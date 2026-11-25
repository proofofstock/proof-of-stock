// packages/proofofstock-guard/examples/crash-test.test.mjs: the crash test (examples/crash-test.mjs) with every answer a
// fake. Each resolver must pick by its own documented rule, the score must follow the rule fixed at the top of the file
// (the original ★★★, no pick ★★, a token off the list ★, a listed fake 0), an agent must score its WORSE phrasing, an
// answer that could not be read must never be scored, and nothing in the file may sign, send or hold a key.
//
// Run: node packages/proofofstock-guard/examples/crash-test.test.mjs
import fs from 'node:fs'
import { crashTest, starsFor, RESOLVERS, STAR_TEXT, maxxagentTable, MAXXAGENT_COMMIT, afterHoursTable, zeusTable, AFTER_HOURS_COMMIT, BLAZE_API_COMMIT, ZEUS_BUNDLE, STOCKINGS, IS_LISTED } from './crash-test.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const REAL = '0xb2' + '0'.repeat(20) + 'b2'.repeat(9), FAKE = '0x' + 'f1'.repeat(20), FAKE2 = '0x' + 'f2'.repeat(20), OTHER = '0x' + 'd1'.repeat(20), RICH = '0x' + 'aa'.repeat(20)
const res = (status, body) => ({ status, json: async () => body, text: async () => String(body) })
// MAXXAGENT's table, in the shape its source writes it: two supported stocks, Circle not among them.
const maxxSource = (rows) => 'export const TOKENIZED_STOCKS = [\n' + rows.map(([sym, t, a]) => `  {\n    symbol: "${sym}",\n    tickerUnderlying: "${t}",\n    name: "x",\n    b20Address: "${a}",\n    chainlinkFeed: "0x${'11'.repeat(20)}",\n  },`).join('\n') + '\n]\n'
const NVDA = '0x' + 'b3'.repeat(20)
const proof = { issuer: 'coinbase', addresses_sha256: 'a'.repeat(64), stale: false }
const answer = (a) => a === REAL ? { address: REAL, listed: true, symbol: 'CRCLc', registries_checked: ['coinbase:base'], registry_age_s: 60 }
  : a === FAKE || a === FAKE2 ? { address: a, listed: false, registries_checked: ['coinbase:base'], impostor: { kinds: ['registry_symbol'], imitates_symbol: 'CRCLc', listed_address: REAL } }
    : { address: a, listed: false, registries_checked: ['coinbase:base'] }

