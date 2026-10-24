import base64
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone

from ..batch_settlement import BatchSettlement
from ..core import Address, Hex, Keccak, Secp256k1

_B64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_UINT = re.compile(r"^(0|[1-9][0-9]*)$")
_TOKEN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]$")
_UNPRINTABLE = re.compile(r"[^\x20-\x7e]")
_ESCAPED = re.compile(r'[\\"]')
_SCHEME = re.compile(r"^payment\s+(\S+)\s*$", re.IGNORECASE)
_TIME = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")
_PARAM_ORDER = ["id", "realm", "method", "intent", "expires", "digest", "header", "opaque", "description", "request"]
_BOUND = ["id", "realm", "method", "intent", "request", "expires", "digest", "header", "opaque"]
_PROBLEM = "https://paymentauth.org/problems/"
_TITLES = {"malformed-credential": "Malformed Credential", "invalid-challenge": "Invalid Challenge",
           "verification-failed": "Verification Failed", "payment-required": "Payment Required"}


class MppError(Exception):
    def __init__(self, type_, detail, more=None):
        super().__init__(detail)
        self.type = type_
        self.detail = detail
        self.more = more


def _malformed(detail):
    return MppError("malformed-credential", detail)


def _invalid(detail):
    return MppError("invalid-challenge", detail)


def _failed(detail):
    return MppError("verification-failed", detail)


def _is_object(value):
    return isinstance(value, dict)


def _trunc(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(f)


def _millis(text):
    m = _TIME.match(text) if isinstance(text, str) else None
    if m is None:
        return None
    zone = m.group(8)
    try:
        at = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), int(m.group(6)), tzinfo=timezone.utc)
    except ValueError:
        return None
    ms = int(at.timestamp()) * 1000 + (int((m.group(7)[1:] + "000")[:3]) if m.group(7) else 0)
    if zone not in ("Z", "z"):
        sign = 1 if zone[0] == "+" else -1
        ms -= sign * (int(zone[1:3]) * 60 + int(zone[4:6])) * 60000
    return ms


class Jcs:
    @staticmethod
    def encode(value):
        if value is None:
            return "null"
        if value is True:
            return "true"
        if value is False:
            return "false"
        if isinstance(value, str):
            return json.dumps(value, ensure_ascii=False)
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            if value != value or value in (float("inf"), float("-inf")):
                raise TypeError("a JSON number is finite")
            return str(int(value)) if value == int(value) and abs(value) < 2 ** 53 else repr(value)
        if isinstance(value, (list, tuple)):
            return "[" + ",".join(Jcs.encode(v) for v in value) + "]"
        if isinstance(value, dict):
            keys = sorted(value.keys(), key=lambda k: str(k).encode("utf-16-be", "surrogatepass"))
            return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + Jcs.encode(value[k]) for k in keys) + "}"
        raise TypeError("not encodable as JSON")


class Base64Url:
    @staticmethod
    def encode(data):
        return base64.urlsafe_b64encode(bytes(data)).decode().rstrip("=")

    @staticmethod
    def decode(text):
        if not isinstance(text, str) or not _B64URL.match(text):
            raise _malformed("not base64url")
        body = text[:-1] if len(text) % 4 == 1 else text
        return base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))

    @staticmethod
    def json(value):
        return Base64Url.encode(Jcs.encode(value).encode("utf-8"))

    @staticmethod
    def parse(text):
        raw = Base64Url.decode(text).decode("utf-8", "replace")

        def no_constant(name):
            raise ValueError(name)

        try:
            out = json.loads(raw, parse_constant=no_constant)
        except (ValueError, RecursionError):
            raise _malformed("not JSON")
        if not _is_object(out):
            raise _malformed("not a JSON object")
        return out


