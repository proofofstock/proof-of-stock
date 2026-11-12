// scripts/stocks/stock-peg.mjs: one reading of every issuer-listed tokenized stock on one chain: the issuer's reference
// price for a token, the DEX pools that trade it, and the premium of the deepest pool over the reference.
//
// Runs as a oneshot on a timer (deployment/systemd/stp-peg.{service,timer}), never inside a server or a
// collector loop (ADR-0003). Writes only <root>/stock-peg/:
//   stock-peg-YYYY-MM-DD.jsonl       one row per token per run (schemas/v2/stock-peg.schema.json)
//   stock-peg-runs-YYYY-MM-DD.jsonl  one row per run, ALWAYS, even when no token row was written
// Nothing in the product reads them yet.
//
// ⚠ THE SERIES ONLY GROWS FORWARD. A weekend or a market holiday that was not recorded cannot be read back later:
// DexScreener answers with the price now, the issuers with their reference now. That is why this exists before
// anything that would show it.
//
// Sources: the issuer's list and reference (evm/core/stocks/registries.mjs), DexScreener token-pairs per token, and the
// chain itself (scripts/stocks/onchain-pools.mjs): every pool the run knows of for the token, read at one pinned block
// through Multicall3. Where both see a pool the chain's price and liquidity win; where either fails the other stands
// (evm/core/stocks/peg.mjs decides what counts). On Base only tokens with supply are read: an unminted token has no
// pool, and asking for it 227 times a run is a cost with no reading in it.
//
// EVIDENCE. Each row says what its DEX price rests on (`price_evidence`, the DEX leg only): for a price the chain gave,
// the block, its hash, the aggregate3 calldata and the bytes returned, which anyone can call again (`reproduce`); for a
// price only an aggregator gave, `{ evidence: "none" }`, because nobody can ask for that answer again. The issuer's
// reference is an API answer nobody can replay either (`reference_evidence: "issuer_api_not_reproducible"`).
// Short-lived private copies of the aggregators' answers may be kept for our own error checking, off by default and
// never public (scripts/stocks/raw-store.mjs).
//
// Usage: node scripts/stocks/stock-peg.mjs --chain=base|robinhood --root=<data root> [--pace-ms=250] [--deadline=<unix s>]
//
// ⚠ THE DEADLINE KEEPS THE RUN ROW. systemd kills the unit at TimeoutStartSec, and a killed run writes nothing about
// itself. With --deadline (deployment/systemd/stp-peg.service passes one, short of the timeout) the run stops topping up
// full pool lists from GeckoTerminal (≥4.5 s each) SUPPLEMENT_STOP_MS before it, stops reading tokens at it, and writes
// its run row either way: what was skipped is counted, a stop is in `aborted` and fails the unit (runExitCode).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { validateV2 } from '../../schemas/v2/validate.mjs'
import { readCoinbase, readRobinhood } from '../../evm/core/stocks/registries.mjs'
import { BASE_DESCRIPTOR } from '../../evm/chains/base/descriptor.mjs'
import { ROBINHOOD_DESCRIPTOR } from '../../evm/chains/robinhood/descriptor.mjs'
import { pegReading, DEXSCREENER_PAIR_CAP } from '../../evm/core/stocks/peg.mjs'
import { mergePairs } from './gecko-pools.mjs'
import { GECKO_PACE_MS, GECKO_BUDGET, readTopups, writeTopups, schedule, startLane, needsAggregator } from './gecko-lane.mjs'
import { prepareOnchain, readTokenOnchain, mergeOnchain, learn, evidenceOf, saveOnchain, ONCHAIN } from './onchain-pools.mjs'
import { snapshotOf, openRawStore } from './raw-store.mjs'
import { recordRegistry } from '../../evm/core/stocks/history.mjs'
import { shapeOf, mergeShapes, shapeChanges } from '../../evm/core/stocks/shape.mjs'

