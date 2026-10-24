<?php

namespace ZeamPass\Settlement;

use ZeamPass\Address;
use ZeamPass\BatchSettlement;
use ZeamPass\Big;
use ZeamPass\Hex;
use ZeamPass\Pass;
use ZeamPass\Secp256k1;

class Refunds
{
    const FUTURE_SKEW_MS = 30000;

    private $cfg;
    private $store;
    private $chain;
    private $relay;
    private $gas;
    private $channels;

    public function __construct(Config $cfg, Store $store, ?Chain $chain = null, ?Relay $relay = null)
    {
        $this->cfg = $cfg;
        $this->store = $store;
        $this->chain = $chain ?: new Chain($cfg->rpcUrl);
        $this->relay = $relay ?: new Relay($cfg->relayUrl);
        $this->gas = new GasQuote($cfg, $this->chain, $this->relay);
        $this->channels = new Channels($cfg, $store, $this->chain);
    }

    public static function message($channelId, $issued)
    {
        return Pass::REALM . " refund\nchannel: " . strtolower((string) $channelId) . "\nissued: " . $issued;
    }

    private static function answer($status, array $body)
    {
        return ['status' => $status, 'body' => $body];
    }

    private static function failed($status, $code, $why, array $more = [])
    {
        return self::answer($status, array_merge(['op' => 'refund_failed', 'code' => $code, 'why' => $why], $more));
    }

    public function proofOwner($channelId, $issued, $signature)
    {
        if ($issued === null || (is_string($issued) && trim($issued) === '')) {
            return ['ok' => false, 'why' => 'issued is missing: send the ISO 8601 time you signed, as a string'];
        }
        $t = null;
        if (is_string($issued)) {
            try {
                $d = new \DateTimeImmutable($issued);
                $t = (int) round((float) $d->format('U.u') * 1000);
            } catch (\Throwable $e) {
                $t = null;
            }
        }
        if ($t === null) {
            return ['ok' => false, 'why' => 'issued is not a timestamp'];
        }
        $now = $this->cfg->nowMs();
        $window = 1000 * (int) $this->cfg->refundWindowSecs;
        if ($now - $t > $window || $t - $now > self::FUTURE_SKEW_MS) {
            return ['ok' => false, 'why' => 'issued ' . $issued . ' is outside the ' . (int) $this->cfg->refundWindowSecs . 's window'];
        }
        if (!is_string($signature) || preg_match('/^(0x)?[0-9a-fA-F]{130}$/D', $signature) !== 1) {
            return ['ok' => false, 'why' => 'signature is missing or is not 65 bytes of hex'];
        }
        try {
            $who = Secp256k1::recoverPersonal(self::message($channelId, $issued), $signature);
        } catch (\Throwable $e) {
            return ['ok' => false, 'why' => 'signature does not recover to an address'];
        }
        return ['ok' => true, 'address' => strtolower($who)];
    }

    public static function owns(array $channel, $address)
    {
        $who = strtolower((string) $address);
        if ($who === '') {
            return false;
        }
        $payer = strtolower(isset($channel['channelConfig']['payer']) ? $channel['channelConfig']['payer'] : '');
        $auth = strtolower(isset($channel['channelConfig']['payerAuthorizer']) ? $channel['channelConfig']['payerAuthorizer'] : '');
        return $who === $payer || ($auth !== '' && $who === $auth);
    }

    const SELF_SEND = '{"selfSend": true}';

    public function handle($channelId, $issued, $signature, array $ask = [])
    {
        $cid = strtolower((string) $channelId);
        if (!Verify::isCanonicalChannelId($cid)) {
            return self::failed(400, 'invalid_request', 'channelId is missing or is not 0x and 64 hex characters: send {channelId, issued, signature}');
        }
        $ticket = $this->channels->ticket($cid);
        $answer = $this->answered($cid, $ticket, $issued, $signature, $ask);
        return is_array($ticket) && isset($ticket['turn']) ? $answer + ['turn' => (int) $ticket['turn']] : $answer;
    }

    private function answered($cid, $ticket, $issued, $signature, array $ask)
    {
        try {
            $seen = $this->seen($cid, $issued, $signature, $ask);
            if (isset($seen['answer'])) {
                return $seen['answer'];
            }
            $waited = $this->waited($cid, $ticket, self::askKey($ask), $seen['ch'] !== null ? $seen['ch'] : ['channelId' => $cid]);
            if ($waited !== null) {
                return $waited;
            }
            $out = $this->channels->serial($cid, function () use ($cid, $seen, $ask) {
                $ch = $this->channels->get($cid);
                if ($ch === null) {
                    if ($seen['config'] === null) {
                        return self::failed(404, 'unknown_channel', 'no channel with that id here. For a channel with no calls here, send its channelConfig with the proof.');
                    }
                    $adopted = $this->adopt($cid, $seen['config']);
                    if (isset($adopted['failed'])) {
                        return $adopted['failed'];
                    }
                    $ch = $adopted['channel'];
                } else {
                    $before = $this->sent($ch);
                    if ($before !== null) {
                        return $before;
                    }
                    $fresh = $this->channels->repaired($cid);
                    $ch = $fresh !== null ? $fresh : $ch;
                }
                return $this->markedRefund($ch, $ask);
            });
            $this->channels->untick($cid, $ticket);
            $ticket = null;
            return isset($out['deferred']) ? $this->deferred($out['deferred']) : $out;
        } finally {
            $this->channels->untick($cid, $ticket);
        }
    }

    private function seen($cid, $issued, $signature, array $ask)
    {
        $ch = $this->channels->get($cid);
        $sent = isset($ask['channelConfig']) ? $ask['channelConfig'] : null;
        $own = $sent === null ? null : $this->ownConfig($cid, $sent);
        if (isset($own['mismatch'])) {
            return ['answer' => self::failed(400, 'channel_config_mismatch', $own['why'], ['mismatch' => $own['mismatch']])];
        }
        $config = isset($own['config']) ? $own['config'] : null;
        if ($ch === null && $config === null) {
            return ['answer' => self::failed(404, 'unknown_channel', 'no channel with that id here. For a channel with no calls here, send its channelConfig with the proof.')];
        }
        $proof = $this->proofOwner($cid, $issued, $signature);
        if (!$proof['ok']) {
            return ['answer' => self::failed(400, 'proof_invalid', $proof['why'], ['sign' => self::message($cid, '<ISO8601 within five minutes>')])];
        }
        if (!self::owns($ch !== null ? $ch : ['channelConfig' => $config], $proof['address'])) {
            return ['answer' => self::failed(403, 'not_the_payer', $proof['address'] . ' is not this channel\'s payer')];
        }
        return ['ch' => $ch, 'config' => $config];
    }

