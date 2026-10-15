# ZEAM :: Pass for agents

A ZEAM :: Bridge seller serves its tools on its own site:

- **MCP** at `<base>/mcp`. `tools/list` is free. A paid call carries the x402 PaymentPayload as a JSON object in
  `_meta["x402/payment"]`, or an MPP credential (section 7).
- **HTTP** at `POST <base>/v1/<tool>`, with the x402 `PAYMENT-SIGNATURE` header (base64 of the PaymentPayload JSON), or an MPP credential (section 7).
  `<base>/openapi.json` lists the tools; its `info.description` states the mode: paywall, gate or both. A seller may
  list only its paid tools there, and its `info.description` then says where the free ones are. Each paid
  operation carries `x-payment-info`: `price` (`{"mode":"fixed","currency":"USD","amount":"0.02"}`, or `"dynamic"` with
  `min` and `max` where the seller states them), `protocols`, and `offers` with the MPP `evm` charge where the tool's 402 carries
  a Payment challenge now. The 402 is what counts. A seller may serve the same document at `/openapi.json` on its
  origin's root, each path written in full.

An agent pays a seller with a pass (section 6), with the Pass client (section 1), or with any x402 or MPP client.

Request bodies below are written short: `{channelId, issued, signature}` is a JSON object with those keys and your
values. No sign-up, no API key. To pay: hold USDC on Base and sign. An agent needs no ETH to pay on the USDC row without Permit2, or for a refund the seller sends through the ZEAM relay.
To pay and to get money back, the agent needs ETH on Base only where it sends a transaction itself, in five cases: the Permit2 row's one-time approval, `selfSend` (from any wallet), `initiateWithdraw` and `finalizeWithdraw` (from the channel's payer), and, with an MPP session, an open or top-up it sends itself for a credential of `type` `hash` (the USDC approval for the session escrow, then its `open` or `topUp`) and `requestClose` and `withdraw` on the session escrow without the relay (each from the channel's payer, section 7). To pass a gate: sign with your key; nothing is paid and the key needs no funds.

## 1. Pay with your own wallet

Hold USDC on Base. No approval.

The Pass client pays from a key in your environment. It needs Node.js 20 or later. Set `PASS_MCP_URL` to the seller; without it the client
calls its default, ZEAM Prism (`https://mcp.zeamprism.com/mcp`).

    export PASS_PRIVATE_KEY=0x…
    PASS_MCP_URL=https://seller.example/agents/mcp npx -y @zeampass/client --tools
    PASS_MCP_URL=https://seller.example/agents/mcp npx -y @zeampass/client --call add '{"a":1,"b":2}'

Without `--call` or `--tools` the client is an MCP stdio server; over HTTP its `paid_fetch` tool pays a 402.
It pays by MPP session, over MCP and over HTTP, only where `PASS_SESSION_ESCROW` names the escrow (section 7, Sessions).

- **Use the eip3009 row.** For USDC, the `accepts[]` row whose `extra` has `name` and `version` and no
  `assetTransferMethod` is EIP-3009: signed offline, no approval. The `"assetTransferMethod": "permit2"` row needs a
  one-time on-chain Permit2 approval, sent by the agent and paid in its ETH.
- **Deposit = price × multiplier.** The first call on a channel deposits; later calls spend the deposit. Multiplier:
  5 for the stock x402 SDK, set with `new BatchSettlementEvmScheme(signer, { depositPolicy: { depositMultiplier: N } })`;
  `PASS_DEPOSIT_MULTIPLIER` for the Pass client (default 40, minimum 3). The deposit must reach the floor in the 402's
  `deposit` line; below it the answer is `funding_requires_open_fee` with `neededMicroUSD`. The floor tracks gas: when gas rises between the 402 and your deposit, the same answer gives the figure needed now. The floor is for every deposit, a later top-up included. Raise the multiplier until price × multiplier ≥ floor. The floor is for the call
  you make, and each call's own 402 states it.
- **The channel id.** Every paid answer carries it: `extra.channelState.channelId` in `PAYMENT-RESPONSE`. Line and
  refund requests name the channel by it. For a channel that never had a paid answer, compute it from the channel's
  seven fields with `computeChannelId` from `@x402/evm/batch-settlement/client`, or read it from the `ChannelCreated` event of your deposit.
- **Two USDC rows.** `accepts` lists the USDC row without Permit2 first and again last, identical: some x402 indexers
  keep only the last row per scheme and network. Sign either. A 402 that
  corrects a payment is the one exception: the channel's state (`extra.channelState`, `extra.voucherState`) is on the
  first row only, as the x402 SDK's own server sends it, and at the top of the body as `channelState`. Resync from those.
- **A failed call is not charged.** On a line a call uses the time it runs, whether or not it succeeds. Arguments are checked first; a failed tool releases the hold. An unpaid call
  with no arguments (no body, an empty body or `{}`) gets the 402 with the price over HTTP; over MCP a seller may
  check the arguments first and answer `invalid_arguments`. A call the tool
  completes is charged, even when the connection drops before the answer arrives. Settlement comes
  back in the `PAYMENT-RESPONSE` header (MCP: `_meta["x402/payment-response"]`). Do not read its
  `amount`: it is filled only on the call that deposits and is empty on every other. What a call cost is
  `extra.chargedAmount`; what a first call deposited is `extra.depositAmount`.

A connector link from a pass: add it as a custom MCP connector. It pays the pass's seller; its free `pass_balance`
tool states the balance. Section 6 funds one.

## 2. Read a seller's price

Call a tool without paying:

- **HTTP:** `402`. The `PAYMENT-REQUIRED` header is base64 JSON of the terms; the body carries the same, but for one member: the header leaves out the x402 discovery extension (`extensions.bazaar`) when it is over 4,096 bytes or would take the header past 12,288 characters, and the body keeps it. An MPP challenge, when offered, is in `WWW-Authenticate: Payment` (section 7).
- **MCP:** `isError: true`; `structuredContent` is the terms.

`accepts[].amount` is the price per call in micro-USDC: `"20000"` is $0.02. `pricing` states it in dollars
(`"$0.02 per call. A failed call is not charged."`). `deposit` states the minimum deposit in the words of a first call; a later top-up meets the same floor
(`"First call on a channel deposits at least $0.03. Later calls spend it. The unspent balance is refundable."`).
`refund` states the refund rule (section 5). A gate's amount is `"0"`.

Each tool has its own price. `prices` in the 402 tags the tools the Bridge engine serves (a seller's own free tools outside it may be missing), or the tool called alone when the 402 carries `priceList`, which names the seller's `mcp` and `openapi` addresses, where every tag is; `tools/list` tags each tool in
`_meta["zeam-pass/price"]`; `openapi.json` in each operation's `x-price`:

| Tag | Meaning |
|---|---|
| `{"usd":"0.02","per":"call"}` | $0.02 per call |
| `{"usd":"0.0001","per":"unit","upTo":"0.05"}` | usage: sign $0.05; charged $0.0001 × the units the tool reports, at most $0.05 |
| `{"usd":"0","per":"call","free":true,"perHour":60}` | free: no payment, no admission; 60 calls an hour per address, then 429 `free_limit` |
| `{"usd":"0","per":"call","free":true}` | free, with no hourly limit |
| `{"per":"call","varies":true}` | depends on the arguments; the call's 402 states it |
| `{"usd":"0.000001","per":"ms","ms":1}` | `buy_time`: line time at $0.000001 per millisecond. Buy any number of milliseconds, and buying again adds time. `"ms":10` means the price is per 10 ms and purchases are multiples of 10 ms. A tag with `maxMs` is a seller that limits one purchase (see Line time) |
| `{"per":"time","usd":"0.000001","ms":1,"callUSD":"0.01","callMs":10000}` | a time tool: on a line it burns line time at `usd` per `ms` milliseconds; without one, $0.01 a call for up to 10,000 ms |

Usage: sign `accepts[].amount`, the reserve. `PAYMENT-RESPONSE` `extra` states `chargedAmount` (used) and
`reservedAmount` on every settled call, equal when the whole reserve was charged; the rest stays in your channel. Sign the next voucher on `extra.channelState.chargedCumulativeAmount`
(stock x402 clients do).

### Line time

A seller that sells time lists `buy_time` and `line`, tags each time tool
`{"per":"time","usd":"0.000001","ms":1,"callUSD":"0.01","callMs":10000}`, and states the rule in the
402's `time` line.

1. **Buy.** Call `buy_time` `{"ms": N}` and pay for N milliseconds at the tagged rate (its tag is `per: "ms"`). The time goes to the
   paying channel with the payment: time that cannot be recorded is not charged (500 `tool_failed`, as for any tool), and a payment
   that does not settle credits no time. The answer states `boughtMs` and `msRemaining`. With no `ms` the seller's
   default amount is bought; the `buy_time` schema states it. A seller that limits one purchase tags `maxMs` and
   refuses more with 400 `invalid_arguments`; most set none.
2. **Open a line.** `POST <base>/line` `{"op":"open","channelId":"0x…"}` answers `{nonce, sign}`. Sign `sign` (EIP-191)
   with the channel's payer key (or `payerAuthorizer`), then `POST` `{"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"}`:
   the answer carries `credential`. A nonce is one attempt, valid 300 s. MCP: the free `line` tool, same arguments.
3. **Call.** Send the credential as the `x-line` header (MCP: `_meta["zeam-pass/line"]`, or `x-line` on the MCP
   request). No payment per call. The answer carries `x-pass-ms-remaining` and `x-pass-ms-elapsed` (MCP:
   `_meta["zeam-pass/meter"]`), a failed call's answer too. With calls at once, a JSON-RPC batch included, each answer carries its own
   reading, which can differ from what the line holds once they all finish; `POST <base>/line {"op":"status"}` with the credential is exact once no call is running. Read while a call or a
   subscription runs, it shows the time burned up to that read, and the call goes on burning until it ends. The burn
   starts once the line has recorded the call, so a mid-call reading can come out higher than the call's share of the
   final figure by the time those records took: up to a few tens of milliseconds (about 25 ms seen), more on a slow disk
   or a seller on more than one process, as every WordPress seller is. Billing is unaffected: concurrent calls burn one
   clock and the final status is exact.
   To stop a call over MCP, send `notifications/cancelled` with its `requestId` and the line credential the call carried (`params._meta["zeam-pass/line"]` or the `x-line` header), or on the `Mcp-Session-Id` the call was sent on (the answer to `initialize` carries one): the line is billed to that moment, nothing after; a cancel with neither is answered 202 and stops nothing.
   Hanging up does the same on a Node seller and on a Python seller served over ASGI. A WordPress seller, and a Python seller served over WSGI, cannot see a hang-up: there a call you hang up on burns until it returns, so cancel it first.
   A call cut for time, or one whose line ran out while it ran, whether or not the tool failed, answers `out_of_time` with `msRemaining` in the body and carries no meter reading. A seller's
   long-running tool may instead answer 200 with `code: "out_of_time"`, what it had gathered, `needsMs` and the meter
   reading: read `code`, not only the status.
4. **Burn.** Time burns while a call runs on the line; calls at the same time burn one clock. No more than
   `maxCalls` (1..1000, default 1000) may be live on a line at once; the next gets 429 `too_many_calls` with `msRemaining`. A seller may also
   burn a fixed idle time after each call; the line's status shows what was burned. A call stops when the
   time runs out: 402 `out_of_time`, its time spent.
5. **Meter.** `{"op":"off"}`: no new calls on the line; a running call burns to its end; a call sent meanwhile gets
   402 `meter_off` with `msRemaining`, the time the line still holds. `{"op":"on"}`, `{"op":"status"}`,
   `{"op":"close"}`, each with the credential as `"credential"` in the body or as the `x-line` header. Over HTTP the line is `POST <base>/line`, or `POST <base>/v1/line`
   with the same body; both answer a failed step with its status and `{op, code, why}`, `op` being `line_failed`. `/v1/line` is the
   line tool's route, so it checks the body against the tool's schema first: an `op` that is not in the schema answers
   `400 invalid_arguments` there. While a refund is settling on the channel, `{"op":"on"}` and a call on the line each
   answer 402 `refund_settling` with `retry_after_seconds`; nothing is charged. Retry after it. While a refund asked for
   on the channel is being worked out, `{"op":"on"}` answers 402 `refund_pending` with `retry_after_seconds` and changes
   nothing (section 5).
6. **Leave.** A refund (section 5) returns the unburned time with the balance (`timeReturnedMs`) and closes the line.

Without a line a time tool is a paid call at `callUSD`, for up to `callMs`; a call past it: 402 `out_of_time`, not
charged.

## 3. Pass a gate

A gate admits listed keys. Each call is signed with your key as a zero-value payment: nothing is paid, the key needs
no funds or ETH, nothing goes on chain.

**Make a key** once. Keep the private key; give the seller its address.

```js
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const key = generatePrivateKey()
privateKeyToAccount(key).address
```

```python
from zeam_bridge import key_address, new_key
key = new_key()
key_address(key)
```

**Sign every call.**

1. Call without a proof. The 402 has one `exact` requirement: `amount: "0"`, `payTo` the seller's wallet,
   `realm: "ZEAM Pass"`, and `how`.
2. Sign it with any x402 client that signs `exact` (an EIP-3009 `TransferWithAuthorization` of value 0, never sent
   to the chain). Send it as `PAYMENT-SIGNATURE` (MCP: `_meta["x402/payment"]`).
3. Use a new nonce per call. A signature is accepted once (again: `replayed`) for as long as its `validBefore`
   allows; x402 clients and `gate_proof` sign it valid 300 seconds. Every signature a key makes here (a proof, a
   voucher, an authorization, a grant, a line proof) is 65 bytes with `v` 27 or 28 and a low `s`, as wallets and
   signing libraries produce it; a voucher or an authorization in another encoding is refused.

Node, with the x402 client:

```js
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { x402Client, wrapFetchWithPayment } from '@x402/fetch'
import { toClientEvmSigner } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/client'

const signer = toClientEvmSigner(privateKeyToAccount(process.env.AGENT_KEY), createPublicClient({ chain: base, transport: http() }))
const f = wrapFetchWithPayment(fetch, new x402Client().register('eip155:8453', new ExactEvmScheme(signer)))
const r = await f('https://seller.example/agents/v1/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"solar"}' })
```

Python, with `zeambridge` (`gate_proof` signs the zero-value row of the terms):

```python
import json, os, urllib.error, urllib.request
from zeam_bridge import gate_proof

def call(url, body, grant=None):
    def post(headers):
        req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers}, method="POST")
        return urllib.request.urlopen(req)
    try:
        return post({})
    except urllib.error.HTTPError as e:
        if e.code != 402:
            raise
        proof = gate_proof(os.environ["AGENT_KEY"], e.headers["PAYMENT-REQUIRED"])
        return post({"payment-signature": proof, **({"x-grant": grant} if grant else {})})
```

**Getting admitted.** A key not on the list gets `403 refused` with a `how`. The seller's `contact` (an `http(s)://`
page or a `mailto:` address), when set, is in that answer, in every 402 and in `openapi.json` `info.contact`. A
WordPress seller's default is its site address. Send the seller your key's address, or ask for a grant.

**Grants.** A listed key can admit your key with a grant: your key's address, one tool or all (`*`), an end time.
Send `x-grant: <base64url of JSON {delegate, scope, until, signature}>` on every call, and sign the call with your own
key as above. The grant works only for the named key. It ends at `until`, or when the seller removes the signing key.
`signature` is the admitting key's EIP-191 signature of:

```
ZEAM Pass grant
delegate: <your key's address, lowercase>
scope: <tool, lowercase, or *>
until: <ISO time>
```

The admitting side signs with `signGrant` (Node, `@zeambridge/bridge`) or `sign_grant` (Python, `zeambridge`):
[seller/docs/SELL.md](../seller/docs/SELL.md). `x-grant` is an HTTP header, on `POST <base>/mcp` too, where it covers
every tool call in the request; never in `_meta`. An answer through a grant carries
`X-Pass-Granted-By: <admitting key's address, lowercase>` (MCP: `_meta["zeam-pass/granted-by"]`). With
`@x402/fetch`, add `'x-grant': grant` to the request headers.

**Both mode.** The key must be admitted (directly or by `x-grant`) and the call paid from it. The unpaid 402 has an
`admission` field and `batch-settlement` rows in `accepts`; a gate has an `exact` row. With `@x402/fetch`, register
`BatchSettlementEvmScheme` beside `ExactEvmScheme`; its signer reads your channel on Base and sends no transaction.

```js
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { x402Client, wrapFetchWithPayment } from '@x402/fetch'
import { toClientEvmSigner } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'

const signer = toClientEvmSigner(privateKeyToAccount(process.env.AGENT_KEY), createPublicClient({ chain: base, transport: http() }))
const grant = process.env.AGENT_GRANT
const client = new x402Client()
  .register('eip155:8453', new BatchSettlementEvmScheme(signer))
  .register('eip155:8453', new ExactEvmScheme(signer))
const pay = wrapFetchWithPayment(fetch, client)
const r = await pay('https://seller.example/agents/v1/search', { method: 'POST', headers: { 'content-type': 'application/json', ...(grant ? { 'x-grant': grant } : {}) }, body: '{"q":"solar"}' })
r.headers.get('x-pass-granted-by')
```

The Pass client sends `PASS_GRANT` as `x-grant` on every request to the seller's own origin, over MCP and HTTP. Use the Pass client
4.0.0 or later: earlier versions, formerly `@zeam-labs/x402-mcp-bridge`, read `X402_…` settings.

## 4. Errors

A seller's HTTP answers to a call carry `error` and `message`, and some carry `code`, `reason`, `how` and `contact`. Its refund and line
routes answer a refused request differently, with `op`, `code` and `why`; a body too large for the seller to read is refused before
either route, with `error` and `message`. (The Pass API at
api.zeampass.com, section 6, is not a seller: a refusal there carries either a sentence in `error` alone, or a code in `error` with the
sentence in `message`. Read `message` when it is there, else `error`. A gas quote from its refund route (`needsSignature: true`) is a step, not a
refusal: it has neither, and its sentence is in `how`.) An MCP `isError`
result carries the same fields in `structuredContent`, merged with the x402 terms when the answer has them (an
argument the tool's schema rejects may come back from the MCP layer itself as text, with no `structuredContent` and
no code). A payment
that does not verify: `error` is the x402 code (`invalid_batch_settlement_evm_…`), the same as in the
`PAYMENT-REQUIRED` terms, and `code` is `payment_invalid`; resync the channel from `accepts`. A deposit sent while the channel already covers the call answers the same way with `reason: "channel_funded"`: pay with a voucher. The refund route answers
`op: "refund_failed"` with `code` and `why`, `op: "refund_quote"` when there is something to sign, `op: "refunded"`
when it was sent, or `op: "refund_signed"` for `selfSend` (section 5).

| code | status | meaning | next step |
|---|---|---|---|
| `invalid_arguments` | 400 | the arguments do not match the tool's `inputSchema`, or the body is not JSON (ZEAM Prism answers `invalid_json` for a body that is not JSON); nothing held. Over HTTP an unpaid call with no arguments gets the 402 instead; over MCP a seller may answer this | fix the arguments from `tools/list` |
| `unknown_tool` | 404 | no tool by that name; the answer lists the tools or says where the catalog is (over MCP, some sellers answer JSON-RPC -32602 instead) | use a name from `tools/list` |
| an x402 code ending `channel_busy`, with `code: "payment_invalid"` | 402 | another call on this channel is being paid for right now; its `accepts` carry no channel state. A call that arrives while another call or a deposit holds the channel gets this answer whatever amount it signed. Two calls that arrive in the same instant, before either holds it, are different: the later one may get a cumulative amount mismatch whose state does not yet count the other | send the same call again in a moment; if it answers a cumulative amount mismatch, re-sign from that answer's `accepts`. Sending one paid call at a time per channel avoids both |
| `tool_failed` | 500 | the tool failed after the hold (for `buy_time`: the time could not be recorded), its result is not valid JSON, or a usage tool reported no units; hold released, nothing charged per call (on a line the call has used the time it ran, and the answer carries the meter reading, over HTTP with `msRemaining` and `elapsedMs` in the body too). Over HTTP the body carries every field the failure carries over MCP in `structuredContent`; a tool may name its own `error` and, for a refusal that is yours, a status of 400 to 599 (never 402), with `Retry-After` when it gives `retry_after_seconds` | retry later, or with other arguments; for a refusal that is yours, do what its `message` says |
| `not_found` | 404 | (WordPress) no published post with that id; nothing charged | find an id with `search_posts` |
| `internal_error` | 500 | the seller's server failed | retry later |
| `price_invalid` | 500 | the seller cannot price this call; nothing held | retry later, or with other arguments |
| `line_unknown` | 403 | (a call on a line, and the line route) the `x-line` credential names no open line (closed, or refunded) | open a line |
| `no_time` | 404 | (line route) this seller sells no line time | pay per call |
| `meter_off` | 402 | the line's meter is off; `msRemaining` is the time the line still holds | `POST <base>/line {"op":"on","credential":"<yours>"}` |
| `out_of_time` | 402 | the line has no time left, or the call ran past its time; that time is spent. Without a line: past `callMs`, not charged | on a line: `buy_time`, then call again. Without one: buy time (`needsMs` says how much when the tool knows), open a line and call on it |
| `too_many_calls` | 429 | (a call on a line) more calls are live on the line than `maxCalls` (1..1000, default 1000); `msRemaining` is the time the line still holds | wait for a live call to finish, then retry |
| `client_gone` | 499 | the caller hung up, or canceled the call over MCP (`notifications/cancelled`), and the call was stopped. On a line the time the call ran is billed and nothing after (`msRemaining` and `elapsedMs` say so, with the meter reading, when the call had started); a call priced per call is not charged. Over MCP the canceled call's own answer is an `isError` result with these fields | nothing; call again when you want the result |
| `no_challenge`, `bad_signature` | 400 | (line route) the nonce is used, expired or unknown, or the signature does not recover | `{"op":"open","channelId":"0x…"}` again and sign `sign` |
| `free_limit` | 429 | over the free tool's calls an hour per address (callers the seller sees no address for share one count); `retry_after_seconds` | retry after `retry_after_seconds` |
| `body_too_large` | 413 | (a Python seller) the body is over 1 MB. The Pass API at api.zeampass.com answers the same with 413, `error` `body_too_large` and the sentence in `message` | send a smaller body |
| `payload_too_large` | 413 | (ZEAM Prism) the body is too large | send a smaller body |
| `not_ready` | 503 | (WordPress, Python) the seller's setup is incomplete | retry later |
| `payment_unavailable` | 503 | the payment check or settlement failed; nothing charged | retry |
| (none, with `accepts`) | 402 | payment required; for a gate, a signed proof of key | pay one row of `accepts` (section 1), or sign the zero-value row (section 3) |
| `bad_payment_header` | 400 | the payment does not decode, or its `voucher.maxClaimableAmount` is not an unsigned integer | send base64 of the PaymentPayload JSON (MCP: the object), the amount as a base-10 or 0x string or a whole JSON number up to 9007199254740991 |
| `bad_payment_type` | 400 | the payment is neither a voucher nor a deposit | pay with a voucher or a deposit |
| `no_matching_requirement` | 402 | the payment matches no row of this call's `accepts`. This is checked before the channel's balance and before the deposit floor, so a deposit signed on a dearer row gets this answer whatever its size, and not `channel_funded` or `funding_requires_open_fee`. A row is its price, asset, `payTo` and terms and names no tool, so a payment signed from another tool's row is refused only when that row differs | sign a row of this call's 402 |
| an x402 code, with `code: "payment_invalid"` | 402 | the payment did not verify (signature, channel, balance or cumulative amount); `error` names the kind and `reason`, when it differs, the cause: a voucher over the channel's balance answers `error` …`cumulative_amount_mismatch` with `reason` …`cumulative_exceeds_balance` when it is for the cumulative amount this call expects (the channel's `chargedCumulativeAmount` plus the price). A voucher for any other amount, however far over the balance, answers `error` and `reason` …`cumulative_amount_mismatch`: that is checked first | re-sign from the returned `accepts`, which carry the channel's current state; when `reason` says the balance is exceeded, deposit more first |
| `price_changed` | 402 | a deposit made on a row that is for less than this call's price by 2 micro-USD or more, such as a cheaper tool's row. Any other payment for less, a deposit on a row exactly 1 micro-USD under among them, answers `no_matching_requirement` or `payment_invalid` | pay the `accepts` quote |
| `funding_requires_open_fee` | 402 | the deposit is signed on a row of this call's `accepts` and is under the floor, or gas rose past the floor the 402 stated before the deposit was sent; nothing charged | deposit at least `neededMicroUSD` |
| `channel_leaving` | 402; 409 on the line route | the channel is withdrawing | open a new channel |
| `refund_settling` | 402 | a refund is settling on this channel; nothing charged. A paid call (voucher or deposit), a line's `{"op":"on"}` and a call on a line each get it; `retry_after_seconds` is when to ask again | retry after `retry_after_seconds` |
| `refund_pending` | 402 | (line route) `{"op":"on"}` while a refund asked for on the channel is being worked out: its proof verified and the chain shows a balance, so the line's meter is off until the refund is answered; nothing changed; `retry_after_seconds` | retry after `retry_after_seconds`. Once the refund is refused, `{"op":"on"}` rides the line again; once it is sent, the line is closed |
| `refund_outstanding` | 402 | the channel has an unsent signed refund | send it (the transaction in the answer), or open a new channel |
| `settle_failed` | 402 | the payment did not settle; not delivered, nothing charged | call again with a new payment |
| `no_payment` | 402 | (gate) no `PAYMENT-SIGNATURE`, or not base64 JSON of an x402 payment | sign the zero-amount requirement with your key |
| `bad_payment` | 402 | (gate) no authorization in the payment | send an `exact` EIP-3009 payment |
| `invalid_payment` | 402 | (gate) the signature, amount, recipient or time window is wrong; `message` names it | re-sign as given: value 0, its `payTo`, a future `validBefore` |
| `replayed` | 402 | (gate) this authorization was already used | sign again with a new nonce |
| `bad_grant` | 402 | (gate and `both`) `x-grant` is malformed or expired, its signer is not admitted, or it names another delegate than the key that signed the call; `message` names it; nothing held | get a new grant from an admitted key, naming the key you sign with |
| `refused` | 403 | your key is not admitted, or your grant's scope is another tool; `how` says how to get in; `contact`, when set, says where | ask the seller to admit your key's address, or ask an admitted key for a grant; do not retry as is |
| `gate_credit_exhausted` | 503 | this gate has no checks left this month and its seller has not bought more | nothing you can do; tell the seller (`contact` in its 402) |
| `invalid_json`, `invalid_request` | 400 | (refund route) the body is not a JSON object, or `channelId` is missing or malformed | send `{channelId, issued, signature}` |
| `invalid_json` | 400 | (a tool call at ZEAM Prism) the body is not JSON | send a JSON object of the tool's arguments |
| `bad_request` | 400 | (line route) the body is not JSON, `op` is not one of open, prove, on, off, status, close, `channelId` is missing or malformed on open or prove, a prove came with no `nonce` or no `signature`, or no credential came with on, off, status or close | send one of those, as in section 2; `why` says which part is missing |
| `not_a_paywall` | 404 | (refund route) this seller takes no payments | stop: there is no channel here to refund |
| `unknown_channel` | 404 | (refund route) no channel with that id here; a channel with no calls is found by its `channelConfig` | check the id, or send `channelConfig` with the proof |
| `unknown_channel` | 404 | (line route) no channel with that id here | pay a call on the channel first, `buy_time` for one, then open the line |
| `channel_config_mismatch` | 400 | (refund route) the `channelConfig` is not this seller's channel (checked whenever sent); `mismatch`: `channelId` (hashes to another id; `why` names both), `receiver` or `receiverAuthorizer` (another seller), `token` (not accepted here), `fields` (not the 7 channel fields), or `balance` (the channel holds nothing on chain) | send the config as deposited, to the seller it names |
| `proof_invalid` | 400 | (refund route) the signed proof does not verify or is stale; `sign` shows the text | sign that text within 5 minutes |
| `not_the_payer` | 403 | (refund and line routes) the proof is not signed by the channel's payer | sign with the payer's key |
| `line_unavailable` | 503 | (line route) the line could not be read, or its channel could not be held for an `{"op":"on"}`, right now; nothing changed | send the same request again |
| `request_open` | 409 | (refund route) a paid call is open on the channel, or a call is running on the channel's line | retry after `retry_after_seconds` |
| `refund_settling` | 409 | (refund route) a refund is already settling on the channel: it is being sent now; nothing more is sent. A request that would be refused is never told this: it gets its own answer | retry after `retry_after_seconds` |
| `nothing_to_return` | 409 | (refund route) the balance is 0, or refund gas ≥ balance; `returnedMicroUSD` 0 | with a balance of 0 there is nothing to do. Otherwise keep spending the balance, or send `selfSend` for a signed refund of all of it at your own gas. If the channel has a line and held a balance, the request switched the line's meter off: `POST <base>/line {"op":"on","credential":"<yours>"}` to ride it again |
| `chain_unreadable` | 409 | (refund route) the chain read failed | retry after `retry_after_seconds` |
| `gas_unpriced` | 503 | (refund route) refund gas cannot be priced, or the relay is unreachable | retry after `retry_after_seconds`, or send `"selfSend": true` |
| `refund_unavailable` | 503 | (refund route) the seller's refund handler failed, it could not hold the channel for the refund, or more refund requests on the channel are already being worked out than the seller takes at once (four); nothing sent; `retry_after_seconds` | retry after `retry_after_seconds` |
| `refund_error` | 409 | (refund route) the refund could not be built, sent or recorded; nothing sent. Always `retry_after_seconds`; `leftMicroUSD` where the balance was read, and the gas figures only where the relay did not send | retry after `retry_after_seconds` |
| `gas_payment_needed` | 409 | (refund route, `op: "refund_quote"`) channel fees (`feeMicroUSD`) < the gas of its deposit, its refund and any calls not yet settled, and of every further deposit and every earlier refund ZEAM paid for on that channel, plus 15% (`coverMicroUSD`); `gasMicroUSD` is the quoted refund gas, L1 fee included (`l1FeeWei`), 15% margin, priced by the relay (`quotedBy: "relay"`) or the seller (`quotedBy: "engine"`). With `requoted: true` and `sendCostMicroUSD`: your payment is under the send cost (the cost rose, or you signed less than the quote); nothing sent; a new quote | sign `sign` (EIP-712) and POST again with a new `issued` and `signature`, plus `gasPayment: {authorization, signature}`, within 5 minutes. The request switched the line's meter off, if the channel has a line: `POST <base>/line {"op":"on","credential":"<yours>"}` to ride it again |

