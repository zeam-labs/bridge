import { Address, Hex, Num } from './core/hex.mjs'
import { ESCROWS } from './settlement/x402.mjs'

export const ESCROW_FROM_BLOCK = ESCROWS.default.fromBlock
export const LOG_PAGE_BLOCKS = 100000
export const LOG_PAGES_AT_ONCE = 8
const hex = (n) => '0x' + BigInt(n).toString(16)
const whole = (v, what) => {
  if (!((typeof v === 'number' && Number.isSafeInteger(v)) || typeof v === 'bigint') || BigInt(v) < 0n) throw new TypeError(`bridge: ${what} is a whole number, 0 or more`)
  return BigInt(v)
}
const some = (v, what) => {
  if (whole(v, what) < 1n) throw new TypeError(`bridge: ${what} is a whole number, 1 or more`)
  return BigInt(v)
}
const digits = (v) => typeof v === 'string' && /^\d{1,78}$/.test(v)
const keptOf = (v) => (v !== null && typeof v === 'object' && digits(v.through) && digits(v.total) && Number.isSafeInteger(v.count) && v.count >= 0 ? { through: BigInt(v.through), total: BigInt(v.total), count: v.count } : null)
const record = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {})

function advance(tally, logs, to, edge, amountOf) {
  const recent = [...tally.recent, ...logs.map((l) => [BigInt(l.blockNumber), amountOf(l)])]
  const reach = to < edge ? to : edge
  const through = reach > tally.kept.through ? reach : tally.kept.through
  let { total, count } = tally.kept
  const rest = []
  for (const e of recent) {
    if (e[0] > through) rest.push(e)
    else {
      total += e[1]
      count += 1
    }
  }
  return { through: to, kept: { through, total, count }, recent: rest }
}

export class Books {
  constructor(chain, file = null, escrow = ESCROWS.default) {
    this.chain = chain
    this.file = file
    this.escrow = escrow
    this.tallies = new Map()
    this.loaded = null
  }

  saved() {
    this.loaded ??= Promise.resolve(this.file ? this.file.get() : null).then((v) => new Map(Object.entries(record(v)).map(([k, t]) => [k, keptOf(t)]).filter(([, t]) => t !== null)), () => new Map())
    return this.loaded
  }

  async save(rows) {
    if (!this.file) return
    const saved = await this.saved()
    const ahead = rows.filter((r) => r.tally.kept.through > (saved.get(r.key)?.through ?? r.from - 1n))
    if (ahead.length === 0) return
    for (const r of ahead) saved.set(r.key, r.tally.kept)
    await this.file.update((was) => {
      const next = { ...record(was) }
      for (const r of ahead) {
        const k = r.tally.kept
        if ((keptOf(next[r.key])?.through ?? -1n) < k.through) next[r.key] = { through: String(k.through), total: String(k.total), count: k.count }
      }
      return next
    }).catch(() => {})
  }

