import { createHash, randomBytes } from 'node:crypto'
import { ChannelFileStore } from './stores.mjs'
import { Secp256k1 } from './core/secp256k1.mjs'
import { ESCROWS } from './settlement/x402.mjs'
import { MAX_MICRO, MAX_USD, microOf, mulDiv, usd } from './pricing.mjs'

const NONCE_SECS = 300
const KEEP_CREDITED = 64
const KEEP_NONCES = 8

export const Clock = {
  HOLD_MS: 2000,
  KEEP_DONE: 512,
  MAX_LIVE_CALLS: 1000,
  ALIVE_MS: 1000,
  DEAD_MS: 30000,

  fresh(channelId) {
    return { channelId: String(channelId).toLowerCase(), balanceMs: 0, spentMs: 0, returnedMs: 0, on: false, since: null, lastActive: null, calls: {}, done: [], credited: [], nonces: {}, lines: [] }
  },

  merged(intervals) {
    const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const out = []
    for (const [s, e] of sorted) {
      const last = out[out.length - 1]
      if (last && s <= last[1]) last[1] = Math.max(last[1], e)
      else out.push([s, e])
    }
    return out
  },

  covered(intervals) {
    return Clock.merged(intervals).reduce((total, [s, e]) => total + (e - s), 0)
  },

  spans(rec, from, to, idleMs = 0) {
    const out = (rec.done ?? []).map(([s, e]) => [Math.max(s, from), Math.min(e, to)])
    for (const c of Object.values(rec.calls)) out.push([Math.max(c.start, from), Math.min(to, c.deadline)])
    if (rec.on && idleMs > 0 && rec.lastActive !== null) out.push([Math.max(rec.lastActive, from), Math.min(to, rec.lastActive + idleMs)])
    return out
  },

  settle(rec, now, idleMs = 0) {
    const r = rec
    r.done = r.done ?? []
    if (r.since === null) {
      r.since = now
      for (const [id, c] of Object.entries(r.calls)) if (c.deadline <= now) delete r.calls[id]
      return r
    }
    for (const [id, c] of Object.entries(r.calls)) {
      if (c.deadline > now) continue
      r.done.push([c.start, c.deadline])
      delete r.calls[id]
    }
    r.done = Clock.merged(r.done)
    let horizon = Math.max(r.since, now - Clock.HOLD_MS)
    if (r.done.length > Clock.KEEP_DONE) horizon = Math.max(horizon, Math.min(now, r.done[r.done.length - Clock.KEEP_DONE - 1][1]))
    const burned = Math.min(r.balanceMs, Clock.covered(Clock.spans(r, r.since, horizon, idleMs)))
    r.balanceMs -= burned
    r.spentMs += burned
    r.since = horizon
    r.done = r.done.filter(([, e]) => e > horizon).map(([s, e]) => [Math.max(s, horizon), e])
    return r
  },

  pending(rec, now, idleMs = 0) {
    return Math.min(rec.balanceMs, Clock.covered(Clock.spans(rec, rec.since ?? now, now, idleMs)))
  },

  left(rec, now, idleMs = 0) {
    return rec.balanceMs - Clock.pending(rec, now, idleMs)
  },

  remaining(rec, now, idleMs = 0) {
    return Clock.left(Clock.settle(structuredClone(rec), now, idleMs), now, idleMs)
  },

  spent(rec, now, idleMs = 0) {
    const r = Clock.settle(structuredClone(rec), now, idleMs)
    return r.spentMs + Clock.pending(r, now, idleMs)
  },

  active(rec, at, idleMs = 0) {
    if (rec.on && idleMs > 0 && rec.lastActive !== null && at > rec.lastActive) rec.done.push([rec.lastActive, Math.min(at, rec.lastActive + idleMs)])
    rec.lastActive = Math.max(rec.lastActive ?? at, at)
  },

  switch(rec, on, now, idleMs = 0) {
    Clock.settle(rec, now, idleMs)
    Clock.active(rec, now, idleMs)
    rec.on = on
    return rec
  },

  begin(rec, id, now, idleMs = 0, cap = null) {
    Clock.settle(rec, now, idleMs)
    if (!rec.on) return { ok: false, code: 'meter_off' }
    const left = Clock.left(rec, now, idleMs)
    if (left <= 0) return { ok: false, code: 'out_of_time' }
    if (cap !== null && Object.keys(rec.calls).length >= cap) return { ok: false, code: 'too_many_calls' }
    Clock.active(rec, now, idleMs)
    const deadline = now + left
    rec.calls[id] = { start: now, deadline }
    return { ok: true, deadline }
  },

  end(rec, id, now, idleMs = 0, start = null, stop = null) {
    rec.done = rec.done ?? []
    const c = rec.calls[id] ?? null
    const ran = Math.min(stop ?? now, now)
    let from = c === null ? ran : c.start
    if (c !== null) {
      if (start !== null && start > c.start && ran <= c.deadline) from = Math.min(start, ran)
      rec.done.push([from, Math.min(ran, c.deadline)])
      delete rec.calls[id]
    }
    Clock.active(rec, ran, idleMs)
    Clock.settle(rec, now, idleMs)
    return { elapsedMs: c === null ? 0 : ran - from, over: c === null || ran > c.deadline }
  },

  renew(rec, id, now, idleMs = 0, start = null, last = null) {
    rec.done = rec.done ?? []
    const c = rec.calls[id] ?? null
    const due = c === null ? last : c.deadline
    if (c !== null) rec.done.push([start !== null && start > c.start ? start : c.start, Math.min(now, c.deadline)])
    delete rec.calls[id]
    const covers = due === null || due >= now || rec.since === null ? now : Math.min(now, due + Math.max(0, Clock.left(rec, now, idleMs)))
    if (due !== null && covers > due) rec.done.push([due, covers])
    Clock.settle(rec, now, idleMs)
    const left = Clock.left(rec, now, idleMs)
    if (covers < now || left <= 0) return { ok: false, code: 'out_of_time' }
    const deadline = now + left
    rec.calls[id] = { start: now, deadline }
    return { ok: true, deadline }
  },

  buy(rec, ms, key, now, idleMs = 0) {
    if (rec.credited.includes(key)) return false
    Clock.settle(rec, now, idleMs)
    rec.balanceMs += ms
    rec.credited = [...rec.credited, key].slice(-KEEP_CREDITED)
    return true
  },

  owe(rec, owed, now, idleMs = 0) {
    for (const [key, ms] of Object.entries(owed ?? {})) if (Number.isSafeInteger(ms) && ms > 0) Clock.buy(rec, ms, key, now, idleMs)
    return rec
  },

  unbuy(rec, ms, key, now, idleMs = 0) {
    if (!rec.credited.includes(key)) return 0
    Clock.settle(rec, now, idleMs)
    const taken = Math.max(0, Math.min(ms, Clock.left(rec, now, idleMs)))
    rec.balanceMs -= taken
    rec.credited = rec.credited.filter((k) => k !== key)
    return taken
  },

  unburnedMicro(rec, now, idleMs, rateMicro, rateMs) {
    const left = Clock.remaining(rec, now, idleMs)
    return mulDiv(left, rateMicro, rateMs, rateMs - 1)
  },

  forget(rec, now, idleMs = 0) {
    Clock.settle(rec, now, idleMs)
    const burning = Clock.pending(rec, now, idleMs)
    const returned = rec.balanceMs - burning
    rec.spentMs += burning
    rec.returnedMs += returned
    rec.balanceMs = 0
    rec.on = false
    rec.calls = {}
    rec.done = []
    rec.since = now
    return returned
  },

  lineMessage(channelId, nonce) {
    return `ZEAM Pass line\nchannel: ${String(channelId).toLowerCase()}\nnonce: ${nonce}`
  },
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))

