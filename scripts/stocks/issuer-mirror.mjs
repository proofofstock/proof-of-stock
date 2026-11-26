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
// State: <root>/stock-peg/mirror.json, schema 2 (docs/list-locks-tz.md, owner 25.11):
//   { schema, chain, issuer, factory, topic0, from_block, scanned_to, tokens: [...], last_ok, last_error, updated_at,
//     comparison }
// A run scans forward from scanned_to within a time budget, so the first backfill spreads over a few runs and a normal
// run costs a call or two. A failure leaves the progress as it was. STP_LOGS_RPC_<CHAIN> replaces the source.
//
// ⚠ ONLY FINALIZED BLOCKS. The scan target is the chain's own `finalized` block, never the head: a creation in a block
// that a reorganisation later drops must never be recorded. An RPC that cannot say which block is finalized is an
// error, never a fall back to the head.
// ⚠ A LOG IS CHECKED BEFORE IT COUNTS: emitted by the pinned factory, under the pinned topic, not `removed`, inside the
// block range asked, with 32-byte block and transaction hashes. The block hash is kept with the token. The RPC is still
// trusted to report logs truthfully; that is the boundary, said in docs/list-locks-tz.md.
// ⚠ SUCCESS IS RECORDED APART FROM AN ATTEMPT. `updated_at` is every run; `last_ok` ({ at, started_at, target_block,
// target_block_time }) only a run that reached its finalized target; `last_error` the last failure, null after a success.
// Freshness is read from `last_ok`, never from `updated_at` (outside review, 25.11: a failing RPC looked fresh).
// ⚠ A RECORDED CREATION IS CHECKED AGAIN, AND CAN BE TAKEN BACK (revalidateMirror). Once a day, and first for tokens
// never checked, the creation's receipt must still be there, in the same block, successful, with the factory's log
// creating that token. A receipt that does not hold it is not yet proof: the block decides (provenAbsent). Only when
// the recorded block is no longer the chain's block at that height, or it is and the factory's log is not in it, the
// token leaves `tokens` for `revoked` with when and why, and an alert fires. A missing receipt or transaction alone is
// never proof: a node with a pruned transaction index answers null for every older one (outside review, 25.11).
// ⚠ A REVOKED TOKEN COMES BACK WHEN THE CHAIN SHOWS IT. A later scan (or lookup, or reconcile) that reads a valid
// creation log for it restores it, with `restored_at`. A refused mirror file keeps its `revoked` through the rebuild.
// ⚠ A MISSED LOG CANNOT HOLD A LISTING FOREVER (lookupAwaiting, reconcileMirror). An address on the issuer's list that
// the factory has not been seen creating for CONFIRM_MS is looked for on its own: on Base by bisecting for its first
// block with code and reading the factory's log in that block; on Robinhood by reading every factory log again. A
// slow reconcile walks the whole range again, a slice per run, and starts over a week after it finishes. Both only
// ever add a creation they can see in a log that passes tokenOf; neither removes one.
// ⚠ A SECOND RPC, WHERE THERE IS ONE (confirmSecond). Each creation is asked of a second RPC run by someone else, by
// its receipt: it must hold the same creation (receiptHolds). Confirmed creations carry `second_at`. One the second RPC
// contradicts (another block, no such log, or no transaction at all) is revoked like any other, saying which RPC.
// The mirror says how many sources it has (`sources`: 1 or 2); the gate (docs/list-locks-tz.md) will ask for both
// where there are two. The URL itself is never written down: a host's own RPC URL may carry a key.
// ⚠ ONE VALIDATOR FOR EVERY READER. validMirror() checks the schema, the pins, the block numbers and the times; the
// scanner (readMirror) and the web process (apps/stocks-web.mjs) both go through it. A file from another factory,
// topic or start block, or from schema 1, is not read: the mirror is rebuilt from the start, and the refused file is
// kept beside it as mirror.refused-<time>.json, one per refusal.
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
    // An address waiting for its creation is found by its first block with code (historical eth_getCode answers on
    // Base, checked 25.11), then the factory's log in that one block, filtered by the token as topic1.
    lookup: 'code_bisect', tokenTopic: true,
    // A second source for each creation, run by another operator than the logs gateway (docs/list-locks-tz.md v3, 3).
    second: 'https://mainnet.base.org', secondEnv: 'STP_VERIFY_RPC_BASE',
    decode: (d, topics) => ({ address: addr(topics[1]), name: str(d, parseInt(word(d, 0), 16)), symbol: str(d, parseInt(word(d, 1), 16)), decimals: parseInt(word(d, 4), 16) }),
  },
  robinhood: {
    issuer: 'robinhood',
    factory: '0x4783c67b63de2b358ac5951a7d41f47a38f3c046',
    topic0: '0xd9b0c6a1c0de228715ad0fa09f3259686ee84f8cc675e03ef7e47a9cdafa76d6',
    from_block: 0, // the beacon's first event is at block 7,796, the first token at 19,698 (12.11)
    rpc: 'https://rpc.mainnet.chain.robinhood.com', env: 'STP_LOGS_RPC_ROBINHOOD', range: 10_000_000,
    // No historical state on Robinhood's RPC (checked 25.11), but 10M blocks a call: a waiting address is looked for
    // by reading every factory log again, a dozen calls for the whole chain.
    lookup: 'rescan', tokenTopic: false,
    // No second public RPC is known for Robinhood Chain: none unless the host sets one.
    second: null, secondEnv: 'STP_VERIFY_RPC_ROBINHOOD',
    decode: (d) => ({ address: addr(word(d, 0)), name: str(d, parseInt(word(d, 1), 16)), symbol: str(d, parseInt(word(d, 2), 16)), decimals: null }),
  },
})

