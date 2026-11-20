// scripts/stocks/symbol-sweep.mjs: look-alikes our token dataset never saw, found by asking the market by symbol.
//
// Why (19.11): the impostor list sees only the tokens the collector of another project recorded (data-roots.mjs). A
// second SNDKc on Base, with a deep pool, was never in that dataset, so it was never
// flagged. The aggregators already index it: a search for the issuer's symbol returns it beside the real token.
//
// What a run does, per chain:
//   - DexScreener search for the issuer symbols, DS_PACE_MS apart (its search allows about 300 a minute; we ask under
//     one a second), at most DS_SWEEP_BUDGET a run, rotating (state.ds_cursor) when a registry is longer than that: the
//     unit runs both chains' lists within one timeout (stp-impostors.service), and a long registry would not fit in it.
//     After DS_BREAKER failures in a row it stops asking: the provider is down, not the symbol.
//   - GeckoTerminal search, scoped to the chain, for a few symbols only (GECKO_SWEEP_BUDGET), GECKO_PACE_MS apart,
//     rotating through the list run after run (state.gecko_cursor): its keyless API allows about 5 calls a minute per
//     IP, and the peg recorder spends that same budget (gecko-lane.mjs). A 429 ends GeckoTerminal for the run.
//   - Every token on this chain in the answers that is not in the issuer's registry becomes a candidate, whatever it is
//     called: the published rule (evm/core/stocks/impostor.mjs) decides later, in the impostor list, exactly as it does
//     for the collector's tokens. The sweep only discovers addresses.
//   - ⚠ THE TEXT COMES FROM THE CHAIN, NOT FROM THE PROVIDER. For each new candidate the sweep reads symbol() and name()
//     on chain (text-evidence.mjs, one multicall). Only a token whose text the chain returned is offered to the list
//     (text_from: 'chain'); one the chain could not answer is kept with the provider's text and text_from: 'provider',
//     so it is retried next run, but it is never listed on a provider's word.
//
// State: <root>/stock-peg/swept-tokens.json (our data root, inside the backed-up stock-peg/), written whole.
// Never on a request path: the impostor list's entry point calls it, on its 6-hour timer.
import fs from 'node:fs'
import path from 'node:path'
import { readTextEvidence, decodeText } from './text-evidence.mjs'

export const SWEEP_FILE = 'swept-tokens.json'
export const DS_PACE_MS = 1_100
export const DS_BREAKER = 5
export const DS_SWEEP_BUDGET = 400
export const GECKO_PACE_MS = 12_500
export const GECKO_SWEEP_BUDGET = Object.freeze({ base: 3, robinhood: 3 })
export const SWEEP_MAX_TOKENS = 5_000
const TIMEOUT_MS = 8_000
const ADDR = /^0x[0-9a-f]{40}$/

export function readSweep (dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, SWEEP_FILE), 'utf8'))
    if (j && typeof j === 'object' && j.tokens && typeof j.tokens === 'object' && !Array.isArray(j.tokens)) return j
  } catch (_) { /* none yet, or unreadable: start empty */ }
  return { tokens: {}, gecko_cursor: 0, ds_cursor: 0 }
}

