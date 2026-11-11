#!/usr/bin/env node
// scripts/stocks/analytics-report.mjs — the visit counter's daily summary (apps/stocks-analytics.mjs), as markdown.
//   node scripts/stocks/analytics-report.mjs [--dir /var/lib/stp-analytics] [--days 7]
// Aggregates only: no pseudonym, address or user agent is printed.
//
// A PERSON is a pseudonym whose page sent a beacon (its script ran) from a browser user agent. A page the server sent with
// no beacon after it is a bot, a link preview, or a visitor whose browser blocks scripts; those are counted apart.
// Time on a page is the sum of its visible seconds; a page closed without a hide beacon adds nothing.

import fs from 'node:fs'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const top = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
const inc = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by)

const ACTION_LABEL = { section: 'scrolled to', chip: 'buttons under the headline', search: 'searches (kind:outcome)', command: 'commands typed', faq: 'questions opened', copy: 'copied', out: 'links out', tab: 'chain switch' }

/** One day's rows → its summary. Exported for the tests. */
export function summarise (rows) {
  const people = new Set(), loads = new Map(), loadVisitors = new Map()
  const views = new Map(), timeByVisitorPage = new Map(), tokens = new Map(), refs = new Map(), countries = new Map()
  const mcpCalls = new Map(), mcpClients = new Map(), mcpVisitors = new Set()
  const actions = new Map() // action → Map(value → people who did it); a person counts once per action and value
  for (const r of rows) {
    if (r.kind === 'load') { inc(loads, r.ua_class); if (!loadVisitors.has(r.ua_class)) loadVisitors.set(r.ua_class, new Set()); loadVisitors.get(r.ua_class).add(r.visitor) }
    else if ((r.kind === 'view' || r.kind === 'hide') && r.ua_class === 'browser') {
      if (!people.has(r.visitor) && r.country) inc(countries, r.country)
      people.add(r.visitor)
      if (r.kind === 'view') {
        inc(views, r.page)
        if (r.chain && (r.token || r.symbol)) inc(tokens, `${r.chain}:${r.symbol || r.token}`)
        if (r.ref_host) inc(refs, r.ref_host)
      } else {
        const k = r.visitor + ' ' + r.page
        timeByVisitorPage.set(k, (timeByVisitorPage.get(k) || 0) + (r.visible_s || 0))
      }
    } else if (r.kind === 'act' && r.ua_class === 'browser') {
      if (!actions.has(r.action)) actions.set(r.action, new Map())
      const m = actions.get(r.action); if (!m.has(r.value)) m.set(r.value, new Set()); m.get(r.value).add(r.visitor)
    } else if (r.kind === 'mcp') {
      mcpVisitors.add(r.visitor)
      inc(mcpCalls, r.tool ? `tools/call ${r.tool}` : r.method)
      if (r.client) inc(mcpClients, r.client)
    }
  }
  const timeByPage = new Map(), perPerson = new Map()
  for (const [k, s] of timeByVisitorPage) {
    const [v, page] = k.split(' ')
    if (!timeByPage.has(page)) timeByPage.set(page, [])
    timeByPage.get(page).push(s)
    perPerson.set(v, (perPerson.get(v) || 0) + s)
  }
  const totals = [...perPerson.values()]
  const browsersLoaded = loadVisitors.get('browser')?.size || 0
  return {
    people: people.size,
    engaged: totals.filter((s) => s >= 30).length,
    median_visible_s: median(totals),
    browsers_without_beacon: Math.max(0, browsersLoaded - [...(loadVisitors.get('browser') || [])].filter((v) => people.has(v)).length),
    loads: Object.fromEntries(loads), bots: loadVisitors.get('bot')?.size || 0, tools: loadVisitors.get('tool')?.size || 0,
    views: top(views, 15), time_by_page: [...timeByPage.entries()].map(([p, a]) => [p, a.length, median(a), Math.max(...a)]).sort((a, b) => b[1] - a[1]).slice(0, 15),
    tokens: top(tokens, 15), refs: top(refs), countries: top(countries),
    actions: Object.fromEntries([...actions.entries()].map(([a, m]) => [a, [...m.entries()].map(([v, s]) => [v, s.size]).sort((x, y) => y[1] - x[1])])),
    mcp_clients: mcpVisitors.size, mcp_calls: top(mcpCalls, 15), mcp_client_names: top(mcpClients),
  }
}

export function report ({ dir, days = 7, today = new Date().toISOString().slice(0, 10) }) {
  const out = [`# Visit counter — last ${days} days to ${today}`, '', 'People: pages that ran their script in a browser. Pseudonyms change daily, so a person counts once per day.', '']
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10)
    const f = path.join(dir, `hits-${d}.jsonl`)
    if (!fs.existsSync(f)) { out.push(`## ${d}`, '', 'no file', ''); continue }
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
    const s = summarise(rows)
    const list = (a, f2 = ([k, v]) => `${k} ${v}`) => a.length ? a.map(f2).join(', ') : '—'
    out.push(`## ${d}`, '',
      `- **people:** ${s.people}; spent 30 s or more: ${s.engaged}; median visible time per person: ${s.median_visible_s ?? '—'} s`,
      `- **not counted as people:** browsers that loaded a page and sent no beacon ${s.browsers_without_beacon}, bots ${s.bots}, tools ${s.tools}; page loads by class: ${list(Object.entries(s.loads))}`,
      `- **pages viewed:** ${list(s.views)}`,
      `- **time on page** (people, median s, longest s): ${list(s.time_by_page, ([p, n, m, x]) => `${p} ${n} people, ${m} s, ${x} s`)}`,
      `- **passports opened:** ${list(s.tokens)}`,
      `- **came from:** ${list(s.refs)}`,
      `- **countries (people):** ${list(s.countries)}`,
      ...['section', 'chip', 'search', 'command', 'faq', 'copy', 'out', 'tab'].map((a) => `- **${ACTION_LABEL[a]}** (people): ${list(s.actions[a] || [])}`),
      `- **MCP:** ${s.mcp_clients} clients; calls: ${list(s.mcp_calls)}; client names: ${list(s.mcp_client_names)}`, '')
  }
  return out.join('\n')
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
  console.log(report({ dir: arg('--dir', process.env.STP_ANALYTICS_DIR || '/var/lib/stp-analytics'), days: Number(arg('--days', 7)) }))
}
