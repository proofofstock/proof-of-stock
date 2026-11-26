// apps/agent-test-routes.test.mjs: the agent test's routes and store (docs/agent-test-tz.md v3 §2, §5). Synthetic lists.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAgentTest, STARTS_PER_HOUR, UNGRADED_GRACE_MS, NOT_PASSED_KEEP_MS } from './stocks-agent-test.mjs'
import { canonicalRegistry, registryHash } from '../evm/core/stocks/history.mjs'
import { checkReceiptOffline, ANSWER_WINDOW_MS } from '../evm/core/stocks/agent-test.mjs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const A = (s) => '0x' + hex(s).slice(0, 40)
const CBA = (s) => '0xb2' + '0'.repeat(22) + hex(s).slice(0, 16)
const cb = (t, name) => ({ issuer: 'coinbase', address: CBA('cb' + t), symbol: t + 'c', name, isin: 'US' + t, supplied: true, paused: [] })
const rh = (t, name) => ({ issuer: 'robinhood', address: A('rh' + t), symbol: t, name: name + ' • Robinhood Token', isin: 'US' + t, supplied: true, paused: [] })
const L = (raw) => { const canonical = canonicalRegistry(raw); return { canonical, registry_hash: registryHash(canonical) } }
const MORE = ['AMZN', 'META', 'NFLX', 'ORCL', 'INTC', 'AMD', 'COIN', 'PLTR']
const BASE = [cb('AAPL', 'Apple Inc.'), cb('NVDA', 'NVIDIA Corporation'), cb('TSLA', 'Tesla, Inc.'), cb('MSFT', 'Microsoft'), cb('ONLYB', 'Only Base Co'), cb('ONLYB2', 'Second Base Co'), ...MORE.map((x) => cb(x, x + ' Holdings Corp'))]
const RH = [rh('AAPL', 'Apple'), rh('NVDA', 'NVIDIA'), rh('TSLA', 'Tesla'), rh('MSFT', 'Microsoft'), rh('ONLYR', 'Only Robinhood Co'), rh('ONLYR2', 'Second Robinhood Co'), ...MORE.map((x) => rh(x, x + ' Holdings'))]
const companies = JSON.parse(fs.readFileSync(new URL('../evm/core/stocks/agent-test-companies.json', import.meta.url), 'utf8'))
const SRC = { lists: { base: L(BASE), robinhood: L(RH) }, held: { base: [], robinhood: [] }, lookalikes: { base: [{ address: A('fake-nvda'), ticker: 'NVDA' }], robinhood: [{ address: A('fake-tsla'), ticker: 'TSLA' }] }, pairTokens: { base: [], robinhood: [] } }

let clock = Date.parse('2026-11-26T12:00:00Z')
const mk = (o = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'))
  let fresh = true
  const at = createAgentTest({ dir, now: () => clock, origin: 'https://proofofstock.xyz', inputsFor: () => (fresh ? SRC : null), companies, ...o })
  return { at, dir, stale: () => { fresh = false } }
}
const rightAnswers = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')).tasks.map((t) => (t.right.address ? { n: t.n, address: t.right.address } : { n: t.n, refuse: true }))
const body = (json) => async () => ({ json })

console.log('start (2.1)')
{
  const { at, dir } = mk()
  const [s, b] = at.start({ label: 'My Agent' }, 'k1')
  check('a start answers 201 with an id, a key, six public tasks and the commitment', s === 201 && /^at_[0-9a-f]{32}$/.test(b.test_id) && /^ak_/.test(b.answer_key) && b.tasks.length === 6 && /^[0-9a-f]{64}$/.test(b.tasks_sha256), JSON.stringify(b).slice(0, 200))
  check('the start response carries no kind, right answer or nonce', !/kind|right|or_address|nonce/.test(JSON.stringify(b)))
  const rec = fs.readFileSync(path.join(dir, b.test_id + '.json'), 'utf8')
  check('the record holds the key only as a hash', !rec.includes(b.answer_key) && rec.includes('key_hash'))
  check('the record holds no IP, user agent or client key', !/k1|user-agent|x-real-ip|"ip"/i.test(rec))
  check('lists are stored once, by hash', fs.readdirSync(path.join(dir, 'lists')).length === 2)
  at.start({}, 'k2')
  check('a second test with the same lists adds no list file', fs.readdirSync(path.join(dir, 'lists')).length === 2)
  check('a refused label is 400', at.start({ label: 'Certified Bot' }, 'k3')[0] === 400)
  const st = mk(); st.stale()
  check('a list that is not fresh: 503, no test', st.at.start({}, 'k')[0] === 503)
  const { at: at2, dir: at2dir } = mk()
  for (let i = 0; i < STARTS_PER_HOUR; i++) at2.start({}, 'same')
  check(`the ${STARTS_PER_HOUR + 1}th start in an hour from one client is 429`, at2.start({}, 'same')[0] === 429)
  check('...another client is not affected', at2.start({}, 'other')[0] === 201)
  const ids = [at2.start({}, 'retaker'), at2.start({}, 'retaker')].map(([, x]) => x.test_id)
  const rc = ids.map((i) => JSON.parse(fs.readFileSync(path.join(at2dir, i + '.json'), 'utf8')).retake_count)
  check('retakes from one client are counted, as a number only', rc[0] === 1 && rc[1] === 2)
}

