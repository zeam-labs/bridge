import asyncio
import base64
import contextvars
from concurrent.futures import ThreadPoolExecutor
import functools
import http
import inspect
import io
import json
import math
import re
import secrets
import threading
import urllib.parse

from .engine import DEFAULT_CREDITS, DEFAULT_RELAY, DEFAULT_RPC, GRANTED_BY, Engine, setting
from .engine.bazaar import bazaar
from .engine.discovery import CACHE_CONTROL, FAILED_CALL, discovery
from .engine.meter import bought_ms, time_micro, time_rate, time_text
from .engine.pricing import FreeLimit, Hangup, caller, deadline_ms, hearing, metered, price_of, running, stopped, unhearing, units, usd
from .engine.pricing import describe as describe_price
from .engine.settlement import Channels, StateFile
from .engine.settlement.mpp import Credential, McpPayment, MppError, Receipt
from .engine.wire import stringify
from .grants import gate_proof, key_address, new_key, sign_grant

META_PAYMENT = "x402/payment"
META_RESPONSE = "x402/payment-response"
META_GRANTED_BY = "zeam-pass/granted-by"
META_PRICE = "zeam-pass/price"
META_LINE = "zeam-pass/line"
META_METER = "zeam-pass/meter"
LINE_OPS = ("open", "prove", "on", "off", "status", "close")
CHANNEL = re.compile(r"^0x[0-9a-fA-F]{64}$")
MCP_SESSION = re.compile(r"^mcp\.[A-Za-z0-9_-]{16}\Z")
MCP_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_BODY = 1024 * 1024
PROBLEM_JSON = "application/problem+json"


def _problem(payload):
    return isinstance(payload, dict) and isinstance(payload.get("type"), str) and payload["type"].startswith("https://paymentauth.org/problems/")


REFUND_TURN = "Zeam-Refund-Turn"
CORS = {"access-control-allow-origin": "*", "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate, Payment-Receipt, X-Pass-Granted-By, X-Pass-Ms-Remaining, X-Pass-Ms-Elapsed"}
PREFLIGHT = {**CORS, "access-control-allow-methods": "GET, POST, OPTIONS",
             "access-control-allow-headers": "content-type, payment-signature, x-payment, authorization, payment-authorization, x-line, x-grant, mcp-protocol-version, mcp-session-id",
             "access-control-max-age": "600"}
HOW = {"paywall": "Paid per call with x402 or MPP", "gate": "Admitted keys only, proven by a zero-value x402 signature; nothing is paid",
       "both": "Admitted keys only, paid per call with x402 or MPP"}
RESULT_NOT_JSON = "the result is not valid JSON (a non-finite number or a non-JSON value). " + FAILED_CALL
TYPES = {"string": (str,), "integer": (int,), "number": (int, float), "boolean": (bool,),
         "object": (dict,), "array": (list,), "null": (type(None),)}

__all__ = ["Bridge", "Pass", "Engine", "Hangup", "deadline_ms", "gate_proof", "key_address", "new_key", "setting", "sign_grant", "stopped", "units"]


def _b64(obj):
    return base64.b64encode(json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()).decode()


def _unb64(value):
    try:
        return json.loads(base64.b64decode(value).decode())
    except Exception:
        return None


def _reject_constant(name):
    raise ValueError(f"{name} is not a JSON number")


def _finite(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"{text} is out of range")
    return value


def _faithful(value):
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, (list, tuple)):
        return all(_faithful(v) for v in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _faithful(v) for k, v in value.items())
    return False


def _serializes(value):
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return False
    return _faithful(value)


def _loads(raw):
    return json.loads(raw, parse_constant=_reject_constant, parse_float=_finite)


def _is(value, kind):
    if kind == "integer" and isinstance(value, float):
        return value.is_integer()
    if isinstance(value, bool) and kind != "boolean":
        return False
    return isinstance(value, TYPES.get(kind, (object,)))


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_value(key, spec, value):
    kinds = spec.get("type")
    kinds = [kinds] if isinstance(kinds, str) else kinds if isinstance(kinds, list) else []
    if kinds and not any(_is(value, k) for k in kinds):
        return f"argument {key} must be {' or '.join(map(str, kinds))}"
    if isinstance(spec.get("enum"), list) and value not in spec["enum"]:
        return f"argument {key} must be one of {stringify(spec['enum'])}"
    if _number(value):
        if _number(spec.get("minimum")) and value < spec["minimum"]:
            return f"argument {key} must be at least {spec['minimum']}"
        if _number(spec.get("maximum")) and value > spec["maximum"]:
            return f"argument {key} must be at most {spec['maximum']}"
        if _number(spec.get("multipleOf")) and spec["multipleOf"] > 0 and value % spec["multipleOf"] != 0:
            return f"argument {key} must be a multiple of {spec['multipleOf']}"
    if isinstance(value, str):
        if _number(spec.get("minLength")) and len(value) < spec["minLength"]:
            return f"argument {key} must be at least {spec['minLength']} characters"
        if _number(spec.get("maxLength")) and len(value) > spec["maxLength"]:
            return f"argument {key} must be at most {spec['maxLength']} characters"
    return None


def _check_object(schema, args, prefix, nested):
    required = schema.get("required") if isinstance(schema.get("required"), list) else []
    missing = [k for k in required if k not in args]
    if missing:
        return f"missing required argument: {prefix}{missing[0]}"
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    for key, value in args.items():
        spec = props.get(key)
        if not isinstance(spec, dict):
            continue
        wrong = _check_value(prefix + str(key), spec, value)
        if wrong:
            return wrong
        if nested and isinstance(value, dict):
            wrong = _check_object(spec, value, f"{prefix}{key}.", False)
            if wrong:
                return wrong
    return None


def _accepted(fn, args):
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return args
    if any(p.kind == p.VAR_KEYWORD for p in params):
        return args
    names = {p.name for p in params if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)}
    return {k: v for k, v in args.items() if k in names}


def _validate(schema, args):
    if not isinstance(args, dict):
        return "the arguments must be an object"
    return _check_object(schema if isinstance(schema, dict) else {}, args, "", True)


def _said(out):
    content = out.get("content") if isinstance(out, dict) else None
    texts = [c["text"] for c in content if isinstance(c, dict) and isinstance(c.get("text"), str)] if isinstance(content, list) else []
    return "\n".join(texts) or "the tool reported an error"


def _text(obj):
    return [{"type": "text", "text": obj if isinstance(obj, str) else stringify(obj)}]


def _reason(status):
    try:
        return http.HTTPStatus(status).phrase
    except ValueError:
        return "Status"


def _first(headers, names):
    for n in names:
        v = headers.get(n)
        if isinstance(v, str) and v.strip() != "":
            return v.strip()
    return ""


def _out_of_time(on_line, ms=None):
    if on_line:
        return {"error": "out_of_time", "message": "the line ran out of time during the call. Its time is spent. Buy time: buy_time."}
    return {"error": "out_of_time", "message": f"the call needs more than the {ms} ms its price buys, so it was cut. Nothing was charged. Buy time and call on a line."}


