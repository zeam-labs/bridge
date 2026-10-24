import { createHmac } from 'node:crypto'
import { Address, Hex, big } from '../core/hex.mjs'
import { Erc20 } from '../core/batch.mjs'
import { Pass } from '../core/pass.mjs'
import { Secp256k1 } from '../core/secp256k1.mjs'
import { ArrayCache } from './json.mjs'

const GAS = { deposit: 145000, claimBase: 35000, claimEntry: 45000, claimAlone: 80000, payout: 210000, charge: 105000, createSplit: 280000, refund: 118000, refundClaim: 37000, paidRefundLeg: 97000, paidClaim: 37700, gasPayment: 58600, paidL1: 13800, paidClaimL1: 4200 }
const GAS_MEASURED = { on: '2026-09-29', how: '35 paid relay refunds, Base blocks 51915440-51949669 (25 alone, 10 with a riding claim); gasUsed + L1 fee in gas', paidRefund: 155625, paidRefundWithClaim: 193332, paidL1: 13830, paidL1WithClaim: 18059 }
const TUNABLE = [
  'withdrawDelay', 'maxTimeoutSeconds', 'depositFloorMicroUSD', 'wethUSD', 'gasPriceWei', 'feeShare', 'gasBuffer',
  'floorMargin', 'idleClaimSecs', 'maxClaimsPerBatch', 'payoutMinUnits', 'refundWindowSecs', 'refundUrl',
  'receiptTimeoutSecs', 'receiptPollMs', 'stateCatchUpMs', 'drainTries', 'drainWaitMs', 'repairEveryMs', 'gasPaymentSecs', 'refundJudgeWaitMs',
]
const SECRET = Symbol('receiverAuthorizerKey')

export class Config {
  static NETWORK = 'eip155:8453'
  static CHAIN_ID = 8453
  static SCHEME = 'batch-settlement'
  static WITHDRAW_DELAY = 86400
  static MAX_TIMEOUT_SECONDS = 240
  static DRAIN_WAIT_MS = 2000
  static FEE_SHARE = 0.0999
  static GAS = GAS
  static GAS_MEASURED = GAS_MEASURED

  constructor(o) {
    for (const k of ['name', 'priceMicroUSD', 'payout', 'feeRecipient', 'receiverAuthorizerKey', 'relayUrl', 'rpcUrl']) {
      if (o[k] === undefined || o[k] === null || o[k] === '') throw new TypeError(`settlement config is missing ${k}`)
    }
    this.name = String(o.name)
    this.site = o.site !== undefined && o.site !== null ? String(o.site) : ''
    this.priceMicroUSD = Math.trunc(Number(o.priceMicroUSD))
    if (!(this.priceMicroUSD >= 1)) throw new TypeError('the price is at least one micro-USD')
    this.payout = Address.checksum(o.payout)
    this.feeRecipient = Address.checksum(o.feeRecipient)
    this.payoutIsFeeRecipient = o.payoutIsFeeRecipient === true
    const seller = Pass.sellerSplit(this.payout, this.feeRecipient, this.name, this.payoutIsFeeRecipient)
    this.split = seller.split
    this.salt = seller.salt
    this.receiver = seller.address
    if (o.receiver !== undefined && o.receiver !== null && !Address.equals(o.receiver, this.receiver)) throw new TypeError('the receiver is not the split predicted for this seller')
    Object.defineProperty(this, SECRET, { value: Secp256k1.normalizePrivateKey(o.receiverAuthorizerKey), enumerable: false })
    this.receiverAuthorizer = Secp256k1.privateKeyToAddress(this[SECRET])
    this.relayUrl = String(o.relayUrl).replace(/\/+$/, '')
    this.rpcUrl = typeof o.rpcUrl === 'string' ? o.rpcUrl : o.rpcUrl
    this.network = Config.NETWORK
    this.chainId = Config.CHAIN_ID
    this.withdrawDelay = Config.WITHDRAW_DELAY
    this.maxTimeoutSeconds = Config.MAX_TIMEOUT_SECONDS
    this.depositFloorMicroUSD = null
    this.wethUSD = null
    this.gasPriceWei = null
    this.feeShare = this.payoutIsFeeRecipient ? 1 : Config.FEE_SHARE
    this.gas = { ...GAS }
    this.gasBuffer = 1.15
    this.floorMargin = 1.25
    this.idleClaimSecs = 20
    this.maxClaimsPerBatch = 50
    this.payoutMinUnits = 1
    this.refundWindowSecs = 300
    this.refundUrl = null
    this.receiptTimeoutSecs = 60
    this.receiptPollMs = 1000
    this.stateCatchUpMs = 2000
    this.drainTries = 15
    this.drainWaitMs = Config.DRAIN_WAIT_MS
    this.repairEveryMs = 60000
    this.gasPaymentSecs = 300
    this.refundJudgeWaitMs = 5000
    for (const k of TUNABLE) if (Object.hasOwn(o, k) && o[k] !== undefined) this[k] = o[k]
    this.withdrawDelay = Math.trunc(Number(this.withdrawDelay))
    this.maxTimeoutSeconds = Math.trunc(Number(this.maxTimeoutSeconds))
    if (o.gas && typeof o.gas === 'object') this.gas = { ...GAS, ...o.gas }
    this.assets = (o.assets ?? [Config.usdc()]).map(Config.asset)
    if (!this.assets.length) throw new TypeError('a seller accepts at least one asset')
    this.clock = typeof o.clock === 'function' ? o.clock : null
    this.sleeper = typeof o.sleep === 'function' ? o.sleep : null
    this.cache = o.cache && typeof o.cache.get === 'function' && typeof o.cache.set === 'function' ? o.cache : new ArrayCache(this.clock)
  }

