#!/usr/bin/env node
// scripts/stocks/tg-bot.mjs: the Proof of Stock Telegram bot (owner, 23.11: "a bot, not just Telegram"). No LLM.
//
// Two jobs, one process:
//   1. Answer. A person sends a contract address or a ticker (or /check <it>); the bot answers with the verdict in fixed
//      words: ISSUER-LISTED, LOOK-ALIKE, NOT ON THE ISSUER'S LIST, UNAVAILABLE, plus, for a listed token, how far its
//      on-chain price is from the issuer's and how old that reading is, and a link to the passport.
//   2. Alert. Every ALERT_EVERY_MS it reads the newly opened look-alike cases on Base and posts each once to the alert
//      chat (a channel the bot is an admin of), if one is configured.
//
// It reads our own API on the loopback (STP_BOT_API, default http://127.0.0.1:3005/stocks), so it shares one client's
// free minute; on top of that each chat gets CHAT_PER_MIN checks a minute.
//
// ⚠ NO CREATOR TEXT, EVER. A token outside the issuer's list carries a symbol and a name its creator chose. The bot never
//   repeats them, and never parses the API's free text into a message: every word it sends is ours or the issuer's list
//   (the symbol it imitates, the issuer's own address). Messages go out with no parse_mode, so nothing in them is markup.
// ⚠ THE TOKEN IS A SECRET. It is read from a file ($CREDENTIALS_DIRECTORY/tg-bot, systemd LoadCredential, or
//   STP_TG_BOT_FILE), KEY=VALUE with TG_BOT_TOKEN; never an argument, never logged, never in git.
//
// Run on the host as the stp-tg-bot unit (deployment/systemd/stp-tg-bot.service). `node tg-bot.mjs --once` answers the
// pending updates and runs one alert pass, then exits.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SITE = 'https://proofofstock.xyz'
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const TICKER_RE = /^[A-Za-z0-9.\- ]{1,40}$/
const SYMBOL_RE = /^[A-Za-z0-9.]{1,16}$/
export const CHAT_PER_MIN = 6
export const ALERT_EVERY_MS = 15 * 60e3
const ISSUER = { coinbase: 'Coinbase', robinhood: 'Robinhood' }
const CHAIN_ISSUER = { base: 'Coinbase', robinhood: 'Robinhood' }
const short = (a) => (ADDRESS_RE.test(String(a)) ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?')
const sym = (s) => (SYMBOL_RE.test(String(s ?? '')) ? String(s) : null)
const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%` : null)
const ago = (s) => (!Number.isFinite(s) ? null : s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`)
const passportUrl = (chain, address) => `${SITE}/?chain=${chain}&address=${address.toLowerCase()}`

export const HELP = [
  'Proof of Stock checks a tokenized stock against the issuer\'s own list (Coinbase on Base, Robinhood on Robinhood Chain).',
  '',
  'Send a contract address (0x…) to check it, or a ticker or company name (NVDA, Tesla) to get the issuer\'s own contract.',
  'Registry data, not advice: listed says whose contract it is, not that its price is fair.',
  `${SITE}`,
].join('\n')

/** Read the bot token from its credential file. Returns null when there is none. */
export function loadToken (env = process.env) {
  const f = env.STP_TG_BOT_FILE || (env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, 'tg-bot') : null)
  if (!f || !fs.existsSync(f)) return null
  const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('TG_BOT_TOKEN='))
  const t = line ? line.slice('TG_BOT_TOKEN='.length).trim() : ''
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(t)) throw new Error('the bot token file does not hold a Telegram bot token')
  return t
}

