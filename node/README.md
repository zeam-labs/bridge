# @zeambridge/bridge

ZEAM :: Bridge for your own server. Define your tools once; agents pay per call over MCP and HTTP on your domain, by x402 or MPP.
The Bridge engine runs in your process. Your settle key, channel records and settlement stay on your server. You keep
90.01% of every sale, paid to your wallet through a split contract with no owner. ZEAM's relay sends the transactions your Bridge signs and
pays their gas when the transaction covers its gas at the 9.99% fee.

Source: https://github.com/zeam-labs/pass

License: Apache-2.0. Patent pending.

Formerly `@zeam-labs/pass` (ZEAM :: Pass); versions published under that name keep working.
Nothing a seller has changes: `pass()` is `bridge()` under its old name, `./pass.json` is still read, the state directory
is still `./.pass`, each `BRIDGE_…` setting is still read under its `PASS_…` name, and every header, `_meta` key and signed text keeps its `pass` name.

## Install

Published: `npm install @zeambridge/bridge` (Node ≥18).

## Start

```js
import { bridge } from '@zeambridge/bridge'

const agents = bridge({
  name: 'acme',
  site: 'https://acme.example',
  mode: 'paywall',
  price: '0.02',
  payout: '0xYourWalletAddress',
})
agents.tool({
  name: 'add',
  description: 'Adds two numbers.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  run: async ({ a, b }) => ({ sum: a + b }),
})
const handle = agents.handle('/agents')
```

Serve it one way. A fetch host:

```js
export default {
  fetch: async (request) =>
    (await handle(request)) ?? new Response('not here', { status: 404 }),
}
```

Express:

```js
app.use(agents.express('/agents'))
```

`payout` must be a real address; `bridge()` throws on a placeholder. Replace `0xYourWalletAddress` with a wallet
address on Base that you control: your earnings are paid to it. Replace `name` and `site` with your own as well: `name` fixes your split's address, and `site` goes in the 402's resource and refund URL.

`examples/server.mjs` is a whole server on `node:http`. After `npm install` it is inside the package (in a checkout
of the source it is `node/examples/server.mjs`):

    BRIDGE_NAME=acme BRIDGE_PAYOUT=0xYourWalletAddress BRIDGE_PRICE=0.02 \
      node node_modules/@zeambridge/bridge/examples/server.mjs

It prints `acme on 18620`, the port it listens on; `PORT` sets another.

With no `name`, `bridge()` reads ./bridge.json, or ./pass.json where there is none (or the file named by `config`):

```json
{
  "name": "acme",
  "site": "https://acme.example",
  "mode": "paywall",
  "price": "0.02",
  "payout": "0xYourWallet"
}
```

`0xYourWallet` is a placeholder too: put the wallet address on Base that your earnings are paid to, or `bridge()` throws.

Routes:

- `/agents/mcp` (and `/agents/mcp/`): MCP. Tools are listed free. A call carries the x402 PaymentPayload as a JSON object (not base64) in
  `_meta["x402/payment"]`, or an MPP credential in `_meta["org.paymentauth/credential"]`; an unpaid call answers with the x402 terms and, where MPP is offered, its challenge.
  A client that declared `capabilities.experimental.payment` is answered JSON-RPC error `-32042` with the challenge in `error.data.challenges` instead (`-32043` for a refused credential), as the MPP MCP transport draft writes it; docs/AGENTS.md section 7.
  Revisions, streams, resources and what the server says about itself: see MCP.
- `POST /agents/v1/<tool>`: the same tools over HTTP, with the x402 `PAYMENT-SIGNATURE` header or an MPP `Authorization: Payment` credential.
- `/agents/openapi.json`: the tools as OpenAPI. Each paid operation carries a `402` response and `x-payment-info`:
  its `price` in dollars, `protocols`, and under `offers` the MPP `evm` charge its 402 carries now, where it carries
  one. Every operation says `security: []`: no API key; a paid tool is opened by the payment.
- `GET /openapi.json` at the root of your origin, which is where MPP directories and validators look, is yours to
  switch on: `agents.handle('/agents', { discovery: true })` or `agents.express('/agents', { discovery: true })`. It is
  the same document with each path written in full (`/agents/v1/<tool>`). It is off unless you ask, so Bridge never
  takes a root path your own app serves. It answers only where your app passes root requests to that handler; if your
  app serves its own `/openapi.json`, add these paths to it instead. Behind a proxy set `site` to your public origin:
  the document, the 402 and the MPP `realm` name that origin, not the address the proxy calls. A directory fetches
  the document over HTTPS.
- `POST /agents/refund`: buyer refunds (see Refunds).

The agent side: https://zeampass.com/docs/agents

## Options

- `config` (default `./bridge.json`, else `./pass.json`, when no `name` is given): a path to a JSON
  file of these options, or the object.
- `name`: 2 to 32 of a-z, 0-9 and -, starting with a letter; fixes your
  split's address.
- `payout`: the wallet address earnings go to; a gate's zero-value proofs name
  it, and nothing is paid to it.
- `mode` (default `paywall`): `paywall`, `gate` or `both`.
- `price`: USD per call, up to 6 decimals (`"0.02"`); the price of a tool with
  none of its own; required for `paywall` and `both` unless `prices` is set.
- `prices` (default none): per tool:
  `{ report: '0.05', words: { price: '0.05', unit: '0.0001' } }`, or
  `(tool, args) => price`.
- `free` (default `[]`): tool names served with no payment and no admission.
- `time` (default none): line time:
  `{ usd: '0.00025', ms: 250, idleMs: 0 }`: that many dollars buys that many milliseconds. A buyer buys any
  number of milliseconds and buying again adds time (`maxMs: N` limits one purchase, if you want that);
  adds `buy_time`, `line` and `POST <base>/line`. Up to 1000 calls run at once on one line (`maxCalls: N`, 1..1000,
  default 1000); lower it to limit how many of a buyer's calls run in parallel — the next is refused `429 too_many_calls`.
- `freeLimit` (default none): free calls an hour per client address per tool
  (`60` or `{ perHour: 60 }`); over it: 429 `free_limit`. A free tool it should not count:
  `tool({ free: true, freeLimit: false })`. A free route of your own is counted the same way (see Routes you already have).
