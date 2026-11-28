// apps/b20-reader.mjs: the reads behind the B20 transfer rules (docs/b20-transfers-tz.md §1, §2, §5): for every
// issuer-listed token on Base, the policy bound to each transfer scope, whether transfers are paused, whether each bound
// policy exists, and what it answers for the accounts we check. Run in the site's registry refresh cycle
// (apps/stocks-web.mjs); the state, the passport block and the snapshots are evm/core/stocks/b20.mjs, which fetches
// nothing.
//
// ⚠ READ-ONLY. eth_getBlockByNumber and eth_call to Multicall3 only. Every outside call goes through the `fetchImpl`
//   handed in, so a test hands in a fake node and npm test makes no call out.
// ⚠ ONE NODE MUST NOT DECIDE. Both RPCs of the pair are read, at one common block: each one's `safe` head is pinned, the
//   lower of the two is taken, that block is fetched by number on both and its hash must be the same; then every read
//   is made on both at that hash (EIP-1898, requireCanonical) and compared token by token. A token the two disagree on
//   is `unknown`, rpc_disagree; a cycle where one of them gave no answer is single_source. Neither is ever `open`, and
//   neither moves the baseline or makes a change.
// ⚠ A HEAD MUST BE PLAUSIBLE. A head's number must have moved, against its time, at a block rate Base can make
//   (MIN_BLOCK_S to MAX_BLOCK_S), from the last accepted head and from the other RPC's; one ahead of our clock is refused. The watermark
//   moves only after the two agreed. If every head stays below it for LOCKOUT_CYCLES cycles, it is reset, loudly.
// ⚠ THE BLOCK'S OWN TIME, NOT OURS. A reading is as old as the block it was read at, by its header, and also expires by a
//   monotonic clock from the moment it was accepted, so moving the wall clock back cannot make it current again.
// ⚠ EVERY BYTE OF AN aggregate3 ANSWER IS CHECKED (decodeAggregate3Strict): the answer must be exactly the canonical
//   encoding of what it decodes to. A failed chunk is tried again on the same RPC before the cycle gives up on it.
// ⚠ A DEADLINE AND BOUNDED PARALLELISM. A cycle has CYCLE_DEADLINE_MS; chunks run PARALLEL at a time. A cycle that
//   cannot finish is a failed cycle, never a list of readings already stale.
// ⚠ A FAILED CYCLE KEEPS WHAT IS STILL CURRENT. A token's last agreed reading stays until it is stale by its own block
//   time; the failure is counted and journaled with a fixed code, never with a provider's text.
// ⚠ policyExists FIRST, ONCE PER ID. An id the registry does not hold answers isAuthorized as an empty set, so
//   isAuthorized is asked only of ids that exist, in a later batch at the same block.
// ⚠ A DURABLE OUTBOX FOR THE ALERT. Each change seen between two agreed readings is one event with a sequence number and
//   an id (sequence, token, kind, scope, account, block hash, from and to), appended to an outbox file in `dir`
//   (deployment/systemd/stp-web.service StateDirectory=stp-b20), and the baseline is written there too, so a restart of
//   this process loses nothing. scripts/stocks/health-check.mjs reads the events with its own cursor and sends them;
//   this process holds no bot token. The baseline is per scope: a scope's answer is taken only from a reading where its
//   binding and the registry's answer were both read, so a failed binding read never mixes with a new answer.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { MULTICALL3, encodeAggregate3, encodeAggregate3Result } from '../scripts/stocks/onchain-pools.mjs'
import { MIRRORS, secondRpcOf } from '../scripts/stocks/issuer-mirror.mjs'
import { KYBER_ROUTER } from '../packages/proofofstock-guard/examples/agent-buy.mjs'
import { SLIPSTREAM } from './simulate/quote-aerodrome.mjs'
import { POLICY_REGISTRY, SCOPE_KEYS, ALWAYS_ALLOW, STALE_S, calldata, idOf, boolOf, accountsOf, allowedIn, changeText, pauseOf, snapshotOf, snapshotChanges, mergeSnapshot } from '../evm/core/stocks/b20.mjs'

