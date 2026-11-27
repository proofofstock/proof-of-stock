// apps/b20-reader.mjs: the reads behind the B20 transfer rules (docs/b20-transfers-tz.md §1, §2, §5): for every
// issuer-listed token on Base, at one block pinned by its hash, the policy bound to each transfer scope, whether
// transfers are paused, whether each bound policy exists, and what it answers for the accounts we check. Run in the
// site's registry refresh cycle (apps/stocks-web.mjs); the state, the passport block and the change diff are
// evm/core/stocks/b20.mjs, which fetches nothing.
//
// ⚠ READ-ONLY. eth_getBlockByNumber and eth_call to Multicall3 only. Every outside call goes through the `fetchImpl`
//   handed in, so a test hands in a fake node and npm test makes no call out.
// ⚠ THE BLOCK'S OWN TIME, NOT OURS. A reading is as old as the block it was read at: a lagging node's head is stamped
//   with its header timestamp, so it is stale, never "read now". A head below the last one used is refused (a fallback
//   node behind the first cannot replay an older state as a change), and every pin asks requireCanonical (EIP-1898), so
//   a block reorganised away during the batches is an error, never a reading.
// ⚠ EVERY BYTE OF AN aggregate3 ANSWER IS CHECKED (decodeAggregate3Strict): its offsets, each tuple's bounds, the
//   success word exactly 0 or 1, the full declared length of each payload. A short or malformed answer is a failed
//   read, never a word read from padding.
// ⚠ policyExists FIRST. An id the registry does not hold answers isAuthorized as an empty set (a blocklist-shaped one
//   says true for everyone), so isAuthorized is asked only of ids that exist, in a later batch at the same block.
// ⚠ ONCE PER CYCLE PER ID. Tokens share policies: an id's existence and each (id, account) answer are read once a cycle.
// ⚠ THE SAME RPC PAIR AS THE FACTORY MIRROR (scripts/stocks/issuer-mirror.mjs MIRRORS.base): its log source first, its
//   second RPC when the first fails. The URLs are never written down: a host's own may carry a key.
// ⚠ ONE JOURNAL LINE PER CHANGE, AND A LOG FOR THE ALERT. Each token keeps a baseline: the last value that was read
//   successfully, per policy id, per pause and per (id, account) answer, each on its own. A sub-call that failed never
//   replaces its value, so a change seen across a failed read is still a change when the read succeeds. A difference
//   is one dated journal line and one entry in `changes()`, which the site serves on /api/status for
//   scripts/stocks/health-check.mjs: that job holds the alert configuration and sends each change once. This process
//   holds no bot token. The first cycle after a start has nothing to compare with.

import { MULTICALL3, encodeAggregate3, encodeAggregate3Result } from '../scripts/stocks/onchain-pools.mjs'
import { MIRRORS, secondRpcOf } from '../scripts/stocks/issuer-mirror.mjs'
import { KYBER_ROUTER } from '../packages/proofofstock-guard/examples/agent-buy.mjs'
import { SLIPSTREAM } from './simulate/quote-aerodrome.mjs'
import { POLICY_REGISTRY, SCOPE_KEYS, ALWAYS_ALLOW, STALE_S, calldata, idOf, boolOf, accountsOf, allowedIn, changesOf, changeText, pauseOf, snapshotOf } from '../evm/core/stocks/b20.mjs'

/** Calls per aggregate3: a few hundred cheap precompile reads in one eth_call. */
export const CHUNK = 200
export const RPC_TIMEOUT_MS = 8_000
/** How many changes the site keeps for health-check to collect (it runs every 15 minutes). */
export const CHANGES_KEPT = 200
/** How far ahead of our clock a header time may be (clock skew between hosts) before the head is refused. */
export const FUTURE_SKEW_MS = 120_000
/** The routers a swap on Base goes to: what the passport and simulate_buy name. */
export const VENUE_ROUTERS = Object.freeze({ kyberRouter: KYBER_ROUTER, aerodromeRouters: SLIPSTREAM.map((d) => d.router) })

const low = (s) => String(s || '').toLowerCase()

