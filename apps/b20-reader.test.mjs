// apps/b20-reader.test.mjs: the reads of the B20 transfer rules against a fake node (docs/b20-transfers-tz.md §1, §5,
// §7). Every call is pinned by block hash with requireCanonical; a reading is as old as its block's header time, so a
// lagging node is stale, never "read now"; a head below the last one used is refused; a short or malformed aggregate3
// answer is a failed read; policyExists is asked before isAuthorized and once per id; an unknown id is never asked
// isAuthorized; a node that fails gives the second RPC its turn, and both failing is `unknown`, never `open`; a change
// is one journal line and one entry for health-check, once, and a failed sub-call never hides a change.
//
// No outside call is made: every request goes to apps/simulate/fake-b20.mjs.
//
// Run: node apps/b20-reader.test.mjs
import { createB20Reader, rpcPairOf, walletPolicy, VENUE_ROUTERS, decodeAggregate3Strict, mergeBaseline } from './b20-reader.mjs'
import { createB20Chain, b20Node } from './simulate/fake-b20.mjs'
import { transfersOf, ORDINARY_WALLET } from '../evm/core/stocks/b20.mjs'
import { encodeAggregate3Result } from '../scripts/stocks/onchain-pools.mjs'
import { KYBER_ROUTER } from '../packages/proofofstock-guard/examples/agent-buy.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

// Synthetic tokens, pools and ids.
const tok = (n) => '0xb2000000000000000000' + String(n).repeat(20).slice(0, 20)
const T1 = tok(1), T2 = tok(2), T3 = tok(3), T4 = tok(4), T5 = tok(5)
const POOL = '0x' + '9c'.repeat(20)
const A = 'http://rpc-a.test', B = 'http://rpc-b.test'
const env = { STP_LOGS_RPC_BASE: A, STP_VERIFY_RPC_BASE: B }
let clock = Date.parse('2026-12-01T15:00:00Z')
const now = () => clock
const zero = { sender: '0', receiver: '0', executor: '0' }
const venues = [KYBER_ROUTER, ...VENUE_ROUTERS.aerodromeRouters, POOL, '0x498581ff718922c3f8e6a244956af099b2652b2b']
function setup () {
  const chain = createB20Chain({
    tokens: {
      [T1]: { policies: zero, paused: false },
      [T2]: { policies: { ...zero, receiver: '9' }, paused: false },
      [T3]: { policies: { ...zero, executor: '4' }, paused: false },
      [T4]: { policies: { ...zero, receiver: '9' }, paused: false },
      [T5]: { policies: { ...zero, receiver: '77' }, paused: false },
    },
    kinds: { 9: { type: 'allow', members: venues }, 4: { type: 'block', members: [KYBER_ROUTER] }, 'unknown:77': true },
  })
  const node = b20Node(chain, { now })
  const logs = []
  const reader = createB20Reader({ fetchImpl: node.fetchImpl, env, now, log: (m) => logs.push(m) })
  const records = [T1, T2, T3, T4, T5].map((address, i) => ({ address, symbol: 'S' + (i + 1) + 'c', paused: [] }))
  const cycle = async () => { node.head++; clock += 300e3; await reader.refresh(records, { poolsOf: () => [POOL] }) }
  return { chain, node, reader, logs, records, cycle, changes: () => reader.changes(), journal: () => logs.filter((m) => /^\[b20\] \d{4}-\d\d-\d\dT.*changed/.test(m)) }
}
const block = (r, t, listPaused = []) => transfersOf(r.get(t), { now: clock, listPaused })

console.log('the RPC pair')
{
  check('the factory mirror\'s pair: its log source, then its second RPC', JSON.stringify(rpcPairOf(env)) === JSON.stringify([A, B]))
  check('unset, the built-in pair, and the same URL is not asked twice', rpcPairOf({}).length === 2 && rpcPairOf({ STP_LOGS_RPC_BASE: A, STP_VERIFY_RPC_BASE: A }).length === 1)
}

console.log('the strict aggregate3 decoder')
{
  const good = encodeAggregate3Result([{ success: true, data: '0x' + '00'.repeat(32) }, { success: true, data: '0x' + '00'.repeat(64) }])
  check('a well-formed answer decodes', decodeAggregate3Strict(good, 2).length === 2)
  const throws = (h, n) => { try { decodeAggregate3Strict(h, n); return false } catch (_) { return true } }
  check('the last payload declared 64 bytes but one word supplied: refused', throws(good.slice(0, -64), 2))
  const badWord = good.replace(/0{63}1(0{62}40)/, '0'.repeat(63) + '2$1')
  check('a success word that is not 0 or 1: refused', badWord !== good && throws(badWord, 2))
  check('a count other than the calls asked: refused', throws(good, 3))
  check('not hex, or an odd length: refused', throws('0xzz', 0) && throws(good + '0', 2))
}

