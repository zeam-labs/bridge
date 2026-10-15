import { empty } from '../core/hex.mjs'
import { Config } from './config.mjs'
import { ESCROWS } from './x402.mjs'

export class Channels {
  static REFUNDING_TTL_MS = 180000
  static JUDGING_TTL_MS = 30000
  static JUDGING_POLL_MS = 20

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

  static judging(c, now) {
    return c !== null && c !== undefined && c.refundingJudging === true && Channels.refundingWaitMs(c, now) > 0
  }

  static weighed(c, now) {
    const all = c !== null && c !== undefined && c.refundsJudged !== null && typeof c.refundsJudged === 'object' ? c.refundsJudged : {}
    return Object.fromEntries(Object.entries(all).filter(([, until]) => Math.trunc(Number(until)) > now))
  }

  static beingJudged(c, now) {
    return Object.keys(Channels.weighed(c, now)).length > 0
  }

  static judgedRetrySecs(cfg, c, now) {
    const until = Math.max(0, ...Object.values(Channels.weighed(c, now)).map((v) => Math.trunc(Number(v))))
    return Channels.retrySecs(cfg, until > now ? until - now : 0)
  }

  static held(c, now, pending = false) {
    return Channels.judging(c, now) || (pending && Channels.beingJudged(c, now) && Channels.refundingWaitMs(c, now) === 0)
  }

  static unweighed(r, holder, now) {
    const rest = Channels.weighed(r, now)
    delete rest[holder]
    if (Object.keys(rest).length > 0) r.refundsJudged = rest
    else delete r.refundsJudged
    return r
  }

  judgeWaitMs() {
    return Math.max(0, Math.trunc(Number(this.cfg?.refundJudgeWaitMs ?? 5000)))
  }

  async judged(channelId, pending = false) {
    const deadline = this.cfg.nowMs() + this.judgeWaitMs()
    for (;;) {
      const c = await this.get(channelId)
      const now = this.cfg.nowMs()
      if (!Channels.held(c, now, pending) || now >= deadline) return c
      await this.cfg.sleepMs(Channels.JUDGING_POLL_MS)
    }
  }

  async weigh(channelId, holder) {
    const deadline = this.cfg.nowMs() + this.judgeWaitMs()
    for (;;) {
      let wait = false
      try {
        await this.update(channelId, (r) => {
          if (r === null) return r
          const now = this.cfg.nowMs()
          const weighed = Channels.weighed(r, now)
          if (now < deadline && Channels.judging(r, now) && !Object.hasOwn(weighed, String(r.refundingBy))) {
            wait = true
            return r
          }
          r.refundsJudged = { ...weighed, [holder]: now + Channels.JUDGING_TTL_MS }
          return r
        })
      } catch {
        return false
      }
      if (!wait) return true
      await this.cfg.sleepMs(Channels.JUDGING_POLL_MS)
    }
  }

  unweigh(channelId, holder) {
    return this.update(channelId, (r) => (r === null ? r : Channels.unweighed(r, holder, this.cfg.nowMs()))).catch(() => {})
  }

  async mark(channelId, holder, refuseOpen = true, sending = false) {
    for (;;) {
      let out = { ok: true }
      try {
        await this.update(channelId, (r) => {
          if (r === null) return r
          const now = this.cfg.nowMs()
          if (Channels.judging(r, now)) out = { wait: true }
          else if (Channels.refundingWaitMs(r, now) > 0) out = { settling: Channels.refundingRetrySecs(this.cfg, r, now) }
          else if (!sending && Channels.beingJudged(r, now)) out = { judged: Channels.judgedRetrySecs(this.cfg, r, now) }
          else if (refuseOpen && Channels.pendingLive(r, now)) out = { open: structuredClone(r), at: now }
          else if (sending) {
            r.refundingUntil = now + Channels.JUDGING_TTL_MS
            r.refundingBy = holder
            r.refundingJudging = true
          } else {
            r.refundingUntil = now + Channels.JUDGING_TTL_MS
            r.refundingBy = holder
            r.refundingJudging = true
          }
          return r
        })
      } catch {
        return { unavailable: true }
      }
      if (out.wait !== true) return out
      await this.cfg.sleepMs(Channels.JUDGING_POLL_MS)
    }
  }

  async sending(channelId, holder) {
    let other = null
    try {
      await this.update(channelId, (r) => {
        if (r === null) return r
        const now = this.cfg.nowMs()
        if (r.refundingBy !== holder || Channels.refundingWaitMs(r, now) === 0) {
          other = Channels.refundingWaitMs(r, now) > 0 ? { settling: Channels.refundingRetrySecs(this.cfg, r, now) } : { unavailable: true }
          return r
        }
        r.refundingUntil = now + Channels.REFUNDING_TTL_MS
        r.refundingBy = holder
        delete r.refundingJudging
        return Channels.unweighed(r, holder, now)
      })
    } catch {
      return { unavailable: true }
    }
    return other
  }

  unmark(channelId, holder) {
    return this.update(channelId, (r) => {
      if (r === null) return r
      if (r.refundingBy === holder) {
        delete r.refundingUntil
        delete r.refundingBy
        delete r.refundingJudging
      }
      return Channels.unweighed(r, holder, this.cfg.nowMs())
    }).catch(() => {})
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

  async release(channelId, pendingId = null) {
    let had = false
    try {
      await this.update(channelId, (c) => {
        if (c === null || c.pendingRequest === undefined || c.pendingRequest === null) return c
        if (pendingId !== null && (c.pendingRequest.pendingId === undefined || c.pendingRequest.pendingId !== pendingId)) return c
        had = true
        delete c.pendingRequest
        return c
      })
    } catch {
      return false
    }
    return had
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
