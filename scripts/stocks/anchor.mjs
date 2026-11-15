// scripts/stocks/anchor.mjs: once a day, a manifest of the SHA-256 of every data file the day produced, chained to the
// manifest of the day before, and its hash sent to the OpenTimestamps calendars, which commit it to Bitcoin.
//
// Why (spec item F; the moat debate of 12.11): our history is append-only, but one server holds it, so on its own it
// could be rewritten whole. A manifest anchored in Bitcoin proves the files existed in this exact form by that day.
// It proves WHEN, not that they were right; it costs nothing and needs no key or transaction of ours.
//
//   node scripts/stocks/anchor.mjs [--day=YYYY-MM-DD] [--out=/var/lib/stp-anchors]
//   (default: yesterday, UTC; roots from STOCKS_ROOT_BASE / STOCKS_ROOT_ROBINHOOD)
//
// Writes, in --out:
//   manifest-<day>.json                       the files, their sizes and SHA-256, and the previous manifest's SHA-256
//   manifest-<day>.json.<calendar>.ots        an OpenTimestamps proof per calendar: pending at first, then completed
//                                             in place once Bitcoin confirms (`ots verify` checks it, anyone can)
// A manifest, once written, is never rewritten: a rerun only adds the proofs that are missing.
//
// Each run also completes the proofs of the last UPGRADE_DAYS days that are still pending: it asks the calendar named
// in the proof for the path from our commitment to a Bitcoin block header, and adds it beside the pending attestation
// (what `ots upgrade` does). Only a path that ends in a Bitcoin attestation is written; nothing already there changes.
// A proof still pending after STALE_DAYS fails the unit (an alert): its calendar may have lost it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { dataRoot } from './data-roots.mjs'

// The OpenTimestamps detached-proof header (python-opentimestamps, DetachedTimestampFile.HEADER_MAGIC), version 1.
export const OTS_MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex')
const OTS_VERSION = 0x01
const OP_SHA256 = 0x08
export const CALENDARS = Object.freeze(['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'])
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const ANCHOR_FILE_RE = /^(manifest-\d{4}-\d{2}-\d{2}\.json(\.[a-z0-9-]+\.ots)?|(mirror|btc-check)-\d{4}-\d{2}-\d{2}\.json)$/

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** The day's data files of every chain: name, size and SHA-256, in a stable order. Missing files are simply absent. */
export const SETTLE_MS = 5 * 60e3
/** Thrown when a file of the day was written moments ago: the day is not finished, so its hash would not be either. */
export class NotSettled extends Error {}

export function dayFiles (roots, day, { settleMs = SETTLE_MS, now = () => Date.now() } = {}) {
  if (!DAY_RE.test(day)) throw new Error('day must be YYYY-MM-DD')
  const out = []
  for (const chain of Object.keys(roots).sort()) {
    const base = path.join(roots[chain], 'stock-peg')
    for (const rel of [`stock-peg-${day}.jsonl`, `stock-peg-runs-${day}.jsonl`, `history/cases-${day}.jsonl`, `history/registry-${day}.jsonl`]) {
      let buf, stat
      try { const f = path.join(base, rel); stat = fs.statSync(f); buf = fs.readFileSync(f) } catch (_) { continue }
      // A RECORDER RUN WRITES ITS ROW WHEN IT FINISHES, INTO THE FILE OF THE DAY IT STARTED. A run that began at
      // 23:52 and ended after the anchor started would be hashed half-written, and every reader checking that file
      // against the manifest afterwards would see a mismatch indistinguishable from tampering. So a file touched in
      // the last few minutes stops the run, which retries later (audit, 14.11).
      if (settleMs > 0 && now() - stat.mtimeMs < settleMs) throw new NotSettled(`${chain}/${rel} was written less than ${Math.round(settleMs / 60e3)} min ago: the day is still being finished`)
      out.push({ chain, file: rel, bytes: buf.length, sha256: sha256(buf) })
    }
  }
  return out
}

/** The newest manifest before `day` in `dir`, as { day, sha256 } of its bytes, or null. */
export function previousManifest (dir, day) {
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => /^manifest-\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(9, 19) < day).sort() } catch (_) { return null }
  if (!names.length) return null
  const last = names[names.length - 1]
  return { day: last.slice(9, 19), sha256: sha256(fs.readFileSync(path.join(dir, last))) }
}

