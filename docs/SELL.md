# Selling with ZEAM :: Bridge

A gate, a paywall or both in front of your API, MCP server or WordPress site. No OAuth, no sign-up, no account with
us. Agents get in with a key. Install the plugin; connect your payout wallet.

- **Gate:** admits the keys you list. Each call is signed with the agent's key as a zero-value x402 payment: nothing
  is paid, the key needs no funds or ETH, nothing goes on chain. A listed key can sign a grant that admits one other
  key, for one tool or all, until a set time.
- **Paywall:** agents pay per call in USDC, from a wallet or a pass. You keep 90.01% of every sale. A failed call is
  not charged; on a line, a call uses the time it runs.
- **Both:** listed keys, paid per call.

The engine runs in your process with your keys. ZEAM holds none of your money or keys and makes no admission
decisions.

## Set up

1. **Install the plugin:** Node `@zeambridge/bridge`, Python `zeambridge`, WordPress `ZEAM Bridge`: `npm install @zeambridge/bridge`
   (Node ≥18) / `pip install zeambridge` (Python ≥3.9) / download https://zeampass.com/downloads/zeam-pass-2.0.0.zip and use
   Plugins → Add New → Upload Plugin; before you activate it, add `define('ZEAM_BRIDGE_KEY', '…');` (32 or more random
   characters) to wp-config.php and keep it.
2. **Connect your payout wallet.** Your earnings go there. It admits no one; the gate admits the keys you list.
3. **Choose** gate, paywall or both. Paywall: set a price per call. Gate: list the keys you admit.

Node takes these options or reads ./bridge.json; Python takes them as keyword arguments to `Bridge(...)`; WordPress has
a settings page.

```json
{ "name": "acme", "site": "https://acme.example", "mode": "paywall", "price": "0.02",
  "payout": "0xYourWalletAddress" }
```

The agent side: [docs/AGENTS.md](../../docs/AGENTS.md).

Formerly ZEAM :: Pass: `@zeam-labs/pass`, `zeam-pass` and `import zeam_pass` keep working and point here; Node's `pass()` is `bridge()`, and `./pass.json` is still read. Each `BRIDGE_…` setting is still read under its `PASS_…` name (on a machine that also runs the Pass client, set the `BRIDGE_…` names: both read `PASS_STATE_DIR` and `PASS_NAME`); on WordPress the plugin's folder and download stay `zeam-pass`, and `ZEAM_PASS_KEY`, the `zeam_pass_tools` and `zeam_pass_prices` filters and `/wp-json/zeam-pass/` keep working.

## Serving agents

Your site serves your tools:

- **MCP** at `/mcp`; payment rides in the tool call's `_meta`.
- **HTTP** at `POST /v1/<tool>`, with the x402 or MPP headers, and `/openapi.json`.
- **Directories** read `/openapi.json` at the root of your origin, over HTTPS. Each paid tool there carries a `402`
  response and `x-payment-info`: its price, x402, and the MPP charge its 402 carries where it carries one. WordPress
  serves it at the root when the site is installed at the root of its domain and permalinks are not "Plain". On Node
  switch it on with `agents.handle('/agents', { discovery: true })`. On Python add one route that returns
  `agents.discovery(origin, "/agents")`; the Python guide shows it. Where your own app already serves
  `/openapi.json`, Bridge does not replace it.

Arguments are checked before any charge; an unpaid HTTP call with no arguments, as x402 directories send to read the
price, gets the 402 with your terms. The 402 carries the x402 `bazaar` discovery extension: how to call the tool,
its input schema and its output schema, so x402 directories can list it. The plugin verifies the payment, holds it while your tool runs, and settles
it only if the tool succeeds, whether or not the agent is still connected to receive the answer.

Prices per tool:

| Kind | Set | The agent pays |
|---|---|---|
| per call | `price` (the default), or a tool's own price | that price per call |
| free | `free` | nothing; optional `freeLimit`: calls an hour per address, then 429 |
| usage | a tool's `price` and `unit`; the tool reports units | units × `unit`, at most `price` (reserved per call) |
| time | `time: { usd: "0.00025", ms: 250, maxCalls: 1000 }`; a tool's `meter: "time"` | milliseconds bought with `buy_time`, burned while calls run on a line; unburned time refunded. `maxCalls` (1..1000, default 1000) caps how many calls run at once on one line; the next is refused `429 too_many_calls` |

The 402, `tools/list` (`_meta["zeam-pass/price"]`) and `/openapi.json` (`x-price`) show each tool's price.

