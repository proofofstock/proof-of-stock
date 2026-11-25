// packages/proofofstock-guard/examples/crash-test.mjs: "who would buy the fake?" The same task, "buy $20 of <stock> on
// Base", handed to the step every trading agent has and few people look at: turning the words the user typed into ONE
// contract address. Each resolver below is the documented or obvious way a popular agent tool does that step, run with
// public endpoints only. Then Proof of Stock checks every address that came back.
//
// ⚠ DRY. Nothing here signs, sends, quotes for a wallet or holds a key. A resolver only answers "which contract would
// you pick"; no agent is given money, an account or a model. A vendor reruns it with the same one command.
// ⚠ NO VENDOR IS CALLED. A vendor's rule is read from its own public source at a pinned version (GitHub, its app bundle,
// its verified contract) and replayed on public data: GET requests, and one read-only eth_call (isListed) to Base's
// public RPC. No prompt reaches any agent.
// ⚠ WHAT IS TESTED IS THE PICK, NOT THE VENDOR'S WHOLE PRODUCT. An agent that asks its model or its user to confirm the
// address after this step may still stop. The table says what the resolver hands on, in that vendor's documented rule.
// ⚠ NAMES ARE SOMEBODY ELSE'S TEXT: every label shown passes cleanLabel (agent-search.mjs).
//
// The score, fixed before any run (the decision rule, so it is the same for every vendor and every week):
//   ★★★  the pick is the token the issuer lists
//   ★★   no pick: the resolver found nothing or several equal answers and would have to ask for the address
//   ★    a token the issuer does not list and nobody has flagged (not proven fake, not the original either)
//   0    a token on the Proof of Stock impostor list: the agent would have bought the fake
// An agent's score is the WORST of its two phrasings (the ticker the user says, CRCL, and the issuer's symbol, CRCLc):
// the phrasing that loses the money is the one that counts.
//
// Run (needs outbound HTTPS; no key, no account):
//   node packages/proofofstock-guard/examples/crash-test.mjs CRCL
//   node packages/proofofstock-guard/examples/crash-test.mjs TSLA --json
// Exit: 0 the table was made, 2 bad input, 3 the stock or the check could not be read.

import { createGuard, DEFAULT_ENDPOINT } from '../index.mjs'
import { cleanLabel, GECKO } from './agent-search.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BASE = 8453
const lower = (a) => String(a || '').toLowerCase()
const same = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase()

async function getJson (fetchImpl, url, init = {}) {
  try {
    const r = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) })
    if (r.status === 404) return { missing: true }
    if (r.status !== 200) return null
    return { body: await r.json() }
  } catch (_) { return null }
}

async function getText (fetchImpl, url) {
  try {
    const r = await fetchImpl(url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(15000) })
    return r.status === 200 ? await r.text() : null
  } catch (_) { return null }
}

/**
 * DexScreener's search, the way several tools use it: every token in a Base pair whose symbol is the query (either side,
 * case aside), with its deepest pool's liquidity, deepest first. Null if the search could not be read.
 */
async function dexBaseMatches (q, fetchImpl) {
  const r = await getJson(fetchImpl, `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`)
  if (!r) return null
  const best = new Map()
  for (const p of r.body && Array.isArray(r.body.pairs) ? r.body.pairs : []) {
    if (!p || p.chainId !== 'base') continue
    const liq = Number(p.liquidity && p.liquidity.usd) || 0
    for (const t of [p.baseToken, p.quoteToken]) {
      if (!t || !same(t.symbol, q) || !ADDRESS.test(String(t.address))) continue
      const a = lower(t.address)
      if (!best.has(a) || liq > best.get(a)) best.set(a, liq)
    }
  }
  return [...best.entries()].map(([address, liq]) => ({ address, liq })).sort((a, b) => b.liq - a.liq)
}

/** A table keyed by the plain ticker (NVDA) serves the issuer's symbol (NVDAc) too: the token it maps is that one. */
const tickerOf = (q) => String(q).replace(/c$/, '')

