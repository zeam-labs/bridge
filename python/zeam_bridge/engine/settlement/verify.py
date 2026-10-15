import re

from ..batch_settlement import BatchSettlement
from ..core import Address, Hex, Secp256k1
from ..php import is_int, php_describe, php_empty, php_str, to_int
from ..rpc import RpcError
from ..typed_data import TypedData
from .chain import Chain
from .config import Config
from .reason import Reason

ZERO = "0x0000000000000000000000000000000000000000"
_CHANNEL = re.compile(r"^0x[0-9a-fA-F]{64}$")
_NETWORK = re.compile(r"^eip155:(\d+)$")
_DEC = re.compile(r"^[0-9]+$")
_HEXNUM = re.compile(r"^0x[0-9a-fA-F]+$")


def _get(value, *path):
    for key in path:
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value


def _dict(value):
    return value if isinstance(value, dict) else {}


class Verify:
    ZERO = ZERO
    PERMIT2_WITNESS_TYPES = {
        "PermitWitnessTransferFrom": [
            {"name": "permitted", "type": "TokenPermissions"},
            {"name": "spender", "type": "address"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "witness", "type": "DepositWitness"},
        ],
        "TokenPermissions": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}],
        "DepositWitness": [{"name": "channelId", "type": "bytes32"}],
    }

    def __init__(self, cfg, chain):
        self.cfg = cfg
        self.chain = chain

    @staticmethod
    def is_voucher_fields(v):
        return isinstance(v, dict) and "channelId" in v and "maxClaimableAmount" in v and "signature" in v

    @staticmethod
    def is_deposit_payload(raw):
        return (isinstance(raw, dict) and raw.get("type") == "deposit" and "channelConfig" in raw
                and Verify.is_voucher_fields(raw.get("voucher"))
                and isinstance(raw.get("deposit"), dict) and isinstance(raw["deposit"].get("amount"), str)
                and isinstance(raw["deposit"].get("authorization"), dict))

    @staticmethod
    def is_voucher_payload(raw):
        return isinstance(raw, dict) and raw.get("type") == "voucher" and "channelConfig" in raw and Verify.is_voucher_fields(raw.get("voucher"))

    @staticmethod
    def is_refund_payload(raw):
        return isinstance(raw, dict) and raw.get("type") == "refund" and "channelConfig" in raw and Verify.is_voucher_fields(raw.get("voucher"))

    @staticmethod
    def chain_id_of(network):
        m = _NETWORK.match(network) if isinstance(network, str) else None
        if not m:
            raise ValueError("not an EVM network: " + php_describe(network))
        return int(m.group(1))

    @staticmethod
    def is_canonical_channel_id(ident):
        return isinstance(ident, str) and _CHANNEL.match(ident) is not None

    @staticmethod
    def strict_config(config):
        if not isinstance(config, dict):
            raise ValueError("channelConfig is not an object")
        for k in ("payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token"):
            a = config.get(k)
            if not Address.is_address(a):
                raise ValueError(f"channelConfig.{k} is not an address")
            body = a[2:]
            if body != body.lower() and body != body.upper() and not Address.is_checksummed(a):
                raise ValueError(f"channelConfig.{k} has a bad checksum")
        if not is_int(config.get("withdrawDelay")):
            raise ValueError("channelConfig.withdrawDelay is not a number")
        if not Hex.is_hex(config.get("salt"), 32):
            raise ValueError("channelConfig.salt is not 32 bytes")
        return config

    @staticmethod
    def compute_channel_id(config, network):
        return BatchSettlement.channel_id(Verify.strict_config(config), Verify.chain_id_of(network))

    @staticmethod
    def binding_error(config, channel_id, network):
        if not Verify.is_canonical_channel_id(channel_id):
            return Reason.CHANNEL_ID_INVALID
        if Verify.compute_channel_id(config, network).lower() != channel_id.lower():
            return Reason.CHANNEL_ID_MISMATCH
        return None

    @staticmethod
    def uint(value):
        if is_int(value) and value >= 0:
            return value
        if isinstance(value, str):
            v = value.strip()
            if _DEC.match(v):
                return int(v, 10)
            if _HEXNUM.match(v):
                return int(v[2:], 16)
        raise ValueError("not an unsigned integer: " + php_describe(value))

    MAX_SAFE = 9007199254740991
    AMOUNT_FORM = "voucher.maxClaimableAmount is not an unsigned integer: send it as a base-10 or 0x string, or as a whole JSON number up to 9007199254740991"

    @staticmethod
    def amount(value):
        if isinstance(value, bool):
            raise ValueError("not an unsigned integer: " + php_describe(value))
        if isinstance(value, int):
            if 0 <= value <= Verify.MAX_SAFE:
                return value
            raise ValueError("not an unsigned integer a JSON number can carry exactly: " + str(value))
        if isinstance(value, float):
            if value.is_integer() and 0 <= value <= Verify.MAX_SAFE:
                return int(value)
            raise ValueError("not an unsigned integer a JSON number can carry exactly: " + repr(value))
        if isinstance(value, str):
            return Verify.uint(value)
        raise ValueError("not an unsigned integer: " + php_describe(value))

    @staticmethod
    def normalize(raw):
        voucher = raw.get("voucher") if isinstance(raw, dict) else None
        if not isinstance(voucher, dict) or "maxClaimableAmount" not in voucher:
            return True
        try:
            voucher["maxClaimableAmount"] = str(Verify.amount(voucher["maxClaimableAmount"]))
            return True
        except ValueError:
            return False

    def config_error(self, config, channel_id, req):
        Verify.strict_config(config)
        extra = _dict(req.get("extra"))
        return BatchSettlement.validate_channel_config(
            config, channel_id, Verify.chain_id_of(req["network"]), req["payTo"],
            extra.get("receiverAuthorizer"), req["asset"],
            to_int(extra["withdrawDelay"]) if "withdrawDelay" in extra else None)

    def hash_signature_ok(self, address, digest, signature):
        try:
            code = self.chain.code(address)
        except Exception:
            return False
        if code in ("0x", ""):
            if not isinstance(signature, str) or len(re.sub(r"^0x", "", signature, flags=re.I)) != 130:
                return False
            return Verify.recovers(address, digest, signature)
        return self.chain.is_valid_signature(address, digest, signature)

    @staticmethod
    def recovers(address, digest, signature):
        try:
            return Secp256k1.is_canonical(signature) and Address.equals(Secp256k1.recover_hash(digest, signature), address)
        except Exception:
            return False

    def voucher_signature_ok(self, config, channel_id, maximum, signature, chain_id):
        try:
            digest = BatchSettlement.voucher_digest(channel_id, str(Verify.uint(maximum)), chain_id)
        except Exception:
            return False
        if config["payerAuthorizer"] != ZERO:
            return Verify.recovers(config["payerAuthorizer"], digest, signature)
        return self.hash_signature_ok(config["payer"], digest, signature)

    @staticmethod
    def invalid(reason, payer=None, message=None):
        out = {"isValid": False, "invalidReason": reason}
        if message is not None:
            out["invalidMessage"] = message
        if payer is not None:
            out["payer"] = payer
        return out

    def facilitator(self, payload, req):
        raw = payload.get("payload")
        accepted = _dict(payload.get("accepted"))
        if accepted.get("scheme") != Config.SCHEME or req["scheme"] != Config.SCHEME:
            return Verify.invalid(Reason.INVALID_SCHEME)
        if accepted.get("network") != req["network"]:
            return Verify.invalid(Reason.NETWORK_MISMATCH)
        try:
            if Verify.is_deposit_payload(raw):
                return self.deposit(raw, req)
            if Verify.is_voucher_payload(raw):
                return self.voucher(raw, req)
        except RpcError as e:
            return Verify.invalid(Reason.RPC_READ_FAILED, None, str(e))
        except Exception as e:
            return Verify.invalid(str(e))
        return Verify.invalid(Reason.PAYLOAD_TYPE)

    @staticmethod
    def _payer(raw):
        return _get(raw, "channelConfig", "payer")

    def voucher(self, raw, req):
        config = raw["channelConfig"]
        payer = Verify._payer(raw)
        channel_id = raw["voucher"]["channelId"]
        err = self.config_error(config, channel_id, req)
        if err:
            return Verify.invalid(err, payer)
        if not self.voucher_signature_ok(config, channel_id, raw["voucher"]["maxClaimableAmount"], raw["voucher"]["signature"], Verify.chain_id_of(req["network"])):
            return Verify.invalid(Reason.VOUCHER_SIGNATURE, payer)
        try:
            state = self.chain.state(channel_id)
        except Exception as e:
            return Verify.invalid(Reason.RPC_READ_FAILED, payer, str(e))
        balance = int(state["balance"])
        if balance == 0:
            return Verify.invalid(Reason.CHANNEL_NOT_FOUND, payer)
        maximum = Verify.uint(raw["voucher"]["maxClaimableAmount"])
        if maximum > balance:
            return Verify.invalid(Reason.EXCEEDS_BALANCE, payer)
        if maximum <= int(state["totalClaimed"]):
            return Verify.invalid(Reason.BELOW_CLAIMED, payer)
        return {
            "isValid": True,
            "payer": payer,
            "extra": {
                "channelId": channel_id,
                "balance": state["balance"],
                "totalClaimed": state["totalClaimed"],
                "withdrawRequestedAt": state["withdrawRequestedAt"],
                "refundNonce": state["refundNonce"],
            },
        }

    @staticmethod
    def transfer_method(raw, req):
        method = _get(req, "extra", "assetTransferMethod")
        if not php_empty(method):
            return method
        return "eip3009" if php_empty(_get(raw, "deposit", "authorization", "permit2Authorization")) else "permit2"

    def deposit(self, raw, req):
        config = raw["channelConfig"]
        payer = Verify._payer(raw)
        err = self.config_error(config, raw["voucher"]["channelId"], req)
        if err:
            return Verify.invalid(err, payer)
        method = Verify.transfer_method(raw, req)
        if method == "permit2" and php_empty(_get(raw, "deposit", "authorization", "permit2Authorization")):
            return Verify.invalid(Reason.PAYLOAD_TYPE, payer)
        fail = self._permit2(raw, req) if method == "permit2" else self._erc3009(raw, req)
        if fail:
            return fail
        shared = self._shared_deposit_state(raw, req)
        if not shared["ok"]:
            return shared["response"]
        execution = self.execution(raw, req)
        if "isValid" in execution:
            return execution
        try:
            self.chain.call(BatchSettlement.ESCROW, BatchSettlement.encode_deposit(
                config, str(Verify.uint(raw["deposit"]["amount"])), execution["collector"], execution["collectorData"]))
        except Exception as e:
            return Verify.invalid(Reason.DEPOSIT_SIMULATION_FAILED, payer, str(e))
        return {
            "isValid": True,
            "payer": payer,
            "extra": {
                "channelId": raw["voucher"]["channelId"],
                "balance": shared["balance"],
                "totalClaimed": shared["totalClaimed"],
                "withdrawRequestedAt": shared["withdrawRequestedAt"],
                "refundNonce": shared["refundNonce"],
            },
            "execution": execution,
        }

    def execution(self, raw, req):
        if Verify.transfer_method(raw, req) == "eip3009":
            return {
                "collector": BatchSettlement.ERC3009_DEPOSIT_COLLECTOR,
                "collectorData": BatchSettlement.erc3009_deposit_collector_data(raw["deposit"]["authorization"]["erc3009Authorization"]),
            }
        fail = self._permit2_allowance(raw, req)
        if fail:
            return fail
        auth = raw["deposit"]["authorization"]["permit2Authorization"]
        inner = BatchSettlement.parse_erc6492_signature(auth["signature"])
        return {
            "collector": BatchSettlement.PERMIT2_DEPOSIT_COLLECTOR,
            "collectorData": BatchSettlement.permit2_collector_data(str(Verify.uint(auth["nonce"])), str(Verify.uint(auth["deadline"])), inner["signature"], "0x"),
        }

    def _erc3009(self, raw, req):
        payer = Verify._payer(raw)
        auth = _get(raw, "deposit", "authorization", "erc3009Authorization")
        if not isinstance(auth, dict) or not auth:
            return Verify.invalid(Reason.ERC3009_AUTHORIZATION_REQUIRED, payer)
        extra = _dict(req.get("extra"))
        if php_empty(extra.get("name")) or php_empty(extra.get("version")):
            return Verify.invalid(Reason.MISSING_EIP712_DOMAIN, payer)
        valid_after = Verify.uint(auth.get("validAfter"))
        valid_before = Verify.uint(auth.get("validBefore"))
        now = self.cfg.now_ms() // 1000
        if valid_before < now + 6:
            return Verify.invalid(Reason.VALID_BEFORE, payer)
        if valid_after > now:
            return Verify.invalid(Reason.VALID_AFTER, payer)
        parsed = BatchSettlement.parse_erc6492_signature(auth.get("signature"))
        if parsed["address"] is not None and parsed["data"] is not None and not Address.equals(parsed["address"], ZERO):
            try:
                deployed = self.chain.has_code(payer)
            except Exception:
                deployed = False
            if not deployed:
                return Verify.invalid(Reason.FACTORY_NOT_ALLOWED, payer)
        chain_id = Verify.chain_id_of(req["network"])
        nonce = BatchSettlement.erc3009_deposit_nonce(raw["voucher"]["channelId"], auth.get("salt"))
        digest = BatchSettlement.receive_authorization_digest(
            BatchSettlement.token_domain(req["asset"], extra["name"], extra["version"], chain_id),
            BatchSettlement.receive_authorization(payer, str(Verify.uint(raw["deposit"]["amount"])), str(valid_after), str(valid_before), nonce))
        if not self.hash_signature_ok(payer, digest, parsed["signature"]):
            return Verify.invalid(Reason.RECEIVE_AUTHORIZATION_SIGNATURE, payer)
        return None

    def _permit2(self, raw, req):
        payer = Verify._payer(raw)
        auth = raw["deposit"]["authorization"]["permit2Authorization"]
        if not isinstance(auth, dict):
            return Verify.invalid(Reason.PERMIT2_AUTHORIZATION_REQUIRED, payer)
        if not Address.equals(Address.checksum(auth.get("from")), payer):
            return Verify.invalid(Reason.PERMIT2_INVALID_SIGNATURE, payer)
        if not Address.equals(Address.checksum(auth.get("spender")), BatchSettlement.PERMIT2_DEPOSIT_COLLECTOR):
            return Verify.invalid(Reason.PERMIT2_INVALID_SPENDER, payer)
        if not Address.equals(Address.checksum(_get(auth, "permitted", "token")), req["asset"]):
            return Verify.invalid(Reason.TOKEN_MISMATCH, payer)
        if Verify.uint(_get(auth, "permitted", "amount")) != Verify.uint(raw["deposit"]["amount"]):
            return Verify.invalid(Reason.PERMIT2_AMOUNT_MISMATCH, payer)
        if _get(auth, "witness", "channelId") is None or auth["witness"]["channelId"] != raw["voucher"]["channelId"]:
            return Verify.invalid(Reason.CHANNEL_ID_MISMATCH, payer)
        now = self.cfg.now_ms() // 1000
        if Verify.uint(auth.get("deadline")) < now + 6:
            return Verify.invalid(Reason.PERMIT2_DEADLINE_EXPIRED, payer)
        try:
            digest = TypedData.hash(
                {"name": "Permit2", "chainId": Verify.chain_id_of(req["network"]), "verifyingContract": Chain.PERMIT2},
                Verify.PERMIT2_WITNESS_TYPES,
                "PermitWitnessTransferFrom",
                {
                    "permitted": {"token": Address.checksum(auth["permitted"]["token"]), "amount": str(Verify.uint(auth["permitted"]["amount"]))},
                    "spender": Address.checksum(auth["spender"]),
                    "nonce": str(Verify.uint(auth.get("nonce"))),
                    "deadline": str(Verify.uint(auth["deadline"])),
                    "witness": {"channelId": auth["witness"]["channelId"]},
                })
        except Exception:
            return Verify.invalid(Reason.PERMIT2_INVALID_SIGNATURE, payer)
        if not self.hash_signature_ok(Address.checksum(auth["from"]), digest, auth.get("signature")):
            return Verify.invalid(Reason.PERMIT2_INVALID_SIGNATURE, payer)
        return self._permit2_allowance(raw, req)

    def _permit2_allowance(self, raw, req):
        payer = Verify._payer(raw)
        try:
            allowance = self.chain.allowance(req["asset"], payer, Chain.PERMIT2)
        except Exception:
            return Verify.invalid(Reason.PERMIT2_ALLOWANCE_REQUIRED, payer)
        if int(allowance) < Verify.uint(raw["deposit"]["amount"]):
            return Verify.invalid(Reason.PERMIT2_ALLOWANCE_REQUIRED, payer)
        return None

    def _shared_deposit_state(self, raw, req):
        config = raw["channelConfig"]
        payer = Verify._payer(raw)
        channel_id = raw["voucher"]["channelId"]
        err = self.config_error(config, channel_id, req)
        if err:
            return {"ok": False, "response": Verify.invalid(err, payer)}
        if not self.voucher_signature_ok(config, channel_id, raw["voucher"]["maxClaimableAmount"], raw["voucher"]["signature"], Verify.chain_id_of(req["network"])):
            return {"ok": False, "response": Verify.invalid(Reason.VOUCHER_SIGNATURE, payer)}
        try:
            ch = self.chain.channel(channel_id)
            payer_balance = self.chain.balance_of(req["asset"], payer)
            wd = self.chain.pending_withdrawal(channel_id)
            nonce = self.chain.refund_nonce(channel_id)
        except Exception as e:
            return {"ok": False, "response": Verify.invalid(Reason.RPC_READ_FAILED, payer, str(e))}
        amount = Verify.uint(raw["deposit"]["amount"])
        if int(payer_balance) < amount:
            return {"ok": False, "response": Verify.invalid(Reason.INSUFFICIENT_BALANCE, payer)}
        maximum = Verify.uint(raw["voucher"]["maxClaimableAmount"])
        if maximum > int(ch["balance"]) + amount:
            return {"ok": False, "response": Verify.invalid(Reason.EXCEEDS_BALANCE, payer)}
        if maximum <= int(ch["totalClaimed"]):
            return {"ok": False, "response": Verify.invalid(Reason.BELOW_CLAIMED, payer)}
        return {
            "ok": True,
            "balance": ch["balance"],
            "totalClaimed": ch["totalClaimed"],
            "withdrawRequestedAt": wd["initiatedAt"],
            "refundNonce": nonce,
        }

    def local(self, raw, req, channel, now):
        ttl = min(300000, max(30000, (max(0, self.cfg.withdrawDelay) * 1000) // 3))
        if channel is None or channel.get("onchainSyncedAt") is None or now - to_int(channel["onchainSyncedAt"]) > ttl:
            return None
        config = raw["channelConfig"]
        if _get(config, "payerAuthorizer") == ZERO:
            return None
        payer = Verify._payer(raw)
        channel_id = raw["voucher"]["channelId"]
        err = self.config_error(config, channel_id, req)
        if err:
            return Verify.invalid(err, payer)
        if Verify.compute_channel_id(config, req["network"]).lower() != str(channel["channelId"]).lower():
            return Verify.invalid(Reason.CHANNEL_ID_MISMATCH, payer)
        digest = BatchSettlement.voucher_digest(channel_id, str(Verify.uint(raw["voucher"]["maxClaimableAmount"])), Verify.chain_id_of(req["network"]))
        if not Verify.recovers(Address.checksum(config["payerAuthorizer"]), digest, raw["voucher"]["signature"]):
            return Verify.invalid(Reason.VOUCHER_SIGNATURE, payer)
        maximum = Verify.uint(raw["voucher"]["maxClaimableAmount"])
        if maximum > int(php_str(channel["balance"])):
            return None
        if maximum <= int(php_str(channel["totalClaimed"])):
            return Verify.invalid(Reason.BELOW_CLAIMED, payer)
        return {
            "isValid": True,
            "payer": payer,
            "extra": {
                "channelId": channel_id,
                "balance": php_str(channel["balance"]),
                "totalClaimed": php_str(channel["totalClaimed"]),
                "withdrawRequestedAt": to_int(channel.get("withdrawRequestedAt")),
                "refundNonce": php_str(channel.get("refundNonce")),
            },
        }
