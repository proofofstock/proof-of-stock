// scripts/stocks/onchain-pools.test.mjs: the chain's reading of a pool is decoded the right way round, its liquidity
// replaces an aggregator's, a pool the chain cannot read is left to the aggregator, and the evidence is the exact call
// that gives the price back.
//
// Run: node scripts/stocks/onchain-pools.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MULTICALL3, ONCHAIN, SEL, encodeAggregate3, decodeAggregate3Calldata, encodeAggregate3Result, decodeAggregate3Result,
  priceFromSqrt, decodePool, mergeOnchain, learn, readBook, writeBook, BOOK_FILE, BOOK_MAX_PER_TOKEN, prepareOnchain,
  readTokenOnchain, evidenceOf, rpcUrlOf, saveOnchain,
} from './onchain-pools.mjs'
import { fakeChain, sqrtX96For } from './test-fake-chain.mjs'
import { eligiblePools, pegReading } from '../../evm/core/stocks/peg.mjs'
import { CHAINS } from './stock-peg.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const near = (a, b, tol = 1e-9) => Number.isFinite(a) && Math.abs(a / b - 1) < tol
const w = (n) => BigInt(n).toString(16).padStart(64, '0')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onchain-pools-'))

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', WETH = '0x4200000000000000000000000000000000000006'
const REFS = CHAINS.base.referenceAssets
// Stock tokens on both sides of USDC's address, so both orientations are exercised.
const LOW = '0x1100000000000000000000000000000000000011', HIGH = '0xb200000000000000000000000000000000000022'
const P1 = '0x' + 'a1'.repeat(20), P2 = '0x' + 'a2'.repeat(20), P3 = '0x' + 'a3'.repeat(20), V4ID = '0x' + 'c4'.repeat(32)

console.log('Multicall3 aggregate3 bytes')
{
  const calls = [{ to: P1, data: '0x' + SEL.slot0 }, { to: USDC, data: '0x' + SEL.balanceOf + '00'.repeat(12) + P1.slice(2) }]
  const cd = encodeAggregate3(calls)
  const back = decodeAggregate3Calldata(cd)
  check('calldata decodes back to the same calls, every one allowed to fail', back.length === 2 && back.every((c, i) => c.to === calls[i].to && c.data === calls[i].data && c.allowFailure))
  check('one call is laid out as the ABI says', encodeAggregate3([{ to: P1, data: '0xdeadbeef' }]) === '0x82ad56cb' + w(0x20) + w(1) + w(0x20) + '00'.repeat(12) + P1.slice(2) + w(1) + w(0x60) + w(4) + 'deadbeef' + '00'.repeat(28))
  check('one result is laid out as the ABI says', encodeAggregate3Result([{ success: true, data: '0x' + w(42) }]) === '0x' + w(0x20) + w(1) + w(0x20) + w(1) + w(0x40) + w(32) + w(42))
  const res = [{ success: true, data: '0x' + w(7) + w(8) }, { success: false, data: '0x' }, { success: true, data: '0x1234' }]
  const r2 = decodeAggregate3Result(encodeAggregate3Result(res))
  check('results round-trip, a failed call and an odd length included', JSON.stringify(r2) === JSON.stringify(res), JSON.stringify(r2))
}

