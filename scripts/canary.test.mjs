// scripts/canary.test.mjs: the outside check passes a healthy site and fails each way a site can go wrong, including
// a list hash that is not the issuer's and price evidence that does not replay; its workflow runs only in the public
// repository, on hosted runners, with actions named by commit.
//
// Run: node scripts/canary.test.mjs
import fs from 'node:fs'
import { runCanary, KNOWN } from './canary.mjs'
import { addressesSha256 } from '../evm/core/stocks/list-proof.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const CB = [KNOWN.listed.address, '0x' + 'cc'.repeat(20)], RH = ['0x' + 'dd'.repeat(20)]
const cbSha = addressesSha256(CB.map((address) => ({ address }))), rhSha = addressesSha256(RH.map((address) => ({ address })))
const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) })

/** A fake world: the site, both issuers and the RPC; `broken` names one thing to break. */
function world (broken = null) {
  return async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://proofofstock.xyz/') return broken === 'page' ? json(502, {}) : { status: 200, ok: true, text: async () => '<title>Proof of Stock</title>' }
    if (u.endsWith('/api/status')) { const s = { registry_age_s: broken === 'stale' ? 3600 : 60, newest_reading_age_s: 300 }; return json(200, { base: s, robinhood: s }) }
    if (u.includes('/verify?chain=base&address=' + KNOWN.listed.address)) return json(200, { listed: broken !== 'delisted', symbol: 'NVDAc', list_proof: { addresses_sha256: broken === 'hash' ? 'f'.repeat(64) : cbSha } })
    if (u.includes('/verify?chain=base&address=' + KNOWN.lookalike.address)) return json(200, { listed: broken === 'impostor-listed', impostor: {} })
    if (u.includes('/verify?chain=robinhood')) return json(200, { listed: false, list_proof: { addresses_sha256: rhSha } })
    if (u.endsWith('/mcp')) return json(200, { result: { tools: Array.from({ length: broken === 'mcp' ? 5 : 6 }, (_, i) => ({ name: 't' + i })) } })
    if (u.startsWith('https://api.coinbase.com')) return json(200, { tokens: CB.map((contract_address) => ({ contract_address })) })
    if (u.startsWith('https://api.robinhood.com')) return json(200, { assets: RH.map((contractAddress) => ({ deployments: [{ chainId: 4663, contractAddress }] })) })
    if (u.includes('/api/passport')) return json(200, { latest: { price_evidence: { evidence: 'onchain', rpc: 'https://rpc.example', multicall: '0xca11', calldata: '0x1234', block_number: 100, return_data: '0xabcd' } } })
    if (u === 'https://rpc.example') { const b = JSON.parse(init.body); return json(200, { result: broken === 'replay' ? '0xdead' : (b.params[1] === '0x64' ? '0xabcd' : '0x') }) }
    return json(404, {})
  }
}
const run = (broken, o = {}) => runCanary({ fetchImpl: world(broken), retryMs: 0, ...o })
const failing = (rs) => rs.filter((r) => !r.ok).map((r) => r.name)

const ok = await run(null)
check('a healthy site passes every check', ok.length >= 9 && failing(ok).length === 0, JSON.stringify(failing(ok)))
for (const [b, name] of [['page', 'page'], ['stale', 'status fresh'], ['delisted', 'a listed token is listed, with its proof'], ['impostor-listed', 'a known look-alike is not listed'], ['mcp', 'the MCP server lists its tools'], ['hash', 'base list hash equals the issuer\'s'], ['replay', 'price evidence replays on chain']]) {
  const rs = await run(b)
  check(`fails, and only there, when: ${name}`, failing(rs).includes(name), JSON.stringify(failing(rs)))
}
// The issuer may change its list between our read and the canary's: a mismatch is asked again after a pause.
let paused = 0, calls = 0
const flip = world(null)
const settling = await runCanary({ retryMs: 1, wait: async () => { paused++ }, fetchImpl: async (u, i) => { if (String(u).includes('/verify?chain=base&address=' + KNOWN.listed.address) && calls++ === 0) return json(200, { listed: true, symbol: 'NVDAc', list_proof: { addresses_sha256: 'e'.repeat(64) } }); return flip(u, i) } })
check('a hash mismatch is asked again after a pause, and passes when the lists agree then', paused === 1 && !failing(settling).includes('base list hash equals the issuer\'s'), JSON.stringify(failing(settling)))
const thrown = await runCanary({ retryMs: 0, fetchImpl: async () => { throw new Error('ENOTFOUND proofofstock.xyz') } })
check('a site that cannot be reached fails every check instead of throwing', thrown.every((r) => !r.ok) && /ENOTFOUND/.test(thrown[0].detail))

const wf = fs.readFileSync(new URL('../.github/workflows/canary.yml', import.meta.url), 'utf8')
check('the workflow runs only in the public repository, on GitHub\'s runners, every 30 minutes', /if: github\.repository == 'proofofstock\/proof-of-stock'/.test(wf) && /runs-on: ubuntu-latest/.test(wf) && !/self-hosted/.test(wf) && /cron: '11,41 \* \* \* \*'/.test(wf))
check('...names every action by its commit, reads only, and takes the bot only from secrets', (wf.match(/uses: [^\n]+/g) || []).every((l) => /@[0-9a-f]{40}\b/.test(l)) && /permissions:\n {2}contents: read/.test(wf) && /secrets\.STP_ALERT_TELEGRAM_TOKEN/.test(wf) && !/[0-9]{8,}:[A-Za-z0-9_-]{30,}/.test(wf))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
