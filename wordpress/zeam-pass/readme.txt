=== ZEAM Bridge ===
Contributors: skimzey
Tags: agents, x402, mpp, paywall, mcp
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 2.0.0
License: GPL-2.0-only
License URI: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

A gate, a paywall or both in front of your posts for AI agents. No OAuth, no sign-up, no account with us.

== Description ==

Patent pending.

AI agents search and read your posts on your site, over MCP and HTTP, with two tools: search_posts and read_post. x402 and MPP clients both pay.

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
* **Refunds.** An agent's unspent balance goes back through `/wp-json/zeam-pass/refund`. ZEAM pays the gas when ZEAM's fee on what the channel spent covers the gas of its deposit, its refund and any calls not yet settled, and of every further deposit and every earlier refund ZEAM paid for on that channel, plus 15%; otherwise the agent pays the quoted gas, 15% included, in USDC out of what comes back. `selfSend` gives the agent a signed refund of the full balance, which it sends from any wallet with ETH on Base for gas. Without you: the agent sends `initiateWithdraw`, then `finalizeWithdraw` after the withdrawal delay, each from the channel's payer wallet with ETH on Base for gas, for at most the channel's `balance` minus `totalClaimed` in the escrow.
* **Gate pricing.** Gate mode is a metered ZEAM service. 10,000 checks a month are free. After that, your site buys credit from the ZEAM credit service automatically, paid from its credit wallet, whose address the settings page shows: 2,000 checks at a time for $1 USDC ($0.50 per 1,000), bought after the month's 10,000 free checks are used and again below 200 remaining. Keep $1 USDC on Base in the credit wallet. It needs no ETH. Paywall mode uses no credit and has no limit. `both` mode needs no USDC in the credit wallet: paid calls are not gate checks.
* **When gate credit runs out, you choose.** "Refuse agents until credit is added" (the default) or "Admit agents and warn me here." Nothing else in the plugin stops or changes.
* **Prices per tool.** Each tool: its own price, else what the `zeam_bridge_prices` filter gives, else the price per call. A 402 carries that call's amount, `pricing` for it and `prices` for every tool. `tools/list`: `_meta["zeam-pass/price"]`. OpenAPI: `x-price`.
* **Free tools.** Check "Free" on a tool: no payment, no key, arguments still checked. "Free calls an hour per address": N per tool per IP per clock hour; over it a 429 with `Retry-After` and `retry_after_seconds`. Empty: no limit.
* **Usage.** A tool with a `unit` price reserves its price, reports units, and is charged units x unit, at most the reserve. No units reported: failed, nothing charged. The settle answer has `chargedAmount` and `reservedAmount`.
* **Line time.** Set a price in USD and the milliseconds it buys (default 250). Once one of your tools runs on time (`'meter' => 'time'`, under More tools), the plugin adds `buy_time` (paid by the millisecond) and `line` (free); until then nothing sells time. 1. `buy_time {"ms": N}` (`N` is a number of milliseconds): credited to the paying channel with the payment; time that cannot be recorded is not charged. 2. `POST /wp-json/zeam-pass/line {"op":"open","channelId":"0x…"}` answers `nonce` and `sign`; sign `sign` with the payer key and post `{"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"}`: a credential. 3. Call a time tool with header `x-line` (MCP: `_meta["zeam-pass/line"]`): no payment, time burns while it runs, `X-Pass-Ms-Remaining`, `X-Pass-Ms-Elapsed`. Out of time: 402 `out_of_time`. An agent that cancels a call over MCP (`notifications/cancelled`) is billed to that moment, and `$meter->stopped()` is true in your tool from then: return there. WordPress cannot see an agent hang up while your tool runs, so that call is billed until your tool returns. 4. A refund returns unburned time (`timeReturnedMs`) and closes the line. You are paid only for time that burned. Calls that overlap on one line share one clock, so you are paid for the wall-clock the line is busy, not the sum. Up to 1,000 run at once on one line, and the plugin has no setting to lower that; the one over is refused `429 too_many_calls`.
* Optional: hold the full text back from the WordPress REST API and your RSS and Atom feeds; anonymous readers get the excerpt and a pointer to your tools. Your pages and logged-in editors are unaffected.

== Installation ==

