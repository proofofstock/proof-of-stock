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

/**
 * Use in the last days, from the visit counter's daily summaries (scripts/stocks/analytics-report.mjs dailySummaries):
 * the same split /stats makes. An MCP client counts on a day it CALLED A TOOL; one that only connected and listed the
 * tools (catalogues, health checks) is discovery and is not counted here. Pseudonyms change daily, so agents are
 * summed per day, never deduplicated across days, and the page says so. Tool calls come from the summary's top keys,
 * so they can only undercount. Null when the counter has no file for any of the days.
 */
export function usageOf (days) {
  const real = (Array.isArray(days) ? days : []).filter((d) => d && d.summary)
  if (!real.length) return null
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const calls = (s) => (s.mcp_calls || []).filter(([k]) => /^tools\/call /.test(k)).reduce((a, [, v]) => a + n(v), 0)
  return {
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

function usageSection (u) {
  if (!u) return ''
  const tile = (v, k) => `<div class="st-use-tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`
  return `<section class="st-use"><h2>Used in the last ${esc(u.days)} days</h2><div class="st-use-row">${tile(u.agent_days, 'agents that called an MCP tool (once a day)')}${tile(u.tool_calls, 'MCP tool calls')}${tile(u.api_client_days, 'programs that called the API (once a day)')}${tile(u.api_requests, 'API calls by programs')}${tile(u.api_checks, 'addresses checked through /verify')}${tile(u.people_days, 'people on the site (once a day)')}</div><p class="st-detail">From our own server's counter. An MCP agent counts on a day it called a tool; catalogues and health checks that only list the tools are left out. API calls are the data routes (/verify, /api/find, /api/passport and the rest) answered to a program: a browser is the site itself and counts as people, and our own daily exam and canary are not counted. Clients are pseudonyms that change every day, so they are counted once a day, not once ever. These are our numbers, not verified onchain.${u.days_with_data < u.days ? ` ${esc(u.days - u.days_with_data)} of the days have no counter file.` : ''}</p></section>`
}

export function statusPage ({ chains, now, version, assets, usage = null }) {
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
    ${usageSection(usage)}
    <p class="st-note">Checked ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC · refreshes every minute · v${esc(version)} · for code: <a href="api/status">/api/status</a></p>
  </main>
</body>
</html>`
}
