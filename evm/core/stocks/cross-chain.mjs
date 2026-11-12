// evm/core/stocks/cross-chain.mjs: the views that look at every issuer chain at once: search across them, the same
// share on another chain, and the "right now" board of where DEX prices sit against the issuers' references.
//
// Pure. Each function is handed, per chain, the issuer registry (evm/core/stocks/registries.mjs) and the in-memory
// readings window (evm/core/stocks/readings-window.mjs); nothing here fetches or reads files.
//
// ⚠ THE SAME SHARE IS MATCHED BY ISIN, NEVER BY SYMBOL. Coinbase writes NVDAc, Robinhood NVDA; a symbol match would
// also pair unrelated tickers that happen to share letters. Two tokens with one ISIN are claims on the same security,
// issued by different issuers under different terms, the comparison shows prices side by side, it does not say they
// are interchangeable.

import { premiumAt, PUBLIC_WINDOW_H } from './passport.mjs'
import { readingsOf } from './readings-window.mjs'

const tickerish = (r) => (r.issuer === 'coinbase' && typeof r.symbol === 'string' ? r.symbol.replace(/c$/, '') : r.symbol)

const low = (v) => (typeof v === 'string' ? v.toLowerCase() : '')
const companyOf = (r) => low(r.name).replace(/\s+robinhood token$/, '')

/**
 * How a record matches a query, or null:
 *   exact  , the symbol, the bare ticker (NVDAc → NVDA) or the ISIN equals the query;
 *   name   , a word of the company name starts with the query (3+ characters), or the name equals it;
 *   prefix , the symbol or bare ticker starts with the query.
 * A query inside a word matches nothing: "SPY" is not Krispy Kreme and "HOOD" is not every "… Robinhood Token".
 */
export function matchQuality (r, q) {
  if ([r.symbol, tickerish(r), r.isin].some((v) => low(v) === q)) return 'exact'
  const company = companyOf(r)
  if (company === q || (q.length >= 3 && company.split(/[^a-z0-9]+/).some((w) => w.startsWith(q)))) return 'name'
  if ([r.symbol, tickerish(r)].some((v) => low(v).startsWith(q))) return 'prefix'
  return null
}

/**
 * Registry records matching a query, across the given chains. When anything matches EXACTLY (ticker or ISIN), only the
 * exact matches are returned: a ticker query must never come back as another company's token. Otherwise name and prefix
 * matches, each labelled with its `match_quality`; nothing found is an empty list with the reason.
 */
export function findAcross (byChain, query, limit = 25) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { matches: [], more: 0, match: 'none', reason: 'empty query' }
  const scan = (qq) => {
    const out = []
    for (const [chain, { records }] of Object.entries(byChain)) {
      for (const r of records || []) { const quality = matchQuality(r, qq); if (quality) out.push({ chain, r, quality }) }
    }
    return out
  }
  let hits = scan(q)
  let exact = hits.filter((h) => h.quality === 'exact')
  // Coinbase's naming carried to another chain: "TSLAc" asked on Robinhood, whose token is TSLA. When nothing equals
  // the query and it ends in Coinbase's suffix, the bare ticker is tried, exact matches only, and the answer says so.
  // Only the suffix of an issuer we read is stripped; another issuer's (xStocks' "TSLAx") would claim a token it is not.
  let normalized = null
  if (!exact.length && /^[a-z0-9.]{1,10}c$/.test(q)) {
    const bare = scan(q.slice(0, -1)).filter((h) => h.quality === 'exact')
    if (bare.length) { hits = bare; exact = bare; normalized = q.slice(0, -1) }
  }
  const kept = exact.length ? exact : hits
  const rank = { exact: 0, name: 1, prefix: 2 }
  kept.sort((a, b) => rank[a.quality] - rank[b.quality] || a.chain.localeCompare(b.chain) || String(a.r.symbol).localeCompare(String(b.r.symbol)))
  return {
    match: exact.length ? 'exact' : kept.length ? 'fuzzy' : 'none',
    ...(normalized ? { query_normalized: normalized.toUpperCase() } : {}),
    reason: normalized ? `"${String(query).trim()}" is Coinbase's naming; no token here is called that, so the ticker ${normalized.toUpperCase()} was matched instead`
      : exact.length ? null : kept.length ? 'no ticker or ISIN equals the query; these match by company name or ticker prefix' : 'no issuer-listed token matches by ticker, ISIN or company name',
    matches: kept.slice(0, limit).map(({ chain, r, quality }) => ({ chain, issuer: r.issuer, symbol: r.symbol, name: r.name ?? null, address: r.address, isin: r.isin, match_quality: quality, has_reference_price: r.reference?.price_usd > 0, minted: r.supplied !== false })),
    more: Math.max(0, kept.length - limit),
  }
}

