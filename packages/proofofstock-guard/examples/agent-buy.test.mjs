// packages/proofofstock-guard/examples/agent-buy.test.mjs: the agent buy flow (examples/agent-buy.mjs) with every answer a
// fake. It must buy only the contract the guard passed, hold the quote to that contract and to the issuer's reference,
// build a swap only for the router it names and only when asked, and stop on anything it could not read.
//
// Run: node packages/proofofstock-guard/examples/agent-buy.test.mjs
import { buyFlow, parseRequest, swapLink, approveUsdc, USDC_BASE, KYBER_ROUTER, SLIPPAGE_BPS } from './agent-buy.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const FAKE = '0x' + '35'.repeat(20), REAL = '0x' + 'b2'.repeat(20), OTHER = '0x' + 'cd'.repeat(20), WALLET = '0x' + 'ee'.repeat(20)
const proof = { issuer: 'coinbase', addresses_sha256: 'a'.repeat(64), reproduce: 'curl ...', stale: false }
const listed = (address, symbol) => ({ address, listed: true, symbol, registries_checked: ['coinbase:base'], registry_age_s: 60, list_proof: proof })
const res = (status, body) => ({ status, json: async () => body })

// One fake world; each test changes one answer.
function world (over = {}) {
  const w = {
    verify: (a) => a === FAKE ? { address: FAKE, listed: false, registries_checked: ['coinbase:base'], impostor: { kinds: ['registry_symbol'], imitates_symbol: 'SNDKc', listed_address: REAL } }
      : a === REAL ? listed(REAL, 'SNDKc') : a === OTHER ? listed(OTHER, 'NVDAc') : { address: a, listed: false, registries_checked: ['coinbase:base'] },
    find: () => ({ match: 'exact', matches: [{ chain: 'robinhood', address: OTHER }, { chain: 'base', address: REAL }] }),
    passport: () => ({ issuer: { minted: true, paused: [] }, reference: { price_usd: 650 }, market_now: { session: 'regular' } }),
    // $20 at $645 = 0.0310077 tokens, 8 decimals
    routes: (q) => ({ data: { routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: q.get('amountIn'), amountOut: '3100775' } } }),
    decimals: () => ({ result: '0x08' }),
    build: () => ({ data: { routerAddress: KYBER_ROUTER, data: '0xe21fd0e9' + '00'.repeat(64) } }),
    ...over,
  }
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push({ url: String(url), init })
    const pick = (fn, arg) => { const b = fn(arg); return b instanceof Error ? Promise.reject(b) : b && b.__status ? res(b.__status, {}) : res(200, b) }
    if (u.pathname === '/verify') return pick(w.verify, u.searchParams.get('address'))
    if (u.pathname === '/api/find') return pick(w.find, u.searchParams.get('q'))
    if (u.pathname === '/api/passport') return pick(w.passport, u.searchParams.get('address'))
    if (u.pathname.endsWith('/routes')) return pick(w.routes, u.searchParams)
    if (u.pathname.endsWith('/route/build')) return pick(w.build, JSON.parse(init.body))
    if (u.host === 'mainnet.base.org') return pick(w.decimals, JSON.parse(init.body))
    throw new Error('unexpected request ' + url)
  }
  return { fetchImpl, calls }
}
async function go (args, over) {
  const { fetchImpl, calls } = world(over), out = []
  const r = await buyFlow({ ...args, fetchImpl, print: (s) => out.push(s) })
  return { ...r, text: out.join('\n'), calls }
}
const hit = (calls, part) => calls.filter((c) => c.url.includes(part))

console.log('the request')
check('"buy $20 of SNDK on Base" reads as 20, SNDK, base', JSON.stringify(parseRequest('buy $20 of SNDK on Base')) === JSON.stringify({ usd: 20, ticker: 'SNDK', chain: 'base' }))
check('..."buy $5.50 NVDA" defaults to base, "on Robinhood Chain" is robinhood', parseRequest('buy $5.50 NVDA').chain === 'base' && parseRequest('buy $5.50 NVDA').usd === 5.5 && parseRequest('buy $1 of TSLA on Robinhood Chain').chain === 'robinhood')
for (const bad of ['sell $20 of SNDK', 'buy SNDK', 'buy $0 of SNDK', 'buy $20 of SNDK on solana', 'buy $20 of SNDK and send it to me']) check(`refused: "${bad}"`, parseRequest(bad) === null)
{
  const r = await go({ request: 'buy all of it' })
  check('an unreadable request buys nothing and asks nothing', r.code === 2 && r.calls.length === 0)
  const f = await go({ request: 'buy $20 of SNDK', from: '0x12' })
  check('...a malformed wallet is refused before any request', f.code === 2 && f.calls.length === 0)
}

