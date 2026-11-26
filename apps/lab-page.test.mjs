// apps/lab-page.test.mjs: /lab (owner, 25.11), the fake exchange, the golden impostor of the week and the crash test,
// behind Cloudflare Access. The page must never link an address anywhere (no way to trade a fake), always print a fake
// beside its original, escape the deployers' text, tell search engines to stay out, and stay linked from nowhere: not a
// tab, not in the sitemap, not in the README or the docs. Served, it must be a plain 404 until the host turns it on.
//
// Run: node apps/lab-page.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb } from './stocks-web.mjs'
import { labPage, usd, goldenLine, BOARD_ROWS } from './stocks-lab-page.mjs'
import { TABS } from './stocks-nav.mjs'
import { sitemapUrls } from './stocks-seo.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const A = (n) => '0x' + n.toString(16).padStart(40, '0')
const FAKE = A(0xf1), ORIG = A(0xc1), PICK = A(0xd1)
const board = { generated_at: '2026-11-25T06:00:00Z', live_min_usd: 100, chains: [
  { chain: 'base', totals: { stocks: 2, fakes: 3, live: 1, liquidity_usd: 12400, unread: 0 }, rows: [
    { chain: 'base', symbol: 'CRCLc', original: ORIG, fakes: 2, live: 1, liquidity_usd: 12400, unread: 0, newest_at: '2026-11-20T00:00:00Z', richest: { address: FAKE, symbol: '<img src=x onerror=alert(1)>', liquidity_usd: 12000 } },
    { chain: 'base', symbol: 'TSLAc', original: A(0xc2), fakes: 1, live: 0, liquidity_usd: 0, unread: 1, newest_at: null, richest: null }] },
  { chain: 'robinhood', error: 'impostor list not readable', rows: [] }] }
const golden = { weeks: { '2026-W47': { week: '2026-W47', chain: 'base', copied: 'NVDAc', original: A(0xc3), address: A(0xf3), symbol: 'NVDAc', liquidity_usd: 800 }, '2026-W48': { week: '2026-W48', chain: 'base', copied: 'CRCLc', original: ORIG, address: FAKE, symbol: 'CRCLc', liquidity_usd: 12000 } } }
const crash = { generated_at: '2026-11-25T06:00:00Z', method: 'node packages/proofofstock-guard/examples/crash-test.mjs <TICKER>', stocks: [
  { ticker: 'CRCL', code: 0, stock: { ticker: 'CRCL', symbol: 'CRCLc', original: ORIG }, rows: [
    { id: 'k', agent: 'KyberSwap skill', how: 'exact symbol', stars: 0, tries: [{ query: 'CRCL', address: null, decision: 'none', stars: 2 }, { query: 'CRCLc', address: FAKE, decision: 'impostor', stars: 0 }] },
    { id: 'l', agent: 'LI.FI', how: 'one answer', stars: 3, tries: [{ query: 'CRCL', address: ORIG, decision: 'listed', stars: 3 }, { query: 'CRCLc', address: ORIG, decision: 'listed', stars: 3 }] },
    { id: 'd', agent: 'Dex', how: 'deepest', stars: 1, tries: [{ query: 'CRCL', address: PICK, decision: 'not_listed', stars: 1 }, { query: 'CRCLc', address: null, decision: 'unreadable', stars: null }] }] },
  { ticker: 'ZZZ', code: 3, outcome: 'unavailable' }] }
const assets = { css: 'style.css', docsCss: 'docs.css', labCss: 'lab/lab.css' }

