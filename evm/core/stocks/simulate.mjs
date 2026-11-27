// evm/core/stocks/simulate.mjs: the answer of simulate_buy (docs/simulate-buy-tz.md), assembled from what the
// orchestration (apps/stocks-simulate.mjs) read: the verdict, the passport, the quotes, the wallet's dry run.
//
// Pure, like passport.mjs: it fetches nothing, writes nothing and reads no clock but the `now` it is handed.
//
// ⚠ FACTS, NOT ADVICE. There is no outcome meaning "go". `premium_check.within` compares the caller's own number (or the
//   default) with a premium we measured, both ways, and says which. No word of ours says buy, sell, safe or should (§7);
//   a test reads every lead for them.
// ⚠ TEXT WE DO NOT CONTROL NEVER ENTERS THE SENTENCE. A look-alike's symbol and name, the caller's ticker, a revert
//   reason, an aggregator's pool labels: each stays in the JSON as data, labelled, and the lead names only the issuer's
//   own symbol, our own reason codes and numbers we computed.
// ⚠ FAIL CLOSED ON THE VERDICT, OPEN TO "unknown" AFTER IT. A refused token is assembled without a quote (the
//   orchestration never asks for one); anything after the verdict that could not be read is `unknown` with a reason
//   from a fixed enum, never a made-up number.

import { usEquitySession } from './market-session.mjs'
import { MAX_REFERENCE_SPREAD, MAX_PLAUSIBLE_RATIO } from './peg.mjs'
import { READING_STALE_S } from './passport.mjs'
import { UNTRUSTED_TEXT_NOTE } from './untrusted-text.mjs'

/** Rate-limit units of one call: a passport's work plus the outside calls (docs/simulate-buy-tz.md §5.4). */
export const SIMULATE_UNITS = 10
export const SIMULATE_WALLET_UNITS = 15
/** How long a quote is treated as current, and served again from the cache for the same question. */
export const QUOTE_TTL_S = 15
/** The same 0.5% as the guard example's SLIPPAGE_BPS (packages/proofofstock-guard/examples/agent-buy.mjs). */
export const DEFAULT_SLIPPAGE_BPS = 50
/** The same 3% as the guard example and /demo (owner, 27.11). */
export const DEFAULT_MAX_PREMIUM = 0.03
export const USD_MIN = 1
export const USD_MAX = 1_000_000
export const SLIPPAGE_MIN = 1
export const SLIPPAGE_MAX = 500
export const MAX_PREMIUM_MAX = 0.5
export const DISCLAIMER = 'It is not investment advice.'
export const KEY_WARNING = 'that looks like a private key; never send one anywhere'
export const WALLET_IN_URL = 'send the wallet in a POST body; a URL is written to the web server\'s log'

// ── The enums, held equal to schemas/v2/simulate.schema.json by evm/core/stocks/simulate.test.mjs ──────────────────
export const OUTCOMES = Object.freeze(['quoted', 'checked', 'refused'])
export const REFUSALS = Object.freeze(['impostor', 'not_listed', 'not_minted', 'paused', 'paused_unknown', 'ticker_not_exact', 'ticker_ambiguous'])
export const QUOTE_RESULTS = Object.freeze(['ok', 'no_route', 'unknown'])
export const QUOTE_SOURCES = Object.freeze(['aerodrome', 'kyberswap'])
export const QUOTE_REASONS = Object.freeze(['aggregator_unavailable', 'aggregator_busy', 'quote_mismatch', 'quote_empty', 'quoter_mismatch', 'venue_unconfirmed', 'rpc_unavailable', 'decimals_unavailable', 'no_buy_quote', 'timed_out'])
/** What `quote.gas` covers: the Quoter's estimate of the pool's own swap (not the router, not the L1 data fee), or the
 * aggregator's own estimate of its route. */
