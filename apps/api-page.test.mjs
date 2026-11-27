// apps/api-page.test.mjs: /api, every call with its price (owner, 22.11). It lists every route the HTTP reference
// documents and every tool the MCP server offers; each price on it is the one the server really charges (measured
// against the live limiter, not read back from the page's own table); the paid pass is shown only where passes are
// sold, with the payment module's own terms; and a reader that runs no script gets all of it.
//
// Run: node apps/api-page.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Ajv from 'ajv'
import { createStocksWeb, PASSPORT_UNITS, PAID_VERIFY_BATCH, batchUnits } from './stocks-web.mjs'
import { MAX_VERIFY_BATCH, toolsFor } from './stocks-mcp-http.mjs'
import { apiPage, HTTP_ROUTES, TOOL_INFO, costWords, EXAMPLE_ADDRESS } from './stocks-api-page.mjs'
import { sitemapUrls } from './stocks-seo.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const server = read('./stocks-web.mjs'), httpDoc = read('../docs/reference/http-api.md'), toolsDoc = read('../docs/reference/tools.md'), docsCss = read('./stocks-web/docs.css')
const PER_MINUTE = Number((server.match(/const RATE = \{ perMinute: (\d+) \}/) || [])[1])
const LIMITS = { perMinute: PER_MINUTE, passportUnits: PASSPORT_UNITS, freeBatch: MAX_VERIFY_BATCH, paidBatch: PAID_VERIFY_BATCH }
const PASS = { priceUsd: 0.01, passMinutes: 10, passRate: 600 }
const tools = toolsFor(24)
const render = (pass) => apiPage({ origin: 'https://proofofstock.xyz', version: '9.9.9', assets: { css: 'style.css', docsCss: 'docs.css', apiJs: 'api.js' }, tools, limits: LIMITS, pass })
const card = (page, id) => (page.match(new RegExp(`<article class="[^"]*" id="${id}">[\\s\\S]*?</article>`)) || [''])[0]
const costOf = (c) => unesc((c.match(/<span class="ap-cost [^"]*">([^<]*)<\/span>/) || [])[1] || '')

console.log('every route the reference documents, and every tool the server offers')
const onPage = render(PASS), offPage = render(null)
{
  // The headings of docs/reference/http-api.md name each route: "## `GET /verify`", "### `POST /api/agent-test`", and two in one.
  const documented = [...new Set([...httpDoc.matchAll(/^#{2,3} .*$/gm)].flatMap((m) => [...m[0].matchAll(/`(?:GET|POST) (\/[^`]*)`/g)].map((x) => x[1])))]
  check('the reference documents at least fifteen routes (the parse found them)', documented.length >= 15, documented.join(' '))
  const paths = new Set([...onPage.matchAll(/<code class="ap-path">([^<]*)<\/code>/g)].map((m) => unesc(m[1])))
  const text = unesc(onPage)
  for (const p of documented) check(`the page lists ${p}`, paths.has(p) || (p === '/anchors/<file>' && paths.has('/anchors/') && text.includes('/anchors/<file>')), [...paths].join(' '))
  check('…and lists nothing the reference does not document', [...paths].filter((p) => p.startsWith('/')).every((p) => documented.includes(p) || p === '/api/status/payments' && httpDoc.includes('`GET /api/status/payments`')))
  check('every route card links to its own anchor in the reference', HTTP_ROUTES.every((r) => httpDoc.includes(`<a id="${r.doc}"></a>`)))
  check('the MCP server offers eleven tools and the page has a card for each', tools.length === 11 && tools.every((t) => TOOL_INFO[t.name] && card(onPage, `t-${t.name}`)), tools.map((t) => t.name).join(' '))
  check('…and no card for a tool the server lacks', Object.keys(TOOL_INFO).every((n) => tools.some((t) => t.name === n)))
  check('every tool card links to its anchor in the tools reference', tools.every((t) => toolsDoc.includes(`<a id="tool-${t.name}"></a>`)))
  const ajv = new Ajv({ strict: false })
  for (const t of tools) check(`the ${t.name} example sends arguments its own schema accepts`, ajv.validate(t.inputSchema, TOOL_INFO[t.name].args), JSON.stringify(ajv.errors))
  check('the example address is a listed token\'s, as the docs use it', /^0x[0-9a-f]{40}$/.test(EXAMPLE_ADDRESS) && read('./stocks-web/index.html').includes('0xb200&hellip;108c') && EXAMPLE_ADDRESS.startsWith('0xb200') && EXAMPLE_ADDRESS.endsWith('108c'))
}

console.log('the prices are the server\'s')
{
  check(`the free tier is the limiter's ${PER_MINUTE} units a minute`, PER_MINUTE > 0 && onPage.includes(`<b>${PER_MINUTE} units</b>`))
  check(`the passport costs ${PASSPORT_UNITS} units, over HTTP and over MCP`, costOf(card(onPage, 'r-passport')) === `${PASSPORT_UNITS} units` && costOf(card(onPage, 't-stock_passport')) === `${PASSPORT_UNITS} units`)
  check('a batch costs ⌈n/10⌉, over HTTP and over MCP', costOf(card(onPage, 'r-verify-batch')) === '⌈n/10⌉ units' && costOf(card(onPage, 't-verify_stock_tokens')) === '⌈n/10⌉ units' && /Costs ⌈n\/10⌉ units of the rate limit/.test(httpDoc))
  check('the routes outside the limit say so: the badge, /anchors/, /api/status/payments', ['r-badge', 'r-anchors', 'r-payments'].every((id) => costOf(card(onPage, id)) === 'outside the limit') && costOf(card(onPage, 'r-find')) === '1 unit')
  check(`the free batch is the server's ${MAX_VERIFY_BATCH}, the paid one ${PAID_VERIFY_BATCH}`, card(onPage, 'r-verify-batch').includes(`up to ${MAX_VERIFY_BATCH} addresses`) && card(onPage, 'r-verify-big').includes(`${MAX_VERIFY_BATCH + 1} to ${PAID_VERIFY_BATCH} addresses`))
  // What MCP charges is what batchUnits() computes for that very request: the page cannot drift from the limiter.
  for (const t of tools) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: TOOL_INFO[t.name].args } })
    const units = batchUnits(body), words = costOf(card(onPage, `t-${t.name}`))
    const want = TOOL_INFO[t.name].cost === 'batch' ? '⌈n/10⌉ units' : costWords(units, LIMITS)
    check(`${t.name}: the page says ${words}, the limiter charges its example ${units}`, words === want && (TOOL_INFO[t.name].cost !== 'batch' || units === Math.ceil(TOOL_INFO[t.name].args.addresses.length / 10)))
  }
  check('what a minute buys is the limiter\'s arithmetic', onPage.includes(`<b>${Math.floor(PER_MINUTE / PASSPORT_UNITS)}</b><span>passports`) && onPage.includes(`<b>${Math.floor(PER_MINUTE / Math.ceil(MAX_VERIFY_BATCH / 10)) * MAX_VERIFY_BATCH}</b><span>addresses checked`))
  check('with passes on: the pass\'s price, length and rate are the payment module\'s', costOf(card(onPage, 'r-pass')) === '0.01 USDC' && onPage.includes('0.01 USDC on Base buys 10 minutes at 600 units a minute') && card(onPage, 'r-pass').includes('curl -i &#39;https://proofofstock.xyz/api/pass&#39;'))
  check('…another price is printed as given, not as 0.01', render({ priceUsd: 0.05, passMinutes: 30, passRate: 900 }).includes('0.05 USDC on Base buys 30 minutes at 900 units a minute'))
  check('…and it says both x402 versions are taken', /x402, version 1 or 2/.test(onPage) && /\(v1\)/.test(card(onPage, 'r-pass')) && /\(v2\)/.test(card(onPage, 'r-pass')))
  // Review 23.11: /api/pass answers its 402 as v2 in the body too, so the card never says the body is v1.
  check('…and the pass card says its 402 is v2, in the header and the body, never that the body is v1', /as x402 v2 in the PAYMENT-REQUIRED header and in the body/.test(card(onPage, 'r-pass')) && !/v1 in the body/.test(card(onPage, 'r-pass')))
  // The claims a reviewer found past the docs (23.11): each now matches docs/reference/http-api.md.
  check('the case log says its window: the last 7 days, up to 50 events', /The case log of the last 7 days, up to 50 events/.test(onPage) && !/never rewritten/.test(onPage))
  check('the list example names <hex> and what the digest must equal, never registry_hash pasted as is', /must print &lt;hex&gt;/.test(onPage) && !/api\/list\/&lt;registry_hash&gt;/.test(onPage))
  check('the big batch example runs as written: a shell variable, no brackets or spaces in the URL', /addresses=\$ADDRS/.test(onPage) && !/addresses=&lt;\d+ to \d+ addresses/.test(onPage))
  check('the free tier says who a client is and works one batch cost through', /per client \(one IP address; IPv6 by its \/56\)/.test(onPage) && /\(50 addresses: 5 units\)/.test(onPage))
  check('with passes off: no price, no pass card, and it says so', !offPage.includes('USDC') && !card(offPage, 'r-pass') && /Paid passes<\/h2><span class="ap-badge off">off here/.test(offPage))
}

console.log('a reader that runs no script gets all of it')
{
  check('no inline script or style, no handler: the CSP holds', !/<script(?![^>]*\ssrc=)|<style|\sstyle=|\son[a-z]+=/.test(onPage))
  check('the only script is api.js, and it only adds copy buttons', [...onPage.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).join() === 'api.js' && !/fetch\(|innerHTML/.test(read('./stocks-web/api.js')))
  check('the copy buttons are hidden until the script shows them: no dead button without it', [...onPage.matchAll(/<button[^>]*>/g)].every((m) => /\shidden>$/.test(m[0])) && read('./stocks-web/api.js').includes('b.hidden = false'))
  check('every example is plain text in the page, escaped', HTTP_ROUTES.every((r) => onPage.includes(r.example('https://proofofstock.xyz').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))))
  const unstyled = [...new Set([...onPage.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].filter((c) => c.startsWith('ap') && !new RegExp('\\.' + c + '[\\s{.:,\\[]').test(docsCss))
  check('every ap- class it uses is styled', !unstyled.length, unstyled.join(' '))
  check('on a phone the cards stack in one column', /@media \(max-width: 900px\) \{ \.ap-list, \.ap-tiers, \.ap-buys \{ grid-template-columns: minmax\(0, 1fr\); \} \}/.test(docsCss))
  check('the page is in the sitemap', sitemapUrls({ site: 'https://x', docs: [] }).some((u) => u.loc === 'https://x/api'))
}

console.log('served, and the limiter charges what the page says')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-page-'))
const fake = () => ({ enabled: true, wallet: '0x' + '02'.repeat(20), priceUsd: 0.01, passMinutes: 10, passRate: 600, description: 'a pass',
  pausedUntil: () => 0, passActive: () => false, passRateOf: () => null, accepts: () => null, purchase: async () => ({ ok: false }) })
const serve = async (x402Module, fn) => {
  const app = createStocksWeb({ listLocks: false, roots: { base: path.join(root, 'b'), robinhood: path.join(root, 'r') }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module })
  const { port } = await app.start(0, '127.0.0.1')
  try { return await fn(`http://127.0.0.1:${port}/stocks`) } finally { await app.stop() }
}
try {
  await serve(fake, async (b) => {
    const r = await fetch(b + '/api')
    const page = await r.text()
    check('GET /api is a page: 200, text/html, the CSP header on it', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && /script-src 'self'/.test(r.headers.get('content-security-policy') || ''))
    check('served with passes on, it shows the pass at 0.01 USDC', costOf(card(page, 'r-pass')) === '0.01 USDC')
    check(`served, the passport is priced at the limiter's ${PASSPORT_UNITS} units`, costOf(card(page, 'r-passport')) === `${PASSPORT_UNITS} units` && page.includes(`<b>${PER_MINUTE} units</b>`))
    check('its head has a canonical link to the public /api', page.includes('<link rel="canonical" href="https://proofofstock.xyz/api">'))
    const js = await fetch(b + '/' + (page.match(/<script src="(api\.js\?v=[0-9a-f]+)"/) || [])[1])
    check('api.js is served, by content hash', js.status === 200 && /javascript/.test(js.headers.get('content-type')))
    check('every relative link on it opens a page or a file of the site', (await Promise.all([...new Set([...page.matchAll(/href="((?:docs\/|\.\/|api|status|history)[^"#]*)/g)].map((m) => m[1]))]
      .map(async (h) => (await fetch(new URL(h, b + '/api'), { headers: { accept: 'text/html' } })).status))).every((s) => s === 200))
  })
  await serve(null, async (b) => {
    const page = await (await fetch(b + '/api')).text()
    check('served with passes off, it sells nothing', !page.includes('USDC') && page.includes('off here'))
    // The limiter itself: 20 passports use the whole free minute, so the next 1-unit read is refused.
    const st = []
    for (let i = 0; i < Math.floor(PER_MINUTE / PASSPORT_UNITS); i++) st.push((await fetch(`${b}/api/passport?chain=base&address=${EXAMPLE_ADDRESS}`)).status)
    check(`${Math.floor(PER_MINUTE / PASSPORT_UNITS)} passports fit the free minute`, st.every((s) => s !== 429), st.join())
    check(`…and use all of it: the next 1-unit read is a 429 (a passport is ${PASSPORT_UNITS} units)`, (await fetch(`${b}/api/find?q=nvda`)).status === 429)
    // Routes the page says are outside the limit stay open past it.
    const free = await Promise.all(['/badge.svg?chain=base&address=' + EXAMPLE_ADDRESS, '/anchors/', '/api/status/payments'].map(async (p) => (await fetch(b + p)).status))
    check('the badge, /anchors/ and /api/status/payments answer past the limit, as the page says', free.every((s) => s === 200), free.join())
  })
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
