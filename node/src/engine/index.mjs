import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Abi } from './core/abi.mjs'
import { Address, big } from './core/hex.mjs'
import { Erc20 } from './core/batch.mjs'
import { writeAtomic, withLock } from './files.mjs'
import { loadKeys } from './keys.mjs'
import { setting } from './env.mjs'
import { ChannelFileStore, GateFileStore, MppHeldFiles, SentFileStore, StateFile } from './stores.mjs'
import { FAILED_CALL } from './discovery.mjs'
import { Admission, Credits, Exact, Meter, gateHttp } from './gate/index.mjs'
import { Chain } from './settlement/chain.mjs'
import { Channels } from './settlement/channels.mjs'
import { Config } from './settlement/config.mjs'
import { Json } from './settlement/json.mjs'
import { Claims, Refunds, Withdrawals } from './settlement/periodic.mjs'
import { GasQuote, Payout, Relay, httpTransport } from './settlement/relay.mjs'
import { Server } from './settlement/server.mjs'
import { ESCROWS, X402BatchSettlement } from './settlement/x402.mjs'
import { Escrows } from './settlement/escrow.mjs'
import { sessionEscrow } from './settlement/session.mjs'
import { Sessions } from './settlement/sessions.mjs'
import { charge as chargeFor, microOf } from './pricing.mjs'
import { TimeMeter, timeOptions } from './meter.mjs'
import { ZEAM } from './zeam.mjs'

