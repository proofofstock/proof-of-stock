// packages/proofofstock-guard/index.test.mjs: the guard buys only an issuer-listed token of the stock asked for,
// refuses an impostor and names the listed contract, refuses what it cannot vouch for, and fails closed.
// The verify answers are the calibration cases of docs/stocks-passport-agent.md, served by a fake fetch: no network.
//
// Run: node packages/proofofstock-guard/index.test.mjs

import { createGuard, checkListProof, addressesSha256, readIssuerList, VERSION, ISSUER_ADDRESS_PREFIX, ISSUER_OF, ISSUER_LIST_TTL_MS, ISSUER_FAIL_TTL_MS, ISSUER_MAX_PAGES } from './index.mjs'
import { guardAction, ACTION_INPUT_SCHEMA } from './agentkit.mjs'
import fs from 'node:fs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}

const LISTED = '0xb200000000000000000000397293cb8cda9a10c5', COPY = '0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703'
const NAMING = '0x8ee13668daa8a46f3605be5cc06c1c085c891f53', OTHER = '0x' + '12'.repeat(20)
const ans = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const PROOF = { issuer: 'coinbase', addresses_sha256: 'a'.repeat(64), reproduce: 'curl ...', stale: false, read_at: new Date().toISOString() }
const answers = {
  [LISTED]: ans(200, { listed: true, symbol: 'SNDKc', address: LISTED, registries_checked: ['coinbase:base'], impostor: null, registry_age_s: 60, list_proof: PROOF }),
  [COPY]: ans(200, { listed: false, symbol: null, address: COPY, registries_checked: ['coinbase:base'], impostor: { kinds: ['registry_symbol'], imitates_symbol: 'SNDKc', listed_address: LISTED } }),
  [NAMING]: ans(200, { listed: false, address: NAMING, registries_checked: ['robinhood:robinhood'], impostor: { kinds: ['issuer_name_suffix'], imitates_symbol: null, listed_address: null } }),
  [OTHER]: ans(200, { listed: false, address: OTHER, registries_checked: ['coinbase:base'], impostor: null, listed_on_other_chain: { chain: 'robinhood', symbol: 'TSLA' } }),
}
// The issuers' own lists, as the guard reads them itself since 0.3.0 (crossCheck on by default outside a browser).
const ISSUER_BODY = { tokens: [LISTED, COPY].map((a) => ({ contract_address: a })) }
const withIssuer = (f) => async (url, init) => (String(url).startsWith('https://api.coinbase.com/') ? ans(200, ISSUER_BODY) : f(url, init))
const calls = []
const heads = []
const fetchImpl = withIssuer(async (url, init) => {
  calls.push(String(url)); heads.push(init && init.headers)
  const a = new URL(url).searchParams.get('address')
  if (a === '0x' + '99'.repeat(20)) return ans(503, { error: 'registry unavailable' })
  if (a === '0x' + '98'.repeat(20)) throw new Error('connect ETIMEDOUT')
  if (a === '0x' + '97'.repeat(20)) return ans(200, { listed: 'false', symbol: 'SNDKc', address: a, registries_checked: ['coinbase:base'], impostor: null })
  if (a === '0x' + '96'.repeat(20)) return ans(200, { listed: true, symbol: 'SNDKc', address: LISTED, registries_checked: ['coinbase:base'], impostor: null })
  if (a === '0x' + '95'.repeat(20)) return ans(200, { listed: false, address: a })
  return answers[a] || ans(404, {})
})
const guard = createGuard({ fetchImpl, retryDelayMs: 0 })

