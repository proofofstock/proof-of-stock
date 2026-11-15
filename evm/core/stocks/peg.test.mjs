// evm/core/stocks/peg.test.mjs: the premium is DEX price over a TOKEN-unit reference, the multiplier is never
// applied twice, every null premium names its reason, and an issuer list is read whole or not at all.
//
// Run: node evm/core/stocks/peg.test.mjs

import fs from 'node:fs'
import { pegReading, eligiblePools, DEXSCREENER_PAIR_CAP, PEG_REFUSALS, MAX_SOURCE_DISAGREEMENT } from './peg.mjs'
import { POOL_SOURCES } from '../../../schemas/v2/enums.mjs'
import { readCoinbase, readRobinhood, COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from './registries.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const near = (a, b) => a != null && Math.abs(a - b) < 1e-12

const T = '0x' + 'ab'.repeat(20)
const pair = (over = {}) => ({ pairAddress: '0x' + 'cd'.repeat(20), dexId: 'uniswap', baseToken: { address: T.toUpperCase().replace('0X', '0x') }, quoteToken: { symbol: 'USDC' }, priceUsd: '101', liquidity: { usd: 50_000 }, volume: { h24: 1234 }, ...over })

console.log('peg reading')
{
  const r = pegReading(T, { price_usd: 100 }, [pair()])
  check('premium is DEX price over the reference, minus one', near(r.premium, 0.01), String(r.premium))
  check('a reading with a premium has no refusal', r.premium_refused === null)
  check('the deepest pool is the one priced', r.dex_pool === '0x' + 'cd'.repeat(20) && r.dex_price_usd === 101)

  // A Coinbase NAV already carries the multiplier; so do Robinhood's tokenBid/tokenAsk. Applying it again would
  // invent a premium the size of the multiplier.
  const withMult = pegReading(T, { price_usd: 100, multiplier: 1.011 }, [pair({ priceUsd: '100' })])
  check('a token at its reference shows no premium whatever its multiplier', near(withMult.premium, 0), String(withMult.premium))

  const deep = pegReading(T, { price_usd: 100 }, [pair({ pairAddress: '0x' + '11'.repeat(20), priceUsd: '90', liquidity: { usd: 20_000 } }), pair({ pairAddress: '0x' + '22'.repeat(20), priceUsd: '102', liquidity: { usd: 900_000 } })])
  check('of two eligible pools the deeper one prices the token', near(deep.premium, 0.02) && deep.dex_pool === '0x' + '22'.repeat(20), JSON.stringify(deep))

  check('no reference → no_reference', pegReading(T, { price_usd: null }, [pair()]).premium_refused === 'no_reference')
  check('a zero reference is no reference', pegReading(T, { price_usd: 0 }, [pair()]).premium_refused === 'no_reference')
  check('a failed pair read → pairs_unavailable', pegReading(T, { price_usd: 100 }, null).premium_refused === 'pairs_unavailable')
  check('no pairs → no_pairs', pegReading(T, { price_usd: 100 }, []).premium_refused === 'no_pairs')
  check('a pool under the liquidity floor is not a price', pegReading(T, { price_usd: 100 }, [pair({ liquidity: { usd: 9_999 } })]).premium_refused === 'no_eligible_pool')
  check('a pool that does not hold the token is not its price', pegReading(T, { price_usd: 100 }, [pair({ baseToken: { address: '0x' + 'ee'.repeat(20) } })]).premium_refused === 'no_eligible_pool')
  // Our token on the QUOTE side: DexScreener's priceUsd is the base's price, priceNative the base in quote units.
  const qs = pegReading(T, { price_usd: 100 }, [pair({ baseToken: { address: '0x' + 'ee'.repeat(20), symbol: 'USDC' }, quoteToken: { address: T }, priceUsd: '1.0', priceNative: '0.0098', liquidity: { usd: 80_000 } })])
  check('a quote-side pool is priced by inversion: priceUsd / priceNative', qs.premium_refused === null && Math.abs(qs.dex_price_usd - 1 / 0.0098) < 1e-9 && Math.abs(qs.premium - (1 / 0.0098 / 100 - 1)) < 1e-12, JSON.stringify(qs))
  check('...and says which side it read, naming the other token', qs.pools.top[0].side === 'quote' && qs.pools.top[0].quote_symbol === 'USDC')
  const gq = pegReading(T, { price_usd: 100 }, [pair({ baseToken: { address: '0x' + 'ee'.repeat(20) }, quoteToken: { address: T }, priceUsd: '1', quotePriceUsd: 99, liquidity: { usd: 80_000 } })])
  check('a direct quote price (GeckoTerminal) wins over inversion', Math.abs(gq.dex_price_usd - 99) < 1e-12)
  const wide = pegReading(T, { price_usd: 100, bid: 97, ask: 103, spread: 0.06 }, [pair()])
  check('a reference quote wider than 1% refuses the premium, keeping the DEX price', wide.premium === null && wide.premium_refused === 'reference_spread_wide' && wide.dex_price_usd === 101)
  check('...and says whether the DEX price sits inside the quote', wide.dex_inside_quote === true)
  const crossed = pegReading(T, { price_usd: 100, bid: 101, ask: 99, spread: -0.02 }, [pair()])
  check('a crossed quote is refused too', crossed.premium_refused === 'reference_spread_wide' && crossed.dex_inside_quote === null)
  const tight = pegReading(T, { price_usd: 100, bid: 99.9, ask: 100.1, spread: 0.002 }, [pair()])
  check('a tight quote keeps the premium; the DEX price outside it is said', tight.premium_refused === null && tight.dex_inside_quote === false)
  // Robinhood Chain, 09.11: memecoins paired with a stock token. Read back out of them, DJT came to ~$990.
  const USD = '0x' + '5f'.repeat(20), MEME = '0x' + '77'.repeat(20)
  const refs = new Set([USD])
  const memePool = pair({ pairAddress: '0x' + '33'.repeat(20), baseToken: { address: MEME, symbol: 'IALI' }, quoteToken: { address: T }, priceUsd: '0.0001', priceNative: '0.0000001', liquidity: { usd: 5_000_000 } })
  const usdPool = pair({ pairAddress: '0x' + '44'.repeat(20), quoteToken: { address: USD, symbol: 'USDG' }, priceUsd: '4.1', liquidity: { usd: 40_000 } })
  const circ = pegReading(T, { price_usd: 4.095 }, [memePool, usdPool], { referenceAssets: refs })
  check('a pool against a memecoin does not price a stock token, however deep', circ.dex_pool === '0x' + '44'.repeat(20) && Math.abs(circ.premium - (4.1 / 4.095 - 1)) < 1e-12 && circ.pools.eligible === 1, JSON.stringify(circ))
  check('...on the base side too', pegReading(T, { price_usd: 4.095 }, [pair({ quoteToken: { address: MEME, symbol: 'GOO' }, priceUsd: '9' })], { referenceAssets: refs }).premium_refused === 'no_eligible_pool')
  check('...and a look-alike symbol is not the reference asset: the address is', pegReading(T, { price_usd: 4.095 }, [pair({ quoteToken: { address: MEME, symbol: 'USDG' }, priceUsd: '4.1' })], { referenceAssets: refs }).premium_refused === 'no_eligible_pool')
  check('a quote-side pool against the stable still prices it', pegReading(T, { price_usd: 100 }, [pair({ baseToken: { address: USD, symbol: 'USDG' }, quoteToken: { address: T }, priceUsd: '1', priceNative: '0.0099', liquidity: { usd: 80_000 } })], { referenceAssets: refs }).premium_refused === null)

  check('every refusal is one of the schema enum', ['no_reference', 'pairs_unavailable', 'no_pairs', 'no_eligible_pool', 'sources_disagree', 'reference_spread_wide'].every((x) => PEG_REFUSALS.includes(x)) && PEG_REFUSALS.length === 6)
  {
    const schema = JSON.parse(fs.readFileSync(new URL('../../../schemas/v2/stock-peg.schema.json', import.meta.url), 'utf8'))
    const inSchema = schema.properties.premium_refused.enum.filter((x) => x !== null)
    check('the refusals in schemas/v2/enums.mjs are the schema enum, in order', JSON.stringify(inSchema) === JSON.stringify([...PEG_REFUSALS]), JSON.stringify(inSchema))
    check('the pool sources in schemas/v2/enums.mjs are the schema enum', JSON.stringify(schema.properties.pools.properties.source.enum) === JSON.stringify([...POOL_SOURCES]))
  }

  // The chain and an aggregator both priced the deepest pool (scripts/stocks/onchain-pools.mjs mergeOnchain keeps the
  // aggregator's price as _crossPrice): past MAX_SOURCE_DISAGREEMENT neither is trusted.
  const agreeing = pegReading(T, { price_usd: 100 }, [pair({ priceUsd: '101', _crossPrice: 101.5 })])
  check('the chain and the aggregator within 2% keep the premium, at the chain\'s price', agreeing.premium_refused === null && agreeing.dex_price_usd === 101)
  const apart = pegReading(T, { price_usd: 100 }, [pair({ priceUsd: '101', _crossPrice: 110 })])
  check('the chain and the aggregator more than 2% apart refuse the premium as sources_disagree', apart.premium === null && apart.premium_refused === 'sources_disagree' && apart.dex_price_usd === 101, JSON.stringify(apart.premium_refused))
  check('...the threshold is 2%', MAX_SOURCE_DISAGREEMENT === 0.02)
  check('a pool only one source priced is not a disagreement', pegReading(T, { price_usd: 100 }, [pair({ priceUsd: '101', _crossPrice: null })]).premium_refused === null)
  const missing = pegReading(T, { price_usd: null }, [pair({ priceUsd: '101', _crossPrice: 150 })])
  check('no reference is still decided first', missing.premium_refused === 'no_reference')
  check('the deepest pair is handed back for the evidence', apart._best && apart._best._crossPrice === 110)

  const capped = pegReading(T, { price_usd: 100 }, Array.from({ length: DEXSCREENER_PAIR_CAP }, () => pair()))
  check('exactly the source cap of pairs is marked capped', capped.pools.capped === true && capped.pools.seen === DEXSCREENER_PAIR_CAP)
  check('the row keeps at most five pools', capped.pools.top.length === 5 && capped.pools.eligible === DEXSCREENER_PAIR_CAP)
  check('eligible pools match the address in any case', eligiblePools(T.toUpperCase().replace('0X', '0x'), [pair()]).length === 1)
}

console.log('registries')
const fakeFetch = (routes) => async (url) => {
  const u = String(url)
  for (const [k, v] of Object.entries(routes)) {
    if (u.startsWith(k)) {
      const r = typeof v === 'function' ? v(u) : v
      if (r instanceof Error) throw r
      return { ok: r.status == null || r.status < 400, status: r.status ?? 200, json: async () => r.body }
    }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}
{
  let call = 0
  const pages = fakeFetch({
    [COINBASE_URL]: (u) => {
      call++
      if (!u.includes('page_token')) return { body: { tokens: [{ contract_address: '0x' + 'AA'.repeat(20), symbol: 'NVDAc', isin: 'US1', multiplier: '1.011', nav_price: '180.5', nav_price_updated_at: '2026-11-07T20:00:00Z', total_supply: '12' }], next_page_token: 'p2' } }
      return { body: { tokens: [{ contract_address: '0x' + 'bb'.repeat(20), symbol: 'XYZc', multiplier: '1' }] } }
    },
  })
  const cb = await readCoinbase(pages, { chainId: 8453 })
  check('coinbase: every page is read', cb.length === 2 && call === 2)
  check('coinbase: addresses are lower-cased', cb[0].address === '0x' + 'aa'.repeat(20))
  check('coinbase: the reference is the NAV, total return', cb[0].reference.kind === 'nav_total_return' && cb[0].reference.price_usd === 180.5)
  check('coinbase: an absent NAV is null, not zero', cb[1].reference.price_usd === null)
  check('coinbase: an absent supply means not minted', cb[0].supplied === true && cb[1].supplied === false)

  let threw = false
  try { await readCoinbase(fakeFetch({ [COINBASE_URL]: (u) => (u.includes('page_token') ? { status: 503, body: {} } : { body: { tokens: [{ contract_address: '0x' + 'aa'.repeat(20) }], next_page_token: 'p2' } }) }), { chainId: 8453 }) } catch (_) { threw = true }
  check('coinbase: a failed second page throws instead of returning half a list', threw)
}
{
  const assets = { assets: [
    { tokenSymbol: 'NVDA', isin: 'US67066G1040', currentMultiplier: '1.001148322800714293', pendingMultiplier: '', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: '0x' + 'CC'.repeat(20) }] },
    { tokenSymbol: 'ELSE', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 1, contractAddress: '0x' + 'dd'.repeat(20) }] },
  ] }
  const quotes = { quotes: [{ tokenSymbol: 'NVDA', bid: '190', ask: '191', tokenBid: '190.2', tokenAsk: '190.4', isTradingHalt: false, generatedAt: '2026-11-08T12:00:00Z' }] }
  const rh = await readRobinhood(fakeFetch({ [ROBINHOOD_ASSETS_URL]: { body: assets }, [ROBINHOOD_PRICES_URL]: { body: quotes } }), { chainId: 4663 })
  check('robinhood: only deployments on chain 4663 are listed', rh.length === 1 && rh[0].address === '0x' + 'cc'.repeat(20))
  check('robinhood: the reference is the TOKEN bid/ask mid, not the share bid/ask', near(rh[0].reference.price_usd, 190.3), String(rh[0].reference.price_usd))
  check('robinhood: the bid and ask kept beside it are the token ones too', rh[0].reference.bid === 190.2 && rh[0].reference.ask === 190.4)
  check('robinhood: the multiplier is recorded, an empty pending one is null', near(rh[0].multiplier, 1.001148322800714) && rh[0].multiplier_pending === null)
  check('robinhood: the halt flag is carried', rh[0].reference.halted === false)
  check('robinhood: the spread is recorded as (ask - bid) / mid', Math.abs(rh[0].reference.spread - 0.2 / 190.3) < 1e-12)
  check('robinhood: the server time is kept apart as quoted_at', rh[0].reference.quoted_at === '2026-11-08T12:00:00.000Z')
  const noToken = await readRobinhood(fakeFetch({ [ROBINHOOD_ASSETS_URL]: { body: { assets: [{ ...assets.assets[0], currentMultiplier: '2' }] } }, [ROBINHOOD_PRICES_URL]: { body: { quotes: [{ tokenSymbol: 'NVDA', bid: '100', ask: '101', isTradingHalt: false, generatedAt: '2026-11-08T12:00:00Z' }] } } }), { chainId: 4663 })
  check('robinhood: without tokenBid/tokenAsk the share quote is scaled by the multiplier', noToken[0].reference.bid === 200 && noToken[0].reference.ask === 202)

  const noPrices = await readRobinhood(fakeFetch({ [ROBINHOOD_ASSETS_URL]: { body: assets }, [ROBINHOOD_PRICES_URL]: { status: 500, body: {} } }), { chainId: 4663 })
  check('robinhood: prices down → the list stands, the reference is null', noPrices.length === 1 && noPrices[0].reference.price_usd === null)
  let threw = false
  try { await readRobinhood(fakeFetch({ [ROBINHOOD_ASSETS_URL]: { status: 500, body: {} } }), { chainId: 4663 }) } catch (_) { threw = true }
  check('robinhood: a failed asset list throws', threw)
}

{
  let threw = false
  try { await readCoinbase(async () => ({ ok: true, status: 200, json: async () => ({ tokens: [] }) })) } catch (_) { threw = true }
  check('a reader without a chain id refuses rather than guessing a chain', threw)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
