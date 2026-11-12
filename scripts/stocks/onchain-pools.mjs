// scripts/stocks/onchain-pools.mjs: a token's pools read from the chain itself, at one pinned block, through Multicall3 on
// the chain's public RPC. Used by scripts/stocks/stock-peg.mjs only.
//
// ⚠ THE CHAIN WINS, BUT NEVER COSTS A READING. Where the chain and an aggregator (DexScreener, GeckoTerminal) both see a
// pool, the pool's price and, for a pool with its own contract, its liquidity come from the chain (owner's decision,
// 12.11: on Base DexScreener counted pools holding about $0.01 as $40k deep). An RPC that fails leaves the aggregator's
// reading exactly as it was, and an aggregator that fails leaves the chain's.
//
// What is read, per pool kind (the selectors were checked against both chains on 12.11.2026):
//   own contract, slot0     Uniswap v3 and its forks (Aerodrome and Aero CL, Ramses, Sushi, Up, Pancake): token0(),
//                           token1(), slot0() (first word sqrtPriceX96), and each token's balanceOf(pool) for liquidity
//   own contract, reserves  constant-product pools: getReserves(); a pool whose stable() is true is a different curve
//                           and is not decoded
//   Uniswap v4              StateView.getSlot0(poolId): a price only. v4 keeps every pool's tokens in one PoolManager,
//                           so a pool's liquidity cannot be read, and the aggregator's figure stands. A v4 pool against
//                           WETH is not read at all: its currency may be native ETH, which sorts first, and the pool id
//                           alone does not say which (reading it the wrong way round inverts the price).
// A pool in USD: a dollar stable counts as $1; WETH is priced from the chain's deepest WETH/stable Uniswap v3 pool, read in
// the same call at the same block.
//
// ⚠ slot0 IS WHAT THE POOL SAID AT THAT BLOCK, NOT A FAIR PRICE. A pool can be pushed for a block; the premium is still
// gated by the liquidity floor, and the aggregator's price for the same pool is kept as a cross-check
// (evm/core/stocks/peg.mjs sources_disagree).
//
// Pools come from a pool book, <root>/stock-peg/pool-book.json: every pool an aggregator listed for a token against a
// reference asset, plus what the factories return for (token, reference asset, fee or tick spacing). The book lets the
// chain price a token on a run where DexScreener did not answer.
//
// The public RPCs count every call inside a JSON-RPC batch on its own (Robinhood: 25 a second; Base answered 429), so
// all reads go through Multicall3 aggregate3: one eth_call per chunk. STP_RPC_BASE / STP_RPC_ROBINHOOD replace the
// public URL (a keyed provider); the URL itself is never written anywhere, the evidence always names the public one.

import fs from 'node:fs'
import path from 'node:path'
import { tokenPriceIn } from '../../evm/core/stocks/peg.mjs'

export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const RPC_TIMEOUT_MS = 10_000
const CHUNK = 200
export const BOOK_FILE = 'pool-book.json'
export const BOOK_MAX_PER_TOKEN = 40
export const DISCOVERY_EVERY_MS = 6 * 3600e3
const CL_SPACINGS = [1, 10, 50, 100, 200, 2000]
const V3_FEES = [100, 500, 3000, 10000]

