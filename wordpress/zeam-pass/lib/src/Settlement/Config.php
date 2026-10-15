<?php

namespace ZeamPass\Settlement;

use ZeamPass\Address;
use ZeamPass\Big;
use ZeamPass\Erc20;
use ZeamPass\Hex;
use ZeamPass\Meter\TimeMeter;
use ZeamPass\Pass;
use ZeamPass\Secp256k1;

final class Config
{
    const NETWORK = 'eip155:8453';
    const CHAIN_ID = 8453;
    const SCHEME = 'batch-settlement';
    const WITHDRAW_DELAY = 86400;
    const MAX_TIMEOUT_SECONDS = 240;
    const DRAIN_WAIT_MS = 2000;
    const FEE_SHARE = 0.0999;
    const GAS = [
        'deposit' => 145000,
        'claimBase' => 35000,
        'claimEntry' => 45000,
        'claimAlone' => 80000,
        'payout' => 210000,
        'charge' => 80000,
        'createSplit' => 280000,
        'refund' => 97000,
        'refundClaim' => 37000,
        'paidClaim' => 37700,
        'gasPayment' => 58600,
        'paidL1' => 13800,
        'paidClaimL1' => 4200,
    ];
    const GAS_MEASURED = [
        'on' => '2026-09-29',
        'how' => '35 paid relay refunds, Base blocks 51915440-51949669 (25 alone, 10 with a riding claim); gasUsed + L1 fee in gas',
        'paidRefund' => 155625,
        'paidRefundWithClaim' => 193332,
        'paidL1' => 13830,
        'paidL1WithClaim' => 18059,
    ];

    public $name;
    public $site;
    public $priceMicroUSD;
    public $payout;
    public $feeRecipient;
    public $receiver;
    public $split;
    public $salt;
    public $receiverAuthorizer;
    public $relayUrl;
    public $rpcUrl;
    public $network = self::NETWORK;
    public $chainId = self::CHAIN_ID;
    public $withdrawDelay = self::WITHDRAW_DELAY;
    public $maxTimeoutSeconds = self::MAX_TIMEOUT_SECONDS;
    public $assets = [];
    public $depositFloorMicroUSD = null;
    public $wethUSD = null;
    public $gasPriceWei = null;
    public $feeShare = self::FEE_SHARE;
    public $payoutIsFeeRecipient = false;
    public $gas = self::GAS;
    public $gasBuffer = 1.15;
    public $floorMargin = 1.25;
    public $idleClaimSecs = 20;
    public $maxClaimsPerBatch = 50;
    public $payoutMinUnits = 1;
    public $refundWindowSecs = 300;
    public $refundUrl = null;
    public $receiptTimeoutSecs = 60;
    public $receiptPollMs = 1000;
    public $stateCatchUpMs = 2000;
    public $drainTries = 15;
    public $drainWaitMs = self::DRAIN_WAIT_MS;
    public $repairEveryMs = 60000;
    public $gasPaymentSecs = 300;
    public $refundJudgeWaitMs = 5000;
    public $cache;
    public $meter = null;
    public $holds;

    private $receiverAuthorizerKey;
    private $clock;
    private $sleeper;

    public function __construct(array $o)
    {
        foreach (['name', 'priceMicroUSD', 'payout', 'feeRecipient', 'receiverAuthorizerKey', 'relayUrl', 'rpcUrl'] as $k) {
            if (!isset($o[$k]) || $o[$k] === '') {
                throw new \InvalidArgumentException(esc_html("settlement config is missing $k"));
            }
        }
        $this->name = (string) $o['name'];
        $this->site = isset($o['site']) ? (string) $o['site'] : '';
        $this->priceMicroUSD = (int) $o['priceMicroUSD'];
        if ($this->priceMicroUSD < 1) {
            throw new \InvalidArgumentException('the price is at least one micro-USD');
        }
        $this->payout = Address::checksum($o['payout']);
        $this->feeRecipient = Address::checksum($o['feeRecipient']);
        $this->payoutIsFeeRecipient = isset($o['payoutIsFeeRecipient']) && $o['payoutIsFeeRecipient'] === true;
        $this->feeShare = $this->payoutIsFeeRecipient ? 1 : self::FEE_SHARE;
        $seller = Pass::sellerSplit($this->payout, $this->feeRecipient, $this->name, $this->payoutIsFeeRecipient);
        $this->split = $seller['split'];
        $this->salt = $seller['salt'];
        $this->receiver = $seller['address'];
        if (isset($o['receiver']) && !Address::equals($o['receiver'], $this->receiver)) {
            throw new \InvalidArgumentException('the receiver is not the split predicted for this seller');
        }
        $this->receiverAuthorizerKey = Secp256k1::normalizePrivateKey($o['receiverAuthorizerKey']);
        $this->receiverAuthorizer = Secp256k1::privateKeyToAddress($this->receiverAuthorizerKey);
        $this->relayUrl = rtrim((string) $o['relayUrl'], '/');
        $this->rpcUrl = (string) $o['rpcUrl'];
        foreach ([
            'withdrawDelay', 'maxTimeoutSeconds', 'depositFloorMicroUSD', 'wethUSD', 'gasPriceWei', 'feeShare', 'gasBuffer',
            'floorMargin', 'idleClaimSecs', 'maxClaimsPerBatch', 'payoutMinUnits', 'refundWindowSecs', 'refundUrl',
            'receiptTimeoutSecs', 'receiptPollMs', 'stateCatchUpMs', 'drainTries', 'drainWaitMs', 'repairEveryMs', 'gasPaymentSecs', 'refundJudgeWaitMs',
        ] as $k) {
            if (array_key_exists($k, $o)) {
                $this->$k = $o[$k];
            }
        }
        $this->withdrawDelay = (int) $this->withdrawDelay;
        $this->maxTimeoutSeconds = (int) $this->maxTimeoutSeconds;
        if (isset($o['gas']) && is_array($o['gas'])) {
            $this->gas = array_merge(self::GAS, $o['gas']);
        }
        $this->assets = [];
        foreach (isset($o['assets']) ? $o['assets'] : [self::usdc()] as $a) {
            $this->assets[] = self::asset($a);
        }
        if ($this->assets === []) {
            throw new \InvalidArgumentException('a seller accepts at least one asset');
        }
        $this->clock = isset($o['clock']) && is_callable($o['clock']) ? $o['clock'] : null;
        $this->sleeper = isset($o['sleep']) && is_callable($o['sleep']) ? $o['sleep'] : null;
        $this->cache = isset($o['cache']) && $o['cache'] instanceof Cache ? $o['cache'] : new ArrayCache($this->clock);
        $this->meter = isset($o['meter']) && $o['meter'] instanceof TimeMeter ? $o['meter'] : null;
        $this->holds = isset($o['holds']) && $o['holds'] instanceof Holds ? $o['holds'] : new CacheHolds($this->cache);
    }

