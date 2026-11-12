// apps/stocks-web.mjs: the public stock-token passport site (proofofstock.xyz): one page and three read-only JSON
// routes, in a process of its own (ADR-0003), behind nginx.
//
// Everything lives under BASE_PATH (/stocks), so the domain's root stays free for other pages:
//   GET /stocks/                       the page (apps/stocks-web/index.html, app.js, style.css); /stocks redirects here
//   GET /stocks/api/find?q[&chain]     issuer-listed tokens matching a ticker, name or ISIN, on every chain unless one is named
//   GET /stocks/api/overview           per chain, the tokens whose DEX price sits furthest from the issuer's reference
//   GET /stocks/api/impostors          per chain, tokens claiming to be an issuer token they are not (scripts/stocks/impostor-list.mjs)
//   GET /stocks/api/passport?chain&address[&hours]   with the same share (same ISIN) on the other chain
//   GET /stocks/api/matrix             every share (ISIN) listed on both Base and Robinhood: each venue's premium, the gap
//   GET /stocks/api/status             what the server holds: registry and readings age per chain
//   GET /stocks/history                the dated, append-only archive: registry snapshots and impostor cases (apps/stocks-history.mjs)
//   GET /stocks/api/history/cases?chain[&since&event&limit]          case events, newest first, at most 50, no paging
//   GET /stocks/api/history/registry?chain[&date]                    snapshot index, or the snapshot in force on a day
//   GET /stocks/api/hit?k&p[&t&c&a&s&r]  the page's own visit counter (apps/stocks-web/beacon.js, apps/stocks-analytics.mjs); 204
//   POST /stocks/mcp                   the same passport as a public MCP server (apps/stocks-mcp-http.mjs)
//   GET /healthz                       for the deploy gate, not proxied: 200 once at least one issuer registry is loaded, else 503
//
// ⚠ NOTHING ON THE REQUEST PATH WALKS THE DATASET OR CALLS OUT. Registries are refreshed in the background every 5
// minutes and the readings window is held in memory (evm/core/stocks/readings-window.mjs); a request reads both from
// memory. The name of a token outside the registry comes from our own dataset, through the names file the impostor
// timer writes (scripts/stocks/impostor-list.mjs); a token it does not name is answered without a name.
//
// ⚠ PUBLIC AND READ-ONLY. GET and HEAD only, no cookies, no accounts, no wallet, no trading. Every passport carries
// `not_trading_signal: true` and the page says the same in words. Strict CSP: the page loads only its own files.
//
// Env: STOCKS_WEB_PORT (3005), STOCKS_WEB_HOST (127.0.0.1), STOCKS_ROOT_BASE, STOCKS_ROOT_ROBINHOOD,
// STOCKS_PUBLIC_ORIGIN (https://proofofstock.xyz) and STOCKS_PUBLIC_PATH (''): where the public sees the site. nginx maps
// the domain's root onto BASE_PATH (deployment/nginx/proofofstock.xyz.conf), so links and the MCP URL the page shows are
// built from these two, never from BASE_PATH.

import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from '../scripts/lib/invoked-directly.mjs'
import { CHAINS } from '../scripts/stocks/stock-peg.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../evm/core/stocks/registries.mjs'
import { MIN_POOL_LIQUIDITY_USD } from '../evm/core/stocks/peg.mjs'
import { RECORDER_CADENCE_S } from '../evm/core/stocks/passport.mjs'

// Where every number in a passport comes from, per chain.
const SOURCES = Object.freeze({
  base: { registry: COINBASE_URL, reference: 'Coinbase NAV per token (nav_price, total return), from the same registry' },
  robinhood: { registry: ROBINHOOD_ASSETS_URL, reference: `Robinhood token bid/ask (${ROBINHOOD_PRICES_URL}): the share quote times the token multiplier, so per TOKEN; with multiplier 1 it equals the share's mid` },
})
import { buildPassport, DEFAULT_WINDOW_H, PUBLIC_WINDOW_H } from '../evm/core/stocks/passport.mjs'
import { usEquitySession } from '../evm/core/stocks/market-session.mjs'
import { createWindowCache, readingsOf, seriesPoints } from '../evm/core/stocks/readings-window.mjs'
import { metaFor, injectMeta, withHead, headOf } from '../evm/core/stocks/page-meta.mjs'
import { robotsTxt, securityTxt, sitemapXml, sitemapUrls, docUrl, homeJsonLd, docJsonLd, pageJsonLd } from './stocks-seo.mjs'
import { createMcpHttp, SUPPORTED_VERSIONS } from './stocks-mcp-http.mjs'
import { verifyToken, badgeSvg, badgeState } from '../evm/core/stocks/verify.mjs'
import { createDocsRenderer } from './stocks-docs.mjs'
import { isIsoTime } from '../scripts/lib/mcp-args.mjs'
import { statusPage } from './stocks-status.mjs'
import { createHistoryStore, historyPage, BULK_WINDOW_DAYS, BULK_MAX, FULL_ARCHIVE } from './stocks-history.mjs'
import { createAnalytics, parseHit } from './stocks-analytics.mjs'
import { findAcross, sameStockElsewhere, overview, matrix, isinsOfTicker, MATRIX_VENUES } from '../evm/core/stocks/cross-chain.mjs'
import { symbolLabel, nameLabel, UNTRUSTED_TEXT_NOTE } from '../evm/core/stocks/untrusted-text.mjs'

/** How many matrix rows the MCP tool returns when no share is named. */
export const MATRIX_MCP_TOP = 20

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.join(HERE, 'stocks-web')
const STATIC = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/docs.css': ['docs.css', 'text/css; charset=utf-8'],
  '/docs.js': ['docs.js', 'text/javascript; charset=utf-8'],
  '/beacon.js': ['beacon.js', 'text/javascript; charset=utf-8'],
  '/og.png': ['og.png', 'image/png'],
  '/logo.png': ['logo.png', 'image/png'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['logo.png', 'image/png'],
})
export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
})
const REGISTRY_TTL_MS = 5 * 60e3
export const PAGE_CACHE_MS = 30e3 // /status and /history: one build per this long
const RATE = { perMinute: 60 }
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const MCP_MAX_BODY = 16 * 1024
const BUCKETS_MAX = 20000
export const BASE_PATH = '/stocks'
const STATUS_DESCRIPTION = 'Is Proof of Stock up to date? The issuer registries, the price readings and the impostor list on Base and Robinhood Chain, each with its age.'

