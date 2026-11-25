// apps/stocks-demo-page.mjs: /demo, the Demo Agent: a trading agent that checks with Proof of Stock before it buys (owner, 25.11). The
// reader types "buy $20 of SNDK on Base", the agent is handed a look-alike, and the page runs the buy for real: the guard
// refuses the fake, finds the issuer's contract, reads its passport, holds a live KyberSwap quote to the issuer's price
// and ends with a swap nobody has signed. One switch tells the same run three ways: plain, trader, developer.
//
// ⚠ THE PAGE RUNS THE EXAMPLE, NOT A COPY OF IT. apps/stocks-web/demo.js imports the guard package and
// packages/proofofstock-guard/examples/agent-buy.mjs as the server serves them (/guard/...), and draws what buyFlow
// reports through its onStep hook. What the page shows is what the example does; a fix there is a fix here.
// ⚠ IT NEVER SIGNS AND HOLDS NO KEY. Nothing on this page asks a wallet for anything: it builds an unsigned transaction
// for an address the reader types, and links to KyberSwap with the checked contract filled in. Signing is the reader's.
// ⚠ ONE PAGE TALKS TO TWO OTHER HOSTS. The quote comes from KyberSwap and the token's decimals from Base's public RPC,
// straight from the reader's browser, so the price is not ours to bend. Only this page's CSP lets them through
// (DEMO_CSP); every other page keeps connect-src 'self'.
//
// Server-rendered so a reader that runs no script still reads what the agent does and why, step by step.

import { siteBar } from './stocks-nav.mjs'
import { KYBER, BASE_RPC } from '../packages/proofofstock-guard/examples/agent-buy.mjs'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** The look-alike the agent is handed by default: a copy of SNDKc on Base that Proof of Stock flags as an impostor. */
export const DEMO_LOOKALIKE = '0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703'
export const DEMO_REQUEST = 'buy $20 of SNDK on Base'
/** The only hosts outside ours the page may reach: the quote and the decimals. Taken from the example itself. */
export const DEMO_HOSTS = Object.freeze([new URL(KYBER).origin, new URL(BASE_RPC).origin])
/** The site's CSP with connect-src widened to DEMO_HOSTS, and nothing else changed. */
export const demoCsp = (csp) => csp.replace("connect-src 'self'", `connect-src 'self' ${DEMO_HOSTS.join(' ')}`)

/** The three ways the page tells a run, in the switch's order. */
export const VIEWS = Object.freeze([
  Object.freeze({ id: 'plain', label: 'Plain', hint: 'the story in plain words' }),
  Object.freeze({ id: 'trader', label: 'Trader', hint: 'price gap, price age, pool, minimum received' }),
  Object.freeze({ id: 'dev', label: 'Developer', hint: 'the calls and what they answered' }),
])

/** The steps, as the page tells them without running anything. */
export const STEPS = Object.freeze([
  ['You ask', 'You type what you want in plain words: buy $20 of SNDK on Base.'],
  ['The agent is handed a contract', 'From a chat, a search or a tip. It looks right. The agent checks it before anything else.'],
  ['The guard refuses the fake', 'The contract copies the issuer\'s name but is not on the issuer\'s own list. The agent will not buy it.'],
  ['The real one', 'The guard names the issuer\'s own contract, and checks that one too: it is on the issuer\'s list.'],
  ['Its passport', 'The issuer still mints it, it is not paused, and there is an issuer\'s price to hold the market to.'],
  ['A live quote, held to that price', 'KyberSwap quotes the swap. The agent refuses a price more than 3% from the issuer\'s, or a quote for any other contract.'],
  ['A ready swap, unsigned', 'A KyberSwap link with the checked contract filled in, or the unsigned transaction for your wallet. You sign, or nothing happens.'],
])

/**
 * @param {object} p
 * @param {string} p.version
 * @param {{ css: string, docsCss: string, demoCss: string, demoJs: string, beacon?: string }} p.assets
 */
