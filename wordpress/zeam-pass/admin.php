<?php
if (!defined('ABSPATH')) {
    exit;
}
$zeam_pass_modes = [
    'paywall' => ['Paywall', 'Agents pay per call in USDC. A failed call is not charged; on a line, a call uses the time it runs.'],
    'gate' => ['Gate', 'Admitted keys only. Calls are free to them. 10,000 checks a month are free to you, then $0.50 per 1,000 from your credit wallet, bought 2,000 at a time for $1.'],
    'both' => ['Both', 'Admitted keys only, paid per call. Paid calls are not gate checks.'],
];
?>
<div class="wrap" id="zeam-pass">
<h1>ZEAM Bridge</h1>
<p>A gate, a paywall or both in front of your posts for AI agents. No sign-up, no account. Connect your payout wallet and choose a mode. This WordPress makes and keeps the keys. ZEAM holds no money, no keys and no admission decisions.</p>

<?php if ($view['notice']) : ?>
<div class="notice notice-<?php echo esc_attr($view['notice'][0] === 'error' ? 'error' : 'success'); ?> is-dismissible">
<?php foreach ((array) $view['notice'][1] as $zeam_pass_line) : ?>
<p><?php echo esc_html($zeam_pass_line); ?></p>
<?php endforeach; ?>
</div>
<?php endif; ?>

<?php if ($view['ready']) : ?>
<div class="notice notice-success inline"><p><strong>You are live.</strong> MCP: <code><?php echo esc_html($view['mcp']); ?></code>. HTTP: <code><?php echo esc_html($view['api']); ?></code>.</p></div>
<?php else : ?>
<div class="notice notice-warning inline"><p><strong>Not live:</strong> <?php echo esc_html(implode('; ', $view['blockers'])); ?>.</p></div>
<?php endif; ?>

<form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
<input type="hidden" name="action" value="zeam_pass_save">
<?php wp_nonce_field('zeam_pass_save'); ?>

<h2>1. Your payout wallet</h2>
<table class="form-table" role="presentation">
<tr><th scope="row"><label for="zp-payout">Payout wallet</label></th><td>
<input id="zp-payout" name="payout" class="regular-text code" value="<?php echo esc_attr($view['payout']); ?>" placeholder="0x…" autocomplete="off">
<button type="button" class="button" id="zp-connect">Use my browser wallet</button>
<p class="description">Earnings are paid here. Connecting reads the address. It signs and sends nothing.</p>
</td></tr>
</table>

