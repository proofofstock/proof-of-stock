// apps/stocks-analytics.mjs — our own visit counter (docs/legal.md "What we count"). No cookies, no third party, no
// stored address. Three kinds of row, appended per UTC day to <dir>/hits-YYYY-MM-DD.jsonl:
//   load  the server sent a page (/, a docs page, /history, /status), with the requester's class: browser, bot or tool
//   view / hide   apps/stocks-web/beacon.js: a page was shown, or hidden after N visible seconds
//   act   an action on the page, as a KIND from ACTIONS (which button, which kind of search and whether it found
//         anything, which question opened, how far down the page): never the text typed, never a position on screen
//   mcp   an MCP call: the JSON-RPC method and, for tools/call, the tool name
//
// ⚠ A VISITOR IS A DAILY PSEUDONYM, NOT A PERSON ID. It is sha256(salt + address + user agent), where the salt is random,
//   held in memory only and replaced at each UTC midnight (and at each restart). The same person is a new visitor the next
//   day, and nobody, us included, can turn a pseudonym back into an address. That is the price of keeping no address.
//
// Off unless a directory is given (STP_ANALYTICS_DIR, set in deployment/systemd/stp-web.service), so a test run or the
// deploy gate never writes into the real counter.
// Writing is best-effort: a directory that cannot be written disables the counter and logs once; the site is unaffected.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const BOT_UA = /bot|crawl|spider|slurp|preview|curl|wget|python|go-http|headless|httpx|axios|node-fetch|undici|scan|monitor|uptime|facebookexternalhit|whatsapp|telegram|discord|slack|embedly|okhttp|java\/|libwww|zgrab|masscan|nuclei|lighthouse|pingdom/i
const PAGE = /^\/(|history|status|docs\/(?:[A-Za-z0-9_.-]+\/){0,3}[A-Za-z0-9_.-]{1,80})$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const SYMBOL = /^[A-Za-z0-9.]{1,12}$/
const HOST = /^[a-z0-9.-]{1,80}$/
const MCP_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized'])
const CLIENT = /^[A-Za-z][A-Za-z0-9 ._-]{0,39}$/
export const DAY_CAP_BYTES = 20 * 1024 * 1024 // one day's file stops growing here; a normal day is far below
export const KEEP_DAYS = 180 // day files older than this are deleted when a new day starts
// One visitor's page rows per day. A person reading the site stays far below; one client re-requesting / in a loop stops
// here instead of filling the day's file by morning. Loads and beacons (view, hide) count separately; MCP rows are not
// capped here (the app's rate limit bounds them).
export const LOADS_PER_VISITOR_DAY = 200
export const BEACONS_PER_VISITOR_DAY = 400
// Visitors tracked for that cap in one day. Past it, a visitor not yet seen today gets no page rows: the memory stays
// bounded and a client rotating its user agent cannot reopen the cap.
export const VISITORS_MAX = 50000

/**
 * The actions a beacon may report, and the values each may carry. A value outside its list drops the row: nothing the
 * visitor typed can reach the file. Search is a kind and an outcome ("ticker:one"), not the query.
 */
export const ACTIONS = Object.freeze({
  chip: /^(NVDA|TSLA|AAPL|MSTR|CRCL|now|impostors|help)$/, // the buttons under the headline (data-run)
  command: /^(help|how|clear|now|matrix|impostors|chain|pick)$/, // typed into the terminal
  search: /^(ticker|name|isin):(none|one|many|error)$|^address:(listed|impostor|unlisted|error)$/,
  tab: /^(base|robinhood|all)$/,
  copy: /^(mcp-url|mcp-cc|mcp-json|address)$/,
  faq: /^q[1-9]$/, // which question was opened, by its place
  section: /^(checks|why|agents|faq|foot)$/, // scrolled into view, once per page view
  out: /^(gecko|explorer|github|registry|other)$/, // a link to another site
})

export const uaClass = (ua) => !ua ? 'tool' : BOT_UA.test(ua) ? 'bot' : /mozilla\//i.test(ua) ? 'browser' : 'tool'

/** Parses and checks a beacon query; null when it is not one we take. */
export function parseHit (sp, chains, isPage = () => true) {
  const event = sp.get('k')
  if (event !== 'view' && event !== 'hide' && event !== 'act') return null
  const page = String(sp.get('p') || '')
  if (!PAGE.test(page) || !isPage(page)) return null
  if (event === 'act') {
    const x = String(sp.get('x') || ''), v = String(sp.get('v') || '')
    if (!Object.hasOwn(ACTIONS, x) || !ACTIONS[x].test(v)) return null
    return { event, page, action: x, value: v }
  }
  const t = Math.floor(Number(sp.get('t')))
  const chain = chains.includes(sp.get('c')) ? sp.get('c') : null
  const a = String(sp.get('a') || '').toLowerCase()
  const s = String(sp.get('s') || '')
  const r = String(sp.get('r') || '').toLowerCase()
  return {
    event, page,
    visible_s: event === 'hide' && Number.isFinite(t) ? Math.min(3600, Math.max(0, t)) : null,
    chain, token: chain && ADDRESS.test(a) ? a : null, symbol: chain && SYMBOL.test(s) ? s : null,
    ref_host: HOST.test(r) ? r : null,
  }
}