/** The latest reading of a token in a window, compact: what a row on a board or a comparison needs. */
function latestOf (window, address, now = null) {
  const e = window && window.byToken ? window.byToken.get(address) : null
  const l = e && e.latest
  if (!l) return null
  const best = l.pools && l.pools.top && l.pools.top[0]
  // The reference's age now: from its own update time when known, else the age at the reading plus the reading's age.
  const upd = l.reference && l.reference.updated_at ? Date.parse(l.reference.updated_at) : NaN
  const atReading = l.reference?.age_s ?? null
  const refAge = now == null ? atReading : Number.isFinite(upd) ? Math.max(0, Math.round((now - upd) / 1000)) : atReading == null ? null : atReading + Math.max(0, Math.round((now - Date.parse(l.observed_at)) / 1000))
  return {
    observed_at: l.observed_at, premium: l.premium ?? null, premium_refused: l.premium_refused ?? null,
    dex_price_usd: l.dex_price_usd ?? null, reference_price_usd: l.reference?.price_usd ?? null, reference_age_s: refAge,
    liquidity_usd: best ? best.liquidity_usd ?? null : null, halted: l.reference?.halted ?? null,
  }
}

/**
 * The same security (same ISIN) on every OTHER chain, with its latest reading. With maxAgeS (the passport's window),
 * a reading older than that is not shown (latest: null): the same rule as the passport's own `latest`.
 */
export function sameStockElsewhere (byChain, chain, address, now = null, maxAgeS = null) {
  const own = (byChain[chain]?.records || []).find((r) => r.address === address)
  if (!own || !own.isin) return []
  const out = []
  for (const [c, { records, window }] of Object.entries(byChain)) {
    if (c === chain) continue
    for (const r of records || []) {
      if (r.isin !== own.isin) continue
      let latest = latestOf(window, r.address, now)
      if (latest && now != null && maxAgeS != null && now - Date.parse(latest.observed_at) > maxAgeS * 1000) latest = null
      out.push({ chain: c, issuer: r.issuer, symbol: r.symbol, name: r.name ?? null, address: r.address, multiplier: r.multiplier, latest })
    }
  }
  return out
}

/**
 * The board: per chain, the issuer tokens with a priced reading, furthest from their reference first. Only readings
 * that HAVE a premium are ranked, a token with no deep pool or no reference is counted, not ranked, so the board never
 * implies a token is "at par" when nothing could price it.
 */
export function overview (byChain, { limit = 12, minLiquidityUsd = 0, now = null, staleS = 1800 } = {}) {
  const out = {}
  for (const [chain, { records, window }] of Object.entries(byChain)) {
    const rows = []
    let unpriced = 0, stale = 0, newest = null
    for (const r of records || []) {
      const l = latestOf(window, r.address, now)
      if (!l) continue
      const t = Date.parse(l.observed_at)
      if (newest == null || t > newest) newest = t
      // A reading older than two recorder runs is history; ranking it would show a stopped recorder as today's market.
      if (now != null && now - t > staleS * 1000) { stale++; continue }
      if (l.premium == null || (l.liquidity_usd ?? 0) < minLiquidityUsd) { unpriced++; continue }
      rows.push({ symbol: r.symbol, name: r.name ?? null, address: r.address, isin: r.isin, ...l })
    }
    rows.sort((a, b) => Math.abs(b.premium) - Math.abs(a.premium))
    out[chain] = { issuer: records?.[0]?.issuer ?? null, priced: rows.length, unpriced, stale, rows: rows.slice(0, limit), as_of: window?.loaded_at ? new Date(window.loaded_at).toISOString() : null, newest_reading_at: newest == null ? null : new Date(newest).toISOString() }
  }
  return out
}

// The two issuer chains the matrix pairs, and how each issuer's reference is made, in words.
export const MATRIX_VENUES = Object.freeze(['base', 'robinhood'])
export const MATRIX_STALE_S = 1800
const REFERENCE_WORDS = Object.freeze({
  nav_total_return: 'Coinbase NAV per token (total return)',
  token_bid_ask_mid: 'Robinhood bid/ask mid per token',
})
export const MATRIX_NOTE = 'Each venue\'s premium is its on-chain price over its OWN issuer\'s reference, per token. The gap is the Robinhood premium minus the Base premium. Raw prices are never compared across venues: the multipliers differ and so do the references (Coinbase publishes a NAV, Robinhood a bid/ask), so a gap is a difference of two premiums over different references, not a price difference and not an arbitrage. Facts with their time, not advice.'

/**
 * One venue's cell, built the way the passport builds the same values (evm/core/stocks/passport.mjs), so each cell
 * equals that token's passport: the reference's age is computed against `now`, the multiplier is the reading's, and the
 * premium at the reference's own time comes from the same readings.
 */