export const DEFAULTS = {
  relay: 'https://api.zeampass.com/relay',
  credits: 'https://api.zeampass.com/credits',
  rpc: 'https://mainnet.base.org',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  tickSeconds: 60,
}
export const CONTRACTS = Object.freeze({
  escrow: ESCROWS.default.contracts.escrow,
  collectors: ESCROWS.default.contracts.collectors,
  permit2: Chain.PERMIT2,
})
export const feeRecipient = () => ZEAM.feeRecipient
const MODES = ['paywall', 'gate', 'both']
const GATE_HOW = 'Sign the zero-amount requirement with any x402 client and your own key. Nothing is paid. The key must be admitted here, or send an x-grant from an admitted key.'
const ADMISSION = 'Only admitted keys pay here, or keys with an x-grant from an admitted key.'
const OUT_OF_CHECKS = 'This gate has no checks left this month. Retry later.'
const BAD_GRANT_HOW = 'Send a new x-grant: signed by an admitted key, delegate = the key that signs this call. ZEAM Pass agent guide, section 3.'
const CONTACT = /^(?:https?:\/\/[^\s/?#]+\S*|mailto:[^\s@]+@[^\s@]+)$/i
export const refusedHow = (contact = null) => `Ask this seller to admit your key${contact ? ` (${contact})` : ''}, or send an x-grant signed by an admitted key. ZEAM Pass agent guide, section 3.`
export const GRANTED_BY = 'X-Pass-Granted-By'
const TUNABLE = ['withdrawDelay', 'maxTimeoutSeconds', 'depositFloorMicroUSD', 'wethUSD', 'gasPriceWei', 'feeShare', 'gasBuffer', 'floorMargin', 'idleClaimSecs', 'maxClaimsPerBatch', 'payoutMinUnits', 'refundWindowSecs', 'receiptTimeoutSecs', 'receiptPollMs', 'stateCatchUpMs', 'drainTries', 'drainWaitMs', 'repairEveryMs', 'refundJudgeWaitMs', 'gas', 'assets']
const message = (e) => String(e?.message ?? e)
const cut = (s, n) => String(s).slice(0, n)

export function priceMicroUSD(price) {
  if (price === undefined || price === null || price === '') return 0
  return microOf(price, 'price')
}

export function loadConfig(options = {}) {
  let file = {}
  const from = options.config ?? (options.name === undefined ? ['bridge.json', 'pass.json'].find((f) => existsSync(resolve(f))) ?? null : null)
  if (typeof from === 'string') file = JSON.parse(readFileSync(resolve(from), 'utf8'))
  else if (from && typeof from === 'object') file = from
  const o = { ...file, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) }
  const name = String(o.name ?? '')
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) throw new TypeError('bridge: name is 2 to 32 of a-z, 0-9 and -, starting with a letter')
  const mode = o.mode ?? 'paywall'
  if (!MODES.includes(mode)) throw new TypeError('bridge: mode is "paywall", "gate" or "both"')
  if (!Address.isAddress(o.payout)) throw new TypeError('bridge: payout is the wallet address earnings go to')
  if ([o.feeRecipient, o.creditIssuer].some((v) => v !== undefined && v !== null)) throw new TypeError("bridge: the fee address and the credit issuer are ZEAM's, set in the package; feeRecipient and creditIssuer are not options")
  const payoutIsFeeRecipient = o.payoutIsFeeRecipient === true
  if (Address.equals(o.payout, ZEAM.feeRecipient) !== payoutIsFeeRecipient) throw new TypeError(payoutIsFeeRecipient ? 'bridge: payoutIsFeeRecipient needs payout to be the fee recipient' : 'bridge: payout is the fee recipient; set payoutIsFeeRecipient: true to pay it 100%')
  const micro = o.priceMicroUSD !== undefined ? Math.trunc(Number(o.priceMicroUSD)) : priceMicroUSD(o.price)
  const prices = typeof o.prices === 'function' || (o.prices !== null && typeof o.prices === 'object' && !Array.isArray(o.prices)) ? o.prices : null
  if (mode !== 'gate' && !(micro >= 1) && prices === null) throw new TypeError('bridge: a paywall needs a price per call, like price: "0.02", or prices per tool')
  const free = [...new Set((Array.isArray(o.free) ? o.free : []).filter((t) => typeof t === 'string'))]
  const perHour = o.freeLimit === undefined || o.freeLimit === null ? null : Math.trunc(Number(typeof o.freeLimit === 'object' ? o.freeLimit.perHour : o.freeLimit))
  if (perHour !== null && !(perHour >= 1)) throw new TypeError('bridge: freeLimit is free calls an hour per address, 1 or more')
  const time = timeOptions(o.time)
  if (time && mode === 'gate') throw new TypeError('bridge: time metering needs mode paywall or both')
  const contact = typeof o.contact === 'string' ? o.contact.trim() : o.contact === undefined || o.contact === null ? '' : null
  if (contact === null || (contact !== '' && !CONTACT.test(contact))) throw new TypeError('bridge: contact is an http(s) URL or a mailto: address')
  const admit = [...new Set((Array.isArray(o.admit) ? o.admit : []).filter((a) => Address.isAddress(a)).map((a) => a.toLowerCase()))]
  const url = (v, d) => (typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim().replace(/\/+$/, '') : d)
  let sessions = null
  if (o.sessions !== undefined && o.sessions !== null && o.sessions !== false) {
    if (typeof o.sessions !== 'object' || !Address.isAddress(o.sessions.escrow) || !Address.isAddress(o.sessions.factory)) throw new TypeError('bridge: sessions is { escrow, factory }: the addresses of the session escrow and of its payee factory')
    if (mode === 'gate') throw new TypeError('bridge: sessions need mode paywall or both')
    sessions = { escrow: Address.checksum(o.sessions.escrow), factory: Address.checksum(o.sessions.factory), gas: o.sessions.gas !== null && typeof o.sessions.gas === 'object' ? { ...o.sessions.gas } : null }
  }
  return {
    sessions,
    name,
    site: typeof o.site === 'string' && o.site !== '' ? o.site.replace(/\/+$/, '') : null,
    mode,
    priceMicroUSD: micro,
    prices,
    free,
    freeLimit: perHour,
    time,
    payout: Address.checksum(o.payout),
    admit,
    contact: contact || null,
    onEmpty: o.onEmpty === 'allow' ? 'allow' : 'refuse',
    relay: url(o.relay, DEFAULTS.relay),
    credits: url(o.credits, DEFAULTS.credits),
    rpc: o.rpc !== null && typeof o.rpc === 'object' ? o.rpc : url(o.rpc, DEFAULTS.rpc),
    stateDir: resolve(o.stateDir ?? setting('BRIDGE_STATE_DIR') ?? '.pass'),
    feeRecipient: ZEAM.feeRecipient,
    payoutIsFeeRecipient,
    creditIssuer: ZEAM.creditIssuer,
    refundUrl: typeof o.refundUrl === 'string' ? o.refundUrl : null,
    tick: o.tick === false || o.tick === 0 ? 0 : Number(o.tick ?? DEFAULTS.tickSeconds),
    keys: o.keys && typeof o.keys === 'object' ? o.keys : {},
    keySecret: o.keySecret ?? setting('BRIDGE_KEY_SECRET'),
    stores: o.stores && typeof o.stores === 'object' ? o.stores : {},
    fetch: typeof o.fetch === 'function' ? o.fetch : typeof o.fetchImpl === 'function' ? o.fetchImpl : globalThis.fetch,
    timeouts: { rpc: 10000, relay: 120000, credits: 20000, ...(o.timeouts ?? {}) },
    clock: typeof o.clock === 'function' ? o.clock : null,
    onError: typeof o.onError === 'function' ? o.onError : null,
    sleep: typeof o.sleep === 'function' ? o.sleep : null,
    tuning: Object.fromEntries(TUNABLE.filter((k) => o[k] !== undefined || o.tuning?.[k] !== undefined).map((k) => [k, o.tuning?.[k] ?? o[k]])),
  }
}

