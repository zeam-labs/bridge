import { Abi } from './abi.mjs'
import { Address, Hex, InvalidArgument, Keccak, Num } from './hex.mjs'
import { Secp256k1, TypedData } from './secp256k1.mjs'

const UINT128_MAX = (1n << 128n) - 1n

const TYPES = Object.freeze({
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint128' },
  ],
  SettleAuthorization: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint128' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  CloseAuthorization: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint128' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  RequestCloseAuthorization: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  WithdrawAuthorization: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
})

const RECEIVE_TYPES = Object.freeze({
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
})

const CHANNEL = '(bool,uint64,address,address,address,address,uint128,uint128)'

const FUNCTIONS = Object.freeze({
  open: 'open(address,address,uint128,bytes32,address)',
  settle: 'settle(bytes32,uint128,bytes)',
  topUp: 'topUp(bytes32,uint128)',
  close: 'close(bytes32,uint128,bytes)',
  requestClose: 'requestClose(bytes32)',
  withdraw: 'withdraw(bytes32)',
  openWithAuthorization: 'openWithAuthorization(address,address,uint128,bytes32,address,address,uint256,uint256,bytes32,bytes)',
  topUpWithAuthorization: 'topUpWithAuthorization(bytes32,uint128,address,bytes32,uint256,uint256,bytes32,bytes)',
  settleWithAuthorization: 'settleWithAuthorization(bytes32,uint128,uint256,uint256,bytes,bytes)',
  closeWithAuthorization: 'closeWithAuthorization(bytes32,uint128,uint256,uint256,bytes,bytes)',
  requestCloseWithAuthorization: 'requestCloseWithAuthorization(bytes32,uint256,uint256,bytes)',
  withdrawWithAuthorization: 'withdrawWithAuthorization(bytes32,uint256,uint256,bytes)',
  getChannel: 'getChannel(bytes32)',
  getChannelsBatch: 'getChannelsBatch(bytes32[])',
  computeChannelId: 'computeChannelId(address,address,address,bytes32,address)',
  getVoucherDigest: 'getVoucherDigest(bytes32,uint128)',
  getSettleAuthorizationDigest: 'getSettleAuthorizationDigest(bytes32,uint128,uint256,uint256)',
  getCloseAuthorizationDigest: 'getCloseAuthorizationDigest(bytes32,uint128,uint256,uint256)',
  getRequestCloseAuthorizationDigest: 'getRequestCloseAuthorizationDigest(bytes32,uint256,uint256)',
  getWithdrawAuthorizationDigest: 'getWithdrawAuthorizationDigest(bytes32,uint256,uint256)',
  computeOpenAuthorizationNonce: 'computeOpenAuthorizationNonce(address,address,address,bytes32,address)',
  computeTopUpAuthorizationNonce: 'computeTopUpAuthorizationNonce(bytes32,uint128,address,bytes32)',
  isPayeeNonceUsed: 'isPayeeNonceUsed(address,bytes32,uint256)',
  isPayerNonceUsed: 'isPayerNonceUsed(address,bytes32,uint256)',
  domainSeparator: 'domainSeparator()',
  CLOSE_GRACE_PERIOD: 'CLOSE_GRACE_PERIOD()',
  TOKEN: 'TOKEN()',
  VOUCHER_TYPEHASH: 'VOUCHER_TYPEHASH()',
  SETTLE_AUTHORIZATION_TYPEHASH: 'SETTLE_AUTHORIZATION_TYPEHASH()',
  CLOSE_AUTHORIZATION_TYPEHASH: 'CLOSE_AUTHORIZATION_TYPEHASH()',
  REQUEST_CLOSE_AUTHORIZATION_TYPEHASH: 'REQUEST_CLOSE_AUTHORIZATION_TYPEHASH()',
  WITHDRAW_AUTHORIZATION_TYPEHASH: 'WITHDRAW_AUTHORIZATION_TYPEHASH()',
})

