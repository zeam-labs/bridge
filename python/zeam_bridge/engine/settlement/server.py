import math
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import urlsplit

from ..abi import Abi
from ..batch_settlement import BatchSettlement
from ..bazaar import for_header
from ..core import Address, Hex, Keccak
from ..php import is_int, php_empty, php_round, php_str, to_int
from ..pricing import exact_usd, pricing
from .channels import Channels, n
from .chain import Chain
from .config import Config
from .gas_quote import GasQuote
from .jsonx import Json
from .mpp import Challenge, Credential, EvmCharge, MppError, Problem, Receipt
from .reason import Reason
from .relay import Relay
from .store import MppHeldMemory
from .verify import Verify, _get

MISMATCH = Reason.CUMULATIVE_AMOUNT_MISMATCH
SDK_FIELDS = (
    "channelId", "channelConfig", "chargedCumulativeAmount", "signedMaxClaimable", "signature", "balance", "totalClaimed",
    "withdrawRequestedAt", "refundNonce", "onchainSyncedAt", "lastRequestTimestamp", "pendingRequest",
)
_CHANNEL = re.compile(r"^0x[0-9a-fA-F]{64}$")
MPP_TTL_SECS = 300
_MPP_USED_TRIES = 5
_AUTHORIZATION_USED = Keccak.utf8("AuthorizationUsed(address,bytes32)")
_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}


def _topic_of(address):
    return "0x" + "0" * 24 + address[2:].lower()


def _without_extra(d):
    return {k: v for k, v in d.items() if k != "extra"}


def _cut(text, length):
    return text.encode("utf-8")[:length].decode("utf-8", "ignore")


ELLIPSIS = "..."


def _shorten(text, length):
    cut = _cut(text, length)
    if cut == text:
        return text
    end = cut.rfind(". ")
    if end >= 60:
        return cut[:end + 1]
    room = _cut(text, length - len(ELLIPSIS))
    space = room.rfind(" ")
    whole = room if text[len(room):len(room) + 1] == " " or space <= 0 else room[:space]
    return whole.rstrip(" \t\n\r,;:([-") + ELLIPSIS


