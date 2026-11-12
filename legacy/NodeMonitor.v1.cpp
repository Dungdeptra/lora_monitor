#include "NodeMonitor.h"

#include <iostream>
#include <memory>
#include <streambuf>

// NodeMonitor co the dung doc lap (khong can loramesher). Neu thu vien co mat,
// noi hook LogHandler vao LOG de bat MOI dong log ma library in ra Terminal.
#if defined(__has_include)
#  if __has_include("loramesher.hpp")
#    include "loramesher.hpp"
#    define NODEMONITOR_HAS_LORAMESHER 1
#  endif
#endif
#ifndef NODEMONITOR_HAS_LORAMESHER
#  define NODEMONITOR_HAS_LORAMESHER 0
#endif

vprintf_like_t NodeMonitor::_origVprintf = nullptr;

#if NODEMONITOR_HAS_LORAMESHER
namespace {

const char* LevelName(loramesher::LogLevel level) {
    switch (level) {
        case loramesher::LogLevel::kDebug:    return "DEBUG";
        case loramesher::LogLevel::kInfo:     return "INFO";
        case loramesher::LogLevel::kWarning:  return "WARNING";
        case loramesher::LogLevel::kError:    return "ERROR";
        default:                              return "UNKNOWN";
    }
}

/**
 * Bat tat ca log cua library (LOG_INFO/LOG_DEBUG/... -> SerialLogHandler).
 * - Van in ra Terminal dung 100% hinh thuc cu (ke ca mau ANSI).
 * - Dong thoi day ban text khong mau vao queue de publish len MQTT.
 *
 * LUU Y: Write() duoc goi trong khi Logger dang giu logger_semaphore_.
 * Chi duoc phep lam viec khong chan (xQueueSend timeout 0) - KHONG duoc goi LOG.
 */
class MonitorLogHandler : public loramesher::SerialLogHandler {
   public:
    void Write(loramesher::LogLevel level, const char* node_addr,
               const char* message) override {
        // 1) Terminal: khong doi gi so voi SerialLogHandler goc
        loramesher::SerialLogHandler::Write(level, node_addr, message);

        // 2) MQTT: ban text sach, kem timestamp [N ms] de web parse duoc
        char buf[256];
        int n;
        if (node_addr != nullptr && node_addr[0] != '\0') {
            n = snprintf(buf, sizeof(buf), "[%lu ms] [%s] [%s] %s",
                         (unsigned long)millis(), LevelName(level), node_addr,
                         message);
        } else {
            n = snprintf(buf, sizeof(buf), "[%lu ms] [%s] %s",
                         (unsigned long)millis(), LevelName(level), message);
        }
        if (n > 0) {
            NodeMonitor::getInstance().feedLogLine(buf);
        }
    }

    void Flush() override { loramesher::SerialLogHandler::Flush(); }
};

}  // namespace
#endif  // NODEMONITOR_HAS_LORAMESHER


void NodeMonitor::begin(const char* wifiSsid, const char* wifiPass, const char* mqttHost, uint16_t mqttPort, const char* customNodeId) {
    if (_initialized) return; // Dam bao chi chay 1 lan du dat trong setup() hay loop()

    MonitorConfig cfg;
    cfg.wifiSsid = wifiSsid;
    cfg.wifiPassword = wifiPass;
    cfg.mqttHost = mqttHost;
    cfg.mqttPort = mqttPort;
    cfg.customNodeId = customNodeId;
    cfg.enableSerialOutput = true;
    begin(cfg);
}

void NodeMonitor::begin(const MonitorConfig& cfg) {
    if (_initialized) return;
    _initialized = true;
    _cfg = cfg;

    // Lay dia chi tu MAC cua ESP32 lam ID mac dinh cho tung board
    if (_localAddr == 0) {
        uint8_t mac[6];
        WiFi.macAddress(mac);
        _localAddr = (static_cast<uint16_t>(mac[4]) << 8) | mac[5];
    }

    if (_cfg.customNodeId != nullptr && strlen(_cfg.customNodeId) > 0) {
        _nodeId = String(_cfg.customNodeId);
    } else {
        char buf[16];
        snprintf(buf, sizeof(buf), "NODE_%04X", _localAddr);
        _nodeId = String(buf);
    }

    // 256 bytes/line, 64 slots: chiu duot burst log luc khoi dong
    _logQueue = xQueueCreate(64, 256);
    if (_logQueue == nullptr) {
        Serial.println("[NodeMonitor] FATAL: khong tao duoc log queue");
        return;
    }

    // Bat ESP_LOG / printf (WiFi, RadioLib, ESP-IDF...)
    _origVprintf = esp_log_set_vprintf(&NodeMonitor::customVprintf);

#if NODEMONITOR_HAS_LORAMESHER
    // BAT TAT CA log cua LoRaMesher library (LOG_INFO/LOG_DEBUG -> Serial).
    // Day la lo duong thuc te: library khong dung ESP_LOG nen hook tren khong bat gi.
    loramesher::LOG.SetHandler(std::make_unique<MonitorLogHandler>());
#endif

    _hasWifiConfig = (_cfg.wifiSsid != nullptr && strlen(_cfg.wifiSsid) > 0 &&
                      _cfg.mqttHost != nullptr && strlen(_cfg.mqttHost) > 0);

    if (_hasWifiConfig) {
        WiFi.mode(WIFI_STA);
        WiFi.setAutoReconnect(true);
        WiFi.begin(_cfg.wifiSsid, _cfg.wifiPassword);

        _mqttClient.setServer(_cfg.mqttHost, _cfg.mqttPort);
        _mqttClient.setBufferSize(2048);
        _mqttClient.setKeepAlive(10);
    }

    xTaskCreatePinnedToCore(
        NodeMonitor::taskEntry,
        "NodeMonitorTask",
        8192,
        this,
        1,
        &_taskHandle,
        0
    );
}

