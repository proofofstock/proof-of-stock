// apps/history-gone-reason.test.mjs: a closed look-alike case says WHY it closed (apps/stocks-history.mjs). A close
// recorded before gone_reason existed gets it from the registry archive at the time of the close; the page and the
// API never make it read as if the look-alike had mended its ways.
//
// Run: node apps/history-gone-reason.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHistoryStore, historyPage } from './stocks-history.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-gone-'))
const dir = path.join(root, 'stock-peg', 'history')
fs.mkdirSync(dir, { recursive: true })
const H = '0x' + '11'.repeat(20), N = '0x' + '22'.repeat(20), REAL_H = '0x' + 'aa'.repeat(20), REAL_N = '0x' + 'bb'.repeat(20)
const ev = (o) => JSON.stringify({ _schema_version: '1.0', chain_id: 8453, source: 'observed', rule_version: 'x', kind: 'registry_name', first_seen_at: '2026-11-14T00:00:00Z', flagged_at: '2026-11-14T06:00:00Z', symbol: 'HOG', name: 'Harley', ...o })
fs.writeFileSync(path.join(dir, 'cases-2026-11-17.jsonl'), [
  ev({ event: 'opened', at: '2026-11-14T06:00:00Z', address: H, registry_symbol: 'HOGc', registry_address: REAL_H }),
  ev({ event: 'opened', at: '2026-11-14T06:00:00Z', address: N, registry_symbol: 'NKEc', registry_address: REAL_N }),
  // two closes from before gone_reason existed: one whose stock left the list first, one whose stock stayed
  ev({ event: 'gone', at: new Date(Date.now() - 3600e3).toISOString(), address: H, registry_symbol: 'HOGc', registry_address: REAL_H }),
  ev({ event: 'gone', at: new Date(Date.now() - 3600e3).toISOString(), address: N, registry_symbol: 'NKEc', registry_address: REAL_N })
].join('\n') + '\n')
const reg = (o) => JSON.stringify({ hash: 'sha256:' + 'c'.repeat(64), prev_hash: null, records: 2, added: [], removed: [], changed: [], ...o })
fs.writeFileSync(path.join(dir, 'registry-2026-11-17.jsonl'), [
  reg({ fetched_at: '2026-11-10T00:00:00Z', added: [REAL_H, REAL_N] }),
  reg({ fetched_at: new Date(Date.now() - 5 * 3600e3).toISOString(), removed: [REAL_H], prev_hash: 'sha256:' + 'd'.repeat(64) })
].join('\n') + '\n')

const store = createHistoryStore({ roots: { base: root } })
store.refresh('base')
const got = store.cases('base').events.filter((e) => e.event === 'gone')
const of = (a) => got.find((e) => e.address === a)
check('a close whose imitated stock had left the issuer\'s list says so', of(H) && of(H).gone_reason === 'imitated_left_list', JSON.stringify(of(H)))
check('a close whose stock was still listed says it no longer copies one', of(N) && of(N).gone_reason === 'no_longer_matches', JSON.stringify(of(N)))
const page = historyPage({ store, chains: ['base'], now: Date.now(), version: '0', assets: { css: 'a', docsCss: 'b' } })
check('the history page names the reason, and never "left the list" on its own', page.includes('closed because HOGc left the Coinbase list') && page.includes('closed: it no longer copies a listed stock') && !page.includes('left the list<'))
const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
check('the landing board shows the same reason', js.includes("imitated_left_list: 'closed: the stock it copied left the issuer\\'s list'") && js.includes("(e.event === 'gone' && GONE_WHY[e.gone_reason])"))
fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
