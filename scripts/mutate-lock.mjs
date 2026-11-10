#!/usr/bin/env node
// scripts/mutate-lock.mjs — break the code on purpose and require the test to notice.
//
// Built because "break it and watch it go red" is the right practice and costs 30-60 minutes per lock by hand.
// Of about thirty such mutations once run by hand, THREE silently did not apply:
// the `find` string matched nothing, the file was rewritten unchanged, the suite passed, and a pass was
// very nearly recorded as proof that the guard works. A harness that does not check whether the breakage
// landed measures nothing while looking rigorous.
//
// WHAT A MUTATION HAS TO SURVIVE HERE, in order:
//
//   1. BASELINE. The lock runs unmutated and must be GREEN. A lock that is already red cannot be shown to
//      have caught anything, and every mutation under it would "pass" for the wrong reason.
//   2. THE EXPECTED STRING MUST BE ABSENT FROM THE GREEN OUTPUT. This repo's `check` helper prints the
//      assertion label on BOTH paths — `ok <label>` when it passes, `FAIL <label>` when it does not. So
//      `expect: "<label>"` would be found in the output of a perfectly healthy run, and the rule "red AND
//      output contains expect" would be satisfied by the half that means nothing. Requiring absence in the
//      baseline is what makes the string discriminating rather than decorative. Write expect as
//      `FAIL <label>`; see the manifests in tests/locks/.
//   3. THE MUTATION MUST APPLY. Zero occurrences of `find` is a harness error, never a pass. Ambiguity is
//      also refused: a `find` matching several sites mutates only the first under String.replace, which may
//      be a site nobody meant, and the redness could then come from somewhere unrelated. Declare
//      `occurrences` in the manifest to accept a multi-site find deliberately — all of them are mutated.
//   4. THE LOCK MUST GO RED, and its output must contain the expected string. Red for an unrelated reason
//      (a syntax error from a clumsy replacement, say) is reported separately from a real catch.
//   5. THE FILE MUST COME BACK BYTE-FOR-BYTE, verified by hash, whatever happened in between — including a
//      Ctrl-C. The Solana original restores in a `finally`, which a SIGINT walks straight past; this runs
//      in a live working tree, so a source file left mutated is a real hazard and the signal handlers below
//      exist for exactly that.
//
// Manifest — tests/locks/<name>.mutations.json:
//   { "target": "scripts/lib/jsonl-writer.mjs",
//     "runner": ["node", "scripts/lib/jsonl-writer.test.mjs"],
//     "mutations": [ { "name": "...", "find": "...", "replace": "...", "expect": "FAIL ...",
//                      "occurrences": 1 } ] }
//
// Run: node scripts/mutate-lock.mjs tests/locks/x.mutations.json [...]
//      node scripts/mutate-lock.mjs --all
//      node scripts/mutate-lock.mjs --marker-status        is this tree being mutated, or left mutated?
//      node scripts/mutate-lock.mjs --clear-compromised    the files are fixed; drop the record
//
// TWO LIMITS, NAMED RATHER THAN PATCHED OVER, both raised by the independent review of this port:
//
//   ONE AT A TIME, PER WORKING TREE. `inFlight` is per-process, so two concurrent runs against the same
//   checkout can have one read a file the other has already mutated, take that for the original, and
//   "restore" the mutation permanently. CI cannot hit this — its one self-hosted runner runs jobs one after
//   another, and each starts with a checkout that resets the tree — but a second terminal can. Do not run two
//   at once.
//
//   SIGKILL LEAVES THE FILE MUTATED. The handlers above cover SIGINT/SIGTERM/SIGHUP and the `finally`
//   covers a throw, but nothing survives kill -9 or a runner that dies. `git status` says so immediately;
//   the risk is noticing late rather than losing work.
//
// A RESTORE THAT COULD NOT LAND is retried, and then recorded on disk. Observed 2026-09-07: a run of
// tests/locks/pool-sump.mutations.json could not write evm/core/rpc/rpc-client.mjs back — `UNKNOWN: unknown
// error, open ...`, a transient Windows file lock. The harness said COULD NOT RESTORE and rethrew, which is
// correct and loud. But the marker was cleared on the way out, so `--marker-status` — the one command whose
// entire job is to answer "is this tree compromised?" — answered "no mutation run in progress" while a whole
// line was still missing from a production source file. It was found a day later by reading every manifest's
// `find` string against its target. A console line is not a record: it scrolls away, and the next reader may
// be another session or CI, neither of which saw the run. So the failure now survives the process in
// `.mutation-run-in-progress.compromised`, and `--marker-status` reports COMPROMISED until
// `--clear-compromised` is typed on purpose.
//
// A file with MIXED line endings is rewritten wholly in its dominant ending while mutated, so the lock runs
// against a file that differs from the original by more than the mutation. Restoration is unaffected — the
// original bytes are written back verbatim — and no file in this repo is mixed, .gitattributes sees to that.

import { isEntryPoint } from './lib/invoked-directly.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// Files currently holding a mutation, so a signal can put them back. A plain object keyed by path: the
// same target is mutated many times in a row and must not accumulate entries.
const inFlight = new Map()