function world (over = {}) {
  const w = {
    find: () => res(200, { matches: [{ chain: 'robinhood', symbol: 'CRCL', name: 'Circle' }, { chain: 'base', symbol: 'CRCLc', name: 'Circle Internet Group Inc.', address: REAL }] }),
    // KyberSwap: whitelisted search finds nothing; the open one has the fake with the bigger marketCap.
    kyber: (q, w) => w === 'true' ? res(200, { data: { tokens: null } }) : res(200, { data: { tokens: q === 'CRCLc' ? [{ address: REAL, symbol: 'CRCLc', marketCap: 100 }, { address: FAKE, symbol: 'CRCLc', marketCap: 5000 }, { address: RICH, symbol: 'CRCLX', marketCap: 9e9 }] : [] } }),
    lifi: (q) => q === 'CRCLc' ? res(200, { address: REAL, symbol: 'CRCLc' }) : res(404, { message: 'not found' }),
    dex: (q) => res(200, { pairs: [
      { chainId: 'base', baseToken: { address: OTHER, symbol: q }, quoteToken: { address: '0x' + '42'.repeat(20), symbol: 'WETH' }, liquidity: { usd: 900 } },
      { chainId: 'base', baseToken: { address: REAL, symbol: q }, quoteToken: { address: '0x' + '42'.repeat(20), symbol: 'WETH' }, liquidity: { usd: 50 } },
      { chainId: 'ethereum', baseToken: { address: RICH, symbol: q }, liquidity: { usd: 9e9 } }] }),
    gecko: () => res(200, { data: [], included: [] }),
    cg: () => res(200, { tokens: [{ chainId: 8453, address: FAKE, symbol: 'crclc' }, { chainId: 8453, address: FAKE2, symbol: 'CRCLC' }, { chainId: 1, address: RICH, symbol: 'CRCL' }] }),
    uni: () => res(200, { tokens: [{ chainId: 8453, address: REAL, symbol: 'CRCLc' }] }),
    velora: () => res(503, {}),
    maxx: () => res(200, maxxSource([['NVDAc', 'NVDA', NVDA], ['TSLAc', 'TSLA', '0x' + 'b4'.repeat(20)]])),
    // After Hours: CRCL on its list; Zeus: not. Stockings lists the original only.
    ah: () => res(200, `export const STOCKS = [\n  { t: 'NVDA', name: 'NVIDIA', token: '${NVDA}', feed: '0x${'11'.repeat(20)}' },\n  { t: 'CRCL', name: 'Circle', token: '${REAL}', feed: '0x${'11'.repeat(20)}' },\n];`),
    zeus: () => res(200, `const Ft={NVDA:\`0x${'99'.repeat(20)}\`},Lt={WETH:\`0x${'42'.repeat(20)}\`,CBBTC:r,NVDA:\`${NVDA}\`},Rt={development:Ft,test:Ft,production:Lt},J=8453`),
    listed: (a) => a === REAL,
    verify: (list) => res(200, { results: list.map(answer), list_proof: proof }),
    ...over,
  }
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    calls.push({ url: u, init })
    if (u.pathname.endsWith('/api/find')) return w.find(u.searchParams.get('q'))
    if (u.pathname.endsWith('/verify')) return w.verify(String(u.searchParams.get('addresses') || u.searchParams.get('address')).split(','))
    if (u.host === 'token-api.kyberswap.com') return w.kyber(u.searchParams.get('name'), u.searchParams.get('isWhitelisted'))
    if (u.host === 'li.quest') return w.lifi(u.searchParams.get('token'))
    if (u.host === 'api.dexscreener.com') return w.dex(u.searchParams.get('q'))
    if (u.host === 'api.geckoterminal.com') return w.gecko(u.searchParams.get('query'))
    if (u.host === 'tokens.coingecko.com') return w.cg()
    if (u.host === 'tokens.uniswap.org') return w.uni()
    if (u.host === 'api.paraswap.io') return w.velora()
    // The guard reads Coinbase's own list itself (0.3.0): the issuer-listed contract is on it.
    if (u.host === 'api.coinbase.com') return res(200, { tokens: [{ contract_address: REAL }] })
    if (u.host === 'raw.githubusercontent.com') return u.pathname.startsWith('/Makabeez/after-hours/') ? w.ah(u.pathname) : w.maxx(u.pathname)
    if (u.host === 'app.zeustrade.io') return w.zeus()
    if (u.host === 'mainnet.base.org') {
      const b = JSON.parse(init.body)
      const p = b.params[0]
      if (b.method !== 'eth_call' || p.to !== STOCKINGS || !p.data.startsWith(IS_LISTED)) return res(400, {})
      const ok = w.listed('0x' + p.data.slice(-40))
      return ok == null ? res(503, {}) : res(200, { jsonrpc: '2.0', id: 1, result: '0x' + (ok ? '1' : '0').padStart(64, '0') })
    }
    return res(599, {})
  }
  return { fetchImpl, calls }
}
const row = (r, id) => r.rows.find((x) => x.id === id)
const tryOf = (r, id, q) => row(r, id).tries.find((t) => t.query === q)

