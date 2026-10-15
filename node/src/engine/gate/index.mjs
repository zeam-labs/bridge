import { randomBytes } from 'node:crypto'
import { Address, Hex, InvalidArgument, Num, isObject } from '../core/hex.mjs'
import { Erc20 } from '../core/batch.mjs'
import { Token } from '../core/evm.mjs'
import { Pass } from '../core/pass.mjs'
import { Secp256k1 } from '../core/secp256k1.mjs'

const UINT256_MAX = (1n << 256n) - 1n
const scalar = (v) => ['string', 'number', 'boolean'].includes(typeof v)
const str = (v) => (typeof v === 'boolean' ? (v ? '1' : '') : String(v))
const rawurlencode = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

export const GateJson = {
  encode(value) {
    const out = JSON.stringify(value)
    if (out === undefined) throw new InvalidArgument('value is not JSON')
    return out
  },
  decode(text) {
    if (typeof text !== 'string' || text === '') return [false, null]
    try {
      return [true, JSON.parse(text)]
    } catch {
      return [false, null]
    }
  },
  toObject(value) {
    return JSON.parse(GateJson.encode(value))
  },
  base64Encode(text) {
    return Buffer.from(String(text), 'utf8').toString('base64')
  },
  base64Decode(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null
    const body = text.replace(/=+$/, '')
    if (body.length % 4 === 1) return null
    return Buffer.from(body, 'base64').toString('utf8')
  },
  base64UrlDecode(text) {
    let t = String(text ?? '')
    const cut = t.indexOf('=')
    if (cut !== -1) t = t.slice(0, cut)
    let clean = t.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '')
    if (clean.length % 4 === 1) clean = clean.slice(0, -1)
    return Buffer.from(clean, 'base64').toString('utf8')
  },
  base64UrlEncode(text) {
    return Buffer.from(String(text), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  sorted(value) {
    if (Array.isArray(value)) return value.map(GateJson.sorted)
    if (isObject(value)) {
      const out = {}
      for (const k of Object.keys(value).sort()) out[k] = GateJson.sorted(value[k])
      return out
    }
    return value
  },
  canonical(value) {
    return GateJson.encode(GateJson.sorted(value))
  },
  deepEqual(a, b) {
    return GateJson.canonical(a) === GateJson.canonical(b)
  },
  containsSubset(expected, actual) {
    if (!isObject(expected)) return GateJson.deepEqual(expected, actual)
    if (!isObject(actual)) return false
    for (const [k, v] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, k)) return false
      if (!GateJson.containsSubset(v, actual[k])) return false
    }
    return true
  },
}

