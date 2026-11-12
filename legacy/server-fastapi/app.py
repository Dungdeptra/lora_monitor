import asyncio
import json
import time
from pathlib import Path
from typing import Dict, Any, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
import paho.mqtt.client as mqtt
import config

app = FastAPI(title="LoRaMesher Live Monitoring & Log Analyzer Server")

WEB_DIR = Path(__file__).parent / "web"
INDEX_FILE = WEB_DIR / "index.html"

nodes_cache: Dict[str, Dict[str, Any]] = {}
ws_clients: Set[WebSocket] = set()
main_loop: asyncio.AbstractEventLoop = None


async def broadcast_ws(message: Dict[str, Any]):
    dead = []
    text = json.dumps(message)
    for ws in list(ws_clients):
        try:
            await ws.send_text(text)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)


def on_mqtt_connect(client, userdata, flags, reason_code, properties=None):
    print(f"[MQTT] Connected to {config.MQTT_BROKER_HOST}:{config.MQTT_BROKER_PORT} (rc={reason_code})")
    client.subscribe(config.MQTT_TOPIC_SUB)


def on_mqtt_message(client, userdata, msg):
    topic = msg.topic
    raw_str = msg.payload.decode("utf-8", errors="ignore").strip()
    parts = topic.split("/")
    node_id = parts[1] if len(parts) >= 2 else "UNKNOWN"

    payload_obj = None
    try:
        payload_obj = json.loads(raw_str)
    except Exception:
        pass

    if isinstance(payload_obj, dict):
        payload_obj.setdefault("node_id", node_id)
        payload_obj["_server_ts"] = int(time.time() * 1000)
        curr = nodes_cache.get(node_id, {})
        curr.update(payload_obj)
        nodes_cache[node_id] = curr

    ws_packet = {
        "type": "mqtt_message",
        "topic": topic,
        "node_id": node_id,
        "payload": payload_obj,
        "raw": raw_str,
        "timestamp": int(time.time() * 1000),
    }
    if main_loop and main_loop.is_running():
        asyncio.run_coroutine_threadsafe(broadcast_ws(ws_packet), main_loop)


mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
mqtt_client.on_connect = on_mqtt_connect
mqtt_client.on_message = on_mqtt_message


@app.on_event("startup")
async def startup_event():
    global main_loop
    main_loop = asyncio.get_running_loop()
    try:
        mqtt_client.connect_async(config.MQTT_BROKER_HOST, config.MQTT_BROKER_PORT, 60)
        mqtt_client.loop_start()
        print("[SERVER] Started MQTT background loop.")
    except Exception as e:
        print(f"[SERVER] Warning: Could not connect to MQTT broker yet: {e}")


@app.on_event("shutdown")
async def shutdown_event():
    try:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()
    except Exception:
        pass


@app.get("/")
async def serve_index():
    return FileResponse(INDEX_FILE)


@app.get("/api/nodes")
async def get_nodes():
    return JSONResponse({"nodes": list(nodes_cache.values())})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    ws_clients.add(websocket)
    try:
        await websocket.send_text(json.dumps({
            "type": "snapshot",
            "nodes": list(nodes_cache.values())
        }))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_clients.discard(websocket)
    except Exception:
        ws_clients.discard(websocket)