console.log('the score, fixed before any run')
{
  check('the original is ★★★, a listed fake 0, a token off the list ★, no pick ★★', starsFor({ address: REAL }, 'listed') === 3 && starsFor({ address: FAKE }, 'impostor') === 0 && starsFor({ address: OTHER }, 'not_listed') === 1 && starsFor({ address: null }, 'none') === 2 && starsFor({ address: null, ambiguous: 2 }, 'ambiguous') === 2)
  check('a pick the guard said nothing clear about is never more than ★', starsFor({ address: OTHER }, 'wrong_stock') === 1)
  check('the stars as text', STAR_TEXT.join() === '0,★,★★,★★★')
  check('every resolver says which rule it follows and where that rule is written', RESOLVERS.length >= 6 && RESOLVERS.every((r) => r.agent && r.how && /^https:\/\//.test(r.source)) && new Set(RESOLVERS.map((r) => r.id)).size === RESOLVERS.length)
}

console.log('one run, every answer a fake')
{
  const w = world()
  const r = await crashTest({ ticker: 'crcl', fetchImpl: w.fetchImpl, endpoint: 'https://pos.test' })
  check('it runs: the stock as the issuer lists it on Base', r.code === 0 && r.stock.ticker === 'CRCL' && r.stock.symbol === 'CRCLc' && r.stock.original === REAL)
  check('every agent is asked both ways: the ticker and the issuer\'s symbol', r.rows.length === RESOLVERS.length && r.rows.every((x) => x.tries.map((t) => t.query).join() === 'CRCL,CRCLc'))
  check('KyberSwap skill: exact symbol, highest marketCap, so it picks the fake (0)', tryOf(r, 'kyberswap-mcp', 'CRCLc').address === FAKE && tryOf(r, 'kyberswap-mcp', 'CRCLc').decision === 'impostor' && row(r, 'kyberswap-mcp').stars === 0)
  check('...it asked the whitelisted list first, as its document says', w.calls.filter((c) => c.url.host === 'token-api.kyberswap.com' && c.url.searchParams.get('name') === 'CRCLc').map((c) => c.url.searchParams.get('isWhitelisted')).join() === 'true,false')
  check('LI.FI: the one answer it returns; a 404 is no pick, not an error', tryOf(r, 'lifi', 'CRCLc').address === REAL && tryOf(r, 'lifi', 'CRCL').decision === 'none' && row(r, 'lifi').stars === 2)
  check('DexScreener agent: Base pairs only, deepest liquidity wins, so a token off the list (★)', tryOf(r, 'dexscreener', 'CRCLc').address === OTHER && tryOf(r, 'dexscreener', 'CRCLc').stars === 1 && row(r, 'dexscreener').stars === 1)
  check('a token list with two equal answers would have to ask: ★★, never a guess', tryOf(r, 'coingecko-list', 'CRCLc').decision === 'ambiguous' && tryOf(r, 'coingecko-list', 'CRCLc').ambiguous === 2 && tryOf(r, 'coingecko-list', 'CRCLc').stars === 2)
  check('a token list with one answer takes it, symbol compared without case', tryOf(r, 'uniswap-list', 'CRCLc').address === REAL && row(r, 'uniswap-list').stars === 2)
  check('an agent scores its worse phrasing', row(r, 'uniswap-list').tries.map((t) => t.stars).join() === '2,3' && row(r, 'uniswap-list').stars === 2)
  check('an answer that could not be read is never scored', row(r, 'velora-list').tries.every((t) => t.decision === 'unreadable' && t.stars === null) && row(r, 'velora-list').stars === null)
  check('the guard is asked once, about every distinct pick, by the issuer\'s symbol', w.calls.filter((c) => c.url.pathname.endsWith('/verify')).length === 1)
  check('the result names the method a vendor reruns', r.method === 'packages/proofofstock-guard/examples/crash-test.mjs')
}

console.log('it stops rather than score what it cannot read')
{
  let r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ verify: () => res(503, {}) }).fetchImpl, endpoint: 'https://pos.test' })
  check('the check could not be made: exit 3, no table', r.code === 3 && r.outcome === 'unavailable' && !r.rows)
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ find: () => res(503, {}) }).fetchImpl, endpoint: 'https://pos.test' })
  check('the issuer-listed search could not be read: exit 3', r.code === 3)
  r = await crashTest({ ticker: 'ZZZZ', fetchImpl: world({ find: () => res(200, { matches: [] }) }).fetchImpl, endpoint: 'https://pos.test' })
  check('a stock the issuer does not list on Base: exit 2', r.code === 2 && r.outcome === 'not_listed_on_base')
  r = await crashTest({ ticker: '<script>', fetchImpl: world().fetchImpl, endpoint: 'https://pos.test' })
  check('a ticker is letters and digits', r.code === 2 && r.outcome === 'bad_input')
}

