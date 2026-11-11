// apps/stocks-seo.mjs — what the site tells search engines, AI crawlers and agents about itself: robots.txt, the
// sitemap, and the JSON-LD that names the organisation, the site, the web app and the MCP server.
//
// Pure: the server (apps/stocks-web.mjs) passes in what it holds (origin, docs, registry symbols, release date).
//
// ⚠ THE ONLY CONTACT IS hello@proofofstock.xyz. No person, host or other project is named here.

import { SITE_NAME, SITE_DESCRIPTION } from '../evm/core/stocks/page-meta.mjs'

export const CONTACT_EMAIL = 'hello@proofofstock.xyz'

/** The crawlers named in robots.txt, by company: search, AI training and AI answer-time fetchers. */
export const AI_CRAWLERS = Object.freeze([
  ['OpenAI', ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User']],
  ['Anthropic', ['ClaudeBot', 'Claude-SearchBot', 'Claude-User']],
  ['Google', ['Googlebot', 'Google-Extended', 'GoogleOther']],
  ['Perplexity', ['PerplexityBot', 'Perplexity-User']],
  ['Meta', ['meta-externalagent', 'meta-externalfetcher', 'FacebookBot']],
  ['Apple', ['Applebot', 'Applebot-Extended']],
  ['Amazon', ['Amazonbot']],
  ['Mistral', ['MistralAI-User']],
  ['Microsoft', ['bingbot']],
  ['Common Crawl', ['CCBot']],
  ['DuckDuckGo', ['DuckAssistBot']],
  ['Cohere', ['cohere-ai']],
])

/**
 * Crawl everything a person reads; keep the JSON API and the MCP endpoint out. `/verify` is the JSON lookup (the page
 * for a token is `/?chain=…&address=…`). The API answers also carry X-Robots-Tag: noindex, for a crawler that ignores
 * this file.
 * @param {string} site  origin plus public path, e.g. https://proofofstock.xyz
 * @param {string} [path] the public path alone ('' in production)
 */
export function robotsTxt (site, path = '') {
  const rules = [`Allow: ${path}/`, `Disallow: ${path}/api/`, `Disallow: ${path}/mcp`, `Disallow: ${path}/verify`]
  return [
    '# Proof of Stock: pages, docs, /llms.txt and /llms-full.txt are open to every crawler and agent.',
    '# The JSON API and the MCP endpoint are for programs: see /docs/reference/http-api.md and /mcp.',
    '',
    '# Search and AI crawlers, named so a rule written for one of them elsewhere never closes this site to it.',
    '# A crawler that finds its own name here follows this group and not the * group, so both carry the same rules.',
    ...AI_CRAWLERS.flatMap(([org, agents]) => [`# ${org}`, ...agents.map((a) => `User-agent: ${a}`)]),
    ...rules,
    '',
    'User-agent: *',
    ...rules,
    '',
    `Sitemap: ${site}/sitemap.xml`,
    '',
  ].join('\n')
}

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' })[c])

/** @param {{ loc: string, lastmod?: string|null }[]} urls */
export function sitemapXml (urls) {
  const seen = new Set()
  const rows = urls.filter((u) => u && u.loc && !seen.has(u.loc) && seen.add(u.loc))
    .map((u) => `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${xml(u.lastmod)}</lastmod>` : ''}</url>`)
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...rows, '</urlset>', ''].join('\n')
}

/** The canonical web address of a docs file: README.md is the docs home. */
export const docUrl = (site, rel) => rel === 'README.md' ? `${site}/docs/` : `${site}/docs/${rel}`

/**
 * Every page worth a search result: the home, the docs (markdown pages; the JSON schema is a file, not a page),
 * /status, /history, and one passport per issuer-listed token by its short link (?base=NVDAc). The listed symbols
 * come from the registries already in memory; an unlisted address is not a page of its own.
 * @param {object} p
 * @param {string} p.site
 * @param {Iterable<string>} p.docs      docs keys (README.md, how-to/x.md, …)
 * @param {string|null} [p.released]     YYYY-MM-DD of this version: the docs and the home change only with a release
 * @param {Record<string, string[]>} [p.symbols]  chain → listed symbols
 */
export function sitemapUrls ({ site, docs, released = null, symbols = {} }) {
  const pages = [...docs].filter((k) => k.endsWith('.md')).sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)))
  return [
    { loc: `${site}/`, lastmod: released },
    ...pages.map((k) => ({ loc: docUrl(site, k), lastmod: released })),
    { loc: `${site}/status` },
    { loc: `${site}/history` },
    ...Object.entries(symbols).flatMap(([chain, list]) => [...new Set(list)].sort().map((s) => ({ loc: `${site}/?${chain}=${encodeURIComponent(s)}` }))),
  ]
}

/** The nodes every page shares, so its own node can point at them by @id. */
function siteNodes (site, { logo }) {
  return [
    {
      '@type': 'Organization', '@id': `${site}/#organization`, name: SITE_NAME, url: `${site}/`, email: CONTACT_EMAIL,
      logo: { '@type': 'ImageObject', url: logo, width: 512, height: 512 },
      contactPoint: { '@type': 'ContactPoint', email: CONTACT_EMAIL, contactType: 'customer support', availableLanguage: 'en' },
    },
    { '@type': 'WebSite', '@id': `${site}/#website`, name: SITE_NAME, alternateName: 'proofofstock.xyz', url: `${site}/`, inLanguage: 'en', publisher: { '@id': `${site}/#organization` } },
  ]
}

