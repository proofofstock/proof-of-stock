// apps/stocks-history.mjs: the passport's history as the site serves it (docs/stocks-truth-layer-tz.md §H6): the
// impostor case archive and the registry snapshots that scripts/stocks/{impostor-list,stock-peg}.mjs append
// (evm/core/stocks/history.mjs). Read-only: the site never writes a history file.
//
// Both are small and held whole: a registry snapshot is appended only when the registry changes. Nothing is read from
// disk on a request; refresh() runs with the site's background refresh and keeps the last good copy if a read fails.
//
// ⚠ A BACKFILLED FACT IS SHOWN AS ONE. A case archived from the collector's older history says "first seen by our
//   collector", never "flagged by us", and carries no flag time.

import { symbolLabel, nameLabel, UNTRUSTED_TEXT_NOTE } from '../evm/core/stocks/untrusted-text.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { replayCases, HISTORY_DIR } from '../evm/core/stocks/history.mjs'

// ⚠ LISTS ARE A WINDOW, AN ADDRESS IS ALWAYS ANSWERED. The archive is what nobody else has, so a list shows only the
//   last BULK_WINDOW_DAYS days of observed events, at most BULK_MAX at a time; backfilled cases are never listed. Any
//   one address still gets its whole case (caseOf, carried by /verify and the passport), and the counts stay public.
//   The full archive is available on request.
export const BULK_WINDOW_DAYS = 7
export const BULK_MAX = 50
export const FULL_ARCHIVE = 'The full archive is available on request: hello@proofofstock.xyz'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const DAY = /^\d{4}-\d{2}-\d{2}$/
// A missing directory is an archive not started; any other error is thrown, so refresh() keeps the last good copy and
// says so, instead of replacing it with an empty archive.
const files = (dir, prefix) => { try { return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort() } catch (e) { if (e && e.code === 'ENOENT') return []; throw e } }
const rowsOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })

/** What the public sees of a case event: the evidence and how it was learned, nothing internal. */
export const publicEvent = (e) => ({ event: e.event, at: e.at, source: e.source, address: e.address, symbol: symbolLabel(e.symbol), name: nameLabel(e.name),
  kind: e.kind, imitates_symbol: e.registry_symbol ?? null, listed_address: e.registry_address ?? null,
  first_seen_at: e.first_seen_at ?? null, flagged_at: e.flagged_at ?? null, ...(e.previous_kind ? { previous_kind: e.previous_kind } : {}),
  // What the chain itself returned for symbol() and name() when the case opened (hex, schema-checked), where recorded.
  ...('text_evidence' in e ? { text_evidence: e.text_evidence } : {}) })

