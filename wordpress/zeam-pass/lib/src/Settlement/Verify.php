<?php

namespace ZeamPass\Settlement;

use ZeamPass\Address;
use ZeamPass\BatchSettlement;
use ZeamPass\Big;
use ZeamPass\Hex;
use ZeamPass\RpcException;
use ZeamPass\Secp256k1;
use ZeamPass\TypedData;

final class Verify
{
    const ZERO = '0x0000000000000000000000000000000000000000';
    const PERMIT2_WITNESS_TYPES = [
        'PermitWitnessTransferFrom' => [
            ['name' => 'permitted', 'type' => 'TokenPermissions'],
            ['name' => 'spender', 'type' => 'address'],
            ['name' => 'nonce', 'type' => 'uint256'],
            ['name' => 'deadline', 'type' => 'uint256'],
            ['name' => 'witness', 'type' => 'DepositWitness'],
        ],
        'TokenPermissions' => [
            ['name' => 'token', 'type' => 'address'],
            ['name' => 'amount', 'type' => 'uint256'],
        ],
        'DepositWitness' => [
            ['name' => 'channelId', 'type' => 'bytes32'],
        ],
    ];

    private $cfg;
    private $chain;

    public function __construct(Config $cfg, Chain $chain)
    {
        $this->cfg = $cfg;
        $this->chain = $chain;
    }

    public static function isVoucherFields($v)
    {
        return is_array($v) && array_key_exists('channelId', $v) && array_key_exists('maxClaimableAmount', $v) && array_key_exists('signature', $v);
    }

    public static function isDepositPayload($raw)
    {
        return is_array($raw) && isset($raw['type']) && $raw['type'] === 'deposit' && array_key_exists('channelConfig', $raw)
            && self::isVoucherFields(isset($raw['voucher']) ? $raw['voucher'] : null)
            && isset($raw['deposit']) && is_array($raw['deposit']) && isset($raw['deposit']['amount']) && is_string($raw['deposit']['amount'])
            && isset($raw['deposit']['authorization']) && is_array($raw['deposit']['authorization']);
    }

    public static function isVoucherPayload($raw)
    {
        return is_array($raw) && isset($raw['type']) && $raw['type'] === 'voucher' && array_key_exists('channelConfig', $raw)
            && self::isVoucherFields(isset($raw['voucher']) ? $raw['voucher'] : null);
    }

    public static function isRefundPayload($raw)
    {
        return is_array($raw) && isset($raw['type']) && $raw['type'] === 'refund' && array_key_exists('channelConfig', $raw)
            && self::isVoucherFields(isset($raw['voucher']) ? $raw['voucher'] : null);
    }

    public static function chainIdOf($network)
    {
        if (!is_string($network) || !preg_match('/^eip155:(\d+)$/D', $network, $m)) {
            throw new \InvalidArgumentException(esc_html('not an EVM network: ' . (is_scalar($network) ? $network : gettype($network))));
        }
        return (int) $m[1];
    }

    public static function isCanonicalChannelId($id)
    {
        return is_string($id) && preg_match('/^0x[0-9a-fA-F]{64}$/D', $id) === 1;
    }

    public static function strictConfig($config)
    {
        if (!is_array($config)) {
            throw new \InvalidArgumentException('channelConfig is not an object');
        }
        foreach (['payer', 'payerAuthorizer', 'receiver', 'receiverAuthorizer', 'token'] as $k) {
            $a = isset($config[$k]) ? $config[$k] : null;
            if (!Address::isAddress($a)) {
                throw new \InvalidArgumentException(esc_html("channelConfig.$k is not an address"));
            }
            $body = substr($a, 2);
            if ($body !== strtolower($body) && $body !== strtoupper($body) && !Address::isChecksummed($a)) {
                throw new \InvalidArgumentException(esc_html("channelConfig.$k has a bad checksum"));
            }
        }
        if (!isset($config['withdrawDelay']) || !is_int($config['withdrawDelay'])) {
            throw new \InvalidArgumentException('channelConfig.withdrawDelay is not a number');
        }
        if (!isset($config['salt']) || !Hex::isHex($config['salt'], 32)) {
            throw new \InvalidArgumentException('channelConfig.salt is not 32 bytes');
        }
        return $config;
    }

