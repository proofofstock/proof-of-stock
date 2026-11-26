// apps/stocks-demo-page.mjs: /demo, the Demo Agent (owner, 25.11): an agent that finds a stock token the way anyone
// would, by searching the market for its name, and lets Proof of Stock tell the original from the fakes. The reader picks
// a stock (Circle first: three tokens on Base carry its exact symbol); the agent lists every token on Base that bears
// the name, Proof of Stock rules on all of them at once, and the agent goes on with the issuer's own only: its passport,
// a live aggregator quote held to the issuer's price, and a swap on Aerodrome nobody has signed. One switch tells the same run three
// ways: plain, trader, developer.
//
// ⚠ THE PAGE RUNS THE EXAMPLES, NOT A COPY OF THEM. apps/stocks-web/demo.js imports the guard package and its
// examples/agent-search.mjs (which ends in agent-buy.mjs) as the server serves them (/guard/...), and draws what they
// report through onStep. What the page shows is what the examples do; a fix there is a fix here.
// ⚠ NO ADDRESS IS MADE UP. The tokens come from a live market search and the verdicts from Proof of Stock, at the
// moment the reader asks. A stock with no fake on the market today shows none.
// ⚠ IT NEVER SIGNS AND HOLDS NO KEY. Nothing on this page asks a wallet for anything: it builds an unsigned transaction
// for an address the reader types, and links to Aerodrome with the checked contract filled in. Signing is the reader's.
// ⚠ ONE PAGE TALKS TO THREE OTHER HOSTS. The market search (GeckoTerminal), the quote (KyberSwap) and the token's
// decimals (Base's public RPC) come straight from the reader's browser, so none of it passes through us. Only this
// page's CSP lets them through (demoCsp); every other page keeps connect-src 'self'.
//
// Server-rendered so a reader that runs no script still reads what the agent does and why, step by step.

import { siteBar } from './stocks-nav.mjs'
import { KYBER, BASE_RPC } from '../packages/proofofstock-guard/examples/agent-buy.mjs'
import { GECKO } from '../packages/proofofstock-guard/examples/agent-search.mjs'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** The stocks offered as buttons, first one preselected. Each is issuer-listed on Base; its ticker spares a lookup. */
export const DEMO_STOCKS = Object.freeze([
  Object.freeze({ query: 'Circle', ticker: 'CRCL' }),
  Object.freeze({ query: 'Tesla', ticker: 'TSLA' }),
  Object.freeze({ query: 'SanDisk', ticker: 'SNDK' }),
  Object.freeze({ query: 'NVIDIA', ticker: 'NVDA' }),
  Object.freeze({ query: 'Apple', ticker: 'AAPL' }),
  Object.freeze({ query: 'Amazon', ticker: 'AMZN' }),
])
/** The quick amounts under the field, in USDC (owner, 26.11). */
export const DEMO_AMOUNTS = Object.freeze([10, 100, 1000, 10000])
/** The only hosts outside ours the page may reach: the search, the quote and the decimals. Taken from the examples. */
export const DEMO_HOSTS = Object.freeze([new URL(GECKO).origin, new URL(KYBER).origin, new URL(BASE_RPC).origin])
/** The site's CSP with connect-src widened to DEMO_HOSTS, and nothing else changed. */
export const demoCsp = (csp) => csp.replace("connect-src 'self'", `connect-src 'self' ${DEMO_HOSTS.join(' ')}`)

/** The three ways the page tells a run, in the switch's order. */
export const VIEWS = Object.freeze([
  Object.freeze({ id: 'plain', label: 'Plain', hint: 'the story in plain words' }),
  Object.freeze({ id: 'trader', label: 'Trader', hint: 'liquidity, price gap, price age, minimum received' }),
  Object.freeze({ id: 'dev', label: 'Developer', hint: 'the calls and what they answered' }),
])