console.log('one cycle')
{
  const s = setup()
  await s.cycle()
  const calls = s.chain.calls
  check('every eth_call is aggregate3 at the pinned block hash, canonical only', s.node.requests.filter((q) => q.method === 'eth_call').every((q) => q.params[1] && q.params[1].blockHash && q.params[1].requireCanonical === true) && s.node.hashTags === s.node.requests.filter((q) => q.method === 'eth_call').length && s.node.hashTags > 0)
  check('isPaused asks TRANSFER (0) of every token', calls.filter((c) => c.kind === 'isPaused').length === 5 && calls.filter((c) => c.kind === 'isPaused').every((c) => c.feature === 0))
  const ex = calls.filter((c) => c.kind === 'policyExists'), au = calls.filter((c) => c.kind === 'isAuthorized')
  check('policyExists is asked first: every one in an earlier batch than any isAuthorized', ex.length && au.length && Math.max(...ex.map((c) => c.batch)) < Math.min(...au.map((c) => c.batch)))
  check('once per id: id 9, shared by two tokens, is asked policyExists once; 0 never', ex.filter((c) => c.id === '9').length === 1 && !ex.some((c) => c.id === '0'))
  const pairs = au.map((c) => c.id + '|' + c.account)
  check('...and each (id, account) isAuthorized once', new Set(pairs).size === pairs.length)
  check('an unknown id is never asked isAuthorized', !au.some((c) => c.id === '77'))
  check('all-zero policies: open, stamped with the block\'s own time', block(s.reader, T1).state === 'open' && s.reader.get(T1).read_at === Math.floor(clock / 1000) * 1000)
  check('an allowlist without the ordinary wallet: restricted, ordinary_wallet_refused', block(s.reader, T2).state === 'restricted' && block(s.reader, T2).reason === 'ordinary_wallet_refused' && block(s.reader, T4).state === 'restricted')
  const t3 = block(s.reader, T3)
  check('the KyberSwap router blocked as executor: restricted, venue_refused, that venue allowed false', t3.state === 'restricted' && t3.reason === 'venue_refused' && t3.venues.find((v) => v.name === 'kyberswap_router').allowed === false)
  check('the unknown id that answers true for everyone: unknown, policy_missing', block(s.reader, T5).state === 'unknown' && block(s.reader, T5).reason === 'policy_missing')
  check('the pool from the book is named, sender and executor', s.reader.get(T1).accounts.some((a) => a.name === 'pool' && a.address === POOL) && s.reader.get(T1).accounts.some((a) => a.address === ORDINARY_WALLET))
  check('the first cycle compares with nothing: no change', s.changes().length === 0)
  check('a cycle in flight is not started twice', s.reader.refresh(s.records) === s.reader.refresh(s.records))
}

console.log('an old, short or lower answer is no reading')
{
  const s = setup()
  s.node.lagS = 3600
  await s.cycle()
  check('a node whose head is an hour old: unknown, stale, never "read now"', block(s.reader, T1).state === 'unknown' && block(s.reader, T1).reason === 'stale' && block(s.reader, T1).age_s >= 3600)
  s.node.lagS = -3600
  await s.cycle()
  check('a node whose head is an hour ahead of our clock: refused, read_failed, never fresh for an hour', block(s.reader, T1).reason === 'read_failed')
  s.node.lagS = 0
  await s.cycle()
  check('...and the next good head is read again', block(s.reader, T1).state === 'open')
  const top = s.node.head
  s.node.down.add(A); s.node.heads.set(B, top - 10)
  await s.cycle()
  check('the first node down, the second behind the last block used: refused, read_failed, never an old state as new', block(s.reader, T1).reason === 'read_failed' && s.changes().length === 0)
  s.node.down.clear(); s.node.heads.clear()
  const t = setup()
  t.node.mangle = (out) => out.slice(0, -64)
  await t.cycle()
  check('a truncated aggregate3 answer: read_failed on both nodes, never open', block(t.reader, T1).state === 'unknown' && block(t.reader, T1).reason === 'read_failed')
}

