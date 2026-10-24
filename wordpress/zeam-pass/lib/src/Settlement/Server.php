<?php

namespace ZeamPass\Settlement;

use ZeamPass\Abi;
use ZeamPass\Address;
use ZeamPass\BatchSettlement;
use ZeamPass\Big;
use ZeamPass\Hex;
use ZeamPass\Keccak;
use ZeamPass\Pricing;

final class Server
{
    const MISMATCH = Reason::CUMULATIVE_AMOUNT_MISMATCH;
    const MIN_PENDING_TTL_MS = 5000;
    const MAX_PENDING_TTL_MS = 600000;
    const MPP_TTL_SECS = 300;
    const MPP_USED_TRIES = 5;
    const MPP_SHOWN_RETRY_SECS = 2;
    const DEFAULT_PORTS = ['http' => 80, 'https' => 443, 'ws' => 80, 'wss' => 443, 'ftp' => 21];
    const SDK_FIELDS = [
        'channelId', 'channelConfig', 'chargedCumulativeAmount', 'signedMaxClaimable', 'signature', 'balance', 'totalClaimed',
        'withdrawRequestedAt', 'refundNonce', 'onchainSyncedAt', 'lastRequestTimestamp', 'pendingRequest',
    ];

    private $cfg;
    private $store;
    private $chain;
    private $relay;
    private $gas;
    private $channels;
    private $verify;

    public function __construct(Config $cfg, Store $store, ?Chain $chain = null, ?Relay $relay = null)
    {
        $this->cfg = $cfg;
        $this->store = $store;
        $this->chain = $chain ?: new Chain($cfg->rpcUrl);
        $this->relay = $relay ?: new Relay($cfg->relayUrl);
        $this->gas = new GasQuote($cfg, $this->chain, $this->relay);
        $this->channels = new Channels($cfg, $store, $this->chain);
        $this->verify = new Verify($cfg, $this->chain);
    }

    public function gas()
    {
        return $this->gas;
    }

    public function micro($price)
    {
        if (is_array($price)) {
            $price = isset($price['micro']) ? $price['micro'] : null;
        }
        return $price !== null && is_numeric($price) && (float) $price >= 1 ? (int) $price : $this->cfg->priceMicroUSD;
    }

    public function accepts($price = null)
    {
        $micro = $this->micro($price);
        $rows = [];
        foreach ($this->cfg->assets as $asset) {
            foreach ($asset['eip3009'] ? ['eip3009', 'permit2'] : ['permit2'] as $method) {
                $rows[] = $this->requirement($asset, $method, $micro);
            }
        }
        $dollar = array_values(array_filter($rows, function ($r) {
            return isset($r['extra']['name']) && preg_match('/^USD Coin$/i', $r['extra']['name']);
        }));
        if ($dollar !== [] && count($rows) > count($dollar)) {
            $rows = array_merge($rows, $dollar);
        }
        return $rows;
    }

    public function requirement(array $asset, $method, $micro = null)
    {
        $extra = [];
        if ($method === 'eip3009') {
            if ($asset['name'] !== null && $asset['name'] !== '') {
                $extra['name'] = $asset['name'];
                $extra['version'] = $asset['version'] !== null ? $asset['version'] : '1';
            }
        } else {
            $extra['assetTransferMethod'] = 'permit2';
        }
        $extra['receiverAuthorizer'] = $this->cfg->receiverAuthorizer;
        $extra['withdrawDelay'] = $this->cfg->withdrawDelay;
        return [
            'scheme' => Config::SCHEME,
            'network' => $this->cfg->network,
            'amount' => $this->cfg->unitsOfMicroUSD($asset, $micro === null ? $this->cfg->priceMicroUSD : $micro),
            'asset' => $asset['address'],
            'payTo' => $this->cfg->receiver,
            'maxTimeoutSeconds' => $this->cfg->maxTimeoutSeconds,
            'extra' => $extra,
        ];
    }

    public static function resourceInfo($resource)
    {
        if (is_array($resource)) {
            $out = ['url' => isset($resource['url']) ? (string) $resource['url'] : ''];
            if (isset($resource['description']) && is_string($resource['description']) && $resource['description'] !== '') {
                $out['description'] = self::shorten($resource['description'], 300);
            }
            $out['mimeType'] = isset($resource['mimeType']) ? (string) $resource['mimeType'] : 'application/json';
            return $out;
        }
        return ['url' => (string) $resource, 'mimeType' => 'application/json'];
    }

    const ELLIPSIS = '...';

    private static function utf8Cut($text, $bytes)
    {
        if (strlen($text) <= $bytes) {
            return $text;
        }
        $end = $bytes;
        while ($end > 0 && (ord($text[$end]) & 0xC0) === 0x80) {
            $end--;
        }
        return substr($text, 0, $end);
    }

    public static function shorten($text, $bytes)
    {
        $cut = self::utf8Cut($text, $bytes);
        if ($cut === $text) {
            return $text;
        }
        $end = strrpos($cut, '. ');
        if ($end !== false && $end >= 60) {
            return substr($cut, 0, $end + 1);
        }
        $room = self::utf8Cut($text, $bytes - strlen(self::ELLIPSIS));
        $space = strrpos($room, ' ');
        $whole = substr($text, strlen($room), 1) === ' ' || $space === false || $space <= 0 ? $room : substr($room, 0, $space);
        return rtrim($whole, " \t\n\r,;:([-") . self::ELLIPSIS;
    }

    private static function document(array $resource, $error, array $accepts)
    {
        $doc = ['x402Version' => 2];
        if ($error !== null) {
            $doc['error'] = $error;
        }
        $doc['resource'] = $resource;
        $doc['accepts'] = $accepts;
        return $doc;
    }

    public static function percent($share)
    {
        return \ZeamPass\Discovery::percent($share);
    }

    private static function usd($microUSD)
    {
        if (is_int($microUSD) && $microUSD >= 0) {
            return \ZeamPass\Pricing::usd($microUSD);
        }
        $s = rtrim(rtrim(sprintf('%.6f', $microUSD / 1e6), '0'), '.');
        return $s === '' ? '0' : $s;
    }

    private function priced($price)
    {
        return is_array($price) ? ['micro' => $this->micro($price), 'unitMicro' => isset($price['unitMicro']) ? $price['unitMicro'] : null] : ['micro' => $this->micro($price), 'unitMicro' => null];
    }

    public function refundWhere($refundUrl = null)
    {
        $at = $this->cfg->refundUrl ? $this->cfg->refundUrl : $refundUrl;
        return $at ? 'POST ' . $at : 'POST /refund on this site';
    }

