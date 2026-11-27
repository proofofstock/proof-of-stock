// apps/simulate/quote-aerodrome.mjs: Aerodrome's own quote on Base for simulate_buy (docs/simulate-buy-tz.md §3.1, v2.2):
// read from its Slipstream contracts by eth_call, no API. The primary quote on Base, and the swap the Base dry run
// simulates (`exactInputSingle`, encoded here).
//
// ⚠ PINNED PER FACTORY. Each Slipstream pool factory has its own Quoter and SwapRouter, as aerodrome-finance/slipstream's
//   README ("Gauges V3 Deployment" and the deployments before it) publishes them. We quote only through a factory whose
//   pair is pinned below, and every quote first asks the Quoter's and the Router's `factory()` in the same batch: a pair
//   that does not answer its own factory is off (`quoter_mismatch`), never guessed. A factory the recorder reads with
//   no confirmed Quoter gets no quote and is named (`venue_unconfirmed`).
// ⚠ A REVERT IS A SKIP, NEVER A ZERO. The Quoter reverts for a tick spacing with no pool, or a pool it cannot route the
//   size through; that pool is skipped and counted. Only a decoded amount above zero is a quote.
// ⚠ ONE POOL, ONE HOP. The answer is the best single-pool quote for the exact size; a split across pools or a route
//   through WETH is what the aggregator line is for.
// The gas: the Quoter's estimate is the pool's own swap, priced at the block header's base fee; the answer says so.
// The pools: the Quoter is asked at every tick spacing the recorder's discovery asks this factory about
// (scripts/stocks/onchain-pools.mjs ONCHAIN.base.factories), and it finds the pool for each itself. The recorder's pool
// book does not keep a pool's tick spacing, so the book is not read here; the factory's getPool names each pool.

import { keccak256 } from '../../evm/core/stocks/evm-tx.mjs'
import { ONCHAIN, MULTICALL3, encodeAggregate3, decodeAggregate3Result, args as abi } from '../../scripts/stocks/onchain-pools.mjs'

const sel = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4).toString('hex')
export const SELECTORS = Object.freeze({
  quoteExactInputSingle: sel('quoteExactInputSingle((address,address,uint256,int24,uint160))'),
  exactInputSingle: sel('exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))'),
  factory: sel('factory()'),
  getPool: sel('getPool(address,address,int24)'),
})

/**
 * Slipstream deployments whose Quoter and SwapRouter are paired with the factory, from aerodrome-finance/slipstream's
 * README, read 27.11.2026, and checked that day by eth_call (`factory()` of the Quoter returns the factory). Only a
 * factory the recorder reads is quoted: today the one it names dexId `aerodrome`.
 */
export const SLIPSTREAM = Object.freeze([
  Object.freeze({ factory: '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef', quoter: '0x514c8b5f54112481e28028f1166bd78501089259', router: '0x698cb2b6dd822994581fea6ea4fc755d1363a92f', source: 'slipstream README, Gauges V3 Deployment, read 27.11.2026' }),
])
/** The recorder's other Base Slipstream factory (dexId `aero`): no Quoter is confirmed for it, so it is not quoted. */
export const UNCONFIRMED_FACTORIES = Object.freeze(['0x9cb220581b91b0c83223012fe69688b92ad07a76'])
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const BASE_WETH = '0x4200000000000000000000000000000000000006'
const ETH_PROBE_WEI = 10n ** 15n // 0.001 WETH, quoted to USDC to price the gas
const RPC_TIMEOUT_MS = 5_000
const UINT = (h, i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'))
const strip = (h) => String(h || '').replace(/^0x/, '')
const low = (s) => String(s || '').toLowerCase()

/** The tick spacings the recorder asks a factory about. */
export function spacingsOf (factory) {
  const f = ONCHAIN.base.factories.find((x) => x.address === low(factory))
  return f && f.by === 'tickSpacing' ? [...f.params] : []
}

/** Calldata of Quoter.quoteExactInputSingle for one tick spacing, no price limit. */
export function encodeQuote ({ tokenIn, tokenOut, amountIn, tickSpacing }) {
  return '0x' + SELECTORS.quoteExactInputSingle + abi.addr(tokenIn) + abi.addr(tokenOut) + abi.uint(amountIn) + abi.int(tickSpacing) + abi.uint(0)
}

/**
 * Calldata of SwapRouter.exactInputSingle, the struct as Slipstream's ISwapRouter declares it: tokenIn, tokenOut,
 * tickSpacing, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96 (read from the verified source,
 * contracts/periphery/interfaces/ISwapRouter.sol, 27.11.2026). A static struct is encoded inline.
 */
export function encodeExactInputSingle ({ tokenIn, tokenOut, tickSpacing, recipient, deadline, amountIn, amountOutMinimum }) {
  return '0x' + SELECTORS.exactInputSingle + abi.addr(tokenIn) + abi.addr(tokenOut) + abi.int(tickSpacing) + abi.addr(recipient) + abi.uint(deadline) + abi.uint(amountIn) + abi.uint(amountOutMinimum) + abi.uint(0)
}

/** The router's return: one word, amountOut. Null when it does not decode. */
export function decodeAmountOut (hex) {
  const h = strip(hex)
  return /^[0-9a-fA-F]{64}$/.test(h) ? UINT(h, 0) : null
}

async function rpc (fetchImpl, url, method, params) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`rpc answered ${r.status}`)
  const j = await r.json()
  if (!j || j.error || j.result == null) throw new Error('rpc: ' + String(j?.error?.message || 'no result').slice(0, 120))
  return j.result
}