class Challenge:
    @staticmethod
    def id(secret, c):
        slots = [c["realm"], c["method"], c["intent"], c["request"], "" if c.get("expires") is None else c["expires"], "" if c.get("digest") is None else c["digest"]]
        if c.get("header") is not None:
            slots.append(c["header"])
        slots.append("" if c.get("opaque") is None else c["opaque"])
        key = secret if isinstance(secret, (bytes, bytearray)) else str(secret).encode("utf-8")
        return Base64Url.encode(hmac.new(bytes(key), "|".join(str(s) for s in slots).encode("utf-8"), hashlib.sha256).digest())

    @staticmethod
    def once():
        return {"n": Base64Url.encode(secrets.token_bytes(12))}

    @staticmethod
    def issue(secret, realm, method, intent, request, expires=None, description=None, opaque=None):
        c = {"realm": str(realm), "method": str(method), "intent": str(intent), "request": Base64Url.json(request)}
        if expires is not None:
            c["expires"] = str(expires)
        if opaque is not None:
            c["opaque"] = Base64Url.json(opaque)
        c["id"] = Challenge.id(secret, c)
        if description is not None and description != "":
            c["description"] = str(description)
        return c

    @staticmethod
    def bound(secret, c):
        if not _is_object(c):
            return False
        for k in ("id", "realm", "method", "intent", "request"):
            if not isinstance(c.get(k), str) or c[k] == "":
                return False
        for k in ("expires", "digest", "header", "opaque"):
            if c.get(k) is not None and not isinstance(c[k], str):
                return False
        return hmac.compare_digest(Challenge.id(secret, c).encode("utf-8"), c["id"].encode("utf-8"))

    @staticmethod
    def header(c):
        parts = []
        for k in _PARAM_ORDER:
            if c.get(k) is None:
                continue
            parts.append(f'{k}="' + _ESCAPED.sub(lambda m: "\\" + m.group(0), _UNPRINTABLE.sub("", str(c[k]))) + '"')
        return "Payment " + ", ".join(parts)

    @staticmethod
    def parse(value):
        out = []
        s = "" if value is None else str(value)
        n = len(s)
        i = 0
        current = None

        def ws(i):
            while i < n and s[i] in " \t":
                i += 1
            return i

        def token(i):
            start = i
            while i < n and _TOKEN.match(s[i]):
                i += 1
            return s[start:i], i

        while i < n:
            i = ws(i)
            if i < n and s[i] == ",":
                i += 1
                continue
            word, i = token(i)
            if word == "":
                break
            i = ws(i)
            if i >= n or s[i] != "=":
                current = {} if word.lower() == "payment" else None
                if current is not None:
                    out.append(current)
                continue
            i += 1
            i = ws(i)
            v = ""
            if i < n and s[i] == '"':
                i += 1
                while i < n and s[i] != '"':
                    if s[i] == "\\" and i + 1 < n:
                        i += 1
                    v += s[i]
                    i += 1
                i += 1
            else:
                v, i = token(i)
            if current is not None and word not in current:
                current[word] = v
        return [c for c in out if isinstance(c.get("id"), str) and c["id"] != "" and isinstance(c.get("method"), str)
                and isinstance(c.get("intent"), str) and isinstance(c.get("request"), str)]

    @staticmethod
    def echo(c):
        return {k: c[k] for k in _BOUND if c.get(k) is not None}

    @staticmethod
    def for_meta(c):
        return {**c, "request": Base64Url.parse(c["request"])}

    @staticmethod
    def from_meta(c):
        if not _is_object(c):
            return None
        out = dict(c)
        if _is_object(c.get("request")):
            out["request"] = Base64Url.json(c["request"])
        if _is_object(c.get("opaque")):
            out["opaque"] = Base64Url.json(c["opaque"])
        return out


