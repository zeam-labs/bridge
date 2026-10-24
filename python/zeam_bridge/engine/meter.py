import base64
import copy
import hashlib
import math
import os
import secrets
import threading
import time

from .core import Secp256k1
from .pricing import MAX_MICRO, MAX_SAFE, MAX_USD, micro_of, usd
from .settlement.store import FileStore

NONCE_SECS = 300
KEEP_CREDITED = 64
KEEP_NONCES = 8


class Clock:
    HOLD_MS = 2000
    KEEP_DONE = 512
    MAX_LIVE_CALLS = 1000
    ALIVE_MS = 1000
    DEAD_MS = 30000

    @staticmethod
    def fresh(channel_id):
        return {"channelId": str(channel_id).lower(), "balanceMs": 0, "spentMs": 0, "returnedMs": 0, "on": False, "since": None,
                "lastActive": None, "calls": {}, "done": [], "credited": [], "nonces": {}, "lines": []}

    @staticmethod
    def merged(intervals):
        out = []
        for s, e in sorted(([s, e] for s, e in intervals if e > s), key=lambda x: (x[0], x[1])):
            if out and s <= out[-1][1]:
                out[-1][1] = max(out[-1][1], e)
            else:
                out.append([s, e])
        return out

    @staticmethod
    def covered(intervals):
        return sum(e - s for s, e in Clock.merged(intervals))

    @staticmethod
    def spans(rec, start, to, idle_ms=0):
        out = [[max(s, start), min(e, to)] for s, e in rec.get("done") or []]
        out += [[max(c["start"], start), min(to, c["deadline"])] for c in rec["calls"].values()]
        if rec["on"] and idle_ms > 0 and rec["lastActive"] is not None:
            out.append([max(rec["lastActive"], start), min(to, rec["lastActive"] + idle_ms)])
        return out

    @staticmethod
    def settle(rec, now, idle_ms=0):
        r = rec
        r["done"] = r.get("done") or []
        if r["since"] is None:
            r["since"] = now
            for ident in [i for i, c in r["calls"].items() if c["deadline"] <= now]:
                del r["calls"][ident]
            return r
        for ident in [i for i, c in r["calls"].items() if c["deadline"] <= now]:
            c = r["calls"].pop(ident)
            r["done"].append([c["start"], c["deadline"]])
        r["done"] = Clock.merged(r["done"])
        horizon = max(r["since"], now - Clock.HOLD_MS)
        if len(r["done"]) > Clock.KEEP_DONE:
            horizon = max(horizon, min(now, r["done"][len(r["done"]) - Clock.KEEP_DONE - 1][1]))
        burned = min(r["balanceMs"], Clock.covered(Clock.spans(r, r["since"], horizon, idle_ms)))
        r["balanceMs"] -= burned
        r["spentMs"] += burned
        r["since"] = horizon
        r["done"] = [[max(s, horizon), e] for s, e in r["done"] if e > horizon]
        return r

    @staticmethod
    def pending(rec, now, idle_ms=0):
        start = now if rec["since"] is None else rec["since"]
        return min(rec["balanceMs"], Clock.covered(Clock.spans(rec, start, now, idle_ms)))

    @staticmethod
    def left(rec, now, idle_ms=0):
        return rec["balanceMs"] - Clock.pending(rec, now, idle_ms)

    @staticmethod
    def remaining(rec, now, idle_ms=0):
        return Clock.left(Clock.settle(copy.deepcopy(rec), now, idle_ms), now, idle_ms)

    @staticmethod
    def spent(rec, now, idle_ms=0):
        r = Clock.settle(copy.deepcopy(rec), now, idle_ms)
        return r["spentMs"] + Clock.pending(r, now, idle_ms)

    @staticmethod
    def active(rec, at, idle_ms=0):
        last = rec["lastActive"]
        if rec["on"] and idle_ms > 0 and last is not None and at > last:
            rec["done"].append([last, min(at, last + idle_ms)])
        rec["lastActive"] = at if last is None else max(last, at)

    @staticmethod
    def switch(rec, on, now, idle_ms=0):
        Clock.settle(rec, now, idle_ms)
        Clock.active(rec, now, idle_ms)
        rec["on"] = on
        return rec

    @staticmethod
    def begin(rec, ident, now, idle_ms=0, cap=None):
        Clock.settle(rec, now, idle_ms)
        if not rec["on"]:
            return {"ok": False, "code": "meter_off"}
        left = Clock.left(rec, now, idle_ms)
        if left <= 0:
            return {"ok": False, "code": "out_of_time"}
        if cap is not None and len(rec["calls"]) >= cap:
            return {"ok": False, "code": "too_many_calls"}
        Clock.active(rec, now, idle_ms)
        deadline = now + left
        rec["calls"][ident] = {"start": now, "deadline": deadline}
        return {"ok": True, "deadline": deadline}

    @staticmethod
    def end(rec, ident, now, idle_ms=0, start=None, stop=None):
        rec["done"] = rec.get("done") or []
        c = rec["calls"].get(ident)
        ran = min(now if stop is None else stop, now)
        begun = ran if c is None else c["start"]
        if c is not None:
            if start is not None and start > c["start"] and ran <= c["deadline"]:
                begun = min(start, ran)
            rec["done"].append([begun, min(ran, c["deadline"])])
            del rec["calls"][ident]
        Clock.active(rec, ran, idle_ms)
        Clock.settle(rec, now, idle_ms)
        return {"elapsedMs": 0 if c is None else ran - begun, "over": c is None or ran > c["deadline"]}

    @staticmethod
    def renew(rec, ident, now, idle_ms=0, start=None, last=None):
        rec["done"] = rec.get("done") or []
        c = rec["calls"].pop(ident, None)
        due = last if c is None else c["deadline"]
        if c is not None:
            rec["done"].append([start if start is not None and start > c["start"] else c["start"], min(now, c["deadline"])])
        covers = now
        if due is not None and due < now and rec["since"] is not None:
            covers = min(now, due + max(0, Clock.left(rec, now, idle_ms)))
        if due is not None and covers > due:
            rec["done"].append([due, covers])
        Clock.settle(rec, now, idle_ms)
        left = Clock.left(rec, now, idle_ms)
        if covers < now or left <= 0:
            return {"ok": False, "code": "out_of_time"}
        deadline = now + left
        rec["calls"][ident] = {"start": now, "deadline": deadline}
        return {"ok": True, "deadline": deadline}

    @staticmethod
    def buy(rec, ms, key, now, idle_ms=0):
        if key in rec["credited"]:
            return False
        Clock.settle(rec, now, idle_ms)
        rec["balanceMs"] += ms
        rec["credited"] = (rec["credited"] + [key])[-KEEP_CREDITED:]
        return True

    @staticmethod
    def owe(rec, owed, now, idle_ms=0):
        for key, ms in (owed or {}).items():
            if isinstance(ms, int) and not isinstance(ms, bool) and 0 < ms <= MAX_SAFE:
                Clock.buy(rec, ms, str(key), now, idle_ms)
        return rec

    @staticmethod
    def unbuy(rec, ms, key, now, idle_ms=0):
        if key not in rec["credited"]:
            return 0
        Clock.settle(rec, now, idle_ms)
        taken = max(0, min(ms, Clock.left(rec, now, idle_ms)))
        rec["balanceMs"] -= taken
        rec["credited"] = [k for k in rec["credited"] if k != key]
        return taken

    @staticmethod
    def unburned_micro(rec, now, idle_ms, rate_micro, rate_ms):
        left = Clock.remaining(rec, now, idle_ms)
        return (left * rate_micro + rate_ms - 1) // rate_ms

    @staticmethod
    def forget(rec, now, idle_ms=0):
        Clock.settle(rec, now, idle_ms)
        burning = Clock.pending(rec, now, idle_ms)
        returned = rec["balanceMs"] - burning
        rec["spentMs"] += burning
        rec["returnedMs"] += returned
        rec["balanceMs"] = 0
        rec["on"] = False
        rec["calls"] = {}
        rec["done"] = []
        rec["since"] = now
        return returned

    @staticmethod
    def line_message(channel_id, nonce):
        return f"ZEAM Pass line\nchannel: {str(channel_id).lower()}\nnonce: {nonce}"


