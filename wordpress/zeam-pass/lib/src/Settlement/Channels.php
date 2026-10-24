<?php

namespace ZeamPass\Settlement;

use ZeamPass\Big;

final class Channels
{
    const REFUNDING_TTL_MS = 180000;
    const JUDGING_TTL_MS = 30000;
    const JUDGING_POLL_MS = 20;

    private $cfg;
    private $store;
    private $chain;

    public function __construct(?Config $cfg, Store $store, ?Chain $chain = null)
    {
        $this->cfg = $cfg;
        $this->store = $store;
        $this->chain = $chain;
    }

    public static function refundingWaitMs($c, $now)
    {
        $until = ($c === null || !isset($c['refundingUntil'])) ? 0 : (int) $c['refundingUntil'];
        return $until > $now ? $until - $now : 0;
    }

    public static function refundingRetrySecs($cfg, $c, $now)
    {
        return self::retrySecs($cfg, self::refundingWaitMs($c, $now));
    }

    public static function retrySecs($cfg, $left)
    {
        $look = max(1, (int) ($cfg !== null && isset($cfg->drainWaitMs) ? $cfg->drainWaitMs : Config::DRAIN_WAIT_MS));
        return max(1, (int) ceil(min($left > 0 ? $left : $look, $look) / 1000));
    }

    public static function judging($c, $now)
    {
        return $c !== null && isset($c['refundingJudging']) && $c['refundingJudging'] === true && self::refundingWaitMs($c, $now) > 0;
    }

    public static function checking($c, $now)
    {
        return self::judging($c, $now) && ($c['refundingCheck'] ?? null) === true;
    }

    public static function weighed($c, $now)
    {
        if ($c === null || !isset($c['refundsJudged']) || !is_array($c['refundsJudged'])) {
            return [];
        }
        return array_filter($c['refundsJudged'], function ($until) use ($now) {
            return (int) $until > $now;
        });
    }

    public static function beingJudged($c, $now)
    {
        return count(self::weighed($c, $now)) > 0;
    }

    public static function judgedRetrySecs($cfg, $c, $now)
    {
        $until = max(array_merge([0], array_map('intval', array_values(self::weighed($c, $now)))));
        return self::retrySecs($cfg, $until > $now ? $until - $now : 0);
    }

    public static function held($c, $now, $pending = false)
    {
        return self::judging($c, $now) || ($pending && self::beingJudged($c, $now) && self::refundingWaitMs($c, $now) === 0);
    }

    public static function unweighed(array $r, $holder, $now)
    {
        $rest = self::weighed($r, $now);
        unset($rest[$holder]);
        if (count($rest) > 0) {
            $r['refundsJudged'] = $rest;
        } else {
            unset($r['refundsJudged']);
        }
        return $r;
    }

    private function nowMs()
    {
        return $this->cfg !== null ? $this->cfg->nowMs() : (int) floor(microtime(true) * 1000);
    }

    private function sleepMs($ms)
    {
        if ($this->cfg !== null) {
            $this->cfg->sleepMs($ms);
            return;
        }
        usleep((int) $ms * 1000);
    }

    public function judgeWaitMs()
    {
        return max(0, (int) ($this->cfg !== null && isset($this->cfg->refundJudgeWaitMs) ? $this->cfg->refundJudgeWaitMs : 5000));
    }

    public function checked($channelId)
    {
        $deadline = $this->nowMs() + $this->judgeWaitMs();
        for (;;) {
            $c = $this->get($channelId);
            $now = $this->nowMs();
            if (!self::checking($c, $now) || $now >= $deadline) {
                return $c;
            }
            $this->sleepMs(self::JUDGING_POLL_MS);
        }
    }

    public function judged($channelId, $pending = false)
    {
        $deadline = $this->nowMs() + $this->judgeWaitMs();
        for (;;) {
            $c = $this->get($channelId);
            $now = $this->nowMs();
            if (!self::held($c, $now, $pending) || $now >= $deadline) {
                return $c;
            }
            $this->sleepMs(self::JUDGING_POLL_MS);
        }
    }

