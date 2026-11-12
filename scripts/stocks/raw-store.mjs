// scripts/stocks/raw-store.mjs: short-lived private copies of the aggregators' (DexScreener, GeckoTerminal) answers,
// kept only for our own error checking. Not published, not resold, and not evidence of anything: publicly a price an
// aggregator alone gave carries `price_evidence: { evidence: "none" }` and nothing else, no hash and no flag.
//
// ⚠ OFF UNLESS STP_RAW_SNAPSHOTS=1. Until the aggregators' terms on private retention have been read, nothing is kept.
// When on:
//   - only the answers behind a reading with a premium are kept (the caller decides), gzipped, one gzip member per line,
//     in <STP_RAW_DIR or /var/lib/stp-raw>/<chain>/raw-YYYY-MM-DD.jsonl.gz, each line { run_id, token_address, source,
//     url, fetched_at, sha256, body }: the hash lives here and nowhere else;
//   - the directory sits OUTSIDE /var/lib/stp, so the dataset's backups do not copy it and deleting it deletes it;
//     directories 0700, files 0600, owned by the recorder's user; the web unit cannot see the path at all
//     (deployment/systemd/stp-web.service InaccessiblePaths) and no route reads it (apps/stocks-web.test.mjs);
//   - files older than RAW_KEEP_DAYS are deleted at the start of each run, except those moved into <chain>/pinned/
//     (a copy tied to an open dispute, kept until it closes and then deleted by hand);
//   - writing stops when the store holds STP_RAW_MAX_BYTES (default 2 GiB), and is reported in the journal.
// A copy that cannot be written is logged and never costs the reading.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

export const RAW_KEEP_DAYS = 30
export const RAW_DEFAULT_DIR = '/var/lib/stp-raw'
export const RAW_DEFAULT_MAX_BYTES = 2 * 1024 ** 3
const FILE = /^raw-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/

/** Reads a fetch Response's body once, as bytes: { source, url, fetched_at, sha256, body }. */
export async function snapshotOf (source, url, response, at = Date.now()) {
  const buf = Buffer.from(await response.arrayBuffer())
  return { source, url, fetched_at: new Date(at).toISOString(), sha256: crypto.createHash('sha256').update(buf).digest('hex'), body: buf.toString('utf8') }
}

function sizeOf (dir) {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    n += e.isDirectory() ? sizeOf(p) : fs.statSync(p).size
  }
  return n
}

/**
 * The store for one chain and one run. Never throws: `{ on: false }` when off or unusable, with `error` when it should
 * have been on. `keep(...)` returns how many answers it wrote (0 when off, full or failing).
 */
export function openRawStore ({ chain, env = process.env, now = Date.now, log = () => {} }) {
  const off = (error = null) => ({ on: false, error, bytes: 0, written: 0, skipped_full: 0, keep: () => 0 })
  if (env.STP_RAW_SNAPSHOTS !== '1') return off()
  const max = Number(env.STP_RAW_MAX_BYTES) > 0 ? Number(env.STP_RAW_MAX_BYTES) : RAW_DEFAULT_MAX_BYTES
  const base = env.STP_RAW_DIR || RAW_DEFAULT_DIR
  const dir = path.join(base, chain)
  let size = 0, pruned = 0
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(base, 0o700); fs.chmodSync(dir, 0o700)
    const cutoff = new Date(now() - RAW_KEEP_DAYS * 86400e3).toISOString().slice(0, 10)
    for (const f of fs.readdirSync(dir)) {
      const m = FILE.exec(f)
      if (m && m[1] < cutoff) { fs.unlinkSync(path.join(dir, f)); pruned++ }
    }
    size = sizeOf(base)
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 200)
    log('[stock-peg] raw store unusable, nothing kept this run: ' + msg)
    return off(msg)
  }
  const store = {
    on: true, error: null, dir, max, pruned, bytes: size, written: 0, skipped_full: 0,
    keep (day, runId, token, snaps) {
      if (!snaps.length) return 0
      if (store.bytes >= max) { store.skipped_full += snaps.length; return 0 }
      try {
        const gz = zlib.gzipSync(snaps.map((s) => JSON.stringify({ run_id: runId, token_address: token, source: s.source, url: s.url, fetched_at: s.fetched_at, sha256: s.sha256, body: s.body }) + '\n').join(''))
        const f = path.join(dir, `raw-${day}.jsonl.gz`)
        fs.appendFileSync(f, gz, { mode: 0o600 })
        fs.chmodSync(f, 0o600)
        store.bytes += gz.length; store.written += snaps.length
        return snaps.length
      } catch (e) { log('[stock-peg] raw copy not kept: ' + String(e && e.message || e).slice(0, 200)); return 0 }
    },
  }
  return store
}
