# Firmware integration

`NodeMonitor` is an observer. It reads the existing LoRaMesher log stream and
publishes telemetry over MQTT. It does not modify the radio, routing tables,
message queues, or the application callbacks.

## 1. Dependency wiring

The canonical library lives at:

```text
LoRaMesh_Monitoring/firmware/NodeMonitor
```

For the example project, `examples/simple_example/platformio.ini` points
PlatformIO at that single copy:

```ini
lib_extra_dirs =
    ../../LoRaMesh_Monitoring/firmware

lib_deps =
    file://../../loramesher_pkg
    https://github.com/jgromes/RadioLib#7.6.0
    SPI
    knolleary/PubSubClient@^2.8
    bblanchon/ArduinoJson@^7.0.4
```

For a different sketch, add the same `lib_extra_dirs` entry and the two
NodeMonitor dependencies (`PubSubClient`, `ArduinoJson`). Do not copy
`NodeMonitor.cpp` into the sketch folder if `lib_extra_dirs` already points at
the library, otherwise the linker sees duplicate symbols.

## 2. Minimal call

```cpp
#include <NodeMonitor.h>

void setup() {
    Serial.begin(115200);

    // Optional but useful for sketches that use std::cout.
    NodeMonitor::getInstance().begin(
        "YOUR_WIFI", "YOUR_PASSWORD", "broker.emqx.io", 1883);
    NodeMonitor::getInstance().hookStdout();

    // Existing LoRaMesher setup follows.
}
```

`begin()` starts a dedicated FreeRTOS task. Do not call `monitor.update()` or
`monitor.loop()` from `loop()`; the task services Wi-Fi, MQTT, queues and
publishing on its own.

## 3. Full configuration

```cpp
nodemonitor::MonitorConfig cfg;

cfg.wifiSsid       = "YOUR_WIFI";
cfg.wifiPassword   = "YOUR_PASSWORD";
cfg.mqttHost       = "broker.emqx.io";
cfg.mqttPort       = 1883;          // 1883 TCP, 8883 TLS
cfg.topicPrefix    = "my-mesh";     // default: loramesh
cfg.nodeId         = nullptr;        // MAC-derived when empty
cfg.mqttUsername   = nullptr;
cfg.mqttPassword   = nullptr;

cfg.metricsIntervalMs   = 5000;
cfg.statusIntervalMs    = 30000;
cfg.wifiRetryIntervalMs = 15000;
cfg.mqttRetryIntervalMs = 5000;

cfg.captureLoRaMesherLogs = true;
cfg.publishRawLogs        = false;  // debug only
cfg.serialTelemetry       = true;   // prints @MON_JSON lines
cfg.captureEspLogs        = false;  // debug only
cfg.maxEventsPerSecond    = 20;

NodeMonitor::getInstance().begin(cfg);
```

All strings are copied into fixed buffers inside `begin()`. Temporary
`String::c_str()` values are safe as long as the call completes.

### TLS

```cpp
cfg.mqttPort = 8883;
cfg.useTls = true;
cfg.tlsInsecure = false;             // verify certificate
cfg.mqttCaCert = ROOT_CA_PEM;        // PEM root CA
NodeMonitor::getInstance().begin(cfg);
```

For testing only, `tlsInsecure = true` skips verification. Do not use it in
production. The ESP32 needs enough free heap for a TLS session; metrics include
`free_heap` and `min_free_heap`.

### Serial-only mode

```cpp
NodeMonitor::getInstance().beginSerialOnly();
```

No Wi-Fi or MQTT is started. Metrics are printed as `@MON_JSON:{...}` every
5 seconds and can be parsed by a USB serial tool. This is useful on a bench
without a network.

## 4. Lifecycle and task model

At `begin()`:

1. Credentials and topic strings are copied.
2. Node ID is derived from the factory Wi-Fi MAC (`NODE_XXXXXX`) if no ID was
   supplied.
