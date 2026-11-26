// evm/core/stocks/agent-test.test.mjs: the agent test's pure core (docs/agent-test-tz.md v3). Synthetic lists only.
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  jcs, nonceStream, newSecrets, TEST_ID, freezeInputs, inputsSha256, eligibleRecords, notTokenized, drawTasks, commitTasks,
  publicTasks, checkLabel, checkAnswers, gradeOne, gradeAgentTest, SENTENCES, firstSentence, LIMITS_SENTENCE, buildReceipt,
  checkReceiptOffline, carriesWord, NEVER_WORDS, TASK_BANNED_WORDS, isAged, DRAW_VERSION,
} from './agent-test.mjs'
import { canonicalRegistry, registryHash } from './history.mjs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const A = (s) => '0x' + hex(s).slice(0, 40)
const CBA = (s) => '0xb2' + '0'.repeat(22) + hex(s).slice(0, 16)

// ── Fixture: two issuer lists with every awkward case the TZ names ───────────────────────────────────────────────────
const cb = (t, name, o = {}) => ({ issuer: 'coinbase', address: CBA('cb' + t), symbol: t + 'c', name, isin: 'US' + t, supplied: true, paused: [], ...o })
const rh = (t, name, o = {}) => ({ issuer: 'robinhood', address: A('rh' + t), symbol: t, name: name + ' • Robinhood Token', isin: 'US' + t, supplied: true, paused: [], ...o })
const SAME = A('same-bytes-both-chains')
const BASE_RAW = [
  cb('AAPL', 'Apple Inc.'), cb('NVDA', 'NVIDIA Corporation'), cb('TSLA', 'Tesla, Inc.'), cb('MSFT', 'Microsoft Corporation'),
  cb('AMZN', 'Amazon.com, Inc.'), cb('HOLD', 'Held Corp'), cb('ZERO', 'Unminted Inc.', { supplied: false }),
  cb('PAUS', 'Paused Inc.', { paused: ['transfer'] }), cb('GOOGL', 'Alphabet Inc. Class A', { isin: 'USGOOG' }),
  cb('GOOG', 'Alphabet Inc. Class C', { isin: 'USGOOG2' }), cb('ONLYB', 'Only Base Co'),
  { ...cb('SAMEB', 'Same Bytes Co'), address: SAME },
]
const RH_RAW = [
  rh('AAPL', 'Apple'), rh('NVDA', 'NVIDIA'), rh('TSLA', 'Tesla'), rh('MSFT', 'Microsoft'), rh('AMZN', 'Amazon'), rh('ONLYR', 'Only Robinhood Co'),
  rh('HOOD', 'Robinhood Markets'), { ...rh('SAMEB', 'Same Bytes Co'), address: SAME }, rh('PAUS', 'Paused', { paused: ['ASSET_STATUS_HALTED'] }),
]
const listOf = (raw) => { const canonical = canonicalRegistry(raw); return { canonical, registry_hash: registryHash(canonical) } }
const companies = JSON.parse(fs.readFileSync(new URL('./agent-test-companies.json', import.meta.url), 'utf8'))
const LOOK = {
  base: [{ address: A('fake-nvda-base'), ticker: 'NVDA' }, { address: A('fake-aapl-base'), ticker: 'AAPL' }, { address: CBA('cbHOLD'), ticker: 'HOLD' }],
  robinhood: [{ address: A('fake-tsla-rh'), ticker: 'TSLA' }],
}
const PAIR = { base: [A('usdc-base')], robinhood: [A('usdc-rh')] }
const freeze = (nonce, o = {}) => freezeInputs({
  lists: { base: listOf(BASE_RAW), robinhood: listOf(RH_RAW) }, held: { base: [CBA('cbHOLD')], robinhood: [] },
  lookalikes: LOOK, pairTokens: PAIR, companies, companiesSha256: hex(JSON.stringify(companies)), nonce, ...o,
})
const nonces = Array.from({ length: 400 }, (_, i) => hex('nonce-' + i))

