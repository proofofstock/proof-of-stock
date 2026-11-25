// packages/proofofstock-guard/examples/agent-search.test.mjs: the search flow (examples/agent-search.mjs) with every answer
// a fake. It must take as candidates only tokens that carry the stock's name, ask the guard about all of them in one
// batch, buy only the one the issuer lists (never a look-alike, never a token it cannot vouch for), call a token outside
// the list "not on the issuer's list" and not "fake", keep strangers' names short and linkless, and stop on anything it
// could not read.
//
// Run: node packages/proofofstock-guard/examples/agent-search.test.mjs
import { searchFlow, searchCandidates, cleanLabel, termsFor, parseIntent, GECKO } from './agent-search.mjs'
import { KYBER_ROUTER } from './agent-buy.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const REAL = '0x' + 'b2'.repeat(20), FAKE1 = '0x' + 'f1'.repeat(20), FAKE2 = '0x' + 'f2'.repeat(20), OTHER = '0x' + 'd1'.repeat(20), USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', MEME = '0x' + 'ee'.repeat(20)
const proof = { issuer: 'coinbase', addresses_sha256: 'a'.repeat(64), reproduce: 'curl ...', stale: false }
const res = (status, body) => ({ status, json: async () => body })
const tok = (address, symbol, name) => ({ id: 'base_' + address, type: 'token', attributes: { address, symbol, name } })
const pool = (base, quote, reserve) => ({ attributes: { reserve_in_usd: String(reserve) }, relationships: { base_token: { data: { id: 'base_' + base } }, quote_token: { data: { id: 'base_' + quote } } } })
const answer = (a) => a === REAL ? { address: REAL, listed: true, symbol: 'CRCLc', registries_checked: ['coinbase:base'], registry_age_s: 60 }
  : a === FAKE1 || a === FAKE2 ? { address: a, listed: false, registries_checked: ['coinbase:base'], impostor: { kinds: ['registry_symbol'], imitates_symbol: 'CRCLc', listed_address: REAL } }
    : { address: a, listed: false, registries_checked: ['coinbase:base'] }

function world (over = {}) {
  const w = {
    gecko: () => ({ data: [pool(REAL, USDC, 900000), pool(FAKE1, USDC, 1200), pool(FAKE2, USDC, 50), pool(OTHER, USDC, 7000), pool(MEME, USDC, 99999)],
      included: [tok(REAL, 'CRCLc', 'Circle Internet Group Inc.'), tok(FAKE1, 'CRCLc', 'Circle'), tok(FAKE2, 'CRCLc', 'Visit crcl-airdrop.com now'), tok(OTHER, 'CRCL.D', 'Dinari CRCL'), tok(USDC, 'USDC', 'USD Coin'), tok(MEME, 'PEPE', 'Pepe')] }),
    verify: (list) => ({ results: list.map(answer), list_proof: proof }),
    find: () => ({ match: 'exact', matches: [{ chain: 'robinhood', symbol: 'CRCL', name: 'Circle' }, { chain: 'base', symbol: 'CRCLc', name: 'Circle Internet Group Inc.', address: REAL }] }),
    passport: () => ({ issuer: { minted: true, paused: [] }, reference: { price_usd: 46 }, market_now: { session: 'regular' } }),
    routes: (q) => ({ data: { routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: q.get('amountIn'), amountOut: String(Math.round(Number(q.get('amountIn')) / 1e6 / 46.2 * 1e8)), route: [] } } }),
    decimals: () => ({ result: '0x08' }),
    build: () => ({ data: { routerAddress: KYBER_ROUTER, data: '0xe21fd0e9' + '00'.repeat(64) } }),
    ...over,
  }
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push({ url: String(url), init })
    const pick = (fn, arg) => { const b = fn(arg); return b instanceof Error ? Promise.reject(b) : b && b.__status ? res(b.__status, {}) : res(200, b) }
    if (String(url).startsWith(GECKO + '/search/pools')) return pick(w.gecko, u.searchParams)
    if (u.pathname === '/verify' && u.searchParams.get('addresses')) return pick(w.batch || w.verify, u.searchParams.get('addresses').split(','))
    if (u.pathname === '/verify') return pick((a) => { const b = w.verify([a]); return b && b.results ? { ...b.results[0], list_proof: proof } : b }, u.searchParams.get('address'))
    if (u.pathname === '/api/find') return pick(w.find, u.searchParams.get('q'))
    if (u.pathname === '/api/passport') return pick(w.passport, u.searchParams.get('address'))
    if (u.pathname.endsWith('/routes')) return pick(w.routes, u.searchParams)
    if (u.pathname.endsWith('/route/build')) return pick(w.build, JSON.parse(init.body))
    if (u.host === 'mainnet.base.org') return pick(w.decimals, JSON.parse(init.body))
    return res(404, {})
  }
  return { fetchImpl, calls }
}
// verify answers a single address too (the buy re-checks the pick): the fake above maps it through the same table.
async function go (args, over) {
  const { fetchImpl, calls } = world(over), out = [], steps = []
  const r = await searchFlow({ fetchImpl, print: (s) => out.push(s), endpoint: 'https://pos.test', onStep: (e) => steps.push(e), ...args }).catch((e) => ({ code: 'threw', error: String(e) }))
  return { ...r, text: out.join('\n'), calls, steps }
}
const stepOf = (r, name) => r.steps.find((e) => e.step === name)

