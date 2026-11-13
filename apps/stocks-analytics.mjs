// apps/stocks-analytics.mjs: our own visit counter (docs/legal.md "What we count"). No cookies, no third party, no
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
//
// Some requesters leave no row at all (deployment/STATS.md "Not counting ourselves"): our own checks, the server itself,
// and the addresses the host is configured to skip. That decision is taken before anything is computed or written, so
// an ignored visit is in no number the dashboard shows.

import fs from 'node:fs'
import os from 'node:os'
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
  command: /^(help|how|clear|now|matrix|impostors|exam|chain|pick)$/, // typed into the terminal
  search: /^(ticker|name|isin):(none|one|many|error)$|^address:(listed|impostor|unlisted|error)$/,
  tab: /^(base|robinhood|all)$/,
  copy: /^(mcp-url|mcp-cc|mcp-gpt-url|mcp-json|address)$/,
  faq: /^q[1-9]$/, // which question was opened, by its place
  section: /^(checks|findings|why|agents|faq|foot)$/, // scrolled into view, once per page view
  out: /^(gecko|explorer|github|registry|other)$/, // a link to another site
  board: /^open$/, // a row of the wall of findings opened its passport
})

export const uaClass = (ua) => !ua ? 'tool' : BOT_UA.test(ua) ? 'bot' : /mozilla\//i.test(ua) ? 'browser' : 'tool'

// ---- what we never count -------------------------------------------------------------------------------------------
// The server's own traffic, with nothing to configure: loopback (nginx talks to the app over it, so a request that
// reaches the app from loopback without X-Real-IP came from the host itself) and every address the host's own
// interfaces hold. Anything else is configuration, never code: STP_ANALYTICS_IGNORE, read on the host from
// /etc/pos/analytics.env (deployment/STATS.md). The owner's own address is personal data and this repository is
// exported publicly, so it must not be in it.
export const DEFAULT_IGNORE = Object.freeze(['127.0.0.0/8', '::1/128'])
// Our own checks, which do not come from a fixed address: the CI canary (scripts/canary.mjs) names itself in every
// request. The health check talks to 127.0.0.1, so loopback covers it.
export const IGNORE_UA = /proofofstock-canary/i

/** Four dotted decimal numbers as bytes; null when the text is not that. */
function ipv4Bytes (s) {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null
    const n = Number(parts[i])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

/**
 * An address as bytes: 4 for IPv4, 16 for IPv6. Brackets and a zone (`%eth0`) are dropped; an IPv4-mapped address
 * (`::ffff:1.2.3.4`) comes back as its four IPv4 bytes, so one IPv4 entry covers both forms of the same address.
 * null when the text is not an address, which is how a malformed entry is refused instead of crashing.
 */
export function ipBytes (text) {
  let s = String(text ?? '').trim()
  if (s.startsWith('[')) { const end = s.indexOf(']'); if (end < 0) return null; s = s.slice(1, end) }
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s) return null
  if (!s.includes(':')) return ipv4Bytes(s)
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = halves.map((h) => (h ? h.split(':') : []))
  // An IPv6 address may end in four dotted decimals, which stand for its last two groups.
  const last = groups[groups.length - 1]
  let tail4 = null
  if (last.length && last[last.length - 1].includes('.')) {
    tail4 = ipv4Bytes(last.pop())
    if (!tail4) return null
  }
  if (groups.flat().some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null
  const bytesOf = (gs) => gs.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 0xff] })
  const head = bytesOf(groups[0])
  const rest = [...bytesOf(halves.length === 2 ? groups[1] : []), ...(tail4 || [])]
  const out = new Uint8Array(16)
  if (halves.length === 1) {
    // No "::": every group must be written out.
    if (head.length + rest.length !== 16) return null
    out.set([...head, ...rest])
  } else {
    // "::" stands for at least one group of zeroes, so the written groups cannot fill all sixteen bytes.
    if (head.length + rest.length > 14) return null
    out.set(head, 0)
    out.set(rest, 16 - rest.length)
  }
  // ::ffff:a.b.c.d is that IPv4 address.
  if (out.slice(0, 10).every((b) => b === 0) && out[10] === 0xff && out[11] === 0xff) return out.slice(12)
  return out
}

/** One entry of the list: a plain address, or a CIDR range as `address/bits`. null when it is neither. */
export function parseIgnoreEntry (text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  const slash = s.indexOf('/')
  const addr = slash < 0 ? s : s.slice(0, slash)
  const bytes = ipBytes(addr)
  if (!bytes) return null
  if (slash < 0) return { bytes, bits: bytes.length * 8 }
  const width = s.slice(slash + 1)
  if (!/^\d{1,3}$/.test(width)) return null
  let bits = Number(width)
  if (addr.includes(':') && bytes.length === 4) {
    // An IPv4-mapped range is written over 128 bits: ::ffff:1.2.3.0/120 is the IPv4 /24.
    if (bits < 96 || bits > 128) return null
    bits -= 96
  } else if (bits > bytes.length * 8) return null
  return { bytes, bits }
}

