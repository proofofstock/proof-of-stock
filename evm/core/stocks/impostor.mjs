// evm/core/stocks/impostor.mjs: does a token that is NOT in its chain's issuer registry present itself as one that is?
//
// Pure. The registry decides identity (an exact contract address); a name never does. What a name CAN do is claim an
// identity, and a token that claims one it does not have is the case a holder most needs flagged, so this module
// only ever answers for tokens outside the registry, and only says what the name resembles and how strongly.
//
// Strength, strongest first:
//   registry_symbol      the symbol is, character for character, a registry token's symbol on this chain, AND that
//                        symbol is distinctive: it is not just the bare ticker (Coinbase's `NVDAc`, not Robinhood's `GME`)
//   issuer_name_suffix   the name ends the way the issuer names its tokens ("… Robinhood Token")
//   ticker               the symbol equals a registry ticker ignoring case (`NVDA`, `nvda`). WEAK: plenty of memecoins
//                        borrow a ticker without pretending to be the share, so this is a resemblance, not a claim.
//
// ⚠ A RESEMBLANCE IS NOT A VERDICT. The row says what the name looks like; it does not say the token is a scam, and it
// does not change the token's class (it stays a memecoin unless something else says otherwise).

import { normalizeUntrusted } from './untrusted-text.mjs'

export const RESEMBLANCE_KINDS = Object.freeze(['registry_symbol', 'issuer_name_suffix', 'ticker'])

// Robinhood's own convention for its stock tokens' names (see evm/core/screener/equity-filter.mjs, where it was found).
const ROBINHOOD_NAME = /\S\s+robinhood\s+token\s*$/i

/** The ticker a registry symbol stands for: Coinbase appends a lower-case `c` (NVDAc → NVDA); Robinhood does not. */
export function tickerOf (rec) {
  const s = typeof rec?.symbol === 'string' ? rec.symbol : ''
  return rec?.issuer === 'coinbase' && /^[A-Z0-9.]+c$/.test(s) ? s.slice(0, -1) : s
}

/**
 * @param identity  { address, symbol, name } of the token being checked
 * @param registry  issuer records for the SAME chain (evm/core/stocks/registries.mjs)
 * @returns null when the token is in the registry or resembles nothing; else { kind, ticker, registry_symbol, registry_address }
 */
export function resemblance (identity, registry) {
  const addr = typeof identity?.address === 'string' ? identity.address.toLowerCase() : null
  const recs = Array.isArray(registry) ? registry : []
  if (!addr || recs.some((r) => r.address === addr)) return null
  return nameHits(identity, recs)[0] || null
}

/**
 * Every name kind the identity matches, strongest first (RESEMBLANCE_KINDS order). The ONE place the name rules live:
 * resemblance() takes the first, resemblances() takes them all. The caller has already excluded registry addresses.
 */
function nameHits (identity, recs) {
  // Compared as one visible line (untrusted-text.mjs): an invisible character or a full-width letter in the symbol was a
  // way past the exact comparison. No length cut here: the naming rule reads the END of the name.
  const sym = normalizeUntrusted(identity.symbol)
  const name = normalizeUntrusted(identity.name)
  const hit = (kind, r) => ({ kind, ticker: tickerOf(r), registry_symbol: r.symbol, registry_address: r.address })
  const hits = []
  if (sym) {
    // ⚠ Only a DISTINCTIVE issuer symbol makes the strong claim. Robinhood names its tokens with the bare ticker
    // (GME, COIN, F, BULL), and on its chain thousands of memecoins carry those same letters: measured, the strong
    // grade without this condition took in borrowed tickers by the thousand. Those fall through to `ticker`.
    const exact = recs.find((r) => r.symbol === sym && tickerOf(r) !== r.symbol)
    if (exact) hits.push(hit('registry_symbol', exact))
  }
  // ⚠ Never fewer cases than before: the name as written is tested too. A stem made only of invisible characters
  //   satisfied the rule's \S until normalization removed it, and a case that stops matching is closed as gone.
  const asWritten = typeof identity.name === 'string' ? identity.name : ''
  if ((ROBINHOOD_NAME.test(name) || ROBINHOOD_NAME.test(asWritten)) && recs.some((r) => r.issuer === 'robinhood')) {
    const stem = name.replace(/\s+robinhood\s+token\s*$/i, '').trim().toLowerCase()
    const r = recs.find((x) => x.issuer === 'robinhood' && (tickerOf(x).toLowerCase() === sym.toLowerCase() || (x.name && normalizeUntrusted(x.name).toLowerCase().startsWith(stem))))
    hits.push({ kind: 'issuer_name_suffix', ticker: r ? tickerOf(r) : null, registry_symbol: r ? r.symbol : null, registry_address: r ? r.address : null })
  }
  if (sym) {
    const t = recs.find((r) => tickerOf(r).toLowerCase() === sym.toLowerCase())
    if (t) hits.push(hit('ticker', t))
  }
  return hits
}