/** The bytes of a detached .ots proof for a SHA-256 digest, given a calendar's answer to POST /digest. */
export function otsFile (digestHex, calendarAnswer) {
  const digest = Buffer.from(digestHex, 'hex')
  if (digest.length !== 32) throw new Error('digest must be 32 bytes')
  return Buffer.concat([OTS_MAGIC, Buffer.from([OTS_VERSION, OP_SHA256]), digest, Buffer.from(calendarAnswer)])
}

const calendarName = (url) => new URL(url).host.replace(/[^a-z0-9-]/g, '-')

/** Build the day's manifest if it is not there yet, then ask each calendar that has no proof yet. */
export async function anchorDay ({ roots, outDir, day, fetchImpl = fetch, now = () => Date.now(), calendars = CALENDARS, log = console.log, settleMs = SETTLE_MS }) {
  fs.mkdirSync(outDir, { recursive: true })
  const mf = path.join(outDir, `manifest-${day}.json`)
  if (!fs.existsSync(mf)) {
    const files = dayFiles(roots, day, { settleMs, now })
    const manifest = { _schema: 'proofofstock-anchor-manifest/1', day, built_at: new Date(now()).toISOString(), previous: previousManifest(outDir, day), files, note: 'SHA-256 of each data file of the day, as written by the recorder and the history archive. The SHA-256 of this file is anchored in Bitcoin through OpenTimestamps.' }
    const tmp = mf + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    // Everything written here is public evidence (served at /anchors/) and is copied by the backup user, which is
    // not the user that writes it: the mode is set, never inherited from a unit's umask.
    fs.chmodSync(tmp, 0o644)
    fs.renameSync(tmp, mf)
  }
  const digest = sha256(fs.readFileSync(mf))
  const result = { day, manifest: path.basename(mf), sha256: digest, proofs: [] }
  for (const cal of calendars) {
    const out = `${mf}.${calendarName(cal)}.ots`
    if (fs.existsSync(out)) { result.proofs.push({ calendar: cal, file: path.basename(out), state: 'kept' }); continue }
    try {
      const r = await fetchImpl(`${cal}/digest`, { method: 'POST', headers: { accept: 'application/vnd.opentimestamps.v1', 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(digest, 'hex'), signal: AbortSignal.timeout(20_000) })
      if (!r.ok) throw new Error(`calendar answered ${r.status}`)
      const answer = Buffer.from(await r.arrayBuffer())
      if (!answer.length || answer.length > 10_000) throw new Error('calendar answer has an unexpected size')
      // ⚠ A FRESH ANSWER IS A PROMISE, NEVER A PROOF. The calendar has just been handed this digest; it cannot
      // already be in a Bitcoin block, and a tree that says it is, is a tree somebody made up. We parse before we
      // write, and keep only a pending one. Without this, a calendar could hand us an attestation tagged "bitcoin"
      // with any height it liked and we would publish that number the same day (audit, 14.11).
      const fresh = attestations(parseProof(otsFile(digest, answer)).root)
      if (!fresh.length || fresh.some((a) => a.kind !== 'pending')) throw new Error('a fresh calendar answer must be pending only: this one is not')
      const tmp = out + '.tmp-' + process.pid
      try { fs.writeFileSync(tmp, otsFile(digest, answer), { flag: 'wx' }); fs.chmodSync(tmp, 0o644); fs.renameSync(tmp, out) } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
      result.proofs.push({ calendar: cal, file: path.basename(out), state: 'stamped' })
    } catch (e) { result.proofs.push({ calendar: cal, state: 'failed', error: String(e && e.message || e).slice(0, 120) }) }
  }
  log('[anchor] ' + JSON.stringify(result))
  return result
}

/** The proof files of a day whose Bitcoin block has been compared with real block headers. */
export function checkedBlocks (dir, day) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, `btc-check-${day}.json`), 'utf8'))
    return (Array.isArray(c.checks) ? c.checks : []).map((x) => x.file)
  } catch (_) { return [] }
}

