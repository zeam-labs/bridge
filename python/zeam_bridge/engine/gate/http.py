import re

from ..rpc import post_json


class Http:
    def __init__(self, timeout=20):
        self.timeout = float(timeout)

    def __call__(self, method, url, headers=None, body=None):
        if not re.match(r"^https?://", str(url), re.I):
            raise ValueError("a URL starts with http:// or https://")
        try:
            status, got, raw = post_json(url, b"" if body is None else body, self.timeout, headers=headers or {}, method=method.upper())
        except Exception as e:
            raise RuntimeError(f"request failed: {e}")
        return {"status": status, "headers": got, "body": raw.decode("utf-8", "replace")}