    public function weigh($channelId, $holder)
    {
        $deadline = $this->nowMs() + $this->judgeWaitMs();
        for (;;) {
            $wait = false;
            try {
                $this->update($channelId, function ($r) use ($holder, $deadline, &$wait) {
                    if ($r === null) {
                        return $r;
                    }
                    $now = $this->nowMs();
                    $weighed = Channels::weighed($r, $now);
                    if ($now < $deadline && Channels::judging($r, $now) && !array_key_exists((string) ($r['refundingBy'] ?? ''), $weighed)) {
                        $wait = true;
                        return $r;
                    }
                    $weighed[$holder] = $now + Channels::JUDGING_TTL_MS;
                    $r['refundsJudged'] = $weighed;
                    return $r;
                });
            } catch (\Throwable $e) {
                return false;
            }
            if (!$wait) {
                return true;
            }
            $this->sleepMs(self::JUDGING_POLL_MS);
        }
    }

    public function unweigh($channelId, $holder)
    {
        try {
            $this->update($channelId, function ($r) use ($holder) {
                return $r === null ? $r : Channels::unweighed($r, $holder, $this->nowMs());
            });
        } catch (\Throwable $e) {
        }
    }

    public function mark($channelId, $holder, $refuseOpen = true, $sending = false)
    {
        $cfg = $this->cfg;
        for (;;) {
            $out = ['ok' => true];
            try {
                $this->update($channelId, function ($r) use ($cfg, $holder, $refuseOpen, $sending, &$out) {
                    if ($r === null) {
                        return $r;
                    }
                    $now = $this->nowMs();
                    if ($sending && isset($r['refundingBy']) && $r['refundingBy'] === $holder && Channels::checking($r, $now)) {
                        return $r;
                    }
                    if (Channels::judging($r, $now)) {
                        $out = ['wait' => true];
                    } elseif (Channels::refundingWaitMs($r, $now) > 0) {
                        $out = ['settling' => Channels::refundingRetrySecs($cfg, $r, $now)];
                    } elseif (!$sending && Channels::beingJudged($r, $now)) {
                        $out = ['judged' => Channels::judgedRetrySecs($cfg, $r, $now)];
                    } elseif ($refuseOpen && Channels::pendingLive($r, $now)) {
                        $out = ['open' => $r, 'at' => $now];
                    } elseif ($sending) {
                        $r['refundingUntil'] = $now + Channels::JUDGING_TTL_MS;
                        $r['refundingBy'] = $holder;
                        $r['refundingJudging'] = true;
                        $r['refundingCheck'] = true;
                    } else {
                        $r['refundingUntil'] = $now + Channels::JUDGING_TTL_MS;
                        $r['refundingBy'] = $holder;
                        $r['refundingJudging'] = true;
                    }
                    return $r;
                });
            } catch (\Throwable $e) {
                return ['unavailable' => true];
            }
            if (!isset($out['wait'])) {
                return $out;
            }
            $this->sleepMs(self::JUDGING_POLL_MS);
        }
    }

    public function sending($channelId, $holder)
    {
        $other = null;
        $cfg = $this->cfg;
        try {
            $this->update($channelId, function ($r) use ($cfg, $holder, &$other) {
                if ($r === null) {
                    return $r;
                }
                $now = $this->nowMs();
                if (!isset($r['refundingBy']) || $r['refundingBy'] !== $holder || Channels::refundingWaitMs($r, $now) === 0) {
                    $other = Channels::refundingWaitMs($r, $now) > 0 ? ['settling' => Channels::refundingRetrySecs($cfg, $r, $now)] : ['unavailable' => true];
                    return $r;
                }
                $r['refundingUntil'] = $now + Channels::REFUNDING_TTL_MS;
                $r['refundingBy'] = $holder;
                unset($r['refundingJudging'], $r['refundingCheck']);
                return Channels::unweighed($r, $holder, $now);
            });
        } catch (\Throwable $e) {
            return ['unavailable' => true];
        }
        return $other;
    }

    public function unmark($channelId, $holder)
    {
        try {
            $this->update($channelId, function ($r) use ($holder) {
                if ($r === null) {
                    return $r;
                }
                if (isset($r['refundingBy']) && $r['refundingBy'] === $holder) {
                    unset($r['refundingUntil'], $r['refundingBy'], $r['refundingJudging'], $r['refundingCheck']);
                }
                return Channels::unweighed($r, $holder, $this->nowMs());
            });
        } catch (\Throwable $e) {
        }
    }