    public function terms($refundUrl = null, $price = null)
    {
        $p = $this->priced($price);
        $floor = $this->gas->depositFloorMicroUSD($p['micro']);
        $q = $this->gas->refund(false, false);
        $cover = $q === null ? null : $q['cover']['microUSD'];
        $relayed = $this->gas->relayRefundQuote();
        $gas = $relayed !== null ? $relayed['microUSD'] : ($q === null ? null : $q['pay']['microUSD']);
        $where = $this->refundWhere($refundUrl);
        $about = function ($microUSD) {
            return $microUSD === null ? '' : ' ($' . self::usd($microUSD) . ' now)';
        };
        $margin = $relayed !== null ? $relayed['marginPercent'] : (int) round(($this->cfg->gasBuffer - 1) * 100);
        $figure = $gas === null ? '' : '$' . self::usd($gas) . ($relayed !== null ? ' at the relay\'s latest quote, ' : ' by this seller\'s estimate, ');
        return [
            'pricing' => Pricing::pricing($p),
            'deposit' => 'First call on a channel deposits at least $' . self::usd($floor) . '. Later calls spend it. The unspent balance is refundable.',
            'refund' => 'Refund: ' . $where . ' with {channelId, issued, signature} signed by the payer; add channelConfig if the channel has no calls. ' . \ZeamPass\Discovery::refundRule((int) round(($this->cfg->gasBuffer - 1) * 100), $margin) . ' Our fee is ' . self::percent($this->cfg->feeShare) . '% of what the buyer spends, against the gas it must cover with the margin' . $about($cover) . '. When it falls short, sign a gasless USDC payment of the refund gas (' . $figure . $margin . '% margin included); a refund request answers with the figure to sign. An unsettled call adds its claim gas. {"selfSend": true}: a signed refund you send from any wallet at your own gas.',
            'split' => $this->cfg->relaySplit(),
        ];
    }

    public function paymentRequired($resource, ?array $extensions = null, $refundUrl = null, array $more = [], $price = null)
    {
        $p = $this->priced($price);
        $doc = self::document(self::resourceInfo($resource), null, $this->accepts($p['micro']));
        if ($extensions) {
            $doc['extensions'] = $extensions;
        }
        $doc = array_merge($doc, $this->terms($refundUrl, $p), $more);
        $headers = ['PAYMENT-REQUIRED' => Json::base64(\ZeamPass\Bazaar::forHeader($doc))];
        $challenge = self::mppOffered($price) ? $this->mppChallenge($doc['resource'], $p['micro']) : null;
        if ($challenge !== null) {
            $headers['WWW-Authenticate'] = Mpp::header($challenge);
            $headers['Cache-Control'] = 'no-store';
        }
        return ['ok' => false, 'status' => 402, 'body' => $doc, 'headers' => $headers];
    }

    public static function mppOffered($price)
    {
        return !is_array($price) || (!isset($price['unitMicro']) && !isset($price['ms']));
    }

    public function mppRealm($resource)
    {
        $info = self::resourceInfo($resource);
        $u = parse_url($info['url']);
        if (!is_array($u) || empty($u['scheme']) || empty($u['host'])) {
            return $this->cfg->name;
        }
        $host = strtolower($u['host']);
        $scheme = strtolower($u['scheme']);
        $ports = self::DEFAULT_PORTS;
        if (isset($u['port']) && (!isset($ports[$scheme]) || $ports[$scheme] !== (int) $u['port'])) {
            $host .= ':' . (int) $u['port'];
        }
        return $host;
    }

    public function mppAsset()
    {
        foreach ($this->cfg->assets as $a) {
            if (!empty($a['eip3009'])) {
                return $a;
            }
        }
        return null;
    }

    public function mppExpect($resource, array $asset)
    {
        return [
            'realm' => $this->mppRealm($resource),
            'chainId' => $this->cfg->chainId,
            'currency' => $asset['address'],
            'recipient' => $this->cfg->receiver,
            'tokenDomain' => BatchSettlement::tokenDomain($asset['address'], $asset['name'], isset($asset['version']) && $asset['version'] !== null ? $asset['version'] : '1', $this->cfg->chainId),
        ];
    }

    public function mppFloorMicroUSD()
    {
        $gas = $this->gas->microUSD((int) ceil($this->cfg->gas['charge'] * $this->cfg->gasBuffer), GasQuote::RECENT_SECS);
        return $gas === null ? null : (int) ceil($gas / $this->cfg->feeShare);
    }

    public function mppQuote($micro)
    {
        $asset = $this->mppAsset();
        if ($asset === null) {
            return null;
        }
        $floor = $this->mppFloorMicroUSD();
        if ($floor === null || $this->micro($micro) < $floor) {
            return null;
        }
        return ['asset' => $asset, 'amount' => $this->cfg->unitsOfMicroUSD($asset, $this->micro($micro))];
    }

    public function mppOffer($price, $description = null)
    {
        if (!self::mppOffered($price)) {
            return null;
        }
        $p = $this->priced($price);
        $q = $this->mppQuote($p['micro']);
        if ($q === null) {
            return null;
        }
        $out = ['amount' => (string) $q['amount'], 'currency' => Address::checksum($q['asset']['address'])];
        $res = self::resourceInfo(['url' => '', 'description' => $description]);
        if (isset($res['description']) && is_string($res['description'])) {
            $out['description'] = self::shorten($res['description'], 120);
        }
        $out['intent'] = Mpp::INTENT;
        $out['method'] = Mpp::METHOD;
        return $out;
    }

    public function mppChallenge($resource, $micro)
    {
        $q = $this->mppQuote($micro);
        if ($q === null) {
            return null;
        }
        $asset = $q['asset'];
        $res = self::resourceInfo($resource);
        $request = Mpp::evmRequest($q['amount'], $asset['address'], $this->cfg->receiver, $this->cfg->chainId, $asset['decimals']);
        $expires = gmdate('Y-m-d\TH:i:s\Z', intdiv($this->cfg->nowMs() + self::MPP_TTL_SECS * 1000, 1000));
        $description = null;
        if (isset($res['description']) && is_string($res['description'])) {
            $description = self::shorten($res['description'], 120);
        }
        return Mpp::issue($this->cfg->mppSecret(), $this->mppRealm($resource), Mpp::METHOD, Mpp::INTENT, $request, $expires, $description, Mpp::once());
    }

    public static function withoutDeposit(array $q)
    {
        unset($q['body']['deposit']);
        $q['headers']['PAYMENT-REQUIRED'] = Json::base64(\ZeamPass\Bazaar::forHeader($q['body']));
        return $q;
    }

    public function mppRefuse($resource, $micro, \Throwable $error)
    {
        $q = self::withoutDeposit($this->paymentRequired($resource, null, null, [], $micro));
        return self::refuse(402, array_merge(Mpp::problemOf($error), ['accepts' => $q['body']['accepts']]), $q['headers']);
    }

    public function mppUsed($token, array $verified)
    {
        $out = $this->chain->call($token, Abi::encodeCall('authorizationState(address,bytes32)', [$verified['payer'], $verified['authorization']['nonce']]));
        return ltrim(substr(Hex::lower($out), 2), '0') !== '';
    }

    public function mppHold($headerValue, $resource, $price = null)
    {
        $micro = $this->micro($price);
        $asset = $this->mppAsset();
        try {
            if ($asset === null) {
                throw new MppException('invalid-challenge', 'this seller takes no EIP-3009 token');
            }
            $credential = Mpp::credentialParse($headerValue);
            $expect = $this->mppExpect($resource, $asset);
            $verified = Mpp::verify($this->cfg->mppSecret(), $credential, $expect, intdiv($this->cfg->nowMs(), 1000));
            if ($verified['request']['amount'] !== (string) $this->cfg->unitsOfMicroUSD($asset, $micro)) {
                throw new MppException('invalid-challenge', 'the challenge is for another price');
            }
            if (!$verified['ecdsa']) {
                $digest = BatchSettlement::transferAuthorizationDigest($expect['tokenDomain'], $verified['authorization']);
                if (!$this->chain->isValidSignature($verified['payer'], $digest, $verified['signature'])) {
                    throw new MppException('verification-failed', 'the authorization signature is not valid for its payer');
                }
            }
            $was = $this->cfg->holds->entry($verified['replayKey']);
            if (is_array($was) && !empty($was['sent'])) {
                return $this->mppSent($verified, $was, $resource, $micro, $asset['address']);
            }
            if ($this->mppUsed($asset['address'], $verified)) {
                throw new MppException('verification-failed', 'this authorization has already been used');
            }
            if (Big::cmp(Big::init((string) $this->chain->balanceOf($asset['address'], $verified['payer'])), Big::init($verified['authorization']['value'])) < 0) {
                throw new MppException('verification-failed', 'the payer does not hold the amount');
            }
        } catch (MppException $e) {
            return $this->mppRefuse($resource, $micro, $e);
        }
        if (!$this->cfg->holds->claim($verified['replayKey'], 1000 * (int) $verified['authorization']['validBefore'], $this->cfg->nowMs())) {
            return $this->mppRefuse($resource, $micro, new MppException('verification-failed', 'this authorization is already in use'));
        }
        return ['ok' => true, 'hold' => ['kind' => 'mpp', 'verified' => $verified, 'micro' => $micro, 'resource' => self::resourceInfo($resource), 'asset' => $asset['address']]];
    }

