// apps/stocks-analytics.mjs — our own visit counter (docs/legal.md "What we count"). No cookies, no third party, no
// stored address. Three kinds of row, appended per UTC day to <dir>/hits-YYYY-MM-DD.jsonl:
//   load  the server sent a page (/, a docs page, /history, /status), with the requester's class: browser, bot or tool
//   view / hide   apps/stocks-web/beacon.js: a page was shown, or hidden after N visible seconds
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

export const uaClass = (ua) => !ua ? 'tool' : BOT_UA.test(ua) ? 'bot' : /mozilla\//i.test(ua) ? 'browser' : 'tool'

/** Parses and checks a beacon query; null when it is not one we take. */
export function parseHit (sp, chains) {
  const event = sp.get('k')
  if (event !== 'view' && event !== 'hide') return null
  const page = String(sp.get('p') || '')
  if (!PAGE.test(page)) return null
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
  const day = () => new Date(now()).toISOString().slice(0, 10)
  function visitor (ip, ua) {
    const d = day()
    if (d !== saltDay) { salt = crypto.randomBytes(32); saltDay = d }
    return crypto.createHash('sha256').update(salt).update(String(ip)).update('\n').update(String(ua || '')).digest('hex').slice(0, 16)
  }
  function write (row) {
    if (off) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, `hits-${day()}.jsonl`), JSON.stringify(row) + '\n')
    } catch (e) { off = true; log(`[analytics] disabled: ${String(e && e.message || e).slice(0, 160)}`) }
  }
  const base = (ip, headers) => {
    const ua = String(headers['user-agent'] || '').slice(0, 300)
    const cc = String(headers['cf-ipcountry'] || '').toUpperCase()
    return { at: new Date(now()).toISOString(), visitor: visitor(ip, ua), ua_class: uaClass(ua), country: /^[A-Z]{2}$/.test(cc) && cc !== 'XX' ? cc : null }
  }
  return {
    /** The server sent a page. */
    load (ip, headers, page) { write({ kind: 'load', ...base(ip, headers), page }) },
    /** A beacon from the page; hit is parseHit()'s result. */
    hit (ip, headers, hit) { write({ kind: hit.event, ...base(ip, headers), ...hit }) },
    /** An MCP message: its method, and the tool for tools/call. Never the arguments. */
    mcp (ip, headers, raw) {
      let m = null
      try { m = JSON.parse(raw) } catch { return }
      for (const x of Array.isArray(m) ? m.slice(0, 50) : [m]) {
        if (!x || typeof x.method !== 'string') continue
        const tool = x.method === 'tools/call' && typeof x.params?.name === 'string' ? x.params.name.slice(0, 60) : null
        const client = x.method === 'initialize' && typeof x.params?.clientInfo?.name === 'string' ? x.params.clientInfo.name.slice(0, 60) : null
        write({ kind: 'mcp', ...base(ip, headers), method: x.method.slice(0, 40), tool, client })
      }
    },
    get disabled () { return off },
  }
}