export function timeOptions(o) {
  if (o === undefined || o === null || o === false) return null
  if (typeof o !== 'object') throw new TypeError('bridge: time is { usd: "0.00025", ms: 250 }: that many dollars buys that many milliseconds')
  const micro = microOf(o.usd ?? o.block, 'time.usd')
  const given = o.ms ?? o.blockMs
  const ms = given === undefined ? 250 : Math.trunc(Number(given))
  const idleMs = o.idleMs === undefined ? 0 : Math.trunc(Number(o.idleMs))
  const maxCalls = o.maxCalls === undefined || o.maxCalls === null ? Clock.MAX_LIVE_CALLS : Math.trunc(Number(o.maxCalls))
  if (!(ms >= 1 && ms <= 3600000)) throw new TypeError('bridge: time.ms is 1 to 3600000')
  if (!(idleMs >= 0 && idleMs <= 3600000)) throw new TypeError('bridge: time.idleMs is 0 to 3600000')
  if (!(maxCalls >= 1 && maxCalls <= 1000)) throw new TypeError('bridge: time.maxCalls is 1 to 1000')
  const legacyCap = o.maxBlocks === undefined || o.maxBlocks === null ? undefined : Number(o.maxBlocks) * ms
  const cap = o.maxMs ?? legacyCap
  const maxMs = cap === undefined || cap === null ? null : Math.trunc(Number(cap))
  const g = gcd(micro, ms)
  const rateMicro = micro / g
  const rateMs = ms / g
  if (maxMs !== null && !(maxMs >= rateMs && maxMs % rateMs === 0)) throw new TypeError(`bridge: time.maxMs is a multiple of ${rateMs} ms, the smallest amount this price sells; leave it out for no maximum`)
  return { rateMicro, rateMs, unitMs: ms, idleMs, maxMs, maxCalls }
}