    const WORKERS = 4;
    const BUSY_RETRY_SECS = 1;
    const KEPT_WHILE_AHEAD = ['nothing_to_return', 'request_open'];

    private function waited($id, $ticket, $key, array $ch)
    {
        $deadline = $this->cfg->nowMs() + $this->channels->judgeWaitMs();
        for (;;) {
            $earlier = $this->channels->ahead($id, $ticket);
            $r = $this->channels->get($id);
            $now = $this->cfg->nowMs();
            $beyond = count($earlier) >= self::WORKERS;
            if (Channels::refundingWaitMs($r, $now) > 0 && !Channels::judging($r, $now)) {
                $empty = $beyond ? null : $this->emptied($r !== null ? $r : $ch);
                return $empty !== null ? $empty : self::settling(Channels::refundingRetrySecs($this->cfg, $r, $now));
            }
            if ($earlier === []) {
                return null;
            }
            $got = $this->channels->awaitTicket($id, $earlier[0], $beyond ? $deadline : min((int) $earlier[0]['until'], $now + intdiv(Channels::JUDGING_TTL_MS, 2)));
            if ($got === null || ($got === false && $beyond && $this->cfg->nowMs() >= $deadline)) {
                return $this->recorded($id, $key, $ch);
            }
        }
    }

    private function recorded($id, $key, array $ch)
    {
        $r = $this->channels->get($id);
        $now = $this->cfg->nowMs();
        $known = null;
        if (Channels::refundingWaitMs($r, $now) > 0 && !Channels::judging($r, $now)) {
            return self::settling(Channels::refundingRetrySecs($this->cfg, $r, $now));
        }
        $kept = self::kept($r, $key, $now, $this->lineOf($id));
        if ($kept !== null && in_array($kept['body']['code'] ?? null, self::KEPT_WHILE_AHEAD, true)) {
            $known = $kept;
        } elseif (Channels::pendingLive($r, $now)) {
            $known = self::callOpen($r, $now);
        } elseif ($this->cfg->meter !== null && $this->cfg->meter->busy($id)) {
            $known = self::lineBusy();
        } elseif ($r !== null && self::recordEmpty($this->cfg, $r)) {
            $known = $this->emptied($r);
        }
        $known = $known !== null ? $known : self::busy();
        $after = $this->checked($r !== null ? $r : $ch);
        return $after !== null ? $after : $known;
    }

    private static function recordEmpty(Config $cfg, array $r)
    {
        $held = ['balance' => isset($r['balance']) ? $r['balance'] : '0', 'claimed' => isset($r['totalClaimed']) ? $r['totalClaimed'] : '0'];
        return Big::sign(Channels::n(Channels::refundable(Channels::earned($cfg, $r), $held))) <= 0;
    }

    private static function busy()
    {
        return self::failed(503, 'refund_unavailable', 'refund requests on this channel are already being worked out. Nothing was sent for this one. Retry in ' . self::BUSY_RETRY_SECS . 's.', ['retry_after_seconds' => self::BUSY_RETRY_SECS]);
    }

    const SHARED = ['nothing_to_return', 'gas_payment_needed', 'request_open'];
    const VERDICT_MS = 5000;

    public static function verdictOf($r)
    {
        $v = is_array($r) && isset($r['refundVerdict']) && is_array($r['refundVerdict']) ? $r['refundVerdict'] : [];
        return [
            'key' => isset($v['key']) && is_string($v['key']) ? $v['key'] : null,
            'state' => isset($v['state']) && is_string($v['state']) ? $v['state'] : null,
            'line' => isset($v['line']) && is_string($v['line']) ? $v['line'] : null,
            'at' => isset($v['at']) && is_int($v['at']) ? $v['at'] : 0,
            'answer' => isset($v['answer']) && is_array($v['answer']) ? $v['answer'] : null,
        ];
    }

    public static function stateOf($r)
    {
        $r = is_array($r) ? $r : [];
        $at = function ($v) {
            return $v === null ? null : (string) $v;
        };
        $pending = isset($r['pendingRequest']) && is_array($r['pendingRequest']) ? $r['pendingRequest'] : [];
        $handed = isset($r['handedOver']) && is_array($r['handedOver']) ? $r['handedOver'] : [];
        return (string) json_encode([
            $at($r['chargedCumulativeAmount'] ?? null),
            $at($r['balance'] ?? null),
            $at($r['totalClaimed'] ?? null),
            $at($r['signedMaxClaimable'] ?? null),
            $at($r['refundNonce'] ?? null),
            $at($pending['expiresAt'] ?? null),
            $at($handed['nonce'] ?? null),
            $at($r['withdrawRequestedAt'] ?? null),
        ]);
    }

    public static function askKey(array $ask)
    {
        return (string) json_encode([isset($ask['selfSend']) && $ask['selfSend'] === true, $ask['gasPayment'] ?? null]);
    }

    private function markedRefund(array $ch, array $ask)
    {
        $id = strtolower($ch['channelId']);
        $key = self::askKey($ask);
        $before = $this->checked($ch);
        if ($before !== null) {
            return $before;
        }
        $kept = self::kept($this->channels->get($id), $key, $this->cfg->nowMs(), $this->lineOf($id));
        if ($kept !== null) {
            $after = $this->checked($ch);
            return $after !== null ? $after : $kept;
        }
        $holder = '0x' . bin2hex(random_bytes(16));
        try {
            return $this->verdict($ch, $ask, $id, $key, $holder);
        } finally {
            $this->channels->unweigh($id, $holder);
        }
    }

    private function deferred(array $d)
    {
        try {
            $answer = $this->send($d['plan'], $d['holder'], true);
        } finally {
            $this->release($d['id'], $d['holder']);
        }
        return $this->keep($d['id'], $d['key'], $d['state'], $d['line'], $answer);
    }

    const JUDGE_TRIES = 3;

    private function judgedNow(array $ch, array $ask, $id, $holder)
    {
        for ($tries = 1;; $tries++) {
            $judged = $this->judge($ch, $ask, $holder);
            if (!array_key_exists('answer', $judged) || !empty($judged['final'])) {
                return $judged;
            }
            $r = $this->channels->get($id);
            $now = $this->cfg->nowMs();
            if (Channels::pendingLive($r, $now)) {
                return ['state' => self::stateOf($r), 'line' => $this->lineOf($id), 'answer' => self::callOpen($r, $now)];
            }
            if ($r === null || self::stateOf($r) === $judged['state'] || $tries >= self::JUDGE_TRIES) {
                return $judged;
            }
        }
    }