MCP transport errors are JSON-RPC: `-32700` the body is not JSON, `-32600` not a JSON-RPC request, `-32601` no such
method, `-32602` bad `params`, `-32603` the server failed.

## 5. Refunds

`POST <base>/refund` (the 402's `refund` line names the URL) with `{channelId, issued, signature}`. `signature` is
the payer's (or `payerAuthorizer`'s) EIP-191 signature of:

```
ZEAM Pass refund
channel: <channel id, lowercase>
issued: <ISO time, within 5 minutes>
```

A channel with no calls: add `channelConfig`, the 7 channel fields as deposited: `payer`, `payerAuthorizer`, `receiver`, `receiverAuthorizer`, `token`, `withdrawDelay`, `salt`. The seller checks that it hashes to
`channelId`, names this seller as receiver, and holds a balance on chain. A config that fails a check, for any
channel, is 400 `channel_config_mismatch` with `mismatch`; nothing is sent.

A channel with an open line: a refund request whose proof verifies switches the line's meter off, so the time left
holds still while the amount is worked out. Until the request is answered, `{"op":"on"}` answers 402 `refund_pending`
and changes nothing, a call on the line answers `meter_off`, and a paid call on the channel waits for the answer for
up to a few seconds. The meter stays off whatever the answer is, a gas quote included: once it is answered,
`POST <base>/line {"op":"on","credential":"<yours>"}` rides the line again. A refund that is sent closes the line.
A request refused before the amount is worked out leaves the meter as it was: `nothing_to_return` on a
channel that holds nothing.