// ─── the working tree is not itself while this runs ──────────────────────────────────────────────────
//
// A mutation run deliberately holds production source files broken, for seconds at a time, over and over.
// Anything that reads the tree meanwhile reads a lie — and that is not hypothetical: a `git diff` taken
// during a run captured `scripts/watch-tick.sh` mid-mutation, with its "no chains to poll" alarm replaced by
// `if false`, and that diff went to two independent code reviewers. Both opened on it as a production defect.
// The code was fine; the snapshot was not.
//
// Nothing can stop a concurrent reader, so the run says out loud that it is in progress. A marker file is
// enough: a human or a script about to snapshot the tree can look, and the answer is unambiguous.
//
// ⚠ OVERRIDABLE, AND NOT FOR CONVENIENCE. This harness's own lock spawns a nested run, so with a fixed path
// the inner run's cleanup deletes the OUTER run's marker and the outer tree goes back to looking trustworthy
// while it is still being broken — the marker lying in exactly the situation it exists to prevent. The
// nested run is given its own path instead, which also keeps the self-test from touching the repository at
// all. Found by running it: the self-test went red under the harness the first time this was wired up.
//
// ⚠ AND RESOLVED AT EVERY CALL, not once at import. A module-level const reads the environment exactly once, at
// whatever moment the first import happens, which makes the path depend on load order — a hidden ordering
// dependency that is invisible until something sets the variable a moment too late and silently gets the
// wrong file. Found by writing the test for it.
const markerPath = () => process.env.STP_MUTATION_MARKER || path.join(ROOT, '.mutation-run-in-progress')

// ⚠ THE MARKER IS OWNED BY RUNS, NOT BY THE FILE, and the first version got that wrong in two ways a reviewer
// found immediately:
//
//   Two ordinary runs at once. A writes the marker, B overwrites it, A finishes and deletes it — and B is
//   still holding sources broken behind a tree that now reads as trustworthy. The env override solved only
//   the nested case, which is not the same case.
//
//   A run that is killed. SIGKILL, a lost host, a pulled plug: no handler runs, the marker survives for ever,
//   and every later reader is told a run is in progress when none is. The previous comment here claimed the
//   marker was cleared "at any signal", which is simply false for uncatchable termination — an instrument
//   describing itself more confidently than it works.
//
// So the file is a LIST of live pids. A run adds its own and removes its own; a pid that no longer exists is
// pruned on sight, which makes a killed run heal itself rather than lie for ever. The file disappears when
// the last live run is gone.
const MARKER_HEADER = [
  '# A mutation run is holding source files under this tree deliberately broken.',
  '# Do NOT diff, commit, deploy or send this tree anywhere while any pid below is alive.',
  '# Dead pids are pruned automatically; run `node scripts/mutate-lock.mjs --marker-status` to check.',
].join('\n')

function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function markerRead () {
  try {
    return fs.readFileSync(markerPath(), 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => ({ pid: Number(l.split(/\s+/)[0]), line: l }))
      .filter(e => Number.isInteger(e.pid) && e.pid > 0)
  } catch (_) { return [] }
}

function markerWriteEntries (entries) {
  try {
    if (!entries.length) { fs.rmSync(markerPath(), { force: true }); return }
    fs.writeFileSync(markerPath(), MARKER_HEADER + '\n' + entries.map(e => e.line).join('\n') + '\n', 'utf8')
  } catch (e) {
    // NOT A REASON TO FAIL THE RUN — and not a reason to be quiet about it either. Swallowing this means the
    // run goes on breaking files with no marker and no word said, so the protection is absent exactly when
    // something is already wrong with the disk or the permissions. Raised by review.
    console.error(`  WARNING: could not update ${path.relative(ROOT, markerPath())} (${e.message}) — this tree is being mutated WITHOUT a marker`)
  }
}

// Live entries only. Exported so a caller about to snapshot the tree can ask the question that matters —
// "is a run happening" — rather than the question the filesystem answers, which is "does a file exist".
export function markerActive () {
  const live = markerRead().filter(e => pidAlive(e.pid))
  markerWriteEntries(live)
  return live
}

function markerWrite () {
  const mine = `${process.pid} started ${new Date().toISOString()}`
  markerWriteEntries([...markerRead().filter(e => e.pid !== process.pid && pidAlive(e.pid)), { pid: process.pid, line: mine }])
}

function markerClear () {
  markerWriteEntries(markerRead().filter(e => e.pid !== process.pid && pidAlive(e.pid)))
}

// ─── a restore that could not land ───────────────────────────────────────────────────────────────────
//
// AN ANNOUNCEMENT IS NOT A RECORD. The 2026-09-07 incident is described in the header: the run said the right
// thing at the right volume and then exited, and the state it was describing outlived the sentence describing
// it. What is needed is something on disk that nothing removes by accident.
//
// A SIBLING OF THE MARKER, not a line inside it. The marker file is a list of live pids and is DELETED the
// moment the last one goes — which is precisely the moment a crashed run stops holding it, i.e. precisely
// when this record has to survive. Deriving the path from markerPath() also means the nested run in this
// harness's own lock keeps its own record, for the same reason it keeps its own marker.
const compromisedPath = () => markerPath() + '.compromised'

const COMPROMISED_HEADER = [
  '# A mutation run could NOT put these files back. Deliberately broken source is still on disk.',
  '# Do NOT diff, commit, deploy or trust this tree until every file below is restored.',
  '# Nothing clears this file on its own: fix the files, then run',
  '#   node scripts/mutate-lock.mjs --clear-compromised',
].join('\n')

