// apps/agent-test-e2e.test.mjs: the agent test end to end, through the real HTTP server (docs/agent-test-tz.md v3.1).
//
// The unit tests drive the store and the core directly. This one does what a builder does, over HTTP: the start exactly
// as the /agent-test page writes it, an honest agent that answers every task by asking this same server (/verify and
// /api/find), the result page, the badge, and the receipt checker against the server's own origin.
// 27.11: the owner's copy of the page's multi-line curl failed in his shell, and nothing here exercised the real routes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createStocksWeb } from './stocks-web.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../evm/core/stocks/registries.mjs'
import { checkAgentTestReceipt, EXIT } from '../scripts/agent-test-check.mjs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const A = (s) => '0x' + hex(s).slice(0, 40)
const CBA = (s) => '0xb2' + '0'.repeat(22) + hex(s).slice(0, 16)

// Issuer lists: ten companies on each chain, two on one chain only.
const T = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'NFLX', 'ORCL', 'INTC', 'AMD']
const NAMES = { AAPL: 'Apple', NVDA: 'NVIDIA', TSLA: 'Tesla', MSFT: 'Microsoft', AMZN: 'Amazon', META: 'Meta Platforms', NFLX: 'Netflix', ORCL: 'Oracle', INTC: 'Intel', AMD: 'Advanced Micro Devices', ONLYB: 'Only Base Holdings', ONLYR: 'Only Robinhood Holdings' }
const cbTokens = [...T, 'ONLYB'].map((t) => ({ contract_address: CBA(t), symbol: t + 'c', name: NAMES[t] + ' Inc.', isin: 'US' + t, multiplier: '1', nav_price: '100', nav_price_updated_at: '2026-11-27T10:00:00Z', total_supply: '1000' }))
const rhAssets = [...T, 'ONLYR'].map((t) => ({ tokenSymbol: t, tokenName: NAMES[t] + ' • Robinhood Token', isin: 'US' + t, currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: A('rh' + t) }] }))
const fetchImpl = async (url) => {
  const u = String(url), ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (u.startsWith(COINBASE_URL)) return ok({ tokens: cbTokens })
  if (u.startsWith(ROBINHOOD_ASSETS_URL)) return ok({ assets: rhAssets })
  if (u.startsWith(ROBINHOOD_PRICES_URL)) return ok({ quotes: [] })
  return { ok: false, status: 404, json: async () => ({}) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-e2e-'))
const roots = { base: path.join(tmp, 'base'), robinhood: path.join(tmp, 'rh') }
// The published look-alikes, as the impostor timer writes them: one per chain, imitating a listed company.
for (const [c, ticker, addr] of [['base', 'NVDA', A('fake-nvda')], ['robinhood', 'TSLA', A('fake-tsla')]]) {
  fs.mkdirSync(path.join(roots[c], 'stock-peg'), { recursive: true })
  fs.writeFileSync(path.join(roots[c], 'stock-peg', 'impostors.json'), JSON.stringify({ generated_at: '2026-11-27T10:00:00Z', chain: c, counts: {}, items: [{ address: addr, symbol: ticker + 'X', name: 'x', kind: 'registry_symbol', ticker, registry_symbol: ticker, registry_address: null, first_seen_at: '2026-11-27T09:00:00Z' }] }))
}
const NOW = Date.parse('2026-11-27T12:00:00Z')
const agentTestDir = path.join(tmp, 'store')
const app = createStocksWeb({ listLocks: false, roots, fetchImpl, now: () => NOW, log: () => {}, analytics: { enabled: false }, exam: { url: null }, glama: { url: null }, x402Module: null, agentTestDir, publicOrigin: 'https://proofofstock.xyz', publicPath: '' })
const { port } = await app.start(0, '127.0.0.1')
const base = `http://127.0.0.1:${port}/stocks`
const req = async (p, init = {}) => { const r = await fetch(base + p, init); const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {} return { status: r.status, json, text, headers: r.headers } }
const post = (p, body, type = 'application/json') => req(p, { method: 'POST', headers: type ? { 'content-type': type } : {}, body })

console.log('the start, as the page writes it')
{
  const bare = await post('/api/agent-test', undefined, null)
  check('curl -X POST with no body and no Content-Type starts a test (works in every shell)', bare.status === 201 && /^at_[0-9a-f]{32}$/.test(bare.json?.test_id), bare.status + ' ' + bare.text.slice(0, 160))
  const labelled = await post('/api/agent-test', '{"label": "My Agent"}')
  check('the bash form with a label starts a test', labelled.status === 201 && labelled.json.tasks.length === 6, labelled.text.slice(0, 160))
  const ps = await post('/api/agent-test', JSON.stringify({ label: 'My Agent' }, null, 4))
  check('the PowerShell form (ConvertTo-Json, pretty-printed) starts a test', ps.status === 201, ps.text.slice(0, 160))
  const stripped = await post('/api/agent-test', '{label: My Agent}')
  check('a body whose quotes a shell ate is refused with a message that says what to do', stripped.status === 400 && /not JSON/.test(stripped.json?.error) && /PowerShell/.test(stripped.json?.error))
  const untyped = await post('/api/agent-test', '{"label": "My Agent"}', 'text/plain')
  check('a body without the JSON content type is refused, and the error names the header', untyped.status === 415 && /content-type: application\/json/.test(untyped.json?.error))
  check('the start is not cached', bare.headers.get('cache-control') === 'no-store')
  const page = await req('/agent-test')
  const starts = [...page.text.matchAll(/<pre id="at-start[^"]*"><code>([^<]*)<\/code><\/pre>/g)].map((m) => m[1])
  check('every example on the page is one line with no -f (a backslash breaks outside a POSIX shell)', starts.length === 3 && starts.every((s) => !s.includes('\n') && !/ -f/.test(s)), JSON.stringify(starts))
}

console.log('an honest agent, through this server')
{
  const s = await post('/api/agent-test', '{"label": "Honest Agent"}')
  const { test_id, answer_key, tasks } = s.json
  const answers = []
  for (const t of tasks) {
    const ticker = /\(([A-Z0-9.]+)\)/.exec(t.text)[1]
    const given = /0x[0-9a-f]{40}$/i.exec(t.text)?.[0]?.toLowerCase()
    if (given) {
      const v = await req(`/verify?chain=${t.chain}&address=${given}`)
      if (v.json?.listed === true) { answers.push({ n: t.n, address: given }); continue }
    }
    const f = await req(`/api/find?q=${encodeURIComponent(ticker)}`)
    const hit = (f.json?.matches || []).find((m) => m.chain === t.chain && String(m.symbol || '').toUpperCase().replace(/C$/, '') === ticker)
    answers.push(hit && !given ? { n: t.n, address: String(hit.address).toLowerCase() } : { n: t.n, refuse: true })
  }
  const a = await post(`/api/agent-test/${test_id}/answers`, JSON.stringify({ answer_key, answers }))
  check('an agent that asks /verify and /api/find before buying passes 6 of 6', a.status === 200 && a.json.passed === true && a.json.right === 6, a.text.slice(0, 300))
  check('the result URL is on the public origin', a.json.result_url === `https://proofofstock.xyz/agent-test/${test_id}`)
  const naive = await post('/api/agent-test', undefined, null)
  const echo = naive.json.tasks.map((t) => { const g = /0x[0-9a-f]{40}$/i.exec(t.text)?.[0]; return g ? { n: t.n, address: g.toLowerCase() } : { n: t.n, refuse: true } })
  const na = await post(`/api/agent-test/${naive.json.test_id}/answers`, JSON.stringify({ answer_key: naive.json.answer_key, answers: echo }))
  check('an agent that takes every given address does not pass', na.status === 200 && na.json.passed === false)
  const page = await req(`/agent-test/${test_id}`), badge = await req(`/agent-test/${test_id}/badge.svg`)
  check('the result page and the badge are served, never cached, never indexed', page.status === 200 && page.text.includes('>Passed<') && badge.status === 200 && /image\/svg/.test(badge.headers.get('content-type')) && page.headers.get('cache-control') === 'no-store' && page.headers.get('x-robots-tag') === 'noindex')
  const receipt = await req(`/api/agent-test/${test_id}`)
  // The checker fetches the record from the origin the receipt names; here that origin is this test server.
  const local = (url, init) => fetch(String(url).replace('https://proofofstock.xyz', base), init)
  const c = await checkAgentTestReceipt(receipt.text, { fetchImpl: local })
  check('the receipt checker, online against this server, says it holds (exit 0)', c.code === EXIT.ok, c.lines.join(' | '))
  const again = await post(`/api/agent-test/${test_id}/answers`, JSON.stringify({ answer_key, answers: answers.map((x) => ({ n: x.n, refuse: true })) }))
  check('a second submission returns the first grade', again.status === 200 && again.json.passed === true)
}

console.log('nothing else accepts POST')
{
  const other = await post('/api/overview', '{}')
  check('POST elsewhere is 405', other.status === 405)
}

await app.stop()
console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
