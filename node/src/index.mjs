import { CONTRACTS, GRANTED_BY, createEngine, feeRecipient } from './engine/index.mjs'
import { randomBytes } from 'node:crypto'
import { FreeLimit, describe as describePrice, priceOf, usd } from './engine/pricing.mjs'
import { boughtMs, timeMicro, timeRate, timeText } from './engine/meter.mjs'
import { bazaar, forHeader } from './engine/bazaar.mjs'
import { Json } from './engine/settlement/json.mjs'
import { CACHE_CONTROL, FAILED_CALL, discovery } from './engine/discovery.mjs'
import { StateFile } from './engine/stores.mjs'
import { Books, gasOf } from './engine/health.mjs'
import { Config } from './engine/settlement/config.mjs'
import { Channels } from './engine/settlement/channels.mjs'
import { Credits } from './engine/gate/index.mjs'
import { Address } from './engine/core/hex.mjs'
import { Erc20 } from './engine/core/batch.mjs'
import { Base64Url, Challenge, Credential, EvmCharge, McpPayment, Receipt } from './engine/settlement/mpp.mjs'
import { Sessions } from './engine/settlement/sessions.mjs'
import { MODERN_VERSIONS, classify, complete, eventStream, isJson, roll, rpcError, streams } from './mcp.mjs'

const META_PAYMENT = 'x402/payment'
const META_RESPONSE = 'x402/payment-response'
const META_GRANTED_BY = 'zeam-pass/granted-by'
const META_PRICE = 'zeam-pass/price'
const META_LINE = 'zeam-pass/line'
const META_METER = 'zeam-pass/meter'
const MCP_SESSION = /^mcp\.[A-Za-z0-9_-]{16}$/
const LINE_OPS = ['open', 'prove', 'on', 'off', 'status', 'close']
const DESCRIBED = ['title', 'description', 'summary', 'arguments', 'annotations', 'outputSchema', 'listedOutputSchema', '_meta', 'aliases']
const CUT_OURS = ['error', 'message', 'msRemaining', 'elapsedMs', 'tool', 'accepts', 'x402Version']
const REFUSALS = [{ type: 'object', required: ['error'] }, { type: 'object', required: ['accepts'] }]
const PAYMENT_ONLY_RESULT = { type: 'object', required: ['receipt'] }
const LINE_ARGUMENTS = {
  op: 'The step. open returns a message to sign for a channel; prove returns the line credential for that signature; on and off switch the meter; status reports the time left; close ends the line.',
  channelId: 'For open and prove: the id of the channel that paid for the time, 0x and 64 hex characters.',
  nonce: 'For prove: the nonce the open answer gave.',
  signature: 'For prove: the signature, made with the channel payer key, of the message the open answer gave in sign.',
  credential: `For on, off, status and close: the credential the prove answer gave. It may be left out when the request carries it as the x-line header or, over MCP, in _meta["${META_LINE}"].`,
}
const CHANNEL = /^0x[0-9a-fA-F]{64}$/
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']
const PAYMENT_ANSWERS = [402, 403, 429, 503]
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate, Payment-Receipt, X-Pass-Granted-By, X-Pass-Ms-Remaining, X-Pass-Ms-Elapsed' }
const SESSIONS_HOW = '; an MPP session pays each call from one deposit'
const HOW = { paywall: 'Paid per call with x402 or MPP', gate: 'Admitted keys only, proven by a zero-value x402 signature; nothing is paid', both: 'Admitted keys only, paid per call with x402 or MPP' }
const REFUND_TURN = 'Zeam-Refund-Turn'
const PREFLIGHT = { ...CORS, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, payment-signature, x-payment, authorization, payment-authorization, x-line, x-grant, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name', 'access-control-max-age': '86400' }

const names = Object.freeze({
  headers: Object.freeze({ payment: 'payment-signature', credential: 'authorization', line: 'x-line', grant: 'x-grant', required: 'PAYMENT-REQUIRED', response: 'PAYMENT-RESPONSE', challenge: 'WWW-Authenticate', receipt: 'Payment-Receipt', grantedBy: GRANTED_BY, msRemaining: 'X-Pass-Ms-Remaining', msElapsed: 'X-Pass-Ms-Elapsed' }),
  meta: Object.freeze({ payment: META_PAYMENT, response: META_RESPONSE, credential: McpPayment.CREDENTIAL, required: McpPayment.REQUIRED, receipt: McpPayment.RECEIPT, line: META_LINE, meter: META_METER, price: META_PRICE, grantedBy: META_GRANTED_BY }),
  rpc: Object.freeze({ paymentRequired: -32402 }),
})

const b64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s))))
const unb64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64').toString('utf8') : decodeURIComponent(escape(atob(s))))
const decodeHeader = (v) => { try { return JSON.parse(unb64(String(v))) } catch { return null } }
const PROBLEMS = 'https://paymentauth.org/problems/'
const typed = (body) => (body !== null && typeof body === 'object' && typeof body.type === 'string' && body.type.startsWith(PROBLEMS) ? 'application/problem+json' : 'application/json')
const json = (status, body, headers = {}) => (status === 204 ? new Response(null, { status, headers }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': typed(body), ...headers } }))
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const fits = (v, t) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : kind(v) === t)
const text = (o) => [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }]
const message = (e) => String(e?.message ?? e)
const bare = (url) => (typeof url === 'string' ? url.split('#')[0].split('?')[0] : url)
const brief = (t) => (typeof t?.summary === 'string' && t.summary.trim() !== '' ? t.summary.trim() : t?.description)
const BAD_CURSOR = 'Invalid params: cursor is not one this server gave for this list; ask again without it'
const PRICE_LIST_HOW = `prices is the price of the tool called, alone. Every tool's price: tools/list at mcp, in each tool's _meta["${META_PRICE}"]. Every paid tool's price: also the document at openapi, in each operation's x-price.`
const RESULT_NOT_JSON = `the result is not valid JSON (a non-finite number or a non-JSON value). ${FAILED_CALL}`
const said = (out) => (Array.isArray(out?.content) ? out.content.map((c) => c?.text).filter((t) => typeof t === 'string').join('\n') : '') || 'the tool reported an error'

class Fault extends Error {
  constructor(cause) {
    super('internal error')
    this.cause = cause
  }
}

const guarded = (run) => async (args, ctx) => {
  try { return await run(args, ctx) } catch (e) { throw new Fault(e) }
}

function faithful(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!(i in v) || !faithful(v[i])) return false
    return true
  }
  if (typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  if ((proto !== Object.prototype && proto !== null) || typeof v.toJSON === 'function') return false
  return Object.values(v).every((x) => x === undefined || faithful(x))
}

function serialize(value) {
  let body
  try { body = JSON.stringify(value) } catch { return null }
  return body === undefined || !faithful(value) ? null : body
}

function checkValue(k, p, v) {
  const types = p.type === undefined ? null : [].concat(p.type)
  if (types && !types.some((t) => fits(v, t))) return `argument ${k} must be ${types.join(' or ')}`
  if (Array.isArray(p.enum) && !p.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) return `argument ${k} must be one of ${JSON.stringify(p.enum)}`
  if (typeof v === 'number') {
    if (typeof p.minimum === 'number' && v < p.minimum) return `argument ${k} must be at least ${p.minimum}`
    if (typeof p.maximum === 'number' && v > p.maximum) return `argument ${k} must be at most ${p.maximum}`
    if (typeof p.multipleOf === 'number' && p.multipleOf > 0 && v % p.multipleOf !== 0) return `argument ${k} must be a multiple of ${p.multipleOf}`
  }
  if (typeof v === 'string') {
    const n = [...v].length
    if (typeof p.minLength === 'number' && n < p.minLength) return `argument ${k} must be at least ${p.minLength} characters`
    if (typeof p.maxLength === 'number' && n > p.maxLength) return `argument ${k} must be at most ${p.maxLength} characters`
  }
  if (Array.isArray(v)) {
    const items = (n) => `${n} item${n === 1 ? '' : 's'}`
    if (typeof p.minItems === 'number' && v.length < p.minItems) return `argument ${k} must have at least ${items(p.minItems)}`
    if (typeof p.maxItems === 'number' && v.length > p.maxItems) return `argument ${k} must have at most ${items(p.maxItems)}`
    if (kind(p.items) === 'object') {
      for (let i = 0; i < v.length; i++) {
        const bad = checkValue(`${k}[${i}]`, p.items, v[i]) ?? (kind(v[i]) === 'object' ? checkObject(p.items, v[i], `${k}[${i}].`, false) : null)
        if (bad) return bad
      }
    }
  }
  return null
}

function checkObject(s, args, prefix, nested) {
  for (const k of Array.isArray(s.required) ? s.required : []) if (!Object.hasOwn(args, k)) return `missing required argument: ${prefix}${k}`
  for (const [k, p] of Object.entries(kind(s.properties) === 'object' ? s.properties : {})) {
    if (!Object.hasOwn(args, k) || kind(p) !== 'object') continue
    const bad = checkValue(prefix + k, p, args[k])
    if (bad) return bad
    if (nested && kind(args[k]) === 'object') {
      const inner = checkObject(p, args[k], `${prefix}${k}.`, false)
      if (inner) return inner
    }
  }
  return null
}

function validate(schema, args) {
  if (kind(args) !== 'object') return 'the arguments must be an object'
  return checkObject(kind(schema) === 'object' ? schema : {}, args, '', true)
}


function required(r) {
  const t = decodeHeader(r.headers['PAYMENT-REQUIRED']) ?? (Array.isArray(r.body?.accepts) ? r.body : null)
  return kind(t) === 'object' ? { x402Version: 2, ...t } : null
}

function refusal(r) {
  if (r.status === 204) {
    const meta = settledMeta(r.headers)
    return { content: [], ...(kind(meta[McpPayment.RECEIPT]) === 'object' ? { structuredContent: { receipt: meta[McpPayment.RECEIPT] } } : {}), _meta: meta }
  }
  const terms = required(r)
  let mpp = null
  try { mpp = McpPayment.required(r.headers?.['WWW-Authenticate'], r.body) } catch { mpp = null }
  const meta = mpp === null ? {} : { _meta: { [McpPayment.REQUIRED]: mpp } }
  if (terms) {
    const own = kind(r.body) === 'object' ? r.body : {}
    const doc = typed(own) === 'application/problem+json' ? { ...own, ...terms, ...own } : { ...own, ...terms }
    return { isError: true, structuredContent: doc, content: [...text(doc), ...(typeof r.text === 'string' ? text(r.text) : [])], ...meta }
  }
  return kind(r.body) === 'object' ? { isError: true, structuredContent: r.body, content: text(r.body), ...meta } : { isError: true, content: text(r.body), ...meta }
}

function failure(body) {
  return { isError: true, structuredContent: body, content: text(body) }
}

function failed(out, tool) {
  if (kind(out?.structuredContent) === 'object') return out
  return { ...out, isError: true, structuredContent: { error: 'tool_failed', tool, message: said(out) } }
}

const ownStatus = (body) => (Number.isInteger(body?.status) && body.status >= 400 && body.status <= 599 && body.status !== 402 ? body.status : 500)

function failedHttp(out, tool) {
  const fields = failed(out, tool).structuredContent
  const body = { error: 'tool_failed', tool, message: said(out), ...fields }
  const wait = body.retry_after_seconds
  return { status: ownStatus(fields), body, headers: Number.isInteger(wait) && wait > 0 ? { 'retry-after': String(wait) } : {} }
}

const reading = (meta) => ({ 'x-pass-ms-remaining': String(meta.msRemaining), 'x-pass-ms-elapsed': String(meta.elapsedMs) })

const told = (l) => (l.meta ? { ...l.body, msRemaining: l.meta.msRemaining, elapsedMs: l.meta.elapsedMs } : l.body)

const metered = (out, meta) => (meta ? { ...out, _meta: { ...(kind(out._meta) === 'object' ? out._meta : {}), [META_METER]: meta } } : out)

function settledMeta(headers) {
  const meta = {}
  const settled = decodeHeader(headers?.['PAYMENT-RESPONSE'])
  if (settled) meta[META_RESPONSE] = settled
  if (typeof headers?.[GRANTED_BY] === 'string') meta[META_GRANTED_BY] = headers[GRANTED_BY]
  if (typeof headers?.['Payment-Receipt'] === 'string') {
    try { meta[McpPayment.RECEIPT] = Receipt.parse(headers['Payment-Receipt']) } catch {}
  }
  return meta
}

