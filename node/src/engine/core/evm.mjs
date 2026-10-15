import { BatchSettlement } from './batch.mjs'

export const Token = Object.freeze({
  TRANSFER_TYPES: BatchSettlement.TRANSFER_AUTHORIZATION_TYPES,
  domain: BatchSettlement.tokenDomain,
  transferDigest: BatchSettlement.transferAuthorizationDigest,
  transferTypedData: BatchSettlement.transferAuthorizationTypedData,
  signTransfer: BatchSettlement.signTransferAuthorization,
  encodeTransfer: BatchSettlement.encodeTransferWithAuthorization,
})

export const Multicall3 = Object.freeze({
  ADDRESS: BatchSettlement.MULTICALL3,
  aggregate3(calls) {
    return { to: BatchSettlement.MULTICALL3, data: BatchSettlement.encodeAggregate3(calls) }
  },
})

export const Erc6492 = Object.freeze({
  parse: BatchSettlement.parseErc6492Signature,
})