export function writeSweep (dir, state) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, SWEEP_FILE), tmp = `${f}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, f)
}

/** The tokens on `slug` in one DexScreener search answer (base and quote side), outside the registry. */
export function fromDexScreener (body, slug, registrySet) {
  const out = new Map()
  for (const p of (body && Array.isArray(body.pairs) ? body.pairs : [])) {
    if (!p || p.chainId !== slug) continue
    for (const t of [p.baseToken, p.quoteToken]) {
      const a = String(t && t.address || '').toLowerCase()
      if (!ADDR.test(a) || registrySet.has(a) || out.has(a)) continue
      out.set(a, { symbol: t.symbol == null ? null : String(t.symbol), name: t.name == null ? null : String(t.name) })
    }
  }
  return out
}

/** The tokens on `network` in one GeckoTerminal pool search answer (its `included` tokens), outside the registry. */
export function fromGecko (body, network, registrySet) {
  const out = new Map()
  for (const t of (body && Array.isArray(body.included) ? body.included : [])) {
    if (!t || t.type !== 'token') continue
    const id = String(t.id || '')
    if (!id.startsWith(network + '_')) continue
    const a = id.slice(network.length + 1).toLowerCase()
    if (!ADDR.test(a) || registrySet.has(a) || out.has(a)) continue
    const at = t.attributes || {}
    out.set(a, { symbol: at.symbol == null ? null : String(at.symbol), name: at.name == null ? null : String(at.name) })
  }
  return out
}

/** The queries of a run: each issuer symbol once, sorted, so the GeckoTerminal cursor walks a stable order. */
export function queriesOf (registry) {
  return [...new Set(registry.map((r) => String(r.symbol || '').trim()).filter((s) => /^[A-Za-z0-9.\-]{1,20}$/.test(s)))].sort()
}

/**
 * Ask the providers. Returns { found: Map address -> { symbol, name, sources:Set }, asked: { dexscreener, geckoterminal },
 * failed: { dexscreener, geckoterminal }, gecko_cursor }. Never throws: a failure is counted, the run goes on.
 */
export async function searchSymbols ({ queries, slug, network, registrySet, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  dsPaceMs = DS_PACE_MS, geckoPaceMs = GECKO_PACE_MS, geckoBudget = 0, geckoCursor = 0, dsBudget = DS_SWEEP_BUDGET, dsCursor = 0 }) {
  const found = new Map()
  const add = (m, source) => {
    for (const [a, t] of m) {
      const f = found.get(a)
      if (f) { f.sources.add(source); if (f.symbol == null) f.symbol = t.symbol; if (f.name == null) f.name = t.name } else found.set(a, { ...t, sources: new Set([source]) })
    }
  }
  const asked = { dexscreener: 0, geckoterminal: 0 }, failed = { dexscreener: 0, geckoterminal: 0 }
  const get = async (url) => {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
    if (!r.ok) { const e = new Error(`answered ${r.status}`); e.status = r.status; throw e }
    return r.json()
  }
  const wrap = (c) => (queries.length ? ((Number(c) || 0) % queries.length + queries.length) % queries.length : 0)
  let streak = 0, ds = wrap(dsCursor)
  for (let i = 0; i < Math.min(dsBudget, queries.length); i++) {
    if (streak >= DS_BREAKER) break
    const q = queries[ds]
    if (i && dsPaceMs > 0) await sleep(dsPaceMs)
    asked.dexscreener++
    try { add(fromDexScreener(await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`), slug, registrySet), 'dexscreener'); streak = 0 } catch (_) { failed.dexscreener++; streak++ }
    ds = (ds + 1) % queries.length
  }
  let cursor = queries.length ? ((Number(geckoCursor) || 0) % queries.length + queries.length) % queries.length : 0
  for (let n = 0; n < Math.min(geckoBudget, queries.length); n++) {
    const q = queries[cursor]
    if (geckoPaceMs > 0) await sleep(geckoPaceMs)
    asked.geckoterminal++
    try {
      add(fromGecko(await get(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(q)}&network=${encodeURIComponent(network)}&include=base_token,quote_token`), network, registrySet), 'geckoterminal')
      cursor = (cursor + 1) % queries.length
    } catch (e) { failed.geckoterminal++; if (e && e.status === 429) break; cursor = (cursor + 1) % queries.length }
  }
  return { found, asked, failed, gecko_cursor: cursor, ds_cursor: ds }
}

/**
 * Fold one run's finds into the state. `evidence`: Map address -> text evidence (text-evidence.mjs) for the tokens
 * asked on chain this run. A token's text is the chain's once the chain has answered; it never goes back to a
 * provider's. first_seen_at keeps the earliest run that found it.
 */
export function mergeSweep (state, found, evidence, nowIso) {
  const tokens = { ...(state.tokens || {}) }
  let added = 0, confirmed = 0
  for (const [a, f] of found) {
    const prev = tokens[a]
    const ev = evidence.get(a)
    const chainSymbol = ev && ev.symbol_return != null ? decodeText(ev.symbol_return) : null
    const chainName = ev && ev.name_return != null ? decodeText(ev.name_return) : null
    const fromChain = chainSymbol != null || chainName != null
    if (!prev && Object.keys(tokens).length >= SWEEP_MAX_TOKENS) continue
    if (!prev) added++
    const sources = [...new Set([...(prev ? prev.sources || [] : []), ...f.sources])].sort()
    if (prev && prev.text_from === 'chain') { tokens[a] = { ...prev, last_seen_at: nowIso, sources }; continue }
    if (fromChain) confirmed++
    tokens[a] = {
      symbol: fromChain ? chainSymbol : f.symbol,
      name: fromChain ? chainName : f.name,
      text_from: fromChain ? 'chain' : 'provider',
      ...(fromChain ? { block_number: ev.block_number } : {}),
      first_seen_at: prev && prev.first_seen_at ? prev.first_seen_at : nowIso,
      last_seen_at: nowIso,
      sources,
    }
  }
  return { state: { ...state, tokens }, added, confirmed }
}

/** The tokens the impostor list may use: text read from the chain, address well formed, not in the registry. */
export function sweptForList (state, registrySet) {
  const out = new Map()
  for (const [a, t] of Object.entries(state && state.tokens || {})) {
    if (!ADDR.test(a) || registrySet.has(a) || !t || t.text_from !== 'chain') continue
    const first = Date.parse(t.first_seen_at)
    out.set(a, { symbol: t.symbol ?? null, name: t.name ?? null, first: Number.isFinite(first) ? first : null })
  }
  return out
}

/**
 * One sweep for a chain: search, read the new finds on chain, fold, write. Returns a summary for the journal.
 * `chainCfg`: CHAINS[chain] (stock-peg.mjs). Skipped (never throws) when POS_SYMBOL_SWEEP=0.
 */
export async function runSweep ({ chain, chainCfg, dir, fetchImpl = fetch, env = process.env, now = () => Date.now(), sleep, readEvidence = readTextEvidence, registry = null }) {
  if (env.POS_SYMBOL_SWEEP === '0') return { chain, skipped: 'POS_SYMBOL_SWEEP=0' }
  const reg = registry || await chainCfg.read(fetchImpl, { chainId: chainCfg.chainId })
  const registrySet = new Set(reg.map((r) => String(r.address).toLowerCase()))
  const state = readSweep(dir)
  const queries = queriesOf(reg)
  const s = await searchSymbols({ queries, slug: chainCfg.slug, network: chainCfg.gecko, registrySet, fetchImpl, ...(sleep ? { sleep } : {}),
    geckoBudget: GECKO_SWEEP_BUDGET[chain] || 0, geckoCursor: state.gecko_cursor, dsCursor: state.ds_cursor })
  // Ask the chain about every find whose text it has not answered yet (new ones and earlier provider-only ones).
  const ask = [...s.found.keys()].filter((a) => !(state.tokens[a] && state.tokens[a].text_from === 'chain'))
  const evidence = ask.length ? await readEvidence({ chain, chainId: chainCfg.chainId, addresses: ask, fetchImpl, env }) : new Map()
  const m = mergeSweep(state, s.found, evidence, new Date(now()).toISOString())
  writeSweep(dir, { ...m.state, gecko_cursor: s.gecko_cursor, ds_cursor: s.ds_cursor, swept_at: new Date(now()).toISOString() })
  return { chain, queries: queries.length, asked: s.asked, failed: s.failed, found: s.found.size, new: m.added, read_on_chain: evidence.size, tokens: Object.keys(m.state.tokens).length }
}
