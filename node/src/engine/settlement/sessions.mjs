import { randomBytes } from 'node:crypto'
import { Abi } from '../core/abi.mjs'
import { Address, Hex, InvalidArgument, isNumeric, isObject } from '../core/hex.mjs'
import { Multicall3, Token } from '../core/evm.mjs'
import { Secp256k1 } from '../core/secp256k1.mjs'
import { EvmSession } from '../core/session.mjs'
import { Channels } from './channels.mjs'
import { Base64Url, Challenge, Credential, MppError, Receipt } from './mpp.mjs'
import { GasQuote } from './relay.mjs'
import { SessionBook } from './session.mjs'
import { usd } from '../pricing.mjs'

const CORE = 'https://paymentauth.org/problems/'
const SESSION = `${CORE}session/`
const UINT = /^(0|[1-9]\d*)$/
const ACTIONS = ['open', 'topUp', 'voucher', 'close']
const KINDS = Object.freeze({
  'invalid-signature': [SESSION, 402, 'Invalid Signature'],
  'signer-mismatch': [SESSION, 402, 'Signer Mismatch'],
  'amount-exceeds-deposit': [SESSION, 402, 'Amount Exceeds Deposit'],
  'delta-too-small': [SESSION, 402, 'Delta Too Small'],
  'channel-not-found': [SESSION, 410, 'Channel Not Found'],
  'channel-finalized': [SESSION, 410, 'Channel Finalized'],
  'challenge-not-found': [SESSION, 402, 'Challenge Not Found'],
  'insufficient-balance': [SESSION, 402, 'Insufficient Balance'],
  'transaction-reverted': [SESSION, 409, 'Transaction Reverted'],
  'malformed-credential': [CORE, 402, 'Malformed Credential'],
  'invalid-challenge': [CORE, 402, 'Invalid Challenge'],
  'verification-failed': [CORE, 402, 'Verification Failed'],
})
const REVERTS = Object.freeze({ AmountExceedsDeposit: 'amount-exceeds-deposit', ChannelNotFound: 'channel-not-found', ChannelFinalized: 'channel-finalized', InvalidSignature: 'invalid-signature', TransferFailed: 'insufficient-balance' })
const lower = (v) => String(v ?? '').toLowerCase()
const message = (e) => String(e?.message ?? e)
const big = (v) => BigInt(String(v))
const SENT = 'zeam_pass_session_sent_'

export class SessionProblem extends Error {
  constructor(type, detail, more = {}) {
    super(detail)
    this.type = type
    this.detail = detail
    this.more = more
  }

  get status() {
    return KINDS[this.type][1]
  }

  body() {
    const [base, status, title] = KINDS[this.type]
    return { type: base + this.type, title, status, detail: String(this.detail), ...this.more }
  }
}

class Unadmitted extends Error {
  constructor(answer) {
    super(String(answer?.why ?? 'not admitted'))
    this.answer = answer
  }
}

