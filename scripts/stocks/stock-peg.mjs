// scripts/stocks/stock-peg.mjs — one reading of every issuer-listed tokenized stock on one chain: the issuer's reference
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
// Sources: the issuer's list and reference (evm/core/stocks/registries.mjs), DexScreener token-pairs per token
// (evm/core/stocks/peg.mjs decides what counts). On Base only tokens with supply are read: an unminted token has no
// pool, and asking for it 227 times a run is a cost with no reading in it.
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
import { readGeckoPools, mergePairs } from './gecko-pools.mjs'
import { recordRegistry } from '../../evm/core/stocks/history.mjs'

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
const PAIR_TIMEOUT_MS = 15_000
export const SUPPLEMENT_STOP_MS = 90_000 // no GeckoTerminal top-ups this close to the deadline
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function readPairs (fetchImpl, slug, address) {
  const r = await fetchImpl(`https://api.dexscreener.com/token-pairs/v1/${slug}/${address}`, { signal: AbortSignal.timeout(PAIR_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`dexscreener answered ${r.status}`)
  const body = await r.json()
  if (!Array.isArray(body)) throw new Error('dexscreener body is not an array')
  return body
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

export async function runStockPeg ({ chain, root, fetchImpl = fetch, now = () => Date.now(), paceMs = 250, geckoPaceMs = 4500, log = console.log,
  deadline = null, // ms since epoch, or null for none; see the header
  onHistoryError = () => { process.exitCode = 1 } }) {
  const C = CHAINS[chain]
  if (!C) throw new Error(`unknown chain ${chain}: expected one of ${Object.keys(CHAINS).join(', ')}`)
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

  let records = null
  try {
    records = await C.read(fetchImpl, { chainId: C.chainId })
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
  try {
  if (records) {
    const wanted = records.filter((r) => r.chain_id === C.chainId && r.supplied)
    run.tokens_considered = wanted.length
    for (const rec of wanted) {
      if (deadline != null && now() >= deadline) { run.aborted = `time budget: stopped before token ${run.rows_written + run.rows_invalid + 1} of ${wanted.length}`; break }
      let pairs = null, pairError = null
      try { pairs = await readPairs(fetchImpl, C.slug, rec.address) } catch (e) { pairError = String(e && e.message || e).slice(0, 200); run.pair_read_errors++ }
      // A full DexScreener list may be hiding pools: ask GeckoTerminal for more, and keep the first list if it refuses.
      let source = 'dexscreener', stillCapped = null
      if (pairs && pairs.length >= DEXSCREENER_PAIR_CAP && C.gecko && deadline != null && now() >= deadline - SUPPLEMENT_STOP_MS) {
        run.supplement_skipped = (run.supplement_skipped || 0) + 1
      } else if (pairs && pairs.length >= DEXSCREENER_PAIR_CAP && C.gecko) {
        try {
          if (geckoPaceMs > 0) await sleep(geckoPaceMs)
          const g = await readGeckoPools(fetchImpl, C.gecko, rec.address, { paceMs: geckoPaceMs })
          pairs = mergePairs(pairs, g.pairs); source = 'dexscreener+geckoterminal'; stillCapped = g.more; run.supplemented++
        } catch (_) { run.supplement_errors++ }
      }
      const at = now()
      const reading = pegReading(rec.address, rec.reference, pairs, { referenceAssets: C.referenceAssets })
      if (stillCapped != null) reading.pools.capped = stillCapped
      // A bid/ask reference is aged from when it last changed (see unchangedSince); a NAV carries its own update time.
      if (rec.reference.kind === 'token_bid_ask_mid') rec.reference.updated_at = unchangedSince(since, rec.address, rec.reference, new Date(at).toISOString())
      const refAt = rec.reference.updated_at ? Date.parse(rec.reference.updated_at) : null
      const row = {
        _schema_version: '1.0', run_id: runId, observed_at: new Date(at).toISOString(), chain_id: rec.chain_id, issuer: rec.issuer,
        token_address: rec.address, symbol: rec.symbol, isin: rec.isin, multiplier: rec.multiplier, multiplier_pending: rec.multiplier_pending,
        paused: rec.paused,
        reference: { ...rec.reference, age_s: refAt != null ? Math.round((at - refAt) / 1000) : null },
        pools: { source, ...reading.pools, error: pairError },
        dex_price_usd: reading.dex_price_usd, dex_pool: reading.dex_pool, premium: reading.premium, premium_refused: reading.premium_refused,
        dex_inside_quote: reading.dex_inside_quote,
      }
      const v = validateV2('stock-peg', row)
      if (!v.valid) { run.rows_invalid++; log(`[stock-peg] invalid row ${rec.address}: ${JSON.stringify(v.errors).slice(0, 300)}`) } else {
        fs.appendFileSync(path.join(outDir, `stock-peg-${day(at)}.jsonl`), JSON.stringify(row) + '\n')
        run.rows_written++
        if (row.premium_refused) run.refused[row.premium_refused] = (run.refused[row.premium_refused] || 0) + 1
      }
      if (paceMs > 0) await sleep(paceMs)
    }
  }
  } catch (e) {
    // The run row is written whatever happens, so a run that died midway is never mistaken for one that never ran.
    run.aborted = String(e && e.message || e).slice(0, 300)
  } finally {
    try { writeSince(outDir, since) } catch (_) { /* the next run re-learns */ }
  }

  run.finished_at = new Date(now()).toISOString()
  const v = validateV2('stock-peg-run', run)
  if (!v.valid) log(`[stock-peg] invalid run row: ${JSON.stringify(v.errors).slice(0, 300)}`)
  fs.appendFileSync(path.join(outDir, `stock-peg-runs-${day(started)}.jsonl`), JSON.stringify(run) + '\n')
  log('[stock-peg] ' + JSON.stringify({ chain, registry: run.registry, tokens: run.tokens_considered, written: run.rows_written, invalid: run.rows_invalid, refused: run.refused, pair_read_errors: run.pair_read_errors, supplement_skipped: run.supplement_skipped || 0, aborted: run.aborted ?? null }))
  return run
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
