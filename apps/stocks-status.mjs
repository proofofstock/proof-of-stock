// apps/stocks-status.mjs: the status page for people: is each part of the passport up to date, in plain words and
// colours. It reads the same numbers as /api/status (which stays for code) and judges them against the cadence each
// part is meant to keep. Pure: handed the numbers and the time, it returns HTML.

import { siteBar } from './stocks-nav.mjs'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ago = (s) => (s == null ? 'never' : s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`)
const CHAIN = { base: 'Base', robinhood: 'Robinhood Chain' }
const ISSUER = { base: 'Coinbase', robinhood: 'Robinhood' }

// What "on time" means for each part: the site re-reads registries every 5 min, the recorder writes every 15 min, the
// impostor list is rebuilt every 6 h. Late is one missed beat; down is more.
export const LIMITS = Object.freeze({ registry: [600, 1800], readings: [1800, 3600], impostors: [7 * 3600, 13 * 3600] })
export const judge = (age, [ok, late]) => (age == null ? 'down' : age <= ok ? 'ok' : age <= late ? 'late' : 'down')
const WORD = { ok: 'Up to date', late: 'Running late', down: 'Not updating' }

/** The overall state and one row per part per chain. */
export function statusOf (chains) {
  const rows = []
  for (const [c, s] of Object.entries(chains)) {
    rows.push({ chain: c, part: `${ISSUER[c] || c} registry`, detail: s.registry_records != null ? `${s.registry_records} tokens listed${s.registry_minted != null && s.registry_minted < s.registry_records ? `, ${s.registry_minted} minted (tradable on this chain)` : ''}` : 'not loaded', age: s.registry_age_s, state: s.registry_records == null ? 'down' : judge(s.registry_age_s, LIMITS.registry) })
    rows.push({ chain: c, part: 'Price readings', detail: s.readings_tokens != null ? `${s.readings_tokens} tokens tracked, every 15 min${s.registry_minted != null && s.registry_records != null && s.registry_minted < s.registry_records ? `. Only minted tokens have a price to read: ${s.registry_minted} of the ${s.registry_records} listed have supply` : ''}` : 'none yet', age: s.newest_reading_age_s, state: judge(s.newest_reading_age_s, LIMITS.readings) })
    rows.push({ chain: c, part: 'Impostor list', detail: s.impostors_listed != null ? `${s.impostors_listed} flagged, rebuilt every 6 h` : 'not generated yet', age: s.impostors_age_s, state: judge(s.impostors_age_s, LIMITS.impostors) })
  }
  const worst = rows.some((r) => r.state === 'down') ? 'down' : rows.some((r) => r.state === 'late') ? 'late' : 'ok'
  return { overall: worst, rows }
}

/**
 * Use in the last days, from the visit counter's daily summaries (scripts/stocks/analytics-report.mjs dailySummaries):
 * the same split /stats makes. An MCP client counts on a day it CALLED A TOOL; one that only connected and listed the
 * tools (catalogues, health checks) is discovery and is not counted here. Pseudonyms change daily, so agents are
 * summed per day, never deduplicated across days, and the page says so. Tool calls come from the summary's top keys,
 * so they can only undercount. Null when the counter has no file for any of the days.
 */
/**
 * Apps we name on the page when they name themselves (owner, 22.11: show who uses it). A client may send any name, so a
 * name is printed only when it is on this list; every other name is counted and never printed: a stranger's word does
 * not reach our page. Keys are lowercase; the MCP clientInfo name, or our own packages' user agent (API_CLIENT).
 */
export const KNOWN_APPS = Object.freeze(Object.assign(Object.create(null), {
  'claude-code': 'Claude Code', 'claude-ai': 'Claude', claude: 'Claude', 'claude desktop': 'Claude', cursor: 'Cursor',
  'cursor-vscode': 'Cursor', windsurf: 'Windsurf', 'visual studio code': 'VS Code', vscode: 'VS Code', cline: 'Cline',
  'roo-code': 'Roo Code', goose: 'Goose', zed: 'Zed', continue: 'Continue', 'openai-mcp': 'ChatGPT', chatgpt: 'ChatGPT',
  codex: 'Codex', 'codex-mcp-client': 'Codex', 'gemini-cli-mcp-client': 'Gemini CLI', librechat: 'LibreChat',
  guard: 'Proof of Stock guard (npm)', 'bankr-skill': 'Bankr skill',
}))
const NOT_A_NAME = new Set(['(no name)', 'other', ''])

/**
 * The apps that named themselves over the window: MCP clients that called a tool (checkers left out upstream) and
 * programs using our own packages. A name is a kind of app, not a person: many people run "claude-code". `returning`
 * counts names seen on two days or more, which a daily pseudonym cannot show for a person (it changes every day).
 */
export function appsOf (real) {
  const daysByName = new Map()
  for (const d of real) {
    const names = new Set([...(d.summary.mcp_agent_names || []), ...(d.summary.api_named_clients || [])]
      .map((e) => String(Array.isArray(e) ? e[0] : '').trim().toLowerCase()).filter((x) => !NOT_A_NAME.has(x)))
    for (const x of names) daysByName.set(x, (daysByName.get(x) || 0) + 1)
  }
  const known = new Map()
  for (const [x, k] of daysByName) if (KNOWN_APPS[x]) known.set(KNOWN_APPS[x], Math.max(known.get(KNOWN_APPS[x]) || 0, k))
  return {
    apps: daysByName.size,
    apps_returning: [...daysByName.values()].filter((k) => k >= 2).length,
    apps_known: [...known.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name),
  }
}

export function usageOf (days) {
  const real = (Array.isArray(days) ? days : []).filter((d) => d && d.summary)
  if (!real.length) return null
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const calls = (s) => (s.mcp_calls || []).filter(([k]) => /^tools\/call /.test(k)).reduce((a, [, v]) => a + n(v), 0)
  return {
    ...appsOf(real),
    days: days.length,
    days_with_data: real.length,
    agent_days: real.reduce((a, d) => a + n(d.summary.mcp_use_agents), 0),
    tool_calls: real.reduce((a, d) => a + calls(d.summary), 0),
    api_requests: real.reduce((a, d) => a + n(d.summary.api_requests), 0),
    api_checks: real.reduce((a, d) => a + n(d.summary.api_checks), 0),
    api_client_days: real.reduce((a, d) => a + n(d.summary.api_clients), 0),
    people_days: real.reduce((a, d) => a + n(d.summary.people), 0)
  }
}

/** The names known apps, as a phrase: "Claude Code, Cursor and Bankr skill". */
export function namesPhrase (names, max = 4) {
  const shown = names.slice(0, max), more = names.length - shown.length
  const list = more > 0 ? [...shown, `${more} more`] : shown
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * The apps that named themselves, above the tiles: how many, how many came back, and the known ones by name. Nothing
 * while none named itself. A name is what a program says about itself, so the sentence says so.
 */
function appsLine (u) {
  if (!u || !u.apps) return ''
  const tile = (v, k) => `<div class="st-use-tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`
  const seen = u.apps_known && u.apps_known.length ? ` Among them: ${esc(namesPhrase(u.apps_known))}.` : ''
  return `<div class="st-use-row">${tile(u.apps, u.apps === 1 ? 'agent app or integration that named itself' : 'agent apps and integrations that named themselves')}${tile(u.apps_returning, 'of them came back on two days or more')}</div><p class="st-detail">An app is the name a client sends about itself: an MCP client that called a tool, or a program using our npm guard or the Bankr skill. A name is a kind of app, not a person, and a client may call itself anything, so only names we recognise are shown.${seen}</p>`
}