// The pins: each vendor's source is read at one version, so a run says which one it judged. A later change on their side
// is a new pin in a new commit here, never a silent one.
export const AFTER_HOURS_COMMIT = '1ddcbea9dfe51f54ffa9ed748e32893fbcea1960'
export const BLAZE_API_COMMIT = '370b5a948eb91a510b4a79723dc8cde9452bde9b'
/** Zeus publishes no source; its app's bundle is named by its content hash, which is the pin. */
export const ZEUS_BUNDLE = 'https://app.zeustrade.io/assets/contracts-BoSZFQd4.js'
/** Stockings' contract on Base (verified on Basescan and Sourcify): its own list of the stocks it lets you send. */
export const STOCKINGS = '0xc3f632fcaa8a6f3245775032ec037f8103cad84a'
export const BASE_RPC_URL = 'https://mainnet.base.org'
/** isListed(address): the first four bytes of its keccak-256 (checked in the test). */
export const IS_LISTED = '0xf794062e'

/** After Hours' STOCKS table (api/_lib.js): ticker and token address of each entry. */
export function afterHoursTable (source) {
  return [...String(source).matchAll(/\{\s*t:\s*'([A-Za-z0-9.]{1,10})'[^}]*?token:\s*'(0x[0-9a-fA-F]{40})'/g)].map((m) => ({ ticker: m[1], address: m[2].toLowerCase() }))
}

/** Zeus' production token table, from its app bundle: `Rt={development:…,test:…,production:<name>}`, then `<name>={KEY:`0x…`,…}`. */
export function zeusTable (bundle) {
  const s = String(bundle)
  const v = s.match(/production:([A-Za-z_$][\w$]*)\}/)
  if (!v) return []
  const at = s.indexOf(`${v[1]}={`)
  if (at < 0) return []
  const body = s.slice(at, s.indexOf('}', at))
  return [...body.matchAll(/([A-Za-z][A-Za-z0-9.]{0,9}):`(0x[0-9a-fA-F]{40})`/g)].map((m) => ({ ticker: m[1], address: m[2].toLowerCase() }))
}

/** One view call to Stockings' contract: is this token on its list? Null if the chain could not be read. */
async function stockingsListed (address, fetchImpl) {
  try {
    const r = await fetchImpl(BASE_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: STOCKINGS, data: IS_LISTED + address.slice(2).padStart(64, '0') }, 'latest'] }) })
    if (r.status !== 200) return null
    const j = await r.json()
    if (!j || typeof j.result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(j.result)) return null
    return BigInt(j.result) === 1n
  } catch (_) { return null }
}

/** The MAXXAGENT commit its list is read at: a vendor's later change is a new run with a new pin, never a silent one. */
export const MAXXAGENT_COMMIT = '8c6e1ba640aca5fb8ea4b8a1aa669a915ee01d27'

/** MAXXAGENT's stock table as written in its source: each entry's symbol, underlying ticker and token address. */
export function maxxagentTable (source) {
  const out = []
  for (const m of String(source).matchAll(/symbol:\s*"([A-Za-z0-9.]{1,12})",\s*tickerUnderlying:\s*"([A-Za-z0-9.]{1,10})",[\s\S]*?b20Address:\s*"(0x[0-9a-fA-F]{40})"/g)) {
    out.push({ symbol: m[1], ticker: m[2], address: m[3].toLowerCase() })
  }
  return out
}

/** A pick out of one list of equal-rank answers: one → that one; none → null; several → ambiguous (would ask). */
function onlyOne (addresses) {
  const u = [...new Set(addresses.map(lower).filter((a) => ADDRESS.test(a)))]
  return u.length === 1 ? { address: u[0] } : { address: null, ambiguous: u.length > 1 ? u.length : 0 }
}

