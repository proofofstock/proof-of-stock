// scripts/stocks/issuer-mirror.mjs: the issuer's token list rebuilt from the chain itself, as a second source beside
// the issuer's API (owner, 12.11: every chain has a reserve and a mirror).
//
// Each issuer deploys its stock tokens from a factory that logs one event per token. Read with eth_getLogs, from the
// factory's first block on, those events are the set of tokens the issuer itself created:
//   Base: Coinbase's factory 0x4ba3e29e...534d (published at api.coinbase.com/v1/tokenized-stocks/chains); topic1 is
//         the token, the data holds name, symbol and decimals. Logs from a keyless public gateway, 1,000 blocks a call.
//   Robinhood Chain: Robinhood's factory 0x4783c67b...c046, found 12.11 from the tokens themselves (each is a
//         BeaconProxy on one beacon; every proxy's creation went through this factory). The token is the first word of
//         the data, then name and symbol. Robinhood's public RPC answers 10,000,000 blocks a call with an address.
//   Checked 12.11 on Robinhood Chain: 212 tokens created by the factory, all 203 of the API's list among them.
//
// ⚠ CREATED BY THE FACTORY IS NOT LISTED. The factory also made tokens the API does not list (tests, delisted, not yet
// listed: 9 on Robinhood, 12.11). The mirror never turns into "listed"; it answers its own question, "did the issuer's
// factory create this contract", with the log (block, transaction, log index) as evidence. Its strongest use is the
// reverse check: a token on the API's list that the factory never created would be a red flag about the list.
//
// State: <root>/stock-peg/mirror.json { chain, factory, topic0, from_block, scanned_to, head, tokens: [...],
// comparison }. A run scans forward from scanned_to within a time budget, so the first backfill spreads over a few runs
// and a normal run costs a call or two. A failure leaves the state as it was. STP_LOGS_RPC_<CHAIN> replaces the source.
import fs from 'node:fs'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64)
const str = (hex, offsetBytes) => {
  if (!Number.isFinite(offsetBytes)) return null
  const at = offsetBytes * 2 + 2
  const len = parseInt(hex.slice(at, at + 64), 16)
  if (!Number.isFinite(len) || len > 256) return null
  try { return Buffer.from(hex.slice(at + 64, at + 64 + len * 2), 'hex').toString('utf8') } catch (_) { return null }
}
const addr = (h) => { const a = '0x' + String(h).slice(-40).toLowerCase(); return /^0x[0-9a-f]{40}$/.test(a) ? a : null }

export const MIRRORS = Object.freeze({
  base: {
    issuer: 'coinbase',
    factory: '0x4ba3e29e254f25e94e61c4c9d67b37027331534d',
    topic0: '0x5c43a3074411409ce140dea2139563c088f43588c8ab6a2b8e2119a670576ce1',
    from_block: 48459816, // the first block with the factory's code (eth_getCode, 12.11)
    rpc: 'https://base.gateway.tenderly.co', env: 'STP_LOGS_RPC_BASE', range: 1000, paceMs: 300, // keyless: rate limited after ~200 calls at 100 ms (12.11)
    decode: (d, topics) => ({ address: addr(topics[1]), name: str(d, parseInt(word(d, 0), 16)), symbol: str(d, parseInt(word(d, 1), 16)), decimals: parseInt(word(d, 4), 16) }),
  },
  robinhood: {
    issuer: 'robinhood',
    factory: '0x4783c67b63de2b358ac5951a7d41f47a38f3c046',
    topic0: '0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6',
    from_block: 0, // the beacon's first event is at block 7,796, the first token at 19,698 (12.11)
    rpc: 'https://rpc.mainnet.chain.robinhood.com', env: 'STP_LOGS_RPC_ROBINHOOD', range: 10_000_000,
    decode: (d) => ({ address: addr(word(d, 0)), name: str(d, parseInt(word(d, 1), 16)), symbol: str(d, parseInt(word(d, 2), 16)), decimals: null }),
  },
})

/** One factory log into a token record, or null when it is not one. */
export function tokenOf (chain, log) {
  const cfg = MIRRORS[chain]
  if (!cfg || !log || !Array.isArray(log.topics) || String(log.topics[0]).toLowerCase() !== cfg.topic0) return null
  let t
  try { t = cfg.decode(String(log.data || '0x'), log.topics) } catch (_) { return null }
  if (!t || !t.address) return null
  return { address: t.address, block: parseInt(log.blockNumber, 16), tx: log.transactionHash, log_index: parseInt(log.logIndex, 16), name: t.name ?? null, symbol: t.symbol ?? null, decimals: Number.isFinite(t.decimals) ? t.decimals : null }
}

export function readMirror (dir, chain) {
  try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'mirror.json'), 'utf8')); return m && m.chain === chain ? m : null } catch (_) { return null }
}