// Per chain. `archive`: whether the public RPC answers eth_call at an old block (measured 12.11: Base 120+ days, Robinhood
// under an hour); where it does not, the evidence says `reproduce_needs: "archive_rpc"`.
export const ONCHAIN = Object.freeze(Object.assign(Object.create(null), {
  base: {
    rpc: 'https://mainnet.base.org', env: 'STP_RPC_BASE', archive: true,
    stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71',
    ethFactory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
    symbols: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC', '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI', '0x4200000000000000000000000000000000000006': 'WETH' },
    // Discovery asks only against USDC and WETH: every eligible Base pool on 12.11 was against USDC.
    discoveryAssets: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x4200000000000000000000000000000000000006'],
    factories: [
      { dexId: 'uniswap', address: '0x33128a8fc17869897dce68ed026d694621f6fdfd', by: 'fee', params: V3_FEES },
      { dexId: 'aero', address: '0x9cb220581b91b0c83223012fe69688b92ad07a76', by: 'tickSpacing', params: CL_SPACINGS },
      { dexId: 'aerodrome', address: '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef', by: 'tickSpacing', params: CL_SPACINGS },
    ],
  },
  robinhood: {
    rpc: 'https://rpc.mainnet.chain.robinhood.com', env: 'STP_RPC_ROBINHOOD', archive: false,
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    ethFactory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    symbols: { '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG', '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH' },
    discoveryAssets: ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', '0x0bd7d308f8e1639fab988df18a8011f41eacad73'],
    factories: [
      { dexId: 'uniswap', address: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', by: 'fee', params: V3_FEES },
      { dexId: 'sushiswap', address: '0xe51960f1b45f1c9fb6d166e6a884f866fc70433b', by: 'fee', params: V3_FEES },
      { dexId: 'aero', address: '0xc63d7338c178e805c544b8f897066bd3bbcbe136', by: 'tickSpacing', params: CL_SPACINGS },
      { dexId: 'ramses', address: '0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8', by: 'tickSpacing', params: CL_SPACINGS },
      { dexId: 'up', address: '0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3', by: 'tickSpacing', params: CL_SPACINGS },
    ],
  },
}))

export const SEL = Object.freeze({
  aggregate3: '82ad56cb', token0: '0dfe1681', token1: 'd21220a7', slot0: '3850c7bd', getReserves: '0902f1ac', stable: '22be3de1',
  balanceOf: '70a08231', decimals: '313ce567', getSlot0: 'c815641c', getPoolByFee: '1698ee82', getPoolBySpacing: '28af8d0b',
})

const low = (s) => (typeof s === 'string' ? s.toLowerCase() : null)
const strip = (h) => String(h || '').replace(/^0x/, '')
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0')
const padRight = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0')
export const call = (to, sel, ...args) => ({ to: low(to), data: '0x' + sel + args.join('') })
export const args = { addr: addrWord, uint: word, int: (n) => word(BigInt.asUintN(256, BigInt(n))), bytes32: (h) => strip(h).padStart(64, '0') }

// ---- Multicall3 aggregate3: (address target, bool allowFailure, bytes callData)[] -> (bool success, bytes returnData)[]

/** Calldata for aggregate3, every call allowed to fail. */
export function encodeAggregate3 (calls) {
  const enc = calls.map((c) => { const d = strip(c.data); return addrWord(c.to) + word(1) + word(0x60) + word(d.length / 2) + padRight(d) })
  let off = calls.length * 32
  const offs = enc.map((e) => { const o = word(off); off += e.length / 2; return o })
  return '0x' + SEL.aggregate3 + word(0x20) + word(calls.length) + offs.join('') + enc.join('')
}
/** The return bytes aggregate3 gives for these results: what the node answers for encodeAggregate3 of the same calls. */
export function encodeAggregate3Result (results) {
  const enc = results.map((r) => { const d = strip(r.data); return word(r.success ? 1 : 0) + word(0x40) + word(d.length / 2) + padRight(d) })
  let off = results.length * 32
  const offs = enc.map((e) => { const o = word(off); off += e.length / 2; return o })
  return '0x' + word(0x20) + word(results.length) + offs.join('') + enc.join('')
}
const reader = (hex) => { const h = strip(hex); return { h, at: (b) => BigInt('0x' + (h.slice(b * 2, b * 2 + 64) || '0')), num: (b) => Number(BigInt('0x' + (h.slice(b * 2, b * 2 + 64) || '0'))) } }
export function decodeAggregate3Result (hex) {
  const { h, num } = reader(hex)
  const arr = num(0), n = num(arr), base = arr + 32, out = []
  if (!(n >= 0) || n > 100_000) throw new Error('aggregate3: bad result')
  for (let k = 0; k < n; k++) {
    const tp = base + num(base + k * 32), bp = tp + num(tp + 32), len = num(bp)
    out.push({ success: num(tp) === 1, data: '0x' + h.slice((bp + 32) * 2, (bp + 32 + len) * 2) })
  }
  return out
}
export function decodeAggregate3Calldata (hex) {
  const h = strip(hex)
  if (h.slice(0, 8) !== SEL.aggregate3) throw new Error('not aggregate3')
  const { num } = reader(h.slice(8))
  const body = h.slice(8), arr = num(0), n = num(arr), base = arr + 32, out = []
  for (let k = 0; k < n; k++) {
    const tp = base + num(base + k * 32), bp = tp + num(tp + 64), len = num(bp)
    out.push({ to: '0x' + body.slice(tp * 2 + 24, tp * 2 + 64), allowFailure: num(tp + 32) === 1, data: '0x' + body.slice((bp + 32) * 2, (bp + 32 + len) * 2) })
  }
  return out
}

// ---- RPC

async function rpc (fetchImpl, url, method, params) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`rpc answered ${r.status}`)
  const j = await r.json()
  if (!j || j.error || j.result == null) throw new Error('rpc: ' + String(j?.error?.message || 'no result').slice(0, 120))
  return j.result
}
export async function pinBlock (fetchImpl, url) {
  const b = await rpc(fetchImpl, url, 'eth_getBlockByNumber', ['latest', false])
  const number = parseInt(b?.number, 16)
  if (!(number > 0) || !/^0x[0-9a-f]{64}$/i.test(String(b?.hash))) throw new Error('rpc: no block')
  return { number, hash: b.hash.toLowerCase() }
}
/** Every call at one block, in chunks; results in order, each { success, data }. */
export async function multicall (fetchImpl, url, calls, blockNumber) {
  const out = []
  for (let i = 0; i < calls.length; i += CHUNK) {
    const part = calls.slice(i, i + CHUNK)
    const res = decodeAggregate3Result(await rpc(fetchImpl, url, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(part) }, '0x' + blockNumber.toString(16)]))
    if (res.length !== part.length) throw new Error('aggregate3: result count')
    out.push(...res)
  }
  return out
}

