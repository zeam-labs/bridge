<?php

namespace ZeamPass\Settlement;

use ZeamPass\Address;
use ZeamPass\Hex;

final class Relay
{
    private $url;
    private $transport;
    private $timeout;

    public function __construct($url, ?callable $transport = null, $timeout = 300)
    {
        if (!preg_match('#^https?://#i', (string) $url)) {
            throw new \InvalidArgumentException('a relay URL starts with http:// or https://');
        }
        $this->url = rtrim((string) $url, '/');
        $this->transport = $transport ?: [self::class, 'http'];
        $this->timeout = (float) $timeout;
    }

    public function send(array $calls, array $split)
    {
        $body = [
            'calls' => array_map(function ($c) {
                return ['to' => Address::checksum($c['to']), 'data' => Hex::lower($c['data'])];
            }, array_values($calls)),
            'split' => $split,
        ];
        try {
            $r = call_user_func($this->transport, 'POST', $this->url . '/relay', Json::encode($body), $this->timeout);
        } catch (\Throwable $e) {
            $r = ['status' => 0, 'body' => '', 'error' => \ZeamPass\message($e)];
        }
        $decoded = isset($r['body']) && is_string($r['body']) ? json_decode($r['body'], true) : null;
        $status = isset($r['status']) ? (int) $r['status'] : 0;
        $fallback = is_array($decoded) && isset($decoded['error']) && is_string($decoded['error'])
            ? $decoded['error']
            : (isset($r['error']) ? 'the relay did not answer: ' . $r['error'] : "the relay answered $status");
        $results = is_array($decoded) && isset($decoded['results']) && is_array($decoded['results']) ? array_values($decoded['results']) : [];
        $out = [];
        foreach (array_values($calls) as $i => $_) {
            $one = isset($results[$i]) && is_array($results[$i]) ? $results[$i] : null;
            if ($one !== null && isset($one['hash']) && Hex::isHex($one['hash'], 32)) {
                $out[] = ['hash' => strtolower($one['hash'])];
            } else {
                $failed = ['error' => $one !== null && isset($one['error']) ? (string) $one['error'] : $fallback];
                if ($one !== null && isset($one['code']) && is_string($one['code'])) {
                    $failed['code'] = $one['code'];
                }
                if ($one !== null && isset($one['gasMicroUSD']) && is_numeric($one['gasMicroUSD']) && (float) $one['gasMicroUSD'] > 0) {
                    $failed['gasMicroUSD'] = (int) ceil((float) $one['gasMicroUSD']);
                }
                $out[] = $failed;
            }
        }
        return $out;
    }

    public function sendQuote(array $calls, array $split)
    {
        $body = ['calls' => array_map(function ($c) {
            return ['to' => Address::checksum($c['to']), 'data' => Hex::lower($c['data'])];
        }, $calls), 'split' => $split];
        try {
            $r = call_user_func($this->transport, 'POST', $this->url . '/quote', Json::encode($body), 10);
        } catch (\Throwable $e) {
            return null;
        }
        if (!is_array($r) || (int) (isset($r['status']) ? $r['status'] : 0) !== 200 || !isset($r['body']) || !is_string($r['body'])) {
            return null;
        }
        $d = json_decode($r['body'], true);
        if (is_array($d) && isset($d['op'], $d['covered']) && $d['op'] === 'send_quote' && is_bool($d['covered'])) {
            return $d;
        }
        return null;
    }

    public function quote(array $call, $payment = true)
    {
        try {
            $r = call_user_func($this->transport, 'POST', $this->url . '/quote', Json::encode(['call' => ['to' => Address::checksum($call['to']), 'data' => Hex::lower($call['data'])], 'payment' => (bool) $payment]), 10);
        } catch (\Throwable $e) {
            return null;
        }
        return self::quoted($r);
    }

