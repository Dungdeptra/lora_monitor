# Local MQTT broker

This folder runs a local [Eclipse Mosquitto](https://mosquitto.org/) broker for
development. It exposes two listeners:

| Listener | Protocol | Used by |
|---|---|---|
| `1883` | MQTT over TCP | Heltec firmware (`MONITOR_MQTT_PORT 1883`) |
| `9001` | MQTT over WebSocket | The static dashboard (`ws://localhost:9001`) |

TLS is not enabled here. That is acceptable on a trusted LAN and when the
dashboard is served over plain HTTP. A GitHub Pages dashboard is HTTPS and must
connect with `wss://`, so it needs a TLS reverse proxy in front of Mosquitto.
See [TLS and GitHub Pages](#tls-and-github-pages).

## Quick start with Docker

Requirements: Docker Desktop or Docker Engine with Compose v2.

```powershell
cd LoRaMesh_Monitoring/broker
docker compose up -d
```

Check the logs:

```powershell
docker compose logs -f mosquitto
```

Test the TCP listener from the host:

```powershell
Test-NetConnection localhost -Port 1883
```

The result should show `TcpTestSucceeded : True`. To publish a test message,
use any MQTT client (MQTTX, MQTT Explorer, or `mosquitto_pub` if installed):

```powershell
mosquitto_pub -h localhost -p 1883 -t loramesh/TEST/status `
  -m '{"schema":1,"node_id":"TEST","online":true}'
```

Or configure a client with:

```text
host: localhost
port: 1883
```

The WebSocket listener is used by the dashboard:

```text
ws://localhost:9001
```

Open `web/index.html` through a local HTTP server (not GitHub Pages) and set
that URL in **Connection settings**.

Stop the broker:

```powershell
docker compose down
```

Data is kept in the `mosquitto-data` named volume. Use
`docker compose down -v` only when you intentionally want to delete retained
messages and broker state.

## Firmware configuration

The node must reach the broker over the LAN. `localhost` inside the firmware
means the ESP32 itself, not your PC.

1. Find the PC/host LAN address:

   ```powershell
   ipconfig
   ```

2. Set `monitor_config.h`:

   ```cpp
   #define MONITOR_MQTT_HOST   "192.168.1.50"
   #define MONITOR_MQTT_PORT   1883
   ```

3. Allow inbound TCP `1883` in the host firewall if needed.

Both devices must be on the same network (or routed/VPN). Guest Wi-Fi with
client isolation will block ESP32-to-PC traffic.

## TLS and GitHub Pages

A page served from GitHub Pages is HTTPS. The browser will block
`ws://192.168.1.50:9001` as mixed content. Options:

1. **Use a cloud broker with WSS.** Easiest for a quick test, for example
   `wss://broker.emqx.io:8084/mqtt`.
2. **Put Mosquitto behind a TLS reverse proxy.** Terminate HTTPS/WSS on port
   443 and forward WebSocket traffic to `mosquitto:9001`.

Example Caddy configuration on the same Docker network:

```caddyfile
monitor.example.com {
    reverse_proxy mosquitto:9001
}
```

Caddy obtains a public certificate automatically. The dashboard URL is then:

```text
wss://monitor.example.com/
```

Firmware can keep using plain TCP `1883` on the LAN, or connect to a TLS MQTT
listener on `8883` if you configure one. Do not expose unauthenticated
Mosquitto directly to the internet.

## Authentication

The supplied `mosquitto.conf` allows anonymous connections. That is convenient
for a lab but unsafe outside a trusted network.

To require a username and password:

1. Create a password file:

   ```powershell
   docker run --rm -it -v "${PWD}:/work" eclipse-mosquitto:2 `
     mosquitto_passwd -c -b /work/passwd monitor "CHANGE_ME"
   ```

2. Edit `mosquitto.conf`. Put these two lines **before the first `listener`**
   line so they apply globally to both listeners:

   ```conf
   allow_anonymous false
   password_file /mosquitto/config/passwd
   ```

   With the default `per_listener_settings false`, authentication settings are
   global. Remove the per-listener `allow_anonymous true` lines when you enable
   authentication.

3. Add the file to `docker-compose.yml`:

   ```yaml
       volumes:
         - ./mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
         - ./passwd:/mosquitto/config/passwd:ro
         - mosquitto-data:/mosquitto/data
   ```

4. Restart:

   ```powershell
   docker compose up -d --force-recreate
   ```

5. Enter the same credentials in the firmware (`MONITOR_MQTT_USER`,
   `MONITOR_MQTT_PASSWORD`) and in the dashboard settings.

`passwd` contains password hashes and must not be committed. For anything
beyond a lab, also add an ACL so one node cannot subscribe to every topic.

## Files

```text
broker/
├── docker-compose.yml
├── mosquitto.conf
└── README.md
```

## Troubleshooting

- **`address already in use`** — another Mosquitto or MQTT service is using
  `1883` or `9001`. Stop it or change the host-side port mapping.
- **Dashboard cannot connect to `ws://localhost:9001`** — make sure the page is
  served over HTTP, not HTTPS, and that the container is running. Test with
  `docker compose ps` and `docker compose logs mosquitto`.
- **Firmware cannot connect** — use the host's LAN IP, not `localhost`; check
  the firewall; confirm both devices are on the same subnet.
- **Retained offline status after removing a node** — delete the retained
  message with `mosquitto_pub -r -n -t '<prefix>/<node_id>/status'` or clear the
  volume.
