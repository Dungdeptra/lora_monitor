# Troubleshooting

## Quick decision tree

```text
Dashboard has no node card
├─ Serial shows "[NodeMonitor] started ..." ?
│  ├─ no  → begin() not called, library not linked, or board reset loop
│  └─ yes
│     ├─ Serial shows "Wi-Fi connected" ? no → Wi-Fi credentials / signal / router
│     ├─ Serial shows "MQTT connected" ? no → broker host/port, firewall, DNS
│     └─ yes
│        ├─ Same topic prefix as dashboard? no → change one side
│        ├─ Dashboard connected to broker? no → WSS URL / mixed content
│        └─ yes → publish a test status and watch the browser console
└─ Card exists but is stale
   ├─ Was the node recently power-cycled? → wait for boot + reconnect
   ├─ Wi-Fi/MQTT down? → monitoring problem, not necessarily LoRa
   └─ Serial still prints mesh traffic? → LoRa may be fine; inspect monitoring link
```

## Build and upload

### `undefined reference` or duplicate NodeMonitor symbols

There must be exactly one copy of the library. The example uses:

```ini
lib_extra_dirs =
    ../../LoRaMesh_Monitoring/firmware
```

Remove any old `NodeMonitor.cpp` / `NodeMonitor.h` from the sketch `src/`
folder if `lib_extra_dirs` points at the library. Old copies were moved into
`LoRaMesh_Monitoring/legacy/` for reference.

### Heltec V4 compiles but V3 does not (or the reverse)

Check the environment and dependencies:

```powershell
pio run -e heltec_wifi_lora_32_V3
pio run -e heltec_wifi_lora_32_V4
```

Both environments need `PubSubClient` and `ArduinoJson`:

```ini
lib_deps =
    knolleary/PubSubClient@^2.8
    bblanchon/ArduinoJson@^7.0.4
```

The V4 environment also needs:

```ini
board_build.variants_dir = variants
board_build.variant = heltec_V4
```

The build was verified for both environments in this repository with
PlatformIO Espressif32 6.11.0 and Arduino core 3.20017.

### `monitor_config.h: No such file or directory`

```powershell
cd examples/simple_example/src
Copy-Item monitor_config.example.h monitor_config.h
```

Edit the new file. It is intentionally gitignored.

## Firmware does not connect

### Wi-Fi never connects

- ESP32-S3 supports 2.4 GHz only. A 5 GHz-only SSID will not work.
- Check the serial for `[NodeMonitor] Wi-Fi lost (status=...)`.
- `WL_NO_SSID_AVAIL` usually means a wrong SSID or 5 GHz network.
- The monitor retries with exponential backoff; a router reboot is recovered
  automatically.
- `WiFi.setSleep(false)` is enabled by the monitor for stable MQTT sessions.

### `MQTT connect failed`

The serial prints the PubSubClient state code every fifth failure:

```text
[NodeMonitor] MQTT connect failed (host=broker.emqx.io:1883 state=-2), will retry
```

Common causes:

- Broker host/port wrong. TCP MQTT is normally `1883`; TLS is `8883`.
- Port 1883 blocked by the network/firewall. Try a phone hotspot.
- Broker requires credentials; fill `MONITOR_MQTT_USER` and
  `MONITOR_MQTT_PASSWORD`.
- Broker is down or DNS fails. Test from a PC:
  `Test-NetConnection broker.emqx.io -Port 1883`.
- Client ID conflict is unlikely because NodeMonitor derives
  `nodemon-XXXXXX` from the MAC, but clone boards can share a MAC.

The monitor uses a retained Last Will. If the node disappears without a clean
disconnect, the broker publishes the offline payload after keepalive expiry.
This is expected.

### TLS fails or the board reboots

- TLS needs heap for the handshake. Check `free_heap`/`min_free_heap`.
- Use `tlsInsecure = true` only to isolate a certificate problem, never in
  production.
- A wrong root CA causes a verification failure. Use the broker's PEM root CA.
- Some public brokers do not expose port 8883 at all.

## Dashboard does not show nodes

### Browser stays on "Connecting…" or "Reconnecting…"

- Open DevTools → Console/Network and look for WebSocket errors.
- `wss://broker.emqx.io:8084/mqtt` is a WebSocket listener. Port `1883` is not.
- A local Mosquitto must have a WebSocket listener (see `broker/`).
- On GitHub Pages (HTTPS), `ws://` is blocked. Use `wss://`.
- Corporate networks/proxies may block WebSocket or non-443 ports. Try a phone
  hotspot; use a broker on port 443 if needed.
- Public brokers can rate-limit or be temporarily unavailable.

### Browser connects but no nodes appear

