export const CACHE_CONTROL = 'max-age=300'
const GUIDANCE = 'Call a tool: POST its path with the arguments as a JSON object. A tool that is not free answers 402 with what to send when it is called without it. A call that fails is not charged.'
const ON_A_LINE = ' On a line a call uses the time it runs, whether or not it succeeds.'
const MPP_402 = '; the 402 carries an MPP Payment challenge now, in WWW-Authenticate (method evm, intent charge); a refused MPP credential answers 402 with a fresh challenge and a problem'

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

export function paymentInfo(tag, mpp = null) {
  const p = price(tag)
  if (p === null) return null
  const charge = p.mode === 'fixed' && isObject(mpp) && typeof mpp.amount === 'string' && /^(0|[1-9][0-9]*)$/.test(mpp.amount) && text(mpp.currency) && text(mpp.method) && text(mpp.intent) ? mpp : null
  if (charge === null) return { price: p, protocols: [{ x402: {} }] }
  const offer = { amount: charge.amount, currency: charge.currency }
  if (text(charge.description)) offer.description = charge.description
  offer.intent = charge.intent
  offer.method = charge.method
  return { offers: [offer], price: p, protocols: [{ mpp: { method: charge.method, intent: charge.intent, currency: charge.currency } }, { x402: {} }] }
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
        if (info.offers && isObject(op.responses) && isObject(op.responses[402]) && text(op.responses[402].description)) next.responses = { ...op.responses, 402: { ...op.responses[402], description: op.responses[402].description + MPP_402 } }
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
