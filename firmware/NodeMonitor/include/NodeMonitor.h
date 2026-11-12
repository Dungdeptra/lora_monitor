/**
 * @file NodeMonitor.h
 * @brief Non-intrusive Wi-Fi/MQTT telemetry for LoRaMesher nodes.
 *
 * NodeMonitor runs in its own FreeRTOS task and observes the existing
 * LoRaMesher log stream. It does not replace the radio, the routing
 * algorithm, the application callbacks, or the main loop.
 *
 * Quick start (2 lines in the sketch):
 * @code
 * #include <NodeMonitor.h>
 * void setup() { NodeMonitor::getInstance().begin("SSID", "PASS", "broker.emqx.io"); }
 * @endcode
 *
 * The module never invents signal values. RSSI/SNR fields are only
 * published when the LoRaMesher/RadioLib layer reports real measurements.
 *
 * License: MIT
 */

#pragma once

#include <Arduino.h>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>

#define NODEMONITOR_VERSION "2.1.0"
#define NODEMONITOR_SCHEMA 1

namespace nodemonitor {

/** Hardware family detected at compile time. */
enum class BoardType : uint8_t {
    kUnknown = 0,
    kHeltecV3 = 1,
    kHeltecV4 = 2,
};

/** Runtime configuration. All strings are copied by begin(). */
struct MonitorConfig {
    // --- Wi-Fi ------------------------------------------------------------
    const char* wifiSsid = nullptr;
    const char* wifiPassword = nullptr;

    // --- MQTT -------------------------------------------------------------
    const char* mqttHost = nullptr;       ///< Hostname or IP address.
    uint16_t mqttPort = 1883;             ///< 1883 plain TCP, 8883 TLS.
    const char* mqttUsername = nullptr;   ///< Optional.
    const char* mqttPassword = nullptr;   ///< Optional.
    bool useTls = false;                  ///< Use WiFiClientSecure.
    bool tlsInsecure = true;              ///< Skip certificate verification.
    const char* mqttCaCert = nullptr;     ///< Optional PEM root CA.

    // --- Identity / topics ------------------------------------------------
    const char* nodeId = nullptr;         ///< Optional; MAC-derived otherwise.
    const char* topicPrefix = "loramesh"; ///< default: loramesh/<node>/...

    // --- Timing -----------------------------------------------------------
    uint32_t metricsIntervalMs = 5000;    ///< Telemetry period.
    uint32_t statusIntervalMs = 30000;    ///< Retained status refresh.
    uint32_t wifiRetryIntervalMs = 15000; ///< Wi-Fi retry backoff base.
    uint32_t mqttRetryIntervalMs = 5000;  ///< MQTT retry backoff base.

    // --- Features ---------------------------------------------------------
    bool captureLoRaMesherLogs = true;    ///< Parse LoRaMesher log events.
    bool publishRawLogs = false;          ///< Debug: also publish raw lines.
    bool serialTelemetry = true;          ///< Print @MON_JSON lines to Serial.
    bool captureEspLogs = false;          ///< Debug: hook esp_log_set_vprintf.
    uint16_t maxEventsPerSecond = 20;     ///< MQTT event rate limit.
};

/**
 * @brief Read-only view of the monitor state.
 *
 * Useful on the serial console or for a status LED. All values are real
 * observations; unavailable values are zero / false.
 */
struct MonitorSnapshot {
    bool started = false;
    bool wifiConnected = false;
    bool mqttConnected = false;
    uint16_t loraAddress = 0;
    uint32_t uptimeSeconds = 0;
    uint32_t txPackets = 0;
    uint32_t rxPackets = 0;
    uint32_t txErrors = 0;
    uint32_t rxErrors = 0;
    int16_t wifiRssi = 0;
    bool hasLoraRssi = false;
    float loraRssi = 0.0F;
    bool hasLoraSnr = false;
    float loraSnr = 0.0F;
};

/**
 * @brief Singleton monitor service.
 *
 * The public API is thread-safe. recordTx(), recordRx(), logEvent() and
 * feedLogLine() only enqueue work; they never perform network I/O.
 */
class NodeMonitor {
   public:
    static NodeMonitor& getInstance();

    /**
     * @brief Start the monitor.
     *
     * Safe to call more than once; only the first call has an effect.
     * @return true when the FreeRTOS task was created.
     */
    bool begin(const MonitorConfig& config);

    /**
     * @brief Convenience overload kept for backwards compatibility.
     *
     * @param wifiSsid       Wi-Fi SSID (nullptr = serial-only mode).
     * @param wifiPassword   Wi-Fi password.
     * @param mqttHost       MQTT broker hostname or IP.
     * @param mqttPort       MQTT TCP port (usually 1883).
     * @param nodeId         Optional stable ID; MAC-derived when nullptr.
     * @param mqttUsername   Optional broker username.
     * @param mqttPassword   Optional broker password.
     */
    bool begin(const char* wifiSsid, const char* wifiPassword,
               const char* mqttHost, uint16_t mqttPort = 1883,
               const char* nodeId = nullptr, const char* mqttUsername = nullptr,
               const char* mqttPassword = nullptr);

    /** @brief Start without Wi-Fi; telemetry is printed to Serial only. */
    bool beginSerialOnly(uint32_t metricsIntervalMs = 5000);

    /** @brief Publish an offline status and stop the FreeRTOS task. */
    void end();

    bool started() const;
    const char* nodeId() const;
    uint16_t localAddress() const;

    /**
     * @brief Override the LoRa address (normally auto-detected from logs).
     */
    void setLocalAddress(uint16_t address);

    /**
     * @brief Manual TX hook for applications that do not use log capture.
     *
     * Do not call this together with automatic capture of the same packet,
     * otherwise the packet is counted twice.
     */
    void recordTx(uint16_t destination, size_t payloadBytes,
                  uint8_t messageType = 0);

    /**
     * @brief Manual RX hook for applications that do not use log capture.
     *
     * Pass NAN for rssi/snr when the values are not available; they will be
     * omitted from the MQTT payload instead of being replaced by fake data.
     */
    void recordRx(uint16_t source, size_t payloadBytes, float rssi = NAN,
                  float snr = NAN, uint8_t messageType = 0);

    /** @brief Record a custom application error/event. */
    void recordError(const char* code, const char* detail);
    void logEvent(const char* event, const char* detail);

    /** @brief Feed one plain-text log line (called by the log hooks). */
    void feedLogLine(const char* line);

    /**
     * @brief Tee std::cout / std::cerr into the monitor (optional).
     *
     * Call after begin() if the sketch uses std::cout for application logs.
     */
    void hookStdout();

    /** @brief Capture ESP_LOG output too (optional, disabled by default). */
    void hookEspLog(bool enable = true);

    /**
     * @brief Optional cooperative service call.
     *
     * Not required: begin() already starts a dedicated task. This exists for
     * users who want to run the monitor from their own loop instead.
     */
    void loop();

    /** @brief Thread-safe snapshot for diagnostics. */
    MonitorSnapshot snapshot() const;

    /** @brief Board detected at compile time. */
    static BoardType boardType();
    static const char* boardName();

   private:
    NodeMonitor();
    ~NodeMonitor();
    NodeMonitor(const NodeMonitor&) = delete;
    NodeMonitor& operator=(const NodeMonitor&) = delete;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace nodemonitor

// Backwards-compatible global alias (existing sketches keep compiling).
using NodeMonitor = nodemonitor::NodeMonitor;