export const Exact = {
  NETWORK: 'eip155:8453',
  MAX_TIMEOUT_SECONDS: 300,
  VALID_BEFORE_MARGIN: 6,

  requirement(amount, payTo, options = {}) {
    return {
      scheme: 'exact',
      network: options.network !== undefined ? String(options.network) : Exact.NETWORK,
      amount: String(amount),
      asset: options.asset !== undefined ? String(options.asset) : Erc20.USDC_BASE,
      payTo: String(payTo),
      maxTimeoutSeconds: options.maxTimeoutSeconds !== undefined ? Math.trunc(Number(options.maxTimeoutSeconds)) : Exact.MAX_TIMEOUT_SECONDS,
      extra: {
        name: options.assetName !== undefined ? String(options.assetName) : Erc20.USDC_BASE_NAME,
        version: options.assetVersion !== undefined ? String(options.assetVersion) : Erc20.USDC_BASE_VERSION,
      },
    }
  },
  chainId(network) {
    const m = typeof network === 'string' ? /^eip155:(\d+)/.exec(network) : null
    if (!m) throw new InvalidArgument('not an eip155 network: ' + (scalar(network) ? network : typeof network))
    return Number(m[1])
  },
  encodeHeader(value) {
    return GateJson.base64Encode(GateJson.encode(value))
  },
  decodeHeader(value) {
    const raw = GateJson.base64Decode(value)
    if (raw === null) return null
    const [ok, decoded] = GateJson.decode(raw)
    return ok ? decoded : null
  },
  matches(requirement, payload) {
    if (!isObject(payload) || payload.x402Version === undefined || payload.x402Version === null || !isObject(payload.accepted)) return false
    if (payload.x402Version === 1) return payload.accepted.scheme !== undefined && payload.accepted.scheme !== null && payload.accepted.network !== undefined && payload.accepted.network !== null && payload.accepted.scheme === requirement.scheme && payload.accepted.network === requirement.network
    if (payload.x402Version !== 2) return false
    const required = GateJson.toObject(requirement)
    const accepted = { ...payload.accepted }
    const requiredExtra = Object.hasOwn(required, 'extra') ? required.extra : null
    const acceptedExtra = Object.hasOwn(accepted, 'extra') ? accepted.extra : null
    delete required.extra
    delete accepted.extra
    if (!GateJson.deepEqual(required, accepted)) return false
    return requiredExtra === null || GateJson.containsSubset(requiredExtra, acceptedExtra)
  },
  isAddress(value) {
    if (typeof value !== 'string' || !Address.isAddress(value)) return false
    return value.toLowerCase() === value || Address.checksum(value) === value
  },
  bigint(value) {
    if (typeof value === 'number') return Number.isInteger(value) ? Num.of(value) : null
    if (typeof value === 'bigint') return value
    if (typeof value !== 'string') return null
    const v = value.trim()
    if (v === '') return 0n
    if (/^0x[0-9a-fA-F]+$/.test(v) || /^-?[0-9]+$/.test(v)) return Num.of(v)
    return null
  },
  tokenDomain(requirement) {
    return Token.domain(requirement.asset, requirement.extra.name, requirement.extra.version, Exact.chainId(requirement.network))
  },
  authorizationMessage(authorization) {
    const a = isObject(authorization) ? authorization : GateJson.toObject(authorization)
    if (!isObject(a)) return null
    for (const f of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) if (!Object.hasOwn(a, f)) return null
    if (!Exact.isAddress(a.from) || !Exact.isAddress(a.to) || !Hex.isHex(a.nonce, 32)) return null
    const m = { from: a.from, to: a.to, nonce: a.nonce }
    for (const f of ['value', 'validAfter', 'validBefore']) {
      const n = Exact.bigint(a[f])
      if (n === null || n < 0n || n > UINT256_MAX) return null
      m[f] = n.toString(10)
    }
    return { from: m.from, to: m.to, value: m.value, validAfter: m.validAfter, validBefore: m.validBefore, nonce: m.nonce }
  },
  async verify(payload, requirement, nowSeconds) {
    if (payload.x402Version !== 2) return `No facilitator registered for x402 version: ${payload.x402Version}`
    const inner = isObject(payload.payload) ? payload.payload : null
    const auth = inner !== null && isObject(inner.authorization) ? inner.authorization : null
    if (auth === null || typeof inner.signature !== 'string') return 'invalid_exact_evm_payload'
    if (payload.accepted?.scheme !== 'exact' || requirement.scheme !== 'exact') return 'invalid_exact_evm_scheme'
    const e = (v) => v === undefined || v === null || v === '' || v === '0' || v === 0 || v === false
    if (e(requirement.extra?.name) || e(requirement.extra?.version)) return 'invalid_exact_evm_missing_eip712_domain'
    if (payload.accepted?.network === undefined || payload.accepted.network !== requirement.network) return 'invalid_exact_evm_network_mismatch'
    const message = Exact.authorizationMessage(auth)
    const sig = inner.signature
    const sigBody = sig.startsWith('0x') ? sig.slice(2) : sig
    if (message === null || sigBody.length !== 130 || !/^[0-9a-fA-F]+$/.test(sigBody)) return 'invalid_exact_evm_signature'
    let signer
    try {
      signer = await Secp256k1.recoverTypedData(Exact.tokenDomain(requirement), Token.TRANSFER_TYPES, 'TransferWithAuthorization', message, '0x' + sigBody)
    } catch (err) {
      if (err instanceof InvalidArgument) return 'invalid_exact_evm_signature'
      throw err
    }
    if (!Address.equals(signer, message.from)) return 'invalid_exact_evm_signature'
    if (message.to.toLowerCase() !== String(requirement.payTo).toLowerCase()) return 'invalid_exact_evm_recipient_mismatch'
    if (BigInt(message.validBefore) < BigInt(Math.trunc(nowSeconds)) + BigInt(Exact.VALID_BEFORE_MARGIN)) return 'invalid_exact_evm_payload_authorization_valid_before'
    if (BigInt(message.validAfter) > BigInt(Math.trunc(nowSeconds))) return 'invalid_exact_evm_payload_authorization_valid_after'
    const amount = Exact.bigint(requirement.amount)
    if (amount === null || BigInt(message.value) !== amount) return 'invalid_exact_evm_payload_authorization_value_mismatch'
    const v = Number.parseInt(sigBody.slice(128, 130), 16)
    if ((v !== 27 && v !== 28) || !Secp256k1.isLowS('0x' + sigBody)) return 'invalid_exact_evm_signature_not_accepted_by_token'
    return null
  },
  async authorize(key, requirement, nowSeconds, nonce) {
    const authorization = {
      from: Secp256k1.privateKeyToAddress(key),
      to: Address.checksum(requirement.payTo),
      value: requirement.amount,
      validAfter: '0',
      validBefore: String(Math.trunc(nowSeconds) + Math.trunc(Number(requirement.maxTimeoutSeconds))),
      nonce: String(nonce).toLowerCase(),
    }
    const signature = await Secp256k1.signTypedData(key, Exact.tokenDomain(requirement), Token.TRANSFER_TYPES, 'TransferWithAuthorization', Exact.authorizationMessage(authorization))
    return { authorization, signature }
  },
  paymentPayload(paymentRequired, requirement, inner) {
    const payload = { x402Version: paymentRequired.x402Version, payload: inner }
    if (Object.hasOwn(paymentRequired, 'extensions')) payload.extensions = paymentRequired.extensions
    if (Object.hasOwn(paymentRequired, 'resource')) payload.resource = paymentRequired.resource
    payload.accepted = requirement
    return payload
  },
}

