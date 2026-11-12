// scripts/stocks/anchor.test.mjs: the daily manifest names every data file of the day with its SHA-256, chains to the
// day before, is never rewritten, and its SHA-256 goes to the OpenTimestamps calendars as a detached proof each.
//
// Run: node scripts/stocks/anchor.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { dayFiles, previousManifest, otsFile, anchorDay, OTS_MAGIC, ANCHOR_FILE_RE, CALENDARS } from './anchor.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'))
const roots = { base: path.join(tmp, 'base'), robinhood: path.join(tmp, 'rh') }
for (const r of Object.values(roots)) fs.mkdirSync(path.join(r, 'stock-peg', 'history'), { recursive: true })
const put = (root, rel, text) => fs.writeFileSync(path.join(root, 'stock-peg', rel), text)
put(roots.base, 'stock-peg-2026-11-12.jsonl', '{"a":1}\n')
put(roots.base, 'stock-peg-runs-2026-11-12.jsonl', '{"r":1}\n')
put(roots.base, 'history/cases-2026-11-12.jsonl', '{"c":1}\n')
put(roots.base, 'stock-peg-2026-11-11.jsonl', '{"old":1}\n')
put(roots.robinhood, 'history/registry-2026-11-12.jsonl', '{"g":1}\n')
put(roots.robinhood, 'pool-book.json', '{}')

console.log('the manifest')
{
  const f = dayFiles(roots, '2026-11-12')
  check('every data file of that day, per chain, with its size and SHA-256; other days and state files are left out', f.length === 4 && f.every((x) => /^[0-9a-f]{64}$/.test(x.sha256) && x.bytes > 0) && !f.some((x) => /2026-11-11|pool-book/.test(x.file)) && f[0].sha256 === sha('{"a":1}\n'), JSON.stringify(f.map((x) => x.chain + ':' + x.file)))
  let threw = false
  try { dayFiles(roots, '../etc') } catch (_) { threw = true }
  check('...and a day that is not YYYY-MM-DD is refused', threw)
}

console.log('the proofs')
{
  const digest = 'ab'.repeat(32)
  const ots = otsFile(digest, Buffer.from('f008aabbccdd', 'hex'))
  check('a detached proof: the OpenTimestamps header, version 1, the SHA-256 op, the digest, then the calendar answer', ots.subarray(0, 31).equals(OTS_MAGIC) && ots[31] === 1 && ots[32] === 0x08 && ots.subarray(33, 65).toString('hex') === digest && ots.subarray(65).toString('hex') === 'f008aabbccdd')
  check('...the header is the one OpenTimestamps defines', OTS_MAGIC.toString('latin1').includes('OpenTimestamps') && OTS_MAGIC.length === 31)
}

console.log('a day anchored')
{
  const out = path.join(tmp, 'anchors')
  const asked = []
  let down = new Set([CALENDARS[1]])
  const fetchImpl = async (url, init) => {
    const cal = CALENDARS.find((c) => String(url).startsWith(c))
    asked.push({ cal, body: Buffer.from(init.body).toString('hex'), method: init.method })
    if (down.has(cal)) return new Response('', { status: 503 })
    return new Response(Buffer.from('f0' + '11'.repeat(8), 'hex'))
  }
  await anchorDay({ roots, outDir: out, day: '2026-11-11', fetchImpl, now: () => Date.parse('2026-11-12T00:20:00Z'), log: () => {} })
  const r = await anchorDay({ roots, outDir: out, day: '2026-11-12', fetchImpl, now: () => Date.parse('2026-11-13T00:20:00Z'), log: () => {} })
  const mfBytes = fs.readFileSync(path.join(out, 'manifest-2026-11-12.json'))
  const mf = JSON.parse(mfBytes)
  check('the manifest names the day, its files, and the SHA-256 of the day before', mf.day === '2026-11-12' && mf.files.length === 4 && mf.previous?.day === '2026-11-11' && mf.previous.sha256 === sha(fs.readFileSync(path.join(out, 'manifest-2026-11-11.json'))))
  check('the SHA-256 of the manifest is what each calendar is sent, by POST', r.sha256 === sha(mfBytes) && asked.filter((a) => a.body === r.sha256).every((a) => a.method === 'POST') && asked.some((a) => a.body === r.sha256))
  check('one calendar down: the other proof is written, and the run says which failed', r.proofs.filter((p) => p.state === 'stamped').length === 1 && r.proofs.filter((p) => p.state === 'failed').length === 1)
  put(roots.base, 'stock-peg-2026-11-12.jsonl', '{"a":1}\n{"late":2}\n')
  down = new Set()
  const again = await anchorDay({ roots, outDir: out, day: '2026-11-12', fetchImpl, now: () => Date.parse('2026-11-13T01:00:00Z'), log: () => {} })
  check('a rerun never rewrites the manifest, even if a file changed since; it only adds the missing proof', fs.readFileSync(path.join(out, 'manifest-2026-11-12.json')).equals(mfBytes) && again.proofs.filter((p) => p.state === 'kept').length === 1 && again.proofs.filter((p) => p.state === 'stamped').length === 1)
  check('every file it writes has a name the site may serve, and nothing else does', fs.readdirSync(out).every((n) => ANCHOR_FILE_RE.test(n)) && !ANCHOR_FILE_RE.test('../manifest-2026-11-12.json') && !ANCHOR_FILE_RE.test('manifest-2026-11-12.json.tmp-1') && !ANCHOR_FILE_RE.test('pool-book.json'))
  check('the previous manifest is the newest one before the day', previousManifest(out, '2026-11-13').day === '2026-11-12' && previousManifest(out, '2026-11-11') === null)
}

const units = fs.readFileSync(new URL('../../deployment/systemd/stp-anchor.service', import.meta.url), 'utf8')
const timer = fs.readFileSync(new URL('../../deployment/systemd/stp-anchor.timer', import.meta.url), 'utf8')
check('the unit writes only its own directory and alerts on failure; the timer runs once a day', /ReadWritePaths=\/var\/lib\/stp-anchors\n/.test(units) && /ProtectSystem=strict/.test(units) && /OnFailure=stp-alert@%n\.service/.test(units) && /OnCalendar=\*-\*-\* 00:20:00 UTC/.test(timer) && /Persistent=true/.test(timer))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
