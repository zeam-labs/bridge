<?php

namespace ZeamPass\Meter;

use ZeamPass\Pricing;
use ZeamPass\Secp256k1;
use ZeamPass\Settlement\Store;

final class TimeMeter
{
    const NONCE_SECS = 300;
    const KEEP_NONCES = 8;
    const DEFAULT_MS = 250;

    public $t;
    private $clocks;
    private $lines;
    private $now;
    private $owed;

    public function __construct(array $t, Store $clocks, Store $lines, ?callable $now = null, ?array $owed = null)
    {
        $this->t = $t;
        $this->owed = $owed;
        $this->clocks = $clocks;
        $this->lines = $lines;
        $this->now = $now ?: function () {
            return (int) floor(microtime(true) * 1000);
        };
    }

    private static function whole($v)
    {
        if (is_int($v)) {
            return $v;
        }
        if (is_bool($v)) {
            return $v ? 1 : 0;
        }
        if (is_float($v) && is_finite($v)) {
            return (int) ($v < 0 ? ceil($v) : floor($v));
        }
        if (is_string($v) && is_numeric(trim($v))) {
            return self::whole((float) trim($v));
        }
        return null;
    }

    public static function safeInt($v)
    {
        if (is_float($v) && is_finite($v) && floor($v) === $v) {
            $v = abs($v) <= 9007199254740991 ? (int) $v : null;
        }
        return is_int($v) && abs($v) <= 9007199254740991 ? $v : null;
    }

    private static function first(array $o, array $names)
    {
        foreach ($names as $name) {
            if (array_key_exists($name, $o) && $o[$name] !== null) {
                return $o[$name];
            }
        }
        return null;
    }

    private static function gcd($a, $b)
    {
        while ($b !== 0) {
            $next = $a % $b;
            $a = $b;
            $b = $next;
        }
        return $a;
    }

    public static function options($o)
    {
        if ($o === null || $o === false) {
            return null;
        }
        if (!is_array($o)) {
            throw new \InvalidArgumentException('bridge: time is { usd: "0.00025", ms: 250 }: that many dollars buys that many milliseconds');
        }
        $micro = Pricing::microOf(self::first($o, ['usd', 'block']), 'time.usd');
        $given = self::first($o, ['ms', 'blockMs']);
        $ms = $given !== null ? self::whole($given) : self::DEFAULT_MS;
        $idleMs = array_key_exists('idleMs', $o) && $o['idleMs'] !== null ? self::whole($o['idleMs']) : 0;
        $maxCalls = array_key_exists('maxCalls', $o) && $o['maxCalls'] !== null ? self::whole($o['maxCalls']) : Clock::MAX_LIVE_CALLS;
        if (!($ms !== null && $ms >= 1 && $ms <= 3600000)) {
            throw new \InvalidArgumentException('bridge: time.ms is 1 to 3600000');
        }
        if (!($idleMs !== null && $idleMs >= 0 && $idleMs <= 3600000)) {
            throw new \InvalidArgumentException('bridge: time.idleMs is 0 to 3600000');
        }
        if (!($maxCalls !== null && $maxCalls >= 1 && $maxCalls <= 1000)) {
            throw new \InvalidArgumentException('bridge: time.maxCalls is 1 to 1000');
        }
        $maxMs = null;
        $capped = false;
        if (array_key_exists('maxMs', $o) && $o['maxMs'] !== null) {
            $capped = true;
            $maxMs = self::whole($o['maxMs']);
        } elseif (array_key_exists('maxBlocks', $o) && $o['maxBlocks'] !== null) {
            $capped = true;
            $maxMs = is_numeric($o['maxBlocks']) ? self::whole((float) $o['maxBlocks'] * $ms) : null;
        }
        $g = self::gcd($micro, $ms);
        $rateMicro = intdiv($micro, $g);
        $rateMs = intdiv($ms, $g);
        if ($capped && !($maxMs !== null && $maxMs >= $rateMs && $maxMs % $rateMs === 0)) {
            throw new \InvalidArgumentException('bridge: time.maxMs is a multiple of ' . $rateMs . ' ms, the smallest amount this price sells; leave it out for no maximum');
        }
        return ['rateMicro' => $rateMicro, 'rateMs' => $rateMs, 'unitMs' => $ms, 'idleMs' => $idleMs, 'maxMs' => $maxMs, 'maxCalls' => $maxCalls];
    }

