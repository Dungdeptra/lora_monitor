# LoRaMesh Monitor
- Dashboard web **100% static**, chạy được trên **GitHub Pages**, không cần Python server.
- Firmware chỉ cần **một dòng `begin()`** trong `setup()`. Không cần `monitor.update()` trong `loop()`.
- Telemetry chạy trong **FreeRTOS task riêng**, không thay đổi radio, routing hay cấu trúc dữ liệu của LoRaMesher.
- RSSI/SNR chỉ lấy từ giá trị thật do RadioLib/LoRaMesher báo về. Không có dữ liệu giả.
- Hỗ trợ nhiều node cùng lúc qua MQTT topics `<prefix>/<node_id>/...`.

> **Điểm quan trọng:** dashboard chỉ quan sát được MQTT. Khi Wi-Fi/MQTT mất, node biến mất khỏi dashboard dù LoRa mesh vẫn có thể đang chạy bình thường. Dashboard **không kết luận node LoRa bị lỗi** chỉ vì mất telemetry.

---

## 1. Bắt đầu nhanh

### Bước 1 — Cấu hình Wi-Fi và broker

```powershell
cd examples/simple_example/src
Copy-Item monitor_config.example.h monitor_config.h
```

Mở `monitor_config.h` và sửa:

```cpp
#define MONITOR_WIFI_SSID      "TEN_WIFI_CUA_BAN"
#define MONITOR_WIFI_PASSWORD  "MAT_KHAU_WIFI"

#define MONITOR_MQTT_HOST      "broker.emqx.io"
#define MONITOR_MQTT_PORT      1883
#define MONITOR_TOPIC_PREFIX   "loramesh"
```

`monitor_config.h` đã được gitignore. Không commit mật khẩu Wi-Fi.

### Bước 2 — Build và nạp firmware

```powershell
cd examples/simple_example

# Heltec WiFi LoRa 32 V3
pio run -e heltec_wifi_lora_32_V3 -t upload

# Hoặc Heltec WiFi LoRa 32 V4
pio run -e heltec_wifi_lora_32_V4 -t upload
```

Nếu dùng PlatformIO CLI trên Windows và `pio` không có trong PATH:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -e heltec_wifi_lora_32_V4 -t upload
```

### Bước 3 — Mở dashboard

Cách nhanh nhất khi đang phát triển:

```powershell
cd LoRaMesh_Monitoring/web
python -m http.server 8080
```

Mở `http://localhost:8080`.

Hoặc mở trực tiếp `LoRaMesh_Monitoring/web/index.html` bằng Chrome/Edge.

### Bước 4 — Kết nối broker

Bấm **Connection settings** (biểu tượng bánh răng), nhập:

| Trường | Giá trị mặc định |
|---|---|
| WebSocket URL | `wss://broker.emqx.io:8084/mqtt` |
| Topic prefix | `loramesh` |

Bấm **Save & connect**. Khi node gửi telemetry, dashboard sẽ tự hiện card của node.

> Firmware dùng MQTT TCP port `1883`. Trình duyệt dùng MQTT WebSocket port `8084` (WSS). Đây là hai listener khác nhau của cùng broker, không thay thế nhau.

### Bước 5 — Đưa dashboard lên GitHub Pages

Workflow đã có sẵn:

- Repo chứa toàn bộ dự án: `.github/workflows/deploy-monitor-pages.yml`
- Nếu chỉ push thư mục `LoRaMesh_Monitoring` thành repo riêng: `LoRaMesh_Monitoring/.github/workflows/deploy-pages.yml`

Trên GitHub: **Settings → Pages → Source: GitHub Actions**, sau đó push lên nhánh `main` hoặc `master`. Workflow sẽ deploy thư mục `web/` và xuất URL công khai.

GitHub Pages chạy HTTPS nên bắt buộc dùng `wss://`. URL `ws://` sẽ bị trình duyệt chặn vì mixed content.

---

## 2. Tích hợp tối giản vào sketch

Chỉ cần thêm include và gọi `begin()` một lần trong `setup()`:

```cpp
#include <NodeMonitor.h>

void setup() {
    Serial.begin(115200);

    // Không cần update() trong loop().
    NodeMonitor::getInstance().begin(
        "TEN_WIFI", "MAT_KHAU",
        "broker.emqx.io", 1883);

    // ... phần khởi tạo LoRaMesher hiện có ...
}
```

Cấu hình đầy đủ hơn, ví dụ đổi topic prefix hoặc dùng TLS:

```cpp
#include <NodeMonitor.h>

void setup() {
    nodemonitor::MonitorConfig cfg;
    cfg.wifiSsid      = "TEN_WIFI";
    cfg.wifiPassword  = "MAT_KHAU";
    cfg.mqttHost      = "broker.emqx.io";
    cfg.mqttPort      = 1883;
    cfg.topicPrefix   = "my-mesh";
    cfg.nodeId        = "gateway-01";   // để trống = tự lấy từ MAC
    cfg.metricsIntervalMs = 5000;

    NodeMonitor::getInstance().begin(cfg);
}
```

Các API tương thích cũ vẫn còn: `beginSerialOnly()`, `hookStdout()`, `recordTx()`, `recordRx()`, `logEvent()`, `feedLogLine()`.

