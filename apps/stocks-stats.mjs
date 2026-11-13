// apps/stocks-stats.mjs: the owner's private dashboard at /stats. Behind a password: nginx asks for it, and the app
// serves the page only to a request that came through that nginx location (the X-Pos-Stats gate, see
// deployment/nginx/proofofstock.xyz.conf). It shows aggregates only, from the same counter as
// scripts/stocks/analytics-report.mjs (no pseudonym, address or user agent), the recorder's last runs and the exam.
// Every value from data is escaped: MCP client names and page paths come from outside.
//
// One screen on a desktop: KPI tiles, then tabs. The tabs are radio inputs and CSS (no script); the histograms are
// inline SVG drawn here, with geometry attributes and classes only, since the CSP has no 'unsafe-inline' for styles.
import fs from 'node:fs'
import path from 'node:path'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const CHAIN = { base: 'Base', robinhood: 'Robinhood Chain' }
const SHORT = { base: 'Base', robinhood: 'Robinhood' }
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

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const show = (v) => (v == null || !Number.isFinite(Number(v)) ? '·' : esc(v))
const sum = (a) => (a || []).reduce((n, [, v]) => n + num(v), 0)
const toolCalls = (s) => (s.mcp_calls || []).filter(([k]) => /^tools\/call /.test(k)).reduce((n, [, v]) => n + num(v), 0)
const hhmm = (r) => String(r.started_at || '').slice(11, 16)
const runState = (r) => (r.aborted ? 'bad' : r.duration_s != null && r.budget_s && r.duration_s / r.budget_s >= 0.8 ? 'warn' : 'ok')
const STATE_WORD = { ok: 'ok', warn: 'slow', bad: 'stopped' }
const ACTION = { section: 'sections seen', chip: 'headline buttons', search: 'searches', command: 'commands', faq: 'questions opened', copy: 'copied', out: 'links out', tab: 'chain switch', board: 'board rows' }

// A native meter, not a styled span: no style attribute would apply under the CSP.
const meter = (v, max, cls = '') => `<meter class="sx-bar ${cls}" min="0" max="${Math.max(1, num(max))}" value="${Math.max(0, num(v))}"></meter>`

/** Top-N rows `[[key, count]]` as label, bar and count; the rest is counted, not shown. */
function topList (rows, { limit = 8, cls = '' } = {}) {
  const a = rows || []
  if (!a.length) return '<p class="sx-none">none</p>'
  const max = Math.max(1, ...a.map(([, v]) => num(v)))
  return `<ul class="sx-top">${a.slice(0, limit).map(([k, v]) => `<li><span class="k" title="${esc(k)}">${esc(k)}</span>${meter(v, max, cls)}<b>${show(v)}</b></li>`).join('')}</ul>${a.length > limit ? `<p class="sx-more">+${a.length - limit} more</p>` : ''}`
}

/**
 * A histogram: one slot per day (or run), bars from the baseline. `slots`: [{ label, title, value, front?, mark?, cls? }].
 * `front` is a part of `value` drawn over it (people who stayed 30 s, tool calls among requests); `mark` is a level
 * drawn as a tick (a run's time budget). The plot stretches to its box; the labels are HTML in as many equal columns,
 * so they line up with the bars at any width.
 */
