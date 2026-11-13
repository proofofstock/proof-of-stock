// scripts/ops/pos-backup.mjs: back up POS's own data, /var/lib/pos, with restic, and write a status file the health
// check reads (scripts/stocks/health-check.mjs backupChecks: an alert when the last success is over 24 h old).
// Run by deployment/systemd/pos-backup.service every 6 hours; the setup is deployment/BACKUP.md.
//
// Configuration comes ONLY from the environment, which the unit reads from /etc/pos/backup.env (root, 0600, written by
// the owner on the host; never in git, never through a chat). The destination is Backblaze B2, through its S3 API
// (owner, 12.11), in a bucket of POS's own:
//   RESTIC_REPOSITORY      s3:s3.<region>.backblazeb2.com/<bucket>/pos
//   RESTIC_PASSWORD        the repository's encryption password (or RESTIC_PASSWORD_FILE)
//   AWS_ACCESS_KEY_ID      the B2 application key's keyID
//   AWS_SECRET_ACCESS_KEY  the B2 application key itself
// Set by the unit, not secret: POS_BACKUP_SOURCE (/var/lib/pos), POS_BACKUP_STATUS (/var/lib/pos-backup/status.json),
// RESTIC_CACHE_DIR.
//
// Each run: `restic backup` of the source; then, once a day, `restic forget --prune` with KEEP and a `restic check`.
// ⚠ NOTHING SECRET IS WRITTEN OR LOGGED HERE. restic's own output goes to the journal; the status file holds times, the
//   kind of destination and the step that failed with its exit code, never the repository address or a key.
// ⚠ IT NEVER INITIALISES A REPOSITORY ON ITS OWN. A repository that does not exist is an error the owner fixes once by
//   hand, `node scripts/ops/pos-backup.mjs --restic init` (deployment/BACKUP.md): a typo in the address must not quietly
//   start a second, empty repository. `--restic <command>` runs any one restic command against the configured
//   destination (snapshots, restore), for the owner; the timer never passes it.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isEntryPoint } from '../lib/invoked-directly.mjs'

// Every 6 hours for two days, then one a day for two weeks, one a week for two months, one a month for a year.
export const KEEP = Object.freeze(['--keep-within', '2d', '--keep-daily', '14', '--keep-weekly', '8', '--keep-monthly', '12'])
// The prune and check run once a day, at the first backup 20 hours after the last one (the timer fires every 6 h).
export const PRUNE_EVERY_MS = 20 * 3600e3
export const DEFAULTS = Object.freeze({
  source: '/var/lib/pos',
  status: '/var/lib/pos-backup/status.json',
})
// restic's documented exit codes, said in words in the status file and the alert.
const EXIT = Object.freeze({
  1: 'failed',
  3: 'could not read some files (the snapshot is incomplete)',
  10: 'the repository does not exist: run restic init once (deployment/BACKUP.md)',
  11: 'the repository is locked by another run',
  12: 'wrong repository password',
})
const said = (step, code) => `restic ${step} exited ${code}${EXIT[code] ? ` (${EXIT[code]})` : ''}`

/**
 * Where the backup goes, from the environment: { kind, args } (extra restic options), or { error } saying what is
 * missing or wrong. Never echoes a value from the environment. Backblaze B2 only: a typo in the address, or any other
 * store, is refused rather than written to.
 */
export const B2_REPOSITORY = /^s3:(https:\/\/)?s3\.[a-z0-9-]+\.backblazeb2\.com\/[A-Za-z0-9-]{6,63}(\/[A-Za-z0-9._-]+)*\/?$/
export function destination (env) {
  const repo = env.RESTIC_REPOSITORY || ''
  if (!repo) return { error: 'RESTIC_REPOSITORY is not set (/etc/pos/backup.env)' }
  if (!env.RESTIC_PASSWORD && !env.RESTIC_PASSWORD_FILE) return { error: 'RESTIC_PASSWORD is not set (/etc/pos/backup.env)' }
  if (!B2_REPOSITORY.test(repo)) return { error: 'RESTIC_REPOSITORY must read s3:s3.<region>.backblazeb2.com/<bucket>/pos (Backblaze B2 over its S3 API)' }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return { error: 'the B2 key is missing: AWS_ACCESS_KEY_ID (keyID) and AWS_SECRET_ACCESS_KEY (applicationKey) in /etc/pos/backup.env' }
  return { kind: 'b2', args: [] }
}

