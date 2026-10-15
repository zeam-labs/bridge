import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ensureDir, readJson, readText, remove, withLock, writeAtomic } from './files.mjs'
import { Json } from './settlement/json.mjs'

const isRecord = (v) => v !== null && typeof v === 'object'

export class ChannelFileStore {
  constructor(dir) {
    const d = String(dir ?? '').replace(/\/+$/, '')
    if (d === '') throw new TypeError('a file store needs a directory')
    this.dir = ensureDir(d)
  }

  static key(channelId) {
    const id = String(channelId).toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new TypeError('a channel id is 32 bytes of hex')
    return id
  }

  path(channelId) {
    return join(this.dir, `${ChannelFileStore.key(channelId)}.json`)
  }

  async get(channelId) {
    const v = await readJson(this.path(channelId))
    return isRecord(v) ? v : null
  }

  async update(channelId, fn) {
    const path = this.path(channelId)
    const out = await withLock(path, async () => {
      const raw = await readJson(path)
      const current = isRecord(raw) ? raw : null
      const next = (await fn(current)) ?? null
      if (next === null) await remove(path)
      else await writeAtomic(path, Json.encode(next))
      return next
    })
    return out.value
  }

  async list() {
    let names = []
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return []
    }
    const out = []
    for (const n of names.filter((f) => /^0x[0-9a-f]{64}\.json$/.test(f)).sort()) {
      const r = await this.get(n.slice(0, -5))
      if (r !== null) out.push(r)
    }
    return out
  }
}

export class SentFileStore {
  static NAME = /^0x[0-9a-f]{40}-0x[0-9a-f]{64}\.json$/

  constructor(dir) {
    const d = String(dir ?? '').replace(/\/+$/, '')
    if (d === '') throw new TypeError('a file store needs a directory')
    this.dir = ensureDir(d)
  }

  static key(escrow, nonce) {
    const key = `${String(escrow).toLowerCase()}-${String(nonce).toLowerCase()}`
    if (!SentFileStore.NAME.test(`${key}.json`)) throw new TypeError('a sent authorization is named by its escrow address and its 32-byte nonce')
    return key
  }

  static whole(v, key) {
    return isRecord(v) && !Array.isArray(v) && `${String(v.escrow).toLowerCase()}-${String(v.nonce).toLowerCase()}` === key && /^\d+$/.test(String(v.validBefore ?? '')) && Number.isFinite(Number(v.at))
  }

  path(key) {
    return join(this.dir, `${key}.json`)
  }

  async read(key) {
    const path = this.path(key)
    const raw = await readText(path)
    if (raw === null) return null
    let v = null
    try {
      v = JSON.parse(raw)
    } catch {
      v = null
    }
    if (SentFileStore.whole(v, key)) return { record: v }
    let at = null
    try {
      at = Math.trunc((await fs.stat(path)).mtimeMs)
    } catch {
      at = null
    }
    return { corrupt: true, at, path }
  }

  get(escrow, nonce) {
    return this.read(SentFileStore.key(escrow, nonce))
  }

  async put(record) {
    const path = this.path(SentFileStore.key(record.escrow, record.nonce))
    await withLock(path, () => writeAtomic(path, Json.encode(record)))
  }

  async remove(escrow, nonce) {
    const path = this.path(SentFileStore.key(escrow, nonce))
    await withLock(path, () => remove(path))
  }

  async prune(nowSecs, corruptBeforeMs) {
    const out = { removed: 0, corrupt: [] }
    let names = []
    try {
      names = await fs.readdir(this.dir)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    for (const n of names.filter((f) => SentFileStore.NAME.test(f)).sort()) {
      const key = n.slice(0, -5)
      const hit = await this.read(key)
      if (hit === null) continue
      if (hit.corrupt === true) out.corrupt.push(hit.path)
      if (hit.corrupt === true ? hit.at !== null && hit.at < corruptBeforeMs : BigInt(hit.record.validBefore) <= BigInt(nowSecs)) {
        await withLock(this.path(key), () => remove(this.path(key)))
        out.removed++
      }
    }
    return out
  }
}

export class GateFileStore {
  constructor(dir) {
    const d = String(dir ?? '').replace(/\/+$/, '')
    if (d === '') throw new TypeError('a file store needs a directory')
    this.dir = ensureDir(d)
  }

  path(key) {
    const k = String(key)
    return join(this.dir, `${k.toLowerCase().replace(/[^a-z0-9_.-]/g, '_')}-${createHash('sha1').update(k).digest('hex').slice(0, 12)}.json`)
  }

  async get(key) {
    const v = await readJson(this.path(key))
    return isRecord(v) ? v : null
  }

  async update(key, change) {
    const path = this.path(key)
    const out = await withLock(path, async () => {
      const raw = await readJson(path)
      const current = isRecord(raw) ? raw : null
      const [next, result] = await change(current)
      if (Json.encode(next ?? null) !== Json.encode(current)) await writeAtomic(path, Json.encode(next ?? null))
      return result
    })
    return out.value
  }
}

export class StateFile {
  constructor(dir, name) {
    this.path = join(ensureDir(dir), name)
  }

  async get() {
    return readJson(this.path)
  }

  async set(value) {
    await writeAtomic(this.path, Json.encode(value))
  }

  async update(fn) {
    return (await withLock(this.path, async () => {
      const next = await fn(await readJson(this.path))
      await writeAtomic(this.path, Json.encode(next))
      return next
    })).value
  }
}

export class MppHeldFiles {
  static PRUNE_EVERY_MS = 60000
  static WRITING_MS = 30000

  constructor(dir) {
    const d = String(dir ?? '').replace(/\/+$/, '')
    if (d === '') throw new TypeError('a file store needs a directory')
    this.dir = ensureDir(d)
    this.prunedAt = 0
  }

  path(key) {
    return join(this.dir, `${createHash('sha256').update(String(key)).digest('hex')}.json`)
  }

  async claim(key, untilMs, nowMs) {
    if (nowMs - this.prunedAt > MppHeldFiles.PRUNE_EVERY_MS) {
      this.prunedAt = nowMs
      await this.prune(nowMs).catch(() => {})
    }
    const path = this.path(key)
    for (let tries = 0; tries < 2; tries++) {
      let h
      try {
        h = await fs.open(path, 'wx', 0o600)
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        const had = await readJson(path)
        if (isRecord(had) ? Number(had.until) > nowMs : await this.writing(path)) return false
        await remove(path)
        continue
      }
      try {
        await h.writeFile(JSON.stringify({ key: String(key), until: Math.trunc(Number(untilMs)) }))
        await h.sync()
      } finally {
        await h.close()
      }
      return true
    }
    return false
  }

  async writing(path) {
    try {
      return Date.now() - (await fs.stat(path)).mtimeMs < MppHeldFiles.WRITING_MS
    } catch {
      return false
    }
  }

  async release(key) {
    await remove(this.path(key))
  }

  async names() {
    try {
      return (await fs.readdir(this.dir)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
    } catch (e) {
      if (e.code === 'ENOENT') return []
      throw e
    }
  }

  async prune(nowMs) {
    for (const n of await this.names()) {
      const path = join(this.dir, n)
      const had = await readJson(path)
      if (isRecord(had) ? Number(had.until) <= nowMs : !(await this.writing(path))) await remove(path)
    }
  }

  async clear() {
    for (const n of await this.names()) await remove(join(this.dir, n))
  }
}