    public static function computeChannelId($config, $network)
    {
        return BatchSettlement::channelId(self::strictConfig($config), self::chainIdOf($network));
    }

    public static function bindingError($config, $channelId, $network)
    {
        if (!self::isCanonicalChannelId($channelId)) {
            return Reason::CHANNEL_ID_INVALID;
        }
        if (strtolower(self::computeChannelId($config, $network)) !== strtolower($channelId)) {
            return Reason::CHANNEL_ID_MISMATCH;
        }
        return null;
    }

    public static function uint($value)
    {
        if (is_int($value) && $value >= 0) {
            return Big::init($value);
        }
        if (is_string($value)) {
            $v = trim($value);
            if (preg_match('/^[0-9]+$/D', $v)) {
                return Big::init($v, 10);
            }
            if (preg_match('/^0x[0-9a-fA-F]+$/D', $v)) {
                return Big::init(substr($v, 2), 16);
            }
        }
        throw new \InvalidArgumentException(esc_html('not an unsigned integer: ' . (is_scalar($value) ? (string) $value : gettype($value))));
    }

    const MAX_SAFE = 9007199254740991;
    const AMOUNT_FORM = 'voucher.maxClaimableAmount is not an unsigned integer: send it as a base-10 or 0x string, or as a whole JSON number up to 9007199254740991';

    public static function amount($value)
    {
        if (is_int($value)) {
            if ($value >= 0 && $value <= self::MAX_SAFE) {
                return Big::init($value);
            }
            throw new \InvalidArgumentException(esc_html('not an unsigned integer a JSON number can carry exactly: ' . $value));
        }
        if (is_float($value)) {
            if (is_finite($value) && floor($value) === $value && $value >= 0 && $value <= self::MAX_SAFE) {
                return Big::init((int) $value);
            }
            throw new \InvalidArgumentException(esc_html('not an unsigned integer a JSON number can carry exactly: ' . $value));
        }
        if (is_string($value)) {
            return self::uint($value);
        }
        throw new \InvalidArgumentException(esc_html('not an unsigned integer: ' . (is_scalar($value) ? var_export($value, true) : gettype($value))));
    }

    public static function normalized($raw)
    {
        if (!is_array($raw) || !isset($raw['voucher']) || !is_array($raw['voucher']) || !array_key_exists('maxClaimableAmount', $raw['voucher'])) {
            return $raw;
        }
        try {
            $raw['voucher']['maxClaimableAmount'] = Big::strval(self::amount($raw['voucher']['maxClaimableAmount']));
        } catch (\Throwable $e) {
            return null;
        }
        return $raw;
    }

    public function configError(array $config, $channelId, array $req)
    {
        self::strictConfig($config);
        $extra = isset($req['extra']) && is_array($req['extra']) ? $req['extra'] : [];
        return BatchSettlement::validateChannelConfig(
            $config,
            $channelId,
            self::chainIdOf($req['network']),
            $req['payTo'],
            isset($extra['receiverAuthorizer']) ? $extra['receiverAuthorizer'] : null,
            $req['asset'],
            array_key_exists('withdrawDelay', $extra) ? (int) $extra['withdrawDelay'] : null
        );
    }

    public function hashSignatureOk($address, $digest, $signature)
    {
        try {
            $code = $this->chain->code($address);
        } catch (\Throwable $e) {
            return false;
        }
        if ($code === '0x' || $code === '') {
            if (!is_string($signature) || strlen(preg_replace('/^0x/i', '', $signature)) !== 130) {
                return false;
            }
            return self::recovers($address, $digest, $signature);
        }
        return $this->chain->isValidSignature($address, $digest, $signature);
    }

    public static function recovers($address, $digest, $signature)
    {
        try {
            return Secp256k1::isCanonical($signature) && Address::equals(Secp256k1::recoverHash($digest, $signature), $address);
        } catch (\Throwable $e) {
            return false;
        }
    }

