import contextvars
import json
import re
import threading

from .php import is_int
from .wire import stringify

_PRICE = re.compile(r"([0-9]+)(?:\.([0-9]{1,6}))?")
_MAPPED = re.compile(r"^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$", re.I)
HOUR_MS = 3600000
MAX_SAFE = 9007199254740991
MAX_MICRO = MAX_SAFE
MAX_USD = "9007199254.740991"
NO_PRICE = "bridge: this tool has no price; set price, prices[tool] or free"
BAD_UNITS = "bridge: units is a whole number, 0 or more"
_RUN = contextvars.ContextVar("zeam_bridge_run", default=None)
_HANGUP = contextvars.ContextVar("zeam_bridge_hangup", default=None)


def _whole(n):
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    return n if is_int(n) and 0 <= n <= MAX_SAFE else None


def _count(v):
    try:
        n = int(float(v)) if not isinstance(v, bool) else 0
    except (TypeError, ValueError, OverflowError):
        return 0
    return n if n > 0 else 0


def micro_of(price, what="price"):
    if isinstance(price, bool):
        text = json.dumps(price)
    elif isinstance(price, float):
        text = repr(price)
    elif isinstance(price, int):
        text = str(price)
    else:
        text = ("" if price is None else str(price)).strip()
        text = text[1:] if text.startswith("$") else text
    m = _PRICE.fullmatch(text)
    if not m:
        raise ValueError(f'bridge: {what} is USD with up to six decimals, like "0.02"; got {stringify(price)}')
    micro = int(m.group(1)) * 1000000 + int((m.group(2) or "").ljust(6, "0"))
    if micro < 1 or micro > MAX_MICRO:
        raise ValueError(f"bridge: {what} is from $0.000001 to ${MAX_USD}; above that a number stops counting micro-USD exactly")
    return micro


def exact_usd(micro):
    if not is_int(micro) or micro < 0:
        return None
    d = str(micro).rjust(7, "0")
    return (d[:-6] + "." + d[-6:]).rstrip("0").rstrip(".")


def usd(micro):
    exact = exact_usd(micro)
    if exact is not None:
        return exact
    s = ("%.6f" % (int(micro) / 1e6)).rstrip("0").rstrip(".")
    return "0" if s == "" else s


def _blank(v):
    return v is None or v == ""


def price_of(spec, fallback_micro=None):
    fallback = fallback_micro if is_int(fallback_micro) and fallback_micro >= 1 else None
    if _blank(spec):
        if fallback is None:
            raise ValueError(NO_PRICE)
        return {"micro": fallback, "unitMicro": None}
    if isinstance(spec, dict):
        micro = fallback if _blank(spec.get("price")) else micro_of(spec["price"])
        if micro is None:
            raise ValueError(NO_PRICE)
        if _blank(spec.get("unit")):
            return {"micro": micro, "unitMicro": None}
        unit_micro = micro_of(spec["unit"], "unit")
        if unit_micro > micro:
            raise ValueError("bridge: a unit costs at most the price the call reserves")
        return {"micro": micro, "unitMicro": unit_micro}
    return {"micro": micro_of(spec), "unitMicro": None}


def charge(price, units):
    if price["unitMicro"] is None:
        return price["micro"]
    n = _whole(units)
    if n is None:
        raise ValueError(BAD_UNITS)
    return min(price["micro"], n * price["unitMicro"])


def describe(price, free=False, per_hour=None, varies=False):
    if free:
        return {"usd": "0", "per": "call", "free": True, "perHour": per_hour} if per_hour else {"usd": "0", "per": "call", "free": True}
    if varies:
        return {"per": "call", "varies": True}
    if price["unitMicro"] is not None:
        return {"usd": usd(price["unitMicro"]), "per": "unit", "upTo": usd(price["micro"])}
    return {"usd": usd(price["micro"]), "per": "call"}