    public function mppRelease(array $hold)
    {
        if (!empty($hold['landed'])) {
            $this->cfg->holds->mark($hold['verified']['replayKey'], 'taken', ['state' => 'sent']);
            return;
        }
        $this->cfg->holds->release($hold['verified']['replayKey']);
    }

    private static function usedIn($receipt, $token, array $v)
    {
        if (!is_array($receipt) || strtolower(isset($receipt['status']) ? (string) $receipt['status'] : '') !== '0x1') {
            return false;
        }
        $event = Keccak::utf8('AuthorizationUsed(address,bytes32)');
        $payer = '0x' . str_repeat('0', 24) . strtolower(substr($v['payer'], 2));
        foreach (isset($receipt['logs']) && is_array($receipt['logs']) ? $receipt['logs'] : [] as $log) {
            $t = isset($log['topics']) && is_array($log['topics']) ? array_values($log['topics']) : [];
            if (count($t) >= 3 && Address::equals(isset($log['address']) ? $log['address'] : null, $token) && strtolower((string) $t[0]) === $event && strtolower((string) $t[1]) === $payer && strtolower((string) $t[2]) === $v['authorization']['nonce']) {
                return true;
            }
        }
        return false;
    }

    private function mppNotShown($resource, $micro, $hash)
    {
        $s = self::MPP_SHOWN_RETRY_SECS;
        $out = $this->mppRefuse($resource, $micro, new MppException('verification-failed', "the payment was sent in transaction $hash and the chain this seller reads does not show it yet, so this call was not delivered. Nothing more is sent for it. Send this credential again in {$s}s: once the transfer shows, the call is delivered, once; if the transfer did not happen, nothing was charged.", ['code' => 'sent_not_shown', 'txHash' => $hash, 'retry_after_seconds' => $s]));
        $out['headers']['Retry-After'] = (string) $s;
        return $out;
    }

    private function mppSent(array $verified, array $was, $resource, $micro, $asset)
    {
        $key = $verified['replayKey'];
        $now = $this->cfg->nowMs();
        $state = isset($was['state']) ? $was['state'] : null;
        $gone = $state === 'sending' && $now - (int) (isset($was['at']) ? $was['at'] : 0) > 2000 * $this->cfg->receiptTimeoutSecs + 60000;
        if ($state === 'delivered') {
            return $this->mppRefuse($resource, $micro, new MppException('verification-failed', 'this authorization has already been used'));
        }
        if ($state !== 'sent' && !$gone) {
            return $this->mppRefuse($resource, $micro, new MppException('verification-failed', 'this authorization is already in use'));
        }
        try {
            $receipt = $this->chain->receipt($was['sent']);
        } catch (\Throwable $e) {
            $receipt = null;
        }
        if ($receipt === null) {
            return $this->mppNotShown($resource, $micro, $was['sent']);
        }
        if (self::usedIn($receipt, $asset, $verified)) {
            if (!$this->cfg->holds->mark($key, $state, ['state' => 'taken', 'at' => $now])) {
                return $this->mppRefuse($resource, $micro, new MppException('verification-failed', 'this authorization is already in use'));
            }
            return ['ok' => true, 'hold' => ['kind' => 'mpp', 'verified' => $verified, 'micro' => $micro, 'resource' => self::resourceInfo($resource), 'asset' => $asset, 'landed' => $was['sent']]];
        }
        try {
            $used = $this->mppUsed($asset, $verified);
        } catch (\Throwable $e) {
            return $this->mppNotShown($resource, $micro, $was['sent']);
        }
        if ($used) {
            return $this->mppRefuse($resource, $micro, new MppException('verification-failed', 'this authorization has already been used'));
        }
        if (!$this->cfg->holds->mark($key, $state, ['state' => 'settled', 'at' => $now])) {
            return $this->mppRefuse($resource, $micro, new MppException('verification-failed', 'this authorization is already in use'));
        }
        $this->cfg->holds->release($key);
        $how = strtolower(isset($receipt['status']) ? (string) $receipt['status'] : '') === '0x1' ? 'did not use this authorization' : 'reverted';
        return $this->mppRefuse($resource, $micro, new MppException('verification-failed', "the payment did not settle. Not delivered; nothing was charged. Transaction {$was['sent']} $how."));
    }

    private function mppDelivered(array $v, $hash)
    {
        $now = $this->cfg->nowMs();
        $timestamp = gmdate('Y-m-d\TH:i:s', intdiv($now, 1000)) . sprintf('.%03dZ', $now % 1000);
        $response = ['success' => true, 'transaction' => Hex::lower($hash), 'network' => $this->cfg->network, 'payer' => $v['payer'], 'amount' => $v['authorization']['value'], 'extra' => ['protocol' => 'mpp', 'method' => Mpp::METHOD, 'intent' => Mpp::INTENT, 'challengeId' => $v['challenge']['id']]];
        return ['ok' => true, 'status' => 200, 'response' => $response, 'headers' => ['Payment-Receipt' => Mpp::receiptHeader(Mpp::receipt($v, $hash, $timestamp))]];
    }

    private function mppFail(array $hold, $detail)
    {
        $this->mppRelease($hold);
        return $this->mppRefuse($hold['resource'], $hold['micro'], new MppException('verification-failed', 'the payment did not settle. Not delivered; nothing was charged. ' . substr((string) $detail, 0, 200)));
    }

    private function mppLost(array $hold, $detail, $sent = false)
    {
        $detail = (string) $detail;
        $tries = $sent && stripos($detail, 'revert') !== false ? self::MPP_USED_TRIES : 1;
        for ($i = 0; $i < $tries; $i++) {
            if ($i > 0) {
                $this->cfg->sleepMs($this->cfg->receiptPollMs);
            }
            try {
                $used = $this->mppUsed($hold['asset'], $hold['verified']);
            } catch (\Throwable $e) {
                break;
            }
            if ($used) {
                return $this->mppRefuse($hold['resource'], $hold['micro'], new MppException('verification-failed', 'this authorization has already been used'));
            }
        }
        return $this->mppFail($hold, $detail);
    }