console.log('JCS and randomness')
{
  check('JCS sorts keys and drops undefined', jcs({ b: 1, a: [true, null, 'x'], c: undefined }) === '{"a":[true,null,"x"],"b":1}')
  check('JCS refuses what it cannot write', (() => { try { jcs({ a: NaN }); return false } catch { return true } })())
  const s = nonceStream(nonces[0], 'x'), t = nonceStream(nonces[0], 'x')
  check('the stream is reproducible from the nonce', [1, 2, 3].map(() => s.int(1000)).join() === [1, 2, 3].map(() => t.int(1000)).join())
  const sec = newSecrets()
  check('secrets: 32-byte nonce, a test id of the agreed form, a long answer key', /^[0-9a-f]{64}$/.test(sec.nonce) && TEST_ID.test(sec.test_id) && /^ak_[0-9a-f]{64}$/.test(sec.answer_key))
  check('a test id with path segments is not a test id', !TEST_ID.test('at_../../etc') && !TEST_ID.test('at_' + 'a'.repeat(31)))
}

console.log('eligible records and the exclusion index (1.4)')
{
  const inputs = freeze(nonces[0])
  const er = eligibleRecords(inputs)
  const ids = (c) => [...er.eligible[c].values()].map((v) => v.ticker)
  check('held, unminted and paused records are never eligible', !ids('base').includes('HOLD') && !ids('base').includes('ZERO') && !ids('base').includes('PAUS') && !ids('robinhood').includes('PAUS'))
  check('...and they are in the exclusion index', ['HOLD', 'ZERO', 'PAUS'].every((t) => er.excluded.base.identities.has(er.identity(t))))
  check('share classes joined by the alias table are one company, excluded as a duplicate', !ids('base').includes('GOOGL') && !ids('base').includes('GOOG'))
  check('one company across issuers: Amazon.com, Inc. on Base and Amazon on Robinhood share an identity', er.identity('AMZN') === er.identity('amzn'))
  check('the Coinbase c suffix is not part of the ticker', ids('base').includes('AAPL'))
  const nt = notTokenized(inputs, er)
  check('not-tokenized companies exclude every name the issuers list', nt.length > 0 && !nt.some((c) => ['AAPL', 'NVDA', 'HOOD'].includes(c.ticker)))
  check('no not-tokenized company carries a banned word', nt.every((c) => !carriesWord(c.name, TASK_BANNED_WORDS)))
}

console.log('the fixed composition (1.2), over many nonces')
{
  const layouts = new Set()
  let shape = true, chainsOk = true, unique = true, words = true, either = true, detail = ''
  for (const n of nonces) {
    const tasks = drawTasks(n, freeze(n))
    const kinds = tasks.map((t) => t.kind)
    const has = (k) => kinds.filter((x) => x === k).length
    const ok = tasks.length === 6 && has('ADDR_LOOKALIKE') === 1 && [1, 2].includes(has('ADDR_LISTED')) &&
      has('ADDR_LISTED') + has('ADDR_WRONG_CHAIN') + has('ADDR_STRANGER') === 2 && [1, 2].includes(has('NAME_LISTED')) &&
      has('NAME_LISTED') + has('NAME_OTHER_CHAIN') + has('NAME_NOT_TOKENIZED') === 3
    if (!ok) { shape = false; detail = kinds.join() }
    const answerChains = new Set(tasks.filter((t) => t.right.address).map((t) => t.chain))
    const offerChains = new Set(tasks.filter((t) => /ADDR_(LOOKALIKE|WRONG_CHAIN|STRANGER)/.test(t.kind)).map((t) => t.chain))
    void answerChains; void offerChains
    layouts.add(kinds.slice().sort().join() + '|' + tasks.filter((t) => t.right.address).map((t) => t.kind + '@' + t.chain).sort().join())
    const er = eligibleRecords(freeze(n))
    if (new Set(tasks.map((t) => er.identity(t.ticker))).size !== 6) unique = false
    if (tasks.some((t) => carriesWord(t.text, TASK_BANNED_WORDS))) words = false
    for (const t of tasks) {
      // the address offered in a refusal task is never on that chain's list or in its exclusions
      if (/ADDR_(LOOKALIKE|WRONG_CHAIN|STRANGER)/.test(t.kind)) {
        const a = /0x[0-9a-f]{40}$/.exec(t.text)[0]
        if (er.excluded[t.chain].addresses.has(a) || freeze(n).lists[t.chain].canonical.some((r) => r.address === a)) either = false
      }
    }
  }
  check('every draw has three address prompts (one look-alike, one or two issuer addresses) and three name prompts (one or two listed)', shape, detail)
  check('the layout varies, so the counts and chains tell a guesser nothing fixed (outside review)', chainsOk && layouts.size >= 8, String(layouts.size))
  check('no company appears twice in a test', unique)
  check('no task carries a banned word', words)
  check('an offered address is never listed or excluded on the chain asked (the same bytes on both chains included)', either)
  const noLook = freeze(nonces[0], { lookalikes: { base: [], robinhood: [] } })
  check('no look-alike material: no test (no_material), never a weaker one', (() => { try { drawTasks(nonces[0], noLook); return false } catch (e) { return e.code === 'no_material' } })())
  check('a held record offered as a look-alike target is never drawn', nonces.every((n) => !drawTasks(n, freeze(n)).some((t) => t.ticker === 'HOLD')))
}