/** The days that have a manifest in `dir`, newest first. */
export function anchorDays (dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch (_) { return [] }
  return names.filter((n) => /^manifest-\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(9, 19)).sort().reverse()
}

/**
 * What a day's anchor says, read off the disk and nothing else: the hash of the manifest, the state of each
 * OpenTimestamps proof (pending, or the Bitcoin block it landed in) and the mirror transactions of that same hash.
 * This is what `verify_anchor` hands an agent, so that it can check all three for itself.
 *
 * A mirror record written for a different hash than the manifest now has is not evidence about this manifest: it is
 * dropped and said so, rather than shown beside a hash it does not belong to.
 */
export function anchorFor (dir, day) {
  if (!DAY_RE.test(day)) return null
  let bytes
  try { bytes = fs.readFileSync(path.join(dir, `manifest-${day}.json`)) } catch (_) { return null }
  const digest = sha256(bytes)
  const prefix = `manifest-${day}.json.`
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.ots')).sort() } catch (_) {}
  let checked = []
  try { const c = JSON.parse(fs.readFileSync(path.join(dir, `btc-check-${day}.json`), 'utf8')); if (Array.isArray(c.checks)) checked = c.checks } catch (_) {}
  const proofs = names.map((n) => {
    const out = { file: n, calendar: n.slice(prefix.length, -4), state: 'unreadable', bitcoin_block: null }
    try {
      const proof = parseProof(fs.readFileSync(path.join(dir, n)))
      // A proof is a proof OF SOMETHING. If it commits to other bytes than the manifest now holds, then the manifest
      // was changed after it was stamped, and presenting that Bitcoin block beside this hash would be the one thing
      // this service must never do. It is said as a fault, not quietly dropped.
      if (proof.digest.toString('hex') !== digest) { out.state = 'other-digest'; return out }
      const atts = attestations(proof.root)
      const btc = atts.find((a) => a.kind === 'bitcoin')
      // ⚠ WHAT THE PROOF SAYS IS NOT WHAT BITCOIN SAYS. A Bitcoin attestation is a tag and a height; believing it is
      // believing the calendar, which is the one party a timestamp exists to not have to trust. The path in the proof
      // ends at a merkle root (the message at that node, reversed), and that root either is or is not the root of the
      // block at that height. Until somebody has compared the two against a real block header, this says "claimed"
      // and hands over the root so anyone can compare it in one request. `checkBitcoin` does the comparing, against
      // sources that are not the calendar, and writes what it found beside the proof.
      out.state = btc ? 'bitcoin-claimed' : atts.some((a) => a.kind === 'pending') ? 'pending' : 'other'
      out.bitcoin_block = btc ? btc.height : null
      out.bitcoin_merkle_root = btc ? Buffer.from(btc.msg).reverse().toString('hex') : null
      if (btc && checked.some((c) => c.file === n && c.height === btc.height && c.merkle_root === out.bitcoin_merkle_root)) out.state = 'bitcoin'
    } catch (_) {}
    return out
  })
  let mirrors = []
  let mismatch = false
  // Confirmed means witnessed, in the JSON an agent parses and not only in the sentence it quotes. A record written
  // before witnesses existed, or by a run whose witnesses were all silent, is read back as what it actually is
  // (review, 14.11): the field and the prose must not disagree.
  const asRead = (m) => (m && m.status === 'confirmed' && !(m.witnessed_by || []).length ? { ...m, status: 'in-block-unwitnessed' } : m)
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, `mirror-${day}.json`), 'utf8'))
    // Both the record and each entry in it have to name THIS manifest's hash. The record-level check alone would keep
    // publishing an entry written for other bytes if the record was later rewritten around it.
    if (m && m.sha256 === digest) {
      const all = Array.isArray(m.mirrors) ? m.mirrors : []
      mirrors = all.filter((x) => !x.sha256 || x.sha256 === digest).map(asRead)
      if (mirrors.length !== all.length) mismatch = true
    } else if (m) mismatch = true
  } catch (_) {}
  return { day, manifest: `manifest-${day}.json`, sha256: digest, proofs, mirrors, mirror_mismatch: mismatch }
}

