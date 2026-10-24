import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Address, Hex, Keccak } from '../core/hex.mjs'
import { Token } from '../core/evm.mjs'
import { Secp256k1 } from '../core/secp256k1.mjs'

const B64URL = /^[A-Za-z0-9_-]+$/
const UINT = /^(0|[1-9]\d*)$/
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const PARAM_ORDER = ['id', 'realm', 'method', 'intent', 'expires', 'digest', 'header', 'opaque', 'description', 'request']
const BOUND = ['id', 'realm', 'method', 'intent', 'request', 'expires', 'digest', 'header', 'opaque']
const PROBLEM = 'https://paymentauth.org/problems/'
const NOT_THE_PROBLEM = ['accepts', 'session']
const BAD_GRANT = 'bad_grant'

export class MppError extends Error {
  constructor(type, detail, more = null) {
    super(detail)
    this.type = type
    this.detail = detail
    this.more = more
  }
}

const malformed = (detail) => new MppError('malformed-credential', detail)
const invalid = (detail) => new MppError('invalid-challenge', detail)
const failed = (detail) => new MppError('verification-failed', detail)

export const Base64Url = {
  encode(bytes) {
    return Buffer.from(bytes).toString('base64url')
  },
  decode(text) {
    if (typeof text !== 'string' || !B64URL.test(text)) throw malformed('not base64url')
    return Buffer.from(text, 'base64url')
  },
  json(value) {
    return Base64Url.encode(Buffer.from(Jcs.encode(value), 'utf8'))
  },
  parse(text) {
    let out
    try {
      out = JSON.parse(Base64Url.decode(text).toString('utf8'))
    } catch (e) {
      if (e instanceof MppError) throw e
      throw malformed('not JSON')
    }
    if (out === null || typeof out !== 'object' || Array.isArray(out)) throw malformed('not a JSON object')
    return out
  },
}

export const Jcs = {
  encode(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('a JSON number is finite')
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) return `[${value.map((v) => Jcs.encode(v === undefined ? null : v)).join(',')}]`
    if (typeof value === 'object') {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${Jcs.encode(value[k])}`).join(',')}}`
    }
    throw new TypeError('not encodable as JSON')
  },
}

export const Challenge = {
  id(secret, c) {
    const slots = [c.realm, c.method, c.intent, c.request, c.expires ?? '', c.digest ?? '']
    if (c.header !== undefined && c.header !== null) slots.push(c.header)
    slots.push(c.opaque ?? '')
    return Base64Url.encode(createHmac('sha256', secret).update(slots.join('|'), 'utf8').digest())
  },
  once() {
    return { n: Base64Url.encode(randomBytes(12)) }
  },
  issue(secret, { realm, method, intent, request, expires = null, description = null, opaque = null }) {
    const c = { realm: String(realm), method: String(method), intent: String(intent), request: Base64Url.json(request) }
    if (expires !== null) c.expires = String(expires)
    if (opaque !== null) c.opaque = Base64Url.json(opaque)
    c.id = Challenge.id(secret, c)
    if (description !== null && description !== '') c.description = String(description)
    return c
  },
  bound(secret, c) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return false
    for (const k of ['id', 'realm', 'method', 'intent', 'request']) if (typeof c[k] !== 'string' || c[k] === '') return false
    for (const k of ['expires', 'digest', 'header', 'opaque']) if (c[k] !== undefined && typeof c[k] !== 'string') return false
    const want = Buffer.from(Challenge.id(secret, c), 'utf8')
    const got = Buffer.from(c.id, 'utf8')
    return want.length === got.length && timingSafeEqual(want, got)
  },
  header(c) {
    const parts = []
    for (const k of PARAM_ORDER) {
      if (c[k] === undefined || c[k] === null) continue
      parts.push(`${k}="${String(c[k]).replace(/[^\x20-\x7e]/g, '').replace(/[\\"]/g, (m) => `\\${m}`)}"`)
    }
    return `Payment ${parts.join(', ')}`
  },
  parse(value) {
    const out = []
    const s = String(value ?? '')
    let i = 0
    const ws = () => {
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++
    }
    const token = () => {
      const from = i
      while (i < s.length && TOKEN.test(s[i])) i++
      return s.slice(from, i)
    }
    let current = null
    while (i < s.length) {
      ws()
      if (s[i] === ',') {
        i++
        continue
      }
      const word = token()
      if (word === '') break
      ws()
      if (s[i] !== '=') {
        current = word.toLowerCase() === 'payment' ? {} : null
        if (current !== null) out.push(current)
        continue
      }
      i++
      ws()
      let v = ''
      if (s[i] === '"') {
        i++
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) i++
          v += s[i++]
        }
        i++
      } else v = token()
      if (current !== null && !Object.hasOwn(current, word)) current[word] = v
    }
    return out.filter((c) => typeof c.id === 'string' && c.id !== '' && typeof c.method === 'string' && typeof c.intent === 'string' && typeof c.request === 'string')
  },
  echo(c) {
    const out = {}
    for (const k of BOUND) if (c[k] !== undefined && c[k] !== null) out[k] = c[k]
    return out
  },
  forMeta(c) {
    return { ...c, request: Base64Url.parse(c.request) }
  },
  fromMeta(c) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return null
    const out = { ...c }
    if (c.request !== null && typeof c.request === 'object' && !Array.isArray(c.request)) out.request = Base64Url.json(c.request)
    if (c.opaque !== null && typeof c.opaque === 'object' && !Array.isArray(c.opaque)) out.opaque = Base64Url.json(c.opaque)
    return out
  },
}

