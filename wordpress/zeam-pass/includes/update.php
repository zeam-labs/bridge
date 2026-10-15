<?php

if (!defined('ABSPATH')) {
    exit;
}

const ZEAM_PASS_UPDATE_MANIFEST = 'https://zeampass.com/downloads/zeam-pass.json';
const ZEAM_PASS_UPDATE_DOWNLOADS = 'https://zeampass.com/downloads/';
const ZEAM_PASS_UPDATE_PUBLIC_KEY = '1rw+C5T3dot/Wk1WAxdlEu6PoQfMxLRMQY8nMZkabBo=';
const ZEAM_PASS_UPDATE_CACHE = 'zeam_pass_update_manifest';
const ZEAM_PASS_UPDATE_TTL = 43200;
const ZEAM_PASS_UPDATE_SLUG = 'zeam-pass';

function zeam_pass_update_basename()
{
    return plugin_basename(dirname(__DIR__) . '/zeam-pass.php');
}

function zeam_pass_update_canonical($value)
{
    if (is_string($value)) {
        $json = wp_json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS);
        return is_string($json) ? $json : null;
    }
    if (!is_array($value) || $value === [] || array_keys($value) === range(0, count($value) - 1)) {
        return null;
    }
    ksort($value, SORT_STRING);
    $parts = [];
    foreach ($value as $key => $item) {
        $k = zeam_pass_update_canonical((string) $key);
        $v = zeam_pass_update_canonical($item);
        if ($k === null || $v === null) {
            return null;
        }
        $parts[] = $k . ':' . $v;
    }
    return '{' . implode(',', $parts) . '}';
}

function zeam_pass_update_verify($manifest, $public_key)
{
    if (!is_array($manifest) || !is_string($manifest['signature'] ?? null) || !function_exists('sodium_crypto_sign_verify_detached')) {
        return false;
    }
    $signature = base64_decode($manifest['signature'], true);
    $key = base64_decode((string) $public_key, true);
    unset($manifest['signature']);
    $bytes = zeam_pass_update_canonical($manifest);
    if ($bytes === null || !is_string($signature) || strlen($signature) !== 64 || !is_string($key) || strlen($key) !== 32) {
        return false;
    }
    try {
        return sodium_crypto_sign_verify_detached($signature, $bytes, $key);
    } catch (Throwable $e) {
        return false;
    }
}

function zeam_pass_update_valid($manifest, $public_key = ZEAM_PASS_UPDATE_PUBLIC_KEY)
{
    if (!zeam_pass_update_verify($manifest, $public_key)) {
        return null;
    }
    $version = $manifest['version'] ?? null;
    if (!is_string($version) || !preg_match('/^\d+\.\d+\.\d+$/D', $version)) {
        return null;
    }
    if (($manifest['slug'] ?? null) !== ZEAM_PASS_UPDATE_SLUG || ($manifest['package'] ?? null) !== ZEAM_PASS_UPDATE_DOWNLOADS . 'zeam-pass-' . $version . '.zip') {
        return null;
    }
    if (!is_string($manifest['sha256'] ?? null) || !preg_match('/^[0-9a-f]{64}$/D', $manifest['sha256'])) {
        return null;
    }
    if (isset($manifest['sections']) && !is_array($manifest['sections'])) {
        return null;
    }
    return $manifest;
}

function zeam_pass_update_manifest()
{
    $cached = get_transient(ZEAM_PASS_UPDATE_CACHE);
    if (is_array($cached) && array_key_exists('manifest', $cached)) {
        return is_array($cached['manifest']) ? zeam_pass_update_valid($cached['manifest']) : null;
    }
    $manifest = null;
    $response = wp_safe_remote_get(ZEAM_PASS_UPDATE_MANIFEST, ['timeout' => 5, 'limit_response_size' => 262144]);
    if (!is_wp_error($response) && (int) wp_remote_retrieve_response_code($response) === 200) {
        $manifest = zeam_pass_update_valid(json_decode((string) wp_remote_retrieve_body($response), true));
    }
    set_transient(ZEAM_PASS_UPDATE_CACHE, ['manifest' => $manifest], ZEAM_PASS_UPDATE_TTL);
    return $manifest;
}

