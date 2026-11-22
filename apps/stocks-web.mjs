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
//   GET /stocks/api/exam               the latest public exam, summarized (apps/stocks-exam.mjs); 503 when none from the last 36 h
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
import { createMcpHttp, SUPPORTED_VERSIONS, MAX_VERIFY_BATCH } from './stocks-mcp-http.mjs'
import { verifyToken, badgeSvg, badgeState, issuerPrefixOf, ISSUER_LABEL as VERIFY_ISSUER_LABEL } from '../evm/core/stocks/verify.mjs'
import { mintedOf } from '../evm/core/stocks/registries.mjs'
import { createDocsRenderer } from './stocks-docs.mjs'
import { stampList, listProof, listBytes } from '../evm/core/stocks/list-proof.mjs'
import { canonicalRegistry } from '../evm/core/stocks/history.mjs'
import { isIsoTime } from '../scripts/lib/mcp-args.mjs'
import { statusPage, usageOf, appsSentenceHtml, withApps } from './stocks-status.mjs'
import { archiveAt } from './stocks-archive.mjs'
import { statsPage, lastRuns, STATS_GATE } from './stocks-stats.mjs'
import { ANCHOR_FILE_RE, anchorDays, anchorFor } from '../scripts/stocks/anchor.mjs'
import { makeReceipt } from '../evm/core/stocks/receipt.mjs'
import { dailySummaries } from '../scripts/stocks/analytics-report.mjs'
import { createHistoryStore, historyPage, BULK_WINDOW_DAYS, BULK_MAX, FULL_ARCHIVE } from './stocks-history.mjs'
import { createAnalytics, parseHit } from './stocks-analytics.mjs'
import { findAcross, sameStockElsewhere, overview, matrix, isinsOfTicker, MATRIX_VENUES } from '../evm/core/stocks/cross-chain.mjs'
import { symbolLabel, nameLabel, UNTRUSTED_TEXT_NOTE } from '../evm/core/stocks/untrusted-text.mjs'
import { createExamCache, EXAM_CHIP_HTML } from './stocks-exam.mjs'
import { boardOf, withBoard, BOARD_LIMIT } from './stocks-board.mjs'
import { createPassSales, rpcCaller } from './pass-sales.mjs'
import { passBazaar, openApiOf } from './x402-discovery.mjs'

// The paid-pass module is a host file, never a tracked one (owner, 15.11): this repository is exported to a public
// one, and the money path is not for export. A checkout without the file is the free service exactly; the import is
// optional on purpose, and its absence only ever disables the passes, never anything else.
let createX402 = null
try { ({ createX402 } = await import('../evm/core/stocks/x402.mjs')) } catch (_) { createX402 = null }

/**
 * Whether this host asked for paid passes. The module being absent is the normal, quiet case: a checkout without it
 * is the free service, which is most of the world. The case that must NOT be quiet is a host that names a payee and
 * a settlement key and then runs a release the module never reached: that host believes it is selling passes and is
 * serving plain 429s instead (16.11: a deploy carried no host files, and the module was gone from the release for a
 * day without a sound).
 */
export function x402Missing (env = process.env, has = createX402 != null) {
  const asked = Boolean(env.STP_X402_PAY_TO) || Boolean(env.STP_X402_KEY_FILE)
  return asked && !has
}

/** The landing's paid-pass block (apps/stocks-web/index.html), cut out where passes are off. */
export const PAY_SECTION_RE = /\n  <section class="pay" id="pay"[\s\S]*?<\/section>\n/

/** What the site says at startup in that case. One line, because an alert nobody reads is the same as silence. */
export const X402_MISSING_LINE = '[x402] THE HOST NAMES A PAYEE OR A KEY FILE AND THE MODULE IS NOT IN THIS RELEASE: passes are off, every refusal is a plain 429. Put evm/core/stocks/x402.mjs under the host files directory (deployment/PUBLISHING.md) so a deploy carries it.'

/** How many matrix rows the MCP tool returns when no share is named. */
export const MATRIX_MCP_TOP = 20

/**
 * The biggest /verify batch, served only with a pass (passGate): 150 addresses, 15 units. Not more, because the batch
 * is a GET: 150 addresses are about 6.5 KB of request line, under nginx's default 8 KB buffer, and the proxy refuses
 * any other method. 500 was the first idea; its 21 KB URL never reached the app (a 431 from Node itself, measured).
 */
export const PAID_VERIFY_BATCH = 150
/** Failed purchases a client may make on passGate in PASS_FAIL_WINDOW_MS before it is refused with a 429. */
export const PASS_FAIL_MAX = 5
export const PASS_FAIL_WINDOW_MS = 10 * 60e3

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = path.join(HERE, 'stocks-web')
const STATIC = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/docs.css': ['docs.css', 'text/css; charset=utf-8'],
  '/docs.js': ['docs.js', 'text/javascript; charset=utf-8'],
  '/beacon.js': ['beacon.js', 'text/javascript; charset=utf-8'],
  '/seal.js': ['seal.js', 'text/javascript; charset=utf-8'],
  '/og.png': ['og.png', 'image/png'],
  '/logo.png': ['logo.png', 'image/png'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  // The guard's shield: our emblem inside a shield, beside the install line and in the repository's own README.
  '/shield.svg': ['shield.svg', 'image/svg+xml'],
  '/favicon.ico': ['logo.png', 'image/png'],
  // The two typefaces, served from here (pentest, 22.11): from Google, every page view handed the reader's address to
  // a third party. Variable woff2, the latin and latin-ext subsets; style.css names them. Licence: fonts/OFL.txt.
  '/fonts/onest-latin.woff2': ['fonts/onest-latin.woff2', 'font/woff2'],
  '/fonts/onest-latin-ext.woff2': ['fonts/onest-latin-ext.woff2', 'font/woff2'],
  '/fonts/martian-mono-latin.woff2': ['fonts/martian-mono-latin.woff2', 'font/woff2'],
  '/fonts/martian-mono-latin-ext.woff2': ['fonts/martian-mono-latin-ext.woff2', 'font/woff2'],
  '/fonts/OFL.txt': ['fonts/OFL.txt', 'text/plain; charset=utf-8'],
})
/** The one line the MCP registry reads at /.well-known/mcp-registry-auth: an Ed25519 public key, base64 of 32 bytes. */
export const MCP_REGISTRY_AUTH_RE = /^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/
/** The claim Glama reads at /mcp/.well-known/glama.json to prove this endpoint is ours (deployment/glama-claim). */
export const GLAMA_CLAIM_RE = /^glama_claim_[A-Za-z0-9_-]{16,96}$/
export const GLAMA_CLAIM_PATH = '/mcp/.well-known/glama.json'
/** 402index.io's domain claim: the SHA-256 hex of the token it issued, at this path (https://402index.io/verify). */
export const INDEX402_PATH = '/.well-known/402index-verify.txt'
export const INDEX402_HASH_RE = /^[0-9a-fA-F]{64}$/