    public function voucherSignatureOk(array $config, $channelId, $max, $signature, $chainId)
    {
        try {
            $digest = BatchSettlement::voucherDigest($channelId, Big::strval(self::uint($max)), $chainId);
        } catch (\Throwable $e) {
            return false;
        }
        if ($config['payerAuthorizer'] !== self::ZERO) {
            return self::recovers($config['payerAuthorizer'], $digest, $signature);
        }
        return $this->hashSignatureOk($config['payer'], $digest, $signature);
    }

    public static function invalid($reason, $payer = null, $message = null)
    {
        $out = ['isValid' => false, 'invalidReason' => $reason];
        if ($message !== null) {
            $out['invalidMessage'] = $message;
        }
        if ($payer !== null) {
            $out['payer'] = $payer;
        }
        return $out;
    }

    public function facilitator(array $payload, array $req)
    {
        $raw = isset($payload['payload']) ? $payload['payload'] : null;
        $accepted = isset($payload['accepted']) && is_array($payload['accepted']) ? $payload['accepted'] : [];
        if ((isset($accepted['scheme']) ? $accepted['scheme'] : null) !== Config::SCHEME || $req['scheme'] !== Config::SCHEME) {
            return self::invalid(Reason::INVALID_SCHEME);
        }
        if ((isset($accepted['network']) ? $accepted['network'] : null) !== $req['network']) {
            return self::invalid(Reason::NETWORK_MISMATCH);
        }
        try {
            if (self::isDepositPayload($raw)) {
                return $this->deposit($raw, $req);
            }
            if (self::isVoucherPayload($raw)) {
                return $this->voucher($raw, $req);
            }
        } catch (RpcException $e) {
            return self::invalid(Reason::RPC_READ_FAILED, null, \ZeamPass\message($e));
        } catch (\Throwable $e) {
            return self::invalid(\ZeamPass\message($e));
        }
        return self::invalid(Reason::PAYLOAD_TYPE);
    }

    public function voucher(array $raw, array $req)
    {
        $config = $raw['channelConfig'];
        $payer = $config['payer'];
        $channelId = $raw['voucher']['channelId'];
        $err = $this->configError($config, $channelId, $req);
        if ($err) {
            return self::invalid($err, $payer);
        }
        if (!$this->voucherSignatureOk($config, $channelId, $raw['voucher']['maxClaimableAmount'], $raw['voucher']['signature'], self::chainIdOf($req['network']))) {
            return self::invalid(Reason::VOUCHER_SIGNATURE, $payer);
        }
        try {
            $state = $this->chain->state($channelId);
        } catch (\Throwable $e) {
            return self::invalid(Reason::RPC_READ_FAILED, $payer, \ZeamPass\message($e));
        }
        $balance = Big::init($state['balance'], 10);
        if (Big::sign($balance) === 0) {
            return self::invalid(Reason::CHANNEL_NOT_FOUND, $payer);
        }
        $max = self::uint($raw['voucher']['maxClaimableAmount']);
        if (Big::cmp($max, $balance) > 0) {
            return self::invalid(Reason::EXCEEDS_BALANCE, $payer);
        }
        if (Big::cmp($max, Big::init($state['totalClaimed'], 10)) <= 0) {
            return self::invalid(Reason::BELOW_CLAIMED, $payer);
        }
        return [
            'isValid' => true,
            'payer' => $payer,
            'extra' => [
                'channelId' => $channelId,
                'balance' => $state['balance'],
                'totalClaimed' => $state['totalClaimed'],
                'withdrawRequestedAt' => $state['withdrawRequestedAt'],
                'refundNonce' => $state['refundNonce'],
            ],
        ];
    }

    public static function transferMethod(array $raw, array $req)
    {
        if (!empty($req['extra']['assetTransferMethod'])) {
            return $req['extra']['assetTransferMethod'];
        }
        return !empty($raw['deposit']['authorization']['permit2Authorization']) ? 'permit2' : 'eip3009';
    }

