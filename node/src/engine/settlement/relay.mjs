import { Address, Hex, big, isNumeric } from '../core/hex.mjs'
import { Splits } from '../core/pass.mjs'
import { Json } from './json.mjs'
import { ESCROWS } from './x402.mjs'
import { mulDiv } from '../pricing.mjs'

export function httpTransport(fetchFn = globalThis.fetch) {
  return async (method, url, body, timeout) => {
    const headers = { accept: 'application/json' }
    if (body !== null && body !== undefined) headers['content-type'] = 'application/json'
    const r = await fetchFn(url, { method, headers, body: body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, timeout * 1000)) })
    return { status: r.status, body: await r.text() }
  }
}

export class Relay {
  constructor(url, transport = null, timeout = 300) {
    if (!/^https?:\/\//i.test(String(url))) throw new TypeError('a relay URL starts with http:// or https://')
    this.url = String(url).replace(/\/+$/, '')
    this.transport = transport ?? httpTransport()
    this.timeout = Number(timeout)
  }

  async send(calls, split, outcome = false) {
    const body = { calls: calls.map((c) => ({ to: Address.checksum(c.to), data: Hex.lower(c.data) })), split }
    let r
    try {
      r = await this.transport('POST', `${this.url}/relay`, Json.encode(body), this.timeout)
    } catch (e) {
      r = { status: 0, body: '', error: e?.message ?? String(e) }
    }
    let decoded = null
    try {
      decoded = typeof r?.body === 'string' ? JSON.parse(r.body) : null
    } catch {
      decoded = null
    }
    const status = Number(r?.status ?? 0) | 0
    const fallback = decoded && typeof decoded === 'object' && typeof decoded.error === 'string' ? decoded.error : r?.error !== undefined ? `the relay did not answer: ${r.error}` : `the relay answered ${status}`
    const results = decoded && typeof decoded === 'object' && Array.isArray(decoded.results) ? decoded.results : []
    return calls.map((_, i) => {
      const one = results[i] !== null && typeof results[i] === 'object' ? results[i] : null
      if (one && Hex.isHex(one.hash, 32)) return { hash: one.hash.toLowerCase() }
      const out = { error: one && one.error !== undefined && one.error !== null ? String(one.error) : fallback }
      if (one && typeof one.code === 'string') out.code = one.code
      if (outcome && one && one.reverted === true) out.reverted = true
      else if (outcome && status >= 400 && status < 500) out.refused = true
      else if (outcome && status === 0) out.unheard = true
      if (one && isNumeric(one.gasMicroUSD) && Number(one.gasMicroUSD) > 0) out.gasMicroUSD = Math.ceil(Number(one.gasMicroUSD))
      return out
    })
  }

  async sendQuote(calls, split) {
    let r
    try {
      r = await this.transport('POST', `${this.url}/quote`, Json.encode({ calls: calls.map((c) => ({ to: Address.checksum(c.to), data: Hex.lower(c.data) })), split }), 10)
    } catch {
      return null
    }
    if (!r || Number(r.status) !== 200) return null
    let d = null
    try {
      d = typeof r.body === 'string' ? JSON.parse(r.body) : null
    } catch {
      return null
    }
    return d !== null && typeof d === 'object' && d.op === 'send_quote' && typeof d.covered === 'boolean' ? d : null
  }

  async quote(call, payment = true, split = null) {
    let r
    try {
      r = await this.transport('POST', `${this.url}/quote`, Json.encode({ call: { to: Address.checksum(call.to), data: Hex.lower(call.data) }, payment: !!payment, ...(split === null ? {} : { split }) }), 10)
    } catch {
      return null
    }
    return Relay.quoted(r)
  }

  async shapeQuote(claim, payment = true) {
    let r
    try {
      r = await this.transport('GET', `${this.url}/quote?claim=${claim ? 1 : 0}&payment=${payment ? 1 : 0}`, null, 5)
    } catch {
      return null
    }
    return Relay.quoted(r)
  }

  static quoted(r) {
    if (!r || Number(r.status) !== 200) return null
    let d
    try {
      d = JSON.parse(String(r.body))
    } catch {
      return null
    }
    if (d === null || typeof d !== 'object') return null
    const pos = (v) => isNumeric(v) && Number(v) > 0
    if (!pos(d.quoteMicroUSD) || !pos(d.costMicroUSD) || !pos(d.gasUnits) || !pos(d.ethUSD) || !isNumeric(d.marginPercent) || !/^\d+$/.test(String(d.gasPriceWei)) || !/^\d+$/.test(String(d.l1FeeWei))) return null
    if (Number(d.quoteMicroUSD) < Number(d.costMicroUSD)) return null
    const units = Math.trunc(Number(d.gasUnits))
    const margin = Number(d.marginPercent)
    return { microUSD: Math.ceil(Number(d.quoteMicroUSD)), costMicroUSD: Math.ceil(Number(d.costMicroUSD)), gasUnits: units, gasUnitsWithMargin: Math.ceil(units * (1 + margin / 100)), gasPriceWei: String(d.gasPriceWei), ethUSD: Number(d.ethUSD), marginPercent: margin, l1FeeWei: String(d.l1FeeWei), quotedBy: 'relay', ...(typeof d.covered === 'boolean' ? { covered: d.covered } : {}) }
  }

  async paid(channelId) {
    let r
    try {
      r = await this.transport('GET', `${this.url}/paid?channel=${String(channelId).toLowerCase()}`, null, 5)
    } catch {
      return null
    }
    return Relay.paidOf(r, channelId)
  }

  static paidOf(r, channelId) {
    if (!r || Number(r.status) !== 200) return null
    let d
    try {
      d = JSON.parse(String(r.body))
    } catch {
      return null
    }
    if (d === null || typeof d !== 'object' || Array.isArray(d) || d.op !== 'gas_paid') return null
    if (typeof d.channelId !== 'string' || d.channelId.toLowerCase() !== String(channelId).toLowerCase()) return null
    return Number.isSafeInteger(d.gasUnits) && d.gasUnits >= 0 ? d.gasUnits : null
  }

  async health() {
    let r
    try {
      r = await this.transport('GET', `${this.url}/health`, null, 10)
    } catch {
      return null
    }
    if (!r || Number(r.status) !== 200) return null
    try {
      const d = JSON.parse(String(r.body))
      return d !== null && typeof d === 'object' ? d : null
    } catch {
      return null
    }
  }
}

export class GasQuote {
  static QUOTE_TTL = 60
  static RECENT_SECS = 5
  static FLOOR_TTL = 86400 * 30
  static RETRY_SECS = 20
  static RETRY_FIRST_MS = 250
  static RETRY_MOST_MS = 4000
  static RETRY_KEY = 'zeam_pass_gas_retry'

