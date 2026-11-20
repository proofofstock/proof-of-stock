// scripts/stocks/gap-stats.test.mjs: the aggregate of how far the chain trades from the issuer price.
//
// Everything here is built in a temp directory from rows written by this file: no real reading is read, and the
// suite asserts that the instrument answers with aggregates and nothing else.
//
// Run: node scripts/stocks/gap-stats.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, collector, readChain, render, SESSION_GROUP } from './gap-stats.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const threw = (fn) => { try { fn(); return null } catch (e) { return e.message } }
const close = (a, b, eps = 1e-9) => a != null && Math.abs(a - b) < eps

// 16:00 UTC on a Tuesday is 11:00 in New York: the US market is open. 02:00 UTC is the middle of the night there.
const OPEN = '2026-11-10T16:00:00.000Z'
const SHUT = '2026-11-10T02:00:00.000Z'

console.log('the flags')
{
  check('both chains and everything recorded, by default', parseArgs([]).chains === null && parseArgs([]).days === null)
  check('a window and one chain can be asked for', parseArgs(['--days', '30', '--chain', 'base']).days === 30 && parseArgs(['--chain', 'base']).chains.join() === 'base')
  check('a chain we do not have is refused', /base or robinhood/.test(threw(() => parseArgs(['--chain', 'solana'])) || ''))
  check('a typo stops the run rather than changing the window', /unknown argument/.test(threw(() => parseArgs(['--day', '3'])) || ''))
}

console.log('what a reading is, and what it is not')
{
  const c = collector()
  c.add({ observed_at: OPEN, address: '0xa', premium: 0.01 })
  c.add({ observed_at: OPEN, address: '0xa', premium: null })          // no pool deep enough: a row, not a reading
  c.add({ observed_at: OPEN, address: '0xa', premium_refused: 'sources_disagree' })
  c.add({ observed_at: OPEN, address: '0xa', premium: 'nonsense' })
  const s = c.done()
  check('a row without a price on both sides is counted as a row and not as a reading', s.rows === 4 && s.readings === 1, `${s.rows} rows, ${s.readings} readings`)
  check('...and nothing a stranger could put in the field is read as a number', s.median === 0.01)
}

console.log('what was recorded before the recorder knew better')
{
  // Readings written before the pool-plausibility rule carry their premium forever: nothing here rewrites history.
  // One of them (16.11: a pool at 78 times the issuer price) moves a 99th percentile on its own, so they are counted
  // and left out, and the count is printed where a reader will see it.
  const c = collector()
  for (const p of [0.002, -0.003, 0.004]) c.add({ observed_at: OPEN, address: '0xa', premium: p })
  c.add({ observed_at: OPEN, address: '0xa', premium: 76.4 })        // $341 against $4.36, the one that started it
  c.add({ observed_at: OPEN, address: '0xa', premium: -0.99 })       // a hundredth of the issuer price: decimals
  const s = c.done()
  check('a reading no rule would accept today is left out of every number', s.readings === 3 && close(s.median, 0.003), JSON.stringify({ readings: s.readings, median: s.median }))
  check('...and counted, so the history can be asked whether the rule worked', s.implausible === 2, String(s.implausible))
  check('...while an alarming but possible reading stays in', (() => { const d = collector(); d.add({ observed_at: OPEN, address: '0xa', premium: 0.8 }); const r = d.done(); return r.readings === 1 && r.implausible === 0 })())
  check('the answer says how many it left out, in words', /left out/.test(render({ base: s })) && /not this token/.test(render({ base: s })))
}

console.log('the gap itself')
{
  const c = collector()
  // Nine readings of one token while the market is open: three of them over 1%, one of them negative and large.
  for (const p of [0.0002, -0.0004, 0.001, -0.002, 0.007, 0.012, -0.015, 0.03, -0.0005]) c.add({ observed_at: OPEN, address: '0xa', premium: p })
  const s = c.done()
  check('the gap is a distance, so a token below the issuer price counts like one above it', close(s.median, 0.002), String(s.median))
  check('how often it is big is a share of readings, not of tokens', close(s.over_1_pct, 3 / 9) && close(s.over_half_pct, 4 / 9), `${s.over_1_pct} over 1%, ${s.over_half_pct} over 0.5%`)
  check('the tail is kept as well as the middle, because the tail is the point', close(s.p99, 0.0288, 1e-3) && s.p90 > s.median, `p90 ${s.p90}, p99 ${s.p99}`)
}

