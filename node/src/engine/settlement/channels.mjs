import { empty } from '../core/hex.mjs'
import { Config } from './config.mjs'
import { ESCROWS } from './x402.mjs'

export class Channels {
  static REFUNDING_TTL_MS = 180000
  static JUDGING_TTL_MS = 30000

  constructor(cfg, store, chain, escrows = ESCROWS) {
    this.cfg = cfg
    this.store = store
    this.chain = chain
    this.escrows = escrows
  }

  static refundingWaitMs(c, now) {
    const until = c === null || c === undefined ? 0 : Math.trunc(Number(c.refundingUntil ?? 0))
    return until > now ? until - now : 0
  }

  static refundingRetrySecs(cfg, c, now) {
    return Channels.retrySecs(cfg, Channels.refundingWaitMs(c, now))
  }

  static retrySecs(cfg, left) {
    const look = Math.max(1, Math.trunc(Number(cfg?.drainWaitMs ?? Config.DRAIN_WAIT_MS)))
    return Math.max(1, Math.ceil(Math.min(left > 0 ? left : look, look) / 1000))
  }

  static GATES = new WeakMap()

  gates() {
    let all = Channels.GATES.get(this.store)
    if (all === undefined) {
      all = new Map()
      Channels.GATES.set(this.store, all)
    }
    return all
  }

  gate(channelId) {
    const id = String(channelId).toLowerCase()
    const all = this.gates()
    let g = all.get(id)
    if (g === undefined) {
      g = { id, tail: Promise.resolve(), queued: 0, seq: 0, order: new Map(), checking: new Map(), arriving: new Map(), held: new Map(), judge: null, reading: null, lastRead: null, wakes: new Set() }
      all.set(id, g)
    }
    return g
  }

  idle(g) {
    if (g.queued === 0 && g.order.size === 0 && g.checking.size === 0 && g.arriving.size === 0 && g.held.size === 0 && g.judge === null && g.reading === null && g.wakes.size === 0 && this.gates().get(g.id) === g) this.gates().delete(g.id)
  }

  async serial(channelId, fn) {
    const g = this.gate(channelId)
    g.queued += 1
    const before = g.tail
    let done
    const mine = new Promise((r) => { done = r })
    g.tail = before.then(() => mine)
    await before
    try {
      return await fn(g)
    } finally {
      g.queued -= 1
      done()
      this.idle(g)
    }
  }

  static live(entries, now) {
    for (const [k, until] of entries) if (until <= now) entries.delete(k)
    return entries.size
  }

  static TURN_KEPT_MS = 600000
  static TURNS = new WeakMap()

  turn(g, now) {
    let all = Channels.TURNS.get(this.store)
    if (all === undefined) {
      all = new Map()
      Channels.TURNS.set(this.store, all)
    }
    const last = all.get(g.id)
    g.seq = Math.max(g.seq, last !== undefined && now - last.at < Channels.TURN_KEPT_MS ? last.turn : 0) + 1
    all.delete(g.id)
    all.set(g.id, { turn: g.seq, at: now })
    for (const [k, v] of all) {
      if (now - v.at < Channels.TURN_KEPT_MS) break
      all.delete(k)
    }
    return g.seq
  }

  ticket(channelId, holder, now) {
    const g = this.gate(channelId)
    const turn = this.turn(g, now)
    g.order.set(holder, turn)
    g.checking.set(holder, now + Channels.JUDGING_TTL_MS)
    return turn
  }

  static before(g, holder, now) {
    const mine = g.order.get(holder) ?? Infinity
    const earlier = (entries) => {
      Channels.live(entries, now)
      for (const k of entries.keys()) if (k !== holder && (g.order.get(k) ?? Infinity) < mine) return true
      return false
    }
    return { ahead: earlier(g.checking) || earlier(g.arriving), mine }
  }

  static earlier(g, holder, entries, now) {
    const mine = g.order.get(holder) ?? Infinity
    Channels.live(entries, now)
    let count = 0
    for (const k of entries.keys()) if (k !== holder && (g.order.get(k) ?? Infinity) < mine) count += 1
    return count
  }

