<?php

if (!defined('ABSPATH')) {
    exit;
}

const ZEAM_PASS_SECRETS = 'zeam_pass_secrets';

function zeam_pass_dedicated_keys()
{
    $keys = [];
    foreach (['ZEAM_BRIDGE_KEY', 'ZEAM_PASS_KEY'] as $name) {
        $value = defined($name) ? constant($name) : null;
        if (is_string($value) && strlen($value) >= 32 && !in_array($value, $keys, true)) {
            $keys[] = $value;
        }
    }
    return $keys;
}

function zeam_pass_has_dedicated_key()
{
    return zeam_pass_dedicated_keys() !== [];
}

function zeam_pass_sealing_names()
{
    $names = [];
    $seen = [];
    foreach (['ZEAM_BRIDGE_KEY', 'ZEAM_PASS_KEY'] as $name) {
        $value = defined($name) ? constant($name) : null;
        if (is_string($value) && strlen($value) >= 32 && !in_array($value, $seen, true)) {
            $seen[] = $value;
            $names[] = $name;
        }
    }
    $names[] = 'salts';
    return $names;
}

function zeam_pass_locked_restore($which)
{
    $all = zeam_pass_secrets();
    $with = isset($all[$which]['sealedWith']) && is_string($all[$which]['sealedWith']) ? $all[$which]['sealedWith'] : '';
    if ($with === 'ZEAM_BRIDGE_KEY' || $with === 'ZEAM_PASS_KEY') {
        return "the {$with} the key was last sealed with";
    }
    if ($with === 'salts') {
        return 'the WordPress salts the key was last sealed with';
    }
    return 'the secret the key was last sealed with: the ZEAM_BRIDGE_KEY this site last ran with, or if it never had one its ZEAM_PASS_KEY, or if it had neither the WordPress salts the site had when the key was made';
}

function zeam_pass_key_notices($newKey)
{
    $labels = ['settle' => 'settle key', 'credit' => 'credit wallet key'];
    $all = zeam_pass_secrets();
    $sealed = [];
    $notices = [];
    foreach ($labels as $which => $label) {
        if (!isset($all[$which]['sealed'])) {
            continue;
        }
        $sealed[] = $label;
        if (zeam_pass_secret_state($which) !== 'locked') {
            continue;
        }
        $now = zeam_pass_secrets();
        $with = isset($now[$which]['sealedWith']) && is_string($now[$which]['sealedWith']) ? $now[$which]['sealedWith'] : '';
        $text = 'Restore in wp-config.php ' . zeam_pass_locked_restore($which) . '.';
        if ($with === 'salts') {
            $text .= ' The salts it reads are AUTH_KEY and SECURE_AUTH_KEY.';
        } elseif ($with === 'ZEAM_BRIDGE_KEY' || $with === 'ZEAM_PASS_KEY') {
            $text .= ' A new ' . $with . ' cannot open it: do not set a new value in its place.';
        } else {
            $text .= ' A new key cannot open it: do not set one in its place.';
        }
        $text .= $which === 'settle' ? ' Paid calls are off until then.' : ' Credit is not bought until then.';
        $notices[] = ['level' => 'error', 'lead' => 'ZEAM Bridge cannot open its ' . $label . '.', 'text' => $text, 'define' => null, 'after' => ''];
    }
    if (zeam_pass_has_dedicated_key() || $notices !== []) {
        return $notices;
    }
    $define = "define('ZEAM_BRIDGE_KEY', '" . $newKey . "');";
    if ($sealed === []) {
        $notices[] = ['level' => 'warning', 'lead' => 'ZEAM Bridge:', 'text' => 'no ZEAM_BRIDGE_KEY is set, so the keys this plugin makes will be sealed with a key derived from the WordPress salts. Add ZEAM_BRIDGE_KEY to wp-config.php before they are made, 32 or more random characters:', 'define' => $define, 'after' => 'Keep it across every move and redeploy: it is what the keys will be sealed with.'];
        return $notices;
    }
    $which = implode(' and ', $sealed);
    $notices[] = ['level' => 'warning', 'lead' => 'ZEAM Bridge:', 'text' => 'your ' . $which . (count($sealed) > 1 ? ' are' : ' is') . ' sealed with a key derived from the WordPress salts. To seal ' . (count($sealed) > 1 ? 'them' : 'it') . ' with a key of your own, add ZEAM_BRIDGE_KEY to wp-config.php, 32 or more random characters:', 'define' => $define, 'after' => 'The salts still open ' . (count($sealed) > 1 ? 'them' : 'it') . ', and ' . (count($sealed) > 1 ? 'they are' : 'it is') . ' sealed again with ZEAM_BRIDGE_KEY on next use; keep that value from then on. Until you add it, keep your WordPress salts across every move and redeploy: they are what ' . (count($sealed) > 1 ? 'the keys are' : 'the key is') . ' sealed with.'];
    return $notices;
}

