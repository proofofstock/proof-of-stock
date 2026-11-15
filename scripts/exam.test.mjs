// scripts/exam.test.mjs: the exam scores a site that tells the truth as perfect, and catches each way a site could lie
// or fail: a look-alike called listed, a listed token called not listed or a fake, a list proof that is not the
// issuer's, price evidence that does not replay, a refusal. Its workflow publishes to the exam branch only.
//
// Run: node scripts/exam.test.mjs
import fs from 'node:fs'
import { runExam, reportMarkdown, strangers } from './exam.mjs'
import { addressesSha256 } from '../evm/core/stocks/list-proof.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const a = (n) => '0x' + String(n).repeat(40).slice(0, 40)
const CB = [a(1), a(2), '0xb20000000000000000000078ee7ce2fe4908108c'], CB_NOSUPPLY = a(3), RH = [a(4)], IMP = a(5), PAIR = a(6)
const json = (status, body) => ({ status, json: async () => body })
const cbSha = addressesSha256([...CB, CB_NOSUPPLY].map((address) => ({ address }))), rhSha = addressesSha256(RH.map((address) => ({ address })))

function site (lie = null) {
  const listed = (c) => (c === 'base' ? [...CB, CB_NOSUPPLY] : RH)
  return async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.host === 'api.coinbase.com') return json(200, { tokens: [...CB.map((x) => ({ contract_address: x, total_supply: 5 })), { contract_address: CB_NOSUPPLY }] })
    if (u.host === 'api.robinhood.com') return json(200, { assets: RH.map((x) => ({ deployments: [{ chainId: 4663, contractAddress: x }] })) })
    if (u.pathname.endsWith('/api/impostors')) return json(200, { chains: { base: { items: [{ address: IMP }] }, robinhood: { items: [] } } })
    if (u.pathname.endsWith('/api/passport')) {
      if (u.searchParams.get('address') === '0xb20000000000000000000078ee7ce2fe4908108c' || u.searchParams.get('address') === '0x322f0929c4625ed5bad873c95208d54e1c003b2d') return json(200, { sources: { pools_counted: { paired_with_addresses: [PAIR] } }, latest: { price_evidence: { evidence: 'onchain', rpc: 'https://rpc.example', multicall: '0xca11', calldata: '0x01', block_number: 7, return_data: '0xaa' } } })
      return json(200, { latest: { price_evidence: { evidence: 'none' } } })
    }
    if (u.host === 'rpc.example') return json(200, { result: lie === 'replay' ? '0xbb' : '0xaa' })
    if (u.pathname.endsWith('/verify')) {
      const c = u.searchParams.get('chain')
      if (lie === 'refuse') return json(503, { error: 'registry unavailable' })
      const results = u.searchParams.get('addresses').split(',').map((x) => {
        let listed_ = listed(c).includes(x)
        if (lie === 'impostor-listed' && x === IMP) listed_ = true
        if (lie === 'drop' && x === CB[0]) listed_ = false
        return { address: x, listed: listed_, impostor: x === IMP || (lie === 'fake' && x === CB[1]) ? { imitates_symbol: 'X' } : null, minted: c === 'base' && listed_ ? (lie === 'minted' ? true : x !== CB_NOSUPPLY) : null, listed_on_other_chain: c === 'robinhood' && [...CB, CB_NOSUPPLY].includes(x) ? { chain: 'base' } : null }
      })
      return json(200, { results, list_proof: { addresses_sha256: lie === 'proof' && c === 'base' ? 'f'.repeat(64) : c === 'base' ? cbSha : rhSha } })
    }
    return json(404, {})
  }
}
const exam = (lie) => runExam({ fetchImpl: site(lie), pauseMs: 0, sleep: async () => {} })

const ok = await exam(null)
check('a truthful site scores perfect, with no failures', ok.failures_total === 0 && ok.metrics.false_listed === 0 && ok.metrics.false_not_listed === 0 && ok.metrics.lookalikes_caught === 1 && ok.metrics.list_proof.base.match && ok.metrics.list_proof.robinhood.match, JSON.stringify(ok.failures))
check('the set has every group, with a reproducible hash', ok.set.counts.A === 5 && ok.set.counts.B === 1 && ok.set.counts.C > 2 && ok.set.counts.D === 4 && /^[0-9a-f]{64}$/.test(ok.set.sha256) && ok.set.sha256 === (await exam(null)).set.sha256)
check('strangers are derived from the day: the same day gives the same, another day other ones', strangers('2026-11-12base').join() === strangers('2026-11-12base').join() && strangers('2026-11-12base')[0] !== strangers('2026-11-13base')[0])
const cases = [
  ['impostor-listed', (r) => r.metrics.false_listed === 1, 'a look-alike answered listed'],
  ['drop', (r) => r.metrics.false_not_listed === 1, 'a listed token answered not listed'],
  ['fake', (r) => r.metrics.real_called_fake === 1, 'a listed token flagged as a fake'],
  ['minted', (r) => r.metrics.minted_wrong === 1, 'minted disagreeing with total_supply'],
  ['proof', (r) => r.metrics.list_proof.base.match === false, 'a list proof that is not the issuer\'s'],
  ['replay', (r) => r.metrics.price_evidence.same_bytes === 0 && r.failures.some((f) => f.group === 'price'), 'price evidence that does not replay'],
  ['refuse', (r) => r.metrics.refused > 0 && r.metrics.false_not_listed === 0, 'a refusal counted as a refusal, never as not listed'],
]
for (const [lie, test, what] of cases) { const r = await exam(lie); check(`it catches: ${what}`, test(r), JSON.stringify(r.metrics)) }
const md = reportMarkdown(ok)
check('the report says what was asked, the set hash, every check and how to rerun', md.includes(ok.set.sha256) && /node scripts\/exam\.mjs/.test(md) && /False "listed"/.test(md) && /hello@proofofstock\.xyz/.test(md))
let threw = false
try { await runExam({ fetchImpl: async () => json(503, {}), pauseMs: 0, sleep: async () => {} }) } catch (_) { threw = true }
check('no exam without the truth: an issuer list that cannot be read stops it', threw)

const wf = fs.readFileSync(new URL('../.github/workflows/exam.yml', import.meta.url), 'utf8')
check('the workflow runs daily in the public repository only, on GitHub\'s runners, actions by commit', /if: github\.repository == 'proofofstock\/proof-of-stock'/.test(wf) && /runs-on: ubuntu-latest/.test(wf) && !/self-hosted/.test(wf) && /cron:/.test(wf) && (wf.match(/uses: [^\n]+/g) || []).every((l) => /@[0-9a-f]{40}\b/.test(l)))
check('...and writes to the exam branch only, never to main', /git push origin HEAD:exam/.test(wf) && !/push origin (HEAD:)?main/.test(wf) && /contents: write/.test(wf))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
