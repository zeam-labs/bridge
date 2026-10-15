import { randomBytes } from 'node:crypto'
import { Address, Hex, InvalidArgument } from '../core/hex.mjs'
import { Erc20 } from '../core/batch.mjs'
import { Token } from '../core/evm.mjs'
import { EvmSession, SessionPayee, SessionPayeeFactory } from '../core/session.mjs'
import { ESCROW_REASONS, defineEscrow, uint } from './escrow.mjs'

export const SESSION_KIND = 'evm-session'
export const SESSION_SCHEME = 'mpp-evm-session'
export const SESSION_AUTHORIZATION_SECS = 600
export const SESSION_HELD = 8
export const SESSION_TOP_UPS = 16

export const SESSION_GAS = Object.freeze({
  deposit: 216801,
  topUp: 132091,
  claimBase: 0,
  claimEntry: 131113,
  claimAlone: 131113,
  refund: 144577,
  refundClaim: 0,
  paidClaim: 0,
  paidL1: 0,
  paidClaimL1: 0,
  payout: 355604,
  createPayee: 369567,
  exitRequest: 84615,
  exitWithdraw: 115531,
})

export const SESSION_GAS_MEASURED = Object.freeze({
  on: '2026-10-12',
  how: 'forge gas snapshot of zeam-contracts-session a6d54d1 on a Base fork with real USDC and 0xSplits; transaction gas',
  openWithAuthorization: 216801,
  topUpWithAuthorization: 132091,
  settleWithAuthorization: 131113,
  closeWithAuthorization: 144577,
  requestCloseWithAuthorization: 84615,
  withdrawWithAuthorization: 115531,
  payeeDeploy: 369567,
  sweep: 72311,
  distribute: 199230,
  warehouseWithdraw: 84063,
})

const REASONS = Object.freeze(Object.fromEntries(ESCROW_REASONS.map((k) => [k, `session_${k.toLowerCase()}`])))
const NONE = Object.freeze({ amount: '0', signature: '' })
const topicOf = (address) => '0x' + '0'.repeat(24) + Hex.body(address).toLowerCase()
const lower = (a) => String(a ?? '').toLowerCase()
const n = (v) => (v === undefined || v === null || v === '' ? 0n : BigInt(String(v)))

