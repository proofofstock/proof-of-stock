#!/usr/bin/env node
// scripts/stocks/gap-stats.mjs: how far the chain trades from the issuer's price, over our whole recorded history.
//
// One number per question, computed from the readings the recorder has written, and nothing else printed: this is an
// aggregate, never a dump of rows (the data rules above this repository). A reading is one token at one minute with
// a premium; a premium exists only where there was a deep enough pool and the sources agreed, so "readings" here is
// always smaller than "rows".
//
// IT PRINTS NUMBERS. They belong in the operator's local report directory, never in git, a commit message or a PR.
//
// Run (on the host, where the data is):
//   node scripts/stocks/gap-stats.mjs                      both chains, everything recorded
//   node scripts/stocks/gap-stats.mjs --days 30            the last 30 days
//   node scripts/stocks/gap-stats.mjs --chain base --json  one chain, as JSON for another script to read
//
// The shape of the answer follows the questions a reader actually asks of a market report: what is the typical gap,
// how often is it large, and is that the same when the US market is open and when it is shut.
import fs from 'node:fs'
import path from 'node:path'
import { usEquitySession } from '../../evm/core/stocks/market-session.mjs'
import { MAX_PLAUSIBLE_RATIO } from '../../evm/core/stocks/peg.mjs'

export const SESSION_GROUP = { regular: 'open', pre: 'extended', post: 'extended', closed: 'closed', unknown: 'closed' }
const DEFAULT_ROOTS = { base: '/var/lib/pos/base', robinhood: '/var/lib/pos/robinhood' }

export function parseArgs (argv) {
  const out = { chains: null, days: null, json: false, roots: { ...DEFAULT_ROOTS } }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--chain') { out.chains = [String(argv[++i] || '')]; continue }
    if (a === '--days') { out.days = Number(argv[++i]); continue }
    if (a === '--json') { out.json = true; continue }
    if (a === '--root-base') { out.roots.base = String(argv[++i] || ''); continue }
    if (a === '--root-robinhood') { out.roots.robinhood = String(argv[++i] || ''); continue }
    throw new Error(`unknown argument ${a}`)
  }
  if (out.chains && !out.chains.every((c) => DEFAULT_ROOTS[c])) throw new Error('--chain takes base or robinhood')
  if (out.days != null && (!Number.isInteger(out.days) || out.days < 1 || out.days > 3650)) throw new Error('--days takes 1 to 3650')
  return out
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/**
 * The aggregate itself. Takes readings one at a time so a day file is read, counted and dropped: nothing larger than
 * one day's rows is ever held, and no row leaves this function.
 */
export function collector () {
  const abs = []
  const bySession = { open: [], extended: [], closed: [] }
  const byToken = new Map() // address -> { open: {n, over1}, all: n }
  let rows = 0, withPremium = 0, implausible = 0, days = new Set()
  return {
    add (row) {
      rows++
      if (row && typeof row.observed_at === 'string') days.add(row.observed_at.slice(0, 10))
      const p = row && typeof row.premium === 'number' && Number.isFinite(row.premium) ? row.premium : null
      if (p == null) return
      // Readings taken before the recorder learned to refuse a pool that cannot be this token (16.11) carry those
      // premiums forever: we never rewrite what was recorded. They are counted and left out of every statistic here,
      // because one pool priced at 78 times the issuer's price moves a 99th percentile on its own. Counted, not
      // hidden: a history whose number of these does not fall after the rule went live is a history saying the rule
      // did not work.
      if (1 + p > MAX_PLAUSIBLE_RATIO || 1 + p < 1 / MAX_PLAUSIBLE_RATIO) { implausible++; return }
      withPremium++
      const a = Math.abs(p)
      abs.push(a)
      const g = SESSION_GROUP[usEquitySession(Date.parse(row.observed_at)).session] || 'closed'
      bySession[g].push(a)
      const key = String(row.address || row.symbol || '?')
      const t = byToken.get(key) || { all: 0, open: 0, openOver1: 0 }
      t.all++
      if (g === 'open') { t.open++; if (a > 0.01) t.openOver1++ }
      byToken.set(key, t)
    },
    done () {
      const sort = (xs) => xs.slice().sort((x, y) => x - y)
      const sorted = sort(abs)
      const share = (xs, over) => (xs.length ? xs.filter((x) => x > over).length / xs.length : null)
      const sessionStats = Object.fromEntries(Object.entries(bySession).map(([g, xs]) => {
        const s = sort(xs)
        return [g, { readings: s.length, median: quantile(s, 0.5), p90: quantile(s, 0.9), over1: share(s, 0.01) }]
      }))
      // Their measure, in our words: for each token, in how many of the readings taken while the US market was open
      // was it more than 1% away. Tokens with too few open-market readings to mean anything are left out of it.
      const perToken = [...byToken.values()].filter((t) => t.open >= 20).map((t) => t.openOver1 / t.open).sort((x, y) => x - y)
      return {
        days: days.size,
        rows,
        readings: withPremium,
        implausible,
        tokens: byToken.size,
        tokens_counted_open: perToken.length,
        median: quantile(sorted, 0.5),
        p90: quantile(sorted, 0.9),
        p99: quantile(sorted, 0.99),
        over_half_pct: share(sorted, 0.005),
        over_1_pct: share(sorted, 0.01),
        over_2_pct: share(sorted, 0.02),
        by_session: sessionStats,
        open_over_1_per_token: { median: quantile(perToken, 0.5), p90: quantile(perToken, 0.9), max: perToken.length ? perToken[perToken.length - 1] : null },
      }
    },
  }
}

