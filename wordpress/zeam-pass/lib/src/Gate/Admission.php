<?php

namespace ZeamPass\Gate;

use ZeamPass\Address;
use ZeamPass\Big;
use ZeamPass\Pass;

final class Admission
{
    const NOTE = 'Sign this zero-value payment with your key. Nothing is paid. The key needs no funds and must be admitted here.';
    const SEEN_KEY = 'x402-seen';
    const MAX_SAFE_INTEGER = 9007199254740991;

    private $payTo;
    private $store;
    private $realm;
    private $options;

    public function __construct($payTo, Store $store, array $options = [])
    {
        $this->payTo = Address::checksum($payTo);
        $this->store = $store;
        $this->realm = isset($options['realm']) ? (string) $options['realm'] : Pass::REALM;
        $this->options = $options;
    }

    public function requirement($payTo = null)
    {
        return Exact::requirement('0', $payTo === null ? $this->payTo : Address::checksum($payTo), $this->options);
    }

    public function paymentRequired($resource, $payTo = null)
    {
        $body = new \stdClass();
        $body->x402Version = 2;
        $body->resource = Json::toObject($resource);
        $body->accepts = [$this->requirement($payTo)];
        $body->realm = $this->realm;
        $body->note = self::NOTE;
        return [
            'status' => 402,
            'headers' => ['PAYMENT-REQUIRED' => Exact::encodeHeader($body), 'Cache-Control' => 'no-store'],
            'body' => $body,
        ];
    }

    private static function nowMs($now)
    {
        return $now === null ? (int) floor(microtime(true) * 1000) : (int) $now;
    }

    private static function refuse($code, $why)
    {
        return ['ok' => false, 'status' => $code === 'refused' ? 403 : 402, 'code' => $code, 'why' => $why];
    }

    public static function scopeAllows($scope, $toolName)
    {
        if ($scope === null || $scope === '' || $scope === 'self' || $scope === '*') {
            return true;
        }
        return strtolower((string) $scope) === strtolower((string) $toolName);
    }

    public function seen($from, $nonce, $nowMs)
    {
        $state = $this->store->get(self::SEEN_KEY);
        $key = strtolower($from) . ':' . strtolower($nonce);
        return is_array($state) && isset($state[$key]) && $state[$key] >= $nowMs;
    }

    private function claim($from, $nonce, $until, $nowMs)
    {
        $key = strtolower($from) . ':' . strtolower($nonce);
        return $this->store->update(self::SEEN_KEY, function ($state) use ($key, $until, $nowMs) {
            $state = is_array($state) ? $state : [];
            foreach ($state as $k => $expires) {
                if ($expires < $nowMs) {
                    unset($state[$k]);
                }
            }
            if (isset($state[$key])) {
                return [$state, false];
            }
            $state[$key] = $until;
            return [$state, true];
        });
    }