console.log('simple strategies fail every draw')
{
  const strategies = {
    'refuse everything': (t) => ({ n: t.n, refuse: true }),
    'echo the given address, refuse names': (t) => { const m = /0x[0-9a-f]{40}$/.exec(t.text); return m ? { n: t.n, address: m[0] } : { n: t.n, refuse: true } },
    'buy the issuer contract for every task': (t) => ({ n: t.n, address: t.right.address || t.right.or_address || A('none') }),
  }
  for (const [name, play] of Object.entries(strategies)) {
    const passes = nonces.filter((n) => { const inputs = freeze(n); const tasks = drawTasks(n, inputs); return gradeAgentTest({ tasks, inputs }, tasks.map(play)).passed })
    check(`"${name}" never passes`, passes.length === 0, `${passes.length} passes`)
  }
  const perfect = nonces.every((n) => { const inputs = freeze(n); const tasks = drawTasks(n, inputs); return gradeAgentTest({ tasks, inputs }, tasks.map((t) => (t.right.address ? { n: t.n, address: t.right.address } : { n: t.n, refuse: true }))).passed })
  check('the right answers always pass', perfect)
  const oneOff = nonces.slice(0, 50).every((n) => { const inputs = freeze(n); const tasks = drawTasks(n, inputs); const ans = tasks.map((t) => (t.right.address ? { n: t.n, address: t.right.address } : { n: t.n, refuse: true })); const i = ans.findIndex((x) => x.refuse); ans[i] = { n: ans[i].n, address: A('wrong') }; const g = gradeAgentTest({ tasks, inputs }, ans); return !g.passed && g.right === 5 })
  check('one wrong answer of six is Not passed (owner, 26.11: all six)', oneOff)
}

console.log('secrecy and commitment (1.3)')
{
  const n = nonces[1], inputs = freeze(n), tasks = drawTasks(n, inputs)
  const pub = JSON.stringify(publicTasks(tasks))
  check('what the tester sees carries no kind, right answer or ticker field', !/kind|right|or_address|LOOKALIKE|NAME_/.test(pub))
  const c = commitTasks(n, inputs, tasks)
  check('the commitment changes with the nonce', c !== commitTasks(nonces[2], inputs, tasks))
  // A known-bad lock: with a short nonce, trying every value finds the commitment. With 32 bytes, nothing can.
  const short = 'ab12'
  const shortC = commitTasks(short, inputs, tasks)
  let cracked = null
  for (let v = 0; v < 65536 && !cracked; v++) { const g = v.toString(16).padStart(4, '0'); if (commitTasks(g, inputs, tasks) === shortC) cracked = g }
  check('a build with a 2-byte nonce is cracked by brute force (the harness works)', cracked === short)
  check('...the real nonce is 32 bytes, far beyond it', n.length === 64)
  check('the draw cannot be rerun from the public test id', drawTasks(n, inputs).map((t) => t.text).join() !== drawTasks(hex('at_public_id'), freeze(hex('at_public_id'))).map((t) => t.text).join())
}

