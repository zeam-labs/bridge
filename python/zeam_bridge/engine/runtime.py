import decimal
import glob
import os
import re
import threading
import time

from .abi import Abi
from .batch_settlement import BatchSettlement, Erc20
from .core import Address
from .discovery import FAILED_CALL
from .env import setting
from .files import ensure_dir, locked
from .gate import Admission, Credits, Exact, Meter
from .gate import FileStore as GateStore
from .keys import KeyFile
from .meter import TimeMeter, time_options
from .php import gmdate_iso, php_round, php_str
from .pricing import charge as charge_for
from .pricing import MAX_MICRO, MAX_USD, metered
from .rpc import Rpc
from .settlement import Chain, Claims, Config, FileCache, FileStore, GasQuote, Payout, Refunds, Relay, Server, Withdrawals
from .settlement.channels import Channels, n
from .settlement.jsonx import Json
from .settlement.store import MppHeldFiles

DEFAULT_FEE_RECIPIENT = "0xc60996007B7657DE2F39fA0577E97d7aAF3b7d1e"
DEFAULT_CREDIT_ISSUER = "0x4202d8042d89cbEFD9D48fE7f7Aa70061CC9Df22"
DEFAULT_RELAY = "https://api.zeampass.com/relay"
DEFAULT_CREDITS = "https://api.zeampass.com/credits"
DEFAULT_RPC = "https://mainnet.base.org"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
MODES = ("paywall", "gate", "both")
_NAME = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_PRICE = re.compile(r"^\d+(\.\d{1,6})?$")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def price_micro(price):
    if price is None:
        return 0
    text = repr(price) if isinstance(price, float) else str(price).strip()
    if not _PRICE.match(text):
        return 0
    micro = int((decimal.Decimal(text) * 1000000).to_integral_value(rounding=decimal.ROUND_HALF_UP))
    return micro if 1 <= micro <= MAX_MICRO else 0


GATE_HOW = ("Sign the zero-amount requirement with any x402 client and your own key. Nothing is paid. "
            "The key must be admitted here, or send an x-grant from an admitted key.")
ADMISSION = "Only admitted keys pay here, or keys with an x-grant from an admitted key."
OUT_OF_CHECKS = "This gate has no checks left this month. Retry later."
BAD_GRANT_HOW = ("Send a new x-grant: signed by an admitted key, delegate = the key that signs this call. "
                 "ZEAM Pass agent guide, section 3.")
_CONTACT = re.compile(r"^(?:https?://[^\s/?#]+\S*|mailto:[^\s@]+@[^\s@]+)$", re.I)


def refused_how(contact=None):
    reach = f" ({contact})" if contact else ""
    return (f"Ask this seller to admit your key{reach}, or send an x-grant signed by an admitted key. "
            "ZEAM Pass agent guide, section 3.")


GRANTED_BY = "X-Pass-Granted-By"
NO_UNITS = "the tool reported no units. " + FAILED_CALL


def refusal(status, body, headers=None):
    return {"delivered": False, "status": status, "headers": headers or {}, "body": body}


def _owed_time(directory):
    box = {}

    def store():
        if "store" not in box:
            box["store"] = FileStore(directory)
        return box["store"]

    def read(channel_id):
        rec = store().get(channel_id)
        return rec.get("timeOwed") if isinstance(rec, dict) else None

    def paid(channel_id, keys):
        def drop(r):
            if not isinstance(r, dict) or not isinstance(r.get("timeOwed"), dict):
                return r
            left = {k: v for k, v in r["timeOwed"].items() if k not in keys}
            if left:
                r["timeOwed"] = left
            else:
                del r["timeOwed"]
            return r

        store().update(channel_id, drop)

    return {"read": read, "paid": paid}


def _url(value, default):
    v = str(value or "").strip()
    return v.rstrip("/") if re.match(r"^https?://", v, re.I) else default