    private function verdict(array $ch, array $ask, $id, $key, $holder)
    {
        $judged = $this->judgedNow($ch, $ask, $id, $holder);
        if (!empty($judged['final'])) {
            return $judged['answer'];
        }
        if (array_key_exists('answer', $judged)) {
            $after = $this->checked($ch);
            return $after !== null ? $after : $this->keep($id, $key, $judged['state'], $judged['line'], $judged['answer']);
        }
        $out = null;
        try {
            $out = $this->underMark($ch, $ask, $judged, $holder);
            if (isset($out['send'])) {
                $other = $this->channels->sending($id, $holder);
                if (isset($other['unavailable'])) {
                    $out = ['state' => $out['state'], 'line' => $out['line'], 'answer' => self::unheld()];
                } elseif ($other !== null) {
                    $out = ['state' => $out['state'], 'line' => $out['line'], 'answer' => self::settling($other['settling'])];
                } else {
                    return ['deferred' => ['plan' => $out['send'], 'holder' => $holder, 'id' => $id, 'key' => $key, 'state' => $out['state'], 'line' => $out['line']]];
                }
            }
        } finally {
            if (!isset($out['send'])) {
                $this->release($id, $holder);
            }
        }
        return $this->keep($id, $key, $out['state'], $out['line'], $out['answer']);
    }

    private function sent(array $ch)
    {
        $r = $this->channels->get($ch['channelId']);
        $now = $this->cfg->nowMs();
        if (Channels::refundingWaitMs($r, $now) === 0 || Channels::judging($r, $now)) {
            return null;
        }
        $empty = $this->emptied($ch);
        return $empty !== null ? $empty : self::settling(Channels::refundingRetrySecs($this->cfg, $r, $now));
    }

    private function checked(array $ch)
    {
        $r = $this->channels->checked(strtolower($ch['channelId']));
        $now = $this->cfg->nowMs();
        if (Channels::refundingWaitMs($r, $now) === 0 || (Channels::judging($r, $now) && !Channels::checking($r, $now))) {
            return null;
        }
        $empty = $this->emptied($ch);
        return $empty !== null ? $empty : self::settling(Channels::refundingRetrySecs($this->cfg, $r, $now));
    }

    public static function kept($r, $key, $now, $line)
    {
        $v = self::verdictOf($r);
        if ($v['answer'] === null || $v['key'] !== $key || $v['state'] !== self::stateOf($r) || $v['line'] !== $line) {
            return null;
        }
        return $now >= $v['at'] && $now - $v['at'] < self::VERDICT_MS ? $v['answer'] : null;
    }

    private function keep($id, $key, $state, $line, array $answer)
    {
        $shared = isset($answer['body']['code']) && in_array($answer['body']['code'], self::SHARED, true);
        try {
            $still = $shared && $this->lineOf($id) === $line;
            $this->channels->update($id, function ($r) use ($still, $key, $state, $line, $answer) {
                if ($r === null) {
                    return null;
                }
                if ($still && self::stateOf($r) === $state) {
                    $r['refundVerdict'] = ['key' => $key, 'state' => $state, 'line' => $line, 'at' => $this->cfg->nowMs(), 'answer' => $answer];
                } elseif (isset($r['refundVerdict'])) {
                    unset($r['refundVerdict']);
                }
                return $r;
            });
        } catch (\Throwable $e) {
        }
        return $answer;
    }

    private function underMark(array $ch, array $ask, array $judged, $holder)
    {
        $id = strtolower($ch['channelId']);
        $meter = $this->cfg->meter;
        if ($meter !== null && !$meter->stop($id)) {
            return ['state' => $judged['state'], 'line' => $this->lineOf($id), 'answer' => self::lineBusy()];
        }
        $plan = $this->unchanged($id, $judged) ? $judged : $this->judge($ch, $ask, $holder);
        return array_key_exists('answer', $plan) ? ['state' => $plan['state'], 'line' => $plan['line'], 'answer' => $plan['answer']] : ['state' => $plan['state'], 'line' => $plan['line'], 'send' => $plan];
    }

    private function lineOf($id)
    {
        $meter = $this->cfg->meter;
        if ($meter === null) {
            return null;
        }
        $s = $meter->status($id);
        return (string) json_encode([$s['metering'] === true, $s['msRemaining'], (bool) $meter->busy($id)]);
    }

    private function unchanged($id, array $judged)
    {
        $raw = $this->channels->get($id);
        if ($raw === null || self::stateOf($raw) !== $judged['state']) {
            return false;
        }
        $now = Channels::earned($this->cfg, $raw);
        return Channels::refundable($now, $judged['live']) === $judged['left'] && !Channels::pendingLive($raw, $this->cfg->nowMs());
    }

    private static function lineBusy()
    {
        return self::failed(409, 'request_open', 'a call is running on this channel\'s line. Retry in ' . self::OPEN_RETRY_SECS . 's.', ['retry_after_seconds' => self::OPEN_RETRY_SECS]);
    }

    private function emptied(array $ch)
    {
        $id = strtolower($ch['channelId']);
        $fresh = $this->channels->get($id);
        $raw = $fresh !== null ? $fresh : $ch;
        try {
            $live = $this->chain->live($id);
        } catch (\Throwable $e) {
            return null;
        }
        return Big::sign(Channels::n(Channels::refundable(Channels::earned($this->cfg, $raw), $live))) <= 0 ? self::nothing() : null;
    }

    private static function nothing()
    {
        return self::failed(409, 'nothing_to_return', 'nothing to return: the channel holds nothing', ['leftMicroUSD' => 0, 'returnedMicroUSD' => 0, 'gasMicroUSD' => 0]);
    }

    private static function callOpen(array $ch, $now)
    {
        $wait = min(self::OPEN_RETRY_SECS, (int) ceil(((int) $ch['pendingRequest']['expiresAt'] - $now) / 1000));
        return self::failed(409, 'request_open', "a paid call is open on this channel. Retry in {$wait}s.", ['retry_after_seconds' => $wait]);
    }

    private static function unheld()
    {
        return self::failed(503, 'refund_unavailable', 'the channel could not be held for the refund right now. Nothing was sent. Retry in ' . self::OPEN_RETRY_SECS . 's.', ['retry_after_seconds' => self::OPEN_RETRY_SECS]);
    }

    private static function settling($secs)
    {
        return self::failed(409, 'refund_settling', "a refund is already settling on this channel. Nothing more was sent. Retry in {$secs}s.", ['retry_after_seconds' => $secs]);
    }

    private function release($id, $holder)
    {
        $this->channels->unmark($id, $holder);
    }

