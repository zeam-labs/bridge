<?php

if (!defined('ABSPATH')) {
    exit;
}

use ZeamPass\Address;
use ZeamPass\BatchSettlement;
use ZeamPass\Big;
use ZeamPass\Core;
use ZeamPass\FreeLimit;
use ZeamPass\Pricing;
use ZeamPass\Pass;
use ZeamPass\Rpc;
use ZeamPass\Gate\Admission;
use ZeamPass\Gate\Credits;
use ZeamPass\Gate\Exact;
use ZeamPass\Gate\Meter;
use ZeamPass\Settlement\Chain;
use ZeamPass\Settlement\Channels;
use ZeamPass\Settlement\Claims;
use ZeamPass\Settlement\Config;
use ZeamPass\Settlement\GasQuote;
use ZeamPass\Settlement\Payout;
use ZeamPass\Settlement\Refunds;
use ZeamPass\Settlement\Relay;
use ZeamPass\Settlement\Server;
use ZeamPass\Settlement\Withdrawals;

const ZEAM_PASS_DEFAULT_FEE_RECIPIENT = '0xc60996007B7657DE2F39fA0577E97d7aAF3b7d1e';
const ZEAM_PASS_DEFAULT_CREDIT_ISSUER = '0x4202d8042d89cbEFD9D48fE7f7Aa70061CC9Df22';
const ZEAM_PASS_DEFAULT_RELAY = 'https://api.zeampass.com/relay';
const ZEAM_PASS_DEFAULT_CREDITS = 'https://api.zeampass.com/credits';
const ZEAM_PASS_DEFAULT_RPC = 'https://mainnet.base.org';
const ZEAM_PASS_MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZEAM_PASS_MODES = ['paywall', 'gate', 'both'];
const ZEAM_PASS_CALL_KEPT_MS = 86400000;
const ZEAM_PASS_BAD_GRANT_HOW = 'Send a new x-grant: signed by an admitted key, delegate = the key that signs this call. ZEAM Pass agent guide, section 3.';
const ZEAM_PASS_GRANTED_BY = 'X-Pass-Granted-By';

function zeam_pass_contact_valid($value)
{
    return is_string($value) && (bool) preg_match('~^(?:https?://[^\s/?#]+\S*|mailto:[^\s@]+@[^\s@]+)$~iD', $value);
}

function zeam_pass_contact()
{
    $v = trim((string) zeam_pass_opt('contact', ''));
    return zeam_pass_contact_valid($v) ? $v : home_url('/');
}

function zeam_pass_refused_how()
{
    return 'Ask this seller to admit your key (' . zeam_pass_contact() . '), or send an x-grant signed by an admitted key. ZEAM Pass agent guide, section 3.';
}

function zeam_pass_mode()
{
    $mode = (string) zeam_pass_opt('mode', 'paywall');
    return in_array($mode, ZEAM_PASS_MODES, true) ? $mode : 'paywall';
}

function zeam_pass_paid_mode()
{
    return zeam_pass_mode() !== 'gate';
}

function zeam_pass_settles()
{
    if (zeam_pass_paid_mode()) {
        return true;
    }
    if (zeam_pass_secret_state('settle') === 'missing') {
        return false;
    }
    return ZeamPassChannelStore::any();
}

function zeam_pass_gated_mode()
{
    return zeam_pass_mode() !== 'paywall';
}

function zeam_pass_fee_recipient()
{
    return ZEAM_PASS_DEFAULT_FEE_RECIPIENT;
}

function zeam_pass_payout_is_fee_recipient()
{
    return zeam_pass_defined('PAYOUT_IS_FEE_RECIPIENT') === true;
}

function zeam_pass_credit_issuer()
{
    return ZEAM_PASS_DEFAULT_CREDIT_ISSUER;
}

function zeam_pass_url_opt($key, $default)
{
    $v = trim((string) zeam_pass_opt($key, ''));
    return preg_match('#^https?://#i', $v) ? untrailingslashit($v) : $default;
}

function zeam_pass_relay_url()
{
    return zeam_pass_url_opt('relay', ZEAM_PASS_DEFAULT_RELAY);
}

function zeam_pass_credits_url()
{
    return zeam_pass_url_opt('credits', ZEAM_PASS_DEFAULT_CREDITS);
}

function zeam_pass_rpc_url()
{
    return zeam_pass_url_opt('rpc', ZEAM_PASS_DEFAULT_RPC);
}

function zeam_pass_default_name()
{
    $name = preg_replace('/[^a-z0-9-]/', '', strtolower(sanitize_title(get_bloginfo('name'))));
    $name = preg_replace('/^[^a-z]+/', '', (string) $name);
    $name = substr((string) $name, 0, 32);
    return preg_match('/^[a-z][a-z0-9-]{1,31}$/D', $name) ? $name : 'site-' . substr(md5(home_url('/')), 0, 8);
}

function zeam_pass_name()
{
    $name = (string) zeam_pass_opt('name', '');
    return preg_match('/^[a-z][a-z0-9-]{1,31}$/D', $name) ? $name : zeam_pass_default_name();
}

function zeam_pass_payout()
{
    $payout = (string) zeam_pass_opt('payout', '');
    return preg_match('/^0x[0-9a-fA-F]{40}$/D', $payout) ? $payout : '';
}

function zeam_pass_usd_micro($price)
{
    $price = trim((string) $price);
    if (!preg_match('/^\d+(\.\d{1,6})?$/D', $price)) {
        return 0;
    }
    try {
        return \ZeamPass\Pricing::microOf($price);
    } catch (\InvalidArgumentException $e) {
        return 0;
    }
}

function zeam_pass_price_micro()
{
    return zeam_pass_usd_micro(zeam_pass_opt('price', ''));
}

function zeam_pass_admit_list()
{
    $out = [];
    foreach ((array) zeam_pass_opt('admit', []) as $a) {
        if (is_string($a) && preg_match('/^0x[0-9a-fA-F]{40}$/D', $a)) {
            $out[] = strtolower($a);
        }
    }
    return array_values(array_unique($out));
}

function zeam_pass_on_empty()
{
    return zeam_pass_opt('onEmpty', 'refuse') === 'allow' ? 'allow' : 'refuse';
}

function zeam_pass_missing_extensions()
{
    $missing = Core::missing();
    if (!function_exists('sodium_crypto_secretbox')) {
        $missing[] = 'the PHP sodium extension is not loaded';
    }
    return $missing;
}

function zeam_pass_blockers()
{
    $out = zeam_pass_missing_extensions();
    if ($out !== []) {
        return $out;
    }
    if (zeam_pass_payout() === '') {
        $out[] = 'no wallet is connected';
    } elseif ((strtolower(zeam_pass_payout()) === strtolower(zeam_pass_fee_recipient())) !== zeam_pass_payout_is_fee_recipient()) {
        $out[] = zeam_pass_payout_is_fee_recipient() ? 'ZEAM_BRIDGE_PAYOUT_IS_FEE_RECIPIENT needs the wallet to be the fee recipient' : 'the wallet is the fee recipient; define ZEAM_BRIDGE_PAYOUT_IS_FEE_RECIPIENT as true to pay it 100%';
    }
    if (zeam_pass_paid_mode() && zeam_pass_price_micro() < 1) {
        $out[] = 'no price per call is set';
    }
    if (zeam_pass_settles()) {
        $state = zeam_pass_secret_state('settle');
        if ($state === 'missing') {
            $out[] = 'the settle key has not been generated';
        } elseif ($state === 'locked') {
            $out[] = 'the settle key cannot be decrypted: restore ' . zeam_pass_locked_restore('settle');
        }
    }
    return $out;
}