    public function mppSettle(array $hold)
    {
        $v = $hold['verified'];
        if (!empty($hold['landed'])) {
            if (!$this->cfg->holds->mark($v['replayKey'], 'taken', ['state' => 'delivered', 'at' => $this->cfg->nowMs()])) {
                return $this->mppRefuse($hold['resource'], $hold['micro'], new MppException('verification-failed', 'this authorization is already in use'));
            }
            return $this->mppDelivered($v, $hold['landed']);
        }
        $hash = null;
        $asked = false;
        $notShown = function () use ($hold, $v, &$hash) {
            $this->cfg->holds->mark($v['replayKey'], 'sending', ['state' => 'sent']);
            return $this->mppNotShown($hold['resource'], $hold['micro'], $hash);
        };
        try {
            $call = Mpp::call($v);
            try {
                $this->chain->call($call['to'], $call['data'], $this->cfg->receiver);
            } catch (\Throwable $e) {
                return $this->mppLost($hold, 'the transfer would revert: ' . \ZeamPass\message($e));
            }
            $asked = true;
            $sent = $this->relay->send([$call], $this->cfg->relaySplit());
            $hash = isset($sent[0]['hash']) ? $sent[0]['hash'] : null;
            if ($hash === null) {
                return $this->mppLost($hold, isset($sent[0]['error']) ? $sent[0]['error'] : 'the relay sent nothing', true);
            }
            $hash = Hex::lower($hash);
            $this->cfg->holds->mark($v['replayKey'], null, ['sent' => $hash, 'state' => 'sending', 'at' => $this->cfg->nowMs()]);
            $receipt = $this->waitForReceipt($hash);
            if ($receipt === null) {
                return $notShown();
            }
            if (strtolower(isset($receipt['status']) ? (string) $receipt['status'] : '') !== '0x1') {
                return $this->mppLost($hold, "transaction $hash reverted");
            }
            if (!self::usedIn($receipt, $call['to'], $v)) {
                return $this->mppFail($hold, "transaction $hash did not use this authorization");
            }
            $this->cfg->holds->mark($v['replayKey'], 'sending', ['state' => 'delivered', 'at' => $this->cfg->nowMs()]);
            return $this->mppDelivered($v, $hash);
        } catch (\Throwable $e) {
            return $hash === null ? $this->mppLost($hold, \ZeamPass\message($e), $asked) : $notShown();
        }
    }

    private static function refuse($status, array $body, array $headers = [])
    {
        return ['ok' => false, 'status' => $status, 'body' => $body, 'headers' => $headers];
    }

    public static function channelIdOf(array $payload)
    {
        $raw = isset($payload['payload']) && is_array($payload['payload']) ? $payload['payload'] : [];
        $id = isset($raw['voucher']['channelId']) ? $raw['voucher']['channelId'] : (isset($raw['channelId']) ? $raw['channelId'] : null);
        return is_string($id) && preg_match('/^0x[0-9a-fA-F]{64}$/D', $id) ? strtolower($id) : null;
    }

    public function match(array $accepts, array $payload)
    {
        $version = isset($payload['x402Version']) ? $payload['x402Version'] : null;
        $accepted = isset($payload['accepted']) && is_array($payload['accepted']) ? $payload['accepted'] : null;
        if ($accepted === null) {
            return null;
        }
        foreach ($accepts as $req) {
            if ($version === 2) {
                $reqCore = $req;
                unset($reqCore['extra']);
                $accCore = $accepted;
                unset($accCore['extra']);
                if (Json::deepEqual($reqCore, $accCore) && Json::containsSubset($req['extra'], isset($accepted['extra']) ? $accepted['extra'] : null)) {
                    return $req;
                }
            } elseif ($version === 1) {
                if (isset($accepted['scheme'], $accepted['network']) && $req['scheme'] === $accepted['scheme'] && $req['network'] === $accepted['network']) {
                    return $req;
                }
            }
        }
        return null;
    }

    private static function provisional(array $raw, $charged, $now)
    {
        return [
            'channelId' => $raw['voucher']['channelId'],
            'channelConfig' => $raw['channelConfig'],
            'chargedCumulativeAmount' => (string) $charged,
            'signedMaxClaimable' => Big::strval(Verify::uint($raw['voucher']['maxClaimableAmount'])),
            'signature' => $raw['voucher']['signature'],
            'balance' => '0',
            'totalClaimed' => '0',
            'withdrawRequestedAt' => 0,
            'refundNonce' => 0,
            'lastRequestTimestamp' => $now,
        ];
    }

    private static function inferCharged($signedMax, $price)
    {
        $signed = Verify::uint($signedMax);
        $amount = Verify::uint($price);
        return Big::cmp($signed, $amount) < 0 ? '0' : Big::strval(Big::sub($signed, $amount));
    }

    private static function channelState(array $c, $charged = null)
    {
        $out = [
            'channelId' => $c['channelId'],
            'balance' => $c['balance'],
            'totalClaimed' => $c['totalClaimed'],
            'withdrawRequestedAt' => $c['withdrawRequestedAt'],
            'refundNonce' => (string) $c['refundNonce'],
        ];
        if ($charged !== null) {
            $out['chargedCumulativeAmount'] = (string) $charged;
        }
        return $out;
    }

    public function enrich(array $accepts, $error, array $payload, $snapshot)
    {
        if ($error !== self::MISMATCH) {
            return $accepts;
        }
        $raw = isset($payload['payload']) ? $payload['payload'] : null;
        if (!Verify::isVoucherPayload($raw) && !Verify::isDepositPayload($raw) && !Verify::isRefundPayload($raw)) {
            return $accepts;
        }
        $network = isset($payload['accepted']['network']) ? $payload['accepted']['network'] : null;
        try {
            if (Verify::bindingError($raw['channelConfig'], $raw['voucher']['channelId'], $network)) {
                return $accepts;
            }
            $channel = $snapshot !== null ? $snapshot : $this->store->get(strtolower($raw['voucher']['channelId']));
        } catch (\Throwable $e) {
            return $accepts;
        }
        if ($channel === null) {
            return $accepts;
        }
        foreach ($accepts as $i => $req) {
            if ($req['scheme'] === Config::SCHEME && $req['network'] === $network) {
                $accepts[$i]['extra']['channelState'] = self::channelState($channel, $channel['chargedCumulativeAmount']);
                $voucher = [];
                foreach (['signedMaxClaimable', 'signature'] as $k) {
                    if (isset($channel[$k])) {
                        $voucher[$k] = $channel[$k];
                    }
                }
                $accepts[$i]['extra']['voucherState'] = $voucher === [] ? new \stdClass() : $voucher;
                break;
            }
        }
        return $accepts;
    }

    private static function stateIn(array $accepts)
    {
        foreach ($accepts as $a) {
            if (isset($a['extra']['channelState'])) {
                return $a['extra']['channelState'];
            }
        }
        return null;
    }

    private function fundingRefusal(array $payload, array $accepts, $floor, $price = null)
    {
        $price = $price === null ? $this->cfg->priceMicroUSD : $price;
        $quoted = $this->quotedMicroUSD($payload);
        if ($quoted + 1 < $price) {
            return [
                'error' => 'price_changed', 'code' => 'price_changed', 'quotedMicroUSD' => $quoted, 'neededMicroUSD' => $floor,
                'message' => "the price is $price micro-USD per call. Pay the accepts quote. Nothing was charged.",
                'accepts' => $accepts,
            ];
        }
        $deposit = $this->depositMicroUSD($payload);
        return [
            'error' => 'funding_requires_open_fee', 'code' => 'funding_requires_open_fee',
            'quotedMicroUSD' => $quoted, 'depositMicroUSD' => $deposit, 'neededMicroUSD' => $floor,
            'message' => "deposit $deposit micro-USD is under the $floor micro-USD floor. Deposit at least $floor micro-USD; each call costs up to $quoted micro-USD; the unspent balance is refundable. Nothing was charged.",
            'accepts' => $accepts,
        ];
    }

