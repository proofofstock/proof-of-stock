// scripts/ops/migrate-pos-data.test.mjs: the copy of each chain's stock-peg/ (history/ included) to /var/lib/pos is
// exact (files, modes, links, SHA-256), owned by the service user, idempotent, never overwrites a target that differs,
// never touches the source, and its --verify mode changes nothing. Run in temp directories as the current user.
//
// Run: node scripts/ops/migrate-pos-data.test.mjs   (Linux only: GNU find, sha256sum, getent; the host and CI are Linux)
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
if (process.platform !== 'linux') {
  console.log('  skip not Linux: the script runs on the host, and CI runs this suite')
  console.log('\n0 passed, 0 failed')
  process.exit(0)
}

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrate-pos-data.sh')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-migrate-'))
const OLD = path.join(tmp, 'stp'), NEW = path.join(tmp, 'pos')
const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim()
const env = { ...process.env, POS_OLD_ROOT: OLD, POS_NEW_ROOT: NEW, POS_OWNER: `${os.userInfo().username}:${group}`, POS_MIGRATE_SKIP_UNIT_CHECK: '1' }
const run = (args = [], extra = {}) => { const r = spawnSync('sh', [SCRIPT, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr } }
const put = (f, text, mode = 0o644) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); fs.chmodSync(f, mode) }
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((p) => { const s = fs.lstatSync(path.join(dir, p)); return `${p} ${(s.mode & 0o7777).toString(8)} ${s.isFile() ? fs.readFileSync(path.join(dir, p), 'utf8') : ''}` }).join('\n')

for (const c of ['base', 'robinhood']) {
  put(path.join(OLD, c, 'stock-peg', 'stock-peg-2026-11-12.jsonl'), `{"chain":"${c}"}\n`)
  put(path.join(OLD, c, 'stock-peg', 'history', 'cases-2026-11-10.jsonl'), `{"case":"${c}"}\n`)
  put(path.join(OLD, c, 'stock-peg', 'history', 'registry-2026-11-10.jsonl'), '{"r":1}\n', 0o600)
  put(path.join(OLD, c, 'static', 'token-static-2026-11-12.jsonl'), '{}\n')
}
const oldBefore = tree(OLD)

console.log('the copy')
{
  const r = run()
  check('it copies both chains and says so', r.code === 0 && /OK: every chain/.test(r.out) && /copied and verified: 3 files, 1 directories/.test(r.out), r.out)
  check('the history is copied, with the modes kept', tree(path.join(NEW, 'base', 'stock-peg')) === tree(path.join(OLD, 'base', 'stock-peg')) && /registry-2026-11-10\.jsonl 600/.test(tree(path.join(NEW, 'robinhood', 'stock-peg'))))
  check('only stock-peg/ is copied, never the other project\'s streams', !fs.existsSync(path.join(NEW, 'base', 'static')))
  check('the source is not changed', tree(OLD) === oldBefore)
  check('no partial copy is left behind', !fs.readdirSync(path.join(NEW, 'base')).some((n) => n.includes('partial')))
  const again = run()
  check('a second run finds exact copies and changes nothing', again.code === 0 && (again.out.match(/already an exact copy/g) || []).length === 2)
  check('--verify passes on an exact copy', run(['--verify']).code === 0)
}

console.log('it never overwrites')
{
  const f = path.join(NEW, 'base', 'stock-peg', 'history', 'cases-2026-11-10.jsonl')
  fs.appendFileSync(f, '{"case":"new"}\n')
  const r = run()
  check('a target that differs is refused (exit 3) and left as it is', r.code === 3 && /is not empty and differs/.test(r.out) && fs.readFileSync(f, 'utf8').includes('"new"'))
  const v = run(['--verify'])
  check('--verify reports the mismatch and fails', v.code === 1 && /MISMATCH/.test(v.out))
  fs.writeFileSync(f, '{"case":"base"}\n')
  const s = path.join(OLD, 'base', 'stock-peg', 'stock-peg-2026-11-12.jsonl')
  fs.appendFileSync(s, '{"later":1}\n')
  check('...also when the source moved on after the copy (a unit ran): look before deciding', run().code === 3)
}

console.log('the edges')
{
  fs.rmSync(NEW, { recursive: true, force: true })
  fs.mkdirSync(path.join(NEW, 'base', 'stock-peg'), { recursive: true })
  const r = run()
  check('an empty target (made by systemd) is filled', r.code === 0 && fs.existsSync(path.join(NEW, 'base', 'stock-peg', 'history', 'cases-2026-11-10.jsonl')))
  fs.rmSync(NEW, { recursive: true, force: true })
  check('--verify on a missing target fails and creates nothing', run(['--verify']).code === 1 && !fs.existsSync(NEW))
  check('a missing service user is refused before anything is copied', run([], { POS_OWNER: 'no-such-user-pos:no-such-user-pos' }).code === 2 && !fs.existsSync(NEW))
  check('a missing source is refused', run([], { POS_CHAINS: 'nochain' }).code === 2 && !fs.existsSync(path.join(NEW, 'nochain')))
  check('an unknown option is refused', run(['--force']).code === 2)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