/** Calls per aggregate3: a few hundred cheap precompile reads in one eth_call. */
export const CHUNK = 200
export const RPC_TIMEOUT_MS = 8_000
/** Chunks in flight at once, per RPC. */
export const PARALLEL = 4
/** A failed chunk is asked again this many times on the same RPC. */
export const CHUNK_RETRIES = 1
/** A whole cycle's deadline, well inside the 5-minute refresh. */
export const CYCLE_DEADLINE_MS = 120_000
/**
 * The block interval a head's number is held to: Base has made blocks every 2 s and now makes them far faster, so a
 * head is plausible when its number moved, against its time, at a rate inside this range, give or take
 * HEAD_SLACK_BLOCKS.
 */
export const MIN_BLOCK_S = 0.05
export const MAX_BLOCK_S = 2.5
export const HEAD_SLACK_BLOCKS = 300
/** Cycles with every head below the watermark before it is reset. */
export const LOCKOUT_CYCLES = 2
/** How far ahead of our clock a header time may be (clock skew between hosts) before the head is refused. */
export const FUTURE_SKEW_MS = 120_000
/** The changes /api/status shows; the outbox keeps the rest. */
export const DISPLAY_KEPT = 50
/** The events the outbox file keeps; older ones are dropped when it is rewritten. health-check says when it missed some. */
export const OUTBOX_KEPT = 5_000
/** The routers a swap on Base goes to: what the passport and simulate_buy name. */
export const VENUE_ROUTERS = Object.freeze({ kyberRouter: KYBER_ROUTER, aerodromeRouters: SLIPSTREAM.map((d) => d.router) })
/** The fixed codes a failure is journaled with: never a provider's own text, which could echo an address. */
export const ERROR_CODES = Object.freeze(['rpc_http', 'rpc_error', 'rpc_timeout', 'no_block', 'bad_answer', 'head_ahead', 'head_stale', 'head_behind', 'head_implausible', 'hash_mismatch', 'time_mismatch', 'deadline', 'single_source', 'rpc_disagree', 'no_tokens', 'outbox_write_failed'])

const low = (s) => String(s || '').toLowerCase()
const fail = (code) => Object.assign(new Error(code), { code })
const codeOf = (e) => (e && ERROR_CODES.includes(e.code) ? e.code : e && e.name === 'TimeoutError' ? 'rpc_timeout' : 'rpc_error')
const monoNow = () => performance.now()
/**
 * Whether two heads are of one chain by their numbers and times: the higher one's number moved past the lower one's at
 * a block rate Base can make, give or take HEAD_SLACK_BLOCKS.
 */
export function plausibleStep (a, b) {
  const [hi, lo] = a.number >= b.number ? [a, b] : [b, a]
  const dn = hi.number - lo.number, dt = (hi.time - lo.time) / 1000
  if (dt < -2) return false
  const t = Math.max(0, dt)
  return dn <= t / MIN_BLOCK_S + HEAD_SLACK_BLOCKS && dn >= t / MAX_BLOCK_S - HEAD_SLACK_BLOCKS
}

/** The factory mirror's RPC pair on Base: its log source (STP_LOGS_RPC_BASE or the built-in one), then its second RPC. */
export function rpcPairOf (env = process.env) {
  const cfg = MIRRORS.base
  const urls = [env[cfg.env] || cfg.rpc, secondRpcOf('base', env)].filter(Boolean)
  return [...new Set(urls)]
}

async function rpc (fetchImpl, url, method, params) {
  let r
  try { r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }) } catch (e) { throw fail(e && e.name === 'TimeoutError' ? 'rpc_timeout' : 'rpc_http') }
  if (!r || !r.ok) throw fail('rpc_http')
  let j
  try { j = await r.json() } catch (_) { throw fail('bad_answer') }
  if (!j || j.error || j.result == null) throw fail('rpc_error')
  return j.result
}

