// evm/core/stocks/receipt.test.mjs: a receipt of one check holds when nothing was changed, and shows every change: an
// edited receipt, a list that is not the one named, and a verdict the named list does not support.
//
// Run: node evm/core/stocks/receipt.test.mjs
import crypto from 'node:crypto'
import { makeReceipt, checkReceipt, receiptHash, canonical, RECEIPT_FORMAT, isOurs, LIST_ORIGINS } from './receipt.mjs'
const ORIGINS = ['https://x.test']

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), Z = '0x' + 'f'.repeat(40)
const listText = [A, B].sort().map((x) => x + '\n').join('')
const listSha = crypto.createHash('sha256').update(listText).digest('hex')
const H = 'd'.repeat(64)
const proof = { issuer: 'coinbase', addresses: 2, addresses_sha256: listSha, addresses_url: `https://x.test/api/list/${H}/addresses`, list_url: `https://x.test/api/list/${H}`, read_at: '2026-11-12T22:00:00Z', stale: false }
// Our archive names a frozen list's chain in a header (LIST_CHAIN_HEADER); the body is the hashed list itself.
const serve = (text, chain = 'base') => async (url) => (String(url) === proof.addresses_url ? new Response(text, { headers: { 'x-pos-chain': chain } }) : new Response('', { status: 404 }))

console.log('making one')
const listed = makeReceipt({ body: { chain: 'base', address: A, listed: true, symbol: 'NVDAc', impostor: null, issuer_factory: { created: true, block: 1 } }, proof, appVersion: '0.5.1', at: Date.parse('2026-11-12T22:01:00Z') })
check('a receipt names the format, the rule and its version, the verdict, the list by hash and frozen URL, and hashes itself', listed.format === RECEIPT_FORMAT && /exact contract address/.test(listed.rule.verify) && listed.rule.app_version === '0.5.1' && listed.verdict === 'listed' && listed.list.addresses_sha256 === listSha && listed.list.addresses_url === proof.addresses_url && listed.sha256 === receiptHash(listed))
check('...its hash does not depend on key order', canonical({ b: 1, a: { d: 2, c: 3 } }) === canonical({ a: { c: 3, d: 2 }, b: 1 }))
check('...and there is no receipt without a list proof to name', makeReceipt({ body: { chain: 'base', address: A, listed: true }, proof: null, appVersion: '1', at: 0 }) === null)
const stranger = makeReceipt({ body: { chain: 'base', address: Z, listed: false, impostor: { kinds: ['registry_symbol'] } }, proof, appVersion: '0.5.1', at: 0 })
check('...an impostor\'s verdict is impostor', stranger.verdict === 'impostor' && stranger.listed === false)

