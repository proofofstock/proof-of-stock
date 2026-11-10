// apps/stocks-history.mjs — the passport's history as the site serves it (docs/stocks-truth-layer-tz.md §H6): the
// impostor case archive and the registry snapshots that scripts/stocks/{impostor-list,stock-peg}.mjs append
// (evm/core/stocks/history.mjs). Read-only: the site never writes a history file.
//
// Both are small and held whole: a registry snapshot is appended only when the registry changes. Nothing is read from
// disk on a request; refresh() runs with the site's background refresh and keeps the last good copy if a read fails.
//
// ⚠ A BACKFILLED FACT IS SHOWN AS ONE. A case archived from the collector's older history says "first seen by our
//   collector", never "flagged by us", and carries no flag time.

import fs from 'node:fs'
import path from 'node:path'
import { replayCases, HISTORY_DIR } from '../evm/core/stocks/history.mjs'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const DAY = /^\d{4}-\d{2}-\d{2}$/
const files = (dir, prefix) => { try { return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort() } catch { return [] } }
const rowsOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })

/** What the public sees of a case event: the evidence and how it was learned, nothing internal. */
export const publicEvent = (e) => ({ event: e.event, at: e.at, source: e.source, address: e.address, symbol: e.symbol ?? null, name: e.name ?? null,
  kind: e.kind, imitates_symbol: e.registry_symbol ?? null, listed_address: e.registry_address ?? null,
  first_seen_at: e.first_seen_at ?? null, flagged_at: e.flagged_at ?? null, ...(e.previous_kind ? { previous_kind: e.previous_kind } : {}) })

export function createHistoryStore ({ roots }) {
  const state = new Map() // chain → { events, byAddress: Map(address → events), open: Map, startedAt, registry: [index] , error }

  function refresh (chain) {
    const dir = path.join(roots[chain], 'stock-peg', HISTORY_DIR)
    try {
      const events = files(dir, 'cases-').flatMap((f) => rowsOf(path.join(dir, f)))
      const byAddress = new Map()
      for (const e of events) { if (!byAddress.has(e.address)) byAddress.set(e.address, []); byAddress.get(e.address).push(e) }
      const registry = []
      for (const f of files(dir, 'registry-')) {
        rowsOf(path.join(dir, f)).forEach((r) => registry.push({ row: r, fetched_at: r.fetched_at, hash: r.hash, prev_hash: r.prev_hash, records: r.records,
          added: r.added.length, removed: r.removed.length, changed: r.changed.length, added_addresses: r.added.slice(0, 500), removed_addresses: r.removed.slice(0, 500), changed_addresses: r.changed.slice(0, 500) }))
      }
      state.set(chain, { events, byAddress, open: replayCases(events), startedAt: events.length ? events[0].at : null, registry, error: null })
    } catch (e) {
      const prev = state.get(chain)
      state.set(chain, { ...(prev || { events: [], byAddress: new Map(), open: new Map(), startedAt: null, registry: [] }), error: String(e && e.message || e).slice(0, 160) })
    }
  }
  const of = (chain) => state.get(chain) || { events: [], byAddress: new Map(), open: new Map(), startedAt: null, registry: [], error: 'not loaded yet' }

  /** Case events, newest first, with filters and a numeric cursor. */
  function cases (chain, { since = null, event = null, limit = 50, cursor = 0 } = {}) {
    const s = of(chain)
    const t = since ? Date.parse(since) : null
    const list = s.events.filter((e) => (!event || e.event === event) && (t == null || Date.parse(e.at) >= t)).slice().reverse()
    const counts = { open: s.open.size, opened: 0, listed: 0, gone: 0, kind_changed: 0, backfilled: 0 }
    for (const e of s.events) { counts[e.event] = (counts[e.event] || 0) + 1; if (e.source === 'backfilled') counts.backfilled++ }
    const page = list.slice(cursor, cursor + limit)
    return { chain, archive_started_at: s.startedAt, counts, count: list.length, events: page.map(publicEvent), next: cursor + limit < list.length ? cursor + limit : null, error: s.error }
  }

  /** One address's case: its events and a plain summary, or null when it was never a case. */
  function caseOf (chain, address) {
    const ev = of(chain).byAddress.get(address)
    if (!ev || !ev.length) return null
    const opened = ev.find((e) => e.event === 'opened')
    const last = ev[ev.length - 1]
    return { status: last.event === 'listed' ? 'listed_by_issuer' : last.event === 'gone' ? 'closed' : 'open',
      first_seen_at: opened?.first_seen_at ?? null, flagged_at: opened?.flagged_at ?? null, source: opened?.source ?? null,
      archived_at: opened?.at ?? null, closed_at: ['listed', 'gone'].includes(last.event) ? last.at : null, events: ev.map(publicEvent) }
  }

  /** The registry snapshots of a chain (index only), or the one in force on a day, with its full list. */
  function registry (chain, { date = null } = {}) {
    const s = of(chain)
    const index = s.registry.map(({ row, added_addresses, removed_addresses, changed_addresses, ...meta }) => meta)
    if (!date) return { chain, snapshots: index.slice().reverse(), count: index.length, error: s.error }
    if (!DAY.test(date)) return { status: 400, error: 'date must be YYYY-MM-DD' }
    const end = Date.parse(date + 'T23:59:59.999Z')
    const pick = [...s.registry].reverse().find((r) => Date.parse(r.fetched_at) <= end)
    if (!pick) return { chain, date, snapshot: null, reason: s.registry.length ? `the archive begins ${s.registry[0].fetched_at.slice(0, 10)}` : 'no snapshot recorded yet' }
    return { chain, date, in_force_since: pick.fetched_at, snapshot: pick.row }
  }

  return { refresh, cases, caseOf, registry, raw: of }
}

