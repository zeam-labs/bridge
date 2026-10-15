import json
import os
import re
import signal
import socket
import sys
import time
from socketserver import ThreadingMixIn
from wsgiref.simple_server import ServerHandler, WSGIRequestHandler, WSGIServer, make_server

from zeam_bridge import Bridge, setting, units
from zeam_bridge.engine import DEFAULT_CREDITS, DEFAULT_RELAY, DEFAULT_RPC

env = os.environ
metered = setting("BRIDGE_METERED") == "1"
prices = dict(kv.split("=", 1) for kv in re.split(r"[\s,]+", setting("BRIDGE_PRICES") or "") if "=" in kv)
agents = Bridge(name=setting("BRIDGE_NAME"), payout=setting("BRIDGE_PAYOUT"), mode=setting("BRIDGE_MODE") or "both", price=setting("BRIDGE_PRICE") or "0.01",
              admit=[a for a in re.split(r"[\s,]+", setting("BRIDGE_ADMIT") or "") if a],
              relay=setting("BRIDGE_RELAY") or DEFAULT_RELAY, credits=setting("BRIDGE_CREDITS") or DEFAULT_CREDITS,
              rpc=setting("BRIDGE_RPC") or DEFAULT_RPC, site=setting("BRIDGE_SITE"),
              state_dir=setting("BRIDGE_STATE_DIR"), contact=setting("BRIDGE_CONTACT"), server_name="ZEAM Bridge reference seller (Python)",
              prices=prices or None, free_limit=int(setting("BRIDGE_FREE_LIMIT")) if setting("BRIDGE_FREE_LIMIT") else None,
              time={"usd": setting("BRIDGE_TIME_BLOCK"), "ms": int(setting("BRIDGE_TIME_BLOCK_MS") or 250), "maxCalls": int(setting("BRIDGE_TIME_MAX_CALLS") or 3)} if metered and setting("BRIDGE_TIME_BLOCK") else None)


@agents.tool(description="Multiplies two numbers.", input_schema={"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]})
def multiply(a, b):
    return {"product": a * b}


@agents.tool(description="Counts the words in a text.", input_schema={"type": "object", "properties": {"text": {"type": "string", "maxLength": 10000}}, "required": ["text"]})
def word_count(text):
    return {"words": len(text.split())}


@agents.tool(price="0.02", description="Divides a by b. Fails when b is 0.", input_schema={"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]})
def divide(a, b):
    return {"quotient": a / b}


if metered:
    @agents.tool(name="ping", free=True, description="Free. Answers pong and the time.")
    def ping(**_):
        return {"pong": True, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    @agents.tool(name="words", price="0.05", unit="0.0001", description="Counts the words in a text: $0.0001 per word, at most $0.05 a call.",
                 input_schema={"type": "object", "properties": {"text": {"type": "string", "maxLength": 20000}}, "required": ["text"]})
    def words(text):
        n = len(text.split())
        units(n)
        return {"words": n}

    if setting("BRIDGE_TIME_BLOCK"):
        @agents.tool(name="wait", meter="time", description="Waits ms milliseconds, then answers. Line time.",
                     input_schema={"type": "object", "properties": {"ms": {"type": "integer", "minimum": 0, "maximum": 9000}}, "required": ["ms"]})
        def wait(ms):
            time.sleep(ms / 1000)
            return {"waited": ms}


paid = agents.wsgi()
gated = None
if setting("BRIDGE_GATE_NAME"):
    gated = Bridge(name=setting("BRIDGE_GATE_NAME"), payout=setting("BRIDGE_PAYOUT"), mode="gate",
                 admit=[a for a in re.split(r"[\s,]+", setting("BRIDGE_ADMIT") or "") if a],
                 credits=setting("BRIDGE_CREDITS") or DEFAULT_CREDITS, rpc=setting("BRIDGE_RPC") or DEFAULT_RPC, site=setting("BRIDGE_SITE"),
                 state_dir=os.path.join(setting("BRIDGE_STATE_DIR"), "gate") if setting("BRIDGE_STATE_DIR") else None,
                 contact=setting("BRIDGE_CONTACT"), server_name="ZEAM Bridge reference gate (Python)")

    @gated.tool(name="multiply", description="Multiplies two numbers.", input_schema={"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]})
    def gated_multiply(a, b):
        return {"product": a * b}

    gate = gated.wsgi()


def app(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    if path == "/health" and environ.get("REQUEST_METHOD") == "GET":
        start_response("200 OK", [("content-type", "application/json")])
        return [json.dumps({"ok": True, "name": setting("BRIDGE_NAME"), "mode": setting("BRIDGE_MODE") or "both", "engine": "python", "gate": setting("BRIDGE_GATE_NAME")}, separators=(",", ":"), ensure_ascii=False).encode()]
    if path == "/agents" or path.startswith("/agents/"):
        environ["SCRIPT_NAME"], environ["PATH_INFO"] = "/agents", path[len("/agents"):] or "/"
        return paid(environ, start_response)
    if gated is not None and (path == "/gate" or path.startswith("/gate/")):
        environ["SCRIPT_NAME"], environ["PATH_INFO"] = "/gate", path[len("/gate"):] or "/"
        return gate(environ, start_response)
    start_response("404 Not Found", [("content-type", "text/plain")])
    return [b"ZEAM Bridge reference seller: the tools are at /agents/mcp and /agents/v1/<tool>\n"]


class Quiet(WSGIRequestHandler):
    server_version = "zeam-bridge"
    sys_version = ""

    def log_message(self, *a):
        pass


ServerHandler.server_software = None


class Threaded(ThreadingMixIn, WSGIServer):
    daemon_threads = True
    request_queue_size = socket.SOMAXCONN


server = make_server(env.get("HOST", "0.0.0.0"), int(env.get("PORT", "8080")), app, server_class=Threaded, handler_class=Quiet)
signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
print(f"{agents.name} on {env.get('HOST', '0.0.0.0')}:{env.get('PORT', '8080')}", flush=True)
try:
    server.serve_forever()
except (KeyboardInterrupt, SystemExit):
    sys.exit(0)