/** The steps, as the page tells them without running anything. */
export const STEPS = Object.freeze([
  ['You pick a stock', 'Circle, Tesla, SanDisk, NVIDIA, Apple, Amazon, or any company or ticker you type.'],
  ['The agent searches the market', 'Like anyone would: every token on Base whose name or symbol says that stock. Often there are several, and they look alike.'],
  ['Proof of Stock checks them all', 'One call for every token found: is it on the issuer\'s own list, or does it copy a token that is?'],
  ['The fakes and the unknown are dropped', 'A copy of the issuer\'s symbol is a fake. A token simply not on the list may be another issuer\'s: the agent cannot vouch for it, so it skips it too.'],
  ['The original', 'The one the issuer itself put on Base. The agent buys that one only, and reads its passport: still minted, not paused, the issuer\'s price.'],
  ['A live quote, held to that price', 'An aggregator (KyberSwap) quotes the swap. The agent refuses a price more than 3% from the issuer\'s, or a quote for any other contract.'],
  ['The swap, simulated', 'A live agent swaps with its own wallet, within your limits, at no more than 3% over the issuer\'s price. This page has no wallet, so the swap is simulated and no money moves. To buy yourself, open the token\'s passport in the terminal.'],
])

/**
 * @param {object} p
 * @param {string} p.version
 * @param {{ css: string, docsCss: string, demoCss: string, demoJs: string, guard?: string, beacon?: string }} p.assets  guard: the
 *   versioned folder the guard's files are served under (stocks-web.mjs guardVersion); demo.js imports them from there
 */