/**
 * The landing's line under "Ask it from your agent" (owner, 22.11): the same count as /status, one sentence, with a
 * link to how it is counted. HTML, escaped here; null while no app named itself, and the page then shows nothing.
 */
export function appsSentenceHtml (u) {
  if (!u || !u.apps) return null
  const known = u.apps_known && u.apps_known.length ? `, among them ${esc(namesPhrase(u.apps_known))}` : ''
  return `In the last ${esc(u.days)} days, ${esc(u.apps)} agent ${u.apps === 1 ? 'app or integration' : 'apps and integrations'} called it by name${known}. <a class="inline-link" href="status">How we count</a>`
}

/** Write the sentence into the landing's placeholder; the page is unchanged without one. */
export function withApps (html, sentenceHtml) {
  if (!sentenceHtml) return html
  return String(html).replace('<p class="agent-apps faint" id="agent-apps" hidden></p>', `<p class="agent-apps faint" id="agent-apps">${sentenceHtml}</p>`)
}

function usageSection (u) {
  if (!u) return ''
  const tile = (v, k) => `<div class="st-use-tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`
  return `<section class="st-use"><h2>Used in the last ${esc(u.days)} days</h2>${appsLine(u)}<div class="st-use-row">${tile(u.agent_days, 'agents that called an MCP tool (once a day)')}${tile(u.tool_calls, 'MCP tool calls')}${tile(u.api_client_days, 'programs that called the API (once a day)')}${tile(u.api_requests, 'API calls by programs')}${tile(u.api_checks, 'addresses checked through /verify')}${tile(u.people_days, 'people on the site (once a day)')}</div><p class="st-detail">From our own server's counter. An MCP agent counts on a day it called a tool; catalogues and health checks that only list the tools are left out. API calls are the data routes (/verify, /api/find, /api/passport and the rest) answered to a program: a browser is the site itself and counts as people, and our own daily exam and canary are not counted. Clients are pseudonyms that change every day, so they are counted once a day, not once ever. These are our numbers, not verified onchain.${u.days_with_data < u.days ? ` ${esc(u.days - u.days_with_data)} of the days have no counter file.` : ''}</p></section>`
}

