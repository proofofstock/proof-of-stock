// scripts/stocks/issuer-mirror.test.mjs: the issuer's list rebuilt from its factory's events, on both chains: decoded,
// checked before it counts, scanned forward to the chain's finalized block within a time budget, never losing state on
// a failure, success recorded apart from an attempt, one validator for every reader, and compared with the API's list.
// docs/list-locks-tz.md (v3) is the spec.
//
// Run: node scripts/stocks/issuer-mirror.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MIRRORS, SCHEMA, FUTURE_SKEW_MS, tokenOf, updateMirror, compareMirror, recordComparison, readMirror, validMirror, caughtUp, receiptHolds, revalidateMirror, REVALIDATE_EVERY_MS, lookupAwaiting, reconcileMirror, CONFIRM_MS, LOOKUP_EVERY_MS, RECONCILE_EVERY_MS, confirmSecond, secondRpcOf } from './issuer-mirror.mjs'
import { mirrorChecks } from './health-check.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const w = (n) => n.toString(16).padStart(64, '0')
const s = (text) => { const b = Buffer.from(text, 'utf8').toString('hex'); return w(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64 || 64, '0') }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'))
const H = (c) => '0x' + c.repeat(32)

// A Robinhood factory log as the chain gives it (12.11): topic1 an asset id; data: token, offset name, offset symbol.
const rhLog = (token, name, symbol, block = 100) => {
  const n = s(name), sy = s(symbol)
  const data = '0x' + w(BigInt('0x' + token.slice(2))) + w(0x60) + w(0x60 + n.length / 2) + n + sy
  return { address: MIRRORS.robinhood.factory, topics: [MIRRORS.robinhood.topic0, '0x' + '7c'.repeat(32)], data, blockNumber: '0x' + block.toString(16), blockHash: H('d1'), transactionHash: H('aa'), logIndex: '0x1' }
}
// A Coinbase factory log: topic1 the token; data: offset name, offset symbol, ..., decimals at word 4.
const cbLog = (token, name, symbol, block = 48459900) => {
  const n = s(name), sy = s(symbol)
  const data = '0x' + w(0xa0) + w(0xa0 + n.length / 2) + w(0) + w(0) + w(18) + n + sy
  return { address: MIRRORS.base.factory, topics: [MIRRORS.base.topic0, '0x' + w(BigInt('0x' + token.slice(2)))], data, blockNumber: '0x' + block.toString(16), blockHash: H('d2'), transactionHash: H('bb'), logIndex: '0x2' }
}
const ok = (result) => new Response(JSON.stringify({ result }))
const fin = (n, t = 1_764_000_000) => ({ number: '0x' + n.toString(16), timestamp: '0x' + t.toString(16) })

console.log('decoding, and a log is checked before it counts')
{
  const T = '0x322f0929c4625ed5bad873c95208d54e1c003b2d', N = '0xb20000000000000000000078ee7ce2fe4908108c'
  const r = tokenOf('robinhood', rhLog(T, 'Tesla • Robinhood Token', 'TSLA'))
  check('Robinhood: the token is the first word of the data, then name and symbol, with its block hash', r && r.address === T && r.symbol === 'TSLA' && r.name === 'Tesla • Robinhood Token' && r.block === 100 && r.log_index === 1 && r.block_hash === H('d1'), JSON.stringify(r))
  const c = tokenOf('base', cbLog(N, 'NVIDIA Corporation', 'NVDAc'))
  check('Base: the token is topic1, the decimals the fifth word', c && c.address === N && c.symbol === 'NVDAc' && c.decimals === 18, JSON.stringify(c))
  check('a log with another topic0 is not a token', tokenOf('robinhood', { ...rhLog(T, 'x', 'y'), topics: ['0x' + '11'.repeat(32)] }) === null && tokenOf('nochain', rhLog(T, 'x', 'y')) === null)
  check('a log emitted by another contract is not a token', tokenOf('base', { ...cbLog(N, 'x', 'y'), address: '0x' + '11'.repeat(20) }) === null)
  check('a removed log (a reorganisation) is not a token', tokenOf('base', { ...cbLog(N, 'x', 'y'), removed: true }) === null)
  check('a log outside the block range asked is not believed', tokenOf('base', cbLog(N, 'x', 'y', 500), { from: 100, to: 200 }) === null && tokenOf('base', cbLog(N, 'x', 'y', 150), { from: 100, to: 200 }) !== null)
  check('a log without 32-byte block and transaction hashes, or with a block that is not a number, is not a token', tokenOf('base', { ...cbLog(N, 'x', 'y'), blockHash: '0x12' }) === null && tokenOf('base', { ...cbLog(N, 'x', 'y'), transactionHash: undefined }) === null && tokenOf('base', { ...cbLog(N, 'x', 'y'), blockNumber: 'pending' }) === null)
}

