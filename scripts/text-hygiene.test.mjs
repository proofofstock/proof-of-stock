// scripts/text-hygiene.test.mjs: no Cyrillic letter and no em or en dash anywhere in the tracked tree (owner, 12.11):
// code, comments, docs, tests and file names. The two internal docs the public export replaces with stubs are left out.
// To name a look-alike letter in an example, write its code point (U+0410).
//
// Run: node scripts/text-hygiene.test.mjs
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

// Outside a git checkout (the export test runs this tree as a plain folder) there is nothing tracked to read.
let files = null
try { files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean) } catch (_) {}
if (!files) { console.log('  ok   not a git checkout: nothing to check'); console.log('\n1 passed, 0 failed'); process.exit(0) }

const STUBBED = new Set(['docs/stocks-truth-layer-tz.md', 'docs/stocks-passport-agent.md'])
const BINARY = /\.(png|ico|jpg|jpeg|gif|webp|woff2?|gz|zip)$/i
const BAD = /[\u0400-\u04FF\u2013\u2014]/ // Cyrillic, en dash, em dash: written as code points so this file passes itself
const hits = []
for (const f of files) {
  if (STUBBED.has(f)) continue
  if (BAD.test(f)) { hits.push(`${f} (file name)`); continue }
  if (BINARY.test(f)) continue
  let text
  try { text = fs.readFileSync(f, 'utf8') } catch (_) { continue }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) if (BAD.test(lines[i])) { hits.push(`${f}:${i + 1}`); if (hits.length > 40) break }
}
check(`no Cyrillic and no em or en dash in ${files.length} tracked files`, hits.length === 0, hits.slice(0, 20).join(', '))
// Nothing of a run may be committed. On 11.11 a local preview was started with the analytics directory set to a
// Windows path whose backslashes were eaten as escapes, so the counter wrote its hits into a directory of that mangled
// name in the repository root, and "git add -A" swept it into the public export (removed 13.11). A top-level entry is
// deliberate and rare, so the list of them is written out here: anything else is a stray.
const TOP_LEVEL = new Set(['.gitattributes', '.github', '.gitignore', 'apps', 'CHANGELOG.md', 'deployment', 'docs', 'evm', 'LICENSE', 'package.json', 'package-lock.json', 'packages', 'README.md', 'schemas', 'scripts', 'SECURITY.md', 'server.json', 'tests'])
const stray = [...new Set(files.map((f) => f.split('/')[0]))].filter((t) => !TOP_LEVEL.has(t))
check('no stray entry in the repository root', stray.length === 0, stray.join(', '))
// A run's own output, wherever it lands: the counter's hit files and the recorder's readings and run rows.
const RUN_OUTPUT = /(^|\/)(hits|stock-peg|stock-peg-runs)-\d{4}-\d{2}-\d{2}\.jsonl$/
const output = files.filter((f) => RUN_OUTPUT.test(f))
check('no file a run wrote is tracked', output.length === 0, output.join(', '))
check('the rule itself catches what it should', BAD.test(String.fromCharCode(0x410)) && BAD.test('a ' + String.fromCharCode(0x2014) + ' b') && BAD.test('1' + String.fromCharCode(0x2013) + '2') && !BAD.test('plain - ascii: text'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
