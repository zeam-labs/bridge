<?php
/**
 * Plugin Name: ZEAM Bridge
 * Plugin URI: https://zeambridge.com
 * Description: Put a gate, a paywall or both in front of your posts for AI agents, on your own site. Agents search and read over MCP and over HTTP; x402 clients pay for every tool, and MPP clients for a tool priced per call whose fee covers the gas of its transfer. No sign-up and no account: install, connect the wallet you are paid to, choose. Your earnings go to your own split, 90.01% to your wallet.
 * Version: 2.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: ZEAM Labs, LLC
 * Author URI: https://www.zeamlabs.com
 * License: GPL-2.0-only
 * License URI: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
 * Text Domain: zeam-pass
 * Update URI: https://zeampass.com/downloads/zeam-pass.json
 */

if (!defined('ABSPATH')) {
    exit;
}

const ZEAM_PASS_NS = 'zeam-pass';
const ZEAM_BRIDGE_NS = 'zeam-bridge';
const ZEAM_PASS_META_PAYMENT = 'x402/payment';
const ZEAM_PASS_META_RESPONSE = 'x402/payment-response';
const ZEAM_PASS_META_GRANTED_BY = 'zeam-pass/granted-by';
const ZEAM_PASS_META_PRICE = 'zeam-pass/price';
const ZEAM_PASS_META_LINE = 'zeam-pass/line';
const ZEAM_PASS_META_METER = 'zeam-pass/meter';
const ZEAM_PASS_LINE_OPS = ['open', 'prove', 'on', 'off', 'status', 'close'];
const ZEAM_PASS_TIME_TOOLS = ['buy_time', 'line'];
const ZEAM_PASS_BUILTIN_TOOLS = ['search_posts', 'read_post'];
const ZEAM_PASS_VERSION = '2.1.0';
const ZEAM_PASS_MCP_SESSION = '/^mcp\.[A-Za-z0-9_-]{16}$/D';
const ZEAM_PASS_HANG_UP_TIME = ' A call you hang up on burns until it returns: to stop the burn, send notifications/cancelled over MCP with its requestId and the line.';

require_once __DIR__ . '/lib/autoload.php';

const ZEAM_PASS_NO_UNITS = 'the tool reported no units. ' . \ZeamPass\Discovery::FAILED_CALL;
const ZEAM_PASS_RESULT_NOT_JSON = 'the result is not valid JSON (a non-finite number or a non-JSON value). ' . \ZeamPass\Discovery::FAILED_CALL;

require_once __DIR__ . '/includes/store.php';
require_once __DIR__ . '/includes/keys.php';
require_once __DIR__ . '/includes/engine.php';
require_once __DIR__ . '/includes/update.php';

function zeam_pass_opt($key, $default = null)
{
    $all = get_option('zeam_pass', []);
    return is_array($all) && array_key_exists($key, $all) ? $all[$key] : $default;
}

function zeam_pass_set(array $values)
{
    $all = get_option('zeam_pass', []);
    update_option('zeam_pass', array_merge(is_array($all) ? $all : [], $values), false);
}

function zeam_pass_defined($name)
{
    foreach (['ZEAM_BRIDGE_', 'ZEAM_PASS_'] as $prefix) {
        if (defined($prefix . $name)) {
            return constant($prefix . $name);
        }
    }
    return null;
}

function zeam_pass_prices_filtered()
{
    return has_filter('zeam_pass_prices') || has_filter('zeam_bridge_prices');
}

function zeam_pass_filtered_price($name, array $args)
{
    return apply_filters('zeam_bridge_prices', apply_filters('zeam_pass_prices', null, $name, $args), $name, $args);
}

function zeam_pass_route($request)
{
    $route = untrailingslashit((string) $request->get_route());
    foreach ([ZEAM_PASS_NS, ZEAM_BRIDGE_NS] as $ns) {
        if ($route === '/' . $ns || strpos($route, '/' . $ns . '/') === 0) {
            return (string) substr($route, strlen($ns) + 1);
        }
    }
    return null;
}

function zeam_pass_site_name()
{
    return html_entity_decode(wp_strip_all_tags(get_bloginfo('name')), ENT_QUOTES);
}

final class ZeamPassMeter
{
    private $units = null;
    private $deadline;
    private $channelId;
    private $call;
    private $cut = null;

    public function __construct($deadlineMs = null, $channelId = null, $call = null)
    {
        $this->deadline = $deadlineMs === null ? null : (int) $deadlineMs;
        $this->channelId = $channelId === null ? null : strtolower((string) $channelId);
        $this->call = $call;
    }

    public function stopped()
    {
        if ($this->cut === null) {
            $this->cut = zeam_pass_call_cut($this->call);
        }
        return $this->cut !== null || ($this->deadline !== null && zeam_pass_now_ms() >= $this->deadline);
    }

    public function cutAt()
    {
        return $this->cut;
    }

    public function deadlineMs()
    {
        return $this->deadline;
    }

    public function channelId()
    {
        return $this->channelId;
    }

    public function units($n)
    {
        $this->units = \ZeamPass\Pricing::units($n);
    }

    public function reported()
    {
        return $this->units;
    }
}

function zeam_pass_builtin_tools()
{
    $site = zeam_pass_site_name();
    return [
        'search_posts' => [
            'description' => "Search the posts on {$site}: titles, links, dates and excerpts.",
            'inputSchema' => ['type' => 'object', 'properties' => ['q' => ['type' => 'string', 'minLength' => 1, 'pattern' => '\\S', 'description' => 'what to search for'], 'page' => ['type' => 'integer', 'minimum' => 1, 'description' => 'page of 10 results']], 'required' => ['q']],
        ],
        'read_post' => [
            'description' => "Read one post on {$site} in full, as plain text.",
            'inputSchema' => ['type' => 'object', 'properties' => ['id' => ['type' => 'integer', 'description' => 'the post id, from search_posts']], 'required' => ['id']],
        ],
    ];
}

function zeam_pass_free_list()
{
    $out = [];
    foreach ((array) zeam_pass_opt('free', []) as $t) {
        if (is_string($t) && in_array($t, ZEAM_PASS_BUILTIN_TOOLS, true)) {
            $out[] = $t;
        }
    }
    return array_values(array_unique($out));
}

function zeam_pass_free_limit()
{
    $n = zeam_pass_opt('free_limit', '');
    return (is_int($n) || (is_string($n) && ctype_digit($n))) && (int) $n >= 1 ? (int) $n : null;
}

function zeam_pass_has_price($value)
{
    return $value !== null && $value !== '';
}

function zeam_pass_own_price(array $t)
{
    return zeam_pass_has_price($t['price'] ?? null) || zeam_pass_has_price($t['unit'] ?? null);
}

function zeam_pass_site_fallback()
{
    $micro = zeam_pass_price_micro();
    return $micro >= 1 ? $micro : null;
}

function zeam_pass_time()
{
    $time = zeam_pass_time_price();
    return $time !== null && isset(zeam_pass_tools()['buy_time']) ? $time : null;
}

function zeam_pass_time_price()
{
    if (zeam_pass_mode() === 'gate') {
        return null;
    }
    $block = trim((string) zeam_pass_opt('time_block', ''));
    if ($block === '') {
        return null;
    }
    $ms = zeam_pass_opt('time_block_ms', '');
    $unitMs = (is_int($ms) || (is_string($ms) && ctype_digit($ms))) && (int) $ms >= 1 ? (int) $ms : \ZeamPass\Meter\TimeMeter::DEFAULT_MS;
    try {
        return \ZeamPass\Meter\TimeMeter::options(['usd' => $block, 'ms' => $unitMs]);
    } catch (InvalidArgumentException $e) {
        return null;
    }
}