int NodeMonitor::customVprintf(const char* fmt, va_list args) {
    char buf[256];
    va_list argsCopy;
    va_copy(argsCopy, args);
    int len = vsnprintf(buf, sizeof(buf), fmt, argsCopy);
    va_end(argsCopy);

    if (len > 0) {
        NodeMonitor& inst = NodeMonitor::getInstance();
        QueueHandle_t q = inst._logQueue;
        if (q != nullptr) {
            // esp_log co the duoc goi tu TASK hoac tu ISR. Chon dung API tuy ngu can.
            if (xPortInIsrContext()) {
                BaseType_t hpTaskWoken = pdFALSE;
                xQueueSendFromISR(q, buf, &hpTaskWoken);
                if (hpTaskWoken == pdTRUE) {
                    portYIELD_FROM_ISR(hpTaskWoken);
                }
            } else if (xQueueSend(q, buf, 0) != pdTRUE) {
                inst._droppedLines++;
            }
        }
    }

    if (_origVprintf != nullptr) {
        return _origVprintf(fmt, args);
    }
    return vprintf(fmt, args);
}

void NodeMonitor::setLocalAddress(uint16_t addr) {
    if (addr == 0 || addr == _localAddr) return;
    _localAddr = addr;
    if (_cfg.customNodeId == nullptr || strlen(_cfg.customNodeId) == 0) {
        char buf[16];
        snprintf(buf, sizeof(buf), "NODE_%04X", _localAddr);
        _nodeId = String(buf);
    }
}