function zeam_pass_ready()
{
    return zeam_pass_blockers() === [];
}

function zeam_pass_seller_split()
{
    $payout = zeam_pass_payout();
    if ($payout === '' || !Core::ready()) {
        return null;
    }
    try {
        return Pass::sellerSplit($payout, zeam_pass_fee_recipient(), zeam_pass_name(), zeam_pass_payout_is_fee_recipient());
    } catch (\Throwable $e) {
        return null;
    }
}

function zeam_pass_engine($fresh = false)
{
    static $engine = null;
    if ($engine !== null && !$fresh) {
        return $engine;
    }
    $blockers = zeam_pass_blockers();
    if ($blockers !== [] || !zeam_pass_settles()) {
        throw new RuntimeException(esc_html($blockers !== [] ? implode('; ', $blockers) : 'this site has no paid calls to settle'));
    }
    $cfg = new Config([
        'name' => zeam_pass_name(),
        'site' => home_url('/'),
        'priceMicroUSD' => max(1, zeam_pass_price_micro()),
        'payout' => zeam_pass_payout(),
        'feeRecipient' => zeam_pass_fee_recipient(),
        'payoutIsFeeRecipient' => zeam_pass_payout_is_fee_recipient(),
        'receiverAuthorizerKey' => zeam_pass_secret('settle'),
        'relayUrl' => zeam_pass_relay_url(),
        'rpcUrl' => zeam_pass_rpc_url(),
        'refundUrl' => rest_url(ZEAM_PASS_NS . '/refund'),
        'cache' => new ZeamPassCache(),
        'holds' => new ZeamPassHolds(),
        'meter' => zeam_pass_time_meter(),
    ]);
    $store = new ZeamPassChannelStore();
    $chain = new Chain(zeam_pass_rpc_url());
    $relay = new Relay($cfg->relayUrl, null, 120);
    $engine = [
        'cfg' => $cfg,
        'store' => $store,
        'chain' => $chain,
        'relay' => $relay,
        'server' => new Server($cfg, $store, $chain, $relay),
    ];
    return $engine;
}

function zeam_pass_gate_parts()
{
    static $gate = null;
    if ($gate !== null) {
        return $gate;
    }
    $store = new ZeamPassGateStore();
    $meter = new Meter($store, zeam_pass_name(), ['onEmpty' => zeam_pass_on_empty()]);
    $gate = [
        'store' => $store,
        'admission' => new Admission(zeam_pass_payout(), $store),
        'meter' => $meter,
        'credits' => new Credits($meter, zeam_pass_credit_issuer()),
    ];
    return $gate;
}

function zeam_pass_resource($tool, $url)
{
    $tools = zeam_pass_tools();
    return ['url' => (string) $url, 'description' => isset($tools[$tool]) ? (string) $tools[$tool]['description'] : '', 'mimeType' => 'application/json'];
}

function zeam_pass_as_array($value)
{
    $decoded = json_decode(wp_json_encode($value), true);
    return is_array($decoded) ? $decoded : [];
}

function zeam_pass_payer_of(array $payload)
{
    $cfg = isset($payload['payload']['channelConfig']) && is_array($payload['payload']['channelConfig']) ? $payload['payload']['channelConfig'] : [];
    $auth = isset($cfg['payerAuthorizer']) && is_string($cfg['payerAuthorizer']) ? $cfg['payerAuthorizer'] : '';
    if (preg_match('/^0x[0-9a-fA-F]{40}$/D', $auth) && !preg_match('/^0x0{40}$/D', $auth)) {
        return strtolower($auth);
    }
    $payer = isset($cfg['payer']) && is_string($cfg['payer']) ? $cfg['payer'] : '';
    if (preg_match('/^0x[0-9a-fA-F]{40}$/D', $payer)) {
        return strtolower($payer);
    }
    $from = isset($payload['payload']['authorization']['from']) && is_string($payload['payload']['authorization']['from']) ? $payload['payload']['authorization']['from'] : '';
    return preg_match('/^0x[0-9a-fA-F]{40}$/D', $from) ? strtolower($from) : null;
}

function zeam_pass_channels()
{
    try {
        return zeam_pass_engine()['server']->channels();
    } catch (Throwable $e) {
        return new \ZeamPass\Settlement\Channels(null, new ZeamPassChannelStore());
    }
}

function zeam_pass_admits_payer($who, $grantHeader, $tool)
{
    if ($who === null) {
        return ['ok' => false, 'code' => 'refused', 'why' => 'the payment names no payer'];
    }
    $list = zeam_pass_admit_list();
    if (!is_string($grantHeader) || $grantHeader === '') {
        return in_array($who, $list, true) ? ['ok' => true, 'root' => $who] : ['ok' => false, 'code' => 'refused', 'why' => "{$who} is not admitted"];
    }
    $a = zeam_pass_gate_parts()['admission']->grant($who, $grantHeader, $tool, $list, zeam_pass_now_ms());
    return $a['ok'] ? ['ok' => true, 'root' => strtolower((string) $a['root'])] : $a;
}

function zeam_pass_tool_failed($out, $tool)
{
    $data = $out->get_error_data();
    $fields = is_array($data) ? $data : [];
    $given = isset($fields['status']) && is_numeric($fields['status']) ? (int) $fields['status'] : null;
    $status = is_int($given) && $given >= 400 && $given <= 599 && $given !== 402 ? $given : 500;
    unset($fields['status']);
    $wait = $fields['retry_after_seconds'] ?? null;
    return zeam_pass_refusal($status, ['error' => $out->get_error_code(), 'message' => $out->get_error_message(), 'tool' => $tool] + $fields, is_int($wait) && $wait > 0 ? ['Retry-After' => (string) $wait] : []);
}

function zeam_pass_free_take($tool, $who)
{
    $limit = zeam_pass_free_limit();
    if ($limit === null) {
        return ['ok' => true];
    }
    $free = new FreeLimit($limit, 'zeam_pass_now_ms', new ZeamPassCache());
    $take = function () use ($free, $tool, $who) {
        return $free->take($tool, $who);
    };
    try {
        return ZeamPassLock::with('free', $take, 5);
    } catch (\Throwable $e) {
        return $take();
    }
}

function zeam_pass_serve_free($tool, array $args, $who)
{
    $take = zeam_pass_free_take($tool, $who);
    if (!$take['ok']) {
        return zeam_pass_refusal(429, FreeLimit::refusal(zeam_pass_free_limit(), $take['retryAfter']), ['Retry-After' => (string) $take['retryAfter']]);
    }
    $out = zeam_pass_run_safely($tool, $args, new ZeamPassMeter());
    if (is_wp_error($out)) {
        return zeam_pass_tool_failed($out, $tool);
    }
    return ['delivered' => true, 'status' => 200, 'headers' => [], 'body' => $out];
}

function zeam_pass_charge_units(array $e, array $hold, $price, $units)
{
    if (!is_array($price) || !isset($price['unitMicro']) || $price['unitMicro'] === null) {
        return null;
    }
    $micro = Pricing::charge($price, $units);
    return $micro === 0 ? '0' : $e['cfg']->unitsOfMicroUSD($e['cfg']->assetOf($hold['requirement']['asset']), $micro);
}

