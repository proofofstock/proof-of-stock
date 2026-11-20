// evm/core/stocks/peg.mjs: how far a tokenized stock's DEX price sits from its issuer's reference price.
//
// Pure. The recorder (scripts/stocks/stock-peg.mjs) feeds it an issuer record and the DEX pairs it read, and writes
// what comes back. Nothing here fetches.
//
// ⚠ NEVER MULTIPLY BY THE MULTIPLIER HERE. Both references this module accepts are already in TOKEN units:
//   - Coinbase (Base): `nav_price` is a Chainlink total-return value, the corporate-action multiplier already in it;
//   - Robinhood: `tokenBid` / `tokenAsk` are the share's bid/ask already scaled to one token. The plain `bid` / `ask`
//     beside them are the SHARE's prices and are not a reference for a token, so the recorder does not read them.
// A token whose multiplier is 1.011 would otherwise show a 1.1% premium that is pure arithmetic. The multiplier is
// still recorded on every row, so a reader can see it, it is just never applied twice.
//
// ⚠ A STALE REFERENCE IS RECORDED, NOT REFUSED. Feeds hold their last value while the exchange is closed, and how the
// DEX price drifts against that held value over a weekend or a holiday is exactly what this series is for. So the
// row carries the reference's age and the premium against it; whether that age is too old is the READER's decision,
// made per question. Only a reference that is missing is a refusal.

export const MIN_POOL_LIQUIDITY_USD = 10_000
// A reference quote wider than this (ask − bid over mid), or crossed, is too loose to judge an on-chain price against.
// Measured 08-09.11: Robinhood's weekend quotes run several percent wide, so a mid against them reads as a gap that is
// mostly the quote's own spread.
export const MAX_REFERENCE_SPREAD = 0.01
export const TOP_POOLS = 5
// DexScreener's token-pairs endpoint returns at most this many pairs: a token that shows exactly this many may have more.
export const DEXSCREENER_PAIR_CAP = 30
// When the chain and an aggregator both price the deepest pool and their prices for the token differ by more than this,
// neither is trusted and the premium is refused (sources_disagree). Measured 12.11 over every eligible pool: at most 0.2%
// for pools with their own contract, 1% for one Uniswap v4 pool. A default the owner may still change; Infinity turns it off.
export const MAX_SOURCE_DISAGREEMENT = 0.02

/**
 * How many times the issuer's price a pool may say before we stop believing the pool rather than the market.
 *
 * A tokenized stock that really moved away from its share moves by percent: an outside report of this market in
 * November 2026 put the typical distance at a fraction of a percent and the wide moments above one percent. Our own
 * readings agree in the middle and disagreed wildly in the tail: on 16.11 one token was recorded at a premium of
 * 7740%, a pool pricing it at $341 against an issuer price of $4.36, a factor of 78. That is not a market gap, it is
 * a pool that is not this token's: a different coin with the same symbol, a wrong quote asset, or decimals.
 *
 * So four, and the bound is a RATIO, not a percentage: anything between a quarter and four times the issuer's price
 * is still reported as a premium, however shocking, because a real depeg must never be hidden by a safety rail. Past
 * that we refuse the premium and say what the pool said instead, which is both more honest and more useful than a
 * number with four digits in front of the decimal point.
 */
export const MAX_PLAUSIBLE_RATIO = 4

// Refusals, in the order they are decided; a null premium always comes with exactly one. The list itself lives in
// schemas/v2/enums.mjs, where the CI holds it equal to the schema's enum.
export { PEG_REFUSALS } from '../../../schemas/v2/enums.mjs'

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const low = (s) => (typeof s === 'string' ? s.toLowerCase() : null)

/**
 * The token's USD price in one pair, from either side. DexScreener's priceUsd prices the BASE token and priceNative is
 * the base in quote units, so a token on the QUOTE side is priceUsd / priceNative; GeckoTerminal gives the quote's USD
 * price directly (quotePriceUsd). Null when the pair does not hold the token or cannot price it.
 *
 * ⚠ ONLY AGAINST A REFERENCE ASSET. A source's USD price for a pool is its price for the OTHER token carried across, so
 * it is only as good as that token's own dollar price. Against a dollar stable or wrapped ETH it is a market price.
 * Against a memecoin it is circular: on Robinhood Chain memecoins are launched paired with stock tokens (IALI/DJT,
 * REDCAT/RCAT), their dollar price is derived from the stock token, and reading the stock token back out of them gave
 * DJT at ~$990 against an issuer price of ~$4 (09.11). `referenceAssets` is the set of lower-case addresses a pool's
 * other token must be in, the chain descriptor's stables and wrapped native, matched by address because a symbol is
 * free to copy. Without it every pair counts, which only tests rely on.
 */
