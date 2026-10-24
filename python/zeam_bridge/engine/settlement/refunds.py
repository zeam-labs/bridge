import copy
import json
import math
import re
import secrets
import threading

from ..batch_settlement import BatchSettlement
from ..core import Address, Hex, Secp256k1
from ..messages import BridgeMessages
from ..php import php_empty, php_round, php_str, time_ms, to_int
from ..pricing import exact_usd
from .channels import Channels, n
from .chain import Chain
from .gas_quote import GasQuote
from .relay import Relay
from .verify import Verify
from ..discovery import percent, refund_rule


_DIGITS = re.compile(r"[0-9]+")


def _cut(text, length):
    return text.encode("utf-8")[:length].decode("utf-8", "ignore")


class Refunds:
    FUTURE_SKEW_MS = 30000

    def __init__(self, cfg, store, chain=None, relay=None):
        self.cfg = cfg
        self.store = store
        self.chain = chain or Chain(cfg.rpcUrl)
        self.relay = relay or Relay(cfg.relayUrl)
        self.gas = GasQuote(cfg, self.chain, self.relay)
        self.channels = Channels(cfg, store, self.chain)

    @staticmethod
    def message(channel_id, issued):
        return BridgeMessages.REALM + " refund\nchannel: " + php_str(channel_id).lower() + "\nissued: " + php_str(issued)

    @staticmethod
    def _answer(status, body):
        return {"status": status, "body": body}

    @staticmethod
    def _failed(status, code, why, more=None):
        return Refunds._answer(status, {"op": "refund_failed", "code": code, "why": why, **(more or {})})

    def proof_owner(self, channel_id, issued, signature):
        if issued is None or (isinstance(issued, str) and issued.strip() == ""):
            return {"ok": False, "why": "issued is missing: send the ISO 8601 time you signed, as a string"}
        t = time_ms(issued.strip()) if isinstance(issued, str) else None
        if t is None:
            return {"ok": False, "why": "issued is not a timestamp"}
        now = self.cfg.now_ms()
        window = 1000 * int(self.cfg.refundWindowSecs)
        if now - t > window or t - now > self.FUTURE_SKEW_MS:
            return {"ok": False, "why": f"issued {issued} is outside the {int(self.cfg.refundWindowSecs)}s window"}
        if not isinstance(signature, str) or re.fullmatch(r"(0x)?[0-9a-fA-F]{130}", signature) is None:
            return {"ok": False, "why": "signature is missing or is not 65 bytes of hex"}
        try:
            who = Secp256k1.recover_personal(Refunds.message(channel_id, issued), signature)
        except Exception:
            return {"ok": False, "why": "signature does not recover to an address"}
        return {"ok": True, "address": who.lower()}

    @staticmethod
    def owns(channel, address):
        who = php_str(address).lower()
        if who == "":
            return False
        config = channel.get("channelConfig") if isinstance(channel.get("channelConfig"), dict) else {}
        payer = php_str(config.get("payer")).lower()
        auth = php_str(config.get("payerAuthorizer")).lower()
        return who == payer or (auth != "" and who == auth)

    def handle(self, channel_id, issued, signature, ask=None):
        cid = php_str(channel_id).lower()
        if not Verify.is_canonical_channel_id(cid):
            return Refunds._failed(400, "invalid_request", "channelId is missing or is not 0x and 64 hex characters: send {channelId, issued, signature}")
        holder = "0x" + secrets.token_hex(16)
        turn = self.channels.ticket(cid, holder)
        try:
            return {**self._checked(cid, issued, signature, ask, holder), "turn": turn}
        finally:
            self.channels.serial(cid, lambda g: self._left(g, holder))

    def _checked(self, cid, issued, signature, ask, holder):
        ch = self.channels.get(cid)
        sent = (ask or {}).get("channelConfig")
        own = None if sent is None else self._own_config(cid, sent)
        if own is not None and own.get("mismatch") is not None:
            return Refunds._failed(400, "channel_config_mismatch", own["why"], {"mismatch": own["mismatch"]})
        config = own.get("config") if own is not None else None
        if ch is None and config is None:
            return Refunds._failed(404, "unknown_channel", "no channel with that id here. For a channel with no calls here, send its channelConfig with the proof.")
        proof = self.proof_owner(cid, issued, signature)
        if not proof["ok"]:
            return Refunds._failed(400, "proof_invalid", proof["why"], {"sign": Refunds.message(cid, "<ISO8601 within five minutes>")})
        if not Refunds.owns(ch if ch is not None else {"channelConfig": config}, proof["address"]):
            return Refunds._failed(403, "not_the_payer", proof["address"] + " is not this channel's payer")
        if ch is None:
            adopted = self._adopt(cid, config)
            if adopted.get("failed") is not None:
                return adopted["failed"]
            ch = adopted["channel"]
        return self._worked(cid, ch, ask or {}, holder)

    WORKERS = 4
    BUSY_RETRY_SECS = 1
    TURN_LOOK_MS = 1000
    READ_SHARED_MS = 100
    JUDGE_TRIES = 3

    def _worked(self, ident, ch, ask, holder):
        key = Refunds.ask_key(ask)
        deadline = self.cfg.now_ms() + self.channels.judge_wait_ms()
        try:
            while True:
                step = self.channels.serial(ident, lambda g: self._arrive(g, ident, ch, key, holder, deadline))
                if "wait" in step:
                    self.channels.waited(step["wait"], deadline)
                    continue
                if "read" in step:
                    live = self._read(ident, step["read"], step.get("own"))
                    step = self.channels.serial(ident, lambda g: self._arrived(g, ident, ch, holder, live, step["read"]))
                answer = step.get("answer")
                if answer is not None and answer["body"].get("code") == "nothing_to_return" and not php_empty((self.channels.get(ident) or {}).get("handedOver")):
                    self.channels.repaired(ident)
                if answer is not None:
                    return self._told(ch, step)
                break
            return self._turns(ident, ch, ask, key, holder, deadline)
        finally:
            self.channels.serial(ident, lambda g: self._left(g, holder))

    def _read(self, ident, read, own):
        if own:
            try:
                read["live"] = self.chain.live(ident)
            except Exception:
                read["live"] = None
            read["done"].set()
        else:
            read["done"].wait()
        return read["live"]

    def _arrive(self, g, ident, ch, key, holder, deadline):
        now = self.cfg.now_ms()
        r = self.channels.get(ident)
        if Channels.refunding_wait_ms(r, now) > 0:
            return {"answer": Refunds._settling(Channels.refunding_retry_secs(self.cfg, r, now)), "settling": Channels.live(g.held, now) + Channels.live(g.arriving, now) < Refunds.WORKERS}
        if Channels.pending_live(r, now):
            return {"answer": Refunds._call_open(r, now)}
        meter = getattr(self.cfg, "meter", None)
        if meter is not None and meter.busy(ident):
            return {"answer": Refunds._line_busy()}
        if Channels.holding(g, now):
            Channels.seat(g, holder, g.held, now + Channels.JUDGING_TTL_MS)
            return {"joined": True}
        if not Channels.arriving(g, now) and not Channels.ahead(g, holder, now):
            kept = Refunds._kept(r, key, now, self._line_of(ident))
            if kept is not None:
                return {"answer": kept}
        seen = g.last_read
        if seen is not None and 0 <= now - seen["at"] < Refunds.READ_SHARED_MS:
            return self._arrived(g, ident, ch, holder, seen["live"], None)
        if Channels._earlier(g, holder, g.arriving, now) >= Refunds.WORKERS:
            return {"answer": Refunds._busy()} if now >= deadline else {"wait": self.channels.waiter(g)}
        Channels.seat(g, holder, g.arriving, now + Channels.JUDGING_TTL_MS)
        own = g.reading is None
        if own:
            g.reading = {"readers": 0, "done": threading.Event(), "live": None}
        g.reading["readers"] += 1
        return {"read": g.reading, "own": own}

    def _arrived(self, g, ident, ch, holder, live, read):
        now = self.cfg.now_ms()
        g.arriving.pop(holder, None)
        if read is not None:
            read["readers"] -= 1
            if g.reading is read:
                g.reading = None
        try:
            r = self.channels.get(ident)
            if Channels.refunding_wait_ms(r, now) > 0:
                return {"answer": Refunds._settling(Channels.refunding_retry_secs(self.cfg, r, now)), "settling": Channels.live(g.held, now) < Refunds.WORKERS}
            if not Channels.holding(g, now):
                if live is None:
                    return {"answer": Refunds._failed(409, "chain_unreadable", "could not read the channel on chain", {"retry_after_seconds": Refunds.RETRY_SECS})}
                g.last_read = {"at": now, "live": live}
                raw = r if r is not None else ch
                if n(Channels.refundable(Channels.earned(self.cfg, raw), live)) <= 0:
                    return {"answer": Refunds._nothing()}
                if Channels.pending_live(r, now):
                    return {"answer": Refunds._call_open(r, now)}
                meter = getattr(self.cfg, "meter", None)
                if meter is not None and not meter.stop(ident):
                    return {"answer": Refunds._line_busy()}
            Channels.seat(g, holder, g.held, now + Channels.JUDGING_TTL_MS)
            return {"joined": True}
        finally:
            self.channels.wake(g)

    def _turns(self, ident, ch, ask, key, holder, deadline):
        tries = 1
        while True:
            step = self.channels.serial(ident, lambda g: self._turn(g, ident, key, holder, deadline))
            if "answer" in step:
                return self._told(ch, step)
            if "wait" in step:
                self.channels.waited(step["wait"], step["until"])
                continue
            judged = self._judge(ch, ask)
            decided = self.channels.serial(ident, lambda g: self._decide(g, ident, key, holder, judged, tries))
            if decided.get("again"):
                tries += 1
                continue
            if "answer" in decided:
                return decided["answer"]
            try:
                return self._send(decided["plan"])
            finally:
                self.channels.serial(ident, lambda g: self._unsend(g, ident, holder))

    def _turn(self, g, ident, key, holder, deadline):
        now = self.cfg.now_ms()
        r = self.channels.get(ident)
        if Channels.refunding_wait_ms(r, now) > 0:
            return {"answer": Refunds._settling(Channels.refunding_retry_secs(self.cfg, r, now)), "settling": list(g.held).index(holder) < Refunds.WORKERS if holder in g.held else True}
        judge = Channels.judge_of(g, now)
        if judge is not None and judge["holder"] == holder:
            judge["until"] = now + Channels.JUDGING_TTL_MS
            return {"judge": True}
        Channels.seat(g, holder, g.held, now + Channels.JUDGING_TTL_MS)
        place = Channels.place(g, holder, now)
        slot = place
        if judge is None and place == 0 and not Channels.ahead(g, holder, now):
            if Channels.pending_live(r, now):
                return {"answer": Refunds._call_open(r, now)}
            kept = Refunds._kept(r, key, now, self._line_of(ident))
            if kept is not None:
                return {"answer": kept}
            g.judge = {"holder": holder, "until": now + Channels.JUDGING_TTL_MS}
            return {"judge": True}
        if slot >= Refunds.WORKERS and now >= deadline:
            return {"answer": Refunds._call_open(r, now) if Channels.pending_live(r, now) else Refunds._busy()}
        until = now + Refunds.TURN_LOOK_MS
        if slot >= Refunds.WORKERS:
            until = min(until, deadline)
        return {"wait": self.channels.waiter(g), "until": until}

    def _decide(self, g, ident, key, holder, judged, tries):
        now = self.cfg.now_ms()
        r = self.channels.get(ident)
        moved = r is not None and Refunds.state_of(r) != judged["state"]
        if "answer" in judged:
            if moved and tries < Refunds.JUDGE_TRIES and not Channels.pending_live(r, now):
                return {"again": True}
            answer = Refunds._call_open(r, now) if Channels.pending_live(r, now) else judged["answer"]
            self._done(g, holder)
            return {"answer": self._keep(ident, key, judged["state"], judged["line"], answer)}
        if not self._unchanged(ident, judged):
            if tries < Refunds.JUDGE_TRIES and not Channels.pending_live(r, now):
                return {"again": True}
            self._done(g, holder)
            return {"answer": Refunds._call_open(r, now) if Channels.pending_live(r, now) else Refunds._unheld()}

        def mark(c):
            if c is None:
                return c
            c["refundingUntil"] = now + Channels.REFUNDING_TTL_MS
            c["refundingBy"] = holder
            return c

        try:
            self.channels.update(ident, mark)
        except Exception:
            self._done(g, holder)
            return {"answer": Refunds._unheld()}
        self._done(g, holder)
        return {"plan": judged}

    def _done(self, g, holder):
        if g.judge is not None and g.judge["holder"] == holder:
            g.judge = None
        g.held.pop(holder, None)
        self.channels.wake(g)

    def _left(self, g, holder):
        g.checking.pop(holder, None)
        g.order.pop(holder, None)
        g.arriving.pop(holder, None)
        self._done(g, holder)

    def _unsend(self, g, ident, holder):
        def drop(r):
            if r is None or r.get("refundingBy") != holder:
                return r
            r.pop("refundingUntil", None)
            r.pop("refundingBy", None)
            return r

        try:
            self.channels.update(ident, drop)
        except Exception:
            pass
        self.channels.wake(g)

    def _told(self, ch, step):
        if step.get("settling") is True:
            return self._emptied(ch) or step["answer"]
        return step["answer"]

    @staticmethod
    def _busy():
        return Refunds._failed(503, "refund_unavailable", f"refund requests on this channel are already being worked out. Nothing was sent for this one. Retry in {Refunds.BUSY_RETRY_SECS}s.", {"retry_after_seconds": Refunds.BUSY_RETRY_SECS})

    SHARED = ("nothing_to_return", "gas_payment_needed", "request_open")
    VERDICT_MS = 5000

    @staticmethod
    def verdict_of(r):
        v = r.get("refundVerdict") if isinstance(r, dict) else None
        v = v if isinstance(v, dict) else {}
        at = v.get("at") if isinstance(v.get("at"), int) and not isinstance(v.get("at"), bool) else 0
        return {"key": v.get("key") if isinstance(v.get("key"), str) else None,
                "state": v.get("state") if isinstance(v.get("state"), str) else None,
                "line": v.get("line") if isinstance(v.get("line"), str) else None,
                "at": at, "answer": v.get("answer") if isinstance(v.get("answer"), dict) else None}

    @staticmethod
    def state_of(r):
        r = r if isinstance(r, dict) else {}

        def at(v):
            return None if v is None else php_str(v)
        pending = r.get("pendingRequest") if isinstance(r.get("pendingRequest"), dict) else {}
        handed = r.get("handedOver") if isinstance(r.get("handedOver"), dict) else {}
        return json.dumps([at(r.get("chargedCumulativeAmount")), at(r.get("balance")), at(r.get("totalClaimed")),
                           at(r.get("signedMaxClaimable")), at(r.get("refundNonce")), at(pending.get("expiresAt")),
                           at(handed.get("nonce")), at(r.get("withdrawRequestedAt"))], separators=(",", ":"))

    @staticmethod
    def ask_key(ask):
        return json.dumps([(ask or {}).get("selfSend") is True, (ask or {}).get("gasPayment")], sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _kept(r, key, now, line):
        v = Refunds.verdict_of(r)
        if v["answer"] is None or v["key"] != key or v["state"] != Refunds.state_of(r) or v["line"] != line:
            return None
        return v["answer"] if 0 <= now - v["at"] < Refunds.VERDICT_MS else None

    def _keep(self, ident, key, state, line, answer):
        shared = ((answer or {}).get("body") or {}).get("code") in Refunds.SHARED
        try:
            still = shared and self._line_of(ident) == line
        except Exception:
            still = False

        def keep(r):
            if r is None:
                return None
            if still and Refunds.state_of(r) == state:
                r["refundVerdict"] = {"key": key, "state": state, "line": line, "at": self.cfg.now_ms(), "answer": answer}
            else:
                r.pop("refundVerdict", None)
            return r

        try:
            self.store.update(ident, keep)
        except Exception:
            pass
        return answer

    def _line_of(self, ident):
        meter = getattr(self.cfg, "meter", None)
        if meter is None:
            return None
        s = meter.status(ident)
        return json.dumps([s.get("metering") is True, s.get("msRemaining"), bool(meter.busy(ident))], separators=(",", ":"))

    def _unchanged(self, ident, judged):
        raw = self.channels.get(ident)
        if raw is None or Refunds.state_of(raw) != judged["state"]:
            return False
        now = Channels.earned(self.cfg, raw)
        return Channels.refundable(now, judged["live"]) == judged["left"] and not Channels.pending_live(raw, self.cfg.now_ms())

    @staticmethod
    def _line_busy():
        return Refunds._failed(409, "request_open", f"a call is running on this channel's line. Retry in {Refunds.OPEN_RETRY_SECS}s.", {"retry_after_seconds": Refunds.OPEN_RETRY_SECS})

    def _emptied(self, ch):
        ident = ch["channelId"].lower()
        raw = self.channels.get(ident) or ch
        try:
            live = self.chain.live(ident)
        except Exception:
            return None
        return Refunds._nothing() if n(Channels.refundable(Channels.earned(self.cfg, raw), live)) <= 0 else None

    @staticmethod
    def _nothing():
        return Refunds._failed(409, "nothing_to_return", "nothing to return: the channel holds nothing",
                               {"leftMicroUSD": 0, "returnedMicroUSD": 0, "gasMicroUSD": 0})

    @staticmethod
    def _call_open(ch, now):
        wait = min(Refunds.OPEN_RETRY_SECS, int(math.ceil((to_int(ch["pendingRequest"]["expiresAt"]) - now) / 1000)))
        return Refunds._failed(409, "request_open", f"a paid call is open on this channel. Retry in {wait}s.", {"retry_after_seconds": wait})

    @staticmethod
    def _unheld():
        return Refunds._failed(503, "refund_unavailable", f"the channel could not be held for the refund right now. Nothing was sent. Retry in {Refunds.OPEN_RETRY_SECS}s.", {"retry_after_seconds": Refunds.OPEN_RETRY_SECS})

    @staticmethod
    def _settling(secs):
        return Refunds._failed(409, "refund_settling", f"a refund is already settling on this channel. Nothing more was sent. Retry in {secs}s.", {"retry_after_seconds": secs})

    def _own_config(self, cid, config):
        fields = {"mismatch": "fields", "why": "channelConfig needs payer, payerAuthorizer, receiver, receiverAuthorizer, token, withdrawDelay and salt, as deposited"}
        if not isinstance(config, dict):
            return fields
        try:
            computed = Verify.compute_channel_id(config, self.cfg.network).lower()
        except Exception:
            return fields
        if computed != cid:
            return {"mismatch": "channelId", "why": "channelConfig hashes to " + computed + ", not to channelId " + cid}
        if not Address.equals(config.get("receiver"), self.cfg.receiver):
            return {"mismatch": "receiver", "why": "channelConfig receiver is " + php_str(config.get("receiver")).lower() + "; this seller's is " + php_str(self.cfg.receiver).lower()}
        if not Address.equals(config.get("receiverAuthorizer"), self.cfg.receiverAuthorizer):
            return {"mismatch": "receiverAuthorizer", "why": "channelConfig receiverAuthorizer is " + php_str(config.get("receiverAuthorizer")).lower() + "; this seller's is " + php_str(self.cfg.receiverAuthorizer).lower()}
        if self.cfg.asset_of(config.get("token")) is None:
            return {"mismatch": "token", "why": "channelConfig token " + php_str(config.get("token")).lower() + " is not accepted here"}
        return {"config": config}

    def _adopt(self, cid, config):
        try:
            st = self.chain.channel(cid)
        except Exception:
            return {"failed": Refunds._failed(409, "chain_unreadable", "could not read the channel on chain", {"retry_after_seconds": Refunds.RETRY_SECS})}
        if n(st["balance"]) <= 0:
            return {"failed": Refunds._failed(400, "channel_config_mismatch", "channelConfig names this seller, but that channel holds no balance on chain: its escrow balance is 0", {"mismatch": "balance"})}
        now = self.cfg.now_ms()

        def adopt(r):
            if r is not None:
                return r
            return {
                "channelId": cid,
                "channelConfig": config,
                "chargedCumulativeAmount": php_str(st["totalClaimed"]),
                "balance": php_str(st["balance"]),
                "totalClaimed": php_str(st["totalClaimed"]),
                "withdrawRequestedAt": 0,
                "refundNonce": 0,
                "onchainSyncedAt": now,
                "lastRequestTimestamp": 0,
                "adoptedAt": now,
            }

        return {"channel": self.channels.update(cid, adopt)}

    AUTHORIZATION_FIELDS = ("from", "to", "value", "validAfter", "validBefore", "nonce")
    GAS_PAYMENT_MARGIN_SECS = 30
    RETRY_SECS = 60
    OPEN_RETRY_SECS = 5

    @staticmethod
    def ask(body):
        b = body if isinstance(body, dict) else {}

        def scalar(x):
            return php_str(x) if isinstance(x, (str, int)) and not isinstance(x, bool) else None

        p = b.get("gasPayment") if isinstance(b.get("gasPayment"), dict) else None
        a = p.get("authorization") if p is not None and isinstance(p.get("authorization"), dict) else None
        config = b.get("channelConfig")
        return {
            "selfSend": b.get("selfSend") is True or b.get("selfSend") == "true",
            "channelConfig": dict(config) if isinstance(config, dict) else config,
            "gasPayment": None if p is None else {
                "authorization": None if a is None else {k: scalar(a.get(k)) for k in Refunds.AUTHORIZATION_FIELDS},
                "signature": scalar(p.get("signature")),
            },
        }

    def _micro_usd(self, ch, units):
        return self.cfg.micro_usd_of(ch["channelConfig"]["token"], units)

    @staticmethod
    def usd(micro_usd):
        exact = exact_usd(micro_usd)
        if exact is not None:
            return exact
        s = ("%.6f" % (micro_usd / 1e6)).rstrip("0").rstrip(".")
        return "0" if s == "" else s

    def _judge(self, incoming, ask):
        ask = ask or {}
        ident = incoming["channelId"].lower()
        raw = self.channels.repaired(ident) or incoming
        state = Refunds.state_of(raw)
        line = self._line_of(ident)

        def refused(answer):
            return {"state": state, "line": line, "answer": answer}

        ch = Channels.earned(self.cfg, raw)
        try:
            live = self.chain.live(ident)
        except Exception:
            return refused(Refunds._failed(409, "chain_unreadable", "could not read the channel on chain", {"retry_after_seconds": Refunds.RETRY_SECS}))
        left = Channels.refundable(ch, live)
        if n(left) <= 0:
            return refused(Refunds._nothing())
        now = self.cfg.now_ms()
        if Channels.pending_live(ch, now):
            return refused(Refunds._call_open(ch, now))
        f = self._frozen(raw, live, ch, left)
        line = f.get("line", line)
        if "failed" in f:
            return refused(f["failed"])
        ch, left = f["ch"], f["left"]
        try:
            nonce = self.chain.refund_nonce(ident)
        except Exception:
            return refused(Refunds._failed(409, "chain_unreadable", "could not read the refund nonce on chain", {"retry_after_seconds": Refunds.RETRY_SECS}))
        plan = {"state": state, "line": line, "live": live, "ch": ch, "left": left, "nonce": nonce}
        if ask.get("selfSend") is True:
            return {**plan, "self": True}
        left_micro_usd = self._micro_usd(ch, left)
        try:
            call = self.refund_call(ch, live, left, nonce)
        except Exception as e:
            return refused(Refunds._failed(409, "refund_error", _cut(str(e), 160), {"retry_after_seconds": Refunds.RETRY_SECS, "leftMicroUSD": left_micro_usd}))
        gas = self.refund_gas(ch, live, call)
        if gas is None:
            return refused(Refunds._failed(503, "gas_unpriced", "refund gas cannot be priced. Retry in 60s, or send "
                                           + Refunds.SELF_SEND + " for a signed refund to send yourself.",
                                           {"retry_after_seconds": Refunds.RETRY_SECS, "leftMicroUSD": left_micro_usd}))
        amounts = {"leftMicroUSD": left_micro_usd, "returnedMicroUSD": left_micro_usd, "gasMicroUSD": gas["gasMicroUSD"],
                   "feeMicroUSD": gas["feeMicroUSD"], "coverMicroUSD": gas["coverMicroUSD"]}
        payment = None
        if not gas["covered"]:
            asset = self.cfg.asset_of(ch["channelConfig"]["token"])
            rule = Refunds.rule(self.cfg, gas)
            if asset is None or not asset.get("eip3009"):
                return refused(Refunds._failed(409, "nothing_to_return", rule + "; this token has no gasless payment for the $"
                                       + Refunds.usd(gas["gasMicroUSD"]) + " refund gas. " + Refunds.SELF, {**amounts, "returnedMicroUSD": 0, **gas["detail"]}))
            if gas["gasMicroUSD"] >= left_micro_usd:
                return refused(Refunds._failed(409, "nothing_to_return", rule + "; refund gas $" + Refunds.usd(gas["gasMicroUSD"])
                                       + " >= balance $" + Refunds.usd(left_micro_usd) + ". " + Refunds.SELF,
                                       {**amounts, "returnedMicroUSD": 0, **gas["detail"]}))
            pay_to = self.gas.gas_wallet()
            if pay_to is None:
                return refused(Refunds._failed(503, "gas_unpriced", "the relay is unreachable. Retry in 60s, or send "
                                       + Refunds.SELF_SEND + " for a signed refund to send yourself.",
                                       {"retry_after_seconds": Refunds.RETRY_SECS, "leftMicroUSD": left_micro_usd}))
            units = self.cfg.units_of_micro_usd(asset, gas["gasMicroUSD"])
            offered = ask.get("gasPayment")
            if offered is None:
                return refused(self._gas_quote(ch, asset, pay_to, units, amounts, gas, None))
            bad = self.gas_payment_problem(ch, asset, pay_to, self.cfg.units_of_micro_usd(asset, gas["costMicroUSD"]), left, offered)
            if bad is not None:
                return refused(self._gas_quote(ch, asset, pay_to, units, amounts, gas, bad, {"requoted": True, "sendCostMicroUSD": gas["costMicroUSD"]} if "sending costs" in bad else None))
            payment = {"asset": asset, "payTo": pay_to, "authorization": offered["authorization"], "signature": offered["signature"]}
        return {**plan, "call": call, "gas": gas, "amounts": amounts, "payment": payment}

    def _send(self, plan):
        ch, live, left = plan["ch"], plan["live"], plan["left"]
        if plan.get("self"):
            return self._self_send(ch, live, left, plan["nonce"])
        call, gas, amounts, payment = plan["call"], plan["gas"], plan["amounts"], plan["payment"]
        if payment is None:
            return self._send_refund_now(ch, call, left, 0, amounts, gas["freeGasUnits"])
        pay = {"to": payment["asset"]["address"], "data": BatchSettlement.encode_transfer_with_authorization(payment["authorization"], payment["signature"])}
        bundle = {"to": BatchSettlement.MULTICALL3, "data": BatchSettlement.encode_aggregate3([call, pay])}
        out = self._send_refund_now(ch, bundle, left, self._micro_usd(ch, payment["authorization"]["value"]), amounts)
        return out if "underpaid" not in out else self._requote(ch, live, payment, amounts, gas, out["underpaid"], call)

    def _frozen(self, raw, live, ch, left):
        meter = getattr(self.cfg, "meter", None)
        if meter is None:
            return {"ch": ch, "left": left}
        if not meter.stop(ch["channelId"]):
            return {"failed": Refunds._line_busy()}
        line = self._line_of(ch["channelId"].lower())
        now = Channels.earned(self.cfg, raw)
        rest = Channels.refundable(now, live)
        if n(rest) <= 0:
            return {"line": line, "failed": Refunds._nothing()}
        return {"line": line, "ch": now, "left": rest}

    def _requote(self, ch, live, payment, amounts, gas, send_cost, call):
        fresh = self.refund_gas(ch, live, call) or gas
        quoted = max(0 if fresh["covered"] else fresh["gasMicroUSD"], int(math.ceil(send_cost * self.cfg.gasBuffer)))
        numbers = {**amounts, "gasMicroUSD": quoted, "feeMicroUSD": fresh["feeMicroUSD"], "coverMicroUSD": fresh["coverMicroUSD"], "sendCostMicroUSD": send_cost}
        paying = self._micro_usd(ch, payment["authorization"]["value"])
        if fresh["covered"] or paying >= fresh["gasMicroUSD"]:
            moved = ("refund gas rose past the quote margin: sending costs $" + Refunds.usd(send_cost)
                     + ", your payment is $" + Refunds.usd(paying) + ". Nothing was sent")
        else:
            moved = ("your payment, $" + Refunds.usd(paying) + ", is under the quote, $" + Refunds.usd(fresh["gasMicroUSD"])
                     + ", and under what sending costs, $" + Refunds.usd(send_cost) + ". Nothing was sent")
        if quoted >= amounts["leftMicroUSD"]:
            return Refunds._failed(409, "nothing_to_return", moved + "; refund gas $" + Refunds.usd(quoted) + " (margin included) >= balance $"
                                   + Refunds.usd(amounts["leftMicroUSD"]) + ". " + Refunds.SELF,
                                   {**numbers, "returnedMicroUSD": 0, **fresh["detail"]})
        units = self.cfg.units_of_micro_usd(payment["asset"], quoted)
        return self._gas_quote(ch, payment["asset"], payment["payTo"], units, numbers, fresh,
                               moved + ". New quote: that cost + " + php_str(fresh["detail"]["marginPercent"]) + "% margin",
                               {"requoted": True, "sendCostMicroUSD": send_cost})

    SELF_SEND = '{"selfSend": true}'
    SELF = "Send " + SELF_SEND + " for a signed refund of the full balance, sent from any wallet at your own gas."

    def _self_send(self, ch, live, left, nonce):
        handed = ch.get("handedOver") if isinstance(ch.get("handedOver"), dict) else {}
        if not php_empty(handed.get("transaction")) and php_str(handed.get("nonce")) == php_str(nonce):
            return Refunds._answer(200, {
                "op": "refund_signed",
                "microUSD": self._micro_usd(ch, handed["units"] if handed.get("units") is not None else "0"),
                "transaction": handed["transaction"],
                "why": "your signed refund is unsent; here it is again",
            })
        try:
            call = self.refund_call(ch, live, left, nonce)
        except Exception as e:
            return Refunds._failed(409, "refund_error", _cut(str(e), 160), {"retry_after_seconds": Refunds.RETRY_SECS})
        return self._hand_over(ch, live, call, left, nonce)

    def refund_gas(self, ch, live, call=None):
        bundled = Refunds.bundled_claim(ch, live)
        already_paid = Refunds.gas_counted(ch, self.cfg.gas, self.gas.relay_paid(ch["channelId"]))
        q = self.gas.refund(bundled > 0, True, already_paid)
        if q is None:
            return None
        counted = {"alreadyPaid": already_paid, "freeGasUnits": self.cfg.gas["refund"] + (self.cfg.gas["refundClaim"] if bundled > 0 else 0)}
        earned = self._micro_usd(ch, str(n(live["claimed"]) + bundled))
        fee_micro_usd = GasQuote.fee_micro_usd(earned, self.cfg.feeShare)

        def detail_of(p):
            return {k: p[k] for k in ("gasUnits", "gasUnitsWithMargin", "gasPriceWei", "ethUSD", "l1FeeWei", "marginPercent", "quotedBy")}

        if fee_micro_usd >= q["cover"]["microUSD"]:
            return {"covered": True, "gasMicroUSD": 0, "costMicroUSD": 0, "feeMicroUSD": fee_micro_usd, "coverMicroUSD": q["cover"]["microUSD"], "detail": detail_of(q["pay"]), **counted}
        pay = self.gas.relay_quote(call) or q["pay"]
        cover = q["cover"] if pay is q["pay"] else self.gas.priced(q["cover"]["gasUnits"], pay["gasPriceWei"], pay["ethUSD"])
        if fee_micro_usd >= cover["microUSD"]:
            return {"covered": True, "gasMicroUSD": 0, "costMicroUSD": 0, "feeMicroUSD": fee_micro_usd, "coverMicroUSD": cover["microUSD"], "detail": detail_of(pay), **counted}
        return {"covered": False, "gasMicroUSD": pay["microUSD"], "costMicroUSD": pay["costMicroUSD"], "feeMicroUSD": fee_micro_usd, "coverMicroUSD": cover["microUSD"], "detail": detail_of(pay), **counted}

    @staticmethod
    def gas_already_paid(ch, gas):
        def count(v):
            try:
                c = to_int(v)
            except (TypeError, ValueError):
                return 0
            return c if c > 0 else 0

        ch = ch or {}
        return max(0, count(ch.get("depositsWePaid", 0)) - 1) * gas["deposit"] + count(ch.get("refundGasWePaid", 0))

    @staticmethod
    def gas_counted(ch, gas, relay_paid):
        told = relay_paid if isinstance(relay_paid, int) and not isinstance(relay_paid, bool) and relay_paid > 0 else 0
        return max(Refunds.gas_already_paid(ch, gas), told)

    @staticmethod
    def gas_of(gas_info):
        return "its deposit, its refund, the further deposits and earlier refunds ZEAM paid for" if gas_info.get("alreadyPaid", 0) > 0 else "its deposit, its refund"

    @staticmethod
    def rule(cfg, gas_info, pay=None):
        return (refund_rule(int(php_round((cfg.gasBuffer - 1) * 100)), None if pay is None else php_str(pay)) + " Our fee is " + percent(cfg.feeShare) + "% of what the buyer spent: $" + Refunds.usd(gas_info["feeMicroUSD"])
                + " on this channel, under the $" + Refunds.usd(gas_info["coverMicroUSD"]) + " of gas it must cover (" + Refunds.gas_of(gas_info) + " and the calls not yet settled, the margin included)")

    def gas_payment_problem(self, ch, asset, pay_to, units, left, p):
        a = p.get("authorization")
        if a is None or any(v is None for v in a.values()) or p.get("signature") is None:
            return "gasPayment is {authorization: {from, to, value, validAfter, validBefore, nonce}, signature}"
        a = {k: php_str(v) for k, v in a.items()}
        if not Address.equals(a["from"], ch["channelConfig"]["payer"]):
            return "gasPayment must come from the channel's payer"
        if not Address.equals(a["to"], pay_to):
            return "gasPayment must go to the relay gas wallet " + pay_to
        if not _DIGITS.fullmatch(a["value"]) or int(a["value"]) < int(units):
            return "gasPayment is " + a["value"] + "; sending costs " + php_str(units)
        if int(a["value"]) > n(left):
            return "gasPayment is " + a["value"] + ", over the " + php_str(left) + " refund"
        now_secs = self.cfg.now_ms() // 1000
        if not _DIGITS.fullmatch(a["validAfter"]) or int(a["validAfter"]) > now_secs:
            return "gasPayment is not valid yet"
        if not _DIGITS.fullmatch(a["validBefore"]) or int(a["validBefore"]) < now_secs + Refunds.GAS_PAYMENT_MARGIN_SECS:
            return "gasPayment expires too soon"
        if not Hex.is_hex(a["nonce"], 32):
            return "gasPayment nonce is not 32 bytes"
        try:
            signer = Secp256k1.recover_hash(BatchSettlement.transfer_authorization_digest(Refunds.token_domain(self.cfg, asset), a), p["signature"]) if Secp256k1.is_canonical(p["signature"]) else None
        except Exception:
            signer = None
        if signer is None or not Address.equals(signer, a["from"]):
            return "gasPayment signature is not the payer's"
        return None

    @staticmethod
    def token_domain(cfg, asset):
        return BatchSettlement.token_domain(asset["address"], asset["name"], asset["version"] if asset.get("version") is not None else "1", cfg.chainId)

    def _gas_quote(self, ch, asset, pay_to, units, amounts, gas_info, why, extra=None):
        now_secs = self.cfg.now_ms() // 1000
        secs = int(float(self.cfg.gasPaymentSecs))
        authorization = {
            "from": Address.checksum(ch["channelConfig"]["payer"]),
            "to": Address.checksum(pay_to),
            "value": php_str(units),
            "validAfter": "0",
            "validBefore": str(now_secs + secs),
            "nonce": "0x" + secrets.token_hex(32),
        }
        gas = self._micro_usd(ch, units)
        d = gas_info["detail"]
        lead = "" if why is None else why + ". "
        return Refunds._answer(409, {
            "op": "refund_quote",
            "code": "gas_payment_needed",
            "why": lead + Refunds.rule(self.cfg, gas_info, d["marginPercent"]) + ". Refund gas: $" + Refunds.usd(gas)
                   + " USDC, no ETH (" + php_str(d["gasUnits"]) + " gas, L1 fee " + php_str(d["l1FeeWei"]) + " wei, "
                   + php_str(d["gasPriceWei"]) + " wei per gas, $" + php_str(d["ethUSD"]) + " per ETH, " + php_str(d["marginPercent"]) + "% margin; "
                   + ("priced by the relay" if d["quotedBy"] == "relay" else "priced from measured refunds") + "). Sign authorization (EIP-3009 TransferWithAuthorization; typed data in sign) and POST again with "
                   + "gasPayment: {authorization, signature} within " + str(secs) + "s. The refund of $" + Refunds.usd(amounts["leftMicroUSD"])
                   + " and the gas payment go in one transaction: $" + Refunds.usd(amounts["leftMicroUSD"] - gas) + " net to you. Or send "
                   + Refunds.SELF_SEND + " for a signed refund of the full balance, sent from any wallet at your own gas.",
            **amounts,
            "gasMicroUSD": gas,
            **d,
            **(extra or {}),
            "payTo": authorization["to"],
            "authorization": authorization,
            "sign": BatchSettlement.transfer_authorization_typed_data(Refunds.token_domain(self.cfg, asset), authorization),
        })

    @staticmethod
    def bundled_claim(ch, live):
        charged = n(ch.get("chargedCumulativeAmount", "0"))
        if charged <= n(live["claimed"]) or php_empty(ch.get("signature")) or php_empty(ch.get("signedMaxClaimable")):
            return 0
        return charged - n(live["claimed"])

    def refund_call(self, ch, live, left, nonce):
        ident = ch["channelId"].lower()
        refund_sig = BatchSettlement.sign_refund(self.cfg.signing_key(), ident, left, nonce, self.cfg.chainId)
        refund = BatchSettlement.encode_refund_with_signature(ch["channelConfig"], left, nonce, refund_sig)
        if Refunds.bundled_claim(ch, live) <= 0:
            return {"to": BatchSettlement.ESCROW, "data": refund}
        claims = [Channels.claim_entry(ch)]
        claim_sig = BatchSettlement.sign_claim_batch(self.cfg.signing_key(), claims, self.cfg.chainId)
        return {
            "to": BatchSettlement.ESCROW,
            "data": BatchSettlement.encode_multicall([BatchSettlement.encode_claim_with_signature(claims, claim_sig), refund]),
        }

    def _send_refund_now(self, ch, call, left, gas_micro_usd, amounts=None, free_gas_units=0):
        amounts = amounts or {}
        ident = ch["channelId"].lower()
        sent = self.relay.send([call], self.cfg.relay_split())
        if "hash" not in sent[0]:
            error = php_str(sent[0].get("error") or "the relay did not send the refund")
            numbers = {k: v for k, v in (("leftMicroUSD", amounts.get("leftMicroUSD")), ("gasMicroUSD", gas_micro_usd),
                                         ("feeMicroUSD", amounts.get("feeMicroUSD")), ("coverMicroUSD", amounts.get("coverMicroUSD"))) if v is not None}
            if gas_micro_usd > 0 and sent[0].get("code") == "underpaid":
                return {"underpaid": max(1, to_int(sent[0].get("gasMicroUSD") or 0))}
            return Refunds._failed(409, "refund_error", _cut(error, 160), {"retry_after_seconds": Refunds.RETRY_SECS, **numbers})
        after = None
        tries = int(self.cfg.drainTries)
        for i in range(max(1, tries)):
            try:
                after = self.chain.live(ident)
            except Exception:
                after = None
            if after is not None and n(after["balance"]) <= n(after["claimed"]):
                break
            if i + 1 < tries:
                self.cfg.sleep_ms(self.cfg.drainWaitMs)
        drained = after is not None and n(after["balance"]) <= n(after["claimed"])
        state = None

        def follow(r):
            if r is None:
                return None
            if gas_micro_usd == 0 and free_gas_units > 0:
                r["refundGasWePaid"] = Refunds.gas_already_paid({"refundGasWePaid": r.get("refundGasWePaid", 0)}, self.cfg.gas) + free_gas_units
            if after is not None:
                r["balance"] = after["balance"]
                r["repairedAt"] = self.cfg.now_ms()
                r["totalClaimed"] = after["claimed"]
                r["chargedCumulativeAmount"] = after["claimed"]
                r["refundNonce"] = to_int(r.get("refundNonce", 0)) + 1
                for k in ("signedMaxClaimable", "signature", "pendingRequest", "handedOver"):
                    r.pop(k, None)
            elif n(ch.get("chargedCumulativeAmount", "0")) < n(r.get("chargedCumulativeAmount", "0")):
                r["chargedCumulativeAmount"] = ch["chargedCumulativeAmount"]
            return r

        self.channels.update(ident, follow)
        if after is not None:
            state = {"channelId": ident, "balance": after["balance"], "totalClaimed": after["claimed"], "chargedCumulativeAmount": after["claimed"]}
        time_ms = self._forget(ident)
        returned = self._micro_usd(ch, left)
        body = {"op": "refunded", "microUSD": returned, "returnedMicroUSD": returned, "gasMicroUSD": gas_micro_usd,
                "transaction": sent[0]["hash"], "drained": drained}
        if time_ms > 0:
            body["timeReturnedMs"] = time_ms
        if gas_micro_usd > 0:
            body["why"] = ("refund $" + Refunds.usd(returned) + " and your gas payment $" + Refunds.usd(gas_micro_usd)
                           + " sent in one transaction: $" + Refunds.usd(returned - gas_micro_usd) + " net to you")
        else:
            body["why"] = "refund $" + Refunds.usd(returned) + " sent; ZEAM paid the gas"
        if state is not None:
            body["channelState"] = state
        return Refunds._answer(200, body)

    def _hand_over(self, ch, live, call, left, nonce):
        ident = ch["channelId"].lower()
        now = self.cfg.now_ms()
        transaction = {"chainId": self.cfg.chainId, "to": Address.checksum(call["to"]), "data": call["data"], "value": "0"}

        def reserve(r):
            if r is None:
                return None
            before = r.get("balance") if r.get("balance") is not None else "0"
            rest = n(before) - n(left)
            r["balance"] = str(rest) if rest > 0 else "0"
            if n(ch.get("chargedCumulativeAmount", "0")) < n(r.get("chargedCumulativeAmount", "0")):
                r["chargedCumulativeAmount"] = ch["chargedCumulativeAmount"]
            r["handedOver"] = {
                "units": php_str(left),
                "chainBalance": php_str(live["balance"]),
                "nonce": php_str(nonce),
                "at": now,
                "transaction": transaction,
            }
            return r

        try:
            self.channels.update(ident, reserve)
        except Exception as e:
            return Refunds._failed(409, "refund_error", _cut(str(e), 160), {"retry_after_seconds": Refunds.RETRY_SECS})
        time_ms = self._forget(ident)
        body = {
            "op": "refund_signed",
            "microUSD": self._micro_usd(ch, left),
            "transaction": transaction,
            "why": "signed refund of the full balance; send it from any wallet at your own gas",
        }
        if time_ms > 0:
            body["timeReturnedMs"] = time_ms
        return Refunds._answer(200, body)

    def _forget(self, ident):
        meter = getattr(self.cfg, "meter", None)
        return meter.forget(ident) if meter is not None else 0
