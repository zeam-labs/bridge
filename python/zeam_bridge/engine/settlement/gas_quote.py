import math
import re

from ..core import Address
from ..php import is_numeric, php_round, to_float, to_int


class GasQuote:
    QUOTE_TTL = 60
    RECENT_SECS = 5
    FLOOR_TTL = 86400 * 30
    RETRY_SECS = 20
    RETRY_FIRST_MS = 250
    RETRY_MOST_MS = 4000
    RETRY_KEY = "zeam_pass_gas_retry"

    def __init__(self, cfg, chain, relay=None):
        self.cfg = cfg
        self.chain = chain
        self.relay = relay

    def eth_usd(self):
        key = "zeam_pass_eth_usd"
        hit = self.cfg.cache.get(key)
        if is_numeric(hit) and to_float(hit) > 0:
            return to_float(hit)
        price = None
        health = self.relay.health() if self.relay else None
        if isinstance(health, dict):
            for k in ("wethUSD", "ethUSD"):
                if is_numeric(health.get(k)) and to_float(health[k]) > 0:
                    price = to_float(health[k])
                    break
            prices = health.get("prices")
            if price is None and isinstance(prices, dict) and is_numeric(prices.get("WETH")) and to_float(prices["WETH"]) > 0:
                price = to_float(prices["WETH"])
        if price is None and is_numeric(self.cfg.wethUSD) and to_float(self.cfg.wethUSD) > 0:
            price = to_float(self.cfg.wethUSD)
        if price is not None:
            self.cfg.cache.set(key, price, self.QUOTE_TTL)
        return price

    def gas_wallet(self):
        key = "zeam_pass_relay_sender"
        hit = self.cfg.cache.get(key)
        if isinstance(hit, str) and Address.is_address(hit):
            return Address.checksum(hit)
        health = self.relay.health() if self.relay else None
        sender = health.get("sender") if isinstance(health, dict) else None
        sender = Address.checksum(sender) if isinstance(sender, str) and Address.is_address(sender) else None
        if sender is not None:
            self.cfg.cache.set(key, sender, self.QUOTE_TTL)
        return sender

    def wei_per_gas(self, fresh=False, recent=None):
        if self.cfg.gasPriceWei is not None and self.cfg.gasPriceWei != "":
            return str(self.cfg.gasPriceWei)
        key = "zeam_pass_gas_price"
        near = None if recent is None else self.cfg.cache.get(key + "_recent")
        if recent is not None and isinstance(near, str) and near.isdigit():
            return near
        hit = self.cfg.cache.get(key)
        last = hit if isinstance(hit, str) and hit.isdigit() else None
        if last is not None and not fresh and recent is None:
            return last
        retry = self.retry_of(self.cfg.cache.get(self.RETRY_KEY))
        if last is not None and retry is not None and self.cfg.now_ms() < retry["due"]:
            return last
        try:
            wei = self.chain.gas_price()
        except Exception:
            self.missed(retry)
            return last
        self.cfg.cache.set(key, wei, self.QUOTE_TTL)
        if recent is not None:
            self.cfg.cache.set(key + "_recent", wei, recent)
        if retry is not None:
            self.cfg.cache.set(self.RETRY_KEY, "", 1)
        return wei

    def missed(self, retry):
        now = self.cfg.now_ms()
        since = now if retry is None else retry["since"]
        left = since + self.RETRY_SECS * 1000 - now
        if left <= 0:
            self.cfg.cache.set(self.RETRY_KEY, "", 1)
            return
        wait = self.RETRY_FIRST_MS if retry is None else min(retry["wait"] * 2, self.RETRY_MOST_MS)
        self.cfg.cache.set(self.RETRY_KEY, f"{since}:{now + wait}:{wait}", int(math.ceil(left / 1000)))

    @staticmethod
    def retry_of(v):
        m = re.fullmatch(r"(\d+):(\d+):(\d+)", v) if isinstance(v, str) else None
        return None if m is None else {"since": int(m.group(1)), "due": int(m.group(2)), "wait": int(m.group(3))}

    def _eth_of(self, units, fresh=False, recent=None):
        wei = self.wei_per_gas(fresh, recent)
        eth = None if wei is None else self.eth_usd()
        if wei is None or eth is None or int(wei) <= 0:
            return None
        return float(int(wei) * int(units)) / 1e18, eth, wei

    def micro_usd(self, units, recent=None):
        q = self._eth_of(int(php_round(units)), False, recent)
        return None if q is None else int(math.ceil(q[0] * q[1] * 1e6))

    def usd(self, units):
        q = self._eth_of(int(math.ceil(units * self.cfg.gasBuffer)))
        return None if q is None else q[0] * q[1]

    def priced(self, units, wei, eth, l1_units=0):
        buffered = int(math.ceil(units * self.cfg.gasBuffer))
        in_eth = float(int(wei) * int(math.ceil((units + l1_units) * self.cfg.gasBuffer))) / 1e18
        cost_eth = float(int(wei) * int(units + l1_units)) / 1e18
        shown = int(eth) if isinstance(eth, float) and eth.is_integer() else eth
        return {"microUSD": int(math.ceil(in_eth * eth * 1e6)), "costMicroUSD": int(math.ceil(cost_eth * eth * 1e6)), "gasUnits": units, "gasUnitsWithMargin": buffered, "gasPriceWei": str(wei),
                "ethUSD": shown, "marginPercent": int(php_round((self.cfg.gasBuffer - 1) * 100)), "l1FeeWei": str(int(wei) * int(l1_units)), "quotedBy": "engine"}

    def _snapshot(self, fresh):
        wei = self.wei_per_gas(fresh)
        eth = None if wei is None else self.eth_usd()
        if wei is None or eth is None or int(wei) <= 0:
            return None
        return wei, eth

    def quote(self, units, fresh=True):
        at = self._snapshot(fresh)
        return None if at is None else self.priced(units, at[0], at[1])

    def refund(self, claim_rides, fresh=True, already_paid=0):
        g = self.cfg.gas
        at = self._snapshot(fresh)
        if at is None:
            return None
        cover = g["deposit"] + g["refund"] + (g["refundClaim"] if claim_rides else 0) + already_paid
        pay = g["paidRefundLeg"] + (g["paidClaim"] if claim_rides else 0) + g["gasPayment"]
        l1 = g["paidL1"] + (g["paidClaimL1"] if claim_rides else 0)
        return {"cover": self.priced(cover, at[0], at[1]), "pay": self.priced(pay, at[0], at[1], l1)}

    def relay_quote(self, call):
        return self.relay.quote(call, True) if self.relay and call else None

    def relay_paid(self, channel_id):
        return self.relay.paid(channel_id) if self.relay else None

    def relay_refund_quote(self):
        key = "zeam_pass_relay_refund_quote"
        hit = self.cfg.cache.get(key)
        if hit == "none":
            return None
        cached = re.fullmatch(r"(\d+)/(\d+)", hit) if isinstance(hit, str) else None
        if cached:
            return {"microUSD": int(cached.group(1)), "marginPercent": int(cached.group(2))}
        q = self.relay.shape_quote(False, True) if self.relay else None
        out = None if q is None else {"microUSD": int(q["microUSD"]), "marginPercent": int(php_round(q["marginPercent"]))}
        self.cfg.cache.set(key, "none" if out is None else str(out["microUSD"]) + "/" + str(out["marginPercent"]), self.QUOTE_TTL)
        return out

    @staticmethod
    def fee_micro_usd(earned_micro_usd, fee_share):
        return (int(earned_micro_usd) * int(php_round(fee_share * 1e6))) // 1000000

    def at_margin(self, usd, units):
        gas = self.usd(units)
        return gas is not None and usd * self.cfg.feeShare >= gas

    def deposit_floor_micro_usd(self, price=None):
        price = self.cfg.priceMicroUSD if price is None else price
        gas = self.micro_usd(self.cfg.gas["deposit"])
        key = "zeam_pass_deposit_floor"
        if gas is None:
            last = self.cfg.cache.get(key)
            configured = self.cfg.depositFloorMicroUSD
            return max(price, to_int(last) if is_numeric(last) else 0, to_int(configured) if is_numeric(configured) else 0)
        back = self.refund(True, False)
        home = 0 if back is None else int(math.ceil(back["pay"]["microUSD"] * self.cfg.floorMargin))
        floor = max(int(math.ceil((gas * self.cfg.floorMargin) / self.cfg.feeShare)), home)
        self.cfg.cache.set(key, floor, self.FLOOR_TTL)
        return max(price, floor)
