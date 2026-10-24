<?php

namespace ZeamPass;

final class Discovery
{
    const CACHE_CONTROL = 'max-age=300';
    const GUIDANCE = 'Call a tool: POST its path with the arguments as a JSON object. A tool that is not free answers 402 with what to send when it is called without it. A call that fails is not charged.';
    const ON_A_LINE = ' On a line a call uses the time it runs, whether or not it succeeds.';
    const FAILED_CALL = 'A failed call is not charged.' . self::ON_A_LINE;

    public static function percent($share)
    {
        return rtrim(rtrim(sprintf('%.2f', (float) $share * 100), '0'), '.');
    }

    public static function refundRule($cover, $pay = null)
    {
        return 'Our relay pays the gas of a refund when our fee on what the buyer spent covers the gas of the deposit, of the refund and of settling any calls not yet settled, and of every further deposit and every earlier refund it paid for on that channel, with a ' . $cover
            . "% margin; otherwise the buyer pays the refund's gas, with a " . ($pay === null ? $cover : $pay) . '% margin, in USDC, quoted before the buyer signs that payment.';
    }

    private static function text($v)
    {
        return is_string($v) && $v !== '';
    }

    private static function field($a, $k)
    {
        return is_array($a) && array_key_exists($k, $a) ? $a[$k] : null;
    }

    private static function mpp402(array $offers)
    {
        $pairs = [];
        $charge = true;
        foreach ($offers as $o) {
            $pairs[] = 'method ' . $o['method'] . ', intent ' . $o['intent'];
            $charge = $charge && $o['intent'] === 'charge';
        }
        return '; the 402 carries ' . (count($offers) === 1 ? 'an MPP Payment challenge' : 'MPP Payment challenges') . ' now, in WWW-Authenticate (' . implode('; ', $pairs) . '); a refused MPP credential answers ' . ($charge ? '402 ' : '') . 'with a fresh challenge and a problem';
    }

    private static function offered($mpp)
    {
        $amount = self::field($mpp, 'amount');
        return is_string($amount) && preg_match('/^(0|[1-9][0-9]*)$/D', $amount) === 1
            && self::text(self::field($mpp, 'currency')) && self::text(self::field($mpp, 'method')) && self::text(self::field($mpp, 'intent'));
    }

    private static function isList($v)
    {
        return is_array($v) && ($v === [] || array_keys($v) === range(0, count($v) - 1));
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
        $given = $p['mode'] === 'fixed' ? array_values(array_filter(self::isList($mpp) ? $mpp : [$mpp], static function ($m) {
            return self::offered($m);
        })) : [];
        if (!$given) {
            return ['price' => $p, 'protocols' => [['x402' => new \stdClass()]]];
        }
        $offers = [];
        $protocols = [];
        foreach ($given as $m) {
            $offer = ['amount' => $m['amount'], 'currency' => $m['currency']];
            if (self::text(self::field($m, 'description'))) {
                $offer['description'] = $m['description'];
            }
            $offer['intent'] = $m['intent'];
            $offer['method'] = $m['method'];
            $offers[] = $offer;
            $protocols[] = ['mpp' => ['method' => $m['method'], 'intent' => $m['intent'], 'currency' => $m['currency']]];
        }
        $protocols[] = ['x402' => new \stdClass()];
        return ['offers' => $offers, 'price' => $p, 'protocols' => $protocols];
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
                        $next['responses'][402]['description'] = $required['description'] . self::mpp402($info['offers']);
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