    public function deposit(array $raw, array $req)
    {
        $config = $raw['channelConfig'];
        $payer = $config['payer'];
        $err = $this->configError($config, $raw['voucher']['channelId'], $req);
        if ($err) {
            return self::invalid($err, $payer);
        }
        $method = self::transferMethod($raw, $req);
        if ($method === 'permit2' && empty($raw['deposit']['authorization']['permit2Authorization'])) {
            return self::invalid(Reason::PAYLOAD_TYPE, $payer);
        }
        $fail = $method === 'permit2' ? $this->permit2($raw, $req) : $this->erc3009($raw, $req);
        if ($fail) {
            return $fail;
        }
        $shared = $this->sharedDepositState($raw, $req);
        if (!$shared['ok']) {
            return $shared['response'];
        }
        $execution = $this->execution($raw, $req);
        if (isset($execution['isValid'])) {
            return $execution;
        }
        try {
            $this->chain->call(BatchSettlement::ESCROW, BatchSettlement::encodeDeposit($config, Big::strval(self::uint($raw['deposit']['amount'])), $execution['collector'], $execution['collectorData']));
        } catch (\Throwable $e) {
            return self::invalid(Reason::DEPOSIT_SIMULATION_FAILED, $payer, \ZeamPass\message($e));
        }
        return [
            'isValid' => true,
            'payer' => $payer,
            'extra' => [
                'channelId' => $raw['voucher']['channelId'],
                'balance' => $shared['balance'],
                'totalClaimed' => $shared['totalClaimed'],
                'withdrawRequestedAt' => $shared['withdrawRequestedAt'],
                'refundNonce' => $shared['refundNonce'],
            ],
            'execution' => $execution,
        ];
    }

    public function execution(array $raw, array $req)
    {
        if (self::transferMethod($raw, $req) === 'eip3009') {
            return [
                'collector' => BatchSettlement::ERC3009_DEPOSIT_COLLECTOR,
                'collectorData' => BatchSettlement::erc3009DepositCollectorData($raw['deposit']['authorization']['erc3009Authorization']),
            ];
        }
        $fail = $this->permit2Allowance($raw, $req);
        if ($fail) {
            return $fail;
        }
        $auth = $raw['deposit']['authorization']['permit2Authorization'];
        $inner = BatchSettlement::parseErc6492Signature($auth['signature']);
        return [
            'collector' => BatchSettlement::PERMIT2_DEPOSIT_COLLECTOR,
            'collectorData' => BatchSettlement::permit2CollectorData(Big::strval(self::uint($auth['nonce'])), Big::strval(self::uint($auth['deadline'])), $inner['signature'], '0x'),
        ];
    }

    private function erc3009(array $raw, array $req)
    {
        $payer = $raw['channelConfig']['payer'];
        $auth = isset($raw['deposit']['authorization']['erc3009Authorization']) ? $raw['deposit']['authorization']['erc3009Authorization'] : null;
        if (!is_array($auth) || $auth === []) {
            return self::invalid(Reason::ERC3009_AUTHORIZATION_REQUIRED, $payer);
        }
        $extra = isset($req['extra']) ? $req['extra'] : [];
        if (empty($extra['name']) || empty($extra['version'])) {
            return self::invalid(Reason::MISSING_EIP712_DOMAIN, $payer);
        }
        $validAfter = self::uint($auth['validAfter']);
        $validBefore = self::uint($auth['validBefore']);
        $now = intdiv($this->cfg->nowMs(), 1000);
        if (Big::cmp($validBefore, Big::init($now + 6)) < 0) {
            return self::invalid(Reason::VALID_BEFORE, $payer);
        }
        if (Big::cmp($validAfter, Big::init($now)) > 0) {
            return self::invalid(Reason::VALID_AFTER, $payer);
        }
        $parsed = BatchSettlement::parseErc6492Signature($auth['signature']);
        if ($parsed['address'] !== null && $parsed['data'] !== null && !Address::equals($parsed['address'], self::ZERO)) {
            try {
                $deployed = $this->chain->hasCode($payer);
            } catch (\Throwable $e) {
                $deployed = false;
            }
            if (!$deployed) {
                return self::invalid(Reason::FACTORY_NOT_ALLOWED, $payer);
            }
        }
        $chainId = self::chainIdOf($req['network']);
        $nonce = BatchSettlement::erc3009DepositNonce($raw['voucher']['channelId'], $auth['salt']);
        $digest = BatchSettlement::receiveAuthorizationDigest(
            BatchSettlement::tokenDomain($req['asset'], $extra['name'], $extra['version'], $chainId),
            BatchSettlement::receiveAuthorization($payer, Big::strval(self::uint($raw['deposit']['amount'])), Big::strval($validAfter), Big::strval($validBefore), $nonce)
        );
        if (!$this->hashSignatureOk($payer, $digest, $parsed['signature'])) {
            return self::invalid(Reason::RECEIVE_AUTHORIZATION_SIGNATURE, $payer);
        }
        return null;
    }

