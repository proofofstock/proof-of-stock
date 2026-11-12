// evm/core/stocks/history.mjs: the passport's history (docs/stocks-truth-layer-tz.md §H): an append-only archive of
// impostor cases (H1) and snapshots of each issuer's registry whenever it changes (H2).
//
// ⚠ APPEND-ONLY. Nothing here edits or deletes a written row. A case's state is the replay of its rows, and a later
//   row that contradicts an earlier one is a new event, never a rewrite.
// ⚠ HOW EACH FACT WAS LEARNED IS ON THE ROW. `observed`: this run saw it. `backfilled`: derived later from older data
//   (the first archive of a chain, from the first_seen_at our collector recorded), never presented as a live observation.
// ⚠ DOUBT WRITES NOTHING. A case only closes as `gone` when the list that lost it was complete (no torn day file, not
//   truncated): a token missing because a file could not be read has not left the list.
//
// Files, under <root>/stock-peg/history/:
//   cases-YYYY-MM-DD.jsonl     one row per change of a case (schemas/v2/stock-case.schema.json)
//   registry-YYYY-MM-DD.jsonl  one row per change of the issuer registry (schemas/v2/stock-registry-snapshot.schema.json)

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const HISTORY_DIR = 'history'
// v2 (11.11.2026): the symbol and name are compared after untrusted-text.mjs normalizeUntrusted() (NFKC, invisible
// characters removed), so a look-alike written with those is now a case. v1 compared the text as written.
export const CASE_RULE_VERSION = 'impostor-strong-v2' // evm/core/stocks/impostor.mjs resemblance(), strong kinds only
export const BACKFILL_SOURCE = 'first_seen_at from our collector history (static day files), archived when the case archive began'

const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const histDir = (root) => path.join(root, 'stock-peg', HISTORY_DIR)