    private function quotedMicroUSD(array $payload)
    {
        try {
            $acc = isset($payload['accepted']) ? $payload['accepted'] : [];
            $v = $this->cfg->microUSDOf(isset($acc['asset']) ? $acc['asset'] : '', Big::strval(Verify::uint(isset($acc['amount']) ? $acc['amount'] : '0')));
            return $v === null ? 0 : $v;
        } catch (\Throwable $e) {
            return 0;
        }
    }

    private function depositMicroUSD(array $payload)
    {
        try {
            $acc = isset($payload['accepted']) ? $payload['accepted'] : [];
            $amount = isset($payload['payload']['deposit']['amount']) ? $payload['payload']['deposit']['amount'] : '0';
            $v = $this->cfg->microUSDOf(isset($acc['asset']) ? $acc['asset'] : '', Big::strval(Verify::uint($amount)));
            return $v === null ? 0 : $v;
        } catch (\Throwable $e) {
            return 0;
        }
    }

    public function channels()
    {
        return $this->channels;
    }

    public function malformed($paymentHeaderValue, $refundUrl = null)
    {
        $payload = Json::decodeHeader($paymentHeaderValue);
        if ($payload === null) {
            return self::refuse(400, ['error' => 'bad_payment_header', 'message' => 'the payment does not decode. Over HTTP, send base64 of the PaymentPayload JSON in the PAYMENT-SIGNATURE header; over MCP, send the PaymentPayload object in params._meta["x402/payment"].']);
        }
        $raw = isset($payload['payload']) && is_array($payload['payload']) ? $payload['payload'] : null;
        $kind = $raw !== null && isset($raw['type']) ? $raw['type'] : null;
        $batch = (isset($payload['scheme']) && $payload['scheme'] === Config::SCHEME)
            || (isset($payload['accepted']['scheme']) && $payload['accepted']['scheme'] === Config::SCHEME)
            || ($kind !== null && $kind !== '' && $kind !== false && $kind !== 0);
        if ($batch && $kind !== 'voucher' && $kind !== 'deposit') {
            return self::refuse(400, ['error' => 'bad_payment_type', 'message' => 'a paid call carries a voucher or a deposit. Refunds: ' . $this->refundWhere($refundUrl) . '. Nothing was charged.']);
        }
        if ($raw !== null && Verify::normalized($raw) === null) {
            return self::refuse(400, ['error' => 'bad_payment_header', 'message' => Verify::AMOUNT_FORM . '. Nothing was charged.']);
        }
        return null;
    }

    public function verifyAndHold($paymentHeaderValue, $resource, $price = null, $refundUrl = null)
    {
        $micro = $this->micro($price);
        $res = self::resourceInfo($resource);
        $accepts = $this->accepts($micro);
        $bad = $this->malformed($paymentHeaderValue, $refundUrl);
        if ($bad !== null) {
            return $bad;
        }
        $payload = Json::decodeHeader($paymentHeaderValue);
        if (isset($payload['payload']) && is_array($payload['payload']) && Verify::normalized($payload['payload']) !== null) {
            $payload['payload'] = Verify::normalized($payload['payload']);
        }
        $raw = isset($payload['payload']) && is_array($payload['payload']) ? $payload['payload'] : null;
        $kind = $raw !== null && isset($raw['type']) ? $raw['type'] : null;
        $cid = self::channelIdOf($payload);
        $ch = null;
        if ($cid !== null) {
            try {
                $ch = $this->channels->repaired($cid);
            } catch (\Throwable $e) {
                $ch = null;
            }
        }
        if ($ch !== null) {
            if (Channels::held($ch, $this->cfg->nowMs(), true)) {
                $after = $this->channels->judged($cid, true);
                $ch = $after !== null ? $after : $ch;
            }
            $refundAt = $this->cfg->nowMs();
            if (Channels::refundingWaitMs($ch, $refundAt) > 0) {
                $secs = Channels::refundingRetrySecs($this->cfg, $ch, $refundAt);
                return self::refuse(402, ['error' => 'refund_settling', 'code' => 'refund_settling', 'message' => "a refund is settling on this channel, retry in {$secs}s. Nothing was charged.", 'retry_after_seconds' => $secs]);
            }
            if ($this->channels->leaving($ch)) {
                return self::refuse(402, ['error' => 'channel_leaving', 'code' => 'channel_leaving', 'message' => 'this channel is withdrawing. Open a new channel. Nothing was charged.']);
            }
            if (!empty($ch['handedOver'])) {
                return self::refuse(402, [
                    'error' => 'refund_outstanding', 'code' => 'refund_outstanding',
                    'transaction' => isset($ch['handedOver']['transaction']) ? $ch['handedOver']['transaction'] : null,
                    'message' => 'this channel has an unsent signed refund. Send it (transaction here), then deposit again. Nothing was charged.',
                ]);
            }
            if ($kind === 'deposit') {
                $left = Big::init(0);
                $price = Big::init(0);
                try {
                    $left = Big::sub(Channels::n($ch['balance']), Channels::max($ch['chargedCumulativeAmount'], $ch['totalClaimed']));
                    $price = Verify::uint(isset($payload['accepted']['amount']) ? $payload['accepted']['amount'] : '0');
                } catch (\Throwable $e) {
                    $price = Big::init(0);
                }
                if (Big::sign($price) > 0 && Big::cmp($left, $price) >= 0 && $this->quotedMicroUSD($payload) + 1 >= $micro && $this->match($accepts, $payload) !== null) {
                    $enriched = $this->enrich($accepts, self::MISMATCH, $payload, null);
                    if (self::stateIn($enriched) !== null) {
                        $corrected = self::document($res, self::MISMATCH, $enriched);
                        $body = $corrected;
                        $body['code'] = 'payment_invalid';
                        $body['reason'] = 'channel_funded';
                        $body['message'] = 'this channel is funded. Pay with a voucher. Nothing was charged.';
                        $body['channelState'] = self::stateIn($enriched);
                        return self::refuse(402, $body, ['PAYMENT-REQUIRED' => Json::base64($corrected)]);
                    }
                }
            }
        }
        $match = $this->match($accepts, $payload);
        if ($kind === 'deposit') {
            $floor = $this->gas->depositFloorMicroUSD($micro);
            if ($this->quotedMicroUSD($payload) + 1 < $micro || ($match !== null && $this->depositMicroUSD($payload) < $floor)) {
                return self::refuse(402, $this->fundingRefusal($payload, $accepts, $floor, $micro));
            }
        }
        if ($match === null) {
            return self::refuse(402, ['error' => 'no_matching_requirement', 'message' => 'the payment matches no requirement here', 'accepts' => $accepts]);
        }
        $ctx = ['snapshot' => null];
        $verified = $this->verifyPayment($payload, $match, $ctx);
        $judgedBy = $this->cfg->nowMs() + $this->channels->judgeWaitMs();
        for ($again = 0; (isset($verified['invalidReason']) ? $verified['invalidReason'] : null) === Reason::REFUND_SETTLING; $again++) {
            $judged = $this->channels->judged($cid);
            $at = $this->cfg->nowMs();
            if (Channels::refundingWaitMs($judged, $at) > 0 || ($again >= 3 && $at >= $judgedBy)) {
                break;
            }
            $verified = $this->verifyPayment($payload, $match, $ctx);
        }
        if ((isset($verified['invalidReason']) ? $verified['invalidReason'] : null) === Reason::REFUND_SETTLING) {
            $secs = Channels::refundingRetrySecs($this->cfg, $this->channels->get($cid), $this->cfg->nowMs());
            return self::refuse(402, ['error' => 'refund_settling', 'code' => 'refund_settling', 'message' => "a refund is settling on this channel, retry in {$secs}s. Nothing was charged.", 'retry_after_seconds' => $secs]);
        }
        if (!$verified['isValid']) {
            $reason = isset($verified['invalidReason']) ? $verified['invalidReason'] : null;
            $error = preg_match('/exceeds_balance|below_claimed/', (string) $reason) ? self::MISMATCH : $reason;
            $enriched = $this->enrich($accepts, $error, $payload, $ctx['snapshot']);
            $corrected = self::document($res, $error, $enriched);
            $body = ['error' => $error !== null ? $error : 'payment_invalid', 'code' => 'payment_invalid', 'message' => 'the payment did not verify'];
            if ($reason !== null) {
                $body['reason'] = $reason;
            }
            $body['accepts'] = $enriched;
            $state = self::stateIn($enriched);
            if ($state !== null) {
                $body['channelState'] = $state;
            }
            return self::refuse(402, $body, ['PAYMENT-REQUIRED' => Json::base64($corrected)]);
        }
        return [
            'ok' => true,
            'hold' => [
                'kind' => $kind,
                'channelId' => $ctx['channelId'],
                'pendingId' => $ctx['pendingId'],
                'payload' => $payload,
                'requirement' => $match,
                'resource' => $res,
                'payer' => $verified['payer'],
                'micro' => $micro,
            ],
        ];
    }