const problem = (type, detail, more = {}) => new SessionProblem(type, detail, more)
const malformed = (detail) => problem('malformed-credential', detail)
const percent = (share) => (Number(share) * 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')

export class Sessions {
  static METHOD = 'evm'
  static INTENT = 'session'
  static TTL_SECS = 300
  static PAYMENT_ONLY = 'zeam-bridge/payment-only'
  static RETRY_MS = 30000
  static CATCH_UP_POLL_MS = 150
  static SENT_TTL = 86400
  static SHOWN_RETRY_SECS = 2
  static SENT_NOT_SHOWN = 'sent_not_shown'
  static PRUNE_EVERY_MS = 60000
  static GAS_PAYMENT_NEEDED = 'gas_payment_needed'
  static NOTHING_TO_RETURN = 'nothing_to_return'
  static GAS_PAYMENT_MARGIN_SECS = 30
  static GAS_SIGNATURE_MAX = 2 + 2 * 4096
  static GAS_QUOTES_KEPT = 8
  static OWN_GAS = 'Or leave at your own gas: requestClose on the escrow, and withdraw after its grace period.'
  static PROBLEMS = Object.freeze(Object.keys(KINDS))

  constructor(server, escrow, { sent = null, report = null } = {}) {
    this.server = server
    this.cfg = server.cfg
    this.chain = server.chain
    this.relay = server.relay
    this.store = server.store
    this.escrow = escrow
    this.unreadAt = null
    this.flying = new Map()
    this.sent = sent
    this.report = typeof report === 'function' ? report : null
    this.recent = new Map()
    this.told = new Set()
    this.prunedAt = null
  }

  static peek(headerValue) {
    try {
      const c = Credential.parse(headerValue)
      if (c.challenge.method !== Sessions.METHOD || c.challenge.intent !== Sessions.INTENT) return null
      return { action: typeof c.payload.action === 'string' ? c.payload.action : '' }
    } catch {
      return null
    }
  }

  static count(v) {
    return Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0
  }

  static paymentOnly(headerValue, flagged = false) {
    const seen = Sessions.peek(headerValue)
    return seen !== null && (flagged === true || seen.action === 'topUp' || seen.action === 'close')
  }

  asset() {
    const a = this.cfg.assetOf(this.escrow.tokenAddress)
    return a !== null && a.eip3009 ? a : null
  }

  async ready() {
    const now = this.cfg.nowMs()
    if (this.unreadAt !== null && now - this.unreadAt < Sessions.RETRY_MS) return false
    try {
      await this.escrow.ready(this.chain.reader)
      this.unreadAt = null
      return true
    } catch {
      this.unreadAt = now
      return false
    }
  }

  split() {
    return this.server.escrows.split(this.cfg, this.escrow)
  }

  gas() {
    return { ...this.cfg.gas, ...this.escrow.gas }
  }

  async gasFloorMicroUSD(row = 'deposit') {
    const gas = await this.server.gasQuote.microUSD(this.gas()[row])
    const key = `zeam_pass_session_floor_${row}`
    if (gas === null) {
      const last = this.cfg.cache.get(key)
      return isNumeric(last) ? Math.trunc(Number(last)) : 0
    }
    const floor = Math.ceil((gas * this.cfg.floorMargin) / this.cfg.feeShare)
    this.cfg.cache.set(key, floor, GasQuote.FLOOR_TTL)
    return floor
  }

  floorWhy(what) {
    return `the fee address's ${percent(this.cfg.feeShare)}% share of it covers ${what} plus ${Math.round((this.cfg.floorMargin - 1) * 100)}%`
  }

  async depositFloorMicroUSD(micro = null, shared = null) {
    const floor = await (shared ? shared.once('sessionFloor', () => this.gasFloorMicroUSD('deposit')) : this.gasFloorMicroUSD('deposit'))
    return Math.max(this.server.micro(micro), floor)
  }

  units(asset, micro) {
    return String(this.cfg.unitsOfMicroUSD(asset, micro))
  }

  async request(micro = null, shared = null) {
    const asset = this.asset()
    if (asset === null || !(await this.ready())) return null
    return {
      amount: this.units(asset, this.server.micro(micro)),
      unitType: 'request',
      suggestedDeposit: this.units(asset, await this.depositFloorMicroUSD(micro, shared)),
      currency: Address.checksum(asset.address),
      recipient: this.escrow.payee(),
      methodDetails: { chainId: this.cfg.chainId, escrowContract: this.escrow.address, feePayer: true, credentialTypes: ['authorization', 'hash'] },
    }
  }

  async challenge(resource, micro = null, shared = null) {
    const request = await this.request(micro, shared)
    if (request === null) return null
    const res = this.server.constructor.resourceInfo(resource)
    const expires = new Date(this.cfg.nowMs() + Sessions.TTL_SECS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    return Challenge.issue(this.cfg.mppSecret(), { realm: this.server.mppRealm(resource), method: Sessions.METHOD, intent: Sessions.INTENT, request, expires, opaque: Challenge.once(), description: typeof res.description === 'string' && res.description !== '' ? this.server.constructor.shorten(res.description, 120) : null })
  }

  published() {
    const { split, salt, receiver } = this.cfg.relaySplit()
    return { receiver, signer: this.cfg.receiverAuthorizer, split, salt }
  }

  async refuse(resource, micro, error) {
    const q = await this.server.paymentRequired(resource, null, null, {}, micro)
    const retry = Sessions.count(error.more?.retry_after_seconds)
    return this.server.constructor.refuse(error.status, { ...error.body(), accepts: q.body.accepts, ...(q.body.session !== undefined ? { session: q.body.session } : {}) }, retry > 0 ? { ...q.headers, 'Retry-After': String(retry) } : q.headers)
  }

  receipt(record, challengeId, more = {}) {
    const id = lower(record.channelId)
    return { method: Sessions.METHOD, intent: Sessions.INTENT, status: 'success', timestamp: new Date(this.cfg.nowMs()).toISOString(), challengeId, reference: id, channelId: id, chainId: this.cfg.chainId, acceptedCumulative: String(record.signedMaxClaimable ?? '0'), spent: String(record.chargedCumulativeAmount ?? '0'), ...more }
  }

  managed(ctx, record, more = {}) {
    return { ok: true, managed: { status: 204, headers: { 'Payment-Receipt': Receipt.header(this.receipt(record, ctx.challenge.id, more)) }, body: null } }
  }

  async verified(headerValue, resource, micro) {
    let credential
    try {
      credential = Credential.parse(headerValue)
    } catch (e) {
      if (e instanceof MppError) throw malformed(e.detail)
      throw e
    }
    const asset = this.asset()
    if (asset === null || !(await this.ready())) throw new Error('the session escrow cannot be read')
    const c = credential.challenge
    if (!Challenge.bound(this.cfg.mppSecret(), c)) throw problem('challenge-not-found', 'this challenge was not issued here, or was altered')
    if (c.method !== Sessions.METHOD || c.intent !== Sessions.INTENT) throw problem('invalid-challenge', 'not an evm session challenge')
    if (c.realm !== this.server.mppRealm(resource)) throw problem('invalid-challenge', 'the challenge is for another realm')
    const nowSecs = Math.floor(this.cfg.nowMs() / 1000)
    const expiresAt = c.expires !== undefined ? new Date(c.expires).getTime() : null
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt / 1000 <= nowSecs)) throw problem('challenge-not-found', 'the challenge has expired')
    const request = Base64Url.parse(c.request)
    const details = isObject(request.methodDetails) ? request.methodDetails : {}
    if (Math.trunc(Number(details.chainId)) !== this.cfg.chainId) throw problem('invalid-challenge', 'the challenge is for another chain')
    if (!Address.equals(details.escrowContract, this.escrow.address)) throw problem('invalid-challenge', 'the challenge names another escrow')
    if (!Address.equals(request.currency, asset.address)) throw problem('invalid-challenge', 'the challenge is for another currency')
    if (!Address.equals(request.recipient, this.escrow.payee())) throw problem('invalid-challenge', 'the challenge pays another recipient')
    if (typeof request.amount !== 'string' || !UINT.test(request.amount)) throw problem('invalid-challenge', 'the challenge has no amount')
    if (micro !== null && request.amount !== this.units(asset, micro)) throw problem('invalid-challenge', 'the challenge is for another price')
    const payload = credential.payload
    if (!ACTIONS.includes(payload.action)) throw malformed(`payload.action is one of ${ACTIONS.join(', ')}`)
    if (!Hex.isHex(payload.channelId, 32)) throw malformed('channelId is 32 bytes of hex')
    return { credential, challenge: c, request, payload, asset, cost: big(request.amount), id: lower(payload.channelId), nowSecs, transaction: null }
  }

  amount(value, what) {
    if (typeof value !== 'string' || !UINT.test(value)) throw malformed(`${what} is a base-10 integer string`)
    try {
      return EvmSession.amount(value, what)
    } catch (e) {
      throw malformed(message(e))
    }
  }

  authorization(a, nowSecs) {
    if (!isObject(a)) throw malformed('authorization is an object')
    for (const k of ['from', 'to']) if (!Address.isAddress(a[k])) throw malformed(`authorization.${k} is an address`)
    for (const k of ['value', 'validAfter', 'validBefore']) if (typeof a[k] !== 'string' || !UINT.test(a[k])) throw malformed(`authorization.${k} is a base-10 integer string`)
    if (!Hex.isHex(a.nonce, 32)) throw malformed('authorization.nonce is 32 bytes of hex')
    if (!Address.equals(a.to, this.escrow.address)) throw problem('verification-failed', 'the authorization pays an address that is not this escrow')
    if (big(a.validAfter) > BigInt(nowSecs)) throw problem('verification-failed', 'the authorization is not valid yet')
    if (big(a.validBefore) <= BigInt(nowSecs)) throw problem('verification-failed', 'the authorization has expired')
    return { from: Address.checksum(a.from), to: Address.checksum(a.to), value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: Hex.lower(a.nonce) }
  }

  async signed(address, digest, signature, what) {
    if (typeof signature !== 'string' || !Hex.isHex(signature) || signature.length < 4) throw malformed(`${what} signature is hex`)
    const wallet = await this.chain.hasCode(address)
    if (Hex.toBytes(signature).length === 65 && Secp256k1.isCanonical(signature)) {
      let who = null
      try {
        who = await Secp256k1.recoverHash(digest, signature)
      } catch {
        who = null
      }
      if (who !== null && Address.equals(who, address)) return
      if (!wallet) throw who === null ? problem('invalid-signature', `the ${what} signature could not be verified`) : problem('signer-mismatch', `the ${what} was not signed by ${lower(address)}`)
    } else if (!wallet) throw problem('invalid-signature', `the ${what} signature is not in the form the escrow accepts: 65 bytes, v 27 or 28, low s`)
    if (!(await this.chain.isValidSignature(address, digest, signature))) throw problem('signer-mismatch', `the ${what} signature is not valid for ${lower(address)}`)
  }

  async funded(asset, a, signature) {
    const domain = Token.domain(asset.address, asset.name, asset.version !== null ? asset.version : '1', this.cfg.chainId)
    await this.signed(a.from, EvmSession.receiveDigest(domain, a), signature, 'authorization')
    if (big(await this.chain.balanceOf(asset.address, a.from)) < big(a.value)) throw problem('insufficient-balance', 'the payer does not hold the amount the authorization moves')
  }

  async used(asset, a) {
    const out = await this.chain.call(asset.address, Abi.encodeCall('authorizationState(address,bytes32)', [a.from, a.nonce]))
    return BigInt(Hex.lower(out) === '0x' ? '0x0' : out) !== 0n
  }

  live(id) {
    return this.escrow.readState(this.chain.reader, id)
  }

  reverted(e) {
    const data = typeof e?.data === 'string' ? e.data : typeof e?.data?.data === 'string' ? e.data.data : ''
    const name = EvmSession.errorName(data)
    const type = (name !== null && REVERTS[name]) || 'transaction-reverted'
    return problem(type, name !== null ? `the escrow would refuse this: ${name}` : 'the transaction would revert')
  }

  async send(calls, simulate = true) {
    if (simulate) {
      for (const c of calls) {
        try {
          await this.chain.call(c.to, c.data)
        } catch (e) {
          if (EvmSession.errorName(typeof e?.data === 'string' ? e.data : e?.data?.data) !== null || /revert/i.test(message(e))) throw this.reverted(e)
          throw e
        }
      }
    }
    const results = await this.relay.send(calls, this.split(), true)
    const last = results[results.length - 1]
    if (last?.hash === undefined) return { hash: null, block: null, reverted: last?.reverted === true, refused: last?.refused === true, unheard: last?.unheard === true, code: typeof last?.code === 'string' ? last.code : null, gasMicroUSD: isNumeric(last?.gasMicroUSD) ? Math.ceil(Number(last.gasMicroUSD)) : null, error: String(last?.error ?? 'the relay sent nothing').slice(0, 200) }
    return this.outcome(last.hash, await this.server.waitForReceipt(last.hash))
  }

  outcome(hash, receipt) {
    if (receipt === null) return { hash, block: null, reverted: false, refused: false, error: `no receipt for ${hash} yet` }
    let block = null
    try {
      block = BigInt(receipt.blockNumber)
    } catch {
      block = null
    }
    if (lower(receipt.status) !== '0x1') return { hash, block, reverted: true, refused: false, error: `transaction ${hash} reverted` }
    return { hash, block, reverted: false, refused: false, error: null }
  }

  async head() {
    try {
      return BigInt(await this.chain.rpc('eth_blockNumber'))
    } catch {
      return null
    }
  }

  async shown(id, sent, shows) {
    const deadline = this.cfg.nowMs() + this.cfg.stateCatchUpMs
    for (;;) {
      const head = sent.block === null ? null : await this.head()
      const live = await this.live(id)
      if (await shows(live)) return live
      if (sent.refused || (head !== null && head >= sent.block) || this.cfg.nowMs() >= deadline) return live
      await this.cfg.sleepMs(Sessions.CATCH_UP_POLL_MS)
    }
  }

  say(what, more = {}) {
    const key = `${what}|${more.file ?? more.nonce ?? ''}`
    if (this.told.has(key)) return
    this.told.add(key)
    if (this.report === null) return
    try {
      this.report(new Error(what), { at: 'session-sent', ...more })
    } catch {}
  }

  static prior(p) {
    const hash = typeof p.hash === 'string' ? p.hash : null
    const reverted = p.reverted === true
    const unsent = p.unsent === true
    return { hash, block: p.block === null || p.block === undefined ? null : BigInt(p.block), reverted, refused: false, unheard: false, unsent, pending: hash === null && !reverted && !unsent, error: p.error ?? null, at: Math.trunc(Number(p.at)) }
  }

  entry(a, about, sent) {
    return { version: 1, nonce: lower(a.nonce), escrow: lower(this.escrow.address), action: about.action, channelId: about.channelId, validBefore: String(a.validBefore), hash: sent.hash ?? null, block: sent.block === null || sent.block === undefined ? null : sent.block.toString(), reverted: sent.reverted === true, unsent: sent.unsent === true, error: sent.error ?? null, at: sent.at ?? this.cfg.nowMs() }
  }

  async remembered(a, about) {
    const key = lower(a.nonce)
    const held = this.recent.get(key)
    if (held !== undefined) return Sessions.prior(held)
    if (this.sent !== null) {
      let hit = null
      try {
        hit = await this.sent.get(this.escrow.address, key)
      } catch (e) {
        this.say(`the record of a sent session authorization could not be read: ${message(e)}`, { nonce: key })
      }
      if (hit !== null && hit.corrupt === true) {
        this.say('the record of a sent session authorization is corrupt. Its authorization is taken as handed to the relay, and is sent again only when the token shows it unused.', { file: hit.path, nonce: key })
        const record = this.entry(a, about, { hash: null, at: hit.at ?? this.cfg.nowMs() })
        this.recent.set(key, record)
        return Sessions.prior(record)
      }
      if (hit !== null) {
        this.recent.set(key, hit.record)
        return Sessions.prior(hit.record)
      }
    }
    const old = this.cfg.cache.get(SENT + key)
    if (typeof old !== 'string') return null
    try {
      return Sessions.prior(JSON.parse(old))
    } catch {
      return null
    }
  }

  async remember(a, about, sent) {
    const record = this.entry(a, about, sent)
    this.recent.set(record.nonce, record)
    if (this.sent === null) return
    try {
      await this.sent.put(record)
    } catch (e) {
      this.say(`the record of a sent session authorization could not be written, and is held in memory until this process stops: ${message(e)}`, { nonce: record.nonce })
    }
  }

  async prune() {
    const now = this.cfg.nowMs()
    const secs = Math.floor(now / 1000)
    this.prunedAt = now
    for (const [key, r] of this.recent) if (big(r.validBefore) <= BigInt(secs)) this.recent.delete(key)
    if (this.sent === null) return 0
    try {
      const out = await this.sent.prune(secs, Date.now() - Sessions.SENT_TTL * 1000)
      for (const file of out.corrupt) this.say('the record of a sent session authorization is corrupt. Its authorization is taken as handed to the relay, and is sent again only when the token shows it unused.', { file })
      return out.removed
    } catch (e) {
      this.say(`the records of sent session authorizations could not be read: ${message(e)}`)
      return 0
    }
  }

  async pruned() {
    if (this.prunedAt === null || this.cfg.nowMs() - this.prunedAt >= Sessions.PRUNE_EVERY_MS) await this.prune()
  }

  async wasSent(a, about) {
    if (this.flying.has(lower(a.nonce))) return true
    const prior = await this.remembered(a, about)
    return prior !== null && !prior.unsent
  }

  async followed(a, about, prior) {
    if (prior.hash === null || prior.block !== null) return prior
    let receipt = null
    try {
      receipt = await this.chain.receipt(prior.hash)
    } catch {
      receipt = null
    }
    if (receipt === null) return prior
    const now = { ...this.outcome(prior.hash, receipt), at: prior.at }
    await this.remember(a, about, now)
    return now
  }

  async spare(prior, asset, a) {
    if (prior.pending) return this.cfg.nowMs() - prior.at >= this.cfg.stateCatchUpMs && !(await this.used(asset, a))
    if (!prior.reverted) return false
    if (prior.block !== null) {
      const head = await this.head()
      if (head === null || head < prior.block) return false
    } else if (this.cfg.nowMs() - prior.at < this.cfg.stateCatchUpMs) return false
    return !(await this.used(asset, a))
  }

  once(asset, a, about, send) {
    const key = lower(a.nonce)
    const flying = this.flying.get(key)
    if (flying !== undefined) return flying
    const going = (async () => {
      await this.pruned()
      const prior = await this.remembered(a, about)
      if (prior !== null && !prior.unsent) {
        const now = await this.followed(a, about, prior)
        if (!(await this.spare(now, asset, a))) return now
      }
      const at = this.cfg.nowMs()
      await this.remember(a, about, { hash: null, at })
      let sent
      try {
        sent = await send()
      } catch (e) {
        await this.remember(a, about, { hash: null, unsent: true, error: message(e).slice(0, 200), at })
        throw e
      }
      if (sent.hash !== null || sent.reverted) await this.remember(a, about, { ...sent, at })
      else if (sent.unheard) sent.pending = true
      else await this.remember(a, about, { hash: null, unsent: true, error: sent.error, at })
      return sent
    })()
    this.flying.set(key, going)
    const done = () => {
      if (this.flying.get(key) === going) this.flying.delete(key)
    }
    going.then(done, done)
    return going
  }

  unsent(sent, what) {
    if (sent.reverted) return problem('transaction-reverted', `the ${what} transaction reverted`, sent.hash ? { txHash: sent.hash } : {})
    if (sent.hash !== null) return problem('verification-failed', `the ${what} was sent in transaction ${sent.hash} and the chain this seller reads does not show it yet. Nothing more is sent for it. Send this credential again in ${Sessions.SHOWN_RETRY_SECS}s: it is taken, and the authorization is not sent twice.`, { code: Sessions.SENT_NOT_SHOWN, txHash: sent.hash, retry_after_seconds: Sessions.SHOWN_RETRY_SECS })
    if (sent.pending === true) return problem('verification-failed', `the ${what} was handed to the relay and this seller holds no transaction for it yet. Nothing more is sent for it now. Send this credential again in ${Sessions.SHOWN_RETRY_SECS}s: it is taken, and it goes to the relay again only when the token shows the authorization unused.`, { code: Sessions.SENT_NOT_SHOWN, retry_after_seconds: Sessions.SHOWN_RETRY_SECS })
    return problem('verification-failed', `the ${what} was not carried out: ${sent.error}`)
  }

  async mined(hash, what) {
    if (!Hex.isHex(hash, 32)) throw malformed('hash is a transaction hash')
    const receipt = await this.chain.receipt(hash)
    if (receipt === null) throw problem('verification-failed', `no receipt for that ${what} transaction yet; send the credential again once it is mined`)
    if (lower(receipt.status) !== '0x1') throw problem('transaction-reverted', `the ${what} transaction reverted`, { txHash: lower(hash) })
    return (receipt.logs ?? []).filter((l) => Address.equals(l.address, this.escrow.address)).map((l) => EvmSession.decodeEvent(l)).filter((e) => e !== null)
  }

  payerOf(credential) {
    const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(credential.source ?? ''))
    if (m === null || Number(m[1]) !== this.cfg.chainId) throw malformed('a hash credential names its payer in source, as did:pkh:eip155:<chain>:<address>')
    return Address.checksum(m[2])
  }

  usable(live, config = null) {
    if (!live.exists) throw problem('channel-not-found', 'the escrow holds no channel with this id')
    if (!Address.equals(live.payee, this.escrow.payee())) throw problem('channel-not-found', 'this channel pays another payee')
    if (!Address.equals(live.token, this.escrow.tokenAddress)) throw problem('channel-not-found', 'this channel holds another token')
    if (config !== null && (!Address.equals(live.payer, config.payer) || !Address.equals(live.authorizedSigner, config.authorizedSigner))) throw problem('channel-not-found', 'this channel has another payer or signer')
    if (live.finalized) throw problem('channel-finalized', 'this channel is closed')
    if (live.closeRequestedAt > 0) throw problem('channel-finalized', 'a close has been requested on this channel; it takes no more vouchers')
  }

  mine(record) {
    return record !== null && record !== undefined && this.server.escrows.find(record) === this.escrow
  }

  async admitted(ctx, who) {
    const gate = ctx.gate
    if (gate === undefined || gate === null || gate.admit === null) return
    const key = lower(who)
    if (!gate.seen.has(key)) gate.seen.set(key, await gate.admit(key))
    const answer = gate.seen.get(key)
    if (!answer.ok) throw new Unadmitted(answer)
  }

  async open(ctx) {
    const p = ctx.payload
    if (p.type !== 'authorization' && p.type !== 'hash') throw malformed('an open carries type "authorization" or "hash"')
    if (!Hex.isHex(p.salt, 32)) throw malformed('salt is 32 bytes of hex')
    if (p.authorizedSigner !== undefined && p.authorizedSigner !== null && !Address.isAddress(p.authorizedSigner)) throw malformed('authorizedSigner is an address')
    const cumulative = this.amount(p.cumulativeAmount, 'cumulativeAmount')
    const relayed = p.type === 'authorization'
    const a = relayed ? this.authorization(p.authorization, ctx.nowSecs) : null
    const voucher = relayed ? p.voucherSignature : p.signature
    const payer = relayed ? a.from : this.payerOf(ctx.credential)
    let config
    try {
      config = EvmSession.channel({ payer, payee: this.escrow.payee(), token: ctx.asset.address, salt: p.salt, authorizedSigner: p.authorizedSigner })
    } catch (e) {
      if (e instanceof InvalidArgument) throw malformed(message(e))
      throw e
    }
    if (lower(EvmSession.channelId(config, this.escrow.address, this.cfg.chainId)) !== ctx.id) throw malformed('channelId is not the id of this payer, payee, token, salt and authorizedSigner on this escrow and chain')
    await this.admitted(ctx, payer)
    const digest = EvmSession.voucherDigest(this.escrow.address, this.cfg.chainId, ctx.id, cumulative)
    let live = await this.live(ctx.id)
    let opened = null
    const about = { action: 'open', channelId: ctx.id }
    const again = relayed && (await this.wasSent(a, about))
    if (!live.exists || again) {
      if (relayed) {
        const deposit = big(a.value)
        if (lower(a.nonce) !== lower(EvmSession.openNonce(a.from, config.payee, config.token, config.salt, config.authorizedSigner))) throw problem('transaction-reverted', 'the authorization nonce is not the one this channel derives; the escrow would refuse it')
        if (!again) {
          const floor = big(this.units(ctx.asset, await this.depositFloorMicroUSD(this.cfg.microUSDOf(ctx.asset, ctx.cost.toString()))))
          if (deposit < floor) throw problem('insufficient-balance', `a deposit sent for the payer is at least ${floor} base units: ${this.floorWhy('the gas of opening the channel')}`, { requiredDeposit: floor.toString(), deposit: deposit.toString() })
          if (cumulative > deposit) throw problem('amount-exceeds-deposit', 'the voucher is for more than the deposit', { deposit: deposit.toString() })
          await this.signed(EvmSession.signerOf(config), digest, voucher, 'voucher')
          await this.funded(ctx.asset, a, p.signature)
        }
        const sent = await this.once(ctx.asset, a, about, () => this.send([this.escrow.openCall({ config, deposit: a.value, authorization: a, signature: p.signature })]))
        live = await this.shown(ctx.id, sent, (l) => l.exists)
        if (!live.exists) throw this.unsent(sent, 'open')
        if (!sent.reverted) opened = { by: 'relay', transaction: sent.error === null ? sent.hash : null }
      } else {
        const events = await this.mined(p.hash, 'open')
        if (!events.some((e) => e.name === 'ChannelOpened' && e.channelId === ctx.id)) throw problem('verification-failed', 'that transaction did not open this channel on this escrow')
        live = await this.live(ctx.id)
        opened = { by: 'payer', transaction: lower(p.hash) }
      }
    }
    this.usable(live, config)
    if (big(live.deposit) - big(live.settled) < ctx.cost) throw problem('insufficient-balance', 'the channel holds less than one unit of this price', { deposit: live.deposit })
    if (cumulative > big(live.deposit)) throw problem('amount-exceeds-deposit', 'the voucher is for more than the deposit', { deposit: live.deposit })
    await this.signed(EvmSession.signerOf(config), digest, voucher, 'voucher')
    const now = this.cfg.nowMs()
    const record = await this.store.update(ctx.id, (current) => {
      if (current !== null && !this.mine(current)) return current
      const r = current ?? { channelId: ctx.id, channelConfig: config, chargedCumulativeAmount: '0', signedMaxClaimable: '0', signature: '', balance: live.deposit, totalClaimed: live.settled, withdrawRequestedAt: 0, refundNonce: 0, lastRequestTimestamp: now, escrow: this.escrow.kind, session: { settle: SessionBook.NONE, held: [], openedAt: now } }
      if (opened !== null && r.session.opened === undefined) {
        r.session.opened = opened
        if (opened.by === 'relay') r.depositsWePaid = Sessions.count(r.depositsWePaid) + 1
      }
      r.balance = live.deposit
      if (big(live.settled) > big(r.totalClaimed ?? '0')) r.totalClaimed = live.settled
      return SessionBook.hold(r, cumulative, voucher)
    })
    if (!this.mine(record)) throw problem('channel-not-found', 'this channel id is held by another escrow here')
    if (opened !== null && opened.transaction !== null) ctx.transaction = opened.transaction
    return record
  }

  async topUp(ctx) {
    const p = ctx.payload
    if (p.type !== 'authorization' && p.type !== 'hash') throw malformed('a topUp carries type "authorization" or "hash"')
    const add = this.amount(p.additionalDeposit, 'additionalDeposit')
    if (add <= 0n) throw malformed('additionalDeposit is more than zero')
    const record = await this.store.get(ctx.id)
    if (!this.mine(record)) throw problem('channel-not-found', 'no channel with this id here')
    await this.admitted(ctx, record.channelConfig.payer)
    if (p.type === 'hash') this.payerOf(ctx.credential)
    const before = await this.live(ctx.id)
    if (!before.exists) throw problem('channel-not-found', 'the escrow holds no channel with this id')
    if (before.finalized) throw problem('channel-finalized', 'this channel is closed')
    let after
    let landed = null
    if (p.type === 'authorization') {
      const a = this.authorization(p.authorization, ctx.nowSecs)
      if (!Hex.isHex(p.salt, 32)) throw malformed('salt is 32 bytes of hex')
      if (big(a.value) !== add) throw problem('verification-failed', 'additionalDeposit and the authorization amount differ')
      if (lower(a.nonce) !== lower(EvmSession.topUpNonce(ctx.id, add, a.from, p.salt))) throw problem('transaction-reverted', 'the authorization nonce is not the one this top-up derives; the escrow would refuse it')
      await this.admitted(ctx, a.from)
      const key = lower(a.nonce)
      const known = SessionBook.topUp(record, key)
      const about = { action: 'topUp', channelId: ctx.id }
      let again = await this.wasSent(a, about)
      if (!again && known !== null && !known.landed && (await this.remembered(a, about)) === null) {
        this.say('the channel record holds a top-up as sent and the record of its authorization is missing. It is taken as handed to the relay, and is sent again only when the token shows it unused.', { nonce: key, channelId: ctx.id })
        await this.remember(a, about, { hash: null })
        again = true
      }
      if (known !== null && known.landed) after = before
      else if (await this.used(ctx.asset, a)) {
        after = await this.live(ctx.id)
        if (known === null || !known.landed) {
          const base = big(known !== null ? known.base : record.balance ?? '0')
          if (big(after.deposit) < base + add) throw problem('verification-failed', 'the token marks this authorization used or canceled, and the channel\'s deposit did not rise by it. Nothing was added. Sign a new authorization, with a new salt.', { deposit: after.deposit })
          landed = { key, relayed: known !== null }
        }
      } else {
        if (!again) {
          const floor = big(this.units(ctx.asset, Math.max(1, await this.gasFloorMicroUSD('topUp'))))
          if (add < floor) throw problem('insufficient-balance', `a top-up sent for the payer is at least ${floor} base units: ${this.floorWhy('its gas')}`, { requiredDeposit: floor.toString(), deposit: add.toString() })
          await this.funded(ctx.asset, a, p.signature)
        }
        const sent = await this.once(ctx.asset, a, about, async () => {
          await this.store.update(ctx.id, (r) => (r === null ? null : SessionBook.topUpSent(r, key, before.deposit)))
          return this.send([this.escrow.topUpCall({ channelId: ctx.id, additionalDeposit: add.toString(), topUpSalt: p.salt, authorization: a, signature: p.signature })])
        })
        const book = SessionBook.topUp(await this.store.get(ctx.id), key)
        if (book !== null && book.landed) after = await this.live(ctx.id)
        else {
          const base = big(book !== null ? book.base : before.deposit)
          let there = false
          after = await this.shown(ctx.id, sent, async (l) => (there = big(l.deposit) >= base + add && (!sent.reverted || (await this.used(ctx.asset, a)))))
          if (!there) throw this.unsent(sent, 'top-up')
          if (sent.error === null) ctx.transaction = sent.hash
          landed = { key, relayed: true }
        }
      }
    } else {
      const events = await this.mined(p.hash, 'top-up')
      if (!events.some((e) => e.name === 'TopUp' && e.channelId === ctx.id && big(e.additionalDeposit) === add)) throw problem('verification-failed', 'that transaction did not add this amount to this channel on this escrow')
      after = await this.live(ctx.id)
      ctx.transaction = lower(p.hash)
      landed = { key: lower(p.hash), relayed: false }
    }
    return this.store.update(ctx.id, (r) => {
      if (r === null) return null
      r.balance = after.finalized ? after.settled : after.deposit
      if (after.closeRequestedAt === 0) r.withdrawRequestedAt = 0
      if (landed !== null && SessionBook.topUpLanded(r, landed.key, add) && landed.relayed) r.depositsWePaid = Sessions.count(r.depositsWePaid) + 1
      return r
    })
  }

  async voucher(ctx) {
    const p = ctx.payload
    const cumulative = this.amount(p.cumulativeAmount, 'cumulativeAmount')
    if (isObject(p.deposit)) {
      const d = p.deposit
      if (d.action === 'open') await this.open({ ...ctx, payload: { action: 'open', type: d.type, channelId: p.channelId, authorization: d.authorization, signature: d.signature, salt: d.salt, authorizedSigner: d.authorizedSigner, cumulativeAmount: p.cumulativeAmount, voucherSignature: p.signature } })
      else if (d.action === 'topUp') await this.topUp({ ...ctx, payload: { action: 'topUp', type: d.type, channelId: p.channelId, authorization: d.authorization, signature: d.signature, salt: d.salt, additionalDeposit: isObject(d.authorization) ? d.authorization.value : undefined } })
      else throw malformed('deposit.action is "open" or "topUp"')
    } else if (p.deposit !== undefined && p.deposit !== null) throw malformed('deposit is an object')
    const record = await this.store.get(ctx.id)
    if (!this.mine(record)) throw problem('channel-not-found', 'no channel with this id here')
    await this.admitted(ctx, record.channelConfig.payer)
    const live = await this.live(ctx.id)
    this.usable(live, record.channelConfig)
    await this.signed(EvmSession.signerOf(record.channelConfig), EvmSession.voucherDigest(this.escrow.address, this.cfg.chainId, ctx.id, cumulative), p.signature, 'voucher')
    if (cumulative > SessionBook.accepted(record) && cumulative > big(live.deposit)) throw problem('amount-exceeds-deposit', 'the voucher is for more than the channel holds', { deposit: live.deposit, acceptedCumulative: String(record.signedMaxClaimable) })
    return this.store.update(ctx.id, (r) => {
      if (r === null) return null
      r.balance = live.deposit
      if (big(live.settled) > big(r.totalClaimed ?? '0')) r.totalClaimed = live.settled
      return cumulative > big(live.deposit) ? r : SessionBook.hold(r, cumulative, p.signature)
    })
  }

  closeReturns(record, live) {
    const settles = big(this.escrow.claimView(record).signedMaxClaimable ?? '0')
    const to = settles > big(live.settled) ? settles : big(live.settled)
    return big(live.deposit) > to ? big(live.deposit) - to : 0n
  }

  gasPaymentOf(given) {
    if (given === undefined || given === null) return null
    const a = isObject(given) ? given.authorization : null
    if (!isObject(a) || typeof given.signature !== 'string') throw malformed('gasPayment is {authorization: {from, to, value, validAfter, validBefore, nonce}, signature}')
    if (given.signature.length > Sessions.GAS_SIGNATURE_MAX || !Hex.isHex(given.signature)) throw malformed(`gasPayment.signature is hex, at most ${(Sessions.GAS_SIGNATURE_MAX - 2) / 2} bytes`)
    for (const k of ['value', 'validAfter', 'validBefore']) if (typeof a[k] === 'string' && a[k].length > 78) throw malformed(`gasPayment.authorization.${k} is a uint256`)
    for (const k of ['from', 'to']) if (!Address.isAddress(a[k])) throw malformed(`gasPayment.authorization.${k} is an address`)
    for (const k of ['value', 'validAfter', 'validBefore']) if (typeof a[k] !== 'string' || !UINT.test(a[k])) throw malformed(`gasPayment.authorization.${k} is a base-10 integer string`)
    if (!Hex.isHex(a.nonce, 32)) throw malformed('gasPayment.authorization.nonce is 32 bytes of hex')
    return { authorization: { from: Address.checksum(a.from), to: Address.checksum(a.to), value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: Hex.lower(a.nonce) }, signature: given.signature }
  }

  tokenDomain(asset) {
    return Token.domain(asset.address, asset.name, asset.version !== null && asset.version !== undefined ? asset.version : '1', this.cfg.chainId)
  }

  async closeGas(call) {
    const quotes = this.server.gasQuote
    return (await quotes.relayQuote(call)) ?? (await quotes.quote(this.gas().refund + this.cfg.gas.gasPayment))
  }

  static underpaid(sendCostMicroUSD, payingMicroUSD) {
    return (gas) => (payingMicroUSD >= gas.microUSD
      ? `close gas rose past the quote margin: sending costs $${usd(sendCostMicroUSD)}, your payment is $${usd(payingMicroUSD)}. Nothing was sent`
      : `your payment, $${usd(payingMicroUSD)}, is under the quote, $${usd(gas.microUSD)}, and under what sending costs, $${usd(sendCostMicroUSD)}. Nothing was sent`)
  }

  async gasQuote(ctx, record, live, call, why, extra = {}) {
    const asset = ctx.asset
    const quotes = this.server.gasQuote
    const left = this.closeReturns(record, live)
    const leftMicroUSD = this.cfg.microUSDOf(asset, left.toString())
    const gas = await this.closeGas(call)
    const payTo = gas === null ? null : await quotes.gasWallet()
    if (gas === null || payTo === null) return problem('verification-failed', `the close was not carried out: its fees do not cover its gas, and the gas cannot be priced now. Retry in 60s. ${Sessions.OWN_GAS}`, { code: 'gas_unpriced', retry_after_seconds: 60, leftMicroUSD })
    const quoted = Math.max(gas.microUSD, extra.sendCostMicroUSD === undefined ? 0 : Math.ceil(extra.sendCostMicroUSD * this.cfg.gasBuffer))
    const units = this.cfg.unitsOfMicroUSD(asset, quoted)
    const gasMicroUSD = this.cfg.microUSDOf(asset, units)
    const earned = this.cfg.microUSDOf(asset, (big(live.deposit) - left).toString())
    const cover = await quotes.quote(this.gas().deposit + this.gas().refund + ((await quotes.relayPaid(ctx.id)) ?? 0), false)
    const numbers = { channelId: ctx.id, leftMicroUSD, returnedMicroUSD: leftMicroUSD, gasMicroUSD, feeMicroUSD: GasQuote.feeMicroUSD(earned, this.cfg.feeShare), ...(cover === null ? {} : { coverMicroUSD: cover.microUSD }), gasUnits: gas.gasUnits, gasUnitsWithMargin: gas.gasUnitsWithMargin, gasPriceWei: gas.gasPriceWei, ethUSD: gas.ethUSD, l1FeeWei: gas.l1FeeWei, marginPercent: gas.marginPercent, quotedBy: gas.quotedBy, ...extra }
    const said = typeof why === 'function' ? why(gas) : why
    const lead = said === null ? '' : `${said}. `
    if (big(units) >= left) return problem('verification-failed', `${lead}Nothing to return: the close's gas, $${usd(gasMicroUSD)}, is not less than the $${usd(leftMicroUSD)} it would return, and the channel's fees do not cover it. Nothing was sent. ${Sessions.OWN_GAS}`, { code: Sessions.NOTHING_TO_RETURN, ...numbers, returnedMicroUSD: 0 })
    const secs = Math.trunc(Number(this.cfg.gasPaymentSecs))
    const authorization = { from: Address.checksum(record.channelConfig.payer), to: Address.checksum(payTo), value: String(units), validAfter: '0', validBefore: String(Math.floor(this.cfg.nowMs() / 1000) + secs), nonce: '0x' + randomBytes(32).toString('hex') }
    await this.store.update(ctx.id, (r) => (r === null ? null : Sessions.quoted(r, authorization, ctx.nowSecs)))
    return problem('verification-failed', `${lead}The channel's fees do not cover the gas of its open, of the top-ups and close request the relay sent, and of its close. Close gas: $${usd(gasMicroUSD)} USDC, no ETH (${gas.gasUnits} gas, L1 fee ${gas.l1FeeWei} wei, ${gas.gasPriceWei} wei per gas, $${gas.ethUSD} per ETH, ${gas.marginPercent}% margin; ${gas.quotedBy === 'relay' ? 'priced by the relay' : 'priced from measured closes'}). Sign authorization (EIP-3009 TransferWithAuthorization; typed data in sign) and send the close again with gasPayment: {authorization, signature} in its payload within ${secs}s. The close and the gas payment go in one transaction: $${usd(leftMicroUSD)} returns and $${usd(leftMicroUSD - gasMicroUSD)} is net to you. ${Sessions.OWN_GAS}`, { code: Sessions.GAS_PAYMENT_NEEDED, ...numbers, payTo: authorization.to, authorization, sign: Token.transferTypedData(this.tokenDomain(asset), authorization) })
  }

  static gasQuotes(record, nowSecs) {
    const kept = Array.isArray(record?.session?.gasQuotes) ? record.session.gasQuotes : []
    return kept.filter((q) => isObject(q) && typeof q.value === 'string' && Number(q.until) >= nowSecs)
  }

  static quoted(record, authorization, nowSecs) {
    const kept = Sessions.gasQuotes(record, nowSecs).filter((q) => q.value !== authorization.value)
    record.session = { ...(record.session ?? {}), gasQuotes: [...kept, { value: authorization.value, until: Number(authorization.validBefore) }].slice(-Sessions.GAS_QUOTES_KEPT) }
    return record
  }

  static unquoted(record, value, nowSecs) {
    const quotes = Sessions.gasQuotes(record, nowSecs)
    if (quotes.some((q) => q.value === value)) return null
    return quotes.length === 0 ? `gasPayment is ${value}, and no close gas is quoted on this channel now` : `gasPayment is ${value}, not the ${quotes[quotes.length - 1].value} quoted`
  }

  async gasPaymentProblem(ctx, record, live, offered) {
    const a = offered.authorization
    const payTo = await this.server.gasQuote.gasWallet()
    if (payTo === null) return 'the relay is unreachable'
    if (!Address.equals(a.from, record.channelConfig.payer)) return "gasPayment must come from the channel's payer"
    if (!Address.equals(a.to, payTo)) return `gasPayment must go to the relay gas wallet ${payTo}`
    if (big(a.value) <= 0n) return 'gasPayment is for nothing'
    if (big(a.value) > this.closeReturns(record, live)) return `gasPayment is ${a.value}, over the ${this.closeReturns(record, live)} the close returns`
    if (big(a.validAfter) > BigInt(ctx.nowSecs)) return 'gasPayment is not valid yet'
    if (big(a.validBefore) < BigInt(ctx.nowSecs + Sessions.GAS_PAYMENT_MARGIN_SECS)) return 'gasPayment expires too soon'
    try {
      await this.signed(a.from, Token.transferDigest(this.tokenDomain(ctx.asset), a), offered.signature, 'gasPayment')
    } catch (e) {
      if (e instanceof SessionProblem) return "gasPayment signature is not the payer's"
      throw e
    }
    if (await this.used(ctx.asset, a)) return 'the token shows this gasPayment used or canceled'
    return null
  }

  async close(ctx) {
    const p = ctx.payload
    const offered = this.gasPaymentOf(p.gasPayment)
    const cumulative = this.amount(p.cumulativeAmount, 'cumulativeAmount')
    let record = await this.store.get(ctx.id)
    if (!this.mine(record)) throw problem('channel-not-found', 'no channel with this id here')
    const live = await this.live(ctx.id)
    if (!live.exists) throw problem('channel-not-found', 'the escrow holds no channel with this id')
    await this.signed(EvmSession.signerOf(record.channelConfig), EvmSession.voucherDigest(this.escrow.address, this.cfg.chainId, ctx.id, cumulative), p.signature, 'voucher')
    const now = this.cfg.nowMs()
    if (live.finalized) return this.managed(ctx, await this.closed(ctx.id, live, null, now))
    if (cumulative > big(live.deposit)) throw problem('amount-exceeds-deposit', 'the voucher is for more than the channel holds', { deposit: live.deposit })
    const pendingId = '0x' + randomBytes(32).toString('hex')
    let busy = false
    record = await this.store.update(ctx.id, (r) => {
      if (r === null) return null
      if (Channels.pendingLive(r, now)) {
        busy = true
        return r
      }
      r.pendingRequest = { pendingId, amount: '0', expiresAt: now + this.holdMs() }
      return SessionBook.hold(r, cumulative, p.signature)
    })
    if (record === null) throw problem('channel-not-found', 'no channel with this id here')
    if (busy) throw problem('verification-failed', 'a call is in flight on this channel; close it when the call has ended', { retry_after_seconds: 2 })
    let sent
    let after
    let gasPaid = null
    try {
      sent = await this.closing(record)
      if (sent === null) {
        const before = await this.escrow.prepareCalls(this.chain)
        const call = await this.escrow.closeCall(this.cfg.signingKey(), record, ctx.nowSecs)
        if (offered === null) {
          sent = await this.send([...before, call], before.length === 0)
          if (sent.hash === null && sent.code === Sessions.GAS_PAYMENT_NEEDED) throw await this.gasQuote(ctx, record, live, call, null)
        } else {
          const bad = await this.gasPaymentProblem(ctx, record, live, offered)
          if (bad !== null) throw await this.gasQuote(ctx, record, live, call, bad)
          const unquoted = Sessions.unquoted(record, offered.authorization.value, ctx.nowSecs)
          if (unquoted !== null && (await this.relay.quote(call, true, this.split()))?.covered !== true) throw await this.gasQuote(ctx, record, live, call, unquoted)
          const pay = { to: ctx.asset.address, data: Token.encodeTransfer(offered.authorization, offered.signature) }
          sent = await this.send([Multicall3.aggregate3([...before, call, pay])], true)
          const paying = this.cfg.microUSDOf(ctx.asset, offered.authorization.value)
          if (sent.hash === null && sent.code === 'underpaid' && sent.gasMicroUSD !== null) throw await this.gasQuote(ctx, record, live, call, Sessions.underpaid(sent.gasMicroUSD, paying), { requoted: true, sendCostMicroUSD: sent.gasMicroUSD })
          if (sent.hash === null && sent.code === Sessions.NOTHING_TO_RETURN) throw problem('verification-failed', `${sent.error} ${Sessions.OWN_GAS}`, { code: Sessions.NOTHING_TO_RETURN, channelId: ctx.id, returnedMicroUSD: 0, gasMicroUSD: paying })
          gasPaid = paying
        }
        if (sent.hash !== null && !sent.reverted) {
          await this.store.update(ctx.id, (r) => {
            if (r === null) return null
            r.session = { ...(r.session ?? {}), closing: { transaction: sent.hash, at: now } }
            return r
          })
        }
      }
      after = await this.shown(ctx.id, sent, (l) => l.finalized)
    } catch (e) {
      await this.server.channels.release(ctx.id, pendingId)
      throw e
    }
    if (!after.finalized) {
      await this.server.channels.release(ctx.id, pendingId)
      const e = this.unsent(sent, 'close')
      e.detail = `${String(e.detail).replace(/\.$/, '')}. To leave without this seller, call requestClose on the escrow and withdraw after its grace period.`
      throw e
    }
    const took = gasPaid !== null && (await this.used(ctx.asset, offered.authorization))
    return this.managed(ctx, await this.closed(ctx.id, after, sent.error === null ? sent.hash : null, now), sent.error === null ? { txHash: sent.hash, ...(took ? { gasMicroUSD: gasPaid } : {}) } : {})
  }

  async closing(record) {
    const c = record.session?.closing
    if (!isObject(c) || !Hex.isHex(c.transaction, 32)) return null
    let receipt = null
    try {
      receipt = await this.chain.receipt(c.transaction)
    } catch {
      receipt = null
    }
    if (receipt === null) return this.cfg.nowMs() - Math.trunc(Number(c.at)) < 1000 * this.cfg.receiptTimeoutSecs ? { hash: c.transaction, block: null, reverted: false, refused: false, error: null } : null
    const sent = this.outcome(c.transaction, receipt)
    return sent.reverted ? null : sent
  }

  closed(id, live, transaction, now) {
    return this.store.update(id, (r) => {
      if (r === null) return null
      delete r.pendingRequest
      r.balance = live.settled
      r.totalClaimed = live.settled
      r.withdrawRequestedAt = 0
      r.session = { ...(r.session ?? {}), closed: r.session?.closed ?? { transaction, at: now } }
      delete r.session.closing
      return r
    })
  }

  holdMs() {
    return Math.min(600000, Math.max(5000, Math.max(0, Math.trunc(Number(this.cfg.maxTimeoutSeconds))) * 1000))
  }

  async reserve(ctx, record) {
    const now = this.cfg.nowMs()
    const pendingId = '0x' + randomBytes(32).toString('hex')
    let outcome = null
    const next = await this.store.update(ctx.id, (r) => {
      if (r === null) return null
      if (Channels.pendingLive(r, now)) {
        outcome = 'busy'
        return r
      }
      const pay = SessionBook.payable(r, ctx.cost, ctx.payload.cumulativeAmount)
      if (!pay.ok) {
        outcome = pay
        return r
      }
      r.pendingRequest = { pendingId, amount: ctx.cost.toString(), expiresAt: now + this.holdMs() }
      r.lastRequestTimestamp = now
      outcome = 'reserved'
      return r
    })
    const r = next ?? record
    if (outcome === 'busy') throw problem('verification-failed', 'another call is in flight on this channel; retry when it has ended. Nothing was charged.', { retry_after_seconds: 2 })
    if (outcome !== 'reserved') {
      const state = { channelId: ctx.id, requiredCumulative: outcome?.requiredCumulative ?? null, acceptedCumulative: String(r.signedMaxClaimable ?? '0'), spent: String(r.chargedCumulativeAmount ?? '0'), deposit: String(r.balance ?? '0') }
      if (outcome?.why === 'presented') throw problem('insufficient-balance', `this voucher is for ${outcome.presented}, and a call is paid by the voucher for exactly what was spent plus its price: sign a voucher for ${state.requiredCumulative}. Nothing was charged.`, state)
      if (outcome?.why === 'voucher') throw problem('insufficient-balance', `no voucher is held between what was spent and this call's total: sign a voucher for exactly ${state.requiredCumulative}. Nothing was charged.`, state)
      throw problem('insufficient-balance', `the vouchers accepted do not cover this call: sign a voucher for ${state.requiredCumulative}${big(state.requiredCumulative ?? '0') > big(state.deposit) ? ', after a topUp' : ''}. Nothing was charged.`, state)
    }
    return { ok: true, hold: { kind: 'session', channelId: ctx.id, pendingId, cost: ctx.cost.toString(), challengeId: ctx.challenge.id, payer: lower(r.channelConfig.payer), transaction: ctx.transaction } }
  }

  async hold(headerValue, resource, price = null, { paymentOnly = false, admit = null } = {}) {
    const micro = price === null || price === undefined ? null : this.server.micro(price)
    try {
      const ctx = await this.verified(headerValue, resource, paymentOnly ? null : micro)
      ctx.gate = { admit: typeof admit === 'function' ? admit : null, seen: new Map() }
      const action = ctx.payload.action
      if (action === 'close') return await this.close(ctx)
      const record = action === 'open' ? await this.open(ctx) : action === 'topUp' ? await this.topUp(ctx) : await this.voucher(ctx)
      if (record === null) throw problem('channel-not-found', 'no channel with this id here')
      if (paymentOnly || action === 'topUp') return this.managed(ctx, record, ctx.transaction !== null ? { txHash: ctx.transaction } : {})
      const held = await this.reserve(ctx, record)
      held.hold.resource = this.server.constructor.resourceInfo(resource)
      held.hold.micro = micro
      held.admitted = ctx.gate.seen.get(held.hold.payer) ?? null
      return held
    } catch (e) {
      if (e instanceof Unadmitted) return { ok: false, unadmitted: e.answer }
      if (e instanceof SessionProblem) return this.refuse(resource, micro, e)
      throw e
    }
  }

  release(hold) {
    return this.server.channels.release(hold.channelId, hold.pendingId)
  }

  async settle(hold) {
    const now = this.cfg.nowMs()
    let charged = false
    const record = await this.store.update(hold.channelId, (r) => {
      if (r === null || r.pendingRequest === undefined || r.pendingRequest === null || r.pendingRequest.pendingId !== hold.pendingId) return r
      delete r.pendingRequest
      r.lastRequestTimestamp = now
      charged = true
      return SessionBook.charge(r, hold.cost)
    })
    if (!charged) return this.refuse(hold.resource, hold.micro, problem('verification-failed', 'the hold on this channel ended before the call did. Not delivered; nothing was charged.'))
    const receipt = this.receipt(record, hold.challengeId, { units: 1, ...(hold.transaction ? { txHash: hold.transaction } : {}) })
    return { ok: true, status: 200, response: { success: true, network: this.cfg.network, payer: hold.payer, amount: hold.cost, extra: { protocol: 'mpp', method: Sessions.METHOD, intent: Sessions.INTENT, challengeId: hold.challengeId, channelId: hold.channelId } }, headers: { 'Payment-Receipt': Receipt.header(receipt) } }
  }
}
