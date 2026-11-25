// apps/stocks-lab-page.mjs: /lab (owner, 25.11), a page behind Cloudflare Access that nothing on the site links to:
// no tab, not in the sitemap, noindex. Three things on it, all read from files scripts/stocks/lab.mjs writes on the host:
//
//   the golden impostor of the week   the one fake with the most pool liquidity this ISO week, with a trophy
//   the fake exchange                 a board made only of fakes: per stock, how many look-alikes, how many live, how
//                                     much pool liquidity sits in them, and the richest one
//   the crash test                    which contract each agent resolver would pick for "buy $20 of <stock> on Base"
//
// ⚠ NEVER A WAY TO TRADE A FAKE. No address on this page is a link: not to a DEX, not to an explorer, not to a chart. A
// fake's address is printed as a warning, in red, and always beside the issuer's original.
// ⚠ NAMES ARE SOMEBODY ELSE'S TEXT. The files hold symbolLabel'd symbols; this page escapes them again.
// ⚠ OFF UNTIL THE OWNER TURNS IT ON. The server answers /lab only when POS_LAB=on is in the host's own environment
// (/etc/pos/web.env), set after the Access rule exists, so a deploy alone never opens it to the world.

import { siteBar } from './stocks-nav.mjs'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ADDRESS = /^0x[0-9a-f]{40}$/
const addr = (a) => ADDRESS.test(String(a)) ? String(a) : '?'
const short = (a) => { const s = addr(a); return s === '?' ? s : `${s.slice(0, 6)}…${s.slice(-4)}` }
export const STARS = Object.freeze(['0', '★', '★★', '★★★'])
const CHAIN_NAME = Object.freeze({ base: 'Base', robinhood: 'Robinhood Chain' })
/** Rows shown before the rest of a chain's board is folded away. */
export const BOARD_ROWS = 20

/** Dollars the way a board shows them: $0, $840, $12.4K, $3.1M. */
export function usd (n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '$0'
  if (v < 1000) return `$${Math.round(v)}`
  const f = (x, d) => x.toFixed(d).replace(/\.0$/, '')
  if (v < 1e6) return `$${f(v / 1e3, v < 1e5 ? 1 : 0)}K`
  return `$${f(v / 1e6, v < 1e7 ? 1 : 0)}M`
}

/** The line under the trophy, and the post's headline: "copied CRCLc, gathered $12.4K". */
export const goldenLine = (g) => `copied ${g.copied}, gathered ${usd(g.liquidity_usd)}`

/** A fake beside its original, as a warning: never a link. */
const pair = (fake, original) => `<span class="lb-pair"><span class="lb-fake" title="${esc(addr(fake))}"><b>FAKE</b><code>${esc(short(fake))}</code></span><span class="lb-vs" aria-hidden="true">≠</span><span class="lb-orig" title="${esc(addr(original))}"><b>ORIGINAL</b><code>${esc(short(original))}</code></span></span>`

const TROPHY = `<svg class="lb-trophy" viewBox="0 0 120 140" aria-hidden="true" focusable="false">
  <path class="lb-t-cup" d="M30 14h60v26c0 22-13 38-30 38S30 62 30 40z"/>
  <path class="lb-t-ear" d="M30 22H14c0 18 8 28 20 30M90 22h16c0 18-8 28-20 30"/>
  <path class="lb-t-cup" d="M52 78h16v20H52z"/><path class="lb-t-cup" d="M36 98h48v12H36z"/>
  <path class="lb-t-base" d="M28 110h64v16H28z"/>
  <text x="60" y="49" text-anchor="middle" class="lb-t-mark">FAKE</text>
</svg>`