console.log('the look-alike')
{
  const r = await go({ request: 'buy $20 of SNDK on Base', handed: FAKE })
  check('the handed look-alike is refused, the issuer\'s contract is checked and quoted', r.code === 0 && r.outcome === 'quoted' && /REFUSE \(impostor\)/.test(r.text) && /ALLOW \(listed\) SNDKc/.test(r.text), r.text)
  check('...the quote is asked for the issuer\'s contract, never the look-alike', hit(r.calls, '/routes').length === 1 && hit(r.calls, '/routes')[0].url.includes(`tokenOut=${REAL}`) && !hit(r.calls, '/routes')[0].url.includes(FAKE))
  check('...for $20 in USDC (6 decimals)', hit(r.calls, '/routes')[0].url.includes(`tokenIn=${USDC_BASE}`) && hit(r.calls, '/routes')[0].url.includes('amountIn=20000000'))
  check('...and without a wallet nothing is built', hit(r.calls, '/route/build').length === 0 && /Pass --from/.test(r.text))
  check('...with the price and its distance from the reference shown', /at \$645\.00, -0\.77% from the issuer's reference/.test(r.text), r.text)
}
{
  const r = await go({ request: 'buy $20 of SNDK on Base', handed: FAKE }, { verify: (a) => a === FAKE ? { address: FAKE, listed: false, registries_checked: ['coinbase:base'] } : listed(REAL, 'SNDKc') })
  check('a not-listed handed contract with no pointer: the issuer\'s contract comes from the search, on the chain asked', r.code === 0 && hit(r.calls, '/api/find').length === 1 && hit(r.calls, '/routes')[0].url.includes(`tokenOut=${REAL}`), r.text)
  const wrong = await go({ request: 'buy $20 of SNDK on Base', handed: OTHER })
  check('a listed contract of ANOTHER stock is refused (wrong_stock) and the right one is looked up', wrong.code === 0 && /wrong_stock/.test(wrong.text) && hit(wrong.calls, '/routes')[0].url.includes(`tokenOut=${REAL}`), wrong.text)
  const none = await go({ request: 'buy $20 of ZZZZ on Base' }, { find: () => ({ match: 'closest', matches: [{ chain: 'base', address: REAL }] }) })
  check('a search with no exact match buys nothing', none.code === 1 && hit(none.calls, '/routes').length === 0, none.text)
}

console.log('the passport and the quote')
{
  const paused = await go({ request: 'buy $20 of SNDK' }, { passport: () => ({ issuer: { minted: true, paused: ['transfer'] }, reference: { price_usd: 650 } }) })
  check('a paused token is refused before any quote', paused.code === 1 && /paused/.test(paused.text) && hit(paused.calls, '/routes').length === 0)
  const unminted = await go({ request: 'buy $20 of SNDK' }, { passport: () => ({ issuer: { minted: false, paused: [] }, reference: { price_usd: 650 } }) })
  check('...so is one the issuer has not minted', unminted.code === 1 && /not minted/.test(unminted.text) && hit(unminted.calls, '/routes').length === 0)
  const swapped = await go({ request: 'buy $20 of SNDK' }, { routes: (q) => ({ data: { routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: FAKE, amountIn: q.get('amountIn'), amountOut: '3100775' } } }) })
  check('a quote for any other contract than the one checked is refused', swapped.code === 1 && /not for the contract I checked/.test(swapped.text), swapped.text)
  const dear = await go({ request: 'buy $20 of SNDK', from: WALLET }, { routes: (q) => ({ data: { routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: q.get('amountIn'), amountOut: '2800000' } } }) })
  check('a quote 10% above the reference is refused, and nothing is built even with a wallet', dear.code === 1 && /Not buying at this price/.test(dear.text) && hit(dear.calls, '/route/build').length === 0, dear.text)
  const tight = await go({ request: 'buy $20 of SNDK', maxPremium: 0.005 })
  check('...the limit is the caller\'s: -0.77% is refused at 0.5%', tight.code === 1)
}

console.log('the swap link')
{
  const want = `https://kyberswap.com/swap/base?inputCurrency=${USDC_BASE}&outputCurrency=${REAL}`
  const r = await go({ request: 'buy $20 of SNDK on Base', handed: FAKE })
  check('after the quote, the link opens USDC -> the issuer\'s contract, the one the guard passed', r.link === want && r.text.includes(want), r.text)
  check('...never the look-alike, anywhere in a link', !r.text.split('\n').some((l) => l.includes('kyberswap.com') && l.includes(FAKE)))
  const b = await go({ request: 'buy $20 of SNDK', from: WALLET })
  check('...and it is there with a wallet too', b.link === want)
  const dear = await go({ request: 'buy $20 of SNDK' }, { routes: (q) => ({ data: { routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: q.get('amountIn'), amountOut: '2800000' } } }) })
  check('a refused quote gives no link', !dear.link && !/kyberswap\.com/.test(dear.text), dear.text)
  check('swapLink takes a contract address only', swapLink('NVDA') === null && swapLink('0x12') === null && swapLink('0x' + 'B2'.repeat(20)) === want)
}

