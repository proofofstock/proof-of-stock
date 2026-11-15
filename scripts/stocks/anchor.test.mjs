// scripts/stocks/anchor.test.mjs: the daily manifest names every data file of the day with its SHA-256, chains to the
// day before, is never rewritten, and its SHA-256 goes to the OpenTimestamps calendars as a detached proof each.
//
// Run: node scripts/stocks/anchor.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { dayFiles, previousManifest, otsFile, anchorDay, OTS_MAGIC, ANCHOR_FILE_RE, CALENDARS, parseProof, serializeProof, attestations, calendarUrl, upgradeProof, upgradeDir, anchorDays, anchorFor, checkBitcoin, blockMerkleRoots, dayFiles as _df, NotSettled } from './anchor.mjs'

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
  const f = dayFiles(roots, '2026-11-12', { settleMs: 0 })
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
    // A calendar answers a tree that ends in a PENDING attestation naming itself. Anything else is refused now:
    // a fresh answer cannot already be in a Bitcoin block.
    const uri = 'https://a.pool.opentimestamps.org'
    return new Response(Buffer.concat([Buffer.from([0x00]), Buffer.from('83dfe30d2ef90c8e', 'hex'), Buffer.from([uri.length + 1, uri.length]), Buffer.from(uri, 'utf8')]))
  }
  await anchorDay({ roots, outDir: out, day: '2026-11-11', fetchImpl, now: () => Date.parse('2026-11-12T00:20:00Z'), log: () => {}, settleMs: 0 })
  const r = await anchorDay({ roots, outDir: out, day: '2026-11-12', fetchImpl, now: () => Date.parse('2026-11-13T00:20:00Z'), log: () => {}, settleMs: 0 })
  const mfBytes = fs.readFileSync(path.join(out, 'manifest-2026-11-12.json'))
  const mf = JSON.parse(mfBytes)
  check('the manifest names the day, its files, and the SHA-256 of the day before', mf.day === '2026-11-12' && mf.files.length === 4 && mf.previous?.day === '2026-11-11' && mf.previous.sha256 === sha(fs.readFileSync(path.join(out, 'manifest-2026-11-11.json'))))
  check('the SHA-256 of the manifest is what each calendar is sent, by POST', r.sha256 === sha(mfBytes) && asked.filter((a) => a.body === r.sha256).every((a) => a.method === 'POST') && asked.some((a) => a.body === r.sha256))
  check('one calendar down: the other proof is written, and the run says which failed', r.proofs.filter((p) => p.state === 'stamped').length === 1 && r.proofs.filter((p) => p.state === 'failed').length === 1)
  put(roots.base, 'stock-peg-2026-11-12.jsonl', '{"a":1}\n{"late":2}\n')
  down = new Set()
  const again = await anchorDay({ roots, outDir: out, day: '2026-11-12', fetchImpl, now: () => Date.parse('2026-11-13T01:00:00Z'), log: () => {}, settleMs: 0 })
  check('a rerun never rewrites the manifest, even if a file changed since; it only adds the missing proof', fs.readFileSync(path.join(out, 'manifest-2026-11-12.json')).equals(mfBytes) && again.proofs.filter((p) => p.state === 'kept').length === 1 && again.proofs.filter((p) => p.state === 'stamped').length === 1)
  check('every file it writes has a name the site may serve, and nothing else does', fs.readdirSync(out).every((n) => ANCHOR_FILE_RE.test(n)) && !ANCHOR_FILE_RE.test('../manifest-2026-11-12.json') && !ANCHOR_FILE_RE.test('manifest-2026-11-12.json.tmp-1') && !ANCHOR_FILE_RE.test('pool-book.json'))
  check('the previous manifest is the newest one before the day', previousManifest(out, '2026-11-13').day === '2026-11-12' && previousManifest(out, '2026-11-11') === null)
}