/** The factory mirror's RPC pair on Base: its log source (STP_LOGS_RPC_BASE or the built-in one), then its second RPC. */
export function rpcPairOf (env = process.env) {
  const cfg = MIRRORS.base
  const urls = [env[cfg.env] || cfg.rpc, secondRpcOf('base', env)].filter(Boolean)
  return [...new Set(urls)]
}

async function rpc (fetchImpl, url, method, params) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  if (!r || !r.ok) throw new Error(`rpc answered ${r ? r.status : 'nothing'}`)
  const j = await r.json()
  if (!j || j.error || j.result == null) throw new Error('rpc: ' + String(j?.error?.message || 'no result').slice(0, 120))
  return j.result
}

const QTY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/
/** The head, pinned: its number, hash and header time (ms), or a throw. */
export async function pinHead (fetchImpl, url) {
  const b = await rpc(fetchImpl, url, 'eth_getBlockByNumber', ['latest', false])
  const n = typeof b?.number === 'string' && QTY.test(b.number) ? Number(BigInt(b.number)) : NaN
  const t = typeof b?.timestamp === 'string' && QTY.test(b.timestamp) ? Number(BigInt(b.timestamp)) * 1000 : NaN
  if (!(n > 0) || !/^0x[0-9a-fA-F]{64}$/.test(String(b?.hash))) throw new Error('rpc: no block')
  if (!(t > 0)) throw new Error('rpc: no block time')
  return { number: n, hash: low(b.hash), time: t }
}

/** The EIP-1898 tag every B20 read uses: the block by hash, and only while it is on the canonical chain. */
export const pinOf = (hash) => ({ blockHash: hash, requireCanonical: true })

/**
 * aggregate3's answer, (bool success, bytes returnData)[], decoded with every bound checked: the array offset is 0x20,
 * the count is `expected`, each tuple offset and each bytes offset lies inside the answer, the success word is exactly
 * 0 or 1, and the whole declared payload is present. Anything else throws.
 */
export function decodeAggregate3Strict (hex, expected) {
  const h = typeof hex === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(hex) ? hex.slice(2) : null
  if (h == null) throw new Error('aggregate3: not hex')
  const size = h.length / 2
  const word = (b) => { if (b < 0 || b + 32 > size) throw new Error('aggregate3: out of bounds'); return BigInt('0x' + h.slice(b * 2, b * 2 + 64)) }
  const small = (b) => { const v = word(b); if (v > BigInt(size)) throw new Error('aggregate3: bad offset'); return Number(v) }
  if (word(0) !== 0x20n) throw new Error('aggregate3: bad head')
  const n = small(32)
  if (n !== expected) throw new Error('aggregate3: result count')
  const base = 64, out = []
  for (let k = 0; k < n; k++) {
    const tp = base + small(base + k * 32)
    const ok = word(tp)
    if (ok !== 0n && ok !== 1n) throw new Error('aggregate3: bad success word')
    if (word(tp + 32) !== 0x40n) throw new Error('aggregate3: bad bytes offset')
    const len = small(tp + 64)
    const start = tp + 96
    if (start + len > size) throw new Error('aggregate3: payload shorter than declared')
    out.push({ success: ok === 1n, data: '0x' + h.slice(start * 2, (start + len) * 2) })
  }
  // The last word on the layout: the answer must be exactly the canonical encoding of what was decoded. A tuple
  // offset that skips a tuple, points back at another, overlaps, is not aligned, or leaves bytes over cannot pass.
  if (encodeAggregate3Result(out).toLowerCase() !== hex.toLowerCase()) throw new Error('aggregate3: not the canonical encoding of its own results')
  return out
}

/** Every call at the block of `hash` (EIP-1898, canonical only), in chunks; results in order, each { success, data }. */
export async function multicallAt (fetchImpl, url, calls, hash) {
  const out = []
  for (let i = 0; i < calls.length; i += CHUNK) {
    const part = calls.slice(i, i + CHUNK)
    out.push(...decodeAggregate3Strict(await rpc(fetchImpl, url, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(part) }, pinOf(hash)]), part.length))
  }
  return out
}

