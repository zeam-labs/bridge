import copy
import re

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


def bigger(a, b):
    return n(a) if n(a) >= n(b) else n(b)


class Channels:
    n = staticmethod(n)
    max = staticmethod(bigger)
    REFUNDING_TTL_MS = 180000
    JUDGING_TTL_MS = 30000
    JUDGING_POLL_MS = 20

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

    @staticmethod
    def judging(c, now):
        return c is not None and c.get("refundingJudging") is True and Channels.refunding_wait_ms(c, now) > 0

    @staticmethod
    def weighed(c, now):
        everyone = c.get("refundsJudged") if c is not None else None
        if not isinstance(everyone, dict):
            return {}
        return {k: v for k, v in everyone.items() if to_int(v) > now}

    @staticmethod
    def being_judged(c, now):
        return len(Channels.weighed(c, now)) > 0

    @staticmethod
    def judged_retry_secs(cfg, c, now):
        until = max([0] + [to_int(v) for v in Channels.weighed(c, now).values()])
        return Channels.retry_secs(cfg, until - now if until > now else 0)

    @staticmethod
    def held(c, now, pending=False):
        return Channels.judging(c, now) or (pending and Channels.being_judged(c, now) and Channels.refunding_wait_ms(c, now) == 0)

    @staticmethod
    def unweighed(r, holder, now):
        rest = Channels.weighed(r, now)
        rest.pop(holder, None)
        if rest:
            r["refundsJudged"] = rest
        else:
            r.pop("refundsJudged", None)
        return r

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

    def judged(self, channel_id, pending=False):
        deadline = self.cfg.now_ms() + self.judge_wait_ms()
        while True:
            c = self.get(channel_id)
            now = self.cfg.now_ms()
            if not Channels.held(c, now, pending) or now >= deadline:
                return c
            self.cfg.sleep_ms(Channels.JUDGING_POLL_MS)

    def weigh(self, channel_id, holder):
        deadline = self.cfg.now_ms() + self.judge_wait_ms()
        while True:
            wait = []

            def enter(r):
                if r is None:
                    return r
                now = self.cfg.now_ms()
                weighed = Channels.weighed(r, now)
                if now < deadline and Channels.judging(r, now) and str(r.get("refundingBy")) not in weighed:
                    wait.append(True)
                    return r
                weighed[holder] = now + Channels.JUDGING_TTL_MS
                r["refundsJudged"] = weighed
                return r

            try:
                self.update(channel_id, enter)
            except Exception:
                return False
            if not wait:
                return True
            self.cfg.sleep_ms(Channels.JUDGING_POLL_MS)

    def unweigh(self, channel_id, holder):
        try:
            self.update(channel_id, lambda r: r if r is None else Channels.unweighed(r, holder, self.cfg.now_ms()))
        except Exception:
            pass

    def mark(self, channel_id, holder, refuse_open=True, sending=False):
        while True:
            out = {"ok": True}

            def take(r):
                if r is None:
                    return r
                now = self.cfg.now_ms()
                if Channels.judging(r, now):
                    out.clear()
                    out["wait"] = True
                elif Channels.refunding_wait_ms(r, now) > 0:
                    out.clear()
                    out["settling"] = Channels.refunding_retry_secs(self.cfg, r, now)
                elif not sending and Channels.being_judged(r, now):
                    out.clear()
                    out["judged"] = Channels.judged_retry_secs(self.cfg, r, now)
                elif refuse_open and Channels.pending_live(r, now):
                    out.clear()
                    out["open"] = copy.deepcopy(r)
                    out["at"] = now
                elif sending:
                    r["refundingUntil"] = now + Channels.JUDGING_TTL_MS
                    r["refundingBy"] = holder
                    r["refundingJudging"] = True
                else:
                    r["refundingUntil"] = now + Channels.JUDGING_TTL_MS
                    r["refundingBy"] = holder
                    r["refundingJudging"] = True
                return r

            try:
                self.update(channel_id, take)
            except Exception:
                return {"unavailable": True}
            if out.get("wait") is not True:
                return out
            self.cfg.sleep_ms(Channels.JUDGING_POLL_MS)

    def sending(self, channel_id, holder):
        other = []

        def extend(r):
            if r is None:
                return r
            now = self.cfg.now_ms()
            if r.get("refundingBy") != holder or Channels.refunding_wait_ms(r, now) == 0:
                other.append(Channels.refunding_retry_secs(self.cfg, r, now) if Channels.refunding_wait_ms(r, now) > 0 else None)
                return r
            r["refundingUntil"] = now + Channels.REFUNDING_TTL_MS
            r["refundingBy"] = holder
            r.pop("refundingJudging", None)
            return Channels.unweighed(r, holder, now)

        try:
            self.update(channel_id, extend)
        except Exception:
            return {"unavailable": True}
        if not other:
            return None
        return {"settling": other[-1]} if other[-1] is not None else {"unavailable": True}

    def unmark(self, channel_id, holder):
        def drop(r):
            if r is None:
                return r
            if r.get("refundingBy") == holder:
                r.pop("refundingUntil", None)
                r.pop("refundingBy", None)
                r.pop("refundingJudging", None)
            return Channels.unweighed(r, holder, self.cfg.now_ms())

        try:
            self.update(channel_id, drop)
        except Exception:
            pass

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
            self.update(channel_id, drop)
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