console.log('the market search')
{
  const { fetchImpl, calls } = world()
  const c = await searchCandidates({ ticker: 'CRCL', name: 'Circle Internet Group Inc.' }, { fetchImpl })
  check('it searches GeckoTerminal on Base by the ticker', calls.length === 1 && calls[0].url === `${GECKO}/search/pools?query=CRCL&network=base&include=base_token,quote_token`)
  check('candidates are the tokens carrying the ticker or the company\'s name, never the quote token or an unrelated one', c.map((x) => x.address).sort().join() === [REAL, FAKE1, FAKE2, OTHER].sort().join(), c.map((x) => x.symbol).join())
  check('...most liquid first, with the liquidity of their pools', c[0].address === REAL && c[0].liquidityUsd === 900000 && c[0].pools === 1 && c.at(-1).address === FAKE2)
  check('...and a stranger\'s name is shown without its link', c.find((x) => x.address === FAKE2).name === 'Visit … now')
  const down = await searchCandidates({ ticker: 'CRCL' }, { fetchImpl: world({ gecko: () => ({ __status: 429 }) }).fetchImpl })
  check('a search that cannot be read is null, not an empty market', down === null)
  check('terms: the ticker and the company\'s first word', termsFor({ ticker: 'crcl', name: 'Circle Internet Group Inc.' }).join() === 'CRCL,CIRCLE' && termsFor({ ticker: 'NVDA', name: 'NVDA' }).join() === 'NVDA')
}

console.log('a stranger\'s text')
{
  check('a link or a domain is cut out', cleanLabel('claim at https://x.co/a now') === 'claim at … now' && cleanLabel('go www.evil.io') === 'go …' && cleanLabel('TSLA tesla-drop.xyz/claim') === 'TSLA …')
  check('control and direction characters go, lines become one, length is capped', cleanLabel('a‮b\nc\u0000d') === 'a b c d' && cleanLabel('x'.repeat(60)).length === 28 && cleanLabel('x'.repeat(60)).endsWith('…'))
}

console.log('the search, then the buy')
{
  const r = await go({ query: 'Circle', ticker: 'CRCL' })
  check('the steps in order: search, candidates, verdicts, the pick, then the buy of the pick', r.steps.map((e) => e.step).join() === 'search,candidates,verdicts,pick,request,handed,guard_handed,guard_real,passport,quote,link', r.steps.map((e) => e.step).join())
  const batch = r.calls.filter((c) => c.url.includes('/verify?chain=base&addresses='))
  check('every candidate is asked about in one batch', batch.length === 1 && new URL(batch[0].url).searchParams.get('addresses').split(',').length === 4)
  const v = stepOf(r, 'verdicts').verdicts
  check('the look-alikes are refused as impostors, naming what they copy', v.filter((x) => x.decision === 'impostor').map((x) => x.address).sort().join() === [FAKE1, FAKE2].sort().join() && v.filter((x) => x.decision === 'impostor').every((x) => x.imitates === 'CRCLc' && !x.allow))
  check('another issuer\'s token is "not listed", refused, and said not to be fake for that', v.find((x) => x.address === OTHER).decision === 'not_listed' && !v.find((x) => x.address === OTHER).allow && /does not make it fake/.test(v.find((x) => x.address === OTHER).reason) && !/scam/i.test(v.find((x) => x.address === OTHER).reason))
  check('the pick is the one the issuer lists', stepOf(r, 'pick').address === REAL && stepOf(r, 'pick').how === 'search' && v.find((x) => x.address === REAL).listed_symbol === 'CRCLc')
  check('the quote is asked for the pick only, never a look-alike', r.calls.filter((c) => c.url.includes('/routes')).every((c) => new URL(c.url).searchParams.get('tokenOut') === REAL) && r.code === 0 && r.outcome === 'quoted', r.text)
  check('...and nothing is ever sent', !r.calls.some((c) => /eth_send|signature|private/i.test(String(c.init.body || '') + c.url)))
  const w = await go({ query: 'Circle', ticker: 'CRCL', from: '0x' + 'ab'.repeat(20), usd: 2 })
  check('with a wallet: the unsigned swap of the amount asked, for the pick', w.code === 0 && w.outcome === 'built' && w.calls.some((c) => c.url.includes('/routes') && new URL(c.url).searchParams.get('amountIn') === '2000000'), w.text)
}