/**
 * One reading of every token at one block. `tokens` is [{ address, accounts }]. Returns { head, readings:
 * Map(address -> reading) }, every reading of the same block, stamped with the block's own time; a throw is the
 * caller's, who tries the other RPC. `minBlock`: a head below it is refused.
 */
export async function readTokens ({ fetchImpl, url, tokens, minBlock = 0, now = () => Date.now(), head: pinned = null }) {
  const head = pinned || await pinHead(fetchImpl, url)
  if (head.number < minBlock) throw new Error('rpc: head below the last block read')
  // 1. The bound ids and the pause, per token.
  const r1 = await multicallAt(fetchImpl, url, tokens.flatMap((t) => [...SCOPE_KEYS.map((s) => ({ to: t.address, data: calldata.policyId(s) })), { to: t.address, data: calldata.isPaused() }]), head.hash)
  const per = tokens.map((t, k) => {
    const at = k * (SCOPE_KEYS.length + 1)
    return { t, policies: Object.fromEntries(SCOPE_KEYS.map((s, j) => [s, idOf(r1[at + j])])), paused: boolOf(r1[at + SCOPE_KEYS.length]) }
  })
  // 2. policyExists for each distinct id other than ALWAYS_ALLOW, once.
  const ids = [...new Set(per.flatMap((p) => Object.values(p.policies)).filter((id) => id != null && id !== ALWAYS_ALLOW))]
  const r2 = ids.length ? await multicallAt(fetchImpl, url, ids.map((id) => ({ to: POLICY_REGISTRY, data: calldata.policyExists(id) })), head.hash) : []
  const exists = Object.fromEntries(ids.map((id, k) => [id, boolOf(r2[k])]))
  // 3. isAuthorized for each (existing id, account) pair a token asks, once.
  const pairs = new Map()
  for (const p of per) for (const a of p.t.accounts) for (const s of a.scopes) {
    const id = p.policies[s]
    if (id != null && id !== ALWAYS_ALLOW && exists[id] === true) pairs.set(id + '|' + low(a.address), [id, low(a.address)])
  }
  const list = [...pairs.values()]
  const r3 = list.length ? await multicallAt(fetchImpl, url, list.map(([id, a]) => ({ to: POLICY_REGISTRY, data: calldata.isAuthorized(id, a) })), head.hash) : []
  const auth = Object.fromEntries(list.map(([id, a], k) => [id + '|' + a, boolOf(r3[k])]))
  const readings = new Map()
  for (const p of per) {
    // Each token keeps only its own answers: its bound ids, for its own accounts (a shared id's answers for every other
    // token's pools would be copied into each reading otherwise).
    const used = new Set(Object.values(p.policies).filter(Boolean))
    const mine = {}
    for (const a of p.t.accounts) for (const s of a.scopes) { const k = p.policies[s] + '|' + low(a.address); if (k in auth) mine[k] = auth[k] }
    readings.set(p.t.address, {
      token: p.t.address, block: head.number, block_hash: head.hash, read_at: head.time, error: null, paused: p.paused, policies: p.policies,
      exists: Object.fromEntries(Object.entries(exists).filter(([id]) => used.has(id))),
      auth: mine,
      accounts: p.t.accounts,
    })
  }
  return { head, readings }
}

/**
 * The baseline after a reading: each value the reading decoded replaces the old one, and each it could not read keeps
 * the last one read successfully. A policy id that moved takes its answers with it: answers of the old id are not
 * carried to the new one.
 */
export function mergeBaseline (prev, reading) {
  if (!prev) return reading
  const pick = (a, b) => (b === true || b === false ? b : a)
  const policies = Object.fromEntries(SCOPE_KEYS.map((s) => [s, reading.policies?.[s] ?? prev.policies?.[s] ?? null]))
  const paused = pick(prev.paused, reading.paused)
  const used = new Set(Object.values(policies).filter(Boolean))
  const exists = {}
  for (const id of used) exists[id] = pick(prev.exists?.[id] ?? null, reading.exists?.[id] ?? null)
  const auth = {}
  for (const a of reading.accounts || []) for (const s of a.scopes) {
    const k = policies[s] + '|' + low(a.address)
    if (!used.has(policies[s])) continue
    auth[k] = pick(prev.auth?.[k] ?? null, reading.auth?.[k] ?? null)
  }
  return { ...reading, policies, paused, exists, auth }
}

