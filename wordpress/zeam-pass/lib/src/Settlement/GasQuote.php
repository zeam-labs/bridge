<?php

namespace ZeamPass\Settlement;

use ZeamPass\Address;
use ZeamPass\Big;

final class GasQuote
{
    const QUOTE_TTL = 60;
    const FLOOR_TTL = 86400 * 30;

    private $cfg;
    private $chain;
    private $relay;

    public function __construct(Config $cfg, Chain $chain, ?Relay $relay = null)
    {
        $this->cfg = $cfg;
        $this->chain = $chain;
        $this->relay = $relay;
    }

    public function ethUSD()
    {
        $key = 'zeam_pass_eth_usd';
        $hit = $this->cfg->cache->get($key);
        if (is_numeric($hit) && (float) $hit > 0) {
            return (float) $hit;
        }
        $price = null;
        $health = $this->relay ? $this->relay->health() : null;
        if (is_array($health)) {
            foreach (['wethUSD', 'ethUSD'] as $k) {
                if (isset($health[$k]) && is_numeric($health[$k]) && (float) $health[$k] > 0) {
                    $price = (float) $health[$k];
                    break;
                }
            }
            if ($price === null && isset($health['prices']['WETH']) && is_numeric($health['prices']['WETH']) && (float) $health['prices']['WETH'] > 0) {
                $price = (float) $health['prices']['WETH'];
            }
        }
        if ($price === null && is_numeric($this->cfg->wethUSD) && (float) $this->cfg->wethUSD > 0) {
            $price = (float) $this->cfg->wethUSD;
        }
        if ($price !== null) {
            $this->cfg->cache->set($key, $price, self::QUOTE_TTL);
        }
        return $price;
    }

    public function gasWallet()
    {
        $key = 'zeam_pass_relay_sender';
        $hit = $this->cfg->cache->get($key);
        if (is_string($hit) && Address::isAddress($hit)) {
            return Address::checksum($hit);
        }
        $health = $this->relay ? $this->relay->health() : null;
        $sender = is_array($health) && isset($health['sender']) && is_string($health['sender']) && Address::isAddress($health['sender']) ? Address::checksum($health['sender']) : null;
        if ($sender !== null) {
            $this->cfg->cache->set($key, $sender, self::QUOTE_TTL);
        }
        return $sender;
    }

    public function weiPerGas($fresh = false)
    {
        if ($this->cfg->gasPriceWei !== null && $this->cfg->gasPriceWei !== '') {
            return (string) $this->cfg->gasPriceWei;
        }
        $key = 'zeam_pass_gas_price';
        $hit = $fresh ? null : $this->cfg->cache->get($key);
        if (is_string($hit) && ctype_digit($hit)) {
            return $hit;
        }
        try {
            $wei = $this->chain->gasPrice();
        } catch (\Throwable $e) {
            return null;
        }
        $this->cfg->cache->set($key, $wei, self::QUOTE_TTL);
        return $wei;
    }

    private function ethOf($units, $fresh = false)
    {
        $wei = $this->weiPerGas($fresh);
        $eth = $wei === null ? null : $this->ethUSD();
        if ($wei === null || $eth === null || Big::sign(Big::init($wei, 10)) <= 0) {
            return null;
        }
        return [(float) Big::strval(Big::mul(Big::init($wei, 10), Big::init((string) $units, 10))) / 1e18, $eth, (string) $wei];
    }

    public function microUSD($units)
    {
        $q = $this->ethOf((int) round($units));
        return $q === null ? null : (int) ceil($q[0] * $q[1] * 1e6);
    }

    public function usd($units)
    {
        $q = $this->ethOf((int) ceil($units * $this->cfg->gasBuffer));
        return $q === null ? null : $q[0] * $q[1];
    }

    private function priced($units, $wei, $eth, $l1Units = 0)
    {
        $buffered = (int) ceil($units * $this->cfg->gasBuffer);
        $inEth = (float) Big::strval(Big::mul(Big::init((string) $wei, 10), Big::init((string) (int) ceil(($units + $l1Units) * $this->cfg->gasBuffer), 10))) / 1e18;
        $costEth = (float) Big::strval(Big::mul(Big::init((string) $wei, 10), Big::init((string) ($units + $l1Units), 10))) / 1e18;
        return [
            'microUSD' => (int) ceil($inEth * $eth * 1e6),
            'costMicroUSD' => (int) ceil($costEth * $eth * 1e6),
            'gasUnits' => $units,
            'gasUnitsWithMargin' => $buffered,
            'gasPriceWei' => (string) $wei,
            'ethUSD' => self::number($eth),
            'marginPercent' => $this->marginPercent(),
            'l1FeeWei' => Big::strval(Big::mul(Big::init((string) $wei, 10), Big::init((string) $l1Units, 10))),
            'quotedBy' => 'engine',
        ];
    }

