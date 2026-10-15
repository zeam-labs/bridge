import base64
import binascii
import copy
import json
import re

_STRICT_B64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")
_URL_CLEAN = re.compile(r"[^A-Za-z0-9+/]")


def nesting(value):
    deepest, stack = 0, [(value, 0)]
    while stack:
        v, d = stack.pop()
        if isinstance(v, dict):
            deepest = max(deepest, d + 1)
            stack.extend((x, d + 1) for x in v.values())
        elif isinstance(v, list):
            deepest = max(deepest, d + 1)
            stack.extend((x, d + 1) for x in v)
    return deepest


def loads(text, depth):
    try:
        value = json.loads(text)
    except (ValueError, RecursionError, UnicodeDecodeError):
        return False, None
    if nesting(value) >= depth:
        return False, None
    return True, value


class Json:
    @staticmethod
    def encode(value):
        try:
            return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as e:
            raise ValueError(f"value is not JSON: {e}")

    @staticmethod
    def decode(text):
        if not isinstance(text, (str, bytes)) or len(text) == 0:
            return False, None
        if isinstance(text, bytes):
            try:
                text = text.decode("utf-8")
            except UnicodeDecodeError:
                return False, None
        return loads(text, 64)

    @staticmethod
    def to_object(value):
        return copy.deepcopy(value)

    @staticmethod
    def base64_encode(text):
        return base64.b64encode(text.encode("utf-8") if isinstance(text, str) else text).decode()

    @staticmethod
    def base64_decode(text):
        if not isinstance(text, str) or not _STRICT_B64.match(text):
            return None
        body = text.rstrip("=")
        if len(body) % 4 == 1:
            return None
        try:
            return base64.b64decode(body + "=" * (-len(body) % 4), validate=True)
        except (binascii.Error, ValueError):
            return None

    @staticmethod
    def base64_url_decode(text):
        text = "" if text is None else str(text)
        cut = text.find("=")
        if cut != -1:
            text = text[:cut]
        clean = _URL_CLEAN.sub("", text.replace("-", "+").replace("_", "/"))
        if len(clean) % 4 == 1:
            clean = clean[:-1]
        try:
            return base64.b64decode(clean + "=" * (-len(clean) % 4))
        except (binascii.Error, ValueError):
            return b""

    @staticmethod
    def base64_url_encode(text):
        raw = text.encode("utf-8") if isinstance(text, str) else text
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @staticmethod
    def canonical(value):
        return Json.encode(Json._sorted(value))

    @staticmethod
    def _sorted(value):
        if isinstance(value, dict):
            return {k: Json._sorted(value[k]) for k in sorted(value)}
        if isinstance(value, list):
            return [Json._sorted(v) for v in value]
        if isinstance(value, float) and value == value and value not in (float("inf"), float("-inf")) and value.is_integer() and abs(value) < 9007199254740992:
            return int(value)
        return value

    @staticmethod
    def deep_equal(a, b):
        return Json.canonical(a) == Json.canonical(b)

    @staticmethod
    def contains_subset(expected, actual):
        if not isinstance(expected, dict):
            return Json.deep_equal(expected, actual)
        if not isinstance(actual, dict):
            return False
        for k, v in expected.items():
            if k not in actual:
                return False
            if not Json.contains_subset(v, actual[k]):
                return False
        return True