export function createAnalytics ({ dir = process.env.STP_ANALYTICS_DIR || null, now = () => Date.now(), log = (m) => console.log(m), enabled = true } = {}) {
  let off = !enabled || !dir
  let salt = null, saltDay = null
  const seen = new Map() // today's visitor -> [loads, beacons]; cleared with the salt
  let seenFull = false
  /** Whether this visitor may add one more row of this kind (0 load, 1 beacon) today. */
  function underCap (v, kind) {
    let n = seen.get(v)
    if (!n) {
      if (seen.size >= VISITORS_MAX) { if (!seenFull) { seenFull = true; log(`[analytics] ${saltDay}: ${VISITORS_MAX} visitors today; new ones get no page rows`) } return false }
      seen.set(v, n = [0, 0])
    }
    if (n[kind] >= (kind === 0 ? LOADS_PER_VISITOR_DAY : BEACONS_PER_VISITOR_DAY)) return false
    n[kind]++
    return true
  }
  const day = () => new Date(now()).toISOString().slice(0, 10)
  function visitor (ip, ua) {
    const d = day()
    if (d !== saltDay) { salt = crypto.randomBytes(32); saltDay = d; seen.clear(); seenFull = false }
    return crypto.createHash('sha256').update(salt).update(String(ip)).update('\n').update(String(ua || '')).digest('hex').slice(0, 16)
  }
  // Bytes written today, read from disk once per day so a restart continues the count.
  let sizeDay = null, size = 0, capped = false
  function write (row) {
    if (off) return
    try {
      const d = day()
      const file = path.join(dir, `hits-${d}.jsonl`)
      if (d !== sizeDay) {
        fs.mkdirSync(dir, { recursive: true })
        sizeDay = d; capped = false
        try { size = fs.statSync(file).size } catch { size = 0 }
        prune(d)
      }
      const line = JSON.stringify(row) + '\n'
      if (size + line.length > DAY_CAP_BYTES) { if (!capped) { capped = true; log(`[analytics] ${d} reached ${DAY_CAP_BYTES} bytes; not counting more today`) } return }
      fs.appendFileSync(file, line)
      size += line.length
    } catch (e) { off = true; log(`[analytics] disabled: ${String(e && e.message || e).slice(0, 160)}`) }
  }
  function prune (today) {
    const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - KEEP_DAYS * 86400e3).toISOString().slice(0, 10)
    for (const f of fs.readdirSync(dir)) {
      const m = /^hits-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
      if (m && m[1] < cutoff) fs.rmSync(path.join(dir, f), { force: true })
    }
  }
  const base = (ip, headers) => {
    const ua = String(headers['user-agent'] || '').slice(0, 300)
    const cc = String(headers['cf-ipcountry'] || '').toUpperCase()
    return { at: new Date(now()).toISOString(), visitor: visitor(ip, ua), ua_class: uaClass(ua), country: /^[A-Z]{2}$/.test(cc) && cc !== 'XX' ? cc : null }
  }
  return {
    /** The server sent a page. */
    load (ip, headers, page) { if (off) return; const b = base(ip, headers); if (underCap(b.visitor, 0)) write({ kind: 'load', ...b, page }) },
    /** A beacon from the page; hit is parseHit()'s result. */
    hit (ip, headers, hit) { if (off) return; const b = base(ip, headers); if (underCap(b.visitor, 1)) write({ kind: hit.event, ...b, ...hit }) },
    /**
     * An MCP request the server accepted: one row, after the answer. Only names the server itself defines are stored
     * (the method, the tool); anything else is "other". The client's own name is kept only as a short plain word.
     * Never the arguments.
     */
    mcp (ip, headers, raw, toolNames = []) {
      let x = null
      try { x = JSON.parse(raw) } catch { return }
      if (!x || Array.isArray(x) || typeof x.method !== 'string') return
      const method = MCP_METHODS.has(x.method) ? x.method : 'other'
      const tool = method === 'tools/call' ? (toolNames.includes(x.params?.name) ? x.params.name : 'other') : null
      const raw_client = method === 'initialize' && typeof x.params?.clientInfo?.name === 'string' ? x.params.clientInfo.name : null
      const client = raw_client && CLIENT.test(raw_client) ? raw_client : raw_client ? 'other' : null
      write({ kind: 'mcp', ...base(ip, headers), method, tool, client })
    },
    get disabled () { return off },
  }
}
