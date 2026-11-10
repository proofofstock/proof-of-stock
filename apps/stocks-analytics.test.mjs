// apps/stocks-analytics.test.mjs — the visit counter: what a beacon may carry, what a row holds, the daily pseudonym,
// the off switch, the wiring in the site, and the report.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnalytics, parseHit, uaClass } from './stocks-analytics.mjs'
import { createStocksWeb } from './stocks-web.mjs'
import { summarise, report } from '../scripts/stocks/analytics-report.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-analytics-'))
const CH = ['base', 'robinhood']
const A = '0x' + 'ab'.repeat(20)
const sp = (q) => new URLSearchParams(q)
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const rowsOf = (dir) => fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))

console.log('what a beacon may carry')
{
  check('a view of the terminal with a passport', JSON.stringify(parseHit(sp(`k=view&p=/&c=base&a=${A.toUpperCase()}&r=x.com`), CH)) === JSON.stringify({ event: 'view', page: '/', visible_s: null, chain: 'base', token: A, symbol: null, ref_host: 'x.com' }))
  check('a hide carries its seconds, capped at an hour', parseHit(sp('k=hide&p=/history&t=99999'), CH).visible_s === 3600 && parseHit(sp('k=hide&p=/history&t=-4'), CH).visible_s === 0)
  check('a docs page is a page', parseHit(sp('k=view&p=/docs/reference/tools.md'), CH)?.page === '/docs/reference/tools.md')
  check('an unknown event or page is refused', parseHit(sp('k=click&p=/'), CH) === null && parseHit(sp('k=view&p=/api/find'), CH) === null && parseHit(sp('k=view&p=/../etc'), CH) === null && parseHit(sp('k=view&p=https://evil'), CH) === null)
  check('a token without a known chain, or a malformed one, is dropped', parseHit(sp(`k=view&p=/&c=solana&a=${A}`), CH).token === null && parseHit(sp('k=view&p=/&c=base&a=0x12'), CH).token === null)
  check('a referrer that is not a host name is dropped', parseHit(sp('k=view&p=/&r=<script>'), CH).ref_host === null)
  check('user agents are classed', uaClass(CHROME) === 'browser' && uaClass('Googlebot/2.1') === 'bot' && uaClass('Mozilla/5.0 HeadlessChrome/120') === 'bot' && uaClass('curl/8.5') === 'bot' && uaClass('') === 'tool' && uaClass('Go-http-client/2.0') === 'bot')
}

console.log('what a row holds')
{
  let t = Date.parse('2026-11-10T10:00:00Z')
  const dir = path.join(tmp, 'a')
  const an = createAnalytics({ dir, now: () => t, log: () => {} })
  const h = { 'user-agent': CHROME, 'cf-ipcountry': 'tr' }
  an.load('198.51.100.7', h, '/')
  an.hit('198.51.100.7', h, parseHit(sp(`k=view&p=/&c=base&a=${A}`), CH))
  an.hit('198.51.100.7', h, parseHit(sp('k=hide&p=/&t=42'), CH))
  an.mcp('203.0.113.5', { 'user-agent': 'claude-code/2' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_stock_tokens', arguments: { addresses: [A] } } }))
  an.mcp('203.0.113.5', { 'user-agent': 'claude-code/2' }, '{not json')
  const rows = rowsOf(dir)
  const text = fs.readFileSync(path.join(dir, 'hits-2026-11-10.jsonl'), 'utf8')
  check('rows go to the UTC day file', fs.readdirSync(dir).join() === 'hits-2026-11-10.jsonl' && rows.length === 4)
  check('no address and no user agent is stored', !text.includes('198.51.100.7') && !text.includes('203.0.113.5') && !text.includes('Chrome/131'))
  check('the MCP row has the tool, never its arguments', rows[3].tool === 'verify_stock_tokens' && !text.includes('arguments') && rows[3].ua_class === 'tool')
  check('the country is Cloudflare\'s two letters, upper case', rows[0].country === 'TR')
  check('one visitor within a day', rows[0].visitor === rows[1].visitor && rows[1].visitor === rows[2].visitor && /^[0-9a-f]{16}$/.test(rows[0].visitor))
  t += 86400e3
  an.load('198.51.100.7', h, '/')
  const next = rowsOf(dir).find((r) => r.at.startsWith('2026-11-11'))
  check('the next day the same person is a new pseudonym', next && next.visitor !== rows[0].visitor)
  const b = createAnalytics({ dir, now: () => t - 86400e3, log: () => {} })
  b.load('198.51.100.7', h, '/')
  check('a restart is a new salt too: the pseudonym cannot be recomputed', rowsOf(dir).filter((r) => r.at.startsWith('2026-11-10')).at(-1).visitor !== rows[0].visitor)
}

console.log('the off switch')
{
  const saved = process.env.STP_ANALYTICS_DIR; delete process.env.STP_ANALYTICS_DIR
  const an = createAnalytics({ log: () => {} })
  an.load('1.2.3.4', {}, '/')
  check('without a directory the counter is off and writes nothing', an.disabled === true)
  const file = path.join(tmp, 'a-file'); fs.writeFileSync(file, 'x')
  const msgs = []
  const bad = createAnalytics({ dir: path.join(file, 'sub'), log: (m) => msgs.push(m) })
  bad.load('1.2.3.4', {}, '/'); bad.load('1.2.3.4', {}, '/')
  check('a directory it cannot write turns it off, said once', bad.disabled === true && msgs.length === 1 && /disabled/.test(msgs[0]))
  if (saved != null) process.env.STP_ANALYTICS_DIR = saved
}

console.log('in the site')
{
  const dir = path.join(tmp, 'site')
  const roots = { base: path.join(tmp, 'rb'), robinhood: path.join(tmp, 'rr') }
  const app = createStocksWeb({ roots, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), now: () => Date.parse('2026-11-10T12:00:00Z'), log: () => {}, analytics: { dir } })
  const { port } = await app.start(0, '127.0.0.1')
  const get = (p, h = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'user-agent': CHROME, ...h } })
  const html = await (await get('/stocks/')).text()
  check('the terminal loads the counter by content hash', /<script src="beacon\.js\?v=[0-9a-f]{12}" defer><\/script>/.test(html))
  check('the counter script is served', (await get('/stocks/beacon.js')).status === 200)
  const hist = await (await get('/stocks/history')).text()
  check('the history and status pages load it too', /beacon\.js\?v=/.test(hist) && /beacon\.js\?v=/.test(await (await get('/stocks/status')).text()))
  check('a docs page loads it from the site root', /src="(\.\.\/)+beacon\.js\?v=/.test(await (await get('/stocks/docs/reference/tools.md', { accept: 'text/html' })).text()))
  const r = await get(`/stocks/api/hit?k=view&p=/&c=base&a=${A}`)
  check('a beacon is answered 204, not cached', r.status === 204 && r.headers.get('cache-control') === 'no-store')
  check('a bad beacon is answered 204 too, and not written', (await get('/stocks/api/hit?k=nope')).status === 204)
  await app.stop()
  const rows = rowsOf(dir)
  check('the site wrote loads and the one good beacon', rows.filter((x) => x.kind === 'view').length === 1 && rows.filter((x) => x.kind === 'load').length >= 3)
  const page = fs.readFileSync(new URL('./stocks-web/beacon.js', import.meta.url), 'utf8')
  check('the counter sets no cookie and keeps nothing in the browser', !/document\.cookie|localStorage|sessionStorage|indexedDB/.test(page) && /credentials: 'omit'/.test(page))
  const unit = fs.readFileSync(new URL('../deployment/systemd/stp-web.service', import.meta.url), 'utf8')
  check('the unit turns the counter on, in its own state directory', /Environment=STP_ANALYTICS_DIR=\/var\/lib\/stp-analytics/.test(unit) && /StateDirectory=stp-analytics/.test(unit))
}

