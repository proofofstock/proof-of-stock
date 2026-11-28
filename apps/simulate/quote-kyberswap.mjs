// apps/simulate/quote-kyberswap.mjs: KyberSwap's route API as a quote adapter for simulate_buy (docs/simulate-buy-tz.md
// §3.2): the second line on Base, the primary on Robinhood Chain, and the builder of the swap the Robinhood Chain dry run
// simulates. No key; the server names itself in x-client-id.
//
// ⚠ ITS ANSWER IS UNTRUSTED INPUT. A quote must be for exactly the tokens and the amount we asked: tokenIn, tokenOut and
//   amountIn are held to ours, as agent-buy.mjs holds them, or the answer is `unknown`, `quote_mismatch`. amountOut must
//   be a decimal string of base units above zero (`quote_empty`). Exchange names are cut to 32 characters of
//   [a-z0-9-/] and are labels only: they never enter our sentence.
// ⚠ WE DO NOT TAKE ITS DOLLAR FIGURES FOR THE TOKEN. amountInUsd / amountOutUsd price the stock token by the aggregator's
//   own oracle; every dollar figure of ours comes from the stable's amount and the issuer's reference. Its gas in USD is
//   taken: that is the chain's gas, not the token.
// ⚠ IT NEVER SIGNS AND NEVER SENDS. `build` asks for calldata for the dry run; nothing here holds a key.

import { keccak256 } from '../../evm/core/stocks/evm-tx.mjs'

export const KYBER_API = 'https://aggregator-api.kyberswap.com'
export const KYBER_CLIENT_ID = 'proofofstock-server'
export const AGGREGATOR_TIMEOUT_MS = 10_000
const CHAIN_PATH = Object.freeze({ base: 'base', robinhood: 'robinhood' })
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UNITS = /^\d{1,78}$/
const low = (s) => String(s || '').toLowerCase()

/** An exchange name as a label: lower case, [a-z0-9-/] only, at most 32 characters. */
export const labelOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\-/]/g, '').slice(0, 32) || 'unnamed'

const headers = (extra = {}) => ({ accept: 'application/json', 'x-client-id': KYBER_CLIENT_ID, ...extra })

/** Thrown by a fetchImpl that is out of aggregator permits (apps/stocks-simulate.mjs): the call was never made. */
export const BUSY_MARK = 'aggregator-busy'

async function getJson (fetchImpl, url, init = {}) {
  let r
  try { r = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS) }) } catch (e) { return e && e.message === BUSY_MARK ? { busy: true } : { down: true } }
  let body = null
  try { body = await r.json() } catch (_) { body = null }
  return { status: r.status, body }
}

