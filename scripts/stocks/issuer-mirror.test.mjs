// scripts/stocks/issuer-mirror.test.mjs: the issuer's list rebuilt from its factory's events, on both chains: decoded,
// scanned forward within a time budget, never losing state on a failure, and compared with the API's list.
//
// Run: node scripts/stocks/issuer-mirror.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MIRRORS, tokenOf, updateMirror, compareMirror, recordComparison, readMirror } from './issuer-mirror.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const w = (n) => n.toString(16).padStart(64, '0')
const s = (text) => { const b = Buffer.from(text, 'utf8').toString('hex'); return w(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64 || 64, '0') }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'))

// A Robinhood factory log as the chain gives it (12.11): topic1 an asset id; data: token, offset name, offset symbol.
const rhLog = (token, name, symbol, block = 100) => {
  const n = s(name), sy = s(symbol)
  const data = '0x' + w(BigInt('0x' + token.slice(2))) + w(0x60) + w(0x60 + n.length / 2) + n + sy
  return { address: MIRRORS.robinhood.factory, topics: [MIRRORS.robinhood.topic0, '0x' + '7c'.repeat(32)], data, blockNumber: '0x' + block.toString(16), transactionHash: '0x' + 'aa'.repeat(32), logIndex: '0x1' }
}
// A Coinbase factory log: topic1 the token; data: offset name, offset symbol, ..., decimals at word 4.
const cbLog = (token, name, symbol, block = 48459900) => {
  const n = s(name), sy = s(symbol)
  const data = '0x' + w(0xa0) + w(0xa0 + n.length / 2) + w(0) + w(0) + w(18) + n + sy
  return { address: MIRRORS.base.factory, topics: [MIRRORS.base.topic0, '0x' + w(BigInt('0x' + token.slice(2)))], data, blockNumber: '0x' + block.toString(16), transactionHash: '0x' + 'bb'.repeat(32), logIndex: '0x2' }
}

console.log('decoding')
{
  const T = '0x322f0929c4625ed5bad873c95208d54e1c003b2d'
  const r = tokenOf('robinhood', rhLog(T, 'Tesla • Robinhood Token', 'TSLA'))
  check('Robinhood: the token is the first word of the data, then name and symbol', r && r.address === T && r.symbol === 'TSLA' && r.name === 'Tesla • Robinhood Token' && r.block === 100 && r.log_index === 1, JSON.stringify(r))
  const c = tokenOf('base', cbLog('0xb20000000000000000000078ee7ce2fe4908108c', 'NVIDIA Corporation', 'NVDAc'))
  check('Base: the token is topic1, the decimals the fifth word', c && c.address === '0xb20000000000000000000078ee7ce2fe4908108c' && c.symbol === 'NVDAc' && c.decimals === 18, JSON.stringify(c))
  check('a log with another topic0 is not a token', tokenOf('robinhood', { ...rhLog(T, 'x', 'y'), topics: ['0x' + '11'.repeat(32)] }) === null && tokenOf('nochain', rhLog(T, 'x', 'y')) === null)
}

