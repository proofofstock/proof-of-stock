// scripts/host-files.test.mjs: a release carries the files that live on the host and in no repository.
//
// The one this exists for is the paid-pass module. It is in neither repository on purpose, so it is not in the
// `git archive` a release is built from: on 15.11 it was installed by hand and by the next deploy it was gone from
// the running release, without a sound, because a host without it is a working free service. What is checked here is
// that a deploy carries it, that it is carried BEFORE the gate (so the tests run against what will run), and that
// the status of a host can say which host files the running release has and which it is missing.
//
// Run: node scripts/host-files.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'host-files.sh')
const run = (...args) => {
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-files-'))
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p }

console.log('a host with nothing installed')
{
  const base = path.join(tmp, 'bare'); const rel = path.join(base, 'releases', 'aaa')
  fs.mkdirSync(rel, { recursive: true })
  const copy = run('copy', base, rel)
  check('copying nothing is a success, not a failure: most hosts have no host files', copy.status === 0, copy.out)
  const status = run('check', base, rel)
  check('...and the status says so in words, rather than saying nothing', status.status === 0 && /none installed/.test(status.out), status.out.trim())
}

console.log('a host with the module installed')
{
  const base = path.join(tmp, 'live'); const rel = path.join(base, 'releases', 'bbb')
  fs.mkdirSync(rel, { recursive: true })
  write(path.join(base, 'host', 'evm', 'core', 'stocks', 'x402.mjs'), 'export const createX402 = () => ({})\n')
  write(path.join(base, 'host', 'evm', 'core', 'stocks', 'x402.test.mjs'), '// the module brings its own tests\n')
  const copy = run('copy', base, rel)
  const landed = path.join(rel, 'evm', 'core', 'stocks', 'x402.mjs')
  check('every host file lands at the path it must have inside the release', copy.status === 0 && fs.existsSync(landed) && fs.existsSync(path.join(rel, 'evm', 'core', 'stocks', 'x402.test.mjs')), copy.out)
  check('...with its contents, not an empty file or a link to one', fs.readFileSync(landed, 'utf8').includes('createX402'))
  check('...and the deploy log names each one, so a deploy that carried nothing is visible', (copy.out.match(/^host file: /gm) || []).length === 2, copy.out.trim())
  const status = run('check', base, rel)
  check('the status of that release says both are there', /x402\.mjs \(in the release\)/.test(status.out) && /x402\.test\.mjs \(in the release\)/.test(status.out), status.out.trim())
  // The whole point: a release built without the step.
  const fresh = path.join(base, 'releases', 'ccc'); fs.mkdirSync(fresh, { recursive: true })
  const missing = run('check', base, fresh)
  check('...and of a release that never got them, that they are MISSING, loudly', /x402\.mjs MISSING FROM THE RELEASE/.test(missing.out), missing.out.trim())
  // Carrying again over an existing file is how a redeploy of the same release behaves.
  write(landed, 'older\n')
  run('copy', base, rel)
  check('carrying again overwrites what is in the release: the host copy is the one that counts', fs.readFileSync(landed, 'utf8').includes('createX402'))
  check('and nothing is ever written back into the host directory', fs.readFileSync(path.join(base, 'host', 'evm', 'core', 'stocks', 'x402.mjs'), 'utf8').includes('createX402'))
}

console.log('what it refuses')
{
  const base = path.join(tmp, 'odd'); const rel = path.join(base, 'releases', 'ddd')
  fs.mkdirSync(rel, { recursive: true })
  write(path.join(base, 'host', 'a file.mjs'), 'x')
  const copy = run('copy', base, rel)
  // Refusing means saying so AND stopping with a status a deploy can see AND leaving nothing behind: a refusal that
  // still copies, or that exits 0, is worse than no check at all (Codex, 16.11).
  check('a host file whose name holds a space is refused, not guessed at', /REFUSED/.test(copy.out) && copy.status !== 0 && fs.readdirSync(rel).length === 0, `status ${copy.status}, left ${fs.readdirSync(rel).join()}`)
  const gone = run('copy', base, path.join(base, 'releases', 'no-such'))
  check('a release directory that is not there is refused', gone.status === 2 && /no release directory/.test(gone.out), gone.out.trim())
  const mode = run('wipe', base, rel)
  check('an unknown mode is refused: this script only ever copies one way', mode.status === 2 && /unknown mode/.test(mode.out), mode.out.trim())
  // A release whose inner directory points outside it would carry a host file out of the release altogether. The
  // release tree is ours, so this is not a likely attack; it is a cheap way to make "into the release" mean it.
  const esc = path.join(tmp, 'escape')
  const relE = path.join(esc, 'releases', 'eee'); const outside = path.join(esc, 'outside')
  fs.mkdirSync(relE, { recursive: true }); fs.mkdirSync(outside, { recursive: true })
  write(path.join(esc, 'host', 'evm', 'x402.mjs'), 'money\n')
  let linked = true
  try { fs.symlinkSync(outside, path.join(relE, 'evm'), 'junction') } catch (_) { linked = false }
  if (!linked) {
    check('a directory in the release that leaves it (no symlinks available here, skipped)', true)
  } else {
    const out = run('copy', esc, relE)
    check('a directory in the release that leaves it is refused, and nothing lands outside', out.status !== 0 && /outside the release/.test(out.out) && !fs.existsSync(path.join(outside, 'x402.mjs')), out.out.trim())
  }
}

console.log('the deploy actually calls it, and before the gate')
{
  const deploy = fs.readFileSync(path.join(HERE, 'deploy.sh'), 'utf8')
  const carry = deploy.indexOf('host-files.sh" copy')
  const npmci = deploy.indexOf('npm ci --omit=dev')
  const gate = deploy.indexOf('npm test')
  check('the build copies the host files in', carry > 0)
  check('...before the gate runs, so the tests see what will run', carry < npmci && carry < gate, `copy ${carry}, ci ${npmci}, gate ${gate}`)
  check('...and the status of a host reports them, with a word when it cannot', /host-files\.sh" check/.test(deploy) && /COULD NOT BE READ/.test(deploy))
  // A release already on disk is reused as it is, so the copy cannot live only in the branch that builds one: a host
  // file installed after that release was built would never reach it (Codex, 16.11).
  const copies = (deploy.match(/host-files\.sh" copy/g) || []).length
  const buildEnd = deploy.indexOf('mv "$REL.tmp" "$REL"')
  check('...and a release reused from disk is carried into as well, not only a fresh build', copies === 2 && deploy.lastIndexOf('host-files.sh" copy') > buildEnd, `${copies} copy calls`)
  // A release is built from this archive, so the script itself must be in it: it is called from the release tree.
  check('the script is in the repository, so every release has it', fs.existsSync(SCRIPT) && /host-files\.sh/.test(deploy))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
