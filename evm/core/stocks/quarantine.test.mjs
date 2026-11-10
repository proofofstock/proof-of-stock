// evm/core/stocks/quarantine.test.mjs — readings known to be wrong leave the window; correct ones around them stay.
//
// Run: node evm/core/stocks/quarantine.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quarantined } from './quarantine.mjs'
import { loadWindow } from './readings-window.mjs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }

const T = '0x' + 'd7'.repeat(20)
const row = (iso, premium, quote) => ({ token_address: T, observed_at: iso, premium, pools: { top: [{ quote_symbol: quote }] } })

console.log('the 09.11 circular-price window')
check('a memecoin-priced reading inside the window is quarantined', Boolean(quarantined(row('2026-11-09T18:10:00Z', 241, 'IALI'))))
check('a USDG-priced reading inside the window is kept', quarantined(row('2026-11-09T18:10:00Z', 0.004, 'USDG')) === null)
check('a memecoin-priced reading outside the window is kept (the recorder no longer writes them)', quarantined(row('2026-11-09T20:30:00Z', 0.01, 'IALI')) === null)
check('a reading with no premium is not touched', quarantined(row('2026-11-09T18:10:00Z', null, 'IALI')) === null)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quar-'))
fs.mkdirSync(path.join(root, 'stock-peg'))
fs.writeFileSync(path.join(root, 'stock-peg', 'stock-peg-2026-11-09.jsonl'), [row('2026-11-09T17:00:00Z', 0.001, 'USDG'), row('2026-11-09T18:10:00Z', 241, 'IALI'), row('2026-11-09T18:25:00Z', 0.002, 'USDG')].map((r) => JSON.stringify(r)).join('\n') + '\n')
const w = await loadWindow(root, Date.parse('2026-11-09T21:00:00Z'), 72)
const pts = w.byToken.get(T).points
check('the window loads the good readings and counts the quarantined one', pts.length === 2 && pts.every(([, p]) => p < 1) && w.quarantined === 1, JSON.stringify({ pts, q: w.quarantined }))
fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
