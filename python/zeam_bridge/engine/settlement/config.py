import hashlib
import hmac
import math
import time

from ..batch_settlement import Erc20
from ..core import Address, Hex, Secp256k1
from ..messages import BridgeMessages
from ..php import php_round
from .cache import ArrayCache, Cache

GAS = {
    "deposit": 145000,
    "claimBase": 35000,
    "claimEntry": 45000,
    "claimAlone": 80000,
    "payout": 210000,
    "charge": 80000,
    "createSplit": 280000,
    "refund": 97000,
    "refundClaim": 37000,
    "paidClaim": 37700,
    "gasPayment": 58600,
    "paidL1": 13800,
    "paidClaimL1": 4200,
}
GAS_MEASURED = {
    "on": "2026-09-29",
    "how": "35 paid relay refunds, Base blocks 51915440-51949669 (25 alone, 10 with a riding claim); gasUsed + L1 fee in gas",
    "paidRefund": 155625,
    "paidRefundWithClaim": 193332,
    "paidL1": 13830,
    "paidL1WithClaim": 18059,
}

_TUNABLE = (
    "withdrawDelay", "maxTimeoutSeconds", "depositFloorMicroUSD", "wethUSD", "gasPriceWei", "feeShare", "gasBuffer",
    "floorMargin", "idleClaimSecs", "maxClaimsPerBatch", "payoutMinUnits", "refundWindowSecs", "refundUrl",
    "receiptTimeoutSecs", "receiptPollMs", "stateCatchUpMs", "drainTries", "drainWaitMs", "repairEveryMs", "gasPaymentSecs", "refundJudgeWaitMs",
)


