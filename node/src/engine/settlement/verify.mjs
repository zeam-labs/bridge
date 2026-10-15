import { Address, InvalidArgument, big, empty, has, isObject } from '../core/hex.mjs'
import { Erc6492 } from '../core/evm.mjs'
import { Secp256k1 } from '../core/secp256k1.mjs'
import { Chain, RpcError } from './chain.mjs'
import { uint } from './escrow.mjs'
import { ESCROWS, PERMIT2_WITNESS_TYPES, ZERO } from './x402.mjs'

const arr = (v) => v !== null && typeof v === 'object'

export class Verify {
  static ZERO = ZERO
  static PERMIT2_WITNESS_TYPES = PERMIT2_WITNESS_TYPES

  constructor(cfg, chain, escrow = ESCROWS.default) {
    this.cfg = cfg
    this.chain = chain
    this.escrow = escrow
  }

  static isVoucherFields(v) {
    return arr(v) && has(v, 'channelId') && has(v, 'maxClaimableAmount') && has(v, 'signature')
  }

  static isDepositPayload(raw) {
    return arr(raw) && raw.type === 'deposit' && has(raw, 'channelConfig') && Verify.isVoucherFields(raw.voucher ?? null) && arr(raw.deposit) && typeof raw.deposit.amount === 'string' && arr(raw.deposit.authorization)
  }

  static isVoucherPayload(raw) {
    return arr(raw) && raw.type === 'voucher' && has(raw, 'channelConfig') && Verify.isVoucherFields(raw.voucher ?? null)
  }

  static isRefundPayload(raw) {
    return arr(raw) && raw.type === 'refund' && has(raw, 'channelConfig') && Verify.isVoucherFields(raw.voucher ?? null)
  }

  static chainIdOf(network) {
    const m = typeof network === 'string' ? /^eip155:(\d+)$/.exec(network) : null
    if (!m) throw new InvalidArgument('not an EVM network: ' + (['string', 'number', 'boolean'].includes(typeof network) ? network : typeof network))
    return Number(m[1])
  }