  constructor(cfg, chain, relay = null) {
    this.cfg = cfg
    this.chain = chain
    this.relay = relay
  }

  async ethUSD() {
    const key = 'zeam_pass_eth_usd'
    const hit = this.cfg.cache.get(key)
    if (isNumeric(hit) && Number(hit) > 0) return Number(hit)
    let price = null
    const health = this.relay ? await this.relay.health() : null
    if (health && typeof health === 'object') {
      for (const k of ['wethUSD', 'ethUSD']) {
        if (isNumeric(health[k]) && Number(health[k]) > 0) {
          price = Number(health[k])
          break
        }
      }
      if (price === null && isNumeric(health.prices?.WETH) && Number(health.prices.WETH) > 0) price = Number(health.prices.WETH)
    }
    if (price === null && isNumeric(this.cfg.wethUSD) && Number(this.cfg.wethUSD) > 0) price = Number(this.cfg.wethUSD)
    if (price !== null) this.cfg.cache.set(key, price, GasQuote.QUOTE_TTL)
    return price
  }

  async gasWallet() {
    const key = 'zeam_pass_relay_sender'
    const hit = this.cfg.cache.get(key)
    if (typeof hit === 'string' && Address.isAddress(hit)) return Address.checksum(hit)
    const health = this.relay ? await this.relay.health() : null
    const sender = health && typeof health === 'object' && typeof health.sender === 'string' && Address.isAddress(health.sender) ? Address.checksum(health.sender) : null
    if (sender !== null) this.cfg.cache.set(key, sender, GasQuote.QUOTE_TTL)
    return sender
  }