export class Admission {
  static NOTE = 'Sign this zero-value payment with your key. Nothing is paid. The key needs no funds and must be admitted here.'
  static SEEN_KEY = 'x402-seen'

  constructor(payTo, store, options = {}) {
    this.payTo = Address.checksum(payTo)
    this.store = store
    this.realm = options.realm !== undefined ? String(options.realm) : Pass.REALM
    this.options = options
  }

  requirement(payTo = null) {
    return Exact.requirement('0', payTo === null ? this.payTo : Address.checksum(payTo), this.options)
  }

  paymentRequired(resource, payTo = null) {
    const body = { x402Version: 2, resource: GateJson.toObject(resource), accepts: [this.requirement(payTo)], realm: this.realm, note: Admission.NOTE }
    return { status: 402, headers: { 'PAYMENT-REQUIRED': Exact.encodeHeader(body), 'Cache-Control': 'no-store' }, body }
  }

  static refuse(code, why) {
    return { ok: false, status: code === 'refused' ? 403 : 402, code, why }
  }

  static notAdmittedSigner(root) {
    return `the grant's signer ${root} is not admitted`
  }

  static otherDelegate(delegate, from) {
    return `the grant's delegate is ${delegate}; this call is signed by ${from}`
  }

  static scopeAllows(scope, toolName) {
    if (scope === null || scope === undefined || scope === '' || scope === 'self' || scope === '*') return true
    return String(scope).toLowerCase() === String(toolName).toLowerCase()
  }

  async seen(from, nonce, nowMs) {
    const state = await this.store.get(Admission.SEEN_KEY)
    const key = `${String(from).toLowerCase()}:${String(nonce).toLowerCase()}`
    return state !== null && typeof state === 'object' && state[key] !== undefined && state[key] !== null && state[key] >= nowMs
  }