console.log('prices from the pool')
{
  check('a sqrtPriceX96 of 2^96 between equal decimals is 1', priceFromSqrt(2n ** 96n, 18, 18) === 1)
  check('decimals are applied: 18 against 6', near(priceFromSqrt(sqrtX96For(3000, 18, 6), 18, 6), 3000))
  const dec = new Map([[LOW, 18], [HIGH, 18], [USDC, 6], [WETH, 18]])
  const ctx = { decimals: dec, usdOf: (a) => (a === USDC ? 1 : a === WETH ? 3000 : null), tokenUsd: 250 }
  const slot = (s) => ({ success: true, data: '0x' + w(s) + w(0) })
  const addr = (a) => ({ success: true, data: '0x' + '00'.repeat(12) + a.slice(2) })
  const bal = (n) => ({ success: true, data: '0x' + w(n) })
  // LOW < USDC: token0 is the stock token, price is USDC per token.
  const a = decodePool({ pool: P1, token: LOW, other: USDC, kind: 'own' }, { token0: addr(LOW), token1: addr(USDC), slot0: slot(sqrtX96For(250, 18, 6)), balT: bal(10n ** 20n), balO: bal(5000n * 10n ** 6n) }, ctx)
  check('token0 is ours: the price is token1 per token0', a.decoder === 'v3_slot0' && near(a.priceUsd, 250), JSON.stringify(a))
  check('liquidity is both balances in dollars, the token at the issuer price', near(a.liquidityUsd, 100 * 250 + 5000))
  // Base, 12.11: a pool whose slot0 said ~1e40 dollars a token held dust of it. At its own price that dust was "1e37
  // dollars" and outranked every real pool; at the issuer's price it is what it is.
  const absurd = decodePool({ pool: P1, token: LOW, other: USDC, kind: 'own' }, { token0: addr(LOW), token1: addr(USDC), slot0: slot(sqrtX96For(1e40, 18, 6)), balT: bal(10n ** 15n), balO: bal(3n * 10n ** 6n) }, ctx)
  check('a pool does not set its own depth: dust at an absurd price is dust', absurd.priceUsd > 1e39 && absurd.liquidityUsd < 4, String(absurd.liquidityUsd))
  const noRef = decodePool({ pool: P1, token: LOW, other: USDC, kind: 'own' }, { token0: addr(LOW), token1: addr(USDC), slot0: slot(sqrtX96For(250, 18, 6)), balT: bal(10n ** 20n), balO: bal(5000n * 10n ** 6n) }, { ...ctx, tokenUsd: null })
  check('with no issuer price only the stablecoin or WETH side counts', near(noRef.liquidityUsd, 5000), String(noRef.liquidityUsd))
  // HIGH > USDC: token0 is USDC, price inverts.
  const b = decodePool({ pool: P2, token: HIGH, other: USDC, kind: 'own' }, { token0: addr(USDC), token1: addr(HIGH), slot0: slot(sqrtX96For(1 / 400, 6, 18)), balT: bal(0n), balO: bal(10n ** 4n) }, ctx)
  check('token1 is ours: the price inverts', near(b.priceUsd, 400), String(b.priceUsd))
  check('an empty pool is priced but holds no liquidity', b.liquidityUsd < 0.02)
  const wethPool = decodePool({ pool: P3, token: LOW, other: WETH, kind: 'own' }, { token0: addr(LOW), token1: addr(WETH), slot0: slot(sqrtX96For(0.1, 18, 18)), balT: bal(0n), balO: bal(0n) }, ctx)
  check('against WETH the dollar leg is the ETH price', near(wethPool.priceUsd, 300))
  check('a pool whose tokens are not ours is not read', decodePool({ pool: P1, token: LOW, other: USDC, kind: 'own' }, { token0: addr(HIGH), token1: addr(USDC), slot0: slot(2n ** 96n) }, ctx).decoder === 'none')
  check('a pool that answers neither slot0 nor reserves is not read', decodePool({ pool: P1, token: LOW, other: USDC, kind: 'own' }, { token0: addr(LOW), token1: addr(USDC), slot0: { success: false, data: '0x' }, reserves: { success: false, data: '0x' } }, ctx).decoder === 'none')
  const res2 = { success: true, data: '0x' + w(10n ** 20n) + w(25_000n * 10n ** 6n) + w(1) }
  const v2 = decodePool({ pool: P1, token: LOW, other: USDC, kind: 'own' }, { token0: addr(LOW), token1: addr(USDC), slot0: { success: false, data: '0x' }, reserves: res2, stable: { success: false, data: '0x' } }, ctx)
  check('a constant-product pool is priced from its reserves', v2.decoder === 'v2_reserves' && near(v2.priceUsd, 250) && near(v2.liquidityUsd, 50_000), JSON.stringify(v2))
  check('a stable-curve pool is not read as constant product', decodePool({ pool: P1, token: LOW, other: USDC, kind: 'own' }, { token0: addr(LOW), token1: addr(USDC), reserves: res2, stable: { success: true, data: '0x' + w(1) } }, ctx).decoder === 'none')
  const v4 = decodePool({ pool: V4ID, token: HIGH, other: USDC, kind: 'v4' }, { v4: slot(sqrtX96For(1 / 400, 6, 18)) }, ctx)
  check('a v4 pool is oriented by sorted address, and has a price but no liquidity', v4.decoder === 'v4_stateview' && near(v4.priceUsd, 400) && v4.liquidityUsd === null && v4.token0 === USDC)
}