function zeam_pass_update_item($manifest, $installed)
{
    $item = [
        'slug' => ZEAM_PASS_UPDATE_SLUG,
        'plugin' => zeam_pass_update_basename(),
        'version' => $manifest['version'],
        'new_version' => $manifest['version'],
        'url' => is_string($manifest['homepage'] ?? null) ? $manifest['homepage'] : 'https://zeambridge.com',
        'tested' => is_string($manifest['tested'] ?? null) ? $manifest['tested'] : '',
        'requires' => is_string($manifest['requires'] ?? null) ? $manifest['requires'] : '',
        'requires_php' => is_string($manifest['requires_php'] ?? null) ? $manifest['requires_php'] : '',
    ];
    if (version_compare($manifest['version'], (string) $installed, '>')) {
        $item['package'] = $manifest['package'];
    }
    return $item;
}

function zeam_pass_update_offer($update, $plugin_data, $plugin_file)
{
    if ($plugin_file !== zeam_pass_update_basename()) {
        return $update;
    }
    $manifest = zeam_pass_update_manifest();
    if ($manifest === null) {
        return $update;
    }
    return zeam_pass_update_item($manifest, is_array($plugin_data) && isset($plugin_data['Version']) ? $plugin_data['Version'] : ZEAM_PASS_VERSION);
}

function zeam_pass_update_details($result, $action, $args)
{
    if ($action !== 'plugin_information' || !is_object($args) || ($args->slug ?? '') !== ZEAM_PASS_UPDATE_SLUG) {
        return $result;
    }
    $manifest = zeam_pass_update_manifest();
    if ($manifest === null) {
        return new WP_Error('zeam_pass_update_unavailable', 'The ZEAM Bridge release details are not available right now.');
    }
    $sections = [];
    foreach ($manifest['sections'] ?? [] as $name => $html) {
        if (is_string($name) && is_string($html)) {
            $sections[sanitize_key($name)] = wp_kses_post($html);
        }
    }
    $item = zeam_pass_update_item($manifest, '0');
    return (object) [
        'name' => 'ZEAM Bridge',
        'slug' => ZEAM_PASS_UPDATE_SLUG,
        'version' => $manifest['version'],
        'author' => '<a href="https://www.zeamlabs.com">ZEAM Labs, LLC</a>',
        'homepage' => $item['url'],
        'requires' => $item['requires'],
        'tested' => $item['tested'],
        'requires_php' => $item['requires_php'],
        'download_link' => $manifest['package'],
        'sections' => $sections,
    ];
}

function zeam_pass_update_download($reply, $package, $upgrader = null, $hook_extra = [])
{
    $ours = (is_array($hook_extra) && ($hook_extra['plugin'] ?? null) === zeam_pass_update_basename()) || strpos((string) $package, ZEAM_PASS_UPDATE_DOWNLOADS) === 0;
    if (!$ours || is_wp_error($reply)) {
        return $reply;
    }
    $manifest = zeam_pass_update_manifest();
    if ($manifest === null) {
        return new WP_Error('zeam_pass_update_unverified', 'There is no signed ZEAM Bridge release to check this download against. Nothing was installed.');
    }
    if ($package !== $manifest['package']) {
        return new WP_Error('zeam_pass_update_package', 'This download is not the signed ZEAM Bridge release. Nothing was installed.');
    }
    $file = is_string($reply) && $reply !== '' && is_file($reply) ? $reply : download_url($package, 300);
    if (is_wp_error($file)) {
        return $file;
    }
    if (!hash_equals($manifest['sha256'], (string) hash_file('sha256', $file))) {
        wp_delete_file($file);
        return new WP_Error('zeam_pass_update_checksum', 'The download does not match the signed ZEAM Bridge release. Nothing was installed.');
    }
    return $file;
}

function zeam_pass_update_request_args($args, $url)
{
    if (is_array($args) && strpos((string) $url, ZEAM_PASS_UPDATE_DOWNLOADS) === 0) {
        $args['user-agent'] = 'WordPress';
    }
    return $args;
}

add_filter('http_request_args', 'zeam_pass_update_request_args', 10, 2);
add_filter('update_plugins_zeampass.com', 'zeam_pass_update_offer', 10, 3);
add_filter('plugins_api', 'zeam_pass_update_details', 10, 3);
add_filter('upgrader_pre_download', 'zeam_pass_update_download', 999, 4);