class Credential:
    @staticmethod
    def is_one(header_value):
        return isinstance(header_value, str) and _SCHEME.match(header_value) is not None

    @staticmethod
    def parse(header_value):
        m = _SCHEME.match("" if header_value is None else str(header_value))
        if m is None:
            raise _malformed("the credential is `Payment <base64url>`")
        c = Base64Url.parse(m.group(1))
        if not _is_object(c.get("challenge")):
            raise _malformed("the credential carries no challenge")
        if not _is_object(c.get("payload")):
            raise _malformed("the credential carries no payload")
        if "source" in c and not isinstance(c["source"], str):
            raise _malformed("source is a string")
        return c

    @staticmethod
    def serialize(challenge, payload, source=None):
        c = {"challenge": Challenge.echo(challenge), "payload": payload}
        if source is not None:
            c["source"] = source
        return "Payment " + Base64Url.json(c)


class Receipt:
    @staticmethod
    def header(receipt):
        return Base64Url.json(receipt)

    @staticmethod
    def parse(value):
        return Base64Url.parse(("" if value is None else str(value)).strip())


class Problem:
    @staticmethod
    def body(type_, detail, title=None):
        return {"type": _PROBLEM + type_, "title": title if title is not None else _TITLES.get(type_, "Payment Problem"), "status": 402, "detail": str(detail)}

    @staticmethod
    def of(error):
        if isinstance(error, MppError):
            return {**Problem.body(error.type, error.detail), **(error.more or {})}
        return Problem.body("verification-failed", str(error))