console.log('scanning to the finalized block')
{
  const dir = path.join(tmp, 'rh'); fs.mkdirSync(dir)
  const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40)
  let finalized = 25_000_000, calls = [], methods = []
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body); methods.push(b.method)
    if (b.method === 'eth_getBlockByNumber') return ok(b.params[0] === 'finalized' ? fin(finalized) : null)
    if (b.method === 'eth_blockNumber') return ok('0x' + (finalized + 999).toString(16))
    const p = b.params[0]; calls.push([parseInt(p.fromBlock, 16), parseInt(p.toBlock, 16)])
    const logs = parseInt(p.fromBlock, 16) === 0 ? [rhLog(A, 'Tesla • Robinhood Token', 'TSLA', 19698), { ...rhLog('0x' + '3'.repeat(40), 'Fake', 'FAKE', 19700), address: '0x' + '99'.repeat(20) }] : parseInt(p.fromBlock, 16) === 20_000_000 ? [rhLog(B, 'NOK', 'NOK', 20_000_001)] : []
    return ok(logs)
  }
  const r1 = await updateMirror({ chain: 'robinhood', dir, fetchImpl, paceMs: 0, clock: () => Date.parse('2026-11-25T12:00:00Z') })
  const m1 = readMirror(dir, 'robinhood', Date.parse('2026-11-25T12:00:00Z'))
  check('Robinhood starts at block 0: the first scan is 0 to the finalized block, never to the head (10M blocks a call)', r1.ok && r1.caught_up && calls[0][0] === 0 && calls[0][1] === 9_999_999 && calls.at(-1)[1] === 25_000_000 && !methods.includes('eth_blockNumber'), JSON.stringify(calls))
  check('...a log from another emitter is rejected and counted, not recorded', r1.tokens === 2 && r1.rejected === 1 && !m1.tokens.some((t) => t.address === '0x' + '3'.repeat(40)))
  check('...the file is schema 2 with its pins, and success is recorded with its target and when the scan began', m1.schema === SCHEMA && m1.factory === MIRRORS.robinhood.factory && m1.from_block === 0 && m1.last_ok.target_block === 25_000_000 && m1.last_ok.started_at === '2026-11-25T12:00:00.000Z' && m1.last_error === null && caughtUp(m1))
  calls = []; finalized = 25_000_100
  const r2 = await updateMirror({ chain: 'robinhood', dir, fetchImpl, paceMs: 0, clock: () => Date.parse('2026-11-25T12:15:00Z') })
  check('...the next run asks only for the blocks since', r2.ok && calls.length === 1 && calls[0][0] === 25_000_001 && calls[0][1] === 25_000_100 && r2.added === 0 && r2.tokens === 2)
  const before = readMirror(dir, 'robinhood', Date.parse('2026-11-25T12:30:00Z'))
  finalized = 25_000_200
  const down = await updateMirror({ chain: 'robinhood', dir, fetchImpl: async () => new Response('bad gateway', { status: 502 }), paceMs: 0, clock: () => Date.parse('2026-11-25T12:30:00Z') })
  const after = readMirror(dir, 'robinhood', Date.parse('2026-11-25T12:30:00Z'))
  check('a source that fails: the run says so, keeps every token and where it had got to', !down.ok && /rpc/.test(down.error) && after.tokens.length === 2 && after.scanned_to === before.scanned_to)
  check('...and the failure moves updated_at and last_error, never last_ok (a failing RPC must not look fresh)', after.updated_at === '2026-11-25T12:30:00.000Z' && /rpc/.test(after.last_error) && after.last_ok.at === before.last_ok.at)
  const noFin = await updateMirror({ chain: 'robinhood', dir, paceMs: 0, clock: () => Date.parse('2026-11-25T12:45:00Z'), fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? null : '0x' + (99_000_000).toString(16)) } })
  check('an RPC that cannot say which block is finalized is an error, never a fall back to the head', !noFin.ok && /finalized/.test(noFin.error) && readMirror(dir, 'robinhood', Date.parse('2026-11-25T12:45:00Z')).scanned_to === before.scanned_to)
  let t = 0
  const slow = path.join(tmp, 'base'); fs.mkdirSync(slow)
  const r3 = await updateMirror({ chain: 'base', dir: slow, paceMs: 0, budgetMs: 3, clock: () => t++, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? fin(48459816 + 50_000) : []) } })
  const m3 = readMirror(slow, 'base', 1e6)
  check('a time budget: the backfill stops midway, writes how far it got, and goes on next run (1,000 blocks a call on Base)', r3.ok && !r3.caught_up && r3.scanned_to > 48459816 && r3.scanned_to < 48459816 + 50_000 && (r3.scanned_to - 48459815) % 1000 === 0, JSON.stringify(r3))
  check('...a backfill midway has no last_ok: it is not caught up', m3.last_ok === null && !caughtUp(m3))
}

{
  // 12.11: the keyless Base gateway answered 'rate limit exceeded' after ~200 calls, and the unit failed with an alert.
  const dir = path.join(tmp, 'throttled'); fs.mkdirSync(dir)
  let n = 0
  const r = await updateMirror({ chain: 'base', dir, paceMs: 0, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); if (b.method === 'eth_getBlockByNumber') return ok(fin(48459816 + 10_000)); return ++n > 3 ? new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } })) : ok([]) } })
  check('a rate limit during the backfill is a pause: ok, marked throttled, progress kept for the next run', r.ok && r.throttled && r.error === null && r.scanned_to === 48459816 + 2999 && readMirror(dir, 'base').scanned_to === 48459816 + 2999, JSON.stringify(r))
}

