// apps/b20-reader.test.mjs: the reads of the B20 transfer rules against a fake pair of nodes (docs/b20-transfers-tz.md
// §1, §5, §7, and the two stress reviews after it). Both RPCs are read at one common `safe` block and compared: a token
// they disagree on, or a cycle one of them did not answer, is `unknown` and moves nothing. Heads must be plausible; a
// lock-out resets loudly. A failed cycle keeps what is still current; a failed chunk is tried again; a cycle has a
// deadline. The baseline is per scope, so a failed binding read never mixes with a new answer. Changes go to a durable
// outbox with sequence ids; a restart loses nothing. The journal carries fixed codes, never a provider's text.
//
// No outside call is made: every request goes to apps/simulate/fake-b20.mjs.
//
// Run: node apps/b20-reader.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createB20Reader, rpcPairOf, walletPolicy, rolesAt, VENUE_ROUTERS, decodeAggregate3Strict, eventId, LOCKOUT_CYCLES, CYCLE_DEADLINE_MS } from './b20-reader.mjs'
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
const ECHO = 'ab'.repeat(20) // what the fake's error messages carry, as a provider echoing an address would
let clock = Date.parse('2026-12-01T15:00:00Z')
const now = () => clock
let monoT = 0
const mono = () => monoT
const zero = { sender: '0', receiver: '0', executor: '0' }
const venues = [KYBER_ROUTER, ...VENUE_ROUTERS.aerodromeRouters, POOL, '0x498581ff718922c3f8e6a244956af099b2652b2b']
const tokensOf = () => ({
  [T1]: { policies: zero, paused: false },
  [T2]: { policies: { ...zero, receiver: '9' }, paused: false },
  [T3]: { policies: { ...zero, executor: '4' }, paused: false },
  [T4]: { policies: { ...zero, receiver: '9' }, paused: false },
  [T5]: { policies: { ...zero, receiver: '77' }, paused: false },
})
const kindsOf = () => ({ 9: { type: 'allow', members: venues }, 4: { type: 'block', members: [KYBER_ROUTER] }, 'unknown:77': true })
function setup ({ dir = null, records = null } = {}) {
  const chain = createB20Chain({ tokens: tokensOf(), kinds: kindsOf() })
  const node = b20Node(chain, { now })
  const logs = []
  const reader = createB20Reader({ fetchImpl: node.fetchImpl, env, now, mono, log: (m) => logs.push(m), dir })
  const recs = records || [T1, T2, T3, T4, T5].map((address, i) => ({ address, symbol: 'S' + (i + 1) + 'c', paused: [] }))
  const cycle = async (step = 150) => { node.head += step; clock += step * 2000; monoT += step * 2000; await reader.refresh(recs, { poolsOf: () => [POOL] }) }
  return { chain, node, reader, logs, records: recs, cycle, events: () => reader.events(0, 10_000).events }
}
const block = (r, t, listPaused = []) => transfersOf(r.get(t), { now: clock, listPaused, mono: monoT })

console.log('the RPC pair, and the strict decoder')
{
  check('the factory mirror\'s pair: its log source, then its second RPC', JSON.stringify(rpcPairOf(env)) === JSON.stringify([A, B]))
  const good = encodeAggregate3Result([{ success: true, data: '0x' + '00'.repeat(32) }, { success: true, data: '0x' + '00'.repeat(64) }])
  const throws = (h, n) => { try { decodeAggregate3Strict(h, n); return false } catch (_) { return true } }
  check('a well-formed answer decodes; a short one, a bad count or bad hex is refused', decodeAggregate3Strict(good, 2).length === 2 && throws(good.slice(0, -64), 2) && throws(good, 3) && throws('0xzz', 0))
  const zeroWord = '0x' + '00'.repeat(32)
  const three = encodeAggregate3Result([{ success: true, data: zeroWord }, { success: true, data: zeroWord }, { success: true, data: zeroWord }]).slice(2)
  const w = (n) => n.toString(16).padStart(64, '0')
  const o = [0, 1, 2].map((k) => BigInt('0x' + three.slice((2 + k) * 64, (3 + k) * 64)))
  const forged = '0x' + w(0x20) + w(4) + [o[0] + 32n, o[1] + 32n, o[2] + 32n, o[2] + 32n].map(w).join('') + three.slice(5 * 64)
  check('a tuple offset pointing back at another tuple: refused', throws(forged, 4))
}

