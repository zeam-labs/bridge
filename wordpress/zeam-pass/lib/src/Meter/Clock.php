<?php

namespace ZeamPass\Meter;

final class Clock
{
    const KEEP_CREDITED = 64;

    const HOLD_MS = 2000;
    const KEEP_DONE = 512;
    const MAX_LIVE_CALLS = 1000;

    public static function fresh($channelId)
    {
        return ['channelId' => strtolower((string) $channelId), 'balanceMs' => 0, 'spentMs' => 0, 'returnedMs' => 0, 'on' => false, 'since' => null, 'lastActive' => null, 'calls' => [], 'done' => [], 'credited' => [], 'nonces' => [], 'lines' => []];
    }

    public static function merged(array $intervals)
    {
        $sorted = array_values(array_filter($intervals, function ($x) {
            return $x[1] > $x[0];
        }));
        usort($sorted, function ($a, $b) {
            return $a[0] === $b[0] ? $a[1] <=> $b[1] : $a[0] <=> $b[0];
        });
        $out = [];
        foreach ($sorted as $x) {
            $n = count($out);
            if ($n > 0 && $x[0] <= $out[$n - 1][1]) {
                $out[$n - 1][1] = max($out[$n - 1][1], $x[1]);
            } else {
                $out[] = [$x[0], $x[1]];
            }
        }
        return $out;
    }

    public static function covered(array $intervals)
    {
        $total = 0;
        foreach (self::merged($intervals) as $x) {
            $total += $x[1] - $x[0];
        }
        return $total;
    }

    public static function spans(array $rec, $from, $to, $idleMs = 0)
    {
        $out = [];
        foreach (isset($rec['done']) ? $rec['done'] : [] as $d) {
            $out[] = [max($d[0], $from), min($d[1], $to)];
        }
        foreach ($rec['calls'] as $c) {
            $out[] = [max($c['start'], $from), min($to, $c['deadline'])];
        }
        if ($rec['on'] && $idleMs > 0 && $rec['lastActive'] !== null) {
            $out[] = [max($rec['lastActive'], $from), min($to, $rec['lastActive'] + $idleMs)];
        }
        return $out;
    }

    public static function settle(array &$rec, $now, $idleMs = 0)
    {
        $rec['done'] = isset($rec['done']) ? $rec['done'] : [];
        if ($rec['since'] === null) {
            $rec['since'] = $now;
            foreach ($rec['calls'] as $id => $c) {
                if ($c['deadline'] <= $now) {
                    unset($rec['calls'][$id]);
                }
            }
            return $rec;
        }
        foreach ($rec['calls'] as $id => $c) {
            if ($c['deadline'] > $now) {
                continue;
            }
            $rec['done'][] = [$c['start'], $c['deadline']];
            unset($rec['calls'][$id]);
        }
        $rec['done'] = self::merged($rec['done']);
        $horizon = max($rec['since'], $now - self::HOLD_MS);
        $n = count($rec['done']);
        if ($n > self::KEEP_DONE) {
            $horizon = max($horizon, min($now, $rec['done'][$n - self::KEEP_DONE - 1][1]));
        }
        $burned = min($rec['balanceMs'], self::covered(self::spans($rec, $rec['since'], $horizon, $idleMs)));
        $rec['balanceMs'] -= $burned;
        $rec['spentMs'] += $burned;
        $rec['since'] = $horizon;
        $kept = [];
        foreach ($rec['done'] as $d) {
            if ($d[1] > $horizon) {
                $kept[] = [max($d[0], $horizon), $d[1]];
            }
        }
        $rec['done'] = $kept;
        return $rec;
    }

    public static function pending(array $rec, $now, $idleMs = 0)
    {
        $from = $rec['since'] === null ? $now : $rec['since'];
        return min($rec['balanceMs'], self::covered(self::spans($rec, $from, $now, $idleMs)));
    }

    public static function left(array $rec, $now, $idleMs = 0)
    {
        return $rec['balanceMs'] - self::pending($rec, $now, $idleMs);
    }

