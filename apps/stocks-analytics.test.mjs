// apps/stocks-analytics.test.mjs: the visit counter: what a beacon may carry, what a row holds, the daily pseudonym,
// the off switch, the wiring in the site, and the report.
import fs from 'node:fs'
import vm from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import { createAnalytics, parseHit, uaClass, DAY_CAP_BYTES, KEEP_DAYS, LOADS_PER_VISITOR_DAY, BEACONS_PER_VISITOR_DAY } from './stocks-analytics.mjs'
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
  check('an action of a known kind and value is taken', JSON.stringify(parseHit(sp('k=act&p=/&x=search&v=ticker:none'), CH)) === JSON.stringify({ event: 'act', page: '/', action: 'search', value: 'ticker:none' }))
  check('...every kind the beacon and the terminal send', ['chip=NVDA', 'command=pick', 'search=address:impostor', 'tab=all', 'copy=mcp-cc', 'copy=mcp-gpt-url', 'faq=q6', 'section=foot', 'out=gecko', 'board=open', 'section=findings'].every((kv) => { const [x, v] = kv.split('='); return parseHit(sp(`k=act&p=/&x=${x}&v=${encodeURIComponent(v)}`), CH)?.action === x }))
  check('an action never carries text: an unknown kind, a free value or a query is dropped', parseHit(sp('k=act&p=/&x=typed&v=nvda'), CH) === null && parseHit(sp('k=act&p=/&x=search&v=NVIDIA+Corp'), CH) === null && parseHit(sp('k=act&p=/&x=chip&v=<b>'), CH) === null && parseHit(sp('k=act&p=/&x=faq&v=q10'), CH) === null && parseHit(sp('k=act&p=/&x=__proto__&v=x'), CH) === null)
  check('an action on a page the site does not have is dropped', parseHit(sp('k=act&p=/api/find&x=chip&v=NVDA'), CH) === null)
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
  an.mcp('203.0.113.5', { 'user-agent': 'claude-code/2' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_stock_tokens', arguments: { addresses: [A] } } }), ['verify_stock_tokens'])
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

console.log('what an MCP row may hold')
{
  const dir = path.join(tmp, 'mcp')
  const an = createAnalytics({ dir, now: () => Date.parse('2026-11-10T10:00:00Z'), log: () => {} })
  const H = { 'user-agent': 'x/1' }
  an.mcp('1.1.1.1', H, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]), [])
  an.mcp('1.1.1.1', H, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'my phone is +90 555 0000' }), [])
  an.mcp('1.1.1.1', H, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'free text of my choosing' } }), ['stock_passport'])
  an.mcp('1.1.1.1', H, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'call me +90 555 0000' } } }), [])
  an.mcp('1.1.1.1', H, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } }), [])
  const rows = fs.existsSync(dir) ? rowsOf(dir) : []
  const text = rows.map((r) => JSON.stringify(r)).join('\n')
  check('a batch writes nothing', rows.length === 4, String(rows.length))
  check('a method or tool the server does not define is stored as "other"', rows[0].method === 'other' && rows[1].tool === 'other')
  check('a client name that is not a short plain word is "other"; a plain one is kept', rows[2].client === 'other' && rows[3].client === 'claude-code')
  check('no text the caller chose is stored', !/555|phone|choosing/.test(text))
}

console.log('the counter stays bounded')
{
  const dir = path.join(tmp, 'cap')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'hits-2026-01-01.jsonl'), '{}\n')
  fs.writeFileSync(path.join(dir, 'hits-2026-11-01.jsonl'), '{}\n')
  fs.writeFileSync(path.join(dir, 'hits-2026-11-10.jsonl'), 'x'.repeat(DAY_CAP_BYTES - 100))
  const msgs = []
  const an = createAnalytics({ dir, now: () => Date.parse('2026-11-10T10:00:00Z'), log: (m) => msgs.push(m) })
  for (let i = 0; i < 5; i++) an.load('1.2.3.4', { 'user-agent': CHROME }, '/')
  const size = fs.statSync(path.join(dir, 'hits-2026-11-10.jsonl')).size
  check('a day file stops at its cap, said once', size <= DAY_CAP_BYTES && msgs.filter((m) => /reached/.test(m)).length === 1, `${size} ${msgs}`)
  check(`day files older than ${KEEP_DAYS} days are deleted; recent ones kept`, !fs.existsSync(path.join(dir, 'hits-2026-01-01.jsonl')) && fs.existsSync(path.join(dir, 'hits-2026-11-01.jsonl')))
  check('a beacon may only name a page the site has', parseHit(sp('k=view&p=/docs/made/up.md'), CH, (p) => p === '/') === null && parseHit(sp('k=view&p=/'), CH, (p) => p === '/') !== null)
}

