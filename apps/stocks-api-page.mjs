// apps/stocks-api-page.mjs: /api, every call the service offers with its price, on one page (owner, 22.11: "a page with
// every API call and its price, beautiful and stylish"). Pure: handed the origin, the pass terms and the MCP tools, it
// returns HTML. Server-rendered so a reader that runs no script (a crawler, an agent, a judge's AI helper) reads all of
// it; the one script, api.js, only adds copy buttons.
//
// ⚠ ONE SOURCE FOR EACH NUMBER. The units come from the server's own constants (stocks-web.mjs RATE, PASSPORT_UNITS,
// PAID_VERIFY_BATCH; stocks-mcp-http.mjs MAX_VERIFY_BATCH), the pass terms from the payment module that sells it, and
// the tools from the MCP server's own list, all handed in. The page describes; it never restates a figure by hand. The
// routes are the ones docs/reference/http-api.md documents, and apps/api-page.test.mjs holds the two lists together.

import { siteBar } from './stocks-nav.mjs'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** NVDAc on Base, the issuer's own contract: the examples name a token that answers. */
export const EXAMPLE_ADDRESS = '0xb20000000000000000000078ee7ce2fe4908108c'

/**
 * The free HTTP routes, in reading order. `cost` is what one call takes from the free minute: a number of units, 'batch'
 * (⌈n/10⌉ for n addresses) or 0 for a route outside the limit. `doc` is its anchor in docs/reference/http-api.md.
 * `example` gets the public origin as `o`.
 */
export const HTTP_ROUTES = Object.freeze([
  { id: 'verify', path: '/verify', params: 'chain, address', cost: 1, doc: 'route-verify',
    ask: 'Is this exact contract the issuer\'s token on this chain? Listed or not, a look-alike or not, with the issuer list it was decided against.',
    example: (o) => `curl -s '${o}/verify?chain=base&address=${EXAMPLE_ADDRESS}'` },
  { id: 'verify-batch', path: '/verify', variant: 'batch', params: 'chain, addresses', cost: 'batch', doc: 'route-verify',
    ask: 'The same check for up to {freeBatch} addresses in one call, under one issuer list and one proof.',
    example: (o) => `curl -s '${o}/verify?chain=base&addresses=${EXAMPLE_ADDRESS},0xb200000000000000000000397293cb8cda9a10c5'` },
  { id: 'find', path: '/api/find', params: 'q, chain', cost: 1, doc: 'route-find',
    ask: 'The issuer\'s tokens matching a ticker, a company name or an ISIN, with their contract addresses.',
    example: (o) => `curl -s '${o}/api/find?q=nvda'` },
  { id: 'passport', path: '/api/passport', params: 'chain, address, hours', cost: 'passport', doc: 'route-passport',
    ask: 'A token\'s whole passport: the listing, the issuer\'s price and its age, the on-chain premium and 24 hours of its history.',
    example: (o) => `curl -s '${o}/api/passport?chain=base&address=${EXAMPLE_ADDRESS}'` },
  { id: 'overview', path: '/api/overview', params: 'chain', cost: 1, doc: 'route-overview',
    ask: 'Per chain, the tokens whose on-chain price sits furthest from the issuer\'s, as of the latest reading (every 15 minutes, not a live quote).',
    example: (o) => `curl -s '${o}/api/overview?chain=base'` },
  { id: 'impostors', path: '/api/impostors', params: 'chain, limit', cost: 1, doc: 'route-impostors',
    ask: 'Look-alikes (impostors): tokens that copy an issuer token\'s symbol or name, first seen in the last 7 days, each with the issuer\'s real address.',
    example: (o) => `curl -s '${o}/api/impostors?chain=base&limit=5'` },
  { id: 'matrix', path: '/api/matrix', params: '', cost: 1, doc: 'route-matrix',
    ask: 'Shares listed on both chains we cover: each chain\'s premium over its own issuer, and the gap between the two premiums (not a price difference to trade on).',
    example: (o) => `curl -s '${o}/api/matrix'` },
  { id: 'history-cases', path: '/api/history/cases', params: 'chain, event, since, limit', cost: 1, doc: 'route-history',
    ask: 'The case log of the last 7 days, up to 50 events: each look-alike opened, changed, listed or gone, dated. Older cases are kept and given on request.',
    example: (o) => `curl -s '${o}/api/history/cases?chain=base&limit=5'` },
  { id: 'history-registry', path: '/api/history/registry', params: 'chain, date', cost: 1, doc: 'route-history',
    ask: 'The issuer list as it changed, or the one in force at the end of a given day.',
    example: (o) => `curl -s '${o}/api/history/registry?chain=base'` },
  { id: 'archive-at', path: '/api/archive/at', params: 'chain, address, date', cost: 1, doc: 'route-archive-at',
    ask: 'What one address was on a given day, from what was recorded that day. Today is answered too, marked partial: true until midnight UTC.',
    example: (o) => `curl -s '${o}/api/archive/at?chain=base&address=${EXAMPLE_ADDRESS}&date=2026-11-15'` },
  { id: 'list', path: '/api/list/<hex>', params: '', cost: 1, doc: 'route-list',
    ask: 'The exact issuer list a verdict names. <hex> is registry_hash from its list_proof without "sha256:"; the SHA-256 of what this returns must equal <hex>. /api/list/<hex>/addresses gives the addresses alone.',
    example: (o) => `curl -fsS ${o}/api/list/<hex> | sha256sum    # must print <hex>` },
  { id: 'status', path: '/api/status', params: '', cost: 1, doc: 'route-status',
    ask: 'Is the data fresh: each issuer list\'s age, the newest price reading, the impostor list.',
    example: (o) => `curl -s '${o}/api/status'` },
  { id: 'exam', path: '/api/exam', params: '', cost: 1, doc: 'route-exam',
    ask: 'The latest public exam, run daily: questions whose right answers come from the issuers\' own lists, and how many we got wrong.',
    example: (o) => `curl -s '${o}/api/exam'` },
  { id: 'badge', path: '/badge.svg', params: 'chain, address', cost: 0, doc: 'route-badge',
    ask: 'A badge for your own page: issuer-listed, a look-alike, not listed. Cached at the edge and outside the limit. Every token\'s passport offers its badge to copy: see docs/how-to/embed-a-badge.md.',
    example: (o) => `<img src="${o}/badge.svg?chain=base&address=${EXAMPLE_ADDRESS}" alt="Proof of Stock">` },
  { id: 'anchors', path: '/anchors/', params: '', cost: 0, doc: 'route-anchors',
    ask: 'A daily record of our data files, timestamped in Bitcoin (OpenTimestamps) so it cannot be rewritten later: the manifests and their proofs; /anchors/<file> serves each one.',
    example: (o) => `curl -s '${o}/anchors/'` },
  { id: 'payments', path: '/api/status/payments', params: '', cost: 0, doc: 'route-status',
    ask: 'The state of paid passes, for monitoring: on or off, who settles them, and the latest settlement.',
    example: (o) => `curl -s '${o}/api/status/payments'` },
])