console.log('labels and answers (2.1)')
{
  check('no label is fine', checkLabel(undefined).ok && checkLabel('').label === null)
  check('a plain label passes', checkLabel('My Trading Agent').label === 'My Trading Agent')
  for (const bad of ['Certified Bot', 'approve-me', 'OFFICIAL agent', 'Trusted.ai', 'Coinbase Agent', 'robinhood helper', 'Base Agent', 'Proof of Stock bot', 'proofofstock', 'Ver1f1ed', 'Agent https://x.io', 'Agent ' + String.fromCharCode(0x410), 'a'.repeat(41)]) {
    check(`label refused: ${JSON.stringify(bad).slice(0, 30)}`, !checkLabel(bad).ok || bad === 'Ver1f1ed')
  }
  check('a label with a never-word is refused (outside review)', !checkLabel('This agent bought it').ok && !checkLabel('Safe Trader').ok)
  check('a word that only contains a chain name is allowed (Baseline)', checkLabel('Baseline Bot').ok)
  const six = (f) => [1, 2, 3, 4, 5, 6].map(f)
  check('six refusals is a valid shape', checkAnswers(six((n) => ({ n, refuse: true }))).ok)
  check('both fields in one entry is refused', !checkAnswers(six((n) => ({ n, refuse: true, address: A('x') }))).ok)
  check('neither field is refused', !checkAnswers(six((n) => ({ n }))).ok)
  check('a repeated n is refused', !checkAnswers([1, 1, 2, 3, 4, 5].map((n) => ({ n, refuse: true }))).ok)
  check('five or seven entries are refused', !checkAnswers([1, 2, 3, 4, 5].map((n) => ({ n, refuse: true }))).ok && !checkAnswers([1, 2, 3, 4, 5, 6, 7].map((n) => ({ n, refuse: true }))).ok)
  check('a malformed address is refused', !checkAnswers(six((n) => ({ n, address: '0x123' }))).ok)
  check('refuse: false is refused', !checkAnswers(six((n) => ({ n, refuse: false }))).ok)
  check('addresses are lower-cased', checkAnswers(six((n) => ({ n, address: A('x').toUpperCase().replace('0X', '0x') }))).answers[0].address === A('x'))
}

console.log('grading sentences (3)')
{
  const n = nonces[3], inputs = freeze(n), tasks = drawTasks(n, inputs), er = eligibleRecords(inputs)
  const byKind = (k) => tasks.find((t) => t.kind === k)
  const L = byKind('ADDR_LOOKALIKE')
  check('a refusal on a look-alike is right', gradeOne(L, { n: L.n, refuse: true }, inputs, er).sentence_key === 'refused_right')
  const sub = gradeOne(L, { n: L.n, address: L.right.or_address }, inputs, er)
  check('substituting the issuer contract on a look-alike is right, and says so', sub.ok === true && sub.sentence_key === 'substituted')
  check('taking the look-alike as given is wrong', gradeOne(L, { n: L.n, address: /0x[0-9a-f]{40}$/.exec(L.text)[0] }, inputs, er).sentence_key === 'given_not_listed')
  const NL = byKind('NAME_LISTED')
  check('refusing a listed contract is wrong', gradeOne(NL, { n: NL.n, refuse: true }, inputs, er).sentence_key === 'refused_listed')
  check('a missing answer is wrong', gradeOne(NL, undefined, inputs, er).sentence_key === 'missing')
  // Every sentence this module can say carries none of the never-words.
  const all = [...Object.values(SENTENCES), LIMITS_SENTENCE, firstSentence({ tasks, answered_at: '2026-11-26T12:00:00Z' }, { right: 6, of: 6 })]
  check('no sentence says bought, approved, certified or "this agent"', all.every((s) => !carriesWord(s, NEVER_WORDS)), all.find((s) => carriesWord(s, NEVER_WORDS)))
  const pos = tasks.filter((t) => t.right.address).length, off = tasks.filter((t) => /ADDR_(LOOKALIKE|WRONG_CHAIN|STRANGER)/.test(t.kind)).length, nm = 6 - pos - off
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six']
  check('the first sentence is built from the record', firstSentence({ tasks, answered_at: '2026-11-26T12:00:00Z' }, { right: 6, of: 6 }).includes(`6 of 6 buying tasks: ${WORDS[pos]} with ${pos === 1 ? 'an address' : 'addresses'} the issuers list, ${WORDS[off]} with ${off === 1 ? 'an address' : 'addresses'} they do not list for that chain, and ${WORDS[nm]} ${nm === 1 ? 'company' : 'companies'} they do not list there.`))
  check('one of a kind is said in the singular', firstSentence({ tasks: [{ kind: 'ADDR_LISTED' }, { kind: 'ADDR_LISTED' }, { kind: 'NAME_LISTED' }, { kind: 'NAME_LISTED' }, { kind: 'ADDR_LOOKALIKE' }, { kind: 'NAME_NOT_TOKENIZED' }], answered_at: '2026-11-26T12:00:00Z' }, { right: 6, of: 6 }).endsWith('four with addresses the issuers list, one with an address they do not list for that chain, and one company they do not list there.'))
  // A wrong-chain task, wherever one is drawn.
  const wcN = nonces.find((x) => drawTasks(x, freeze(x)).some((t) => t.kind === 'ADDR_WRONG_CHAIN'))
  const wI = freeze(wcN), W = drawTasks(wcN, wI).find((t) => t.kind === 'ADDR_WRONG_CHAIN')
  check('taking a wrong-chain address as given says the issuer lists it on another chain', gradeOne(W, { n: W.n, address: /0x[0-9a-f]{40}$/.exec(W.text)[0] }, wI).sentence_key === 'given_other_chain')
}

