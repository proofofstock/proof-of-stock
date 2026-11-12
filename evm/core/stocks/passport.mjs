// evm/core/stocks/passport.mjs: what can be said, with its time and source, about one token that is or claims to be a
// tokenized stock: who issued it, what the issuer prices it at and how fresh that price is, where it trades and how
// far from that price, and what the market was doing meanwhile.
//
// Pure. It is handed the issuer registry for the chain (evm/core/stocks/registries.mjs), the peg readings recorded for
// the token (scripts/stocks/stock-peg.mjs, any order), what our dataset knows of the token's name, and the time. It
// fetches nothing and writes nothing. The CLI (scripts/stocks/passport.mjs) and, later, the agent read it.
//
// ⚠ FACTS, NOT ADVICE. There is no score, no "buy" and no "safe" here. Every passport carries
// `not_trading_signal: true`, and every gap is named in `notes` rather than filled.
//
// ⚠ RIGHTS COME FROM THE PROSPECTUS, NOT FROM THE CONTRACT. The passport says who issued the token and points at the
// issuer; it never states what a holder is entitled to.

import { symbolLabel, nameLabel, UNTRUSTED_TEXT_NOTE } from './untrusted-text.mjs'
import { usEquitySession } from './market-session.mjs'
import { resemblance } from './impostor.mjs'
import { mintedOf } from './registries.mjs'

// A reference older than this is "held": the issuer is not updating it right now.
export const REFERENCE_HELD_S = 3600
// While the exchange is open the issuer's reference should move; one older than this, against an on-chain price read
// minutes ago, compares two different moments and is named.
export const REFERENCE_LAG_OPEN_S = 1800
// How often the recorder reads (deployment/systemd/stp-peg.timer): "latest" is at most this old when it runs.
export const RECORDER_CADENCE_S = 900
// The recorder runs every 15 minutes; a latest reading older than two runs means it has stopped, and what the passport
// shows is history, not now.
export const READING_STALE_S = 1800
export const DEFAULT_WINDOW_H = 72
// The most a public answer shows: the site and MCP passport (PUBLIC_HOURS in apps/stocks-web.mjs) and the matrix cells
// built to equal it (evm/core/stocks/cross-chain.mjs). One number, so the same value never differs by route.
export const PUBLIC_WINDOW_H = 24
export const NOTE_CODES = Object.freeze([
  'not_in_registry', 'no_readings', 'no_reference', 'reference_held_market_closed', 'reference_held_market_open',
  'trading_halted', 'paused', 'no_dex_price', 'pools_capped', 'multiplier_change_pending', 'calendar_unknown',
  'reference_spread_wide', 'reading_stale', 'not_minted', 'sources_disagree',
])
// The refusals that mean no DEX price was found; the others (no_reference, reference_spread_wide, sources_disagree) have a
// DEX price and lack a usable reference, or a price two sources agree on, and get their own note.
const NO_DEX_PRICE = new Set(['pairs_unavailable', 'no_pairs', 'no_eligible_pool'])

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null)
function stats (xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return { n: 0, median: null, p10: null, p90: null, min: null, max: null }
  return { n: s.length, median: quantile(s, 0.5), p10: quantile(s, 0.1), p90: quantile(s, 0.9), min: s[0], max: s[s.length - 1] }
}
export function premiumAt (rows, iso) {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  const r = rows.find((x) => Date.parse(x.observed_at) >= t && x.premium != null)
  // Only a reading close to the reference's own time is "of the same moment": within two recorder runs. A reference that
  // moved before the window began has no such reading, and the answer is null, not the oldest reading we hold.
  if (!r || Date.parse(r.observed_at) - t > 2 * RECORDER_CADENCE_S * 1000) return null
  return { observed_at: r.observed_at, premium: r.premium, lag_s: Math.round((Date.parse(r.observed_at) - t) / 1000) }
}
const SESSION_GROUP = Object.freeze({ regular: 'regular', pre: 'extended', post: 'extended', closed: 'closed', unknown: 'unknown' })

/**
 * @param {object} p
 * @param {string} p.address
 * @param {number} p.chainId
 * @param {object[]} p.registry   issuer records for this chain
 * @param {object[]} [p.readings] stock-peg rows for this address
 * @param {{symbol?: string, name?: string}} [p.identity]  what our dataset knows of the token
 * @param {number} p.now
 * @param {number} [p.windowH]
 */