    public static function remaining(array $rec, $now, $idleMs = 0)
    {
        self::settle($rec, $now, $idleMs);
        return self::left($rec, $now, $idleMs);
    }

    public static function spent(array $rec, $now, $idleMs = 0)
    {
        self::settle($rec, $now, $idleMs);
        return $rec['spentMs'] + self::pending($rec, $now, $idleMs);
    }

    public static function active(array &$rec, $at, $idleMs = 0)
    {
        $last = $rec['lastActive'];
        if ($rec['on'] && $idleMs > 0 && $last !== null && $at > $last) {
            $rec['done'][] = [$last, min($at, $last + $idleMs)];
        }
        $rec['lastActive'] = $last === null ? $at : max($last, $at);
    }

    public static function switch(array &$rec, $on, $now, $idleMs = 0)
    {
        self::settle($rec, $now, $idleMs);
        self::active($rec, $now, $idleMs);
        $rec['on'] = (bool) $on;
        return $rec;
    }

    public static function begin(array &$rec, $id, $now, $idleMs = 0, $cap = null)
    {
        self::settle($rec, $now, $idleMs);
        if (!$rec['on']) {
            return ['ok' => false, 'code' => 'meter_off'];
        }
        $left = self::left($rec, $now, $idleMs);
        if ($left <= 0) {
            return ['ok' => false, 'code' => 'out_of_time'];
        }
        if ($cap !== null && count($rec['calls']) >= $cap) {
            return ['ok' => false, 'code' => 'too_many_calls'];
        }
        self::active($rec, $now, $idleMs);
        $deadline = $now + $left;
        $rec['calls'][(string) $id] = ['start' => $now, 'deadline' => $deadline];
        return ['ok' => true, 'deadline' => $deadline];
    }

    public static function end(array &$rec, $id, $now, $idleMs = 0, $start = null, $stop = null)
    {
        $rec['done'] = isset($rec['done']) ? $rec['done'] : [];
        $id = (string) $id;
        $c = isset($rec['calls'][$id]) ? $rec['calls'][$id] : null;
        $ran = min($stop === null ? $now : $stop, $now);
        $from = $c === null ? $ran : $c['start'];
        if ($c !== null) {
            if ($start !== null && $start > $c['start'] && $ran <= $c['deadline']) {
                $from = min($start, $ran);
            }
            $rec['done'][] = [$from, min($ran, $c['deadline'])];
            unset($rec['calls'][$id]);
        }
        self::active($rec, $ran, $idleMs);
        self::settle($rec, $now, $idleMs);
        return ['elapsedMs' => $c === null ? 0 : $ran - $from, 'over' => $c === null || $ran > $c['deadline']];
    }

    public static function renew(array &$rec, $id, $now, $idleMs = 0, $start = null, $last = null)
    {
        $rec['done'] = isset($rec['done']) ? $rec['done'] : [];
        $id = (string) $id;
        $c = isset($rec['calls'][$id]) ? $rec['calls'][$id] : null;
        $due = $c === null ? $last : $c['deadline'];
        if ($c !== null) {
            $rec['done'][] = [$start !== null && $start > $c['start'] ? $start : $c['start'], min($now, $c['deadline'])];
        }
        unset($rec['calls'][$id]);
        $covers = $now;
        if ($due !== null && $due < $now && $rec['since'] !== null) {
            $covers = min($now, $due + max(0, self::left($rec, $now, $idleMs)));
        }
        if ($due !== null && $covers > $due) {
            $rec['done'][] = [$due, $covers];
        }
        self::settle($rec, $now, $idleMs);
        $left = self::left($rec, $now, $idleMs);
        if ($covers < $now || $left <= 0) {
            return ['ok' => false, 'code' => 'out_of_time'];
        }
        $deadline = $now + $left;
        $rec['calls'][$id] = ['start' => $now, 'deadline' => $deadline];
        return ['ok' => true, 'deadline' => $deadline];
    }

