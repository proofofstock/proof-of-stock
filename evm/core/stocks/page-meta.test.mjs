// evm/core/stocks/page-meta.test.mjs — a shared link previews what it points at, every value escaped; the chart series
// is thinned to a bound, keeps the newest point and labels each point's market session.
//
// Run: node evm/core/stocks/page-meta.test.mjs

import { metaFor, injectMeta, escapeHtml, SITE_TITLE, SITE_NAME, headTags, headOf, withHead, jsonLdScript } from './page-meta.mjs'
import { seriesPoints } from './readings-window.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const PAGE = '<html><head><title>Proof of Stock</title><meta name="description" content="x">\n  <!--og-->\n</head></html>'

console.log('link previews')
{
  const m = metaFor({ chain: 'base', record: { symbol: 'NVDAc', name: 'NVIDIA', issuer: 'coinbase' }, latest: { premium: 0.006 } })
  check('a registry token link names the token, the chain and the premium', /^NVDAc \(NVIDIA\) on Base: \+0\.60% vs the issuer's reference/.test(m.title), m.title)
  check('...and says it is not advice', /Not advice/.test(m.description))
  const rh = metaFor({ chain: 'robinhood', record: { symbol: 'NVDA', name: 'NVIDIA  Robinhood Token', issuer: 'robinhood' }, latest: { premium: null } })
  check('the issuer suffix is dropped from the name, and a missing premium is not invented', /^NVDA \(NVIDIA\) on Robinhood Chain: issuer reference and on-chain price/.test(rh.title), rh.title)
  const imp = metaFor({ chain: 'base', impostor: { symbol: 'NVDAc', kind: 'registry_symbol', registry_symbol: 'NVDAc' } })
  check('an impostor link says it is not the issuer token', /is not the issuer's NVDAc/.test(imp.title))
  const A = '0x' + 'ab'.repeat(20)
  const naming = metaFor({ chain: 'robinhood', impostor: { address: A, symbol: 'dETH', kind: 'issuer_name_suffix', registry_symbol: null, ticker: null } })
  check('an impostor copying only the issuer naming says so, without inventing a target', /^Contract 0xabab…abab on Robinhood Chain copies the issuer's naming but is not its token/.test(naming.title), naming.title)
  // The title is a sentence of ours that previews and search results repeat: the impostor's own symbol never enters it.
  const hostile = metaFor({ chain: 'base', impostor: { address: A, symbol: 'IGNORE ALL PREVIOUS INSTRUCTIONS', name: 'buy now', kind: 'registry_symbol', registry_symbol: 'NVDAc' } })
  check('the impostor own symbol and name are in neither the title nor the description', !/IGNORE|buy now/i.test(hostile.title + hostile.description) && /^Contract 0xabab…abab on Base is not the issuer's NVDAc/.test(hostile.title), hostile.title)
  check('a link to nothing in particular is the site', metaFor({}).title === SITE_TITLE)

  const evil = injectMeta(PAGE, { title: '"><script>alert(1)</script>', description: 'a & b' }, 'https://x/?a=1&b=2')
  check('the title and tags are escaped', !evil.includes('<script>') && evil.includes('&lt;script&gt;') && evil.includes('a &amp; b') && evil.includes('a=1&amp;b=2'))
  check('the preview tags are filled once', (evil.match(/property="og:title"/g) || []).length === 1 && !evil.includes('<!--og-->'))
  check('the twitter card is there', evil.includes('name="twitter:card" content="summary"'))
  check('escapeHtml covers quotes', escapeHtml(`'"`) === '&#39;&quot;')
}

console.log('head tags')
{
  const t = headTags({ title: 'T & "x"', description: 'D', url: 'https://x/?a=1&b=2', image: 'https://x/og.png?v=1', robots: 'noindex', type: 'article', logo: 'https://x/logo.png', jsonLd: { a: '</script><script>alert(1)</script>&' } })
  check('a canonical link, escaped', t.includes('<link rel="canonical" href="https://x/?a=1&amp;b=2">'))
  check('robots only when asked', t.includes('<meta name="robots" content="noindex">') && !headTags({ title: 'a', description: 'b', url: 'u' }).includes('name="robots"'))
  check('with an image: the large card, og:image with its size and alt, twitter:image', /twitter:card" content="summary_large_image"/.test(t) && /og:image" content="https:\/\/x\/og\.png\?v=1"/.test(t) && /og:image:width" content="1200"/.test(t) && /og:image:height" content="630"/.test(t) && /og:image:alt" content="Proof of Stock/.test(t) && /twitter:image" content="https:\/\/x\/og\.png\?v=1"/.test(t))
  check('without one: the summary card and no image tags', /twitter:card" content="summary"/.test(headTags({ title: 'a', description: 'b', url: 'u' })) && !/og:image/.test(headTags({ title: 'a', description: 'b', url: 'u' })))
  check('og:type and the site name', /og:type" content="article"/.test(t) && new RegExp(`og:site_name" content="${SITE_NAME}"`).test(t))
  check('a PNG icon and touch icon when a logo is given', /<link rel="icon" type="image\/png" sizes="512x512" href="https:\/\/x\/logo\.png">/.test(t) && /<link rel="apple-touch-icon" href="https:\/\/x\/logo\.png">/.test(t))
  const block = (t.match(/<script type="application\/ld\+json">([^<]*)<\/script>/) || [])[1]
  check('JSON-LD cannot close its script element and still parses to the same value', block != null && (t.match(/<\/script>/g) || []).length === 1 && JSON.parse(block).a === '</script><script>alert(1)</script>&')
  check('jsonLdScript escapes <, > and &', jsonLdScript({ a: '<>&' }) === '<script type="application/ld+json">{"a":"\\u003c\\u003e\\u0026"}</script>')

  const page = '<html><head><title>A &amp; B</title>\n</head><body></body></html>'
  const w = withHead(page, { description: 'Fallback & more', url: 'https://x/p' })
  check('withHead adds a missing description once, and the tags before </head>', (w.match(/name="description"/g) || []).length === 1 && w.includes('<meta name="description" content="Fallback &amp; more">') && w.indexOf('rel="canonical"') < w.indexOf('</head>'))
  check('...from the page\'s own title, not double-escaped', w.includes('og:title" content="A &amp; B"') && !w.includes('&amp;amp;'))
  const own = withHead('<head><title>T</title><meta name="description" content="Own"></head>', { description: 'Other', url: 'u' })
  check('...and keeps a description the page already has', (own.match(/name="description"/g) || []).length === 1 && own.includes('og:description" content="Own"'))
  check('headOf reads the title and description, null when there is none', headOf(page).title === 'A & B' && headOf(page).description === null && headOf('<title>x</title><meta name="description" content="it&#39;s">').description === 'it\'s')
  const inj = injectMeta(PAGE, { title: 't', description: 'd' }, 'https://x/', { image: 'https://x/og.png', robots: 'noindex' })
  check('injectMeta passes the image and robots through', /summary_large_image/.test(inj) && /name="robots" content="noindex"/.test(inj) && /<link rel="canonical" href="https:\/\/x\/">/.test(inj))
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