console.log('one validator, and a file it does not trust is rebuilt')
{
  const now = Date.parse('2026-11-25T12:00:00Z')
  const good = { schema: 2, chain: 'base', issuer: 'coinbase', factory: MIRRORS.base.factory, topic0: MIRRORS.base.topic0, from_block: MIRRORS.base.from_block, scanned_to: 48460000, tokens: [{ address: '0x' + 'b2'.repeat(20), block: 48459900, block_hash: H('d2'), tx: H('bb'), log_index: 2 }], last_ok: { at: '2026-11-25T11:59:00Z', started_at: '2026-11-25T11:58:00Z', target_block: 48460000, target_block_time: '2026-11-25T11:40:00Z' }, last_error: null }
  check('a good file is read as it is', validMirror(good, 'base', now) === good && caughtUp(good))
  check('schema 1, another chain, another factory, topic or start block: not read', [{ ...good, schema: undefined }, { ...good, chain: 'robinhood' }, { ...good, factory: '0x' + '11'.repeat(20) }, { ...good, topic0: H('00') }, { ...good, from_block: 1 }].every((m) => validMirror(m, 'base', now) === null))
  check('a block that is not an integer, or a scan below the factory\'s start, is not read', [{ ...good, scanned_to: 1.5 }, { ...good, scanned_to: '48460000' }, { ...good, scanned_to: 5 }, { ...good, tokens: [{ ...good.tokens[0], block: -1 }] }].every((m) => validMirror(m, 'base', now) === null))
  check('a token without its block hash or transaction is not read', validMirror({ ...good, tokens: [{ ...good.tokens[0], block_hash: undefined }] }, 'base', now) === null)
  check('scanned_to null is the unscanned state (Robinhood starts at 0)', validMirror({ ...good, chain: 'robinhood', issuer: 'robinhood', factory: MIRRORS.robinhood.factory, topic0: MIRRORS.robinhood.topic0, from_block: 0, scanned_to: null, tokens: [], last_ok: null }, 'robinhood', now) !== null)
  const future = validMirror({ ...good, last_ok: { ...good.last_ok, at: new Date(now + FUTURE_SKEW_MS + 60e3).toISOString() } }, 'base', now)
  check('a last_ok in the future counts as none: the file is read, but it is not caught up', future && future.last_ok === null && !caughtUp(future))
  check('a last_ok whose target the scan has not reached counts as none', validMirror({ ...good, last_ok: { ...good.last_ok, target_block: 48470000 } }, 'base', now).last_ok === null)
  const dir = path.join(tmp, 'v1'); fs.mkdirSync(dir)
  const v1 = { chain: 'base', factory: MIRRORS.base.factory, head: 62_000_000, scanned_to: 62_000_000, tokens: [{ address: '0x' + 'b2'.repeat(20), block: 48459900, tx: H('bb'), log_index: 2 }] }
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify(v1))
  check('the scanner\'s reader refuses a schema 1 file', readMirror(dir, 'base', now) === null)
  const r = await updateMirror({ chain: 'base', dir, paceMs: 0, budgetMs: 1e9, clock: () => now, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? fin(48459816 + 1500) : []) } })
  const m = readMirror(dir, 'base', now)
  const kept = fs.readdirSync(dir).filter((f) => /^mirror\.refused-.+\.json$/.test(f))
  check('...rebuilds from the factory\'s start, keeping nothing of the old scan, and keeps the refused file beside, named by time', r.rebuilt && r.ok && m.schema === 2 && m.tokens.length === 0 && m.scanned_to === 48459816 + 1500 && kept.length === 1 && JSON.parse(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).head === 62_000_000)
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ ...v1, factory: '0x' + '11'.repeat(20) }))
  await updateMirror({ chain: 'base', dir, paceMs: 0, budgetMs: 1e9, clock: () => now + 60e3, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? fin(48459816 + 1500) : []) } })
  check('...a second refusal is kept too, not overwritten', fs.readdirSync(dir).filter((f) => /^mirror\.refused-.+\.json$/.test(f)).length === 2)
  // The file is replaced whole: written beside, then renamed, so a reader never sees half of one.
  const renames = [], real = fs.renameSync
  fs.renameSync = (a, b) => { renames.push([path.basename(a), path.basename(b)]); return real(a, b) }
  try { await updateMirror({ chain: 'base', dir, paceMs: 0, budgetMs: 1e9, clock: () => now + 120e3, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? fin(48459816 + 1500) : []) } }) } finally { fs.renameSync = real }
  check('the mirror file is written beside and renamed into place, never written in place', renames.some(([a, b]) => /^mirror\.json\.tmp-/.test(a) && b === 'mirror.json'))
  const hosts = []
  await updateMirror({ chain: 'base', dir, paceMs: 0, budgetMs: 1e9, env: { STP_LOGS_RPC_BASE: 'https://logs.example.test' }, clock: () => now + 180e3, fetchImpl: async (url, init) => { hosts.push(new URL(url).host); const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? fin(48459816 + 1500) : []) } })
  check('STP_LOGS_RPC_<CHAIN> replaces the source', hosts.length > 0 && hosts.every((h) => h === 'logs.example.test'))
}