export function demoPage ({ version, assets }) {
  const views = VIEWS.map((v, i) => `<button type="button" class="dm-view" data-view="${esc(v.id)}" aria-pressed="${i === 0}" title="${esc(v.hint)}">${esc(v.label)}</button>`).join('')
  const amounts = DEMO_AMOUNTS.map((n) => `<button type="button" class="dm-amt" data-usd="${n}">$${n.toLocaleString('en-US')}</button>`).join('') +
    '<button type="button" class="dm-amt dm-clear" id="dm-clear">clear</button>'
  const chips = DEMO_STOCKS.map((s, i) => `<button type="button" class="dm-chip" data-query="${esc(s.query)}" data-ticker="${esc(s.ticker)}" aria-pressed="${i === 0}">${esc(s.query)}<span>${esc(s.ticker)}</span></button>`).join('')
  const steps = STEPS.map(([t, d], i) => `<li><span class="dm-n">${i + 1}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Demo Agent: it finds the real stock · Proof of Stock</title>
  <meta name="description" content="Ask for a stock token on Base. The Demo Agent searches the market, Proof of Stock tells the fakes from the issuer's original, and the agent holds a live quote to the issuer's price before handing you a swap on Aerodrome. Live data, no keys, nothing signed.">
  <meta name="theme-color" content="#08090c">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="${esc(assets.css)}">
  <link rel="stylesheet" href="${esc(assets.docsCss)}">
  <link rel="stylesheet" href="${esc(assets.demoCss)}">
  <script type="module" src="${esc(assets.demoJs)}"></script>
  ${assets.beacon ? `<script src="${esc(assets.beacon)}" defer></script>` : ''}
</head>
<body class="dx ap dm" data-view="plain" data-guard="${esc(assets.guard || 'guard/')}">
  ${siteBar({ current: 'demo' })}
  <main class="ap-main dm-main">
    <section class="ap-hero dm-hero">
      <p class="ap-kicker">Demo Agent · live</p>
      <h1>Demo Agent <em>finds the real stock</em></h1>
      <p class="ap-lede">Pick a stock. The agent searches Base the way anyone would and finds every token that carries the name. Proof of Stock tells the fakes from the issuer's original, and the agent goes for the original only, at a price held to the issuer's. A live agent would then swap with its own wallet; here the swap is simulated and no money moves.</p>
      <p class="dm-glossary">New to this? Coinbase issues tokenized stocks on <b>Base</b>, its network; their tickers end in "c" (CRCLc is Circle). You pay in <b>USDC</b>, a digital dollar. Anyone can make a token with the same name, so the agent checks which one Coinbase issued.</p>
      <ul class="dm-promise" aria-label="What this page never does">
        <li><span class="i i-check" aria-hidden="true"></span>Never signs: the swap is simulated</li>
        <li><span class="i i-check" aria-hidden="true"></span>No keys, no wallet connection</li>
        <li><span class="i i-check" aria-hidden="true"></span>Live data: market search, Proof of Stock, a live quote</li>
      </ul>
    </section>

    <section class="dm-stage" aria-label="The agent">
      <div class="dm-top">
        <div class="dm-views" role="group" aria-label="Tell it for">${views}</div>
        <span class="dm-live" id="dm-live" hidden><span class="dm-dot" aria-hidden="true"></span>running</span>
      </div>
      <ol class="dm-log" id="dm-log" aria-live="polite" aria-label="The conversation"></ol>
      <form class="dm-ask" id="dm-ask" autocomplete="off">
        <div class="dm-chips" role="group" aria-label="Find a stock">${chips}</div>
        <label class="sr" for="dm-q">Or type a company or a ticker</label>
        <input id="dm-q" name="q" value="${esc(DEMO_STOCKS[0].query)}" placeholder="A company or a ticker" spellcheck="false" maxlength="40">
        <button type="submit" class="dm-run" id="dm-run">Search<span class="i i-arrow" aria-hidden="true"></span></button>
        <div class="dm-amtrow">
          <details class="dm-more">
            <summary>Amount</summary>
            <label for="dm-usd">Amount to quote, in USDC</label>
            <input id="dm-usd" name="usd" value="20" inputmode="decimal" spellcheck="false" maxlength="8">
          </details>
          <!-- Quick amounts (owner, 26.11): a click writes "<stock> <amount>$" into the field; with no stock there, a random one. -->
          <div class="dm-amts" role="group" aria-label="Quick amounts">${amounts}</div>
        </div>
        <!-- The wallet is for developers only (owner, 25.11): shown in the Developer view, ignored in the others. -->
        <details class="dm-more dm-dev-only" id="dm-wallet">
          <summary>For developers: build the unsigned swap for your wallet</summary>
          <label for="dm-from">Your wallet's public address (optional; never a key). The swap is built through KyberSwap's router and not signed.</label>
          <input id="dm-from" name="from" value="" placeholder="0x…" spellcheck="false" maxlength="42">
        </details>
        <p class="dm-noscript" id="dm-noscript">This demo runs in your browser and needs JavaScript. What it does is below.</p>
      </form>
    </section>

    <section class="ap-sec dm-how" aria-labelledby="dm-how-title">
      <div class="ap-sec-head"><h2 id="dm-how-title">What happens, step by step</h2></div>
      <ol class="dm-steps">${steps}</ol>
      <p class="ap-sec-lede">The page runs <a href="https://github.com/proofofstock/proof-of-stock/blob/main/packages/proofofstock-guard/examples/agent-search.mjs">examples/agent-search.mjs</a> and <a href="https://github.com/proofofstock/proof-of-stock/blob/main/packages/proofofstock-guard/examples/agent-buy.mjs">agent-buy.mjs</a> from the <a href="docs/how-to/check-before-listing.md">guard package</a> as they are. Your agent can make the same check in one line: <code>npm install @proofofstock/guard</code>, then <code>await guard.beforeBuyMany('base', tokens)</code> on everything a search turns up.</p>
    </section>

    <p class="st-note">v${esc(version)} · prices are quotes at the moment you run it, not advice · token names come from the market search and are shown as written, without links · the search, the quote and the token's decimals come from GeckoTerminal, KyberSwap's aggregator and Base's public RPC, straight from your browser; the swap button opens Aerodrome, which shows its own price · <a href="docs/how-to/check-before-listing.md">the guard</a>, <a href="api">the API</a>.</p>
  </main>
</body>
</html>`
}
