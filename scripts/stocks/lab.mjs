// scripts/stocks/lab.mjs: the three files behind /lab (owner, 25.11), a page behind a password that nothing on the site
// links to. Built here, on the host, from what the impostor list already holds, so the page reads three small files and
// makes no outbound call of its own.
//
//   board.json   "the fake exchange": per issuer stock, how many listed look-alikes it has and how much real money sits
//                in their pools now. Aggregates and the one richest fake per stock, no more.
//   golden.json  "the golden impostor of the week": per ISO week (UTC), the single fake with the most real money in its
//                pools seen in any run that week. A run never lowers a week's winner; a new week starts empty.
//   crash.json   the crash test (packages/proofofstock-guard/examples/crash-test.mjs) on Circle and the Base stocks with
//                the most look-alikes: which contract each agent resolver would pick.
//
// ⚠ ONLY THE STRONG CLAIMS. The board reads impostors.json, which lists only tokens that copy the issuer's exact symbol
// or its naming convention (scripts/stocks/impostor-list.mjs). A memecoin that borrows a ticker is not on it.
// ⚠ A FAKE'S ADDRESS IS A WARNING. It is kept so the page can say "this one, not that one", always beside the issuer's
// original. Nothing written here is a link to trade it, and the deployer (in impostors.json) is never copied.
// ⚠ NAMES ARE SOMEBODY ELSE'S TEXT: every symbol from a fake goes through symbolLabel (nothing invisible, one line) and
// cleanLabel (no link, no domain, short) before it is written.
// ⚠ REAL MONEY IS ONLY THE OTHER SIDE, AND ONLY A REFERENCE ASSET. DexScreener's liquidity.usd counts both sides of a
// pool, and a fake's own side is priced by the fake itself: a pool holding a billion fake tokens against a few dollars
// of WETH reads as hundreds of thousands (seen on the first run, 25.11). So a pool counts only its WETH or stablecoin
// side (each chain's descriptor: wrappedNative, stableAssets), valued at the pair's own price; a pool against anything
// else counts zero. DexScreener's figure is kept beside it as `reported_usd`, never shown as money gathered.
//
// Usage: node scripts/stocks/lab.mjs [--out=/var/lib/pos/lab] [--no-crash]
//   reads <root>/stock-peg/impostors.json per chain (scripts/stocks/data-roots.mjs), writes the three files to --out
//   (env POS_LAB_DIR), each to a temporary file and renamed.

import fs from 'node:fs'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { dataRoot } from './data-roots.mjs'
import { symbolLabel } from '../../evm/core/stocks/untrusted-text.mjs'
import { cleanLabel } from '../../packages/proofofstock-guard/examples/agent-search.mjs'
import { BASE_DESCRIPTOR } from '../../evm/chains/base/descriptor.mjs'
import { ROBINHOOD_DESCRIPTOR } from '../../evm/chains/robinhood/descriptor.mjs'

export const LAB_DIR = '/var/lib/pos/lab'
export const CHAIN_SLUGS = Object.freeze({ base: 'base', robinhood: 'robinhood' })
/** The assets whose side of a pool is real money: each chain's wrapped native token and its stablecoins. */
const referenceOf = (d) => new Set([...(d.stableAssets || []), d.wrappedNative].filter(Boolean).map((a) => String(a).toLowerCase()))
export const REFERENCE = Object.freeze({ base: referenceOf(BASE_DESCRIPTOR), robinhood: referenceOf(ROBINHOOD_DESCRIPTOR) })
/** A fake with less real money than this in its pools is counted but not called "live". */
export const LIVE_MIN_USD = 100
/** DexScreener's tokens endpoint takes at most this many addresses per call. */
export const DEX_BATCH = 30
export const MAX_WEEKS = 104
export const CRASH_MAX = 4
const ADDRESS = /^0x[0-9a-f]{40}$/
const label = (v) => cleanLabel(symbolLabel(String(v ?? '')) || '', 24) || '?'