The rule: ZEAM pays the gas when the channel's fees (its spend times the fee address's share of the seller's split:
9.99% for most sellers, who keep 90.01%; 100% for one whose split pays the fee address everything, like Prism; the
402's `refund` names it) ≥ `coverMicroUSD`: the gas of its deposit, its refund and any calls not yet settled, and of every further deposit into the channel and every earlier refund of it that ZEAM paid for, plus 15%, at the current gas and ETH price. The figure in the
402's `refund` line and `coverMicroUSD` already have the 15% in them; do not add it again. `feeMicroUSD`
rounds down, `coverMicroUSD` rounds up; free when `feeMicroUSD >= coverMicroUSD`. The seller, the relay and the 402
apply the same comparison. An unsettled call rides the refund as a claim and adds its gas to both.

- **Free:** `op: "refunded"`, `returnedMicroUSD` = the balance, `gasMicroUSD: 0`, `transaction`.
- **Not free:** 409 `op: "refund_quote"`, `code: "gas_payment_needed"`, with `feeMicroUSD`, `coverMicroUSD`,
  `gasMicroUSD` (the quote), `gasUnits` (refund + riding claim + your payment), `gasUnitsWithMargin`, `l1FeeWei`,
  `gasPriceWei`, `ethUSD`, `marginPercent`, `quotedBy` (`relay`, or `engine` when the relay gave no quote),
  `returnedMicroUSD`, `payTo` (the relay's gas wallet, its `/health` `sender`), `authorization` and `sign` (EIP-712
  typed data of an EIP-3009 `TransferWithAuthorization` of `gasMicroUSD` USDC from your payer to `payTo`). Sign
  `sign` with the payer (viem: `account.signTypedData(answer.sign)`) and POST again with a new `issued` and
  `signature`, plus `gasPayment: {authorization, signature}`. One transaction sends the refund, then the gas payment;
  you need no USDC or ETH beforehand. Answer: `op: "refunded"`, `returnedMicroUSD` (out of the escrow),
  `gasMicroUSD` (your payment); net = `returnedMicroUSD - gasMicroUSD`.
