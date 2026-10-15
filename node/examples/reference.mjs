import http from 'node:http'
import { bridge, setting } from '@zeambridge/bridge'

const env = process.env
const list = (s) => String(s ?? '').split(/[\s,]+/).filter(Boolean)
const priced = (s) => Object.fromEntries(list(s).map((kv) => kv.split('=')).filter(([k, v]) => k && v))
const metered = setting('BRIDGE_METERED') === '1'
const agents = bridge({
  name: setting('BRIDGE_NAME'),
  payout: setting('BRIDGE_PAYOUT'),
  mode: setting('BRIDGE_MODE') ?? 'both',
  price: setting('BRIDGE_PRICE') ?? '0.01',
  admit: list(setting('BRIDGE_ADMIT')),
  relay: setting('BRIDGE_RELAY') || undefined,
  credits: setting('BRIDGE_CREDITS') || undefined,
  rpc: setting('BRIDGE_RPC') || undefined,
  site: setting('BRIDGE_SITE') || undefined,
  contact: setting('BRIDGE_CONTACT') || undefined,
  prices: setting('BRIDGE_PRICES') ? priced(setting('BRIDGE_PRICES')) : undefined,
  freeLimit: setting('BRIDGE_FREE_LIMIT') ? Number(setting('BRIDGE_FREE_LIMIT')) : undefined,
  sessions: setting('BRIDGE_SESSION_ESCROW') && setting('BRIDGE_SESSION_FACTORY') ? { escrow: setting('BRIDGE_SESSION_ESCROW'), factory: setting('BRIDGE_SESSION_FACTORY') } : undefined,
  time: metered && setting('BRIDGE_TIME_BLOCK') ? { usd: setting('BRIDGE_TIME_BLOCK'), ms: Number(setting('BRIDGE_TIME_BLOCK_MS') || 250), maxCalls: Number(setting('BRIDGE_TIME_MAX_CALLS') || 3) } : undefined,
  serverName: 'ZEAM Bridge reference seller (Node)',
})
agents.tool({
  name: 'add', description: 'Adds two numbers.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  run: async ({ a, b }) => ({ sum: a + b }),
})
agents.tool({
  name: 'fortune', description: 'A fortune, for sale.',
  run: async () => ({ fortune: 'An agent will pay you today.' }),
})
agents.tool({
  name: 'divide', price: '0.02', description: 'Divides a by b. Fails when b is 0.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  run: async ({ a, b }) => {
    if (b === 0) throw new Error('b is 0')
    return { quotient: a / b }
  },
})
if (metered) {
  agents.tool({ name: 'ping', free: true, description: 'Free. Answers pong and the time.', run: async () => ({ pong: true, at: new Date().toISOString() }) })
  agents.tool({
    name: 'words', price: '0.05', unit: '0.0001', description: 'Counts the words in a text: $0.0001 per word, at most $0.05 a call.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 20000 } }, required: ['text'] },
    run: async ({ text }, meter) => { const words = text.split(/\s+/).filter(Boolean).length; meter.units(words); return { words } },
  })
  if (setting('BRIDGE_TIME_BLOCK')) {
    agents.tool({
      name: 'wait', meter: 'time', description: 'Waits ms milliseconds, then answers. Line time.',
      inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0, maximum: 9000 } }, required: ['ms'] },
      run: ({ ms }, { signal } = {}) => new Promise((ok, no) => {
        const t = setTimeout(() => ok({ waited: ms }), ms)
        signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason) })
      }),
    })
  }
}
const handle = agents.handle('/agents')
const gated = setting('BRIDGE_GATE_NAME')
  ? bridge({
      name: setting('BRIDGE_GATE_NAME'),
      payout: setting('BRIDGE_PAYOUT'),
      mode: 'gate',
      admit: list(setting('BRIDGE_ADMIT')),
      credits: setting('BRIDGE_CREDITS') || undefined,
      rpc: setting('BRIDGE_RPC') || undefined,
      site: setting('BRIDGE_SITE') || undefined,
      contact: setting('BRIDGE_CONTACT') || undefined,
      stateDir: `${setting('BRIDGE_STATE_DIR') ?? '.pass'}/gate`,
      serverName: 'ZEAM Bridge reference gate (Node)',
    })
  : null
gated?.tool({
  name: 'add', description: 'Adds two numbers.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  run: async ({ a, b }) => ({ sum: a + b }),
})
const gate = gated ? gated.handle('/gate') : async () => null

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: setting('BRIDGE_NAME'), mode: setting('BRIDGE_MODE') ?? 'both', engine: 'node', gate: setting('BRIDGE_GATE_NAME') || null }))
      return
    }
    let body = ''
    for await (const c of req) body += c
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['content-length', 'transfer-encoding'].includes(k)).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]))
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body })
    const response = (await handle(request, { ip: req.socket.remoteAddress })) ?? (await gate(request)) ?? new Response('ZEAM Bridge reference seller: the tools are at /agents/mcp and /agents/v1/<tool>\n', { status: 404, headers: { 'content-type': 'text/plain' } })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'internal_error', message: String(e?.message ?? e) }))
  }
})
server.listen(Number(env.PORT ?? 8080), env.HOST ?? '0.0.0.0', () => console.log(`${setting('BRIDGE_NAME')} on ${env.HOST ?? '0.0.0.0'}:${env.PORT ?? 8080}`))

const stop = () => {
  agents.stop()
  gated?.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
