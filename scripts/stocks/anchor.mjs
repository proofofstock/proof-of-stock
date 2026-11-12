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
//   manifest-<day>.json.<calendar>.ots        an OpenTimestamps proof per calendar (pending until Bitcoin confirms;
//                                             `ots upgrade` then `ots verify` complete and check it, anyone can)
// A manifest, once written, is never rewritten: a rerun only adds the proofs that are missing.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isEntryPoint } from '../lib/invoked-directly.mjs'

// The OpenTimestamps detached-proof header (python-opentimestamps, DetachedTimestampFile.HEADER_MAGIC), version 1.
export const OTS_MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex')
const OTS_VERSION = 0x01
const OP_SHA256 = 0x08
export const CALENDARS = Object.freeze(['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'])
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const ANCHOR_FILE_RE = /^manifest-\d{4}-\d{2}-\d{2}\.json(\.[a-z0-9-]+\.ots)?$/

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** The day's data files of every chain: name, size and SHA-256, in a stable order. Missing files are simply absent. */
export function dayFiles (roots, day) {
  if (!DAY_RE.test(day)) throw new Error('day must be YYYY-MM-DD')
  const out = []
  for (const chain of Object.keys(roots).sort()) {
    const base = path.join(roots[chain], 'stock-peg')
    for (const rel of [`stock-peg-${day}.jsonl`, `stock-peg-runs-${day}.jsonl`, `history/cases-${day}.jsonl`, `history/registry-${day}.jsonl`]) {
      let buf
      try { buf = fs.readFileSync(path.join(base, rel)) } catch (_) { continue }
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
export async function anchorDay ({ roots, outDir, day, fetchImpl = fetch, now = () => Date.now(), calendars = CALENDARS, log = console.log }) {
  fs.mkdirSync(outDir, { recursive: true })
  const mf = path.join(outDir, `manifest-${day}.json`)
  if (!fs.existsSync(mf)) {
    const files = dayFiles(roots, day)
    const manifest = { _schema: 'proofofstock-anchor-manifest/1', day, built_at: new Date(now()).toISOString(), previous: previousManifest(outDir, day), files, note: 'SHA-256 of each data file of the day, as written by the recorder and the history archive. The SHA-256 of this file is anchored in Bitcoin through OpenTimestamps.' }
    const tmp = mf + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
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
      fs.writeFileSync(out, otsFile(digest, answer))
      result.proofs.push({ calendar: cal, file: path.basename(out), state: 'stamped' })
    } catch (e) { result.proofs.push({ calendar: cal, state: 'failed', error: String(e && e.message || e).slice(0, 120) }) }
  }
  log('[anchor] ' + JSON.stringify(result))
  return result
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const day = arg('day') || new Date(Date.now() - 864e5).toISOString().slice(0, 10)
  const roots = { base: process.env.STOCKS_ROOT_BASE || '/var/lib/stp/base', robinhood: process.env.STOCKS_ROOT_ROBINHOOD || '/var/lib/stp/robinhood' }
  const res = await anchorDay({ roots, outDir: arg('out') || process.env.STP_ANCHOR_DIR || '/var/lib/stp-anchors', day })
  // Every calendar failing is a failure of the unit (and an alert); one is enough to anchor the day.
  if (!res.proofs.some((p) => p.state !== 'failed')) process.exitCode = 1
}
