// apps/stocks-history.mjs: the passport's history as the site serves it (docs/stocks-truth-layer-tz.md §H6): the
// impostor case archive and the registry snapshots that scripts/stocks/{impostor-list,stock-peg}.mjs append
// (evm/core/stocks/history.mjs). Read-only: the site never writes a history file.
//
// Both are small and held whole: a registry snapshot is appended only when the registry changes. Nothing is read from
// disk on a request; refresh() runs with the site's background refresh and keeps the last good copy if a read fails.
//
// ⚠ A BACKFILLED FACT IS SHOWN AS ONE. A case archived from the collector's older history says "first seen by our
//   collector", never "flagged by us", and carries no flag time.

import { siteBar } from './stocks-nav.mjs'
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
  ...('text_evidence' in e ? { text_evidence: e.text_evidence } : {}),
  ...(e.event === 'gone' ? { gone_reason: e.gone_reason ?? null } : {}) })

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
      // A close recorded before gone_reason existed (17.11 and earlier) gets it from the registry archive: did the
      // imitated contract leave the issuer's list at or before the close? The same rule as caseEvents, applied late.
      for (const e of events) {
        if (e.event !== 'gone' || e.gone_reason) continue
        const t = Date.parse(e.at)
        const last = registry.filter((r) => Date.parse(r.fetched_at) <= t && (r.added_addresses.includes(e.registry_address) || r.removed_addresses.includes(e.registry_address))).pop()
        e.gone_reason = e.registry_address && last && last.removed_addresses.includes(e.registry_address) ? 'imitated_left_list' : 'no_longer_matches'
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
    // A real calendar day: Date.parse rolls 2026-02-30 over to 2 March, and an answer for another day than the one asked is wrong.
    if (!DAY.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) return { status: 400, error: 'date must be YYYY-MM-DD' }
    const end = Date.parse(date + 'T23:59:59.999Z')
    const pick = [...s.registry].reverse().find((r) => Date.parse(r.fetched_at) <= end)
    if (!pick) return { chain, date, snapshot: null, reason: s.registry.length ? `the archive begins ${s.registry[0].fetched_at.slice(0, 10)}` : 'no snapshot recorded yet' }
    return { chain, date, in_force_since: pick.fetched_at, snapshot: pick.row }
  }

  return { refresh, cases, caseOf, registry, raw: of }
}

