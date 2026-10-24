import re
import threading
import weakref

from ..php import is_int, php_empty, php_str, to_int
from .config import Config

_DEC = re.compile(r"^\s*-?[0-9]+\s*$")


def n(value):
    if value is None or value == "":
        return 0
    if is_int(value):
        return value
    text = php_str(value)
    if not _DEC.match(text):
        raise ValueError(f"not a decimal integer: {text[:80]}")
    return int(text)


class Gate:
    def __init__(self, ident):
        self.id = ident
        self.lock = threading.Lock()
        self.woke = threading.Condition(threading.Lock())
        self.version = 0
        self.queued = 0
        self.waiting = set()
        self.seq = 0
        self.order = {}
        self.checking = {}
        self.arriving = {}
        self.held = {}
        self.judge = None
        self.reading = None
        self.last_read = None


def bigger(a, b):
    return n(a) if n(a) >= n(b) else n(b)


class Channels:
    n = staticmethod(n)
    max = staticmethod(bigger)
    REFUNDING_TTL_MS = 180000
    JUDGING_TTL_MS = 30000

    @staticmethod
    def refunding_wait_ms(c, now):
        until = 0 if c is None else to_int(c.get("refundingUntil") or 0)
        return until - now if until > now else 0

    @staticmethod
    def refunding_retry_secs(cfg, c, now):
        return Channels.retry_secs(cfg, Channels.refunding_wait_ms(c, now))

    @staticmethod
    def retry_secs(cfg, left):
        look = max(1, to_int(getattr(cfg, "drainWaitMs", Config.DRAIN_WAIT_MS)))
        return max(1, -(-min(left if left > 0 else look, look) // 1000))

    def __init__(self, cfg, store, chain):
        self.cfg = cfg
        self.store = store
        self.chain = chain

    def get(self, channel_id):
        return self.store.get(channel_id.lower())

    def update(self, channel_id, fn):
        return self.store.update(channel_id.lower(), fn)

    def judge_wait_ms(self):
        return max(0, to_int(getattr(self.cfg, "refundJudgeWaitMs", 5000)))

    _GATES = weakref.WeakKeyDictionary()
    _GATES_LOCK = threading.Lock()

    def _gates(self):
        return Channels._GATES.setdefault(self.store, {})

    def gate(self, channel_id):
        ident = php_str(channel_id).lower()
        with Channels._GATES_LOCK:
            g = self._gates().get(ident)
            if g is None:
                g = Gate(ident)
                self._gates()[ident] = g
            return g

    def _enter(self, channel_id):
        ident = php_str(channel_id).lower()
        with Channels._GATES_LOCK:
            g = self._gates().get(ident)
            if g is None:
                g = Gate(ident)
                self._gates()[ident] = g
            g.queued += 1
            return g

    def idle(self, g):
        with Channels._GATES_LOCK:
            if g.queued == 0 and not g.order and not g.checking and not g.arriving and not g.held and g.judge is None and g.reading is None and not g.waiting and self._gates().get(g.id) is g:
                del self._gates()[g.id]

    def serial(self, channel_id, fn):
        g = self._enter(channel_id)
        try:
            with g.lock:
                return fn(g)
        finally:
            with Channels._GATES_LOCK:
                g.queued -= 1
            self.idle(g)

    @staticmethod
    def live(entries, now):
        for k in [k for k, until in entries.items() if until <= now]:
            del entries[k]
        return len(entries)

    TURN_KEPT_MS = 600000
    _TURNS = weakref.WeakKeyDictionary()
    _TURNS_LOCK = threading.Lock()

    def _turn(self, g, now):
        with Channels._TURNS_LOCK:
            turns = Channels._TURNS.setdefault(self.store, {})
            last = turns.pop(g.id, None)
            g.seq = max(g.seq, last[0] if last is not None and now - last[1] < Channels.TURN_KEPT_MS else 0) + 1
            turns[g.id] = (g.seq, now)
            while turns:
                first = next(iter(turns))
                if now - turns[first][1] < Channels.TURN_KEPT_MS:
                    break
                del turns[first]
            return g.seq

    def ticket(self, channel_id, holder):
        def take(g):
            now = self.cfg.now_ms()
            turn = self._turn(g, now)
            g.order[holder] = turn
            g.checking[holder] = now + Channels.JUDGING_TTL_MS
            return turn

        return self.serial(channel_id, take)

    @staticmethod
    def _earlier(g, holder, entries, now):
        mine = g.order.get(holder, float("inf"))
        Channels.live(entries, now)
        return sum(1 for k in entries if k != holder and g.order.get(k, float("inf")) < mine)

    @staticmethod
    def ahead(g, holder, now):
        return Channels._earlier(g, holder, g.checking, now) + Channels._earlier(g, holder, g.arriving, now) > 0

    @staticmethod
    def place(g, holder, now):
        return Channels._earlier(g, holder, g.held, now)

    @staticmethod
    def seat(g, holder, entries, until):
        g.checking.pop(holder, None)
        entries[holder] = until

    @staticmethod
    def judge_of(g, now):
        if g.judge is not None and g.judge["until"] <= now:
            g.judge = None
        return g.judge

    @staticmethod
    def arriving(g, now):
        return Channels.live(g.arriving, now) > 0

    @staticmethod
    def holding(g, now):
        return Channels.live(g.held, now) > 0

    @staticmethod
    def asked(g, now):
        return Channels.arriving(g, now) or Channels.holding(g, now)

    def waiter(self, g):
        token = object()
        with g.woke:
            g.waiting.add(token)
            return {"g": g, "seen": g.version, "token": token}

    def wake(self, g):
        with g.woke:
            g.version += 1
            g.waiting.clear()
            g.woke.notify_all()

    def waited(self, w, deadline):
        g = w["g"]
        try:
            with g.woke:
                while g.version == w["seen"]:
                    left = deadline - self.cfg.now_ms()
                    if left <= 0:
                        break
                    g.woke.wait(min(left, 2147483) / 1000)
        finally:
            with g.woke:
                g.waiting.discard(w["token"])
            self.idle(g)

    def until_answered(self, channel_id, deadline, decide):
        while True:
            def look(g):
                now = self.cfg.now_ms()
                r = self.get(channel_id)
                if Channels.refunding_wait_ms(r, now) > 0:
                    return {"settling": Channels.refunding_retry_secs(self.cfg, r, now), "r": r}
                asked = Channels.asked(g, now)
                if asked and Channels.arriving(g, now) and now < deadline:
                    return {"wait": self.waiter(g)}
                return decide(g, r, now, asked)

            out = self.serial(channel_id, look)
            if not isinstance(out, dict) or "wait" not in out:
                return out
            self.waited(out["wait"], deadline)

    def repaired(self, channel_id):
        channel = self.get(channel_id)
        if channel is None:
            return None
        now = self.cfg.now_ms()
        last = to_int(channel.get("repairedAt", 0))
        if php_empty(channel.get("handedOver")) and now - last < self.cfg.repairEveryMs:
            return channel
        try:
            st = self.chain.channel(channel_id)
        except Exception:
            return channel
        nonce = None
        if not php_empty(channel.get("handedOver")):
            try:
                nonce = self.chain.refund_nonce(channel_id)
            except Exception:
                nonce = None

        def fix(c):
            if c is None:
                return None
            c["repairedAt"] = now
            if not php_empty(c.get("handedOver")):
                if nonce is not None and php_str(nonce) != php_str(c["handedOver"].get("nonce")):
                    del c["handedOver"]
                    c["balance"] = st["balance"]
            elif c.get("balance") is not None and n(st["balance"]) < n(c["balance"]):
                c["balance"] = st["balance"]
            elif (c.get("balance") is not None and n(st["balance"]) > n(c["balance"]) and php_str(c["balance"]) == php_str(channel.get("balance"))
                  and Channels.refunding_wait_ms(c, now) == 0):
                c["balance"] = st["balance"]
            charged = n(c.get("chargedCumulativeAmount", "0"))
            if n(st["totalClaimed"]) > charged:
                c["chargedCumulativeAmount"] = st["totalClaimed"]
                c["totalClaimed"] = st["totalClaimed"]
            return c

        return self.update(channel_id, fix)

    def leaving(self, channel):
        ident = channel["channelId"]
        stamped = to_int(channel.get("withdrawRequestedAt")) > 0
        try:
            w = self.chain.pending_withdrawal(ident)
        except Exception:
            return stamped
        leaving = n(w["amount"]) > 0
        if leaving != stamped:
            now = self.cfg.now_ms()

            def stamp(c):
                if c is None:
                    return None
                c["withdrawRequestedAt"] = now if leaving else 0
                return c

            self.update(ident, stamp)
        return leaving

    def release(self, channel_id, pending_id=None):
        had = [False]

        def drop(c):
            if c is None or "pendingRequest" not in c:
                return c
            pending = c["pendingRequest"] if isinstance(c["pendingRequest"], dict) else {}
            if pending_id is not None and pending.get("pendingId") != pending_id:
                return c
            had[0] = True
            del c["pendingRequest"]
            return c

        try:
            self.serial(channel_id, lambda g: self.update(channel_id, drop))
        except Exception:
            return False
        return had[0]

    @staticmethod
    def pending_live(channel, now=0):
        if channel is None:
            return False
        pending = channel.get("pendingRequest")
        return isinstance(pending, dict) and pending.get("expiresAt") is not None and to_int(pending["expiresAt"]) > now

    @staticmethod
    def claimable(c):
        if php_empty(c.get("signature")) or php_empty(c.get("signedMaxClaimable")):
            return False
        try:
            charged = n(c.get("chargedCumulativeAmount", "0"))
            signed = n(c["signedMaxClaimable"])
            claimed = n(c.get("totalClaimed", "0"))
            balance = n(c.get("balance", "0"))
        except Exception:
            return False
        if charged <= 0 or charged <= claimed or charged > signed or charged > balance:
            return False
        return charged - claimed <= balance - claimed

    @staticmethod
    def earned(cfg, c):
        meter = getattr(cfg, "meter", None)
        config = c.get("channelConfig") if isinstance(c, dict) else None
        if meter is None or not c.get("channelId") or not isinstance(config, dict) or not config.get("token"):
            return c
        micro = meter.unburned_micro(c["channelId"])
        asset = cfg.asset_of(config["token"]) if micro > 0 else None
        if asset is None:
            return c
        try:
            charged = n(c.get("chargedCumulativeAmount", "0"))
            claimed = n(c.get("totalClaimed", "0"))
        except ValueError:
            return c
        net = max(charged - int(cfg.units_of_micro_usd(asset, micro)), claimed)
        return c if net >= charged else {**c, "chargedCumulativeAmount": str(net)}

    @staticmethod
    def refundable(c, live):
        charged = n(c.get("chargedCumulativeAmount", "0"))
        left = n(live["balance"]) - bigger(charged, live["claimed"])
        return str(left) if left > 0 else "0"

    @staticmethod
    def claim_entry(c):
        return {
            "voucher": {"channel": c["channelConfig"], "maxClaimableAmount": php_str(c["signedMaxClaimable"])},
            "signature": c["signature"],
            "totalClaimed": php_str(c["chargedCumulativeAmount"]),
        }
