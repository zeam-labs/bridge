from .abi import Abi
from .core import Address, Hex, Keccak, Num, Secp256k1
from .typed_data import TypedData


def _t(*fields):
    return [{"name": n, "type": t} for n, t in fields]


class BatchSettlement:
    ESCROW = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003"
    ERC3009_DEPOSIT_COLLECTOR = "0x4020806089470a89826cB9fB1f4059150b550004"
    MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
    PERMIT2_DEPOSIT_COLLECTOR = "0x4020425FAf3B746C082C2f942b4E5159887B0005"
    DOMAIN_NAME = "x402 Batch Settlement"
    DOMAIN_VERSION = "1"
    MIN_WITHDRAW_DELAY = 900
    MAX_WITHDRAW_DELAY = 2592000
    ERC6492_MAGIC = "6492649264926492649264926492649264926492649264926492649264926492"

    CONFIG = "(address,address,address,address,address,uint40,bytes32)"
    VOUCHER_CLAIMS = "(((address,address,address,address,address,uint40,bytes32),uint128),bytes,uint128)[]"

    CHANNEL_CONFIG_TYPES = {"ChannelConfig": _t(
        ("payer", "address"), ("payerAuthorizer", "address"), ("receiver", "address"), ("receiverAuthorizer", "address"),
        ("token", "address"), ("withdrawDelay", "uint40"), ("salt", "bytes32"))}
    VOUCHER_TYPES = {"Voucher": _t(("channelId", "bytes32"), ("maxClaimableAmount", "uint128"))}
    REFUND_TYPES = {"Refund": _t(("channelId", "bytes32"), ("nonce", "uint256"), ("amount", "uint128"))}
    CLAIM_BATCH_TYPES = {
        "ClaimBatch": _t(("claims", "ClaimEntry[]")),
        "ClaimEntry": _t(("channelId", "bytes32"), ("maxClaimableAmount", "uint128"), ("totalClaimed", "uint128")),
    }
    _AUTH = (("from", "address"), ("to", "address"), ("value", "uint256"), ("validAfter", "uint256"),
             ("validBefore", "uint256"), ("nonce", "bytes32"))
    RECEIVE_AUTHORIZATION_TYPES = {"ReceiveWithAuthorization": _t(*_AUTH)}
    TRANSFER_AUTHORIZATION_TYPES = {"TransferWithAuthorization": _t(*_AUTH)}

    @staticmethod
    def domain(chain_id):
        return {
            "name": BatchSettlement.DOMAIN_NAME,
            "version": BatchSettlement.DOMAIN_VERSION,
            "chainId": int(chain_id),
            "verifyingContract": Address.checksum(BatchSettlement.ESCROW),
        }

    @staticmethod
    def config(config):
        for k in ("payer", "payerAuthorizer", "receiver", "receiverAuthorizer", "token", "withdrawDelay", "salt"):
            if k not in config:
                raise ValueError(f"channel config is missing {k}")
        return {
            "payer": Address.checksum(config["payer"]),
            "payerAuthorizer": Address.checksum(config["payerAuthorizer"]),
            "receiver": Address.checksum(config["receiver"]),
            "receiverAuthorizer": Address.checksum(config["receiverAuthorizer"]),
            "token": Address.checksum(config["token"]),
            "withdrawDelay": int(Num.dec(config["withdrawDelay"])),
            "salt": Hex.lower(config["salt"]),
        }

    @staticmethod
    def config_tuple(config):
        c = BatchSettlement.config(config)
        return [c["payer"], c["payerAuthorizer"], c["receiver"], c["receiverAuthorizer"], c["token"], c["withdrawDelay"], c["salt"]]

    @staticmethod
    def channel_id(config, chain_id):
        return TypedData.hash(BatchSettlement.domain(chain_id), BatchSettlement.CHANNEL_CONFIG_TYPES, "ChannelConfig", BatchSettlement.config(config))

    @staticmethod
    def channel_id_matches(config, channel_id, chain_id):
        return Hex.is_hex(channel_id, 32) and BatchSettlement.channel_id(config, chain_id).lower() == channel_id.lower()

    @staticmethod
    def validate_channel_config(config, channel_id, chain_id, pay_to, receiver_authorizer, asset, withdraw_delay=None):
        c = BatchSettlement.config(config)
        if not BatchSettlement.channel_id_matches(c, channel_id, chain_id):
            return "invalid_batch_settlement_evm_channel_id_mismatch"
        if not Address.equals(c["receiver"], pay_to):
            return "invalid_batch_settlement_evm_receiver_mismatch"
        if not receiver_authorizer or Address.equals(receiver_authorizer, Address.ZERO) or not Address.equals(c["receiverAuthorizer"], receiver_authorizer):
            return "invalid_batch_settlement_evm_receiver_authorizer_mismatch"
        if not Address.equals(c["token"], asset):
            return "invalid_batch_settlement_evm_token_mismatch"
        if withdraw_delay is not None and c["withdrawDelay"] != int(withdraw_delay):
            return "invalid_batch_settlement_evm_withdraw_delay_mismatch"
        if c["withdrawDelay"] < BatchSettlement.MIN_WITHDRAW_DELAY or c["withdrawDelay"] > BatchSettlement.MAX_WITHDRAW_DELAY:
            return "invalid_batch_settlement_evm_withdraw_delay_out_of_range"
        return None

    @staticmethod
    def voucher_digest(channel_id, max_claimable_amount, chain_id):
        return TypedData.hash(BatchSettlement.domain(chain_id), BatchSettlement.VOUCHER_TYPES, "Voucher",
                              {"channelId": channel_id, "maxClaimableAmount": max_claimable_amount})

    @staticmethod
    def sign_voucher(key, channel_id, max_claimable_amount, chain_id):
        return Secp256k1.sign_hash(key, BatchSettlement.voucher_digest(channel_id, max_claimable_amount, chain_id))

    @staticmethod
    def recover_voucher(channel_id, max_claimable_amount, signature, chain_id):
        return Secp256k1.recover_hash(BatchSettlement.voucher_digest(channel_id, max_claimable_amount, chain_id), signature)

    @staticmethod
    def verify_voucher(config, channel_id, max_claimable_amount, signature, chain_id):
        c = BatchSettlement.config(config)
        expected = c["payer"] if Address.equals(c["payerAuthorizer"], Address.ZERO) else c["payerAuthorizer"]
        try:
            return Address.equals(BatchSettlement.recover_voucher(channel_id, max_claimable_amount, signature, chain_id), expected)
        except ValueError:
            return False

    @staticmethod
    def claim_entries(claims, chain_id):
        return [{
            "channelId": BatchSettlement.channel_id(c["voucher"]["channel"], chain_id),
            "maxClaimableAmount": Num.dec(c["voucher"]["maxClaimableAmount"]),
            "totalClaimed": Num.dec(c["totalClaimed"]),
        } for c in claims]

    @staticmethod
    def claim_batch_digest(claims, chain_id):
        return TypedData.hash(BatchSettlement.domain(chain_id), BatchSettlement.CLAIM_BATCH_TYPES, "ClaimBatch",
                              {"claims": BatchSettlement.claim_entries(claims, chain_id)})

    @staticmethod
    def sign_claim_batch(key, claims, chain_id):
        return Secp256k1.sign_hash(key, BatchSettlement.claim_batch_digest(claims, chain_id))

    @staticmethod
    def refund_digest(channel_id, nonce, amount, chain_id):
        return TypedData.hash(BatchSettlement.domain(chain_id), BatchSettlement.REFUND_TYPES, "Refund",
                              {"channelId": channel_id, "nonce": nonce, "amount": amount})

    @staticmethod
    def sign_refund(key, channel_id, amount, nonce, chain_id):
        return Secp256k1.sign_hash(key, BatchSettlement.refund_digest(channel_id, nonce, amount, chain_id))

    @staticmethod
    def erc3009_deposit_nonce(channel_id, salt):
        return Keccak.hash_hex(Abi.encode(["bytes32", "uint256"], [channel_id, salt]))

    @staticmethod
    def erc3009_collector_data(valid_after, valid_before, salt, signature):
        return Abi.encode(["uint256", "uint256", "uint256", "bytes"], [valid_after, valid_before, salt, signature])

    @staticmethod
    def permit2_collector_data(nonce, deadline, permit2_signature, eip2612_permit_data="0x"):
        return Abi.encode(["uint256", "uint256", "bytes", "bytes"], [nonce, deadline, permit2_signature, eip2612_permit_data])

    @staticmethod
    def token_domain(asset, name, version, chain_id):
        return {"name": str(name), "version": str(version), "chainId": int(chain_id), "verifyingContract": Address.checksum(asset)}

    @staticmethod
    def receive_authorization(payer, amount, valid_after, valid_before, nonce):
        return {
            "from": Address.checksum(payer),
            "to": Address.checksum(BatchSettlement.ERC3009_DEPOSIT_COLLECTOR),
            "value": Num.dec(amount),
            "validAfter": Num.dec(valid_after),
            "validBefore": Num.dec(valid_before),
            "nonce": nonce,
        }

    @staticmethod
    def receive_authorization_digest(token_domain, authorization):
        return TypedData.hash(token_domain, BatchSettlement.RECEIVE_AUTHORIZATION_TYPES, "ReceiveWithAuthorization", authorization)

    @staticmethod
    def sign_receive_authorization(key, token_domain, authorization):
        return Secp256k1.sign_hash(key, BatchSettlement.receive_authorization_digest(token_domain, authorization))

    @staticmethod
    def transfer_authorization_typed_data(token_domain, authorization):
        d, a = token_domain, authorization
        return {
            "domain": {"name": str(d["name"]), "version": str(d["version"]), "chainId": int(d["chainId"]), "verifyingContract": Address.checksum(d["verifyingContract"])},
            "types": {"TransferWithAuthorization": [{"name": f["name"], "type": f["type"]} for f in BatchSettlement.TRANSFER_AUTHORIZATION_TYPES["TransferWithAuthorization"]]},
            "primaryType": "TransferWithAuthorization",
            "message": {"from": Address.checksum(a["from"]), "to": Address.checksum(a["to"]), "value": Num.dec(a["value"]), "validAfter": Num.dec(a["validAfter"]),
                        "validBefore": Num.dec(a["validBefore"]), "nonce": Hex.lower(a["nonce"])},
        }

    @staticmethod
    def transfer_authorization_digest(token_domain, authorization):
        return TypedData.hash(token_domain, BatchSettlement.TRANSFER_AUTHORIZATION_TYPES, "TransferWithAuthorization", authorization)

    @staticmethod
    def sign_transfer_authorization(key, token_domain, authorization):
        return Secp256k1.sign_hash(key, BatchSettlement.transfer_authorization_digest(token_domain, authorization))

    @staticmethod
    def parse_erc6492_signature(signature):
        h = Hex.lower(signature)
        if len(h) < 66 or h[-64:] != BatchSettlement.ERC6492_MAGIC:
            return {"address": None, "data": None, "signature": h}
        address, data, inner = Abi.decode(["address", "bytes", "bytes"], "0x" + h[2:-64])
        return {"address": address, "data": data, "signature": inner}

    @staticmethod
    def verify_erc3009_deposit(config, amount, authorization, asset, name, version, chain_id):
        c = BatchSettlement.config(config)
        parsed = BatchSettlement.parse_erc6492_signature(authorization["signature"])
        nonce = BatchSettlement.erc3009_deposit_nonce(BatchSettlement.channel_id(c, chain_id), authorization["salt"])
        digest = BatchSettlement.receive_authorization_digest(
            BatchSettlement.token_domain(asset, name, version, chain_id),
            BatchSettlement.receive_authorization(c["payer"], amount, authorization["validAfter"], authorization["validBefore"], nonce))
        try:
            return Address.equals(Secp256k1.recover_hash(digest, parsed["signature"]), c["payer"])
        except ValueError:
            return False

    @staticmethod
    def erc3009_deposit_collector_data(authorization):
        parsed = BatchSettlement.parse_erc6492_signature(authorization["signature"])
        return BatchSettlement.erc3009_collector_data(authorization["validAfter"], authorization["validBefore"], authorization["salt"], parsed["signature"])

    @staticmethod
    def voucher_claim_tuples(claims):
        return [[
            [BatchSettlement.config_tuple(c["voucher"]["channel"]), Num.dec(c["voucher"]["maxClaimableAmount"])],
            Hex.lower(c["signature"]),
            Num.dec(c["totalClaimed"]),
        ] for c in claims]

    @staticmethod
    def encode_deposit(config, amount, collector, collector_data):
        return Abi.encode_call("deposit(" + BatchSettlement.CONFIG + ",uint128,address,bytes)",
                               [BatchSettlement.config_tuple(config), amount, Address.checksum(collector), collector_data])

    @staticmethod
    def encode_erc3009_deposit(config, amount, authorization):
        return BatchSettlement.encode_deposit(config, amount, BatchSettlement.ERC3009_DEPOSIT_COLLECTOR,
                                              BatchSettlement.erc3009_deposit_collector_data(authorization))

    @staticmethod
    def encode_claim(claims):
        return Abi.encode_call("claim(" + BatchSettlement.VOUCHER_CLAIMS + ")", [BatchSettlement.voucher_claim_tuples(claims)])

    @staticmethod
    def encode_claim_with_signature(claims, authorizer_signature):
        return Abi.encode_call("claimWithSignature(" + BatchSettlement.VOUCHER_CLAIMS + ",bytes)",
                               [BatchSettlement.voucher_claim_tuples(claims), authorizer_signature])

    @staticmethod
    def encode_refund_with_signature(config, amount, nonce, receiver_authorizer_signature):
        return Abi.encode_call("refundWithSignature(" + BatchSettlement.CONFIG + ",uint128,uint256,bytes)",
                               [BatchSettlement.config_tuple(config), amount, nonce, receiver_authorizer_signature])

    @staticmethod
    def encode_settle(receiver, token):
        return Abi.encode_call("settle(address,address)", [Address.checksum(receiver), Address.checksum(token)])

    @staticmethod
    def encode_multicall(calls):
        return Abi.encode_call("multicall(bytes[])", [list(calls)])

    @staticmethod
    def encode_transfer_with_authorization(authorization, signature):
        a = authorization
        return Abi.encode_call("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
                               [Address.checksum(a["from"]), Address.checksum(a["to"]), Num.dec(a["value"]), Num.dec(a["validAfter"]),
                                Num.dec(a["validBefore"]), Hex.lower(a["nonce"]), Hex.lower(signature)])

    @staticmethod
    def encode_aggregate3(calls):
        return Abi.encode_call("aggregate3((address,bool,bytes)[])", [[[Address.checksum(c["to"]), False, Hex.lower(c["data"])] for c in calls]])

    @staticmethod
    def encode_channels(channel_id):
        return Abi.encode_call("channels(bytes32)", [channel_id])

    @staticmethod
    def decode_channels(data):
        balance, total_claimed = Abi.decode(["uint128", "uint128"], data)
        return {"balance": balance, "totalClaimed": total_claimed}

    @staticmethod
    def encode_receivers(receiver, token):
        return Abi.encode_call("receivers(address,address)", [Address.checksum(receiver), Address.checksum(token)])

    @staticmethod
    def decode_receivers(data):
        claimed, settled = Abi.decode(["uint128", "uint128"], data)
        return {"totalClaimed": claimed, "totalSettled": settled}

    @staticmethod
    def encode_refund_nonce(channel_id):
        return Abi.encode_call("refundNonce(bytes32)", [channel_id])

    @staticmethod
    def decode_refund_nonce(data):
        return Abi.decode(["uint256"], data)[0]

    @staticmethod
    def encode_pending_withdrawals(channel_id):
        return Abi.encode_call("pendingWithdrawals(bytes32)", [channel_id])

    @staticmethod
    def decode_pending_withdrawals(data):
        amount, initiated_at = Abi.decode(["uint128", "uint40"], data)
        return {"amount": amount, "initiatedAt": initiated_at}

    @staticmethod
    def encode_get_channel_id(config):
        return Abi.encode_call("getChannelId(" + BatchSettlement.CONFIG + ")", [BatchSettlement.config_tuple(config)])

    @staticmethod
    def encode_get_voucher_digest(channel_id, max_claimable_amount):
        return Abi.encode_call("getVoucherDigest(bytes32,uint128)", [channel_id, max_claimable_amount])

    @staticmethod
    def encode_get_refund_digest(channel_id, nonce, amount):
        return Abi.encode_call("getRefundDigest(bytes32,uint256,uint128)", [channel_id, nonce, amount])

    @staticmethod
    def encode_get_claim_batch_digest(claims):
        return Abi.encode_call("getClaimBatchDigest(" + BatchSettlement.VOUCHER_CLAIMS + ")", [BatchSettlement.voucher_claim_tuples(claims)])


class Erc20:
    USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    USDC_BASE_NAME = "USD Coin"
    USDC_BASE_VERSION = "2"

    @staticmethod
    def encode_balance_of(owner):
        return Abi.encode_call("balanceOf(address)", [Address.checksum(owner)])

    @staticmethod
    def decode_uint256(data):
        return Abi.decode(["uint256"], data)[0]