const QTY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/
/** A block by tag or number, pinned: its number, hash and header time (ms), or a throw. Numbers past 2^53 are refused. */
export async function pinTag (fetchImpl, url, tag = 'latest') {
  const b = await rpc(fetchImpl, url, 'eth_getBlockByNumber', [typeof tag === 'number' ? '0x' + tag.toString(16) : tag, false])
  const big = typeof b?.number === 'string' && QTY.test(b.number) ? BigInt(b.number) : -1n
  const t = typeof b?.timestamp === 'string' && QTY.test(b.timestamp) ? Number(BigInt(b.timestamp)) * 1000 : NaN
  if (!(big > 0n) || big > BigInt(Number.MAX_SAFE_INTEGER) || !/^0x[0-9a-fA-F]{64}$/.test(String(b?.hash))) throw fail('no_block')
  if (!(t > 0)) throw fail('no_block')
  return { number: Number(big), hash: low(b.hash), time: t }
}
/** The latest head, pinned (the dry run's and the wallet read's block). */
export const pinHead = (fetchImpl, url) => pinTag(fetchImpl, url, 'latest')

/** The EIP-1898 tag every B20 read uses: the block by hash, and only while it is on the canonical chain. */
export const pinOf = (hash) => ({ blockHash: hash, requireCanonical: true })

/**
 * aggregate3's answer, (bool success, bytes returnData)[], decoded with every bound checked, and then held to its
 * canonical encoding: the answer must be exactly the encoding of what it decodes to. Anything else throws.
 */
export function decodeAggregate3Strict (hex, expected) {
  const h = typeof hex === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(hex) ? hex.slice(2) : null
  if (h == null) throw fail('bad_answer')
  const size = h.length / 2
  const word = (b) => { if (b < 0 || b + 32 > size) throw fail('bad_answer'); return BigInt('0x' + h.slice(b * 2, b * 2 + 64)) }
  const small = (b) => { const v = word(b); if (v > BigInt(size)) throw fail('bad_answer'); return Number(v) }
  if (word(0) !== 0x20n) throw fail('bad_answer')
  const n = small(32)
  if (n !== expected) throw fail('bad_answer')
  const base = 64, out = []
  for (let k = 0; k < n; k++) {
    const tp = base + small(base + k * 32)
    const ok = word(tp)
    if (ok !== 0n && ok !== 1n) throw fail('bad_answer')
    if (word(tp + 32) !== 0x40n) throw fail('bad_answer')
    const len = small(tp + 64)
    const start = tp + 96
    if (start + len > size) throw fail('bad_answer')
    out.push({ success: ok === 1n, data: '0x' + h.slice(start * 2, (start + len) * 2) })
  }
  // The last word on the layout: a tuple offset that skips a tuple, points back at another, overlaps, is not aligned,
  // or leaves bytes over cannot pass.
  if (encodeAggregate3Result(out).toLowerCase() !== hex.toLowerCase()) throw fail('bad_answer')
  return out
}

/** Run `tasks` (functions returning promises) PARALLEL at a time, in order of results. */
async function pooled (tasks, limit = PARALLEL) {
  const out = new Array(tasks.length)
  let next = 0
  const worker = async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i]() } }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return out
}

/**
 * Every call at the block of `hash` (EIP-1898, canonical only), in chunks run PARALLEL at a time, each tried again
 * CHUNK_RETRIES times on the same RPC; results in order, each { success, data }. Past `deadline` (a time from
 * `clock`), no chunk starts.
 */
export async function multicallAt (fetchImpl, url, calls, hash, { deadline = Infinity, clock = () => Date.now() } = {}) {
  const tasks = []
  for (let i = 0; i < calls.length; i += CHUNK) {
    const part = calls.slice(i, i + CHUNK)
    tasks.push(async () => {
      let last = null
      for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
        if (clock() > deadline) throw fail('deadline')
        try { return decodeAggregate3Strict(await rpc(fetchImpl, url, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(part) }, pinOf(hash)]), part.length) } catch (e) { last = e }
      }
      throw last
    })
  }
  return (await pooled(tasks)).flat()
}

/**
 * One reading of every token at one block `head` (already pinned and agreed). `tokens` is [{ address, accounts }].
 * Returns Map(address -> reading), stamped with the block's own time; a throw is the caller's.
 */
