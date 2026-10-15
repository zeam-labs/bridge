<?php

namespace ZeamPass\Settlement;

use ZeamPass\Address;
use ZeamPass\BatchSettlement;
use ZeamPass\Big;

final class Claims
{
    private $cfg;
    private $store;
    private $chain;
    private $relay;
    private $gas;
    private $channels;
    private $payout;

    public function __construct(Config $cfg, Store $store, ?Chain $chain = null, ?Relay $relay = null)
    {
        $this->cfg = $cfg;
        $this->store = $store;
        $this->chain = $chain ?: new Chain($cfg->rpcUrl);
        $this->relay = $relay ?: new Relay($cfg->relayUrl);
        $this->gas = new GasQuote($cfg, $this->chain, $this->relay);
        $this->channels = new Channels($cfg, $store, $this->chain);
        $this->payout = new Payout($cfg, $this->chain);
    }

    public function claimable(array $asset, array $all)
    {
        $now = $this->cfg->nowMs();
        $found = [];
        foreach ($all as $raw) {
            $c = Channels::earned($this->cfg, $raw);
            if (!isset($c['channelConfig']['token']) || !Address::equals($c['channelConfig']['token'], $asset['address']) || !Channels::claimable($c)) {
                continue;
            }
            try {
                $live = $this->chain->live($c['channelId']);
            } catch (\Throwable $e) {
                continue;
            }
            if ($live['withdrawing'] && empty($c['withdrawRequestedAt'])) {
                $this->channels->update($c['channelId'], function ($r) use ($now) {
                    if ($r !== null) {
                        $r['withdrawRequestedAt'] = $now;
                    }
                    return $r;
                });
            }
            $charged = Channels::n($c['chargedCumulativeAmount']);
            if (Big::cmp($charged, Channels::n($live['balance'])) > 0 || Big::cmp($charged, Channels::n($live['claimed'])) <= 0) {
                continue;
            }
            $delta = Big::sub($charged, Channels::n($live['claimed']));
            if (Big::cmp($delta, Channels::n($live['payable'])) > 0) {
                continue;
            }
            $microUSD = (int) $this->cfg->microUSDOf($asset, Big::strval($delta));
            $urgent = false;
            if ($live['withdrawing']) {
                $gas = $this->gas->microUSD($this->cfg->gas['claimAlone']);
                $urgent = $gas !== null && $microUSD * $this->cfg->feeShare >= $gas;
            }
            $idle = $now - (isset($c['lastRequestTimestamp']) ? (int) $c['lastRequestTimestamp'] : 0) >= 1000 * $this->cfg->idleClaimSecs;
            if (!$live['withdrawing'] && !$idle) {
                continue;
            }
            $found[] = ['c' => $c, 'live' => $live, 'urgent' => $urgent, 'microUSD' => $microUSD, 'units' => Big::strval($delta)];
        }
        $urgent = array_values(array_filter($found, function ($x) {
            return $x['urgent'];
        }));
        $rest = array_values(array_filter($found, function ($x) {
            return !$x['urgent'];
        }));
        return ['urgent' => $urgent, 'rest' => $rest];
    }

    public function worthClaiming(array $asset, array $all, $found = null)
    {
        $found = $found !== null ? $found : $this->claimable($asset, $all);
        $urgent = $found['urgent'];
        $rest = $found['rest'];
        if ($rest === []) {
            return $urgent;
        }
        $worth = array_sum(array_map(function ($x) {
            return $x['microUSD'];
        }, $rest));
        $gas = $this->gas->microUSD($this->cfg->gas['claimBase'] + $this->cfg->gas['claimEntry'] * count($rest) + $this->cfg->gas['payout']);
        $ok = $gas !== null && $worth * $this->cfg->feeShare >= $gas;
        return $ok ? array_merge($urgent, $rest) : $urgent;
    }

    private function claimCall(array $picked)
    {
        $claims = array_map(function ($x) {
            return Channels::claimEntry($x['c']);
        }, $picked);
        $signature = BatchSettlement::signClaimBatch($this->cfg->signingKey(), $claims, $this->cfg->chainId);
        return [
            'what' => 'claim ' . count($claims) . ' voucher(s)',
            'to' => BatchSettlement::ESCROW,
            'data' => BatchSettlement::encodeClaimWithSignature($claims, $signature),
        ];
    }

    public function run()
    {
        $all = $this->store->list();
        $report = [];
        foreach ($this->cfg->assets as $asset) {
            $report[$asset['symbol']] = $this->runAsset($asset, $all);
        }
        return $report;
    }