console.log('a recorded creation is checked again, and can be taken back')
{
  const N = '0xb20000000000000000000078ee7ce2fe4908108c', M = '0xb2000000000000000000001e800a7f5189430cd0'
  const log = (token, txc) => ({ ...cbLog(token, 'x', 'Xc'), transactionHash: H(txc) })
  const tokN = tokenOf('base', log(N, 'b1')), tokM = tokenOf('base', log(M, 'b2'))
  const receipt = (tok, over = {}) => ({ blockHash: tok.block_hash, transactionHash: tok.tx, blockNumber: '0x' + tok.block.toString(16), status: '0x1', logs: [{ ...log(tok.address, tok.tx.slice(2, 4)), logIndex: '0x' + tok.log_index.toString(16), transactionHash: tok.tx }], ...over })
  check('a receipt that still holds the creation holds', receiptHolds('base', tokN, receipt(tokN)).ok === true)
  check('another block, a failed transaction, a missing log or a log for another token: does not hold, and says why', [
    [receipt(tokN, { blockHash: H('ee') }), /another block/], [receipt(tokN, { status: '0x0' }), /failed/], [receipt(tokN, { logs: [] }), /not in the receipt/],
    [receipt(tokN, { logs: [{ ...log(M, 'b1'), logIndex: '0x2' }] }), /does not create this token/], [receipt(tokN, { logs: [{ ...log(N, 'b1'), address: '0x' + '11'.repeat(20), logIndex: '0x2' }] }), /does not create/],
  ].every(([r, why]) => { const v = receiptHolds('base', tokN, r); return v.ok === false && why.test(v.why) }))
  const dir = path.join(tmp, 'reval'); fs.mkdirSync(dir)
  const now = Date.parse('2026-11-25T12:00:00Z')
  const base = { schema: 2, chain: 'base', issuer: 'coinbase', factory: MIRRORS.base.factory, topic0: MIRRORS.base.topic0, from_block: MIRRORS.base.from_block, scanned_to: 48460000, last_ok: { at: '2026-11-25T11:59:00Z', started_at: '2026-11-25T11:58:00Z', target_block: 48460000, target_block_time: '2026-11-25T11:40:00Z' }, last_error: null }
  const write = (tokens, extra = {}) => fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ ...base, tokens, ...extra }))
  const world = (answers) => { const asked = []; return { asked, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); asked.push([b.method, b.params[0]]); const a = answers(b.method, b.params[0]); return a instanceof Error ? new Response('down', { status: 502 }) : ok(a) } } }
  // The chain as a node with a full index answers it: blocks by number, logs by block hash, receipts by transaction.
  const chainOf = ({ receipts = {}, blocks = {}, blockLogs = {}, txs = {} }) => (m, p0) => m === 'eth_getTransactionReceipt' ? (receipts[p0] ?? null)
    : m === 'eth_getBlockByNumber' ? (blocks[parseInt(p0, 16)] ?? null)
      : m === 'eth_getLogs' ? (blockLogs[p0.blockHash] ?? [])
        : m === 'eth_getTransactionByHash' ? (txs[p0] ?? null) : null
  const intact = (tok) => ({ blocks: { [tok.block]: { hash: tok.block_hash } }, blockLogs: { [tok.block_hash]: [{ ...log(tok.address, tok.tx.slice(2, 4)), logIndex: '0x' + tok.log_index.toString(16) }] } })
  write([tokN, { ...tokM, checked_at: '2026-11-25T11:00:00Z' }])
  let w = world(chainOf({ receipts: { [tokN.tx]: receipt(tokN), [tokM.tx]: receipt(tokM) } }))
  let r = await revalidateMirror({ chain: 'base', dir, fetchImpl: w.fetchImpl, clock: () => now })
  let m = readMirror(dir, 'base', now)
  check('a token never checked is checked; one checked an hour ago is not due', r.ok && r.checked === 1 && r.due === 1 && w.asked.length === 1 && w.asked[0][1] === tokN.tx && m.tokens.find((t) => t.address === N).checked_at === '2026-11-25T12:00:00.000Z')
  // A node with a pruned transaction index: null for the receipt and the transaction. The block still holds it.
  write([tokN])
  w = world(chainOf(intact(tokN)))
  r = await revalidateMirror({ chain: 'base', dir, fetchImpl: w.fetchImpl, clock: () => now })
  check('no receipt and no transaction (a pruned index), but the block still holds the creation: kept, checked (outside review, 25.11)', r.ok && r.revoked.length === 0 && readMirror(dir, 'base', now).tokens[0].checked_at === new Date(now).toISOString())
  write([tokN])
  w = world(chainOf({}))
  r = await revalidateMirror({ chain: 'base', dir, fetchImpl: w.fetchImpl, clock: () => now })
  check('no receipt, no transaction, and the node cannot give the block either: could not check, nothing revoked', r.ok && r.revoked.length === 0 && readMirror(dir, 'base', now).tokens.length === 1 && !readMirror(dir, 'base', now).tokens[0].checked_at)
  write([tokN])
  w = world(chainOf({ receipts: { [tokN.tx]: receipt(tokN, { blockHash: H('ee') }) }, ...intact(tokN) }))
  r = await revalidateMirror({ chain: 'base', dir, fetchImpl: w.fetchImpl, clock: () => now })
  check('a receipt that disagrees while the recorded block still holds the creation: kept (the block decides)', r.revoked.length === 0 && readMirror(dir, 'base', now).tokens.length === 1)
  write([tokN, tokM])
  w = world(chainOf({ blocks: { [tokN.block]: { hash: H('ee') } } }))
  r = await revalidateMirror({ chain: 'base', dir, fetchImpl: w.fetchImpl, clock: () => now + REVALIDATE_EVERY_MS })
  m = readMirror(dir, 'base', now + REVALIDATE_EVERY_MS)
  check('the recorded block is no longer the chain\'s block at that height: proven, revoked with when and why', r.ok && r.revoked.length === 2 && /no longer the chain's block/.test(m.revoked[0].why) && m.revoked[0].revoked_at === new Date(now + REVALIDATE_EVERY_MS).toISOString())
  write([tokN])
  w = world(chainOf({ blocks: { [tokN.block]: { hash: tokN.block_hash } }, blockLogs: { [tokN.block_hash]: [] } }))
  r = await revalidateMirror({ chain: 'base', dir, fetchImpl: w.fetchImpl, clock: () => now })
  check('the recorded block is the chain\'s, but holds no factory log creating the token: proven, revoked', r.revoked.length === 1 && /holds no factory log/.test(r.revoked[0].why))
  write([tokN])
  w = world(() => new Error('down'))
  r = await revalidateMirror({ chain: 'base', dir, fetchImpl: w.fetchImpl, clock: () => now })
  check('an RPC that fails ends the run and revokes nothing', !r.ok && /rpc/.test(r.error) && r.revoked.length === 0 && readMirror(dir, 'base', now).tokens.length === 1)
  write([tokN, tokM])
  let t = 0
  r = await revalidateMirror({ chain: 'base', dir, budgetMs: 1e9, maxPerRun: 1, clock: () => now + (t++), fetchImpl: world(chainOf({ receipts: { [tokN.tx]: receipt(tokN), [tokM.tx]: receipt(tokM) } })).fetchImpl })
  check('at most maxPerRun a run', r.checked === 1 && r.due === 2)
  // A revoked token comes back when the chain shows it: a valid creation log, read by the scan.
  write([], { revoked: [{ ...tokM, revoked_at: '2026-11-25T11:00:00Z', why: 'x' }], scanned_to: 48459899, last_ok: null })
  await updateMirror({ chain: 'base', dir, paceMs: 0, budgetMs: 1e9, clock: () => now, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? fin(48460500) : [cbLog(M, 'x', 'Xc', 48459950)]) } })
  m = readMirror(dir, 'base', now)
  check('a revoked token whose valid creation log a scan reads again is restored, saying when', m.tokens.length === 1 && m.tokens[0].address === M && m.tokens[0].restored_at === new Date(now).toISOString() && (m.revoked || []).length === 0)
  // A refused file keeps what was taken back, so its alert does not go quiet.
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ ...base, schema: 1, tokens: [], revoked: [{ ...tokN, revoked_at: '2026-11-25T11:00:00Z', why: 'w' }, { address: 'junk' }] }))
  await updateMirror({ chain: 'base', dir, paceMs: 0, budgetMs: 1e9, clock: () => now, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return ok(b.method === 'eth_getBlockByNumber' ? fin(48459816 + 10) : []) } })
  m = readMirror(dir, 'base', now)
  check('a refused file is rebuilt, but its well-formed revocations are kept', m && m.tokens.length === 0 && (m.revoked || []).length === 1 && m.revoked[0].address === N)
  check('a malformed revoked list makes the file untrusted', validMirror({ ...base, tokens: [], revoked: [{ address: M }] }, 'base', now) === null)
  const out = {}
  mirrorChecks((k, bad, text) => { out[k] = { bad, text } }, 'Base', 'base', { last_ok: { at: '2026-11-25T11:59:00Z' }, updated_at: '2026-11-25T11:59:00Z', revoked: [{ address: M, revoked_at: '2026-11-24T12:00:00Z', why: 'the transaction is in another block now' }] }, now)
  check('the health check alerts on a revocation of the last 7 days, naming it', out['mirror-revoked:base'].bad && out['mirror-revoked:base'].text.includes(M))
  const out2 = {}
  mirrorChecks((k, bad) => { out2[k] = bad }, 'Base', 'base', { last_ok: { at: '2026-11-25T11:59:00Z' }, updated_at: '2026-11-25T11:59:00Z', revoked: [{ address: M, revoked_at: '2026-11-10T12:00:00Z', why: 'x' }] }, now)
  check('...and rests after 7 days, the record kept', out2['mirror-revoked:base'] === false)
}

