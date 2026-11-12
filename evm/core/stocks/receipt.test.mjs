// evm/core/stocks/receipt.test.mjs: a receipt of one check holds when nothing was changed, and shows every change: an
// edited receipt, a list that is not the one named, and a verdict the named list does not support.
//
// Run: node evm/core/stocks/receipt.test.mjs
import crypto from 'node:crypto'
import { makeReceipt, checkReceipt, receiptHash, canonical, RECEIPT_FORMAT } from './receipt.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), Z = '0x' + 'f'.repeat(40)
const listText = [A, B].sort().map((x) => x + '\n').join('')
const listSha = crypto.createHash('sha256').update(listText).digest('hex')
const proof = { issuer: 'coinbase', addresses: 2, addresses_sha256: listSha, addresses_url: 'https://x.test/api/list/h/addresses', list_url: 'https://x.test/api/list/h', read_at: '2026-11-12T22:00:00Z', stale: false }
const serve = (text) => async (url) => (String(url) === proof.addresses_url ? new Response(text) : new Response('', { status: 404 }))

console.log('making one')
const listed = makeReceipt({ body: { chain: 'base', address: A, listed: true, symbol: 'NVDAc', impostor: null, issuer_factory: { created: true, block: 1 } }, proof, appVersion: '0.5.1', at: Date.parse('2026-11-12T22:01:00Z') })
check('a receipt names the format, the rule and its version, the verdict, the list by hash and frozen URL, and hashes itself', listed.format === RECEIPT_FORMAT && /exact contract address/.test(listed.rule.verify) && listed.rule.app_version === '0.5.1' && listed.verdict === 'listed' && listed.list.addresses_sha256 === listSha && listed.list.addresses_url === proof.addresses_url && listed.sha256 === receiptHash(listed))
check('...its hash does not depend on key order', canonical({ b: 1, a: { d: 2, c: 3 } }) === canonical({ a: { c: 3, d: 2 }, b: 1 }))
check('...and there is no receipt without a list proof to name', makeReceipt({ body: { chain: 'base', address: A, listed: true }, proof: null, appVersion: '1', at: 0 }) === null)
const stranger = makeReceipt({ body: { chain: 'base', address: Z, listed: false, impostor: { kinds: ['registry_symbol'] } }, proof, appVersion: '0.5.1', at: 0 })
check('...an impostor\'s verdict is impostor', stranger.verdict === 'impostor' && stranger.listed === false)

console.log('checking one')
{
  const ok = await checkReceipt(listed, { fetchImpl: serve(listText) })
  check('an untouched receipt holds: its hash, the frozen list\'s hash, and the verdict from that list', ok.ok && ok.checks.length === 3, JSON.stringify(ok.checks))
  const okNot = await checkReceipt(stranger, { fetchImpl: serve(listText) })
  check('...so does a "not listed" one', okNot.ok)
  const edited = { ...listed, verdict: 'not_listed', listed: false }
  const e = await checkReceipt(edited, { fetchImpl: serve(listText) })
  check('an edited receipt fails on its own hash', !e.ok && e.checks.find((c) => c.check === 'receipt hash').ok === false)
  const forged = { ...edited }; forged.sha256 = receiptHash(forged)
  const f = await checkReceipt(forged, { fetchImpl: serve(listText) })
  check('a forged one, rehashed, fails on the verdict: the named list says otherwise', !f.ok && f.checks.find((c) => c.check === 'receipt hash').ok && f.checks.find((c) => c.check === 'verdict').ok === false)
  const other = await checkReceipt(listed, { fetchImpl: serve(listText + '0x' + 'c'.repeat(40) + '\n') })
  check('a list that is not the one named fails on its hash, and no verdict is drawn from it', !other.ok && other.checks.find((c) => c.check === 'frozen list hash').ok === false && !other.checks.some((c) => c.check === 'verdict'))
  const gone = await checkReceipt(listed, { fetchImpl: async () => new Response('', { status: 404 }) })
  check('a list that cannot be fetched fails, saying so', !gone.ok && /could not fetch/.test(gone.checks.find((c) => c.check === 'frozen list').detail))
  const notOurs = await checkReceipt({ format: 'something-else' })
  check('something that is not a receipt fails', !notOurs.ok)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const l of failures) console.log(l); process.exit(1) }