// Which issuer publishes for which chain, and that chain's DexScreener and GeckoTerminal names. The chain id comes from
// the descriptor.
// What a pool's other token must be for the pool to price a stock token: the chain's dollar stables and its wrapped
// native, by address (evm/core/stocks/peg.mjs tokenPriceIn says why).
export function referenceAssetsOf (d) {
  return new Set([...(d.stableAssets || []), d.wrappedNative].filter(Boolean).map((a) => String(a).toLowerCase()))
}
// No prototype: a ?chain= of "constructor" or "__proto__" must not find an inherited member (it used to answer 500).
export const CHAINS = Object.freeze(Object.assign(Object.create(null), {
  base: { issuer: 'coinbase', read: readCoinbase, slug: 'base', gecko: 'base', chainId: BASE_DESCRIPTOR.chainId, explorer: BASE_DESCRIPTOR.explorer?.webUrl || null, referenceAssets: referenceAssetsOf(BASE_DESCRIPTOR) },
  robinhood: { issuer: 'robinhood', read: readRobinhood, slug: 'robinhood', gecko: 'robinhood', chainId: ROBINHOOD_DESCRIPTOR.chainId, explorer: ROBINHOOD_DESCRIPTOR.explorer?.webUrl || null, referenceAssets: referenceAssetsOf(ROBINHOOD_DESCRIPTOR) },
}))
// DexScreener answers in about 0.15 s (p95 0.19 s, measured on the host 12.11); a request still open after 6 s is
// not coming back, and every second it waits is taken from the run's deadline (the 17:01 abort, 12.11).
const PAIR_TIMEOUT_MS = 6_000
// After this many tokens in a row whose chain read failed, the run stops asking the chain: each failure can cost two
// RPC timeouts, and the aggregators' reading stands anyway. The pool book still learns.
export const ONCHAIN_BREAKER = 5
export const SUPPLEMENT_STOP_MS = 90_000 // no GeckoTerminal top-ups this close to the deadline
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function readPairs (fetchImpl, slug, address) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${slug}/${address}`
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(PAIR_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`dexscreener answered ${r.status}`)
  const snap = await snapshotOf('dexscreener', url, r)
  const body = JSON.parse(snap.body)
  if (!Array.isArray(body)) throw new Error('dexscreener body is not an array')
  return { pairs: body, snap }
}

/**
 * Where a run spends its time (owner, 12.11: a Robinhood run reached its 9-minute deadline). Wraps fetch: every outside
 * request is sorted by source and timed until its whole answer has arrived (the body is read once from a clone, so the
 * caller reads it as before). summary() gives, per source, the count, the total and the p50, p95 and max in ms, and how
 * many answers were 429 (rate limited) and how many failed otherwise (another non-2xx status, a timeout, a network error).
 * JSON-RPC is recognised by its body before any host, since an RPC host may sit under an issuer's domain
 * (rpc.mainnet.chain.robinhood.com).
 */
export function timedFetch (fetchImpl, clock = () => performance.now()) {
  const times = {}
  const rpcMethod = (init) => {
    if (!init || typeof init.body !== 'string') return null
    try { const b = JSON.parse(init.body); const one = Array.isArray(b) ? b[0] : b; return one && one.jsonrpc ? String(one.method || '') : null } catch (_) { return null }
  }
  const sourceOf = (url, init) => {
    const m = rpcMethod(init)
    if (m != null) return m === 'eth_call' ? 'rpc_call' : (m === 'eth_blockNumber' || m.startsWith('eth_getBlock')) ? 'rpc_block' : 'rpc_other'
    let host = ''
    try { host = new URL(String(url)).host } catch (_) { /* counted as other */ }
    if (/(^|\.)dexscreener\.com$/.test(host)) return 'dexscreener'
    if (/(^|\.)geckoterminal\.com$/.test(host)) return 'geckoterminal'
    if (/(^|\.)(coinbase|robinhood)\.com$/.test(host)) return 'issuer'
    return 'other'
  }
  const statuses = {}
  const timed = async (url, init) => {
    const source = sourceOf(url, init), t0 = clock()
    const st = (statuses[source] ||= { n_429: 0, n_failed: 0 })
    try {
      const r = await fetchImpl(url, init)
      if (r && r.status === 429) st.n_429++
      else if (r && r.ok === false) st.n_failed++
      if (r && typeof r.clone === 'function') await r.clone().arrayBuffer().catch(() => {})
      return r
    } catch (e) { st.n_failed++; throw e } finally { (times[source] ||= []).push(Math.max(0, clock() - t0)) }
  }
  timed.summary = () => Object.fromEntries(Object.entries(times).map(([source, xs]) => {
    const v = [...xs].sort((a, b) => a - b), at = (p) => Math.round(v[Math.min(v.length - 1, Math.floor(p * v.length))])
    return [source, { n: v.length, total_ms: Math.round(v.reduce((a, b) => a + b, 0)), p50_ms: at(0.5), p95_ms: at(0.95), max_ms: Math.round(v[v.length - 1]), n_429: statuses[source]?.n_429 || 0, n_failed: statuses[source]?.n_failed || 0 }]
  }))
  return timed
}

// Robinhood stamps every quote with the time its server answered (generatedAt), which is seconds old even when the quote
// has not moved all weekend. A reference's age must be how long it has been UNCHANGED, so the recorder keeps, per token,
// the mid it last saw and since when, across runs, in <root>/stock-peg/reference-since.json. A mid seen for the first
// time is dated from its own quote time: an underestimate the next change corrects, never a fresh-looking held price.
const SINCE_FILE = 'reference-since.json'
function readSince (dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, SINCE_FILE), 'utf8')) } catch (_) { return {} } }
function writeSince (dir, state) { const f = path.join(dir, SINCE_FILE); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, f) }
export function unchangedSince (state, address, reference, atIso) {
  const mid = reference && typeof reference.price_usd === 'number' ? reference.price_usd : null
  if (mid == null) return reference && reference.updated_at
  const prev = state[address]
  if (!prev || prev.mid !== mid) state[address] = { mid, since: reference.quoted_at || atIso }
  return state[address].since
}

export async function runStockPeg ({ chain, root, fetchImpl = fetch, now = () => Date.now(), paceMs = 250, geckoPaceMs = GECKO_PACE_MS, geckoBudget = null, log = console.log,
  deadline = null, // ms since epoch, or null for none; see the header
  env = process.env, // STP_RPC_BASE / STP_RPC_ROBINHOOD replace the public RPC (scripts/stocks/onchain-pools.mjs)
  clock = () => performance.now(), // times the outside requests (timedFetch); `now` stays the run's calendar
  onHistoryError = () => { process.exitCode = 1 } }) {
  const C = CHAINS[chain]
  if (!C) throw new Error(`unknown chain ${chain}: expected one of ${Object.keys(CHAINS).join(', ')}`)
  const timed = timedFetch(fetchImpl, clock)
  fetchImpl = timed
  const outDir = path.join(root, 'stock-peg')
  fs.mkdirSync(outDir, { recursive: true })
  const started = now()
  const runId = `${chain}-${new Date(started).toISOString()}-${crypto.randomBytes(3).toString('hex')}`
  const run = {
    _schema_version: '1.0', run_id: runId, chain_id: C.chainId, issuer: C.issuer,
    started_at: new Date(started).toISOString(), finished_at: null,
    registry: { records: null, complete: false, error: null },
    tokens_considered: 0, rows_written: 0, rows_invalid: 0, refused: {}, pair_read_errors: 0, supplemented: 0, supplement_errors: 0,
  }
  let chainState = null, raw = { on: false }
  // The shape of every third-party answer this run (evm/core/stocks/shape.mjs), per source; compared with the last run's.
  const shapes = {}

  let records = null
  try {
    records = await C.read(fetchImpl, { chainId: C.chainId, onBody: (src, body) => (shapes[src] ||= []).push(shapeOf(body)) })
    run.registry = { records: records.length, complete: true, error: null }
    // H2: a snapshot of the registry whenever it changed (docs/stocks-truth-layer-tz.md §H). What an issuer listed on a
    // given day cannot be read back later. A failure here never stops the readings, but it fails the unit.
    try {
      const h = recordRegistry({ root, records, chainId: C.chainId, issuer: C.issuer, at: now(), validate: validateV2, log })
      if (h.written || h.invalid) log('[stock-peg] registry snapshot ' + JSON.stringify({ chain, ...h }))
      if (h.invalid) onHistoryError()
    } catch (e) { log('[stock-peg] ALARM registry snapshot not written: ' + (e && e.message || e)); onHistoryError() }
  } catch (e) {
    run.registry = { records: null, complete: false, error: String(e && e.message || e).slice(0, 300) }
  }

  const since = readSince(outDir)
  const topups = readTopups(outDir)
  let lane = null
  try {
  if (records) {
    const listed = records.filter((r) => r.chain_id === C.chainId && r.supplied)
    // GeckoTerminal top-ups run as one paced lane beside this loop (scripts/stocks/gecko-lane.mjs); the tokens it will
    // top up go last, so their answers are usually in by the time the loop reaches them.
    const lanePlan = C.gecko ? schedule(topups, listed.map((r) => r.address), geckoBudget ?? GECKO_BUDGET[chain] ?? 0, now()) : []
    const inLane = new Set(lanePlan)
    const wanted = [...listed.filter((r) => !inLane.has(r.address)), ...listed.filter((r) => inLane.has(r.address))]
    run.tokens_considered = wanted.length
    // The chain's side of the run. It never throws: a chain it cannot reach leaves every reading to the aggregators.
    chainState = await prepareOnchain({ chain, dir: outDir, tokens: wanted.map((r) => r.address), referenceAssets: C.referenceAssets, fetchImpl, now, env })
    run.onchain = { rpc: chainState.rpc, error: chainState.error, discovered: chainState.discovered, tokens_read: 0, read_errors: 0, breaker: null }
    let chainFails = 0, lastDexStart = -Infinity
    // Private copies of the aggregators' answers (scripts/stocks/raw-store.mjs): off unless STP_RAW_SNAPSHOTS=1.
    raw = openRawStore({ chain, env, now, log })
    lane = startLane({ fetchImpl, network: C.gecko, addresses: lanePlan, paceMs: geckoPaceMs, stopAt: deadline != null ? deadline - SUPPLEMENT_STOP_MS : null, now })
    for (const rec of wanted) {
      if (deadline != null && now() >= deadline) { run.aborted = `time budget: stopped before token ${run.rows_written + run.rows_invalid + 1} of ${wanted.length}`; break }
      // DexScreener allows 300 requests a minute for token-pairs; a start every paceMs (250 ms: 240 a minute) keeps to 80% of
      // it, and the time its answer takes counts toward the gap instead of adding to it (was a fixed pause after each token).
      if (paceMs > 0) { const wait = lastDexStart + paceMs - clock(); if (wait > 0) await sleep(wait) }
      lastDexStart = clock()
      let pairs = null, pairError = null
      const snaps = []
      // The chain is read from the pool book while DexScreener answers: a pool DexScreener lists for the first time is
      // read from the chain from the next run on (the factories' pools from the first). Sequential, the chain added
      // ~0.4 s a token, ~80 s to a Robinhood run already near its deadline (measured 12.11).
      const chainP = chainState.ok && !run.onchain.breaker ? readTokenOnchain(chainState, fetchImpl, rec.address, { tokenUsd: rec.reference?.price_usd ?? null }).then((r) => ({ r }), (e) => ({ e })) : null
      try { const d = await readPairs(fetchImpl, C.slug, rec.address); pairs = d.pairs; snaps.push(d.snap); (shapes['dexscreener:token-pairs'] ||= []).push(shapeOf(d.pairs)) } catch (e) { pairError = String(e && e.message || e).slice(0, 200); run.pair_read_errors++ }
      const dsCapped = pairs ? pairs.length >= DEXSCREENER_PAIR_CAP : false
      // A full DexScreener list may be hiding pools: ask GeckoTerminal for more, and keep the first list if it refuses.
      const sources = pairs ? ['dexscreener'] : []
      let stillCapped = null
      const atIso = new Date(now()).toISOString()
      const state = topups[rec.address] || null
      if (dsCapped) topups[rec.address] = { ...(state || {}), capped_at: atIso }
      if (lane.has(rec.address)) {
        const g = await lane.get(rec.address)
        if (g.skipped) run.supplement_skipped = (run.supplement_skipped || 0) + 1
        else if (g.error) run.supplement_errors++
        else if (pairs) {
          const need = needsAggregator(pairs, g.pairs, chainState?.book)
          pairs = mergePairs(pairs, g.pairs); sources.push('geckoterminal'); stillCapped = g.more; run.supplemented++; snaps.push(...g.snaps)
          topups[rec.address] = { ...(topups[rec.address] || {}), topped_at: atIso, pages: g.snaps.length, more: g.more, needs_aggregator: need }
        }
      } else if (dsCapped && C.gecko) run.supplement_deferred = (run.supplement_deferred || 0) + 1
      const toppedAt = dsCapped ? (topups[rec.address]?.topped_at || null) : null
      // The chain's answer. A failure here costs nothing: the aggregators' reading stands.
      let onchainError = null, chainRead = null
      if (chainP) {
        const c = await chainP
        if (c.e) {
          onchainError = String(c.e && c.e.message || c.e).slice(0, 200); run.onchain.read_errors++
          if (++chainFails >= ONCHAIN_BREAKER) run.onchain.breaker = `stopped reading the chain after ${ONCHAIN_BREAKER} failed tokens in a row, at token ${run.rows_written + run.rows_invalid + 1} of ${wanted.length}`
        } else if (c.r) { chainFails = 0; chainRead = c.r; run.onchain.tokens_read++ } // a token with no pool in the book asked nothing, and proves nothing
      }
      // The pool book learns from the aggregators' answer whenever the chain was reached at the start, even after the
      // breaker stopped the reads: the next run starts with the pools this one saw.
      if (chainState.ok) learn(chainState.book, rec.address, pairs, C.referenceAssets, sources.includes('geckoterminal') ? 'geckoterminal' : 'dexscreener', new Date(now()).toISOString())
      if (chainRead && chainRead.reads.size) { pairs = mergeOnchain(rec.address, pairs, chainRead.reads, C.referenceAssets, ONCHAIN[chain]?.symbols); sources.push('onchain') }
      const source = sources.length ? sources.join('+') : 'dexscreener'
      const at = now()
      const reading = pegReading(rec.address, rec.reference, pairs, { referenceAssets: C.referenceAssets })
      // Capped is DexScreener's cap, cleared only by GeckoTerminal showing the end of the list.
      reading.pools.capped = stillCapped != null ? stillCapped : dsCapped
      // When the full list was last completed from GeckoTerminal: this run, an earlier one, or never (null).
      reading.pools.topped_up_at = toppedAt
      // A bid/ask reference is aged from when it last changed (see unchangedSince); a NAV carries its own update time.
      if (rec.reference.kind === 'token_bid_ask_mid') rec.reference.updated_at = unchangedSince(since, rec.address, rec.reference, new Date(at).toISOString())
      const refAt = rec.reference.updated_at ? Date.parse(rec.reference.updated_at) : null
      const row = {
        _schema_version: '1.0', run_id: runId, observed_at: new Date(at).toISOString(), chain_id: rec.chain_id, issuer: rec.issuer,
        token_address: rec.address, symbol: rec.symbol, isin: rec.isin, multiplier: rec.multiplier, multiplier_pending: rec.multiplier_pending,
        paused: rec.paused,
        reference: { ...rec.reference, age_s: refAt != null ? Math.round((at - refAt) / 1000) : null },
        pools: { source, ...reading.pools, error: pairError, onchain_error: onchainError },
        dex_price_usd: reading.dex_price_usd, dex_pool: reading.dex_pool, premium: reading.premium, premium_refused: reading.premium_refused,
        dex_inside_quote: reading.dex_inside_quote,
        price_evidence: priceEvidence(chain, reading._best, chainRead),
        reference_evidence: 'issuer_api_not_reproducible',
      }
      const v = validateV2('stock-peg', row)
      if (!v.valid) { run.rows_invalid++; log(`[stock-peg] invalid row ${rec.address}: ${JSON.stringify(v.errors).slice(0, 300)}`) } else {
        fs.appendFileSync(path.join(outDir, `stock-peg-${day(at)}.jsonl`), JSON.stringify(row) + '\n')
        run.rows_written++
        // A private copy of the answers behind a premium, after the row: one that cannot be written never costs the reading.
        if (row.premium != null && raw.on) raw.keep(day(at), runId, rec.address, snaps)
        if (row.premium_refused) run.refused[row.premium_refused] = (run.refused[row.premium_refused] || 0) + 1
      }
    }
  }
  } catch (e) {
    // The run row is written whatever happens, so a run that died midway is never mistaken for one that never ran.
    run.aborted = String(e && e.message || e).slice(0, 300)
  } finally {
    try { writeSince(outDir, since) } catch (_) { /* the next run re-learns */ }
    try { writeTopups(outDir, topups, now()) } catch (_) { /* the next run schedules from what it sees */ }
    lane?.stop()
    if (chainState) { const err = saveOnchain(chainState, outDir); if (err) log('[stock-peg] pool book not written: ' + err) }
    try { run.shape_changes = recordShapes(outDir, shapes, { complete: !run.aborted }) } catch (e) { log('[stock-peg] shapes not compared: ' + String(e && e.message || e).slice(0, 200)) }
  }

  const finished = now()
  run.finished_at = new Date(finished).toISOString()
  run.duration_s = Math.max(0, Math.round((finished - started) / 100) / 10)
  run.budget_s = deadline != null ? Math.max(0, Math.round((deadline - started) / 1000)) : null
  run.timing = timed.summary()
  const v = validateV2('stock-peg-run', run)
  if (!v.valid) log(`[stock-peg] invalid run row: ${JSON.stringify(v.errors).slice(0, 300)}`)
  fs.appendFileSync(path.join(outDir, `stock-peg-runs-${day(started)}.jsonl`), JSON.stringify(run) + '\n')
  log('[stock-peg] ' + JSON.stringify({ chain, registry: run.registry, tokens: run.tokens_considered, written: run.rows_written, invalid: run.rows_invalid, refused: run.refused, pair_read_errors: run.pair_read_errors, supplement_skipped: run.supplement_skipped || 0, supplement_deferred: run.supplement_deferred || 0, onchain: run.onchain ?? null, raw: raw.on ? { written: raw.written, skipped_full: raw.skipped_full, pruned: raw.pruned, store_bytes: raw.bytes } : (raw.error ? { error: raw.error } : 'off'), aborted: run.aborted ?? null, duration_s: run.duration_s, budget_s: run.budget_s, timing: Object.fromEntries(Object.entries(run.timing).map(([s, t]) => [s, `${t.n}x p50 ${t.p50_ms} p95 ${t.p95_ms} total ${t.total_ms}ms`])) }))
  return run
}

/**
 * Compare this run's answer shapes with the last ones kept in <outDir>/shapes.json, keep the new ones, and return what
 * changed as { source: [changes] } (only sources with a change). The DexScreener shape is per token merged; its sizes
 * are not compared (a token's pool count is not a format).
 */
export function recordShapes (outDir, shapes, { complete = true } = {}) {
  const file = path.join(outDir, 'shapes.json')
  let kept = {}
  try { kept = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { /* the first run keeps a baseline */ }
  const changes = {}
  for (const [src, list] of Object.entries(shapes)) {
    const now = mergeShapes(list)
    if (src.startsWith('dexscreener')) now.sizes = {}
    const c = shapeChanges(kept[src], now, { complete })
    if (c.length) changes[src] = c.slice(0, 20)
    kept[src] = now
  }
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(kept)); fs.renameSync(tmp, file)
  return changes
}

/**
 * What the row's DEX price rests on: the chain's reading when the deepest pool was priced on-chain (reproducible); else
 * `{ evidence: "none" }`: an aggregator's answer cannot be asked for again, and a hash of it is not evidence. Null when
 * there is no price.
 */
export function priceEvidence (chain, best, chainRead) {
  if (!best) return null
  if (best._onchain && chainRead) return evidenceOf(chain, best._onchain, chainRead.block, chainRead.calls, chainRead.results)
  return { evidence: 'none' }
}

/**
 * A run that could not read its issuer's list, died midway or wrote an invalid row exits non-zero, so systemd marks it
 * failed and the alarm sees it. A run that died after the registry read used to exit 0 with half its prices missing.
 */
export const runExitCode = (run) => (!run.registry.complete || run.aborted || run.rows_invalid > 0 ? 1 : 0)

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const dl = arg('deadline')
  if (dl != null && !(Number(dl) > 0)) throw new Error(`--deadline must be unix seconds, got ${dl}`)
  const run = await runStockPeg({ chain: arg('chain'), root: arg('root') || 'data', paceMs: Number(arg('pace-ms') ?? 250), deadline: dl != null ? Number(dl) * 1000 : null })
  process.exitCode = runExitCode(run)
}
