// apps/glama-badge.test.mjs: the Glama badge in the landing's footer (apps/stocks-glama.mjs, 24.11). Somebody else's
// SVG served from our origin, so what is held here is the filter: a plain badge passes, anything that could run, load
// or link out refuses the whole file, a failed read keeps the last good copy, and the server asks at most hourly.
//
// Run: node apps/glama-badge.test.mjs
import { checkBadgeSvg, createGlamaBadge, glamaFooterHtml, GLAMA_BADGE_CSP, GLAMA_BADGE_URL, GLAMA_FALLBACK_SVG, GLAMA_PAGE_URL } from './stocks-glama.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

// Shaped like the badge Glama serves: shapes, a clip path, uses of its own parts, a title and a description.
const BADGE = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="110" height="20" viewBox="0 0 110 20"><title>Proof of Stock MCP connector rated A on Glama</title><desc>Glama score badge</desc>' +
  '<defs><clipPath id="c"><rect width="110" height="20" rx="2"/></clipPath><path id="g0" d="M0 0h4v4H0Z"/></defs>' +
  '<g clip-path="url(#c)"><path d="M2 0h106v20H2Z" fill="#111"/><use href="#g0" x="10"/><use xlink:href="#g0" x="20"/><text x="30" y="14">A</text></g></svg>'

console.log('the filter')
check('a plain badge passes, as it came', checkBadgeSvg(BADGE).ok && checkBadgeSvg(BADGE).svg === BADGE)
check('our own fallback passes the same filter', checkBadgeSvg(GLAMA_FALLBACK_SVG).ok)
const bad = {
  'a script element': BADGE.replace('</g>', '</g><script>alert(1)</script>'),
  'an event handler': BADGE.replace('<rect ', '<rect onload="alert(1)" '),
  'an event handler in capitals': BADGE.replace('<rect ', '<rect ONMOUSEOVER = "x" '),
  'a foreignObject': BADGE.replace('</g>', '</g><foreignObject><div/></foreignObject>'),
  'a style element': BADGE.replace('<defs>', '<style>@import "https://x.example/a.css";</style><defs>'),
  'a link out by href': BADGE.replace('href="#g0"', 'href="https://x.example/a.svg#g0"'),
  'a link out by xlink:href': BADGE.replace('xlink:href="#g0"', 'xlink:href="javascript:alert(1)"'),
  'a url() out of the file': BADGE.replace('url(#c)', 'url(https://x.example/c)'),
  'an image element': BADGE.replace('</g>', '</g><image href="#g0"/>'),
  'a DOCTYPE with an entity': '<!DOCTYPE svg [<!ENTITY x "y">]>' + BADGE,
  'a markup declaration inside the svg': BADGE.replace('<defs>', '<![CDATA[x]]><defs>'),
  'an anchor element': BADGE.replace('<text', '<a href="#g0"><text').replace('</text>', '</text></a>'),
  'two documents glued together': BADGE + BADGE.replace('<title>', '<script>1</script><title>'),
  'not an svg at all': '<html><body>hi</body></html>',
  'a link out under another namespace prefix': BADGE.replace('<use href="#g0" x="10"/>', '<use xmlns:x="http://www.w3.org/1999/xlink" x:href="https://x.example/a.svg#g0" x="10"/>'),
  'an unquoted link out': BADGE.replace('href="#g0"', 'href=https://x.example/a.svg#g0'),
  'a CSS-escaped url(': BADGE.replace('<rect ', '<rect style="fill:u\\72l(https://x.example/a)" '),
  'a character reference': BADGE.replace('<title>', '<title>&#106;avascript'),
  'image-set in a style': BADGE.replace('<rect ', '<rect style="fill:image-set(\'https://x.example/a\' 1x)" '),
  'nothing': '',
}
for (const [what, s] of Object.entries(bad)) check(`refused: ${what}`, !checkBadgeSvg(s).ok, checkBadgeSvg(s).why)

console.log('the cache')
{
  let t = Date.parse('2026-11-24T12:00:00Z'), calls = 0, answer = null
  const res = (status, body, type = 'image/svg+xml') => ({ status, headers: { get: (k) => (k === 'content-type' ? type : null) }, arrayBuffer: async () => Buffer.from(body) })
  const fetchImpl = async (u, o) => { calls++; if (u !== GLAMA_BADGE_URL || o.redirect !== 'error') throw new Error('asked the wrong place'); return answer() }
  const said = []
  const g = createGlamaBadge({ fetchImpl, now: () => t, log: (m) => said.push(m) })
  check('nothing is shown before the first read', g.get() === null)
  answer = () => res(200, BADGE)
  await g.refresh()
  check('a good read is kept and served', g.get() === BADGE && calls === 1)
  await g.refresh()
  check('...and the server asks again only after an hour', calls === 1)
  t += 60 * 60e3 + 1
  answer = () => res(200, BADGE.replace('<rect ', '<rect onload="x" '))
  await g.refresh()
  check('a refused read keeps the last good copy, and says why in the journal', g.get() === BADGE && calls === 2 && said.some((m) => /refused: an event handler/.test(m)), said.join(' | '))
  t += 60 * 60e3 + 1
  answer = () => res(200, BADGE, 'text/html')
  await g.refresh()
  check('a read that is not image/svg+xml is refused', g.get() === BADGE && said.some((m) => /not image\/svg\+xml/.test(m)))
  t += 60 * 60e3 + 1
  answer = () => res(200, BADGE.replace('</g>', '</g>' + '<path d="M0 0"/>'.repeat(2000)))
  await g.refresh()
  check('a read past the size cap is refused', g.get() === BADGE && said.some((m) => /too large/.test(m)))
  t += 60 * 60e3 + 1
  answer = () => res(503, '')
  await g.refresh()
  check('an error status keeps the last good copy too', g.get() === BADGE && said.some((m) => /HTTP 503/.test(m)))
  const off = createGlamaBadge({ fetchImpl, url: null })
  const before = calls
  await off.refresh(true)
  check('url null never asks anyone', calls === before && off.get() === null)
}

console.log('what the page shows')
{
  const h = glamaFooterHtml('glama-badge.svg')
  check('the footer image comes from our origin and links to the connector page on Glama', /<img src="glama-badge\.svg"/.test(h) && h.includes(`href="${GLAMA_PAGE_URL}"`) && !/<img[^>]*glama\.ai/.test(h))
  check('...opening Glama in a new tab with no referrer and no opener', /target="_blank"/.test(h) && /rel="noopener noreferrer"/.test(h))
  check('the badge is served under a CSP that runs no script and fetches nothing', /default-src 'none'/.test(GLAMA_BADGE_CSP) && !/script-src/.test(GLAMA_BADGE_CSP) && !/https?:/.test(GLAMA_BADGE_CSP))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
