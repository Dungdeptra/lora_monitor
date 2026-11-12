# MQTT protocol

The dashboard is a plain MQTT subscriber. Any client can consume the same
topics; there is no private HTTP API.

## 1. Topics

```text
<prefix>/<node_id>/status
<prefix>/<node_id>/metrics
<prefix>/<node_id>/events
<prefix>/<node_id>/logs
```

Defaults:

- `prefix`: `loramesh`
- `node_id`: MAC-derived `NODE_XXXXXX`
- Broker (firmware): `broker.emqx.io:1883` TCP
- Broker (browser): `wss://broker.emqx.io:8084/mqtt`

The dashboard subscribes to:

```text
<prefix>/+/status
<prefix>/+/metrics
<prefix>/+/events
<prefix>/+/logs     (optional checkbox)
```

`prefix` and `node_id` are sanitized to `A-Z a-z 0-9 _ -`. Spaces, `/`, `:`,
and `.` become underscores. This keeps the wildcard subscription predictable.

## 2. QoS, retain and Last Will

| Topic | Publish | Retain | QoS |
|---|---|---|---|
| `status` | on connect and every 30 s | **yes** | 0 |
| `metrics` | every 5 s | no | 0 |
| `events` | on packet/route/network/error | no | 0 |
| `logs` | optional debug | no | 0 |

The MQTT connection registers a retained Last Will on the status topic:

```json
{
  "schema": 1,
  "node_id": "NODE_A1B2C3",
  "online": false,
  "mqtt_connected": false,
  "lora_addr": 6699,
  "board": "heltec-v4",
  "fw": "2.1.0"
}
```

The will is delivered by the broker after the keepalive expires. It is a
monitoring signal only; it says the MQTT session ended, not that the LoRa radio
failed.

## 3. Common fields

All JSON payloads start with:

| Field | Type | Meaning |
|---|---|---|
| `schema` | integer | Payload schema, currently `1`. |
| `node_id` | string | Stable node identifier. |
| `board` | string | `heltec-v3`, `heltec-v4`, or `esp32`. |
| `fw` | string | NodeMonitor version. |
| `boot_id` | integer | Random value generated at boot. Changes on reboot. |
| `uptime_s` | integer | `millis() / 1000` at publish time. |
| `lora_addr` | integer | 16-bit LoRa address, or `0` until known. |
| `lora_addr_hex` | string | Formatted address, for example `0x1A2B`. |

## 4. Status payload

```json
{
  "schema": 1,
  "node_id": "NODE_A1B2C3",
  "board": "heltec-v4",
  "fw": "2.1.0",
  "boot_id": 3184921,
  "uptime_s": 8640,
  "lora_addr": 6699,
  "lora_addr_hex": "0x1A2B",
  "online": true,
  "mqtt_connected": true,
  "wifi_connected": true,
  "ip": "192.168.1.42"
}
```

`online: false` is also used for a graceful `end()`. The web client marks the
node as **telemetry offline** and preserves the last known metrics with a stale
badge.

## 5. Metrics payload

```json
{
  "schema": 1,
  "node_id": "NODE_A1B2C3",
  "board": "heltec-v4",
  "fw": "2.1.0",
  "boot_id": 3184921,
  "uptime_s": 8640,
  "lora_addr": 6699,
  "lora_addr_hex": "0x1A2B",

  "free_heap": 182456,
  "min_free_heap": 165000,

  "wifi_connected": true,
  "wifi_rssi": -52,
  "wifi_quality": 96,
  "wifi_ssid": "Truong Muoi",
  "wifi_channel": 6,
  "ip": "192.168.1.42",

  "mqtt_connected": true,
  "mqtt_connects": 3,
  "mqtt_failures": 1,
  "mqtt_disconnects": 1,
  "wifi_disconnects": 0,

  "tx_packets": 1284,
  "rx_packets": 2391,
  "tx_errors": 2,
  "rx_errors": 1,
  "publish_failures": 0,
  "log_dropped": 0,
  "events_dropped": 0,
  "events_suppressed": 0,

  "last_src": 15437,
  "last_dst": 11068,
  "last_activity_ago_s": 4,

  "lora_rssi": -74.5,
  "lora_snr": 8.25,

  "network_manager": 6699,
  "network_state": 3,
  "nodes": 4,

  "routes": [
    { "dest": 11068, "next": 11068, "hops": 1, "valid": true },
    { "dest": 15437, "next": 15437, "hops": 1, "valid": true },
    { "dest": 19806, "next": 11068, "hops": 2, "valid": true }
  ]
}
```

