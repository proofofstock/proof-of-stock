// apps/stocks-web.test.mjs: the public passport site: serves its page with a strict CSP, answers find and passport
// from memory, refuses anything but GET/HEAD, validates input, rate limits per client (trusting X-Real-IP only from the
// loopback proxy), says 503 until a registry is loaded, and never builds a passport from readings it does not hold.
//
// Run: node apps/stocks-web.test.mjs

import { passportLead } from './stocks-mcp-http.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { createStocksWeb, SECURITY_HEADERS, PAGE_CACHE_MS } from './stocks-web.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../evm/core/stocks/registries.mjs'
import { loadWindow, readingsOf } from '../evm/core/stocks/readings-window.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const A = '0x' + 'aa'.repeat(20), X = '0x' + 'ee'.repeat(20), R = '0x' + 'cc'.repeat(20)
const NOW = Date.parse('2026-11-08T14:00:00Z')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stocks-web-'))
const baseRoot = path.join(tmp, 'base'), rhRoot = path.join(tmp, 'rh')
const peg = (addr, iso, premium) => ({ token_address: addr, observed_at: iso, multiplier: 1, multiplier_pending: null, paused: [], reference: { kind: 'nav_total_return', price_usd: 180, updated_at: '2026-11-06T21:00:00Z', age_s: 147000, halted: null }, pools: { seen: 2, eligible: 1, capped: false, top: [{ pair_address: '0xp', dex_id: 'uniswap', quote_symbol: 'USDC', price_usd: 181, liquidity_usd: 2e6, volume_h24_usd: 5e5 }] }, dex_price_usd: 181, dex_pool: '0xp', premium, premium_refused: null })
fs.mkdirSync(path.join(baseRoot, 'stock-peg'), { recursive: true })
fs.writeFileSync(path.join(baseRoot, 'stock-peg', 'stock-peg-2026-11-08.jsonl'), [peg(A, '2026-11-08T13:00:00Z', 0.004), peg(A, '2026-11-08T13:45:00Z', 0.0056)].map((r) => JSON.stringify(r)).join('\n') + '\n')
fs.writeFileSync(path.join(baseRoot, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'), '{"run_id":"r"}\n')

let dexCalls = 0
// The names file the impostor timer writes; the site names an outside token from it and never calls out for a name.
fs.writeFileSync(path.join(baseRoot, 'stock-peg', 'stock-names.json'), JSON.stringify({ generated_at: '2026-11-08T12:00:00Z', chain: 'base', count: 1, names: { [X]: ['NVDAc', '<img src=x onerror=alert(1)>'] } }))
const fetchImpl = async (url) => {
  const u = String(url)
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (u.startsWith(COINBASE_URL)) return ok({ tokens: [{ contract_address: A, symbol: 'NVDAc', name: 'NVIDIA', isin: 'US67066G1040', multiplier: '1', nav_price: '180', nav_price_updated_at: '2026-11-06T21:00:00Z', total_supply: '5' }] })
  if (u.startsWith(ROBINHOOD_ASSETS_URL)) return ok({ assets: [{ tokenSymbol: 'TSLA', tokenName: 'Tesla  Robinhood Token', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: R }] }] })
  if (u.startsWith(ROBINHOOD_PRICES_URL)) return ok({ quotes: [] })
  if (u.includes('/token-pairs/v1/base/' + X)) { dexCalls++; return ok([{ baseToken: { address: X, symbol: 'NVDAc', name: '<img src=x onerror=alert(1)>' }, quoteToken: { address: '0x' + '11'.repeat(20) } }]) }
  return { ok: false, status: 404, json: async () => ({}) }
}

console.log('the readings window')
{
  const w = await loadWindow(baseRoot, NOW, 72)
  check('the run manifest is not read as readings', w.files === 1 && w.byToken.size === 1)
  const e = w.byToken.get(A)
  check('the latest full row is kept, the rest as points', e.latest.observed_at === '2026-11-08T13:45:00Z' && e.points.length === 2)
  const rows = readingsOf(e, A)
  check('readings are rebuilt with the latest row last', rows.length === 2 && rows[1] === e.latest && rows[0].premium === 0.004)
  check('an empty root is an empty window, not an error', (await loadWindow(path.join(tmp, 'none'), NOW, 72)).byToken.size === 0)
}

// The history archive (evm/core/stocks/history.mjs): X was flagged imitating NVDAc; Y was backfilled from the collector
// and later listed by the issuer; one registry snapshot.
const Y = '0x' + 'dd'.repeat(20)
const histDir = path.join(baseRoot, 'stock-peg', 'history')
fs.mkdirSync(histDir, { recursive: true })
const ev = (o) => JSON.stringify({ _schema_version: '1.0', chain_id: 8453, kind: 'registry_symbol', registry_symbol: 'NVDAc', registry_address: A, flagged_at: null, ...o })
fs.writeFileSync(path.join(histDir, 'cases-2026-11-07.jsonl'), [
  ev({ event: 'opened', at: '2026-11-07T00:23:00Z', source: 'backfilled', address: Y, symbol: 'AAPLc', registry_symbol: 'AAPLc', first_seen_at: '2026-08-01T10:00:00Z' }),
  ev({ event: 'opened', at: '2026-11-07T06:23:00Z', source: 'observed', address: X, symbol: 'NVDAc', first_seen_at: '2026-11-07T06:00:00Z', flagged_at: '2026-11-07T06:23:00Z' }),
].join('\n') + '\n')
fs.writeFileSync(path.join(histDir, 'cases-2026-11-08.jsonl'), ev({ event: 'listed', at: '2026-11-08T12:23:00Z', source: 'observed', address: Y, symbol: 'AAPLc', registry_symbol: 'AAPLc' }) + '\n')
fs.writeFileSync(path.join(histDir, 'registry-2026-11-07.jsonl'), JSON.stringify({ _schema_version: '1.0', chain_id: 8453, issuer: 'coinbase', fetched_at: '2026-11-07T12:52:00Z', hash: 'sha256:' + 'ab'.repeat(32), prev_hash: null, records: 1, added: [A], removed: [], changed: [], body: [{ address: A, symbol: 'NVDAc' }] }) + '\n')

const app = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
const { port } = await app.start(0, '127.0.0.1')
const get = (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, opts)

console.log('health')
{
  const h = await get('/healthz')
  const j = await h.json()
  check('healthz is 200 with a registry loaded and names which ones', h.status === 200 && j.ok === true && j.registries.base === true, JSON.stringify(j))
}

console.log('the recorder\'s private copies of third-party answers are never served')
{
  // In production they sit beside the dataset roots, in /var/lib/stp-raw (scripts/stocks/raw-store.mjs). Here a canary
  // sits beside the test roots the same way, as a gzip file and as plain text.
  const CANARY = 'raw-canary-' + 'c4'.repeat(16)
  const rawDir = path.join(tmp, 'stp-raw', 'base')
  fs.mkdirSync(rawDir, { recursive: true })
  fs.writeFileSync(path.join(rawDir, 'raw-2026-11-08.jsonl.gz'), zlib.gzipSync(JSON.stringify({ body: CANARY }) + '\n'))
  fs.writeFileSync(path.join(rawDir, 'raw-2026-11-08.jsonl'), CANARY)
  const tries = ['/stp-raw/base/raw-2026-11-08.jsonl', '/stocks/stp-raw/base/raw-2026-11-08.jsonl.gz', '/stocks/../stp-raw/base/raw-2026-11-08.jsonl',
    '/stocks/%2e%2e/%2e%2e/stp-raw/base/raw-2026-11-08.jsonl', '/stocks/..%2fstp-raw%2fbase%2fraw-2026-11-08.jsonl', '/var/lib/stp-raw/base/raw-2026-11-08.jsonl',
    '/stocks/docs/../../stp-raw/base/raw-2026-11-08.jsonl', '/stocks/static/..%2f..%2fstp-raw/base/raw-2026-11-08.jsonl', '/stocks/api/history/cases?chain=base&since=2026-11-01T00:00:00Z']
  const leaks = []
  for (const p of tries) {
    const r = await get(p)
    const body = Buffer.from(await r.arrayBuffer())
    let text = body.toString('utf8')
    try { text += zlib.gunzipSync(body).toString('utf8') } catch (_) { /* not gzip */ }
    if (text.includes(CANARY)) leaks.push(p + ' ' + r.status)
  }
  check('no route serves a byte of the private copies, whatever the path', leaks.length === 0, leaks.join(', '))
  const appsDir = new URL('.', import.meta.url)
  const appFiles = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|html)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) appFiles.push(p) } }
  walk(fileURLToPath(appsDir))
  const reaching = appFiles.filter((f) => /stp-raw|raw-store|STP_RAW/.test(fs.readFileSync(f, 'utf8')))
  check('the web app has no code path to them: no file in apps/ names the store, its module or its switch', appFiles.length > 5 && reaching.length === 0, reaching.join(', '))
  const webUnit = fs.readFileSync(new URL('../deployment/systemd/stp-web.service', import.meta.url), 'utf8')
  const pegUnit = fs.readFileSync(new URL('../deployment/systemd/stp-peg.service', import.meta.url), 'utf8')
  const vhostConf = fs.readFileSync(new URL('../deployment/nginx/proofofstock.xyz.conf', import.meta.url), 'utf8')
  check('the web unit cannot see the directory at all, and nginx does not name it', /^InaccessiblePaths=-\/var\/lib\/stp-raw$/m.test(webUnit) && !/stp-raw/.test(vhostConf))
  check('the recorder may write there, outside the backed-up /var/lib/stp, and is not switched on by its unit', /^ReadWritePaths=.* -\/var\/lib\/stp-raw$/m.test(pegUnit) && !/^Environment=.*STP_RAW_SNAPSHOTS=1/m.test(pegUnit))
}