console.log('a node that fails')
{
  const s = setup()
  s.node.down.add(A)
  await s.cycle()
  check('the first RPC down: the second answers, and the reading is good', block(s.reader, T1).state === 'open' && s.node.requests.some((q) => q.url === B))
  s.node.down.add(B)
  await s.cycle()
  check('both down: every token unknown, read_failed, never open', [T1, T2, T3].every((t) => block(s.reader, t).state === 'unknown' && block(s.reader, t).reason === 'read_failed'))
  check('...said in the journal, without the URL', s.logs.some((m) => m.startsWith('[b20] read failed')) && !s.logs.some((m) => m.includes(A) || m.includes(B)))
  check('...and the baseline is kept for the next comparison', s.reader.lastGood(T1) && !s.reader.lastGood(T1).error)
  s.node.down.clear()
  await s.cycle()
  check('a good read after a failed one, with nothing changed: no change', s.changes().length === 0)
  const g = setup()
  g.chain.garbage = true
  await g.cycle()
  check('ids that do not decode: unknown, undecodable', block(g.reader, T1).state === 'unknown' && block(g.reader, T1).reason === 'undecodable')
}

console.log('a change, once')
{
  const s = setup()
  await s.cycle(); await s.cycle()
  check('two cycles, nothing changed: no change', s.changes().length === 0 && s.journal().length === 0)
  s.chain.kinds[9] = { type: 'allow', members: [...venues, ORDINARY_WALLET] }
  await s.cycle()
  const c = s.changes()
  check('the allowlist now takes the ordinary wallet: one change per token that uses it (T2, T4), scope and both values', c.length === 2 && c.every((x) => x.kind === 'answer' && x.scope === 'receiver' && x.account === 'ordinary_wallet' && x.from === false && x.to === true) && c.map((x) => x.token).sort().join() === [T2, T4].sort().join())
  check('...each with its block and time, and one dated journal line per token', c.every((x) => Number.isInteger(x.block) && /^\d{4}-/.test(x.at)) && s.journal().length === 2)
  await s.cycle()
  check('the next cycle, the same rules: no new change', s.changes().length === 2)
  s.chain.tokens[T1].paused = true
  await s.cycle()
  check('transfers paused: one change naming it', s.changes().length === 3 && s.changes()[2].kind === 'paused' && s.changes()[2].to === true)
  check('...and the pause the issuer\'s list does not say is a journal line, once', s.logs.filter((m) => m.includes('the issuer\'s list says not paused')).length === 1)
  await s.cycle()
  check('...not again next cycle', s.changes().length === 3 && s.logs.filter((m) => m.includes('the issuer\'s list says not paused')).length === 1)
  s.chain.tokens[T1].paused = false
  await s.cycle()
  check('unpaused: one change', s.changes().length === 4 && s.changes()[3].to === false)
  s.chain.tokens[T3].policies = { ...zero, executor: '0' }
  await s.cycle()
  check('a bound id changes: said for that token', s.changes().some((x) => x.token === T3 && x.kind === 'policy_id' && x.from === '4' && x.to === '0'))
  check('no change carries a wallet: only our own accounts', s.changes().every((x) => x.address == null || [...venues, ORDINARY_WALLET].includes(x.address)))
}

console.log('a failed sub-call never hides a change')
{
  const s = setup()
  await s.cycle()
  // KyberSwap's router is allowed by id 9 as receiver; it leaves the allowlist while its own isAuthorized fails.
  s.chain.kinds[9] = { type: 'allow', members: venues.filter((v) => v !== KYBER_ROUTER) }
  s.chain.failAuth.add('9|' + KYBER_ROUTER)
  await s.cycle()
  check('the cycle whose sub-call failed: no change said, and the baseline keeps the last answer read', s.changes().length === 0 && s.reader.lastGood(T2).auth['9|' + KYBER_ROUTER] === true)
  s.chain.failAuth.clear()
  await s.cycle()
  const c = s.changes()
  check('the next good read: the change is said (allowed -> refused)', c.length === 2 && c.every((x) => x.address === KYBER_ROUTER && x.from === true && x.to === false))
  const m = mergeBaseline({ policies: { sender: '1', receiver: '2', executor: '0' }, paused: false, exists: { 1: true, 2: true }, auth: { '1|0xa': true } }, { policies: { sender: null, receiver: '3', executor: '0' }, paused: null, exists: { 3: true }, auth: { '1|0xa': null }, accounts: [{ address: '0xa', scopes: ['sender', 'receiver'] }] })
  check('the baseline: an id that did not decode and a pause that did not decode keep theirs; a moved id does not inherit answers', m.policies.sender === '1' && m.policies.receiver === '3' && m.paused === false && m.auth['1|0xa'] === true && m.auth['3|0xa'] === null)
}