console.log('when the search does not surface the original')
{
  const noReal = { gecko: () => ({ data: [pool(FAKE1, USDC, 10)], included: [tok(FAKE1, 'CRCLc', 'Circle')] }) }
  const r = await go({ query: 'Circle', ticker: 'CRCL' }, noReal)
  check('a look-alike\'s answer names the real one: that is the pick, never the look-alike', stepOf(r, 'pick').address === REAL && stepOf(r, 'pick').how === 'pointer' && r.code === 0)
  const none = await go({ query: 'Circle', ticker: 'CRCL' }, { gecko: () => ({ data: [], included: [] }) })
  check('nothing found: no batch, and the buy looks the issuer\'s own up itself', stepOf(none, 'candidates').candidates.length === 0 && !none.calls.some((c) => c.url.includes('addresses=')) && none.calls.some((c) => c.url.includes('/api/find')) && none.code === 0, none.text)
}

console.log('a name, not a ticker')
{
  const r = await go({ query: 'Circle' })
  check('the ticker comes from the issuer-listed search on Base', stepOf(r, 'search').ticker === 'CRCL' && r.calls[0].url === 'https://pos.test/api/find?q=Circle')
  const unknown = await go({ query: 'Acme' }, { find: () => ({ match: 'none', matches: [] }) })
  check('a name the issuer does not list on Base: refused, nothing searched', unknown.code === 1 && !unknown.calls.some((c) => c.url.startsWith(GECKO)))
}

console.log('a request in a person\'s words (owner, 25.11: "Tesla 7000$" was searched as a stock called "Tesla 7000")')
{
  const cases = [
    ['Tesla 7000$', 'Tesla', 7000], ['buy $20 of SNDK on Base', 'SNDK', 20], ['\u043a\u0443\u043f\u0438 \u0442\u0435\u0441\u043b\u0443 \u043d\u0430 7000 \u0434\u043e\u043b\u043b\u0430\u0440\u043e\u0432', 'Tesla', 7000], ['\u0442\u0435\u0441\u043b\u044b \u043d\u0430 7 \u0442\u044b\u0441\u044f\u0447', 'Tesla', 7000],
    ['nvidia 7k', 'NVIDIA', 7000], ['$2 circle', 'Circle', 2], ['TSLA 50 usdc', 'TSLA', 50], ['$7,000 tesla', 'Tesla', 7000], ['NVDA $1,250.50', 'NVDA', 1250.5],
    ['7,5$ tesla', 'Tesla', 7.5], ['buy tesla for $50', 'Tesla', 50], ['Find me Tesla 7000 on Base', 'Tesla', 7000], ['Circle', 'Circle', null], ['apple', 'Apple', null], ['AAPL', 'AAPL', null],
  ]
  const bad = cases.filter(([t, q, u]) => { const r = parseIntent(t); return r.query !== q || r.usd !== u }).map(([t]) => `${t} -> ${JSON.stringify(parseIntent(t))}`)
  check('the stock and the amount come apart, in any order, in English or Russian, with $, usd, k or \u0442\u044b\u0441\u044f\u0447', bad.length === 0, bad.join(' | '))
  check('an amount alone names no stock', parseIntent('7000').query === '' && parseIntent('7000').usd === 7000)
  const r = await go({ query: 'Tesla 7000$' }, { find: () => ({ match: 'exact', matches: [{ chain: 'base', symbol: 'CRCLc', name: 'Circle Internet Group Inc.' }] }) })
  check('...and the flow searches for the stock and quotes the amount', r.calls[0].url === 'https://pos.test/api/find?q=Tesla' && stepOf(r, 'search').usd === 7000 && r.calls.some((c) => c.url.includes('/routes') && new URL(c.url).searchParams.get('amountIn') === '7000000000'), r.text)
  const field = await go({ query: 'Circle', ticker: 'CRCL', usd: 5 })
  check('without an amount in the words, the amount given beside them is used', field.calls.some((c) => c.url.includes('/routes') && new URL(c.url).searchParams.get('amountIn') === '5000000'))
  const none = await go({ query: '7000 usd', ticker: null })
  check('an amount with no stock: asked which stock, nothing bought', none.code === 2 && /which stock/.test(none.text))
}

console.log('anything unread stops it (exit 3)')
for (const [label, over] of [['the market search', { gecko: () => ({ __status: 500 }) }], ['the batch check', { batch: () => ({ __status: 503 }) }], ['the issuer-listed search', { find: () => ({ __status: 503 }) }]]) {
  const r = await go({ query: 'Circle', ticker: label === 'the issuer-listed search' ? null : 'CRCL' }, over)
  check(`${label} unreadable: exit 3, no quote`, r.code === 3 && !r.calls.some((c) => c.url.includes('/routes')), r.text)
}
{
  const bad = await go({ query: '', ticker: 'CRCL' })
  check('no stock named: exit 2', bad.code === 2)
  const badT = await go({ query: 'Circle', ticker: 'CR CL' })
  check('a ticker that is not one: exit 2', badT.code === 2)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