class FileCache {
  constructor(path, clock) {
    this.path = path
    this.clock = clock
    this.items = {}
    try {
      this.items = JSON.parse(readFileSync(path, 'utf8')) ?? {}
    } catch {
      this.items = {}
    }
  }

  now() {
    return this.clock ? Number(this.clock()) : Date.now()
  }

  get(key) {
    const hit = this.items[key]
    if (!hit) return null
    if (hit[1] < this.now()) {
      delete this.items[key]
      return null
    }
    return hit[0]
  }

  set(key, value, ttlSeconds) {
    this.items[key] = [value, this.now() + 1000 * Number(ttlSeconds)]
    writeAtomic(this.path, JSON.stringify(this.items)).catch(() => {})
  }
}

export function payerOf(payload) {
  const cfg = payload?.payload?.channelConfig ?? {}
  const auth = typeof cfg.payerAuthorizer === 'string' ? cfg.payerAuthorizer : ''
  if (/^0x[0-9a-fA-F]{40}$/.test(auth) && !/^0x0{40}$/.test(auth)) return auth.toLowerCase()
  const payer = typeof cfg.payer === 'string' ? cfg.payer : ''
  if (/^0x[0-9a-fA-F]{40}$/.test(payer)) return payer.toLowerCase()
  const from = payload?.payload?.authorization?.from
  return typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from) ? from.toLowerCase() : null
}

function owedTime(store) {
  return {
    read: async (channelId) => (await store.get(channelId))?.timeOwed ?? null,
    paid: (channelId, keys) => store.update(channelId, (r) => {
      if (r === null || r.timeOwed === null || typeof r.timeOwed !== 'object') return r
      const left = Object.fromEntries(Object.entries(r.timeOwed).filter(([k]) => !keys.includes(k)))
      if (Object.keys(left).length > 0) r.timeOwed = left
      else delete r.timeOwed
      return r
    }),
  }
}

function sentStore(dir, report) {
  try {
    return new SentFileStore(dir)
  } catch (e) {
    if (report !== null) {
      try {
        report(new Error(`the records of sent session authorizations cannot be kept in ${dir}, and are held in memory until this process stops: ${e?.message ?? e}`), { at: 'session-sent', file: dir })
      } catch {}
    }
    return null
  }
}

