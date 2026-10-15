import { hashTypedData, recoverPublicKey } from 'viem'
import { privateKeyToAccount, publicKeyToAddress, sign } from 'viem/accounts'
import { Address, Hex, InvalidArgument, Keccak } from './hex.mjs'

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
const DOMAIN_FIELDS = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']]

function normalizeValue(type, value, types) {
  const arr = /^(.*)\[(\d*)\]$/.exec(type)
  if (arr) return (Array.isArray(value) ? value : Object.values(value ?? {})).map((v) => normalizeValue(arr[1], v, types))
  if (types[type]) return normalizeStruct(type, value, types)
  if (/^u?int\d*$/.test(type)) return BigInt(typeof value === 'string' ? value.trim() : value)
  if (type === 'address') return Address.checksum(value)
  if (/^bytes\d*$/.test(type)) return Hex.lower(value)
  return value
}

function normalizeStruct(name, data, types) {
  const out = {}
  for (const f of types[name]) out[f.name] = normalizeValue(f.type, data?.[f.name], types)
  return out
}

export const TypedData = {
  domainTypes(domain) {
    return DOMAIN_FIELDS.filter(([k]) => domain[k] !== undefined && domain[k] !== null).map(([name, type]) => ({ name, type }))
  },
  hash(domain, types, primaryType, message) {
    try {
      const all = { ...types }
      if (!all.EIP712Domain) all.EIP712Domain = TypedData.domainTypes(domain)
      const d = normalizeStruct('EIP712Domain', domain, all)
      for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k]
      const { EIP712Domain, ...rest } = all
      return hashTypedData({ domain: d, types: { EIP712Domain, ...rest }, primaryType, message: primaryType === 'EIP712Domain' ? {} : normalizeStruct(primaryType, message, all) })
    } catch (e) {
      if (e instanceof InvalidArgument) throw e
      throw new InvalidArgument(e.shortMessage ?? e.message)
    }
  },
}

export const Secp256k1 = {
  N,
  HALF_N,
  normalizePrivateKey(key) {
    const bytes = Hex.toBytes(typeof key === 'string' && !/^0x/i.test(key) ? '0x' + key : key)
    if (bytes.length !== 32) throw new InvalidArgument('a private key is 32 bytes')
    const k = BigInt('0x' + bytes.toString('hex'))
    if (k <= 0n || k >= N) throw new InvalidArgument('private key out of range')
    return '0x' + bytes.toString('hex')
  },
  publicKey(key) {
    return privateKeyToAccount(Secp256k1.normalizePrivateKey(key)).publicKey
  },
  privateKeyToAddress(key) {
    return Address.checksum(privateKeyToAccount(Secp256k1.normalizePrivateKey(key)).address)
  },
  async signHash(key, hash) {
    const digest = Hex.lower(hash)
    if (digest.length !== 66) throw new InvalidArgument('a digest is 32 bytes')
    return (await sign({ hash: digest, privateKey: Secp256k1.normalizePrivateKey(key), to: 'hex' })).toLowerCase()
  },
  parseSignature(signature) {
    const bytes = Hex.toBytes(signature)
    if (bytes.length === 64) {
      const vs = Buffer.from(bytes.subarray(32, 64))
      const yParity = vs[0] & 0x80 ? 1 : 0
      vs[0] &= 0x7f
      return { r: bytes.subarray(0, 32).toString('hex'), s: vs.toString('hex'), yParity }
    }
    if (bytes.length !== 65) throw new InvalidArgument('a signature is 65 bytes')
    const v = bytes[64]
    let yParity
    if (v === 0 || v === 1) yParity = v
    else if (v === 27 || v === 28) yParity = v - 27
    else throw new InvalidArgument('invalid signature v: ' + v)
    return { r: bytes.subarray(0, 32).toString('hex'), s: bytes.subarray(32, 64).toString('hex'), yParity }
  },
  isLowS(signature) {
    return BigInt('0x' + Secp256k1.parseSignature(signature).s) <= HALF_N
  },
  isCanonical(signature) {
    const bytes = Hex.toBytes(signature)
    return bytes.length === 65 && (bytes[64] === 27 || bytes[64] === 28) && Secp256k1.isLowS(signature)
  },
  async recoverHash(hash, signature) {
    const digest = Hex.lower(hash)
    if (digest.length !== 66) throw new InvalidArgument('a digest is 32 bytes')
    const p = Secp256k1.parseSignature(signature)
    for (const part of ['r', 's']) {
      const x = BigInt('0x' + p[part])
      if (x <= 0n || x >= N) throw new InvalidArgument(`signature ${part} out of range`)
    }
    let pub
    try {
      pub = await recoverPublicKey({ hash: digest, signature: { r: '0x' + p.r, s: '0x' + p.s, yParity: p.yParity } })
    } catch {
      throw new InvalidArgument('signature does not recover to a point')
    }
    return Address.checksum(publicKeyToAddress(pub))
  },
  hashMessage(message) {
    const bytes = message !== null && typeof message === 'object' && message.raw !== undefined ? Hex.toBytes(message.raw) : Buffer.from(String(message), 'utf8')
    return Keccak.hashHex(Hex.fromBytes(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`, 'utf8'), bytes])))
  },
  personalSign(key, message) {
    return Secp256k1.signHash(key, Secp256k1.hashMessage(message))
  },
  async recoverPersonal(message, signature) {
    if (!Secp256k1.isLowS(signature)) throw new InvalidArgument('signature s is above half the curve order')
    return Secp256k1.recoverHash(Secp256k1.hashMessage(message), signature)
  },
  async verifyPersonal(address, message, signature) {
    try {
      return Address.equals(await Secp256k1.recoverPersonal(message, signature), address)
    } catch (e) {
      if (e instanceof InvalidArgument) return false
      throw e
    }
  },
  signTypedData(key, domain, types, primaryType, message) {
    return Secp256k1.signHash(key, TypedData.hash(domain, types, primaryType, message))
  },
  async recoverTypedData(domain, types, primaryType, message, signature) {
    return Secp256k1.recoverHash(TypedData.hash(domain, types, primaryType, message), signature)
  },
}