/** One chain, read day file by day file. A file that cannot be parsed line by line is counted, never guessed at. */
export function readChain (root, { days = null, now = Date.now() } = {}) {
  const dir = path.join(root, 'stock-peg')
  const c = collector()
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => /^stock-peg-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort() } catch (_) { return { error: `no readings under ${dir}` } }
  if (days != null) {
    // "--days 1" is today, not today and yesterday: a window of n days holds n day files, which is what a reader who
    // asks for 30 days means and what the answer's own "days recorded" line will then agree with.
    const from = new Date(now - (days - 1) * 86400e3).toISOString().slice(0, 10)
    files = files.filter((f) => f.slice('stock-peg-'.length, -'.jsonl'.length) >= from)
  }
  let broken = 0
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      let row = null
      try { row = JSON.parse(line) } catch (_) { broken++; continue }
      c.add(row)
    }
  }
  return { files: files.length, broken, ...c.done() }
}

const pct = (x, digits = 2) => (x == null ? '-' : (x * 100).toFixed(digits) + '%')
const n = (x) => (x == null ? '-' : String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' '))

export function render (byChain) {
  const out = ['how far the chain trades from the issuer price, by our own readings', '']
  for (const [chain, s] of Object.entries(byChain)) {
    if (s.error) { out.push(`${chain}: ${s.error}`, ''); continue }
    out.push(`## ${chain}`)
    out.push(`days recorded        ${s.days} (${n(s.rows)} rows, ${n(s.readings)} of them with a price on both sides)`)
    out.push(`left out             ${n(s.implausible)} readings whose pool price is beyond ${MAX_PLAUSIBLE_RATIO}x the issuer price either way: not this token's pool`)
    out.push(`tokens seen          ${s.tokens}, of which ${s.tokens_counted_open} have 20+ readings while the market was open`)
    out.push(`typical gap          median ${pct(s.median)}, 90th ${pct(s.p90)}, 99th ${pct(s.p99)}`)
    out.push(`how often it is big  over 0.5%: ${pct(s.over_half_pct, 1)}   over 1%: ${pct(s.over_1_pct, 1)}   over 2%: ${pct(s.over_2_pct, 1)}`)
    for (const [g, v] of Object.entries(s.by_session)) {
      out.push(`  ${g.padEnd(9)}        ${n(v.readings)} readings, median ${pct(v.median)}, 90th ${pct(v.p90)}, over 1%: ${pct(v.over1, 1)}`)
    }
    const t = s.open_over_1_per_token
    out.push(`per token, market open, share of readings over 1%: median ${pct(t.median, 1)}, 90th ${pct(t.p90, 1)}, worst ${pct(t.max, 1)}`)
    if (s.broken) out.push(`unparsable lines     ${s.broken}`)
    out.push('')
  }
  out.push('A reading is one token at one minute with a price on both sides. These are measurements: the local report')
  out.push('directory, not git.')
  return out.join('\n')
}

export function main (argv = process.argv.slice(2), { now = Date.now() } = {}) {
  let args
  try { args = parseArgs(argv) } catch (e) { console.error(e.message); return 1 }
  const chains = args.chains || Object.keys(DEFAULT_ROOTS)
  const byChain = {}
  for (const c of chains) byChain[c] = readChain(args.roots[c], { days: args.days, now })
  console.log(args.json ? JSON.stringify(byChain, null, 2) : render(byChain))
  return Object.values(byChain).every((s) => s.error) ? 1 : 0
}

if (process.argv[1] && process.argv[1].endsWith('gap-stats.mjs')) process.exitCode = main()