    public static function rate(array $t)
    {
        return '$' . Pricing::usd($t['rateMicro']) . ' per ' . ($t['rateMs'] === 1 ? 'ms' : $t['rateMs'] . ' ms');
    }

    public static function boughtMs(array $t, $args)
    {
        $a = is_array($args) ? $args : [];
        $ms = self::safeInt($a['ms'] ?? null);
        if ($ms !== null) {
            return $ms;
        }
        $blocks = self::safeInt($a['blocks'] ?? null);
        if ($blocks !== null && $blocks >= 1) {
            return $blocks * $t['unitMs'];
        }
        return $t['unitMs'];
    }

    public static function text(array $t, $base = '')
    {
        $idle = $t['idleMs'] > 0 ? ' and ' . $t['idleMs'] . ' ms after each' : '';
        $step = $t['rateMs'] > 1 ? ' in steps of ' . $t['rateMs'] . ' ms' : '';
        $most = empty($t['maxMs']) ? '' : ' (up to ' . $t['maxMs'] . ' ms a purchase)';
        return 'Line time: ' . self::rate($t) . '. buy_time {"ms": N}' . $step . $most . '; buying again adds time; the time is credited to the paying channel once the payment settles. Open a line: POST ' . $base . '/line {"op":"open","channelId":"0x…"}, sign the message it returns with the payer key, POST {"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"}. Send the credential as x-line (MCP: _meta["zeam-pass/line"]). Time burns while a call runs on the line' . $idle . '; a call stops when the time runs out. {"op":"off"}: no new calls on any line of the channel; a running call burns to its end. Unburned time comes back with a refund.';
    }

    public static function hash($credential)
    {
        return '0x' . hash('sha256', (string) $credential);
    }

    public function nowMs()
    {
        return (int) call_user_func($this->now);
    }

    public static function callMsOf(array $t, $priceMicro)
    {
        return min(Pricing::mulDiv($priceMicro, $t['rateMs'], $t['rateMicro']), 9007199254740991);
    }

    public static function micro(array $t, $ms)
    {
        $micro = intdiv($ms, $t['rateMs']) * $t['rateMicro'];
        if (!is_int($micro) || $micro > Pricing::MAX_MICRO) {
            throw new \InvalidArgumentException('bridge: that much line time costs more than $' . Pricing::MAX_USD . '; above that a number stops counting micro-USD exactly. Buy less at a time');
        }
        return $micro;
    }

    public function callMs($priceMicro)
    {
        return self::callMsOf($this->t, $priceMicro);
    }

    private function owing($channelId)
    {
        if ($this->owed === null) {
            return null;
        }
        $o = call_user_func($this->owed['read'], strtolower((string) $channelId));
        return is_array($o) && $o !== [] ? $o : null;
    }

    public function change($channelId, callable $fn)
    {
        $id = strtolower((string) $channelId);
        $owed = $this->owing($id);
        $out = null;
        $this->clocks->update($id, function ($current) use ($id, $fn, $owed, &$out) {
            $rec = $current === null ? Clock::fresh($id) : Clock::normalize($current);
            if ($owed !== null) {
                Clock::owe($rec, $owed, $this->nowMs(), $this->t['idleMs']);
            }
            $out = $fn($rec);
            return Clock::snapshot($rec);
        });
        if ($owed !== null) {
            try {
                call_user_func($this->owed['paid'], $id, array_map('strval', array_keys($owed)));
            } catch (\Throwable $e) {
            }
        }
        return $out;
    }

    private function record($channelId)
    {
        $raw = $this->clocks->get(strtolower((string) $channelId));
        return $raw === null ? null : Clock::normalize($raw);
    }

    public function status($channelId)
    {
        $owed = $this->owing($channelId);
        $rec = $this->record($channelId);
        $rec = $rec === null ? Clock::fresh($channelId) : $rec;
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        if ($owed !== null) {
            Clock::owe($rec, $owed, $now, $idle);
        }
        return ['channelId' => $rec['channelId'], 'msRemaining' => Clock::remaining($rec, $now, $idle), 'msSpent' => Clock::spent($rec, $now, $idle), 'msReturned' => $rec['returnedMs'], 'metering' => $rec['on'], 'rateUSD' => Pricing::usd($this->t['rateMicro']), 'rateMs' => $this->t['rateMs']];
    }