export const timeRate = (t) => `$${usd(t.rateMicro)} per ${t.rateMs === 1 ? 'ms' : `${t.rateMs} ms`}`

export function boughtMs(t, args) {
  if (Number.isSafeInteger(args?.ms)) return args.ms
  if (Number.isSafeInteger(args?.blocks) && args.blocks >= 1) return args.blocks * t.unitMs
  return t.unitMs
}

export function timeMicro(t, ms) {
  const micro = (ms / t.rateMs) * t.rateMicro
  if (!(micro <= MAX_MICRO)) throw new TypeError(`bridge: that much line time costs more than $${MAX_USD}; above that a number stops counting micro-USD exactly. Buy less at a time`)
  return micro
}

export function timeText(t, base = '') {
  const idle = t.idleMs > 0 ? ` and ${t.idleMs} ms after each` : ''
  const step = t.rateMs > 1 ? ` in steps of ${t.rateMs} ms` : ''
  const most = t.maxMs ? ` (up to ${t.maxMs} ms a purchase)` : ''
  return `Line time: ${timeRate(t)}. buy_time {"ms": N}${step}${most}; buying again adds time; the time is credited to the paying channel once the payment settles. Open a line: POST ${base}/line {"op":"open","channelId":"0x…"}, sign the message it returns with the payer key, POST {"op":"prove","channelId":"0x…","nonce":"…","signature":"0x…"}. Send the credential as x-line (MCP: _meta["zeam-pass/line"]). Time burns while a call runs on the line${idle}; a call stops when the time runs out. {"op":"off"}: no new calls on any line of the channel; a running call burns to its end. Unburned time comes back with a refund.`
}

export class TimeMeter {
  constructor(dir, t, { now = () => Date.now(), clocks = null, lines = null, alive = null, owed = null } = {}) {
    this.t = t
    this.owed = owed
    this.now = now
    this.clocks = clocks ?? new ChannelFileStore(`${dir}/clocks`)
    this.lines = lines ?? new ChannelFileStore(`${dir}/lines`)
    this.alive = alive ?? new ChannelFileStore(`${dir}/alive`)
    this.boot = '0x' + randomBytes(32).toString('hex')
    this.pulsed = null
    this.pulsing = null
    this.marks = new Map()
    this.starts = new Map()
    this.stops = new Map()
    this.opening = new Set()
  }

  async pulse() {
    const now = this.now()
    if (this.pulsed !== null && now >= this.pulsed && now - this.pulsed < Clock.ALIVE_MS) return
    this.pulsed = now
    await this.alive.update(this.boot, () => ({ channelId: this.boot, at: now }))
  }

  keepAlive() {
    if (this.pulsing !== null) return
    this.pulsing = setInterval(() => {
      if (this.starts.size === 0) {
        clearInterval(this.pulsing)
        this.pulsing = null
        return
      }
      this.pulse().catch(() => {})
    }, Clock.ALIVE_MS)
    this.pulsing.unref?.()
  }

  async lastAlive(boot, now) {
    const hit = this.marks.get(boot)
    if (hit !== undefined && now >= hit.read && now - hit.read < Clock.ALIVE_MS) return hit.at
    const mark = await this.alive.get(boot).catch(() => null)
    const at = Number.isFinite(mark?.at) ? mark.at : 0
    this.marks.set(boot, { at, read: now })
    return at
  }

  async reap(rec, now) {
    for (const [id, c] of Object.entries(rec.calls ?? {})) {
      if (typeof c.by !== 'string' || c.by === this.boot) continue
      const at = await this.lastAlive(c.by, now)
      if (now - at <= Clock.DEAD_MS) continue
      const ran = Math.max(at, c.start)
      rec.done = rec.done ?? []
      rec.done.push([c.start, Math.min(ran, c.deadline)])
      delete rec.calls[id]
      Clock.active(rec, ran, this.t.idleMs)
    }
    return rec
  }

  seen() {
    return { starts: new Map(this.starts), stops: new Map(this.stops), opening: new Set(this.opening) }
  }

