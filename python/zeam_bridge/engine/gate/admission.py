import time

from ..core import Address
from ..messages import BridgeMessages
from ..php import is_int, is_scalar, php_str
from .exact import Exact
from .jsonx import Json, loads


class Admission:
    NOTE = "Sign this zero-value payment with your key. Nothing is paid. The key needs no funds and must be admitted here."
    SEEN_KEY = "x402-seen"
    MAX_SAFE_INTEGER = 9007199254740991

    def __init__(self, pay_to, store, options=None):
        options = options or {}
        self.pay_to = Address.checksum(pay_to)
        self.store = store
        self.realm = str(options["realm"]) if options.get("realm") is not None else BridgeMessages.REALM
        self.options = options

    def requirement(self, pay_to=None):
        return Exact.requirement("0", self.pay_to if pay_to is None else Address.checksum(pay_to), self.options)

    def payment_required(self, resource, pay_to=None):
        body = {
            "x402Version": 2,
            "resource": Json.to_object(resource),
            "accepts": [self.requirement(pay_to)],
            "realm": self.realm,
            "note": self.NOTE,
        }
        return {
            "status": 402,
            "headers": {"PAYMENT-REQUIRED": Exact.encode_header(body), "Cache-Control": "no-store"},
            "body": body,
        }

    @staticmethod
    def _now_ms(now):
        return int(time.time() * 1000) if now is None else int(now)

    @staticmethod
    def _refuse(code, why):
        return {"ok": False, "status": 403 if code == "refused" else 402, "code": code, "why": why}

    @staticmethod
    def scope_allows(scope, tool_name):
        if scope is None or scope in ("", "self", "*"):
            return True
        return php_str(scope).lower() == php_str(tool_name).lower()

    def seen(self, sender, nonce, now_ms):
        state = self.store.get(self.SEEN_KEY)
        key = sender.lower() + ":" + nonce.lower()
        return isinstance(state, dict) and state.get(key) is not None and state[key] >= now_ms

    def _claim(self, sender, nonce, until, now_ms):
        key = sender.lower() + ":" + nonce.lower()

        def change(state):
            state = state if isinstance(state, dict) else {}
            state = {k: v for k, v in state.items() if not v < now_ms}
            if key in state:
                return state, False
            state[key] = until
            return state, True

        return self.store.update(self.SEEN_KEY, change)

    def admit(self, payment_header_value, grant_header_value, tool_name, admit_list, now=None):
        t = Admission._now_ms(now)
        if not isinstance(payment_header_value, str) or payment_header_value == "":
            return Admission._refuse("no_payment", "no PAYMENT-SIGNATURE header")
        payload = Exact.decode_header(payment_header_value)
        if payload is None:
            return Admission._refuse("no_payment", "PAYMENT-SIGNATURE is not base64 JSON of an x402 payment")
        requirement = self.requirement()
        if not Exact.matches(requirement, payload):
            return Admission._refuse("no_matching_requirement", "the payment matches no accepted requirement")
        inner = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        auth = inner.get("authorization") if isinstance(inner.get("authorization"), dict) else None
        sender = php_str(auth["from"]).lower() if auth is not None and is_scalar(auth.get("from")) else ""
        nonce = php_str(auth["nonce"]) if auth is not None and is_scalar(auth.get("nonce")) else ""
        if sender == "" or nonce == "":
            return Admission._refuse("bad_payment", "no authorization in the payment")
        if self.seen(sender, nonce, t):
            return Admission._refuse("replayed", "this authorization was already used")
        try:
            invalid = Exact.verify(payload, requirement, t // 1000)
        except Exception as e:
            invalid = str(e)
        if invalid is not None:
            return Admission._refuse("invalid_payment", invalid)
        admitted = self.grant(sender, grant_header_value, tool_name, admit_list, t)
        if not admitted["ok"]:
            return admitted
        until = min(Exact.bigint(auth["validBefore"]) * 1000, Admission.MAX_SAFE_INTEGER)
        if not self._claim(sender, nonce, until, t):
            return Admission._refuse("replayed", "this authorization was already used")
        return admitted

    def grant(self, sender, grant_header_value, tool_name, admit_list, t):
        grant = None
        if isinstance(grant_header_value, str) and grant_header_value != "":
            raw = Json.base64_url_decode(grant_header_value)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                return Admission._refuse("bad_grant", "x-grant is not base64url JSON")
            ok, grant = loads(text, 32)
            if not ok:
                return Admission._refuse("bad_grant", "x-grant is not base64url JSON")
        if grant is None or grant is False or grant == "" or (is_int(grant) and grant == 0) or (isinstance(grant, float) and grant == 0.0):
            return self._direct(sender, admit_list)
        return self._delegated(sender, grant, tool_name, admit_list, t)

    @staticmethod
    def not_admitted_signer(root):
        return f"the grant's signer {root} is not admitted"

    @staticmethod
    def other_delegate(delegate, sender):
        return f"the grant's delegate is {delegate}; this call is signed by {sender}"

    @staticmethod
    def _admits(admit_list, address):
        return any(is_scalar(a) and php_str(a).lower() == address.lower() for a in admit_list)

    def _direct(self, sender, admit_list):
        if not Admission._admits(admit_list, sender):
            return Admission._refuse("refused", f"{sender} is not admitted")
        return {"ok": True, "signer": sender, "root": sender, "scope": "self", "until": None, "grant": None}

    def _delegated(self, sender, grant, tool_name, admit_list, t):
        if isinstance(grant, dict):
            for field in ("delegate", "until", "signature", "scope", "budget"):
                if grant.get(field) is not None and not is_scalar(grant[field]):
                    return Admission._refuse("bad_grant", "a grant needs delegate, until and signature")
        try:
            g = BridgeMessages.verify_grant(self.realm, grant, t)
        except Exception as e:
            g = {"ok": False, "why": "bad signature: " + str(e)[:80]}
        if not g["ok"]:
            return Admission._refuse("bad_grant", g["why"])
        if not Admission._admits(admit_list, g["root"]):
            return Admission._refuse("bad_grant", Admission.not_admitted_signer(g["root"]))
        if sender != g["delegate"]:
            return Admission._refuse("bad_grant", Admission.other_delegate(g["delegate"], sender))
        if not Admission.scope_allows(g["scope"], tool_name):
            return Admission._refuse("refused", "the grant's scope is " + g["scope"] + ", not this tool")
        return {"ok": True, "signer": sender, "root": g["root"], "scope": g["scope"], "until": g["until"], "grant": g["id"]}
