const PRICE = /^(\d+)(?:\.(\d{1,6}))?$/
const HOUR_MS = 3600000
export const MAX_MICRO = Number.MAX_SAFE_INTEGER
export const MAX_USD = '9007199254.740991'

export function mulDiv(a, b, c, add = 0) {
  const top = a * b + add
  if (Math.abs(top) <= MAX_MICRO) return Math.floor(top / c)
  return Number((BigInt(Math.trunc(a)) * BigInt(Math.trunc(b)) + BigInt(Math.trunc(add))) / BigInt(Math.trunc(c)))
}

export function microOf(price, what = 'price') {
  const s = typeof price === 'number' ? String(price) : String(price ?? '').trim().replace(/^\$/, '')
  const m = PRICE.exec(s)
  if (!m) throw new TypeError(`bridge: ${what} is USD with up to six decimals, like "0.02"; got ${JSON.stringify(price)}`)
  const micro = BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0'))
  if (micro < 1n || micro > BigInt(MAX_MICRO)) throw new TypeError(`bridge: ${what} is from $0.000001 to $${MAX_USD}; above that a number stops counting micro-USD exactly`)
  return Number(micro)
}

export function usd(micro) {
  const n = Number(micro)
  if (Number.isSafeInteger(n) && n >= 0) {
    const d = String(n).padStart(7, '0')
    return `${d.slice(0, -6)}.${d.slice(-6)}`.replace(/0+$/, '').replace(/\.$/, '')
  }
  const s = (n / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return s === '' ? '0' : s
}

export function priceOf(spec, fallbackMicro = null) {
  if (spec === undefined || spec === null || spec === '') {
    if (!(fallbackMicro >= 1)) throw new TypeError('bridge: this tool has no price; set price, prices[tool] or free')
    return { micro: fallbackMicro, unitMicro: null }
  }
  if (typeof spec === 'object' && !Array.isArray(spec)) {
    const micro = spec.price === undefined || spec.price === null || spec.price === '' ? fallbackMicro : microOf(spec.price)
    if (!(micro >= 1)) throw new TypeError('bridge: this tool has no price; set price, prices[tool] or free')
    if (spec.unit === undefined || spec.unit === null || spec.unit === '') return { micro, unitMicro: null }
    const unitMicro = microOf(spec.unit, 'unit')
    if (unitMicro > micro) throw new TypeError('bridge: a unit costs at most the price the call reserves')
    return { micro, unitMicro }
  }
  return { micro: microOf(spec), unitMicro: null }
}

export function charge(price, units) {
  if (price.unitMicro === null) return price.micro
  if (!Number.isSafeInteger(units) || units < 0) throw new TypeError('bridge: units is a whole number, 0 or more')
  return Math.min(price.micro, units * price.unitMicro)
}

export function describe(price, { free = false, perHour = null, varies = false } = {}) {
  if (free) return perHour ? { usd: '0', per: 'call', free: true, perHour } : { usd: '0', per: 'call', free: true }
  if (varies) return { per: 'call', varies: true }
  if (price.unitMicro !== null) return { usd: usd(price.unitMicro), per: 'unit', upTo: usd(price.micro) }
  return { usd: usd(price.micro), per: 'call' }
}

export function pricing(price) {
  if (price.ms) return `$${usd(price.micro)} for ${price.ms} ms of line time. Time you do not burn comes back with a refund.`
  if (price.unitMicro !== null) return `Up to $${usd(price.micro)} per call, reserved; charged $${usd(price.unitMicro)} per unit the call reports, at most the reserve. A failed call is not charged.`
  return `$${usd(price.micro)} per call. A failed call is not charged.`
}

export class FreeLimit {
  constructor(perHour, now = () => Date.now()) {
    this.perHour = perHour
    this.now = now
    this.counts = new Map()
  }

  static window(now) {
    return Math.floor(now / HOUR_MS)
  }

  static callerKey(who) {
    const s = String(who ?? '')
    if (s === '' || !s.includes(':')) return s
    const z = s.split('%')[0]
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(z)
    if (mapped) return mapped[1]
    const dbl = z.split('::')
    const head = dbl[0] ? dbl[0].split(':') : []
    const tail = dbl.length > 1 && dbl[1] ? dbl[1].split(':') : []
    const fill = Math.max(0, 8 - head.length - tail.length)
    const groups = [...head, ...Array(fill).fill('0'), ...tail].slice(0, 8)
    const norm = groups.map((g) => (g === '' ? '0' : g.toLowerCase().replace(/^0+(?=.)/, '')))
    return norm.slice(0, 4).join(':') + '::/64'
  }

  take(tool, who, perHour = this.perHour) {
    if (!(perHour >= 1)) return { ok: true }
    const now = this.now()
    const w = FreeLimit.window(now)
    const key = `${w}\n${tool}\n${FreeLimit.callerKey(who)}`
    const used = this.counts.get(key) ?? 0
    if (used >= perHour) {
      const retry = Math.max(1, Math.ceil(((w + 1) * HOUR_MS - now) / 1000))
      return { ok: false, retryAfter: retry }
    }
    this.counts.set(key, used + 1)
    if (this.counts.size > 20000) for (const k of this.counts.keys()) if (!k.startsWith(`${w}\n`)) this.counts.delete(k)
    return { ok: true }
  }

  async takeSaved(file, tool, who, perHour = this.perHour) {
    if (!(perHour >= 1)) return { ok: true }
    try {
      let out
      await file.update((cur) => {
        const w = FreeLimit.window(this.now())
        const head = `${w}\n`
        const saved = cur?.window === w && cur.counts !== null && typeof cur.counts === 'object' ? cur.counts : {}
        this.counts = new Map(Object.entries(saved).map(([k, v]) => [head + k, Number(v) || 0]))
        out = this.take(tool, who, perHour)
        return { window: w, counts: Object.fromEntries([...this.counts].filter(([k]) => k.startsWith(head)).map(([k, v]) => [k.slice(head.length), v])) }
      })
      return out
    } catch {
      return this.take(tool, who, perHour)
    }
  }

  static refusal(perHour, retryAfter) {
    return { error: 'free_limit', message: `${perHour} free calls an hour per address. Retry in ${retryAfter}s.`, retry_after_seconds: retryAfter }
  }
}