  static isCanonicalChannelId(id) {
    return typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id)
  }

  static strictConfig(config, escrow = ESCROWS.default) {
    return escrow.strictConfig(config)
  }

  static computeChannelId(config, network, escrow = ESCROWS.default) {
    return escrow.channelId(escrow.strictConfig(config), Verify.chainIdOf(network))
  }

  static bindingError(config, channelId, network, escrow = ESCROWS.default) {
    if (!Verify.isCanonicalChannelId(channelId)) return escrow.reasons.CHANNEL_ID_INVALID
    if (Verify.computeChannelId(config, network, escrow).toLowerCase() !== channelId.toLowerCase()) return escrow.reasons.CHANNEL_ID_MISMATCH
    return null
  }

  static uint(value) {
    return uint(value)
  }

  static amount(value) {
    if (typeof value === 'number') {
      if (Number.isSafeInteger(value) && value >= 0) return BigInt(value)
      throw new InvalidArgument(`not an unsigned integer a JSON number can carry exactly: ${String(value)}`)
    }
    if (typeof value === 'string') return uint(value)
    throw new InvalidArgument(`not an unsigned integer: ${['boolean', 'bigint'].includes(typeof value) ? String(value) : value === null ? 'null' : typeof value}`)
  }

  static AMOUNT_FORM = 'voucher.maxClaimableAmount is not an unsigned integer: send it as a base-10 or 0x string, or as a whole JSON number up to 9007199254740991'

  static normalize(raw) {
    if (!isObject(raw?.voucher) || !has(raw.voucher, 'maxClaimableAmount')) return true
    try {
      raw.voucher.maxClaimableAmount = Verify.amount(raw.voucher.maxClaimableAmount).toString()
      return true
    } catch {
      return false
    }
  }

  configError(config, channelId, req) {
    this.escrow.strictConfig(config)
    return this.escrow.termsError(config, channelId, Verify.chainIdOf(req.network), req)
  }

  async hashSignatureOk(address, digest, signature) {
    let code
    try {
      code = await this.chain.code(address)
    } catch {
      return false
    }
    if (code === '0x' || code === '') {
      if (typeof signature !== 'string' || signature.replace(/^0x/i, '').length !== 130) return false
      return Verify.recovers(address, digest, signature)
    }
    return this.chain.isValidSignature(address, digest, signature)
  }

  static async recovers(address, digest, signature) {
    try {
      return Secp256k1.isCanonical(signature) && Address.equals(await Secp256k1.recoverHash(digest, signature), address)
    } catch {
      return false
    }
  }

  async voucherSignatureOk(config, channelId, max, signature, chainId) {
    let digest
    try {
      digest = this.escrow.voucherDigest(channelId, Verify.uint(max).toString(), chainId)
    } catch {
      return false
    }
    const signer = this.escrow.signer(config)
    return signer.wallet ? this.hashSignatureOk(signer.address, digest, signature) : Verify.recovers(signer.address, digest, signature)
  }

  static invalid(reason, payer = null, message = null) {
    const out = { isValid: false, invalidReason: reason }
    if (message !== null) out.invalidMessage = message
    if (payer !== null) out.payer = payer
    return out
  }

  async facilitator(payload, req) {
    const raw = payload.payload ?? null
    const accepted = arr(payload.accepted) ? payload.accepted : {}
    if ((accepted.scheme ?? null) !== this.escrow.scheme || req.scheme !== this.escrow.scheme) return Verify.invalid(this.escrow.reasons.INVALID_SCHEME)
    if ((accepted.network ?? null) !== req.network) return Verify.invalid(this.escrow.reasons.NETWORK_MISMATCH)
    try {
      if (Verify.isDepositPayload(raw)) return await this.deposit(raw, req)
      if (Verify.isVoucherPayload(raw)) return await this.voucher(raw, req)
    } catch (e) {
      if (e instanceof RpcError) return Verify.invalid(this.escrow.reasons.RPC_READ_FAILED, null, e.message)
      return Verify.invalid(e?.message ?? String(e))
    }
    return Verify.invalid(this.escrow.reasons.PAYLOAD_TYPE)
  }

  async voucher(raw, req) {
    const config = raw.channelConfig
    const payer = this.escrow.payer(config)
    const channelId = raw.voucher.channelId
    const err = this.configError(config, channelId, req)
    if (err) return Verify.invalid(err, payer)
    if (!(await this.voucherSignatureOk(config, channelId, raw.voucher.maxClaimableAmount, raw.voucher.signature, Verify.chainIdOf(req.network)))) return Verify.invalid(this.escrow.reasons.VOUCHER_SIGNATURE, payer)
    let state
    try {
      state = await this.chain.state(channelId, this.escrow)
    } catch (e) {
      return Verify.invalid(this.escrow.reasons.RPC_READ_FAILED, payer, e?.message ?? String(e))
    }
    const balance = big(state.balance)
    if (balance === 0n) return Verify.invalid(this.escrow.reasons.CHANNEL_NOT_FOUND, payer)
    const max = Verify.uint(raw.voucher.maxClaimableAmount)
    if (max > balance) return Verify.invalid(this.escrow.reasons.EXCEEDS_BALANCE, payer)
    if (max <= big(state.totalClaimed)) return Verify.invalid(this.escrow.reasons.BELOW_CLAIMED, payer)
    return { isValid: true, payer, extra: { channelId, balance: state.balance, totalClaimed: state.totalClaimed, withdrawRequestedAt: state.withdrawRequestedAt, refundNonce: state.refundNonce } }
  }

  static transferMethod(raw, req) {
    if (!empty(req.extra?.assetTransferMethod)) return req.extra.assetTransferMethod
    return !empty(raw.deposit?.authorization?.permit2Authorization) ? 'permit2' : 'eip3009'
  }

  async deposit(raw, req) {
    const config = raw.channelConfig
    const payer = this.escrow.payer(config)
    const err = this.configError(config, raw.voucher.channelId, req)
    if (err) return Verify.invalid(err, payer)
    const method = Verify.transferMethod(raw, req)
    if (method === 'permit2' && empty(raw.deposit.authorization.permit2Authorization)) return Verify.invalid(this.escrow.reasons.PAYLOAD_TYPE, payer)
    const fail = method === 'permit2' ? await this.permit2(raw, req) : await this.erc3009(raw, req)
    if (fail) return fail
    const shared = await this.sharedDepositState(raw, req)
    if (!shared.ok) return shared.response
    const execution = await this.execution(raw, req)
    if (has(execution, 'isValid')) return execution
    try {
      const call = this.escrow.depositCall(config, Verify.uint(raw.deposit.amount).toString(), execution)
      await this.chain.call(call.to, call.data)
    } catch (e) {
      return Verify.invalid(this.escrow.reasons.DEPOSIT_SIMULATION_FAILED, payer, e?.message ?? String(e))
    }
    return {
      isValid: true,
      payer,
      extra: { channelId: raw.voucher.channelId, balance: shared.balance, totalClaimed: shared.totalClaimed, withdrawRequestedAt: shared.withdrawRequestedAt, refundNonce: shared.refundNonce },
      execution,
    }
  }

  async execution(raw, req) {
    if (Verify.transferMethod(raw, req) === 'eip3009') {
      return this.escrow.funding('eip3009', raw.deposit.authorization.erc3009Authorization)
    }
    const fail = await this.permit2Allowance(raw, req)
    if (fail) return fail
    return this.escrow.funding('permit2', raw.deposit.authorization.permit2Authorization)
  }

  async erc3009(raw, req) {
    const payer = this.escrow.payer(raw.channelConfig)
    const auth = raw.deposit.authorization.erc3009Authorization ?? null
    if (!arr(auth) || empty(auth)) return Verify.invalid(this.escrow.reasons.ERC3009_AUTHORIZATION_REQUIRED, payer)
    const extra = req.extra ?? {}
    if (empty(extra.name) || empty(extra.version)) return Verify.invalid(this.escrow.reasons.MISSING_EIP712_DOMAIN, payer)
    const validAfter = Verify.uint(auth.validAfter)
    const validBefore = Verify.uint(auth.validBefore)
    const now = Math.floor(this.cfg.nowMs() / 1000)
    if (validBefore < BigInt(now + 6)) return Verify.invalid(this.escrow.reasons.VALID_BEFORE, payer)
    if (validAfter > BigInt(now)) return Verify.invalid(this.escrow.reasons.VALID_AFTER, payer)
    const parsed = Erc6492.parse(auth.signature)
    if (parsed.address !== null && parsed.data !== null && !Address.equals(parsed.address, ZERO)) {
      let deployed
      try {
        deployed = await this.chain.hasCode(payer)
      } catch {
        deployed = false
      }
      if (!deployed) return Verify.invalid(this.escrow.reasons.FACTORY_NOT_ALLOWED, payer)
    }
    const chainId = Verify.chainIdOf(req.network)
    const digest = this.escrow.fundingDigest('eip3009', { channelId: raw.voucher.channelId, salt: auth.salt, token: req.asset, name: extra.name, version: extra.version, chainId, payer, amount: raw.deposit.amount, validAfter: validAfter.toString(), validBefore: validBefore.toString() })
    if (!(await this.hashSignatureOk(payer, digest, parsed.signature))) return Verify.invalid(this.escrow.reasons.RECEIVE_AUTHORIZATION_SIGNATURE, payer)
    return null
  }

  async permit2(raw, req) {
    const payer = this.escrow.payer(raw.channelConfig)
    const auth = raw.deposit.authorization.permit2Authorization
    if (!arr(auth)) return Verify.invalid(this.escrow.reasons.PERMIT2_AUTHORIZATION_REQUIRED, payer)
    if (!Address.equals(Address.checksum(auth.from), payer)) return Verify.invalid(this.escrow.reasons.PERMIT2_INVALID_SIGNATURE, payer)
    if (!Address.equals(Address.checksum(auth.spender), this.escrow.transferTarget('permit2'))) return Verify.invalid(this.escrow.reasons.PERMIT2_INVALID_SPENDER, payer)
    if (!Address.equals(Address.checksum(auth.permitted.token), req.asset)) return Verify.invalid(this.escrow.reasons.TOKEN_MISMATCH, payer)
    if (Verify.uint(auth.permitted.amount) !== Verify.uint(raw.deposit.amount)) return Verify.invalid(this.escrow.reasons.PERMIT2_AMOUNT_MISMATCH, payer)
    if (auth.witness?.channelId === undefined || auth.witness.channelId !== raw.voucher.channelId) return Verify.invalid(this.escrow.reasons.CHANNEL_ID_MISMATCH, payer)
    const now = Math.floor(this.cfg.nowMs() / 1000)
    if (Verify.uint(auth.deadline) < BigInt(now + 6)) return Verify.invalid(this.escrow.reasons.PERMIT2_DEADLINE_EXPIRED, payer)
    let digest
    try {
      digest = this.escrow.fundingDigest('permit2', {
        chainId: Verify.chainIdOf(req.network),
        token: Address.checksum(auth.permitted.token),
        amount: Verify.uint(auth.permitted.amount).toString(),
        spender: Address.checksum(auth.spender),
        nonce: Verify.uint(auth.nonce).toString(),
        deadline: Verify.uint(auth.deadline).toString(),
        channelId: auth.witness.channelId,
      })
    } catch {
      return Verify.invalid(this.escrow.reasons.PERMIT2_INVALID_SIGNATURE, payer)
    }
    if (!(await this.hashSignatureOk(Address.checksum(auth.from), digest, auth.signature))) return Verify.invalid(this.escrow.reasons.PERMIT2_INVALID_SIGNATURE, payer)
    return this.permit2Allowance(raw, req)
  }

  async permit2Allowance(raw, req) {
    const payer = this.escrow.payer(raw.channelConfig)
    let allowance
    try {
      allowance = await this.chain.allowance(req.asset, payer, Chain.PERMIT2)
    } catch {
      return Verify.invalid(this.escrow.reasons.PERMIT2_ALLOWANCE_REQUIRED, payer)
    }
    if (big(allowance) < Verify.uint(raw.deposit.amount)) return Verify.invalid(this.escrow.reasons.PERMIT2_ALLOWANCE_REQUIRED, payer)
    return null
  }

  async sharedDepositState(raw, req) {
    const config = raw.channelConfig
    const payer = this.escrow.payer(config)
    const channelId = raw.voucher.channelId
    const err = this.configError(config, channelId, req)
    if (err) return { ok: false, response: Verify.invalid(err, payer) }
    if (!(await this.voucherSignatureOk(config, channelId, raw.voucher.maxClaimableAmount, raw.voucher.signature, Verify.chainIdOf(req.network)))) return { ok: false, response: Verify.invalid(this.escrow.reasons.VOUCHER_SIGNATURE, payer) }
    let ch, payerBalance, wd, nonce
    try {
      ch = await this.chain.channel(channelId, this.escrow)
      payerBalance = await this.chain.balanceOf(req.asset, payer)
      wd = await this.chain.pendingWithdrawal(channelId, this.escrow)
      nonce = await this.chain.refundNonce(channelId, this.escrow)
    } catch (e) {
      return { ok: false, response: Verify.invalid(this.escrow.reasons.RPC_READ_FAILED, payer, e?.message ?? String(e)) }
    }
    const amount = Verify.uint(raw.deposit.amount)
    if (big(payerBalance) < amount) return { ok: false, response: Verify.invalid(this.escrow.reasons.INSUFFICIENT_BALANCE, payer) }
    const max = Verify.uint(raw.voucher.maxClaimableAmount)
    if (max > big(ch.balance) + amount) return { ok: false, response: Verify.invalid(this.escrow.reasons.EXCEEDS_BALANCE, payer) }
    if (max <= big(ch.totalClaimed)) return { ok: false, response: Verify.invalid(this.escrow.reasons.BELOW_CLAIMED, payer) }
    return { ok: true, balance: ch.balance, totalClaimed: ch.totalClaimed, withdrawRequestedAt: wd.initiatedAt, refundNonce: nonce }
  }

  async local(raw, req, channel, now) {
    const ttl = Math.min(300000, Math.max(30000, Math.floor((Math.max(0, this.cfg.withdrawDelay) * 1000) / 3)))
    if (channel === null || channel.onchainSyncedAt === undefined || channel.onchainSyncedAt === null || now - Math.trunc(Number(channel.onchainSyncedAt)) > ttl) return null
    const config = raw.channelConfig
    const signer = this.escrow.signer(config)
    if (signer.wallet) return null
    const payer = this.escrow.payer(config)
    const channelId = raw.voucher.channelId
    const err = this.configError(config, channelId, req)
    if (err) return Verify.invalid(err, payer)
    if (Verify.computeChannelId(config, req.network, this.escrow).toLowerCase() !== String(channel.channelId).toLowerCase()) return Verify.invalid(this.escrow.reasons.CHANNEL_ID_MISMATCH, payer)
    const digest = this.escrow.voucherDigest(channelId, Verify.uint(raw.voucher.maxClaimableAmount).toString(), Verify.chainIdOf(req.network))
    if (!(await Verify.recovers(Address.checksum(signer.address), digest, raw.voucher.signature))) return Verify.invalid(this.escrow.reasons.VOUCHER_SIGNATURE, payer)
    const max = Verify.uint(raw.voucher.maxClaimableAmount)
    if (max > big(String(channel.balance))) return null
    if (max <= big(String(channel.totalClaimed))) return Verify.invalid(this.escrow.reasons.BELOW_CLAIMED, payer)
    return { isValid: true, payer, extra: { channelId, balance: String(channel.balance), totalClaimed: String(channel.totalClaimed), withdrawRequestedAt: Math.trunc(Number(channel.withdrawRequestedAt)), refundNonce: String(channel.refundNonce) } }
  }
}