console.log('the chain wins over the aggregator')
{
  const agg = (over) => ({ pairAddress: P1, dexId: 'aerodrome', baseToken: { address: LOW, symbol: 'X' }, quoteToken: { address: USDC, symbol: 'USDC' }, priceUsd: '251', liquidity: { usd: 43_954 }, volume: { h24: 7 }, ...over })
  // Base, 12.11: DexScreener called a pool $43,954 deep that held $0.01.
  const phantom = new Map([[P1, { pool: P1, other: USDC, dexId: 'aerodrome', priceUsd: 250, liquidityUsd: 0.01, decoder: 'v3_slot0' }]])
  const m = mergeOnchain(LOW, [agg()], phantom, REFS)
  check('the chain\'s liquidity replaces the aggregator\'s', m[0].liquidity.usd === 0.01 && m[0].priceUsd === 250 && m[0]._crossPrice === 251)
  check('...so an empty pool DexScreener calls deep is not eligible', eligiblePools(LOW, m, 10_000, REFS).length === 0 && pegReading(LOW, { price_usd: 250 }, m, { referenceAssets: REFS }).premium_refused === 'no_eligible_pool')
  check('...and the aggregator\'s own fields stay (volume, dex)', m[0].volume.h24 === 7 && m[0].dexId === 'aerodrome')
  const q = mergeOnchain(HIGH, [agg({ baseToken: { address: USDC, symbol: 'USDC' }, quoteToken: { address: HIGH }, priceUsd: '1', priceNative: '0.0025' })], new Map([[P1, { pool: P1, other: USDC, priceUsd: 401, liquidityUsd: 90_000 }]]), REFS)
  const qr = pegReading(HIGH, { price_usd: 400 }, q, { referenceAssets: REFS })
  check('a quote-side pool takes the chain\'s price and keeps its side', qr.dex_price_usd === 401 && qr.pools.top[0].side === 'quote' && near(q[0]._crossPrice, 400))
  const v4 = mergeOnchain(LOW, [agg({ pairAddress: V4ID, dexId: 'uniswap', liquidity: { usd: 70_000 } })], new Map([[V4ID, { pool: V4ID, other: USDC, priceUsd: 250.5, liquidityUsd: null, decoder: 'v4_stateview' }]]), REFS)
  check('a v4 pool takes the chain\'s price and keeps the aggregator\'s liquidity', v4[0].priceUsd === 250.5 && v4[0].liquidity.usd === 70_000)
  const only = mergeOnchain(LOW, null, new Map([[P2, { pool: P2, other: USDC, dexId: 'uniswap', priceUsd: 249, liquidityUsd: 2e6 }]]), REFS, ONCHAIN.base.symbols)
  const or = pegReading(LOW, { price_usd: 250 }, only, { referenceAssets: REFS })
  check('with no aggregator list the chain\'s pools alone price the token', or.premium_refused === null && or.dex_pool === P2 && or.pools.top[0].quote_symbol === 'USDC' && or._best._onchain.pool === P2)
  const both = mergeOnchain(LOW, [agg()], new Map([[P2, { pool: P2, other: USDC, priceUsd: 249, liquidityUsd: 2e6 }]]), REFS)
  check('a pool only the chain knows is added beside the aggregator\'s, an aggregator pool the chain did not read stays', both.length === 2 && both[0].liquidity.usd === 43_954 && both[1].pairAddress === P2)
  const swapped = mergeOnchain(LOW, [agg({ quoteToken: { address: WETH } })], new Map([[P1, { pool: P1, other: USDC, priceUsd: 250, liquidityUsd: 50_000 }]]), REFS)
  check('where the chain says the pool is against another token, the chain\'s pair is taken and nothing is cross-checked', swapped[0].quoteToken.address === USDC && swapped[0]._crossPrice === null)
}