function zeam_pass_bad_grant($server, $resource, $why, $price, array $listing, $extensions)
{
    $q = $server->paymentRequired($resource, $extensions, null, ['admission' => 'Only admitted keys pay here, or keys with an x-grant from an admitted key.', 'contact' => zeam_pass_contact()] + $listing + ['error' => 'bad_grant'], $price);
    return zeam_pass_refusal(402, array_merge($q['body'], ['message' => $why, 'how' => ZEAM_PASS_BAD_GRANT_HOW]), $q['headers']);
}

function zeam_pass_serve_mpp($server, $tool, $resource, array $args, $credential, $grant, $both, $price, $bound, array $listing = [], $extensions = null)
{
    zeam_pass_allow_seconds(180);
    $held = $server->mppHold($credential, $resource, is_array($price) ? $price['micro'] : null);
    if (!$held['ok']) {
        return zeam_pass_refusal($held['status'], $held['body'], $held['headers']);
    }
    $hold = $held['hold'];
    $grantedBy = null;
    if ($both) {
        $who = strtolower($hold['verified']['payer']);
        $a = zeam_pass_admits_payer($who, $grant, $tool);
        if (!$a['ok']) {
            $server->mppRelease($hold);
            if ($a['code'] === 'bad_grant') {
                return zeam_pass_bad_grant($server, $resource, $a['why'], $price, $listing, $extensions);
            }
            return zeam_pass_refusal(403, ['error' => 'refused', 'message' => $a['why'], 'how' => zeam_pass_refused_how(), 'contact' => zeam_pass_contact()]);
        }
        if ($a['root'] !== $who) {
            $grantedBy = $a['root'];
        }
    }
    $started = zeam_pass_now_ms();
    $call = zeam_pass_call_open();
    if ($call !== null) {
        register_shutdown_function('zeam_pass_call_close', $call);
    }
    $meter = new ZeamPassMeter($bound === null ? null : $started + $bound, null, $call);
    $out = zeam_pass_run_safely($tool, $args, $meter);
    $cut = zeam_pass_call_ended($call, $meter, zeam_pass_now_ms());
    if ($bound !== null && zeam_pass_now_ms() - $started > $bound) {
        $server->mppRelease($hold);
        return zeam_pass_refusal(402, zeam_pass_out_of_time(false, $bound));
    }
    if ($cut !== null) {
        $server->mppRelease($hold);
        return zeam_pass_refusal(499, zeam_pass_hung_up(false) + ['tool' => $tool]);
    }
    if (is_wp_error($out)) {
        $server->mppRelease($hold);
        return zeam_pass_tool_failed($out, $tool);
    }
    $settled = $server->mppSettle($hold);
    if (!$settled['ok']) {
        return zeam_pass_refusal($settled['status'], $settled['body'], $settled['headers']);
    }
    $headers = $settled['headers'];
    if ($grantedBy !== null) {
        $headers[ZEAM_PASS_GRANTED_BY] = $grantedBy;
    }
    return ['delivered' => true, 'status' => 200, 'headers' => $headers, 'body' => $out];
}

function zeam_pass_serve_paid($tool, $resource, array $args, $payment, $grant, $both, $price = null, $bound = null, $extensions = null, $credential = '')
{
    $e = zeam_pass_engine();
    $server = $e['server'];
    $listing = zeam_pass_listing();
    if ($payment === '' && $credential !== '' && \ZeamPass\Settlement\Server::mppOffered($price)) {
        return zeam_pass_serve_mpp($server, $tool, $resource, $args, $credential, $grant, $both, $price, $bound, $listing, $extensions);
    }
    if ($payment === '') {
        $q = $server->paymentRequired($resource, $extensions, null, ($both ? ['admission' => 'Only admitted keys pay here, or keys with an x-grant from an admitted key.', 'contact' => zeam_pass_contact()] : ['contact' => zeam_pass_contact()]) + $listing, $price);
        return zeam_pass_refusal($q['status'], $q['body'], $q['headers']);
    }
    $grantedBy = null;
    $nobody = false;
    if ($both) {
        $payload = \ZeamPass\Settlement\Json::decodeHeader($payment);
        if ($payload !== null) {
            $who = zeam_pass_payer_of($payload);
            $bad = $who === null ? $server->malformed($payment) : null;
            if ($bad !== null) {
                return zeam_pass_refusal($bad['status'], $bad['body'], $bad['headers']);
            }
            $nobody = $who === null;
            if (!$nobody) {
                $a = zeam_pass_admits_payer($who, $grant, $tool);
                if (!$a['ok'] && $a['code'] === 'bad_grant') {
                    return zeam_pass_bad_grant($server, $resource, $a['why'], $price, $listing, $extensions);
                }
                if (!$a['ok']) {
                    return zeam_pass_refusal(403, ['error' => 'refused', 'message' => $a['why'], 'how' => zeam_pass_refused_how(), 'contact' => zeam_pass_contact()]);
                }
                if ($a['root'] !== $who) {
                    $grantedBy = $a['root'];
                }
            }
        }
    }
    zeam_pass_allow_seconds(180);
    $held = $server->verifyAndHold($payment, $resource, is_array($price) ? $price['micro'] : null);
    if (!$held['ok']) {
        return zeam_pass_refusal($held['status'], $held['body'], $held['headers']);
    }
    if ($nobody) {
        $server->release($held['hold']);
        $a = zeam_pass_admits_payer(null, $grant, $tool);
        return zeam_pass_refusal(403, ['error' => 'refused', 'message' => $a['why'], 'how' => zeam_pass_refused_how(), 'contact' => zeam_pass_contact()]);
    }
    $hold = $held['hold'];
    $started = zeam_pass_now_ms();
    $call = zeam_pass_call_open();
    if ($call !== null) {
        register_shutdown_function('zeam_pass_call_close', $call);
    }
    $meter = new ZeamPassMeter($bound === null ? null : $started + $bound, $hold['channelId'], $call);
    $out = zeam_pass_run_safely($tool, $args, $meter);
    $cut = zeam_pass_call_ended($call, $meter, zeam_pass_now_ms());
    if ($bound !== null && zeam_pass_now_ms() - $started > $bound) {
        $server->release($hold);
        return zeam_pass_refusal(402, zeam_pass_out_of_time(false, $bound));
    }
    if ($cut !== null) {
        $server->release($hold);
        return zeam_pass_refusal(499, zeam_pass_hung_up(false) + ['tool' => $tool]);
    }
    if (is_wp_error($out)) {
        $server->release($hold);
        return zeam_pass_tool_failed($out, $tool);
    }
    $metered = is_array($price) && isset($price['unitMicro']) && $price['unitMicro'] !== null;
    if ($metered && $meter->reported() === null) {
        $server->release($hold);
        return zeam_pass_refusal(500, ['error' => 'tool_failed', 'message' => ZEAM_PASS_NO_UNITS, 'tool' => $tool]);
    }
    $bought = ((zeam_pass_tools()[$tool]['builtin'] ?? null) === 'buy_time')
        ? ['channelId' => $hold['channelId'], 'ms' => zeam_pass_bought_ms($args), 'key' => $hold['pendingId']]
        : null;
    if ($bought !== null) {
        $hold['owedMs'] = $bought['ms'];
    }
    $settled = $server->settle($hold, $metered ? zeam_pass_charge_units($e, $hold, $price, $meter->reported()) : null);
    if (!$settled['ok']) {
        return zeam_pass_refusal($settled['status'], $settled['body'], $settled['headers']);
    }
    if ($bought !== null) {
        try {
            zeam_pass_time_meter()->credit($bought['channelId'], $bought['ms'], $bought['key']);
        } catch (Throwable $ex) {
        }
        if (is_array($out) && array_key_exists('msRemaining', $out)) {
            try {
                $out['msRemaining'] = zeam_pass_time_meter()->status($bought['channelId'])['msRemaining'];
            } catch (Throwable $ex) {
            }
        }
    }
    $headers = ['PAYMENT-RESPONSE' => $settled['headers']['PAYMENT-RESPONSE']];
    if ($grantedBy !== null) {
        $headers[ZEAM_PASS_GRANTED_BY] = $grantedBy;
    }
    return ['delivered' => true, 'status' => 200, 'headers' => $headers, 'body' => $out];
}

