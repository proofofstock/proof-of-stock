// scripts/ops/pos-backup.test.mjs: the backup of /var/lib/pos goes to Backblaze B2 (S3 API) and nowhere else,
// refuses an incomplete configuration without echoing it, never initialises a repository, prunes once a day, and always
// leaves a status file the health check can read, which never holds a secret. restic itself is replaced by a recorder.
//
// Run: node scripts/ops/pos-backup.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { destination, runBackup, runRestic, readStatus, KEEP, PRUNE_EVERY_MS } from './pos-backup.mjs'
import { backupChecks } from '../stocks/health-check.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-backup-'))
const SECRET = 'S3CRET-' + 'x'.repeat(8), PASS = 'PASS-' + 'y'.repeat(8)
const B2 = { RESTIC_REPOSITORY: 's3:s3.eu-central-003.backblazeb2.com/pos-backup-bucket/pos', RESTIC_PASSWORD: PASS, AWS_ACCESS_KEY_ID: '003abc', AWS_SECRET_ACCESS_KEY: SECRET }
const all = () => true

console.log('where it goes: Backblaze B2 only')
{
  check('B2 over its S3 API, with its key from the env', destination(B2).kind === 'b2' && destination(B2).args.length === 0)
  check('...the https form of the endpoint too', destination({ ...B2, RESTIC_REPOSITORY: 's3:https://s3.us-west-004.backblazeb2.com/pos-backup-k3x9/pos' }).kind === 'b2')
  check('...refused without the key, and the refusal echoes no value', /AWS_ACCESS_KEY_ID \(keyID\) and AWS_SECRET_ACCESS_KEY/.test(destination({ ...B2, AWS_SECRET_ACCESS_KEY: '' }).error) && !JSON.stringify(destination({ ...B2, AWS_SECRET_ACCESS_KEY: '' })).includes('003abc'))
  const bad = (repo) => destination({ ...B2, RESTIC_REPOSITORY: repo }).error
  check('any other store is refused: SFTP, a local path (same disk), another S3, the native b2: backend', ['sftp:u@h:/srv/pos', '/var/backups/pos', 's3:s3.amazonaws.com/pos-backup-bucket/pos', 'b2:pos-backup-bucket:pos'].every((r) => /must read s3:s3.<region>.backblazeb2.com/.test(bad(r))))
  check('...and so is a B2 address with no bucket, a short one, or shell characters', ['s3:s3.eu-central-003.backblazeb2.com', 's3:s3.eu-central-003.backblazeb2.com/abc/pos', 's3:s3.eu-central-003.backblazeb2.com/pos-bucket;id/pos', 's3:s3.evil.com/x.backblazeb2.com/pos-backup-bucket'].every(bad))
  check('no repository or no password is refused', /RESTIC_REPOSITORY is not set/.test(destination({}).error) && /RESTIC_PASSWORD is not set/.test(destination({ ...B2, RESTIC_PASSWORD: '' }).error) && destination({ ...B2, RESTIC_PASSWORD: '', RESTIC_PASSWORD_FILE: '/etc/pos/pw' }).kind === 'b2')
}