def _whole(value):
    if isinstance(value, bool):
        return int(value)
    try:
        return int(float(value))
    except (TypeError, ValueError, OverflowError):
        return None


def _safe_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if isinstance(value, int) and abs(value) <= 9007199254740991 else None


def _first(o, *names):
    for name in names:
        if o.get(name) is not None:
            return o[name]
    return None


def time_options(o):
    if o is None or o is False:
        return None
    if not isinstance(o, dict):
        raise ValueError('bridge: time is {"usd": "0.00025", "ms": 250}: that many dollars buys that many milliseconds')
    micro = micro_of(_first(o, "usd", "block"), "time.usd")
    given = _first(o, "ms", "blockMs")
    ms = 250 if given is None else _whole(given)
    idle_ms = 0 if o.get("idleMs") is None else _whole(o["idleMs"])
    max_calls = Clock.MAX_LIVE_CALLS if o.get("maxCalls") is None else _whole(o["maxCalls"])
    if ms is None or not 1 <= ms <= 3600000:
        raise ValueError("bridge: time.ms is 1 to 3600000")
    if idle_ms is None or not 0 <= idle_ms <= 3600000:
        raise ValueError("bridge: time.idleMs is 0 to 3600000")
    if max_calls is None or not 1 <= max_calls <= 1000:
        raise ValueError("bridge: time.maxCalls is 1 to 1000")
    capped = o.get("maxMs") is not None or o.get("maxBlocks") is not None
    if o.get("maxMs") is not None:
        max_ms = _whole(o["maxMs"])
    elif o.get("maxBlocks") is not None:
        try:
            max_ms = _whole(float(o["maxBlocks"]) * ms)
        except (TypeError, ValueError, OverflowError):
            max_ms = None
    else:
        max_ms = None
    g = math.gcd(micro, ms)
    rate_micro = micro // g
    rate_ms = ms // g
    if capped and not (max_ms is not None and max_ms >= rate_ms and max_ms % rate_ms == 0):
        raise ValueError(f"bridge: time.maxMs is a multiple of {rate_ms} ms, the smallest amount this price sells; leave it out for no maximum")
    return {"rateMicro": rate_micro, "rateMs": rate_ms, "unitMs": ms, "idleMs": idle_ms, "maxMs": max_ms, "maxCalls": max_calls}