    public static function usdc()
    {
        return [
            'symbol' => 'USDC',
            'address' => Erc20::USDC_BASE,
            'decimals' => 6,
            'name' => Erc20::USDC_BASE_NAME,
            'version' => Erc20::USDC_BASE_VERSION,
            'eip3009' => true,
            'priceUSD' => 1,
        ];
    }

    private static function asset(array $a)
    {
        foreach (['symbol', 'address', 'decimals'] as $k) {
            if (!isset($a[$k])) {
                throw new \InvalidArgumentException(esc_html("an asset is missing $k"));
            }
        }
        return [
            'symbol' => (string) $a['symbol'],
            'address' => Address::checksum($a['address']),
            'decimals' => (int) $a['decimals'],
            'name' => isset($a['name']) ? (string) $a['name'] : null,
            'version' => isset($a['version']) ? (string) $a['version'] : null,
            'eip3009' => !empty($a['eip3009']) && isset($a['name']),
            'priceUSD' => isset($a['priceUSD']) ? (float) $a['priceUSD'] : 1.0,
        ];
    }

    public function assetOf($token)
    {
        foreach ($this->assets as $a) {
            if (Address::equals($a['address'], (string) $token)) {
                return $a;
            }
        }
        return null;
    }

    public function unitsOfMicroUSD(array $asset, $microUSD)
    {
        if ($asset['decimals'] === 6 && (float) $asset['priceUSD'] === 1.0) {
            return (string) max(1, (int) $microUSD);
        }
        $units = round(((float) $microUSD / 1e6 / (float) $asset['priceUSD']) * pow(10, $asset['decimals']));
        return sprintf('%.0f', max(1, $units));
    }

    public function microUSDOf($token, $units)
    {
        $asset = is_array($token) ? $token : $this->assetOf($token);
        if ($asset === null) {
            return null;
        }
        $n = Big::init((string) $units, 10);
        if ($asset['decimals'] === 6 && (float) $asset['priceUSD'] === 1.0) {
            return (int) Big::strval($n);
        }
        return (int) round((float) Big::strval($n) / pow(10, $asset['decimals']) * (float) $asset['priceUSD'] * 1e6);
    }

    public function priceUnits(array $asset)
    {
        return $this->unitsOfMicroUSD($asset, $this->priceMicroUSD);
    }

    public function relaySplit()
    {
        return [
            'split' => [
                'recipients' => $this->split['recipients'],
                'allocations' => $this->split['allocations'],
                'totalAllocation' => $this->split['totalAllocation'],
                'distributionIncentive' => (int) $this->split['distributionIncentive'],
            ],
            'salt' => Hex::lower($this->salt),
            'receiver' => $this->receiver,
        ];
    }

    public function signingKey()
    {
        return $this->receiverAuthorizerKey;
    }

    public function mppSecret()
    {
        return hash_hmac('sha256', 'zeam-pass/mpp-challenge-binding', Hex::toBin($this->receiverAuthorizerKey), true);
    }

    public function nowMs()
    {
        return $this->clock ? (int) call_user_func($this->clock) : (int) floor(microtime(true) * 1000);
    }

    public function sleepMs($ms)
    {
        if ($ms <= 0) {
            return;
        }
        if ($this->sleeper) {
            call_user_func($this->sleeper, $ms);
            return;
        }
        usleep((int) $ms * 1000);
    }

    public function __debugInfo()
    {
        $out = get_object_vars($this);
        $out['receiverAuthorizerKey'] = '(hidden)';
        return $out;
    }
}
