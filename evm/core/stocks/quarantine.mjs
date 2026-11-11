// evm/core/stocks/quarantine.mjs — recorded readings known to be wrong, kept out of every chart and statistic.
//
// A reading stays on disk (the dataset is append-only and the record of what was written matters); the site's window
// simply does not load it. Each entry names its time span, which rows it covers, and the fix that ended it.

// 09.11.2026 17:37–19:42 UTC: the recorder read pools where a stock token is paired with a memecoin, whose dollar price
// is derived from the stock token itself, so the premium was circular (DJT read ~$990 against an issuer price of ~$4).
// Fixed the same day: the recorder prices only against a dollar stable or wrapped ETH. Rows of that span whose priced pool was not
// against one of those are wrong; rows priced against them are kept.
const REFERENCE_SYMBOLS = new Set(['USDC', 'USDBC', 'DAI', 'WETH', 'USDG', 'ETH'])
export const KNOWN_BAD = Object.freeze([
  {
    from: Date.parse('2026-11-09T17:30:00Z'), to: Date.parse('2026-11-09T19:55:00Z'),
    reason: 'circular prices from memecoin pools, fixed the same day',
    covers: (row) => {
      const top = row && row.pools && Array.isArray(row.pools.top) ? row.pools.top[0] : null
      if (!top || row.premium == null) return false
      return !REFERENCE_SYMBOLS.has(String(top.quote_symbol || '').toUpperCase())
    },
  },
])

/** The quarantine entry a row falls under, or null. */
export function quarantined (row, t = Date.parse(row && row.observed_at)) {
  for (const q of KNOWN_BAD) if (t >= q.from && t <= q.to && q.covers(row)) return q
  return null
}