const NAMES = Object.freeze({
  open: ['payee', 'token', 'deposit', 'salt', 'authorizedSigner'],
  settle: ['channelId', 'cumulativeAmount', 'signature'],
  topUp: ['channelId', 'additionalDeposit'],
  close: ['channelId', 'cumulativeAmount', 'signature'],
  requestClose: ['channelId'],
  withdraw: ['channelId'],
  openWithAuthorization: ['payee', 'token', 'deposit', 'salt', 'authorizedSigner', 'from', 'validAfter', 'validBefore', 'nonce', 'signature'],
  topUpWithAuthorization: ['channelId', 'additionalDeposit', 'from', 'topUpSalt', 'validAfter', 'validBefore', 'nonce', 'signature'],
  settleWithAuthorization: ['channelId', 'cumulativeAmount', 'nonce', 'deadline', 'payeeSignature', 'voucherSignature'],
  closeWithAuthorization: ['channelId', 'cumulativeAmount', 'nonce', 'deadline', 'payeeSignature', 'voucherSignature'],
  requestCloseWithAuthorization: ['channelId', 'nonce', 'deadline', 'payerSignature'],
  withdrawWithAuthorization: ['channelId', 'nonce', 'deadline', 'payerSignature'],
})

const RETURNS = Object.freeze({
  getChannel: [CHANNEL],
  getChannelsBatch: [`${CHANNEL}[]`],
  computeChannelId: ['bytes32'],
  getVoucherDigest: ['bytes32'],
  getSettleAuthorizationDigest: ['bytes32'],
  getCloseAuthorizationDigest: ['bytes32'],
  getRequestCloseAuthorizationDigest: ['bytes32'],
  getWithdrawAuthorizationDigest: ['bytes32'],
  computeOpenAuthorizationNonce: ['bytes32'],
  computeTopUpAuthorizationNonce: ['bytes32'],
  isPayeeNonceUsed: ['bool'],
  isPayerNonceUsed: ['bool'],
  domainSeparator: ['bytes32'],
  CLOSE_GRACE_PERIOD: ['uint64'],
  TOKEN: ['address'],
  VOUCHER_TYPEHASH: ['bytes32'],
  SETTLE_AUTHORIZATION_TYPEHASH: ['bytes32'],
  CLOSE_AUTHORIZATION_TYPEHASH: ['bytes32'],
  REQUEST_CLOSE_AUTHORIZATION_TYPEHASH: ['bytes32'],
  WITHDRAW_AUTHORIZATION_TYPEHASH: ['bytes32'],
  open: ['bytes32'],
  openWithAuthorization: ['bytes32'],
})

const EVENTS = Object.freeze({
  ChannelOpened: { signature: 'ChannelOpened(bytes32,address,address,address,address,bytes32,uint256)', indexed: ['channelId', 'payer', 'payee'], data: [['token', 'address'], ['authorizedSigner', 'address'], ['salt', 'bytes32'], ['deposit', 'uint256']] },
  Settled: { signature: 'Settled(bytes32,address,address,uint256,uint256,uint256)', indexed: ['channelId', 'payer', 'payee'], data: [['cumulativeAmount', 'uint256'], ['deltaPaid', 'uint256'], ['newSettled', 'uint256']] },
  CloseRequested: { signature: 'CloseRequested(bytes32,address,address,uint256)', indexed: ['channelId', 'payer', 'payee'], data: [['closeGraceEnd', 'uint256']] },
  TopUp: { signature: 'TopUp(bytes32,address,address,uint256,uint256)', indexed: ['channelId', 'payer', 'payee'], data: [['additionalDeposit', 'uint256'], ['newDeposit', 'uint256']] },
  ChannelClosed: { signature: 'ChannelClosed(bytes32,address,address,uint256,uint256)', indexed: ['channelId', 'payer', 'payee'], data: [['settledToPayee', 'uint256'], ['refundedToPayer', 'uint256']] },
  CloseRequestCancelled: { signature: 'CloseRequestCancelled(bytes32,address,address)', indexed: ['channelId', 'payer', 'payee'], data: [] },
  ChannelExpired: { signature: 'ChannelExpired(bytes32,address,address)', indexed: ['channelId', 'payer', 'payee'], data: [] },
})

