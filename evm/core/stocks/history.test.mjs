// evm/core/stocks/history.test.mjs — the history is append-only and says how each fact was learned (TZ §H1, §H2).
// Run: node evm/core/stocks/history.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { replayCases, caseEvents, recordCases, canonicalRegistry, registryHash, recordRegistry, HISTORY_DIR } from './history.mjs'
import { createHistoryStore } from '../../../apps/stocks-history.mjs'
import { eachJsonl } from '../../../scripts/lib/jsonl.mjs'
import { validateV2 } from '../../../base/dataset-v2/schema-validator.mjs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b1'.repeat(20), C = '0x' + 'c1'.repeat(20), R = '0x' + 'ee'.repeat(20)
const item = (address, kind = 'registry_symbol', extra = {}) => ({ address, symbol: 'NVDAc', name: 'NVIDIA', kind, ticker: 'NVDA', registry_symbol: 'NVDAc', registry_address: R, first_seen_at: '2026-08-01T10:00:00.000Z', deployer: null, ...extra })
const list = (items, extra = {}) => ({ items, torn_files: 0, truncated: false, ...extra })
const T0 = Date.parse('2026-11-10T12:00:00Z'), T1 = T0 + 6 * 3600e3, T2 = T1 + 6 * 3600e3, T3 = T2 + 6 * 3600e3
const newRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stp-history-'))
const rowsOf = (root, prefix) => (fs.existsSync(path.join(root, 'stock-peg', HISTORY_DIR)) ? fs.readdirSync(path.join(root, 'stock-peg', HISTORY_DIR)) : []).filter((f) => f.startsWith(prefix)).sort()
  .flatMap((f) => fs.readFileSync(path.join(root, 'stock-peg', HISTORY_DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
const run = (root, items, at, registry = new Set([R]), extra = {}) => recordCases({ root, list: list(items, extra), registry, chainId: 8453, at, validate: validateV2 })

console.log('H1: the case archive')
{
  const root = newRoot()
  const h0 = run(root, [item(A), item(B, 'issuer_name_suffix')], T0)
  let rows = rowsOf(root, 'cases-')
  check('the first archive of a chain is backfilled, never passed off as seen live', h0.written === 2 && rows.every((r) => r.event === 'opened' && r.source === 'backfilled' && r.flagged_at === null && r.backfill_source && r.first_seen_at === '2026-08-01T10:00:00.000Z'))
  check('every row it writes passes its schema', rows.every((r) => validateV2('stock-case', r).valid))

  const h1 = run(root, [item(A), item(B, 'issuer_name_suffix')], T1)
  check('a run with no change writes no row', h1.written === 0 && rowsOf(root, 'cases-').length === 2)

  run(root, [item(A), item(B, 'issuer_name_suffix'), item(C)], T2)
  rows = rowsOf(root, 'cases-')
  const c = rows.find((r) => r.address === C)
  check('a case opened after the archive began is observed, with the run that flagged it', c && c.source === 'observed' && c.flagged_at === new Date(T2).toISOString())

  run(root, [item(A, 'issuer_name_suffix'), item(C)], T3, new Set([R, B]))
  rows = rowsOf(root, 'cases-')
  const last = rows.slice(-2)
  check('a changed signal is a kind_changed row, naming the previous kind', last.some((r) => r.event === 'kind_changed' && r.address === A && r.previous_kind === 'registry_symbol'))
  check('a case the issuer then listed closes as listed, never silently', last.some((r) => r.event === 'listed' && r.address === B))

  const replay = replayCases(rows)
  check('replaying the archive reproduces the current list, as sets', [...replay.keys()].sort().join() === [A, C].sort().join())
  run(root, [item(C)], T3 + 6 * 3600e3)
  check('a case that left a complete list closes as gone', rowsOf(root, 'cases-').some((r) => r.event === 'gone' && r.address === A))
}
{
  // Two runs on the same day land in the same file: the second must add to it, not replace it.
  const root = newRoot()
  run(root, [item(A)], T0)
  const file = path.join(root, 'stock-peg', HISTORY_DIR, `cases-${new Date(T0).toISOString().slice(0, 10)}.jsonl`)
  const before = fs.readFileSync(file, 'utf8')
  run(root, [item(A), item(B)], T0 + 3600e3)
  const after = fs.readFileSync(file, 'utf8')
  check('earlier rows are never rewritten: the old file only grows', after.startsWith(before) && after.length > before.length)
}
{
  const open = replayCases([{ event: 'opened', address: A, kind: 'registry_symbol', registry_address: R, flagged_at: null }])
  check('a torn day file closes nothing: a token missing from a partial list has not left it', caseEvents(open, list([], { torn_files: 1 }), { registry: new Set(), at: T0, chainId: 8453, firstArchive: false }).length === 0)
  check('a truncated list closes nothing', caseEvents(open, list([], { truncated: true }), { registry: new Set(), at: T0, chainId: 8453, firstArchive: false }).length === 0)
  check('a listing closes a case even when the list was partial', caseEvents(open, list([], { torn_files: 1 }), { registry: new Set([A]), at: T0, chainId: 8453, firstArchive: false })[0]?.event === 'listed')
  check('the schema refuses a backfilled row that claims a flag time', !validateV2('stock-case', { _schema_version: '1.0', chain_id: 1, event: 'opened', at: new Date(T0).toISOString(), source: 'backfilled', backfill_source: 'x', rule_version: 'v', address: A, kind: 'k', registry_symbol: null, registry_address: null, first_seen_at: null, flagged_at: new Date(T0).toISOString() }).valid)
}

console.log('H2: registry snapshots')
{
  const rec = (address, extra = {}) => ({ address, symbol: 'X', name: 'X Inc', isin: 'US0000000000', multiplier: 1, multiplier_pending: null, supplied: true, paused: [], reference: { price_usd: Math.random() }, ...extra })
  check('the canonical list leaves prices out, so they never make a snapshot', !/price/.test(JSON.stringify(canonicalRegistry([rec(A)]))))
  const root = newRoot()
  const reg = (records, at) => recordRegistry({ root, records, chainId: 8453, issuer: 'coinbase', at, validate: validateV2 })
  const s0 = reg([rec(B), rec(A)], T0)
  check('the first registry read writes a full snapshot', s0.written === 1 && s0.first)
  check('an unchanged registry writes nothing, whatever its prices did', reg([rec(A), rec(B)], T1).written === 0)
  check('the same list in another order hashes the same', registryHash(canonicalRegistry([rec(A), rec(B)])) === registryHash(canonicalRegistry([rec(B), rec(A)])))
  const s2 = reg([rec(A, { multiplier: 1.01 }), rec(B), rec(C)], T2)
  const rows = rowsOf(root, 'registry-')
  check('one change writes one snapshot that names what changed', s2.written === 1 && rows.length === 2 && rows[1]?.added.join() === C && rows[1].changed.join() === A && rows[1].removed.length === 0)
  check('each snapshot chains to the previous one', rows[1]?.prev_hash === rows[0]?.hash && rows[0]?.prev_hash === null)
  check('a snapshot holds no price', !JSON.stringify(rows).includes('price_usd'))
  check('every snapshot passes its schema', rows.every((r) => validateV2('stock-registry-snapshot', r).valid))
  reg([rec(A, { multiplier: 1.01 }), rec(C)], T3)
  check('a token the issuer dropped is named as removed', rowsOf(root, 'registry-')[2]?.removed.join() === B)
}

console.log('damage is not emptiness')
{
  // A run killed mid-write left a torn last line with no newline: the next append must not glue its row onto it.
  const root = newRoot()
  run(root, [item(A)], T0)
  const file = path.join(root, 'stock-peg', HISTORY_DIR, fs.readdirSync(path.join(root, 'stock-peg', HISTORY_DIR))[0])
  fs.appendFileSync(file, '{"event":"opened","addr')
  run(root, [item(A), item(B)], T0 + 3600e3)
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const good = lines.flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  check('a row appended after a torn tail stays whole and readable', good.some((r) => r.address === B && r.event === 'opened') && lines.length === 3, String(lines.length))

  // An archive directory that cannot be listed (EACCES) is an error, not an empty archive: that would backfill every case.
  const r2 = newRoot()
  run(r2, [item(A)], T0)
  const histPath = path.join(r2, 'stock-peg', HISTORY_DIR)
  const realReaddir = fs.readdirSync
  fs.readdirSync = (p, ...a) => { if (path.resolve(String(p)) === path.resolve(histPath)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return realReaddir(p, ...a) }
  let threw = false
  try { run(r2, [item(A), item(B)], T1) } catch (_) { threw = true } finally { fs.readdirSync = realReaddir }
  check('an unreadable archive stops the run instead of backfilling from scratch', threw && rowsOf(r2, 'cases-').length === 1, String(rowsOf(r2, 'cases-').length))

  // The site's copy: a refresh that cannot list the archive keeps the last good copy and says so.
  const r3 = newRoot()
  run(r3, [item(A)], T0)
  const store = createHistoryStore({ roots: { base: r3 }, now: () => T1 })
  store.refresh('base')
  const before = store.cases('base').counts.opened
  fs.rmSync(path.join(r3, 'stock-peg', HISTORY_DIR), { recursive: true }); fs.writeFileSync(path.join(r3, 'stock-peg', HISTORY_DIR), 'not a directory')
  store.refresh('base')
  const after = store.cases('base')
  check('the site keeps its last good archive when a refresh cannot read it, and says so', before === 1 && after.counts.opened === 1 && typeof after.error === 'string', JSON.stringify({ before, after: after.counts.opened, error: after.error }))

  // A junk line inside a day file is damage; a torn last line is a writer mid-append.
  const f = path.join(newRoot(), 'day.jsonl')
  fs.writeFileSync(f, '{"a":1}\n{"a":2\n{"a":3}\n{"a":4')
  const seen = []
  const bad = await eachJsonl(f, (o) => seen.push(o.a))
  check('eachJsonl counts a damaged middle line, not a torn last one', bad === 1 && seen.join(',') === '1,3', `${bad} ${seen}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