function zeam_pass_out_of_time($onLine, $ms = null)
{
    return ['error' => 'out_of_time', 'message' => $onLine ? 'the line ran out of time during the call. Its time is spent. Buy time: buy_time.' : "the call needs more than the {$ms} ms its price buys, so it was cut. Nothing was charged. Buy time and call on a line."];
}

function zeam_pass_hung_up($onLine)
{
    return ['error' => 'client_gone', 'message' => 'the caller hung up or canceled the call, so it was stopped. ' . ($onLine ? 'The line is billed for the time the call ran, nothing after.' : 'Nothing was charged.')];
}

function zeam_pass_caller_gone(...$set)
{
    static $gone = null;
    if ($set) {
        $gone = $set[0] === null ? null : (bool) $set[0];
    }
    return $gone !== null ? $gone : connection_aborted() === 1;
}

function zeam_pass_call_key($id)
{
    if (is_string($id)) {
        return '0x' . hash('sha256', 'string ' . $id);
    }
    return (is_int($id) || is_float($id)) ? '0x' . hash('sha256', 'number ' . json_encode((float) $id)) : null;
}

function zeam_pass_callers($named = null)
{
    $line = is_string($named) && trim($named) !== '' ? trim($named) : trim((string) zeam_pass_request_line());
    $session = trim((string) zeam_pass_request_session());
    $by = [];
    if ($line !== '') {
        $by[] = hash('sha256', 'line ' . $line);
    }
    if (\ZeamPass\Settlement\Mpp::mcpInSession($session) || preg_match(ZEAM_PASS_MCP_SESSION, $session) === 1) {
        $by[] = hash('sha256', 'session ' . $session);
    }
    return $by;
}

function zeam_pass_call_open($channelId = null, $meterId = null, $started = null, $deadline = null)
{
    $asked = zeam_pass_request_call();
    if (!is_array($asked) || ($asked['key'] ?? null) === null || empty($asked['by'])) {
        return null;
    }
    $handle = ['key' => $asked['key'], 'id' => bin2hex(random_bytes(8))];
    $now = zeam_pass_now_ms();
    $entry = ['by' => array_values($asked['by']), 'channelId' => $channelId, 'call' => $meterId, 'started' => $started, 'deadline' => $deadline, 'at' => $now, 'cutAt' => null];
    try {
        (new ZeamPassMeterStore('call'))->update($handle['key'], function ($rec) use ($handle, $entry, $now) {
            $calls = [];
            foreach ((array) ($rec['calls'] ?? []) as $k => $c) {
                if ($now - (int) ($c['at'] ?? 0) <= ZEAM_PASS_CALL_KEPT_MS) {
                    $calls[$k] = $c;
                }
            }
            $calls[$handle['id']] = $entry;
            return ['calls' => $calls];
        });
    } catch (\Throwable $e) {
        return null;
    }
    return $handle;
}

function zeam_pass_call_cut($handle)
{
    if (is_array($handle)) {
        try {
            $rec = (new ZeamPassMeterStore('call'))->get($handle['key']);
        } catch (\Throwable $e) {
            $rec = null;
        }
        $at = $rec['calls'][$handle['id']]['cutAt'] ?? null;
        if ($at !== null) {
            return (int) $at;
        }
    }
    return zeam_pass_caller_gone() ? zeam_pass_now_ms() : null;
}

function zeam_pass_call_close($handle)
{
    if (!is_array($handle)) {
        return null;
    }
    $entry = null;
    try {
        (new ZeamPassMeterStore('call'))->update($handle['key'], function ($rec) use ($handle, &$entry) {
            $calls = (array) ($rec['calls'] ?? []);
            $entry = $calls[$handle['id']] ?? null;
            unset($calls[$handle['id']]);
            return $calls === [] ? null : ['calls' => $calls];
        });
    } catch (\Throwable $e) {
        return null;
    }
    return $entry;
}

function zeam_pass_call_ended($handle, ZeamPassMeter $meter, $stopped)
{
    $entry = zeam_pass_call_close($handle);
    $cut = $entry['cutAt'] ?? null;
    if ($cut === null && zeam_pass_caller_gone()) {
        $cut = $meter->cutAt() ?? $stopped;
    }
    return $cut === null ? null : min((int) $cut, (int) $stopped);
}

function zeam_pass_call_cancel($key, array $by)
{
    $store = new ZeamPassMeterStore('call');
    $holds = function ($c) use ($by) {
        return ($c['cutAt'] ?? null) === null && array_intersect($by, (array) ($c['by'] ?? [])) !== [];
    };
    $now = zeam_pass_now_ms();
    if (array_filter((array) ($store->get($key)['calls'] ?? []), $holds) === []) {
        return 0;
    }
    $hit = [];
    $store->update($key, function ($rec) use ($holds, $now, &$hit) {
        $calls = (array) ($rec['calls'] ?? []);
        foreach ($calls as $id => $c) {
            if ($holds($c)) {
                $calls[$id]['cutAt'] = $now;
                $hit[] = $calls[$id];
            }
        }
        return $calls === [] ? null : ['calls' => $calls];
    });
    foreach ($hit as $c) {
        if (is_string($c['channelId'] ?? null) && is_string($c['call'] ?? null)) {
            zeam_pass_time_meter()->end($c['channelId'], $c['call'], $c['started'] ?? null, $now);
        }
    }
    return count($hit);
}