  running(rec, now, seen = this.seen()) {
    for (const [id, c] of Object.entries(rec.calls ?? {})) {
      const key = `${rec.channelId}:${id}`
      const started = seen.starts.get(key) ?? (seen.opening.has(key) ? now : undefined)
      const stopped = seen.stops.get(key)
      const ran = stopped === undefined ? now : Math.min(stopped, now)
      if (ran > c.deadline) continue
      if (started !== undefined && started > c.start) c.start = Math.min(started, ran)
      if (stopped !== undefined) c.deadline = Math.max(c.start, ran)
    }
    return rec
  }

  stopped(channelId, id, at) {
    const key = `${String(channelId).toLowerCase()}:${id}`
    if (!this.stops.has(key)) this.stops.set(key, at)
  }

  static hash(credential) {
    return '0x' + createHash('sha256').update(String(credential)).digest('hex')
  }

  callMs(priceMicro) {
    return Math.min(mulDiv(priceMicro, this.t.rateMs, this.t.rateMicro), Number.MAX_SAFE_INTEGER)
  }

  async owing(channelId) {
    if (this.owed === null) return null
    const o = await this.owed.read(channelId)
    return o !== null && typeof o === 'object' && Object.keys(o).length > 0 ? o : null
  }

  async change(channelId, fn) {
    const owed = await this.owing(channelId)
    let out
    await this.clocks.update(channelId, async (current) => {
      const rec = await this.reap(current ?? Clock.fresh(channelId), this.now())
      if (owed !== null) Clock.owe(rec, owed, this.now(), this.t.idleMs)
      out = fn(rec)
      return rec
    })
    if (owed !== null) await Promise.resolve(this.owed.paid(channelId, Object.keys(owed))).catch(() => {})
    return out
  }

  async status(channelId) {
    const owed = await this.owing(channelId)
    const now = this.now()
    const seen = this.seen()
    const stored = (await this.clocks.get(channelId)) ?? Clock.fresh(channelId)
    const rec = this.running(await this.reap(structuredClone(stored), now), now, seen)
    if (owed !== null) Clock.owe(rec, owed, now, this.t.idleMs)
    return { channelId: rec.channelId, msRemaining: Clock.remaining(rec, now, this.t.idleMs), msSpent: Clock.spent(rec, now, this.t.idleMs), msReturned: rec.returnedMs, metering: rec.on, rateUSD: usd(this.t.rateMicro), rateMs: this.t.rateMs }
  }

  credit(channelId, ms, key) {
    return this.change(channelId, (rec) => Clock.buy(rec, ms, String(key), this.now(), this.t.idleMs))
  }

  uncredit(channelId, ms, key) {
    return this.change(channelId, (rec) => Clock.unbuy(rec, ms, String(key), this.now(), this.t.idleMs))
  }

  switch(channelId, on) {
    return this.change(channelId, (rec) => { const now = this.now(); Clock.switch(rec, on, now, this.t.idleMs); return Clock.left(rec, now, this.t.idleMs) })
  }

  async begin(channelId, id) {
    await this.pulse()
    const key = `${String(channelId).toLowerCase()}:${id}`
    this.opening.add(key)
    let b
    try {
      b = await this.change(channelId, (rec) => {
        const r = Clock.begin(rec, id, this.now(), this.t.idleMs, this.t.maxCalls)
        if (r.ok) rec.calls[id].by = this.boot
        return r
      })
    } finally {
      this.opening.delete(key)
    }
    if (!b.ok) return b
    const started = this.now()
    this.starts.set(key, started)
    this.keepAlive()
    return { ...b, started }
  }

  async end(channelId, id, started = null, stopped = null) {
    if (stopped !== null) this.stopped(channelId, id, stopped)
    try {
      return await this.change(channelId, (rec) => {
        const now = this.now()
        const seen = this.seen()
        const out = Clock.end(rec, id, now, this.t.idleMs, started, stopped)
        return { ...out, msRemaining: Clock.left(this.running(structuredClone(rec), now, seen), now, this.t.idleMs) }
      })
    } finally {
      this.starts.delete(`${String(channelId).toLowerCase()}:${id}`)
      this.stops.delete(`${String(channelId).toLowerCase()}:${id}`)
    }
  }

  renew(channelId, id, last = null) {
    const started = this.starts.get(`${String(channelId).toLowerCase()}:${id}`) ?? null
    return this.change(channelId, (rec) => {
      const r = Clock.renew(rec, id, this.now(), this.t.idleMs, started, last)
      if (r.ok) rec.calls[id].by = this.boot
      return r
    })
  }