    public static function n($value)
    {
        if (Big::is($value)) {
            return $value;
        }
        if ($value === null || $value === '') {
            return Big::init(0);
        }
        if (is_int($value)) {
            return Big::init($value);
        }
        return Big::init((string) $value, 10);
    }

    public static function max($a, $b)
    {
        return Big::cmp(self::n($a), self::n($b)) >= 0 ? self::n($a) : self::n($b);
    }

    public function serial($channelId, callable $fn)
    {
        return method_exists($this->store, 'serial') ? $this->store->serial(strtolower((string) $channelId), $fn) : $fn();
    }

    public function serialBusy($channelId)
    {
        return method_exists($this->store, 'serialBusy') ? (bool) $this->store->serialBusy(strtolower((string) $channelId)) : false;
    }

    public function ticket($channelId)
    {
        if (!method_exists($this->store, 'ticket')) {
            return null;
        }
        return $this->store->ticket(strtolower((string) $channelId), $this->nowMs() + self::JUDGING_TTL_MS);
    }

    public function ahead($channelId, $ticket)
    {
        if ($ticket === null) {
            return [];
        }
        $id = strtolower((string) $channelId);
        $now = $this->nowMs();
        $this->store->renew($id, $ticket, $now + self::JUDGING_TTL_MS);
        return $this->store->ahead($id, $ticket, $now);
    }

    public function awaitTicket($channelId, array $earlier, $untilMs)
    {
        $now = $this->nowMs();
        if ($untilMs <= $now) {
            return false;
        }
        return method_exists($this->store, 'awaitTicket') ? $this->store->awaitTicket(strtolower((string) $channelId), $earlier, (int) $untilMs, $now) : null;
    }

    public function untick($channelId, $ticket)
    {
        if ($ticket === null) {
            return;
        }
        try {
            $this->store->untick(strtolower((string) $channelId), $ticket);
        } catch (\Throwable $e) {
        }
    }

    public function get($channelId)
    {
        return $this->store->get(strtolower($channelId));
    }

    public function update($channelId, callable $fn)
    {
        return $this->store->update(strtolower($channelId), $fn);
    }

    public function repaired($channelId)
    {
        $channel = $this->get($channelId);
        if ($channel === null) {
            return null;
        }
        $now = $this->cfg->nowMs();
        $last = isset($channel['repairedAt']) ? (int) $channel['repairedAt'] : 0;
        if (empty($channel['handedOver']) && $now - $last < $this->cfg->repairEveryMs) {
            return $channel;
        }
        try {
            $st = $this->chain->channel($channelId);
        } catch (\Throwable $e) {
            return $channel;
        }
        $nonce = null;
        if (!empty($channel['handedOver'])) {
            try {
                $nonce = $this->chain->refundNonce($channelId);
            } catch (\Throwable $e) {
                $nonce = null;
            }
        }
        $cfg = $this->cfg;
        return $this->update($channelId, function ($c) use ($st, $nonce, $now, $cfg, $channel) {
            if ($c === null) {
                return null;
            }
            $c['repairedAt'] = $now;
            if (!empty($c['handedOver'])) {
                if ($nonce !== null && (string) $nonce !== (string) $c['handedOver']['nonce']) {
                    unset($c['handedOver']);
                    $c['balance'] = $st['balance'];
                }
            } elseif (isset($c['balance']) && Big::cmp(Channels::n($st['balance']), Channels::n($c['balance'])) < 0) {
                $c['balance'] = $st['balance'];
            } elseif (isset($c['balance'], $channel['balance']) && Big::cmp(Channels::n($st['balance']), Channels::n($c['balance'])) > 0 && (string) $c['balance'] === (string) $channel['balance'] && Channels::refundingWaitMs($c, $now) === 0) {
                $c['balance'] = $st['balance'];
            }
            $charged = Channels::n(isset($c['chargedCumulativeAmount']) ? $c['chargedCumulativeAmount'] : '0');
            if (Big::cmp(Channels::n($st['totalClaimed']), $charged) > 0) {
                $c['chargedCumulativeAmount'] = $st['totalClaimed'];
                $c['totalClaimed'] = $st['totalClaimed'];
            }
            return $c;
        });
    }