function zeam_pass_serve_on_line($tool, array $args, $credential)
{
    $meter = zeam_pass_time_meter();
    $channelId = $meter->line($credential);
    if ($channelId === null) {
        return zeam_pass_refusal(403, ['error' => 'line_unknown', 'message' => 'no open line with that credential. Open one: POST {"op":"open","channelId":"0x…"} to this seller\'s line route, the address its 402 time line names.']);
    }
    $id = bin2hex(random_bytes(8));
    $channels = zeam_pass_channels();
    $seated = $channels->serial($channelId, function () use ($channels, $channelId, $meter, $id) {
        $ch = $channels->judged($channelId);
        if ($ch === null) {
            return ['refused' => zeam_pass_refusal(403, ['error' => 'line_unknown', 'message' => 'no channel for this line.'])];
        }
        if ((int) ($ch['withdrawRequestedAt'] ?? 0) > 0) {
            return ['refused' => zeam_pass_refusal(402, ['error' => 'channel_leaving', 'message' => 'this channel is withdrawing. Open a new channel.'])];
        }
        if (\ZeamPass\Settlement\Channels::refundingWaitMs($ch, $meter->nowMs()) > 0) {
            $secs = \ZeamPass\Settlement\Channels::refundingRetrySecs(null, $ch, $meter->nowMs());
            return ['refused' => zeam_pass_refusal(402, ['error' => 'refund_settling', 'message' => "a refund is settling on this channel, retry in {$secs}s.", 'retry_after_seconds' => $secs])];
        }
        if (zeam_pass_caller_gone()) {
            return ['refused' => zeam_pass_refusal(499, zeam_pass_hung_up(true))];
        }
        return ['b' => $meter->begin($channelId, $id)];
    });
    if (isset($seated['refused'])) {
        return $seated['refused'];
    }
    $b = $seated['b'];
    if (!$b['ok']) {
        $msRemaining = $meter->status($channelId)['msRemaining'];
        if ($b['code'] === 'too_many_calls') {
            return zeam_pass_refusal(429, ['error' => 'too_many_calls', 'message' => 'too many calls are live on this line; wait for one to finish, then retry.', 'msRemaining' => $msRemaining]);
        }
        return zeam_pass_refusal(402, ['error' => $b['code'], 'message' => $b['code'] === 'meter_off' ? 'the meter is off. Switch it on: POST ' . rest_url(ZEAM_PASS_NS . '/line') . ' {"op":"on","credential":"<yours>"}.' : 'this line has no time left. Buy time: buy_time.', 'msRemaining' => $msRemaining]);
    }
    zeam_pass_allow_seconds(max(180, (int) ceil(($b['deadline'] - zeam_pass_now_ms()) / 1000) + 60));
    $open = new ArrayObject(['open' => true]);
    $call = zeam_pass_call_open($channelId, $id, $b['started'], $b['deadline']);
    register_shutdown_function('zeam_pass_line_abandoned', $meter, $channelId, $id, $b['started'], $open, $call);
    $told = new ZeamPassMeter($b['deadline'], $channelId, $call);
    $out = zeam_pass_run_safely($tool, $args, $told);
    $stopped = $meter->nowMs();
    $cut = zeam_pass_call_ended($call, $told, $stopped);
    if ($cut !== null) {
        $e = $meter->end($channelId, $id, $b['started'], $cut);
        $open['open'] = false;
        if ($cut > $b['deadline']) {
            return zeam_pass_refusal(402, zeam_pass_out_of_time(true) + ['msRemaining' => $e['msRemaining']]);
        }
        $elapsed = max(0, $cut - $b['started']);
        return zeam_pass_line_read(zeam_pass_refusal(499, zeam_pass_hung_up(true) + ['msRemaining' => $e['msRemaining'], 'elapsedMs' => $elapsed]), $channelId, $e['msRemaining'], $elapsed);
    }
    $renewed = $stopped > $b['deadline'] && $meter->renew($channelId, $id, $b['started'], $b['deadline'])['ok'];
    $e = $meter->end($channelId, $id, $b['started'], $stopped);
    $open['open'] = false;
    if ($e['over']) {
        return zeam_pass_refusal(402, zeam_pass_out_of_time(true) + ['msRemaining' => $e['msRemaining']]);
    }
    if ($renewed) {
        $e['elapsedMs'] = $stopped - $b['started'];
    }
    if (is_wp_error($out)) {
        $failed = zeam_pass_tool_failed($out, $tool);
        $failed['mcpBody'] = $failed['body'];
        $failed['body'] += ['msRemaining' => $e['msRemaining'], 'elapsedMs' => $e['elapsedMs']];
        return zeam_pass_line_read($failed, $channelId, $e['msRemaining'], $e['elapsedMs']);
    }
    return ['delivered' => true, 'status' => 200, 'headers' => ['X-Pass-Ms-Remaining' => (string) $e['msRemaining'], 'X-Pass-Ms-Elapsed' => (string) $e['elapsedMs']], 'body' => $out, 'meter' => ['channelId' => $channelId, 'msRemaining' => $e['msRemaining'], 'elapsedMs' => $e['elapsedMs']]];
}

function zeam_pass_line_read(array $s, $channelId, $msRemaining, $elapsedMs)
{
    $s['headers']['X-Pass-Ms-Remaining'] = (string) $msRemaining;
    $s['headers']['X-Pass-Ms-Elapsed'] = (string) $elapsedMs;
    $s['meter'] = ['channelId' => $channelId, 'msRemaining' => $msRemaining, 'elapsedMs' => $elapsedMs];
    return $s;
}

function zeam_pass_line_abandoned($meter, $channelId, $id, $started, $open, $call = null)
{
    if (!$open['open']) {
        return null;
    }
    $open['open'] = false;
    try {
        $now = $meter->nowMs();
        $cut = zeam_pass_call_close($call)['cutAt'] ?? null;
        return $meter->end($channelId, $id, $started, $cut === null ? $now : min((int) $cut, $now));
    } catch (\Throwable $e) {
        return null;
    }
}

