// scripts/agent-test-check.test.mjs: the agent test receipt checker (docs/agent-test-tz.md v3 §6), its exit codes and
// what it refuses. The network is a fake: the receipt is served from a store made here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { checkAgentTestReceipt, EXIT } from './agent-test-check.mjs'
import { createAgentTest } from '../apps/stocks-agent-test.mjs'
import { canonicalRegistry, registryHash } from '../evm/core/stocks/history.mjs'
import { jcs } from '../evm/core/stocks/agent-test.mjs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const A = (s) => '0x' + hex(s).slice(0, 40)
const CBA = (s) => '0xb2' + '0'.repeat(22) + hex(s).slice(0, 16)
const T = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'NFLX', 'ORCL', 'INTC', 'AMD']
const L = (raw) => { const canonical = canonicalRegistry(raw); return { canonical, registry_hash: registryHash(canonical) } }
const SRC = {
  lists: {
    base: L([...T.map((x) => ({ issuer: 'coinbase', address: CBA(x), symbol: x + 'c', name: x + ' Inc.', isin: 'US' + x, supplied: true, paused: [] })), { issuer: 'coinbase', address: CBA('ONLYB'), symbol: 'ONLYBc', name: 'Only Base Co', isin: 'USONLYB', supplied: true, paused: [] }]),
    robinhood: L([...T.map((x) => ({ issuer: 'robinhood', address: A(x), symbol: x, name: x + ' • Robinhood Token', isin: 'US' + x, supplied: true, paused: [] })), { issuer: 'robinhood', address: A('ONLYR'), symbol: 'ONLYR', name: 'Only Robinhood Co • Robinhood Token', isin: 'USONLYR', supplied: true, paused: [] }]),
  },
  held: { base: [], robinhood: [] }, lookalikes: { base: [{ address: A('fake-nvda'), ticker: 'NVDA' }], robinhood: [{ address: A('fake-tsla'), ticker: 'TSLA' }] }, pairTokens: { base: [], robinhood: [] },
}
const companies = JSON.parse(fs.readFileSync(new URL('../evm/core/stocks/agent-test-companies.json', import.meta.url), 'utf8'))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-check-'))
const at = createAgentTest({ dir, now: () => Date.parse('2026-11-26T12:00:00Z'), origin: 'https://proofofstock.xyz', inputsFor: () => SRC, companies })
const [, b] = at.start({}, 'k')
const tasks = JSON.parse(fs.readFileSync(path.join(dir, b.test_id + '.json'), 'utf8')).tasks
at.answer(b.test_id, { answer_key: b.answer_key, answers: tasks.map((t) => (t.right.address ? { n: t.n, address: t.right.address } : { n: t.n, refuse: true })) })
const file = at.read(b.test_id)[1]
const served = (body, status = 200) => async (url, init) => {
  if (init?.redirect !== 'error') throw new Error('the checker must refuse redirects')
  if (!String(url).startsWith('https://proofofstock.xyz/api/agent-test/')) throw new Error('only our origin: ' + url)
  return new Response(body, { status })
}
const out = (r) => r.lines.join('\n')

console.log('online (step 1 and the replay)')
{
  const r = await checkAgentTestReceipt(file, { fetchImpl: served(file) })
  check('a receipt we issued passes online: exit 0', r.code === EXIT.ok, out(r))
  check('...and says what it never proves', /Never proved here: who or what wrote the answers/.test(out(r)))
  const forged = JSON.parse(file); forged.grade.passed = !forged.grade.passed; delete forged.receipt_sha256
  forged.receipt_sha256 = hex(jcs(forged))
  const fr = await checkAgentTestReceipt(JSON.stringify(forged), { fetchImpl: served(file) })
  check('a forgery with every hash recomputed fails online: exit 1', fr.code === EXIT.failed && /differs from this file/.test(out(fr)))
  check('a receipt we no longer hold fails: exit 1', (await checkAgentTestReceipt(file, { fetchImpl: served('gone', 410) })).code === EXIT.failed)
  const down = await checkAgentTestReceipt(file, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  check('an unreachable origin proves nothing: exit 3', down.code === EXIT.unreachable && /nothing is proved/.test(out(down)))
  check('a 5xx proves nothing: exit 3', (await checkAgentTestReceipt(file, { fetchImpl: served('oops', 503) })).code === EXIT.unreachable)
  const foreign = JSON.parse(file); foreign.origin = 'https://evil.example'
  let asked = false
  const fo = await checkAgentTestReceipt(JSON.stringify(foreign), { fetchImpl: async () => { asked = true; return new Response('{}') } })
  check('a receipt naming a foreign origin is refused before any fetch', fo.code === EXIT.failed && !asked)
}

console.log('offline')
{
  const r = await checkAgentTestReceipt(file, { offline: true })
  check('offline and consistent: exit 2, never "passed"', r.code === EXIT.offline && /does not prove Proof of Stock issued it/.test(out(r)) && !/The receipt holds/.test(out(r)))
  const edited = JSON.parse(file); edited.answers[0] = edited.answers[0].refuse ? { n: edited.answers[0].n, address: A('x') } : { n: edited.answers[0].n, refuse: true }
  check('an edited answer fails offline: exit 1', (await checkAgentTestReceipt(JSON.stringify(edited), { offline: true })).code === EXIT.failed)
  check('a file that is not a receipt is refused', (await checkAgentTestReceipt('{"format":"other"}', { offline: true })).code === EXIT.failed && (await checkAgentTestReceipt('not json', { offline: true })).code === EXIT.failed)
  const reordered = JSON.parse(file)
  reordered.inputs.lists.base.canonical = reordered.inputs.lists.base.canonical.map((x) => Object.fromEntries(Object.entries(x).reverse()))
  const rr = await checkAgentTestReceipt(JSON.stringify(reordered), { offline: true })
  check('list hashes do not depend on the key order a file holds them in (only receipt_sha256 does)', rr.lines.some((l) => /^ok +list base/.test(l)), out(rr))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