  async weiPerGas(fresh = false, recent = null) {
    if (this.cfg.gasPriceWei !== null && this.cfg.gasPriceWei !== undefined && this.cfg.gasPriceWei !== '') return String(this.cfg.gasPriceWei)
    const key = 'zeam_pass_gas_price'
    const near = recent === null ? null : this.cfg.cache.get(`${key}_recent`)
    if (recent !== null && typeof near === 'string' && /^\d+$/.test(near)) return near
    const hit = this.cfg.cache.get(key)
    const last = typeof hit === 'string' && /^\d+$/.test(hit) ? hit : null
    if (last !== null && !fresh && recent === null) return last
    const retry = GasQuote.retryOf(this.cfg.cache.get(GasQuote.RETRY_KEY))
    if (last !== null && retry !== null && this.cfg.nowMs() < retry.due) return last
    let wei
    try {
      wei = await this.chain.gasPrice()
    } catch {
      this.missed(retry)
      return last
    }
    this.cfg.cache.set(key, wei, GasQuote.QUOTE_TTL)
    if (recent !== null) this.cfg.cache.set(`${key}_recent`, wei, recent)
    if (retry !== null) this.cfg.cache.set(GasQuote.RETRY_KEY, '', 1)
    return wei
  }

  missed(retry) {
    const now = this.cfg.nowMs()
    const since = retry?.since ?? now
    const left = since + GasQuote.RETRY_SECS * 1000 - now
    if (left <= 0) return this.cfg.cache.set(GasQuote.RETRY_KEY, '', 1)
    const wait = retry === null ? GasQuote.RETRY_FIRST_MS : Math.min(retry.wait * 2, GasQuote.RETRY_MOST_MS)
    this.cfg.cache.set(GasQuote.RETRY_KEY, `${since}:${now + wait}:${wait}`, Math.ceil(left / 1000))
  }

  static retryOf(v) {
    const m = typeof v === 'string' ? /^(\d+):(\d+):(\d+)$/.exec(v) : null
    return m ? { since: Number(m[1]), due: Number(m[2]), wait: Number(m[3]) } : null
  }

  async ethOf(units, fresh = false, recent = null) {
    const wei = await this.weiPerGas(fresh, recent)
    const eth = wei === null ? null : await this.ethUSD()
    if (wei === null || eth === null || big(wei) <= 0n) return null
    return [Number(big(wei) * BigInt(units)) / 1e18, eth, wei]
  }

  async microUSD(units, recent = null) {
    const q = await this.ethOf(Math.round(units), false, recent)
    return q === null ? null : Math.ceil(q[0] * q[1] * 1e6)
  }

  async usd(units) {
    const q = await this.ethOf(Math.ceil(units * this.cfg.gasBuffer))
    return q === null ? null : q[0] * q[1]
  }

  priced(units, wei, eth, l1Units = 0) {
    const buffered = Math.ceil(units * this.cfg.gasBuffer)
    const inEth = Number(big(wei) * BigInt(Math.ceil((units + l1Units) * this.cfg.gasBuffer))) / 1e18
    const costEth = Number(big(wei) * BigInt(units + l1Units)) / 1e18
    return { microUSD: Math.ceil(inEth * eth * 1e6), costMicroUSD: Math.ceil(costEth * eth * 1e6), gasUnits: units, gasUnitsWithMargin: buffered, gasPriceWei: String(wei), ethUSD: eth, marginPercent: Math.round((this.cfg.gasBuffer - 1) * 100), l1FeeWei: String(big(wei) * BigInt(l1Units)), quotedBy: 'engine' }
  }

  async quote(units, fresh = true) {
    const wei = await this.weiPerGas(fresh)
    const eth = wei === null ? null : await this.ethUSD()
    if (wei === null || eth === null || big(wei) <= 0n) return null
    return this.priced(units, wei, eth)
  }

  async refund(claimRides, fresh = true, alreadyPaid = 0) {
    const g = this.cfg.gas
    const wei = await this.weiPerGas(fresh)
    const eth = wei === null ? null : await this.ethUSD()
    if (wei === null || eth === null || big(wei) <= 0n) return null
    return { cover: this.priced(g.deposit + g.refund + (claimRides ? g.refundClaim : 0) + alreadyPaid, wei, eth), pay: this.priced(g.paidRefundLeg + (claimRides ? g.paidClaim : 0) + g.gasPayment, wei, eth, g.paidL1 + (claimRides ? g.paidClaimL1 : 0)) }
  }