console.log('decisions')
{
  const ok = await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'SNDK' })
  check('an issuer-listed token of the stock asked for is allowed', ok.allow === true && ok.decision === 'listed')
  check('...and the request went to /verify on proofofstock.xyz with a lower-case address', calls[0] === 'https://proofofstock.xyz/verify?chain=base&address=' + LISTED)
  const copy = await guard.beforeBuy({ chain: 'base', tokenAddress: COPY.toUpperCase().replace('0X', '0x'), claimedSymbol: 'SNDKc' })
  check('a token copying a listed symbol is refused, and the listed contract is offered instead', copy.allow === false && copy.decision === 'impostor' && copy.use_instead === LISTED && /imitates the issuer-listed SNDKc/.test(copy.reason))
  const naming = await guard.beforeBuy({ chain: 'robinhood', tokenAddress: NAMING })
  check('a token copying the issuer naming is refused, with nothing offered instead', naming.allow === false && naming.decision === 'impostor' && naming.use_instead === null)
  const other = await guard.beforeBuy({ chain: 'base', tokenAddress: OTHER })
  check('a token outside the registry is refused without being called fake, and the other chain is pointed out', other.allow === false && other.decision === 'not_listed' && /does not make it fake/.test(other.reason) && /listed on robinhood as TSLA/.test(other.reason))
  const wrong = await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'TSLA' })
  check('a listed token of ANOTHER stock than the one asked for is refused', wrong.allow === false && wrong.decision === 'wrong_stock')
  check('the claim NVDAc, NVDA or nvda is the same stock; a lowercase word is not trimmed', (await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'sndk' })).allow === true && (await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'sndkc' })).decision === 'wrong_stock')
}

console.log('failing closed')
{
  // A 200 is not enough: the answer must say listed === true about the address asked, in the documented shape.
  for (const [a, why] of [['97', 'listed is the string "false"'], ['96', 'the answer is about another contract'], ['95', 'registries_checked is missing']]) {
    let d, threw = null
    try { d = await guard.beforeBuy({ chain: 'base', tokenAddress: '0x' + a.repeat(20), claimedSymbol: 'SNDK' }) } catch (e) { threw = e.message }
    check('a malformed 200 (' + why + ') is unknown and refused, not allowed or thrown', !threw && d.allow === false && d.decision === 'unknown' && /malformed answer/.test(d.reason), threw || JSON.stringify(d && { allow: d.allow, decision: d.decision }))
  }
  const down = await guard.beforeBuy({ chain: 'base', tokenAddress: '0x' + '99'.repeat(20) })
  check('a registry that cannot be read refuses the buy', down.allow === false && down.decision === 'unknown')
  const net = await guard.beforeBuy({ chain: 'base', tokenAddress: '0x' + '98'.repeat(20) })
  check('a network failure refuses the buy', net.allow === false && net.decision === 'unknown' && /ETIMEDOUT/.test(net.reason))
  const open = await createGuard({ fetchImpl, failOpen: true, retryDelayMs: 0 }).beforeBuy({ chain: 'base', tokenAddress: '0x' + '99'.repeat(20) })
  check('...unless the caller chose failOpen, and then it says so', open.allow === true && /failOpen/.test(open.reason))
  // 0.2.0: beforeBuy never throws; bad input is a refusal an agent can read.
  const badChain = await guard.beforeBuy({ chain: 'solana', tokenAddress: LISTED }), badAddr = await guard.beforeBuy({ chain: 'base', tokenAddress: 'NVDA' })
  check('a bad chain or address is a refusal (invalid_input), not a throw', badChain.allow === false && badChain.decision === 'invalid_input' && badAddr.decision === 'invalid_input')
  // The version is written in index.mjs and in package.json, and the check below ties those two together. A literal
// here would be a third place to forget, which is how a number goes wrong: it is deliberately not pinned.
check('requests say who asks: user-agent proofofstock-guard/<version>', heads.some((h) => h && h['user-agent'] === 'proofofstock-guard/' + VERSION) && /^\d+\.\d+\.\d+$/.test(VERSION))
}