    const MOVED_TRIES = 2;

    public static function movedSince($seen, $current)
    {
        if ($seen === null || $current === null) {
            return false;
        }
        $at = function ($r, $k) {
            return isset($r[$k]) ? (string) $r[$k] : '';
        };
        return $at($seen, 'refundNonce') !== $at($current, 'refundNonce') || $at($seen, 'balance') !== $at($current, 'balance') || empty($seen['handedOver']) !== empty($current['handedOver']);
    }

    private function serially($channelId, callable $fn)
    {
        return $this->channels->serial($channelId, function () use ($channelId, $fn) {
            return $this->store->update($channelId, $fn);
        });
    }

    public function verifyPayment(array $payload, array $req, array &$ctx, $tries = 0)
    {
        $raw = $payload['payload'];
        $local = null;
        $normMax = null;
        $snapshot = null;
        $now = $this->cfg->nowMs();
        if (Verify::isVoucherPayload($raw) || Verify::isDepositPayload($raw)) {
            try {
                $normMax = Big::strval(Verify::amount($raw['voucher']['maxClaimableAmount']));
            } catch (\Throwable $e) {
                return Verify::invalid(Reason::PAYLOAD_TYPE, null, Verify::AMOUNT_FORM);
            }
            try {
                $bind = Verify::bindingError($raw['channelConfig'], $raw['voucher']['channelId'], $req['network']);
                if ($bind) {
                    return Verify::invalid($bind);
                }
                $cid = strtolower($raw['voucher']['channelId']);
                $snapshot = $this->store->get($cid);
                $charged = $snapshot !== null && isset($snapshot['chargedCumulativeAmount'])
                    ? (string) $snapshot['chargedCumulativeAmount']
                    : self::inferCharged($raw['voucher']['maxClaimableAmount'], $req['amount']);
                $expected = Big::add(Big::init($charged, 10), Verify::uint($req['amount']));
                if (Channels::pendingLive($snapshot, $now)) {
                    return Verify::invalid(Reason::CHANNEL_BUSY);
                }
                if (Big::cmp(Verify::uint($raw['voucher']['maxClaimableAmount']), $expected) !== 0) {
                    $ctx['snapshot'] = $snapshot !== null ? $snapshot : self::provisional($raw, $charged, $now);
                    return Verify::invalid(self::MISMATCH);
                }
                $ctx['snapshot'] = $snapshot;
                $ctx['channelId'] = $cid;
                $ctx['pendingId'] = Hex::fromBin(random_bytes(32));
                if (Verify::isVoucherPayload($raw)) {
                    $local = $this->verify->local($raw, $req, $snapshot, $now);
                }
            } catch (\Throwable $e) {
                return Verify::invalid(Reason::VERIFICATION_STATE_UNAVAILABLE);
            }
        }
        $result = $local !== null ? $local : $this->verify->facilitator($payload, $req);
        if (!$result['isValid'] || empty($result['payer'])) {
            return $result;
        }
        if (!isset($ctx['pendingId'])) {
            return Verify::invalid(Reason::VERIFICATION_STATE_UNAVAILABLE);
        }
        $ex = isset($result['extra']) ? $result['extra'] : [];
        $record = null;
        $outcome = null;
        $pendingId = $ctx['pendingId'];
        $expiresAt = $now + min(self::MAX_PENDING_TTL_MS, max(self::MIN_PENDING_TTL_MS, max(0, (int) $req['maxTimeoutSeconds']) * 1000));
        $isLocal = $local !== null;
        $seen = $snapshot;
        try {
            $this->serially($ctx['channelId'], function ($current) use ($raw, $req, $ex, $now, $pendingId, $expiresAt, $isLocal, $normMax, $seen, &$outcome, &$record) {
                if (Channels::refundingWaitMs($current, $now) > 0) {
                    $outcome = 'refunding';
                    return $current;
                }
                if (Channels::pendingLive($current, $now)) {
                    $outcome = 'busy';
                    return $current;
                }
                if (self::movedSince($seen, $current)) {
                    $outcome = 'moved';
                    $record = $current;
                    return $current;
                }
                $base = $current !== null && isset($current['chargedCumulativeAmount'])
                    ? (string) $current['chargedCumulativeAmount']
                    : self::inferCharged($raw['voucher']['maxClaimableAmount'], $req['amount']);
                $expected = Big::add(Big::init($base, 10), Verify::uint($req['amount']));
                if (Big::cmp(Verify::uint($raw['voucher']['maxClaimableAmount']), $expected) !== 0) {
                    $outcome = 'stale';
                    $record = $current !== null ? $current : self::provisional($raw, $base, $now);
                    return $current;
                }
                $next = [
                    'channelId' => $raw['voucher']['channelId'],
                    'channelConfig' => $raw['channelConfig'],
                    'chargedCumulativeAmount' => $base,
                    'signedMaxClaimable' => $normMax,
                    'signature' => $raw['voucher']['signature'],
                    'balance' => isset($ex['balance']) ? (string) $ex['balance'] : '0',
                    'totalClaimed' => isset($ex['totalClaimed']) ? (string) $ex['totalClaimed'] : '0',
                    'withdrawRequestedAt' => isset($ex['withdrawRequestedAt']) ? (int) $ex['withdrawRequestedAt'] : 0,
                    'refundNonce' => isset($ex['refundNonce']) ? (int) $ex['refundNonce'] : 0,
                ];
                $synced = $isLocal ? ($current !== null && isset($current['onchainSyncedAt']) ? $current['onchainSyncedAt'] : null) : $now;
                if ($synced !== null) {
                    $next['onchainSyncedAt'] = $synced;
                }
                $next['lastRequestTimestamp'] = $now;
                $next['pendingRequest'] = [
                    'pendingId' => $pendingId,
                    'signedMaxClaimable' => $normMax,
                    'expiresAt' => $expiresAt,
                ];
                foreach ($current !== null ? $current : [] as $k => $v) {
                    if (!in_array($k, self::SDK_FIELDS, true)) {
                        $next[$k] = $v;
                    }
                }
                $outcome = 'reserved';
                $record = $next;
                return $next;
            });
        } catch (\Throwable $e) {
            return Verify::invalid(Reason::VERIFICATION_STATE_UNAVAILABLE);
        }
        if ($outcome === 'refunding') {
            return Verify::invalid(Reason::REFUND_SETTLING);
        }
        if ($outcome === 'busy') {
            return Verify::invalid(Reason::CHANNEL_BUSY);
        }
        if ($outcome === 'moved' && $tries < self::MOVED_TRIES) {
            return $this->verifyPayment($payload, $req, $ctx, $tries + 1);
        }
        if ($outcome === 'stale' || $outcome === 'moved') {
            $ctx['snapshot'] = $record;
            return Verify::invalid(self::MISMATCH);
        }
        $ctx['snapshot'] = $record;
        return $result;
    }

