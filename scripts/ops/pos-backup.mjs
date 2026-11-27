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
// Set by the unit, not secret: POS_BACKUP_SOURCE (the paths to copy, see sources() below), POS_BACKUP_STATUS
// (/var/lib/pos-backup/status.json), RESTIC_CACHE_DIR.
//
// Each run: `restic backup` of the sources; then, once a day, `restic forget --prune` with KEEP and a `restic check`.
// ⚠ NOTHING SECRET IS WRITTEN OR LOGGED HERE. restic's own output goes to the journal; the status file holds times, the
//   kind of destination, the step that failed with its exit code and any source path that was not there, never the
//   repository address or a key.
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
  // The data root first, then the pieces beside it that no other copy holds. /var/lib/stp-anchors carries the daily
  // manifests and their OpenTimestamps proofs (scripts/stocks/anchor.mjs): the manifest can be rebuilt from the data,
  // but a proof cannot. A new proof made later would attest today, not the day it covers, so losing that directory
  // loses the only evidence of WHEN the archive existed in this form (data audit, 13.11).
  // Beside them since 27.11: stp-web's published agent tests and its ledger of paid passes (deployment/BACKUP.md).
  sources: '/var/lib/pos:/var/lib/stp-anchors:/var/lib/stp-agent-test:/var/lib/stp-x402',
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

/**
 * The paths to copy, from POS_BACKUP_SOURCE: absolute paths separated by `:`, PATH-style, so the unit needs no
 * quoting. Returns { paths } with the first one the data root, or { error } saying what is wrong with the setting.
 * A relative path is refused rather than dropped: restic would resolve it against the working directory and copy
 * something nobody asked for, and a typo must not pass quietly.
 */
export function sources (env) {
  const given = String(env.POS_BACKUP_SOURCE || DEFAULTS.sources).split(':').map((s) => s.trim()).filter(Boolean)
  if (!given.length) return { error: 'POS_BACKUP_SOURCE names no path' }
  const relative = given.find((s) => !s.startsWith('/'))
  if (relative) return { error: `POS_BACKUP_SOURCE must hold absolute paths separated by ":", not ${JSON.stringify(relative)}` }
  return { paths: [...new Set(given)] }
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
  const iso = () => new Date(now()).toISOString()
  const prev = read(statusFile) || {}
  const status = {
    last_success_at: prev.last_success_at || null,
    last_attempt_at: iso(),
    last_prune_at: prev.last_prune_at || null,
    last_error: null,
    destination: prev.destination || null,
    // Carried, like the times above: a run that is refused before it looks at the paths learns nothing about them, and
    // must not clear the backup:sources alert by reporting an empty list.
    missing_sources: Array.isArray(prev.missing_sources) ? prev.missing_sources : [],
  }
  const done = (code, error = null) => { status.last_error = error; write(statusFile, status); return code }
  const dest = destination(env)
  if (dest.error) return done(2, 'refused: ' + dest.error)
  status.destination = dest.kind
  const src = sources(env)
  if (src.error) return done(2, 'refused: ' + src.error)
  const [root] = src.paths
  // The data root is the run: without it there is nothing worth copying, and an empty snapshot in its place would be
  // worse than none. A path beside it that is not there (a fresh host whose first anchor run has not happened yet) does
  // not hold the copy back; it is named in the status instead, and stp-health turns that into an alert of its own.
  const present = src.paths.filter((p) => exists(p))
  if (!present.includes(root)) return done(2, `refused: the source ${root} does not exist`)
  const missing = src.paths.filter((p) => !present.includes(p))
  const b = run(['backup', ...dest.args, '--one-file-system', '--host', 'pos', '--tag', 'pos', '--exclude', '*.tmp-*', '--exclude', '*.tmp', ...present])
  if (b !== 0) return done(1, said('backup', b))
  status.last_success_at = iso()
  // Only now, beside the success it belongs to: missing_sources says what the newest SNAPSHOT is short of, not what
  // the filesystem looked like when a run started. A run that found the path again and then failed to write anything
  // must not report the gap as closed, or stp-health would send the all-clear while no snapshot holds the path yet.
  status.missing_sources = missing
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
    console.log('[pos-backup] ' + JSON.stringify({ code, last_success_at: s.last_success_at, last_prune_at: s.last_prune_at, missing_sources: s.missing_sources, error: s.last_error }))
    process.exitCode = code
  }
}
