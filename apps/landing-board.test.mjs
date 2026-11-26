// The landing's wall of findings arrives as HTML (apps/stocks-board.mjs), and it is the same board app.js draws.
// 21.11 the outside review read "Loading the case archive." and an empty table: the board came only from the script, and
// a reader that runs none (a search engine, an agent, a judge's AI helper) saw nothing where a browser saw 24 rows.
// One cell differs on purpose: the page carries none of a creator's text (apps/untrusted-text.test.mjs), so before the
// script runs the token cell is the contract's short address, and the script writes the symbol and name in as text.
// Run: node apps/landing-board.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardOf, withBoard, age, shortAddress, BOARD_LIMIT, BOARD_EMPTY } from './stocks-board.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const html = fs.readFileSync(path.join(HERE, 'stocks-web', 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(HERE, 'stocks-web', 'app.js'), 'utf8')
let passed = 0, failed = 0
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log('  ok  ' + name) } else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) } }

const NOW = Date.parse('2026-11-22T12:00:00Z')
const at = (h) => new Date(NOW - h * 3600e3).toISOString()
const A = (n) => '0x' + String(n).padStart(40, '0')
// Every label the board has, a creator's name that is markup, and more events than the board shows.
const events = [
  { event: 'opened', at: at(1), address: A(1), symbol: 'ANTc', name: 'Anthropic   Coinbase  Tokenized Stock Long', kind: 'registry_name', imitates_symbol: 'ANTc', flagged_at: at(1.5) },
  { event: 'listed', at: at(2), address: A(2), symbol: 'NEWc', name: null, kind: 'registry_symbol', imitates_symbol: 'NEWc', flagged_at: at(30) },
  { event: 'gone', at: at(3), address: A(3), symbol: '<img src=x onerror=alert(1)>', name: '"quoted" & <b>bold</b>', kind: 'ticker', imitates_symbol: 'NVDAc', gone_reason: 'imitated_left_list' },
  { event: 'gone', at: at(4), address: A(4), symbol: null, name: null, kind: 'issuer_name_suffix', imitates_symbol: null, gone_reason: 'something_new' },
  { event: 'kind_changed', at: at(50), address: A(5), symbol: "O'Brien", name: '', kind: 'mystery', imitates_symbol: null },
  ...Array.from({ length: 30 }, (_, i) => ({ event: 'opened', at: at(60 + i), address: A(100 + i), symbol: 'X' + i, name: 'n' + i, kind: 'registry_symbol', imitates_symbol: 'AMDc', flagged_at: at(60 + i) })),
]
const cases = {
  base: { chain: 'base', counts: { open: 93 }, count: 63, events: events.filter((_, i) => i % 2 === 0) },
  robinhood: { chain: 'robinhood', counts: { open: 7 }, count: 10, events: events.filter((_, i) => i % 2 === 1) },
}

// ---- app.js's own findingsBoard, run on the same answer in a minimal DOM, serialised the way the server writes it ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ser = (n) => (typeof n === 'string' ? esc(n) : `<${n.tag}${Object.entries(n.attrs).filter(([k, v]) => !(k === 'class' && v === '')).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${n.kids.map(ser).join('')}</${n.tag}>`)
const h = (tag, attrs, ...kids) => ({ tag, attrs: Object.fromEntries(Object.entries(attrs || {}).filter(([, v]) => v != null && v !== false)), kids: kids.flat().filter((k) => k != null && k !== false).map((k) => (typeof k === 'object' ? k : String(k))), on: {}, addEventListener (t, f) { this.on[t] = f } })
function clientBoard (answer, { hideRh }) {
  const fnSrc = (js.match(/ {2}const BOARD_STATUS = [\s\S]*?\n {2}async function findingsBoard \(\) \{[\s\S]*?\n {2}\}\n/) || [''])[0]
  const labelSrc = (js.match(/^ {2}const CHAIN_LABEL = .*$/m) || [''])[0]
  const ageSrc = (js.match(/^ {2}const age = \(s\) => \{[\s\S]*?\n {2}\}\n/m) || [''])[0]
  if (!fnSrc || !labelSrc || !ageSrc) return null
  const wrap = { hidden: null }
  const el = { '#board-rows': { kids: [], replaceChildren (...k) { this.kids = k }, closest: () => wrap }, '#board-counts': { textContent: '' }, '#board-empty': { textContent: '', hidden: null } }
  const FixedDate = class extends Date { static now () { return NOW } }
  const drawn = []
  const run = new Function('$', 'h', 'api', 'document', 'act', 'toTerminal', 'passport', 'Date',
    `${labelSrc}\n${ageSrc}\n${fnSrc}\nreturn findingsBoard()`)
  const passportSpy = { fn: () => {} }
  return run((s) => el[s], h, async () => answer, { body: { classList: { contains: (c) => c === 'no-rh' && hideRh } } }, () => {}, () => {}, (...a) => passportSpy.fn(...a), FixedDate)
    .then(() => { for (const tr of el['#board-rows'].kids) { let to = null; passportSpy.fn = (c, a) => { to = { chain: c, address: a } }; tr.on.click(); drawn.push(to) } })
    .then(() => ({ counts: el['#board-counts'].textContent, rows: el['#board-rows'].kids.map(ser), ev: drawn, empty: el['#board-empty'].textContent, wrapHidden: wrap.hidden }))
}