export const McpPayment = {
  CREDENTIAL: 'org.paymentauth/credential',
  REQUIRED: 'org.paymentauth/payment-required',
  RECEIPT: 'org.paymentauth/receipt',
  header(meta) {
    const v = meta !== null && typeof meta === 'object' ? meta[McpPayment.CREDENTIAL] : null
    if (v === null || v === undefined) return ''
    const ok = typeof v === 'object' && !Array.isArray(v) && v.payload !== null && typeof v.payload === 'object'
    const challenge = ok ? Challenge.fromMeta(v.challenge) : null
    if (challenge === null) return 'Payment e30'
    return Credential.serialize({ challenge, payload: v.payload, source: typeof v.source === 'string' ? v.source : null })
  },
  required(headerValue, body = null) {
    const challenges = Challenge.parse(headerValue)
    if (!challenges.length) return null
    const out = { httpStatus: 402, challenges: challenges.map(Challenge.forMeta) }
    if (body !== null && typeof body === 'object' && typeof body.type === 'string' && body.type.startsWith(PROBLEM)) out.problem = Object.fromEntries(Object.entries(body).filter(([k, v]) => !NOT_THE_PROBLEM.includes(k) && v !== undefined))
    if (body !== null && typeof body === 'object' && body.session !== null && typeof body.session === 'object') out.session = body.session
    return out
  },
  PAYMENT_REQUIRED: -32042,
  VERIFICATION_FAILED: -32043,
  INVALID_PARAMS: -32602,
  SESSION: /^payment\.[A-Za-z0-9_-]{16}$/,
  capability(intents = [EvmCharge.INTENT]) {
    return { methods: { [EvmCharge.METHOD]: { intents: [...intents] } } }
  },
  declares(capabilities) {
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    return isObject(capabilities) && isObject(capabilities.experimental) && isObject(capabilities.experimental.payment)
  },
  session(bytes = randomBytes(12)) {
    return `payment.${Base64Url.encode(bytes)}`
  },
  inSession(id) {
    return typeof id === 'string' && McpPayment.SESSION.test(id.trim())
  },
  params(message) {
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    if (!isObject(message) || !isObject(message.params)) return message?.params ?? null
    const p = message.params
    const root = isObject(message._meta) ? message._meta[McpPayment.CREDENTIAL] : undefined
    if (root === undefined || root === null || (p._meta !== undefined && !isObject(p._meta))) return p
    if (p._meta !== undefined && p._meta[McpPayment.CREDENTIAL] !== undefined && p._meta[McpPayment.CREDENTIAL] !== null) return p
    return { ...p, _meta: { ...(p._meta ?? {}), [McpPayment.CREDENTIAL]: root } }
  },
  error(required, refused = null) {
    if (required === null || typeof required !== 'object' || !Array.isArray(required.challenges) || !required.challenges.length) return null
    const problem = required.problem ?? null
    const reason = problem === null ? 'payment-required' : String(problem.type).slice(PROBLEM.length)
    const data = { httpStatus: 402, challenges: required.challenges, ...(required.session !== undefined ? { session: required.session } : {}) }
    if (problem !== null) data.problem = problem
    if (problem === null && refused !== null && typeof refused === 'object' && refused.error === BAD_GRANT) {
      const said = Object.fromEntries(['error', 'message', 'how', 'contact'].filter((k) => typeof refused[k] === 'string').map((k) => [k, refused[k]]))
      return { code: McpPayment.VERIFICATION_FAILED, message: 'Payment Verification Failed', data: { ...data, failure: { reason: BAD_GRANT, detail: String(refused.message ?? '') }, ...said } }
    }
    if (reason === 'payment-required') return { code: McpPayment.PAYMENT_REQUIRED, message: 'Payment Required', data }
    if (reason === 'malformed-credential') return { code: McpPayment.INVALID_PARAMS, message: 'Invalid params', data: { ...data, detail: String(problem.detail) } }
    return { code: McpPayment.VERIFICATION_FAILED, message: 'Payment Verification Failed', data: { ...data, failure: { reason, detail: String(problem.detail) } } }
  },
}

