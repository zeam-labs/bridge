import os
import socket
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from zeam_bridge import Bridge, setting

agents = Bridge(name=setting("BRIDGE_NAME"), payout=setting("BRIDGE_PAYOUT"), price=setting("BRIDGE_PRICE") or "0.001",
              site=setting("BRIDGE_SITE"), state_dir=setting("BRIDGE_STATE_DIR"), server_name="Py Acme")


@agents.tool(description="Multiplies two numbers.", input_schema={"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]})
def multiply(a, b):
    return {"product": a * b}


def site(environ, start_response):
    start_response("200 OK", [("content-type", "text/plain")])
    return [b"the site's own page"]


paid = agents.wsgi()


def app(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    if path.startswith("/agents"):
        environ["SCRIPT_NAME"], environ["PATH_INFO"] = "/agents", path[len("/agents"):] or "/"
        return paid(environ, start_response)
    return site(environ, start_response)


class Quiet(WSGIRequestHandler):
    def log_message(self, *a):
        pass


class Threaded(ThreadingMixIn, WSGIServer):
    daemon_threads = True
    request_queue_size = socket.SOMAXCONN


make_server("127.0.0.1", int(os.environ.get("PORT", "18630")), app, server_class=Threaded, handler_class=Quiet).serve_forever()