1. Download the plugin: https://zeampass.com/downloads/zeam-pass-2.0.0.zip (its SHA-256 is next to it, at the same address plus .sha256). Plugins -> Add New -> Upload Plugin, choose the zip, Install Now.
2. Before you activate, add an encryption key of at least 32 random characters to wp-config.php and keep it: `define('ZEAM_BRIDGE_KEY', '…');`
3. Activate, then Settings -> ZEAM Bridge.
4. Connect your payout wallet: your browser wallet, or paste the address.
5. Name, under Advanced on the settings page: with your wallet it fixes your split's address and holds your gate credit. It defaults to one made from your site title; set it before you take payments. A change moves new earnings to a new split and leaves gate credit bought before it behind, and the settings page refuses it while the current split has earnings not yet claimed: pay out first.
6. Choose gate, paywall or both. Paywall: set a price per call; optional, a price or Free per tool, free calls an hour per address, and a line-time price with the milliseconds it buys. Line time is sold only once you add a tool that runs on time, with `'meter' => 'time'` in the `zeam_bridge_tools` filter; until then the price is saved and nothing sells time. Gate: list the addresses of the keys you admit. "Contact for access": a web address or a mailto: address where an agent asks to be admitted. Agents see it in every 402 and when a key is refused. Empty: your site's address; your admin email is never shown.
7. Save. The page shows your split, earnings, gate usage and the credit wallet to fund.
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

**Advanced.** The settings page sets the relay (default `https://api.zeampass.com/relay`), the credit service (default `https://api.zeampass.com/credits`) and the Base RPC (default `https://mainnet.base.org`, rate-limited). Development only: `ZEAM_BRIDGE_FEE_RECIPIENT` and `ZEAM_BRIDGE_CREDIT_ISSUER` (or the same with `ZEAM_PASS_`) in wp-config.php override the fee address and the credit issuer.

== External services ==

The plugin calls four outside services, with only the data listed here.

* **Base RPC** (default `https://mainnet.base.org`, run by Coinbase; configurable). Reads the gas price, the agents' channels in the x402 escrow, and your split's balance. It receives the public addresses and channel ids it is asked about. [Terms](https://docs.base.org/terms-of-service), [privacy](https://docs.base.org/privacy-policy).
* **ZEAM relay** (default `https://api.zeampass.com/relay`, run by ZEAM Labs; configurable). Sends to Base the transactions your site signed (claims, payouts and refunds for your channels) and agents' deposits and MPP charges. It receives those signed transactions and your split's address and salt, pays their gas by the rules under Gas and Refunds, and cannot change or redirect them. Paywall and both modes. [Terms](https://zeampass.com/terms), [privacy](https://zeampass.com/privacy).
* **ZEAM updates** (`https://zeampass.com/downloads/zeam-pass.json`, run by ZEAM Labs). At most every 12 hours, and when you view the update details, WordPress fetches this signed release file to see whether a new version exists, then downloads the new version from `https://zeampass.com/downloads/` when you or your auto-update setting update the plugin. Both requests are plain HTTPS GETs with the user agent `WordPress` and nothing else about your site: no site address, no WordPress or plugin version, no settings, no keys. [Terms](https://zeampass.com/terms), [privacy](https://zeampass.com/privacy).
* **ZEAM credit service** (default `https://api.zeampass.com/credits`, run by ZEAM Labs). Where gate mode buys checks after the 10,000 free each month. It receives your payout address, your Bridge name, how many checks to buy, and the USDC payment from your credit wallet, and returns a credit note signed by ZEAM. Gate mode only. [Terms](https://zeampass.com/terms), [privacy](https://zeampass.com/privacy).

No personal data about your visitors or editors is sent. Agents' payments reach the relay only as the transactions they signed.

== Changelog ==

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
* A burst of refund requests on one channel holds at most four of the site's PHP workers. The rest are answered from the channel's record as soon as a PHP worker takes them, without reading the chain or waiting: `refund_settling` while a refund is being sent, the answer just given to the same request, `request_open` while a call is open, or else 503 `refund_unavailable` with `retry_after_seconds` 1. Under Apache's prefork, KeepAlive holds each worker idle after it answers, up to KeepAliveTimeout (5 s by default), so a burst sent over connections the client keeps open is answered a few workers at a time; a site that takes bursts turns KeepAlive off (`KeepAlive Off` in the Apache configuration, or ask your host).
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
* A post that is not valid JSON (non-UTF-8 bytes) is a failed call: nothing charged.
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
