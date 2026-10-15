# zeambridge (Python)

ZEAM :: Bridge for your own server. Define your tools once; agents pay per call over MCP and HTTP on your domain, by x402 or MPP.
The Bridge engine runs in your process: keys, channel records, gate usage and settlement stay on your server. ZEAM runs
the relay (gas for transactions that cover their own gas) and the credit service (gate checks). You keep 90.01% of
every sale, paid to your own split.

Source: https://github.com/zeam-labs/pass

License: Apache-2.0. Patent pending.

## Install

Published: `pip install zeambridge` (Python ≥3.9).
Until 1.0.9 this package was `zeam-pass`: change the requirement to `zeambridge`; `import zeam_pass` and `Pass` keep working.
Dependencies: `coincurve` (libsecp256k1, signing) and `pycryptodome` (Keccak, key sealing).

## Start

```python
from zeam_bridge import Bridge

agents = Bridge(name="acme", payout="0xYourWalletAddress", price="0.01")

@agents.tool(
    description="A price for a symbol.",
    input_schema={
        "type": "object",
        "properties": {"symbol": {"type": "string"}},
        "required": ["symbol"],
    },
)
def quote(symbol):
    return {"symbol": symbol, "price": lookup(symbol)}
```

FastAPI / Starlette:

```python
app.mount("/agents", agents.asgi())
```

Flask (`pip install flask`; werkzeug comes with it):

```python
from werkzeug.middleware.dispatcher import DispatcherMiddleware

app.wsgi_app = DispatcherMiddleware(app.wsgi_app, {"/agents": agents.wsgi()})
```

Replace `0xYourWalletAddress`: `payout` is a wallet address on Base that you control, and your earnings are paid to
it. `Bridge()` raises `ValueError` on a placeholder. Replace `acme` with your own `name` as well: it fixes your split's address.