export const GAS_BASES = Object.freeze(['pool_swap_only', 'aggregator_estimate'])
export const PREMIUM_REFUSALS = Object.freeze(['no_reference', 'reference_spread_wide', 'implausible_vs_reference', 'no_quote'])
export const WITHIN_REFUSALS = Object.freeze(['reference_age_unknown', 'reference_held', 'no_premium'])
export const IMPACT_REFUSALS = Object.freeze(['mid_stale', 'no_mid', 'no_quote'])
export const SIM_RESULTS = Object.freeze(['would_succeed', 'would_revert', 'unknown'])
export const SIM_REASONS = Object.freeze(['no_quote', 'build_failed', 'router_not_allowed', 'rpc_unavailable', 'block_unavailable', 'rpc_gas_cap', 'override_unverified', 'override_suspect', 'revert_empty', 'return_undecodable', 'below_min_out', 'estimate_disagrees', 'revert_unattributed', 'no_probe_pool', 'build_unverified', 'build_mismatch', 'aggregator_busy', 'timed_out', 'debit_unverified', 'transfer_mismatch', 'deadline_passed'])
export const REVERT_KINDS = Object.freeze(['token_rule', 'stable_blocklist', 'min_out'])
export const PROBES = Object.freeze(['stable', 'token'])
export const OVERRIDES = Object.freeze(['stable_balance', 'stable_allowance', 'native_balance'])
/** The passport's notes that matter to a buyer, and our own minted_unknown (§5.8). */
export const CONTEXT_NOTES = Object.freeze(['reference_held_market_closed', 'reference_held_market_open', 'trading_halted', 'multiplier_change_pending', 'reference_spread_wide', 'minted_unknown'])

/** The words no sentence of ours carries (§7). "simulate_buy", "a buy of $X" and "sell-back" are the allowed uses. */
export const BANNED_WORDS = /\b(buy|buying|sell|selling|safe|unsafe|good|bad|cheap|expensive|deal|opportunity|recommend|recommended|should|arbitrage|profit)\b|go through|go ahead/i
/** A lead with its allowed uses taken out, for the banned-word test. */
export const withoutAllowed = (s) => String(s).replace(/simulate_buy/g, '').replace(/\ba buy of \$/g, '').replace(/sell-back/g, '')

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TICKER = /^[A-Za-z0-9.-]{1,16}$/
const KEYLIKE = /^(0x)?[0-9a-fA-F]{64}$/
const CHAINS = Object.freeze({ base: { name: 'Base', stable: 'USDC' }, robinhood: { name: 'Robinhood Chain', stable: 'USDG' } })
const ISSUER = Object.freeze({ coinbase: 'Coinbase', robinhood: 'Robinhood' })
const ISSUER_OF_CHAIN = Object.freeze({ base: 'coinbase', robinhood: 'robinhood' })
const FIELDS = new Set(['chain', 'token', 'usd', 'slippage_bps', 'max_premium', 'wallet'])

/** Any string field shaped like a private key (64 hex digits): refused, and the value is never echoed. */
export function looksLikeKey (args) {
  if (!args || typeof args !== 'object') return false
  return Object.values(args).some((v) => typeof v === 'string' && KEYLIKE.test(v.trim()))
}

/**
 * The caller's arguments, checked (§1). `raw` is an MCP arguments object or an HTTP query or body; over HTTP numbers may
 * arrive as strings (a query has no other kind), which `fromText` allows and parses strictly. Returns { input } or
 * { error } in words; an error never echoes a value.
 */