/** What each MCP tool answers, in a line, and the arguments its example sends. Every tool the server lists has one. */
export const TOOL_INFO = Object.freeze({
  find_stock_token: { cost: 1, ask: 'Find the issuer\'s tokens on one chain by ticker, company name or ISIN.', args: { chain: 'base', query: 'nvda' } },
  list_stock_tokens: { cost: 1, ask: 'The whole issuer list for one chain, in one answer.', args: { chain: 'base' } },
  stock_passport: { cost: 'passport', ask: 'One token\'s passport: listing, the issuer\'s price and its age, the premium and its history.', args: { chain: 'base', address: EXAMPLE_ADDRESS } },
  verify_stock_tokens: { cost: 'batch', ask: 'Check up to {freeBatch} addresses before a buy, against the issuer\'s own list.', args: { chain: 'base', addresses: [EXAMPLE_ADDRESS] } },
  recent_impostors: { cost: 1, ask: 'Look-alikes (impostors) first seen in the last 7 days, each with the token it imitates.', args: { chain: 'base' } },
  compare_venues: { cost: 1, ask: 'The same share on both chains we cover: each chain\'s premium over its own issuer, and the gap between the two.', args: { symbol: 'NVDA' } },
  verify_anchor: { cost: 1, ask: 'Proof that a day\'s record has not changed: its Bitcoin proof and the mirror transactions.', args: {} },
  largest_gaps: { cost: 1, ask: 'The landing board: the listed tokens whose on-chain price sits furthest from the issuer\'s, with when each was read.', args: { chain: 'base' } },
  data_freshness: { cost: 1, ask: 'When each issuer list and pool price was last read, and whether it is late: the facts of /status.', args: {} },
  address_on_date: { cost: 1, ask: 'What an address was on a past UTC day, from the archive recorded then; UNKNOWN when nothing was.', args: { chain: 'base', address: EXAMPLE_ADDRESS, date: '2026-11-20' } },
})