    private function ownConfig($cid, $config)
    {
        $fields = ['mismatch' => 'fields', 'why' => 'channelConfig needs payer, payerAuthorizer, receiver, receiverAuthorizer, token, withdrawDelay and salt, as deposited'];
        if (!is_array($config) || ($config !== [] && array_keys($config) === range(0, count($config) - 1))) {
            return $fields;
        }
        try {
            $id = strtolower(Verify::computeChannelId($config, $this->cfg->network));
        } catch (\Throwable $e) {
            return $fields;
        }
        if ($id !== $cid) {
            return ['mismatch' => 'channelId', 'why' => 'channelConfig hashes to ' . $id . ', not to channelId ' . $cid];
        }
        if (!Address::equals($config['receiver'], $this->cfg->receiver)) {
            return ['mismatch' => 'receiver', 'why' => 'channelConfig receiver is ' . strtolower((string) $config['receiver']) . '; this seller\'s is ' . strtolower((string) $this->cfg->receiver)];
        }
        if (!Address::equals($config['receiverAuthorizer'], $this->cfg->receiverAuthorizer)) {
            return ['mismatch' => 'receiverAuthorizer', 'why' => 'channelConfig receiverAuthorizer is ' . strtolower((string) $config['receiverAuthorizer']) . '; this seller\'s is ' . strtolower((string) $this->cfg->receiverAuthorizer)];
        }
        if ($this->cfg->assetOf($config['token']) === null) {
            return ['mismatch' => 'token', 'why' => 'channelConfig token ' . strtolower((string) $config['token']) . ' is not accepted here'];
        }
        return ['config' => $config];
    }

    private function adopt($cid, array $config)
    {
        try {
            $st = $this->chain->channel($cid);
        } catch (\Throwable $e) {
            return ['failed' => self::failed(409, 'chain_unreadable', 'could not read the channel on chain', ['retry_after_seconds' => self::RETRY_SECS])];
        }
        if (Big::sign(Channels::n($st['balance'])) <= 0) {
            return ['failed' => self::failed(400, 'channel_config_mismatch', 'channelConfig names this seller, but that channel holds no balance on chain: its escrow balance is 0', ['mismatch' => 'balance'])];
        }
        $now = $this->cfg->nowMs();
        $channel = $this->channels->update($cid, function ($r) use ($cid, $config, $st, $now) {
            return $r !== null ? $r : [
                'channelId' => $cid,
                'channelConfig' => $config,
                'chargedCumulativeAmount' => (string) $st['totalClaimed'],
                'balance' => (string) $st['balance'],
                'totalClaimed' => (string) $st['totalClaimed'],
                'withdrawRequestedAt' => 0,
                'refundNonce' => 0,
                'onchainSyncedAt' => $now,
                'lastRequestTimestamp' => 0,
                'adoptedAt' => $now,
            ];
        });
        return ['channel' => $channel];
    }

    const AUTHORIZATION_FIELDS = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'];
    const GAS_PAYMENT_MARGIN_SECS = 30;
    const RETRY_SECS = 60;
    const OPEN_RETRY_SECS = 5;

    public static function ask($body)
    {
        $b = is_array($body) ? $body : [];
        $obj = function ($x) {
            return is_array($x) && ($x === [] || array_keys($x) !== range(0, count($x) - 1)) ? $x : null;
        };
        $scalar = function ($x) {
            if (is_int($x) || is_string($x)) {
                return (string) $x;
            }
            if (is_float($x)) {
                return is_finite($x) && floor($x) === $x && abs($x) < 1e21 ? sprintf('%.0f', $x) : json_encode($x);
            }
            return null;
        };
        $p = $obj(isset($b['gasPayment']) ? $b['gasPayment'] : null);
        $a = $p === null ? null : $obj(isset($p['authorization']) ? $p['authorization'] : null);
        $config = $obj(isset($b['channelConfig']) ? $b['channelConfig'] : null);
        $authorization = null;
        if ($a !== null) {
            $authorization = [];
            foreach (self::AUTHORIZATION_FIELDS as $k) {
                $authorization[$k] = $scalar(isset($a[$k]) ? $a[$k] : null);
            }
        }
        return [
            'selfSend' => (isset($b['selfSend']) && ($b['selfSend'] === true || $b['selfSend'] === 'true')),
            'channelConfig' => $config !== null ? $config : (isset($b['channelConfig']) ? $b['channelConfig'] : null),
            'gasPayment' => $p === null ? null : [
                'authorization' => $authorization,
                'signature' => $scalar(isset($p['signature']) ? $p['signature'] : null),
            ],
        ];
    }

    private function microUSD(array $ch, $units)
    {
        return $this->cfg->microUSDOf($ch['channelConfig']['token'], $units);
    }

    public static function usd($microUSD)
    {
        if (is_int($microUSD) && $microUSD >= 0) {
            return \ZeamPass\Pricing::usd($microUSD);
        }
        $s = rtrim(rtrim(sprintf('%.6f', $microUSD / 1e6), '0'), '.');
        return $s === '' ? '0' : $s;
    }

    private function frozen(array $raw, array $live, array $ch, $left)
    {
        $meter = $this->cfg->meter;
        if ($meter === null) {
            return ['ch' => $ch, 'left' => $left];
        }
        if (!$meter->stop($ch['channelId'])) {
            return ['failed' => self::lineBusy()];
        }
        $line = $this->lineOf(strtolower($ch['channelId']));
        $now = Channels::earned($this->cfg, $raw);
        $rest = Channels::refundable($now, $live);
        if (Big::sign(Channels::n($rest)) <= 0) {
            return ['line' => $line, 'failed' => self::nothing()];
        }
        return ['line' => $line, 'ch' => $now, 'left' => $rest];
    }