- **Refund gas ≥ balance:** 409 `nothing_to_return`; `leftMicroUSD` stays in the channel, `returnedMicroUSD` 0.
- **`"selfSend": true`:** 200 `op: "refund_signed"`, `microUSD` (the full balance), `transaction`
  (`{chainId, to, data, value}`, a signed refund you send from any wallet with ETH on Base for gas), `why`, and
  `timeReturnedMs` when line time was returned. Asked again before it is sent: the same `transaction`.
- **No answer from the seller:** `initiateWithdraw` from the payer's wallet, for at most the `balance` minus
  `totalClaimed` the escrow's `channels(channelId)` returns (more reverts), then `finalizeWithdraw` after the
  channel's `withdrawDelay` (it pays the payer), each with ETH on Base for gas.

While a refund is settling on a channel, a paid call, a line's `{"op":"on"}` and a call on the line each get 402 `refund_settling` with `retry_after_seconds`; nothing is charged. Retry after it.

**The quote.** The seller hands its signed refund to the relay. The relay prices it: the gas the refund uses (`eth_simulateV1` from its
sender; `eth_estimateGas` where the RPC lacks it), + the gas a payment adds (median of its paid refunds), + Base's L1 data fee, at the current gas and
ETH price, + 15%. No quote from the relay: the
seller prices from the same measurements (`quotedBy: "engine"`), with the ETH price and `payTo` it read from the
relay's `/health` in the last 60 seconds. Without those it prices nothing: 503 `gas_unpriced` with
`retry_after_seconds`. At send time the relay estimates the transaction and
its L1 fee at current prices, and sends when your payment covers that cost. If your payment is under that cost, because it rose or because you signed less than the quote,
nothing is sent: 409 `refund_quote` with `requoted: true`, `sendCostMicroUSD`, and a new `authorization` and `sign`
for that cost + 15%. Sign and POST again. The signature is valid 5 minutes.

