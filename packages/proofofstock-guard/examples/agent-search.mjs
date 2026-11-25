// packages/proofofstock-guard/examples/agent-search.mjs: an agent that finds a stock token by searching the market, the
// way a person or a naive agent would, and lets the guard tell the original from everything else that bears its name.
//
// The user says "find me Circle on Base". The flow:
//   1. search a public DEX index (GeckoTerminal, no key) for tokens on Base whose symbol or name claims the stock;
//   2. ask the guard about every one of them in one batch: impostor, not on the issuer's list, or the issuer's own;
//   3. take the one the issuer lists (else the address the guard names instead, else the issuer-listed search);
//   4. hand it to examples/agent-buy.mjs, which checks it once more, reads its passport, holds a live KyberSwap quote
//      to the issuer's price and ends with a link or an unsigned swap.
//
// ⚠ IT NEVER SIGNS AND NEVER SENDS, like agent-buy.mjs, whose money path it reuses unchanged.
// ⚠ "NOT ON THE ISSUER'S LIST" IS NOT "FAKE". Another issuer's genuine token (Dinari, for one) is not on Coinbase's list
// either. The flow skips such a token because it cannot vouch for it, and says so in those words.
// ⚠ NAMES ARE SOMEBODY ELSE'S TEXT. A token's symbol and name are written by whoever deployed it; cleanLabel keeps them
// short, single-line and without links before anything shows them.
//
// Run (needs outbound HTTPS):
//   node packages/proofofstock-guard/examples/agent-search.mjs Circle
//   node packages/proofofstock-guard/examples/agent-search.mjs Tesla [--from 0x...]
// Exit: as agent-buy.mjs: 0 quoted or built, 1 refused by a check, 2 bad input, 3 something could not be read.

import { createGuard, DEFAULT_ENDPOINT, MAX_BATCH } from '../index.mjs'
import { buyFlow } from './agent-buy.mjs'

export const GECKO = 'https://api.geckoterminal.com/api/v2'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** A token's symbol or name, made safe to show: one line, no control characters, no link, at most `max` characters. */
export function cleanLabel (s, max = 28) {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S*/gi, '…')
    .replace(/\b[a-z0-9-]+\.(?:com|io|xyz|org|net|app|fi|finance|gg|co|me|ai|site|online|link|vip|top|club)\b\S*/gi, '…')
    .replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** The words a token must carry to be a candidate for this stock: the ticker, and the company's first name word. */
export function termsFor ({ ticker, name }) {
  const out = []
  if (ticker) out.push(String(ticker).toUpperCase())
  const w = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/)[0]
  if (w && w.length >= 3 && w.toUpperCase() !== out[0]) out.push(w.toUpperCase())
  return out
}

/**
 * The tokens on Base a market search turns up for this stock: GeckoTerminal's pool search, every token in the pools
 * found whose symbol or name carries one of the terms, with the pools' liquidity summed. Most liquid first, at most
 * MAX_BATCH (the guard's batch). Null if the search could not be read.
 */