  async scan(rows, token, head, page) {
    const edge = head - BigInt(LOG_PAGE_BLOCKS)
    const filter = this.escrow.collectedFilter(rows.map((r) => r.address), token)
    let from = rows[0].tally.through + 1n
    while (from <= head) {
      const pages = []
      while (pages.length < LOG_PAGES_AT_ONCE && from <= head) {
        const to = from + page - 1n > head ? head : from + page - 1n
        pages.push([from, to])
        from = to + 1n
      }
      const read = await Promise.all(pages.map(([a, b]) => this.chain.rpc('eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }])))
      const logs = read.flatMap((l) => (Array.isArray(l) ? l : []))
      for (const r of rows) {
        r.tally = advance(r.tally, logs.filter((l) => this.escrow.collectedIsFor(l, r.address)), pages[pages.length - 1][1], edge, this.escrow.collectedAmount)
        const now = this.tallies.get(r.key)
        if (!now || r.tally.through > now.through) this.tallies.set(r.key, r.tally)
      }
      await this.save(rows)
    }
  }

  async totals(receiver, token, head) {
    const call = async (to, data) => {
      const ask = (at) => this.chain.rpc('eth_call', [{ to: Address.checksum(to), data: Hex.lower(data) }, at])
      return String(await ask(hex(head)).catch(() => ask('latest')))
    }
    const read = await this.escrow.readPayee(call, receiver, token)
    return { totalClaimed: BigInt(read.totalClaimed), totalSettled: BigInt(read.totalSettled) }
  }

  async read(receivers, token, { fromBlock = this.escrow.fromBlock, pageBlocks = LOG_PAGE_BLOCKS } = {}) {
    const from = whole(fromBlock, 'books fromBlock')
    const page = some(pageBlocks, 'books pageBlocks')
    const head = BigInt(Num.dec(await this.chain.rpc('eth_blockNumber')))
    const saved = await this.saved()
    const rows = new Map()
    for (const r of receivers) {
      const key = `${r.address.toLowerCase()}:${token.toLowerCase()}:${from}`
      if (rows.has(key)) continue
      const kept = saved.get(key) ?? { through: from - 1n, total: 0n, count: 0 }
      rows.set(key, { key, from, address: r.address, tally: this.tallies.get(key) ?? { through: kept.through, kept, recent: [] } })
    }
    const scans = new Map()
    for (const row of rows.values()) scans.set(row.tally.through, [...(scans.get(row.tally.through) ?? []), row])
    const [totals] = await Promise.all([
      Promise.all([...rows.values()].map((row) => this.totals(row.address, token, head))),
      ...[...scans.values()].map((group) => this.scan(group, token, head, page)),
    ])
    const read = new Map([...rows.keys()].map((key, i) => [key, totals[i]]))
    const books = receivers.map((r) => {
      const key = `${r.address.toLowerCase()}:${token.toLowerCase()}:${from}`
      const { tally } = rows.get(key)
      const { totalClaimed, totalSettled } = read.get(key)
      const settled = tally.recent.reduce((sum, e) => sum + e[1], tally.kept.total)
      return {
        receiver: Address.checksum(r.address),
        role: r.role,
        token: Address.checksum(token),
        totalClaimed: String(totalClaimed),
        totalSettled: String(totalSettled),
        settledFromEvents: String(settled),
        unsettled: String(totalClaimed - totalSettled),
        settleEvents: tally.kept.count + tally.recent.length,
        scannedThroughBlock: String(tally.through),
        agrees: totalSettled === settled,
      }
    })
    const disagreeing = books.filter((b) => !b.agrees).length
    return { ok: disagreeing === 0, checked: books.length, disagreeing, books }
  }
}

export async function gasOf(chain, wallets, { gasUnitsPerTransaction, targetTransactions = 1, lowBelowTransactions = 1 }, now) {
  const units = some(gasUnitsPerTransaction, 'gas gasUnitsPerTransaction')
  const target = some(targetTransactions, 'gas targetTransactions')
  const lowBelow = some(lowBelowTransactions, 'gas lowBelowTransactions')
  const readAt = new Date(now).toISOString()
  try {
    const price = BigInt(await chain.gasPrice())
    const balances = []
    for (const w of wallets) balances.push(BigInt(Num.dec(await chain.rpc('eth_getBalance', [w.address, 'latest']))))
    const perTx = price * units
    const rows = wallets.map((w, i) => {
      const covers = perTx > 0n ? Number(balances[i] / perTx) : null
      const short = perTx * target - balances[i]
      return { name: w.name, address: w.address, wei: balances[i].toString(), coversTransactions: covers, empty: covers !== null && covers < 1, low: covers !== null && covers < Number(lowBelow), toTargetWei: (short > 0n ? short : 0n).toString() }
    })
    const empty = rows.filter((r) => r.empty).map((r) => r.name)
    return { ok: empty.length === 0, ...(empty.length ? { error: 'out_of_gas', message: `no gas to send a transaction: ${empty.join(', ')}` } : {}), empty, readAt, gasPriceWei: price.toString(), gasUnitsPerTransaction: Number(units), targetTransactions: Number(target), lowBelowTransactions: Number(lowBelow), low: rows.filter((r) => r.low).map((r) => r.name), wallets: rows }
  } catch (e) {
    return { ok: false, readAt, error: String(e?.message ?? e).slice(0, 120), empty: [], low: [], wallets: [] }
  }
}