function zeam_pass_wrapping_keys()
{
    if (!function_exists('sodium_crypto_secretbox')) {
        return [];
    }
    $keys = [];
    foreach (zeam_pass_dedicated_keys() as $dedicated) {
        $keys[] = sodium_crypto_generichash('zeam-pass-keys|dedicated|' . $dedicated, '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
    }
    $salts = defined('AUTH_KEY') && defined('SECURE_AUTH_KEY') ? AUTH_KEY . SECURE_AUTH_KEY : wp_salt('auth') . wp_salt('secure_auth');
    $keys[] = sodium_crypto_generichash('zeam-pass-keys|wordpress|' . $salts, '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
    return $keys;
}

function zeam_pass_seal($plain)
{
    $keys = zeam_pass_wrapping_keys();
    if ($keys === []) {
        throw new RuntimeException('ZEAM Bridge needs the PHP sodium extension to keep its keys');
    }
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return 'v1:' . base64_encode($nonce . sodium_crypto_secretbox((string) $plain, $nonce, $keys[0]));
}

function zeam_pass_open_sealed($sealed)
{
    if (!is_string($sealed) || strpos($sealed, 'v1:') !== 0) {
        return [null, null];
    }
    $raw = base64_decode(substr($sealed, 3), true);
    if (!is_string($raw) || strlen($raw) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES) {
        return [null, null];
    }
    $nonce = substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    $box = substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    foreach (zeam_pass_wrapping_keys() as $i => $key) {
        $plain = sodium_crypto_secretbox_open($box, $nonce, $key);
        if ($plain !== false) {
            return [$plain, $i];
        }
    }
    return [null, null];
}

function zeam_pass_secrets()
{
    $all = get_option(ZEAM_PASS_SECRETS, []);
    return is_array($all) ? $all : [];
}

function zeam_pass_store_secrets(array $all)
{
    if (get_option(ZEAM_PASS_SECRETS, null) === null) {
        add_option(ZEAM_PASS_SECRETS, $all, '', 'no');
    } else {
        update_option(ZEAM_PASS_SECRETS, $all, false);
    }
}

function zeam_pass_secret($which)
{
    static $open = [];
    if (array_key_exists($which, $open)) {
        return $open[$which];
    }
    $all = zeam_pass_secrets();
    if (!isset($all[$which]['sealed'])) {
        return null;
    }
    list($plain, $index) = zeam_pass_open_sealed($all[$which]['sealed']);
    if ($plain === null) {
        return null;
    }
    $names = zeam_pass_sealing_names();
    $with = isset($names[$index]) ? $names[$index] : null;
    if ($index > 0 && zeam_pass_has_dedicated_key()) {
        $all[$which]['sealed'] = zeam_pass_seal($plain);
        $all[$which]['sealedWith'] = $names[0];
        zeam_pass_store_secrets($all);
    } elseif ($with !== null && (!isset($all[$which]['sealedWith']) || $all[$which]['sealedWith'] !== $with)) {
        $all[$which]['sealedWith'] = $with;
        zeam_pass_store_secrets($all);
    }
    $open[$which] = $plain;
    return $plain;
}

function zeam_pass_secret_state($which)
{
    $all = zeam_pass_secrets();
    if (!isset($all[$which]['sealed'])) {
        return 'missing';
    }
    return zeam_pass_secret($which) === null ? 'locked' : 'ok';
}

function zeam_pass_secret_address($which)
{
    $all = zeam_pass_secrets();
    return isset($all[$which]['address']) && is_string($all[$which]['address']) ? $all[$which]['address'] : '';
}

function zeam_pass_new_private_key()
{
    for ($i = 0; $i < 16; $i++) {
        $key = '0x' . bin2hex(random_bytes(32));
        try {
            return [$key, \ZeamPass\Secp256k1::privateKeyToAddress($key)];
        } catch (\InvalidArgumentException $e) {
            continue;
        }
    }
    throw new RuntimeException('could not generate a key');
}

function zeam_pass_ensure_secret($which)
{
    $all = zeam_pass_secrets();
    if (isset($all[$which]['sealed'])) {
        return zeam_pass_secret_state($which) === 'ok';
    }
    if (!\ZeamPass\Core::ready() || zeam_pass_wrapping_keys() === []) {
        return false;
    }
    list($key, $address) = zeam_pass_new_private_key();
    $all[$which] = ['sealed' => zeam_pass_seal($key), 'sealedWith' => zeam_pass_sealing_names()[0], 'address' => $address, 'created' => gmdate('c')];
    zeam_pass_store_secrets($all);
    return true;
}

function zeam_pass_ensure_keys()
{
    zeam_pass_ensure_secret('settle');
    if (in_array(zeam_pass_mode(), ['gate', 'both'], true)) {
        zeam_pass_ensure_secret('credit');
    }
}
