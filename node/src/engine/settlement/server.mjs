import { randomBytes } from 'node:crypto'
import { Address, Hex, Keccak, empty, isObject } from '../core/hex.mjs'
import { Abi } from '../core/abi.mjs'
import { Token } from '../core/evm.mjs'
import { Chain } from './chain.mjs'
import { Channels } from './channels.mjs'
import { UnknownEscrow } from './escrow.mjs'
import { Json, Reason } from './json.mjs'
import { Challenge, Credential, EvmCharge, MppError, Problem, Receipt } from './mpp.mjs'
import { GasQuote, Relay } from './relay.mjs'
import { Verify } from './verify.mjs'
import { ESCROWS } from './x402.mjs'
import { pricing, usd } from '../pricing.mjs'
import { forHeader } from '../bazaar.mjs'
import { percent, refundRule } from '../discovery.mjs'

const MISMATCH = Reason.CUMULATIVE_AMOUNT_MISMATCH
const MIN_PENDING_TTL_MS = 5000
const MAX_PENDING_TTL_MS = 600000
const MOVED_TRIES = 2
const SDK_FIELDS = ['channelId', 'channelConfig', 'chargedCumulativeAmount', 'signedMaxClaimable', 'signature', 'balance', 'totalClaimed', 'withdrawRequestedAt', 'refundNonce', 'onchainSyncedAt', 'lastRequestTimestamp', 'pendingRequest']
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const message = (e) => String(e?.message ?? e)
const MPP_TTL_SECS = 300
const MPP_USED_TRIES = 5
const MPP_SHOWN_RETRY_SECS = 2
const AUTHORIZATION_USED = Keccak.utf8('AuthorizationUsed(address,bytes32)')
const topicOf = (address) => '0x' + '0'.repeat(24) + Hex.body(address)

const ELLIPSIS = '...'

function utf8Cut(text, bytes) {
  const b = Buffer.from(text, 'utf8')
  if (b.length <= bytes) return text
  let end = bytes
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--
  return b.subarray(0, end).toString('utf8')
}