// ---- decoding

const ok32 = (r, words = 1) => r && r.success && strip(r.data).length >= 64 * words
const asAddr = (r) => (ok32(r) ? '0x' + strip(r.data).slice(24, 64).toLowerCase() : null)
const asUint = (r, i = 0) => (ok32(r, i + 1) ? BigInt('0x' + strip(r.data).slice(i * 64, i * 64 + 64)) : null)
const human = (raw, dec) => Number(raw) / 10 ** dec
/** token1 per token0, in whole tokens, from a sqrtPriceX96. */
export function priceFromSqrt (sqrtX96, dec0, dec1) {
  const s = Number(sqrtX96) / 2 ** 96
  return s * s * 10 ** (dec0 - dec1)
}

/** The calls that price one book entry. `decoder` known: only its calls; unknown: every candidate, to find out. */
export function poolCalls (e, cfg) {
  if (e.kind === 'v4') return [{ k: 'v4', c: call(cfg.stateView, SEL.getSlot0, args.bytes32(e.pool)) }]
  const all = !e.decoder || e.decoder === 'none'
  const out = [{ k: 'token0', c: call(e.pool, SEL.token0) }, { k: 'token1', c: call(e.pool, SEL.token1) }]
  if (all || e.decoder === 'v3_slot0') out.push({ k: 'slot0', c: call(e.pool, SEL.slot0) }, { k: 'balT', c: call(e.token, SEL.balanceOf, args.addr(e.pool)) }, { k: 'balO', c: call(e.other, SEL.balanceOf, args.addr(e.pool)) })
  if (all || e.decoder === 'v2_reserves') out.push({ k: 'reserves', c: call(e.pool, SEL.getReserves) }, { k: 'stable', c: call(e.pool, SEL.stable) })
  return out
}