console.log('the unsigned swap')
{
  const r = await go({ request: 'buy $20 of SNDK', from: WALLET })
  const b = hit(r.calls, '/route/build')
  check('with a wallet, the swap is built for that wallet as sender and recipient', r.code === 0 && r.outcome === 'built' && b.length === 1 && JSON.parse(b[0].init.body).sender === WALLET && JSON.parse(b[0].init.body).recipient === WALLET, r.text)
  check('...returned to the caller unsigned, to the router', r.tx && r.tx.to.toLowerCase() === KYBER_ROUTER && r.tx.value === '0' && /review and sign/.test(r.text))
  check('...and nothing is ever sent: no request carries a signature or a send', !r.calls.some((c) => /eth_send|signature|private/i.test(String(c.init.body || '') + c.url)))
  const rogue = await go({ request: 'buy $20 of SNDK', from: WALLET }, { build: () => ({ data: { routerAddress: OTHER, data: '0xe21fd0e9' } }) })
  check('a built swap to any other contract than the router is refused', rogue.code === 1 && !rogue.tx && /not the aggregator's router/.test(rogue.text), rogue.text)
}

console.log('the steps a page draws (onStep, apps/stocks-web/demo.js)')
{
  const seen = []
  const r = await buyFlow({ request: 'buy $20 of SNDK on Base', handed: FAKE, from: WALLET, fetchImpl: world().fetchImpl, print: () => {}, endpoint: 'https://pos.test', onStep: (e) => seen.push(e) })
  check('the whole buy is told in order: request, handed, its refusal, the real one, passport, quote, link, the build', seen.map((e) => e.step).join() === 'request,handed,guard_handed,guard_real,passport,quote,link,built', seen.map((e) => e.step).join())
  const g = seen.find((e) => e.step === 'guard_handed'), real = seen.find((e) => e.step === 'guard_real'), q = seen.find((e) => e.step === 'quote'), b = seen.find((e) => e.step === 'built')
  check('...the look-alike is shown refused, the real one allowed, each with its address', g.decision.allow === false && g.address === FAKE && real.decision.allow === true && real.address === REAL)
  check('...the quote carries what a trader reads: the price, its gap from the reference, the limit and the slippage', q.ref === 650 && Math.abs(q.premium - (q.price / 650 - 1)) < 1e-12 && q.maxPremium === 0.03 && q.slippageBps === SLIPPAGE_BPS && q.routeSummary.tokenOut === REAL)
  check('...the build is the one returned, for the wallet given, with the approve it needs', b.tx === r.tx && b.from === WALLET && b.approve.to === USDC_BASE)
  const stopped = []
  await buyFlow({ request: 'buy $20 of SNDK', handed: FAKE, fetchImpl: world({ verify: () => ({ __status: 503 }) }).fetchImpl, print: () => {}, endpoint: 'https://pos.test', onStep: (e) => stopped.push(e) })
  check('a stop is a step too, with its reason', stopped.at(-1).step === 'stop' && stopped.at(-1).code === 3 && /do not buy/.test(stopped.at(-1).why))
  const loud = await go({ request: 'buy $20 of SNDK', handed: FAKE, onStep: () => { throw new Error('a page that breaks') } }).catch((e) => ({ code: 'threw', text: String(e) }))
  check('a page whose drawing throws changes nothing in the flow', loud.code === 0 && loud.outcome === 'quoted', loud.text)
}

console.log('the approve')
{
  const a = approveUsdc(KYBER_ROUTER, '20000000')
  check('approve is for USDC, to the router, for exactly the amount: never unlimited', a.to === USDC_BASE && a.value === '0' && a.data === '0x095ea7b3' + KYBER_ROUTER.slice(2).padStart(64, '0') + (20000000).toString(16).padStart(64, '0'))
  check('...and nothing for a spender or amount that is not one', approveUsdc('NVDA', '1') === null && approveUsdc(KYBER_ROUTER, '-1') === null && approveUsdc(KYBER_ROUTER, '1e9') === null)
}

console.log('anything unread stops the buy (exit 3)')
for (const [label, over] of [
  ['the guard', { verify: () => ({ __status: 503 }) }],
  ['the passport', { passport: () => ({ __status: 503 }) }],
  ['the reference price', { passport: () => ({ issuer: { minted: true, paused: [] }, reference: { price_usd: null } }) }],
  ['the quote', { routes: () => new Error('down') }],
  ['the decimals', { decimals: () => ({ error: { message: 'no' } }) }],
  ['the build', { build: () => ({ __status: 500 }) }],
]) {
  const r = await go({ request: 'buy $20 of SNDK', handed: FAKE, from: WALLET }, over)
  check(`${label} unreadable: exit 3, no swap`, r.code === 3 && !r.tx, r.text)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