**Check the price.** The relay answers anyone, free, with no key.

- `GET https://api.zeampass.com/relay/quote` prices by shape. `?claim=1`: an unsettled call's claim rides the refund.
  `?payment=0`: a refund alone (ZEAM pays the gas). Default: refund + your gas payment, no claim.
- `POST https://api.zeampass.com/relay/quote` with `{"call": {"to": "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003", "data": "<the refund>"}, "payment": true}`
  (`to` is the x402 batch-settlement escrow on Base) prices one refund: `refundWithSignature`, or the escrow `multicall` of claim then refund (the calldata of a
  `selfSend` answer).

```json
{"op": "refund_gas_quote", "shape": {"claim": false, "payment": true}, "gasUnits": 155600, "gasFrom": "calibrated",
 "gasPriceWei": "6525513", "l1FeeWei": "32085809811", "ethUSD": 2701.52, "costMicroUSD": 2830, "marginPercent": 15,
 "quoteMicroUSD": 3255, "payTo": "<the relay's gas wallet: sender in /relay/health>",
 "measured": {"paidRefunds": 0, "paidRefundsWithClaim": 1, "calibrated": "2026-09-29"}}
```

`costMicroUSD`: an estimate of the send cost now, from `gasUnits`; the cost applied when the refund is sent
a few seconds later, from a fresh gas estimate, can be higher. `quoteMicroUSD`: cost + margin, the figure a seller quotes. `gasFrom`: `simulated` (the posted refund run
against the chain), `estimated` (the posted refund, gas estimate), `measured` (median of the relay's paid refunds of
that shape) or `calibrated` (starting units: a paid shape before the relay's first paid refund of it, and a free refund's shape always, since only paid
refunds are measured). Unreadable body: `400`. Chain unreadable: `503` with
`retry_after_seconds`.

**Ordering.** The payment is a `TransferWithAuthorization`, not a `ReceiveWithAuthorization`:
`receiveWithAuthorization` requires the caller to be the payee, and the caller USDC sees is Multicall3. The relay
enforces the order: the payment is sent after the refund, in the same transaction, and both land or neither lands. It
never sends the payment alone or inside an escrow call. The seller hands the relay the
refund and payment as one Multicall3 bundle, refund first, neither leg allowed to fail. The relay sends the bundle as
is, or nested in a larger Multicall3 with other buyers' calls, where each bundle can fail alone: another buyer's
failure does not undo yours, and a failing bundle undoes its own refund and payment. Anyone holding your signed
payment can submit it alone to USDC: it pays only the relay's gas wallet, only the quoted amount, within 5 minutes,
and your refund is then quoted again. Sign it only to post it, over HTTPS.

## 6. Fund a pass

A pass is an allowance at one ZEAM :: Bridge seller, for another agent or a person's chatbot: a channel with your wallet as payer, a
pass key as spender, the seller as receiver. It pays that seller up to what you load, or returns the balance to your
wallet. The page https://zeampass.com/pass runs these steps in a browser; a seller links to it with
`?seller=<its MCP URL>`. The buyer API is `https://api.zeampass.com/pass` (every path below is under it); connector
links are `https://api.zeampass.com/c/<token>/mcp`.

1. `POST https://api.zeampass.com/pass/quote {"seller": "<the seller's MCP URL or HTTP base>"}` answers `seller`: the
   terms the pass is locked to (`receiver`, its split; `receiverAuthorizer`; `token`; `withdrawDelay`; `refund`;
   `admission`, for a seller with an access list; `contact`, when set) and its prices: `pricing` (a sentence: the
   per-call range, tools priced by use, line time), `priceMicro` and `priceTool` (its cheapest per-call tool, a time tool counted at its `callUSD`; never `buy_time`), `prices` (each tool's
   tag: `{tool, usd, per}` with `per` `call`; `{tool, usd, per, upTo}` with `per` `unit`; `{tool, per, ...}` with `per`
   `time`; `{tool, free}` with `free` true; or `{tool, varies}` with `varies` true) and `time` (`{tool, usd, ms}`: `usd` per `ms` milliseconds, plus `maxMs` if the seller limits one purchase, when it sells line time). It creates
   nothing.