// --- Completing a proof (`ots upgrade`) ---
// The proof after its header is a tree (python-opentimestamps, Timestamp.serialize): from a message, operations lead
// to new messages and finally to attestations. Siblings are prefixed with 0xff, the last one is not.
const ATT_PENDING = '83dfe30d2ef90c8e'
const ATT_BITCOIN = '0588960d73d71901'
const UNARY_OPS = Object.freeze({ 0x08: 'sha256', 0x02: 'sha1', 0x03: 'ripemd160' })
const BINARY_OPS = Object.freeze({ 0xf0: 'append', 0xf1: 'prepend' })
const MAX_DEPTH = 256
const MAX_PROOF_BYTES = 64 * 1024
export const UPGRADE_DAYS = 7
export const STALE_DAYS = 3
const PROOF_FILE_RE = /^manifest-(\d{4}-\d{2}-\d{2})\.json\.[a-z0-9-]+\.ots$/

function reader (buf) {
  let i = 0
  const need = (n) => { if (i + n > buf.length) throw new Error('proof is truncated') }
  const r = {
    byte: () => { need(1); return buf[i++] },
    bytes: (n) => { need(n); const b = buf.subarray(i, i + n); i += n; return b },
    varuint: () => {
      let v = 0, s = 0, b
      do { if (s > 49) throw new Error('varuint too long'); b = r.byte(); v += (b & 0x7f) * 2 ** s; s += 7 } while (b & 0x80)
      return v
    },
    varbytes: (max = 8192) => { const n = r.varuint(); if (n > max) throw new Error('field too long'); return r.bytes(n) },
    done: () => i === buf.length
  }
  return r
}

function varuint (n) {
  const out = []
  do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b) } while (n)
  return Buffer.from(out)
}
const varbytes = (b) => Buffer.concat([varuint(b.length), b])

/** Parse a timestamp tree for `msg`: { msg, items: [{ att, payload } | { op, arg, child }] }. */
export function parseTimestamp (r, msg, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('proof is too deep')
  const node = { msg, items: [] }
  const item = (tag) => {
    if (tag === 0x00) { node.items.push({ att: r.bytes(8).toString('hex'), payload: r.varbytes() }); return }
    let next, arg = null
    if (UNARY_OPS[tag]) next = crypto.createHash(UNARY_OPS[tag]).update(msg).digest()
    else if (BINARY_OPS[tag]) { arg = r.varbytes(4096); next = tag === 0xf0 ? Buffer.concat([msg, arg]) : Buffer.concat([arg, msg]) }
    else throw new Error(`unknown operation 0x${tag.toString(16)}`)
    node.items.push({ op: tag, arg, child: parseTimestamp(r, next, depth + 1) })
  }
  let tag = r.byte()
  while (tag === 0xff) { item(r.byte()); tag = r.byte() }
  item(tag)
  return node
}

function writeTimestamp (node, parts) {
  node.items.forEach((it, k) => {
    if (k < node.items.length - 1) parts.push(Buffer.from([0xff]))
    if (it.att) { parts.push(Buffer.from([0x00]), Buffer.from(it.att, 'hex'), varbytes(it.payload)); return }
    parts.push(Buffer.from([it.op]))
    if (it.arg) parts.push(varbytes(it.arg))
    writeTimestamp(it.child, parts)
  })
  return parts
}

/** A detached proof: { digest, root } (SHA-256 files only, as we write them). */
export function parseProof (bytes) {
  if (bytes.length > MAX_PROOF_BYTES) throw new Error('proof is too large')
  const r = reader(bytes)
  if (!r.bytes(OTS_MAGIC.length).equals(OTS_MAGIC)) throw new Error('not an OpenTimestamps proof')
  if (r.varuint() !== OTS_VERSION) throw new Error('unknown proof version')
  if (r.byte() !== OP_SHA256) throw new Error('not a SHA-256 proof')
  const digest = Buffer.from(r.bytes(32))
  const root = parseTimestamp(r, digest)
  if (!r.done()) throw new Error('trailing bytes after the proof')
  return { digest, root }
}

export const serializeProof = ({ digest, root }) => Buffer.concat([OTS_MAGIC, Buffer.from([OTS_VERSION, OP_SHA256]), digest, ...writeTimestamp(root, [])])