function zeam_pass_line_op($args, $headerCredential = '')
{
    $fail = function ($status, $code, $why) {
        return ['status' => $status, 'body' => ['op' => 'line_failed', 'code' => $code, 'why' => $why]];
    };
    $meter = zeam_pass_time_meter();
    if ($meter === null) {
        return $fail(404, 'no_time', 'this seller sells no line time');
    }
    if (!zeam_pass_is_object($args) || !in_array($args['op'] ?? null, ZEAM_PASS_LINE_OPS, true)) {
        return $fail(400, 'bad_request', 'op is open, prove, on, off, status or close');
    }
    $op = $args['op'];
    if ($op === 'open' || $op === 'prove') {
        $id = isset($args['channelId']) && is_string($args['channelId']) && preg_match('/^0x[0-9a-fA-F]{64}$/D', $args['channelId']) ? strtolower($args['channelId']) : null;
        if ($id === null) {
            return $fail(400, 'bad_request', 'channelId is missing or is not 0x and 64 hex characters: send "channelId":"0x…" with the op');
        }
        $ch = $id !== null ? (new ZeamPassChannelStore())->get($id) : null;
        if (!isset($ch['channelConfig'])) {
            return $fail(404, 'unknown_channel', 'no channel with that id here. Pay a call on it first, e.g. buy_time.');
        }
        if ((int) ($ch['withdrawRequestedAt'] ?? 0) > 0) {
            return $fail(409, 'channel_leaving', 'this channel is withdrawing. Open a new channel.');
        }
        if ($op === 'open') {
            $c = $meter->challenge($id);
            return ['status' => 200, 'body' => ['op' => 'challenge', 'channelId' => $id, 'nonce' => $c['nonce'], 'sign' => $c['message'], 'expiresInSeconds' => $c['expiresInSeconds']]];
        }
        $channels = zeam_pass_channels();
        $r = $meter->prove($ch, $args['nonce'] ?? null, $args['signature'] ?? null, function ($attach) use ($channels, $id) {
            $holder = '0x' . bin2hex(random_bytes(16));
            return $channels->serial($id, function () use ($channels, $id, $holder, $attach) {
                $marked = $channels->mark($id, $holder, false);
                if (isset($marked['unavailable'])) {
                    return ['refused' => $marked];
                }
                if (isset($marked['settling']) || isset($marked['judged'])) {
                    return $attach($marked);
                }
                try {
                    return $attach();
                } finally {
                    $channels->unmark($id, $holder);
                }
            });
        });
        if (isset($r['refused']['unavailable'])) {
            return ['status' => 503, 'body' => ['op' => 'line_failed', 'code' => 'line_unavailable', 'why' => 'the line could not be read right now. Retry.']];
        }
        if (isset($r['refused']['settling'])) {
            $secs = $r['refused']['settling'];
            return ['status' => 402, 'body' => ['op' => 'line_failed', 'code' => 'refund_settling', 'why' => "a refund is settling on this channel, and a first line would switch its meter on. Nothing was opened: send {\"op\":\"open\"} again in {$secs}s.", 'retry_after_seconds' => $secs]];
        }
        if (isset($r['refused']['judged'])) {
            $secs = $r['refused']['judged'];
            return ['status' => 402, 'body' => ['op' => 'line_failed', 'code' => 'refund_pending', 'why' => "a refund asked for on this channel is being worked out, and the meter stays off until it is answered. Nothing was opened: send {\"op\":\"open\"} again in {$secs}s.", 'retry_after_seconds' => $secs]];
        }
        if (!$r['ok']) {
            return $fail($r['status'], $r['code'], $r['why']);
        }
        return ['status' => 200, 'body' => ['op' => 'opened', 'credential' => $r['credential'], 'channelId' => $id, 'msRemaining' => $r['msRemaining'], 'metering' => $r['metering']]];
    }
    $credential = isset($args['credential']) && is_string($args['credential']) && $args['credential'] !== '' ? $args['credential'] : (string) $headerCredential;
    if ($credential === '') {
        return $fail(400, 'bad_request', 'credential is missing or is not a string: add "credential":"<yours>" to the body, or send it as the x-line header');
    }
    $id = $meter->line($credential);
    if ($id === null) {
        return $fail(403, 'line_unknown', 'no open line with that credential');
    }
    $channels = zeam_pass_channels();
    if ($op === 'close') {
        $channels->serial($id, function () use ($meter, $credential) {
            return $meter->close($credential);
        });
        return ['status' => 200, 'body' => ['op' => 'closed', 'channelId' => $id]];
    }
    if ($op === 'on') {
        $holder = '0x' . bin2hex(random_bytes(16));
        $marked = $channels->serial($id, function () use ($channels, $meter, $id, $holder) {
            $marked = $channels->mark($id, $holder, false);
            if (isset($marked['unavailable']) || isset($marked['settling']) || isset($marked['judged'])) {
                return $marked;
            }
            try {
                $meter->switch($id, true);
            } finally {
                $channels->unmark($id, $holder);
            }
            return $marked;
        });
        if (isset($marked['unavailable'])) {
            return ['status' => 503, 'body' => ['op' => 'line_failed', 'code' => 'line_unavailable', 'why' => 'the line could not be read right now. Retry.']];
        }
        if (isset($marked['settling'])) {
            $secs = $marked['settling'];
            return ['status' => 402, 'body' => ['op' => 'line_failed', 'code' => 'refund_settling', 'why' => "a refund is settling on this channel, retry in {$secs}s.", 'retry_after_seconds' => $secs]];
        }
        if (isset($marked['judged'])) {
            $secs = $marked['judged'];
            return ['status' => 402, 'body' => ['op' => 'line_failed', 'code' => 'refund_pending', 'why' => "a refund asked for on this channel is being worked out, and the meter stays off until it is answered. Retry in {$secs}s.", 'retry_after_seconds' => $secs]];
        }
    } elseif ($op !== 'status') {
        $channels->serial($id, function () use ($meter, $id) {
            return $meter->switch($id, false);
        });
    }
    return ['status' => 200, 'body' => ['op' => $op] + $meter->status($id)];
}

function zeam_pass_serve_line_op(array $args, $credential, $mcp)
{
    try {
        $l = zeam_pass_line_op($args, $credential);
    } catch (Throwable $e) {
        $l = ['status' => 503, 'body' => ['op' => 'line_failed', 'code' => 'line_unavailable', 'why' => 'the line could not be read right now. Retry.']];
    }
    if ($l['status'] === 200) {
        return ['delivered' => true, 'status' => 200, 'headers' => [], 'body' => $l['body']];
    }
    if (!$mcp) {
        return zeam_pass_refusal($l['status'], $l['body']);
    }
    return zeam_pass_refusal(500, ['error' => 'tool_failed', 'message' => wp_json_encode($l['body']), 'tool' => 'line']) + ['mcpBody' => $l['body']];
}

const ZEAM_PASS_GATE_HOW = 'Sign the zero-amount requirement with any x402 client and your own key. Nothing is paid. The key must be admitted here, or send an x-grant from an admitted key.';

function zeam_pass_gate_terms($admission, $resource, $error = null)
{
    $q = $admission->paymentRequired($resource);
    $doc = clone $q['body'];
    $doc->contact = zeam_pass_contact();
    $terms = zeam_pass_as_array($doc);
    if ($error !== null) {
        $doc->error = $error;
    }
    $headers = $q['headers'];
    $headers['PAYMENT-REQUIRED'] = Exact::encodeHeader($doc);
    return ['terms' => $terms, 'headers' => $headers];
}

function zeam_pass_serve_gate($tool, $resource, array $args, $payment, $grant)
{
    $g = zeam_pass_gate_parts();
    if ($payment === '') {
        $q = zeam_pass_gate_terms($g['admission'], $resource);
        return zeam_pass_refusal(402, array_merge($q['terms'], ['how' => ZEAM_PASS_GATE_HOW]), $q['headers']);
    }
    $a = $g['admission']->admit($payment, $grant, $tool, zeam_pass_admit_list());
    if (!$a['ok'] && $a['status'] === 402) {
        $q = zeam_pass_gate_terms($g['admission'], $resource, $a['code']);
        return zeam_pass_refusal(402, array_merge($q['terms'], ['error' => $a['code'], 'message' => $a['why'], 'how' => ZEAM_PASS_GATE_HOW]), $q['headers']);
    }
    if (!$a['ok']) {
        return zeam_pass_refusal($a['status'], $a['status'] === 403 ? ['error' => $a['code'], 'message' => $a['why'], 'how' => zeam_pass_refused_how(), 'contact' => zeam_pass_contact()] : ['error' => $a['code'], 'message' => $a['why']]);
    }
    $c = $g['meter']->charge();
    if (!$c['ok']) {
        return zeam_pass_refusal(503, ['error' => 'gate_credit_exhausted', 'message' => 'This gate has no checks left this month. Retry later.']);
    }
    if (!empty($c['unpaid'])) {
        update_option('zeam_pass_unpaid_at', gmdate('c'), false);
    }
    $out = zeam_pass_run_safely($tool, $args);
    if (is_wp_error($out)) {
        return zeam_pass_tool_failed($out, $tool);
    }
    $headers = [];
    if ($a['root'] !== $a['signer']) {
        $headers[ZEAM_PASS_GRANTED_BY] = $a['root'];
    }
    return ['delivered' => true, 'status' => 200, 'headers' => $headers, 'body' => $out];
}