function zeam_pass_time_meter()
{
    $time = zeam_pass_time();
    return $time === null ? null : new \ZeamPass\Meter\TimeMeter($time, new ZeamPassMeterStore('clock'), new ZeamPassMeterStore('line'), 'zeam_pass_now_ms', zeam_pass_owed_time());
}

function zeam_pass_owed_time()
{
    $store = new ZeamPassChannelStore();
    return [
        'read' => function ($channelId) use ($store) {
            $rec = $store->get($channelId);
            return is_array($rec) && isset($rec['timeOwed']) ? $rec['timeOwed'] : null;
        },
        'paid' => function ($channelId, array $keys) use ($store) {
            $store->update($channelId, function ($r) use ($keys) {
                if (!is_array($r) || !isset($r['timeOwed']) || !is_array($r['timeOwed'])) {
                    return $r;
                }
                foreach ($keys as $k) {
                    unset($r['timeOwed'][$k]);
                }
                if ($r['timeOwed'] === []) {
                    unset($r['timeOwed']);
                }
                return $r;
            });
        },
    ];
}

function zeam_pass_bought_ms(array $args)
{
    return \ZeamPass\Meter\TimeMeter::boughtMs(zeam_pass_time(), $args);
}

function zeam_pass_time_tools(array $time)
{
    $rate = \ZeamPass\Meter\TimeMeter::rate($time);
    return [
        'buy_time' => [
            'builtin' => 'buy_time',
            'description' => "Buys line time: {$rate}, for the channel that pays. Then open a line.",
            'inputSchema' => ['type' => 'object', 'properties' => ['ms' => ['type' => 'integer', 'minimum' => $time['rateMs']] + ($time['rateMs'] > 1 ? ['multipleOf' => $time['rateMs']] : []) + (empty($time['maxMs']) ? [] : ['maximum' => $time['maxMs']]) + ['description' => "milliseconds of line time; default {$time['unitMs']}. Buying again adds time"]]],
            'free' => false,
        ],
        'line' => [
            'builtin' => 'line',
            'description' => 'A line spends bought time without a payment per call. {"op":"open","channelId":"0x…"} returns a message to sign with the payer key; {"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"} returns the credential; {"op":"on","credential":"…"} and {"op":"off","credential":"…"} switch the channel\'s meter on and off; {"op":"status","credential":"…"} reads the line; {"op":"close","credential":"…"} ends it.',
            'inputSchema' => ['type' => 'object', 'properties' => ['op' => ['enum' => ZEAM_PASS_LINE_OPS], 'channelId' => ['type' => 'string'], 'nonce' => ['type' => 'string'], 'signature' => ['type' => 'string'], 'credential' => ['type' => 'string']], 'required' => ['op']],
            'free' => true,
        ],
    ];
}

function zeam_pass_tools()
{
    $tools = zeam_pass_builtin_tools();
    $time = zeam_pass_time_price();
    $prices = zeam_pass_opt('tool_prices', []);
    $free = zeam_pass_free_list();
    foreach ($tools as $name => $t) {
        if (is_array($prices) && isset($prices[$name]) && is_string($prices[$name]) && $prices[$name] !== '') {
            $tools[$name]['price'] = $prices[$name];
        }
        if (in_array($name, $free, true)) {
            $tools[$name]['free'] = true;
        }
    }
    $legacy = apply_filters('zeam_pass_tools', $tools);
    $legacy = is_array($legacy) ? $legacy : $tools;
    $added = apply_filters('zeam_bridge_tools', $legacy);
    $out = [];
    foreach (is_array($added) ? $added : $legacy as $name => $t) {
        if (!is_string($name) || !preg_match('/^[a-z0-9_]{1,64}$/D', $name) || !is_array($t) || in_array($name, ZEAM_PASS_TIME_TOOLS, true)) {
            continue;
        }
        unset($t['builtin']);
        if (!in_array($name, ZEAM_PASS_BUILTIN_TOOLS, true) && !(isset($t['run']) && is_callable($t['run']))) {
            continue;
        }
        $t['description'] = isset($t['description']) && is_string($t['description']) ? $t['description'] : '';
        $t['inputSchema'] = isset($t['inputSchema']) && zeam_pass_is_object($t['inputSchema']) ? $t['inputSchema'] : ['type' => 'object'];
        $t['free'] = !empty($t['free']);
        $metered = $t['meter'] ?? null;
        if ($metered !== null && ($metered !== 'time' || $time === null || $t['free'])) {
            continue;
        }
        if (!$t['free'] && zeam_pass_own_price($t)) {
            try {
                \ZeamPass\Pricing::priceOf(['price' => $t['price'] ?? null, 'unit' => $t['unit'] ?? null], zeam_pass_site_fallback());
            } catch (\InvalidArgumentException $e) {
                if (\ZeamPass\message($e) !== \ZeamPass\Pricing::NO_PRICE) {
                    continue;
                }
            }
        }
        $out[$name] = $t;
    }
    $burns = false;
    foreach ($out as $t) {
        if (($t['meter'] ?? null) === 'time') {
            $burns = true;
        }
    }
    return $time === null || !$burns ? $out : $out + zeam_pass_time_tools($time);
}

function zeam_pass_price_for($name, array $t, array $args = [])
{
    if (($t['builtin'] ?? null) === 'buy_time') {
        $time = zeam_pass_time();
        $ms = zeam_pass_bought_ms($args);
        return ['micro' => \ZeamPass\Meter\TimeMeter::micro($time, $ms), 'unitMicro' => null, 'ms' => $ms];
    }
    $p = zeam_pass_base_price($name, $t, $args);
    $time = ($t['meter'] ?? null) === 'time' ? zeam_pass_time_price() : null;
    if ($time !== null && $p['unitMicro'] === null) {
        return $p + ['rateMicro' => $time['rateMicro'], 'rateMs' => $time['rateMs']];
    }
    return $p;
}

function zeam_pass_base_price($name, array $t, array $args = [])
{
    if (zeam_pass_own_price($t)) {
        return \ZeamPass\Pricing::priceOf(['price' => $t['price'] ?? null, 'unit' => $t['unit'] ?? null], zeam_pass_site_fallback());
    }
    if (zeam_pass_prices_filtered()) {
        return \ZeamPass\Pricing::priceOf(zeam_pass_filtered_price($name, $args), zeam_pass_site_fallback());
    }
    return \ZeamPass\Pricing::priceOf(null, zeam_pass_site_fallback());
}

