import { Address, Hex, InvalidArgument, Keccak, Num, has, isObject } from '../core/hex.mjs'
import { BatchSettlement } from '../core/batch.mjs'
import { Erc6492 } from '../core/evm.mjs'
import { TypedData } from '../core/secp256k1.mjs'
import { Config } from './config.mjs'
import { ESCROW_GAS, Escrows, defineEscrow, uint } from './escrow.mjs'
import { Reason } from './json.mjs'

export const ZERO = '0x0000000000000000000000000000000000000000'
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'DepositWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  DepositWitness: [{ name: 'channelId', type: 'bytes32' }],
}

const ESCROW = BatchSettlement.ESCROW
const SETTLED = Keccak.utf8('Settled(address,address,address,uint128)')
const topicOf = (address) => '0x' + '0'.repeat(24) + Hex.body(address).toLowerCase()
const lower = (a) => String(a ?? '').toLowerCase()
const claimEntry = (c) => ({ voucher: { channel: c.channelConfig, maxClaimableAmount: String(c.signedMaxClaimable) }, signature: c.signature, totalClaimed: String(c.chargedCumulativeAmount) })

function requirement(cfg, asset, method, micro) {
  const extra = {}
  if (method === 'eip3009') {
    if (asset.name !== null && asset.name !== '') {
      extra.name = asset.name
      extra.version = asset.version !== null ? asset.version : '1'
    }
  } else extra.assetTransferMethod = 'permit2'
  extra.receiverAuthorizer = cfg.receiverAuthorizer
  extra.withdrawDelay = cfg.withdrawDelay
  return { scheme: Config.SCHEME, network: cfg.network, amount: cfg.unitsOfMicroUSD(asset, micro), asset: asset.address, payTo: cfg.receiver, maxTimeoutSeconds: cfg.maxTimeoutSeconds, extra }
}

