import re

from ..batch_settlement import BatchSettlement, Erc20
from ..core import Address, Hex, Num, Secp256k1
from ..php import is_int, php_describe, php_empty, php_str
from .jsonx import Json

_NETWORK = re.compile(r"^eip155:(\d+)")
_NUMBER = re.compile(r"^(0x[0-9a-fA-F]+|-?[0-9]+)$")
_XDIGITS = re.compile(r"^[0-9a-fA-F]+$")
MAX_UINT256 = (1 << 256) - 1


class Exact:
    NETWORK = "eip155:8453"
    MAX_TIMEOUT_SECONDS = 300
    VALID_BEFORE_MARGIN = 6

    @staticmethod
    def requirement(amount, pay_to, options=None):
        options = options or {}
        return {
            "scheme": "exact",
            "network": str(options["network"]) if options.get("network") is not None else Exact.NETWORK,
            "amount": php_str(amount),
            "asset": str(options["asset"]) if options.get("asset") is not None else Erc20.USDC_BASE,
            "payTo": php_str(pay_to),
            "maxTimeoutSeconds": int(options["maxTimeoutSeconds"]) if options.get("maxTimeoutSeconds") is not None else Exact.MAX_TIMEOUT_SECONDS,
            "extra": {
                "name": str(options["assetName"]) if options.get("assetName") is not None else Erc20.USDC_BASE_NAME,
                "version": str(options["assetVersion"]) if options.get("assetVersion") is not None else Erc20.USDC_BASE_VERSION,
            },
        }

    @staticmethod
    def chain_id(network):
        m = _NETWORK.match(network) if isinstance(network, str) else None
        if not m:
            raise ValueError("not an eip155 network: " + php_describe(network))
        return int(m.group(1))

    @staticmethod
    def encode_header(value):
        return Json.base64_encode(Json.encode(value))

    @staticmethod
    def decode_header(value):
        raw = Json.base64_decode(value)
        if raw is None:
            return None
        ok, decoded = Json.decode(raw)
        return decoded if ok else None

    @staticmethod
    def matches(requirement, payload):
        if not isinstance(payload, dict) or payload.get("x402Version") is None or not isinstance(payload.get("accepted"), dict):
            return False
        version = payload["x402Version"]
        accepted = payload["accepted"]
        if is_int(version) and version == 1:
            return (accepted.get("scheme") is not None and accepted.get("network") is not None
                    and accepted["scheme"] == requirement["scheme"] and accepted["network"] == requirement["network"])
        if not (is_int(version) and version == 2):
            return False
        required = Json.to_object(requirement)
        accepted = dict(accepted)
        required_extra = required.pop("extra", None)
        accepted_extra = accepted.pop("extra", None)
        if not Json.deep_equal(required, accepted):
            return False
        return required_extra is None or Json.contains_subset(required_extra, accepted_extra)

    @staticmethod
    def is_address(value):
        if not isinstance(value, str) or not Address.is_address(value):
            return False
        return value.lower() == value or Address.checksum(value) == value

    @staticmethod
    def bigint(value):
        if isinstance(value, bool):
            return None
        if is_int(value):
            return Num.of(value)
        if isinstance(value, float) and value.is_integer():
            return Num.of(value)
        if not isinstance(value, str):
            return None
        v = value.strip()
        if v == "":
            return 0
        if _NUMBER.match(v):
            return Num.of(v)
        return None

    @staticmethod
    def token_domain(requirement):
        return BatchSettlement.token_domain(requirement["asset"], requirement["extra"]["name"], requirement["extra"]["version"], Exact.chain_id(requirement["network"]))

    @staticmethod
    def authorization_message(authorization):
        a = authorization
        if not isinstance(a, dict):
            return None
        for field in ("from", "to", "value", "validAfter", "validBefore", "nonce"):
            if field not in a:
                return None
        if not Exact.is_address(a["from"]) or not Exact.is_address(a["to"]) or not Hex.is_hex(a["nonce"], 32):
            return None
        message = {"from": a["from"], "to": a["to"], "nonce": a["nonce"]}
        for field in ("value", "validAfter", "validBefore"):
            n = Exact.bigint(a[field])
            if n is None or n < 0 or n > MAX_UINT256:
                return None
            message[field] = str(n)
        return {
            "from": message["from"],
            "to": message["to"],
            "value": message["value"],
            "validAfter": message["validAfter"],
            "validBefore": message["validBefore"],
            "nonce": message["nonce"],
        }

    @staticmethod
    def verify(payload, requirement, now_seconds):
        if not (is_int(payload.get("x402Version")) and payload["x402Version"] == 2):
            return "No facilitator registered for x402 version: " + php_str(payload.get("x402Version"))
        inner = payload.get("payload") if isinstance(payload.get("payload"), dict) else None
        auth = inner.get("authorization") if inner is not None and isinstance(inner.get("authorization"), dict) else None
        if auth is None or not isinstance(inner.get("signature"), str):
            return "invalid_exact_evm_payload"
        accepted = payload.get("accepted") if isinstance(payload.get("accepted"), dict) else {}
        if accepted.get("scheme") != "exact" or requirement["scheme"] != "exact":
            return "invalid_exact_evm_scheme"
        extra = requirement.get("extra") or {}
        if php_empty(extra.get("name")) or php_empty(extra.get("version")):
            return "invalid_exact_evm_missing_eip712_domain"
        if accepted.get("network") is None or accepted["network"] != requirement["network"]:
            return "invalid_exact_evm_network_mismatch"
        message = Exact.authorization_message(auth)
        sig = inner["signature"]
        body = sig[2:] if sig[:2] == "0x" else sig
        if message is None or len(body) != 130 or not _XDIGITS.match(body):
            return "invalid_exact_evm_signature"
        try:
            signer = Secp256k1.recover_typed_data(Exact.token_domain(requirement), BatchSettlement.TRANSFER_AUTHORIZATION_TYPES,
                                                  "TransferWithAuthorization", message, "0x" + body)
        except ValueError:
            return "invalid_exact_evm_signature"
        if not Address.equals(signer, message["from"]):
            return "invalid_exact_evm_signature"
        if message["to"].lower() != php_str(requirement["payTo"]).lower():
            return "invalid_exact_evm_recipient_mismatch"
        if int(message["validBefore"]) < int(now_seconds) + Exact.VALID_BEFORE_MARGIN:
            return "invalid_exact_evm_payload_authorization_valid_before"
        if int(message["validAfter"]) > int(now_seconds):
            return "invalid_exact_evm_payload_authorization_valid_after"
        amount = Exact.bigint(requirement["amount"])
        if amount is None or int(message["value"]) != amount:
            return "invalid_exact_evm_payload_authorization_value_mismatch"
        v = int(body[128:130], 16)
        if v not in (27, 28) or not Secp256k1.is_low_s("0x" + body):
            return "invalid_exact_evm_signature_not_accepted_by_token"
        return None

    @staticmethod
    def authorize(key, requirement, now_seconds, nonce):
        authorization = {
            "from": Secp256k1.private_key_to_address(key),
            "to": Address.checksum(requirement["payTo"]),
            "value": requirement["amount"],
            "validAfter": "0",
            "validBefore": str(int(now_seconds) + int(requirement["maxTimeoutSeconds"])),
            "nonce": nonce.lower(),
        }
        signature = Secp256k1.sign_typed_data(key, Exact.token_domain(requirement), BatchSettlement.TRANSFER_AUTHORIZATION_TYPES,
                                              "TransferWithAuthorization", Exact.authorization_message(authorization))
        return {"authorization": authorization, "signature": signature}

    @staticmethod
    def payment_payload(payment_required, requirement, inner):
        payload = {"x402Version": payment_required["x402Version"], "payload": inner}
        if "extensions" in payment_required:
            payload["extensions"] = payment_required["extensions"]
        if "resource" in payment_required:
            payload["resource"] = payment_required["resource"]
        payload["accepted"] = requirement
        return payload
