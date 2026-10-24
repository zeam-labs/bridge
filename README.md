# ZEAM :: Bridge

Let agents into your service. Charge per call, admit listed keys, or both, over MCP and HTTP on Base. x402 clients pay for every tool, and MPP clients for a tool priced per call whose fee covers the gas of its transfer.
No sign-up and no API key for the agent.

- `node/`: `@zeambridge/bridge` on npm (Node 18+)
- `python/`: `zeambridge` on PyPI (Python 3.9+)
- `wordpress/`: the WordPress plugin; its `lib/src/` is the reference engine
- `docs/SELL.md`: selling with ZEAM :: Bridge
- `docs/AGENTS.md`: paying a ZEAM :: Bridge seller as an agent: with a pass, with the Pass client, or with any x402 or MPP client
- `docs/ENGINE.md`: the engine and its constants

Formerly ZEAM :: Pass: `@zeam-labs/pass` and `zeam-pass` keep working and point here. ZEAM :: Pass is now the buyer side: https://zeampass.com/

The seller keeps 90.01% of every sale; 9.99% goes to ZEAM. A gate's first 10,000 checks a month are free.

## Install and a minimal example

ZEAM :: Bridge is a plugin for Node.js, Python and WordPress: a paywall, a gate or both in front of your API or MCP server.
Each example below serves one paid tool at `/agents/mcp` (MCP) and `POST /agents/v1/<tool>` (HTTP). A call with no
payment answers 402 with the price.

Replace `0xYourWalletAddress` before you run one: `payout` is a wallet address on Base that you control, and your
earnings are paid to it. The plugin refuses a placeholder.

### Node, with Express

    npm install @zeambridge/bridge express

```js
import express from 'express'
import { bridge } from '@zeambridge/bridge'

const agents = bridge({
  name: 'acme',
  site: 'https://acme.example',
  mode: 'paywall',
  price: '0.02',
  payout: '0xYourWalletAddress',
})
agents.tool({
  name: 'add',
  description: 'Adds two numbers.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  run: async ({ a, b }) => ({ sum: a + b }),
})

const app = express()
app.use(agents.express('/agents'))
app.listen(3000)
```

Save it as `app.mjs` and run `node app.mjs`. Options, prices per tool, the gate and fetch hosts:
[node/README.md](node/README.md)

### Python, with FastAPI

    pip install zeambridge fastapi uvicorn

```python
from fastapi import FastAPI
from zeam_bridge import Bridge

agents = Bridge(name="acme", payout="0xYourWalletAddress", price="0.01")

@agents.tool(description="Multiplies two numbers.", input_schema={"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]})
def multiply(a, b):
    return {"product": a * b}

app = FastAPI()
app.mount("/agents", agents.asgi())
```

Save it as `app.py` and run `uvicorn app:app --port 3000`. Flask, Django and the options:
[python/README.md](python/README.md)

### WordPress

No code. Download the plugin zip from https://zeambridge.com/install#wordpress-h and use Plugins → Add New →
Upload Plugin. Before you activate, add `define('ZEAM_BRIDGE_KEY', '…');` (32 or more random characters) to
`wp-config.php` and keep it. Activate, connect your payout wallet on the plugin's settings page, and choose gate,
paywall or both. Agents get two tools over your posts, `search_posts` and `read_post`. The steps in full:
[wordpress/zeam-pass/readme.txt](wordpress/zeam-pass/readme.txt)

Site: https://zeambridge.com · Agents: https://zeampass.com/docs/agents · Selling: https://zeambridge.com/docs/sell

This repository is the published source of each release. Issues are welcome; changes are made upstream.

License: Apache-2.0, except the WordPress plugin in `wordpress/zeam-pass/`, which is GPL-2.0-only. Patent pending. Contact: info@zeamlabs.com