function zeam_pass_refund(array $body)
{
    if (!zeam_pass_settles()) {
        return ['status' => 404, 'body' => ['op' => 'refund_failed', 'code' => 'not_a_paywall', 'why' => 'this site has no paid calls']];
    }
    if (!zeam_pass_ready()) {
        return ['status' => 503, 'body' => ['op' => 'refund_failed', 'code' => 'not_ready', 'why' => 'this site has not finished setting up ZEAM Bridge']];
    }
    zeam_pass_allow_seconds(180);
    $e = zeam_pass_engine();
    $refunds = new Refunds($e['cfg'], $e['store'], $e['chain'], $e['relay']);
    $scalar = function ($k) use ($body) {
        return isset($body[$k]) && is_scalar($body[$k]) ? (string) $body[$k] : null;
    };
    return $refunds->handle($scalar('channelId'), $scalar('issued'), $scalar('signature'), Refunds::ask($body));
}

function zeam_pass_record_payout(array $calls, $valueUSD, $how)
{
    $txs = [];
    foreach ($calls as $c) {
        if (isset($c['hash'])) {
            $txs[] = $c['hash'];
        }
    }
    if ($txs === []) {
        return;
    }
    update_option('zeam_pass_last_payout', ['at' => gmdate('c'), 'valueUSD' => $valueUSD, 'how' => $how, 'transactions' => array_values(array_unique($txs))], false);
}

function zeam_pass_credit_step()
{
    $g = zeam_pass_gate_parts();
    $payout = zeam_pass_payout();
    $name = zeam_pass_name();
    $issuer = zeam_pass_credit_issuer();
    $notes = get_option('zeam_pass_credit_notes', []);
    $notes = is_array($notes) ? $notes : [];
    $changed = false;
    foreach ($notes as $i => $entry) {
        if (!empty($entry['added']) || !isset($entry['note'])) {
            continue;
        }
        $r = $g['credits']->addNote($entry['note'], $issuer, $payout, $name);
        if ($r['ok'] || (isset($r['why']) && $r['why'] === 'this note is already added')) {
            $notes[$i]['added'] = true;
            unset($notes[$i]['why']);
        } else {
            $notes[$i]['why'] = isset($r['why']) ? (string) $r['why'] : 'not added';
        }
        $changed = true;
    }
    $out = ['wanted' => $g['meter']->wantsCredit()];
    if ($out['wanted']) {
        $last = (int) get_option('zeam_pass_credit_try', 0);
        if (time() - $last < 300) {
            $out['waiting'] = 'last purchase attempt under 5 minutes ago';
        } else {
            update_option('zeam_pass_credit_try', time(), false);
            $key = zeam_pass_secret('credit');
            if ($key === null) {
                $out['error'] = 'no credit wallet key';
            } else {
                $r = $g['credits']->buy(zeam_pass_credits_url(), $g['meter']->creditBlock(), $key, $payout, $name, new Rpc(zeam_pass_rpc_url(), 10, 5));
                if (isset($r['note']) && is_array($r['note'])) {
                    $ok = !empty($r['added']['ok']);
                    $notes[] = ['note' => $r['note'], 'at' => gmdate('c'), 'added' => $ok] + ($ok ? [] : ['why' => isset($r['added']['why']) ? (string) $r['added']['why'] : 'not added']);
                    $changed = true;
                }
                $out['bought'] = !empty($r['ok']);
                if (empty($r['ok'])) {
                    $out['error'] = isset($r['why']) ? (string) $r['why'] : (isset($r['added']['why']) ? (string) $r['added']['why'] : 'not bought');
                }
            }
        }
    }
    if ($changed) {
        update_option('zeam_pass_credit_notes', array_slice(array_values($notes), -100), false);
    }
    return $out;
}

function zeam_pass_tick()
{
    zeam_pass_allow_seconds(300);
    $ran = ZeamPassLock::attempt('tick', function () {
        $report = ['at' => gmdate('c'), 'mode' => zeam_pass_mode()];
        $blockers = zeam_pass_blockers();
        if ($blockers !== []) {
            $report['error'] = implode('; ', $blockers);
            return $report;
        }
        if (zeam_pass_settles()) {
            try {
                $e = zeam_pass_engine();
                $report['withdrawals'] = (new Withdrawals($e['cfg'], $e['store'], $e['chain']))->run();
                $claims = (new Claims($e['cfg'], $e['store'], $e['chain'], $e['relay']))->run();
                $report['claims'] = $claims;
                $report['synced'] = count(zeam_pass_sync_claimed($e));
                foreach ($claims as $asset) {
                    $paid = array_filter($asset['calls'], function ($c) {
                        return strpos((string) $c['what'], 'claim ') !== 0;
                    });
                    zeam_pass_record_payout($paid, $asset['valueUSD'], 'relay');
                }
            } catch (\Throwable $ex) {
                $report['error'] = substr(\ZeamPass\message($ex), 0, 300);
            }
        }
        if (zeam_pass_mode() === 'gate') {
            try {
                $report['credit'] = zeam_pass_credit_step();
            } catch (\Throwable $ex) {
                $report['creditError'] = substr(\ZeamPass\message($ex), 0, 300);
            }
        }
        return $report;
    });
    if ($ran === null) {
        return ['at' => gmdate('c'), 'skipped' => 'another run is in progress'];
    }
    update_option('zeam_pass_last_tick', $ran, false);
    return $ran;
}

function zeam_pass_sync_claimed(array $e, $limit = 50)
{
    $synced = [];
    foreach ($e['store']->list() as $c) {
        if (count($synced) >= $limit || !isset($c['channelId'])) {
            continue;
        }
        $charged = Channels::n(isset($c['chargedCumulativeAmount']) ? $c['chargedCumulativeAmount'] : '0');
        $claimed = Channels::n(isset($c['totalClaimed']) ? $c['totalClaimed'] : '0');
        if (Big::cmp($charged, $claimed) <= 0) {
            continue;
        }
        try {
            $st = $e['chain']->channel($c['channelId']);
        } catch (\Throwable $ex) {
            continue;
        }
        if (Big::cmp(Channels::n($st['totalClaimed']), $claimed) <= 0) {
            continue;
        }
        $e['store']->update($c['channelId'], function ($r) use ($st) {
            if ($r === null) {
                return null;
            }
            if (Big::cmp(Channels::n($st['totalClaimed']), Channels::n(isset($r['totalClaimed']) ? $r['totalClaimed'] : '0')) > 0) {
                $r['totalClaimed'] = $st['totalClaimed'];
            }
            return $r;
        });
        $synced[] = strtolower($c['channelId']);
    }
    return $synced;
}