console.log('the pool book')
{
  const book = { pools: {}, decimals: {}, discovered_at: null }
  const MEME = '0x' + '77'.repeat(20)
  learn(book, LOW, [
    { pairAddress: P1, dexId: 'aerodrome', baseToken: { address: LOW }, quoteToken: { address: USDC } },
    { pairAddress: V4ID, dexId: 'uniswap', baseToken: { address: WETH }, quoteToken: { address: LOW } },
    { pairAddress: P2, dexId: 'uniswap', baseToken: { address: LOW }, quoteToken: { address: MEME } },
    { pairAddress: 'nonsense', baseToken: { address: LOW }, quoteToken: { address: USDC } },
  ], REFS, 'dexscreener', '2026-11-12T10:00:00.000Z')
  check('only pools against a reference asset are kept, by address', Object.keys(book.pools).sort().join() === [P1, V4ID].sort().join())
  check('a v4 pool id is kept as v4, with the other token', book.pools[V4ID].kind === 'v4' && book.pools[V4ID].other === WETH && book.pools[P1].kind === 'own')
  for (let i = 0; i < BOOK_MAX_PER_TOKEN + 5; i++) learn(book, HIGH, [{ pairAddress: '0x' + String(i).padStart(40, '0'), baseToken: { address: HIGH }, quoteToken: { address: USDC } }], REFS, 'dexscreener', new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString())
  const highs = Object.values(book.pools).filter((e) => e.token === HIGH)
  check('a token keeps at most BOOK_MAX_PER_TOKEN pools, the newest', highs.length === BOOK_MAX_PER_TOKEN && !book.pools['0x' + '0'.padStart(40, '0')])
  const dir = path.join(tmp, 'book'); fs.mkdirSync(dir)
  writeBook(dir, book)
  check('the book is written and read back', Object.keys(readBook(dir).pools).length === Object.keys(book.pools).length)
  fs.writeFileSync(path.join(dir, BOOK_FILE), '{broken')
  check('a broken book is relearned, not fatal', Object.keys(readBook(dir).pools).length === 0)
}