function zeam_pass_price_tag($name, array $t)
{
    $time = zeam_pass_time();
    if (($t['builtin'] ?? null) === 'line') {
        return ['usd' => '0', 'per' => 'call', 'free' => true];
    }
    if (($t['builtin'] ?? null) === 'buy_time') {
        return ['usd' => \ZeamPass\Pricing::usd($time['rateMicro']), 'per' => 'ms', 'ms' => $time['rateMs']] + (empty($time['maxMs']) ? [] : ['maxMs' => $time['maxMs']]);
    }
    if (($t['meter'] ?? null) === 'time' && $time !== null) {
        if (zeam_pass_prices_filtered() && !zeam_pass_own_price($t)) {
            return ['per' => 'time', 'usd' => \ZeamPass\Pricing::usd($time['rateMicro']), 'ms' => $time['rateMs'], 'varies' => true];
        }
        try {
            $p = zeam_pass_price_for($name, $t);
        } catch (\InvalidArgumentException $e) {
            return null;
        }
        return ['per' => 'time', 'usd' => \ZeamPass\Pricing::usd($time['rateMicro']), 'ms' => $time['rateMs'], 'callUSD' => \ZeamPass\Pricing::usd($p['micro']), 'callMs' => \ZeamPass\Meter\TimeMeter::callMsOf($time, $p['micro'])];
    }
    if (!empty($t['free'])) {
        return \ZeamPass\Pricing::describe(null, ['free' => true, 'perHour' => zeam_pass_free_limit()]);
    }
    if (zeam_pass_mode() === 'gate') {
        return ['usd' => '0', 'per' => 'call'];
    }
    if (!zeam_pass_own_price($t) && zeam_pass_prices_filtered()) {
        return \ZeamPass\Pricing::describe(null, ['varies' => true]);
    }
    try {
        return \ZeamPass\Pricing::describe(zeam_pass_price_for($name, $t));
    } catch (\InvalidArgumentException $e) {
        return null;
    }
}

function zeam_pass_listing()
{
    if (zeam_pass_mode() === 'gate') {
        return [];
    }
    $prices = [];
    foreach (zeam_pass_tools() as $name => $t) {
        $tag = zeam_pass_price_tag($name, $t);
        if ($tag !== null) {
            $prices[$name] = $tag;
        }
    }
    $time = zeam_pass_time();
    return $time === null ? ['prices' => $prices] : ['prices' => $prices, 'time' => \ZeamPass\Meter\TimeMeter::text($time, untrailingslashit(rest_url(ZEAM_PASS_NS))) . ZEAM_PASS_HANG_UP_TIME];
}

