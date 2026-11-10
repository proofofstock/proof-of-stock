// scripts/lib/jsonl.mjs — read a JSONL day stream line by line (plain or .gz), and list a stream's day files.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'

/** Call fn for every JSON object line; a torn or junk line is skipped. */
export async function eachJsonl (file, fn) {
  let s = fs.createReadStream(file); if (file.endsWith('.gz')) s = s.pipe(zlib.createGunzip())
  for await (const l of readline.createInterface({ input: s, crlfDelay: Infinity })) {
    if (!l) continue; let o; try { o = JSON.parse(l) } catch { continue }; if (o && typeof o === 'object') fn(o)
  }
}
/** Day files of one stream, oldest first; `days` keeps only those whose date is in the set. */
export function dayFiles (root, dir, prefix, days = null) {
  let names; try { names = fs.readdirSync(path.join(root, dir)) } catch { return [] }
  return names.filter(f => f.startsWith(prefix) && (!days || days.has(f.slice(prefix.length, prefix.length + 10)))).sort().map(f => path.join(root, dir, f))
}