export async function readTokens ({ fetchImpl, url, tokens, head, deadline = Infinity, clock = () => Date.now() }) {
  const at = { deadline, clock }
  // 1. The bound ids and the pause, per token.
  const r1 = await multicallAt(fetchImpl, url, tokens.flatMap((t) => [...SCOPE_KEYS.map((s) => ({ to: t.address, data: calldata.policyId(s) })), { to: t.address, data: calldata.isPaused() }]), head.hash, at)
  const per = tokens.map((t, k) => {
    const i = k * (SCOPE_KEYS.length + 1)
    return { t, policies: Object.fromEntries(SCOPE_KEYS.map((s, j) => [s, idOf(r1[i + j])])), paused: boolOf(r1[i + SCOPE_KEYS.length]) }
  })
  // 2. policyExists for each distinct id other than ALWAYS_ALLOW, once.
  const ids = [...new Set(per.flatMap((p) => Object.values(p.policies)).filter((id) => id != null && id !== ALWAYS_ALLOW))]
  const r2 = ids.length ? await multicallAt(fetchImpl, url, ids.map((id) => ({ to: POLICY_REGISTRY, data: calldata.policyExists(id) })), head.hash, at) : []
  const exists = new Map(ids.map((id, k) => [id, boolOf(r2[k])]))
  // 3. isAuthorized for each (existing id, account) pair a token asks, once.
  const pairs = new Map()
  for (const p of per) for (const a of p.t.accounts) for (const s of a.scopes) {
    const id = p.policies[s]
    if (id != null && id !== ALWAYS_ALLOW && exists.get(id) === true) pairs.set(id + '|' + low(a.address), [id, low(a.address)])
  }
  const list = [...pairs.values()]
  const r3 = list.length ? await multicallAt(fetchImpl, url, list.map(([id, a]) => ({ to: POLICY_REGISTRY, data: calldata.isAuthorized(id, a) })), head.hash, at) : []
  const auth = new Map(list.map(([id, a], k) => [id + '|' + a, boolOf(r3[k])]))
  const readings = new Map()
  for (const p of per) {
    // Each token keeps only its own answers, looked up directly: its bound ids, for its own accounts.
    const mineExists = {}, mineAuth = {}
    for (const id of Object.values(p.policies)) if (id != null && exists.has(id)) mineExists[id] = exists.get(id)
    for (const a of p.t.accounts) for (const s of a.scopes) { const k = p.policies[s] + '|' + low(a.address); if (auth.has(k)) mineAuth[k] = auth.get(k) }
    readings.set(p.t.address, { token: p.t.address, block: head.number, block_hash: head.hash, read_at: head.time, error: null, source_state: null, paused: p.paused, policies: p.policies, exists: mineExists, auth: mineAuth, accounts: p.t.accounts })
  }
  return readings
}

/** The part of a reading the two RPCs must agree on. */
const agreeKey = (r) => JSON.stringify([SCOPE_KEYS.map((s) => r.policies[s]), r.paused, Object.entries(r.exists).sort(), Object.entries(r.auth).sort()])

/** One event's id: its sequence, and a hash of what it says (token, kind, scope, account, block hash, from and to). */
export const eventId = (seq, e) => `b20-${seq}-` + crypto.createHash('sha256').update(JSON.stringify([e.token, e.kind, e.scope ?? null, e.account ?? null, e.address ?? null, e.block_hash ?? null, e.from, e.to])).digest('hex').slice(0, 12)

/**
 * The durable outbox: one file, `<dir>/b20-state.json`, holding the sequence high-water mark, the events (each with its
 * `seq` and `id`) and the baseline, written together and atomically (a temporary file renamed over it). A commit either
 * lands whole or not at all, so a crash cannot leave a baseline ahead of its events, or events behind a baseline that
 * would make them again with new ids. The high-water mark never goes down, even when old rows are dropped. Without a
 * dir it is held in memory only (a test, a host without the state directory).
 */