export const SCHEMA = 2
/** A last_ok further ahead of the clock than this is no last_ok. */
export const FUTURE_SKEW_MS = 5 * 60e3
const HASH32 = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const isBlock = (n) => Number.isInteger(n) && n >= 0
const hexInt = (h) => (typeof h === 'string' && /^0x[0-9a-f]+$/i.test(h) ? Number.parseInt(h, 16) : NaN)

/**
 * One factory log into a token record, or null when it is not one. `range` ({ from, to }) is the block range the log
 * was asked for: a log outside it is not believed.
 */
export function tokenOf (chain, log, range = null) {
  const cfg = MIRRORS[chain]
  if (!cfg || !log || !Array.isArray(log.topics) || String(log.topics[0]).toLowerCase() !== cfg.topic0) return null
  if (String(log.address || '').toLowerCase() !== cfg.factory) return null
  if (log.removed === true) return null
  const block = hexInt(log.blockNumber), logIndex = hexInt(log.logIndex)
  const blockHash = String(log.blockHash || '').toLowerCase(), tx = String(log.transactionHash || '').toLowerCase()
  if (!isBlock(block) || !isBlock(logIndex) || !HASH32.test(blockHash) || !HASH32.test(tx)) return null
  if (range && (block < range.from || block > range.to)) return null
  let t
  try { t = cfg.decode(String(log.data || '0x'), log.topics) } catch (_) { return null }
  if (!t || !t.address) return null
  return { address: t.address, block, block_hash: blockHash, tx, log_index: logIndex, name: t.name ?? null, symbol: t.symbol ?? null, decimals: Number.isFinite(t.decimals) ? t.decimals : null }
}

/**
 * The mirror, if it is one this code may trust: schema 2, this chain's pins, block numbers that are integers, tokens
 * that carry their evidence. A `last_ok` that is malformed or in the future is dropped (the mirror then counts as never
 * having succeeded). Null otherwise. Pure.
 */