function zeam_pass_client_address()
{
    return isset($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : '';
}

function zeam_pass_post_view(WP_Post $post, $full)
{
    $view = [
        'id' => $post->ID,
        'title' => html_entity_decode(get_the_title($post), ENT_QUOTES),
        'url' => get_permalink($post),
        'date' => get_post_time('c', true, $post),
        'excerpt' => wp_strip_all_tags(get_the_excerpt($post)),
    ];
    if ($full) {
        $view['author'] = get_the_author_meta('display_name', $post->post_author);
        $view['text'] = trim(wp_strip_all_tags(apply_filters('the_content', $post->post_content))); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound
    }
    return $view;
}

function zeam_pass_readable($id)
{
    $post = get_post((int) $id);
    return $post instanceof WP_Post && $post->post_status === 'publish' && $post->post_type === 'post' && !post_password_required($post) ? $post : null;
}

function zeam_pass_is_object($v)
{
    return is_array($v) && ($v === [] || array_keys($v) !== range(0, count($v) - 1));
}

function zeam_pass_type_ok($type, $v)
{
    switch ($type) {
        case 'string':
            return is_string($v);
        case 'integer':
            return is_int($v) || (is_float($v) && is_finite($v) && floor($v) === $v);
        case 'number':
            return is_int($v) || is_float($v);
        case 'boolean':
            return is_bool($v);
        case 'object':
            return zeam_pass_is_object($v);
        case 'array':
            return is_array($v) && ($v === [] || array_keys($v) === range(0, count($v) - 1));
        default:
            return true;
    }
}

function zeam_pass_validate($tool, $args)
{
    $schema = zeam_pass_tools()[$tool]['inputSchema'];
    $bad = function ($message) { return ['error' => 'invalid_arguments', 'message' => $message, 'status' => 400]; };
    if (!zeam_pass_is_object($args)) {
        return $bad('the arguments must be an object');
    }
    if ((zeam_pass_tools()[$tool]['builtin'] ?? null) === 'buy_time' && is_array($args) && !array_key_exists('ms', $args)) {
        $blocks = \ZeamPass\Meter\TimeMeter::safeInt($args['blocks'] ?? null);
        if ($blocks !== null && $blocks >= 1) {
            $args['ms'] = $blocks * zeam_pass_time()['unitMs'];
        }
    }
    foreach ($schema['required'] ?? [] as $key) {
        if (!array_key_exists($key, $args)) {
            return $bad("missing required argument: {$key}");
        }
    }
    foreach ($schema['properties'] ?? [] as $key => $prop) {
        if (!array_key_exists($key, $args)) {
            continue;
        }
        $v = $args[$key];
        if (isset($prop['type']) && !zeam_pass_type_ok($prop['type'], $v)) {
            return $bad("argument {$key} must be {$prop['type']}");
        }
        if (isset($prop['enum']) && is_array($prop['enum']) && !in_array(wp_json_encode($v), array_map('wp_json_encode', $prop['enum']), true)) {
            return $bad("argument {$key} must be one of " . wp_json_encode(array_values($prop['enum']), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        }
        if (isset($prop['minimum']) && (is_int($v) || is_float($v)) && $v < $prop['minimum']) {
            return $bad("argument {$key} must be at least {$prop['minimum']}");
        }
        if (isset($prop['maximum']) && (is_int($v) || is_float($v)) && $v > $prop['maximum']) {
            return $bad("argument {$key} must be at most {$prop['maximum']}");
        }
        if (isset($prop['multipleOf']) && $prop['multipleOf'] > 0 && (is_int($v) || is_float($v)) && fmod((float) $v, (float) $prop['multipleOf']) !== 0.0) {
            return $bad("argument {$key} must be a multiple of {$prop['multipleOf']}");
        }
        $length = is_string($v) ? (function_exists('mb_strlen') ? mb_strlen($v, 'UTF-8') : strlen($v)) : null;
        if (isset($prop['minLength']) && $length !== null && $length < $prop['minLength']) {
            return $bad("argument {$key} must be at least {$prop['minLength']} character" . ($prop['minLength'] === 1 ? '' : 's'));
        }
        if (isset($prop['maxLength']) && $length !== null && $length > $prop['maxLength']) {
            return $bad("argument {$key} must be at most {$prop['maxLength']} characters");
        }
        if (isset($prop['pattern']) && is_string($v) && preg_match('/' . str_replace('/', '\\/', $prop['pattern']) . '/u', $v) !== 1) {
            return $bad("argument {$key} must match the pattern {$prop['pattern']}");
        }
    }
    return null;
}

function zeam_pass_precheck($tool, array $args)
{
    if ($tool === 'read_post' && !zeam_pass_readable($args['id'] ?? 0)) {
        return ['error' => 'not_found', 'message' => 'no published post with that id', 'status' => 404];
    }
    return null;
}

function zeam_pass_run($tool, array $args, ?ZeamPassMeter $meter = null)
{
    $tools = zeam_pass_tools();
    if (($tools[$tool]['builtin'] ?? null) === 'buy_time') {
        $time = zeam_pass_time();
        $ms = zeam_pass_bought_ms($args);
        $channelId = $meter ? $meter->channelId() : null;
        $st = zeam_pass_time_meter()->status($channelId);
        return ['channelId' => $channelId, 'boughtMs' => $ms, 'msRemaining' => $st['msRemaining'] + $ms, 'paidUSD' => \ZeamPass\Pricing::usd(\ZeamPass\Meter\TimeMeter::micro($time, $ms))];
    }
    if (isset($tools[$tool]['run']) && is_callable($tools[$tool]['run'])) {
        return call_user_func($tools[$tool]['run'], $args, $meter ?: new ZeamPassMeter());
    }
    if ($tool === 'search_posts') {
        $q = sanitize_text_field((string) $args['q']);
        $page = max(1, (int) ($args['page'] ?? 1));
        $found = new WP_Query(['s' => $q, 'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 10, 'paged' => $page, 'has_password' => false]);
        $posts = [];
        foreach ($found->posts as $p) {
            if ($p instanceof WP_Post) {
                $posts[] = zeam_pass_post_view($p, false);
            }
        }
        return ['query' => $q, 'page' => $page, 'total' => (int) $found->found_posts, 'posts' => $posts];
    }
    if ($tool === 'read_post') {
        $post = zeam_pass_readable($args['id'] ?? 0);
        if (!$post) {
            return new WP_Error('not_found', 'no published post with that id', ['status' => 404]);
        }
        return zeam_pass_post_view($post, true);
    }
    return new WP_Error('unknown_tool', 'no such tool', ['status' => 404]);
}

function zeam_pass_run_safely($tool, array $args, ?ZeamPassMeter $meter = null)
{
    try {
        $out = zeam_pass_run($tool, $args, $meter);
    } catch (Throwable $e) {
        return new WP_Error('tool_failed', 'the tool failed', ['status' => 500]);
    }
    if (is_array($out) && json_encode($out) === false) {
        return new WP_Error('tool_failed', ZEAM_PASS_RESULT_NOT_JSON, ['status' => 500]);
    }
    return is_array($out) ? $out : (is_wp_error($out) ? $out : new WP_Error('tool_failed', 'the tool failed', ['status' => 500]));
}

function zeam_pass_refusal($status, array $body, array $headers = [])
{
    return ['delivered' => false, 'status' => $status, 'headers' => $headers, 'body' => $body];
}

function zeam_pass_first_header(array $headers, array $names)
{
    foreach ($names as $n) {
        if (isset($headers[$n]) && is_string($headers[$n]) && trim($headers[$n]) !== '') {
            return trim($headers[$n]);
        }
    }
    return '';
}

function zeam_pass_probe(array $t, $args, $payment, $line)
{
    return $payment === '' && $args === [] && !isset($t['builtin']) && empty($t['free']) && !(($t['meter'] ?? null) === 'time' && $line !== '');
}

function zeam_pass_serve($tool, $path, $resource, $args, array $payment_headers, $who = '')
{
    $t = zeam_pass_tools()[$tool];
    $line = zeam_pass_first_header($payment_headers, ['x-line']);
    $payment = zeam_pass_first_header($payment_headers, ['payment-signature', 'x-payment']);
    $offered = zeam_pass_first_header($payment_headers, ['payment-authorization', 'authorization']);
    $credential = $payment === '' && \ZeamPass\Settlement\Mpp::credentialIs($offered) ? $offered : '';
    $bad = zeam_pass_validate($tool, $args);
    if (!$bad) {
        $bad = zeam_pass_precheck($tool, $args);
    }
    $probe = $bad && zeam_pass_probe($t, $args, $payment !== '' ? $payment : ($credential !== '' ? 'paid' : ''), $line);
    if ($bad) {
        $bad = ['status' => $bad['status'], 'body' => ['error' => $bad['error'], 'tool' => $tool] + array_diff_key($bad, ['status' => true])];
    }
    if ($bad && !$probe) {
        return zeam_pass_refusal($bad['status'], $bad['body']) + ['arguments' => true];
    }
    if (!zeam_pass_ready()) {
        return zeam_pass_refusal(503, ['error' => 'not_ready', 'message' => 'this site has not finished setting up ZEAM Bridge']);
    }
    if (($t['builtin'] ?? null) === 'line') {
        return zeam_pass_serve_line_op($args, $line, strpos((string) $path, 'mcp:') === 0);
    }
    if (!empty($t['free'])) {
        return zeam_pass_serve_free($tool, $args, (string) $who);
    }
    $grant = zeam_pass_first_header($payment_headers, ['x-grant']);
    $res = zeam_pass_resource($tool, $resource);
    $timed = ($t['meter'] ?? null) === 'time';
    try {
        if ($timed && $line !== '') {
            return zeam_pass_serve_on_line($tool, $args, $line);
        }
        if (zeam_pass_mode() === 'gate') {
            return zeam_pass_serve_gate($tool, $res, $args, $payment, $grant);
        }
        try {
            $price = zeam_pass_price_for($tool, $t, $args);
        } catch (Throwable $e) {
            return $probe ? zeam_pass_refusal($bad['status'], $bad['body']) + ['arguments' => true] : zeam_pass_refusal(500, ['error' => 'price_invalid', 'tool' => $tool, 'message' => \ZeamPass\message($e)]);
        }
        return zeam_pass_serve_paid($tool, $res, $args, $payment, $grant, zeam_pass_mode() === 'both', $price, $timed ? zeam_pass_time_meter()->callMs($price['micro']) : null, \ZeamPass\Bazaar::extension(['name' => $tool] + $t, strpos((string) $path, 'mcp:') === 0 ? 'mcp' : 'http'), $credential);
    } catch (Throwable $e) {
        return zeam_pass_refusal(503, ['error' => 'payment_unavailable', 'message' => 'the payment check failed; nothing was charged. Retry.']);
    }
}

function zeam_pass_decode_header($value)
{
    $decoded = json_decode((string) base64_decode((string) $value, true), true);
    return is_array($decoded) ? $decoded : null;
}

function zeam_pass_http(WP_REST_Request $request)
{
    $tool = (string) $request['tool'];
    $tools = zeam_pass_tools();
    if (!isset($tools[$tool]) && $tool === 'line') {
        $l = zeam_pass_line_op(null);
        return new WP_REST_Response($l['body'], $l['status']);
    }
    if (!isset($tools[$tool])) {
        return new WP_REST_Response(['error' => 'unknown_tool', 'message' => 'no tool named ' . $tool . ' here; tools lists the ones there are', 'tool' => $tool, 'tools' => array_keys($tools)], 404);
    }
    $raw = trim((string) $request->get_body());
    $args = $raw === '' ? [] : json_decode($raw, true);
    if ($raw !== '' && json_last_error() !== JSON_ERROR_NONE) {
        return new WP_REST_Response(['error' => 'invalid_arguments', 'tool' => $tool, 'message' => 'the body is not JSON'], 400);
    }
    if ($raw !== '' && !(json_decode($raw) instanceof stdClass)) {
        return new WP_REST_Response(['error' => 'invalid_arguments', 'tool' => $tool, 'message' => 'the arguments must be an object'], 400);
    }
    $s = zeam_pass_serve($tool, '/v1/' . $tool, rest_url(ZEAM_PASS_NS . '/v1/' . $tool), $args, [
        'payment-signature' => $request->get_header('payment_signature'),
        'x-payment' => $request->get_header('x_payment'),
        'x-grant' => $request->get_header('x_grant'),
        'x-line' => $request->get_header('x_line'),
        'authorization' => $request->get_header('authorization'),
        'payment-authorization' => $request->get_header('payment_authorization'),
    ], zeam_pass_client_address());
    $response = new WP_REST_Response($s['body'], $s['status']);
    foreach ($s['headers'] as $k => $v) {
        $response->header($k, $v);
    }
    if (is_array($s['body']) && is_string($s['body']['type'] ?? null) && strpos($s['body']['type'], \ZeamPass\Settlement\Mpp::PROBLEM) === 0) {
        $response->header('Content-Type', 'application/problem+json');
    }
    return $response;
}

function zeam_pass_mpp_meta(array $s)
{
    try {
        $required = \ZeamPass\Settlement\Mpp::mcpRequired($s['headers']['WWW-Authenticate'] ?? null, $s['body'] ?? null);
    } catch (\ZeamPass\Settlement\MppException $e) {
        $required = null;
    }
    return $required === null ? [] : ['_meta' => [\ZeamPass\Settlement\Mpp::REQUIRED => $required]];
}

function zeam_pass_mcp_error(array $body)
{
    $out = ['isError' => true, 'content' => [['type' => 'text', 'text' => wp_json_encode($body, \ZeamPass\Settlement\Json::WIRE)]]];
    if (zeam_pass_is_object($body) && $body !== []) {
        $out['structuredContent'] = $body;
    }
    return $out;
}

function zeam_pass_mcp_call(array $params, $listed = false)
{
    $tool = (string) $params['name'];
    $tools = zeam_pass_tools();
    if (!isset($tools[$tool])) {
        return zeam_pass_mcp_error(['error' => 'unknown_tool', 'message' => 'no tool named ' . $tool . ' here; tools lists the ones there are', 'tool' => $tool, 'tools' => array_keys($tools)]);
    }
    if ($listed || (isset($params['arguments']) && !zeam_pass_is_object($params['arguments']))) {
        return zeam_pass_mcp_error(['error' => 'invalid_arguments', 'tool' => $tool, 'message' => 'the arguments must be an object']);
    }
    $args = $params['arguments'] ?? [];
    $payment = $params['_meta'][ZEAM_PASS_META_PAYMENT] ?? null;
    $paying = $payment !== null && $payment !== false && $payment !== 0 && $payment !== 0.0 && $payment !== '';
    $line = isset($params['_meta'][ZEAM_PASS_META_LINE]) && is_string($params['_meta'][ZEAM_PASS_META_LINE]) && trim($params['_meta'][ZEAM_PASS_META_LINE]) !== '' ? $params['_meta'][ZEAM_PASS_META_LINE] : zeam_pass_request_line();
    $s = zeam_pass_serve($tool, 'mcp:' . $tool, rest_url(ZEAM_PASS_NS . '/mcp'), $args, ['payment-signature' => $paying ? base64_encode(wp_json_encode($payment)) : null, 'x-grant' => zeam_pass_request_grant(), 'x-line' => $line, 'authorization' => $paying ? null : \ZeamPass\Settlement\Mpp::mcpHeader($params['_meta'] ?? null)], zeam_pass_client_address());
    $read = isset($s['meter']) ? ['_meta' => [ZEAM_PASS_META_METER => $s['meter']]] : [];
    if (isset($s['mcpBody'])) {
        return ['isError' => true, 'structuredContent' => $s['mcpBody'], 'content' => [['type' => 'text', 'text' => wp_json_encode($s['mcpBody'], \ZeamPass\Settlement\Json::WIRE)]]] + $read;
    }
    if (!$s['delivered']) {
        $mpp = array_merge_recursive(zeam_pass_mpp_meta($s), $read);
        $required = zeam_pass_decode_header($s['headers']['PAYMENT-REQUIRED'] ?? '') ?: (isset($s['body']['accepts']) ? $s['body'] : null);
        if (!$required && $s['status'] === 402) {
            $required = array_merge(['x402Version' => 2, 'accepts' => []], $s['body']);
        }
        if ($required) {
            $required = array_merge(['x402Version' => 2], $s['body'], $required);
            return ['isError' => true, 'structuredContent' => $required, 'content' => [['type' => 'text', 'text' => wp_json_encode($required, \ZeamPass\Settlement\Json::WIRE)]]] + $mpp;
        }
        if (!empty($s['arguments']) || !zeam_pass_is_object($s['body']) || $s['body'] === []) {
            return zeam_pass_mcp_error($s['body']) + $mpp;
        }
        return ['isError' => true, 'structuredContent' => $s['body'], 'content' => [['type' => 'text', 'text' => wp_json_encode($s['body'], \ZeamPass\Settlement\Json::WIRE)]]] + $mpp;
    }
    $result = ['content' => [['type' => 'text', 'text' => wp_json_encode($s['body'], \ZeamPass\Settlement\Json::WIRE)]], 'structuredContent' => $s['body']];
    $meta = [];
    $settled = zeam_pass_decode_header($s['headers']['PAYMENT-RESPONSE'] ?? '');
    if ($settled) {
        $meta[ZEAM_PASS_META_RESPONSE] = $settled;
    }
    if (isset($s['headers'][ZEAM_PASS_GRANTED_BY]) && is_string($s['headers'][ZEAM_PASS_GRANTED_BY])) {
        $meta[ZEAM_PASS_META_GRANTED_BY] = $s['headers'][ZEAM_PASS_GRANTED_BY];
    }
    if (isset($s['meter'])) {
        $meta[ZEAM_PASS_META_METER] = $s['meter'];
    }
    if (isset($s['headers']['Payment-Receipt']) && is_string($s['headers']['Payment-Receipt'])) {
        try {
            $meta[\ZeamPass\Settlement\Mpp::RECEIPT] = \ZeamPass\Settlement\Mpp::receiptParse($s['headers']['Payment-Receipt']);
        } catch (\ZeamPass\Settlement\MppException $e) {
            unset($meta[\ZeamPass\Settlement\Mpp::RECEIPT]);
        }
    }
    if ($meta) {
        $result['_meta'] = $meta;
    }
    return $result;
}

function zeam_pass_bad_params($msg)
{
    $params = $msg['params'] ?? null;
    if (array_key_exists('params', $msg) && !zeam_pass_is_object($params)) {
        return 'params must be an object';
    }
    if ($msg['method'] !== 'tools/call') {
        return null;
    }
    if (!is_string($params['name'] ?? null) || $params['name'] === '') {
        return 'params.name must be a string';
    }
    if (array_key_exists('_meta', $params) && !zeam_pass_is_object($params['_meta'])) {
        return 'params._meta must be an object';
    }
    return null;
}

function zeam_pass_takes_mpp()
{
    if (zeam_pass_mode() === 'gate') {
        return false;
    }
    try {
        return zeam_pass_engine()['server']->mppAsset() !== null;
    } catch (\Throwable $e) {
        return false;
    }
}

function zeam_pass_mcp_declares($params)
{
    return zeam_pass_is_object($params) && \ZeamPass\Settlement\Mpp::mcpDeclares($params['capabilities'] ?? null) && zeam_pass_takes_mpp();
}

function zeam_pass_mcp_session($body)
{
    if (!zeam_pass_is_object($body) || $body === [] || ($body['method'] ?? null) !== 'initialize' || !array_key_exists('id', $body)) {
        return null;
    }
    return zeam_pass_mcp_declares($body['params'] ?? null) ? \ZeamPass\Settlement\Mpp::mcpSession() : 'mcp.' . rtrim(strtr(base64_encode(random_bytes(12)), '+/', '-_'), '=');
}

function zeam_pass_mcp_opens($request)
{
    if (!($request instanceof WP_REST_Request) || $request->get_method() !== 'POST' || zeam_pass_route($request) !== '/mcp') {
        return false;
    }
    $body = json_decode($request->get_body(), true);
    return zeam_pass_is_object($body) && $body !== [] && ($body['method'] ?? null) === 'initialize' && array_key_exists('id', $body);
}

function zeam_pass_mcp_canceled(array $msg)
{
    $params = $msg['params'] ?? null;
    if ($msg['method'] !== 'notifications/cancelled' || !zeam_pass_is_object($params)) {
        return;
    }
    $key = zeam_pass_call_key($params['requestId'] ?? null);
    $meta = $params['_meta'] ?? null;
    $by = zeam_pass_callers(is_array($meta) ? ($meta[ZEAM_PASS_META_LINE] ?? null) : null);
    if ($key === null || $by === []) {
        return;
    }
    try {
        zeam_pass_call_cancel($key, $by);
    } catch (Throwable $e) {
        return;
    }
}

function zeam_pass_request_payment($set = null)
{
    static $payment = false;
    if ($set !== null) {
        $payment = (bool) $set;
    }
    return $payment;
}

function zeam_pass_mcp_listed($shape)
{
    return $shape instanceof stdClass && ($shape->params ?? null) instanceof stdClass && property_exists($shape->params, 'arguments') && $shape->params->arguments !== null && !($shape->params->arguments instanceof stdClass);
}

function zeam_pass_mcp_one($msg, $shape = null)
{
    if (!zeam_pass_is_object($msg) || ($msg['jsonrpc'] ?? '') !== '2.0' || !is_string($msg['method'] ?? null)) {
        return ['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => 'invalid request']];
    }
    if (!array_key_exists('id', $msg)) {
        zeam_pass_mcp_canceled($msg);
        return null;
    }
    $id = is_string($msg['id']) || is_int($msg['id']) || is_float($msg['id']) ? $msg['id'] : null;
    $fail = function ($code, $message) use ($id) { return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $message]]; };
    $reply = function ($result) use ($id) { return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result]; };
    $invalid = zeam_pass_bad_params($msg);
    if ($invalid) {
        return $fail(-32602, $invalid);
    }
    $params = $msg['params'] ?? [];
    try {
        switch ($msg['method']) {
            case 'initialize':
                $asked = $params['protocolVersion'] ?? '';
                $known = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
                return $reply(['protocolVersion' => in_array($asked, $known, true) ? $asked : $known[0], 'capabilities' => ['tools' => (object) []] + (zeam_pass_mcp_declares($params) && zeam_pass_sells_by_charge() ? ['experimental' => ['payment' => \ZeamPass\Settlement\Mpp::mcpCapability()]] : []), 'serverInfo' => ['name' => zeam_pass_site_name(), 'version' => ZEAM_PASS_VERSION]]);
            case 'ping':
                return $reply((object) []);
            case 'tools/list':
                $list = [];
                foreach (zeam_pass_tools() as $name => $t) {
                    $entry = ['name' => $name, 'description' => $t['description'], 'inputSchema' => $t['inputSchema']];
                    $tag = zeam_pass_price_tag($name, $t);
                    if ($tag !== null) {
                        $entry['_meta'] = [ZEAM_PASS_META_PRICE => $tag];
                    }
                    $list[] = $entry;
                }
                return $reply(['tools' => $list]);
            case 'tools/call':
                $asked = \ZeamPass\Settlement\Mpp::mcpParams($msg);
                zeam_pass_request_call(['key' => zeam_pass_call_key($msg['id']), 'by' => zeam_pass_callers($asked['_meta'][ZEAM_PASS_META_LINE] ?? null)]);
                try {
                    $out = zeam_pass_mcp_call($asked, zeam_pass_mcp_listed($shape));
                } finally {
                    zeam_pass_request_call(null);
                }
                $unpaid = zeam_pass_request_payment() ? \ZeamPass\Settlement\Mpp::mcpError($out['_meta'][\ZeamPass\Settlement\Mpp::REQUIRED] ?? null, $out['structuredContent'] ?? null) : null;
                return $unpaid === null ? $reply($out) : ['jsonrpc' => '2.0', 'id' => $id, 'error' => $unpaid];
            default:
                return $fail(-32601, 'method not found');
        }
    } catch (Throwable $e) {
        return $fail(-32603, 'internal error');
    }
}

function zeam_pass_request_grant($set = null)
{
    static $grant = null;
    if ($set !== null) {
        $grant = (string) $set;
    }
    return $grant;
}

function zeam_pass_request_line($set = null)
{
    static $line = '';
    if ($set !== null) {
        $line = (string) $set;
    }
    return $line;
}

function zeam_pass_request_session($set = null)
{
    static $session = '';
    if ($set !== null) {
        $session = (string) $set;
    }
    return $session;
}

function zeam_pass_request_call(...$set)
{
    static $call = null;
    if ($set) {
        $call = $set[0];
    }
    return $call;
}

function zeam_pass_mcp(WP_REST_Request $request)
{
    zeam_pass_request_grant((string) $request->get_header('x_grant'));
    zeam_pass_request_line((string) $request->get_header('x_line'));
    zeam_pass_request_session((string) $request->get_header('mcp_session_id'));
    zeam_pass_request_payment(\ZeamPass\Settlement\Mpp::mcpInSession((string) $request->get_header('mcp_session_id')) && zeam_pass_takes_mpp());
    $body = json_decode($request->get_body(), true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        return new WP_REST_Response(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32700, 'message' => 'parse error']], 400);
    }
    if (!is_array($body) || $body === []) {
        return new WP_REST_Response(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => 'invalid request']], 400);
    }
    $batch = !zeam_pass_is_object($body);
    $shape = json_decode($request->get_body());
    $answers = array_values(array_filter(array_map('zeam_pass_mcp_one', $batch ? $body : [$body], $batch && is_array($shape) ? $shape : [$shape])));
    if (!$answers) {
        return new WP_REST_Response(null, 202);
    }
    $response = new WP_REST_Response($batch ? $answers : $answers[0], 200);
    $session = $batch ? null : zeam_pass_mcp_session($body);
    if ($session !== null) {
        $response->header('Mcp-Session-Id', $session);
    }
    return $response;
}

