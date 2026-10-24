<?php

if (!defined('ABSPATH')) {
    exit;
}

function zeam_pass_notice_key()
{
    return 'zeam_pass_notice_' . get_current_user_id();
}

function zeam_pass_price_range()
{
    return 'From 0.000001 to ' . \ZeamPass\Pricing::MAX_USD . ', at most 6 decimals.';
}

function zeam_pass_name_rule()
{
    return 'A name is 2 to 32 of a-z, 0-9 and -, starting with a letter.';
}

function zeam_pass_parse_addresses($text)
{
    $good = [];
    $bad = [];
    foreach (preg_split('/[\s,]+/', (string) $text, -1, PREG_SPLIT_NO_EMPTY) as $a) {
        if (preg_match('/^0x[0-9a-fA-F]{40}$/D', $a)) {
            $good[] = strtolower($a);
        } else {
            $bad[] = $a;
        }
    }
    return [array_values(array_unique($good)), $bad];
}

function zeam_pass_clean_url($raw)
{
    $raw = trim((string) $raw);
    if ($raw === '') {
        return '';
    }
    $url = esc_url_raw($raw, ['http', 'https']);
    return $url === '' ? null : untrailingslashit($url);
}

function zeam_pass_checksum($address)
{
    try {
        return \ZeamPass\Core::ready() ? \ZeamPass\Address::checksum($address) : $address;
    } catch (Throwable $e) {
        return null;
    }
}