const PENDING_PROOF = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108cd327890de9cfd8bbaf4386d6c92bb103efd1431a857f83651194801665979bbf0086735ad5631d211c208f0101a1bef42354f68aa3314a71974a1115808f020a9e8f8ae15eaa51bb75f530cfe0134c4cecf7944e22d48eda00d75282b555c0608f1204d7c2cb7886838fc32820e91ca49d81367695defdea88a95c193b682a0780ccf08f020aca897a30726adf0cf66fe72c1058b4a3cb931bd40e833e6646c6bd802869df008f1046af658c8f00857146c10cdf3206b0083dfe30d2ef90c8e2e2d68747470733a2f2f616c6963652e6274632e63616c656e6461722e6f70656e74696d657374616d70732e6f7267', 'hex')
const COMMITMENT = '6af658c8138a713a791c7731324552f3903b70627d96919e30014dd05665e1b2d56391f257146c10cdf3206b'
const ALICE_ANSWER = Buffer.from('08f120d875fb249bff17326c3253ee2fd13c75721f41022dc76e00984ecb059aa0e47808f120af7a005799258c03071f3a80919e7b16c1784d60e865c233683227853b72341c08f0208a60a61897a2c8f7eb83121c36666525f28cc5e29859b6341af0ad8adb64f88a08f020785507d9f2653758a9545e63c5c75f3e5356fac8a31a671cc1ae228937e8b5ea08f02079bdae90eb3dc9266853a3ab71c5e614983b87abddf3efda32fb320ab35d02bf08f020430f93a00dbdd30d722f39e52887f8a14f8b7790bf2664c9d3979fbd73b0627c08f0208e6b8a42fa0cceb6d03678138bd7d7da7af2459269086d4fc78a80955d05a4c408f12082115cf1c43c9750194d010d33da7a88a4b462348d87522c6fc71fc0ad3cd65c08f0209afc17591c369a3d35e3af7344e6841c1bd453db7431480eb6a499cf4db669fd08f02079e29f24047f0f800a4e2a58ef724fa06898e10a86fe78908ac2dce3081699db08f120ee9a820a6cd61350aa85432c8d4782219e424eadab21296b276a4b942733e48308f02069c7434acd9fa929b23e7725b82ae6f0ea210f4ef98b184dd0968e16ad117b3508f12036b05c083d455d8aaaddccb02d132b795ecd89c4677a8c8c2bb9c4297925ca2c08f02046ae72c26e06d9351f681115fb757ae6a49aa6fad12eed8b267bef52cdc2eaab08f15901000000011cfec550ea738f0c0571f137ea3226e9ac47fb9c4869972436cb199d4b3c70570000000000feffffff02a7950000000000001600141d90f99ef8715d49a4eed4bd58be9c17aed79ecc0000000000000000226a20f00403e30e000808f12048b94c095a19186fd283f41531a7dd75eefb65556799b3a305906daec2c7e8b90808f0206f79b9e46577573f29e5bd22ae650fcae8e82495b4c8b3d96b463abdca3ea9080808f020d398c0be7c7b60863c7e6770e005179ebeac031928af0171864f92888e97f23d0808f020fbea450f671382ef98514cbfd809b566c321784584022bbc7bde0ec7b0df424b0808f02066a6106e3b2284f0e4c1e80ae48b9375935d201cba32beaa10daadac5cccfefa0808f120c03cd4f6c7e1cd185f71c5fc55d0c599b98302078261cd311109e92ae2e739610808f020d6c5f00cd96c736c41e1b4ad535744914bf321857c8ac86ac76f8810dfd59f700808f02053d6f12e18de413938cccdf839d39ecf406c843bb49e3f059f4a21db174c26950808f12034b762ce340828291c5a214172b0a00a382525df63ad015e231e86aa5d86cefd0808f0209c01f53b136fdac833a9310733715e8e05d04bfbeb7cb2231aed6f71f24e328f0808f1201549001766922cb26c38521195ee9f0e603ac71e6b8db4d9eed484d8c08fe67c0808f020a606bfc07934513ccfc06ad9e67ec6aa1a7c3cb1277d992c21ac4b9e77371e110808000588960d73d719010384c63b', 'hex')
const MERKLE_ROOT_975620 = '449d285ade5728aa8c60fa14c5a43113200d0577210d1cfd8705807ae1123dfa'
const DIGEST = 'cd327890de9cfd8bbaf4386d6c92bb103efd1431a857f83651194801665979bb'
console.log('what a calendar is allowed to answer, and when a day is ready to hash')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-fresh-'))
  const roots = { base: path.join(dir, 'base') }
  fs.mkdirSync(path.join(roots.base, 'stock-peg', 'history'), { recursive: true })
  fs.writeFileSync(path.join(roots.base, 'stock-peg', 'stock-peg-2026-11-12.jsonl'), '{"a":1}' + String.fromCharCode(10))
  // A FRESH ANSWER CANNOT ALREADY BE IN A BLOCK. One that says it is, is one somebody made up, and believing it would
  // put a Bitcoin block number we never checked into the sentence agents quote.
  const forged = Buffer.concat([Buffer.from([0x00]), Buffer.from('0588960d73d71901', 'hex'), Buffer.from([0x04]), Buffer.from('a0ba3b', 'hex'), Buffer.from([0x00])])
  const r = await anchorDay({ roots, outDir: dir, day: '2026-11-12', settleMs: 0, log: () => {}, calendars: ['https://a.pool.opentimestamps.org'], fetchImpl: async () => new Response(forged) })
  check('a fresh answer that already claims Bitcoin is refused, and nothing is written', r.proofs[0].state === 'failed' && /pending only/.test(r.proofs[0].error) && !fs.readdirSync(dir).some((n) => n.endsWith('.ots')))
  const junk = await anchorDay({ roots, outDir: dir, day: '2026-11-12', settleMs: 0, log: () => {}, calendars: ['https://b.pool.opentimestamps.org'], fetchImpl: async () => new Response(Buffer.from('ffff', 'hex')) })
  check('...and an answer that is not a timestamp at all is refused too, rather than stored unreadable', junk.proofs[0].state === 'failed' && !fs.readdirSync(dir).some((n) => n.endsWith('.ots')))
  // A file written moments ago means the day is still being finished: the recorder writes its row when it ends.
  let settled = null
  try { _df(roots, '2026-11-12') } catch (e) { settled = e }
  check('a day whose file was just written is not hashed, and says so as its own kind of error', settled instanceof NotSettled && /still being finished/.test(settled.message))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('completing a proof (ots upgrade)')
{
  // A real pair: our proof of manifest-2026-11-12.json from a.pool as stamped (pending), and alice's answer for its
  // commitment once Bitcoin confirmed it, in block 975620 (merkle root as block explorers show it).

  const p = parseProof(PENDING_PROOF)
  const a0 = attestations(p.root)
  check('a stamped proof reads: our digest, one pending attestation at alice, and writes back byte for byte', p.digest.toString('hex') === DIGEST && a0.length === 1 && a0[0].kind === 'pending' && a0[0].uri === 'https://alice.btc.calendar.opentimestamps.org' && a0[0].msg.toString('hex') === COMMITMENT && serializeProof(p).equals(PENDING_PROOF))

  const urls = []
  const answer = (status, body) => async (url) => { urls.push(String(url)); return new Response(body, { status }) }
  const up = await upgradeProof(PENDING_PROOF, { fetchImpl: answer(200, ALICE_ANSWER) })
  const done = parseProof(up.bytes)
  const btc = attestations(done.root)
  check('alice is asked for exactly our commitment', urls[0] === `https://alice.btc.calendar.opentimestamps.org/timestamp/${COMMITMENT}`, urls[0])
  const btcOnly = btc.filter((x) => x.kind === 'bitcoin')
  check('the completed proof keeps the digest and its pending attestation, and is attested by Bitcoin block 975620', up.state === 'upgraded' && up.height === 975620 && done.digest.toString('hex') === DIGEST && btc.length === 2 && btc.filter((x) => x.kind === 'pending').length === 1 && btcOnly.length === 1 && btcOnly[0].height === 975620)
  check('...and its path ends at that block\'s merkle root: the same check `ots verify` makes', Buffer.from(btcOnly[0].msg).reverse().toString('hex') === MERKLE_ROOT_975620)
  check('...it starts with the stamped proof up to the commitment, so nothing before is changed', up.bytes.subarray(0, PENDING_PROOF.length - 56).equals(PENDING_PROOF.subarray(0, PENDING_PROOF.length - 56)))

  urls.length = 0
  const again = await upgradeProof(up.bytes, { fetchImpl: answer(200, ALICE_ANSWER) })
  check('a complete proof is left alone and no calendar is asked', again.state === 'complete' && again.height === 975620 && !again.bytes && urls.length === 0)
  const notYet = await upgradeProof(PENDING_PROOF, { fetchImpl: answer(404, 'Pending confirmation in Bitcoin blockchain') })
  check('not in a block yet (404): still pending, nothing to write, no error', notYet.state === 'pending' && !notYet.bytes && notYet.errors.length === 0)
  const onlyPending = await upgradeProof(PENDING_PROOF, { fetchImpl: answer(200, Buffer.from('f0010100' + '83dfe30d2ef90c8e' + '0302017a', 'hex')) })
  check('an answer without a Bitcoin attestation is not written', onlyPending.state === 'pending' && !onlyPending.bytes)
  for (const [label, body] of [['a truncated answer', ALICE_ANSWER.subarray(0, 300)], ['trailing bytes', Buffer.concat([ALICE_ANSWER, Buffer.from([0])])], ['an unknown operation', Buffer.from('67' + '000588960d73d719010384c63b', 'hex')]]) {
    const bad = await upgradeProof(PENDING_PROOF, { fetchImpl: answer(200, body) })
    check(`${label} from the calendar: nothing written, the error is reported`, bad.state === 'pending' && !bad.bytes && bad.errors.length === 1, JSON.stringify(bad.errors))
  }

  check('only the public OpenTimestamps calendars, by bare https origin, are ever asked', calendarUrl('https://alice.btc.calendar.opentimestamps.org') && !calendarUrl('http://alice.btc.calendar.opentimestamps.org') && !calendarUrl('https://opentimestamps.org.evil.example') && !calendarUrl('https://alice.btc.calendar.opentimestamps.org/x') && !calendarUrl('https://127.0.0.1') && !calendarUrl('not a url'))
  const evil = Buffer.from(PENDING_PROOF)
  evil.write('com', PENDING_PROOF.length - 3, 'latin1') // ...opentimestamps.org becomes ...opentimestamps.com
  urls.length = 0
  const refused = await upgradeProof(evil, { fetchImpl: answer(200, ALICE_ANSWER) })
  check('...a proof that names any other place is not followed', refused.state === 'pending' && urls.length === 0 && /not allowed/.test(refused.errors[0]))
  let threw = false
  try { parseProof(Buffer.concat([PENDING_PROOF, Buffer.from([0])])) } catch (_) { threw = true }
  check('a proof with trailing bytes is refused', threw)

  // The directory: completed in place, atomically, within the window; an old pending day is flagged stale.
  const dir = path.join(tmp, 'up')
  fs.mkdirSync(dir)
  const put2 = (n, b) => fs.writeFileSync(path.join(dir, n), b)
  put2('manifest-2026-11-12.json', '{}')
  put2('manifest-2026-11-12.json.a-pool-opentimestamps-org.ots', PENDING_PROOF)
  put2('manifest-2026-11-09.json.a-pool-opentimestamps-org.ots', PENDING_PROOF)
  put2('manifest-2026-10-01.json.a-pool-opentimestamps-org.ots', PENDING_PROOF)
  urls.length = 0
  const res = await upgradeDir({ outDir: dir, fetchImpl: async (url) => { urls.push(String(url)); return new Response(url.includes('x') ? '' : ALICE_ANSWER) }, now: () => Date.parse('2026-11-14T00:20:00Z'), log: () => {} })
  const by = Object.fromEntries(res.map((r) => [r.file.slice(9, 19), r]))
  check('the directory: proofs in the window are completed in place, older ones are read but never written', by['2026-11-12'].state === 'upgraded' && by['2026-11-09'].state === 'upgraded' && (by['2026-10-01'] || {}).past_window === true && (by['2026-10-01'] || {}).state === 'pending' && (by['2026-10-01'] || {}).stale === true && fs.readFileSync(path.join(dir, 'manifest-2026-10-01.json.a-pool-opentimestamps-org.ots')).equals(PENDING_PROOF) && attestations(parseProof(fs.readFileSync(path.join(dir, 'manifest-2026-11-12.json.a-pool-opentimestamps-org.ots'))).root).find((x) => x.kind === 'bitcoin').height === 975620)
  check('...no temporary file is left, and every name is one the site serves', fs.readdirSync(dir).every((n) => ANCHOR_FILE_RE.test(n)))
  put2('manifest-2026-11-10.json.a-pool-opentimestamps-org.ots', PENDING_PROOF)
  const stale = await upgradeDir({ outDir: dir, fetchImpl: answer(404, ''), now: () => Date.parse('2026-11-14T00:20:00Z'), log: () => {} })
  const s = Object.fromEntries(stale.map((r) => [r.file.slice(9, 19), r]))
  check('a proof still pending after three days is flagged stale; a completed one never is', s['2026-11-10'].state === 'pending' && s['2026-11-10'].stale === true && s['2026-11-12'].state === 'complete' && s['2026-11-12'].stale === false && s['2026-11-09'].stale === false)
  put2('manifest-2026-11-11.json.a-pool-opentimestamps-org.ots', Buffer.from('not a proof'))
  const broken = await upgradeDir({ outDir: dir, fetchImpl: answer(404, ''), now: () => Date.parse('2026-11-14T00:20:00Z'), log: () => {} })
  check('a file that is not a proof is reported as failed and left as it was', broken.find((r) => r.file.includes('11-11')).state === 'failed' && fs.readFileSync(path.join(dir, 'manifest-2026-11-11.json.a-pool-opentimestamps-org.ots')).toString() === 'not a proof')
}