1. Confirm the firmware prints `[NodeMonitor] MQTT connected: ...`.
2. Compare the **exact** topic prefix in firmware and dashboard.
3. In the browser console run:

```js
LoRaMonitor.app.store.settings
LoRaMonitor.app.bridge.client.subscribe('loramesh/+/status')
```

4. Publish a manual status message from any MQTT client to
   `<prefix>/NODE_TEST/status` and watch the dashboard.
5. If you see other people's nodes, your prefix is too common. Choose a unique
   prefix such as `mesh-lab-7f3a`.
6. Remember: `status` is retained, but `metrics` only arrives every few seconds.

### Nodes appear for a moment, then disappear

- This is the Last Will firing. The MQTT connection dropped, the board lost
  power, or Wi-Fi failed.
- A `status` payload with `online: false` marks only the monitoring link
  offline. Check the serial console before diagnosing a LoRa fault.
- Dashboard heartbeat timeout is 45 seconds. A metrics interval of 5 seconds
  normally leaves plenty of margin.

### Node is stale but the serial shows LoRa traffic

That is expected during a Wi-Fi/MQTT outage. LoRa mesh traffic and MQTT
telemetry are independent paths. The dashboard cannot observe LoRa directly;
it only sees what the node published.

## RSSI and SNR

### RSSI/SNR show “—”

- No `PKT_RX ... rssi=... snr=...` line has been parsed yet. A node that only
  transmits will not have a receive signal.
- Your RadioLib/LoRaMesher version may emit a different RX log format. The
  monitor parses the format shown in `MQTT_PROTOCOL.md`.
- Values are intentionally `null` rather than a synthetic `-80` or `5`.
- The physical radio may report unusual values; the monitor accepts RSSI in
  `(-200, 50)` dBm and SNR in `(-50, 50)` dB.

### RSSI appears frozen

Metrics carry the **last real** measurement, not a new one every 5 seconds.
RSSI only changes when a new packet is received. Use the Events view to see
per-packet RSSI/SNR.

## Charts and history

- History is stored in browser memory only. Reloading the tab clears it.
- A newly opened dashboard has no past samples. Keep it open to build history.
- After a node reboot (`boot_id` changes), that node's history is reset.
- Charts derive packet rate from counter deltas. If a counter goes backwards
  after a reboot, the delta is skipped instead of drawing a negative spike.
- Browser time is used for chart timestamps; device uptime is separate.

## GitHub Pages

### 404 or blank page

- The Pages workflow must deploy the `web/` folder as the artifact root, not
  the repository root.
- Set **Settings → Pages → Source: GitHub Actions**.
- Check the Actions log. The root workflow path is
  `.github/workflows/deploy-monitor-pages.yml`; if `LoRaMesh_Monitoring` is its
  own repository, use `LoRaMesh_Monitoring/.github/workflows/deploy-pages.yml`.
- File names are case-sensitive on the Linux runner: `index.html`,
  `assets/css/dashboard.css`, and `assets/js/app.js` must match exactly.
- If the site is served from a project subpath, all asset references are
  relative, so no base path configuration is needed.

### Page loads but MQTT.js is missing

Confirm `web/assets/vendor/mqtt.min.js` was committed. It is vendored
intentionally, so the dashboard works without a CDN or internet CDN access.
The license is in `web/assets/vendor/mqtt.LICENSE.md`.

## UI behavior

- **Stale** is not a LoRa failure verdict. It means no MQTT telemetry arrived
  within 45 seconds.
- **Wi-Fi down** comes from the last metrics sample. It does not prove the LoRa
  radio is down.
- **Pause** freezes the visible event list; new events are still stored and
  appear when you unpause.
- **Clear** deletes events in this tab only. It does not affect the node or
  broker.
- **Export** downloads a JSON snapshot of nodes, history and events.
- Settings and theme use `localStorage`. Private browsing may block storage;
  the dashboard still runs but will not remember settings.

## Hardware test checklist

1. Flash one board with a unique `MONITOR_TOPIC_PREFIX`.
2. Open the serial monitor at 115200 and confirm:
   - `[NodeMonitor] started id=... board=...`
   - `Wi-Fi connected: ...`
   - `MQTT connected: ...`
3. Open the dashboard with the same prefix and WSS URL.
4. Confirm a node card appears within `metricsIntervalMs` (5 s).
5. Send a mesh message from another node and confirm `rx` events and real
   RSSI/SNR.
6. Disconnect Wi-Fi on the node. Dashboard should mark it stale after 45 s.
   Reconnect Wi-Fi; node should reappear.
7. Power-cycle the node. Dashboard should show a new boot and reset history.
8. Repeat with V3 and V4 boards to confirm the FEM/TCXO configuration.

If a step fails, check the serial log first. The dashboard cannot tell you
anything the node did not publish.