    public static function buy(array &$rec, $ms, $key, $now, $idleMs = 0)
    {
        if (in_array((string) $key, $rec['credited'], true)) {
            return false;
        }
        self::settle($rec, $now, $idleMs);
        $rec['balanceMs'] += (int) $ms;
        $credited = $rec['credited'];
        $credited[] = (string) $key;
        $rec['credited'] = array_values(array_slice($credited, -self::KEEP_CREDITED));
        return true;
    }

    public static function owe(array &$rec, $owed, $now, $idleMs = 0)
    {
        foreach (is_array($owed) ? $owed : [] as $key => $ms) {
            if (is_int($ms) && $ms > 0 && $ms <= 9007199254740991) {
                self::buy($rec, $ms, (string) $key, $now, $idleMs);
            }
        }
        return $rec;
    }

    public static function unbuy(array &$rec, $ms, $key, $now, $idleMs = 0)
    {
        $key = (string) $key;
        if (!in_array($key, $rec['credited'], true)) {
            return 0;
        }
        self::settle($rec, $now, $idleMs);
        $taken = max(0, min((int) $ms, self::left($rec, $now, $idleMs)));
        $rec['balanceMs'] -= $taken;
        $rec['credited'] = array_values(array_filter($rec['credited'], function ($k) use ($key) {
            return $k !== $key;
        }));
        return $taken;
    }

    public static function unburnedMicro(array $rec, $now, $idleMs, $rateMicro, $rateMs)
    {
        $left = self::remaining($rec, $now, $idleMs);
        return \ZeamPass\Pricing::mulDiv($left, $rateMicro, $rateMs, (int) $rateMs - 1);
    }

    public static function forget(array &$rec, $now, $idleMs = 0)
    {
        self::settle($rec, $now, $idleMs);
        $burning = self::pending($rec, $now, $idleMs);
        $returned = $rec['balanceMs'] - $burning;
        $rec['spentMs'] += $burning;
        $rec['returnedMs'] += $returned;
        $rec['balanceMs'] = 0;
        $rec['on'] = false;
        $rec['calls'] = [];
        $rec['done'] = [];
        $rec['since'] = $now;
        return $returned;
    }

    public static function lineMessage($channelId, $nonce)
    {
        return "ZEAM Pass line\nchannel: " . strtolower((string) $channelId) . "\nnonce: " . $nonce;
    }

    public static function normalize($rec)
    {
        $out = self::fresh(is_array($rec) && isset($rec['channelId']) ? $rec['channelId'] : '');
        if (!is_array($rec)) {
            return $out;
        }
        foreach (['balanceMs', 'spentMs', 'returnedMs'] as $k) {
            $out[$k] = isset($rec[$k]) ? (int) $rec[$k] : 0;
        }
        $out['on'] = !empty($rec['on']);
        foreach (['since', 'lastActive'] as $k) {
            $out[$k] = isset($rec[$k]) ? (int) $rec[$k] : null;
        }
        foreach (['calls', 'nonces'] as $k) {
            $out[$k] = isset($rec[$k]) && is_array($rec[$k]) ? $rec[$k] : [];
        }
        foreach (['credited', 'lines'] as $k) {
            $out[$k] = isset($rec[$k]) && is_array($rec[$k]) ? array_values($rec[$k]) : [];
        }
        foreach (isset($rec['done']) && is_array($rec['done']) ? $rec['done'] : [] as $d) {
            if (is_array($d) && count($d) === 2) {
                $out['done'][] = [(int) array_values($d)[0], (int) array_values($d)[1]];
            }
        }
        return $out;
    }

    public static function snapshot(array $rec)
    {
        return ['channelId' => $rec['channelId'], 'balanceMs' => $rec['balanceMs'], 'spentMs' => $rec['spentMs'], 'returnedMs' => $rec['returnedMs'], 'on' => $rec['on'], 'since' => $rec['since'], 'lastActive' => $rec['lastActive'], 'calls' => $rec['calls'] === [] ? new \stdClass() : $rec['calls'], 'done' => array_values(isset($rec['done']) ? $rec['done'] : []), 'credited' => $rec['credited'], 'nonces' => $rec['nonces'] === [] ? new \stdClass() : $rec['nonces'], 'lines' => $rec['lines']];
    }
}
