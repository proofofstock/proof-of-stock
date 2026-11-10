// evm/core/stocks/readings-window.mjs — the recent peg readings of every token on one chain, held in memory in compact
// form, so that a public request builds a passport from memory instead of scanning day files.
//
// Per token it keeps the LATEST full row (everything a passport shows about "now") and, for the window, only the
// [time, premium] points the series needs. A refresh rereads the window's day files whole; on a read error it keeps
// the last good window and says so, rather than serving an empty one as if nothing had been recorded.

import { quarantined } from './quarantine.mjs'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { usEquitySession } from './market-session.mjs'

const day = (ms) => new Date(ms).toISOString().slice(0, 10)

async function eachRow (file, fn) {
  let s = fs.createReadStream(file)
  if (file.endsWith('.gz')) s = s.pipe(zlib.createGunzip())
  for await (const l of readline.createInterface({ input: s, crlfDelay: Infinity })) {
    if (!l) continue
    let o; try { o = JSON.parse(l) } catch { continue }
    if (o && typeof o === 'object') fn(o)
  }
}

/** Read the window: Map address → { latest, points: [[ms, premium|null], …] oldest first }. */
export async function loadWindow (root, now, windowH) {
  const from = now - windowH * 3600e3
  const days = new Set(); for (let t = from - 864e5; t <= now + 864e5; t += 864e5) days.add(day(t))
  const dir = path.join(root, 'stock-peg')
  let names = []
  try { names = fs.readdirSync(dir) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const files = names.filter((f) => /^stock-peg-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f) && days.has(f.slice(10, 20))).sort()
  const byToken = new Map()
  let quarantinedRows = 0
  for (const f of files) {
    await eachRow(path.join(dir, f), (o) => {
      const t = Date.parse(o.observed_at)
      if (!o.token_address || !Number.isFinite(t) || t < from || t > now) return
      if (quarantined(o, t)) { quarantinedRows++; return }
      let e = byToken.get(o.token_address)
      if (!e) { e = { latest: null, latestAt: -Infinity, points: [] }; byToken.set(o.token_address, e) }
      e.points.push([t, typeof o.premium === 'number' ? o.premium : null])
      if (t >= e.latestAt) { e.latest = o; e.latestAt = t }
    })
  }
  for (const e of byToken.values()) e.points.sort((a, b) => a[0] - b[0])
  return { byToken, files: files.length, loaded_at: now, quarantined: quarantinedRows }
}

/** The readings buildPassport expects, rebuilt from a window entry: compact points plus the latest full row. */
export function readingsOf (entry, address) {
  if (!entry) return []
  const rows = entry.points.map(([t, premium]) => ({ token_address: address, observed_at: new Date(t).toISOString(), premium }))
  if (entry.latest) rows[rows.length - 1] = entry.latest
  return rows
}

const GROUP = Object.freeze({ regular: 'r', pre: 'e', post: 'e', closed: 'c', unknown: 'u' })

/**
 * The premium series of one token for a chart: [ms, premium|null, session] with session r(egular) / e(xtended) /
 * c(losed) / u(nknown), thinned evenly to at most `max` points (the newest is always kept).
 */
export function seriesPoints (entry, max = 400) {
  const pts = entry && Array.isArray(entry.points) ? entry.points : []
  const step = Math.max(1, Math.ceil(pts.length / max))
  const out = []
  for (let i = 0; i < pts.length; i += step) out.push(pts[i])
  if (pts.length && out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1])
  return out.map(([t, p]) => [t, p, GROUP[usEquitySession(t).session] || 'u'])
}

/**
 * A window kept fresh: `get()` answers from memory at once; `refresh()` reloads, keeping the last good window on error.
 */
export function createWindowCache ({ root, windowH, now = () => Date.now() }) {
  let held = null, error = null, refreshing = null
  async function refresh () {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try { held = await loadWindow(root, now(), windowH); error = null } catch (e) { error = String(e && e.message || e) } finally { refreshing = null }
    })()
    return refreshing
  }
  return { refresh, get: () => ({ window: held, error }) }
}
