const isArrayLike = (v) => v !== null && typeof v === 'object'

export const Json = {
  encode(value) {
    const out = JSON.stringify(value)
    if (out === undefined) throw new Error('not encodable as JSON')
    return out.replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'))
  },
  base64(value) {
    return Buffer.from(Json.encode(value), 'utf8').toString('base64')
  },
  sharing() {
    const parts = new WeakMap()
    const part = (v) => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v) === undefined ? undefined : Json.encode(v)
      if (!parts.has(v)) parts.set(v, Json.encode(v))
      return parts.get(v)
    }
    return (doc) => {
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.toJSON === 'function') return Json.encode(doc)
      const out = []
      for (const k of Object.keys(doc)) {
        const p = part(doc[k])
        if (p !== undefined) out.push(`${Json.encode(k)}:${p}`)
      }
      return `{${out.join(',')}}`
    }
  },
  decodeHeader(value) {
    if (typeof value !== 'string' || value.trim() === '') return null
    const clean = value.trim().replace(/[^A-Za-z0-9+/]/g, '')
    const raw = Buffer.from(clean, 'base64').toString('utf8')
    if (raw === '') return null
    try {
      const decoded = JSON.parse(raw)
      return isArrayLike(decoded) ? decoded : null
    } catch {
      return null
    }
  },
  isList(value) {
    return Array.isArray(value) || (isArrayLike(value) && Object.keys(value).length === 0)
  },
  normalize(value) {
    if (!isArrayLike(value)) return value
    if (Array.isArray(value)) return value.map(Json.normalize)
    if (Object.keys(value).length === 0) return []
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = Json.normalize(value[k])
    return out
  },
  deepEqual(a, b) {
    return Json.encode(Json.normalize(a)) === Json.encode(Json.normalize(b))
  },
  containsSubset(expected, actual) {
    if (!isArrayLike(expected) || Json.isList(expected)) return Json.deepEqual(expected, actual)
    if (!isArrayLike(actual) || (Array.isArray(actual) && actual.length > 0)) return false
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) return false
      if (!Json.containsSubset(value, actual[key])) return false
    }
    return true
  },
}

export const Reason = {
  CHANNEL_NOT_FOUND: 'invalid_batch_settlement_evm_channel_not_found',
  TOKEN_MISMATCH: 'invalid_batch_settlement_evm_token_mismatch',
  VOUCHER_SIGNATURE: 'invalid_batch_settlement_evm_voucher_signature',
  EXCEEDS_BALANCE: 'invalid_batch_settlement_evm_cumulative_exceeds_balance',
  BELOW_CLAIMED: 'invalid_batch_settlement_evm_cumulative_below_claimed',
  INSUFFICIENT_BALANCE: 'invalid_batch_settlement_evm_insufficient_balance',
  DEPOSIT_TRANSACTION_FAILED: 'invalid_batch_settlement_evm_deposit_transaction_failed',
  INVALID_SCHEME: 'invalid_batch_settlement_evm_scheme',
  NETWORK_MISMATCH: 'invalid_batch_settlement_evm_network_mismatch',
  MISSING_EIP712_DOMAIN: 'invalid_batch_settlement_evm_missing_eip712_domain',
  VALID_BEFORE: 'invalid_batch_settlement_evm_payload_authorization_valid_before',
  VALID_AFTER: 'invalid_batch_settlement_evm_payload_authorization_valid_after',
  RECEIVE_AUTHORIZATION_SIGNATURE: 'invalid_batch_settlement_evm_receive_authorization_signature',
  ERC3009_AUTHORIZATION_REQUIRED: 'invalid_batch_settlement_evm_erc3009_authorization_required',
  PAYLOAD_TYPE: 'invalid_batch_settlement_evm_payload_type',
  CHANNEL_ID_MISMATCH: 'invalid_batch_settlement_evm_channel_id_mismatch',
  CHANNEL_ID_INVALID: 'invalid_batch_settlement_evm_channel_id_invalid',
  DEPOSIT_SIMULATION_FAILED: 'invalid_batch_settlement_evm_deposit_simulation_failed',
  FACTORY_NOT_ALLOWED: 'invalid_batch_settlement_evm_eip6492_factory_not_allowed',
  RPC_READ_FAILED: 'invalid_batch_settlement_evm_rpc_read_failed',
  PERMIT2_AUTHORIZATION_REQUIRED: 'invalid_batch_settlement_evm_permit2_authorization_required',
  PERMIT2_INVALID_SPENDER: 'invalid_batch_settlement_evm_permit2_invalid_spender',
  PERMIT2_AMOUNT_MISMATCH: 'invalid_batch_settlement_evm_permit2_amount_mismatch',
  PERMIT2_DEADLINE_EXPIRED: 'invalid_batch_settlement_evm_permit2_deadline_expired',
  PERMIT2_INVALID_SIGNATURE: 'invalid_batch_settlement_evm_permit2_invalid_signature',
  PERMIT2_ALLOWANCE_REQUIRED: 'invalid_batch_settlement_evm_permit2_allowance_required',
  CUMULATIVE_AMOUNT_MISMATCH: 'invalid_batch_settlement_evm_cumulative_amount_mismatch',
  CHANNEL_BUSY: 'invalid_batch_settlement_evm_channel_busy',
  VERIFICATION_STATE_UNAVAILABLE: 'invalid_batch_settlement_evm_verification_state_unavailable',
  CHARGE_EXCEEDS_SIGNED_CUMULATIVE: 'invalid_batch_settlement_evm_charge_exceeds_signed_cumulative',
  MISSING_CHANNEL: 'invalid_batch_settlement_evm_missing_channel',
  REFUND_SETTLING: 'refund_settling',
}

export class ArrayCache {
  constructor(clock = null) {
    this.items = new Map()
    this.clock = clock
  }

  now() {
    return this.clock ? Number(this.clock()) : Date.now()
  }

  get(key) {
    const hit = this.items.get(key)
    if (!hit) return null
    if (hit[1] < this.now()) {
      this.items.delete(key)
      return null
    }
    return hit[0]
  }

  set(key, value, ttlSeconds) {
    this.items.set(key, [value, this.now() + 1000 * Number(ttlSeconds)])
  }
}