function zeam_pass_save_settings(array $in)
{
    $errors = [];
    $values = [];
    $payout = trim((string) ($in['payout'] ?? ''));
    if ($payout !== '') {
        $checked = preg_match('/^0x[0-9a-fA-F]{40}$/D', $payout) ? zeam_pass_checksum($payout) : null;
        if ($checked === null) {
            $errors[] = 'The wallet is not an address: 0x and 40 hex digits, valid checksum.';
        } else {
            $values['payout'] = $checked;
        }
    } else {
        $values['payout'] = '';
    }
    $name = strtolower(trim((string) ($in['name'] ?? '')));
    if ($name !== '' && !preg_match('/^[a-z][a-z0-9-]{1,31}$/D', $name)) {
        $errors[] = zeam_pass_name_rule();
    } else {
        $values['name'] = $name;
    }
    $mode = (string) ($in['mode'] ?? 'paywall');
    $values['mode'] = in_array($mode, ZEAM_PASS_MODES, true) ? $mode : 'paywall';
    $price = trim((string) ($in['price'] ?? ''));
    if ($price !== '' && zeam_pass_usd_micro($price) < 1) {
        $errors[] = 'A price is USD above 0, at most 6 decimals, like 0.02, and at most ' . \ZeamPass\Pricing::MAX_USD . ', the most a number counts exactly in micro-USD.';
    } else {
        $values['price'] = $price;
    }
    if ($values['mode'] !== 'gate' && ($values['price'] ?? (string) zeam_pass_opt('price', '')) === '') {
        $errors[] = 'Set a price per call for a paywall.';
    }
    $toolPrices = [];
    $priceErrors = [];
    $inPrices = isset($in['tool_price']) && is_array($in['tool_price']) ? $in['tool_price'] : [];
    $inFree = isset($in['tool_free']) && is_array($in['tool_free']) ? $in['tool_free'] : [];
    $free = [];
    foreach (ZEAM_PASS_BUILTIN_TOOLS as $tool) {
        $p = trim((string) (is_scalar($inPrices[$tool] ?? null) ? $inPrices[$tool] : ''));
        if ($p !== '' && zeam_pass_usd_micro($p) < 1) {
            $priceErrors[] = 'The ' . $tool . ' price is USD above 0, at most 6 decimals, like 0.02, and at most ' . \ZeamPass\Pricing::MAX_USD . ', the most a number counts exactly in micro-USD.';
        } elseif ($p !== '') {
            $toolPrices[$tool] = $p;
        }
        if (!empty($inFree[$tool])) {
            $free[] = $tool;
        }
    }
    if ($priceErrors === []) {
        $values['tool_prices'] = $toolPrices;
    } else {
        $errors = array_merge($errors, $priceErrors);
    }
    $values['free'] = $free;
    $limit = trim((string) (is_scalar($in['free_limit'] ?? null) ? $in['free_limit'] : ''));
    if ($limit !== '' && (!ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 1000000)) {
        $errors[] = 'Free calls an hour is a whole number from 1 to 1000000, or empty.';
    } else {
        $values['free_limit'] = $limit === '' ? '' : (int) $limit;
    }
    $block = trim((string) (is_scalar($in['time_block'] ?? null) ? $in['time_block'] : ''));
    $blockMs = trim((string) (is_scalar($in['time_block_ms'] ?? null) ? $in['time_block_ms'] : ''));
    if ($block !== '' && zeam_pass_usd_micro($block) < 1) {
        $errors[] = 'The line time price is USD above 0, at most 6 decimals, like 0.00025, and at most ' . \ZeamPass\Pricing::MAX_USD . ', the most a number counts exactly in micro-USD.';
    } elseif ($blockMs !== '' && (!ctype_digit($blockMs) || (int) $blockMs < 1 || (int) $blockMs > 3600000)) {
        $errors[] = 'The line time amount is 1 to 3600000 ms, or empty for 250.';
    } elseif ($block !== '' && $values['mode'] === 'gate') {
        $errors[] = 'Line time needs a paywall or both.';
    } else {
        $values['time_block'] = $block;
        $values['time_block_ms'] = $blockMs === '' ? '' : (int) $blockMs;
    }
    list($admit, $bad) = zeam_pass_parse_addresses($in['admit'] ?? '');
    if ($bad !== []) {
        $errors[] = 'Not wallet addresses: ' . implode(', ', array_slice($bad, 0, 5)) . '.';
    } else {
        $values['admit'] = $admit;
    }
    $contact = trim((string) ($in['contact'] ?? ''));
    if ($contact !== '' && !zeam_pass_contact_valid($contact)) {
        $errors[] = 'A contact is an http(s) URL or a mailto: address.';
    } else {
        $values['contact'] = $contact;
    }
    $values['onEmpty'] = ($in['onEmpty'] ?? '') === 'allow' ? 'allow' : 'refuse';
    $values['hold'] = !empty($in['hold']);
    $values['no_root_openapi'] = !empty($in['no_root_openapi']);
    foreach (['relay', 'credits', 'rpc'] as $k) {
        $url = zeam_pass_clean_url($in[$k] ?? '');
        if ($url === null) {
            $errors[] = 'The ' . $k . ' URL is not an http or https address.';
        } else {
            $values[$k] = $url;
        }
    }
    $movesSplit = (isset($values['payout']) && strtolower($values['payout']) !== strtolower(zeam_pass_payout()))
        || (isset($values['name']) && ($values['name'] === '' ? zeam_pass_default_name() : $values['name']) !== zeam_pass_name());
    if ($movesSplit && zeam_pass_payout() !== '' && zeam_pass_missing_extensions() === []) {
        $unclaimed = zeam_pass_local_unclaimed_micro();
        if ($unclaimed['microUSD'] > 0) {
            $errors[] = 'Wallet and name not changed: $' . number_format($unclaimed['microUSD'] / 1e6, 6) . ' in the current split is unclaimed. Pay out, then change them.';
            unset($values['payout'], $values['name']);
        }
    }
    zeam_pass_set($values);
    zeam_pass_ensure_keys();
    return $errors;
}

add_action('admin_post_zeam_pass_save', function () {
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You are not allowed to change ZEAM Bridge.', 'zeam-pass'), 403);
    }
    check_admin_referer('zeam_pass_save');
    $errors = zeam_pass_save_settings(wp_unslash($_POST));
    set_transient(zeam_pass_notice_key(), $errors ? ['error', $errors] : ['success', ['Saved.']], 120);
    wp_safe_redirect(admin_url('options-general.php?page=zeam-pass'));
    exit;
});

function zeam_pass_ajax_guard()
{
    check_ajax_referer('zeam_pass');
    if (!current_user_can('manage_options')) {
        wp_send_json_error(['message' => 'not allowed'], 403);
    }
}

add_action('wp_ajax_zeam_pass_status', function () {
    zeam_pass_ajax_guard();
    wp_send_json_success(zeam_pass_status());
});

add_action('wp_ajax_zeam_pass_run', function () {
    zeam_pass_ajax_guard();
    wp_send_json_success(zeam_pass_tick());
});