export const Credential = {
  SCHEME: /^payment\s+(\S+)\s*$/i,
  is(headerValue) {
    return typeof headerValue === 'string' && Credential.SCHEME.test(headerValue)
  },
  parse(headerValue) {
    const m = Credential.SCHEME.exec(String(headerValue ?? ''))
    if (m === null) throw malformed('the credential is `Payment <base64url>`')
    const c = Base64Url.parse(m[1])
    if (c.challenge === null || typeof c.challenge !== 'object' || Array.isArray(c.challenge)) throw malformed('the credential carries no challenge')
    if (c.payload === null || typeof c.payload !== 'object' || Array.isArray(c.payload)) throw malformed('the credential carries no payload')
    if (c.source !== undefined && typeof c.source !== 'string') throw malformed('source is a string')
    return c
  },
  serialize({ challenge, payload, source = null }) {
    const c = { challenge: Challenge.echo(challenge), payload }
    if (source !== null) c.source = source
    return `Payment ${Base64Url.json(c)}`
  },
}

export const Receipt = {
  header(receipt) {
    return Base64Url.json(receipt)
  },
  parse(value) {
    return Base64Url.parse(String(value ?? '').trim())
  },
}

export const Problem = {
  body(type, detail, title = null) {
    const titles = { 'malformed-credential': 'Malformed Credential', 'invalid-challenge': 'Invalid Challenge', 'verification-failed': 'Verification Failed', 'payment-required': 'Payment Required' }
    return { type: PROBLEM + type, title: title ?? titles[type] ?? 'Payment Problem', status: 402, detail: String(detail) }
  },
  of(error) {
    return error instanceof MppError ? { ...Problem.body(error.type, error.detail), ...(error.more ?? {}) } : Problem.body('verification-failed', String(error?.message ?? error))
  },
}

