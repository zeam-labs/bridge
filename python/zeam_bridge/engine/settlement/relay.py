import json
import math
import re

from ..core import Address, Hex
from ..rpc import post_json
from ..php import is_numeric
from .jsonx import Json


def http_transport(method, url, body, timeout):
    status, _, raw = post_json(url, body, timeout, method=method)
    return {"status": status, "body": raw.decode("utf-8", "replace")}


_DIGITS = re.compile(r"\d+")


def _js_str(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return "" if v is None else str(v)


def _num(v):
    f = float(v)
    return int(f) if f.is_integer() else f


class Relay:
    def __init__(self, url, transport=None, timeout=300):
        if not re.match(r"^https?://", str(url), re.I):
            raise ValueError("a relay URL starts with http:// or https://")
        self.url = str(url).rstrip("/")
        self.transport = transport or http_transport
        self.timeout = float(timeout)

    def send(self, calls, split):
        body = {
            "calls": [{"to": Address.checksum(c["to"]), "data": Hex.lower(c["data"])} for c in calls],
            "split": split,
        }
        try:
            r = self.transport("POST", self.url + "/relay", Json.encode(body), self.timeout)
        except Exception as e:
            r = {"status": 0, "body": "", "error": str(e)}
        decoded = None
        if isinstance(r.get("body"), str):
            try:
                decoded = json.loads(r["body"])
            except ValueError:
                decoded = None
        status = int(r.get("status") or 0)
        if isinstance(decoded, dict) and isinstance(decoded.get("error"), str):
            fallback = decoded["error"]
        elif r.get("error") is not None:
            fallback = "the relay did not answer: " + str(r["error"])
        else:
            fallback = f"the relay answered {status}"
        results = decoded.get("results") if isinstance(decoded, dict) and isinstance(decoded.get("results"), (list, dict)) else []
        results = list(results.values()) if isinstance(results, dict) else results
        out = []
        for i in range(len(calls)):
            one = results[i] if i < len(results) and isinstance(results[i], dict) else None
            if one is not None and Hex.is_hex(one.get("hash"), 32):
                out.append({"hash": one["hash"].lower()})
                continue
            failed = {"error": str(one["error"]) if one is not None and one.get("error") is not None else fallback}
            if one is not None and isinstance(one.get("code"), str):
                failed["code"] = one["code"]
            if one is not None and is_numeric(one.get("gasMicroUSD")) and float(one["gasMicroUSD"]) > 0:
                failed["gasMicroUSD"] = int(math.ceil(float(one["gasMicroUSD"])))
            out.append(failed)
        return out

    def send_quote(self, calls, split):
        body = {
            "calls": [{"to": Address.checksum(c["to"]), "data": Hex.lower(c["data"])} for c in calls],
            "split": split,
        }
        try:
            r = self.transport("POST", self.url + "/quote", Json.encode(body), 10)
        except Exception:
            return None
        if not isinstance(r, dict) or int(r.get("status") or 0) != 200:
            return None
        try:
            d = json.loads(r.get("body")) if isinstance(r.get("body"), str) else None
        except Exception:
            return None
        if isinstance(d, dict) and d.get("op") == "send_quote" and isinstance(d.get("covered"), bool):
            return d
        return None

    def quote(self, call, payment=True):
        body = {"call": {"to": Address.checksum(call["to"]), "data": Hex.lower(call["data"])}, "payment": bool(payment)}
        try:
            r = self.transport("POST", self.url + "/quote", Json.encode(body), 10)
        except Exception:
            return None
        return Relay._quoted(r)

    def shape_quote(self, claim, payment=True):
        try:
            r = self.transport("GET", self.url + "/quote?claim=" + ("1" if claim else "0") + "&payment=" + ("1" if payment else "0"), None, 5)
        except Exception:
            return None
        return Relay._quoted(r)

    def paid(self, channel_id):
        try:
            r = self.transport("GET", self.url + "/paid?channel=" + str(channel_id).lower(), None, 5)
        except Exception:
            return None
        return Relay.paid_of(r, channel_id)

    @staticmethod
    def paid_of(r, channel_id):
        if not r or r.get("status") is None or int(r["status"]) != 200:
            return None
        try:
            d = json.loads(str(r.get("body")))
        except ValueError:
            return None
        if not isinstance(d, dict) or d.get("op") != "gas_paid":
            return None
        if not isinstance(d.get("channelId"), str) or d["channelId"].lower() != str(channel_id).lower():
            return None
        units = d.get("gasUnits")
        if isinstance(units, bool) or not isinstance(units, (int, float)) or units != units or units in (float("inf"), float("-inf")):
            return None
        return int(units) if units == int(units) and 0 <= units <= 9007199254740991 else None

    @staticmethod
    def _quoted(r):
        if not r or r.get("status") is None or int(r["status"]) != 200:
            return None
        try:
            d = json.loads(str(r.get("body")))
        except ValueError:
            return None
        if not isinstance(d, dict):
            return None

        def pos(v):
            return is_numeric(v) and float(v) > 0

        if (not pos(d.get("quoteMicroUSD")) or not pos(d.get("costMicroUSD")) or not pos(d.get("gasUnits")) or not pos(d.get("ethUSD"))
                or not is_numeric(d.get("marginPercent")) or not _DIGITS.fullmatch(_js_str(d.get("gasPriceWei"))) or not _DIGITS.fullmatch(_js_str(d.get("l1FeeWei")))):
            return None
        if float(d["quoteMicroUSD"]) < float(d["costMicroUSD"]):
            return None
        units = int(float(d["gasUnits"]))
        margin = _num(d["marginPercent"])
        return {"microUSD": int(math.ceil(float(d["quoteMicroUSD"]))), "costMicroUSD": int(math.ceil(float(d["costMicroUSD"]))), "gasUnits": units,
                "gasUnitsWithMargin": int(math.ceil(units * (1 + margin / 100))), "gasPriceWei": _js_str(d["gasPriceWei"]), "ethUSD": _num(d["ethUSD"]),
                "marginPercent": margin, "l1FeeWei": _js_str(d["l1FeeWei"]), "quotedBy": "relay"}

    def health(self):
        try:
            r = self.transport("GET", self.url + "/health", None, 10)
        except Exception:
            return None
        if r.get("status") is None or int(r["status"]) != 200:
            return None
        try:
            decoded = json.loads(str(r.get("body")))
        except ValueError:
            return None
        return decoded if isinstance(decoded, (dict, list)) else None