add_action('wp_ajax_zeam_pass_payout', function () {
    zeam_pass_ajax_guard();
    try {
        wp_send_json_success(zeam_pass_payout_now());
    } catch (Throwable $e) {
        wp_send_json_error(['message' => substr(\ZeamPass\message($e), 0, 300)], 409);
    }
});

add_action('admin_menu', function () {
    add_options_page('ZEAM Bridge', 'ZEAM Bridge', 'manage_options', 'zeam-pass', 'zeam_pass_admin_page');
});

add_action('admin_notices', function () {
    if (!current_user_can('manage_options')) {
        return;
    }
    $missing = zeam_pass_missing_extensions();
    if ($missing !== []) {
        echo '<div class="notice notice-error"><p><strong>ZEAM Bridge cannot run on this server.</strong> ' . esc_html(ucfirst(implode('; ', $missing))) . '. Ask your host to enable PHP GMP or BCMath, and sodium. Tools answer not_ready and charge nothing until then.</p></div>';
        return;
    }
    $screen = function_exists('get_current_screen') ? get_current_screen() : null;
    $ours = $screen && in_array($screen->id, ['settings_page_zeam-pass', 'plugins'], true);
    foreach (zeam_pass_key_notices(wp_generate_password(48, false, false)) as $n) {
        if ($n['level'] === 'warning' && !$ours) {
            continue;
        }
        echo '<div class="notice notice-' . $n['level'] . '"><p><strong>' . esc_html($n['lead']) . '</strong> ' . esc_html($n['text']) . ($n['define'] !== null ? ' <code>' . esc_html($n['define']) . '</code> ' . esc_html($n['after']) : '') . '</p></div>';
    }
});

function zeam_pass_admin_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    $notice = get_transient(zeam_pass_notice_key());
    if ($notice) {
        delete_transient(zeam_pass_notice_key());
    }
    $split = zeam_pass_seller_split();
    $view = [
        'notice' => is_array($notice) ? $notice : null,
        'ready' => zeam_pass_ready(),
        'blockers' => zeam_pass_blockers(),
        'mode' => zeam_pass_mode(),
        'payout' => zeam_pass_payout(),
        'name' => (string) zeam_pass_opt('name', ''),
        'effectiveName' => zeam_pass_name(),
        'price' => (string) zeam_pass_opt('price', ''),
        'toolPrices' => is_array(zeam_pass_opt('tool_prices', [])) ? zeam_pass_opt('tool_prices', []) : [],
        'free' => zeam_pass_free_list(),
        'freeLimit' => zeam_pass_free_limit() === null ? '' : (string) zeam_pass_free_limit(),
        'timeBlock' => (string) zeam_pass_opt('time_block', ''),
        'timeBlockMs' => (string) zeam_pass_opt('time_block_ms', ''),
        'admit' => implode("\n", zeam_pass_admit_list()),
        'contact' => (string) zeam_pass_opt('contact', ''),
        'home' => home_url('/'),
        'onEmpty' => zeam_pass_on_empty(),
        'hold' => (bool) zeam_pass_opt('hold', false),
        'no_root_openapi' => (bool) zeam_pass_opt('no_root_openapi', false),
        'relay' => (string) zeam_pass_opt('relay', ''),
        'credits' => (string) zeam_pass_opt('credits', ''),
        'rpc' => (string) zeam_pass_opt('rpc', ''),
        'split' => $split ? $split['address'] : '',
        'settleAddress' => zeam_pass_secret_address('settle'),
        'creditAddress' => zeam_pass_secret_address('credit'),
        'feeRecipient' => zeam_pass_fee_recipient(),
        'creditIssuer' => zeam_pass_credit_issuer(),
        'mcp' => rest_url(ZEAM_PASS_NS . '/mcp'),
        'api' => rest_url(ZEAM_PASS_NS . '/openapi.json'),
        'refund' => rest_url(ZEAM_PASS_NS . '/refund'),
        'cron' => site_url('wp-cron.php'),
        'cronDisabled' => defined('DISABLE_WP_CRON') && DISABLE_WP_CRON,
    ];
    $js = [
        'ajax' => admin_url('admin-ajax.php'),
        'nonce' => wp_create_nonce('zeam_pass'),
        'mode' => $view['mode'],
        'ready' => $view['ready'],
        'admit' => zeam_pass_admit_list(),
        'realm' => \ZeamPass\Pass::REALM,
    ];
    include dirname(__DIR__) . '/admin.php';
}