console.log('the page')
{
  const html = labPage({ board, golden, crash, version: '9.9.9', assets })
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
  check('search engines are told to stay out', /<meta name="robots" content="noindex, nofollow">/.test(html))
  check('no address is ever a link: not a DEX, not an explorer, not a chart', hrefs.every((h) => !/0x[0-9a-f]{6,}/i.test(h)) && !/dexscreener|geckoterminal|basescan|uniswap|aerodrome|kyberswap|app\.|swap\?/i.test(hrefs.join(' ')))
  check('the only links are the site\'s own: its bar, its stylesheets', hrefs.every((h) => !/^https?:/.test(h) || h === 'https://x' ))
  check('every fake stands beside its original', (html.match(/<span class="lb-fake"/g) || []).length === (html.match(/<span class="lb-orig"/g) || []).length && (html.match(/<span class="lb-fake"/g) || []).length === 2)
  check('the deployer\'s text is escaped', !html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  check('the golden impostor: the latest week, "copied X, gathered $Y"', /<h2 id="lb-gold-title">copied CRCLc, gathered \$12K<\/h2>/.test(html) && /2026-W48/.test(html) && goldenLine(golden.weeks['2026-W48']) === 'copied CRCLc, gathered $12K')
  check('...with a trophy, and the earlier weeks folded away', /<svg class="lb-trophy"/.test(html) && /<details class="lb-past">[\s\S]*2026-W47[\s\S]*NVDAc/.test(html))
  check('the board: per stock, fakes, live, real money, what DexScreener shows, the richest fake, the newest', /Stock copied<\/th><th scope="col">Fakes<\/th><th scope="col">Live<\/th><th scope="col">Real money in fakes<\/th><th scope="col">DexScreener shows<\/th><th scope="col">Richest fake ≠ the original<\/th><th scope="col">Newest fake<\/th>/.test(html))
  check('an unread pool is said, not shown as zero', /\+1 unread/.test(html))
  check('a stock whose fakes have no pool shows only its original', /no fake holds real money/.test(html))
  check('a chain without a list says so', /Robinhood Chain: impostor list not readable/.test(html))
  check('the crash test: stars per agent, the fake pick in red words, the command to rerun', /class="lb-stars s-0">0</.test(html) && /class="lb-stars s-3">★★★</.test(html) && /class="lb-pick d-impostor">[\s\S]*?A FAKE/.test(html) && /node packages\/proofofstock-guard\/examples\/crash-test\.mjs &lt;TICKER&gt;/.test(html))
  check('an unreadable answer is said, and the agent gets no stars', /could not be read/.test(html) && /class="lb-stars s-1">★</.test(html))
  check('a stock whose crash test stopped is left out, not drawn empty', !/ZZZ/.test(html))
  check('the results table: one row per agent tool, its stars per stock', /<div class="lb-scroll lb-summary">[\s\S]*?<th scope="col">CRCL<\/th>[\s\S]*?<th scope="row">KyberSwap skill<\/th><td class="lb-stars s-0">0<\/td>[\s\S]*?<th scope="row">LI\.FI<\/th><td class="lb-stars s-3">★★★<\/td>/.test(html))
  const many = { chains: [{ chain: 'base', totals: { stocks: 25, fakes: 25, live: 0, liquidity_usd: 0 }, rows: Array.from({ length: BOARD_ROWS + 5 }, (_, i) => ({ symbol: `S${i}c`, original: A(0x100 + i), fakes: 1, live: 0, liquidity_usd: 0, unread: 0, richest: null })) }] }
  const long = labPage({ board: many, golden: null, crash: null, version: '9.9.9', assets })
  check(`a long board shows its first ${BOARD_ROWS} stocks and folds the rest, none lost`, /<details class="lb-more"><summary>5 more stocks with fakes<\/summary>/.test(long) && long.indexOf('>S19c<') < long.indexOf('lb-more') && long.indexOf('>S24c<') > long.indexOf('lb-more'))
  check('no stray "undefined" or "null"', !/undefined|>null</.test(html))
  const empty = labPage({ board: null, golden: null, crash: null, version: '9.9.9', assets })
  check('before the first run: the page still stands and says what is missing', /has not been built yet/.test(empty) && /No crash test has run yet/.test(empty) && /No fake with a live pool this week/.test(empty))
}

console.log('money as a board shows it')
check('$0, $840, $12.4K, $125K, $3.1M', [0, 840, 12400, 125000, 3.1e6].map(usd).join() === '$0,$840,$12.4K,$125K,$3.1M' && usd(NaN) === '$0' && usd(-5) === '$0')

console.log('linked from nowhere')
{
  check('not a tab', !TABS.some((t) => /lab/i.test(t.id) || /lab/i.test(t.href)))
  check('not in the sitemap', !sitemapUrls({ site: 'https://s', docs: new Map(), symbols: {} }).some((u) => /\/lab\b/.test(u.loc)))
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const docs = []
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (n.endsWith('.md')) docs.push(fs.readFileSync(p, 'utf8')) } }
  walk(fileURLPath('../docs'))
  check('not in the README or the docs', ![readme, ...docs].some((t) => /proofofstock\.xyz\/lab\b|\]\(\/?lab\)|href="\/?lab"/.test(t)))
  for (const f of ['stocks-web/index.html', 'stocks-web/app.js', 'stocks-nav.mjs', 'stocks-docs.mjs']) {
    check(`${f} has no link to it`, !/["'(]\.?\/?lab["')?#]/.test(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8')))
  }
}
function fileURLPath (rel) { return decodeURIComponent(new URL(rel, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1') }

console.log('served')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-page-'))
const labDir = path.join(root, 'lab')
fs.mkdirSync(labDir)
fs.writeFileSync(path.join(labDir, 'board.json'), JSON.stringify(board))
fs.writeFileSync(path.join(labDir, 'golden.json'), JSON.stringify(golden))
const opts = { listLocks: false, roots: { base: path.join(root, 'b'), robinhood: path.join(root, 'r') }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module: null, labDir }
const off = createStocksWeb({ ...opts, lab: false })
const on = createStocksWeb({ ...opts, lab: true })
const a = await off.start(0, '127.0.0.1'), b = await on.start(0, '127.0.0.1')
try {
  for (const p of ['/stocks/lab', '/stocks/lab/lab.css']) check(`off (the default): ${p} is a plain 404`, (await fetch(`http://127.0.0.1:${a.port}${p}`)).status === 404)
  const r = await fetch(`http://127.0.0.1:${b.port}/stocks/lab`)
  const page = await r.text()
  check('on: /lab answers the page, from the files', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && /copied CRCLc, gathered \$12K/.test(page) && /No crash test has run yet/.test(page))
  check('...noindex in the header too, and never cached', r.headers.get('x-robots-tag') === 'noindex, nofollow' && r.headers.get('cache-control') === 'private, no-store')
  const css = [...page.matchAll(/href="(lab\/lab\.css\?v=[0-9a-f]{12})"/g)].map((m) => new URL(m[1], `http://127.0.0.1:${b.port}/stocks/lab`).href)
  const c = css.length === 1 ? await fetch(css[0]) : null
  check('...its stylesheet is served under /lab, as CSS, byte for byte', c && c.status === 200 && /text\/css/.test(c.headers.get('content-type')) && (await c.text()) === fs.readFileSync(new URL('./stocks-web/lab.css', import.meta.url), 'utf8'))
  check('a page under /lab that is not the page is still 404', (await fetch(`http://127.0.0.1:${b.port}/stocks/lab/board.json`)).status === 404)
  check('the default is off: nothing but POS_LAB=on in the host environment turns it on', /lab = process\.env\.POS_LAB === 'on',/.test(fs.readFileSync(new URL('./stocks-web.mjs', import.meta.url), 'utf8')))
} finally {
  await off.stop(); await on.stop()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