/**
 * One book entry's on-chain reading from its call results: { decoder, priceUsd (our token), liquidityUsd (null for v4),
 * token0, token1 } or { decoder: 'none' } when the pool cannot be read as one of the kinds above.
 * `ctx`: { decimals: Map, usdOf(addr) -> number|null, tokenUsd: number|null }.
 *
 * ⚠ A POOL DOES NOT SET ITS OWN DEPTH. The stock token's side of a pool is valued at the ISSUER'S reference price
 * (`tokenUsd`), never at the pool's own price, and not at all when the issuer gives none: only the stablecoin or WETH
 * side counts then. Measured 12.11 on Base: two pools whose slot0 said ~1e40 dollars a token held dust of it, which at
 * their own price came to "1e37 dollars" deep and outranked every real pool.
 */
const depth = (tokens, otherUsd, tokenUsd) => otherUsd + (tokenUsd > 0 ? tokens * tokenUsd : 0)
export function decodePool (e, res, ctx) {
  const t = low(e.token), o = low(e.other)
  const dT = ctx.decimals.get(t), dO = ctx.decimals.get(o), usdO = ctx.usdOf(o)
  if (dT == null || dO == null || !(usdO > 0)) return null
  if (e.kind === 'v4') {
    const sqrt = asUint(res.v4)
    if (!(sqrt > 0n)) return { decoder: 'none' }
    const [t0, t1] = t < o ? [t, o] : [o, t]
    const p = priceFromSqrt(sqrt, ctx.decimals.get(t0), ctx.decimals.get(t1))
    const inOther = t0 === t ? p : 1 / p
    return { decoder: 'v4_stateview', token0: t0, token1: t1, priceUsd: inOther * usdO, liquidityUsd: null }
  }
  const t0 = asAddr(res.token0), t1 = asAddr(res.token1)
  if (!t0 || !t1 || !((t0 === t && t1 === o) || (t0 === o && t1 === t))) return { decoder: 'none' }
  const tIs0 = t0 === t
  const [d0, d1] = tIs0 ? [dT, dO] : [dO, dT]
  if (e.decoder !== 'v2_reserves' && asUint(res.slot0) > 0n) {
    const p = priceFromSqrt(asUint(res.slot0), d0, d1)
    const inOther = tIs0 ? p : 1 / p
    const bT = asUint(res.balT), bO = asUint(res.balO)
    const priceUsd = inOther * usdO
    const liquidityUsd = bT != null && bO != null ? depth(human(bT, dT), human(bO, dO) * usdO, ctx.tokenUsd) : null
    return { decoder: 'v3_slot0', token0: t0, token1: t1, priceUsd, liquidityUsd }
  }
  const r0 = asUint(res.reserves, 0), r1 = asUint(res.reserves, 1)
  if (r0 > 0n && r1 > 0n) {
    if (asUint(res.stable) === 1n) return { decoder: 'none' }
    const [rT, rO] = tIs0 ? [r0, r1] : [r1, r0]
    const inOther = human(rO, dO) / human(rT, dT)
    const priceUsd = inOther * usdO
    return { decoder: 'v2_reserves', token0: t0, token1: t1, priceUsd, liquidityUsd: depth(human(rT, dT), human(rO, dO) * usdO, ctx.tokenUsd) }
  }
  return { decoder: 'none' }
}

// ---- merging into the aggregator's pairs

/**
 * The aggregator's pairs with the chain's readings applied, in DexScreener's shape so evm/core/stocks/peg.mjs decides as
 * before. For a pool both see: the price is the chain's, and so is the liquidity unless the pool is v4; the aggregator's
 * own price for the token is kept as `_crossPrice`. A pool only the chain sees is added with our token on the base side.
 * Each pair the chain read carries `_onchain` (its reading), which the recorder turns into the row's evidence.
 */