class Config:
    NETWORK = "eip155:8453"
    CHAIN_ID = 8453
    SCHEME = "batch-settlement"
    WITHDRAW_DELAY = 86400
    MAX_TIMEOUT_SECONDS = 240
    DRAIN_WAIT_MS = 2000
    FEE_SHARE = 0.0999
    GAS = GAS
    GAS_MEASURED = GAS_MEASURED

    def __init__(self, o):
        for k in ("name", "priceMicroUSD", "payout", "feeRecipient", "receiverAuthorizerKey", "relayUrl", "rpcUrl"):
            if o.get(k) is None or o.get(k) == "":
                raise ValueError(f"settlement config is missing {k}")
        self.name = str(o["name"])
        self.site = str(o.get("site") or "")
        self.priceMicroUSD = int(o["priceMicroUSD"])
        if self.priceMicroUSD < 1:
            raise ValueError("the price is at least one micro-USD")
        self.payout = Address.checksum(o["payout"])
        self.feeRecipient = Address.checksum(o["feeRecipient"])
        self.payoutIsFeeRecipient = o.get("payoutIsFeeRecipient") is True
        seller = BridgeMessages.seller_split(self.payout, self.feeRecipient, self.name, self.payoutIsFeeRecipient)
        self.split = seller["split"]
        self.salt = seller["salt"]
        self.receiver = seller["address"]
        if o.get("receiver") is not None and not Address.equals(o["receiver"], self.receiver):
            raise ValueError("the receiver is not the split predicted for this seller")
        self._key = Secp256k1.normalize_private_key(o["receiverAuthorizerKey"])
        self.receiverAuthorizer = Secp256k1.private_key_to_address(self._key)
        self.relayUrl = str(o["relayUrl"]).rstrip("/")
        self.rpcUrl = o["rpcUrl"]
        self.network = self.NETWORK
        self.chainId = self.CHAIN_ID
        self.withdrawDelay = self.WITHDRAW_DELAY
        self.maxTimeoutSeconds = self.MAX_TIMEOUT_SECONDS
        self.depositFloorMicroUSD = None
        self.wethUSD = None
        self.gasPriceWei = None
        self.feeShare = 1 if self.payoutIsFeeRecipient else self.FEE_SHARE
        self.gasBuffer = 1.15
        self.floorMargin = 1.25
        self.idleClaimSecs = 20
        self.maxClaimsPerBatch = 50
        self.payoutMinUnits = 1
        self.refundWindowSecs = 300
        self.refundUrl = None
        self.receiptTimeoutSecs = 60
        self.receiptPollMs = 1000
        self.stateCatchUpMs = 2000
        self.drainTries = 15
        self.drainWaitMs = Config.DRAIN_WAIT_MS
        self.repairEveryMs = 60000
        self.gasPaymentSecs = 300
        self.refundJudgeWaitMs = 5000
        for k in _TUNABLE:
            if k in o:
                setattr(self, k, o[k])
        self.withdrawDelay = int(self.withdrawDelay)
        self.maxTimeoutSeconds = int(self.maxTimeoutSeconds)
        self.gas = {**GAS, **o["gas"]} if isinstance(o.get("gas"), dict) else dict(GAS)
        self.assets = [Config._asset(a) for a in (o["assets"] if "assets" in o and o["assets"] is not None else [Config.usdc()])]
        if not self.assets:
            raise ValueError("a seller accepts at least one asset")
        self._clock = o.get("clock") if callable(o.get("clock")) else None
        self._sleeper = o.get("sleep") if callable(o.get("sleep")) else None
        self.cache = o["cache"] if isinstance(o.get("cache"), Cache) else ArrayCache(self._clock)

    @staticmethod
    def usdc():
        return {
            "symbol": "USDC",
            "address": Erc20.USDC_BASE,
            "decimals": 6,
            "name": Erc20.USDC_BASE_NAME,
            "version": Erc20.USDC_BASE_VERSION,
            "eip3009": True,
            "priceUSD": 1,
        }

    @staticmethod
    def _asset(a):
        for k in ("symbol", "address", "decimals"):
            if a.get(k) is None:
                raise ValueError(f"an asset is missing {k}")
        return {
            "symbol": str(a["symbol"]),
            "address": Address.checksum(a["address"]),
            "decimals": int(a["decimals"]),
            "name": str(a["name"]) if a.get("name") is not None else None,
            "version": str(a["version"]) if a.get("version") is not None else None,
            "eip3009": bool(a.get("eip3009")) and a.get("name") is not None,
            "priceUSD": float(a["priceUSD"]) if a.get("priceUSD") is not None else 1.0,
        }

    def asset_of(self, token):
        for a in self.assets:
            if Address.equals(a["address"], str(token) if token is not None else ""):
                return a
        return None

    def units_of_micro_usd(self, asset, micro_usd):
        if asset["decimals"] == 6 and float(asset["priceUSD"]) == 1.0:
            return str(max(1, int(micro_usd)))
        units = php_round((float(micro_usd) / 1e6 / float(asset["priceUSD"])) * math.pow(10, asset["decimals"]))
        return "%.0f" % max(1, units)

    def micro_usd_of(self, token, units):
        asset = token if isinstance(token, dict) else self.asset_of(token)
        if asset is None:
            return None
        n = int(str(units), 10)
        if asset["decimals"] == 6 and float(asset["priceUSD"]) == 1.0:
            return n
        return int(php_round(float(n) / math.pow(10, asset["decimals"]) * float(asset["priceUSD"]) * 1e6))

    def price_units(self, asset):
        return self.units_of_micro_usd(asset, self.priceMicroUSD)

    def relay_split(self):
        return {
            "split": {
                "recipients": self.split["recipients"],
                "allocations": self.split["allocations"],
                "totalAllocation": self.split["totalAllocation"],
                "distributionIncentive": int(self.split["distributionIncentive"]),
            },
            "salt": Hex.lower(self.salt),
            "receiver": self.receiver,
        }

    def signing_key(self):
        return self._key

    def mpp_secret(self):
        return hmac.new(Hex.to_bin(self._key), b"zeam-pass/mpp-challenge-binding", hashlib.sha256).digest()

    def now_ms(self):
        return int(self._clock()) if self._clock else int(time.time() * 1000)

    def sleep_ms(self, ms):
        if ms <= 0:
            return
        if self._sleeper:
            self._sleeper(ms)
            return
        time.sleep(ms / 1000)

    def __repr__(self):
        return f"Config(name={self.name!r}, receiver={self.receiver!r}, receiverAuthorizer={self.receiverAuthorizer!r}, key=(hidden))"