def _hung_up(on_line):
    billed = "The line is billed for the time the call ran, nothing after." if on_line else "Nothing was charged."
    return {"error": "client_gone", "message": f"the caller hung up or canceled the call, so it was stopped. {billed}"}


def _call_key(ident):
    if isinstance(ident, str):
        return "string", ident
    if isinstance(ident, (int, float)) and not isinstance(ident, bool):
        return "number", float(ident)
    return None


def _int(value):
    try:
        return int(float(value)) if value is not None and not isinstance(value, bool) else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def _reading(meta):
    return {"x-pass-ms-remaining": str(meta["msRemaining"]), "x-pass-ms-elapsed": str(meta["elapsedMs"])}


def _metered(out, meta):
    if not meta:
        return out
    return {**out, "_meta": {**(out["_meta"] if isinstance(out.get("_meta"), dict) else {}), META_METER: meta}}


def _failure(body):
    return {"isError": True, "structuredContent": body, "content": _text(body)}


def _own_status(body):
    s = body.get("status") if isinstance(body, dict) else None
    return s if isinstance(s, int) and not isinstance(s, bool) and 400 <= s <= 599 and s != 402 else 500


def _failed(out, tool):
    if isinstance(out.get("structuredContent"), dict):
        return out
    return {**out, "isError": True, "structuredContent": {"error": "tool_failed", "tool": tool, "message": _said(out)}}


def _settled_meta(headers):
    meta = {}
    settled = _unb64(headers["PAYMENT-RESPONSE"]) if headers.get("PAYMENT-RESPONSE") else None
    if settled:
        meta[META_RESPONSE] = settled
    if isinstance(headers.get(GRANTED_BY), str):
        meta[META_GRANTED_BY] = headers[GRANTED_BY]
    if isinstance(headers.get("Payment-Receipt"), str):
        try:
            meta[McpPayment.RECEIPT] = Receipt.parse(headers["Payment-Receipt"])
        except MppError:
            pass
    return meta


def _mpp_credential(headers):
    offered = _first(headers, ("payment-authorization", "authorization"))
    return offered if Credential.is_one(offered) else ""


def _mpp_meta(s):
    try:
        required = McpPayment.required(s["headers"].get("WWW-Authenticate"), s["body"])
    except MppError:
        required = None
    return {} if required is None else {"_meta": {McpPayment.REQUIRED: required}}