function goldenSection (golden) {
  const weeks = golden && golden.weeks ? Object.keys(golden.weeks).sort().reverse() : []
  const g = weeks.length ? golden.weeks[weeks[0]] : null
  const past = weeks.slice(1, 9).map((w) => { const x = golden.weeks[w]; return `<li><span class="lb-wk">${esc(w)}</span><span>${esc(x.copied)}</span><span>${esc(usd(x.liquidity_usd))}</span><span>${esc(CHAIN_NAME[x.chain] || x.chain)}</span></li>` }).join('')
  return `<section class="lb-gold" aria-labelledby="lb-gold-title">
      ${TROPHY}
      <div class="lb-gold-text">
        <p class="ap-kicker">The golden impostor of the week${g ? ` · ${esc(g.week)}` : ''}</p>
        <h2 id="lb-gold-title">${g ? esc(goldenLine(g)) : 'No fake with a live pool this week, yet'}</h2>
        ${g ? `<p class="lb-gold-sub">${esc(g.symbol)} on ${esc(CHAIN_NAME[g.chain] || g.chain)}. Do not buy it: the issuer's ${esc(g.copied)} is the one marked ORIGINAL.</p>${pair(g.address, g.original)}` : '<p class="lb-gold-sub">The award goes to the fake with the most pool liquidity seen in any run of the week.</p>'}
        ${past ? `<details class="lb-past"><summary>Earlier weeks</summary><ul>${past}</ul></details>` : ''}
      </div>
    </section>`
}

function tape (boards) {
  const items = boards.flatMap((b) => b.rows.filter((r) => r.richest).map((r) => ({ ...r, chain: b.chain }))).sort((a, b) => b.liquidity_usd - a.liquidity_usd).slice(0, 12)
  if (!items.length) return ''
  const one = items.map((r) => `<span class="lb-tick"><b>${esc(r.symbol)}</b> ${esc(r.fakes)} fake${r.fakes === 1 ? '' : 's'} <i>${esc(usd(r.liquidity_usd))}</i></span>`).join('')
  return `<div class="lb-tape" aria-hidden="true"><div class="lb-tape-run">${one}${one}</div></div>`
}

function boardTable (b) {
  if (b.error) return `<p class="lb-empty">${esc(CHAIN_NAME[b.chain] || b.chain)}: ${esc(b.error)}.</p>`
  const t = b.totals || { stocks: 0, fakes: 0, live: 0, liquidity_usd: 0 }
  const rowHtml = (r) => `<tr>
          <th scope="row"><span class="lb-sym">${esc(r.symbol)}</span></th>
          <td class="lb-n">${esc(r.fakes)}</td>
          <td class="lb-n">${esc(r.live)}</td>
          <td class="lb-n lb-liq">${esc(usd(r.liquidity_usd))}${r.unread ? `<small title="addresses whose pools could not be read this run">+${esc(r.unread)} unread</small>` : ''}</td>
          <td class="lb-n lb-shown">${esc(usd(r.reported_usd))}</td>
          <td>${r.richest ? `${pair(r.richest.address, r.original)}<small class="lb-rich">${esc(r.richest.symbol)} · ${esc(usd(r.richest.liquidity_usd))}</small>` : `<span class="lb-orig-only" title="${esc(addr(r.original))}">original <code>${esc(short(r.original))}</code>, no fake holds real money</span>`}</td>
          <td class="lb-when">${esc(String(r.newest_at || '').slice(0, 10) || '?')}</td>
        </tr>`
  const head = '<thead><tr><th scope="col">Stock copied</th><th scope="col">Fakes</th><th scope="col">Live</th><th scope="col">Real money in fakes</th><th scope="col">DexScreener shows</th><th scope="col">Richest fake ≠ the original</th><th scope="col">Newest fake</th></tr></thead>'
  const rows = b.rows.slice(0, BOARD_ROWS).map(rowHtml).join('')
  const rest = b.rows.slice(BOARD_ROWS)
  return `<div class="lb-chain">
      <div class="lb-chain-head"><h3>${esc(CHAIN_NAME[b.chain] || b.chain)}</h3><p>${esc(t.fakes)} fakes of ${esc(t.stocks)} stocks · ${esc(t.live)} with a live pool · ${esc(usd(t.liquidity_usd))} of real money in their pools, ${esc(usd(t.reported_usd))} as DexScreener shows it</p></div>
      <div class="lb-scroll"><table class="lb-board">
        ${head}
        <tbody>${rows || '<tr><td colspan="7" class="lb-empty">No listed fake.</td></tr>'}</tbody>
      </table></div>
      ${rest.length ? `<details class="lb-more"><summary>${esc(rest.length)} more stock${rest.length === 1 ? '' : 's'} with fakes</summary><div class="lb-scroll"><table class="lb-board">${head}<tbody>${rest.map(rowHtml).join('')}</tbody></table></div></details>` : ''}
    </div>`
}

function crashSection (crash) {
  const stocks = crash && Array.isArray(crash.stocks) ? crash.stocks.filter((s) => s.code === 0 && s.stock) : []
  // The results table: one row per agent tool, one column per stock, its stars (its worse phrasing).
  const agents = stocks.length ? stocks[0].rows.map((r) => ({ id: r.id, agent: r.agent })) : []
  const cell = (s, id) => { const r = s.rows.find((x) => x.id === id); return r ? `<td class="lb-stars s-${r.stars == null ? 'x' : r.stars}">${r.stars == null ? '?' : esc(STARS[r.stars])}</td>` : '<td class="lb-stars s-x">?</td>' }
  const summary = stocks.length ? `<div class="lb-scroll lb-summary"><table class="lb-board lb-crash-t">
        <thead><tr><th scope="col">Agent tool</th>${stocks.map((s) => `<th scope="col">${esc(s.stock.ticker)}</th>`).join('')}</tr></thead>
        <tbody>${agents.map((a) => `<tr><th scope="row">${esc(a.agent)}</th>${stocks.map((s) => cell(s, a.id)).join('')}</tr>`).join('')}</tbody>
      </table></div>` : ''
  const blocks = stocks.map((s) => {
    const qs = s.rows[0] ? s.rows[0].tries.map((x) => x.query) : []
    const rows = s.rows.map((r) => `<tr>
          <th scope="row">${esc(r.agent)}<small>${esc(r.how)}</small></th>
          ${r.tries.map((x) => `<td class="lb-pick d-${esc(x.decision)}">${x.address ? `<code title="${esc(addr(x.address))}">${esc(short(x.address))}</code>` : '<span>no pick</span>'}<small>${esc({ listed: 'the original', impostor: 'A FAKE', not_listed: 'not on the issuer\'s list', none: 'found nothing', ambiguous: `${x.ambiguous} equal answers`, unreadable: 'could not be read' }[x.decision] || x.decision)}</small></td>`).join('')}
          <td class="lb-stars s-${r.stars == null ? 'x' : r.stars}">${r.stars == null ? '?' : esc(STARS[r.stars])}</td>
        </tr>`).join('')
    return `<details class="lb-crash">
      <summary><h3>“buy $20 of ${esc(s.stock.ticker)} on Base” <span>the issuer's ${esc(s.stock.symbol)} is <code title="${esc(addr(s.stock.original))}">${esc(short(s.stock.original))}</code></span></h3></summary>
      <div class="lb-scroll"><table class="lb-board lb-crash-t">
        <thead><tr><th scope="col">Agent tool</th>${qs.map((q) => `<th scope="col">asked for “${esc(q)}”</th>`).join('')}<th scope="col">Stars</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`
  }).join('')
  return `<section class="ap-sec lb-sec" aria-labelledby="lb-crash-title">
      <div class="ap-sec-head"><h2 id="lb-crash-title">Crash test: who would buy the fake?</h2></div>
      <p class="ap-sec-lede">The same task for every agent tool: buy $20 of a stock on Base. Each one turns the words into one contract by its own documented rule; Proof of Stock then says what that contract is. Dry: nothing is signed, no key, no account. ★★★ the original · ★★ found nothing, would ask · ★ a token the issuer does not list · 0 a listed fake. An agent scores its worse phrasing.</p>
      ${summary}
      ${blocks ? `<p class="lb-sub">Each stock, every pick:</p>${blocks}` : '<p class="lb-empty">No crash test has run yet.</p>'}
      <p class="lb-cmd">Rerun it yourself: <code>${esc(crash && crash.method || 'node packages/proofofstock-guard/examples/crash-test.mjs CRCL')}</code>${crash && crash.generated_at ? ` · last run ${esc(String(crash.generated_at).slice(0, 16).replace('T', ' '))} UTC` : ''}</p>
    </section>`
}

/**
 * @param {object} p
 * @param {object|null} p.board   board.json
 * @param {object|null} p.golden  golden.json
 * @param {object|null} p.crash   crash.json
 * @param {string} p.version
 * @param {{ css: string, docsCss: string, labCss: string }} p.assets
 */
export function labPage ({ board, golden, crash, version, assets }) {
  const boards = board && Array.isArray(board.chains) ? board.chains.map((b) => ({ ...b, rows: Array.isArray(b.rows) ? b.rows : [] })) : []
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Lab · Proof of Stock</title>
  <meta name="theme-color" content="#08090c">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="${esc(assets.css)}">
  <link rel="stylesheet" href="${esc(assets.docsCss)}">
  <link rel="stylesheet" href="${esc(assets.labCss)}">
</head>
<body class="dx ap lb">
  ${siteBar({ current: 'lab' })}
  <main class="ap-main lb-main">
    <section class="ap-hero">
      <p class="ap-kicker">Lab · not linked from the site</p>
      <h1>The fake exchange <em>lists only fakes</em></h1>
      <p class="ap-lede">Every token here copies an issuer's tokenized stock by its exact symbol or its naming convention. None of them is the stock. Each one stands beside the issuer's original, and nothing here links to a place to trade it.</p>
    </section>

    ${goldenSection(golden)}

    <section class="ap-sec lb-sec" aria-labelledby="lb-board-title">
      <div class="ap-sec-head"><h2 id="lb-board-title">The fake exchange</h2></div>
      ${tape(boards)}
      ${boards.length ? boards.map(boardTable).join('') : '<p class="lb-empty">The board has not been built yet.</p>'}
      <p class="ap-sec-lede">Fakes: tokens on our impostor list for that stock. Live: a fake with at least $${esc(board && board.live_min_usd || 100)} of real money in its pools. Real money: only the WETH or stablecoin side of the fakes' pools on DexScreener, never the fake's own side, which the fake prices itself${board && board.generated_at ? `, as of ${esc(String(board.generated_at).slice(0, 16).replace('T', ' '))} UTC` : ''}.</p>
    </section>

    ${crashSection(crash)}

    <p class="st-note">v${esc(version)} · a listed token is a claim with evidence, not a verdict · symbols are the deployers' own text, shown without links · addresses are warnings, never links.</p>
  </main>
</body>
</html>`
}