- `site` (default the request's origin): your public origin, used in the
  402's resource and refund URL.
- `admit` (default `[]`): the addresses of the keys a gate admits (`gate` and
  `both`).
- `onEmpty` (default `refuse`): gate credit at 0: `refuse`, or `allow` and
  warn.
- `sessions` (default none): `{ escrow, factory }`, the addresses of the MPP session escrow and of its payee
  factory, in mode `paywall` or `both`: every tool priced per call is also offered by MPP `session`. On Base they are
  `0x5e09aD70b644414cD1cD7Df1d9a10fF7899D92B8` and `0xE18fCE1266056becA4a3B0edfc15F8634EA6901B`. The session contracts
  are not audited: nobody outside their authors has reviewed them. What it changes for you:
  https://zeambridge.com/docs/sell#mpp-sessions
- `contact` (default none): an `http(s)://` URL or a `mailto:` address; goes in
  every 402, in the 403 `refused` answer (`how` and `contact`) and in
  `openapi.json` `info.contact`.
- `stateDir` (default `$BRIDGE_STATE_DIR` or `./.pass`): keys, channel records,
  gate usage, line time and free-call counts.
- `rpc` (default `https://mainnet.base.org`): a Base RPC URL, or an object
  with `call(method, params)`.
- `relay` (default `https://api.zeampass.com/relay`): ZEAM's relay.
- `credits` (default `https://api.zeampass.com/credits`): ZEAM's gate credit
  service.
- `tick` (default `60`): seconds between background runs; `false` turns the
  timer off.
- `keys`: `{ settle, credit }` private keys in place of the ones in
  `stateDir`.
- `keySecret` (default `$BRIDGE_KEY_SECRET`): seals `keys.json` (see Keys).
- `refundUrl` (default `<site>/<base>/refund`): the refund URL the 402 names.
- `feeRecipient` (default `$BRIDGE_FEE_RECIPIENT` or ZEAM's fee address):
  development only.
- `payoutIsFeeRecipient` (default `false`): `true` only when `payout` is the
  fee address: the split pays it 100%.
- `creditIssuer` (default `$BRIDGE_CREDIT_ISSUER` or ZEAM's issuer): development
  only: the key whose credit notes the gate accepts.
- `stores` (default file stores): `{ channels, gate }` in your own database
  (see State).
- `timeouts` (default `{ rpc: 10000, relay: 120000, credits: 20000 }`):
  milliseconds.
- `serverName`, `version` (default `name`, `1.0.0`): the MCP handshake's
  server info.
- `server` (default none): `{ title, description, websiteUrl, icons, instructions }`: the rest of what the MCP
  server says about itself (see MCP).
- `stream` (default `false`): `true` answers an MCP call with an event stream whenever the client's `Accept` names
  `text/event-stream` (see MCP).
- `priceList` (default `all`): `all`, or `tool` for a 402 that carries the price of the tool called and where
  the rest are (see Prices per tool).
- `listPage` (default none): how many tools one `tools/list` answer carries, and how many resources one
  `resources/list` answer; the rest follow by cursor (see MCP). With none, a list is one answer, whatever its length.
- `lineArgument` (default none): the name of a tool argument that may carry a line credential, e.g. `'line'`
  (see MCP).
- `unpaid` (default none): a function that adds your fields and your text to a 402 that states the price (see Your
  words in an unpaid answer).
- `lineQuery` (default none): the name of a query parameter that may carry a line credential, e.g. `'line'`, for a
  client that can set a URL and no header. It is read wherever `x-line` is, which outranks it: `/v1/<tool>`,
  `/line`, `/mcp` and a `paywall.wrap()` route that meters time. Off by default: no query string is read.
  `agents.lineOf(request)` returns the credential a request carries, header first, for a route or a socket of your
  own; it takes a fetch `Request` or a Node request.
- `onError` (default none): `(error, { method, path, ip }) => {}`, told every error the plugin answers 500 for, so
  you can log it. The buyer is told only `{ "error": "internal_error", "message": "internal error" }` (MCP: `-32603`
  `internal error`): what went wrong inside your server is not put in the answer. `path` is the path alone: it never
  carries the query string, so a `?line=<credential>` does not reach your log. A tool of yours that throws is not
  this: it answers `tool_failed` with the message it threw. The built-in `line` and `buy_time` are the plugin's: one
  that fails inside is told to `onError` and answered `internal error`, over HTTP and MCP, and nothing is charged.

Settings from the environment are `BRIDGE_…`; the `PASS_…` name of each still works and is read second.
`setting('BRIDGE_NAME')` (package export) reads one that way.

A bad `name` or `payout`, or a paywall without a price, throws when `bridge()` is called.

## Prices per tool

A tool's price: its own `price`, else `prices[tool]`, else `price`. A bad price throws at `tool()`; a `prices`
function that throws answers 500 `price_invalid`, nothing held.

```js
agents.tool({ name: 'report', price: '0.05', run })
agents.tool({ name: 'ping', free: true, run })
agents.tool({
  name: 'words', price: '0.05', unit: '0.0001',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async ({ text }, meter) => {
    meter.units(text.length)
    return { ok: true }
  },
})
```

`report`: $0.05 per call. `ping`: no payment, no admission. `words`: reserves $0.05, charges $0.0001 × units, at most
$0.05.

- The 402 states this call's `amount` and `pricing`, and `prices`: every tool's tag. `tools/list` carries each
  tool's tag in `_meta["zeam-pass/price"]`; `openapi.json` in each operation's `x-price`.
- `bridge({ priceList: 'tool' })`: a 402 carries the tag of the tool called and no other, so it is the same size
  with 5 tools or 500: `prices: { report: { usd: '0.05', per: 'call' } }`, and `priceList: { mcp, openapi, how }`,
  the addresses of this seller's `tools/list` and `openapi.json`, where every tool's tag is, and a sentence that
  says so. A route that is not a tool carries `prices: {}`. `'all'` is the default: every tag in every 402, and no
  `priceList`. The amount, `pricing`, the time line, `tools/list`, `openapi.json`, `terms()`, `prices()` and what a
  call is charged are the same either way; `offers().body` is the 402 as it is sent. A client that wants every
  price and finds `priceList` in a 402 reads the tags from `tools/list`, every page of it, or from the document.
- Tags: `{"usd":"0.02","per":"call"}`, `{"usd":"0.0001","per":"unit","upTo":"0.05"}`,
  `{"usd":"0","per":"call","free":true,"perHour":60}`, `{"per":"call","varies":true}` (a `prices` function);
  with `time`: `buy_time` `{"usd":"0.000001","per":"ms","ms":1}` and each time tool
  `{"per":"time","usd":…,"ms":…,"callUSD":…,"callMs":…}`.
- Usage: `meter.units(n)`, n a whole number ≥ 0. Charge = n × `unit`, at most the reserve; the rest of the reserve
  stays in the buyer's channel. `PAYMENT-RESPONSE` `extra` carries `chargedAmount` and `reservedAmount`, on every settled call. No units
  reported, or a bad n: the call fails, released, nothing charged.
- Free: validated, no payment header, 429 `free_limit` with `retry_after_seconds` past `freeLimit`. `handle()` counts
  per `info.ip` (`handle(base)(request, { ip })`); `express()` passes `req.ip`; no `ip`: one count shared by all
  callers. The count is kept in `stateDir/free.json`, so a restart does not reset the hour.
  `agents.tool({ name: 'about', free: true, freeLimit: false, run })` has no limit: it is never counted and never
  answers `free_limit`, its tag carries no `perHour` and its OpenAPI operation no 429 (Node engine).
- Time: `agents.tool({ name: 'scan', meter: 'time', run: async (args, { signal, deadline }) => ... })`. On a line
  (`x-line`) it runs until `deadline` (`signal` aborts then) and burns the line's time; without a line it is a paid
  call bounded to its price's ms. Calls, `buy_time`, the line steps and refunds:
  https://zeampass.com/docs/agents#line-time
- `paid()`, `instrument()` and `paywall` take prices by tool name (`prices`) or `{ price }`; usage metering is for
  `tool()`. `paywall.wrap()` also takes `meter: 'time'` and `free: true` (see Routes you already have).

## Tools come and go

`agents.tool()` with a name already registered replaces that tool whole: description, schemas, price and `run`.
`agents.untool(name)` takes one off: it leaves `tools/list`, `openapi.json` and the 402's price list, and a call to
it answers `unknown_tool`; a call already running finishes and settles. It returns `true` if there was one, and
throws for `buy_time` and `line`.

`agents.tool({ name: 'get_report', aliases: ['report'], … })`: a call to an alias, over HTTP or MCP, is a call to the
tool: its arguments, its price, its name in every answer. An alias is not listed in `tools/list`, `openapi.json` or
the price list, so a renamed tool keeps answering its old name. A tool of that name outranks an alias, and an alias
leaves with its tool. `agents.describe('buy_time', { aliases: ['tick'] })` gives a built-in tool one.

`tools/list` says what a tool returns. `tool({ outputSchema })` with `type: 'object'` is listed as
`outputSchema: { type: 'object', anyOf: [yours, { required: ['error'] }, { required: ['accepts'] }] }`: your result,
or the document a refusal carries (the price, an error). MCP clients check every structured result against the
listed schema, a refusal included; listed alone, yours would make them throw the price away. Declare one only for a
tool whose result is an object and fits it: the client refuses a result that does not. `tool({ annotations })`
(MCP's `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) is listed as given.

`tool({ title, _meta })`: a `title` is listed beside the name, and the keys of `_meta` (examples, anything a client
of yours reads) are listed beside the price tag, which stays the plugin's. `tool({ outputSchema, listedOutputSchema })`:
`listedOutputSchema` is the schema `tools/list` carries, wrapped the same way, when it should differ from the one
that describes the tool to directories: a client refuses a result that does not fit the listed schema, so a tool
whose results can leave a field out or null lists a schema that allows it, and keeps the exact one in `outputSchema`
for the 402's discovery extension.

`agents.describe(name, { title, description, summary, arguments, annotations, outputSchema, listedOutputSchema, _meta })` sets how a tool
already there is described, and nothing else about it; it is how `buy_time` and `line` get your title, your words and
your examples; it takes `aliases` too. It throws for a name that is not a tool and for any other field: the arguments, the price and `run`
are `tool()`'s, and a built-in tool's are the plugin's. `tools/list`, `openapi.json` and the 402 carry the new
description.

`tool({ description, summary })`, `describe(name, { summary })`: a tool has one `description`, listed whole in
`tools/list` and `openapi.json`; the 402 says it in `resource.description`, cut to 300 bytes at a sentence, or at a word with `...` when no sentence ends inside them, and
the MPP challenge cut further. A `summary` is what the 402 and the MPP challenge and offer carry instead, cut the
same way, when you would rather choose the short form than have it cut. No `summary`: the description, as before.

The built-in tools list a description for every argument: `line`'s `op`, `channelId`, `nonce`, `signature` and
`credential`, and `buy_time`'s `ms`. `agents.describe('line', { arguments: { credential: 'your words' } })` re-words
the ones it names, on a built-in tool or one of yours, and nothing else: each argument's type, its values, what is
required, and everything validation and billing read stay as they are. It throws for a name that is not an argument
of the tool and for a description that is not a non-empty string.

## Refusing before the price

`agents.tool({ name, refuses: async (args) => 'why' | null, run })`. `refuses` runs after the arguments pass the input
schema and before any price is quoted or payment read. A non-empty string answers 400 `invalid_arguments` with that
message (an MCP call: a tool error with the same body); nothing is held or charged. `null`, anything else, or a throw
lets the call go on. An unpaid call with no arguments is still told the price first.

## Your words in an unpaid answer

`bridge({ unpaid: ({ tool, base, via, body }) => ({ fields, text }) })`. It is asked each time the plugin is about to
answer 402 with the price (the terms, no error): for a tool over HTTP and MCP, and for a route behind `paywall` or
`paid()`. `fields` is an object added to the 402's body (MCP: its `structuredContent`); a name the plugin uses
(`accepts`, `prices`, `pricing`, `time`, …) stays the plugin's. `text` is a string for a reader, added as a second
text block of the MCP result. `tool` is the tool's name (a route: its `tool.name`, else its path), `base` the public
address your routes are mounted at, `via` is `'http'` or `'mcp'`, `body` the 402 as it stands. It may be async.
`null`, a throw, or fields that are not valid JSON leave the answer as it was. The `PAYMENT-REQUIRED` header and the
MPP challenge are not changed, nothing is charged or held, and `offers().body` carries the fields too.

## What a cut call had

A time tool that runs out of time answers 402 `out_of_time`, and whatever it had gathered is gone unless it says so:
`run: async (args, { ifCut, signal }) => ...`. `ifCut(fields)` leaves an object for that answer. Call it as often as
you like: the latest wins, and `null` takes it back. If the call is cut, the fields are added to the `out_of_time`
body, over HTTP and MCP, on a line (the line's time is spent, as for any cut call) and for a call sold without a line
(nothing is charged). The names are yours (`snapshot`, `needsMs`, `note`); `error`, `message`, `msRemaining`,
`elapsedMs`, `tool`, `accepts` and `x402Version` stay the plugin's. A call that ends in time drops them, and fields
that are not valid JSON are left out. `signal` aborts at the deadline as before: stop your work there.

## A call

1. The arguments are checked against the tool's `inputSchema` (`type: object`, `required`, the types `string`,
   `number`, `integer`, `boolean`, `object`, `array`, `null`, `enum`, `minimum`, `maximum`, `minLength`,
   `maxLength`, an array's `minItems`, `maxItems` and `items` (each item against it, an object item's `required` and
   properties included), and the same for an object argument's properties, 1 level deep; the array rules are the
   Node engine's). Bad arguments: HTTP 400 (MCP: an
   `isError` result); nothing held, nothing charged, no chain read. An unpaid call to a paid tool with no arguments
   (no body, `{}`) gets the 402 of step 2.
2. **paywall:** no payment answers 402 with the x402 `batch-settlement` terms and, for a tool priced per call, an MPP `Payment` challenge when the fee address's share of that one call (9.99%; 100% with `payoutIsFeeRecipient`) covers the gas of one USDC transfer plus 15%; an MPP client pays that call with one USDC transfer to your split. The 402 of a `tool()` carries the
   x402 `bazaar` discovery extension (`extensions.bazaar`: how to call it, its `inputSchema`, and its `outputSchema`
   if you give one in `tool({ outputSchema })`, else "any JSON") so x402 directories can list it. In the
   `PAYMENT-REQUIRED` header while the extension is at most 4,096 bytes and the header at most 12,288; past that, in
   the body only. A payment is verified as the x402
   SDK's facilitator verifies it (voucher signature, channel binding, chain balance, cumulative amount) and the
   channel is held. **gate:** the zero-value x402 `exact` signature is verified offline (nothing is paid; the key
   needs no funds), replay is refused, grants are checked, 1 check is counted. **both:** the payer must be admitted
   before anything is held; paid calls are not gate checks.
3. Your tool runs; its result is serialized to JSON.
4. Success: the payment settles. A voucher is committed to your channel record; a first deposit goes on chain
   through the relay. The result carries the `PAYMENT-RESPONSE` header (MCP: `_meta["x402/payment-response"]`).
   Failure (the tool threw, returned `isError: true`, or an HTTP route answered 400 or above): the hold is released,
   the buyer gets HTTP 500 `tool_failed`, nothing charged per call (on a line the call has used the time it ran). An
   `isError: true` result is answered over HTTP with the fields of its `structuredContent`, as MCP carries them; a
   `status` of 400 to 599 among them, other than 402, marks a refusal that is the caller's and is the answer's status,
   with `Retry-After` from `retry_after_seconds`. A result that is not valid JSON answers 500 `tool_failed` too (a
   non-finite number, a BigInt, a circular object, an empty array slot, a `Date`, a class instance, anything
   `JSON.stringify` changes or drops, or no result), with the message every engine gives: "the result is not valid
   JSON (a non-finite number or a non-JSON value); nothing was charged".

Settlement fails: the result is withheld; the buyer gets a 402 with the terms and the reason. Chain unreadable: the
payment is refused.

## The gate

`mode: 'gate'` admits the keys in `admit`, free to them; `both` admits them and they pay per call. An agent signs
each call with its key as a zero-value x402 payment (any x402 client makes one): nothing is paid, the key needs no
funds or ETH, nothing goes on chain. Agent side: https://zeampass.com/docs/agents#pass-a-gate

```js
const agents = bridge({
  name: 'acme',
  mode: 'gate',
  payout: '0xYourWalletAddress',
  admit: ['0xAgentKeyAddress'],
})
```

A key in `admit` can admit one other key with a grant. `signGrant` returns the `x-grant` header value for the agent
that holds that key:

```js
import { signGrant } from '@zeambridge/bridge'

const grant = await signGrant({
  key: process.env.ADMITTED_KEY,
  delegate: '0xTheirKeyAddress',
  scope: 'add',
  until: '2026-12-31T00:00:00Z',
})
```

`key`: the private key of an address in `admit`. `delegate`: the address of the key you admit. `scope`: one tool
name, or `'*'` (default). `until`: an ISO time or a `Date`. A call signed by any other key is refused `bad_grant`; so
is one past `until`. Removing the signing key from `admit` ends every grant it signed. A key:
`generatePrivateKey()` from `viem/accounts`; `privateKeyToAccount(key).address` is the address to list.

## Keys

On first run the engine writes its keys to `stateDir/keys.json`, mode 0600: the settle key (signs your claims and
refunds; the `receiverAuthorizer` of every channel) and, for `gate` and `both`, the credit wallet, which holds the
gate's USDC. `agents.status()` shows its address (`creditWallet.address`); `keys: { credit }` sets your own. Gate
mode: send it USDC on Base; it needs no ETH. Credit is 2,000 checks at a time for $1 USDC ($0.50 per 1,000), bought
after the month's 10,000 free checks are used and again below 200 remaining. Keep $1 USDC on Base in the credit
wallet. `both` mode needs no USDC in the credit wallet: paid calls are not gate checks.

`BRIDGE_KEY_SECRET` seals the keys with AES-256-GCM (key from scrypt); an unsealed file is sealed on the next start.
Keep the secret across every redeploy: a sealed file cannot be opened without it.
Back up `keys.json` and the secret: without the settle key, your channels cannot be claimed.

## State

`stateDir` holds channel records (the SDK's field layout plus `handedOver`, `depositsWePaid`, `refundGasWePaid`, `repairedAt`), gate
usage, replay protection, MPP charges accepted and not yet settled (`mpp-held/`) and the last run's report, written
atomically under a lock; several processes can share one disk. Without a persistent disk, give your own stores:

```js
bridge({ ..., stores: {
  channels: {
    get: async (channelId) => record | null,
    update: async (channelId, fn) => next,
    list: async () => records,
  },
  gate: {
    get: async (key) => value | null,
    update: async (key, fn) => result,
  },
  mppHeld: {
    claim: async (key, untilMs, nowMs) => boolean,
    release: async (key) => {},
  },
} })
```

`update` is atomic per id: read the current value, call `fn(current)`, store the return (channels: `null` deletes;
gate: `fn` returns `[next, result]` and `update` returns `result`). `get` returns `null` for an id or key the store
does not hold, and channels' `list` returns every record the store holds as an array, `[]` when it holds none.

## Background work

Every `tick` seconds, on a timer that does not keep the process alive, the engine stamps channels whose payer started
a withdrawal, claims idle channels and pays you out through the relay once the 9.99% fee covers the gas, and, for a
gate, buys credit. Serverless: set `tick: false` and call it from your cron:

```js
const agents = bridge({
  name: 'acme', payout: '0xYourWalletAddress', price: '0.02', tick: false,
})
const handle = agents.handle('/agents')
export default {
  fetch: async (request) =>
    (await handle(request)) ?? new Response('not here', { status: 404 }),
  scheduled: () => agents.tick(),
}
```

- `tick(options)` (package export): makes a Bridge from the options (or the config file) with the timer off and runs once.
- `agents.tick()`: 1 run.
- `agents.payout()`: pays out now through the relay, or returns a transaction to send from your wallet with ETH on
  Base for gas.
- `agents.status()`: unclaimed, paid, gate usage. Fields: https://zeambridge.com/docs/sell#status
- `agents.books()`, `agents.gas()`: the escrow's books for your receiver, and the gas your wallets hold (see Books
  and gas).
- `agents.stop()`: stops the timer.
- `agents.drain()`: ends the calls in flight before your process exits (see Shutting down).
- `agents.verify(url)`: whether your `site` shares that URL's origin.

## Shutting down

`await agents.drain()` before your process exits. From then no paid call starts: it answers 503 `restarting`,
nothing charged; free tools, `tools/list`, the line route and refunds still answer. Every running call is told to
stop through its `signal` and answers 503 `restarting`: a call on a line is billed the time it ran and its clock is
closed, a call paid per call is charged nothing. `drain()` resolves when they have ended, with
`{ finished, ended, left }`. `drain({ wait: ms })` first gives running calls that long to finish and be paid as
usual. `left` counts the calls it cannot end: a `paid()`, `instrument()` or per-call `paywall` handler takes no
`signal`, so it is given `wait` and no more. A drained Bridge stays shut; it is for a process that is leaving.
`drain()` does not stop the timer and claims nothing: `agents.stop()` and `agents.tick()` do that.

A process that dies without draining needs no call from you. A call it left open on a line is billed to the last
second that process was alive, not to its deadline, once that is 30 seconds past; the next process does it when the
line is next read.

## MCP

`<base>/mcp` is written in this package, with no MCP SDK. This section is the Node engine: the Python and WordPress
engines serve the four earlier revisions, answer in JSON only, and have none of `server`, `stream`, `resource()`,
`lineArgument` or `listPage`.

**Revisions.** `2026-07-28`, and `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05` as before. A request that
claims no revision is served as it always was: `initialize` agrees one of the four earlier revisions (never
`2026-07-28`, which has no handshake), `ping` answers, a batch is taken. A `2026-07-28` request names its revision in
`params._meta["io.modelcontextprotocol/protocolVersion"]`, with `io.modelcontextprotocol/clientCapabilities` beside it
(`clientInfo` is optional), and may repeat it in the `MCP-Protocol-Version` header. It sends `Mcp-Method`, and
`Mcp-Name` on `tools/call` and `resources/read`. It gets:

- `server/discover` in place of `initialize`: `{ supportedVersions: ["2026-07-28"], capabilities, instructions }`.
- `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]` on every result; `ttlMs: 0` and
  `cacheScope: "private"` on a list, a read and the discovery.
- HTTP 404 with `-32601` for a method that revision does not have or this server does not serve (`ping`,
  `initialize`, `prompts/list`, `subscriptions/listen`).
- HTTP 400 with `-32020` when a header and the body disagree or `Mcp-Method` or `Mcp-Name` is absent; `-32602` when
  the envelope is not whole; `-32600` for a batch. HTTP 415 unless the body is `application/json`.

On every revision, a version this server does not serve, named in the header or the envelope, answers HTTP 400 with
`-32022` and `data: { supported, requested }`: the list to retry from.

Payment does not change with the revision: the same `_meta` keys carry the payment and the settlement, an unpaid
call is told the same terms, a free tool is free, and a call on a line spends its time.

Not served: `subscriptions/listen` and list-change notifications, prompts, completions, and the check of
`Mcp-Param-*` headers against an `x-mcp-header` in a tool's schema.

**Pages.** `bridge({ listPage: 50 })`: `tools/list` and `resources/list` answer that many entries, in the order you
registered them, and a `nextCursor` while there are more; a client sends it back as `params.cursor` for the next page,
on every revision. The last page has no `nextCursor`. A cursor stays good while tools come and go: one listing, from
its first page to its last, lists each tool that was there when it began and is still there when its page is asked
for, once. So no tool is listed twice, none that was there throughout is skipped, a tool registered after the first
page is in the next listing, and a tool replaced under its name keeps its place. A cursor that is not one this server
gave for that list answers `-32602`. A cursor is good in the process that gave it, and in another that registered the
same tools in the same order; after a restart, list again from the start. Without `listPage` nothing changes: one
answer, no `nextCursor`, and a `cursor` a client sends is not read. `agents.tools()` is always the whole list. There
is no stream to send a list-change notification on, so none is sent and none is claimed: a client lists again to see
a change.

**Streams.** A call is a POST. `GET` answers 405: there is no stream the server opens on its own. `HEAD` answers 200.
An answer is one JSON body, unless the client's `Accept` names `text/event-stream` and neither `application/json`
nor `*/*`: then it is an event stream, one `message` event per answer, closed after the last. With `stream: true`
the answer is an event stream whenever `Accept` names `text/event-stream`, which MCP clients send beside
`application/json`; a `: keepalive` comment goes out every 15 seconds while a call runs. A `2026-07-28` request is
answered in JSON either way. `express()` writes a stream as it comes; with `handle()`, send the `Response` body as a
stream (`examples/server.mjs` buffers it, which delivers every event at the end).

**What the server says about itself.** `bridge({ server })`, or `agents.server({ title, description, websiteUrl,
icons, instructions })` at any time; a later call replaces the fields it names. `title`, `description`, `websiteUrl`
and `icons` (`[{ src, mimeType, sizes }]`) join `serverName` and `version` in the handshake's `serverInfo` and in
`_meta["io.modelcontextprotocol/serverInfo"]`. `instructions` is a string, or a function that returns one and is
asked at each handshake and discovery.

**Resources.** `agents.resource({ uri, name, title, description, mimeType, read })`. A resource is free to list and
to read. `read({ uri, base })` returns the text, or `{ text }` or `{ blob }` (base64), with a `mimeType` if it differs;
`base` is the public address your routes are mounted at. With one resource or more the server claims `resources` and
answers `resources/list`, `resources/read` and `resources/templates/list` (always empty). A `uri` it does not have:
`-32602` `Resource not found`.

**A line credential as an argument.** Some MCP clients can set neither a header nor `_meta`. `lineArgument: 'line'`
adds an optional string argument of that name to every `meter: 'time'` tool in `tools/list`; a call that carries it
runs on that line, as with `x-line` or `_meta["zeam-pass/line"]`, which both outrank it. The argument is removed
before your `inputSchema` is checked and before `run` is called. A tool whose own schema has a property of that name
keeps it and takes no credential this way. Off by default: no schema changes and no argument is read.

## An MCP server you already have

With the official SDK, make its tools paid in place:

```js
const server = agents.instrument(
  new McpServer({ name: 'mine', version: '1' }),
  { free: ['about'] },
)
server.registerTool('quote', { inputSchema: { symbol: z.string() } }, handler)
```

`instrument()` returns the server. Tools the official SDK holds when `instrument()` runs are made paid too (except
the `free` ones); on another server object, a tool registered before `instrument()` stays free. One handler:
`server.registerTool('quote', config, agents.paid('quote', handler, { description }))`. The SDK checks the arguments
before the handler runs.

## Routes you already have

`app.use('/reports', agents.paywall.express())`, or `agents.paywall.wrap(handler)` for a fetch handler. The Express
paywall buffers the whole response until the payment settles, then sends it with `PAYMENT-RESPONSE`; a stream is
sent when it ends. `paywall.wrap()` settles when your handler returns its `Response`, before a streamed body is read:
a stream that fails partway is charged. Give `wrap()` a complete body, or use the Express paywall.

A route priced by time: `agents.paywall.wrap(handler, { meter: 'time' })` sells a fetch route the way a
`meter: 'time'` tool is sold (it needs the `time` option). A request with a line credential in `x-line` rides the
line: no payment per request, time burns while your handler runs, and the response carries `X-Pass-Ms-Remaining` and
`X-Pass-Ms-Elapsed`. A request with no line is one payment (`price`, else the seller's `price`) for the ms that buys.
The refusals are a time tool's: 402 with the terms, 402 `out_of_time` or `meter_off`, 403 `line_unknown`, 429
`too_many_calls`, 499 `client_gone`, each a JSON `{ error, message }`.

```js
const rpc = agents.paywall.wrap(async (request, call) => {
  const answer = await node.send(await request.json(), { signal: call.signal })
  return Response.json(answer)
}, { meter: 'time' })
app.post('/rpc', agents.serve(rpc))
```

- The handler is called `(request, call, ...rest)`. `call` is `{ signal, ifCut, channelId }` and, on a line,
  `deadline` and `renew`. `signal` aborts when the time runs out or the caller hangs up (`request.signal`); `ifCut` is
  the one a tool has (see What a cut call had).
- A response of 400 or above is sent as yours and is not charged per call; a throw answers 500 `tool_failed`; on a
  line both have used the time they ran. The call is settled when your handler returns its `Response`.
- One request is one call, whatever it carries: a JSON-RPC batch is one payment, or one stretch of line time, and is
  cut as one. `call.ifCut({ answers })` keeps the answers finished before the cut. A route with an envelope of its
  own wraps the wrapped handler and puts any refusal in that envelope.
- `line: (request) => credential` reads the line credential from somewhere other than `x-line`. For a query
  parameter the `lineQuery` option does it on every route.
- `tool: { name, description, inputSchema, outputSchema }` describes the route in its 402 as a tool is described,
  for directories; a per-call `wrap()` takes it too.
- `base: 'https://acme.example/agents'` is the public address your `handle()` routes are mounted at, so the 402 of
  a route outside them names the line route in full (`POST https://acme.example/agents/line`), as a tool's 402 does.
  Without it the 402 uses your `refundUrl` option less its `/refund`, and with neither it says `POST /line`.
  `paywall.express({ base })` takes it too.
- `agents.serve(handler)` mounts any fetch handler in Express; a connection closed before the answer is the
  hang-up. A handler that throws is answered 500 `internal error`, and `onError` is told with the request's path
  and no query string.

`paywall.express()`, `paid()` and `instrument()` price per call only.

**A free route.** `agents.paywall.wrap(handler, { free: true })` is a route of yours that costs nothing and is counted
as a free tool is (Node engine). No payment is read. Each caller address has the seller's `freeLimit` calls an hour;
`freeLimit: 20` on the route gives it a number of its own and `freeLimit: false` none; with neither set there is no
limit. Past it the route answers what a free tool answers: 429 `free_limit` with `retry_after_seconds` and a
`Retry-After` header, and your handler is not run. The hour, the address rule (an IPv6 address is counted by its
/64, an IPv4-mapped one as its IPv4 address) and the count in `stateDir/free.json` are a free tool's.

- The caller address is the `ip` of the route's second argument: `route(request, { ip })`, as `handle()` takes
  it. `agents.serve(route)` passes `req.ip`. No `ip`: one count shared by all callers.
- A route is counted under `tool: { name }` if it has one, else under the path of the request, so name a route whose
  path varies. A route with the name of a free tool shares that tool's count.
- The handler is called `(request, call, ...rest)` with `call.signal`, which aborts when the caller hangs up. Its
  `Response` is sent as it is, whatever its status; a throw is yours to catch.
- `agents.paths({ '/verify': { post: { free: true } } })` lists it in `openapi.json` with a free tool's `x-price`
  and, where it has a limit, its 429; `freeLimit` is taken there too.
- A free route does not meter time, and `paywall.express()` has no `free`.

**Your routes in the document.** `agents.paths({ '/rpc/{chain}': { post: { summary, requestBody, meter: 'time' } },
'/reports': { post: { summary, price: '0.05' } } })` lists routes of your own in `openapi.json`, beside the tools. A
path is written as your server serves it, from the origin. An operation is an OpenAPI operation, under any HTTP
method, plus the two keys `paywall.wrap()` takes: `price` (else the seller's `price`; a function is a price that
varies) and `meter: 'time'`. Give them as you gave them to the route: the plugin takes them out and writes what a
tool's operation carries, so you write no payment text: `x-price`, `security: []`, `x-payment-info` with the MPP
offer where the route's 402 carries one, and the answers 200, 400, 402, 403, 429 on a time route, 500 and 503. Your
own `responses` are kept; for 402, 403, 429 and 503 the plugin's sentence comes first and yours follows it.
Everything else in a path item (`parameters`, `summary`) is passed through. In `<base>/openapi.json` a path under
the mount is written from the mount, as a tool's is, and a path outside it carries `servers: [{ url: <origin> }]`;
in the document at the root (`discovery: true`) every path is written in full. A later call replaces the routes
listed, `paths({})` lists none, and a path that is a tool's stays the tool's. The document describes; the route is
sold by `paywall`.

## A stream on a line

A websocket subscription, a server-sent stream, a held connection: something open for as long as the buyer has time.
`agents.ride(credential, { signal })` puts it on a line (it needs the `time` option):

```js
const ride = await agents.ride(credential)
if (!ride.ok) return socket.close(1008, ride.body.error)
ride.onCut((body) => { socket.send(JSON.stringify(body)); socket.close(1008, body.error) })
socket.on('close', () => ride.end())
```

- Refused: `{ ok: false, status, body }`, the answer a call on that line would get: 403 `line_unknown`; 402
  `meter_off`, `out_of_time`, `refund_settling` or `channel_leaving`; 429 `too_many_calls`; 503 `restarting`.
- Open: `{ ok: true, channelId, signal, deadline, msRemaining(), renew(), end(), onCut(fn) }`. Time burns from then
  until it ends, and it is billed as a call of that length is. A ride is one call on the line (`maxCalls`); a ride
  and calls open at the same time burn the line once.
- `deadline` is when the line's time runs out. At the deadline the plugin looks for time bought since and carries on
  if there is some; `renew()` looks now and returns the deadline. With none the ride is cut: the time is spent,
  `signal` aborts and `onCut(body)` is told `{ error: 'out_of_time', message, msRemaining }`. `agents.drain()` cuts
  it too, with `restarting`, billed to that moment. A listener added after the cut is told at once.
- `await ride.end()` when the client leaves: billed to that moment, it returns `{ msRemaining, elapsedMs }`. The
  `signal` you pass to `ride()` does the same when it aborts. `onCut` is not called for an end of your own.
- A ride bills as a call on the line does, by the same clock: a ride of a length is billed what a call of that
  length is; a ride and a call open together are billed the time from the first opening to the last close, once;
  a ride refused for `maxCalls`, cut when the time runs out or ended by `drain()` is told what a call is told. What
  differs: a ride needs a line (a call may be paid alone), it burns from open to end whether or not anything is
  sent on it, and it has no `ifCut`.
- `await agents.line(credential)` says whether a credential is an open line before anything starts:
  `{ ok: true, channelId, msRemaining, msSpent, metering }` and the rate, or `{ ok: false, status, body }`. Nothing
  burns.

## Your terms, read back

For a page, a catalog or a status route of your own, ask the plugin what it tells agents; do not restate it by hand.

`agents.terms()` returns `{ name, mode, protocols, headers: { request, response }, payout, feeRecipient, relay,
network, chainId, asset, receiver, escrow, collectors: { erc3009, permit2 }, permit2, split, feeShare, withdrawDelay,
settle }`. `protocols` is what a call here may pay with: `['x402', 'mpp']` for a paywall whose token takes an MPP
charge, `['x402']` otherwise. `headers` are the request headers the plugin reads and the response headers it sets.
`escrow` is the x402 batch-settlement contract that holds a buyer's deposit, `collectors` the two contracts a deposit
goes through, `permit2` the Permit2 contract: the addresses the engine hashes and verifies with, so a page that prints
them needs no SDK and no pin of its own.

`agents.prices()` returns every tool's price tag by name, `{ report: { usd: '0.05', per: 'call' }, … }`: the tags of
Prices per tool, as `tools/list` and the 402 carry them.

A route you wrapped with a name is in it too (Node engine): after
`agents.paywall.wrap(handler, { tool: { name: 'rpc' }, meter: 'time' })`, `agents.prices().rpc` is the tag
`paths()` writes as that route's `x-price`: `{ usd, per: 'call' }`, the time tag, `{ per: 'call', varies: true }`
for a price that is a function, or a free tool's tag for a free route, with its `perHour`. A route has an entry
from the moment it is wrapped; wrapped again under the same name it has one entry, the later one. A tool of that
name keeps the name, and a route with no name is not listed. The routes are in `prices()` only: `tools/list`,
`openapi.json` and the price list of a 402 are the tools, as before.

Before a Bridge exists (package exports): `contracts` is `{ escrow, collectors, permit2 }`, and `feeRecipient()` is
the fee address `bridge()` will use, so `payoutIsFeeRecipient: payout.toLowerCase() === feeRecipient().toLowerCase()`
needs no address written down. `names` holds the strings of the protocols for a route of your own:
`names.headers` (`payment`, `credential`, `line`, `grant`, `required`, `response`, `challenge`, `receipt`,
`grantedBy`, `msRemaining`, `msElapsed`), `names.meta` (the `_meta` keys: `payment`, `response`, `credential`,
`required`, `receipt`, `line`, `meter`, `price`, `grantedBy`) and `names.rpc.paymentRequired`, the JSON-RPC error code
(`-32402`) a route with a JSON-RPC envelope gives a refusal for want of payment.

`await agents.offers('report', { base })` returns what an unpaid call to that tool is told now:
`{ x402, mpp, body, headers }`. `x402` is the `accepts` list; `mpp` is `{ method, intent, currency, chainId, amount }`,
or `null` when no MPP charge is offered at that price; `body` and `headers` are the 402 itself. It is `null` for a
free tool and for a name you do not sell. `base` is the public address your routes are mounted at, for the resource
and refund addresses in the answer. For a route of your own: `await agents.offers({ path: '/reports', price: '0.05' }, { base })`.
Give it what you gave `paywall.wrap()`: with `tool` the answer carries the route's description, with `meter: 'time'`
it is the one payment a request with no line makes, and with `free: true` it is `null`.
Nothing is charged and nothing is held.

Many at once (Node engine): `await agents.offers({ tools: 'all' }, { base })`, or `{ tools: ['report', 'words'] }`,
returns `{ report: { x402, mpp, body, headers }, ping: null, … }`: for each name, what `offers(name)` returns, a
`null` for a free tool or a name you do not sell included. `'all'` is every tool in `tools()`. What does not differ
from one tool to the next is made once a call: the price list, the deposit and refund terms of each price and the
MPP floor, read from one gas quote. A long run gives the event loop a turn every 5 ms of work, so a catalog of
thousands is refreshed without holding up your requests. Each MPP challenge is its own, as two calls to
`offers(name)` give two. With `priceList: 'all'` every entry's `body.prices` is one object and every 402 still
carries the whole list, so a refresh costs time and memory by the square of the catalog; `priceList: 'tool'` does not.

## Books and gas

Two readings of the chain for a status page of your own. Each returns plain data and adds no route; each reads the
chain when it is called, so keep the answer for as long as suits your page.

`await agents.books({ receivers, token, fromBlock, pageBlocks })` checks what the escrow says it has settled to a
receiver against the sum of the escrow's own `Settled` events for it. It returns
`{ ok, checked, disagreeing, books }`, one row a receiver: `{ receiver, role, token, totalClaimed, totalSettled,
settledFromEvents, unsettled, settleEvents, scannedThroughBlock, agrees }`, amounts in the token's units as strings.
`agrees` is `totalSettled === settledFromEvents`; `unsettled` is claimed and not yet settled, which a payout
settles; `ok` is every row agreeing. With no `receivers` it checks your split (`role: 'split'`); give addresses, or
`{ address, role }` with a name of your own, to check others, such as a receiver you sold through before. `token`
is USDC unless you say. The events are read from `fromBlock` (default 46033952, the block on Base the escrow was
deployed at) in pages of `pageBlocks` blocks (default 100000; lower it for an RPC that returns fewer). A page is one
`eth_getLogs` for every receiver together, filtered by the RPC, and 8 pages are asked at once. A Bridge remembers how
far it has read, so a later call reads only the blocks since. It keeps the count in `stateDir/books.json` up to
100000 blocks behind the head, so after a restart it reads those last blocks again and no more: the first reading
in a new state directory is the only one that walks the chain from `fromBlock`, and it takes as long as your RPC
takes to answer some 65 pages today. Read it once in the background when your process starts rather than inside a
request. A chain that cannot be read rejects.

`await agents.gas({ wallets, gasUnitsPerTransaction, targetTransactions, lowBelowTransactions })` reads the ETH each
wallet holds against what a transaction costs at the gas price now. It returns `{ ok, empty, low, readAt,
gasPriceWei, gasUnitsPerTransaction, targetTransactions, lowBelowTransactions, wallets }`, and `error: 'out_of_gas'`
with a `message` when a wallet cannot send one. Each wallet is `{ name, address, wei, coversTransactions, empty, low,
toTargetWei }`: `empty` covers less than one transaction, `low` fewer than `lowBelowTransactions`, and `toTargetWei`
is what it is short of `targetTransactions`. The settle key is listed as `settle`; `wallets: [{ name, address }]`
adds your own. The relay sends what your Bridge signs, so the settle key needs ETH only if you send from it. With no
numbers given a transaction is one claim and a payout from the engine's gas table, and both counts are 1: the next
transaction. A chain that cannot be read answers `{ ok: false, error, readAt, empty: [], low: [], wallets: [] }`. In
`gate` mode it adds `credit: { address, usdcMicro, nextPurchaseMicro, covers }`, the credit wallet's USDC against its
next purchase of checks, and `ok` needs it covered.

## Refunds

`agents.handle()` and `agents.express()` serve `POST <base>/refund`. With `instrument()`, `paid()` or the paywall,
mount it: `app.post('/refund', agents.refundExpress())`, or `agents.refund(request)` in a fetch handler. The refund
URL the 402 names is `site` + the mount path when `site` is set, else the request's host.

The buyer posts `{ channelId, issued, signature }`, signed by the channel's payer over
`ZEAM Pass refund\nchannel: <id>\nissued: <ISO time>` within 5 minutes, plus `channelConfig` for a channel with no
calls. The balance goes back through the relay:

- The channel's spend times the fee address's share of your split (9.99%; 100% with `payoutIsFeeRecipient`),
  rounded down, ≥ the gas of its deposit, its refund and any calls not yet settled, and of every further deposit and every earlier refund ZEAM paid for on that channel, plus 15%, rounded up: ZEAM
  pays the gas. `op: "refunded"`, `gasMicroUSD: 0`.
- Otherwise: 409 `op: "refund_quote"` (`gas_payment_needed`), an EIP-3009 `TransferWithAuthorization` of the quoted
  gas (15% margin) for the buyer to sign. The relay prices it (`quotedBy: "relay"`); no quote from the relay: the engine
  prices from `Config.GAS` and the measured L1 fee (`quotedBy: "engine"`), with the ETH price and gas wallet it read
  from the relay's `/health` in the last 60 seconds; without those, 503 `gas_unpriced`. Public check:
  `https://api.zeampass.com/relay/quote`. The buyer posts again with `gasPayment`; the relay sends the refund, then
  the payment, in one transaction.
- `selfSend: true`: the buyer gets a signed refund of the full balance and sends it from any wallet with ETH on Base for gas.

Every field and error: https://zeampass.com/docs/agents#errors and
https://zeampass.com/docs/agents#refunds

## Browsers

`handle()` responses carry `access-control-allow-origin: *` and expose `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE` and
`X-Pass-Granted-By`; `OPTIONS` on `/mcp`, `/v1/*` and `/refund` answers the preflight, which allows the
`MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` request headers.

## Node only, for now

`terms()`, `prices()`, `names`, `contracts`, `feeRecipient()`, `onError`, `unpaid`, the paywall's `base`, `offers()` and its bulk form, `refuses`, `ifCut`, `drain()`, `serve()`, `meter: 'time'` and `free` on `paywall.wrap()`, a wrapped route in `prices()`, `ride()`,
`line()`, `lineOf()`, `lineQuery`, `listPage`, `priceList`, `books()`, `gas()`, `paths()`, `untool()`, `describe()`, a tool's `aliases`, `title`, `summary`, `_meta` and `listedOutputSchema`, the argument descriptions of `line` and `buy_time`, and the output schema and
annotations in `tools/list` are in this engine. The Python and WordPress engines do not have them yet.

## Dependencies

- `viem`: keccak, secp256k1 signing and recovery, EIP-712 hashing, ABI encoding, JSON-RPC. It is the only
  dependency.

The x402 batch-settlement escrow and collector addresses, the EIP-712 domain and types (`Voucher`, `Refund`,
`ClaimBatch`, `TransferWithAuthorization`) and the channel id are in the engine's own source
(`src/engine/core/batch.mjs`), so the engine hashes what buyers sign.

The engine is the Node port of the PHP engine in the ZEAM :: Bridge WordPress plugin; both pass the same shared test
vectors.