const units = fs.readFileSync(new URL('../../deployment/systemd/stp-anchor.service', import.meta.url), 'utf8')
const timer = fs.readFileSync(new URL('../../deployment/systemd/stp-anchor.timer', import.meta.url), 'utf8')
check('the unit writes only its own directory and alerts on failure; the timer runs once a day', /ReadWritePaths=\/var\/lib\/stp-anchors\n/.test(units) && /ProtectSystem=strict/.test(units) && /OnFailure=stp-alert@%n\.service/.test(units) && /OnCalendar=\*-\*-\* 00:20:00 UTC/.test(timer) && /Persistent=true/.test(timer))

console.log('reading a day back (what verify_anchor hands over)')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-read-'))
  const day = '2026-11-12'
  const body = '{"day":"2026-11-12"}' + String.fromCharCode(10)
  fs.writeFileSync(path.join(dir, `manifest-${day}.json`), body)
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  fs.writeFileSync(path.join(dir, `manifest-${day}.json.a-pool-opentimestamps-org.ots`), Buffer.from('00ff', 'hex'))
  check('a day names its manifest hash and the proofs beside it', anchorFor(dir, day).sha256 === digest && anchorFor(dir, day).proofs.length === 1)
  check('an unreadable proof is called unreadable, not pending', anchorFor(dir, day).proofs[0].state === 'unreadable')
  // A real pending proof, from the fixture above, re-pointed at this manifest's digest: the tree is untouched, only
  // the bytes it commits to. parseProof does not check the tree against the digest, and neither does this.
  const REAL = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108cd327890de9cfd8bbaf4386d6c92bb103efd1431a857f83651194801665979bbf0086735ad5631d211c208f0101a1bef42354f68aa3314a71974a1115808f020a9e8f8ae15eaa51bb75f530cfe0134c4cecf7944e22d48eda00d75282b555c0608f1204d7c2cb7886838fc32820e91ca49d81367695defdea88a95c193b682a0780ccf08f020aca897a30726adf0cf66fe72c1058b4a3cb931bd40e833e6646c6bd802869df008f1046af658c8f00857146c10cdf3206b0083dfe30d2ef90c8e2e2d68747470733a2f2f616c6963652e6274632e63616c656e6461722e6f70656e74696d657374616d70732e6f7267', 'hex')
  const repointed = Buffer.concat([REAL.subarray(0, 33), Buffer.from(digest, 'hex'), REAL.subarray(65)])
  fs.writeFileSync(path.join(dir, `manifest-${day}.json.a-pool-opentimestamps-org.ots`), repointed)
  check('a proof of this manifest is read as pending until Bitcoin has it', anchorFor(dir, day).proofs[0].state === 'pending')
  fs.writeFileSync(path.join(dir, `manifest-${day}.json.a-pool-opentimestamps-org.ots`), REAL)
  check('a proof that commits to OTHER bytes is a fault, never a Bitcoin block beside this hash', anchorFor(dir, day).proofs[0].state === 'other-digest' && anchorFor(dir, day).proofs[0].bitcoin_block === null)
  fs.writeFileSync(path.join(dir, `manifest-${day}.json.a-pool-opentimestamps-org.ots`), repointed)
  check('the days are newest first, and only manifests make a day', anchorDays(dir).join() === day)
  // Everything in this directory is public evidence: the site serves it and the BACKUP USER copies it, and that user
  // is not the one that writes it. The unit holding the key runs with UMask=0077, so inheriting the mode left files
  // at 0600 and the nightly copy stopped mid-snapshot (found on the host, 14.11). Windows has no such bits, so this
  // is checked where it means something, which includes CI.
  if (process.platform === 'win32') { passed++; console.log('  ok   (file modes are not checked on this platform)') } else {
    const wrote = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-mode-'))
    const roots2 = { base: path.join(wrote, 'base') }
    fs.mkdirSync(path.join(roots2.base, 'stock-peg', 'history'), { recursive: true })
    fs.writeFileSync(path.join(roots2.base, 'stock-peg', 'stock-peg-2026-11-12.jsonl'), '{"a":1}' + String.fromCharCode(10))
    const before = process.umask(0o077)
    const uri2 = 'https://a.pool.opentimestamps.org'
    await anchorDay({ roots: roots2, outDir: wrote, day: '2026-11-12', settleMs: 0, log: () => {}, calendars: ['https://a.pool.opentimestamps.org'], fetchImpl: async () => new Response(Buffer.concat([Buffer.from([0x00]), Buffer.from('83dfe30d2ef90c8e', 'hex'), Buffer.from([uri2.length + 1, uri2.length]), Buffer.from(uri2, 'utf8')])) })
    process.umask(before)
    const written = fs.readdirSync(wrote)
    const tight = written.filter((n) => (fs.statSync(path.join(wrote, n)).mode & 0o044) !== 0o044)
    check('every file of evidence is readable by the backup user, whatever the unit umask is', written.length >= 2 && tight.length === 0, `${written.length} files, not readable: ${tight.join() || 'none'}`)
    fs.rmSync(wrote, { recursive: true, force: true })
  }
  check('a day with no manifest is nothing, and a day that is not a day is refused', anchorFor(dir, '2026-01-01') === null && anchorFor(dir, 'today') === null)
  // What the proof CLAIMS about Bitcoin, and what we checked. A completed proof repointed at this manifest: the tree
  // is untouched, so it still ends at block 975620 and at that block's merkle root.
  const complete = (await upgradeProof(PENDING_PROOF, { fetchImpl: async () => new Response(ALICE_ANSWER) })).bytes
  fs.writeFileSync(path.join(dir, `manifest-${day}.json.a-pool-opentimestamps-org.ots`), Buffer.concat([complete.subarray(0, 33), Buffer.from(digest, 'hex'), complete.subarray(65)]))
  const claimed = anchorFor(dir, day).proofs[0]
  check('a Bitcoin attestation we have not checked is CLAIMED, never stated', claimed.state === 'bitcoin-claimed' && claimed.bitcoin_block === 975620)
  // The root the path ends at, for THESE bytes. (The proof above was repointed at this manifest, so its path leads
  // somewhere else than the real block 975620 root; what matters here is that the root is handed over at all, and the
  // test for a real proof's real root is in the upgrade block above, the one that does what `ots verify` does.)
  const root = claimed.bitcoin_merkle_root
  check('...and the merkle root it ends at is handed over, so anyone can compare it in one request', /^[0-9a-f]{64}$/.test(root))
  const checkFile = (height, root) => fs.writeFileSync(path.join(dir, `btc-check-${day}.json`), JSON.stringify({ day, checks: [{ file: `manifest-${day}.json.a-pool-opentimestamps-org.ots`, height, merkle_root: root, agreed: ['mempool.space', 'blockstream.info'] }] }))
  checkFile(975620, 'f'.repeat(64))
  check('a check of a different root does not make it verified', anchorFor(dir, day).proofs[0].state === 'bitcoin-claimed')
  checkFile(975620, root)
  check('a check that matches the height and the root does', anchorFor(dir, day).proofs[0].state === 'bitcoin')
  // A mirror record that says confirmed with nobody named behind it is read back as what it is, so the JSON an agent
  // parses cannot disagree with the sentence it quotes.
  fs.writeFileSync(path.join(dir, `mirror-${day}.json`), JSON.stringify({ day, sha256: digest, mirrors: [{ chain: 'base', tx: '0x' + 'ab'.repeat(32), status: 'confirmed', block: 7 }] }))
  check('confirmed with nobody behind it reads back as in-block-unwitnessed', anchorFor(dir, day).mirrors[0].status === 'in-block-unwitnessed')
  fs.writeFileSync(path.join(dir, `mirror-${day}.json`), JSON.stringify({ day, sha256: digest, mirrors: [{ chain: 'base', tx: '0x' + 'ab'.repeat(32), status: 'confirmed', block: 7, witnessed_by: ['a.test', 'b.test'] }] }))
  check('...and one with witnesses named stays confirmed', anchorFor(dir, day).mirrors[0].status === 'confirmed')
  fs.rmSync(path.join(dir, `mirror-${day}.json`), { force: true })
  fs.rmSync(path.join(dir, `btc-check-${day}.json`), { force: true })

  // Asking Bitcoin itself. Two sources that are not the calendar have to agree before anything is called verified.
  const explorer = (root) => async (url) => new Response(String(url).includes('block-height') ? 'b'.repeat(64) : JSON.stringify({ merkle_root: root }))
  const roots = await blockMerkleRoots(975620, { fetchImpl: explorer(root) })
  check('both sources are asked, by height then by block', roots.length === 2 && roots.every((r) => r.merkle_root === root))
  const agreed = await checkBitcoin({ outDir: dir, fetchImpl: explorer(root), now: () => Date.parse('2026-11-13T00:00:00Z'), log: () => {} })
  check('a root both sources confirm is written down, and the proof becomes verified', agreed.length === 1 && agreed[0].agreed.length === 2 && anchorFor(dir, day).proofs[0].state === 'bitcoin')
  fs.rmSync(path.join(dir, `btc-check-${day}.json`), { force: true })
  const lying = await checkBitcoin({ outDir: dir, fetchImpl: explorer('a'.repeat(64)), now: () => Date.parse('2026-11-13T00:00:00Z'), log: () => {} })
  check('a block whose real root is something else is reported, and nothing is written down', lying[0].disagreed.length === 2 && !fs.existsSync(path.join(dir, `btc-check-${day}.json`)) && anchorFor(dir, day).proofs[0].state === 'bitcoin-claimed')
  const oneSource = await checkBitcoin({ outDir: dir, fetchImpl: async (url) => (String(url).includes('mempool') ? explorer(root)(url) : new Response('', { status: 500 })), now: () => Date.parse('2026-11-13T00:00:00Z'), log: () => {} })
  check('one source alone is not enough to call it verified', oneSource[0].agreed.length === 1 && !fs.existsSync(path.join(dir, `btc-check-${day}.json`)))
  fs.rmSync(path.join(dir, `manifest-${day}.json.a-pool-opentimestamps-org.ots`))
  fs.writeFileSync(path.join(dir, `manifest-${day}.json.a-pool-opentimestamps-org.ots`), repointed)

  const mirror = (sha, inner) => fs.writeFileSync(path.join(dir, `mirror-${day}.json`), JSON.stringify({ day, sha256: sha, mirrors: [{ chain: 'base', tx: '0x' + 'ab'.repeat(32), status: 'confirmed', sha256: inner }] }))
  mirror(digest, digest)
  check('a mirror of this manifest is shown', anchorFor(dir, day).mirrors.length === 1 && anchorFor(dir, day).mirror_mismatch === false)
  mirror('f'.repeat(64), 'f'.repeat(64))
  check('a mirror record of other bytes is dropped, and said', anchorFor(dir, day).mirrors.length === 0 && anchorFor(dir, day).mirror_mismatch === true)
  // The record-level hash can be right while an entry inside it was written for other bytes: that entry is evidence
  // about a manifest this is not, so it goes too rather than being shown under this day's hash.
  mirror(digest, 'f'.repeat(64))
  check('...and so is one entry of other bytes inside a record that otherwise matches', anchorFor(dir, day).mirrors.length === 0 && anchorFor(dir, day).mirror_mismatch === true)
  // An older record whose entries name no hash of their own: then the record's own hash is the only thing saying
  // which manifest it belongs to, and it has to be checked.
  fs.writeFileSync(path.join(dir, `mirror-${day}.json`), JSON.stringify({ day, sha256: 'f'.repeat(64), mirrors: [{ chain: 'base', tx: '0x' + 'ab'.repeat(32), status: 'confirmed' }] }))
  check('a record of other bytes is dropped even when its entries name no hash at all', anchorFor(dir, day).mirrors.length === 0 && anchorFor(dir, day).mirror_mismatch === true)
  fs.rmSync(dir, { recursive: true, force: true })
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
