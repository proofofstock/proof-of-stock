// apps/list-gate.test.mjs: the list locks (docs/list-locks-tz.md v3) on the served routes. A record on the issuer's list
// is called listed only when the chain backs it: the pinned Base prefix, and the issuer's factory having created it
// (confirmed by a second RPC where there is one). Anything else gets no verdict, never "listed" and never "not listed",
// on every route that says "listed"; a held original is never offered instead of a look-alike; the archive and
// list_proof stay what the issuer served; a restart cannot turn a fresh listing into a conflict or a conflict into an
// awaiting one; and the production entry point runs with the locks on.
//
// Run: node apps/list-gate.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb } from './stocks-web.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../evm/core/stocks/registries.mjs'
import { MIRRORS } from '../scripts/stocks/issuer-mirror.mjs'
import { trustOf, CONFIRM_MS, ISSUER_ADDRESS_PREFIX, issuerPrefixOf } from '../evm/core/stocks/verify.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const P = ISSUER_ADDRESS_PREFIX.base
const B = (n) => P + n.toString(16).padStart(18, '0')
const OK = B(1), NEW = B(2), OLD = B(3), SECONDLESS = B(5), REV = B(6), FOREIGN = '0x' + 'fe'.repeat(20), STRANGER = B(0x99), R = '0x' + 'cc'.repeat(20)
const IMP_NEW = '0x' + '1a'.repeat(20), IMP_OK = '0x' + '1b'.repeat(20)
const NOW = Date.parse('2026-11-25T14:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const H = (c) => '0x' + c.repeat(32)
const tok = (address, extra = {}) => ({ address, block: MIRRORS.base.from_block + 10, block_hash: H('d2'), tx: H('bb'), log_index: 1, ...extra })
const lastOk = (over = {}) => ({ at: iso(NOW - 5 * 60e3), started_at: iso(NOW - 6 * 60e3), target_block: MIRRORS.base.from_block + 1000, target_block_time: iso(NOW - 20 * 60e3), ...over })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'list-gate-'))
function roots (name, { baseMirror = 'good', archive = true } = {}) {
  const base = path.join(tmp, name, 'base'), rh = path.join(tmp, name, 'rh')
  for (const r of [base, rh]) fs.mkdirSync(path.join(r, 'stock-peg', 'history'), { recursive: true })
  const mirror = { schema: 2, chain: 'base', issuer: 'coinbase', factory: MIRRORS.base.factory, topic0: MIRRORS.base.topic0, from_block: MIRRORS.base.from_block, scanned_to: MIRRORS.base.from_block + 1000, sources: 2,
    tokens: [tok(OK, { second_at: iso(NOW - 3600e3) }), tok(SECONDLESS)], revoked: [{ ...tok(REV), revoked_at: iso(NOW - 3600e3), why: 'the transaction is in another block now' }], last_ok: lastOk(), last_error: null, updated_at: iso(NOW - 5 * 60e3) }
  if (baseMirror === 'good') fs.writeFileSync(path.join(base, 'stock-peg', 'mirror.json'), JSON.stringify(mirror))
  if (baseMirror === 'stale') fs.writeFileSync(path.join(base, 'stock-peg', 'mirror.json'), JSON.stringify({ ...mirror, last_ok: lastOk({ at: iso(NOW - 5 * 3600e3), started_at: iso(NOW - 5 * 3600e3 - 60e3), target_block_time: iso(NOW - 5 * 3600e3 - 900e3) }), last_error: 'rpc down', updated_at: iso(NOW - 60e3) }))
  fs.writeFileSync(path.join(rh, 'stock-peg', 'mirror.json'), JSON.stringify({ schema: 2, chain: 'robinhood', issuer: 'robinhood', factory: MIRRORS.robinhood.factory, topic0: MIRRORS.robinhood.topic0, from_block: 0, scanned_to: 1000, sources: 1, tokens: [tok(R, { block: 10 })], last_ok: lastOk({ target_block: 1000 }), last_error: null, updated_at: iso(NOW) }))
  // The registry archive: every Base record but NEW was on the list three hours ago.
  if (archive) fs.writeFileSync(path.join(base, 'stock-peg', 'history', 'registry-2026-11-25.jsonl'), JSON.stringify({ _schema_version: '1.0', chain_id: 8453, issuer: 'coinbase', fetched_at: iso(NOW - 3 * 3600e3), hash: 'sha256:' + 'a'.repeat(64), prev_hash: null, records: 5, added: [], removed: [], changed: [], body: [OK, OLD, SECONDLESS, REV, FOREIGN].map((address) => ({ address })) }) + '\n')
  fs.writeFileSync(path.join(base, 'stock-peg', 'pool-book.json'), JSON.stringify({ pools: {}, decimals: Object.fromEntries([OK, NEW, OLD, SECONDLESS, REV, FOREIGN].map((a) => [a, 8])) }))
  fs.writeFileSync(path.join(rh, 'stock-peg', 'pool-book.json'), JSON.stringify({ pools: {}, decimals: { [R]: 18 } }))
  fs.writeFileSync(path.join(base, 'stock-peg', 'stock-names.json'), JSON.stringify({ generated_at: iso(NOW - 3600e3), chain: 'base', count: 2, names: { [IMP_NEW]: ['NEWc', 'New Inc.'], [IMP_OK]: ['OKc', 'Ok Inc.'] } }))
  fs.writeFileSync(path.join(base, 'stock-peg', 'impostors.json'), JSON.stringify({ generated_at: iso(NOW - 3600e3), chain: 'base', listed: 2, counts: {}, note: 'n', items: [
    { address: IMP_NEW, symbol: 'NEWc', name: 'New', kind: 'registry_symbol', ticker: 'NEW', registry_symbol: 'NEWc', registry_address: NEW, first_seen_at: iso(NOW - 3600e3) },
    { address: IMP_OK, symbol: 'OKc', name: 'Ok', kind: 'registry_symbol', ticker: 'OK', registry_symbol: 'OKc', registry_address: OK, first_seen_at: iso(NOW - 3600e3) }] }))
  return { base, robinhood: rh }
}
const rec = (address, symbol, isin = 'US0000000000') => ({ contract_address: address, symbol, name: symbol + ' Inc.', isin, multiplier: '1', nav_price: '10', nav_price_updated_at: iso(NOW - 3600e3), total_supply: '5' })
let outsideCalls = 0 // simulate_buy's quotes and RPC: none may be made for a held record
const fetchImpl = async (url) => {
  const u = String(url)
  if (/aggregator-api\.kyberswap\.com|mainnet\.base\.org|rpc\.mainnet\.chain\.robinhood\.com/.test(u)) outsideCalls++
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (u.startsWith(COINBASE_URL)) return ok({ tokens: [rec(OK, 'OKc'), rec(NEW, 'NEWc', 'US0000000N01'), rec(OLD, 'OLDc'), rec(SECONDLESS, 'SECc'), rec(REV, 'REVc'), rec(FOREIGN, 'FRNc')] })
  if (u.startsWith(ROBINHOOD_ASSETS_URL)) return ok({ assets: [{ tokenSymbol: 'TSLA', tokenName: 'Tesla Robinhood Token', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: R }] }] })
  if (u.startsWith(ROBINHOOD_PRICES_URL)) return ok({ quotes: [] })
  return { ok: false, status: 404, json: async () => ({}) }
}
async function serve (r, t = () => NOW) {
  const app = createStocksWeb({ roots: r, fetchImpl, now: t, log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module: null })
  const { port } = await app.start(0, '127.0.0.1')
  const get = async (p, headers = {}) => { const res = await fetch(`http://127.0.0.1:${port}/stocks${p}`, { headers }); const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch (_) {} return { status: res.status, json, text } }
  const mcp = async (name, args, h = {}) => (await (await fetch(`http://127.0.0.1:${port}/stocks/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...h }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result
  return { app, get, mcp }
}

console.log('the rule (trustOf), fixed before building')
{
  const m = { tokens: [tok(OK)], revoked: [], last_ok: lastOk(), sources: 1 }
  const t = (address, extra = {}) => trustOf({ chain: 'base', address, mirror: m, firstListedAt: NOW - 3 * 3600e3, now: NOW, ...extra })
  check('created by the factory: trusted', t(OK).trusted === true)
  check('no issuer prefix on Base: held, whatever else is true', t(FOREIGN).reason === 'issuer_prefix_mismatch' && trustOf({ chain: 'base', address: FOREIGN, mirror: { ...m, tokens: [tok(FOREIGN)] }, now: NOW }).reason === 'issuer_prefix_mismatch')
  check('no mirror, or one that never reached a finalized block: held, factory check unavailable', t(OK, { mirror: null }).reason === 'factory_check_unavailable' && t(OK, { mirror: { ...m, last_ok: null } }).reason === 'factory_check_unavailable')
  check('not created, the listing covered by a scan, past CONFIRM_MS: a conflict', t(OLD).reason === 'factory_conflict')
  check('not created, the listing newer than the last scan: awaiting, never a conflict', t(NEW, { firstListedAt: NOW - 60e3 }).reason === 'awaiting_factory_confirmation')
  check('...within CONFIRM_MS of the covering scan: still awaiting', t(NEW, { firstListedAt: Date.parse(m.last_ok.at) - CONFIRM_MS + 60e3, mirror: { ...m, last_ok: lastOk({ started_at: iso(Date.parse(m.last_ok.at) - CONFIRM_MS + 2 * 60e3) }) } }).reason === 'awaiting_factory_confirmation')
  check('...no first-listed time at all: awaiting', t(NEW, { firstListedAt: null }).reason === 'awaiting_factory_confirmation')
  check('a creation taken back: a conflict at once', t(REV, { mirror: { ...m, revoked: [{ address: REV, revoked_at: iso(NOW), why: 'x' }] } }).reason === 'factory_conflict')
  check('two RPC sources: created but not confirmed by the second is awaiting', t(SECONDLESS, { mirror: { ...m, sources: 2, tokens: [tok(SECONDLESS)] } }).reason === 'awaiting_factory_confirmation' && t(OK, { mirror: { ...m, sources: 2, tokens: [tok(OK, { second_at: iso(NOW) })] } }).trusted)
  check('Robinhood has no prefix: only the factory decides', trustOf({ chain: 'robinhood', address: R, mirror: { ...m, tokens: [tok(R)] }, firstListedAt: null, now: NOW }).trusted === true)
  check('the Base prefix is pinned, never derived: one foreign address in a list does not lift it', issuerPrefixOf([{ address: OK }, { address: FOREIGN }], 'base') === P && issuerPrefixOf([{ address: OK }, { address: FOREIGN }]) === null)
}

console.log('served, with the locks on (the default)')
const r1 = roots('main')
const s1 = await serve(r1)
try {
  const v = async (a) => s1.get(`/verify?chain=base&address=${a}`)
  const ok = await v(OK)
  check('a trusted record: listed', ok.status === 200 && ok.json.listed === true && ok.json.symbol === 'OKc')
  for (const [a, reason] of [[NEW, 'awaiting_factory_confirmation'], [OLD, 'factory_conflict'], [FOREIGN, 'issuer_prefix_mismatch'], [REV, 'factory_conflict'], [SECONDLESS, 'awaiting_factory_confirmation']]) {
    const x = await v(a)
    check(`a held record (${reason}): 503, no verdict, never listed or not listed`, x.status === 503 && x.json.reason === reason && !('listed' in x.json) && /no verdict/.test(x.json.error), JSON.stringify(x.json))
  }
  const st = await v(STRANGER)
  check('an address not on the list at all: not listed, as before, with the pinned prefix noted', st.status === 200 && st.json.listed === false && st.json.issuer_like_address?.prefix === P)
  const batchOk = await s1.get(`/verify?chain=base&addresses=${OK},${STRANGER}`)
  const batchHeld = await s1.get(`/verify?chain=base&addresses=${OK},${NEW}`)
  check('a batch with a held record fails closed as a whole, naming it; one without answers', batchOk.status === 200 && batchOk.json.results.length === 2 && batchHeld.status === 503 && batchHeld.json.address === NEW && batchHeld.json.reason === 'awaiting_factory_confirmation')
  const badge = await s1.get(`/badge.svg?chain=base&address=${OLD}`)
  check('the badge of a held record is never green', badge.status === 200 && !badge.text.includes('✓') && badge.text.includes('?'))
  const pOk = await s1.get(`/api/passport?chain=base&address=${OK}`), pNew = await s1.get(`/api/passport?chain=base&address=${NEW}`)
  check('the passport: a trusted record is in the registry; a held one gets no passport, never in_registry false', pOk.status === 200 && pOk.json.in_registry === true && pNew.status === 503 && pNew.json.reason === 'awaiting_factory_confirmation' && !('in_registry' in pNew.json))
  const find = await s1.get('/api/find?q=NEWc'), findOk = await s1.get('/api/find?q=OKc')
  check('find: a held record is no match, but it is named as held, with its reason and no verdict (outside review, 25.11)', find.json.matches.length === 0 && find.json.held?.[0]?.address === NEW && find.json.held[0].reason === 'awaiting_factory_confirmation' && /no verdict/.test(find.json.held_note) && JSON.stringify(findOk.json.matches).includes(OK) && !findOk.json.held)
  const pImp = await s1.get(`/api/passport?chain=base&address=${IMP_NEW}`), pImpOk = await s1.get(`/api/passport?chain=base&address=${IMP_OK}`)
  check('the passport of a copy of a held listing still resembles it, without naming the held original', pImp.status === 200 && pImp.json.resembles?.registry_symbol === 'NEWc' && pImp.json.resembles.registry_address === null && pImpOk.json.resembles?.registry_address === OK, JSON.stringify(pImp.json.resembles))
  const mcpBatch = await s1.mcp('verify_stock_tokens', { chain: 'base', addresses: [OK, NEW] })
  check('MCP verify_stock_tokens: a batch with a held address fails closed, naming it and why', mcpBatch.isError === true && mcpBatch.content[0].text.includes(NEW) && /awaiting_factory_confirmation/.test(mcpBatch.content[0].text))
  const mcpFind = await s1.mcp('find_stock_token', { query: 'NEWc', chain: 'base' })
  check('MCP find_stock_token names the held record too', JSON.stringify(mcpFind.structuredContent || {}).includes(NEW))
  const tl = await s1.get('/tokenlist.json')
  const tlAddrs = (tl.json && tl.json.tokens || []).map((t) => String(t.address).toLowerCase())
  check('/tokenlist.json carries trusted records only (the same source as every other route)', tl.status === 200 && tlAddrs.includes(OK) && ![NEW, OLD, SECONDLESS, REV, FOREIGN].some((a) => tlAddrs.includes(a)), JSON.stringify([tl.status, tlAddrs.length]))
  const sitemap = await s1.get('/sitemap.xml')
  check('the sitemap lists trusted records only', sitemap.text.includes('OKc') && !sitemap.text.includes('NEWc') && !sitemap.text.includes('OLDc'))
  // simulate_buy goes through the same gate (docs/simulate-buy-tz.md §4.1): a held record gets the 503 with its reason,
  // by address and by ticker, over HTTP and MCP, and no aggregator or RPC call is made for it.
  outsideCalls = 0
  const own = { 'x-real-ip': '198.51.100.40' } // a client of its own: the 10 units each leave the shared one's minute alone
  const simNew = await s1.get(`/api/simulate?chain=base&token=${NEW}&usd=25`, own), simTick = await s1.get('/api/simulate?chain=base&token=NEWc&usd=25', own)
  const simMcp = await s1.mcp('simulate_buy', { chain: 'base', token: OLD, usd: 25 }, own)
  // ...and by an alias find_stock_token also takes as exact: the bare ticker, the ISIN. A collision with trusted records
  // on the same words is ambiguous, never a quote for the trusted one.
  const simBare = await s1.get('/api/simulate?chain=base&token=NEW&usd=25', own), simIsin = await s1.get('/api/simulate?chain=base&token=US0000000N01&usd=25', own)
  const simShared = await s1.get('/api/simulate?chain=base&token=US0000000000&usd=25', { 'x-real-ip': '198.51.100.41' })
  check('simulate_buy: a held record reached by its bare ticker or its ISIN still gets the 503 with its reason', simBare.status === 503 && simBare.json.reason === 'awaiting_factory_confirmation' && simIsin.status === 503 && simIsin.json.reason === 'awaiting_factory_confirmation', JSON.stringify([simBare.status, simBare.json, simIsin.status]))
  check('...and an ISIN shared by trusted and held records is ticker_ambiguous, the held ones among the candidates, no quote', simShared.status === 200 && simShared.json.verdict.reason === 'ticker_ambiguous' && simShared.json.verdict.candidates.some((c) => c.held) && outsideCalls === 0, JSON.stringify(simShared.json?.verdict))
  check('simulate_buy: a held record is refused with the 503 and its reason, never "not listed", and no outside call', simNew.status === 503 && simNew.json.reason === 'awaiting_factory_confirmation' && !('outcome' in simNew.json) && simTick.status === 503 && simTick.json.reason === 'awaiting_factory_confirmation' && simMcp.isError === true && /factory_conflict/.test(simMcp.content[0].text) && outsideCalls === 0, JSON.stringify([simNew.json, simTick.json, outsideCalls]))
  const pageNew = await s1.get('/?base=NEWc'), pageOk = await s1.get('/?base=OKc')
  check('the ?base=SYM page resolves a trusted record and never a held one', /rel="canonical" href="[^"]*\?base=OKc"/.test(pageOk.text) && !/\?base=NEWc"/.test(pageNew.text) && !pageNew.text.includes(NEW))
  const today = '2026-11-25'
  const arcOld = await s1.get(`/api/archive/at?chain=base&address=${OLD}&date=${today}`), arcOk = await s1.get(`/api/archive/at?chain=base&address=${OK}&date=${today}`)
  check('the archive never quotes a record the chain contradicts now as LISTED', arcOld.status === 200 && /^ON THE ISSUER'S LIST AS SERVED, NO VERDICT/.test(arcOld.json.summary) && arcOld.json.held_now?.reason === 'factory_conflict' && /^LISTED:/.test(arcOk.json.summary) && !arcOk.json.held_now, JSON.stringify([arcOld.status, arcOld.json?.summary]))
  const imp1 = await v(IMP_NEW), imp2 = await v(IMP_OK)
  check('a look-alike of a held original: still a look-alike, but the original is not offered instead', imp1.json.impostor && imp1.json.impostor.listed_address === null && imp2.json.impostor.listed_address === OK)
  const imps = await s1.get('/api/impostors?chain=base')
  const items = imps.json.chains.base.items
  check('/api/impostors: a held original is not named, and says why', items.find((i) => i.address === IMP_NEW).registry_address === null && items.find((i) => i.address === IMP_NEW).listed_address_held === 'awaiting_factory_confirmation' && items.find((i) => i.address === IMP_OK).registry_address === OK)
  const stNew = (await s1.get('/api/status')).json
  const sbNew = stNew.chains?.base || stNew.base
  check('a record not in the archive is first listed at the server\'s first good read of it, not at an unknown time', sbNew.held.find((h) => h.address === NEW)?.since === iso(NOW))
  const status = await s1.get('/api/status')
  const sb = status.json.chains?.base || status.json.base || (Array.isArray(status.json.chains) ? status.json.chains.find((c) => c.chain === 'base') : null)
  check('/api/status: the factory check and the held records, conflicts first', sb && sb.factory_check.state === 'ok' && sb.factory_check.rpc_sources === 2 && sb.held_count === 5 && sb.held_conflicts === 3 && sb.held[0].reason !== 'awaiting_factory_confirmation', JSON.stringify(sb && { fc: sb.factory_check, n: sb.held_count, c: sb.held_conflicts }))
  const proof = ok.json.list_proof
  check('list_proof still hashes the list as the issuer served it: every record, held ones included', proof && proof.addresses === 6)
  const rh = await s1.get(`/verify?chain=robinhood&address=${R}`)
  check('Robinhood: a record its factory created is listed, with no prefix to check', rh.status === 200 && rh.json.listed === true)
} finally { await s1.app.stop() }

console.log('the staleness edge (outside review, 25.11)')
{
  let t = NOW
  const s5 = await serve(roots('edge'), () => t)
  try {
    t = NOW + 900_200 // older than 900 s by the millisecond, 900 s when rounded: one rule must decide both
    const a = await s5.get(`/verify?chain=base&address=${OK}`), b = await s5.get(`/verify?chain=base&address=${NEW}`), c = await s5.get(`/verify?chain=base&address=${FOREIGN}`)
    check('at the freshness edge a held record is never answered listed: one freshness rule for both checks', b.status === 503 && c.status === 503 && !(b.json && b.json.listed) && !(c.json && c.json.listed) && (a.status === 503 || a.json.listed === true), JSON.stringify([a.status, b.status, c.status]))
    t = NOW + 901_000
    const d = await s5.get(`/verify?chain=base&address=${OK}`), e = await s5.get(`/verify?chain=base&address=${NEW}`)
    check('...and past it, every record gets "registry unavailable", the trusted ones too', d.status === 503 && e.status === 503 && !d.json.reason && !e.json.reason)
  } finally { await s5.app.stop() }
}

console.log('a restart, a stale mirror, no mirror')
{
  const s2 = await serve(r1, () => NOW + 60e3)
  try {
    const a = await s2.get(`/verify?chain=base&address=${OLD}`), b = await s2.get(`/verify?chain=base&address=${NEW}`)
    check('after a restart a conflict is still a conflict (its first-listed time is in the archive) and a fresh listing still awaiting', a.json.reason === 'factory_conflict' && b.json.reason === 'awaiting_factory_confirmation')
  } finally { await s2.app.stop() }
  const s3 = await serve(roots('stale', { baseMirror: 'stale' }))
  try {
    const a = await s3.get(`/verify?chain=base&address=${OK}`), b = await s3.get(`/verify?chain=base&address=${OLD}`), c = await s3.get(`/verify?chain=base&address=${REV}`)
    check('a mirror behind and failing: a recorded creation stays trusted, a conflict stays held, a revoked one stays held', a.json.listed === true && b.status === 503 && c.json.reason === 'factory_conflict')
  } finally { await s3.app.stop() }
  const s4 = await serve(roots('none', { baseMirror: 'none' }))
  try {
    const a = await s4.get(`/verify?chain=base&address=${OK}`), st = await s4.get('/api/status')
    const sb = st.json.chains?.base || st.json.base || (Array.isArray(st.json.chains) ? st.json.chains.find((c) => c.chain === 'base') : null)
    check('no mirror: every Base record is held (fail closed), and status says the factory check is unavailable', a.status === 503 && a.json.reason === 'factory_check_unavailable' && sb.factory_check.state === 'unavailable')
  } finally { await s4.app.stop() }
}

console.log('the production entry point')
{
  const src = fs.readFileSync(new URL('./stocks-web.mjs', import.meta.url), 'utf8')
  check('the server starts with no options, so with the locks on', /\n  const app = createStocksWeb\(\)\n/.test(src) && /\n  listLocks = true,\n/.test(src))
  check('no environment variable can switch the locks off', !/listLocks\s*=\s*process\.env/.test(src) && !/process\.env\.[A-Z_]*LIST_?LOCK/.test(src))
  check('no route reads the raw list to say listed: verdicts go through listedRecords; the passport is built only after its held check', !/reg\.records\.some\(/.test(src) && !/records: registries\.get\(c\)\?\.records/.test(src) && src.indexOf('if (held) return { status: 503,') < src.indexOf('registry: lr.raw,') && /\(listLocks \? null : reg\.records\)/.test(src) && /return registryFresh\(r\) \? r\.records : null/.test(src))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