// Exported for the same reason markerActive() is: a caller about to snapshot the tree needs to ask whether
// the tree is trustworthy, and "a run is in progress" is only half of that question.
export function compromisedRead () {
  try {
    return fs.readFileSync(compromisedPath(), 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => { const [file, when, pid, ...rest] = l.split('\t'); return { file, when, pid, detail: rest.join('\t') } })
      .filter(e => e.file)
  } catch (e) {
    // ⚠ ENOENT IS THE ONLY FAILURE THAT MEANS "CLEAN". Any other — EACCES, EISDIR, a share that went away —
    // is the file DECLINING TO ANSWER, and returning [] for it would print "no unrestored file" on the
    // strength of a question that was never asked. That is precisely the defect this record exists to fix,
    // reproduced one level up in the instrument itself: a run of --marker-status against an unreadable record
    // exited 0 and said the tree was clean. Raised by the independent review of this change.
    if (e.code === 'ENOENT') return []
    throw new Error(`cannot read ${compromisedPath()} (${e.code || e.message}) — this tree CANNOT be shown to be clean`, { cause: e })
  }
}

// Once per file per process. restoreAll() can reach a target mutateOne() has already given up on, and two
// lines for one incident would read as two incidents.
const recorded = new Set()

function recordCompromised (abs, why, message) {
  if (recorded.has(abs)) return
  recorded.add(abs)
  const line = [abs, new Date().toISOString(), `pid ${process.pid}`, `${why}: ${message}`].join('\t')
  try {
    const p = compromisedPath()
    fs.appendFileSync(p, (fs.existsSync(p) ? '' : COMPROMISED_HEADER + '\n') + line + '\n', 'utf8')
  } catch (e) {
    // The last resort has no resort of its own. Whatever stopped the restore — a full disk, a revoked
    // permission — may well stop this too, and then the console is all there is. That is the state this block
    // exists to improve on, not one it can promise to prevent, so it is said plainly rather than implied.
    console.error(`  WARNING: could not record the failure in ${compromisedPath()} (${e.message}) — ${abs} IS STILL BROKEN and nothing but this line says so`)
  }
}

// ─── a write that fails is usually a write that is early ─────────────────────────────────────────────
//
// The 2026-09-07 failure was a transient Windows file lock: an antivirus scanner or the search indexer
// holding the file open for a few milliseconds after the lock process let go of it. Those clear on their own.
// A single immediate attempt turns a hiccup into a broken working tree; a short ladder does not, and costs
// nothing on the overwhelmingly common path where the first write succeeds. Failures that are NOT transient —
// EACCES, EISDIR — simply pay the full ladder before being reported, which is a fraction of a second.
// ⚠ A TYPO IN THE ENVIRONMENT MUST NOT DISARM THE LADDER, and the first version of this let it. `Number('abc')`
// is NaN, `Math.max(1, NaN)` is NaN, and `attempt <= NaN` is false on the very first pass — so the loop ran
// ZERO times, every restore came back failed, and the failure report then read `.message` off an error that
// had never been assigned. One mistyped variable converted every restore into a TypeError with no record
// written. Measured, not reasoned about: MUTATE_LOCK_RESTORE_ATTEMPTS=abc reproduced it exactly. Raised by
// the independent review of this change.
export const envNumber = (raw, fallback, { min }) => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}
const RESTORE_ATTEMPTS = envNumber(process.env.MUTATE_LOCK_RESTORE_ATTEMPTS, 5, { min: 1 })
const RESTORE_BACKOFF_MS = envNumber(process.env.MUTATE_LOCK_RESTORE_BACKOFF_MS, 50, { min: 0 })

// Atomics.wait, not a promise. This runs inside a `finally` and inside signal handlers, where the event loop
// is not coming back round — an `await` there would never resume and the file would stay broken for ever.
function sleepSync (ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Exported with its writer and its clock injectable, because a real transient file lock cannot be summoned on
// demand: a test that waited for the indexer to grab a file would be a test that sometimes waits for ever.
export function writeWithRetry (abs, content, opts = {}) {
  const write = opts.write || ((p, c) => fs.writeFileSync(p, c, 'utf8'))
  const sleep = opts.sleep || sleepSync
  // ⚠ THE SAME GUARD AS THE ENVIRONMENT GETS, and for a reason worth writing down. This was
  // `opts.attempts || RESTORE_ATTEMPTS`, which silently swallows NaN and 0 because both are falsy — and
  // passes -1 straight through, where `attempt <= -1` is false on the first pass and the loop runs ZERO
  // times. That left a failure with no error assigned, so the code below carried an `error || new Error(...)`
  // net for a case no test could reach: the review of this change pointed out that the net went green whether
  // it was there or not. A guard nothing can falsify is not a guard, so the hole is closed here instead and
  // the net is gone.
  const attempts = envNumber(opts.attempts, RESTORE_ATTEMPTS, { min: 1 })
  const backoffMs = envNumber(opts.backoffMs, RESTORE_BACKOFF_MS, { min: 0 })
  let error
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { write(abs, content); return { ok: true, attempts: attempt } } catch (e) { error = e }
    if (attempt < attempts) sleep(backoffMs * 2 ** (attempt - 1))
  }
  // `error` is always assigned: `attempts` is at least 1, so the loop body ran at least once and every path
  // through it either returned or caught. That is what makes it safe for callers to read `.message` — the one
  // path that must survive, because it is what writes the durable record.
  return { ok: false, attempts, error }
}