    public function release(array $hold)
    {
        return $this->channels->release($hold['channelId'], $hold['pendingId']);
    }

    private function depositShort(array $hold, array $payload, $needed, $micro)
    {
        $this->release($hold);
        return self::refuse(402, $this->fundingRefusal($payload, $this->accepts(isset($hold['micro']) ? $hold['micro'] : null), $needed, $micro));
    }

    private function settleFailed(array $hold, $reason)
    {
        $this->release($hold);
        $accepts = $this->accepts(isset($hold['micro']) ? $hold['micro'] : null);
        $doc = self::document($hold['resource'], 'settle_failed', $accepts);
        return self::refuse(402, [
            'error' => 'settle_failed', 'code' => 'settle_failed',
            'message' => 'the payment did not settle. Not delivered; nothing was charged.',
            'reason' => substr((string) $reason, 0, 200),
            'accepts' => $accepts,
        ], ['PAYMENT-REQUIRED' => Json::base64($doc)]);
    }

    private static function delivered(array $response)
    {
        return ['ok' => true, 'status' => 200, 'response' => $response, 'headers' => ['PAYMENT-RESPONSE' => Json::base64($response)]];
    }

    public static function chargeOf(array $hold, $charge)
    {
        $reserved = Verify::uint($hold['requirement']['amount']);
        if ($charge === null) {
            return $reserved;
        }
        $text = is_int($charge) ? (string) $charge : (is_string($charge) ? trim($charge) : '');
        if (!preg_match('/^-?[0-9]+$/D', $text)) {
            throw new \RangeException(esc_html('a charge of ' . (is_scalar($charge) ? (string) $charge : 'that') . ' is outside 0 to the reserved ' . Big::strval($reserved)));
        }
        $c = Big::init($text, 10);
        if (Big::sign($c) < 0 || Big::cmp($c, $reserved) > 0) {
            throw new \RangeException(esc_html('a charge of ' . Big::strval($c) . ' is outside 0 to the reserved ' . Big::strval($reserved)));
        }
        return $c;
    }

    public static function owe(array &$record, array $hold)
    {
        $ms = $hold['owedMs'] ?? null;
        if (!is_int($ms) || $ms <= 0) {
            return;
        }
        $owed = isset($record['timeOwed']) && is_array($record['timeOwed']) ? $record['timeOwed'] : [];
        $owed[(string) $hold['pendingId']] = $ms;
        $record['timeOwed'] = $owed;
    }

    public static function chargedExtra(array $hold, $charged, array $extra = [])
    {
        $reserved = (string) $hold['requirement']['amount'];
        $extra['chargedAmount'] = Big::strval($charged);
        $extra['reservedAmount'] = $reserved;
        return $extra;
    }

    public function settle(array $hold, $charge = null)
    {
        try {
            $c = self::chargeOf($hold, $charge);
            if ($hold['kind'] === 'voucher') {
                return $this->settleVoucher($hold, $c);
            }
            if ($hold['kind'] === 'deposit') {
                return $this->settleDeposit($hold, $c);
            }
            return $this->settleFailed($hold, Reason::PAYLOAD_TYPE);
        } catch (\Throwable $e) {
            return $this->settleFailed($hold, \ZeamPass\message($e));
        }
    }

    public function settleVoucher(array $hold, $increment = null)
    {
        $req = $hold['requirement'];
        $voucher = $hold['payload']['payload']['voucher'];
        $increment = $increment === null ? Verify::uint($req['amount']) : $increment;
        $cap = Verify::uint($voucher['maxClaimableAmount']);
        $pendingId = $hold['pendingId'];
        $now = $this->cfg->nowMs();
        $outcome = null;
        $previous = null;
        $charged = null;
        $this->serially($hold['channelId'], function ($current) use ($hold, $pendingId, $increment, $cap, $voucher, $now, &$outcome, &$previous, &$charged) {
            if ($current === null) {
                $outcome = 'missing';
                return $current;
            }
            if (!isset($current['pendingRequest']['pendingId']) || $current['pendingRequest']['pendingId'] !== $pendingId) {
                $outcome = 'pending_mismatch';
                return $current;
            }
            $next = Big::add(Big::init((string) $current['chargedCumulativeAmount'], 10), $increment);
            if (Big::cmp($next, $cap) > 0) {
                $outcome = 'cap_exceeded';
                unset($current['pendingRequest']);
                return $current;
            }
            $previous = $current;
            $charged = Big::strval($next);
            $current['chargedCumulativeAmount'] = $charged;
            $current['signedMaxClaimable'] = Big::strval($cap);
            $current['signature'] = $voucher['signature'];
            $current['lastRequestTimestamp'] = $now;
            self::owe($current, $hold);
            unset($current['pendingRequest']);
            $outcome = 'committed';
            return $current;
        });
        if ($outcome === 'missing') {
            return $this->settleFailed($hold, Reason::MISSING_CHANNEL);
        }
        if ($outcome === 'cap_exceeded') {
            return $this->settleFailed($hold, Reason::CHARGE_EXCEEDS_SIGNED_CUMULATIVE);
        }
        if ($outcome !== 'committed') {
            return $this->settleFailed($hold, Reason::CHANNEL_BUSY);
        }
        return self::delivered([
            'success' => true,
            'payer' => strtolower($previous['channelConfig']['payer']),
            'transaction' => '',
            'network' => $req['network'],
            'amount' => '',
            'extra' => self::chargedExtra($hold, $increment, ['channelState' => self::channelState($previous, $charged)]),
        ]);
    }

    public function settleDeposit(array $hold, $increment = null)
    {
        $req = $hold['requirement'];
        $payload = $hold['payload'];
        $raw = $payload['payload'];
        $channelId = $hold['channelId'];
        $increment = $increment === null ? Verify::uint($req['amount']) : $increment;
        $micro = $this->micro(isset($hold['micro']) ? $hold['micro'] : null);
        $this->channels->repaired($channelId);
        $floor = $this->gas->depositFloorMicroUSD($micro);
        $quoted = (int) $this->cfg->microUSDOf($req['asset'], $req['amount']);
        $arriving = (int) $this->cfg->microUSDOf($req['asset'], Big::strval(Verify::uint($raw['deposit']['amount'])));
        if ($quoted + 1 < $micro || $arriving < $floor) {
            return $this->depositShort($hold, $payload, $floor, $micro);
        }
        $verified = $this->verify->facilitator($payload, $req);
        if (!$verified['isValid']) {
            return $this->settleFailed($hold, isset($verified['invalidReason']) ? $verified['invalidReason'] : Reason::PAYLOAD_TYPE);
        }
        $execution = $verified['execution'];
        $amount = Big::strval(Verify::uint($raw['deposit']['amount']));
        $data = BatchSettlement::encodeDeposit($raw['channelConfig'], $amount, $execution['collector'], $execution['collectorData']);
        $sent = $this->relay->send([['to' => BatchSettlement::ESCROW, 'data' => $data]], $this->cfg->relaySplit());
        $hash = isset($sent[0]['hash']) ? $sent[0]['hash'] : null;
        if ($hash === null && preg_match('/below break-even: deposit at least \\$(\d+(?:\.\d+)?)/', isset($sent[0]['error']) ? (string) $sent[0]['error'] : '', $short)) {
            return $this->depositShort($hold, $payload, (int) ceil(((float) $short[1]) * 1e6), $micro);
        }
        try {
            return $this->depositSent($hold, $verified, $amount, $increment, $hash, isset($sent[0]['error']) ? $sent[0]['error'] : null);
        } catch (\Throwable $e) {
            if ($hash === null) {
                throw $e;
            }
            return $this->depositUnsettled($hold, $hash, \ZeamPass\message($e));
        }
    }