console.log('answers (2.1, 5.2)')
{
  const { at, dir } = mk()
  const [, b] = at.start({ label: 'My Agent' }, 'k')
  const id = b.test_id, good = rightAnswers(dir, id)
  check('a wrong key is 403', at.answer(id, { answer_key: 'ak_x', answers: good })[0] === 403)
  check('a malformed body is 400 and does not use the attempt', at.answer(id, { answer_key: b.answer_key, answers: good.slice(1) })[0] === 400 && !fs.existsSync(path.join(dir, id + '.graded.json')))
  const [s, g] = at.answer(id, { answer_key: b.answer_key, answers: good })
  check('the right answers pass', s === 200 && g.passed === true && g.right === 6 && g.result_url.endsWith('/agent-test/' + id))
  const [s2, g2] = at.answer(id, { answer_key: b.answer_key, answers: good.map((a) => ({ n: a.n, refuse: true })) })
  check('a second submission returns the first grade unchanged', s2 === 200 && g2.passed === true)
  clock += ANSWER_WINDOW_MS + 1000
  const [s3, g3] = at.answer(id, { answer_key: b.answer_key, answers: good })
  check('...even after the window: a lost response can be fetched again', s3 === 200 && g3.passed === true)
  clock -= ANSWER_WINDOW_MS + 1000
  const receipt = JSON.parse(at.read(id)[1])
  check('the stored file keeps the lists by reference, so a grade adds no list bytes', typeof JSON.parse(fs.readFileSync(path.join(dir, id + '.graded.json'), 'utf8')).inputs.lists.base === 'string')
  const offline = checkReceiptOffline(receipt, { registryHash })
  check('the stored receipt passes every offline check', offline.every((c) => c.ok), JSON.stringify(offline.filter((c) => !c.ok)))
  check('the label is kept on Passed', receipt.label === 'My Agent')
  check('no temp file is left behind', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')))
  // Not passed: no label kept.
  const [, b3] = at.start({ label: 'Acme Agent' }, 'k')
  at.answer(b3.test_id, { answer_key: b3.answer_key, answers: [1, 2, 3, 4, 5, 6].map((n) => ({ n, refuse: true })) })
  const r3 = JSON.parse(at.read(b3.test_id)[1])
  check('a Not passed receipt keeps no label', r3.grade.passed === false && r3.label === null)
  // Late.
  const [, b4] = at.start({}, 'k')
  clock += ANSWER_WINDOW_MS + 1000
  check('an answer after the window is 410', at.answer(b4.test_id, { answer_key: b4.answer_key, answers: rightAnswers(dir, b4.test_id) })[0] === 410)
  check('...and the read is 410', at.read(b4.test_id)[0] === 410)
  clock -= ANSWER_WINDOW_MS + 1000
}

console.log('parallel submissions publish one grade')
{
  const { at, dir } = mk()
  const [, b] = at.start({}, 'k')
  // Another grader won the link a moment earlier: this one must return that grade, not its own.
  const winner = { test_id: b.test_id, grade: { passed: false, right: 0, of: 6, sentences: [] } }
  fs.writeFileSync(path.join(dir, b.test_id + '.graded.json'), JSON.stringify(winner))
  const [s, g] = at.answer(b.test_id, { answer_key: b.answer_key, answers: rightAnswers(dir, b.test_id) })
  check('a submission that finds a grade already published returns that grade, not its own', s === 200 && g.passed === false)
  check('...and leaves no temp file', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')))
}

console.log('routes by state (2.4)')
{
  const { at, dir } = mk()
  const [, b] = at.start({}, 'k')
  const [s, r] = at.read(b.test_id)
  check('an ungraded test in its window reads as tasks only', s === 200 && r.tasks.length === 6 && !/kind|right|nonce/.test(JSON.stringify(r)))
  check('its result is not served before grading', at.result(b.test_id).status === 404)
  at.answer(b.test_id, { answer_key: b.answer_key, answers: rightAnswers(dir, b.test_id) })
  const [s2, raw, isRaw] = at.read(b.test_id)
  check('a graded test reads as the receipt, the same bytes every time', s2 === 200 && isRaw && Buffer.compare(raw, at.read(b.test_id)[1]) === 0 && JSON.parse(raw).inputs.lists.base.canonical.length > 0)
  check('hide needs the key', at.hide(b.test_id, { answer_key: 'ak_wrong' })[0] === 403)
  check('hidden with the key: every route is 410', at.hide(b.test_id, { answer_key: b.answer_key })[0] === 200 && at.read(b.test_id)[0] === 410 && at.result(b.test_id).status === 410)
  check('an unknown id is 404', at.read('at_' + '0'.repeat(32))[0] === 404)
  const viaHandle = await at.handle('GET', '/api/agent-test/at_../../etc/passwd', body({}), 'k')
  check('an id with path segments never reaches the disk', viaHandle === null || viaHandle[0] === 404)
  check('GET on the start route is 405', (await at.handle('GET', '/api/agent-test', body({}), 'k'))[0] === 405)
  check('POST through handle starts a test', (await at.handle('POST', '/api/agent-test', body({}), 'k'))[0] === 201)
  const hostHidden = path.join(dir, 'hidden.txt'); fs.writeFileSync(hostHidden, b.test_id + '\n')
  const { at: at2 } = mk({ hiddenFile: hostHidden })
  check('an id on the host hidden list is 410', at2.read(b.test_id)[0] === 410)
}

console.log('outside review of the code (26.11)')
{
  const { at, dir } = mk()
  const [, b] = at.start({}, 'k')
  check('an answer key that is not a string of the right form is 403, not a crash', at.answer(b.test_id, { answer_key: { toString: null }, answers: [] })[0] === 403 && at.hide(b.test_id, { answer_key: 42 })[0] === 403)
  for (let i = 0; i < 25; i++) at.answer(b.test_id, { answer_key: 'ak_' + '0'.repeat(64), answers: [] }, 'attacker')
  check('wrong-key floods from one client do not block the key holder', at.answer(b.test_id, { answer_key: b.answer_key, answers: rightAnswers(dir, b.test_id) }, 'owner')[0] === 200)
  check('...the flooding client is limited', at.answer(b.test_id, { answer_key: b.answer_key, answers: [] }, 'attacker')[0] === 429)
  fs.rmSync(path.join(dir, b.test_id + '.json'))
  check('a receipt left without its record is not served', at.result(b.test_id).status === 404)
  at.sweep()
  check('...and the sweep removes it', !fs.existsSync(path.join(dir, b.test_id + '.graded.json')))
}

console.log('hide is counted with answers')
{
  const { at } = mk()
  const [, b] = at.start({}, 'k')
  for (let i = 0; i < 25; i++) at.hide(b.test_id, { answer_key: 'ak_' + '0'.repeat(64) }, 'guesser')
  check('hide guesses are limited per client', at.hide(b.test_id, { answer_key: b.answer_key }, 'guesser')[0] === 429 && at.hide(b.test_id, { answer_key: b.answer_key }, 'owner')[0] === 200)
}

console.log('retention (5.2)')
{
  const { at, dir } = mk()
  const [, ungraded] = at.start({}, 'k')
  const [, notPassed] = at.start({}, 'k')
  at.answer(notPassed.test_id, { answer_key: notPassed.answer_key, answers: [1, 2, 3, 4, 5, 6].map((n) => ({ n, refuse: true })) })
  const [, pass] = at.start({}, 'k')
  at.answer(pass.test_id, { answer_key: pass.answer_key, answers: rightAnswers(dir, pass.test_id) })
  fs.writeFileSync(path.join(dir, 'x.graded.json.ab.tmp'), 'half')
  fs.utimesSync(path.join(dir, 'x.graded.json.ab.tmp'), new Date(clock - 3600e3), new Date(clock - 3600e3))
  clock += ANSWER_WINDOW_MS + UNGRADED_GRACE_MS + 120e3
  at.sweep()
  check('an ungraded record is deleted an hour after its window', !fs.existsSync(path.join(dir, ungraded.test_id + '.json')))
  check('a stray temp file is deleted', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')))
  check('a Not passed result is kept before 90 days', fs.existsSync(path.join(dir, notPassed.test_id + '.graded.json')))
  clock += NOT_PASSED_KEEP_MS
  at.sweep()
  check('...and deleted after 90 days', !fs.existsSync(path.join(dir, notPassed.test_id + '.graded.json')))
  check('a Passed result is kept', fs.existsSync(path.join(dir, pass.test_id + '.graded.json')))
  check('a list file still referred to is kept', fs.readdirSync(path.join(dir, 'lists')).length === 2)
  clock -= ANSWER_WINDOW_MS + UNGRADED_GRACE_MS + 120e3 + NOT_PASSED_KEEP_MS
}

console.log('the disk cap (5.2)')
{
  const { at } = mk({ maxMb: 0 })
  at.start({}, 'k')
  check('over the cap after a sweep, a start is 503', at.start({}, 'k2')[0] === 503)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