console.log('one cycle, both RPCs at one safe block')
{
  const s = setup()
  await s.cycle()
  const calls = s.node.requests
  check('each RPC is asked its safe head', ['safe'].every((t) => calls.filter((q) => q.method === 'eth_getBlockByNumber' && q.params[0] === t).length === 2))
  check('every eth_call is aggregate3 at the common block hash, canonical only, on both RPCs', calls.filter((q) => q.method === 'eth_call').every((q) => q.params[1].blockHash && q.params[1].requireCanonical === true) && [A, B].every((u) => calls.some((q) => q.url === u && q.method === 'eth_call')))
  const ex = s.chain.calls.filter((c) => c.kind === 'policyExists'), au = s.chain.calls.filter((c) => c.kind === 'isAuthorized')
  check('policyExists before isAuthorized, once per id per RPC; an unknown id never asked isAuthorized', ex.filter((c) => c.id === '9').length === 2 && Math.max(...ex.map((c) => c.batch)) < Math.max(...au.map((c) => c.batch)) && !au.some((c) => c.id === '77'))
  check('agreed: open, restricted and policy_missing as the chain says, from two sources', block(s.reader, T1).state === 'open' && s.reader.get(T1).sources === 2 && block(s.reader, T2).reason === 'ordinary_wallet_refused' && block(s.reader, T3).reason === 'venue_refused' && block(s.reader, T5).reason === 'policy_missing')
  check('stamped with the block\'s own time', s.reader.get(T1).read_at === Math.floor(clock / 1000) * 1000)
  check('a first cycle has no baseline to compare with: no event', s.events().length === 0 && s.reader.counters.last_ok_at)
}

console.log('one node must not decide')
{
  // The same height on both, different hashes: two chains.
  const f = setup()
  f.node.forks.set(A, 'f0')
  await f.cycle()
  check('two RPCs giving one height two hashes: every token unknown, rpc_disagree, never open', [T1, T2].every((t) => block(f.reader, t).state === 'unknown' && block(f.reader, t).reason === 'rpc_disagree') && f.events().length === 0)
  // The same block, and one RPC says paused where the other says not: that token is unknown.
  const g = setup()
  await g.cycle()
  const other = createB20Chain({ tokens: { ...tokensOf(), [T1]: { policies: zero, paused: true } }, kinds: kindsOf() })
  g.node.chains.set(B, other)
  await g.cycle()
  check('one RPC answers paused, the other not, at the same hash: that token rpc_disagree; the rest agree', block(g.reader, T1).reason === 'rpc_disagree' && block(g.reader, T2).reason === 'ordinary_wallet_refused')
  check('...and no event, and the baseline does not move', g.events().length === 0 && g.reader.lastGood(T1).paused === false)
  g.node.chains.delete(B)
  // A head numbered past 2^53 on one RPC: refused, and the honest heads go on next cycle.
  const h = setup()
  await h.cycle()
  h.node.heads.set(A, 2 ** 53)
  await h.cycle()
  check('a head numbered 2^53: that RPC gives no block, the cycle fails, and only the last agreed reading stands', h.reader.counters.last_error === 'no_block' && block(h.reader, T1).state === 'open' && h.reader.get(T1).sources === 2, JSON.stringify(h.reader.counters))
  h.node.heads.clear()
  await h.cycle()
  check('...and the next cycle reads both again: no lock-out', block(h.reader, T1).state === 'open' && h.reader.counters.last_error === null)
  // A head far ahead with a current time: implausible against its own history and the other RPC.
  h.node.heads.set(A, h.node.head + 9_000_000)
  await h.cycle()
  check('a head far ahead of its time: refused as implausible, never the watermark', h.reader.counters.last_error === 'head_implausible' || h.reader.counters.last_error === 'single_source', h.reader.counters.last_error)
  h.node.heads.clear()
  await h.cycle()
  check('...the honest heads are read the next cycle', block(h.reader, T1).state === 'open' && h.reader.counters.last_error === null)
  // Both RPCs far ahead together, with current times: consistent with each other, not with the last accepted head.
  for (const u of [A, B]) h.node.heads.set(u, h.node.head + 9_000_000)
  await h.cycle()
  check('both heads far ahead of their time together: refused as implausible against the last accepted head', h.reader.counters.last_error === 'head_implausible', h.reader.counters.last_error)
  h.node.heads.clear()
  await h.cycle()
  check('...and the watermark did not move: the honest heads are read next', block(h.reader, T1).state === 'open' && h.reader.counters.last_error === null, h.reader.counters.last_error)
  const ah = setup()
  ah.node.lagS = -3600
  await ah.cycle()
  check('every head an hour ahead of our clock: refused (head_ahead), never fresh for an hour', ah.reader.counters.last_error === 'head_ahead' && block(ah.reader, T1).state === 'unknown', ah.reader.counters.last_error)
  // Both RPCs move back below the watermark (a reset node pair): LOCKOUT_CYCLES cycles, then a loud reset.
  const k = setup()
  await k.cycle()
  for (const u of [A, B]) k.node.heads.set(u, k.node.head - 100_000)
  for (let i = 0; i < LOCKOUT_CYCLES; i++) await k.cycle(0)
  check('every head below the watermark for two cycles: a loud LOCKOUT line, and the watermark is reset', k.logs.some((m) => /LOCKOUT/.test(m)))
  await k.cycle(0)
  check('...after which the lower heads are read', k.reader.counters.last_error === null && block(k.reader, T1).state === 'open', JSON.stringify(k.reader.counters))
}