console.log('MAXXAGENT: its own fixed list, read from its source at a pinned commit')
{
  const t = maxxagentTable(maxxSource([['NVDAc', 'NVDA', NVDA.toUpperCase().replace('0X', '0x')], ['BRK.Bc', 'BRK.B', '0x' + 'b5'.repeat(20)]]))
  check('the table: symbol, ticker and address of each entry, addresses in lower case', t.length === 2 && t[0].symbol === 'NVDAc' && t[0].ticker === 'NVDA' && t[0].address === NVDA && t[1].ticker === 'BRK.B')
  const w = world()
  let r = await crashTest({ ticker: 'CRCL', fetchImpl: w.fetchImpl, endpoint: 'https://pos.test' })
  check('a stock it does not trade: refused both ways, ★★, never a guess', row(r, 'maxxagent').tries.every((x) => x.decision === 'none') && row(r, 'maxxagent').stars === 2)
  check('...read at the pinned commit, from its source on GitHub, and nothing sent to its own service', w.calls.some((c) => c.url.host === 'raw.githubusercontent.com' && c.url.pathname === `/0xAxelowETH/maxxagent/${MAXXAGENT_COMMIT}/src/lib/tokenizedStocks.ts`) && !w.calls.some((c) => /maxxagent\.xyz/.test(c.url.host)) && /^[0-9a-f]{40}$/.test(MAXXAGENT_COMMIT))
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ maxx: () => res(200, maxxSource([['CRCLc', 'CRCL', REAL]])) }).fetchImpl, endpoint: 'https://pos.test' })
  check('a stock on its list: found by ticker and by symbol, scored by the guard', row(r, 'maxxagent').tries.every((x) => x.address === REAL && x.stars === 3) && row(r, 'maxxagent').stars === 3)
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ maxx: () => res(200, maxxSource([['CRCLc', 'CRCL', FAKE]])) }).fetchImpl, endpoint: 'https://pos.test' })
  check('a list that held a fake would score 0', row(r, 'maxxagent').stars === 0)
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ maxx: () => res(200, 'export const nothing = 1') }).fetchImpl, endpoint: 'https://pos.test' })
  check('a source that no longer has the table is unreadable, not "no pick"', row(r, 'maxxagent').stars === null && row(r, 'maxxagent').tries.every((x) => x.decision === 'unreadable'))
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ maxx: () => res(404, '') }).fetchImpl, endpoint: 'https://pos.test' })
  check('a source that could not be fetched is unreadable too', row(r, 'maxxagent').stars === null)
}