console.log('one run against a chain')
{
  const cfg = ONCHAIN.base
  const chain = fakeChain({ rpc: cfg.rpc })
  const ETHPOOL = '0x' + 'e7'.repeat(20)
  chain.erc20(USDC, 6, { [ETHPOOL]: 10n ** 15n, [P1]: 10n ** 4n, [P2]: 1_000_000n * 10n ** 6n, [P3]: 0n })
  chain.erc20(WETH, 18, { [P3]: 100n * 10n ** 18n })
  chain.erc20(LOW, 18, { [P1]: 10n ** 15n, [P2]: 4000n * 10n ** 18n, [P3]: 1000n * 10n ** 18n })
  chain.getPool(cfg.ethFactory, true, WETH, USDC, 500, ETHPOOL)
  chain.v3(ETHPOOL, WETH, USDC, sqrtX96For(3000, 18, 6))
  // P1 is listed by the aggregator (phantom); P2 is found by the Uniswap v3 factory; P3 is against WETH.
  chain.v3(P1, LOW, USDC, sqrtX96For(250, 18, 6))
  chain.getPool(cfg.factories[0].address, true, LOW, USDC, 3000, P2)
  chain.v3(P2, LOW, USDC, sqrtX96For(249, 18, 6))
  chain.v3(P3, LOW, WETH, sqrtX96For(249 / 3000, 18, 18))
  // A v4 pool against WETH that WOULD decode if read: skipping it must be a rule, not an accident.
  chain.v4(cfg.stateView, V4ID, sqrtX96For(249 / 3000, 18, 18))
  const fetchImpl = chain.fetch(async () => ({ ok: false, status: 404, json: async () => ({}) }))
  const dir = path.join(tmp, 'run'); fs.mkdirSync(dir)
  const st = await prepareOnchain({ chain: 'base', dir, tokens: [LOW], referenceAssets: REFS, fetchImpl, now: () => Date.parse('2026-11-12T12:00:00Z'), env: {} })
  check('the chain is set up: decimals, the WETH/USD pool, and the factories asked', st.ok && st.ethPool?.pool === ETHPOOL && st.decimals.get(USDC) === 6 && st.discovered === 1 && st.book.pools[P2]?.from === 'factory', JSON.stringify({ ok: st.ok, err: st.error, eth: st.ethPool, d: st.discovered }))
  learn(st.book, LOW, [{ pairAddress: P1, dexId: 'aerodrome', baseToken: { address: LOW }, quoteToken: { address: USDC } }, { pairAddress: P3, dexId: 'uniswap', baseToken: { address: LOW }, quoteToken: { address: WETH } }, { pairAddress: V4ID, dexId: 'uniswap', baseToken: { address: LOW }, quoteToken: { address: WETH } }], REFS, 'dexscreener', '2026-11-12T12:00:00.000Z')
  const before = chain.log.calls
  const got = await readTokenOnchain(st, fetchImpl, LOW, { tokenUsd: 249 })
  check('a token is read in one eth_call at one pinned block', chain.log.calls - before === 1 && [...chain.log.atBlocks].every((t) => t === '0x' + chain.block.toString(16)), JSON.stringify([...chain.log.atBlocks]))
  check('every pool the book holds for it is priced', got.reads.size === 3 && near(got.reads.get(P2).priceUsd, 249) && near(got.reads.get(P1).priceUsd, 250))
  check('a v4 pool against WETH is not read (native ETH or WETH cannot be told from its id)', !got.reads.has(V4ID))
  check('a pool against WETH is priced through the WETH/USD pool at the same block', near(got.reads.get(P3).priceUsd, 249) && near(got.reads.get(P3).liquidityUsd, 1000 * 249 + 100 * 3000) && got.reads.get(P3).usd_leg === 'weth_pool')
  check('the empty pool reads empty', got.reads.get(P1).liquidityUsd < 1)
  const ev = evidenceOf('base', got.reads.get(P3), got.block, got.calls, got.results)
  const evCalls = decodeAggregate3Calldata(ev.calldata)
  check('the evidence calldata is exactly the pool\'s calls and the WETH/USD leg', evCalls.length === 7 && evCalls.filter((c) => c.to === P3).length === 3 && evCalls.some((c) => c.to === ETHPOOL && c.data === '0x' + SEL.slot0), JSON.stringify(evCalls.map((c) => c.to + c.data.slice(0, 10))))
  const again = await fetchImpl(cfg.rpc, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: MULTICALL3, data: ev.calldata }, '0x' + ev.block_number.toString(16)] }) })
  check('calling it again returns return_data byte for byte', (await again.json()).result === ev.return_data)
  check('the evidence names the block, its hash, and a cast call at that block on the public RPC', ev.block_number === chain.block && ev.block_hash === chain.hash && ev.reproduce === `cast call --block ${chain.block} ${MULTICALL3} ${ev.calldata} --rpc-url ${cfg.rpc}` && ev.reproduce_needs === null)
  check('Robinhood\'s public RPC keeps no old state, and the evidence says so', ONCHAIN.robinhood.archive === false && ONCHAIN.base.archive === true && evidenceOf('robinhood', got.reads.get(P3), got.block, got.calls, got.results).reproduce_needs === 'archive_rpc')
  check('the decimals learned are kept for the next run', saveOnchain(st, dir) === null && readBook(dir).decimals[LOW] === 18)
  chain.down = true
  let threw = false
  try { await readTokenOnchain(st, fetchImpl, LOW) } catch (_) { threw = true }
  check('a chain that stops answering mid-run throws to the caller, which keeps the aggregator\'s reading', threw)
  const down = await prepareOnchain({ chain: 'base', dir, tokens: [LOW], referenceAssets: REFS, fetchImpl, now: () => Date.now(), env: {} })
  check('a chain that cannot be reached at the start is not used, and says why', down.ok === false && /503/.test(down.error))
  check('a token with nothing in the book is not read at all', (await readTokenOnchain({ ...st, book: { pools: {} } }, fetchImpl, HIGH)) === null)
}

console.log('the RPC')
{
  check('the public RPC by default', rpcUrlOf('base', {}).url === ONCHAIN.base.rpc && rpcUrlOf('base', {}).label === 'public')
  const c = rpcUrlOf('robinhood', { STP_RPC_ROBINHOOD: 'https://example.invalid/key' })
  check('an env URL replaces it, and is only ever called "custom"', c.url === 'https://example.invalid/key' && c.label === 'custom')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