    private function depositSent(array $hold, array $verified, $amount, $increment, $hash, $refused)
    {
        $req = $hold['requirement'];
        $raw = $hold['payload']['payload'];
        $channelId = $hold['channelId'];
        $receipt = $hash === null ? null : $this->waitForReceipt($hash);
        if ($receipt !== null && (!isset($receipt['status']) || strtolower((string) $receipt['status']) !== '0x1')) {
            return $this->settleFailed($hold, Reason::DEPOSIT_TRANSACTION_FAILED . ': transaction reverted (receipt status reverted)');
        }
        $ex = $verified['extra'];
        $state = [
            'channelId' => $raw['voucher']['channelId'],
            'balance' => Big::strval(Big::add(Big::init((string) $ex['balance'], 10), Big::init($amount, 10))),
            'totalClaimed' => (string) $ex['totalClaimed'],
            'withdrawRequestedAt' => (int) $ex['withdrawRequestedAt'],
            'refundNonce' => (string) $ex['refundNonce'],
        ];
        $post = $this->depositOnChain($channelId, Big::init($state['balance'], 10));
        if ($receipt === null && $post === null) {
            if ($hash === null) {
                return $this->settleFailed($hold, Reason::DEPOSIT_TRANSACTION_FAILED . ': ' . ($refused !== null ? $refused : 'no hash'));
            }
            return $this->depositUnsettled($hold, $hash, Reason::DEPOSIT_TRANSACTION_FAILED . ": no receipt for $hash");
        }
        if ($post !== null) {
            $state = [
                'channelId' => $raw['voucher']['channelId'],
                'balance' => $post['balance'],
                'totalClaimed' => $post['totalClaimed'],
                'withdrawRequestedAt' => $post['withdrawRequestedAt'],
                'refundNonce' => $post['refundNonce'],
            ];
        }
        $pendingId = $hold['pendingId'];
        $now = $this->cfg->nowMs();
        $record = null;
        $heldBefore = Big::sign(Big::init((string) $ex['balance'], 10)) > 0 || Big::sign(Big::init((string) $ex['totalClaimed'], 10)) > 0;
        $this->serially($channelId, function ($current) use ($hold, $raw, $increment, $state, $pendingId, $now, $heldBefore, &$record) {
            if ($current === null || !isset($current['pendingRequest']['pendingId']) || $current['pendingRequest']['pendingId'] !== $pendingId) {
                return $current;
            }
            $next = [
                'channelId' => $raw['voucher']['channelId'],
                'channelConfig' => $raw['channelConfig'],
                'chargedCumulativeAmount' => Big::strval(Big::add(Big::init((string) $current['chargedCumulativeAmount'], 10), $increment)),
                'signedMaxClaimable' => Big::strval(Verify::uint($raw['voucher']['maxClaimableAmount'])),
                'signature' => $raw['voucher']['signature'],
                'balance' => $state['balance'],
                'totalClaimed' => $state['totalClaimed'],
                'withdrawRequestedAt' => (int) $state['withdrawRequestedAt'],
                'refundNonce' => (int) $state['refundNonce'],
                'onchainSyncedAt' => $now,
                'lastRequestTimestamp' => $now,
            ];
            foreach ($current as $k => $v) {
                if (!in_array($k, self::SDK_FIELDS, true)) {
                    $next[$k] = $v;
                }
            }
            $next['depositsWePaid'] = (isset($current['depositsWePaid']) ? (int) $current['depositsWePaid'] : ($heldBefore ? 1 : 0)) + 1;
            self::owe($next, $hold);
            $record = $next;
            return $next;
        });
        if ($record === null) {
            return $this->depositLate($hold, Reason::CHANNEL_BUSY . ': ' . ($hash === null ? 'the deposit' : "deposit $hash") . ' landed after the hold expired');
        }
        $channelState = $state;
        $channelState['chargedCumulativeAmount'] = $record['chargedCumulativeAmount'];
        $extra = self::chargedExtra($hold, $increment, ['channelState' => $channelState]);
        $response = [
            'success' => true,
            'transaction' => $hash === null ? '' : $hash,
            'network' => $req['network'],
            'payer' => $raw['channelConfig']['payer'],
            'amount' => $raw['deposit']['amount'],
            'extra' => $extra,
        ];
        $response['extra']['depositAmount'] = $response['amount'];
        if ((string) $response['amount'] !== (string) $req['amount']) {
            $response['amount'] = (string) $req['amount'];
        }
        return self::delivered($response);
    }

    private function depositOnChain($channelId, $expected)
    {
        $deadline = $this->cfg->nowMs() + $this->cfg->stateCatchUpMs;
        $reads = (int) ceil($this->cfg->stateCatchUpMs / 150) + 1;
        for ($read = 1; ; $read++) {
            try {
                $post = $this->chain->state($channelId);
            } catch (\Throwable $e) {
                $post = null;
            }
            if ($post !== null && Big::cmp(Big::init($post['balance'], 10), $expected) >= 0) {
                return $post;
            }
            if ($this->cfg->nowMs() >= $deadline || $read >= $reads) {
                return null;
            }
            $this->cfg->sleepMs(150);
        }
    }

    private function depositUnsettled(array $hold, $hash, $reason)
    {
        return $this->depositAnswer($hold, $reason, "the deposit was sent ($hash) and has not landed yet, so this call was not delivered. If it lands, your channel holds it: pay the next call with a voucher.");
    }

    private function depositLate(array $hold, $reason)
    {
        return $this->depositAnswer($hold, $reason, 'the deposit landed in your channel after this call was given up, so this call was not delivered and not charged. Your channel holds the deposit: pay the next call with a voucher.');
    }

    private function depositAnswer(array $hold, $reason, $said)
    {
        $out = $this->settleFailed($hold, $reason);
        $out['body']['message'] = $said;
        return $out;
    }

    private function waitForReceipt($hash)
    {
        $deadline = $this->cfg->nowMs() + 1000 * $this->cfg->receiptTimeoutSecs;
        $reads = (int) ceil(1000 * $this->cfg->receiptTimeoutSecs / max(1, $this->cfg->receiptPollMs)) + 1;
        for ($read = 1; ; $read++) {
            try {
                $r = $this->chain->receipt($hash);
            } catch (\Throwable $e) {
                $r = null;
            }
            if ($r !== null) {
                return $r;
            }
            if ($this->cfg->nowMs() >= $deadline || $read >= $reads) {
                return null;
            }
            $this->cfg->sleepMs($this->cfg->receiptPollMs);
        }
    }
}
