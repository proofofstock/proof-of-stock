// scripts/stocks/health-standalone.test.mjs: the health checks that keep POS standing on its own (deployment/CUTOVER.md).
// The token streams another project writes are an alert per chain once their newest day file is older than 8 hours, and
// clear when fresh; an unreadable or empty stream is an alert too. The backup of /var/lib/pos is an alert when its last
// success is older than a day or was never recorded, and only where the unit names its status file.
//
// Run: node scripts/stocks/health-standalone.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tokenStreamChecks, newestTokenStatic, backupChecks, readBackupStatus, standaloneChecks, TOKEN_STREAM_MAX_AGE_S, BACKUP_MAX_AGE_S } from './health-check.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-health-standalone-'))
const NOW = Date.parse('2026-11-12T18:00:00Z')
const H = 3600e3
const bad = (checks) => checks.filter((c) => c.bad).map((c) => c.key).sort()

console.log('the token streams that feed the look-alike list')
{
  check('the threshold is 8 hours, past the longest ordinary quiet stretch measured (5.1 h)', TOKEN_STREAM_MAX_AGE_S === 8 * 3600)
  const fresh = tokenStreamChecks({ newest: { base: { mtimeMs: NOW - 2 * H }, robinhood: { mtimeMs: NOW - 5 * H } }, now: NOW })
  check('fresh streams on both chains raise nothing', bad(fresh).length === 0 && fresh.length === 2)
  const old = tokenStreamChecks({ newest: { base: { mtimeMs: NOW - 2 * H }, robinhood: { mtimeMs: NOW - 9.5 * H } }, now: NOW })
  const rh = old.find((c) => c.key === 'token-streams:robinhood')
  check('a stream older than 8 h is an alert for that chain only', bad(old).join() === 'token-streams:robinhood')
  check('...that says how long and what it means', rh.text === 'Robinhood Chain: the token streams that feed the look-alike list have not been updated for 9 h; the list may be stale.', rh.text)
  const back = tokenStreamChecks({ newest: { robinhood: { mtimeMs: NOW - 60e3 } }, now: NOW })
  check('...and clears once the stream is fresh again', back.length === 1 && !back[0].bad && back[0].key === 'token-streams:robinhood' && /updated again/.test(back[0].text))
  check('exactly 8 h is not yet an alert', bad(tokenStreamChecks({ newest: { base: { mtimeMs: NOW - 8 * H } }, now: NOW })).length === 0)
  check('the threshold can be set', bad(tokenStreamChecks({ newest: { base: { mtimeMs: NOW - 3 * H } }, now: NOW, maxAgeS: 2 * 3600 })).join() === 'token-streams:base')
  const gone = tokenStreamChecks({ newest: { base: { error: 'EACCES' }, robinhood: null }, now: NOW })
  check('an unreadable dataset or one with no day file is an alert, not a silence', bad(gone).join() === 'token-streams:base,token-streams:robinhood' && /cannot be read \(EACCES\)/.test(gone[0].text) && /no day file/.test(gone[1].text))
  check('a chain not looked at says nothing', tokenStreamChecks({ newest: {}, now: NOW }).length === 0)
}

console.log('the newest day file of a token dataset')
{
  const ds = path.join(tmp, 'ds'), st = path.join(ds, 'static')
  fs.mkdirSync(st, { recursive: true })
  const put = (name, ageH) => { const f = path.join(st, name); fs.writeFileSync(f, '{}\n'); const t = new Date(NOW - ageH * H); fs.utimesSync(f, t, t) }
  put('token-static-2026-11-12.jsonl', 10)
  // The collector compresses a day three days later: its new mtime must not make the stream look fresh.
  put('token-static-2026-11-09.jsonl.gz', 0.1)
  put('notes.txt', 0)
  put('token-static-2026-11-13.jsonl.tmp', 0)
  const n = newestTokenStatic(ds)
  check('it is the newest day by name, not the newest mtime', n.day === '2026-11-12' && n.file === 'token-static-2026-11-12.jsonl', JSON.stringify(n))
  check('...so a recompressed old day does not hide a stalled stream', bad(tokenStreamChecks({ newest: { base: n }, now: NOW })).join() === 'token-streams:base')
  put('token-static-2026-11-13.jsonl.gz', 1)
  check('a compressed newest day counts', newestTokenStatic(ds).day === '2026-11-13')
  // A day file deleted between the listing and its stat (the collector replacing a .jsonl by its .gz) is skipped. A
  // dangling link lists like a file and stats like a deleted one; where links cannot be made, this check is skipped.
  let linked = true
  try { fs.symlinkSync(path.join(st, 'gone'), path.join(st, 'token-static-2026-11-14.jsonl')) } catch (_) { linked = false }
  if (linked) check('a day file that vanished since the listing is skipped, not an unreadable stream', newestTokenStatic(ds).day === '2026-11-13')
  else console.log('  skip no symlinks here: the vanished-file case is checked on Linux')
  // The stream stopped on the 11th and that day was compressed just now: its age counts from the end of the 11th.
  const ds2 = path.join(tmp, 'ds2'); fs.mkdirSync(path.join(ds2, 'static'), { recursive: true })
  const late = path.join(ds2, 'static', 'token-static-2026-11-11.jsonl.gz'); fs.writeFileSync(late, '{}\n'); fs.utimesSync(late, new Date(NOW - 0.1 * H), new Date(NOW - 0.1 * H))
  const n2 = newestTokenStatic(ds2)
  check('a stopped stream whose last day was compressed just now still alerts (age from the end of that day)', n2.mtimeMs === Date.parse('2026-11-12T00:00:00Z') && bad(tokenStreamChecks({ newest: { base: n2 }, now: NOW })).join() === 'token-streams:base', JSON.stringify(n2))
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(path.join(empty, 'static'), { recursive: true })
  check('no day file is null', newestTokenStatic(empty) === null)
  let code = null
  try { newestTokenStatic(path.join(tmp, 'missing')) } catch (e) { code = e.code }
  check('a missing dataset throws, so it is reported, not taken for an empty one', code === 'ENOENT')
}