console.log('the page')
{
  const r = await get('/stocks/')
  check('the page is served', r.status === 200 && /Proof of Stock/.test(await r.text()))
  check('with a strict CSP and no framing', r.headers.get('content-security-policy') === SECURITY_HEADERS['content-security-policy'] && /frame-ancestors 'none'/.test(r.headers.get('content-security-policy')))
  const html = await (await get('/stocks/')).text()
  check('the page names its assets by content hash and is not cached itself', /src="app\.js\?v=[0-9a-f]{12}"/.test(html) && /href="style\.css\?v=[0-9a-f]{12}"/.test(html) && r.headers.get('cache-control') === 'no-cache')
  check('the script and the stylesheet are served', (await get('/stocks/app.js')).status === 200 && (await get('/stocks/style.css')).headers.get('content-type').startsWith('text/css'))
  check('nothing else of the repository is served', (await get('/stocks/stocks-web.mjs')).status === 404 && (await get('/stocks/../package.json')).status === 404)
  check('POST is refused', (await get('/stocks/api/find?chain=base&q=nvda', { method: 'POST' })).status === 405)
  const bare = await get('/stocks?chain=robinhood', { redirect: 'manual' })
  check('/stocks redirects to /stocks/, keeping the query', bare.status === 301 && bare.headers.get('location') === '/stocks/?chain=robinhood')
  check('the root and the old unprefixed API are not served', (await get('/')).status === 404 && (await get('/api/status')).status === 404)
  check('the page uses relative URLs, so it works under its prefix', !/(src|href)="\/(?!\/)/.test(await (await get('/stocks/')).text()) && !/api\(['`]\//.test(fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')))
  check('the page script never writes HTML from data', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')))
  {
    // The terminal's status bar (owner, 12.11: it wrapped and "clear screen" fell onto its own line). The keys are one
    // group of the same chips, the clear key still clears, and each part is whole: no wrap inside a chain or a key.
    const bar = (html.match(/<footer class="statusbar">[\s\S]*?<\/footer>/) || [''])[0]
    const keys = [...bar.matchAll(/class="key"[^>]*><kbd>([^<]+)<\/kbd> (\w+)<\/(span|button)>/g)].map((m) => m[1] + ' ' + m[2])
    check('the status bar: the status, then one group of three keys, each a chip with its label', /<span id="status" class="status">/.test(bar) && JSON.stringify(keys) === JSON.stringify(['↑↓ history', 'help commands', 'clear screen']) && !/linkish/.test(bar), JSON.stringify(keys))
    check('...the clear key is a button that clears the screen, like the red window dot', /<button type="button" class="key" data-win="clear">/.test(bar))
    const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
    check('...each chain and the key group stay whole, and the bar wraps whole parts', /\.status \.seg \{[^}]*white-space: nowrap/.test(css) && /\.statusbar \.hint \{[^}]*white-space: nowrap/.test(css) && /\.statusbar \{[^}]*flex-wrap: wrap/.test(css))
    const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
    check('...the short status keeps the full sentence for screen readers and as its title', /listed, last price read/.test(js) && /h\('span', \{ class: 'sr' \}, full\)/.test(js) && /el\.title = full/.test(js))
  }
}

console.log('the history archive')
{
  const c = await (await get('/stocks/api/history/cases?chain=base')).json()
  check('the list holds observed events only, newest first; the counts stay whole', c.count === 2 && c.events.every((e) => e.source === 'observed') && c.events[0].event === 'listed' && c.counts.open === 1 && c.counts.listed === 1 && c.counts.backfilled === 1, JSON.stringify(c.counts))
  check('an event carries its evidence and how it was learned, not internals', c.events[0].imitates_symbol === 'AAPLc' && c.events[0].source === 'observed' && !('_schema_version' in c.events[0]) && !('chain_id' in c.events[0]))
  check('the archive start is the first event', c.archive_started_at === '2026-11-07T00:23:00Z')
  const f = await (await get('/stocks/api/history/cases?chain=base&limit=1')).json()
  const fo = await (await get('/stocks/api/history/cases?chain=base&event=opened')).json()
  const fc = await (await get('/stocks/api/history/cases?chain=base&limit=1&cursor=1')).json()
  check('filter by event and limit; count is the window, not the page', f.count === 2 && f.events.length === 1 && fo.count === 1 && fo.events[0].event === 'opened')
  check('there is no cursor: a cursor is ignored and nothing offers a next page', !('next' in f) && fc.events.length === 1 && fc.events[0].at === f.events[0].at && fc.events[0].event === f.events[0].event)
  const big = await (await get('/stocks/api/history/cases?chain=base&limit=500&since=2000-01-01T00:00:00Z')).json()
  check('a list is the last 7 days and at most 50 rows, whatever is asked, and says where the rest is', big.window_days === 7 && Date.parse(big.window_from) === NOW - 7 * 86400e3 && big.count === 2 && /on request/.test(big.older))
  const s = await (await get('/stocks/api/history/cases?chain=base&since=2026-11-08T00:00:00Z')).json()
  check('since keeps later events only', s.count === 1)
  check('a bad event, since or chain is a 400', (await get('/stocks/api/history/cases?chain=base&event=x')).status === 400 && (await get('/stocks/api/history/cases?chain=base&since=nope')).status === 400 && (await get('/stocks/api/history/cases?chain=nope')).status === 400)
  const both = await (await get('/stocks/api/history/cases')).json()
  check('without a chain, every chain answers; an empty one says so', both.chains.base.count === 2 && both.chains.robinhood.count === 0)
  const ri = await (await get('/stocks/api/history/registry?chain=base')).json()
  check('the registry index has no bodies', ri.count === 1 && ri.snapshots[0].records === 1 && !('body' in ri.snapshots[0]) && !('row' in ri.snapshots[0]))
  const rd = await (await get('/stocks/api/history/registry?chain=base&date=2026-11-08')).json()
  check('the snapshot in force on a day is the last one before its end', rd.in_force_since === '2026-11-07T12:52:00Z' && rd.snapshot.body.length === 1)
  const early = await (await get('/stocks/api/history/registry?chain=base&date=2026-11-01')).json()
  check('a day before the archive says when it begins', early.snapshot === null && /begins 2026-11-07/.test(early.reason))
  check('a bad date, or a date without a chain, is a 400', (await get('/stocks/api/history/registry?chain=base&date=11-08')).status === 400 && (await get('/stocks/api/history/registry?date=2026-11-08')).status === 400)
  check('the history API is open to other origins', (await get('/stocks/api/history/cases?chain=base')).headers.get('access-control-allow-origin') === '*')
  const v = await (await get(`/stocks/api/verify?chain=base&address=${X}`)).json()
  check('verify carries the open case, short', v.case?.status === 'open' && v.case.source === 'observed' && v.case.flagged_at === '2026-11-07T06:23:00Z' && v.case.events === 1, JSON.stringify(v.case))
  const vy = await (await get(`/stocks/api/verify?chain=base&address=${Y}`)).json()
  check('a backfilled case later listed says both, with no flag time', vy.case?.status === 'listed_by_issuer' && vy.case.source === 'backfilled' && vy.case.flagged_at === null && vy.case.closed_at === '2026-11-08T12:23:00Z')
  const va = await (await get(`/stocks/api/verify?chain=base&address=${A}`)).json()
  check('an address that never was a case has case null', va.case === null)
  {
    // Every verdict names the list it was decided against, in a form anyone can check (evm/core/stocks/list-proof.mjs).
    const lp = va.list_proof
    check('/verify carries list_proof: the issuer list\'s digest, its source, when it was read and how to reproduce it', lp && lp.issuer === 'coinbase' && lp.addresses === 1 && /^[0-9a-f]{64}$/.test(lp.addresses_sha256) && /^sha256:[0-9a-f]{64}$/.test(lp.registry_hash) && /^curl -fsS 'https:\/\/api\.coinbase\.com\/v1\/tokenized-stocks\?page_size=500'/.test(lp.reproduce) && lp.stale === false && Number.isFinite(Date.parse(lp.read_at)) && lp.ledger === 'https://proofofstock.xyz/api/history/registry?chain=base', JSON.stringify(lp))
    const vp = await (await get(`/stocks/api/passport?chain=base&address=${A}`)).json()
    const mv = await (await get('/stocks/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.7' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_stock_tokens', arguments: { chain: 'base', addresses: [A, X] } } }) })).json()
    const sc = mv.result?.structuredContent
    {
      // Review of #60: a failed read keeps the last good list and its stamp, says stale, and is not cached; a good read
      // clears it.
      let down = false
      const flaky = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl: (u) => (down && String(u).startsWith(COINBASE_URL) ? Promise.reject(new Error('down')) : fetchImpl(u)), now: () => NOW, log: () => {} })
      const { port: fp } = await flaky.start(0, '127.0.0.1')
      const ver = () => fetch(`http://127.0.0.1:${fp}/stocks/api/verify?chain=base&address=${A}`)
      const before = (await (await ver()).json()).list_proof
      down = true; await flaky.refreshAll()
      const r1 = await ver(); const during = (await r1.json()).list_proof
      down = false; await flaky.refreshAll()
      const after = (await (await ver()).json()).list_proof
      await flaky.stop()
      check('after a failed read the proof keeps the last good digest and says stale, uncached; a good read clears it', before.stale === false && during.stale === true && during.addresses_sha256 === before.addresses_sha256 && r1.headers.get('cache-control') === 'no-store' && after.stale === false, JSON.stringify([before.stale, during?.stale, r1.headers.get('cache-control'), after.stale]))
    }
    {
      // Spec 1.3: the exact list by its hash, so a forwarded verdict stays checkable after the issuer's list changes.
      const crypto = await import('node:crypto')
      const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
      const local = (u) => u.replace('https://proofofstock.xyz', '/stocks')
      const hdr = { headers: { 'x-real-ip': '198.51.100.31' } }
      const lr = await get(local(lp.list_url), hdr), body = await lr.text()
      const ar = await get(local(lp.addresses_url), hdr), lines = await ar.text()
      check('list_url serves the bytes registry_hash names, immutable, as JSON', lr.status === 200 && 'sha256:' + sha(body) === lp.registry_hash && /immutable/.test(lr.headers.get('cache-control')) && /^application\/json/.test(lr.headers.get('content-type')) && JSON.parse(body)[0].address === A, String(lr.status))
      check('...addresses_url its addresses, one per line, whose digest is addresses_sha256', ar.status === 200 && sha(lines) === lp.addresses_sha256 && lines === A + '\n')
      const nope = await get('/stocks/api/list/' + '0'.repeat(64), hdr)
      check('...a hash nobody has is a 404 in words, and a malformed one is not this route', nope.status === 404 && /no list with this hash/.test(await nope.text()) && (await get('/stocks/api/list/xyz', hdr)).status === 404)
      // The fixture's archive row names a made-up hash ('ab' x 32) over a real body: the archive lookup finds it, and the
      // server refuses to serve bytes under a name they do not hash to.
      const tampered = await get('/stocks/api/list/' + 'ab'.repeat(32), hdr)
      check('...an archived list whose bytes do not hash to its name is refused (500), never served', tampered.status === 500 && tampered.headers.get('cache-control') === 'no-store')
    }
    {
      // Spec 3.1 (owner, 12.11: up to 50 free, like MCP): GET /verify?addresses=, one snapshot and one proof per batch.
      const ip = (n) => ({ headers: { 'x-real-ip': '198.51.100.' + n } })
      const b = await (await get(`/stocks/verify?chain=base&addresses=${A},${X}`, ip(41))).json()
      check('a batch answers each address in order, with one proof for the batch, as MCP does', b.count === 2 && b.results[0].address === A && b.results[0].listed === true && b.results[1].address === X && b.listed === 1 && b.list_proof?.addresses_sha256 === lp.addresses_sha256 && b.results.every((r) => !('list_proof' in r)), JSON.stringify(b).slice(0, 200))
      const st = async (q) => (await get(`/stocks/verify?chain=base&${q}`, ip(42))).status
      const fifty = Array.from({ length: 50 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'))
      check('...address and addresses together, an empty list, 51 addresses or a bad one are each a 400', (await st(`address=${A}&addresses=${A}`)) === 400 && (await st('addresses=')) === 400 && (await st('addresses=' + [...fifty, A].join(','))) === 400 && /addresses\[1\]/.test(await (await get(`/stocks/verify?chain=base&addresses=${A},nope`, ip(43))).text()))
      const codes = []
      for (let i = 0; i < 13; i++) codes.push((await get(`/stocks/verify?chain=base&addresses=${fifty.join(',')}`, ip(44))).status)
      check('...a batch of 50 costs 5 units: twelve fit in a minute, the thirteenth is 429', codes.slice(0, 12).every((s) => s === 200) && codes[12] === 429, codes.join(','))
      const { evidenceViolations } = await import('../evm/core/stocks/evidence-rule.mjs')
      check('...and the batch keeps the evidence rule (the MCP batch rule applies)', evidenceViolations('mcp_verify', b).length === 0)
    }
    check('...the passport and MCP verify carry the same proof, MCP once per answer and not per address', vp.list_proof?.addresses_sha256 === lp.addresses_sha256 && sc?.list_proof?.addresses_sha256 === lp.addresses_sha256 && sc.results.every((r) => !('list_proof' in r)), JSON.stringify(sc?.list_proof))
  }
  const pp = await (await get(`/stocks/api/passport?chain=base&address=${X}`)).json()
  check('the passport carries the case too', pp.case?.status === 'open')
  const page = await get('/stocks/history')
  const html = await page.text()
  check('the history page lists the last 7 days, no backfilled row, and says each address keeps its case', page.status === 200 && /registry snapshot/.test(html) && !/from collector history/.test(html) && /listed by issuer/.test(html) && /last 7 days/.test(html) && /on request/.test(html))
  check('the history page escapes names from data', !/<img src=x/.test(html))
  {
    const out = (html.match(/<details class="hs-out">[\s\S]*?<\/details>/) || [''])[0]
    check('a flagged address opens on the explorer only through a warning that says what it is not', /<summary[^>]*><code>0x/.test(out) && out.includes('This is a look-alike, not the stock.') && out.includes('do not buy it, approve it or send anything to it') && /href="https:\/\/basescan\.org\/token\/0x[0-9a-f]{40}" target="_blank" rel="noopener noreferrer nofollow">I understand, open the contract on basescan\.org</.test(out), out.slice(0, 300))
    const listedRow = (html.match(/<li class="hs-row">[^]*?class="hs-ev listed"[^]*?<\/li>/) || [''])[0]
    check('...but a token the issuer has listed since opens without one, and the warning never sits mid-sentence', /<a class="hs-plain" href="https:\/\/basescan\.org\/token\/0x[0-9a-f]{40}"/.test(listedRow) && !listedRow.includes('hs-warn') && /registry &middot; <details class="hs-out">/.test(html), listedRow.slice(0, 300))
  }
  check('the main page links to the history', /href="history"/.test(await (await get('/stocks/')).text()))
}

console.log('the api')
{
  const find = await (await get('/stocks/api/find?chain=base&q=nvda')).json()
  check('find by bare ticker returns the official contract', find.matches.length === 1 && find.matches[0].address === A)
  const p = await (await get('/stocks/api/passport?chain=base&address=' + A.toUpperCase().replace('0X', '0x'))).json()
  check('a registry token passport comes from memory', p.in_registry === true && p.latest.premium === 0.0056 && p.series.readings === 2 && p.readings_loaded === true)
  check('it is never a trading signal', p.not_trading_signal === true)
  const f = await (await get('/stocks/api/passport?chain=base&address=' + X)).json()
  check('an impostor is named by its resemblance', f.in_registry === false && f.resembles?.kind === 'registry_symbol' && f.resembles?.registry_address === A)
  await get('/stocks/api/passport?chain=base&address=' + X)
  check('an outside token is named from our dataset, with no outbound call', f.identity.symbol === 'NVDAc' && dexCalls === 0, String(dexCalls))
  const unnamed = await (await get('/stocks/api/passport?chain=base&address=0x' + '77'.repeat(20))).json()
  check('a token our dataset does not name is answered without a name, still with no call', unnamed.in_registry === false && unnamed.identity.symbol === null && unnamed.resembles === null && dexCalls === 0)
  check('a bad address is 400', (await get('/stocks/api/passport?chain=base&address=nvda')).status === 400)
  check('a bad chain is 400', (await get('/stocks/api/find?chain=solana&q=x')).status === 400)
  check('an empty query is 400', (await get('/stocks/api/find?chain=base&q=')).status === 400)
  const both = await (await get('/stocks/api/find?q=nvda')).json()
  check('without a chain, find searches every loaded chain and says which', both.matches.length === 1 && both.matches[0].chain === 'base' && Array.isArray(both.missing))
  const ov = await (await get('/stocks/api/overview')).json()
  check('the board answers per chain with the market session', ov.chains.base.priced === 1 && ov.chains.base.rows[0].symbol === 'NVDAc' && ov.chains.robinhood.priced === 0 && typeof ov.market_now.session === 'string')
  check('the passport names its chain and lists the same share elsewhere', p.chain === 'base' && Array.isArray(p.same_stock_elsewhere))
  check('the passport links to GeckoTerminal and the explorer', /^https:\/\/www\.geckoterminal\.com\/base\/(pools|tokens)\/0x/.test(p.links.dex) && /^https:\/\/basescan\.org\/token\/0x/.test(p.links.explorer))
  check('the passport carries no chart series unless asked', !('series_points' in p))
  const ps = await (await get(`/stocks/api/passport?chain=base&address=${A}&series=1`)).json()
  check('with series=1 it carries its chart series', Array.isArray(ps.series_points) && ps.series_points.length === 2 && ps.series_points[1][1] === 0.0056)
  check('the page asks for the series it draws', /&series=1/.test(fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')))
  const imp = await (await get('/stocks/api/impostors')).json()
  check('impostors: a chain with no list yet says so instead of an empty list', imp.chains.base.error && imp.chains.robinhood.error)
  const page = await (await get('/stocks/?chain=base&address=' + A)).text()
  check('a link to a registry token previews that token', /<title>NVDAc \(NVIDIA\) on Base: \+0\.56% vs the issuer&#39;s reference/.test(page) && /property="og:url" content="https:\/\/proofofstock.xyz\/\?base=NVDAc"/.test(page))
  const plain = await (await get('/stocks/?chain=base&address=%22%3E%3Cscript%3E')).text()
  const short = await (await get('/stocks/?base=nvdac')).text()
  check('the short link ?base=NVDAc previews the same token, case-insensitively', /<title>NVDAc \(NVIDIA\) on Base/.test(short) && /og:url" content="https:\/\/proofofstock.xyz\/\?base=NVDAc"/.test(short))
  const unlisted = await (await get('/stocks/?chain=base&address=' + X)).text()
  check('a token outside the registry keeps its address in the link', /og:url" content="https:\/\/proofofstock.xyz\/\?chain=base&amp;address=0x(ee){20}"/.test(unlisted))
  check('a link with a junk address previews the site, and nothing from the link reaches the page', /<title>Proof of Stock<\/title>/.test(plain) && !plain.includes('<script>'))
  const st = await (await get('/stocks/api/status')).json()
  check('status says what is held per chain', st.base.registry_records === 1 && st.base.readings_tokens === 1 && st.robinhood.readings_tokens === 0)
  check('status says when the recorder last wrote, apart from when the server last read', st.base.newest_reading_at === '2026-11-08T13:45:00.000Z' && st.base.newest_reading_age_s === 900 && st.robinhood.newest_reading_at === null)
  const long = await (await get(`/stocks/api/passport?chain=base&address=${A}&hours=500`)).json()
  check('a public passport shows at most 24 h, whatever is asked', long.series.window_h === 24)
}

console.log('rate limit')
{
  let last = 0
  for (let i = 0; i < 61; i++) last = (await get('/stocks/api/find?chain=base&q=nvda', { headers: { 'x-real-ip': '203.0.113.7' } })).status
  check('the 61st request in a minute from one client is 429', last === 429)
  check('another client is not affected', (await get('/stocks/api/find?chain=base&q=nvda', { headers: { 'x-real-ip': '203.0.113.8' } })).status === 200)
}

console.log('the public MCP endpoint')
{
  const rpc = (body, extra = {}) => get('/stocks/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-real-ip': '198.51.100.1', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  // External audit, 12.11: a JSON-RPC body is JSON. text/plain and form bodies are what another site's page can send
  // without a preflight; they get 415, and so does a body with no type at all.
  const typed = async (ct) => { const h = { accept: 'application/json, text/event-stream', 'x-real-ip': '198.51.100.3' }; if (ct) h['content-type'] = ct; return get('/stocks/mcp', { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }) }
  const refused = await Promise.all(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null].map(typed))
  check('/mcp refuses a body that is not JSON with 415 and says why', refused.every((r) => r.status === 415) && /Content-Type must be application\/json/.test(await refused[0].text()) && refused[0].headers.get('access-control-allow-origin') === '*')
  check('...and takes application/json with a charset', (await typed('application/json; charset=utf-8')).status === 200)
  {
    const r = await get('/stocks/.well-known/security.txt')
    const t = await r.text()
    const exp = Date.parse((t.match(/^Expires: (.+)$/m) || [])[1])
    check('security.txt (RFC 9116): a contact, an expiry under a year ahead, the canonical address', r.status === 200 && /^text\/plain/.test(r.headers.get('content-type')) && /^Contact: mailto:hello@proofofstock\.xyz$/m.test(t) && exp > NOW && exp - NOW <= 366 * 864e5 && /^Canonical: https:\/\/proofofstock\.xyz\/\.well-known\/security\.txt$/m.test(t), t)
    check('...and no other mailbox', (t.match(/[\w.+-]+@[\w.-]+/g) || []).every((m) => m === 'hello@proofofstock.xyz'))
  }
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })).json()
  check('initialize answers the version the client asked for, when supported', init.result.protocolVersion === '2025-03-26' && init.result.capabilities.tools && /not advice: https:\/\/proofofstock.xyz\/docs\/legal\.md/.test(init.result.instructions))
  const odd = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json()
  check('...and its own latest when the asked version is unknown', odd.result.protocolVersion === '2025-06-18')
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  check('a notification is 202 with no body', note.status === 202 && (await note.text()) === '')
  const list = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()
  check('six read-only tools, none of them trading', list.result.tools.length === 6 && !list.result.tools.some((t) => /buy|sell|swap|trade/.test(t.name)))
  check('the passport tool offers only the hours the site holds', list.result.tools.find((t) => t.name === 'stock_passport').inputSchema.properties.hours.maximum === 24)
  check('a protocol version header this server does not speak is 400', (await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status === 400)
  check('...a supported one is served', (await rpc({ jsonrpc: '2.0', id: 10, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' })).status === 200)
  const find = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find_stock_token', arguments: { chain: 'base', query: 'nvda' } } })).json()
  check('find answers from memory, as text and as structured content', find.result.structuredContent.matches[0].address === A && JSON.parse(find.result.content[1].text).matches.length === 1)
  check('...its first block is the count in words, the second the JSON alone', /^1 issuer-listed token on Base has exactly the ticker or ISIN "nvda": NVDAc\.$/.test(find.result.content[0].text) && find.result.structuredContent.summary === find.result.content[0].text, find.result.content[0].text.slice(0, 80))
  const listed = await (await rpc({ jsonrpc: "2.0", id: 11, method: 'tools/call', params: { name: 'list_stock_tokens', arguments: { chain: 'base' } } })).json()
  const lead = listed.result.content[0].text
  check('the registry list states its exact count first, and the count matches the list', /^The Coinbase registry on Base lists 1 token \(count: 1\)\. Of them, 1 is minted on this chain and 1 has an issuer reference price\./.test(lead) && listed.result.structuredContent.count === listed.result.structuredContent.tokens.length, lead)
  check('...and says impostors are not part of it', /imitate these are a separate list/.test(lead))
  {
    // Spec 1.2: Robinhood reports no supply, so its list says minted null per token and no count, in words too.
    const rl = await (await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'list_stock_tokens', arguments: { chain: 'robinhood' } } })).json()
    const sc = rl.result.structuredContent
    // The evidence rule (evm/core/stocks/evidence-rule.mjs) over every kind of answer this server gives.
    const { evidenceViolations } = await import('../evm/core/stocks/evidence-rule.mjs')
    const ans = {
      verify: await (await get(`/stocks/api/verify?chain=base&address=${A}`, { headers: { 'x-real-ip': '198.51.100.21' } })).json(),
      passport: await (await get(`/stocks/api/passport?chain=base&address=${A}`, { headers: { 'x-real-ip': '198.51.100.21' } })).json(),
      mcp_verify: (await (await rpc({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'verify_stock_tokens', arguments: { chain: 'base', addresses: [A] } } })).json()).result.structuredContent,
      list: listed.result.structuredContent,
    }
    const bad = Object.entries(ans).flatMap(([k, a]) => evidenceViolations(k, a).map((m) => `${k}: ${m}`)).concat(evidenceViolations('list', sc).map((m) => `list robinhood: ${m}`))
    check('evidence rule: no answer states listed, minted or a premium without the field that backs it', bad.length === 0 && ans.verify.listed === true && ans.passport.in_registry === true, bad.join('; '))
    check('the Robinhood list says nothing is known about minting, per token, in the count and in the lead', sc.minted === null && sc.tokens.every((t) => t.minted === null) && /the issuer reports no supply, so how many are minted is not known/.test(rl.result.content[0].text), JSON.stringify([sc.minted, sc.tokens.map((t) => t.minted)]))
  }
  const pass = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'stock_passport', arguments: { chain: 'base', address: A } } })).json()
  check('the passport tool returns the same passport as the page', pass.result.structuredContent.in_registry === true && pass.result.structuredContent.links.explorer.startsWith('https://basescan.org/token/'))
  check('...opening with the verdict, the numbers and their true ages', /^ISSUER-LISTED: NVDAc on Base is in the Coinbase registry\. Issuer reference \$180 per token, 41 h old\. Deepest on-chain price \$181, \+0\.56% against the reference, read 15 min ago\./.test(pass.result.content[0].text), pass.result.content[0].text.slice(0, 220))
  check('...and closing with what listed is not: a verdict on the price', pass.result.content[0].text.endsWith(' Listed says which contract is the issuer\'s, not that its price is fair.'), pass.result.content[0].text.slice(-120))
  const fake = await (await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'stock_passport', arguments: { chain: 'base', address: X } } })).json()
  check('an impostor\'s passport opens with NOT and names the official contract', /^NOT an issuer token: 0x(ee){20} is not in the issuer registry on Base; its symbol or name imitates NVDAc \(official contract 0x(aa){20}\)\./.test(fake.result.content[0].text), fake.result.content[0].text.slice(0, 200))
  check('...and an impostor lead does not say what listed is (it is not listed)', !/Listed says/.test(fake.result.content[0].text))
  const bad = await (await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'stock_passport', arguments: { chain: 'base', address: 'nope' } } })).json()
  check('an argument that breaks the schema is a protocol error -32602', bad.error && bad.error.code === -32602 && /address has the wrong form/.test(bad.error.message), JSON.stringify(bad).slice(0, 200))
  const callWith = (id, name, args) => rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.json())
  const lean = pass.result.structuredContent
  check('the MCP passport leaves the raw series out unless asked, and names its sources and pool rule', lean.series_points === undefined && lean.series && /coinbase\.com/.test(lean.sources.registry) && lean.sources.pools_counted.min_liquidity_usd === 10000 && lean.sources.recorded_every_s === 900, JSON.stringify(lean.sources || {}).slice(0, 160))
  const full = await callWith(25, 'stock_passport', { chain: 'base', address: A, include_series: true })
  check('...and includes it when asked', Array.isArray(full.result.structuredContent.series_points) && full.result.structuredContent.series_points.length === 2)
  check('include_series must be a boolean', (await callWith(26, 'stock_passport', { chain: 'base', address: A, include_series: 'yes' })).error?.code === -32602)
  check('hours out of range is refused, not silently clamped', (await callWith(20, 'stock_passport', { chain: 'base', address: A, hours: 99999 })).error?.code === -32602)
  check('hours given as text is refused', (await callWith(21, 'stock_passport', { chain: 'base', address: A, hours: 'abc' })).error?.code === -32602)
  check('an unknown argument is refused', /unknown argument bogus/.test((await callWith(22, 'list_stock_tokens', { chain: 'base', bogus: 1 })).error?.message || ''))
  check('a query given as a number is refused', (await callWith(23, 'find_stock_token', { chain: 'base', query: 12345 })).error?.code === -32602)
  check('an unknown tool is a protocol error', (await callWith(24, 'buy_token', {})).error?.code === -32602)
  const raw = (b) => rpc(b).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
  check('a null id is refused', (await raw({ jsonrpc: '2.0', id: null, method: 'ping' })).json?.error?.code === -32600)
  check('an object id is refused', (await raw({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })).json?.error?.code === -32600)
  check('a non-string method is refused', (await raw({ jsonrpc: '2.0', id: 30, method: 5 })).json?.error?.code === -32600)
  check('an id with no method, result or error is refused', (await raw({ jsonrpc: '2.0', id: 31 })).json?.error?.code === -32600)
  check('a client response (id with result) is accepted with 202', (await rpc({ jsonrpc: '2.0', id: 32, result: {} })).status === 202)
  check('tools are annotated read-only and idempotent', list.result.tools.every((t) => t.annotations && t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false && t.annotations.idempotentHint === true))
  const nameOnly = passportLead({ in_registry: false, address: '0x' + '9a'.repeat(20), resembles: { kind: 'issuer_name_suffix', ticker: null, registry_symbol: null, registry_address: null } }, 'Robinhood Chain')
  check('a name-only impostor never reads "imitates null"', !/null/.test(nameOnly) && /copies the way the issuer names its stock tokens/.test(nameOnly), nameOnly)
  check('GET is 405: no SSE stream is offered', (await get('/stocks/mcp')).status === 405)
  check('DELETE is 405 too: no sessions to end', (await get('/stocks/mcp', { method: 'DELETE' })).status === 405)
  const browser = await get('/stocks/mcp', { redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
  check('a browser opening the MCP address is sent to the page section on connecting an agent', browser.status === 302 && browser.headers.get('location') === 'https://proofofstock.xyz/#mcp')
  check('an MCP client asking for an event stream still gets 405', (await get('/stocks/mcp', { headers: { accept: 'application/json, text/event-stream' } })).status === 405)
  const pre = await get('/stocks/mcp', { method: 'OPTIONS' })
  check('a browser preflight is answered with CORS for POST', pre.status === 204 && pre.headers.get('access-control-allow-methods').includes('POST'))
  check('a batch is refused', (await rpc([{ jsonrpc: '2.0', id: 7, method: 'ping' }])).status === 400)
  check('junk is a parse error', (await (await rpc('{nope')).json()).error.code === -32700)
  check('a body over 16 KB is 413', (await rpc({ jsonrpc: '2.0', id: 8, method: 'ping', pad: 'x'.repeat(20000) })).status === 413)
}

console.log('verify and badge')
{
  const v = await get('/stocks/verify?chain=base&address=' + A.toUpperCase().replace('0X', '0x'))
  const vb = await v.json()
  check('verify: a registry address is listed, whatever its case, with a short passport link', v.status === 200 && vb.listed === true && vb.symbol === 'NVDAc' && vb.passport === 'https://proofofstock.xyz/?base=NVDAc' && v.headers.get('access-control-allow-origin') === '*')
  const out = await (await get('/stocks/verify?chain=base&address=' + X)).json()
  check('verify: an address outside the registry is not listed and names the registry checked', out.listed === false && out.registries_checked[0] === 'coinbase:base' && /address=0x(ee){20}/.test(out.passport))
  check('verify: the /api/ path answers the same', (await (await get('/stocks/api/verify?chain=base&address=' + A)).json()).listed === true)
  check('verify: a bad chain and a bad address are 400', (await get('/stocks/verify?chain=sol&address=' + A)).status === 400 && (await get('/stocks/verify?chain=base&address=nvda')).status === 400)
  const badge = await get('/stocks/badge.svg?chain=base&address=' + A)
  const svg = await badge.text()
  check('badge: an SVG naming the listed token and printing its address', badge.status === 200 && /image\/svg\+xml/.test(badge.headers.get('content-type')) && svg.includes('Issuer-listed · NVDAc · Coinbase') && svg.includes('0xaaaa…aaaa'))
  const junk = await get('/stocks/badge.svg?chain=nope&address=x')
  check('badge: a junk request is still a 200 image, in the "?" state, not cached', junk.status === 200 && (await junk.text()).includes('Registry unavailable') && junk.headers.get('cache-control') === 'no-store')
  // A chain named after an Object.prototype member used to pass the CHAINS[c] check and crash the handler with a 500.
  for (const [i, c] of ['constructor', '__proto__', 'toString', 'hasOwnProperty'].entries()) {
    const from = { headers: { 'x-real-ip': '198.51.100.' + (60 + i) } } // its own address: the checks above spent the shared quota
    const v = await get('/stocks/verify?chain=' + c + '&address=' + A, from), b = await get('/stocks/badge.svg?chain=' + c + '&address=' + A, from)
    const p = await get('/stocks/api/passport?chain=' + c + '&address=' + A, from), h = await get('/stocks/api/history/cases?chain=' + c, from)
    check('chain=' + c + ' is a 400 on verify, passport and history, and the ? badge', v.status === 400 && p.status === 400 && h.status === 400 && b.status === 200 && (await b.text()).includes('Registry unavailable'), [v.status, p.status, h.status, b.status].join(' '))
  }
  const rpcV = (args) => get('/stocks/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.9' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_stock_tokens', arguments: args } }) }).then((r) => r.json())
  const batch = await rpcV({ chain: 'base', addresses: [A, X] })
  check('MCP verify: one call checks many addresses and opens with the counts', batch.result.structuredContent.count === 2 && batch.result.structuredContent.listed === 1 && /^1 of 2 addresses is issuer-listed on Base \(NVDAc\)\./.test(batch.result.content[0].text), batch.result && batch.result.content[0].text)
  check('MCP verify: 51 addresses are refused by the schema', (await rpcV({ chain: 'base', addresses: Array(51).fill(A) })).error?.code === -32602)
  check('MCP verify: a malformed address in the list is refused', /addresses\[1\] has the wrong form/.test((await rpcV({ chain: 'base', addresses: [A, 'nope'] })).error?.message || ''))
  const rec = await get('/stocks/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.9' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recent_impostors', arguments: { chain: 'base' } } }) }).then((r) => r.json())
  check('MCP recent_impostors: a chain with no list yet is a tool error the model can read', rec.result && rec.result.isError === true && /impostor list/.test(rec.result.content[0].text))
}
{
  // A registry that stops refreshing: verify must stop answering "not listed" and say it cannot tell.
  let t = NOW
  const app6 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => t, log: () => {} })
  const { port: p6 } = await app6.start(0, '127.0.0.1')
  t += 901e3
  const stale = await fetch(`http://127.0.0.1:${p6}/stocks/verify?chain=base&address=${X}`)
  check('verify: a registry older than 15 minutes is 503, never "not listed"', stale.status === 503 && stale.headers.get('cache-control') === 'no-store' && (await stale.json()).listed === undefined)
  const sb = await (await fetch(`http://127.0.0.1:${p6}/stocks/badge.svg?chain=base&address=${X}`)).text()
  check('badge: ...and the badge says "?" with the address, still a 200', sb.includes('Registry unavailable') && sb.includes('0xeeee…eeee'))
  await app6.stop()
}
{
  // /status and /history: one build serves every request for PAGE_CACHE_MS, then the page is built again.
  let t = NOW
  const app9 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => t, log: () => {} })
  const { port: p9 } = await app9.start(0, '127.0.0.1')
  const page = (p) => fetch(`http://127.0.0.1:${p9}/stocks${p}`).then((r) => r.text())
  const s1 = await page('/status'), h1 = await page('/history')
  t += PAGE_CACHE_MS - 1000
  check('/status and /history are served from memory within the cache window', (await page('/status')) === s1 && (await page('/history')) === h1)
  t += 20 * 60e3
  check('...and built again after it (the ages move on)', (await page('/status')) !== s1)
  await app9.stop()
}
console.log('the Base and Robinhood matrix')
{
  // Its own roots and registries: NVIDIA listed on both chains under one ISIN, Tesla on Robinhood only.
  const b2 = path.join(tmp, 'base2'), r2 = path.join(tmp, 'rh2'), N2 = '0x' + 'dd'.repeat(20)
  for (const d of [b2, r2]) fs.mkdirSync(path.join(d, 'stock-peg'), { recursive: true })
  fs.writeFileSync(path.join(b2, 'stock-peg', 'stock-peg-2026-11-08.jsonl'), JSON.stringify(peg(A, '2026-11-08T13:45:00Z', 0.0056)) + '\n')
  const rhRow = { ...peg(N2, '2026-11-08T13:45:00Z', -0.002), multiplier: 2, reference: { kind: 'token_bid_ask_mid', price_usd: 360, updated_at: '2026-11-08T13:40:00Z', age_s: 300, halted: false }, dex_price_usd: 359.28 }
  fs.writeFileSync(path.join(r2, 'stock-peg', 'stock-peg-2026-11-08.jsonl'), JSON.stringify(rhRow) + '\n')
  const fetch2 = async (url) => {
    const u = String(url)
    if (u.startsWith(ROBINHOOD_ASSETS_URL)) return { ok: true, status: 200, json: async () => ({ assets: [
      { tokenSymbol: 'NVDA', tokenName: 'NVIDIA  Robinhood Token', isin: 'US67066G1040', currentMultiplier: '2', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: N2 }] },
      { tokenSymbol: 'TSLA', tokenName: 'Tesla  Robinhood Token', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: R }] }] }) }
    return fetchImpl(url)
  }
  const app7 = createStocksWeb({ roots: { base: b2, robinhood: r2 }, fetchImpl: fetch2, now: () => NOW, log: () => {} })
  const { port: p7 } = await app7.start(0, '127.0.0.1')
  const res = await fetch(`http://127.0.0.1:${p7}/stocks/api/matrix`)
  const mx = await res.json()
  const row = mx.rows && mx.rows[0]
  check('api/matrix: one row per ISIN on both chains, cached for a minute', res.status === 200 && mx.pairs === 1 && row.isin === 'US67066G1040' && res.headers.get('cache-control') === 'public, max-age=60', JSON.stringify(mx).slice(0, 200))
  check('api/matrix: each venue its own premium, the gap between them', row.base.symbol === 'NVDAc' && row.robinhood.symbol === 'NVDA' && row.base.premium === 0.0056 && row.robinhood.premium === -0.002 && row.gap === -0.002 - 0.0056)
  check('api/matrix: different references are said in words', row.reference_kinds_differ === true && /different references/.test(row.reference_note) && mx.compares === 'premium')
  const pass = await (await fetch(`http://127.0.0.1:${p7}/stocks/api/passport?chain=robinhood&address=${N2}`)).json()
  check('api/matrix: a cell equals the passport', row.robinhood.premium === pass.latest.premium && row.robinhood.reference_age_s === pass.reference.age_s && row.robinhood.multiplier === pass.issuer.multiplier && row.robinhood.reference_kind === pass.reference.kind)
  let last = 0
  for (let i = 0; i < 61; i++) last = (await fetch(`http://127.0.0.1:${p7}/stocks/api/matrix`, { headers: { 'x-real-ip': '203.0.113.70' } })).status
  check('api/matrix is rate limited like the other routes', last === 429)
  const call = (id, args) => fetch(`http://127.0.0.1:${p7}/stocks/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.70' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'compare_venues', arguments: args } }) }).then((r) => r.json())
  const all = await call(1, {})
  check('MCP compare_venues: with no argument, the top rows and a lead with exact counts', all.result.structuredContent.rows.length === 1 && /^1 share is listed on both Base \(Coinbase\) and Robinhood Chain \(Robinhood\), matched by ISIN\. 1 has a current premium on both venues and 0 do not/.test(all.result.content[0].text) && /not a price difference/.test(all.result.content[0].text), all.result && all.result.content[0].text)
  check('...the gap in percentage points', /NVDAc\/NVDA gap -0\.76 pp \(Base \+0\.56%, Robinhood -0\.20%\)/.test(all.result.content[0].text), all.result.content[0].text)
  const bySym = await call(2, { symbol: 'NVDAc' })
  check('MCP compare_venues: NVDAc resolves to its ISIN', bySym.result.structuredContent.rows.length === 1 && bySym.result.structuredContent.query.symbol_isins[0] === 'US67066G1040' && /^1 pair for the ticker NVDAc/.test(bySym.result.content[0].text), bySym.result && bySym.result.content[0].text)
  check('...and so does the bare ticker NVDA', (await call(3, { symbol: 'NVDA' })).result.structuredContent.rows[0]?.isin === 'US67066G1040')
  check('MCP compare_venues: by ISIN', (await call(4, { isin: 'US67066G1040' })).result.structuredContent.total === 1)
  const one = await call(5, { symbol: 'TSLA' })
  check('MCP compare_venues: a share on one chain only is answered in words, with no rows', one.result.structuredContent.rows.length === 0 && /^No share with the ticker TSLA is listed on both/.test(one.result.content[0].text), one.result && one.result.content[0].text)
  const none = await call(6, { symbol: 'ZZZZ' })
  check('MCP compare_venues: an unknown ticker says no issuer lists it', /^No issuer-listed token on Base or Robinhood Chain has the ticker ZZZZ/.test(none.result.content[0].text))
  check('MCP compare_venues: arguments are validated', (await call(7, { isin: 'nope' })).error?.code === -32602 && (await call(8, { symbol: 5 })).error?.code === -32602 && /unknown argument chain/.test((await call(9, { chain: 'base' })).error?.message || ''))
  await app7.stop()
  const down = createStocksWeb({ roots: { base: b2, robinhood: r2 }, fetchImpl: async (url) => (String(url).startsWith(ROBINHOOD_ASSETS_URL) ? { ok: false, status: 503, json: async () => ({}) } : fetchImpl(url)), now: () => NOW, log: () => {} })
  const { port: p8 } = await down.start(0, '127.0.0.1')
  const d = await fetch(`http://127.0.0.1:${p8}/stocks/api/matrix`)
  check('api/matrix: a chain whose registry is not loaded is 503 naming it, not an empty matrix', d.status === 503 && (await d.json()).missing[0] === 'robinhood')
  await down.stop()
}
{
  const { batchUnits } = await import('./stocks-web.mjs')
  check('a batch verify costs one rate unit per ten addresses', batchUnits(JSON.stringify({ method: 'tools/call', params: { name: 'verify_stock_tokens', arguments: { addresses: Array(25).fill(A) } } })) === 3 && batchUnits('{nope') === 1 && batchUnits(JSON.stringify({ method: 'ping' })) === 1)
}

