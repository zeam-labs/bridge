<?php

namespace ZeamPass;

final class Discovery
{
    const CACHE_CONTROL = 'max-age=300';
    const GUIDANCE = 'Call a tool: POST its path with the arguments as a JSON object. A tool that is not free answers 402 with what to send when it is called without it. A call that fails is not charged.';
    const ON_A_LINE = ' On a line a call uses the time it runs, whether or not it succeeds.';
    const MPP_402 = '; the 402 carries an MPP Payment challenge now, in WWW-Authenticate (method evm, intent charge); a refused MPP credential answers 402 with a fresh challenge and a problem';

    private static function text($v)
    {
        return is_string($v) && $v !== '';
    }

    private static function field($a, $k)
    {
        return is_array($a) && array_key_exists($k, $a) ? $a[$k] : null;
    }

    public static function price($tag)
    {
        if (!is_array($tag) || self::field($tag, 'free') === true) {
            return null;
        }
        if (self::field($tag, 'varies') === true) {
            return ['mode' => 'dynamic', 'currency' => 'USD'];
        }
        $per = self::field($tag, 'per');
        if ($per === 'unit') {
            return self::text(self::field($tag, 'upTo')) ? ['mode' => 'dynamic', 'currency' => 'USD', 'min' => '0', 'max' => $tag['upTo']] : null;
        }
        if ($per === 'ms') {
            return self::text(self::field($tag, 'usd')) ? ['mode' => 'dynamic', 'currency' => 'USD', 'min' => $tag['usd']] : null;
        }
        $amount = self::field($tag, $per === 'time' ? 'callUSD' : 'usd');
        return self::text($amount) ? ['mode' => 'fixed', 'currency' => 'USD', 'amount' => $amount] : null;
    }

    public static function paymentInfo($tag, $mpp = null)
    {
        $p = self::price($tag);
        if ($p === null) {
            return null;
        }
        $amount = self::field($mpp, 'amount');
        $charge = $p['mode'] === 'fixed' && is_string($amount) && preg_match('/^(0|[1-9][0-9]*)$/D', $amount) === 1
            && self::text(self::field($mpp, 'currency')) && self::text(self::field($mpp, 'method')) && self::text(self::field($mpp, 'intent'));
        if (!$charge) {
            return ['price' => $p, 'protocols' => [['x402' => new \stdClass()]]];
        }
        $offer = ['amount' => $amount, 'currency' => $mpp['currency']];
        if (self::text(self::field($mpp, 'description'))) {
            $offer['description'] = $mpp['description'];
        }
        $offer['intent'] = $mpp['intent'];
        $offer['method'] = $mpp['method'];
        return ['offers' => [$offer], 'price' => $p, 'protocols' => [['mpp' => ['method' => $mpp['method'], 'intent' => $mpp['intent'], 'currency' => $mpp['currency']]], ['x402' => new \stdClass()]]];
    }

    public static function document(array $doc, $offers = [], $homepage = null, $origin = null, $mount = '')
    {
        $paths = [];
        $timed = false;
        foreach (is_array(self::field($doc, 'paths')) ? $doc['paths'] : [] as $path => $item) {
            $out = [];
            foreach (is_array($item) ? $item : [] as $method => $op) {
                if (!is_array($op)) {
                    $out[$method] = $op;
                    continue;
                }
                $tag = self::field($op, 'x-price');
                if (in_array(self::field($tag, 'per'), ['time', 'ms'], true)) {
                    $timed = true;
                }
                $name = self::field($op, 'operationId');
                $info = self::paymentInfo($tag, is_array($offers) && is_string($name) && array_key_exists($name, $offers) ? $offers[$name] : null);
                $next = $op;
                if (is_array($tag)) {
                    $next['security'] = [];
                }
                if ($info !== null) {
                    $next['x-payment-info'] = $info;
                    $required = self::field(self::field($op, 'responses'), 402);
                    if (isset($info['offers']) && self::text(self::field($required, 'description'))) {
                        $next['responses'][402]['description'] = $required['description'] . self::MPP_402;
                    }
                }
                $out[$method] = $next;
            }
            $paths[$origin === null ? $path : $mount . $path] = $out;
        }
        $out = $doc;
        $out['info']['x-guidance'] = $doc['info']['description'] . '. ' . self::GUIDANCE . ($timed ? self::ON_A_LINE : '');
        if (self::text($homepage)) {
            $out['x-service-info'] = ['docs' => ['homepage' => $homepage]];
        }
        if ($origin !== null) {
            $out['servers'] = [['url' => $origin]];
        }
        $out['paths'] = $paths;
        return $out;
    }
}