const KIND = { registry_symbol: (e) => `uses the symbol ${e.imitates_symbol}`, issuer_name_suffix: () => 'copies the issuer\'s naming' }
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const CHAIN = { base: ['Base', 'Coinbase'], robinhood: ['Robinhood Chain', 'Robinhood'] }

/** The /history page for people: per chain, the registry snapshots and the case timeline, each with its date and source. */
export function historyPage ({ store, chains, now, version, assets, perChain = 60 }) {
  const sections = chains.map((c) => {
    const [chainName, issuer] = CHAIN[c] || [c, c]
    const cs = store.cases(c, { limit: perChain })
    const reg = store.registry(c)
    const regRows = reg.snapshots.slice(0, 8).map((r) => `<li class="hs-row"><span class="hs-date">${esc(String(r.fetched_at).slice(0, 16).replace('T', ' '))}</span><span class="hs-ev reg">registry</span><span class="hs-what">${esc(issuer)} listed <b>${r.records}</b> tokens${r.prev_hash ? ` · ${[r.added && `+${r.added}`, r.removed && `−${r.removed}`, r.changed && `${r.changed} changed`].filter(Boolean).join(' · ')}` : ' · first snapshot'}</span><code class="hs-hash" title="${esc(r.hash)}">${esc(r.hash.slice(7, 19))}</code></li>`).join('')
    const evRows = cs.events.map((e) => {
      const word = { opened: 'flagged', kind_changed: 'changed', listed: 'listed by issuer', gone: 'left the list' }[e.event] || e.event
      const how = e.source === 'backfilled' ? `<span class="hs-src" title="Archived from our collector's earlier history when the archive began; first seen ${esc(String(e.first_seen_at || '').slice(0, 10))}">from collector history</span>` : ''
      const href = `./?chain=${c}&address=${e.address}`
      return `<li class="hs-row"><span class="hs-date">${esc(String(e.source === 'backfilled' ? e.first_seen_at || e.at : e.at).slice(0, 10))}</span><span class="hs-ev ${esc(e.event)}">${esc(word)}</span><span class="hs-what"><a href="${href}">${esc(e.symbol || '?')}</a> <code>${esc(short(e.address))}</code> ${esc((KIND[e.kind] || (() => e.kind))(e))}, not in the ${esc(issuer)} registry ${how}</span></li>`
    }).join('')
    return `<section class="hs-chain"><h2>${esc(chainName)}</h2>
  <div class="hs-stats"><div><b>${cs.counts.open}</b><span>open cases</span></div><div><b>${cs.counts.listed}</b><span>later listed by ${esc(issuer)}</span></div><div><b>${reg.count}</b><span>registry snapshot${reg.count === 1 ? '' : 's'}</span></div><div><b>${esc(cs.archive_started_at ? cs.archive_started_at.slice(0, 10) : 'not yet')}</b><span>${cs.archive_started_at ? 'case archive began' : 'case archive starts with the next impostor run'}</span></div></div>
  <h3>Registry snapshots</h3><ul class="hs-list">${regRows || '<li class="hs-empty">No snapshot recorded yet.</li>'}</ul>
  <h3>Cases, newest first</h3><ul class="hs-list">${evRows || '<li class="hs-empty">No case recorded yet. The impostor list is archived every 6 hours; the first run writes every case it already holds, marked as from collector history.</li>'}</ul>
  ${cs.count > cs.events.length ? `<p class="hs-more">${cs.count - cs.events.length} older events: <a href="api/history/cases?chain=${c}&amp;cursor=${cs.events.length}">api/history/cases?chain=${c}</a></p>` : ''}
</section>`
  }).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>History · Stock Token Passport</title>
  <meta name="description" content="What each issuer listed and which contracts imitated their stock tokens, dated, append-only.">
  <meta name="theme-color" content="#08090c">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@300;400;600&amp;family=Onest:wght@400;500;600;700&amp;display=swap">
  <link rel="stylesheet" href="${assets.css}">
  <link rel="stylesheet" href="${assets.docsCss}">
  ${assets.beacon ? `<script src="${assets.beacon}" defer></script>` : ''}
</head>
<body class="dx">
  <header class="dx-bar">
    <a class="dx-brand" href="./"><span class="dx-logo" aria-hidden="true"><span class="i i-chev"></span></span><span>Stock Token Passport</span><span class="dx-docs">History</span></a>
    <span></span>
    <nav class="dx-links"><a href="./"><span class="ic ic-terminal" aria-hidden="true"></span>Terminal</a><a href="status"><span class="ic ic-pulse" aria-hidden="true"></span>Status</a><a href="docs/"><span class="ic ic-doc" aria-hidden="true"></span>Docs</a></nav>
    <a class="dx-cta" href="docs/tutorials/connect-an-agent.md"><span aria-hidden="true">+</span> Connect an agent</a>
  </header>
  <main class="hs-main">
    <h1>History</h1>
    <p class="hs-lede">What each issuer listed, and which contracts used its tokens' names, with dates. Every row is appended and never rewritten. A case from before the archive began is marked as coming from our collector's history.</p>
    ${sections}
    <p class="st-note">Updated ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC · v${esc(version)} · for code: <a href="api/history/cases">/api/history/cases</a>, <a href="api/history/registry">/api/history/registry</a> · "Not in the registry" is a fact about one list, not a verdict on a token.</p>
  </main>
</body>
</html>`
}