export async function searchCandidates ({ ticker, name }, { fetchImpl = globalThis.fetch } = {}) {
  const terms = termsFor({ ticker, name })
  if (!terms.length) return []
  let body
  try {
    const r = await fetchImpl(`${GECKO}/search/pools?query=${encodeURIComponent(terms[0])}&network=base&include=base_token,quote_token`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
    if (r.status !== 200) return null
    body = await r.json()
  } catch (_) { return null }
  if (!body || !Array.isArray(body.data)) return null
  const tokens = new Map()
  for (const t of Array.isArray(body.included) ? body.included : []) {
    const a = t && t.attributes
    if (!a || !ADDRESS.test(String(a.address))) continue
    const text = `${a.symbol || ''} ${a.name || ''}`.toUpperCase()
    if (!terms.some((w) => text.includes(w))) continue
    tokens.set(String(a.address).toLowerCase(), { address: String(a.address).toLowerCase(), symbol: cleanLabel(a.symbol, 16), name: cleanLabel(a.name), liquidityUsd: 0, pools: 0 })
  }
  for (const p of body.data) {
    const rel = p && p.relationships, reserve = Number(p && p.attributes && p.attributes.reserve_in_usd) || 0
    for (const side of ['base_token', 'quote_token']) {
      const id = rel && rel[side] && rel[side].data && String(rel[side].data.id || '')
      const c = id && tokens.get(id.replace(/^base_/, '').toLowerCase())
      if (c) { c.liquidityUsd += reserve; c.pools++ }
    }
  }
  return [...tokens.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, MAX_BATCH)
}

/**
 * The whole search, then the buy. Never throws; returns what buyFlow returns, or { code, outcome } if it stops first.
 * @param {object} o
 * @param {string} o.query          what the user asked for: a company or a ticker ("Circle", "TSLA")
 * @param {string} [o.ticker]       the ticker, when the caller already knows it (the page's buttons do); else it is
 *                                  read from the issuer-listed search
 * @param {number} [o.usd]          how much to quote (default 20)
 * @param {string} [o.from]         the user's wallet: build the unsigned swap for it
 * @param {function} [o.onStep]     called with { step, ... } at each step, this file's and agent-buy.mjs's
 */
export async function searchFlow ({ query, ticker = null, usd = 20, from = null, maxPremium = 0.03, fetchImpl = globalThis.fetch, print = console.log, endpoint = DEFAULT_ENDPOINT, onStep = null } = {}) {
  const say = (who, s) => print(`${who.padEnd(6)} ${s}`)
  const step = (name, o = {}) => { try { if (onStep) onStep({ step: name, ...o }) } catch (_) {} }
  const stop = (code, outcome, why) => { say('agent', why); step('stop', { code, outcome, why }); return { code, outcome } }
  const q = cleanLabel(query, 40)
  if (!q) return stop(2, 'bad_input', 'Tell me which stock to look for, like "Circle" or "Tesla". Nothing bought.')
  if (ticker != null && !/^[A-Za-z][A-Za-z0-9.]{0,9}$/.test(String(ticker))) return stop(2, 'bad_input', 'A ticker is letters and digits, like CRCL. Nothing bought.')
  if (!(Number(usd) > 0 && Number(usd) <= 1e6)) return stop(2, 'bad_input', 'The amount must be more than $0. Nothing bought.')
  say('user', `find me ${q} on Base`)

  // The stock's ticker and name: given, or from the issuer-listed search (so "Tesla" becomes TSLA).
  let name = q
  if (!ticker) {
    let f = null
    try { const r = await fetchImpl(`${endpoint}/api/find?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); f = r.status === 200 ? await r.json() : null } catch (_) {}
    if (!f || !Array.isArray(f.matches)) return stop(3, 'unavailable', 'The issuer-listed search could not be read, so I do not buy.')
    const hit = f.matches.find((x) => x && x.chain === 'base' && typeof x.symbol === 'string')
    if (!hit) return stop(1, 'refused', `No stock called ${q} is listed by the issuer on Base. Nothing bought.`)
    ticker = hit.symbol.replace(/c$/, '')
    name = hit.name || q
  }
  ticker = String(ticker).toUpperCase()
  step('search', { query: q, ticker, terms: termsFor({ ticker, name }) })
  say('agent', `Searching Base for tokens that call themselves ${q} (${ticker}).`)

  // 1. The market search.
  const found = await searchCandidates({ ticker, name }, { fetchImpl })
  if (found == null) return stop(3, 'unavailable', 'The market search could not be read, so I do not buy.')
  step('candidates', { ticker, candidates: found })
  say('agent', `${found.length} token${found.length === 1 ? '' : 's'} on Base carry the name ${ticker}.`)

  // 2. The guard, on all of them at once.
  let picked = null
  if (found.length) {
    const guard = createGuard({ endpoint, fetchImpl })
    const ds = await guard.beforeBuyMany('base', found.map((c) => ({ tokenAddress: c.address, claimedSymbol: ticker })))
    const verdicts = found.map((c, i) => ({ ...c, decision: ds[i].decision, allow: ds[i].allow, reason: ds[i].reason, use_instead: ds[i].use_instead || null, imitates: ds[i].verify && ds[i].verify.impostor ? ds[i].verify.impostor.imitates_symbol || null : null, listed_symbol: ds[i].allow ? ds[i].verify.symbol : null }))
    step('verdicts', { ticker, verdicts })
    for (const v of verdicts) say('guard', `${v.allow ? 'ALLOW' : 'REFUSE'} (${v.decision}) ${v.symbol} ${v.address}`)
    if (verdicts.some((v) => v.decision === 'unknown')) return stop(3, 'unavailable', 'The check could not be made for every token, so I do not buy.')
    // 3. The original: the one the issuer lists, else the address a look-alike's answer names as the real one.
    const listed = verdicts.find((v) => v.allow)
    if (listed) picked = { address: listed.address, how: 'search' }
    else { const pointer = verdicts.find((v) => v.use_instead && ADDRESS.test(v.use_instead)); if (pointer) picked = { address: pointer.use_instead.toLowerCase(), how: 'pointer' } }
  }
  step('pick', { ticker, address: picked ? picked.address : null, how: picked ? picked.how : 'issuer_search' })
  say('agent', picked ? `The issuer's own ${ticker} is ${picked.address}. Buying that one only.` : `The search did not turn up the issuer's own ${ticker}; asking the issuer-listed search.`)

  // 4. The buy: agent-buy.mjs, handed the original (or nothing: then it looks the ticker up itself).
  return buyFlow({ request: `buy $${Number(usd)} of ${ticker} on Base`, handed: picked ? picked.address : null, from, maxPremium, fetchImpl, print, endpoint, onStep })
}

const isMain = globalThis.process?.argv?.[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')).href
if (isMain) {
  const args = process.argv.slice(2)
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] ?? '' : null }
  const from = opt('--from')
  const r = await searchFlow({ query: args[0] || 'Circle', ticker: args[0] ? null : 'CRCL', from })
  process.exit(r.code)
}
