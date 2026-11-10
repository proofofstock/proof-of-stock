// evm/core/stocks/market-session.mjs — which US equity session an instant falls in, so a peg reading can be read
// against what the underlying market was doing: open, in extended hours, closed for the night or the weekend, or
// closed for a holiday.
//
// Pure, no dependencies: the New York wall clock comes from Intl (daylight saving included).
//
// Sessions (NYSE, New York time): pre 04:00–09:30, regular 09:30–16:00 (13:00 on an early-close day), post until 20:00
// (17:00 on an early-close day), closed otherwise, all day on weekends and full holidays.
//
// ⚠ THE HOLIDAY TABLE IS DATA, AND IT ENDS. A date past the last year it covers answers `unknown`, never `regular`: a
// screener that guesses an exchange open on a holiday it does not know about would read a held reference as fresh,
// which is the one error this module exists to prevent. Extend the table from the exchange's own published calendar.
//
// ⚠ ISSUERS QUOTE BEYOND THE EXCHANGE. Robinhood's stock tokens trade around the clock on weekdays (with an overnight
// session), so a Robinhood reference can be live at 02:00 when this module says `closed`. That is not a contradiction:
// this module describes the PRIMARY listing; the reference's own age says whether the issuer was quoting.

// NYSE full-day closures and early closes (13:00), from the exchange's published calendar.
export const NYSE_CALENDAR = Object.freeze({
  years: [2026, 2027],
  holidays: Object.freeze({
    '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday",
    '2026-04-03': 'Good Friday', '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independence Day (observed)',
    '2026-09-07': 'Labor Day', '2026-11-26': 'Thanksgiving Day', '2026-12-25': 'Christmas Day',
    '2027-01-01': "New Year's Day", '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': "Washington's Birthday",
    '2027-03-26': 'Good Friday', '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth (observed)', '2027-07-05': 'Independence Day (observed)',
    '2027-09-06': 'Labor Day', '2027-11-25': 'Thanksgiving Day', '2027-12-24': 'Christmas Day (observed)',
  }),
  earlyCloses: Object.freeze({
    '2026-11-27': 'Day after Thanksgiving', '2026-12-24': 'Christmas Eve',
    '2027-11-26': 'Day after Thanksgiving',
  }),
})

export const SESSIONS = Object.freeze(['pre', 'regular', 'post', 'closed', 'unknown'])

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })

/** New York wall clock of an instant: { date: 'YYYY-MM-DD', minutes: since local midnight, weekday: 'Mon'.. } */
export function newYorkClock (ms) {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday, year: Number(p.year) }
}

/**
 * @param {number} ms  epoch milliseconds
 * @returns {{ session: 'pre'|'regular'|'post'|'closed'|'unknown', reason: string, ny_date: string, holiday: string|null, early_close: boolean }}
 */
export function usEquitySession (ms, calendar = NYSE_CALENDAR) {
  if (!Number.isFinite(ms)) return { session: 'unknown', reason: 'not_a_time', ny_date: null, holiday: null, early_close: false }
  const c = newYorkClock(ms)
  const out = (session, reason, extra = {}) => ({ session, reason, ny_date: c.date, holiday: null, early_close: false, ...extra })
  if (!calendar.years.includes(c.year)) return out('unknown', 'outside_calendar')
  if (c.weekday === 'Sat' || c.weekday === 'Sun') return out('closed', 'weekend')
  const holiday = calendar.holidays[c.date] || null
  if (holiday) return out('closed', 'holiday', { holiday })
  const early = Boolean(calendar.earlyCloses[c.date])
  const close = early ? 13 * 60 : 16 * 60
  const postEnd = early ? 17 * 60 : 20 * 60
  const m = c.minutes
  const extra = { early_close: early, ...(early ? { holiday: calendar.earlyCloses[c.date] } : {}) }
  if (m >= 4 * 60 && m < 9 * 60 + 30) return out('pre', 'pre_market', extra)
  if (m >= 9 * 60 + 30 && m < close) return out('regular', early ? 'regular_early_close' : 'regular', extra)
  if (m >= close && m < postEnd) return out('post', 'after_hours', extra)
  return out('closed', 'overnight', extra)
}
