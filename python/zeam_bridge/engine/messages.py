import math
import re
import time

from .core import Address, Keccak, Secp256k1
from .php import is_numeric, php_empty, php_str, strtotime, to_float, to_int
from .splits import Splits

_BUDGET = re.compile(r"^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$")
_UNITS = {"ms": 1, "s": 1000, "m": 60000, "h": 3600000, "d": 86400000}


class BridgeMessages:
    REALM = "ZEAM Pass"

    @staticmethod
    def grant_message(realm, grant):
        scope = grant["scope"] if grant.get("scope") is not None else "self"
        message = (f"{realm} grant\ndelegate: " + php_str(grant.get("delegate")).lower()
                   + "\nscope: " + php_str(scope).lower()
                   + "\nuntil: " + php_str(grant.get("until")))
        if grant.get("budget") is not None and grant.get("budget") != "":
            message += "\nbudget: " + php_str(grant["budget"])
        return message

    @staticmethod
    def grant_id(message):
        return Keccak.utf8(message)

    @staticmethod
    def budget_ms(budget):
        if budget is None or budget == "":
            return None
        m = _BUDGET.match(php_str(budget).strip())
        if not m:
            return False
        unit = _UNITS[m.group(2)] if m.group(2) else 1
        return int(math.floor(float(m.group(1)) * unit))

    @staticmethod
    def sign_grant(key, realm, grant):
        return Secp256k1.personal_sign(key, BridgeMessages.grant_message(realm, grant))

    @staticmethod
    def verify_grant(realm, grant, now_ms=None):
        if isinstance(grant, list):
            return {"ok": False, "why": "a grant needs delegate, until and signature"}
        if not isinstance(grant, dict):
            return {"ok": False, "why": "no grant"}
        if php_empty(grant.get("delegate")) or php_empty(grant.get("until")) or php_empty(grant.get("signature")):
            return {"ok": False, "why": "a grant needs delegate, until and signature"}
        budget = grant.get("budget")
        ms = BridgeMessages.budget_ms(budget)
        if ms is False:
            return {"ok": False, "why": "budget is not a duration (250ms, 30s, 2h, 1d)"}
        t = strtotime(php_str(grant["until"]))
        if t is None:
            return {"ok": False, "why": "until is not a timestamp"}
        now = int(time.time() * 1000) if now_ms is None else int(now_ms)
        if t * 1000 <= now:
            return {"ok": False, "why": "grant expired at " + php_str(grant["until"])}
        scope = grant["scope"] if grant.get("scope") is not None else "self"
        message = BridgeMessages.grant_message(realm, {"delegate": grant["delegate"], "scope": scope, "until": grant["until"], "budget": budget})
        try:
            root = Secp256k1.recover_personal(message, grant["signature"]).lower()
        except ValueError as e:
            return {"ok": False, "why": "bad signature: " + str(e)[:80]}
        return {
            "ok": True,
            "root": root,
            "delegate": php_str(grant["delegate"]).lower(),
            "scope": php_str(scope).lower(),
            "until": grant["until"],
            "budget": budget,
            "budgetMs": ms,
            "message": message,
            "id": BridgeMessages.grant_id(message),
        }

    @staticmethod
    def note_message(note):
        return ("ZEAM Pass gate credit\nid: " + php_str(note.get("id"))
                + "\nseller: " + php_str(note.get("seller")).lower()
                + "\nname: " + php_str(note.get("name"))
                + "\nchecks: " + php_str(note.get("checks"))
                + "\nissued: " + php_str(note.get("issued")))

    @staticmethod
    def sign_note(key, note):
        return Secp256k1.personal_sign(key, BridgeMessages.note_message(note))

    @staticmethod
    def verify_note(note, issuer):
        checks = note.get("checks") if isinstance(note, dict) else None
        if (not isinstance(note, dict) or php_empty(note.get("id")) or php_empty(note.get("signature"))
                or not (is_numeric(checks) and to_float(checks) > 0)):
            return {"ok": False, "why": "not a credit note"}
        if Secp256k1.verify_personal(issuer, BridgeMessages.note_message(note), note["signature"]):
            return {"ok": True, "checks": to_int(checks)}
        return {"ok": False, "why": "the note is not signed by ZEAM"}

    @staticmethod
    def seller_split(payout, fee, name, whole=False):
        if whole and Address.checksum(payout) != Address.checksum(fee):
            raise ValueError("payoutIsFeeRecipient needs the payout to be the fee recipient")
        split = Splits.whole_split(fee) if whole else Splits.fee_split(payout, fee)
        salt = Splits.salt_for(BridgeMessages.REALM, name)
        return {"split": split, "salt": salt, "owner": Address.ZERO, "address": Splits.predict_address(split, Address.ZERO, salt)}


PassMessages = BridgeMessages
