// scripts/ops/cf-analytics.test.mjs: the reading of Cloudflare's own counts, and the file that outlives them.
//
// The plan keeps daily rows for about six days. The history file is therefore the only long record there will be,
// and the one thing it must never do is let a day that has fallen out of that window overwrite the day we already
// wrote down: a day outside the window comes back as a row of zeros, not as nothing.
//
// Nothing here talks to Cloudflare. The token, wherever it lives, is never read by this suite.
//
// Run: node scripts/ops/cf-analytics.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, loadToken, windowDates, rowsFor, mergeHistory, readHistory, writeHistory, withHistoryLock, render, main } from './cf-analytics.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const threw = (fn) => { try { fn(); return null } catch (e) { return e.message } }

console.log('the question it asks')
{
  check('a day is the unit, and the window ends yesterday', windowDates(3, new Date('2026-11-16T10:00:00Z')).join() === '2026-11-12,2026-11-13,2026-11-14' === false && windowDates(3, new Date('2026-11-16T10:00:00Z')).join() === '2026-11-13,2026-11-14,2026-11-15', windowDates(3, new Date('2026-11-16T10:00:00Z')).join())
  // Today is still being counted: a half-counted day next to full ones reads as a collapse in traffic.
  check('...and never includes today, which is still being counted', !windowDates(7, new Date('2026-11-16T23:59:00Z')).includes('2026-11-16'))
  check('a typo in a flag stops the run rather than changing the window quietly', threw(() => parseArgs(['--day', '3'], {})) === 'unknown argument --day')
  check('...and so does a window that is not a window', /1 to 365/.test(threw(() => parseArgs(['--days', '0'], {})) || '') && /1 to 365/.test(threw(() => parseArgs(['--days', 'lots'], {})) || ''))
  check('the zone is a name, not a shell fragment', /domain name/.test(threw(() => parseArgs(['--zone', '; rm -rf /'], {})) || ''))
  check('the history file can come from the environment, and the flag wins over it', parseArgs([], { CF_HISTORY_FILE: '/a' }).history === '/a' && parseArgs(['--history', '/b'], { CF_HISTORY_FILE: '/a' }).history === '/b')
}

console.log('the token')
{
  check('no token at all is a refusal that says what to set', /CF_API_TOKEN/.test(threw(() => loadToken({})) || '') && /CF_TOKEN_FILE/.test(threw(() => loadToken({})) || ''))
  check('...and a file that cannot be read says which file, not what was in it', threw(() => loadToken({ CF_TOKEN_FILE: '/no/such' }, () => { throw new Error('ENOENT: secret-looking text') })) === 'CF_TOKEN_FILE names /no/such, which cannot be read')
  check('something far too short is not a token', /does not look like one/.test(threw(() => loadToken({ CF_TOKEN_FILE: '/f' }, () => 'abc')) || ''))
  const token = 'x'.repeat(40)
  check('the environment is enough on its own, and the file is read whole and trimmed', loadToken({ CF_API_TOKEN: token }) === token && loadToken({ CF_TOKEN_FILE: '/f' }, () => '\n' + token + '\n  ') === token)
}

console.log('a day with no row is said to be missing, not zero')
{
  const groups = [{ dimensions: { date: '2026-11-15' }, sum: { requests: 10, pageViews: 4, bytes: 1048576, cachedRequests: 5, threats: 1 }, uniq: { uniques: 3 } }]
  const rows = rowsFor(['2026-11-14', '2026-11-15'], groups)
  check('the day Cloudflare answered carries its numbers', rows[1].requests === 10 && rows[1].uniques === 3 && rows[1].missing === false)
  check('...and the day it did not is marked, not counted as a quiet day', rows[0].requests === 0 && rows[0].missing === true)
  const out = render('example.test', rows, [{ clientCountryName: 'US', requests: 9, threats: 1 }])
  check('the table says so too, and says why', /2026-11-14 \*/.test(out) && /limited window on this plan/.test(out))
  check('...and does not add visitors across days, because they do not add', /Visitors are counted per day/.test(out) && !/^total.*\b3\b/m.test(out))
  check('...and says out loud where these numbers may go', /local report directory, not in git/.test(out))
}