<h2>2. Choose</h2>
<table class="form-table" role="presentation">
<tr><th scope="row">Mode</th><td><fieldset>
<?php foreach ($zeam_pass_modes as $zeam_pass_key => $zeam_pass_mode) : ?>
<label><input type="radio" name="mode" value="<?php echo esc_attr($zeam_pass_key); ?>" <?php checked($view['mode'], $zeam_pass_key); ?>> <strong><?php echo esc_html($zeam_pass_mode[0]); ?></strong>: <?php echo esc_html($zeam_pass_mode[1]); ?></label><br>
<?php endforeach; ?>
</fieldset></td></tr>
<tr class="zp-paid"><th scope="row"><label for="zp-price">Price per call (USD)</label></th><td><input id="zp-price" name="price" class="small-text" value="<?php echo esc_attr($view['price']); ?>" placeholder="0.02"><p class="description">Per search, or per post read. A post that does not exist costs nothing. <?php echo esc_html(zeam_pass_price_range()); ?></p></td></tr>
<tr><th scope="row">Per tool</th><td><fieldset>
<?php foreach (ZEAM_PASS_BUILTIN_TOOLS as $zeam_pass_tool) : ?>
<label><code><?php echo esc_html($zeam_pass_tool); ?></code></label> <input name="tool_price[<?php echo esc_attr($zeam_pass_tool); ?>]" class="small-text zp-paid" aria-label="<?php echo esc_attr($zeam_pass_tool); ?> price (USD)" value="<?php echo esc_attr($view['toolPrices'][$zeam_pass_tool] ?? ''); ?>" placeholder="<?php echo esc_attr($view['price'] !== '' ? $view['price'] : '0.02'); ?>"> <label><input type="checkbox" name="tool_free[<?php echo esc_attr($zeam_pass_tool); ?>]" value="1" <?php checked(in_array($zeam_pass_tool, $view['free'], true)); ?>> Free</label><br>
<?php endforeach; ?>
</fieldset><p class="description">Price empty: the price per call. Free: no payment, no key. <?php echo esc_html(zeam_pass_price_range()); ?></p></td></tr>
<tr><th scope="row"><label for="zp-free-limit">Free calls an hour per address</label></th><td><input id="zp-free-limit" name="free_limit" type="number" min="1" max="1000000" step="1" class="small-text" value="<?php echo esc_attr($view['freeLimit']); ?>"><p class="description">Per free tool. A whole number from 1 to 1,000,000. Empty: no limit. Over it: 429.</p></td></tr>
<tr class="zp-paid"><th scope="row"><label for="zp-time-block">Line time (USD)</label></th><td><input id="zp-time-block" name="time_block" class="small-text" value="<?php echo esc_attr($view['timeBlock']); ?>" placeholder="0.00025"> buys <input id="zp-time-block-ms" name="time_block_ms" type="number" min="1" max="3600000" step="1" class="small-text" aria-label="Milliseconds that price buys" value="<?php echo esc_attr($view['timeBlockMs']); ?>" placeholder="250"> ms<p class="description">Price empty: off. Milliseconds: 1 to 3,600,000, empty for 250. <?php echo esc_html(zeam_pass_price_range()); ?> Agents buy milliseconds with <code>buy_time</code> and call time tools on a line with no payment per call. Unburned time goes back with their refund. Time tools come from the <code>zeam_bridge_tools</code> filter with <code>'meter' =&gt; 'time'</code>.</p></td></tr>
<tr class="zp-gated"><th scope="row"><label for="zp-admit">Admitted keys</label></th><td><textarea id="zp-admit" name="admit" rows="4" class="large-text code" placeholder="0x… one per line"><?php echo esc_textarea($view['admit']); ?></textarea><p class="description">One address per line. An agent signs each call with its key as a zero-value x402 payment. Nothing is paid. The key needs no funds. A key on this list can sign grants (below).</p></td></tr>
<tr><th scope="row"><label for="zp-contact">Contact for access</label></th><td><input id="zp-contact" name="contact" class="regular-text" value="<?php echo esc_attr($view['contact']); ?>" placeholder="<?php echo esc_attr($view['home']); ?>"><p class="description">A web address or a mailto: address. Agents see it in the 402 an unpaid call gets and when their key is refused. Empty: your site's address. Your admin email is not shown.</p></td></tr>
<tr class="zp-gate-only"><th scope="row"><label for="zp-onempty">When gate credit runs out</label></th><td><select id="zp-onempty" name="onEmpty">
<option value="refuse" <?php selected($view['onEmpty'], 'refuse'); ?>>Refuse agents until credit is added</option>
<option value="allow" <?php selected($view['onEmpty'], 'allow'); ?>>Admit agents and warn me here</option>
</select></td></tr>
<tr><th scope="row">Free API</th><td><label><input type="checkbox" name="hold" value="1" <?php checked($view['hold']); ?>> Hold the full text back from the WordPress API and feeds</label><p class="description">Anonymous readers of <code>/wp-json/wp/v2/posts</code> and the RSS and Atom feeds get the excerpt and a link to the tools. Pages and logged-in editors get the full text.</p></td></tr>
<tr><th scope="row">Directories</th><td><label><input type="checkbox" name="no_root_openapi" value="1" <?php checked($view['no_root_openapi']); ?>> Do not answer <code>/openapi.json</code> at the site root</label><p class="description">Directories of paid tools read <code>/openapi.json</code> at the root of a domain. Unchecked, the plugin answers it with your tools and prices when the site is at the root of its domain, permalinks are not Plain and no file of that name exists. The same document stays at <code>/wp-json/zeam-pass/openapi.json</code> either way.</p></td></tr>
</table>

