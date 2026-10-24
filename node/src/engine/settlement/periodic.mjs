import { randomBytes } from 'node:crypto'
import { Address, Hex, empty, isObject } from '../core/hex.mjs'
import { Multicall3, Token } from '../core/evm.mjs'
import { Pass } from '../core/pass.mjs'
import { Secp256k1 } from '../core/secp256k1.mjs'
import { Chain } from './chain.mjs'
import { Channels } from './channels.mjs'
import { UnknownEscrow } from './escrow.mjs'
import { GasQuote, Payout, Relay } from './relay.mjs'
import { Verify } from './verify.mjs'
import { ESCROWS } from './x402.mjs'
import { usd as usdOf } from '../pricing.mjs'
import { percent, refundRule } from '../discovery.mjs'

const n = Channels.n
const message = (e) => String(e?.message ?? e)

export class Claims {
  constructor(cfg, store, chain = null, relay = null, escrows = ESCROWS) {
    this.cfg = cfg
    this.store = store
    this.chain = chain ?? new Chain(cfg.rpcUrl)
    this.relay = relay ?? new Relay(cfg.relayUrl)
    this.escrows = escrows
    this.gas = new GasQuote(cfg, this.chain, this.relay)
    this.channels = new Channels(cfg, store, this.chain, escrows)
    this.payout = new Payout(cfg, this.chain, escrows.default)
  }

  payoutOf(escrow) {
    return escrow === this.escrows.default ? this.payout : new Payout(this.cfg, this.chain, escrow)
  }

  async claimable(asset, all, escrow = this.escrows.default) {
    const now = this.cfg.nowMs()
    const found = []
    for (const raw of all) {
      if (this.escrows.find(raw) !== escrow) continue
      const c = await Channels.earned(this.cfg, this.escrows.view(escrow, raw), escrow)
      const token = Channels.tokenOf(c, escrow)
      if (token === undefined || !Address.equals(token, asset.address) || !Channels.claimable(c, escrow)) continue
      let live
      try {
        live = await this.chain.live(c.channelId, escrow)
      } catch {
        continue
      }
      if (live.withdrawing && empty(c.withdrawRequestedAt)) {
        await this.channels.update(c.channelId, (r) => {
          if (r !== null) r.withdrawRequestedAt = now
          return r
        })
      }
      const charged = n(c.chargedCumulativeAmount)
      if (charged > n(live.balance) || charged <= n(live.claimed)) continue
      const delta = charged - n(live.claimed)
      if (delta > n(live.payable)) continue
      const microUSD = Math.trunc(Number(this.cfg.microUSDOf(asset, delta.toString())))
      let urgent = false
      if (live.withdrawing) {
        const gas = await this.gas.microUSD(this.escrows.gas(this.cfg, escrow).claimAlone)
        urgent = gas !== null && microUSD * this.cfg.feeShare >= gas
      }
      const idle = now - (c.lastRequestTimestamp !== undefined ? Math.trunc(Number(c.lastRequestTimestamp)) : 0) >= 1000 * this.cfg.idleClaimSecs
      if (!live.withdrawing && !idle) continue
      found.push({ c, live, urgent, microUSD, units: delta.toString() })
    }
    return { urgent: found.filter((x) => x.urgent), rest: found.filter((x) => !x.urgent) }
  }

  async worthClaiming(asset, all, found = null, escrow = this.escrows.default) {
    const { urgent, rest } = found ?? await this.claimable(asset, all, escrow)
    if (!rest.length) return urgent
    const worth = rest.reduce((s, x) => s + x.microUSD, 0)
    const units = this.escrows.gas(this.cfg, escrow)
    const gas = await this.gas.microUSD(units.claimBase + units.claimEntry * rest.length + units.payout)
    const ok = gas !== null && worth * this.cfg.feeShare >= gas
    return ok ? [...urgent, ...rest] : urgent
  }

  async claimCall(picked, escrow = this.escrows.default) {
    return (await this.claimCalls(picked, escrow))[0]
  }

  claimCalls(picked, escrow = this.escrows.default) {
    return this.escrows.claimCalls(escrow, this.cfg.signingKey(), picked.map((x) => x.c), this.cfg.chainId, () => this.chain.time(Math.floor(this.cfg.nowMs() / 1000)))
  }

  async receipts(rows) {
    const deadline = this.cfg.nowMs() + 1000 * this.cfg.receiptTimeoutSecs
    const read = new Map()
    for (const row of rows) {
      const hash = row.hash
      if (hash === undefined) continue
      if (!read.has(hash)) {
        let receipt = null
        for (;;) {
          try {
            receipt = await this.chain.receipt(hash)
          } catch {
            receipt = null
          }
          if (receipt !== null || this.cfg.nowMs() >= deadline) break
          await this.cfg.sleepMs(this.cfg.receiptPollMs)
        }
        read.set(hash, receipt)
      }
      const receipt = read.get(hash)
      if (receipt !== null && String(receipt.status ?? '').toLowerCase() === '0x1') continue
      delete row.hash
      row.sent = hash
      row.reverted = receipt !== null
      row.error = receipt === null ? `no receipt for ${hash} yet` : `transaction ${hash} reverted`
    }
  }

  reportKey(asset, escrow) {
    return escrow === this.escrows.default ? asset.symbol : `${asset.symbol}@${escrow.kind}`
  }

  async run() {
    const all = await this.store.list()
    const report = {}
    for (const escrow of this.escrows.list) {
      for (const asset of this.cfg.assets) report[this.reportKey(asset, escrow)] = await this.runAsset(asset, all, escrow)
    }
    return report
  }