class Engine:

    def __init__(self, name, payout, mode="paywall", price=None, site=None, admit=None, relay=None, credits=None, rpc=None,
                 state_dir=None, on_empty="refuse", refund_url=None,
                 relay_transport=None, credits_http=None, settings=None, tick_seconds=60, contact=None, payout_is_fee_recipient=False,
                 prices=None, free=None, free_limit=None, time=None):
        if not isinstance(name, str) or not _NAME.match(name):
            raise ValueError("bridge: name is 2 to 32 characters of a-z, 0-9 and -, starting with a letter")
        if mode not in MODES:
            raise ValueError("bridge: mode is paywall, gate or both")
        if not isinstance(payout, str) or not _ADDRESS.match(payout):
            raise ValueError("bridge: payout is the wallet address your earnings go to")
        contact = "" if contact is None else contact.strip() if isinstance(contact, str) else None
        if contact is None or (contact and not _CONTACT.match(contact)):
            raise ValueError("bridge: contact is an http(s) URL or a mailto: address")
        self.contact = contact or None
        self.reach = {"contact": self.contact} if self.contact else {}
        self.refused_how = refused_how(self.contact)
        self.name = name
        self.mode = mode
        self.site = site
        self.payout = Address.checksum(payout)
        self.price_micro = price_micro(price)
        self.prices = prices if callable(prices) or isinstance(prices, dict) else None
        if mode != "gate" and self.price_micro < 1 and (self.prices is None or not (price is None or price == "")):
            raise ValueError("bridge: price is the USD per call, from 0.000001 to " + MAX_USD + " (above that a number stops counting micro-USD exactly), at most six decimals, or set prices per tool")
        self.free = list(dict.fromkeys(t for t in (free or []) if isinstance(t, str)))
        self.free_limit = Engine._per_hour(free_limit)
        self.time = time_options(time)
        if self.time and mode == "gate":
            raise ValueError("bridge: time metering needs mode paywall or both")
        self.admit_list = sorted({a.lower() for a in (admit or []) if isinstance(a, str) and _ADDRESS.match(a)})
        self.on_empty = "allow" if on_empty == "allow" else "refuse"
        self.relay_url = _url(relay, DEFAULT_RELAY)
        self.credits_url = _url(credits, DEFAULT_CREDITS)
        self.rpc = rpc if rpc is not None and not isinstance(rpc, str) else _url(rpc, DEFAULT_RPC)
        self.fee_recipient = DEFAULT_FEE_RECIPIENT
        self.payout_is_fee_recipient = payout_is_fee_recipient is True
        if _ADDRESS.match(str(self.fee_recipient)) and (self.payout.lower() == str(self.fee_recipient).lower()) != self.payout_is_fee_recipient:
            raise ValueError("bridge: payout_is_fee_recipient needs payout to be the fee recipient" if self.payout_is_fee_recipient
                             else "bridge: payout is the fee recipient; set payout_is_fee_recipient=True to pay it 100%")
        self.credit_issuer = DEFAULT_CREDIT_ISSUER
        self.refund_url = refund_url
        self.relay_transport = relay_transport
        self.credits_http = credits_http
        self.settings = dict(settings or {})
        if "feeRecipient" in self.settings:
            raise ValueError("bridge: the fee address is ZEAM's, set in the package; settings do not set feeRecipient")
        self.tick_seconds = tick_seconds
        self.state_dir = ensure_dir(str(state_dir or setting("BRIDGE_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".zeam-pass", name)))
        self.keys = KeyFile(self.state_dir)
        self.keys.ensure("settle")
        if self.gated():
            self.keys.ensure("credit")
        self.meta = GateStore(os.path.join(self.state_dir, "meta"))
        self.meter = TimeMeter(os.path.join(self.state_dir, "meter"), self.time, now=self._now_ms, owed=_owed_time(os.path.join(self.state_dir, "channels"))) if self.time else None
        self._parts = None
        self._gate = None
        self._build = threading.Lock()
        self._wake = threading.Event()
        self._thread = None
        self._pid = None

    @staticmethod
    def _per_hour(value):
        if value is None:
            return None
        v = value.get("perHour") if isinstance(value, dict) else value
        try:
            n = int(float(v)) if not isinstance(v, bool) else 0
        except (TypeError, ValueError, OverflowError):
            n = 0
        if n < 1:
            raise ValueError("bridge: free_limit is free calls an hour per address, 1 or more")
        return n

    def paid_mode(self):
        return self.mode != "gate"

    def settles(self):
        return self.paid_mode() or bool(glob.glob(os.path.join(self.state_dir, "channels", "0x*.json")))

    def gated(self):
        return self.mode != "paywall"

    def blockers(self):
        out = []
        if self.settles():
            state = self.keys.state("settle")
            if state == "missing":
                out.append("the settle key has not been generated")
            elif state == "locked":
                out.append("the settle key cannot be decrypted: BRIDGE_KEY_SECRET is missing or changed since it was made")
        return out

    def ready(self):
        return not self.blockers()

    def parts(self):
        if self._parts is not None:
            return self._parts
        with self._build:
            if self._parts is None:
                blockers = self.blockers()
                if blockers or not self.settles():
                    raise RuntimeError("; ".join(blockers) if blockers else "this site is not selling paid calls")
                options = {
                    "name": self.name,
                    "site": self.site or "",
                    "priceMicroUSD": max(1, self.price_micro),
                    "payout": self.payout,
                    "feeRecipient": self.fee_recipient,
                    "payoutIsFeeRecipient": self.payout_is_fee_recipient,
                    "receiverAuthorizerKey": self.keys.get("settle"),
                    "relayUrl": self.relay_url,
                    "rpcUrl": self.rpc if isinstance(self.rpc, str) else "http://rpc.invalid",
                    "refundUrl": self.refund_url,
                    "cache": FileCache(os.path.join(self.state_dir, "cache.json"), self.settings.get("clock")),
                }
                options.update(self.settings)
                cfg = Config(options)
                cfg.meter = self.meter
                store = FileStore(os.path.join(self.state_dir, "channels"))
                chain = Chain(self.rpc)
                relay = Relay(cfg.relayUrl, self.relay_transport, 120)
                server = Server(cfg, store, chain, relay)
                server.mpp_held = MppHeldFiles(os.path.join(self.state_dir, "mpp-held"))
                self._parts = {"cfg": cfg, "store": store, "chain": chain, "relay": relay, "server": server}
        return self._parts

    def gate_parts(self):
        if self._gate is not None:
            return self._gate
        with self._build:
            if self._gate is None:
                store = GateStore(os.path.join(self.state_dir, "gate"))
                clock = self.settings.get("clock")
                meter = Meter(store, self.name, {"onEmpty": self.on_empty, "now": clock, "freePerMonth": self.settings.get("gateFreePerMonth"), "creditBlock": self.settings.get("gateCreditBlock")})
                options = {"now": clock}
                if self.credits_http is not None:
                    options["http"] = self.credits_http
                self._gate = {
                    "store": store,
                    "admission": Admission(self.payout, store),
                    "meter": meter,
                    "credits": Credits(meter, self.credit_issuer, options),
                }
        return self._gate

    def _now_ms(self):
        clock = self.settings.get("clock")
        return int(clock()) if callable(clock) else int(time.time() * 1000)

    @staticmethod
    def resource(url, description=""):
        return {"url": php_str(url), "description": php_str(description), "mimeType": "application/json"}

    def channel(self, channel_id):
        try:
            return FileStore(os.path.join(self.state_dir, "channels")).get(channel_id)
        except Exception:
            return None

    def serve(self, tool, resource, payment, grant, run, refund_url=None, price=None, listing=None, bought=None, extensions=None, credential=""):
        self.start()
        if not self.ready():
            return refusal(503, {"error": "not_ready", "message": "this site has not finished setting up ZEAM Bridge"})
        payment = (payment or "").strip()
        grant = (grant or "").strip()
        try:
            if self.mode == "gate":
                return self._serve_gate(tool, resource, payment, grant, run)
            return self._serve_paid(tool, resource, payment, grant, run, self.mode == "both", refund_url, price, listing or {}, bought, extensions, (credential or "").strip())
        except _ToolRaised as e:
            raise e.error
        except Exception:
            return refusal(503, {"error": "payment_unavailable", "message": "the payment check failed; nothing was charged. Retry."})

    @staticmethod
    def _run(run, channel_id=None):
        try:
            return metered(run, channelId=channel_id)
        except Exception as e:
            raise _ToolRaised(e) from e

    def _bad_grant(self, server, resource, why, refund_url, price, listing, extensions):
        q = server.payment_required(resource, extensions, refund_url, {"admission": ADMISSION, **self.reach, **listing, "error": "bad_grant"}, price)
        return refusal(402, {**q["body"], "message": why, "how": BAD_GRANT_HOW}, q["headers"])

    def _serve_mpp(self, server, tool, resource, credential, grant, run, both, price, refund_url=None, listing=None, extensions=None):
        held = server.mpp_hold(credential, resource, price["micro"] if price else None, refund_url)
        if not held["ok"]:
            return refusal(held["status"], held["body"], held["headers"])
        hold = held["hold"]
        granted_by = None
        if both:
            who = hold["verified"]["payer"].lower()
            a = self.admits_payer(who, grant, tool)
            if not a["ok"]:
                server.mpp_release(hold)
                if a["code"] == "bad_grant":
                    return self._bad_grant(server, resource, a["why"], refund_url, price, listing or {}, extensions)
                return refusal(403, {"error": "refused", "message": a["why"], "how": self.refused_how, **self.reach})
            if a["root"] != who:
                granted_by = a["root"]
        try:
            (ok, value, status), _units = Engine._run(run, None)
        except BaseException:
            server.mpp_release(hold)
            raise
        if not ok:
            server.mpp_release(hold)
            return {"delivered": False, "failed": True, "status": status, "headers": {}, "body": value}
        settled = server.mpp_settle(hold)
        if not settled["ok"]:
            return refusal(settled["status"], settled["body"], settled["headers"])
        headers = dict(settled["headers"])
        if granted_by:
            headers[GRANTED_BY] = granted_by
        return {"delivered": True, "status": 200, "headers": headers, "body": value}

    def _serve_paid(self, tool, resource, payment, grant, run, both, refund_url=None, price=None, listing=None, bought=None, extensions=None, credential=""):
        server = self.parts()["server"]
        listing = listing or {}
        if payment == "" and credential and server.mpp_offered(price):
            return self._serve_mpp(server, tool, resource, credential, grant, run, both, price, refund_url, listing, extensions)
        if payment == "":
            q = server.payment_required(resource, extensions, refund_url, {"admission": ADMISSION, **self.reach, **listing} if both else {**self.reach, **listing}, price)
            return refusal(q["status"], q["body"], q["headers"])
        granted_by = None
        nobody = False
        if both:
            payload = Json.decode_header(payment)
            if payload is not None:
                who = Engine.payer_of(payload)
                bad = server.malformed(payment, refund_url) if who is None else None
                if bad is not None:
                    return refusal(bad["status"], bad["body"], bad["headers"])
                nobody = who is None
                if not nobody:
                    a = self.admits_payer(who, grant, tool)
                    if not a["ok"] and a["code"] == "bad_grant":
                        return self._bad_grant(server, resource, a["why"], refund_url, price, listing, extensions)
                    if not a["ok"]:
                        return refusal(403, {"error": "refused", "message": a["why"], "how": self.refused_how, **self.reach})
                    if a["root"] != who:
                        granted_by = a["root"]
        held = server.verify_and_hold(payment, resource, price["micro"] if price else None, refund_url)
        if not held["ok"]:
            return refusal(held["status"], held["body"], held["headers"])
        if nobody:
            server.release(held["hold"])
            return refusal(403, {"error": "refused", "message": self.admits_payer(None, grant, tool)["why"], "how": self.refused_how, **self.reach})
        hold = held["hold"]
        try:
            (ok, value, status), units = Engine._run(run, hold["channelId"])
        except BaseException:
            server.release(hold)
            raise
        if not ok:
            server.release(hold)
            return {"delivered": False, "failed": True, "status": status, "headers": {}, "body": value}
        is_metered = bool(price) and price.get("unitMicro") is not None
        if is_metered and units is None:
            server.release(hold)
            return {"delivered": False, "failed": True, "status": 500, "headers": {}, "body": NO_UNITS}
        charge = None
        if is_metered:
            micro = charge_for(price, units)
            cfg = self.parts()["cfg"]
            charge = "0" if micro == 0 else cfg.units_of_micro_usd(cfg.asset_of(hold["requirement"]["asset"]), micro)
        if bought is not None:
            hold["owedMs"] = bought["ms"]
        settled = server.settle(hold, charge)
        if not settled["ok"]:
            return refusal(settled["status"], settled["body"], settled["headers"])
        if bought is not None:
            try:
                bought["credit"](hold)
            except Exception:
                pass
            if bought.get("stated") is not None:
                value = bought["stated"](hold, value)
        headers = {"PAYMENT-RESPONSE": settled["headers"]["PAYMENT-RESPONSE"]}
        if granted_by:
            headers[GRANTED_BY] = granted_by
        return {"delivered": True, "status": 200, "headers": headers, "body": value}

    @staticmethod
    def _undo(bought, hold):
        if bought is None:
            return
        try:
            bought["undo"](hold)
        except Exception:
            pass

    def _serve_gate(self, tool, resource, payment, grant, run):
        g = self.gate_parts()
        if payment == "":
            body, headers = self._gate_terms(resource)
            return refusal(402, {**body, "how": GATE_HOW}, headers)
        a = g["admission"].admit(payment, grant, tool, self.admit_list, self._now_ms())
        if not a["ok"] and a["status"] == 402:
            body, headers = self._gate_terms(resource, {"error": a["code"]})
            return refusal(402, {**body, "error": a["code"], "message": a["why"], "how": GATE_HOW}, headers)
        if not a["ok"]:
            body = {"error": a["code"], "message": a["why"], "how": self.refused_how, **self.reach} if a["status"] == 403 else {"error": a["code"], "message": a["why"]}
            return refusal(a["status"], body)
        c = g["meter"].charge()
        if c.get("buy"):
            self._wake.set()
        if not c["ok"]:
            return refusal(503, {"error": "gate_credit_exhausted", "message": OUT_OF_CHECKS})
        if c.get("unpaid"):
            self.meta.update("unpaid-at", lambda s: ({"at": gmdate_iso()}, None))
        (ok, value, status), _units = Engine._run(run)
        if not ok:
            return {"delivered": False, "failed": True, "status": status, "headers": {}, "body": value}
        headers = {GRANTED_BY: a["root"]} if a["root"] != a["signer"] else {}
        return {"delivered": True, "status": 200, "headers": headers, "body": value}

    def _gate_terms(self, resource, extra=None):
        q = self.gate_parts()["admission"].payment_required(resource)
        body = {**q["body"], **self.reach}
        return body, {**q["headers"], "PAYMENT-REQUIRED": Exact.encode_header({**body, **(extra or {})})}

    @staticmethod
    def payer_of(payload):
        raw = payload.get("payload") if isinstance(payload, dict) and isinstance(payload.get("payload"), dict) else {}
        cfg = raw.get("channelConfig") if isinstance(raw.get("channelConfig"), dict) else {}
        auth = cfg.get("payerAuthorizer") if isinstance(cfg.get("payerAuthorizer"), str) else ""
        if _ADDRESS.match(auth) and not re.match(r"^0x0{40}$", auth):
            return auth.lower()
        payer = cfg.get("payer") if isinstance(cfg.get("payer"), str) else ""
        if _ADDRESS.match(payer):
            return payer.lower()
        auth = raw.get("authorization") if isinstance(raw.get("authorization"), dict) else {}
        sender = auth.get("from") if isinstance(auth.get("from"), str) else ""
        return sender.lower() if _ADDRESS.match(sender) else None

    def admits_payer(self, who, grant_header, tool):
        if who is None:
            return {"ok": False, "code": "refused", "why": "the payment names no payer"}
        if not grant_header:
            return {"ok": True, "root": who} if who in self.admit_list else {"ok": False, "code": "refused", "why": f"{who} is not admitted"}
        a = self.gate_parts()["admission"].grant(who, grant_header, tool, self.admit_list, self._now_ms())
        return {"ok": True, "root": php_str(a["root"]).lower()} if a["ok"] else a

    def refund(self, body):
        if not self.settles():
            return {"status": 404, "body": {"op": "refund_failed", "code": "not_a_paywall", "why": "this site has no paid calls"}}
        if not self.ready():
            return {"status": 503, "body": {"op": "refund_failed", "code": "not_ready", "why": "this site has not finished setting up ZEAM Bridge"}}
        p = self.parts()
        refunds = Refunds(p["cfg"], p["store"], p["chain"], p["relay"])

        def scalar(k):
            v = body.get(k) if isinstance(body, dict) else None
            return php_str(v) if isinstance(v, (str, int, float, bool)) else None

        return refunds.handle(scalar("channelId"), scalar("issued"), scalar("signature"), Refunds.ask(body))

    def _meta(self, key):
        value = self.meta.get(key)
        return value.get("value") if isinstance(value, dict) else None

    def _set_meta(self, key, value):
        self.meta.update(key, lambda _s: ({"value": value}, None))

    def _record_payout(self, calls, value_usd, how):
        txs = []
        for c in calls:
            if "hash" in c and c["hash"] not in txs:
                txs.append(c["hash"])
        if txs:
            self._set_meta("last-payout", {"at": gmdate_iso(), "valueUSD": value_usd, "how": how, "transactions": txs})

    def sync_claimed(self, limit=50):
        p = self.parts()
        synced = []
        for c in p["store"].list():
            if len(synced) >= limit or c.get("channelId") is None:
                continue
            try:
                charged, claimed = n(c.get("chargedCumulativeAmount", "0")), n(c.get("totalClaimed", "0"))
            except ValueError:
                continue
            if charged <= claimed:
                continue
            try:
                st = p["chain"].channel(c["channelId"])
            except Exception:
                continue
            if n(st["totalClaimed"]) <= claimed:
                continue

            def mark(r, st=st):
                if r is None:
                    return None
                if n(st["totalClaimed"]) > n(r.get("totalClaimed", "0")):
                    r["totalClaimed"] = st["totalClaimed"]
                return r

            p["store"].update(c["channelId"], mark)
            synced.append(c["channelId"].lower())
        return synced

    def credit_step(self):
        g = self.gate_parts()
        notes = self._meta("credit-notes") or []
        changed = False
        for entry in notes:
            if entry.get("added") or "note" not in entry:
                continue
            r = g["credits"].add_note(entry["note"], self.credit_issuer, self.payout, self.name)
            if r["ok"] or r.get("why") == "this note is already added":
                entry["added"] = True
                entry.pop("why", None)
            else:
                entry["why"] = php_str(r.get("why") or "not added")
            changed = True
        out = {"wanted": g["meter"].wants_credit()}
        if out["wanted"]:
            last = self._meta("credit-try") or 0
            if time.time() - last < 300:
                out["waiting"] = "last purchase attempt under 5 minutes ago"
            else:
                self._set_meta("credit-try", int(time.time()))
                key = self.keys.get("credit")
                if key is None:
                    out["error"] = "no credit wallet key"
                else:
                    rpc = Rpc(self.rpc, 10, 5) if isinstance(self.rpc, str) else self.rpc
                    r = g["credits"].buy(self.credits_url, g["meter"].credit_block(), key, self.payout, self.name, rpc)
                    if isinstance(r.get("note"), dict):
                        ok = bool(r["added"].get("ok"))
                        entry = {"note": r["note"], "at": gmdate_iso(), "added": ok}
                        if not ok:
                            entry["why"] = php_str(r["added"].get("why") or "not added")
                        notes.append(entry)
                        changed = True
                    out["bought"] = bool(r.get("ok"))
                    if not r.get("ok"):
                        out["error"] = php_str(r.get("why") or (r.get("added") or {}).get("why") or "not bought")
        if changed:
            self._set_meta("credit-notes", notes[-100:])
        return out

    def tick(self):
        with locked(os.path.join(self.state_dir, "tick.lock"), blocking=False) as got:
            if not got:
                return {"at": gmdate_iso(), "skipped": "another run is in progress"}
            report = {"at": gmdate_iso(), "mode": self.mode}
            blockers = self.blockers()
            if blockers:
                report["error"] = "; ".join(blockers)
                return report
            if self.settles():
                try:
                    p = self.parts()
                    report["withdrawals"] = Withdrawals(p["cfg"], p["store"], p["chain"]).run()
                    claims = Claims(p["cfg"], p["store"], p["chain"], p["relay"]).run()
                    report["claims"] = claims
                    report["synced"] = len(self.sync_claimed())
                    for asset in claims.values():
                        paid = [c for c in asset["calls"] if not php_str(c["what"]).startswith("claim ")]
                        self._record_payout(paid, asset["valueUSD"], "relay")
                except Exception as e:
                    report["error"] = str(e)[:300]
            if self.mode == "gate":
                try:
                    report["credit"] = self.credit_step()
                except Exception as e:
                    report["creditError"] = str(e)[:300]
            self._set_meta("last-tick", report)
            return report

    def payout_plan(self):
        p = self.parts()
        cfg, chain = p["cfg"], p["chain"]
        calls, usd, gas_units = [], 0.0, 0
        for asset in cfg.assets:
            picked, riding = [], 0
            for raw in p["store"].list():
                c = Channels.earned(cfg, raw)
                token = c.get("channelConfig", {}).get("token") if isinstance(c.get("channelConfig"), dict) else None
                if token is None or c.get("channelId") is None or not Address.equals(token, asset["address"]) or not Channels.claimable(c):
                    continue
                try:
                    live = chain.live(c["channelId"])
                except Exception:
                    continue
                charged = n(c["chargedCumulativeAmount"])
                if charged > n(live["balance"]) or charged <= n(live["claimed"]):
                    continue
                delta = charged - n(live["claimed"])
                if delta > n(live["payable"]):
                    continue
                picked.append(c)
                riding += delta
            plan = Payout(cfg, chain).calls(asset["address"], bool(picked))
            if picked:
                entries = [Channels.claim_entry(c) for c in picked]
                signature = BatchSettlement.sign_claim_batch(cfg.signing_key(), entries, cfg.chainId)
                calls.append({"what": f"claim {len(entries)} voucher(s)", "to": BatchSettlement.ESCROW, "data": BatchSettlement.encode_claim_with_signature(entries, signature)})
                gas_units += cfg.gas["claimBase"] + len(entries) * cfg.gas["claimEntry"]
            if plan["calls"]:
                gas_units += cfg.gas["payout"]
                for c in plan["calls"]:
                    if c["what"] == "create split":
                        gas_units += cfg.gas["createSplit"]
                calls.extend(plan["calls"])
                usd += cfg.micro_usd_of(asset, str(riding + int(plan["owed"]) + int(plan["held"]))) / 1e6
        return {"calls": calls, "usd": usd, "gasUnits": gas_units}

    def payout_now(self):
        p = self.parts()
        plan = self.payout_plan()
        if not plan["calls"]:
            return {"paidBy": "nobody", "valueUSD": 0, "note": "Nothing to pay out."}
        gas = GasQuote(p["cfg"], p["chain"], p["relay"])
        value_usd = php_round(plan["usd"], 6)
        gas_usd = gas.usd(plan["gasUnits"])
        note = None
        if gas.at_margin(plan["usd"], plan["gasUnits"]):
            sent = p["relay"].send(plan["calls"], p["cfg"].relay_split())
            report = [{"what": c["what"], **sent[i]} for i, c in enumerate(plan["calls"])]
            if any("hash" in r for r in report):
                self._record_payout(report, value_usd, "relay")
                self.sync_claimed()
                return {"paidBy": "relay", "valueUSD": value_usd, "calls": report}
            note = "The relay did not send it (" + (report[0].get("error") or "no answer") + "). "
        tuples = [[Address.checksum(c["to"]), False, c["data"]] for c in plan["calls"]]
        return {
            "paidBy": "you",
            "valueUSD": value_usd,
            "gasUSD": None if gas_usd is None else php_round(gas_usd, 6),
            "note": (note or "") + ("Below break-even: the " + Server.percent(p["cfg"].feeShare) + "% fee share of this payout is under its gas. The relay sends it once the share covers "
                                    "the gas. To pay out now, send this transaction from your wallet with ETH on Base for gas. It pays only you "
                                    "and the split's fee."),
            "transaction": {"chainId": 8453, "to": MULTICALL3, "data": Abi.encode_call("aggregate3((address,bool,bytes)[])", [tuples]), "value": "0"},
            "calls": [c["what"] for c in plan["calls"]],
        }

    def status(self):
        out = {
            "mode": self.mode,
            "ready": self.ready(),
            "blockers": self.blockers(),
            "stateDir": self.state_dir,
            "settleKey": self.keys.address("settle"),
            "lastPayout": self._meta("last-payout"),
            "lastTick": self._meta("last-tick"),
        }
        if self.settles() and self.ready():
            p = self.parts()
            cfg = p["cfg"]
            out["receiver"] = cfg.receiver
            total, opened = 0, 0
            for raw in p["store"].list():
                c = Channels.earned(cfg, raw)
                opened += 1
                try:
                    delta = n(c.get("chargedCumulativeAmount", "0")) - n(c.get("totalClaimed", "0"))
                except ValueError:
                    continue
                total += max(0, delta)
            out["unclaimed"] = {"microUSD": total, "channels": opened}
            try:
                token = cfg.assets[0]["address"]
                r = p["chain"].receivers(cfg.receiver, token)
                owed = int(r["totalClaimed"]) - int(r["totalSettled"])
                deployed = p["chain"].has_code(cfg.receiver)
                held = int(p["chain"].split_balance(cfg.receiver, token) if deployed else p["chain"].balance_of(token, cfg.receiver))
                out["claimedNotPaid"] = {"microUSD": max(0, owed) + held, "splitDeployed": deployed}
            except Exception as e:
                out["chainError"] = str(e)[:200]
        if self.gated():
            try:
                out["gate"] = dict(self.gate_parts()["meter"].usage(), onEmpty=self.on_empty, unpaidAt=(self.meta.get("unpaid-at") or {}).get("at"))
            except Exception as e:
                out["gateError"] = str(e)[:200]
            credit = self.keys.address("credit")
            if credit:
                try:
                    out["creditWallet"] = {"address": credit, "usdcMicro": int(Chain(self.rpc).balance_of(Erc20.USDC_BASE, credit))}
                except Exception:
                    out["creditWallet"] = {"address": credit, "error": "could not read its balance"}
        return out

    def start(self):
        if not self.tick_seconds or self.tick_seconds <= 0:
            return
        pid = os.getpid()
        if self._thread is not None and self._pid == pid and self._thread.is_alive():
            return
        with self._build:
            if self._thread is not None and self._pid == pid and self._thread.is_alive():
                return
            self._pid = pid
            self._wake = threading.Event()
            self._thread = threading.Thread(target=self._loop, name=f"zeam-bridge-{self.name}", daemon=True)
            self._thread.start()

    def _loop(self):
        while True:
            try:
                self.tick()
            except Exception:
                pass
            self._wake.wait(self.tick_seconds)
            self._wake.clear()


class _ToolRaised(Exception):
    def __init__(self, error):
        super().__init__(str(error))
        self.error = error
