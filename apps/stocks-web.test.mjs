// apps/stocks-web.test.mjs — the public passport site: serves its page with a strict CSP, answers find and passport
// from memory, refuses anything but GET/HEAD, validates input, rate limits per client (trusting X-Real-IP only from the
// loopback proxy), says 503 until a registry is loaded, and never builds a passport from readings it does not hold.
//
// Run: node apps/stocks-web.test.mjs

import { passportLead } from './stocks-mcp-http.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb, SECURITY_HEADERS } from './stocks-web.mjs'
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

console.log('the page')
{
  const r = await get('/stocks/')
  check('the page is served', r.status === 200 && /Stock Token Passport/.test(await r.text()))
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
}

console.log('the history archive')
{
  const c = await (await get('/stocks/api/history/cases?chain=base')).json()
  check('case events come newest first with counts', c.count === 3 && c.events[0].event === 'listed' && c.counts.open === 1 && c.counts.listed === 1 && c.counts.backfilled === 1, JSON.stringify(c.counts))
  check('an event carries its evidence and how it was learned, not internals', c.events[0].imitates_symbol === 'AAPLc' && c.events[0].source === 'observed' && !('_schema_version' in c.events[0]) && !('chain_id' in c.events[0]))
  check('the archive start is the first event', c.archive_started_at === '2026-11-07T00:23:00Z')
  const f = await (await get('/stocks/api/history/cases?chain=base&event=opened&limit=1')).json()
  check('filter by event, page with a cursor', f.count === 2 && f.events.length === 1 && f.next === 1)
  const s = await (await get('/stocks/api/history/cases?chain=base&since=2026-11-08T00:00:00Z')).json()
  check('since keeps later events only', s.count === 1)
  check('a bad event, since or chain is a 400', (await get('/stocks/api/history/cases?chain=base&event=x')).status === 400 && (await get('/stocks/api/history/cases?chain=base&since=nope')).status === 400 && (await get('/stocks/api/history/cases?chain=nope')).status === 400)
  const both = await (await get('/stocks/api/history/cases')).json()
  check('without a chain, every chain answers; an empty one says so', both.chains.base.count === 3 && both.chains.robinhood.count === 0)
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
  const pp = await (await get(`/stocks/api/passport?chain=base&address=${X}`)).json()
  check('the passport carries the case too', pp.case?.status === 'open')
  const page = await get('/stocks/history')
  const html = await page.text()
  check('the history page is served with the events and the backfill marked', page.status === 200 && /registry snapshots/.test(html) && /from collector history/.test(html) && /listed by issuer/.test(html))
  check('the history page escapes names from data', !/<img src=x/.test(html))
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
  check('the passport links to DexScreener and the explorer', /^https:\/\/dexscreener\.com\/base\/0x/.test(p.links.dex) && /^https:\/\/basescan\.org\/token\/0x/.test(p.links.explorer))
  check('the passport carries its chart series', Array.isArray(p.series_points) && p.series_points.length === 2 && p.series_points[1][1] === 0.0056)
  const imp = await (await get('/stocks/api/impostors')).json()
  check('impostors: a chain with no list yet says so instead of an empty list', imp.chains.base.error && imp.chains.robinhood.error)
  const page = await (await get('/stocks/?chain=base&address=' + A)).text()
  check('a link to a registry token previews that token', /<title>NVDAc \(NVIDIA\) on Base: \+0\.56% vs the issuer&#39;s reference/.test(page) && /property="og:url" content="https:\/\/proofofstock.xyz\/\?base=NVDAc"/.test(page))
  const plain = await (await get('/stocks/?chain=base&address=%22%3E%3Cscript%3E')).text()
  const short = await (await get('/stocks/?base=nvdac')).text()
  check('the short link ?base=NVDAc previews the same token, case-insensitively', /<title>NVDAc \(NVIDIA\) on Base/.test(short) && /og:url" content="https:\/\/proofofstock.xyz\/\?base=NVDAc"/.test(short))
  const unlisted = await (await get('/stocks/?chain=base&address=' + X)).text()
  check('a token outside the registry keeps its address in the link', /og:url" content="https:\/\/proofofstock.xyz\/\?chain=base&amp;address=0x(ee){20}"/.test(unlisted))
  check('a link with a junk address previews the site, and nothing from the link reaches the page', /<title>Stock Token Passport<\/title>/.test(plain) && !plain.includes('<script>'))
  const st = await (await get('/stocks/api/status')).json()
  check('status says what is held per chain', st.base.registry_records === 1 && st.base.readings_tokens === 1 && st.robinhood.readings_tokens === 0)
  check('status says when the recorder last wrote, apart from when the server last read', st.base.newest_reading_at === '2026-11-08T13:45:00.000Z' && st.base.newest_reading_age_s === 900 && st.robinhood.newest_reading_at === null)
  const long = await (await get(`/stocks/api/passport?chain=base&address=${A}&hours=500`)).json()
  check('a window longer than the server holds is cut to what it holds', long.series.window_h === 72)
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
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })).json()
  check('initialize answers the version the client asked for, when supported', init.result.protocolVersion === '2025-03-26' && init.result.capabilities.tools && /not advice: https:\/\/proofofstock.xyz\/docs\/legal\.md/.test(init.result.instructions))
  const odd = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json()
  check('...and its own latest when the asked version is unknown', odd.result.protocolVersion === '2025-06-18')
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  check('a notification is 202 with no body', note.status === 202 && (await note.text()) === '')
  const list = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()
  check('six read-only tools, none of them trading', list.result.tools.length === 6 && !list.result.tools.some((t) => /buy|sell|swap|trade/.test(t.name)))
  check('the passport tool offers only the hours the site holds', list.result.tools.find((t) => t.name === 'stock_passport').inputSchema.properties.hours.maximum === 72)
  check('a protocol version header this server does not speak is 400', (await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status === 400)
  check('...a supported one is served', (await rpc({ jsonrpc: '2.0', id: 10, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' })).status === 200)
  const find = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find_stock_token', arguments: { chain: 'base', query: 'nvda' } } })).json()
  check('find answers from memory, as text and as structured content', find.result.structuredContent.matches[0].address === A && JSON.parse(find.result.content[1].text).matches.length === 1)
  check('...its first block is the count in words, the second the JSON alone', /^1 issuer-listed token on Base has exactly the ticker or ISIN "nvda": NVDAc\.$/.test(find.result.content[0].text) && find.result.structuredContent.summary === find.result.content[0].text, find.result.content[0].text.slice(0, 80))
  const listed = await (await rpc({ jsonrpc: "2.0", id: 11, method: 'tools/call', params: { name: 'list_stock_tokens', arguments: { chain: 'base' } } })).json()
  const lead = listed.result.content[0].text
  check('the registry list states its exact count first, and the count matches the list', /^The Coinbase registry on Base lists 1 token \(count: 1\)\. Of them, 1 is minted on this chain and 1 has an issuer reference price\./.test(lead) && listed.result.structuredContent.count === listed.result.structuredContent.tokens.length, lead)
  check('...and says impostors are not part of it', /imitate these are a separate list/.test(lead))
  const pass = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'stock_passport', arguments: { chain: 'base', address: A } } })).json()
  check('the passport tool returns the same passport as the page', pass.result.structuredContent.in_registry === true && pass.result.structuredContent.links.explorer.startsWith('https://basescan.org/token/'))
  check('...opening with the verdict, the numbers and their true ages', /^ISSUER-LISTED: NVDAc on Base is in the Coinbase registry\. Issuer reference \$180 per token, 41 h old\. Deepest on-chain price \$181, \+0\.56% against the reference, read 15 min ago\./.test(pass.result.content[0].text), pass.result.content[0].text.slice(0, 220))
  const fake = await (await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'stock_passport', arguments: { chain: 'base', address: X } } })).json()
  check('an impostor\'s passport opens with NOT and names the official contract', /^NOT an issuer token: 0x(ee){20} is not in the issuer registry on Base; its symbol or name imitates NVDAc \(official contract 0x(aa){20}\)\./.test(fake.result.content[0].text), fake.result.content[0].text.slice(0, 200))
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
  await down.stop()
}