  async runAsset(asset, all, escrow = this.escrows.default) {
    const cap = Math.max(1, Math.trunc(Number(this.cfg.maxClaimsPerBatch)))
    const found = await this.claimable(asset, all, escrow)
    const wide = [...found.urgent, ...found.rest].slice(0, cap)
    let selected = (await this.worthClaiming(asset, all, found, escrow)).slice(0, cap)
    const payout = this.payoutOf(escrow)
    const planFor = async (riding) => {
      try {
        return await payout.calls(asset.address, riding)
      } catch (e) {
        return { calls: [], owed: '0', held: '0', error: message(e) }
      }
    }
    let plan = await planFor(selected.length > 0)
    let quoted = null
    const widePlan = wide.length === selected.length ? plan : await planFor(wide.length > 0)
    const table = this.escrows.gas(this.cfg, escrow)
    const split = this.escrows.split(this.cfg, escrow)
    let before = []
    if (wide.length || widePlan.calls.length) {
      try {
        before = await this.escrows.prepareCalls(escrow, this.chain)
      } catch (e) {
        return { selected: selected.length, claimed: [], valueUSD: 0, calls: [], error: message(e) }
      }
    }
    if (widePlan.calls.length) {
      quoted = await this.relay.sendQuote([...before, ...(wide.length ? await this.claimCalls(wide, escrow) : []), ...widePlan.calls], split)
      if (quoted !== null) {
        selected = wide
        plan = widePlan
      }
    }
    let riding = 0n
    for (const x of selected) riding += BigInt(x.units)
    const payoutCalls = plan.calls
    let usd = 0
    let payoutOk = quoted !== null && quoted.covered
    if (payoutCalls.length && quoted !== null) {
      usd = this.cfg.microUSDOf(asset, (riding + BigInt(plan.owed) + BigInt(plan.held)).toString()) / 1e6
    } else if (payoutCalls.length) {
      const units = (riding + BigInt(plan.owed) + BigInt(plan.held)).toString()
      usd = this.cfg.microUSDOf(asset, units) / 1e6
      let gasUnits = table.payout + (selected.length ? table.claimBase + selected.length * table.claimEntry : 0)
      for (const c of payoutCalls) if (c.what === 'create split') gasUnits += table.createSplit
      for (const c of before) if (c.what === 'create payee') gasUnits += table.createPayee ?? 0
      payoutOk = await this.gas.atMargin(usd, gasUnits)
    }
    const claiming = payoutOk ? selected : selected.filter((x) => x.live.withdrawing)
    let calls = []
    if (claiming.length) calls.push(...(await this.claimCalls(claiming, escrow)))
    if (payoutOk) calls = [...calls, ...payoutCalls]
    const out = { selected: selected.length, claimed: [], valueUSD: Math.round(usd * 1e6) / 1e6, calls: [] }
    if (plan.error !== undefined) out.error = plan.error
    if (payoutCalls.length && !payoutOk) out.waiting = 'below break-even: waits until the fee share covers the gas'
    if (!calls.length) return out
    calls = [...before, ...calls]
    const results = await this.relay.send(calls, split)
    calls.forEach((call, i) => out.calls.push({ what: call.what, ...results[i] }))
    const exact = escrow.settles === 'exact'
    if (exact) await this.receipts(out.calls)
    if (claiming.length && (exact || results[before.length]?.hash !== undefined)) {
      const deadline = this.cfg.nowMs() + this.cfg.stateCatchUpMs
      const failed = []
      let landed = 0n
      for (const [i, x] of claiming.entries()) {
        const id = x.c.channelId
        const expected = n(x.c.chargedCumulativeAmount)
        const row = out.calls[before.length + i]
        if (exact && row.hash === undefined) {
          if (row.sent !== undefined) failed.push({ channelId: id, reverted: row.reverted, why: row.error })
          continue
        }
        let st = null
        for (;;) {
          try {
            st = await this.chain.channel(id, escrow)
          } catch {
            st = null
          }
          if (st !== null && n(st.totalClaimed) >= expected) break
          if (this.cfg.nowMs() >= deadline) break
          await this.cfg.sleepMs(150)
        }
        if (st === null) continue
        await this.channels.update(id, (r) => {
          if (r === null) return null
          if (n(st.totalClaimed) > n(r.totalClaimed ?? '0')) r.totalClaimed = st.totalClaimed
          if (n(st.balance) < n(r.balance ?? '0')) r.balance = st.balance
          return r
        })
        if (exact && n(st.totalClaimed) < expected) {
          failed.push({ channelId: id, reverted: false, why: `the channel shows ${st.totalClaimed} settled, under the ${expected} sent` })
          continue
        }
        landed += BigInt(x.units)
        out.claimed.push(id)
      }
      if (failed.length) out.failed = failed
      if (exact && payoutCalls.length) out.valueUSD = Math.round(this.cfg.microUSDOf(asset, (landed + BigInt(plan.owed) + BigInt(plan.held)).toString())) / 1e6
    }
    return out
  }
}

export class Withdrawals {
  constructor(cfg, store, chain = null, escrows = ESCROWS) {
    this.cfg = cfg
    this.store = store
    this.chain = chain ?? new Chain(cfg.rpcUrl)
    this.escrows = escrows
  }

  async run() {
    const out = { checked: 0, withdrawing: [], cleared: [], errors: 0 }
    const now = this.cfg.nowMs()
    for (const c of await this.store.list()) {
      if (c.channelId === undefined || c.channelId === null || n(c.balance ?? '0') <= 0n) continue
      const id = String(c.channelId).toLowerCase()
      const escrow = this.escrows.find(c)
      if (escrow === null) {
        out.errors++
        continue
      }
      let w
      try {
        w = await this.chain.pendingWithdrawal(id, escrow)
      } catch {
        out.errors++
        continue
      }
      out.checked++
      const leaving = n(w.amount) > 0n
      const stamped = !empty(c.withdrawRequestedAt)
      if (leaving) out.withdrawing.push(id)
      if (leaving === stamped) continue
      await this.store.update(id, (r) => {
        if (r === null) return null
        r.withdrawRequestedAt = leaving ? now : 0
        return r
      })
      if (!leaving) out.cleared.push(id)
    }
    return out
  }
}

export class Refunds {
  static FUTURE_SKEW_MS = 30000

  constructor(cfg, store, chain = null, relay = null, escrows = ESCROWS) {
    this.cfg = cfg
    this.store = store
    this.chain = chain ?? new Chain(cfg.rpcUrl)
    this.relay = relay ?? new Relay(cfg.relayUrl)
    this.escrows = escrows
    this.gas = new GasQuote(cfg, this.chain, this.relay)
    this.channels = new Channels(cfg, store, this.chain, escrows)
  }

  static SHARED = Object.freeze(['nothing_to_return', 'gas_payment_needed', 'request_open'])
  static VERDICT_MS = 5000

  static verdictOf(r) {
    const v = r?.refundVerdict
    return {
      key: typeof v?.key === 'string' ? v.key : null,
      state: typeof v?.state === 'string' ? v.state : null,
      line: typeof v?.line === 'string' ? v.line : null,
      at: Number.isSafeInteger(v?.at) ? v.at : 0,
      answer: isObject(v?.answer) ? v.answer : null,
    }
  }

  static stateOf(r) {
    const at = (v) => (v === undefined || v === null ? null : String(v))
    return JSON.stringify([at(r?.chargedCumulativeAmount), at(r?.balance), at(r?.totalClaimed), at(r?.signedMaxClaimable), at(r?.refundNonce), at(r?.pendingRequest?.expiresAt), at(r?.handedOver?.nonce), at(r?.withdrawRequestedAt)])
  }

  static askKey(ask) {
    return JSON.stringify([ask?.selfSend === true, ask?.gasPayment ?? null])
  }