    private function permit2(array $raw, array $req)
    {
        $payer = $raw['channelConfig']['payer'];
        $auth = $raw['deposit']['authorization']['permit2Authorization'];
        if (!is_array($auth)) {
            return self::invalid(Reason::PERMIT2_AUTHORIZATION_REQUIRED, $payer);
        }
        if (!Address::equals(Address::checksum($auth['from']), $payer)) {
            return self::invalid(Reason::PERMIT2_INVALID_SIGNATURE, $payer);
        }
        if (!Address::equals(Address::checksum($auth['spender']), BatchSettlement::PERMIT2_DEPOSIT_COLLECTOR)) {
            return self::invalid(Reason::PERMIT2_INVALID_SPENDER, $payer);
        }
        if (!Address::equals(Address::checksum($auth['permitted']['token']), $req['asset'])) {
            return self::invalid(Reason::TOKEN_MISMATCH, $payer);
        }
        if (Big::cmp(self::uint($auth['permitted']['amount']), self::uint($raw['deposit']['amount'])) !== 0) {
            return self::invalid(Reason::PERMIT2_AMOUNT_MISMATCH, $payer);
        }
        if (!isset($auth['witness']['channelId']) || $auth['witness']['channelId'] !== $raw['voucher']['channelId']) {
            return self::invalid(Reason::CHANNEL_ID_MISMATCH, $payer);
        }
        $now = intdiv($this->cfg->nowMs(), 1000);
        if (Big::cmp(self::uint($auth['deadline']), Big::init($now + 6)) < 0) {
            return self::invalid(Reason::PERMIT2_DEADLINE_EXPIRED, $payer);
        }
        try {
            $digest = TypedData::hash(
                ['name' => 'Permit2', 'chainId' => self::chainIdOf($req['network']), 'verifyingContract' => Chain::PERMIT2],
                self::PERMIT2_WITNESS_TYPES,
                'PermitWitnessTransferFrom',
                [
                    'permitted' => ['token' => Address::checksum($auth['permitted']['token']), 'amount' => Big::strval(self::uint($auth['permitted']['amount']))],
                    'spender' => Address::checksum($auth['spender']),
                    'nonce' => Big::strval(self::uint($auth['nonce'])),
                    'deadline' => Big::strval(self::uint($auth['deadline'])),
                    'witness' => ['channelId' => $auth['witness']['channelId']],
                ]
            );
        } catch (\Throwable $e) {
            return self::invalid(Reason::PERMIT2_INVALID_SIGNATURE, $payer);
        }
        if (!$this->hashSignatureOk(Address::checksum($auth['from']), $digest, $auth['signature'])) {
            return self::invalid(Reason::PERMIT2_INVALID_SIGNATURE, $payer);
        }
        return $this->permit2Allowance($raw, $req);
    }

    private function permit2Allowance(array $raw, array $req)
    {
        $payer = $raw['channelConfig']['payer'];
        try {
            $allowance = $this->chain->allowance($req['asset'], $payer, Chain::PERMIT2);
        } catch (\Throwable $e) {
            return self::invalid(Reason::PERMIT2_ALLOWANCE_REQUIRED, $payer);
        }
        if (Big::cmp(Big::init($allowance, 10), self::uint($raw['deposit']['amount'])) < 0) {
            return self::invalid(Reason::PERMIT2_ALLOWANCE_REQUIRED, $payer);
        }
        return null;
    }

