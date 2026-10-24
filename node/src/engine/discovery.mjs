export const CACHE_CONTROL = 'max-age=300'
const GUIDANCE = 'Call a tool: POST its path with the arguments as a JSON object. A tool that is not free answers 402 with what to send when it is called without it. A call that fails is not charged.'
const ON_A_LINE = ' On a line a call uses the time it runs, whether or not it succeeds.'
export const FAILED_CALL = `A failed call is not charged.${ON_A_LINE}`
export const percent = (share) => (Number(share) * 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
export const refundRule = (cover, pay = cover) => `Our relay pays the gas of a refund when our fee on what the buyer spent covers the gas of the deposit, of the refund and of settling any calls not yet settled, and of every further deposit and every earlier refund it paid for on that channel, with a ${cover}% margin; otherwise the buyer pays the refund's gas, with a ${pay}% margin, in USDC, quoted before the buyer signs that payment.`
const mpp402 = (offers) => `; the 402 carries ${offers.length === 1 ? 'an MPP Payment challenge' : 'MPP Payment challenges'} now, in WWW-Authenticate (${offers.map((o) => `method ${o.method}, intent ${o.intent}`).join('; ')}); a refused MPP credential answers ${offers.every((o) => o.intent === 'charge') ? '402 ' : ''}with a fresh challenge and a problem`

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v) => typeof v === 'string' && v !== ''

export function price(tag) {
  if (!isObject(tag) || tag.free === true) return null
  if (tag.varies === true) return { mode: 'dynamic', currency: 'USD' }
  if (tag.per === 'unit') return text(tag.upTo) ? { mode: 'dynamic', currency: 'USD', min: '0', max: tag.upTo } : null
  if (tag.per === 'ms') return text(tag.usd) ? { mode: 'dynamic', currency: 'USD', min: tag.usd } : null
  const amount = tag.per === 'time' ? tag.callUSD : tag.usd
  return text(amount) ? { mode: 'fixed', currency: 'USD', amount } : null
}

const offered = (mpp) => isObject(mpp) && typeof mpp.amount === 'string' && /^(0|[1-9][0-9]*)$/.test(mpp.amount) && text(mpp.currency) && text(mpp.method) && text(mpp.intent)

export function paymentInfo(tag, mpp = null) {
  const p = price(tag)
  if (p === null) return null
  const given = p.mode === 'fixed' ? (Array.isArray(mpp) ? mpp : [mpp]).filter(offered) : []
  if (!given.length) return { price: p, protocols: [{ x402: {} }] }
  const offers = given.map((m) => ({ amount: m.amount, currency: m.currency, ...(text(m.description) ? { description: m.description } : {}), intent: m.intent, method: m.method }))
  return { offers, price: p, protocols: [...given.map((m) => ({ mpp: { method: m.method, intent: m.intent, currency: m.currency } })), { x402: {} }] }
}

export function discovery(doc, offers = {}, { homepage = null, origin = null, mount = '' } = {}) {
  const paths = {}
  let timed = false
  for (const [path, item] of Object.entries(isObject(doc.paths) ? doc.paths : {})) {
    const out = {}
    for (const [method, op] of Object.entries(isObject(item) ? item : {})) {
      if (!isObject(op)) { out[method] = op; continue }
      const tag = op['x-price']
      if (isObject(tag) && (tag.per === 'time' || tag.per === 'ms')) timed = true
      const info = paymentInfo(tag, isObject(offers) && Object.hasOwn(offers, op.operationId) ? offers[op.operationId] : null)
      const next = { ...op }
      if (isObject(tag)) next.security = []
      if (info !== null) {
        next['x-payment-info'] = info
        if (info.offers && isObject(op.responses) && isObject(op.responses[402]) && text(op.responses[402].description)) next.responses = { ...op.responses, 402: { ...op.responses[402], description: op.responses[402].description + mpp402(info.offers) } }
      }
      out[method] = next
    }
    paths[origin === null ? path : mount + path] = out
  }
  const info = { ...doc.info, 'x-guidance': `${doc.info.description}. ${GUIDANCE}${timed ? ON_A_LINE : ''}` }
  const out = { ...doc, info }
  if (text(homepage)) out['x-service-info'] = { docs: { homepage } }
  if (origin !== null) out.servers = [{ url: origin }]
  out.paths = paths
  return out
}