// Each resolver: (query, fetchImpl) → { address } | { address: null, ambiguous? } | null when it could not be read.
// `how` is the rule, in words, printed on the page beside the result, and `source` the public document it comes from.
export const RESOLVERS = Object.freeze([
  {
    id: 'kyberswap-mcp', agent: 'KyberSwap skill (Coinbase Wallet MCP plugin)',
    how: 'token-api by name, whitelisted first, else all; exact symbol, highest marketCap',
    source: 'https://docs.cdp.coinbase.com/coinbase-for-agents/wallet-mcp/plugins/kyberswap.md',
    async resolve (q, fetchImpl) {
      for (const w of ['true', 'false']) {
        const r = await getJson(fetchImpl, `https://token-api.kyberswap.com/api/v1/public/tokens?chainIds=${BASE}&name=${encodeURIComponent(q)}&isWhitelisted=${w}&pageSize=100`)
        if (!r || r.missing) return r ? { address: null } : null
        const list = (r.body && r.body.data && Array.isArray(r.body.data.tokens) ? r.body.data.tokens : []).filter((t) => same(t.symbol, q) && ADDRESS.test(String(t.address)))
        if (!list.length) continue
        list.sort((a, b) => (Number(b.marketCap) || 0) - (Number(a.marketCap) || 0))
        return { address: lower(list[0].address) }
      }
      return { address: null }
    },
  },
  {
    id: 'lifi', agent: 'LI.FI token lookup (used by agent swap tools)',
    how: 'GET /v1/token?chain=8453&token=<symbol>, the one answer it returns',
    source: 'https://docs.li.fi/api-reference/fetch-information-about-a-token',
    async resolve (q, fetchImpl) {
      const r = await getJson(fetchImpl, `https://li.quest/v1/token?chain=${BASE}&token=${encodeURIComponent(q)}`)
      if (!r) return null
      if (r.missing || !r.body || !ADDRESS.test(String(r.body.address))) return { address: null }
      return { address: lower(r.body.address) }
    },
  },
  {
    id: 'dexscreener', agent: 'Naive agent with a DexScreener search tool',
    how: 'search pairs; Base pairs whose token symbol is the query; deepest liquidity',
    source: 'https://docs.dexscreener.com/api/reference',
    async resolve (q, fetchImpl) {
      const found = await dexBaseMatches(q, fetchImpl)
      return found ? { address: found.length ? found[0].address : null } : null
    },
  },
  {
    id: 'geckoterminal', agent: 'Naive agent with a GeckoTerminal search tool',
    how: 'search Base pools; tokens whose symbol is the query; deepest pools summed',
    source: 'https://www.geckoterminal.com/dex-api',
    async resolve (q, fetchImpl) {
      const r = await getJson(fetchImpl, `${GECKO}/search/pools?query=${encodeURIComponent(q)}&network=base&include=base_token,quote_token`)
      if (!r) return null
      const body = r.body || {}
      const liq = new Map()
      const tokens = new Map()
      for (const t of Array.isArray(body.included) ? body.included : []) {
        const a = t && t.attributes
        if (a && same(a.symbol, q) && ADDRESS.test(String(a.address))) tokens.set(lower(a.address), 0)
      }
      for (const p of Array.isArray(body.data) ? body.data : []) {
        const reserve = Number(p && p.attributes && p.attributes.reserve_in_usd) || 0
        for (const side of ['base_token', 'quote_token']) {
          const id = p && p.relationships && p.relationships[side] && p.relationships[side].data && String(p.relationships[side].data.id || '')
          const a = id && lower(id.replace(/^base_/, ''))
          if (a && tokens.has(a)) liq.set(a, (liq.get(a) || 0) + reserve)
        }
      }
      const best = [...tokens.keys()].sort((a, b) => (liq.get(b) || 0) - (liq.get(a) || 0))[0]
      return { address: best || null }
    },
  },
  {
    id: 'coingecko-list', agent: 'CoinGecko Base token list (default list of many wallets)',
    how: 'exact symbol in the Base list; one answer, else ask',
    source: 'https://tokens.coingecko.com/base/all.json',
    async resolve (q, fetchImpl) {
      const r = await getJson(fetchImpl, 'https://tokens.coingecko.com/base/all.json')
      if (!r || r.missing) return r ? { address: null } : null
      const list = (r.body && Array.isArray(r.body.tokens) ? r.body.tokens : []).filter((t) => t && t.chainId === BASE && same(t.symbol, q))
      return onlyOne(list.map((t) => t.address))
    },
  },
  {
    id: 'uniswap-list', agent: 'Uniswap default token list',
    how: 'exact symbol on chain 8453; one answer, else ask',
    source: 'https://tokens.uniswap.org',
    async resolve (q, fetchImpl) {
      const r = await getJson(fetchImpl, 'https://tokens.uniswap.org')
      if (!r || r.missing) return r ? { address: null } : null
      const list = (r.body && Array.isArray(r.body.tokens) ? r.body.tokens : []).filter((t) => t && t.chainId === BASE && same(t.symbol, q))
      return onlyOne(list.map((t) => t.address))
    },
  },
  {
    id: 'velora-list', agent: 'Velora (ParaSwap) token list',
    how: 'exact symbol in /tokens/8453; one answer, else ask',
    source: 'https://developers.velora.xyz',
    async resolve (q, fetchImpl) {
      const r = await getJson(fetchImpl, `https://api.paraswap.io/tokens/${BASE}`)
      if (!r || r.missing) return r ? { address: null } : null
      const list = (r.body && Array.isArray(r.body.tokens) ? r.body.tokens : []).filter((t) => t && same(t.symbol, q))
      return onlyOne(list.map((t) => t.address))
    },
  },
  {
    // Owner, 25.11: "add it to the bench". MAXXAGENT does not search: it trades a fixed list of stocks written in its
    // open source (MIT) and refuses any other, naming the closest one it supports. So its pick is read from that list,
    // at a pinned commit, and nothing is sent to its service: no prompt, no account.
    id: 'maxxagent', agent: 'MAXXAGENT (stock-basket agent)',
    how: 'its own fixed list (src/lib/tokenizedStocks.ts): ticker or symbol → address; any other stock refused',
    source: `https://github.com/0xAxelowETH/maxxagent/blob/${MAXXAGENT_COMMIT}/src/lib/tokenizedStocks.ts`,
    async resolve (q, fetchImpl) {
      const text = await getText(fetchImpl, `https://raw.githubusercontent.com/0xAxelowETH/maxxagent/${MAXXAGENT_COMMIT}/src/lib/tokenizedStocks.ts`)
      if (text == null) return null
      const table = maxxagentTable(text)
      if (!table.length) return null // the file no longer has the shape this reads: unreadable, never "no pick"
      const hit = table.filter((s) => same(s.symbol, q) || same(s.ticker, q))
      return onlyOne(hit.map((s) => s.address))
    },
  },
  // Owner, 25.11: three more from the community, and Stockings. Each read from its own public source; none is called.
  {
    id: 'after-hours', agent: 'After Hours (one-click stock swap)',
    how: 'its own fixed list (api/_lib.js STOCKS): ticker → token; any other stock cannot be bought',
    source: `https://github.com/Makabeez/after-hours/blob/${AFTER_HOURS_COMMIT}/api/_lib.js`,
    async resolve (q, fetchImpl) {
      const text = await getText(fetchImpl, `https://raw.githubusercontent.com/Makabeez/after-hours/${AFTER_HOURS_COMMIT}/api/_lib.js`)
      if (text == null) return null
      const table = afterHoursTable(text)
      if (!table.length) return null
      return onlyOne(table.filter((s) => same(s.ticker, q) || same(s.ticker, tickerOf(q))).map((s) => s.address))
    },
  },
  {
    // Its quote API (src/lib/symbolResolve.ts, pickBestPair) is this rule exactly; its SDK and MCP swap refuse any
    // symbol but ETH, WETH, USDC and its own token, so the API path is the one that can pick a stock.
    id: 'blazephoenix', agent: 'BlazePhoenix aggregator (quote API)',
    how: 'symbolResolve.ts: DexScreener search, Base pairs, exact symbol, deepest liquidity (its swap SDK refuses symbols)',
    source: `https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-API/blob/${BLAZE_API_COMMIT}/src/lib/symbolResolve.ts`,
    async resolve (q, fetchImpl) {
      const found = await dexBaseMatches(q, fetchImpl)
      return found ? { address: found.length ? found[0].address : null } : null
    },
  },
  {
    id: 'zeus', agent: 'Zeus (perp and swap DEX, agent endpoint)',
    how: 'its app\'s production token table (contracts bundle): ticker → token; any other stock has no address',
    source: ZEUS_BUNDLE,
    async resolve (q, fetchImpl) {
      const text = await getText(fetchImpl, ZEUS_BUNDLE)
      if (text == null) return null
      const table = zeusTable(text)
      if (!table.length) return null
      return onlyOne(table.filter((s) => same(s.ticker, q) || same(s.ticker, tickerOf(q))).map((s) => s.address))
    },
  },
  {
    id: 'stockings', agent: 'Stockings (stock gift links; not an agent)',
    how: 'tokens a DexScreener search finds by exact symbol, kept only if its contract says isListed; one, else ask',
    source: `https://basescan.org/address/${STOCKINGS}#code`,
    async resolve (q, fetchImpl) {
      const found = await dexBaseMatches(q, fetchImpl)
      if (!found) return null
      const listed = []
      for (const c of found.slice(0, 10)) {
        const ok = await stockingsListed(c.address, fetchImpl)
        if (ok == null) return null
        if (ok) listed.push(c.address)
      }
      return onlyOne(listed)
    },
  },
])