  static message(channelId, issued) {
    return `${Pass.REALM} refund\nchannel: ${String(channelId ?? '').toLowerCase()}\nissued: ${issued}`
  }

  static answer(status, body) {
    return { status, body }
  }

  static failed(status, code, why, more = {}) {
    return Refunds.answer(status, { op: 'refund_failed', code, why, ...more })
  }

  static parseIssued(issued) {
    if (typeof issued !== 'string' || issued.trim() === '') return null
    const t = Date.parse(issued)
    if (!Number.isNaN(t)) return t
    const s = Pass.strtotime(issued)
    return s === false ? null : s * 1000
  }

  async proofOwner(channelId, issued, signature) {
    if (issued === undefined || issued === null || (typeof issued === 'string' && issued.trim() === '')) return { ok: false, why: 'issued is missing: send the ISO 8601 time you signed, as a string' }
    const t = Refunds.parseIssued(issued)
    if (t === null) return { ok: false, why: 'issued is not a timestamp' }
    const now = this.cfg.nowMs()
    const window = 1000 * Math.trunc(Number(this.cfg.refundWindowSecs))
    if (now - t > window || t - now > Refunds.FUTURE_SKEW_MS) return { ok: false, why: `issued ${issued} is outside the ${Math.trunc(Number(this.cfg.refundWindowSecs))}s window` }
    if (typeof signature !== 'string' || !/^(0x)?[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, why: 'signature is missing or is not 65 bytes of hex' }
    const who = await Refunds.recovered(Refunds.message(channelId, issued), signature)
    if (who === null) return { ok: false, why: 'signature does not recover to an address' }
    return { ok: true, address: who }
  }

  static PROOFS = new Map()
  static PROOFS_KEPT = 256

  static recovered(message, signature) {
    const key = `${message}\n${signature}`
    let who = Refunds.PROOFS.get(key)
    if (who === undefined) {
      who = Secp256k1.recoverPersonal(message, signature).then((a) => a.toLowerCase(), () => null)
      Refunds.PROOFS.set(key, who)
      while (Refunds.PROOFS.size > Refunds.PROOFS_KEPT) Refunds.PROOFS.delete(Refunds.PROOFS.keys().next().value)
    }
    return who
  }

  static owns(channel, address, escrow = ESCROWS.default) {
    const who = String(address ?? '').toLowerCase()
    if (who === '') return false
    return escrow.owners(channel.channelConfig).some((a) => who === String(a ?? '').toLowerCase())
  }

  static unserved(e) {
    return Refunds.failed(409, 'unknown_escrow', `this channel's record names an escrow this seller does not serve (${String(e.kind).slice(0, 60)}). Nothing was sent.`)
  }

  async handle(channelId, issued, signature, ask = {}) {
    const cid = String(channelId ?? '').toLowerCase()
    if (!Verify.isCanonicalChannelId(cid)) return Refunds.failed(400, 'invalid_request', 'channelId is missing or is not 0x and 64 hex characters: send {channelId, issued, signature}')
    const holder = '0x' + randomBytes(16).toString('hex')
    const turn = this.channels.ticket(cid, holder, this.cfg.nowMs())
    try {
      return { ...(await this.checked(cid, issued, signature, ask, holder)), turn }
    } finally {
      await this.channels.serial(cid, (g) => this.left(g, holder))
    }
  }

  async checked(cid, issued, signature, ask, holder) {
    let ch
    try {
      ch = await this.channels.get(cid)
      if (ch !== null) this.escrows.of(ch)
    } catch (e) {
      if (e instanceof UnknownEscrow) return Refunds.unserved(e)
      throw e
    }
    const sent = ask?.channelConfig ?? null
    const own = sent === null ? null : this.ownConfig(cid, sent)
    if (own?.mismatch) return Refunds.failed(400, 'channel_config_mismatch', own.why, { mismatch: own.mismatch })
    const config = own?.config ?? null
    if (ch === null && config === null) return Refunds.failed(404, 'unknown_channel', 'no channel with that id here. For a channel with no calls here, send its channelConfig with the proof.')
    const proof = await this.proofOwner(cid, issued, signature)
    if (!proof.ok) return Refunds.failed(400, 'proof_invalid', proof.why, { sign: Refunds.message(cid, '<ISO8601 within five minutes>') })
    const escrow = ch === null ? own.escrow : this.escrows.of(ch)
    if (escrow.closes === 'whole') return Refunds.failed(409, 'session_channel', 'this channel is an MPP session: it is closed whole, by a close credential on the paid resource, or by requestClose and withdraw on its escrow. Nothing was sent.')
    if (!Refunds.owns(ch ?? { channelConfig: config }, proof.address, escrow)) return Refunds.failed(403, 'not_the_payer', `${proof.address} is not this channel's payer`)
    if (ch === null) {
      const adopted = await this.adopt(cid, config, escrow)
      if (adopted.failed) return adopted.failed
      ch = adopted.channel
    }
    return this.worked(cid, ch, ask ?? {}, holder)
  }

  static WORKERS = 4
  static BUSY_RETRY_SECS = 1
  static TURN_LOOK_MS = 1000
  static JUDGE_TRIES = 3

  async worked(id, ch, ask, holder) {
    const key = Refunds.askKey(ask)
    const deadline = this.cfg.nowMs() + this.channels.judgeWaitMs()
    try {
      for (;;) {
        let step = await this.channels.serial(id, (g) => this.arrive(g, id, ch, key, holder, deadline))
        if (step.wait !== undefined) {
          await this.channels.waited(step.wait, deadline)
          continue
        }
        if (step.read !== undefined) {
          const live = await step.read.live
          step.read.readers -= 1
          step = await this.channels.serial(id, (g) => this.arrived(g, id, ch, holder, live))
        }
        if (step.answer?.body?.code === 'nothing_to_return' && !empty((await this.channels.get(id))?.handedOver)) await this.channels.repaired(id)
        if (step.answer !== undefined) return await this.told(ch, step)
        break
      }
      return await this.turns(id, ch, ask, key, holder, deadline)
    } finally {
      await this.channels.serial(id, (g) => this.left(g, holder))
    }
  }

  static seat(g, holder, map, until) {
    g.checking.delete(holder)
    map.set(holder, until)
  }

  static READ_SHARED_MS = 100

  async arrive(g, id, ch, key, holder, deadline) {
    const now = this.cfg.nowMs()
    const r = await this.channels.get(id)
    if (Channels.refundingWaitMs(r, now) > 0) return { answer: Refunds.settling(Channels.refundingRetrySecs(this.cfg, r, now)), settling: Channels.live(g.held, now) + Channels.live(g.arriving, now) < Refunds.WORKERS }
    if (Channels.pendingLive(r, now)) return { answer: Refunds.callOpen(r, now) }
    if (this.cfg.meter && (await this.cfg.meter.busy(id))) return { answer: Refunds.lineBusy() }
    if (Channels.holding(g, now)) {
      Refunds.seat(g, holder, g.held, now + Channels.JUDGING_TTL_MS)
      return { joined: true }
    }
    if (!Channels.arriving(g, now) && !Channels.ahead(g, holder, now)) {
      const kept = Refunds.kept(r, key, now, await this.lineOf(id))
      if (kept !== null) return { answer: kept }
    }
    const seen = g.lastRead
    if (seen !== null && now >= seen.at && now - seen.at < Refunds.READ_SHARED_MS) return this.arrived(g, id, ch, holder, seen.live)
    if (Channels.earlier(g, holder, g.arriving, now) >= Refunds.WORKERS) return now >= deadline ? { answer: Refunds.busy() } : { wait: this.channels.waiter(g) }
    Refunds.seat(g, holder, g.arriving, now + Channels.JUDGING_TTL_MS)
    if (g.reading === null) {
      const read = { readers: 0, live: this.chain.live(id, this.escrows.of(r ?? ch)).catch(() => null) }
      g.reading = read
      read.live.then(() => { if (g.reading === read) g.reading = null })
    }
    g.reading.readers += 1
    return { read: g.reading }
  }

  async arrived(g, id, ch, holder, live) {
    const now = this.cfg.nowMs()
    g.arriving.delete(holder)
    try {
      const r = await this.channels.get(id)
      if (Channels.refundingWaitMs(r, now) > 0) return { answer: Refunds.settling(Channels.refundingRetrySecs(this.cfg, r, now)), settling: Channels.live(g.held, now) < Refunds.WORKERS }
      if (!Channels.holding(g, now)) {
        if (live === null) return { answer: Refunds.failed(409, 'chain_unreadable', 'could not read the channel on chain', { retry_after_seconds: Refunds.RETRY_SECS }) }
        g.lastRead = { at: now, live }
        const raw = r ?? ch
        if (n(Channels.refundable(await Channels.earned(this.cfg, raw, this.escrows.of(raw)), live)) <= 0n) return { answer: Refunds.nothing() }
        if (Channels.pendingLive(r, now)) return { answer: Refunds.callOpen(r, now) }
        if (this.cfg.meter && !(await this.cfg.meter.stop(id))) return { answer: Refunds.lineBusy() }
      }
      Refunds.seat(g, holder, g.held, now + Channels.JUDGING_TTL_MS)
      return { joined: true }
    } finally {
      this.channels.wake(g)
    }
  }

  async turns(id, ch, ask, key, holder, deadline) {
    for (let tries = 1; ; tries++) {
      const step = await this.channels.serial(id, (g) => this.turn(g, id, key, holder, deadline))
      if (step.answer !== undefined) return await this.told(ch, step)
      if (step.wait !== undefined) {
        tries -= 1
        await this.channels.waited(step.wait, step.until)
        continue
      }
      const judged = await this.judge(ch, ask)
      const decided = await this.channels.serial(id, (g) => this.decide(g, id, key, holder, judged, tries))
      if (decided.again) continue
      if (decided.answer !== undefined) return decided.answer
      try {
        return await this.send(decided.plan)
      } finally {
        await this.channels.serial(id, (g) => this.unsend(g, id, holder))
      }
    }
  }

  async turn(g, id, key, holder, deadline) {
    const now = this.cfg.nowMs()
    const r = await this.channels.get(id)
    if (Channels.refundingWaitMs(r, now) > 0) return { answer: Refunds.settling(Channels.refundingRetrySecs(this.cfg, r, now)), settling: [...g.held.keys()].indexOf(holder) < Refunds.WORKERS }
    const judge = Channels.judgeOf(g, now)
    if (judge?.holder === holder) {
      judge.until = now + Channels.JUDGING_TTL_MS
      return { judge: true }
    }
    Refunds.seat(g, holder, g.held, now + Channels.JUDGING_TTL_MS)
    const place = Channels.place(g, holder, now)
    const slot = place
    if (judge === null && place === 0 && !Channels.before(g, holder, now).ahead) {
      if (Channels.pendingLive(r, now)) return { answer: Refunds.callOpen(r, now) }
      const kept = Refunds.kept(r, key, now, await this.lineOf(id))
      if (kept !== null) return { answer: kept }
      g.judge = { holder, until: now + Channels.JUDGING_TTL_MS }
      return { judge: true }
    }
    if (slot >= Refunds.WORKERS && now >= deadline) return { answer: Channels.pendingLive(r, now) ? Refunds.callOpen(r, now) : Refunds.busy() }
    return { wait: this.channels.waiter(g), until: Math.min(slot >= Refunds.WORKERS ? deadline : Infinity, now + Refunds.TURN_LOOK_MS) }
  }

  async decide(g, id, key, holder, judged, tries) {
    const now = this.cfg.nowMs()
    const r = await this.channels.get(id)
    const moved = r !== null && Refunds.stateOf(r) !== judged.state
    if (judged.answer !== undefined) {
      if (moved && judged.final !== true && tries < Refunds.JUDGE_TRIES && !Channels.pendingLive(r, now)) return { again: true }
      const answer = Channels.pendingLive(r, now) ? Refunds.callOpen(r, now) : judged.answer
      this.done(g, holder)
      return { answer: await this.keep(id, key, judged.state, judged.line, answer) }
    }
    if (!(await this.unchanged(id, judged))) {
      if (tries < Refunds.JUDGE_TRIES && !Channels.pendingLive(r, now)) return { again: true }
      this.done(g, holder)
      return { answer: Channels.pendingLive(r, now) ? Refunds.callOpen(r, now) : Refunds.unheld() }
    }
    try {
      await this.channels.update(id, (c) => {
        if (c === null) return c
        c.refundingUntil = now + Channels.REFUNDING_TTL_MS
        c.refundingBy = holder
        return c
      })
    } catch {
      this.done(g, holder)
      return { answer: Refunds.unheld() }
    }
    this.done(g, holder)
    return { plan: judged }
  }

  done(g, holder) {
    if (g.judge?.holder === holder) g.judge = null
    g.held.delete(holder)
    this.channels.wake(g)
  }

  left(g, holder) {
    g.checking.delete(holder)
    g.order.delete(holder)
    g.arriving.delete(holder)
    this.done(g, holder)
  }

  async unsend(g, id, holder) {
    await this.channels.update(id, (r) => {
      if (r === null || r.refundingBy !== holder) return r
      delete r.refundingUntil
      delete r.refundingBy
      return r
    }).catch(() => {})
    this.channels.wake(g)
  }

  async told(ch, step) {
    return step.settling === true ? ((await this.emptied(ch)) ?? step.answer) : step.answer
  }

  static busy() {
    return Refunds.failed(503, 'refund_unavailable', `refund requests on this channel are already being worked out. Nothing was sent for this one. Retry in ${Refunds.BUSY_RETRY_SECS}s.`, { retry_after_seconds: Refunds.BUSY_RETRY_SECS })
  }

  static kept(r, key, now, line) {
    const v = Refunds.verdictOf(r)
    if (v.answer === null || v.key !== key || v.state !== Refunds.stateOf(r) || v.line !== line) return null
    return now >= v.at && now - v.at < Refunds.VERDICT_MS ? v.answer : null
  }

  async keep(id, key, state, line, answer) {
    const shared = Refunds.SHARED.includes(answer?.body?.code)
    const still = shared && (await this.lineOf(id).catch(() => undefined)) === line
    await this.store.update(id, (r) => {
      if (r === null) return null
      if (still && Refunds.stateOf(r) === state) r.refundVerdict = { key, state, line, at: this.cfg.nowMs(), answer }
      else if (r.refundVerdict !== undefined) delete r.refundVerdict
      return r
    }).catch(() => null)
    return answer
  }

  async lineOf(id) {
    const meter = this.cfg.meter
    if (!meter) return null
    const s = await meter.status(id)
    return JSON.stringify([s.metering === true, s.msRemaining, await meter.busy(id)])
  }

  async unchanged(id, judged) {
    const raw = await this.channels.get(id)
    if (raw === null || Refunds.stateOf(raw) !== judged.state) return false
    const now = await Channels.earned(this.cfg, raw, judged.escrow)
    return Channels.refundable(now, judged.live) === judged.left && !Channels.pendingLive(raw, this.cfg.nowMs())
  }

  static lineBusy() {
    return Refunds.failed(409, 'request_open', `a call is running on this channel's line. Retry in ${Refunds.OPEN_RETRY_SECS}s.`, { retry_after_seconds: Refunds.OPEN_RETRY_SECS })
  }

  async emptied(ch) {
    const id = String(ch.channelId).toLowerCase()
    const raw = (await this.channels.get(id)) ?? ch
    const escrow = this.escrows.of(raw)
    const live = await this.chain.live(id, escrow).catch(() => null)
    return live !== null && n(Channels.refundable(await Channels.earned(this.cfg, raw, escrow), live)) <= 0n ? Refunds.nothing() : null
  }

  static nothing() {
    return Refunds.failed(409, 'nothing_to_return', 'nothing to return: the channel holds nothing', { leftMicroUSD: 0, returnedMicroUSD: 0, gasMicroUSD: 0 })
  }

  static callOpen(ch, now) {
    const wait = Math.min(Refunds.OPEN_RETRY_SECS, Math.ceil((Math.trunc(Number(ch.pendingRequest.expiresAt)) - now) / 1000))
    return Refunds.failed(409, 'request_open', `a paid call is open on this channel. Retry in ${wait}s.`, { retry_after_seconds: wait })
  }

  static unheld() {
    return Refunds.failed(503, 'refund_unavailable', `the channel could not be held for the refund right now. Nothing was sent. Retry in ${Refunds.OPEN_RETRY_SECS}s.`, { retry_after_seconds: Refunds.OPEN_RETRY_SECS })
  }

  static settling(secs) {
    return Refunds.failed(409, 'refund_settling', `a refund is already settling on this channel. Nothing more was sent. Retry in ${secs}s.`, { retry_after_seconds: secs })
  }

  ownConfig(cid, config) {
    let first = null
    for (const escrow of this.escrows.list) {
      const own = this.ownConfigIn(escrow, cid, config)
      if (!own.mismatch) return own
      first ??= own
    }
    return first
  }

  ownConfigIn(escrow, cid, config) {
    const fields = { mismatch: 'fields', why: `channelConfig needs ${escrow.configFields}, as deposited` }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) return fields
    let id
    try {
      id = Verify.computeChannelId(config, this.cfg.network, escrow).toLowerCase()
    } catch {
      return fields
    }
    if (id !== cid) return { mismatch: 'channelId', why: `channelConfig hashes to ${id}, not to channelId ${cid}` }
    return escrow.sellerMismatch(config, this.cfg) ?? { config, escrow }
  }