  claim(from, nonce, until, nowMs) {
    const key = `${String(from).toLowerCase()}:${String(nonce).toLowerCase()}`
    return this.store.update(Admission.SEEN_KEY, (state) => {
      const s = isObject(state) ? { ...state } : {}
      for (const [k, expires] of Object.entries(s)) if (expires < nowMs) delete s[k]
      if (s[key] !== undefined && s[key] !== null) return [s, false]
      s[key] = until
      return [s, true]
    })
  }

  async admit(paymentHeaderValue, grantHeaderValue, toolName, admitList, now = null) {
    const t = now === null ? Date.now() : Math.trunc(now)
    if (typeof paymentHeaderValue !== 'string' || paymentHeaderValue === '') return Admission.refuse('no_payment', 'no PAYMENT-SIGNATURE header')
    const payload = Exact.decodeHeader(paymentHeaderValue)
    if (payload === null) return Admission.refuse('no_payment', 'PAYMENT-SIGNATURE is not base64 JSON of an x402 payment')
    const requirement = this.requirement()
    if (!Exact.matches(requirement, payload)) return Admission.refuse('no_matching_requirement', 'the payment matches no accepted requirement')
    const auth = isObject(payload.payload) && isObject(payload.payload.authorization) ? payload.payload.authorization : null
    const from = auth !== null && scalar(auth.from) ? str(auth.from).toLowerCase() : ''
    const nonce = auth !== null && scalar(auth.nonce) ? str(auth.nonce) : ''
    if (from === '' || nonce === '') return Admission.refuse('bad_payment', 'no authorization in the payment')
    if (await this.seen(from, nonce, t)) return Admission.refuse('replayed', 'this authorization was already used')
    let invalid
    try {
      invalid = await Exact.verify(payload, requirement, Math.floor(t / 1000))
    } catch (e) {
      invalid = String(e?.message ?? e)
    }
    if (invalid !== null) return Admission.refuse('invalid_payment', invalid)
    const admitted = await this.grant(from, grantHeaderValue, toolName, admitList, t)
    if (!admitted.ok) return admitted
    const validBeforeMs = Exact.bigint(auth.validBefore) * 1000n
    const until = validBeforeMs < BigInt(Number.MAX_SAFE_INTEGER) ? Number(validBeforeMs) : Number.MAX_SAFE_INTEGER
    if (!(await this.claim(from, nonce, until, t))) return Admission.refuse('replayed', 'this authorization was already used')
    return admitted
  }

  async grant(from, grantHeaderValue, toolName, admitList, t) {
    let grant = null
    if (typeof grantHeaderValue === 'string' && grantHeaderValue !== '') {
      const text = GateJson.base64UrlDecode(grantHeaderValue)
      try {
        grant = JSON.parse(text)
      } catch {
        return Admission.refuse('bad_grant', 'x-grant is not base64url JSON')
      }
    }
    if (grant === null || grant === false || grant === 0 || grant === '') return this.direct(from, admitList)
    return this.delegated(from, grant, toolName, admitList, t)
  }

  static admits(admitList, address) {
    return admitList.some((a) => scalar(a) && str(a).toLowerCase() === String(address).toLowerCase())
  }

  direct(from, admitList) {
    if (!Admission.admits(admitList, from)) return Admission.refuse('refused', `${from} is not admitted`)
    return { ok: true, signer: from, root: from, scope: 'self', until: null, grant: null }
  }

  async delegated(from, grant, toolName, admitList, t) {
    if (grant !== null && typeof grant === 'object') {
      for (const f of ['delegate', 'until', 'signature', 'scope', 'budget']) {
        if (grant[f] !== undefined && grant[f] !== null && !scalar(grant[f])) return Admission.refuse('bad_grant', 'a grant needs delegate, until and signature')
      }
    }
    let g
    try {
      g = await Pass.verifyGrant(this.realm, grant, t)
    } catch (e) {
      g = { ok: false, why: 'bad signature: ' + String(e?.message ?? e).slice(0, 80) }
    }
    if (!g.ok) return Admission.refuse('bad_grant', g.why)
    if (!Admission.admits(admitList, g.root)) return Admission.refuse('bad_grant', Admission.notAdmittedSigner(g.root))
    if (from !== g.delegate) return Admission.refuse('bad_grant', Admission.otherDelegate(g.delegate, from))
    if (!Admission.scopeAllows(g.scope, toolName)) return Admission.refuse('refused', `the grant's scope is ${g.scope}, not this tool`)
    return { ok: true, signer: from, root: g.root, scope: g.scope, until: g.until, grant: g.id }
  }
}