console.log('open market and shut market are counted apart')
{
  const c = collector()
  for (let i = 0; i < 10; i++) c.add({ observed_at: OPEN, address: '0xa', premium: 0.001 })
  for (let i = 0; i < 10; i++) c.add({ observed_at: SHUT, address: '0xa', premium: 0.02 })
  const s = c.done()
  check('a reading taken while New York trades is an open-market reading', s.by_session.open.readings === 10 && close(s.by_session.open.median, 0.001))
  check('...and one taken at two in the morning there is not', s.by_session.closed.readings === 10 && close(s.by_session.closed.median, 0.02))
  check('...which is the comparison the whole thing exists for', s.by_session.closed.median > s.by_session.open.median)
  check('the session groups are the three a reader understands', Object.keys(s.by_session).join() === 'open,extended,closed' && SESSION_GROUP.pre === 'extended' && SESSION_GROUP.regular === 'open')
}

console.log('per token, because a market report counts that way')
{
  const c = collector()
  // One token that strays in a fifth of its open-market readings, one that never does, one with too few to judge.
  for (let i = 0; i < 100; i++) c.add({ observed_at: OPEN, address: '0xstray', premium: i < 20 ? 0.02 : 0.001 })
  for (let i = 0; i < 100; i++) c.add({ observed_at: OPEN, address: '0xcalm', premium: 0.0003 })
  for (let i = 0; i < 5; i++) c.add({ observed_at: OPEN, address: '0xnew', premium: 0.05 })
  const s = c.done()
  check('every token is seen', s.tokens === 3)
  check('...but one with a handful of readings is not given a share of its own', s.tokens_counted_open === 2, String(s.tokens_counted_open))
  check('the worst token is reported as the worst, not averaged away', close(s.open_over_1_per_token.max, 0.2) && close(s.open_over_1_per_token.median, 0.1), JSON.stringify(s.open_over_1_per_token))
}

console.log('reading a chain from disk')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-stats-'))
  const dir = path.join(tmp, 'stock-peg')
  fs.mkdirSync(dir, { recursive: true })
  const row = (at, p) => JSON.stringify({ observed_at: at, address: '0xa', premium: p })
  fs.writeFileSync(path.join(dir, 'stock-peg-2026-11-10.jsonl'), [row(OPEN, 0.001), row(OPEN, 0.02), 'not json', ''].join('\n'))
  fs.writeFileSync(path.join(dir, 'stock-peg-2026-11-11.jsonl'), row('2026-11-11T16:00:00.000Z', 0.003) + '\n')
  fs.writeFileSync(path.join(dir, 'runs-2026-11-10.jsonl'), 'ignored\n')
  const s = readChain(tmp)
  check('every day file is read, and a file that is not one is left alone', s.files === 2 && s.readings === 3, JSON.stringify({ files: s.files, readings: s.readings }))
  check('a line that is not a row is counted, not guessed at and not fatal', s.broken === 1)
  check('the days are counted from the readings themselves', s.days === 2)
  const window = readChain(tmp, { days: 1, now: Date.parse('2026-11-11T20:00:00.000Z') })
  check('a window takes the days inside it and no others', window.files === 1 && window.readings === 1, JSON.stringify({ files: window.files, readings: window.readings }))
  const missing = readChain(path.join(tmp, 'nowhere'))
  check('a chain with no readings says so instead of answering with zeros', /no readings under/.test(missing.error || ''), JSON.stringify(missing))
  // What must never happen: a row, or any part of one, in the output.
  const text = render({ base: s })
  check('the answer is an aggregate: no address, no timestamp, no row in it', !/0xa\b/.test(text) && !/observed_at/.test(text) && !/2026-11-10T/.test(text), text.slice(0, 80))
  check('...and it says where its numbers may go', /not git/.test(text))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
