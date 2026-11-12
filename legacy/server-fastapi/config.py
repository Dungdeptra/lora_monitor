import os

MQTT_BROKER_HOST = os.getenv("MQTT_BROKER_HOST", "127.0.0.1")
MQTT_BROKER_PORT = int(os.getenv("MQTT_BROKER_PORT", "1883"))
MQTT_TOPIC_SUB   = "loramesh/#"
WEB_HOST         = "0.0.0.0"
WEB_PORT         = 8000