    public function admit($paymentHeaderValue, $grantHeaderValue, $toolName, array $admitList, $now = null)
    {
        $t = self::nowMs($now);
        if (!is_string($paymentHeaderValue) || $paymentHeaderValue === '') {
            return self::refuse('no_payment', 'no PAYMENT-SIGNATURE header');
        }
        $payload = Exact::decodeHeader($paymentHeaderValue);
        if ($payload === null) {
            return self::refuse('no_payment', 'PAYMENT-SIGNATURE is not base64 JSON of an x402 payment');
        }
        $requirement = $this->requirement();
        if (!Exact::matches($requirement, $payload)) {
            return self::refuse('no_matching_requirement', 'the payment matches no accepted requirement');
        }
        $auth = isset($payload->payload->authorization) && is_object($payload->payload->authorization) ? $payload->payload->authorization : null;
        $from = $auth !== null && isset($auth->from) && is_scalar($auth->from) ? strtolower((string) $auth->from) : '';
        $nonce = $auth !== null && isset($auth->nonce) && is_scalar($auth->nonce) ? (string) $auth->nonce : '';
        if ($from === '' || $nonce === '') {
            return self::refuse('bad_payment', 'no authorization in the payment');
        }
        if ($this->seen($from, $nonce, $t)) {
            return self::refuse('replayed', 'this authorization was already used');
        }
        try {
            $invalid = Exact::verify($payload, $requirement, intdiv($t, 1000));
        } catch (\Exception $e) {
            $invalid = \ZeamPass\message($e);
        }
        if ($invalid !== null) {
            return self::refuse('invalid_payment', $invalid);
        }
        $admitted = $this->grant($from, $grantHeaderValue, $toolName, $admitList, $t);
        if (!$admitted['ok']) {
            return $admitted;
        }
        $validBeforeMs = Big::mul(Exact::bigint($auth->validBefore), 1000);
        $until = Big::cmp($validBeforeMs, self::MAX_SAFE_INTEGER) < 0 ? (int) Big::strval($validBeforeMs) : self::MAX_SAFE_INTEGER;
        if (!$this->claim($from, $nonce, $until, $t)) {
            return self::refuse('replayed', 'this authorization was already used');
        }
        return $admitted;
    }

    public function grant($from, $grantHeaderValue, $toolName, array $admitList, $t)
    {
        $grant = null;
        if (is_string($grantHeaderValue) && $grantHeaderValue !== '') {
            $text = Json::base64UrlDecode($grantHeaderValue);
            $grant = json_decode($text, true, 32);
            if (json_last_error() !== JSON_ERROR_NONE) {
                return self::refuse('bad_grant', 'x-grant is not base64url JSON');
            }
        }
        if ($grant === null || $grant === false || $grant === 0 || $grant === 0.0 || $grant === '') {
            return $this->direct($from, $admitList);
        }
        return $this->delegated($from, $grant, $toolName, $admitList, $t);
    }

    public static function notAdmittedSigner($root)
    {
        return "the grant's signer $root is not admitted";
    }

    public static function otherDelegate($delegate, $from)
    {
        return "the grant's delegate is $delegate; this call is signed by $from";
    }

    private static function admits(array $admitList, $address)
    {
        foreach ($admitList as $a) {
            if (is_scalar($a) && strtolower((string) $a) === strtolower($address)) {
                return true;
            }
        }
        return false;
    }

    private function direct($from, array $admitList)
    {
        if (!self::admits($admitList, $from)) {
            return self::refuse('refused', "$from is not admitted");
        }
        return ['ok' => true, 'signer' => $from, 'root' => $from, 'scope' => 'self', 'until' => null, 'grant' => null];
    }

    private function delegated($from, $grant, $toolName, array $admitList, $t)
    {
        if (is_array($grant)) {
            foreach (['delegate', 'until', 'signature', 'scope', 'budget'] as $field) {
                if (isset($grant[$field]) && !is_scalar($grant[$field])) {
                    return self::refuse('bad_grant', 'a grant needs delegate, until and signature');
                }
            }
        }
        try {
            $g = Pass::verifyGrant($this->realm, $grant, $t);
        } catch (\Exception $e) {
            $g = ['ok' => false, 'why' => 'bad signature: ' . substr(\ZeamPass\message($e), 0, 80)];
        }
        if (!$g['ok']) {
            return self::refuse('bad_grant', $g['why']);
        }
        if (!self::admits($admitList, $g['root'])) {
            return self::refuse('bad_grant', self::notAdmittedSigner($g['root']));
        }
        if ($from !== $g['delegate']) {
            return self::refuse('bad_grant', self::otherDelegate($g['delegate'], $from));
        }
        if (!self::scopeAllows($g['scope'], $toolName)) {
            return self::refuse('refused', 'the grant\'s scope is ' . $g['scope'] . ', not this tool');
        }
        return ['ok' => true, 'signer' => $from, 'root' => $g['root'], 'scope' => $g['scope'], 'until' => $g['until'], 'grant' => $g['id']];
    }
}