    private function judge(array $incoming, array $ask, $holder)
    {
        $id = strtolower($incoming['channelId']);
        $fresh = $this->channels->get($id);
        $raw = $fresh !== null ? $fresh : $incoming;
        $state = self::stateOf($raw);
        $line = $this->lineOf($id);
        $refused = function (array $answer) use ($state, &$line) {
            return ['state' => $state, 'line' => $line, 'answer' => $answer];
        };
        $ch = Channels::earned($this->cfg, $raw);
        try {
            $live = $this->chain->live($id);
        } catch (\Throwable $e) {
            return $refused(self::failed(409, 'chain_unreadable', 'could not read the channel on chain', ['retry_after_seconds' => self::RETRY_SECS]));
        }
        $left = Channels::refundable($ch, $live);
        if (Big::sign(Channels::n($left)) <= 0) {
            return $refused(self::nothing());
        }
        $now = $this->cfg->nowMs();
        if (Channels::pendingLive($ch, $now)) {
            return $refused(self::callOpen($ch, $now));
        }
        if (!$this->channels->weigh($id, $holder)) {
            return $refused(self::unheld());
        }
        $f = $this->frozen($raw, $live, $ch, $left);
        if (array_key_exists('line', $f)) {
            $line = $f['line'];
        }
        if (isset($f['failed'])) {
            return $refused($f['failed']);
        }
        $ch = $f['ch'];
        $left = $f['left'];
        try {
            $nonce = $this->chain->refundNonce($id);
        } catch (\Throwable $e) {
            return $refused(self::failed(409, 'chain_unreadable', 'could not read the refund nonce on chain', ['retry_after_seconds' => self::RETRY_SECS]));
        }
        $plan = ['state' => $state, 'line' => $line, 'live' => $live, 'ch' => $ch, 'left' => $left, 'nonce' => $nonce];
        if (isset($ask['selfSend']) && $ask['selfSend'] === true) {
            return $this->accepted($id, $holder, $plan + ['self' => true]);
        }
        $leftMicroUSD = $this->microUSD($ch, $left);
        try {
            $call = $this->refundCall($ch, $live, $left, $nonce);
        } catch (\Throwable $e) {
            return $refused(self::failed(409, 'refund_error', substr(\ZeamPass\message($e), 0, 160), ['retry_after_seconds' => self::RETRY_SECS, 'leftMicroUSD' => $leftMicroUSD]));
        }
        $gas = $this->refundGas($ch, $live, $call);
        if ($gas === null) {
            return $refused(self::failed(503, 'gas_unpriced', 'refund gas cannot be priced. Retry in 60s, or send ' . self::SELF_SEND . ' for a signed refund to send yourself.', ['retry_after_seconds' => self::RETRY_SECS, 'leftMicroUSD' => $leftMicroUSD]));
        }
        $amounts = ['leftMicroUSD' => $leftMicroUSD, 'returnedMicroUSD' => $leftMicroUSD, 'gasMicroUSD' => $gas['gasMicroUSD'], 'feeMicroUSD' => $gas['feeMicroUSD'], 'coverMicroUSD' => $gas['coverMicroUSD']];
        if ($gas['covered']) {
            return $this->accepted($id, $holder, $plan + ['call' => $call, 'gas' => $gas, 'amounts' => $amounts, 'payment' => null]);
        }
        $asset = $this->cfg->assetOf($ch['channelConfig']['token']);
        $rule = self::rule($this->cfg, $gas);
        if ($asset === null || empty($asset['eip3009'])) {
            return $refused(self::failed(409, 'nothing_to_return', $rule . '; this token has no gasless payment for the $' . self::usd($gas['gasMicroUSD']) . ' refund gas. Send ' . self::SELF_SEND . ' for a signed refund of the full balance, sent from any wallet at your own gas.', array_merge($amounts, ['returnedMicroUSD' => 0], $gas['detail'])));
        }
        if ($gas['gasMicroUSD'] >= $leftMicroUSD) {
            return $refused(self::failed(409, 'nothing_to_return', $rule . '; refund gas $' . self::usd($gas['gasMicroUSD']) . ' >= balance $' . self::usd($leftMicroUSD) . '. Send ' . self::SELF_SEND . ' for a signed refund of the full balance, sent from any wallet at your own gas.', array_merge($amounts, ['returnedMicroUSD' => 0], $gas['detail'])));
        }
        $payTo = $this->gas->gasWallet();
        if ($payTo === null) {
            return $refused(self::failed(503, 'gas_unpriced', 'the relay is unreachable. Retry in 60s, or send ' . self::SELF_SEND . ' for a signed refund to send yourself.', ['retry_after_seconds' => self::RETRY_SECS, 'leftMicroUSD' => $leftMicroUSD]));
        }
        $units = $this->cfg->unitsOfMicroUSD($asset, $gas['gasMicroUSD']);
        $offered = isset($ask['gasPayment']) ? $ask['gasPayment'] : null;
        if ($offered === null) {
            return $refused($this->gasQuote($ch, $asset, $payTo, $units, $amounts, $gas, null));
        }
        $bad = $this->gasPaymentProblem($ch, $asset, $payTo, $this->cfg->unitsOfMicroUSD($asset, $gas['costMicroUSD']), $left, $offered);
        if ($bad !== null) {
            return $refused($this->gasQuote($ch, $asset, $payTo, $units, $amounts, $gas, $bad, strpos($bad, 'sending costs') !== false ? ['requoted' => true, 'sendCostMicroUSD' => $gas['costMicroUSD']] : []));
        }
        return $this->accepted($id, $holder, $plan + ['call' => $call, 'gas' => $gas, 'amounts' => $amounts, 'payment' => ['asset' => $asset, 'payTo' => $payTo, 'authorization' => $offered['authorization'], 'signature' => $offered['signature']]]);
    }

    private function accepted($id, $holder, array $plan)
    {
        $marked = $this->channels->mark($id, $holder, true, true);
        if (isset($marked['unavailable'])) {
            return ['state' => $plan['state'], 'line' => $plan['line'], 'answer' => self::unheld(), 'final' => true];
        }
        if (isset($marked['settling'])) {
            $empty = $this->emptied($plan['ch']);
            return ['state' => $plan['state'], 'line' => $plan['line'], 'answer' => $empty !== null ? $empty : self::settling($marked['settling']), 'final' => true];
        }
        if (isset($marked['open'])) {
            return ['state' => self::stateOf($marked['open']), 'line' => $this->lineOf($id), 'answer' => self::callOpen($marked['open'], $marked['at'])];
        }
        return $plan;
    }

    private function send(array $plan, $holder, $marked = false)
    {
        if (!empty($plan['self'])) {
            $other = $marked ? null : $this->channels->sending(strtolower($plan['ch']['channelId']), $holder);
            if (isset($other['unavailable'])) {
                return self::unheld();
            }
            if ($other !== null) {
                return self::settling($other['settling']);
            }
            return $this->selfSend($plan['ch'], $plan['live'], $plan['left'], $plan['nonce']);
        }
        $ch = $plan['ch'];
        $payment = $plan['payment'];
        if ($payment === null) {
            return $this->sendRefund($ch, $plan['call'], $plan['left'], 0, $plan['amounts'], $holder, $plan['gas']['freeGasUnits'], $marked);
        }
        $pay = ['to' => $payment['asset']['address'], 'data' => BatchSettlement::encodeTransferWithAuthorization($payment['authorization'], $payment['signature'])];
        $bundle = ['to' => BatchSettlement::MULTICALL3, 'data' => BatchSettlement::encodeAggregate3([$plan['call'], $pay])];
        $out = $this->sendRefund($ch, $bundle, $plan['left'], $this->microUSD($ch, $payment['authorization']['value']), $plan['amounts'], $holder, 0, $marked);
        return isset($out['underpaid']) ? $this->requote($ch, $plan['live'], $payment, $plan['amounts'], $plan['gas'], $out['underpaid'], $plan['call']) : $out;
    }