console.log('a failed cycle keeps what is current, and is journaled by code only')
{
  const s = setup()
  await s.cycle()
  s.node.down.add(B)
  await s.cycle()
  check('the second RPC down: the cycle is single_source, and the last agreed reading, still current, stays', s.reader.counters.last_error && block(s.reader, T1).state === 'open')
  s.node.down.add(A)
  await s.cycle()
  check('both down: still the last agreed reading while it is current', block(s.reader, T1).state === 'open')
  await s.cycle(300)
  check('...until it is stale by its own block time', block(s.reader, T1).reason === 'stale' || block(s.reader, T1).reason === 'read_failed')
  check('the journal names codes only: no provider text, no address it echoed', s.logs.filter((m) => m.startsWith('[b20] read failed')).length >= 2 && !s.logs.some((m) => m.includes(ECHO)))
  // A chunk that fails once is asked again on the same RPC.
  const r = setup()
  let failures = 0
  r.node.downMethods.set(A, (b) => b.method === 'eth_call' && failures++ === 0)
  await r.cycle()
  check('a chunk that fails once is tried again on the same RPC, and the cycle succeeds', failures > 1 && block(r.reader, T1).state === 'open' && r.reader.counters.last_error === null)
  // A cycle past its deadline is a failed cycle, never a list of stale readings.
  const d = setup()
  let bCalls = 0
  // The last of B's three batches runs past the deadline: no chunk is left to start, the cycle itself must say so.
  d.node.downMethods.set(B, (b) => { if (b.method === 'eth_call' && ++bCalls === 3) clock += CYCLE_DEADLINE_MS + 1000; return false })
  await d.cycle()
  check('a cycle past its deadline: failed (deadline), no reading published from it', d.reader.counters.last_error === 'deadline' && block(d.reader, T1).state === 'unknown', d.reader.counters.last_error)
}