<details<?php echo ($view['relay'] || $view['credits'] || $view['rpc']) ? ' open' : ''; ?>>
<summary><strong>Advanced</strong></summary>
<table class="form-table" role="presentation">
<tr><th scope="row"><label for="zp-name">Name</label></th><td><input id="zp-name" name="name" class="regular-text" value="<?php echo esc_attr($view['name']); ?>" placeholder="<?php echo esc_attr($view['effectiveName']); ?>"><p class="description"><?php echo esc_html(zeam_pass_name_rule()); ?> Name and wallet set your split address and hold your gate credit. A change moves new earnings to a new split and leaves credit bought before it behind. Pay out first.</p></td></tr>
<tr><th scope="row"><label for="zp-relay">Relay</label></th><td><input id="zp-relay" name="relay" class="regular-text code" value="<?php echo esc_attr($view['relay']); ?>" placeholder="<?php echo esc_attr(ZEAM_PASS_DEFAULT_RELAY); ?>"><p class="description">Sends the transactions this site signs, and agents' deposits and MPP charges. It pays the gas of every deposit, and of a claim, payout or MPP charge when the 9.99% fee share covers it. Our relay pays the gas of a refund when our fee on what the buyer spent covers the gas of the deposit, of the refund and of settling any calls not yet settled, and of every further deposit and every earlier refund it paid for on that channel, with a 15% margin; otherwise the buyer pays the refund's gas, with a 15% margin, in USDC, quoted before the buyer signs that payment.</p></td></tr>
<tr><th scope="row"><label for="zp-credits">Credits</label></th><td><input id="zp-credits" name="credits" class="regular-text code" value="<?php echo esc_attr($view['credits']); ?>" placeholder="<?php echo esc_attr(ZEAM_PASS_DEFAULT_CREDITS); ?>"><p class="description">Where the gate buys checks.</p></td></tr>
<tr><th scope="row"><label for="zp-rpc">Base RPC</label></th><td><input id="zp-rpc" name="rpc" class="regular-text code" value="<?php echo esc_attr($view['rpc']); ?>" placeholder="<?php echo esc_attr(ZEAM_PASS_DEFAULT_RPC); ?>"><p class="description">The default endpoint is rate-limited. For a site with traffic, set your own Base node or a provider.</p></td></tr>
<tr><th scope="row">Constants</th><td><p class="description">Fee address <code><?php echo esc_html($view['feeRecipient']); ?></code>. Credit issuer <code><?php echo esc_html($view['creditIssuer']); ?></code>.</p></td></tr>
</table>
</details>

<?php submit_button('Save'); ?>
</form>

<div class="zp-gated">
<h2>Grants</h2>
<p>A grant admits one key that is not on your list. A key on your list signs it with the other key, one tool or all, and an end time. It works for that key alone. Remove the signing key from your list to end its grants.</p>
<table class="form-table" role="presentation">
<tr><th scope="row"><label for="zp-grant-delegate">Key to let in</label></th><td><input id="zp-grant-delegate" class="regular-text code" placeholder="0x…" autocomplete="off"><p class="description">The address of the agent's key.</p></td></tr>
<tr><th scope="row"><label for="zp-grant-scope">Tools</label></th><td><select id="zp-grant-scope"><option value="*">Every tool</option><?php foreach (array_keys(zeam_pass_tools()) as $zeam_pass_tool) : ?><option value="<?php echo esc_attr($zeam_pass_tool); ?>"><?php echo esc_html($zeam_pass_tool); ?></option><?php endforeach; ?></select></td></tr>
<tr><th scope="row"><label for="zp-grant-until">Until</label></th><td><input id="zp-grant-until" type="datetime-local"><p class="description">Your local time.</p></td></tr>
</table>
<p><button type="button" class="button" id="zp-grant-sign">Sign with my browser wallet</button></p>
<p class="description">The browser wallet must hold a key on your saved list. Signing costs nothing and sends nothing. This page keeps no copy. Without a browser wallet, sign with the Node or Python package: <code>signGrant</code> or <code>sign_grant</code>.</p>
<div id="zp-grant-result" hidden>
<p><label for="zp-grant-out">The agent sends this as the <code>x-grant</code> header:</label></p>
<textarea id="zp-grant-out" rows="4" class="large-text code" readonly></textarea>
</div>
</div>

