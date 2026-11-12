/**
 * @file NodeMonitor.cpp
 * @brief Implementation of the non-intrusive LoRaMesher node monitor.
 *
 * Design notes
 * ------------
 * - One low-priority FreeRTOS task owns all network I/O (Wi-Fi/MQTT) and
 *   JSON serialization. The LoRa tasks only push small fixed-size events
 *   into a queue, so they are never blocked by the network.
 * - RSSI/SNR are taken from the real "PKT_RX ... rssi=... snr=..." log
 *   emitted by RadioLib inside LoRaMesher. When the values are absent the
 *   JSON fields are null; no synthetic values are generated.
 * - The routing table is reconstructed from the real route log messages
 *   published by LoRaMesher. It is informative only and never changes the
 *   mesh routing algorithm.
 */

#include "NodeMonitor.h"

#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <streambuf>

// ---------------------------------------------------------------------------
// Optional LoRaMesher integration. The library remains usable without it.
// ---------------------------------------------------------------------------
#if defined(__has_include)
#  if __has_include("loramesher.hpp")
#    include "loramesher.hpp"
#    define NODEMONITOR_HAS_LORAMESHER 1
#  endif
#endif
#ifndef NODEMONITOR_HAS_LORAMESHER
#  define NODEMONITOR_HAS_LORAMESHER 0
#endif

namespace nodemonitor {
namespace {

constexpr size_t kLogLineLen = 192;
constexpr size_t kLogQueueLen = 48;
constexpr size_t kEventQueueLen = 24;
constexpr size_t kRouteCapacity = 24;
constexpr size_t kPayloadLen = 3072;
constexpr size_t kEventPayloadLen = 768;
constexpr size_t kIdLen = 33;
constexpr size_t kPrefixLen = 33;
constexpr size_t kTopicLen = 96;
constexpr size_t kHostLen = 96;
constexpr size_t kCredentialLen = 65;

constexpr int16_t kNoSignal = INT16_MIN;

struct PendingEvent {
    char type[20];
    char detail[96];
    uint32_t deviceMs;
    uint16_t src;
    uint16_t dst;
    uint16_t size;
    uint8_t msgType;
    float rssi;
    float snr;
    bool hasSrc;
    bool hasDst;
    bool hasRssi;
    bool hasSnr;
};

struct RouteEntry {
    uint16_t destination;
    uint16_t nextHop;
    uint8_t hops;
    bool valid;
};

void copyText(char* out, size_t outLen, const char* text) {
    if (out == nullptr || outLen == 0) return;
    if (text == nullptr) {
        out[0] = '\0';
        return;
    }
    size_t i = 0;
    for (; text[i] != '\0' && i + 1 < outLen; ++i) {
        out[i] = text[i];
    }
    out[i] = '\0';
}

/** Keep MQTT topic segments safe: A-Z a-z 0-9 _ - only. */
void sanitizeSegment(const char* input, char* out, size_t outLen,
                     const char* fallback) {
    if (out == nullptr || outLen == 0) return;
    if (input == nullptr || input[0] == '\0') {
        copyText(out, outLen, fallback);
        return;
    }
    size_t j = 0;
    for (size_t i = 0; input[i] != '\0' && j + 1 < outLen; ++i) {
        const unsigned char c = static_cast<unsigned char>(input[i]);
        if (std::isalnum(c) || c == '_' || c == '-') {
            out[j++] = static_cast<char>(c);
        } else if (c == ' ' || c == '/' || c == ':' || c == '.') {
            out[j++] = '_';
        }
    }
    out[j] = '\0';
    if (j == 0) copyText(out, outLen, fallback);
}

/** Remove ANSI escape sequences and carriage returns from a log line. */
void stripAnsi(const char* input, char* out, size_t outLen) {
    if (out == nullptr || outLen == 0) return;
    size_t j = 0;
    for (size_t i = 0; input != nullptr && input[i] != '\0' && j + 1 < outLen;) {
        const char c = input[i];
        if (c == '\033') {
            ++i;
            if (input[i] == '[') {
                ++i;
                while (input[i] != '\0' &&
                       !(input[i] >= 0x40 && input[i] <= 0x7E)) {
                    ++i;
                }
                if (input[i] != '\0') ++i;
            }
            continue;
        }
        if (c == '\r' || c == '\n') {
            ++i;
            continue;
        }
        out[j++] = c;
        ++i;
    }
    out[j] = '\0';
}

#if NODEMONITOR_HAS_LORAMESHER
const char* levelName(loramesher::LogLevel level) {
    switch (level) {
        case loramesher::LogLevel::kDebug:
            return "DEBUG";
        case loramesher::LogLevel::kInfo:
            return "INFO";
        case loramesher::LogLevel::kWarning:
            return "WARNING";
        case loramesher::LogLevel::kError:
            return "ERROR";
        default:
            return "UNKNOWN";
    }
}
#endif

}  // namespace

// ---------------------------------------------------------------------------
// Pimpl
// ---------------------------------------------------------------------------
struct NodeMonitor::Impl {
    MonitorConfig cfg;

    char wifiSsid[kCredentialLen] = {};
    char wifiPassword[kCredentialLen] = {};
    char mqttHost[kHostLen] = {};
    char mqttUsername[kCredentialLen] = {};
    char mqttPassword[kCredentialLen] = {};
    char nodeId[kIdLen] = {};
    char topicPrefix[kPrefixLen] = {};
    char mqttClientId[48] = {};
    char hostname[48] = {};

    char statusTopic[kTopicLen] = {};
    char metricsTopic[kTopicLen] = {};
    char eventsTopic[kTopicLen] = {};
    char rawLogTopic[kTopicLen] = {};
    char lwtPayload[512] = {};

    bool hasWifi = false;
    bool hasMqtt = false;

    WiFiClient plainClient;
    WiFiClientSecure tlsClient;
    PubSubClient mqtt{plainClient};
    QueueHandle_t logQueue = nullptr;
    QueueHandle_t eventQueue = nullptr;
    TaskHandle_t task = nullptr;

    char payload[kPayloadLen] = {};
    char eventPayload[kEventPayloadLen] = {};

    // Counters shared with other tasks.
    std::atomic<bool> initialized{false};
    std::atomic<bool> stopRequested{false};
    std::atomic<bool> taskRunning{false};
    std::atomic<bool> wifiConnected{false};
    std::atomic<bool> mqttConnected{false};
    std::atomic<uint16_t> loraAddress{0};
    std::atomic<uint32_t> txPackets{0};
    std::atomic<uint32_t> rxPackets{0};
    std::atomic<uint32_t> txErrors{0};
    std::atomic<uint32_t> rxErrors{0};
    std::atomic<uint32_t> droppedLogLines{0};
    std::atomic<uint32_t> droppedEvents{0};
    std::atomic<uint32_t> suppressedEvents{0};
    std::atomic<uint32_t> publishFailures{0};
    std::atomic<uint32_t> wifiDisconnects{0};
    std::atomic<uint32_t> mqttConnects{0};
    std::atomic<uint32_t> mqttFailures{0};
    std::atomic<uint32_t> mqttDisconnects{0};
    std::atomic<uint32_t> lastActivityMs{0};
    std::atomic<uint16_t> lastSrc{0};
    std::atomic<uint16_t> lastDst{0};
    std::atomic<int16_t> loraRssiX10{kNoSignal};
    std::atomic<int16_t> loraSnrX10{kNoSignal};
    std::atomic<uint16_t> networkManager{0};
    std::atomic<uint8_t> networkState{0};
    std::atomic<uint32_t> bootId{0};