const payHeader = (payment, grant = null, meta = null) => (h) => (h === 'payment-signature' && payment ? b64(JSON.stringify(payment)) : h === 'x-grant' ? grant : h === 'authorization' && !payment ? McpPayment.header(meta) : null)

const LONGEST_TIMER = 2 ** 31 - 1
const TURN_MS = 5

function countdown(ms, fire) {
  let left = Math.max(0, ms)
  let timer
  const step = () => {
    const wait = Math.min(left, LONGEST_TIMER)
    left -= wait
    timer = setTimeout(() => (left > 0 ? step() : fire()), wait)
    timer.unref?.()
  }
  step()
  return () => clearTimeout(timer)
}

function gone(signal) {
  const r = signal?.reason
  return r instanceof Error && typeof r.code === 'string' ? r : Object.assign(new Error('the caller hung up or canceled the call, so it was stopped.'), { code: 'client_gone' })
}

const hangupOf = (request, info) => (info?.signal instanceof AbortSignal ? info.signal : request?.signal ?? null)

function hungUp(e, onLine, more = {}) {
  return { status: Number.isInteger(e.status) ? e.status : 499, body: { error: e.code, message: `${message(e)} ${onLine ? 'The line is billed for the time the call ran, nothing after.' : 'Nothing was charged.'}`, ...more } }
}

function readBody(req) {
  if (req.body !== undefined) return Promise.resolve(typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body))
  return new Promise((ok, fail) => { let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => ok(b)); req.on('error', fail) })
}

