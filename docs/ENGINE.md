# The Bridge engine

Every plugin (WordPress/PHP, Node, Python) runs the same engine in the seller's process. The seller's keys, channel
records, gate usage and settlement stay with the seller. ZEAM runs the relay (gas for signed transactions that pay
for themselves) and the credit service (gate checks).

Reference: the PHP engine in the WordPress plugin's `lib/src/`, matching the x402 SDK. Node and Python follow its
structure, names and behavior, and pass the same shared fixtures.

## Pieces

| Piece | PHP reference | Job |
|---|---|---|
| Config | `Settlement/Config.php` | name, site, mode (gate/paywall/both), price (micro-USD per call), payout; the split (900100/99900 to the ZEAM fee address; with `payoutIsFeeRecipient`, payout = the fee address: 1000000 to it, fee share 1) and its salt (`keccak256("ZEAM Pass seller <name>")`: the text keeps the plugin's former name, since a new one would move every seller's split); the predicted split receiver; the settle key (receiverAuthorizer); relay, credits and RPC URLs; withdraw delay 86400; USDC on Base |
| Store | `Settlement/Store.php`, `Gate/Store.php` | `get`, atomic `update(id, fn)`, `list`; channel records in the SDK's field layout plus `handedOver`, `depositsWePaid`, `refundGasWePaid`, `repairedAt`, `timeOwed` |
| Server | `Settlement/Server.php`, `Verify.php` | `paymentRequired(resource)`, `verifyAndHold(header, resource)`, `settle(hold)`, `release(hold)` |
| Claims | `Settlement/Claims.php` | periodic: claim at margin with the payout in one relay request; the claim's gas (base and per voucher) counts with the payout's; a withdrawing channel's claim at its own margin |
| Refunds | `Settlement/Refunds.php` | see [Refunds](#refunds) |
| Withdrawals | `Settlement/Withdrawals.php` | periodic: stamp channels whose payer started a withdrawal; clear on cancel |
| Relay client | `Settlement/Relay.php` | `POST <relay>/relay {calls:[{to,data}], split:{split, salt, receiver}}` → `results[i].hash / error`. The relay sends 1 transaction at a time from its wallet. A request with a payout (settle, split creation, distribute, withdraw) goes out as one Multicall3 `aggregate3` in the given order, none allowed to fail |
| Gate | `Gate/Admission.php`, `Exact.php`, `Meter.php`, `Credits.php` | admission by key: a zero-value x402 `exact` signature verified offline; replay by from + lowercased nonce; grants from an admitted key to one delegate key, scoped to a tool; 10,000 free checks a month; credit notes signed by ZEAM's issuer; credit bought with an x402 `exact` payment from the credit wallet |
| Grant helpers | Node `signGrant` (`node/src/grant.mjs`); Python `sign_grant`, `gate_proof`, `new_key`, `key_address` (the package's `grants.py`); the WordPress settings page's Grants box | sign an `x-grant` with an admitted key; Python also signs an agent's zero-value proof |

## Escrow adapter (Node)

The channel engine (store, locks, holds, cumulative accounting, claims, refunds, withdrawals, line time, gas quoting)
does not name an escrow contract. It asks an adapter. `settlement/escrow.mjs` states the interface and holds the
registry; `settlement/x402.mjs` is the default adapter, the x402 `batch-settlement` escrow, wrapping
`core/batch.mjs`; `settlement/session.mjs` is the second, served only when the seller sets `sessions` (see
[MPP session](#mpp-session-node)). PHP and Python keep their layout and are held to the same behavior by the shared fixtures.

A channel record names its escrow in `escrow` only when it is not the default one. No record written so far has the
field: absent means x402 `batch-settlement`. In the Node engine, a record naming an escrow it does not serve is refused
(`unknown_escrow`: 402 on a paid call, 409 on a refund or a line), skipped by claims, counted in `errors` by
withdrawals, and never read as x402. The Python and WordPress engines serve the x402 escrow alone and write only x402
records, so they never meet another escrow's record and do not check for one.

What an escrow provides (`defineEscrow` refuses an adapter missing any of it):

| Member | Job |
|---|---|
| `kind`, `scheme`, `address`, `contracts`, `fromBlock` | the name on a record, the wire scheme, the contract and its collectors, its first block |
| `settles` | `at-most`: a claim may take less than the highest voucher signs (x402). `exact`: a settle takes exactly a signed amount, so a channel is claimable only when the amount charged is the amount signed |
| `gas` | units per action: `deposit`, `claimBase`, `claimEntry`, `claimAlone`, `refund`, `refundClaim`, `paidClaim`, `paidL1`, `paidClaimL1`. They are those rows of `Config.GAS`, which stays the one table a seller tunes; `payout`, `charge`, `createSplit` and `gasPayment` are the engine's own |
| `reasons`, `stale(reason)` | the refusal vocabulary (`invalid_batch_settlement_evm_*` for x402), and which refusals mean a cumulative amount out of step |
| `config`, `strictConfig`, `configFields` | the channel config normalized, checked as received, and named for a refusal |
| `channelId(config, chainId)` | the id formula |
| `termsError(config, channelId, chainId, requirement)`, `sellerMismatch(config, cfg)` | the config against the row it paid, and against this seller |
| `payer`, `signer` → `{address, wallet}`, `owners`, `token` | who funds, who signs vouchers (`wallet`: may be a contract, checked by ERC-1271), who may refund or open a line, which token. x402 has payer / payerAuthorizer and receiver / receiverAuthorizer; an escrow with payer / authorizedSigner and one payee answers the same four |
| `voucherDigest(channelId, cumulative, chainId)` | what a voucher signs |
| `accepts(cfg, asset, micro)` | its rows in the 402 `accepts`, none if it is not paid over the x402 envelope |
| `transferTarget(method)`, `fundingDigest(method, fields)`, `funding(method, authorization)` | per funding method (`eip3009`, `permit2`): the address the payer's authorization names, what it signs, and what the deposit call carries |
| `depositCall`, `claimCall`, `refundCall`, `collectCall` → `{to, data}` | deposit; claim a list of records (signed with the settle key); refund an amount with or without a riding claim; move what was claimed to the payee |
| `readChannel` → `{balance, totalClaimed}`, `readClosing` → `{amount, initiatedAt}`, `readRefundNonce`, `readPayee` → `{totalClaimed, totalSettled}` | the reads, each given a `call(to, data)`: the deposit and what the payee has taken; the payer leaving; a counter that moves when a refund lands; claimed and paid out per payee |
| `collectedFilter`, `collectedIsFor`, `collectedAmount` | the payout event `books` tallies |

An escrow may also provide (`defineEscrow` checks the type of each one present; x402 has none of them, and every
caller falls back to the members above):

| Member | Job |
|---|---|
| `closes` | `amount` (the default): a refund returns an amount and the channel lives on. `whole`: a close pays the payee, returns the whole remainder and ends the channel; `POST /refund` answers 409 `session_channel` |
| `ready(call)`, `payee()`, `graceSecs()` | read once what the chain alone knows (the payee in front of the seller's split, the close grace period), refusing an escrow that does not fit; the payee once read |
| `claimView(record)` | the record as a claim sees it: for an `exact` escrow, charged and signed both set to the voucher held for what was spent |
| `claimCalls(key, records, chainId, nowSecs)` → `[{what, to, data}]` | one call per record where the contract settles one channel per call |
| `prepareCalls(chain)` → `[{what, to, data}]` | what must be on chain before a claim or a payout (the payee contract), sent first in the same group |
| `openCall`, `topUpCall`, `closeCall` | open by the payer's authorization; add funds to an open channel; close under the payee's signature |
| `readState(call, channelId)` | the whole channel record, where the engine decides from chain state |
| `gas.topUp`, `gas.payout`, `gas.createPayee`, `gas.exitRequest`, `gas.exitWithdraw` | rows an escrow adds to the gas table. `Escrows.gas(cfg, escrow)` is the seller's `gas` for the default escrow and the seller's `gas` overlaid with the escrow's own for any other |

Outside the adapter: the x402 payment envelope (`payload.type` `voucher` / `deposit`, `channelConfig`,
`voucher.maxClaimableAmount`, `deposit.authorization`), the record's field names, and one gas table per seller.

## MPP session (Node)

Off unless the seller sets `sessions: { escrow, factory }`: the addresses of an `EvmPaymentChannel` escrow and of its
`SessionPayeeFactory` (repo `zeam-contracts-session`). There is no default address; the pair deployed on Base on 2026-10-13, immutable, is the escrow `0x5e09aD70b644414cD1cD7Df1d9a10fF7899D92B8` and its factory `0xE18fCE1266056becA4a3B0edfc15F8634EA6901B` (`seller/docs/SELL.md` gives the option). Without the
option the registry is the one object `ESCROWS`, and every answer is the one main gives. With it, and once
`ready` has read the chain (the factory is bound to that escrow, the escrow holds USDC, its grace period is at least
600 s), a fixed-price call's 402 carries a second `Payment` challenge in `WWW-Authenticate`, after the `charge` one
when there is one. An escrow that cannot be read is asked again after 30 s and no session is offered meanwhile.
A price by use (`unitMicro`) and a purchase of line time (`ms`) are not offered a session yet; a time tool called
without a line is priced per call, at its `callUSD`, and is. The relay takes the same two addresses
(`PASS_RELAY_SESSION_ESCROW`, `PASS_RELAY_SESSION_FACTORY`); without them it sends nothing to either.

The wire is `draft-evm-session-00`, published at https://paymentauth.org/draft-evm-session-00 and carried over `draft-httpauth-payment-01` and `draft-payment-transport-mcp-00`.

**Challenge.** `method="evm"`, `intent="session"`, HMAC-bound like the charge challenge, 300 s. `request`: `amount`
(the price of one call in base units, the same number x402 `accepts[].amount` and the charge challenge state),
`unitType: "request"`, `suggestedDeposit`, `currency`, `recipient` (the seller's `SessionPayee`, from
`factory.addressOf(settle key address, split)`: the split cannot sign or call, so the payee signs for it and forwards
all it receives to it), `methodDetails: { chainId, escrowContract, feePayer: true, credentialTypes: ["authorization",
"hash"] }`. `suggestedDeposit` is the least deposit the engine sends for the payer: max(price, ceil(gas(216,801) x
1.25 / fee share)).

**Published beside the challenge.** Every answer that carries a session challenge also carries
`session: { receiver, signer, split: { recipients, allocations, totalAllocation, distributionIncentive }, salt }`:
the split, the settle key's address, and the inputs of the split's address (allocations and the total as decimal
strings; the owner is the zero address). It is a member of the 402 body and of a session problem's body, so of the
MCP unpaid result (`structuredContent` and its text) and of `offers()`, and of
`_meta["org.paymentauth/payment-required"]`, which is the `data` of the JSON-RPC error a client that declares the
payment capability gets. It is in `PAYMENT-REQUIRED` too: the header and the 402 body are one document (about 520 more bytes of header). A payer checks it, and trusts none of it: the 0xSplits
factory's `isDeployed(split, 0x0, salt)` returns `receiver`, and `factory.addressOf(signer, receiver)` is the
challenge's `recipient`. It is what the relay asks of anyone who posts a signed exit, and the relay runs the same
two checks. No answer has the member when no session challenge is offered.

**Credential actions** (`payload.action`; `Authorization: Payment`, or MCP `_meta["org.paymentauth/credential"]`):

| Action | What the engine does |
|---|---|
| `open`, `type: "authorization"` | checks the EIP-3009 authorization (to the escrow, in its window, nonce `keccak(abi.encode(from, payee, token, salt, authorizedSigner))`, signature, balance), the channel id, the deposit against the floor, the first voucher; simulates `openWithAuthorization` by `eth_call`; sends it through the relay; then reads the channel. A channel already there (a copied call, a replay) is taken as open without sending |
| `open`, `type: "hash"` | `source` names the payer; the receipt must have status 1 and a `ChannelOpened` for that id from this escrow; then the channel is read |
| `topUp` | the same two forms (`topUpWithAuthorization`, nonce `keccak(abi.encode(channelId, additionalDeposit, from, salt))`; or a hash with a `TopUp` of that amount, and `source` naming the payer as for an open by hash: without it, 400). The record keeps the last 16 top-ups (`session.topUps`: the authorization nonce or the hash, the deposit before it was sent, whether it landed). An authorization the token marks used answers as landed only when the record has it as landed, or the channel's deposit is at least the deposit before it plus its amount; the token marks a canceled authorization the same way, and that one answers `verification-failed` and changes nothing. A top-up whose transaction reverted is `transaction-reverted` whatever the deposit shows. Least relayed top-up: ceil(gas(132,091) x 1.25 / fee share). Never runs the tool |
| `voucher` | reads the channel (it exists, pays this payee, is not finalized, has no close request), verifies the signature against the payer or its `authorizedSigner` (ECDSA 65 bytes, v 27/28, low s; ERC-1271 when the signer has code) before anything else, refuses an amount over the deposit, keeps the voucher. A `deposit` field (`open` or `topUp`, `authorization`) is carried out first |
| `close` | verifies the voucher, then sends `closeWithAuthorization` under the payee's signature at the voucher held for what was spent; reads the channel and answers only when it is finalized. A channel already finalized answers the same without a transaction |

An `open` or a `voucher` on a call pays that call: the price is reserved (`pendingRequest`, one call in flight per
channel, as for x402), the tool runs, and `spent` moves by the price only when it succeeds. A failed tool charges
nothing per call. `topUp`, `close`, any credential on `HEAD`, and any credential with MCP
`_meta["zeam-bridge/payment-only"]: true` are payment-only: 204 with `Payment-Receipt` over HTTP, a result with
empty `content` and the receipt in `_meta["org.paymentauth/receipt"]` over MCP, and the tool is not run nor its
arguments read. The MCP result carries the receipt as `structuredContent` too, `{receipt}`, and with sessions on each
tool's listed `outputSchema` admits that shape beside its own and a refusal's, so a client that checks a result
against the schema (the MCP SDK does) reads it.

**Access list.** A seller in mode `both` asks its list before a session credential does anything, as it does before
an x402 payment is verified: `open` (the authorization's `from`, or `source`), `topUp` (the channel's payer, and the
authorization's `from` when that is another address) and `voucher` (the channel's payer), on a paid call, on `HEAD`
and with `zeam-bridge/payment-only`. The credential is parsed and its challenge checked first; nothing is
sent to the relay and nothing is written before the list has answered. A payer that is not admitted gets the 403
`refused` (or the 402 `bad_grant`) an x402 payment gets, less the terms' `deposit` sentence, and its authorization is not sent. A `close` is never
asked of the list: a payer the seller no longer admits can always close its channel. The close serves no call,
settles at most what was spent, and returns the rest of the deposit.
Mode `gate` takes no `sessions` option and reads no session credential.

**Over MCP** the whole lifecycle is `tools/call` on the paid tool: the challenges arrive as `-32042` (or in the
tool result's `_meta["org.paymentauth/payment-required"]`, the same object as that error's `data`, for a client that did
not declare the capability; every challenge of the call's 402, `charge` and `session` alike), a
credential rides `params._meta`, a paid result carries the receipt, a refusal is `-32043` with a fresh challenge and
`failure.reason` `session/<type>`, a malformed credential `-32602`. To a client that declared the payment capability,
the server advertises in `capabilities.experimental.payment.methods.evm.intents` the intents its 402s carry: `session`,
and `charge` only when a tool's price per call reaches the charge floor (a seller whose every price is under it, as
Prism's are, advertises `["session"]`). Where its 402s carry neither, or the client declared none, `initialize` has no
payment capability; Python and WordPress, which have
no sessions, advertise `["charge"]` or nothing the same way. The transport draft defines no
credential-only request; `zeam-bridge/payment-only` is a `_meta` key of ours for a voucher or an open that should
buy nothing yet, and `topUp` and `close` need no key.

**Accounting** (draft 12 and 13). `acceptedCumulative` is the highest voucher (`signedMaxClaimable`), `spent` is
`chargedCumulativeAmount`, `settledOnChain` is `totalClaimed`, the deposit is `balance`. The contract settles exactly
a signed amount, so the record also keeps `session.settle` (the highest voucher at or below `spent`) and
`session.held` (vouchers above `spent`, lowest first, at most 8: the 7 lowest and the highest). A call is paid only
by the voucher it carries, and only when that voucher is for exactly `spent` + price, so every `spent` a receipt
states is an amount the seller can settle and a credential pays one call at most; a client that signs previous +
price, as the draft describes, always carries one. A voucher for less or more, a credential sent again, and a credential
that carries no voucher of its own for `spent` + price (one that leans on a voucher an earlier payment-only credential
carried) pay no call: 402 `insufficient-balance` with `requiredCumulative`. A voucher sent ahead in a payment-only
credential buys nothing then, and pays one call when a later credential carries it. The engine never settles or closes above `spent`.

One large voucher. The draft's balance check is `acceptedCumulative - spent >= cost` (13, 13.1), a procedure it
states without a MUST; it requires the voucher to be accepted (12.5), and the engine accepts it: `acceptedCumulative`
moves. It does not require the call to be served on that voucher alone, and the engine does not serve it: a client
that signs one voucher for its whole deposit and spends against it is refused from its first call, with
`requiredCumulative`, until it signs a voucher for that amount (a voucher below the highest accepted is taken and
kept). The reason is the contract, not the draft: it settles exactly a signed amount. Serving on the large voucher
alone leaves two ways to settle a payer who then stops: at the large voucher, which takes money for calls that were
not made (the draft allows it: 15.16, 15.17), or at the last voucher at or below `spent`, which may be zero. The
engine does neither.

**Receipt** on every paid answer and every payment-only answer: `method`, `intent`, `status`, `timestamp`,
`challengeId`, `reference` = `channelId`, `chainId`, `acceptedCumulative`, `spent`, `units: 1` on a paid call,
`txHash` when that answer sent or took a transaction.

**Problems** (RFC 9457, `Content-Type: application/problem+json`, with `accepts` and a fresh challenge; the same
media type on a `charge` problem; the unpaid 402 and every x402 answer stay `application/json`, and over MCP a
problem rides the JSON-RPC answer): `session/invalid-signature`, `signer-mismatch`,
`amount-exceeds-deposit`, `challenge-not-found`, `insufficient-balance` (402), `channel-not-found`,
`channel-finalized` (410; also a channel with a close request), `transaction-reverted` (409; a revert is named by
its contract error, never by selector); `malformed-credential`, `invalid-challenge` and `verification-failed`
(402; `verification-failed`: the relay declined, a call in flight, no receipt yet).

**After a send.** The engine answers an open, a top-up and a close from the channel it reads, not from the
relay's answer. It waits until its node's head reaches the receipt's block, or `stateCatchUpMs` (2000 ms). A send the
chain still does not show is 402 `verification-failed` with `code: "sent_not_shown"`, `retry_after_seconds` (2), a
`Retry-After` header and `txHash` (absent when the relay did not answer); over MCP `code`, `txHash` and
`retry_after_seconds` are members of `data.problem`. The same credential sent again is taken and is not sent to the
relay again. Each authorization is recorded before it goes to the relay, in
`<stateDir>/session-sent/<escrow>-<nonce>.json` (written whole to a temporary file, then renamed, under the lock the
channel records use): `version`, `nonce`, `escrow`, `action` (`open` or `topUp`), `channelId`, `validBefore`,
`hash`, `block`, `reverted`, `unsent`, `error`, `at`. A restart reads it, so a repeat is answered as before the
restart. It goes to the relay a second time only when its transaction reverted, or no transaction is known for it
after `stateCatchUpMs`, and the token shows the nonce unused. A record is removed when `validBefore` has passed. A
record that cannot be parsed, a record missing for a top-up the channel holds as sent, and a directory that cannot
be made are told to `onError` (`at: "session-sent"`); the engine goes on, and treats such an authorization as
handed to the relay. A close is kept on the channel record (`session.closing`: its transaction) and is sent again
only when that transaction reverted or has no receipt after `receiptTimeoutSecs`.

**Settlement.** The periodic step claims session channels as it claims x402 ones (idle 20 s, the fee share of what
moves covers the gas, at most `maxClaimsPerBatch`), one `settleWithAuthorization` per channel, each signed by the
settle key with a random nonce and a deadline 600 s after the later of the clock and the latest block. The payout
that follows is `SessionPayee.sweep`, then the split's `distribute` and the warehouse `withdraw`, in one group with
the payee's `deploy` first when it has no code. A channel whose payer asked to close on chain is seen by the same
step (`readClosing`), stamped, refused further vouchers at once, and claimed without waiting to be idle. After a
relayed call the engine reads the receipt and the channel, and books what both show (draft 12.2, 14.1). The periodic
step waits for each transaction's receipt (`receiptTimeoutSecs` for the group): a settle that reverted, or has no
receipt, is in `failed` (`channelId`, `reverted`, `why`) and not in `claimed`, its row in `calls` carries `sent`
and `error` in place of `hash`, the value reported leaves it out, and no payout is recorded for a row without a
`hash`. A channel is in `claimed` only when its `settled` on chain reached the amount sent. The record's
`totalClaimed` is only ever the chain's, so a settle that failed is due again at the next tick. An open or a top-up
whose own transaction reverted counts no deposit, whatever the channel shows afterwards.

**Leaving.** A close refunds deposit - spent to the payer. The relay pays its gas when the channel's fees cover the
gas of its open, of every top-up and close request the relay sent for it, and of its close (the rule below). When they do not, the payer signs the gas payment in USDC, taken out of what returns as an x402
refund's `gasPayment` is, and needs no ETH (the design and the routes not taken:
[design/session-gas-in-usdc.md](design/session-gas-in-usdc.md)). The relay refuses the close with
`code: "gas_payment_needed"`, and the engine answers 402 `verification-failed` with that `code` and the members of
the refund quote under [Refunds](#refunds), meaning the same: `leftMicroUSD` and `returnedMicroUSD` (what the close
returns), `gasMicroUSD` (the quote), `feeMicroUSD`, `coverMicroUSD`, `gasUnits`, `gasUnitsWithMargin`, `gasPriceWei`,
`ethUSD`, `l1FeeWei`, `marginPercent`, `quotedBy` (`relay`: its `POST /quote` for this close; `engine` when it gave
none), `payTo` (the relay's `/health` `sender`), `authorization` and `sign` (EIP-712 typed data of an EIP-3009
`TransferWithAuthorization` of `gasMicroUSD` from the payer to `payTo`, valid `gasPaymentSecs`, 300), and
`channelId`. Over MCP they are members of `data.problem`. Nothing is sent for a quote and the channel's hold is
released. The payer signs `sign` and sends the close again with `gasPayment: {authorization, signature}` in the
credential's payload. The engine checks it (from the channel's payer, to `payTo`, no more than the close returns,
valid now and for 30 s more, signed by the payer, the token shows the nonce unused, and for the value of a quote it
gave for this channel that has not expired, unless the relay's `POST /quote` for the close says the channel's fees
cover it, when the payment goes with the close and is not taken); a payment that fails a check is
answered with a fresh quote whose `detail` begins with the reason. A good one goes to the relay as one Multicall3
`aggregate3`, no call allowed to fail: the payee's `deploy` when it has no code, the close, the payment. The relay
estimates the group, prices it at the current gas price without the `deploy` (that gas is drawn against the seller's
unearned allowance, not charged to the buyer) and sends it when the payment covers the cost; under it the relay
answers `underpaid` with the cost, and the engine answers a new quote with `requoted: true` and `sendCostMicroUSD`.
The receipt of a close paid this way carries `gasMicroUSD`. When the gas is not less than what the close returns
the answer is `code: "nothing_to_return"`, `returnedMicroUSD: 0`, and nothing is sent, as for a refund; the relay
refuses a group whose payment is more than the close returns with the same code. The payer can then leave at its
own gas by `requestClose`, 15 minutes, `withdraw`.

The contract's two extensions, `requestCloseWithAuthorization` and `withdrawWithAuthorization` under the payer's
signature, are sent by the relay to anyone who posts them with the seller's split and signer. It pays their gas when
the fees of what the channel has settled cover the gas of its open, of every top-up and close request the relay sent for it, and of its exit, plus 15%; otherwise it refuses with
`code: "gas_payment_needed"` and takes them paid for by the payer. `POST /quote` with `{"call": {"to", "data"}}`, the
request, answers in the refund quote's form (`op: "refund_gas_quote"`, `shape: {"session": "exit", "payment": true}`,
`transactions: 2`, `costMicroUSD`, `quoteMicroUSD` = cost + 15%, `payTo`); a `closeWithAuthorization` or a
`withdrawWithAuthorization` in `call` is priced as that one transaction with its payment, and
`GET /quote?session=close` (or `exit`, `withdraw`) prices the shape. The payer posts two calls in one request: the
request, then a Multicall3 `aggregate3` of `withdrawWithAuthorization` and a `transferWithAuthorization` of the quote
from the payer to `payTo`, both signed up front. The payment's `validAfter` is no earlier than the end of the grace
period counted from the relay's chain time when the request reaches it, so nobody can take the payment during the
grace period: sign the chain's time when you post plus the grace period plus 30 s (`EXIT_LAND_SECS` in the audit's
signer), which the request's block falls well within. The withdrawal's deadline and the payment's `validBefore` are
at least 60 s past that `validAfter`. A payment valid earlier is refused and nothing is sent. The relay sends the
request at once, answers the second call `{"held": true, "channelId", "sendAfter", "until"}` (`sendAfter` the later
of the end of the grace period and `validAfter`; `until` the last second its transaction can land in, the
withdrawal's deadline or one second before the payment's `validBefore`, whichever is earlier), keeps it in its state
file (`exits`; at most 1000) and sends it itself once the latest block's time has reached the request's
`closeRequestedAt` plus the grace period and is past `validAfter` (`exitSweepSecs`, 30): USDC takes the payment
only in a block whose time is past `validAfter` and before `validBefore`. Until then a post of the held call answers
`held` again; a held call whose `until` the latest block has reached is dropped, since no later block can take it.
A paid close or paid refund whose payment the next block could not take (the chain's time not yet past
`validAfter`, or `validBefore` not more than a second ahead), and a paid withdrawal past its grace period whose
payment's `validBefore` is not more than a second ahead, are refused with both times and nothing is sent; one not yet
valid says `retry in <n>s` and carries `retry_after_seconds`. Before it holds a call or
sends its request, the relay checks the withdrawal's signature and the payment's signature against the channel's
payer (strict ECDSA, or ERC-1271 for a contract payer) and that neither nonce is used; a call that fails is refused
and nothing is sent. The same held call posted again changes nothing before the grace period ends and is sent after
it, once: the relay keys each withdrawal and close by its authorization, and a post of one it is sending or has sent
answers that send's hash, or its error, and broadcasts nothing. That record is read before anything else is checked,
so a post after the send has landed, when the channel reads closed, answers the same; the relay keeps it for a day. A different withdrawal and payment that pass the same checks and pay what is then owed replace the held one;
nothing else does. A withdrawal whose grace period has passed is sent at once with its payment, when the payment is
valid by then; otherwise it is held until it is. The relay has paid
for the request before it is paid: that gas is drawn against the seller's unearned allowance and kept as owed for
the channel (`owed` in the state file; `requestMicroUSD` in a later quote), one request is sent per channel, and
whoever pays for a later withdrawal or close of that channel pays for the request too. The allowance is released
when that payment lands, when a close the fees cover lands, and when the relay finds the channel closed by its
seller. The held call is dropped, with no payment taken, when the channel was closed by its seller, when what is
left after a settle is under the payment, when its authorizations have expired, when the payer's own top-up canceled
a close request the relay paid for (a strike), when the token logged the payer's cancellation of the payment (a
strike) and when the token shows the payment used with no such log (no strike). The relay reads the settle rule
again just before it sends: its sender sends one transaction at a time and a held withdrawal never rides in a batch,
so every transaction the relay sent before it, a settle among them, is mined first; then the relay reads the
channel at the latest block and sends only when `deposit` less `settled` is not under the payment. A paid close or
withdrawal sent at once is read the same way (`nothing_to_return` when it fails). The chain has no way to make the
send itself revert on it: the escrow's withdrawal takes no minimum and Multicall3 compares nothing. What is left is
a settle sent by another sender that lands after the block the relay read and before its own transaction, about one
Base block. A held withdrawal that would cost more than its payment waits for the gas price to fall, until its
deadline. A paid close or exit is refused for a payer with two strikes in 24 hours.

The relay takes no gas payment from a channel whose fees cover the gas. A paid close or withdrawal of such a channel
is sent without its payment leg and answered `gasPayment: "not_taken"`; a held one is held and sent the same way. The
engine puts `gasMicroUSD` in a close's receipt only when the token shows the payment used. A session quote that
names a channel (`call`, or `{"session", "channel", "cumulativeAmount"}`) carries `covered`, by the fee share of the
`split` posted with it, or by the least share (`feeSharePpm` 99900) when none is. The engine refuses a `gasPayment`
whose signature is over 4096 bytes before it reads the chain.

Gas already paid for the channel is added to the gas side of both comparisons, by the rule of
[Refunds](#refunds): every top-up the relay sent (`topUp` gas each) and every exit leg it sent earlier
(`exitRequest`, `exitWithdraw`). With f the fee address's share of the seller's split (0.0999 for most sellers, 1
for one whose split pays the fee address everything), a close is free when ⌊(settled + what the close settles) × f⌋
micro-USD ≥ ⌈(open + close + already paid) gas × 1.15⌉ micro-USD at the gas price read then; a
`requestCloseWithAuthorization` when ⌊settled × f⌋ ≥ ⌈(open + exitRequest + exitWithdraw + already paid) gas × 1.15⌉;
the `withdrawWithAuthorization` that follows at the same total, its request now among the gas already paid, and at
⌈(open + exitWithdraw + already paid) gas × 1.15⌉ when the payer sent the request itself. A request the relay sent
free fixes the answer for its withdrawal: the relay keeps the request's `closeRequestedAt` for the channel
(`freeExits` in the state file: the time of the block that mined the request, read from its receipt, and read again
at the next quote, withdrawal or sweep while the RPC cannot answer it yet), and while the channel shows that request the withdrawal is free and a quote for it
says `covered: true`, whatever gas the relay pays for the channel after the request (a top-up by another address
during the grace period, which leaves the request standing). The relay keeps the
figures per channel in its state file and answers them at `GET /paid?channel=<id>` (`deposits`: opens and top-ups
it sent; `refundGasUnits`: the closes, close requests and withdrawals whose gas it paid, whether sent free, sent free
although a gas payment was posted with them (`gasPayment: not_taken`), or held and sent by its sweep, and not one
whose gas payment it took; `settleGasUnits`: the settles it sent for the channel, each paid for by the fee on what it
settled and so left out of `gasUnits`; `gasUnits`: top-ups and exits). The engine does not judge a close; it writes
`depositsWePaid` on the record for a relayed open and for each relayed top-up, once each, and a deposit the payer
sent by its own transaction counts nothing.

**Departures from the draft, each on the side of the payer's money or stated by the task.** Payment-only answers are
204 where the draft's diagrams show 200. `spent` is committed after delivery, not before (a crash mid-call charges
nothing). One call is in flight per channel. A close is carried out at the voucher held for `spent`, not at the
close voucher when that is higher. A voucher below the highest accepted is kept when it lies above `spent`. A call
is not served on one large voucher alone (Accounting, above). Not
built: `permit2` credentials, `Idempotency-Key`, the SSE `payment-need-voucher` event, `minVoucherDelta` (0).

## Request flow

1. Validate the arguments against the tool's `inputSchema`. Bad arguments: 400, nothing held. Except a probe: no
   payment, no line credential on a time tool, and no arguments (no body, a blank body, `{}`; MCP `arguments`
   absent, null or `{}`) to a paid tool answers the unpaid 402 of step 2, nothing run (a price that cannot be read
   for it: the 400).
2. By mode:
   - **paywall:** no payment → 402 from `paymentRequired`, with the x402 `bazaar` discovery extension
     (`Bazaar`: `extensions.bazaar`, HTTP or MCP form, the tool's `inputSchema` with an example body built from it,
     its `outputSchema` or "any JSON"); `PAYMENT-REQUIRED` leaves it out when it is over 4,096 bytes or the header
     over 12,288, and the body keeps it. Else `verifyAndHold`, run the tool, then `settle` on
     success (PAYMENT-RESPONSE / MCP `_meta["x402/payment-response"]`) or `release` on failure. A failed settle
     delivers nothing.
     The 402 also carries `WWW-Authenticate: Payment` (MPP: method `evm`, intent `charge`, a random `opaque` so no two challenges share an id) when the price is fixed
     per call and price × fee share ≥ the gas of one transfer × 1.15. A credential in `Authorization`,
     `Payment-Authorization` or MCP `_meta["org.paymentauth/credential"]`: `mppHold` (challenge bound to this
     seller's key, signature, balance, the token's `authorizationState`), run the tool, then `mppSettle`: one
     `transferWithAuthorization` to the split through the relay, delivered only when its receipt carries
     `AuthorizationUsed` for that payer and nonce (`Payment-Receipt` / MCP `_meta["org.paymentauth/receipt"]`).
     The hold on the authorization (Node and Python: `<stateDir>/mpp-held/`, WordPress: the `held` table) records
     the transaction it was sent in and its state (`sending`, `sent`, `taken`, `delivered`), each step taken only from
     the step before it under the hold's lock. No receipt in `receiptTimeoutSecs` is 402 `verification-failed` with
     `code: "sent_not_shown"`, `txHash`, `retry_after_seconds` (2) and `Retry-After`; the hold is kept. The same
     credential sent again is not sent to the relay: once the receipt carries `AuthorizationUsed`, one request takes
     it, runs the tool and is delivered (a copy at the same time is told `this authorization is already in use`, one
     after it `this authorization has already been used`; a tool that fails gives it back); once the receipt shows
     a revert and the token shows the authorization unused, the answer says nothing was charged and the hold is
     released, so the credential can be paid again; with no receipt yet it is `sent_not_shown` again. A hold left
     `sending` by a process that stopped is read again after twice `receiptTimeoutSecs` plus 60 s.
     Never for `buy_time` or a unit-metered price.
   - **gate:** `Admission.admit` with PAYMENT-SIGNATURE and `x-grant`, then `Meter.charge`, then run. The proof is a
     zero-value `exact` payment signed by the agent's key: nothing is paid, the key needs no funds, nothing goes on
     chain. A 402 refusal carries the zero-amount terms (PAYMENT-REQUIRED with `error`; `how` in the body). A key not
     admitted: 403. Meter out of checks: 503 `gate_credit_exhausted`.
   - **both:** the paywall payer (payerAuthorizer, else payer) must be admitted before anything is held; paid calls
     are not gate checks. The unpaid 402 adds an `admission` field. A payer not admitted: 403 `refused` with `how`.
     An answer through a grant carries `X-Pass-Granted-By: <admitting key's address>` (MCP:
     `_meta["zeam-pass/granted-by"]`), in gate mode too.

Prices: a tool's own `price`/`unit`, else the seller's `prices[tool]` (or `prices(tool, args)`), else `price`. The
402's `accepts[].amount` and `pricing` are the call's; `prices` tags every tool (`tools/list`
`_meta["zeam-pass/price"]`, OpenAPI `x-price`). The Node engine's `priceList: 'tool'` makes `prices` the called tool's
tag alone and adds `priceList: { mcp, openapi, how }`, where the rest are; its `listPage` pages `tools/list` by cursor. Free tools skip payment and admission; `freeLimit` counts calls per
(tool, client address, clock hour), 429 `free_limit` over it; the count lives in `<stateDir>/free.json` (Node, Python)
or WordPress transients, so it survives a restart; a host that passes no client address gives one shared count. Usage: the voucher signs charged + reserve; the tool
reports whole units; settle commits min(reserve, units × unit). Every settle states `extra.chargedAmount` and `extra.reservedAmount`.
Every 402, in all three engines, carries `split: { receiver, split, salt }`, what the relay is sent with each request;
the Pass service pays a deposit's gas only when the 0xSplits factory's `isDeployed(split, 0x0, salt)` returns `receiver`
and the split pays the fee address at least 9.99%.
No units reported: released, 500 `tool_failed`. Shared: `wordpress/tests/pricing/fixtures.json`.

Time (`time: {usd, ms, idleMs}`: that many dollars buys that many milliseconds, reduced to the rate `rateMicro` per `rateMs`; `maxMs` only if the seller limits one purchase; paywall or both): a clock per channel in `meter/clocks/<channelId>`
(`balanceMs`, `spentMs`, `returnedMs`, `on`, `since`, `lastActive`, `calls`, `credited`, `nonces`, `lines`), line
credentials by sha256 in `meter/lines/`. A call that its process never ended: Node and Python record the process on
each open call (`by`) and write `meter/alive/<process>` every 1000 ms while a call is in flight; a call whose
process's mark is over 30 s old (the age at which the file store takes a lock holder for dead) is ended at that mark,
or at its own start if later, the next time its clock is read, so a crash or restart bills what ran before the last
mark, not the time to the deadline. WordPress ends a call cut off by a fatal error or a time limit in a shutdown
function, at that moment; a PHP worker killed outright still leaves its call open to its deadline. `buy_time {ms}` is priced ms / rateMs × rateMicro and credits those ms once per hold (a legacy `{blocks}` counts `ms` each),
only after the settle returns ok: a deposit that verifies and then fails on chain credits no time, so it leaves nothing
usable and extends no running call. The settle writes the ms into the channel record in the write that charges the
payment (`timeOwed`, the ms keyed by the hold), so a purchase whose time cannot be written is not charged (402
`settle_failed`). The clock then credits it; a clock that cannot be written at that moment loses nothing: every clock
write first credits each `timeOwed` entry once by its key, `status` and the unburned time that claims and refunds use
count it, and an entry leaves the channel record once the clock holds it. Such a purchase is answered 200 with the
time it bought, and the next clock write (a retry, a line step or call, a refund) credits it. A line: a nonce (300 s, one attempt) signed EIP-191 over `ZEAM Pass line\nchannel:
<id>\nnonce: <nonce>` by the payer or payerAuthorizer. Prove switches the meter on (`on`) only when the clock's `lines` is
empty, a channel's first line or the first after every line was closed or a refund closed them; with a line open it
leaves `on` as it is, so only `on` and `off` switch a channel that has lines, and the `opened` answer's `metering` is
the clock's `on`. A prove that would switch the meter on takes the channel's refund serializer, as `on` does (on
WordPress, the channel's lock and its refund mark): while a refund is settling it answers 402 `refund_settling`, and
while one is being worked out 402 `refund_pending`, and it opens nothing (its nonce is spent). Burn = the union of the calls' true intervals (each to its deadline =
start + what is left) and `idleMs` after the last activity, while on. A call's true interval runs from its start being
written to its handler returning (`end` gets both); the store's time before and after is not burned, for one call or
for many at once. To do that the record holds the last 2000 ms provisionally: finished intervals wait in `done` and
running calls count up to now, and time is made final (`spentMs`, `since`) only once it is 2000 ms old. At most `maxCalls` calls (`time.maxCalls`, validated 1..1000, default `Clock.MAX_LIVE_CALLS` = 1000) are live on a line at once; the next is refused `too_many_calls` (429) and a seller lowers it to bound concurrency. `remaining`,
`spent` and refunds always include the provisional part. A call that runs longer than the hold is billed its run time
plus at most its own start write. Claims, payouts and refunds use earned = max(charged −
ceil(unburned ms × rateMicro / rateMs), claimed); a refund switches the meter off first, is refused while a line call
runs (`request_open`), and zeroes the clock and closes its lines once sent or handed over. A time tool without a
line: a paid call bounded to price × rateMs / rateMicro ms. Its 402's `pricing` states both prices and what a failed call costs on each, from the price and the rate (Node `pricing`, Python `pricing`, PHP `Pricing::pricing`, given the price with `rateMicro` and `rateMs`): `$0.00025 per call of up to 250 ms without a line; $0.000001 per ms on a line. A failed call without a line is not charged; on a line a call burns the time it runs, failed or not.` A tool priced per call or per unit, and `buy_time`, keep their own sentences. A cut (the caller hangs up, or sends MCP
`notifications/cancelled` for the call's id with its line credential or on the `Mcp-Session-Id` it was sent on, never by
address) ends the call's interval at the cut and answers 499 `client_gone`; a call priced per call is released, not
charged. Node and Python hold live calls in memory and stop the handler's wait (Node `signal`, the hang-up being the
host's `signal` passed beside the request, else `request.signal`; Python
`stopped()`; ASGI `http.disconnect` is the hang-up, WSGI has none). WordPress keeps live MCP calls in the meter table
(`call:` records: the hashed line and session, the channel and the call's start): the cancel's request ends the
interval at once, the call's own request ends it again for nothing, and PHP learns of a hang-up only when it writes,
so a hang-up there is billed to the tool's return. Shared: `wordpress/tests/meter/fixtures.json` (`cut`).

Bad arguments or a non-JSON body: 400 `invalid_arguments` in every engine. A result that is not valid JSON (a
non-finite number, non-UTF-8 bytes, a value the encoder changes or drops) is a failed call: hold released, 500
`tool_failed`, the same message in every engine.

A failed call answers over HTTP with every field the failure carries over MCP (Node and Python: the result's
`structuredContent`; WordPress: the `WP_Error`'s code, message and data), `error`, `tool` and `message` added where
it has none. A failure that carries a `status` of 400 to 599, other than 402, is a refusal the tool marks as the
caller's: HTTP answers that status, with `Retry-After` when it carries `retry_after_seconds`; any other failure is
500. Paid or free, it is not charged per call; on a line it has used the time it ran.

A seller's `contact` (an `https://` URL or a `mailto:` address; WordPress defaults to the site's address) goes in
the 402 an unpaid call gets (body and PAYMENT-REQUIRED), in the 403 `refused` body and its `how`, and in
`openapi.json` as `info.contact`; other refusals, the 402s of a line or a refund among them, do not carry it. Unset:
none of these change.

## Refunds

Our relay pays the gas of a refund when our fee on what the buyer spent covers the gas of the deposit, of the refund and of settling any calls not yet settled, and of every further deposit and every earlier refund it paid for on that channel, with a 15% margin; otherwise the buyer pays the refund's gas, with a 15% margin, in USDC, quoted before the buyer signs that payment.

- Proof: payer-signed; always sent through the relay.
- In numbers, free when ⌊(on-chain claimed + bundled claim) × 0.0999⌋ micro-USD ≥ ⌈(deposit + refund + riding claim) gas ×
  1.15⌉ micro-USD, both at the gas price read for the refund. The relay applies the same comparison.
- Gas already paid for the channel is added to that gas, inside the × 1.15: the larger of the record's
  (`depositsWePaid` − 1) × deposit + `refundGasWePaid` and the `gasUnits` the relay answers at `GET /paid?channel=<id>`,
  which also counts deposits the Pass service sent at its own gas. No answer from the relay: the record alone.
- Otherwise 409 `refund_quote` (`gas_payment_needed`, with `feeMicroUSD`, `coverMicroUSD`, `gasUnits`,
  `gasUnitsWithMargin`, `l1FeeWei`, `gasPriceWei`, `ethUSD`, `marginPercent`, `quotedBy`): an EIP-3009
  `TransferWithAuthorization` of the quoted gas in the channel's token.
- Quote: the engine signs the refund and posts it to the relay's `POST /quote` (`{call: {to, data}, payment: true}`).
  The relay answers the gas the refund uses (`eth_simulateV1` from its sender; `eth_estimateGas` where the RPC lacks
  it, which over-reads a refund of the whole balance by its storage refund) + the gas a payment adds over that (median
  of its paid refunds, kept apart for simulated and estimated legs), Base's L1 data fee, gas and ETH price, `costMicroUSD` and `quoteMicroUSD` (cost × 1.15). The engine
  quotes `quoteMicroUSD` and checks the payment against `costMicroUSD` (`quotedBy: "relay"`). No valid relay quote:
  (refund + riding claim + payment + L1 fee in gas) × 1.15 (`quotedBy: "engine"`).
- Payment: to the relay's gas wallet (its `/health` `sender`), valid 300 s, posted back as `gasPayment`. Checks:
  from the payer; to that wallet; ≥ the send cost now (the quote's cost, no margin); ≤ the refund; in its window;
  signed by the payer. Sent as one Multicall3 `aggregate3`: the refund (or the escrow multicall of claim and
  refund), then the payment, neither allowed to fail.
- The relay sends when the payment covers the cost of that send: its `eth_estimateGas` + L1 data fee
  (`GasPriceOracle.getL1Fee`) at the current gas and ETH price. Else `code: "underpaid"` with that cost as
  `gasMicroUSD`; the engine answers a new 409 `refund_quote` (`requoted: true`, `sendCostMicroUSD`) for max(its
  fresh quote, cost × 1.15), with new typed data. Nothing is sent.
- Gas ≥ balance: `nothing_to_return` (`leftMicroUSD` stays in the channel, `returnedMicroUSD` 0).
- `selfSend: true`: a signed handover of the full balance, reserved and re-issued while the refund nonce is unchanged.
- A channel with no record (funded, no calls) is adopted from the `channelConfig` the payer sends when it hashes to
  the id, names this receiver and `receiverAuthorizer`, and holds a balance on chain. A config that fails a check is
  400 `channel_config_mismatch` for any channel, with `mismatch` = `fields`, `channelId`, `receiver`,
  `receiverAuthorizer` or `token`.
- The gas payment's typed data is `transferAuthorizationTypedData`, the same bytes in every engine
  (`wordpress/tests/vectors.json`).
- Serializer: every step that reads a channel's state and then changes it runs inside one critical section per
  channel: a refund's arrival, the result of its first chain read, its turn to be judged, its decision (refuse, judge
  again, or write the sending mark) and the end of its send; a paid call's reservation and its charge; line `on`,
  `off` and `close`; a line call's admission; and, in Node, every MPP session record change. Node uses a
  promise-chain mutex per channel id (`Channels.serial`), Python a `threading.Lock` per channel, WordPress the
  channel's database lock (`GET_LOCK`), held by a refund from its arrival (its proof is checked inside it) to its
  sending mark. Chain reads and relay
  sends never run inside the section in Node and Python: they run under a flag the section sets (requests arriving,
  refunds held, the one being judged, the sending mark in the record), and a request that must wait is woken when a
  flag changes and decides again inside the section, so no request answers from a snapshot taken before another
  request changed the channel. A paid call's voucher is verified against the channel's record before the section;
  inside it the call is reserved only if that record has not moved since (its refund nonce, its balance, an unsent
  signed refund). If it has, the call is verified again on the record as it now is, so a call verified before a
  refund landed is judged on the channel the refund left (402 `payment_invalid` with that `channelState`), never
  served against money the refund returned. Refunds on a channel are judged one at a time, in the order they reached
  the refund handler: in Node and Python each request takes a place in the channel's order before its proof is
  checked, and no request is judged or given a kept answer while one that arrived before it is still being checked,
  reading the chain or waiting for its turn; in WordPress each request takes a numbered ticket before its proof is
  checked, written one at a time under the channel's ticket lock, and waits for every earlier live ticket on its
  channel. A request that arrives while a refund that arrived first is still being checked is answered after it
  (`refund_settling` once that refund is sent). The place is the request's turn: counted per channel from 1, it
  starts again only after `TURN_KEPT_MS` (ten minutes) with no refund request on the channel, never while one holds a
  place, and on a Node or Python restart (WordPress keeps the count in its `turns` table). Every answer the refund
  route gives for the channel carries it, as `turn` last in the body and in the `Zeam-Refund-Turn` header (exposed
  to browsers), so the order a seller judged in can be read from its answers. The relay send always runs after the
  section, under the sending mark.

## Constants

| Name | Value |
|---|---|
| Fee share | 0.0999 (the seller keeps 90.01%); 1 with `payoutIsFeeRecipient` |
| Relay rule | sends only for an owner-less split paying the ZEAM fee address ≥ 99900 of 1000000, no distribution incentive; break-even at that split's fee share |
| Split | 900100 seller / 99900 ZEAM |
| Deposit floor | max(price, ceil(gas(145,000) × 1.25 / 0.0999), ceil(the gas of a paid refund × 1.25)), from `eth_gasPrice` and the relay's `/health` `wethUSD`; it never falls as the price rises |
| Gas estimates | deposit 145k; claim 35k + 45k per voucher; payout 210k per asset (settle 60k, distribute 90k, withdraw 60k) + 280k when the split is created; refund 118k (the row below; 97k as the refund leg of a paid refund, `paidRefundLeg`); a claim riding a refund 37k (37.7k in a paid refund); Multicall3 wrapping + `transferWithAuthorization` of a gas payment 58.6k; L1 data fee of a paid refund, in gas at the measured gas price, 13.8k, + 4.2k with a riding claim. The refund-payment units apply only when the relay's `/quote` does not answer |
| Refund gas, measured | calibrated 2026-09-29 from the receipts of the relay's 35 paid refunds (`0xB3ED726D24AF7C3ffbf04219A78506170155641b` to Multicall3, Base blocks 51915440 to 51949669; `seller/test/fixtures/paid-refunds-2026-09-29.json`). Refund + payment, 25 sends of 1,252 bytes: 155,101–156,013 gas (median 155,625). With a riding claim, 10 sends of 2,212 bytes: 193,256–194,092 (median 193,332). `eth_estimateGas` of the refund leg alone at each parent block: medians 96,187 and 133,294; a payment adds 59,430 and 60,035. The refund leg's gasUsed by `eth_simulateV1` (71 paid refunds to block 51957700, 3 of them whole-balance refunds from the audit of 2026-09-29, where `eth_estimateGas` reads 100,136 for a leg that uses 94,690): a payment adds 60,367–60,411 (60,391) alone and 61,111–61,155 (61,135) with a claim, the relay's `paymentOverUsed` defaults; its POSTed quotes come to 1.15–1.18 × the send cost on all 38 fixture receipts. L1 data fee: 8% of the cost (medians 13,830 and 18,059 gas at each send's gas price). The relay keeps its own medians from its receipts; engines and relay keep the calibration as `GAS_MEASURED` beside `GAS` |
| Refund gas, a payer holding nothing | gas 118k (`refund` in every engine's gas table and the relay's), measured on a Base fork on 2026-10-22 (`REFUND_GAS_MEASURED` in the relay): a `refundWithSignature` to a payer that deposited all it held writes the payer's USDC balance slot from zero and needs 117,421 gas (`eth_estimateGas`), using 111,802; after a claim it needs 113,529 and uses 112,710, and with a riding claim 151,022 and 150,085. To a payer that still holds USDC it needs 99,774 and uses 94,702 (after a claim 95,882 and 95,610; with a riding claim 133,071 and 132,961). The refund is priced for the payer holding nothing, and the relay sends a free refund with 118,000 × 1.15 = 135,700 gas (97k sent 111,550, so such a refund reverted in the relay's dry run and was not sent free). The relay's break-even and every engine's refund cover count ceil((145,000 + 118,000 + 37,000 per riding claim + the gas ZEAM already paid on the channel) × 1.15). A paid refund keeps its own calibration, `paidRefundLeg` 97,000, from the relay's real paid refunds (the row above), so its table quote stays 1.10–1.25 × what those sends cost. On the same fork a paid refund (refund, then the payer's gas payment, in one Multicall3) to a payer holding nothing needs 173,571 (`eth_estimateGas`), and 211,216 with a riding claim, against 156,447 and 194,104 for a payer that still holds USDC; the relay prices each paid refund it sends by `eth_estimateGas` of the whole transaction and sends it with a gas limit that counts the refund at 118,000 and the payment at 58,600, × 1.15. A seller's first claim riding a refund also writes the seller's claimed total from zero (168,098 `eth_estimateGas`, over the 155,000 a refund and its riding claim are priced at); the relay sends a riding claim inside the claim's own gas (35k + 45k per voucher) as well, so it is sent |
| MPP charge | gas 105k (`charge` in every engine's gas table and the relay's), measured on a Base fork on 2026-10-22: a USDC `transferWithAuthorization` to a split that has never held USDC writes its balance slot from zero and needs 104,365 gas (`eth_estimateGas`), using 103,264; to a split that holds USDC it needs 86,982 and uses 86,152. A 402 is priced before the buyer signs and cannot know which split it pays, so the charge is priced for the fresh one, and the relay sends it with 105,000 × 1.15 = 120,750 gas (80k sent 92,000, and a new seller's first charge reverted in the relay's dry run); offered when price ≥ ceil(gas(105,000 × 1.15) / fee share), judged at each 402 on `eth_gasPrice` read at most 5 s before (`GasQuote.RECENT_SECS`); when that read fails, on the last gas price the engine read while it is under 60 s old (`GasQuote.QUOTE_TTL`), with the 1.15 still applied; a 402 with no gas price under 60 s old offers no charge, over HTTP and MCP alike. The relay judges a charge on the lowest gas price it read in the last 90 s (`CHARGE_GAS_SECS`: the 60 s an engine may price on, the 20 s the relay may spend asking its node again, and 10 s for the payer to sign and post), reading `eth_gasPrice` every 2 s to keep those prices, so a charge a 402 offered on a price from the same node in that time is not refused as below break-even |
| A node that does not answer | Engines: a failed `eth_gasPrice` is tried again 0.25 s later, the wait doubling to 4 s, for 20 s from the first failure (`GasQuote.RETRY_SECS`); the schedule is kept in the engine's cache, so every request and process shares it. Until a retry is due, a gas figure that has a price under 60 s old to stand on uses it without asking the node; one without asks the node, as it does when the node answers. Every gas figure an engine states falls back the same way (charge floor, refund cover and refund gas); the deposit floor with no price under 60 s old keeps the last floor it stated. The relay: a read that meets a refused connection, a reset or a timeout is asked again 0.25 s later, the wait doubling to 4 s, for up to 20 s; a send the node does not answer (a refused connection, a reset or a timeout) is sent again as the same signed transaction, the same hash, on the same schedule; a node that already took it says so, and that answer, like any other error from the node, is looked up by its hash for 6 s, as before. The relay has one node and never sends to another |
| MPP session gas, measured | 2026-10-12, forge snapshot of `zeam-contracts-session` a6d54d1 on a Base fork: open by authorization 216,801; top-up 132,091; relayed settle to the payee 131,113; relayed close 144,577; signed exit 84,615 + 115,531; payee deploy 369,567; payout 355,604 (sweep 72,311, distribute 199,230, withdraw 84,063). Engine `SESSION_GAS`, relay `SESSION_GAS`; a seller overrides rows with `sessions.gas` |
| Buffer | 1.15 |
| `stateCatchUpMs` | 2000: how long an answer waits for the engine's node to show a transaction whose receipt it has (a deposit, a session open, top-up or close) |
| `refundJudgeWaitMs` | 5000: how long a paid call waits for the answer to a refund being worked out on its channel before it goes on (a refund judged meanwhile then checks the channel again and never returns what that call spends); how long a line `on`, a `prove` that would open a channel's first line and a line call wait for a refund's first chain read; and how long a refund request that arrived after four still being worked out on its channel waits for a place (counted by arrival, so a later request never takes an earlier one's place), answered meanwhile from the channel's record without reading the chain (`refund_settling` while a refund is being sent, the kept answer to its request while no other request holds the channel, `request_open` while a call is open), then 503 `refund_unavailable` with `retry_after_seconds` 1. A refund holds its channel from its verified proof, in the order refunds arrived (the serializer, under [Refunds](#refunds)): its first chain read is shared by the requests that arrive with it, and while that read runs a line `on`, a line call and a paid call wait for it. A channel that holds nothing ends the request there with `nothing_to_return` and the meter as it was. One that holds a balance stays held until every request whose read showed it is answered (each entry lapses after 30 s, so a request that stopped holds nothing longer): the line's meter is switched off before the amount is worked out (`request_open` if a call is running on the line) and stays off whatever the answer; a line `on` is told 402 `refund_pending` and changes nothing, a line call is told `meter_off`, and a paid call waits. A refused refund (`nothing_to_return`, a gas quote, a gas payment that fails a check, `request_open`) lets `on` work again; if the channel moved while it was judged it is judged again (up to three times), so a quote never counts what a call spent. A refund that will be sent (a gas payment that passes every check, channel fees that cover the gas, or `selfSend`) checks the channel again and writes its sending mark in the same step; from then until the send is resolved a paid call, a line `on`, a line call and every other refund request are told `refund_settling` at once (a refund `nothing_to_return` if the chain shows the channel empty). A refused refund's answer is kept in the record (`refundVerdict`) for 5 s with the channel and its line as they were; a refund with the same request on a channel and line unchanged since, while no other request holds the channel, is given it without reading the chain. WordPress takes the channel's database lock for the same steps instead, so a paid call, a line `on` and a line call that arrive while a refund is judged wait for the lock (up to 15 s) and are answered as the channel is when it is let go (a paid call that reaches a PHP worker only after the refund was sent finds the channel refunded and is answered 402 `payment_invalid` with its `channelState`), and it does not wait for a place: a request beyond the four is answered from the record at once (`nothing_to_return` when the record shows the channel empty and one read of the chain agrees), a waiting request holds a PHP worker, Apache's KeepAlive holds a worker idle after each answer (the image `wordpress/Dockerfile` builds turns it off), and on WordPress every request of a burst takes one of the site's PHP workers while WordPress loads and answers it, so until the burst is answered every other request to the site, on any channel or page, waits for a free worker. In Node and Python a burst of refunds on a channel does not slow the seller's other channels |
| Relay strikes | two reverts the payer caused (an authorization it canceled, or more than it held) in 24 h. The relay then answers 402 `deposits for this payer are paused until <ISO time>: two of its authorizations reverted on chain in 24h (canceled, or more than it held). It can send its own; retry in <n>s` (`charges for this payer …` for a charge), with `retry_after_seconds` |
| Idle before claiming | 20 s |
| Hold lifetime | the payment's maxTimeoutSeconds (240) |
| ZEAM fee address | `0xc60996007B7657DE2F39fA0577E97d7aAF3b7d1e`, set in each engine; no option or setting changes it |
| Credit issuer | `0x4202d8042d89cbEFD9D48fE7f7Aa70061CC9Df22`, set in each engine; no option or setting changes it |
| Relay | `https://api.zeampass.com/relay` |
| Credit service | `https://api.zeampass.com/credits` |
| Gate credit | Gate mode: 2,000 checks at a time for $1 USDC ($0.50 per 1,000), bought after the month's 10,000 free checks are used and again below 200 remaining. Keep $1 USDC on Base in the credit wallet. `both` mode needs no USDC in the credit wallet: paid calls are not gate checks. |

## Shared fixtures

- `wordpress/tests/vectors.json`: crypto, typed data, ABI, channel ids, splits, grants and notes.
- `wordpress/tests/settlement/fixtures.json`: SDK client payloads with the SDK server's verdicts and responses.
- `wordpress/tests/gate/fixtures.json`: admission, grants, notes and credit purchase.
- `wordpress/tests/pricing/fixtures.json`: prices, usage charges, price tags, the pricing text and the free limit.
- `wordpress/tests/meter/fixtures.json`: the clock (buy, switch, begin, end, idle, unburned, forget), time options,
  the `time` terms text and the line message.
- `wordpress/tests/mpp-vectors.json`: MPP challenge ids, headers, credentials, the EVM charge check and its refusals,
  receipts and the MCP forms.
- `wordpress/tests/floor/fixtures.json`: the deposit floor and the 402 lines that state it, with the gas quote present,
  absent and failing. Node and Python read it over a socket with their own HTTP client, from an edge that refuses the
  User-Agents the default RPC refuses; PHP reads it through its transport.
- `wordpress/tests/discovery/fixtures.json`: the OpenAPI document's `x-payment-info` (price, protocols, the MPP offers),
  `security`, `x-guidance`, the 402 description where there is an offer, and the document for the origin root.

Every engine passes all eight.
