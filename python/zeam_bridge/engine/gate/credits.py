import json
import math
import re
import secrets
import time
import urllib.parse

from ..batch_settlement import Erc20
from ..core import Address, Num, Secp256k1
from ..messages import BridgeMessages
from ..php import is_int, is_scalar, php_empty, php_str
from .exact import Exact
from .http import Http

_NAME = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
_CHECKS = re.compile(r"^[1-9][0-9]*$")


def _raw(value):
    return urllib.parse.quote(php_str(value), safe="-_.~")


class Credits:
    MICRO_PER_THOUSAND = 500000

    def __init__(self, meter, issuer=None, options=None):
        options = options or {}
        self.meter = meter
        self.issuer = issuer
        self.http = options["http"] if callable(options.get("http")) else Http()
        self._now = options.get("now") if callable(options.get("now")) else None
        self.random = options["random"] if callable(options.get("random")) else secrets.token_bytes
        self.max_micro_per_thousand = int(options["maxMicroPerThousand"]) if options.get("maxMicroPerThousand") is not None else self.MICRO_PER_THOUSAND

    def _now_ms(self):
        return int(self._now()) if self._now is not None else int(time.time() * 1000)

    @staticmethod
    def price_micro(checks, micro_per_thousand=MICRO_PER_THOUSAND):
        return int(math.ceil((int(checks) / 1000) * micro_per_thousand))

    def add_note(self, note, issuer, seller_payout, name):
        if not issuer or not Address.is_address(issuer):
            return {"ok": False, "why": "this Bridge has no credit issuer set"}
        if not isinstance(note, dict):
            return {"ok": False, "why": "not a credit note"}
        for field in ("id", "seller", "name", "checks", "issued", "signature"):
            if field not in note or not is_scalar(note[field]):
                return {"ok": False, "why": "not a credit note"}
        if not Address.equals(php_str(note["seller"]), php_str(seller_payout)) or note["name"] != name:
            return {"ok": False, "why": "the note is for another seller"}
        checks = note["checks"]
        if not is_int(checks) and not (isinstance(checks, str) and _CHECKS.match(checks)):
            return {"ok": False, "why": "not a credit note"}
        v = BridgeMessages.verify_note(note, issuer)
        if not v["ok"]:
            return v
        added = self.meter.add_credit(note["id"], v["checks"])
        if not added["ok"]:
            return added
        return {"ok": True, "checks": v["checks"], "credit": added["credit"]}

    @staticmethod
    def credit_request_url(credit_url, checks, seller_payout, name):
        return (php_str(credit_url).rstrip("/") + "/credits?checks=" + _raw(checks)
                + "&seller=" + _raw(seller_payout) + "&name=" + _raw(name))

    @staticmethod
    def select_requirement(payment_required):
        if not isinstance(payment_required, dict) or not isinstance(payment_required.get("accepts"), list):
            return None
        for req in payment_required["accepts"]:
            if not isinstance(req, dict) or req.get("scheme") is None or req.get("network") is None or req["scheme"] != "exact" or req["network"] != Exact.NETWORK:
                continue
            flow = req["extra"].get("paymentFlow") if isinstance(req.get("extra"), dict) else None
            if flow is not None and flow != "authorization":
                continue
            return req
        return None

    @staticmethod
    def _fail(code, why, status=None):
        return {"ok": False, "code": code, "why": why, "status": status}

    def sign(self, payment_required, credit_key, checks):
        req = Credits.select_requirement(payment_required)
        if req is None:
            return Credits._fail("no_requirement", f"the credit service asked for nothing this client pays (exact on {Exact.NETWORK})")
        extra = req.get("extra") if isinstance(req.get("extra"), dict) else {}
        if extra.get("assetTransferMethod") is not None and extra["assetTransferMethod"] != "eip3009":
            return Credits._fail("no_requirement", "the credit service asked for " + php_str(extra["assetTransferMethod"]) + "; this client signs EIP-3009 only")
        if (php_empty(extra.get("name")) or php_empty(extra.get("version")) or req.get("asset") is None or req.get("payTo") is None
                or req.get("amount") is None or req.get("maxTimeoutSeconds") is None):
            return Credits._fail("bad_requirement", "the requirement is missing its asset, payTo, amount, timeout or EIP-712 domain")
        if (not isinstance(req["asset"], str) or not Address.equals(req["asset"], Erc20.USDC_BASE) or not isinstance(req["payTo"], str)
                or not Address.is_address(req["payTo"]) or not is_int(req["maxTimeoutSeconds"]) or req["maxTimeoutSeconds"] < 1):
            return Credits._fail("bad_requirement", "the requirement is not USDC on Base to an address")
        amount = Exact.bigint(req["amount"])
        ceiling = Credits.price_micro(checks, self.max_micro_per_thousand)
        if amount is None or amount < 0 or amount > ceiling:
            asked = php_str(req["amount"]) if is_scalar(req["amount"]) else "?"
            return Credits._fail("overpriced", f"the credit service asked {asked} micro-USDC for {checks} checks; the ceiling is {ceiling}")
        nonce = "0x" + self.random(32).hex()
        inner = Exact.authorize(credit_key, req, self._now_ms() // 1000, nonce)
        payload = Exact.payment_payload(payment_required, req, inner)
        return {"ok": True, "payload": payload, "header": Exact.encode_header(payload), "requirement": req}

    def buy(self, credit_url, checks, credit_key, seller_payout, name, rpc=None):
        checks = int(checks)
        if checks < 1000 or checks % 1000 != 0:
            return Credits._fail("bad_checks", "checks is a multiple of 1,000")
        if not Address.is_address(seller_payout) or not _NAME.match(php_str(name)):
            return Credits._fail("bad_seller", "seller is the seller's payout address and name its Bridge name")
        url = Credits.credit_request_url(credit_url, checks, seller_payout, name)
        try:
            first = self.http("POST", url, {}, None)
        except Exception as e:
            return Credits._fail("unreachable", str(e))
        if first["status"] == 200:
            return self._finish(first, seller_payout, name)
        if first["status"] != 402:
            return Credits._fail("unexpected_status", f"the credit service answered HTTP {first['status']}", first["status"])
        headers = {k.lower(): v for k, v in (first.get("headers") or {}).items()}
        payment_required = Exact.decode_header(headers["payment-required"]) if headers.get("payment-required") else None
        if not isinstance(payment_required, dict) or not (is_int(payment_required.get("x402Version")) and payment_required["x402Version"] == 2):
            return Credits._fail("no_requirement", "the 402 carries no x402 v2 PAYMENT-REQUIRED header", 402)
        signed = self.sign(payment_required, credit_key, checks)
        if not signed["ok"]:
            return signed
        if rpc is not None and callable(getattr(rpc, "eth_call", None)):
            try:
                sender = Secp256k1.private_key_to_address(credit_key)
                balance = Num.of(Erc20.decode_uint256(rpc.eth_call(Erc20.USDC_BASE, Erc20.encode_balance_of(sender))))
            except Exception as e:
                return Credits._fail("rpc", f"could not read the credit key's USDC balance: {e}")
            if balance < Exact.bigint(signed["requirement"]["amount"]):
                return Credits._fail("insufficient_usdc", f"{sender} holds {balance} micro-USDC; the credit costs {signed['requirement']['amount']}")
        try:
            second = self.http("POST", url, {
                "PAYMENT-SIGNATURE": signed["header"],
                "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
            }, None)
        except Exception as e:
            return Credits._fail("unreachable", str(e))
        return self._finish(second, seller_payout, name)

    def _finish(self, response, seller_payout, name):
        try:
            note = json.loads(php_str(response.get("body")))
        except ValueError:
            note = None
        if response["status"] != 200:
            error = php_str(note["error"]) if isinstance(note, dict) and is_scalar(note.get("error")) else f"HTTP {response['status']}"
            reason = ": " + php_str(note["reason"]) if isinstance(note, dict) and is_scalar(note.get("reason")) else ""
            return Credits._fail("not_bought", f"could not buy credit ({response['status']} {error}{reason})", response["status"])
        if not isinstance(note, (dict, list)):
            return Credits._fail("not_bought", "the credit service answered 200 without a note", 200)
        added = self.add_note(note, self.issuer, seller_payout, name) if self.issuer else {"ok": False, "why": "this Bridge has no credit issuer set"}
        return {"ok": added["ok"], "note": note, "added": added}
