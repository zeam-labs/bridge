=== ZEAM Bridge ===
Contributors: skimzey
Tags: agents, x402, mpp, paywall, mcp
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 2.1.0
License: GPL-2.0-only
License URI: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

A gate, a paywall or both in front of your posts for AI agents. No OAuth, no sign-up, no account with us.

== Description ==

Patent pending.

AI agents search and read your posts on your site, over MCP and HTTP, with two tools: search_posts and read_post. x402 clients pay for every tool, and MPP clients for a tool priced per call whose fee covers the gas of its transfer.

* MCP: `/wp-json/zeam-pass/mcp`
* HTTP: `POST /wp-json/zeam-pass/v1/<tool>`
* OpenAPI: `/wp-json/zeam-pass/openapi.json`, and the same document at `/openapi.json` on your site's root, where MPP directories look. The root address answers when WordPress is installed at the root of your domain and your permalinks are not "Plain"; a site in a subfolder, or a file of that name on your server, is not covered. To leave the root address alone, check "Do not answer /openapi.json at the site root" on the settings page.

The same routes answer under `/wp-json/zeam-bridge/` too. The plugin's own documents name `/wp-json/zeam-pass/`, the address agents already hold.

Install the plugin, connect your payout wallet, choose a mode.

* **Paywall:** agents pay per call in USDC. Your site verifies the payment, holds it while the tool runs, and settles it only if the tool succeeds. Bad arguments, a missing post or a failed tool cost the agent $0 per call; on a line, a call uses the time it runs. You keep 90.01% of every sale.
* **Gate:** admits the keys you list. An agent signs each call with its key as a zero-value x402 payment (any x402 client makes one): nothing is paid, the key needs no funds or ETH, nothing goes on chain. A listed key can sign a grant that admits one other key, for one tool or all, until a set time. The settings page signs grants with your browser wallet.
* **Both:** listed keys, paid per call.

The engine runs inside your WordPress. ZEAM holds none of your money or keys and makes no admission decisions.