function restoreAll (why) {
  for (const [abs, original] of inFlight) {
    const w = writeWithRetry(abs, original)
    if (w.ok) {
      console.error(`  restored ${path.relative(ROOT, abs)} (${why})${w.attempts > 1 ? ` on attempt ${w.attempts}` : ''}`)
    } else {
      // Nothing further can be done to the file here — and the operator must not learn about it from a diff
      // next week, nor from this line, which is gone as soon as the terminal scrolls. The record is the half
      // that outlives the process.
      console.error(`  COULD NOT RESTORE ${abs} (${why}) after ${w.attempts} attempt(s): ${w.error.message}`)
      recordCompromised(abs, why, w.error.message)
    }
  }
  inFlight.clear()
  markerClear()
}

// 128 + signal number, the shell convention, rather than 130 for everything: a caller reading the exit code
// should be able to tell which signal arrived.
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
for (const sig of Object.keys(SIGNAL_EXIT)) {
  process.on(sig, () => { restoreAll(sig); process.exit(SIGNAL_EXIT[sig]) })
}
process.on('uncaughtException', (e) => { restoreAll('uncaught: ' + e.message); throw e })

// A mutation can turn a bounded loop into an unbounded one — the F-008 manifest contains one that puts a
// `continue` back where a `break` belongs — so an unbounded wait here would hang the harness with a source
// file still mutated on disk. A timeout is not a nicety; it is what lets the restore below always happen.
// Per-manifest, because locks honestly differ: a pure-function suite answers in milliseconds while
// scripts/watch-tick.test.mjs spawns bash against a live HTTP server and takes 162 seconds on Windows. One
// global number low enough to catch a hang would report the slow suite as an ALREADY-RED baseline — a false
// verdict of exactly the kind this harness exists to refuse. Declare `timeoutMs` in the manifest.
const RUN_TIMEOUT_MS = Number(process.env.MUTATE_LOCK_TIMEOUT_MS || 120_000)

function runCmd (cmdArr, cwd, timeoutMs = RUN_TIMEOUT_MS) {
  const r = spawnSync(cmdArr[0], cmdArr.slice(1), { cwd, encoding: 'utf8', shell: false, timeout: timeoutMs })
  if (r.error) {
    const timedOut = r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'
    return { status: timedOut ? 'timeout' : null, out: String(r.error.message) }
  }
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const hash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const norm = (s) => s.replace(/\r\n/g, '\n')

export const targetPath = (manifest) =>
  path.isAbsolute(manifest.target) ? manifest.target : path.join(ROOT, manifest.target)

// HOW MANY SITES A FIND MATCHES — the one definition of it. Exported because scripts/lock-anchors.mjs asks
// the same question statically, before the expensive sweep, and a second copy of this expression is a copy
// that can drift: a preflight that disagreed with the harness would wave through a manifest the sweep then
// reports as dead, which is worse than having no preflight at all. Line endings are normalised on BOTH
// sides for the reason spelled out in mutateOne below.
export const anchorSites = (source, find) => norm(source).split(norm(find)).length - 1

// ── manifest shape ──────────────────────────────────────────────────────────────────────────────────
//
// Checked up front and by name. A manifest missing `expect` would otherwise reach the comparison as
// `undefined`, and `out.includes(undefined)` is a type error at best and a silent false at worst.
export function validateManifest (manifest, label) {
  const errs = []
  const need = (cond, msg) => { if (!cond) errs.push(`${label}: ${msg}`) }
  // 🔴 A MANIFEST THAT IS NOT AN OBJECT USED TO END THE RUN RATHER THAN FAIL ONE CHECK. A file holding the
  // four characters `null` is valid JSON, so it survives the parse and arrives here — where reading
  // `.target` off it threw a raw TypeError out of the loop, and every manifest queued behind it went
  // unchecked and uncounted. That is the same defect this change fixes for a renamed target, one layer
  // earlier. ⚠ Raised in review of the rebase, and found by WRITING the file rather than reading the code.
  // Loud either way — but a verdict names the manifest, and a stack trace names the harness.
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    const what = manifest === null ? 'null' : Array.isArray(manifest) ? 'an array' : typeof manifest
    return [`${label}: manifest must be a JSON object (got ${what})`]
  }
  need(typeof manifest.target === 'string' && manifest.target, 'target must be a non-empty string')
  need(Array.isArray(manifest.runner) && manifest.runner.length > 0, 'runner must be a non-empty array')
  need(Array.isArray(manifest.mutations) && manifest.mutations.length > 0, 'mutations must be a non-empty array')
  if (manifest.timeoutMs !== undefined) {
    need(Number.isInteger(manifest.timeoutMs) && manifest.timeoutMs > 0, 'timeoutMs must be a positive integer')
  }
  checkPlatforms(manifest, null, need)
  if (Array.isArray(manifest.mutations)) {
    manifest.mutations.forEach((m, i) => {
      const at = `${label} mutation[${i}]`
      checkPlatforms(m, at, need)
      need(typeof m.name === 'string' && m.name, `${at}: name is required`)
      need(typeof m.find === 'string' && m.find, `${at}: find is required`)
      need(typeof m.replace === 'string', `${at}: replace is required (use "" to delete)`)
      need(typeof m.expect === 'string' && m.expect, `${at}: expect is required`)
      need(m.find !== m.replace, `${at}: find equals replace — this mutation changes nothing`)
      if (m.occurrences !== undefined) {
        need(Number.isInteger(m.occurrences) && m.occurrences > 0, `${at}: occurrences must be a positive integer`)
      }
    })
  }
  return errs
}

