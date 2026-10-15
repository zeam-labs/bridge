from ..abi import Abi
from ..batch_settlement import BatchSettlement, Erc20
from ..core import Address, Hex, Num
from ..rpc import Rpc
from ..splits import Splits


class Chain:
    PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
    ERC1271_MAGIC = "0x1626ba7e"

    def __init__(self, rpc):
        if isinstance(rpc, str):
            rpc = Rpc(rpc, 10, 5)
        if not callable(getattr(rpc, "call", None)):
            raise ValueError("a chain reader needs an RPC URL or an object with call(method, params)")
        self._rpc = rpc

    def rpc(self, method, params=()):
        return self._rpc.call(method, list(params))

    def call(self, to, data, sender=None):
        tx = {"to": Address.checksum(to), "data": Hex.lower(data)}
        if sender is not None:
            tx["from"] = Address.checksum(sender)
        out = self.rpc("eth_call", [tx, "latest"])
        return "" if out is None else str(out)

    def gas_price(self):
        return Num.dec(self.rpc("eth_gasPrice"))

    def code(self, address):
        code = self.rpc("eth_getCode", [Address.checksum(address), "latest"])
        return code.lower() if isinstance(code, str) else "0x"

    def has_code(self, address):
        code = self.code(address)
        return code not in ("0x", "")

    def channel(self, channel_id):
        c = BatchSettlement.decode_channels(self.call(BatchSettlement.ESCROW, BatchSettlement.encode_channels(channel_id)))
        return {"balance": Num.dec(c["balance"]), "totalClaimed": Num.dec(c["totalClaimed"])}

    def pending_withdrawal(self, channel_id):
        w = BatchSettlement.decode_pending_withdrawals(self.call(BatchSettlement.ESCROW, BatchSettlement.encode_pending_withdrawals(channel_id)))
        return {"amount": Num.dec(w["amount"]), "initiatedAt": int(Num.dec(w["initiatedAt"]))}

    def refund_nonce(self, channel_id):
        return Num.dec(BatchSettlement.decode_refund_nonce(self.call(BatchSettlement.ESCROW, BatchSettlement.encode_refund_nonce(channel_id))))

    def state(self, channel_id):
        c = self.channel(channel_id)
        w = self.pending_withdrawal(channel_id)
        return {
            "balance": c["balance"],
            "totalClaimed": c["totalClaimed"],
            "withdrawRequestedAt": w["initiatedAt"],
            "withdrawing": int(w["amount"]) > 0,
            "refundNonce": self.refund_nonce(channel_id),
        }

    def live(self, channel_id):
        c = self.channel(channel_id)
        w = self.pending_withdrawal(channel_id)
        payable = int(c["balance"]) - int(c["totalClaimed"])
        return {
            "balance": c["balance"],
            "claimed": c["totalClaimed"],
            "payable": "0" if payable < 0 else str(payable),
            "withdrawing": int(w["amount"]) > 0,
        }

    def balance_of(self, token, owner):
        return Num.dec(Erc20.decode_uint256(self.call(token, Erc20.encode_balance_of(owner))))

    def allowance(self, token, owner, spender):
        data = Abi.encode_call("allowance(address,address)", [Address.checksum(owner), Address.checksum(spender)])
        return Num.dec(Erc20.decode_uint256(self.call(token, data)))

    def receivers(self, receiver, token):
        r = BatchSettlement.decode_receivers(self.call(BatchSettlement.ESCROW, BatchSettlement.encode_receivers(receiver, token)))
        return {"totalClaimed": Num.dec(r["totalClaimed"]), "totalSettled": Num.dec(r["totalSettled"])}

    def split_balance(self, split, token):
        b = Splits.decode_get_split_balance(self.call(split, Splits.encode_get_split_balance(token)))
        return str(int(Num.dec(b["splitBalance"])) + int(Num.dec(b["warehouseBalance"])))

    def is_valid_signature(self, address, digest, signature):
        try:
            out = self.call(address, Abi.encode_call("isValidSignature(bytes32,bytes)", [digest, Hex.lower(signature)]))
        except Exception:
            return False
        return out[:10].lower() == self.ERC1271_MAGIC

    def receipt(self, tx_hash):
        r = self.rpc("eth_getTransactionReceipt", [tx_hash.lower()])
        return r if isinstance(r, dict) else None