console.log('a missed log cannot hold a listing forever')
{
  const now = Date.parse('2026-11-25T12:00:00Z')
  const FROM = MIRRORS.base.from_block, TARGET = FROM + 100_000
  const X = '0xb2000000000000000000009999999999999999aa', Y = '0xb2000000000000000000008888888888888888bb', Z = '0x' + 'ab'.repeat(20)
  const CREATED = FROM + 54_321
  const baseM = { schema: 2, chain: 'base', issuer: 'coinbase', factory: MIRRORS.base.factory, topic0: MIRRORS.base.topic0, from_block: FROM, scanned_to: TARGET, tokens: [], last_ok: { at: '2026-11-25T11:59:00Z', started_at: '2026-11-25T11:58:00Z', target_block: TARGET, target_block_time: '2026-11-25T11:40:00Z' }, last_error: null }
  const dir = path.join(tmp, 'lookup'); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify(baseM))
  const asked = []
  // X was created at CREATED by the factory (the forward scan missed it); Y has code from CREATED too, but no factory
  // log there; Z has no code at all.
  const chain = async (url, init) => {
    const b = JSON.parse(init.body); asked.push(b.method)
    if (b.method === 'eth_getCode') { const [a, blk] = b.params; return ok((a === X || a === Y) && parseInt(blk, 16) >= CREATED ? '0x6080' : '0x') }
    if (b.method === 'eth_getLogs') { const q = b.params[0], f = parseInt(q.fromBlock, 16), t = parseInt(q.toBlock, 16); return ok(f <= CREATED && CREATED <= t && (!q.topics[1] || q.topics[1].endsWith(X.slice(2))) ? [cbLog(X, 'Late', 'LATEc', CREATED)] : []) }
    return ok(null)
  }
  let r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X, Y, Z], fetchImpl: chain, clock: () => now })
  check('an address on the list the factory has not been seen creating is noted as waiting, not looked for at once', r.ok && r.waiting === 3 && r.looked.length === 0 && asked.length === 0)
  r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X, Y, Z], fetchImpl: chain, clock: () => now + CONFIRM_MS })
  const m = readMirror(dir, 'base', now + CONFIRM_MS)
  const res = Object.fromEntries(r.looked.map((l) => [l.address, l.result]))
  check('after CONFIRM_MS each is looked for: the missed creation is found by its first block with code and the factory log there', r.ok && r.found === 1 && res[X] === 'found' && m.tokens.some((t) => t.address === X && t.block === CREATED) && !m.awaiting[X], JSON.stringify(r))
  check('...code from a block with no factory log for it: created elsewhere, still waiting', res[Y] === 'created_elsewhere' && m.awaiting[Y].result === 'created_elsewhere')
  check('...no code at all: said so, still waiting', res[Z] === 'no_code' && m.awaiting[Z].result === 'no_code')
  check('...the bisection costs a few dozen calls, not the whole range', asked.filter((x) => x === 'eth_getCode').length < 3 * 25 && asked.filter((x) => x === 'eth_getLogs').length === 2)
  asked.length = 0
  r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X, Y, Z], fetchImpl: chain, clock: () => now + CONFIRM_MS + 60e3 })
  check('...and not looked for again until LOOKUP_EVERY_MS has passed', r.looked.length === 0 && asked.length === 0)
  r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [Y], fetchImpl: chain, clock: () => now + CONFIRM_MS + LOOKUP_EVERY_MS })
  check('an address that left the list stops waiting; one still on it is looked for again', r.waiting === 1 && r.looked.length === 1 && r.looked[0].address === Y && !readMirror(dir, 'base', now + CONFIRM_MS + LOOKUP_EVERY_MS).awaiting[Z])
  const behind = path.join(tmp, 'lookup-behind'); fs.mkdirSync(behind)
  fs.writeFileSync(path.join(behind, 'mirror.json'), JSON.stringify({ ...baseM, last_ok: null }))
  check('a mirror not caught up looks for nothing', !(await lookupAwaiting({ paceMs: 0, chain: 'base', dir: behind, listAddresses: [X], fetchImpl: chain, clock: () => now })).ok)
  // Robinhood: no historical state, so the waiting addresses are looked for in a fresh read of every factory log.
  const rdir = path.join(tmp, 'lookup-rh'); fs.mkdirSync(rdir)
  const R = '0x' + '5'.repeat(40)
  fs.writeFileSync(path.join(rdir, 'mirror.json'), JSON.stringify({ ...baseM, chain: 'robinhood', issuer: 'robinhood', factory: MIRRORS.robinhood.factory, topic0: MIRRORS.robinhood.topic0, from_block: 0, scanned_to: 25_000_000, last_ok: { ...baseM.last_ok, target_block: 25_000_000 } }))
  const rcalls = []
  const rchain = async (url, init) => { const b = JSON.parse(init.body); rcalls.push(b.method); const q = b.params[0]; return ok(b.method === 'eth_getLogs' && parseInt(q.fromBlock, 16) === 20_000_000 ? [rhLog(R, 'Late', 'LATE', 20_000_123)] : []) }
  await lookupAwaiting({ paceMs: 0, chain: 'robinhood', dir: rdir, listAddresses: [R], fetchImpl: rchain, clock: () => now })
  r = await lookupAwaiting({ paceMs: 0, chain: 'robinhood', dir: rdir, listAddresses: [R], fetchImpl: rchain, clock: () => now + CONFIRM_MS })
  check('Robinhood: found by reading every factory log again (10M blocks a call), never by historical state', r.found === 1 && r.looked[0].result === 'found' && !rcalls.includes('eth_getCode') && rcalls.length === 3 && readMirror(rdir, 'robinhood', now + CONFIRM_MS).tokens.some((t) => t.address === R))
  // The slow reconcile.
  const cdir = path.join(tmp, 'reconcile'); fs.mkdirSync(cdir)
  fs.writeFileSync(path.join(cdir, 'mirror.json'), JSON.stringify({ ...baseM, scanned_to: FROM + 2499, last_ok: { ...baseM.last_ok, target_block: FROM + 2499 } }))
  const cc = async (url, init) => { const b = JSON.parse(init.body); const q = b.params[0], f = parseInt(q.fromBlock, 16), t = parseInt(q.toBlock, 16); return ok(f <= FROM + 1500 && FROM + 1500 <= t ? [cbLog(X, 'Gap', 'GAPc', FROM + 1500)] : []) }
  let c = await reconcileMirror({ chain: 'base', dir: cdir, fetchImpl: cc, maxCalls: 2, clock: () => now })
  check('the reconcile reads the range again, a slice per run, adding a creation the forward scan missed', c.ok && c.calls === 2 && c.added === 1 && c.at === FROM + 2000 && readMirror(cdir, 'base', now).tokens.some((t) => t.address === X))
  c = await reconcileMirror({ chain: 'base', dir: cdir, fetchImpl: cc, maxCalls: 2, clock: () => now + 60e3 })
  check('...finishes, never adding twice, and records when', c.ok && c.calls === 1 && c.added === 0 && c.at === null && readMirror(cdir, 'base', now).reconcile.finished_at === new Date(now + 60e3).toISOString())
  c = await reconcileMirror({ chain: 'base', dir: cdir, fetchImpl: cc, clock: () => now + 2 * 864e5 })
  check('...rests a week before starting over', c.calls === 0)
  c = await reconcileMirror({ chain: 'base', dir: cdir, fetchImpl: cc, maxCalls: 1, clock: () => now + 60e3 + RECONCILE_EVERY_MS })
  check('...then starts again from the factory\'s first block', c.calls === 1 && c.at === FROM + 1000)
}