  async relayQuote(call) {
    return this.relay && call ? this.relay.quote(call, true) : null
  }

  async relayPaid(channelId) {
    return this.relay ? this.relay.paid(channelId) : null
  }

  async relayRefundQuote() {
    const key = 'zeam_pass_relay_refund_quote'
    const hit = this.cfg.cache.get(key)
    if (hit === 'none') return null
    const cached = typeof hit === 'string' ? /^(\d+)\/(\d+)$/.exec(hit) : null
    if (cached) return { microUSD: Number(cached[1]), marginPercent: Number(cached[2]) }
    const q = this.relay ? await this.relay.shapeQuote(false, true) : null
    const out = q === null ? null : { microUSD: q.microUSD, marginPercent: Math.round(q.marginPercent) }
    this.cfg.cache.set(key, out === null ? 'none' : `${out.microUSD}/${out.marginPercent}`, GasQuote.QUOTE_TTL)
    return out
  }

  static feeMicroUSD(earnedMicroUSD, feeShare) {
    return mulDiv(Math.trunc(Number(earnedMicroUSD)), Math.round(feeShare * 1e6), 1000000)
  }

  async atMargin(usd, units) {
    const gas = await this.usd(units)
    return gas !== null && usd * this.cfg.feeShare >= gas
  }

  async depositFloorMicroUSD(price = this.cfg.priceMicroUSD) {
    const gas = await this.microUSD(this.cfg.gas.deposit)
    const key = 'zeam_pass_deposit_floor'
    if (gas === null) {
      const last = this.cfg.cache.get(key)
      const configured = this.cfg.depositFloorMicroUSD
      return Math.max(price, isNumeric(last) ? Math.trunc(Number(last)) : 0, isNumeric(configured) ? Math.trunc(Number(configured)) : 0)
    }
    const back = await this.refund(true, false)
    const home = back === null ? 0 : Math.ceil(back.pay.microUSD * this.cfg.floorMargin)
    const floor = Math.max(Math.ceil((gas * this.cfg.floorMargin) / this.cfg.feeShare), home)
    this.cfg.cache.set(key, floor, GasQuote.FLOOR_TTL)
    return Math.max(price, floor)
  }
}

export class Payout {
  static DUST = 100

  constructor(cfg, chain, escrow = ESCROWS.default) {
    this.cfg = cfg
    this.chain = chain
    this.escrow = escrow
  }

  async calls(token, claimsRiding = false) {
    const receiver = this.cfg.receiver
    const min = big(String(this.cfg.payoutMinUnits))
    const calls = []
    let incoming = 0n
    const r = await this.chain.receivers(receiver, token, this.escrow)
    const owed = big(r.totalClaimed) - big(r.totalSettled)
    if (claimsRiding || owed >= min) {
      incoming = claimsRiding && owed < min ? min + 1n : owed
      calls.push({ what: claimsRiding ? 'settle what the claims riding with it bring' : `settle ${incoming}`, ...this.escrow.collectCall(receiver, token) })
    }
    const deployed = await this.chain.hasCode(receiver)
    const held = big(deployed ? await this.chain.splitBalance(receiver, token) : await this.chain.balanceOf(token, receiver))
    const heldErc20 = deployed ? big(await this.chain.balanceOf(token, receiver)) : held
    const result = { calls, owed: (owed > 0n ? owed : 0n).toString(), held: heldErc20.toString(), deployed }
    if (held + incoming <= min) return result
    if (incoming === 0n && held < BigInt(Payout.DUST)) return result
    if (!deployed) calls.push({ what: 'create split', to: Splits.PULL_SPLIT_FACTORY, data: Splits.encodeCreateSplitDeterministic(this.cfg.split, Address.ZERO, this.cfg.payout, this.cfg.salt) })
    calls.push({ what: claimsRiding ? 'distribute' : `distribute ${held + incoming}`, to: receiver, data: Splits.encodeDistribute(this.cfg.split, token, Address.ZERO) })
    calls.push({ what: 'pay the seller', to: Splits.WAREHOUSE, data: Splits.encodeWarehouseWithdraw(this.cfg.split.recipients[0], token) })
    result.calls = calls
    return result
  }
}
