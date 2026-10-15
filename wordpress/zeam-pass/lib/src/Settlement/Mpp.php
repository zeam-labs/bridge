<?php

namespace ZeamPass\Settlement;

use ZeamPass\Address;
use ZeamPass\BatchSettlement;
use ZeamPass\Big;
use ZeamPass\Hex;
use ZeamPass\Keccak;
use ZeamPass\Secp256k1;

final class Mpp
{
    const METHOD = 'evm';
    const INTENT = 'charge';
    const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
    const CREDENTIAL = 'org.paymentauth/credential';
    const REQUIRED = 'org.paymentauth/payment-required';
    const RECEIPT = 'org.paymentauth/receipt';
    const PROBLEM = 'https://paymentauth.org/problems/';
    const FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS;
    const TOKEN = "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const PARAM_ORDER = ['id', 'realm', 'method', 'intent', 'expires', 'digest', 'header', 'opaque', 'description', 'request'];
    const BOUND = ['id', 'realm', 'method', 'intent', 'request', 'expires', 'digest', 'header', 'opaque'];
    const TITLES = ['malformed-credential' => 'Malformed Credential', 'invalid-challenge' => 'Invalid Challenge', 'verification-failed' => 'Verification Failed', 'payment-required' => 'Payment Required'];

    private static function malformed($detail)
    {
        return new MppException('malformed-credential', $detail);
    }

    private static function invalid($detail)
    {
        return new MppException('invalid-challenge', $detail);
    }

    private static function failed($detail)
    {
        return new MppException('verification-failed', $detail);
    }

    public static function isObject($value)
    {
        return is_array($value) && ($value === [] || array_keys($value) !== range(0, count($value) - 1));
    }

    private static function has(array $a, $key)
    {
        return array_key_exists($key, $a) && $a[$key] !== null;
    }

