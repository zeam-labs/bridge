import { InvalidArgument } from '../core/hex.mjs'

export const SETTLES = Object.freeze(['at-most', 'exact'])

export const ESCROW_VALUES = Object.freeze(['kind', 'scheme', 'address', 'contracts', 'settles', 'fromBlock', 'gas', 'reasons', 'configFields'])

export const ESCROW_FUNCTIONS = Object.freeze([
  'config', 'strictConfig', 'channelId', 'termsError', 'sellerMismatch',
  'payer', 'signer', 'owners', 'token',
  'voucherDigest', 'stale',
  'accepts', 'transferTarget', 'fundingDigest', 'funding',
  'depositCall', 'claimCall', 'refundCall', 'collectCall',
  'readChannel', 'readClosing', 'readRefundNonce', 'readPayee',
  'collectedFilter', 'collectedIsFor', 'collectedAmount',
])

export const ESCROW_GAS = Object.freeze(['deposit', 'claimBase', 'claimEntry', 'claimAlone', 'refund', 'refundClaim', 'paidClaim', 'paidL1', 'paidClaimL1'])

export const CLOSES = Object.freeze(['amount', 'whole'])

export const ESCROW_OPTIONAL_FUNCTIONS = Object.freeze(['ready', 'payee', 'graceSecs', 'claimView', 'claimCalls', 'prepareCalls', 'openCall', 'topUpCall', 'closeCall', 'readState'])

export const ESCROW_OPTIONAL_GAS = Object.freeze(['topUp', 'payout', 'createPayee', 'exitRequest', 'exitWithdraw'])

export const ESCROW_REASONS = Object.freeze([
  'CHANNEL_NOT_FOUND', 'TOKEN_MISMATCH', 'VOUCHER_SIGNATURE', 'EXCEEDS_BALANCE', 'BELOW_CLAIMED', 'INSUFFICIENT_BALANCE',
  'DEPOSIT_TRANSACTION_FAILED', 'INVALID_SCHEME', 'NETWORK_MISMATCH', 'MISSING_EIP712_DOMAIN', 'VALID_BEFORE', 'VALID_AFTER',
  'RECEIVE_AUTHORIZATION_SIGNATURE', 'ERC3009_AUTHORIZATION_REQUIRED', 'PAYLOAD_TYPE', 'CHANNEL_ID_MISMATCH', 'CHANNEL_ID_INVALID',
  'DEPOSIT_SIMULATION_FAILED', 'FACTORY_NOT_ALLOWED', 'RPC_READ_FAILED', 'PERMIT2_AUTHORIZATION_REQUIRED', 'PERMIT2_INVALID_SPENDER',
  'PERMIT2_AMOUNT_MISMATCH', 'PERMIT2_DEADLINE_EXPIRED', 'PERMIT2_INVALID_SIGNATURE', 'PERMIT2_ALLOWANCE_REQUIRED',
  'CUMULATIVE_AMOUNT_MISMATCH', 'CHANNEL_BUSY', 'VERIFICATION_STATE_UNAVAILABLE', 'CHARGE_EXCEEDS_SIGNED_CUMULATIVE', 'MISSING_CHANNEL',
])

export function uint(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'string') {
    const v = value.trim()
    if (/^[0-9]+$/.test(v)) return BigInt(v)
    if (/^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v)
  }
  throw new InvalidArgument('not an unsigned integer: ' + (['string', 'number', 'boolean', 'bigint'].includes(typeof value) ? String(value) : typeof value))
}

export class UnknownEscrow extends Error {
  constructor(kind) {
    super(`no escrow of kind ${JSON.stringify(kind)} is served here`)
    this.code = 'unknown_escrow'
    this.kind = kind
  }
}

export function defineEscrow(adapter) {
  if (adapter === null || typeof adapter !== 'object') throw new TypeError('an escrow adapter is an object')
  for (const k of ESCROW_VALUES) if (adapter[k] === undefined || adapter[k] === null) throw new TypeError(`an escrow adapter states ${k}`)
  for (const k of ['kind', 'scheme', 'address', 'configFields']) if (typeof adapter[k] !== 'string' || adapter[k] === '') throw new TypeError(`an escrow adapter's ${k} is a string`)
  if (!SETTLES.includes(adapter.settles)) throw new TypeError(`an escrow adapter settles ${SETTLES.join(' or ')}`)
  for (const k of ESCROW_FUNCTIONS) if (typeof adapter[k] !== 'function') throw new TypeError(`an escrow adapter provides ${k}()`)
  for (const k of ESCROW_GAS) if (!Number.isFinite(adapter.gas[k]) || adapter.gas[k] < 0) throw new TypeError(`an escrow adapter's gas table has ${k}`)
  for (const k of ESCROW_OPTIONAL_GAS) if (adapter.gas[k] !== undefined && (!Number.isFinite(adapter.gas[k]) || adapter.gas[k] < 0)) throw new TypeError(`an escrow adapter's gas table has ${k} as units of gas`)
  for (const k of ESCROW_OPTIONAL_FUNCTIONS) if (adapter[k] !== undefined && typeof adapter[k] !== 'function') throw new TypeError(`an escrow adapter's ${k} is a function`)
  if (adapter.closes !== undefined && !CLOSES.includes(adapter.closes)) throw new TypeError(`an escrow adapter closes ${CLOSES.join(' or ')}`)
  for (const k of ESCROW_REASONS) if (typeof adapter.reasons[k] !== 'string' || adapter.reasons[k] === '') throw new TypeError(`an escrow adapter's reasons name ${k}`)
  return Object.freeze(adapter)
}

export class Escrows {
  constructor(list) {
    if (!Array.isArray(list) || list.length === 0) throw new TypeError('an engine serves at least one escrow')
    this.list = Object.freeze(list.map(defineEscrow))
    for (const k of ['kind', 'scheme']) {
      if (new Set(this.list.map((e) => e[k])).size !== this.list.length) throw new TypeError(`two escrows share a ${k}`)
    }
    this.default = this.list[0]
  }

  named(kind) {
    const found = this.list.find((e) => e.kind === kind)
    if (found === undefined) throw new UnknownEscrow(kind)
    return found
  }

  of(record) {
    const kind = record === null || record === undefined ? undefined : record.escrow
    return kind === undefined || kind === null ? this.default : this.named(kind)
  }

  find(record) {
    try {
      return this.of(record)
    } catch (e) {
      if (e instanceof UnknownEscrow) return null
      throw e
    }
  }

  offering(scheme) {
    return this.list.find((e) => e.scheme === scheme) ?? null
  }

  tag(escrow) {
    return escrow === this.default ? {} : { escrow: escrow.kind }
  }

  split(cfg, escrow) {
    return typeof escrow.payee === 'function' ? { ...cfg.relaySplit(), signer: cfg.receiverAuthorizer } : cfg.relaySplit()
  }

  gas(cfg, escrow) {
    return escrow === this.default ? cfg.gas : { ...cfg.gas, ...escrow.gas }
  }

  view(escrow, record) {
    return typeof escrow.claimView === 'function' ? escrow.claimView(record) : record
  }

  async claimCalls(escrow, key, records, chainId, clock = null) {
    if (typeof escrow.claimCalls === 'function') return escrow.claimCalls(key, records, chainId, clock === null ? undefined : await clock())
    const call = await escrow.claimCall(key, records, chainId)
    return [{ what: `claim ${records.length} voucher(s)`, to: call.to, data: call.data }]
  }

  async prepareCalls(escrow, chain) {
    return typeof escrow.prepareCalls === 'function' ? escrow.prepareCalls(chain) : []
  }
}
