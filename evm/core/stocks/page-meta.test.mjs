// evm/core/stocks/page-meta.test.mjs — a shared link previews what it points at, every value escaped; the chart series
// is thinned to a bound, keeps the newest point and labels each point's market session.
//
// Run: node evm/core/stocks/page-meta.test.mjs

import { metaFor, injectMeta, escapeHtml, SITE_TITLE } from './page-meta.mjs'
import { seriesPoints } from './readings-window.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const PAGE = '<html><head><title>Stock Token Passport</title><meta name="description" content="x">\n  <!--og-->\n</head></html>'

console.log('link previews')
{
  const m = metaFor({ chain: 'base', record: { symbol: 'NVDAc', name: 'NVIDIA', issuer: 'coinbase' }, latest: { premium: 0.006 } })
  check('a registry token link names the token, the chain and the premium', /^NVDAc \(NVIDIA\) on Base: \+0\.60% vs the issuer's reference/.test(m.title), m.title)
  check('...and says it is not advice', /Not advice/.test(m.description))
  const rh = metaFor({ chain: 'robinhood', record: { symbol: 'NVDA', name: 'NVIDIA  Robinhood Token', issuer: 'robinhood' }, latest: { premium: null } })
  check('the issuer suffix is dropped from the name, and a missing premium is not invented', /^NVDA \(NVIDIA\) on Robinhood Chain: issuer reference and on-chain price/.test(rh.title), rh.title)
  const imp = metaFor({ chain: 'base', impostor: { symbol: 'NVDAc', kind: 'registry_symbol', registry_symbol: 'NVDAc' } })
  check('an impostor link says it is not the issuer token', /is not the issuer's NVDAc/.test(imp.title))
  const naming = metaFor({ chain: 'robinhood', impostor: { symbol: 'dETH', kind: 'issuer_name_suffix', registry_symbol: null, ticker: null } })
  check('an impostor copying only the issuer naming says so, without inventing a target', /^dETH on Robinhood Chain copies the issuer's naming but is not its token/.test(naming.title), naming.title)
  check('a link to nothing in particular is the site', metaFor({}).title === SITE_TITLE)

  const evil = injectMeta(PAGE, { title: '"><script>alert(1)</script>', description: 'a & b' }, 'https://x/?a=1&b=2')
  check('the title and tags are escaped', !evil.includes('<script>') && evil.includes('&lt;script&gt;') && evil.includes('a &amp; b') && evil.includes('a=1&amp;b=2'))
  check('the preview tags are filled once', (evil.match(/property="og:title"/g) || []).length === 1 && !evil.includes('<!--og-->'))
  check('the twitter card is there', evil.includes('name="twitter:card" content="summary"'))
  check('escapeHtml covers quotes', escapeHtml(`'"`) === '&#39;&quot;')
}

console.log('chart series')
{
  const t0 = Date.parse('2026-11-06T14:00:00Z') // Friday 09:00 New York, pre-market
  const points = Array.from({ length: 1000 }, (_, i) => [t0 + i * 15 * 60e3, i % 7 === 0 ? null : i / 1e4])
  const s = seriesPoints({ points }, 400)
  check('thinned to the bound (plus the newest)', s.length <= 401 && s.length >= 300, String(s.length))
  check('the newest point is kept', s[s.length - 1][0] === points[points.length - 1][0])
  check('a missing premium stays missing', s.some((p) => p[1] === null))
  check('each point carries its session', s.every((p) => ['r', 'e', 'c', 'u'].includes(p[2])) && s[0][2] === 'e' && s.some((p) => p[2] === 'r') && s.some((p) => p[2] === 'c'))
  check('an empty entry is an empty series', seriesPoints(null).length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