export function validMirror (m, chain, now = Date.now()) {
  const cfg = MIRRORS[chain]
  if (!cfg || !m || typeof m !== 'object' || Array.isArray(m)) return null
  if (m.schema !== SCHEMA || m.chain !== chain || m.factory !== cfg.factory || m.topic0 !== cfg.topic0 || m.from_block !== cfg.from_block) return null
  if (!(m.scanned_to === null || (isBlock(m.scanned_to) && m.scanned_to >= cfg.from_block))) return null
  const isTime = (v) => v === undefined || (typeof v === 'string' && Number.isFinite(Date.parse(v)))
  if (!Array.isArray(m.tokens) || !m.tokens.every((t) => t && ADDRESS.test(t.address) && isBlock(t.block) && HASH32.test(t.block_hash) && HASH32.test(t.tx) && isBlock(t.log_index) && isTime(t.checked_at) && isTime(t.second_at))) return null
  if (m.sources !== undefined && m.sources !== 1 && m.sources !== 2) return null
  if (m.awaiting !== undefined && !(m.awaiting && typeof m.awaiting === 'object' && !Array.isArray(m.awaiting) && Object.entries(m.awaiting).every(([a, w]) => ADDRESS.test(a) && w && Number.isFinite(Date.parse(w.since))))) return null
  if (m.reconcile !== undefined && !(m.reconcile && (m.reconcile.at === null || isBlock(m.reconcile.at)))) return null
  if (m.revoked !== undefined && !(Array.isArray(m.revoked) && m.revoked.every((t) => t && ADDRESS.test(t.address) && typeof t.revoked_at === 'string' && Number.isFinite(Date.parse(t.revoked_at)) && typeof t.why === 'string'))) return null
  const ok = m.last_ok
  const at = ok && Date.parse(ok.at), started = ok && Date.parse(ok.started_at), tt = ok && Date.parse(ok.target_block_time)
  const goodOk = ok && typeof ok === 'object' && Number.isFinite(at) && Number.isFinite(started) && Number.isFinite(tt) && started <= at && at <= now + FUTURE_SKEW_MS && isBlock(ok.target_block) && m.scanned_to !== null && m.scanned_to >= ok.target_block
  return goodOk ? m : { ...m, last_ok: null }
}

/** Has the mirror covered its last finalized target? The one test of "caught up" every reader uses. */
export const caughtUp = (m) => Boolean(m && m.last_ok && m.scanned_to !== null && m.scanned_to >= m.last_ok.target_block)

export function readMirror (dir, chain, now = Date.now()) {
  try { return validMirror(JSON.parse(fs.readFileSync(path.join(dir, 'mirror.json'), 'utf8')), chain, now) } catch (_) { return null }
}

/** A JSON-RPC caller for one URL. Throws on a transport error, an error answer or a missing result. */
export const rpcCaller = (url, fetchImpl) => async (method, params) => {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
  const j = await r.json().catch(() => null)
  if (!j || j.error || j.result === undefined) throw new Error(`rpc ${method}: ${String(j?.error?.message || 'HTTP ' + r.status).slice(0, 120)}`)
  return j.result
}

const freshMirror = (chain) => {
  const cfg = MIRRORS[chain]
  return { schema: SCHEMA, chain, issuer: cfg.issuer, factory: cfg.factory, topic0: cfg.topic0, from_block: cfg.from_block, scanned_to: null, tokens: [], last_ok: null, last_error: null, updated_at: null }
}

/**
 * Scan forward from where the mirror stopped, until the chain's finalized block or the time budget, and write it back.
 * Never throws.
 * @returns {{ ok, error, throttled, calls, added, rejected, scanned_to, target, tokens, caught_up, rebuilt }}
 */