    // Monitor-task-only state.
    RouteEntry routes[kRouteCapacity] = {};
    size_t routeCount = 0;
    bool wifiWasConnected = false;
    bool mqttWasConnected = false;
    uint32_t wifiRetryAt = 0;
    uint32_t wifiBackoff = 0;
    uint32_t mqttRetryAt = 0;
    uint32_t mqttBackoff = 0;
    uint32_t lastMetricsMs = 0;
    uint32_t lastStatusMs = 0;
    uint32_t rateWindowMs = 0;
    uint16_t rateCount = 0;
    uint32_t rawWindowMs = 0;
    uint16_t rawCount = 0;
    bool stdoutHooked = false;
    bool espLogHooked = false;
    vprintf_like_t originalVprintf = nullptr;

    static void taskEntry(void* parameter);
    void serviceOnce();
    void serviceConnections();
    void processLogQueue();
    void processEventQueue();
    void publishMetrics();
    void publishStatus(bool online);
    void publishEventNow(const PendingEvent& event);
    void publishRawLog(const char* line);
    void attemptMqttConnect();
    void parseLine(const char* rawLine);
    void enqueueEvent(const PendingEvent& event);
    void updateRoute(uint16_t destination, uint16_t nextHop, uint8_t hops,
                     bool announce);
    void removeRoute(uint16_t destination, bool announce);
    void clearRoutes();
    RouteEntry* findRoute(uint16_t destination);
    void setLocalAddressInternal(uint16_t address);
    void fillCommon(JsonDocument& doc) const;
    void makeTopic(char* out, size_t outLen, const char* suffix) const;
    static int customVprintf(const char* format, va_list args);
};

// ---------------------------------------------------------------------------
// Log handler that keeps the original Serial output and feeds the monitor.
// ---------------------------------------------------------------------------
#if NODEMONITOR_HAS_LORAMESHER
namespace {
class MonitorLogHandler : public loramesher::SerialLogHandler {
   public:
    void Write(loramesher::LogLevel level, const char* nodeAddr,
               const char* message) override {
        // Preserve 100% of the original terminal output.
        loramesher::SerialLogHandler::Write(level, nodeAddr, message);

        char line[kLogLineLen];
        if (nodeAddr != nullptr && nodeAddr[0] != '\0') {
            snprintf(line, sizeof(line), "[%lu ms] [%s] [%s] %s",
                     static_cast<unsigned long>(millis()), levelName(level),
                     nodeAddr, message != nullptr ? message : "");
        } else {
            snprintf(line, sizeof(line), "[%lu ms] [%s] %s",
                     static_cast<unsigned long>(millis()), levelName(level),
                     message != nullptr ? message : "");
        }
        NodeMonitor::getInstance().feedLogLine(line);
    }

    void Flush() override { loramesher::SerialLogHandler::Flush(); }
};
}  // namespace
#endif

// ---------------------------------------------------------------------------
// Stdout tee
// ---------------------------------------------------------------------------
namespace {
class TeeStreamBuf : public std::streambuf {
   public:
    explicit TeeStreamBuf(std::streambuf* sink) : sink_(sink) {}

   protected:
    int_type overflow(int_type ch) override {
        if (ch == traits_type::eof()) return traits_type::not_eof(ch);
        const char c = traits_type::to_char_type(ch);
        if (c == '\n') {
            flushLine();
        } else if (len_ + 1 < sizeof(buffer_)) {
            buffer_[len_++] = c;
        }
        if (sink_ != nullptr) return sink_->sputc(ch);
        return ch;
    }

    int sync() override {
        flushLine();
        if (sink_ != nullptr) return sink_->pubsync();
        return 0;
    }

   private:
    void flushLine() {
        if (len_ == 0) return;
        buffer_[len_] = '\0';
        NodeMonitor::getInstance().feedLogLine(buffer_);
        len_ = 0;
    }