3. Two queues are created: log lines and events.
4. A LoRaMesher log handler tees every line to the original serial output and
   to the monitor queue.
5. A FreeRTOS task pinned to core 0 owns all network I/O.

The LoRa callbacks and logger only push fixed-size items into queues. They do
not block on DNS, sockets, TLS, or JSON serialization.

`end()` stops the task, publishes a retained offline status when possible and
deletes the queues. It is optional; most applications keep monitoring for the
lifetime of the device.

## 5. Manual hooks

Automatic log capture reads:

- `PKT_TX dst=0x.... src=0x.... type=0x.... size=...`
- `PKT_RX src=0x.... dst=0x.... type=0x.... size=... rssi=... snr=...`
- routing table messages such as `Route updated: dest=... via=... hops=...`

If your application bypasses the LoRaMesher logger, feed events manually:

```cpp
NodeMonitor& monitor = NodeMonitor::getInstance();

monitor.setLocalAddress(0x1A2B);
monitor.recordTx(0x2B3C, 5, 0x01);
monitor.recordRx(0x3C4D, 5, -74.5F, 8.25F, 0x01);
monitor.recordError("send_failed", "No route to 0x4D5E");
monitor.logEvent("app", "Gateway accepted command");
```

Do not call `recordTx()` / `recordRx()` for packets that are already counted by
automatic log capture, or the counters will be doubled.

Do not invent RSSI/SNR values. Pass `NAN` when no measurement exists; the
fields are then omitted from MQTT instead of being replaced with a fake value.

## 6. Board support: Heltec V3 and V4

Both boards use an ESP32-S3 with an SX1262. The example uses:

| Signal | GPIO |
|---|---|
| NSS / CS | 8 |
| RST | 12 |
| DIO1 / IRQ | 14 |
| BUSY | 13 |
| SCK | 9 |
| MISO | 11 |
| MOSI | 10 |

V4 additionally has a front-end module:

| Signal | GPIO | Level |
|---|---|---|
| FEM_EN | 2 | HIGH |
| PA_CTX | 5 | LOW |

The example enables those pins under
`ARDUINO_heltec_wifi_lora_32_V4` before creating the LoRaMesher instance. Both
boards need `radioConfig.setTcxoVoltage(1.8F)`.

The V4 environment also sets:

```ini
board_build.variants_dir = variants
board_build.variant = heltec_V4
```

If a different board revision changes the FEM wiring, only the sketch-level pin
configuration changes; NodeMonitor does not touch radio pins.

## 7. Log capture and serial output

`captureLoRaMesherLogs` installs a `loramesh::SerialLogHandler` replacement that
first calls the original handler, then enqueues a copy for parsing. Terminal
output is preserved.

`hookStdout()` tees `std::cout` / `std::cerr` into the monitor. Call it after
`begin()` if application code uses iostream.

`captureEspLogs` is disabled by default. When enabled it hooks
`esp_log_set_vprintf()`, which can capture Wi-Fi/ESP-IDF diagnostics. It adds
CPU overhead and log volume, so use it for debugging only.

## 8. Memory and performance

- Log queue: 48 entries × 192 bytes.
- Event queue: 24 entries, fixed-size structure.
- MQTT payload buffer: 3072 bytes; PubSubClient buffer increased to 4096.
- Route table observation capacity: 24 destinations.
- MQTT publish is rate-limited for events (default 20/s) and raw logs (10/s).
- Telemetry runs every 5 seconds by default, status every 30 seconds.

If memory is tight, reduce `maxEventsPerSecond`, disable raw logs, or increase
the metrics interval.

## 9. Verification

```powershell
cd examples/simple_example
pio run -e heltec_wifi_lora_32_V3
pio run -e heltec_wifi_lora_32_V4
```

Both environments were compiled successfully in this repository. Physical
Wi-Fi/MQTT behavior still needs testing on real boards.