  async adopt(cid, config, escrow) {
    let st
    try {
      st = await this.chain.channel(cid, escrow)
    } catch {
      return { failed: Refunds.failed(409, 'chain_unreadable', 'could not read the channel on chain', { retry_after_seconds: Refunds.RETRY_SECS }) }
    }
    if (n(st.balance) <= 0n) return { failed: Refunds.failed(400, 'channel_config_mismatch', "channelConfig names this seller, but that channel holds no balance on chain: its escrow balance is 0", { mismatch: 'balance' }) }
    const now = this.cfg.nowMs()
    const channel = await this.channels.update(cid, (r) => r ?? {
      channelId: cid,
      channelConfig: config,
      chargedCumulativeAmount: String(st.totalClaimed),
      balance: String(st.balance),
      totalClaimed: String(st.totalClaimed),
      withdrawRequestedAt: 0,
      refundNonce: 0,
      onchainSyncedAt: now,
      lastRequestTimestamp: 0,
      adoptedAt: now,
      ...this.escrows.tag(escrow),
    })
    return { channel }
  }

  static ask(body) {
    const b = body !== null && typeof body === 'object' ? body : {}
    const obj = (x) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? x : null)
    const scalar = (x) => (['string', 'number'].includes(typeof x) ? String(x) : null)
    const p = obj(b.gasPayment)
    const a = p === null ? null : obj(p.authorization)
    const config = obj(b.channelConfig)
    return {
      selfSend: b.selfSend === true || b.selfSend === 'true',
      channelConfig: config !== null ? { ...config } : b.channelConfig === undefined ? null : b.channelConfig,
      gasPayment: p === null ? null : {
        authorization: a === null ? null : Object.fromEntries(Refunds.AUTHORIZATION_FIELDS.map((k) => [k, scalar(a[k])])),
        signature: scalar(p.signature),
      },
    }
  }

  static AUTHORIZATION_FIELDS = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']
  static GAS_PAYMENT_MARGIN_SECS = 30
  static RETRY_SECS = 60
  static OPEN_RETRY_SECS = 5

  microUSD(ch, units) {
    return this.cfg.microUSDOf(this.escrows.of(ch).token(ch.channelConfig), units)
  }

  async judge(incoming, ask) {
    const id = String(incoming.channelId).toLowerCase()
    const raw = (await this.channels.repaired(id)) ?? incoming
    const state = Refunds.stateOf(raw)
    let line = await this.lineOf(id)
    const refused = (answer) => ({ state, line, answer })
    const escrow = this.escrows.of(raw)
    let ch = await Channels.earned(this.cfg, raw, escrow)
    let live
    try {
      live = await this.chain.live(id, escrow)
    } catch {
      return refused(Refunds.failed(409, 'chain_unreadable', 'could not read the channel on chain', { retry_after_seconds: Refunds.RETRY_SECS }))
    }
    let left = Channels.refundable(ch, live)
    if (n(left) <= 0n) return refused(Refunds.nothing())
    const now = this.cfg.nowMs()
    if (Channels.pendingLive(ch, now)) return refused(Refunds.callOpen(ch, now))
    const f = await this.frozen(raw, live, ch, left)
    line = f.line ?? line
    if (f.failed) return refused(f.failed)
    ch = f.ch
    left = f.left
    let nonce
    try {
      nonce = await this.chain.refundNonce(id, escrow)
    } catch {
      return refused(Refunds.failed(409, 'chain_unreadable', 'could not read the refund nonce on chain', { retry_after_seconds: Refunds.RETRY_SECS }))
    }
    const plan = { state, line, escrow, live, ch, left, nonce }
    if (ask.selfSend === true) return { ...plan, self: true }
    const leftMicroUSD = this.microUSD(ch, left)
    let call
    try {
      call = await this.refundCall(ch, live, left, nonce)
    } catch (e) {
      return refused(Refunds.failed(409, 'refund_error', message(e).slice(0, 160), { retry_after_seconds: Refunds.RETRY_SECS, leftMicroUSD }))
    }
    const gas = await this.refundGas(ch, live, call)
    if (gas === null) return refused(Refunds.failed(503, 'gas_unpriced', `refund gas cannot be priced. Retry in 60s, or send ${Refunds.SELF_SEND} for a signed refund to send yourself.`, { retry_after_seconds: Refunds.RETRY_SECS, leftMicroUSD }))
    const amounts = { leftMicroUSD, returnedMicroUSD: leftMicroUSD, gasMicroUSD: gas.gasMicroUSD, feeMicroUSD: gas.feeMicroUSD, coverMicroUSD: gas.coverMicroUSD }
    if (gas.covered) return { ...plan, call, gas, amounts, payment: null }
    const asset = this.cfg.assetOf(escrow.token(ch.channelConfig))
    const rule = Refunds.rule(this.cfg, gas)
    if (asset === null || !asset.eip3009) return refused(Refunds.failed(409, 'nothing_to_return', `${rule}; this token has no gasless payment for the $${Refunds.usd(gas.gasMicroUSD)} refund gas. Send ${Refunds.SELF_SEND} for a signed refund of the full balance, sent from any wallet at your own gas.`, { ...amounts, returnedMicroUSD: 0, ...gas.detail }))
    if (gas.gasMicroUSD >= leftMicroUSD) return refused(Refunds.failed(409, 'nothing_to_return', `${rule}; refund gas $${Refunds.usd(gas.gasMicroUSD)} >= balance $${Refunds.usd(leftMicroUSD)}. Send ${Refunds.SELF_SEND} for a signed refund of the full balance, sent from any wallet at your own gas.`, { ...amounts, returnedMicroUSD: 0, ...gas.detail }))
    const payTo = await this.gas.gasWallet()
    if (payTo === null) return refused(Refunds.failed(503, 'gas_unpriced', `the relay is unreachable. Retry in 60s, or send ${Refunds.SELF_SEND} for a signed refund to send yourself.`, { retry_after_seconds: Refunds.RETRY_SECS, leftMicroUSD }))
    const units = this.cfg.unitsOfMicroUSD(asset, gas.gasMicroUSD)
    const offered = ask.gasPayment ?? null
    if (offered === null) return refused(this.gasQuote(ch, asset, payTo, units, amounts, gas, null))
    const bad = await this.gasPaymentProblem(ch, asset, payTo, this.cfg.unitsOfMicroUSD(asset, gas.costMicroUSD), left, offered)
    if (bad !== null) return refused(this.gasQuote(ch, asset, payTo, units, amounts, gas, bad, /sending costs/.test(bad) ? { requoted: true, sendCostMicroUSD: gas.costMicroUSD } : {}))
    return { ...plan, call, gas, amounts, payment: { asset, payTo, authorization: offered.authorization, signature: offered.signature } }
  }

  async send(plan) {
    const { ch, live, left, call, gas, amounts, payment } = plan
    if (plan.self) return this.selfSend(ch, live, left, plan.nonce)
    if (payment === null) return this.sendRefundNow(ch, call, left, 0, amounts, gas.freeGasUnits)
    const pay = { to: payment.asset.address, data: Token.encodeTransfer(payment.authorization, payment.signature) }
    const bundle = Multicall3.aggregate3([call, pay])
    const out = await this.sendRefundNow(ch, bundle, left, this.microUSD(ch, payment.authorization.value), amounts)
    return out.underpaid === undefined ? out : this.requote(ch, live, payment, amounts, gas, out.underpaid, call)
  }

  async frozen(raw, live, ch, left) {
    const meter = this.cfg.meter
    if (!meter) return { ch, left }
    if (!(await meter.stop(ch.channelId))) return { failed: Refunds.lineBusy() }
    const line = await this.lineOf(String(ch.channelId).toLowerCase())
    const now = await Channels.earned(this.cfg, raw, this.escrows.of(raw))
    const rest = Channels.refundable(now, live)
    if (n(rest) <= 0n) return { line, failed: Refunds.nothing() }
    return { line, ch: now, left: rest }
  }

  async requote(ch, live, payment, amounts, gas, sendCostMicroUSD, call) {
    const fresh = (await this.refundGas(ch, live, call)) ?? gas
    const quoted = Math.max(fresh.covered ? 0 : fresh.gasMicroUSD, Math.ceil(sendCostMicroUSD * this.cfg.gasBuffer))
    const numbers = { ...amounts, gasMicroUSD: quoted, feeMicroUSD: fresh.feeMicroUSD, coverMicroUSD: fresh.coverMicroUSD, sendCostMicroUSD }
    const paying = this.microUSD(ch, payment.authorization.value)
    const moved = fresh.covered || paying >= fresh.gasMicroUSD
      ? `refund gas rose past the quote margin: sending costs $${Refunds.usd(sendCostMicroUSD)}, your payment is $${Refunds.usd(paying)}. Nothing was sent`
      : `your payment, $${Refunds.usd(paying)}, is under the quote, $${Refunds.usd(fresh.gasMicroUSD)}, and under what sending costs, $${Refunds.usd(sendCostMicroUSD)}. Nothing was sent`
    if (quoted >= amounts.leftMicroUSD) return Refunds.failed(409, 'nothing_to_return', `${moved}; refund gas $${Refunds.usd(quoted)} (margin included) >= balance $${Refunds.usd(amounts.leftMicroUSD)}. Send ${Refunds.SELF_SEND} for a signed refund of the full balance, sent from any wallet at your own gas.`, { ...numbers, returnedMicroUSD: 0, ...fresh.detail })
    const units = this.cfg.unitsOfMicroUSD(payment.asset, quoted)
    return this.gasQuote(ch, payment.asset, payment.payTo, units, numbers, fresh, `${moved}. New quote: that cost + ${fresh.detail.marginPercent}% margin`, { requoted: true, sendCostMicroUSD })
  }

  static SELF_SEND = '{"selfSend": true}'

  static usd(microUSD) {
    return usdOf(microUSD)
  }

  async selfSend(ch, live, left, nonce) {
    if (!empty(ch.handedOver?.transaction) && String(ch.handedOver.nonce) === String(nonce)) {
      return Refunds.answer(200, { op: 'refund_signed', microUSD: this.microUSD(ch, ch.handedOver.units ?? '0'), transaction: ch.handedOver.transaction, why: 'your signed refund is unsent; here it is again' })
    }
    let call
    try {
      call = await this.refundCall(ch, live, left, nonce)
    } catch (e) {
      return Refunds.failed(409, 'refund_error', message(e).slice(0, 160), { retry_after_seconds: Refunds.RETRY_SECS })
    }
    return this.handOver(ch, live, call, left, nonce)
  }

  async refundGas(ch, live, call = null) {
    const bundled = Refunds.bundledClaim(ch, live)
    const alreadyPaid = Refunds.gasCounted(ch, this.cfg.gas, await this.gas.relayPaid(ch.channelId))
    const q = await this.gas.refund(bundled > 0n, true, alreadyPaid)
    if (q === null) return null
    const counted = { alreadyPaid, freeGasUnits: this.cfg.gas.refund + (bundled > 0n ? this.cfg.gas.refundClaim : 0) }
    const earned = this.microUSD(ch, (n(live.claimed) + bundled).toString())
    const feeMicroUSD = GasQuote.feeMicroUSD(earned, this.cfg.feeShare)
    const detailOf = (p) => ({ gasUnits: p.gasUnits, gasUnitsWithMargin: p.gasUnitsWithMargin, gasPriceWei: p.gasPriceWei, ethUSD: p.ethUSD, l1FeeWei: p.l1FeeWei, marginPercent: p.marginPercent, quotedBy: p.quotedBy })
    if (feeMicroUSD >= q.cover.microUSD) return { covered: true, gasMicroUSD: 0, costMicroUSD: 0, feeMicroUSD, coverMicroUSD: q.cover.microUSD, detail: detailOf(q.pay), ...counted }
    const pay = (await this.gas.relayQuote(call)) ?? q.pay
    const cover = pay === q.pay ? q.cover : this.gas.priced(q.cover.gasUnits, pay.gasPriceWei, pay.ethUSD)
    if (feeMicroUSD >= cover.microUSD) return { covered: true, gasMicroUSD: 0, costMicroUSD: 0, feeMicroUSD, coverMicroUSD: cover.microUSD, detail: detailOf(pay), ...counted }
    return { covered: false, gasMicroUSD: pay.microUSD, costMicroUSD: pay.costMicroUSD, feeMicroUSD, coverMicroUSD: cover.microUSD, detail: detailOf(pay), ...counted }
  }

  static gasAlreadyPaid(ch, gas) {
    const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0)
    return Math.max(0, count(ch?.depositsWePaid) - 1) * gas.deposit + count(ch?.refundGasWePaid)
  }

  static gasCounted(ch, gas, relayPaid) {
    return Math.max(Refunds.gasAlreadyPaid(ch, gas), Number.isSafeInteger(relayPaid) && relayPaid > 0 ? relayPaid : 0)
  }

  static gasOf(gasInfo) {
    return gasInfo.alreadyPaid > 0 ? 'its deposit, its refund, the further deposits and earlier refunds ZEAM paid for' : 'its deposit, its refund'
  }

  static rule(cfg, gasInfo, pay) {
    return `${refundRule(Math.round((cfg.gasBuffer - 1) * 100), pay)} Our fee is ${percent(cfg.feeShare)}% of what the buyer spent: $${Refunds.usd(gasInfo.feeMicroUSD)} on this channel, under the $${Refunds.usd(gasInfo.coverMicroUSD)} of gas it must cover (${Refunds.gasOf(gasInfo)} and the calls not yet settled, the margin included)`
  }

  async gasPaymentProblem(ch, asset, payTo, units, left, p) {
    const a = p.authorization
    if (a === null || Object.values(a).some((v) => v === null) || p.signature === null) return 'gasPayment is {authorization: {from, to, value, validAfter, validBefore, nonce}, signature}'
    if (!Address.equals(a.from, this.escrows.of(ch).payer(ch.channelConfig))) return "gasPayment must come from the channel's payer"
    if (!Address.equals(a.to, payTo)) return `gasPayment must go to the relay gas wallet ${payTo}`
    if (!/^\d+$/.test(a.value) || n(a.value) < n(units)) return `gasPayment is ${a.value}; sending costs ${units}`
    if (n(a.value) > n(left)) return `gasPayment is ${a.value}, over the ${left} refund`
    const nowSecs = BigInt(Math.floor(this.cfg.nowMs() / 1000))
    if (!/^\d+$/.test(a.validAfter) || n(a.validAfter) > nowSecs) return 'gasPayment is not valid yet'
    if (!/^\d+$/.test(a.validBefore) || n(a.validBefore) < nowSecs + BigInt(Refunds.GAS_PAYMENT_MARGIN_SECS)) return 'gasPayment expires too soon'
    if (!Hex.isHex(a.nonce, 32)) return 'gasPayment nonce is not 32 bytes'
    let signer = null
    try {
      signer = Secp256k1.isCanonical(p.signature) ? await Secp256k1.recoverHash(Token.transferDigest(Refunds.tokenDomain(this.cfg, asset), a), p.signature) : null
    } catch {
      signer = null
    }
    if (signer === null || !Address.equals(signer, a.from)) return "gasPayment signature is not the payer's"
    return null
  }

  static tokenDomain(cfg, asset) {
    return Token.domain(asset.address, asset.name, asset.version ?? '1', cfg.chainId)
  }

  gasQuote(ch, asset, payTo, units, amounts, gasInfo, why, extra = {}) {
    const nowSecs = Math.floor(this.cfg.nowMs() / 1000)
    const authorization = {
      from: Address.checksum(this.escrows.of(ch).payer(ch.channelConfig)),
      to: Address.checksum(payTo),
      value: String(units),
      validAfter: '0',
      validBefore: String(nowSecs + Math.trunc(Number(this.cfg.gasPaymentSecs))),
      nonce: '0x' + randomBytes(32).toString('hex'),
    }
    const gas = this.microUSD(ch, units)
    const d = gasInfo.detail
    const lead = why === null ? '' : `${why}. `
    return Refunds.answer(409, {
      op: 'refund_quote',
      code: 'gas_payment_needed',
      why: `${lead}${Refunds.rule(this.cfg, gasInfo, d.marginPercent)}. Refund gas: $${Refunds.usd(gas)} USDC, no ETH (${d.gasUnits} gas, L1 fee ${d.l1FeeWei} wei, ${d.gasPriceWei} wei per gas, $${d.ethUSD} per ETH, ${d.marginPercent}% margin; ${d.quotedBy === 'relay' ? 'priced by the relay' : 'priced from measured refunds'}). Sign authorization (EIP-3009 TransferWithAuthorization; typed data in sign) and POST again with gasPayment: {authorization, signature} within ${Math.trunc(Number(this.cfg.gasPaymentSecs))}s. The refund of $${Refunds.usd(amounts.leftMicroUSD)} and the gas payment go in one transaction: $${Refunds.usd(amounts.leftMicroUSD - gas)} net to you. Or send ${Refunds.SELF_SEND} for a signed refund of the full balance, sent from any wallet at your own gas.`,
      ...amounts,
      gasMicroUSD: gas,
      ...d,
      ...extra,
      payTo: authorization.to,
      authorization,
      sign: Token.transferTypedData(Refunds.tokenDomain(this.cfg, asset), authorization),
    })
  }

  static bundledClaim(ch, live) {
    const charged = n(ch.chargedCumulativeAmount ?? '0')
    if (charged <= n(live.claimed) || empty(ch.signature) || empty(ch.signedMaxClaimable)) return 0n
    return charged - n(live.claimed)
  }

  async refundCall(ch, live, left, nonce) {
    return this.escrows.of(ch).refundCall(this.cfg.signingKey(), ch, left, nonce, this.cfg.chainId, Refunds.bundledClaim(ch, live) > 0n)
  }

  async sendRefundNow(ch, call, left, gasMicroUSD, amounts = {}, freeGasUnits = 0) {
    const id = String(ch.channelId).toLowerCase()
    const escrow = this.escrows.of(ch)
    const sent = await this.relay.send([call], this.cfg.relaySplit())
    if (sent[0]?.hash === undefined) {
      const error = String(sent[0]?.error ?? 'the relay did not send the refund')
      const numbers = { leftMicroUSD: amounts.leftMicroUSD, gasMicroUSD, feeMicroUSD: amounts.feeMicroUSD, coverMicroUSD: amounts.coverMicroUSD }
      if (gasMicroUSD > 0 && sent[0]?.code === 'underpaid') return { underpaid: Math.max(1, Math.trunc(Number(sent[0].gasMicroUSD ?? 0))) }
      return Refunds.failed(409, 'refund_error', error.slice(0, 160), { retry_after_seconds: Refunds.RETRY_SECS, ...numbers })
    }
    let after = null
    const tries = Math.max(1, Math.trunc(Number(this.cfg.drainTries)))
    for (let i = 0; i < tries; i++) {
      try {
        after = await this.chain.live(id, escrow)
      } catch {
        after = null
      }
      if (after !== null && n(after.balance) <= n(after.claimed)) break
      if (i + 1 < Math.trunc(Number(this.cfg.drainTries))) await this.cfg.sleepMs(this.cfg.drainWaitMs)
    }
    const drained = after !== null && n(after.balance) <= n(after.claimed)
    let state = null
    await this.channels.update(id, (r) => {
      if (r === null) return null
      if (gasMicroUSD === 0 && freeGasUnits > 0) r.refundGasWePaid = Refunds.gasAlreadyPaid({ refundGasWePaid: r.refundGasWePaid }, this.cfg.gas) + freeGasUnits
      if (after !== null) {
        r.balance = after.balance
        r.repairedAt = this.cfg.nowMs()
        r.totalClaimed = after.claimed
        r.chargedCumulativeAmount = after.claimed
        r.refundNonce = Math.trunc(Number(r.refundNonce ?? 0)) + 1
        delete r.signedMaxClaimable
        delete r.signature
        delete r.pendingRequest
        delete r.handedOver
      } else if (n(ch.chargedCumulativeAmount ?? '0') < n(r.chargedCumulativeAmount ?? '0')) {
        r.chargedCumulativeAmount = ch.chargedCumulativeAmount
      }
      return r
    })
    if (after !== null) state = { channelId: id, balance: after.balance, totalClaimed: after.claimed, chargedCumulativeAmount: after.claimed }
    const timeMs = this.cfg.meter ? await this.cfg.meter.forget(id) : 0
    const returned = this.microUSD(ch, left)
    const body = { op: 'refunded', microUSD: returned, returnedMicroUSD: returned, gasMicroUSD, transaction: sent[0].hash, drained, ...(timeMs > 0 ? { timeReturnedMs: timeMs } : {}) }
    body.why = gasMicroUSD > 0
      ? `refund $${Refunds.usd(returned)} and your gas payment $${Refunds.usd(gasMicroUSD)} sent in one transaction: $${Refunds.usd(returned - gasMicroUSD)} net to you`
      : `refund $${Refunds.usd(returned)} sent; ZEAM paid the gas`
    if (state !== null) body.channelState = state
    return Refunds.answer(200, body)
  }

  async handOver(ch, live, call, left, nonce) {
    const id = String(ch.channelId).toLowerCase()
    const now = this.cfg.nowMs()
    const transaction = { chainId: this.cfg.chainId, to: Address.checksum(call.to), data: call.data, value: '0' }
    try {
      await this.channels.update(id, (r) => {
        if (r === null) return null
        const before = r.balance ?? '0'
        const rest = n(before) - n(left)
        r.balance = rest > 0n ? rest.toString() : '0'
        if (n(ch.chargedCumulativeAmount ?? '0') < n(r.chargedCumulativeAmount ?? '0')) r.chargedCumulativeAmount = ch.chargedCumulativeAmount
        r.handedOver = { units: String(left), chainBalance: String(live.balance), nonce: String(nonce), at: now, transaction }
        return r
      })
    } catch (e) {
      return Refunds.failed(409, 'refund_error', message(e).slice(0, 160), { retry_after_seconds: Refunds.RETRY_SECS })
    }
    const timeMs = this.cfg.meter ? await this.cfg.meter.forget(id) : 0
    return Refunds.answer(200, { op: 'refund_signed', microUSD: this.microUSD(ch, left), transaction, why: 'signed refund of the full balance; send it from any wallet at your own gas', ...(timeMs > 0 ? { timeReturnedMs: timeMs } : {}) })
  }
}