export function demoPage ({ version, assets }) {
  const views = VIEWS.map((v, i) => `<button type="button" class="dm-view" data-view="${esc(v.id)}" aria-pressed="${i === 0}" title="${esc(v.hint)}">${esc(v.label)}</button>`).join('')
  const steps = STEPS.map(([t, d], i) => `<li><span class="dm-n">${i + 1}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Demo Agent: it checks before it buys · Proof of Stock</title>
  <meta name="description" content="Watch a trading agent buy a tokenized stock on Base: the guard catches a look-alike contract, finds the issuer's own, reads its passport and holds a live KyberSwap quote to the issuer's price. Live data, no keys, nothing signed.">
  <meta name="theme-color" content="#08090c">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="${esc(assets.css)}">
  <link rel="stylesheet" href="${esc(assets.docsCss)}">
  <link rel="stylesheet" href="${esc(assets.demoCss)}">
  <script type="module" src="${esc(assets.demoJs)}"></script>
  ${assets.beacon ? `<script src="${esc(assets.beacon)}" defer></script>` : ''}
</head>
<body class="dx ap dm" data-view="plain">
  ${siteBar({ current: 'demo' })}
  <main class="ap-main dm-main">
    <section class="ap-hero dm-hero">
      <p class="ap-kicker">Demo Agent · live</p>
      <h1>Demo Agent <em>checks before it buys</em></h1>
      <p class="ap-lede">Tell the agent what to buy. It gets handed a look-alike, the way agents do, and Proof of Stock stops it. Then it finds the issuer's real contract, holds a live quote to the issuer's price and hands you a swap to sign yourself.</p>
      <ul class="dm-promise" aria-label="What this page never does">
        <li><span class="i i-check" aria-hidden="true"></span>Never signs</li>
        <li><span class="i i-check" aria-hidden="true"></span>No keys, no wallet connection</li>
        <li><span class="i i-check" aria-hidden="true"></span>Live data: Proof of Stock and KyberSwap</li>
      </ul>
    </section>

    <section class="dm-stage" aria-label="The agent">
      <div class="dm-top">
        <div class="dm-views" role="group" aria-label="Tell it for">${views}</div>
        <span class="dm-live" id="dm-live" hidden><span class="dm-dot" aria-hidden="true"></span>running</span>
      </div>
      <ol class="dm-log" id="dm-log" aria-live="polite" aria-label="The conversation"></ol>
      <form class="dm-ask" id="dm-ask" autocomplete="off">
        <label class="sr" for="dm-q">What should the agent buy?</label>
        <input id="dm-q" name="q" value="${esc(DEMO_REQUEST)}" spellcheck="false" maxlength="60">
        <button type="submit" class="dm-run" id="dm-run">Run<span class="i i-arrow" aria-hidden="true"></span></button>
        <details class="dm-more">
          <summary>What the agent is handed, and your wallet</summary>
          <label for="dm-handed">Contract the agent is handed (empty: none, it looks the ticker up)</label>
          <input id="dm-handed" name="handed" value="${esc(DEMO_LOOKALIKE)}" spellcheck="false" maxlength="42">
          <label for="dm-from">Your wallet's public address, to build the unsigned swap for it (optional; never a key)</label>
          <input id="dm-from" name="from" value="" placeholder="0x…" spellcheck="false" maxlength="42">
        </details>
        <p class="dm-noscript" id="dm-noscript">This demo runs in your browser and needs JavaScript. What it does is below.</p>
      </form>
    </section>

    <section class="ap-sec dm-how" aria-labelledby="dm-how-title">
      <div class="ap-sec-head"><h2 id="dm-how-title">What happens, step by step</h2></div>
      <ol class="dm-steps">${steps}</ol>
      <p class="ap-sec-lede">The page runs <a href="https://github.com/proofofstock/proof-of-stock/blob/main/packages/proofofstock-guard/examples/agent-buy.mjs">examples/agent-buy.mjs</a> from the <a href="docs/how-to/check-before-listing.md">guard package</a> as it is. Your agent can make the same check in one line: <code>npm install @proofofstock/guard</code>, then <code>await guard.beforeBuy({ chain, tokenAddress })</code> before every buy.</p>
    </section>

    <p class="st-note">v${esc(version)} · prices are quotes at the moment you run it, not advice · the quote comes from KyberSwap and the token's decimals from Base's public RPC, straight from your browser · <a href="docs/how-to/check-before-listing.md">the guard</a>, <a href="api">the API</a>.</p>
  </main>
</body>
</html>`
}