* **Split.** Payments go to your split contract: no owner, ZEAM included; no one can change it. It pays 90.01% to your wallet and 9.99% to ZEAM. Your first payout creates it.
* **Keys.** The plugin makes a settle key on activation and a credit wallet the first time it runs in gate or both mode, which holds the gate's USDC. Both are encrypted in your database. They never leave your server.
* **Gas.** An agent needs no ETH to pay on the USDC row without Permit2, and you, the seller, need none to be paid. ZEAM's relay sends what your site signed, to where your site signed it (claims, payouts and refunds for your channels), and agents' deposits and MPP charges, which the agent signed. It pays the gas of every deposit it sends; of a claim or payout when ZEAM's 9.99% fee on it covers that gas; and of an MPP charge on the same rule (a charge whose fee does not cover it is not sent: the call is not delivered and nothing is charged). A refund has its own rule, under Refunds.
* **MPP clients.** For a tool priced per call, your 402 also carries an MPP `Payment` challenge (the `WWW-Authenticate: Payment` header) when ZEAM's fee on that one call (9.99% of it; all of it when your payout is the fee address) covers the gas of one USDC transfer plus 15%; an MPP client pays that call with one USDC transfer to your split. Nothing to set up. Below that price your 402 offers x402 only, and so does every tool priced by use and every purchase of line time.
* **Payouts** run once ZEAM's 9.99% fee on a payout covers its gas. "Pay out now" pays through the relay when the fee covers the gas; below that it returns a transaction to send from your own wallet, which then needs ETH on Base for gas.
* **Refunds.** An agent's unspent balance goes back through `/wp-json/zeam-pass/refund`. Our relay pays the gas of a refund when our fee on what the buyer spent covers the gas of the deposit, of the refund and of settling any calls not yet settled, and of every further deposit and every earlier refund it paid for on that channel, with a 15% margin; otherwise the buyer pays the refund's gas, with a 15% margin, in USDC, quoted before the buyer signs that payment. Our fee is 9.99% of what the buyer spent, and all of it when your payout is the fee address; the buyer's gas payment comes out of what comes back. `selfSend` gives the agent a signed refund of the full balance, which it sends from any wallet with ETH on Base for gas. Without you: the agent sends `initiateWithdraw`, then `finalizeWithdraw` after the withdrawal delay, each from the channel's payer wallet with ETH on Base for gas, for at most the channel's `balance` minus `totalClaimed` in the escrow. A burst of refund requests on one channel takes one of your site's PHP workers for each request while WordPress loads and answers it, and every page and channel shares those workers, so the rest of the site waits for a free worker until the burst is answered. At most four requests of a burst are worked out at once; each of the others is answered as soon as a PHP worker takes it, from the channel's record, without waiting for them: `refund_settling` while a refund is being sent, the answer just given to the same request, `request_open` while a call is open, `nothing_to_return` when the record shows the channel holds nothing and one read of the chain agrees, or else 503 `refund_unavailable` with `retry_after_seconds` 1. A paid call on that channel sent during the burst waits for a worker too, so it is answered only after the burst: 402 `refund_settling` if it reaches your site while the refund is being sent, or, once the refund has been sent, as the channel then stands, 402 `payment_invalid` with the channel's state after the refund (`channelState`); nothing is charged either way. Under Apache's prefork, KeepAlive holds each worker idle after it answers, up to KeepAliveTimeout (5 s by default), so a burst sent over connections the client keeps open is answered a few workers at a time: a site that takes bursts turns KeepAlive off (`KeepAlive Off` in the Apache configuration, or ask your host). More PHP workers, or a per-client limit on the refund route in front of WordPress, shorten the wait.
* **Gate pricing.** Gate mode is a metered ZEAM service. 10,000 checks a month are free. After that, your site buys credit from the ZEAM credit service automatically, paid from its credit wallet, whose address the settings page shows: 2,000 checks at a time for $1 USDC ($0.50 per 1,000), bought after the month's 10,000 free checks are used and again below 200 remaining. Keep $1 USDC on Base in the credit wallet. It needs no ETH. Paywall mode uses no credit and has no limit. `both` mode needs no USDC in the credit wallet: paid calls are not gate checks.
* **When gate credit runs out, you choose.** "Refuse agents until credit is added" (the default) or "Admit agents and warn me here." Nothing else in the plugin stops or changes.
* **Prices per tool.** Each tool: its own price, else what the `zeam_bridge_prices` filter gives, else the price per call. A 402 carries that call's amount, `pricing` for it and `prices` for every tool. `tools/list`: `_meta["zeam-pass/price"]`. OpenAPI: `x-price`. A tool the `zeam_bridge_prices` filter prices is tagged `{"per":"call","varies":true}`, and a time tool it prices `{"per":"time","usd":…,"ms":…,"varies":true}`: the line rate, with its price without a line in each call's 402.
* **Free tools.** Check "Free" on a tool: no payment, no key, arguments still checked. "Free calls an hour per address": N per tool per IP per clock hour; over it a 429 with `Retry-After` and `retry_after_seconds`. Empty: no limit.
* **Usage.** A tool with a `unit` price reserves its price, reports units, and is charged units x unit, at most the reserve. No units reported: the call fails, nothing charged per call (on a line the call has used the time it ran). The settle answer has `chargedAmount` and `reservedAmount`.
* **Line time.** Set a price in USD and the milliseconds it buys (default 250). Once one of your tools runs on time (`'meter' => 'time'`, under More tools), the plugin adds `buy_time` and `line` (free); until then nothing sells time. 1. `buy_time {"ms": N}`: the agent buys milliseconds in the smallest step your price divides into whole micro-dollars (any number of milliseconds when a millisecond costs a whole number of micro-dollars), credited to the paying channel with the payment; time that cannot be recorded is not charged. 2. `POST /wp-json/zeam-pass/line {"op":"open","channelId":"0x…"}` answers `nonce` and `sign`; sign `sign` with the payer key and post `{"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"}`: a credential. The channel's first open line switches its meter on; a line opened while another is open leaves the meter as it is. While a refund is being worked out or settling on the channel, a first line is refused 402 `refund_pending` or `refund_settling`, as `on` is, and nothing is opened. 3. Call a time tool with header `x-line` (MCP: `_meta["zeam-pass/line"]`): no payment, time burns while it runs, `X-Pass-Ms-Remaining`, `X-Pass-Ms-Elapsed`. Out of time: 402 `out_of_time`. An agent that cancels a call over MCP (`notifications/cancelled`) is billed to that moment, and `$meter->stopped()` is true in your tool from then: return there. WordPress cannot see an agent hang up while your tool runs, so that call is billed until your tool returns. 4. A refund returns unburned time (`timeReturnedMs`) and closes the line. You are paid only for time that burned. Calls that overlap on one line share one clock, so you are paid for the wall-clock the line is busy, not the sum. Up to 1,000 run at once on one line, and the plugin has no setting to lower that; the one over is refused `429 too_many_calls`.
* Optional: hold the full text back from the WordPress REST API and your RSS and Atom feeds; anonymous readers get the excerpt and a pointer to your tools. Your pages and logged-in editors are unaffected.