  static ahead(g, holder, now) {
    return Channels.before(g, holder, now).ahead || Channels.place(g, holder, now) > 0
  }

  static place(g, holder, now) {
    const mine = g.order.get(holder) ?? Infinity
    Channels.live(g.held, now)
    let place = 0
    for (const k of g.held.keys()) if (k !== holder && (g.order.get(k) ?? Infinity) < mine) place += 1
    return place
  }

  static judgeOf(g, now) {
    if (g.judge !== null && g.judge.until <= now) g.judge = null
    return g.judge
  }

  static arriving(g, now) {
    return Channels.live(g.arriving, now) > 0
  }

  static holding(g, now) {
    return Channels.live(g.held, now) > 0
  }

  static asked(g, now) {
    return Channels.arriving(g, now) || Channels.holding(g, now)
  }

  waiter(g) {
    let wake
    const woken = new Promise((r) => { wake = r })
    g.wakes.add(wake)
    return { g, woken, wake }
  }

  wake(g) {
    const all = [...g.wakes]
    g.wakes.clear()
    for (const w of all) w()
  }

  async waited(w, deadline) {
    const left = Math.min(deadline - this.cfg.nowMs(), 2147483647)
    if (left > 0) {
      let timer = null
      const lapse = this.cfg.sleeper ? this.cfg.sleepMs(left) : new Promise((r) => { timer = setTimeout(r, left) })
      await Promise.race([w.woken, lapse])
      if (timer !== null) clearTimeout(timer)
    }
    w.g.wakes.delete(w.wake)
    this.idle(w.g)
  }

  judgeWaitMs() {
    return Math.max(0, Math.trunc(Number(this.cfg?.refundJudgeWaitMs ?? 5000)))
  }

  async untilAnswered(channelId, deadline, decide) {
    for (;;) {
      const out = await this.serial(channelId, async (g) => {
        const now = this.cfg.nowMs()
        const r = await this.get(channelId)
        if (Channels.refundingWaitMs(r, now) > 0) return { settling: Channels.refundingRetrySecs(this.cfg, r, now), r }
        const asked = Channels.asked(g, now)
        if (asked && Channels.arriving(g, now) && now < deadline) return { wait: this.waiter(g) }
        return decide(g, r, now, asked)
      })
      if (out?.wait === undefined) return out
      await this.waited(out.wait, deadline)
    }
  }

  async release(channelId, pendingId = null) {
    let had = false
    try {
      await this.serial(channelId, () => this.update(channelId, (c) => {
        if (c === null || c.pendingRequest === undefined || c.pendingRequest === null) return c
        if (pendingId !== null && (c.pendingRequest.pendingId === undefined || c.pendingRequest.pendingId !== pendingId)) return c
        had = true
        delete c.pendingRequest
        return c
      }))
    } catch {
      return false
    }
    return had
  }

  static n(value) {
    if (typeof value === 'bigint') return value
    if (value === null || value === undefined || value === '') return 0n
    if (typeof value === 'number') return BigInt(Math.trunc(value))
    const s = String(value)
    if (!/^-?\d+$/.test(s)) throw new TypeError(`not a decimal integer: ${s.slice(0, 40)}`)
    return BigInt(s)
  }

  static max(a, b) {
    return Channels.n(a) >= Channels.n(b) ? Channels.n(a) : Channels.n(b)
  }

  get(channelId) {
    return this.store.get(String(channelId).toLowerCase())
  }

  update(channelId, fn) {
    return this.store.update(String(channelId).toLowerCase(), fn)
  }