/** The score of one pick, by the rule at the top of this file. Never more than ★ for an answer the guard could not give. */
export function starsFor (pick, decision) {
  if (!pick || !pick.address) return 2
  if (decision === 'listed') return 3
  if (decision === 'impostor') return 0
  return 1
}

export const STAR_TEXT = Object.freeze(['0', '★', '★★', '★★★'])

/**
 * The whole crash test for one stock. Never throws.
 * @returns {Promise<{ code, outcome?, stock?, rows? }>}
 */
export async function crashTest ({ ticker, fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT, resolvers = RESOLVERS, now = () => Date.now() } = {}) {
  const t = String(ticker || '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(t)) return { code: 2, outcome: 'bad_input' }
  // The stock as the issuer lists it on Base: its symbol (CRCLc) and its one contract.
  const f = await getJson(fetchImpl, `${endpoint}/api/find?q=${encodeURIComponent(t)}`)
  const hit = f && f.body && Array.isArray(f.body.matches) ? f.body.matches.find((m) => m && m.chain === 'base' && typeof m.symbol === 'string' && same(m.symbol.replace(/c$/, ''), t) && ADDRESS.test(String(m.address))) : null
  if (!f) return { code: 3, outcome: 'unavailable' }
  if (!hit) return { code: 2, outcome: 'not_listed_on_base' }
  const stock = { ticker: t, symbol: hit.symbol, name: cleanLabel(hit.name, 48), original: lower(hit.address) }
  const queries = [...new Set([t, hit.symbol])]

  const picks = [] // { resolver, query, pick }
  for (const r of resolvers) {
    for (const q of queries) {
      let pick = null
      try { pick = await r.resolve(q, fetchImpl) } catch (_) { pick = null }
      picks.push({ resolver: r, query: q, pick })
    }
  }
  const addrs = [...new Set(picks.map((p) => p.pick && p.pick.address).filter(Boolean))]
  const decided = new Map()
  if (addrs.length) {
    const guard = createGuard({ endpoint, fetchImpl })
    const ds = await guard.beforeBuyMany('base', addrs.map((a) => ({ tokenAddress: a, claimedSymbol: hit.symbol })))
    addrs.forEach((a, i) => decided.set(a, ds[i]))
    if (ds.some((d) => d.decision === 'unknown')) return { code: 3, outcome: 'unavailable', stock }
  }
  const rows = resolvers.map((r) => {
    const tries = picks.filter((p) => p.resolver === r).map((p) => {
      if (!p.pick) return { query: p.query, address: null, decision: 'unreadable', stars: null }
      const a = p.pick.address
      const d = a ? decided.get(a) : null
      const decision = !a ? (p.pick.ambiguous ? 'ambiguous' : 'none') : d.decision
      return { query: p.query, address: a, decision, ambiguous: p.pick.ambiguous || 0, stars: starsFor(p.pick, decision), symbol: a && d && d.verify && d.verify.symbol ? cleanLabel(d.verify.symbol, 16) : null }
    })
    const scored = tries.filter((x) => x.stars != null)
    return { id: r.id, agent: r.agent, how: r.how, source: r.source, tries, stars: scored.length === tries.length ? Math.min(...scored.map((x) => x.stars)) : null }
  })
  return { code: 0, stock, rows, run_at: new Date(now()).toISOString(), method: 'packages/proofofstock-guard/examples/crash-test.mjs' }
}

const isMain = globalThis.process?.argv?.[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')).href
if (isMain) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const r = await crashTest({ ticker: args.find((a) => !a.startsWith('--')) || 'CRCL' })
  if (json) console.log(JSON.stringify(r, null, 2))
  else if (r.code) console.log(`stopped: ${r.outcome}`)
  else {
    console.log(`buy $20 of ${r.stock.ticker} on Base. The issuer's ${r.stock.symbol}: ${r.stock.original}`)
    for (const row of r.rows) {
      console.log(`${(row.stars == null ? '?' : STAR_TEXT[row.stars]).padEnd(4)} ${row.agent}`)
      for (const x of row.tries) console.log(`       "${x.query}" → ${x.address || '(no pick)'} ${x.decision}`)
    }
  }
  process.exit(r.code)
}
