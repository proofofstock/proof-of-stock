/**
 * The landing's wall of findings ("Look-alikes we flagged this week"), written into the page by the server.
 *
 * Until 22.11 the board came only from app.js, so a reader that does not run scripts (a search engine, an agent, a
 * judge's AI helper) saw "Loading the case archive." and an empty table where a browser saw 24 rows. The outside review
 * (21.11) asked for the board to arrive as HTML. The script still redraws it on load and every 5 minutes, with
 * the click that opens a row's passport; this is the same board, said once before the script runs.
 *
 * It mirrors findingsBoard() in apps/stocks-web/app.js: the same 24 newest events of the 7-day window, the same labels,
 * the same counts sentence. apps/landing-board.test.mjs runs both on one input and holds them equal.
 *
 * One cell differs, on purpose. A token's symbol and name are its creator's text, and the page itself carries none of
 * it (apps/untrusted-text.test.mjs): a crawler or an agent reading the HTML gets no warning that a cell is a stranger's
 * words, and the words can be an instruction. So the token cell here is the contract's short address; the script then
 * writes the symbol and name in, as text, the way it always has. What a token copies is the listed symbol, the issuer's
 * own text, and stays. Nothing here links out (the board must not advertise a fake).
 */

export const BOARD_LIMIT = 24
export const CHAIN_LABEL = { all: 'both', base: 'Base', robinhood: 'Robinhood Chain' }
export const BOARD_STATUS = { opened: 'open', listed: 'later listed by the issuer: we were early or wrong', gone: 'closed', kind_changed: 'kind changed' }
export const GONE_WHY = { imitated_left_list: 'closed: the stock it copied left the issuer\'s list', no_longer_matches: 'closed: no longer copies a listed stock', rule_narrowed: 'closed: our name rule was narrowed; the token did not change' }
export const BOARD_UNREADABLE = 'The case archive could not be read right now.'
export const BOARD_EMPTY = 'No new look-alikes flagged in the last 7 days.'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** The age of a flag, as app.js says it. */
export const age = (s) => {
  if (s == null) return 'time unknown'
  if (s < 90) return s + ' s ago'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  if (s < 172800) return Math.round(s / 3600) + ' h ago'
  return Math.round(s / 86400) + ' days ago'
}

/** The token cell before the script runs: the contract, never its creator's text. */
export const shortAddress = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a)) ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?')

const why = (kind) => (kind === 'registry_name' ? 'by name' : kind === 'ticker' ? 'by ticker' : kind === 'registry_symbol' ? 'by symbol' : kind === 'issuer_name_suffix' ? 'by naming' : '')

/**
 * The board from an /api/history/cases answer for every chain ({ chains: { base: {...}, robinhood: {...} } }).
 * Returns null where nothing can be said (no chain readable): the page then keeps its own placeholder and the script
 * decides, as before.
 */
export function boardOf (casesByChain, { now = Date.now(), hideRh = false } = {}) {
  const per = Object.entries(casesByChain || {}).filter(([c, v]) => v && !v.error && !(hideRh && c === 'robinhood'))
  if (!per.length) return null
  const ev = per.flatMap(([c, v]) => (v.events || []).map((e) => ({ ...e, chain: c }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, BOARD_LIMIT)
  const open = per.map(([c, v]) => `${v.counts?.open ?? 0} on ${CHAIN_LABEL[c] || c}`).join(', ')
  const week = per.reduce((n, [, v]) => n + (v.count || 0), 0)
  const missed = ev.filter((e) => e.event === 'listed').length
  const counts = `Open cases: ${open}. This week: ${week} new event${week === 1 ? '' : 's'}${missed ? `, ${missed} later listed by the issuer` : ''}.`
  const rows = ev.map((e) => {
    const copies = e.imitates_symbol || (e.kind === 'issuer_name_suffix' ? "the issuer's naming" : '?')
    const status = (e.event === 'gone' && GONE_WHY[e.gone_reason]) || BOARD_STATUS[e.event] || e.event
    const since = (e.event === 'opened' || !e.flagged_at) ? '' : `<span class="board-why">flagged ${esc(age(Math.round((now - Date.parse(e.flagged_at)) / 1000)))}</span>`
    return `<tr class="click${e.event === 'gone' ? ' closed' : ''}" tabindex="0">` +
      `<td>${esc(CHAIN_LABEL[e.chain] || e.chain)}</td>` +
      `<td><code>${shortAddress(e.address)}</code></td>` +
      `<td>${esc(copies)}<span class="board-why">${why(e.kind)}</span></td>` +
      `<td>${esc(age(Math.round((now - Date.parse(e.at)) / 1000)))}${since}</td>` +
      `<td${e.event === 'listed' ? ' class="warn"' : ''}>${esc(status)}</td></tr>`
  })
  return { counts, rows, empty: ev.length === 0 }
}

/** The page with the board written in. Markup it does not find is left alone, and so is a board that cannot be said. */
export function withBoard (html, board) {
  if (!board) return html
  let out = String(html).replace('<p class="board-counts" id="board-counts">Loading the case archive.</p>', `<p class="board-counts" id="board-counts">${esc(board.counts)}</p>`)
  if (board.empty) {
    return out.replace('<div class="board-wrap">', '<div class="board-wrap" hidden>').replace('<p class="board-empty" id="board-empty" hidden></p>', `<p class="board-empty" id="board-empty">${BOARD_EMPTY}</p>`)
  }
  return out.replace('<tbody id="board-rows"></tbody>', `<tbody id="board-rows">${board.rows.join('')}</tbody>`)
}