export async function updateMirror ({ chain, dir, fetchImpl = globalThis.fetch, env = process.env, budgetMs = 240_000, paceMs = null, clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cfg = MIRRORS[chain]
  if (!cfg) return { ok: false, error: 'no mirror for this chain', calls: 0, added: 0, rejected: 0, scanned_to: null, target: null, tokens: 0, caught_up: false, rebuilt: false }
  const url = env[cfg.env] || cfg.rpc
  const file = path.join(dir, 'mirror.json')
  let m = readMirror(dir, chain, clock())
  let rebuilt = false
  if (!m) {
    // A file this code may not trust (schema 1, other pins, malformed) is kept once beside, then rebuilt from the start.
    try { if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, `mirror.refused-${new Date(clock()).toISOString().replace(/[:.]/g, '-')}.json`)) } catch (_) {}
    rebuilt = fs.existsSync(file)
    m = freshMirror(chain)
    // What was taken back stays known through a rebuild, so its alert does not go quiet (outside review, 25.11).
    try {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'))
      const kept = Array.isArray(old && old.revoked) ? old.revoked.filter((t) => t && ADDRESS.test(t.address) && isBlock(t.block) && HASH32.test(String(t.block_hash)) && HASH32.test(String(t.tx)) && isBlock(t.log_index) && typeof t.revoked_at === 'string' && Number.isFinite(Date.parse(t.revoked_at)) && typeof t.why === 'string') : []
      if (kept.length) m.revoked = kept
      if (old && old.awaiting && typeof old.awaiting === 'object' && !Array.isArray(old.awaiting)) {
        const aw = Object.fromEntries(Object.entries(old.awaiting).filter(([a, w]) => ADDRESS.test(a) && w && Number.isFinite(Date.parse(w.since))))
        if (Object.keys(aw).length) m.awaiting = aw
      }
    } catch (_) {}
  }
  const rpc = rpcCaller(url, fetchImpl)
  const start = clock()
  const pace = paceMs ?? cfg.paceMs ?? 100
  let calls = 0, added = 0, rejected = 0, target = null, error = null, throttled = false
  try {
    const fin = await rpc('eth_getBlockByNumber', ['finalized', false])
    target = hexInt(fin && fin.number)
    const targetTime = hexInt(fin && fin.timestamp) * 1000
    if (!isBlock(target) || !Number.isFinite(targetTime)) throw new Error('rpc eth_getBlockByNumber: no finalized block')
    // A revoked token is not "known": a valid creation log for it, read now, restores it.
    const known = new Set(m.tokens.map((t) => t.address))
    const next = () => (m.scanned_to === null ? cfg.from_block : m.scanned_to + 1)
    while (next() <= target && clock() - start < budgetMs) {
      if (calls && pace > 0) await sleep(pace)
      const from = next(), to = Math.min(target, from + cfg.range - 1)
      const logs = await rpc('eth_getLogs', [{ address: cfg.factory, topics: [cfg.topic0], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])
      calls++
      if (!Array.isArray(logs)) throw new Error('rpc eth_getLogs: not a list')
      for (const l of logs) {
        const t = tokenOf(chain, l, { from, to })
        if (!t) { rejected++; continue }
        if (!known.has(t.address)) { addCreation(m, t, clock()); known.add(t.address); added++ }
      }
      m.scanned_to = to
    }
    if (m.scanned_to !== null && m.scanned_to >= target) {
      m.last_ok = { at: new Date(clock()).toISOString(), started_at: new Date(start).toISOString(), target_block: target, target_block_time: new Date(targetTime).toISOString() }
      m.last_error = null
    }
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 200)
    // A rate limit during a backfill is a pause, not a failure: the progress is kept and the next run goes on from it.
    if (/rate limit|too many|429/i.test(msg)) throttled = true; else error = msg
    m.last_error = msg
  }
  m.updated_at = new Date(clock()).toISOString()
  try { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, file) } catch (e) { error = error || String(e && e.message || e).slice(0, 200) }
  return { ok: !error, error, throttled, calls, added, rejected, scanned_to: m.scanned_to, target, tokens: m.tokens.length, caught_up: caughtUp(m), rebuilt }
}

export const CONFIRM_MS = 30 * 60e3
export const LOOKUP_EVERY_MS = 6 * 3600e3
export const LOOKUP_MAX_PER_RUN = 5
export const RECONCILE_EVERY_MS = 7 * 864e5
export const RECONCILE_CALLS_PER_RUN = 80
const topicOf = (a) => '0x' + '0'.repeat(24) + String(a).slice(2).toLowerCase()

/**
 * Addresses on the issuer's list that the factory has not been seen creating: noted with when they were first seen
 * waiting, and each looked for on its own once it has waited CONFIRM_MS (then again every LOOKUP_EVERY_MS). Only a
 * creation in a log that passes tokenOf is added. Never throws.
 * @returns {{ ok, error, waiting, looked: Array<{ address, result }>, found }}
 */