function zeam_pass_mcp_get()
{
    $response = new WP_REST_Response(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32000, 'message' => 'method not allowed: POST JSON-RPC to this address']], 405);
    $response->header('Allow', 'POST');
    return $response;
}

add_filter('rest_pre_dispatch', function ($result, $server, $request) {
    return $result === null && $request->get_method() === 'GET' && zeam_pass_route($request) === '/mcp' ? zeam_pass_mcp_get() : $result;
}, 10, 3);

function zeam_pass_reads_its_own_body($request)
{
    $route = zeam_pass_route($request);
    return $route !== null && (in_array($route, ['/mcp', '/refund', '/line'], true) || preg_match('#^/v1/[a-z0-9_]+$#D', $route) === 1);
}

add_filter('rest_request_before_callbacks', function ($response, $handler, $request) {
    if (is_wp_error($response) && $response->get_error_code() === 'rest_invalid_json' && zeam_pass_reads_its_own_body($request)) {
        return null;
    }
    return $response;
}, 10, 3);

function zeam_pass_refund_route(WP_REST_Request $request)
{
    $raw = (string) $request->get_body();
    $shape = json_decode($raw);
    if (json_last_error() !== JSON_ERROR_NONE) {
        return new WP_REST_Response(['op' => 'refund_failed', 'code' => 'invalid_json', 'why' => 'the body is not JSON'], 400);
    }
    $body = json_decode($raw, true);
    if (!($shape instanceof stdClass) || !is_array($body)) {
        return new WP_REST_Response(['op' => 'refund_failed', 'code' => 'invalid_request', 'why' => 'expected { channelId, issued, signature }, optional selfSend or gasPayment'], 400);
    }
    try {
        $r = zeam_pass_refund($body);
    } catch (Throwable $e) {
        $r = ['status' => 503, 'body' => ['op' => 'refund_failed', 'code' => 'refund_unavailable', 'why' => 'the refund could not be handled right now', 'retry_after_seconds' => 5]];
    }
    if (!isset($r['turn'])) {
        return new WP_REST_Response($r['body'], $r['status']);
    }
    $response = new WP_REST_Response($r['body'] + ['turn' => (int) $r['turn']], $r['status']);
    $response->header('Zeam-Refund-Turn', (string) (int) $r['turn']);
    return $response;
}