// The documentation the site serves (docs/), as markdown, plus /llms.txt and /llms-full.txt (llmstxt.org). Only these
// directories and files are public; internal notes in docs/ (the TZ, the ssh-based agent note) are not.
const DOCS_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'docs')
const PUBLIC_DOCS = /^(README\.md|legal\.md|(explanation|tutorials|how-to|reference)\/[a-z0-9-]+\.(md|schema\.json))$/
/** The source as the third icon at the bottom, after X and Telegram (apps/stocks-web/index.html .foot-social). */
export const sourceIcon = (url) => `<a class="foot-ic" href="${url}" target="_blank" rel="me noopener noreferrer" aria-label="Proof of Stock source on GitHub" title="GitHub: ${url.replace('https://github.com/', '')}"><span class="i i-gh" aria-hidden="true"></span></a>`

export function loadDocs (dir = DOCS_DIR) {
  const out = new Map()
  const walk = (rel) => {
    let names = []; try { names = fs.readdirSync(path.join(dir, rel)) } catch (_) { return }
    for (const n of names) {
      const r = rel ? rel + '/' + n : n
      if (fs.statSync(path.join(dir, r)).isDirectory()) walk(r)
      else if (PUBLIC_DOCS.test(r)) out.set(r, fs.readFileSync(path.join(dir, r), 'utf8'))
    }
  }
  walk('')
  return out
}
/** The llms.txt index: title, one line, then every page with its first sentence. */
export function llmsTxt (docs, origin, version) {
  const order = ['README.md', 'tutorials/', 'how-to/', 'reference/', 'explanation/', 'legal.md', 'changelog.md']
  const rank = (k) => order.findIndex((o) => k === o || k.startsWith(o))
  const pages = [...docs.keys()].filter((k) => k.endsWith('.md') && k !== 'README.md').sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const titleOf = (t) => (t.match(/^#\s+(.+)$/m) || [])[1] || 'Untitled'
  const lineOf = (t) => (t.split('\n').find((l) => /^[A-Z][^|#`>\-*]/.test(l.trim()) && !/^v\d/.test(l.trim())) || '').trim().replace(/\s+/g, ' ').slice(0, 180)
  const sections = {}
  for (const k of pages) (sections[k.split('/').length > 1 ? k.split('/')[0] : 'more'] ||= []).push(`- [${titleOf(docs.get(k))}](${origin}/docs/${k}): ${lineOf(docs.get(k))}`)
  const head = ['# Proof of Stock', '', `> Is a token the issuer's tokenized stock, and how far does the chain trade from the issuer's price? Base (Coinbase registry) and Robinhood Chain (Robinhood registry). Public read-only MCP server: ${origin}/mcp. Version ${version}.`, '',
    'Contact: hello@proofofstock.xyz. Read-only: nothing here trades, signs or holds a key. Not investment advice.', '']
  // Where an agent starts: the endpoints and the one-file copy of every page, before the page index.
  const start = [
    `- [MCP server](${origin}/mcp): Streamable HTTP, POST one JSON-RPC message, no key or account` + (docs.has('reference/tools.md') ? `; tools: ${origin}/docs/reference/tools.md` : ''),
    docs.has('reference/http-api.md') ? `- [HTTP API](${origin}/docs/reference/http-api.md): read-only JSON routes, e.g. ${origin}/verify?chain=base&address=0x…` : null,
    docs.has('reference/passport.schema.json') ? `- [Passport JSON Schema](${origin}/docs/reference/passport.schema.json): the shape of one passport answer` : null,
    docs.has('how-to/check-before-listing.md') ? `- [Pre-trade guard for agents](${origin}/docs/how-to/check-before-listing.md): the @proofofstock/guard package, beforeBuy() refuses a token the issuer did not list (fails closed; not on npm yet)` : null,
    `- [Every page in one file](${origin}/llms-full.txt)`,
  ].filter(Boolean)
  head.push('## Start here', '', ...start, '')
  const names = { tutorials: 'Tutorials', 'how-to': 'How-to guides', reference: 'Reference', explanation: 'Explanation', more: 'More' }
  return head.concat(...['tutorials', 'how-to', 'reference', 'explanation', 'more'].filter((s) => sections[s]).map((s) => [`## ${names[s]}`, '', ...sections[s], ''])).join('\n')
}

/** How many rate-limit units an MCP message costs: a verify batch of n addresses is ⌈n/10⌉, anything else 1. */
// ⚠ THE RECORDER'S PRICE HISTORY IS OURS, A PASSPORT IS NOT A DOWNLOAD. A passport shows at most PUBLIC_HOURS of
//   readings, its chart points only when asked (series=1), and costs PASSPORT_UNITS of the per-minute limit, so walking
//   every token every day to rebuild the dataset takes hours instead of minutes. The site keeps 72 h for its own stats.
export const PUBLIC_HOURS = PUBLIC_WINDOW_H
export const PASSPORT_UNITS = 3
export function batchUnits (raw) {
  try {
    const m = JSON.parse(raw)
    if (m && m.method === 'tools/call' && m.params && m.params.name === 'stock_passport') return PASSPORT_UNITS
    const a = m && m.method === 'tools/call' && m.params && m.params.name === 'verify_stock_tokens' && m.params.arguments && m.params.arguments.addresses
    return Array.isArray(a) ? Math.max(1, Math.ceil(a.length / 10)) : 1
  } catch (_) { return 1 }
}

/**
 * The rate-limit key of a client address. IPv6 clients are keyed by their /56, the block an ISP gives one customer: keyed
 * per /64, one free /48 is 65,536 clients and fills the limiter table; per /56 it is 256. IPv4 (and IPv4-mapped IPv6)
 * stays per address.
 */
export function clientKey (ip) {
  const s = String(ip || '').toLowerCase()
  if (!s.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/^::ffff:/, '')
  const [head, tail = ''] = s.split('::')
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const full = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  const q = full.slice(0, 4).map((x) => parseInt(x || '0', 16) || 0)
  q[3] &= 0xff00
  return q.map((x) => x.toString(16)).join(':') + '::/56'
}

export function createStocksWeb ({
  roots = { base: process.env.STOCKS_ROOT_BASE || '/var/lib/stp/base', robinhood: process.env.STOCKS_ROOT_ROBINHOOD || '/var/lib/stp/robinhood' },
  fetchImpl = fetch, now = () => Date.now(), windowH = DEFAULT_WINDOW_H, log = (m) => console.log(m),
  publicOrigin = process.env.STOCKS_PUBLIC_ORIGIN || 'https://proofofstock.xyz',
  publicPath = process.env.STOCKS_PUBLIC_PATH ?? '',
  analytics: analyticsOpts = {}, // apps/stocks-analytics.mjs options; { enabled: false } turns the counter off
  source, // the source link: undefined = package.json decides (stp.source_public), null = none, a URL = that URL
} = {}) {
  const registries = new Map() // chain → { records, at, error }
  // Addresses that were listed and have left the registry, since this process started: chain → Map(address → { at, symbol }).
  const delisted = new Map(Object.keys(CHAINS).map((c) => [c, new Map()]))
  const windows = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, createWindowCache({ root: roots[c], windowH, now })]))
  const names = new Map() // chain → Map(address → { symbol, name }), from stock-names.json
  const impostors = new Map() // chain → the parsed impostors.json, or { error }
  const buckets = new Map() // ip → { minute, n }
  const history = createHistoryStore({ roots, now, log })
  const analytics = createAnalytics({ now, log, ...analyticsOpts })
  const docs = loadDocs()
  // The changelog is a docs page (/docs/changelog.md): the repository's own CHANGELOG.md, its links into docs/ rebased.
  try { docs.set('changelog.md', fs.readFileSync(path.join(path.dirname(DOCS_DIR), 'CHANGELOG.md'), 'utf8').replace(/\]\(docs\//g, '](')) } catch (_) { /* a tree without it has no such page */ }
  const pkgJson = JSON.parse(fs.readFileSync(path.join(path.dirname(STATIC_DIR), '..', 'package.json'), 'utf8'))
  const appVersion = pkgJson.version
  // The source link: shown only once the repository is public (package.json stp.source_public), so nobody follows it to
  // a GitHub 404 before then. Opening the code is that one flag and a deploy.
  const sourceUrl = source !== undefined ? source : (pkgJson.stp?.source_public && pkgJson.repository?.url ? pkgJson.repository.url : null)
  // The release date is the changelog's for this version ("## [0.3.0] - 2026-11-10"), shown as "10 Nov 2026".
  // The sitemap's lastmod for the home and the docs is the same date, as YYYY-MM-DD (null when unreleased).
  const releasedIso = (() => {
    try {
      const m = fs.readFileSync(path.join(path.dirname(DOCS_DIR), 'CHANGELOG.md'), 'utf8').match(new RegExp('^## \\[' + appVersion.replace(/\./g, '\\.') + '\\] - (\\d{4}-\\d{2}-\\d{2})', 'm'))
      return m ? m[1] : null
    } catch (_) { return null }
  })()
  const released = releasedIso ? new Date(releasedIso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'unreleased'
  let docsPages = null // built once the static assets are versioned, below
  const llms = llmsTxt(docs, publicOrigin + publicPath, appVersion)
  // One file holds every page, so a relative link would resolve against /llms-full.txt and 404: each is made absolute
  // against its own page first. An in-page anchor (#x) points at that page's URL too.
  const absLinks = (k, t) => t.replace(/\]\((?!https?:|mailto:)([^)\s]+)\)/g, (m, href) => {
    try { return '](' + new URL(href, `${publicOrigin + publicPath}/docs/${k}`).href + ')' } catch (_) { return m }
  })
  const llmsFull = [...docs.entries()].filter(([k]) => k.endsWith('.md')).map(([k, t]) => `<!-- ${publicOrigin + publicPath}/docs/${k} -->\n\n${absLinks(k, t.trim())}\n`).join('\n---\n\n')
  const static_ = Object.fromEntries(Object.entries(STATIC).map(([k, [f, type]]) => [k, { body: fs.readFileSync(path.join(STATIC_DIR, f)), type }]))
  // The page names its script and stylesheet by content hash, so a release reaches every visitor at once: the assets may
  // be cached, the page that names them may not.
  const version = (k) => crypto.createHash('sha256').update(static_[k].body).digest('hex').slice(0, 12)
  static_['/'].body = Buffer.from(String(static_['/'].body).replace('href="style.css"', `href="style.css?v=${version('/style.css')}"`).replace('src="app.js"', `src="app.js?v=${version('/app.js')}"`).replace('src="beacon.js"', `src="beacon.js?v=${version('/beacon.js')}"`)
    .replaceAll('__MCP_URL__', publicOrigin + publicPath + '/mcp').replaceAll('__VERSION__', appVersion).replaceAll('__RELEASED__', released)
    .replace('<!--source-->', sourceUrl ? sourceIcon(sourceUrl) : ''))
  // What crawlers and link previews read: the preview image and logo by content hash (a new image is a new URL, so
  // X and Telegram fetch it again), robots.txt and the head tags every page gets.
  const site = publicOrigin + publicPath
  const seo = { image: `${site}/og.png?v=${version('/og.png')}`, logo: `${site}/logo.png?v=${version('/logo.png')}` }
  const robots = robotsTxt(site, publicPath)
  docsPages = createDocsRenderer({ docs, version: appVersion, released, sourceUrl, base: publicPath, assets: { css: `style.css?v=${version('/style.css')}`, docsCss: `docs.css?v=${version('/docs.css')}`, docsJs: `docs.js?v=${version('/docs.js')}`, beacon: `beacon.js?v=${version('/beacon.js')}` } })

  // ⚠ A RAW ERROR NEVER REACHES A RESPONSE. A file system or fetch error can carry an internal path or a piece of a file;
  //   what is public is a fixed sentence, the original goes to the journal (once per change, not every refresh).
  const lastLogged = new Map()
  const internal = (where, e, said) => { const m = String(e && e.message || e).slice(0, 300); if (lastLogged.get(where) !== m) { lastLogged.set(where, m); log(`[${where}] ${m}`) } return said }
  const unavailable = (m) => Object.assign(new Error(m), { public: true }) // our own sentence: safe to show an MCP client
  // /status and /history are built from in-memory state that changes at most once a refresh: one build serves every
  // request for PAGE_CACHE_MS, so a client hammering them costs a map lookup, not a render.
  const pageCache = new Map()
  const cachedPage = (key, build) => { const c = pageCache.get(key); if (c && now() - c.at < PAGE_CACHE_MS) return c.html; const html = build(); pageCache.set(key, { at: now(), html }); return html }
  async function refreshRegistry (chain) {
    const C = CHAINS[chain]
    try {
      const records = await C.read(fetchImpl, { chainId: C.chainId })
      const prev = registries.get(chain)?.records
      if (prev) {
        const kept = new Set(records.map((r) => r.address)), gone = delisted.get(chain)
        for (const r of prev) if (!kept.has(r.address) && !gone.has(r.address)) gone.set(r.address, { at: now(), symbol: r.symbol })
        for (const a of kept) gone.delete(a)
      }
      registries.set(chain, { records, at: now(), error: null })
    } catch (e) {
      const prev = registries.get(chain)
      registries.set(chain, { records: prev?.records || null, at: prev?.at || null, error: internal(`registry ${chain}`, e, 'the issuer registry could not be read') })
    }
  }
  // The impostor list is written by its own timer; read it whole, keep the last good copy if a read fails.
  function refreshImpostors (chain) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(roots[chain], 'stock-peg', 'impostors.json'), 'utf8'))
      // A deployer's address is the collector's work and is not published; how many listed impostors share it is.
      const byDeployer = new Map()
      for (const i of j.items || []) if (i.deployer) byDeployer.set(i.deployer, (byDeployer.get(i.deployer) || 0) + 1)
      // ⚠ symbol and name are the creator's text: published as labels (untrusted-text.mjs), whatever the file holds.
      const pub = (i) => { const { deployer, ...rest } = i; return { ...rest, symbol: symbolLabel(i.symbol), name: nameLabel(i.name), same_deployer_impostors: deployer ? byDeployer.get(deployer) - 1 : null } }
      const items = (j.items || []).map(pub)
      // asWritten is for resemblance() only (nameOf → buildPassport, which publishes labels); no route serializes it.
      const asWritten = new Map((j.items || []).map((i) => [i.address, { symbol: i.symbol ?? null, name: i.name ?? null }]))
      impostors.set(chain, { ...j, items, byAddress: new Map(items.map((i) => [i.address, i])), asWritten })
    } catch (e) { if (!impostors.get(chain)?.items) impostors.set(chain, { error: e.code === 'ENOENT' ? 'not generated yet' : internal(`impostors ${chain}`, e, 'unreadable') }) }
  }
  // The names file: written by the same timer, read whole, the last good copy kept.
  function refreshNames (chain) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(roots[chain], 'stock-peg', 'stock-names.json'), 'utf8'))
      names.set(chain, new Map(Object.entries(j.names || {}).map(([a, [symbol, name]]) => [a, { symbol: symbol ?? null, name: name ?? null }])))
    } catch (_) { if (!names.has(chain)) names.set(chain, new Map()) }
  }
  async function refreshAll () {
    await Promise.all(Object.keys(CHAINS).flatMap((c) => [refreshRegistry(c), windows[c].refresh(), Promise.resolve(refreshImpostors(c)), Promise.resolve(refreshNames(c)), Promise.resolve(history.refresh(c))]))
  }

  // The page, with a link preview for the token the link names, built only from what is held in memory.
  function pageFor (url) {
    let c = url.searchParams.get('chain'), a = String(url.searchParams.get('address') || '').toLowerCase()
    // The short form of a listed token's link: ?base=NVDAc resolves to that registry record.
    if (!ADDRESS.test(a)) {
      for (const k of Object.keys(CHAINS)) {
        const sym = String(url.searchParams.get(k) || '').toLowerCase()
        const rec = sym ? registries.get(k)?.records?.find((r) => String(r.symbol).toLowerCase() === sym) : null
        if (rec) { c = k; a = rec.address; break }
      }
    }
    let meta = metaFor({})
    let record = null, impostor = null
    const named = Boolean(CHAINS[c] && ADDRESS.test(a))
    if (named) {
      record = registries.get(c)?.records?.find((r) => r.address === a) || null
      const latest = record ? windows[c].get().window?.byToken.get(a)?.latest : null
      impostor = record ? null : impostors.get(c)?.byAddress?.get(a) || null
      meta = metaFor({ chain: c, record, latest, impostor })
    }
    const canonical = publicOrigin + publicPath + '/' + (record ? `?${c}=${encodeURIComponent(record.symbol)}` : named ? `?chain=${c}&address=${a}` : '')
    // A listed token and a listed impostor are pages worth a search result; any other address is the empty passport
    // of a contract nobody indexed, one per address that exists: not indexed.
    const jsonLd = named ? pageJsonLd({ site, url: canonical, title: meta.title, description: meta.description, logo: seo.logo }) : homeJsonLd({ site, version: appVersion, ...seo })
    return Buffer.from(injectMeta(static_['/'].body, meta, canonical, { ...seo, jsonLd, robots: named && !record && !impostor ? 'noindex' : undefined }))
  }

  // A docs page with its canonical link, preview and JSON-LD. The docs are fixed at start, so each page is built once.
  const docPages = new Map()
  function docPage (rel) {
    if (!docPages.has(rel)) {
      const html = docsPages.render(rel), url = docUrl(site, rel), { title, description } = headOf(html)
      docPages.set(rel, withHead(html, { url, type: 'article', ...seo, jsonLd: docJsonLd({ site, url, title, description, version: appVersion, ...seo }) }))
    }
    return docPages.get(rel)
  }
  // /status and /history, from what their own module rendered.
  function withPageHead (sub, html, description) {
    const url = site + sub, own = headOf(html)
    return withHead(html, { url, description, ...seo, jsonLd: pageJsonLd({ site, url, title: own.title, description: own.description ?? description, logo: seo.logo }) })
  }

  // A token outside the registry, named from our dataset; unnamed, the passport says nothing about resemblance.
  function nameOf (chain, address) {
    const n = names.get(chain)?.get(address)
    if (n) return n
    return impostors.get(chain)?.asWritten?.get(address) || {}
  }

  let sweptMinute = -1
  const SPILL_SHARDS = 4096, spill = new Uint32Array(SPILL_SHARDS)
  let spillMinute = -1
  function limited (ipRaw, units = 1) {
    const ip = clientKey(ipRaw)
    const minute = Math.floor(now() / 60e3)
    const b = buckets.get(ip)
    if (!b || b.minute !== minute) {
      if (!b && buckets.size >= BUCKETS_MAX) {
        // Past the cap, drop the buckets of earlier minutes, at most once a minute: walking a map full of current
        // buckets on every new client is quadratic, and a crowd of fresh addresses would stall the process.
        if (sweptMinute !== minute) { sweptMinute = minute; for (const [k, v] of buckets) if (v.minute !== minute) buckets.delete(k) }
        // Still full of this minute's clients: a new one is counted in a shared counter picked by a hash of its key,
        // never untracked (that let it make unlimited requests) and never refused outright (that would let anyone
        // holding many addresses, an IPv6 /32 is 16M /56s, lock every new visitor out). A shard is shared by few
        // clients unless the table is under attack, and nginx still limits each address.
        if (buckets.size >= BUCKETS_MAX) {
          if (spillMinute !== minute) { spillMinute = minute; spill.fill(0) }
          let h = 2166136261
          for (let i = 0; i < ip.length; i++) h = Math.imul(h ^ ip.charCodeAt(i), 16777619)
          const s = (h >>> 0) % SPILL_SHARDS
          spill[s] = Math.min(spill[s] + units, 0xffffffff)
          return spill[s] > RATE.perMinute
        }
      }
      buckets.set(ip, { minute, n: units })
      return units > RATE.perMinute
    }
    b.n += units
    return b.n > RATE.perMinute
  }

  function send (res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    // A JSON answer is for programs: no search engine lists it, whatever links to it.
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': buf.length, ...(/json/.test(type) ? { 'x-robots-tag': 'noindex' } : {}), ...extra })
    res.end(res.req.method === 'HEAD' ? undefined : buf)
  }

  // Every chain whose registry has loaded, with its readings window. A chain still loading is left out and named.
  function loaded () {
    const byChain = {}, missing = []
    for (const c of Object.keys(CHAINS)) {
      const r = registries.get(c)
      if (r?.records) byChain[c] = { records: r.records, window: windows[c].get().window }; else missing.push(c)
    }
    return { byChain, missing }
  }

  /** One token's passport, as the API and the MCP server both answer it: { status, body }. */
  async function passportOf (chain, address, hoursArg) {
    if (!CHAINS[chain]) return { status: 400, body: { error: `chain must be one of ${Object.keys(CHAINS).join(', ')}` } }
    const reg = registries.get(chain)
    if (!reg?.records) return { status: 503, body: { error: 'the issuer registry is not loaded yet', detail: reg?.error ?? null } }
    if (!ADDRESS.test(String(address || ''))) return { status: 400, body: { error: 'address must be 0x followed by 40 hex characters' } }
    const addr = String(address).toLowerCase()
    const hours = Math.min(PUBLIC_HOURS, windowH, Math.max(1, Number(hoursArg) || PUBLIC_HOURS))
    const inRegistry = reg.records.some((r) => r.address === addr)
    const w = windows[chain].get()
    const identity = inRegistry ? {} : nameOf(chain, addr)
    const p = buildPassport({ address: addr, chainId: CHAINS[chain].chainId, registry: reg.records, readings: inRegistry && w.window ? readingsOf(w.window.byToken.get(addr), addr) : [], identity, now: now(), windowH: Math.min(hours, windowH) })
    const elsewhere = inRegistry ? sameStockElsewhere(loaded().byChain, chain, addr, now(), hours * 3600) : []
    const listed = inRegistry ? null : impostors.get(chain)?.byAddress?.get(addr) || null
    const points = inRegistry && w.window ? seriesPoints(w.window.byToken.get(addr)).filter(([t]) => t >= now() - hours * 3600e3) : []
    // Where a reader can look for themselves: the token on GeckoTerminal (CoinGecko's DEX charts; its deepest pool when we
    // know it) and the contract
    // on the chain's public explorer. An impostor gets the same links; the page warns before it opens them.
    const C = CHAINS[chain]
    const links = {
      dex: inRegistry && p.latest && /^0x[0-9a-f]{40}$/.test(String(p.latest.dex_pool)) ? `https://www.geckoterminal.com/${C.gecko}/pools/${p.latest.dex_pool}` : `https://www.geckoterminal.com/${C.gecko}/tokens/${addr}`,
      explorer: C.explorer ? `${C.explorer}/token/${addr}` : null,
    }
    const sources = { ...SOURCES[chain], dex: 'DexScreener token-pairs, completed from GeckoTerminal pools when DexScreener lists 30', recorded_every_s: RECORDER_CADENCE_S,
      pools_counted: { min_liquidity_usd: MIN_POOL_LIQUIDITY_USD, paired_with_addresses: [...(C.referenceAssets || [])], rule: 'a pool prices the token only against the chain\'s dollar stablecoins or wrapped ETH, matched by address; the deepest one is used' } }
    return { status: 200, body: { ...p, chain, links, sources, same_stock_elsewhere: elsewhere, series_points: points, impostor_listing: listed ? { first_seen_at: listed.first_seen_at, same_deployer_impostors: listed.same_deployer_impostors ?? null } : null, case: caseSummary(chain, addr), readings_loaded: Boolean(w.window), registry_age_s: Math.round((now() - reg.at) / 1000) } }
  }

  /** What the server holds, per chain, with ages: the numbers behind /api/status and /status. */
  function statusNumbers () {
    return Object.fromEntries(Object.keys(CHAINS).map((c) => {
      const r = registries.get(c); const w = windows[c].get(); const imp = impostors.get(c)
      // readings_age_s is when the server last read the files; newest_reading_age_s is when the recorder last wrote one.
      let newest = null
      if (w.window) for (const e of w.window.byToken.values()) if (e.latestAt > (newest ?? -Infinity)) newest = e.latestAt
      const impAt = imp && imp.generated_at ? Date.parse(imp.generated_at) : NaN
      return [c, { registry_records: r?.records?.length ?? null, registry_age_s: r?.at ? Math.round((now() - r.at) / 1000) : null, registry_error: r?.error ?? null,
        readings_tokens: w.window ? w.window.byToken.size : null, readings_age_s: w.window ? Math.round((now() - w.window.loaded_at) / 1000) : null, readings_error: w.error ? internal(`readings ${c}`, w.error, 'the readings could not be read') : null,
        newest_reading_at: newest == null ? null : new Date(newest).toISOString(), newest_reading_age_s: newest == null ? null : Math.round((now() - newest) / 1000),
        impostors_listed: imp && imp.items ? imp.items.length : null, impostors_age_s: Number.isFinite(impAt) ? Math.round((now() - impAt) / 1000) : null }]
    }))
  }

  /** An address's archived case, short: what verify and the passport carry. The events are at /api/history/cases. */
  function caseSummary (chain, addr) {
    const c = history.caseOf(chain, addr)
    if (!c) return null
    const { events, ...rest } = c
    return { ...rest, events: events.length }
  }

  /** The one-bit answer for an address (evm/core/stocks/verify.mjs), from memory only. */
  function verifyOf (chain, address) {
    const reg = registries.get(chain)
    const addr = String(address || '').toLowerCase()
    const imp = impostors.get(chain)
    const r = verifyToken({
      chain, issuer: CHAINS[chain].issuer, address: addr, records: reg?.records || null, registryAt: reg?.at ?? null, now: now(),
      impostor: imp?.byAddress?.get(addr) || null, delisted: delisted.get(chain).get(addr) || null,
      otherChains: Object.keys(CHAINS).filter((c) => c !== chain).map((c) => ({ chain: c, records: registries.get(c)?.records || [] })),
    })
    if (r.status === 'ok') {
      r.body.passport = r.body.listed ? `${publicOrigin}${publicPath}/?${chain}=${encodeURIComponent(r.body.symbol)}` : `${publicOrigin}${publicPath}/?chain=${chain}&address=${r.body.address}`
      if (!r.body.listed && !r.body.impostor && imp?.truncated) r.body.impostor_list_truncated = true
      r.body.case = caseSummary(chain, r.body.address)
    }
    return r
  }

  /** The impostor list, newest first, optionally since a time: what an agent polls for new look-alikes. */
  function recentImpostors (chain, since) {
    const j = impostors.get(chain)
    if (!j || !j.items) throw unavailable(`the ${chain} impostor list is ${j?.error || 'not loaded'}`)
    const from = now() - BULK_WINDOW_DAYS * 86400e3
    const t = Math.max(from, since ? Date.parse(since) : from)
    const items = j.items.filter((i) => i.first_seen_at && Date.parse(i.first_seen_at) >= t)
      .sort((a, b) => String(b.first_seen_at).localeCompare(String(a.first_seen_at)))
    return { chain, generated_at: j.generated_at, since: since || null, window_days: BULK_WINDOW_DAYS, count: items.length, older: FULL_ARCHIVE, note: j.note, untrusted_text: UNTRUSTED_TEXT_NOTE, items: items.slice(0, BULK_MAX).map((i) => ({ address: i.address, symbol: i.symbol, name: i.name, kind: i.kind, imitates_symbol: i.registry_symbol ?? null, listed_address: i.registry_address ?? null, first_seen_at: i.first_seen_at })) }
  }

  /** The Base ↔ Robinhood matrix from memory, or null with the chains whose registry has not loaded. */
  function matrixOf () {
    const { byChain, missing } = loaded()
    const absent = MATRIX_VENUES.filter((c) => !byChain[c])
    if (absent.length) return { missing: absent, body: null }
    return { missing: [], body: matrix(byChain, { now: now() }) }
  }

  /**
   * The matrix as the MCP tool answers it: the rows for one share (by ISIN, by ticker, or both, which must agree), or
   * the top rows by |gap| when none is named. `total` is every row that matched; `rows` is what is shown.
   */
  function matrixFor ({ isin, symbol } = {}) {
    const m = matrixOf()
    if (!m.body) throw unavailable(`the ${m.missing.join(' and ')} registry is not loaded yet`)
    const named = isin != null || symbol != null
    let rows = m.body.rows
    let symbolIsins = null
    if (isin != null) rows = rows.filter((r) => r.isin.toLowerCase() === isin.toLowerCase())
    if (symbol != null) { symbolIsins = isinsOfTicker(loaded().byChain, symbol); rows = rows.filter((r) => symbolIsins.includes(r.isin)) }
    const { rows: _all, ...head } = m.body
    return { ...head, query: named ? { isin: isin ?? null, symbol: symbol ?? null, symbol_isins: symbolIsins } : null, total: rows.length, rows: named ? rows : rows.slice(0, MATRIX_MCP_TOP) }
  }

  // When and from where a registry answer comes: the issuer's own list, as the server last read it.
  const sourceOf = (c) => { const r = registries.get(c); return { generated_at: new Date(now()).toISOString(), source: `${CHAINS[c].issuer} issuer registry`, registry_age_s: r?.at ? Math.round((now() - r.at) / 1000) : null } }
  const mcp = createMcpHttp({
    chains: Object.keys(CHAINS),
    log,
    maxHours: Math.min(PUBLIC_HOURS, windowH),
    find: (c, q) => { const { byChain } = loaded(); if (!byChain[c]) throw unavailable(`the ${c} registry is not loaded yet`); return { ...findAcross({ [c]: byChain[c] }, q), ...sourceOf(c) } },
    list: (c) => {
      const recs = registries.get(c)?.records
      if (!recs) throw unavailable(`the ${c} registry is not loaded yet`)
      const tokens = recs.map((r) => ({ symbol: r.symbol, name: r.name ?? null, address: r.address, isin: r.isin, multiplier: r.multiplier, has_reference_price: r.reference?.price_usd > 0, minted: r.supplied !== false }))
      return { chain: c, issuer: CHAINS[c].issuer, ...sourceOf(c), count: tokens.length, minted: tokens.filter((t) => t.minted).length, with_reference_price: tokens.filter((t) => t.has_reference_price).length, tokens }
    },
    passport: passportOf,
    verify: verifyOf,
    recent: recentImpostors,
    matrix: matrixFor,
  })
  const MCP_HEADERS = Object.freeze({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id', 'access-control-allow-methods': 'POST, OPTIONS', 'cache-control': 'no-store' })

  function clientIp (req) {
    // nginx sets X-Real-IP from the Cloudflare-restored client address; only trust it from the loopback proxy.
    const peer = req.socket.remoteAddress || ''
    return /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(peer) && req.headers['x-real-ip'] ? String(req.headers['x-real-ip']) : peer
  }

  async function routeMcp (req, res) {
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', MCP_HEADERS)
    // A person who opens the MCP address in a browser is sent to the page's section on connecting an agent; an MCP
    // client probing for an event stream (Accept: text/event-stream) gets the 405 the spec asks for.
    const accept = String(req.headers.accept || '')
    if (req.method === 'GET' && accept.includes('text/html') && !accept.includes('text/event-stream')) {
      return send(res, 302, '', 'text/plain', { location: publicOrigin + publicPath + '/#mcp', 'cache-control': 'no-store' })
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST one JSON-RPC message; this server offers no SSE stream' }, undefined, { ...MCP_HEADERS, allow: 'POST, OPTIONS' })
    if (limited(clientIp(req))) return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'too many requests, try again in a minute' } }, undefined, { ...MCP_HEADERS, 'retry-after': '60' })
    // A JSON-RPC message is JSON. Anything else is 415 (external audit, 12.11): text/plain and form bodies are what a
    // browser can send from another site without asking first.
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Content-Type must be application/json' } }, undefined, MCP_HEADERS)
    // Streamable HTTP: a client names the protocol version it negotiated; one this server does not speak is a 400.
    const pv = req.headers['mcp-protocol-version']
    if (pv && !SUPPORTED_VERSIONS.includes(String(pv))) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `unsupported MCP-Protocol-Version ${String(pv).slice(0, 40)}; this server speaks ${SUPPORTED_VERSIONS.join(', ')}` } }, undefined, MCP_HEADERS)
    const chunks = []
    let size = 0
    for await (const c of req) { size += c.length; if (size > MCP_MAX_BODY) return send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } }, undefined, MCP_HEADERS); chunks.push(c) }
    const raw = Buffer.concat(chunks).toString('utf8')
    // A batch verify is several lookups: it counts one unit per ten addresses beyond the first ten.
    const extra = batchUnits(raw) - 1
    if (extra > 0 && limited(clientIp(req), extra)) return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'too many requests, try again in a minute' } }, undefined, { ...MCP_HEADERS, 'retry-after': '60' })
    const { status, json } = await mcp.handle(raw)
    if (status < 400) analytics.mcp(clientIp(req), req.headers, raw, mcp.toolNames)
    return json == null ? send(res, status, '', 'text/plain', MCP_HEADERS) : send(res, status, json, undefined, MCP_HEADERS)
  }

  async function route (req, res) {
    let url
    try { url = new URL(req.url, 'http://local') } catch (_) { return send(res, 404, { error: 'not found' }) }
    if (url.pathname === BASE_PATH + '/mcp') return routeMcp(req, res)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' }, undefined, { allow: 'GET, HEAD' })
    // A release that cannot read any issuer registry answers every lookup with 503: it must fail the deploy gate, not pass.
    if (url.pathname === '/healthz') {
      const chains = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, Boolean(registries.get(c)?.records)]))
      const ok = Object.values(chains).some(Boolean)
      return send(res, ok ? 200 : 503, { ok, registries: chains }, undefined, { 'cache-control': 'no-store' })
    }
    // The page's relative URLs need the trailing slash; the bare prefix redirects to it, keeping the query.
    if (url.pathname === BASE_PATH) return send(res, 301, { moved: BASE_PATH + '/' }, undefined, { location: BASE_PATH + '/' + url.search })
    if (!url.pathname.startsWith(BASE_PATH + '/')) return send(res, 404, { error: 'not found' })
    const sub = url.pathname.slice(BASE_PATH.length)
    if (sub === '/') { if (req.method === 'GET') analytics.load(clientIp(req), req.headers, '/'); return send(res, 200, pageFor(url), STATIC['/'][1], { 'cache-control': 'no-cache' }) }
    if (STATIC[sub]) { const s = static_[sub]; return send(res, 200, s.body, s.type, { 'cache-control': 'public, max-age=86400' }) }
    // The old address of the changelog: it is a docs page now.
    if (sub === '/CHANGELOG.md') { res.writeHead(301, { location: publicPath + '/docs/changelog.md', 'cache-control': 'public, max-age=3600' }); return res.end() }
    if (sub === '/robots.txt') return send(res, 200, robots, 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600' })
    if (sub === '/.well-known/security.txt') return send(res, 200, securityTxt(site, sourceUrl, now()), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600' })
    // The listed tokens come from the registries in memory, so the sitemap follows a listing within PAGE_CACHE_MS.
    if (sub === '/sitemap.xml') {
      const build = () => sitemapXml(sitemapUrls({ site, docs: docs.keys(), released: releasedIso, symbols: Object.fromEntries(Object.keys(CHAINS).map((c) => [c, (registries.get(c)?.records || []).map((r) => r.symbol).filter(Boolean)])) }))
      return send(res, 200, cachedPage('/sitemap.xml', build), 'application/xml; charset=utf-8', { 'cache-control': 'public, max-age=3600' })
    }
    if (sub === '/llms.txt') return send(res, 200, llms, 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' })
    if (sub === '/llms-full.txt') return send(res, 200, llmsFull, 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' })
    if (sub === '/docs' || sub === '/docs/' || sub.startsWith('/docs/')) {
      const rel = sub === '/docs' || sub === '/docs/' ? 'README.md' : sub.slice('/docs/'.length)
      if (!docs.has(rel)) return send(res, 404, { error: 'no such page', index: publicOrigin + publicPath + '/docs/' })
      // A browser gets the page; an agent, curl or ?format=md gets the markdown. Varies by Accept, so it is not shared-cached.
      const wantsHtml = rel.endsWith('.md') && url.searchParams.get('format') !== 'md' && /text\/html/.test(String(req.headers.accept || ''))
      if (wantsHtml) analytics.load(clientIp(req), req.headers, '/docs/' + rel)
      if (wantsHtml) return send(res, 200, docPage(rel), 'text/html; charset=utf-8', { 'cache-control': 'private, max-age=300', vary: 'Accept' })
      // The markdown is the same page for an agent: a search engine that gets it is pointed at the HTML one.
      const md = rel.endsWith('.md') ? { link: `<${docUrl(site, rel)}>; rel="canonical"` } : {}
      return send(res, 200, docs.get(rel), rel.endsWith('.json') ? 'application/schema+json; charset=utf-8' : 'text/markdown; charset=utf-8', { 'cache-control': 'private, max-age=300', vary: 'Accept', 'access-control-allow-origin': '*', ...md })
    }
    // The badge: an image other pages embed. It answers from memory, is cached at the CDN and is not rate limited per
    // address of the requester, because image proxies fetch it from a handful of addresses. It is always 200: a broken
    // image on someone else's page would read as our outage.
    if (sub === '/badge.svg') {
      const c = url.searchParams.get('chain'), a = url.searchParams.get('address')
      const r = CHAINS[c] ? verifyOf(c, a) : { status: 'unavailable', body: { address: a } }
      const st = badgeState(r)
      const cache = st === 'unavailable' ? 'no-store' : st === 'listed' ? 'public, max-age=300' : 'public, max-age=60'
      return send(res, 200, badgeSvg(r, { address: String(a || '').toLowerCase() }), 'image/svg+xml; charset=utf-8', { 'cache-control': cache, 'access-control-allow-origin': '*' })
    }
    if (sub === '/verify' || sub === '/api/verify') {
      if (limited(clientIp(req))) return send(res, 429, { error: 'too many requests, try again in a minute' }, undefined, { 'retry-after': '60', 'access-control-allow-origin': '*' })
      const c = url.searchParams.get('chain')
      if (!CHAINS[c]) return send(res, 400, { error: `chain must be one of ${Object.keys(CHAINS).join(', ')}` }, undefined, { 'access-control-allow-origin': '*' })
      const r = verifyOf(c, url.searchParams.get('address'))
      if (r.status === 'bad_address') return send(res, 400, r.body, undefined, { 'access-control-allow-origin': '*' })
      if (r.status === 'unavailable') return send(res, 503, r.body, undefined, { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'retry-after': '60' })
      return send(res, 200, r.body, undefined, { 'access-control-allow-origin': '*', 'cache-control': r.body.listed ? 'public, max-age=300' : 'public, max-age=60' })
    }
    if (sub === '/status') {
      analytics.load(clientIp(req), req.headers, '/status')
      return send(res, 200, cachedPage('/status', () => withPageHead('/status', statusPage({ chains: statusNumbers(), now: now(), version: appVersion, assets: { css: `style.css?v=${version('/style.css')}`, docsCss: `docs.css?v=${version('/docs.css')}`, beacon: `beacon.js?v=${version('/beacon.js')}` } }), STATUS_DESCRIPTION)), 'text/html; charset=utf-8', { 'cache-control': 'no-store' })
    }
    if (sub === '/history') {
      analytics.load(clientIp(req), req.headers, '/history')
      return send(res, 200, cachedPage('/history', () => withPageHead('/history', historyPage({ store: history, chains: Object.keys(CHAINS), now: now(), version: appVersion, assets: { css: `style.css?v=${version('/style.css')}`, docsCss: `docs.css?v=${version('/docs.css')}`, beacon: `beacon.js?v=${version('/beacon.js')}` } }))), 'text/html; charset=utf-8', { 'cache-control': 'public, max-age=300' })
    }
    if (!sub.startsWith('/api/')) return send(res, 404, { error: 'not found' })

    if (limited(clientIp(req), sub === '/api/passport' ? PASSPORT_UNITS : 1)) return send(res, 429, { error: 'too many requests, try again in a minute' }, undefined, { 'retry-after': '60' })

    const chain = url.searchParams.get('chain')
    if (sub === '/api/hit') {
      const hit = parseHit(url.searchParams, Object.keys(CHAINS), (p) => p === '/' || p === '/history' || p === '/status' || (p.startsWith('/docs/') && docs.has(p.slice(6))))
      if (hit) analytics.hit(clientIp(req), req.headers, hit)
      return send(res, 204, '', 'text/plain', { 'cache-control': 'no-store' })
    }
    if (sub === '/api/status') {
      return send(res, 200, statusNumbers(), undefined, { 'cache-control': 'no-store' })
    }
    if (sub === '/api/history/cases' || sub === '/api/history/registry') {
      const cors = { 'access-control-allow-origin': '*' }
      const chains = chain ? [chain] : Object.keys(CHAINS)
      if (chain && !CHAINS[chain]) return send(res, 400, { error: `chain must be one of ${Object.keys(CHAINS).join(', ')}` }, undefined, cors)
      if (sub === '/api/history/registry') {
        const date = url.searchParams.get('date')
        if (date && !chain) return send(res, 400, { error: 'date needs a chain' }, undefined, cors)
        const out = chains.map((c) => history.registry(c, { date }))
        if (out[0].status === 400) return send(res, 400, { error: out[0].error }, undefined, cors)
        return send(res, 200, chain ? out[0] : { chains: Object.fromEntries(chains.map((c, i) => [c, out[i]])) }, undefined, { ...cors, 'cache-control': 'public, max-age=300' })
      }
      const since = url.searchParams.get('since')
      if (since && !isIsoTime(since)) return send(res, 400, { error: 'since must be an ISO time' }, undefined, cors)
      const event = url.searchParams.get('event')
      if (event && !['opened', 'kind_changed', 'listed', 'gone'].includes(event)) return send(res, 400, { error: 'event must be one of opened, kind_changed, listed, gone' }, undefined, cors)
      const opts = { since, event, limit: Math.min(BULK_MAX, Math.max(1, Number(url.searchParams.get('limit')) || BULK_MAX)) }
      const out = chains.map((c) => history.cases(c, opts))
      return send(res, 200, chain ? out[0] : { chains: Object.fromEntries(chains.map((c, i) => [c, out[i]])) }, undefined, { ...cors, 'cache-control': 'public, max-age=300' })
    }
    if (sub === '/api/matrix') {
      const m = matrixOf()
      if (!m.body) return send(res, 503, { error: `the ${m.missing.join(' and ')} registry is not loaded yet`, missing: m.missing }, undefined, { 'retry-after': '30' })
      return send(res, 200, { market_now: usEquitySession(now()), ...m.body }, undefined, { 'cache-control': 'public, max-age=60' })
    }
    if (sub === '/api/impostors') {
      if (chain && !CHAINS[chain]) return send(res, 400, { error: `chain must be one of ${Object.keys(CHAINS).join(', ')}` })
      const limit = Math.min(BULK_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 30))
      const from = now() - BULK_WINDOW_DAYS * 86400e3
      const out = {}
      for (const c of Object.keys(CHAINS)) {
        if (chain && c !== chain) continue
        const j = impostors.get(c)
        const recent = j?.items ? j.items.filter((i) => i.first_seen_at && Date.parse(i.first_seen_at) >= from) : null
        out[c] = j?.items ? { generated_at: j.generated_at, counts: j.counts, listed: j.listed, note: j.note, untrusted_text: UNTRUSTED_TEXT_NOTE, window_days: BULK_WINDOW_DAYS, in_window: recent.length, items: recent.slice(0, limit), older: FULL_ARCHIVE } : { error: j?.error || 'not loaded' }
      }
      return send(res, 200, { chains: out }, undefined, { 'cache-control': 'public, max-age=300' })
    }
    if (sub === '/api/find' || sub === '/api/overview') {
      if (chain && !CHAINS[chain]) return send(res, 400, { error: `chain must be one of ${Object.keys(CHAINS).join(', ')}` })
      const { byChain, missing } = loaded()
      if (!Object.keys(byChain).length) return send(res, 503, { error: 'no issuer registry is loaded yet' }, undefined, { 'retry-after': '30' })
      const scope = chain ? (byChain[chain] ? { [chain]: byChain[chain] } : null) : byChain
      if (!scope) return send(res, 503, { error: `the ${chain} registry is not loaded yet` }, undefined, { 'retry-after': '30' })
      if (sub === '/api/overview') return send(res, 200, { market_now: usEquitySession(now()), chains: overview(scope, { now: now() }), missing }, undefined, { 'cache-control': 'public, max-age=60' })
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 64)
      if (!q) return send(res, 400, { error: 'q is required' })
      return send(res, 200, { ...findAcross(scope, q), missing }, undefined, { 'cache-control': 'public, max-age=60' })
    }
    if (sub === '/api/passport') {
      const r = await passportOf(chain, url.searchParams.get('address'), url.searchParams.get('hours'))
      // The chart's points only for a caller that draws them.
      if (r.status === 200 && url.searchParams.get('series') !== '1') { const { series_points: _sp, ...rest } = r.body; r.body = rest }
      return send(res, r.status, r.body, undefined, r.status === 200 ? { 'cache-control': 'public, max-age=60' } : r.status === 503 ? { 'retry-after': '30' } : {})
    }
    return send(res, 404, { error: 'not found' })
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => { log('[stocks-web] ' + (e && e.stack || e)); if (!res.headersSent) send(res, 500, { error: 'internal error' }) })
  })
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  let timer = null
  return {
    server, refreshAll,
    async start (port, host) {
      await refreshAll()
      timer = setInterval(() => { refreshAll().catch(() => {}) }, REGISTRY_TTL_MS); timer.unref()
      await new Promise((resolve) => server.listen(port, host, resolve))
      return server.address()
    },
    async stop () { clearInterval(timer); await new Promise((resolve) => server.close(resolve)) },
  }
}

if (isEntryPoint(import.meta.url)) {
  const app = createStocksWeb()
  const a = await app.start(Number(process.env.STOCKS_WEB_PORT || 3005), process.env.STOCKS_WEB_HOST || '127.0.0.1')
  console.log(`[stocks-web] listening on ${a.address}:${a.port}`)
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.stop().finally(() => process.exit(0)) })
}