class _RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Bridge:

    def __init__(self, name, payout=None, mode="paywall", price=None, site=None, admit=None, relay=DEFAULT_RELAY,
                 credits=DEFAULT_CREDITS, rpc=DEFAULT_RPC, state_dir=None, server_name=None, version="2.1.0", on_empty="refuse",
                 refund_url=None, tick_seconds=60, relay_transport=None,
                 credits_http=None, settings=None, contact=None, payout_is_fee_recipient=False, prices=None, free=None, free_limit=None, time=None):
        self.name = name
        self.server_name = server_name or name
        self.version = version
        self.site = site.rstrip("/") if site else None
        self.engine = Engine(name, payout, mode=mode, price=price, site=self.site, admit=admit, relay=relay, credits=credits,
                             rpc=rpc, state_dir=state_dir,
                             on_empty=on_empty, refund_url=refund_url, relay_transport=relay_transport,
                             credits_http=credits_http, settings=settings, tick_seconds=tick_seconds, contact=contact,
                             payout_is_fee_recipient=payout_is_fee_recipient, prices=prices, free=free, free_limit=free_limit, time=time)
        self._free_limit = FreeLimit(self.engine.free_limit, self.engine._now_ms)
        self._free_file = StateFile(self.engine.state_dir, "free.json") if self.engine.free_limit else None
        self._tools = {}
        self._calling = {}
        self._calls = threading.Lock()
        self.time = self.engine.time
        self.meter = self.engine.meter
        if self.time:
            self._builtins()
        self.engine.start()

    def _builtins(self):
        t = self.time
        meter = self.meter

        def buy_time(ms=None, blocks=None):
            n = bought_ms(t, {"ms": ms, "blocks": blocks})
            box = running() or {}
            cid = box.get("channelId")
            st = meter.status(cid)
            return {"channelId": cid, "boughtMs": n, "msRemaining": st["msRemaining"] + n,
                    "paidUSD": usd(time_micro(t, n))}

        def line(**args):
            return self._line_tool(args, "")

        self._tools["buy_time"] = {
            "name": "buy_time", "builtin": "buy_time", "run": buy_time, "price": None, "unit": None, "free": False,
            "description": f"Buys line time: {time_rate(t)}, for the channel that pays. Then open a line.",
            "inputSchema": {"type": "object", "properties": {"ms": {
                "type": "integer", "minimum": t["rateMs"], **({"multipleOf": t["rateMs"]} if t["rateMs"] > 1 else {}), **({"maximum": t["maxMs"]} if t.get("maxMs") else {}),
                "description": f"milliseconds of line time; default {t['unitMs']}. Buying again adds time"}}},
        }
        self._tools["line"] = {
            "name": "line", "builtin": "line", "run": line, "price": None, "unit": None, "free": True,
            "description": ('A line spends bought time without a payment per call. {"op":"open","channelId":"0x…"} returns a message to sign '
                            'with the payer key; {"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"} returns the credential; '
                            '{"op":"on","credential":"…"} and {"op":"off","credential":"…"} switch the channel\'s meter on and off; '
                            '{"op":"status","credential":"…"} reads the line; {"op":"close","credential":"…"} ends it.'),
            "inputSchema": {"type": "object", "properties": {"op": {"enum": list(LINE_OPS)}, "channelId": {"type": "string"}, "nonce": {"type": "string"},
                                                             "signature": {"type": "string"}, "credential": {"type": "string"}}, "required": ["op"]},
        }

    @property
    def mode(self):
        return self.engine.mode

    def tick(self):
        return self.engine.tick()

    def status(self):
        return self.engine.status()

    def payout_now(self):
        return self.engine.payout_now()

    def tool(self, name=None, description="", input_schema=None, price=None, unit=None, free=False, meter=None, output_schema=None):
        def register(fn):
            t = {
                "name": name or fn.__name__,
                "description": description or (fn.__doc__ or "").strip(),
                "inputSchema": input_schema or {"type": "object"},
                "run": fn,
                "price": price,
                "unit": unit,
                "free": free is True,
            }
            if isinstance(output_schema, dict):
                t["outputSchema"] = output_schema
            if (self._tools.get(t["name"]) or {}).get("builtin"):
                raise ValueError(f"bridge: {t['name']} is a built-in tool")
            if meter is not None and meter != "time":
                raise ValueError('bridge: meter is "time"')
            if meter == "time":
                if not self.time or self._is_free(t):
                    raise ValueError(f"bridge: {t['name']} meters time; set the seller's time option, and do not make it free")
                t["meter"] = "time"
            if not self._is_free(t) and self.mode != "gate" and (self._own_price(t) or not callable(self.engine.prices)):
                self._price_for(t)
            self._tools[t["name"]] = t
            return fn
        return register

    def _is_free(self, tool):
        return tool.get("free") is True or tool["name"] in self.engine.free

    @staticmethod
    def _own_price(tool):
        return tool.get("price") is not None or tool.get("unit") is not None

    def _asked(self, tool, args):
        if tool.get("builtin") != "buy_time" or not isinstance(args, dict) or "ms" in args:
            return args
        blocks = args.get("blocks")
        if isinstance(blocks, float) and blocks.is_integer():
            blocks = int(blocks)
        if isinstance(blocks, int) and not isinstance(blocks, bool) and 1 <= blocks <= 9007199254740991:
            return {**args, "ms": blocks * self.time["unitMs"]}
        return args

    def _price_for(self, tool, args=None):
        if tool.get("builtin") == "buy_time":
            ms = bought_ms(self.time, args)
            return {"micro": time_micro(self.time, ms), "unitMicro": None, "ms": ms}
        p = self._base_price(tool, args)
        if tool.get("meter") == "time" and self.time and p["unitMicro"] is None:
            return {**p, "rateMicro": self.time["rateMicro"], "rateMs": self.time["rateMs"]}
        return p

    def _base_price(self, tool, args=None):
        fallback = self.engine.price_micro
        prices = self.engine.prices
        if self._own_price(tool):
            return price_of({"price": tool.get("price"), "unit": tool.get("unit")}, fallback)
        if callable(prices):
            return price_of(prices(tool["name"], args if args is not None else {}), fallback)
        return price_of(prices.get(tool["name"]) if isinstance(prices, dict) else None, fallback)

    def _price_tag(self, tool):
        if tool.get("builtin") == "line":
            return {"usd": "0", "per": "call", "free": True}
        if tool.get("builtin") == "buy_time":
            return {"usd": usd(self.time["rateMicro"]), "per": "ms", "ms": self.time["rateMs"], **({"maxMs": self.time["maxMs"]} if self.time.get("maxMs") else {})}
        if tool.get("meter") == "time":
            if callable(self.engine.prices) and not self._own_price(tool):
                return {"per": "time", "usd": usd(self.time["rateMicro"]), "ms": self.time["rateMs"], "varies": True}
            p = self._price_for(tool)
            return {"per": "time", "usd": usd(self.time["rateMicro"]), "ms": self.time["rateMs"],
                    "callUSD": usd(p["micro"]), "callMs": self.meter.call_ms(p["micro"])}
        if self._is_free(tool):
            return describe_price(None, free=True, per_hour=self.engine.free_limit)
        if self.mode == "gate":
            return {"usd": "0", "per": "call"}
        if not self._own_price(tool) and callable(self.engine.prices):
            return describe_price(None, varies=True)
        return describe_price(self._price_for(tool))

    def _listing(self, base=""):
        if self.mode == "gate":
            return {}
        out = {"prices": {t["name"]: self._price_tag(t) for t in self._tools.values()}}
        if self.time:
            out["time"] = time_text(self.time, base)
        return out

    def tools(self):
        return [self._describe(t) for t in self._tools.values()]

    def _describe(self, tool):
        return {"name": tool["name"], "description": tool["description"], "inputSchema": tool["inputSchema"], "_meta": {META_PRICE: self._price_tag(tool)}}

    def _public(self, url):
        if not self.site or not url:
            return url
        called, site = urllib.parse.urlsplit(url), urllib.parse.urlsplit(self.site)
        return urllib.parse.urlunsplit((site.scheme, site.netloc, called.path, called.query, ""))

    def _run(self, tool, args):
        try:
            out = tool["run"](**_accepted(tool["run"], args))
        except TypeError as e:
            return False, f"bad arguments: {e}", 400
        except Exception as e:
            return False, str(e), 500
        if isinstance(out, dict) and out.get("isError") is True:
            return False, out, 500
        if not _serializes(out):
            return False, RESULT_NOT_JSON, 500
        return True, out, None

    def _within(self, ms, tool, args, more=None):
        result = {}
        ctx = contextvars.copy_context()
        mine = Hangup(caller())
        ctx.run(hearing, mine)
        wake = threading.Event()

        def work():
            try:
                result["out"] = self._run(tool, args)
            finally:
                wake.set()

        mine.listen(wake.set)
        if not mine.gone:
            threading.Thread(target=ctx.run, args=(work,), name=f"zeam-bridge-{tool['name']}", daemon=True).start()
        while not mine.gone:
            wake.wait(None if ms is None else min(max(0, ms) / 1000, threading.TIMEOUT_MAX))
            if wake.is_set():
                break
            ms = more() if more is not None else 0
            if not ms > 0:
                break
        mine.leave()
        out = result.get("out")
        if out is None:
            mine.hang_up()
        return out

    @staticmethod
    def _gone(out):
        heard = caller()
        return heard is not None and heard.gone and (out is None or not out[0])

    def _bounded(self, ms, tool, args):
        deadline = None if ms is None else self.engine._now_ms() + ms
        box = running()
        if box is not None and deadline is not None:
            box["deadline"] = deadline
        out = self._within(ms, tool, args)
        if self._gone(out):
            return False, {**_hung_up(False), "tool": tool["name"]}, 499
        if deadline is not None and (out is None or (not out[0] and self.engine._now_ms() >= deadline)):
            return False, _out_of_time(False, ms), 402
        return out

    def _bought(self, tool, args):
        if tool.get("builtin") != "buy_time":
            return None
        ms = bought_ms(self.time, args)

        def stated(hold, value):
            if not isinstance(value, dict) or "msRemaining" not in value:
                return value
            try:
                return {**value, "msRemaining": self.meter.status(hold["channelId"])["msRemaining"]}
            except Exception:
                return value

        return {"ms": ms,
                "credit": lambda hold: self.meter.credit(hold["channelId"], ms, hold["pendingId"]),
                "undo": lambda hold: self.meter.uncredit(hold["channelId"], ms, hold["pendingId"]),
                "stated": stated}

    def _serve(self, tool, args, url, payment, grant, refund_url=None, price=None, via="http", credential=""):
        resource = Engine.resource(url, tool["description"])
        if tool.get("meter") == "time" and price is not None:
            bound = self.meter.call_ms(price["micro"])
            run = lambda: self._bounded(bound, tool, args)
        elif caller() is not None:
            run = lambda: self._bounded(None, tool, args)
        else:
            run = lambda: self._run(tool, args)
        base = re.sub(r"/refund$", "", refund_url or "")
        return self.engine.serve(tool["name"], resource, payment, grant, run, refund_url, price, self._listing(base), self._bought(tool, args), bazaar(tool, via), credential)

    @staticmethod
    def _timed_out(s):
        return s.get("failed") and s["status"] == 402 and isinstance(s["body"], dict) and s["body"].get("error") == "out_of_time"

    @staticmethod
    def _hung(s):
        return s.get("failed") and s["status"] == 499 and isinstance(s["body"], dict) and s["body"].get("error") == "client_gone"

    def _free(self, tool, args, client, line=""):
        if tool.get("builtin") == "line":
            out = self._line_tool(args, line)
            return {"ok": not out.get("isError"), "body": out, "status": 500}
        who = client or ""
        take = self._free_limit.take_saved(self._free_file, tool["name"], who) if self._free_file else self._free_limit.take(tool["name"], who)
        if not take["ok"]:
            return {"limited": FreeLimit.refusal(self.engine.free_limit, take["retryAfter"]), "retryAfter": take["retryAfter"]}
        (ok, out, status), _units = metered(lambda: self._run(tool, args))
        return {"ok": ok, "body": out, "status": status}

    def _on_line(self, tool, args, credential, refund_url=None):
        meter = self.meter
        channel_id = meter.line(credential)
        if not channel_id:
            return {"status": 403, "body": {"error": "line_unknown", "message": 'no open line with that credential. Open one: POST {"op":"open","channelId":"0x…"} to this seller\'s line route, the address its 402 time line names.'}}
        ident = secrets.token_hex(8)
        heard = caller()
        channels = self.engine.parts()["server"].channels

        def seat(g, ch, now, asked):
            if not ch:
                return {"refused": {"status": 403, "body": {"error": "line_unknown", "message": "no channel for this line."}}}
            if _int(ch.get("withdrawRequestedAt")) > 0:
                return {"refused": {"status": 402, "body": {"error": "channel_leaving", "message": "this channel is withdrawing. Open a new channel."}}}
            if heard is not None and heard.gone:
                return {"refused": {"status": 499, "body": _hung_up(True)}}
            return {"b": meter.begin(channel_id, ident)}

        try:
            k = channels.until_answered(channel_id, self.engine.parts()["cfg"].now_ms() + channels.judge_wait_ms(), seat)
        except Exception:
            k = {"refused": {"status": 403, "body": {"error": "line_unknown", "message": "no channel for this line."}}}
        if "settling" in k:
            secs = k["settling"]
            return {"status": 402, "body": {"error": "refund_settling", "message": f"a refund is settling on this channel, retry in {secs}s.", "retry_after_seconds": secs}}
        if "refused" in k:
            return k["refused"]
        b = k["b"]
        if not b["ok"]:
            ms_remaining = meter.status(channel_id)["msRemaining"]
            if b["code"] == "too_many_calls":
                return {"status": 429, "body": {"error": "too_many_calls", "message": "too many calls are live on this line; wait for one to finish, then retry.", "msRemaining": ms_remaining}}
            at = re.sub(r"/refund$", "", refund_url or "")
            why = f'the meter is off. Switch it on: POST {at}/line {{"op":"on","credential":"<yours>"}}.' if b["code"] == "meter_off" else "this line has no time left. Buy time: buy_time."
            return {"status": 402, "body": {"error": b["code"], "message": why, "msRemaining": ms_remaining}}
        line = {"deadline": b["deadline"], "renewed": False, "spent": False}
        turn = threading.Lock()

        def renew():
            with turn:
                if not line["spent"] and meter._now() >= line["deadline"]:
                    r = meter.renew(channel_id, ident, line["deadline"])
                    if r["ok"] and r["deadline"] > line["deadline"]:
                        line.update(deadline=r["deadline"], renewed=True)
                    else:
                        line["spent"] = True
                return line["deadline"]

        out, _units = metered(lambda: self._within(b["deadline"] - meter._now(), tool, args, lambda: renew() - meter._now()), deadline=b["deadline"], renew=renew, channelId=channel_id)
        ended = meter.stopped(channel_id, ident)
        gone = self._gone(out)
        cut = not gone and (out is None or (ended >= line["deadline"] and not out[0]))
        e = meter.end(channel_id, ident) if cut else meter.end(channel_id, ident, b["started"], ended)
        meta = {"channelId": channel_id, "msRemaining": e["msRemaining"], "elapsedMs": ended - b["started"] if line["renewed"] and not cut else e["elapsedMs"]}
        if cut or (not gone and e["over"]):
            return {"status": 402, "body": {**_out_of_time(True), "msRemaining": e["msRemaining"]}}
        if gone:
            return {"status": 499, "body": {**_hung_up(True), "msRemaining": meta["msRemaining"], "elapsedMs": meta["elapsedMs"]}, "meta": meta}
        ok, value, status = out
        if not ok:
            return {"status": status, "failed": value, "meta": meta}
        return {"status": 200, "value": value, "meta": meta}

    def _line_tool(self, args, header_credential):
        l = self._line_op(args, header_credential)
        return l["body"] if l["status"] == 200 else {"isError": True, "structuredContent": l["body"], "content": _text(l["body"])}

    def _line_op(self, args, header_credential=""):
        def fail(status, code, why):
            return {"status": status, "body": {"op": "line_failed", "code": code, "why": why}}

        if not self.time:
            return fail(404, "no_time", "this seller sells no line time")
        if not isinstance(args, dict) or args.get("op") not in LINE_OPS:
            return fail(400, "bad_request", "op is open, prove, on, off, status or close")
        meter = self.meter
        op = args["op"]
        if op in ("open", "prove"):
            cid = args.get("channelId")
            ident = cid.lower() if isinstance(cid, str) and CHANNEL.match(cid) else None
            if not ident:
                return fail(400, "bad_request", 'channelId is missing or is not 0x and 64 hex characters: send "channelId":"0x…" with the op')
            ch = self.engine.channel(ident) if ident else None
            if not ch or not ch.get("channelConfig"):
                return fail(404, "unknown_channel", "no channel with that id here. Pay a call on it first, e.g. buy_time.")
            if _int(ch.get("withdrawRequestedAt")) > 0:
                return fail(409, "channel_leaving", "this channel is withdrawing. Open a new channel.")
            if op == "open":
                c = meter.challenge(ident)
                return {"status": 200, "body": {"op": "challenge", "channelId": ident, "nonce": c["nonce"], "sign": c["message"], "expiresInSeconds": c["expiresInSeconds"]}}
            channels = self.engine.parts()["server"].channels
            cfg = self.engine.parts()["cfg"]
            deadline = cfg.now_ms() + channels.judge_wait_ms()

            def gate(attach):
                out = channels.until_answered(ident, deadline, lambda g, rec, now, asked: attach({"judged": Channels.retry_secs(cfg, 0)} if asked else None))
                if "settling" in out:
                    return channels.serial(ident, lambda g: attach({"settling": out["settling"]}))
                return out

            try:
                r = meter.prove(ch, args.get("nonce"), args.get("signature"), gate)
            except Exception:
                return {"status": 503, "body": {"op": "line_failed", "code": "line_unavailable", "why": "the line could not be read right now. Retry."}}
            refused = r.get("refused") or {}
            if "settling" in refused:
                secs = refused["settling"]
                return {"status": 402, "body": {"op": "line_failed", "code": "refund_settling", "why": f'a refund is settling on this channel, and a first line would switch its meter on. Nothing was opened: send {{"op":"open"}} again in {secs}s.', "retry_after_seconds": secs}}
            if "judged" in refused:
                secs = refused["judged"]
                return {"status": 402, "body": {"op": "line_failed", "code": "refund_pending", "why": f'a refund asked for on this channel is being worked out, and the meter stays off until it is answered. Nothing was opened: send {{"op":"open"}} again in {secs}s.', "retry_after_seconds": secs}}
            if not r["ok"]:
                return fail(r["status"], r["code"], r["why"])
            return {"status": 200, "body": {"op": "opened", "credential": r["credential"], "channelId": ident, "msRemaining": r["msRemaining"], "metering": r["metering"]}}
        credential = args["credential"] if isinstance(args.get("credential"), str) and args["credential"] != "" else header_credential
        if not credential:
            return fail(400, "bad_request", 'credential is missing or is not a string: add "credential":"<yours>" to the body, or send it as the x-line header')
        ident = meter.line(credential)
        if not ident:
            return fail(403, "line_unknown", "no open line with that credential")
        channels = self.engine.parts()["server"].channels
        if op == "close":
            channels.serial(ident, lambda g: meter.close(credential))
            return {"status": 200, "body": {"op": "closed", "channelId": ident}}
        if op == "on":
            cfg = self.engine.parts()["cfg"]

            def turn_on(g, ch, now, asked):
                if asked:
                    return {"judged": Channels.retry_secs(cfg, 0)}
                meter.switch(ident, True)
                return {}

            try:
                marked = channels.until_answered(ident, cfg.now_ms() + channels.judge_wait_ms(), turn_on)
            except Exception:
                return {"status": 503, "body": {"op": "line_failed", "code": "line_unavailable", "why": "the line could not be read right now. Retry."}}
            if "settling" in marked:
                secs = marked["settling"]
                return {"status": 402, "body": {"op": "line_failed", "code": "refund_settling", "why": f"a refund is settling on this channel, retry in {secs}s.", "retry_after_seconds": secs}}
            if "judged" in marked:
                secs = marked["judged"]
                return {"status": 402, "body": {"op": "line_failed", "code": "refund_pending", "why": f"a refund asked for on this channel is being worked out, and the meter stays off until it is answered. Retry in {secs}s.", "retry_after_seconds": secs}}
        elif op != "status":
            channels.serial(ident, lambda g: meter.switch(ident, False))
        return {"status": 200, "body": {"op": op, **meter.status(ident)}}

    def _probe(self, tool, args, payment, credential):
        return payment == "" and isinstance(args, dict) and not args and not tool.get("builtin") and not self._is_free(tool) and not (tool.get("meter") == "time" and credential)

    def _probe_terms(self, tool, resource, grant, refund_url, via="http"):
        try:
            price = None if self.mode == "gate" else self._price_for(tool, {})
        except Exception:
            return None
        s = self._serve(tool, {}, resource, "", grant, refund_url, price, via)
        return None if s.get("delivered") or s.get("failed") else s

    def _price_or_refusal(self, tool, args):
        if self.mode == "gate":
            return None, None
        try:
            return self._price_for(tool, args), None
        except Exception as e:
            return None, {"error": "price_invalid", "tool": tool["name"], "message": str(e)}

    @staticmethod
    def _http_failure(tool_name, out, status):
        if isinstance(out, dict):
            fields = _failed(out, tool_name)["structuredContent"]
            body = {"error": "tool_failed", "message": _said(out), "tool": tool_name, **fields}
            wait = body.get("retry_after_seconds")
            return _own_status(fields), ({"retry-after": str(wait)} if isinstance(wait, int) and not isinstance(wait, bool) and wait > 0 else {}), body
        return status, {}, {"error": "invalid_arguments" if status == 400 else "tool_failed", "message": out, "tool": tool_name}

    def _unknown_tool(self, tool):
        return {"error": "unknown_tool", "message": f"no tool named {tool} here; tools lists the ones there are", "tool": tool, "tools": list(self._tools)}

    def _http(self, tool_name, headers, body, resource=None, refund_url=None, client=""):
        tool = self._tools.get(tool_name)
        if not tool and tool_name == "line":
            l = self._line_op({})
            return l["status"], {}, l["body"]
        if not tool:
            return 404, {}, self._unknown_tool(tool_name)
        try:
            args = _loads(body if body and body.strip() else b"{}")
        except ValueError as e:
            return 400, {}, {"error": "invalid_arguments", "message": f"the body is not JSON: {e}", "tool": tool_name}
        wrong = _validate(tool["inputSchema"], self._asked(tool, args))
        if wrong and self._probe(tool, args, _first(headers, ("payment-signature", "x-payment")) or ("paid" if _mpp_credential(headers) else ""), _first(headers, ("x-line",))):
            s = self._probe_terms(tool, resource, _first(headers, ("x-grant",)), refund_url)
            if s:
                return s["status"], s["headers"], s["body"]
        if wrong:
            return 400, {}, {"error": "invalid_arguments", "message": wrong, "tool": tool_name}
        if tool.get("builtin") == "line":
            l = self._line_op(args, _first(headers, ("x-line",)))
            return l["status"], {}, l["body"]
        if self._is_free(tool):
            f = self._free(tool, args, client, _first(headers, ("x-line",)))
            if "limited" in f:
                return 429, {"retry-after": str(f["retryAfter"])}, f["limited"]
            if not f["ok"]:
                return self._http_failure(tool_name, f["body"], f["status"])
            return 200, {}, f["body"]
        credential = _first(headers, ("x-line",))
        if tool.get("meter") == "time" and credential:
            l = self._on_line(tool, args, credential, refund_url)
            if "failed" in l:
                f = self._http_failure(tool_name, l["failed"], l["status"])
                return f[0], {**f[1], **_reading(l["meta"])}, {**f[2], "msRemaining": l["meta"]["msRemaining"], "elapsedMs": l["meta"]["elapsedMs"]}
            if l["status"] != 200:
                return l["status"], _reading(l["meta"]) if "meta" in l else {}, l["body"]
            return 200, _reading(l["meta"]), l["value"]
        price, invalid = self._price_or_refusal(tool, args)
        if invalid:
            return 500, {}, invalid
        s = self._serve(tool, args, resource, _first(headers, ("payment-signature", "x-payment")), _first(headers, ("x-grant",)), refund_url, price, "http", _mpp_credential(headers))
        if self._timed_out(s):
            return 402, {}, s["body"]
        if self._hung(s):
            return 499, {}, s["body"]
        if s.get("failed"):
            return self._http_failure(tool_name, s["body"], s["status"])
        return s["status"], s["headers"], s["body"]

    @staticmethod
    def _payment_result(s):
        body = s["body"] if isinstance(s["body"], dict) else {}
        required = _unb64(s["headers"].get("PAYMENT-REQUIRED", "")) if s["headers"].get("PAYMENT-REQUIRED") else None
        if not isinstance(required, dict):
            required = body if "accepts" in body else None
        if not required and s["status"] == 402:
            required = {"x402Version": 2, "accepts": [], **body}
        if required:
            required = {"x402Version": 2, **body, **required}
            return {"isError": True, "structuredContent": required, "content": _text(required), **_mpp_meta(s)}
        if isinstance(s["body"], dict):
            return {"isError": True, "structuredContent": s["body"], "content": _text(s["body"]), **_mpp_meta(s)}
        return {"isError": True, "content": _text(body), **_mpp_meta(s)}

    @staticmethod
    def _mcp_failure(out, status, name):
        if isinstance(out, dict):
            return _failed(out, name)
        return _failure({"error": "invalid_arguments" if status == 400 else "tool_failed", "tool": name, "message": out})

    @staticmethod
    def _delivered(out, meta=None):
        extra = {"_meta": meta} if meta else {}
        structured = {"structuredContent": out} if isinstance(out, dict) else {}
        return {"content": _text(out), **structured, **extra}

    def _mcp_call(self, params, resource=None, grant="", refund_url=None, client="", line=""):
        if not isinstance(params, dict):
            raise _RpcError(-32602, "params must be an object")
        name = params.get("name")
        if not isinstance(name, str):
            raise _RpcError(-32602, "params.name must be a string")
        meta = params.get("_meta", {})
        if meta is None:
            meta = {}
        if not isinstance(meta, dict):
            raise _RpcError(-32602, "params._meta must be an object")
        args = params.get("arguments", {})
        if args is None:
            args = {}
        payment = meta.get(META_PAYMENT)
        paying = payment is not None and payment is not False and payment != 0 and payment != ""
        tool = self._tools.get(name)
        if not tool:
            return _failure(self._unknown_tool(name))
        wrong = _validate(tool["inputSchema"], self._asked(tool, args))
        credential = meta.get(META_LINE).strip() if isinstance(meta.get(META_LINE), str) and meta[META_LINE].strip() else (line or "").strip()
        if wrong and self._probe(tool, args, "paid" if paying or meta.get(McpPayment.CREDENTIAL) else "", credential):
            s = self._probe_terms(tool, resource, grant, refund_url, "mcp")
            if s:
                return self._payment_result(s)
        if wrong:
            return _failure({"error": "invalid_arguments", "tool": name, "message": wrong})
        if self._is_free(tool):
            f = self._free(tool, args, client, credential)
            if "limited" in f:
                return _failure(f["limited"])
            if not f["ok"]:
                return self._mcp_failure(f["body"], f["status"], name)
            return self._delivered(f["body"])
        if tool.get("meter") == "time" and credential:
            l = self._on_line(tool, args, credential, refund_url)
            if "failed" in l:
                return _metered(self._mcp_failure(l["failed"], l["status"], name), l["meta"])
            if l["status"] != 200:
                return _metered(_failure(l["body"]), l.get("meta"))
            return self._delivered(l["value"], {META_METER: l["meta"]})
        price, invalid = self._price_or_refusal(tool, args)
        if invalid:
            return _failure(invalid)
        s = self._serve(tool, args, resource, _b64(payment) if paying else "", grant, refund_url, price, "mcp", "" if paying else McpPayment.header(meta))
        if self._timed_out(s) or self._hung(s):
            return _failure(s["body"])
        if s.get("failed"):
            return self._mcp_failure(s["body"], s["status"], name)
        if not s["delivered"]:
            return self._payment_result(s)
        return self._delivered(s["body"], _settled_meta(s["headers"]))

    def _takes_mpp(self):
        if self.mode == "gate":
            return False
        try:
            return self.engine.parts()["server"].mpp_asset() is not None
        except Exception:
            return False

    def _callers(self, line, session, meta):
        named = meta.get(META_LINE) if isinstance(meta, dict) else None
        credential = named.strip() if isinstance(named, str) and named.strip() else (line or "").strip()
        ident = session.strip() if isinstance(session, str) else ""
        by = set()
        if credential:
            by.add(f"line {credential}")
        if McpPayment.in_session(ident) or MCP_SESSION.match(ident):
            by.add(f"session {ident}")
        return by

    def _called(self, ident, line, session, meta):
        key = _call_key(ident)
        call = (Hangup(caller()), self._callers(line, session, meta))
        if key is not None:
            with self._calls:
                self._calling.setdefault(key, []).append(call)

        def land():
            call[0].leave()
            with self._calls:
                live = [c for c in self._calling.get(key, ()) if c is not call]
                if live:
                    self._calling[key] = live
                else:
                    self._calling.pop(key, None)

        return call[0], land

    def _canceled(self, msg, line, session):
        params = msg.get("params")
        if msg.get("method") != "notifications/cancelled" or not isinstance(params, dict):
            return
        key = _call_key(params.get("requestId"))
        if key is None:
            return
        by = self._callers(line, session, params.get("_meta"))
        with self._calls:
            found = [c for c in self._calling.get(key, ()) if c[1] & by]
        for c in found:
            c[0].hang_up()

    def _mcp_one(self, msg, resource=None, grant="", refund_url=None, client="", line="", payment=False, session=""):
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
        if "id" not in msg:
            self._canceled(msg, line, session)
            return None
        ident = msg["id"]
        try:
            method = msg["method"]
            params = msg.get("params")
            if params is not None and not isinstance(params, (dict, list)):
                raise _RpcError(-32602, "params must be an object")
            if method == "initialize":
                asked = params.get("protocolVersion") if isinstance(params, dict) else None
                declared = isinstance(params, dict) and McpPayment.declares(params.get("capabilities")) and self._takes_mpp() and self._sells_by_charge()
                result = {"protocolVersion": asked if asked in MCP_VERSIONS else MCP_VERSIONS[0],
                          "capabilities": {"tools": {}, **({"experimental": {"payment": McpPayment.capability()}} if declared else {})},
                          "serverInfo": {"name": self.server_name, "version": self.version}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": self.tools()}
            elif method == "tools/call":
                asked = McpPayment.params(msg)
                heard, land = self._called(ident, line, session, asked.get("_meta") if isinstance(asked, dict) else None)
                token = hearing(heard)
                try:
                    result = self._mcp_call(asked, resource, grant, refund_url, client, line)
                finally:
                    unhearing(token)
                    land()
                unpaid = McpPayment.error(result.get("_meta", {}).get(McpPayment.REQUIRED), result.get("structuredContent")) if payment else None
                if unpaid is not None:
                    return {"jsonrpc": "2.0", "id": ident, "error": unpaid}
            else:
                raise _RpcError(-32601, f"method not found: {method}")
            return {"jsonrpc": "2.0", "id": ident, "result": result}
        except _RpcError as e:
            return {"jsonrpc": "2.0", "id": ident, "error": {"code": e.code, "message": str(e)}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": ident, "error": {"code": -32603, "message": f"internal error: {e}"}}

    def _mcp(self, body, resource=None, grant="", refund_url=None, client="", line="", session=""):
        try:
            data = _loads(body or b"")
        except ValueError:
            return 400, {}, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        batch = isinstance(data, list)
        if batch and not data:
            return 400, {}, {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request: empty batch"}}
        items = data if batch else [data]
        payment = McpPayment.in_session(session) and self._takes_mpp()
        one = lambda m: self._mcp_one(m, resource, grant, refund_url, client, line, payment, session)
        opened = {}
        if not batch and isinstance(data, dict) and data.get("method") == "initialize" and "id" in data:
            declared = isinstance(data.get("params"), dict) and McpPayment.declares(data["params"].get("capabilities")) and self._takes_mpp()
            issued = McpPayment.session() if declared else "mcp." + base64.urlsafe_b64encode(secrets.token_bytes(12)).decode()
            opened = {"mcp-session-id": issued, "access-control-expose-headers": CORS["access-control-expose-headers"] + ", Mcp-Session-Id"}
        if len(items) > 1:
            carried = [contextvars.copy_context() for _ in items]
            with ThreadPoolExecutor(max_workers=len(items)) as pool:
                found = list(pool.map(lambda pair: pair[0].run(one, pair[1]), zip(carried, items)))
        else:
            found = [one(m) for m in items]
        answers = [a for a in found if a is not None]
        if not answers:
            return 202, {}, None
        return 200, opened, answers if batch else answers[0]

    def _responses(self, tool):
        if self._is_free(tool):
            out = {"200": {"description": "the result"}, "400": {"description": "invalid arguments"}, "500": {"description": "the tool failed"}}
            if self.engine.free_limit and not tool.get("builtin"):
                out["429"] = {"description": f"over {self.engine.free_limit} free calls an hour per address"}
            out["413"] = {"description": "the body is over the size this seller reads; nothing is charged"}
            if tool.get("name") == "line":
                out.update({"400": {"description": "invalid arguments (error invalid_arguments), or a step refused (op line_failed, with code and why)"}, "402": {"description": "a refund settling on the channel answers refund_settling; \"on\" while a refund asked for on the channel is being worked out answers refund_pending"}, "403": {"description": "no line with that credential, or the proof is not the payer's"},
                            "404": {"description": "no channel with that id here, or this seller sells no line time"}, "409": {"description": "the channel is leaving; code and why say so"},
                            "503": {"description": "the line could not be read right now (code line_unavailable; nothing changed, send it again)"}})
            return out
        timed = tool.get("meter") == "time"
        unavailable = ("the check failed (error payment_unavailable), this gate has no checks left this month (error gate_credit_exhausted)" if self.mode == "gate"
                       else "the payment check or settlement failed (error payment_unavailable)")
        out = {"200": {"description": "the result"},
               "400": {"description": "invalid arguments; nothing is charged" if self.mode == "gate" else "invalid arguments (error invalid_arguments), or a payment that does not decode (error bad_payment_header) or is neither a voucher nor a deposit (error bad_payment_type); nothing is charged"},
               "402": {"description": "a zero-value x402 signature is required; nothing is paid" if self.mode == "gate" else
                       ("x402 payment required" if tool.get("builtin") == "buy_time" or self._price_tag(tool).get("per") == "unit" else "payment required: x402, or MPP when the 402 carries a Payment challenge")
                       + ("; on a line, the meter is off (error meter_off), the line is out of time (error out_of_time) or the channel is withdrawing (error channel_leaving)" if timed else "") + "; a refund settling on the channel answers refund_settling"},
               "403": {"description": "key not admitted" + ("; on a line, no line with that credential (error line_unknown)" if timed else "")},
               "413": {"description": "the body is over the size this seller reads; nothing is charged"},
               "499": {"description": "the caller hung up or canceled the call, so it was stopped (error client_gone); nothing is charged" + (" per call, and on a line the line is billed for the time the call ran" if timed else "")},
               "500": {"description": "the tool failed; nothing is charged per call" + (", and on a line the call has used the time it ran" if timed else "")},
               "503": {"description": unavailable + ", or this seller's setup is incomplete (error not_ready); nothing is charged. Retry later"}}
        if timed:
            out["429"] = {"description": "too many calls are live on the line (error too_many_calls)"}
        return out

    def _sells_by_charge(self):
        if self._mpp_offers():
            return True
        return callable(self.engine.prices) and any(not self._is_free(t) and not t.get("builtin") and not self._own_price(t) for t in self._tools.values())

    def _mpp_offers(self):
        if self.mode == "gate":
            return {}
        try:
            server = self.engine.parts()["server"]
        except Exception:
            return {}
        offers = {}
        for t in self._tools.values():
            if self._is_free(t) or (not self._own_price(t) and callable(self.engine.prices)):
                continue
            try:
                offer = server.mpp_offer(self._price_for(t, {}), t.get("description"))
            except Exception:
                offer = None
            if offer is not None:
                offers[t["name"]] = offer
        return offers

    def discovery(self, origin, mount=""):
        base = (self._public(origin.rstrip("/") + mount) or "").rstrip("/")
        return self.openapi(base, mount)

    def openapi(self, base_url, mount=None):
        paths = {f"/v1/{t['name']}": {"post": {"operationId": t["name"], "summary": t["description"], "x-price": self._price_tag(t),
                                                "requestBody": {"required": True, "content": {"application/json": {"schema": t["inputSchema"]}}},
                                                "responses": self._responses(t)}}
                 for t in self._tools.values()}
        info = {"title": self.server_name, "version": self.version,
                "description": f"{HOW[self.mode]}. MCP: {base_url}/mcp"}
        contact = self.engine.contact
        if contact:
            info["contact"] = {"email": contact[7:]} if contact.lower().startswith("mailto:") else {"url": contact}
        doc = {"openapi": "3.0.3", "info": info, "servers": [{"url": base_url}], "paths": paths}
        if mount is None:
            return discovery(doc, self._mpp_offers(), self.site)
        return discovery(doc, self._mpp_offers(), self.site, base_url[:len(base_url) - len(mount)], mount)

    def refund(self, body):
        try:
            args = json.loads(body or b"{}")
        except ValueError:
            return 400, {}, {"op": "refund_failed", "code": "invalid_json", "why": "the body is not JSON"}
        if not isinstance(args, dict):
            return 400, {}, {"op": "refund_failed", "code": "invalid_request", "why": "expected { channelId, issued, signature }, optional selfSend or gasPayment"}
        try:
            r = self.engine.refund(args)
        except Exception as e:
            return 503, {}, {"op": "refund_failed", "code": "refund_unavailable", "why": f"the refund could not be handled right now: {e}", "retry_after_seconds": 5}
        turn = r.get("turn")
        if not isinstance(turn, int) or isinstance(turn, bool):
            return r["status"], {}, r["body"]
        return r["status"], {REFUND_TURN.lower(): str(turn), "access-control-expose-headers": CORS["access-control-expose-headers"] + ", " + REFUND_TURN}, {**r["body"], "turn": turn}

    @staticmethod
    def ours(path):
        return path in ("/mcp", "/openapi.json", "/refund", "/line") or path.startswith("/v1/")

    def handle(self, method, path, headers, body, base_url="", client="", hangup=None):
        token = None if hangup is None else hearing(hangup)
        try:
            out = self._handle(method, path, {k.lower(): v for k, v in headers.items()}, body, base_url, client or "")
        finally:
            if token is not None:
                unhearing(token)
        if out is None:
            return None
        status, extra, payload = out
        return status, {**CORS, **extra, **({"content-type": PROBLEM_JSON} if _problem(payload) else {})}, payload

    def _handle(self, method, path, headers, body, base_url, client=""):
        if method == "OPTIONS" and self.ours(path):
            return 204, dict(PREFLIGHT), None
        refund_at = self._public(base_url + "/refund")
        mcp = self._public(base_url + "/mcp")
        if path == "/mcp":
            if method != "POST":
                return 405, {"allow": "POST, OPTIONS"}, None
            return self._mcp(body, mcp, _first(headers, ("x-grant",)), refund_at, client, _first(headers, ("x-line",)), _first(headers, ("mcp-session-id",)))
        if path == "/openapi.json" and method == "GET":
            return 200, {"cache-control": CACHE_CONTROL}, self.openapi((self._public(base_url) or base_url).rstrip("/"))
        if path == "/refund" and method == "POST":
            return self.refund(body)
        if path == "/line" and method == "POST":
            if not self.time:
                l = self._line_op({})
                return l["status"], {}, l["body"]
            try:
                args = _loads(body or b"")
            except ValueError:
                return 400, {}, {"op": "line_failed", "code": "bad_request", "why": "the body is not JSON"}
            l = self._line_op(args, _first(headers, ("x-line",)))
            return l["status"], {}, l["body"]
        if path.startswith("/v1/") and method == "POST":
            return self._http(path[4:], headers, body, self._public(base_url + path), refund_at, client)
        return None

    def asgi(self, fallback=None):
        async def app(scope, receive, send):
            if scope["type"] != "http":
                if fallback:
                    return await fallback(scope, receive, send)
                return
            path = scope["path"][len(scope.get("root_path", "")):] or "/"
            if not self.ours(path) and fallback:
                return await fallback(scope, receive, send)
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
            try:
                declared = int(headers.get("content-length") or 0)
            except ValueError:
                declared = 0
            chunks, size, big = [], 0, declared > MAX_BODY
            while not big:
                event = await receive()
                if event.get("type") == "http.disconnect":
                    return
                chunk = event.get("body", b"")
                size += len(chunk)
                if size > MAX_BODY:
                    big = True
                    break
                chunks.append(chunk)
                if not event.get("more_body"):
                    break
            body = b"".join(chunks)
            gone = Hangup()
            if big:
                out = (413, dict(CORS), {"error": "body_too_large", "message": f"the body is over {MAX_BODY} bytes", "limit": MAX_BODY})
            else:
                host = headers.get("host", "localhost")
                base_url = f"{scope.get('scheme', 'http')}://{host}{scope.get('root_path', '')}"
                peer = scope.get("client")
                client = str(peer[0]) if isinstance(peer, (list, tuple)) and peer and peer[0] is not None else ""

                async def listen():
                    try:
                        while (await receive()).get("type") != "http.disconnect":
                            pass
                    except Exception:
                        return
                    gone.hang_up()

                listener = asyncio.ensure_future(listen())
                try:
                    out = await asyncio.to_thread(self.handle, scope["method"], path, headers, body, base_url, client, gone)
                except BaseException:
                    gone.hang_up()
                    raise
                finally:
                    listener.cancel()
            if out is None:
                if fallback:
                    replayed = [{"type": "http.request", "body": body, "more_body": False}]

                    async def again():
                        if replayed:
                            return replayed.pop()
                        return {"type": "http.disconnect"} if gone.gone else await receive()
                    return await fallback(scope, again, send)
                out = (404, {}, {"error": "not_found", "message": "nothing is served at this path"})
            status, extra, payload = out
            raw = b"" if payload is None else stringify(payload).encode()
            hdrs = [(b"content-type", str(extra.get("content-type", "application/json")).encode())] + [(k.lower().encode(), str(v).encode()) for k, v in extra.items() if k.lower() != "content-type"]
            try:
                await send({"type": "http.response.start", "status": status, "headers": hdrs})
                await send({"type": "http.response.body", "body": raw})
            except Exception:
                if not gone.gone:
                    raise
        return app

    def wsgi(self, fallback=None):
        def app(environ, start_response):
            path = environ.get("PATH_INFO") or "/"
            try:
                path = path.encode("latin-1").decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
            if not self.ours(path) and fallback:
                return fallback(environ, start_response)
            try:
                length = max(int(environ.get("CONTENT_LENGTH") or 0), 0)
            except ValueError:
                length = 0
            if length > MAX_BODY:
                out = (413, dict(CORS), {"error": "body_too_large", "message": f"the body is over {MAX_BODY} bytes", "limit": MAX_BODY})
                body = b""
            else:
                body = environ["wsgi.input"].read(length) if length else b""
                headers = {k[5:].replace("_", "-").lower(): v for k, v in environ.items() if k.startswith("HTTP_")}
                if environ.get("CONTENT_TYPE"):
                    headers["content-type"] = environ["CONTENT_TYPE"]
                base_url = f"{environ.get('wsgi.url_scheme', 'http')}://{environ.get('HTTP_HOST', 'localhost')}{environ.get('SCRIPT_NAME', '')}"
                out = self.handle(environ["REQUEST_METHOD"], path, headers, body, base_url, environ.get("REMOTE_ADDR") or "")
            if out is None:
                if fallback:
                    environ["wsgi.input"] = io.BytesIO(body)
                    environ["CONTENT_LENGTH"] = str(len(body))
                    return fallback(environ, start_response)
                out = (404, {}, {"error": "not_found", "message": "nothing is served at this path"})
            status, extra, payload = out
            raw = b"" if payload is None else stringify(payload).encode()
            start_response(f"{status} {_reason(status)}", [("content-type", str(extra.get("content-type", "application/json")))] + [(k, str(v)) for k, v in extra.items() if k.lower() != "content-type"])
            return [raw]
        return app

    def paid(self, fn):
        priced = {"name": fn.__name__}
        if self.mode != "gate" and not callable(self.engine.prices):
            self._price_for(priced)

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            from flask import request, make_response
            box = {}
            price, invalid = self._price_or_refusal(priced, dict(kwargs))
            if invalid:
                return self._flask_json(make_response, invalid, 500)

            def run():
                box["resp"] = make_response(fn(*args, **kwargs))
                return (box["resp"].status_code < 400), box["resp"], box["resp"].status_code

            headers = {k.lower(): v for k, v in request.headers.items()}
            resource = Engine.resource(self._public(request.url), (fn.__doc__ or "").strip())
            s = self.engine.serve(fn.__name__, resource, _first(headers, ("payment-signature", "x-payment")), _first(headers, ("x-grant",)), run, None, price, self._listing(), None, None, _mpp_credential(headers))
            if s.get("failed"):
                return s["body"]
            if not s["delivered"]:
                return self._flask(self._flask_json(make_response, s["body"], s["status"]), s["headers"])
            return self._flask(s["body"], s["headers"])
        return wrapper

    def refund_view(self):
        def refund():
            from flask import request, make_response
            status, extra, body = self.refund(request.get_data())
            return self._flask(self._flask_json(make_response, body, status), extra)
        return refund

    @staticmethod
    def _flask_json(make_response, body, status):
        resp = make_response(stringify(body), status)
        resp.headers["Content-Type"] = PROBLEM_JSON if _problem(body) else "application/json"
        return resp

    @staticmethod
    def _flask(resp, headers):
        for k, v in headers.items():
            resp.headers[k] = v
        return resp


Pass = Bridge
