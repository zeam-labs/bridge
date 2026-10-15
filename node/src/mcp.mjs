const VERSION = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const LOG_LEVEL = 'io.modelcontextprotocol/logLevel'
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
const MODERN_FROM = '2026-07-28'
const MODERN_VERSIONS = [MODERN_FROM]
const CACHEABLE = ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read', 'server/discover']
const NAMED = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }
const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const KEEPALIVE_MS = 15000
const STREAM_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const isModern = (v) => typeof v === 'string' && v >= MODERN_FROM
const isJson = (type) => String(type ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
const expected = (want, v) => `Invalid input: expected ${want}, received ${kind(v)}`
const echo = (body) => (kind(body) === 'object' && typeof body.method === 'string' && ['string', 'number'].includes(typeof body.id) ? body.id : null)

function rpcError(status, code, message, data, id = null) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }), { status, headers: { 'content-type': 'application/json' } })
}

const unsupported = (requested, supported, id) => rpcError(400, -32022, `Unsupported protocol version: ${requested}`, { supported, requested }, id)
const mismatch = (header, body, id) => rpcError(400, -32020, `Bad Request: the request headers and body disagree: ${body}`, { mismatch: { header, body } }, id)
const invalid = (why, id = null) => rpcError(400, -32600, `Bad Request: ${why}`, undefined, id)

function envelopeIssue(meta) {
  if (!(CLIENT_CAPABILITIES in meta)) return { key: CLIENT_CAPABILITIES, problem: 'missing' }
  if (meta.progressToken !== undefined && !['string', 'number'].includes(typeof meta.progressToken)) return { key: 'progressToken', problem: 'Invalid input' }
  if (typeof meta[VERSION] !== 'string') return { key: VERSION, problem: expected('string', meta[VERSION]) }
  const info = meta[CLIENT_INFO]
  if (info !== undefined) {
    if (kind(info) !== 'object') return { key: CLIENT_INFO, problem: expected('object', info) }
    for (const k of ['name', 'version']) if (typeof info[k] !== 'string') return { key: `${CLIENT_INFO}.${k}`, problem: expected('string', info[k]) }
  }
  if (kind(meta[CLIENT_CAPABILITIES]) !== 'object') return { key: CLIENT_CAPABILITIES, problem: expected('object', meta[CLIENT_CAPABILITIES]) }
  if (meta[LOG_LEVEL] !== undefined && !LOG_LEVELS.includes(meta[LOG_LEVEL])) return { key: LOG_LEVEL, problem: `Invalid option: expected one of ${LOG_LEVELS.map((l) => `"${l}"`).join('|')}` }
  return null
}

function decoded(value) {
  if (!(value.startsWith('=?base64?') && value.endsWith('?='))) return value
  const b = value.slice(9, value.length - 2)
  if (!BASE64.test(b)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(b), (c) => c.codePointAt(0))) } catch { return undefined }
}

function named(request, body, id) {
  const field = Object.hasOwn(NAMED, body.method) ? NAMED[body.method] : undefined
  if (field === undefined) return null
  const value = typeof body.params?.[field] === 'string' ? body.params[field] : undefined
  const header = request.headers.get('mcp-name')
  if (header === null) return value === undefined ? null : mismatch('(missing)', `the body carries params.${field}="${value}" but the required Mcp-Name header is absent`, id)
  const name = decoded(header.trim())
  if (name === undefined) return mismatch(header.trim(), 'the Mcp-Name header carries an invalid Base64 sentinel value', id)
  return value !== undefined && name !== value ? mismatch(header.trim(), `the body carries params.${field}="${value}" but the Mcp-Name header names "${name}"`, id) : null
}