Routes: `/agents/mcp` (MCP; payment in the tool call's `_meta`), `POST /agents/v1/<tool>` (x402 or MPP headers),
`/agents/openapi.json` and `/agents/refund`, with CORS. Django mounts `agents.wsgi()` or `agents.asgi()` the same
way. `examples/server.py` is a whole server on the standard library. `pip install` does not put it on disk: it is in
the source distribution and at https://github.com/zeam-labs/pass/blob/main/python/examples/server.py

In `openapi.json` each paid operation carries a `402` response and `x-payment-info`: its `price` in dollars,
`protocols`, and under `offers` the MPP `evm` charge its 402 carries now, where it carries one. Every operation says
`security: []`: no API key; a paid tool is opened by the payment.

MPP directories and validators look for `GET /openapi.json` at the root of your origin. Bridge mounted at `/agents`
does not see that path, so add the route in your own app; `agents.discovery(origin, "/agents")` is the same document
with each path written in full. Flask:

```python
@app.get("/openapi.json")
def discovery():
    return agents.discovery(request.host_url, "/agents")
```

FastAPI serves its own schema at `/openapi.json`: create the app with `FastAPI(openapi_url=None)` (or another path)
and add the route the same way, with `str(request.base_url)` as the origin. Without that route there is no root
document and a directory will not find your tools. Set `site` to your public origin when you run behind a proxy: the
document, the 402 and the MPP `realm` then name that origin. A directory fetches the document over HTTPS.

The agent side: https://zeampass.com/docs/agents

## Modes

What an agent does in each `mode`:

- `paywall` (default): pays `price` USD per call with x402 `batch-settlement`,
  or with an MPP charge where the 402 offers one (USDC on Base).
- `gate`: signs each call with its key as a zero-value x402 `exact` payment:
  nothing is paid, the key needs no funds; `admit=[...]` lists the admitted
  key addresses; a grant (`x-grant`) from one of them admits one other key.
- `both`: its key must be admitted; it pays per call.

`name` (2 to 32 of a-z, 0-9 and -, starting with a letter) and `payout` (the wallet address earnings go to) fix your
split's address and hold your gate credit: a change moves new earnings to a new split and leaves gate credit bought
before it behind, so pay out first.

Other keyword arguments to `Bridge(...)`:

- `price`: USD per call, up to 6 decimals (`"0.02"`); the default for tools
  with no price of their own.
- `prices`: per tool: `{"tool": "0.05"}` or
  `{"tool": {"price": "0.05", "unit": "0.0001"}}`, or a callable
  `(tool, args) -> spec`; a paywall needs `price` or `prices`.
- `free` (default `[]`): tool names served with no payment and no admission.
- `time` (default none): line time:
  `{"usd": "0.00025", "ms": 250, "idleMs": 0}`: that many dollars buys that many milliseconds. A buyer buys any
  number of milliseconds and buying again adds time (`"maxMs": N` limits one purchase, if you want that);
  `paywall` and `both` only; adds `buy_time`, `line` and `POST <base>/line`. Up to 1000 calls run at once on one
  line (`"maxCalls": N`, 1..1000, default 1000); lower it to limit a buyer's parallel calls — the next is refused `429 too_many_calls`.
- `free_limit` (default none): `N` or `{"perHour": N}`: N free calls per tool
  per client address per clock hour, kept in `state_dir/free.json` (a restart
  keeps the hour); no client address: one shared count; over it: 429
  `free_limit`, `retry-after`.
- `site` (default the request's origin): your public origin, used in the
  402's resource and refund URL.
- `admit` (default `[]`): admitted key addresses.
- `on_empty` (default `"refuse"`): gate credit at 0: `"refuse"`, or `"allow"`
  and warn.
- `contact` (default none): an `http(s)://` URL or a `mailto:` address; goes in
  every 402, in the 403 `refused` answer (`how` and `contact`) and in
  `openapi.json` `info.contact`.
- `state_dir` (default `$BRIDGE_STATE_DIR` or `~/.zeam-pass/<name>`): keys,
  channel records, gate usage, line time and free-call counts.
- `rpc` (default `https://mainnet.base.org`): a Base RPC URL.
- `relay` (default `https://api.zeampass.com/relay`): ZEAM's relay.
- `credits` (default `https://api.zeampass.com/credits`): ZEAM's gate credit
  service.
- `refund_url`: the refund URL the 402 names.
- `tick_seconds` (default `60`): seconds between background runs; `0` turns
  the thread off.
- `server_name`, `version`: the MCP handshake's server info.
- `fee_recipient`, `credit_issuer` (default `$BRIDGE_FEE_RECIPIENT`,
  `$BRIDGE_CREDIT_ISSUER`): development only.
- `payout_is_fee_recipient` (default `False`): `True` only when `payout` is
  the fee address: the split pays it 100%.
- `settings`: engine tuning; `gateFreePerMonth` and `gateCreditBlock` set the
  gate's free checks and credit block, for tests.

Settings from the environment are `BRIDGE_…`; the `PASS_…` name of each still works and is read second.

The Python plugin does not read `pass.json`.

`@agents.tool(...)` keyword arguments:

- `name`, `description`, `input_schema` (default the function's name and
  docstring, `{"type": "object"}`).
- `output_schema` (default none): the JSON Schema of the result, for the x402
  `bazaar` discovery extension the 402 carries (`extensions.bazaar`: how to
  call the tool, `input_schema`, `output_schema` or "any JSON"). In the
  `PAYMENT-REQUIRED` header while the extension is at most 4,096 bytes and the
  header at most 12,288; past that, in the body only.
- `price` (default `prices[name]`, then `price`): USD per call; an invalid
  price raises at registration.
- `unit` (default none): USD per unit: the call reserves `price`; the tool
  calls `zeam_bridge.units(n)`; charge = min(`price`, n × `unit`).
- `free` (default `False`): `True`: no payment, no admission; arguments still
  validated.
- `meter` (default none): `"time"`: on a line (`x-line`) the call burns the
  line's time; without one it is a paid call bounded to
  the milliseconds its price buys at the `time` rate (past it: 402 `out_of_time`, not
  charged); needs `time`, never free.

Order: the tool's `price`/`unit`, then `prices`, then `price`. The 402 carries this call's amount in `accepts`,
`pricing` for this call and `prices` for every tool; `tools/list` entries carry `_meta["zeam-pass/price"]`; `openapi.json`
operations carry `x-price`. A price the callable cannot give: 500 `price_invalid`. `gate` mode never prices.

## The gate

```python
import os

from zeam_bridge import Bridge, sign_grant

agents = Bridge(
    name="acme",
    payout="0xYourWalletAddress",
    mode="gate",
    admit=["0xAgentKeyAddress"],
)

grant = sign_grant(
    os.environ["ADMITTED_KEY"],
    "0xTheirKeyAddress",
    "2026-12-31T00:00:00Z",
    scope="quote",
)
```

An agent signs each call with its own key; nothing is paid, nothing goes on chain. `sign_grant(key, delegate, until,
scope="*")`: `key` is the private key of an address in `admit`, `delegate` the address of the key you admit, `until`
an ISO time or a timezone-aware `datetime`, `scope` one tool name or `"*"`. It returns the `x-grant` header value for
the agent that holds `delegate`. A call signed by any other key is refused `bad_grant`; so is one past `until`.
Removing the signing key from `admit` ends every grant it signed.

Agent side, in Python: `new_key()` makes a key; `key_address(key)` is the address the seller lists;
`gate_proof(key, payment_required)` signs the zero-value row of a gate's 402 (the body, or its `PAYMENT-REQUIRED`
header) and returns the `PAYMENT-SIGNATURE` value. Pass a gate: https://zeampass.com/docs/agents#pass-a-gate

## Keys

On first start the plugin writes its keys to `state_dir`: the settle key (signs your claims and refunds) and, for
`gate` and `both`, a credit wallet, which holds the gate's USDC; `agents.status()` shows its address. Gate mode: send
it USDC on Base; it needs no ETH. Credit is 2,000 checks at a time for $1 USDC ($0.50 per 1,000), bought after the
month's 10,000 free checks are used and again below 200 remaining. Keep $1 USDC on Base in the credit wallet. `both`
mode needs no USDC in the credit wallet: paid calls are not gate checks.

`keys.json` has mode 0600 in a 0700 directory. `BRIDGE_KEY_SECRET` seals the keys with AES-256-GCM (key from scrypt);
unsealed keys are sealed on the next start. Secret missing or wrong: paid calls answer 503 and nothing is served.

Put `state_dir` on storage that survives a redeploy, and back it up: it holds the keys and the channel records your
earnings are claimed from. `agents.status()` shows the settle key and credit wallet addresses, unclaimed and unpaid
earnings, and gate usage. Fields: https://zeambridge.com/docs/sell#status

## A call

1. Arguments are checked against your `input_schema` (types, `required`, `enum`, `minimum`, `maximum`, `minLength`,
   `maxLength`, and the same for an object argument's properties, 1 level deep). Bad arguments, and bodies with
   `NaN`, `Infinity` or numbers too large for a float: 400 (MCP: an error result); nothing held. An unpaid call to
   a paid tool with no arguments (no body, `{}`) gets the 402 with the price. Properties the
   schema does not name are allowed, as in Node: your function gets the ones its signature takes (all of them with
   `**kwargs`).
2. The payment is verified and held.
3. Your tool runs. With a `unit`, it reports whole units with `zeam_bridge.units(n)` (outside a tool run: `RuntimeError`).
4. The payment settles only on success. With a `unit`: no report, or a bad one (negative, not whole, bool, str),
   is a failure: released, nothing charged per call (on a line the call has used the time it ran). The settle response's `extra` carries `chargedAmount` and
   `reservedAmount`. The tool raised, returned a dict with `"isError": True`, or returned a value
   that is not valid JSON (a set, a non-finite float, a non-string dict key): the hold is released, nothing is
   charged per call (on a line the call has used the time it ran); the last answers 500 `tool_failed` with the message every engine gives: "the result is not valid JSON (a
   non-finite number or a non-JSON value); nothing was charged". An `"isError": True` dict is answered over HTTP with
   the fields of its `structuredContent`, as MCP carries them; a `status` of 400 to 599 among them, other than 402,
   marks a refusal that is the caller's and is the answer's status, with `Retry-After` from `retry_after_seconds`;
   otherwise 500 `tool_failed`.

The payment does not settle: the result is not delivered. Chain unreadable: nothing is served. Request bodies are
capped at 1 MB.

A voucher settles in your process with no transaction. A deposit (the first call on a channel, and every top-up) goes
through the relay and waits for its receipt: that call takes a few seconds.

Behind a proxy or on localhost, pass `site="https://your.domain"`: the 402's resource and refund URL use that origin.

Flask routes you already have: `@agents.paid` holds, runs and settles the same way; an exception or a status of 400
or more releases the hold. Add the refund route:

```python
from flask import Flask

app = Flask(__name__)

@app.post("/quote")
@agents.paid
def quote():
    ...

app.add_url_rule("/refund", view_func=agents.refund_view(), methods=["POST"])
```

## Line time

With `time` set, an agent buys time and spends it on a line with no payment per call:

1. `buy_time {"ms": n}` (any number of milliseconds; buying again adds time): a paid call for n ms at the `time` rate; the n ms are credited to the
   paying channel once the payment settles, once per payment.
2. `POST <base>/line {"op": "open", "channelId"}` (or the free `line` tool): a message to sign with the payer key.
3. `{"op": "prove", "channelId", "nonce", "signature"}`: the credential; the meter is on. A nonce is one attempt, 300 s.
4. Calls to a `meter="time"` tool with the credential in `x-line` (MCP: `_meta["zeam-pass/line"]` or the request's
   `x-line`) run until the time runs out; answers carry `x-pass-ms-remaining` and `x-pass-ms-elapsed` (MCP:
   `_meta["zeam-pass/meter"]`). Time burns while a call runs, once for calls at the same time, plus `idleMs` after each.
   Refusals: 403 `line_unknown`, 402 `meter_off`, `out_of_time`, `channel_leaving`, `refund_settling`, 429 `too_many_calls`.
5. `{"op": "off"}`, `"on"`, `"status"`, `"close"` with `credential` or `x-line`.

`zeam_bridge.deadline_ms()` inside a time tool: the epoch ms its call must end by (`None` elsewhere). The call runs in a
worker thread; past the deadline the caller gets `out_of_time` and a late result is discarded, so stop by then.
`zeam_bridge.stopped(wait=0)` inside a tool: true once the caller hung up, canceled the call over MCP
(`notifications/cancelled` with the call's line or its `Mcp-Session-Id`) or the time ran out; it waits up to `wait`
seconds for that. The meter stops at that moment and a call priced per call is not charged; a tool that does not check
runs on, unbilled. Over ASGI a disconnect is the hang-up. WSGI and `@agents.paid` cannot see one: there a call is billed
until it returns or is canceled. With a server of your own, pass `hangup=zeam_bridge.Hangup()` to `agents.handle()` and
call its `hang_up()` when the caller leaves.
Claims and payouts take what burned; a refund switches the meter off, returns the unburned time with the balance
(`timeReturnedMs`) and closes the channel's lines. State: `<state_dir>/meter`.

## Refunds

The buyer posts `{"channelId", "issued", "signature"}`, signed by the channel's payer over
`ZEAM Pass refund\nchannel: <id>\nissued: <ISO time>` within 5 minutes, plus `channelConfig` for a channel with no
calls. The balance goes back through the relay:

- The channel's spend times the fee address's share of your split (9.99%; 100% with `payout_is_fee_recipient`), in
  whole micro-dollars, ≥ the gas of its deposit, its refund and any calls not yet settled, and of every further deposit and every earlier refund ZEAM paid for on that channel, plus 15%: ZEAM pays the gas. `"op": "refunded"`, `gasMicroUSD: 0`.
- Otherwise: 409 `"op": "refund_quote"` (`gas_payment_needed`), an EIP-3009 `TransferWithAuthorization` of the quoted
  gas (15% margin) for the buyer to sign. The relay prices it; no quote from the relay: the engine prices from `GAS`
  (`quotedBy: "engine"`), with the ETH price and gas wallet it read from the relay's `/health` in the last 60
  seconds; without those, 503 `gas_unpriced`. Public check: `https://api.zeampass.com/relay/quote`. The buyer posts again with
  `"gasPayment"`; the relay sends the refund, then the payment, in one transaction.
- `"selfSend": true`: the buyer gets a signed refund of the full balance and sends it from any wallet with ETH on Base for gas.

Every field and error: https://zeampass.com/docs/agents#errors and
https://zeampass.com/docs/agents#refunds

## Background work

Where no process stays alive between requests the thread below does not run: set `tick_seconds=0` and call
`agents.tick()` from your scheduler. A daemon thread runs `agents.tick()` every `tick_seconds` (60): it stamps channels whose payer started a withdrawal,
claims earnings once the fee covers the gas and pays them out in the same relay request, and, in `gate` mode, buys
credit. Several workers can share one `state_dir`; overlapping ticks skip. `tick_seconds=0` and `agents.tick()` from
your cron schedules it yourself. `agents.payout_now()` pays out now, or returns the transaction to send from your
wallet with ETH on Base for gas.

A paid call waits on the chain and, for a deposit, on the relay: serve with threads or workers (gunicorn, uvicorn, or
`wsgiref` with `socketserver.ThreadingMixIn` and `request_queue_size = socket.SOMAXCONN` as in `examples/server.py`:
the standard library's default queue of 5 connections drops a burst).

## Tests

`python -m unittest` from this directory runs the plugin tests and the 5 fixture sets every engine shares
(`wordpress/tests/vectors.json`, `settlement/fixtures.json`, `gate/fixtures.json`, `pricing/fixtures.json`,
`meter/fixtures.json`).