export function createEngine(options) {
  const c = loadConfig(options)
  const paid = c.mode !== 'gate'
  const gated = c.mode !== 'paywall'
  const channelsDir = join(c.stateDir, 'channels')
  const holdsChannels = !c.stores.channels && existsSync(channelsDir) && readdirSync(channelsDir).length > 0
  const settles = paid || holdsChannels
  const need = [...(settles ? ['settle'] : []), ...(gated ? ['credit'] : [])]
  const keys = loadKeys(c.stateDir, { need, secret: c.keySecret, provided: c.keys })
  const now = () => (c.clock ? Math.trunc(Number(c.clock())) : Date.now())
  const chain = new Chain(c.rpc, { timeout: c.timeouts.rpc / 1000, fetchFn: c.fetch })
  const relay = new Relay(c.relay, httpTransport(c.fetch), c.timeouts.relay / 1000)
  const state = (name) => new StateFile(c.stateDir, name)
  let escrows = ESCROWS
  let cfg = null
  let store = null
  let server = null
  if (settles) {
    cfg = new Config({
      name: c.name,
      site: c.site ?? '',
      priceMicroUSD: Math.max(1, Number(c.priceMicroUSD ?? 1)),
      payout: c.payout,
      feeRecipient: c.feeRecipient,
      payoutIsFeeRecipient: c.payoutIsFeeRecipient,
      receiverAuthorizerKey: keys.settle.key,
      relayUrl: c.relay,
      rpcUrl: typeof c.rpc === 'string' ? c.rpc : 'rpc:object',
      refundUrl: c.refundUrl,
      cache: new FileCache(join(c.stateDir, 'cache.json'), c.clock),
      clock: c.clock,
      sleep: c.sleep,
      ...c.tuning,
    })
    store = c.stores.channels ?? new ChannelFileStore(join(c.stateDir, 'channels'))
    if (c.time) Object.defineProperty(cfg, 'meter', { value: new TimeMeter(join(c.stateDir, 'meter'), c.time, { now, owed: owedTime(store) }), enumerable: false })
    if (c.sessions !== null) escrows = new Escrows([X402BatchSettlement, sessionEscrow({ address: c.sessions.escrow, factory: c.sessions.factory, signer: cfg.receiverAuthorizer, split: cfg.receiver, chainId: cfg.chainId, gas: c.sessions.gas })])
    server = new Server(cfg, store, chain, relay, escrows)
    server.mppHeld = c.stores.mppHeld ?? new MppHeldFiles(join(c.stateDir, 'mpp-held'))
    if (c.sessions !== null) server.sessions = new Sessions(server, escrows.list[1], { sent: c.stores.sent ?? sentStore(join(c.stateDir, 'session-sent'), c.onError), report: c.onError })
  }
  let gate = null
  if (gated) {
    const gstore = c.stores.gate ?? new GateFileStore(join(c.stateDir, 'gate'))
    const meter = new Meter(gstore, c.name, { onEmpty: c.onEmpty, now: c.clock ?? undefined })
    gate = {
      store: gstore,
      admission: new Admission(c.payout, gstore),
      meter,
      credits: new Credits(meter, c.creditIssuer, { http: gateHttp(c.fetch, c.timeouts.credits / 1000), now: c.clock ?? undefined }),
    }
  }

  const refusal = (status, body, headers = {}) => ({ ok: false, status, body, headers })
  const reach = c.contact ? { contact: c.contact } : {}
  const REFUSED_HOW = refusedHow(c.contact)
  const gateTerms = (res, extra = {}) => {
    const q = gate.admission.paymentRequired(res)
    const body = { ...q.body, ...reach }
    return { body, headers: { ...q.headers, 'PAYMENT-REQUIRED': Exact.encodeHeader({ ...body, ...extra }) } }
  }
  const unavailable = () => refusal(503, { error: 'payment_unavailable', message: 'the payment check failed; nothing was charged. Retry.' })

  async function admitsPayer(who, grantHeader, tool) {
    if (who === null) return { ok: false, code: 'refused', why: 'the payment names no payer' }
    if (typeof grantHeader !== 'string' || grantHeader === '') return c.admit.includes(who) ? { ok: true, root: who } : { ok: false, code: 'refused', why: `${who} is not admitted` }
    const a = await gate.admission.grant(who, grantHeader, tool, c.admit, now())
    return a.ok ? { ok: true, root: String(a.root).toLowerCase() } : a
  }

  let creditRun = null
  const wantCredit = () => {
    if (!creditRun) creditRun = creditStep().catch(() => null).finally(() => { creditRun = null })
    return creditRun
  }

  async function check({ tool, resource, payment, grant, credential = '', refundUrl = null, price = null, listing = {}, extensions = null, shared = null, paymentOnly = false }) {
    const res = { url: String(resource ?? ''), description: typeof tool?.description === 'string' ? tool.description : '', mimeType: 'application/json' }
    const toolName = tool?.name ?? ''
    const badGrant = async (why, session = false) => {
      const terms = await server.paymentRequired(res, extensions, refundUrl, { admission: ADMISSION, ...reach, ...listing, error: 'bad_grant' }, price)
      const q = session ? Server.forSession(terms) : terms
      return refusal(402, { ...q.body, message: why, how: BAD_GRANT_HOW }, q.headers)
    }
    try {
      if (c.mode === 'gate') {
        if (!payment) {
          const q = gateTerms(res)
          return refusal(402, { ...q.body, how: GATE_HOW }, q.headers)
        }
        const a = await gate.admission.admit(payment, grant, toolName, c.admit, now())
        if (!a.ok && a.status === 402) {
          const q = gateTerms(res, { error: a.code })
          return refusal(402, { ...q.body, error: a.code, message: a.why, how: GATE_HOW }, q.headers)
        }
        if (!a.ok) return refusal(a.status, a.status === 403 ? { error: a.code, message: a.why, how: REFUSED_HOW, ...reach } : { error: a.code, message: a.why })
        const m = await gate.meter.charge()
        if (m.buy) wantCredit()
        if (!m.ok) return refusal(503, { error: 'gate_credit_exhausted', message: OUT_OF_CHECKS })
        if (m.unpaid) await state('unpaid.json').set({ at: new Date(now()).toISOString() })
        return { ok: true, ticket: { kind: 'gate', headers: a.root !== a.signer ? { [GRANTED_BY]: a.root } : {} } }
      }
      if (!payment && credential && server.sessions !== null && Server.mppOffered(price) && Sessions.peek(credential) !== null) {
        const held = await server.sessions.hold(credential, res, price?.micro ?? null, { paymentOnly: Sessions.paymentOnly(credential, paymentOnly === true), admit: c.mode === 'both' ? (who) => admitsPayer(who, grant, toolName) : null, refundUrl })
        if (held.unadmitted) {
          if (held.unadmitted.code === 'bad_grant') return await badGrant(held.unadmitted.why, true)
          return refusal(403, { error: 'refused', message: held.unadmitted.why, how: REFUSED_HOW, ...reach })
        }
        if (!held.ok) return refusal(held.status, held.body, held.headers)
        if (held.managed) return refusal(held.managed.status, held.managed.body, held.managed.headers)
        const grantedBy = held.admitted && held.admitted.root !== held.hold.payer ? held.admitted.root : null
        return { ok: true, ticket: { kind: 'paid', hold: held.hold, grantedBy, price } }
      }
      if (!payment && credential && Server.mppOffered(price)) {
        const held = await server.mppHold(credential, res, price?.micro ?? null, refundUrl)
        if (!held.ok) return refusal(held.status, held.body, held.headers)
        let grantedBy = null
        if (c.mode === 'both') {
          const who = held.hold.verified.payer.toLowerCase()
          const a = await admitsPayer(who, grant, toolName)
          if (!a.ok) {
            await server.mppRelease(held.hold)
            if (a.code === 'bad_grant') return await badGrant(a.why)
            return refusal(403, { error: 'refused', message: a.why, how: REFUSED_HOW, ...reach })
          }
          if (a.root !== who) grantedBy = a.root
        }
        return { ok: true, ticket: { kind: 'paid', hold: held.hold, grantedBy, price } }
      }
      if (!payment) {
        const q = await server.paymentRequired(res, extensions, refundUrl, c.mode === 'both' ? { admission: ADMISSION, ...reach, ...listing } : { ...reach, ...listing }, price, shared)
        return refusal(q.status, q.body, q.headers)
      }
      let grantedBy = null
      let nobody = false
      if (c.mode === 'both') {
        const payload = Json.decodeHeader(payment)
        if (payload !== null) {
          const who = payerOf(payload)
          const bad = who === null ? server.malformed(payment, refundUrl) : null
          if (bad !== null) return refusal(bad.status, bad.body, bad.headers)
          nobody = who === null
          if (!nobody) {
            const a = await admitsPayer(who, grant, toolName)
            if (!a.ok && a.code === 'bad_grant') return await badGrant(a.why)
            if (!a.ok) return refusal(403, { error: 'refused', message: a.why, how: REFUSED_HOW, ...reach })
            if (a.root !== who) grantedBy = a.root
          }
        }
      }
      const held = await server.verifyAndHold(payment, res, price?.micro ?? null, refundUrl)
      if (!held.ok) return refusal(held.status, held.body, held.headers)
      if (nobody) {
        await server.release(held.hold)
        const a = await admitsPayer(null, grant, toolName)
        return refusal(403, { error: 'refused', message: a.why, how: REFUSED_HOW, ...reach })
      }
      return { ok: true, ticket: { kind: 'paid', hold: held.hold, grantedBy, price } }
    } catch {
      return unavailable()
    }
  }

  async function done(ticket, ok, { units = null } = {}) {
    if (!ticket || ticket.kind === 'gate') return { ok: true, status: 200, headers: ticket?.headers ?? {}, body: {} }
    try {
      const metered = ticket.price && ticket.price.unitMicro !== null && ticket.price.unitMicro !== undefined
      if (ok && metered && units === null) {
        await server.release(ticket.hold)
        return { ok: false, status: 500, headers: {}, body: { error: 'tool_failed', message: `the tool reported no units. ${FAILED_CALL}` } }
      }
      if (ticket.hold.kind === 'session') {
        if (!ok) {
          await server.sessions.release(ticket.hold)
          return { ok: true, status: 200, headers: {}, body: { released: true } }
        }
        const s = await server.sessions.settle(ticket.hold)
        if (s.ok) return { ok: true, status: 200, headers: ticket.grantedBy ? { ...s.headers, [GRANTED_BY]: ticket.grantedBy } : s.headers, body: s.response }
        return { ok: false, status: s.status, headers: s.headers, body: s.body }
      }
      if (ticket.hold.kind === 'mpp') {
        if (!ok) {
          await server.mppRelease(ticket.hold)
          return { ok: true, status: 200, headers: {}, body: { released: true } }
        }
        const s = await server.mppSettle(ticket.hold)
        if (s.ok) return { ok: true, status: 200, headers: ticket.grantedBy ? { ...s.headers, [GRANTED_BY]: ticket.grantedBy } : s.headers, body: s.response }
        return { ok: false, status: s.status, headers: s.headers, body: s.body }
      }
      if (!ok) {
        await server.release(ticket.hold)
        return { ok: true, status: 200, headers: {}, body: { released: true } }
      }
      const micro = metered ? chargeFor(ticket.price, units) : null
      const s = await server.settle(ticket.hold, micro === null ? null : micro === 0 ? '0' : cfg.unitsOfMicroUSD(cfg.assetOf(ticket.hold.requirement.asset), micro))
      if (s.ok) return { ok: true, status: 200, headers: ticket.grantedBy ? { ...s.headers, [GRANTED_BY]: ticket.grantedBy } : s.headers, body: s.response }
      return { ok: false, status: s.status, headers: s.headers, body: s.body }
    } catch {
      if (ticket.hold.kind === 'mpp') await server.mppRelease(ticket.hold).catch(() => {})
      else if (ticket.hold.kind === 'session') await server.sessions.release(ticket.hold).catch(() => {})
      else await server.release(ticket.hold).catch(() => {})
      return { ok: false, status: 503, headers: {}, body: { error: 'payment_unavailable', message: 'settlement failed; nothing was charged. Retry.' } }
    }
  }

  async function refund(body) {
    if (!settles) return { status: 404, body: { op: 'refund_failed', code: 'not_a_paywall', why: 'this site has no paid calls' } }
    const scalar = (k) => (body && ['string', 'number', 'boolean'].includes(typeof body[k]) ? String(body[k]) : null)
    return new Refunds(cfg, store, chain, relay, escrows).handle(scalar('channelId'), scalar('issued'), scalar('signature'), Refunds.ask(body))
  }

  async function syncClaimed(limit = 50) {
    const synced = []
    for (const ch of await store.list()) {
      if (synced.length >= limit || !ch.channelId) continue
      const charged = Channels.n(ch.chargedCumulativeAmount ?? '0')
      const claimed = Channels.n(ch.totalClaimed ?? '0')
      if (charged <= claimed) continue
      const escrow = escrows.find(ch)
      if (escrow === null) continue
      let st
      try {
        st = await chain.channel(ch.channelId, escrow)
      } catch {
        continue
      }
      if (Channels.n(st.totalClaimed) <= claimed) continue
      await store.update(ch.channelId, (r) => {
        if (r === null) return null
        if (Channels.n(st.totalClaimed) > Channels.n(r.totalClaimed ?? '0')) r.totalClaimed = st.totalClaimed
        return r
      })
      synced.push(String(ch.channelId).toLowerCase())
    }
    return synced
  }

  async function recordPayout(calls, valueUSD, how) {
    const txs = [...new Set(calls.filter((x) => x.hash).map((x) => x.hash))]
    if (txs.length) await state('last-payout.json').set({ at: new Date(now()).toISOString(), valueUSD, how, transactions: txs })
  }

  async function creditStep() {
    const notesFile = state('credit-notes.json')
    let notes = (await notesFile.get()) ?? []
    let changed = false
    for (const entry of notes) {
      if (entry.added || !entry.note) continue
      const r = await gate.credits.addNote(entry.note, c.creditIssuer, c.payout, c.name)
      if (r.ok || r.why === 'this note is already added') {
        entry.added = true
        delete entry.why
      } else entry.why = r.why ?? 'not added'
      changed = true
    }
    const out = { wanted: await gate.meter.wantsCredit() }
    if (out.wanted) {
      const tryFile = state('credit-try.json')
      const last = Number((await tryFile.get())?.at ?? 0)
      if (now() - last < 300000) out.waiting = 'last purchase attempt under 5 minutes ago'
      else {
        await tryFile.set({ at: now() })
        const r = await gate.credits.buy(c.credits, gate.meter.creditBlock(), keys.credit.key, c.payout, c.name, chain)
        if (r.note && typeof r.note === 'object') {
          const okAdded = !!r.added?.ok
          notes.push({ note: r.note, at: new Date(now()).toISOString(), added: okAdded, ...(okAdded ? {} : { why: String(r.added?.why ?? 'not added') }) })
          changed = true
        }
        out.bought = !!r.ok
        if (!r.ok) out.error = String(r.why ?? r.added?.why ?? 'not bought')
      }
    }
    if (changed) {
      notes = notes.slice(-100)
      await notesFile.set(notes)
    }
    return out
  }

  async function tick() {
    const ran = await withLock(join(c.stateDir, 'tick'), async () => {
      const report = { at: new Date(now()).toISOString(), mode: c.mode }
      if (settles) {
        try {
          report.withdrawals = await new Withdrawals(cfg, store, chain, escrows).run()
          const claims = await new Claims(cfg, store, chain, relay, escrows).run()
          report.claims = claims
          report.synced = (await syncClaimed()).length
          for (const asset of Object.values(claims)) await recordPayout(asset.calls.filter((x) => !String(x.what).startsWith('claim ')), asset.valueUSD, 'relay')
        } catch (e) {
          report.error = cut(message(e), 300)
        }
      }
      if (c.mode === 'gate') {
        try {
          report.credit = await creditStep()
        } catch (e) {
          report.creditError = cut(message(e), 300)
        }
      }
      return report
    }, { attempt: true })
    if (!ran.ran) return { at: new Date(now()).toISOString(), skipped: 'another run is in progress' }
    await state('last-tick.json').set(ran.value)
    return ran.value
  }

  async function payoutPlan() {
    let calls = []
    let usd = 0
    let gasUnits = 0
    for (const [asset, escrow] of cfg.assets.flatMap((a) => escrows.list.map((e) => [a, e]))) {
      const picked = []
      let riding = 0n
      for (const raw of await store.list()) {
        if (escrows.find(raw) !== escrow) continue
        const ch = await Channels.earned(cfg, escrows.view(escrow, raw), escrow)
        const token = Channels.tokenOf(ch, escrow)
        if (!token || !ch.channelId || !Address.equals(token, asset.address) || !Channels.claimable(ch, escrow)) continue
        let live
        try {
          live = await chain.live(ch.channelId, escrow)
        } catch {
          continue
        }
        const charged = Channels.n(ch.chargedCumulativeAmount)
        if (charged > Channels.n(live.balance) || charged <= Channels.n(live.claimed)) continue
        const delta = charged - Channels.n(live.claimed)
        if (delta > Channels.n(live.payable)) continue
        picked.push(ch)
        riding += delta
      }
      const plan = await new Payout(cfg, chain, escrow).calls(asset.address, picked.length > 0)
      const units = escrows.gas(cfg, escrow)
      if (picked.length || plan.calls.length) {
        for (const x of await escrows.prepareCalls(escrow, chain)) {
          calls.push(x)
          gasUnits += units.createPayee ?? 0
        }
      }
      if (picked.length) {
        calls.push(...(await escrows.claimCalls(escrow, cfg.signingKey(), picked, cfg.chainId, () => chain.time(Math.floor(now() / 1000)))))
        gasUnits += units.claimBase + picked.length * units.claimEntry
      }
      if (plan.calls.length) {
        gasUnits += units.payout
        for (const x of plan.calls) if (x.what === 'create split') gasUnits += units.createSplit
        calls = [...calls, ...plan.calls]
        usd += cfg.microUSDOf(asset, (riding + BigInt(plan.owed) + BigInt(plan.held)).toString()) / 1e6
      }
    }
    return { calls, usd, gasUnits }
  }

  async function payout() {
    if (!settles) return { paidBy: 'nobody', valueUSD: 0, note: 'This site has no paid calls.' }
    const plan = await payoutPlan()
    if (!plan.calls.length) return { paidBy: 'nobody', valueUSD: 0, note: 'Nothing to pay out.' }
    const gas = new GasQuote(cfg, chain, relay)
    const valueUSD = Math.round(plan.usd * 1e6) / 1e6
    const gasUSD = await gas.usd(plan.gasUnits)
    let note = ''
    if (await gas.atMargin(plan.usd, plan.gasUnits)) {
      const sent = await relay.send(plan.calls, cfg.relaySplit())
      const report = plan.calls.map((x, i) => ({ what: x.what, ...sent[i] }))
      if (report.some((x) => x.hash)) {
        await recordPayout(report, valueUSD, 'relay')
        await syncClaimed()
        return { paidBy: 'relay', valueUSD, calls: report }
      }
      note = `The relay did not send it (${report[0]?.error ?? 'no answer'}). `
    }
    const tuples = plan.calls.map((x) => [Address.checksum(x.to), false, x.data])
    return {
      paidBy: 'you',
      valueUSD,
      gasUSD: gasUSD === null ? null : Math.round(gasUSD * 1e6) / 1e6,
      note: note + `Below break-even: the ${Server.percent(cfg.feeShare)}% fee share of this payout is under its gas. The relay sends it once the share covers the gas. To pay out now, send this transaction from your wallet with ETH on Base for gas. It pays only you and the split's fee.`,
      transaction: { chainId: 8453, to: DEFAULTS.multicall3, data: Abi.encodeCall('aggregate3((address,bool,bytes)[])', [tuples]), value: '0' },
      calls: plan.calls.map((x) => x.what),
    }
  }

  async function status() {
    const out = { mode: c.mode, name: c.name, payout: c.payout, lastPayout: await state('last-payout.json').get(), lastTick: await state('last-tick.json').get() }
    if (settles) {
      out.receiver = cfg.receiver
      out.settleKey = keys.settle.address
      let total = 0n
      let open = 0
      for (const raw of await store.list()) {
        const ch = await Channels.earned(cfg, raw)
        open++
        try {
          const d = Channels.n(ch.chargedCumulativeAmount ?? '0') - Channels.n(ch.totalClaimed ?? '0')
          if (d > 0n) total += d
        } catch {}
      }
      out.unclaimed = { microUSD: Number(total), channels: open }
      try {
        const token = cfg.assets[0].address
        const r = await chain.receivers(cfg.receiver, token)
        const owed = big(r.totalClaimed) - big(r.totalSettled)
        const deployed = await chain.hasCode(cfg.receiver)
        const held = big(deployed ? await chain.splitBalance(cfg.receiver, token) : await chain.balanceOf(token, cfg.receiver))
        out.claimedNotPaid = { microUSD: Number((owed > 0n ? owed : 0n) + held), splitDeployed: deployed }
      } catch (e) {
        out.chainError = cut(message(e), 200)
      }
    }
    if (gated) {
      out.gate = { ...(await gate.meter.usage()), onEmpty: c.onEmpty, unpaidAt: (await state('unpaid.json').get())?.at ?? null }
      out.creditWallet = { address: keys.credit.address }
      try {
        out.creditWallet.usdcMicro = Number(await chain.balanceOf(Erc20.USDC_BASE, keys.credit.address))
      } catch {
        out.creditWallet.error = 'could not read its balance'
      }
    }
    return out
  }

  let timer = null
  const start = () => {
    if (timer || !(c.tick > 0)) return
    timer = setInterval(() => { tick().catch(() => {}) }, c.tick * 1000)
    timer.unref?.()
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    options: c,
    mode: c.mode,
    paid,
    gated,
    cfg,
    store,
    chain,
    relay,
    escrows,
    server,
    sessions: server?.sessions ?? null,
    gate,
    meter: cfg?.meter ?? null,
    keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, { address: v.address, source: v.source }])),
    check,
    done,
    refund,
    tick,
    payout,
    status,
    start,
    stop,
  }
}