export function parseInput (raw, { fromText = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the arguments must be an object' }
  if (looksLikeKey(raw)) return { error: KEY_WARNING }
  for (const k of Object.keys(raw)) if (!FIELDS.has(k)) return { error: `unknown argument ${String(k).slice(0, 40)}` }
  const num = (v, re) => (typeof v === 'number' ? v : fromText && typeof v === 'string' && re.test(v.trim()) ? Number(v.trim()) : NaN)
  const { chain, token } = raw
  if (!CHAINS[chain]) return { error: 'chain must be one of base, robinhood' }
  if (typeof token !== 'string' || !(ADDRESS.test(token) || TICKER.test(token))) return { error: 'token must be a contract address (0x and 40 hex digits) or a ticker (1 to 16 letters, digits, dots or dashes)' }
  const usd = num(raw.usd, /^\d{1,7}(\.\d{1,2})?$/)
  if (raw.usd === undefined) return { error: 'usd is required' }
  if (!Number.isFinite(usd) || usd < USD_MIN || usd > USD_MAX) return { error: `usd must be a number from ${USD_MIN} to ${USD_MAX}` }
  if (Math.abs(usd * 100 - Math.round(usd * 100)) > 1e-6) return { error: 'usd takes at most 2 decimals' }
  let slippageBps = DEFAULT_SLIPPAGE_BPS
  if (raw.slippage_bps !== undefined) {
    slippageBps = num(raw.slippage_bps, /^\d{1,3}$/)
    if (!Number.isInteger(slippageBps) || slippageBps < SLIPPAGE_MIN || slippageBps > SLIPPAGE_MAX) return { error: `slippage_bps must be a whole number from ${SLIPPAGE_MIN} to ${SLIPPAGE_MAX}` }
  }
  let maxPremium = DEFAULT_MAX_PREMIUM, limitSource = 'default'
  if (raw.max_premium !== undefined) {
    maxPremium = num(raw.max_premium, /^\d(\.\d{1,6})?$/)
    if (!Number.isFinite(maxPremium) || maxPremium < 0 || maxPremium > MAX_PREMIUM_MAX) return { error: `max_premium must be a number from 0 to ${MAX_PREMIUM_MAX}` }
    limitSource = 'caller'
  }
  let wallet = null
  if (raw.wallet !== undefined) {
    if (typeof raw.wallet !== 'string' || !ADDRESS.test(raw.wallet)) return { error: 'wallet must be a public address, 0x and 40 hex digits' }
    wallet = raw.wallet.toLowerCase()
  }
  return { input: { chain, token: ADDRESS.test(token) ? token.toLowerCase() : token, byAddress: ADDRESS.test(token), usd: Math.round(usd * 100) / 100, slippageBps, maxPremium, limitSource, wallet } }
}

/** The units a call costs, by whether it carries a wallet. */
export const unitsOf = (args) => (args && typeof args === 'object' && args.wallet != null ? SIMULATE_WALLET_UNITS : SIMULATE_UNITS)

/**
 * The token a ticker names on one chain: the exact matches of the trusted records and of the records the list locks
 * hold, taken together, as find_stock_token matches them (an ISIN, a bare ticker for Coinbase's "c" name). One exact
 * match is { address, held }; none is ticker_not_exact, several ticker_ambiguous, with the candidates. A held record is
 * never dropped for a trusted one that matches the same words: that would quote a token the caller did not mean.
 */
export function resolveTicker (found, chain) {
  let trusted = found?.match === 'exact' && Array.isArray(found.matches) ? found.matches.filter((m) => m && m.chain === chain) : []
  let held = Array.isArray(found?.held) ? found.held.filter((h) => h && h.chain === chain && h.match_quality === 'exact') : []
  // One rule for both sides: a literal match (the symbol or ISIN as written) wins over one found only by stripping
  // Coinbase's trailing "c". Trusted ABCC beside held ABC: ABCC is quoted. Held NEWc beside trusted NEW: NEWc's 503.
  const trustedStripped = Boolean(found?.query_normalized), literal = held.filter((h) => !h.normalized)
  if (trustedStripped && literal.length) trusted = []
  else if (!trustedStripped && trusted.length) held = literal
  const fuzzy = Array.isArray(found?.matches) ? found.matches.filter((m) => m && m.chain === chain) : []
  const candidates = [...trusted, ...held, ...(trusted.length || held.length ? [] : fuzzy)].slice(0, 10).map((m) => ({ symbol: m.symbol ?? null, address: m.address, match_quality: m.match_quality ?? null, ...(m.reason ? { held: m.reason } : {}) }))
  const exact = trusted.length + held.length
  if (!exact) return { refusal: 'ticker_not_exact', candidates }
  if (exact > 1) return { refusal: 'ticker_ambiguous', candidates }
  return trusted.length ? { address: String(trusted[0].address).toLowerCase() } : { address: String(held[0].address).toLowerCase(), held: true }
}

/**
 * What stops the flow before any outside call (§2 steps 3 and 4), from the verify body and the passport. Null when the
 * flow goes on. Only minted === false refuses: Robinhood reports no supply, so its records are minted: null.
 * `current` is the issuer's record in the verified snapshot ({ paused }): the pause is read from there, never from the
 * passport's latest reading, which may be up to a day old. Without it the passport's own record is used.
 */
export function refusalOf (verify, passport, current = null) {
  if (!verify || !verify.listed) return verify && verify.impostor ? 'impostor' : 'not_listed'
  const issuer = passport && passport.issuer
  if (!issuer) return 'not_listed'
  if (issuer.minted === false) return 'not_minted'
  const paused = current ? current.paused : issuer.paused
  if (!Array.isArray(paused)) return 'paused_unknown'
  if (paused.length) return 'paused'
  return null
}

/** The least the swap may deliver at the slippage: amountOut × (1 − bps / 10,000), rounded down, in base units. */
export function minReceived (amountOut, slippageBps) {
  const a = BigInt(amountOut)
  return (a * BigInt(10_000 - slippageBps)) / 10_000n
}

/** |premium| <= limit: a discount past the limit is outside it too (agent-buy.mjs's Math.abs rule). */
export const withinLimit = (premium, limit) => Math.abs(premium) <= limit

/**
 * A number as an exact fraction [numerator, denominator] of bigints, from its shortest decimal spelling, exponent
 * included (1e-7, 2.5e+21); null for anything negative or not finite.
 */
export const fracOf = (x) => {
  const s = typeof x === 'number' && Number.isFinite(x) && x >= 0 ? String(x) : ''
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(s)
  if (!m) return null
  const f = m[2] || '', e = Number(m[3] || 0) - f.length
  const n = BigInt(m[1] + f)
  return e >= 0 ? [n * 10n ** BigInt(e), 1n] : [n, 10n ** BigInt(-e)]
}
/**
 * The same comparison in exact arithmetic, from the amounts themselves: |price / reference - 1| <= limit, where price is
 * usd / (amountOut / 10^decimals). Both ways round, the edge included. Floating point puts $103 for one token against a
 * $100 reference at 0.030000000000000027 and would call it outside a 3% limit; this does not. Null when a number has
 * no plain decimal spelling (the float comparison is then used).
 */
export function withinExact ({ usd, amountOut, decimals, reference, limit }) {
  const u = fracOf(usd), r = fracOf(reference), l = fracOf(limit)
  if (!u || !r || !l || !(r[0] > 0n) || !isUnits(amountOut) || !(BigInt(amountOut) > 0n) || !Number.isInteger(decimals)) return null
  const num = u[0] * 10n ** BigInt(decimals) * r[1] // the ratio is num / den
  const den = u[1] * BigInt(amountOut) * r[0]
  const lower = (l[1] - l[0]) * den, upper = (l[1] + l[0]) * den, mid = num * l[1]
  return lower <= mid && mid <= upper
}

const isUnits = (s) => typeof s === 'string' && /^\d{1,78}$/.test(s)
const human = (units, dec) => Number(BigInt(units)) / 10 ** dec
const spreadWide = (ref) => {
  const s = ref && typeof ref.spread === 'number' ? ref.spread : null
  const crossed = ref && ref.bid > 0 && ref.ask > 0 && ref.bid > ref.ask
  return crossed || (s != null && (s < 0 || s > MAX_REFERENCE_SPREAD))
}

/** The premium block from the effective price and the passport (§3.3). */
export function premiumOf (effectivePrice, passport, now) {
  const ref = passport?.reference || null
  const latest = passport?.latest || null
  const out = { reference_usd: ref && ref.price_usd > 0 ? ref.price_usd : null, reference_kind: ref ? ref.kind ?? null : null, reference_age_s: ref ? ref.age_s ?? null : null,
    effective_premium: null, mid_premium: latest ? latest.premium ?? null : null, mid_age_s: latest ? latest.age_s ?? null : null, price_impact: null }
  if (!(effectivePrice > 0)) return { ...out, premium_refused: 'no_quote', price_impact_refused: 'no_quote' }
  // The reference is in token units, as the issuer gives it: no multiplier is applied (peg.mjs's rule).
  if (!(out.reference_usd > 0)) out.premium_refused = 'no_reference'
  else if (spreadWide(ref)) out.premium_refused = 'reference_spread_wide'
  else {
    const ratio = effectivePrice / out.reference_usd
    if (!(ratio > 0) || ratio > MAX_PLAUSIBLE_RATIO || ratio < 1 / MAX_PLAUSIBLE_RATIO) out.premium_refused = 'implausible_vs_reference'
    else out.effective_premium = ratio - 1
  }
  // Our price impact is against the recorder's mid from an eligible pool, only while that mid is current.
  const midOk = latest && latest.dex_price_usd > 0 && (latest.pools?.eligible ?? 0) > 0 && !['implausible_vs_reference', 'sources_disagree', 'no_eligible_pool', 'no_pairs', 'pairs_unavailable'].includes(latest.premium_refused)
  if (!midOk) out.price_impact_refused = 'no_mid'
  else if (!(latest.age_s <= READING_STALE_S)) out.price_impact_refused = 'mid_stale'
  else out.price_impact = effectivePrice / latest.dex_price_usd - 1
  return out
}

/** The comparison with the caller's limit (or ours), and why there is none when there is none. */
export function premiumCheckOf (premium, { limit, limitSource }, notes, exact = null) {
  const o = { limit, limit_source: limitSource, within: null }
  if (premium.effective_premium == null) return { ...o, within_refused: 'no_premium' }
  if (notes.includes('reference_held_market_closed') || notes.includes('reference_held_market_open')) return { ...o, within_refused: 'reference_held' }
  if (premium.reference_age_s == null) return { ...o, within_refused: 'reference_age_unknown' }
  // Exact arithmetic only, for any limit: a comparison that cannot be made exactly is not made.
  const x = exact ? withinExact({ ...exact, reference: premium.reference_usd, limit }) : null
  return x == null ? { ...o, within_refused: 'no_premium' } : { ...o, within: x }
}

/** The context block (§5.8). */
export function contextOf (passport, now, { mintedUnknown = false } = {}) {
  const s = passport?.market_now || usEquitySession(now)
  const ref = passport?.reference || null
  const notes = (passport?.notes || []).filter((n) => CONTEXT_NOTES.includes(n))
  if (ref && spreadWide(ref) && !notes.includes('reference_spread_wide')) notes.push('reference_spread_wide')
  if (mintedUnknown) notes.push('minted_unknown')
  const held = notes.includes('reference_held_market_closed') || notes.includes('reference_held_market_open')
  return {
    market: { session: s.session, reason: s.reason ?? null, holiday: s.holiday ?? null, early_close: s.early_close ?? null },
    reference: ref ? { kind: ref.kind ?? null, price_usd: ref.price_usd ?? null, updated_at: ref.updated_at ?? null, age_s: ref.age_s ?? null, held, halted: ref.halted === true, bid: ref.bid ?? null, ask: ref.ask ?? null, spread: ref.spread ?? null } : null,
    notes,
    liquidity: passport?.latest?.liquidity ?? null,
  }
}

/** A quote adapter's answer as the `quote` block: amounts in base units become numbers here, and only here. */
function quoteBlock (q, { decimals, usd, slippageBps, now }) {
  const head = { result: q?.result || 'unknown', source: q?.source ?? null }
  const t = q?.quotedAt ?? null
  const age = t != null ? Math.max(0, Math.round((now - t) / 1000)) : null
  const times = { quoted_at: t != null ? new Date(t).toISOString() : null, age_s: age, valid_for_s: age != null ? Math.max(0, QUOTE_TTL_S - age) : null, cached: Boolean(q?.cached) }
  const empty = { tokens_out: null, tokens_out_base_units: null, decimals: Number.isInteger(decimals) ? decimals : null, effective_price_usd: null, min_received: null, min_received_base_units: null, slippage_bps: slippageBps, gas: { units: null, usd: null, basis: null }, route: q?.route ?? null }
  if (head.result !== 'ok') return { ...head, ...(head.result === 'unknown' ? { reason: q?.reason || 'aggregator_unavailable' } : {}), ...times, ...empty }
  // The adapter checked the amounts; this is the last line: no number from guessed decimals, no zero, no NaN price.
  if (!Number.isInteger(decimals)) return { ...head, result: 'unknown', reason: 'decimals_unavailable', ...times, ...empty }
  if (!isUnits(q.amountOut) || !(BigInt(q.amountOut) > 0n)) return { ...head, result: 'unknown', reason: 'quote_empty', ...times, ...empty }
  const tokens = human(q.amountOut, decimals)
  const min = minReceived(q.amountOut, slippageBps)
  return { ...head, ...times, tokens_out: tokens, tokens_out_base_units: q.amountOut, decimals, effective_price_usd: usd / tokens,
    min_received: human(min.toString(), decimals), min_received_base_units: min.toString(), slippage_bps: slippageBps,
    gas: { units: Number.isFinite(q.gasUnits) ? q.gasUnits : null, usd: Number.isFinite(q.gasUsd) ? q.gasUsd : null, basis: GAS_BASES.includes(q.gasBasis) ? q.gasBasis : null }, route: q.route ?? null }
}

function sellBackBlock (s, { stableDecimals, usd, now, buyOk }) {
  if (!buyOk) return { result: 'unknown', reason: 'no_buy_quote', source: null, quoted_at: null, tokens_in_base_units: null, usd_back: null, round_trip_cost: null }
  const head = { result: s?.result || 'unknown', source: s?.source ?? null, quoted_at: s?.quotedAt != null ? new Date(s.quotedAt).toISOString() : null, tokens_in_base_units: s?.amountIn ?? null }
  if (head.result !== 'ok') return { ...head, ...(head.result === 'unknown' ? { reason: s?.reason || 'aggregator_unavailable' } : {}), usd_back: null, round_trip_cost: null }
  if (!isUnits(s.amountOut) || !(BigInt(s.amountOut) > 0n)) return { ...head, result: 'unknown', reason: 'quote_empty', usd_back: null, round_trip_cost: null }
  const back = human(s.amountOut, stableDecimals)
  return { ...head, usd_back: back, round_trip_cost: 1 - back / usd }
}

const short = (a) => (ADDRESS.test(String(a)) ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'the wallet')
const usdWords = (x) => (x == null ? null : x >= 1 ? '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '$' + x.toPrecision(4))
const usd0 = (x) => '$' + Math.round(x).toLocaleString('en-US')
const tokWords = (x) => (x >= 0.0001 ? x.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : x.toPrecision(4))
const pctWords = (x) => (Math.abs(x) * 100).toFixed(2) + '%'
const secsAgo = (s) => (s == null ? 'at an unknown time' : s === 0 ? 'just now' : s === 1 ? '1 second ago' : `${s} seconds ago`)
export function ageWords (s) {
  if (s == null) return 'at an unknown time'
  if (s < 90) return `${s} s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}
const SESSION = Object.freeze({ regular: 'open', pre: 'in pre-market', post: 'in after-hours', closed: 'closed', unknown: 'not known (calendar unknown)' })
const REVERT_WORDS = Object.freeze({
  token_rule: 'the stock token\'s own transfer rule refused the transfer to this wallet',
  stable_blocklist: 'the stable refused this wallet (its blocklist)',
  min_out: 'the route\'s price moved past the slippage between the quote and this run',
})
const OVERRIDE_WORDS = (stable) => ({ stable_balance: `the ${stable}`, stable_allowance: 'the approval', native_balance: 'the gas' })
const list = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])

/** The lead sentence: the verdict, the market and the reference's state before any number, then the numbers (§7). */
export function leadOf (a) {
  const C = CHAINS[a.chain]
  const who = ISSUER[ISSUER_OF_CHAIN[a.chain]]
  const v = a.verdict || {}
  const tail = 'Facts with their time and source, not advice.'
  if (a.outcome === 'refused') {
    const r = v.reason
    if (r === 'ticker_not_exact') return `No issuer-listed token on ${C.name} has exactly that ticker or ISIN; ${(v.candidates || []).length} match by company name or ticker prefix instead (listed in verdict.candidates). Name one by its address. No quote was made.`
    if (r === 'ticker_ambiguous') return `${(v.candidates || []).length} issuer-listed tokens on ${C.name} have exactly that ticker or ISIN (listed in verdict.candidates); none is picked for you. Name one by its address. No quote was made.`
    if (r === 'impostor') {
      const what = v.impostor && v.impostor.imitates_symbol ? `copies ${v.impostor.imitates_symbol}` : `copies the way ${who} names its stock tokens`
      return `${v.address} is not on ${who}'s list on ${C.name} and ${what}; ${v.use_instead ? `the listed contract is ${v.use_instead}` : 'no listed contract is named for it now'}. No quote was made.`
    }
    if (r === 'not_listed') return `${v.address} is not in the ${who} registry on ${C.name} (not necessarily fake: another issuer's token would not be in it either). No quote was made.`
    if (r === 'not_minted') return `${v.symbol} on ${C.name} is on ${who}'s list but not minted on this chain yet, so there is no pool. No quote was made.`
    if (r === 'paused') return `${v.symbol} on ${C.name} is on ${who}'s list and paused by the issuer (verdict.paused), so a swap would revert. No quote was made.`
    return `${v.symbol} on ${C.name} is on ${who}'s list, but whether the issuer has paused it could not be read. No quote was made.`
  }
  const parts = [`${v.symbol} on ${C.name} is on ${who}'s list.`]
  const ctx = a.context || {}
  parts.push(`US market: ${SESSION[ctx.market?.session] || SESSION.unknown}.`)
  if (ctx.reference?.held) parts.push(`${who}'s reference is held from an earlier price (updated ${ageWords(ctx.reference.age_s)}), so the limit is not compared.`)
  if (ctx.notes?.includes('trading_halted')) parts.push('The issuer reports trading in the share as halted.')
  if (ctx.liquidity?.thin) parts.push(`The deepest pool we recorded is thin (${ctx.liquidity.deepest_pool_usd == null ? 'no depth read' : 'about ' + usd0(ctx.liquidity.deepest_pool_usd)}, below the ${usd0(ctx.liquidity.thin_below_usd)} we call thin), so the size moves the price.`)
  const q = a.quote
  const venue = q.source === 'aerodrome' ? 'Aerodrome, one pool' : 'KyberSwap'
  if (a.outcome === 'checked') {
    parts.push(q.result === 'no_route'
      ? `No route was found for ${usdWords(a.amount_in.usd)} of ${C.stable} on ${q.source === 'aerodrome' ? 'Aerodrome\'s pools' : 'the aggregator'}, so there is no price for this size.`
      : `No quote could be read from ${q.source === 'aerodrome' ? 'Aerodrome\'s quoter' : 'the aggregator'} right now (${q.reason}), so there is no price for ${usdWords(a.amount_in.usd)}.`)
  } else {
    const p = a.premium, pc = a.premium_check
    let s = `${usdWords(a.amount_in.usd)} of ${C.stable} would get ${tokWords(q.tokens_out)} ${v.symbol} at an effective ${usdWords(q.effective_price_usd)} each, quoted ${secsAgo(q.age_s)} (${venue})`
    if (p.effective_premium != null) {
      s += `: ${pctWords(p.effective_premium)} ${p.effective_premium >= 0 ? 'above' : 'below'} ${who}'s reference of ${usdWords(p.reference_usd)} (updated ${ageWords(p.reference_age_s)})`
      const lim = `the ${pctWords(pc.limit)} ${pc.limit_source === 'caller' ? 'limit you gave' : 'default limit'}`
      s += pc.within === true ? `, within ${lim}.` : pc.within === false ? `, outside ${lim}.` : `; it is not compared with ${lim} (${pc.within_refused}).`
    } else s += `; no premium over ${who}'s reference is computed (${p.premium_refused}).`
    parts.push(s)
    const sb = a.sell_back
    parts.push(sb.result === 'ok' ? `The sell-back of those tokens, quoted now, returns ${usdWords(sb.usd_back)}.` : sb.result === 'no_route' ? 'No route was found for the sell-back of those tokens.' : `No sell-back quote could be read (${sb.reason}).`)
  }
  const k = a.venues?.kyberswap
  if (k) parts.push(k.result === 'ok' ? `KyberSwap, across venues, quotes ${tokWords(k.tokens_out)} ${v.symbol} for the same amount${k.same_route ? ', through the same pool' : ''}.` : `KyberSwap's line could not be read (${k.result === 'no_route' ? 'no route' : k.reason}).`)
  const sim = a.simulation
  if (sim) {
    const w = short(sim.wallet)
    const words = OVERRIDE_WORDS(C.stable)
    const lacks = (sim.simulated_with || []).map((x) => words[x])
    const at = sim.head_block != null ? ` at block ${sim.head_block}` : ''
    if (sim.result === 'would_succeed') parts.push(lacks.length ? `As ${w} stands it lacks ${list(lacks)}; with ${lacks.length === 1 ? 'that' : 'those'} supplied, the simulated swap did not revert${at}.` : `The simulated swap from ${w} did not revert${at}.`)
    else if (sim.result === 'would_revert') parts.push(`${lacks.length ? `As ${w} stands it lacks ${list(lacks)}; with ${lacks.length === 1 ? 'that' : 'those'} supplied, the` : `The`} simulated swap from ${w} reverted${at}: ${REVERT_WORDS[sim.revert?.kind] || 'for a reason we could not attribute'}.`)
    else parts.push(`The simulated swap from ${w} could not be judged (${sim.reason}).`)
  }
  parts.push(tail)
  return parts.join(' ')
}

