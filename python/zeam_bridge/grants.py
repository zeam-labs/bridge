import datetime
import json
import re
import secrets
import time

from .engine.core import Address, Secp256k1
from .engine.gate import Exact, Json
from .engine.messages import BridgeMessages
from .engine.php import strtotime

_KEY = re.compile(r"^0x[0-9a-fA-F]{64}$")


def new_key():
    while True:
        key = "0x" + secrets.token_hex(32)
        try:
            Secp256k1.normalize_private_key(key)
            return key
        except ValueError:
            continue


def key_address(key):
    return Address.checksum(Secp256k1.private_key_to_address(key))


def _until_text(until):
    if isinstance(until, datetime.datetime):
        if until.tzinfo is None:
            raise TypeError("sign_grant: until is a timezone-aware datetime or an ISO time, like \"2026-10-01T00:00:00Z\"")
        return until.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(until, str) and until.strip() and "\n" not in until and "\r" not in until:
        return until.strip()
    raise TypeError("sign_grant: until is a timezone-aware datetime or an ISO time, like \"2026-10-01T00:00:00Z\"")


def sign_grant(key, delegate, until, scope="*", realm=BridgeMessages.REALM, now=None):
    if not isinstance(key, str) or not _KEY.match(key):
        raise TypeError("sign_grant: key is the private key of a key the seller admits, 0x and 64 hex digits")
    if not isinstance(delegate, str) or not Address.is_address(delegate):
        raise TypeError("sign_grant: delegate is the address of the key you let in")
    if not isinstance(scope, str) or not scope.strip() or "\n" in scope or "\r" in scope:
        raise TypeError("sign_grant: scope is one tool name, or \"*\" for every tool")
    text = _until_text(until)
    t = strtotime(text)
    if t is None:
        raise TypeError("sign_grant: until is not a time: " + text)
    if t <= (time.time() if now is None else now):
        raise TypeError("sign_grant: until is in the past: " + text)
    grant = {"delegate": delegate.lower(), "scope": scope.strip(), "until": text}
    grant["signature"] = BridgeMessages.sign_grant(key, realm, grant)
    return Json.base64_url_encode(json.dumps(grant, separators=(",", ":")))


def gate_proof(key, payment_required, now=None):
    terms = payment_required
    if isinstance(terms, str):
        terms = Exact.decode_header(terms)
    if not isinstance(terms, dict) or not isinstance(terms.get("accepts"), list):
        raise TypeError("gate_proof: payment_required is the 402 body, or its PAYMENT-REQUIRED header")
    row = next((a for a in terms["accepts"] if isinstance(a, dict) and a.get("scheme") == "exact" and str(a.get("amount")) == "0"), None)
    if row is None:
        raise TypeError("gate_proof: these terms ask for a payment, not a gate proof; there is no exact row of amount 0")
    seconds = int(time.time() if now is None else now)
    inner = Exact.authorize(key, row, seconds, "0x" + secrets.token_hex(32))
    return Exact.encode_header(Exact.payment_payload({"x402Version": terms.get("x402Version", 2), **terms}, row, inner))