// A row with its token cell set aside: everything else must match the script's row exactly.
const TOKEN_CELL = /^(<tr[^>]*><td>[^<]*<\/td>)<td>.*?<\/td>(<td>)/
const withoutToken = (r) => r.replace(TOKEN_CELL, '$1<td>·</td>$2')
const tokenCell = (r) => (r.match(/^<tr[^>]*><td>[^<]*<\/td>(<td>.*?<\/td>)<td>/) || [])[1]

console.log('the server says the board the script draws')
for (const hideRh of [false, true]) {
  const server = boardOf(cases, { now: NOW, hideRh })
  const client = await clientBoard({ chains: cases }, { hideRh })
  check(`app.js's board can be run here (hideRh ${hideRh})`, client != null)
  if (!client) continue
  check(`...the same counts sentence (hideRh ${hideRh})`, server.counts === client.counts, JSON.stringify([server.counts, client.counts]))
  check(`...the same rows, cell for cell (hideRh ${hideRh})`, server.rows.length === client.rows.length && client.rows.every((r) => TOKEN_CELL.test(r)) && server.rows.every((r, i) => withoutToken(r) === withoutToken(client.rows[i])),
    server.rows.map((r, i) => (withoutToken(r) === withoutToken(client.rows[i] || '') ? '' : `#${i}\n  server ${r}\n  client ${client.rows[i]}`)).filter(Boolean)[0] || `${server.rows.length} vs ${client.rows.length}`)
  check(`...and the token cell is the same contract the script's row opens, by its short address (hideRh ${hideRh})`, server.rows.every((r, i) => tokenCell(r) === `<td><code>${shortAddress(client.ev[i].address)}</code></td>`), server.rows.map(tokenCell).slice(0, 3).join(' '))
}
{
  const server = boardOf(cases, { now: NOW })
  check('at most the newest 24 events, newest first', server.rows.length === BOARD_LIMIT && server.rows[0].includes('0x0000…0001') && server.rows[1].includes('0x0000…0002'))
  const said = server.rows.join('') + server.counts
  check('none of a creator\'s text is in the page: no symbol, no name, escaped or not', !/<code>(?!0x[0-9a-f]{4}…[0-9a-f]{4}<)|img|onerror|quoted|bold|Brien|Anthropic|Tokenized|board-name/.test(said) && server.rows[2].includes('<td><code>0x0000…0003</code></td>'), server.rows[2])
  check('...while what it copies, the issuer\'s own symbol, is said', server.rows[0].includes('<td>ANTc<span class="board-why">by name</span></td>') && server.rows[2].includes('<td>NVDAc<span class="board-why">by ticker</span></td>'))
  check('the counts sentence names both chains and the misses', server.counts === 'Open cases: 93 on Base, 7 on Robinhood Chain. This week: 73 new events, 1 later listed by the issuer.', server.counts)
  const base = boardOf(cases, { now: NOW, hideRh: true })
  check('a page that hides Robinhood Chain shows the board for Base alone', base.counts === 'Open cases: 93 on Base. This week: 63 new events.' && !base.rows.join('').includes('Robinhood'), base.counts)
}