export const EvmCharge = {
  METHOD: 'evm',
  INTENT: 'charge',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  request({ amount, currency, recipient, chainId, decimals = null, description = null, externalId = null }) {
    if (!UINT.test(String(amount)) || BigInt(amount) <= 0n) throw new TypeError('a charge is a positive amount in base units')
    const r = { amount: String(amount), currency: Address.checksum(currency), recipient: Address.checksum(recipient), methodDetails: { chainId: Math.trunc(Number(chainId)), credentialTypes: ['authorization'], permit2Address: EvmCharge.PERMIT2 } }
    if (decimals !== null) r.methodDetails.decimals = Math.trunc(Number(decimals))
    if (description !== null && description !== '') r.description = String(description)
    if (externalId !== null && externalId !== '') r.externalId = String(externalId)
    return r
  },
  challengeHashes(challenge) {
    return [
      Keccak.utf8(JSON.stringify([challenge.id, challenge.realm])),
      Keccak.hashHex(Hex.concat([Hex.fromUtf8(challenge.id), Hex.fromUtf8(challenge.realm)])),
    ]
  },
  source(chainId, address) {
    return `did:pkh:eip155:${Math.trunc(Number(chainId))}:${Address.checksum(address)}`
  },
  async payload(key, challenge, tokenDomain, nowSecs = Math.floor(Date.now() / 1000)) {
    const request = Base64Url.parse(challenge.request)
    const from = Secp256k1.privateKeyToAddress(key)
    const expires = challenge.expires ? Math.floor(new Date(challenge.expires).getTime() / 1000) : nowSecs + 300
    const authorization = { from, to: Address.checksum(request.recipient), value: String(request.amount), validAfter: '0', validBefore: String(expires), nonce: EvmCharge.challengeHashes(challenge)[0] }
    const signature = await Token.signTransfer(key, tokenDomain, authorization)
    return { type: 'authorization', ...authorization, signature }
  },
  async verify(secret, credential, expect, nowSecs = Math.floor(Date.now() / 1000)) {
    const c = credential.challenge
    if (!Challenge.bound(secret, c)) throw invalid('this challenge was not issued here, or was altered')
    if (c.method !== EvmCharge.METHOD || c.intent !== EvmCharge.INTENT) throw invalid('not an evm charge challenge')
    if (c.realm !== expect.realm) throw invalid('the challenge is for another realm')
    const expiresAt = c.expires !== undefined ? new Date(c.expires).getTime() : null
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt / 1000 <= nowSecs)) throw invalid('the challenge has expired')
    const request = Base64Url.parse(c.request)
    const details = request.methodDetails ?? {}
    if (Math.trunc(Number(details.chainId)) !== Math.trunc(Number(expect.chainId))) throw invalid('the challenge is for another chain')
    if (!Address.equals(request.currency, expect.currency)) throw invalid('the challenge is for another currency')
    if (!Address.equals(request.recipient, expect.recipient)) throw invalid('the challenge pays another recipient')
    if (Array.isArray(details.splits) && details.splits.length) throw failed('an authorization credential cannot carry splits')
    const p = credential.payload
    if (p.type !== 'authorization') throw malformed('this challenge takes payload type "authorization"')
    for (const k of ['from', 'to']) if (!Address.isAddress(p[k])) throw malformed(`${k} is an address`)
    for (const k of ['value', 'validAfter', 'validBefore']) if (typeof p[k] !== 'string' || !UINT.test(p[k])) throw malformed(`${k} is a base-10 integer string`)
    if (!Hex.isHex(p.nonce, 32)) throw malformed('nonce is 32 bytes of hex')
    if (typeof p.signature !== 'string' || !Hex.isHex(p.signature) || p.signature.length < 130) throw malformed('signature is hex')
    if (!Address.equals(p.to, request.recipient)) throw failed('the authorization pays another recipient')
    if (p.value !== String(request.amount)) throw failed('the authorization is for another amount')
    if (!EvmCharge.challengeHashes(c).includes(Hex.lower(p.nonce))) throw failed('the authorization nonce is not bound to this challenge')
    if (BigInt(p.validAfter) > BigInt(nowSecs)) throw failed('the authorization is not valid yet')
    if (BigInt(p.validBefore) <= BigInt(nowSecs)) throw failed('the authorization has expired')
    if (expiresAt !== null && BigInt(p.validBefore) > BigInt(Math.floor(expiresAt / 1000))) throw failed('the authorization outlives its challenge')
    const authorization = { from: Address.checksum(p.from), to: Address.checksum(p.to), value: p.value, validAfter: p.validAfter, validBefore: p.validBefore, nonce: Hex.lower(p.nonce) }
    let signer = null
    if (Hex.toBytes(p.signature).length === 65 || Hex.toBytes(p.signature).length === 64) {
      if (!Secp256k1.isCanonical(p.signature)) throw failed('the authorization signature is not in the form the token accepts: 65 bytes, v 27 or 28, low s')
      try {
        signer = await Secp256k1.recoverHash(Token.transferDigest(expect.tokenDomain, authorization), p.signature)
      } catch {
        signer = null
      }
      if (signer === null || !Address.equals(signer, authorization.from)) throw failed('the authorization signature does not recover to its payer')
    }
    const source = EvmCharge.source(details.chainId, authorization.from)
    if (credential.source !== undefined && credential.source.toLowerCase() !== source.toLowerCase()) throw failed('source is not the payer')
    return { challenge: c, request, authorization, signature: Hex.lower(p.signature), payer: authorization.from, source, ecdsa: signer !== null, replayKey: `${authorization.from.toLowerCase()}:${authorization.nonce}` }
  },
  call(verified) {
    return { to: Address.checksum(verified.request.currency), data: Token.encodeTransfer(verified.authorization, verified.signature) }
  },
  receipt(verified, hash, timestamp = new Date().toISOString()) {
    const r = { method: EvmCharge.METHOD, challengeId: verified.challenge.id, reference: Hex.lower(hash), status: 'success', timestamp, chainId: Math.trunc(Number(verified.request.methodDetails.chainId)) }
    if (verified.request.externalId !== undefined) r.externalId = verified.request.externalId
    return r
  },
}
