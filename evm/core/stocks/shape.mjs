// evm/core/stocks/shape.mjs: the shape of a third party's answer, so a change of format is noticed the day it happens.
//
// A reader throws when a field it needs is missing; it says nothing when a field is added, renamed beside the old one,
// or changes type in a field it does not read. Those are the first signs of a format change (owner, 12.11: "how do we
// know when the registry changes?"). The shape is every path in the answer with the JSON types seen there, array items
// merged into one `[]` step, cut at a depth, plus the size of the top arrays.
//
// The recorder keeps the last shape per source (<root>/stock-peg/shapes.json) and writes what changed into its run row;
// scripts/stocks/health-check.mjs turns a change into a message to the owner.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** { paths: { "tokens[].symbol": ["string"], ... }, sizes: { "tokens": 338 } } */
export function shapeOf (body, { maxDepth = 4 } = {}) {
  const paths = {}, sizes = {}
  const add = (p, t) => { const s = (paths[p] ||= []); if (!s.includes(t)) s.push(t) }
  const walk = (v, p, depth) => {
    const t = typeOf(v)
    add(p || '$', t)
    if (depth >= maxDepth) return
    if (t === 'array') { if (depth <= 1) sizes[p || '$'] = v.length; for (const x of v) walk(x, (p || '$') + '[]', depth + 1) } else if (t === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, depth + 1)
  }
  walk(body, '', 0)
  for (const k of Object.keys(paths)) paths[k].sort()
  return { paths, sizes }
}

/** Merge several answers of one source (pages, or one per token) into one shape. */
export function mergeShapes (shapes) {
  const paths = {}, sizes = {}
  for (const s of shapes) {
    for (const [p, ts] of Object.entries(s.paths)) { const a = (paths[p] ||= []); for (const t of ts) if (!a.includes(t)) a.push(t) }
    for (const [p, n] of Object.entries(s.sizes)) sizes[p] = (sizes[p] || 0) + n
  }
  for (const k of Object.keys(paths)) paths[k].sort()
  return { paths, sizes }
}

/**
 * What changed from `before` to `after`, in words, or [] when nothing did. A path seen before but not now is reported
 * only when `complete` (the source answered in full), since a run that read fewer records may simply not have met it.
 * A top-level list that shrank by more than `shrink` (default 10%) is reported too: a list read short looks like a change.
 */
export function shapeChanges (before, after, { complete = true, shrink = 0.1 } = {}) {
  if (!before) return []
  const out = []
  for (const [p, ts] of Object.entries(after.paths)) {
    const was = before.paths[p]
    if (!was) out.push(`new field ${p} (${ts.join('|')})`)
    else if (ts.some((t) => !was.includes(t))) out.push(`${p} is now ${ts.join('|')}, was ${was.join('|')}`)
  }
  if (complete) for (const p of Object.keys(before.paths)) if (!after.paths[p]) out.push(`field ${p} is gone`)
  for (const [p, n] of Object.entries(before.sizes || {})) {
    const m = after.sizes?.[p]
    if (m != null && n > 0 && (n - m) / n > shrink) out.push(`${p} shrank from ${n} to ${m}`)
  }
  return out
}