export function readStatus (file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null } }
export function writeStatus (file, status) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', { mode: 0o644 })
  fs.renameSync(tmp, file)
}

/**
 * One backup run. `run(args)` runs restic and returns its exit code. Returns the process exit code: 0 done, 1 a restic
 * step failed, 2 refused (the configuration is incomplete). The status is written in every case.
 */
export function runBackup ({ env = process.env, run, now = () => Date.now(), exists = fs.existsSync, read = readStatus, write = writeStatus } = {}) {
  const statusFile = env.POS_BACKUP_STATUS || DEFAULTS.status
  const source = env.POS_BACKUP_SOURCE || DEFAULTS.source
  const iso = () => new Date(now()).toISOString()
  const prev = read(statusFile) || {}
  const status = {
    last_success_at: prev.last_success_at || null,
    last_attempt_at: iso(),
    last_prune_at: prev.last_prune_at || null,
    last_error: null,
    destination: prev.destination || null,
  }
  const done = (code, error = null) => { status.last_error = error; write(statusFile, status); return code }
  const dest = destination(env)
  if (dest.error) return done(2, 'refused: ' + dest.error)
  status.destination = dest.kind
  if (!exists(source)) return done(2, `refused: the source ${source} does not exist`)
  const b = run(['backup', ...dest.args, '--one-file-system', '--host', 'pos', '--tag', 'pos', '--exclude', '*.tmp-*', '--exclude', '*.tmp', source])
  if (b !== 0) return done(1, said('backup', b))
  status.last_success_at = iso()
  const lastPrune = Date.parse(status.last_prune_at)
  if (!Number.isFinite(lastPrune) || now() - lastPrune >= PRUNE_EVERY_MS) {
    const f = run(['forget', ...dest.args, '--host', 'pos', '--tag', 'pos', '--prune', ...KEEP])
    if (f !== 0) return done(1, said('forget --prune', f))
    const c = run(['check', ...dest.args])
    if (c !== 0) return done(1, said('check', c))
    status.last_prune_at = iso()
  }
  return done(0)
}

/**
 * `--restic <command> [args]`: one restic command against the configured destination, for the owner by hand
 * (deployment/BACKUP.md: init, snapshots, restore). The status file is not touched. Returns the exit code.
 */
export function runRestic (args, { env = process.env, run, log = (m) => console.error(m) } = {}) {
  if (!args.length) { log('[pos-backup] --restic needs a restic command, e.g. --restic snapshots'); return 2 }
  const dest = destination(env)
  if (dest.error) { log('[pos-backup] refused: ' + dest.error); return 2 }
  return run([...dest.args, ...args])
}

if (isEntryPoint(import.meta.url)) {
  const bin = process.env.POS_RESTIC_BIN || 'restic'
  const manual = process.argv[2] === '--restic'
  const run = (args) => {
    const r = spawnSync(bin, args, { stdio: [manual ? 'inherit' : 'ignore', 'inherit', 'inherit'], env: process.env })
    if (r.error) { console.error(`[pos-backup] ${bin} could not be started: ${r.error.code || r.error.message}`); return 127 }
    return r.status ?? 1
  }
  if (manual) {
    process.exitCode = runRestic(process.argv.slice(3), { run })
  } else if (process.argv.length > 2) {
    console.error('usage: node scripts/ops/pos-backup.mjs [--restic <restic command> [args]]'); process.exitCode = 2
  } else {
    const code = runBackup({ run })
    const s = readStatus(process.env.POS_BACKUP_STATUS || DEFAULTS.status) || {}
    console.log('[pos-backup] ' + JSON.stringify({ code, last_success_at: s.last_success_at, last_prune_at: s.last_prune_at, error: s.last_error }))
    process.exitCode = code
  }
}