{
  let t = Date.parse('2026-11-10T10:00:00Z')
  const dir = path.join(tmp, 'per-visitor')
  const an = createAnalytics({ dir, now: () => t, log: () => {} })
  const h = { 'user-agent': CHROME }
  for (let i = 0; i < LOADS_PER_VISITOR_DAY + 50; i++) an.load('1.2.3.4', h, '/')
  for (let i = 0; i < BEACONS_PER_VISITOR_DAY + 50; i++) an.hit('1.2.3.4', h, parseHit(sp('k=view&p=/'), CH))
  an.load('5.6.7.8', h, '/')
  let rows = rowsOf(dir)
  const loads = () => rows.filter((r) => r.kind === 'load').length
  check('one client re-requesting a page stops at its daily cap of loads', rows.filter((r) => r.kind === 'load').length === LOADS_PER_VISITOR_DAY + 1)
  check('its beacons stop at their own cap', rows.filter((r) => r.kind === 'view').length === BEACONS_PER_VISITOR_DAY)
  check('another visitor is still counted', new Set(rows.filter((r) => r.kind === 'load').map((r) => r.visitor)).size === 2)
  t += 86400e3
  an.load('1.2.3.4', h, '/')
  rows = rowsOf(dir)
  check('the cap starts over the next day', fs.existsSync(path.join(dir, 'hits-2026-11-11.jsonl')) && loads() === LOADS_PER_VISITOR_DAY + 2)
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
  check('a beacon naming a docs page that does not exist is not written', (await get('/stocks/api/hit?k=view&p=/docs/nope/nope.md')).status === 204)
  const mcpPost = (body) => fetch(`http://127.0.0.1:${port}/stocks/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body })
  await mcpPost(JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'm' }))))
  await mcpPost(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
  await app.stop()
  const rows = rowsOf(dir)
  check('a rejected MCP batch writes no row; an accepted request writes one', rows.filter((x) => x.kind === 'mcp').length === 1 && rows.find((x) => x.kind === 'mcp').method === 'ping')
  check('only real pages were counted from beacons', rows.filter((x) => x.kind === 'view').every((x) => x.page === '/'))
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
    R({ kind: 'act', visitor: 'p1', ua_class: 'browser', page: '/', action: 'chip', value: 'NVDA' }),
    R({ kind: 'act', visitor: 'p1', ua_class: 'browser', page: '/', action: 'chip', value: 'NVDA' }),
    R({ kind: 'act', visitor: 'p2', ua_class: 'browser', page: '/', action: 'chip', value: 'NVDA' }),
    R({ kind: 'act', visitor: 'p2', ua_class: 'browser', page: '/', action: 'section', value: 'faq' }),
    R({ kind: 'act', visitor: 'h1', ua_class: 'bot', page: '/', action: 'chip', value: 'now' }),
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
  check('actions count people, once each, and never a bot', JSON.stringify(s.actions.chip) === JSON.stringify([['NVDA', 2]]) && JSON.stringify(s.actions.section) === JSON.stringify([['faq', 1]]))
  check('the report has a line per kind of action', md.includes('**buttons under the headline** (people): NVDA 2') && md.includes('**sections seen (a second on screen)** (people): faq 1') && md.includes('**searches (kind:outcome)** (people): none'))
  check('the report prints no pseudonym', !/\bp1\b|\bm1\b/.test(md))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('the beacon in a page')
{
  // beacon.js run in a fake page: a passport A is shown for a while, then the terminal moves the URL to passport B.
  const src = fs.readFileSync(new URL('./stocks-web/beacon.js', import.meta.url), 'utf8')
  const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20)
  const sent = []
  let clock = 1_000_000
  const listeners = {}
  class FakeEl { constructor (sel, data) { this.sel = sel; this.dataset = data || {} } closest (q) { return q.split(',').some((p) => p.trim() === this.sel) ? this : null } }
  const loc = { host: 'proofofstock.xyz', pathname: '/', search: `?chain=base&address=${A}`, get href () { return 'https://proofofstock.xyz' + this.pathname + this.search } }
  const history = { pushState (_s, _t, url) { const u = new URL(url, loc.href); loc.pathname = u.pathname; loc.search = u.search }, replaceState (s, t, url) { this.pushState(s, t, url) } }
  const ctx = vm.createContext({
    URL, URLSearchParams, location: loc, history,
    document: { currentScript: { src: 'https://proofofstock.xyz/beacon.js' }, visibilityState: 'visible', referrer: '', addEventListener (t, fn) { (listeners[t] ||= []).push(fn) }, querySelectorAll: () => [], querySelector: () => null },
    Element: FakeEl,
    addEventListener () {}, fetch: (u) => { sent.push(Object.fromEntries(new URL(u).searchParams)); return Promise.resolve() },
    Date: { now: () => clock }, Math,
  })
  ctx.window = ctx
  vm.runInContext(src, ctx)
  clock += 30_000
  ctx.history.pushState(null, '', `/?chain=base&address=${B}`)
  const hideA = sent.find((e) => e.k === 'hide')
  check('the beacon counts the first passport when it is shown', sent[0]?.k === 'view' && sent[0].a === A)
  check('moving to another passport closes the first one with ITS address and seconds', hideA && hideA.a === A && hideA.t === '30', JSON.stringify(hideA))
  check('...and opens the second one', sent.at(-1)?.k === 'view' && sent.at(-1).a === B)
  // Actions: what the terminal says (pos:act) and clicks on known controls go out as kinds, with the page.
  listeners['pos:act'][0]({ detail: { x: 'search', v: 'ticker:one' } })
  const s1 = sent.at(-1)
  check('an action from the terminal goes out as act, its kind and value, with the page', s1.k === 'act' && s1.x === 'search' && s1.v === 'ticker:one' && s1.p === '/' && !('a' in s1), JSON.stringify(s1))
  listeners.click[0]({ target: new FakeEl('.hero [data-run]', { run: 'NVDA' }) })
  check('a button under the headline goes out as chip', sent.at(-1).k === 'act' && sent.at(-1).x === 'chip' && sent.at(-1).v === 'NVDA')
  listeners.click[0]({ target: new FakeEl('[data-copy]', { copy: 'mcp-url' }) })
  check('a copy button goes out as copy', sent.at(-1).x === 'copy' && sent.at(-1).v === 'mcp-url')
  const n = sent.length
  listeners.click[0]({ target: new FakeEl('p') })
  check('a click on anything else sends nothing', sent.length === n)
}
{
  // Sections: a section passed on the way down (as when a restored scroll or #faq jumps past it) is not counted; one
  // that stays half on screen for a second is, once.
  const src = fs.readFileSync(new URL('./stocks-web/beacon.js', import.meta.url), 'utf8')
  const sent = [], timers = new Map()
  let tid = 0, observer = null
  const els = Object.fromEntries(['.checks', '.why', '.agents', '.faq', '.foot'].map((s) => [s, { sel: s, dataset: {} }]))
  const ctx = vm.createContext({
    URL, URLSearchParams, location: { host: 'proofofstock.xyz', pathname: '/', search: '', href: 'https://proofofstock.xyz/' }, history: { pushState () {}, replaceState () {} },
    document: { currentScript: { src: 'https://proofofstock.xyz/beacon.js' }, visibilityState: 'visible', referrer: '', addEventListener () {}, querySelectorAll: () => [], querySelector: (s) => els[s] || null },
    Element: class {}, addEventListener () {}, fetch: (u) => { sent.push(Object.fromEntries(new URL(u).searchParams)); return Promise.resolve() },
    Date: { now: () => 1_000_000 }, Math,
    setTimeout: (fn) => { timers.set(++tid, fn); return tid }, clearTimeout: (id) => timers.delete(id),
    IntersectionObserver: class { constructor (cb) { this.cb = cb; this.watched = new Set(); observer = this } observe (el) { this.watched.add(el) } unobserve (el) { this.watched.delete(el) } },
  })
  ctx.window = ctx
  vm.runInContext(src, ctx)
  const seen = (s, on) => observer.cb([{ target: els[s], isIntersecting: on }])
  const tick = () => { const fns = [...timers.values()]; timers.clear(); for (const f of fns) f() }
  const sections = () => sent.filter((e) => e.x === 'section').map((e) => e.v)
  seen('.checks', true); seen('.why', true); seen('.checks', false); seen('.why', false)
  tick()
  check('sections passed by in an instant are not counted', sections().length === 0, JSON.stringify(sections()))
  seen('.faq', true); tick()
  check('a section a second on screen is counted', JSON.stringify(sections()) === '["faq"]')
  seen('.faq', false); seen('.faq', true); tick()
  check('...once per page load', JSON.stringify(sections()) === '["faq"]' && !observer.watched.has(els['.faq']))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
