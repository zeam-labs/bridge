import json
import re
import urllib.error
import urllib.request

from .core import Address, Hex, Num


class RpcError(RuntimeError):
    def __init__(self, message, rpc_code=None, rpc_data=None):
        super().__init__(message)
        self.rpc_code = rpc_code
        self.rpc_data = rpc_data


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)
USER_AGENT = "zeam-bridge"


def post_json(url, body, timeout, headers=None, method="POST"):
    data = None if body is None else (body if isinstance(body, bytes) else body.encode())
    hdrs = {"accept": "application/json", "user-agent": USER_AGENT, **({"content-type": "application/json"} if data else {}), **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read()


class Rpc:
    def __init__(self, url, timeout=10, connect_timeout=5):
        if not re.match(r"^https?://", str(url), re.I):
            raise ValueError("an RPC URL starts with http:// or https://")
        self.url = url
        self.timeout = float(timeout)
        self.connect_timeout = float(connect_timeout)
        self._id = 0

    def call(self, method, params=()):
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": list(params)})
        try:
            status, _, raw = post_json(self.url, body, self.timeout)
        except Exception as e:
            raise RpcError(f"RPC request failed: {e}")
        if status < 200 or status >= 300:
            raise RpcError(f"RPC answered HTTP {status}")
        try:
            reply = json.loads(raw)
        except ValueError:
            reply = None
        if not isinstance(reply, dict):
            raise RpcError(f"{method}: the RPC answered with something that is not JSON")
        if reply.get("error") is not None:
            e = reply["error"] if isinstance(reply["error"], dict) else {}
            raise RpcError(f"{method}: " + str(e.get("message") or "RPC error"), e.get("code"), e.get("data"))
        if "result" not in reply:
            raise RpcError(f"{method}: the RPC answer has no result")
        return reply["result"]

    def chain_id(self):
        return int(Num.dec(self.call("eth_chainId")))

    def eth_call(self, to, data, block="latest", sender=None):
        tx = {"to": Address.checksum(to), "data": Hex.lower(data)}
        if sender is not None:
            tx["from"] = Address.checksum(sender)
        return self.call("eth_call", [tx, block])
