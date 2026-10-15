import base64
import binascii
import json
import re

_ALPHABET = re.compile(r"[^A-Za-z0-9+/]")


class Json:
    @staticmethod
    def encode(value):
        try:
            out = json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as e:
            raise RuntimeError(f"not encodable as JSON: {e}")
        return out.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

    @staticmethod
    def base64(value):
        return base64.b64encode(Json.encode(value).encode()).decode()

    @staticmethod
    def lenient_b64decode(text):
        body = _ALPHABET.sub("", text)
        if len(body) % 4 == 1:
            body = body[:-1]
        try:
            return base64.b64decode(body + "=" * (-len(body) % 4))
        except (binascii.Error, ValueError):
            return b""

    @staticmethod
    def decode_header(value):
        if not isinstance(value, str) or value.strip() == "":
            return None
        raw = Json.lenient_b64decode(value.strip())
        if not raw:
            return None
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return decoded if isinstance(decoded, (dict, list)) else None

    @staticmethod
    def normalize(value):
        if isinstance(value, list):
            return [Json.normalize(v) for v in value]
        if isinstance(value, dict):
            if not value:
                return []
            return {k: Json.normalize(value[k]) for k in sorted(value, key=str)}
        return value

    @staticmethod
    def deep_equal(a, b):
        return Json.encode(Json.normalize(a)) == Json.encode(Json.normalize(b))

    @staticmethod
    def contains_subset(expected, actual):
        if not isinstance(expected, dict) or not expected:
            return Json.deep_equal(expected, actual)
        if not isinstance(actual, (dict, list)) or (isinstance(actual, list) and actual):
            return False
        for key, value in expected.items():
            if not isinstance(actual, dict) or key not in actual:
                return False
            if not Json.contains_subset(value, actual[key]):
                return False
        return True