    private function requote(array $ch, array $live, array $payment, array $amounts, array $gas, $sendCost, $call = null)
    {
        $fresh = $this->refundGas($ch, $live, $call);
        if ($fresh === null) {
            $fresh = $gas;
        }
        $quoted = max($fresh['covered'] ? 0 : $fresh['gasMicroUSD'], (int) ceil($sendCost * $this->cfg->gasBuffer));
        $numbers = array_merge($amounts, ['gasMicroUSD' => $quoted, 'feeMicroUSD' => $fresh['feeMicroUSD'], 'coverMicroUSD' => $fresh['coverMicroUSD'], 'sendCostMicroUSD' => $sendCost]);
        $paying = $this->microUSD($ch, $payment['authorization']['value']);
        $moved = $fresh['covered'] || $paying >= $fresh['gasMicroUSD']
            ? 'refund gas rose past the quote margin: sending costs $' . self::usd($sendCost) . ', your payment is $' . self::usd($paying) . '. Nothing was sent'
            : 'your payment, $' . self::usd($paying) . ', is under the quote, $' . self::usd($fresh['gasMicroUSD']) . ', and under what sending costs, $' . self::usd($sendCost) . '. Nothing was sent';
        if ($quoted >= $amounts['leftMicroUSD']) {
            return self::failed(409, 'nothing_to_return', $moved . '; refund gas $' . self::usd($quoted) . ' (margin included) >= balance $' . self::usd($amounts['leftMicroUSD']) . '. Send ' . self::SELF_SEND . ' for a signed refund of the full balance, sent from any wallet at your own gas.', array_merge($numbers, ['returnedMicroUSD' => 0], $fresh['detail']));
        }
        $units = $this->cfg->unitsOfMicroUSD($payment['asset'], $quoted);
        return $this->gasQuote($ch, $payment['asset'], $payment['payTo'], $units, $numbers, $fresh, $moved . '. New quote: that cost + ' . $fresh['detail']['marginPercent'] . '% margin', ['requoted' => true, 'sendCostMicroUSD' => $sendCost]);
    }

    private function selfSend(array $ch, array $live, $left, $nonce)
    {
        if (!empty($ch['handedOver']['transaction']) && (string) $ch['handedOver']['nonce'] === (string) $nonce) {
            return self::answer(200, [
                'op' => 'refund_signed',
                'microUSD' => $this->microUSD($ch, isset($ch['handedOver']['units']) ? $ch['handedOver']['units'] : '0'),
                'transaction' => $ch['handedOver']['transaction'],
                'why' => 'your signed refund is unsent; here it is again',
            ]);
        }
        try {
            $call = $this->refundCall($ch, $live, $left, $nonce);
        } catch (\Throwable $e) {
            return self::failed(409, 'refund_error', substr(\ZeamPass\message($e), 0, 160), ['retry_after_seconds' => self::RETRY_SECS]);
        }
        return $this->handOver($ch, $live, $call, $left, $nonce);
    }

    public function refundGas(array $ch, array $live, $call = null)
    {
        $bundled = self::bundledClaim($ch, $live);
        $alreadyPaid = self::gasCounted($ch, $this->cfg->gas, $this->gas->relayPaid($ch['channelId']));
        $q = $this->gas->refund(Big::sign($bundled) > 0, true, $alreadyPaid);
        if ($q === null) {
            return null;
        }
        $counted = ['alreadyPaid' => $alreadyPaid, 'freeGasUnits' => $this->cfg->gas['refund'] + (Big::sign($bundled) > 0 ? $this->cfg->gas['refundClaim'] : 0)];
        $earned = $this->microUSD($ch, Big::strval(Big::add(Channels::n($live['claimed']), $bundled)));
        $feeMicroUSD = GasQuote::feeMicroUSD($earned, $this->cfg->feeShare);
        $detailOf = function (array $p) {
            return ['gasUnits' => $p['gasUnits'], 'gasUnitsWithMargin' => $p['gasUnitsWithMargin'], 'gasPriceWei' => $p['gasPriceWei'], 'ethUSD' => $p['ethUSD'], 'l1FeeWei' => $p['l1FeeWei'], 'marginPercent' => $p['marginPercent'], 'quotedBy' => $p['quotedBy']];
        };
        if ($feeMicroUSD >= $q['cover']['microUSD']) {
            return ['covered' => true, 'gasMicroUSD' => 0, 'costMicroUSD' => 0, 'feeMicroUSD' => $feeMicroUSD, 'coverMicroUSD' => $q['cover']['microUSD'], 'detail' => $detailOf($q['pay'])] + $counted;
        }
        $pay = $this->gas->relayQuote($call);
        $cover = $q['cover'];
        if ($pay === null) {
            $pay = $q['pay'];
        } else {
            $cover = $this->gas->priced($q['cover']['gasUnits'], $pay['gasPriceWei'], $pay['ethUSD']);
        }
        if ($feeMicroUSD >= $cover['microUSD']) {
            return ['covered' => true, 'gasMicroUSD' => 0, 'costMicroUSD' => 0, 'feeMicroUSD' => $feeMicroUSD, 'coverMicroUSD' => $cover['microUSD'], 'detail' => $detailOf($pay)] + $counted;
        }
        return ['covered' => false, 'gasMicroUSD' => $pay['microUSD'], 'costMicroUSD' => $pay['costMicroUSD'], 'feeMicroUSD' => $feeMicroUSD, 'coverMicroUSD' => $cover['microUSD'], 'detail' => $detailOf($pay)] + $counted;
    }

    public static function gasCounted($ch, array $gas, $relayPaid)
    {
        return max(self::gasAlreadyPaid($ch, $gas), is_int($relayPaid) && $relayPaid > 0 ? $relayPaid : 0);
    }

    public static function gasAlreadyPaid($ch, array $gas)
    {
        $count = function ($v) {
            return is_numeric($v) && $v > 0 ? (int) $v : 0;
        };
        $deposits = is_array($ch) && isset($ch['depositsWePaid']) ? $count($ch['depositsWePaid']) : 0;
        $refunds = is_array($ch) && isset($ch['refundGasWePaid']) ? $count($ch['refundGasWePaid']) : 0;
        return max(0, $deposits - 1) * $gas['deposit'] + $refunds;
    }

    public static function gasOf(array $gasInfo)
    {
        return isset($gasInfo['alreadyPaid']) && $gasInfo['alreadyPaid'] > 0 ? 'its deposit, its refund, the further deposits and earlier refunds ZEAM paid for' : 'its deposit, its refund';
    }

    public static function rule($cfg, array $gasInfo, $pay = null)
    {
        return \ZeamPass\Discovery::refundRule((int) round(($cfg->gasBuffer - 1) * 100), $pay) . ' Our fee is ' . \ZeamPass\Discovery::percent($cfg->feeShare) . '% of what the buyer spent: $' . self::usd($gasInfo['feeMicroUSD']) . ' on this channel, under the $' . self::usd($gasInfo['coverMicroUSD']) . ' of gas it must cover (' . self::gasOf($gasInfo) . ' and the calls not yet settled, the margin included)';
    }

