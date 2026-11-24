// apps/stocks-glama.mjs: the Glama score badge of our MCP connector, shown in the landing's footer from OUR origin.
//
// The page loads nothing from a third party (docs/legal.md, the CSP's img-src 'self'), so a visitor's browser never
// asks glama.ai for the picture. The server fetches it instead, at most once an hour, and serves the last good copy at
// /glama-badge.svg. A badge that cannot be read is left out of the footer rather than shown broken.
//
// ⚠ AN SVG FROM SOMEBODY ELSE, SERVED FROM OUR ORIGIN. Opened on its own, an SVG is a document: a script or an event
// handler inside it would run as us. So the file is checked against what a badge needs and nothing more: shapes, text,
// gradients, clip paths, and links only to its own parts (href="#..."). Anything else (a script, a foreignObject, a
// style element, an on* handler, a link out, a DOCTYPE or entity, a processing instruction) refuses the whole file and
// the last good copy stays. It is served with its own CSP that allows no script either way.
export const GLAMA_PAGE_URL = 'https://glama.ai/mcp/connectors/xyz.proofofstock/proof-of-stock'
export const GLAMA_BADGE_URL = GLAMA_PAGE_URL + '/badges/score.svg'
export const GLAMA_BADGE_PATH = '/glama-badge.svg'
export const GLAMA_EVERY_MS = 60 * 60e3
export const GLAMA_MAX_BYTES = 16 * 1024
// The CSP the badge itself is served with: inline presentation only, nothing fetched, nothing run.
export const GLAMA_BADGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"

const ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'defs', 'use', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop', 'symbol'])

/** The badge text if it is a plain badge, else null with the reason in `why` (for the journal). */
export function checkBadgeSvg (text) {
  const why = (r) => ({ ok: false, why: r })
  if (typeof text !== 'string' || !text.trim()) return why('empty')
  const s = text.trim()
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>$/i.test(s)) return why('not a single svg element')
  if (/<[!?]/.test(s)) return why('a DOCTYPE, entity, comment or processing instruction')
  for (const m of s.matchAll(/<\/?\s*([a-zA-Z][\w:.-]*)/g)) if (!ELEMENTS.has(m[1].toLowerCase())) return why(`element ${m[1].slice(0, 30)}`)
  if (/\son[a-z]+\s*=/i.test(s)) return why('an event handler')
  // Every link stays inside the file, under any namespace prefix (x:href is xlink:href if x names that namespace). An
  // attribute value may not reach out either (url(...) to anything but #id). A backslash is refused outright: CSS
  // escapes (u\72l() and character references spell url( and href without the letters the checks look for, and a
  // badge has no use for either (outside review, 24.11).
  if (/[\\]|&#|image-set/i.test(s)) return why('an escape, a character reference or image-set')
  for (const m of s.matchAll(/(?:^|\s)(?:[\w.-]+:)?href\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]*)/gi)) if (!/^#[\w.-]+$/.test(m[2] ?? m[3] ?? m[1])) return why('a link out of the file')
  for (const m of s.matchAll(/url\(\s*['"]?([^)'"]*)/gi)) if (!/^#[\w.-]+$/.test(m[1])) return why('a url() out of the file')
  if (/javascript:|data:text|@import/i.test(s)) return why('a script or import url')
  return { ok: true, svg: s }
}

async function readCapped (res, max) {
  const len = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(len) && len > max) throw new Error(`badge too large (${len} bytes)`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > max) throw new Error(`badge too large (${buf.length} bytes)`)
  return buf.toString('utf8')
}

/** The badge as the footer shows it: refreshed in the background, read from memory. `url: null` turns it off. */
export function createGlamaBadge ({ fetchImpl = fetch, now = () => Date.now(), url = GLAMA_BADGE_URL, everyMs = GLAMA_EVERY_MS, maxBytes = GLAMA_MAX_BYTES, log = () => {} } = {}) {
  let svg = null // the last good copy; a failed read keeps it
  let tried = -Infinity, inFlight = null
  async function load () {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { accept: 'image/svg+xml', 'user-agent': 'proofofstock-site' } })
      if (res.status !== 200) throw new Error(`badge HTTP ${res.status}`)
      if (!/^image\/svg\+xml\b/i.test(res.headers?.get?.('content-type') || '')) throw new Error('badge is not image/svg+xml')
      const c = checkBadgeSvg(await readCapped(res, maxBytes))
      if (!c.ok) throw new Error(`badge refused: ${c.why}`)
      svg = c.svg
    } catch (e) {
      log(`[glama] ${String(e && e.message || e).slice(0, 200)}`)
    }
  }
  return {
    refresh (force = false) {
      if (!url) return Promise.resolve()
      if (inFlight) return inFlight
      if (!force && now() - tried < everyMs) return Promise.resolve()
      tried = now()
      inFlight = load().finally(() => { inFlight = null })
      return inFlight
    },
    /** The badge, or null while none has been read. */
    get () { return svg },
  }
}

/** Ours, shown while no copy has been read: a plain chip, so the footer never shows a broken image. */
export const GLAMA_FALLBACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="110" height="20" viewBox="0 0 110 20"><title>Proof of Stock MCP connector on Glama</title><rect width="110" height="20" rx="2" fill="#1b2026"/><text x="55" y="14" fill="#9aa4ae" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle">Glama</text></svg>'

/** The footer's link: the picture from our origin, linking to the connector's page on Glama. */
export const glamaFooterHtml = (path) => `<a class="foot-glama" href="${GLAMA_PAGE_URL}" target="_blank" rel="noopener noreferrer" title="Tool definition quality and endpoint health of our MCP connector, scored by Glama"><img src="${path}" width="110" height="20" alt="Proof of Stock MCP connector score on Glama"></a>`
