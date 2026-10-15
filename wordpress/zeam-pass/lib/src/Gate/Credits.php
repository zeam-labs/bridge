<?php

namespace ZeamPass\Gate;

use ZeamPass\Address;
use ZeamPass\Big;
use ZeamPass\Erc20;
use ZeamPass\Num;
use ZeamPass\Pass;
use ZeamPass\Rpc;
use ZeamPass\Secp256k1;

final class Credits
{
    const MICRO_PER_THOUSAND = 500000;

    private $meter;
    private $issuer;
    private $http;
    private $now;
    private $random;
    private $maxMicroPerThousand;

    public function __construct(Meter $meter, $issuer = null, array $options = [])
    {
        $this->meter = $meter;
        $this->issuer = $issuer;
        $this->http = isset($options['http']) && is_callable($options['http']) ? $options['http'] : new Http();
        $this->now = isset($options['now']) && is_callable($options['now']) ? $options['now'] : null;
        $this->random = isset($options['random']) && is_callable($options['random']) ? $options['random'] : 'random_bytes';
        $this->maxMicroPerThousand = isset($options['maxMicroPerThousand']) ? (int) $options['maxMicroPerThousand'] : self::MICRO_PER_THOUSAND;
    }

    private function nowMs()
    {
        return $this->now !== null ? (int) call_user_func($this->now) : (int) floor(microtime(true) * 1000);
    }

    public static function priceMicro($checks, $microPerThousand = self::MICRO_PER_THOUSAND)
    {
        return (int) ceil(((int) $checks / 1000) * $microPerThousand);
    }

    public function addNote($note, $issuer, $sellerPayout, $name)
    {
        if (!$issuer || !Address::isAddress($issuer)) {
            return ['ok' => false, 'why' => 'this Bridge has no credit issuer set'];
        }
        if (!is_array($note)) {
            return ['ok' => false, 'why' => 'not a credit note'];
        }
        foreach (['id', 'seller', 'name', 'checks', 'issued', 'signature'] as $field) {
            if (!array_key_exists($field, $note) || !is_scalar($note[$field])) {
                return ['ok' => false, 'why' => 'not a credit note'];
            }
        }
        if (!Address::equals((string) $note['seller'], (string) $sellerPayout) || $note['name'] !== $name) {
            return ['ok' => false, 'why' => 'the note is for another seller'];
        }
        if (!is_int($note['checks']) && !(is_string($note['checks']) && preg_match('/^[1-9][0-9]*$/D', $note['checks']))) {
            return ['ok' => false, 'why' => 'not a credit note'];
        }
        $v = Pass::verifyNote($note, $issuer);
        if (!$v['ok']) {
            return $v;
        }
        $added = $this->meter->addCredit($note['id'], $v['checks']);
        if (!$added['ok']) {
            return $added;
        }
        return ['ok' => true, 'checks' => $v['checks'], 'credit' => $added['credit']];
    }

    public static function creditRequestUrl($creditUrl, $checks, $sellerPayout, $name)
    {
        return rtrim((string) $creditUrl, '/') . '/credits?checks=' . rawurlencode((string) $checks)
            . '&seller=' . rawurlencode((string) $sellerPayout) . '&name=' . rawurlencode((string) $name);
    }

    public static function selectRequirement($paymentRequired)
    {
        if (!is_object($paymentRequired) || !isset($paymentRequired->accepts) || !is_array($paymentRequired->accepts)) {
            return null;
        }
        foreach ($paymentRequired->accepts as $req) {
            if (!is_object($req) || !isset($req->scheme, $req->network) || $req->scheme !== 'exact' || $req->network !== Exact::NETWORK) {
                continue;
            }
            $flow = isset($req->extra->paymentFlow) ? $req->extra->paymentFlow : null;
            if ($flow !== null && $flow !== 'authorization') {
                continue;
            }
            return $req;
        }
        return null;
    }

    private static function fail($code, $why, $status = null)
    {
        return ['ok' => false, 'code' => $code, 'why' => $why, 'status' => $status];
    }