console.log('a run')
{
  const statusFile = path.join(tmp, 'status.json')
  const env = { ...B2, POS_BACKUP_STATUS: statusFile, POS_BACKUP_SOURCE: '/var/lib/pos' }
  let t = Date.parse('2026-11-12T00:47:00Z')
  const calls = []
  let codes = {}
  const run = (args) => { calls.push(args); return codes[args[0]] ?? 0 }
  const go = () => runBackup({ env, run, now: () => t, exists: all })
  check('the first run backs up, prunes and checks', go() === 0 && calls.map((a) => a[0]).join() === 'backup,forget,check')
  const b = calls[0]
  check('...the backup is the source alone, tagged, without temporary files', b.at(-1) === '/var/lib/pos' && b.includes('--one-file-system') && b.join(' ').includes('--host pos --tag pos') && b.join(' ').includes('--exclude *.tmp-*'))
  check('...the prune keeps 2 days of every run, then 14 daily, 8 weekly, 12 monthly', calls[1].join(' ').endsWith('--prune ' + KEEP.join(' ')) && KEEP.join(' ') === '--keep-within 2d --keep-daily 14 --keep-weekly 8 --keep-monthly 12')
  check('...it never runs restic init', !calls.some((a) => a[0] === 'init'))
  let s = readStatus(statusFile)
  check('...and the status says when it succeeded and pruned', s.last_success_at === '2026-11-12T00:47:00.000Z' && s.last_prune_at === s.last_success_at && s.last_error === null && s.destination === 'b2')
  const raw = fs.readFileSync(statusFile, 'utf8')
  check('the status file holds no secret and no repository address', !raw.includes(SECRET) && !raw.includes(PASS) && !raw.includes('backblazeb2') && !raw.includes('bucket'))
  calls.length = 0; t += 6 * 3600e3
  check('six hours later: a backup, no prune', go() === 0 && calls.map((a) => a[0]).join() === 'backup')
  calls.length = 0; t += PRUNE_EVERY_MS
  check('a day later: the prune again', go() === 0 && calls.map((a) => a[0]).join() === 'backup,forget,check')
  const okAt = readStatus(statusFile).last_success_at
  calls.length = 0; t += 6 * 3600e3; codes = { backup: 10 }
  check('a repository that does not exist fails the run and says to init it, keeping the last success', go() === 1 && /restic backup exited 10 \(the repository does not exist: run restic init once/.test(readStatus(statusFile).last_error) && readStatus(statusFile).last_success_at === okAt)
  codes = { backup: 3 }
  check('an incomplete snapshot (exit 3) is a failure, not a success', go() === 1 && readStatus(statusFile).last_success_at === okAt && /incomplete/.test(readStatus(statusFile).last_error))
  t += PRUNE_EVERY_MS; codes = { forget: 1 }
  check('a failed prune fails the run (an alert) but the backup itself counts', go() === 1 && readStatus(statusFile).last_success_at === new Date(t).toISOString() && /forget --prune exited 1/.test(readStatus(statusFile).last_error))
  codes = {}; calls.length = 0
  check('...and the prune is tried again on the next run', go() === 0 && calls.map((a) => a[0]).join() === 'backup,forget,check')
  calls.length = 0
  const refused = runBackup({ env: { POS_BACKUP_STATUS: statusFile, AWS_SECRET_ACCESS_KEY: SECRET }, run, now: () => t, exists: all })
  s = readStatus(statusFile)
  check('an incomplete configuration runs no restic, exits 2 and says why in the status', refused === 2 && calls.length === 0 && /^refused: RESTIC_REPOSITORY is not set/.test(s.last_error) && !fs.readFileSync(statusFile, 'utf8').includes(SECRET))
  check('...and the health check reads that status: fresh success, no alert', backupChecks({ status: s, now: t })[0].bad === false)
  check('a missing source is refused, not backed up as empty', runBackup({ env, run, now: () => t, exists: (f) => f !== '/var/lib/pos' }) === 2 && /source \/var\/lib\/pos does not exist/.test(readStatus(statusFile).last_error))
}

console.log('by hand: --restic')
{
  const calls = [], logs = []
  const run = (args) => { calls.push(args); return 0 }
  check('the owner\'s init goes to the configured B2 bucket, as restic init and nothing more', runRestic(['init'], { env: B2, run }) === 0 && calls[0].join(' ') === 'init')
  check('...and any other command the same way', runRestic(['snapshots', '--tag', 'pos'], { env: B2, run }) === 0 && calls[1].join(' ') === 'snapshots --tag pos')
  check('an incomplete configuration runs nothing', runRestic(['init'], { env: {}, run, log: (m) => logs.push(m) }) === 2 && calls.length === 2 && /refused: RESTIC_REPOSITORY/.test(logs[0]))
  check('no command is refused', runRestic([], { env: B2, run, log: (m) => logs.push(m) }) === 2 && calls.length === 2)
}

console.log('the unit')
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const unit = fs.readFileSync(path.join(ROOT, 'deployment', 'systemd', 'pos-backup.service'), 'utf8')
  const timer = fs.readFileSync(path.join(ROOT, 'deployment', 'systemd', 'pos-backup.timer'), 'utf8')
  check('the credentials come only from /etc/pos/backup.env, and the unit is skipped until it exists', /^EnvironmentFile=\/etc\/pos\/backup\.env$/m.test(unit) && /^ConditionPathExists=\/etc\/pos\/backup\.env$/m.test(unit) && !/^Environment=(RESTIC_PASSWORD|RESTIC_REPOSITORY|AWS_)/m.test(unit))
  check('it runs as its own user, not root and not the site\'s, with no capability', /^User=pos-backup$/m.test(unit) && /^CapabilityBoundingSet=$/m.test(unit))
  check('it reads /var/lib/pos and writes only its status and cache', /^Environment=POS_BACKUP_SOURCE=\/var\/lib\/pos$/m.test(unit) && /^Environment=POS_BACKUP_STATUS=\/var\/lib\/pos-backup\/status\.json$/m.test(unit) && /^StateDirectory=pos-backup$/m.test(unit) && /^CacheDirectory=pos-backup$/m.test(unit) && /^ProtectSystem=strict$/m.test(unit) && !/^ReadWritePaths=/m.test(unit))
  check('a failure reaches the owner', /^OnFailure=stp-alert@%n\.service$/m.test(unit))
  check('the timer fires every 6 hours', /^OnCalendar=\*-\*-\* 00\/6:47:00$/m.test(timer) && /^Unit=pos-backup\.service$/m.test(timer) && /^Persistent=true$/m.test(timer))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