const ERRORS = Object.freeze([
  'ChannelAlreadyExists', 'ChannelNotFound', 'ChannelFinalized', 'InvalidSignature', 'AmountExceedsDeposit', 'AmountNotIncreasing', 'NotPayer', 'NotPayee', 'TransferFailed',
  'CloseNotReady', 'InvalidPayee', 'InvalidToken', 'ZeroDeposit', 'DepositOverflow', 'NonceMismatch', 'NonceAlreadyUsed', 'AuthorizationExpired', 'InvalidPayer',
])

const SELECTORS = new Map(Object.entries(FUNCTIONS).map(([name, signature]) => [Keccak.selector(signature), name]))
const TOPICS = new Map(Object.entries(EVENTS).map(([name, e]) => [Keccak.utf8(e.signature), name]))
const ERROR_SELECTORS = new Map(ERRORS.map((name) => [Keccak.selector(`${name}()`), name]))
const typesOf = (signature) => Abi.parseSignature(signature).types
const word = (topic) => '0x' + Hex.body(String(topic)).slice(24)

function amount(value, what = 'cumulativeAmount') {
  let n
  try {
    n = Num.of(value)
  } catch {
    throw new InvalidArgument(`${what} is not an unsigned integer`)
  }
  if (n < 0n || n > UINT128_MAX) throw new InvalidArgument(`${what} is outside uint128`)
  return n
}

function channelOf(tuple) {
  const [finalized, closeRequestedAt, payer, payee, token, authorizedSigner, deposit, settled] = tuple
  return { finalized: finalized === true, closeRequestedAt: Number(closeRequestedAt), payer, payee, token, authorizedSigner, deposit: String(deposit), settled: String(settled), exists: !Address.equals(payer, Address.ZERO) }
}

