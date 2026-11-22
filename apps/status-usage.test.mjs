// apps/status-usage.test.mjs: the "Used in the last 7 days" block on /status (apps/stocks-status.mjs usageOf) and the
// API rows it is built from (apps/stocks-analytics.mjs api, scripts/stocks/analytics-report.mjs summarise). It may
// count only use by others: never a browser on our own site, never our own exam or canary, and it shows nothing rather
// than zeros it never read.
//
// Run: node apps/status-usage.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { usageOf, statusPage, appsSentenceHtml, withApps, namesPhrase } from './stocks-status.mjs'
import { createAnalytics, IGNORE_UA, API_CLIENT } from './stocks-analytics.mjs'
import { summarise } from '../scripts/stocks/analytics-report.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

console.log('the rows')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-usage-'))
  const a = createAnalytics({ dir, now: () => Date.parse('2026-11-19T12:00:00Z'), log: () => {}, interfaces: () => ({}) })
  const ip = '203.0.113.7'
  a.api(ip, { 'user-agent': 'proofofstock-guard/0.2.1' }, 'verify', 1)
  a.api(ip, { 'user-agent': 'bankr-skill-proof-of-stock/1' }, 'find', 1)
  a.api('198.51.100.2', { 'user-agent': 'python-requests/2.31' }, 'verify', 12)
  a.api(ip, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' }, 'find', 1)
  a.api(ip, { 'user-agent': 'proofofstock-exam' }, 'verify', 50)
  a.api(ip, { 'user-agent': 'proofofstock-canary/1' }, 'verify', 1)
  a.api(ip, { 'user-agent': 'curl/8' }, 'hit', 1)
  a.api(ip, { 'user-agent': 'curl/8' }, 'verify', 999)
  const rows = fs.readFileSync(path.join(dir, 'hits-2026-11-19.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  check('a program calling a data route leaves one row with the route, the count and our client\'s name', rows.length === 4 && rows[0].route === 'verify' && rows[0].client === 'guard' && rows[1].client === 'bankr-skill' && rows[2].n === 12 && rows[2].client === null, JSON.stringify(rows.map((r) => [r.route, r.n, r.client])))
  check('...never a browser, our own exam or canary, or a route that is not a data route', !rows.some((r) => /Mozilla/.test(JSON.stringify(r))) && IGNORE_UA.test('proofofstock-exam') && IGNORE_UA.test('proofofstock-canary/1') && !rows.some((r) => r.route === 'hit'))
  check('...and a batch count is capped at the batch limit, never the address itself', rows[3].n === 50 && !JSON.stringify(rows).includes('0x') && !('address' in rows[0]))
  check('our clients are named by their user agent only', API_CLIENT('proofofstock-guard/0.3.0') === 'guard' && API_CLIENT('bankr-skill-proof-of-stock/1') === 'bankr-skill' && API_CLIENT('my-guard') === null)
  const s = summarise(rows)
  check('the day\'s summary counts calls, distinct programs and addresses checked', s.api_requests === 4 && s.api_clients === 4 && s.api_checks === 63 && s.api_named_clients.some(([k, v]) => k === 'guard' && v === 1), JSON.stringify({ r: s.api_requests, c: s.api_clients, k: s.api_checks }))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('the block')
const sum = (over) => ({ people: 3, mcp_use_agents: 2, mcp_clients: 40, api_requests: 10, api_clients: 2, api_checks: 25, mcp_calls: [['initialize', 30], ['tools/list', 25], ['tools/call find_stock_token', 4], ['tools/call stock_passport', 1], ['ping', 9]], ...over })
const days = [{ day: '2026-11-13', summary: null }, { day: '2026-11-14', summary: sum() }, { day: '2026-11-15', summary: sum({ mcp_use_agents: 5, people: 1, mcp_calls: [['tools/call verify_anchor', 2]] }) }]
const u = usageOf(days)
check('agents are the ones that called a tool, summed per day; catalogues that only connected are not counted', u.agent_days === 7, JSON.stringify(u))
check('tool calls count only tools/call, never initialize, tools/list or ping', u.tool_calls === 7)
check('API use is summed per day: calls, programs, addresses checked', u.api_requests === 20 && u.api_client_days === 4 && u.api_checks === 50)
check('people are summed per day, and the days without a file are said', u.people_days === 4 && u.days === 3 && u.days_with_data === 2)
check('no counter file at all shows nothing, never zeros', usageOf([{ day: 'x', summary: null }]) === null && usageOf(null) === null)

const chains = { base: { registry_records: 89, registry_age_s: 10, readings_tokens: 89, newest_reading_age_s: 60, impostors_listed: 1, impostors_age_s: 60 } }
const page = statusPage({ chains, now: Date.parse('2026-11-19T12:00:00Z'), version: '0', assets: { css: 'a', docsCss: 'b' }, usage: u })
check('the page shows each number with what it is', /Used in the last 3 days/.test(page) && page.includes('<b>7</b><span>agents that called an MCP tool (once a day)') && page.includes('<b>50</b><span>addresses checked through /verify') && page.includes('<b>4</b><span>people on the site'))
check('...and says what it leaves out and that these are our numbers, not onchain', page.includes('a browser is the site itself') && page.includes('our own daily exam and canary are not counted') && page.includes('not verified onchain') && page.includes('1 of the days have no counter file'))
// The apps that named themselves (owner, 22.11): counted over the window, back on two days or more, and only names we
// recognise are printed: a client may send any name, and a stranger's word never reaches our page.
console.log('apps that named themselves')
{
  const day = (mcp, api = []) => ({ people: 0, mcp_use_agents: 1, mcp_calls: [], mcp_agent_names: mcp, api_named_clients: api })
  const w = usageOf([
    { day: '2026-11-20', summary: day([['claude-code', 2], ['(no name)', 3], ['spam-site.example', 1]]) },
    { day: '2026-11-21', summary: day([['Claude-Code', 1], ['cursor', 1], ['other', 2]], [['bankr-skill', 1]]) },
    { day: '2026-11-22', summary: null },
  ])
  check('apps are the distinct names over the window, never "(no name)" or "other", case folded', w.apps === 4, JSON.stringify(w))
  check('...back on two days or more counts a name seen on two days', w.apps_returning === 1)
  check('...the known ones by name, most days first, an unknown name counted and never named', JSON.stringify(w.apps_known) === JSON.stringify(['Claude Code', 'Bankr skill', 'Cursor']))
  const p = statusPage({ chains, now: 0, version: '0', assets: { css: 'a', docsCss: 'b' }, usage: w })
  check('/status shows both counts and the known names, and says a name is what a client says about itself', p.includes('<b>4</b><span>agent apps and integrations that named themselves') && p.includes('<b>1</b><span>of them came back on two days or more') && p.includes('Among them: Claude Code, Bankr skill and Cursor.') && p.includes('a client may call itself anything'))
  check('...and never prints a name it does not recognise', !p.includes('spam-site'))
  const sentence = appsSentenceHtml(w)
  check('the landing sentence: the window, the count, the known names, and a link to how it is counted', sentence === 'In the last 3 days, 4 agent apps and integrations called it by name, among them Claude Code, Bankr skill and Cursor. <a class="inline-link" href="status">How we count</a>', sentence)
  const page = '<h3>Ask it from your agent</h3>\n      <p class="agent-apps faint" id="agent-apps" hidden></p>'
  check('...written into the placeholder, which is no longer hidden', withApps(page, sentence).includes(`<p class="agent-apps faint" id="agent-apps">${sentence}</p>`))
  const none = usageOf([{ day: 'x', summary: day([['(no name)', 2]]) }])
  check('no app named itself: no sentence, the placeholder stays hidden, and /status shows no apps row', none.apps === 0 && appsSentenceHtml(none) === null && withApps(page, appsSentenceHtml(none)) === page && !statusPage({ chains, now: 0, version: '0', assets: { css: 'a', docsCss: 'b' }, usage: none }).includes('named themselves'))
  check('a long list ends with how many more', namesPhrase(['A', 'B', 'C', 'D', 'E', 'F']) === 'A, B, C, D and 2 more' && namesPhrase(['A']) === 'A' && namesPhrase(['A', 'B']) === 'A and B')
}

check('with no usage the block is not on the page', !/st-use/.test(statusPage({ chains, now: 0, version: '0', assets: { css: 'a', docsCss: 'b' } })))

// Paid passes (outside review, 21.11): the proof that passes are sold is the settling wallet's own transactions on
// BaseScan, not a count we keep. A paused sale says until when; payments off says so; a malformed wallet is not linked.
console.log('paid passes on /status')
const W = '0x025297a6729ea9df0bb1f75c216c2b3a9b5cbf4a'
const NOW = Date.parse('2026-11-21T12:00:00Z')
const pay = (payments) => statusPage({ chains, now: NOW, version: '0', assets: { css: 'a', docsCss: 'b' }, payments })
const on = pay({ enabled: true, settlement_wallet: W, paused_until: null, late_settlements: [] })
check('selling: the price, the pass and the settling wallet linked on BaseScan', /<h2>Paid passes<\/h2>/.test(on) && on.includes('0.01 USDC on Base buys a 10-minute pass') && on.includes(`<a href="https://basescan.org/address/${W}">0x0252…bf4a on BaseScan</a>`) && on.includes('docs/how-to/pay-per-call.md'))
const paused = pay({ enabled: true, settlement_wallet: W, paused_until: '2026-11-21T12:30:00.000Z', late_settlements: [] })
check('...paused: says until when, and that the free tier still answers', paused.includes('Selling is paused until 2026-11-21 12:30 UTC') && paused.includes('free tier answers as usual') && !paused.includes('buys a 10-minute pass'))
check('...a pause that has ended reads as selling', pay({ enabled: true, settlement_wallet: W, paused_until: '2026-11-21T11:00:00.000Z' }).includes('buys a 10-minute pass'))
check('...off says so, and links no wallet', /Off on this server/.test(pay({ enabled: false })) && !/basescan/.test(pay({ enabled: false })))
const odd = pay({ enabled: true, settlement_wallet: '"><script>x</script>', paused_until: null })
check('...a wallet that is not an address is not linked or printed', !/basescan|<script>x/.test(odd) && odd.includes('buys a 10-minute pass'))
check('...and without a payments state the block is not on the page', !/Paid passes/.test(pay(null)))

// Who settles v2 (22.11): with Coinbase's facilitator the page says those sales are not in the wallet's count, and where.
{
  const cdpPage = pay({ enabled: true, settlement_wallet: W, paused_until: null, late_settlements: [], settles_v2: 'cdp' })
  check('v2 settled by Coinbase\'s facilitator: the page says so and links our x402scan page for those sales', cdpPage.includes("Payments in x402 v2 are settled by Coinbase's x402 facilitator, so they are not in the wallet's count") && cdpPage.includes('href="https://www.x402scan.com/server/eb34ec2c-49f1-4b37-bee5-b3c86f0f79f1"'))
  check('...and says nothing of it while we settle v2 ourselves', !/facilitator/.test(pay({ enabled: true, settlement_wallet: W, paused_until: null, late_settlements: [], settles_v2: 'self' })) && !/facilitator/.test(pay({ enabled: true, settlement_wallet: W, paused_until: null, late_settlements: [] })))
}

// The sales as the chain has them (outside review, 21.11): the wallet's own count and its latest settlement, linked,
// with who paid. A purchase of our own says so; a stranger's is linked by address; nothing before the first read.
console.log('sales read from Base')
const TX = '0xf6d0e92a6f3ce3e1dbc6e2649ff6538b02b290174ae07a7436d4fe985813fc64'
const PAYER = '0x' + 'ab'.repeat(20)
const sold = (sales) => pay({ enabled: true, settlement_wallet: W, paused_until: null, late_settlements: [], sales })
const ours = sold({ settlement_transactions: 1, latest: { transaction: TX, at: '2026-11-20T11:52:15.000Z', settled: true, payer: '0x376a832d9827b157c9e7502e11af1e45c8224a88', ours: true }, read_at: '2026-11-21T11:59:00.000Z' })
check('one sale of our own: the count, the transaction linked on BaseScan, its day, and that no one else has bought one', /<b>1<\/b><span>settlement sent on Base, one per pass sold/.test(ours) && ours.includes(`<a href="https://basescan.org/tx/${TX}">0xf6d0…fc64</a> on BaseScan, 20 Nov 2026, paid by our own test wallet. No one else has bought a pass yet.`), ours.match(/Latest settlement[^<]*<a[^>]*>[^<]*<\/a>[^<]*/)?.[0])
const theirs = sold({ settlement_transactions: 3, latest: { transaction: TX, at: '2026-11-21T08:00:00.000Z', settled: true, payer: PAYER, ours: false } })
check('a customer\'s sale: the payer is linked by address, never called ours, and the count is plural', /<b>3<\/b><span>settlements sent/.test(theirs) && theirs.includes(`paid by <a href="https://basescan.org/address/${PAYER}">0xabab…abab</a>.`) && !/our own test wallet|No one else/.test(theirs))
check('...a later sale of ours after customers does not claim no one else bought', !/No one else/.test(sold({ settlement_transactions: 4, latest: { transaction: TX, at: null, settled: true, payer: PAYER, ours: true } })))
const reverted = sold({ settlement_transactions: 2, latest: { transaction: TX, at: '2026-11-21T08:00:00.000Z', settled: false, payer: null, ours: false } })
check('a settlement that reverted says it paid nothing out', reverted.includes('it was sent and reverted, so it paid nothing out') && !/paid by/.test(reverted))
check('none sold yet says so; before the first read the block shows no count at all', sold({ settlement_transactions: 0, latest: null }).includes('No pass has been sold yet.') && !/st-use-tile/.test(sold(null).split('Paid passes')[1] || '') && !/settlement sent|settlements sent/.test(sold(null)))
const forged = sold({ settlement_transactions: 1, latest: { transaction: '"><script>x</script>', settled: true, payer: '"><i>zz', ours: false } })
check('...a transaction or payer that is not one is never linked or printed', !/<script>x|<i>zz/.test(forged) && !/Latest settlement/.test(forged))

// Readings below the registry (outside review, 21.11: "90 of 415" read as 22% coverage): the row says the recorder
// reads only minted tokens and how many of the listed ones have supply; with no supply count (Robinhood) it says nothing.
console.log('readings against the registry')
const row = (o) => statusPage({ chains: { base: { registry_records: 415, registry_age_s: 10, readings_tokens: 90, newest_reading_age_s: 60, impostors_listed: 1, impostors_age_s: 60, ...o } }, now: 0, version: '0', assets: { css: 'a', docsCss: 'b' } })
check('the registry row says how many of the listed are minted, only when fewer are', row({ registry_minted: 90 }).includes('415 tokens listed, 90 minted (tradable on this chain)') && !/minted \(tradable/.test(row({ registry_minted: 415 })) && !/minted \(tradable/.test(row({ registry_minted: null })))
check('fewer readings than listed tokens: the page says only minted tokens are read, and how many have supply', row({ registry_minted: 90 }).includes('90 tokens tracked, every 15 min. Only minted tokens have a price to read: 90 of the 415 listed have supply'))
check('...every listed token minted, or no supply count: no such sentence', !/Only minted/.test(row({ registry_minted: 415 })) && !/Only minted/.test(row({ registry_minted: null })) && !/Only minted/.test(row({})))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