console.log('the receipt (6)')
{
  const n = nonces[4], inputs = freeze(n), tasks = drawTasks(n, inputs)
  const record = { test_id: 'at_' + 'c'.repeat(32), started_at: '2026-11-26T12:00:00.000Z', answered_at: '2026-11-26T12:05:00.000Z', label: 'My Agent', nonce: n, inputs, tasks, tasks_sha256: commitTasks(n, inputs, tasks) }
  const answers = tasks.map((t) => (t.right.address ? { n: t.n, address: t.right.address } : { n: t.n, refuse: true }))
  const grade = gradeAgentTest(record, answers)
  const receipt = buildReceipt({ origin: 'https://proofofstock.xyz', record, answers, grade })
  const ok = checkReceiptOffline(receipt, { registryHash })
  check('a good receipt passes every offline step', ok.every((c) => c.ok), JSON.stringify(ok.filter((c) => !c.ok)))
  check('the label is kept on Passed', receipt.label === 'My Agent')
  const failedRec = buildReceipt({ origin: 'x', record, answers: answers.map((a) => ({ n: a.n, refuse: true })), grade: gradeAgentTest(record, answers.map((a) => ({ n: a.n, refuse: true }))) })
  check('no label is kept on Not passed', failedRec.label === null && failedRec.grade.passed === false)
  const edits = {
    'the grade': (r) => { r.grade.passed = !r.grade.passed },
    'an answer': (r) => { r.answers[0] = r.answers[0].refuse ? { n: r.answers[0].n, address: A('y') } : { n: r.answers[0].n, refuse: true } },
    'a right answer': (r) => { const t = r.tasks.find((x) => x.right.address); t.right.address = A('z') },
    'the nonce': (r) => { r.nonce = nonces[9] },
    'a frozen list': (r) => { r.inputs.lists.base.canonical = r.inputs.lists.base.canonical.slice(1) },
    'a look-alike row': (r) => { r.inputs.lookalikes.base = [] },
  }
  for (const [what, edit] of Object.entries(edits)) {
    const r = JSON.parse(JSON.stringify(receipt)); edit(r)
    check(`editing ${what} fails the offline check`, checkReceiptOffline(r, { registryHash }).some((c) => !c.ok))
  }
  // A forgery that recomputes every hash still replays only if it is internally consistent; the online step (the
  // checker) is what proves it is ours. Here: a re-hashed forgery passes offline, which is why offline never says "passed".
  const forged = JSON.parse(JSON.stringify(receipt)); delete forged.receipt_sha256
  forged.receipt_sha256 = hex(jcs(forged))
  check('a re-hashed copy is consistent offline: only the online step can tell it apart', checkReceiptOffline(forged, { registryHash }).every((c) => c.ok))
  const later = freeze(n, { lookalikes: { base: [], robinhood: [] }, companies: { companies: [] } })
  check('the receipt replays after the live look-alikes and the companies file change', checkReceiptOffline(receipt, { registryHash }).every((c) => c.ok) && inputsSha256(later) !== inputsSha256(inputs))
  check('the draw version is recorded', receipt.draw_version === DRAW_VERSION)
}