export function createOutbox ({ dir = null, log = () => {}, write = null } = {}) {
  const file = dir ? path.join(dir, 'b20-state.json') : null
  // The outbox's epoch: made once, kept in the file. A new file (lost, or never written) is a new epoch, so a reader of
  // the sequence can tell a reset from a sequence that caught up with its cursor.
  let hw = 0, events = [], baseline = {}, epoch = crypto.randomBytes(8).toString('hex')
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j && Array.isArray(j.events)) events = j.events.filter((e) => e && Number.isInteger(e.seq) && typeof e.id === 'string')
      if (j && j.baseline && typeof j.baseline === 'object') baseline = j.baseline
      hw = Math.max(Number.isInteger(j && j.hw) ? j.hw : 0, events.length ? events[events.length - 1].seq : 0)
      if (j && typeof j.epoch === 'string' && /^[0-9a-f]{16}$/.test(j.epoch)) epoch = j.epoch
    } catch (e) { if (e.code !== 'ENOENT') log('[b20] outbox_unreadable') }
  }
  const put = write || ((body) => {
    if (!file) return true
    try { fs.mkdirSync(dir, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 }); fs.renameSync(tmp, file); return true } catch (_) { return false }
  })
  return {
    /**
     * Commit new events (without seq and id) and the baseline they lead to, as one write. Returns { ok, events } with
     * the events numbered; on a failed write nothing changes in memory either, and the caller keeps its old baseline.
     */
    commit (list, nextBaseline) {
      let seq = hw
      const out = list.map((e) => { seq++; return { seq, id: eventId(seq, e), ...e } })
      const kept = [...events, ...out].slice(-OUTBOX_KEPT)
      if (!put({ epoch, hw: seq, events: kept, baseline: nextBaseline })) { log('[b20] outbox_write_failed'); return { ok: false, events: [] } }
      hw = seq; events = kept; baseline = nextBaseline
      return { ok: true, events: out }
    },
    /** Events after `after` (a sequence number), at most `limit`; with the oldest held and the high-water mark. */
    since (after = 0, limit = 200) {
      const xs = []
      for (const e of events) { if (e.seq > after) { xs.push(e); if (xs.length >= limit) break } }
      return { events: xs, oldest: events.length ? events[0].seq : null, last: hw, epoch }
    },
    recent: (n = DISPLAY_KEPT) => events.slice(-n),
    baseline: () => baseline,
    durable: Boolean(file),
  }
}

/**
 * The reader the site holds: refresh() once a cycle; get(), lastGood(), snapshots(), changes(), events() from memory.
 * @param {object} o
 * @param {function} o.fetchImpl
 * @param {object} [o.env]       STP_LOGS_RPC_BASE / STP_VERIFY_RPC_BASE (the mirror's pair)
 * @param {string} [o.dir]       the outbox and baseline directory (STP_B20_DIR on the host)
 */