export async function lookupAwaiting ({ chain, dir, listAddresses, fetchImpl = globalThis.fetch, env = process.env, budgetMs = 40_000, maxPerRun = LOOKUP_MAX_PER_RUN, paceMs = null, clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const cfg = MIRRORS[chain]
  const m = cfg ? readMirror(dir, chain, clock()) : null
  if (!m || !caughtUp(m)) return { ok: false, error: 'no mirror caught up to look in', waiting: 0, looked: [], found: 0 }
  const rpc = rpcCaller(env[cfg.env] || cfg.rpc, fetchImpl)
  const now = clock(), start = now, target = m.last_ok.target_block
  // A revoked token on the list waits like any other: a valid creation log found for it restores it (addCreation).
  const known = new Set(m.tokens.map((t) => t.address))
  const onList = new Set(listAddresses.map((a) => String(a).toLowerCase()).filter((a) => ADDRESS.test(a)))
  const waiting = m.awaiting && typeof m.awaiting === 'object' ? m.awaiting : {}
  for (const a of Object.keys(waiting)) if (!onList.has(a) || known.has(a)) delete waiting[a]
  for (const a of onList) if (!known.has(a) && !waiting[a]) waiting[a] = { since: new Date(now).toISOString(), looked_at: null, result: null }
  m.awaiting = waiting
  const due = Object.entries(waiting).filter(([, w]) => now - Date.parse(w.since) >= CONFIRM_MS && (!w.looked_at || now - Date.parse(w.looked_at) >= LOOKUP_EVERY_MS)).map(([a]) => a).sort().slice(0, maxPerRun)
  const looked = []
  let found = 0, error = null
  const add = (t) => { if (t && !known.has(t.address)) { addCreation(m, t, clock()); known.add(t.address); found++; delete waiting[t.address] } }
  const pace = paceMs ?? cfg.paceMs ?? 0
  let calls = 0
  const call = async (method, params) => { if (calls++ && pace > 0) await sleep(pace); return rpc(method, params) }
  const over = () => clock() - start >= budgetMs
  try {
    if (due.length && cfg.lookup === 'rescan') {
      for (let from = cfg.from_block; from <= target && clock() - start < budgetMs; from += cfg.range) {
        const to = Math.min(target, from + cfg.range - 1)
        const logs = await call('eth_getLogs', [{ address: cfg.factory, topics: [cfg.topic0], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])
        if (!Array.isArray(logs)) throw new Error('rpc eth_getLogs: not a list')
        for (const l of logs) { const t = tokenOf(chain, l, { from, to }); if (t && due.includes(t.address)) add(t) }
        if (to === target) for (const a of due) looked.push({ address: a, result: known.has(a) ? 'found' : 'not_in_factory_logs' })
      }
    } else if (cfg.lookup === 'code_bisect') {
      for (const a of due) {
        if (over()) break
        const code = async (b) => String(await call('eth_getCode', [a, '0x' + b.toString(16)]) || '0x') !== '0x'
        let result
        if (!(await code(target))) result = 'no_code'
        else {
          // The budget is checked at every step and the calls are paced: one slow gateway must not run the unit past
          // its limit before Robinhood's turn (outside review, 25.11). A bisection cut short is not a result.
          let lo = cfg.from_block, hi = target
          while (lo < hi && !over()) { const mid = Math.floor((lo + hi) / 2); if (await code(mid)) hi = mid; else lo = mid + 1 }
          if (lo < hi) break
          const logs = await call('eth_getLogs', [{ address: cfg.factory, topics: [cfg.topic0, topicOf(a)], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + lo.toString(16) }])
          const t = (Array.isArray(logs) ? logs : []).map((l) => tokenOf(chain, l, { from: lo, to: lo })).find((x) => x && x.address === a)
          if (t) { add(t); result = 'found' } else result = 'created_elsewhere'
        }
        looked.push({ address: a, result })
      }
    }
  } catch (e) { error = String(e && e.message || e).slice(0, 200) }
  const at = new Date(clock()).toISOString()
  for (const l of looked) if (waiting[l.address]) Object.assign(waiting[l.address], { looked_at: at, result: l.result })
  const file = path.join(dir, 'mirror.json')
  try { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, file) } catch (e) { error = error || String(e && e.message || e).slice(0, 200) }
  return { ok: !error, error, waiting: Object.keys(waiting).length, looked, found }
}

/**
 * The slow reconcile: the whole range read again from the factory's start, a slice per run, adding any creation the
 * forward scan missed. Starts over RECONCILE_EVERY_MS after it last finished. Never throws.
 */
export async function reconcileMirror ({ chain, dir, fetchImpl = globalThis.fetch, env = process.env, maxCalls = RECONCILE_CALLS_PER_RUN, budgetMs = 40_000, clock = () => Date.now() }) {
  const cfg = MIRRORS[chain]
  const m = cfg ? readMirror(dir, chain, clock()) : null
  if (!m || !caughtUp(m)) return { ok: false, error: 'no mirror caught up to reconcile', calls: 0, added: 0, at: null }
  const rpc = rpcCaller(env[cfg.env] || cfg.rpc, fetchImpl)
  const start = clock(), target = m.last_ok.target_block
  const r = m.reconcile && typeof m.reconcile === 'object' ? m.reconcile : { at: null, finished_at: null }
  if (r.at == null) {
    if (r.finished_at && start - Date.parse(r.finished_at) < RECONCILE_EVERY_MS) return { ok: true, error: null, calls: 0, added: 0, at: null }
    r.at = cfg.from_block
  }
  const known = new Set(m.tokens.map((t) => t.address))
  let calls = 0, added = 0, error = null
  try {
    while (r.at <= target && calls < maxCalls && clock() - start < budgetMs) {
      const from = r.at, to = Math.min(target, from + cfg.range - 1)
      const logs = await rpc('eth_getLogs', [{ address: cfg.factory, topics: [cfg.topic0], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])
      calls++
      if (!Array.isArray(logs)) throw new Error('rpc eth_getLogs: not a list')
      for (const l of logs) { const t = tokenOf(chain, l, { from, to }); if (t && !known.has(t.address)) { addCreation(m, t, clock()); known.add(t.address); added++ } }
      r.at = to + 1
    }
    if (r.at > target) { r.at = null; r.finished_at = new Date(clock()).toISOString() }
  } catch (e) { error = String(e && e.message || e).slice(0, 200) }
  m.reconcile = r
  const file = path.join(dir, 'mirror.json')
  try { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, file) } catch (e) { error = error || String(e && e.message || e).slice(0, 200) }
  return { ok: !error, error, calls, added, at: r.at }
}

/** The second RPC for a chain: the host's own (env), else the built-in public one, else none. */
export const secondRpcOf = (chain, env = process.env) => { const cfg = MIRRORS[chain]; return (cfg && (env[cfg.secondEnv] || cfg.second)) || null }

/**
 * Ask the second RPC about every creation it has not confirmed yet, by its receipt; at most maxPerRun a run, within
 * budgetMs. Confirmed: `second_at`, when its receipt holds the creation, or its block does. Revoked only on proof from
 * the second RPC's block (provenAbsent): a missing receipt or transaction alone is never proof, since a node with a
 * pruned index answers null for older ones (outside review, 25.11). An RPC that fails confirms nothing and revokes
 * nothing. Records `sources`. Never throws.
 * @returns {{ ok, error, sources, confirmed, revoked: Array<{ address, why }>, pending }}
 */
export async function confirmSecond ({ chain, dir, fetchImpl = globalThis.fetch, env = process.env, budgetMs = 30_000, maxPerRun = REVALIDATE_MAX_PER_RUN, clock = () => Date.now() }) {
  const cfg = MIRRORS[chain]
  const m = cfg ? readMirror(dir, chain, clock()) : null
  if (!m) return { ok: false, error: 'no mirror to confirm', sources: null, confirmed: 0, revoked: [], pending: 0 }
  const url = secondRpcOf(chain, env)
  m.sources = url ? 2 : 1
  const revoked = []
  let confirmed = 0, error = null
  if (url) {
    const rpc = rpcCaller(url, fetchImpl)
    const start = clock()
    for (const t of m.tokens.filter((x) => !x.second_at).slice(0, maxPerRun)) {
      if (clock() - start >= budgetMs) break
      try {
        const receipt = await rpc('eth_getTransactionReceipt', [t.tx])
        if (receipt && receiptHolds(chain, t, receipt).ok) { t.second_at = new Date(clock()).toISOString(); confirmed++; continue }
        const proof = await provenAbsent(chain, t, rpc)
        if (!proof) continue
        if (!proof.absent) { t.second_at = new Date(clock()).toISOString(); confirmed++ } else t.revoke = 'the second RPC does not hold it: ' + proof.why
      } catch (e) { error = String(e && e.message || e).slice(0, 200); break }
    }
    const at = new Date(clock()).toISOString()
    for (const t of m.tokens.filter((x) => x.revoke)) { const { revoke, ...rest } = t; revoked.push({ address: t.address, why: revoke }); (m.revoked ||= []).push({ ...rest, revoked_at: at, why: revoke }) }
    m.tokens = m.tokens.filter((t) => !t.revoke)
  }
  const file = path.join(dir, 'mirror.json')
  try { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, file) } catch (e) { error = error || String(e && e.message || e).slice(0, 200) }
  return { ok: !error, error, sources: m.sources, confirmed, revoked, pending: url ? m.tokens.filter((t) => !t.second_at).length : 0 }
}