/** Slipstream's price bounds (TickMath): with no price limit the Quoter swaps until one of these, plus or minus one. */
export const MIN_SQRT_RATIO = 4295128739n
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n
/**
 * A swap that ended at the price limit ran out of liquidity: the pool stopped with input left over, and the output it
 * gives is for less than the amount asked. Such a quote is not a quote for this size, so it is skipped.
 */
export const hitLimit = (tokenIn, tokenOut, sqrtAfter) => (low(tokenIn) < low(tokenOut) ? sqrtAfter <= MIN_SQRT_RATIO + 1n : sqrtAfter >= MAX_SQRT_RATIO - 1n)

const HEX_WORDS = (h, n) => typeof h === 'string' && new RegExp(`^0x[0-9a-fA-F]{${64 * n}}$`).test(h)
const QTY = /^0x[0-9a-fA-F]{1,64}$/

/**
 * The best single-pool quote on Aerodrome for exactly `amountIn` of `tokenIn`: the latest block's header first (its
 * number and base fee), then one Multicall3 batch at that block. { result: 'ok', source, amountIn, amountOut, gasUnits,
 * gasUsd, gasBasis, route, pool, tickSpacing, deployment, routerPaired, quotedAt, pools } or { result: 'no_route' |
 * 'unknown', reason }. `withGasPrice` adds an ETH price to the batch, for the gas in dollars.
 *
 * `no_route` is said only when it is a fact: no pool exists for the pair, or every pool's quote reverted or stopped at
 * the price limit. A pool that answered with something that is not the Quoter's four words, or with a zero, makes the
 * answer `unknown` (quote_empty) when nothing else answered: an unreadable reply is not an empty market.
 */
