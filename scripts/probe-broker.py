import os
import sys
import time

import paho.mqtt.client as mqtt

# Probe a MeshCore MQTT broker over WebSockets/TLS before wiring it into
# meshcore-health-check. Verifies CONNACK (auth) and SUBACK (read ACL), then
# reports which topic roots and IATA region segments actually carry traffic.
#
#   pip install paho-mqtt websocket-client
#   python3 probe-broker.py                        # anonymous
#   python3 probe-broker.py <user> <pass> 120      # with credentials
#
# Env overrides: BROKER_HOST, BROKER_PORT, BROKER_WS_PATH
HOST = os.environ.get("BROKER_HOST", "mqtt.gomesh.dev")
PORT = int(os.environ.get("BROKER_PORT", "443"))
PATH = os.environ.get("BROKER_WS_PATH", "/mqtt")
USER = sys.argv[1] if len(sys.argv) > 1 else None
PASS = sys.argv[2] if len(sys.argv) > 2 else None
DURATION = int(sys.argv[3]) if len(sys.argv) > 3 else 75

ROOTS = ["#", "meshcore/#", "MESHCORE/#", "msh/#", "gomesh/#", "$SYS/#", "packets/#", "mc/#"]
mids = {}
counts = {}
seen = {}


def on_connect(c, u, f, rc, props=None):
    code = rc.value if hasattr(rc, "value") else rc
    print("CONNACK rc =", code)
    if code != 0:
        return
    for t in ROOTS:
        r = c.subscribe(t, qos=0)
        mids[r[1]] = t


def on_subscribe(c, u, mid, granted, props=None):
    codes = [g.value if hasattr(g, "value") else g for g in granted] if granted else []
    t = mids.get(mid, "?")
    ok = codes and all(x < 128 for x in codes)
    print(f"SUBACK {t:14} granted={codes} {'OK' if ok else 'DENIED'}")


def on_message(c, u, msg):
    root = msg.topic.split("/")[0]
    counts[root] = counts.get(root, 0) + 1
    seg = msg.topic.split("/")
    if len(seg) > 1:
        seen[seg[1]] = seen.get(seg[1], 0) + 1
    if sum(counts.values()) <= 8:
        print(f"MSG {msg.topic} ({len(msg.payload)}B) {msg.payload[:40]!r}")


try:
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, transport="websockets")
except AttributeError:
    c = mqtt.Client(transport="websockets")
c.ws_set_options(path=PATH)
c.tls_set()
if USER:
    c.username_pw_set(USER, PASS)
c.on_connect, c.on_subscribe, c.on_message = on_connect, on_subscribe, on_message
print(f"connecting wss://{HOST}:{PORT}{PATH} as {USER or '(anonymous)'}")
c.connect(HOST, PORT, keepalive=30)
c.loop_start()
time.sleep(DURATION)
c.loop_stop()
print("\ntotal messages:", sum(counts.values()))
print("by root:", counts)
print("by 2nd segment:", dict(sorted(seen.items(), key=lambda kv: -kv[1])))

if not counts:
    print("\nNo traffic. If every SUBACK said DENIED (0x80) the broker is up but")
    print("your account has no read ACL — ask the operator for subscriber credentials.")
