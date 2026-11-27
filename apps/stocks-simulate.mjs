// apps/stocks-simulate.mjs: simulate_buy's orchestration (docs/simulate-buy-tz.md): what $X of a stock token would get
// right now, what getting out would return, and, with a wallet, whether that swap would revert for it. It decides the
// order of the calls; the answer is assembled by evm/core/stocks/simulate.mjs, which fetches nothing.
//
// The chains are one table (§11.1): each names its stable, its quote adapters, its RPC and the routers a swap may go to.
//   Base       primary: Aerodrome's own Quoter by eth_call (apps/simulate/quote-aerodrome.mjs); second line: KyberSwap
//   Robinhood  primary: KyberSwap's route API (apps/simulate/quote-kyberswap.mjs); no second line in v1
// The dry run is apps/simulate/sim-evm.mjs for both.
//
// ⚠ THE VERDICT COMES FIRST AND COSTS NOTHING OUTSIDE. Steps 1 to 4 (arguments, ticker, verdict, passport) read the
//   site's memory only, through the same data.find / data.verify / data.passport as find_stock_token, verify_stock_tokens
//   and stock_passport, against ONE registry snapshot. A refusal is answered before any aggregator or RPC call: a
//   look-alike is never priced, routed or simulated, so this cannot be used to find liquidity for one.
// ⚠ IT NEVER SIGNS AND NEVER SENDS. Quotes, eth_call and eth_estimateGas only; no key anywhere in the path.
// ⚠ THE WALLET IS USED FOR THIS ONE ANSWER. It goes to the aggregator's build and to the node, and nowhere else: it is
//   not cached, not logged and not counted.
// ⚠ SOMEONE ELSE'S API IS SHARED. Outgoing aggregator calls are capped per second for the whole server
//   (STP_AGGREGATOR_PER_S), and no client key may take more than its share of a second (AGGREGATOR_SHARE), so a few
//   addresses varying the amount past the cache cannot keep every other caller at "busy".

import { assemble, refusalOf, resolveTicker, minReceived, QUOTE_TTL_S } from '../evm/core/stocks/simulate.mjs'
import { rpcUrlOf } from '../scripts/stocks/onchain-pools.mjs'
import { KYBER_ROUTER, swapLink } from '../packages/proofofstock-guard/examples/agent-buy.mjs'
import { aerodromeQuote, encodeExactInputSingle, decodeAmountOut, SLIPSTREAM } from './simulate/quote-aerodrome.mjs'
import { kyberQuote, kyberBuild, decodeKyberReturn, BUSY_MARK } from './simulate/quote-kyberswap.mjs'
import { simulateSwap, rpcCall, STABLES, MIN_OUT_SLIPSTREAM, MIN_OUT_KYBER } from './simulate/sim-evm.mjs'

/** The global cap on outgoing aggregator calls per second, unless the host sets STP_AGGREGATOR_PER_S. */
export const AGGREGATOR_PER_S_DEFAULT = 12
/** The most of one second's cap a client key may take: a quarter, rounded down. A cap below MIN_FAIR_CAP is refused at
 * start, so the quarter always holds. */
export const AGGREGATOR_SHARE = 0.25
export const MIN_FAIR_CAP = 4
export const BUSY = 'the quote source is busy; try again in a few seconds'
export const BUSY_RETRY_S = 2
/** The whole answer's deadline, below the proxy's 25 s: what has not finished by then is `unknown` (timed_out). */
export const ANSWER_BUDGET_MS = 20_000
/** The deadline the dry-run swap carries, in seconds from now: far past the simulated block's time. */
export const SWAP_DEADLINE_S = 1200
// What is cached: quotes only. A dry run is per wallet and per block, and is never served again.
const CACHEABLE = new Set(['quote'])
const CACHE_MAX = 2000
const KYBER_HOST = 'aggregator-api.kyberswap.com'

/** The chains simulate_buy answers on: every one of them has an issuer list (the tool's chain enum). */
export const CHAINS_SIM = Object.freeze({
  base: Object.freeze({ vm: 'evm', chainId: 8453, stable: STABLES.base, primary: 'aerodrome', second: 'kyberswap', routers: Object.freeze(SLIPSTREAM.map((d) => d.router)), decodeOut: decodeAmountOut, minOutReason: MIN_OUT_SLIPSTREAM }),
  robinhood: Object.freeze({ vm: 'evm', chainId: 4663, stable: STABLES.robinhood, primary: 'kyberswap', second: null, routers: Object.freeze([KYBER_ROUTER]), decodeOut: decodeKyberReturn, minOutReason: MIN_OUT_KYBER }),
})