== Installation ==

1. Download the plugin: https://zeampass.com/downloads/zeam-pass-2.1.0.zip (its SHA-256 is next to it, at the same address plus .sha256). Plugins -> Add New -> Upload Plugin, choose the zip, Install Now.
2. Before you activate, add an encryption key of at least 32 random characters to wp-config.php and keep it: `define('ZEAM_BRIDGE_KEY', '…');`
3. Activate, then Settings -> ZEAM Bridge.
4. Connect your payout wallet: your browser wallet, or paste the address.
5. Name, under Advanced on the settings page: with your wallet it fixes your split's address and holds your gate credit. It defaults to one made from your site title; set it before you take payments. A change moves new earnings to a new split and leaves gate credit bought before it behind, and the settings page refuses it while the current split has earnings not yet claimed: pay out first.
6. Choose gate, paywall or both. Paywall: set a price per call; optional, a price or Free per tool, free calls an hour per address, and a line-time price with the milliseconds it buys. Line time is sold only once you add a tool that runs on time, with `'meter' => 'time'` in the `zeam_bridge_tools` filter; until then the price is saved and nothing sells time. Gate: list the addresses of the keys you admit. "Contact for access": a web address or a mailto: address where an agent asks to be admitted. Agents see it in the 402 an unpaid call gets and when a key is refused. Empty: your site's address; your admin email is never shown.
7. Save. In paywall or both mode the page shows your split, your earnings and Pay out now; in gate mode, the gate checks used this month and the credit wallet to fund.
8. Gate, optional, after you save: the Grants box signs a grant with your browser wallet, when it holds a key on your saved list.

Your site must be reachable from the internet and use pretty permalinks.

**Names.** The plugin was ZEAM Pass before 2.0.0. Its folder, its download and its update file are still named `zeam-pass`, so an installed site updates in place and keeps its settings, keys and addresses. `ZEAM_PASS_KEY`, the `zeam_pass_tools` and `zeam_pass_prices` filters and `/wp-json/zeam-pass/` keep working.

**Updates.** New versions appear in Dashboard -> Updates and on the Plugins page like any other plugin, with the WordPress auto-update setting, off unless you turn it on. They come from zeampass.com, signed by ZEAM Labs: the plugin installs a new version only when its release file carries a valid signature and the download matches the signed SHA-256. A download that does not match is refused and nothing changes.

**Requirements:** PHP 7.4 or later with GMP or BCMath, and sodium. The plugin checks for them and names a missing one on every admin page; until then your tools answer that the site is not ready, and nothing is charged.

**Background work.** Every minute the plugin claims agent payments, pays out once ZEAM's fee covers the gas, stamps withdrawing channels and buys gate credit. WordPress runs scheduled work on visits: on a low-traffic site, have a cron job request `https://your.site/wp-cron.php` every minute and set `define('DISABLE_WP_CRON', true);` in wp-config.php. "Run now" on the settings page runs it at once.

**Keys.** Before you activate, add an encryption key of at least 32 random characters to wp-config.php: `define('ZEAM_BRIDGE_KEY', '…');`. The plugin makes its settle key on activation, and its credit wallet the first time it runs in gate or both mode, and seals each with it. Without it the plugin derives one from your WordPress salts and says so on its settings page. Keep the value across every move and redeploy; if you set none, keep the WordPress salts instead. Without the one the keys were sealed with, they cannot be opened. A site that already has `ZEAM_PASS_KEY` needs no change: it is read when `ZEAM_BRIDGE_KEY` is not set. With both set, the keys are opened with either and sealed again with `ZEAM_BRIDGE_KEY` on next use; keep it from then on.

**More tools.** Add a tool with the `zeam_bridge_tools` filter. Name: a-z, 0-9 and _. `run` gets the arguments and a meter and returns an array or a `WP_Error`:

`add_filter('zeam_bridge_tools', function ($tools) { $tools['word_count'] = ['description' => 'Counts words.', 'inputSchema' => ['type' => 'object', 'properties' => ['text' => ['type' => 'string']], 'required' => ['text']], 'price' => '0.05', 'unit' => '0.0001', 'run' => function ($args, $meter) { $n = str_word_count($args['text']); $meter->units($n); return ['words' => $n]; }]; return $tools; });`

A tool that runs on time:

`add_filter('zeam_bridge_tools', function ($tools) { $tools['until_deadline'] = ['description' => 'Says when its time ends.', 'meter' => 'time', 'run' => function ($args, $meter) { return ['deadlineMs' => $meter->deadlineMs()]; }]; return $tools; });`