function histogram ({ title, legend = '', slots, kind = '', aria, single = false }) {
  const max = Math.max(1, ...slots.map((s) => Math.max(num(s.value), num(s.mark))))
  const top = 92, h = (v) => (num(v) > 0 ? Math.max(1.5, (num(v) / max) * top) : 0)
  const step = 10, bw = 6.2, x0 = (step - bw) / 2
  const grid = [0.25, 0.5, 0.75, 1].map((k) => `<line class="g" x1="0" x2="${slots.length * step}" y1="${(100 - top * k).toFixed(2)}" y2="${(100 - top * k).toFixed(2)}" vector-effect="non-scaling-stroke"/>`).join('')
  const bars = slots.map((s, i) => {
    const x = i * step + x0, hv = h(s.value), hf = single ? hv : Math.min(hv, h(s.front)), hm = h(s.mark)
    return `<g class="sx-s ${esc(s.cls || '')}"><rect class="hit" x="${i * step}" y="0" width="${step}" height="100"/>` +
      (hv && !single ? `<rect class="b0" x="${x}" y="${(100 - hv).toFixed(2)}" width="${bw}" height="${hv.toFixed(2)}"/>` : '') +
      (hf ? `<rect class="b1" x="${x}" y="${(100 - hf).toFixed(2)}" width="${bw}" height="${hf.toFixed(2)}"/>` : '') +
      (hm ? `<line class="mk" x1="${x - 1}" x2="${x + bw + 1}" y1="${(100 - hm).toFixed(2)}" y2="${(100 - hm).toFixed(2)}" vector-effect="non-scaling-stroke"/>` : '') +
      `<title>${esc(s.title)}</title></g>`
  }).join('')
  const axis = slots.map((s) => `<li class="${esc(s.cls || '')}"><b>${show(s.value)}</b><span>${esc(s.label)}</span></li>`).join('')
  return `<figure class="sx-card sx-chart ${kind}">
      <figcaption class="sx-h"><h2>${esc(title)}</h2><span class="sx-leg">${legend}</span></figcaption>
      <div class="sx-plot"><span class="sx-ymax">${esc(max)}</span>${slots.some((s) => s.value != null) ? '' : '<span class="sx-nodata">no data</span>'}<svg class="sx-svg" viewBox="0 0 ${Math.max(1, slots.length) * step} 100" preserveAspectRatio="none" role="img" aria-label="${esc(aria || title)}"><line class="g0" x1="0" x2="${slots.length * step}" y1="100" y2="100" vector-effect="non-scaling-stroke"/>${grid}${bars}</svg></div>
      <ol class="sx-x">${axis}</ol>
    </figure>`
}
const key = (cls, text) => `<i class="sx-k ${cls}"></i>${esc(text)}`

const card = (title, body, { sub = '', cls = '' } = {}) => `<section class="sx-card ${cls}"><div class="sx-h"><h2>${esc(title)}</h2>${sub ? `<span class="sx-leg">${esc(sub)}</span>` : ''}</div>${body}</section>`
const tile = (label, value, foot, cls = '') => `<div class="sx-kpi ${cls}"><span class="sx-kl">${esc(label)}</span><b class="sx-kn">${value}</b><span class="sx-kf">${foot}</span></div>`

const TABS = [['overview', 'Overview'], ['visits', 'Visits'], ['mcp', 'MCP'], ['recorder', 'Recorder'], ['exam', 'Exam'], ['days', 'Days']]

