// apps/stocks-stats.mjs: the owner's private dashboard at /stats. Behind a password: nginx asks for it, and the app
// serves the page only to a request that came through that nginx location (the X-Pos-Stats gate, see
// deployment/nginx/proofofstock.xyz.conf). It shows aggregates only, from the same counter as
// scripts/stocks/analytics-report.mjs (no pseudonym, address or user agent), the recorder's last runs and the exam.
// Every value from data is escaped: MCP client names and page paths come from outside.
import fs from 'node:fs'
import path from 'node:path'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const CHAIN = { base: 'Base', robinhood: 'Robinhood Chain' }
export const STATS_GATE = 'X-Pos-Stats'

/** The last `n` recorder run rows of a chain, newest first, from today's and yesterday's run files. */
export function lastRuns (root, n = 8, now = Date.now()) {
  const rows = []
  for (const d of [0, 1]) {
    const f = path.join(root, 'stock-peg', `stock-peg-runs-${new Date(now - d * 864e5).toISOString().slice(0, 10)}.jsonl`)
    let text = ''
    try { text = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    for (const l of text.trim().split('\n').reverse()) { try { rows.push(JSON.parse(l)) } catch (_) { /* a torn line */ } if (rows.length >= n) return rows }
  }
  return rows
}

// A native meter, not a styled span: the CSP has no 'unsafe-inline', so no style attribute would apply.
const bar = (v, max, cls = '') => `<meter class="sx-bar ${cls}" min="0" max="${Math.max(1, max)}" value="${Math.max(0, v)}"></meter>`
const list = (a, f = ([k, v]) => `${esc(k)} <b>${esc(v)}</b>`) => (a && a.length ? a.map(f).join(' · ') : '<span class="sx-none">none</span>')
const sum = (a) => (a || []).reduce((n, [, v]) => n + v, 0)

/** The page. `days`: dailySummaries() oldest first; `runs`: { chain: lastRuns() }; `exam`: the /api/exam body or null. */
export function statsPage ({ days, runs, exam, now, version, assets }) {
  const real = days.filter((d) => d.summary)
  const maxPeople = Math.max(1, ...real.map((d) => d.summary.people))
  const maxMcp = Math.max(1, ...real.map((d) => d.summary.mcp_clients))
  const toolCalls = (s) => (s.mcp_calls || []).filter(([k]) => /^tools\/call /.test(k)).reduce((n, [, v]) => n + v, 0)
  const dayRows = [...days].reverse().map(({ day, summary: s }) => s
    ? `<tr><td>${esc(day)}</td><td class="n">${s.people}</td><td>${bar(s.people, maxPeople)}</td><td class="n">${s.engaged}</td><td class="n">${s.median_visible_s ?? ''}</td><td class="n">${s.bots}</td><td class="n">${s.mcp_clients}</td><td>${bar(s.mcp_clients, maxMcp, 'mcp')}</td><td class="n">${toolCalls(s)}</td></tr>`
    : `<tr class="sx-empty"><td>${esc(day)}</td><td colspan="8">no data</td></tr>`).join('')
  const t = real.length ? real[real.length - 1] : null
  const ts = t && t.summary
  const actions = ts ? Object.entries(ts.actions || {}).map(([a, v]) => `<li><span>${esc(a)}</span> ${list(v)}</li>`).join('') : ''
  const today = ts ? `<section class="sx-card"><h2>${esc(t.day)} in detail</h2><ul class="sx-list">
      <li><span>pages</span> ${list(ts.views)}</li>
      <li><span>countries</span> ${list(ts.countries)}</li>
      <li><span>came from</span> ${list(ts.refs)}</li>
      <li><span>passports</span> ${list(ts.tokens)}</li>
      ${actions}
      <li><span>not people</span> browsers without a beacon <b>${ts.browsers_without_beacon}</b> · bots <b>${ts.bots}</b> · tools <b>${ts.tools}</b></li>
    </ul></section>
    <section class="sx-card"><h2>MCP, ${esc(t.day)}</h2><ul class="sx-list">
      <li><span>clients</span> <b>${ts.mcp_clients}</b>, tool calls <b>${toolCalls(ts)}</b> of ${sum(ts.mcp_calls)} requests</li>
      <li><span>calls</span> ${list(ts.mcp_calls)}</li>
      <li><span>client names</span> ${list(ts.mcp_client_names)}</li>
    </ul></section>` : ''
  const runBlock = Object.entries(runs).map(([c, rs]) => `<section class="sx-card"><h2>Recorder, ${esc(CHAIN[c] || c)}</h2>${rs.length ? `<table class="sx-table"><thead><tr><th>started UTC</th><th>took</th><th>written</th><th>top-ups</th><th>429</th><th>chain</th><th>stopped</th></tr></thead><tbody>${rs.map((r) => {
    const n429 = Object.values(r.timing || {}).reduce((n, x) => n + (x.n_429 || 0), 0)
    const took = r.duration_s != null ? `${r.duration_s} s${r.budget_s ? ` of ${r.budget_s}` : ''}` : ''
    const slow = r.duration_s != null && r.budget_s ? r.duration_s / r.budget_s >= 0.8 : false
    return `<tr class="${r.aborted ? 'bad' : slow ? 'warn' : ''}"><td>${esc(String(r.started_at || '').slice(11, 16))}</td><td class="n">${esc(took)}</td><td class="n">${r.rows_written ?? ''}/${r.tokens_considered ?? ''}</td><td class="n">${r.supplemented ?? 0}${r.supplement_errors ? ` (${r.supplement_errors} failed)` : ''}</td><td class="n">${n429}</td><td>${esc(r.onchain ? (r.onchain.breaker ? 'breaker open' : r.onchain.error ? 'unreachable' : `${r.onchain.tokens_read} read`) : '')}</td><td>${esc(r.aborted ? String(r.aborted).slice(0, 60) : '')}</td></tr>`
  }).join('')}</tbody></table>` : '<p class="sx-none">no run today or yesterday</p>'}</section>`).join('')
  const examBlock = `<section class="sx-card"><h2>Public exam</h2>${exam ? `<p><b>${esc(exam.passed)}/${esc(exam.total)}</b> on ${esc(exam.day)}, ${esc(exam.failures_total)} failures · set ${esc(String(exam.set?.sha256 || '').slice(0, 12))}</p>` : '<p class="sx-none">no exam report from the last 36 h</p>'}</section>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Stats · Proof of Stock</title>
  <meta name="theme-color" content="#050608">
  <meta http-equiv="refresh" content="300">
  <link rel="stylesheet" href="${assets.css}">
  <link rel="stylesheet" href="${assets.docsCss}">
</head>
<body class="dx">
  <header class="dx-bar">
    <a class="dx-brand" href="./"><span class="dx-logo" aria-hidden="true"></span><span>Proof of Stock</span><span class="dx-docs">Stats</span></a>
    <span></span><nav class="dx-links"><a href="status">Status</a><a href="history">History</a></nav><span></span>
  </header>
  <main class="sx-main">
    <h1>Stats</h1>
    <p class="sx-sub">Private. People are browsers that ran the page's script; a pseudonym changes every day, so a person counts once a day. Aggregates only: no address, no user agent.</p>
    <section class="sx-card"><h2>By day</h2><table class="sx-table"><thead><tr><th>day</th><th>people</th><th></th><th>30 s+</th><th>median s</th><th>bots</th><th>MCP clients</th><th></th><th>tool calls</th></tr></thead><tbody>${dayRows}</tbody></table></section>
    ${today}
    ${examBlock}
    ${runBlock}
    <p class="sx-sub">Built ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC · v${esc(version)} · refreshes every 5 minutes</p>
  </main>
</body>
</html>`
}
