// scripts/stocks/gecko-pools.mjs — a second list of a token's pools, from GeckoTerminal, for the tokens whose DexScreener
// list hit its cap of 30 pairs. Used by scripts/stocks/stock-peg.mjs only.
//
// ⚠ A SUPPLEMENT, NEVER A SUBSTITUTE. It is asked only when DexScreener's list is full, and a failure here leaves the
// DexScreener reading as it was: the recorder never loses a reading because the second source throttled it.
// GeckoTerminal throttles bursts (measured 08.11: the third call within ~6 s answered 429), so calls are paced and pages
// are few, and a page refused after the first keeps the pages already read.
//
// The pools come back in DexScreener's shape so the same eligibility rules (evm/core/stocks/peg.mjs) apply to both.

export const GECKO_PAGE_SIZE = 20
export const GECKO_MAX_PAGES = 3
const TIMEOUT_MS = 15_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
// "base_0xabc…" → "0xabc…"
const idAddress = (id) => { const m = /_(0x[0-9a-fA-F]{40})$/.exec(String(id || '')); return m ? m[1].toLowerCase() : null }

/** GeckoTerminal pools → DexScreener-shaped pairs. Only the base side is priced by base_token_price_usd. */
export function geckoToPairs (body) {
  const out = []
  for (const p of Array.isArray(body?.data) ? body.data : []) {
    const a = p.attributes || {}, rel = p.relationships || {}
    const base = idAddress(rel.base_token?.data?.id)
    const pair = typeof a.address === 'string' ? a.address.toLowerCase() : null
    if (!base || !pair) continue
    const quoteSymbol = typeof a.name === 'string' && a.name.includes(' / ') ? a.name.split(' / ')[1].split(' ')[0] : null
    out.push({
      pairAddress: pair,
      dexId: typeof rel.dex?.data?.id === 'string' ? rel.dex.data.id : null,
      baseToken: { address: base, symbol: typeof a.name === 'string' && a.name.includes(' / ') ? a.name.split(' / ')[0] : null },
      quoteToken: { address: idAddress(rel.quote_token?.data?.id), symbol: quoteSymbol },
      priceUsd: num(a.base_token_price_usd),
      // When OUR token is the quote side, its own USD price (evm/core/stocks/peg.mjs tokenPriceIn).
      quotePriceUsd: num(a.quote_token_price_usd),
      priceNative: num(a.base_token_price_quote_token),
      liquidity: { usd: num(a.reserve_in_usd) },
      volume: { h24: num(a.volume_usd?.h24) },
    })
  }
  return out
}

/**
 * Up to GECKO_MAX_PAGES pages of a token's pools. Returns { pairs, more } where `more` says there may be pools neither
 * source listed: the last page read was full, or a later page was refused. Throws only when the FIRST page fails; the
 * caller then keeps what it had.
 */
export async function readGeckoPools (fetchImpl, network, address, { paceMs = 4500 } = {}) {
  const pairs = []
  let more = false
  for (let page = 1; page <= GECKO_MAX_PAGES; page++) {
    if (page > 1 && paceMs > 0) await sleep(paceMs)
    const r = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=${page}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
    if (!r.ok) {
      if (page === 1) throw new Error(`geckoterminal answered ${r.status}`)
      more = true
      break
    }
    const got = geckoToPairs(await r.json())
    pairs.push(...got)
    more = got.length >= GECKO_PAGE_SIZE
    if (!more) break
  }
  return { pairs, more }
}

/** DexScreener pairs plus GeckoTerminal ones, deduplicated by pool address; DexScreener's entry wins on a tie. */
export function mergePairs (primary, extra) {
  const seen = new Set((primary || []).map((p) => String(p.pairAddress || '').toLowerCase()))
  return [...(primary || []), ...(extra || []).filter((p) => !seen.has(String(p.pairAddress || '').toLowerCase()))]
}