    public function shapeQuote($claim, $payment = true)
    {
        try {
            $r = call_user_func($this->transport, 'GET', $this->url . '/quote?claim=' . ($claim ? '1' : '0') . '&payment=' . ($payment ? '1' : '0'), null, 5);
        } catch (\Throwable $e) {
            return null;
        }
        return self::quoted($r);
    }

    public function paid($channelId)
    {
        try {
            $r = call_user_func($this->transport, 'GET', $this->url . '/paid?channel=' . strtolower((string) $channelId), null, 5);
        } catch (\Throwable $e) {
            return null;
        }
        return self::paidOf($r, $channelId);
    }

    public static function paidOf($r, $channelId)
    {
        if (!is_array($r) || !isset($r['status']) || (int) $r['status'] !== 200) {
            return null;
        }
        $d = json_decode((string) (isset($r['body']) ? $r['body'] : ''), true);
        if (!is_array($d) || !isset($d['op']) || $d['op'] !== 'gas_paid') {
            return null;
        }
        if (!isset($d['channelId']) || !is_string($d['channelId']) || strtolower($d['channelId']) !== strtolower((string) $channelId)) {
            return null;
        }
        $units = isset($d['gasUnits']) ? $d['gasUnits'] : null;
        if (!(is_int($units) || (is_float($units) && is_finite($units) && floor($units) === $units))) {
            return null;
        }
        return $units >= 0 && $units <= 9007199254740991 ? (int) $units : null;
    }

    private static function quoted($r)
    {
        if (!is_array($r) || !isset($r['status']) || (int) $r['status'] !== 200) {
            return null;
        }
        $d = json_decode((string) (isset($r['body']) ? $r['body'] : ''), true);
        if (!is_array($d)) {
            return null;
        }
        $pos = function ($k) use ($d) {
            return isset($d[$k]) && self::numeric($d[$k]) && (float) $d[$k] > 0;
        };
        $digits = function ($k) use ($d) {
            return isset($d[$k]) && (is_string($d[$k]) || is_int($d[$k])) && preg_match('/^\d+$/', (string) $d[$k]);
        };
        if (!$pos('quoteMicroUSD') || !$pos('costMicroUSD') || !$pos('gasUnits') || !$pos('ethUSD') || !isset($d['marginPercent']) || !self::numeric($d['marginPercent']) || !$digits('gasPriceWei') || !$digits('l1FeeWei')) {
            return null;
        }
        if ((float) $d['quoteMicroUSD'] < (float) $d['costMicroUSD']) {
            return null;
        }
        $units = (int) (float) $d['gasUnits'];
        $margin = GasQuote::number((float) $d['marginPercent']);
        return [
            'microUSD' => (int) ceil((float) $d['quoteMicroUSD']),
            'costMicroUSD' => (int) ceil((float) $d['costMicroUSD']),
            'gasUnits' => $units,
            'gasUnitsWithMargin' => (int) ceil($units * (1 + $margin / 100)),
            'gasPriceWei' => (string) $d['gasPriceWei'],
            'ethUSD' => GasQuote::number((float) $d['ethUSD']),
            'marginPercent' => $margin,
            'l1FeeWei' => (string) $d['l1FeeWei'],
            'quotedBy' => 'relay',
        ];
    }

    private static function numeric($v)
    {
        return (is_int($v) || is_float($v) || is_string($v)) && is_numeric($v) && is_finite((float) $v);
    }

    public function health()
    {
        try {
            $r = call_user_func($this->transport, 'GET', $this->url . '/health', null, 10);
        } catch (\Throwable $e) {
            return null;
        }
        if (!isset($r['status']) || (int) $r['status'] !== 200) {
            return null;
        }
        $decoded = json_decode((string) $r['body'], true);
        return is_array($decoded) ? $decoded : null;
    }

    public static function http($method, $url, $body, $timeout)
    {
        $headers = ['accept' => 'application/json'];
        if ($body !== null) {
            $headers['content-type'] = 'application/json';
        }
        $r = \ZeamPass\Transport::request($method, $url, $headers, $body, $timeout);
        return ['status' => $r['status'], 'body' => $r['body']];
    }
}