console.log('a second RPC, where there is one')
{
  const now = Date.parse('2026-11-25T12:00:00Z')
  const N = '0xb20000000000000000000078ee7ce2fe4908108c', M = '0xb2000000000000000000001e800a7f5189430cd0'
  const lg = (token, txc) => ({ ...cbLog(token, 'x', 'Xc'), transactionHash: H(txc) })
  const tN = tokenOf('base', lg(N, 'c1')), tM = tokenOf('base', lg(M, 'c2'))
  const rc = (tok, over = {}) => ({ blockHash: tok.block_hash, transactionHash: tok.tx, blockNumber: '0x' + tok.block.toString(16), status: '0x1', logs: [{ ...lg(tok.address, tok.tx.slice(2, 4)), logIndex: '0x' + tok.log_index.toString(16) }], ...over })
  const baseM = { schema: 2, chain: 'base', issuer: 'coinbase', factory: MIRRORS.base.factory, topic0: MIRRORS.base.topic0, from_block: MIRRORS.base.from_block, scanned_to: 48460000, last_ok: { at: '2026-11-25T11:59:00Z', started_at: '2026-11-25T11:58:00Z', target_block: 48460000, target_block_time: '2026-11-25T11:40:00Z' }, last_error: null }
  const dir = path.join(tmp, 'second'); fs.mkdirSync(dir)
  const write = (tokens) => fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ ...baseM, tokens }))
  check('Base has a built-in second RPC run by another operator than the logs gateway; Robinhood has none unless the host sets one', secondRpcOf('base', {}) === 'https://mainnet.base.org' && new URL(secondRpcOf('base', {})).host !== new URL(MIRRORS.base.rpc).host && secondRpcOf('robinhood', {}) === null && secondRpcOf('robinhood', { STP_VERIFY_RPC_ROBINHOOD: 'https://x.example' }) === 'https://x.example')
  // The second RPC's chain: receipts by transaction, blocks by number, logs by block hash. tM's recorded block is
  // replaced there; tN's is intact.
  const second = ({ receipts = {}, blocks = {}, blockLogs = {} }) => async (url, init) => {
    hosts.push(new URL(url).host)
    const b = JSON.parse(init.body), p0 = b.params[0]
    return ok(b.method === 'eth_getTransactionReceipt' ? (receipts[p0] ?? null) : b.method === 'eth_getBlockByNumber' ? (blocks[parseInt(p0, 16)] ?? null) : b.method === 'eth_getLogs' ? (blockLogs[p0.blockHash] ?? []) : null)
  }
  const hosts = []
  write([tN, tM])
  let r = await confirmSecond({ chain: 'base', dir, clock: () => now, fetchImpl: second({ receipts: { [tN.tx]: rc(tN), [tM.tx]: rc(tM, { blockHash: H('ee') }) }, blocks: { [tM.block]: { hash: H('ee') } } }) })
  let m = readMirror(dir, 'base', now)
  check('each creation is asked of the second RPC, and only of it', hosts.length >= 2 && hosts.every((h) => h === 'mainnet.base.org'))
  check('...one it holds is confirmed (second_at); one whose block it proves replaced is revoked, saying the second RPC does not hold it', r.ok && r.sources === 2 && r.confirmed === 1 && m.tokens.length === 1 && m.tokens[0].second_at === '2026-11-25T12:00:00.000Z' && /second RPC does not hold it: the recorded block is no longer/.test(m.revoked[0].why))
  hosts.length = 0
  r = await confirmSecond({ chain: 'base', dir, clock: () => now + 60e3, fetchImpl: second({}) })
  check('...a confirmed creation is not asked again', r.confirmed === 0 && hosts.length === 0 && r.pending === 0)
  write([tN])
  r = await confirmSecond({ chain: 'base', dir, clock: () => now, fetchImpl: second({}) })
  check('no receipt, no transaction, no block from the second RPC (a pruned or flaky node): neither confirmed nor revoked (outside review, 25.11)', r.confirmed === 0 && r.revoked.length === 0 && r.pending === 1 && !readMirror(dir, 'base', now).tokens[0].second_at)
  r = await confirmSecond({ chain: 'base', dir, clock: () => now, fetchImpl: second({ blocks: { [tN.block]: { hash: tN.block_hash } }, blockLogs: { [tN.block_hash]: [{ ...lg(N, 'c1'), logIndex: '0x' + tN.log_index.toString(16) }] } }) })
  check('no receipt, but the second RPC\'s block holds the creation: confirmed', r.confirmed === 1 && !!readMirror(dir, 'base', now).tokens[0].second_at)
  write([tN])
  r = await confirmSecond({ chain: 'base', dir, clock: () => now, fetchImpl: async () => new Response('down', { status: 502 }) })
  check('a second RPC that fails confirms nothing and revokes nothing', !r.ok && r.revoked.length === 0 && readMirror(dir, 'base', now).tokens.length === 1)
  const rdir = path.join(tmp, 'second-rh'); fs.mkdirSync(rdir)
  fs.writeFileSync(path.join(rdir, 'mirror.json'), JSON.stringify({ ...baseM, chain: 'robinhood', issuer: 'robinhood', factory: MIRRORS.robinhood.factory, topic0: MIRRORS.robinhood.topic0, from_block: 0, scanned_to: 25_000_000, last_ok: { ...baseM.last_ok, target_block: 25_000_000 }, tokens: [] }))
  let asked = 0
  r = await confirmSecond({ chain: 'robinhood', dir: rdir, env: {}, clock: () => now, fetchImpl: async () => { asked++; return ok(null) } })
  check('Robinhood with no second RPC: one source, said in the file, nothing asked', r.ok && r.sources === 1 && asked === 0 && readMirror(rdir, 'robinhood', now).sources === 1)
  const src = fs.readFileSync(new URL('./issuer-mirror.mjs', import.meta.url), 'utf8')
  check('the second RPC\'s URL is never written into the mirror (a host\'s own URL may carry a key)', !/m\.(second|rpc)_?url|second_rpc\s*=/.test(src) && !JSON.stringify(readMirror(dir, 'base', now)).includes('mainnet.base.org'))
  check('sources must be 1 or 2', validMirror({ ...baseM, tokens: [], sources: 3 }, 'base', now) === null)
}