/** Record a creation read from a valid log; a revoked one is restored, saying when. */
export function addCreation (m, t, now) {
  const was = (m.revoked || []).findIndex((r) => r.address === t.address)
  if (was >= 0) { m.revoked.splice(was, 1); m.tokens.push({ ...t, restored_at: new Date(now).toISOString() }) } else m.tokens.push(t)
}

/**
 * Is the recorded creation provably gone from the chain? Only the block can say. { absent: true, why } when the
 * recorded block is no longer the chain's block at that height, or it still is and the factory's log creating this
 * token is not in it; { absent: false } when the block still holds it; null when it could not be checked. Throws on an
 * RPC error (the caller ends its run).
 */
export async function provenAbsent (chain, t, rpc) {
  const block = await rpc('eth_getBlockByNumber', ['0x' + t.block.toString(16), false])
  if (!block || !HASH32.test(String(block.hash || '').toLowerCase())) return null
  if (String(block.hash).toLowerCase() !== t.block_hash) return { absent: true, why: 'the recorded block is no longer the chain\'s block at that height' }
  const cfg = MIRRORS[chain]
  const logs = await rpc('eth_getLogs', [{ blockHash: t.block_hash, address: cfg.factory, topics: [cfg.topic0] }])
  if (!Array.isArray(logs)) return null
  const hit = logs.map((l) => tokenOf(chain, l, { from: t.block, to: t.block })).find((x) => x && x.address === t.address && x.tx === t.tx)
  return hit ? { absent: false } : { absent: true, why: 'the recorded block holds no factory log creating this token' }
}