// ── where a lock can run ────────────────────────────────────────────────────────────────────────────
//
// 🔴 A LOCK WHOSE SUITE SKIPS ON THIS OS REPORTED EVERY MUTATION AS "ESCAPED". Measured on Windows 11,
// 2026-10-29: of 780 manifests, 20 had suites that print "SKIP win32: needs SIGUSR1 / flock / /proc / mode
// bits" and exit 0. A green baseline, then a green run with the code broken — 150 mutations reported as holes
// that are not holes, burying the few that were. And the opposite case read as worse than it was: a suite
// that exits 3 (REQUIRED-SKIPPED) was "the lock is ALREADY failing".
//
// So a manifest — or a single mutation, when only its own test is OS-bound — DECLARES the platforms it can
// run on, with the reason. Elsewhere it is not run and the report says so, by name. An undeclared skip still
// surfaces as escaped-green, which is how a Windows run finds the next one. On the platforms it names, a
// declaration changes nothing: CI runs Linux, so every declared lock still runs there.
export const PLATFORMS = Object.freeze(['linux', 'darwin', 'win32'])

function checkPlatforms (o, at, need) {
  if (!o || typeof o !== 'object' || o.platforms === undefined) return
  const pre = at ? `${at}: ` : ''
  need(Array.isArray(o.platforms) && o.platforms.length > 0 && o.platforms.every(p => PLATFORMS.includes(p)),
    `${pre}platforms must be a non-empty array of ${PLATFORMS.join(' / ')}`)
  need(typeof o.platforms_why === 'string' && o.platforms_why.trim().length >= 10,
    `${pre}platforms needs platforms_why — what the lock needs that other platforms lack`)
}

/** null when `o` can run on `platform`; otherwise the line that says why it was not run. */
export function notHere (o, platform = process.platform) {
  if (!o || !Array.isArray(o.platforms) || o.platforms.includes(platform)) return null
  return `declared for ${o.platforms.join(', ')} only (${o.platforms_why}) — not run on ${platform}`
}

// ── one mutation ────────────────────────────────────────────────────────────────────────────────────
export function mutateOne (manifest, m, opts = {}) {
  const run = opts.run || runCmd
  const abs = targetPath(manifest)

  // A TARGET THAT IS NOT THERE IS A VERDICT, NOT A CRASH. This read used to be unguarded, so a manifest
  // whose target had been renamed threw ENOENT out of the loop in main: one raw stack trace, and EVERY
  // manifest after it in the sweep never ran. The exit code was non-zero, so the gate did fail — but it
  // failed with no verdicts and no count of what had been skipped, which reads as "the harness is broken"
  // rather than "one manifest points at a file that moved". Named as its own kind so the report says which.
  let original
  try {
    original = fs.readFileSync(abs, 'utf8')
  } catch (e) {
    // ⚠ THE VERDICT SAYS WHAT WAS OBSERVED, NOT WHAT IS GUESSED. The first wording asserted "the manifest
    // points at a file that is not there" for every read failure — true for ENOENT, and a false lead for
    // EACCES, EISDIR or a share that went away, each of which would send the next reader hunting a rename
    // that never happened. The code is in the message either way; the sentence around it should not
    // contradict it. Raised in review, which reached this branch by making the target a directory.
    const why = e.code === 'ENOENT'
      ? 'the manifest points at a file that is not there'
      : 'the file exists but would not open'
    return { ok: false, kind: 'target-missing', detail: `target ${manifest.target} cannot be read (${e.code || e.message}) — ${why}, so nothing was tested` }
  }

  // LINE ENDINGS ARE NORMALISED BEFORE MATCHING, and this is not tidiness. .gitattributes stores this repo
  // as LF and checks it out as CRLF on Windows, so a multi-line `find` written here matches locally and
  // matches NOTHING on a Linux runner. The harness would then report `did-not-apply` for every multi-line
  // mutation in CI — red, but for a reason that has nothing to do with the guard under test. Manifests are
  // written with plain \n and work on both.
  const nl = original.includes('\r\n') ? '\r\n' : '\n'
  const denorm = (s) => (nl === '\r\n' ? s.replace(/\n/g, '\r\n') : s)
  const originalN = norm(original)
  const findN = norm(m.find)
  const replaceN = norm(m.replace)

  const found = anchorSites(original, m.find)
  if (found < 1) {
    return { ok: false, kind: 'did-not-apply', detail: `find matches nothing in ${manifest.target} — the breakage never landed, so a green lock would prove nothing` }
  }
  const wanted = m.occurrences === undefined ? 1 : m.occurrences
  if (found !== wanted) {
    return {
      ok: false,
      kind: 'ambiguous',
      detail: `find matches ${found} site(s) in ${manifest.target}, manifest expects ${wanted}` +
        (m.occurrences === undefined ? ' — narrow the find, or declare "occurrences" to mutate them all on purpose' : ''),
    }
  }

  // `() => replaceN`, NOT replaceN. A replacement STRING is interpreted by String.replace: `$&`, `$'`,
  // "$`" and `$1` are substitution patterns, so a manifest replacing code that contains any of them gets a
  // mutation that applied but is not the one it declared — and the verdict then describes somebody else's
  // breakage. A replacer function is taken literally. The split/join branch below never had the problem,
  // which meant the same replacement behaved differently depending on how many sites it matched.
  const mutatedN = found === 1 ? originalN.replace(findN, () => replaceN) : originalN.split(findN).join(replaceN)
  const mutated = denorm(mutatedN)
  if (mutated === original) {
    // Belt and braces: validateManifest already refuses find === replace, but a replacement that reproduces
    // the original by some other route would otherwise read as a caught mutation.
    return { ok: false, kind: 'did-not-apply', detail: 'the replacement reproduced the original file byte-for-byte' }
  }

  let result
  // The run's own failure is caught rather than allowed to fly, so that a restore failure in the `finally`
  // can carry it out instead of replacing it. Raised by the independent review: an investigation needs to
  // know what the run was doing when the restore failed as much as it needs to know that it failed.
  let pending = null
  try {
    inFlight.set(abs, original)
    fs.writeFileSync(abs, mutated, 'utf8')
    const timeoutMs = manifest.timeoutMs || RUN_TIMEOUT_MS
    const r = run(manifest.runner, ROOT, timeoutMs)
    if (r.status === 'timeout') {
      // Reported as its own kind. A hang is not a catch: the lock never returned a verdict, and calling it
      // one would credit the guard for a mutation that merely broke termination.
      result = { ok: false, kind: 'timeout', detail: `the lock did not finish within ${timeoutMs} ms — the mutation may have made a loop unbounded; no verdict was reached` }
    } else if (r.status === 0) {
      result = { ok: false, kind: 'escaped-green', detail: 'the lock stayed GREEN with the code broken — it does not guard this failure' }
    } else if (!r.out.includes(m.expect)) {
      result = { ok: false, kind: 'escaped-message', detail: `the lock went red, but "${m.expect}" is absent from its output — the redness may have another cause` }
    } else {
      result = { ok: true, kind: 'caught', detail: `caught (exit ${r.status}), output contains "${m.expect}"` }
    }
  } catch (e) {
    pending = e
  } finally {
    // The restore is retried before it is given up on, and giving up leaves a record that outlives this
    // process. The entry leaves `inFlight` either way: after the full ladder a further attempt from
    // restoreAll() adds nothing, and leaving it there would let a late success quietly contradict a record
    // that is meant to stand until somebody clears it by hand.
    const w = writeWithRetry(abs, original)
    inFlight.delete(abs)
    if (!w.ok) {
      console.error(`  COULD NOT RESTORE ${abs} after ${w.attempts} attempt(s): ${w.error.message}`)
      recordCompromised(abs, `restore after mutation "${m.name}"`, w.error.message)
      throw new Error(
        `${abs} could not be restored after ${w.attempts} attempt(s): ${w.error.message}` +
        (pending ? ` — and the run was ALREADY failing with: ${pending.message}` : ''),
        { cause: pending || w.error })
    }
  }
  // Restored fine, but the run itself had thrown: put that back on its way now that the file is safe.
  if (pending) throw pending

  if (hash(fs.readFileSync(abs, 'utf8')) !== hash(original)) {
    return { ok: false, kind: 'restore-failed', detail: `${manifest.target} did not come back byte-for-byte` }
  }
  return result
}