2. Derive the pass key from your wallet. Sign this text with the wallet (EIP-191, personal_sign), with the seller's
   receiver address from the quote, checksummed, in place of `<receiver>`:

   ```
   ZEAM Pass
   merchant: <receiver>

   Signing this derives the spending keys for your passes at this merchant.
   It moves no money and approves no transaction.
   ```

   `seed = keccak256(signature)`, over the signature's 65 bytes, not its hex text. Pass `n` has key `keccak256(seed ‖ "key:n")` and channel salt
   `keccak256(seed ‖ "salt:n")`, where `"key:0"` is those ASCII bytes. The token is the key's 32 bytes, base64url
   without padding.
3. `POST /issue {"seller": "<the seller's MCP URL>", "token": "<your pass token>"}` answers `token`, `passAddress`, `connectorUrl` and `page`. `409 pass_in_use`: pass
   `n` is funded; use `n + 1`. This is checked before any grant, so walk `n` first and ask for a grant for the pass you land on. Without `token` the service makes a random key and returns it once, as `token` in the same answer; it stores no key. For such a pass the `salt`
   below is any 32 bytes of hex you choose and keep.
   A seller with `admission` must admit the pass address: add `"grant"`, an `x-grant` value with delegate =
   `passAddress`, signed by an admitted key (section 3). No grant: `400 grant_required` ("this seller admits only
   listed keys. Get a grant for this pass first.") with `passAddress`; no pass is made. Without `token` that refusal
   carries no `passAddress`: send your own key as `token` so a grant can name the pass. A grant for another key:
   `400 grant_wrong_delegate` with `passAddress` and `delegate` (neither when you sent no `token`: the answer says to send one). Not an `x-grant` value: `400 grant_invalid` with
   `passAddress`. No refusal on this route carries `passAddress` when you sent no `token`. The service then asks the seller whether it admits the grant (a call carrying the grant, for the
   pass, that pays nothing): not admitted, `400 grant_not_admitted` with the seller's reason in `message`; the seller
   could not be asked, `502 grant_unchecked`; no pass is made. All carry the seller's `contact` when set. `/link`
   answers the same.
4. `POST /c/<token>/prepare {"payer": "<your wallet>", "amount": "1.00", "salt": "<the pass's salt>"}` answers
   `typedData`: an EIP-3009 `ReceiveWithAuthorization` of `amount` from your wallet. Sign it (no gas), then
   `POST /c/<token>/deposit` with the prepare answer plus `signature`. The service sends the deposit and pays the
   gas, only into a channel to this pass's seller, in its asset. `503 deposit_not_sent` with `retry_after_seconds`:
   nothing moved; send the same request again. `502 deposit_unconfirmed` with `transaction`: it was sent; do not send it
   again, read `/status`. `502 deposit_reverted` with `transaction`: the chain turned it down, nothing moved; prepare
   again. `502 deposit_failed`: not sent, nothing moved. `400 receiver_not_zeam_split` with `receiver`: the service
   pays deposit gas only into a split that pays ZEAM its fee; not sent. `429` with `Retry-After` and `perHour`: too many
   deposits from one address, or to one pass, this hour. `501`: this service has no gas key and sends no deposit. Every
   other refusal says what was wrong in a sentence, in `error`; nothing was sent.
5. `POST /c/<token>/link {"payer": "<your wallet>", "salt": "<the pass's salt>"}` checks the channel on chain. The `connectorUrl` then
   pays that seller. `GET /c/<token>/status`: `loaded` (all deposits; `funded` is the same figure), `spent`,
   `returned` (back to your wallet, net of gas), `gas_paid` (quoted refund gas you paid in USDC) and `remaining`,
   with each `transaction` in `returns` (`usd` net to your wallet, `gas_usd` paid out of it).
   `loaded = spent + returned + gas_paid + remaining`. The connector's free `pass_balance` tool (`loaded_usd`,
   `spent_usd`, `returned_usd`, `gas_paid_usd`, `remaining_usd`) and the pass page show the same five.