export const REVALIDATE_EVERY_MS = 24 * 3600e3
export const REVALIDATE_MAX_PER_RUN = 150

/**
 * Does this receipt still hold this recorded creation? { ok: true } or { ok: false, why }. Pure. A null receipt is
 * "gone" only together with a null transaction; the caller decides that (revalidateMirror).
 */
export function receiptHolds (chain, token, receipt) {
  const cfg = MIRRORS[chain]
  if (!cfg || !receipt || typeof receipt !== 'object') return { ok: false, why: 'no receipt' }
  if (String(receipt.blockHash || '').toLowerCase() !== token.block_hash) return { ok: false, why: 'the transaction is in another block now' }
  if (receipt.status !== '0x1') return { ok: false, why: 'the transaction failed' }
  const hit = (Array.isArray(receipt.logs) ? receipt.logs : []).find((l) => hexInt(l && l.logIndex) === token.log_index)
  if (!hit) return { ok: false, why: 'the creation log is not in the receipt' }
  const t = tokenOf(chain, { blockHash: receipt.blockHash, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, ...hit })
  if (!t || t.address !== token.address || t.block !== token.block) return { ok: false, why: 'the receipt\'s log does not create this token' }
  return { ok: true }
}

/**
 * Check recorded creations against the chain again: those never checked first, then those checked longest ago, each
 * at most once a day, at most maxPerRun a run and within budgetMs. A creation the chain no longer holds is revoked.
 * An RPC that fails ends the run without revoking anything. Never throws.
 * @returns {{ ok, error, checked, revoked: Array<{ address, why }>, due }}
 */