console.log('After Hours, BlazePhoenix, Zeus, Stockings: each from its own public source')
{
  check('After Hours\' table: ticker and token', afterHoursTable(`{ t: 'NVDA', name: 'N', token: '${NVDA.toUpperCase().replace('0X', '0x')}', feed: '0x${'11'.repeat(20)}' },{ t: 'GOOGL',name: 'A', token: '${REAL}' }`).map((x) => x.ticker + x.address).join() === `NVDA${NVDA},GOOGL${REAL}`)
  const z = zeusTable(`Ft={NVDA:\`0x${'99'.repeat(20)}\`},Lt={CBBTC:r,NVDA:\`${NVDA}\`,TSLA:\`${REAL}\`},Rt={development:Ft,test:Ft,production:Lt}`)
  check('Zeus\' table is the production one, never development\'s or test\'s, and a non-literal entry is skipped', z.map((x) => x.ticker + x.address).join() === `NVDA${NVDA},TSLA${REAL}`)
  check('a bundle without a production table reads empty', zeusTable('const a={b:1}').length === 0)
  const keccak = (await import('@noble/hashes/sha3.js')).keccak_256
  check('isListed\'s selector is the keccak of its signature', IS_LISTED === '0x' + Buffer.from(keccak(new TextEncoder().encode('isListed(address)'))).toString('hex').slice(0, 8))
  check('the pins are exact versions', [AFTER_HOURS_COMMIT, BLAZE_API_COMMIT, MAXXAGENT_COMMIT].every((c) => /^[0-9a-f]{40}$/.test(c)) && /-[A-Za-z0-9_-]{6,}\.js$/.test(ZEUS_BUNDLE))
  let w = world()
  let r = await crashTest({ ticker: 'CRCL', fetchImpl: w.fetchImpl, endpoint: 'https://pos.test' })
  check('After Hours: on its list, found by ticker and by the issuer\'s symbol', row(r, 'after-hours').tries.every((x) => x.address === REAL) && row(r, 'after-hours').stars === 3)
  check('...read at its pinned commit', w.calls.some((c) => c.url.pathname === `/Makabeez/after-hours/${AFTER_HOURS_COMMIT}/api/_lib.js`))
  check('Zeus: not on its list, both ways: ★★', row(r, 'zeus').tries.every((x) => x.decision === 'none') && row(r, 'zeus').stars === 2)
  check('BlazePhoenix: its quote API\'s rule, deepest Base pool by exact symbol, so a token off the list (★)', tryOf(r, 'blazephoenix', 'CRCLc').address === OTHER && row(r, 'blazephoenix').stars === 1)
  check('Stockings: of the tokens found, only the one its contract lists', tryOf(r, 'stockings', 'CRCLc').address === REAL && tryOf(r, 'stockings', 'CRCLc').stars === 3)
  check('...asked by one read-only eth_call per candidate, to Base\'s public RPC', w.calls.filter((c) => c.url.host === 'mainnet.base.org').every((c) => JSON.parse(c.init.body).method === 'eth_call'))
  check('no vendor\'s own service is called', !w.calls.some((c) => /zeustrade\.io$/.test(c.url.host) && c.url.host !== 'app.zeustrade.io') && !w.calls.some((c) => /blazephoenix|after-hours-public|stocking\.live|maxxagent\.xyz|mcp\./.test(c.url.host)))
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ listed: () => true }).fetchImpl, endpoint: 'https://pos.test' })
  check('Stockings listing two candidates would have to ask', tryOf(r, 'stockings', 'CRCLc').decision === 'ambiguous')
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ listed: () => null }).fetchImpl, endpoint: 'https://pos.test' })
  check('a chain that could not be read is unreadable, not "not listed"', row(r, 'stockings').stars === null)
  r = await crashTest({ ticker: 'CRCL', fetchImpl: world({ zeus: () => res(200, 'console.log(1)') }).fetchImpl, endpoint: 'https://pos.test' })
  check('a Zeus bundle without its table is unreadable', row(r, 'zeus').stars === null)
}

console.log('dry')
{
  const src = fs.readFileSync(new URL('./crash-test.mjs', import.meta.url), 'utf8')
  check('it never signs, sends or holds a key, and builds no swap', !/eth_send|eth_sign|personal_sign|signTypedData|sendTransaction|privateKey|mnemonic|buyFlow|\/routes\b/i.test(src))
  check('no credential anywhere', !/authorization|api[_-]?key|x-api-key/i.test(src))
  const posts = [...src.matchAll(/method:\s*'(POST|PUT|PATCH|DELETE)'/g)]
  check('the one outside call that is not a GET is the read-only eth_call to Base\'s public RPC', posts.length === 1 && /fetchImpl\(BASE_RPC_URL, \{ method: 'POST'/.test(src) && /method: 'eth_call'/.test(src) && (src.match(/jsonrpc: '2\.0'/g) || []).length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
