from ..batch_settlement import BatchSettlement
from ..core import Address
from ..splits import Splits


class Payout:
    DUST = 100

    def __init__(self, cfg, chain):
        self.cfg = cfg
        self.chain = chain

    def calls(self, token, claims_riding=False):
        receiver = self.cfg.receiver
        minimum = int(str(self.cfg.payoutMinUnits), 10)
        calls = []
        incoming = 0
        r = self.chain.receivers(receiver, token)
        owed = int(r["totalClaimed"]) - int(r["totalSettled"])
        if claims_riding or owed >= minimum:
            incoming = minimum + 1 if claims_riding and owed < minimum else owed
            calls.append({
                "what": "settle what the claims riding with it bring" if claims_riding else f"settle {incoming}",
                "to": BatchSettlement.ESCROW,
                "data": BatchSettlement.encode_settle(receiver, token),
            })
        deployed = self.chain.has_code(receiver)
        held = int(self.chain.split_balance(receiver, token) if deployed else self.chain.balance_of(token, receiver))
        held_erc20 = int(self.chain.balance_of(token, receiver)) if deployed else held
        result = {"calls": calls, "owed": str(owed if owed > 0 else 0), "held": str(held_erc20), "deployed": deployed}
        if held + incoming <= minimum:
            return result
        if incoming == 0 and held < self.DUST:
            return result
        if not deployed:
            calls.append({
                "what": "create split",
                "to": Splits.PULL_SPLIT_FACTORY,
                "data": Splits.encode_create_split_deterministic(self.cfg.split, Address.ZERO, self.cfg.payout, self.cfg.salt),
            })
        calls.append({
            "what": "distribute" if claims_riding else f"distribute {held + incoming}",
            "to": receiver,
            "data": Splits.encode_distribute(self.cfg.split, token, Address.ZERO),
        })
        calls.append({
            "what": "pay the seller",
            "to": Splits.WAREHOUSE,
            "data": Splits.encode_warehouse_withdraw(self.cfg.split["recipients"][0], token),
        })
        result["calls"] = calls
        return result