    public function leaving(array $channel)
    {
        $id = $channel['channelId'];
        $stamped = isset($channel['withdrawRequestedAt']) && (int) $channel['withdrawRequestedAt'] > 0;
        try {
            $w = $this->chain->pendingWithdrawal($id);
        } catch (\Throwable $e) {
            return $stamped;
        }
        $leaving = Big::sign(self::n($w['amount'])) > 0;
        if ($leaving !== $stamped) {
            $now = $this->cfg->nowMs();
            $this->update($id, function ($c) use ($leaving, $now) {
                if ($c === null) {
                    return null;
                }
                $c['withdrawRequestedAt'] = $leaving ? $now : 0;
                return $c;
            });
        }
        return $leaving;
    }

    public function release($channelId, $pendingId = null)
    {
        $had = false;
        try {
            $this->update($channelId, function ($c) use ($pendingId, &$had) {
                if ($c === null || !isset($c['pendingRequest'])) {
                    return $c;
                }
                if ($pendingId !== null && (!isset($c['pendingRequest']['pendingId']) || $c['pendingRequest']['pendingId'] !== $pendingId)) {
                    return $c;
                }
                $had = true;
                unset($c['pendingRequest']);
                return $c;
            });
        } catch (\Throwable $e) {
            return false;
        }
        return $had;
    }

    public static function pendingLive(?array $channel, $now = 0)
    {
        return $channel !== null && isset($channel['pendingRequest']['expiresAt']) && (int) $channel['pendingRequest']['expiresAt'] > $now;
    }

    public static function claimable(array $c)
    {
        if (empty($c['signature']) || empty($c['signedMaxClaimable'])) {
            return false;
        }
        try {
            $charged = self::n(isset($c['chargedCumulativeAmount']) ? $c['chargedCumulativeAmount'] : '0');
            $signed = self::n($c['signedMaxClaimable']);
            $claimed = self::n(isset($c['totalClaimed']) ? $c['totalClaimed'] : '0');
            $balance = self::n(isset($c['balance']) ? $c['balance'] : '0');
        } catch (\Throwable $e) {
            return false;
        }
        if (Big::sign($charged) <= 0 || Big::cmp($charged, $claimed) <= 0 || Big::cmp($charged, $signed) > 0 || Big::cmp($charged, $balance) > 0) {
            return false;
        }
        return Big::cmp(Big::sub($charged, $claimed), Big::sub($balance, $claimed)) <= 0;
    }

    public static function earned(Config $cfg, array $c)
    {
        if ($cfg->meter === null || empty($c['channelId']) || empty($c['channelConfig']['token'])) {
            return $c;
        }
        $micro = $cfg->meter->unburnedMicro($c['channelId']);
        $asset = $micro > 0 ? $cfg->assetOf($c['channelConfig']['token']) : null;
        if ($asset === null) {
            return $c;
        }
        $charged = self::n(isset($c['chargedCumulativeAmount']) ? $c['chargedCumulativeAmount'] : '0');
        $claimed = self::n(isset($c['totalClaimed']) ? $c['totalClaimed'] : '0');
        $net = Big::sub($charged, Big::init($cfg->unitsOfMicroUSD($asset, $micro), 10));
        if (Big::cmp($net, $claimed) < 0) {
            $net = $claimed;
        }
        if (Big::cmp($net, $charged) >= 0) {
            return $c;
        }
        $c['chargedCumulativeAmount'] = Big::strval($net);
        return $c;
    }

    public static function refundable(array $c, array $live)
    {
        $charged = self::n(isset($c['chargedCumulativeAmount']) ? $c['chargedCumulativeAmount'] : '0');
        $left = Big::sub(self::n($live['balance']), self::max($charged, $live['claimed']));
        return Big::sign($left) > 0 ? Big::strval($left) : '0';
    }

    public static function claimEntry(array $c)
    {
        return [
            'voucher' => ['channel' => $c['channelConfig'], 'maxClaimableAmount' => (string) $c['signedMaxClaimable']],
            'signature' => $c['signature'],
            'totalClaimed' => (string) $c['chargedCumulativeAmount'],
        ];
    }
}