await app.stop()

console.log('before a registry is loaded')
{
  const down = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), now: () => NOW, log: () => {} })
  const a = await down.start(0, '127.0.0.1')
  const r = await fetch(`http://127.0.0.1:${a.port}/stocks/api/find?chain=base&q=nvda`)
  check('a chain whose registry never loaded answers 503, not an empty list', r.status === 503)
  const h = await fetch(`http://127.0.0.1:${a.port}/healthz`)
  check('healthz is 503 while no registry is loaded, so the deploy gate fails', h.status === 503 && (await h.json()).ok === false)
  await down.stop()
}

console.log('errors in public answers')
{
  // Every source fails with a message that carries an internal path: none of it may reach a response, all of it the log.
  const SECRET = 'srv-internal-path-7f3a'
  const r3 = path.join(tmp, 'broken'), b3 = path.join(r3, 'base'), h3 = path.join(r3, 'rh')
  for (const root of [b3, h3]) {
    fs.mkdirSync(path.join(root, 'stock-peg', 'history', 'cases-2026-11-10.jsonl'), { recursive: true }) // a directory: reading it throws EISDIR with its path
    fs.mkdirSync(path.join(root, 'stock-peg', 'impostors.json'), { recursive: true })
  }
  const logged = []
  const broken = createStocksWeb({ roots: { base: b3, robinhood: h3 }, fetchImpl: async () => { throw new Error('ENOENT: open /' + SECRET + '/registry.json') }, now: () => NOW, log: (m) => logged.push(m) })
  const a = await broken.start(0, '127.0.0.1')
  const at = (p, o) => fetch(`http://127.0.0.1:${a.port}${p}`, o).then((r) => r.text())
  const rpc = (name, args) => at('/stocks/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const bodies = [await at('/stocks/api/status'), await at('/stocks/api/passport?chain=base&address=' + A), await at('/stocks/api/history/cases'), await at('/stocks/api/history/registry'), await at('/stocks/api/impostors'),
    await rpc('recent_impostors', { chain: 'base' }), await rpc('list_stock_tokens', { chain: 'base' })]
  const leaks = bodies.filter((b) => b.includes(SECRET) || b.includes(r3) || /EISDIR|ENOENT/.test(b))
  check('no internal path or system error code in any public answer', leaks.length === 0, leaks.map((b) => b.slice(0, 120)).join(' | '))
  check('the answers say what is unavailable in plain words', bodies[1].includes('the issuer registry could not be read') && bodies[2].includes('the history archive could not be read') && bodies[4].includes('unreadable'), bodies[1].slice(0, 120))
  check('the originals are in the log', logged.some((m) => m.includes(SECRET)) && logged.some((m) => m.includes('EISDIR')))
  await broken.stop()
}

