import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { join } from 'node:path'
import { Secp256k1 } from './core/secp256k1.mjs'
import { setting } from './env.mjs'

const FILE = 'keys.json'
const SEAL = 'v1:'

export class KeyError extends Error {}

function wrapKey(secret, salt) {
  return scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 })
}

export function seal(plain, secret) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', wrapKey(secret, salt), iv)
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return SEAL + Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString('base64')
}

export function unseal(sealed, secret) {
  if (typeof sealed !== 'string' || !sealed.startsWith(SEAL)) return null
  const raw = Buffer.from(sealed.slice(SEAL.length), 'base64')
  if (raw.length <= 44) return null
  try {
    const d = createDecipheriv('aes-256-gcm', wrapKey(secret, raw.subarray(0, 16)), raw.subarray(16, 28))
    d.setAuthTag(raw.subarray(28, 44))
    return Buffer.concat([d.update(raw.subarray(44)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

function newKey() {
  for (let i = 0; i < 16; i++) {
    const key = '0x' + randomBytes(32).toString('hex')
    try {
      return [key, Secp256k1.privateKeyToAddress(key)]
    } catch {
      continue
    }
  }
  throw new KeyError('could not generate a key')
}

function lock(path) {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + 10000
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600))
      return () => { try { unlinkSync(lockPath) } catch {} }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30000) unlinkSync(lockPath)
      } catch {}
      if (Date.now() > deadline) throw new KeyError(`could not lock ${path}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}

function read(path) {
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

function write(path, all) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

export function loadKeys(dir, { need = ['settle'], secret = setting('BRIDGE_KEY_SECRET'), provided = {} } = {}) {
  const out = {}
  for (const which of need) {
    if (typeof provided[which] === 'string' && provided[which] !== '') {
      const key = Secp256k1.normalizePrivateKey(provided[which])
      out[which] = { key, address: Secp256k1.privateKeyToAddress(key), source: 'option' }
    }
  }
  const missing = need.filter((w) => !out[w])
  if (!missing.length) return out
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE)
  const unlock = lock(path)
  try {
    const all = read(path)
    let changed = false
    for (const which of missing) {
      const entry = all[which]
      if (entry && (entry.sealed || entry.key)) {
        let key = entry.key ?? null
        if (entry.sealed) {
          if (!secret) throw new KeyError(`the ${which} key in ${path} is sealed; set BRIDGE_KEY_SECRET to the secret it was sealed with`)
          key = unseal(entry.sealed, secret)
          if (key === null) throw new KeyError(`the ${which} key in ${path} cannot be decrypted: BRIDGE_KEY_SECRET is missing or changed since it was made`)
        } else if (secret) {
          all[which] = { sealed: seal(key, secret), address: entry.address, created: entry.created }
          changed = true
        }
        const normalized = Secp256k1.normalizePrivateKey(key)
        out[which] = { key: normalized, address: Secp256k1.privateKeyToAddress(normalized), source: 'file' }
        continue
      }
      const [key, address] = newKey()
      all[which] = { ...(secret ? { sealed: seal(key, secret) } : { key }), address, created: new Date().toISOString() }
      out[which] = { key, address, source: 'generated' }
      changed = true
    }
    if (changed) write(path, all)
    else if (existsSync(path) && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
  } finally {
    unlock()
  }
  return out
}