export class Meter {
  static FREE_PER_MONTH = 10000
  static CREDIT_BLOCK = 2000

  constructor(store, name, options = {}) {
    this.store = store
    this.meterName = String(name)
    this.free = options.freePerMonth !== undefined ? Math.max(0, Math.trunc(Number(options.freePerMonth))) : Meter.FREE_PER_MONTH
    this.block = options.creditBlock !== undefined ? Math.max(1000, Math.trunc(Number(options.creditBlock))) : Meter.CREDIT_BLOCK
    this.empty = options.onEmpty === 'allow' ? 'allow' : 'refuse'
    this.now = typeof options.now === 'function' ? options.now : null
  }

  name() {
    return this.meterName
  }

  creditBlock() {
    return this.block
  }

  onEmpty() {
    return this.empty
  }

  nowMs() {
    return this.now !== null ? Math.trunc(Number(this.now())) : Date.now()
  }

  key() {
    return `meter-${this.meterName}`
  }

  fresh(state) {
    const month = new Date(Math.floor(this.nowMs() / 1000) * 1000).toISOString().slice(0, 7)
    let s = isObject(state) ? { ...state } : { month, used: 0, credit: 0, notes: [] }
    s = { ...s }
    for (const [k, v] of Object.entries({ month, used: 0, credit: 0, notes: [] })) if (!Object.hasOwn(s, k)) s[k] = v
    if (s.month !== month) {
      s.month = month
      s.used = 0
    }
    return s
  }

  async usage() {
    const s = this.fresh(await this.store.get(this.key()))
    return { month: s.month, used: Math.trunc(Number(s.used)), free: this.free, credit: Math.trunc(Number(s.credit)), notes: Array.isArray(s.notes) ? s.notes.length : Object.keys(s.notes ?? {}).length }
  }

  async wantsCredit() {
    return this.lowOn(this.fresh(await this.store.get(this.key())))
  }

  lowOn(s) {
    return s.used >= this.free && s.credit < this.block * 0.1
  }

  charge() {
    const free = this.free
    const onEmpty = this.empty
    return this.store.update(this.key(), (state) => {
      const s = this.fresh(state)
      let out
      if (s.used < free) {
        s.used++
        out = { ok: true, free: true }
      } else if (s.credit > 0) {
        s.credit--
        s.used++
        out = { ok: true, credit: s.credit }
      } else if (onEmpty === 'allow') {
        s.used++
        out = { ok: true, unpaid: true }
      } else {
        out = { ok: false, status: 402, code: 'gate_credit_exhausted', why: 'This gate has no checks left this month. It admits again when the seller adds credit.' }
      }
      return [s, { ...out, buy: this.lowOn(s) }]
    })
  }

  addCredit(noteId, checks) {
    const id = String(noteId)
    const n = Math.trunc(Number(checks))
    return this.store.update(this.key(), (state) => {
      const s = this.fresh(state)
      const notes = Array.isArray(s.notes) ? [...s.notes] : Object.values(s.notes ?? {})
      if (notes.includes(id)) return [state, { ok: false, why: 'this note is already added' }]
      notes.push(id)
      s.notes = notes
      s.credit += n
      return [s, { ok: true, credit: s.credit }]
    })
  }
}