console.log('the baseline is per scope')
{
  // Sender and receiver both on 9, which allows the probe. Then sender moves to 0, 9 starts refusing the probe, and only
  // the sender's policyId read fails.
  // T2 beside it, read well: a cycle where every agreed reading fails to decode is a failed one (below).
  const recs = [{ address: T1, symbol: 'S1c', paused: [] }, { address: T2, symbol: 'S2c', paused: [] }]
  const s = setup({ records: recs })
  s.chain.tokens[T1].policies = { sender: '9', receiver: '9', executor: '0' }
  s.chain.kinds[9] = { type: 'allow', members: [...venues, ORDINARY_WALLET] }
  await s.cycle()
  s.chain.tokens[T1].policies = { sender: '0', receiver: '9', executor: '0' }
  s.chain.kinds[9] = { type: 'allow', members: venues }
  s.chain.failPolicyId = { token: T1, scope: 'sender' }
  await s.cycle()
  const ev = s.events().filter((e) => e.token === T1)
  check('only the receiver\'s refusal is an event; no false sender denial from the shared policy', ev.length === 1 && ev[0].scope === 'receiver' && ev[0].account === 'ordinary_wallet' && ev[0].from === true && ev[0].to === false, JSON.stringify(ev.map((e) => [e.kind, e.scope, e.account])))
}

console.log('a durable outbox')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-outbox-'))
  const s = setup({ dir })
  await s.cycle()
  s.chain.tokens[T1].paused = true
  await s.cycle()
  const e1 = s.events()
  check('a change is an event with a sequence, a stable id and the block hash', e1.length === 1 && e1[0].seq === 1 && /^b20-1-[0-9a-f]{12}$/.test(e1[0].id) && /^0x[0-9a-f]{64}$/.test(e1[0].block_hash) && e1[0].kind === 'paused')
  check('...written to the outbox file before the cycle ends', fs.readFileSync(path.join(dir, 'b20-state.json'), 'utf8').includes(e1[0].id))
  // The site restarts: a new reader on the same directory keeps the baseline and the sequence.
  const s2 = createB20Reader({ fetchImpl: s.node.fetchImpl, env, now, mono, log: () => {}, dir })
  s.chain.tokens[T1].paused = false
  s.node.head += 150; clock += 300e3; monoT += 300e3
  await s2.refresh(s.records, { poolsOf: () => [POOL] })
  const e2 = s2.events(1, 100).events
  check('after a restart the baseline is the one written: the unpause is an event, seq 2', e2.length === 1 && e2[0].seq === 2 && e2[0].kind === 'paused' && e2[0].to === false)
  check('two events at one height on different hashes, or with other values, have different ids', eventId(5, { token: T1, kind: 'paused', block_hash: '0x' + 'a'.repeat(64), from: false, to: true }) !== eventId(5, { token: T1, kind: 'paused', block_hash: '0x' + 'b'.repeat(64), from: false, to: true }) && eventId(5, { token: T1, kind: 'paused', block_hash: '0xa', from: false, to: true }) !== eventId(5, { token: T1, kind: 'paused', block_hash: '0xa', from: true, to: false }))
  fs.rmSync(dir, { recursive: true, force: true })
  // 201 tokens paused in one cycle, then one unpaused: nothing falls out.
  const many = Array.from({ length: 201 }, (_, i) => '0xb2000000000000000000' + (i + 1).toString(16).padStart(20, '0'))
  const chain = createB20Chain({ tokens: Object.fromEntries(many.map((t) => [t, { policies: zero, paused: false }])), kinds: {} })
  const node = b20Node(chain, { now })
  const rd = createB20Reader({ fetchImpl: node.fetchImpl, env, now, mono, log: () => {} })
  const recs = many.map((address) => ({ address, symbol: null, paused: [] }))
  const go = async () => { node.head += 150; clock += 300e3; monoT += 300e3; await rd.refresh(recs) }
  await go()
  for (const t of many) chain.tokens[t].paused = true
  await go()
  chain.tokens[many[0]].paused = false
  await go()
  const all = rd.events(0, 10_000).events
  check('201 pauses in one cycle and an unpause after: all 202 events kept, the first token\'s both legs among them', all.length === 202 && all.filter((e) => e.token === many[0]).length === 2)
}