/**
 * The home page: who runs it, the site, the web app and the MCP server for agents.
 * @param {object} p
 * @param {string} p.site
 * @param {string} p.version
 * @param {string} p.image   the preview image URL
 * @param {string} p.logo    the 512×512 logo URL
 */
export function homeJsonLd ({ site, version, image, logo }) {
  const org = { '@id': `${site}/#organization` }
  const free = { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...siteNodes(site, { logo }),
      {
        '@type': 'WebApplication', '@id': `${site}/#app`, name: SITE_NAME, url: `${site}/`, description: SITE_DESCRIPTION, image,
        applicationCategory: 'FinanceApplication', operatingSystem: 'Any (web browser)', browserRequirements: 'Requires JavaScript',
        softwareVersion: version, isAccessibleForFree: true, offers: free, publisher: org, inLanguage: 'en',
        featureList: [
          'Issuer registry check: is this contract the issuer\'s tokenized stock (Coinbase on Base, Robinhood on Robinhood Chain)',
          'Issuer reference price with its age, against the NYSE calendar',
          'On-chain premium of the deepest pool, by US market session',
          'Impostor list: tokens that copy a listed symbol or the issuer\'s naming',
        ],
        isPartOf: { '@id': `${site}/#website` },
      },
      {
        '@type': 'SoftwareApplication', '@id': `${site}/#mcp`, name: `${SITE_NAME} MCP server`, url: `${site}/mcp`,
        description: 'Public read-only Model Context Protocol server (Streamable HTTP, no key): find a stock token, verify contracts against the issuer registry, read a passport. It never trades, signs or holds a key.',
        applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', softwareVersion: version, isAccessibleForFree: true, offers: free,
        softwareHelp: { '@type': 'CreativeWork', url: `${site}/docs/reference/tools.md` }, publisher: org,
      },
    ],
  }
}

/** A docs page: a technical article in the site's documentation. */
export function docJsonLd ({ site, url, title, description, logo, image, version }) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...siteNodes(site, { logo }),
      {
        '@type': 'TechArticle', '@id': `${url}#article`, headline: String(title).slice(0, 110), description, url, image, inLanguage: 'en',
        version, isPartOf: { '@id': `${site}/#website` }, publisher: { '@id': `${site}/#organization` }, author: { '@id': `${site}/#organization` },
      },
    ],
  }
}

/** Any other page (/status, /history, a passport): a web page of the site. */
export function pageJsonLd ({ site, url, title, description, logo }) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...siteNodes(site, { logo }),
      { '@type': 'WebPage', '@id': `${url}#page`, name: title, description, url, inLanguage: 'en', isPartOf: { '@id': `${site}/#website` }, publisher: { '@id': `${site}/#organization` } },
    ],
  }
}