    private function snapshot($fresh)
    {
        $wei = $this->weiPerGas($fresh);
        $eth = $wei === null ? null : $this->ethUSD();
        if ($wei === null || $eth === null || Big::sign(Big::init($wei, 10)) <= 0) {
            return null;
        }
        return [$wei, $eth];
    }

    public function quote($units, $fresh = true)
    {
        $at = $this->snapshot($fresh);
        return $at === null ? null : $this->priced($units, $at[0], $at[1]);
    }

    public function refund($claimRides, $fresh = true, $alreadyPaid = 0)
    {
        $g = $this->cfg->gas;
        $at = $this->snapshot($fresh);
        if ($at === null) {
            return null;
        }
        $cover = $g['deposit'] + $g['refund'] + ($claimRides ? $g['refundClaim'] : 0) + $alreadyPaid;
        $pay = $g['refund'] + ($claimRides ? $g['paidClaim'] : 0) + $g['gasPayment'];
        $l1 = $g['paidL1'] + ($claimRides ? $g['paidClaimL1'] : 0);
        return ['cover' => $this->priced($cover, $at[0], $at[1]), 'pay' => $this->priced($pay, $at[0], $at[1], $l1)];
    }

    public function relayQuote($call)
    {
        return $this->relay && $call ? $this->relay->quote($call, true) : null;
    }

    public function relayPaid($channelId)
    {
        return $this->relay ? $this->relay->paid($channelId) : null;
    }

    public function relayRefundQuote()
    {
        $key = 'zeam_pass_relay_refund_quote';
        $hit = $this->cfg->cache->get($key);
        if ($hit === 'none') {
            return null;
        }
        if (is_string($hit) && preg_match('/^(\d+)\/(\d+)$/', $hit, $m)) {
            return ['microUSD' => (int) $m[1], 'marginPercent' => (int) $m[2]];
        }
        $q = $this->relay ? $this->relay->shapeQuote(false, true) : null;
        $out = $q === null ? null : ['microUSD' => (int) $q['microUSD'], 'marginPercent' => (int) round($q['marginPercent'])];
        $this->cfg->cache->set($key, $out === null ? 'none' : $out['microUSD'] . '/' . $out['marginPercent'], self::QUOTE_TTL);
        return $out;
    }

    public function marginPercent()
    {
        return (int) round(($this->cfg->gasBuffer - 1) * 100);
    }

    public static function number($x)
    {
        return is_float($x) && is_finite($x) && floor($x) === $x && abs($x) < 9007199254740992 ? (int) $x : $x;
    }

    public static function feeMicroUSD($earnedMicroUSD, $feeShare)
    {
        return \ZeamPass\Pricing::mulDiv($earnedMicroUSD, (int) round($feeShare * 1e6), 1000000);
    }

    public function atMargin($usd, $units)
    {
        $gas = $this->usd($units);
        return $gas !== null && $usd * $this->cfg->feeShare >= $gas;
    }

    public function depositFloorMicroUSD($price = null)
    {
        $price = $price === null ? $this->cfg->priceMicroUSD : (int) $price;
        $gas = $this->microUSD($this->cfg->gas['deposit']);
        $key = 'zeam_pass_deposit_floor';
        if ($gas === null) {
            $last = $this->cfg->cache->get($key);
            $configured = $this->cfg->depositFloorMicroUSD;
            return max($price, is_numeric($last) ? (int) $last : 0, is_numeric($configured) ? (int) $configured : 0);
        }
        $back = $this->refund(true, false);
        $home = $back === null ? 0 : (int) ceil($back['pay']['microUSD'] * $this->cfg->floorMargin);
        $floor = max((int) ceil(($gas * $this->cfg->floorMargin) / $this->cfg->feeShare), $home);
        $this->cfg->cache->set($key, $floor, self::FLOOR_TTL);
        return max($price, $floor);
    }
}