// ── W2-static: every kind at once, and three address-level signals (docs/stocks-truth-layer-tz.md §W2) ─────────────────
//
// `resemblance()` above is the PUBLISHED answer (the site, /verify and the impostor list decide by it) and stays as it
// is. `resemblances()` below is the radar's internal answer: it returns every kind that fires, the name kinds in the
// order `resemblance()` ranks them and then the address kinds. ⚠ The address kinds are INTERNAL until their precision
// is measured (§W2c): nothing public may read them before that.
//
//   vanity_prefix_partial  Base only. The address starts `0xb2` + k zero hex digits, VANITY_MIN_ZEROS ≤ k <
//                          FULL_PREFIX_ZEROS, and is not listed. Every Coinbase-listed Base address carries `0xb2` +
//                          ≥ 20 zeros; a random address carries `0xb2` + k zeros with probability 16^-(2+k), so at k = 4
//                          a chance match is about 1 in 16^6: someone ground a vanity address to look like the issuer's.
//   unlisted_full_prefix   Base only. `0xb2` + ≥ FULL_PREFIX_ZEROS zeros and not listed. Forging that is ~2^88 work, so
//                          this is most likely a fresh Coinbase deploy the registry has not published yet. It is NEVER an
//                          impostor kind (NEVER_IMPOSTOR_KINDS): it means "look again when the registry refreshes".
//   address_lookalike      the address equals a listed address in the characters a wallet shows, while the middle
//                          differs. Per chain (LOOKALIKE_RULES): Robinhood compares the first 6 and the last 4 hex after
//                          0x. On Base every listed address shares the head `b20000…`, so the head carries no information
//                          and the rule is the last 6 hex alone. ⚠ HYPOTHESIS: tail-6 is an unmeasured threshold. A
//                          random address matches one listed tail with probability 16^-6, times the registry size times
//                          the tokens scanned, so chance hits are expected; W2c measures its precision before anyone
//                          sees it.
//
// Self-check (prefixSelfCheck): the prefix signals rest on an observed fact about Coinbase's deploys, not on a rule
// anyone published. If ANY Coinbase registry address lacks the full prefix, the fact no longer holds: both prefix
// signals switch off and the result says so (`prefix_check.active === false`, with the reason), so a caller can raise
// the alarm instead of flagging on a dead pattern. An empty Coinbase registry also switches them off: nothing to check.
//
// Invariant shared by all of them: a registry address is never flagged. A listed token gets no hit at all.

export const ADDRESS_SIGNAL_KINDS = Object.freeze(['address_lookalike', 'vanity_prefix_partial', 'unlisted_full_prefix'])
/** Kinds that are counted and recorded but must never make a token an impostor. */
export const NEVER_IMPOSTOR_KINDS = Object.freeze(['ticker', 'unlisted_full_prefix'])
export const VANITY_HEAD = 'b2'
export const VANITY_MIN_ZEROS = 4
export const FULL_PREFIX_ZEROS = 20
/** Characters a wallet shows, per chain: `head` hex after 0x and `tail` hex at the end must equal a listed address's. */
export const LOOKALIKE_RULES = Object.freeze({
  robinhood: Object.freeze({ head: 6, tail: 4 }),
  base: Object.freeze({ head: 0, tail: 6 }), // ⚠ hypothesis, measured in W2c
})

const HEX40 = /^0x[0-9a-f]{40}$/
const ISSUER_CHAIN = { coinbase: 'base', robinhood: 'robinhood' }

