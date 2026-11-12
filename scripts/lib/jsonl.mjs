// scripts/lib/jsonl.mjs: read a JSONL day stream line by line (plain or .gz), and list a stream's day files.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'

/**
 * Call fn for every JSON object line, and return how many lines could not be read. A junk line is skipped; a torn LAST
 * line is not counted, because a writer may be appending it right now. Junk with lines after it is real damage, and a
 * reader that must know its list is whole (the impostor list closes cases on absence) treats the file as torn.
 */
export async function eachJsonl (file, fn) {
  let s = fs.createReadStream(file); if (file.endsWith('.gz')) { const src = s, z = zlib.createGunzip(); src.on('error', (e) => z.destroy(e)); s = src.pipe(z) }
  let bad = 0, pending = false
  for await (const l of readline.createInterface({ input: s, crlfDelay: Infinity })) {
    if (!l) continue
    if (pending) { bad++; pending = false }
    let o; try { o = JSON.parse(l) } catch { pending = true; continue }; if (o && typeof o === 'object') fn(o)
  }
  return bad
}
/**
 * Day files of one stream, oldest first; `days` keeps only those whose date is in the set. A missing directory is no
 * files; any other error (access, I/O) is thrown: an unreadable stream must not pass for an empty one.
 */
export function dayFiles (root, dir, prefix, days = null) {
  let names; try { names = fs.readdirSync(path.join(root, dir)) } catch (e) { if (e && e.code === 'ENOENT') return []; throw e }
  return names.filter(f => f.startsWith(prefix) && (!days || days.has(f.slice(prefix.length, prefix.length + 10)))).sort().map(f => path.join(root, dir, f))
}