// ⚠ An unreadable archive is not an empty one: an empty one would make the next run backfill every open case again.
function readRows (dir, prefix) {
  let names; try { names = fs.readdirSync(dir) } catch (e) { if (e && e.code === 'ENOENT') return []; throw e }
  const rows = []
  for (const f of names.filter((n) => n.startsWith(prefix) && n.endsWith('.jsonl')).sort()) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l) continue
      try { rows.push(JSON.parse(l)) } catch { /* a torn last line is skipped; the next run appends after it */ }
    }
  }
  return rows
}
function append (dir, prefix, atMs, rows) {
  if (!rows.length) return
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${prefix}${day(atMs)}.jsonl`)
  // A run killed mid-write leaves a torn last line with no newline. Appending straight after it would glue the new row
  // onto it and lose the row too; a newline first keeps the torn line apart (readRows skips it) and the new row whole.
  let lead = ''
  try {
    const fd = fs.openSync(file, 'r')
    try { const size = fs.fstatSync(fd).size; if (size > 0) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); if (b[0] !== 0x0a) lead = '\n' } } finally { fs.closeSync(fd) }
  } catch (e) { if (!e || e.code !== 'ENOENT') throw e }
  fs.appendFileSync(file, lead + rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

// ---------------------------------------------------------------------------------------------------------------- H1

/** Replay case rows into the open cases: address → the last state of a case that has not closed. */
export function replayCases (rows) {
  const open = new Map()
  for (const r of rows) {
    if (r.event === 'opened' || r.event === 'kind_changed') open.set(r.address, r)
    else if (r.event === 'listed' || r.event === 'gone') open.delete(r.address)
  }
  return open
}

const caseFields = (it) => ({ address: it.address, symbol: it.symbol ?? null, name: it.name ?? null, kind: it.kind, ticker: it.ticker ?? null,
  registry_symbol: it.registry_symbol ?? null, registry_address: it.registry_address ?? null, first_seen_at: it.first_seen_at ?? null, deployer: it.deployer ?? null })

/**
 * The events that take the archive from `open` to the list just built.
 * @param {Map} open             replayCases() of the archive so far
 * @param {object} list          buildImpostorList() output: items, torn_files, truncated
 * @param {object} p
 * @param {Set<string>} p.registry  every issuer-listed address now
 * @param {number} p.at          this run's time (ms)
 * @param {number} p.chainId
 * @param {boolean} p.firstArchive  the archive of this chain is empty: what the list holds now is backfilled
 */
export function caseEvents (open, list, { registry, at, chainId, firstArchive }) {
  const atIso = new Date(at).toISOString()
  const base = (event, source) => ({ _schema_version: '1.0', chain_id: chainId, event, at: atIso, source, rule_version: CASE_RULE_VERSION })
  const out = []
  const now = new Map(list.items.map((it) => [it.address, it]))
  for (const [a, it] of now) {
    const prev = open.get(a)
    if (!prev) {
      out.push(firstArchive
        ? { ...base('opened', 'backfilled'), ...caseFields(it), flagged_at: null, backfill_source: BACKFILL_SOURCE }
        : { ...base('opened', 'observed'), ...caseFields(it), flagged_at: atIso })
    } else if (prev.kind !== it.kind || prev.registry_address !== (it.registry_address ?? null)) {
      out.push({ ...base('kind_changed', 'observed'), ...caseFields(it), flagged_at: prev.flagged_at ?? null, previous_kind: prev.kind })
    }
  }
  const complete = !list.torn_files && !list.truncated
  for (const [a, prev] of open) {
    if (now.has(a)) continue
    // Listed by the issuer: we were wrong or early, and that is kept and counted. Checked first, and whatever the
    // list's completeness, because the registry answer stands on its own.
    if (registry.has(a)) out.push({ ...base('listed', 'observed'), ...caseFields(prev), flagged_at: prev.flagged_at ?? null })
    else if (complete) out.push({ ...base('gone', 'observed'), ...caseFields(prev), flagged_at: prev.flagged_at ?? null })
  }
  return out
}

/** H1 for one chain: read the archive, append what changed, return a summary for the journal. */
export function recordCases ({ root, list, registry, chainId, at, validate = null, log = () => {} }) {
  const dir = histDir(root)
  const rows = readRows(dir, 'cases-')
  const events = caseEvents(replayCases(rows), list, { registry, at, chainId, firstArchive: rows.length === 0 })
  const ok = []
  let invalid = 0
  for (const e of events) {
    const v = validate ? validate('stock-case', e) : { valid: true }
    if (v.valid) ok.push(e); else { invalid++; log(`[history] invalid case row ${e.address}: ${JSON.stringify(v.errors).slice(0, 300)}`) }
  }
  append(dir, 'cases-', at, ok)
  const by = {}
  for (const e of ok) by[e.event + (e.source === 'backfilled' ? ':backfilled' : '')] = (by[e.event + (e.source === 'backfilled' ? ':backfilled' : '')] || 0) + 1
  return { written: ok.length, invalid, events: by, open_before: replayCases(rows).size }
}

// ---------------------------------------------------------------------------------------------------------------- H2

/** The registry without what moves every minute (prices), sorted, so the same list hashes the same. */
export function canonicalRegistry (records) {
  return records.map((r) => ({ address: r.address, symbol: r.symbol ?? null, name: r.name ?? null, isin: r.isin ?? null,
    multiplier: r.multiplier ?? null, multiplier_pending: r.multiplier_pending ?? null, supplied: !!r.supplied,
    paused: Array.isArray(r.paused) ? r.paused.slice().sort() : [] }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
}
export const registryHash = (canon) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex')

/** What changed between two canonical lists, by address. */
export function registryDiff (prev, next) {
  const p = new Map((prev || []).map((r) => [r.address, JSON.stringify(r)]))
  const n = new Map(next.map((r) => [r.address, JSON.stringify(r)]))
  return {
    added: [...n.keys()].filter((a) => !p.has(a)),
    removed: [...p.keys()].filter((a) => !n.has(a)),
    changed: [...n.keys()].filter((a) => p.has(a) && p.get(a) !== n.get(a)),
  }
}

/** H2 for one chain: append a snapshot when the registry differs from the last one written. */
export function recordRegistry ({ root, records, chainId, issuer, at, validate = null, log = () => {} }) {
  const dir = histDir(root)
  const rows = readRows(dir, 'registry-')
  const last = rows.length ? rows[rows.length - 1] : null
  const body = canonicalRegistry(records)
  const hash = registryHash(body)
  if (last && last.hash === hash) return { written: 0, hash }
  const d = registryDiff(last ? last.body : null, body)
  const row = { _schema_version: '1.0', chain_id: chainId, issuer, fetched_at: new Date(at).toISOString(), hash, prev_hash: last ? last.hash : null,
    records: body.length, added: d.added, removed: d.removed, changed: d.changed, body }
  const v = validate ? validate('stock-registry-snapshot', row) : { valid: true }
  if (!v.valid) { log(`[history] invalid registry snapshot: ${JSON.stringify(v.errors).slice(0, 300)}`); return { written: 0, hash, invalid: 1 } }
  append(dir, 'registry-', at, [row])
  return { written: 1, hash, first: !last, added: d.added.length, removed: d.removed.length, changed: d.changed.length }
}