Time: with a line-time price set, the plugin adds `buy_time`, `line` and `POST <base>/line`; on WordPress, once one of your tools runs on time. An agent buys milliseconds, opens a line with its payer key, and calls time
tools on it with no payment per call. Time burns while a call runs; a call stops when the time runs out. Time is
credited only after the payment settles; you are paid only for time that burned; unburned time goes back with the
agent's refund. Many calls can run on one line at once; they share one clock, so you are paid for the wall-clock the
line is busy, not the sum of the overlapping calls. `maxCalls` (1..1000, default 1000) caps how many run at once —
lower it to bound the parallel work one buyer can start on your backend; the call over the cap is refused `429
too_many_calls`. The WordPress plugin has no setting for it: its cap is 1000. Time state is in your state directory (`meter/`; WordPress: its database), so a host with no disk that lasts
should not sell time. Detail: [docs/AGENTS.md](../../docs/AGENTS.md),
section 2.

## WordPress tools

The plugin serves `search_posts` and `read_post`. Add a tool of your own with the `zeam_bridge_tools` filter. A name is
a-z, 0-9 and _. `run` gets the arguments and a meter and returns an array or a `WP_Error`:

```php
add_filter('zeam_bridge_tools', function ($tools) { $tools['word_count'] = ['description' => 'Counts words.', 'inputSchema' => ['type' => 'object', 'properties' => ['text' => ['type' => 'string']], 'required' => ['text']], 'price' => '0.05', 'unit' => '0.0001', 'run' => function ($args, $meter) { $n = str_word_count($args['text']); $meter->units($n); return ['words' => $n]; }]; return $tools; });
```

A tool that runs on time:

```php
add_filter('zeam_bridge_tools', function ($tools) { $tools['until_deadline'] = ['description' => 'Says when its time ends.', 'meter' => 'time', 'run' => function ($args, $meter) { return ['deadlineMs' => $meter->deadlineMs()]; }]; return $tools; });
```

Keys: `description`, `inputSchema`, `outputSchema` (the result's JSON Schema, optional; listed in the 402's x402 bazaar discovery extension), `price` (USD, optional), `unit` (USD per unit, optional), `free` (optional), `meter` (`'time'`, optional), `run`. A `'meter' => 'time'` tool needs line time, is never free, and gets its deadline from `$meter->deadlineMs()` (epoch ms): on a line it spends the line's time; without one it is a paid call that runs for the milliseconds its price buys at your line time rate, and past that it answers 402 `out_of_time`, not charged. The names `buy_time` and `line` are taken. A price that is not USD with up to 6 decimals, $0.000001 to $9,007,199,254.740991, drops the tool. That top is not a business limit: it is the largest amount a number counts exactly in micro-USD. `zeam_bridge_prices` filter, optional, for tools with no price of their own: `($price, $tool, $args)`, `$price` starting null, returns a USD string or `['price' => '0.05', 'unit' => '0.001']`, or null or `''` for the price per call; a return that is not a price answers 500 `price_invalid`.

## Money

- **Split.** Earnings go to your split contract: no owner, ZEAM included; no one can change it. It pays 90.01% to
  your wallet and 9.99% to ZEAM.
- **Gas.** An agent needs no ETH to pay on the USDC row without Permit2, and you, the seller, need none to be paid. ZEAM's relay sends what your Bridge signed, to where it signed it (claims, payouts and refunds for your channels), and agents' deposits and MPP charges, which the agent signed. It pays the gas of every deposit it sends; of a claim or payout when
  ZEAM's 9.99% fee on it covers that gas; and of an MPP charge on the same rule (a charge whose fee does not cover it is not sent: the call is not delivered and nothing is charged). A refund has its own rule, under Refunds.
- **Payouts.** Automatic once ZEAM's 9.99% fee on a payout covers its gas. The first payout waits for more sales: it also creates your
  split, which costs more gas.
- **Deposits.** An agent's first call on a channel deposits at least the deposit floor: your price per call, or the gas floor where that is higher (about $0.036 at a gas price of 0.0084 gwei and ETH at $2,370; it tracks gas, and your 402 states the live figure); later
  calls spend it, and a later top-up meets the same floor.
- **Refunds.** The unspent balance goes back to the agent through the relay. ZEAM pays the gas when the channel's
  fees cover the gas of its deposit, its refund and any calls not yet settled, and of every further deposit and every earlier refund ZEAM paid for on that channel, plus 15%; otherwise the agent pays the quoted gas in USDC (15% margin, priced by the
  relay, public at `https://api.zeampass.com/relay/quote`). Nothing is claimed for you from it. `selfSend`: the
  agent gets a signed refund of the full balance and sends it from any wallet with ETH on Base for gas. Without you:
  the agent sends `initiateWithdraw`, then `finalizeWithdraw` after the withdrawal delay, each from the channel's
  payer wallet with ETH on Base for gas, for at most the channel's `balance` minus `totalClaimed` in the escrow.
  Detail: [docs/AGENTS.md](../../docs/AGENTS.md), section 5. When a buyer paid with a pass and you
  refuse its refund, the pass service hands that buyer's funding wallet the same escrow withdrawal to broadcast itself; the
  pass service does not send it or pay its gas.