    private function runAsset(array $asset, array $all)
    {
        $cap = max(1, (int) $this->cfg->maxClaimsPerBatch);
        $found = $this->claimable($asset, $all);
        $wide = array_slice(array_merge($found['urgent'], $found['rest']), 0, $cap);
        $selected = array_slice($this->worthClaiming($asset, $all, $found), 0, $cap);
        $planFor = function ($riding) use ($asset) {
            try {
                return $this->payout->calls($asset['address'], $riding);
            } catch (\Throwable $e) {
                return ['calls' => [], 'owed' => '0', 'held' => '0', 'error' => \ZeamPass\message($e)];
            }
        };
        $plan = $planFor($selected !== []);
        $quoted = null;
        $widePlan = count($wide) === count($selected) ? $plan : $planFor($wide !== []);
        if ($widePlan['calls'] !== []) {
            $quoted = $this->relay->sendQuote(array_merge($wide !== [] ? [$this->claimCall($wide)] : [], $widePlan['calls']), $this->cfg->relaySplit());
            if ($quoted !== null) {
                $selected = $wide;
                $plan = $widePlan;
            }
        }
        $riding = Big::init(0);
        foreach ($selected as $x) {
            $riding = Big::add($riding, Big::init($x['units'], 10));
        }
        $payoutCalls = $plan['calls'];
        $usd = 0.0;
        $payoutOk = $quoted !== null && $quoted['covered'];
        if ($payoutCalls !== [] && $quoted !== null) {
            $units = Big::strval(Big::add(Big::add($riding, Big::init($plan['owed'], 10)), Big::init($plan['held'], 10)));
            $usd = $this->cfg->microUSDOf($asset, $units) / 1e6;
        } elseif ($payoutCalls !== []) {
            $units = Big::strval(Big::add(Big::add($riding, Big::init($plan['owed'], 10)), Big::init($plan['held'], 10)));
            $usd = $this->cfg->microUSDOf($asset, $units) / 1e6;
            $gasUnits = $this->cfg->gas['payout'] + ($selected !== [] ? $this->cfg->gas['claimBase'] + count($selected) * $this->cfg->gas['claimEntry'] : 0);
            foreach ($payoutCalls as $c) {
                if ($c['what'] === 'create split') {
                    $gasUnits += $this->cfg->gas['createSplit'];
                }
            }
            $payoutOk = $this->gas->atMargin($usd, $gasUnits);
        }
        $claiming = $payoutOk ? $selected : array_values(array_filter($selected, function ($x) {
            return $x['live']['withdrawing'];
        }));
        $calls = [];
        if ($claiming !== []) {
            $calls[] = $this->claimCall($claiming);
        }
        if ($payoutOk) {
            $calls = array_merge($calls, $payoutCalls);
        }
        $out = [
            'selected' => count($selected),
            'claimed' => [],
            'valueUSD' => round($usd, 6),
            'calls' => [],
        ];
        if (isset($plan['error'])) {
            $out['error'] = $plan['error'];
        }
        if ($payoutCalls !== [] && !$payoutOk) {
            $out['waiting'] = 'below break-even: waits until the fee share covers the gas';
        }
        if ($calls === []) {
            return $out;
        }
        $results = $this->relay->send($calls, $this->cfg->relaySplit());
        foreach ($calls as $i => $call) {
            $out['calls'][] = ['what' => $call['what']] + $results[$i];
        }
        if ($claiming !== [] && isset($results[0]['hash'])) {
            $deadline = $this->cfg->nowMs() + $this->cfg->stateCatchUpMs;
            foreach ($claiming as $x) {
                $id = $x['c']['channelId'];
                $expected = Channels::n($x['c']['chargedCumulativeAmount']);
                $st = null;
                while (true) {
                    try {
                        $st = $this->chain->channel($id);
                    } catch (\Throwable $e) {
                        $st = null;
                    }
                    if ($st !== null && Big::cmp(Channels::n($st['totalClaimed']), $expected) >= 0) {
                        break;
                    }
                    if ($this->cfg->nowMs() >= $deadline) {
                        break;
                    }
                    $this->cfg->sleepMs(150);
                }
                if ($st === null) {
                    continue;
                }
                $this->channels->update($id, function ($r) use ($st) {
                    if ($r === null) {
                        return null;
                    }
                    if (Big::cmp(Channels::n($st['totalClaimed']), Channels::n(isset($r['totalClaimed']) ? $r['totalClaimed'] : '0')) > 0) {
                        $r['totalClaimed'] = $st['totalClaimed'];
                    }
                    if (Big::cmp(Channels::n($st['balance']), Channels::n(isset($r['balance']) ? $r['balance'] : '0')) < 0) {
                        $r['balance'] = $st['balance'];
                    }
                    return $r;
                });
                $out['claimed'][] = $id;
            }
        }
        return $out;
    }
}