function zeam_pass_payout_plan(array $e)
{
    $cfg = $e['cfg'];
    $chain = $e['chain'];
    $calls = [];
    $usd = 0.0;
    $gasUnits = 0;
    foreach ($cfg->assets as $asset) {
        $picked = [];
        $riding = Big::init(0);
        foreach ($e['store']->list() as $raw) {
            $c = Channels::earned($cfg, $raw);
            if (!isset($c['channelConfig']['token'], $c['channelId']) || !Address::equals($c['channelConfig']['token'], $asset['address']) || !Channels::claimable($c)) {
                continue;
            }
            try {
                $live = $chain->live($c['channelId']);
            } catch (\Throwable $ex) {
                continue;
            }
            $charged = Channels::n($c['chargedCumulativeAmount']);
            if (Big::cmp($charged, Channels::n($live['balance'])) > 0 || Big::cmp($charged, Channels::n($live['claimed'])) <= 0) {
                continue;
            }
            $delta = Big::sub($charged, Channels::n($live['claimed']));
            if (Big::cmp($delta, Channels::n($live['payable'])) > 0) {
                continue;
            }
            $picked[] = $c;
            $riding = Big::add($riding, $delta);
        }
        $plan = (new Payout($cfg, $chain))->calls($asset['address'], $picked !== []);
        if ($picked !== []) {
            $entries = array_map(['ZeamPass\\Settlement\\Channels', 'claimEntry'], $picked);
            $signature = BatchSettlement::signClaimBatch($cfg->signingKey(), $entries, $cfg->chainId);
            $calls[] = ['what' => 'claim ' . count($entries) . ' voucher(s)', 'to' => BatchSettlement::ESCROW, 'data' => BatchSettlement::encodeClaimWithSignature($entries, $signature)];
            $gasUnits += $cfg->gas['claimBase'] + count($entries) * $cfg->gas['claimEntry'];
        }
        if ($plan['calls'] !== []) {
            $gasUnits += $cfg->gas['payout'];
            foreach ($plan['calls'] as $c) {
                if ($c['what'] === 'create split') {
                    $gasUnits += $cfg->gas['createSplit'];
                }
            }
            $calls = array_merge($calls, $plan['calls']);
            $usd += $cfg->microUSDOf($asset, Big::strval(Big::add(Big::add($riding, Big::init($plan['owed'], 10)), Big::init($plan['held'], 10)))) / 1e6;
        }
    }
    return ['calls' => $calls, 'usd' => $usd, 'gasUnits' => $gasUnits];
}

function zeam_pass_multicall3(array $calls)
{
    $tuples = [];
    foreach ($calls as $c) {
        $tuples[] = [Address::checksum($c['to']), false, $c['data']];
    }
    return \ZeamPass\Abi::encodeCall('aggregate3((address,bool,bytes)[])', [$tuples]);
}

function zeam_pass_payout_now()
{
    zeam_pass_allow_seconds(300);
    $e = zeam_pass_engine();
    $plan = zeam_pass_payout_plan($e);
    if ($plan['calls'] === []) {
        return ['paidBy' => 'nobody', 'valueUSD' => 0, 'note' => 'Nothing to pay out.'];
    }
    $gas = new GasQuote($e['cfg'], $e['chain'], $e['relay']);
    $valueUSD = round($plan['usd'], 6);
    $gasUSD = $gas->usd($plan['gasUnits']);
    $note = null;
    if ($gas->atMargin($plan['usd'], $plan['gasUnits'])) {
        $sent = $e['relay']->send($plan['calls'], $e['cfg']->relaySplit());
        $report = [];
        foreach ($plan['calls'] as $i => $c) {
            $report[] = ['what' => $c['what']] + $sent[$i];
        }
        $hashes = array_filter($report, function ($r) {
            return isset($r['hash']);
        });
        if ($hashes !== []) {
            zeam_pass_record_payout($report, $valueUSD, 'relay');
            zeam_pass_sync_claimed($e);
            return ['paidBy' => 'relay', 'valueUSD' => $valueUSD, 'calls' => $report];
        }
        $note = 'The relay did not send it (' . (isset($report[0]['error']) ? $report[0]['error'] : 'no answer') . '). ';
    }
    return [
        'paidBy' => 'you',
        'valueUSD' => $valueUSD,
        'gasUSD' => $gasUSD === null ? null : round($gasUSD, 6),
        'note' => ($note ?: '') . 'Below break-even: the ' . \ZeamPass\Settlement\Server::percent($e['cfg']->feeShare) . '% fee share of this payout is under its gas. The relay sends it once the share covers the gas. To pay out now, send this transaction from your wallet with ETH on Base for gas. It pays only you and the split\'s fee.',
        'transaction' => ['chainId' => 8453, 'to' => ZEAM_PASS_MULTICALL3, 'data' => zeam_pass_multicall3($plan['calls']), 'value' => '0'],
        'calls' => array_map(function ($c) {
            return $c['what'];
        }, $plan['calls']),
    ];
}

function zeam_pass_local_unclaimed_micro()
{
    $total = 0;
    $open = 0;
    $cfg = null;
    if (zeam_pass_time() !== null) {
        try {
            $cfg = zeam_pass_engine()['cfg'];
        } catch (\Throwable $e) {
            $cfg = null;
        }
    }
    foreach ((new ZeamPassChannelStore())->list() as $c) {
        $open++;
        try {
            $c = $cfg !== null ? Channels::earned($cfg, $c) : $c;
            $delta = Big::sub(Channels::n(isset($c['chargedCumulativeAmount']) ? $c['chargedCumulativeAmount'] : '0'), Channels::n(isset($c['totalClaimed']) ? $c['totalClaimed'] : '0'));
        } catch (\Throwable $e) {
            continue;
        }
        if (Big::sign($delta) > 0) {
            $total += (int) Big::strval($delta);
        }
    }
    return ['microUSD' => $total, 'channels' => $open];
}

function zeam_pass_status()
{
    $out = [
        'mode' => zeam_pass_mode(),
        'ready' => zeam_pass_ready(),
        'blockers' => zeam_pass_blockers(),
        'lastPayout' => get_option('zeam_pass_last_payout', null),
        'lastTick' => get_option('zeam_pass_last_tick', null),
        'nextTick' => wp_next_scheduled('zeam_pass_tick') ?: null,
    ];
    if (zeam_pass_missing_extensions() !== []) {
        return $out;
    }
    if (zeam_pass_settles()) {
        $out['unclaimed'] = zeam_pass_local_unclaimed_micro();
        try {
            $e = zeam_pass_engine();
            $cfg = $e['cfg'];
            $token = $cfg->assets[0]['address'];
            $r = $e['chain']->receivers($cfg->receiver, $token);
            $owed = Big::sub(Big::init($r['totalClaimed'], 10), Big::init($r['totalSettled'], 10));
            $deployed = $e['chain']->hasCode($cfg->receiver);
            $held = Big::init($deployed ? $e['chain']->splitBalance($cfg->receiver, $token) : $e['chain']->balanceOf($token, $cfg->receiver), 10);
            $out['claimedNotPaid'] = ['microUSD' => (int) Big::strval(Big::add(Big::sign($owed) > 0 ? $owed : Big::init(0), $held)), 'splitDeployed' => $deployed];
        } catch (\Throwable $ex) {
            $out['chainError'] = substr(\ZeamPass\message($ex), 0, 200);
        }
    }
    if (zeam_pass_gated_mode()) {
        try {
            $out['gate'] = zeam_pass_gate_parts()['meter']->usage();
            $out['gate']['onEmpty'] = zeam_pass_on_empty();
            $out['gate']['unpaidAt'] = get_option('zeam_pass_unpaid_at', null);
        } catch (\Throwable $ex) {
            $out['gateError'] = substr(\ZeamPass\message($ex), 0, 200);
        }
        $credit = zeam_pass_secret_address('credit');
        if ($credit !== '') {
            try {
                $chain = new Chain(zeam_pass_rpc_url());
                $out['creditWallet'] = ['address' => $credit, 'usdcMicro' => (int) $chain->balanceOf(\ZeamPass\Erc20::USDC_BASE, $credit)];
            } catch (\Throwable $ex) {
                $out['creditWallet'] = ['address' => $credit, 'error' => 'could not read its balance'];
            }
        }
    }
    return $out;
}

function zeam_pass_allow_seconds($seconds)
{
    if (function_exists('set_time_limit')) {
        @set_time_limit($seconds); // phpcs:ignore Squiz.PHP.DiscouragedFunctions.Discouraged
    }
}