export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
})
const REGISTRY_TTL_MS = 5 * 60e3
export const PAGE_CACHE_MS = 30e3 // /status and /history: one build per this long
const RATE = { perMinute: 60 } // units in any RATE_WINDOW_S seconds, per client key
const RATE_WINDOW_S = 60
const SWEEP_EVERY_S = 10
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
/** The llms.txt index: title, one line, then every page with its first sentence. `passLine` is added when paid passes are on. */
export function llmsTxt (docs, origin, version, passLine = null) {
  const order = ['README.md', 'tutorials/', 'how-to/', 'reference/', 'explanation/', 'legal.md', 'changelog.md']
  const rank = (k) => order.findIndex((o) => k === o || k.startsWith(o))
  const pages = [...docs.keys()].filter((k) => k.endsWith('.md') && k !== 'README.md').sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const titleOf = (t) => (t.match(/^#\s+(.+)$/m) || [])[1] || 'Untitled'
  const lineOf = (t) => (t.split('\n').find((l) => /^[A-Z][^|#`>\-*]/.test(l.trim()) && !/^v\d/.test(l.trim())) || '').trim().replace(/\s+/g, ' ').slice(0, 180)
  const sections = {}
  for (const k of pages) (sections[k.split('/').length > 1 ? k.split('/')[0] : 'more'] ||= []).push(`- [${titleOf(docs.get(k))}](${origin}/docs/${k}): ${lineOf(docs.get(k))}`)
  const head = ['# Proof of Stock', '', `> Tokenized stocks, the real-world assets (RWA) that trade on-chain: is a token the issuer's tokenized stock, and how far does the chain trade from the issuer's price? Base (Coinbase registry) and Robinhood Chain (Robinhood registry). Public read-only MCP server: ${origin}/mcp. Version ${version}.`, '',
    'Contact: hello@proofofstock.xyz. Read-only: nothing here trades or signs for you. Not investment advice.', '']
  // Where an agent starts: the endpoints and the one-file copy of every page, before the page index.
  const start = [
    `- [MCP server](${origin}/mcp): Streamable HTTP, POST one JSON-RPC message, no key or account` + (docs.has('reference/tools.md') ? `; tools: ${origin}/docs/reference/tools.md` : ''),
    docs.has('reference/http-api.md') ? `- [HTTP API](${origin}/docs/reference/http-api.md): read-only JSON routes, e.g. ${origin}/verify?chain=base&address=0x…` : null,
    docs.has('reference/passport.schema.json') ? `- [Passport JSON Schema](${origin}/docs/reference/passport.schema.json): the shape of one passport answer` : null,
    docs.has('how-to/check-before-listing.md') ? `- [Pre-trade guard for agents](${origin}/docs/how-to/check-before-listing.md): npm install @proofofstock/guard, beforeBuy() refuses a token the issuer did not list (fails closed, no dependencies)` : null,
    passLine,
    `- [Every page in one file](${origin}/llms-full.txt)`,
    `- [Status](${origin}/status), [the week's cases](${origin}/history) and [the daily anchors](${origin}/anchors/)`,
  ].filter(Boolean)
  head.push('## Start here', '', ...start, '')
  // An agent that reads only this file used to learn what we answer and nothing about why it can be believed. These
  // five are built, live and were invisible here (information audit, 13.11). Each one is a thing it can check itself.
  head.push('## How to check us', '',
    'We are a centralised service, and that is why every claim here comes with a way to check it without us. The chain is not here so that we can be trusted: it is here so that we cannot rewrite yesterday.', '',
    `- Every verdict names the issuer list it was decided against, by the SHA-256 of its sorted addresses, with the command that computes the same hash from the issuer's own API and a URL of that exact list frozen: ${origin}/api/list/<hex>.`,
    `- Add \`&receipt=1\` to ${origin}/verify and keep the answer: scripts/receipt-check.mjs in the repository rechecks it months later, after the issuer's list has changed.`,
    '- Every answer carries `issuer_factory`: whether the issuer\'s own token factory created that contract, read from the chain, with the block and transaction. A second source beside the list.',
    `- Once a day a manifest of that day's data files is timestamped into Bitcoin through OpenTimestamps, so a reading cannot be rewritten afterwards: ${origin}/anchors/. The same hash is written on Base and on Robinhood Chain as mirrors, for reach, with Bitcoin as the root: those two chains are sequenced by the issuers we check. The MCP tool \`verify_anchor\` hands over the hash, the state of the Bitcoin proof and each mirror transaction, for a day of your choosing.`,
    '- Once a day a public exam asks this service about every token whose right answer comes from the issuers; the reports are committed to the `exam` branch of the public repository, with the hash of the question set.',
    '- An independent check runs on GitHub\'s runners, not on this host, and rehashes each issuer\'s list straight from the issuer. It asks to run every 30 minutes; GitHub\'s scheduler drops most of those, so in practice it lands a handful of times a day. Every run is public: github.com/proofofstock/proof-of-stock/actions.',
    '',
    'Two things worth knowing before you read an answer: `recent_impostors` and `/api/history/cases` are a 7-day window, not the whole list (the answer carries `window_days` and `listed_total`), and the rate limit is 60 units in any 60 seconds, where a passport costs 3 and a batch verify costs one per ten addresses.',
    '')
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
  roots = { base: process.env.STOCKS_ROOT_BASE || '/var/lib/pos/base', robinhood: process.env.STOCKS_ROOT_ROBINHOOD || '/var/lib/pos/robinhood' },
  fetchImpl = fetch, now = () => Date.now(), windowH = DEFAULT_WINDOW_H, log = (m) => console.log(m),
  publicOrigin = process.env.STOCKS_PUBLIC_ORIGIN || 'https://proofofstock.xyz',
  publicPath = process.env.STOCKS_PUBLIC_PATH ?? '',
  analytics: analyticsOpts = {}, // apps/stocks-analytics.mjs options; { enabled: false } turns the counter off
  exam: examOpts = {}, // apps/stocks-exam.mjs options; { url: null } turns the exam summary off
  x402: x402Opts = {}, // evm/core/stocks/x402.mjs options; {} with no host env is off, and then nothing changes
  // The module itself, so a test can be a host that asked for passes and did not get it. Null is that host.
  x402Module = createX402,
  // How the Paid passes block reads the settlement wallet on Base (apps/pass-sales.mjs): a JSON-RPC call function.
  // Unset, a node at STP_RPC_BASE or the public one, over fetchImpl; a test passes its own chain.
  baseCall = null,
  source, // the source link: undefined = package.json decides (stp.source_public), null = none, a URL = that URL
  // The claim Glama reads to see that the connector at /mcp is ours. It belongs to the host, never to this
  // repository: the repository is exported publicly, and an ownership claim has no business being published.
  // Set on the host in /etc/pos/web.env (deployment/PUBLISHING.md); without it the path is a plain 404.
  glamaClaim = process.env.STP_GLAMA_CLAIM || null,
  // 402index.io's domain claim (22.11): the SHA-256 hash of the token it issues, which it reads at
  // /.well-known/402index-verify.txt. The hash only, never the token; on the host, like the Glama claim, never in git.
  index402Hash = process.env.STP_402INDEX_HASH || null,
} = {}) {
  const registries = new Map() // chain → { records, at, error }
  // Addresses that were listed and have left the registry, since this process started: chain → Map(address → { at, symbol }).
  const delisted = new Map(Object.keys(CHAINS).map((c) => [c, new Map()]))
  const windows = Object.fromEntries(Object.keys(CHAINS).map((c) => [c, createWindowCache({ root: roots[c], windowH, now })]))
  const names = new Map() // chain → Map(address → { symbol, name }), from stock-names.json
  const impostors = new Map() // chain → the parsed impostors.json, or { error }
  const buckets = new Map() // client key → { sec, n, slots }: its last second seen, units in the window, units per second
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
  // The public exam's report is read from GitHub in the background, at most every 30 minutes; a request reads memory.
  // Like the source link, only while the source is public: before that there is no exam branch to read or link to.
  const exam = createExamCache({ fetchImpl, now, log, ...(sourceUrl ? {} : { url: null }), ...examOpts })
  // The release date is the changelog's for this version ("## [0.3.0] - 2026-11-10"), shown as "10 Nov 2026".
  // The sitemap's lastmod for the home and the docs is the same date, as YYYY-MM-DD (null when unreleased).
  const releasedIso = (() => {
    try {
      const m = fs.readFileSync(path.join(path.dirname(DOCS_DIR), 'CHANGELOG.md'), 'utf8').match(new RegExp('^## \\[' + appVersion.replace(/\./g, '\\.') + '\\] - (\\d{4}-\\d{2}-\\d{2})', 'm'))
      return m ? m[1] : null
    } catch (_) { return null }
  })()
  const released = releasedIso ? new Date(releasedIso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'unreleased'
  // Each docs page opens with its version, and it is filled in here from package.json, where the page footer's comes
  // from. Written by hand it went stale a release later: on 13.11 every page named the release before while the
  // server, server.json and llms.txt named the current one, and the HTML page showed both at once. One source, or
  // none. No date beside it, for the reason the footer has none: a release date reads as "last updated".
  for (const [k, t] of docs) if (t.includes('__VERSION__')) docs.set(k, t.replaceAll('__VERSION__', appVersion))
  let docsPages = null // built once the static assets are versioned, below
  // The paid pass over the free minute (owner, 15.11): a sporadic reader never pays and sees nothing new; a client
  // the limiter refuses may buy 0.01 USDC (x402, base) for ten minutes at ten times the rate. Off unless the host
  // names a payee and a settlement key file, without them the free world is byte-identical to the day before.
  if (x402Missing(process.env, x402Module != null)) log(X402_MISSING_LINE)
  // The payment module's alarms reach the owner through stp-health (scripts/stocks/health-check.mjs, paymentChecks),
  // which reads /api/status every 15 minutes: a broadcast with no receipt is the one the module can only write to the
  // journal, so the log line is caught here and kept for a day. The module itself is unchanged (owner, 20.11).
  const lateSettlements = []
  const x402Log = (m) => {
    const hit = /^\[x402\] ALERT late settlement (0x[0-9a-f]{64})/.exec(String(m))
    if (hit) { lateSettlements.push({ transaction: hit[1], at: new Date(now()).toISOString() }); if (lateSettlements.length > 50) lateSettlements.shift() }
    log(m)
  }
  const x402 = x402Module
    ? x402Module({ ...x402Opts, fetchImpl, now, log: x402Log })
    : { enabled: false, passActive: () => false, accepts: () => null, purchase: async () => ({ ok: false, error: 'paid passes are not enabled' }) }
  // The one paid route, as catalogues read it (apps/x402-discovery.mjs): the Bazaar extension in its 402, and /openapi.json.
  const PASS_BAZAAR = x402.enabled ? passBazaar(x402) : null
  const openApi = x402.enabled ? openApiOf({ origin: publicOrigin + publicPath, priceUsd: x402.priceUsd, passMinutes: x402.passMinutes, passRate: x402.passRate, version: appVersion }) : null
  const passLine = x402.enabled
    ? `- [Over the free minute](${publicOrigin + publicPath}/docs/how-to/pay-per-call.md): pay ${x402.priceUsd} USDC on base (x402 v1 or v2) for a ${x402.passMinutes}-minute pass at ${x402.passRate} units a minute; buy one up front at ${publicOrigin + publicPath}/api/pass`
    : null
  const llms = llmsTxt(docs, publicOrigin + publicPath, appVersion, passLine)
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
  static_['/'].body = Buffer.from(String(static_['/'].body).replace('href="style.css"', `href="style.css?v=${version('/style.css')}"`).replace('src="app.js"', `src="app.js?v=${version('/app.js')}"`).replace('src="beacon.js"', `src="beacon.js?v=${version('/beacon.js')}"`).replace('src="seal.js"', `src="seal.js?v=${version('/seal.js')}"`)
    .replaceAll('__MCP_URL__', publicOrigin + publicPath + '/mcp').replaceAll('__VERSION__', appVersion).replaceAll('__RELEASED__', released)
    .replace('<!--source-->', sourceUrl ? sourceIcon(sourceUrl) : '').replace('<!--exam-->', sourceUrl ? EXAM_CHIP_HTML : '')
    // The paid-pass block promises a payment path: a server without one (passes off, a local copy) never shows it.
    .replace(PAY_SECTION_RE, (block) => (x402.enabled ? block : '\n')))
  // What crawlers and link previews read: the preview image and logo by content hash (a new image is a new URL, so
  // X and Telegram fetch it again), robots.txt and the head tags every page gets.
  const site = publicOrigin + publicPath
  const seo = { image: `${site}/og.png?v=${version('/og.png')}`, logo: `${site}/logo.png?v=${version('/logo.png')}` }
  const robots = robotsTxt(site, publicPath)
  // The official MCP registry proves we own proofofstock.xyz by this file: the public half of the key the publish
  // workflow signs with (.github/workflows/mcp-registry.yml). Only a well-formed line is served; otherwise 404.
  const registryAuth = (() => { try { const t = fs.readFileSync(new URL('../deployment/mcp-registry-auth', import.meta.url), 'utf8').trim(); return MCP_REGISTRY_AUTH_RE.test(t) ? t + '\n' : null } catch (_) { return null } })()
  // Only a well-formed claim is served, so a truncated or mistyped one answers 404 rather than a wrong claim.
  const claim = GLAMA_CLAIM_RE.test(String(glamaClaim || '').trim()) ? String(glamaClaim).trim() : null
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
  // The last lists this server read, per chain, by registry_hash: GET /api/list/<hex> serves them before the recorder's
  // archive has them (it reads on its own 15-minute clock). Eight per chain; the archive holds the rest.
  const recentLists = new Map(Object.keys(CHAINS).map((c) => [c, new Map()]))
  function rememberList (chain, hex, canonical) {
    const m = recentLists.get(chain)
    if (m.has(hex)) return
    m.set(hex, canonical)
    while (m.size > 8) m.delete(m.keys().next().value)
  }
  /** A list by the hex of its registry_hash: this server's recent reads, then the archive. null when nobody has it. */
  function listByHash (hex) {
    for (const [c, m] of recentLists) if (m.has(hex)) return { chain: c, canonical: m.get(hex) }
    for (const c of Object.keys(CHAINS)) {
      const hit = (history.raw(c).registry || []).find((r) => r.row?.hash === 'sha256:' + hex)
      if (hit) return { chain: c, canonical: hit.row.body }
    }
    return null
  }
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
      const stamp = stampList({ issuer: C.issuer, chainId: C.chainId, records })
      registries.set(chain, { records, at: now(), error: null, stamp })
      rememberList(chain, stamp.registry_hash.slice(7), canonicalRegistry(records))
    } catch (e) {
      const prev = registries.get(chain)
      registries.set(chain, { records: prev?.records || null, at: prev?.at || null, stamp: prev?.stamp || null, error: internal(`registry ${chain}`, e, 'the issuer registry could not be read') })
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
    // Not awaited: a slow GitHub must not hold the start of the site or a registry refresh.
    exam.refresh().catch(() => {})
    await Promise.all(Object.keys(CHAINS).flatMap((c) => [refreshRegistry(c), windows[c].refresh(), Promise.resolve(refreshImpostors(c)), Promise.resolve(refreshNames(c)), Promise.resolve(history.refresh(c))]))
  }

  // The wall of findings, written into the page so a reader that runs no script sees the board, not "Loading" (22.11).
  // One build per PAGE_CACHE_MS: the flag ages it shows are minutes and hours.
  const hideRh = String(static_['/'].body).includes('<body class="no-rh">')
  let boardCache = { at: -Infinity, board: null }
  function landingBoard () {
    if (now() - boardCache.at < PAGE_CACHE_MS) return boardCache.board
    let board = null
    try { board = boardOf(Object.fromEntries(Object.keys(CHAINS).map((c) => [c, history.cases(c, { limit: BOARD_LIMIT })])), { now: now(), hideRh }) } catch (e) { log(`[board] ${e.message}`) }
    boardCache = { at: now(), board }
    return board
  }

  // Who calls it, as one sentence under 'Ask it from your agent' (owner, 22.11): the apps that named themselves in the
  // last 7 days, from the same counter as /status. Read from the day files at most every APPS_CACHE_MS.
  const APPS_CACHE_MS = 5 * 60e3
  let appsCache = { at: -Infinity, html: null }
  function landingApps () {
    if (now() - appsCache.at < APPS_CACHE_MS) return appsCache.html
    let html = null
    try { html = appsSentenceHtml(usageOf(dailySummaries({ dir: analyticsOpts.dir ?? process.env.STP_ANALYTICS_DIR ?? null, days: 7, today: new Date(now()).toISOString().slice(0, 10) }))) } catch (e) { log(`[apps] ${e.message}`) }
    appsCache = { at: now(), html }
    return html
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
    return Buffer.from(withApps(withBoard(injectMeta(static_['/'].body, meta, canonical, { ...seo, jsonLd, robots: named && !record && !impostor ? 'noindex' : undefined }), landingBoard()), landingApps()))
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

  // The rate limit is a sliding window: at most RATE.perMinute units in any 60 seconds, counted in one-second slots.
  // External audit, 12.11: a fixed calendar minute let a steady series straddling a minute boundary through twice (80
  // requests in 52 s all passed). A refused request costs nothing, so a client that waits RATE_WINDOW_S is always let in
  // again and Retry-After: 60 holds.
  let sweptAt = -Infinity
  const SPILL_SHARDS = 4096, spill = new Uint16Array(SPILL_SHARDS * RATE_WINDOW_S)
  let spillSec = -Infinity
  // Moves a client's window on to second `sec`, emptying the slots that fell out of it.
  function slide (b, sec) {
    if (sec <= b.sec) return
    if (sec - b.sec >= RATE_WINDOW_S) { b.slots.fill(0); b.n = 0 } else {
      for (let t = b.sec + 1; t <= sec; t++) { const i = t % RATE_WINDOW_S; b.n -= b.slots[i]; b.slots[i] = 0 }
    }
    b.sec = sec
  }
  function limited (ipRaw, units = 1) {
    const ip = clientKey(ipRaw)
    // The limit a client is measured against: the free minute, or ten times it while a paid pass is live. A client
    // without a pass is measured exactly as the day before.
    const cap = x402.enabled && x402.passActive(ip) ? x402.passRate : RATE.perMinute
    const sec = Math.floor(now() / 1000)
    let b = buckets.get(ip)
    if (!b) {
      if (buckets.size >= BUCKETS_MAX) {
        // Past the cap, drop the clients with nothing left in their window, at most once per SWEEP_EVERY_S: walking a
        // map full of current clients on every new one is quadratic, and a crowd of fresh addresses would stall the
        // process.
        if (sec - sweptAt >= SWEEP_EVERY_S) { sweptAt = sec; for (const [k, v] of buckets) if (sec - v.sec >= RATE_WINDOW_S) buckets.delete(k) }
        // Still full of current clients: a new one is counted in a shared window picked by a hash of its key, never
        // untracked (that let it make unlimited requests) and never refused outright (that would let anyone holding
        // many addresses, an IPv6 /32 is 16M /56s, lock every new visitor out). A shard is shared by few clients
        // unless the table is under attack, and nginx still limits each address.
        if (buckets.size >= BUCKETS_MAX) return spillLimited(ip, sec, units, cap)
      }
      // Uint16: a pass carries up to 600 units a minute, and a burst can exceed one byte inside a single second slot.
      b = { sec, n: 0, slots: new Uint16Array(RATE_WINDOW_S) }
      buckets.set(ip, b)
    }
    slide(b, sec)
    if (b.n + units > cap) return true
    b.slots[sec % RATE_WINDOW_S] += units
    b.n += units
    return false
  }
  // The shared windows past the cap: row t % 60 holds every shard's units of second t.
  function spillLimited (ip, sec, units, cap = RATE.perMinute) {
    if (sec > spillSec) {
      const from = sec - spillSec >= RATE_WINDOW_S ? sec - RATE_WINDOW_S + 1 : spillSec + 1
      for (let t = from; t <= sec; t++) spill.fill(0, (t % RATE_WINDOW_S) * SPILL_SHARDS, (t % RATE_WINDOW_S + 1) * SPILL_SHARDS)
      spillSec = sec
    }
    let h = 2166136261
    for (let i = 0; i < ip.length; i++) h = Math.imul(h ^ ip.charCodeAt(i), 16777619)
    const s = (h >>> 0) % SPILL_SHARDS
    let n = 0
    for (let r = 0; r < RATE_WINDOW_S; r++) n += spill[r * SPILL_SHARDS + s]
    if (n + units > cap) return true
    spill[(sec % RATE_WINDOW_S) * SPILL_SHARDS + s] += units
    return false
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
    const sources = { ...SOURCES[chain], dex: 'the pools on the chain itself, read at one block, with DexScreener token-pairs (completed from GeckoTerminal when DexScreener lists 30); where both see a pool, the price and liquidity read from the chain are used', recorded_every_s: RECORDER_CADENCE_S,
      pools_counted: { min_liquidity_usd: MIN_POOL_LIQUIDITY_USD, paired_with_addresses: [...(C.referenceAssets || [])], rule: 'a pool prices the token only against the chain\'s dollar stablecoins or wrapped ETH, matched by address; the deepest one is used' } }
    return { status: 200, body: { ...p, chain, links, sources, issuer_factory: factoryFact(chain, addr), issuer_like_address: inRegistry ? null : issuerLike(chain, addr, reg.records), list_proof: proofOf(chain, reg), same_stock_elsewhere: elsewhere, series_points: points, impostor_listing: listed ? { first_seen_at: listed.first_seen_at, same_deployer_impostors: listed.same_deployer_impostors ?? null } : null, case: caseSummary(chain, addr), readings_loaded: Boolean(w.window), registry_age_s: Math.round((now() - reg.at) / 1000) } }
  }

  /** What the server holds, per chain, with ages: the numbers behind /api/status and /status. */
  /** Paid passes, for stp-health: whether selling is paused, settlements to reconcile by hand, the wallet that pays gas. */
  // What the settlement wallet has done, read from Base (outside review, 21.11). Only where passes are on: the free
  // world reads no chain and its answer is unchanged.
  const passSales = x402.enabled
    ? createPassSales({ wallet: x402.wallet, payTo: x402Opts.payTo || process.env.STP_X402_PAY_TO, now, log,
      call: baseCall || rpcCaller({ url: process.env.STP_RPC_BASE || 'https://mainnet.base.org', fetchImpl }), ...(baseCall ? { pauseMs: 0 } : {}) })
    : null
  function paymentsStatus () {
    if (!x402.enabled) return { enabled: false }
    const t = now(), paused = typeof x402.pausedUntil === 'function' ? x402.pausedUntil() : 0
    return { enabled: true, settlement_wallet: x402.wallet || null, paused_until: paused > t ? new Date(paused).toISOString() : null,
      late_settlements: lateSettlements.filter((e) => t - Date.parse(e.at) < 24 * 3600e3), sales: passSales.snapshot() }
  }

  function statusNumbers () {
    return Object.fromEntries(Object.keys(CHAINS).map((c) => {
      const r = registries.get(c); const w = windows[c].get(); const imp = impostors.get(c)
      // readings_age_s is when the server last read the files; newest_reading_age_s is when the recorder last wrote one.
      let newest = null
      if (w.window) for (const e of w.window.byToken.values()) if (e.latestAt > (newest ?? -Infinity)) newest = e.latestAt
      const impAt = imp && imp.generated_at ? Date.parse(imp.generated_at) : NaN
      // How many listed tokens the issuer has minted: the recorder reads only those, so it explains a readings count
      // below the registry's (outside review, 21.11: 90 of 415 read as 22% coverage). Null when the issuer reports no
      // supply (Robinhood), never a guess.
      const minted = r?.records ? r.records.map(mintedOf) : null
      const registryMinted = minted && minted.every((m) => m != null) ? minted.filter(Boolean).length : null
      return [c, { registry_records: r?.records?.length ?? null, registry_minted: registryMinted, registry_age_s: r?.at ? Math.round((now() - r.at) / 1000) : null, registry_error: r?.error ?? null,
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

  // The issuer's factory on chain (scripts/stocks/issuer-mirror.mjs): did the issuer's own factory create this contract?
  // A second source beside the issuer's list, with the log as evidence. Read from <root>/stock-peg/mirror.json at most
  // once a minute. Unknown (null) while the mirror has not caught up with the chain, or has not been built.
  const mirrorCache = new Map()
  function mirrorOf (chain) {
    const hit = mirrorCache.get(chain)
    if (hit && now() - hit.at < 60e3) return hit.m
    let m = null
    try { m = JSON.parse(fs.readFileSync(path.join(roots[chain], 'stock-peg', 'mirror.json'), 'utf8')) } catch (_) { m = null }
    if (m && m.chain !== chain) m = null
    const byAddress = m ? new Map((m.tokens || []).map((t) => [t.address, t])) : null
    const v = m ? { ...m, byAddress } : null
    mirrorCache.set(chain, { at: now(), m: v })
    return v
  }
  function factoryFact (chain, address) {
    const m = mirrorOf(chain)
    if (!m || m.head == null || m.scanned_to == null || m.scanned_to < m.head) return null
    const t = m.byAddress.get(String(address).toLowerCase()) || null
    const base = { source: 'the issuer\'s token factory on chain, a second source beside the issuer\'s list (not the list itself)', factory: m.factory, checked_to_block: m.scanned_to, as_of: m.updated_at || null }
    return t ? { created: true, ...base, block: t.block, tx: t.tx, log_index: t.log_index } : { created: false, ...base }
  }

  /** The one-bit answer for an address (evm/core/stocks/verify.mjs), from memory only. */
  // `reg`: the registry snapshot to decide against; the caller passes the same one to proofOf, so a verdict and its
  // list_proof can never come from two different reads.
  /** An address outside the list that starts like the listed ones (evm/core/stocks/verify.mjs issuerPrefixOf), as the passport says it. */
  function issuerLike (chain, addr, records) {
    const prefix = issuerPrefixOf(records)
    if (!prefix || !addr.startsWith(prefix)) return null
    const who = VERIFY_ISSUER_LABEL[CHAINS[chain]?.issuer] || 'the issuer'
    return { prefix, note: `This address starts like the addresses on ${who}'s list, but this contract is not on it: it is not ${who}'s stock token. The start of an address proves nothing.` }
  }

  function verifyOf (chain, address, reg = registries.get(chain)) {
    const addr = String(address || '').toLowerCase()
    const imp = impostors.get(chain)
    const r = verifyToken({
      chain, issuer: CHAINS[chain].issuer, address: addr, records: reg?.records || null, registryAt: reg?.at ?? null, now: now(),
      impostor: imp?.byAddress?.get(addr) || null, delisted: delisted.get(chain).get(addr) || null,
      otherChains: Object.keys(CHAINS).filter((c) => c !== chain).map((c) => ({ chain: c, records: registries.get(c)?.records || [] })),
    })
    // The factory fact rides along both when the list answered and when it could not: then it is the only fact, labelled.
    if (r.status === 'ok' || r.status === 'unavailable') r.body.issuer_factory = factoryFact(chain, addr)
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
    return { chain, generated_at: j.generated_at, since: since || null, window_days: BULK_WINDOW_DAYS, count: items.length, listed_total: j.items.length, older: FULL_ARCHIVE, note: j.note, untrusted_text: UNTRUSTED_TEXT_NOTE, items: items.slice(0, BULK_MAX).map((i) => ({ address: i.address, symbol: i.symbol, name: i.name, kind: i.kind, imitates_symbol: i.registry_symbol ?? null, listed_address: i.registry_address ?? null, first_seen_at: i.first_seen_at })) }
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
  // The list a verdict was decided against, stamped so anyone can check it again (evm/core/stocks/list-proof.mjs).
  const proofOf = (c, r = registries.get(c)) => listProof(r?.stamp, { readAt: r?.at, stale: Boolean(r?.error), ledgerUrl: `${publicOrigin}${publicPath}/api/history/registry?chain=${c}`, listBase: `${publicOrigin}${publicPath}/api/list` })
  const sourceOf = (c) => { const r = registries.get(c); return { generated_at: new Date(now()).toISOString(), source: `${CHAINS[c].issuer} issuer registry`, registry_age_s: r?.at ? Math.round((now() - r.at) / 1000) : null } }
  const mcp = createMcpHttp({
    chains: Object.keys(CHAINS),
    log,
    maxHours: Math.min(PUBLIC_HOURS, windowH),
    find: (c, q) => { const { byChain } = loaded(); if (!byChain[c]) throw unavailable(`the ${c} registry is not loaded yet`); return { ...findAcross({ [c]: byChain[c] }, q), ...sourceOf(c) } },
    list: (c) => {
      const recs = registries.get(c)?.records
      if (!recs) throw unavailable(`the ${c} registry is not loaded yet`)
      const tokens = recs.map((r) => ({ symbol: r.symbol, name: r.name ?? null, address: r.address, isin: r.isin, multiplier: r.multiplier, has_reference_price: r.reference?.price_usd > 0, minted: mintedOf(r) }))
      return { chain: c, issuer: CHAINS[c].issuer, ...sourceOf(c), count: tokens.length, minted: tokens.some((t) => t.minted == null) ? null : tokens.filter((t) => t.minted).length, with_reference_price: tokens.filter((t) => t.has_reference_price).length, tokens }
    },
    passport: passportOf,
    verify: verifyOf,
    snapshot: (c) => registries.get(c),
    // A day's anchor, read off the disk: the hash, the state of its Bitcoin proofs and the mirror transactions of the
    // same hash. Public, and deliberately everything needed to check us without us (verify_anchor, spec H4).
    anchor: (day) => {
      const dir = process.env.STP_ANCHOR_DIR || null
      if (!dir) return null
      const d = day || anchorDays(dir)[0]
      if (!d) return null
      const a = anchorFor(dir, d)
      if (!a) return null
      const at = `${publicOrigin}${publicPath}/anchors/`
      return {
        day: a.day, sha256: a.sha256, root: 'bitcoin', manifest_url: at + a.manifest,
        proofs: a.proofs.map((p) => ({ ...p, url: at + p.file })),
        mirrors: a.mirrors, mirror_mismatch: a.mirror_mismatch, days: anchorDays(dir).slice(0, 10),
        how_to_check: ['Fetch the manifest and recompute its SHA-256: it must be the sha256 above.', 'Fetch a .ots proof beside it and run: ots verify manifest-' + a.day + '.json (opentimestamps-client); a proof still pending completes with ots upgrade.', 'Read each mirror transaction on its own chain: the calldata is ASCII and says the day and this hash.', 'The manifest names every data file of that day by SHA-256, so any file you hold can be checked against it.'],
      }
    },
    listProof: proofOf,
    recent: recentImpostors,
    matrix: matrixFor,
  })
  // No `authorization` among the allowed headers: the server takes no credentials and nginx clears the header before
  // the app, so allowing it only told a browser page it could send one (pentest, 22.11).
  const MCP_HEADERS = Object.freeze({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id', 'access-control-allow-methods': 'POST, OPTIONS', 'cache-control': 'no-store' })

  function clientIp (req) {
    // nginx sets X-Real-IP from the Cloudflare-restored client address; only trust it from the loopback proxy.
    const peer = req.socket.remoteAddress || ''
    return /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(peer) && req.headers['x-real-ip'] ? String(req.headers['x-real-ip']) : peer
  }

  const TOO_MANY = { error: 'too many requests, try again in a minute' }

  /**
   * The public URL a 402 names as its resource. The proxy maps the domain's `/` onto the app's BASE_PATH, so the app sees
   * /stocks/verify for the public /verify; naming that path sent buyers to a 404 (20.11). Query strings are left out: the
   * pass covers the client, not one request.
   */
  function resourceOf (req) {
    let p = '/'
    try { p = new URL(req.url, 'http://local').pathname } catch (_) { /* the plain root names the pass fine */ }
    if (p === BASE_PATH || p.startsWith(BASE_PATH + '/')) p = p.slice(BASE_PATH.length) || '/'
    return publicOrigin + publicPath + p
  }

  // x402 v1 and v2 side by side (22.11): v2 is what catalogues such as x402scan register. A client pays in either; the
  // receipt answers in the wrapper it paid in. A payment module that speaks v1 only leaves every answer as it was.
  /** The payment a client sent: x402 v2's PAYMENT-SIGNATURE, or v1's X-PAYMENT. */
  const paymentOf = (req) => req.headers['payment-signature'] ? { header: String(req.headers['payment-signature']), version: 2 }
    : req.headers['x-payment'] ? { header: String(req.headers['x-payment']), version: 1 } : null
  const PAY_EXPOSE = Object.freeze({ 'access-control-expose-headers': 'payment-required, payment-response, x-payment-response' })
  const b64json = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
  /** The 402 as x402 v2 PaymentRequired, or null where the module speaks v1 only. */
  const offerV2 = (o) => (typeof x402.acceptsV2 === 'function' ? x402.acceptsV2(o) : null)
  /** Headers of a 402: the v2 offer in PAYMENT-REQUIRED (base64 JSON, the v2 spec's canonical place) beside the v1 body. */
  function offerHeaders (o) { const v2 = offerV2(o); return { ...PAY_EXPOSE, ...(v2 ? { 'payment-required': b64json(v2) } : {}) } }
  /** The settlement receipt in the wrapper the client paid in: PAYMENT-RESPONSE for v2, X-PAYMENT-RESPONSE for v1. */
  const receiptHeaders = (r, version) => (version === 2 ? (r.headerV2 ? { 'payment-response': r.headerV2 } : {}) : (r.header ? { 'x-payment-response': r.header } : {}))

  /**
   * Where the free minute ends. Without paid passes this is the plain 429 of every day before. With them, a refused
   * client is shown the 402 that names the pass (x402), and a client that answers with `X-PAYMENT` buys the pass: the
   * purchase settles on chain, this request is then served under the pass's rate, and the settle receipt rides out in
   * `X-PAYMENT-RESPONSE`. Returns true when it has answered, false when the caller may proceed.
   */
  async function limitGate (req, res, { units = 1, cors = {}, headers = {}, mcp = false } = {}) {
    const ip = clientIp(req)
    if (!limited(ip, units)) return false
    const key = clientKey(ip)
    const noStore = { 'cache-control': 'no-store' }
    if (!x402.enabled) { send(res, 429, mcp ? { jsonrpc: '2.0', id: null, error: { code: -32000, message: TOO_MANY.error } } : TOO_MANY, undefined, { ...headers, ...cors, ...noStore, 'retry-after': '60' }); return true }
    if (x402.passActive(key)) {
      const message = `your pass is active: it allows ${x402.passRate} units a minute; slow down a little`
      send(res, 429, mcp ? { jsonrpc: '2.0', id: null, error: { code: -32000, message } } : { error: message }, undefined, { ...headers, ...cors, ...noStore, 'retry-after': '5' })
      return true
    }
    const pay = paymentOf(req)
    if (!pay) {
      const resource = resourceOf(req), error = 'the free minute is used up; ' + x402.description
      send(res, 402, x402.accepts({ resource, error }), undefined, { ...headers, ...cors, ...noStore, ...offerHeaders({ resource, error }) })
      return true
    }
    const r = await x402.purchase(pay.header, key)
    if (!r.ok) {
      const body = mcp ? { jsonrpc: '2.0', id: null, error: { code: -32000, message: r.error } } : { error: r.error, ...(r.pending ? { pending: true } : {}) }
      // A pending settlement carries its transaction in the receipt header, as x402 v2's settlement_pending does.
      send(res, r.status || 402, body, undefined, { ...headers, ...cors, ...noStore, ...PAY_EXPOSE, ...receiptHeaders(r, pay.version), ...(r.retryAfterS ? { 'retry-after': String(r.retryAfterS) } : {}) })
      return true
    }
    for (const [h, v] of Object.entries({ ...PAY_EXPOSE, ...receiptHeaders(r, pay.version) })) res.setHeader(h, v)
    if (limited(ip, units)) { send(res, 429, mcp ? { jsonrpc: '2.0', id: null, error: { code: -32000, message: TOO_MANY.error } } : TOO_MANY, undefined, { ...headers, ...cors, ...noStore, 'retry-after': '10' }); return true }
    return false
  }

  /**
   * A route that is only served with a pass (the big batch): an active pass goes through; a client without one is shown
   * the same 402 as the limiter's, with the reason, and one that answers with X-PAYMENT buys the pass through the same
   * x402.purchase as limitGate, so there is one way to pay and one price. Returns true when it has answered.
   */
  async function passGate (req, res, { cors = {}, why, extensions = null, v2Body = false }) {
    const key = clientKey(clientIp(req))
    if (x402.passActive(key)) return false
    const noStore = { 'cache-control': 'no-store' }
    const pay = paymentOf(req)
    if (!pay) {
      const resource = resourceOf(req), error = why + '; ' + x402.description
      // A route made to be bought (/api/pass) answers the v2 form in the body too: a v2 reader, or a catalogue that reads
      // the body, sees one version only. The other paid routes keep the v1 body their clients already read.
      const v2 = v2Body ? offerV2({ resource, error, extensions }) : null
      send(res, 402, v2 || x402.accepts({ resource, error }), undefined, { ...cors, ...noStore, ...offerHeaders({ resource, error, extensions }) })
      return true
    }
    // limitGate only reaches a purchase for a client the limiter already refused; this route reaches it for anyone, so
    // failed attempts are counted per client and capped (security review, 19.11: each bad header costs us a parse, a
    // keccak and an ECDSA recovery). A settled purchase clears the count.
    const fails = passFails.get(key)
    if (fails && now() - fails.since < PASS_FAIL_WINDOW_MS && fails.n >= PASS_FAIL_MAX) {
      // The refusal names the wait it means: the same seconds as Retry-After, and in minutes for a person reading it.
      const waitS = Math.max(1, Math.ceil((PASS_FAIL_WINDOW_MS - (now() - fails.since)) / 1000))
      const waitM = Math.ceil(waitS / 60)
      send(res, 429, { error: `too many failed payments from this client; try again in ${waitM} minute${waitM === 1 ? '' : 's'}`, retry_after_s: waitS }, undefined, { ...cors, ...noStore, 'retry-after': String(waitS) })
      return true
    }
    const r = await x402.purchase(pay.header, key)
    if (!r.ok) {
      const f = fails && now() - fails.since < PASS_FAIL_WINDOW_MS ? fails : { since: now(), n: 0 }
      f.n++
      passFails.set(key, f)
      if (passFails.size > 10000) for (const [k, v] of passFails) if (now() - v.since >= PASS_FAIL_WINDOW_MS) passFails.delete(k)
      send(res, r.status || 402, { error: r.error, ...(r.pending ? { pending: true } : {}) }, undefined, { ...cors, ...noStore, ...PAY_EXPOSE, ...receiptHeaders(r, pay.version), ...(r.retryAfterS ? { 'retry-after': String(r.retryAfterS) } : {}) })
      return true
    }
    passFails.delete(key)
    for (const [h, v] of Object.entries({ ...PAY_EXPOSE, ...receiptHeaders(r, pay.version) })) res.setHeader(h, v)
    return false
  }
  const passFails = new Map() // client key -> { since, n }: failed purchases on passGate in the current window

  async function routeMcp (req, res) {
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', MCP_HEADERS)
    // A person who opens the MCP address in a browser is sent to the page's section on connecting an agent; an MCP
    // client probing for an event stream (Accept: text/event-stream) gets the 405 the spec asks for.
    const accept = String(req.headers.accept || '')
    if (req.method === 'GET' && accept.includes('text/html') && !accept.includes('text/event-stream')) {
      return send(res, 302, '', 'text/plain', { location: publicOrigin + publicPath + '/#mcp', 'cache-control': 'no-store' })
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'POST one JSON-RPC message; this server offers no SSE stream' }, undefined, { ...MCP_HEADERS, allow: 'POST, OPTIONS' })
    if (await limitGate(req, res, { mcp: true, headers: MCP_HEADERS })) return
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
    if (extra > 0 && await limitGate(req, res, { units: extra, mcp: true, headers: MCP_HEADERS })) return
    const { status, json } = await mcp.handle(raw)
    if (status < 400) analytics.mcp(clientIp(req), req.headers, raw, mcp.toolNames)
    return json == null ? send(res, status, '', 'text/plain', MCP_HEADERS) : send(res, status, json, undefined, MCP_HEADERS)
  }

  async function route (req, res) {
    let url
    try { url = new URL(req.url, 'http://local') } catch (_) { return send(res, 404, { error: 'not found' }) }
    // Before the MCP handler, as Glama asks: a plain public GET, no authentication and no redirect.
    if (url.pathname === BASE_PATH + GLAMA_CLAIM_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' }, undefined, { allow: 'GET, HEAD' })
      return claim
        ? send(res, 200, { $schema: 'https://glama.ai/mcp/schemas/connector.json', claim }, undefined, { 'cache-control': 'public, max-age=60' })
        : send(res, 404, { error: 'not found' })
    }
    // 402index.io reads the hash of its claim token here, plain text, no redirect (its /verify page). A malformed hash
    // on the host is a 404, never served.
    if (url.pathname === BASE_PATH + INDEX402_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' }, undefined, { allow: 'GET, HEAD' })
      return INDEX402_HASH_RE.test(String(index402Hash || '').trim()) ? send(res, 200, String(index402Hash).trim().toLowerCase(), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=60' }) : send(res, 404, { error: 'not found' })
    }
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
    const useRoute = sub === '/verify' || sub === '/api/verify' ? 'verify' : sub === '/badge.svg' ? 'badge' : sub.startsWith('/api/history/') ? 'history' : sub.startsWith('/api/list/') ? 'list' : ({ '/api/find': 'find', '/api/passport': 'passport', '/api/overview': 'overview', '/api/impostors': 'impostors', '/api/matrix': 'matrix', '/api/archive/at': 'archive' })[sub] || null
    if (useRoute && req.method === 'GET') {
      const n = useRoute === 'verify' && url.searchParams.get('addresses') ? url.searchParams.get('addresses').split(',').map((s) => s.trim()).filter(Boolean).length : 1
      res.once('finish', () => { if (res.statusCode < 400) analytics.api(clientIp(req), req.headers, useRoute, n) })
    }
    if (sub === '/') { if (req.method === 'GET') analytics.load(clientIp(req), req.headers, '/'); return send(res, 200, pageFor(url), STATIC['/'][1], { 'cache-control': 'no-cache' }) }
    if (STATIC[sub]) { const s = static_[sub]; return send(res, 200, s.body, s.type, { 'cache-control': 'public, max-age=86400' }) }
    // The old address of the changelog: it is a docs page now.
    if (sub === '/CHANGELOG.md') { res.writeHead(301, { location: publicPath + '/docs/changelog.md', 'cache-control': 'public, max-age=3600' }); return res.end() }
    // The paid route described for catalogues (x402scan reads /openapi.json first). Only where passes are sold.
    if (sub === '/openapi.json') {
      if (!x402.enabled) return send(res, 404, { error: 'not found' })
      return send(res, 200, openApi, undefined, { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' })
    }
    if (sub === '/robots.txt') return send(res, 200, robots, 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600' })
    if (sub === '/.well-known/mcp-registry-auth') return registryAuth ? send(res, 200, registryAuth, 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=300' }) : send(res, 404, { error: 'not found' })
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
    // A list by its hash (list_proof.list_url): the exact bytes registry_hash names, or its addresses. Immutable, so
    // cached for a year; checked against its name before it leaves; 1 unit of the limit like any API read.
    const lm = sub.match(/^\/api\/list\/([0-9a-f]{64})(\/addresses)?$/)
    if (lm) {
      if (await limitGate(req, res, { cors: { 'access-control-allow-origin': '*' } })) return
      const hit = listByHash(lm[1])
      if (!hit) return send(res, 404, { error: 'no list with this hash: neither read recently nor in the archive' }, undefined, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' })
      const bytes = listBytes(hit.canonical, lm[1])
      if (!bytes) { log(`[list] ${hit.chain} ${lm[1]}: the stored list does not hash to its name`); return send(res, 500, { error: 'internal error' }, undefined, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }) }
      const imm = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable', 'x-robots-tag': 'noindex' }
      return lm[2] ? send(res, 200, bytes.addresses, 'text/plain; charset=utf-8', imm) : send(res, 200, bytes.body, 'application/json; charset=utf-8', imm)
    }
    if (sub === '/verify' || sub === '/api/verify') {
      const cors = { 'access-control-allow-origin': '*' }
      const many = url.searchParams.get('addresses')
      // A batch: up to MAX_VERIFY_BATCH addresses free, ⌈n/10⌉ units of the limit, as MCP verify_stock_tokens charges.
      // Bigger batches, up to PAID_VERIFY_BATCH, are the paid route (owner, 12.11 and 19.11): they need an active pass,
      // and a client without one is shown the pass's 402. The answer is the same verdict either way; only the size is
      // paid for, never the verdict.
      if (many != null) {
        if (url.searchParams.get('address') != null) return send(res, 400, { error: 'give address or addresses, not both' }, undefined, cors)
        const list = many.split(',').map((s) => s.trim()).filter(Boolean)
        if (!list.length) return send(res, 400, { error: 'addresses needs at least one address' }, undefined, cors)
        const big = list.length > MAX_VERIFY_BATCH
        if (big && (!x402.enabled || list.length > PAID_VERIFY_BATCH)) return send(res, 400, { error: x402.enabled ? `addresses takes at most ${PAID_VERIFY_BATCH} (more than ${MAX_VERIFY_BATCH} with a pass)` : `addresses takes at most ${MAX_VERIFY_BATCH}` }, undefined, cors)
        const bad = list.findIndex((a) => !/^0x[0-9a-fA-F]{40}$/.test(a))
        if (bad >= 0) return send(res, 400, { error: `addresses[${bad}] must be 0x followed by 40 hex characters` }, undefined, cors)
        // Every check that can refuse the request runs before passGate: a payment is never taken for an answer that
        // would then be a 400 (review, 19.11: chain=bogus with 51 addresses and X-PAYMENT bought a pass for nothing).
        const c = url.searchParams.get('chain')
        if (!CHAINS[c]) return send(res, 400, { error: `chain must be one of ${Object.keys(CHAINS).join(', ')}` }, undefined, cors)
        if (big && await passGate(req, res, { cors, why: `a batch of more than ${MAX_VERIFY_BATCH} addresses needs a pass` })) return
        if (await limitGate(req, res, { units: Math.ceil(list.length / 10), cors })) return
        // One registry snapshot for the whole batch and its one proof.
        const reg = registries.get(c)
        const results = []
        for (const a of list) {
          const r = verifyOf(c, a, reg)
          if (r.status === 'unavailable') return send(res, 503, r.body, undefined, { ...cors, 'cache-control': 'no-store', 'retry-after': '60' })
          results.push(r.body)
        }
        const proof = proofOf(c, reg)
        const body = { chain: c, count: results.length, listed: results.filter((r) => r.listed).length, impostors: results.filter((r) => r.impostor).length, results, list_proof: proof }
        // A paid batch is never shared by a cache: a "cache everything" rule at the edge would hand it to unpaid clients.
        return send(res, 200, body, undefined, { ...cors, 'cache-control': big ? 'private, no-store' : proof?.stale ? 'no-store' : 'public, max-age=60' })
      }
      if (await limitGate(req, res, { cors })) return
      const c = url.searchParams.get('chain')
      if (!CHAINS[c]) return send(res, 400, { error: `chain must be one of ${Object.keys(CHAINS).join(', ')}` }, undefined, { 'access-control-allow-origin': '*' })
      const reg = registries.get(c)
      const r = verifyOf(c, url.searchParams.get('address'), reg)
      if (r.status === 'bad_address') return send(res, 400, r.body, undefined, { 'access-control-allow-origin': '*' })
      if (r.status === 'unavailable') return send(res, 503, r.body, undefined, { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'retry-after': '60' })
      const proof = proofOf(c, reg)
      // receipt=1: a receipt of this check to keep (evm/core/stocks/receipt.mjs); scripts/receipt-check.mjs checks it later.
      if (url.searchParams.get('receipt') === '1') return send(res, 200, { ...r.body, list_proof: proof, receipt: makeReceipt({ body: r.body, proof, appVersion, at: now() }) }, undefined, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
      return send(res, 200, { ...r.body, list_proof: proof }, undefined, { 'access-control-allow-origin': '*', 'cache-control': proof?.stale ? 'no-store' : r.body.listed ? 'public, max-age=300' : 'public, max-age=60' })
    }
    // The owner's dashboard. Only nginx's password-protected location sets the gate header (and every other location
    // clears it), so a request that did not pass the password gets the same 404 as any unknown path.
    if (sub === '/stats') {
      if (req.headers[STATS_GATE.toLowerCase()] !== 'gate') return send(res, 404, { error: 'not found' })
      const html = statsPage({ days: dailySummaries({ dir: analyticsOpts.dir ?? process.env.STP_ANALYTICS_DIR ?? null, days: 14, today: new Date(now()).toISOString().slice(0, 10) }), runs: Object.fromEntries(Object.keys(CHAINS).map((c) => [c, lastRuns(roots[c], 8, now())])), exam: (() => { const r = exam.get(); return r.status === 200 ? r.body : null })(), ignoring: analytics.ignoring, now: now(), version: appVersion, assets: { css: `style.css?v=${version('/style.css')}`, docsCss: `docs.css?v=${version('/docs.css')}` } })
      return send(res, 200, html, 'text/html; charset=utf-8', { 'cache-control': 'no-store, private', 'x-robots-tag': 'noindex, nofollow' })
    }
    // The daily anchors (scripts/stocks/anchor.mjs): the manifests and their OpenTimestamps proofs, as written. Public,
    // read-only, and only names that match the anchor files: nothing else in the directory is reachable.
    if (sub === '/anchors/' || sub === '/anchors') {
      const dir = process.env.STP_ANCHOR_DIR || null
      let names = []
      try { names = dir ? fs.readdirSync(dir).filter((n) => ANCHOR_FILE_RE.test(n)).sort().reverse() : [] } catch (_) { names = [] }
      // Only a manifest names a day here: a mirror file is listed beside the day it belongs to, never read as one.
      const days = [...new Set(names.filter((n) => /^manifest-\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(9, 19)))]
      return send(res, 200, { note: 'Daily manifests of the SHA-256 of every data file, each anchored in Bitcoin through OpenTimestamps. Each proof is completed in place once Bitcoin confirms it (by the next daily run). To check one: download the manifest and a .ots proof, then run ots verify (opentimestamps-client); ots upgrade completes a proof that is still pending. Bitcoin is the root; `mirror` is the same hash written on Base and Robinhood Chain for reach, and the MCP tool verify_anchor hands all of it over in one answer.', days: days.map((d) => ({ day: d, manifest: `anchors/manifest-${d}.json`, proofs: names.filter((n) => n.startsWith(`manifest-${d}.json.`)).map((n) => `anchors/${n}`), mirror: names.includes(`mirror-${d}.json`) ? `anchors/mirror-${d}.json` : null, btc_check: names.includes(`btc-check-${d}.json`) ? `anchors/btc-check-${d}.json` : null })) }, undefined, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' })
    }
    if (sub.startsWith('/anchors/')) {
      const name = sub.slice('/anchors/'.length)
      const dir = process.env.STP_ANCHOR_DIR || null
      if (!dir || !ANCHOR_FILE_RE.test(name)) return send(res, 404, { error: 'not found' })
      let body
      try { body = fs.readFileSync(path.join(dir, name)) } catch (_) { return send(res, 404, { error: 'not found' }) }
      return send(res, 200, body, name.endsWith('.ots') ? 'application/octet-stream' : 'application/json; charset=utf-8', { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' })
    }
    if (sub === '/status') {
      analytics.load(clientIp(req), req.headers, '/status')
      return send(res, 200, cachedPage('/status', () => withPageHead('/status', statusPage({ chains: statusNumbers(), now: now(), version: appVersion, payments: paymentsStatus(), usage: usageOf(dailySummaries({ dir: analyticsOpts.dir ?? process.env.STP_ANALYTICS_DIR ?? null, days: 7, today: new Date(now()).toISOString().slice(0, 10) })), assets: { css: `style.css?v=${version('/style.css')}`, docsCss: `docs.css?v=${version('/docs.css')}`, beacon: `beacon.js?v=${version('/beacon.js')}` } }), STATUS_DESCRIPTION)), 'text/html; charset=utf-8', { 'cache-control': 'no-store' })
    }
    if (sub === '/history') {
      analytics.load(clientIp(req), req.headers, '/history')
      return send(res, 200, cachedPage('/history', () => withPageHead('/history', historyPage({ store: history, chains: Object.keys(CHAINS), explorers: Object.fromEntries(Object.entries(CHAINS).map(([c, v]) => [c, v.explorer])), now: now(), version: appVersion, assets: { css: `style.css?v=${version('/style.css')}`, docsCss: `docs.css?v=${version('/docs.css')}`, beacon: `beacon.js?v=${version('/beacon.js')}` } }))), 'text/html; charset=utf-8', { 'cache-control': 'public, max-age=300' })
    }
    if (!sub.startsWith('/api/')) return send(res, 404, { error: 'not found' })

    // The payment state is for monitoring: stp-health reads it every 15 minutes, and a monitor that met the free
    // minute's 402 instead of the state would miss the very alert it is for (pentest, 22.11). It costs no unit;
    // it is one small object in memory, and nginx's own per-client limit still stands in front of it.
    if (sub === '/api/status/payments') {
      return send(res, 200, paymentsStatus(), undefined, { 'cache-control': 'no-store' })
    }

    // The pass on its own: a route made to be bought (22.11, x402 v2 and the catalogues that list paid routes). Without a
    // live pass it is always the 402, whatever the free minute holds, so a catalogue probing it sees the offer; paid, or
    // with a pass already live, it answers what the pass is. Failed purchases are capped per client by passGate. It
    // costs no unit: buying must work for a client the limiter has refused.
    if (sub === '/api/pass') {
      const cors = { 'access-control-allow-origin': '*' }
      if (!x402.enabled) return send(res, 404, { error: 'paid passes are not enabled on this server' }, undefined, cors)
      if (await passGate(req, res, { cors, why: 'a pass is sold here', extensions: PASS_BAZAAR, v2Body: true })) return
      const until = typeof x402.passUntil === 'function' ? x402.passUntil(clientKey(clientIp(req))) : 0
      return send(res, 200, { pass: { active: true, until: until ? new Date(until).toISOString() : null, minutes: x402.passMinutes, units_per_minute: x402.passRate } }, undefined, { ...cors, 'cache-control': 'no-store' })
    }

    if (await limitGate(req, res, { units: sub === '/api/passport' ? PASSPORT_UNITS : 1 })) return

    const chain = url.searchParams.get('chain')
    if (sub === '/api/hit') {
      const hit = parseHit(url.searchParams, Object.keys(CHAINS), (p) => p === '/' || p === '/history' || p === '/status' || (p.startsWith('/docs/') && docs.has(p.slice(6))))
      if (hit) analytics.hit(clientIp(req), req.headers, hit)
      return send(res, 204, '', 'text/plain', { 'cache-control': 'no-store' })
    }
    // /api/status is per chain and nothing else: its readers (the site's Status dot and status line, the outside
    // canary) take every key as a chain, and a 'payments' key beside the chains turned the dot red and the canary
    // false (20.11). The payment state has its own route, read by stp-health.
    if (sub === '/api/status') {
      return send(res, 200, statusNumbers(), undefined, { 'cache-control': 'no-store' })
    }
    if (sub === '/api/exam') {
      const r = exam.get()
      return send(res, r.status, r.body, undefined, { 'access-control-allow-origin': '*', 'cache-control': r.status === 200 ? 'public, max-age=300' : 'no-store' })
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
    // One address on one day, from the archive, free (apps/stocks-archive.mjs). A window, not a download.
    if (sub === '/api/archive/at') {
      const cors = { 'access-control-allow-origin': '*' }
      const dir = process.env.STP_ANCHOR_DIR || null
      const anchorOf = (d) => {
        const a = dir ? anchorFor(dir, d) : null
        return a ? { day: a.day, sha256: a.sha256, manifest_url: `${publicOrigin}${publicPath}/anchors/${a.manifest}`, mirrors: a.mirrors } : null
      }
      const r = archiveAt({ history, anchorOf, origin: publicOrigin + publicPath, chains: Object.keys(CHAINS), chain, address: url.searchParams.get('address'), date: url.searchParams.get('date'), now: now() })
      if (r.status !== 200) return send(res, r.status, { error: r.error }, undefined, cors)
      return send(res, 200, r.body, undefined, { ...cors, 'cache-control': 'public, max-age=300' })
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
    server, refreshAll, x402,
    examRefresh: (force) => exam.refresh(force),
    // `fd` is a listening socket handed over by systemd (systemdListenFd); without one the server binds port and host.
    async start (port, host, { fd = null } = {}) {
      await refreshAll()
      timer = setInterval(() => { refreshAll().catch(() => {}) }, REGISTRY_TTL_MS); timer.unref()
      await new Promise((resolve) => (fd != null ? server.listen({ fd }, resolve) : server.listen(port, host, resolve)))
      return server.address()
    },
    async stop () { clearInterval(timer); await new Promise((resolve) => server.close(resolve)) },
  }
}

/**
 * The listening socket systemd passed in, by its socket-activation protocol: exactly one descriptor (fd 3), meant for
 * this process. Null when there is none, and the server binds the port itself as before.
 *
 * Why (measured on the host, 20.11): the server reads both issuer registries before it listens, about 9 s, and during
 * every deploy restart nginx found the port closed and answered 502. With deployment/systemd/stp-web.socket the port
 * belongs to systemd and stays open across the restart, so a request in that gap waits in the kernel's queue and is
 * answered by the new process instead of being refused.
 */
export function systemdListenFd (env = process.env, pid = process.pid) {
  if (env.LISTEN_FDS !== '1' || Number(env.LISTEN_PID) !== pid) return null
  return 3
}

if (isEntryPoint(import.meta.url)) {
  const app = createStocksWeb()
  const fd = systemdListenFd()
  // Not passed on to anything this process might start: the descriptor was meant for this one.
  delete process.env.LISTEN_FDS; delete process.env.LISTEN_PID; delete process.env.LISTEN_FDNAMES
  const a = await app.start(Number(process.env.STOCKS_WEB_PORT || 3005), process.env.STOCKS_WEB_HOST || '127.0.0.1', { fd })
  console.log(`[stocks-web] listening on ${a.address}:${a.port}${fd != null ? ' (socket from systemd)' : ''}`)
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.stop().finally(() => process.exit(0)) })
}