function sentenceCut(text, bytes) {
  const cut = utf8Cut(text, bytes)
  if (cut === text) return text
  const end = cut.lastIndexOf('. ')
  if (end >= 60) return cut.slice(0, end + 1)
  const room = utf8Cut(text, bytes - ELLIPSIS.length)
  const space = room.lastIndexOf(' ')
  const whole = text.charAt(room.length) === ' ' || space <= 0 ? room : room.slice(0, space)
  return whole.replace(/[ \t\n\r,;:([-]+$/, '') + ELLIPSIS
}

export class MppHeldMemory {
  constructor() {
    this.held = new Map()
  }

  async claim(key, untilMs, nowMs) {
    for (const [k, e] of this.held) if (e.until <= nowMs) this.held.delete(k)
    if (this.held.has(key)) return false
    this.held.set(key, { key: String(key), until: untilMs })
    return true
  }

  async release(key) {
    this.held.delete(key)
  }

  async entry(key) {
    const e = this.held.get(key)
    return e === undefined ? null : { ...e }
  }

  async mark(key, from, fields) {
    const e = this.held.get(key)
    if (e === undefined || (e.state ?? null) !== from) return false
    this.held.set(key, { ...e, ...fields })
    return true
  }

  async clear() {
    this.held.clear()
  }
}

export class Server {
  static MISMATCH = MISMATCH
  static SDK_FIELDS = SDK_FIELDS

  constructor(cfg, store, chain = null, relay = null, escrows = ESCROWS) {
    this.cfg = cfg
    this.store = store
    this.chain = chain ?? new Chain(cfg.rpcUrl)
    this.relay = relay ?? new Relay(cfg.relayUrl)
    this.escrows = escrows
    this.gasQuote = new GasQuote(cfg, this.chain, this.relay)
    this.channels = new Channels(cfg, store, this.chain, escrows)
    this.verifiers = new Map(escrows.list.map((e) => [e, new Verify(cfg, this.chain, e)]))
    this.verify = this.verifiers.get(escrows.default)
    this.mppHeld = new MppHeldMemory()
    this.sessions = null
  }

  escrowOf(scheme) {
    return this.escrows.offering(scheme) ?? this.escrows.default
  }

  static unserved(e) {
    return Server.refuse(402, { error: 'unknown_escrow', code: 'unknown_escrow', message: `this channel's record names an escrow this payment does not use (${String(e.kind).slice(0, 60)}). Nothing was charged.` })
  }

  gas() {
    return this.gasQuote
  }

  micro(price) {
    return price !== null && price !== undefined && Number(price) >= 1 ? Math.trunc(Number(price)) : this.cfg.priceMicroUSD
  }

  accepts(price = null) {
    const all = []
    for (const escrow of this.escrows.list) {
      let rows = []
      for (const asset of this.cfg.assets) rows.push(...escrow.accepts(this.cfg, asset, this.micro(price)))
      const dollar = rows.filter((r) => typeof r.extra.name === 'string' && /^USD Coin$/i.test(r.extra.name))
      if (dollar.length && rows.length > dollar.length) rows = [...rows, ...dollar.map(clone)]
      all.push(...rows)
    }
    return all
  }

  static shorten(text, bytes) {
    return sentenceCut(text, bytes)
  }

  static resourceInfo(resource) {
    if (resource !== null && typeof resource === 'object') {
      const out = { url: resource.url !== undefined && resource.url !== null ? String(resource.url) : '' }
      if (typeof resource.description === 'string' && resource.description !== '') out.description = sentenceCut(resource.description, 300)
      out.mimeType = resource.mimeType !== undefined && resource.mimeType !== null ? String(resource.mimeType) : 'application/json'
      return out
    }
    return { url: String(resource ?? ''), mimeType: 'application/json' }
  }

  static document(resource, error, accepts) {
    const doc = { x402Version: 2 }
    if (error !== null && error !== undefined) doc.error = error
    doc.resource = resource
    doc.accepts = accepts
    return doc
  }

  static percent(share) {
    return percent(share)
  }

  static usd(microUSD) {
    return usd(microUSD)
  }

  refundWhere(refundUrl = null) {
    const at = this.cfg.refundUrl || refundUrl
    return at ? `POST ${at}` : 'POST /refund on this site'
  }

  async terms(refundUrl = null, price = null) {
    const p = price !== null && typeof price === 'object' ? price : { micro: this.micro(price), unitMicro: null }
    const floor = await this.gasQuote.depositFloorMicroUSD(p.micro)
    const q = await this.gasQuote.refund(false, false)
    const cover = q === null ? null : q.cover.microUSD
    const relayed = await this.gasQuote.relayRefundQuote()
    const gas = relayed !== null ? relayed.microUSD : q === null ? null : q.pay.microUSD
    const where = this.refundWhere(refundUrl)
    const about = (microUSD) => (microUSD === null ? '' : ` ($${Server.usd(microUSD)} now)`)
    const margin = relayed !== null ? relayed.marginPercent : Math.round((this.cfg.gasBuffer - 1) * 100)
    const figure = gas === null ? '' : `$${Server.usd(gas)} ${relayed !== null ? "at the relay's latest quote" : "by this seller's estimate"}, `
    return {
      pricing: pricing(p),
      deposit: `First call on a channel deposits at least $${Server.usd(floor)}. Later calls spend it. The unspent balance is refundable.`,
      refund: `Refund: ${where} with {channelId, issued, signature} signed by the payer; add channelConfig if the channel has no calls. ${refundRule(Math.round((this.cfg.gasBuffer - 1) * 100), margin)} Our fee is ${Server.percent(this.cfg.feeShare)}% of what the buyer spends, against the gas it must cover with the margin${about(cover)}. When it falls short, sign a gasless USDC payment of the refund gas (${figure}${margin}% margin included); a refund request answers with the figure to sign. An unsettled call adds its claim gas. {"selfSend": true}: a signed refund you send from any wallet at your own gas.`,
      split: this.cfg.relaySplit(),
    }
  }

  sharing() {
    const memo = new Map()
    const encode = Json.sharing()
    return {
      once: (key, make) => {
        if (!memo.has(key)) memo.set(key, make())
        return memo.get(key)
      },
      size: (doc) => 4 * Math.ceil(Buffer.byteLength(encode(doc), 'utf8') / 3),
      base64: (doc) => Buffer.from(encode(doc), 'utf8').toString('base64'),
    }
  }

  async paymentRequired(resource, extensions = null, refundUrl = null, more = {}, price = null, shared = null) {
    const p = price !== null && typeof price === 'object' ? price : { micro: this.micro(price), unitMicro: null }
    let doc = Server.document(Server.resourceInfo(resource), null, this.accepts(p.micro))
    if (extensions && (Array.isArray(extensions) ? extensions.length : Object.keys(extensions).length)) doc.extensions = extensions
    const said = shared ? shared.once(`terms\n${refundUrl}\n${p.micro}\n${p.unitMicro}\n${p.ms}\n${p.rateMicro}\n${p.rateMs}`, () => this.terms(refundUrl, p)) : this.terms(refundUrl, p)
    doc = { ...doc, ...(await said), ...more }
    const session = this.sessions !== null && Server.mppOffered(p) ? await this.sessions.challenge(doc.resource, p.micro, shared) : null
    if (session !== null) doc.session = this.sessions.published()
    const headers = { 'PAYMENT-REQUIRED': shared ? shared.base64(forHeader(doc, shared.size)) : Json.base64(forHeader(doc)) }
    const challenge = Server.mppOffered(p) ? await this.mppChallenge(doc.resource, p.micro, shared) : null
    const challenges = [challenge, session].filter((c) => c !== null)
    if (challenges.length) {
      headers['WWW-Authenticate'] = challenges.map((c) => Challenge.header(c)).join(', ')
      headers['Cache-Control'] = 'no-store'
    }
    return { ok: false, status: 402, body: doc, headers }
  }

  static forSession(q) {
    const body = Object.fromEntries(Object.entries(q.body).filter(([k]) => k !== 'deposit'))
    return { ...q, body, headers: { ...q.headers, 'PAYMENT-REQUIRED': Json.base64(forHeader(body)) } }
  }

  static mppOffered(price) {
    return price === null || typeof price !== 'object' || ((price.unitMicro ?? null) === null && (price.ms ?? null) === null)
  }

  mppRealm(resource) {
    try {
      return new URL(Server.resourceInfo(resource).url).host || this.cfg.name
    } catch {
      return this.cfg.name
    }
  }

  mppAsset() {
    return this.cfg.assets.find((a) => a.eip3009) ?? null
  }

  mppExpect(resource, asset) {
    return { realm: this.mppRealm(resource), chainId: this.cfg.chainId, currency: asset.address, recipient: this.cfg.receiver, tokenDomain: Token.domain(asset.address, asset.name, asset.version !== null ? asset.version : '1', this.cfg.chainId) }
  }

  async mppFloorMicroUSD() {
    const gas = await this.gasQuote.microUSD(Math.ceil(this.cfg.gas.charge * this.cfg.gasBuffer), GasQuote.RECENT_SECS)
    return gas === null ? null : Math.ceil(gas / this.cfg.feeShare)
  }

  async mppQuote(micro, shared = null) {
    const asset = this.mppAsset()
    if (asset === null) return null
    const floor = await (shared ? shared.once('mppFloor', () => this.mppFloorMicroUSD()) : this.mppFloorMicroUSD())
    if (floor === null || this.micro(micro) < floor) return null
    return { asset, amount: this.cfg.unitsOfMicroUSD(asset, this.micro(micro)) }
  }

  async mppOffer(price, description = null) {
    const p = price !== null && typeof price === 'object' ? price : { micro: this.micro(price), unitMicro: null }
    if (!Server.mppOffered(p)) return null
    const q = await this.mppQuote(p.micro)
    if (q === null) return null
    const said = Server.resourceInfo({ url: '', description }).description
    return { amount: String(q.amount), currency: Address.checksum(q.asset.address), ...(typeof said === 'string' && said !== '' ? { description: sentenceCut(said, 120) } : {}), intent: EvmCharge.INTENT, method: EvmCharge.METHOD }
  }

  async mppOffers(price, description = null) {
    const p = price !== null && typeof price === 'object' ? price : { micro: this.micro(price), unitMicro: null }
    if (!Server.mppOffered(p)) return []
    const charge = await this.mppOffer(p, description)
    const request = this.sessions !== null ? await this.sessions.request(p.micro) : null
    const said = Server.resourceInfo({ url: '', description }).description
    const session = request === null ? null : { amount: request.amount, currency: request.currency, ...(typeof said === 'string' && said !== '' ? { description: sentenceCut(said, 120) } : {}), intent: this.sessions.constructor.INTENT, method: this.sessions.constructor.METHOD }
    return [charge, session].filter((o) => o !== null)
  }

  async mppChallenge(resource, micro, shared = null) {
    const q = await this.mppQuote(micro, shared)
    if (q === null) return null
    const res = Server.resourceInfo(resource)
    const request = EvmCharge.request({ amount: q.amount, currency: q.asset.address, recipient: this.cfg.receiver, chainId: this.cfg.chainId, decimals: q.asset.decimals })
    const expires = new Date(this.cfg.nowMs() + MPP_TTL_SECS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    return Challenge.issue(this.cfg.mppSecret(), { realm: this.mppRealm(resource), method: EvmCharge.METHOD, intent: EvmCharge.INTENT, request, expires, opaque: Challenge.once(), description: typeof res.description === 'string' ? sentenceCut(res.description, 120) : null })
  }

  async mppRefuse(resource, micro, error, refundUrl = null) {
    const q = Server.forSession(await this.paymentRequired(resource, null, refundUrl, {}, micro))
    return Server.refuse(402, { ...Problem.of(error), accepts: q.body.accepts }, q.headers)
  }

  async mppHold(headerValue, resource, price = null, refundUrl = null) {
    const micro = this.micro(price)
    const asset = this.mppAsset()
    let verified
    try {
      if (asset === null) throw new MppError('invalid-challenge', 'this seller takes no EIP-3009 token')
      const credential = Credential.parse(headerValue)
      verified = await EvmCharge.verify(this.cfg.mppSecret(), credential, this.mppExpect(resource, asset), Math.floor(this.cfg.nowMs() / 1000))
      if (verified.request.amount !== String(this.cfg.unitsOfMicroUSD(asset, micro))) throw new MppError('invalid-challenge', 'the challenge is for another price')
      if (!verified.ecdsa) {
        const digest = Token.transferDigest(this.mppExpect(resource, asset).tokenDomain, verified.authorization)
        if (!(await this.chain.isValidSignature(verified.payer, digest, verified.signature))) throw new MppError('verification-failed', 'the authorization signature is not valid for its payer')
      }
      const was = await this.mppHeld.entry(verified.replayKey)
      if (was?.sent) return await this.mppSent(verified, was, { resource, micro, asset: asset.address, refundUrl })
      if (await this.mppUsed(asset.address, verified)) throw new MppError('verification-failed', 'this authorization has already been used')
      if (BigInt(await this.chain.balanceOf(asset.address, verified.payer)) < BigInt(verified.authorization.value)) throw new MppError('verification-failed', 'the payer does not hold the amount')
    } catch (e) {
      if (!(e instanceof MppError)) throw e
      return this.mppRefuse(resource, micro, e, refundUrl)
    }
    if (!(await this.mppHeld.claim(verified.replayKey, Number(verified.authorization.validBefore) * 1000, this.cfg.nowMs()))) return this.mppRefuse(resource, micro, new MppError('verification-failed', 'this authorization is already in use'), refundUrl)
    return { ok: true, hold: { kind: 'mpp', verified, micro, resource: Server.resourceInfo(resource), asset: asset.address, refundUrl } }
  }

  async mppUsed(token, verified) {
    const out = await this.chain.call(token, Abi.encodeCall('authorizationState(address,bytes32)', [verified.payer, verified.authorization.nonce]))
    return BigInt(Hex.lower(out) === '0x' ? '0x0' : out) !== 0n
  }

  static usedIn(receipt, token, v) {
    return String(receipt?.status ?? '').toLowerCase() === '0x1' && (receipt.logs ?? []).some((l) => Address.equals(l.address, token) && String(l.topics?.[0] ?? '').toLowerCase() === AUTHORIZATION_USED && String(l.topics?.[1] ?? '').toLowerCase() === topicOf(v.payer) && String(l.topics?.[2] ?? '').toLowerCase() === v.authorization.nonce)
  }

  async mppNotShown(resource, micro, hash, refundUrl) {
    const out = await this.mppRefuse(resource, micro, new MppError('verification-failed', `the payment was sent in transaction ${hash} and the chain this seller reads does not show it yet, so this call was not delivered. Nothing more is sent for it. Send this credential again in ${MPP_SHOWN_RETRY_SECS}s: once the transfer shows, the call is delivered, once; if the transfer did not happen, nothing was charged.`, { code: 'sent_not_shown', txHash: hash, retry_after_seconds: MPP_SHOWN_RETRY_SECS }), refundUrl)
    out.headers = { ...out.headers, 'Retry-After': String(MPP_SHOWN_RETRY_SECS) }
    return out
  }

  async mppSent(verified, was, { resource, micro, asset, refundUrl }) {
    const key = verified.replayKey
    const refuse = (detail) => this.mppRefuse(resource, micro, new MppError('verification-failed', detail), refundUrl)
    const now = this.cfg.nowMs()
    const gone = was.state === 'sending' && now - Number(was.at ?? 0) > 2000 * this.cfg.receiptTimeoutSecs + 60000
    if (was.state === 'delivered') return refuse('this authorization has already been used')
    if (was.state !== 'sent' && !gone) return refuse('this authorization is already in use')
    let receipt
    try {
      receipt = await this.chain.receipt(was.sent)
    } catch {
      receipt = null
    }
    if (receipt === null) return this.mppNotShown(resource, micro, was.sent, refundUrl)
    if (Server.usedIn(receipt, asset, verified)) {
      if (!(await this.mppHeld.mark(key, was.state, { state: 'taken', at: now }))) return refuse('this authorization is already in use')
      return { ok: true, hold: { kind: 'mpp', verified, micro, resource: Server.resourceInfo(resource), asset, refundUrl, landed: was.sent } }
    }
    let used
    try {
      used = await this.mppUsed(asset, verified)
    } catch {
      return this.mppNotShown(resource, micro, was.sent, refundUrl)
    }
    if (used) return refuse('this authorization has already been used')
    if (!(await this.mppHeld.mark(key, was.state, { state: 'settled', at: now }))) return refuse('this authorization is already in use')
    await this.mppHeld.release(key)
    return refuse(`the payment did not settle. Not delivered; nothing was charged. Transaction ${was.sent} ${String(receipt.status ?? '').toLowerCase() === '0x1' ? 'did not use this authorization' : 'reverted'}.`)
  }

  async mppLanded(hold) {
    const v = hold.verified
    if (!(await this.mppHeld.mark(v.replayKey, 'taken', { state: 'delivered', at: this.cfg.nowMs() }))) return this.mppRefuse(hold.resource, hold.micro, new MppError('verification-failed', 'this authorization is already in use'), hold.refundUrl ?? null)
    return this.mppDelivered(v, hold.landed)
  }

  mppDelivered(v, hash) {
    const response = { success: true, transaction: Hex.lower(hash), network: this.cfg.network, payer: v.payer, amount: v.authorization.value, extra: { protocol: 'mpp', method: EvmCharge.METHOD, intent: EvmCharge.INTENT, challengeId: v.challenge.id } }
    return { ok: true, status: 200, response, headers: { 'Payment-Receipt': Receipt.header(EvmCharge.receipt(v, hash, new Date(this.cfg.nowMs()).toISOString())) } }
  }

  async mppRelease(hold) {
    if (hold.landed) {
      await this.mppHeld.mark(hold.verified.replayKey, 'taken', { state: 'sent' })
      return
    }
    await this.mppHeld.release(hold.verified.replayKey)
  }

  async mppSettle(hold) {
    const v = hold.verified
    if (hold.landed) return this.mppLanded(hold)
    const fail = async (detail) => {
      await this.mppRelease(hold)
      return this.mppRefuse(hold.resource, hold.micro, new MppError('verification-failed', `the payment did not settle. Not delivered; nothing was charged. ${String(detail).slice(0, 200)}`), hold.refundUrl ?? null)
    }
    const lost = async (detail, sent = false) => {
      const tries = sent && /revert/i.test(String(detail)) ? MPP_USED_TRIES : 1
      for (let i = 0; i < tries; i++) {
        if (i > 0) await this.cfg.sleepMs(this.cfg.receiptPollMs)
        let used
        try {
          used = await this.mppUsed(hold.asset, v)
        } catch {
          break
        }
        if (used) return this.mppRefuse(hold.resource, hold.micro, new MppError('verification-failed', 'this authorization has already been used'), hold.refundUrl ?? null)
      }
      return fail(detail)
    }
    let hash
    let asked = false
    const notShown = async () => {
      await this.mppHeld.mark(v.replayKey, 'sending', { state: 'sent' })
      return this.mppNotShown(hold.resource, hold.micro, hash, hold.refundUrl ?? null)
    }
    try {
      const call = EvmCharge.call(v)
      try {
        await this.chain.call(call.to, call.data, this.cfg.receiver)
      } catch (e) {
        return await lost(`the transfer would revert: ${message(e)}`)
      }
      asked = true
      const sent = await this.relay.send([call], this.cfg.relaySplit())
      hash = sent[0]?.hash
      if (hash === undefined) return await lost(sent[0]?.error ?? 'the relay sent nothing', true)
      hash = Hex.lower(hash)
      await this.mppHeld.mark(v.replayKey, null, { sent: hash, state: 'sending', at: this.cfg.nowMs() })
      const receipt = await this.waitForReceipt(hash)
      if (receipt === null) return await notShown()
      if (String(receipt.status ?? '').toLowerCase() !== '0x1') return await lost(`transaction ${hash} reverted`)
      if (!Server.usedIn(receipt, call.to, v)) return await fail(`transaction ${hash} did not use this authorization`)
      await this.mppHeld.mark(v.replayKey, 'sending', { state: 'delivered', at: this.cfg.nowMs() })
      return this.mppDelivered(v, hash)
    } catch (e) {
      return hash === undefined ? lost(message(e), asked) : notShown()
    }
  }

  static refuse(status, body, headers = {}) {
    return { ok: false, status, body, headers }
  }

  static channelIdOf(payload) {
    const raw = payload && isObject(payload.payload) ? payload.payload : {}
    const id = raw.voucher?.channelId !== undefined && raw.voucher?.channelId !== null ? raw.voucher.channelId : raw.channelId !== undefined && raw.channelId !== null ? raw.channelId : null
    return typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id) ? id.toLowerCase() : null
  }

  match(accepts, payload) {
    const version = payload.x402Version ?? null
    const accepted = payload.accepted !== null && typeof payload.accepted === 'object' ? payload.accepted : null
    if (accepted === null) return null
    for (const req of accepts) {
      if (version === 2) {
        const { extra: _r, ...reqCore } = req
        const { extra: _a, ...accCore } = accepted
        if (Json.deepEqual(reqCore, accCore) && Json.containsSubset(req.extra, accepted.extra ?? null)) return req
      } else if (version === 1) {
        if (accepted.scheme !== undefined && accepted.scheme !== null && accepted.network !== undefined && accepted.network !== null && req.scheme === accepted.scheme && req.network === accepted.network) return req
      }
    }
    return null
  }

  static provisional(raw, charged, now) {
    return {
      channelId: raw.voucher.channelId,
      channelConfig: raw.channelConfig,
      chargedCumulativeAmount: String(charged),
      signedMaxClaimable: Verify.uint(raw.voucher.maxClaimableAmount).toString(),
      signature: raw.voucher.signature,
      balance: '0',
      totalClaimed: '0',
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: now,
    }
  }

  static inferCharged(signedMax, price) {
    const signed = Verify.uint(signedMax)
    const amount = Verify.uint(price)
    return signed < amount ? '0' : (signed - amount).toString()
  }

  static channelState(c, charged = null) {
    const out = { channelId: c.channelId, balance: c.balance, totalClaimed: c.totalClaimed, withdrawRequestedAt: c.withdrawRequestedAt, refundNonce: String(c.refundNonce) }
    if (charged !== null && charged !== undefined) out.chargedCumulativeAmount = String(charged)
    return out
  }

  async enrich(accepts, error, payload, snapshot, escrow = this.escrows.default) {
    if (error !== escrow.reasons.CUMULATIVE_AMOUNT_MISMATCH) return accepts
    const raw = payload.payload ?? null
    if (!Verify.isVoucherPayload(raw) && !Verify.isDepositPayload(raw) && !Verify.isRefundPayload(raw)) return accepts
    const network = payload.accepted?.network ?? null
    let channel
    try {
      if (Verify.bindingError(raw.channelConfig, raw.voucher.channelId, network, escrow)) return accepts
      channel = snapshot !== null && snapshot !== undefined ? snapshot : await this.store.get(String(raw.voucher.channelId).toLowerCase())
    } catch {
      return accepts
    }
    if (channel === null) return accepts
    const out = clone(accepts)
    for (const req of out) {
      if (req.scheme === escrow.scheme && req.network === network) {
        req.extra.channelState = Server.channelState(channel, channel.chargedCumulativeAmount)
        req.extra.voucherState = { signedMaxClaimable: channel.signedMaxClaimable, signature: channel.signature }
        break
      }
    }
    return out
  }

  static stateIn(accepts) {
    for (const a of accepts) if (a.extra?.channelState !== undefined) return a.extra.channelState
    return null
  }

  fundingRefusal(payload, accepts, floor, price = this.cfg.priceMicroUSD) {
    const quoted = this.quotedMicroUSD(payload)
    if (quoted + 1 < price) {
      return { error: 'price_changed', code: 'price_changed', quotedMicroUSD: quoted, neededMicroUSD: floor, message: `the price is ${price} micro-USD per call. Pay the accepts quote. Nothing was charged.`, accepts }
    }
    const deposit = this.depositMicroUSD(payload)
    return {
      error: 'funding_requires_open_fee',
      code: 'funding_requires_open_fee',
      quotedMicroUSD: quoted,
      depositMicroUSD: deposit,
      neededMicroUSD: floor,
      message: `deposit ${deposit} micro-USD is under the ${floor} micro-USD floor. Deposit at least ${floor} micro-USD; each call costs up to ${quoted} micro-USD; the unspent balance is refundable. Nothing was charged.`,
      accepts,
    }
  }

  quotedMicroUSD(payload) {
    try {
      const acc = payload.accepted ?? {}
      const v = this.cfg.microUSDOf(acc.asset ?? '', Verify.uint(acc.amount ?? '0').toString())
      return v === null ? 0 : v
    } catch {
      return 0
    }
  }

  depositMicroUSD(payload) {
    try {
      const acc = payload.accepted ?? {}
      const amount = payload.payload?.deposit?.amount ?? '0'
      const v = this.cfg.microUSDOf(acc.asset ?? '', Verify.uint(amount).toString())
      return v === null ? 0 : v
    } catch {
      return 0
    }
  }

  malformed(paymentHeaderValue, refundUrl = null) {
    const payload = Json.decodeHeader(paymentHeaderValue)
    if (payload === null) return Server.refuse(400, { error: 'bad_payment_header', message: 'the payment does not decode. Over HTTP, send base64 of the PaymentPayload JSON in the PAYMENT-SIGNATURE header; over MCP, send the PaymentPayload object in params._meta["x402/payment"].' })
    const raw = isObject(payload.payload) || Array.isArray(payload.payload) ? payload.payload : null
    const kind = raw !== null ? raw.type ?? null : null
    const batch = this.escrows.offering(payload.scheme) !== null || this.escrows.offering(payload.accepted?.scheme) !== null || (kind !== null && kind !== '' && kind !== false && kind !== 0)
    if (batch && kind !== 'voucher' && kind !== 'deposit') return Server.refuse(400, { error: 'bad_payment_type', message: `a paid call carries a voucher or a deposit. Refunds: ${this.refundWhere(refundUrl)}. Nothing was charged.` })
    if (!Verify.normalize(raw)) return Server.refuse(400, { error: 'bad_payment_header', message: `${Verify.AMOUNT_FORM}. Nothing was charged.` })
    return null
  }

  async verifyAndHold(paymentHeaderValue, resource, price = null, refundUrl = null) {
    const micro = this.micro(price)
    const res = Server.resourceInfo(resource)
    const accepts = this.accepts(micro)
    const bad = this.malformed(paymentHeaderValue, refundUrl)
    if (bad !== null) return bad
    const payload = Json.decodeHeader(paymentHeaderValue)
    const raw = isObject(payload.payload) || Array.isArray(payload.payload) ? payload.payload : null
    Verify.normalize(raw)
    const kind = raw !== null ? raw.type ?? null : null
    const escrow = this.escrowOf(payload.accepted?.scheme ?? payload.scheme)
    const MISMATCH = escrow.reasons.CUMULATIVE_AMOUNT_MISMATCH
    const cid = Server.channelIdOf(payload)
    const judgedBy = this.cfg.nowMs() + this.channels.judgeWaitMs()
    let ch = null
    if (cid !== null) {
      try {
        ch = await this.channels.repaired(cid)
      } catch (e) {
        if (e instanceof UnknownEscrow) return Server.unserved(e)
        ch = null
      }
    }
    if (ch !== null) {
      if (this.escrows.of(ch) !== escrow) return Server.unserved(new UnknownEscrow(this.escrows.of(ch).kind))
      const seen = await this.channels.untilAnswered(cid, judgedBy, (g, r, now, asked) => (asked && now < judgedBy ? { wait: this.channels.waiter(g) } : { r }))
      ch = seen.r ?? ch
      if (seen.settling !== undefined) {
        const secs = seen.settling
        return Server.refuse(402, { error: 'refund_settling', code: 'refund_settling', message: `a refund is settling on this channel, retry in ${secs}s. Nothing was charged.`, retry_after_seconds: secs })
      }
      if (await this.channels.leaving(ch)) return Server.refuse(402, { error: 'channel_leaving', code: 'channel_leaving', message: 'this channel is withdrawing. Open a new channel. Nothing was charged.' })
      if (!empty(ch.handedOver)) {
        return Server.refuse(402, {
          error: 'refund_outstanding',
          code: 'refund_outstanding',
          transaction: ch.handedOver.transaction ?? null,
          message: 'this channel has an unsent signed refund. Send it (transaction here), then deposit again. Nothing was charged.',
        })
      }
      if (kind === 'deposit') {
        let left = 0n
        let price = 0n
        try {
          left = Channels.n(ch.balance) - Channels.max(ch.chargedCumulativeAmount, ch.totalClaimed)
          price = Verify.uint(payload.accepted?.amount ?? '0')
        } catch {
          price = 0n
        }
        if (price > 0n && left >= price && this.quotedMicroUSD(payload) + 1 >= micro && this.match(accepts, payload) !== null) {
          const enriched = await this.enrich(accepts, MISMATCH, payload, null, escrow)
          if (Server.stateIn(enriched) !== null) {
            const corrected = Server.document(res, MISMATCH, enriched)
            const body = { ...corrected, code: 'payment_invalid', reason: 'channel_funded', message: 'this channel is funded. Pay with a voucher. Nothing was charged.', channelState: Server.stateIn(enriched) }
            return Server.refuse(402, body, { 'PAYMENT-REQUIRED': Json.base64(corrected) })
          }
        }
      }
    }
    const match = this.match(accepts, payload)
    if (kind === 'deposit') {
      const floor = await this.gasQuote.depositFloorMicroUSD(micro)
      if (this.quotedMicroUSD(payload) + 1 < micro || (match !== null && this.depositMicroUSD(payload) < floor)) return Server.refuse(402, this.fundingRefusal(payload, accepts, floor, micro))
    }
    if (match === null) return Server.refuse(402, { error: 'no_matching_requirement', message: 'the payment matches no requirement here', accepts })
    const ctx = { snapshot: null }
    let verified = await this.verifyPayment(payload, match, ctx, judgedBy)
    while (verified.held !== undefined) {
      await this.channels.waited(verified.held, judgedBy)
      verified = await this.verifyPayment(payload, match, ctx, judgedBy)
    }
    if (verified.invalidReason === Reason.REFUND_SETTLING) {
      const secs = Channels.refundingRetrySecs(this.cfg, await this.channels.get(cid), this.cfg.nowMs())
      return Server.refuse(402, { error: 'refund_settling', code: 'refund_settling', message: `a refund is settling on this channel, retry in ${secs}s. Nothing was charged.`, retry_after_seconds: secs })
    }
    if (!verified.isValid) {
      const reason = verified.invalidReason ?? null
      const error = escrow.stale(reason) ? MISMATCH : reason
      const enriched = await this.enrich(accepts, error, payload, ctx.snapshot, escrow)
      const corrected = Server.document(res, error, enriched)
      const body = { error: error ?? 'payment_invalid', code: 'payment_invalid', message: 'the payment did not verify' }
      if (reason !== null) body.reason = reason
      body.accepts = enriched
      const state = Server.stateIn(enriched)
      if (state !== null) body.channelState = state
      return Server.refuse(402, body, { 'PAYMENT-REQUIRED': Json.base64(corrected) })
    }
    return { ok: true, hold: { kind, channelId: ctx.channelId, pendingId: ctx.pendingId, payload, requirement: match, resource: res, payer: verified.payer, micro } }
  }

  static movedSince(seen, current) {
    if (seen === null || seen === undefined || current === null || current === undefined) return false
    const at = (r, k) => (r[k] === undefined || r[k] === null ? '' : String(r[k]))
    return at(seen, 'refundNonce') !== at(current, 'refundNonce') || at(seen, 'balance') !== at(current, 'balance') || empty(seen.handedOver) !== empty(current.handedOver)
  }

  async verifyPayment(payload, req, ctx, judgedBy = 0, tries = 0) {
    const raw = payload.payload
    const escrow = this.escrowOf(req.scheme)
    const verify = this.verifiers.get(escrow)
    const R = escrow.reasons
    const MISMATCH = R.CUMULATIVE_AMOUNT_MISMATCH
    let local = null
    let normMax = null
    let seen = null
    const now = this.cfg.nowMs()
    if (Verify.isVoucherPayload(raw) || Verify.isDepositPayload(raw)) {
      try {
        normMax = Verify.amount(raw.voucher.maxClaimableAmount).toString()
      } catch {
        return Verify.invalid(R.PAYLOAD_TYPE, null, Verify.AMOUNT_FORM)
      }
      try {
        const bind = Verify.bindingError(raw.channelConfig, raw.voucher.channelId, req.network, escrow)
        if (bind) return Verify.invalid(bind)
        const cid = String(raw.voucher.channelId).toLowerCase()
        const snapshot = await this.store.get(cid)
        seen = snapshot
        const charged = snapshot !== null && snapshot.chargedCumulativeAmount !== undefined && snapshot.chargedCumulativeAmount !== null ? String(snapshot.chargedCumulativeAmount) : Server.inferCharged(raw.voucher.maxClaimableAmount, req.amount)
        const expected = BigInt(charged) + Verify.uint(req.amount)
        if (Channels.pendingLive(snapshot, now)) return Verify.invalid(R.CHANNEL_BUSY)
        if (Verify.uint(raw.voucher.maxClaimableAmount) !== expected) {
          ctx.snapshot = snapshot !== null ? snapshot : Server.provisional(raw, charged, now)
          return Verify.invalid(MISMATCH)
        }
        ctx.snapshot = snapshot
        ctx.channelId = cid
        ctx.pendingId = '0x' + randomBytes(32).toString('hex')
        if (Verify.isVoucherPayload(raw)) local = await verify.local(raw, req, snapshot, now)
      } catch {
        return Verify.invalid(R.VERIFICATION_STATE_UNAVAILABLE)
      }
    }
    const result = local !== null ? local : await verify.facilitator(payload, req)
    if (!result.isValid || !result.payer) return result
    if (ctx.pendingId === undefined) return Verify.invalid(R.VERIFICATION_STATE_UNAVAILABLE)
    const ex = result.extra ?? {}
    let record = null
    let outcome = null
    const pendingId = ctx.pendingId
    const expiresAt = now + Math.min(MAX_PENDING_TTL_MS, Math.max(MIN_PENDING_TTL_MS, Math.max(0, Math.trunc(Number(req.maxTimeoutSeconds))) * 1000))
    const isLocal = local !== null
    let held = null
    try {
      await this.channels.serial(ctx.channelId, (g) => {
        const at = this.cfg.nowMs()
        if (Channels.asked(g, at) && at < judgedBy) {
          outcome = 'held'
          held = this.channels.waiter(g)
          return null
        }
        return this.store.update(ctx.channelId, (current) => {
          if (Channels.refundingWaitMs(current, now) > 0) {
            outcome = 'refunding'
            return current
          }
          if (Channels.pendingLive(current, now)) {
            outcome = 'busy'
            return current
          }
          if (Server.movedSince(seen, current)) {
            outcome = 'moved'
            record = current
            return current
          }
          const base = current !== null && current.chargedCumulativeAmount !== undefined && current.chargedCumulativeAmount !== null ? String(current.chargedCumulativeAmount) : Server.inferCharged(raw.voucher.maxClaimableAmount, req.amount)
          const expected = BigInt(base) + Verify.uint(req.amount)
          if (Verify.uint(raw.voucher.maxClaimableAmount) !== expected) {
            outcome = 'stale'
            record = current !== null ? current : Server.provisional(raw, base, now)
            return current
          }
          const next = {
            channelId: raw.voucher.channelId,
            channelConfig: raw.channelConfig,
            chargedCumulativeAmount: base,
            signedMaxClaimable: normMax,
            signature: raw.voucher.signature,
            balance: ex.balance !== undefined && ex.balance !== null ? String(ex.balance) : '0',
            totalClaimed: ex.totalClaimed !== undefined && ex.totalClaimed !== null ? String(ex.totalClaimed) : '0',
            withdrawRequestedAt: ex.withdrawRequestedAt !== undefined && ex.withdrawRequestedAt !== null ? Math.trunc(Number(ex.withdrawRequestedAt)) : 0,
            refundNonce: ex.refundNonce !== undefined && ex.refundNonce !== null ? Math.trunc(Number(ex.refundNonce)) : 0,
          }
          const synced = isLocal ? (current !== null && current.onchainSyncedAt !== undefined && current.onchainSyncedAt !== null ? current.onchainSyncedAt : null) : now
          if (synced !== null) next.onchainSyncedAt = synced
          next.lastRequestTimestamp = now
          next.pendingRequest = { pendingId, signedMaxClaimable: normMax, expiresAt }
          for (const [k, v] of Object.entries(current ?? {})) if (!SDK_FIELDS.includes(k)) next[k] = v
          Object.assign(next, this.escrows.tag(escrow))
          outcome = 'reserved'
          record = next
          return next
        })
      })
    } catch {
      return Verify.invalid(R.VERIFICATION_STATE_UNAVAILABLE)
    }
    if (outcome === 'held') return { ...Verify.invalid(Reason.REFUND_SETTLING), held }
    if (outcome === 'refunding') return Verify.invalid(Reason.REFUND_SETTLING)
    if (outcome === 'busy') return Verify.invalid(R.CHANNEL_BUSY)
    if (outcome === 'moved' && tries < MOVED_TRIES) return this.verifyPayment(payload, req, ctx, judgedBy, tries + 1)
    if (outcome === 'stale' || outcome === 'moved') {
      ctx.snapshot = record
      return Verify.invalid(MISMATCH)
    }
    ctx.snapshot = record
    return result
  }

  release(hold) {
    return this.channels.release(hold.channelId, hold.pendingId)
  }

  async depositShort(hold, payload, needed) {
    await this.release(hold)
    return Server.refuse(402, this.fundingRefusal(payload, this.accepts(hold.micro), needed, this.micro(hold.micro)))
  }

  async settleFailed(hold, reason) {
    await this.release(hold)
    const accepts = this.accepts(hold.micro)
    const doc = Server.document(hold.resource, 'settle_failed', accepts)
    return Server.refuse(402, {
      error: 'settle_failed',
      code: 'settle_failed',
      message: 'the payment did not settle. Not delivered; nothing was charged.',
      reason: String(reason).slice(0, 200),
      accepts,
    }, { 'PAYMENT-REQUIRED': Json.base64(doc) })
  }

  static delivered(response) {
    return { ok: true, status: 200, response, headers: { 'PAYMENT-RESPONSE': Json.base64(response) } }
  }

  static chargeOf(hold, charge) {
    const reserved = Verify.uint(hold.requirement.amount)
    if (charge === null || charge === undefined) return reserved
    const c = BigInt(charge)
    if (c < 0n || c > reserved) throw new RangeError(`a charge of ${c} is outside 0 to the reserved ${reserved}`)
    return c
  }

  static owe(record, hold) {
    if (!Number.isSafeInteger(hold.owedMs) || hold.owedMs <= 0) return
    record.timeOwed = { ...(record.timeOwed !== null && typeof record.timeOwed === 'object' ? record.timeOwed : {}), [hold.pendingId]: hold.owedMs }
  }

  static chargedExtra(hold, charged, extra = {}) {
    const reserved = String(hold.requirement.amount)
    return { ...extra, chargedAmount: String(charged), reservedAmount: reserved }
  }

  async settle(hold, charge = null) {
    try {
      const c = Server.chargeOf(hold, charge)
      if (hold.kind === 'voucher') return await this.settleVoucher(hold, c)
      if (hold.kind === 'deposit') return await this.settleDeposit(hold, c)
      return await this.settleFailed(hold, this.escrowOf(hold.requirement?.scheme).reasons.PAYLOAD_TYPE)
    } catch (e) {
      return this.settleFailed(hold, message(e))
    }
  }

  async settleVoucher(hold, increment = Verify.uint(hold.requirement.amount)) {
    const req = hold.requirement
    const escrow = this.escrowOf(req.scheme)
    const R = escrow.reasons
    const voucher = hold.payload.payload.voucher
    const cap = Verify.uint(voucher.maxClaimableAmount)
    const pendingId = hold.pendingId
    const now = this.cfg.nowMs()
    let outcome = null
    let previous = null
    let charged = null
    await this.channels.serial(hold.channelId, () => this.store.update(hold.channelId, (current) => {
        if (current === null) {
          outcome = 'missing'
          return current
        }
        if (current.pendingRequest?.pendingId === undefined || current.pendingRequest.pendingId !== pendingId) {
          outcome = 'pending_mismatch'
          return current
        }
        const next = BigInt(String(current.chargedCumulativeAmount)) + increment
        if (next > cap) {
          outcome = 'cap_exceeded'
          delete current.pendingRequest
          return current
        }
        previous = clone(current)
        charged = next.toString()
        current.chargedCumulativeAmount = charged
        current.signedMaxClaimable = cap.toString()
        current.signature = voucher.signature
        current.lastRequestTimestamp = now
        Server.owe(current, hold)
        delete current.pendingRequest
        outcome = 'committed'
        return current
    }))
    if (outcome === 'missing') return this.settleFailed(hold, R.MISSING_CHANNEL)
    if (outcome === 'cap_exceeded') return this.settleFailed(hold, R.CHARGE_EXCEEDS_SIGNED_CUMULATIVE)
    if (outcome !== 'committed') return this.settleFailed(hold, R.CHANNEL_BUSY)
    return Server.delivered({
      success: true,
      payer: String(escrow.payer(previous.channelConfig)).toLowerCase(),
      transaction: '',
      network: req.network,
      amount: '',
      extra: Server.chargedExtra(hold, increment, { channelState: Server.channelState(previous, charged) }),
    })
  }

  async settleDeposit(hold, increment = Verify.uint(hold.requirement.amount)) {
    const req = hold.requirement
    const escrow = this.escrowOf(req.scheme)
    const R = escrow.reasons
    const payload = hold.payload
    const raw = payload.payload
    const channelId = hold.channelId
    await this.channels.repaired(channelId)
    const floor = await this.gasQuote.depositFloorMicroUSD(this.micro(hold.micro))
    const quoted = Math.trunc(Number(this.cfg.microUSDOf(req.asset, req.amount)))
    const arriving = Math.trunc(Number(this.cfg.microUSDOf(req.asset, Verify.uint(raw.deposit.amount).toString())))
    if (quoted + 1 < this.micro(hold.micro) || arriving < floor) return this.depositShort(hold, payload, floor)
    const verified = await this.verifiers.get(escrow).facilitator(payload, req)
    if (!verified.isValid) return this.settleFailed(hold, verified.invalidReason ?? R.PAYLOAD_TYPE)
    const execution = verified.execution
    const amount = Verify.uint(raw.deposit.amount).toString()
    const sent = await this.relay.send([escrow.depositCall(raw.channelConfig, amount, execution)], this.cfg.relaySplit())
    const hash = sent[0]?.hash
    if (hash === undefined) {
      const short = /below break-even: deposit at least \$(\d+(?:\.\d+)?)/.exec(String(sent[0]?.error ?? ''))
      if (short !== null) return this.depositShort(hold, payload, Math.ceil(Number(short[1]) * 1e6))
    }
    try {
      return await this.depositSent(hold, escrow, verified, amount, increment, hash, sent[0]?.error)
    } catch (e) {
      if (hash === undefined) throw e
      return this.depositUnsettled(hold, hash, message(e))
    }
  }

  async depositSent(hold, escrow, verified, amount, increment, hash, refused) {
    const req = hold.requirement
    const R = escrow.reasons
    const raw = hold.payload.payload
    const channelId = hold.channelId
    const receipt = hash === undefined ? null : await this.waitForReceipt(hash)
    if (receipt !== null && (receipt.status === undefined || receipt.status === null || String(receipt.status).toLowerCase() !== '0x1')) return this.settleFailed(hold, `${R.DEPOSIT_TRANSACTION_FAILED}: transaction reverted (receipt status reverted)`)
    const ex = verified.extra
    let state = {
      channelId: raw.voucher.channelId,
      balance: (BigInt(String(ex.balance)) + BigInt(amount)).toString(),
      totalClaimed: String(ex.totalClaimed),
      withdrawRequestedAt: Math.trunc(Number(ex.withdrawRequestedAt)),
      refundNonce: String(ex.refundNonce),
    }
    const post = await this.depositOnChain(channelId, escrow, BigInt(state.balance))
    if (receipt === null && post === null) {
      if (hash === undefined) return this.settleFailed(hold, `${R.DEPOSIT_TRANSACTION_FAILED}: ${refused ?? 'no hash'}`)
      return this.depositUnsettled(hold, hash, `${R.DEPOSIT_TRANSACTION_FAILED}: no receipt for ${hash}`)
    }
    if (post !== null) state = { channelId: raw.voucher.channelId, balance: post.balance, totalClaimed: post.totalClaimed, withdrawRequestedAt: post.withdrawRequestedAt, refundNonce: post.refundNonce }
    const pendingId = hold.pendingId
    const now = this.cfg.nowMs()
    let record = null
    await this.channels.serial(channelId, () => this.store.update(channelId, (current) => {
        if (current === null || current.pendingRequest?.pendingId === undefined || current.pendingRequest.pendingId !== pendingId) return current
        const next = {
          channelId: raw.voucher.channelId,
          channelConfig: raw.channelConfig,
          chargedCumulativeAmount: (BigInt(String(current.chargedCumulativeAmount)) + increment).toString(),
          signedMaxClaimable: Verify.uint(raw.voucher.maxClaimableAmount).toString(),
          signature: raw.voucher.signature,
          balance: state.balance,
          totalClaimed: state.totalClaimed,
          withdrawRequestedAt: Math.trunc(Number(state.withdrawRequestedAt)),
          refundNonce: Math.trunc(Number(state.refundNonce)),
          onchainSyncedAt: now,
          lastRequestTimestamp: now,
        }
        for (const [k, v] of Object.entries(current)) if (!SDK_FIELDS.includes(k)) next[k] = v
        Object.assign(next, this.escrows.tag(escrow))
        const heldBefore = BigInt(String(ex.balance)) > 0n || BigInt(String(ex.totalClaimed)) > 0n
        next.depositsWePaid = (current.depositsWePaid !== undefined ? Math.trunc(Number(current.depositsWePaid)) : heldBefore ? 1 : 0) + 1
        Server.owe(next, hold)
        record = next
        return next
    }))
    if (record === null) return this.depositLate(hold, `${R.CHANNEL_BUSY}: ${hash === undefined ? 'the deposit' : `deposit ${hash}`} landed after the hold expired`)
    const extra = Server.chargedExtra(hold, increment, { channelState: { ...state, chargedCumulativeAmount: record.chargedCumulativeAmount } })
    const response = { success: true, transaction: hash ?? '', network: req.network, payer: escrow.payer(raw.channelConfig), amount: raw.deposit.amount, extra }
    response.extra.depositAmount = response.amount
    if (String(response.amount) !== String(req.amount)) {
      response.amount = String(req.amount)
    }
    return Server.delivered(response)
  }

  async depositOnChain(channelId, escrow, expected) {
    const deadline = this.cfg.nowMs() + this.cfg.stateCatchUpMs
    const reads = Math.ceil(this.cfg.stateCatchUpMs / 150) + 1
    for (let read = 1; ; read++) {
      let post
      try {
        post = await this.chain.state(channelId, escrow)
      } catch {
        post = null
      }
      if (post !== null && BigInt(post.balance) >= expected) return post
      if (this.cfg.nowMs() >= deadline || read >= reads) return null
      await this.cfg.sleepMs(150)
    }
  }

  async depositUnsettled(hold, hash, reason) {
    return this.depositAnswer(hold, reason, `the deposit was sent (${hash}) and has not landed yet, so this call was not delivered. If it lands, your channel holds it: pay the next call with a voucher.`)
  }

  async depositLate(hold, reason) {
    return this.depositAnswer(hold, reason, 'the deposit landed in your channel after this call was given up, so this call was not delivered and not charged. Your channel holds the deposit: pay the next call with a voucher.')
  }

  async depositAnswer(hold, reason, said) {
    const out = await this.settleFailed(hold, reason)
    out.body.message = said
    return out
  }

  async waitForReceipt(hash) {
    const deadline = this.cfg.nowMs() + 1000 * this.cfg.receiptTimeoutSecs
    const reads = Math.ceil((1000 * this.cfg.receiptTimeoutSecs) / Math.max(1, this.cfg.receiptPollMs)) + 1
    for (let read = 1; ; read++) {
      let r
      try {
        r = await this.chain.receipt(hash)
      } catch {
        r = null
      }
      if (r !== null) return r
      if (this.cfg.nowMs() >= deadline || read >= reads) return null
      await this.cfg.sleepMs(this.cfg.receiptPollMs)
    }
  }
}