// KyberSwap's documented "route not found" answer: a 4xx carrying its error code 4008, and nothing else. A message that
// happens to say "no route" (a 5xx, a proxy's "no route to host") is an outage, never a fact about the market.
export const NO_ROUTE_CODES = Object.freeze([4008])
const NO_ROUTE = (r) => r.status >= 400 && r.status < 500 && r.status !== 429 && r.body && typeof r.body === 'object' && NO_ROUTE_CODES.includes(r.body.code)
/** A base-unit amount as the API must send it: a decimal string. A JSON number may already have been rounded. */
const isUnits = (v) => typeof v === 'string' && UNITS.test(v)
/** A number field the API may leave out: null when absent or not a number, never a zero made from null. */
const numOrNull = (v) => ((typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) || (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Number(v) : null)

/**
 * The route itself, held to what was asked: every path starts with tokenIn and ends with tokenOut, its hops chain
 * (each hop's tokenOut is the next one's tokenIn), and the paths' input amounts add up to amountIn. Null when it holds.
 */
export function routeProblem (rs, tokenIn, tokenOut, amountIn) {
  const paths = Array.isArray(rs.route) ? rs.route : null
  if (!paths || !paths.length || paths.some((p) => !Array.isArray(p) || !p.length || p.some((s) => !s || typeof s !== 'object'))) return 'quote_mismatch'
  let sum = 0n
  for (const p of paths) {
    // Every hop names both its tokens: two hops with no intermediate address are no chain.
    if (p.some((h) => !ADDRESS.test(String(h.tokenIn || '')) || !ADDRESS.test(String(h.tokenOut || '')))) return 'quote_mismatch'
    if (low(p[0].tokenIn) !== low(tokenIn) || low(p[p.length - 1].tokenOut) !== low(tokenOut)) return 'quote_mismatch'
    for (let i = 1; i < p.length; i++) if (low(p[i].tokenIn) !== low(p[i - 1].tokenOut)) return 'quote_mismatch'
    if (!isUnits(p[0].swapAmount)) return 'quote_mismatch'
    sum += BigInt(p[0].swapAmount)
  }
  return sum === BigInt(amountIn) ? null : 'quote_mismatch'
}

/**
 * One quote: { result: 'ok', source, amountOut, amountIn, gasUnits, gasUsd, route: { kind, pools, hops }, poolAddresses,
 * deliveringPool, routeSummary, quotedAt } or { result: 'no_route' | 'unknown', reason }.
 */
export async function kyberQuote ({ fetchImpl, chain, tokenIn, tokenOut, amountIn, now = Date.now }) {
  const p = CHAIN_PATH[chain]
  if (!p) return { result: 'unknown', reason: 'aggregator_unavailable', source: 'kyberswap' }
  const url = `${KYBER_API}/${p}/api/v1/routes?tokenIn=${low(tokenIn)}&tokenOut=${low(tokenOut)}&amountIn=${String(amountIn)}&gasInclude=true`
  const r = await getJson(fetchImpl, url, { headers: headers() })
  const at = now()
  if (r.busy || r.status === 429) return { result: 'unknown', reason: 'aggregator_busy', source: 'kyberswap', quotedAt: null }
  if (r.down) return { result: 'unknown', reason: 'aggregator_unavailable', source: 'kyberswap', quotedAt: at }
  if (NO_ROUTE(r)) return { result: 'no_route', source: 'kyberswap', quotedAt: at }
  const rs = r.status === 200 && r.body && r.body.data && r.body.data.routeSummary
  if (!rs || typeof rs !== 'object') return { result: 'unknown', reason: 'aggregator_unavailable', source: 'kyberswap', quotedAt: at }
  // Held to the checked contract exactly, both ways round: a quote for another token or another amount is no quote.
  if (low(rs.tokenIn) !== low(tokenIn) || low(rs.tokenOut) !== low(tokenOut)) return { result: 'unknown', reason: 'quote_mismatch', source: 'kyberswap', quotedAt: at }
  if (!isUnits(rs.amountIn) || rs.amountIn !== String(amountIn)) return { result: 'unknown', reason: 'quote_mismatch', source: 'kyberswap', quotedAt: at }
  if (!isUnits(rs.amountOut) || !(BigInt(rs.amountOut) > 0n)) return { result: 'unknown', reason: 'quote_empty', source: 'kyberswap', quotedAt: at }
  // ...and so is a summary whose route ends in another token than the one it names.
  const bad = routeProblem(rs, tokenIn, tokenOut, amountIn)
  if (bad) return { result: 'unknown', reason: bad, source: 'kyberswap', quotedAt: at }
  const swaps = rs.route.flat()
  const pools = [...new Set(swaps.map((s) => labelOf(s.exchange)))]
  const poolAddresses = [...new Set(swaps.map((s) => low(s.pool)).filter((a) => ADDRESS.test(a)))]
  // The pool that hands the stock token over: the probe of a wrapped revert sends one unit from there (sim-evm.mjs).
  const delivering = swaps.find((s) => low(s.tokenOut) === low(tokenOut) && ADDRESS.test(low(s.pool)))
  // Every pool that hands the stock token over, on every split of the route: each one sends it (the B20 sender scope).
  const deliveringPools = [...new Set(swaps.filter((s) => low(s.tokenOut) === low(tokenOut) && ADDRESS.test(low(s.pool))).map((s) => low(s.pool)))]
  // A delivering hop through a pool the route itself names as Uniswap v4 (a 32-byte id, an exchange called v4): the
  // PoolManager holds and sends the token. Any other delivering hop without a 20-byte address is opaque: we cannot say
  // who sends the token, and the caller treats that line as unchecked.
  const delivering_ = swaps.filter((s) => low(s.tokenOut) === low(tokenOut))
  const isV4 = (s) => /^0x[0-9a-f]{64}$/.test(low(s.pool)) && /v4/i.test(String(s.exchange || ''))
  const deliveringV4 = delivering_.some(isV4)
  const deliveringOpaque = delivering_.some((s) => !ADDRESS.test(low(s.pool)) && !isV4(s))
  const gas = numOrNull(rs.gas), gasUsd = numOrNull(rs.gasUsd)
  return {
    result: 'ok', source: 'kyberswap', amountIn: rs.amountIn, amountOut: rs.amountOut, quotedAt: at,
    gasUnits: gas != null && gas > 0 ? gas : null, gasUsd, gasBasis: 'aggregator_estimate',
    route: { kind: 'aggregator', pools, hops: Math.max(...rs.route.map((x) => x.length)), splits: rs.route.length },
    poolAddresses, deliveringPool: delivering ? low(delivering.pool) : null, deliveringPools, deliveringV4, deliveringOpaque, routeSummary: rs,
  }
}

// ── The built swap, decoded ───────────────────────────────────────────────────────────────────────────────────────
// KyberSwap's MetaAggregationRouterV2 takes a SwapDescriptionV2 in either of its two entry points; both are decoded
// here, strictly, and nothing else is run. Read from the router's verified source and checked 27.11 against a live
// build on both chains, which used `swap`.
const DESC = '(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes)'
const sel = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4).toString('hex')
/** SwapDescriptionV2's flags: bit 0 is _PARTIAL_FILL (the router may stop before the whole input is spent). */
export const PARTIAL_FILL = 1n
export const ROUTER_SELECTORS = Object.freeze({ swap: sel(`swap((address,address,bytes,${DESC},bytes))`), swapSimpleMode: sel(`swapSimpleMode(address,${DESC},bytes,bytes)`) })