console.log('checking one')
{
  const ok = await checkReceipt(listed, { fetchImpl: serve(listText), origins: ORIGINS })
  check('an untouched receipt holds: its hash, its fields, the list\'s chain, the frozen list\'s hash, and the verdict from that list', ok.ok && ok.checks.length === 5, JSON.stringify(ok.checks))
  const okNot = await checkReceipt(stranger, { fetchImpl: serve(listText), origins: ORIGINS })
  check('...so does a "not listed" one, and an impostor verdict is said to be the service\'s own finding, not re-derived', okNot.ok && /service's own finding/.test(okNot.checks.find((c) => c.check === 'impostor')?.detail || ''))
  // Outside review, 24.11: a receipt is a file anybody can write and rehash. Its fields must agree with each other, and
  // the list it names must be the archive's list for the receipt's own chain.
  const cross = await checkReceipt(listed, { fetchImpl: serve(listText, 'robinhood'), origins: ORIGINS })
  check('a Base receipt over a list our archive serves as Robinhood\'s fails on the list\'s chain', !cross.ok && cross.checks.find((c) => c.check === 'list chain').ok === false)
  const noChain = await checkReceipt(listed, { fetchImpl: async () => new Response(listText), origins: ORIGINS })
  check('...and so does one whose list comes with no chain named', !noChain.ok && noChain.checks.find((c) => c.check === 'list chain').ok === false)
  const forge = (over) => { const x = { ...listed, ...over }; x.sha256 = receiptHash(x); return x }
  for (const [what, over] of [
    ['an impostor verdict over a listed field', { verdict: 'impostor', listed: true }],
    ['an impostor verdict with no impostor finding', { verdict: 'impostor', listed: false, impostor: null }],
    ['a verdict that is no verdict', { verdict: 'scam', listed: false }],
    ['an address that is not one', { address: A + '\u001b[2Jgenuine' }],
    ['a chain we do not check', { chain: 'ethereum' }],
  ]) {
    const r = await checkReceipt(forge(over), { fetchImpl: async () => { throw new Error('no fetch expected') }, origins: ORIGINS })
    check(`a rehashed receipt with ${what} fails on its fields before anything is fetched`, !r.ok && r.checks.find((c) => c.check === 'fields').ok === false && !r.checks.some((c) => c.check === 'frozen list'))
  }
  const offPath = forge({ list: { ...listed.list, addresses_url: 'https://x.test/api/history/registry?chain=base' } })
  const op = await checkReceipt(offPath, { fetchImpl: serve(listText), origins: ORIGINS })
  check('a list URL on our origin but outside the frozen lists fails', !op.ok && /not our archive/.test(op.checks.find((c) => c.check === 'frozen list')?.detail || ''))
  const edited = { ...listed, verdict: 'not_listed', listed: false }
  const e = await checkReceipt(edited, { fetchImpl: serve(listText), origins: ORIGINS })
  check('an edited receipt fails on its own hash', !e.ok && e.checks.find((c) => c.check === 'receipt hash').ok === false)
  const forged = { ...edited }; forged.sha256 = receiptHash(forged)
  const f = await checkReceipt(forged, { fetchImpl: serve(listText), origins: ORIGINS })
  check('a forged one, rehashed, fails on the verdict: the named list says otherwise', !f.ok && f.checks.find((c) => c.check === 'receipt hash').ok && f.checks.find((c) => c.check === 'verdict').ok === false)
  const other = await checkReceipt(listed, { fetchImpl: serve(listText + '0x' + 'c'.repeat(40) + '\n'), origins: ORIGINS })
  check('a list that is not the one named fails on its hash, and no verdict is drawn from it', !other.ok && other.checks.find((c) => c.check === 'frozen list hash').ok === false && !other.checks.some((c) => c.check === 'verdict'))
  const gone = await checkReceipt(listed, { fetchImpl: async () => new Response('', { status: 404 }), origins: ORIGINS })
  check('a list that cannot be fetched fails, saying so', !gone.ok && /could not fetch/.test(gone.checks.find((c) => c.check === 'frozen list').detail))
  // ⚠ A receipt is a file somebody handed you, and its own hash only proves nobody edited it afterwards. An impostor
  // can write a receipt that says "listed", serve a list that hashes to what it claims, rehash the receipt, and every
  // check goes green on the author's own bytes. What ties a receipt to us is where its list is served from.
  const elsewhere = { ...listed, list: { ...listed.list, addresses_url: 'https://evil.example/list' } }
  elsewhere.sha256 = receiptHash(elsewhere)
  const asked = []
  const bad = await checkReceipt(elsewhere, { fetchImpl: async (u) => { asked.push(String(u)); return new Response(listText) }, origins: ORIGINS })
  check('a receipt pointing anywhere but our archive fails, and nothing of the author is fetched', !bad.ok && asked.length === 0 && /not our archive/.test(bad.checks.find((c) => c.check === 'frozen list').detail))
  check('...and the pin is the site itself by default, over https only', LIST_ORIGINS[0] === 'https://proofofstock.xyz' && isOurs('https://proofofstock.xyz/api/list/h/addresses') && !isOurs('http://proofofstock.xyz/x') && !isOurs('https://proofofstock.xyz.evil.test/x') && !isOurs('https://user:pw@proofofstock.xyz/x'))
  const notOurs = await checkReceipt({ format: 'something-else' })
  check('something that is not a receipt fails', !notOurs.ok)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const l of failures) console.log(l); process.exit(1) }