export const X402BatchSettlement = defineEscrow({
  kind: 'x402-batch-settlement',
  scheme: Config.SCHEME,
  address: ESCROW,
  contracts: Object.freeze({
    escrow: ESCROW,
    collectors: Object.freeze({ erc3009: BatchSettlement.ERC3009_DEPOSIT_COLLECTOR, permit2: BatchSettlement.PERMIT2_DEPOSIT_COLLECTOR }),
    permit2: PERMIT2,
  }),
  settles: 'at-most',
  fromBlock: 46033952,
  gas: Object.freeze(Object.fromEntries(ESCROW_GAS.map((k) => [k, Config.GAS[k]]))),
  reasons: Reason,
  configFields: 'payer, payerAuthorizer, receiver, receiverAuthorizer, token, withdrawDelay and salt',

  config(config) {
    return BatchSettlement.config(config)
  },

  strictConfig(config) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new InvalidArgument('channelConfig is not an object')
    for (const k of ['payer', 'payerAuthorizer', 'receiver', 'receiverAuthorizer', 'token']) {
      const a = config[k] ?? null
      if (!Address.isAddress(a)) throw new InvalidArgument(`channelConfig.${k} is not an address`)
      const body = a.slice(2)
      if (body !== body.toLowerCase() && body !== body.toUpperCase() && !Address.isChecksummed(a)) throw new InvalidArgument(`channelConfig.${k} has a bad checksum`)
    }
    if (!Number.isInteger(config.withdrawDelay)) throw new InvalidArgument('channelConfig.withdrawDelay is not a number')
    if (!Hex.isHex(config.salt, 32)) throw new InvalidArgument('channelConfig.salt is not 32 bytes')
    return config
  },

  channelId(config, chainId) {
    return BatchSettlement.channelId(config, chainId)
  },

  termsError(config, channelId, chainId, req) {
    const extra = isObject(req.extra) ? req.extra : {}
    return BatchSettlement.validateChannelConfig(config, channelId, chainId, req.payTo, extra.receiverAuthorizer ?? null, req.asset, has(extra, 'withdrawDelay') ? Math.trunc(Number(extra.withdrawDelay)) : null)
  },

  sellerMismatch(config, cfg) {
    if (!Address.equals(config.receiver, cfg.receiver)) return { mismatch: 'receiver', why: `channelConfig receiver is ${lower(config.receiver)}; this seller's is ${lower(cfg.receiver)}` }
    if (!Address.equals(config.receiverAuthorizer, cfg.receiverAuthorizer)) return { mismatch: 'receiverAuthorizer', why: `channelConfig receiverAuthorizer is ${lower(config.receiverAuthorizer)}; this seller's is ${lower(cfg.receiverAuthorizer)}` }
    if (cfg.assetOf(config.token) === null) return { mismatch: 'token', why: `channelConfig token ${lower(config.token)} is not accepted here` }
    return null
  },

  payer(config) {
    return config.payer
  },

  signer(config) {
    return config.payerAuthorizer !== ZERO ? { address: config.payerAuthorizer, wallet: false } : { address: config.payer, wallet: true }
  },

  owners(config) {
    return [config?.payer, config?.payerAuthorizer]
  },

  token(config) {
    return config.token
  },

  voucherDigest(channelId, cumulative, chainId) {
    return BatchSettlement.voucherDigest(channelId, cumulative, chainId)
  },

  stale(reason) {
    return /exceeds_balance|below_claimed/.test(String(reason ?? ''))
  },

  requirement,

  accepts(cfg, asset, micro) {
    return (asset.eip3009 ? ['eip3009', 'permit2'] : ['permit2']).map((method) => requirement(cfg, asset, method, micro))
  },

  transferTarget(method) {
    return method === 'permit2' ? BatchSettlement.PERMIT2_DEPOSIT_COLLECTOR : BatchSettlement.ERC3009_DEPOSIT_COLLECTOR
  },

  fundingDigest(method, f) {
    if (method === 'permit2') {
      return TypedData.hash(
        { name: 'Permit2', chainId: f.chainId, verifyingContract: PERMIT2 },
        PERMIT2_WITNESS_TYPES,
        'PermitWitnessTransferFrom',
        { permitted: { token: f.token, amount: f.amount }, spender: f.spender, nonce: f.nonce, deadline: f.deadline, witness: { channelId: f.channelId } },
      )
    }
    const nonce = BatchSettlement.erc3009DepositNonce(f.channelId, f.salt)
    return BatchSettlement.receiveAuthorizationDigest(
      BatchSettlement.tokenDomain(f.token, f.name, f.version, f.chainId),
      BatchSettlement.receiveAuthorization(f.payer, uint(f.amount).toString(), f.validAfter, f.validBefore, nonce),
    )
  },

  funding(method, authorization) {
    if (method === 'permit2') {
      const inner = Erc6492.parse(authorization.signature)
      return { collector: BatchSettlement.PERMIT2_DEPOSIT_COLLECTOR, collectorData: BatchSettlement.permit2CollectorData(uint(authorization.nonce).toString(), uint(authorization.deadline).toString(), inner.signature, '0x') }
    }
    return { collector: BatchSettlement.ERC3009_DEPOSIT_COLLECTOR, collectorData: BatchSettlement.erc3009DepositCollectorData(authorization) }
  },

  depositCall(config, amount, funding) {
    return { to: ESCROW, data: BatchSettlement.encodeDeposit(config, amount, funding.collector, funding.collectorData) }
  },

  async claimCall(key, records, chainId) {
    const claims = records.map(claimEntry)
    const signature = await BatchSettlement.signClaimBatch(key, claims, chainId)
    return { to: ESCROW, data: BatchSettlement.encodeClaimWithSignature(claims, signature) }
  },

  async refundCall(key, record, amount, nonce, chainId, claim) {
    const id = String(record.channelId).toLowerCase()
    const refundSig = await BatchSettlement.signRefund(key, id, amount, nonce, chainId)
    const refund = BatchSettlement.encodeRefundWithSignature(record.channelConfig, amount, nonce, refundSig)
    if (!claim) return { to: ESCROW, data: refund }
    const claims = [claimEntry(record)]
    const claimSig = await BatchSettlement.signClaimBatch(key, claims, chainId)
    return { to: ESCROW, data: BatchSettlement.encodeMulticall([BatchSettlement.encodeClaimWithSignature(claims, claimSig), refund]) }
  },

  collectCall(payee, token) {
    return { to: ESCROW, data: BatchSettlement.encodeSettle(payee, token) }
  },

  async readChannel(call, channelId) {
    const c = BatchSettlement.decodeChannels(await call(ESCROW, BatchSettlement.encodeChannels(channelId)))
    return { balance: Num.dec(c.balance), totalClaimed: Num.dec(c.totalClaimed) }
  },

  async readClosing(call, channelId) {
    const w = BatchSettlement.decodePendingWithdrawals(await call(ESCROW, BatchSettlement.encodePendingWithdrawals(channelId)))
    return { amount: Num.dec(w.amount), initiatedAt: Number(Num.dec(w.initiatedAt)) }
  },

  async readRefundNonce(call, channelId) {
    return Num.dec(BatchSettlement.decodeRefundNonce(await call(ESCROW, BatchSettlement.encodeRefundNonce(channelId))))
  },

  async readPayee(call, payee, token) {
    const r = BatchSettlement.decodeReceivers(await call(ESCROW, BatchSettlement.encodeReceivers(payee, token)))
    return { totalClaimed: Num.dec(r.totalClaimed), totalSettled: Num.dec(r.totalSettled) }
  },

  collectedFilter(payees, token) {
    return { address: ESCROW, topics: [SETTLED, payees.length === 1 ? topicOf(payees[0]) : payees.map(topicOf), topicOf(token)] }
  },

  collectedIsFor(log, payee) {
    return String(log.topics?.[1]).toLowerCase() === topicOf(payee)
  },

  collectedAmount(log) {
    return BigInt('0x' + Hex.body(log.data).slice(0, 64))
  },
})

export const ESCROWS = new Escrows([X402BatchSettlement])