console.log('the public address')
{
  const app4 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
  const { port: p4 } = await app4.start(0, '127.0.0.1')
  const page = await (await fetch(`http://127.0.0.1:${p4}/stocks/`)).text()
  await app4.stop()
  check('the page shows the MCP URL of the public origin, three times, and no placeholder is left', (page.match(/https:\/\/proofofstock.xyz\/mcp/g) || []).length === 3 && !page.includes('__MCP_URL__'))
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
  check('llms.txt is a markdown index with sections, links and one line each', /^# Stock Token Passport/.test(llms) && /## Tutorials\n\n- \[Connect\]\(https:\/\/x\.test\/docs\/tutorials\/a\.md\): Connect an agent in five minutes\./.test(llms) && /Version 9\.9\.9/.test(llms), llms)
  const app7 = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
  const { port: p7 } = await app7.start(0, '127.0.0.1')
  const g7 = (u) => fetch(`http://127.0.0.1:${p7}${u}`)
  const lt = await g7('/stocks/llms.txt')
  const full = await (await g7('/stocks/llms-full.txt')).text()
  check('llms-full.txt has no relative link: each is absolute against its own page', !/\]\((?!https?:|mailto:)[^)\s]+\)/.test(full) && /\]\(https:\/\/[^)]+\/docs\/reference\/[a-z-]+\.md/.test(full))
  check('/llms.txt is served as text', lt.status === 200 && /text\/plain/.test(lt.headers.get('content-type')) && /^# Stock Token Passport/.test(await lt.text()))
  check('/docs/ serves the index and a missing page is a 404', (await g7('/stocks/docs/')).status === (docs.has('README.md') ? 200 : 404) && (await g7('/stocks/docs/nope.md')).status === 404)
  check('no path escapes the docs', (await g7('/stocks/docs/..%2f..%2fpackage.json')).status === 404 && (await g7('/stocks/docs/../package.json')).status !== 200)
  const page = await (await g7('/stocks/')).text()
  check('the page shows the version from package.json', page.includes('v' + JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version) && !page.includes('__VERSION__'))
  check('...with its release date from the changelog and the rights line', /v\d+\.\d+\.\d+ · \d{1,2} [A-Z][a-z]{2} \d{4}/.test(page) && !page.includes('__RELEASED__') && /© 2026 Stock Token Passport\. All rights reserved\./.test(page))
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
  check('/status is a page for people, with plain words per chain', page.status === 200 && /text\/html/.test(page.headers.get('content-type')) && /Base/.test(html) && /Price readings/.test(html) && /updated /.test(html) && (html.match(/<script/g) || []).length === 1 && /<script src="beacon\.js\?v=[0-9a-f]{12}" defer><\/script>/.test(html))
  check('/api/status still answers JSON for code, now with the impostor list age', typeof (await (await fetch(`http://127.0.0.1:${p8}/stocks/api/status`)).json()).base.impostors_age_s !== 'undefined')
  const doc = await fetch(`http://127.0.0.1:${p8}/stocks/docs/`, { headers: { accept: 'text/html' } })
  const dh = await doc.text()
  check('a browser gets the docs as a page with the catalogs, not markdown', /text\/html/.test(doc.headers.get('content-type')) && /class="cats"/.test(dh) && /class="dx-side"/.test(dh))
  // The only scripts: the self-hosted search (script-src 'self') and its JSON index, which a browser does not execute.
  const scripts = dh.match(/<script[^>]*>/g) || []
  check('the docs page runs no inline script, only the self-hosted search and counter', scripts.length === 3 && scripts.every((t) => /src="[./]*(docs|beacon)\.js\?v=/.test(t) || /type="application\/json"/.test(t)))
  const tools = await (await fetch(`http://127.0.0.1:${p8}/stocks/docs/reference/tools.md`, { headers: { accept: 'text/html' } })).text()
  check('a tool heading renders as a signature card', /<h2 id="find_stock_token" class="fn"><span class="fn-kind">tool<\/span>/.test(tools) || /class="fn"><span class="fn-kind">tool/.test(tools))
  const js = await fetch(`http://127.0.0.1:${p8}/stocks/docs.js`)
  check('the search script is served as JavaScript', js.status === 200 && /javascript/.test(js.headers.get('content-type')))
  const md = await fetch(`http://127.0.0.1:${p8}/stocks/docs/?format=md`, { headers: { accept: 'text/html' } })
  check('?format=md and non-browser clients still get the markdown', /text\/markdown/.test(md.headers.get('content-type')) && /text\/markdown/.test((await fetch(`http://127.0.0.1:${p8}/stocks/docs/`)).headers.get('content-type')))
  await app8.stop()
}

console.log('source link')
{
  const GH = 'https://github.com/Coconatrm/stock-token-passport'
  const pages = async (opts) => {
    const app = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {}, ...opts })
    const { port } = await app.start(0, '127.0.0.1')
    const home = await (await fetch(`http://127.0.0.1:${port}/stocks/`)).text()
    const doc = await (await fetch(`http://127.0.0.1:${port}/stocks/docs/`, { headers: { accept: 'text/html' } })).text()
    await app.stop()
    return { home, doc }
  }
  const hidden = await pages({})
  check('while the repository is private, no page links to it (no GitHub 404 for a visitor)', !hidden.home.includes('github.com') && !hidden.doc.includes('github.com') && !hidden.home.includes('<!--source-->'))
  const shown = await pages({ source: GH })
  check('once it is public, the footer and the docs link to the source', shown.home.includes(`href="${GH}"`) && shown.doc.includes(`href="${GH}"`) && /Source on GitHub/.test(shown.doc))
}

console.log('publishing')
{
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const srv = JSON.parse(fs.readFileSync(path.join(repo, 'server.json'), 'utf8'))
  check('server.json carries the same version as package.json', srv.version === pkg.version)
  check('server.json points the registry at the public MCP endpoint', srv.remotes?.[0]?.type === 'streamable-http' && srv.remotes[0].url === 'https://proofofstock.xyz/mcp')
  const guard = JSON.parse(fs.readFileSync(path.join(repo, 'packages/stockofproof-guard/package.json'), 'utf8'))
  check('the guard is publishable under MIT with its licence file', !guard.private && guard.license === 'MIT' && guard.files.includes('LICENSE') && fs.existsSync(path.join(repo, 'packages/stockofproof-guard/LICENSE')))
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
  check('the vhost allows GET and HEAD only, and rate limits', /limit_except GET HEAD \{ deny all; \}/.test(vhost) && /limit_req zone=stocks_req/.test(vhost))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