/**
 * Scan forward from where the mirror stopped, until the head or the time budget, and write it back. Never throws.
 * @returns {{ ok, error, calls, added, scanned_to, head, tokens, caught_up }}
 */
export async function updateMirror ({ chain, dir, fetchImpl = globalThis.fetch, env = process.env, budgetMs = 240_000, paceMs = null, clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cfg = MIRRORS[chain]
  if (!cfg) return { ok: false, error: 'no mirror for this chain', calls: 0, added: 0, scanned_to: null, head: null, tokens: 0, caught_up: false }
  const url = env[cfg.env] || cfg.rpc
  const m = readMirror(dir, chain) || { chain, issuer: cfg.issuer, factory: cfg.factory, topic0: cfg.topic0, from_block: cfg.from_block, scanned_to: cfg.from_block - 1, head: null, tokens: [] }
  const rpc = async (method, params) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
    const j = await r.json().catch(() => null)
    if (!j || j.error || j.result === undefined) throw new Error(`rpc ${method}: ${String(j?.error?.message || 'HTTP ' + r.status).slice(0, 120)}`)
    return j.result
  }
  const start = clock()
  const pace = paceMs ?? cfg.paceMs ?? 100
  let calls = 0, added = 0, head = null, error = null, throttled = false
  try {
    head = parseInt(await rpc('eth_blockNumber', []), 16)
    m.head = head
    const known = new Set(m.tokens.map((t) => t.address))
    while (m.scanned_to < head && clock() - start < budgetMs) {
      if (calls && pace > 0) await sleep(pace)
      const from = m.scanned_to + 1, to = Math.min(head, from + cfg.range - 1)
      const logs = await rpc('eth_getLogs', [{ address: cfg.factory, topics: [cfg.topic0], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])
      calls++
      for (const l of logs) { const t = tokenOf(chain, l); if (t && !known.has(t.address)) { m.tokens.push(t); known.add(t.address); added++ } }
      m.scanned_to = to
    }
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 200)
    // A rate limit during a backfill is a pause, not a failure: the progress is kept and the next run goes on from it.
    if (/rate limit|too many|429/i.test(msg)) throttled = true; else error = msg
  }
  m.updated_at = new Date(clock()).toISOString()
  try { const f = path.join(dir, 'mirror.json'), tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, f) } catch (e) { error = error || String(e && e.message || e).slice(0, 200) }
  return { ok: !error, error, throttled, calls, added, scanned_to: m.scanned_to, head, tokens: m.tokens.length, caught_up: head != null && m.scanned_to >= head }
}

/** Mirror against the issuer's list: what each has that the other does not. Only meaningful once caught up. */
export function compareMirror (mirror, listAddresses) {
  const list = new Set(listAddresses.map((a) => String(a).toLowerCase()))
  const created = new Set((mirror?.tokens || []).map((t) => t.address))
  return { listed: list.size, created: created.size, on_list_not_created: [...list].filter((a) => !created.has(a)).sort(), created_not_on_list: [...created].filter((a) => !list.has(a)).sort() }
}

/** Record the comparison in the mirror file (only when caught up), so the health check and the site can read it. */
export function recordComparison (dir, chain, listAddresses, at) {
  const m = readMirror(dir, chain)
  if (!m || m.head == null || m.scanned_to < m.head) return null
  const c = { at, ...compareMirror(m, listAddresses) }
  m.comparison = c
  const f = path.join(dir, 'mirror.json'), tmp = f + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, f)
  return c
}

if (isEntryPoint(import.meta.url)) {
  const { readCoinbase, readRobinhood } = await import('../../evm/core/stocks/registries.mjs')
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const chain = arg('chain'), root = arg('root')
  if (!MIRRORS[chain] || !root) { console.error('usage: issuer-mirror.mjs --chain=base|robinhood --root=<data root>'); process.exit(2) }
  const dir = path.join(root, 'stock-peg')
  const res = await updateMirror({ chain, dir, budgetMs: Number(arg('budget-s') || 240) * 1000 })
  let comparison = null
  if (res.caught_up) {
    try {
      const records = await (chain === 'base' ? readCoinbase : readRobinhood)(fetch, { chainId: chain === 'base' ? 8453 : 4663 })
      comparison = recordComparison(dir, chain, records.filter((r) => r.chain_id === (chain === 'base' ? 8453 : 4663)).map((r) => r.address), new Date().toISOString())
    } catch (e) { res.error = res.error || 'issuer list: ' + String(e && e.message || e).slice(0, 120) }
  }
  console.log('[issuer-mirror] ' + JSON.stringify({ chain, ...res, comparison: comparison && { listed: comparison.listed, created: comparison.created, on_list_not_created: comparison.on_list_not_created.length, created_not_on_list: comparison.created_not_on_list.length } }))
  if (!res.ok) process.exitCode = 1
}