export async function revalidateMirror ({ chain, dir, fetchImpl = globalThis.fetch, env = process.env, budgetMs = 40_000, maxPerRun = REVALIDATE_MAX_PER_RUN, every = REVALIDATE_EVERY_MS, clock = () => Date.now() }) {
  const cfg = MIRRORS[chain]
  const m = cfg ? readMirror(dir, chain, clock()) : null
  if (!m) return { ok: false, error: 'no mirror to check', checked: 0, revoked: [], due: 0 }
  const rpc = rpcCaller(env[cfg.env] || cfg.rpc, fetchImpl)
  const start = clock()
  const age = (t) => (t.checked_at ? clock() - Date.parse(t.checked_at) : Infinity)
  const due = m.tokens.filter((t) => age(t) >= every).sort((a, b) => age(b) - age(a))
  const revoked = []
  let checked = 0, error = null
  for (const t of due.slice(0, maxPerRun)) {
    if (clock() - start >= budgetMs) break
    try {
      const receipt = await rpc('eth_getTransactionReceipt', [t.tx])
      if (receipt && receiptHolds(chain, t, receipt).ok) { checked++; t.checked_at = new Date(clock()).toISOString(); continue }
      // The receipt is missing or does not hold it: the block decides. Anything short of proof is "could not check".
      const proof = await provenAbsent(chain, t, rpc)
      if (!proof) continue
      checked++
      if (!proof.absent) { t.checked_at = new Date(clock()).toISOString(); continue }
      t.revoke = proof.why
    } catch (e) { error = String(e && e.message || e).slice(0, 200); break }
  }
  const at = new Date(clock()).toISOString()
  for (const t of m.tokens.filter((x) => x.revoke)) { const { revoke, ...rest } = t; revoked.push({ address: t.address, why: revoke }); (m.revoked ||= []).push({ ...rest, revoked_at: at, why: revoke }) }
  m.tokens = m.tokens.filter((t) => !t.revoke)
  const file = path.join(dir, 'mirror.json')
  try { const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, file) } catch (e) { error = error || String(e && e.message || e).slice(0, 200) }
  return { ok: !error, error, checked, revoked, due: due.length }
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
  if (!caughtUp(m)) return null
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
  if (res.caught_up) {
    const rv = await revalidateMirror({ chain, dir, budgetMs: Number(arg('revalidate-s') || 40) * 1000 })
    res.revalidated = { checked: rv.checked, revoked: rv.revoked, due: rv.due, error: rv.error }
    if (rv.revoked.length) console.log('[issuer-mirror] REVOKED ' + JSON.stringify({ chain, revoked: rv.revoked }))
    const sc = await confirmSecond({ chain, dir, budgetMs: Number(arg('second-s') || 30) * 1000 })
    res.second = { sources: sc.sources, confirmed: sc.confirmed, revoked: sc.revoked, pending: sc.pending, error: sc.error }
    if (sc.revoked.length) console.log('[issuer-mirror] REVOKED ' + JSON.stringify({ chain, revoked: sc.revoked }))
  }
  let comparison = null
  if (res.caught_up) {
    try {
      const records = await (chain === 'base' ? readCoinbase : readRobinhood)(fetch, { chainId: chain === 'base' ? 8453 : 4663 })
      const listed = records.filter((r) => r.chain_id === (chain === 'base' ? 8453 : 4663)).map((r) => r.address)
      const lk = await lookupAwaiting({ chain, dir, listAddresses: listed, budgetMs: Number(arg('lookup-s') || 40) * 1000 })
      res.lookup = { waiting: lk.waiting, looked: lk.looked, found: lk.found, error: lk.error }
      const rc = await reconcileMirror({ chain, dir, budgetMs: Number(arg('reconcile-s') || 30) * 1000 })
      res.reconcile = { calls: rc.calls, added: rc.added, at: rc.at, error: rc.error }
      comparison = recordComparison(dir, chain, listed, new Date().toISOString())
    } catch (e) { res.error = res.error || 'issuer list: ' + String(e && e.message || e).slice(0, 120) }
  }
  console.log('[issuer-mirror] ' + JSON.stringify({ chain, ...res, comparison: comparison && { listed: comparison.listed, created: comparison.created, on_list_not_created: comparison.on_list_not_created.length, created_not_on_list: comparison.created_not_on_list.length } }))
  if (!res.ok) process.exitCode = 1
}