export function createHistoryStore ({ roots, now = () => Date.now(), log = () => {} }) {
  const state = new Map() // chain → { events, byAddress: Map(address → events), open: Map, startedAt, registry: [index] , error }

  function refresh (chain) {
    const dir = path.join(roots[chain], 'stock-peg', HISTORY_DIR)
    try {
      const events = files(dir, 'cases-').flatMap((f) => rowsOf(path.join(dir, f)))
      const byAddress = new Map()
      for (const e of events) { if (!byAddress.has(e.address)) byAddress.set(e.address, []); byAddress.get(e.address).push(e) }
      const registry = []
      for (const f of files(dir, 'registry-')) {
        // A row missing its lists or hash is skipped, not trusted: one bad row must not stop every later refresh.
        rowsOf(path.join(dir, f)).filter((r) => r && typeof r.hash === 'string' && typeof r.fetched_at === 'string' && Array.isArray(r.added) && Array.isArray(r.removed) && Array.isArray(r.changed)).forEach((r) => registry.push({ row: r, fetched_at: r.fetched_at, hash: r.hash, prev_hash: r.prev_hash, records: r.records,
          added: r.added.length, removed: r.removed.length, changed: r.changed.length, added_addresses: r.added.slice(0, 500), removed_addresses: r.removed.slice(0, 500), changed_addresses: r.changed.slice(0, 500) }))
      }
      state.set(chain, { events, byAddress, open: replayCases(events), startedAt: events.length ? events[0].at : null, registry, error: null })
    } catch (e) {
      const prev = state.get(chain)
      state.set(chain, { ...(prev || { events: [], byAddress: new Map(), open: new Map(), startedAt: null, registry: [] }), error: 'the history archive could not be read' }) // public; the original only in the journal
      log(`[history ${chain}] ${String(e && e.message || e).slice(0, 300)}`)
    }
  }
  const of = (chain) => state.get(chain) || { events: [], byAddress: new Map(), open: new Map(), startedAt: null, registry: [], error: 'not loaded yet' }

  /**
   * Observed case events of the last BULK_WINDOW_DAYS days, newest first, with filters: the newest BULK_MAX at most.
   * There is no cursor. Paging through the window would hand out the whole week, which the 50-row cap is there to
   * prevent (an audit on 11.11 read 120 events in 3 requests); count still says how many the window holds.
   */
  function cases (chain, { since = null, event = null, limit = BULK_MAX } = {}) {
    const s = of(chain)
    const from = now() - BULK_WINDOW_DAYS * 86400e3
    const t = Math.max(from, since ? Date.parse(since) : from)
    limit = Math.min(BULK_MAX, Math.max(1, limit))
    const list = s.events.filter((e) => e.source !== 'backfilled' && (!event || e.event === event) && Date.parse(e.at) >= t).slice().reverse()
    const counts = { open: s.open.size, opened: 0, listed: 0, gone: 0, kind_changed: 0, backfilled: 0 }
    for (const e of s.events) { counts[e.event] = (counts[e.event] || 0) + 1; if (e.source === 'backfilled') counts.backfilled++ }
    const page = list.slice(0, limit)
    return { chain, archive_started_at: s.startedAt, counts, window_days: BULK_WINDOW_DAYS, window_from: new Date(from).toISOString(), count: list.length, untrusted_text: UNTRUSTED_TEXT_NOTE, events: page.map(publicEvent), older: FULL_ARCHIVE, error: s.error }
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

const KIND = { registry_symbol: (e) => `uses the symbol ${e.imitates_symbol}`, issuer_name_suffix: () => 'copies the issuer\'s naming', registry_name: (e) => `uses the company name of ${e.imitates_symbol}` }
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const CHAIN = { base: ['Base', 'Coinbase'], robinhood: ['Robinhood Chain', 'Robinhood'] }

// A flagged address opens on the chain's explorer only through a warning, as the passport does: the first click unfolds
// what the contract is not, the second opens it. A details element, so it works without a page script under the CSP.
function addressOut (e, explorer) {
  const code = `<code>${esc(short(e.address))}</code>`
  if (!explorer || !/^0x[0-9a-f]{40}$/i.test(String(e.address))) return code
  const host = (() => { try { return new URL(explorer).host } catch (_) { return 'the explorer' } })()
  const href = `${esc(explorer)}/token/${esc(String(e.address).toLowerCase())}`
  // The issuer has listed it since: it is the stock token now, and opens without a warning.
  if (e.event === 'listed') return `<a class="hs-plain" href="${href}" target="_blank" rel="noopener noreferrer nofollow" title="Open on ${esc(host)}">${code}</a>`
  const what = e.imitates_symbol ? `the issuer's ${esc(e.imitates_symbol)}` : 'a listed stock token'
  return `<details class="hs-out"><summary title="Open on ${esc(host)}, after a warning">${code}</summary><div class="hs-warn" role="note"><b>&#9888; This is a look-alike, not the stock.</b> It is not ${what}. Reading it on the explorer is safe; do not buy it, approve it or send anything to it. <a href="${href}" target="_blank" rel="noopener noreferrer nofollow">I understand, open the contract on ${esc(host)}</a></div></details>`
}

/** The /history page for people: per chain, the registry snapshots and the case timeline, each with its date and source. */
export function historyPage ({ store, chains, now, version, assets, explorers = {} }) {
  const sections = chains.map((c) => {
    const [chainName, issuer] = CHAIN[c] || [c, c]
    const cs = store.cases(c, { limit: BULK_MAX })
    const reg = store.registry(c)
    const regRows = reg.snapshots.slice(0, 8).map((r) => `<li class="hs-row"><span class="hs-date">${esc(String(r.fetched_at).slice(0, 16).replace('T', ' '))}</span><span class="hs-ev reg">registry</span><span class="hs-what">${esc(issuer)} listed <b>${esc(r.records)}</b> tokens${r.prev_hash ? ` · ${[r.added && `+${r.added}`, r.removed && `−${r.removed}`, r.changed && `${r.changed} changed`].filter(Boolean).join(' · ')}` : ' · first snapshot'}</span><code class="hs-hash" title="${esc(r.hash)}">${esc(r.hash.slice(7, 19))}</code></li>`).join('')
    const evRows = cs.events.map((e) => {
      const word = { opened: 'flagged', kind_changed: 'changed', listed: 'listed by issuer', gone: 'left the list' }[e.event] || e.event
      const how = e.source === 'backfilled' ? `<span class="hs-src" title="Archived from our collector's earlier history when the archive began; first seen ${esc(String(e.first_seen_at || '').slice(0, 10))}">from collector history</span>` : ''
      const href = `./?chain=${esc(c)}&amp;address=${esc(e.address)}`
      return `<li class="hs-row"><span class="hs-date">${esc(String(e.source === 'backfilled' ? e.first_seen_at || e.at : e.at).slice(0, 10))}</span><span class="hs-ev ${esc(e.event)}">${esc(word)}</span><span class="hs-what"><a href="${href}">${esc(e.symbol || '?')}</a> ${esc((KIND[e.kind] || (() => e.kind))(e))}, not in the ${esc(issuer)} registry &middot; ${addressOut(e, explorers[c])} ${how}</span></li>`
    }).join('')
    return `<section class="hs-chain"><h2>${esc(chainName)}</h2>
  <div class="hs-stats"><div><b>${cs.counts.open}</b><span>open cases</span></div><div><b>${cs.counts.listed}</b><span>later listed by ${esc(issuer)}</span></div><div><b>${reg.count}</b><span>registry snapshot${reg.count === 1 ? '' : 's'}</span></div><div><b>${esc(cs.archive_started_at ? cs.archive_started_at.slice(0, 10) : 'not yet')}</b><span>${cs.archive_started_at ? 'case archive began' : 'case archive starts with the next impostor run'}</span></div></div>
  <h3>Registry snapshots</h3><ul class="hs-list">${regRows || '<li class="hs-empty">No snapshot recorded yet.</li>'}</ul>
  <h3>Cases of the last ${BULK_WINDOW_DAYS} days, newest first</h3><ul class="hs-list">${evRows || `<li class="hs-empty">No new case in the last ${BULK_WINDOW_DAYS} days. The open cases counted above were first seen earlier. The impostor list is archived every 6 hours.</li>`}</ul>
  <p class="hs-more">Events of the last ${BULK_WINDOW_DAYS} days. Every address keeps its whole case: open its passport or <a href="docs/reference/http-api.md#route-verify">/verify</a>. ${esc(FULL_ARCHIVE)}.</p>
</section>`
  }).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>History · Proof of Stock</title>
  <meta name="description" content="What each issuer listed and which contracts imitated their stock tokens, dated, append-only.">
  <meta name="theme-color" content="#08090c">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23070C18'%3E%3C/rect%3E%3Ccircle cx='8' cy='8' r='7' fill='%234B87FF'%3E%3C/circle%3E%3Cpath d='M0 8h6V6h4v2h6v1H9V7H7v2H0z' fill='%23070C18'%3E%3C/path%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@300;400;600&amp;family=Onest:wght@400;500;600;700&amp;display=swap">
  <link rel="stylesheet" href="${assets.css}">
  <link rel="stylesheet" href="${assets.docsCss}">
  ${assets.beacon ? `<script src="${assets.beacon}" defer></script>` : ''}
</head>
<body class="dx">
  <header class="dx-bar">
    <a class="dx-brand" href="./"><span class="dx-logo" aria-hidden="true"></span><span>Proof of Stock</span><span class="dx-docs">History</span></a>
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