console.log('the report')
{
  const R = (o) => ({ at: '2026-11-10T10:00:00Z', country: null, ...o })
  const rows = [
    R({ kind: 'load', visitor: 'p1', ua_class: 'browser', page: '/' }),
    R({ kind: 'view', visitor: 'p1', ua_class: 'browser', page: '/', chain: 'base', symbol: 'NVDAc', ref_host: 'x.com', country: 'TR' }),
    R({ kind: 'hide', visitor: 'p1', ua_class: 'browser', page: '/', visible_s: 50 }),
    R({ kind: 'hide', visitor: 'p1', ua_class: 'browser', page: '/', visible_s: 20 }),
    R({ kind: 'load', visitor: 'p2', ua_class: 'browser', page: '/' }),
    R({ kind: 'view', visitor: 'p2', ua_class: 'browser', page: '/history', country: 'US' }),
    R({ kind: 'hide', visitor: 'p2', ua_class: 'browser', page: '/history', visible_s: 5 }),
    R({ kind: 'load', visitor: 'p3', ua_class: 'browser', page: '/' }),
    R({ kind: 'load', visitor: 'b1', ua_class: 'bot', page: '/' }),
    R({ kind: 'view', visitor: 'h1', ua_class: 'bot', page: '/' }),
    R({ kind: 'mcp', visitor: 'm1', ua_class: 'tool', method: 'initialize', tool: null, client: 'claude-code' }),
    R({ kind: 'mcp', visitor: 'm1', ua_class: 'tool', method: 'tools/call', tool: 'verify_stock_tokens', client: null }),
  ]
  const s = summarise(rows)
  check('people are browsers whose script ran; a bot running scripts is not one', s.people === 2)
  check('a person\'s visible time adds up across hides', s.engaged === 1 && s.median_visible_s === 37.5)
  check('a browser that loaded and sent nothing is counted apart', s.browsers_without_beacon === 1 && s.bots === 1)
  check('passports, referrers, countries and MCP calls are counted', s.tokens[0][0] === 'base:NVDAc' && s.refs[0][0] === 'x.com' && s.countries.length === 2 && s.mcp_clients === 1 && s.mcp_calls.some(([k]) => k === 'tools/call verify_stock_tokens'))
  const dir = path.join(tmp, 'rep'); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'hits-2026-11-10.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const md = report({ dir, days: 2, today: '2026-11-10' })
  check('the report has a section per day and says when a day has no file', /## 2026-11-09\n\nno file/.test(md) && /## 2026-11-10/.test(md) && /\*\*people:\*\* 2/.test(md))
  check('the report prints no pseudonym', !/\bp1\b|\bm1\b/.test(md))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