void NodeMonitor::feedLogLine(const char* line) {
    if (line == nullptr || _logQueue == nullptr) return;
    char buf[256];
    strncpy(buf, line, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
    // Timeout 0: khong bao gio chan task dang log (logger_semaphore dang bi giu)
    if (xQueueSend(_logQueue, buf, 0) != pdTRUE) {
        _droppedLines++;
    }
}

namespace {

/**
 * Streambuf "tee": van day van ban ra Serial/UART goc (terminal khong doi gi),
 * dong thoi gom tung dong va day vao NodeMonitor de publish len MQTT.
 * Bat cac dong std::cout / std::cerr cua main.cpp ("Received data from...",
 * "Routing table has N entries", "Route updated ...").
 */
class TeeStreamBuf : public std::streambuf {
   public:
    explicit TeeStreamBuf(std::streambuf* sink) : sink_(sink) {}

   protected:
    int_type overflow(int_type ch) override {
        if (ch == traits_type::eof()) return traits_type::not_eof(ch);
        const char c = traits_type::to_char_type(ch);
        if (c == '\n') {
            flushLine();
        } else if (len_ < sizeof(buf_) - 1) {
            buf_[len_++] = c;
        }
        if (sink_ != nullptr) return sink_->sputc(ch);
        return ch;
    }

    int sync() override {
        flushLine();
        // sync() la protected -> goi pubsync() (public) cua sink
        if (sink_ != nullptr) return sink_->pubsync();
        return 0;
    }

   private:
    void flushLine() {
        if (len_ == 0) return;
        buf_[len_] = '\0';
        NodeMonitor::getInstance().feedLogLine(buf_);
        len_ = 0;
    }

    std::streambuf* sink_;
    char buf_[256] = {};
    size_t len_ = 0;
};

}  // namespace

void NodeMonitor::hookStdout() {
    static TeeStreamBuf coutTee(std::cout.rdbuf());
    static TeeStreamBuf cerrTee(std::cerr.rdbuf());
    std::cout.rdbuf(&coutTee);
    std::cerr.rdbuf(&cerrTee);
}

void NodeMonitor::taskEntry(void* pvParameters) {
    NodeMonitor* self = static_cast<NodeMonitor*>(pvParameters);
    for (;;) {
        self->taskLoop();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void NodeMonitor::ensureConnections() {
    if (!_hasWifiConfig) return;
    uint32_t now = millis();

    if (WiFi.status() != WL_CONNECTED) {
        if (now - _lastWifiAttempt >= 10000) {
            _lastWifiAttempt = now;
            WiFi.disconnect();
            WiFi.begin(_cfg.wifiSsid, _cfg.wifiPassword);
        }
        return;
    }

    if (!_mqttClient.connected()) {
        if (now - _lastMqttAttempt >= 5000) {
            _lastMqttAttempt = now;
            String lwtTopic = "loramesh/" + _nodeId + "/status";
            String lwtPayload = "{\"node_id\":\"" + _nodeId + "\",\"mqtt_online\":false}";

            if (_mqttClient.connect(_nodeId.c_str(), nullptr, nullptr, lwtTopic.c_str(), 0, true, lwtPayload.c_str())) {
                publishStatus(true);
                logEvent("MQTT_CONNECTED", "Connected to MQTT Broker");
            } else {
                _mqttDisconnectCount++;
            }
        }
    } else {
        _mqttClient.loop();
    }
}

void NodeMonitor::parseLineMetrics(const char* line) {
    // 1. Tu dong nhan dien Node ID dang [0x1A2B] trong log cua loramesher_pkg
    const char* pNode = strstr(line, "[0x");
    if (pNode != nullptr) {
        unsigned int parsedAddr = 0;
        if (sscanf(pNode, "[0x%x]", &parsedAddr) == 1 && parsedAddr > 0 && parsedAddr < 0xFFFF) {
            setLocalAddress(static_cast<uint16_t>(parsedAddr));
        }
    }

    // 2. Tu dong dem PKT_TX
    const char* pTx = strstr(line, "PKT_TX");
    if (pTx != nullptr) {
        _txCount++;
        _lastTxRxMillis = millis();
        unsigned int dst = 0;
        if (sscanf(pTx, "PKT_TX dst=0x%x", &dst) == 1) {
            _lastDst = static_cast<uint16_t>(dst);
        }
    }

    // 3. Tu dong dem PKT_RX va lay RSSI / SNR thuc te
    const char* pRx = strstr(line, "PKT_RX");
    if (pRx != nullptr) {
        _rxCount++;
        _lastTxRxMillis = millis();
        unsigned int src = 0, dst = 0, type = 0, sz = 0;
        float rssi = NAN, snr = NAN;
        if (sscanf(pRx, "PKT_RX src=0x%x dst=0x%x type=0x%x size=%u rssi=%f snr=%f",
                   &src, &dst, &type, &sz, &rssi, &snr) >= 4) {
            _lastSrc = static_cast<uint16_t>(src);
            if (!isnan(rssi)) _lastLoRaRssi = rssi;
            if (!isnan(snr))  _lastLoRaSnr = snr;
        }
    }
}

void NodeMonitor::processCapturedLogs() {
    if (_logQueue == nullptr) return;
    char lineBuf[256];
    int processed = 0;
    // 32 dong / 20ms = 1600 dong/s - vuot qua toc do log thuc te cua library
    while (processed < 32 && xQueueReceive(_logQueue, lineBuf, 0) == pdTRUE) {
        processed++;
        parseLineMetrics(lineBuf);

        // Day dong log thuc te qua MQTT de Web Dashboard ve Timeline, Topology, Delivery!
        if (_hasWifiConfig && _mqttClient.connected()) {
            String topic = "loramesh/" + _nodeId + "/rawlog";
            if (!_mqttClient.publish(topic.c_str(), lineBuf, false)) {
                _droppedLines++;
            }
        }
    }
}

void NodeMonitor::taskLoop() {
    ensureConnections();
    processCapturedLogs();

    uint32_t now = millis();
    if (now - _lastPublish >= _cfg.publishIntervalMs) {
        _lastPublish = now;
        publishMetrics();
    }
}

void NodeMonitor::publishStatus(bool online) {
    if (!_hasWifiConfig || !_mqttClient.connected()) return;
    JsonDocument doc;
    doc["node_id"] = _nodeId;
    doc["lora_addr"] = _localAddr;
    doc["mqtt_online"] = online;
    doc["wifi_connected"] = (WiFi.status() == WL_CONNECTED);
    doc["ip"] = WiFi.localIP().toString();
    doc["uptime_s"] = millis() / 1000;

    String topic = "loramesh/" + _nodeId + "/status";
    String output;
    serializeJson(doc, output);
    _mqttClient.publish(topic.c_str(), output.c_str(), true);
}

void NodeMonitor::publishMetrics() {
    JsonDocument doc;
    doc["node_id"] = _nodeId;
    doc["lora_addr"] = _localAddr;
    char hexAddr[8];
    snprintf(hexAddr, sizeof(hexAddr), "0x%04X", _localAddr);
    doc["lora_addr_hex"] = hexAddr;

    doc["uptime_s"] = millis() / 1000;
    doc["free_heap"] = ESP.getFreeHeap();
    bool wifiOk = (_hasWifiConfig && WiFi.status() == WL_CONNECTED);
    doc["wifi_connected"] = wifiOk;
    if (wifiOk) doc["wifi_rssi"] = WiFi.RSSI();
    else doc["wifi_rssi"] = nullptr;

    doc["mqtt_connected"] = (_hasWifiConfig && _mqttClient.connected());
    doc["mqtt_disconnects"] = _mqttDisconnectCount;

    doc["tx_packets"] = _txCount;
    doc["rx_packets"] = _rxCount;
    doc["last_src"] = _lastSrc;
    doc["last_dst"] = _lastDst;
    doc["log_dropped"] = _droppedLines;
    doc["last_activity_ago_s"] = (_lastTxRxMillis > 0) ? ((millis() - _lastTxRxMillis) / 1000) : -1;

    if (!isnan(_lastLoRaRssi)) doc["lora_rssi"] = _lastLoRaRssi;
    else doc["lora_rssi"] = nullptr;

    if (!isnan(_lastLoRaSnr)) doc["lora_snr"] = _lastLoRaSnr;
    else doc["lora_snr"] = nullptr;

    String output;
    serializeJson(doc, output);

    if (_cfg.enableSerialOutput) {
        Serial.print("@MON_JSON:");
        Serial.println(output);
    }

    if (_hasWifiConfig && _mqttClient.connected()) {
        String topic = "loramesh/" + _nodeId + "/metrics";
        _mqttClient.publish(topic.c_str(), output.c_str(), false);
    }
}

void NodeMonitor::recordTx(uint16_t dstAddr, size_t payloadBytes, uint8_t msgType) {
    _txCount++;
    _lastDst = dstAddr;
    _lastTxRxMillis = millis();

    char line[128];
    snprintf(line, sizeof(line), "[%lu ms] [INFO] [0x%04X] PKT_TX dst=0x%04X src=0x%04X type=0x%02X size=%u",
             (unsigned long)millis(), _localAddr, dstAddr, _localAddr, msgType, (unsigned)payloadBytes);

    if (_cfg.enableSerialOutput) {
        Serial.println(line);
    }
    if (_hasWifiConfig && _mqttClient.connected()) {
        String topic = "loramesh/" + _nodeId + "/rawlog";
        _mqttClient.publish(topic.c_str(), line, false);
    }

    char detail[64];
    snprintf(detail, sizeof(detail), "TX %u bytes -> 0x%04X", (unsigned)payloadBytes, dstAddr);
    logEvent("TX", detail);
}

void NodeMonitor::recordRx(uint16_t srcAddr, size_t payloadBytes, float rssi, float snr, uint8_t msgType) {
    _rxCount++;
    _lastSrc = srcAddr;
    _lastTxRxMillis = millis();
    if (!isnan(rssi)) _lastLoRaRssi = rssi;
    if (!isnan(snr))  _lastLoRaSnr = snr;

    float printRssi = isnan(rssi) ? -80.0f : rssi;
    float printSnr  = isnan(snr)  ? 5.0f   : snr;
    char line[160];
    snprintf(line, sizeof(line), "[%lu ms] [INFO] [0x%04X] PKT_RX src=0x%04X dst=0x%04X type=0x%02X size=%u rssi=%.1f snr=%.1f",
             (unsigned long)millis(), _localAddr, srcAddr, _localAddr, msgType, (unsigned)payloadBytes, printRssi, printSnr);

    if (_cfg.enableSerialOutput) {
        Serial.println(line);
    }
    if (_hasWifiConfig && _mqttClient.connected()) {
        String topic = "loramesh/" + _nodeId + "/rawlog";
        _mqttClient.publish(topic.c_str(), line, false);
    }

    char detail[64];
    snprintf(detail, sizeof(detail), "RX %u bytes <- 0x%04X", (unsigned)payloadBytes, srcAddr);
    logEvent("RX", detail);
}

void NodeMonitor::logEvent(const char* eventType, const char* detail) {
    JsonDocument doc;
    doc["node_id"] = _nodeId;
    doc["lora_addr"] = _localAddr;
    doc["event"] = eventType;
    doc["detail"] = detail;
    doc["uptime_s"] = millis() / 1000;

    String output;
    serializeJson(doc, output);

    if (_cfg.enableSerialOutput) {
        Serial.print("@MON_JSON:");
        Serial.println(output);
    }

    if (_hasWifiConfig && _mqttClient.connected()) {
        String topic = "loramesh/" + _nodeId + "/events";
        _mqttClient.publish(topic.c_str(), output.c_str(), false);
    }
}