export function mergeOnchain (token, aggPairs, reads, referenceAssets, symbols = {}) {
  const t = low(token), out = [], used = new Set()
  const fresh = (k, r) => ({ pairAddress: k, dexId: r.dexId ?? null, baseToken: { address: t, symbol: null }, quoteToken: { address: r.other, symbol: symbols[r.other] ?? null }, priceUsd: r.priceUsd, liquidity: { usd: r.liquidityUsd }, volume: { h24: null }, _onchain: r, _crossPrice: null })
  for (const p of Array.isArray(aggPairs) ? aggPairs : []) {
    const k = low(p?.pairAddress), r = k ? reads.get(k) : null
    if (!r) { out.push(p); continue }
    used.add(k)
    const isBase = low(p?.baseToken?.address) === t
    const otherOf = low(isBase ? p?.quoteToken?.address : p?.baseToken?.address)
    const cross = tokenPriceIn(t, p, referenceAssets)
    if (otherOf !== r.other) { out.push({ ...fresh(k, r), dexId: p.dexId ?? r.dexId ?? null, volume: p.volume ?? { h24: null }, _crossPrice: null }); continue }
    const q = { ...p, liquidity: { ...(p.liquidity || {}), usd: r.liquidityUsd != null ? r.liquidityUsd : p?.liquidity?.usd }, _onchain: r, _crossPrice: cross ? cross.price : null }
    if (isBase) q.priceUsd = r.priceUsd
    else q.quotePriceUsd = r.priceUsd
    out.push(q)
  }
  for (const [k, r] of reads) if (!used.has(k)) out.push(fresh(k, r))
  return out
}

// ---- the pool book

export function readBook (dir) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dir, BOOK_FILE), 'utf8'))
    if (b && typeof b.pools === 'object' && b.pools) return { pools: b.pools, decimals: b.decimals || {}, discovered_at: b.discovered_at || null }
  } catch (_) { /* a missing or broken book is relearned */ }
  return { pools: {}, decimals: {}, discovered_at: null }
}
export function writeBook (dir, book) {
  const f = path.join(dir, BOOK_FILE), tmp = f + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(book)); fs.renameSync(tmp, f)
}
/** Adds the pools an aggregator listed for `token` against a reference asset; keeps the newest BOOK_MAX_PER_TOKEN. */
export function learn (book, token, pairs, referenceAssets, from, atIso) {
  const t = low(token)
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const k = low(p?.pairAddress)
    if (!k || !(/^0x[0-9a-f]{40}$/.test(k) || /^0x[0-9a-f]{64}$/.test(k))) continue
    const b = low(p?.baseToken?.address), q = low(p?.quoteToken?.address)
    const other = b === t ? q : q === t ? b : null
    if (!other || !referenceAssets.has(other)) continue
    const prev = book.pools[k]
    book.pools[k] = { ...(prev || {}), pool: k, token: t, other, dex_id: typeof p.dexId === 'string' ? p.dexId : prev?.dex_id ?? null, kind: k.length === 66 ? 'v4' : 'own', from: prev?.from || from, seen_at: atIso }
  }
  const mine = Object.values(book.pools).filter((e) => e.token === t).sort((a, b) => String(b.seen_at).localeCompare(String(a.seen_at)))
  for (const e of mine.slice(BOOK_MAX_PER_TOKEN)) delete book.pools[e.pool]
}

// ---- one run

/** Writes the book back with what this run learned (decimals included). Never throws. */
export function saveOnchain (state, dir) {
  try { state.book.decimals = Object.fromEntries(state.decimals); writeBook(dir, state.book); return null } catch (e) { return String(e && e.message || e).slice(0, 200) }
}

export function rpcUrlOf (chain, env = process.env) {
  const cfg = ONCHAIN[chain]
  const custom = cfg && env[cfg.env]
  return { url: custom || cfg?.rpc || null, label: custom ? 'custom' : 'public' }
}

/**
 * Set up the chain's side of one run: the book, the reference assets' decimals, the WETH/USD pool, and (every
 * DISCOVERY_EVERY_MS) the factories' pools for the run's tokens. Never throws: a chain it cannot reach gives
 * `{ ok: false, error }`, and the run goes on with the aggregators alone.
 */