/**
 * The swap description inside a built call: { entry, srcToken, dstToken, srcReceivers, srcAmounts, dstReceiver,
 * amount, minReturnAmount } or null when the selector is not one we decode or the data does not decode as ABI.
 */
export function decodeKyberSwap (data) {
  const h = String(data || '').toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]*$/.test(h) || h.length < 8 || (h.length - 8) % 64) return null
  const body = h.slice(8), words = body.length / 64
  const w = (i) => { if (!Number.isInteger(i) || i < 0 || i >= words) throw new Error('out of range'); return BigInt('0x' + body.slice(i * 64, i * 64 + 64)) }
  const at = (byteOff) => { if (byteOff % 32n) throw new Error('unaligned'); return Number(byteOff / 32n) }
  const addr = (i) => { const x = w(i); if (x >> 160n) throw new Error('not an address'); return '0x' + x.toString(16).padStart(40, '0') }
  const arr = (i, kind) => { const n = Number(w(i)); if (n > 64) throw new Error('too long'); return Array.from({ length: n }, (_, k) => (kind === 'addr' ? addr(i + 1 + k) : w(i + 1 + k).toString())) }
  try {
    let d, entry, executorBytes
    if (h.startsWith(ROUTER_SELECTORS.swap)) { const t = at(w(0)); d = t + at(w(t + 3)); executorBytes = w(t + at(w(t + 2))); entry = 'swap' }
    else if (h.startsWith(ROUTER_SELECTORS.swapSimpleMode)) { d = at(w(1)); executorBytes = w(at(w(2))); entry = 'swapSimpleMode' }
    else return null
    return { entry, srcToken: addr(d), dstToken: addr(d + 1), srcReceivers: arr(d + at(w(d + 2)), 'addr'), srcAmounts: arr(d + at(w(d + 3))), dstReceiver: addr(d + 6), amount: w(d + 7).toString(), minReturnAmount: w(d + 8).toString(), flags: w(d + 9).toString(), executorBytes: executorBytes.toString() }
  } catch (_) { return null }
}

/**
 * The swap KyberSwap builds for `wallet` from a quote's routeSummary, decoded and held to what was asked: { ok: true,
 * to, data, payTo, desc } or { ok: false, reason }. `build_unverified` is a call we cannot decode (another entry point);
 * `build_mismatch` one that sells another token, buys another, pays someone else or spends another amount. Neither is
 * run. The router it names is checked against the allowlist by the simulator.
 */
export async function kyberBuild ({ fetchImpl, chain, routeSummary, wallet, slippageBps, tokenIn, tokenOut, amountIn, deadline = null }) {
  const p = CHAIN_PATH[chain]
  if (!p || !routeSummary) return { ok: false, reason: 'build_failed' }
  const r = await getJson(fetchImpl, `${KYBER_API}/${p}/api/v1/route/build`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ routeSummary, sender: wallet, recipient: wallet, slippageTolerance: slippageBps, ...(Number.isFinite(deadline) ? { deadline } : {}) }) })
  if (r.busy || r.status === 429) return { ok: false, reason: 'aggregator_busy' }
  const tx = !r.down && r.status === 200 && r.body && r.body.data
  if (!tx || !ADDRESS.test(String(tx.routerAddress || '')) || !/^0x[0-9a-fA-F]{8,}$/.test(String(tx.data || ''))) return { ok: false, reason: 'build_failed' }
  const desc = decodeKyberSwap(tx.data)
  if (!desc) return { ok: false, reason: 'build_unverified', to: low(tx.routerAddress) }
  // The router pays dstReceiver, or msg.sender when it is zero: the dry run calls from the wallet, so either is the wallet.
  const paysWallet = desc.dstReceiver === low(wallet) || /^0x0{40}$/.test(desc.dstReceiver)
  // A partial fill (flag bit 0) may spend less than asked; the swap entry point carries executor data, which the real
  // router requires. How much the wallet actually spends is not read from the description (simple mode pulls by its
  // executor data, a source fee by separate transfers): the dry run measures it as a balance change.
  const partialFill = (BigInt(desc.flags) & PARTIAL_FILL) !== 0n
  if (desc.srcToken !== low(tokenIn) || desc.dstToken !== low(tokenOut) || !paysWallet || desc.amount !== String(amountIn) || partialFill || !(BigInt(desc.minReturnAmount) > 0n)) return { ok: false, reason: 'build_mismatch', to: low(tx.routerAddress) }
  if (desc.entry === 'swap' && !(BigInt(desc.executorBytes) > 0n)) return { ok: false, reason: 'build_unverified', to: low(tx.routerAddress) }
  return { ok: true, to: low(tx.routerAddress), data: String(tx.data).toLowerCase(), payTo: desc.srcReceivers[0] || null, desc, deadline: Number.isFinite(deadline) ? deadline : null }
}

/** The router's return, (uint256 returnAmount, uint256 gasUsed): the amount out, or null when it is not two words. */
export function decodeKyberReturn (hex) {
  const h = String(hex || '').replace(/^0x/, '')
  return /^[0-9a-fA-F]{128}$/.test(h) ? BigInt('0x' + h.slice(0, 64)) : null
}