console.log('reconcile and monotonic expiry')
{
  const s = setup()
  await s.cycle()
  await s.reader.refresh([], {})
  check('an empty trusted list: every token leaves the readings and the baseline', Object.keys(s.reader.snapshots()).length === 0 && s.reader.get(T1) === null)
  const m = setup()
  await m.cycle()
  clock -= 3600e3 // the wall clock moves back an hour
  monoT += 901e3 // while the monotonic clock goes on past the reading's budget
  check('a wall clock moved back cannot make an expired reading current: stale by the monotonic expiry', block(m.reader, T1).reason === 'stale')
  clock += 3600e3
}

console.log('rolesAt and the wallet read')
{
  const s = setup()
  await s.cycle()
  const W = '0x' + '11'.repeat(20)
  // The binding moved since the cycle to policy 5, which exists and refuses the wallet.
  s.chain.tokens[T2].policies = { ...zero, receiver: '5' }
  s.chain.kinds[5] = { type: 'block', members: [W] }
  const r = await walletPolicy({ fetchImpl: s.node.fetchImpl, urls: [A, B], token: T2, wallet: W, now })
  check('the wallet read reads the current bindings first: refused by the policy now bound', r && r.receive === false && r.send === true)
  check('...without a public reading at all (independent of the probe)', (await walletPolicy({ fetchImpl: s.node.fetchImpl, urls: [A, B], token: T5, wallet: W, now })) !== null)
  s.node.lagS = 3600
  check('a head an hour old: nothing is said', (await walletPolicy({ fetchImpl: s.node.fetchImpl, urls: [A, B], token: T2, wallet: W, now })) === null)
  s.node.lagS = -3600
  check('a head an hour ahead of the clock: nothing is said', (await walletPolicy({ fetchImpl: s.node.fetchImpl, urls: [A, B], token: T2, wallet: W, now })) === null)
  // A head 899 s old, and the clock moves two seconds during the reads: checked again after them.
  s.node.lagS = 899
  s.node.downMethods.set(A, (b) => { if (b.method === 'eth_call') clock += 2000; return false })
  check('a head that goes stale while the reads run: nothing is said', (await walletPolicy({ fetchImpl: s.node.fetchImpl, urls: [A, B], token: T2, wallet: W, now })) === null)
  s.node.downMethods.clear(); s.node.lagS = 0
  const dis = createB20Chain({ tokens: { ...tokensOf(), [T3]: { policies: { ...zero, executor: '0' }, paused: false } }, kinds: kindsOf() })
  s.node.chains.set(B, dis)
  check('rolesAt on two RPCs that disagree: nothing is said', (await rolesAt({ fetchImpl: s.node.fetchImpl, urls: [A, B], token: T3, accounts: [{ address: KYBER_ROUTER, scopes: ['executor'] }], now })) === null)
  s.node.chains.delete(B)
  check('...and on one RPC only: nothing is said', (await rolesAt({ fetchImpl: s.node.fetchImpl, urls: [A], token: T3, accounts: [{ address: KYBER_ROUTER, scopes: ['executor'] }], now })) === null)
  const roles = await rolesAt({ fetchImpl: s.node.fetchImpl, urls: [A, B], token: T3, accounts: [{ address: KYBER_ROUTER, scopes: ['executor'] }, { address: POOL, scopes: ['sender', 'executor'] }], now })
  check('rolesAt reads any account at the head: the router refused as executor, the pool allowed', roles.roles[KYBER_ROUTER].executor === false && roles.roles[POOL].sender === true)
}