  async repaired(channelId) {
    const channel = await this.get(channelId)
    if (channel === null) return null
    const escrow = this.escrows.of(channel)
    const now = this.cfg.nowMs()
    const last = channel.repairedAt !== undefined ? Math.trunc(Number(channel.repairedAt)) : 0
    if (empty(channel.handedOver) && now - last < this.cfg.repairEveryMs) return channel
    let st
    try {
      st = await this.chain.channel(channelId, escrow)
    } catch {
      return channel
    }
    let nonce = null
    if (!empty(channel.handedOver)) {
      try {
        nonce = await this.chain.refundNonce(channelId, escrow)
      } catch {
        nonce = null
      }
    }
    return this.update(channelId, (c) => {
      if (c === null) return null
      c.repairedAt = now
      if (!empty(c.handedOver)) {
        if (nonce !== null && String(nonce) !== String(c.handedOver.nonce)) {
          delete c.handedOver
          c.balance = st.balance
        }
      } else if (c.balance !== undefined && c.balance !== null && Channels.n(st.balance) < Channels.n(c.balance)) {
        c.balance = st.balance
      } else if (c.balance !== undefined && c.balance !== null && Channels.n(st.balance) > Channels.n(c.balance) && String(c.balance) === String(channel.balance) && Channels.refundingWaitMs(c, now) === 0) {
        c.balance = st.balance
      }
      const charged = Channels.n(c.chargedCumulativeAmount ?? '0')
      if (Channels.n(st.totalClaimed) > charged) {
        c.chargedCumulativeAmount = st.totalClaimed
        c.totalClaimed = st.totalClaimed
      }
      return c
    })
  }

  async leaving(channel) {
    const id = channel.channelId
    const stamped = channel.withdrawRequestedAt !== undefined && channel.withdrawRequestedAt !== null && Math.trunc(Number(channel.withdrawRequestedAt)) > 0
    const escrow = this.escrows.of(channel)
    let w
    try {
      w = await this.chain.pendingWithdrawal(id, escrow)
    } catch {
      return stamped
    }
    const leaving = Channels.n(w.amount) > 0n
    if (leaving !== stamped) {
      const now = this.cfg.nowMs()
      await this.update(id, (c) => {
        if (c === null) return null
        c.withdrawRequestedAt = leaving ? now : 0
        return c
      })
    }
    return leaving
  }

  static pendingLive(channel, now = 0) {
    return channel !== null && channel !== undefined && channel.pendingRequest?.expiresAt !== undefined && channel.pendingRequest.expiresAt !== null && Math.trunc(Number(channel.pendingRequest.expiresAt)) > now
  }

  static claimable(c, escrow = ESCROWS.default) {
    if (empty(c.signature) || empty(c.signedMaxClaimable)) return false
    let charged, signed, claimed, balance
    try {
      charged = Channels.n(c.chargedCumulativeAmount ?? '0')
      signed = Channels.n(c.signedMaxClaimable)
      claimed = Channels.n(c.totalClaimed ?? '0')
      balance = Channels.n(c.balance ?? '0')
    } catch {
      return false
    }
    if (charged <= 0n || charged <= claimed || charged > signed || charged > balance) return false
    if (escrow.settles === 'exact' && charged !== signed) return false
    return charged - claimed <= balance - claimed
  }

  static tokenOf(c, escrow = ESCROWS.default) {
    const config = c?.channelConfig
    return config === undefined || config === null ? undefined : escrow.token(config)
  }

  static async earned(cfg, c, escrow = ESCROWS.default) {
    if (!cfg?.meter || !c?.channelId || !Channels.tokenOf(c, escrow)) return c
    const micro = await cfg.meter.unburnedMicro(c.channelId)
    const asset = micro > 0 ? cfg.assetOf(Channels.tokenOf(c, escrow)) : null
    if (asset === null) return c
    const charged = Channels.n(c.chargedCumulativeAmount ?? '0')
    const claimed = Channels.n(c.totalClaimed ?? '0')
    let net = charged - BigInt(cfg.unitsOfMicroUSD(asset, micro))
    if (net < claimed) net = claimed
    return net >= charged ? c : { ...c, chargedCumulativeAmount: net.toString() }
  }

  static refundable(c, live) {
    const charged = Channels.n(c.chargedCumulativeAmount ?? '0')
    const left = Channels.n(live.balance) - Channels.max(charged, live.claimed)
    return left > 0n ? left.toString() : '0'
  }
}
