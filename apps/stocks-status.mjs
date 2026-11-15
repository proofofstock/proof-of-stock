// apps/stocks-status.mjs: the status page for people: is each part of the passport up to date, in plain words and
// colours. It reads the same numbers as /api/status (which stays for code) and judges them against the cadence each
// part is meant to keep. Pure: handed the numbers and the time, it returns HTML.

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
    rows.push({ chain: c, part: `${ISSUER[c] || c} registry`, detail: s.registry_records != null ? `${s.registry_records} tokens listed` : 'not loaded', age: s.registry_age_s, state: s.registry_records == null ? 'down' : judge(s.registry_age_s, LIMITS.registry) })
    rows.push({ chain: c, part: 'Price readings', detail: s.readings_tokens != null ? `${s.readings_tokens} tokens tracked, every 15 min` : 'none yet', age: s.newest_reading_age_s, state: judge(s.newest_reading_age_s, LIMITS.readings) })
    rows.push({ chain: c, part: 'Impostor list', detail: s.impostors_listed != null ? `${s.impostors_listed} flagged, rebuilt every 6 h` : 'not generated yet', age: s.impostors_age_s, state: judge(s.impostors_age_s, LIMITS.impostors) })
  }
  const worst = rows.some((r) => r.state === 'down') ? 'down' : rows.some((r) => r.state === 'late') ? 'late' : 'ok'
  return { overall: worst, rows }
}

export function statusPage ({ chains, now, version, assets }) {
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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23070C18'%3E%3C/rect%3E%3Ccircle cx='8' cy='8' r='7' fill='%234B87FF'%3E%3C/circle%3E%3Cpath d='M0 8h6V6h4v2h6v1H9V7H7v2H0z' fill='%23070C18'%3E%3C/path%3E%3C/svg%3E">
  <meta http-equiv="refresh" content="60">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@300;400;600&amp;family=Onest:wght@400;500;700&amp;display=swap">
  <link rel="stylesheet" href="${assets.css}">
  <link rel="stylesheet" href="${assets.docsCss}">
  ${assets.beacon ? `<script src="${assets.beacon}" defer></script>` : ''}
</head>
<body class="dx">
  <header class="dx-bar">
    <a class="dx-brand" href="./"><span class="dx-logo" aria-hidden="true"></span><span>Proof of Stock</span><span class="dx-docs">Status</span></a>
    <span></span>
    <nav class="dx-links"><a href="./"><span class="ic ic-terminal" aria-hidden="true"></span>Terminal</a><a href="docs/"><span class="ic ic-doc" aria-hidden="true"></span>Docs</a></nav>
    <a class="dx-cta" href="docs/tutorials/connect-an-agent.md"><span aria-hidden="true">+</span> Connect an agent</a>
  </header>
  <main class="st-main">
    <div class="st-hero ${overall}"><span class="st-dot big" aria-hidden="true"></span><div><h1>${esc(headline)}</h1><p>${esc(sub)}</p></div></div>
    <div class="st-grid">${byChain}</div>
    <p class="st-note">Checked ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC · refreshes every minute · v${esc(version)} · for code: <a href="api/status">/api/status</a></p>
  </main>
</body>
</html>`
}