function zeam_pass_line_route(WP_REST_Request $request)
{
    if (zeam_pass_time() === null) {
        $l = zeam_pass_line_op(null);
        return new WP_REST_Response($l['body'], $l['status']);
    }
    $body = json_decode((string) $request->get_body(), true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        return new WP_REST_Response(['op' => 'line_failed', 'code' => 'bad_request', 'why' => 'the body is not JSON'], 400);
    }
    try {
        $l = zeam_pass_line_op($body, trim((string) $request->get_header('x_line')));
    } catch (Throwable $e) {
        $l = ['status' => 503, 'body' => ['op' => 'line_failed', 'code' => 'line_unavailable', 'why' => 'the line could not be read right now. Retry.']];
    }
    return new WP_REST_Response($l['body'], $l['status']);
}

function zeam_pass_own_route($request)
{
    return !($request instanceof WP_REST_Request) || zeam_pass_route($request) !== null;
}

add_filter('rest_allowed_cors_headers', function ($headers, $request = null) {
    return zeam_pass_own_route($request) ? array_values(array_unique(array_merge($headers, ['payment-signature', 'x-payment', 'authorization', 'payment-authorization', 'x-grant', 'x-line', 'mcp-protocol-version', 'mcp-session-id']))) : $headers;
}, 10, 2);