/**
 * Paid passes, from paymentsStatus(): on or off, paused or selling, and the wallet that settles every pass, linked on
 * BaseScan. A count we kept ourselves would be one more number to take on trust; the wallet's own transactions are the
 * list anyone can read (outside review, 21.11: "nothing shows a paid pass ever happened").
 */
function paymentsSection (p, now) {
  if (!p) return ''
  if (!p.enabled) return '<section class="st-use st-pay"><h2>Paid passes</h2><p class="st-detail">Off on this server. The free tier answers as usual.</p></section>'
  const w = /^0x[0-9a-fA-F]{40}$/.test(String(p.settlement_wallet)) ? p.settlement_wallet : null
  const paused = p.paused_until && Date.parse(p.paused_until) > now
  const state = paused ? `Selling is paused until ${esc(String(p.paused_until).slice(0, 16).replace('T', ' '))} UTC after failed settlements; the free tier answers as usual.` : 'On: 0.01 USDC on Base buys a 10-minute pass at ten times the free rate, paid over x402.'
  const proof = w ? ` We settle every pass ourselves from one wallet, so each sale is a public transaction: <a href="https://basescan.org/address/${esc(w)}">${esc(w.slice(0, 6))}…${esc(w.slice(-4))} on BaseScan</a>. That wallet also pays the gas of those settlements; it holds no one else's funds.` : ''
  // Since 22.11 an x402 v2 payment is settled by Coinbase's facilitator, not by the wallet above: those sales are not in
  // the wallet's count, and the page says where they are instead of leaving the count to look complete.
  const viaCdp = p.settles_v2 === 'cdp' ? ` Payments in x402 v2 are settled by Coinbase's x402 facilitator, so they are not in the wallet's count: <a href="${X402SCAN_SERVER}">see them on x402scan</a>.` : ''
  return `<section class="st-use st-pay"><h2>Paid passes</h2>${salesOf(p.sales)}<p class="st-detail">${state}${proof}${viaCdp} <a href="docs/how-to/pay-per-call.md">How to pay</a>.</p></section>`
}

/** Our server's page on x402scan, where the sales settled by a facilitator it knows are counted. */
export const X402SCAN_SERVER = 'https://www.x402scan.com/server/eb34ec2c-49f1-4b37-bee5-b3c86f0f79f1'
const HASH_RE = /^0x[0-9a-f]{64}$/
const short = (s) => `${s.slice(0, 6)}…${s.slice(-4)}`
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/**
 * The sales, as the chain has them (apps/pass-sales.mjs): the settlement wallet's own transaction count, and its
 * latest settlement linked, with who paid it. A sale of our own is said to be ours, so a test purchase never reads as
 * a customer. Nothing until the first read from Base has come back.
 */