    public function sign($paymentRequired, $creditKey, $checks)
    {
        $req = self::selectRequirement($paymentRequired);
        if ($req === null) {
            return self::fail('no_requirement', 'the credit service asked for nothing this client pays (exact on ' . Exact::NETWORK . ')');
        }
        if (isset($req->extra->assetTransferMethod) && $req->extra->assetTransferMethod !== 'eip3009') {
            return self::fail('no_requirement', 'the credit service asked for ' . $req->extra->assetTransferMethod . '; this client signs EIP-3009 only');
        }
        if (empty($req->extra->name) || empty($req->extra->version) || !isset($req->asset, $req->payTo, $req->amount, $req->maxTimeoutSeconds)) {
            return self::fail('bad_requirement', 'the requirement is missing its asset, payTo, amount, timeout or EIP-712 domain');
        }
        if (!is_string($req->asset) || !Address::equals($req->asset, Erc20::USDC_BASE) || !is_string($req->payTo) || !Address::isAddress($req->payTo) || !is_int($req->maxTimeoutSeconds) || $req->maxTimeoutSeconds < 1) {
            return self::fail('bad_requirement', 'the requirement is not USDC on Base to an address');
        }
        $amount = Exact::bigint($req->amount);
        $ceiling = self::priceMicro($checks, $this->maxMicroPerThousand);
        if ($amount === null || Big::sign($amount) < 0 || Big::cmp($amount, $ceiling) > 0) {
            return self::fail('overpriced', 'the credit service asked ' . (is_scalar($req->amount) ? $req->amount : '?') . " micro-USDC for $checks checks; the ceiling is $ceiling");
        }
        $nonce = '0x' . bin2hex(call_user_func($this->random, 32));
        $inner = Exact::authorize($creditKey, $req, intdiv($this->nowMs(), 1000), $nonce);
        $payload = Exact::paymentPayload($paymentRequired, $req, $inner);
        return ['ok' => true, 'payload' => $payload, 'header' => Exact::encodeHeader($payload), 'requirement' => $req];
    }

    public function buy($creditUrl, $checks, $creditKey, $sellerPayout, $name, $rpc = null)
    {
        $checks = (int) $checks;
        if ($checks < 1000 || $checks % 1000 !== 0) {
            return self::fail('bad_checks', 'checks is a multiple of 1,000');
        }
        if (!Address::isAddress($sellerPayout) || !preg_match('/^[a-z][a-z0-9-]{1,31}$/D', (string) $name)) {
            return self::fail('bad_seller', 'seller is the seller\'s payout address and name its Bridge name');
        }
        $url = self::creditRequestUrl($creditUrl, $checks, $sellerPayout, $name);
        try {
            $first = call_user_func($this->http, 'POST', $url, [], null);
        } catch (\Exception $e) {
            return self::fail('unreachable', \ZeamPass\message($e));
        }
        if ($first['status'] === 200) {
            return $this->finish($first, $sellerPayout, $name);
        }
        if ($first['status'] !== 402) {
            return self::fail('unexpected_status', 'the credit service answered HTTP ' . $first['status'], $first['status']);
        }
        $headers = array_change_key_case($first['headers'], CASE_LOWER);
        $paymentRequired = isset($headers['payment-required']) && $headers['payment-required'] !== '' ? Exact::decodeHeader($headers['payment-required']) : null;
        if ($paymentRequired === null || !isset($paymentRequired->x402Version) || $paymentRequired->x402Version !== 2) {
            return self::fail('no_requirement', 'the 402 carries no x402 v2 PAYMENT-REQUIRED header', 402);
        }
        $signed = $this->sign($paymentRequired, $creditKey, $checks);
        if (!$signed['ok']) {
            return $signed;
        }
        if ($rpc instanceof Rpc) {
            try {
                $from = Secp256k1::privateKeyToAddress($creditKey);
                $balance = Num::of(Erc20::decodeUint256($rpc->ethCall(Erc20::USDC_BASE, Erc20::encodeBalanceOf($from))));
            } catch (\Exception $e) {
                return self::fail('rpc', 'could not read the credit key\'s USDC balance: ' . \ZeamPass\message($e));
            }
            if (Big::cmp($balance, Exact::bigint($signed['requirement']->amount)) < 0) {
                return self::fail('insufficient_usdc', "$from holds " . Big::strval($balance) . ' micro-USDC; the credit costs ' . $signed['requirement']->amount);
            }
        }
        try {
            $second = call_user_func($this->http, 'POST', $url, [
                'PAYMENT-SIGNATURE' => $signed['header'],
                'Access-Control-Expose-Headers' => 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE',
            ], null);
        } catch (\Exception $e) {
            return self::fail('unreachable', \ZeamPass\message($e));
        }
        return $this->finish($second, $sellerPayout, $name);
    }

    private function finish(array $response, $sellerPayout, $name)
    {
        $note = json_decode((string) $response['body'], true);
        if ($response['status'] !== 200) {
            $error = is_array($note) && isset($note['error']) && is_scalar($note['error']) ? (string) $note['error'] : 'HTTP ' . $response['status'];
            $reason = is_array($note) && isset($note['reason']) && is_scalar($note['reason']) ? ': ' . $note['reason'] : '';
            return self::fail('not_bought', 'could not buy credit (' . $response['status'] . ' ' . $error . $reason . ')', $response['status']);
        }
        if (!is_array($note)) {
            return self::fail('not_bought', 'the credit service answered 200 without a note', 200);
        }
        $added = $this->issuer ? $this->addNote($note, $this->issuer, $sellerPayout, $name) : ['ok' => false, 'why' => 'this Bridge has no credit issuer set'];
        return ['ok' => $added['ok'], 'note' => $note, 'added' => $added];
    }
}