async function toRequest(req, signal) {
  const url = `${req.protocol ?? 'http'}://${req.headers.host ?? 'localhost'}${req.originalUrl ?? req.url}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!k.startsWith(':') && !['content-length', 'transfer-encoding'].includes(k) && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
  const hasBody = !['GET', 'HEAD'].includes(req.method)
  return new Request(url, { method: req.method, headers, body: hasBody ? await readBody(req) : undefined, signal })
}

async function send(res, response) {
  res.statusCode = response.status
  response.headers.forEach((v, k) => res.setHeader(k, v))
  if (response.body && (response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    res.flushHeaders?.()
    for await (const chunk of response.body) {
      if (res.destroyed || res.writableEnded) return
      res.write(chunk)
    }
    res.end()
    return
  }
  res.end(Buffer.from(await response.arrayBuffer()))
}

function fallback(res, e, body) {
  if (res.headersSent) return res.destroy?.(e)
  res.statusCode = 500
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function bridge(options = {}) {
  const engine = createEngine(options)
  const { serverName = engine.options.name, version = '1.0.0', lineArgument = null, lineQuery = null, stream = false, listPage = null, priceList = 'all' } = options
  if (lineQuery !== null && (typeof lineQuery !== 'string' || lineQuery === '')) throw new Error('bridge: lineQuery is the name of a query parameter')
  if (lineArgument !== null && (typeof lineArgument !== 'string' || lineArgument === '')) throw new Error('bridge: lineArgument is the name of an argument')
  if (listPage !== null && !(Number.isSafeInteger(listPage) && listPage >= 1)) throw new Error('bridge: listPage is how many entries one page of a list carries, a whole number, 1 or more')
  if (!['all', 'tool'].includes(priceList)) throw new Error('bridge: priceList is "all" or "tool"')
  if (options.unpaid !== undefined && typeof options.unpaid !== 'function') throw new Error('bridge: unpaid is a function that returns { fields, text }')
  if (options.onError !== undefined && typeof options.onError !== 'function') throw new Error('bridge: onError is a function of the error and where it happened')
  const internal = (e, at = {}) => {
    if (options.onError) { try { options.onError(e, at) } catch {} }
    return { error: 'internal_error', message: 'internal error' }
  }
  const lost = (res, e, req) => fallback(res, e, internal(e, { method: req?.method, path: bare(req?.originalUrl ?? req?.url), ip: req?.ip ?? req?.socket?.remoteAddress }))
  const about = {}
  const resources = new Map()
  const site = engine.options.site
  const tools = new Map()
  const routes = new Map()
  const wrapped = new Map()
  const toolRoll = roll('tools')
  const resourceRoll = roll('resources')
  const o = engine.options
  const freeLimit = new FreeLimit(o.freeLimit, () => (o.clock ? Number(o.clock()) : Date.now()))
  const freeFile = new StateFile(o.stateDir, 'free.json')
  const freeCap = (t) => (t.freeLimit === false ? null : Number.isSafeInteger(t.freeLimit) ? t.freeLimit : o.freeLimit)
  const freeTake = (name, who, cap) => freeLimit.takeSaved(freeFile, name, who ?? '', cap)
  const isFree = (t) => t.free === true || o.free.includes(t.name)
  const ownPrice = (t) => t.price !== undefined || t.unit !== undefined
  const time = o.time
  const meter = engine.meter
  const onTime = (p) => (p !== null && time && p.unitMicro === null ? { ...p, rateMicro: time.rateMicro, rateMs: time.rateMs } : p)
  const basePrice = (t, args) => {
    if (ownPrice(t)) return priceOf({ price: t.price, unit: t.unit }, o.priceMicroUSD)
    if (typeof o.prices === 'function') return priceOf(o.prices(t.name, args), o.priceMicroUSD)
    return priceOf(o.prices?.[t.name], o.priceMicroUSD)
  }
  const priceFor = (t, args = {}) => {
    if (t.builtin === 'buy_time') { const ms = boughtMs(time, args); return { micro: timeMicro(time, ms), unitMicro: null, ms } }
    return t.meter === 'time' ? onTime(basePrice(t, args)) : basePrice(t, args)
  }
  const asked = (t, args) => (t.builtin === 'buy_time' && kind(args) === 'object' && !Object.hasOwn(args, 'ms') && Number.isSafeInteger(args.blocks) && args.blocks >= 1 ? { ...args, ms: args.blocks * time.unitMs } : args)
  const lineVaries = () => ({ per: 'time', usd: usd(time.rateMicro), ms: time.rateMs, varies: true })
  const priceTag = (t) => {
    if (t.builtin === 'line') return { usd: '0', per: 'call', free: true }
    if (t.builtin === 'buy_time') return { usd: usd(time.rateMicro), per: 'ms', ms: time.rateMs, ...(time.maxMs ? { maxMs: time.maxMs } : {}) }
    if (t.meter === 'time') {
      if (typeof o.prices === 'function' && !ownPrice(t)) return lineVaries()
      const p = priceFor(t)
      return { per: 'time', usd: usd(time.rateMicro), ms: time.rateMs, callUSD: usd(p.micro), callMs: meter.callMs(p.micro) }
    }
    if (isFree(t)) return describePrice(null, { free: true, perHour: freeCap(t) })
    if (engine.mode === 'gate') return { usd: '0', per: 'call' }
    if (!ownPrice(t) && typeof o.prices === 'function') return describePrice(null, { varies: true })
    return describePrice(priceFor(t))
  }
  const tagged = (list) => Object.fromEntries(list.map((t) => [t.name, priceTag(t)]))
  const listing = (base = '', called = null, all = null) => (engine.mode === 'gate' ? {} : { ...(priceList === 'all' ? { prices: all ?? tagged([...tools.values()]) } : { prices: tagged([tools.get(called)].filter(Boolean)), priceList: { mcp: `${base}/mcp`, openapi: `${base}/openapi.json`, how: PRICE_LIST_HOW } }), ...(time ? { time: timeText(time, base) } : {}) })
  const publicUrl = (url) => { try { const u = new URL(url); return site ? new URL(u.pathname + u.search, site).toString() : u.toString() } catch { return undefined } }
  const first = (...values) => values.map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => v !== '') ?? ''
  const find = (name) => tools.get(name) ?? [...tools.values()].find((t) => Array.isArray(t.aliases) && t.aliases.includes(name))
  const lineOf = (request) => {
    const h = request?.headers
    const header = typeof h?.get === 'function' ? h.get('x-line') : [].concat(h?.['x-line'] ?? [])[0]
    const asked = lineQuery === null ? '' : String(request?.url ?? '').split('#')[0].split('?').slice(1).join('?')
    return first(header, asked === '' ? '' : new URLSearchParams(asked).get(lineQuery) ?? '')
  }
  engine.start()

  const stopping = new AbortController()
  const flights = new Map()
  let closed = false
  const quit = (hangup) => (hangup?.aborted ? hangup : stopping.signal.aborted ? stopping.signal : null)
  const fly = (work, endable = true) => {
    const p = work()
    flights.set(p, endable)
    const land = () => flights.delete(p)
    p.then(land, land)
    return p
  }
  const shut = () => ({ status: 503, headers: {}, body: { error: 'restarting', message: 'this seller is restarting, so the call was not started. Nothing was charged. Call again.' } })

  async function drain({ wait = 0 } = {}) {
    closed = true
    const open = [...flights.keys()]
    if (wait > 0 && open.length) {
      let cancel = () => {}
      await Promise.race([Promise.allSettled(open), new Promise((ok) => { cancel = countdown(wait, ok) })])
      cancel()
    }
    const running = [...flights]
    if (!stopping.signal.aborted) stopping.abort(Object.assign(new Error('this seller is restarting, so the call was stopped. Call again.'), { code: 'restarting', status: 503 }))
    const ended = running.filter(([, endable]) => endable).map(([p]) => p)
    await Promise.allSettled(ended)
    return { finished: open.length - running.length, ended: ended.length, left: running.length - ended.length }
  }

  const quotes = (r) => r.status === 402 && kind(r.body) === 'object' && Array.isArray(r.body.accepts) && !Object.hasOwn(r.body, 'error') && !Object.hasOwn(r.body, 'type')

  async function unpaid(r, tool, base, via, args) {
    if (!options.unpaid || !quotes(r)) return r
    let more
    try { more = await options.unpaid({ tool, base, via, body: r.body, args: kind(args) === 'object' ? args : null }) } catch { return r }
    if (kind(more) !== 'object') return r
    const fields = kind(more.fields) === 'object' && serialize(more.fields) !== null ? more.fields : {}
    const added = Object.fromEntries(Object.entries(fields).filter(([k]) => !Object.hasOwn(r.body, k)))
    const terms = decodeHeader(r.headers['PAYMENT-REQUIRED'])
    const headers = kind(terms) === 'object' && Object.keys(added).length ? { ...r.headers, 'PAYMENT-REQUIRED': Json.base64(forHeader({ ...added, ...terms })) } : r.headers
    return { ...r, headers, body: { ...added, ...r.body }, ...(typeof more.text === 'string' && more.text !== '' ? { text: more.text } : {}) }
  }

  async function check({ path = '/', header, resource, tool: described, refundUrl = null, price = null, base = null, shared = null, paymentOnly = false, args = null }) {
    const payment = first(header('payment-signature'), header('x-payment'))
    const grant = first(header('x-grant'))
    const offered = first(header('payment-authorization'), header('authorization'))
    const credential = Credential.is(offered) ? offered : ''
    const tool = described ?? { name: path }
    const via = String(path).startsWith('mcp:') ? 'mcp' : 'http'
    const extensions = bazaar(tool, via)
    const at = baseOf(refundUrl, base)
    const r = await engine.check({ tool: { name: tool.name, description: brief(tool) }, resource, payment, grant, credential, refundUrl, price, listing: listing(at, tool.name, shared?.prices ?? null), extensions, shared, paymentOnly })
    return r.ok ? { ok: true, ticket: r.ticket, status: 200, headers: {}, body: {} } : unpaid({ ok: false, status: r.status, headers: r.headers ?? {}, body: r.body }, tool.name, at, via, args)
  }

  function done(ticket, ok, used = {}) {
    return engine.done(ticket, ok, used)
  }

  async function paymentOnly(t, header, path, resource, refundUrl, flagged) {
    if (!engine.sessions || isFree(t) || t.builtin === 'line') return null
    const sent = first(header('payment-authorization'), header('authorization'))
    if (first(header('payment-signature'), header('x-payment')) || !Credential.is(sent) || !Sessions.paymentOnly(sent, flagged === true)) return null
    let price = null
    try { price = priceFor(t, {}) } catch { price = null }
    const c = await check({ path, header, resource, tool: offer(t), refundUrl, price, paymentOnly: true })
    return c.ok ? null : c
  }

  function usage() {
    const m = { units: null, cut: null }
    m.ctx = {
      units(n) {
        if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('bridge: units is a whole number, 0 or more')
        m.units = n
      },
      ifCut(fields) {
        if (fields !== null && kind(fields) !== 'object') throw new TypeError('bridge: ifCut takes an object of fields, or null')
        m.cut = fields
      },
    }
    return m
  }

  const gate = (req, exec, isFailure = () => false, hangup) => (closed ? Promise.resolve({ refused: shut() }) : fly(() => sold(req, exec, isFailure, hangup), hangup !== undefined))

  async function sold(req, exec, isFailure, hangup) {
    const c = await check(req)
    if (!c.ok) return { refused: c }
    const m = usage()
    let value
    let threw = false
    let error
    try { value = await exec({ ...m.ctx, channelId: c.ticket?.hold?.channelId ?? null }) } catch (e) { threw = true; error = e }
    const had = m.cut
    const left = hangup === undefined ? null : quit(hangup)
    if (left) { threw = true; error = gone(left) }
    const failed = threw || isFailure(value)
    const buying = !failed && time && c.ticket?.hold && req.tool?.name === 'buy_time' && tools.get('buy_time')?.builtin === 'buy_time'
    const bought = buying ? { channelId: c.ticket.hold.channelId, ms: boughtMs(time, req.args), key: c.ticket.hold.pendingId } : null
    if (bought) c.ticket.hold.owedMs = bought.ms
    const d = await done(c.ticket, !failed, { units: m.units })
    if (bought && d.ok) {
      await meter.credit(bought.channelId, bought.ms, bought.key).catch(() => null)
      const now = await meter.status(bought.channelId).catch(() => null)
      if (now !== null && kind(value?.value) === 'object' && Object.hasOwn(value.value, 'msRemaining')) {
        const stated = { ...value.value, msRemaining: now.msRemaining }
        value = { ...value, value: stated, body: serialize(stated) }
      }
    }
    return { value, threw, error, failed, settlement: d, cut: had }
  }

  const within = (ms, run, { hangup = null, more = null } = {}) => {
    const aborter = new AbortController()
    let over = false
    let cancel = () => {}
    let unhook = () => {}
    const stopped = new Promise((_, fail) => {
      const stop = (e) => { aborter.abort(e); fail(e) }
      const late = async () => {
        const next = more ? await more() : 0
        if (over) return
        if (next > 0) { cancel = countdown(next, late); return }
        stop(Object.assign(new Error(`the call ran past its ${ms} ms`), { code: 'out_of_time' }))
      }
      const hung = () => stop(gone(quit(hangup)))
      if (quit(hangup)) return hung()
      hangup?.addEventListener('abort', hung, { once: true })
      stopping.signal.addEventListener('abort', hung, { once: true })
      unhook = () => { hangup?.removeEventListener('abort', hung); stopping.signal.removeEventListener('abort', hung) }
      if (ms !== null) cancel = countdown(ms, late)
    })
    stopped.catch(() => {})
    return Promise.race([run(aborter.signal), stopped]).finally(() => { over = true; cancel(); unhook() })
  }

  const whenCut = (fields, body) => {
    if (kind(fields) !== 'object' || serialize(fields) === null) return body
    const kept = Object.fromEntries(Object.entries(fields).filter(([k, v]) => !CUT_OURS.includes(k) && v !== undefined))
    return { ...kept, ...body }
  }

  const outOfTime = (onLine, ms) => ({ error: 'out_of_time', message: onLine ? 'the line ran out of time during the call. Its time is spent. Buy time: buy_time.' : `the call needs more than the ${ms} ms its price buys, so it was cut. Nothing was charged. Buy time and call on a line.` })

  const baseOf = (refundUrl = null, base = null) => (base !== null && base !== undefined ? String(base).replace(/\/+$/, '') : String(refundUrl ?? o.refundUrl ?? '').replace(/\/refund$/, ''))

  const onLine = (t, args, credential, hangup = null, work = (ctx) => perform(t, args, ctx), at = baseOf()) => (closed ? Promise.resolve(shut()) : fly(() => ridden(t, work, credential, hangup, at)))

  async function known(credential, then = null) {
    const channelId = await meter.line(credential)
    if (!channelId) return { status: 403, body: { error: 'line_unknown', message: 'no open line with that credential. Open one: POST {"op":"open","channelId":"0x…"} to this seller\'s line route, the address its 402 time line names.' } }
    const channels = engine.server.channels
    const k = await channels.untilAnswered(channelId, engine.cfg.nowMs() + channels.judgeWaitMs(), async (g, ch) => {
      if (!ch) return { status: 403, body: { error: 'line_unknown', message: 'no channel for this line.' } }
      if (Number(ch.withdrawRequestedAt ?? 0) > 0) return { status: 402, body: { error: 'channel_leaving', message: 'this channel is withdrawing. Open a new channel.' } }
      return { status: 200, channelId, then: then === null ? null : await then(channelId) }
    })
    if (k.settling !== undefined) return { status: 402, body: { error: 'refund_settling', message: `a refund is settling on this channel, retry in ${k.settling}s.`, retry_after_seconds: k.settling } }
    return k
  }

  async function seat(credential, hangup, at = baseOf()) {
    const id = randomBytes(8).toString('hex')
    const k = await known(credential, (channelId) => (hangup?.aborted ? null : meter.begin(channelId, id)))
    if (k.status !== 200) return { refused: k }
    const channelId = k.channelId
    if (k.then === null) return { refused: hungUp(gone(hangup), true) }
    const b = k.then
    if (!b.ok) {
      const msRemaining = (await meter.status(channelId)).msRemaining
      if (b.code === 'too_many_calls') return { refused: { status: 429, body: { error: 'too_many_calls', message: 'too many calls are live on this line; wait for one to finish, then retry.', msRemaining } } }
      return { refused: { status: 402, body: { error: b.code, message: b.code === 'meter_off' ? `the meter is off. Switch it on: POST ${at}/line {"op":"on","credential":"<yours>"}.` : 'this line has no time left. Buy time: buy_time.', msRemaining } } }
    }
    let deadline = b.deadline
    let renewed = false
    let ended = false
    let order = Promise.resolve()
    const renew = () => (order = order.then(async () => {
      if (ended) return deadline
      const r = await meter.renew(channelId, id, deadline).catch(() => null)
      if (r?.ok && r.deadline > deadline) { deadline = r.deadline; renewed = true }
      return deadline
    }))
    let armed = b.deadline
    const more = async () => {
      if (!((await renew()) > armed)) return 0
      armed = deadline
      return deadline - meter.now()
    }
    const leave = async (cut) => {
      const stoppedAt = meter.now()
      if (!cut) meter.stopped(channelId, id, stoppedAt)
      ended = true
      await order
      const e = cut ? await meter.end(channelId, id) : await meter.end(channelId, id, b.started, stoppedAt)
      return { msRemaining: e.msRemaining, elapsedMs: renewed && !cut ? stoppedAt - b.started : e.elapsedMs, over: e.over }
    }
    return { channelId, first: b.deadline, renew, more, leave, get deadline() { return deadline } }
  }

  async function ridden(t, work, credential, hangup, at) {
    const s = await seat(credential, hangup, at)
    if (s.refused) return s.refused
    let value
    let error = null
    const m = usage()
    try {
      value = await within(s.first - meter.now(), (signal) => work({ ...m.ctx, signal, channelId: s.channelId, renew: s.renew, get deadline() { return s.deadline } }), { hangup, more: s.more })
    } catch (e) { error = e }
    const had = m.cut
    const cut = error?.code === 'out_of_time'
    const e = await s.leave(cut)
    const meta = { channelId: s.channelId, msRemaining: e.msRemaining, elapsedMs: e.elapsedMs }
    const hung = error !== null && quit(hangup)
    if (cut || (e.over && !hung)) return { status: 402, body: whenCut(had, { ...outOfTime(true), msRemaining: e.msRemaining }) }
    if (hung) { const h = hungUp(gone(quit(hangup)), true, { msRemaining: e.msRemaining, elapsedMs: e.elapsedMs }); return { status: h.status, body: whenCut(had, h.body), meta } }
    if (error !== null) return { status: 500, body: { error: 'tool_failed', tool: t.name, message: message(error) }, meta }
    if (value.isError) {
      const f = failedHttp(value.value, t.name)
      return { status: f.status, failedValue: value.value, body: f.body, headers: f.headers, meta }
    }
    return { status: 200, value, meta }
  }

  async function line(credential) {
    if (!time) throw new Error('bridge: a line needs the seller\'s time option')
    const k = await known(credential)
    return k.status === 200 ? { ok: true, ...(await meter.status(k.channelId)) } : { ok: false, status: k.status, body: k.body }
  }

  async function ride(credential, { signal = null } = {}) {
    if (!time) throw new Error('bridge: a ride burns line time; it needs the seller\'s time option')
    if (closed) { const no = shut(); return { ok: false, status: no.status, body: no.body } }
    let land = () => {}
    fly(() => new Promise((ok) => { land = ok }))
    let s
    try { s = await seat(credential, signal) } catch (e) { land(); throw e }
    if (s.refused) { land(); return { ok: false, status: s.refused.status, body: s.refused.body } }
    const cutter = new AbortController()
    const heard = []
    let cancel = () => {}
    let told = null
    let over = null
    const hung = () => { finish(false, null).catch(() => {}) }
    const stop = () => { finish(false, quit(null)).catch(() => {}) }
    const finish = (cut, why) => (over ??= (async () => {
      cancel()
      signal?.removeEventListener('abort', hung)
      stopping.signal.removeEventListener('abort', stop)
      let e
      try { e = await s.leave(cut) } finally { land() }
      if (cut) told = { ...outOfTime(true), msRemaining: e.msRemaining }
      else if (why) told = hungUp(gone(why), true, { msRemaining: e.msRemaining, elapsedMs: e.elapsedMs }).body
      if (told) {
        cutter.abort(Object.assign(new Error(told.message), { code: told.error }))
        for (const fn of heard.splice(0)) { try { fn(told) } catch {} }
      }
      return { msRemaining: e.msRemaining, elapsedMs: e.elapsedMs }
    })())
    const late = async () => {
      const next = await s.more()
      if (over) return
      if (next > 0) { cancel = countdown(next, late); return }
      finish(true, null).catch(() => {})
    }
    cancel = countdown(s.first - meter.now(), late)
    signal?.addEventListener('abort', hung, { once: true })
    stopping.signal.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) hung()
    else if (stopping.signal.aborted) stop()
    return {
      ok: true,
      channelId: s.channelId,
      signal: cutter.signal,
      get deadline() { return s.deadline },
      msRemaining: async () => (await meter.status(s.channelId)).msRemaining,
      renew: () => s.renew(),
      end: () => finish(false, null),
      onCut(fn) {
        if (typeof fn !== 'function') throw new TypeError('bridge: onCut takes a function')
        if (told) { try { fn(told) } catch {} } else if (!over) heard.push(fn)
      },
    }
  }

  async function lineOp(args, headerCredential = '') {
    const fail = (status, code, why) => ({ status, body: { op: 'line_failed', code, why } })
    if (!time) return fail(404, 'no_time', 'this seller sells no line time')
    if (kind(args) !== 'object' || !LINE_OPS.includes(args.op)) return fail(400, 'bad_request', 'op is open, prove, on, off, status or close')
    if (args.op === 'open' || args.op === 'prove') {
      const id = typeof args.channelId === 'string' && CHANNEL.test(args.channelId) ? args.channelId.toLowerCase() : null
      if (!id) return fail(400, 'bad_request', 'channelId is missing or is not 0x and 64 hex characters: send "channelId":"0x…" with the op')
      const ch = id ? await engine.store.get(id) : null
      if (!ch?.channelConfig) return fail(404, 'unknown_channel', 'no channel with that id here. Pay a call on it first, e.g. buy_time.')
      if (Number(ch.withdrawRequestedAt ?? 0) > 0) return fail(409, 'channel_leaving', 'this channel is withdrawing. Open a new channel.')
      if (args.op === 'open') {
        const c = await meter.challenge(id)
        return { status: 200, body: { op: 'challenge', channelId: id, nonce: c.nonce, sign: c.message, expiresInSeconds: c.expiresInSeconds } }
      }
      const escrow = engine.escrows.find(ch)
      if (escrow === null) return fail(409, 'unknown_escrow', "this channel's record names an escrow this seller does not serve.")
      const channels = engine.server.channels
      const deadline = engine.cfg.nowMs() + channels.judgeWaitMs()
      let r
      try {
        r = await meter.prove(ch, args.nonce, args.signature, escrow.owners(ch.channelConfig), async (attach) => {
          const out = await channels.untilAnswered(id, deadline, (g, rec, now, asked) => attach(asked ? { judged: Channels.retrySecs(engine.cfg, 0) } : null))
          return out.settling !== undefined ? channels.serial(id, () => attach({ settling: out.settling })) : out
        })
      } catch {
        return { status: 503, body: { op: 'line_failed', code: 'line_unavailable', why: 'the line could not be read right now. Retry.' } }
      }
      if (r.refused?.settling !== undefined) return { status: 402, body: { op: 'line_failed', code: 'refund_settling', why: `a refund is settling on this channel, and a first line would switch its meter on. Nothing was opened: send {"op":"open"} again in ${r.refused.settling}s.`, retry_after_seconds: r.refused.settling } }
      if (r.refused?.judged !== undefined) return { status: 402, body: { op: 'line_failed', code: 'refund_pending', why: `a refund asked for on this channel is being worked out, and the meter stays off until it is answered. Nothing was opened: send {"op":"open"} again in ${r.refused.judged}s.`, retry_after_seconds: r.refused.judged } }
      if (!r.ok) return fail(r.status, r.code, r.why)
      return { status: 200, body: { op: 'opened', credential: r.credential, channelId: id, msRemaining: r.msRemaining, metering: r.metering } }
    }
    const credential = typeof args.credential === 'string' && args.credential !== '' ? args.credential : headerCredential
    if (!credential) return fail(400, 'bad_request', 'credential is missing or is not a string: add "credential":"<yours>" to the body, or send it as the x-line header')
    const id = await meter.line(credential)
    if (!id) return fail(403, 'line_unknown', 'no open line with that credential')
    const channels = engine.server.channels
    if (args.op === 'close') {
      await channels.serial(id, () => meter.close(credential))
      return { status: 200, body: { op: 'closed', channelId: id } }
    }
    if (args.op === 'on') {
      let on
      try {
        on = await channels.untilAnswered(id, engine.cfg.nowMs() + channels.judgeWaitMs(), async (g, ch, now, asked) => {
          if (asked) return { judged: Channels.retrySecs(engine.cfg, 0) }
          await meter.switch(id, true)
          return {}
        })
      } catch {
        return { status: 503, body: { op: 'line_failed', code: 'line_unavailable', why: 'the line could not be read right now. Retry.' } }
      }
      if (on.settling !== undefined) return { status: 402, body: { op: 'line_failed', code: 'refund_settling', why: `a refund is settling on this channel, retry in ${on.settling}s.`, retry_after_seconds: on.settling } }
      if (on.judged !== undefined) return { status: 402, body: { op: 'line_failed', code: 'refund_pending', why: `a refund asked for on this channel is being worked out, and the meter stays off until it is answered. Retry in ${on.judged}s.`, retry_after_seconds: on.judged } }
    } else if (args.op !== 'status') await channels.serial(id, () => meter.switch(id, false))
    return { status: 200, body: { op: args.op, ...(await meter.status(id)) } }
  }

  async function served(t, args, info = {}) {
    const take = t.builtin || t.freeLimit === false ? { ok: true } : await freeTake(t.name, info.ip, o.freeLimit)
    if (!take.ok) return { limited: FreeLimit.refusal(o.freeLimit, take.retryAfter), retryAfter: take.retryAfter }
    try { return { value: await perform(t, args, { ...usage().ctx, line: info.line ?? '' }) } } catch (e) { return { threw: true, error: e } }
  }

  function tool(def) {
    if (!def?.name || typeof def.run !== 'function') throw new Error('bridge: a tool is { name, description, inputSchema, run(args) }')
    const t = { description: '', inputSchema: { type: 'object' }, ...def }
    if (tools.get(t.name)?.builtin) throw new Error(`bridge: ${t.name} is a built-in tool`)
    delete t.builtin
    if (t.meter !== undefined && t.meter !== 'time') throw new Error('bridge: meter is "time"')
    if (t.refuses !== undefined && typeof t.refuses !== 'function') throw new Error('bridge: refuses is a function of the arguments')
    wellDescribed(t, ['listedOutputSchema', '_meta'])
    if (t.freeLimit !== undefined && t.freeLimit !== false) throw new Error('bridge: a tool\'s freeLimit is false, for a free tool the seller\'s freeLimit does not count')
    if (t.meter === 'time' && (!time || isFree(t))) throw new Error(`bridge: ${t.name} meters time; set the seller's time option, and do not make it free`)
    if (!isFree(t) && engine.mode !== 'gate' && (ownPrice(t) || typeof o.prices !== 'function')) priceFor(t)
    toolRoll.add(t.name)
    tools.set(def.name, t)
    return api
  }

  function wellDescribed(t, objects) {
    for (const k of ['title', 'summary', ...(objects.includes('description') ? ['description'] : [])]) if (t[k] !== undefined && typeof t[k] !== 'string') throw new Error(`bridge: a tool's ${k} is a string`)
    for (const k of objects) if (k !== 'description' && t[k] !== undefined && kind(t[k]) !== 'object') throw new Error(`bridge: a tool's ${k} is an object`)
    if (t.aliases !== undefined && !(Array.isArray(t.aliases) && t.aliases.every((a) => typeof a === 'string' && a !== ''))) throw new Error('bridge: a tool\'s aliases is a list of names')
  }

  function describe(name, fields) {
    const t = tools.get(name)
    if (!t) throw new Error(`bridge: no tool named ${name}`)
    if (kind(fields) !== 'object') throw new Error(`bridge: describe takes { ${DESCRIBED.join(', ')} }`)
    const other = Object.keys(fields).find((k) => !DESCRIBED.includes(k))
    if (other !== undefined) throw new Error(`bridge: describe sets ${DESCRIBED.join(', ')}; ${other} is set by tool()`)
    wellDescribed(fields, ['description', 'annotations', 'outputSchema', 'listedOutputSchema', '_meta'])
    const { arguments: said, ...rest } = fields
    const next = { ...t, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) }
    if (said !== undefined) next.inputSchema = reworded(t, said)
    tools.set(name, next)
    return api
  }

  function reworded(t, said) {
    if (kind(said) !== 'object' || !Object.values(said).every((d) => typeof d === 'string' && d.trim() !== '')) throw new Error('bridge: describe\'s arguments is { <argument>: \'<description>\' }')
    const properties = kind(t.inputSchema?.properties) === 'object' ? t.inputSchema.properties : {}
    const other = Object.keys(said).find((k) => !Object.hasOwn(properties, k) || kind(properties[k]) !== 'object')
    if (other !== undefined) throw new Error(`bridge: ${t.name} has no argument named ${other}`)
    return { ...t.inputSchema, properties: Object.fromEntries(Object.entries(properties).map(([k, p]) => [k, Object.hasOwn(said, k) ? { ...p, description: said[k] } : p])) }
  }

  function untool(name) {
    if (tools.get(name)?.builtin) throw new Error(`bridge: ${name} is a built-in tool`)
    toolRoll.drop(name)
    return tools.delete(name)
  }

  function server(meta) {
    if (kind(meta) !== 'object') throw new Error('bridge: server is { title, description, websiteUrl, icons, instructions }')
    for (const k of ['title', 'description', 'websiteUrl']) if (meta[k] !== undefined && typeof meta[k] !== 'string') throw new Error(`bridge: server ${k} is a string`)
    if (meta.icons !== undefined && !(Array.isArray(meta.icons) && meta.icons.every((i) => kind(i) === 'object' && typeof i.src === 'string'))) throw new Error('bridge: server icons is a list of { src, mimeType, sizes }')
    if (meta.instructions !== undefined && !['string', 'function'].includes(typeof meta.instructions)) throw new Error('bridge: server instructions is a string, or a function that returns one')
    for (const k of ['title', 'description', 'websiteUrl', 'icons', 'instructions']) if (meta[k] !== undefined) about[k] = meta[k]
    return api
  }

  function resource(def) {
    if (typeof def?.uri !== 'string' || def.uri === '' || typeof def.name !== 'string' || def.name === '' || typeof def.read !== 'function') throw new Error('bridge: a resource is { uri, name, title, description, mimeType, read() }')
    resourceRoll.add(def.uri)
    resources.set(def.uri, def)
    return api
  }

  const serverInfo = () => ({ name: serverName, ...(about.title ? { title: about.title } : {}), version, ...(about.description ? { description: about.description } : {}), ...(about.websiteUrl ? { websiteUrl: about.websiteUrl } : {}), ...(about.icons?.length ? { icons: about.icons } : {}) })
  async function mppIntents() {
    if (!engine.server || engine.mode === 'gate') return []
    let top = null
    let unknown = false
    for (const t of tools.values()) {
      if (isFree(t) || t.builtin) continue
      if (!ownPrice(t) && typeof o.prices === 'function') {
        unknown = true
        continue
      }
      let p = null
      try { p = priceFor(t, {}) } catch { p = null }
      if (p === null || !engine.server.constructor.mppOffered(p)) continue
      if (top === null || p.micro > top) top = p.micro
    }
    if (top === null && !unknown) return []
    let charge = unknown && engine.server.mppAsset() !== null
    if (!charge && top !== null) {
      try { charge = (await engine.server.mppQuote(top)) !== null } catch { charge = false }
    }
    return [...(charge ? [EvmCharge.INTENT] : []), ...(engine.sessions ? [Sessions.INTENT] : [])]
  }
  const capabilities = async (payment = false) => {
    const intents = payment ? await mppIntents() : []
    return { tools: {}, ...(resources.size ? { resources: {} } : {}), ...(intents.length ? { experimental: { payment: McpPayment.capability(intents) } } : {}) }
  }
  const greeting = () => {
    const text = typeof about.instructions === 'function' ? about.instructions() : about.instructions
    return typeof text === 'string' && text !== '' ? { instructions: text } : {}
  }
  const mcpVersions = () => [...MODERN_VERSIONS, ...MCP_VERSIONS]
  const mcpMethods = () => ['server/discover', 'tools/list', 'tools/call', ...(resources.size ? ['resources/list', 'resources/templates/list', 'resources/read'] : [])]

  const takesLine = (t) => lineArgument !== null && t?.meter === 'time' && !Object.hasOwn(kind(t.inputSchema?.properties) === 'object' ? t.inputSchema.properties : {}, lineArgument)
  const lineListed = (d) => (takesLine(tools.get(d.name)) ? { ...d, inputSchema: { ...d.inputSchema, properties: { ...(kind(d.inputSchema?.properties) === 'object' ? d.inputSchema.properties : {}), [lineArgument]: { type: 'string', description: `Optional. A line credential, for a client that cannot send the x-line header or _meta["${META_LINE}"]: the call runs on that line's time.` } } } } : d)
  const lineCalled = (p, header) => {
    if (!takesLine(find(p.name)) || kind(p.arguments) !== 'object' || !Object.hasOwn(p.arguments, lineArgument)) return p
    const { [lineArgument]: given, ...rest } = p.arguments
    const carried = first(typeof p._meta?.[META_LINE] === 'string' ? p._meta[META_LINE] : '', header)
    return { ...p, arguments: rest, ...(carried === '' && typeof given === 'string' && given !== '' ? { _meta: { ...(p._meta ?? {}), [META_LINE]: given } } : {}) }
  }

  async function mcpRead(params, base) {
    const def = resources.get(params.uri)
    const out = await def.read({ uri: def.uri, base })
    const one = typeof out === 'string' ? { text: out } : out
    if (kind(one) !== 'object' || (typeof one.text !== 'string' && typeof one.blob !== 'string')) throw new Error(`the resource ${def.uri} returned neither text nor a blob`)
    const type = typeof one.mimeType === 'string' ? one.mimeType : def.mimeType
    return { contents: [{ uri: def.uri, ...(typeof type === 'string' ? { mimeType: type } : {}), ...(typeof one.text === 'string' ? { text: one.text } : { blob: one.blob }) }] }
  }

  const entry = (t) => ({ name: t.name, ...(typeof t.title === 'string' && t.title !== '' ? { title: t.title } : {}), description: t.description, inputSchema: t.inputSchema, _meta: { ...(kind(t._meta) === 'object' ? t._meta : {}), [META_PRICE]: priceTag(t) } })
  const offer = (t) => ({ ...entry(t), ...(typeof t.summary === 'string' ? { summary: t.summary } : {}), ...(kind(t.outputSchema) === 'object' ? { outputSchema: t.outputSchema } : {}) })
  const listedSchema = (t) => (kind(t.listedOutputSchema) === 'object' ? t.listedOutputSchema : t.outputSchema)
  const returns = ({ $schema, $defs, definitions, ...own }) => ({ ...($schema !== undefined ? { $schema } : {}), ...($defs !== undefined ? { $defs } : {}), ...(definitions !== undefined ? { definitions } : {}), type: 'object', anyOf: [own, ...REFUSALS, ...(engine.sessions ? [PAYMENT_ONLY_RESULT] : [])] })
  const shown = (t) => ({ ...entry(t), ...(kind(listedSchema(t)) === 'object' && listedSchema(t).type === 'object' ? { outputSchema: returns(listedSchema(t)) } : {}), ...(kind(t.annotations) === 'object' ? { annotations: t.annotations } : {}) })
  const listTools = () => [...tools.values()].map(shown)
  const toolNames = () => [...tools.keys()]
  const prices = () => {
    const out = tagged([...tools.values()])
    for (const [name, spec] of wrapped) {
      if (Object.hasOwn(out, name)) continue
      try { out[name] = routeTag(spec) } catch {}
    }
    return out
  }

  async function perform(t, args, ctx) {
    const value = await t.run(args, ctx)
    if (kind(value) === 'object' && value.isError === true) return { value, isError: true }
    const body = serialize(value)
    if (body === null) throw new Error(RESULT_NOT_JSON)
    return { value, body }
  }

  const declined = async (t, args) => {
    if (typeof t.refuses !== 'function') return null
    let why
    try { why = await t.refuses(args) } catch { return null }
    return typeof why === 'string' && why.trim() !== '' ? why : null
  }

  const probe = (t, args, payment, credential) => payment === '' && kind(args) === 'object' && Object.keys(args).length === 0 && !t.builtin && !isFree(t) && !(t.meter === 'time' && credential)

  async function terms(t, path, header, resource, refundUrl, shared = null, args = null) {
    let price
    try { price = engine.mode === 'gate' ? null : priceFor(t, {}) } catch { return null }
    const q = await check({ path, header, resource, tool: offer(t), refundUrl, price, shared, args })
    return q.ok ? null : q
  }

  const listed = (v) => String(v).split(',').map((h) => h.trim()).filter(Boolean)
  const takesMpp = () => engine.mode !== 'gate' && Boolean(engine.server?.mppAsset())

  function facts() {
    const c = engine.cfg
    return {
      name: o.name,
      mode: engine.mode,
      protocols: ['x402', ...(takesMpp() ? ['mpp'] : [])],
      headers: { request: listed(PREFLIGHT['access-control-allow-headers']), response: listed(CORS['access-control-expose-headers']) },
      payout: o.payout,
      feeRecipient: o.feeRecipient,
      relay: o.relay,
      network: c?.network ?? null,
      chainId: c?.chainId ?? null,
      asset: c?.assets?.[0]?.address ?? null,
      receiver: c?.receiver ?? null,
      escrow: CONTRACTS.escrow,
      collectors: { ...CONTRACTS.collectors },
      permit2: CONTRACTS.permit2,
      split: c?.split ?? null,
      feeShare: c?.feeShare ?? null,
      withdrawDelay: c?.withdrawDelay ?? null,
      settle: engine.keys.settle?.address ?? null,
    }
  }

  const ledger = new Books(engine.chain, new StateFile(o.stateDir, 'books.json'), engine.escrows.default)

  async function books({ receivers, token, fromBlock, pageBlocks } = {}) {
    const own = engine.cfg?.receiver ?? null
    const listed = receivers === undefined ? (own === null ? [] : [own]) : receivers
    if (!Array.isArray(listed)) throw new TypeError('bridge: books receivers is a list of addresses, or of { address, role }')
    const rows = listed.map((r) => {
      const address = kind(r) === 'object' ? r.address : r
      if (!Address.isAddress(address)) throw new TypeError('bridge: books receivers is a list of addresses, or of { address, role }')
      return { address, role: kind(r) === 'object' && typeof r.role === 'string' ? r.role : own !== null && Address.equals(address, own) ? 'split' : 'receiver' }
    })
    const asset = token ?? engine.cfg?.assets?.[0]?.address ?? Erc20.USDC_BASE
    if (!Address.isAddress(asset)) throw new TypeError('bridge: books token is a token address')
    return ledger.read(rows, asset, { ...(fromBlock === undefined ? {} : { fromBlock }), ...(pageBlocks === undefined ? {} : { pageBlocks }) })
  }

  async function gas({ wallets = [], gasUnitsPerTransaction, targetTransactions, lowBelowTransactions } = {}) {
    if (!Array.isArray(wallets) || !wallets.every((w) => kind(w) === 'object' && typeof w.name === 'string' && w.name !== '' && Address.isAddress(w.address))) throw new TypeError('bridge: gas wallets is a list of { name, address }')
    const table = engine.cfg?.gas ?? Config.GAS
    const named = wallets.map((w) => ({ name: w.name, address: Address.checksum(w.address) }))
    const settle = engine.keys.settle?.address
    const watched = [...named, ...(settle && !named.some((w) => Address.equals(w.address, settle)) ? [{ name: 'settle', address: Address.checksum(settle) }] : [])]
    const out = await gasOf(engine.chain, watched, { gasUnitsPerTransaction: gasUnitsPerTransaction ?? table.claimBase + table.claimEntry + table.payout, ...(targetTransactions === undefined ? {} : { targetTransactions }), ...(lowBelowTransactions === undefined ? {} : { lowBelowTransactions }) }, o.clock ? Number(o.clock()) : Date.now())
    if (engine.mode !== 'gate' || !engine.keys.credit) return out
    const nextPurchaseMicro = Credits.priceMicro(engine.gate.meter.creditBlock(), engine.gate.credits.maxMicroPerThousand)
    const credit = { address: Address.checksum(engine.keys.credit.address), nextPurchaseMicro }
    try {
      credit.usdcMicro = Number(await engine.chain.balanceOf(Erc20.USDC_BASE, engine.keys.credit.address))
      credit.covers = credit.usdcMicro >= nextPurchaseMicro
    } catch {
      credit.error = 'could not read its balance'
      credit.covers = false
    }
    return { ...out, ok: out.ok && credit.covers, credit }
  }

  const challengeIn = (header) => {
    const c = Challenge.parse(header)[0]
    if (!c) return null
    let request = {}
    try { request = Base64Url.parse(c.request) } catch {}
    return { method: c.method, intent: c.intent, currency: request?.currency ?? null, chainId: request?.methodDetails?.chainId ?? null, amount: request?.amount ?? null }
  }

  const offered = (q) => (!q || q.status !== 402 ? null : { x402: Array.isArray(q.body?.accepts) ? q.body.accepts : [], mpp: challengeIn(q.headers?.['WWW-Authenticate']), body: q.body, headers: q.headers })

  async function offerOf(t, root, shared = null) {
    if (!t || isFree(t) || t.builtin === 'line') return null
    return offered(await terms(t, `/v1/${t.name}`, () => '', publicUrl(`${root}/v1/${t.name}`), root ? publicUrl(`${root}/refund`) ?? null : null, shared))
  }

  async function offersOf(asked, root) {
    if (asked !== 'all' && !(Array.isArray(asked) && asked.every((n) => typeof n === 'string'))) throw new Error('bridge: offers({ tools }) is "all" or a list of tool names')
    const shared = engine.server ? { ...engine.server.sharing(), prices: priceList === 'all' && engine.mode !== 'gate' ? tagged([...tools.values()]) : null } : null
    const out = {}
    let since = performance.now()
    for (const name of asked === 'all' ? toolNames() : asked) {
      out[name] = await offerOf(find(name), root, shared)
      if (performance.now() - since < TURN_MS) continue
      await new Promise((ok) => setImmediate(ok))
      since = performance.now()
    }
    return out
  }

  async function offers(what, { base = '' } = {}) {
    const root = String(base).replace(/\/+$/, '')
    if (typeof what === 'string') return offerOf(find(what), root)
    if (kind(what) === 'object' && what.tools !== undefined) return offersOf(what.tools, root)
    const spec = kind(what) === 'object' ? what : {}
    if (spec.free === true) return null
    const path = typeof spec.path === 'string' ? spec.path : '/'
    const c = await check({ path, header: () => '', resource: root ? publicUrl(`${root}${path}`) : undefined, tool: kind(spec.tool) === 'object' ? { name: path, ...spec.tool } : undefined, refundUrl: root ? publicUrl(`${root}/refund`) ?? null : null, price: spec.meter === 'time' ? onTime(routePrice(spec.price, null)) : routePrice(spec.price, null) })
    return offered(c.ok ? null : c)
  }

  const unknownTool = (tool) => ({ error: 'unknown_tool', message: `no tool named ${tool} here; tools lists the ones there are`, tool, tools: toolNames() })

  async function http(request, called, refundUrl = null, info = {}) {
    const t = find(called)
    if (!t && called === 'line') {
      const l = await lineOp({})
      return json(l.status, l.body)
    }
    if (!t) return json(404, unknownTool(called))
    const toolName = t.name
    const only = closed ? null : await paymentOnly(t, (h) => request.headers.get(h), `/v1/${toolName}`, publicUrl(request.url), refundUrl, request.method === 'HEAD')
    if (only) return json(only.status, only.body, only.headers)
    const raw = await request.text()
    let args
    try { args = raw.trim() ? JSON.parse(raw) : {} } catch { return json(400, { error: 'invalid_arguments', tool: toolName, message: 'the body is not JSON' }) }
    const bad = validate(t.inputSchema, asked(t, args))
    const paying = first(request.headers.get('payment-signature'), request.headers.get('x-payment')) || (Credential.is(first(request.headers.get('payment-authorization'), request.headers.get('authorization'))) ? 'paid' : '')
    const probing = probe(t, args, paying, lineOf(request))
    if (bad && probing) {
      const q = await terms(t, `/v1/${toolName}`, (h) => request.headers.get(h), publicUrl(request.url), refundUrl, null, args)
      return q ? json(q.status, q.body, q.headers) : json(400, { error: 'invalid_arguments', tool: toolName, message: bad })
    }
    if (bad) return json(400, { error: 'invalid_arguments', tool: toolName, message: bad })
    const no = probing ? null : await declined(t, args)
    if (no) return json(400, { error: 'invalid_arguments', tool: toolName, message: no })
    if (t.builtin === 'line') {
      const l = await lineOp(args, lineOf(request))
      return json(l.status, l.body)
    }
    if (isFree(t)) {
      const f = await served(t, args, { ip: info.ip, line: lineOf(request) })
      if (f.limited) return json(429, f.limited, { 'retry-after': String(f.retryAfter) })
      if (f.threw) return json(500, { error: 'tool_failed', message: message(f.error), tool: toolName })
      if (f.value.isError) {
        const h = failedHttp(f.value.value, toolName)
        return json(h.status, h.body, h.headers)
      }
      return new Response(f.value.body, { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const credential = lineOf(request)
    const hangup = hangupOf(request, info)
    if (t.meter === 'time' && credential) {
      const l = await onLine(t, args, credential, hangup, undefined, baseOf(refundUrl))
      if (l.status !== 200) return json(l.status, told(l), { ...(l.headers ?? {}), ...(l.meta ? reading(l.meta) : {}) })
      return new Response(l.value.body, { status: 200, headers: { 'content-type': 'application/json', ...reading(l.meta) } })
    }
    let price
    try { price = engine.mode === 'gate' ? null : priceFor(t, args) } catch (e) { return json(500, { error: 'price_invalid', tool: toolName, message: message(e) }) }
    const bound = t.meter === 'time' ? meter.callMs(price.micro) : null
    const g = await gate({ path: `/v1/${toolName}`, header: (h) => request.headers.get(h), resource: publicUrl(request.url), tool: offer(t), refundUrl, price, args }, (ctx) => within(bound, (signal) => perform(t, args, { ...ctx, signal }), { hangup }), (r) => r.isError, hangup)
    if (g.refused) return json(g.refused.status, g.refused.body, g.refused.headers)
    if (g.threw && g.error?.code === 'out_of_time') return json(402, whenCut(g.cut, outOfTime(false, bound)))
    if (g.threw && quit(hangup)) { const l = hungUp(g.error, false, { tool: toolName }); return json(l.status, whenCut(g.cut, l.body)) }
    if (g.threw && g.error instanceof Fault) throw g.error.cause
    if (g.failed && g.threw) return json(500, { error: 'tool_failed', message: message(g.error), tool: toolName })
    if (g.failed) {
      const h = failedHttp(g.value.value, toolName)
      return json(h.status, h.body, h.headers)
    }
    if (!g.settlement.ok) return json(g.settlement.status, g.settlement.body?.error === 'tool_failed' ? { ...g.settlement.body, tool: toolName } : g.settlement.body, g.settlement.headers)
    return new Response(g.value.body, { status: 200, headers: { 'content-type': 'application/json', ...g.settlement.headers } })
  }

  const delivered = (value, body, meta = {}) => {
    const structured = kind(value) === 'object' ? { structuredContent: JSON.parse(body) } : {}
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : body }], ...structured, ...(Object.keys(meta).length ? { _meta: meta } : {}) }
  }

  async function mcpCall(params, resource, grant, refundUrl = null, info = {}) {
    const t = find(params.name)
    if (!t) return failure(unknownTool(params.name))
    const only = closed ? null : await paymentOnly(t, payHeader(params._meta?.[META_PAYMENT], grant, params._meta), `mcp:${t.name}`, resource, refundUrl, params._meta?.[Sessions.PAYMENT_ONLY] === true)
    if (only) return refusal(only)
    const args = params.arguments ?? {}
    const bad = validate(t.inputSchema, asked(t, args))
    const probing = probe(t, args, params._meta?.[META_PAYMENT] || params._meta?.[McpPayment.CREDENTIAL] ? 'paid' : '', first(typeof params._meta?.[META_LINE] === 'string' ? params._meta[META_LINE] : '', info.line))
    if (bad && probing) {
      const q = await terms(t, `mcp:${t.name}`, payHeader(null, grant), resource, refundUrl, null, args)
      return q ? refusal(q) : failure({ error: 'invalid_arguments', tool: t.name, message: bad })
    }
    if (bad) return failure({ error: 'invalid_arguments', tool: t.name, message: bad })
    const no = probing ? null : await declined(t, args)
    if (no) return failure({ error: 'invalid_arguments', tool: t.name, message: no })
    if (isFree(t)) {
      const f = await served(t, args, { ip: info.ip, line: first(typeof params._meta?.[META_LINE] === 'string' ? params._meta[META_LINE] : '', info.line) })
      if (f.limited) return failure(f.limited)
      if (f.threw && f.error instanceof Fault) throw f.error.cause
      if (f.threw) return failure({ error: 'tool_failed', tool: t.name, message: message(f.error) })
      if (f.value.isError) return failed(f.value.value, t.name)
      return delivered(f.value.value, f.value.body)
    }
    const credential = first(typeof params._meta?.[META_LINE] === 'string' ? params._meta[META_LINE] : '', info.line)
    if (t.meter === 'time' && credential) {
      const l = await onLine(t, args, credential, info.signal ?? null, undefined, baseOf(refundUrl))
      if (l.failedValue) return metered(failed(l.failedValue, t.name), l.meta)
      if (l.status !== 200) return metered(failure(l.body), l.meta)
      return delivered(l.value.value, l.value.body, { [META_METER]: l.meta })
    }
    let price
    try { price = engine.mode === 'gate' ? null : priceFor(t, args) } catch (e) { return failure({ error: 'price_invalid', tool: t.name, message: message(e) }) }
    const bound = t.meter === 'time' ? meter.callMs(price.micro) : null
    const g = await gate({ path: `mcp:${t.name}`, header: payHeader(params._meta?.[META_PAYMENT], grant, params._meta), resource, tool: offer(t), refundUrl, price, args }, (ctx) => within(bound, (signal) => perform(t, args, { ...ctx, signal }), { hangup: info.signal ?? null }), (r) => r.isError, info.signal ?? null)
    if (g.refused) return refusal(g.refused)
    if (g.threw && g.error?.code === 'out_of_time') return failure(whenCut(g.cut, outOfTime(false, bound)))
    if (g.threw && quit(info.signal)) return failure(whenCut(g.cut, { ...hungUp(g.error, false).body, tool: t.name }))
    if (g.threw && g.error instanceof Fault) throw g.error.cause
    if (g.threw) return failure({ error: 'tool_failed', tool: t.name, message: message(g.error) })
    if (g.failed) return failed(g.value.value, t.name)
    if (!g.settlement.ok) return refusal(g.settlement)
    return delivered(g.value.value, g.value.body, settledMeta(g.settlement.headers))
  }

  const calling = new Map()
  const callers = (info, meta) => {
    const line = first(typeof meta?.[META_LINE] === 'string' ? meta[META_LINE] : '', info.line)
    return [line ? `line ${line}` : null, typeof info.session === 'string' && (McpPayment.inSession(info.session) || MCP_SESSION.test(info.session.trim())) ? `session ${info.session.trim()}` : null].filter(Boolean)
  }
  const called = (id, info, meta) => {
    const key = `${typeof id} ${id}`
    const stopper = new AbortController()
    const call = { stopper, by: callers(info, meta) }
    const hung = () => stopper.abort(info.signal.reason)
    if (info.signal?.aborted) hung()
    else info.signal?.addEventListener('abort', hung, { once: true })
    if (!calling.has(key)) calling.set(key, new Set())
    calling.get(key).add(call)
    return {
      signal: stopper.signal,
      land() {
        info.signal?.removeEventListener('abort', hung)
        calling.get(key)?.delete(call)
        if (calling.get(key)?.size === 0) calling.delete(key)
      },
    }
  }
  const canceled = (msg, info) => {
    const id = kind(msg?.params) === 'object' ? msg.params.requestId : undefined
    if (msg?.method !== 'notifications/cancelled' || !['string', 'number'].includes(typeof id)) return
    const by = callers(info, kind(msg.params._meta) === 'object' ? msg.params._meta : undefined)
    for (const call of calling.get(`${typeof id} ${id}`) ?? []) if (call.by.some((who) => by.includes(who))) call.stopper.abort()
  }

  async function mcpOne(msg, resource, grant, refundUrl = null, info = {}) {
    const id = kind(msg) === 'object' && ['string', 'number'].includes(typeof msg.id) ? msg.id : null
    const reply = (result) => ({ jsonrpc: '2.0', id, result: info.modern ? complete(msg.method, result, serverInfo()) : result })
    const fail = (code, why, data) => ({ jsonrpc: '2.0', id, error: { code, message: why, ...(data === undefined ? {} : { data }) } })
    try {
      if (kind(msg) !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request')
      if (msg.id === undefined) { canceled(msg, info); return null }
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params?.protocolVersion
          return reply({ protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: await capabilities(takesMpp() && McpPayment.declares(msg.params?.capabilities)), serverInfo: serverInfo(), ...greeting() })
        }
        case 'ping': return reply({})
        case 'server/discover': return info.modern ? reply({ supportedVersions: MODERN_VERSIONS, capabilities: await capabilities(info.payment === true), ...greeting() }) : fail(-32601, `method not found: ${msg.method}`)
        case 'tools/list': {
          const page = toolRoll.page([...tools.values()], (t) => t.name, listPage, msg.params?.cursor)
          return page ? reply({ tools: page.items.map(shown).map(lineListed), ...(page.next ? { nextCursor: page.next } : {}) }) : fail(-32602, BAD_CURSOR)
        }
        case 'resources/list': {
          if (!resources.size) return fail(-32601, `method not found: ${msg.method}`)
          const page = resourceRoll.page([...resources.values()], (r) => r.uri, listPage, msg.params?.cursor)
          return page ? reply({ resources: page.items.map(({ read, ...listed }) => listed), ...(page.next ? { nextCursor: page.next } : {}) }) : fail(-32602, BAD_CURSOR)
        }
        case 'resources/templates/list': return resources.size ? reply({ resourceTemplates: [] }) : fail(-32601, `method not found: ${msg.method}`)
        case 'resources/read': {
          if (!resources.size) return fail(-32601, `method not found: ${msg.method}`)
          if (typeof msg.params?.uri !== 'string') return fail(-32602, 'invalid params: expected { uri }')
          if (!resources.has(msg.params.uri)) return fail(-32602, `Resource not found: ${msg.params.uri}`, { uri: msg.params.uri })
          return reply(await mcpRead(msg.params, String(refundUrl ?? '').replace(/\/refund$/, '')))
        }
        case 'tools/call': {
          const p = McpPayment.params(msg)
          if (kind(p) !== 'object' || typeof p.name !== 'string' || (p._meta !== undefined && kind(p._meta) !== 'object')) return fail(-32602, 'invalid params: expected { name, arguments, _meta } with _meta an object')
          const call = called(id, info, p._meta)
          let out
          try { out = await mcpCall(lineCalled(p, info.line), resource, grant, refundUrl, { ...info, signal: call.signal }) } finally { call.land() }
          const unpaid = info.payment === true ? McpPayment.error(out._meta?.[McpPayment.REQUIRED], out.structuredContent ?? null) : null
          return unpaid ? fail(unpaid.code, unpaid.message, unpaid.data) : reply(out)
        }
        default: return fail(-32601, `method not found: ${msg.method}`)
      }
    } catch (e) {
      internal(e, info.at)
      return fail(-32603, 'internal error')
    }
  }

  async function mcp(request, refundUrl = null, info = {}) {
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    let body
    try { body = await request.json() } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    const era = classify(request, body, mcpVersions())
    if (era.refuse) return era.refuse
    if (Array.isArray(body) && !body.length) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: empty batch' } })
    const resource = publicUrl(request.url)
    const grant = request.headers.get('x-grant')
    info = { ...info, line: lineOf(request), session: request.headers.get('mcp-session-id'), signal: hangupOf(request, info), at: { method: request.method, path: new URL(request.url).pathname, ip: info.ip } }
    const opened = !era.modern && kind(body) === 'object' && body.method === 'initialize' && body.id !== undefined ? { 'mcp-session-id': takesMpp() && McpPayment.declares(body.params?.capabilities) ? McpPayment.session() : `mcp.${Base64Url.encode(randomBytes(12))}` } : {}
    info.payment = takesMpp() && (era.modern ? McpPayment.declares(body.params?._meta?.['io.modelcontextprotocol/clientCapabilities']) : McpPayment.inSession(request.headers.get('mcp-session-id')))
    if (era.modern) {
      if (!isJson(request.headers.get('content-type'))) return rpcError(415, -32000, 'Unsupported Media Type: Content-Type must be application/json')
      if (era.notification) { canceled(body, info); return new Response(null, { status: 202 }) }
      if (!mcpMethods().includes(body.method)) return rpcError(404, -32601, 'Method not found', undefined, body.id)
      return json(200, await mcpOne(body, resource, grant, refundUrl, { ...info, modern: true }))
    }
    const asked = (Array.isArray(body) ? body : [body]).map((m) => mcpOne(m, resource, grant, refundUrl, info))
    if (streams(request.headers.get('accept'), stream === true) && (Array.isArray(body) ? body : [body]).some((m) => kind(m) !== 'object' || m.id !== undefined || typeof m.method !== 'string' || m.jsonrpc !== '2.0')) return eventStream(asked, opened)
    const answers = (await Promise.all(asked)).filter(Boolean)
    if (!answers.length) return new Response(null, { status: 202 })
    return json(200, Array.isArray(body) ? answers : answers[0], opened)
  }

  async function refund(request) {
    let b
    try { b = JSON.parse(await request.text()) } catch { return json(400, { op: 'refund_failed', code: 'invalid_json', why: 'the body is not JSON' }) }
    if (kind(b) !== 'object') return json(400, { op: 'refund_failed', code: 'invalid_request', why: 'expected { channelId, issued, signature }, optional selfSend or gasPayment' })
    try {
      const r = await engine.refund(b)
      return Number.isSafeInteger(r.turn) ? json(r.status, { ...r.body, turn: r.turn }, { [REFUND_TURN]: String(r.turn) }) : json(r.status, r.body)
    } catch (e) { return json(503, { op: 'refund_failed', code: 'refund_unavailable', why: message(e), retry_after_seconds: 5 }) }
  }

  function refundExpress() {
    return (req, res, next) => {
      if (req.method !== 'POST') return next()
      ;(async () => send(res, await refund(await toRequest(req))))().catch((e) => lost(res, e, req))
    }
  }

  async function verify(url) {
    try {
      return { ok: !!site && new URL(site).origin === new URL(url).origin, site }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  }

  const unavailable = () => (engine.mode === 'gate'
    ? 'the check failed (error payment_unavailable), or this gate has no checks left this month (error gate_credit_exhausted). Retry later'
    : 'the payment check or settlement failed (error payment_unavailable); nothing is charged. Retry')
  const answers = (t, tag) => (isFree(t)
    ? { 200: { description: 'the result' }, 400: { description: 'invalid arguments' }, 500: { description: 'the tool failed' }, ...(freeCap(t) && !t.builtin ? { 429: { description: `over ${freeCap(t)} free calls an hour per address` } } : {}) }
    : { 200: { description: 'the result' }, 400: { description: engine.mode === 'gate' ? 'invalid arguments; nothing is charged' : 'invalid arguments (error invalid_arguments), or a payment that does not decode (error bad_payment_header) or is neither a voucher nor a deposit (error bad_payment_type); nothing is charged' }, 402: { description: engine.mode === 'gate' ? 'a zero-value x402 signature is required; nothing is paid' : `${t.builtin === 'buy_time' || tag.per === 'unit' ? 'x402 payment required' : 'payment required: x402, or MPP when the 402 carries a Payment challenge'}${t.meter === 'time' ? '; on a line, the meter is off (error meter_off), the line is out of time (error out_of_time) or the channel is withdrawing (error channel_leaving)' : ''}; a refund settling on the channel answers refund_settling` }, 403: { description: `key not admitted${t.meter === 'time' ? '; on a line, no line with that credential (error line_unknown)' : ''}` }, ...(t.meter === 'time' ? { 429: { description: 'too many calls are live on the line (error too_many_calls)' } } : {}), ...(t.route !== true || t.meter === 'time' ? { 499: { description: `the caller hung up or canceled the call, so it was stopped (error client_gone); nothing is charged${t.meter === 'time' ? ' per call, and on a line the line is billed for the time the call ran' : ''}` } } : {}), 500: { description: `the tool failed; nothing is charged per call${t.meter === 'time' ? ', and on a line the call has used the time it ran' : ''}` }, 503: { description: unavailable() } })

  const routeTag = (op) => {
    if (op.free === true) return describePrice(null, { free: true, perHour: freeCap(op) })
    if (engine.mode === 'gate') return { usd: '0', per: 'call' }
    if (typeof op.price === 'function') return op.meter === 'time' ? lineVaries() : describePrice(null, { varies: true })
    const p = routePrice(op.price, null)
    return op.meter === 'time' ? { per: 'time', usd: usd(time.rateMicro), ms: time.rateMs, callUSD: usd(p.micro), callMs: meter.callMs(p.micro) } : describePrice(p)
  }

  function paths(map) {
    const shape = 'bridge: paths is { "/path": { post: { summary, requestBody, price, meter } } }'
    if (kind(map) !== 'object') throw new Error(shape)
    for (const [path, item] of Object.entries(map)) {
      if (!path.startsWith('/') || kind(item) !== 'object') throw new Error(shape)
      const ops = Object.entries(item).filter(([method]) => METHODS.includes(method))
      if (!ops.length) throw new Error(`bridge: paths ${path} names no operation: one of ${METHODS.join(', ')}`)
      for (const [, op] of ops) {
        if (kind(op) !== 'object') throw new Error(shape)
        if (op.meter !== undefined && op.meter !== 'time') throw new Error('bridge: meter is "time"')
        if (op.meter === 'time' && !time) throw new Error('bridge: a route that meters time needs the seller\'s time option')
        if (op.responses !== undefined && kind(op.responses) !== 'object') throw new Error('bridge: a path\'s responses is an object')
        freeRoute(op)
        routeTag(op)
      }
    }
    routes.clear()
    for (const [path, item] of Object.entries(map)) routes.set(path, item)
    return api
  }

  async function routePaths(info, origin, root) {
    const mine = {}
    const offers = {}
    const given = {}
    for (const [path, item] of routes) {
      const out = {}
      for (const [method, v] of Object.entries(item)) {
        if (!METHODS.includes(method)) { out[method] = v; continue }
        const { price, meter: by, free, freeLimit: own, responses = {}, ...op } = v
        const tag = routeTag(v)
        const ours = answers({ name: path, meter: by, free, freeLimit: own, route: true }, tag)
        const both = Object.fromEntries(PAYMENT_ANSWERS.filter((code) => ours[code]).map((code) => [code, kind(responses[code]) === 'object' ? { ...responses[code], description: [ours[code].description, responses[code].description].filter((d) => typeof d === 'string' && d !== '').join('; ') } : ours[code]]))
        const key = `${method} ${path}`
        given[key] = op.operationId
        out[method] = { ...op, operationId: key, 'x-price': tag, responses: { ...ours, ...responses, ...both } }
        if (engine.server && engine.mode !== 'gate' && free !== true && typeof price !== 'function') {
          let offer = []
          try { offer = await engine.server.mppOffers(routePrice(price, null), null) } catch { offer = [] }
          if (offer.length) offers[key] = offer
        }
      }
      const under = root !== '' && path.startsWith(`${root}/`)
      mine[origin === null || root === '' ? path : under ? path.slice(root.length) : path] = origin === null || root === '' || under || out.servers !== undefined ? out : { servers: [{ url: origin }], ...out }
    }
    const listed = discovery({ info, paths: mine }, offers).paths
    for (const item of Object.values(listed)) {
      for (const [method, op] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue
        if (given[op.operationId] === undefined) delete op.operationId
        else op.operationId = given[op.operationId]
      }
    }
    return listed
  }

  async function openapi(base, mount = null, root = '') {
    const paths = {}
    for (const t of tools.values()) {
      const responses = answers(t, isFree(t) ? null : priceTag(t))
      if (t.name === 'line') Object.assign(responses, { 400: { description: 'invalid arguments (error invalid_arguments), or a step refused (op line_failed, with code and why)' }, 402: { description: 'a refund settling on the channel answers refund_settling; "on" while a refund asked for on the channel is being worked out answers refund_pending' }, 403: { description: "no line with that credential, or the proof is not the payer's" }, 404: { description: 'no channel with that id here, or this seller sells no line time' }, 409: { description: 'the channel is leaving; code and why say so' }, 503: { description: 'the line could not be read right now (code line_unavailable; nothing changed, send it again)' } })
      paths[`/v1/${t.name}`] = { post: { operationId: t.name, summary: t.description, 'x-price': priceTag(t), requestBody: { required: true, content: { 'application/json': { schema: t.inputSchema } } }, responses } }
    }
    const contact = engine.options.contact
    const reach = contact ? { contact: /^mailto:/i.test(contact) ? { email: contact.slice(7) } : { url: contact } } : {}
    const offers = {}
    if (engine.server && engine.mode !== 'gate') {
      for (const t of tools.values()) {
        if (isFree(t) || (!ownPrice(t) && typeof o.prices === 'function')) continue
        let offer = []
        try { offer = await engine.server.mppOffers(priceFor(t, {}), brief(t)) } catch { offer = [] }
        if (offer.length) offers[t.name] = offer
      }
    }
    const sessions = Object.values(offers).some((list) => list.some((offer) => offer.intent === Sessions.INTENT))
    const doc = { openapi: '3.0.3', info: { title: serverName, version, description: `${HOW[engine.mode]}${sessions ? SESSIONS_HOW : ''}. MCP: ${base}/mcp`, ...reach }, servers: [{ url: base }], paths }
    const out = discovery(doc, offers, { homepage: site || null, ...(mount === null ? {} : { origin: base.slice(0, base.length - mount.length), mount }) })
    if (!routes.size) return out
    const listed = await routePaths(doc.info, mount === null ? base.slice(0, base.length - root.length) : null, root)
    out.paths = { ...out.paths, ...Object.fromEntries(Object.entries(listed).filter(([path]) => !Object.hasOwn(out.paths, path))) }
    return out
  }

  const withCors = (res) => {
    const h = new Headers(res.headers)
    for (const [k, v] of Object.entries(CORS)) h.set(k, v)
    if (h.has('mcp-session-id')) h.set('access-control-expose-headers', `${CORS['access-control-expose-headers']}, Mcp-Session-Id`)
    if (h.has(REFUND_TURN)) h.set('access-control-expose-headers', `${CORS['access-control-expose-headers']}, ${REFUND_TURN}`)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }

  function handle(base = '', { discovery: atRoot = false } = {}) {
    const root = base.replace(/\/+$/, '')
    const described = { 'cache-control': CACHE_CONTROL }
    const route = async (request, info) => {
      const u = new URL(request.url)
      const at = (publicUrl(`${u.origin}${root}`) ?? `${u.origin}${root}`).replace(/\/+$/, '')
      if (atRoot && root !== '' && u.pathname === '/openapi.json' && request.method === 'GET') return json(200, await openapi(at, root), described)
      if (!u.pathname.startsWith(root)) return null
      const under = u.pathname.slice(root.length) || '/'
      const rest = under === '/mcp/' ? '/mcp' : under
      const m = /^\/v1\/([^/]+)$/.exec(rest)
      const refundAt = publicUrl(`${u.origin}${root}/refund`) ?? null
      if (request.method === 'OPTIONS' && (rest === '/mcp' || rest === '/refund' || rest === '/line' || m)) return new Response(null, { status: 204, headers: PREFLIGHT })
      if (rest === '/line' && request.method === 'POST') {
        if (!time) {
          const l = await lineOp({})
          return json(l.status, l.body)
        }
        let body
        try { body = JSON.parse(await request.text()) } catch { return json(400, { op: 'line_failed', code: 'bad_request', why: 'the body is not JSON' }) }
        const l = await lineOp(body, lineOf(request))
        return json(l.status, l.body)
      }
      if (rest === '/mcp') return mcp(request, refundAt, info)
      if (rest === '/refund' && request.method === 'POST') return refund(request)
      if (rest === '/openapi.json' && request.method === 'GET') return json(200, await openapi(at, null, root), described)
      if (m && (request.method === 'POST' || (request.method === 'HEAD' && engine.sessions))) {
        let toolName
        try { toolName = decodeURIComponent(m[1]) } catch { return json(404, unknownTool(m[1])) }
        return http(request, toolName, refundAt, info)
      }
      return null
    }
    return async (request, info = {}) => {
      let res
      try {
        res = await route(request, info && typeof info === 'object' ? info : {})
      } catch (e) {
        const read = (get) => { try { return get() } catch { return undefined } }
        const path = read(() => new URL(request.url).pathname) ?? ''
        const body = internal(e, { method: read(() => request.method), path, ip: info?.ip })
        res = /^\/mcp\/?$/.test(path.slice(root.length)) ? json(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: body.message } }) : json(500, body)
      }
      return res ? withCors(res) : null
    }
  }

  function serve(h) {
    if (typeof h !== 'function') throw new Error('bridge: serve takes a fetch handler: (request) => Response')
    return (req, res, next) => {
      ;(async () => {
        const hung = new AbortController()
        res.on?.('close', () => { if (!res.writableEnded) hung.abort() })
        const response = await h(await toRequest(req, hung.signal), { ip: req.ip ?? req.socket?.remoteAddress, signal: hung.signal })
        if (!response) return next()
        await send(res, response)
      })().catch((e) => lost(res, e, req))
    }
  }

  const express = (base = '', options = {}) => serve(handle(base, options))

  function buffer(res, settle, req) {
    const orig = { writeHead: res.writeHead, write: res.write, end: res.end }
    const chunks = []
    let head = null
    let ended = false
    const push = (chunk, enc) => { if (chunk != null) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8') : Buffer.from(chunk)) }
    res.writeHead = function (status, ...more) { head = [status, ...more]; res.statusCode = status; return res }
    res.write = function (chunk, enc, cb) { push(chunk, enc); const f = typeof enc === 'function' ? enc : cb; if (typeof f === 'function') queueMicrotask(f); return true }
    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null } else if (typeof enc === 'function') { cb = enc; enc = null }
      if (ended) return res
      ended = true
      push(chunk, enc)
      Object.assign(res, orig)
      settle({ status: res.statusCode, head, body: Buffer.concat(chunks), cb }).catch((e) => lost(res, e, req))
      return res
    }
  }

  const freeRoute = ({ free, freeLimit: own, meter: by }) => {
    if (free !== undefined && typeof free !== 'boolean') throw new Error('bridge: a route\'s free is true or false')
    if (own !== undefined && own !== false && !(Number.isSafeInteger(own) && own >= 1)) throw new Error('bridge: a route\'s freeLimit is free calls an hour per client address, a whole number, 1 or more, or false for none')
    if (own !== undefined && free !== true) throw new Error('bridge: freeLimit is for a free route; set free: true')
    if (free === true && by === 'time') throw new Error('bridge: a route that meters time is not free')
  }

  const routePrice = (spec, req) => (engine.mode === 'gate' ? null : priceOf(typeof spec === 'function' ? spec(req) : spec ?? null, o.priceMicroUSD))

  const paywall = {
    express: ({ when = () => true, price, base = null } = {}) => (req, res, next) => {
      ;(async () => {
        if (!when(req)) return next()
        const header = (h) => req.get?.(h) ?? req.headers?.[h]
        const resource = publicUrl(`${req.protocol ?? 'http'}://${header('host') ?? 'localhost'}${req.originalUrl ?? req.url}`)
        if (closed) { const no = shut(); return send(res, json(no.status, no.body)) }
        const c = await check({ path: req.originalUrl ?? req.url, header, resource, price: routePrice(price, req), base })
        if (!c.ok) return send(res, json(c.status, c.body, c.headers))
        let land = () => {}
        fly(() => new Promise((ok) => { land = ok }), false)
        res.on?.('close', () => land())
        buffer(res, async ({ status, head, body, cb }) => {
          const failed = status >= 400
          const d = await done(c.ticket, !failed).finally(land)
          if (failed || d.ok) {
            if (!failed) for (const [k, v] of Object.entries(d.headers)) res.setHeader(k, v)
            if (head) res.writeHead(...head)
            res.end(body, cb)
            return
          }
          for (const k of res.getHeaderNames?.() ?? []) res.removeHeader(k)
          await send(res, json(d.status, d.body, d.headers))
        }, req)
        next()
      })().catch((e) => lost(res, e, req))
    },
    wrap: (handler, { when = () => true, price, meter: by, line, tool: described, base = null, free, freeLimit: own } = {}) => {
      if (by !== undefined && by !== 'time') throw new Error('bridge: meter is "time"')
      if (by === 'time' && !time) throw new Error('bridge: a route that meters time needs the seller\'s time option')
      if (line !== undefined && typeof line !== 'function') throw new Error('bridge: line is a function of the request that returns the line credential')
      freeRoute({ free, freeLimit: own, meter: by })
      const cap = freeCap({ freeLimit: own })
      if (typeof described?.name === 'string' && described.name !== '') wrapped.set(described.name, { price, meter: by, free, freeLimit: own })
      const about = (path) => (kind(described) === 'object' ? { name: path, ...described } : undefined)
      const sent = (r, headers) => {
        const h = new Headers(r.headers)
        for (const [k, v] of Object.entries(headers)) h.set(k, v)
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h })
      }
      return async (request, ...rest) => {
        if (!when(request)) return handler(request, ...rest)
        const u = new URL(request.url)
        if (free === true) {
          const take = await freeTake(about(u.pathname)?.name ?? u.pathname, rest[0]?.ip, cap)
          if (!take.ok) return json(429, FreeLimit.refusal(cap, take.retryAfter), { 'retry-after': String(take.retryAfter) })
          return handler(request, { signal: hangupOf(request, rest[0]) }, ...rest)
        }
        const sale = { path: u.pathname + u.search, header: (h) => request.headers.get(h), resource: publicUrl(request.url), tool: about(u.pathname), base }
        if (by === 'time') return timed(request, rest, handler, sale, price, line, sent)
        const g = await gate({ ...sale, price: routePrice(price, request) }, () => handler(request, ...rest), (r) => typeof r?.status !== 'number' || r.status >= 400)
        if (g.refused) return json(g.refused.status, g.refused.body, g.refused.headers)
        if (g.threw) throw g.error
        if (g.failed) return g.value
        if (!g.settlement.ok) return json(g.settlement.status, g.settlement.body, g.settlement.headers)
        return sent(g.value, g.settlement.headers)
      }
    },
  }

  async function timed(request, rest, handler, sale, price, line, sent) {
    const name = sale.tool?.name ?? sale.path
    const hangup = hangupOf(request, rest[0])
    const credential = line ? first(line(request)) : lineOf(request)
    const work = async (call) => {
      const r = await handler(request, call, ...rest)
      return typeof r?.status !== 'number' || r.status >= 400 ? { value: r, isError: true } : { value: r }
    }
    if (credential) {
      const l = await onLine({ name }, null, credential, hangup, work, baseOf(null, sale.base))
      if (l.failedValue !== undefined) return l.failedValue instanceof Response ? sent(l.failedValue, reading(l.meta)) : l.failedValue
      if (l.status !== 200) return json(l.status, told(l), { ...(l.headers ?? {}), ...(l.meta ? reading(l.meta) : {}) })
      return sent(l.value.value, reading(l.meta))
    }
    let p
    try { p = onTime(routePrice(price, request)) } catch (e) { return json(500, { error: 'price_invalid', tool: name, message: message(e) }) }
    const bound = meter.callMs(p.micro)
    const g = await gate({ ...sale, price: p }, (ctx) => within(bound, (signal) => work({ ...ctx, signal }), { hangup }), (r) => r.isError === true, hangup)
    if (g.refused) return json(g.refused.status, g.refused.body, g.refused.headers)
    if (g.threw && g.error?.code === 'out_of_time') return json(402, whenCut(g.cut, outOfTime(false, bound)))
    if (g.threw && quit(hangup)) { const l = hungUp(g.error, false, { tool: name }); return json(l.status, whenCut(g.cut, l.body)) }
    if (g.threw) return json(500, { error: 'tool_failed', tool: name, message: message(g.error) })
    if (g.failed) return g.value.value ?? json(500, { error: 'tool_failed', tool: name, message: 'the route returned no response' })
    if (!g.settlement.ok) return json(g.settlement.status, g.settlement.body, g.settlement.headers)
    return sent(g.value.value, g.settlement.headers)
  }

  function paid(toolName, handler, { description, inputSchema, outputSchema, resource, price } = {}) {
    const described = description !== undefined || inputSchema !== undefined ? { name: toolName, ...(description !== undefined ? { description } : {}), ...(inputSchema !== undefined ? { inputSchema } : {}), ...(inputSchema !== undefined && outputSchema !== undefined ? { outputSchema } : {}) } : undefined
    const priced = { name: toolName, ...(price !== undefined ? { price } : {}) }
    if (engine.mode !== 'gate' && (ownPrice(priced) || typeof o.prices !== 'function')) priceFor(priced)
    return async (...args) => {
      const extra = args.length > 1 ? args[args.length - 1] : args[0]
      const meta = kind(extra?._meta) === 'object' ? extra._meta : {}
      const grant = extra?.requestInfo?.headers?.['x-grant'] ?? null
      let p
      try { p = engine.mode === 'gate' ? null : priceFor(priced, args.length > 1 && kind(args[0]) === 'object' ? args[0] : {}) } catch (e) { return failure({ error: 'price_invalid', tool: toolName, message: message(e) }) }
      const g = await gate({ path: `mcp:${toolName}`, header: payHeader(meta[META_PAYMENT], typeof grant === 'string' ? grant : null, meta), resource, tool: described ?? { name: toolName }, price: p }, () => handler(...args), (out) => out?.isError === true || serialize(out) === null)
      if (g.refused) return refusal(g.refused)
      if (g.threw) throw g.error
      if (g.failed) return serialize(g.value) === null ? failure({ error: 'tool_failed', tool: toolName, message: RESULT_NOT_JSON }) : g.value
      if (!g.settlement.ok) return refusal(g.settlement)
      const out = g.value
      const added = settledMeta(g.settlement.headers)
      return Object.keys(added).length ? { ...out, _meta: { ...(out?._meta ?? {}), ...added } } : out
    }
  }

  function instrument(server, { free: freeTools = [], resource } = {}) {
    const free = [...freeTools, ...o.free]
    const wrap = (toolName, handler, description) => (free.includes(toolName) ? handler : paid(toolName, handler, { description, resource }))
    const seal = (toolName, registered) => {
      if (kind(registered) !== 'object' || typeof registered.update !== 'function' || free.includes(toolName)) return registered
      const update = registered.update.bind(registered)
      registered.update = (u) => update(typeof u?.callback === 'function' ? { ...u, callback: paid(u.name ?? toolName, u.callback, { description: u.description ?? registered.description, resource }) } : u)
      return registered
    }
    const existing = kind(server._registeredTools) === 'object' ? server._registeredTools : null
    for (const [toolName, t] of Object.entries(existing ?? {})) {
      if (typeof t?.handler !== 'function' || free.includes(toolName)) continue
      t.handler = paid(toolName, t.handler, { description: t.description, resource })
      seal(toolName, t)
    }
    const register = server.registerTool.bind(server)
    server.registerTool = (toolName, config, handler) => seal(toolName, register(toolName, config, wrap(toolName, handler, config?.description)))
    if (typeof server.tool === 'function') {
      const legacy = server.tool.bind(server)
      server.tool = (toolName, ...rest) => {
        const handler = rest.pop()
        return seal(toolName, legacy(toolName, ...rest, wrap(toolName, handler, typeof rest[0] === 'string' ? rest[0] : undefined)))
      }
    }
    return server
  }

  if (time) {
    toolRoll.add('buy_time')
    toolRoll.add('line')
    tools.set('buy_time', { name: 'buy_time', builtin: 'buy_time', description: `Buys line time: ${timeRate(time)}, for the channel that pays. Then open a line.`, inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: time.rateMs, ...(time.rateMs > 1 ? { multipleOf: time.rateMs } : {}), ...(time.maxMs ? { maximum: time.maxMs } : {}), description: `milliseconds of line time; default ${time.unitMs}. Buying again adds time` } } }, run: guarded(async (args, ctx) => {
      const ms = boughtMs(time, args)
      const st = await meter.status(ctx.channelId)
      return { channelId: ctx.channelId, boughtMs: ms, msRemaining: st.msRemaining + ms, paidUSD: usd(timeMicro(time, ms)) }
    }) })
    tools.set('line', { name: 'line', builtin: 'line', free: true, description: 'A line spends bought time without a payment per call. {"op":"open","channelId":"0x…"} returns a message to sign with the payer key; {"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"} returns the credential; {"op":"on","credential":"…"} and {"op":"off","credential":"…"} switch the channel\'s meter on and off; {"op":"status","credential":"…"} reads the line; {"op":"close","credential":"…"} ends it.', inputSchema: { type: 'object', properties: { op: { type: 'string', enum: LINE_OPS, description: LINE_ARGUMENTS.op }, channelId: { type: 'string', description: LINE_ARGUMENTS.channelId }, nonce: { type: 'string', description: LINE_ARGUMENTS.nonce }, signature: { type: 'string', description: LINE_ARGUMENTS.signature }, credential: { type: 'string', description: LINE_ARGUMENTS.credential } }, required: ['op'] }, run: guarded(async (args, ctx) => {
      const l = await lineOp(args, ctx.line ?? '')
      return l.status === 200 ? l.body : { isError: true, structuredContent: l.body, content: text(l.body) }
    }) })
  }

  const api = { tool, describe, untool, lineOf, server, resource, handle, express, serve, check, done, validate, paywall, paid, instrument, refund, refundExpress, verify, tools: listTools, prices, terms: facts, offers, tick: engine.tick, payout: engine.payout, status: engine.status, stop: engine.stop, drain, line, ride, books, gas, paths, engine }
  if (options.server !== undefined) server(options.server)
  return api
}

function tick(options = {}) {
  const p = bridge({ ...options, tick: false })
  return p.tick()
}

export { bridge, bridge as pass, tick, validate, names, feeRecipient, CONTRACTS as contracts }
export { signGrant } from './grant.mjs'
export { setting } from './engine/env.mjs'