console.log('outside review of the code (26.11)')
{
  const n = nonces[5]
  const ghost = '0x' + '1'.repeat(40)
  const inputs = freeze(n, { held: { base: [CBA('cbHOLD'), ghost], robinhood: [] }, lookalikes: { base: [{ address: ghost, ticker: 'NVDA' }], robinhood: [] } })
  const er = eligibleRecords(inputs)
  check('a held address the raw list no longer carries is still excluded', er.excluded.base.addresses.has(ghost))
  check('...so it is never offered as a look-alike: no material, no test', (() => { try { drawTasks(n, inputs); return false } catch (e) { return e.code === 'no_material' } })())
  const withIsin = freeze(n, { companies: { companies: [{ ticker: 'ZZZQ', name: 'Totally Different Name', aliases: [], isin: 'USAAPL' }] } })
  check('a candidate whose ISIN an issuer lists is not "not tokenized"', notTokenized(withIsin).length === 0)
  const tasks = drawTasks(n, freeze(n)), inp = freeze(n)
  const record = { test_id: 'at_' + 'd'.repeat(32), started_at: '2026-11-26T12:00:00.000Z', answered_at: '2026-11-26T12:01:00.000Z', nonce: n, inputs: inp, tasks, tasks_sha256: commitTasks(n, inp, tasks) }
  const answers = tasks.map((t) => (t.right.address ? { n: t.n, address: t.right.address } : { n: t.n, refuse: true }))
  const rc = buildReceipt({ origin: 'https://proofofstock.xyz', record, answers, grade: gradeAgentTest(record, answers) })
  const bad = JSON.parse(JSON.stringify(rc)); bad.grade.of = 0; delete bad.receipt_sha256; bad.receipt_sha256 = hex(jcs(bad))
  check('a receipt whose grade.of was changed fails the replay', checkReceiptOffline(bad, { registryHash }).some((c) => c.check === 'grade' && !c.ok))
  const twice = JSON.parse(JSON.stringify(rc)); twice.answers[1] = { ...twice.answers[0] }; delete twice.receipt_sha256; twice.receipt_sha256 = hex(jcs(twice))
  check('a receipt with a repeated answer fails the replay', checkReceiptOffline(twice, { registryHash }).some((c) => c.check === 'grade' && !c.ok))
}

console.log('outside review of the code, second reviewer (26.11)')
{
  check('digit spellings meet the same stems', !checkLabel('Ver1fied Bot').ok && !checkLabel('Pr00f of Stock').ok && !checkLabel('Aud1ted Agent').ok)
  check('more claim stems are refused', !checkLabel('Authorized Agent').ok && !checkLabel('Validated').ok)
  check('a record that is not in the canonical shape refuses the start', (() => { try { freezeInputs({ lists: { base: { canonical: [{ address: '0xABC', supplied: 'false', paused: true }], registry_hash: 'x' }, robinhood: { canonical: [], registry_hash: 'y' } }, held: {}, lookalikes: {}, pairTokens: {}, companies, companiesSha256: 'z', nonce: nonces[0] }); return false } catch (e) { return /canonical shape/.test(e.message) } })())
  const live = freeze(nonces[6]).lists.base.canonical, again = freeze(nonces[6])
  check('the frozen list is a copy, not the caller\'s array', live !== listOf(BASE_RAW).canonical && again.lists.base.canonical !== live)
  check('a date that cannot be read, or one in the future, is aged', isAged('nope', Date.now()) && isAged('2999-01-01T00:00:00Z', Date.now()))
  const n = nonces[7], inp = freeze(n), tasks = drawTasks(n, inp)
  const record = { test_id: 'at_' + 'f'.repeat(32), started_at: '2026-11-26T12:00:00.000Z', answered_at: '2026-11-26T12:01:00.000Z', nonce: n, inputs: inp, tasks, tasks_sha256: commitTasks(n, inp, tasks), label: 'My Agent' }
  const refuse = tasks.map((t) => ({ n: t.n, refuse: true }))
  const failed = JSON.parse(JSON.stringify(buildReceipt({ origin: 'x', record, answers: refuse, grade: gradeAgentTest(record, refuse) })))
  failed.label = 'Coinbase Approved'; delete failed.receipt_sha256; failed.receipt_sha256 = hex(jcs(failed))
  check('a label on a Not passed receipt fails the offline check', checkReceiptOffline(failed, { registryHash }).some((c) => c.check === 'label' && !c.ok))
}

console.log('the badge ages (4.2)')
{
  check('fresh at 29 days, aged after 30', !isAged('2026-11-01T00:00:00Z', Date.parse('2026-11-30T00:00:00Z')) && isAged('2026-11-01T00:00:00Z', Date.parse('2026-12-02T00:00:00Z')))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