/** Do these two addresses of the same length agree on their first `bits` bits? */
function samePrefix (a, b, bits) {
  const whole = bits >> 3
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false
  const spare = bits & 7
  if (!spare) return true
  const mask = (0xff << (8 - spare)) & 0xff
  return (a[whole] & mask) === (b[whole] & mask)
}

/**
 * Reads the configured list: addresses and CIDR ranges, one per line or several on a line separated by commas,
 * semicolons or spaces, with `#` comments and blank lines. Returns the entries it understood and how many words it
 * did not (never the words themselves: a mistyped entry is still somebody's address, and a log is not the place).
 */
export function parseIgnore (text) {
  const entries = []
  let bad = 0
  for (const line of String(text ?? '').split(/[\r\n]+/)) {
    const cut = line.replace(/#.*$/, '').trim()
    if (!cut) continue
    for (const word of cut.split(/[\s,;]+/).filter(Boolean)) {
      const entry = parseIgnoreEntry(word)
      if (entry) entries.push(entry); else bad++
    }
  }
  return { entries, bad }
}

/**
 * The addresses this host itself holds, as entries, and why there are none when there are none.
 *
 * Reading them needs a netlink socket (getifaddrs), which a sandboxed unit does not have unless its
 * RestrictAddressFamilies= names AF_NETLINK: stp-web.service does, for this. Observed 13.11 on the live host, where it
 * did not yet: the call threw, this returned nothing, and the server's own visits were counted while the code looked
 * right. So the reason is returned and said out loud rather than swallowed.
 */
export function selfEntries (interfaces = os.networkInterfaces) {
  const out = []
  let list = null
  try { list = interfaces() } catch (e) { return { entries: out, unreadable: String(e && (e.code || e.message) || e).slice(0, 80) } }
  for (const addresses of Object.values(list || {})) {
    for (const a of addresses || []) {
      const entry = parseIgnoreEntry(a && a.address)
      if (entry) out.push(entry)
    }
  }
  return { entries: out, unreadable: null }
}

/** Is this address covered by one of the entries? An address we cannot parse is not ignored. */
export function ignoredAddress (entries, ip) {
  const bytes = ipBytes(ip)
  if (!bytes) return false
  return entries.some((e) => e.bytes.length === bytes.length && samePrefix(e.bytes, bytes, e.bits))
}

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

export function createAnalytics ({ dir = process.env.STP_ANALYTICS_DIR || null, now = () => Date.now(), log = (m) => console.log(m), enabled = true, ignore = process.env.STP_ANALYTICS_IGNORE || '', interfaces = os.networkInterfaces } = {}) {
  let off = !enabled || !dir
  // Decided once, at startup: our own traffic, plus whatever the host was told to skip. An empty or missing setting
  // ignores nothing beyond ourselves, which is what the counter did before this existed.
  const configured = parseIgnore(ignore)
  const self = selfEntries(interfaces)
  const ignoreList = [...DEFAULT_IGNORE.map(parseIgnoreEntry), ...self.entries, ...configured.entries]
  // Never silent: a host whose own addresses cannot be read still counts its own visits, and only this line says so.
  if (self.unreadable) log(`[analytics] cannot read this host's own addresses (${self.unreadable}); only loopback and the configured list are ignored. The unit needs AF_NETLINK in RestrictAddressFamilies=`)
  if (configured.entries.length || configured.bad) {
    const n = configured.entries.length, bad = configured.bad
    // The count only: a mistyped entry is still somebody's address, and the journal is not the place for it.
    log(`[analytics] not counting ${n} configured ${n === 1 ? 'address or range' : 'addresses or ranges'}` +
      (bad ? `; ${bad} ${bad === 1 ? 'entry was not an address and was' : 'entries were not addresses and were'} skipped` : ''))
  }
  /** A requester that leaves no row at all: us, or an address the host skips. Asked before anything is computed. */
  const ignored = (ip, ua) => IGNORE_UA.test(String(ua || '')) || ignoredAddress(ignoreList, ip)
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
    load (ip, headers, page) { if (off || ignored(ip, headers['user-agent'])) return; const b = base(ip, headers); if (underCap(b.visitor, 0)) write({ kind: 'load', ...b, page }) },
    /** A beacon from the page; hit is parseHit()'s result. */
    hit (ip, headers, hit) { if (off || ignored(ip, headers['user-agent'])) return; const b = base(ip, headers); if (underCap(b.visitor, 1)) write({ kind: hit.event, ...b, ...hit }) },
    /**
     * An MCP request the server accepted: one row, after the answer. Only names the server itself defines are stored
     * (the method, the tool); anything else is "other". The client's own name is kept only as a short plain word.
     * Never the arguments.
     */
    mcp (ip, headers, raw, toolNames = []) {
      if (off || ignored(ip, headers['user-agent'])) return
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
    /** Whether this requester leaves no row. Exported for the tests and for a check on the host. */
    ignored,
  }
}