/**
 * The end of a failed run's output, on ONE line. A red baseline used to say only "exit 1", and in CI the job log
 * holds nothing else — the assertion that actually failed was thrown away (a CPU-throttled runner failed a
 * timing check and nobody could say which). One line, joined with ' ⏎ ', because the parallel runner reads the
 * report line by line and a multi-line detail would break its blocks. Capped, and shown only for a red baseline.
 */
export function outputTail (out, { lines = 12, chars = 1500 } = {}) {
  const all = String(out || '').replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '')
  if (!all.length) return '(no output)'
  const joined = all.slice(-lines).join(' ⏎ ')
  return joined.length > chars ? '…' + joined.slice(-chars) : joined
}

// ── the baseline ────────────────────────────────────────────────────────────────────────────────────
//
// Runs the lock untouched. Two things are established: the lock is green to begin with, and every `expect`
// string is ABSENT from a green run. Step 2 in the header is the whole reason this function exists.
export function baseline (manifest, opts = {}) {
  const run = opts.run || runCmd
  const timeoutMs = manifest.timeoutMs || RUN_TIMEOUT_MS
  const r = run(manifest.runner, ROOT, timeoutMs)
  // A TIMEOUT IS NOT A RED BASELINE, and saying so cost half an hour: the watch-tick suite takes 162 seconds
  // and was reported as "already failing before any mutation", which sends you looking for a broken lock
  // instead of at the clock. Different cause, different fix, so different words.
  if (r.status === 'timeout') {
    return { ok: false, kind: 'baseline-timeout', detail: `the lock did not finish within ${timeoutMs} ms — it may simply be slower than that; set "timeoutMs" in the manifest` }
  }
  // Exit 3 is REQUIRED-SKIPPED (scripts/lib/required-skip.mjs): the suite applies and this environment kept it
  // from running. Still not a pass — nothing was tested — but not "already failing" either, which sends the
  // reader to a broken lock. Declare the platforms in the manifest if this is the OS rather than the host.
  if (r.status === 3) {
    return { ok: false, kind: 'baseline-skipped', detail: `the lock could not run here (REQUIRED-SKIPPED), so nothing was tested — declare "platforms" if this OS can never run it. End of its output: ${outputTail(r.out)}` }
  }
  if (r.status !== 0) {
    return { ok: false, kind: 'baseline-red', detail: `the lock is ALREADY failing before any mutation (exit ${r.status}) — nothing below it can be trusted. End of its output: ${outputTail(r.out)}` }
  }
  const indiscriminate = manifest.mutations.filter(m => r.out.includes(m.expect))
  if (indiscriminate.length) {
    return {
      ok: false,
      kind: 'expect-not-discriminating',
      detail: 'these expect strings already appear in the GREEN output, so they cannot tell red from green: ' +
        indiscriminate.map(m => `"${m.expect}"`).join(', '),
    }
  }
  return { ok: true, kind: 'baseline-green', detail: `lock green, and all ${manifest.mutations.length} expect string(s) absent from a healthy run` }
}