class EvmCharge:
    METHOD = "evm"
    INTENT = "charge"
    PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

    @staticmethod
    def request(amount, currency, recipient, chain_id, decimals=None, description=None, external_id=None):
        if not _UINT.match(str(amount)) or int(str(amount)) <= 0:
            raise TypeError("a charge is a positive amount in base units")
        r = {"amount": str(amount), "currency": Address.checksum(currency), "recipient": Address.checksum(recipient),
             "methodDetails": {"chainId": int(chain_id), "credentialTypes": ["authorization"], "permit2Address": EvmCharge.PERMIT2}}
        if decimals is not None:
            r["methodDetails"]["decimals"] = int(decimals)
        if description is not None and description != "":
            r["description"] = str(description)
        if external_id is not None and external_id != "":
            r["externalId"] = str(external_id)
        return r

    @staticmethod
    def challenge_hashes(challenge):
        return [
            Keccak.utf8(json.dumps([challenge["id"], challenge["realm"]], separators=(",", ":"), ensure_ascii=False)),
            Keccak.hex(str(challenge["id"]).encode("utf-8") + str(challenge["realm"]).encode("utf-8")),
        ]

    @staticmethod
    def source(chain_id, address):
        return f"did:pkh:eip155:{int(chain_id)}:{Address.checksum(address)}"

    @staticmethod
    def payload(key, challenge, token_domain, now_secs):
        request = Base64Url.parse(challenge["request"])
        sender = Secp256k1.private_key_to_address(key)
        at = _millis(challenge["expires"]) if challenge.get("expires") else None
        expires = at // 1000 if at is not None else int(now_secs) + 300
        authorization = {"from": sender, "to": Address.checksum(request["recipient"]), "value": str(request["amount"]), "validAfter": "0",
                         "validBefore": str(expires), "nonce": EvmCharge.challenge_hashes(challenge)[0]}
        signature = BatchSettlement.sign_transfer_authorization(key, token_domain, authorization)
        return {"type": "authorization", **authorization, "signature": signature}

    @staticmethod
    def verify(secret, credential, expect, now_secs):
        c = credential["challenge"]
        if not Challenge.bound(secret, c):
            raise _invalid("this challenge was not issued here, or was altered")
        if c["method"] != EvmCharge.METHOD or c["intent"] != EvmCharge.INTENT:
            raise _invalid("not an evm charge challenge")
        if c["realm"] != expect["realm"]:
            raise _invalid("the challenge is for another realm")
        expires_at = None
        if c.get("expires") is not None:
            expires_at = _millis(c["expires"])
            if expires_at is None or expires_at / 1000 <= now_secs:
                raise _invalid("the challenge has expired")
        request = Base64Url.parse(c["request"])
        details = request.get("methodDetails") if _is_object(request.get("methodDetails")) else {}
        chain = _trunc(details.get("chainId"))
        if chain is None or chain != _trunc(expect["chainId"]):
            raise _invalid("the challenge is for another chain")
        if not Address.equals(request.get("currency"), expect["currency"]):
            raise _invalid("the challenge is for another currency")
        if not Address.equals(request.get("recipient"), expect["recipient"]):
            raise _invalid("the challenge pays another recipient")
        if isinstance(details.get("splits"), list) and len(details["splits"]):
            raise _failed("an authorization credential cannot carry splits")
        p = credential["payload"]
        if p.get("type") != "authorization":
            raise _malformed('this challenge takes payload type "authorization"')
        for k in ("from", "to"):
            if not Address.is_address(p.get(k)):
                raise _malformed(f"{k} is an address")
        for k in ("value", "validAfter", "validBefore"):
            if not isinstance(p.get(k), str) or not _UINT.match(p[k]):
                raise _malformed(f"{k} is a base-10 integer string")
        if not Hex.is_hex(p.get("nonce"), 32):
            raise _malformed("nonce is 32 bytes of hex")
        if not isinstance(p.get("signature"), str) or not Hex.is_hex(p["signature"]) or len(p["signature"]) < 130:
            raise _malformed("signature is hex")
        if not Address.equals(p["to"], request["recipient"]):
            raise _failed("the authorization pays another recipient")
        if p["value"] != str(request.get("amount")):
            raise _failed("the authorization is for another amount")
        if Hex.lower(p["nonce"]) not in EvmCharge.challenge_hashes(c):
            raise _failed("the authorization nonce is not bound to this challenge")
        if int(p["validAfter"]) > int(now_secs):
            raise _failed("the authorization is not valid yet")
        if int(p["validBefore"]) <= int(now_secs):
            raise _failed("the authorization has expired")
        if expires_at is not None and int(p["validBefore"]) > expires_at // 1000:
            raise _failed("the authorization outlives its challenge")
        authorization = {"from": Address.checksum(p["from"]), "to": Address.checksum(p["to"]), "value": p["value"], "validAfter": p["validAfter"],
                         "validBefore": p["validBefore"], "nonce": Hex.lower(p["nonce"])}
        signer = None
        if len(Hex.to_bin(p["signature"])) in (64, 65):
            if not Secp256k1.is_canonical(p["signature"]):
                raise _failed("the authorization signature is not in the form the token accepts: 65 bytes, v 27 or 28, low s")
            try:
                signer = Secp256k1.recover_hash(BatchSettlement.transfer_authorization_digest(expect["tokenDomain"], authorization), p["signature"])
            except ValueError:
                signer = None
            if signer is None or not Address.equals(signer, authorization["from"]):
                raise _failed("the authorization signature does not recover to its payer")
        source = EvmCharge.source(details["chainId"], authorization["from"])
        if credential.get("source") is not None and str(credential["source"]).lower() != source.lower():
            raise _failed("source is not the payer")
        return {"challenge": c, "request": request, "authorization": authorization, "signature": Hex.lower(p["signature"]), "payer": authorization["from"],
                "source": source, "ecdsa": signer is not None, "replayKey": authorization["from"].lower() + ":" + authorization["nonce"]}

    @staticmethod
    def call(verified):
        return {"to": Address.checksum(verified["request"]["currency"]),
                "data": BatchSettlement.encode_transfer_with_authorization(verified["authorization"], verified["signature"])}

    @staticmethod
    def receipt(verified, tx_hash, timestamp):
        r = {"method": EvmCharge.METHOD, "challengeId": verified["challenge"]["id"], "reference": Hex.lower(tx_hash), "status": "success",
             "timestamp": timestamp, "chainId": _trunc(verified["request"]["methodDetails"]["chainId"])}
        if "externalId" in verified["request"]:
            r["externalId"] = verified["request"]["externalId"]
        return r