/** Every attestation of a tree: { node, item, msg, kind: 'pending'|'bitcoin'|'other', uri?, height? }. */
export function attestations (node, out = []) {
  for (const it of node.items) {
    if (!it.att) { attestations(it.child, out); continue }
    const a = { node, item: it, msg: node.msg, kind: 'other' }
    try {
      const p = reader(it.payload)
      if (it.att === ATT_PENDING) Object.assign(a, { kind: 'pending', uri: p.varbytes(1000).toString('utf8') })
      else if (it.att === ATT_BITCOIN) Object.assign(a, { kind: 'bitcoin', height: p.varuint() })
    } catch (_) {}
    out.push(a)
  }
  return out
}

/** Only the public OpenTimestamps calendars, by their bare https origin: the unit talks to nothing else. */
export function calendarUrl (uri) {
  let u
  try { u = new URL(uri) } catch (_) { return null }
  if (u.protocol !== 'https:' || u.origin !== uri || !u.hostname.endsWith('.opentimestamps.org')) return null
  return u.origin
}

/**
 * Complete a proof: for each pending attestation, ask its calendar for the rest of the path. Returns
 * { state: 'complete'|'upgraded'|'pending', bytes?, height?, errors }. bytes is set only when it changed.
 */
export async function upgradeProof (bytes, { fetchImpl = fetch } = {}) {
  const proof = parseProof(bytes)
  const atts = attestations(proof.root)
  const done = atts.find((a) => a.kind === 'bitcoin')
  if (done) return { state: 'complete', height: done.height, errors: [] }
  const errors = []
  let changed = false
  for (const a of atts.filter((x) => x.kind === 'pending')) {
    const cal = calendarUrl(a.uri)
    if (!cal) { errors.push('calendar not allowed: ' + String(a.uri).slice(0, 80)); continue }
    try {
      const r = await fetchImpl(`${cal}/timestamp/${a.msg.toString('hex')}`, { headers: { accept: 'application/vnd.opentimestamps.v1' }, signal: AbortSignal.timeout(10_000) })
      if (r.status === 404) continue // not in a block yet
      if (!r.ok) throw new Error(`calendar answered ${r.status}`)
      const body = Buffer.from(await r.arrayBuffer())
      if (!body.length || body.length > MAX_PROOF_BYTES) throw new Error('calendar answer has an unexpected size')
      const rr = reader(body)
      const sub = parseTimestamp(rr, a.msg)
      if (!rr.done()) throw new Error('trailing bytes in the calendar answer')
      if (!attestations(sub).some((x) => x.kind === 'bitcoin')) continue
      a.node.items.push(...sub.items) // beside the pending attestation, as `ots upgrade` merges: the calendar route stays
      changed = true
    } catch (e) { errors.push(String(e && e.message || e).slice(0, 120)) }
  }
  if (!changed) return { state: 'pending', errors }
  const out = serializeProof(proof)
  const again = parseProof(out) // what we write must read back, with the same digest
  const btc = attestations(again.root).find((x) => x.kind === 'bitcoin')
  if (!again.digest.equals(proof.digest) || !btc) throw new Error('upgraded proof does not read back')
  return { state: 'upgraded', bytes: out, height: btc.height, errors }
}

// --- Checking a Bitcoin attestation against Bitcoin ---
//
// A completed proof ends at the merkle root of a block, and says which height. Both come from the calendar, so on
// their own they are a claim. These are the places we ask what root that block really has, and they are deliberately
// not calendars and not each other's operator. Two must agree before a proof is called verified; one disagreeing is
// an alarm, not a retry, because a wrong root means either a forged proof or a manifest that no longer matches.
export const HEADER_SOURCES = Object.freeze([
  { name: 'mempool.space', id: (h) => `https://mempool.space/api/block-height/${h}`, block: (id) => `https://mempool.space/api/block/${id}` },
  { name: 'blockstream.info', id: (h) => `https://blockstream.info/api/block-height/${h}`, block: (id) => `https://blockstream.info/api/block/${id}` },
])
const HEX64 = /^[0-9a-f]{64}$/