console.log('the time column is the event time (owner, 27.11)')
{
  const now = Date.parse('2026-11-27T12:00:00Z')
  const gone = { event: 'gone', at: '2026-11-26T12:00:00Z', flagged_at: '2026-11-19T12:00:00Z', address: '0x' + '1'.repeat(40), kind: 'registry_name', imitates_symbol: 'TRONc', gone_reason: 'rule_narrowed' }
  const open = { event: 'opened', at: '2026-11-27T09:00:00Z', flagged_at: '2026-11-27T09:00:00Z', address: '0x' + '2'.repeat(40), kind: 'registry_symbol', imitates_symbol: 'HOODc' }
  const b = boardOf({ base: { events: [gone, open], counts: { open: 1 }, count: 2 } }, { now })
  check('a close shows when it closed, and under it when the token was flagged', b.rows[1].includes('<td>24 h ago<span class="board-why">flagged 8 days ago</span></td>'), b.rows[1])
  check('...and is dimmed as history, not a live flag', b.rows[1].startsWith('<tr class="click closed"'))
  check('an open case shows only its own time', b.rows[0].includes('<td>3 h ago</td>') && !b.rows[0].includes('closed'))
  check('the header names the column after the event, not the flag', fs.readFileSync(new URL('./stocks-web/index.html', import.meta.url), 'utf8').includes('<th scope="col">when</th>'))
}

console.log('the page carries it')
{
  const page = withBoard(html, boardOf(cases, { now: NOW }))
  const board = (page.match(/<section class="board"[\s\S]*?<\/section>/) || [''])[0]
  check('the page is written with the rows, so a reader without scripts sees them', (board.match(/<tr class="click( closed)?"/g) || []).length === BOARD_LIMIT && !/Loading the case archive/.test(board))
  check('...and the counts sentence in place of "Loading"', board.includes('<p class="board-counts" id="board-counts">Open cases: 93 on Base, 7 on Robinhood Chain.'))
  check('...the token cells name contracts, and the script will write the names in', board.includes('<td><code>0x0000…0001</code></td>') && !board.includes('board-name"'))
  check('...the empty-state line stays hidden and blank while there are rows', board.includes('<p class="board-empty" id="board-empty" hidden></p>') && !board.includes(BOARD_EMPTY))
  check('...it still links nowhere outside the site', !/href="https?:/.test(board))
  check('the markup it writes into is in index.html, so a renamed id cannot leave the board silently unwritten',
    html.includes('<p class="board-counts" id="board-counts">Loading the case archive.</p>') && html.includes('<tbody id="board-rows"></tbody>') && html.includes('<p class="board-empty" id="board-empty" hidden></p>') && html.includes('<div class="board-wrap">'))
  const empty = withBoard(html, boardOf({ base: { counts: { open: 4 }, count: 0, events: [] } }, { now: NOW }))
  check('an empty week says so, with no empty table head over it', empty.includes(`<p class="board-empty" id="board-empty">${BOARD_EMPTY}</p>`) && empty.includes('<div class="board-wrap" hidden>'))
  check('an archive that cannot be read leaves the page as it was, for the script to decide', withBoard(html, boardOf({ base: { error: 'unreadable' } }, { now: NOW })) === html && boardOf({}, { now: NOW }) === null)
}

console.log('the ages are said the way the script says them')
{
  const line = (js.match(/^ {2}const age = \(s\) => \{[\s\S]*?\n {2}\}\n/m) || [''])[0]
  const clientAge = line ? new Function(line + '; return age')() : null
  const probe = [null, 0, 89, 90, 5399, 5400, 172799, 172800, 9e6]
  check('the same words at every boundary', clientAge && probe.every((s) => age(s) === clientAge(s)), probe.map((s) => `${s}: ${age(s)} / ${clientAge && clientAge(s)}`).join('; '))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