export const SessionBook = Object.freeze({
  NONE,

  of(record) {
    const s = record?.session !== null && typeof record?.session === 'object' ? record.session : {}
    const settle = s.settle !== null && typeof s.settle === 'object' && s.settle.amount !== undefined ? { amount: String(s.settle.amount), signature: String(s.settle.signature ?? '') } : NONE
    const held = Array.isArray(s.held) ? s.held.map((v) => ({ amount: String(v.amount), signature: String(v.signature) })) : []
    return { settle, held }
  },

  spent(record) {
    return n(record?.chargedCumulativeAmount)
  },

  accepted(record) {
    return n(record?.signedMaxClaimable)
  },

  best(record, upTo) {
    const { settle, held } = SessionBook.of(record)
    let found = settle
    for (const v of held) if (n(v.amount) <= upTo && n(v.amount) >= n(found.amount)) found = v
    return found
  },

  hold(record, amount, signature) {
    const a = n(amount)
    const book = SessionBook.of(record)
    const spent = SessionBook.spent(record)
    if (a > SessionBook.accepted(record) || record.signedMaxClaimable === undefined) {
      record.signedMaxClaimable = a.toString()
      record.signature = signature
    }
    if (a <= spent) {
      if (a > n(book.settle.amount) || (a === n(book.settle.amount) && book.settle.signature === '')) book.settle = { amount: a.toString(), signature }
    } else if (!book.held.some((v) => n(v.amount) === a)) {
      book.held.push({ amount: a.toString(), signature })
    }
    SessionBook.write(record, book)
    return record
  },

  charge(record, cost) {
    record.chargedCumulativeAmount = (SessionBook.spent(record) + n(cost)).toString()
    SessionBook.write(record, SessionBook.of(record))
    return record
  },

  write(record, book) {
    const spent = SessionBook.spent(record)
    const top = SessionBook.accepted(record)
    let settle = book.settle
    for (const v of book.held) if (n(v.amount) <= spent && n(v.amount) > n(settle.amount)) settle = v
    let held = book.held.filter((v) => n(v.amount) > spent).sort((a, b) => (n(a.amount) < n(b.amount) ? -1 : n(a.amount) > n(b.amount) ? 1 : 0))
    if (held.length > SESSION_HELD) held = [...held.slice(0, SESSION_HELD - 1), ...held.filter((v) => n(v.amount) === top).slice(-1)].filter((v, i, all) => all.findIndex((w) => w.amount === v.amount) === i)
    record.session = { ...(record.session ?? {}), settle: { amount: String(settle.amount), signature: settle.signature }, held }
    return record
  },

  topUps(record) {
    return Array.isArray(record?.session?.topUps) ? record.session.topUps : []
  },

  topUp(record, key) {
    return SessionBook.topUps(record).find((t) => t.key === key) ?? null
  },

  topUpSent(record, key, deposit) {
    const rest = SessionBook.topUps(record).filter((t) => t.key !== key)
    record.session = { ...(record.session ?? {}), topUps: [...rest, { key, base: String(deposit), landed: false }].slice(-SESSION_TOP_UPS) }
    return record
  },

  topUpLanded(record, key, amount) {
    if (SessionBook.topUp(record, key)?.landed === true) return false
    const rest = SessionBook.topUps(record).filter((t) => t.key !== key).map((t) => (t.landed ? t : { ...t, base: (n(t.base) + n(amount)).toString() }))
    record.session = { ...(record.session ?? {}), topUps: [...rest, { key, landed: true }].slice(-SESSION_TOP_UPS) }
    return true
  },

  payable(record, cost, presented) {
    const spent = SessionBook.spent(record)
    const after = spent + n(cost)
    if (SessionBook.accepted(record) < after) return { ok: false, why: 'balance', requiredCumulative: after.toString() }
    if (n(presented) !== after) return { ok: false, why: 'presented', requiredCumulative: after.toString(), presented: n(presented).toString() }
    if (n(SessionBook.best(record, after).amount) < after) return { ok: false, why: 'voucher', requiredCumulative: after.toString() }
    return { ok: true, after: after.toString() }
  },
})