/** The chain a registry belongs to, from its issuer; null when it cannot be told. */
export function chainOfRegistry (registry) {
  const recs = Array.isArray(registry) ? registry : []
  const chains = new Set(recs.map((r) => ISSUER_CHAIN[r?.issuer]).filter(Boolean))
  return chains.size === 1 ? [...chains][0] : null
}

/** k: the number of zero hex digits right after `0xb2`; -1 when the address does not start `0xb2`. */
export function vanityZeros (address) {
  const a = typeof address === 'string' ? address.toLowerCase() : ''
  if (!HEX40.test(a) || !a.startsWith('0x' + VANITY_HEAD)) return -1
  return /^0*/.exec(a.slice(2 + VANITY_HEAD.length))[0].length
}

/**
 * Does Coinbase still deploy on the full prefix? Only Base has the pattern.
 * @returns { active, reason, checked, without_prefix: [addresses] }
 */
export function prefixSelfCheck (registry, chain = chainOfRegistry(registry)) {
  if (chain !== 'base') return { active: false, reason: 'not_applicable', checked: 0, without_prefix: [] }
  const recs = (Array.isArray(registry) ? registry : []).filter((r) => r?.issuer === 'coinbase')
  if (!recs.length) return { active: false, reason: 'empty_registry', checked: 0, without_prefix: [] }
  const without = recs.filter((r) => vanityZeros(r.address) < FULL_PREFIX_ZEROS).map((r) => r.address)
  if (without.length) return { active: false, reason: 'registry_address_without_full_prefix', checked: recs.length, without_prefix: without }
  return { active: true, reason: null, checked: recs.length, without_prefix: [] }
}

/** The listed record `address` imitates in the characters a wallet shows, or null. A listed address never matches. */
export function addressLookalike (address, registry, chain = chainOfRegistry(registry)) {
  const a = typeof address === 'string' ? address.toLowerCase() : ''
  const rule = LOOKALIKE_RULES[chain]
  const recs = Array.isArray(registry) ? registry : []
  if (!rule || !HEX40.test(a) || recs.some((r) => r.address === a)) return null
  const hex = a.slice(2)
  const head = hex.slice(0, rule.head), tail = hex.slice(-rule.tail), middle = hex.slice(rule.head, -rule.tail)
  return recs.find((r) => {
    const h = typeof r?.address === 'string' && HEX40.test(r.address) ? r.address.slice(2) : null
    return h && h.slice(0, rule.head) === head && h.slice(-rule.tail) === tail && h.slice(rule.head, -rule.tail) !== middle
  }) || null
}

/**
 * Every kind the token matches, plus the prefix self-check state.
 * @param identity  { address, symbol, name }
 * @param registry  issuer records for the SAME chain
 * @param [opts.chain]        'base' | 'robinhood'; inferred from the registry's issuer when omitted
 * @param [opts.prefixCheck]  a precomputed prefixSelfCheck(registry), for a caller scanning many tokens
 * @returns { listed, hits: [{ kind, ticker, registry_symbol, registry_address, ... }], prefix_check }
 */
export function resemblances (identity, registry, { chain, prefixCheck } = {}) {
  const recs = Array.isArray(registry) ? registry : []
  const ch = chain || chainOfRegistry(recs)
  const prefix_check = prefixCheck || prefixSelfCheck(recs, ch)
  const addr = typeof identity?.address === 'string' ? identity.address.toLowerCase() : null
  if (!addr) return { listed: false, hits: [], prefix_check }
  if (recs.some((r) => r.address === addr)) return { listed: true, hits: [], prefix_check }
  const hit = (kind, r, extra) => ({ kind, ticker: r ? tickerOf(r) : null, registry_symbol: r ? r.symbol : null, registry_address: r ? r.address : null, ...extra })
  const hits = nameHits(identity, recs)
  const look = addressLookalike(addr, recs, ch)
  if (look) hits.push(hit('address_lookalike', look, { rule: LOOKALIKE_RULES[ch] }))
  if (ch === 'base' && prefix_check.active) {
    const k = vanityZeros(addr)
    if (k >= FULL_PREFIX_ZEROS) hits.push(hit('unlisted_full_prefix', null, { zeros: k }))
    else if (k >= VANITY_MIN_ZEROS) hits.push(hit('vanity_prefix_partial', null, { zeros: k }))
  }
  return { listed: false, hits, prefix_check }
}