class McpPayment:
    CREDENTIAL = "org.paymentauth/credential"
    REQUIRED = "org.paymentauth/payment-required"
    RECEIPT = "org.paymentauth/receipt"

    @staticmethod
    def header(meta):
        v = meta.get(McpPayment.CREDENTIAL) if _is_object(meta) else None
        if v is None:
            return ""
        ok = _is_object(v) and isinstance(v.get("payload"), (dict, list))
        challenge = Challenge.from_meta(v.get("challenge")) if ok else None
        if challenge is None:
            return "Payment e30"
        return Credential.serialize(challenge, v["payload"], v["source"] if isinstance(v.get("source"), str) else None)

    @staticmethod
    def required(header_value, body=None):
        challenges = Challenge.parse(header_value)
        if not challenges:
            return None
        out = {"httpStatus": 402, "challenges": [Challenge.for_meta(c) for c in challenges]}
        if _is_object(body) and isinstance(body.get("type"), str) and body["type"].startswith(_PROBLEM):
            out["problem"] = {**{k: v for k, v in body.items() if k not in ("accepts", "session")}, "status": 402}
        return out

    PAYMENT_REQUIRED = -32042
    VERIFICATION_FAILED = -32043
    INVALID_PARAMS = -32602
    SESSION = re.compile(r"^payment\.[A-Za-z0-9_-]{16}\Z")

    @staticmethod
    def capability():
        return {"methods": {EvmCharge.METHOD: {"intents": [EvmCharge.INTENT]}}}

    @staticmethod
    def declares(capabilities):
        experimental = capabilities.get("experimental") if _is_object(capabilities) else None
        return _is_object(experimental) and _is_object(experimental.get("payment"))

    @staticmethod
    def session(raw=None):
        return "payment." + Base64Url.encode(secrets.token_bytes(12) if raw is None else raw)

    @staticmethod
    def in_session(ident):
        return isinstance(ident, str) and McpPayment.SESSION.match(ident.strip(" \t")) is not None

    @staticmethod
    def params(message):
        if not _is_object(message) or not _is_object(message.get("params")):
            return message.get("params") if _is_object(message) else None
        p = message["params"]
        root = message["_meta"].get(McpPayment.CREDENTIAL) if _is_object(message.get("_meta")) else None
        if root is None or ("_meta" in p and not _is_object(p["_meta"])):
            return p
        if p.get("_meta", {}).get(McpPayment.CREDENTIAL) is not None:
            return p
        return {**p, "_meta": {**p.get("_meta", {}), McpPayment.CREDENTIAL: root}}

    @staticmethod
    def error(required, refused=None):
        if not _is_object(required) or not isinstance(required.get("challenges"), list) or not required["challenges"]:
            return None
        problem = required.get("problem")
        reason = "payment-required" if problem is None else str(problem.get("type"))[len(_PROBLEM):]
        data = {"httpStatus": 402, "challenges": required["challenges"]}
        if problem is not None:
            data["problem"] = problem
        if problem is None and _is_object(refused) and refused.get("error") == "bad_grant":
            said = {k: refused[k] for k in ("error", "message", "how", "contact") if isinstance(refused.get(k), str)}
            detail = refused.get("message")
            return {"code": McpPayment.VERIFICATION_FAILED, "message": "Payment Verification Failed",
                    "data": {**data, "failure": {"reason": "bad_grant", "detail": detail if isinstance(detail, str) else ""}, **said}}
        if reason == "payment-required":
            return {"code": McpPayment.PAYMENT_REQUIRED, "message": "Payment Required", "data": data}
        detail = str(problem.get("detail"))
        if reason == "malformed-credential":
            return {"code": McpPayment.INVALID_PARAMS, "message": "Invalid params", "data": {**data, "detail": detail}}
        return {"code": McpPayment.VERIFICATION_FAILED, "message": "Payment Verification Failed", "data": {**data, "failure": {"reason": reason, "detail": detail}}}