function venueOf (chain, r, window, now, staleS) {
  const entry = window && window.byToken ? window.byToken.get(r.address) : null
  const l = entry && entry.latest
  const ref = l ? l.reference : r.reference
  const refAge = ref && ref.updated_at && Number.isFinite(Date.parse(ref.updated_at)) ? Math.max(0, Math.round((now - Date.parse(ref.updated_at)) / 1000)) : (ref?.age_s ?? null)
  const best = l && l.pools && l.pools.top && l.pools.top[0]
  const minted = r.supplied !== false
  const readingAge = l ? Math.round((now - Date.parse(l.observed_at)) / 1000) : null
  return {
    chain, issuer: r.issuer, symbol: r.symbol, address: r.address, minted,
    multiplier: l ? l.multiplier ?? r.multiplier : r.multiplier,
    reference_kind: ref?.kind ?? null, reference_price_usd: ref?.price_usd ?? null, reference_updated_at: ref?.updated_at ?? null, reference_age_s: refAge,
    dex_price_usd: l ? l.dex_price_usd ?? null : null, dex_pool: l ? l.dex_pool ?? null : null, liquidity_usd: best ? best.liquidity_usd ?? null : null,
    premium: l ? l.premium ?? null : null,
    // The reading's own refusal; with no reading at all, the passport's code for why there is none.
    premium_refused: l ? (l.premium == null ? l.premium_refused ?? 'unknown' : null) : (minted ? 'no_readings' : 'not_minted'),
    // From the passport's own window (24 h), not all the site holds (72 h): with an issuer price older than a day, as on a
    // weekend, the passport says null and so must the cell.
    premium_at_reference_time: l ? premiumAt(readingsOf(entry, r.address).filter((x) => Date.parse(x.observed_at) >= now - PUBLIC_WINDOW_H * 3600e3), ref && ref.updated_at) : null,
    observed_at: l ? l.observed_at : null, reading_age_s: readingAge,
    stale: readingAge != null && readingAge > staleS,
  }
}

/** Why a cell gives no usable premium for the gap, or null when it does. */
function cellRefusal (v) {
  if (v.premium == null) return `${v.chain}: ${v.premium_refused}`
  if (v.stale) return `${v.chain}: reading_stale`
  return null
}

/**
 * The Base ↔ Robinhood matrix: one row per ISIN listed on BOTH chains, each venue's premium over its own issuer's
 * reference side by side, and their gap (Robinhood minus Base) when both are current. Rows with a gap come first,
 * largest |gap| first; rows without one follow, with `gap_refused` naming why. A reading older than `staleS` is shown,
 * flagged `stale`, and never enters a gap: a stopped recorder is not today's market.
 *
 * Paired by ISIN only (see the top of this file). An ISIN listed twice on one chain yields one row per pair.
 */
export function matrix (byChain, { now, staleS = MATRIX_STALE_S } = {}) {
  if (!Number.isFinite(now)) throw new Error('matrix needs the time (now)')
  const [A, B] = MATRIX_VENUES
  const byIsin = new Map()
  for (const r of byChain[B]?.records || []) {
    if (!r.isin) continue
    if (!byIsin.has(r.isin)) byIsin.set(r.isin, [])
    byIsin.get(r.isin).push(r)
  }
  const rows = []
  for (const a of byChain[A]?.records || []) {
    if (!a.isin) continue
    for (const b of byIsin.get(a.isin) || []) {
      const va = venueOf(A, a, byChain[A].window, now, staleS)
      const vb = venueOf(B, b, byChain[B].window, now, staleS)
      const refused = [cellRefusal(va), cellRefusal(vb)].filter(Boolean)
      const kinds = [va.reference_kind, vb.reference_kind]
      const differ = kinds[0] == null || kinds[1] == null || kinds[0] !== kinds[1]
      rows.push({
        isin: a.isin, name: a.name ?? null, [A]: va, [B]: vb,
        gap: refused.length ? null : vb.premium - va.premium,
        gap_refused: refused.length ? refused.join('; ') : null,
        reference_kinds_differ: differ,
        reference_note: differ
          ? `The two premiums are over different references: ${kinds.map((k, i) => `${MATRIX_VENUES[i]} over ${REFERENCE_WORDS[k] || k || 'no reference'}`).join(', ')}. The gap is not a price difference.`
          : `Both premiums are over the same kind of reference (${REFERENCE_WORDS[kinds[0]] || kinds[0]}).`,
      })
    }
  }
  rows.sort((x, y) => (x.gap == null) - (y.gap == null) || (x.gap != null ? Math.abs(y.gap) - Math.abs(x.gap) : 0) || String(x[A].symbol).localeCompare(String(y[A].symbol)))
  const withGap = rows.filter((r) => r.gap != null).length
  return {
    generated_at: new Date(now).toISOString(), venues: [...MATRIX_VENUES], compares: 'premium', stale_after_s: staleS, note: MATRIX_NOTE,
    pairs: rows.length, with_gap: withGap, without_gap: rows.length - withGap,
    stale: rows.filter((r) => r[A].stale || r[B].stale).length,
    rows,
  }
}

/**
 * The ISINs a ticker names on the given chains: the symbol itself (NVDAc, NVDA) or the bare ticker (NVDAc → NVDA), any
 * case. A query ending in c that names nothing is retried without it, so "nvdac" finds NVIDIA on both chains.
 */
export function isinsOfTicker (byChain, symbol) {
  const q = String(symbol || '').trim().toLowerCase()
  if (!q) return []
  const look = (s) => {
    const out = new Set()
    for (const { records } of Object.values(byChain)) for (const r of records || []) if (r.isin && (low(r.symbol) === s || low(tickerish(r)) === s)) out.add(r.isin)
    return [...out]
  }
  const hit = look(q)
  return hit.length || !q.endsWith('c') ? hit : look(q.slice(0, -1))
}