class Server:
    MISMATCH = MISMATCH
    MIN_PENDING_TTL_MS = 5000
    MAX_PENDING_TTL_MS = 600000
    SDK_FIELDS = SDK_FIELDS
    shorten = staticmethod(_shorten)

    def __init__(self, cfg, store, chain=None, relay=None):
        self.cfg = cfg
        self.store = store
        self.chain = chain or Chain(cfg.rpcUrl)
        self.relay = relay or Relay(cfg.relayUrl)
        self.gas_quote = GasQuote(cfg, self.chain, self.relay)
        self.channels = Channels(cfg, store, self.chain)
        self.verify = Verify(cfg, self.chain)
        self.mpp_held = MppHeldMemory()

    def gas(self):
        return self.gas_quote

    def micro(self, price):
        try:
            value = int(float(price)) if price is not None and not isinstance(price, bool) else 0
        except (TypeError, ValueError):
            value = 0
        return value if value >= 1 else int(self.cfg.priceMicroUSD)

    def accepts(self, price=None):
        micro = self.micro(price)
        rows = []
        for asset in self.cfg.assets:
            for method in (("eip3009", "permit2") if asset["eip3009"] else ("permit2",)):
                rows.append(self._requirement(asset, method, micro))
        dollar = [r for r in rows if isinstance(r["extra"].get("name"), str) and re.match(r"^USD Coin$", r["extra"]["name"], re.I)]
        if dollar and len(rows) > len(dollar):
            rows = rows + [dict(r, extra=dict(r["extra"])) for r in dollar]
        return rows

    def _requirement(self, asset, method, micro=None):
        extra = {}
        if method == "eip3009":
            if asset["name"] is not None and asset["name"] != "":
                extra["name"] = asset["name"]
                extra["version"] = asset["version"] if asset["version"] is not None else "1"
        else:
            extra["assetTransferMethod"] = "permit2"
        extra["receiverAuthorizer"] = self.cfg.receiverAuthorizer
        extra["withdrawDelay"] = self.cfg.withdrawDelay
        return {
            "scheme": Config.SCHEME,
            "network": self.cfg.network,
            "amount": self.cfg.price_units(asset) if micro is None else self.cfg.units_of_micro_usd(asset, micro),
            "asset": asset["address"],
            "payTo": self.cfg.receiver,
            "maxTimeoutSeconds": self.cfg.maxTimeoutSeconds,
            "extra": extra,
        }

    @staticmethod
    def resource_info(resource):
        if isinstance(resource, dict):
            out = {"url": php_str(resource.get("url"))}
            description = resource.get("description")
            if isinstance(description, str) and description != "":
                out["description"] = _shorten(description, 300)
            out["mimeType"] = php_str(resource["mimeType"]) if resource.get("mimeType") is not None else "application/json"
            return out
        return {"url": php_str(resource), "mimeType": "application/json"}

    @staticmethod
    def _document(resource, error, accepts):
        doc = {"x402Version": 2}
        if error is not None:
            doc["error"] = error
        doc["resource"] = resource
        doc["accepts"] = accepts
        return doc

    @staticmethod
    def _usd(micro_usd):
        exact = exact_usd(micro_usd)
        if exact is not None:
            return exact
        s = ("%.6f" % (micro_usd / 1e6)).rstrip("0").rstrip(".")
        return "0" if s == "" else s

    @staticmethod
    def percent(share):
        return ("%.2f" % (float(share) * 100)).rstrip("0").rstrip(".")

    def _price(self, price):
        return price if isinstance(price, dict) else {"micro": self.micro(price), "unitMicro": None}

    def refund_where(self, refund_url=None):
        at = self.cfg.refundUrl or refund_url
        return ("POST " + str(at)) if at else "POST /refund on this site"

    def terms(self, refund_url=None, price=None):
        p = self._price(price)
        floor = self.gas_quote.deposit_floor_micro_usd(p["micro"])
        q = self.gas_quote.refund(False, False)
        cover = None if q is None else q["cover"]["microUSD"]
        relayed = self.gas_quote.relay_refund_quote()
        gas = relayed["microUSD"] if relayed is not None else (None if q is None else q["pay"]["microUSD"])
        where = self.refund_where(refund_url)

        def about(micro_usd):
            return "" if micro_usd is None else " ($" + Server._usd(micro_usd) + " now)"

        margin = relayed["marginPercent"] if relayed is not None else int(php_round((self.cfg.gasBuffer - 1) * 100))
        figure = "" if gas is None else "$" + Server._usd(gas) + (" at the relay's latest quote, " if relayed is not None else " by this seller's estimate, ")
        return {
            "pricing": pricing(p),
            "deposit": "First call on a channel deposits at least $" + Server._usd(floor)
                       + ". Later calls spend it. The unspent balance is refundable.",
            "refund": ("Refund: " + where + " with {channelId, issued, signature} signed by the payer; add channelConfig "
                       "if the channel has no calls. ZEAM pays the gas when the channel's fees (" + Server.percent(self.cfg.feeShare) + "% of its spend) cover "
                       "the gas of its deposit, its refund and any calls not yet settled, and of every further deposit and every earlier refund ZEAM paid for on that channel, plus " + str(int(php_round((self.cfg.gasBuffer - 1) * 100))) + "%" + about(cover) + ". Otherwise sign a gasless USDC payment of the refund "
                       "gas (" + figure + str(margin) + "% margin included); a refund request answers with the figure to sign. An unsettled call adds its claim gas. "
                       "{\"selfSend\": true}: a signed refund you send at your own gas."),
        }

    def payment_required(self, resource, extensions=None, refund_url=None, more=None, price=None):
        p = self._price(price)
        doc = Server._document(Server.resource_info(resource), None, self.accepts(p["micro"]))
        if extensions:
            doc["extensions"] = extensions
        doc.update(self.terms(refund_url, p))
        doc.update(more or {})
        headers = {"PAYMENT-REQUIRED": Json.base64(for_header(doc))}
        challenge = self.mpp_challenge(doc["resource"], p["micro"]) if Server.mpp_offered(p) else None
        if challenge is not None:
            headers["WWW-Authenticate"] = Challenge.header(challenge)
            headers["Cache-Control"] = "no-store"
        return {"ok": False, "status": 402, "body": doc, "headers": headers}

    @staticmethod
    def mpp_offered(price):
        return not isinstance(price, dict) or (price.get("unitMicro") is None and price.get("ms") is None)

    def mpp_realm(self, resource):
        try:
            u = urlsplit(Server.resource_info(resource)["url"])
            host = u.hostname
            if not u.scheme or not host:
                return self.cfg.name
            if ":" in host:
                host = "[" + host + "]"
            if u.port is not None and _DEFAULT_PORTS.get(u.scheme.lower()) != u.port:
                host = f"{host}:{u.port}"
            return host
        except ValueError:
            return self.cfg.name

    def mpp_asset(self):
        for a in self.cfg.assets:
            if a.get("eip3009"):
                return a
        return None

    def mpp_expect(self, resource, asset):
        version = asset["version"] if asset.get("version") is not None else "1"
        return {"realm": self.mpp_realm(resource), "chainId": self.cfg.chainId, "currency": asset["address"], "recipient": self.cfg.receiver,
                "tokenDomain": BatchSettlement.token_domain(asset["address"], asset["name"], version, self.cfg.chainId)}

    def mpp_floor_micro_usd(self):
        gas = self.gas_quote.micro_usd(int(math.ceil(self.cfg.gas["charge"] * self.cfg.gasBuffer)))
        return None if gas is None else int(math.ceil(gas / self.cfg.feeShare))

    def mpp_quote(self, micro):
        asset = self.mpp_asset()
        if asset is None:
            return None
        floor = self.mpp_floor_micro_usd()
        if floor is None or self.micro(micro) < floor:
            return None
        return {"asset": asset, "amount": self.cfg.units_of_micro_usd(asset, self.micro(micro))}

    def mpp_offer(self, price, description=None):
        p = price if isinstance(price, dict) else {"micro": self.micro(price), "unitMicro": None}
        if not Server.mpp_offered(p):
            return None
        q = self.mpp_quote(p["micro"])
        if q is None:
            return None
        out = {"amount": str(q["amount"]), "currency": Address.checksum(q["asset"]["address"])}
        said = Server.resource_info({"url": "", "description": description}).get("description")
        if isinstance(said, str) and said != "":
            out["description"] = _shorten(said, 120)
        out["intent"] = EvmCharge.INTENT
        out["method"] = EvmCharge.METHOD
        return out

    def mpp_challenge(self, resource, micro):
        q = self.mpp_quote(micro)
        if q is None:
            return None
        asset = q["asset"]
        res = Server.resource_info(resource)
        request = EvmCharge.request(q["amount"], asset["address"], self.cfg.receiver, self.cfg.chainId, asset["decimals"])
        expires = datetime.fromtimestamp((self.cfg.now_ms() + MPP_TTL_SECS * 1000) // 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        description = None
        if isinstance(res.get("description"), str):
            description = _shorten(res["description"], 120)
        return Challenge.issue(self.cfg.mpp_secret(), self.mpp_realm(resource), EvmCharge.METHOD, EvmCharge.INTENT, request, expires, description, Challenge.once())

    def mpp_refuse(self, resource, micro, error):
        q = self.payment_required(resource, None, None, {}, micro)
        return Server._refuse(402, {**Problem.of(error), "accepts": q["body"]["accepts"]}, q["headers"])

    def mpp_hold(self, header_value, resource, price=None):
        micro = self.micro(price)
        asset = self.mpp_asset()
        try:
            if asset is None:
                raise MppError("invalid-challenge", "this seller takes no EIP-3009 token")
            credential = Credential.parse(header_value)
            expect = self.mpp_expect(resource, asset)
            verified = EvmCharge.verify(self.cfg.mpp_secret(), credential, expect, self.cfg.now_ms() // 1000)
            if verified["request"]["amount"] != str(self.cfg.units_of_micro_usd(asset, micro)):
                raise MppError("invalid-challenge", "the challenge is for another price")
            if not verified["ecdsa"]:
                digest = BatchSettlement.transfer_authorization_digest(expect["tokenDomain"], verified["authorization"])
                if not self.chain.is_valid_signature(verified["payer"], digest, verified["signature"]):
                    raise MppError("verification-failed", "the authorization signature is not valid for its payer")
            if self.mpp_used(asset["address"], verified):
                raise MppError("verification-failed", "this authorization has already been used")
            if int(self.chain.balance_of(asset["address"], verified["payer"])) < int(verified["authorization"]["value"]):
                raise MppError("verification-failed", "the payer does not hold the amount")
        except MppError as e:
            return self.mpp_refuse(resource, micro, e)
        if not self.mpp_held.claim(verified["replayKey"], int(verified["authorization"]["validBefore"]) * 1000, self.cfg.now_ms()):
            return self.mpp_refuse(resource, micro, MppError("verification-failed", "this authorization is already in use"))
        return {"ok": True, "hold": {"kind": "mpp", "verified": verified, "micro": micro, "resource": Server.resource_info(resource), "asset": asset["address"]}}

    def mpp_used(self, token, verified):
        out = self.chain.call(token, Abi.encode_call("authorizationState(address,bytes32)", [verified["payer"], verified["authorization"]["nonce"]]))
        return int(Hex.lower(out)[2:] or "0", 16) != 0

    def mpp_release(self, hold):
        self.mpp_held.release(hold["verified"]["replayKey"])

    def mpp_settle(self, hold):
        v = hold["verified"]

        def fail(detail):
            self.mpp_release(hold)
            return self.mpp_refuse(hold["resource"], hold["micro"], MppError("verification-failed", "the payment did not settle. Not delivered; nothing was charged. " + str(detail)[:200]))

        def lost(detail, sent=False):
            tries = _MPP_USED_TRIES if sent and "revert" in str(detail).lower() else 1
            for i in range(tries):
                if i > 0:
                    self.cfg.sleep_ms(self.cfg.receiptPollMs)
                try:
                    used = self.mpp_used(hold["asset"], v)
                except Exception:
                    break
                if used:
                    return self.mpp_refuse(hold["resource"], hold["micro"], MppError("verification-failed", "this authorization has already been used"))
            return fail(detail)

        tx_hash = None
        asked = False
        try:
            call = EvmCharge.call(v)
            try:
                self.chain.call(call["to"], call["data"], self.cfg.receiver)
            except Exception as e:
                return lost(f"the transfer would revert: {e}")
            asked = True
            sent = self.relay.send([call], self.cfg.relay_split())
            tx_hash = sent[0].get("hash") if sent and isinstance(sent[0], dict) else None
            if tx_hash is None:
                return lost(sent[0].get("error") if sent and isinstance(sent[0], dict) and sent[0].get("error") is not None else "the relay sent nothing", True)
            receipt = self._wait_for_receipt(tx_hash)
            if receipt is None:
                return fail(f"no receipt for {tx_hash}")
            if str(receipt.get("status") if receipt.get("status") is not None else "").lower() != "0x1":
                return lost(f"transaction {tx_hash} reverted")
            used = False
            for entry in receipt.get("logs") or []:
                topics = entry.get("topics") or []
                if (Address.equals(entry.get("address"), call["to"]) and len(topics) >= 3 and str(topics[0]).lower() == _AUTHORIZATION_USED
                        and str(topics[1]).lower() == _topic_of(v["payer"]) and str(topics[2]).lower() == v["authorization"]["nonce"]):
                    used = True
            if not used:
                return fail(f"transaction {tx_hash} did not use this authorization")
            at = datetime.fromtimestamp(self.cfg.now_ms() / 1000, timezone.utc)
            timestamp = at.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (at.microsecond // 1000)
            response = {"success": True, "transaction": Hex.lower(tx_hash), "network": self.cfg.network, "payer": v["payer"], "amount": v["authorization"]["value"],
                        "extra": {"protocol": "mpp", "method": EvmCharge.METHOD, "intent": EvmCharge.INTENT, "challengeId": v["challenge"]["id"]}}
            return {"ok": True, "status": 200, "response": response, "headers": {"Payment-Receipt": Receipt.header(EvmCharge.receipt(v, tx_hash, timestamp))}}
        except Exception as e:
            return lost(str(e), asked) if tx_hash is None else fail(str(e))

    @staticmethod
    def _refuse(status, body, headers=None):
        return {"ok": False, "status": status, "body": body, "headers": headers or {}}

    @staticmethod
    def channel_id_of(payload):
        raw = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        ident = _get(raw, "voucher", "channelId")
        if ident is None:
            ident = raw.get("channelId")
        return ident.lower() if isinstance(ident, str) and _CHANNEL.match(ident) else None

    def match(self, accepts, payload):
        version = payload.get("x402Version")
        accepted = payload.get("accepted") if isinstance(payload.get("accepted"), dict) else None
        if accepted is None:
            return None
        for req in accepts:
            if is_int(version) and version == 2:
                if Json.deep_equal(_without_extra(req), _without_extra(accepted)) and Json.contains_subset(req["extra"], accepted.get("extra")):
                    return req
            elif is_int(version) and version == 1:
                if accepted.get("scheme") is not None and accepted.get("network") is not None and req["scheme"] == accepted["scheme"] and req["network"] == accepted["network"]:
                    return req
        return None

    @staticmethod
    def _provisional(raw, charged, now):
        return {
            "channelId": raw["voucher"]["channelId"],
            "channelConfig": raw["channelConfig"],
            "chargedCumulativeAmount": php_str(charged),
            "signedMaxClaimable": php_str(Verify.uint(raw["voucher"]["maxClaimableAmount"])),
            "signature": raw["voucher"]["signature"],
            "balance": "0",
            "totalClaimed": "0",
            "withdrawRequestedAt": 0,
            "refundNonce": 0,
            "lastRequestTimestamp": now,
        }

    @staticmethod
    def _infer_charged(signed_max, price):
        signed = Verify.uint(signed_max)
        amount = Verify.uint(price)
        return "0" if signed < amount else str(signed - amount)

    @staticmethod
    def _channel_state(c, charged=None):
        out = {
            "channelId": c.get("channelId"),
            "balance": c.get("balance"),
            "totalClaimed": c.get("totalClaimed"),
            "withdrawRequestedAt": c.get("withdrawRequestedAt"),
            "refundNonce": php_str(c.get("refundNonce")),
        }
        if charged is not None:
            out["chargedCumulativeAmount"] = php_str(charged)
        return out

    def enrich(self, accepts, error, payload, snapshot):
        if error != MISMATCH:
            return accepts
        raw = payload.get("payload")
        if not Verify.is_voucher_payload(raw) and not Verify.is_deposit_payload(raw) and not Verify.is_refund_payload(raw):
            return accepts
        network = _get(payload, "accepted", "network")
        try:
            if Verify.binding_error(raw["channelConfig"], raw["voucher"]["channelId"], network):
                return accepts
            channel = snapshot if snapshot is not None else self.store.get(raw["voucher"]["channelId"].lower())
        except Exception:
            return accepts
        if channel is None:
            return accepts
        accepts = [dict(a, extra=dict(a["extra"])) for a in accepts]
        for req in accepts:
            if req["scheme"] == Config.SCHEME and req["network"] == network:
                req["extra"]["channelState"] = Server._channel_state(channel, channel.get("chargedCumulativeAmount"))
                req["extra"]["voucherState"] = {k: channel[k] for k in ("signedMaxClaimable", "signature") if channel.get(k) is not None}
                break
        return accepts

    @staticmethod
    def _state_in(accepts):
        for a in accepts:
            if isinstance(a.get("extra"), dict) and a["extra"].get("channelState") is not None:
                return a["extra"]["channelState"]
        return None

    def _funding_refusal(self, payload, accepts, floor, price=None):
        price = self.cfg.priceMicroUSD if price is None else price
        quoted = self._quoted_micro_usd(payload)
        if quoted + 1 < price:
            return {
                "error": "price_changed", "code": "price_changed", "quotedMicroUSD": quoted, "neededMicroUSD": floor,
                "message": f"the price is {price} micro-USD per call. Pay the accepts quote. Nothing was charged.",
                "accepts": accepts,
            }
        deposit = self._deposit_micro_usd(payload)
        return {
            "error": "funding_requires_open_fee", "code": "funding_requires_open_fee",
            "quotedMicroUSD": quoted, "depositMicroUSD": deposit, "neededMicroUSD": floor,
            "message": f"deposit {deposit} micro-USD is under the {floor} micro-USD floor. Deposit at least {floor} micro-USD; "
                       f"each call costs up to {quoted} micro-USD; the unspent balance is refundable. Nothing was charged.",
            "accepts": accepts,
        }

    def _quoted_micro_usd(self, payload):
        try:
            acc = payload.get("accepted") if isinstance(payload.get("accepted"), dict) else {}
            amount = acc.get("amount") if acc.get("amount") is not None else "0"
            v = self.cfg.micro_usd_of(acc.get("asset") if acc.get("asset") is not None else "", str(Verify.uint(amount)))
            return 0 if v is None else v
        except Exception:
            return 0

    def _deposit_micro_usd(self, payload):
        try:
            acc = payload.get("accepted") if isinstance(payload.get("accepted"), dict) else {}
            amount = _get(payload, "payload", "deposit", "amount")
            amount = "0" if amount is None else amount
            v = self.cfg.micro_usd_of(acc.get("asset") if acc.get("asset") is not None else "", str(Verify.uint(amount)))
            return 0 if v is None else v
        except Exception:
            return 0

    def malformed(self, payment_header_value, refund_url=None):
        payload = Json.decode_header(payment_header_value)
        if payload is None:
            return Server._refuse(400, {"error": "bad_payment_header", "message": "the payment does not decode. Over HTTP, send base64 of the PaymentPayload JSON in the PAYMENT-SIGNATURE header; over MCP, send the PaymentPayload object in params._meta[\"x402/payment\"]."})
        if isinstance(payload, list):
            payload = {}
        raw = payload.get("payload") if isinstance(payload.get("payload"), dict) else None
        kind = raw.get("type") if raw is not None else None
        batch = (payload.get("scheme") == Config.SCHEME
                 or _get(payload, "accepted", "scheme") == Config.SCHEME
                 or (kind is not None and kind != "" and kind is not False and not (is_int(kind) and kind == 0)))
        if batch and kind != "voucher" and kind != "deposit":
            return Server._refuse(400, {"error": "bad_payment_type", "message": "a paid call carries a voucher or a deposit. Refunds: " + self.refund_where(refund_url) + ". Nothing was charged."})
        if not Verify.normalize(raw):
            return Server._refuse(400, {"error": "bad_payment_header", "message": Verify.AMOUNT_FORM + ". Nothing was charged."})
        return None

    def verify_and_hold(self, payment_header_value, resource, price=None, refund_url=None):
        micro = self.micro(price)
        res = Server.resource_info(resource)
        accepts = self.accepts(micro)
        bad = self.malformed(payment_header_value, refund_url)
        if bad is not None:
            return bad
        payload = Json.decode_header(payment_header_value)
        if isinstance(payload, list):
            payload = {}
        raw = payload.get("payload") if isinstance(payload.get("payload"), dict) else None
        Verify.normalize(raw)
        kind = raw.get("type") if raw is not None else None
        cid = Server.channel_id_of(payload)
        ch = None
        if cid is not None:
            try:
                ch = self.channels.repaired(cid)
            except Exception:
                ch = None
        if ch is not None:
            if Channels.held(ch, self.cfg.now_ms(), True):
                ch = self.channels.judged(cid, True) or ch
            refund_at = self.cfg.now_ms()
            if Channels.refunding_wait_ms(ch, refund_at) > 0:
                secs = Channels.refunding_retry_secs(self.cfg, ch, refund_at)
                return Server._refuse(402, {"error": "refund_settling", "code": "refund_settling", "message": f"a refund is settling on this channel, retry in {secs}s. Nothing was charged.", "retry_after_seconds": secs})
            if self.channels.leaving(ch):
                return Server._refuse(402, {"error": "channel_leaving", "code": "channel_leaving", "message": "this channel is withdrawing. Open a new channel. Nothing was charged."})
            if not php_empty(ch.get("handedOver")):
                return Server._refuse(402, {
                    "error": "refund_outstanding", "code": "refund_outstanding",
                    "transaction": _get(ch, "handedOver", "transaction"),
                    "message": "this channel has an unsent signed refund. Send it (transaction here), then deposit again. Nothing was charged.",
                })
            if kind == "deposit":
                left, price = 0, 0
                try:
                    left = n(ch.get("balance")) - Channels.max(ch.get("chargedCumulativeAmount"), ch.get("totalClaimed"))
                    amount = _get(payload, "accepted", "amount")
                    price = Verify.uint("0" if amount is None else amount)
                except Exception:
                    price = 0
                if price > 0 and left >= price and self._quoted_micro_usd(payload) + 1 >= micro and self.match(accepts, payload) is not None:
                    enriched = self.enrich(accepts, MISMATCH, payload, None)
                    if Server._state_in(enriched) is not None:
                        corrected = Server._document(res, MISMATCH, enriched)
                        body = dict(corrected)
                        body["code"] = "payment_invalid"
                        body["reason"] = "channel_funded"
                        body["message"] = "this channel is funded. Pay with a voucher. Nothing was charged."
                        body["channelState"] = Server._state_in(enriched)
                        return Server._refuse(402, body, {"PAYMENT-REQUIRED": Json.base64(corrected)})
        match = self.match(accepts, payload)
        if kind == "deposit":
            floor = self.gas_quote.deposit_floor_micro_usd(micro)
            if self._quoted_micro_usd(payload) + 1 < micro or (match is not None and self._deposit_micro_usd(payload) < floor):
                return Server._refuse(402, self._funding_refusal(payload, accepts, floor, micro))
        if match is None:
            return Server._refuse(402, {"error": "no_matching_requirement", "message": "the payment matches no requirement here", "accepts": accepts})
        ctx = {"snapshot": None}
        verified = self.verify_payment(payload, match, ctx)
        again = 0
        judged_by = self.cfg.now_ms() + self.channels.judge_wait_ms()
        while verified.get("invalidReason") == Reason.REFUND_SETTLING:
            judged = self.channels.judged(cid)
            at = self.cfg.now_ms()
            if Channels.refunding_wait_ms(judged, at) > 0 or (again >= 3 and at >= judged_by):
                break
            verified = self.verify_payment(payload, match, ctx)
            again += 1
        if verified.get("invalidReason") == Reason.REFUND_SETTLING:
            secs = Channels.refunding_retry_secs(self.cfg, self.channels.get(cid), self.cfg.now_ms())
            return Server._refuse(402, {"error": "refund_settling", "code": "refund_settling", "message": f"a refund is settling on this channel, retry in {secs}s. Nothing was charged.", "retry_after_seconds": secs})
        if not verified["isValid"]:
            reason = verified.get("invalidReason")
            error = MISMATCH if re.search(r"exceeds_balance|below_claimed", php_str(reason)) else reason
            enriched = self.enrich(accepts, error, payload, ctx["snapshot"])
            corrected = Server._document(res, error, enriched)
            body = {"error": error if error is not None else "payment_invalid", "code": "payment_invalid", "message": "the payment did not verify"}
            if reason is not None:
                body["reason"] = reason
            body["accepts"] = enriched
            state = Server._state_in(enriched)
            if state is not None:
                body["channelState"] = state
            return Server._refuse(402, body, {"PAYMENT-REQUIRED": Json.base64(corrected)})
        return {
            "ok": True,
            "hold": {
                "kind": kind,
                "channelId": ctx["channelId"],
                "pendingId": ctx["pendingId"],
                "payload": payload,
                "requirement": match,
                "resource": res,
                "payer": verified["payer"],
                "micro": micro,
            },
        }

    def verify_payment(self, payload, req, ctx):
        raw = payload["payload"]
        local = None
        norm_max = None
        now = self.cfg.now_ms()
        if Verify.is_voucher_payload(raw) or Verify.is_deposit_payload(raw):
            try:
                norm_max = php_str(Verify.amount(raw["voucher"]["maxClaimableAmount"]))
            except Exception:
                return Verify.invalid(Reason.PAYLOAD_TYPE, None, Verify.AMOUNT_FORM)
            try:
                bind = Verify.binding_error(raw["channelConfig"], raw["voucher"]["channelId"], req["network"])
                if bind:
                    return Verify.invalid(bind)
                cid = raw["voucher"]["channelId"].lower()
                snapshot = self.store.get(cid)
                if snapshot is not None and snapshot.get("chargedCumulativeAmount") is not None:
                    charged = php_str(snapshot["chargedCumulativeAmount"])
                else:
                    charged = Server._infer_charged(raw["voucher"]["maxClaimableAmount"], req["amount"])
                expected = int(charged) + Verify.uint(req["amount"])
                if Channels.pending_live(snapshot, now):
                    return Verify.invalid(Reason.CHANNEL_BUSY)
                if Verify.uint(raw["voucher"]["maxClaimableAmount"]) != expected:
                    ctx["snapshot"] = snapshot if snapshot is not None else Server._provisional(raw, charged, now)
                    return Verify.invalid(MISMATCH)
                ctx["snapshot"] = snapshot
                ctx["channelId"] = cid
                ctx["pendingId"] = Hex.from_bin(secrets.token_bytes(32))
                if Verify.is_voucher_payload(raw):
                    local = self.verify.local(raw, req, snapshot, now)
            except Exception:
                return Verify.invalid(Reason.VERIFICATION_STATE_UNAVAILABLE)
        result = local if local is not None else self.verify.facilitator(payload, req)
        if not result["isValid"] or php_empty(result.get("payer")):
            return result
        if "pendingId" not in ctx:
            return Verify.invalid(Reason.VERIFICATION_STATE_UNAVAILABLE)
        ex = result.get("extra") or {}
        pending_id = ctx["pendingId"]
        expires_at = now + min(self.MAX_PENDING_TTL_MS, max(self.MIN_PENDING_TTL_MS, max(0, to_int(req["maxTimeoutSeconds"])) * 1000))
        is_local = local is not None
        box = {"outcome": None, "record": None}

        def reserve(current):
            if Channels.refunding_wait_ms(current, now) > 0:
                box["outcome"] = "refunding"
                return current
            if Channels.pending_live(current, now):
                box["outcome"] = "busy"
                return current
            if current is not None and current.get("chargedCumulativeAmount") is not None:
                base = php_str(current["chargedCumulativeAmount"])
            else:
                base = Server._infer_charged(raw["voucher"]["maxClaimableAmount"], req["amount"])
            if Verify.uint(raw["voucher"]["maxClaimableAmount"]) != int(base) + Verify.uint(req["amount"]):
                box["outcome"] = "stale"
                box["record"] = current if current is not None else Server._provisional(raw, base, now)
                return current
            nxt = {
                "channelId": raw["voucher"]["channelId"],
                "channelConfig": raw["channelConfig"],
                "chargedCumulativeAmount": base,
                "signedMaxClaimable": norm_max,
                "signature": raw["voucher"]["signature"],
                "balance": php_str(ex["balance"]) if ex.get("balance") is not None else "0",
                "totalClaimed": php_str(ex["totalClaimed"]) if ex.get("totalClaimed") is not None else "0",
                "withdrawRequestedAt": to_int(ex["withdrawRequestedAt"]) if ex.get("withdrawRequestedAt") is not None else 0,
                "refundNonce": to_int(ex["refundNonce"]) if ex.get("refundNonce") is not None else 0,
            }
            if is_local:
                synced = current.get("onchainSyncedAt") if current is not None else None
            else:
                synced = now
            if synced is not None:
                nxt["onchainSyncedAt"] = synced
            nxt["lastRequestTimestamp"] = now
            nxt["pendingRequest"] = {
                "pendingId": pending_id,
                "signedMaxClaimable": norm_max,
                "expiresAt": expires_at,
            }
            for k, v in (current or {}).items():
                if k not in SDK_FIELDS:
                    nxt[k] = v
            box["outcome"] = "reserved"
            box["record"] = nxt
            return nxt

        try:
            self.store.update(ctx["channelId"], reserve)
        except Exception:
            return Verify.invalid(Reason.VERIFICATION_STATE_UNAVAILABLE)
        if box["outcome"] == "refunding":
            return Verify.invalid(Reason.REFUND_SETTLING)
        if box["outcome"] == "busy":
            return Verify.invalid(Reason.CHANNEL_BUSY)
        if box["outcome"] == "stale":
            ctx["snapshot"] = box["record"]
            return Verify.invalid(MISMATCH)
        ctx["snapshot"] = box["record"]
        return result

    def release(self, hold):
        return self.channels.release(hold["channelId"], hold["pendingId"])

    def _deposit_short(self, hold, payload, needed, micro):
        self.release(hold)
        return Server._refuse(402, self._funding_refusal(payload, self.accepts(hold.get("micro")), needed, micro))

    def _settle_failed(self, hold, reason):
        self.release(hold)
        accepts = self.accepts(hold.get("micro"))
        doc = Server._document(hold["resource"], "settle_failed", accepts)
        return Server._refuse(402, {
            "error": "settle_failed", "code": "settle_failed",
            "message": "the payment did not settle. Not delivered; nothing was charged.",
            "reason": _cut(php_str(reason), 200),
            "accepts": accepts,
        }, {"PAYMENT-REQUIRED": Json.base64(doc)})

    @staticmethod
    def _delivered(response):
        return {"ok": True, "status": 200, "response": response, "headers": {"PAYMENT-RESPONSE": Json.base64(response)}}

    @staticmethod
    def charge_of(hold, charge):
        reserved = Verify.uint(hold["requirement"]["amount"])
        if charge is None:
            return reserved
        c = int(str(charge), 10)
        if c < 0 or c > reserved:
            raise ValueError(f"a charge of {c} is outside 0 to the reserved {reserved}")
        return c

    @staticmethod
    def charged_extra(hold, charged, extra=None):
        reserved = php_str(hold["requirement"]["amount"])
        out = dict(extra or {})
        out["chargedAmount"] = str(charged)
        out["reservedAmount"] = reserved
        return out

    def settle(self, hold, charge=None):
        try:
            c = Server.charge_of(hold, charge)
            if hold["kind"] == "voucher":
                return self._settle_voucher(hold, c)
            if hold["kind"] == "deposit":
                return self._settle_deposit(hold, c)
            return self._settle_failed(hold, Reason.PAYLOAD_TYPE)
        except Exception as e:
            return self._settle_failed(hold, str(e))

    def _settle_voucher(self, hold, increment=None):
        req = hold["requirement"]
        voucher = hold["payload"]["payload"]["voucher"]
        increment = Verify.uint(req["amount"]) if increment is None else increment
        cap = Verify.uint(voucher["maxClaimableAmount"])
        pending_id = hold["pendingId"]
        now = self.cfg.now_ms()
        box = {"outcome": None, "previous": None, "charged": None}

        def commit(current):
            if current is None:
                box["outcome"] = "missing"
                return current
            if _get(current, "pendingRequest", "pendingId") is None or current["pendingRequest"]["pendingId"] != pending_id:
                box["outcome"] = "pending_mismatch"
                return current
            nxt = int(php_str(current["chargedCumulativeAmount"])) + increment
            if nxt > cap:
                box["outcome"] = "cap_exceeded"
                del current["pendingRequest"]
                return current
            box["previous"] = dict(current)
            box["charged"] = str(nxt)
            current["chargedCumulativeAmount"] = box["charged"]
            current["signedMaxClaimable"] = php_str(cap)
            current["signature"] = voucher["signature"]
            current["lastRequestTimestamp"] = now
            del current["pendingRequest"]
            box["outcome"] = "committed"
            return current

        self.store.update(hold["channelId"], commit)
        if box["outcome"] == "missing":
            return self._settle_failed(hold, Reason.MISSING_CHANNEL)
        if box["outcome"] == "cap_exceeded":
            return self._settle_failed(hold, Reason.CHARGE_EXCEEDS_SIGNED_CUMULATIVE)
        if box["outcome"] != "committed":
            return self._settle_failed(hold, Reason.CHANNEL_BUSY)
        previous = box["previous"]
        return Server._delivered({
            "success": True,
            "payer": php_str(previous["channelConfig"]["payer"]).lower(),
            "transaction": "",
            "network": req["network"],
            "amount": "",
            "extra": Server.charged_extra(hold, increment, {"channelState": Server._channel_state(previous, box["charged"])}),
        })

    def _settle_deposit(self, hold, increment=None):
        req = hold["requirement"]
        increment = Verify.uint(req["amount"]) if increment is None else increment
        micro = self.micro(hold.get("micro"))
        payload = hold["payload"]
        raw = payload["payload"]
        channel_id = hold["channelId"]
        self.channels.repaired(channel_id)
        floor = self.gas_quote.deposit_floor_micro_usd(micro)
        quoted = to_int(self.cfg.micro_usd_of(req["asset"], req["amount"]))
        arriving = to_int(self.cfg.micro_usd_of(req["asset"], str(Verify.uint(raw["deposit"]["amount"]))))
        if quoted + 1 < micro or arriving < floor:
            return self._deposit_short(hold, payload, floor, micro)
        verified = self.verify.facilitator(payload, req)
        if not verified["isValid"]:
            return self._settle_failed(hold, verified.get("invalidReason") if verified.get("invalidReason") is not None else Reason.PAYLOAD_TYPE)
        execution = verified["execution"]
        amount = str(Verify.uint(raw["deposit"]["amount"]))
        data = BatchSettlement.encode_deposit(raw["channelConfig"], amount, execution["collector"], execution["collectorData"])
        sent = self.relay.send([{"to": BatchSettlement.ESCROW, "data": data}], self.cfg.relay_split())
        if "hash" not in sent[0]:
            short = re.search(r"below break-even: deposit at least \$(\d+(?:\.\d+)?)", php_str(sent[0].get("error") or ""))
            if short is not None:
                return self._deposit_short(hold, payload, math.ceil(float(short.group(1)) * 1e6), micro)
            return self._settle_failed(hold, Reason.DEPOSIT_TRANSACTION_FAILED + ": " + (sent[0].get("error") or "no hash"))
        tx_hash = sent[0]["hash"]
        receipt = self._wait_for_receipt(tx_hash)
        if receipt is None:
            return self._settle_failed(hold, Reason.DEPOSIT_TRANSACTION_FAILED + f": no receipt for {tx_hash}")
        if php_str(receipt.get("status")).lower() != "0x1":
            return self._settle_failed(hold, Reason.DEPOSIT_TRANSACTION_FAILED + ": transaction reverted (receipt status reverted)")
        ex = verified["extra"]
        state = {
            "channelId": raw["voucher"]["channelId"],
            "balance": str(int(php_str(ex["balance"])) + int(amount)),
            "totalClaimed": php_str(ex["totalClaimed"]),
            "withdrawRequestedAt": to_int(ex["withdrawRequestedAt"]),
            "refundNonce": php_str(ex["refundNonce"]),
        }
        expected = int(state["balance"])
        deadline = self.cfg.now_ms() + self.cfg.stateCatchUpMs
        post = None
        while True:
            try:
                post = self.chain.state(channel_id)
            except Exception:
                post = None
            if post is not None and int(post["balance"]) >= expected:
                break
            if self.cfg.now_ms() >= deadline:
                post = None
                break
            self.cfg.sleep_ms(150)
        if post is not None:
            state = {
                "channelId": raw["voucher"]["channelId"],
                "balance": post["balance"],
                "totalClaimed": post["totalClaimed"],
                "withdrawRequestedAt": post["withdrawRequestedAt"],
                "refundNonce": post["refundNonce"],
            }
        pending_id = hold["pendingId"]
        now = self.cfg.now_ms()
        box = {"record": None}

        def commit(current):
            if current is None or _get(current, "pendingRequest", "pendingId") is None or current["pendingRequest"]["pendingId"] != pending_id:
                return current
            nxt = {
                "channelId": raw["voucher"]["channelId"],
                "channelConfig": raw["channelConfig"],
                "chargedCumulativeAmount": str(int(php_str(current["chargedCumulativeAmount"])) + increment),
                "signedMaxClaimable": php_str(Verify.uint(raw["voucher"]["maxClaimableAmount"])),
                "signature": raw["voucher"]["signature"],
                "balance": state["balance"],
                "totalClaimed": state["totalClaimed"],
                "withdrawRequestedAt": to_int(state["withdrawRequestedAt"]),
                "refundNonce": to_int(state["refundNonce"]),
                "onchainSyncedAt": now,
                "lastRequestTimestamp": now,
            }
            for k, v in current.items():
                if k not in SDK_FIELDS:
                    nxt[k] = v
            held_before = int(php_str(ex["balance"])) > 0 or int(php_str(ex["totalClaimed"])) > 0
            nxt["depositsWePaid"] = to_int(current.get("depositsWePaid", 1 if held_before else 0)) + 1
            box["record"] = nxt
            return nxt

        self.store.update(channel_id, commit)
        if box["record"] is None:
            return self._settle_failed(hold, f"{Reason.CHANNEL_BUSY}: deposit {tx_hash} landed after the hold expired. Not charged, not delivered.")
        extra = Server.charged_extra(hold, increment, {"channelState": dict(state, chargedCumulativeAmount=box["record"]["chargedCumulativeAmount"])})
        response = {
            "success": True,
            "transaction": tx_hash,
            "network": req["network"],
            "payer": raw["channelConfig"]["payer"],
            "amount": raw["deposit"]["amount"],
            "extra": extra,
        }
        response["extra"]["depositAmount"] = response["amount"]
        if php_str(response["amount"]) != php_str(req["amount"]):
            response["amount"] = php_str(req["amount"])
        return Server._delivered(response)

    def _wait_for_receipt(self, tx_hash):
        deadline = self.cfg.now_ms() + 1000 * self.cfg.receiptTimeoutSecs
        while True:
            try:
                r = self.chain.receipt(tx_hash)
            except Exception:
                r = None
            if r is not None:
                return r
            if self.cfg.now_ms() >= deadline:
                return None
            self.cfg.sleep_ms(self.cfg.receiptPollMs)