Xem thêm: [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

---

## 3. Dashboard có gì?

- **Overview:** số node đang báo telemetry, tổng TX/RX, routes, lỗi link, card từng node.
- **Nodes:** bảng tìm kiếm/sắp xếp, trạng thái monitoring, Wi-Fi RSSI, LoRa RSSI/SNR, số packet, routes.
- **Node detail:** danh tính node, bảng routing, sự kiện gần đây, bộ đếm MQTT/Wi-Fi, heap, uptime.
- **Events:** luồng sự kiện TX/RX, route add/remove, network state, lỗi, monitor; lọc theo node/loại; export JSON.
- **Charts:** lịch sử packet rate, LoRa RSSI/SNR, Wi-Fi RSSI, free heap; lưu trong bộ nhớ tab trình duyệt.
- **Guide:** hướng dẫn kết nối và mô tả topic contract.

Dashboard không có backend, không database, không analytics. Settings nằm trong `localStorage`; lịch sử và events mất khi reload tab.

---

## 4. Kiến trúc dữ liệu

```text
Heltec V3/V4
  ├─ LoRaMesher log stream (PKT_TX, PKT_RX, routes, network)
  ├─ NodeMonitor: parse log → queue → FreeRTOS task
  └─ Wi-Fi + MQTT TCP :1883
             │
             ▼
      MQTT broker (EMQX / Mosquitto / HiveMQ)
             │  WSS :8084 (hoặc :9001 với Mosquitto local)
             ▼
      Static dashboard (GitHub Pages / local)
```

Topic mặc định:

```text
<prefix>/<node_id>/status    → retained, có Last Will
<prefix>/<node_id>/metrics   → mỗi 5 giây
<prefix>/<node_id>/events    → TX/RX, route, network, error
<prefix>/<node_id>/logs      → tùy chọn, khi bật publishRawLogs
```

Chi tiết payload: [`docs/MQTT_PROTOCOL.md`](docs/MQTT_PROTOCOL.md).

---

## 5. Phân biệt lỗi monitoring và lỗi LoRa

| Hiện tượng | Ý nghĩa |
|---|---|
| Dashboard báo **Stale / Telemetry offline** | Không nhận được MQTT trong 45 giây. Có thể do Wi-Fi, broker, mất điện, hoặc node reboot. **Chưa đủ kết luận LoRa lỗi.** |
| Dashboard vẫn **Live** nhưng `tx_errors` tăng | Có telemetry, nhưng tầng LoRa đang báo lỗi gửi. Xem serial + routing table. |
| Dashboard mất node, serial vẫn in log mesh | Nhiều khả năng lỗi Wi-Fi/MQTT/broker. Kiểm tra kết nối mạng của node. |
| Node không lên dashboard nhưng serial báo LoRa OK | Kiểm tra Wi-Fi, MQTT host/port, topic prefix, và broker URL trên web. |

Không có trường RSSI/SNR nào được tạo giả. Nếu radio không báo giá trị, dashboard hiển thị `—`.

---

## 6. Cấu trúc thư mục

```text
LoRaMesh_Monitoring/
├── firmware/NodeMonitor/     # Thư viện PlatformIO/Arduino
│   ├── include/NodeMonitor.h
│   ├── src/NodeMonitor.cpp
│   ├── library.json
│   └── README.md
├── web/                      # Dashboard static
│   ├── index.html
│   ├── assets/css/
│   ├── assets/js/
│   ├── assets/vendor/        # MQTT.js (vendored, không CDN)
│   └── README.md
├── docs/
│   ├── INTEGRATION.md
│   ├── MQTT_PROTOCOL.md
│   └── TROUBLESHOOTING.md
├── broker/                   # Mosquitto local + Docker Compose
├── legacy/                   # Dashboard/server cũ, chỉ lưu tham khảo
└── .github/workflows/        # Deploy GitHub Pages (nếu là repo riêng)
```

Ví dụ tích hợp nằm tại `examples/simple_example/`. `platformio.ini` của ví dụ dùng `lib_extra_dirs = ../../LoRaMesh_Monitoring/firmware`, nên chỉ có **một bản NodeMonitor duy nhất** trong repo.

---

## 7. Kiểm thử và giới hạn

Đã xác nhận:

- Build thành công `heltec_wifi_lora_32_V3`.
- Build thành công `heltec_wifi_lora_32_V4`.
- Dashboard kết nối được broker EMQX qua `wss://` và nhận/parse đúng bản tin MQTT thử nghiệm.
- JavaScript dashboard đã được kiểm tra cú pháp bằng `node --check`.

Chưa xác nhận trong môi trường này:

- Chạy thực tế trên board Heltec V3/V4 với Wi-Fi thật.
- Hành vi của LWT, mất Wi-Fi, reconnect và routing trên phần cứng.
- Sai khác pinout/TCXO/FEM giữa các lô board V3/V4 khác nhau.

Trước khi triển khai thật, hãy test ít nhất 2 board: một node và một gateway, xem serial log + dashboard + bảng routing.

---

## 8. Lưu ý bảo mật

- `broker.emqx.io` là broker công khai, ai cũng có thể subscribe topic. Chỉ dùng cho thử nghiệm.
- Với triển khai thật, dùng broker riêng (Mosquitto/HiveMQ Cloud) có username/password và TLS.
- Đổi `topicPrefix` thành chuỗi riêng, ví dụ `mesh-lab-<random>`.
- Không commit `monitor_config.h` hoặc mật khẩu broker.
- Dashboard lưu credential trong `localStorage` của trình duyệt; dùng máy tin cậy.

---

## 9. Tài liệu

- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — tích hợp firmware, V3/V4, TLS, API.
- [`docs/MQTT_PROTOCOL.md`](docs/MQTT_PROTOCOL.md) — topic, payload, field, LWT.
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — lỗi thường gặp.
- [`firmware/NodeMonitor/README.md`](firmware/NodeMonitor/README.md) — thư viện NodeMonitor.
- [`web/README.md`](web/README.md) — deploy dashboard.
- [`broker/README.md`](broker/README.md) — Mosquitto local.

License: MIT (theo dự án LoRaMesher).
#   l o r a _ m o n i t o r 
 
 