export function createB20Reader ({ fetchImpl, env = process.env, now = () => Date.now(), mono = monoNow, log = () => {}, dir = null, write = null } = {}) {
  const readings = new Map() // token -> the reading published (agreed, or unknown with its reason)
  const outbox = createOutbox({ dir, log, write })
  let good = new Map(Object.entries(outbox.baseline())) // token -> the baseline snapshot, per scope
  const pauseAgree = new Map()
  let inFlight = null, last = null, lowCycles = 0, implausibleCycles = 0
  const counters = { cycles: 0, failed: 0, changes: 0, last_ok_at: null, last_error: null }

  function refresh (records, { poolsOf = () => [] } = {}) {
    if (inFlight) return inFlight
    inFlight = (async () => { try { await cycle(records || [], poolsOf) } finally { inFlight = null } })()
    return inFlight
  }

  /** Is this head plausible: not ahead of the clock, current by its time, not below the watermark, near its expected number. */
  function headProblem (h) {
    const t = now()
    if (h.time > t + FUTURE_SKEW_MS) return 'head_ahead'
    if (t - h.time > STALE_S * 1000) return 'head_stale'
    if (last) {
      if (h.number < last.number) return 'head_behind'
      if (!plausibleStep(h, last)) return 'head_implausible'
    }
    return null
  }

  /** A failed cycle: what is still current stays; everything else is unknown with `state`. */
  function failCycle (tokens, code, state = null) {
    counters.failed++
    counters.last_error = code
    log(`[b20] read failed: ${code}`)
    const t = now()
    for (const tk of tokens) {
      const r = readings.get(tk.address)
      const current = r && !r.error && !r.source_state && Number.isFinite(r.read_at) && t - r.read_at <= STALE_S * 1000 && (!Number.isFinite(r.expires_mono) || mono() <= r.expires_mono)
      if (current) continue
      readings.set(tk.address, { token: tk.address, block: null, block_hash: null, read_at: t, error: state ? null : 'read_failed', source_state: state, paused: null, policies: null, exists: {}, auth: {}, accounts: tk.accounts })
    }
  }

  async function cycle (records, poolsOf) {
    counters.cycles++
    const start = now()
    const deadline = start + CYCLE_DEADLINE_MS
    const tokens = records.map((r) => ({ address: low(r.address), accounts: accountsOf({ ...VENUE_ROUTERS, pools: poolsOf(low(r.address)) || [] }) }))
    // Reconcile: a token no longer trusted leaves the readings and the baseline (its past events stay in the outbox).
    const keep = new Set(tokens.map((t) => t.address))
    for (const a of [...readings.keys()]) if (!keep.has(a)) readings.delete(a)
    const gone = [...good.keys()].filter((a) => !keep.has(a))
    if (gone.length) {
      const next = new Map(good)
      for (const a of gone) next.delete(a)
      if (outbox.commit([], Object.fromEntries(next)).ok) good = next
    }
    if (!tokens.length) return
    const urls = rpcPairOf(env)
    if (urls.length < 2) return failCycle(tokens, 'single_source', 'single_source')
    // 1. Each RPC's safe head.
    const heads = await Promise.all(urls.map(async (url) => { try { const h = await pinTag(fetchImpl, url, 'safe'); return { url, h, problem: headProblem(h) } } catch (e) { return { url, h: null, problem: codeOf(e) } } }))
    // A lock-out: every head below the watermark, or every head implausible against it, for LOCKOUT_CYCLES cycles.
    const behind = heads.every((x) => x.problem === 'head_behind'), odd = heads.every((x) => x.problem === 'head_implausible')
    if (behind || odd) {
      const n = behind ? ++lowCycles : ++implausibleCycles
      if (n >= LOCKOUT_CYCLES) { log(`[b20] LOCKOUT: every head ${behind ? 'below' : 'implausible against'} the watermark for ${n} cycles; the watermark is reset`); last = null; lowCycles = 0; implausibleCycles = 0 }
      return failCycle(tokens, behind ? 'head_behind' : 'head_implausible')
    }
    lowCycles = 0; implausibleCycles = 0
    const okHeads = heads.filter((x) => x.h && !x.problem)
    // No usable head at all is a failed read; one usable head is one node, which must not decide.
    if (!okHeads.length) return failCycle(tokens, heads.find((x) => x.problem)?.problem || 'rpc_error')
    if (okHeads.length < 2) return failCycle(tokens, heads.find((x) => x.problem)?.problem || 'single_source', 'single_source')
    // 2. The two heads near each other, by number against time; then one common block, the same hash on both.
    const [a, b] = okHeads
    if (!plausibleStep(a.h, b.h)) return failCycle(tokens, 'head_implausible', 'rpc_disagree')
    const n = Math.min(a.h.number, b.h.number)
    let common
    try {
      const [ca, cb] = await Promise.all(okHeads.map((x) => (x.h.number === n ? x.h : pinTag(fetchImpl, x.url, n))))
      // One block has one header: the same hash must come with the same time from both, and that time is held to the
      // bounds again. Neither RPC alone sets the time a reading is stamped with.
      if (ca.hash !== cb.hash || ca.number !== n || cb.number !== n) return failCycle(tokens, 'hash_mismatch', 'rpc_disagree')
      if (ca.time !== cb.time) return failCycle(tokens, 'time_mismatch', 'rpc_disagree')
      const bad = headProblem(ca)
      if (bad) return failCycle(tokens, bad, 'rpc_disagree')
      common = ca
    } catch (e) { return failCycle(tokens, codeOf(e), 'single_source') }
    // 3. Every read on both, at that hash; compared token by token.
    let ra, rb
    try {
      ;[ra, rb] = await Promise.all(okHeads.map((x) => readTokens({ fetchImpl, url: x.url, tokens, head: common, deadline, clock: now })))
    } catch (e) { return failCycle(tokens, codeOf(e), 'single_source') }
    if (now() > deadline) return failCycle(tokens, 'deadline')
    // A block that went stale while the cycle ran is no reading to compare or publish.
    if (now() - common.time > STALE_S * 1000) return failCycle(tokens, 'head_stale')
    const expires = mono() + Math.max(0, STALE_S * 1000 - (now() - common.time))
    const byAddress = new Map(records.map((r) => [low(r.address), r]))
    const events = [], lines = []
    const at = new Date(now()).toISOString()
    const next = new Map(good)
    let agreed = 0, decoded = 0
    for (const tk of tokens) {
      const x = ra.get(tk.address), y = rb.get(tk.address)
      if (!x || !y || agreeKey(x) !== agreeKey(y)) {
        readings.set(tk.address, { ...x, source_state: 'rpc_disagree', paused: null, policies: null, exists: {}, auth: {} })
        continue
      }
      agreed++
      if (x.paused !== null && SCOPE_KEYS.every((s) => x.policies[s] != null)) decoded++
      const reading = { ...x, sources: 2, expires_mono: expires }
      readings.set(tk.address, reading)
      const rec = byAddress.get(tk.address)
      const prev = good.get(tk.address) || null
      const snap = snapshotOf(reading)
      const changes = prev ? snapshotChanges(prev, snap) : []
      next.set(tk.address, { symbol: rec?.symbol ?? null, ...mergeSnapshot(prev, snap) })
      if (changes.length) {
        // One dated journal line per token whose rules changed, once the outbox holds it; the alert is health-check's.
        lines.push({ changes, text: `[b20] ${at} ${changeText({ symbol: rec?.symbol, token: tk.address, block: reading.block }, changes)}` })
        for (const c of changes) events.push({ token: tk.address, symbol: rec?.symbol ?? null, block: reading.block, block_hash: reading.block_hash, at, kind: c.kind, scope: c.scope ?? null, account: c.account ?? null, address: c.address ?? null, from: c.from, to: c.to })
      }
      const p = pauseOf(reading, rec ? rec.paused : null, true)
      if (p.agree !== pauseAgree.get(tk.address)) {
        if (p.agree === false) log(`[b20] ${at} ${rec?.symbol || tk.address} (${tk.address}): the chain says transfers ${p.chain ? 'paused' : 'not paused'}, the issuer's list says ${p.issuer_list ? 'paused' : 'not paused'}; a swap meets the chain's`)
        pauseAgree.set(tk.address, p.agree)
      }
    }
    // Every token disagreed: no comparison succeeded, and the cycle is a failed one for the blind-reader alert.
    if (!agreed) { counters.failed++; counters.last_error = 'rpc_disagree'; log('[b20] read failed: rpc_disagree'); return }
    // Two answers that agree only in not decoding are no reading either: the cycle failed (bad_answer).
    if (!decoded) { counters.failed++; counters.last_error = 'bad_answer'; log('[b20] read failed: bad_answer'); return }
    // The events and the baseline they lead to, in one write. A write that fails changes nothing: the same changes are
    // seen again next cycle and committed then, with nothing told twice.
    const c = outbox.commit(events, Object.fromEntries(next))
    if (!c.ok) { counters.failed++; counters.last_error = 'outbox_write_failed'; return }
    good = next
    for (const l of lines) { counters.changes += l.changes.length; log(l.text) }
    last = { number: common.number, time: common.time }
    counters.last_ok_at = new Date(now()).toISOString()
    counters.last_error = null
  }

  return {
    refresh,
    get: (address) => readings.get(low(address)) || null,
    lastGood: (address) => good.get(low(address)) || null,
    /** Every token's baseline, per scope (snapshotOf): the probe wallet by its name only. */
    snapshots: () => Object.fromEntries(good),
    /** The last DISPLAY_KEPT events, for /api/status. */
    changes: () => outbox.recent(),
    /** The events after a sequence number, for health-check's cursor: { events, oldest, last }. */
    events: (after, limit) => outbox.since(after, limit),
    durable: outbox.durable,
    counters,
  }
}