export const EvmSession = Object.freeze({
  DOMAIN_NAME: 'EVM Payment Channel',
  DOMAIN_VERSION: '1',
  TYPES,
  RECEIVE_TYPES,
  FUNCTIONS,
  EVENTS,
  ERRORS,
  UINT128_MAX,
  MIN_GRACE_SECS: 600,

  amount,

  domain(escrow, chainId) {
    return { name: EvmSession.DOMAIN_NAME, version: EvmSession.DOMAIN_VERSION, chainId: Math.trunc(Number(chainId)), verifyingContract: Address.checksum(escrow) }
  },

  channel(config) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new InvalidArgument('a channel is an object')
    for (const k of ['payer', 'payee', 'token']) if (!Address.isAddress(config[k])) throw new InvalidArgument(`channel.${k} is not an address`)
    if (!Hex.isHex(config.salt, 32)) throw new InvalidArgument('channel.salt is not 32 bytes')
    const signer = config.authorizedSigner === undefined || config.authorizedSigner === null || config.authorizedSigner === '' ? Address.ZERO : config.authorizedSigner
    if (!Address.isAddress(signer)) throw new InvalidArgument('channel.authorizedSigner is not an address')
    return { payer: Address.checksum(config.payer), payee: Address.checksum(config.payee), token: Address.checksum(config.token), salt: Hex.lower(config.salt), authorizedSigner: Address.checksum(signer) }
  },

  channelId(config, escrow, chainId) {
    const c = EvmSession.channel(config)
    return Keccak.hashHex(Abi.encode(['address', 'address', 'address', 'bytes32', 'address', 'address', 'uint256'], [c.payer, c.payee, c.token, c.salt, c.authorizedSigner, Address.checksum(escrow), String(Math.trunc(Number(chainId)))]))
  },

  signerOf(config) {
    const c = EvmSession.channel(config)
    return Address.equals(c.authorizedSigner, Address.ZERO) ? c.payer : c.authorizedSigner
  },

  openNonce(from, payee, token, salt, authorizedSigner = Address.ZERO) {
    return Keccak.hashHex(Abi.encode(['address', 'address', 'address', 'bytes32', 'address'], [from, payee, token, Hex.lower(salt), authorizedSigner ?? Address.ZERO]))
  },

  topUpNonce(channelId, additionalDeposit, from, topUpSalt) {
    return Keccak.hashHex(Abi.encode(['bytes32', 'uint128', 'address', 'bytes32'], [Hex.lower(channelId), amount(additionalDeposit, 'additionalDeposit').toString(), from, Hex.lower(topUpSalt)]))
  },

  digest(escrow, chainId, type, message) {
    if (!Object.hasOwn(TYPES, type)) throw new InvalidArgument(`no typed message named ${type}`)
    return TypedData.hash(EvmSession.domain(escrow, chainId), { [type]: TYPES[type] }, type, message)
  },

  voucherDigest(escrow, chainId, channelId, cumulativeAmount) {
    return EvmSession.digest(escrow, chainId, 'Voucher', { channelId: Hex.lower(channelId), cumulativeAmount: amount(cumulativeAmount).toString() })
  },

  payeeDigest(escrow, chainId, kind, a) {
    return EvmSession.digest(escrow, chainId, kind === 'close' ? 'CloseAuthorization' : 'SettleAuthorization', { channelId: Hex.lower(a.channelId), cumulativeAmount: amount(a.cumulativeAmount).toString(), nonce: Num.dec(a.nonce), deadline: Num.dec(a.deadline) })
  },

  payerDigest(escrow, chainId, kind, a) {
    return EvmSession.digest(escrow, chainId, kind === 'withdraw' ? 'WithdrawAuthorization' : 'RequestCloseAuthorization', { channelId: Hex.lower(a.channelId), nonce: Num.dec(a.nonce), deadline: Num.dec(a.deadline) })
  },

  signVoucher(key, escrow, chainId, channelId, cumulativeAmount) {
    return Secp256k1.signHash(key, EvmSession.voucherDigest(escrow, chainId, channelId, cumulativeAmount))
  },

  signPayee(key, escrow, chainId, kind, a) {
    return Secp256k1.signHash(key, EvmSession.payeeDigest(escrow, chainId, kind, a))
  },

  signPayer(key, escrow, chainId, kind, a) {
    return Secp256k1.signHash(key, EvmSession.payerDigest(escrow, chainId, kind, a))
  },

  receiveAuthorization(a) {
    return { from: Address.checksum(a.from), to: Address.checksum(a.to), value: Num.dec(a.value), validAfter: Num.dec(a.validAfter), validBefore: Num.dec(a.validBefore), nonce: Hex.lower(a.nonce) }
  },

  receiveDigest(tokenDomain, authorization) {
    return TypedData.hash(tokenDomain, RECEIVE_TYPES, 'ReceiveWithAuthorization', EvmSession.receiveAuthorization(authorization))
  },

  signReceive(key, tokenDomain, authorization) {
    return Secp256k1.signHash(key, EvmSession.receiveDigest(tokenDomain, authorization))
  },

  call(name, args = []) {
    if (!Object.hasOwn(FUNCTIONS, name)) throw new InvalidArgument(`the escrow has no function ${name}`)
    return Abi.encodeCall(FUNCTIONS[name], args)
  },

  selector(name) {
    return Keccak.selector(FUNCTIONS[name])
  },

  decodeCall(data) {
    const hex = Hex.lower(data)
    const name = SELECTORS.get(hex.slice(0, 10))
    if (name === undefined) return null
    const types = typesOf(FUNCTIONS[name])
    let values
    try {
      values = types.length ? Abi.decode(types, '0x' + hex.slice(10)) : []
    } catch {
      return null
    }
    const names = NAMES[name] ?? types.map((_, i) => String(i))
    return { name, values, args: Object.fromEntries(names.map((k, i) => [k, values[i]])) }
  },

  result(name, data) {
    if (!Object.hasOwn(RETURNS, name)) throw new InvalidArgument(`${name} returns nothing`)
    const out = Abi.decode(RETURNS[name], data)[0]
    if (name === 'getChannel') return channelOf(out)
    if (name === 'getChannelsBatch') return out.map(channelOf)
    return out
  },

  topic(name) {
    return Keccak.utf8(EVENTS[name].signature)
  },

  decodeEvent(log) {
    const name = TOPICS.get(String(log?.topics?.[0] ?? '').toLowerCase())
    if (name === undefined) return null
    const e = EVENTS[name]
    const out = { name, channelId: String(log.topics[1]).toLowerCase(), payer: Address.checksum(word(log.topics[2])), payee: Address.checksum(word(log.topics[3])) }
    if (e.data.length) {
      const values = Abi.decode(e.data.map(([, type]) => type), log.data)
      e.data.forEach(([k], i) => { out[k] = values[i] })
    }
    return out
  },

  errorName(data) {
    return ERROR_SELECTORS.get(String(data ?? '').slice(0, 10).toLowerCase()) ?? null
  },
})