export function gateHttp(fetchFn = globalThis.fetch, timeout = 20) {
  return async (method, url, headers = {}, body = null) => {
    if (!/^https?:\/\//i.test(String(url))) throw new InvalidArgument('a URL starts with http:// or https://')
    const r = await fetchFn(url, { method: String(method).toUpperCase(), headers, body: body ?? '', redirect: 'manual', signal: AbortSignal.timeout(timeout * 1000) })
    const out = {}
    r.headers.forEach((v, k) => { out[k.toLowerCase()] = v })
    return { status: r.status, headers: out, body: await r.text() }
  }
}

export class Credits {
  static MICRO_PER_THOUSAND = 500000

  constructor(meter, issuer = null, options = {}) {
    this.meter = meter
    this.issuer = issuer
    this.http = typeof options.http === 'function' ? options.http : gateHttp(options.fetch)
    this.now = typeof options.now === 'function' ? options.now : null
    this.random = typeof options.random === 'function' ? options.random : (n) => randomBytes(n)
    this.maxMicroPerThousand = options.maxMicroPerThousand !== undefined ? Math.trunc(Number(options.maxMicroPerThousand)) : Credits.MICRO_PER_THOUSAND
  }

  nowMs() {
    return this.now !== null ? Math.trunc(Number(this.now())) : Date.now()
  }

  static priceMicro(checks, microPerThousand = Credits.MICRO_PER_THOUSAND) {
    return Math.ceil((Math.trunc(Number(checks)) / 1000) * microPerThousand)
  }

  async addNote(note, issuer, sellerPayout, name) {
    if (!issuer || !Address.isAddress(issuer)) return { ok: false, why: 'this Bridge has no credit issuer set' }
    if (note === null || typeof note !== 'object') return { ok: false, why: 'not a credit note' }
    for (const f of ['id', 'seller', 'name', 'checks', 'issued', 'signature']) if (!Object.hasOwn(note, f) || !scalar(note[f])) return { ok: false, why: 'not a credit note' }
    if (!Address.equals(str(note.seller), String(sellerPayout)) || note.name !== name) return { ok: false, why: 'the note is for another seller' }
    if (!Number.isInteger(note.checks) && !(typeof note.checks === 'string' && /^[1-9][0-9]*$/.test(note.checks))) return { ok: false, why: 'not a credit note' }
    const v = await Pass.verifyNote(note, issuer)
    if (!v.ok) return v
    const added = await this.meter.addCredit(note.id, v.checks)
    if (!added.ok) return added
    return { ok: true, checks: v.checks, credit: added.credit }
  }

  static creditRequestUrl(creditUrl, checks, sellerPayout, name) {
    return `${String(creditUrl).replace(/\/+$/, '')}/credits?checks=${rawurlencode(checks)}&seller=${rawurlencode(sellerPayout)}&name=${rawurlencode(name)}`
  }

  static selectRequirement(paymentRequired) {
    if (!isObject(paymentRequired) || !Array.isArray(paymentRequired.accepts)) return null
    for (const req of paymentRequired.accepts) {
      if (!isObject(req) || req.scheme === undefined || req.scheme === null || req.network === undefined || req.network === null || req.scheme !== 'exact' || req.network !== Exact.NETWORK) continue
      const flow = isObject(req.extra) && req.extra.paymentFlow !== undefined ? req.extra.paymentFlow : null
      if (flow !== null && flow !== 'authorization') continue
      return req
    }
    return null
  }

  static fail(code, why, status = null) {
    return { ok: false, code, why, status }
  }

  async sign(paymentRequired, creditKey, checks) {
    const req = Credits.selectRequirement(paymentRequired)
    if (req === null) return Credits.fail('no_requirement', `the credit service asked for nothing this client pays (exact on ${Exact.NETWORK})`)
    if (isObject(req.extra) && req.extra.assetTransferMethod !== undefined && req.extra.assetTransferMethod !== null && req.extra.assetTransferMethod !== 'eip3009') return Credits.fail('no_requirement', `the credit service asked for ${req.extra.assetTransferMethod}; this client signs EIP-3009 only`)
    const e = (v) => v === undefined || v === null || v === '' || v === '0' || v === 0 || v === false
    const set = (v) => v !== undefined && v !== null
    if (e(req.extra?.name) || e(req.extra?.version) || !set(req.asset) || !set(req.payTo) || !set(req.amount) || !set(req.maxTimeoutSeconds)) return Credits.fail('bad_requirement', 'the requirement is missing its asset, payTo, amount, timeout or EIP-712 domain')
    if (typeof req.asset !== 'string' || !Address.equals(req.asset, Erc20.USDC_BASE) || typeof req.payTo !== 'string' || !Address.isAddress(req.payTo) || !Number.isInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds < 1) return Credits.fail('bad_requirement', 'the requirement is not USDC on Base to an address')
    const amount = Exact.bigint(req.amount)
    const ceiling = Credits.priceMicro(checks, this.maxMicroPerThousand)
    if (amount === null || amount < 0n || amount > BigInt(ceiling)) return Credits.fail('overpriced', `the credit service asked ${scalar(req.amount) ? req.amount : '?'} micro-USDC for ${checks} checks; the ceiling is ${ceiling}`)
    const nonce = '0x' + Buffer.from(await this.random(32)).toString('hex')
    const inner = await Exact.authorize(creditKey, req, Math.floor(this.nowMs() / 1000), nonce)
    const payload = Exact.paymentPayload(paymentRequired, req, inner)
    return { ok: true, payload, header: Exact.encodeHeader(payload), requirement: req }
  }

  async buy(creditUrl, checks, creditKey, sellerPayout, name, chain = null) {
    const n = Math.trunc(Number(checks))
    if (!(n >= 1000) || n % 1000 !== 0) return Credits.fail('bad_checks', 'checks is a multiple of 1,000')
    if (!Address.isAddress(sellerPayout) || !/^[a-z][a-z0-9-]{1,31}$/.test(String(name))) return Credits.fail('bad_seller', "seller is the seller's payout address and name its Bridge name")
    const url = Credits.creditRequestUrl(creditUrl, n, sellerPayout, name)
    let first
    try {
      first = await this.http('POST', url, {}, null)
    } catch (err) {
      return Credits.fail('unreachable', String(err?.message ?? err))
    }
    if (first.status === 200) return this.finish(first, sellerPayout, name)
    if (first.status !== 402) return Credits.fail('unexpected_status', `the credit service answered HTTP ${first.status}`, first.status)
    const headers = Object.fromEntries(Object.entries(first.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    const paymentRequired = headers['payment-required'] !== undefined && headers['payment-required'] !== '' ? Exact.decodeHeader(headers['payment-required']) : null
    if (!isObject(paymentRequired) || paymentRequired.x402Version !== 2) return Credits.fail('no_requirement', 'the 402 carries no x402 v2 PAYMENT-REQUIRED header', 402)
    const signed = await this.sign(paymentRequired, creditKey, n)
    if (!signed.ok) return signed
    if (chain !== null && typeof chain?.balanceOf === 'function') {
      const from = Secp256k1.privateKeyToAddress(creditKey)
      let balance
      try {
        balance = BigInt(await chain.balanceOf(Erc20.USDC_BASE, from))
      } catch (err) {
        return Credits.fail('rpc', `could not read the credit key's USDC balance: ${String(err?.message ?? err)}`)
      }
      if (balance < Exact.bigint(signed.requirement.amount)) return Credits.fail('insufficient_usdc', `${from} holds ${balance} micro-USDC; the credit costs ${signed.requirement.amount}`)
    }
    let second
    try {
      second = await this.http('POST', url, { 'PAYMENT-SIGNATURE': signed.header, 'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE' }, null)
    } catch (err) {
      return Credits.fail('unreachable', String(err?.message ?? err))
    }
    return this.finish(second, sellerPayout, name)
  }

  async finish(response, sellerPayout, name) {
    let note = null
    try {
      note = JSON.parse(String(response.body))
    } catch {
      note = null
    }
    if (response.status !== 200) {
      const error = note !== null && typeof note === 'object' && scalar(note.error) ? str(note.error) : `HTTP ${response.status}`
      const reason = note !== null && typeof note === 'object' && scalar(note.reason) ? `: ${note.reason}` : ''
      return Credits.fail('not_bought', `could not buy credit (${response.status} ${error}${reason})`, response.status)
    }
    if (note === null || typeof note !== 'object') return Credits.fail('not_bought', 'the credit service answered 200 without a note', 200)
    const added = this.issuer ? await this.addNote(note, this.issuer, sellerPayout, name) : { ok: false, why: 'this Bridge has no credit issuer set' }
    return { ok: added.ok, note, added }
  }
}