/**
 * The roles of some accounts under the token's own policies at one block hash, on one RPC: the current bindings first,
 * then existence and isAuthorized for those ids, at the same hash. `accounts` is [{ address, scopes }]. Returns
 * { address: { scope: true | false | null } }, or throws.
 */
async function rolesAtHash (fetchImpl, url, token, accounts, hash) {
  const scopes = [...new Set(accounts.flatMap((a) => a.scopes))]
  const r1 = await multicallAt(fetchImpl, url, scopes.map((s) => ({ to: token, data: calldata.policyId(s) })), hash)
  const policies = Object.fromEntries(scopes.map((s, k) => [s, idOf(r1[k])]))
  const ids = [...new Set(Object.values(policies).filter((id) => id != null && id !== ALWAYS_ALLOW))]
  const asks = []
  for (const id of ids) asks.push({ k: 'e', id, call: { to: POLICY_REGISTRY, data: calldata.policyExists(id) } })
  for (const a of accounts) for (const s of a.scopes) { const id = policies[s]; if (id != null && id !== ALWAYS_ALLOW) asks.push({ k: 'a', id, addr: low(a.address), call: { to: POLICY_REGISTRY, data: calldata.isAuthorized(id, a.address) } }) }
  const seen = new Set()
  const uniq = asks.filter((x) => { const key = x.k + x.id + (x.addr || ''); if (seen.has(key)) return false; seen.add(key); return true })
  const r2 = uniq.length ? await multicallAt(fetchImpl, url, uniq.map((x) => x.call), hash) : []
  const reading = { policies: Object.fromEntries(SCOPE_KEYS.map((s) => [s, policies[s] ?? null])), exists: {}, auth: {} }
  uniq.forEach((x, i) => { if (x.k === 'e') reading.exists[x.id] = boolOf(r2[i]); else reading.auth[x.id + '|' + x.addr] = boolOf(r2[i]) })
  const roles = {}
  for (const a of accounts) {
    const r = roles[low(a.address)] || (roles[low(a.address)] = {})
    for (const s of a.scopes) { const v = allowedIn(reading, s, a.address); r[s] = v === true || v === false ? v : null }
  }
  return roles
}