/** One chain's /verify answer as fixed words (the issuer's symbol and address only). */
function verdictLine (chain, b) {
  const who = CHAIN_ISSUER[chain]
  if (!b || typeof b.listed !== 'boolean') return { state: 'unavailable', text: `${chain}: UNAVAILABLE, the check could not be made just now. Do not treat it as listed.` }
  if (b.delisted_at) return { state: 'delisted', text: `${chain}: DELISTED. ${who} removed this contract from its list. It is no longer the issuer's token.` }
  if (b.listed) return { state: 'listed', text: `${chain}: ISSUER-LISTED. ${who} lists this exact contract${sym(b.symbol) ? ` as ${sym(b.symbol)}` : ''}.` }
  const imp = b.impostor
  if (imp && Array.isArray(imp.kinds)) {
    const target = sym(imp.imitates_symbol)
    return { state: 'impostor', text: `${chain}: LOOK-ALIKE. Not on ${who}'s list, and it imitates ${target || 'the issuer\'s naming'}.${ADDRESS_RE.test(imp.listed_address || '') ? `\nThe issuer's own contract: ${imp.listed_address.toLowerCase()}` : ''}` }
  }
  const alike = b.issuer_like_address ? ` Its address starts like ${who}'s, which proves nothing.` : ''
  return { state: 'not_listed', text: `${chain}: NOT ON ${who.toUpperCase()}'S LIST. It is not ${who}'s stock token here.${alike}` }
}

/**
 * The reply to one message. `api(path)` returns the parsed JSON of our own API or throws. Never throws itself.
 * @returns {Promise<string>}
 */
export async function replyFor (text, { api }) {
  let q = String(text || '').trim()
  if (/^\/(start|help)\b/i.test(q)) return HELP
  q = q.replace(/^\/check(@\w+)?\s*/i, '').trim()
  if (!q) return 'Send a contract address (0x…) or a ticker, e.g. /check NVDA.'
  if (ADDRESS_RE.test(q)) {
    const address = q.toLowerCase()
    const lines = [], states = []
    // Base first, as the landing (Robinhood Chain is hidden there); Robinhood only when the address is listed there.
    const chains = ['base']
    for (let i = 0; i < chains.length; i++) {
      const chain = chains[i]
      let b = null
      try { b = await api(`/verify?chain=${chain}&address=${address}`) } catch (_) { /* unavailable */ }
      const v = verdictLine(chain, b)
      states.push(v.state); lines.push(v.text)
      if (b && b.listed_on_other_chain && b.listed_on_other_chain.chain === 'robinhood' && !chains.includes('robinhood')) chains.push('robinhood')
    }
    const listedOn = chains[states.indexOf('listed')]
    if (listedOn) {
      try {
        const p = await api(`/api/passport?chain=${listedOn}&address=${address}`)
        const l = p && p.latest
        const gap = l ? pct(l.premium) : null
        if (gap) lines.push(`On-chain vs issuer price: ${gap} (read ${ago(l.age_s) || 'recently'}).`)
      } catch (_) { /* the verdict stands without the price */ }
    }
    const head = states.includes('listed') ? 'ISSUER-LISTED' : states.includes('impostor') ? 'LOOK-ALIKE' : states.includes('delisted') ? 'DELISTED' : states.every((s) => s === 'unavailable') ? 'UNAVAILABLE' : 'NOT ON THE ISSUER\'S LIST'
    return [`Proof of Stock: ${head}`, address, '', ...lines, '', `Passport: ${passportUrl(listedOn || 'base', address)}`, 'Registry data, not advice.'].join('\n')
  }
  if (!TICKER_RE.test(q)) return 'Send a contract address (0x followed by 40 hex characters) or a ticker.'
  let r
  try { r = await api(`/api/find?q=${encodeURIComponent(q)}`) } catch (_) { return 'Proof of Stock: UNAVAILABLE, the issuer lists could not be searched just now.' }
  // The query is never echoed: it came from the chat.
  const all = (r && Array.isArray(r.matches) ? r.matches : []).filter((x) => x && ADDRESS_RE.test(x.address || '') && CHAIN_ISSUER[x.chain])
  // Base first, as the landing; Robinhood's only when Base has none.
  const m = (all.some((x) => x.chain === 'base') ? all.filter((x) => x.chain === 'base') : all).slice(0, 6)
  if (!m.length) return 'No issuer-listed token matches that. A token by that name elsewhere is not the issuer\'s.'
  return [`Issuer-listed contracts${r.match === 'exact' ? '' : ' (closest matches)'}:`,
    ...m.map((x) => `${sym(x.symbol) || '?'} on ${x.chain} (${ISSUER[x.issuer] || CHAIN_ISSUER[x.chain]}): ${x.address.toLowerCase()}`),
    '', 'Only these exact addresses are the issuer\'s. Send one to check it.'].join('\n')
}

/**
 * The alert posts for newly opened look-alike cases, oldest first, each once. `seen` is the set of keys already posted;
 * on the first pass (`seen` empty and `prime`) everything is marked seen and nothing is posted, so a restart never
 * floods the channel. Only issuer-side words: the symbol imitated and the issuer's own address.
 */
export function alertsFrom (events, seen, { prime = false } = {}) {
  const out = []
  for (const e of (Array.isArray(events) ? events : []).filter((x) => x && x.event === 'opened' && ADDRESS_RE.test(x.address || '')).sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const key = `${e.address.toLowerCase()}@${e.at}`
    if (seen.has(key)) continue
    seen.add(key)
    if (prime || e.source === 'backfilled') continue
    const target = sym(e.imitates_symbol)
    out.push([`New look-alike on Base${target ? `: imitates ${target}` : ''}`, e.address.toLowerCase(), 'Not on Coinbase\'s list.',
      ...(ADDRESS_RE.test(e.listed_address || '') ? [`Coinbase's own${target ? ` ${target}` : ''}: ${e.listed_address.toLowerCase()}`] : []),
      `Passport: ${passportUrl('base', e.address)}`].join('\n'))
  }
  return out
}

/** Per-chat pacing: at most `perMin` checks in any 60 s. */
export function pacer (perMin = CHAT_PER_MIN, now = () => Date.now()) {
  const seen = new Map()
  return (chat) => {
    const t = now(), xs = (seen.get(chat) || []).filter((x) => t - x < 60e3)
    if (xs.length >= perMin) { seen.set(chat, xs); return false }
    xs.push(t); seen.set(chat, xs)
    if (seen.size > 5000) for (const [k, v] of seen) if (!v.some((x) => t - x < 60e3)) seen.delete(k)
    return true
  }
}

/** The bot: a Telegram long-polling loop and the alert pass, with injectable fetch and clock for the tests. */
export function createBot ({ token, apiBase = 'http://127.0.0.1:3005/stocks', alertChat = null, fetchImpl = fetch, now = () => Date.now(), log = (m) => console.log(m), stateFile = null }) {
  const tg = async (method, body) => {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'getUpdates' ? 40_000 : 15_000) })
    const j = await r.json().catch(() => null)
    if (!j || j.ok !== true) throw new Error(`${method}: ${j && j.description ? String(j.description).slice(0, 120) : r.status}`)
    return j.result
  }
  const api = async (p) => {
    const r = await fetchImpl(apiBase + p, { headers: { accept: 'application/json', 'user-agent': 'proofofstock-tg-bot/1' }, signal: AbortSignal.timeout(15_000) })
    if (r.status === 429) throw new Error('busy')
    return r.json()
  }
  const allow = pacer(CHAT_PER_MIN, now)
  let offset = 0
  const seen = new Set()
  let primed = false
  if (stateFile) { try { for (const k of JSON.parse(fs.readFileSync(stateFile, 'utf8')).seen || []) seen.add(k); primed = seen.size > 0 } catch (_) { /* first run */ } }
  const save = () => { if (stateFile) { try { fs.writeFileSync(stateFile, JSON.stringify({ seen: [...seen].slice(-2000) })) } catch (e) { log(`[tg-bot] state not saved: ${e.message}`) } } }

  async function answerOnce (timeoutS = 30) {
    const updates = await tg('getUpdates', { offset, timeout: timeoutS, allowed_updates: ['message'] })
    for (const u of updates || []) {
      offset = Math.max(offset, u.update_id + 1)
      const m = u.message
      if (!m || !m.chat || typeof m.text !== 'string') continue
      const text = allow(m.chat.id) ? await replyFor(m.text, { api }) : 'Too many checks from this chat; try again in a minute.'
      try { await tg('sendMessage', { chat_id: m.chat.id, text, disable_web_page_preview: true }) } catch (e) { log(`[tg-bot] send failed: ${e.message}`) }
    }
    return (updates || []).length
  }

  async function alertOnce () {
    if (!alertChat) return 0
    let c
    try { c = await api('/api/history/cases?chain=base&event=opened&limit=50') } catch (e) { log(`[tg-bot] cases unavailable: ${e.message}`); return 0 }
    const posts = alertsFrom(c && c.events, seen, { prime: !primed })
    primed = true
    for (const text of posts) { try { await tg('sendMessage', { chat_id: alertChat, text, disable_web_page_preview: true }) } catch (e) { log(`[tg-bot] alert failed: ${e.message}`) } }
    save()
    return posts.length
  }

  return { answerOnce, alertOnce, replyFor: (t) => replyFor(t, { api }) }
}

async function main () {
  const token = loadToken()
  if (!token) { console.log('[tg-bot] no token file; nothing to do'); return }
  const bot = createBot({ token, apiBase: process.env.STP_BOT_API || 'http://127.0.0.1:3005/stocks', alertChat: process.env.STP_TG_ALERT_CHAT || null, stateFile: process.env.STP_TG_STATE || null })
  if (process.argv.includes('--once')) { await bot.answerOnce(0); await bot.alertOnce(); return }
  let nextAlert = 0
  for (;;) {
    try { await bot.answerOnce(25) } catch (e) { console.log(`[tg-bot] poll failed: ${String(e.message).slice(0, 120)}`); await new Promise((r) => setTimeout(r, 5000)) }
    if (Date.now() >= nextAlert) { await bot.alertOnce(); nextAlert = Date.now() + ALERT_EVERY_MS }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.log(`[tg-bot] stopped: ${String(e && e.message || e).slice(0, 160)}`); process.exitCode = 1 })