/** The merkle root each source reports for a height: [{ source, merkle_root }], a source that fails simply absent. */
export async function blockMerkleRoots (height, { fetchImpl = fetch, sources = HEADER_SOURCES, timeoutMs = 15_000 } = {}) {
  const out = []
  for (const s of sources) {
    try {
      const idRes = await fetchImpl(s.id(height), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
      if (!idRes.ok) throw new Error('height ' + idRes.status)
      const id = (await idRes.text()).trim()
      if (!HEX64.test(id)) throw new Error('not a block id')
      const bRes = await fetchImpl(s.block(id), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
      if (!bRes.ok) throw new Error('block ' + bRes.status)
      const b = await bRes.json()
      const root = String(b && b.merkle_root || '').toLowerCase()
      if (!HEX64.test(root)) throw new Error('no merkle root')
      out.push({ source: s.name, block_id: id, merkle_root: root })
    } catch (_) { /* a source that will not answer is not evidence either way */ }
  }
  return out
}

/**
 * For every proof of the given days that claims a Bitcoin block, ask the sources what that block's merkle root is and
 * write what came back to `btc-check-<day>.json`. Returns one row per proof looked at:
 * { day, file, height, merkle_root, agreed: string[], disagreed: [{source, merkle_root}] }.
 */
export async function checkBitcoin ({ outDir, days = UPGRADE_DAYS, fetchImpl = fetch, now = () => Date.now(), sources = HEADER_SOURCES, log = console.log }) {
  const today = new Date(now()).toISOString().slice(0, 10)
  const since = new Date(now() - days * 864e5).toISOString().slice(0, 10)
  const rows = []
  for (const day of anchorDays(outDir)) {
    if (day < since || day > today) continue
    const a = anchorFor(outDir, day)
    if (!a) continue
    const todo = a.proofs.filter((p) => p.state === 'bitcoin-claimed')
    if (!todo.length) continue
    const checks = []
    try { const c = JSON.parse(fs.readFileSync(path.join(outDir, `btc-check-${day}.json`), 'utf8')); if (Array.isArray(c.checks)) checks.push(...c.checks) } catch (_) {}
    let changed = false
    for (const p of todo) {
      const found = await blockMerkleRoots(p.bitcoin_block, { fetchImpl, sources })
      const agreed = found.filter((f) => f.merkle_root === p.bitcoin_merkle_root).map((f) => f.source)
      const disagreed = found.filter((f) => f.merkle_root !== p.bitcoin_merkle_root)
      rows.push({ day, file: p.file, height: p.bitcoin_block, merkle_root: p.bitcoin_merkle_root, agreed, disagreed })
      if (agreed.length >= 2 && !disagreed.length) {
        checks.push({ file: p.file, height: p.bitcoin_block, merkle_root: p.bitcoin_merkle_root, agreed, checked_at: new Date(now()).toISOString() })
        changed = true
      }
    }
    if (changed) {
      const file = path.join(outDir, `btc-check-${day}.json`)
      const tmp = file + '.tmp-' + process.pid
      fs.writeFileSync(tmp, JSON.stringify({ _schema: 'proofofstock-anchor-btc-check/1', day, note: 'For each OpenTimestamps proof of this day that names a Bitcoin block, the merkle root its path ends at, and the sources that confirmed the block at that height really has it. Anyone can repeat this with one request to any block explorer.', checks }, null, 2) + String.fromCharCode(10))
      fs.chmodSync(tmp, 0o644)
      fs.renameSync(tmp, file)
    }
  }
  if (rows.length) log('[anchor] bitcoin ' + JSON.stringify(rows.map((r) => ({ day: r.day, height: r.height, agreed: r.agreed, disagreed: r.disagreed.map((d) => d.source) }))))
  return rows
}

/** Complete the pending proofs of the last `days` days in `outDir`, in place (atomically). */
export async function upgradeDir ({ outDir, fetchImpl = fetch, now = () => Date.now(), days = UPGRADE_DAYS, staleDays = STALE_DAYS, log = console.log }) {
  const today = new Date(now()).toISOString().slice(0, 10)
  const since = new Date(now() - days * 864e5).toISOString().slice(0, 10)
  const staleBefore = new Date(now() - staleDays * 864e5).toISOString().slice(0, 10)
  let names = []
  try { names = fs.readdirSync(outDir).filter((n) => PROOF_FILE_RE.test(n)).sort() } catch (_) {}
  const results = []
  for (const name of names) {
    const day = name.match(PROOF_FILE_RE)[1]
    if (day > today) continue
    const file = path.join(outDir, name)
    let res
    // Past the window we stop asking the calendar, but we never stop looking: a proof that never completed is a hole
    // in the archive, and the alert used to go quiet on day eight simply because the hole had got old (audit, 14.11).
    if (day < since) {
      try {
        const old = parseProof(fs.readFileSync(file))
        res = { state: attestations(old.root).some((a) => a.kind === 'bitcoin') ? 'complete' : 'pending', errors: [] }
      } catch (e) { res = { state: 'failed', errors: [String(e && e.message || e).slice(0, 120)] } }
      // Past the window a proof is still looked at, and so is the check behind its Bitcoin block: a day whose claimed
      // block nobody ever compared with a real block header is a hole, however old it is (review, 14.11).
      const claimedButUnchecked = res.state === 'complete' && !checkedBlocks(outDir, day).includes(name)
      results.push({ file: name, ...res, stale: res.state !== 'complete' || claimedButUnchecked, past_window: true, unchecked: claimedButUnchecked || undefined })
      continue
    }
    try {
      res = await upgradeProof(fs.readFileSync(file), { fetchImpl })
      if (res.bytes) {
        const tmp = file + '.tmp-' + process.pid
        try { fs.writeFileSync(tmp, res.bytes); fs.chmodSync(tmp, 0o644); fs.renameSync(tmp, file) } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
      }
    } catch (e) { res = { state: 'failed', errors: [String(e && e.message || e).slice(0, 120)] } }
    const { bytes, ...shown } = res
    results.push({ file: name, ...shown, stale: res.state !== 'complete' && res.state !== 'upgraded' && day < staleBefore })
  }
  log('[anchor] upgrade ' + JSON.stringify(results))
  return results
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const day = arg('day') || new Date(Date.now() - 864e5).toISOString().slice(0, 10)
  const roots = { base: dataRoot('base'), robinhood: dataRoot('robinhood') }
  const outDir = arg('out') || process.env.STP_ANCHOR_DIR || '/var/lib/stp-anchors'
  let res
  try {
    res = await anchorDay({ roots, outDir, day })
  } catch (e) {
    // A day still being written is not a failure, it is "not yet": exit 75 (EX_TEMPFAIL), which the unit retries
    // without raising an alert, unlike exit 1.
    if (e instanceof NotSettled) { console.log('[anchor] not yet: ' + e.message); process.exit(75) }
    throw e
  }
  // Every calendar failing is a failure of the unit (and an alert); one is enough to anchor the day.
  if (!res.proofs.some((p) => p.state !== 'failed')) process.exitCode = 1
  // A day in the window whose manifest exists but holds no proof at all is stamped again: without this, a day that
  // lost both calendars on its own night was never attempted again (audit, 14.11).
  for (const d of anchorDays(outDir).slice(0, UPGRADE_DAYS + 1)) {
    if (d === day) continue
    const a = anchorFor(outDir, d)
    if (a && !a.proofs.length) {
      try { await anchorDay({ roots, outDir, day: d }) } catch (e) { console.log('[anchor] restamp ' + d + ' failed: ' + String(e && e.message || e).slice(0, 120)) }
      process.exitCode = 1
    }
  }
  // A day whose proofs are all still pending after STALE_DAYS is an alert too (one completed proof is enough).
  const up = await upgradeDir({ outDir })
  const byDay = {}
  for (const p of up) (byDay[p.file.slice(9, 19)] ||= []).push(p)
  if (Object.values(byDay).some((ps) => ps.every((p) => p.stale))) process.exitCode = 1
  // And what the proofs claim about Bitcoin is compared with what Bitcoin says. A root that does not match is not a
  // retry: it means either a forged proof or a manifest that is no longer the one that was stamped.
  const btc = await checkBitcoin({ outDir })
  if (btc.some((r) => r.disagreed.length)) process.exitCode = 1
}