/** The page. `days`: dailySummaries() oldest first; `runs`: { chain: lastRuns() }; `exam`: the /api/exam body or null. */
export function statsPage ({ days, runs, exam, now, version, assets }) {
  const today = new Date(now).toISOString().slice(0, 10)
  const real = days.filter((d) => d.summary)
  const t = real.length ? real[real.length - 1] : null
  const ts = t && t.summary
  const prevDay = real.length > 1 ? real[real.length - 2] : null
  const prev = prevDay && Date.parse(t.day) - Date.parse(prevDay.day) === 864e5 ? prevDay.summary : null
  const when = t ? (t.day === today ? 'today' : t.day) : 'latest day'
  const dd = (d) => d.slice(8, 10)

  // The day histograms.
  const people = histogram({
    title: 'People by day', legend: `${key('b0', 'people')}${key('b1', '30 s+')}`, aria: 'People by day, and those who stayed 30 seconds or more',
    slots: days.map(({ day, summary: s }) => ({ label: dd(day), value: s ? s.people : null, front: s ? s.engaged : 0, title: s ? `${day}: ${s.people} people, ${s.engaged} stayed 30 s+` : `${day}: no data` })),
  })
  const mcpReq = histogram({
    title: 'MCP requests by day', kind: 'mcp', legend: `${key('b0', 'requests')}${key('b1', 'tool calls')}`, aria: 'MCP requests by day, and tool calls among them',
    slots: days.map(({ day, summary: s }) => ({ label: dd(day), value: s ? sum(s.mcp_calls) : null, front: s ? toolCalls(s) : 0, title: s ? `${day}: ${sum(s.mcp_calls)} requests, ${toolCalls(s)} tool calls, ${s.mcp_clients} clients` : `${day}: no data` })),
  })
  const mcpClients = histogram({
    title: 'MCP clients by day', kind: 'mcp', legend: key('b1', 'clients'), aria: 'MCP clients by day', single: true,
    slots: days.map(({ day, summary: s }) => ({ label: dd(day), value: s ? s.mcp_clients : null, title: s ? `${day}: ${s.mcp_clients} clients` : `${day}: no data` })),
  })
  const median = histogram({
    title: 'Median time on site by day', kind: 'alt', legend: key('b1', 'seconds per person'), aria: 'Median visible seconds per person by day', single: true,
    slots: days.map(({ day, summary: s }) => ({ label: dd(day), value: s ? s.median_visible_s : null, title: s ? `${day}: median ${s.median_visible_s ?? 'none'} s` : `${day}: no data` })),
  })

  // The tiles.
  const avg = real.length ? Math.round(real.reduce((n, d) => n + num(d.summary.people), 0) / real.length * 10) / 10 : null
  const delta = ts && prev ? ts.people - prev.people : null
  const chains = Object.entries(runs)
  const lastState = chains.map(([c, rs]) => [c, rs[0] ? runState(rs[0]) : 'none', rs[0]])
  const worst = lastState.some(([, s]) => s === 'bad' || s === 'none') ? 'bad' : lastState.some(([, s]) => s === 'warn') ? 'warn' : 'ok'
  const examCls = exam ? (num(exam.failures_total) === 0 ? 'ok' : 'warn') : ''
  const tiles = [
    tile(`People, ${when}`, show(ts?.people), delta == null ? 'no data for the day before' : `${delta > 0 ? '+' : ''}${delta} vs the day before`),
    tile('Per day, 14 days', show(avg), `average over ${real.length} day${real.length === 1 ? '' : 's'} with data`),
    tile(`Stayed 30 s+, ${when}`, show(ts?.engaged), ts ? `median ${show(ts.median_visible_s)} s per person` : 'no data'),
    tile(`MCP clients, ${when}`, show(ts?.mcp_clients), ts ? `${toolCalls(ts)} tool calls of ${sum(ts.mcp_calls)} requests` : 'no data', 'mcp'),
    tile('Public exam', exam ? `${show(exam.passed)}<small>/${show(exam.total)}</small>` : '·', exam ? `${esc(exam.day)} · ${show(exam.failures_total)} failure${num(exam.failures_total) === 1 ? '' : 's'}` : 'no report from the last 36 h', examCls),
    tile('Recorder, last runs', chains.length ? `${lastState.filter(([, s]) => s === 'ok').length}<small>/${chains.length} ok</small>` : '·', lastState.map(([c, s, r]) => `${esc(SHORT[c] || c)} ${r ? `${esc(hhmm(r))} ${STATE_WORD[s]}` : 'none'}`).join(' · ') || 'no chains', chains.length ? worst : ''),
  ].join('')

  // Overview.
  const overview = `<div class="sx-row c2">${people}${mcpReq}</div>
    <div class="sx-row c3">${card('Pages', topList(ts?.views, { limit: 7 }), { sub: when })}${card('Countries', topList(ts?.countries, { limit: 7 }), { sub: when })}${card('MCP calls', topList(ts?.mcp_calls, { limit: 7, cls: 'mcp' }), { sub: when })}</div>`

  // Visits.
  const actions = ts && Object.keys(ts.actions || {}).length
    ? `<ul class="sx-kv">${Object.entries(ts.actions).map(([a, v]) => { const line = (v || []).map(([k, n]) => `${k} ${n}`).join(' · '); return `<li><span class="k">${esc(ACTION[a] || a)}</span><span class="v" title="${esc(line)}">${esc(line)}</span></li>` }).join('')}</ul>`
    : '<p class="sx-none">none</p>'
  const notPeople = ts ? `<ul class="sx-kv"><li><span class="k">no beacon</span><span class="v">${show(ts.browsers_without_beacon)} browsers</span></li><li><span class="k">bots</span><span class="v">${show(ts.bots)}</span></li><li><span class="k">tools</span><span class="v">${show(ts.tools)}</span></li></ul>` : '<p class="sx-none">none</p>'
  const visits = `<div class="sx-row c2">${people}${median}</div>
    <div class="sx-row c4">${card('Pages', topList(ts?.views, { limit: 7 }), { sub: when })}${card('Countries · came from', `${topList(ts?.countries, { limit: 3 })}<div class="sx-sep"></div>${topList(ts?.refs, { limit: 3 })}`, { sub: when })}${card('Passports · not people', `${topList(ts?.tokens, { limit: 3 })}<div class="sx-sep"></div>${notPeople}`, { sub: when })}${card('Actions', actions, { sub: `${when}, people` })}</div>`

  // MCP.
  const mcp = `<div class="sx-row c2">${mcpReq}${mcpClients}</div>
    <div class="sx-row c2">${card('Calls', topList(ts?.mcp_calls, { limit: 7, cls: 'mcp' }), { sub: ts ? `${when} · ${toolCalls(ts)} tool calls of ${sum(ts.mcp_calls)}` : when })}${card('Client names', topList(ts?.mcp_client_names, { limit: 7, cls: 'mcp' }), { sub: when })}</div>`

  // Recorder: per chain, a chart of the last runs' time against their budget, and the table.
  const recorder = `<div class="sx-row c2 rec">${chains.map(([c, rs]) => {
    const old = [...rs].reverse()
    const chart = rs.length ? histogram({
      title: `${CHAIN[c] || c}, run time`, kind: 'rec', legend: `${key('ok', 'ok')}${key('warn', '80%+ of budget')}${key('bad', 'stopped')}${key('mk', 'budget')}`, aria: `${CHAIN[c] || c}: the last runs' time against their budget`, single: true,
      slots: old.map((r) => ({ label: hhmm(r), value: r.duration_s ?? null, mark: r.budget_s ?? 0, cls: runState(r), title: `${String(r.started_at || '').slice(0, 16).replace('T', ' ')} UTC: ${r.duration_s ?? '?'} s${r.budget_s ? ` of ${r.budget_s}` : ''}, written ${r.rows_written ?? '?'}/${r.tokens_considered ?? '?'}${r.aborted ? `, stopped: ${String(r.aborted).slice(0, 80)}` : ''}` })),
    }) : ''
    const table = rs.length ? `<table class="sx-table"><thead><tr><th>started UTC</th><th class="n">took</th><th class="n">written</th><th class="n">top-ups</th><th class="n">429</th><th>chain</th><th>stopped</th></tr></thead><tbody>${rs.map((r) => {
      const n429 = Object.values(r.timing || {}).reduce((n, x) => n + num(x?.n_429), 0)
      const took = r.duration_s != null ? `${r.duration_s} s${r.budget_s ? ` of ${r.budget_s}` : ''}` : ''
      const st = runState(r)
      return `<tr class="${st === 'ok' ? '' : st}"><td>${esc(hhmm(r))}</td><td class="n">${esc(took)}</td><td class="n">${show(r.rows_written)}/${show(r.tokens_considered)}</td><td class="n">${show(r.supplemented ?? 0)}${r.supplement_errors ? ` (${show(r.supplement_errors)} failed)` : ''}</td><td class="n">${n429}</td><td>${esc(r.onchain ? (r.onchain.breaker ? 'breaker open' : r.onchain.error ? 'unreachable' : `${r.onchain.tokens_read} read`) : '')}</td><td class="cut" title="${esc(r.aborted ? String(r.aborted) : '')}">${esc(r.aborted ? String(r.aborted).slice(0, 60) : '')}</td></tr>`
    }).join('')}</tbody></table>` : '<p class="sx-none">no run today or yesterday</p>'
    return `<div class="sx-col">${chart}${card(`Recorder, ${CHAIN[c] || c}`, table, { sub: rs.length ? `last ${rs.length} runs, newest first` : '' })}</div>`
  }).join('')}</div>`

  // Exam: the score as one stacked bar, the set, and the metrics the summary carries.
  let examPanel = `<div class="sx-row c1 fit">${card('Public exam', '<p class="sx-none">no exam report from the last 36 h</p>')}</div>`
  if (exam) {
    const total = Math.max(1, num(exam.total)), m = exam.metrics || {}
    const refused = num(m.refused), failed = num(exam.failures_total), passed = num(exam.passed)
    const seg = [['ok', passed, 'passed'], ['warn', refused, 'refused'], ['bad', failed, 'failures']]
    let x = 0
    const stack = `<svg class="sx-stack" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${esc(`${passed} passed, ${refused} refused, ${failed} failures of ${num(exam.total)}`)}">${seg.map(([c, v, w]) => { const wd = Math.min(100 - x, (v / total) * 100); const r = wd > 0 ? `<rect class="${c}" x="${x.toFixed(2)}" y="0" width="${wd.toFixed(2)}" height="10"><title>${esc(`${v} ${w}`)}</title></rect>` : ''; x += Math.max(0, wd); return r }).join('')}</svg>`
    const counts = exam.set?.counts || {}
    const row = (k, v) => `<li><span class="k">${esc(k)}</span><span class="v">${v}</span></li>`
    const yes = (b) => (b === true ? 'match' : b === false ? 'no match' : '·')
    examPanel = `<div class="sx-row c2 fit">
      ${card('Public exam', `<p class="sx-big">${show(exam.passed)}<small>/${show(exam.total)} passed</small></p>${stack}<p class="sx-leg sx-legrow">${seg.map(([c, v, w]) => `${key(c, `${w} ${v}`)}`).join('')}</p><div class="sx-sep"></div>${topList(Object.entries(counts).map(([k, v]) => [`set ${k}`, v]), { limit: 4 })}`, { sub: `${exam.day} · set ${String(exam.set?.sha256 || '').slice(0, 12)}` })}
      ${card('Metrics', `<ul class="sx-kv two">${[
        row('asked', show(m.asked)), row('false listed', show(m.false_listed)), row('false not listed', show(m.false_not_listed)), row('real called fake', show(m.real_called_fake)),
        row('lookalikes caught', `${show(m.lookalikes_caught)}/${show(m.lookalikes)}`), row('minted wrong', show(m.minted_wrong)), row('refused', show(m.refused)), row('failures', show(exam.failures_total)),
        row('list proof, Base', yes(m.list_proof?.base)), row('list proof, Robinhood', yes(m.list_proof?.robinhood)),
        row('price, onchain', `${show(m.price_evidence?.onchain)}/${show(m.price_evidence?.tried)}`), row('price, same bytes', `${show(m.price_evidence?.same_bytes)}/${show(m.price_evidence?.tried)}`),
        row('price, no evidence', show(m.price_evidence?.none)), row('verify ms', `p50 ${show(m.verify_ms?.p50)} · p95 ${show(m.verify_ms?.p95)}`),
      ].join('')}</ul>`, { sub: exam.finished_at ? `finished ${String(exam.finished_at).slice(0, 16).replace('T', ' ')} UTC` : '' })}
    </div>`
  }

  // Days: every number by day, as a table.
  const dayRows = [...days].reverse().map(({ day, summary: s }) => s
    ? `<tr><td>${esc(day)}</td><td class="n">${show(s.people)}</td><td class="n">${show(s.engaged)}</td><td class="n">${show(s.median_visible_s)}</td><td class="n">${show(s.browsers_without_beacon)}</td><td class="n">${show(s.bots)}</td><td class="n">${show(s.tools)}</td><td class="n">${show(s.mcp_clients)}</td><td class="n">${toolCalls(s)}</td><td class="n">${sum(s.mcp_calls)}</td></tr>`
    : `<tr class="sx-empty"><td>${esc(day)}</td><td colspan="9">no data</td></tr>`).join('')
  const dayTable = `<div class="sx-row c1 fit">${card('By day', `<table class="sx-table"><thead><tr><th>day</th><th class="n">people</th><th class="n">30 s+</th><th class="n">median s</th><th class="n">no beacon</th><th class="n">bots</th><th class="n">tools</th><th class="n">MCP clients</th><th class="n">tool calls</th><th class="n">MCP requests</th></tr></thead><tbody>${dayRows}</tbody></table>`, { sub: 'newest first, UTC' })}</div>`

  const panels = { overview, visits, mcp, recorder, exam: examPanel, days: dayTable }
  const range = days.length ? `${days[0].day} to ${days[days.length - 1].day} UTC` : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="color-scheme" content="dark light">
  <title>Stats · Proof of Stock</title>
  <meta name="theme-color" content="#050608">
  <link rel="stylesheet" href="${assets.css}">
  <link rel="stylesheet" href="${assets.docsCss}">
</head>
<body class="dx sx">
  <header class="dx-bar">
    <a class="dx-brand" href="./"><span class="dx-logo" aria-hidden="true"></span><span>Proof of Stock</span><span class="dx-docs">Stats</span></a>
    <span></span><nav class="dx-links"><a href="status">Status</a><a href="history">History</a></nav><span></span>
  </header>
  <main class="sx-main">
    <div class="sx-top-line"><h1>Stats</h1><p class="sx-sub">Private · aggregates only, no address, no user agent · a person counts once a day · ${esc(range)}</p><span class="sx-built">built ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC · v${esc(version)}</span></div>
    <div class="sx-kpis">${tiles}</div>
    ${TABS.map(([id], i) => `<input class="sx-r sr" type="radio" name="sx-tab" id="sx-t-${id}"${i === 0 ? ' checked' : ''}>`).join('')}
    <nav class="sx-tabs" aria-label="Sections">${TABS.map(([id, label]) => `<label for="sx-t-${id}">${esc(label)}</label>`).join('')}</nav>
    <div class="sx-panels">${TABS.map(([id, label]) => `<section class="sx-panel sx-p-${id}" aria-label="${esc(label)}">${panels[id]}</section>`).join('')}</div>
  </main>
</body>
</html>`
}