console.log('the lookup and the reconcile accept only a log that passes every check')
{
  const now = Date.parse('2026-11-25T12:00:00Z')
  const FROM = MIRRORS.base.from_block, TARGET = FROM + 100_000, AT = FROM + 777
  const X = '0xb2000000000000000000007777777777777777aa', Y = '0xb2000000000000000000006666666666666666bb', Z = '0x' + '5c'.repeat(20)
  const baseM = { schema: 2, chain: 'base', issuer: 'coinbase', factory: MIRRORS.base.factory, topic0: MIRRORS.base.topic0, from_block: FROM, scanned_to: TARGET, tokens: [], last_ok: { at: '2026-11-25T11:59:00Z', started_at: '2026-11-25T11:58:00Z', target_block: TARGET, target_block_time: '2026-11-25T11:40:00Z' }, last_error: null }
  const junk = (token, block) => [
    { ...cbLog(token, 'x', 'Xc', block), address: '0x' + '99'.repeat(20) },
    { ...cbLog(token, 'x', 'Xc', block), topics: ['0x' + '12'.repeat(32), cbLog(token, 'x', 'Xc', block).topics[1]] },
  ]
  // The RPC answers the bisection's topic-filtered query with logs that must all be refused: another emitter, another
  // topic0, and a valid log for ANOTHER token in that block. It does not filter for us.
  const world = (logs) => async (url, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_getCode') return ok(parseInt(b.params[1], 16) >= AT ? '0x6080' : '0x')
    if (b.method === 'eth_getLogs') return ok(logs)
    return ok(null)
  }
  const dir = path.join(tmp, 'gate'); fs.mkdirSync(dir)
  const start = (extra = {}) => fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ ...baseM, ...extra, awaiting: { [X]: { since: new Date(now - 3600e3).toISOString(), looked_at: null, result: null } } }))
  start()
  let r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X], clock: () => now, fetchImpl: world([...junk(X, AT), cbLog(Y, 'other', 'OTHc', AT)]) })
  let m = readMirror(dir, 'base', now)
  check('bisection: a log from another emitter, under another topic0, or creating another token is refused; nothing added', r.ok && r.looked[0].result === 'created_elsewhere' && m.tokens.length === 0, JSON.stringify(r.looked))
  start()
  r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X], clock: () => now, fetchImpl: world([cbLog(X, 'x', 'Xc', AT + 5)]) })
  check('...and a log for the right token but outside the block found is refused too', r.looked[0].result === 'created_elsewhere' && readMirror(dir, 'base', now).tokens.length === 0)
  start()
  r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X], clock: () => now, fetchImpl: world([...junk(X, AT), cbLog(X, 'x', 'Xc', AT)]) })
  check('...the one valid log among them is the one taken', r.looked[0].result === 'found' && readMirror(dir, 'base', now).tokens.map((t) => t.address).join() === X)
  // A revoked token waiting on the list comes back through the lookup.
  start({ revoked: [{ address: X, block: AT, block_hash: H('d2'), tx: H('bb'), log_index: 2, revoked_at: '2026-11-25T10:00:00Z', why: 'w' }] })
  r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X], clock: () => now, fetchImpl: world([cbLog(X, 'x', 'Xc', AT)]) })
  m = readMirror(dir, 'base', now)
  check('a revoked token on the list is looked for, and a valid log restores it', r.looked[0]?.result === 'found' && m.tokens[0].restored_at === new Date(now).toISOString() && (m.revoked || []).length === 0)
  // The budget inside the bisection, and the pacing between calls.
  start()
  let t = 0, calls = 0
  const slow = async (url, init) => { calls++; return world([cbLog(X, 'x', 'Xc', AT)])(url, init) }
  r = await lookupAwaiting({ paceMs: 0, chain: 'base', dir, listAddresses: [X], budgetMs: 5, clock: () => now + (t++), fetchImpl: slow })
  check('the budget is checked inside the bisection: a long one stops midway, and a cut-short search is no result', calls <= 6 && r.looked.length === 0 && !readMirror(dir, 'base', now).awaiting[X].looked_at, `calls=${calls}`)
  start()
  const slept = []
  await lookupAwaiting({ paceMs: 50, chain: 'base', dir, listAddresses: [X], clock: () => now, sleep: async (ms) => { slept.push(ms) }, fetchImpl: world([cbLog(X, 'x', 'Xc', AT)]) })
  check('...and the calls are paced', slept.length > 10 && slept.every((ms) => ms === 50))
  // Robinhood's rescan adds only the addresses it looks for.
  const rdir = path.join(tmp, 'gate-rh'); fs.mkdirSync(rdir)
  const R1 = '0x' + '6a'.repeat(20)
  fs.writeFileSync(path.join(rdir, 'mirror.json'), JSON.stringify({ ...baseM, chain: 'robinhood', issuer: 'robinhood', factory: MIRRORS.robinhood.factory, topic0: MIRRORS.robinhood.topic0, from_block: 0, scanned_to: 25_000_000, last_ok: { ...baseM.last_ok, target_block: 25_000_000 }, awaiting: { [R1]: { since: new Date(now - 3600e3).toISOString(), looked_at: null, result: null } } }))
  r = await lookupAwaiting({ paceMs: 0, chain: 'robinhood', dir: rdir, listAddresses: [R1], clock: () => now, fetchImpl: async (url, init) => { const q = JSON.parse(init.body).params[0]; return ok(parseInt(q.fromBlock, 16) === 0 ? [rhLog(Z, 'Other', 'OTH', 500), { ...rhLog(R1, 'Fake', 'F', 600), address: '0x' + '99'.repeat(20) }] : []) } })
  m = readMirror(rdir, 'robinhood', now)
  check('Robinhood\'s rescan adds only the addresses looked for, and refuses a foreign emitter\'s log for them', r.looked[0].result === 'not_in_factory_logs' && m.tokens.length === 0)
  // The reconcile: junk refused.
  const cdir = path.join(tmp, 'gate-rc'); fs.mkdirSync(cdir)
  fs.writeFileSync(path.join(cdir, 'mirror.json'), JSON.stringify({ ...baseM, scanned_to: FROM + 999, last_ok: { ...baseM.last_ok, target_block: FROM + 999 } }))
  const rc = await reconcileMirror({ chain: 'base', dir: cdir, clock: () => now, fetchImpl: async () => ok([...junk(X, FROM + 10), { ...cbLog(Y, 'y', 'Yc', FROM + 10), removed: true }]) })
  check('the reconcile refuses another emitter, another topic0 and a removed log', rc.ok && rc.added === 0 && readMirror(cdir, 'base', now).tokens.length === 0)
  // A refused file keeps its waiting list.
  fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ ...baseM, schema: 1, awaiting: { [X]: { since: '2026-11-25T10:00:00Z', looked_at: null, result: null } } }))
  await updateMirror({ chain: 'base', dir, paceMs: 0, budgetMs: 1e9, clock: () => now, fetchImpl: async (url, init) => ok(JSON.parse(init.body).method === 'eth_getBlockByNumber' ? fin(FROM + 10) : []) })
  check('a refused file keeps its waiting list, with when each began waiting', readMirror(dir, 'base', now).awaiting?.[X]?.since === '2026-11-25T10:00:00Z')
}