export function tokenPriceIn (token, p, referenceAssets = null) {
  const t = low(token)
  const isBase = low(p?.baseToken?.address) === t, isQuote = !isBase && low(p?.quoteToken?.address) === t
  if (!isBase && !isQuote) return null
  if (referenceAssets && !referenceAssets.has(low(isBase ? p?.quoteToken?.address : p?.baseToken?.address))) return null
  if (isBase) { const v = num(p?.priceUsd); return v > 0 ? { price: v, side: 'base' } : null }
  {
    const direct = num(p?.quotePriceUsd)
    if (direct > 0) return { price: direct, side: 'quote' }
    const usd = num(p?.priceUsd), nat = num(p?.priceNative)
    return usd > 0 && nat > 0 ? { price: usd / nat, side: 'quote' } : null
  }
  return null
}

/**
 * The pairs a token's price may be read from: the token is on either side and priced (tokenPriceIn), and the pool holds
 * at least MIN_POOL_LIQUIDITY_USD. Deepest first. Each comes back with its `_price` and `_side`.
 */
export function eligiblePools (token, pairs, minLiquidityUsd = MIN_POOL_LIQUIDITY_USD, referenceAssets = null) {
  const out = []
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!(num(p?.liquidity?.usd) >= minLiquidityUsd)) continue
    const tp = tokenPriceIn(token, p, referenceAssets)
    if (tp) out.push({ ...p, _price: tp.price, _side: tp.side })
  }
  return out.sort((a, b) => num(b.liquidity.usd) - num(a.liquidity.usd))
}

/** One pair, in the row's words. */
export function poolSummary (p) {
  return {
    pair_address: low(p.pairAddress) || null,
    dex_id: typeof p.dexId === 'string' ? p.dexId : null,
    // The OTHER token of the pair: the quote when ours is the base, the base when ours is the quote.
    quote_symbol: p._side === 'quote' ? (typeof p?.baseToken?.symbol === 'string' ? p.baseToken.symbol : null) : (typeof p?.quoteToken?.symbol === 'string' ? p.quoteToken.symbol : null),
    price_usd: p._price != null ? p._price : num(p.priceUsd),
    side: p._side === 'quote' ? 'quote' : 'base',
    liquidity_usd: num(p?.liquidity?.usd),
    volume_h24_usd: num(p?.volume?.h24),
  }
}

/**
 * @param reference  { price_usd, bid?, ask?, spread? } in token units (see the header)
 * @param pairs      DexScreener-shaped pairs (DexScreener, GeckoTerminal, the chain: scripts/stocks/onchain-pools.mjs), or
 *                   null when no source could be read. A pair may carry `_crossPrice`: another source's price for the
 *                   token in the same pool, checked against MAX_SOURCE_DISAGREEMENT for the deepest pool.
 * @param opts.referenceAssets  lower-case addresses a pool's other token must be (see tokenPriceIn)
 * @returns {{ premium: number|null, premium_refused: string|null, dex_price_usd: number|null, dex_pool: string|null,
 *             dex_inside_quote: boolean|null, pools: { seen: number|null, eligible: number, capped: boolean, top: object[] },
 *             _best: object|null }}  _best is the deepest eligible pair as given, for the recorder's evidence
 */
export function pegReading (token, reference, pairs, { referenceAssets = null } = {}) {
  const ref = num(reference?.price_usd)
  const seen = Array.isArray(pairs) ? pairs.length : null
  const ok = eligiblePools(token, pairs, MIN_POOL_LIQUIDITY_USD, referenceAssets)
  const pools = { seen, eligible: ok.length, capped: seen === DEXSCREENER_PAIR_CAP, top: ok.slice(0, TOP_POOLS).map(poolSummary) }
  const best = ok[0] ? poolSummary(ok[0]) : null
  // Where the issuer quotes both sides, whether the on-chain price sits inside that quote says more than any mid.
  const bid = num(reference?.bid), ask = num(reference?.ask)
  const inside = best && bid > 0 && ask > 0 && ask >= bid ? best.price_usd >= bid && best.price_usd <= ask : null
  const out = (refused, premium = null) => ({ premium, premium_refused: refused, dex_price_usd: best?.price_usd ?? null, dex_pool: best?.pair_address ?? null, dex_inside_quote: inside, pools, _best: ok[0] || null })
  if (!(ref > 0)) return out('no_reference')
  if (pairs == null) return out('pairs_unavailable')
  if (seen === 0) return out('no_pairs')
  if (!best) return out('no_eligible_pool')
  const cross = num(ok[0]._crossPrice)
  if (cross > 0 && Math.abs(best.price_usd / cross - 1) > MAX_SOURCE_DISAGREEMENT) return out('sources_disagree')
  const spread = num(reference?.spread)
  if (spread != null && (spread < 0 || spread > MAX_REFERENCE_SPREAD)) return out('reference_spread_wide')
  // Every gate above asks whether the POOL is sound: deep enough, agreed on by two sources, quoted against a sane
  // spread. A deep pool for the wrong asset passes all of them, so the last gate asks the only remaining question:
  // can this price and the issuer's price be the same thing at all. The numbers stay in the answer either way.
  const ratio = best.price_usd / ref
  if (!(ratio > 0) || ratio > MAX_PLAUSIBLE_RATIO || ratio < 1 / MAX_PLAUSIBLE_RATIO) return out('implausible_vs_reference')
  return out(null, ratio - 1)
}