/**
 * The reader the site holds: refresh() once a cycle, get(), lastGood() and changes() from memory.
 * @param {object} o
 * @param {function} o.fetchImpl
 * @param {object} [o.env]       STP_LOGS_RPC_BASE / STP_VERIFY_RPC_BASE (the mirror's pair)
 */
export function createB20Reader ({ fetchImpl, env = process.env, now = () => Date.now(), log = () => {} } = {}) {
  const readings = new Map() // token -> the latest reading (error or not)
  const good = new Map() // token -> the baseline: the last value read successfully, per value
  const pauseAgree = new Map() // token -> the last `agree` journaled
  const changeLog = [] // the last CHANGES_KEPT changes, oldest first
  let inFlight = null, lastBlock = 0
  const counters = { cycles: 0, failed: 0, changes: 0 }

  /**
   * One cycle. `records` are the trusted Base records ({ address, symbol, paused }); `poolsOf(address)` the token's
   * pools, deepest first.
   */
  function refresh (records, { poolsOf = () => [] } = {}) {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try { await cycle(records || [], poolsOf) } finally { inFlight = null }
    })()
    return inFlight
  }
  async function cycle (records, poolsOf) {
    counters.cycles++
    const tokens = records.map((r) => ({ address: low(r.address), accounts: accountsOf({ ...VENUE_ROUTERS, pools: poolsOf(low(r.address)) || [] }) }))
    if (!tokens.length) return
    // The freshest valid head across the pair: each node's head is pinned, one ahead of the clock is dropped, the newest
    // by its own time is read first (a primary that lags loses to a current fallback), and one below the last block used
    // is refused by readTokens, so the next is tried.
    let got = null, lastErr = null
    const heads = []
    for (const url of rpcPairOf(env)) {
      // A header time well ahead of our clock is no time to stamp a reading with: it would stay "fresh" past its age.
      try { const head = await pinHead(fetchImpl, url); if (head.time <= now() + FUTURE_SKEW_MS) heads.push({ url, head }); else lastErr = new Error('rpc: block time ahead of the clock') } catch (e) { lastErr = e }
    }
    heads.sort((a, b) => b.head.time - a.head.time || b.head.number - a.head.number)
    for (const { url, head } of heads) {
      try { got = await readTokens({ fetchImpl, url, tokens, minBlock: lastBlock, now, head }); break } catch (e) { lastErr = e }
    }
    if (!got) {
      counters.failed++
      log(`[b20] read failed: ${String(lastErr && lastErr.message || lastErr).slice(0, 160)}`)
      const at = now()
      for (const t of tokens) readings.set(t.address, { token: t.address, block: null, block_hash: null, read_at: at, error: 'read_failed', paused: null, policies: null, exists: {}, auth: {}, accounts: t.accounts })
      return
    }
    lastBlock = got.head.number
    // An old head is said as it is (stale) and never moves the baseline: a change is judged between current readings.
    const current = now() - got.head.time <= STALE_S * 1000
    const byAddress = new Map(records.map((r) => [low(r.address), r]))
    for (const [addr, reading] of got.readings) {
      readings.set(addr, reading)
      if (!current) continue
      const rec = byAddress.get(addr)
      const prev = good.get(addr)
      const next = mergeBaseline(prev, reading)
      const changes = changesOf(prev, next)
      good.set(addr, next)
      if (changes.length) {
        const at = new Date(now()).toISOString()
        counters.changes++
        // One dated line in the journal per change, so it is in the record; the alert is health-check's.
        log(`[b20] ${at} ${changeText({ symbol: rec?.symbol, token: addr, block: reading.block }, changes)}`)
        for (const c of changes) {
          changeLog.push({ token: addr, symbol: rec?.symbol ?? null, block: reading.block, at, kind: c.kind, scope: c.scope, account: c.account ?? null, address: c.address ?? null, from: c.from, to: c.to })
          if (changeLog.length > CHANGES_KEPT) changeLog.shift()
        }
      }
      // The issuer's list and the chain on the pause: said in the journal once per change of agreement.
      const p = pauseOf(reading, rec ? rec.paused : null, Number.isFinite(reading.read_at) && now() - reading.read_at <= STALE_S * 1000)
      if (p.agree !== pauseAgree.get(addr)) {
        if (p.agree === false) log(`[b20] ${new Date(now()).toISOString()} ${rec?.symbol || addr} (${addr}): the chain says transfers ${p.chain ? 'paused' : 'not paused'}, the issuer's list says ${p.issuer_list ? 'paused (' + p.issuer_list_features.join(',') + ')' : 'not paused'}; a swap meets the chain's`)
        pauseAgree.set(addr, p.agree)
      }
    }
  }
  return {
    refresh,
    get: (address) => readings.get(low(address)) || null,
    lastGood: (address) => good.get(low(address)) || null,
    /**
     * The changes seen since this process started, the last CHANGES_KEPT, in memory: { token, symbol, block, at, kind,
     * scope, account, address, from, to }, the probe wallet by its name only. Served on /api/status for health-check,
     * which alerts on each one it has not told; after a restart it falls back to the baselines.
     */
    changes: () => changeLog.slice(),
    /**
     * Every token's baseline as health-check reads it from /api/status (snapshotOf): the bound ids, the pause and each
     * answer, by account name and scope; the probe wallet by its name only. health-check keeps its own copy and sends
     * what differs, so nothing is lost when this process restarts.
     */
    snapshots: (symbols = new Map()) => Object.fromEntries([...good].map(([a, r]) => [a, { symbol: symbols.get(a) ?? null, ...snapshotOf(r) }])),
    counters,
  }
}