add_filter('rest_exposed_cors_headers', function ($headers, $request = null) {
    return zeam_pass_own_route($request) ? array_values(array_unique(array_merge($headers, ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'WWW-Authenticate', 'Payment-Receipt', 'X-Pass-Granted-By', 'X-Pass-Ms-Remaining', 'X-Pass-Ms-Elapsed'], zeam_pass_mcp_opens($request) ? ['Mcp-Session-Id'] : [], zeam_pass_route($request) === '/refund' ? ['Zeam-Refund-Turn'] : []))) : $headers;
}, 10, 2);

function zeam_pass_sells_by_charge()
{
    if (zeam_pass_mpp_offers() !== []) {
        return true;
    }
    if (!zeam_pass_prices_filtered()) {
        return false;
    }
    foreach (zeam_pass_tools() as $t) {
        if (empty($t['free']) && empty($t['builtin']) && !zeam_pass_own_price($t)) {
            return true;
        }
    }
    return false;
}

function zeam_pass_mpp_offers()
{
    if (zeam_pass_mode() === 'gate') {
        return [];
    }
    try {
        $server = zeam_pass_engine()['server'];
    } catch (\Throwable $e) {
        return [];
    }
    $offers = [];
    foreach (zeam_pass_tools() as $name => $t) {
        if (!empty($t['free']) || (!zeam_pass_own_price($t) && zeam_pass_prices_filtered())) {
            continue;
        }
        try {
            $offer = $server->mppOffer(zeam_pass_price_for($name, $t), $t['description'] ?? null);
        } catch (\Throwable $e) {
            $offer = null;
        }
        if ($offer !== null) {
            $offers[$name] = $offer;
        }
    }
    return $offers;
}

function zeam_pass_openapi($mount = null)
{
    $paths = [];
    $limit = zeam_pass_free_limit();
    $unready = "this site's setup is incomplete (error not_ready)";
    $unavailable = (zeam_pass_mode() === 'gate' ? 'the check failed (error payment_unavailable), this gate has no checks left this month (error gate_credit_exhausted)' : 'the payment check or settlement failed (error payment_unavailable)') . ", or {$unready}; nothing is charged. Retry later";
    foreach (zeam_pass_tools() as $name => $t) {
        $timed = ($t['meter'] ?? null) === 'time';
        $missing = $name === 'read_post' ? ['404' => ['description' => 'no published post with that id' . (empty($t['free']) ? '; nothing is charged' : '')]] : [];
        $responses = !empty($t['free'])
            ? ['200' => ['description' => 'the result'], '400' => ['description' => 'invalid arguments'], '500' => ['description' => 'the tool failed']] + $missing + ($limit && empty($t['builtin']) ? ['429' => ['description' => "over {$limit} free calls an hour per address"]] : []) + ['503' => ['description' => "{$unready}. Retry later"]]
            : ['200' => ['description' => 'the result'], '400' => ['description' => zeam_pass_mode() === 'gate' ? 'invalid arguments; nothing is charged' : 'invalid arguments (error invalid_arguments), or a payment that does not decode (error bad_payment_header) or is neither a voucher nor a deposit (error bad_payment_type); nothing is charged']] + $missing + ['402' => ['description' => zeam_pass_mode() === 'gate' ? 'a zero-value x402 signature is required; nothing is paid' : ((($t['builtin'] ?? null) === 'buy_time' || ((zeam_pass_price_tag($name, $t) ?? [])['per'] ?? null) === 'unit' ? 'x402 payment required' : 'payment required: x402, or MPP when the 402 carries a Payment challenge') . ($timed ? '; on a line, the meter is off (error meter_off), the line is out of time (error out_of_time) or the channel is withdrawing (error channel_leaving)' : '') . '; a refund settling on the channel answers refund_settling')], '403' => ['description' => 'key not admitted' . ($timed ? '; on a line, no line with that credential (error line_unknown)' : '')], '499' => ['description' => 'the caller hung up or canceled the call, so it was stopped (error client_gone); nothing is charged' . ($timed ? ' per call, and on a line the line is billed for the time the call ran' : '')], '500' => ['description' => 'the tool failed; nothing is charged per call' . ($timed ? ', and on a line the call has used the time it ran' : '')], '503' => ['description' => $unavailable]] + ($timed ? ['429' => ['description' => 'too many calls are live on the line (error too_many_calls)']] : []);
        if ($name === 'line') {
            $responses = ['200' => $responses['200'], '400' => ['description' => 'invalid arguments (error invalid_arguments), or a step refused (op line_failed, with code and why)'], '402' => ['description' => 'a refund settling on the channel answers refund_settling; "on" while a refund asked for on the channel is being worked out answers refund_pending'], '403' => ['description' => "no line with that credential, or the proof is not the payer's"], '404' => ['description' => 'no channel with that id here, or this seller sells no line time'], '409' => ['description' => 'the channel is leaving; code and why say so'], '500' => $responses['500'], '503' => ['description' => "the line could not be read right now (code line_unavailable; nothing changed, send it again), or {$unready}"]];
        }
        $op = ['operationId' => $name, 'summary' => $t['description']];
        $tag = zeam_pass_price_tag($name, $t);
        if ($tag !== null) {
            $op['x-price'] = $tag;
        }
        $paths['/v1/' . $name] = ['post' => $op + ['requestBody' => ['required' => true, 'content' => ['application/json' => ['schema' => $t['inputSchema']]]], 'responses' => $responses]];
    }
    $how = ['paywall' => 'Paid per call with x402 or MPP', 'gate' => 'Admitted keys only, proven by a zero-value x402 signature; nothing is paid', 'both' => 'Admitted keys only, paid per call with x402 or MPP'][zeam_pass_mode()];
    $contact = zeam_pass_contact();
    $reach = stripos($contact, 'mailto:') === 0 ? ['email' => substr($contact, 7)] : ['url' => $contact];
    $doc = ['openapi' => '3.0.3', 'info' => ['title' => zeam_pass_site_name(), 'version' => ZEAM_PASS_VERSION, 'description' => $how . '. MCP: ' . rest_url(ZEAM_PASS_NS . '/mcp'), 'contact' => $reach], 'servers' => [['url' => untrailingslashit(rest_url(ZEAM_PASS_NS))]], 'paths' => $paths];
    $home = untrailingslashit(home_url());
    return $mount === null ? \ZeamPass\Discovery::document($doc, zeam_pass_mpp_offers(), $home) : \ZeamPass\Discovery::document($doc, zeam_pass_mpp_offers(), $home, $home, $mount);
}