    private function gasPaymentProblem(array $ch, array $asset, $payTo, $units, $left, array $p)
    {
        $a = isset($p['authorization']) ? $p['authorization'] : null;
        $missing = !is_array($a) || !isset($p['signature']) || $p['signature'] === null;
        if (!$missing) {
            foreach (self::AUTHORIZATION_FIELDS as $k) {
                if (!isset($a[$k]) || $a[$k] === null) {
                    $missing = true;
                }
            }
        }
        if ($missing) {
            return 'gasPayment is {authorization: {from, to, value, validAfter, validBefore, nonce}, signature}';
        }
        if (!Address::equals($a['from'], $ch['channelConfig']['payer'])) {
            return 'gasPayment must come from the channel\'s payer';
        }
        if (!Address::equals($a['to'], $payTo)) {
            return 'gasPayment must go to the relay gas wallet ' . $payTo;
        }
        if (!preg_match('/^\d+$/D', $a['value']) || Big::cmp(Channels::n($a['value']), Channels::n($units)) < 0) {
            return 'gasPayment is ' . $a['value'] . '; sending costs ' . $units;
        }
        if (Big::cmp(Channels::n($a['value']), Channels::n($left)) > 0) {
            return 'gasPayment is ' . $a['value'] . ', over the ' . $left . ' refund';
        }
        $nowSecs = Big::init((string) intdiv($this->cfg->nowMs(), 1000), 10);
        if (!preg_match('/^\d+$/D', $a['validAfter']) || Big::cmp(Channels::n($a['validAfter']), $nowSecs) > 0) {
            return 'gasPayment is not valid yet';
        }
        if (!preg_match('/^\d+$/D', $a['validBefore']) || Big::cmp(Channels::n($a['validBefore']), Big::add($nowSecs, Big::init(self::GAS_PAYMENT_MARGIN_SECS))) < 0) {
            return 'gasPayment expires too soon';
        }
        if (!Hex::isHex($a['nonce'], 32)) {
            return 'gasPayment nonce is not 32 bytes';
        }
        try {
            $signer = Secp256k1::isCanonical($p['signature']) ? Secp256k1::recoverHash(BatchSettlement::transferAuthorizationDigest(self::tokenDomain($this->cfg, $asset), $a), $p['signature']) : null;
        } catch (\Throwable $e) {
            $signer = null;
        }
        if ($signer === null || !Address::equals($signer, $a['from'])) {
            return 'gasPayment signature is not the payer\'s';
        }
        return null;
    }

    public static function tokenDomain(Config $cfg, array $asset)
    {
        return BatchSettlement::tokenDomain($asset['address'], $asset['name'], $asset['version'] !== null ? $asset['version'] : '1', $cfg->chainId);
    }

    private function gasQuote(array $ch, array $asset, $payTo, $units, array $amounts, array $gasInfo, $why, array $extra = [])
    {
        $nowSecs = intdiv($this->cfg->nowMs(), 1000);
        $secs = (int) $this->cfg->gasPaymentSecs;
        $authorization = [
            'from' => Address::checksum($ch['channelConfig']['payer']),
            'to' => Address::checksum($payTo),
            'value' => (string) $units,
            'validAfter' => '0',
            'validBefore' => (string) ($nowSecs + $secs),
            'nonce' => '0x' . bin2hex(random_bytes(32)),
        ];
        $gas = $this->microUSD($ch, $units);
        $d = $gasInfo['detail'];
        $lead = $why === null ? '' : $why . '. ';
        $amounts['gasMicroUSD'] = $gas;
        return self::answer(409, array_merge([
            'op' => 'refund_quote',
            'code' => 'gas_payment_needed',
            'why' => $lead . self::rule($this->cfg, $gasInfo, $d['marginPercent']) . '. Refund gas: $' . self::usd($gas) . ' USDC, no ETH (' . $d['gasUnits'] . ' gas, L1 fee ' . $d['l1FeeWei'] . ' wei, ' . $d['gasPriceWei'] . ' wei per gas, $' . Json::encode($d['ethUSD']) . ' per ETH, ' . $d['marginPercent'] . '% margin; ' . ($d['quotedBy'] === 'relay' ? 'priced by the relay' : 'priced from measured refunds') . '). Sign authorization (EIP-3009 TransferWithAuthorization; typed data in sign) and POST again with gasPayment: {authorization, signature} within ' . $secs . 's. The refund of $' . self::usd($amounts['leftMicroUSD']) . ' and the gas payment go in one transaction: $' . self::usd($amounts['leftMicroUSD'] - $gas) . ' net to you. Or send ' . self::SELF_SEND . ' for a signed refund of the full balance, sent from any wallet at your own gas.',
        ], $amounts, $d, $extra, [
            'payTo' => $authorization['to'],
            'authorization' => $authorization,
            'sign' => BatchSettlement::transferAuthorizationTypedData(self::tokenDomain($this->cfg, $asset), $authorization),
        ]));
    }

    public static function bundledClaim(array $ch, array $live)
    {
        $charged = Channels::n(isset($ch['chargedCumulativeAmount']) ? $ch['chargedCumulativeAmount'] : '0');
        if (Big::cmp($charged, Channels::n($live['claimed'])) <= 0 || empty($ch['signature']) || empty($ch['signedMaxClaimable'])) {
            return Big::init(0);
        }
        return Big::sub($charged, Channels::n($live['claimed']));
    }

    public function refundCall(array $ch, array $live, $left, $nonce)
    {
        $id = strtolower($ch['channelId']);
        $refundSig = BatchSettlement::signRefund($this->cfg->signingKey(), $id, $left, $nonce, $this->cfg->chainId);
        $refund = BatchSettlement::encodeRefundWithSignature($ch['channelConfig'], $left, $nonce, $refundSig);
        if (Big::sign(self::bundledClaim($ch, $live)) <= 0) {
            return ['to' => BatchSettlement::ESCROW, 'data' => $refund];
        }
        $claims = [Channels::claimEntry($ch)];
        $claimSig = BatchSettlement::signClaimBatch($this->cfg->signingKey(), $claims, $this->cfg->chainId);
        return [
            'to' => BatchSettlement::ESCROW,
            'data' => BatchSettlement::encodeMulticall([BatchSettlement::encodeClaimWithSignature($claims, $claimSig), $refund]),
        ];
    }

    private function sendRefund(array $ch, array $call, $left, $gasMicroUSD, array $amounts, $holder, $freeGasUnits = 0, $marked = false)
    {
        $id = strtolower($ch['channelId']);
        $other = $marked ? null : $this->channels->sending($id, $holder);
        if (isset($other['unavailable'])) {
            return self::unheld();
        }
        if ($other !== null) {
            return self::settling($other['settling']);
        }
        return $this->sendRefundNow($ch, $call, $left, $gasMicroUSD, $amounts, $freeGasUnits);
    }