  stop(channelId) {
    return this.change(channelId, (rec) => {
      Clock.settle(rec, this.now(), this.t.idleMs)
      if (Object.keys(rec.calls).length > 0) return false
      Clock.switch(rec, false, this.now(), this.t.idleMs)
      return true
    })
  }

  async busy(channelId) {
    const now = this.now()
    const stored = await this.clocks.get(channelId)
    const rec = stored === null ? null : await this.reap(stored, now)
    return rec !== null && Object.values(rec.calls ?? {}).some((c) => c.deadline > now)
  }

  async unburnedMicro(channelId) {
    const owed = await this.owing(channelId)
    const stored = await this.clocks.get(channelId)
    if (stored === null && owed === null) return 0
    const rec = await this.reap(stored ?? Clock.fresh(channelId), this.now())
    if (owed !== null) Clock.owe(rec, owed, this.now(), this.t.idleMs)
    return Clock.unburnedMicro(rec, this.now(), this.t.idleMs, this.t.rateMicro, this.t.rateMs)
  }

  async forget(channelId) {
    let lines = []
    const returned = await this.change(channelId, (rec) => {
      lines = rec.lines
      rec.lines = []
      return Clock.forget(rec, this.now(), this.t.idleMs)
    })
    for (const h of lines) await this.lines.update(h, () => null).catch(() => {})
    return returned
  }

  challenge(channelId) {
    const nonce = randomBytes(16).toString('hex')
    const now = this.now()
    return this.change(channelId, (rec) => {
      const live = Object.entries(rec.nonces).filter(([, until]) => until > now).slice(-(KEEP_NONCES - 1))
      rec.nonces = Object.fromEntries([...live, [nonce, now + NONCE_SECS * 1000]])
      return { nonce, message: Clock.lineMessage(channelId, nonce), expiresInSeconds: NONCE_SECS }
    })
  }

  async prove(channel, nonce, signature, owners = null, gate = null) {
    if (nonce === undefined || nonce === null || nonce === '') return { ok: false, status: 400, code: 'bad_request', why: 'nonce is missing: send the nonce the open answer gave, with your signature of its message' }
    if (typeof signature !== 'string' || !signature) return { ok: false, status: 400, code: 'bad_request', why: 'signature is missing or is not a string: sign the message the open answer gave and send it with the nonce' }
    const channelId = String(channel.channelId).toLowerCase()
    const now = this.now()
    const live = await this.change(channelId, (rec) => {
      const until = rec.nonces[String(nonce)]
      delete rec.nonces[String(nonce)]
      return until !== undefined && until > now
    })
    if (!live) return { ok: false, status: 400, code: 'no_challenge', why: 'no live challenge with that nonce. Send {"op":"open","channelId":"0x…"} again and sign what it returns.' }
    let who
    try {
      who = (await Secp256k1.recoverPersonal(Clock.lineMessage(channelId, nonce), String(signature ?? ''))).toLowerCase()
    } catch (e) {
      return { ok: false, status: 400, code: 'bad_signature', why: `the signature does not recover: ${String(e?.message ?? e).slice(0, 80)}` }
    }
    if (!(owners ?? ESCROWS.default.owners(channel.channelConfig)).some((a) => who === String(a ?? '').toLowerCase())) return { ok: false, status: 403, code: 'not_the_payer', why: `${who} is not this channel's payer` }
    const credential = randomBytes(32).toString('base64url')
    const h = TimeMeter.hash(credential)
    const attach = (refusal = null) => this.change(channelId, (rec) => {
      if (rec.lines.length === 0) {
        if (refusal !== null) return { refused: refusal }
        Clock.switch(rec, true, this.now(), this.t.idleMs)
      }
      rec.lines = [...rec.lines, h]
      return { msRemaining: Clock.left(rec, this.now(), this.t.idleMs), metering: rec.on }
    })
    const opened = gate === null ? await attach() : await gate(attach)
    if (opened.refused !== undefined) return { ok: false, refused: opened.refused }
    await this.lines.update(h, () => ({ channelId, at: now }))
    return { ok: true, credential, channelId, msRemaining: opened.msRemaining, metering: opened.metering }
  }

  async line(credential) {
    if (typeof credential !== 'string' || credential === '') return null
    const hit = await this.lines.get(TimeMeter.hash(credential))
    return hit?.channelId ?? null
  }

  async close(credential) {
    const h = TimeMeter.hash(credential)
    const hit = await this.lines.get(h)
    if (!hit) return null
    await this.lines.update(h, () => null)
    await this.change(hit.channelId, (rec) => { rec.lines = rec.lines.filter((x) => x !== h) })
    return hit.channelId
  }
}