### Field notes

- `lora_rssi` and `lora_snr` are **real measurements** parsed from the
  `PKT_RX ... rssi=... snr=...` log line emitted by RadioLib. When no
  measurement exists they are `null`; the web displays `—`.
- `last_activity_ago_s` is `-1` when no packet has been seen yet.
- `routes` is a reconstructed observation table; it is not used by the routing
  algorithm. `nodes` is `routeCount + 1`.
- `wifi_rssi`, `wifi_quality`, `wifi_ssid`, `wifi_channel`, and `ip` are
  `null` when Wi-Fi is down at sample time.
- Counters are 32-bit and cumulative since boot.
- `boot_id` lets the web reset history and delta calculations after a reboot.
- `free_heap`/`min_free_heap` are bytes.

## 6. Event payload

```json
{
  "schema": 1,
  "node_id": "NODE_A1B2C3",
  "board": "heltec-v4",
  "fw": "2.1.0",
  "boot_id": 3184921,
  "uptime_s": 8640,
  "lora_addr": 6699,
  "lora_addr_hex": "0x1A2B",

  "event": "rx",
  "detail": "RX 5 B <- 0x3C4D",
  "device_ms": 119500,
  "src": 15437,
  "dst": 6699,
  "size": 5,
  "msg_type": 1,
  "lora_rssi": -74.5,
  "lora_snr": 8.25
}
```

Event types:

| `event` | Meaning |
|---|---|
| `tx` | Packet transmitted. |
| `rx` | Packet received; may include real RSSI/SNR. |
| `route_add` | Route observed/updated. |
| `route_remove` | Route removed or expired. |
| `network` | Network state/manager/join/role change. |
| `monitor` | Monitor lifecycle; currently MQTT connected. |
| `error` | Parsed TX/RX error line. |

Optional fields (`src`, `dst`, `size`, `msg_type`, `lora_rssi`, `lora_snr`)
are omitted when unavailable. `device_ms` is the device uptime in
milliseconds.

Events are rate-limited on the device (default 20/s). The dashboard keeps the
last 800 events in memory.

## 7. Raw logs

When `publishRawLogs = true`, the `logs` topic receives plain-text lines, not
JSON. The web only subscribes when **Subscribe to raw logs** is enabled in
settings. Raw logs are capped at 10 messages/second on the device and 140 lines
per node in the browser.

## 8. Browser connection

Use an MQTT-over-WebSocket listener:

- EMQX public: `wss://broker.emqx.io:8084/mqtt`
- Local Mosquitto: `ws://localhost:9001`
- HiveMQ public: `wss://broker.hivemq.com:8884/mqtt`

GitHub Pages is HTTPS, so the broker URL must be `wss://`. A `ws://` endpoint
fails as mixed content and is blocked before the MQTT handshake.

WebSocket is not subject to CORS in the same way as HTTP, but the broker must
have a WebSocket listener enabled. Port `1883` is TCP MQTT, not WebSocket.

## 9. Security

Public brokers are shared. Use a unique prefix for testing and a private broker
with authentication/TLS for real data. The dashboard stores broker credentials
in browser `localStorage`; do not use it on an untrusted machine.

`clean: true` is used for the dashboard session. Multiple dashboard tabs may
connect with different random client IDs.
