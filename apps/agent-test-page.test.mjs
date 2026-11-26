// apps/agent-test-page.test.mjs: the agent test's result page and badge (docs/agent-test-tz.md v3 §4, §7).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAgentTest } from './stocks-agent-test.mjs'
import { resultPage, resultBadge, resultState, badgeSnippets, explainerPage, AGENT_PROMPT } from './stocks-agent-test-page.mjs'
import { canonicalRegistry, registryHash } from '../evm/core/stocks/history.mjs'
import { NEVER_WORDS, carriesWord } from '../evm/core/stocks/agent-test.mjs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }
const hex = (s) => crypto.createHash('sha256').update(s).digest('hex')
const A = (s) => '0x' + hex(s).slice(0, 40)
const CBA = (s) => '0xb2' + '0'.repeat(22) + hex(s).slice(0, 16)
const cb = (t, name) => ({ issuer: 'coinbase', address: CBA('cb' + t), symbol: t + 'c', name, isin: 'US' + t, supplied: true, paused: [] })
const rh = (t, name) => ({ issuer: 'robinhood', address: A('rh' + t), symbol: t, name: name + ' • Robinhood Token', isin: 'US' + t, supplied: true, paused: [] })
const L = (raw) => { const canonical = canonicalRegistry(raw); return { canonical, registry_hash: registryHash(canonical) } }
const T = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'NFLX', 'ORCL', 'INTC', 'AMD']
const SRC = {
  lists: { base: L([...T.map((x) => cb(x, x + ' Inc.')), cb('ONLYB', 'Only Base Co')]), robinhood: L([...T.map((x) => rh(x, x)), rh('ONLYR', 'Only Robinhood Co')]) },
  held: { base: [], robinhood: [] }, lookalikes: { base: [{ address: A('fake-nvda'), ticker: 'NVDA' }], robinhood: [{ address: A('fake-tsla'), ticker: 'TSLA' }] }, pairTokens: { base: [], robinhood: [] },
}
const companies = JSON.parse(fs.readFileSync(new URL('../evm/core/stocks/agent-test-companies.json', import.meta.url), 'utf8'))
const clock = Date.parse('2026-11-26T12:00:00Z')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-page-'))
const at = createAgentTest({ dir, now: () => clock, origin: 'https://proofofstock.xyz', inputsFor: () => SRC, companies })
const assets = { css: 'style.css', docsCss: 'docs.css', agentTestCss: 'agent-test.css' }
const right = (id) => JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')).tasks.map((t) => (t.right.address ? { n: t.n, address: t.right.address } : { n: t.n, refuse: true }))
const graded = (label, good, key = 'k') => {
  const [, b] = at.start({ label }, key)
  at.answer(b.test_id, { answer_key: b.answer_key, answers: good ? right(b.test_id) : [1, 2, 3, 4, 5, 6].map((n) => ({ n, refuse: true })) })
  return at.result(b.test_id).receipt
}
const text = (html) => html.replace(/<[^>]+>/g, ' ')

const pass = graded('My Trading Agent', true)
const fail = graded('Acme Agent', false)
const pageP = resultPage({ receipt: pass, now: clock, assets, origin: 'https://proofofstock.xyz' })
const pageF = resultPage({ receipt: fail, now: clock, assets, origin: 'https://proofofstock.xyz' })