/** The ISO week (UTC) a moment falls in, as "2026-W48". */
export function isoWeek (ms) {
  const d = new Date(ms)
  const day = (d.getUTCDay() + 6) % 7 // Monday 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3)
  const year = new Date(thursday).getUTCFullYear()
  // Week 1 is the week of the year's first Thursday; counted from that Thursday.
  const jan4 = Date.UTC(year, 0, 4)
  const firstThursday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 864e5 + 3 * 864e5
  const week = 1 + Math.round((thursday - firstThursday) / 604800e3)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * The real money in one pool for one of its tokens: the other side, when it is a reference asset, in USD at the pair's own
 * price (priceUsd is the base token's; priceUsd / priceNative is the quote token's). Zero when the other side is anything
 * else, or a number is missing.
 */
export function realSideUsd (pair, token, reference) {
  const base = String(pair && pair.baseToken && pair.baseToken.address || '').toLowerCase()
  const quote = String(pair && pair.quoteToken && pair.quoteToken.address || '').toLowerCase()
  const l = pair && pair.liquidity || {}
  const priceUsd = Number(pair && pair.priceUsd), priceNative = Number(pair && pair.priceNative)
  let v = 0
  if (token === base && reference.has(quote)) v = Number(l.quote) * priceUsd / priceNative
  else if (token === quote && reference.has(base)) v = Number(l.base) * priceUsd
  return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * Pool money per address, from DexScreener's tokens endpoint, DEX_BATCH at a time.
 * @returns {Promise<{ liq: Map<string, { usd: number, reported: number, pools: number }>, unread: number }>} usd: the
 *          real money (realSideUsd); reported: DexScreener's liquidity.usd, both sides. unread: addresses in a batch that
 *          could not be read (they count as unknown, never as zero, on the board)
 */
export async function readLiquidity (slug, addresses, { fetchImpl = globalThis.fetch, pauseMs = 250, reference = new Set() } = {}) {
  const liq = new Map()
  let unread = 0
  const list = [...new Set(addresses.map((a) => String(a).toLowerCase()).filter((a) => ADDRESS.test(a)))]
  for (let i = 0; i < list.length; i += DEX_BATCH) {
    const batch = list.slice(i, i + DEX_BATCH)
    let pairs = null
    try {
      const r = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${slug}/${batch.join(',')}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      if (r.status === 200) { const b = await r.json(); if (Array.isArray(b)) pairs = b }
    } catch (_) { pairs = null }
    if (!pairs) { unread += batch.length; continue }
    for (const a of batch) liq.set(a, { usd: 0, reported: 0, pools: 0 })
    const seen = new Set()
    for (const p of pairs) {
      const id = String(p && p.pairAddress || '')
      const reported = Number(p && p.liquidity && p.liquidity.usd) || 0
      for (const t of [p && p.baseToken, p && p.quoteToken]) {
        const a = String(t && t.address || '').toLowerCase()
        const e = liq.get(a)
        if (!e || seen.has(a + id)) continue
        seen.add(a + id)
        e.usd += realSideUsd(p, a, reference); e.reported += reported; e.pools++
      }
    }
    if (pauseMs && i + DEX_BATCH < list.length) await new Promise((r) => setTimeout(r, pauseMs))
  }
  return { liq, unread }
}

/**
 * The board of one chain: one row per issuer stock that has at least one listed look-alike.
 * @param {object} impostors  the parsed impostors.json of that chain
 * @param {Map} liq           readLiquidity's map (an address missing from it is unread, not empty)
 */
export function boardOf (chain, impostors, liq) {
  const rows = new Map()
  for (const it of Array.isArray(impostors && impostors.items) ? impostors.items : []) {
    const original = String(it.registry_address || '').toLowerCase()
    const address = String(it.address || '').toLowerCase()
    if (!ADDRESS.test(original) || !ADDRESS.test(address)) continue
    let row = rows.get(original)
    if (!row) { row = { chain, symbol: label(it.registry_symbol || it.ticker), original, fakes: 0, live: 0, liquidity_usd: 0, reported_usd: 0, unread: 0, richest: null, newest_at: null }; rows.set(original, row) }
    row.fakes++
    if (it.first_seen_at && (!row.newest_at || it.first_seen_at > row.newest_at)) row.newest_at = it.first_seen_at
    const l = liq.get(address)
    if (!l) { row.unread++; continue }
    row.liquidity_usd += l.usd
    row.reported_usd += l.reported || 0
    if (l.usd >= LIVE_MIN_USD) row.live++
    if (l.usd > 0 && (!row.richest || l.usd > row.richest.liquidity_usd)) row.richest = { address, symbol: label(it.symbol), liquidity_usd: round(l.usd), pools: l.pools, kind: it.kind, first_seen_at: it.first_seen_at || null }
  }
  const out = [...rows.values()].map((r) => ({ ...r, liquidity_usd: round(r.liquidity_usd), reported_usd: round(r.reported_usd) }))
  out.sort((a, b) => b.liquidity_usd - a.liquidity_usd || b.fakes - a.fakes || a.symbol.localeCompare(b.symbol))
  const totals = out.reduce((t, r) => ({ stocks: t.stocks + 1, fakes: t.fakes + r.fakes, live: t.live + r.live, liquidity_usd: round(t.liquidity_usd + r.liquidity_usd), reported_usd: round(t.reported_usd + r.reported_usd), unread: t.unread + r.unread }), { stocks: 0, fakes: 0, live: 0, liquidity_usd: 0, reported_usd: 0, unread: 0 })
  return { chain, impostors_generated_at: impostors && impostors.generated_at || null, totals, rows: out }
}

const round = (n) => Math.round(n * 100) / 100

/** This week's golden impostor: the richest fake on any chain, kept if it beats the week's standing winner. */
export function updateGolden (prev, boards, now) {
  const weeks = { ...(prev && prev.weeks && typeof prev.weeks === 'object' ? prev.weeks : {}) }
  const week = isoWeek(now)
  let best = null
  for (const b of boards) for (const r of b.rows) {
    if (!r.richest || r.richest.liquidity_usd < LIVE_MIN_USD) continue
    if (!best || r.richest.liquidity_usd > best.liquidity_usd) best = { week, chain: b.chain, copied: r.symbol, original: r.original, address: r.richest.address, symbol: r.richest.symbol, liquidity_usd: r.richest.liquidity_usd, seen_at: new Date(now).toISOString() }
  }
  if (best && (!weeks[week] || best.liquidity_usd > weeks[week].liquidity_usd)) weeks[week] = best
  const keep = Object.keys(weeks).sort().slice(-MAX_WEEKS)
  return { updated_at: new Date(now).toISOString(), rule: `the fake with the most real money (the WETH or stablecoin side of its pools) seen in any run of the ISO week (UTC), at least $${LIVE_MIN_USD}`, weeks: Object.fromEntries(keep.map((k) => [k, weeks[k]])) }
}

/** The tickers the crash test runs on: Circle first, then the Base stocks with the most look-alikes. */
export function crashTickers (baseBoard, max = CRASH_MAX) {
  const out = ['CRCL']
  for (const r of [...(baseBoard ? baseBoard.rows : [])].sort((a, b) => b.fakes - a.fakes)) {
    const t = String(r.symbol).replace(/c$/, '').toUpperCase()
    if (/^[A-Z][A-Z0-9.]{0,9}$/.test(t) && !out.includes(t)) out.push(t)
    if (out.length >= max) break
  }
  return out
}

/** A fetch that downloads each URL once per run: the two big token lists are asked for every ticker and phrasing. */
export function onceFetch (fetchImpl) {
  const memo = new Map()
  return (url, init) => {
    if (init && init.method && init.method !== 'GET') return fetchImpl(url, init)
    if (!memo.has(url)) memo.set(url, (async () => { const r = await fetchImpl(url, init); return { status: r.status, text: r.status === 200 ? await r.text() : '' } })().catch(() => null))
    return memo.get(url).then((c) => { if (!c) throw new Error('unreadable'); return { status: c.status, ok: c.status === 200, json: async () => JSON.parse(c.text), text: async () => c.text } })
  }
}

function writeAtomic (file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n')
  fs.renameSync(tmp, file)
}

export async function runLab ({ out, roots, fetchImpl = globalThis.fetch, now = () => Date.now(), crash = true, crashTest = null, pauseMs = 250 }) {
  const boards = []
  for (const chain of Object.keys(CHAIN_SLUGS)) {
    let imp = null
    try { imp = JSON.parse(fs.readFileSync(path.join(roots[chain], 'stock-peg', 'impostors.json'), 'utf8')) } catch (_) { imp = null }
    if (!imp || !Array.isArray(imp.items)) { boards.push({ chain, error: 'impostor list not readable', totals: null, rows: [] }); continue }
    const { liq, unread } = await readLiquidity(CHAIN_SLUGS[chain], imp.items.map((i) => i.address), { fetchImpl, pauseMs, reference: REFERENCE[chain] })
    boards.push({ ...boardOf(chain, imp, liq), liquidity_unread: unread })
  }
  const at = now()
  writeAtomic(path.join(out, 'board.json'), { generated_at: new Date(at).toISOString(), source: 'impostors.json (strong claims only) + DexScreener pools: the WETH or stablecoin side only', live_min_usd: LIVE_MIN_USD, chains: boards })
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(path.join(out, 'golden.json'), 'utf8')) } catch (_) { prev = null }
  writeAtomic(path.join(out, 'golden.json'), updateGolden(prev, boards.filter((b) => !b.error), at))
  if (crash) {
    const run = crashTest || (await import('../../packages/proofofstock-guard/examples/crash-test.mjs')).crashTest
    const f = onceFetch(fetchImpl)
    const stocks = []
    for (const t of crashTickers(boards.find((b) => b.chain === 'base' && !b.error))) stocks.push({ ticker: t, ...(await run({ ticker: t, fetchImpl: f })) })
    writeAtomic(path.join(out, 'crash.json'), { generated_at: new Date(now()).toISOString(), method: 'node packages/proofofstock-guard/examples/crash-test.mjs <TICKER>', stocks })
  }
  return { boards }
}

if (isEntryPoint(import.meta.url)) {
  const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
  const out = arg('out') || process.env.POS_LAB_DIR || LAB_DIR
  const roots = Object.fromEntries(Object.keys(CHAIN_SLUGS).map((c) => [c, dataRoot(c)]))
  const { boards } = await runLab({ out, roots, crash: !process.argv.includes('--no-crash') })
  // Counts only, for the journal: the board itself is read on the page.
  for (const b of boards) console.log(`[lab] ${b.chain}: ${b.error || `${b.totals.stocks} stocks, ${b.totals.fakes} fakes, ${b.liquidity_unread} unread`}`)
  process.exit(boards.every((b) => b.error) ? 1 : 0)
}