export function sessionEscrow({ address, factory, signer, split, chainId = 8453, token = Erc20.USDC_BASE, fromBlock = 0, gas = null }) {
  for (const [k, v] of Object.entries({ escrow: address, factory, signer, split, token })) if (!Address.isAddress(v)) throw new TypeError(`a session escrow needs ${k} as an address`)
  const ESCROW = Address.checksum(address)
  const FACTORY = Address.checksum(factory)
  const SIGNER = Address.checksum(signer)
  const SPLIT = Address.checksum(split)
  const TOKEN = Address.checksum(token)
  const CHAIN = Math.trunc(Number(chainId))
  const state = { payee: null, grace: null, reading: null }

  const need = () => {
    if (state.payee === null) throw new InvalidArgument('the session payee has not been read from its factory')
    return state.payee
  }

  async function read(call) {
    const boundTo = SessionPayeeFactory.address(await call(FACTORY, SessionPayeeFactory.call('escrow')))
    if (!Address.equals(boundTo, ESCROW)) throw new InvalidArgument(`the payee factory ${FACTORY} is bound to another escrow`)
    const held = EvmSession.result('TOKEN', await call(ESCROW, EvmSession.call('TOKEN')))
    if (!Address.equals(held, TOKEN)) throw new InvalidArgument(`the session escrow ${ESCROW} holds another token`)
    const grace = Number(EvmSession.result('CLOSE_GRACE_PERIOD', await call(ESCROW, EvmSession.call('CLOSE_GRACE_PERIOD'))))
    if (!(grace >= EvmSession.MIN_GRACE_SECS)) throw new InvalidArgument(`the session escrow's close grace period is ${grace}s, under the ${EvmSession.MIN_GRACE_SECS}s a server may accept`)
    const payee = SessionPayeeFactory.address(await call(FACTORY, SessionPayeeFactory.call('addressOf', [SIGNER, SPLIT])))
    state.grace = grace
    state.payee = Address.checksum(payee)
    return state
  }

  function ready(call) {
    if (state.payee !== null) return Promise.resolve(state)
    if (state.reading === null) {
      state.reading = read(call).finally(() => {
        state.reading = null
      })
    }
    return state.reading
  }

  const view = (record) => {
    const { settle } = SessionBook.of(record)
    return { ...record, chargedCumulativeAmount: settle.amount, signedMaxClaimable: settle.amount, signature: settle.signature }
  }

  const nonce = () => BigInt('0x' + randomBytes(32).toString('hex')).toString()

  async function payeeCall(key, kind, channelId, cumulativeAmount, voucherSignature, nowSecs) {
    const a = { channelId: lower(channelId), cumulativeAmount: String(cumulativeAmount), nonce: nonce(), deadline: String(Math.trunc(Number(nowSecs)) + SESSION_AUTHORIZATION_SECS) }
    const payeeSignature = await EvmSession.signPayee(key, ESCROW, CHAIN, kind, a)
    const voucher = voucherSignature === undefined || voucherSignature === null || voucherSignature === '' ? '0x' : voucherSignature
    return { to: ESCROW, data: EvmSession.call(kind === 'close' ? 'closeWithAuthorization' : 'settleWithAuthorization', [a.channelId, a.cumulativeAmount, a.nonce, a.deadline, payeeSignature, voucher]) }
  }

  const adapter = {
    kind: SESSION_KIND,
    scheme: SESSION_SCHEME,
    address: ESCROW,
    contracts: Object.freeze({ escrow: ESCROW, factory: FACTORY }),
    settles: 'exact',
    closes: 'whole',
    fromBlock: Math.trunc(Number(fromBlock)),
    gas: Object.freeze({ ...SESSION_GAS, ...(gas !== null && typeof gas === 'object' ? gas : {}) }),
    reasons: REASONS,
    configFields: 'payer, payee, token, salt and authorizedSigner',
    chainId: CHAIN,
    tokenAddress: TOKEN,
    signerAddress: SIGNER,
    splitAddress: SPLIT,

    ready,

    payee() {
      return need()
    },

    graceSecs() {
      return state.grace
    },

    config(config) {
      return EvmSession.channel(config)
    },

    strictConfig(config) {
      EvmSession.channel(config)
      return config
    },

    channelId(config, chain) {
      return EvmSession.channelId(config, ESCROW, chain)
    },

    termsError(config, channelId, chain, req) {
      if (lower(EvmSession.channelId(config, ESCROW, chain)) !== lower(channelId)) return REASONS.CHANNEL_ID_MISMATCH
      if (!Address.equals(config.payee, req.payTo)) return 'session_payee_mismatch'
      if (!Address.equals(config.token, req.asset)) return REASONS.TOKEN_MISMATCH
      return null
    },

    sellerMismatch(config, cfg) {
      if (state.payee === null || !Address.equals(config.payee, state.payee)) return { mismatch: 'payee', why: `channelConfig payee is ${lower(config.payee)}; this seller's is ${lower(state.payee ?? 'not read yet')}` }
      if (cfg.assetOf(config.token) === null || !Address.equals(config.token, TOKEN)) return { mismatch: 'token', why: `channelConfig token ${lower(config.token)} is not accepted here` }
      return null
    },

    payer(config) {
      return config.payer
    },

    signer(config) {
      return { address: EvmSession.signerOf(config), wallet: true }
    },

    owners(config) {
      return [config?.payer, config?.authorizedSigner]
    },

    token(config) {
      return config.token
    },

    voucherDigest(channelId, cumulative, chain) {
      return EvmSession.voucherDigest(ESCROW, chain, channelId, cumulative)
    },

    stale() {
      return false
    },

    accepts() {
      return []
    },

    transferTarget() {
      return ESCROW
    },

    fundingDigest(method, f) {
      if (method !== 'eip3009') throw new InvalidArgument('the session escrow is funded by an EIP-3009 authorization or by the payer\'s own transaction')
      return EvmSession.receiveDigest(Token.domain(f.token, f.name, f.version, f.chainId), { from: f.payer, to: ESCROW, value: uint(f.amount).toString(), validAfter: f.validAfter, validBefore: f.validBefore, nonce: f.nonce })
    },

    funding(method, authorization) {
      if (method !== 'eip3009') throw new InvalidArgument('the session escrow is funded by an EIP-3009 authorization or by the payer\'s own transaction')
      return { kind: authorization.kind === 'topUp' ? 'topUp' : 'open', ...authorization }
    },

    openCall({ config, deposit, authorization, signature }) {
      const c = EvmSession.channel(config)
      return { to: ESCROW, data: EvmSession.call('openWithAuthorization', [c.payee, c.token, uint(deposit).toString(), c.salt, c.authorizedSigner, authorization.from, uint(authorization.validAfter).toString(), uint(authorization.validBefore).toString(), authorization.nonce, signature]) }
    },

    topUpCall({ channelId, additionalDeposit, topUpSalt, authorization, signature }) {
      return { to: ESCROW, data: EvmSession.call('topUpWithAuthorization', [lower(channelId), uint(additionalDeposit).toString(), authorization.from, topUpSalt, uint(authorization.validAfter).toString(), uint(authorization.validBefore).toString(), authorization.nonce, signature]) }
    },

    depositCall(config, amount, funding) {
      if (funding.kind === 'topUp') return adapter.topUpCall({ channelId: funding.channelId ?? EvmSession.channelId(config, ESCROW, CHAIN), additionalDeposit: amount, topUpSalt: funding.salt, authorization: funding, signature: funding.signature })
      return adapter.openCall({ config, deposit: amount, authorization: funding, signature: funding.signature })
    },

    claimView: view,

    async claimCalls(key, records, _chain, nowSecs = Math.floor(Date.now() / 1000)) {
      const calls = []
      for (const record of records) {
        const v = view(record)
        calls.push({ what: 'claim 1 voucher(s)', ...(await payeeCall(key, 'settle', v.channelId, v.signedMaxClaimable, v.signature, nowSecs)) })
      }
      return calls
    },

    async claimCall(key, records, chain) {
      if (records.length !== 1) throw new InvalidArgument('the session escrow settles one channel per call: use claimCalls')
      const [call] = await adapter.claimCalls(key, records, chain)
      return { to: call.to, data: call.data }
    },

    closeCall(key, record, nowSecs = Math.floor(Date.now() / 1000)) {
      const v = view(record)
      return payeeCall(key, 'close', v.channelId, v.signedMaxClaimable, v.signature, nowSecs)
    },

    refundCall(key, record) {
      return adapter.closeCall(key, record)
    },

    async prepareCalls(chain) {
      await ready(chain.reader)
      if (await chain.hasCode(need())) return []
      return [{ what: 'create payee', to: FACTORY, data: SessionPayeeFactory.call('deploy', [SIGNER, SPLIT]) }]
    },

    collectCall(_payee, tokenAddress) {
      return { to: need(), data: SessionPayee.call('sweep', [Address.checksum(tokenAddress)]) }
    },

    async readState(call, channelId) {
      return EvmSession.result('getChannel', await call(ESCROW, EvmSession.call('getChannel', [lower(channelId)])))
    },

    async readChannel(call, channelId) {
      const c = await adapter.readState(call, channelId)
      return { balance: c.finalized ? c.settled : c.deposit, totalClaimed: c.settled }
    },

    async readClosing(call, channelId) {
      const c = await adapter.readState(call, channelId)
      const leaving = !c.finalized && c.closeRequestedAt > 0
      const left = n(c.deposit) - n(c.settled)
      return { amount: leaving ? (left > 0n ? left : 1n).toString() : '0', initiatedAt: leaving ? c.closeRequestedAt : 0 }
    },

    async readRefundNonce(call, channelId) {
      return (await adapter.readState(call, channelId)).finalized ? '1' : '0'
    },

    async readPayee(call, _payee, tokenAddress) {
      await ready(call)
      const held = Erc20.decodeUint256(await call(tokenAddress, Erc20.encodeBalanceOf(need())))
      return { totalClaimed: String(held), totalSettled: '0' }
    },

    collectedFilter(_payees, tokenAddress) {
      return { address: need(), topics: [SessionPayee.SWEPT, topicOf(tokenAddress)] }
    },

    collectedIsFor(log) {
      return state.payee !== null && Address.equals(log.address, state.payee)
    },

    collectedAmount(log) {
      return SessionPayee.sweptAmount(log)
    },
  }
  return defineEscrow(adapter)
}