console.log('the file that outlives the window')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-history-'))
  const file = path.join(dir, 'history.json')
  const day = (d, n, missing = false) => ({ date: d, requests: n, pageViews: n, uniques: n, cached: 0, threats: 0, bytes: 0, missing })
  check('nothing to read yet is an empty history, not a failure', readHistory(file, 'example.test').length === 0)
  writeHistory(file, mergeHistory([], [day('2026-11-10', 100), day('2026-11-11', 200)]), 'example.test')
  check('what was written comes back', readHistory(file, 'example.test').map((d) => d.date).join() === '2026-11-10,2026-11-11')
  check('...with the zone and the time of writing, so a file says what it is', JSON.parse(fs.readFileSync(file, 'utf8')).zone === 'example.test' && /^\d{4}-\d\d-\d\dT/.test(JSON.parse(fs.readFileSync(file, 'utf8')).written_at))
  // The whole point. A day that has fallen out of Cloudflare's window comes back as a row of zeros marked missing;
  // if that were merged in, every run would quietly erase the history it was written to keep. The mark is what
  // rowsFor puts there when the day has no group at all, so that is where this starts.
  const outside = rowsFor(['2026-11-10', '2026-11-11'], [])
  check('a day Cloudflare no longer answers for is marked, which is what the merge looks at', outside.every((r) => r.missing === true && r.requests === 0))
  const next = mergeHistory(readHistory(file, 'example.test'), [...outside, day('2026-11-12', 300)])
  check('a day outside the window never overwrites the day we already have', next.find((d) => d.date === '2026-11-10').requests === 100 && next.find((d) => d.date === '2026-11-11').requests === 200)
  check('...and the new day is kept, in order, without the mark', next.map((d) => d.date).join() === '2026-11-10,2026-11-11,2026-11-12' && !('missing' in next[2]))
  // A day Cloudflare corrects (it finishes counting after midnight) is taken: the newer reading of a day IN the
  // window is the better one. It can only ever come back higher, so a lower one is a sign of something wrong.
  const corrected = mergeHistory(next, [day('2026-11-12', 333)])
  check('a day the window still holds is updated, because the later reading is the better one', corrected.find((d) => d.date === '2026-11-12').requests === 333 && corrected.length === 3)
  const smaller = mergeHistory(corrected, [day('2026-11-12', 12), day('2026-11-11', 0)])
  check('...but a reading SMALLER than the one we have is refused, mark or no mark', smaller.find((d) => d.date === '2026-11-12').requests === 333 && smaller.find((d) => d.date === '2026-11-11').requests === 200)
  // A day that really was quiet is still a day: zero requests with a row behind it is not the same as no row.
  const quiet = rowsFor(['2026-11-13'], [{ dimensions: { date: '2026-11-13' }, sum: { requests: 0, pageViews: 0, bytes: 0, cachedRequests: 0, threats: 0 }, uniq: { uniques: 0 } }])
  check('a day that was genuinely quiet is kept as a day, not treated as absent', quiet[0].missing === false && mergeHistory(corrected, quiet).length === 4)
  fs.writeFileSync(file, 'not json at all')
  check('a file that is not ours is never silently replaced', /does not parse/.test(threw(() => readHistory(file, 'example.test')) || ''))
  fs.writeFileSync(file, JSON.stringify({ zone: 'x' }))
  check('...nor one that parses but holds no days', /no days in it/.test(threw(() => readHistory(file, 'example.test')) || ''))
  fs.writeFileSync(file, JSON.stringify({ zone: 'other.test', days: [] }))
  check('...nor the history of another zone, which would mix two sites into one line', /history of other.test/.test(threw(() => readHistory(file, 'example.test')) || ''))
  // Unreadable is not empty: a run that cannot see the history must not write one day over years of them.
  const boom = Object.assign(new Error('EACCES'), { code: 'EACCES' })
  check('a history we cannot read stops the run instead of being replaced', /refusing to write over a history we cannot see/.test(threw(() => readHistory(file, 'example.test', () => { throw boom })) || ''))
  check('...while a file that is simply not there is still an empty history', readHistory(file, 'example.test', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }).length === 0)

  // Two runs at once: the second one says so and stops. Without this, both read the same history and the later
  // write silently drops the other's day.
  let inner = 0
  withHistoryLock(file, () => {
    inner++
    check('a second run does not race the first, it refuses', /another run holds/.test(threw(() => withHistoryLock(file, () => { inner++ })) || ''))
  })
  check('...and the lock is gone afterwards, so tomorrow is not blocked by today', inner === 1 && !fs.existsSync(file + '.lock'))
  check('...even when the run inside it throws', threw(() => withHistoryLock(file, () => { throw new Error('boom') })) === 'boom' && !fs.existsSync(file + '.lock'))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('the run itself')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-run-'))
  const file = path.join(dir, 'h.json')
  const env = { CF_API_TOKEN: 'y'.repeat(40) }
  const zone = { id: 'zone123' }
  const groups = [{ dimensions: { date: '2026-11-15' }, sum: { requests: 42, pageViews: 7, bytes: 2048, cachedRequests: 1, threats: 0 }, uniq: { uniques: 5 } }]
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init?.headers?.authorization || '', body: init?.body || '' })
    if (url.includes('/zones?')) return { ok: true, status: 200, json: async () => ({ success: true, result: [zone] }) }
    return { ok: true, status: 200, json: async () => ({ data: { viewer: { zones: [{ httpRequests1dGroups: groups }] } } }) }
  }
  const said = []
  const log = console.log
  console.log = (...a) => said.push(a.join(' '))
  const code = await main(['--days', '2', '--history', file, '--quiet'], { env, fetchImpl, now: new Date('2026-11-16T10:00:00Z') })
  console.log = log
  check('a run answers, writes its days and says how many it has', code === 0 && readHistory(file, 'proofofstock.xyz').length === 1, String(code))
  check('...and with --quiet says one line, the one about the history', said.length === 1 && /^history: 1 days in /.test(said[0]), said.join(' | ').slice(0, 80))
  // The token goes in a header and nowhere else: not in a URL, not in a body, not in anything printed, and not in
  // the file this leaves behind for years (Codex, 16.11).
  const secret = env.CF_API_TOKEN
  check('...and the token travelled as a bearer header, on every call and only there', calls.length === 2 && calls.every((c) => c.auth === `Bearer ${secret}`) && calls.every((c) => !c.url.includes(secret) && !String(c.body).includes(secret)), String(calls.length))
  check('...and is in nothing this run leaves behind', !said.join('\n').includes(secret) && !fs.readFileSync(file, 'utf8').includes(secret))
  const refused = await main(['--days', '2'], { env: {}, fetchImpl, now: new Date() })
  check('no token is asked wrongly (1), not a failure to retry', refused === 1)
  const down = async () => ({ ok: false, status: 503, json: async () => ({ errors: [{ message: 'upstream' }] }) })
  const err = console.error
  console.error = () => {}
  const temp = await main(['--days', '2'], { env, fetchImpl: down, now: new Date() })
  console.error = err
  check('Cloudflare being down is 75, the code a timer may retry', temp === 75, String(temp))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