- **MPP clients.** For a tool priced per call, your 402 also carries an MPP `Payment` challenge (the
  `WWW-Authenticate: Payment` header) when ZEAM's fee on that one call (9.99% of it; all of it when your payout is the fee address) covers the gas of one USDC transfer plus 15%; an MPP
  client pays that call with one USDC transfer to your split. Nothing to set up. Below that price your 402 offers
  x402 only (and, on Node, a session where you have turned sessions on: MPP sessions, below), and so does every tool priced by use and every purchase of line time.
  A time tool called without a line is a tool priced per call here, at its `callUSD`.
- **Stock x402 clients.** Stock x402 clients deposit 5x your price. They work when your price is at least 1/5 of the
  deposit floor in your 402 `deposit` line. Example: floor $0.036, price $0.0072 and up. Line time follows the same
  rule: on a new channel a stock client's first purchase must cost at least 1/5 of the floor, so it buys that many
  milliseconds or more; a pass and the Pass client deposit enough for a small purchase. Use the Pass client
  4.0.0 or later: earlier versions, formerly `@zeam-labs/x402-mcp-bridge`, read `X402_…` settings.

## MPP sessions

Node only, for now: the Python and WordPress plugins offer no session. Off until you turn it on:
`sessions: { escrow: '0x5e09aD70b644414cD1cD7Df1d9a10fF7899D92B8', factory: '0xE18fCE1266056becA4a3B0edfc15F8634EA6901B' }`
in your Bridge's options, in mode `paywall` or `both`. Those are the `EvmPaymentChannel` escrow on Base and its payee
factory, both deployed on 2026-10-13 and immutable.

**The session contracts are not audited.** Nobody outside their authors has reviewed them. A buyer's deposit sits in
the escrow, and what a session earns you passes through your payee contract, below.

- **What a buyer sees.** Your 402 for every tool priced per call carries a second MPP `Payment` challenge,
  `intent="session"` (`draft-evm-session-00`), at the same price as every other way to pay, whether or not it
  carries a charge. A tool priced by use and a purchase of line time get none.
- **How a buyer pays.** One deposit into the escrow, which the relay sends from the buyer's signed authorization
  (for a pass, the pass service sends it), then one signed voucher per call. A call that fails is not charged.
- **Your payee.** A session pays your `SessionPayee` contract, at the factory's `addressOf(your settle key's address,
  your split)`. It signs for your split, which cannot sign, and forwards all it receives to it; your split and its
  90.01% and 9.99% are as they were. Your 402 publishes the split, its salt and the settle key's address beside the
  challenge so a buyer can check the payee. The relay creates the payee with your first session payout.
- **Settlement.** Each background run claims session channels that have been idle 20 seconds, once ZEAM's fee on what
  it claims covers the gas. The payout that follows sweeps the payee to your split, distributes the split and
  withdraws to your wallet, by the rule under Payouts below break-even. You need no ETH.
- **A buyer leaves.** On a buyer's close you are paid what it spent and the rest of its deposit returns to it in the
  same transaction; the relay sends that free when the channel's fees cover the gas of its open, of every top-up and
  close request the relay sent for it, and of its close, and
  otherwise takes the gas in USDC from what returns to the buyer, who needs no ETH. A buyer
  can also leave without you: it asks the escrow to close and withdraws after 15 minutes, and a background run
  in that time claims what it spent without waiting for the channel to be idle. A buyer you have taken off your access list can still close.

What a buyer signs and checks: [docs/AGENTS.md](../../docs/AGENTS.md), section 7.

## The gate

- **Admitting keys.** List the addresses of the keys you admit: `admit` in Node (`bridge.json` or `bridge({ admit })`)
  and Python (`Bridge(admit=[...])`); "Admitted keys" on the WordPress settings page.

  ```json
  { "name": "acme", "mode": "gate", "payout": "0xYourWalletAddress",
    "admit": ["0xAgentKeyAddress", "0xAnotherAgentKeyAddress"] }
  ```

- **Contact.** A key not on your list is refused with a `how` that says to ask you. Set `contact` to an `http(s)://`
  page or a `mailto:` address: Node `bridge({ contact })` or `bridge.json`, Python `Bridge(contact=...)`, WordPress
  "Contact for access". It goes in every 402, in that refusal and in your `openapi.json`. WordPress defaults to your
  site's address and never shows your admin email.