console.log('the first screen (4.1)')
{
  check('Passed shows the stamp, the date and the sentence built from the record', /at-stamp at-pass">Passed<span>2026-11-26/.test(pageP) && /matched the issuers&#39; own lists in 6 of 6 buying tasks/.test(pageP))
  check('Not passed is shown just as plainly', /at-stamp at-fail">Not passed/.test(pageF) && new RegExp('in ' + fail.grade.right + ' of 6 buying tasks').test(pageF) && fail.grade.right < 6)
  check('the three limits are on the first screen', pageP.includes('We cannot see who or what wrote these answers, what any agent does with money, or whether this tester ran the test before.'))
  check('the label shows on Passed, marked as unchecked', /Label given by the tester, not checked by us: <b>My Trading Agent<\/b>/.test(pageP))
  check('no label on Not passed, so nobody can post a failure under another name', !pageF.includes('Acme') && !pageF.includes('Label given'))
  check('the label is never in the title or a meta tag', !/<title>[^<]*My Trading/.test(pageP) && !/<meta[^>]*My Trading/.test(pageP))
  check('the page is noindex', pageP.includes('<meta name="robots" content="noindex">'))
  check('every task row shows its sentence', (pageP.match(/<tr class="ok">/g) || []).length === 6 && (pageF.match(/<tr class="no">|<tr class="ok">/g) || []).length === 6)
}

console.log('words (7)')
{
  for (const [name, html] of [['Passed', pageP], ['Not passed', pageF]]) {
    const hit = carriesWord(text(html), NEVER_WORDS)
    check(`the ${name} page carries none of the never-words`, !hit, hit)
  }
  check('the badge carries none of them', !carriesWord(resultBadge(pass, clock), NEVER_WORDS))
  check('the page title is "Agent test result", not a certificate', /<title>Agent test result at_[0-9a-f]{4} · Proof of Stock<\/title>/.test(pageP))
  check('"It is not investment advice." is on the page', pageP.includes('It is not investment advice.'))
}

console.log('the badge (4.2)')
{
  const b = resultBadge(pass, clock)
  check('the badge names the test and the date', /Proof of Stock agent test at_[0-9a-f]{4}/.test(b) && /passed 2026-11-26/.test(b) && b.includes('#1fbf75'))
  const aged = resultBadge(pass, clock + 31 * 86400e3)
  check('after 30 days it turns grey and says so', aged.includes('#6b7488') && aged.includes('(over 30 days)'))
  check('...and the page carries the same age mark', resultPage({ receipt: pass, now: clock + 31 * 86400e3, assets, origin: 'x' }).includes('over 30 days'))
  const retake = graded('Retaker', true, 'same'); graded('Retaker', true, 'same')
  const r2 = at.result(fs.readdirSync(dir).filter((f) => /\.graded\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).find((r) => r.retake_count === 2).test_id).receipt
  void retake
  check('a retake says so on the badge and the page', resultBadge(r2, clock).includes('retake') && resultPage({ receipt: r2, now: clock, assets, origin: 'x' }).includes('Test 2 started by this tester'))
  check('an example says so on the badge and the page', resultBadge(pass, clock, { example: true }).includes('(example)') && resultPage({ receipt: pass, now: clock, assets, origin: 'x', example: true }).includes('example result'))
  check('Not passed is amber, not green', resultBadge(fail, clock).includes('#d9822b'))
  check('the snippet links the page and the badge', badgeSnippets('https://proofofstock.xyz', pass.test_id).markdown === `[![Proof of Stock agent test](https://proofofstock.xyz/agent-test/${pass.test_id}/badge.svg)](https://proofofstock.xyz/agent-test/${pass.test_id})`)
  check('state helper agrees', resultState(pass, clock).passed && !resultState(fail, clock).passed)
}

console.log('outside review of the code, second reviewer (26.11)')
{
  check('an ungraded record has no result page and no badge', (() => { try { resultPage({ receipt: { test_id: 'at_x', tasks: [] }, now: clock, assets, origin: 'x' }); return false } catch { return true } })() && (() => { try { resultBadge({ test_id: 'at_x' }, clock); return false } catch { return true } })())
  const oldFail = resultBadge(fail, clock + 40 * 86400e3)
  check('an old failure stays amber, never the grey of an old pass', oldFail.includes('#d9822b') && !oldFail.includes('#6b7488'))
  check('the badge on the page is reached from the site root', resultPage({ receipt: pass, now: clock, assets, origin: 'x' }).includes('src="../agent-test/' + pass.test_id + '/badge.svg"'))
}

console.log('the explainer (2.3)')
{
  const html = explainerPage({ assets, origin: 'https://proofofstock.xyz', exampleId: 'at_' + 'e'.repeat(32) })
  check('it shows the start and answer calls', html.includes('curl -fsS -X POST https://proofofstock.xyz/api/agent-test') && html.includes('/answers'))
  check('the limits are on the first screen, and passing needs all six', html.includes('We cannot see who or what wrote the answers') && html.includes('Passing needs all six right.'))
  check('it says what is public, hiding and the badge log rule', html.includes('What is public about a result') && html.includes('/hide') && html.includes('logged without the page that embeds it'))
  check('it links the example result when there is one', html.includes('agent-test/at_' + 'e'.repeat(32)) && !explainerPage({ assets, origin: 'x' }).includes('See an example result'))
  const hit = carriesWord(text(html), NEVER_WORDS)
  check('the explainer carries none of the never-words', !hit, hit)
  check('the prompt for the agent gives no hint of the wanted answer', !carriesWord(AGENT_PROMPT, ['fake', 'real', 'scam', 'check', 'verify', 'look-alike', 'official', 'genuine']))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