    std::streambuf* sink_ = nullptr;
    char buffer_[kLogLineLen] = {};
    size_t len_ = 0;
};
}  // namespace

// ---------------------------------------------------------------------------
// Singleton lifecycle
// ---------------------------------------------------------------------------
NodeMonitor& NodeMonitor::getInstance() {
    static NodeMonitor instance;
    return instance;
}

NodeMonitor::NodeMonitor() : impl_(new Impl()) {}

NodeMonitor::~NodeMonitor() = default;

BoardType NodeMonitor::boardType() {
#if defined(ARDUINO_heltec_wifi_lora_32_V4)
    return BoardType::kHeltecV4;
#elif defined(ARDUINO_heltec_wifi_lora_32_V3)
    return BoardType::kHeltecV3;
#else
    return BoardType::kUnknown;
#endif
}

const char* NodeMonitor::boardName() {
    switch (boardType()) {
        case BoardType::kHeltecV4:
            return "heltec-v4";
        case BoardType::kHeltecV3:
            return "heltec-v3";
        default:
            return "esp32";
    }
}

bool NodeMonitor::started() const {
    return impl_ && impl_->taskRunning.load();
}

const char* NodeMonitor::nodeId() const {
    return impl_ ? impl_->nodeId : "";
}

uint16_t NodeMonitor::localAddress() const {
    return impl_ ? impl_->loraAddress.load() : 0;
}

MonitorSnapshot NodeMonitor::snapshot() const {
    MonitorSnapshot s;
    if (!impl_) return s;
    s.started = impl_->taskRunning.load();
    s.wifiConnected = impl_->wifiConnected.load();
    s.mqttConnected = impl_->mqttConnected.load();
    s.loraAddress = impl_->loraAddress.load();
    s.uptimeSeconds = millis() / 1000UL;
    s.txPackets = impl_->txPackets.load();
    s.rxPackets = impl_->rxPackets.load();
    s.txErrors = impl_->txErrors.load();
    s.rxErrors = impl_->rxErrors.load();
    s.wifiRssi = s.wifiConnected ? static_cast<int16_t>(WiFi.RSSI()) : 0;
    const int16_t rssi = impl_->loraRssiX10.load();
    const int16_t snr = impl_->loraSnrX10.load();
    if (rssi != kNoSignal) {
        s.hasLoraRssi = true;
        s.loraRssi = static_cast<float>(rssi) / 10.0F;
    }
    if (snr != kNoSignal) {
        s.hasLoraSnr = true;
        s.loraSnr = static_cast<float>(snr) / 10.0F;
    }
    return s;
}

// ---------------------------------------------------------------------------
// begin / end
// ---------------------------------------------------------------------------
bool NodeMonitor::begin(const char* wifiSsid, const char* wifiPassword,
                        const char* mqttHost, uint16_t mqttPort,
                        const char* nodeId, const char* mqttUsername,
                        const char* mqttPassword) {
    MonitorConfig config;
    config.wifiSsid = wifiSsid;
    config.wifiPassword = wifiPassword;
    config.mqttHost = mqttHost;
    config.mqttPort = mqttPort;
    config.nodeId = nodeId;
    config.mqttUsername = mqttUsername;
    config.mqttPassword = mqttPassword;
    return begin(config);
}

bool NodeMonitor::beginSerialOnly(uint32_t metricsIntervalMs) {
    MonitorConfig config;
    config.metricsIntervalMs = metricsIntervalMs;
    return begin(config);
}

bool NodeMonitor::begin(const MonitorConfig& config) {
    if (impl_ == nullptr) return false;
    if (impl_->initialized.load()) return true;

    impl_->cfg = config;
    if (impl_->cfg.metricsIntervalMs < 1000) impl_->cfg.metricsIntervalMs = 1000;
    if (impl_->cfg.statusIntervalMs < 5000) impl_->cfg.statusIntervalMs = 5000;
    if (impl_->cfg.wifiRetryIntervalMs < 5000)
        impl_->cfg.wifiRetryIntervalMs = 5000;
    if (impl_->cfg.mqttRetryIntervalMs < 2000)
        impl_->cfg.mqttRetryIntervalMs = 2000;
    if (impl_->cfg.maxEventsPerSecond == 0)
        impl_->cfg.maxEventsPerSecond = 1;
    if (impl_->cfg.maxEventsPerSecond > 100)
        impl_->cfg.maxEventsPerSecond = 100;

    // Copy credentials so callers may pass temporary String.c_str() values.
    copyText(impl_->wifiSsid, sizeof(impl_->wifiSsid),
             config.wifiSsid != nullptr ? config.wifiSsid : "");
    copyText(impl_->wifiPassword, sizeof(impl_->wifiPassword),
             config.wifiPassword != nullptr ? config.wifiPassword : "");
    copyText(impl_->mqttHost, sizeof(impl_->mqttHost),
             config.mqttHost != nullptr ? config.mqttHost : "");
    copyText(impl_->mqttUsername, sizeof(impl_->mqttUsername),
             config.mqttUsername != nullptr ? config.mqttUsername : "");
    copyText(impl_->mqttPassword, sizeof(impl_->mqttPassword),
             config.mqttPassword != nullptr ? config.mqttPassword : "");
    impl_->hasWifi = impl_->wifiSsid[0] != '\0';
    impl_->hasMqtt = impl_->hasWifi && impl_->mqttHost[0] != '\0';

    // Derive a stable identity from the factory MAC (works before Wi-Fi start).
    uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char macSuffix[16];
    snprintf(macSuffix, sizeof(macSuffix), "%02X%02X%02X", mac[3], mac[4],
             mac[5]);
    char fallbackId[kIdLen];
    snprintf(fallbackId, sizeof(fallbackId), "NODE_%s", macSuffix);
    sanitizeSegment(config.nodeId, impl_->nodeId, sizeof(impl_->nodeId),
                    fallbackId);
    sanitizeSegment(config.topicPrefix, impl_->topicPrefix,
                    sizeof(impl_->topicPrefix), "loramesh");
    snprintf(impl_->mqttClientId, sizeof(impl_->mqttClientId), "nodemon-%s",
             macSuffix);

    // Hostname: lower-case node id (mDNS-friendly).
    copyText(impl_->hostname, sizeof(impl_->hostname), impl_->nodeId);
    for (char* p = impl_->hostname; *p != '\0'; ++p) {
        *p = static_cast<char>(std::tolower(static_cast<unsigned char>(*p)));
    }

    impl_->makeTopic(impl_->statusTopic, sizeof(impl_->statusTopic), "status");
    impl_->makeTopic(impl_->metricsTopic, sizeof(impl_->metricsTopic),
                     "metrics");
    impl_->makeTopic(impl_->eventsTopic, sizeof(impl_->eventsTopic), "events");
    impl_->makeTopic(impl_->rawLogTopic, sizeof(impl_->rawLogTopic), "logs");

    // Last-Will payload: retained "offline" marker.
    snprintf(impl_->lwtPayload, sizeof(impl_->lwtPayload),
             "{\"schema\":%d,\"node_id\":\"%s\",\"online\":false,"
             "\"mqtt_connected\":false,\"lora_addr\":%u,\"board\":\"%s\","
             "\"fw\":\"%s\"}",
             NODEMONITOR_SCHEMA, impl_->nodeId,
             static_cast<unsigned>(impl_->loraAddress.load()), boardName(),
             NODEMONITOR_VERSION);

    impl_->bootId.store(esp_random() != 0 ? esp_random() : 1);

    // Network clients.
    if (impl_->cfg.useTls) {
        if (impl_->cfg.mqttCaCert != nullptr &&
            impl_->cfg.mqttCaCert[0] != '\0') {
            impl_->tlsClient.setCACert(impl_->cfg.mqttCaCert);
        } else if (impl_->cfg.tlsInsecure) {
            impl_->tlsClient.setInsecure();
        }
        impl_->mqtt.setClient(impl_->tlsClient);
    } else {
        impl_->mqtt.setClient(impl_->plainClient);
    }
    impl_->mqtt.setServer(impl_->mqttHost, impl_->cfg.mqttPort);
    impl_->mqtt.setKeepAlive(20);
    impl_->mqtt.setSocketTimeout(3);
    impl_->mqtt.setBufferSize(4096);

    impl_->logQueue = xQueueCreate(kLogQueueLen, kLogLineLen);
    impl_->eventQueue = xQueueCreate(kEventQueueLen, sizeof(PendingEvent));
    if (impl_->logQueue == nullptr || impl_->eventQueue == nullptr) {
        if (impl_->logQueue != nullptr) vQueueDelete(impl_->logQueue);
        if (impl_->eventQueue != nullptr) vQueueDelete(impl_->eventQueue);
        impl_->logQueue = nullptr;
        impl_->eventQueue = nullptr;
        Serial.println("[NodeMonitor] FATAL: cannot allocate queues");
        return false;
    }

#if NODEMONITOR_HAS_LORAMESHER
    if (impl_->cfg.captureLoRaMesherLogs) {
        loramesher::LOG.SetHandler(std::make_unique<MonitorLogHandler>());
    }
#endif
    if (impl_->cfg.captureEspLogs) {
        impl_->espLogHooked = true;
        impl_->originalVprintf = esp_log_set_vprintf(&Impl::customVprintf);
    }

    if (impl_->hasWifi) {
        WiFi.persistent(false);
        WiFi.mode(WIFI_STA);
        WiFi.setAutoReconnect(true);
        WiFi.setSleep(false);
        WiFi.setHostname(impl_->hostname);
        WiFi.begin(impl_->wifiSsid, impl_->wifiPassword);
        impl_->wifiRetryAt = millis() + 10000UL;
        impl_->wifiBackoff = impl_->cfg.wifiRetryIntervalMs;
    }

    impl_->wifiWasConnected = false;
    impl_->mqttWasConnected = false;
    impl_->mqttBackoff = impl_->cfg.mqttRetryIntervalMs;
    impl_->wifiBackoff = impl_->cfg.wifiRetryIntervalMs;
    impl_->stopRequested.store(false);
    impl_->initialized.store(true);

    BaseType_t created = xTaskCreatePinnedToCore(
        &Impl::taskEntry, "NodeMonitor", 10240, impl_.get(), 2, &impl_->task, 0);
    if (created != pdPASS) {
        impl_->initialized.store(false);
        vQueueDelete(impl_->logQueue);
        vQueueDelete(impl_->eventQueue);
        impl_->logQueue = nullptr;
        impl_->eventQueue = nullptr;
        Serial.println("[NodeMonitor] FATAL: cannot create task");
        return false;
    }

    impl_->taskRunning.store(true);
    Serial.printf("[NodeMonitor] started id=%s board=%s fw=%s\n",
                  impl_->nodeId, boardName(), NODEMONITOR_VERSION);
    return true;
}

void NodeMonitor::end() {
    if (impl_ == nullptr || !impl_->initialized.load()) return;
    impl_->stopRequested.store(true);
    const uint32_t deadline = millis() + 5000UL;
    while (impl_->taskRunning.load() && static_cast<int32_t>(millis() - deadline) < 0) {
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    if (impl_->mqtt.connected()) {
        impl_->publishStatus(false);
        impl_->mqtt.disconnect();
    }
    impl_->mqttConnected.store(false);
    impl_->wifiConnected.store(false);

    if (impl_->logQueue != nullptr) {
        vQueueDelete(impl_->logQueue);
        impl_->logQueue = nullptr;
    }
    if (impl_->eventQueue != nullptr) {
        vQueueDelete(impl_->eventQueue);
        impl_->eventQueue = nullptr;
    }
    impl_->initialized.store(false);
    impl_->task = nullptr;
    Serial.println("[NodeMonitor] stopped");
}

void NodeMonitor::loop() {
    if (impl_ == nullptr || !impl_->initialized.load()) return;
    if (!impl_->taskRunning.load()) {
        impl_->serviceOnce();
    }
}

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------
void NodeMonitor::setLocalAddress(uint16_t address) {
    if (impl_ == nullptr) return;
    impl_->setLocalAddressInternal(address);
}

void NodeMonitor::recordTx(uint16_t destination, size_t payloadBytes,
                           uint8_t messageType) {
    if (impl_ == nullptr) return;
    impl_->txPackets.fetch_add(1);
    impl_->lastDst.store(destination);
    impl_->lastActivityMs.store(millis());
    PendingEvent event{};
    copyText(event.type, sizeof(event.type), "tx");
    snprintf(event.detail, sizeof(event.detail), "TX %u B -> 0x%04X",
             static_cast<unsigned>(payloadBytes), static_cast<unsigned>(destination));
    event.deviceMs = millis();
    event.size = static_cast<uint16_t>(payloadBytes > 0xFFFF ? 0xFFFF : payloadBytes);
    event.dst = destination;
    event.hasDst = true;
    event.msgType = messageType;
    impl_->enqueueEvent(event);
}

void NodeMonitor::recordRx(uint16_t source, size_t payloadBytes, float rssi,
                           float snr, uint8_t messageType) {
    if (impl_ == nullptr) return;
    impl_->rxPackets.fetch_add(1);
    impl_->lastSrc.store(source);
    impl_->lastActivityMs.store(millis());
    if (!std::isnan(rssi)) impl_->loraRssiX10.store(static_cast<int16_t>(rssi * 10.0F));
    if (!std::isnan(snr)) impl_->loraSnrX10.store(static_cast<int16_t>(snr * 10.0F));

    PendingEvent event{};
    copyText(event.type, sizeof(event.type), "rx");
    snprintf(event.detail, sizeof(event.detail), "RX %u B <- 0x%04X",
             static_cast<unsigned>(payloadBytes), static_cast<unsigned>(source));
    event.deviceMs = millis();
    event.size = static_cast<uint16_t>(payloadBytes > 0xFFFF ? 0xFFFF : payloadBytes);
    event.src = source;
    event.hasSrc = true;
    event.msgType = messageType;
    if (!std::isnan(rssi)) {
        event.rssi = rssi;
        event.hasRssi = true;
    }
    if (!std::isnan(snr)) {
        event.snr = snr;
        event.hasSnr = true;
    }
    impl_->enqueueEvent(event);
}

void NodeMonitor::recordError(const char* code, const char* detail) {
    if (impl_ == nullptr) return;
    PendingEvent event{};
    copyText(event.type, sizeof(event.type), "error");
    snprintf(event.detail, sizeof(event.detail), "%s%s%s",
             code != nullptr ? code : "ERROR", detail != nullptr ? ": " : "",
             detail != nullptr ? detail : "");
    event.deviceMs = millis();
    impl_->enqueueEvent(event);
}

void NodeMonitor::logEvent(const char* event, const char* detail) {
    if (impl_ == nullptr) return;
    PendingEvent pending{};
    copyText(pending.type, sizeof(pending.type),
             event != nullptr ? event : "event");
    copyText(pending.detail, sizeof(pending.detail),
             detail != nullptr ? detail : "");
    pending.deviceMs = millis();
    impl_->enqueueEvent(pending);
}

void NodeMonitor::feedLogLine(const char* line) {
    if (impl_ == nullptr || line == nullptr || impl_->logQueue == nullptr) return;
    char buffer[kLogLineLen];
    copyText(buffer, sizeof(buffer), line);
    if (xQueueSend(impl_->logQueue, buffer, 0) != pdTRUE) {
        impl_->droppedLogLines.fetch_add(1);
    }
}

void NodeMonitor::hookStdout() {
    if (impl_ == nullptr || impl_->stdoutHooked) return;
    static TeeStreamBuf coutTee(std::cout.rdbuf());
    static TeeStreamBuf cerrTee(std::cerr.rdbuf());
    std::cout.rdbuf(&coutTee);
    std::cerr.rdbuf(&cerrTee);
    impl_->stdoutHooked = true;
}

void NodeMonitor::hookEspLog(bool enable) {
    if (impl_ == nullptr) return;
    if (enable && !impl_->espLogHooked) {
        impl_->originalVprintf = esp_log_set_vprintf(&Impl::customVprintf);
        impl_->espLogHooked = true;
    } else if (!enable && impl_->espLogHooked) {
        esp_log_set_vprintf(impl_->originalVprintf != nullptr
                                ? impl_->originalVprintf
                                : &vprintf);
        impl_->espLogHooked = false;
    }
}

// ---------------------------------------------------------------------------
// Impl helpers
// ---------------------------------------------------------------------------
void NodeMonitor::Impl::makeTopic(char* out, size_t outLen,
                                  const char* suffix) const {
    snprintf(out, outLen, "%s/%s/%s", topicPrefix, nodeId, suffix);
}

void NodeMonitor::Impl::setLocalAddressInternal(uint16_t address) {
    if (address == 0 || address == 0xFFFF) return;
    if (loraAddress.exchange(address) == address) return;
    // Refresh the retained last-will payload so an offline marker carries the
    // latest address when possible.
    snprintf(lwtPayload, sizeof(lwtPayload),
             "{\"schema\":%d,\"node_id\":\"%s\",\"online\":false,"
             "\"mqtt_connected\":false,\"lora_addr\":%u,\"board\":\"%s\","
             "\"fw\":\"%s\"}",
             NODEMONITOR_SCHEMA, nodeId, static_cast<unsigned>(address),
             NodeMonitor::boardName(), NODEMONITOR_VERSION);
}

void NodeMonitor::Impl::enqueueEvent(const PendingEvent& event) {
    if (eventQueue == nullptr) return;
    if (xQueueSend(eventQueue, &event, 0) != pdTRUE) {
        droppedEvents.fetch_add(1);
    }
}

RouteEntry* NodeMonitor::Impl::findRoute(uint16_t destination) {
    for (size_t i = 0; i < routeCount; ++i) {
        if (routes[i].destination == destination) return &routes[i];
    }
    return nullptr;
}

void NodeMonitor::Impl::updateRoute(uint16_t destination, uint16_t nextHop,
                                    uint8_t hops, bool announce) {
    if (destination == 0 || destination == 0xFFFF) return;
    RouteEntry* entry = findRoute(destination);
    if (entry == nullptr) {
        if (routeCount >= kRouteCapacity) return;
        entry = &routes[routeCount++];
        entry->destination = destination;
        entry->valid = true;
    }
    if (nextHop != 0) entry->nextHop = nextHop;
    if (hops != 0) entry->hops = hops;
    entry->valid = true;

    if (announce) {
        PendingEvent event{};
        copyText(event.type, sizeof(event.type), "route_add");
        snprintf(event.detail, sizeof(event.detail),
                 "Route 0x%04X via 0x%04X (%u hops)",
                 static_cast<unsigned>(destination),
                 static_cast<unsigned>(entry->nextHop),
                 static_cast<unsigned>(entry->hops));
        event.deviceMs = millis();
        event.dst = destination;
        event.hasDst = true;
        enqueueEvent(event);
    }
}

void NodeMonitor::Impl::removeRoute(uint16_t destination, bool announce) {
    for (size_t i = 0; i < routeCount; ++i) {
        if (routes[i].destination != destination) continue;
        routes[i] = routes[routeCount - 1];
        --routeCount;
        if (announce) {
            PendingEvent event{};
            copyText(event.type, sizeof(event.type), "route_remove");
            snprintf(event.detail, sizeof(event.detail),
                     "Route removed: 0x%04X", static_cast<unsigned>(destination));
            event.deviceMs = millis();
            event.dst = destination;
            event.hasDst = true;
            enqueueEvent(event);
        }
        return;
    }
}

void NodeMonitor::Impl::clearRoutes() {
    routeCount = 0;
}

// ---------------------------------------------------------------------------
// Task loop
// ---------------------------------------------------------------------------
void NodeMonitor::Impl::taskEntry(void* parameter) {
    Impl* self = static_cast<Impl*>(parameter);
    for (;;) {
        if (self->stopRequested.load()) break;
        self->serviceOnce();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    self->taskRunning.store(false);
    self->task = nullptr;
    vTaskDelete(nullptr);
}

void NodeMonitor::Impl::serviceOnce() {
    serviceConnections();
    processLogQueue();
    processEventQueue();

    const uint32_t now = millis();
    if ((mqtt.connected() || cfg.serialTelemetry) &&
        static_cast<uint32_t>(now - lastMetricsMs) >= cfg.metricsIntervalMs) {
        lastMetricsMs = now;
        publishMetrics();
    }
    if (mqtt.connected() &&
        static_cast<uint32_t>(now - lastStatusMs) >= cfg.statusIntervalMs) {
        lastStatusMs = now;
        publishStatus(true);
    }
}

void NodeMonitor::Impl::serviceConnections() {
    const uint32_t now = millis();

    if (hasWifi) {
        const wl_status_t status = WiFi.status();
        if (status == WL_CONNECTED) {
            if (!wifiWasConnected) {
                wifiWasConnected = true;
                wifiConnected.store(true);
                wifiBackoff = cfg.wifiRetryIntervalMs;
                Serial.printf("[NodeMonitor] Wi-Fi connected: %s ip=%s rssi=%d\n",
                              WiFi.SSID().c_str(),
                              WiFi.localIP().toString().c_str(),
                              static_cast<int>(WiFi.RSSI()));
            }
        } else {
            wifiConnected.store(false);
            if (wifiWasConnected) {
                wifiWasConnected = false;
                wifiDisconnects.fetch_add(1);
                if (mqtt.connected()) mqtt.disconnect();
                mqttConnected.store(false);
                mqttWasConnected = false;
                Serial.printf("[NodeMonitor] Wi-Fi lost (status=%d), retrying\n",
                              static_cast<int>(status));
            }
            if (static_cast<int32_t>(now - wifiRetryAt) >= 0) {
                if (status == WL_NO_SSID_AVAIL || status == WL_CONNECT_FAILED ||
                    status == WL_IDLE_STATUS) {
                    WiFi.begin(wifiSsid, wifiPassword);
                } else {
                    WiFi.reconnect();
                }
                wifiRetryAt = now + wifiBackoff;
                if (wifiBackoff < 60000UL) wifiBackoff *= 2UL;
            }
            return;
        }
    } else {
        wifiConnected.store(false);
    }

    if (!hasMqtt) return;

    if (mqtt.connected()) {
        mqttConnected.store(true);
        mqtt.loop();
        if (!mqttWasConnected) {
            mqttWasConnected = true;
        }
        return;
    }

    mqttConnected.store(false);
    if (mqttWasConnected) {
        mqttWasConnected = false;
        mqttDisconnects.fetch_add(1);
        Serial.println("[NodeMonitor] MQTT connection lost");
    }
    if (static_cast<int32_t>(now - mqttRetryAt) >= 0) {
        attemptMqttConnect();
        mqttRetryAt = now + mqttBackoff;
        if (mqttBackoff < 60000UL) mqttBackoff *= 2UL;
    }
}

void NodeMonitor::Impl::attemptMqttConnect() {
    const char* user = mqttUsername[0] != '\0' ? mqttUsername : nullptr;
    const char* pass = mqttPassword[0] != '\0' ? mqttPassword : nullptr;

    const bool ok = mqtt.connect(mqttClientId, user, pass, statusTopic, 0, true,
                                 lwtPayload, true);
    if (!ok) {
        mqttFailures.fetch_add(1);
        if ((mqttFailures.load() % 5U) == 1U) {
            Serial.printf(
                "[NodeMonitor] MQTT connect failed (host=%s:%u state=%d), "
                "will retry\n",
                mqttHost, static_cast<unsigned>(cfg.mqttPort),
                mqtt.state());
        }
        return;
    }

    mqttConnected.store(true);
    mqttWasConnected = true;
    mqttConnects.fetch_add(1);
    mqttBackoff = cfg.mqttRetryIntervalMs;
    lastMetricsMs = 0;
    lastStatusMs = 0;
    publishStatus(true);
    publishMetrics();

    PendingEvent event{};
    copyText(event.type, sizeof(event.type), "monitor");
    snprintf(event.detail, sizeof(event.detail),
             "MQTT connected to %s:%u", mqttHost,
             static_cast<unsigned>(cfg.mqttPort));
    event.deviceMs = millis();
    enqueueEvent(event);

    Serial.printf("[NodeMonitor] MQTT connected: %s:%u\n", mqttHost,
                  static_cast<unsigned>(cfg.mqttPort));
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------
void NodeMonitor::Impl::parseLine(const char* rawLine) {
    if (rawLine == nullptr) return;
    char line[kLogLineLen];
    stripAnsi(rawLine, line, sizeof(line));
    if (line[0] == '\0') return;

    // Local address from the logger's task prefix, e.g. "[0x1A2B]".
    const char* bracket = strstr(line, "[0x");
    if (bracket != nullptr) {
        unsigned int addr = 0;
        if (sscanf(bracket, "[0x%x]", &addr) == 1 && addr > 0 &&
            addr < 0xFFFF) {
            setLocalAddressInternal(static_cast<uint16_t>(addr));
        }
    }

    // Explicit address announcements.
    if (loraAddress.load() == 0) {
        const char* patterns[] = {
            "Generated node address 0x",
            "Generated fallback node address 0x",
            "LoRaMesh protocol initialized for node 0x",
            "Using configured node address 0x",
        };
        for (const char* pattern : patterns) {
            const char* p = strstr(line, pattern);
            if (p == nullptr) continue;
            unsigned int addr = 0;
            if (sscanf(p, "%*[^0]0x%x", &addr) == 1 && addr > 0 &&
                addr < 0xFFFF) {
                setLocalAddressInternal(static_cast<uint16_t>(addr));
                break;
            }
        }
    }

    // --- TX -----------------------------------------------------------------
    const char* pTx = strstr(line, "PKT_TX dst=0x");
    if (pTx != nullptr) {
        unsigned int dst = 0, src = 0, type = 0, size = 0;
        if (sscanf(pTx, "PKT_TX dst=0x%x src=0x%x type=0x%x size=%u", &dst,
                   &src, &type, &size) == 4) {
            txPackets.fetch_add(1);
            lastDst.store(static_cast<uint16_t>(dst));
            lastActivityMs.store(millis());
            if (loraAddress.load() == 0 && src > 0 && src < 0xFFFF) {
                setLocalAddressInternal(static_cast<uint16_t>(src));
            }
            PendingEvent event{};
            copyText(event.type, sizeof(event.type), "tx");
            snprintf(event.detail, sizeof(event.detail), "TX %u B -> 0x%04X",
                     size, dst);
            event.deviceMs = millis();
            event.src = static_cast<uint16_t>(src);
            event.dst = static_cast<uint16_t>(dst);
            event.size = static_cast<uint16_t>(size > 0xFFFF ? 0xFFFF : size);
            event.msgType = static_cast<uint8_t>(type);
            event.hasSrc = true;
            event.hasDst = true;
            enqueueEvent(event);
        }
    }

    // --- RX -----------------------------------------------------------------
    const char* pRx = strstr(line, "PKT_RX src=0x");
    if (pRx != nullptr) {
        unsigned int src = 0, dst = 0, type = 0, size = 0;
        float rssi = NAN, snr = NAN;
        const int fields = sscanf(
            pRx,
            "PKT_RX src=0x%x dst=0x%x type=0x%x size=%u rssi=%f snr=%f", &src,
            &dst, &type, &size, &rssi, &snr);
        if (fields >= 4) {
            rxPackets.fetch_add(1);
            lastSrc.store(static_cast<uint16_t>(src));
            lastActivityMs.store(millis());
            if (loraAddress.load() == 0 && dst > 0 && dst < 0xFFFF) {
                setLocalAddressInternal(static_cast<uint16_t>(dst));
            }
            if (fields >= 6 && !std::isnan(rssi) && rssi > -200.0F &&
                rssi < 50.0F) {
                loraRssiX10.store(static_cast<int16_t>(rssi * 10.0F));
            }
            if (fields >= 6 && !std::isnan(snr) && snr > -50.0F && snr < 50.0F) {
                loraSnrX10.store(static_cast<int16_t>(snr * 10.0F));
            }
            PendingEvent event{};
            copyText(event.type, sizeof(event.type), "rx");
            snprintf(event.detail, sizeof(event.detail), "RX %u B <- 0x%04X",
                     size, src);
            event.deviceMs = millis();
            event.src = static_cast<uint16_t>(src);
            event.dst = static_cast<uint16_t>(dst);
            event.size = static_cast<uint16_t>(size > 0xFFFF ? 0xFFFF : size);
            event.msgType = static_cast<uint8_t>(type);
            event.hasSrc = true;
            event.hasDst = true;
            if (fields >= 6 && !std::isnan(rssi)) {
                event.rssi = rssi;
                event.hasRssi = true;
            }
            if (fields >= 6 && !std::isnan(snr)) {
                event.snr = snr;
                event.hasSnr = true;
            }
            enqueueEvent(event);
        }
    }

    // --- Routing table ------------------------------------------------------
    bool routeHandled = false;
    const char* pRoute = strstr(line, "Route ");
    if (pRoute != nullptr) {
        unsigned int dest = 0, next = 0;
        int hops = 0;
        if (sscanf(pRoute, "Route removed: dest=0x%x via=0x%x hops=%d", &dest,
                   &next, &hops) == 3) {
            removeRoute(static_cast<uint16_t>(dest), true);
            routeHandled = true;
        } else if (sscanf(pRoute,
                          "Route updated: dest=0x%x via=0x%x hops=%d", &dest,
                          &next, &hops) == 3) {
            updateRoute(static_cast<uint16_t>(dest),
                        static_cast<uint16_t>(next),
                        static_cast<uint8_t>(hops), true);
            routeHandled = true;
        }
    }
    if (!routeHandled) {
        const char* p = strstr(line, "Added node 0x");
        if (p != nullptr) {
            unsigned int dest = 0, next = 0;
            int hops = 0;
            if (sscanf(p, "Added node 0x%x with route via 0x%x, hop count %d",
                       &dest, &next, &hops) == 3) {
                updateRoute(static_cast<uint16_t>(dest),
                            static_cast<uint16_t>(next),
                            static_cast<uint8_t>(hops), true);
                routeHandled = true;
            }
        }
    }
    if (!routeHandled) {
        const char* p = strstr(line, "Added route to 0x");
        if (p != nullptr) {
            unsigned int dest = 0, next = 0;
            int hops = 0;
            if (sscanf(p, "Added route to 0x%x via 0x%x (hops: %d)", &dest,
                       &next, &hops) == 3) {
                updateRoute(static_cast<uint16_t>(dest),
                            static_cast<uint16_t>(next),
                            static_cast<uint8_t>(hops), true);
                routeHandled = true;
            }
        }
    }
    if (!routeHandled) {
        const char* p = strstr(line, "Added new direct neighbor node 0x");
        if (p != nullptr) {
            unsigned int dest = 0;
            if (sscanf(p, "Added new direct neighbor node 0x%x", &dest) == 1) {
                updateRoute(static_cast<uint16_t>(dest),
                            static_cast<uint16_t>(dest), 1, true);
                routeHandled = true;
            }
        }
    }
    if (!routeHandled) {
        const char* p = strstr(line, "New node 0x");
        if (p != nullptr) {
            unsigned int dest = 0, next = 0;
            if (sscanf(p, "New node 0x%x via 0x%x", &dest, &next) == 2) {
                updateRoute(static_cast<uint16_t>(dest),
                            static_cast<uint16_t>(next), 0, true);
                routeHandled = true;
            }
        }
    }
    if (!routeHandled) {
        const char* p = strstr(line, "Added new node 0x");
        if (p != nullptr) {
            unsigned int dest = 0;
            if (sscanf(p, "Added new node 0x%x", &dest) == 1) {
                updateRoute(static_cast<uint16_t>(dest), 0, 0, true);
                routeHandled = true;
            }
        }
    }
    if (!routeHandled) {
        const char* p = strstr(line, "Removing node 0x");
        if (p != nullptr) {
            unsigned int dest = 0;
            if (sscanf(p, "Removing node 0x%x", &dest) == 1) {
                removeRoute(static_cast<uint16_t>(dest), true);
                routeHandled = true;
            }
        }
    }
    if (!routeHandled) {
        const char* p = strstr(line, "Removing oldest node 0x");
        if (p != nullptr) {
            unsigned int dest = 0;
            if (sscanf(p, "Removing oldest node 0x%x", &dest) == 1) {
                removeRoute(static_cast<uint16_t>(dest), true);
                routeHandled = true;
            }
        }
    }
    if (strstr(line, "Cleared routing table") != nullptr) {
        clearRoutes();
    }

    // --- Network state ------------------------------------------------------
    const char* pManager = strstr(line, "Updated network manager to 0x");
    if (pManager == nullptr) {
        pManager = strstr(line, "Network manager set to 0x");
    }
    if (pManager != nullptr) {
        unsigned int manager = 0;
        if (sscanf(pManager, "%*[^0]0x%x", &manager) == 1) {
            networkManager.store(static_cast<uint16_t>(manager));
            PendingEvent event{};
            copyText(event.type, sizeof(event.type), "network");
            snprintf(event.detail, sizeof(event.detail),
                     "Network manager 0x%04X", manager);
            event.deviceMs = millis();
            enqueueEvent(event);
        }
    }

    const char* pJoined = strstr(line, "Successfully joined network 0x");
    if (pJoined != nullptr) {
        unsigned int network = 0;
        if (sscanf(pJoined, "Successfully joined network 0x%x", &network) == 1) {
            PendingEvent event{};
            copyText(event.type, sizeof(event.type), "network");
            snprintf(event.detail, sizeof(event.detail),
                     "Joined network 0x%04X", network);
            event.deviceMs = millis();
            enqueueEvent(event);
        }
    }

    const char* pCreated = strstr(line, "Created new network as manager 0x");
    if (pCreated != nullptr) {
        unsigned int manager = 0;
        if (sscanf(pCreated, "Created new network as manager 0x%x", &manager) ==
            1) {
            networkManager.store(static_cast<uint16_t>(manager));
            PendingEvent event{};
            copyText(event.type, sizeof(event.type), "network");
            snprintf(event.detail, sizeof(event.detail),
                     "Created network as manager 0x%04X", manager);
            event.deviceMs = millis();
            enqueueEvent(event);
        }
    }

    const char* pState = strstr(line, "Network service state changed to ");
    if (pState == nullptr) pState = strstr(line, "Protocol state changed to ");
    if (pState != nullptr) {
        int state = -1;
        const char* value = strrchr(pState, ' ');
        if (value != nullptr && sscanf(value + 1, "%d", &state) == 1) {
            networkState.store(static_cast<uint8_t>(state < 0 ? 0 : state));
            PendingEvent event{};
            copyText(event.type, sizeof(event.type), "network");
            snprintf(event.detail, sizeof(event.detail), "Network state %d",
                     state);
            event.deviceMs = millis();
            enqueueEvent(event);
        }
    }

    if (strstr(line, "Node role is NETWORK_MANAGER") != nullptr) {
        PendingEvent event{};
        copyText(event.type, sizeof(event.type), "network");
        copyText(event.detail, sizeof(event.detail),
                 "Role: NETWORK_MANAGER");
        event.deviceMs = millis();
        enqueueEvent(event);
    }

    // --- Errors -------------------------------------------------------------
    if (strstr(line, "Failed to send") != nullptr ||
        strstr(line, "Failed to queue") != nullptr ||
        strstr(line, "No route to dest=") != nullptr) {
        txErrors.fetch_add(1);
        PendingEvent event{};
        copyText(event.type, sizeof(event.type), "error");
        copyText(event.detail, sizeof(event.detail), line);
        event.deviceMs = millis();
        enqueueEvent(event);
    } else if (strstr(line, "Receive queue full") != nullptr ||
               strstr(line, "Failed to deserialize") != nullptr) {
        rxErrors.fetch_add(1);
        PendingEvent event{};
        copyText(event.type, sizeof(event.type), "error");
        copyText(event.detail, sizeof(event.detail), line);
        event.deviceMs = millis();
        enqueueEvent(event);
    }

    if (cfg.publishRawLogs && mqtt.connected()) {
        publishRawLog(line);
    }
}

void NodeMonitor::Impl::processLogQueue() {
    if (logQueue == nullptr) return;
    char line[kLogLineLen];
    int processed = 0;
    while (processed < 24 && xQueueReceive(logQueue, line, 0) == pdTRUE) {
        ++processed;
        parseLine(line);
    }
}

void NodeMonitor::Impl::processEventQueue() {
    if (eventQueue == nullptr) return;

    if (!mqtt.connected() && !cfg.serialTelemetry) {
        // Do not replay stale events after an outage. Metrics retain totals.
        PendingEvent discard{};
        int drained = 0;
        while (drained < 8 && xQueueReceive(eventQueue, &discard, 0) == pdTRUE) {
            ++drained;
            droppedEvents.fetch_add(1);
        }
        return;
    }

    PendingEvent event{};
    int processed = 0;
    while (processed < 8 && xQueueReceive(eventQueue, &event, 0) == pdTRUE) {
        ++processed;
        publishEventNow(event);
    }
}

// ---------------------------------------------------------------------------
// MQTT payloads
// ---------------------------------------------------------------------------
void NodeMonitor::Impl::fillCommon(JsonDocument& doc) const {
    doc["schema"] = NODEMONITOR_SCHEMA;
    doc["node_id"] = nodeId;
    doc["board"] = NodeMonitor::boardName();
    doc["fw"] = NODEMONITOR_VERSION;
    doc["boot_id"] = bootId.load();
    doc["uptime_s"] = millis() / 1000UL;
    const uint16_t addr = loraAddress.load();
    doc["lora_addr"] = addr;
    char hex[8];
    snprintf(hex, sizeof(hex), "0x%04X", static_cast<unsigned>(addr));
    doc["lora_addr_hex"] = hex;
}

void NodeMonitor::Impl::publishMetrics() {
    JsonDocument doc;
    fillCommon(doc);
    doc["free_heap"] = ESP.getFreeHeap();
    doc["min_free_heap"] = ESP.getMinFreeHeap();

    const bool wifiOk = hasWifi && (WiFi.status() == WL_CONNECTED);
    doc["wifi_connected"] = wifiOk;
    if (wifiOk) {
        const int rssi = WiFi.RSSI();
        doc["wifi_rssi"] = rssi;
        // Linear 0-100 quality estimate from the measured RSSI.
        int quality = 2 * (rssi + 100);
        if (quality < 0) quality = 0;
        if (quality > 100) quality = 100;
        doc["wifi_quality"] = quality;
        doc["wifi_ssid"] = WiFi.SSID();
        doc["wifi_channel"] = WiFi.channel();
        doc["ip"] = WiFi.localIP().toString();
    } else {
        doc["wifi_rssi"] = nullptr;
        doc["wifi_quality"] = nullptr;
        doc["ip"] = nullptr;
    }

    doc["mqtt_connected"] = mqtt.connected();
    doc["mqtt_connects"] = mqttConnects.load();
    doc["mqtt_failures"] = mqttFailures.load();
    doc["mqtt_disconnects"] = mqttDisconnects.load();
    doc["wifi_disconnects"] = wifiDisconnects.load();

    doc["tx_packets"] = txPackets.load();
    doc["rx_packets"] = rxPackets.load();
    doc["tx_errors"] = txErrors.load();
    doc["rx_errors"] = rxErrors.load();
    doc["publish_failures"] = publishFailures.load();
    doc["log_dropped"] = droppedLogLines.load();
    doc["events_dropped"] = droppedEvents.load();
    doc["events_suppressed"] = suppressedEvents.load();

    const uint16_t src = lastSrc.load();
    const uint16_t dst = lastDst.load();
    doc["last_src"] = src;
    doc["last_dst"] = dst;
    const uint32_t last = lastActivityMs.load();
    doc["last_activity_ago_s"] =
        last == 0 ? -1 : static_cast<int32_t>((millis() - last) / 1000UL);

    const int16_t rssiX10 = loraRssiX10.load();
    const int16_t snrX10 = loraSnrX10.load();
    if (rssiX10 != kNoSignal) {
        doc["lora_rssi"] = static_cast<float>(rssiX10) / 10.0F;
    } else {
        doc["lora_rssi"] = nullptr;
    }
    if (snrX10 != kNoSignal) {
        doc["lora_snr"] = static_cast<float>(snrX10) / 10.0F;
    } else {
        doc["lora_snr"] = nullptr;
    }

    doc["network_manager"] = networkManager.load();
    doc["network_state"] = networkState.load();
    doc["nodes"] = static_cast<uint32_t>(routeCount + 1);

    JsonArray routesJson = doc["routes"].to<JsonArray>();
    for (size_t i = 0; i < routeCount; ++i) {
        JsonObject route = routesJson.add<JsonObject>();
        route["dest"] = routes[i].destination;
        route["next"] = routes[i].nextHop;
        route["hops"] = routes[i].hops;
        route["valid"] = routes[i].valid;
    }

    const size_t length = serializeJson(doc, payload, sizeof(payload));
    if (length == 0) return;

    if (mqtt.connected() && !mqtt.publish(metricsTopic, payload, false)) {
        publishFailures.fetch_add(1);
    }

    if (cfg.serialTelemetry) {
        Serial.print("@MON_JSON:");
        Serial.println(payload);
    }
}

void NodeMonitor::Impl::publishStatus(bool online) {
    if (!mqtt.connected()) return;
    JsonDocument doc;
    fillCommon(doc);
    doc["online"] = online;
    doc["mqtt_connected"] = online;
    doc["wifi_connected"] = hasWifi && (WiFi.status() == WL_CONNECTED);
    doc["ip"] = (hasWifi && WiFi.status() == WL_CONNECTED)
                    ? WiFi.localIP().toString()
                    : "";

    const size_t length = serializeJson(doc, payload, sizeof(payload));
    if (length == 0) return;
    if (!mqtt.publish(statusTopic, payload, true)) {
        publishFailures.fetch_add(1);
    }
}

void NodeMonitor::Impl::publishEventNow(const PendingEvent& event) {
    const uint32_t now = millis();
    if (static_cast<uint32_t>(now - rateWindowMs) >= 1000UL) {
        rateWindowMs = now;
        rateCount = 0;
    }
    if (rateCount >= cfg.maxEventsPerSecond) {
        suppressedEvents.fetch_add(1);
        return;
    }
    ++rateCount;

    JsonDocument doc;
    fillCommon(doc);
    doc["event"] = event.type;
    doc["detail"] = event.detail;
    doc["device_ms"] = event.deviceMs;
    if (event.hasSrc) doc["src"] = event.src;
    if (event.hasDst) doc["dst"] = event.dst;
    if (event.hasSrc || event.hasDst) doc["size"] = event.size;
    if (event.msgType != 0) doc["msg_type"] = event.msgType;
    if (event.hasRssi) doc["lora_rssi"] = event.rssi;
    if (event.hasSnr) doc["lora_snr"] = event.snr;

    const size_t length = serializeJson(doc, eventPayload, sizeof(eventPayload));
    if (length == 0) return;
    if (mqtt.connected() && !mqtt.publish(eventsTopic, eventPayload, false)) {
        publishFailures.fetch_add(1);
    }

    if (cfg.serialTelemetry && event.type[0] != '\0' &&
        strcmp(event.type, "rx") != 0 && strcmp(event.type, "tx") != 0) {
        Serial.print("@MON_EVENT:");
        Serial.println(eventPayload);
    }
}

void NodeMonitor::Impl::publishRawLog(const char* line) {
    if (!mqtt.connected() || line == nullptr) return;
    const uint32_t now = millis();
    if (static_cast<uint32_t>(now - rawWindowMs) >= 1000UL) {
        rawWindowMs = now;
        rawCount = 0;
    }
    if (rawCount >= 10) return;
    ++rawCount;
    if (!mqtt.publish(rawLogTopic, line, false)) {
        publishFailures.fetch_add(1);
    }
}

int NodeMonitor::Impl::customVprintf(const char* format, va_list args) {
    char buffer[kLogLineLen];
    va_list copy;
    va_copy(copy, args);
    const int length = vsnprintf(buffer, sizeof(buffer), format, copy);
    va_end(copy);
    NodeMonitor& instance = NodeMonitor::getInstance();
    if (length > 0) {
        if (instance.impl_ != nullptr && instance.impl_->logQueue != nullptr) {
            if (xPortInIsrContext()) {
                BaseType_t woken = pdFALSE;
                xQueueSendFromISR(instance.impl_->logQueue, buffer, &woken);
                if (woken == pdTRUE) portYIELD_FROM_ISR(woken);
            } else if (xQueueSend(instance.impl_->logQueue, buffer, 0) != pdTRUE) {
                instance.impl_->droppedLogLines.fetch_add(1);
            }
        }
    }
    if (instance.impl_ != nullptr && instance.impl_->originalVprintf != nullptr) {
        return instance.impl_->originalVprintf(format, args);
    }
    return vprintf(format, args);
}

}  // namespace nodemonitor