/**
 * The roles of some accounts, read at the chain's head on BOTH RPCs of the pair, which must agree, like the cycle:
 * each one's latest head pinned, the lower one fetched by number on both with the same hash and the same time, that
 * time current and not ahead of the clock (checked again after the reads), then rolesAtHash on both, compared. One RPC
 * never decides. Returns { head_block, head_time, roles }, or null when they disagree, one did not answer, or the head
 * is not current.
 */
export async function rolesAt ({ fetchImpl, urls, token, accounts, now = Date.now }) {
  if (!Array.isArray(urls) || urls.length < 2) return null
  const fresh = (h) => now() - h.time <= STALE_S * 1000 && h.time <= now() + FUTURE_SKEW_MS
  try {
    const heads = await Promise.all(urls.slice(0, 2).map((u) => pinHead(fetchImpl, u)))
    if (!plausibleStep(heads[0], heads[1])) return null
    const n = Math.min(heads[0].number, heads[1].number)
    const [ca, cb] = await Promise.all(urls.slice(0, 2).map((u, k) => (heads[k].number === n ? heads[k] : pinTag(fetchImpl, u, n))))
    if (ca.hash !== cb.hash || ca.time !== cb.time || ca.number !== n || cb.number !== n || !fresh(ca)) return null
    const [ra, rb] = await Promise.all(urls.slice(0, 2).map((u) => rolesAtHash(fetchImpl, u, token, accounts, ca.hash)))
    if (JSON.stringify(ra) !== JSON.stringify(rb)) return null
    // Checked again after the reads: a head that went stale while they ran says nothing.
    if (!fresh(ca)) return null
    return { head_block: ca.number, head_time: ca.time, roles: ra }
  } catch (_) { return null }
}

/**
 * simulate_buy's wallet read (§4): what the receiver and sender policies say of the caller's wallet at the head, by
 * rolesAt on both RPCs. Returns { head_block, head_time, receive, send } or null. The caller checks head_time again
 * when it uses the answer.
 */
export async function walletPolicy ({ fetchImpl, urls, token, wallet, now = Date.now }) {
  const r = await rolesAt({ fetchImpl, urls, token, accounts: [{ address: wallet, scopes: ['receiver', 'sender'] }], now })
  if (!r) return null
  const w = r.roles[low(wallet)] || {}
  return { head_block: r.head_block, head_time: r.head_time, receive: w.receiver ?? null, send: w.sender ?? null }
}