def pricing(price):
    if price.get("ms"):
        return f"${usd(price['micro'])} for {price['ms']} ms of line time. Time you do not burn comes back with a refund."
    if price["unitMicro"] is not None:
        return (f"Up to ${usd(price['micro'])} per call, reserved; charged ${usd(price['unitMicro'])} per unit the call reports, "
                "at most the reserve. A failed call is not charged.")
    if price.get("rateMicro"):
        call_ms = min((price["micro"] * price["rateMs"]) // price["rateMicro"], MAX_SAFE)
        per = "ms" if price["rateMs"] == 1 else f"{price['rateMs']} ms"
        return (f"${usd(price['micro'])} per call of up to {call_ms} ms without a line; ${usd(price['rateMicro'])} per {per} on a line. "
                "A failed call without a line is not charged; on a line a call burns the time it runs, failed or not.")
    return f"${usd(price['micro'])} per call. A failed call is not charged."


def units(n):
    box = _RUN.get()
    if box is None:
        raise RuntimeError("bridge: units() reports usage from inside a tool while it runs")
    whole = _whole(n)
    if whole is None:
        raise ValueError(BAD_UNITS)
    box["units"] = whole


def deadline_ms():
    box = _RUN.get()
    if box is None:
        return None
    renew = box.get("renew")
    return box.get("deadline") if renew is None else renew()


def running():
    return _RUN.get()


class Hangup:
    def __init__(self, parent=None):
        self._gone = threading.Event()
        self._turn = threading.Lock()
        self._heard = []
        self._parent = parent
        if parent is not None:
            parent.listen(self.hang_up)

    @property
    def gone(self):
        return self._gone.is_set()

    def hang_up(self):
        with self._turn:
            if self._gone.is_set():
                return
            self._gone.set()
            heard, self._heard = self._heard, []
        for fn in heard:
            fn()

    def listen(self, fn):
        with self._turn:
            if not self._gone.is_set():
                self._heard.append(fn)
                return
        fn()

    def unlisten(self, fn):
        with self._turn:
            if fn in self._heard:
                self._heard.remove(fn)

    def leave(self):
        if self._parent is not None:
            self._parent.unlisten(self.hang_up)

    def wait(self, seconds=0):
        return self._gone.wait(seconds if seconds and seconds > 0 else 0)


def caller():
    return _HANGUP.get()


def hearing(found):
    return _HANGUP.set(found)


def unhearing(token):
    _HANGUP.reset(token)


def stopped(wait=0):
    found = _HANGUP.get()
    if found is None:
        if wait and wait > 0:
            threading.Event().wait(wait)
        return False
    return found.wait(wait)


def metered(fn, **extra):
    box = {"units": None, "deadline": None, "channelId": None, **extra}
    token = _RUN.set(box)
    try:
        return fn(), box["units"]
    finally:
        _RUN.reset(token)


class FreeLimit:
    def __init__(self, per_hour, now):
        self.per_hour = per_hour
        self.now = now
        self.counts = {}
        self.lock = threading.Lock()

    @staticmethod
    def window(now):
        return now // HOUR_MS

    @staticmethod
    def caller_key(who):
        s = "" if who is None else str(who)
        if s == "" or ":" not in s:
            return s
        z = s.split("%")[0]
        mapped = _MAPPED.match(z)
        if mapped:
            return mapped.group(1)
        dbl = z.split("::")
        head = dbl[0].split(":") if dbl[0] else []
        tail = dbl[1].split(":") if len(dbl) > 1 and dbl[1] else []
        fill = max(0, 8 - len(head) - len(tail))
        groups = (head + ["0"] * fill + tail)[:8]
        norm = ["0" if g == "" else re.sub(r"^0+(?=.)", "", g.lower()) for g in groups]
        return ":".join(norm[:4]) + "::/64"

    def take(self, tool, who):
        if not (is_int(self.per_hour) and self.per_hour >= 1):
            return {"ok": True}
        now = int(self.now())
        w = FreeLimit.window(now)
        key = (w, tool, FreeLimit.caller_key(who))
        with self.lock:
            used = self.counts.get(key, 0)
            if used >= self.per_hour:
                return {"ok": False, "retryAfter": max(1, -((now - (w + 1) * HOUR_MS) // 1000))}
            self.counts[key] = used + 1
            if len(self.counts) > 20000:
                for k in [k for k in self.counts if k[0] != w]:
                    del self.counts[k]
        return {"ok": True}

    def take_saved(self, file, tool, who):
        if not (is_int(self.per_hour) and self.per_hour >= 1):
            return {"ok": True}
        try:
            box = {}

            def apply(cur):
                w = FreeLimit.window(int(self.now()))
                saved = cur["counts"] if isinstance(cur, dict) and cur.get("window") == w and isinstance(cur.get("counts"), dict) else {}
                with self.lock:
                    self.counts = {(w, *str(k).split("\n", 1)): _count(v) for k, v in saved.items() if "\n" in str(k)}
                box["out"] = self.take(tool, who)
                with self.lock:
                    counts = {f"{k[1]}\n{k[2]}": v for k, v in self.counts.items() if k[0] == w}
                return {"window": w, "counts": counts}

            file.update(apply)
            return box["out"]
        except Exception:
            return self.take(tool, who)

    @staticmethod
    def refusal(per_hour, retry_after):
        return {"error": "free_limit", "message": f"{per_hour} free calls an hour per address. Retry in {retry_after}s.",
                "retry_after_seconds": retry_after}