6. `POST /c/<token>/refund` returns the balance: it calls the seller's refund route with the channel config, so a
   pass with no calls is refunded too.
   - Seller quotes gas: `409 needsSignature`. Sign `sign` with your wallet and POST
     `/c/<token>/refund` again with `{gasPayment: {authorization, signature}}`. A quote changes nothing; the pass keeps paying until a refund is
     sent or its withdrawal is handed to you. A requote (`requoted: true`): nothing sent, no withdrawal; sign the new one.
   - Seller says retry (any answer with `retry_after_seconds`, such as `refund_error`): `409` with the seller's
     `code` (also as `error`), a `message`, `retry_after_seconds` and a `Retry-After` header; nothing starts, and a gas
     payment sent with the request is not used. A pass has no `selfSend`.
   - Seller refuses (no `retry_after_seconds`): the service does not send the withdrawal or pay its gas. It answers
     `funderWithdraw: true` with `amountMicroUSD`, `goesTo` (the wallet that funded the pass, the channel's `payer`),
     `readyInSeconds` (the `withdrawDelay`) and two calldata objects for you to broadcast from that wallet: `withdraw`
     (an `initiateWithdraw`) now, then `finalize` (a `finalizeWithdraw`) after `readyInSeconds`. Each needs ETH on Base
     for gas; the escrow pays the funding wallet. The service cannot send them: the escrow takes only the `payer` or
     the pass key as sender, and the pass holds no gas. A withdrawal already pending: `already: true`,
     `funderFinalize: true`, with the `finalize` calldata, `readyAt` and `due`. A gas payment posted with the refusal
     is not used: `409 refund_not_sent`. No balance to withdraw: `409 nothing_left`; the channel could not be read:
     `502 withdrawal_unavailable` with `retry_after_seconds`. `POST /c/<token>/finalize` returns the `finalize`
     calldata to broadcast once it is due; it does not send it.
   - A pass sent home (refund sent, or its withdrawal handed to you as above, before you broadcast it) pays nothing
     and takes no top-up: `prepare`, `deposit` and `link` answer `409 pass_sent_home`, and the service drops the pass
     key from memory. Fund a new pass.

The link is the key: whoever holds it can spend the pass at its seller, nothing else. The service stores no key and
no secret that derives one.

## 7. Pay with an MPP client

A 402 from a ZEAM :: Bridge seller for a tool priced per call also carries a `WWW-Authenticate: Payment` challenge of intent `charge` when the fee address's share of that one call (9.99% for most sellers; 100% for one whose split pays the fee address everything) covers the gas of one USDC transfer plus 15%.
ZEAM Prism offers no charge: it takes x402 and an MPP session (Sessions, below).
A price under that carries no charge challenge, whatever the split. A seller that offers sessions carries a challenge of intent `session` at any price per call (Sessions, below). The 402 says which challenges a call carries.
A time tool called without a line is a tool priced per call here, at its `callUSD` (section 2, Line time).
The charge: method `evm`, intent `charge`, USDC on Base (chain 8453), credential type `authorization`.

1. Sign an EIP-3009 `transferWithAuthorization` of `request.amount` to `request.recipient`: `validAfter` 0,
   `validBefore` no later than the challenge's `expires`, `nonce` the keccak256 of the JSON array `[id, realm]` as UTF-8,
   written compactly: `["<id>","<realm>"]`, no space after the comma (Python: `json.dumps([id, realm], separators=(",", ":"), ensure_ascii=False)`).
2. Resend with `Authorization: Payment <credential>` or `Payment-Authorization: Payment <credential>`. The credential
   is the base64url, without padding, of the JSON `{"challenge": {…}, "payload": {…}}`. `challenge` is the challenge's
   parameters as the header gave them, `request` and `opaque` still the base64url strings they came as. `payload` is
   `{"type": "authorization", "from": "0x…", "to": "0x…", "value": "…", "validAfter": "0", "validBefore": "…", "nonce": "0x…", "signature": "0x…"}`: what you
   signed, the three numbers as base-10 strings, `nonce` and `signature` as `0x` hex. Over MCP:
   `params._meta["org.paymentauth/credential"]`, the same object as JSON, the challenge echoed as `_meta` gave it: `request` a JSON object, `opaque` the base64url string.
3. The answer carries `Payment-Receipt` (MCP: `result._meta["org.paymentauth/receipt"]`). Its `reference` is the
   transaction.

- **By a charge, one authorization pays one call.** No channel, no deposit, nothing to refund.
- **A failed call sends nothing.** The authorization is not used and expires at its `validBefore`.
- **The payer's wallet needs no ETH.** The ZEAM relay sends the transfer.
- **No Payment challenge on a 402.** ZEAM's fee on that call does not cover the gas of one transfer plus 15% and the
  seller offers no session, or the tool is priced by use, or the call buys line time.
- **Over MCP the unpaid answer is a tool result**, unless the client declared payment (next). The challenges are in
  `result._meta["org.paymentauth/payment-required"]`.
- **A client that declares payment over MCP is answered as the MPP MCP transport draft writes it.** Declare
  `capabilities.experimental.payment`, an object such as `{"methods": {"evm": {"intents": ["charge"]}}}`, at
  `initialize`, and send the `Mcp-Session-Id` header that answer carries on every later request; on MCP revision
  `2026-07-28` (the Node engine), which has no handshake, declare it in each request's
  `_meta["io.modelcontextprotocol/clientCapabilities"]`. The `initialize` answer names in
  `capabilities.experimental.payment.methods.evm.intents` the intents the seller's 402s carry (`charge`, `session`),
  and has no payment capability where they carry neither. An unpaid call is then JSON-RPC error `-32042` with the same
  challenges in `error.data.challenges`; a refused credential is error `-32043` with the problem in
  `error.data.problem`, its reason and detail in `error.data.failure`, and a fresh challenge; a malformed credential is
  error `-32602`. The problem in `error.data.problem` carries every member the HTTP problem does (`requiredDeposit`,
  `requiredCumulative`, `spent` and the rest), less `accepts` and `session`. A payment refused for its grant (`bad_grant`, section 3)
  is error `-32043` too, with `error.data.failure.reason` `bad_grant` and the refusal's `error`, `message` and `how` in
  `error.data`. A credential is read from the `_meta` at the root of the message too. Where no Payment challenge is
  offered, the answer is the tool result every client gets.
- **A refused credential:** 402 with a problem `type` ending `malformed-credential`, `invalid-challenge` or
  `verification-failed`; `detail` says which check. It carries a fresh challenge of each intent the tool's 402 offers,
  and none when the 402 offers none. A tool priced by use, a purchase of line time and a gate do not read an MPP
  credential: the answer is the 402 an unpaid call gets, with no problem.
- **The nonce** may instead be the keccak256 of `id` followed by `realm`, as the EVM charge draft writes it.
- **`methodDetails.permit2Address`** is the canonical Permit2 contract, `0x000000000022D473030F116dDEE9F6B43aC78BA3`, which the EVM
  charge draft requires in every request. It is not an offer: `credentialTypes` is `["authorization"]` and a `permit2`
  credential is refused as `malformed-credential`.

### Sessions

A ZEAM :: Bridge seller on the Node engine that has sessions turned on, and ZEAM Prism, offer the MPP `session` intent
(`draft-evm-session-00`, method `evm`, USDC on Base) for every tool priced per call: the 402 carries a second
`Payment` challenge with `intent="session"`, after the `charge` one when there is one. A Python seller and a
WordPress seller offer no session today, and no seller offers one for a tool priced by use or for line time. A call
costs the same by session, by charge and by x402.

A session is a payment channel: one deposit into an escrow contract, then one signed voucher per call for the
running total, and what is not spent comes back when the channel closes. The deposit is what a session commits; a
call that fails is not charged.

**The session contracts are not audited.** The escrow is `EvmPaymentChannel` at
`0x5e09aD70b644414cD1cD7Df1d9a10fF7899D92B8` on Base and its payee factory is
`0xE18fCE1266056becA4a3B0edfc15F8634EA6901B`, both deployed on 2026-10-13 and immutable. Nobody outside their
authors has reviewed them. It is a separate contract from the x402 batch-settlement escrow (section 5), and a
deposit sits in it until the channel closes.

**What the 402 carries.** The challenge's `request`: `amount` (the price of one call in base units), `unitType`
`"request"`, `suggestedDeposit` (the least deposit the relay sends for you), `currency`, `recipient` (the seller's
payee) and `methodDetails`: `{"chainId": 8453, "escrowContract": "0x…", "feePayer": true, "credentialTypes":
["authorization", "hash"]}`. Beside the challenge, in the 402 body and the `PAYMENT-REQUIRED` header (MCP: the unpaid
result and `_meta["org.paymentauth/payment-required"]`), is a member
`session`: `{"receiver", "signer", "split": {"recipients", "allocations", "totalAllocation", "distributionIncentive"}, "salt"}`.

**Check the payee before you deposit.** `recipient` is not the seller's wallet. It is the seller's `SessionPayee`, a
contract in front of the seller's split: it signs for the split, which cannot sign, and forwards all it receives to
it. Trust none of the `session` member; check it on Base:

1. `escrowContract` is the escrow above.
2. The 0xSplits pull split factory (`0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1`) answers
   `isDeployed(split, 0x0000000000000000000000000000000000000000, salt)` with `receiver`: the split you were shown is
   the one at that address, and `receiver` is the `payTo` of the 402's x402 rows.
3. The payee factory above answers `addressOf(signer, receiver)` with the challenge's `recipient`.

**The credential.** As for the charge: `Authorization: Payment <credential>`, the base64url, without padding, of
`{"challenge": {…}, "payload": {…}}` with the challenge echoed as the header gave it; over MCP the same object in
`params._meta["org.paymentauth/credential"]`. A credential of `type` `hash` adds `"source":
"did:pkh:eip155:8453:<payer>"`. The draft is published at https://paymentauth.org/draft-evm-session-00 and each
`payload` below is its own (section 10.2). In every one, amounts are
base-10 strings in USDC base units, addresses are `0x` hex, `channelId`, `salt`, `nonce` and `hash` are `0x` and 64
hex digits, and a signature is 65 bytes of `0x` hex (`r`, `s`, then `v` 27 or 28, with a low `s`), or one the
signer's `isValidSignature` accepts when the signer is a contract.

**The channel.** A channel is fixed by the payer, `payee` (the challenge's `recipient`), `token` (its `currency`),
the escrow and chain (its `methodDetails`), and two values the payer picks. `salt` is 32 random bytes, new for each
channel. It is not the `salt` in the 402's `session` member: that one belongs to the seller's split and serves only
to check the payee (above). `authorizedSigner` is the address that signs the vouchers, or the zero address, which
means the payer; leave it out of the payload for the payer. The channel id is
`keccak256(abi.encode(payer, payee, token, salt, authorizedSigner, escrow, chainId))`, the types
`(address, address, address, bytes32, address, address, uint256)`; the escrow's
`computeChannelId(payer, payee, token, salt, authorizedSigner)` answers the same.

**What is signed.** A voucher is EIP-712 `Voucher(bytes32 channelId,uint128 cumulativeAmount)` in the escrow's
domain: name `EVM Payment Channel`, version `1`, chain 8453, verifying contract the escrow. A deposit the relay sends
is an EIP-3009 `ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256
validBefore,bytes32 nonce)` in USDC's domain: name `USD Coin`, version `2`, chain 8453, verifying contract the
`currency`. In it `from` is the payer, `to` the escrow, `validAfter` a time already past (`0` will do) and
`validBefore` one to come. Its `nonce` is derived from the channel, as below, never random: the escrow refuses any
other.

**Open.** `{"action": "open", "type": "authorization", "channelId": "0x…", "authorization": {"from": "0x…", "to":
"0x…", "value": "…", "validAfter": "0", "validBefore": "…", "nonce": "0x…"}, "signature": "0x…", "cumulativeAmount":
"…", "voucherSignature": "0x…", "salt": "0x…"}`, with `"authorizedSigner": "0x…"` when another address signs the
vouchers. `authorization` moves the deposit, `value`, at least `suggestedDeposit`, and its nonce is
`keccak256(abi.encode(from, payee, token, salt, authorizedSigner))`, the types `(address, address, address,
bytes32, address)`, with the zero address when there is no `authorizedSigner`. `signature` signs `authorization`.
`cumulativeAmount` is the price of this call (`amount`) and `voucherSignature` the voucher for it: an open carries
the first voucher and pays the call it rides on. The ZEAM relay sends the deposit: your wallet needs USDC and no ETH.
A deposit under `suggestedDeposit` is refused `insufficient-balance` with `requiredDeposit`. Or open the channel
yourself, at your own gas: approve the escrow for the deposit, send its `open(payee, token, deposit, salt,
authorizedSigner)`, and send `{"action": "open", "type": "hash", "channelId": "0x…", "hash": "0x…",
"cumulativeAmount": "…", "signature": "0x…", "salt": "0x…"}` (and `authorizedSigner`), `hash` that transaction and
`signature` the voucher, with `source` naming the payer.

**A voucher per call.** `{"action": "voucher", "channelId": "0x…", "cumulativeAmount": "…", "signature": "0x…"}`,
signed by the payer or the channel's `authorizedSigner`. Sign what the receipts show spent plus the price of this
call: a call is paid only by a voucher for exactly that, so one for less or more, or a credential sent again, pays no call. A voucher over the
deposit is refused `amount-exceeds-deposit`. One voucher for the whole deposit is accepted and pays no call by
itself: the answer is `insufficient-balance` with `requiredCumulative`, the amount to sign. One call runs on a
channel at a time. The answer carries `Payment-Receipt`: `reference` is the channel id, `acceptedCumulative` your
highest voucher, `spent` what the calls have cost. A voucher may carry the draft's `deposit`, which opens or tops
up the channel in the same credential: `{"action": "open", "type": "authorization", "authorization": {…},
"signature": "0x…", "salt": "0x…"}` (and `authorizedSigner`) for an open, with the voucher's own `cumulativeAmount`
and `signature` as its first voucher, or `{"action": "topUp", "type": "authorization", "authorization": {…},
"signature": "0x…", "salt": "0x…"}` for a top-up of `authorization.value`.

**Top up.** `{"action": "topUp", "type": "authorization", "channelId": "0x…", "salt": "0x…", "authorization":
{…}, "signature": "0x…", "additionalDeposit": "…"}`. `additionalDeposit` is `authorization.value`, `salt` is 32
random bytes new for this top-up, and the authorization's nonce is
`keccak256(abi.encode(channelId, additionalDeposit, from, salt))`, the types `(bytes32, uint128, address,
bytes32)`. Or, at your own gas from the channel's payer, approve the escrow for the top-up, send its `topUp(channelId,
additionalDeposit)` and `{"action": "topUp", "type": "hash", "channelId": "0x…", "hash": "0x…", "additionalDeposit":
"…"}`, with `source`. A top-up the relay sends has a least amount; under it the answer is `insufficient-balance` with `requiredDeposit`. A top-up runs no tool.

**Without a call.** A `topUp`, a `close`, any credential on `HEAD`, and any credential with MCP
`_meta["zeam-bridge/payment-only"]: true` run no tool: 204 with `Payment-Receipt` over HTTP, a result with empty
`content` and the receipt in `_meta["org.paymentauth/receipt"]` and in `structuredContent` as `{receipt}` over MCP. The
tool's listed `outputSchema` admits that shape, so an MCP SDK client that checks results against it reads the answer.

**Leaving.** A payer can always leave. There are three ways, and each returns the deposit less what the seller has
been paid:

1. **The seller's close.** `{"action": "close", "channelId": "0x…", "cumulativeAmount": "…", "signature": "0x…"}`,
   a voucher for what was spent (the receipt's `spent`): the seller is paid what was spent and the rest of the
   deposit returns to the payer in the same transaction. The relay sends it free when the channel's
   fees (its spend times the fee address's share of the seller's split) cover the gas of its open, of every top-up and
   close request the relay sent for it, and of its close. When
   they do not, the close is answered `verification-failed` with `code: "gas_payment_needed"` and a refund's gas
   quote: sign `sign` and send the close again with `"gasPayment": {"authorization": {…}, "signature": "0x…"}` in its
   payload, `authorization` the answer's as it came, and one
   transaction closes the channel and takes the gas in USDC from what returns, with no ETH
   (`code: "nothing_to_return"` when the gas is not less than what returns).
2. **Without the seller, through the relay, with no ETH.** Sign `RequestCloseAuthorization(bytes32
   channelId,uint256 nonce,uint256 deadline)` in the escrow's domain (a voucher's: name `EVM Payment Channel`, version
   `1`, chain 8453, the escrow) and POST the escrow call
   `requestCloseWithAuthorization(channelId, nonce, deadline, payerSignature)` to
   `https://api.zeampass.com/relay/relay` as `{"calls": [{"to": "<escrow>", "data": "0x…"}], "split": <the 402's
   session member>}`. `nonce` is any number the payer has not used on this channel (32 random bytes; the escrow's
   `isPayerNonceUsed(payer, channelId, nonce)` says), `deadline` the Unix time after which the escrow refuses the
   call (a few minutes ahead), and `split` the whole `session` member, `{receiver, signer, split, salt}`, as the 402
   gave it. The answer's `results` holds one entry per call: `hash` when it was sent, `held: true` with `sendAfter` and
   `until` when the relay keeps it, or `error` and `code`. After the escrow's grace period, 15 minutes from the
   request's block (`closeRequestedAt` + `CLOSE_GRACE_PERIOD`, both read on the escrow), do the same with
   `WithdrawAuthorization` and `withdrawWithAuthorization`: everything the seller has not settled returns to the
   payer. The relay sends the two free when the fees on what the channel has settled cover the gas of its open, of
   every top-up the relay sent and of its exit; when they do not it answers `code: "gas_payment_needed"`. Then
   `POST https://api.zeampass.com/relay/quote` with `{"call": {"to": "<escrow>", "data": "<the request>"}, "split":
   <the session member>}`: it answers `op: "refund_gas_quote"`, `shape: {"session": "exit", "payment": true}`,
   `quoteMicroUSD` (the gas of the request and the withdrawal, 15% included, in USDC base units), `payTo` (the relay's
   gas wallet) and `covered`, with the other figures of a refund's quote (section 5). Sign the withdrawal and a USDC
   `TransferWithAuthorization` of `quoteMicroUSD` from the payer to `payTo`: its `validAfter` the chain's time now plus
   the grace period plus 30 s, so nobody can take it during the grace period, and its `validBefore` and the
   withdrawal's `deadline` at least 60 s after that. POST the request together with a Multicall3
   (`0xcA11bde05977b3631167028862bE2a173976CA11`) `aggregate3` of the withdrawal and the gas payment, neither allowed
   to fail, as two `calls`: the relay sends the request, holds the rest and sends it after the grace period, with no
   ETH. These two calls are ZEAM's additions to the draft's escrow.
3. **Without the seller or the relay, at your own gas.** The payer sends the draft's `requestClose(channelId)` to the
   escrow, and `withdraw(channelId)` after the same 15 minutes. This needs ETH on Base and nothing from anyone.

A channel with a close requested takes no more vouchers (`channel-finalized`). A top-up the payer funds cancels the
payer's close request. A buyer a seller has taken off its access list can still close: a close is never asked of the
list.

**Refusals.** RFC 9457 problems, `Content-Type: application/problem+json`, with `accepts` and fresh challenges:
the session draft's `invalid-signature`, `signer-mismatch`, `amount-exceeds-deposit`, `delta-too-small`,
`challenge-not-found` and `insufficient-balance` (402), `channel-not-found` and `channel-finalized` (410) and
`transaction-reverted` (409); and `malformed-credential`, `invalid-challenge` and `verification-failed` (402;
`verification-failed`: the relay declined, a call is in flight, or a transaction has no receipt yet).
A `verification-failed` with `code: "sent_not_shown"` means your open, top-up or close was sent and the seller's node
does not show it yet: send the same credential again after `retry_after_seconds`; it is taken once.

**Over MCP** every step is a `tools/call` on the paid tool, with the credential in
`params._meta["org.paymentauth/credential"]` and the receipt in `result._meta["org.paymentauth/receipt"]`. A client
that declared payment gets a refusal as error `-32043` with `error.data.failure.reason` `session/<type>` and a fresh
challenge, and a malformed credential as `-32602`. To stop a call, send `notifications/cancelled` with its
`requestId` on the `Mcp-Session-Id` the call was sent on: the call is released and not charged.
