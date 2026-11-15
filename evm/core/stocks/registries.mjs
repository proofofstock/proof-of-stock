// evm/core/stocks/registries.mjs: the issuers' own lists of tokenized stocks, read from their public APIs.
//
// Two issuers, one shape out. The chain id is the caller's (from the chain descriptor): this is generic core and names
// no chain itself. Each issuer publishes for one chain:
//   { issuer, chain_id, address, symbol, name, isin, multiplier, multiplier_pending, supplied, paused, reference }
// where `reference` is the issuer's price for ONE TOKEN (see evm/core/stocks/peg.mjs for why that matters):
//   Coinbase on Base     GET https://api.coinbase.com/v1/tokenized-stocks          nav_price (Chainlink, total return)
//   Robinhood chain      GET https://api.robinhood.com/rhj/assets + /rhj/prices    tokenBid / tokenAsk mid
// Neither needs a key.
//
// ⚠ ALL OR NOTHING. A list read halfway (a page that failed, a body that is not the shape) is thrown, never returned
// short: a short list reads downstream as "these tokens are not stocks", which is the error this module exists to
// prevent. A missing PRICE is different, the list is still true, and the token gets a null reference.
//
// ⚠ ABSENT IS NOT ZERO. Coinbase omits default-valued fields (no `total_supply` means none minted, no `nav_price`
// means no feed). Every number here is null when the field is absent, never 0.

export const COINBASE_URL = 'https://api.coinbase.com/v1/tokenized-stocks'
export const ROBINHOOD_ASSETS_URL = 'https://api.robinhood.com/rhj/assets'
export const ROBINHOOD_PRICES_URL = 'https://api.robinhood.com/rhj/prices'
const MAX_PAGES = 50
const TIMEOUT_MS = 20_000

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const low = (s) => (typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null)
const str = (s) => (typeof s === 'string' && s ? s : null)
const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null }

async function getJson (fetchImpl, url) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname} answered ${r.status}`)
  return r.json()
}

/**
 * Whether a listed token is minted on its chain, as far as the issuer SAYS: true or false from Coinbase's total_supply,
 * null for Robinhood, whose API reports no supply (its records carry supplied: true only so the recorder reads them;
 * canonicalRegistry keeps that field, so registry_hash does not move). The one place this is decided.
 */
export const mintedOf = (r) => (!r ? null : r.issuer === 'robinhood' || r.supply_known === false ? null : r.supplied !== false)

/** Coinbase tokenized stocks (on Base). Throws unless every page was read. */
export async function readCoinbase (fetchImpl = fetch, { chainId, onBody = null } = {}) {
  if (!Number.isInteger(chainId)) throw new Error('coinbase: chainId is required')
  const out = []
  let token = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = COINBASE_URL + '?page_size=500' + (token ? '&page_token=' + encodeURIComponent(token) : '')
    const body = await getJson(fetchImpl, url)
    if (onBody) onBody('coinbase:tokenized-stocks', body)
    if (!body || !Array.isArray(body.tokens)) throw new Error('coinbase: body has no tokens array')
    for (const t of body.tokens) {
      const address = low(t.contract_address)
      if (!address) throw new Error('coinbase: a record without a contract address')
      const nav = num(t.nav_price)
      out.push({
        issuer: 'coinbase', chain_id: chainId, address, symbol: str(t.symbol), name: str(t.name), isin: str(t.isin),
        multiplier: num(t.multiplier), multiplier_pending: null,
        supplied: num(t.total_supply) > 0,
        paused: Array.isArray(t.paused_features) && t.paused_features.length > 0 ? t.paused_features.map(String) : [],
        reference: { kind: 'nav_total_return', price_usd: nav, bid: null, ask: null, updated_at: iso(t.nav_price_updated_at), halted: null },
      })
    }
    token = str(body.next_page_token)
    // How many pages it took, for the list's proof (evm/core/stocks/list-proof.mjs): its one-page recipe holds only then.
    if (!token) return Object.defineProperty(out, 'pages', { value: page + 1, enumerable: false })
  }
  throw new Error(`coinbase: more than ${MAX_PAGES} pages`)
}

/** Robinhood stock tokens on its chain, with their token-unit quotes. The list throws; the prices may fail alone.
 *  Only deployments whose chainId equals the caller's are listed. */
export async function readRobinhood (fetchImpl = fetch, { chainId, onBody = null } = {}) {
  if (!Number.isInteger(chainId)) throw new Error('robinhood: chainId is required')
  const body = await getJson(fetchImpl, ROBINHOOD_ASSETS_URL)
  if (onBody) onBody('robinhood:assets', body)
  if (!body || !Array.isArray(body.assets)) throw new Error('robinhood: body has no assets array')
  let quotes = null
  try {
    const q = await getJson(fetchImpl, ROBINHOOD_PRICES_URL)
    if (onBody) onBody('robinhood:prices', q)
    if (Array.isArray(q?.quotes)) quotes = new Map(q.quotes.map((x) => [x.tokenSymbol, x]))
  } catch (_) { /* the list is still true without prices: every reference is null and says so */ }
  const out = []
  for (const a of body.assets) {
    const dep = (Array.isArray(a.deployments) ? a.deployments : []).find((d) => String(d.chainId) === String(chainId))
    if (!dep) continue
    const address = low(dep.contractAddress)
    if (!address) throw new Error('robinhood: a deployment without a contract address')
    const q = quotes ? quotes.get(a.tokenSymbol) : null
    // tokenBid/tokenAsk are the share's quote scaled to one token (measured: tokenBid / bid = currentMultiplier on every
    // token). They are not in Robinhood's published docs, so if they vanish, scale the documented bid/ask ourselves.
    const mult = num(a.currentMultiplier)
    const bid = num(q?.tokenBid) ?? (num(q?.bid) != null && mult > 0 ? num(q.bid) * mult : null)
    const ask = num(q?.tokenAsk) ?? (num(q?.ask) != null && mult > 0 ? num(q.ask) * mult : null)
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null
    out.push({
      issuer: 'robinhood', chain_id: chainId, address, symbol: str(a.tokenSymbol), name: str(a.tokenName), isin: str(a.isin),
      multiplier: num(a.currentMultiplier), multiplier_pending: num(a.pendingMultiplier),
      // Not read: Robinhood reports no supply. true keeps the recorder reading the token; supply_known says it means nothing.
      supplied: true, supply_known: false,
      paused: a.status && a.status !== 'ASSET_STATUS_ACTIVE' ? [String(a.status)] : [],
      reference: {
        kind: 'token_bid_ask_mid',
        price_usd: mid,
        bid, ask,
        spread: mid ? (ask - bid) / mid : null,
        // generatedAt is when Robinhood's server answered, not when the quote changed; the recorder turns it into
        // 'unchanged since' across runs (scripts/stocks/stock-peg.mjs).
        updated_at: iso(q?.generatedAt),
        quoted_at: iso(q?.generatedAt),
        halted: typeof q?.isTradingHalt === 'boolean' ? q.isTradingHalt : null,
      },
    })
  }
  return out
}