export async function prepareOnchain ({ chain, dir, tokens, referenceAssets, fetchImpl, now, env = process.env }) {
  const cfg = ONCHAIN[chain]
  const { url, label } = rpcUrlOf(chain, env)
  const book = readBook(dir)
  const state = { ok: false, error: null, rpc: label, cfg, url, book, referenceAssets, decimals: new Map(Object.entries(book.decimals)), ethPool: null, discovered: 0, read_tokens: 0, read_errors: 0 }
  if (!cfg || !url) { state.error = 'no rpc for this chain'; return state }
  try {
    const block = await pinBlock(fetchImpl, url)
    const refs = [...referenceAssets]
    const weth = refs.find((a) => cfg.symbols[a] === 'WETH') || null
    const stables = refs.filter((a) => a !== weth)
    const pre = [...refs.map((a) => call(a, SEL.decimals))]
    const ethCands = weth ? stables.flatMap((s) => V3_FEES.map((f) => ({ s, c: call(cfg.ethFactory, SEL.getPoolByFee, args.addr(weth), args.addr(s), args.uint(f)) }))) : []
    const res = await multicall(fetchImpl, url, [...pre, ...ethCands.map((x) => x.c)], block.number)
    refs.forEach((a, i) => { const d = asUint(res[i]); if (d != null && d <= 36n) state.decimals.set(a, Number(d)) })
    const found = ethCands.map((x, i) => ({ s: x.s, pool: asAddr(res[pre.length + i]) })).filter((x) => x.pool && !/^0x0{40}$/.test(x.pool))
    if (found.length) {
      const bal = await multicall(fetchImpl, url, found.map((x) => call(x.s, SEL.balanceOf, args.addr(x.pool))), block.number)
      const best = found.map((x, i) => ({ ...x, depth: (asUint(bal[i]) ?? 0n) * 10n ** BigInt(18 - (state.decimals.get(x.s) ?? 18)) })).sort((a, b) => (b.depth > a.depth ? 1 : -1))[0]
      if (best && best.depth > 0n) state.ethPool = { pool: best.pool, weth, stable: best.s }
    }
    state.ok = true
    if (!book.discovered_at || now() - Date.parse(book.discovered_at) >= DISCOVERY_EVERY_MS) {
      const asks = []
      for (const t of tokens) for (const a of cfg.discoveryAssets) for (const f of cfg.factories) for (const p of f.params) {
        asks.push({ t, a, f, c: call(f.address, f.by === 'fee' ? SEL.getPoolByFee : SEL.getPoolBySpacing, args.addr(t), args.addr(a), f.by === 'fee' ? args.uint(p) : args.int(p)) })
      }
      const got = await multicall(fetchImpl, url, asks.map((x) => x.c), block.number)
      const at = new Date(now()).toISOString()
      asks.forEach((x, i) => {
        const pool = asAddr(got[i])
        if (!pool || /^0x0{40}$/.test(pool) || book.pools[pool]) return
        book.pools[pool] = { pool, token: low(x.t), other: low(x.a), dex_id: x.f.dexId, kind: 'own', from: 'factory', seen_at: at }
        state.discovered++
      })
      book.discovered_at = at
    }
  } catch (e) {
    state.error = String(e && e.message || e).slice(0, 200)
  }
  return state
}

/**
 * One token's pools from the chain, at a block pinned for it. Returns null when there is nothing to read, else
 * { block, reads: Map(pool -> reading), calls, results, eth: { idx, ... } } for mergeOnchain and evidenceOf. Throws on an
 * RPC failure; the caller keeps the aggregator's reading.
 */