def time_rate(t):
    return f"${usd(t['rateMicro'])} per {'ms' if t['rateMs'] == 1 else str(t['rateMs']) + ' ms'}"


def time_micro(t, ms):
    micro = ms // t["rateMs"] * t["rateMicro"]
    if micro > MAX_MICRO:
        raise ValueError(f"bridge: that much line time costs more than ${MAX_USD}; above that a number stops counting micro-USD exactly. Buy less at a time")
    return micro


def bought_ms(t, args):
    a = args if isinstance(args, dict) else {}
    ms = _safe_int(a.get("ms"))
    if ms is not None:
        return ms
    blocks = _safe_int(a.get("blocks"))
    if blocks is not None and blocks >= 1:
        return blocks * t["unitMs"]
    return t["unitMs"]


def time_text(t, base=""):
    idle = f" and {t['idleMs']} ms after each" if t["idleMs"] > 0 else ""
    step = f" in steps of {t['rateMs']} ms" if t["rateMs"] > 1 else ""
    most = f" (up to {t['maxMs']} ms a purchase)" if t.get("maxMs") else ""
    return (f'Line time: {time_rate(t)}. buy_time {{"ms": N}}{step}{most}; buying again adds time; '
            "the time is credited to the paying channel once the payment settles. "
            f'Open a line: POST {base}/line {{"op":"open","channelId":"0x…"}}, sign the message it returns with the payer key, '
            'POST {"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"}. Send the credential as x-line (MCP: _meta["zeam-pass/line"]). '
            f'Time burns while a call runs on the line{idle}; a call stops when the time runs out. {{"op":"off"}}: no new calls on any line of the channel; a running call burns to its end. '
            "Unburned time comes back with a refund.")