    private function sharedDepositState(array $raw, array $req)
    {
        $config = $raw['channelConfig'];
        $payer = $config['payer'];
        $channelId = $raw['voucher']['channelId'];
        $err = $this->configError($config, $channelId, $req);
        if ($err) {
            return ['ok' => false, 'response' => self::invalid($err, $payer)];
        }
        if (!$this->voucherSignatureOk($config, $channelId, $raw['voucher']['maxClaimableAmount'], $raw['voucher']['signature'], self::chainIdOf($req['network']))) {
            return ['ok' => false, 'response' => self::invalid(Reason::VOUCHER_SIGNATURE, $payer)];
        }
        try {
            $ch = $this->chain->channel($channelId);
            $payerBalance = $this->chain->balanceOf($req['asset'], $payer);
            $wd = $this->chain->pendingWithdrawal($channelId);
            $nonce = $this->chain->refundNonce($channelId);
        } catch (\Throwable $e) {
            return ['ok' => false, 'response' => self::invalid(Reason::RPC_READ_FAILED, $payer, \ZeamPass\message($e))];
        }
        $amount = self::uint($raw['deposit']['amount']);
        if (Big::cmp(Big::init($payerBalance, 10), $amount) < 0) {
            return ['ok' => false, 'response' => self::invalid(Reason::INSUFFICIENT_BALANCE, $payer)];
        }
        $max = self::uint($raw['voucher']['maxClaimableAmount']);
        if (Big::cmp($max, Big::add(Big::init($ch['balance'], 10), $amount)) > 0) {
            return ['ok' => false, 'response' => self::invalid(Reason::EXCEEDS_BALANCE, $payer)];
        }
        if (Big::cmp($max, Big::init($ch['totalClaimed'], 10)) <= 0) {
            return ['ok' => false, 'response' => self::invalid(Reason::BELOW_CLAIMED, $payer)];
        }
        return [
            'ok' => true,
            'balance' => $ch['balance'],
            'totalClaimed' => $ch['totalClaimed'],
            'withdrawRequestedAt' => $wd['initiatedAt'],
            'refundNonce' => $nonce,
        ];
    }

    public function local(array $raw, array $req, $channel, $now)
    {
        $ttl = min(300000, max(30000, intdiv(max(0, $this->cfg->withdrawDelay) * 1000, 3)));
        if ($channel === null || !isset($channel['onchainSyncedAt']) || $now - (int) $channel['onchainSyncedAt'] > $ttl) {
            return null;
        }
        $config = $raw['channelConfig'];
        if ($config['payerAuthorizer'] === self::ZERO) {
            return null;
        }
        $payer = $config['payer'];
        $channelId = $raw['voucher']['channelId'];
        $err = $this->configError($config, $channelId, $req);
        if ($err) {
            return self::invalid($err, $payer);
        }
        if (strtolower(self::computeChannelId($config, $req['network'])) !== strtolower($channel['channelId'])) {
            return self::invalid(Reason::CHANNEL_ID_MISMATCH, $payer);
        }
        $digest = BatchSettlement::voucherDigest($channelId, Big::strval(self::uint($raw['voucher']['maxClaimableAmount'])), self::chainIdOf($req['network']));
        if (!self::recovers(Address::checksum($config['payerAuthorizer']), $digest, $raw['voucher']['signature'])) {
            return self::invalid(Reason::VOUCHER_SIGNATURE, $payer);
        }
        $max = self::uint($raw['voucher']['maxClaimableAmount']);
        if (Big::cmp($max, Big::init((string) $channel['balance'], 10)) > 0) {
            return null;
        }
        if (Big::cmp($max, Big::init((string) $channel['totalClaimed'], 10)) <= 0) {
            return self::invalid(Reason::BELOW_CLAIMED, $payer);
        }
        return [
            'isValid' => true,
            'payer' => $payer,
            'extra' => [
                'channelId' => $channelId,
                'balance' => (string) $channel['balance'],
                'totalClaimed' => (string) $channel['totalClaimed'],
                'withdrawRequestedAt' => (int) $channel['withdrawRequestedAt'],
                'refundNonce' => (string) $channel['refundNonce'],
            ],
        ];
    }
}