console.log('the comparison')
{
  const m = { tokens: [{ address: '0xaa' }, { address: '0xbb' }, { address: '0xcc' }] }
  const c = compareMirror(m, ['0xAA', '0xbb', '0xdd'])
  check('what the list has that the factory never created, and what the factory created that the list leaves out', c.listed === 3 && c.created === 3 && JSON.stringify(c.on_list_not_created) === '["0xdd"]' && JSON.stringify(c.created_not_on_list) === '["0xcc"]')
  const dir = path.join(tmp, 'rh')
  const rec = recordComparison(dir, 'robinhood', ['0x' + '1'.repeat(40)], '2026-11-12T21:00:00Z')
  check('...recorded in the mirror file once caught up to the finalized target', rec && readMirror(dir, 'robinhood', Date.parse('2026-11-25T13:00:00Z')).comparison.created === 2 && rec.created_not_on_list.length === 1)
  const behind = path.join(tmp, 'base')
  check('...and not before: a mirror still backfilling compares nothing', recordComparison(behind, 'base', ['0xaa'], 'x') === null)
}

console.log('the health check reads success, not attempts')
{
  const now = Date.parse('2026-11-25T12:00:00Z'), ago = (min) => new Date(now - min * 60e3).toISOString()
  const run = (mirror) => { const out = {}; mirrorChecks((k, bad, text) => { out[k] = { bad, text } }, 'Base', 'base', mirror, now); return out['mirror-stale:base'] }
  check('caught up to a recent finalized block: quiet', run({ last_ok: { at: ago(2), target_block_time: ago(30) }, updated_at: ago(2), last_error: null }).bad === false)
  check('a fresh attempt but no finalized block for hours: alerts, with the error (a failing RPC must not look fresh)', (() => { const r = run({ last_ok: { at: ago(200), target_block_time: ago(220) }, updated_at: ago(2), last_error: 'rpc eth_getLogs: HTTP 502' }); return r.bad && /502/.test(r.text) })())
  check('a finalized block stuck for days, reached again every run: alerts (last_ok.at is fresh, the block is not)', (() => { const r = run({ last_ok: { at: ago(1), target_block_time: ago(3 * 24 * 60) }, updated_at: ago(1), last_error: null }); return r.bad && /stuck/.test(r.text) })())
  check('a first backfill that is moving without an error: reported, does not page', (() => { const r = run({ last_ok: null, updated_at: ago(5), last_error: null, scanned_to: 50_000_000 }); return !r.bad && /backfilling/.test(r.text) })())
  check('...a backfill that has stopped moving, or errs, pages', run({ last_ok: null, updated_at: ago(300), last_error: null }).bad && run({ last_ok: null, updated_at: ago(5), last_error: 'rpc x' }).bad)
  check('no mirror at all, or one it does not trust: pages, and says it is rebuilt', (() => { const r = run(null); return r.bad && /rebuilt/.test(r.text) })())
}

const unit = fs.readFileSync(new URL('../../deployment/systemd/stp-mirror.service', import.meta.url), 'utf8')
const timer = fs.readFileSync(new URL('../../deployment/systemd/stp-mirror.timer', import.meta.url), 'utf8')
check('the unit writes only the chains\' stock-peg directories and alerts on failure; the timer runs every 15 minutes', /^StateDirectory=pos\/base\/stock-peg pos\/robinhood\/stock-peg$/m.test(unit) && !/ReadWritePaths/.test(unit) && /--chain=base --root=\/var\/lib\/pos\/base /.test(unit) && /--chain=robinhood --root=\/var\/lib\/pos\/robinhood /.test(unit) && /exit \$\$rc'/.test(unit) && /OnFailure=stp-alert@%n\.service/.test(unit) && /--chain=base/.test(unit) && /--chain=robinhood/.test(unit) && /OnCalendar=\*:04\/15/.test(timer))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
