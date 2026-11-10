// evm/core/stocks/market-session.test.mjs — the session an instant falls in, on the New York clock, with daylight
// saving, weekends, holidays and early closes; and `unknown` past the calendar, never a guess.
//
// Run: node evm/core/stocks/market-session.test.mjs

import { usEquitySession, newYorkClock, NYSE_CALENDAR, SESSIONS } from './market-session.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const at = (iso) => usEquitySession(Date.parse(iso))

console.log('the New York clock')
check('winter: 14:30Z is 09:30 in New York', newYorkClock(Date.parse('2026-12-01T14:30:00Z')).minutes === 9 * 60 + 30)
check('summer: 13:30Z is 09:30 in New York', newYorkClock(Date.parse('2026-07-01T13:30:00Z')).minutes === 9 * 60 + 30)

console.log('a regular week')
check('a Tuesday at 10:00 New York is regular', at('2026-11-10T15:00:00Z').session === 'regular')
check('09:29 is still pre-market', at('2026-11-10T14:29:00Z').session === 'pre')
check('16:00 is after hours', at('2026-11-10T21:00:00Z').session === 'post')
check('20:00 is closed for the night', at('2026-11-11T01:00:00Z').session === 'closed' && at('2026-11-11T01:00:00Z').reason === 'overnight')
check('03:59 is closed, 04:00 is pre', at('2026-11-10T08:59:00Z').session === 'closed' && at('2026-11-10T09:00:00Z').session === 'pre')
check('daylight saving moves the open: 13:30Z on 1 July is regular', at('2026-07-01T13:30:00Z').session === 'regular')
check('Saturday is closed for the weekend', at('2026-11-07T15:00:00Z').reason === 'weekend')
check('Sunday is closed for the weekend', at('2026-11-08T15:00:00Z').reason === 'weekend')

console.log('holidays and early closes')
const thx = at('2026-11-26T15:00:00Z')
check('Thanksgiving 2026 at noon is closed, holiday named', thx.session === 'closed' && thx.reason === 'holiday' && thx.holiday === 'Thanksgiving Day', JSON.stringify(thx))
const fri = at('2026-11-27T17:30:00Z')
check('the day after Thanksgiving at 12:30 is regular, early close', fri.session === 'regular' && fri.early_close === true)
check('...and at 13:00 it is after hours', at('2026-11-27T18:00:00Z').session === 'post')
check('...and at 17:00 it is closed', at('2026-11-27T22:00:00Z').session === 'closed')
check('Christmas Eve 2026 closes early', at('2026-12-24T18:30:00Z').session === 'post')
check('Christmas Day 2026 is closed', at('2026-12-25T15:00:00Z').reason === 'holiday')
check('Independence Day 2026 is observed on Friday 3 July', at('2026-07-03T15:00:00Z').reason === 'holiday')
check('Christmas 2027 is observed on Friday 24 December', at('2027-12-24T15:00:00Z').reason === 'holiday')

console.log('beyond the calendar')
check('a date past the last covered year is unknown, not regular', at('2028-03-01T15:00:00Z').session === 'unknown' && at('2028-03-01T15:00:00Z').reason === 'outside_calendar')
check('a NaN instant is unknown', usEquitySession(NaN).session === 'unknown')
check('every answer is one of the declared sessions', ['2026-11-10T15:00:00Z', '2026-11-26T15:00:00Z', '2028-01-01T00:00:00Z'].every((x) => SESSIONS.includes(at(x).session)))

console.log('the table')
const days = [...Object.keys(NYSE_CALENDAR.holidays), ...Object.keys(NYSE_CALENDAR.earlyCloses)]
check('no holiday falls on a weekend', days.every((d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6 }))
check('the table covers every year it claims', NYSE_CALENDAR.years.every((y) => Object.keys(NYSE_CALENDAR.holidays).filter((d) => d.startsWith(String(y))).length === 10))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