Keys: `description`, `inputSchema`, `outputSchema` (the result's JSON Schema, optional; listed in the 402's x402 bazaar discovery extension), `price` (USD, optional), `unit` (USD per unit, optional), `free` (optional), `meter` (`'time'`, optional), `run`. A `WP_Error` is answered with its code as `error`, its message and the fields of its data, over HTTP and MCP alike, and is not charged per call (on a line, the call uses the time it ran); a `status` of 400 to 599 in its data, other than 402, is the answer's status, for a refusal that is the caller's, with `Retry-After` from `retry_after_seconds`; any other is 500. A `'meter' => 'time'` tool needs line time, is never free, and gets its deadline from `$meter->deadlineMs()` (epoch ms): on a line it spends the line's time; without one it is a paid call that runs for the milliseconds its price buys at your line time rate, and past that it answers 402 `out_of_time`, not charged. The names `buy_time` and `line` are taken. A price that is not USD with up to 6 decimals, $0.000001 to $9,007,199,254.740991, drops the tool. That top is not a business limit: it is the largest amount a number counts exactly in micro-USD. `zeam_bridge_prices` filter, optional, for tools with no price of their own: `($price, $tool, $args)`, `$price` starting null, returns a USD string or `['price' => '0.05', 'unit' => '0.001']`, or null or `''` for the price per call; a return that is not a price answers 500 `price_invalid`. `zeam_pass_tools` and `zeam_pass_prices`, the names before 2.0.0, run first; the `zeam_bridge_` filter gets their result and has the last word.

**Advanced.** The settings page sets the relay (default `https://api.zeampass.com/relay`), the credit service (default `https://api.zeampass.com/credits`) and the Base RPC (default `https://mainnet.base.org`, rate-limited).

== External services ==

The plugin calls four outside services, with only the data listed here.