export async function readTokenOnchain (state, fetchImpl, token, { tokenUsd = null } = {}) {
  const { cfg, book, url } = state
  const t = low(token)
  const weth = state.ethPool?.weth || null
  const nowMs = Date.now()
  const entries = Object.values(book.pools).filter((e) => e.token === t && !(e.decoder === 'none' && nowMs - Date.parse(e.none_at || 0) < DISCOVERY_EVERY_MS) && !(e.kind === 'v4' && e.other === weth) && (e.other !== weth || state.ethPool))
  if (!entries.length) return null
  const calls = [], idx = []
  const add = (c) => { calls.push(c); return calls.length - 1 }
  const decT = state.decimals.has(t) ? null : add(call(t, SEL.decimals))
  let eth = null
  if (entries.some((e) => e.other === weth)) eth = { slot0: add(call(state.ethPool.pool, SEL.slot0)), token0: add(call(state.ethPool.pool, SEL.token0)) }
  for (const e of entries) idx.push(poolCalls(e, cfg).map((x) => ({ k: x.k, i: add(x.c) })))
  const block = await pinBlock(fetchImpl, url)
  const results = await multicall(fetchImpl, url, calls, block.number)
  if (decT != null) { const d = asUint(results[decT]); if (d != null && d <= 36n) state.decimals.set(t, Number(d)) }
  let ethUsd = null
  if (eth) {
    const s = asUint(results[eth.slot0]), w0 = asAddr(results[eth.token0])
    const dW = state.decimals.get(state.ethPool.weth), dS = state.decimals.get(state.ethPool.stable)
    if (s > 0n && w0 && dW != null && dS != null) {
      const wethIs0 = w0 === state.ethPool.weth
      const p = priceFromSqrt(s, wethIs0 ? dW : dS, wethIs0 ? dS : dW)
      ethUsd = wethIs0 ? p : 1 / p
    }
  }
  const stables = new Set([...state.referenceAssets].filter((a) => a !== weth))
  const ctx = { decimals: state.decimals, usdOf: (a) => (stables.has(a) ? 1 : a === weth ? ethUsd : null), tokenUsd }
  const reads = new Map()
  entries.forEach((e, j) => {
    const res = Object.fromEntries(idx[j].map((x) => [x.k, results[x.i]]))
    const r = decodePool(e, res, ctx)
    if (!r) return
    if (r.decoder === 'none') { if (e.kind !== 'v4') Object.assign(book.pools[e.pool], { decoder: 'none', none_at: new Date(nowMs).toISOString() }); return }
    if (e.kind !== 'v4') { book.pools[e.pool].decoder = r.decoder; delete book.pools[e.pool].none_at }
    if (!(r.priceUsd > 0) || !Number.isFinite(r.priceUsd)) return
    const used = idx[j].filter((x) => (r.decoder === 'v3_slot0' ? ['token0', 'token1', 'slot0', 'balT', 'balO'] : r.decoder === 'v2_reserves' ? ['token0', 'token1', 'reserves', 'stable'] : ['v4']).includes(x.k)).map((x) => x.i)
    const usdLeg = e.other === weth ? [eth.slot0, eth.token0] : []
    reads.set(e.pool, { ...r, pool: e.pool, dexId: e.dex_id, other: e.other, decimals: [state.decimals.get(r.token0), state.decimals.get(r.token1)], usd_leg: e.other === weth ? 'weth_pool' : 'stable_at_1', eth_pool: e.other === weth ? state.ethPool.pool : null, eth_usd: e.other === weth ? ethUsd : null, _idx: [...used, ...usdLeg] })
  })
  return { block, reads, calls, results }
}

/**
 * The row's `price_evidence` for a price the chain gave: the block, and the aggregate3 calldata of exactly the calls the
 * price used (the pool, and the WETH/USD pool when the pool is against WETH) with the bytes the node returned for them.
 * aggregate3 of those calls at that block returns `return_data` again, byte for byte; `reproduce` is that call.
 */
export function evidenceOf (chain, read, block, calls, results) {
  const cfg = ONCHAIN[chain]
  const calldata = encodeAggregate3(read._idx.map((i) => calls[i]))
  return {
    evidence: 'onchain', block_number: block.number, block_hash: block.hash, multicall: MULTICALL3, calldata,
    return_data: encodeAggregate3Result(read._idx.map((i) => results[i])),
    decoder: read.decoder, pool: read.pool, token0: read.token0, token1: read.token1, decimals: read.decimals,
    usd_leg: read.usd_leg, eth_pool: read.eth_pool,
    rpc: cfg.rpc, reproduce_needs: cfg.archive ? null : 'archive_rpc',
    reproduce: `cast call --block ${block.number} ${MULTICALL3} ${calldata} --rpc-url ${cfg.rpc}`,
  }
}