console.log('scanning')
{
  const dir = path.join(tmp, 'rh'); fs.mkdirSync(dir)
  const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40)
  let head = 25_000_000, calls = []
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body)
    if (b.method === 'eth_blockNumber') return new Response(JSON.stringify({ result: '0x' + head.toString(16) }))
    const p = b.params[0]; calls.push([parseInt(p.fromBlock, 16), parseInt(p.toBlock, 16)])
    const logs = parseInt(p.fromBlock, 16) === 0 ? [rhLog(A, 'Tesla • Robinhood Token', 'TSLA', 19698)] : parseInt(p.fromBlock, 16) === 20_000_000 ? [rhLog(B, 'NOK', 'NOK', 20_000_001)] : []
    return new Response(JSON.stringify({ result: logs }))
  }
  const r1 = await updateMirror({ chain: 'robinhood', dir, fetchImpl, paceMs: 0 })
  check('a first run scans from the factory\'s start to the head in the chain\'s window (10M blocks on Robinhood)', r1.ok && r1.caught_up && r1.tokens === 2 && calls.length === 3 && calls[0][0] === 0 && calls[0][1] === 9_999_999 && calls[2][1] === 25_000_000, JSON.stringify(calls))
  calls = []; head = 25_000_100
  const r2 = await updateMirror({ chain: 'robinhood', dir, fetchImpl, paceMs: 0 })
  check('...the next run asks only for the blocks since', r2.ok && calls.length === 1 && calls[0][0] === 25_000_001 && r2.added === 0 && r2.tokens === 2)
  const before = fs.readFileSync(path.join(dir, 'mirror.json'), 'utf8')
  head = 25_000_200
  const down = await updateMirror({ chain: 'robinhood', dir, fetchImpl: async () => new Response('bad gateway', { status: 502 }), paceMs: 0 })
  const after = readMirror(dir, 'robinhood')
  check('a source that fails: the run says so, and keeps every token and where it had got to', !down.ok && /rpc/.test(down.error) && after.tokens.length === 2 && after.scanned_to === JSON.parse(before).scanned_to)
  let t = 0
  const slow = path.join(tmp, 'base'); fs.mkdirSync(slow)
  const r3 = await updateMirror({ chain: 'base', dir: slow, paceMs: 0, budgetMs: 3, clock: () => t++, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); return new Response(JSON.stringify({ result: b.method === 'eth_blockNumber' ? '0x' + (48459816 + 50_000).toString(16) : [] })) } })
  check('a time budget: the backfill stops midway, writes how far it got, and goes on next run (1,000 blocks a call on Base)', r3.ok && !r3.caught_up && r3.scanned_to > 48459816 && r3.scanned_to < 48459816 + 50_000 && (r3.scanned_to - 48459815) % 1000 === 0, JSON.stringify(r3))
}

{
  // 12.11: the keyless Base gateway answered 'rate limit exceeded' after ~200 calls, and the unit failed with an alert.
  const dir = path.join(tmp, 'throttled'); fs.mkdirSync(dir)
  let n = 0
  const r = await updateMirror({ chain: 'base', dir, paceMs: 0, fetchImpl: async (url, init) => { const b = JSON.parse(init.body); if (b.method === 'eth_blockNumber') return new Response(JSON.stringify({ result: '0x' + (48459816 + 10_000).toString(16) })); return ++n > 3 ? new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } })) : new Response(JSON.stringify({ result: [] })) } })
  check('a rate limit during the backfill is a pause: ok, marked throttled, progress kept for the next run', r.ok && r.throttled && r.error === null && r.scanned_to === 48459816 + 2999 && readMirror(dir, 'base').scanned_to === 48459816 + 2999, JSON.stringify(r))
}

console.log('the comparison')
{
  const m = { tokens: [{ address: '0xaa' }, { address: '0xbb' }, { address: '0xcc' }] }
  const c = compareMirror(m, ['0xAA', '0xbb', '0xdd'])
  check('what the list has that the factory never created, and what the factory created that the list leaves out', c.listed === 3 && c.created === 3 && JSON.stringify(c.on_list_not_created) === '["0xdd"]' && JSON.stringify(c.created_not_on_list) === '["0xcc"]')
  const dir = path.join(tmp, 'rh')
  const rec = recordComparison(dir, 'robinhood', ['0x' + '1'.repeat(40)], '2026-11-12T21:00:00Z')
  check('...recorded in the mirror file once caught up', rec && readMirror(dir, 'robinhood').comparison.created === 2 && rec.created_not_on_list.length === 1)
  const behind = path.join(tmp, 'base')
  check('...and not before: a mirror still backfilling compares nothing', recordComparison(behind, 'base', ['0xaa'], 'x') === null)
}

const unit = fs.readFileSync(new URL('../../deployment/systemd/stp-mirror.service', import.meta.url), 'utf8')
const timer = fs.readFileSync(new URL('../../deployment/systemd/stp-mirror.timer', import.meta.url), 'utf8')
check('the unit writes only the chains\' stock-peg directories and alerts on failure; the timer runs every 15 minutes', /ReadWritePaths=\/var\/lib\/stp\/base\/stock-peg \/var\/lib\/stp\/robinhood\/stock-peg\n/.test(unit) && /OnFailure=stp-alert@%n\.service/.test(unit) && /--chain=base/.test(unit) && /--chain=robinhood/.test(unit) && /OnCalendar=\*:04\/15/.test(timer))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
