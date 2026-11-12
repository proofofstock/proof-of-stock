// scripts/stocks/text-evidence.test.mjs: a newly flagged contract's symbol() and name(), read from the chain at one
// block, as raw bytes, with a command to ask again; written only on new observed case events, never after the fact.
//
// Run: node scripts/stocks/text-evidence.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTextEvidence, decodeText } from './text-evidence.mjs'
import { ONCHAIN } from './onchain-pools.mjs'
import { fakeChain } from './test-fake-chain.mjs'
import { recordCases, pendingCaseAddresses } from '../../evm/core/stocks/history.mjs'
import { validateV2 } from '../../schemas/v2/validate.mjs'
import { publicEvent } from '../../apps/stocks-history.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const w = (n) => BigInt(n).toString(16).padStart(64, '0')
const abiString = (s) => { const b = Buffer.from(s, 'utf8').toString('hex'); return w(0x20) + w(b.length / 2) + b.padEnd(Math.max(64, Math.ceil(b.length / 64) * 64), '0') }
const X = '0x' + 'e1'.repeat(20), Y = '0x' + 'e2'.repeat(20)

console.log('reading the chain')
{
  const chain = fakeChain({ rpc: ONCHAIN.base.rpc })
  chain.set(X, '0x95d89b41', abiString('NVDAc'))
  chain.set(X, '0x06fdde03', abiString('NVIDIA Corporation'))
  chain.set(Y, '0x95d89b41', abiString('TSLA'))
  chain.set(Y, '0x06fdde03', abiString('Totally Not Tesla'))
  const ev = await readTextEvidence({ chain: 'base', chainId: 8453, addresses: [X, Y], collector: new Map([[X, { symbol: 'NVDAc', name: 'NVIDIA  Corporation' }], [Y, { symbol: 'TSLA', name: 'Tesla' }]]), fetchImpl: chain.fetch(async () => new Response('', { status: 404 })), env: {} })
  const x = ev.get(X), y = ev.get(Y)
  check('each address gets the raw bytes of symbol() and name(), the block and its hash', x && x.block_number === chain.block && x.block_hash === chain.hash && /^0x[0-9a-f]+$/.test(x.symbol_return) && decodeText(x.symbol_return) === 'NVDAc' && decodeText(x.name_return) === 'NVIDIA Corporation', JSON.stringify(x))
  check('...compared with the collector\'s text after normalising both (spaces), and a mismatch is said, not hidden', x.matches_collector === true && y.matches_collector === false)
  check('...with a command that asks the chain again, and on Base no archive node is needed', /^cast call --block \d+ 0x(e1){20} 'symbol\(\)\(string\)' --rpc-url https:\/\//.test(x.reproduce) && x.needs_archive_rpc === false && x.chain_id === 8453)
  const down = await readTextEvidence({ chain: 'base', addresses: [X], fetchImpl: async () => new Response('', { status: 503 }), env: {} })
  check('the chain unreachable: no evidence at all, never a guess', down.size === 0)
  check('on Robinhood Chain replaying needs an archive node, and says so', ONCHAIN.robinhood.archive === false)
}

console.log('the case archive')
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'textev-'))
  const list = (items) => ({ items, torn_files: 0, truncated: false })
  const it = (address, symbol) => ({ address, symbol, name: symbol + ' Corp', kind: 'registry_symbol', registry_symbol: 'NVDAc', registry_address: '0x' + 'aa'.repeat(20) })
  // The first run is a backfill: nothing is pending, and nothing gets evidence after the fact.
  check('no pending address on the archive\'s first (backfill) run', pendingCaseAddresses({ root, list: list([it(X, 'NVDAc')]) }).length === 0)
  recordCases({ root, list: list([it(X, 'NVDAc')]), registry: new Set(), chainId: 8453, at: Date.parse('2026-11-12T10:00:00Z'), validate: validateV2, textEvidence: new Map() })
  const pending = pendingCaseAddresses({ root, list: list([it(X, 'NVDAc'), it(Y, 'NVDAc')]), chainId: 8453, at: Date.parse('2026-11-12T16:00:00Z') })
  check('the next run asks only about the new case', JSON.stringify(pending) === JSON.stringify([Y]))
  const evY = { chain_id: 8453, block_number: 7, block_hash: '0x' + 'b1'.repeat(32), symbol_return: '0x' + abiString('NVDAc'), name_return: null, matches_collector: false, reproduce: 'cast call ...', needs_archive_rpc: false }
  const h = recordCases({ root, list: list([it(X, 'NVDAc'), it(Y, 'NVDAc')]), registry: new Set(), chainId: 8453, at: Date.parse('2026-11-12T16:00:00Z'), validate: validateV2, textEvidence: new Map([[Y, evY]]) })
  const rows = fs.readdirSync(path.join(root, 'stock-peg', 'history')).filter((f) => f.startsWith('cases-')).flatMap((f) => fs.readFileSync(path.join(root, 'stock-peg', 'history', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  const ry = rows.find((r) => r.address === Y), rx = rows.find((r) => r.address === X)
  check('the new observed case carries the evidence, valid against the case schema', h.invalid === 0 && ry.text_evidence?.block_number === 7 && validateV2('stock-case', ry).valid, JSON.stringify(validateV2('stock-case', ry).errors))
  check('...the backfilled one never gets any', rx.source === 'backfilled' && !('text_evidence' in rx))
  check('...and the public event shows it as hex, as stored', publicEvent(ry).text_evidence.symbol_return === evY.symbol_return && !('text_evidence' in publicEvent(rx)))
  const Z = '0x' + 'e3'.repeat(20)
  recordCases({ root, list: list([it(X, 'NVDAc'), it(Y, 'NVDAc'), it(Z, 'NVDAc')]), registry: new Set(), chainId: 8453, at: Date.parse('2026-11-12T22:00:00Z'), validate: validateV2, textEvidence: new Map() })
  const rz = fs.readdirSync(path.join(root, 'stock-peg', 'history')).flatMap((f) => fs.readFileSync(path.join(root, 'stock-peg', 'history', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).find((r) => r.address === Z)
  check('a new case when the chain could not be read: text_evidence null, and still valid', rz.text_evidence === null && validateV2('stock-case', rz).valid)
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const l of failures) console.log(l); process.exit(1) }