  static usdc() {
    return { symbol: 'USDC', address: Erc20.USDC_BASE, decimals: 6, name: Erc20.USDC_BASE_NAME, version: Erc20.USDC_BASE_VERSION, eip3009: true, priceUSD: 1 }
  }

  static asset(a) {
    for (const k of ['symbol', 'address', 'decimals']) if (a[k] === undefined || a[k] === null) throw new TypeError(`an asset is missing ${k}`)
    return {
      symbol: String(a.symbol),
      address: Address.checksum(a.address),
      decimals: Math.trunc(Number(a.decimals)),
      name: a.name !== undefined && a.name !== null ? String(a.name) : null,
      version: a.version !== undefined && a.version !== null ? String(a.version) : null,
      eip3009: !!a.eip3009 && a.name !== undefined && a.name !== null,
      priceUSD: a.priceUSD !== undefined && a.priceUSD !== null ? Number(a.priceUSD) : 1.0,
    }
  }

  assetOf(token) {
    return this.assets.find((a) => Address.equals(a.address, String(token))) ?? null
  }

  unitsOfMicroUSD(asset, microUSD) {
    if (asset.decimals === 6 && Number(asset.priceUSD) === 1) return String(Math.max(1, Math.trunc(Number(microUSD))))
    const units = Math.round((Number(microUSD) / 1e6 / Number(asset.priceUSD)) * 10 ** asset.decimals)
    const whole = Math.max(1, units)
    return Number.isFinite(whole) && whole >= 1e21 ? BigInt(whole).toString() : whole.toFixed(0)
  }

  microUSDOf(token, units) {
    const asset = token !== null && typeof token === 'object' ? token : this.assetOf(token)
    if (asset === null) return null
    const n = big(String(units))
    if (asset.decimals === 6 && Number(asset.priceUSD) === 1) return Number(n)
    return Math.round((Number(n) / 10 ** asset.decimals) * Number(asset.priceUSD) * 1e6)
  }

  priceUnits(asset) {
    return this.unitsOfMicroUSD(asset, this.priceMicroUSD)
  }

  relaySplit() {
    return {
      split: { recipients: this.split.recipients, allocations: this.split.allocations, totalAllocation: this.split.totalAllocation, distributionIncentive: Math.trunc(Number(this.split.distributionIncentive)) },
      salt: Hex.lower(this.salt),
      receiver: this.receiver,
    }
  }

  signingKey() {
    return this[SECRET]
  }

  mppSecret() {
    return createHmac('sha256', Hex.toBytes(this[SECRET])).update('zeam-pass/mpp-challenge-binding', 'utf8').digest()
  }

  nowMs() {
    return this.clock ? Math.trunc(Number(this.clock())) : Date.now()
  }

  async sleepMs(ms) {
    if (ms <= 0) return
    if (this.sleeper) return void (await this.sleeper(ms))
    await new Promise((r) => setTimeout(r, ms))
  }

  toJSON() {
    const out = { ...this }
    out.receiverAuthorizerKey = '(hidden)'
    delete out.cache
    return out
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.toJSON()
  }
}