/**
 * The whole answer. Every input is what the orchestration read; nothing here fetches.
 * @param {object} o
 * @param {object} o.input          parseInput's input
 * @param {object} [o.verify]       the verify body, as verify_stock_tokens returns it (null for a ticker refusal)
 * @param {object} [o.listProof]    data.listProof(chain, snapshot)
 * @param {object} [o.passport]     the passport body (listed tokens only)
 * @param {object} [o.current]      the issuer's record in the verified snapshot ({ paused }), for the pause
 * @param {string} [o.refusal]      a refusal reason (refusalOf or resolveTicker)
 * @param {object[]} [o.candidates] a ticker refusal's candidates
 * @param {string} [o.query]        the caller's token as given (data, never in the sentence)
 * @param {object} [o.quote]        the primary quote adapter's answer
 * @param {object} [o.sellBack]     the sell-back's
 * @param {object} [o.second]       KyberSwap's line on Base
 * @param {object} [o.simulation]   sim-evm's block, or null without a wallet
 * @param {object} o.stable         { symbol, address, decimals }
 * @param {number|null} [o.decimals] the token's decimals as read from the chain
 * @param {object} [o.links]        { passport, docs, aerodrome }
 * @param {number} o.now
 */
export function assemble ({ input, verify = null, listProof = null, passport = null, current = null, refusal = null, candidates = null, query = null, quote = null, sellBack = null, second = null, simulation = null, stable, decimals = null, links = {}, now }) {
  const base = { summary: '', outcome: 'refused', generated_at: new Date(now).toISOString(), chain: input.chain, not_trading_signal: true, disclaimer: DISCLAIMER, query: query ?? input.token }
  const amountIn = { usd: input.usd, asset: stable.symbol, address: stable.address, base_units: BigInt(Math.round(input.usd * 100)) * 10n ** BigInt(stable.decimals) / 100n + '', stable_assumed_usd: 1 }
  const verdict = verify
    ? { ...verify, use_instead: verify.impostor && verify.impostor.listed_address ? verify.impostor.listed_address : null, list_proof: listProof ?? null }
    : { listed: null, address: null, symbol: null, impostor: null, use_instead: null, list_proof: listProof ?? null }
  if (verify && verify.impostor) verdict.untrusted_text = UNTRUSTED_TEXT_NOTE
  const why = refusal || refusalOf(verify, passport, current)
  if (why) {
    // A refusal is assembled without a quote, whatever the caller handed in: a look-alike is never priced (§0.1).
    const a = { ...base, outcome: 'refused', verdict: { ...verdict, reason: why, ...(candidates ? { candidates } : {}), ...(why === 'paused' ? { paused: (current || passport.issuer).paused } : {}) },
      amount_in: amountIn, quote: null, premium: null, premium_check: null, sell_back: null, venues: null,
      context: contextOf(passport, now), links: { passport: links.passport ?? null, docs: links.docs ?? null } }
    a.summary = leadOf(a)
    return a
  }
  const mintedUnknown = passport.issuer.minted == null
  const context = contextOf(passport, now, { mintedUnknown })
  const q = quoteBlock(quote, { decimals, usd: input.usd, slippageBps: input.slippageBps, now })
  const ok = q.result === 'ok'
  const premium = premiumOf(ok ? q.effective_price_usd : null, passport, now)
  const premiumCheck = premiumCheckOf(premium, { limit: input.maxPremium, limitSource: input.limitSource }, context.notes, ok ? { usd: input.usd, amountOut: q.tokens_out_base_units, decimals } : null)
  const sb = sellBackBlock(sellBack, { stableDecimals: stable.decimals, usd: input.usd, now, buyOk: ok })
  const venues = {}
  if (links.aerodrome) venues.aerodrome = { link: links.aerodrome }
  if (second) {
    const k = quoteBlock(second, { decimals, usd: input.usd, slippageBps: input.slippageBps, now })
    venues.kyberswap = { result: k.result, ...(k.reason ? { reason: k.reason } : {}), quoted_at: k.quoted_at, cached: k.cached, tokens_out: k.tokens_out, tokens_out_base_units: k.tokens_out_base_units,
      effective_price_usd: k.effective_price_usd, more_than_primary: ok && k.result === 'ok' ? (BigInt(k.tokens_out_base_units) > BigInt(q.tokens_out_base_units) ? true : BigInt(k.tokens_out_base_units) < BigInt(q.tokens_out_base_units) ? false : null) : null,
      same_route: Boolean(second.samePool), gas: k.gas, route: k.route, untrusted_text: UNTRUSTED_TEXT_NOTE }
  }
  const a = { ...base, outcome: ok ? 'quoted' : 'checked', verdict, amount_in: amountIn, quote: { ...q, ...(q.route ? { untrusted_text: UNTRUSTED_TEXT_NOTE } : {}) }, premium, premium_check: premiumCheck, sell_back: sb, venues,
    ...(simulation ? { simulation } : {}), context, links: { passport: links.passport ?? null, docs: links.docs ?? null } }
  a.summary = leadOf(a)
  return a
}