class TimeMeter:

    def __init__(self, directory, t, now=None, clocks=None, lines=None, alive=None, owed=None):
        self.t = t
        self.owed = owed
        self.now = now if callable(now) else (lambda: int(time.time() * 1000))
        self.clocks = clocks if clocks is not None else FileStore(os.path.join(directory, "clocks"))
        self.lines = lines if lines is not None else FileStore(os.path.join(directory, "lines"))
        self.alive = alive if alive is not None else FileStore(os.path.join(directory, "alive"))
        self.boot = "0x" + secrets.token_hex(32)
        self.pulsed = None
        self.pulsing = None
        self.marks = {}
        self._beat = threading.Lock()
        self.starts = {}
        self.stops = {}
        self.opening = set()
        self._seen = threading.Lock()

    def pulse(self):
        now = self._now()
        with self._beat:
            if self.pulsed is not None and now >= self.pulsed and now - self.pulsed < Clock.ALIVE_MS:
                return
            self.pulsed = now
        self.alive.update(self.boot, lambda _c: {"channelId": self.boot, "at": now})

    def _pulses(self):
        while True:
            time.sleep(Clock.ALIVE_MS / 1000)
            with self._beat:
                if not self.starts:
                    self.pulsing = None
                    return
            try:
                self.pulse()
            except Exception:
                pass

    def keep_alive(self):
        with self._beat:
            if self.pulsing is not None:
                return
            self.pulsing = threading.Thread(target=self._pulses, name="zeam-bridge-alive", daemon=True)
            self.pulsing.start()

    def last_alive(self, boot, now):
        hit = self.marks.get(boot)
        if hit is not None and now >= hit["read"] and now - hit["read"] < Clock.ALIVE_MS:
            return hit["at"]
        try:
            mark = self.alive.get(boot)
        except Exception:
            mark = None
        at = mark.get("at") if isinstance(mark, dict) else None
        at = at if isinstance(at, int) and not isinstance(at, bool) else 0
        self.marks[boot] = {"at": at, "read": now}
        return at

    def reap(self, rec, now):
        for ident, c in list((rec.get("calls") or {}).items()):
            by = c.get("by")
            if not isinstance(by, str) or by == self.boot:
                continue
            at = self.last_alive(by, now)
            if now - at <= Clock.DEAD_MS:
                continue
            ran = max(at, c["start"])
            rec["done"] = rec.get("done") or []
            rec["done"].append([c["start"], min(ran, c["deadline"])])
            del rec["calls"][ident]
            Clock.active(rec, ran, self.t["idleMs"])
        return rec

    @staticmethod
    def hash(credential):
        return "0x" + hashlib.sha256(str(credential).encode("utf-8")).hexdigest()

    def call_ms(self, price_micro):
        return min((price_micro * self.t["rateMs"]) // self.t["rateMicro"], MAX_SAFE)

    def _now(self):
        return int(self.now())

    def _owing(self, channel_id):
        if self.owed is None:
            return None
        o = self.owed["read"](str(channel_id).lower())
        return o if isinstance(o, dict) and o else None

    def change(self, channel_id, fn):
        owed = self._owing(channel_id)
        box = {}

        def apply(current):
            rec = self.reap(current if current is not None else Clock.fresh(channel_id), self._now())
            if owed is not None:
                Clock.owe(rec, owed, self._now(), self.t["idleMs"])
            box["out"] = fn(rec)
            return rec

        self.clocks.update(str(channel_id).lower(), apply)
        if owed is not None:
            try:
                self.owed["paid"](str(channel_id).lower(), list(owed))
            except Exception:
                pass
        return box.get("out")

    def seen(self):
        return {"starts": dict(self.starts), "stops": dict(self.stops), "opening": set(self.opening)}

    def running(self, rec, now, seen=None):
        seen = self.seen() if seen is None else seen
        for ident, c in rec.get("calls", {}).items():
            key = (rec["channelId"], ident)
            started = seen["starts"].get(key, now if key in seen["opening"] else None)
            stopped = seen["stops"].get(key)
            ran = now if stopped is None else min(stopped, now)
            if ran > c["deadline"]:
                continue
            if started is not None and started > c["start"]:
                c["start"] = min(started, ran)
            if stopped is not None:
                c["deadline"] = max(c["start"], ran)
        return rec

    def stopped(self, channel_id, ident, at=None):
        with self._seen:
            return self.stops.setdefault((str(channel_id).lower(), ident), self._now() if at is None else at)

    def status(self, channel_id):
        owed = self._owing(channel_id)
        with self._seen:
            now = self._now()
            seen = self.seen()
        stored = self.clocks.get(channel_id) or Clock.fresh(channel_id)
        rec = self.running(self.reap(copy.deepcopy(stored), now), now, seen)
        idle = self.t["idleMs"]
        if owed is not None:
            Clock.owe(rec, owed, now, idle)
        return {"channelId": rec["channelId"], "msRemaining": Clock.remaining(rec, now, idle),
                "msSpent": Clock.spent(rec, now, idle), "msReturned": rec["returnedMs"],
                "metering": rec["on"], "rateUSD": usd(self.t["rateMicro"]), "rateMs": self.t["rateMs"]}

    def credit(self, channel_id, ms, key):
        return self.change(channel_id, lambda rec: Clock.buy(rec, ms, str(key), self._now(), self.t["idleMs"]))

    def uncredit(self, channel_id, ms, key):
        return self.change(channel_id, lambda rec: Clock.unbuy(rec, ms, str(key), self._now(), self.t["idleMs"]))

    def switch(self, channel_id, on):
        def flip(rec):
            now = self._now()
            Clock.switch(rec, on, now, self.t["idleMs"])
            return Clock.left(rec, now, self.t["idleMs"])
        return self.change(channel_id, flip)

    def begin(self, channel_id, ident):
        def start(rec):
            r = Clock.begin(rec, ident, self._now(), self.t["idleMs"], self.t.get("maxCalls"))
            if r["ok"]:
                rec["calls"][ident]["by"] = self.boot
            return r
        self.pulse()
        key = (str(channel_id).lower(), ident)
        with self._seen:
            self.opening.add(key)
        b = {"ok": False}
        try:
            b = self.change(channel_id, start)
        finally:
            with self._seen:
                if b["ok"]:
                    started = self._now()
                    self.starts[key] = started
                self.opening.discard(key)
        if not b["ok"]:
            return b
        self.keep_alive()
        return {**b, "started": started}

    def end(self, channel_id, ident, started=None, stopped=None):
        def stop(rec):
            with self._seen:
                now = self._now()
                seen = self.seen()
            out = Clock.end(rec, ident, now, self.t["idleMs"], started, stopped)
            return {**out, "msRemaining": Clock.left(self.running(copy.deepcopy(rec), now, seen), now, self.t["idleMs"])}
        if stopped is not None:
            self.stopped(channel_id, ident, stopped)
        try:
            return self.change(channel_id, stop)
        finally:
            self.starts.pop((str(channel_id).lower(), ident), None)
            self.stops.pop((str(channel_id).lower(), ident), None)

    def renew(self, channel_id, ident, last=None):
        started = self.starts.get((str(channel_id).lower(), ident))
        def again(rec):
            r = Clock.renew(rec, ident, self._now(), self.t["idleMs"], started, last)
            if r["ok"]:
                rec["calls"][ident]["by"] = self.boot
            return r
        return self.change(channel_id, again)

    def stop(self, channel_id):
        def halt(rec):
            Clock.settle(rec, self._now(), self.t["idleMs"])
            if rec["calls"]:
                return False
            Clock.switch(rec, False, self._now(), self.t["idleMs"])
            return True
        return self.change(channel_id, halt)

    def busy(self, channel_id):
        now = self._now()
        rec = self.clocks.get(channel_id)
        rec = None if rec is None else self.reap(rec, now)
        return rec is not None and any(c["deadline"] > now for c in (rec.get("calls") or {}).values())

    def unburned_micro(self, channel_id):
        owed = self._owing(channel_id)
        rec = self.clocks.get(channel_id)
        if rec is None and owed is None:
            return 0
        rec = self.reap(rec if rec is not None else Clock.fresh(channel_id), self._now())
        if owed is not None:
            Clock.owe(rec, owed, self._now(), self.t["idleMs"])
        return Clock.unburned_micro(rec, self._now(), self.t["idleMs"], self.t["rateMicro"], self.t["rateMs"])

    def _drop(self, h):
        try:
            self.lines.update(h, lambda _c: None)
        except Exception:
            pass

    def forget(self, channel_id):
        box = {"lines": []}

        def wipe(rec):
            box["lines"] = rec["lines"]
            rec["lines"] = []
            return Clock.forget(rec, self._now(), self.t["idleMs"])

        returned = self.change(channel_id, wipe)
        for h in box["lines"]:
            self._drop(h)
        return returned

    def challenge(self, channel_id):
        nonce = secrets.token_hex(16)
        now = self._now()

        def ask(rec):
            live = [(k, until) for k, until in rec["nonces"].items() if until > now][-(KEEP_NONCES - 1):]
            rec["nonces"] = dict(live + [(nonce, now + NONCE_SECS * 1000)])
            return {"nonce": nonce, "message": Clock.line_message(channel_id, nonce), "expiresInSeconds": NONCE_SECS}

        return self.change(channel_id, ask)

    def prove(self, channel, nonce, signature, gate=None):
        if nonce is None or nonce == "":
            return {"ok": False, "status": 400, "code": "bad_request", "why": "nonce is missing: send the nonce the open answer gave, with your signature of its message"}
        if not isinstance(signature, str) or not signature:
            return {"ok": False, "status": 400, "code": "bad_request", "why": "signature is missing or is not a string: sign the message the open answer gave and send it with the nonce"}
        channel_id = str(channel["channelId"]).lower()
        now = self._now()

        def take(rec):
            until = rec["nonces"].pop(str(nonce), None)
            return until is not None and until > now

        if not self.change(channel_id, take):
            return {"ok": False, "status": 400, "code": "no_challenge", "why": 'no live challenge with that nonce. Send {"op":"open","channelId":"0x…"} again and sign what it returns.'}
        try:
            who = Secp256k1.recover_personal(Clock.line_message(channel_id, nonce), str(signature if signature is not None else "")).lower()
        except Exception as e:
            return {"ok": False, "status": 400, "code": "bad_signature", "why": f"the signature does not recover: {str(e)[:80]}"}
        config = channel.get("channelConfig") if isinstance(channel.get("channelConfig"), dict) else {}
        payer = str(config.get("payer") or "").lower()
        auth = str(config.get("payerAuthorizer") or "").lower()
        if who != payer and who != auth:
            return {"ok": False, "status": 403, "code": "not_the_payer", "why": f"{who} is not this channel's payer"}
        credential = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
        h = TimeMeter.hash(credential)

        def attach(refusal=None):
            def keep(rec):
                at = self._now()
                if not rec["lines"]:
                    if refusal is not None:
                        return {"refused": refusal}
                    Clock.switch(rec, True, at, self.t["idleMs"])
                rec["lines"] = rec["lines"] + [h]
                return {"msRemaining": Clock.left(rec, at, self.t["idleMs"]), "metering": bool(rec["on"])}

            return self.change(channel_id, keep)

        opened = attach() if gate is None else gate(attach)
        if "refused" in opened:
            return {"ok": False, "refused": opened["refused"]}
        self.lines.update(h, lambda _c: {"channelId": channel_id, "at": now})
        return {"ok": True, "credential": credential, "channelId": channel_id, "msRemaining": opened["msRemaining"], "metering": opened["metering"]}

    def line(self, credential):
        if not isinstance(credential, str) or credential == "":
            return None
        hit = self.lines.get(TimeMeter.hash(credential))
        return hit.get("channelId") if isinstance(hit, dict) else None

    def close(self, credential):
        h = TimeMeter.hash(credential)
        hit = self.lines.get(h)
        if not hit:
            return None
        self.lines.update(h, lambda _c: None)

        def unlink(rec):
            rec["lines"] = [x for x in rec["lines"] if x != h]

        self.change(hit["channelId"], unlink)
        return hit["channelId"]