function zeam_pass_openapi_route()
{
    return zeam_pass_openapi();
}

function zeam_pass_root_mount()
{
    $home = wp_parse_url(home_url('/'));
    $rest = wp_parse_url(untrailingslashit(rest_url(ZEAM_PASS_NS)));
    if (!is_array($home) || !is_array($rest) || !empty($rest['query']) || empty($rest['path']) || trim($home['path'] ?? '', '/') !== '') {
        return null;
    }
    return $rest['path'];
}

add_filter('rest_json_encode_options', function ($options, $request = null) {
    return $request instanceof WP_REST_Request && zeam_pass_route($request) !== null ? ((int) $options) | \ZeamPass\Settlement\Json::WIRE : $options;
}, 10, 2);

add_filter('rest_post_dispatch', function ($response, $server = null, $request = null) {
    if ($request instanceof WP_REST_Request && $response instanceof WP_REST_Response && in_array($request->get_route(), ['/' . ZEAM_PASS_NS . '/openapi.json', '/' . ZEAM_BRIDGE_NS . '/openapi.json'], true)) {
        $response->header('Cache-Control', \ZeamPass\Discovery::CACHE_CONTROL);
    }
    return $response;
}, 10, 3);

add_action('parse_request', function () {
    $method = isset($_SERVER['REQUEST_METHOD']) ? sanitize_text_field(wp_unslash($_SERVER['REQUEST_METHOD'])) : '';
    $path = isset($_SERVER['REQUEST_URI']) ? wp_parse_url(sanitize_text_field(wp_unslash($_SERVER['REQUEST_URI'])), PHP_URL_PATH) : null;
    if ($method !== 'GET' || $path !== '/openapi.json' || zeam_pass_opt('no_root_openapi') || zeam_pass_payout() === '' || !(zeam_pass_mode() === 'gate' || zeam_pass_price_micro() > 0)) {
        return;
    }
    $mount = zeam_pass_root_mount();
    if ($mount === null) {
        return;
    }
    if (!headers_sent()) {
        header('Cache-Control: ' . \ZeamPass\Discovery::CACHE_CONTROL);
        header('Access-Control-Allow-Origin: *');
    }
    wp_send_json(zeam_pass_openapi($mount), 200, JSON_UNESCAPED_SLASHES);
}, 0);

add_action('rest_api_init', function () {
    foreach ([ZEAM_PASS_NS, ZEAM_BRIDGE_NS] as $ns) {
        register_rest_route($ns, '/mcp', ['methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'zeam_pass_mcp']);
        register_rest_route($ns, '/refund', ['methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'zeam_pass_refund_route']);
        register_rest_route($ns, '/line', ['methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'zeam_pass_line_route']);
        register_rest_route($ns, '/v1/(?P<tool>[a-z0-9_]+)', ['methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => 'zeam_pass_http']);
        register_rest_route($ns, '/openapi.json', ['methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => 'zeam_pass_openapi_route']);
    }
});

function zeam_pass_holding()
{
    return zeam_pass_opt('hold') && !current_user_can('edit_posts');
}

function zeam_pass_held_html($post)
{
    $mcp = rest_url(ZEAM_PASS_NS . '/mcp');
    $how = [
        'paywall' => __('Agents read the full text, paid per call, over MCP at', 'zeam-pass'),
        'gate' => __('Admitted agents read the full text over MCP at', 'zeam-pass'),
        'both' => __('Admitted agents read the full text, paid per call, over MCP at', 'zeam-pass'),
    ][zeam_pass_mode()];
    return wpautop(esc_html(wp_strip_all_tags(get_the_excerpt($post))))
        . '<p>' . esc_html($how) . ' <a href="' . esc_url($mcp) . '">' . esc_html($mcp) . '</a></p>';
}

function zeam_pass_hold_text($response, $post, $request)
{
    if (!zeam_pass_holding() || !($response instanceof WP_REST_Response)) {
        return $response;
    }
    $data = $response->get_data();
    if (isset($data['content']['rendered'])) {
        $data['content']['rendered'] = zeam_pass_held_html($post);
        $data['content']['held'] = true;
        $response->set_data($data);
    }
    return $response;
}
add_filter('rest_prepare_post', 'zeam_pass_hold_text', 10, 3);

add_filter('the_content_feed', function ($content) {
    return zeam_pass_holding() ? zeam_pass_held_html(get_post()) : $content;
}, PHP_INT_MAX);

add_filter('the_excerpt_rss', function ($excerpt) {
    return zeam_pass_holding() ? wp_strip_all_tags(get_the_excerpt(get_post())) : $excerpt;
}, PHP_INT_MAX);

add_filter('option_rss_use_excerpt', function ($value) {
    return is_feed() && zeam_pass_holding() ? '1' : $value;
});

add_action('wp_head', function () {
    if (zeam_pass_payout() !== '' && (zeam_pass_mode() === 'gate' || zeam_pass_price_micro() > 0)) {
        echo '<link rel="alternate" type="application/json" title="Tools for AI agents (' . (zeam_pass_mode() === 'gate' ? 'MCP and x402' : 'MCP, x402 and MPP') . ')" href="' . esc_url(rest_url(ZEAM_PASS_NS . '/openapi.json')) . '">' . "\n";
    }
});

require_once __DIR__ . '/includes/admin-actions.php';

register_activation_hook(__FILE__, 'zeam_pass_activate');
register_deactivation_hook(__FILE__, 'zeam_pass_deactivate');

function zeam_pass_activate()
{
    zeam_pass_install_tables();
    zeam_pass_ensure_keys();
    if (!wp_next_scheduled('zeam_pass_tick')) {
        wp_schedule_event(time() + 60, 'zeam_pass_minute', 'zeam_pass_tick');
    }
}

function zeam_pass_deactivate()
{
    wp_clear_scheduled_hook('zeam_pass_tick');
}

add_filter('cron_schedules', function ($schedules) {
    $schedules['zeam_pass_minute'] = ['interval' => 60, 'display' => 'Every minute (ZEAM Bridge)'];
    return $schedules;
});

add_action('zeam_pass_tick', 'zeam_pass_tick');

add_action('init', function () {
    if (get_option('zeam_pass_db') !== ZEAM_PASS_DB_VERSION) {
        zeam_pass_install_tables();
        zeam_pass_ensure_keys();
    }
    if (!wp_next_scheduled('zeam_pass_tick')) {
        wp_schedule_event(time() + 60, 'zeam_pass_minute', 'zeam_pass_tick');
    }
});