export function runManifest (manifest, label, opts = {}) {
  const errs = validateManifest(manifest, label)
  if (errs.length) return { failures: errs.length, lines: errs.map(e => ({ ok: false, kind: 'bad-manifest', name: '-', detail: e })) }

  // 🔴 THE LOG'S TIMESTAMPS MEASURE PRINTING, NOT RUNNING, AND THAT COST AN INVESTIGATION. Every result is
  // buffered into `lines` and printed after the manifest finishes, so reading the CI log back gives each
  // mutation 0.0 s and attributes the whole elapsed time to the baseline. The question "four manifests are
  // 67% of an 18-minute job — WHY?" could not be answered from the only record there was: is it one slow
  // suite run paid twelve times, or one pathological mutation? Those want opposite repairs. So the harness
  // times itself, at the only place that knows: around the run, not around the print.
  const lines = []
  const platform = opts.platform || process.platform
  const away = notHere(manifest, platform)
  if (away) return { failures: 0, notHere: 1, lines: [{ ok: true, kind: 'not-applicable-here', name: 'platform', detail: away }] }
  const t0 = Date.now()
  const b = baseline(manifest, opts)
  lines.push({ ok: b.ok, kind: b.kind, name: 'baseline', detail: b.detail, ms: Date.now() - t0 })
  if (!b.ok) return { failures: 1, lines }

  let failures = 0
  for (const m of manifest.mutations) {
    const mAway = notHere(m, platform)
    if (mAway) { lines.push({ ok: true, kind: 'not-applicable-here', name: m.name, detail: mAway }); continue }
    const t = Date.now()
    const r = mutateOne(manifest, m, opts)
    if (!r.ok) failures++
    lines.push({ ok: r.ok, kind: r.kind, name: m.name, detail: r.detail, ms: Date.now() - t })
  }
  return { failures, lines }
}

