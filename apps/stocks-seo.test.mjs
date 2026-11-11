// apps/stocks-seo.test.mjs — robots.txt keeps the API and /mcp out and names the sitemap; the sitemap lists the pages
// and the listed tokens, escaped and once each; the JSON-LD names only hello@proofofstock.xyz.
//
// Run: node apps/stocks-seo.test.mjs

import { robotsTxt, sitemapXml, sitemapUrls, docUrl, homeJsonLd, docJsonLd, pageJsonLd, CONTACT_EMAIL } from './stocks-seo.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const SITE = 'https://proofofstock.xyz'

console.log('robots.txt')
{
  const r = robotsTxt(SITE)
  check('every crawler may read the pages', /^User-agent: \*$/m.test(r) && /^Allow: \/$/m.test(r) && !/^Disallow: \/$/m.test(r))
  check('the JSON API, the JSON lookup and the MCP endpoint are kept out', /^Disallow: \/api\/$/m.test(r) && /^Disallow: \/verify$/m.test(r) && /^Disallow: \/mcp$/m.test(r))
  check('docs, llms.txt and the badge are not disallowed', !/^Disallow: \/(docs|llms|badge)/m.test(r))
  check('it names the sitemap by its absolute URL', /^Sitemap: https:\/\/proofofstock\.xyz\/sitemap\.xml$/m.test(r))
  const p = robotsTxt('https://e.test/x', '/x')
  check('under a public path the rules carry it', /^Allow: \/x\/$/m.test(p) && /^Disallow: \/x\/api\/$/m.test(p) && /^Sitemap: https:\/\/e\.test\/x\/sitemap\.xml$/m.test(p))
}

console.log('sitemap')
{
  const urls = sitemapUrls({ site: SITE, docs: ['README.md', 'how-to/b.md', 'reference/a.md', 'reference/passport.schema.json', 'legal.md'], released: '2026-11-11', symbols: { base: ['NVDAc', 'A&B', 'NVDAc'], robinhood: ['TSLA'] } })
  const locs = urls.map((u) => u.loc)
  check('the home first, then the docs home', locs[0] === SITE + '/' && locs[1] === SITE + '/docs/')
  check('every markdown page, the schema file left out', locs.includes(SITE + '/docs/how-to/b.md') && locs.includes(SITE + '/docs/legal.md') && !locs.some((l) => /schema\.json|README/.test(l)))
  check('/status and /history', locs.includes(SITE + '/status') && locs.includes(SITE + '/history'))
  check('one short link per listed symbol, encoded, duplicates folded', locs.filter((l) => l === SITE + '/?base=NVDAc').length === 1 && locs.includes(SITE + '/?base=A%26B') && locs.includes(SITE + '/?robinhood=TSLA'))
  check('the docs carry the release date, the live pages none', urls.find((u) => u.loc === SITE + '/docs/legal.md').lastmod === '2026-11-11' && !urls.find((u) => u.loc === SITE + '/status').lastmod && !urls.find((u) => u.loc === SITE + '/?robinhood=TSLA').lastmod)
  const x = sitemapXml([{ loc: SITE + '/?a=1&b=<2>' }, { loc: SITE + '/?a=1&b=<2>' }, { loc: SITE + '/', lastmod: '2026-11-11' }, null])
  check('XML is escaped and each URL is listed once', x.includes('<loc>https://proofofstock.xyz/?a=1&amp;b=&lt;2&gt;</loc>') && (x.match(/<url>/g) || []).length === 2 && x.includes('<lastmod>2026-11-11</lastmod>'))
  check('the urlset is the sitemaps.org one', /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n/.test(x) && x.trimEnd().endsWith('</urlset>'))
  check('no released date, no lastmod', !sitemapXml(sitemapUrls({ site: SITE, docs: ['legal.md'] })).includes('lastmod'))
  check('docUrl: README.md is the docs home', docUrl(SITE, 'README.md') === SITE + '/docs/' && docUrl(SITE, 'legal.md') === SITE + '/docs/legal.md')
}

console.log('JSON-LD')
{
  const seo = { image: SITE + '/og.png?v=1', logo: SITE + '/logo.png?v=1' }
  const home = homeJsonLd({ site: SITE, version: '9.9.9', ...seo })
  const g = home['@graph'], t = (k) => g.find((n) => n['@type'] === k)
  check('schema.org, one graph', home['@context'] === 'https://schema.org' && Array.isArray(g))
  check('the organisation is Proof of Stock, reachable at hello@ only, with a raster logo', t('Organization').name === 'Proof of Stock' && t('Organization').email === CONTACT_EMAIL && t('Organization').contactPoint.email === CONTACT_EMAIL && t('Organization').logo.url === seo.logo && CONTACT_EMAIL === 'hello@proofofstock.xyz')
  check('the site, the organisation and the app share one name, the old product name gone', t('WebSite').name === 'Proof of Stock' && t('WebApplication').name === 'Proof of Stock' && t('SoftwareApplication').name === 'Proof of Stock MCP server' && !JSON.stringify(home).includes('Stock Token Passport'))
  check('the web app: free, its version, the preview image', t('WebApplication').softwareVersion === '9.9.9' && t('WebApplication').offers.price === '0' && t('WebApplication').image === seo.image)
  check('the MCP server is its own application, pointing at its tools reference', t('SoftwareApplication').url === SITE + '/mcp' && t('SoftwareApplication').softwareHelp.url === SITE + '/docs/reference/tools.md')
  check('every @id reference resolves inside the graph', (() => { const ids = new Set(g.map((n) => n['@id'])); const refs = JSON.stringify(home).match(/\{"@id":"[^"]+"\}/g) || []; return refs.length > 0 && refs.every((r) => ids.has(JSON.parse(r)['@id'])) })())
  const all = JSON.stringify([home, docJsonLd({ site: SITE, url: SITE + '/docs/legal.md', title: 'Legal', description: 'd', version: '1', ...seo }), pageJsonLd({ site: SITE, url: SITE + '/status', title: 'S', description: 'd', logo: seo.logo })])
  check('no address but hello@proofofstock.xyz appears in any graph', (all.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).every((e) => e === CONTACT_EMAIL))
  const doc = docJsonLd({ site: SITE, url: SITE + '/docs/legal.md', title: 'x'.repeat(200), description: 'd', version: '1', ...seo })
  check('a docs page is a TechArticle with a headline search engines accept', doc['@graph'].some((n) => n['@type'] === 'TechArticle' && n.headline.length === 110 && n.url === SITE + '/docs/legal.md'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