    private static function trunc($value)
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_bool($value)) {
            return $value ? 1 : 0;
        }
        if (is_float($value)) {
            return is_finite($value) ? (int) $value : null;
        }
        if (is_string($value) && is_numeric(trim($value))) {
            return (int) (float) trim($value);
        }
        return null;
    }

    private static function millis($text)
    {
        if (!is_string($text) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/D', $text, $m)) {
            return null;
        }
        if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1]) || (int) $m[4] > 23 || (int) $m[5] > 59 || (int) $m[6] > 59) {
            return null;
        }
        $ms = gmmktime((int) $m[4], (int) $m[5], (int) $m[6], (int) $m[2], (int) $m[3], (int) $m[1]) * 1000;
        if ($m[7] !== '') {
            $ms += (int) substr(substr($m[7], 1) . '000', 0, 3);
        }
        if ($m[8] !== 'Z' && $m[8] !== 'z') {
            $sign = $m[8][0] === '+' ? 1 : -1;
            $ms -= $sign * ((int) substr($m[8], 1, 2) * 60 + (int) substr($m[8], 4, 2)) * 60000;
        }
        return $ms;
    }

    private static function utf16($key)
    {
        return function_exists('mb_convert_encoding') ? mb_convert_encoding((string) $key, 'UTF-16BE', 'UTF-8') : (string) $key;
    }

    public static function jcs($value)
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_string($value)) {
            $out = json_encode($value, self::FLAGS | JSON_INVALID_UTF8_SUBSTITUTE);
            if ($out === false) {
                throw new \InvalidArgumentException('not encodable as JSON');
            }
            return $out;
        }
        if (is_int($value)) {
            return (string) $value;
        }
        if (is_float($value)) {
            if (!is_finite($value)) {
                throw new \InvalidArgumentException('a JSON number is finite');
            }
            return $value == floor($value) && abs($value) < 9007199254740992 ? sprintf('%d', $value) : json_encode($value);
        }
        if (is_array($value)) {
            if (!self::isObject($value)) {
                return '[' . implode(',', array_map([self::class, 'jcs'], $value)) . ']';
            }
            $keys = array_map('strval', array_keys($value));
            usort($keys, function ($a, $b) {
                return strcmp(self::utf16($a), self::utf16($b));
            });
            $parts = [];
            foreach ($keys as $k) {
                $parts[] = self::jcs($k) . ':' . self::jcs($value[$k]);
            }
            return '{' . implode(',', $parts) . '}';
        }
        throw new \InvalidArgumentException('not encodable as JSON');
    }

    public static function b64Encode($bytes)
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    public static function b64Decode($text)
    {
        if (!is_string($text) || !preg_match('/^[A-Za-z0-9_-]+$/D', $text)) {
            throw self::malformed('not base64url');
        }
        $body = strlen($text) % 4 === 1 ? substr($text, 0, -1) : $text;
        return (string) base64_decode(strtr($body, '-_', '+/'));
    }

    public static function b64Json($value)
    {
        return self::b64Encode(self::jcs($value));
    }

    public static function b64Parse($text)
    {
        $raw = self::b64Decode($text);
        $shape = json_decode($raw, false, 512, JSON_INVALID_UTF8_SUBSTITUTE);
        if ($shape === null && json_last_error() !== JSON_ERROR_NONE) {
            throw self::malformed('not JSON');
        }
        if (!($shape instanceof \stdClass)) {
            throw self::malformed('not a JSON object');
        }
        return json_decode($raw, true, 512, JSON_INVALID_UTF8_SUBSTITUTE);
    }

    public static function challengeId($secret, array $c)
    {
        $slots = [$c['realm'], $c['method'], $c['intent'], $c['request'], self::has($c, 'expires') ? $c['expires'] : '', self::has($c, 'digest') ? $c['digest'] : ''];
        if (self::has($c, 'header')) {
            $slots[] = $c['header'];
        }
        $slots[] = self::has($c, 'opaque') ? $c['opaque'] : '';
        return self::b64Encode(hash_hmac('sha256', implode('|', array_map('strval', $slots)), (string) $secret, true));
    }

    public static function once()
    {
        return ['n' => self::b64Encode(random_bytes(12))];
    }

    public static function issue($secret, $realm, $method, $intent, array $request, $expires = null, $description = null, $opaque = null)
    {
        $c = ['realm' => (string) $realm, 'method' => (string) $method, 'intent' => (string) $intent, 'request' => self::b64Json($request)];
        if ($expires !== null) {
            $c['expires'] = (string) $expires;
        }
        if ($opaque !== null) {
            $c['opaque'] = self::b64Json($opaque);
        }
        $c['id'] = self::challengeId($secret, $c);
        if ($description !== null && $description !== '') {
            $c['description'] = (string) $description;
        }
        return $c;
    }

    public static function bound($secret, $c)
    {
        if (!self::isObject($c)) {
            return false;
        }
        foreach (['id', 'realm', 'method', 'intent', 'request'] as $k) {
            if (!isset($c[$k]) || !is_string($c[$k]) || $c[$k] === '') {
                return false;
            }
        }
        foreach (['expires', 'digest', 'header', 'opaque'] as $k) {
            if (self::has($c, $k) && !is_string($c[$k])) {
                return false;
            }
        }
        return hash_equals(self::challengeId($secret, $c), $c['id']);
    }

    public static function header(array $c)
    {
        $parts = [];
        foreach (self::PARAM_ORDER as $k) {
            if (!self::has($c, $k)) {
                continue;
            }
            $v = preg_replace('/[^\x20-\x7e]/', '', (string) $c[$k]);
            $parts[] = $k . '="' . addcslashes($v, '\\"') . '"';
        }
        return 'Payment ' . implode(', ', $parts);
    }

    public static function parse($value)
    {
        $out = [];
        $s = $value === null ? '' : (string) $value;
        $n = strlen($s);
        $i = 0;
        $current = -1;
        $token = function () use (&$i, $s, $n) {
            $from = $i;
            while ($i < $n && strpos(self::TOKEN, $s[$i]) !== false) {
                $i++;
            }
            return substr($s, $from, $i - $from);
        };
        $ws = function () use (&$i, $s, $n) {
            while ($i < $n && ($s[$i] === ' ' || $s[$i] === "\t")) {
                $i++;
            }
        };
        while ($i < $n) {
            $ws();
            if ($i < $n && $s[$i] === ',') {
                $i++;
                continue;
            }
            $word = $token();
            if ($word === '') {
                break;
            }
            $ws();
            if ($i >= $n || $s[$i] !== '=') {
                if (strtolower($word) === 'payment') {
                    $out[] = [];
                    $current = count($out) - 1;
                } else {
                    $current = -1;
                }
                continue;
            }
            $i++;
            $ws();
            $v = '';
            if ($i < $n && $s[$i] === '"') {
                $i++;
                while ($i < $n && $s[$i] !== '"') {
                    if ($s[$i] === '\\' && $i + 1 < $n) {
                        $i++;
                    }
                    $v .= $s[$i];
                    $i++;
                }
                $i++;
            } else {
                $v = $token();
            }
            if ($current >= 0 && !array_key_exists($word, $out[$current])) {
                $out[$current][$word] = $v;
            }
        }
        $kept = [];
        foreach ($out as $c) {
            if (isset($c['id'], $c['method'], $c['intent'], $c['request']) && $c['id'] !== '') {
                $kept[] = $c;
            }
        }
        return $kept;
    }

    public static function echoed(array $c)
    {
        $out = [];
        foreach (self::BOUND as $k) {
            if (self::has($c, $k)) {
                $out[$k] = $c[$k];
            }
        }
        return $out;
    }

    public static function forMeta(array $c)
    {
        $out = $c;
        $out['request'] = self::b64Parse($c['request']);
        return $out;
    }

    public static function fromMeta($c)
    {
        if (!self::isObject($c)) {
            return null;
        }
        $out = $c;
        if (isset($c['request']) && self::isObject($c['request'])) {
            $out['request'] = self::b64Json($c['request']);
        }
        if (isset($c['opaque']) && self::isObject($c['opaque'])) {
            $out['opaque'] = self::b64Json($c['opaque']);
        }
        return $out;
    }

    public static function credentialIs($headerValue)
    {
        return is_string($headerValue) && preg_match('/^payment\s+(\S+)\s*$/iD', $headerValue) === 1;
    }

    public static function credentialParse($headerValue)
    {
        if (!preg_match('/^payment\s+(\S+)\s*$/iD', $headerValue === null ? '' : (string) $headerValue, $m)) {
            throw self::malformed('the credential is `Payment <base64url>`');
        }
        $c = self::b64Parse($m[1]);
        if (!array_key_exists('challenge', $c) || !self::isObject($c['challenge'])) {
            throw self::malformed('the credential carries no challenge');
        }
        if (!array_key_exists('payload', $c) || !self::isObject($c['payload'])) {
            throw self::malformed('the credential carries no payload');
        }
        if (array_key_exists('source', $c) && !is_string($c['source'])) {
            throw self::malformed('source is a string');
        }
        return $c;
    }

    public static function credentialSerialize(array $challenge, $payload, $source = null)
    {
        $c = ['challenge' => self::echoed($challenge), 'payload' => $payload];
        if ($source !== null) {
            $c['source'] = $source;
        }
        return 'Payment ' . self::b64Json($c);
    }

    public static function receiptHeader(array $receipt)
    {
        return self::b64Json($receipt);
    }

    public static function receiptParse($value)
    {
        return self::b64Parse(trim($value === null ? '' : (string) $value));
    }

    public static function problem($type, $detail, $title = null)
    {
        $titles = self::TITLES;
        return ['type' => self::PROBLEM . $type, 'title' => $title !== null ? $title : (isset($titles[$type]) ? $titles[$type] : 'Payment Problem'), 'status' => 402, 'detail' => (string) $detail];
    }

    public static function problemOf(\Throwable $e)
    {
        return $e instanceof MppException ? self::problem($e->type, $e->detail) : self::problem('verification-failed', \ZeamPass\message($e));
    }

    public static function evmRequest($amount, $currency, $recipient, $chainId, $decimals = null, $description = null, $externalId = null)
    {
        $a = (string) $amount;
        if (!preg_match('/^(0|[1-9]\d*)$/D', $a) || $a === '0') {
            throw new \InvalidArgumentException('a charge is a positive amount in base units');
        }
        $r = ['amount' => $a, 'currency' => Address::checksum($currency), 'recipient' => Address::checksum($recipient), 'methodDetails' => ['chainId' => (int) $chainId, 'credentialTypes' => ['authorization'], 'permit2Address' => self::PERMIT2]];
        if ($decimals !== null) {
            $r['methodDetails']['decimals'] = (int) $decimals;
        }
        if ($description !== null && $description !== '') {
            $r['description'] = (string) $description;
        }
        if ($externalId !== null && $externalId !== '') {
            $r['externalId'] = (string) $externalId;
        }
        return $r;
    }

    public static function challengeHashes(array $challenge)
    {
        return [
            Keccak::utf8(json_encode([(string) $challenge['id'], (string) $challenge['realm']], self::FLAGS)),
            Keccak::utf8((string) $challenge['id'] . (string) $challenge['realm']),
        ];
    }

    public static function source($chainId, $address)
    {
        return 'did:pkh:eip155:' . (int) $chainId . ':' . Address::checksum($address);
    }

    public static function payload($key, array $challenge, array $tokenDomain, $nowSecs)
    {
        $request = self::b64Parse($challenge['request']);
        $from = Secp256k1::privateKeyToAddress($key);
        $at = !empty($challenge['expires']) ? self::millis($challenge['expires']) : null;
        $expires = $at !== null ? intdiv($at, 1000) : (int) $nowSecs + 300;
        $hashes = self::challengeHashes($challenge);
        $authorization = ['from' => $from, 'to' => Address::checksum($request['recipient']), 'value' => (string) $request['amount'], 'validAfter' => '0', 'validBefore' => (string) $expires, 'nonce' => $hashes[0]];
        $signature = BatchSettlement::signTransferAuthorization($key, $tokenDomain, $authorization);
        return ['type' => 'authorization'] + $authorization + ['signature' => $signature];
    }

    public static function verify($secret, array $credential, array $expect, $nowSecs)
    {
        $c = $credential['challenge'];
        if (!self::bound($secret, $c)) {
            throw self::invalid('this challenge was not issued here, or was altered');
        }
        if ($c['method'] !== self::METHOD || $c['intent'] !== self::INTENT) {
            throw self::invalid('not an evm charge challenge');
        }
        if ($c['realm'] !== $expect['realm']) {
            throw self::invalid('the challenge is for another realm');
        }
        $expiresAt = null;
        if (self::has($c, 'expires')) {
            $expiresAt = self::millis($c['expires']);
            if ($expiresAt === null || $expiresAt / 1000 <= $nowSecs) {
                throw self::invalid('the challenge has expired');
            }
        }
        $request = self::b64Parse($c['request']);
        $details = isset($request['methodDetails']) && self::isObject($request['methodDetails']) ? $request['methodDetails'] : [];
        $chain = self::trunc(isset($details['chainId']) ? $details['chainId'] : null);
        if ($chain === null || $chain !== self::trunc($expect['chainId'])) {
            throw self::invalid('the challenge is for another chain');
        }
        if (!Address::equals(isset($request['currency']) ? $request['currency'] : null, $expect['currency'])) {
            throw self::invalid('the challenge is for another currency');
        }
        if (!Address::equals(isset($request['recipient']) ? $request['recipient'] : null, $expect['recipient'])) {
            throw self::invalid('the challenge pays another recipient');
        }
        if (isset($details['splits']) && is_array($details['splits']) && count($details['splits'])) {
            throw self::failed('an authorization credential cannot carry splits');
        }
        $p = $credential['payload'];
        if (!isset($p['type']) || $p['type'] !== 'authorization') {
            throw self::malformed('this challenge takes payload type "authorization"');
        }
        foreach (['from', 'to'] as $k) {
            if (!Address::isAddress(isset($p[$k]) ? $p[$k] : null)) {
                throw self::malformed("$k is an address");
            }
        }
        foreach (['value', 'validAfter', 'validBefore'] as $k) {
            if (!isset($p[$k]) || !is_string($p[$k]) || !preg_match('/^(0|[1-9]\d*)$/D', $p[$k])) {
                throw self::malformed("$k is a base-10 integer string");
            }
        }
        if (!Hex::isHex(isset($p['nonce']) ? $p['nonce'] : null, 32)) {
            throw self::malformed('nonce is 32 bytes of hex');
        }
        if (!isset($p['signature']) || !is_string($p['signature']) || !Hex::isHex($p['signature']) || strlen($p['signature']) < 130) {
            throw self::malformed('signature is hex');
        }
        if (!Address::equals($p['to'], $request['recipient'])) {
            throw self::failed('the authorization pays another recipient');
        }
        $amount = isset($request['amount']) ? $request['amount'] : null;
        if ($p['value'] !== (is_string($amount) || is_int($amount) ? (string) $amount : '')) {
            throw self::failed('the authorization is for another amount');
        }
        if (!in_array(Hex::lower($p['nonce']), self::challengeHashes($c), true)) {
            throw self::failed('the authorization nonce is not bound to this challenge');
        }
        $now = Big::init((string) (int) $nowSecs);
        if (Big::cmp(Big::init($p['validAfter']), $now) > 0) {
            throw self::failed('the authorization is not valid yet');
        }
        if (Big::cmp(Big::init($p['validBefore']), $now) <= 0) {
            throw self::failed('the authorization has expired');
        }
        if ($expiresAt !== null && Big::cmp(Big::init($p['validBefore']), Big::init((string) intdiv($expiresAt, 1000))) > 0) {
            throw self::failed('the authorization outlives its challenge');
        }
        $authorization = ['from' => Address::checksum($p['from']), 'to' => Address::checksum($p['to']), 'value' => $p['value'], 'validAfter' => $p['validAfter'], 'validBefore' => $p['validBefore'], 'nonce' => Hex::lower($p['nonce'])];
        $signer = null;
        $length = strlen(Hex::toBin($p['signature']));
        if ($length === 65 || $length === 64) {
            if (!Secp256k1::isCanonical($p['signature'])) {
                throw self::failed('the authorization signature is not in the form the token accepts: 65 bytes, v 27 or 28, low s');
            }
            try {
                $signer = Secp256k1::recoverHash(BatchSettlement::transferAuthorizationDigest($expect['tokenDomain'], $authorization), $p['signature']);
            } catch (\InvalidArgumentException $e) {
                $signer = null;
            }
            if ($signer === null || !Address::equals($signer, $authorization['from'])) {
                throw self::failed('the authorization signature does not recover to its payer');
            }
        }
        $source = self::source($details['chainId'], $authorization['from']);
        if (array_key_exists('source', $credential) && $credential['source'] !== null && strtolower((string) $credential['source']) !== strtolower($source)) {
            throw self::failed('source is not the payer');
        }
        return ['challenge' => $c, 'request' => $request, 'authorization' => $authorization, 'signature' => Hex::lower($p['signature']), 'payer' => $authorization['from'], 'source' => $source, 'ecdsa' => $signer !== null, 'replayKey' => strtolower($authorization['from']) . ':' . $authorization['nonce']];
    }

    public static function call(array $verified)
    {
        return ['to' => Address::checksum($verified['request']['currency']), 'data' => BatchSettlement::encodeTransferWithAuthorization($verified['authorization'], $verified['signature'])];
    }

    public static function receipt(array $verified, $hash, $timestamp)
    {
        $r = ['method' => self::METHOD, 'challengeId' => $verified['challenge']['id'], 'reference' => Hex::lower($hash), 'status' => 'success', 'timestamp' => $timestamp, 'chainId' => self::trunc($verified['request']['methodDetails']['chainId'])];
        if (array_key_exists('externalId', $verified['request'])) {
            $r['externalId'] = $verified['request']['externalId'];
        }
        return $r;
    }

    public static function mcpHeader($meta)
    {
        $v = self::isObject($meta) && array_key_exists(self::CREDENTIAL, $meta) ? $meta[self::CREDENTIAL] : null;
        if ($v === null) {
            return '';
        }
        $ok = self::isObject($v) && isset($v['payload']) && is_array($v['payload']);
        $challenge = $ok ? self::fromMeta(isset($v['challenge']) ? $v['challenge'] : null) : null;
        if ($challenge === null) {
            return 'Payment e30';
        }
        return self::credentialSerialize($challenge, $v['payload'], isset($v['source']) && is_string($v['source']) ? $v['source'] : null);
    }

    public static function mcpRequired($headerValue, $body = null)
    {
        $challenges = self::parse($headerValue);
        if (!$challenges) {
            return null;
        }
        $out = ['httpStatus' => 402, 'challenges' => array_map([self::class, 'forMeta'], $challenges)];
        if (self::isObject($body) && isset($body['type']) && is_string($body['type']) && strncmp($body['type'], self::PROBLEM, strlen(self::PROBLEM)) === 0) {
            $problem = $body;
            unset($problem['accepts'], $problem['session']);
            $problem['status'] = 402;
            $out['problem'] = $problem;
        }
        return $out;
    }

    const PAYMENT_REQUIRED = -32042;
    const VERIFICATION_FAILED = -32043;
    const INVALID_PARAMS = -32602;
    const SESSION = '/^payment\\.[A-Za-z0-9_-]{16}$/D';

    public static function mcpCapability()
    {
        return ['methods' => [self::METHOD => ['intents' => [self::INTENT]]]];
    }

    public static function mcpDeclares($capabilities)
    {
        $experimental = self::isObject($capabilities) && array_key_exists('experimental', $capabilities) ? $capabilities['experimental'] : null;
        return self::isObject($experimental) && array_key_exists('payment', $experimental) && self::isObject($experimental['payment']);
    }

    public static function mcpSession($bytes = null)
    {
        return 'payment.' . self::b64Encode($bytes === null ? random_bytes(12) : $bytes);
    }

    public static function mcpInSession($id)
    {
        return is_string($id) && preg_match(self::SESSION, trim($id, " \t")) === 1;
    }

    public static function mcpParams($message)
    {
        if (!self::isObject($message) || !array_key_exists('params', $message)) {
            return null;
        }
        $p = $message['params'];
        if (!self::isObject($p)) {
            return $p;
        }
        $root = isset($message['_meta']) && self::isObject($message['_meta']) && isset($message['_meta'][self::CREDENTIAL]) ? $message['_meta'][self::CREDENTIAL] : null;
        if ($root === null || (array_key_exists('_meta', $p) && !self::isObject($p['_meta']))) {
            return $p;
        }
        $meta = array_key_exists('_meta', $p) ? $p['_meta'] : [];
        if (isset($meta[self::CREDENTIAL])) {
            return $p;
        }
        $meta[self::CREDENTIAL] = $root;
        $p['_meta'] = $meta;
        return $p;
    }

    public static function mcpError($required, $refused = null)
    {
        if (!self::isObject($required) || !isset($required['challenges']) || !is_array($required['challenges']) || !$required['challenges']) {
            return null;
        }
        $problem = isset($required['problem']) ? $required['problem'] : null;
        $reason = $problem === null ? 'payment-required' : (string) substr((string) $problem['type'], strlen(self::PROBLEM));
        $data = ['httpStatus' => 402, 'challenges' => $required['challenges']];
        if ($problem !== null) {
            $data['problem'] = $problem;
        }
        if ($problem === null && self::isObject($refused) && isset($refused['error']) && $refused['error'] === 'bad_grant') {
            $said = [];
            foreach (['error', 'message', 'how', 'contact'] as $k) {
                if (isset($refused[$k]) && is_string($refused[$k])) {
                    $said[$k] = $refused[$k];
                }
            }
            return ['code' => self::VERIFICATION_FAILED, 'message' => 'Payment Verification Failed', 'data' => $data + ['failure' => ['reason' => 'bad_grant', 'detail' => isset($said['message']) ? $said['message'] : '']] + $said];
        }
        if ($reason === 'payment-required') {
            return ['code' => self::PAYMENT_REQUIRED, 'message' => 'Payment Required', 'data' => $data];
        }
        $detail = (string) (isset($problem['detail']) ? $problem['detail'] : '');
        if ($reason === 'malformed-credential') {
            return ['code' => self::INVALID_PARAMS, 'message' => 'Invalid params', 'data' => $data + ['detail' => $detail]];
        }
        return ['code' => self::VERIFICATION_FAILED, 'message' => 'Payment Verification Failed', 'data' => $data + ['failure' => ['reason' => $reason, 'detail' => $detail]]];
    }
}
