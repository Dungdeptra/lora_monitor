#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <esp_log.h>

struct MonitorConfig {
    const char* wifiSsid = nullptr;
    const char* wifiPassword = nullptr;
    const char* mqttHost = nullptr;
    uint16_t mqttPort = 1883;
    const char* customNodeId = nullptr;
    uint32_t publishIntervalMs = 3000;
    bool enableSerialOutput = true;
};

class NodeMonitor {
public:
    static NodeMonitor& getInstance() {
        static NodeMonitor instance;
        return instance;
    }

    // 1. Chi chay qua cong COM (USB Serial)
    void beginSerialOnly(uint32_t publishIntervalMs = 3000) {
        MonitorConfig cfg;
        cfg.publishIntervalMs = publishIntervalMs;
        cfg.enableSerialOutput = true;
        begin(cfg);
    }

    // 2. Chay dong thoi Cong COM + Wi-Fi MQTT
    void begin(const char* wifiSsid, const char* wifiPass, const char* mqttHost, uint16_t mqttPort = 1883, const char* customNodeId = nullptr);
    void begin(const MonitorConfig& cfg);

    // Goi thu cong hoac tu dong bat log tu he thong
    void setLocalAddress(uint16_t addr);
    uint16_t localAddress() const { return _localAddr; }
    void feedLogLine(const char* line);
    uint32_t droppedLines() const { return _droppedLines; }

    // Bat tinh nang neu (tee) std::cout / std::cerr ra MQTT (can goi trong setup())
    void hookStdout();
    void recordTx(uint16_t dstAddr, size_t payloadBytes, uint8_t msgType = 0x11);
    void recordRx(uint16_t srcAddr, size_t payloadBytes, float rssi = NAN, float snr = NAN, uint8_t msgType = 0x11);
    void logEvent(const char* eventType, const char* detail);

private:
    NodeMonitor() : _mqttClient(_wifiClient) {}

    MonitorConfig _cfg;
    WiFiClient _wifiClient;
    PubSubClient _mqttClient;
    TaskHandle_t _taskHandle = nullptr;
    QueueHandle_t _logQueue = nullptr;
    bool _initialized = false;

    String _nodeId;
    uint16_t _localAddr = 0;
    bool _hasWifiConfig = false;

    uint32_t _txCount = 0;
    uint32_t _rxCount = 0;
    uint16_t _lastSrc = 0;
    uint16_t _lastDst = 0;
    uint32_t _lastTxRxMillis = 0;
    float _lastLoRaRssi = NAN;
    float _lastLoRaSnr = NAN;

    uint32_t _lastWifiAttempt = 0;
    uint32_t _lastMqttAttempt = 0;
    uint32_t _lastPublish = 0;
    uint32_t _mqttDisconnectCount = 0;
    uint32_t _droppedLines = 0;

    static vprintf_like_t _origVprintf;
    static int customVprintf(const char* fmt, va_list args);

    static void taskEntry(void* pvParameters);
    void taskLoop();
    void ensureConnections();
    void processCapturedLogs();
    void parseLineMetrics(const char* line);
    void publishMetrics();
    void publishStatus(bool online);
};