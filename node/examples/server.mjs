import http from 'node:http'
import { bridge, setting } from '@zeambridge/bridge'

const agents = bridge({ name: setting('BRIDGE_NAME'), payout: setting('BRIDGE_PAYOUT'), price: setting('BRIDGE_PRICE'), site: setting('BRIDGE_SITE'), serverName: 'Acme' })
agents.tool({
  name: 'add', description: 'Adds two numbers.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  run: async ({ a, b }) => ({ sum: a + b }),
})
agents.tool({
  name: 'fortune', description: 'A fortune, for sale.',
  run: async () => ({ fortune: 'An agent will pay you today.' }),
})
const handle = agents.handle('/agents')

http.createServer(async (req, res) => {
  const hung = new AbortController()
  res.on('close', () => { if (!res.writableEnded) hung.abort() })
  let body = ''
  for await (const c of req) body += c
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body })
  const response = (await handle(request, { signal: hung.signal })) ?? new Response('the site\'s own page')
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(Number(process.env.PORT ?? 18620), '127.0.0.1', () => console.log('acme on', process.env.PORT ?? 18620))