function classify(request, body, served) {
  const refuse = (response) => ({ refuse: response })
  const legacy = { modern: false }
  const id = echo(body)
  const sent = request.headers.get('mcp-protocol-version')
  const header = sent === null || sent.trim() === '' ? undefined : sent.trim()
  if (header !== undefined && !served.includes(header)) return refuse(unsupported(header, served, id))
  const headerModern = isModern(header)
  const claims = (m) => kind(m) === 'object' && kind(m.params) === 'object' && kind(m.params._meta) === 'object' && VERSION in m.params._meta
  if (Array.isArray(body)) {
    if (body.some(claims)) return refuse(invalid('JSON-RPC batches may not contain requests for protocol revision 2026-07-28 or later'))
    return headerModern && body.length ? refuse(invalid('JSON-RPC batches are not supported on protocol revision 2026-07-28 or later')) : legacy
  }
  if (kind(body) !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    if (!headerModern) return legacy
    return refuse(invalid(kind(body) === 'object' && (body.result !== undefined || body.error !== undefined) ? 'JSON-RPC responses cannot be posted to this endpoint' : 'the request body is not a valid JSON-RPC message'))
  }
  const method = body.method
  const note = body.id === undefined
  const meta = claims(body) ? body.params._meta : undefined
  const claimed = meta?.[VERSION]
  const called = request.headers.get('mcp-method')?.trim()
  if (method === 'initialize' && !(isModern(claimed) && envelopeIssue(meta) === null)) {
    return headerModern ? refuse(mismatch(header, 'an initialize request (legacy handshake) was sent with a modern MCP-Protocol-Version header', id)) : legacy
  }
  if (meta === undefined) {
    if (!headerModern) return legacy
    if (note) return called !== undefined && called !== method ? refuse(mismatch(called, `the notification body names method ${method} but the Mcp-Method header names ${called}`)) : { modern: true, notification: true }
    const held = kind(body.params) === 'object' && kind(body.params._meta) === 'object' ? body.params._meta : undefined
    const missing = held === undefined ? ['_meta'] : [VERSION, ...(CLIENT_CAPABILITIES in held ? [] : [CLIENT_CAPABILITIES])]
    return refuse(rpcError(400, -32602, `Invalid params: the MCP-Protocol-Version header names protocol revision ${header}, but the request is missing the required per-request envelope key(s): ${missing.join(', ')}`, { envelope: { missing } }, id))
  }
  if (typeof claimed === 'string' && !isModern(claimed)) {
    if (!served.includes(claimed)) return refuse(unsupported(claimed, served, id))
    return headerModern ? refuse(mismatch(header, `the body envelope names protocol version ${claimed} but the MCP-Protocol-Version header names ${header}`, id)) : legacy
  }
  const issue = envelopeIssue(meta)
  if (issue) return refuse(rpcError(400, -32602, `Invalid _meta envelope for protocol revision 2026-07-28: ${issue.key}: ${issue.problem}`, { envelope: issue }, id))
  if (header !== undefined && header !== claimed) return refuse(mismatch(header, `the body envelope names protocol version ${claimed} but the MCP-Protocol-Version header names ${header}`, id))
  if (called !== undefined && called !== method) return refuse(mismatch(called, `the body names method ${method} but the Mcp-Method header names ${called}`, id))
  if (!served.includes(claimed)) return refuse(unsupported(claimed, served, id))
  if (note) return { modern: true, notification: true }
  if (!(typeof body.id === 'string' || Number.isInteger(body.id))) return refuse(invalid('the request body is not a valid JSON-RPC message'))
  if (called === undefined) return refuse(mismatch('(missing)', `the body names method ${method} but the required Mcp-Method header is absent`, id))
  const bad = named(request, body, id)
  return bad ? refuse(bad) : { modern: true, notification: false }
}

function complete(method, result, serverInfo) {
  const out = { ...result, resultType: result.resultType ?? 'complete' }
  if (CACHEABLE.includes(method) && out.resultType === 'complete') Object.assign(out, { ttlMs: 0, cacheScope: 'private' })
  out._meta = { ...(kind(result._meta) === 'object' ? result._meta : {}), [SERVER_INFO]: serverInfo }
  return out
}

function streams(accept, whenever) {
  const a = String(accept ?? '').toLowerCase()
  if (!a.includes('text/event-stream')) return false
  return whenever || !(a.includes('application/json') || a.includes('*/*'))
}

function eventStream(answers, headers = {}) {
  const encoder = new TextEncoder()
  let open = true
  let timer
  const body = new ReadableStream({
    start(controller) {
      const write = (frame) => { if (open) { try { controller.enqueue(encoder.encode(frame)) } catch { open = false } } }
      timer = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS)
      timer.unref?.()
      const sent = answers.map((a) => Promise.resolve(a).then((m) => { if (m) write(`event: message\ndata: ${JSON.stringify(m)}\n\n`) }, () => {}))
      Promise.all(sent).then(() => {
        clearInterval(timer)
        if (!open) return
        open = false
        try { controller.close() } catch {}
      })
    },
    cancel() {
      open = false
      clearInterval(timer)
    },
  })
  return new Response(body, { status: 200, headers: { ...STREAM_HEADERS, ...headers } })
}

function roll(list) {
  const ranks = new Map()
  let last = 0
  const write = (after, top) => btoa(JSON.stringify([list, after, top])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const read = (cursor) => {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
    let v
    try { v = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) } catch { return null }
    return Array.isArray(v) && v.length === 3 && v[0] === list && Number.isSafeInteger(v[1]) && Number.isSafeInteger(v[2]) && v[1] >= 0 && v[2] >= v[1] ? { after: v[1], top: v[2] } : null
  }
  return {
    add(key) { if (!ranks.has(key)) ranks.set(key, ++last) },
    drop(key) { ranks.delete(key) },
    page(items, keyOf, size, cursor) {
      if (size === null) return { items }
      const at = cursor === undefined || cursor === null ? { after: 0, top: last } : read(cursor)
      if (at === null) return null
      const rest = items.filter((i) => ranks.get(keyOf(i)) > at.after && ranks.get(keyOf(i)) <= at.top)
      const now = rest.slice(0, size)
      return rest.length > size ? { items: now, next: write(ranks.get(keyOf(now[now.length - 1])), at.top) } : { items: now }
    },
  }
}

export { MODERN_VERSIONS, classify, complete, eventStream, isJson, roll, rpcError, streams }
