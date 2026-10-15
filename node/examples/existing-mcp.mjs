import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { bridge, setting } from '@zeambridge/bridge'

const agents = bridge({ name: setting('BRIDGE_NAME'), payout: setting('BRIDGE_PAYOUT'), price: setting('BRIDGE_PRICE') })

const build = () => {
  const server = agents.instrument(new McpServer({ name: 'existing-mcp', version: '1.0.0' }), { free: ['about'] })
  server.registerTool('weather', { description: 'A forecast for a city.', inputSchema: { city: z.string() } },
    async ({ city }) => ({ content: [{ type: 'text', text: JSON.stringify({ city, forecast: 'clear, 21C' }) }] }))
  server.registerTool('about', { description: 'What this server is. Free.' },
    async () => ({ content: [{ type: 'text', text: 'An MCP server, paid per call.' }] }))
  return server
}

const refund = agents.refundExpress()

http.createServer(async (req, res) => {
  if (req.url === '/refund') return refund(req, res, () => { res.statusCode = 405; res.end() })
  let body = ''
  for await (const c of req) body += c
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => t.close())
  await build().connect(t)
  await t.handleRequest(req, res, body ? JSON.parse(body) : undefined)
}).listen(Number(process.env.PORT ?? 18640), '127.0.0.1', () => console.log('existing MCP on', process.env.PORT ?? 18640))