    private function sendRefundNow(array $ch, array $call, $left, $gasMicroUSD, array $amounts = [], $freeGasUnits = 0)
    {
        $id = strtolower($ch['channelId']);
        $sent = $this->relay->send([$call], $this->cfg->relaySplit());
        if (!isset($sent[0]['hash'])) {
            $error = isset($sent[0]['error']) ? (string) $sent[0]['error'] : 'the relay did not send the refund';
            $numbers = [
                'leftMicroUSD' => isset($amounts['leftMicroUSD']) ? $amounts['leftMicroUSD'] : null,
                'gasMicroUSD' => $gasMicroUSD,
                'feeMicroUSD' => isset($amounts['feeMicroUSD']) ? $amounts['feeMicroUSD'] : null,
                'coverMicroUSD' => isset($amounts['coverMicroUSD']) ? $amounts['coverMicroUSD'] : null,
            ];
            if ($gasMicroUSD > 0 && isset($sent[0]['code']) && $sent[0]['code'] === 'underpaid') {
                return ['underpaid' => max(1, isset($sent[0]['gasMicroUSD']) ? (int) $sent[0]['gasMicroUSD'] : 0)];
            }
            return self::failed(409, 'refund_error', substr($error, 0, 160), array_merge(['retry_after_seconds' => self::RETRY_SECS], $numbers));
        }
        $after = null;
        for ($i = 0; $i < max(1, (int) $this->cfg->drainTries); $i++) {
            try {
                $after = $this->chain->live($id);
            } catch (\Throwable $e) {
                $after = null;
            }
            if ($after !== null && Big::cmp(Channels::n($after['balance']), Channels::n($after['claimed'])) <= 0) {
                break;
            }
            if ($i + 1 < (int) $this->cfg->drainTries) {
                $this->cfg->sleepMs($this->cfg->drainWaitMs);
            }
        }
        $drained = $after !== null && Big::cmp(Channels::n($after['balance']), Channels::n($after['claimed'])) <= 0;
        $state = null;
        $gasTable = $this->cfg->gas;
        $readAt = $this->cfg->nowMs();
        $this->channels->update($id, function ($r) use ($after, $ch, $gasMicroUSD, $freeGasUnits, $gasTable, $readAt) {
            if ($r === null) {
                return null;
            }
            if ($gasMicroUSD === 0 && $freeGasUnits > 0) {
                $r['refundGasWePaid'] = self::gasAlreadyPaid(['refundGasWePaid' => isset($r['refundGasWePaid']) ? $r['refundGasWePaid'] : 0], $gasTable) + $freeGasUnits;
            }
            if ($after === null && Big::cmp(Channels::n(isset($ch['chargedCumulativeAmount']) ? $ch['chargedCumulativeAmount'] : '0'), Channels::n(isset($r['chargedCumulativeAmount']) ? $r['chargedCumulativeAmount'] : '0')) < 0) {
                $r['chargedCumulativeAmount'] = $ch['chargedCumulativeAmount'];
            }
            if ($after !== null) {
                $r['balance'] = $after['balance'];
                $r['repairedAt'] = $readAt;
                $r['totalClaimed'] = $after['claimed'];
                $r['chargedCumulativeAmount'] = $after['claimed'];
                $r['refundNonce'] = (int) (isset($r['refundNonce']) ? $r['refundNonce'] : 0) + 1;
                unset($r['signedMaxClaimable'], $r['signature'], $r['pendingRequest'], $r['handedOver']);
            }
            return $r;
        });
        if ($after !== null) {
            $state = ['channelId' => $id, 'balance' => $after['balance'], 'totalClaimed' => $after['claimed'], 'chargedCumulativeAmount' => $after['claimed']];
        }
        $timeMs = $this->cfg->meter !== null ? $this->cfg->meter->forget($id) : 0;
        $returned = $this->microUSD($ch, $left);
        $body = ['op' => 'refunded', 'microUSD' => $returned, 'returnedMicroUSD' => $returned, 'gasMicroUSD' => $gasMicroUSD, 'transaction' => $sent[0]['hash'], 'drained' => $drained];
        if ($timeMs > 0) {
            $body['timeReturnedMs'] = $timeMs;
        }
        $body['why'] = $gasMicroUSD > 0
            ? 'refund $' . self::usd($returned) . ' and your gas payment $' . self::usd($gasMicroUSD) . ' sent in one transaction: $' . self::usd($returned - $gasMicroUSD) . ' net to you'
            : 'refund $' . self::usd($returned) . ' sent; ZEAM paid the gas';
        if ($state !== null) {
            $body['channelState'] = $state;
        }
        return self::answer(200, $body);
    }

    private function handOver(array $ch, array $live, array $call, $left, $nonce)
    {
        $id = strtolower($ch['channelId']);
        $now = $this->cfg->nowMs();
        $transaction = ['chainId' => $this->cfg->chainId, 'to' => Address::checksum($call['to']), 'data' => $call['data'], 'value' => '0'];
        $before = null;
        $earned = isset($ch['chargedCumulativeAmount']) ? (string) $ch['chargedCumulativeAmount'] : '0';
        try {
            $this->channels->update($id, function ($r) use ($left, $live, $nonce, $now, $transaction, $earned, &$before) {
                if ($r === null) {
                    return null;
                }
                if (Big::cmp(Channels::n($earned), Channels::n(isset($r['chargedCumulativeAmount']) ? $r['chargedCumulativeAmount'] : '0')) < 0) {
                    $r['chargedCumulativeAmount'] = $earned;
                }
                $before = isset($r['balance']) ? $r['balance'] : '0';
                $rest = Big::sub(Channels::n($before), Channels::n($left));
                $r['balance'] = Big::sign($rest) > 0 ? Big::strval($rest) : '0';
                $r['handedOver'] = [
                    'units' => (string) $left,
                    'chainBalance' => (string) $live['balance'],
                    'nonce' => (string) $nonce,
                    'at' => $now,
                    'transaction' => $transaction,
                ];
                return $r;
            });
        } catch (\Throwable $e) {
            return self::failed(409, 'refund_error', substr(\ZeamPass\message($e), 0, 160), ['retry_after_seconds' => self::RETRY_SECS]);
        }
        $timeMs = $this->cfg->meter !== null ? $this->cfg->meter->forget($id) : 0;
        $body = [
            'op' => 'refund_signed',
            'microUSD' => $this->microUSD($ch, $left),
            'transaction' => $transaction,
            'why' => 'signed refund of the full balance; send it from any wallet at your own gas',
        ];
        if ($timeMs > 0) {
            $body['timeReturnedMs'] = $timeMs;
        }
        return self::answer(200, $body);
    }
}
