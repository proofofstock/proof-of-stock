// packages/proofofstock-guard/examples/agent-buy.mjs: an agent's whole buy, from the user's sentence to an unsigned swap.
//
// The user says "buy $20 of SNDK on Base" and the agent is handed a contract (from a tip, a search, a chat). The flow:
//   1. read the request: amount, ticker, chain;
//   2. guard.beforeBuy on the handed contract: a look-alike is refused;
//   3. resolve the issuer's own contract (the guard's use_instead, else /api/find) and check THAT one with the guard;
//   4. read its passport: minted, not paused, the issuer's reference price;
//   5. ask a public DEX aggregator (KyberSwap, no key) for a USDC -> token quote, and refuse it unless the quote is for
//      the very contract checked in step 3 and its price sits within maxPremium of the issuer's reference;
//   6. print a KyberSwap link with the checked contract filled in, for a person to swap in the browser;
//   7. with --from <address> only: build the unsigned swap for that wallet.
//
// ⚠ IT NEVER SIGNS AND NEVER SENDS. There is no key anywhere in this file. Step 6 prints a transaction for the user's own
// wallet to review and sign; without --from the flow stops at the quote.
// ⚠ IT FAILS CLOSED. Any step that cannot be read stops the buy (exit 3), the same as the guard does.
//
// Run (needs outbound HTTPS):
//   node packages/proofofstock-guard/examples/agent-buy.mjs
//   node packages/proofofstock-guard/examples/agent-buy.mjs "buy $20 of SNDK on Base" --handed 0x35b7...f703 [--from 0x...]
// Exit: 0 quoted or built, 1 refused by a check, 2 bad input, 3 something could not be read.

import { createGuard, DEFAULT_ENDPOINT } from '../index.mjs'

export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1'
export const BASE_RPC = 'https://mainnet.base.org'
// KyberSwap's MetaAggregationRouterV2 on Base. A built swap to any other contract is refused: the aggregator chooses the
// route, never where the user's USDC goes.
export const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'
/** The slippage the built swap allows, in basis points: the least it may deliver is the quote less this. */
export const SLIPPAGE_BPS = 50

/** The unsigned USDC approve the swap needs first: exactly `amount` (base units) to `spender`, never an unlimited one. */
export function approveUsdc (spender, amount) {
  if (!ADDRESS.test(String(spender)) || !/^\d{1,30}$/.test(String(amount))) return null
  const word = (hex) => hex.padStart(64, '0')
  return { to: USDC_BASE, value: '0', data: '0x095ea7b3' + word(String(spender).slice(2).toLowerCase()) + word(BigInt(amount).toString(16)) }
}

/** KyberSwap's swap page with USDC -> the given contract filled in, built from the checked address only (never from
 * the user's words or a quote), so the browser gets exactly the contract the guard passed. Null for anything else. */