    public function credit($channelId, $ms, $key)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        return $this->change($channelId, function (array &$rec) use ($ms, $key, $now, $idle) {
            return Clock::buy($rec, $ms, (string) $key, $now, $idle);
        });
    }

    public function uncredit($channelId, $ms, $key)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        return $this->change($channelId, function (array &$rec) use ($ms, $key, $now, $idle) {
            return Clock::unbuy($rec, $ms, (string) $key, $now, $idle);
        });
    }

    public function switch($channelId, $on)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        return $this->change($channelId, function (array &$rec) use ($on, $now, $idle) {
            Clock::switch($rec, $on, $now, $idle);
            return Clock::left($rec, $now, $idle);
        });
    }

    public function stop($channelId)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        return $this->change($channelId, function (array &$rec) use ($now, $idle) {
            foreach ($rec['calls'] as $c) {
                if ($c['deadline'] > $now) {
                    return false;
                }
            }
            Clock::switch($rec, false, $now, $idle);
            return true;
        });
    }

    public function begin($channelId, $id)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        $cap = array_key_exists('maxCalls', $this->t) ? $this->t['maxCalls'] : Clock::MAX_LIVE_CALLS;
        $b = $this->change($channelId, function (array &$rec) use ($id, $now, $idle, $cap) {
            return Clock::begin($rec, $id, $now, $idle, $cap);
        });
        return $b['ok'] ? $b + ['started' => $this->nowMs()] : $b;
    }

    public function renew($channelId, $id, $started = null, $last = null)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        return $this->change($channelId, function (array &$rec) use ($id, $now, $idle, $started, $last) {
            return Clock::renew($rec, $id, $now, $idle, $started, $last);
        });
    }

    public function end($channelId, $id, $started = null, $stopped = null)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        return $this->change($channelId, function (array &$rec) use ($id, $now, $idle, $started, $stopped) {
            return Clock::end($rec, $id, $now, $idle, $started, $stopped) + ['msRemaining' => Clock::left($rec, $now, $idle)];
        });
    }

    public function busy($channelId)
    {
        $rec = $this->record($channelId);
        if ($rec === null) {
            return false;
        }
        $now = $this->nowMs();
        foreach ($rec['calls'] as $c) {
            if ($c['deadline'] > $now) {
                return true;
            }
        }
        return false;
    }

    public function unburnedMicro($channelId)
    {
        $owed = $this->owing($channelId);
        $rec = $this->record($channelId);
        if ($rec === null && $owed === null) {
            return 0;
        }
        $rec = $rec === null ? Clock::fresh(strtolower((string) $channelId)) : $rec;
        $now = $this->nowMs();
        if ($owed !== null) {
            Clock::owe($rec, $owed, $now, $this->t['idleMs']);
        }
        return Clock::unburnedMicro($rec, $now, $this->t['idleMs'], $this->t['rateMicro'], $this->t['rateMs']);
    }

    private function drop($hash)
    {
        try {
            $this->lines->update($hash, function () {
                return null;
            });
        } catch (\Throwable $e) {
            return;
        }
    }

    public function forget($channelId)
    {
        $now = $this->nowMs();
        $idle = $this->t['idleMs'];
        $lines = [];
        $returned = $this->change($channelId, function (array &$rec) use ($now, $idle, &$lines) {
            $lines = $rec['lines'];
            $rec['lines'] = [];
            return Clock::forget($rec, $now, $idle);
        });
        foreach ($lines as $h) {
            $this->drop($h);
        }
        return $returned;
    }

    public function challenge($channelId)
    {
        $nonce = bin2hex(random_bytes(16));
        $now = $this->nowMs();
        $message = Clock::lineMessage($channelId, $nonce);
        return $this->change($channelId, function (array &$rec) use ($nonce, $now, $message) {
            $live = [];
            foreach ($rec['nonces'] as $n => $until) {
                if ($until > $now) {
                    $live[(string) $n] = $until;
                }
            }
            $live = array_slice($live, -(self::KEEP_NONCES - 1), null, true);
            $live[$nonce] = $now + self::NONCE_SECS * 1000;
            $rec['nonces'] = $live;
            return ['nonce' => $nonce, 'message' => $message, 'expiresInSeconds' => self::NONCE_SECS];
        });
    }

    public function prove(array $channel, $nonce, $signature, $gate = null)
    {
        if ($nonce === null || $nonce === '') {
            return ['ok' => false, 'status' => 400, 'code' => 'bad_request', 'why' => 'nonce is missing: send the nonce the open answer gave, with your signature of its message'];
        }
        if (!is_string($signature) || $signature === '') {
            return ['ok' => false, 'status' => 400, 'code' => 'bad_request', 'why' => 'signature is missing or is not a string: sign the message the open answer gave and send it with the nonce'];
        }
        $channelId = strtolower((string) $channel['channelId']);
        $now = $this->nowMs();
        $n = is_scalar($nonce) ? (string) $nonce : '';
        $live = $this->change($channelId, function (array &$rec) use ($n, $now) {
            $until = array_key_exists($n, $rec['nonces']) ? $rec['nonces'][$n] : null;
            unset($rec['nonces'][$n]);
            return $until !== null && $until > $now;
        });
        if (!$live) {
            return ['ok' => false, 'status' => 400, 'code' => 'no_challenge', 'why' => 'no live challenge with that nonce. Send {"op":"open","channelId":"0x…"} again and sign what it returns.'];
        }
        try {
            $who = strtolower(Secp256k1::recoverPersonal(Clock::lineMessage($channelId, $n), is_scalar($signature) ? (string) $signature : ''));
        } catch (\Throwable $e) {
            return ['ok' => false, 'status' => 400, 'code' => 'bad_signature', 'why' => 'the signature does not recover: ' . substr(\ZeamPass\message($e), 0, 80)];
        }
        $payer = strtolower(isset($channel['channelConfig']['payer']) ? (string) $channel['channelConfig']['payer'] : '');
        $auth = strtolower(isset($channel['channelConfig']['payerAuthorizer']) ? (string) $channel['channelConfig']['payerAuthorizer'] : '');
        if ($who !== $payer && $who !== $auth) {
            return ['ok' => false, 'status' => 403, 'code' => 'not_the_payer', 'why' => $who . ' is not this channel\'s payer'];
        }
        $credential = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $h = self::hash($credential);
        $idle = $this->t['idleMs'];
        $attach = function ($refusal = null) use ($channelId, $h, $idle) {
            return $this->change($channelId, function (array &$rec) use ($h, $idle, $refusal) {
                $at = $this->nowMs();
                if (count($rec['lines']) === 0) {
                    if ($refusal !== null) {
                        return ['refused' => $refusal];
                    }
                    Clock::switch($rec, true, $at, $idle);
                }
                $rec['lines'] = array_merge($rec['lines'], [$h]);
                return ['msRemaining' => Clock::left($rec, $at, $idle), 'metering' => (bool) $rec['on']];
            });
        };
        $opened = $gate === null ? $attach() : $gate($attach);
        if (isset($opened['refused'])) {
            return ['ok' => false, 'refused' => $opened['refused']];
        }
        $this->lines->update($h, function () use ($channelId, $now) {
            return ['channelId' => $channelId, 'at' => $now];
        });
        return ['ok' => true, 'credential' => $credential, 'channelId' => $channelId, 'msRemaining' => $opened['msRemaining'], 'metering' => $opened['metering']];
    }

    public function line($credential)
    {
        if (!is_string($credential) || $credential === '') {
            return null;
        }
        $hit = $this->lines->get(self::hash($credential));
        return is_array($hit) && isset($hit['channelId']) ? (string) $hit['channelId'] : null;
    }

    public function close($credential)
    {
        $h = self::hash($credential);
        $hit = $this->lines->get($h);
        if (!is_array($hit) || !isset($hit['channelId'])) {
            return null;
        }
        $this->lines->update($h, function () {
            return null;
        });
        $this->change($hit['channelId'], function (array &$rec) use ($h) {
            $rec['lines'] = array_values(array_filter($rec['lines'], function ($x) use ($h) {
                return $x !== $h;
            }));
            return null;
        });
        return (string) $hit['channelId'];
    }
}