/**
 * @param {object} o
 * @param {object} o.data       { snapshot, find, verify, listProof, passport }: the site's own functions, from memory
 * @param {function} o.fetchImpl  every outside call goes through it (a test hands in a fake aggregator and node)
 * @param {object} [o.env]       STP_RPC_BASE / STP_RPC_ROBINHOOD (scripts/stocks/onchain-pools.mjs), STP_AGGREGATOR_PER_S
 * @param {string} [o.origin]    the public site, for the links
 */
export function createSimulator ({ data, fetchImpl, env = process.env, now = Date.now, log = () => {}, origin = 'https://proofofstock.xyz', aggregatorPerS = null, budgetMs = ANSWER_BUDGET_MS } = {}) {
  // Unset is the default; anything set must be a whole number, and at least MIN_FAIR_CAP. Zero, a word or a fraction is
  // a configuration error, refused at start, never quietly read as the default.
  const rawCap = aggregatorPerS ?? env.STP_AGGREGATOR_PER_S
  const unset = rawCap == null || rawCap === ''
  const perS = unset ? AGGREGATOR_PER_S_DEFAULT : /^\d+$/.test(String(rawCap).trim()) ? Number(String(rawCap).trim()) : NaN
  if (!Number.isInteger(perS)) throw new Error(`STP_AGGREGATOR_PER_S is not a whole number: simulate_buy needs a whole number of at least ${MIN_FAIR_CAP} aggregator calls a second`)
  const perClient = Math.floor(perS * AGGREGATOR_SHARE)
  // Below MIN_FAIR_CAP one client's single call is more than a quarter of the cap: the share could not keep its promise,
  // so such a cap is a configuration error, refused at start rather than served unfairly.
  if (perS < MIN_FAIR_CAP) throw new Error(`STP_AGGREGATOR_PER_S is ${perS}: simulate_buy needs at least ${MIN_FAIR_CAP}, so that no client takes more than a quarter of a second's aggregator calls`)
  const cache = new Map() // key -> { at, value }
  const decimals = new Map() // chain|address -> decimals, for the process's life
  let sec = -1, used = 0
  let byClient = new Map()
  const counters = { aggregator_calls: 0, rpc_calls: 0 }

  /** One permit for one aggregator call now, for `client`: the whole cap first, then the client's share of it. */
  function permit (client) {
    const s = Math.floor(now() / 1000)
    if (s !== sec) { sec = s; used = 0; byClient = new Map() }
    const mine = byClient.get(client) || 0
    if (used + 1 > perS) return false
    if (mine + 1 > perClient) return false
    used++; byClient.set(client, mine + 1)
    return true
  }
  /**
   * The fetch one answer uses: every aggregator call takes its permit at the moment it is sent, after the cache has
   * had its chance, so the cap counts calls that go out, in the second they go out. Without a permit the call is not
   * made, and the adapter answers `aggregator_busy`.
   */
  // `gate` is the answer's own: once it is sent (done) or its deadline has passed, no further call of it starts.
  const fetchFor = (client, gate) => (url, init) => {
    if (gate.done || now() >= gate.deadlineAt) return Promise.reject(new Error('the answer is already sent'))
    if (String(url).includes(KYBER_HOST)) {
      if (!permit(client)) return Promise.reject(new Error(BUSY_MARK))
      counters.aggregator_calls++
    } else counters.rpc_calls++
    return fetchImpl(url, init)
  }
  /** A cached answer for `key` within QUOTE_TTL_S, or a fresh one. Only CACHEABLE kinds are ever kept. */
  async function viaCache (kind, key, fresh) {
    if (!CACHEABLE.has(kind)) return fresh()
    const hit = cache.get(key)
    if (hit && now() - hit.at < QUOTE_TTL_S * 1000) return { ...hit.value, cached: true }
    const value = await fresh()
    // What could not be read is asked again next time: only an answer is kept.
    if (value && value.result && value.result !== 'unknown') {
      cache.set(key, { at: now(), value })
      if (cache.size > CACHE_MAX) for (const [k, v] of cache) if (now() - v.at >= QUOTE_TTL_S * 1000 || cache.size > CACHE_MAX) cache.delete(k)
    }
    return { ...value, cached: false }
  }
  const qKey = (chain, source, tokenIn, tokenOut, amountIn) => `${chain}|${source}|${tokenIn}|${tokenOut}|${amountIn}`

  async function tokenDecimals (f, chain, url, address) {
    const k = chain + '|' + address
    if (decimals.has(k)) return decimals.get(k)
    const r = await rpcCall(f, url, 'eth_call', [{ to: address, data: '0x313ce567' }, 'latest'])
    const d = r.ok && typeof r.result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.result) ? Number(BigInt(r.result)) : NaN
    if (!Number.isInteger(d) || d > 36) return null
    decimals.set(k, d)
    return d
  }

  /**
   * One answer: { status, body, headers?, busy? }. `input` is parseInput's; `client` the limiter's key of the caller.
   * A 503 is the verdict's own (no list, a held record) or "busy"; everything else is a 200 whose outcome says it.
   */
  async function run (input, opts = {}) {
    const gate = { done: false, deadlineAt: Infinity }
    try { return await answer(input, opts, gate) } finally { gate.done = true }
  }
  async function answer (input, { client = 'anonymous', startedAt = null } = {}, gate) {
    const { chain } = input
    const C = CHAINS_SIM[chain]
    const t0 = now()
    // The deadline runs from the request's arrival (before the rate gate), so the whole request stays under the proxy's.
    const deadlineAt = (Number.isFinite(startedAt) ? startedAt : t0) + budgetMs
    gate.deadlineAt = deadlineAt
    const f = fetchFor(client, gate)
    const links = { docs: `${origin}/docs/reference/tools.md#tool-simulate_buy` }
    const unavailable = (body) => ({ status: 503, body, headers: { 'retry-after': '60' } })
    // Past the answer's deadline a part is `unknown` (timed_out); the parts that finished are answered as they are.
    const timers = new Set()
    const inTime = (p, late) => {
      let tm
      const left = Math.max(0, deadlineAt - now())
      const timeout = new Promise((resolve) => { tm = setTimeout(() => resolve(late), left); timers.add(tm) })
      return Promise.race([p, timeout]).finally(() => { clearTimeout(tm); timers.delete(tm) })
    }
    const lateQuote = (source) => ({ result: 'unknown', reason: 'timed_out', source, quotedAt: null })

    // 1 to 3. One registry snapshot for the ticker, the verdict, the list proof and the passport.
    const snapshot = data.snapshot(chain)
    let address = input.byAddress ? input.token : null
    if (!address) {
      let found
      try { found = data.find(chain, input.token) } catch (e) { return unavailable({ error: e && e.public ? e.message : `the ${chain} registry is not loaded yet` }) }
      const r = resolveTicker(found, chain)
      if (r.refusal) return { status: 200, body: assemble({ input, refusal: r.refusal, candidates: r.candidates, listProof: data.listProof(chain, snapshot), stable: C.stable, links, now: t0 }) }
      // A held record goes through the verdict like any address, and gets its 503 with its reason there.
      address = r.address
    }
    const v = data.verify(chain, address, snapshot)
    if (v.status === 'unavailable') return unavailable(v.body)
    if (v.status !== 'ok') return { status: 400, body: v.body }
    const listProof = data.listProof(chain, snapshot)
    links.passport = v.body.passport ?? `${origin}/?chain=${chain}&address=${address}`
    let passport = null, current = null
    if (v.body.listed) {
      const p = await data.passport(chain, address, snapshot)
      if (p.status !== 200) return unavailable(p.body)
      passport = p.body
      // The issuer's own state now, from the verified snapshot: a reading of ours may be up to a day old.
      current = p.current || null
    }
    // 4. A refusal is assembled here, before any outside call.
    if (refusalOf(v.body, passport, current)) return { status: 200, body: assemble({ input, verify: v.body, listProof, passport, current, stable: C.stable, links, now: t0 }) }

    // 5 to 7. The quotes.
    const { url, label } = rpcUrlOf(chain, env)
    const stable = C.stable.address
    const amountIn = BigInt(Math.round(input.usd * 100)) * 10n ** BigInt(C.stable.decimals) / 100n
    if (chain === 'base') links.aerodrome = swapLink(address)
    const dec = await inTime(tokenDecimals(f, chain, url, address), null)
    const parts = { input, verify: v.body, listProof, passport, current, stable: C.stable, decimals: dec, links }
    const simArgs = { fetchImpl: f, chain, url, rpcLabel: label, wallet: input.wallet, token: address, amountIn, routers: C.routers, decodeOut: C.decodeOut, minOutReason: C.minOutReason, now, deadlineAt }
    const noRun = (reason) => simulateSwap({ ...simArgs, minOut: 0n, build: { ok: false, reason }, probePool: null })
    if (dec == null) {
      // No number from guessed decimals: the quote is unknown, and so is everything built on it.
      const u = { result: 'unknown', reason: 'decimals_unavailable', source: C.primary, quotedAt: null }
      return { status: 200, body: assemble({ ...parts, quote: u, second: C.second ? u : null, simulation: input.wallet ? strip(await noRun('no_quote')) : null, now: now() }) }
    }
    const aeroQ = (tokenIn, tokenOut, amt, withGasPrice) => viaCache('quote', qKey(chain, 'aerodrome', tokenIn, tokenOut, amt), () => aerodromeQuote({ fetchImpl: f, rpcUrl: url, tokenIn, tokenOut, amountIn: amt, now, withGasPrice }))
    const kyberQ = (tokenIn, tokenOut, amt) => viaCache('quote', qKey(chain, 'kyberswap', tokenIn, tokenOut, amt), () => kyberQuote({ fetchImpl: f, chain, tokenIn, tokenOut, amountIn: amt, now }))
    let quote, second = null
    if (C.primary === 'aerodrome') {
      ;[quote, second] = await Promise.all([inTime(aeroQ(stable, address, amountIn, true), lateQuote('aerodrome')), inTime(kyberQ(stable, address, amountIn), lateQuote('kyberswap'))])
      if (quote.result === 'unknown') logOnce(quote.reason, 'aerodrome', chain)
      if (second.result === 'unknown' && second.reason === 'quote_mismatch') logOnce('quote_mismatch', 'kyberswap', chain)
      if (quote.result === 'ok' && second.result === 'ok') second = { ...second, samePool: Array.isArray(second.poolAddresses) && second.poolAddresses.length === 1 && second.poolAddresses[0] === quote.pool }
    } else {
      quote = await inTime(kyberQ(stable, address, amountIn), lateQuote('kyberswap'))
      // On Robinhood Chain the aggregator is the only source: a buy quote refused for the cap is the answer.
      if (quote.result === 'unknown' && quote.reason === 'aggregator_busy') return { status: 503, busy: true, body: { error: BUSY, retry_after_s: BUSY_RETRY_S }, headers: { 'retry-after': String(BUSY_RETRY_S) } }
      if (quote.result === 'unknown' && quote.reason === 'quote_mismatch') logOnce('quote_mismatch', 'kyberswap', chain)
    }

    // 7 and 8 together: the sell-back and, with a wallet, the dry run, both after the buy quote and each in time.
    const sellQ = () => (quote.result !== 'ok' ? Promise.resolve(null) : C.primary === 'aerodrome' ? aeroQ(address, stable, BigInt(quote.amountOut), false) : kyberQ(address, stable, BigInt(quote.amountOut)))
    async function dryRun (q) {
      // Never cached: per wallet and per block.
      return viaCache('simulation', null, async () => {
        if (!q || q.result !== 'ok') return noRun('no_quote')
        const minOut = minReceived(q.amountOut, input.slippageBps)
        let build
        if (C.primary === 'aerodrome') {
          // Our own encoding of the swap the quote chose, to the router pinned with that pool's factory; the stable goes
          // to that pool.
          // A deadline well past the simulated block's time (that block is the read block's child, seconds later).
          const deadline = Math.floor(now() / 1000) + SWAP_DEADLINE_S
          build = q.routerPaired ? { ok: true, to: q.deployment.router, payTo: q.pool, deadline, data: encodeExactInputSingle({ tokenIn: stable, tokenOut: address, tickSpacing: q.tickSpacing, recipient: input.wallet, deadline, amountIn, amountOutMinimum: minOut }) } : { ok: true, to: '0x' + '0'.repeat(40), data: '0x' }
        } else build = await kyberBuild({ fetchImpl: f, chain, routeSummary: q.routeSummary, wallet: input.wallet, slippageBps: input.slippageBps, tokenIn: stable, tokenOut: address, amountIn, deadline: Math.floor(now() / 1000) + SWAP_DEADLINE_S })
        if (build.reason === 'build_mismatch' || build.reason === 'build_unverified') logOnce(build.reason, 'kyberswap build', chain)
        const s = await simulateSwap({ ...simArgs, minOut, build, probePool: C.primary === 'aerodrome' ? q.pool : q.deliveringPool })
        if (s.reason === 'override_unverified') logOnce('override_unverified', 'the stable slot table', chain)
        return s
      })
    }
    const lateSim = { wallet: input.wallet, head_block: null, rpc: label, wallet_state: { stable_balance_enough: null, allowance_enough: null, gas_balance_enough: null }, simulated_with: [], result: 'unknown', reason: 'timed_out', revert: null, amount_out_simulated_base_units: null, gas_units: null }
    const [sellBack, sim] = await Promise.all([
      inTime(sellQ(), lateQuote(C.primary)),
      input.wallet ? inTime(dryRun(quote), lateSim) : Promise.resolve(null),
    ])
    if (sellBack && sellBack.result === 'unknown' && sellBack.reason === 'quote_mismatch') logOnce('quote_mismatch', 'sell-back', chain)
    for (const tm of timers) clearTimeout(tm)
    return { status: 200, body: assemble({ ...parts, quote, sellBack, second, simulation: sim ? strip(sim) : null, now: now() }) }
  }
  const strip = (s) => { const { cached: _c, ...rest } = s || {}; return rest }
  const logged = new Map()
  function logOnce (reason, what, chain) {
    const k = reason + what + chain
    if (logged.get(k) && now() - logged.get(k) < 600e3) return
    logged.set(k, now())
    log(`[simulate] ${chain}: ${what} answered ${reason}`)
  }
  return { run, counters, cap: { perS, perClient } }
}