console.log('the review of the hardening')
{
  // One RPC stamps the common block with another time: one block has one header, so this is a disagreement.
  const tm = setup()
  await tm.cycle()
  tm.node.lags.set(A, 1)
  await tm.cycle()
  check('the same hash with two header times: rpc_disagree (time_mismatch), the watermark not moved', tm.reader.counters.last_error === 'time_mismatch' && block(tm.reader, T1).state === 'open', tm.reader.counters.last_error)
  tm.node.lags.clear()
  await tm.cycle()
  check('...and the next agreeing cycle reads', tm.reader.counters.last_error === null)
  // Every head implausible against the watermark for two cycles: reset, loudly.
  const ip = setup()
  await ip.cycle()
  for (let i = 0; i < LOCKOUT_CYCLES; i++) { for (const u of [A, B]) ip.node.heads.set(u, ip.node.head + 9_000_000); await ip.cycle(0) }
  check('every head implausible for two cycles: a loud LOCKOUT line, the watermark reset', ip.logs.some((m) => /LOCKOUT: every head implausible/.test(m)))
  // Every token disagreed: no comparison succeeded, so no last_ok_at, and the cycle counts as failed.
  const dg = setup()
  const other = createB20Chain({ tokens: Object.fromEntries(Object.entries(tokensOf()).map(([t, v]) => [t, { ...v, paused: true }])), kinds: kindsOf() })
  dg.node.chains.set(B, other)
  await dg.cycle()
  check('total disagreement: a failed cycle, no last_ok_at, last_error rpc_disagree', dg.reader.counters.last_ok_at === null && dg.reader.counters.last_error === 'rpc_disagree' && dg.reader.counters.failed === 1)
  // Two RPCs that agree only in not decoding: no reading, a failed cycle (bad_answer), no last_ok_at.
  const ud = setup()
  ud.chain.garbage = true
  await ud.cycle()
  check('every agreed reading undecodable: a failed cycle, bad_answer, no last_ok_at', ud.reader.counters.last_error === 'bad_answer' && ud.reader.counters.last_ok_at === null)
  // The outbox's epoch: kept in its file, served with the events; a new file is a new epoch.
  const edir = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-epoch-'))
  const e1 = setup({ dir: edir })
  await e1.cycle()
  const ep1 = e1.reader.events(0, 0).epoch
  const e2 = createB20Reader({ fetchImpl: e1.node.fetchImpl, env, now, mono, log: () => {}, dir: edir })
  check('the epoch is kept across a restart, and a lost file makes a new one', /^[0-9a-f]{16}$/.test(ep1) && e2.events(0, 0).epoch === ep1 && createB20Reader({ fetchImpl: e1.node.fetchImpl, env, now, mono, log: () => {} }).events(0, 0).epoch !== ep1)
  fs.rmSync(edir, { recursive: true, force: true })
  // A write that fails commits nothing: the same change is seen next cycle and committed once.
  let writes = 0, fails = 1
  const wr = setup()
  const recs = wr.records
  const rd = createB20Reader({ fetchImpl: wr.node.fetchImpl, env, now, mono, log: () => {}, write: () => { writes++; return !(writes > 1 && fails-- > 0) } })
  const go = async () => { wr.node.head += 150; clock += 300e3; monoT += 300e3; await rd.refresh(recs, { poolsOf: () => [POOL] }) }
  await go()
  wr.chain.tokens[T1].paused = true
  await go()
  check('the outbox write failed: no event, the baseline not moved, and the status says outbox_write_failed', rd.events(0, 100).events.length === 0 && rd.lastGood(T1).paused === false && rd.counters.last_error === 'outbox_write_failed')
  await go()
  const ev = rd.events(0, 100).events
  check('...the next cycle commits the change once, with seq 1', ev.length === 1 && ev[0].seq === 1 && ev[0].kind === 'paused' && rd.counters.last_error === null)
  // The high-water mark never goes down, even when old rows are dropped.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-hw-'))
  fs.writeFileSync(path.join(dir, 'b20-state.json'), JSON.stringify({ hw: 9000, events: [], baseline: {} }))
  const hw = setup({ dir })
  await hw.cycle()
  hw.chain.tokens[T1].paused = true
  await hw.cycle()
  check('a high-water mark held with no rows left: the next event is seq 9001, never 1', hw.events()[0]?.seq === 9001 && hw.reader.events(0, 0).last === 9001, JSON.stringify(hw.events()[0]))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