export function buildPassport ({ address, chainId, registry, readings = [], identity = {}, now, windowH = DEFAULT_WINDOW_H }) {
  const addr = String(address || '').toLowerCase()
  const rec = (registry || []).find((r) => r.address === addr) || null
  const notes = []
  const session = usEquitySession(now)
  if (session.session === 'unknown') notes.push('calendar_unknown')
  const base = {
    address: addr, chain_id: chainId, generated_at: new Date(now).toISOString(), not_trading_signal: true,
    market_now: { session: session.session, reason: session.reason, holiday: session.holiday, early_close: session.early_close },
  }

  if (!rec) {
    notes.push('not_in_registry')
    return { ...base, in_registry: false, issuer: null, resembles: resemblance({ address: addr, ...identity }, registry),
      // ⚠ The creator's own text: shown as a label (one line, cut), never as written. resemblance() above reads the full text.
      untrusted_text: UNTRUSTED_TEXT_NOTE, identity: { symbol: symbolLabel(identity.symbol), name: nameLabel(identity.name) }, latest: null, series: null, notes }
  }

  // Coinbase lists many tokens before any is minted on Base: no supply, no NAV, no pool, and the recorder skips them.
  // That is one fact, said once, not three gaps.
  const minted = rec.supplied !== false
  if (!minted) notes.push('not_minted')
  const own = (readings || []).filter((r) => r && r.token_address === addr).sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at))
  // ⚠ NO PRICE OLDER THAN THE WINDOW. A passport shows windowH hours of readings (24 in public), `latest` included: when the
  //   recorder has stopped for longer, the last reading it left is not shown; the passport says reading_stale instead.
  const from = now - windowH * 3600e3
  const last = own.length ? own[own.length - 1] : null
  const latest = last && Date.parse(last.observed_at) >= from ? last : null
  const ref = latest ? latest.reference : rec.reference
  // The reference's age NOW. A reading stores it as of the reading, which a stopped recorder would leave looking fresh.
  // A Robinhood quote with no reading of ours: its updated_at is the time Robinhood's server answered, not when the mid last
  // moved (the recorder tracks that), so its age is unknown rather than seconds.
  const unknownAge = !latest && ref && ref.kind === 'token_bid_ask_mid'
  const refAge = unknownAge ? null : ref && ref.updated_at && Number.isFinite(Date.parse(ref.updated_at)) ? Math.max(0, Math.round((now - Date.parse(ref.updated_at)) / 1000)) : (ref?.age_s ?? null)
  if (!ref || !(ref.price_usd > 0)) notes.push('no_reference')
  else if (refAge != null && session.session === 'regular' && refAge > REFERENCE_LAG_OPEN_S) notes.push('reference_held_market_open')
  else if (refAge != null && session.session !== 'regular' && refAge > REFERENCE_HELD_S) notes.push('reference_held_market_closed')
  if (ref && ref.halted === true) notes.push('trading_halted')
  if ((latest ? latest.paused : rec.paused)?.length) notes.push('paused')
  if (!latest) { if (last) notes.push('reading_stale'); else if (minted) notes.push('no_readings') }
  else {
    if (now - Date.parse(latest.observed_at) > READING_STALE_S * 1000) notes.push('reading_stale')
    if (latest.premium == null && NO_DEX_PRICE.has(latest.premium_refused)) notes.push('no_dex_price')
    if (latest.premium_refused === 'reference_spread_wide') notes.push('reference_spread_wide')
    // The chain and an aggregator priced the deepest pool more than 2% apart: there is a price (the chain's) and no premium.
    if (latest.premium_refused === 'sources_disagree') notes.push('sources_disagree')
    if (latest.pools?.capped) notes.push('pools_capped')
  }
  const pending = latest ? latest.multiplier_pending : rec.multiplier_pending
  if (pending != null && pending !== (latest ? latest.multiplier : rec.multiplier)) notes.push('multiplier_change_pending')

  const inWindow = own.filter((r) => Date.parse(r.observed_at) >= from)
  const bySession = {}
  for (const r of inWindow) {
    const g = SESSION_GROUP[usEquitySession(Date.parse(r.observed_at)).session]
    ;(bySession[g] ||= []).push(r.premium)
  }
  const series = {
    window_h: windowH,
    readings: inWindow.length,
    with_premium: inWindow.filter((r) => r.premium != null).length,
    first_at: inWindow[0]?.observed_at ?? null,
    premium_all: stats(inWindow.map((r) => r.premium)),
    premium_by_session: Object.fromEntries(Object.entries(bySession).map(([g, xs]) => [g, stats(xs)])),
  }

  return {
    ...base,
    in_registry: true,
    resembles: null,
    issuer: {
      name: rec.issuer, symbol: rec.symbol, token_name: rec.name ?? null, isin: rec.isin, minted: mintedOf(rec),
      multiplier: latest ? latest.multiplier : rec.multiplier, multiplier_pending: pending ?? null,
      paused: latest ? latest.paused : rec.paused,
      rights: 'set by the issuer\'s prospectus, not by the token contract',
    },
    identity: { symbol: identity.symbol ?? rec.symbol, name: identity.name ?? rec.name ?? null },
    reference: ref ? { kind: ref.kind, price_usd: ref.price_usd, updated_at: ref.updated_at, age_s: refAge, halted: ref.halted, bid: ref.bid ?? null, ask: ref.ask ?? null, spread: ref.spread ?? null } : null,
    latest: latest ? {
      observed_at: latest.observed_at, dex_price_usd: latest.dex_price_usd, dex_pool: latest.dex_pool,
      premium: latest.premium, premium_refused: latest.premium_refused, dex_inside_quote: latest.dex_inside_quote ?? null,
      // What the DEX price rests on (scripts/stocks/stock-peg.mjs priceEvidence): the pool read at a block, or evidence:
      // none. A row recorded before the chain was read has no field, and says none rather than nothing.
      price_evidence: latest.price_evidence ?? (latest.dex_price_usd != null ? { evidence: 'none' } : null),
      reference_evidence: latest.reference_evidence ?? 'issuer_api_not_reproducible',
      age_s: Math.round((now - Date.parse(latest.observed_at)) / 1000),
      cadence_s: RECORDER_CADENCE_S,
      // The premium as of the reference's own time: the first reading at or after the reference was last updated, so both
      // prices are of one moment. Null when that moment is outside the window or there is no reading since.
      premium_at_reference_time: premiumAt(inWindow, ref && ref.updated_at),
      pools: { seen: latest.pools.seen, eligible: latest.pools.eligible, capped: latest.pools.capped, top: latest.pools.top },
    } : null,
    series,
    notes,
  }
}