function salesOf (s) {
  if (!s || !Number.isInteger(s.settlement_transactions) || s.settlement_transactions < 0) return ''
  const n = s.settlement_transactions
  const tile = `<div class="st-use-row"><div class="st-use-tile"><b>${esc(n)}</b><span>${n === 1 ? 'settlement' : 'settlements'} sent on Base, one per pass sold: the wallet's own transaction count, read from the chain</span></div></div>`
  const l = s.latest
  if (n === 0 || !l || !HASH_RE.test(String(l.transaction))) return tile + (n === 0 ? '<p class="st-detail">No pass has been sold yet.</p>' : '')
  const link = `<a href="https://basescan.org/tx/${esc(l.transaction)}">${esc(short(l.transaction))}</a>`
  const when = l.at && Number.isFinite(Date.parse(l.at)) ? `, ${esc(dayOf(l.at))}` : ''
  const who = !l.settled
    ? ': it was sent and reverted, so it paid nothing out'
    : l.ours
      ? `, paid by our own test wallet${n === 1 ? '. No one else has bought a pass yet' : ''}`
      : /^0x[0-9a-f]{40}$/.test(String(l.payer)) ? `, paid by <a href="https://basescan.org/address/${esc(l.payer)}">${esc(short(l.payer))}</a>` : ''
  return `${tile}<p class="st-detail">Latest settlement: ${link} on BaseScan${when}${who}.</p>`
}