console.log('the backup of /var/lib/pos')
{
  check('the threshold is a day: four missed runs of the 6-hour timer', BACKUP_MAX_AGE_S === 24 * 3600)
  const ok = backupChecks({ status: { last_success_at: new Date(NOW - 6 * H).toISOString(), last_attempt_at: new Date(NOW - 6 * H).toISOString(), last_error: null }, now: NOW })
  check('a backup that succeeded 6 h ago raises nothing', ok.length === 1 && !ok[0].bad && ok[0].key === 'backup:pos')
  const old = backupChecks({ status: { last_success_at: new Date(NOW - 30 * H).toISOString(), last_error: 'restic backup exited 1' }, now: NOW })
  check('a last success older than 24 h is an alert that says how old and what failed', old[0].bad && /was 30 h ago/.test(old[0].text) && /restic backup exited 1/.test(old[0].text), old[0].text)
  const never = backupChecks({ status: null, now: NOW })
  check('no status file is an alert: no copy off the host yet', never[0].bad && /no successful backup/.test(never[0].text))
  check('a status file with only failures is the same alert, with the failure', /last attempt: refused: RESTIC_REPOSITORY/.test(backupChecks({ status: { last_success_at: null, last_error: 'refused: RESTIC_REPOSITORY' }, now: NOW })[0].text))
  const f = path.join(tmp, 'status.json')
  fs.writeFileSync(f, JSON.stringify({ last_success_at: '2026-11-12T12:00:00Z' }))
  check('the status file is read', readBackupStatus(f).last_success_at === '2026-11-12T12:00:00Z' && readBackupStatus(path.join(tmp, 'none.json')) === null)
  fs.writeFileSync(f, '{"torn')
  check('a torn status file reads as none', readBackupStatus(f) === null)
}

console.log('the checks as the unit runs them')
{
  const ds = path.join(tmp, 'live'), st = path.join(ds, 'static')
  fs.mkdirSync(st, { recursive: true })
  fs.writeFileSync(path.join(st, 'token-static-2026-11-12.jsonl'), '{}\n')
  const t = new Date(NOW - H); fs.utimesSync(path.join(st, 'token-static-2026-11-12.jsonl'), t, t)
  const env = { POS_TOKEN_DATASET_BASE: ds, POS_TOKEN_DATASET_ROBINHOOD: path.join(tmp, 'absent') }
  const before = standaloneChecks(NOW, { env })
  check('before the cutover (no POS_BACKUP_STATUS) there is no backup check', !before.some((c) => c.key === 'backup:pos'))
  check('the token datasets come from the env: a fresh one passes, a missing one is an alert', bad(before).join() === 'token-streams:robinhood' && /ENOENT/.test(before.find((c) => c.key === 'token-streams:robinhood').text))
  const after = standaloneChecks(NOW, { env: { ...env, POS_BACKUP_STATUS: path.join(tmp, 'no-status.json') } })
  check('after it, a missing status file is an alert', bad(after).includes('backup:pos'))
  check('STP_TOKEN_STREAM_MAX_AGE_H lowers the threshold', bad(standaloneChecks(NOW, { env: { ...env, STP_TOKEN_STREAM_MAX_AGE_H: '0.5' } })).includes('token-streams:base'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