console.log('the public address')
{
  const app4 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
  const { port: p4 } = await app4.start(0, '127.0.0.1')
  const page = await (await fetch(`http://127.0.0.1:${p4}/stocks/`)).text()
  await app4.stop()
  check('the page shows the MCP URL of the public origin, three times, and no placeholder is left', (page.replace(/<script type="application\/ld\+json">[^<]*<\/script>/g, '').match(/https:\/\/proofofstock.xyz\/mcp/g) || []).length === 3 && !page.includes('__MCP_URL__'))
  const app3 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {}, publicOrigin: 'https://example.test', publicPath: '/x' })
  const { port: p3 } = await app3.start(0, '127.0.0.1')
  const other = await (await fetch(`http://127.0.0.1:${p3}/stocks/?chain=base&address=${A}`)).text()
  check('another origin and path are used for the MCP URL and the canonical link', other.includes('https://example.test/x/mcp') && other.includes('content="https://example.test/x/?base=NVDAc"'))
  await app3.stop()
}

console.log('docs and llms.txt')
{
  const { loadDocs, llmsTxt } = await import('./stocks-web.mjs')
  const docs = loadDocs()
  check('only public docs are served: no TZ, no internal agent note', ![...docs.keys()].some((k) => /truth-layer-tz|stocks-passport-agent/.test(k)))
  const llms = llmsTxt(new Map([['README.md', '# Docs'], ['tutorials/a.md', '# Connect\n\nv0.3.0 · x\n\nConnect an agent in five minutes.'], ['legal.md', '# Legal\n\nNot investment advice.']]), 'https://x.test', '9.9.9')
  check('llms.txt is a markdown index with sections, links and one line each', /^# Proof of Stock/.test(llms) && /## Tutorials\n\n- \[Connect\]\(https:\/\/x\.test\/docs\/tutorials\/a\.md\): Connect an agent in five minutes\./.test(llms) && /Version 9\.9\.9/.test(llms), llms)
  const app7 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
  const { port: p7 } = await app7.start(0, '127.0.0.1')
  const g7 = (u, o) => fetch(`http://127.0.0.1:${p7}${u}`, o)
  const lt = await g7('/stocks/llms.txt')
  {
    const cl = await g7('/stocks/docs/changelog.md', { headers: { accept: 'text/html' } })
    const clHtml = await cl.text()
    check('the changelog is a docs page, in the docs layout', cl.status === 200 && /text\/html/.test(cl.headers.get('content-type')) && /Changelog/.test(clHtml) && /\[?0\.4\.0/.test(clHtml))
    check('...its link into docs/ is rebased, not docs/docs/', !/href="docs\//.test(clHtml))
    const old = await fetch(`http://127.0.0.1:${p7}/stocks/CHANGELOG.md`, { redirect: 'manual' })
    check('the old /CHANGELOG.md address redirects to it', old.status === 301 && /\/docs\/changelog\.md$/.test(old.headers.get('location')))
    const home = await (await g7('/stocks/')).text()
    check('the footer version links to the docs page', /href="docs\/changelog\.md"/.test(home) && !/href="CHANGELOG\.md"/.test(home))
  }
  const full = await (await g7('/stocks/llms-full.txt')).text()
  check('llms-full.txt has no relative link: each is absolute against its own page', !/\]\((?!https?:|mailto:)[^)\s]+\)/.test(full) && /\]\(https:\/\/[^)]+\/docs\/reference\/[a-z-]+\.md/.test(full))
  check('/llms.txt is served as text', lt.status === 200 && /text\/plain/.test(lt.headers.get('content-type')) && /^# Proof of Stock/.test(await lt.text()))
  check('/docs/ serves the index and a missing page is a 404', (await g7('/stocks/docs/')).status === (docs.has('README.md') ? 200 : 404) && (await g7('/stocks/docs/nope.md')).status === 404)
  check('no path escapes the docs', (await g7('/stocks/docs/..%2f..%2fpackage.json')).status === 404 && (await g7('/stocks/docs/../package.json')).status !== 200)
  const page = await (await g7('/stocks/')).text()
  check('the page shows the version from package.json', page.includes('v' + JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version) && !page.includes('__VERSION__'))
  check('...with its release date from the changelog and the rights line', /v\d+\.\d+\.\d+ · \d{1,2} [A-Z][a-z]{2} \d{4}/.test(page) && !page.includes('__RELEASED__') && /© 2026 Proof of Stock\. Code under the MIT licence\./.test(page))
  const init = await (await fetch(`http://127.0.0.1:${p7}/stocks/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })).json()
  check('the MCP server reports the same version and points at the docs', init.result.serverInfo.version === JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version && /docs\/legal\.md/.test(init.result.instructions))
  await app7.stop()
}

console.log('status page')
{
  const { statusOf, judge, LIMITS } = await import('./stocks-status.mjs')
  check('a part is on time, late or not updating by its own schedule', judge(600, LIMITS.readings) === 'ok' && judge(2400, LIMITS.readings) === 'late' && judge(9000, LIMITS.readings) === 'down' && judge(null, LIMITS.readings) === 'down')
  const s = statusOf({ base: { registry_records: 10, registry_age_s: 30, readings_tokens: 5, newest_reading_age_s: 400, impostors_listed: 3, impostors_age_s: 3600 } })
  check('all parts on time is the green state', s.overall === 'ok' && s.rows.length === 3)
  check('one stale part makes the page say so', statusOf({ base: { registry_records: 10, registry_age_s: 30, readings_tokens: 5, newest_reading_age_s: 5000, impostors_listed: 3, impostors_age_s: 3600 } }).overall === 'down')
  const app8 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
  const { port: p8 } = await app8.start(0, '127.0.0.1')
  const page = await fetch(`http://127.0.0.1:${p8}/stocks/status`)
  const html = await page.text()
  check('/status is a page for people, with plain words per chain', page.status === 200 && /text\/html/.test(page.headers.get('content-type')) && /Base/.test(html) && /Price readings/.test(html) && /updated /.test(html) && (html.match(/<script(?! type="application\/ld\+json")/g) || []).length === 1 && /<script src="beacon\.js\?v=[0-9a-f]{12}" defer><\/script>/.test(html))
  check('/api/status still answers JSON for code, now with the impostor list age', typeof (await (await fetch(`http://127.0.0.1:${p8}/stocks/api/status`)).json()).base.impostors_age_s !== 'undefined')
  const doc = await fetch(`http://127.0.0.1:${p8}/stocks/docs/`, { headers: { accept: 'text/html' } })
  const dh = await doc.text()
  check('a browser gets the docs as a page with the catalogs, not markdown', /text\/html/.test(doc.headers.get('content-type')) && /class="cats"/.test(dh) && /class="dx-side"/.test(dh))
  // The only scripts: the self-hosted search (script-src 'self'), its JSON index and the JSON-LD, which a browser does
  // not execute.
  const scripts = dh.match(/<script[^>]*>/g) || []
  check('the docs page runs no inline script, only the self-hosted search and counter', scripts.length === 4 && scripts.every((t) => /src="[./]*(docs|beacon)\.js\?v=/.test(t) || /type="application\/(ld\+)?json"/.test(t)))
  const tools = await (await fetch(`http://127.0.0.1:${p8}/stocks/docs/reference/tools.md`, { headers: { accept: 'text/html' } })).text()
  check('a tool heading renders as a signature card', /<h2 id="find_stock_token" class="fn"><span class="fn-kind">tool<\/span>/.test(tools) || /class="fn"><span class="fn-kind">tool/.test(tools))
  const js = await fetch(`http://127.0.0.1:${p8}/stocks/docs.js`)
  check('the search script is served as JavaScript', js.status === 200 && /javascript/.test(js.headers.get('content-type')))
  const md = await fetch(`http://127.0.0.1:${p8}/stocks/docs/?format=md`, { headers: { accept: 'text/html' } })
  check('?format=md and non-browser clients still get the markdown', /text\/markdown/.test(md.headers.get('content-type')) && /text\/markdown/.test((await fetch(`http://127.0.0.1:${p8}/stocks/docs/`)).headers.get('content-type')))
  await app8.stop()
}

console.log('search engines, AI crawlers and link previews')
{
  const app = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
  const { port } = await app.start(0, '127.0.0.1')
  const g = (u, h = {}) => fetch(`http://127.0.0.1:${port}${u}`, { headers: h })
  const html = { accept: 'text/html' }
  const ld = (page) => [...page.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]))
  const tag = (page, re) => (page.match(re) || [])[1]

  const rb = await g('/stocks/robots.txt')
  const robots = await rb.text()
  check('/robots.txt allows the pages, keeps the API and /mcp out and names the sitemap', rb.status === 200 && /text\/plain/.test(rb.headers.get('content-type')) && /^User-agent: \*$/m.test(robots) && /^Allow: \/$/m.test(robots) && /^Disallow: \/api\/$/m.test(robots) && /^Disallow: \/mcp$/m.test(robots) && /^Sitemap: https:\/\/proofofstock\.xyz\/sitemap\.xml$/m.test(robots) && !/^Disallow: \/$/m.test(robots), robots)

  const sm = await g('/stocks/sitemap.xml')
  const sitemap = await sm.text()
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])
  check('/sitemap.xml is XML', sm.status === 200 && /application\/xml/.test(sm.headers.get('content-type')) && /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sitemap))
  check('...lists the home, the docs home, every docs page, /status and /history', ['https://proofofstock.xyz/', 'https://proofofstock.xyz/docs/', 'https://proofofstock.xyz/docs/reference/http-api.md', 'https://proofofstock.xyz/docs/legal.md', 'https://proofofstock.xyz/status', 'https://proofofstock.xyz/history'].every((u) => locs.includes(u)), locs.join(' '))
  check('...and one passport per listed token by its short link, from the registries in memory', locs.includes('https://proofofstock.xyz/?base=NVDAc') && locs.includes('https://proofofstock.xyz/?robinhood=TSLA'))
  check('...but no API route, no README duplicate, no schema file, no bare address and no duplicate', !locs.some((u) => /\/api\/|\/mcp|README|schema\.json|address=/.test(u)) && new Set(locs).size === locs.length)
  check('...with the release date as lastmod on the home', /<loc>https:\/\/proofofstock\.xyz\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap) || !/^## \[\d+\.\d+\.\d+\] - /m.test(fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')))

  const home = await (await g('/stocks/')).text()
  check('the home names its canonical link', tag(home, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/')
  check('...a large preview image by content hash, with its size and alt text', /^https:\/\/proofofstock\.xyz\/og\.png\?v=[0-9a-f]{12}$/.test(tag(home, /<meta property="og:image" content="([^"]*)">/) || '') && /name="twitter:card" content="summary_large_image"/.test(home) && /og:image:width" content="1200"/.test(home) && /og:image:height" content="630"/.test(home) && /og:image:alt" content="[^"]{20,}"/.test(home))
  check('...and is not marked noindex', !/name="robots"/.test(home))
  const homeLd = ld(home)
  const nodes = homeLd[0]?.['@graph'] || []
  const byType = (t) => nodes.find((n) => n['@type'] === t)
  check('the home JSON-LD names the organisation, the site, the web app and the MCP server', homeLd.length === 1 && byType('Organization')?.name === 'Proof of Stock' && byType('WebSite')?.url === 'https://proofofstock.xyz/' && byType('WebApplication')?.applicationCategory === 'FinanceApplication' && byType('SoftwareApplication')?.url === 'https://proofofstock.xyz/mcp')
  const emails = JSON.stringify(homeLd).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []
  check('...with hello@proofofstock.xyz as the only contact', emails.length > 0 && emails.every((e) => e === 'hello@proofofstock.xyz'), emails.join(' '))
  check('...and the version the footer shows', byType('WebApplication')?.softwareVersion === JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)

  const listed = await (await g('/stocks/?chain=base&address=' + A)).text()
  check('a listed token\'s passport is indexable, canonical at its short link, with a WebPage node', tag(listed, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/?base=NVDAc' && !/name="robots"/.test(listed) && ld(listed)[0]['@graph'].some((n) => n['@type'] === 'WebPage' && n.url === 'https://proofofstock.xyz/?base=NVDAc'))
  const unlistedPage = await (await g('/stocks/?chain=base&address=0x' + '12'.repeat(20))).text()
  check('an address that is neither listed nor a listed impostor is noindex', /<meta name="robots" content="noindex">/.test(unlistedPage) && tag(unlistedPage, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/?chain=base&amp;address=0x' + '12'.repeat(20))
  const junk = await (await g('/stocks/?chain=base&address=%22%3E%3Cscript%3E&utm_source=x')).text()
  check('a junk or tracking link is the home: canonical / and indexable', tag(junk, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/' && !/name="robots"/.test(junk))

  const doc = await (await g('/stocks/docs/reference/http-api.md', html)).text()
  check('a docs page names its canonical link, an article preview and a TechArticle', tag(doc, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/docs/reference/http-api.md' && /property="og:type" content="article"/.test(doc) && /og:image" content="https:\/\/proofofstock\.xyz\/og\.png\?v=/.test(doc) && ld(doc)[0]['@graph'].some((n) => n['@type'] === 'TechArticle' && n.url === 'https://proofofstock.xyz/docs/reference/http-api.md' && /^HTTP API/.test(n.headline)))
  check('...its og:title is the page title, said once', (doc.match(/property="og:title"/g) || []).length === 1 && /property="og:title" content="HTTP API · Proof of Stock Docs"/.test(doc))
  const docsHome = await (await g('/stocks/docs/', html)).text()
  check('the docs home is canonical at /docs/, not /docs/README.md', tag(docsHome, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/docs/' && tag(await (await g('/stocks/docs/README.md', html)).text(), /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/docs/')
  const md = await g('/stocks/docs/reference/http-api.md')
  check('the markdown copy points a crawler at the HTML page', /text\/markdown/.test(md.headers.get('content-type')) && md.headers.get('link') === '<https://proofofstock.xyz/docs/reference/http-api.md>; rel="canonical"')

  const status = await (await g('/stocks/status')).text()
  check('/status has a description, its canonical link and a preview', /<meta name="description" content="[^"]{40,}">/.test(status) && tag(status, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/status' && /og:image/.test(status) && (status.match(/name="description"/g) || []).length === 1)
  const hist = await (await g('/stocks/history')).text()
  check('/history keeps its own description and gets its canonical link and a preview', tag(hist, /<link rel="canonical" href="([^"]*)">/) === 'https://proofofstock.xyz/history' && /property="og:description" content="What each issuer listed/.test(hist) && (hist.match(/name="description"/g) || []).length === 1)

  const api = await g('/stocks/api/overview'), verify = await g(`/stocks/verify?chain=base&address=${A}`), page = await g('/stocks/')
  check('JSON answers say noindex; pages do not', api.headers.get('x-robots-tag') === 'noindex' && verify.headers.get('x-robots-tag') === 'noindex' && page.headers.get('x-robots-tag') === null && (await g('/stocks/docs/', html)).headers.get('x-robots-tag') === null)

  const png = async (u) => { const r = await g(u); const b = Buffer.from(await r.arrayBuffer()); return { type: r.headers.get('content-type'), sig: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }
  const og = await png('/stocks/og.png'), logo = await png('/stocks/logo.png')
  check('/og.png is a 1200×630 PNG and /logo.png a 512×512 one', og.type === 'image/png' && og.sig === 'PNG' && og.w === 1200 && og.h === 630 && logo.sig === 'PNG' && logo.w === 512 && logo.h === 512, JSON.stringify({ og, logo }))
  check('/favicon.ico answers an image instead of a JSON 404', (await g('/stocks/favicon.ico')).status === 200 && /^image\//.test((await g('/stocks/favicon.svg')).headers.get('content-type')))
  {
    // The site's icon (owner, 11.11): the blue disc with the notched band. Every kind of page carries the same one inline,
    // /favicon.svg is that file, and the PNG (touch icon, /favicon.ico, the organisation's logo) is its 512 px raster.
    const icon = (await (await g('/stocks/favicon.svg')).text())
    const iconOf = (html) => (html.match(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)">/) || [])[1]
    const pages = await Promise.all(['/stocks/', '/stocks/docs/', '/stocks/history', '/stocks/status'].map(async (u) => iconOf(await (await g(u, { accept: 'text/html' })).text())))
    check('the icon is the owner\'s: a #4B87FF disc and a #070C18 notched band', /fill="#4B87FF"/.test(icon) && /M0 8h6V6h4v2h6v1H9V7H7v2H0z/.test(icon))
    check('...and every kind of page carries that same icon', pages.every((p) => p && p === pages[0]) && decodeURIComponent(pages[0]).includes('M0 8h6V6h4v2h6v1H9V7H7v2H0z') && !pages.some((p) => p.includes('0052ff')), JSON.stringify(pages.map((p) => (p || 'none').slice(0, 30))))
    // The brand marks (footer, docs bar) draw the icon from the stylesheet itself: a URL to /favicon.svg is cached a day
    // by the CDN without a version, and showed the old icon for hours after 0.5.0 (12.11).
    const css = ['style.css', 'docs.css'].map((f) => fs.readFileSync(new URL('./stocks-web/' + f, import.meta.url), 'utf8'))
    check('...and the brand marks carry it inline, never as an unversioned file', css.every((s) => !/url\("?favicon\.svg/.test(s)) && css.every((s) => [...s.matchAll(/data:image\/svg\+xml,([^"]+)"/g)].some((m) => decodeURIComponent(m[1]).includes('M0 8h6V6h4v2h6v1H9V7H7v2H0z'))))
    const png = Buffer.from(await (await g('/stocks/logo.png')).arrayBuffer())
    check('...and its PNG is 512 px', png.readUInt32BE(16) === 512 && png.readUInt32BE(20) === 512)
  }

  const llms = await (await g('/stocks/llms.txt')).text()
  check('llms.txt starts an agent at the MCP server, the HTTP API, the guard and the full text', /## Start here\n\n- \[MCP server\]\(https:\/\/proofofstock\.xyz\/mcp\)/.test(llms) && /\[HTTP API\]\(https:\/\/proofofstock\.xyz\/docs\/reference\/http-api\.md\)/.test(llms) && /@proofofstock\/guard/.test(llms) && /\[Every page in one file\]\(https:\/\/proofofstock\.xyz\/llms-full\.txt\)/.test(llms) && /hello@proofofstock\.xyz/.test(llms))
  await app.stop()

  const other = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {}, publicOrigin: 'https://example.test', publicPath: '/x' })
  const { port: po } = await other.start(0, '127.0.0.1')
  const r2 = await (await fetch(`http://127.0.0.1:${po}/stocks/robots.txt`)).text()
  const s2 = await (await fetch(`http://127.0.0.1:${po}/stocks/sitemap.xml`)).text()
  check('robots.txt and the sitemap follow the public origin and path', /^Disallow: \/x\/api\/$/m.test(r2) && /^Sitemap: https:\/\/example\.test\/x\/sitemap\.xml$/m.test(r2) && /<loc>https:\/\/example\.test\/x\/docs\/<\/loc>/.test(s2) && !s2.includes('proofofstock.xyz/'))
  await other.stop()
}

console.log('source link')
{
  const GH = 'https://github.com/proofofstock/proof-of-stock'
  const pages = async (opts) => {
    const app = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {}, ...opts })
    const { port } = await app.start(0, '127.0.0.1')
    const home = await (await fetch(`http://127.0.0.1:${port}/stocks/`)).text()
    const doc = await (await fetch(`http://127.0.0.1:${port}/stocks/docs/`, { headers: { accept: 'text/html' } })).text()
    await app.stop()
    return { home, doc }
  }
  // Explicit, so the check holds whatever package.json says; the default follows package.json (checked below).
  const hidden = await pages({ source: null })
  check('while the repository is private, no page links to it (no GitHub 404 for a visitor)', !hidden.home.includes('github.com') && !hidden.doc.includes('github.com') && !hidden.home.includes('<!--source-->'))
  const shown = await pages({ source: GH })
  check('once it is public, the footer and the docs link to the source', shown.home.includes(`href="${GH}"`) && shown.doc.includes(`href="${GH}"`))
  {
    // The bottom of every page: X, Telegram, GitHub, in that order and nothing after them (owner, 12.11).
    const icons = (html, cls) => [...html.matchAll(new RegExp(`<a class="${cls}" href="([^"]+)"`, 'g'))].map((m) => m[1])
    const order = JSON.stringify(['https://x.com/proofofstock', 'https://t.me/proofofstock1', GH])
    const foot = (shown.home.match(/<footer class="foot">[\s\S]*?<\/footer>/) || [''])[0]
    check('the site: X, Telegram and GitHub are the last thing in the footer, not in the link row', JSON.stringify(icons(foot, 'foot-ic')) === order && /<\/span>\s*<\/span>\s*<\/div>\s*<\/footer>/.test(foot) && !/foot-link[^>]*github/.test(foot) && foot.lastIndexOf('foot-ic') > foot.indexOf('foot-bottom'))
    const dfoot = (shown.doc.match(/<footer class="dx-foot">[\s\S]*?<\/footer>/) || [''])[0]
    check('the docs: the same three icons at the bottom, each named for a screen reader', JSON.stringify(icons(dfoot, 'dx-ic')) === order && (dfoot.match(/aria-label="Proof of Stock[^"]*"><span class="i i-(x|tg|gh)" aria-hidden="true">/g) || []).length === 3)
    check('...and while private, the docs show X and Telegram only', JSON.stringify(icons((hidden.doc.match(/<footer class="dx-foot">[\s\S]*?<\/footer>/) || [''])[0], 'dx-ic')) === JSON.stringify(['https://x.com/proofofstock', 'https://t.me/proofofstock1']))
  }
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const byDefault = await pages({})
  const want = pkg.stp?.source_public === true ? pkg.repository.url : null
  check('by default the link follows package.json (stp.source_public, repository.url)', want ? byDefault.home.includes(`href="${want}"`) : !byDefault.home.includes('github.com'))
}

console.log('publishing')
{
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const srv = JSON.parse(fs.readFileSync(path.join(repo, 'server.json'), 'utf8'))
  check('server.json carries the same version as package.json', srv.version === pkg.version)
  check('server.json points the registry at the public MCP endpoint', srv.remotes?.[0]?.type === 'streamable-http' && srv.remotes[0].url === 'https://proofofstock.xyz/mcp')
  const guard = JSON.parse(fs.readFileSync(path.join(repo, 'packages/proofofstock-guard/package.json'), 'utf8'))
  check('the guard is publishable under MIT with its licence file', !guard.private && guard.license === 'MIT' && guard.files.includes('LICENSE') && fs.existsSync(path.join(repo, 'packages/proofofstock-guard/LICENSE')))
}

console.log('deployment')
{
  const unit = fs.readFileSync(new URL('../deployment/systemd/stp-web.service', import.meta.url), 'utf8')
  const vhost = fs.readFileSync(new URL('../deployment/nginx/proofofstock.xyz.conf', import.meta.url), 'utf8')
  check('the unit runs this app from the deployed release, on loopback', /WorkingDirectory=\/opt\/stp\/current/.test(unit) && /apps\/stocks-web\.mjs/.test(unit) && /STOCKS_WEB_HOST=127\.0\.0\.1/.test(unit))
  check('the unit and the vhost agree on the port', /STOCKS_WEB_PORT=3005/.test(unit) && /proxy_pass http:\/\/127\.0\.0\.1:3005\/stocks\/;/.test(vhost))
  check('the vhost is public: no auth_basic directive', !/^\s*auth_basic\s/m.test(vhost))
  check('the vhost passes the client as X-Real-IP and clears X-Forwarded-For, cookies and auth', /X-Real-IP \$remote_addr/.test(vhost) && /X-Forwarded-For ""/.test(vhost) && /Cookie ""/.test(vhost) && /Authorization ""/.test(vhost))
  check('the domain root is the app\'s /stocks/, and dot-files are refused', /location \/ \{\s*limit_except GET HEAD \{ deny all; \}\s*proxy_pass http:\/\/127\.0\.0\.1:3005\/stocks\/;/.test(vhost) && /location ~ \/\\\. \{ return 404; \}/.test(vhost))
  check('the vhost sends /mcp to the app, which answers GET and DELETE with 405 and an oversized body with its own 413', /location = \/mcp \{\s*limit_except GET POST OPTIONS DELETE \{ deny all; \}\s*[^}]*?client_max_body_size 32k;\s*proxy_pass http:\/\/127\.0\.0\.1:3005\/stocks\/mcp;/.test(vhost))
  check('www, the older names and plain http go to https://proofofstock.xyz', (vhost.match(/return 301 https:\/\/proofofstock\.xyz\$request_uri;/g) || []).length === 4 && /server_name tickerproof\.xyz www\.tickerproof\.xyz;/.test(vhost) && /server_name stockofproof\.xyz www\.stockofproof\.xyz;/.test(vhost))
  check('the older names still serve /mcp in place: a redirected POST is not followed', (vhost.match(/proxy_pass http:\/\/127\.0\.0\.1:3005\/stocks\/mcp;/g) || []).length === 3)
  check('the vhost allows GET and HEAD only, and rate limits', /limit_except GET HEAD \{ deny all; \}/.test(vhost) && /limit_req zone=stocks_req56/.test(vhost))
  check('every server block hides the nginx version on its own error pages', (vhost.match(/^server \{/gm) || []).length === (vhost.match(/^    server_tokens off;/gm) || []).length && /server_tokens off;/.test(vhost))
  check('security.txt is served though dot-paths are refused: an exact location, before the rule', vhost.indexOf('location = /.well-known/security.txt') > 0 && vhost.indexOf('location = /.well-known/security.txt') < vhost.indexOf('location ~ /\\. { return 404; }') && /proxy_pass http:\/\/127\.0\.0\.1:3005\/stocks\/\.well-known\/security\.txt;/.test(vhost))
  // Each server block on 443, up to the next server block.
  const servers443 = vhost.split(/\nserver \{/).filter((b) => /listen 443 ssl;/.test(b))
  const serving = servers443.filter((b) => /proxy_pass/.test(b))
  check('the vhost keys its limits by an IPv6 /56, like the app, through one map', /map \$binary_remote_addr \$stocks_client \{\s*"~\^\(\?s\)\(\?<stocks_v6_56>\.\{7\}\)\.\{9\}\$" \$stocks_v6_56;\s*default \$binary_remote_addr;\s*\}/.test(vhost) && /limit_req_zone \$stocks_client zone=stocks_req56/.test(vhost) && /limit_conn_zone \$stocks_client zone=stocks_conn56/.test(vhost) && !/_zone \$binary_remote_addr/.test(vhost))
  check('every server that reaches the app limits requests and connections', serving.length === 3 && serving.every((b) => /limit_req zone=stocks_req56/.test(b) && /limit_conn stocks_conn56 \d+;/.test(b) && /limit_conn_status 429;/.test(b)))
  check('every https server sends HSTS', servers443.length === 4 && servers443.every((b) => /add_header Strict-Transport-Security "max-age=\d{7,}" always;/.test(b)))
  check('the unit hides other processes and keeps its files private', /^ProtectProc=invisible$/m.test(unit) && /^UMask=0077$/m.test(unit))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