const PAYEE_FUNCTIONS = Object.freeze({ sweep: 'sweep(address)', escrow: 'escrow()', signer: 'signer()', split: 'split()', isValidSignature: 'isValidSignature(bytes32,bytes)' })
const FACTORY_FUNCTIONS = Object.freeze({ deploy: 'deploy(address,address)', addressOf: 'addressOf(address,address)', escrow: 'escrow()' })

export const SessionPayee = Object.freeze({
  FUNCTIONS: PAYEE_FUNCTIONS,
  SWEPT: Keccak.utf8('Swept(address,uint256)'),
  call(name, args = []) {
    if (!Object.hasOwn(PAYEE_FUNCTIONS, name)) throw new InvalidArgument(`a session payee has no function ${name}`)
    return Abi.encodeCall(PAYEE_FUNCTIONS[name], args)
  },
  selector(name) {
    return Keccak.selector(PAYEE_FUNCTIONS[name])
  },
  address(data) {
    return Abi.decode(['address'], data)[0]
  },
  decodeSweep(data) {
    const hex = Hex.lower(data)
    if (hex.slice(0, 10) !== Keccak.selector(PAYEE_FUNCTIONS.sweep)) return null
    try {
      return { token: Abi.decode(['address'], '0x' + hex.slice(10))[0] }
    } catch {
      return null
    }
  },
  sweptAmount(log) {
    return BigInt(Abi.decode(['uint256'], log.data)[0])
  },
})

export const SessionPayeeFactory = Object.freeze({
  FUNCTIONS: FACTORY_FUNCTIONS,
  PAYEE_DEPLOYED: Keccak.utf8('PayeeDeployed(address,address,address)'),
  call(name, args = []) {
    if (!Object.hasOwn(FACTORY_FUNCTIONS, name)) throw new InvalidArgument(`the payee factory has no function ${name}`)
    return Abi.encodeCall(FACTORY_FUNCTIONS[name], args)
  },
  selector(name) {
    return Keccak.selector(FACTORY_FUNCTIONS[name])
  },
  address(data) {
    return Abi.decode(['address'], data)[0]
  },
  decodeDeploy(data) {
    const hex = Hex.lower(data)
    if (hex.slice(0, 10) !== Keccak.selector(FACTORY_FUNCTIONS.deploy)) return null
    try {
      const [signer, split] = Abi.decode(['address', 'address'], '0x' + hex.slice(10))
      return { signer, split }
    } catch {
      return null
    }
  },
})
