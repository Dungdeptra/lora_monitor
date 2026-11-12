# LoRaMesh Monitor web dashboard

A 100% static dashboard for LoRaMesher nodes. It connects directly to an MQTT
broker over WebSocket, so there is no backend, database, build step, or Python
server to deploy.

## What it shows

- **Overview** — nodes reporting, LoRa TX/RX totals, routes, link errors, and
  one card per node.
- **Nodes** — searchable/sortable table with monitoring state, Wi-Fi RSSI, real
  LoRa RSSI/SNR, packet counters, and route counts.
- **Node detail** — identity, routing table, recent events, MQTT/Wi-Fi counters,
  heap, and uptime.
- **Events** — TX/RX, route add/remove, network state, monitor lifecycle, and
  errors; filter by node/type, pause, clear, export JSON.
- **Charts** — packet rate, LoRa RSSI/SNR, Wi-Fi RSSI, and free heap history.
- **Guide** — connection instructions and the topic contract.

The dashboard only displays values published by the firmware. RSSI/SNR are
never generated in the browser; when a real measurement is unavailable the UI
shows `—`.

> **Monitoring versus LoRa failure:** the dashboard observes MQTT only. A stale
> node means telemetry stopped arriving. The LoRa mesh may still be running.
> The dashboard never declares a LoRa failure from a Wi-Fi/MQTT outage.

## Files

```text
web/
├── index.html
├── assets/
│   ├── css/dashboard.css
│   ├── js/
│   │   ├── config.js       settings, validation, formatting
│   │   ├── store.js        payload ingestion and state
│   │   ├── charts.js       canvas charts (no chart library)
│   │   ├── mqtt-client.js  MQTT.js wrapper and reconnect
│   │   ├── ui.js           rendering and interactions
│   │   └── app.js          bootstrap
│   └── vendor/
│       ├── mqtt.min.js     vendored MQTT.js
│       └── mqtt.LICENSE.md
└── README.md
```

All asset references are relative, so the dashboard works at a domain root or
under a GitHub Pages project subpath without configuration.

## Run locally

From this folder:

```powershell
python -m http.server 8080
```

Open <http://localhost:8080>. Any static file server works. Opening
`index.html` directly with Chrome/Edge also works, but a local HTTP server is
closer to the deployed environment and avoids browser restrictions on
`file://` pages.

## Connect to a broker

Click **Connection settings** (gear icon) and enter:

| Field | Example | Notes |
|---|---|---|
| WebSocket URL | `wss://broker.emqx.io:8084/mqtt` | Must be MQTT-over-WebSocket, not plain MQTT. |
| Topic prefix | `loramesh` | Must match the firmware exactly. |
| Username | empty | Optional. |
| Password | empty | Optional. |
| Subscribe to raw logs | off | Enables the optional `<prefix>/+/logs` topic. |

Then click **Save & connect**.

Common endpoints:

- EMQX public: `wss://broker.emqx.io:8084/mqtt`
- HiveMQ public: `wss://broker.hivemq.com:8884/mqtt`
- Local Mosquitto: `ws://localhost:9001` (see [`../broker/`](../broker/))

GitHub Pages is served over HTTPS. Browsers block plain `ws://` there as mixed
content, so a deployed dashboard must use `wss://`. Use a TLS reverse proxy in
front of a local Mosquitto if you need a private broker on Pages.

## URL query parameters

Settings can be supplied for a single page load:

```text
https://example.github.io/loramesh-monitor/?broker=wss%3A%2F%2Fbroker.emqx.io%3A8084%2Fmqtt&prefix=mesh-lab-7f3a
```

| Parameter | Example | Effect |
|---|---|---|
| `broker` | `wss://broker.emqx.io:8084/mqtt` | Overrides the stored WebSocket URL. |
| `prefix` | `mesh-lab-7f3a` | Overrides the stored topic prefix. |
| `logs` | `1` | Subscribes to raw logs for this load. |

Query parameters are not written to `localStorage`; only **Save & connect**
persists settings. This is useful for sharing a read-only dashboard link
without changing the recipient's saved configuration.

## Deploy to GitHub Pages

Two workflows are provided so either repository layout works:

- Whole LoRaMesher repository: the root workflow at
  `.github/workflows/deploy-monitor-pages.yml` deploys
  `LoRaMesh_Monitoring/web`.
- `LoRaMesh_Monitoring` as its own repository:
  [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml)
  deploys `web`.

Steps:

1. Push to the `main` or `master` branch.
2. On GitHub open **Settings → Pages**.
3. Set **Source** to **GitHub Actions**.
4. Run the workflow or push a change under `web/`.
5. Open the URL printed by the `deploy` job.

The workflow uploads only the `web/` folder, so the firmware source is not
published. `mqtt.min.js` is vendored intentionally; the dashboard does not
depend on a CDN.

## History and persistence

- Settings and theme are stored in browser `localStorage`.
- Node history and events live in memory and are capped (900 history samples,
  800 events, 220 events per node, 140 raw log lines per node).
- Reloading or closing the tab clears history. A newly opened dashboard starts
  with no past samples; keep it open to build charts.
- `status` is retained by the broker, so current online/offline state can appear
  immediately after opening the page.
- When a node reboots (`boot_id` changes), its history is reset.

There is no server-side storage, analytics, or account system.

## Browser support

Current Chrome, Edge, Firefox, and Safari. The dashboard uses WebSocket,
`URLSearchParams`, `localStorage`, and canvas. MQTT.js supports MQTT 3.1.1 over
WebSocket.

If the broker is unreachable, the header shows **Reconnecting…** and the
dashboard keeps retrying with backoff. This is a browser-to-broker problem, not
a LoRa verdict.

## Security notes

- Public brokers such as `broker.emqx.io` are shared. Anyone can subscribe to
  your topics. Use a unique prefix for tests and a private broker for real data.
- Broker credentials are stored in `localStorage` in plain text. Do not use the
  dashboard on an untrusted machine.
- There is no authentication layer in the static page. Protect the broker, not
  the HTML.
- Use TLS (`wss://`) for any non-test deployment.

See [`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md) for connection
diagnostics and [`../docs/MQTT_PROTOCOL.md`](../docs/MQTT_PROTOCOL.md) for the
payload contract.