function loadManifestPaths (args) {
  if (args.includes('--all')) {
    const dir = path.join(ROOT, 'tests', 'locks')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(f => f.endsWith('.mutations.json')).sort().map(f => path.join(dir, f))
  }
  return args.filter(a => !a.startsWith('-'))
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────────
if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2)

  // Ask whether a run is happening, not whether a file exists. Prunes dead pids as a side effect, so a run
  // killed outright stops claiming the tree the first time anyone looks.
  // The record is not cleared by a later run, by a successful run, or by time. It is cleared here, by
  // somebody who has looked at the files and put them back — which is the whole difference between a record
  // and the console line that used to be the only trace.
  if (args.includes('--clear-compromised')) {
    // The read is allowed to fail HERE AND ONLY HERE. This is the command that exists to clean up, and a
    // record that cannot be read is exactly the state an operator has to be able to clear — refusing to
    // delete it because it will not parse would leave them with no way out but a manual rm.
    let dropped = []
    let unreadable = null
    try { dropped = compromisedRead() } catch (e) { unreadable = e.message }
    const existed = fs.existsSync(compromisedPath())
    // ⚠ AN UNREADABLE RECORD IS MOVED ASIDE, NOT DELETED. The block above lets this command survive a record
    // it cannot parse, because it is the only way out of the exit-2 refusal — but the cause of that refusal is
    // the same class of transient fault that produced this whole change (a scanner, a share that went away),
    // and deleting on the first read failure would destroy the evidence to unblock the operator. Raised by the
    // independent review. A readable record IS deleted: the operator read it and fixed the files.
    let movedTo = null
    if (unreadable && existed) {
      movedTo = `${compromisedPath()}.rejected-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try { fs.renameSync(compromisedPath(), movedTo) } catch (e) { movedTo = null }
    }
    if (!movedTo) fs.rmSync(compromisedPath(), { force: true, recursive: true })
    // "nothing to clear" and "I removed something I could not read" are different answers, and the first one
    // said in place of the second is the same lie in miniature: a clean-sounding sentence about a question
    // that was never answered.
    console.log(unreadable
      ? movedTo
        ? `moved aside a record that could not be read (kept as ${path.basename(movedTo)}) — ${unreadable}`
        : `removed a record that could not be read — ${unreadable}`
      : dropped.length
        ? `cleared ${dropped.length} compromised record(s): ${[...new Set(dropped.map(e => e.file))].join(', ')}`
        : existed
          ? 'removed an empty record — no unrestored file was named in it'
          : 'nothing to clear — no unrestored file was recorded')
    process.exit(0)
  }

  if (args.includes('--marker-status')) {
    const live = markerActive()
    // The caller asked whether this tree can be trusted. "I could not find out" is a legitimate answer and a
    // non-zero one; thirty lines of Node internals is not, and the reassuring pid line must not be printed
    // ahead of it — which is why the read happens before anything is said.
    let wrecked
    try { wrecked = compromisedRead() } catch (e) {
      console.error(`CANNOT ANSWER — ${e.message}`)
      console.error('Fix or remove that file, then: node scripts/mutate-lock.mjs --clear-compromised')
      process.exit(2)
    }
    console.log(live.length
      ? `MUTATION RUN IN PROGRESS — ${live.length} live: ${live.map(e => e.pid).join(', ')}`
      : 'no mutation run in progress')
    // ⚠ THIS IS THE ANSWER THE COMMAND EXISTS TO GIVE. A run that ended is not the same as a tree that is
    // clean: on 2026-09-07 the run had ended, the pids were gone, and a production source file was still
    // missing a line. Reporting only the pids answered a narrower question than the one being asked.
    if (wrecked.length) {
      console.log(`TREE COMPROMISED — ${wrecked.length} file(s) a run could not put back:`)
      for (const e of wrecked) console.log(`  ${e.file}  (${e.when}, ${e.pid}) ${e.detail}`)
      console.log('Restore each one (git checkout -- <file>), then: node scripts/mutate-lock.mjs --clear-compromised')
    }
    // 2 outranks 1: a tree still holding broken source is worse news than a tree that is merely busy. A
    // caller that only tests for zero — CI does — reads both as "do not trust this tree", which is right.
    process.exit(wrecked.length ? 2 : live.length ? 1 : 0)
  }

  const paths = loadManifestPaths(args)
  if (!paths.length) {
    console.error('usage: node scripts/mutate-lock.mjs <manifest.mutations.json ...> | --all')
    if (args.includes('--all')) console.error('  (--all found no manifests in tests/locks/)')
    process.exit(2)
  }

  markerWrite()

  // Said once, at the top, rather than refused: the operator may well be re-running the very lock they are
  // repairing. But every verdict below is measured against a tree that already holds breakage nobody
  // declared, and that has to be visible before the verdicts are, not only in --marker-status afterwards.
  let wreckedAtStart
  try { wreckedAtStart = compromisedRead() } catch (e) {
    // Refused rather than announced, and this is the one place the difference matters: a run that cannot tell
    // whether the tree already holds breakage is about to add more of its own, and every verdict it prints
    // would be measured against a state nobody can describe.
    console.error(`\nREFUSING TO RUN — ${e.message}`)
    console.error('Fix or remove that file, then: node scripts/mutate-lock.mjs --clear-compromised')
    markerClear()
    process.exit(2)
  }
  if (wreckedAtStart.length) {
    console.error(`\nTREE COMPROMISED before this run started — ${wreckedAtStart.length} file(s) an earlier run could not put back:`)
    for (const e of wreckedAtStart) console.error(`    ${e.file}`)
    console.error('  Every verdict below is measured against that tree. See --marker-status.')
  }

  let failures = 0
  const notRunHere = []
  for (const mp of paths) {
    const label = path.basename(mp)
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(mp, 'utf8'))
    } catch (e) {
      console.log(`\n> ${label}\n  FAIL [manifest] unreadable: ${e.message}`)
      failures++
      continue
    }
    // ⚠ AND THE SAME GUARD HERE, BECAUSE THE CRASH WAS HERE TOO. `null` parses cleanly, so the catch above
    // never fires, and this line read `.runner` off it and threw out of the loop — every manifest queued
    // behind it unrun and uncounted. Guarding `validateManifest` was not enough: the header is printed
    // before validation, and that was the actual crash site. Found by reproducing rather than by trusting
    // where the report said it was.
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      const what = manifest === null ? 'null' : Array.isArray(manifest) ? 'an array' : typeof manifest
      console.log(`\n> ${label}\n  FAIL [manifest] not a manifest object (parsed as ${what})`)
      failures++
      continue
    }
    console.log(`\n> ${label} -> lock: ${(manifest.runner || []).join(' ')}`)
    const res = runManifest(manifest, label)
    failures += res.failures
    for (const l of res.lines) if (l.kind === 'not-applicable-here') notRunHere.push(`${label} [${l.name}]`)
    // ⚠ AND THE TIME IS PRINTED, OR RECORDING IT WAS POINTLESS. Review caught the first version measuring
    // `ms` into a field nothing rendered: the log would have gone on showing nothing, the "four manifests
    // are 67% — why?" question would have gone on being unanswerable, and the change would have looked done.
    // An instrument that takes a reading it does not report has not been built, it has been sketched.
    for (const l of res.lines) {
      const t = Number.isFinite(l.ms) ? `${(l.ms / 1000).toFixed(1)}s `.padStart(7) : ''
      console.log(`  ${t}${l.ok ? 'ok  ' : 'FAIL'} [${l.name}] ${l.kind}: ${l.detail}`)
    }
  }

  markerClear()

  // Named, not just counted: a declaration that has gone stale is found by reading which locks it kept out.
  if (notRunHere.length) {
    console.log(`
${notRunHere.length} lock(s) or mutation(s) declared for other platforms — NOT run on ${process.platform}, run in CI:`)
    for (const n of notRunHere) console.log(`    ${n}`)
  }
  console.log(failures === 0
    ? `\nALL CAUGHT — every lock went red on every mutation`
    : `\n${failures} mutation(s) NOT caught`)
  process.exit(failures === 0 ? 0 : 1)
}