export function swapLink (address) {
  if (!ADDRESS.test(String(address))) return null
  return `https://kyberswap.com/swap/base?inputCurrency=${USDC_BASE}&outputCurrency=${String(address).toLowerCase()}`
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const CLIENT = { 'x-client-id': 'proofofstock-example', accept: 'application/json' }

/** "buy $20 of SNDK on Base" -> { usd: 20, ticker: 'SNDK', chain: 'base' }, or null. */
export function parseRequest (text) {
  const m = /^\s*buy\s+\$\s*(\d{1,6}(?:\.\d{1,2})?)\s+(?:of\s+)?\$?([A-Za-z][A-Za-z0-9.]{0,9})(?:\s+on\s+(base|robinhood(?:\s+chain)?))?\s*$/i.exec(String(text || ''))
  if (!m) return null
  const usd = Number(m[1])
  if (!(usd > 0)) return null
  return { usd, ticker: m[2].toUpperCase(), chain: m[3] ? m[3].toLowerCase().split(/\s+/)[0] : 'base' }
}

/**
 * The whole flow. Never throws; returns { code, outcome, ... }.
 * @param {object} o
 * @param {string} o.request          the user's sentence
 * @param {string} [o.handed]         the contract the agent was handed, if any
 * @param {string} [o.from]           the user's wallet: build the unsigned swap for it
 * @param {number} [o.maxPremium]     refuse a quote further than this from the issuer's reference (default 0.03)
 * @param {function} [o.onStep]       called with { step, ... } at each step, for a page that draws the flow (apps/stocks-web/demo.js);
 *                                    it only watches: what it returns or throws changes nothing in the flow
 */
export async function buyFlow ({ request, handed = null, from = null, maxPremium = 0.03, fetchImpl = globalThis.fetch, print = console.log, endpoint = DEFAULT_ENDPOINT, onStep = null } = {}) {
  const say = (who, s) => print(`${who.padEnd(6)} ${s}`)
  const step = (name, o = {}) => { try { if (onStep) onStep({ step: name, ...o }) } catch (_) {} }
  const stop = (code, outcome, why) => { say('agent', why); step('stop', { code, outcome, why }); return { code, outcome } }
  const getJson = async (url, init = {}) => {
    try {
      const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10000) })
      const body = await r.json().catch(() => null)
      return r.status === 200 && body ? body : null
    } catch (_) { return null }
  }

  // 1. The request.
  const ask = parseRequest(request)
  if (!ask) return stop(2, 'bad_input', 'I read requests of the form "buy $20 of SNDK on Base". Nothing bought.')
  if (from != null && !ADDRESS.test(from)) return stop(2, 'bad_input', '--from must be 0x followed by 40 hex characters. Nothing bought.')
  if (handed != null && !ADDRESS.test(handed)) return stop(2, 'bad_input', 'the handed contract must be 0x followed by 40 hex characters. Nothing bought.')
  say('user', `buy $${ask.usd} of ${ask.ticker} on ${ask.chain}`)
  step('request', { ask })

  const guard = createGuard({ endpoint, fetchImpl })
  let address = null

  // 2. The handed contract.
  if (handed) {
    say('agent', `I was handed ${handed}. Checking it before anything else.`)
    step('handed', { address: handed.toLowerCase() })
    const d = await guard.beforeBuy({ chain: ask.chain, tokenAddress: handed, claimedSymbol: ask.ticker })
    say('guard', `${d.allow ? 'ALLOW' : 'REFUSE'} (${d.decision}) ${d.reason}`)
    step('guard_handed', { address: handed.toLowerCase(), decision: d })
    if (d.decision === 'unknown') return stop(3, 'unavailable', 'The check could not be made, so I do not buy.')
    if (d.allow) address = handed.toLowerCase()
    else if (d.use_instead) { say('agent', `Not buying ${handed}. Checking the issuer's own contract instead.`); address = d.use_instead.toLowerCase() }
    else say('agent', `Not buying ${handed}. Looking up the issuer's own ${ask.ticker} contract.`)
  }

  // 3. The issuer's contract: from the guard's answer, else from the issuer-listed search, on the chain asked only.
  if (!address) {
    const f = await getJson(`${endpoint}/api/find?q=${encodeURIComponent(ask.ticker)}`, { headers: { accept: 'application/json' } })
    if (!f || !Array.isArray(f.matches)) return stop(3, 'unavailable', 'The issuer-listed search could not be read, so I do not buy.')
    const hit = f.match === 'exact' ? f.matches.find((x) => x && x.chain === ask.chain && ADDRESS.test(String(x.address || ''))) : null
    if (!hit) return stop(1, 'refused', `No issuer-listed ${ask.ticker} on ${ask.chain}. Nothing bought.`)
    address = hit.address.toLowerCase()
    step('find', { address, matches: f.matches })
  }
  const d = await guard.beforeBuy({ chain: ask.chain, tokenAddress: address, claimedSymbol: ask.ticker })
  say('guard', `${d.allow ? 'ALLOW' : 'REFUSE'} (${d.decision}) ${d.reason}`)
  step('guard_real', { address, decision: d })
  if (d.decision === 'unknown') return stop(3, 'unavailable', 'The check could not be made, so I do not buy.')
  if (!d.allow) return stop(1, 'refused', 'The issuer\'s contract did not pass the check either. Nothing bought.')
  const symbol = d.verify.symbol

  // 4. The passport: the issuer still mints it, it is not paused, and there is a reference price to hold the quote to.
  const p = await getJson(`${endpoint}/api/passport?chain=${ask.chain}&address=${address}`, { headers: { accept: 'application/json' } })
  const ref = p && p.reference && Number(p.reference.price_usd)
  if (!p || !p.issuer || !(ref > 0)) return stop(3, 'unavailable', 'The passport or its reference price could not be read, so I do not buy.')
  if (p.issuer.minted !== true) return stop(1, 'refused', `The issuer lists ${symbol} but has not minted it. Nothing bought.`)
  if (!Array.isArray(p.issuer.paused) || p.issuer.paused.length) return stop(1, 'refused', `The issuer has paused ${symbol} (${(p.issuer.paused || []).join(', ') || 'unknown'}). Nothing bought.`)
  const session = p.market_now && p.market_now.session
  say('agent', `${symbol}: the issuer's reference is $${ref.toFixed(2)}${session && session !== 'regular' ? ` (US market ${session}: the reference is held from the last close)` : ''}.`)
  step('passport', { address, symbol, ref, session: session || null, passport: p })

  if (ask.chain !== 'base') return stop(0, 'checked', `This example quotes on Base only; ${symbol} on ${ask.chain} is checked and ready for your own venue.`)

  // 5. The quote, held to the contract checked above and to the issuer's reference.
  const amountIn = String(Math.round(ask.usd * 1e6))
  const q = await getJson(`${KYBER}/routes?tokenIn=${USDC_BASE}&tokenOut=${address}&amountIn=${amountIn}`, { headers: CLIENT })
  const rs = q && q.data && q.data.routeSummary
  if (!rs) return stop(3, 'unavailable', 'No quote could be read, so I do not buy.')
  if (String(rs.tokenOut).toLowerCase() !== address || String(rs.tokenIn).toLowerCase() !== USDC_BASE || String(rs.amountIn) !== amountIn) {
    return stop(1, 'refused', 'The quote is not for the contract I checked. Nothing bought.')
  }
  const dec = await getJson(BASE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] }) })
  const decimals = dec && /^0x[0-9a-f]+$/i.test(String(dec.result)) ? Number(BigInt(dec.result)) : NaN
  if (!Number.isInteger(decimals) || decimals > 36) return stop(3, 'unavailable', `${symbol}'s decimals could not be read from the chain, so I do not buy.`)
  const tokens = Number(rs.amountOut) / 10 ** decimals
  if (!(tokens > 0)) return stop(1, 'refused', 'The quote gives nothing for the money. Nothing bought.')
  const price = ask.usd / tokens, premium = price / ref - 1
  say('quote', `$${ask.usd} USDC -> ${tokens.toFixed(6)} ${symbol} at $${price.toFixed(2)}, ${(premium * 100).toFixed(2)}% from the issuer's reference.`)
  step('quote', { address, symbol, usd: ask.usd, tokens, price, ref, premium, maxPremium, decimals, slippageBps: SLIPPAGE_BPS, routeSummary: rs })
  if (Math.abs(premium) > maxPremium) return stop(1, 'refused', `That is more than ${(maxPremium * 100).toFixed(1)}% from the reference. Not buying at this price.`)

  // 6. The unsigned swap, for the user's own wallet only.
  // The same swap for a person in a browser: the page opens with the checked contract already in place, no search by name.
  const link = swapLink(address)
  say('link', link)
  step('link', { link, address, symbol })
  say('', `opens USDC -> ${symbol} with ${address} filled in; check that address in your wallet before you sign.`)
  if (!from) { say('agent', `Ready to swap into ${address} (${symbol}). Pass --from <your wallet> to build the transaction; nothing is signed here.`); return { code: 0, outcome: 'quoted', link, address, symbol } }
  const b = await getJson(`${KYBER}/route/build`, { method: 'POST', headers: { ...CLIENT, 'content-type': 'application/json' }, body: JSON.stringify({ routeSummary: rs, sender: from, recipient: from, slippageTolerance: SLIPPAGE_BPS }) })
  const tx = b && b.data
  if (!tx || !ADDRESS.test(String(tx.routerAddress || '')) || !/^0x[0-9a-f]+$/i.test(String(tx.data || ''))) return stop(3, 'unavailable', 'The swap could not be built, so I do not buy.')
  if (String(tx.routerAddress).toLowerCase() !== KYBER_ROUTER) return stop(1, 'refused', "The built swap goes to a contract that is not the aggregator's router. Not signing that.")
  say('agent', 'Unsigned transaction for your wallet to review and sign (first approve USDC to the router):')
  say('', `to ${tx.routerAddress}, value 0, data ${tx.data.slice(0, 10)}... (${(tx.data.length - 2) / 2} bytes), max 0.5% slippage`)
  const approve = approveUsdc(tx.routerAddress, rs.amountIn)
  if (approve) say('', `approve first: to ${approve.to} (USDC), data ${approve.data.slice(0, 10)}... for exactly ${ask.usd} USDC, not unlimited`)
  const built = { to: tx.routerAddress, value: '0', data: tx.data }
  step('built', { tx: built, from, approve, address, symbol })
  return { code: 0, outcome: 'built', tx: built, link, address, symbol }
}

// The page at /demo imports this file in a browser, where there is no process.
const isMain = globalThis.process?.argv?.[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')).href
if (isMain) {
  const args = process.argv.slice(2)
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] ?? '' : null }
  const handed = opt('--handed'), from = opt('--from')
  const request = args[0] || 'buy $20 of SNDK on Base'
  // The default run is the case the guard was built for: a look-alike of SNDKc that Proof of Stock flagged on Base.
  const r = await buyFlow({ request, handed: handed ?? (args[0] ? null : '0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703'), from })
  process.exit(r.code)
}
