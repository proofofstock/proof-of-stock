// apps/status-usage.test.mjs: the "Used in the last 7 days" block on /status (apps/stocks-status.mjs usageOf) and the
// API rows it is built from (apps/stocks-analytics.mjs api, scripts/stocks/analytics-report.mjs summarise). It may
// count only use by others: never a browser on our own site, never our own exam or canary, and it shows nothing rather
// than zeros it never read.
//
// Run: node apps/status-usage.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { usageOf, statusPage } from './stocks-status.mjs'
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
check('with no usage the block is not on the page', !/st-use/.test(statusPage({ chains, now: 0, version: '0', assets: { css: 'a', docsCss: 'b' } })))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