/**
 * simulate_buy's one extra read (§4): what the token's receiver and sender policies say of the caller's wallet, at the
 * chain's head pinned by its hash (canonical only), like the dry run. The head must be current by its own header time
 * and not below the reading's block. The bound ids are read again in the same batch: if any differs from `reading`
 * (the policy changed since the last cycle), nothing is said. Returns { head_block, receive, send } with true, false or
 * null each, or null when the reading is not one to build on or the node does not answer.
 */
export async function walletPolicy ({ fetchImpl, url, token, wallet, reading, now = Date.now }) {
  if (!reading || reading.error || !reading.policies || SCOPE_KEYS.some((s) => reading.policies[s] == null)) return null
  let head
  try { head = await pinHead(fetchImpl, url) } catch (_) { return null }
  if (Number.isInteger(reading.block) && head.number < reading.block) return null
  if (now() - head.time > STALE_S * 1000) return null
  if (head.time > now() + FUTURE_SKEW_MS) return null
  const ids = { receiver: reading.policies.receiver, sender: reading.policies.sender }
  const calls = [{ to: token, data: calldata.policyId('receiver') }, { to: token, data: calldata.policyId('sender') }]
  const asks = Object.entries(ids).filter(([, id]) => id !== ALWAYS_ALLOW)
  for (const [, id] of asks) calls.push({ to: POLICY_REGISTRY, data: calldata.policyExists(id) }, { to: POLICY_REGISTRY, data: calldata.isAuthorized(id, wallet) })
  let r
  try { r = await multicallAt(fetchImpl, url, calls, head.hash) } catch (_) { return null }
  if (idOf(r[0]) !== ids.receiver || idOf(r[1]) !== ids.sender) return { head_block: head.number, receive: null, send: null }
  const fresh = { policies: { ...reading.policies, ...ids }, exists: {}, auth: {} }
  asks.forEach(([, id], k) => { fresh.exists[id] = boolOf(r[2 + 2 * k]); fresh.auth[id + '|' + low(wallet)] = boolOf(r[3 + 2 * k]) })
  const v = (scope) => { const x = allowedIn(fresh, scope, wallet); return x === true || x === false ? x : null }
  return { head_block: head.number, receive: v('receiver'), send: v('sender') }
}