/** One call's price on the free minute, as words. */
export function costWords (cost, { passportUnits }) {
  if (cost === 0) return 'outside the limit'
  if (cost === 'batch') return '⌈n/10⌉ units'
  const n = cost === 'passport' ? passportUnits : cost
  return `${n} unit${n === 1 ? '' : 's'}`
}
const costClass = (cost) => (cost === 0 ? 'zero' : cost === 'passport' ? 'heavy' : cost === 'batch' ? 'batch' : 'one')

const mcpExample = (o, name, args) => `curl -s ${o}/mcp -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}'`

/** Plain USDC words for a price in dollars: 0.01 → "0.01 USDC". */
export const usdc = (priceUsd) => `${Number(priceUsd).toString()} USDC`

/**
 * @param {object} p
 * @param {string} p.origin     the public site, e.g. https://proofofstock.xyz
 * @param {string} p.version
 * @param {object} p.assets     { css, docsCss, apiJs, beacon }
 * @param {object[]} p.tools    the MCP server's tools (stocks-mcp-http.mjs toolsFor)
 * @param {object} p.limits     { perMinute, passportUnits, freeBatch, paidBatch }
 * @param {object|null} p.pass  { priceUsd, passMinutes, passRate } where passes are sold, else null
 */
export function apiPage ({ origin, version, assets, tools, limits, pass = null }) {
  const { perMinute, passportUnits, freeBatch, paidBatch } = limits
  const fill = (s) => s.replaceAll('{freeBatch}', String(freeBatch))
  const words = (c) => costWords(c, { passportUnits })
  let n = 0
  const codeBlock = (text) => {
    const id = `ex-${++n}`
    return `<div class="ap-ex"><pre id="${id}"><code>${esc(text)}</code></pre><button type="button" class="ap-copy" data-copy="${id}" hidden>Copy</button></div>`
  }
  const route = (r) => `
      <article class="ap-route" id="r-${esc(r.id)}">
        <div class="ap-route-head"><span class="ap-m">GET</span><code class="ap-path">${esc(r.path)}</code>${r.variant ? `<span class="ap-variant">${esc(r.variant)}</span>` : ''}<span class="ap-cost ${costClass(r.cost)}">${esc(words(r.cost))}</span></div>
        <p class="ap-ask">${esc(fill(r.ask))}</p>
        ${r.params ? `<p class="ap-params"><span>params</span> ${r.params.split(', ').map((p) => `<code>${esc(p)}</code>`).join(' ')}</p>` : ''}
        ${codeBlock(r.example(origin))}
        <a class="ap-doc" href="docs/reference/http-api.md#${esc(r.doc)}">Reference<span class="i i-arrow" aria-hidden="true"></span></a>
      </article>`
  const toolCard = (t) => {
    const info = TOOL_INFO[t.name]
    return `
      <article class="ap-route" id="t-${esc(t.name)}">
        <div class="ap-route-head"><span class="ap-m tool">TOOL</span><code class="ap-path">${esc(t.name)}</code><span class="ap-cost ${costClass(info.cost)}">${esc(words(info.cost))}</span></div>
        <p class="ap-ask">${esc(fill(info.ask))}</p>
        <p class="ap-params"><span>title</span> ${esc(t.annotations?.title || t.name)} · read-only</p>
        ${codeBlock(mcpExample(origin, t.name, info.args))}
        <a class="ap-doc" href="docs/reference/tools.md#tool-${esc(t.name)}">Reference<span class="i i-arrow" aria-hidden="true"></span></a>
      </article>`
  }
  const passBuys = pass ? Math.floor(pass.passRate / passportUnits) : null
  const paid = pass
    ? `
    <section class="ap-sec" id="paid" aria-labelledby="paid-title">
      <div class="ap-sec-head"><h2 id="paid-title">Paid: a pass over x402</h2><span class="ap-badge paid">${esc(usdc(pass.priceUsd))}</span></div>
      <p class="ap-sec-lede">When the free minute is not enough, an agent pays for itself: ${esc(usdc(pass.priceUsd))} on Base buys ${esc(String(pass.passMinutes))} minutes at ${esc(String(pass.passRate))} units a minute, ten times the free rate. No account, no key, no card. The payment is x402, version 1 or 2; the answers are the same verdicts as on the free minute.</p>
      <div class="ap-list">
      <article class="ap-route ap-paid" id="r-pass">
        <div class="ap-route-head"><span class="ap-m">GET</span><code class="ap-path">/api/pass</code><span class="ap-cost paid">${esc(usdc(pass.priceUsd))}</span></div>
        <p class="ap-ask">Buy a pass before you need one. Without a live pass it answers 402 with the offer, as x402 v2 in the PAYMENT-REQUIRED header and in the body; pay with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1). Paid, or with a pass already live, it answers 200 with the pass and when it ends. It takes no unit of the free minute.</p>
        <p class="ap-params"><span>pass</span> ${esc(String(pass.passMinutes))} min · ${esc(String(pass.passRate))} units/min · about ${esc(String(passBuys))} passports a minute</p>
        ${codeBlock(`curl -i '${origin}/api/pass'`)}
        <a class="ap-doc" href="docs/how-to/pay-per-call.md">How to pay<span class="i i-arrow" aria-hidden="true"></span></a>
      </article>
      <article class="ap-route ap-paid" id="r-verify-big">
        <div class="ap-route-head"><span class="ap-m">GET</span><code class="ap-path">/verify</code><span class="ap-variant">${esc(String(freeBatch + 1))} to ${esc(String(paidBatch))} addresses</span><span class="ap-cost paid">with a pass</span></div>
        <p class="ap-ask">A batch bigger than the free ${esc(String(freeBatch))}, up to ${esc(String(paidBatch))} addresses in one call (⌈n/10⌉ units of the pass). Without a live pass the answer is the pass's 402, saying why. Only the size is paid for, never the verdict.</p>
        ${codeBlock(`curl -s "${origin}/verify?chain=base&addresses=$ADDRS"   # ADDRS: ${freeBatch + 1} to ${paidBatch} addresses, comma-separated`)}
        <a class="ap-doc" href="docs/reference/http-api.md#route-verify">Reference<span class="i i-arrow" aria-hidden="true"></span></a>
      </article>
      <article class="ap-route ap-paid ap-wide" id="r-any">
        <div class="ap-route-head"><span class="ap-m any">ANY</span><code class="ap-path">every route above, and /mcp</code><span class="ap-cost paid">over the free minute</span></div>
        <p class="ap-ask">A client past ${esc(String(perMinute))} units in 60 seconds gets the same offer as a 402 instead of a plain 429. Pay it, retry the request with X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2), and the call is served with the pass started.</p>
        <p class="ap-params"><span>for catalogues</span> <a href="openapi.json"><code>/openapi.json</code></a> describes <code>/api/pass</code>, its price and its 402</p>
        <a class="ap-doc" href="docs/reference/http-api.md#paid-passes">Reference<span class="i i-arrow" aria-hidden="true"></span></a>
      </article>
      </div>
    </section>`
    : `
    <section class="ap-sec" id="paid" aria-labelledby="paid-title">
      <div class="ap-sec-head"><h2 id="paid-title">Paid passes</h2><span class="ap-badge off">off here</span></div>
      <p class="ap-sec-lede">This server sells no pass: every route is the free minute, and a client over it gets a plain 429 with Retry-After. <a href="docs/reference/http-api.md#paid-passes">How passes work where they are on</a>.</p>
    </section>`
  const tierPass = pass
    ? `<div class="ap-tier pass"><span class="ap-tier-k">Pass · x402</span><b>${esc(usdc(pass.priceUsd))}</b><span>on Base for ${esc(String(pass.passMinutes))} minutes at ${esc(String(pass.passRate))} units a minute. Version 1 or 2, no account.</span></div>`
    : '<div class="ap-tier pass"><span class="ap-tier-k">Pass · x402</span><b>off</b><span>not sold on this server.</span></div>'
  const batchMinute = Math.floor(perMinute / Math.ceil(freeBatch / 10)) * freeBatch
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API and prices · Proof of Stock</title>
  <meta name="description" content="Every call Proof of Stock offers, with its price: the free HTTP API and MCP tools (${esc(String(perMinute))} units a minute, no key)${pass ? ` and a pass over x402 for ${esc(usdc(pass.priceUsd))} on Base` : ''}.">
  <meta name="theme-color" content="#08090c">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="${esc(assets.css)}">
  <link rel="stylesheet" href="${esc(assets.docsCss)}">
  ${assets.apiJs ? `<script src="${esc(assets.apiJs)}" defer></script>` : ''}
  ${assets.beacon ? `<script src="${esc(assets.beacon)}" defer></script>` : ''}
</head>
<body class="dx ap">
  ${siteBar({ current: 'api' })}
  <main class="ap-main">
    <section class="ap-hero">
      <p class="ap-kicker">API · v${esc(version)}</p>
      <h1>Every call, <em>with its price</em></h1>
      <p class="ap-lede">One read-only service, three ways in: an HTTP API for code, an MCP server for agents, and a pass over x402 for when the free minute is not enough. No key, no account, no cookies. Every answer carries its time and its source.</p>
      <div class="ap-tiers">
        <div class="ap-tier free"><span class="ap-tier-k">Free</span><b>${esc(String(perMinute))} units</b><span>a minute per client (one IP address; IPv6 by its /56), HTTP and MCP together. A call costs 1 unit, a passport ${esc(String(passportUnits))}, a batch of n addresses ⌈n/10⌉ (${esc(String(freeBatch))} addresses: ${esc(String(Math.ceil(freeBatch / 10)))} units).</span></div>
        ${tierPass}
        <div class="ap-tier mcp"><span class="ap-tier-k">MCP</span><b>${esc(String(tools.length))} tools</b><span>read-only, on the same limit and the same pass, at <code>${esc(origin)}/mcp</code>.</span></div>
      </div>
      <nav class="ap-jump" aria-label="On this page"><a href="#http">HTTP API</a><a href="#paid">Paid pass</a><a href="#mcp">MCP tools</a><a href="#units">What a minute buys</a></nav>
    </section>

    <section class="ap-sec" id="http" aria-labelledby="http-title">
      <div class="ap-sec-head"><h2 id="http-title">HTTP API</h2><span class="ap-badge free">free</span></div>
      <p class="ap-sec-lede">Read-only JSON over GET at <code>${esc(origin)}</code>. A refused request costs nothing; over the limit the answer says when to come back.</p>
      <div class="ap-list">${HTTP_ROUTES.map(route).join('')}
      </div>
    </section>
${paid}

    <section class="ap-sec" id="mcp" aria-labelledby="mcp-title">
      <div class="ap-sec-head"><h2 id="mcp-title">MCP tools</h2><span class="ap-badge free">free</span></div>
      <p class="ap-sec-lede">The same answers for an agent: a public MCP server over streamable HTTP at <code>${esc(origin)}/mcp</code>, no key. Every POST costs 1 unit; the tools below say where a call costs more. <a href="docs/tutorials/connect-an-agent.md">Connect an agent</a>.</p>
      <div class="ap-list">${tools.filter((t) => TOOL_INFO[t.name]).map(toolCard).join('')}
      </div>
    </section>

    <section class="ap-sec" id="units" aria-labelledby="units-title">
      <div class="ap-sec-head"><h2 id="units-title">What a free minute buys</h2></div>
      <div class="ap-buys">
        <div class="ap-buy"><b>${esc(String(perMinute))}</b><span>single checks: <code>/verify</code>, <code>/api/find</code> and the other 1-unit reads</span></div>
        <div class="ap-buy"><b>${esc(String(Math.floor(perMinute / passportUnits)))}</b><span>passports, at ${esc(String(passportUnits))} units each</span></div>
        <div class="ap-buy"><b>${esc(String(batchMinute))}</b><span>addresses checked, in batches of ${esc(String(freeBatch))} at ⌈${esc(String(freeBatch))}/10⌉ = ${esc(String(Math.ceil(freeBatch / 10)))} units</span></div>
      </div>
      <p class="ap-sec-lede">The window slides by the second: any 60 seconds, wherever a minute begins. The limit is per client address, HTTP and MCP share it, and a pass raises it for that client alone.</p>
    </section>

    <p class="st-note">v${esc(version)} · the full reference: <a href="docs/reference/http-api.md">HTTP API</a>, <a href="docs/reference/tools.md">MCP tools</a>, <a href="docs/reference/passport.md">fields and units</a>${pass ? ', <a href="openapi.json">openapi.json</a>' : ''} · facts with their time and source, not investment advice.</p>
  </main>
</body>
</html>`
}