console.log('no evidence, no buy')
{
  const mk = (body) => createGuard({ retryDelayMs: 0, fetchImpl: withIssuer(async () => ans(200, { listed: true, symbol: 'SNDKc', address: LISTED, registries_checked: ['coinbase:base'], impostor: null, registry_age_s: 60, list_proof: PROOF, ...body })) })
  const noProof = await mk({ list_proof: null }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('a listed answer without list_proof is unknown and refused', noProof.allow === false && noProof.decision === 'unknown' && /no list_proof/.test(noProof.reason))
  const stale = await mk({ list_proof: { ...PROOF, stale: true } }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('...so is one whose list is stale', stale.allow === false && stale.decision === 'unknown' && /stale/.test(stale.reason))
  const old = await mk({ registry_age_s: 3600 }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('...and one from a list read longer ago than maxRegistryAgeS (900 s)', old.allow === false && /3600 s ago/.test(old.reason))
  const fine = await createGuard({ retryDelayMs: 0, maxRegistryAgeS: 7200, fetchImpl: withIssuer(async () => ans(200, { listed: true, symbol: 'SNDKc', address: LISTED, registries_checked: ['coinbase:base'], impostor: null, registry_age_s: 3600, list_proof: PROOF })) }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('...unless the caller allows that age', fine.allow === true)
}

console.log('retries')
{
  let n = 0
  const flaky = createGuard({ retryDelayMs: 0, fetchImpl: withIssuer(async () => (++n === 1 ? ans(503, {}) : answers[LISTED])) })
  check('a 503 is asked once more, and the second answer counts', (await flaky.beforeBuy({ chain: 'base', tokenAddress: LISTED })).allow === true && n === 2)
  let m = 0
  const busy = createGuard({ retryDelayMs: 0, fetchImpl: async () => { m++; return ans(429, { error: 'too many requests' }) } })
  const d = await busy.beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('a 429 is not retried (asking again makes it worse), and refuses', m === 1 && d.allow === false && d.decision === 'unknown')
}

console.log('batches')
{
  const seen = []
  const batchFetch = async (url) => {
    seen.push(String(url))
    const list = new URL(url).searchParams.get('addresses').split(',')
    const res = list.map((a) => (a === LISTED ? { listed: true, symbol: 'SNDKc', address: a, registries_checked: ['coinbase:base'], impostor: null, registry_age_s: 60 } : { listed: false, address: a, registries_checked: ['coinbase:base'], impostor: a === COPY ? { kinds: ['registry_symbol'], imitates_symbol: 'SNDKc', listed_address: LISTED } : null }))
    return ans(200, { chain: 'base', count: res.length, results: res, list_proof: PROOF })
  }
  const g = createGuard({ fetchImpl: withIssuer(batchFetch), retryDelayMs: 0 })
  const many = Array.from({ length: 60 }, (_, i) => (i === 0 ? LISTED : i === 1 ? COPY : '0x' + (i + 16).toString(16).padStart(40, '0')))
  const ds = await g.beforeBuyMany('base', many.map((a) => ({ tokenAddress: a })).concat([{ tokenAddress: 'bad' }]))
  check('beforeBuyMany: one decision per input, in order, asked 50 at a time', ds.length === 61 && seen.length === 2 && ds[0].decision === 'listed' && ds[1].decision === 'impostor' && ds[1].use_instead === LISTED && ds[2].decision === 'not_listed' && ds[60].decision === 'invalid_input', JSON.stringify(ds.slice(0, 3).map((d) => d.decision)))
  const short = await createGuard({ retryDelayMs: 0, fetchImpl: async () => ans(200, { results: [] }) }).beforeBuyMany('base', [{ tokenAddress: LISTED }])
  check('...a batch answer that does not match the addresses asked is unknown', short[0].decision === 'unknown' && /do not match/.test(short[0].reason))
}

console.log('checking the list proof against the issuer')
{
  const list = [LISTED, COPY]
  const sha = await addressesSha256(list)
  const issuer = (body, status = 200) => async () => ans(status, body)
  const proof = { ...PROOF, addresses_sha256: sha }
  const m = await checkListProof(proof, { address: LISTED, fetchImpl: issuer({ tokens: list.map((a) => ({ contract_address: a.toUpperCase().replace('0X', '0x') })) }) })
  check('match: the issuer\'s list hashes to addresses_sha256, and the address is on it', m.status === 'match' && m.address_in_issuer_list === true && m.issuer_sha256 === sha)
  const changed = await checkListProof(proof, { address: COPY, fetchImpl: issuer({ tokens: [{ contract_address: LISTED }] }) })
  check('list_changed: another list, and the address is not on it', changed.status === 'list_changed' && changed.address_in_issuer_list === false)
  check('issuer_unavailable: the issuer could not be read', (await checkListProof(proof, { fetchImpl: issuer({}, 503) })).status === 'issuer_unavailable')
  check('no_recipe: no proof, a list with no recipe, or a Coinbase list that spans pages', (await checkListProof(null)).status === 'no_recipe' && (await checkListProof({ ...proof, reproduce: null })).status === 'no_recipe' && (await checkListProof(proof, { fetchImpl: issuer({ tokens: [], next_page_token: 'x' }) })).status === 'no_recipe')
  const rh = await checkListProof({ ...PROOF, issuer: 'robinhood', addresses_sha256: await addressesSha256([COPY]) }, { address: COPY, fetchImpl: issuer({ assets: [{ deployments: [{ chainId: 1, contractAddress: LISTED }, { chainId: 4663, contractAddress: COPY }] }, { deployments: [] }] }) })
  check('Robinhood: the first deployment on Robinhood Chain of each asset, as the server reads it', rh.status === 'match' && rh.address_in_issuer_list === true)
  // The same digest as the server's own code (evm/core/stocks/list-proof.mjs) on one fixture.
  const { addressesSha256: serverSha } = await import('../../evm/core/stocks/list-proof.mjs')
  check('parity: the guard hashes a list exactly as proofofstock.xyz does', serverSha(list.map((address) => ({ address }))) === sha)
  // crossCheck: buy only when the issuer itself has the address.
  const both = (issuerBody) => async (url) => (String(url).startsWith('https://proofofstock.xyz') ? ans(200, { listed: true, symbol: 'SNDKc', address: LISTED, registries_checked: ['coinbase:base'], impostor: null, registry_age_s: 60, list_proof: proof }) : ans(200, issuerBody))
  const yes = await createGuard({ crossCheck: true, retryDelayMs: 0, fetchImpl: both({ tokens: list.map((a) => ({ contract_address: a })) }) }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  const no = await createGuard({ crossCheck: true, retryDelayMs: 0, fetchImpl: both({ tokens: [{ contract_address: COPY }] }) }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('crossCheck: allowed only when the issuer\'s own list has the address; otherwise unknown', yes.allow === true && yes.cross_check.status === 'match' && no.allow === false && no.decision === 'unknown' && no.cross_check.address_in_issuer_list === false)
}

console.log('it does not take our word for it (0.3.0)')
{
  const FOREIGN = '0x' + 'c0'.repeat(20)
  const listedAs = (address, proof = PROOF) => async (url) => (String(url).startsWith('https://proofofstock.xyz') ? ans(200, { listed: true, symbol: 'SNDKc', address, registries_checked: ['coinbase:base'], impostor: null, registry_age_s: 60, list_proof: proof }) : ans(200, ISSUER_BODY))
  check('the Base prefix is pinned: 0xb2 then twenty zero hex digits; Robinhood has none; the issuer is chosen by the chain', ISSUER_ADDRESS_PREFIX.base === '0xb2' + '0'.repeat(20) && !('robinhood' in ISSUER_ADDRESS_PREFIX) && ISSUER_OF.base === 'coinbase' && ISSUER_OF.robinhood === 'robinhood')
  const forged = await createGuard({ retryDelayMs: 0, crossCheck: false, fetchImpl: listedAs(FOREIGN) }).beforeBuy({ chain: 'base', tokenAddress: FOREIGN })
  check('a server that says "listed" for a Base address without the issuer\'s form is not believed, even with crossCheck off', forged.allow === false && forged.decision === 'unknown' && /not believed/.test(forged.reason))
  const open = await createGuard({ retryDelayMs: 0, crossCheck: false, failOpen: true, fetchImpl: listedAs(FOREIGN) }).beforeBuy({ chain: 'base', tokenAddress: FOREIGN })
  check('...and failOpen does not let it through: the answer is contradicted, not missing', open.allow === false)
  const PREFIXED = '0xb2000000000000000000009999999999999999ff'
  const offList = await createGuard({ retryDelayMs: 0, fetchImpl: listedAs(PREFIXED) }).beforeBuy({ chain: 'base', tokenAddress: PREFIXED })
  check('by default the guard reads the issuer\'s list itself: an address "listed" by the server but not by Coinbase is refused', offList.allow === false && offList.decision === 'unknown' && offList.cross_check.address_in_issuer_list === false)
  const ok = await createGuard({ retryDelayMs: 0, fetchImpl: listedAs(LISTED) }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('...and the issuer-listed token is allowed, confirmed', ok.allow === true && ok.decision === 'listed' && ok.cross_check.address_in_issuer_list === true)
  const swapped = await createGuard({ retryDelayMs: 0, fetchImpl: listedAs(LISTED, { ...PROOF, issuer: 'robinhood' }) }).beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('an answer that names another issuer\'s list for the chain is not believed', swapped.allow === false && swapped.decision === 'unknown' && /decided by coinbase/.test(swapped.reason))
  let reads = 0, t = 0
  const counting = async (url) => { if (String(url).startsWith('https://api.coinbase.com/')) reads++; return listedAs(LISTED)(url) }
  const g = createGuard({ retryDelayMs: 0, fetchImpl: counting, now: () => t })
  await g.beforeBuy({ chain: 'base', tokenAddress: LISTED }); await g.beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check(`one read of the issuer's list serves ${ISSUER_LIST_TTL_MS / 1000} s of decisions`, reads === 1)
  t = ISSUER_LIST_TTL_MS + 1
  await g.beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('...then it is read again', reads === 2)
  let down = 0, t2 = 0
  const flaky = async (url) => (String(url).startsWith('https://api.coinbase.com/') ? (++down === 1 ? ans(503, {}) : ans(200, ISSUER_BODY)) : listedAs(LISTED)(url))
  const g2 = createGuard({ retryDelayMs: 0, fetchImpl: flaky, now: () => t2 })
  const first = await g2.beforeBuy({ chain: 'base', tokenAddress: LISTED })
  const again = await g2.beforeBuy({ chain: 'base', tokenAddress: LISTED })
  t2 = ISSUER_FAIL_TTL_MS + 1
  const second = await g2.beforeBuy({ chain: 'base', tokenAddress: LISTED })
  check('an issuer that could not be read is "unknown"; the failure is kept briefly (a batch asks once), then asked again', first.allow === false && first.decision === 'unknown' && again.allow === false && down === 2 && second.allow === true, `down=${down}`)
  let failing = 0
  const batchListed = async (url) => { const u = new URL(String(url)); const list = (u.searchParams.get('addresses') || '').split(','); return ans(200, { results: list.map((a) => ({ listed: true, symbol: 'SNDKc', address: a, registries_checked: ['coinbase:base'], impostor: null, registry_age_s: 60 })), list_proof: PROOF }) }
  const g3 = createGuard({ retryDelayMs: 0, now: () => 0, fetchImpl: async (url) => (String(url).startsWith('https://api.coinbase.com/') ? (failing++, ans(503, {})) : batchListed(url)) })
  await g3.beforeBuyMany('base', Array.from({ length: 5 }, () => ({ tokenAddress: LISTED })))
  check('...a batch with the issuer down asks the issuer once, not once per token', failing === 1, `asked ${failing} times`)
  const offOpen = await createGuard({ retryDelayMs: 0, failOpen: true, fetchImpl: listedAs(PREFIXED) }).beforeBuy({ chain: 'base', tokenAddress: PREFIXED })
  check('failOpen never buys a token the issuer\'s own list, read just now, does not have', offOpen.allow === false && offOpen.cross_check.address_in_issuer_list === false && /whatever failOpen says/.test(offOpen.reason))
  const RH = '0x' + '3c'.repeat(20)
  const rhListed = async (url) => (String(url).startsWith('https://proofofstock.xyz') ? ans(200, { listed: true, symbol: 'TSLA', address: RH, registries_checked: ['robinhood:robinhood'], impostor: null, registry_age_s: 60, list_proof: { ...PROOF, issuer: 'robinhood' } }) : ans(200, { assets: [{ deployments: [{ chainId: 4663, contractAddress: '0x' + '4d'.repeat(20) }] }] }))
  check('...on Robinhood too, where there is no prefix to fall back on', (await createGuard({ retryDelayMs: 0, failOpen: true, fetchImpl: rhListed }).beforeBuy({ chain: 'robinhood', tokenAddress: RH })).allow === false)
  const pageA = '0xb2' + '0'.repeat(20) + 'aa'.repeat(9), pageB = '0xb2' + '0'.repeat(20) + 'bb'.repeat(9)
  const paged = async (url) => { const u = new URL(String(url)); return u.searchParams.get('page_token') === 'p2' ? ans(200, { tokens: [{ contract_address: pageB }] }) : ans(200, { tokens: [{ contract_address: pageA }], next_page_token: 'p2' }) }
  const two = await readIssuerList('coinbase', { fetchImpl: paged })
  check('a Coinbase list longer than a page is followed to its end', two.list && two.list.has(pageA) && two.list.has(pageB))
  const endless = await readIssuerList('coinbase', { fetchImpl: async () => ans(200, { tokens: [{ contract_address: pageA }], next_page_token: 'again' }) })
  check(`...but not past ${ISSUER_MAX_PAGES} pages: then no list, never half of one`, endless.list === null)
  check('readIssuerList: an empty or unreadable list is no list', (await readIssuerList('coinbase', { fetchImpl: async () => ans(200, { tokens: [] }) })).list === null && (await readIssuerList('nobody')).list === null)
  const src = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
  check('crossCheck is on by default outside a browser, off in one, a Web Worker or a Service Worker included (no CORS)', /crossCheck = !IN_BROWSER/.test(src) && /typeof globalThis\.window !== 'undefined' && typeof globalThis\.document !== 'undefined'/.test(src) && /typeof globalThis\.WorkerGlobalScope !== 'undefined'/.test(src))
}

console.log('the package')
{
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const cjs = req('./index.mjs'), esm = await import('./index.mjs')
  check('require() and import give the same exports (no build step: Node 20.19+ loads ESM with require)', JSON.stringify(Object.keys(cjs).sort()) === JSON.stringify(Object.keys(esm).sort()))
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  check('package.json: version, types, exports for import and require, the files it ships', pkg.version === VERSION && pkg.types === './index.d.ts' && pkg.exports['.'].require && pkg.exports['.'].import && pkg.files.includes('index.d.ts') && fs.existsSync(new URL('./index.d.ts', import.meta.url)))
  const dts = fs.readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8')
  check('the types name every export', Object.keys(esm).every((k) => new RegExp('\\b' + k + '\\b').test(dts)), Object.keys(esm).filter((k) => !dts.includes(k)).join(','))
}

console.log('the AgentKit action')
{
  const action = guardAction({ fetchImpl })
  const text = await action.invoke({ chain: 'base', tokenAddress: COPY, claimedSymbol: 'SNDKc' })
  check('the action answers in a line that starts with REFUSE and names the contract to use', /^REFUSE \(impostor\):/.test(text) && text.includes('Use instead: ' + LISTED))
  check('...ALLOW for the listed one', /^ALLOW \(listed\)/.test(await action.invoke({ chain: 'base', tokenAddress: LISTED })))
  check('the input schema requires chain and address and allows only the two chains', ACTION_INPUT_SCHEMA.required.join() === 'chain,tokenAddress' && ACTION_INPUT_SCHEMA.properties.chain.enum.join() === 'base,robinhood')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