const KIND = { registry_symbol: (e) => `uses the symbol ${e.imitates_symbol}`, issuer_name_suffix: () => 'copies the issuer\'s naming', registry_name: (e) => `uses the company name behind ${e.imitates_symbol}` }
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
      const word = { opened: 'flagged', kind_changed: 'changed', listed: 'listed by issuer', gone: 'closed' }[e.event] || e.event
      const why = e.event !== 'gone' ? '' : e.gone_reason === 'imitated_left_list' ? ` &middot; closed because ${esc(e.imitates_symbol || 'the stock it imitated')} left the ${esc(issuer)} list` : ' &middot; closed: it no longer copies a listed stock'
      const how = e.source === 'backfilled' ? `<span class="hs-src" title="Archived from our collector's earlier history when the archive began; first seen ${esc(String(e.first_seen_at || '').slice(0, 10))}">from collector history</span>` : ''
      const href = `./?chain=${esc(c)}&amp;address=${esc(e.address)}`
      return `<li class="hs-row"><span class="hs-date">${esc(String(e.source === 'backfilled' ? e.first_seen_at || e.at : e.at).slice(0, 10))}</span><span class="hs-ev ${esc(e.event)}">${esc(word)}</span><span class="hs-what"><a href="${href}">${esc(e.symbol || '?')}</a> ${esc((KIND[e.kind] || (() => e.kind))(e))}, not in the ${esc(issuer)} registry &middot; ${addressOut(e, explorers[c])}${why} ${how}</span></li>`
    }).join('')
    return `<section class="hs-chain"><h2>${esc(chainName)}</h2>
  <div class="hs-stats"><div><b>${cs.counts.open}</b><span>open cases</span></div><div><b>${cs.counts.listed}</b><span>later listed by ${esc(issuer)}</span></div><div><b>${reg.count}</b><span>registry snapshot${reg.count === 1 ? '' : 's'}</span></div><div><b>${esc(cs.archive_started_at ? cs.archive_started_at.slice(0, 10) : 'not yet')}</b><span>${cs.archive_started_at ? 'case archive began' : 'case archive starts with the next impostor run'}</span></div></div>
  <h3>Registry snapshots${reg.count > 8 ? `, the newest 8 of ${esc(reg.count)}` : ''}</h3><ul class="hs-list">${regRows || '<li class="hs-empty">No snapshot recorded yet.</li>'}</ul>${reg.count > 8 ? `<p class="hs-more">Every snapshot: <a href="api/history/registry?chain=${esc(c)}">/api/history/registry?chain=${esc(c)}</a>; add <code>&amp;date=YYYY-MM-DD</code> for the full list in force that day.</p>` : ''}
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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2080%2092%22%20width%3D%2280%22%20height%3D%2292%22%20role%3D%22img%22%20aria-label%3D%22Proof%20of%20Stock%20guard%22%3E%3Ctitle%3EProof%20of%20Stock%20guard%3C%2Ftitle%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g-plate%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220.35%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%231B2742%22%2F%3E%3Cstop%20offset%3D%220.45%22%20stop-color%3D%22%230D1526%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23070C18%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22g-rim%22%20x1%3D%220.1%22%20y1%3D%220%22%20x2%3D%220.9%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23A9C8FF%22%2F%3E%3Cstop%20offset%3D%220.35%22%20stop-color%3D%22%234B87FF%22%2F%3E%3Cstop%20offset%3D%220.75%22%20stop-color%3D%22%231E4FD8%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2315347F%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22g-disc%22%20x1%3D%220.2%22%20y1%3D%220%22%20x2%3D%220.8%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%239CC0FF%22%2F%3E%3Cstop%20offset%3D%220.4%22%20stop-color%3D%22%234B87FF%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%232A5FD8%22%2F%3E%3C%2FlinearGradient%3E%3ClinearGradient%20id%3D%22g-gloss%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%220%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23FFFFFF%22%20stop-opacity%3D%220.26%22%2F%3E%3Cstop%20offset%3D%220.55%22%20stop-color%3D%22%23FFFFFF%22%20stop-opacity%3D%220.06%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23FFFFFF%22%20stop-opacity%3D%220%22%2F%3E%3C%2FlinearGradient%3E%3CradialGradient%20id%3D%22g-glow%22%20cx%3D%220.5%22%20cy%3D%220.42%22%20r%3D%220.6%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%234B87FF%22%20stop-opacity%3D%220.35%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%234B87FF%22%20stop-opacity%3D%220%22%2F%3E%3C%2FradialGradient%3E%3Cpath%20id%3D%22g-shape%22%20d%3D%22M40%204%2072%2013v30c0%2018.5-12.8%2032.4-32%2041.6C20.8%2075.4%208%2061.5%208%2043V13z%22%2F%3E%3CclipPath%20id%3D%22g-clip%22%3E%3Cuse%20href%3D%22%23g-shape%22%2F%3E%3C%2FclipPath%3E%3Cfilter%20id%3D%22f-drop%22%20x%3D%22-30%25%22%20y%3D%22-25%25%22%20width%3D%22160%25%22%20height%3D%22160%25%22%3E%3CfeDropShadow%20dx%3D%220%22%20dy%3D%223%22%20stdDeviation%3D%223.2%22%20flood-color%3D%22%2304070F%22%20flood-opacity%3D%220.75%22%2F%3E%3C%2Ffilter%3E%3Cfilter%20id%3D%22f-emboss%22%20x%3D%22-20%25%22%20y%3D%22-20%25%22%20width%3D%22140%25%22%20height%3D%22140%25%22%3E%3CfeOffset%20in%3D%22SourceAlpha%22%20dx%3D%220%22%20dy%3D%221.4%22%20result%3D%22o%22%2F%3E%3CfeGaussianBlur%20in%3D%22o%22%20stdDeviation%3D%221.1%22%20result%3D%22b%22%2F%3E%3CfeFlood%20flood-color%3D%22%2304070F%22%20flood-opacity%3D%220.55%22%2F%3E%3CfeComposite%20in2%3D%22b%22%20operator%3D%22in%22%20result%3D%22sh%22%2F%3E%3CfeMerge%3E%3CfeMergeNode%20in%3D%22sh%22%2F%3E%3CfeMergeNode%20in%3D%22SourceGraphic%22%2F%3E%3C%2FfeMerge%3E%3C%2Ffilter%3E%3C%2Fdefs%3E%3Cg%20filter%3D%22url%28%23f-drop%29%22%3E%3Cuse%20href%3D%22%23g-shape%22%20fill%3D%22url%28%23g-plate%29%22%2F%3E%3Cg%20clip-path%3D%22url%28%23g-clip%29%22%3E%3Crect%20x%3D%220%22%20y%3D%220%22%20width%3D%2280%22%20height%3D%2292%22%20fill%3D%22url%28%23g-glow%29%22%2F%3E%3Cpath%20d%3D%22M8%2013%2040%204l32%209v16c-10%206.5-22%2010-32%2010S18%2035.5%208%2029z%22%20fill%3D%22url%28%23g-gloss%29%22%2F%3E%3Cg%20filter%3D%22url%28%23f-emboss%29%22%20transform%3D%22translate%2840%2043%29%20scale%282.55%29%20translate%28-8%20-8%29%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%227%22%20fill%3D%22url%28%23g-disc%29%22%2F%3E%3Cpath%20d%3D%22M-8%208h14V6h4v2h14v1H9V7H7v2H-8z%22%20fill%3D%22%230B1020%22%20fill-opacity%3D%220.92%22%2F%3E%3C%2Fg%3E%3C%2Fg%3E%3Cuse%20href%3D%22%23g-shape%22%20fill%3D%22none%22%20stroke%3D%22url%28%23g-rim%29%22%20stroke-width%3D%223%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cuse%20href%3D%22%23g-shape%22%20fill%3D%22none%22%20stroke%3D%22%23FFFFFF%22%20stroke-opacity%3D%220.18%22%20stroke-width%3D%221%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate%280%201.1%29%20scale%280.985%29%20translate%280.6%200%29%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E">
  <link rel="stylesheet" href="${assets.css}">
  <link rel="stylesheet" href="${assets.docsCss}">
  ${assets.beacon ? `<script src="${assets.beacon}" defer></script>` : ''}
</head>
<body class="dx">
  ${siteBar({ current: 'history' })}
  <main class="hs-main">
    <h1>History</h1>
    <p class="hs-lede">What each issuer listed, and which contracts used its tokens' names, with dates. Every row is appended and never rewritten. A case from before the archive began is marked as coming from our collector's history.</p>
    ${sections}
    <p class="st-note">Updated ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC · v${esc(version)} · for code: <a href="api/history/cases">/api/history/cases</a>, <a href="api/history/registry">/api/history/registry</a> · "Not in the registry" is a fact about one list, not a verdict on a token.</p>
  </main>
</body>
</html>`
}