- **What an agent sends.** A zero-value x402 `exact` payment signed with its key, on every call (any x402 client
  makes one). It moves nothing and is never sent to the chain. Your Bridge verifies the signature in your process,
  refuses a replay, and admits the key if its address is on your list. Agent side:
  [docs/AGENTS.md](../../docs/AGENTS.md), section 3.
- **Grants.** A listed key can admit one other key: it signs a grant naming that key, one tool (or `*`) and an end
  time; the agent sends the grant as the `x-grant` header. A call signed by any other key is refused `bad_grant`.
  Remove the signing key from your list and every grant it signed ends. On a line the list is checked when the
  channel pays, at its deposit and at each purchase of time, not on each call that rides the line: a key you remove
  can use up time it already bought and can buy no more.

  Node:

  ```js
  import { signGrant } from '@zeambridge/bridge'

  const grant = await signGrant({ key: process.env.ADMITTED_KEY, delegate: '0xTheirKeyAddress', scope: 'search', until: '2026-12-31T00:00:00Z' })
  ```

  Python:

  ```python
  import os
  from zeam_bridge import sign_grant

  grant = sign_grant(os.environ["ADMITTED_KEY"], "0xTheirKeyAddress", "2026-12-31T00:00:00Z", scope="search")
  ```

  `key`: the private key of a listed address. `scope`: a tool's name, or `*` (the default) for every tool. `until`: an ISO time, a `Date` or a
  timezone-aware `datetime`. Both return the `x-grant` value for the agent. WordPress: the Grants box on the settings
  page signs with your browser wallet when it holds a listed key.

  The grant is base64url JSON `{delegate, scope, until, signature}`; `signature` is the admitted key's EIP-191
  signature of:

  ```
  ZEAM Pass grant
  delegate: <the key's address, lowercase>
  scope: <tool, lowercase, or *>
  until: <ISO time>
  ```

  A grant made by hand with no `scope` is signed with the line `scope: self`; it covers every tool, as `*` does.
- **Price.**
  - 10,000 checks a month are free.
  - Your Bridge makes a credit wallet the first time it runs in gate or both mode; `status()` (WordPress: the settings page, in gate mode) shows its address. It
    holds the gate's USDC on Base and needs no ETH. Node: `keys: { credit }` sets your own.
  - Credit is 2,000 checks at a time for $1 USDC ($0.50 per 1,000), bought after the month's 10,000 free checks are
    used and again below 200 remaining. Keep $1 USDC on Base in the credit wallet.
  - Credit at 0: refuse (default), or with `"onEmpty": "allow"`, admit and warn.
- **Both mode:** paid calls are not gate checks. `both` mode needs no USDC in the credit wallet.

## Status

`status()` (WordPress: the settings page) answers:

- `unclaimed`: `microUSD` paid to you and not yet claimed from the escrow, over `channels` channels.
- `claimedNotPaid`: `microUSD` claimed and not yet paid to your wallet. `splitDeployed` is false until your first
  payout creates your split.
- `lastPayout`: when, how much, which transactions. `lastTick`: the last background run.
- `gate`: this `month`'s `used` checks, the `free` allowance, `credit` left, `onEmpty`, and `unpaidAt` when calls
  were admitted with no credit.
- `creditWallet`: its `address` and `usdcMicro` balance.
- `chainError`: the chain read for the figures above failed.

**Payouts below break-even.** The relay pays out when ZEAM's 9.99% of the payout covers its gas; you keep 90.01%. The
gas is priced live: your Bridge asks the relay, which estimates the payout transaction itself at the current gas price,
adds Base's L1 fee and 15%. Only when the relay cannot be asked does your Bridge fall back to its own fixed estimate. A
payout (claim, settle, distribute, withdraw) goes out as one Multicall3 transaction in that order, all or nothing.
Below break-even, `unclaimed` or `claimedNotPaid` stays above 0, `lastTick.claims.USDC.waiting` reads "below
break-even: waits until the fee share covers the gas", and `payout()` (Python: `payout_now()`) answers
`paidBy: "you"` with `valueUSD`, `gasUSD` and a `transaction` to send from your own wallet, the seller's, which then
needs ETH on Base for gas. Nothing else a seller does needs ETH.

## What ZEAM runs

- **The ZEAM :: Bridge relay:** sends to Base the transactions your Bridge signed (claims, payouts and refunds for your channels) and
  agents' deposits and MPP charges. It pays the gas of every deposit it sends, and of a claim, payout, refund or MPP charge by the rules under Money.
- **The ZEAM :: Bridge credit service:** sells gate checks.

Neither holds anything of yours.
