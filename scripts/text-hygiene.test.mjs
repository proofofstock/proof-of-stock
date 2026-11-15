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
// A claim or a token that proves something is ours belongs on the host, never here: this repository is exported to a
// public one, and a published ownership claim is a claim anyone can read. The owner asked for this on 13.11 after a
// Glama claim was committed by mistake. Matched by value, so a rename or a new directory does not get around it.
const OWNERSHIP_CLAIM = /glama_claim_[A-Za-z0-9_-]{16,}|_glama-claim\./
const claims = files.filter((f) => !BINARY.test(f) && !/text-hygiene\.test\.mjs$/.test(f)).filter((f) => { try { return OWNERSHIP_CLAIM.test(fs.readFileSync(f, 'utf8')) } catch (_) { return false } })
check('no ownership claim of ours is committed; those live on the host', claims.length === 0, claims.join(', '))
// Numbers in prose, and how they are kept true. Two rules, because there are two kinds of number.
//
// A number that MOVES (how many tokens are listed, how many the factory made, how many questions the exam asked)
// is never written into a file: it rots the week after, and nobody rereads a paragraph. It is either rendered from
// the live service or not stated. The version is the same kind: it lives in package.json and the pages read it
// from there, so a version written into prose is always the wrong one sooner or later. On 13.11 the docs still
// announced 0.5.0 in seven files, in the rendered page, the raw markdown and llms-full.txt, while the site ran 0.5.1.
// Three more announced it inside a code span, which is why the line below allows for one: that form slipped through
// the first pass and left the three reference pages, the most read of them, a release behind for another day.
//
// A number that is a DECISION (50 addresses a call, a 24 hour window, 7 days of cases) belongs in the documents,
// because a reader needs it. It is kept true by being checked against the constant it describes, here, below.
const docFiles = files.filter((f) => (f.startsWith('docs/') || f === 'README.md') && f.endsWith('.md') && f !== 'CHANGELOG.md')
const versioned = docFiles.filter((f) => /^`?v\d+\.\d+\.\d+[ `]/m.test(fs.readFileSync(f, 'utf8')))
check('no page writes a version into its own text; the pages read it from package.json', versioned.length === 0, versioned.join(', '))
{
  const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch (_) { return '' } }
  const constant = (f, name) => { const m = read(f).match(new RegExp(`${name} = (\\d+)`)); return m ? Number(m[1]) : null }
  const facts = [
    ['the batch limit', constant('apps/stocks-mcp-http.mjs', 'MAX_VERIFY_BATCH'), [['docs/reference/tools.md', /up to (\d+) addresses/], ['docs/reference/tools.md', /more than (\d+) addresses/], ['docs/reference/http-api.md', /1 to (\d+) addresses/]]],
    ['the public reading window', constant('evm/core/stocks/passport.mjs', 'PUBLIC_WINDOW_H'), [['docs/reference/tools.md', /`hours` \| number \| no \| 1 to (\d+)/]]],
    ['the case window', constant('apps/stocks-history.mjs', 'BULK_WINDOW_DAYS'), [['docs/reference/tools.md', /first seen in the last (\d+) days/]]],
  ]
  const wrong = []
  for (const [what, value, places] of facts) {
    if (value == null) { wrong.push(`${what}: the constant itself was not found`); continue }
    for (const [file, re] of places) {
      const m = read(file).match(re)
      if (!m) wrong.push(`${what}: ${file} no longer states it where this test looks`)
      else if (Number(m[1]) !== value) wrong.push(`${what}: ${file} says ${m[1]}, the code says ${value}`)
    }
  }
  check('every number the documents promise is the number the code uses', wrong.length === 0, wrong.join('; '))
}

// A secret, a key or a dataset that somebody added past .gitignore, by name. .gitignore stops what nobody has added
// yet and `git add -f` walks past it, so this is the net that actually holds: it reads what is TRACKED and fails the
// build. The repository is exported to a public one, so a file here is a file in the open.
const LOOKS_LIKE = [
  [/\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, 'a key or a certificate'],
  [/(^|\/)(\.env($|\..*)|[^/]*\.env)$/i, 'an environment file'],
  [/(^|\/)(\.npmrc|\.netrc|\.pgpass|rclone\.conf)$/i, 'a credential file'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)/i, 'an ssh private key'],
  [/(^|\/)(secrets?|credentials)\./i, 'something named as a secret'],
  [/glama[^/]*\.json$|\.claim$/i, 'an ownership claim of ours'],
  [/\.(sqlite3?|db|parquet)$/i, 'a database or a dataset'],
  [/\.jsonl$/i, 'dataset rows'],
  [/\.ots$/i, 'an anchor proof downloaded from the site'],
]
const ALLOWED = [/^tests\/.*\.jsonl$/, /\.env\.example$/]
const smell = []
for (const f of files) {
  if (ALLOWED.some((a) => a.test(f))) continue
  const hit = LOOKS_LIKE.find(([re]) => re.test(f))
  if (hit) smell.push(`${f} (${hit[1]})`)
}
check('nothing tracked looks like a secret, a credential or a dataset', smell.length === 0, smell.join(', '))
// A run's own output, wherever it lands: the counter's hit files and the recorder's readings and run rows.
const RUN_OUTPUT = /(^|\/)(hits|stock-peg|stock-peg-runs)-\d{4}-\d{2}-\d{2}\.jsonl$/
const output = files.filter((f) => RUN_OUTPUT.test(f))
check('no file a run wrote is tracked', output.length === 0, output.join(', '))
check('the rule itself catches what it should', BAD.test(String.fromCharCode(0x410)) && BAD.test('a ' + String.fromCharCode(0x2014) + ' b') && BAD.test('1' + String.fromCharCode(0x2013) + '2') && !BAD.test('plain - ascii: text'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