<h2>Your addresses</h2>
<table class="form-table" role="presentation">
<tr class="zp-paid"><th scope="row">Your split</th><td><code><?php echo esc_html($view['split'] ?: 'connect a wallet first'); ?></code><p class="description">Pays 90.01% to your wallet and 9.99% to ZEAM. It has no owner. Nobody can change it. Your first payout creates it.</p></td></tr>
<tr class="zp-paid"><th scope="row">Settle key</th><td><code><?php echo esc_html($view['settleAddress'] ?: 'not generated'); ?></code><p class="description">Made by this site, encrypted in its database. It signs claims and refunds. It holds no money.</p></td></tr>
<tr class="zp-gate-only"><th scope="row">Credit wallet</th><td><code><?php echo esc_html($view['creditAddress'] ?: 'made the first time the plugin runs in gate or both mode'); ?></code> <span id="zp-credit-balance"></span><p class="description">Made by this site. Keep $1 USDC on Base in it; it needs no ETH. It buys gate checks 2,000 at a time for $1 once the month's free ones are used up, and again below 200 remaining.</p></td></tr>
</table>

<h2>Earnings and usage</h2>
<table class="form-table" role="presentation">
<tr class="zp-paid"><th scope="row">Earned, unclaimed</th><td id="zp-unclaimed">…</td></tr>
<tr class="zp-paid"><th scope="row">Claimed, unpaid</th><td id="zp-claimed">…</td></tr>
<tr class="zp-paid"><th scope="row">Last payout</th><td id="zp-last">…</td></tr>
<tr class="zp-gate-only"><th scope="row">Gate this month</th><td id="zp-gate">…</td></tr>
<tr><th scope="row">Background work</th><td><span id="zp-tick">…</span><p class="description">Every minute this site claims what agents paid, pays out once ZEAM's 9.99% fee on a payout covers its gas, stamps withdrawing channels and buys gate credit. WordPress runs it on a visit. Add a cron job that requests <code><?php echo esc_html($view['cron']); ?></code> every minute<?php echo $view['cronDisabled'] ? ' (DISABLE_WP_CRON is set: required)' : ' and set DISABLE_WP_CRON in wp-config.php'; ?>.</p></td></tr>
</table>
<p>
<button type="button" class="button" id="zp-refresh">Refresh</button>
<button type="button" class="button" id="zp-run">Run now</button>
<button type="button" class="button button-primary zp-paid" id="zp-pay">Pay out now</button>
</p>
<div id="zp-payout-box" hidden>
<p id="zp-payout-note"></p>
<p id="zp-payout-gas"></p>
<p><button type="button" class="button button-primary" id="zp-send" hidden>Send it from my wallet on Base</button></p>
<p id="zp-payout-tx"></p>
</div>
<p id="zp-status" role="status"></p>
</div>
<script>
(function () {
  var cfg = <?php echo wp_json_encode($js, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT); ?>;
  var BASE = '0x2105';
  var $ = function (id) { return document.getElementById(id) };
  var text = function (id, t) { var el = $(id); if (el) el.textContent = t == null ? '' : String(t) };
  var say = function (t, bad) { text('zp-status', t); $('zp-status').style.color = bad ? '#b32d2e' : '' };
  var state = { tx: null, busy: false };
  var usd = function (micro) { var v = Number(micro) / 1e6; return Number.isFinite(v) ? '$' + v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : '' };
  var post = function (action, extra) {
    var body = new URLSearchParams(Object.assign({ action: action, _ajax_nonce: cfg.nonce }, extra || {}));
    return fetch(cfg.ajax, { method: 'POST', credentials: 'same-origin', body: body }).then(function (r) { return r.json() }).then(function (j) {
      if (!j || !j.success) throw new Error(j && j.data && j.data.message ? String(j.data.message) : 'The request failed.');
      return j.data;
    });
  };
  var guarded = function (fn) {
    return function () {
      if (state.busy) return;
      state.busy = true;
      Promise.resolve().then(fn).catch(function (e) { say(e && e.message ? String(e.message) : String(e), true) }).then(function () { state.busy = false });
    };
  };
  var showMode = function (mode) {
    var paid = mode !== 'gate', gated = mode !== 'paywall';
    var show = function (sel, on) { document.querySelectorAll('#zeam-pass ' + sel).forEach(function (el) { el.style.display = on ? '' : 'none' }) };
    show('.zp-paid', paid);
    show('.zp-gated', gated);
    show('.zp-gate-only', mode === 'gate');
  };
  document.querySelectorAll('#zeam-pass input[name="mode"]').forEach(function (el) { el.addEventListener('change', function () { showMode(el.value) }) });
  showMode(cfg.mode);

  var wallet = function () {
    if (!window.ethereum) throw new Error('No browser wallet found. Install one and reload, or paste your address.');
    return window.ethereum.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      if (!accounts || !accounts[0]) throw new Error('The wallet did not share an address.');
      return String(accounts[0]);
    });
  };

  var txList = function (list) { return (list || []).filter(function (t, i, a) { return a.indexOf(t) === i }).join(', ') };
  var render = function (s) {
    if (s.unclaimed) text('zp-unclaimed', usd(s.unclaimed.microUSD) + ' across ' + s.unclaimed.channels + ' channel(s)');
    else text('zp-unclaimed', s.ready ? 'nothing' : 'not live');
    if (s.claimedNotPaid) text('zp-claimed', usd(s.claimedNotPaid.microUSD) + (s.claimedNotPaid.splitDeployed ? '' : ' (the first payout creates your split)'));
    else text('zp-claimed', s.chainError ? 'could not read the chain: ' + s.chainError : 'not live');
    var last = s.lastPayout;
    text('zp-last', last && last.at ? [last.at, last.valueUSD != null ? '$' + last.valueUSD : '', 'transaction ' + txList(last.transactions)].filter(Boolean).join(' · ') : 'none');
    if (s.gate) {
      var g = s.gate;
      var line = g.used + ' checks used of ' + g.free + ' free; ' + g.credit + ' bought checks left';
      if (g.onEmpty === 'allow' && g.unpaidAt) line += '. Warning: calls admitted with no credit (last at ' + g.unpaidAt + '). Fund the credit wallet.';
      text('zp-gate', line);
    } else text('zp-gate', s.gateError ? 'could not read usage: ' + s.gateError : 'not live');
    if (s.creditWallet) text('zp-credit-balance', s.creditWallet.usdcMicro != null ? '(holds ' + usd(s.creditWallet.usdcMicro) + ' USDC)' : '(' + s.creditWallet.error + ')');
    var t = s.lastTick;
    var tick = t && t.at ? 'last run ' + t.at + (t.error ? ': ' + t.error : '') + (t.credit && t.credit.error ? '; credit: ' + t.credit.error : '') : 'not run';
    if (s.nextTick) tick += '; next due ' + new Date(s.nextTick * 1000).toISOString();
    text('zp-tick', tick);
  };
  var refresh = function () { return post('zeam_pass_status').then(render).catch(function (e) { say(e.message, true) }) };

  $('zp-connect').addEventListener('click', guarded(async function () {
    say('Connecting your wallet…');
    var address = await wallet();
    $('zp-payout').value = address;
    say('Connected ' + address + '. Save to use it.');
  }));
  var hexOf = function (s) { return '0x' + Array.from(new TextEncoder().encode(s)).map(function (b) { return ('0' + b.toString(16)).slice(-2) }).join('') };
  var b64url = function (s) { return btoa(Array.from(new TextEncoder().encode(s)).map(function (b) { return String.fromCharCode(b) }).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
  var soon = new Date(Date.now() + 7 * 86400000);
  $('zp-grant-until').value = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $('zp-grant-sign').addEventListener('click', guarded(async function () {
    $('zp-grant-result').hidden = true;
    var delegate = $('zp-grant-delegate').value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(delegate)) return say('The key to let in is an address: 0x and 40 hex digits.', true);
    var when = new Date($('zp-grant-until').value);
    if (isNaN(when.getTime()) || when.getTime() <= Date.now()) return say('Choose an end time in the future.', true);
    var until = when.toISOString().replace(/\.\d{3}Z$/, 'Z');
    var scope = $('zp-grant-scope').value;
    var signer = (await wallet()).toLowerCase();
    if (cfg.admit.indexOf(signer) === -1) return say('Your browser wallet holds ' + signer + '. It is not on your saved list. Add it and save.', true);
    var message = cfg.realm + ' grant\ndelegate: ' + delegate + '\nscope: ' + scope.toLowerCase() + '\nuntil: ' + until;
    say('Sign the grant in your wallet…');
    var signature = await window.ethereum.request({ method: 'personal_sign', params: [hexOf(message), signer] });
    $('zp-grant-out').value = b64url(JSON.stringify({ delegate: delegate, scope: scope, until: until, signature: String(signature) }));
    $('zp-grant-result').hidden = false;
    say('Signed. Give the grant to the agent that holds ' + delegate + '.');
  }));
  $('zp-refresh').addEventListener('click', guarded(refresh));
  $('zp-run').addEventListener('click', guarded(async function () {
    say('Running…');
    var r = await post('zeam_pass_run');
    say(r.skipped ? 'Already running. Retry in 60s.' : (r.error ? 'Ran with an error: ' + r.error : 'Ran.'), !!r.error);
    await refresh();
  }));
  $('zp-pay').addEventListener('click', guarded(async function () {
    $('zp-payout-box').hidden = true;
    $('zp-send').hidden = true;
    text('zp-payout-note', '');
    text('zp-payout-gas', '');
    text('zp-payout-tx', '');
    state.tx = null;
    say('Pricing the payout…');
    var b = await post('zeam_pass_payout');
    $('zp-payout-box').hidden = false;
    if (b.paidBy === 'relay') {
      text('zp-payout-note', 'Paying out $' + b.valueUSD + ' to your wallet. The relay pays the gas.');
      text('zp-payout-tx', 'Transaction ' + txList((b.calls || []).map(function (c) { return c.hash }).filter(Boolean)));
      say('Sent.');
    } else if (b.paidBy === 'you' && b.transaction) {
      state.tx = b.transaction;
      text('zp-payout-note', b.note || '');
      text('zp-payout-gas', 'Value $' + b.valueUSD + '. Gas about ' + (b.gasUSD == null ? 'unknown' : '$' + b.gasUSD) + ' in ETH on Base, from your own wallet. Calls: ' + (b.calls || []).join(', ') + '.');
      $('zp-send').hidden = false;
      say('Below break-even.');
    } else {
      text('zp-payout-note', b.note || 'Nothing to pay out.');
      say('Nothing to pay out.');
    }
    await refresh();
  }));
  $('zp-send').addEventListener('click', guarded(async function () {
    var tx = state.tx;
    if (!tx) return;
    if (Number(tx.chainId) !== 8453 || !/^0x[0-9a-fA-F]{40}$/.test(String(tx.to)) || !/^0x[0-9a-fA-F]*$/.test(String(tx.data))) return say('This page will not send that transaction.', true);
    var from = await wallet();
    say('Switching your wallet to Base…');
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE }] });
    } catch (e) {
      if (!e || e.code !== 4902) throw e;
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: BASE, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }] });
    }
    var chain = await window.ethereum.request({ method: 'eth_chainId' });
    if (String(chain).toLowerCase() !== BASE) return say('Your wallet is not on Base. Switch to Base and retry.', true);
    say('Confirm the transaction in your wallet…');
    var hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: from, to: String(tx.to), data: String(tx.data), value: '0x' + BigInt(String(tx.value || '0')).toString(16) }] });
    state.tx = null;
    $('zp-send').hidden = true;
    text('zp-payout-tx', 'Sent: transaction ' + String(hash));
    say('Sent. The payout lands when Base includes it.');
  }));
  refresh();
})();
</script>
