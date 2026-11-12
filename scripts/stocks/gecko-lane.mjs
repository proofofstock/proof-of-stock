// scripts/stocks/gecko-lane.mjs: the GeckoTerminal top-ups as one paced lane beside the DexScreener loop.
//
// Why (12.11): the keyless GeckoTerminal API allows about 5 calls a minute per IP ("~5 calls/min (dynamic, varies by
// server load)", docs.coingecko.com/docs/keyless-public-api), and a Robinhood run asked it about 38 times at a 4.5 s
// pace: 17 or 18 of those were refused (429), and the pauses were three quarters of the run. Now:
//   - a run asks at most `budget` GeckoTerminal requests (pages count), 12.5 s apart;
//   - which tokens: those whose DexScreener list was full (30 pairs) in the last day, the longest without a top-up
//     first; one that needs the aggregator (a pool only GeckoTerminal saw that the chain cannot read) counts an hour older;
//   - the lane starts with the run and works while DexScreener is asked; the scheduled tokens go last in the loop, so
//     their answers are usually there when the loop reaches them.
// A token not topped up this run keeps the pools it learned before (the pool book reads them on chain); its row says
// when it was last topped up (pools.topped_up_at). Per-token state lives in <root>/stock-peg/gecko-topups.json.
import fs from 'node:fs'
import path from 'node:path'
import { readGeckoPools, GECKO_MAX_PAGES } from './gecko-pools.mjs'

export const GECKO_PACE_MS = 12_500
export const GECKO_BUDGET = Object.freeze({ base: 4, robinhood: 10 })
export const TOPUP_STATE_FILE = 'gecko-topups.json'
const CAPPED_RECENT_MS = 24 * 3600e3
const KEEP_MS = 7 * 24 * 3600e3

export function readTopups (dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, TOPUP_STATE_FILE), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {} } catch (_) { return {} }
}

/** Write the state atomically, keeping only tokens whose list was full in the last week. */
export function writeTopups (dir, state, nowMs) {
  const kept = Object.fromEntries(Object.entries(state).filter(([, s]) => s && s.capped_at && nowMs - Date.parse(s.capped_at) < KEEP_MS))
  const f = path.join(dir, TOPUP_STATE_FILE), tmp = f + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(kept)); fs.renameSync(tmp, f)
}

/** The addresses to top up this run, in order, within `budget` requests (a token costs the pages it took last time). */
export function schedule (state, addresses, budget, nowMs) {
  if (!(budget > 0)) return []
  const due = addresses.filter((a) => { const s = state[a]; return s && s.capped_at && nowMs - Date.parse(s.capped_at) < CAPPED_RECENT_MS })
  // Oldest top-up first; a token that needs the aggregator counts an hour older: a head start, not a pass, so the
  // budget can never go to such tokens alone run after run.
  const age = (a) => (Date.parse(state[a].topped_at || 0) || 0) - (state[a].needs_aggregator ? 3600e3 : 0)
  due.sort((a, b) => age(a) - age(b))
  const out = []
  let used = 0
  for (const a of due) {
    const cost = Math.min(GECKO_MAX_PAGES, Math.max(1, Number(state[a].pages) || 2))
    if (out.length && used + cost > budget) continue
    out.push(a); used += cost
    if (used >= budget) break
  }
  return out
}

/**
 * Start the lane: one request at a time, `paceMs` apart (pages too), stopping at `stopAt` (ms) if given. Returns a Map
 * address -> Promise of { pairs, more, snaps } | { error } | { skipped: true }. Never rejects.
 */
export function startLane ({ fetchImpl, network, addresses, paceMs = GECKO_PACE_MS, stopAt = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), read = readGeckoPools }) {
  const done = new Map(), out = new Map()
  let stopped = false
  for (const a of addresses) out.set(a, new Promise((resolve) => done.set(a, resolve)))
  ;(async () => {
    for (const a of addresses) {
      const late = () => stopped || (stopAt != null && now() >= stopAt)
      if (late()) { done.get(a)({ skipped: true }); continue }
      if (paceMs > 0) await sleep(paceMs)
      if (late()) { done.get(a)({ skipped: true }); continue }
      try { done.get(a)(await read(fetchImpl, network, a, { paceMs })) } catch (e) { done.get(a)({ error: String(e && e.message || e).slice(0, 200) }) }
    }
  })().catch(() => { for (const r of done.values()) r({ skipped: true }) })
  // The run calls stop() when it ends, however it ends: no request leaves after the run row is written.
  out.stop = () => { stopped = true }
  return out
}

/** Does a top-up's answer hold a pool the chain cannot read (a v4 pool id, or one the pool book could not decode)? */
export function needsAggregator (dsPairs, geckoPairs, book) {
  const seen = new Set((dsPairs || []).map((p) => String(p.pairAddress || '').toLowerCase()))
  return (geckoPairs || []).some((p) => {
    const id = String(p.pairAddress || '').toLowerCase()
    if (!id || seen.has(id)) return false
    return id.length === 66 || /v4/i.test(String(p.dexId || '')) || book?.pools?.[id]?.decoder === 'none'
  })
}