export async function aerodromeQuote ({ fetchImpl, rpcUrl, tokenIn, tokenOut, amountIn, now = Date.now, withGasPrice = true, deployment = SLIPSTREAM[0] }) {
  const out = (o) => ({ source: 'aerodrome', quotedAt: now(), unconfirmed_factories: [...UNCONFIRMED_FACTORIES], ...o })
  const spacings = spacingsOf(deployment.factory)
  if (!spacings.length) return out({ result: 'unknown', reason: 'venue_unconfirmed' })
  const calls = [
    { to: deployment.quoter, data: '0x' + SELECTORS.factory },
    { to: deployment.router, data: '0x' + SELECTORS.factory },
  ]
  const ethAt = calls.length
  if (withGasPrice) for (const ts of spacings) calls.push({ to: deployment.quoter, data: encodeQuote({ tokenIn: BASE_WETH, tokenOut: BASE_USDC, amountIn: ETH_PROBE_WEI, tickSpacing: ts }) })
  const poolAt = calls.length
  for (const ts of spacings) {
    calls.push({ to: deployment.factory, data: '0x' + SELECTORS.getPool + abi.addr(tokenIn) + abi.addr(tokenOut) + abi.int(ts) })
    calls.push({ to: deployment.quoter, data: encodeQuote({ tokenIn, tokenOut, amountIn, tickSpacing: ts }) })
  }
  let res, block, baseFee
  try {
    // The base fee from the block header, never from BASEFEE inside a fee-less eth_call (a node may report zero there).
    const head = await rpc(fetchImpl, rpcUrl, 'eth_getBlockByNumber', ['latest', false])
    if (!head || !QTY.test(String(head.number))) return out({ result: 'unknown', reason: 'rpc_unavailable' })
    block = String(head.number)
    baseFee = QTY.test(String(head.baseFeePerGas)) ? BigInt(head.baseFeePerGas) : null
    const raw = await rpc(fetchImpl, rpcUrl, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, block])
    if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(raw)) return out({ result: 'unknown', reason: 'rpc_unavailable' })
    res = decodeAggregate3Result(raw)
  } catch (_) { return out({ result: 'unknown', reason: 'rpc_unavailable' }) }
  if (res.length !== calls.length || res.some((r) => !r || !/^0x([0-9a-fA-F]{2})*$/.test(String(r.data)))) return out({ result: 'unknown', reason: 'rpc_unavailable' })
  const addrOf = (r) => (r && r.success && HEX_WORDS(r.data, 1) && /^0x0{24}/.test(r.data) ? '0x' + r.data.slice(26).toLowerCase() : null)
  // The pairing, read in the same batch as the quote: a Quoter that names another factory quotes another venue.
  if (addrOf(res[0]) !== deployment.factory) return out({ result: 'unknown', reason: 'quoter_mismatch' })
  const routerPaired = addrOf(res[1]) === deployment.factory
  let best = null, reverted = 0, quoted = 0, partial = 0, unreadable = 0
  spacings.forEach((ts, i) => {
    const poolR = res[poolAt + 2 * i], q = res[poolAt + 2 * i + 1]
    const pool = addrOf(poolR)
    // A getPool that failed or answered nonsense says nothing about whether the pool exists: unreadable, never absent.
    if (!pool) { unreadable++; return }
    if (/^0x0{40}$/.test(pool)) return
    quoted++
    // A revert is a pool skipped: never a zero, and never its revert data read as numbers.
    if (!q.success) { reverted++; return }
    if (!HEX_WORDS(q.data, 4)) { unreadable++; return }
    const h = q.data.slice(2)
    const amountOut = UINT(h, 0), sqrtAfter = UINT(h, 1), gas = UINT(h, 3)
    if (!(amountOut > 0n)) { unreadable++; return }
    if (hitLimit(tokenIn, tokenOut, sqrtAfter)) { partial++; return }
    if (!best || amountOut > best.amountOut) best = { amountOut, gas, ts, pool }
  })
  const pools = { quoted, reverted, partial, unreadable }
  if (!best) return unreadable ? out({ result: 'unknown', reason: 'quote_empty', pools, routerPaired }) : out({ result: 'no_route', pools, routerPaired })
  let gasUsd = null
  if (withGasPrice && baseFee != null && baseFee > 0n) {
    const eth = spacings.map((_, i) => res[ethAt + i]).filter((r) => r && r.success && HEX_WORDS(r.data, 4) && !hitLimit(BASE_WETH, BASE_USDC, UINT(r.data.slice(2), 1))).map((r) => UINT(r.data.slice(2), 0)).reduce((m, x) => (x > m ? x : m), 0n)
    // USD per ETH = USDC out (6 decimals) for 0.001 ETH, times 1000.
    if (eth > 0n) gasUsd = Number(best.gas * baseFee) / 1e18 * (Number(eth) / 1e6 * 1000)
  }
  return out({
    result: 'ok', amountIn: String(amountIn), amountOut: best.amountOut.toString(), gasUnits: Number(best.gas) || null, gasUsd: Number.isFinite(gasUsd) ? gasUsd : null,
    // The Quoter's estimate covers the pool's own swap: not the router, not the L1 data fee. Said so in the answer.
    gasBasis: 'pool_swap_only',
    route: { kind: 'single_pool', pools: [`aerodrome-cl-${best.ts}`], hops: 1, tick_spacing: best.ts, pool: best.pool },
    pool: best.pool, tickSpacing: best.ts, deployment, routerPaired, pools,
  })
}