console.log('the wallet check of simulate_buy')
{
  const s = setup()
  await s.cycle()
  const W = '0x' + '11'.repeat(20)
  const before = s.node.requests.length
  const r = await walletPolicy({ fetchImpl: s.node.fetchImpl, url: A, token: T2, wallet: W, reading: s.reader.get(T2), now })
  const asked = s.node.requests.slice(before)
  check('a wallet outside the receiver allowlist: receive false, send true (sender is 0)', r && r.receive === false && r.send === true && r.head_block === s.node.head)
  check('...one block pin and one eth_call, at that block\'s hash, canonical only', asked.length === 2 && asked[1].method === 'eth_call' && asked[1].params[1].blockHash && asked[1].params[1].requireCanonical === true)
  s.chain.kinds[9] = { type: 'allow', members: [W] }
  check('a wallet on the allowlist: receive true', (await walletPolicy({ fetchImpl: s.node.fetchImpl, url: A, token: T2, wallet: W, reading: s.reader.get(T2), now })).receive === true)
  s.node.lagS = 3600
  check('a head an hour old by its header time: nothing is said', (await walletPolicy({ fetchImpl: s.node.fetchImpl, url: A, token: T2, wallet: W, reading: s.reader.get(T2), now })) === null)
  s.node.lagS = 0
  s.node.heads.set(A, s.node.head - 5)
  check('a head below the reading\'s block: nothing is said', (await walletPolicy({ fetchImpl: s.node.fetchImpl, url: A, token: T2, wallet: W, reading: s.reader.get(T2), now })) === null)
  s.node.heads.clear()
  s.chain.tokens[T2].policies = { ...zero, receiver: '4' }
  const moved = await walletPolicy({ fetchImpl: s.node.fetchImpl, url: A, token: T2, wallet: W, reading: s.reader.get(T2), now })
  check('the bound id changed since the reading: nothing is said', moved.receive === null && moved.send === null)
  s.node.down.add('*')
  check('the node down: null', (await walletPolicy({ fetchImpl: s.node.fetchImpl, url: A, token: T2, wallet: W, reading: s.reader.get(T2), now })) === null)
  check('a failed reading is not built on', (await walletPolicy({ fetchImpl: s.node.fetchImpl, url: A, token: T2, wallet: W, reading: { error: 'read_failed' }, now })) === null)
}

console.log('the re-review of #268')
{
  // The reviewer's case: four calls (three policy ids of 0 and the pause); the pause tuple is left out and its offset
  // points back at a zero policy tuple. Every word is in bounds and every declared length present.
  const zeroWord = '0x' + '00'.repeat(32)
  const three = encodeAggregate3Result([{ success: true, data: zeroWord }, { success: true, data: zeroWord }, { success: true, data: zeroWord }]).slice(2)
  const word = (i) => three.slice(i * 64, i * 64 + 64)
  const w = (n) => n.toString(16).padStart(64, '0')
  const o = [0, 1, 2].map((k) => BigInt('0x' + word(2 + k)))
  const forged = '0x' + w(0x20) + w(4) + [o[0] + 32n, o[1] + 32n, o[2] + 32n, o[2] + 32n].map(w).join('') + three.slice(5 * 64)
  let threw = false
  try { decodeAggregate3Strict(forged, 4) } catch (_) { threw = true }
  check('a tuple offset pointing back at another tuple (the pause left out): refused', threw)
  const s = setup()
  s.node.mangle = () => forged
  s.records.splice(1)
  await s.reader.refresh(s.records, { poolsOf: () => [] })
  check('...so that token is unknown, never open', block(s.reader, T1).state === 'unknown' && block(s.reader, T1).reason === 'read_failed')

  const f = setup()
  f.node.lags.set(A, 3600)
  await f.cycle()
  check('the first node an hour behind, the second current: the current head is read, open', block(f.reader, T1).state === 'open' && f.reader.get(T1).read_at > clock - 60e3)

  const g = setup()
  await g.cycle()
  g.chain.kinds[9] = { type: 'allow', members: [...venues, ORDINARY_WALLET] }
  g.node.lagS = 3600
  await g.cycle()
  check('every node an hour behind: the reading is stale, and the baseline does not move', block(g.reader, T2).reason === 'stale' && g.changes().length === 0 && g.reader.lastGood(T2).auth['9|' + ORDINARY_WALLET] === false)
  g.node.lagS = 0
  await g.cycle()
  check('...the next current reading says the change, once', g.changes().filter((x) => x.token === T2).length === 1)
  const snaps = g.reader.snapshots()
  check('the snapshots for health-check name the probe wallet, never its address', snaps[T2].answers['ordinary_wallet|receiver'] === true && !JSON.stringify(snaps).includes(ORDINARY_WALLET.slice(2)) && !JSON.stringify(g.changes()).includes(ORDINARY_WALLET.slice(2)))

  const W = '0x' + '11'.repeat(20)
  g.node.lagS = -3600
  check('the wallet read refuses a head an hour ahead of the clock', (await walletPolicy({ fetchImpl: g.node.fetchImpl, url: A, token: T2, wallet: W, reading: g.reader.get(T2), now })) === null)
  g.node.lagS = 0
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