* **Base RPC** (default `https://mainnet.base.org`, run by Coinbase; configurable). Reads the gas price, the agents' channels in the x402 escrow, and your split's balance. It receives the public addresses and channel ids it is asked about. [Terms](https://docs.base.org/terms-of-service), [privacy](https://docs.base.org/privacy-policy).
* **ZEAM relay** (default `https://api.zeampass.com/relay`, run by ZEAM Labs; configurable). Sends to Base the transactions your site signed (claims, payouts and refunds for your channels) and agents' deposits and MPP charges. It receives those signed transactions, to price and send them, with your split: its address, the addresses it pays and their shares, and its salt; and a channel's id when your site asks what the relay has paid on it. It pays their gas by the rules under Gas and Refunds, and cannot change or redirect them. When a buyer closes an MPP session channel through the relay, the relay's state file also holds the buyer's signed withdrawal from the session escrow and, unless the seller's fees cover its gas, the buyer's signed USDC authorization that pays that gas, until the relay sends them after the channel's grace period ends; they leave the file when they are sent, or when they can no longer be sent: the channel closed, the authorizations expired, or the buyer canceled them. Paywall and both modes. [Terms](https://zeambridge.com/terms), [privacy](https://zeambridge.com/privacy).
* **ZEAM updates** (`https://zeampass.com/downloads/zeam-pass.json`, run by ZEAM Labs). At most every 12 hours, and when you view the update details, WordPress fetches this signed release file to see whether a new version exists, then downloads the new version from `https://zeampass.com/downloads/` when you or your auto-update setting update the plugin. Both requests are plain HTTPS GETs with the user agent `WordPress` and nothing else about your site: no site address, no WordPress or plugin version, no settings, no keys. [Terms](https://zeambridge.com/terms), [privacy](https://zeambridge.com/privacy).
* **ZEAM credit service** (default `https://api.zeampass.com/credits`, run by ZEAM Labs). Where gate mode buys checks after the 10,000 free each month. It receives your payout address, your Bridge name, how many checks to buy, and the USDC payment from your credit wallet, and returns a credit note signed by ZEAM. Gate mode only. [Terms](https://zeambridge.com/terms), [privacy](https://zeambridge.com/privacy).

No personal data about your visitors or editors is sent. Agents' payments reach the relay only as the transactions they signed.

== Changelog ==

= 2.1.0 =
* A free refund to an agent that deposited all the USDC it held is sent. Refund gas is priced at 118,000, what that refund needs, so a channel is refunded free only when its fees cover it. It was priced at 97,000, and the relay refused such a refund as needing more gas than it was priced for. The refund gas an agent pays is unchanged.
* A new seller's first MPP charge, to a split that has never held USDC, is sent. The charge is priced at 105,000 gas, what that transfer needs, so a 402 offers a charge only at a price whose fee covers it. It was priced at 80,000, and the relay refused the first charge as needing more gas than it was priced for.
* When Base's node does not answer, a 402 prices its MPP charge, and every other gas figure it states, on the last gas price the plugin read while that is under 60 seconds old, with the 15% buffer, and asks the node again after a quarter of a second, the wait doubling to 4 seconds, for 20 seconds. With no gas price under 60 seconds old it offers no charge. A 402 whose gas read failed offered no charge.
* A `buy_time` purchase writes its time into the channel's record in the same write that charges it, so time that cannot be recorded is not charged, as the readme says. A purchase whose clock could not be written right after was charged with its time unrecorded (500 `tool_failed`); its time is now kept with the charge and credited once on the channel's next clock write.
* The readme says what `buy_time` takes as the plugin sells it: milliseconds in the smallest step your price divides into whole micro-dollars. It said `buy_time` was paid by the millisecond and took any number of milliseconds.
* Refunds on a channel are taken in the order they reach the plugin: a refund takes its worker place and the channel's lock before its proof is checked, so a request that arrives while a gas-paid refund that arrived before it is still being checked waits for it, and is told `refund_settling` once that refund is sent, never the gas quote kept for it. A request that finished its own checks first could take that kept quote, which counted the money the earlier refund was returning.
* Every answer the refund route gives for a channel carries its `turn`, in the body and in a `Zeam-Refund-Turn` header: the place the plugin gave the request on that channel when it reached the plugin, the order the plugin judges a channel's requests in. An agent, or an auditor, can see that a request answered with a gas quote counting what a refund returns took its turn before that refund, even when it was sent after it. A channel's turns count up from 1 and start again after ten minutes with no refund request on the channel (a `turn` column on the plugin's `tickets` table, and a `turns` table).
* The readme says what the relay is sent, as the plugin sends it: the signed transactions, to price and send, with your split's address, the split itself (the addresses it pays and their shares) and its salt, and a channel's id when the plugin asks what the relay has paid. It named only the split's address and salt.
* The readme says, as Bridge's privacy policy does, that the relay also holds a buyer's signed MPP session exit (the withdrawal from the session escrow and, unless the seller's fees cover its gas, the USDC authorization that pays that gas) until the channel's grace period ends, and that it leaves the relay's state file once sent or once it can no longer be sent. It named only what your site sends the relay.
* An MPP charge whose transfer was sent and has no receipt in time is answered 402 `verification-failed` with `code: "sent_not_shown"`, its `txHash` and `Retry-After`; the hold on the authorization keeps the transaction (a `note` column on the plugin's `held` table). Sent again, the credential is not sent twice: it is delivered once the transfer shows, once, and told nothing was charged only once the chain shows the transfer reverted and the authorization unused. It was answered "Not delivered; nothing was charged" while the transfer could still land.
* The settings page states the name rule beside the Name field: 2 to 32 of a-z, 0-9 and -, starting with a letter, the rule its save enforces. A seller saw it only when a save refused a name.
* A deposit the relay answered with an error, or whose receipt did not come in time, is read on chain before it is answered: when the channel holds it, the call is delivered and charged once, and the channel's balance is the chain's. A deposit sent that has not landed is answered `settle_failed` saying so, not "nothing was charged". Such a deposit was answered `settle_failed` "nothing was charged" even when it had landed.
* A paid call verified against the channel before a refund on it was sent, that takes the channel only after the refund was sent, is verified again on the channel the refund left and answers 402 `payment_invalid` with that `channelState`; nothing is charged. It was reserved against the balance the refund had returned.
* The plugin's description and readme say which tools MPP clients pay for, the set-up step says which rows the settings page shows in each mode, and the line tool's description gives each body as JSON with its op.
* A ZEAM_BRIDGE_KEY or ZEAM_PASS_KEY under 32 characters is named in the key notice as too short and ignored, with the 32 or more characters a key must have. The notice said no ZEAM_BRIDGE_KEY was set.
* An MCP `tools/call` whose `arguments` is present and not an object, such as `[]` or a string, answers the `invalid_arguments` tool error "the arguments must be an object" before any payment terms, as the HTTP route answers such a body. `[]` got the payment terms, and a string a JSON-RPC -32602 error.
* A refund asked for while another refund on its channel is being checked before it is sent waits for that check. A refund holds its channel to be checked from the moment its gas payment is accepted, and a request answered with the answer kept for it, or with no free refund worker, waits for the check too. Once that refund is handed to the relay, it is told `refund_settling`, never a gas quote that counts the money that refund returns.
* An unpaid call whose body is JSON but not an object, such as `[]`, answers 400 `invalid_arguments`, as Node and Python answer it. It got the 402 with the price, which only no body, an empty body or `{}` gets.
* The settings page states the limits its save enforces: free calls an hour from 1 to 1,000,000, and line time milliseconds from 1 to 3,600,000 (empty for 250).
* Every 402 carries `split`: your split's receiver, the split itself and its salt, the same three the relay is sent. The ZEAM :: Pass service pays the gas of an agent's deposit only into a split it has checked, and 2.0.0 said none.
* A refund request answered while a paid call is open on its channel answers 409 `request_open`, and one judged while a call on its channel was charged is judged again, so a gas quote never counts the money a call is spending.
* The fee address and the credit issuer are ZEAM's, set in the plugin; no wp-config.php constant changes them.
* The readme says what a burst of refund requests does to the rest of the site: each request takes a PHP worker while WordPress answers it, so other pages wait for a free worker until the burst is answered.
* A refund request holds its channel's database lock from its proof until its refund is handed to the relay. A paid call, a line `on`, a line call and another refund on that channel wait for the lock, so none is answered from a channel a refund is changing, and a refund asked for while another is being accepted is told `refund_settling`, never a quote that counts the money that refund returns.
* A 402 offers an MPP charge on a gas price at most 5 seconds old, so it does not offer a charge the relay then refuses as below break-even after gas rose.
* Refund requests on a channel that holds nothing, asked for while four are already being worked out on it, are told `nothing_to_return` once one read of the chain agrees with the channel's record, not 503 `refund_unavailable`.
* A time tool priced by the `zeam_bridge_prices` filter is tagged by time, `{"per":"time","usd":…,"ms":…,"varies":true}`: the line rate it is sold at, with its price without a line in each call's 402. It was tagged as a call whose price varies, which dropped the line rate.
* A time tool's 402 states both prices and what a failed call costs on each: the price per call of up to the milliseconds it buys without a line, not charged when it fails, and the line rate, on which a call burns the time it runs, failed or not. It said only the price per call and "A failed call is not charged."
* In "both" mode, a payment that names no payer, neither a voucher nor a deposit, gets the answer a paywall gives it, never 403 `refused`.
* A call cut without a line says it needs more than the milliseconds its price buys, so it was cut. It said the call "ran past" them.
* The line rule in the 402 says `{"op":"off"}` stops new calls on every line of the channel: the meter is the channel's, not one line's.
* A refused MPP credential is answered with its problem and no x402 deposit sentence, in the body, in `PAYMENT-REQUIRED` and over MCP alike. Over MCP it carried the deposit sentence of an unpaid call.
* A refund quote's `coverMicroUSD` is priced at the gas and ETH prices the answer states (`gasPriceWei`, `ethUSD`), the relay's when the relay quotes, so it can be worked out from the answer. It was priced at the plugin's own read.
* The OpenAPI document names every refusal a call on a line to a time tool can answer, by its code, under its status: 402 `meter_off`, `out_of_time`, `channel_leaving` and `refund_settling`, 403 `line_unknown`, 429 `too_many_calls`, and 499 `client_gone`, which every paid tool now lists.
* The settings page and the readme say where agents see your contact: in the 402 an unpaid call gets and when a key is refused. They said every 402 and every refusal; the 402s of a line or a refund and the other refusals do not carry it.
* A usage tool that reports no units is answered with the failed-call rule and its line clause, as a result that is not valid JSON is: "the tool reported no units. A failed call is not charged. On a line a call uses the time it runs, whether or not it succeeds." It said "Nothing was charged." The readme says the same of a call that reports no units and of a post that is not valid JSON.

= 2.0.0 =
* A major version: the plugin has a new name, a price has no $1,000 top, and a signature is taken in one form only, so a call 1.0.11 took can be refused.
* The OpenAPI document says how each tool is paid (`x-payment-info`: the price, x402, and the MPP charge its 402 carries) and is also answered at `/openapi.json` on your site's root, where MPP directories look. "Do not answer /openapi.json at the site root" on the settings page switches the root address off.
* The plugin is named ZEAM Bridge. Nothing to do: settings, keys, tools, addresses and the update file are unchanged. New names beside the old, which keep working: `ZEAM_BRIDGE_KEY` (`ZEAM_PASS_KEY`), the `zeam_bridge_tools` and `zeam_bridge_prices` filters (`zeam_pass_tools`, `zeam_pass_prices`), `/wp-json/zeam-bridge/` (`/wp-json/zeam-pass/`).
* A price has no $1,000 top: $0.000001 to $9,007,199,254.740991.
* Time bought while a call runs on a line keeps it running. A call that outran its line is billed what the line held, never time bought afterwards.
* An agent that cancels a call over MCP (`notifications/cancelled`, with the call's line or its session) is billed to that moment on a line and not charged for a call priced per call. `$meter->stopped()` tells your tool. The 402 says a call the agent hangs up on is billed until it returns.
* Bought time is credited only after its payment settles.
* A line takes up to 1,000 calls at once; one over answers 429 `too_many_calls`. Calls at once never multiply the bill.
* A paid call that arrives while a refund settles on its channel answers 402 `refund_settling` and is not charged.
* A refund request is judged before it holds the channel, and one that ends refused never holds it: `refund_settling` answers only while a refund is being sent, and a request on a channel that holds nothing is told `nothing_to_return`, never `refund_settling`.
* A failed call on a line carries the meter reading: `X-Pass-Ms-Remaining` and `X-Pass-Ms-Elapsed` over HTTP, `_meta["zeam-pass/meter"]` over MCP.
* An MPP problem is served as `application/problem+json`.
* A tool that fails answers with its `tool` name beside the error and the message, as the Node and Python plugins do.
* A tool's `WP_Error` is answered with the fields of its data over HTTP as over MCP, and a `status` of 400 to 599 in its data, other than 402, is the answer's status, for a refusal that is the caller's.
* A refund that cannot hold its channel, because the database fails, sends nothing and answers 503 `refund_unavailable` with `retry_after_seconds`.
* A burst of refund requests on one channel is worked out at most four requests at a time. The rest are answered as soon as a PHP worker takes them, without waiting: from the channel's record, `refund_settling` while a refund is being sent, the answer just given to the same request, or `request_open` while a call is open; `nothing_to_return` when the record shows the channel holds nothing and one read of the chain agrees; or else 503 `refund_unavailable` with `retry_after_seconds` 1. Under Apache's prefork, KeepAlive holds each worker idle after it answers, up to KeepAliveTimeout (5 s by default), so a burst sent over connections the client keeps open is answered a few workers at a time; a site that takes bursts turns KeepAlive off (`KeepAlive Off` in the Apache configuration, or ask your host). Each request of a burst still takes a PHP worker while WordPress loads and answers it, and the site's workers are shared by every page and channel, so a burst delays the whole site until it is answered, a paid call sent during it included. More PHP workers, or a per-client limit on the refund route in front of WordPress, shorten it.
* While a refund request on a channel is being worked out, its line's meter stays off: `{"op":"on"}` answers 402 `refund_pending` and changes nothing until the refund is answered, and a paid call on the channel waits for the answer.
* A channel can be refunded again within the hour.
* A gate proof is accepted once for as long as it is valid.
* A signature is taken in one form: 65 bytes, v 27 or 28, low s.
* Free calls an hour are counted per address on IPv4 and per /64 on IPv6.
* Every MPP challenge is its own, and its charge request names the Permit2 contract. A second copy of an MPP credential is refused as already used, with a fresh challenge. A bad grant sent with an MPP credential answers 402 `bad_grant`.
* An MPP charge accepted and not yet settled is held in the site's database, not in a transient an object cache can drop, so a restart cannot run the same charge twice.
* A voucher whose amount is not a plain decimal is refused.
* Over MCP an MPP challenge keeps `opaque` as the base64url string its header carries, so an MPP client reads it there.
* A call on a line whose request ended before its tool returned is billed the time it ran, not the time to its deadline.
* The OpenAPI document and the link in your pages' head name MPP beside x402 in paywall and both modes. The OpenAPI document lists the 402 `refund_settling` and the 429 `too_many_calls`.
* The message of a 500 `price_invalid` starts `bridge:`.

= 1.0.11 =
* MPP clients can pay: the 402 for a tool priced per call also carries an MPP `Payment` challenge when ZEAM's 9.99% fee on that one call covers the gas of one USDC transfer plus 15%, and an MPP client pays the call with one USDC transfer to your split. Tools priced by use and purchases of line time stay x402 only.
* A deposit signed on another call's dearer row is refused as matching no requirement whatever its size, not as under the floor.
* The readme and the settings page say the relay sends MPP charges too, and when it pays their gas.
* The OpenAPI document lists the 503 each route can answer.
* An MPP authorization signed to outlive its challenge is refused and takes nothing.
* The refund route says so when `issued` is missing.

= 1.0.10 =
* The readme says Patent pending. No code change from 1.0.9.

= 1.0.9 =
* The settings page says what a failed call costs: nothing per call, and on a line the time it ran.
* Set-up puts the encryption key before activation, where the keys are made.
* After a refund, the corrective 402 carries no empty fields, so the stock x402 client resyncs and pays again.
* The deposit floor is exact: a deposit under it by any amount is refused as such.
* A deposit under the floor is refused with the call's price stated as a ceiling, and the OpenAPI document lists the 500 a failing tool returns.

= 1.0.8 =
* The smallest deposit an agent can make now always leaves enough to get the rest back: after one call, the balance covers the gas of a refund paid for in USDC. Sellers at the standard fee see no change.

= 1.0.7 =
* Line time is sold by the millisecond. Agents call `buy_time` with `ms`, in the smallest step your price divides into whole micro-dollars (any number of milliseconds when a millisecond costs a whole number of micro-dollars), and buying again adds time; the one-hour limit on a purchase is gone. The price reads as dollars per millisecond everywhere an agent sees it. Agents that still send `blocks` keep working, and your saved line time price is unchanged.

= 1.0.6 =
* A paid call's 402 carries the x402 bazaar discovery extension: the tool's input schema, its output schema, and how to call it, so x402 directories can list and call your tools.

= 1.0.5 =
* An unpaid call with no arguments answers 402 with the price, as x402 directories expect when they probe. Arguments that are present are still checked before any payment.

= 1.0.4 =
* Updates from zeampass.com, signed.

= 1.0.3 =
* Distributed from zeampass.com only.

= 1.0.2 =
* Readme: gate pricing, the seller's choice when credit runs out, and the credit service stated plainly.

= 1.0.1 =
* Plugin Check clean: exception messages escaped, queries prepared with fixed table names, input unslashed and sanitized, the file stores used only by the tests left out of the plugin.

= 1.0.0 =
* Prices per tool, free tools, a free-call limit per address, usage pricing by unit.
* `zeam_pass_tools` and `zeam_pass_prices` filters.
* Line time: `buy_time`, `line`, `POST /wp-json/zeam-pass/line`, time tools; unburned time refunded.

= 0.6.0 =
* A refused key is told where to ask: your contact, or your site's address. Every 402 and the OpenAPI document carry it.
* A post that is not valid JSON (non-UTF-8 bytes) is a failed call: nothing charged per call (on a line the call has used the time it ran).
* Outbound requests use the WordPress HTTP API.
* BCMath when GMP is missing.
* A deposit delivers only with a recorded charge.
* Every relay gas unit counts against the 9.99% fee.
* Refunds: ZEAM pays the gas when the channel's fees cover the gas of its deposit, its refund and any calls not yet settled, and of every further deposit and every earlier refund ZEAM paid for on that channel, plus 15%; otherwise the buyer signs a gasless USDC payment of the quoted gas (15% margin) and the relay sends refund and payment in one transaction; a requote when the payment is under what sending costs (gas moved past the margin, or less than the quote was signed). {"selfSend": true} returns a signed refund of the full balance.
* channelConfig refunds a channel with no calls; a mismatched one is refused (channel_config_mismatch).
* MCP errors carry the HTTP fields in structuredContent; in both mode PAYMENT-REQUIRED carries the admission field.
* Both mode: X-Pass-Granted-By (MCP: `_meta["zeam-pass/granted-by"]`) on granted answers; a refused key gets a `how`.
* The gate admits keys; the payout wallet admits no one.
* Grants box on the settings page.
* "Pay out now" shows its answer.
* A payment that does not verify gets the same error, code and reason over HTTP and MCP; a non-JSON body gets a 400.

= 0.5.0 =
* The engine runs inside WordPress: verify, hold, settle, claim, pay out and refund, with its own keys.
* Gate and both modes: admitted keys and grants (x-grant). Gate: 10,000 free checks a month, automatic credit purchase.
* Channels, gate usage and replay protection in the WordPress database, each read-modify-write under a database lock.
* Keys generated on activation, encrypted with libsodium.
* A one-minute schedule for claims, payouts, withdrawals and credit; "Run now".
* Pay out now: through the relay once ZEAM's fee covers the gas, or as a transaction from your own wallet, which then needs ETH.

= 0.3.0 =
* Hold, run, settle: a payment settles only after the tool succeeds.
* Arguments are checked against each tool's input schema before any payment.

= 0.2.0 =
* MCP and x402 HTTP tools, search_posts and read_post.
