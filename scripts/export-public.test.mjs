// scripts/export-public.test.mjs: the dry run of the public export (`export-public.sh --check`) passes on this tree and
// refuses a planted hit: a deny-listed string in a file, in a file name, an internal-looking doc with no stub, a workflow
// on a self-hosted runner. The deny list is read from the exported commit, not the working tree. On a hit the output
// names files and never the matched text.
//
// Everything happens in a temp clone of this repository; the real deny list is never read or printed here. The planted
// marker is a synthetic pattern added to the clone's deny list, built at runtime so this file itself never matches it.
//
// Run: node scripts/export-public.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// The export works on a git checkout. A release on the host is a `git archive` with no .git (scripts/deploy.sh runs the
// tests there as its gate): nothing to export from, so this suite says so and passes. CI and a developer's checkout run it.
if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.log('  skip not a git checkout (a release built from git archive): the export is checked in CI')
  console.log('\n0 passed, 0 failed')
  process.exit(0)
}
// The public copy has no deny list (the export removes it): nothing to check against there, so this suite says so and
// passes. The private repository, where the export runs, has it.
if (!fs.existsSync(path.join(ROOT, 'scripts/public-deny.txt'))) {
  console.log('  skip no scripts/public-deny.txt (the public copy): the export is checked in the private repository')
  console.log('\n0 passed, 0 failed')
  process.exit(0)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'export-check-'))
const repo = path.join(tmp, 'repo')
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, env: ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}
let n = 0
const dryRun = (...rest) => {
  const dest = path.join(tmp, 'out' + n++)
  const r = spawnSync('bash', ['scripts/export-public.sh', '--check', dest, ...rest], { cwd: repo, env: ENV, encoding: 'utf8' })
  return { dest, status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text) }
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD') }

const MARKER = ['zq', 'planted', 'marker', '7f3a'].join('-')
const DENY = 'scripts/public-deny.txt'

try {
  // A temp clone of the committed tree, with this working tree's export script (so the script under test is this one).
  const c = spawnSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', ROOT, repo], { env: ENV, encoding: 'utf8' })
  if (c.status !== 0) throw new Error('clone: ' + c.stderr)
  fs.copyFileSync(path.join(ROOT, 'scripts/export-public.sh'), path.join(repo, 'scripts/export-public.sh'))
  const realDeny = fs.readFileSync(path.join(repo, DENY), 'utf8')
  write(DENY, realDeny.replace(/\n?$/, '\n') + MARKER + '\n')
  const base = commit('test: base with a synthetic deny pattern')

  console.log('the tree as it is')
  {
    const r = dryRun()
    check('the dry run passes', r.status === 0, r.out.slice(-400))
    check('it stops before git init', !fs.existsSync(path.join(r.dest, '.git')))
    check('the deny list is not exported', !fs.existsSync(path.join(r.dest, DENY)))
    const ci = fs.readFileSync(path.join(r.dest, '.github/workflows/ci.yml'), 'utf8')
    // A tag can be moved to other code; a commit cannot. Both CIs name every action by its commit.
    const usesOf = (y) => [...y.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])
    const priv = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8')
    check('every action in both CIs is pinned to a commit', [...usesOf(ci), ...usesOf(priv)].length >= 3 && [...usesOf(ci), ...usesOf(priv)].every((u) => /@[0-9a-f]{40}$/.test(u)), JSON.stringify([...usesOf(ci), ...usesOf(priv)]))
    check('the public CI runs on hosted runners', /runs-on: ubuntu-latest/.test(ci) && !/self-hosted/i.test(ci))
    for (const f of ['docs/stocks-truth-layer-tz.md', 'docs/stocks-passport-agent.md']) {
      const p = path.join(r.dest, f)
      check(f + ' is the stub', !fs.existsSync(p) || /^# Internal\n\nThis page is internal design notes/.test(fs.readFileSync(p, 'utf8')))
    }
    check('a public tutorial whose name ends in -agent is not taken for an internal doc', fs.existsSync(path.join(r.dest, 'docs/tutorials/connect-an-agent.md')))
  }

  console.log('a deny-listed string in a file')
  {
    write('apps/planted.txt', 'before ' + MARKER + ' after\n')
    commit('plant in contents')
    // The working tree's deny list loses the pattern; the commit's list still has it, and that is the one that counts.
    write(DENY, realDeny)
    const r = dryRun()
    check('refuses', r.status === 1, r.out.slice(-400))
    check('names the file', r.out.includes('apps/planted.txt'))
    check('never prints the matched text', !r.out.includes(MARKER))
    check('stops before git init', !fs.existsSync(path.join(r.dest, '.git')))
    check('an older commit given as <rev> is checked instead, and passes', dryRun(base).status === 0)
    git('reset', '-q', '--hard', base)
  }

  console.log('a deny-listed string in a file name')
  {
    write('docs/' + MARKER + '.md', 'nothing to see\n')
    commit('plant in a name')
    const r = dryRun()
    check('refuses', r.status === 1, r.out.slice(-400))
    check('prints the path with the name redacted', r.out.includes('docs/<redacted>'))
    check('never prints the matched text', !r.out.includes(MARKER))
    git('reset', '-q', '--hard', base)
  }

  console.log('a new internal-looking doc without a stub')
  {
    write('docs/pricing-tz.md', '# design notes\n')
    write('docs/HANDOFF-x.md', '# hand-over\n')
    commit('new internal docs')
    const r = dryRun()
    check('refuses', r.status === 1, r.out.slice(-400))
    check('names both docs', r.out.includes('docs/pricing-tz.md') && r.out.includes('docs/HANDOFF-x.md'))
    git('reset', '-q', '--hard', base)
  }

  console.log('a workflow on a self-hosted runner')
  {
    write('.github/workflows/extra.yml', 'jobs:\n  x:\n    runs-on: [self-hosted]\n')
    commit('extra workflow')
    const r = dryRun()
    check('refuses', r.status === 1, r.out.slice(-400))
    check('says why', /self-hosted runner/.test(r.out))
    git('reset', '-q', '--hard', base)
  }

  console.log('nothing to check against')
  {
    write(DENY, '# only a comment\n')
    commit('empty deny list')
    const r = dryRun()
    check('an empty deny list is a refusal, not a pass', r.status === 1, r.out.slice(-400))
    git('reset', '-q', '--hard', base)
  }

  console.log('a non-empty destination')
  {
    const dest = path.join(tmp, 'busy'); fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'x'), 'x')
    const r = spawnSync('bash', ['scripts/export-public.sh', '--check', dest], { cwd: repo, env: ENV, encoding: 'utf8' })
    check('is refused', r.status === 2)
  }
} catch (e) {
  failed++; failures.push('  FAIL ' + e.message); console.log('  FAIL ' + e.message)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