export function statusPage ({ chains, now, version, assets, usage = null, payments = null }) {
  const { overall, rows } = statusOf(chains)
  const headline = { ok: 'All systems up to date', late: 'Some data is running late', down: 'Part of the data is not updating' }[overall]
  const sub = { ok: 'Registries, prices and the impostor list are all within their schedule.', late: 'The passport still answers; some numbers are older than usual.', down: 'The passport still answers, with older data where a part has stopped. Each answer carries its own age.' }[overall]
  const byChain = Object.keys(chains).map((c) => `<section class="st-chain"><h2>${esc(CHAIN[c] || c)}</h2>` + rows.filter((r) => r.chain === c).map((r) =>
    `<div class="st-row ${r.state}"><span class="st-dot" aria-hidden="true"></span><div class="st-what"><div class="st-part">${esc(r.part)}</div><div class="st-detail">${esc(r.detail)}</div></div><div class="st-when"><div class="st-word">${WORD[r.state]}</div><div class="st-age">updated ${esc(ago(r.age))}</div></div></div>`).join('') + '</section>').join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Status · Proof of Stock</title>
  <meta name="theme-color" content="#050608">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2092%22%20width%3D%2280%22%20height%3D%2292%22%20role%3D%22img%22%20aria-label%3D%22Proof%20of%20Stock%20guard%22%3E%3Ctitle%3EProof%20of%20Stock%20guard%3C%2Ftitle%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g-plate%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220.35%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%231B2742%22%2F%3E%3Cstop%20offset%3D%220.45%22%20stop-color%3D%22%230D1526%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23070C18%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22g-rim%22%20x1%3D%220.1%22%20y1%3D%220%22%20x2%3D%220.9%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23A9C8FF%22%2F%3E%3Cstop%20offset%3D%220.35%22%20stop-color%3D%22%234B87FF%22%2F%3E%3Cstop%20offset%3D%220.75%22%20stop-color%3D%22%231E4FD8%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2315347F%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22g-disc%22%20x1%3D%220.2%22%20y1%3D%220%22%20x2%3D%220.8%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%239CC0FF%22%2F%3E%3Cstop%20offset%3D%220.4%22%20stop-color%3D%22%234B87FF%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%232A5FD8%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22g-gloss%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23FFFFFF%22%20stop-opacity%3D%220.26%22%2F%3E%3Cstop%20offset%3D%220.55%22%20stop-color%3D%22%23FFFFFF%22%20stop-opacity%3D%220.06%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23FFFFFF%22%20stop-opacity%3D%220%22%2F%3E%3C%2FlinearGradient%3E%3CradialGradient%20id%3D%22g-glow%22%20cx%3D%220.5%22%20cy%3D%220.42%22%20r%3D%220.6%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234B87FF%22%20stop-opacity%3D%220.35%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%234B87FF%22%20stop-opacity%3D%220%22%2F%3E%3C%2FradialGradient%3E%3Cpath%20id%3D%22g-shape%22%20d%3D%22M40%204%2072%2013v30c0%2018.5-12.8%2032.4-32%2041.6C20.8%2075.4%208%2061.5%208%2043V13z%22%2F%3E%3CclipPath%20id%3D%22g-clip%22%3E%3Cuse%20href%3D%22%23g-shape%22%2F%3E%3C%2FclipPath%3E%3Cfilter%20id%3D%22f-drop%22%20x%3D%22-30%25%22%20y%3D%22-25%25%22%20width%3D%22160%25%22%20height%3D%22160%25%22%3E%3CfeDropShadow%20dx%3D%220%22%20dy%3D%223%22%20stdDeviation%3D%223.2%22%20flood-color%3D%22%2304070F%22%20flood-opacity%3D%220.75%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22f-emboss%22%20x%3D%22-20%25%22%20y%3D%22-20%25%22%20width%3D%22140%25%22%20height%3D%22140%25%22%3E%3CfeOffset%20in%3D%22SourceAlpha%22%20dx%3D%220%22%20dy%3D%221.4%22%20result%3D%22o%22%2F%3E%3CfeGaussianBlur%20in%3D%22o%22%20stdDeviation%3D%221.1%22%20result%3D%22b%22%2F%3E%3CfeFlood%20flood-color%3D%22%2304070F%22%20flood-opacity%3D%220.55%22%2F%3E%3CfeComposite%20in2%3D%22b%22%20operator%3D%22in%22%20result%3D%22sh%22%2F%3E%3CfeMerge%3E%3CfeMergeNode%20in%3D%22sh%22%2F%3E%3CfeMergeNode%20in%3D%22SourceGraphic%22%2F%3E%3C%2FfeMerge%3E%3C%2Ffilter%3E%3C%2Fdefs%3E%3Cg%20filter%3D%22url%28%23f-drop%29%22%3E%3Cuse%20href%3D%22%23g-shape%22%20fill%3D%22url%28%23g-plate%29%22%2F%3E%3Cg%20clip-path%3D%22url%28%23g-clip%29%22%3E%3Crect%20x%3D%220%22%20y%3D%220%22%20width%3D%2280%22%20height%3D%2292%22%20fill%3D%22url%28%23g-glow%29%22%2F%3E%3Cpath%20d%3D%22M8%2013%2040%204l32%209v16c-10%206.5-22%2010-32%2010S18%2035.5%208%2029z%22%20fill%3D%22url%28%23g-gloss%29%22%2F%3E%3Cg%20filter%3D%22url%28%23f-emboss%29%22%20transform%3D%22translate%2840%2043%29%20scale%282.55%29%20translate%28-8%20-8%29%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%227%22%20fill%3D%22url%28%23g-disc%29%22%2F%3E%3Cpath%20d%3D%22M-8%208h14V6h4v2h14v1H9V7H7v2H-8z%22%20fill%3D%22%230B1020%22%20fill-opacity%3D%220.92%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3Cuse%20href%3D%22%23g-shape%22%20fill%3D%22none%22%20stroke%3D%22url%28%23g-rim%29%22%20stroke-width%3D%223%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cuse%20href%3D%22%23g-shape%22%20fill%3D%22none%22%20stroke%3D%22%23FFFFFF%22%20stroke-opacity%3D%220.18%22%20stroke-width%3D%221%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate%280%201.1%29%20scale%280.985%29%20translate%280.6%200%29%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E">
  <meta http-equiv="refresh" content="60">
  <link rel="stylesheet" href="${assets.css}">
  <link rel="stylesheet" href="${assets.docsCss}">
  ${assets.beacon ? `<script src="${assets.beacon}" defer></script>` : ''}
</head>
<body class="dx">
  ${siteBar({ current: 'status' })}
  <main class="st-main">
    <div class="st-hero ${overall}"><span class="st-dot big" aria-hidden="true"></span><div><h1>${esc(headline)}</h1><p>${esc(sub)}</p></div></div>
    <div class="st-grid">${byChain}</div>
    ${usageSection(usage)}
    ${paymentsSection(payments, now)}
    <p class="st-note">Checked ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC · refreshes every minute · v${esc(version)} · for code: <a href="api/status">/api/status</a></p>
  </main>
</body>
</html>`
}
