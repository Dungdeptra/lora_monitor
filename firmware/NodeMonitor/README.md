# NodeMonitor

Non-intrusive Wi-Fi/MQTT telemetry for [LoRaMesher](https://github.com/pvcd/LoRaMesher)
on **Heltec WiFi LoRa 32 V3 / V4**.

The library observes the existing LoRaMesher log stream in a dedicated
FreeRTOS task. It does not replace the radio, modify routing, or change the
application's data structures. No `monitor.update()` call is needed in
`loop()`.

## Features

- Stable node ID derived from the factory MAC (`NODE_XXXXXX`).
- Wi-Fi and MQTT reconnect with backoff.
- Retained status topic plus MQTT Last Will.
- Real RSSI/SNR only; absent measurements become JSON `null`.
- TX/RX packet counters, TX/RX errors, publish failures, heap, uptime.
- Routing table reconstruction from actual route logs (read-only).
- Event stream for packets, routes, network state and errors.
- Optional raw log publishing and ESP-IDF log capture.
- Backwards-compatible API from NodeMonitor v1 (`beginSerialOnly`,
  `hookStdout`, `recordTx`, `recordRx`, `logEvent`).

## Installation

Copy `NodeMonitor/` into `<project>/lib/`, or point PlatformIO at the parent
folder:

```ini
lib_extra_dirs =
    ../../LoRaMesh_Monitoring/firmware

lib_deps =
    knolleary/PubSubClient@^2.8
    bblanchon/ArduinoJson@^7.0.4
```

Do not keep a second copy of `NodeMonitor.cpp` in the sketch folder.

## Minimal usage

```cpp
#include <NodeMonitor.h>

void setup() {
    Serial.begin(115200);

    NodeMonitor::getInstance().begin(
        "YOUR_WIFI", "YOUR_PASSWORD", "broker.emqx.io", 1883);

    // Existing LoRaMesher setup...
}
```

Call `begin()` before starting the mesh if you want boot and early routing
logs. The monitor prints `@MON_JSON:{...}` telemetry to Serial by default.

## Full configuration

```cpp
nodemonitor::MonitorConfig cfg;
cfg.wifiSsid     = "YOUR_WIFI";
cfg.wifiPassword = "YOUR_PASSWORD";
cfg.mqttHost     = "broker.emqx.io";
cfg.mqttPort     = 1883;
cfg.topicPrefix  = "loramesh";
cfg.nodeId       = nullptr;  // MAC-derived
NodeMonitor::getInstance().begin(cfg);
```

See `include/NodeMonitor.h` for every field and its default.

## API

| Method | Purpose |
|---|---|
| `begin(const MonitorConfig&)` | Start the FreeRTOS task. |
| `begin(ssid, pass, host, port, nodeId, user, pass)` | Compatibility overload. |
| `beginSerialOnly(intervalMs)` | No network; print `@MON_JSON` to Serial. |
| `end()` | Publish offline status and stop the task. |
| `started()` | Task state. |
| `nodeId()` / `localAddress()` | Identity observed by the monitor. |
| `setLocalAddress(addr)` | Override address detection. |
| `recordTx(dst, bytes, type)` | Manual TX hook. |
| `recordRx(src, bytes, rssi, snr, type)` | Manual RX hook; pass `NAN` when unknown. |
| `recordError(code, detail)` | Application error event. |
| `logEvent(event, detail)` | Custom event. |
| `feedLogLine(line)` | Inject a plain log line. |
| `hookStdout()` | Tee `std::cout`/`std::cerr`. |
| `hookEspLog(enable)` | Capture ESP-IDF logs (debug). |
| `snapshot()` | Thread-safe counter snapshot. |
| `boardType()` / `boardName()` | Compile-time board detection. |

## Topics

```text
<prefix>/<node_id>/status
<prefix>/<node_id>/metrics
<prefix>/<node_id>/events
<prefix>/<node_id>/logs
```

See [`../../docs/MQTT_PROTOCOL.md`](../../docs/MQTT_PROTOCOL.md) for payload
examples and field semantics.

## Task model

`begin()` creates:

- a 48-entry log queue (192 bytes per line),
- a 24-entry event queue,
- one FreeRTOS task pinned to core 0 with a 10 KB stack.

The LoRaMesher log handler only formats a line and enqueues it. The monitor
task owns Wi-Fi, MQTT, JSON serialization and publishing. This keeps radio
callbacks and application code free from network blocking.

The MQTT payload buffer is 3072 bytes and PubSubClient is configured with a
4096-byte buffer. Event publishing is rate-limited (20/s by default), raw logs
are limited to 10/s, and the routing observation table holds 24 destinations.

## Board notes

Both V3 and V4 use an ESP32-S3 + SX1262 with a 1.8 V TCXO. The V4 has an
additional front-end module:

- `FEM_EN` GPIO 2 → HIGH
- `PA_CTX` GPIO 5 → LOW

Those pins belong to the sketch/hardware setup, not to NodeMonitor. The monitor
only reads logs; it never touches radio pins.

## Verification

The example project compiles for both environments:

```powershell
cd examples/simple_example
pio run -e heltec_wifi_lora_32_V3
pio run -e heltec_wifi_lora_32_V4
```

Compilation is verified. Physical Wi-Fi/MQTT behavior on real V3/V4 hardware
still needs to be tested before production deployment.

## License

MIT, consistent with the LoRaMesher project.
