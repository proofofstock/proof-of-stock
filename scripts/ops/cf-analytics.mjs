#!/usr/bin/env node
// scripts/ops/cf-analytics.mjs: what Cloudflare's edge counted for a zone, on the operator's own machine.
//
// The site is proxied through Cloudflare, so the edge already counts every request before our host sees it: no
// beacon, no script on the visitor's page, no token in the HTML. This pulls those counts through the GraphQL
// Analytics API so a day's numbers can sit next to our own counter in the daily report instead of in a browser tab.
//
// IT PRINTS NUMBERS. They are a measurement, so they belong in the operator's local report directory, never in git,
// a commit message or a PR body (the data rules kept above this repository). This file is the instrument and may be
// committed; its output may not.
//
// The token: a Cloudflare API token with Zone -> Analytics -> Read on this zone alone. Nothing else. It is read from
// CF_API_TOKEN, or from the file named by CF_TOKEN_FILE, and is never printed, not even in an error. No path is
// written down here: a local path of the operator's is one of the things the public export refuses.
//
// Run:
//   node scripts/ops/cf-analytics.mjs                        the last 7 days of proofofstock.xyz
//   node scripts/ops/cf-analytics.mjs --days 30 --countries  a month, with where the requests came from
//   node scripts/ops/cf-analytics.mjs --zone other.example   another zone the token can read
//
// Exit codes: 0 answered, 1 asked wrongly (no token, unknown zone), 75 Cloudflare could not answer right now.
import fs from 'node:fs'

const API = 'https://api.cloudflare.com/client/v4'
const DEFAULT_ZONE = 'proofofstock.xyz'
const EX_USAGE = 1
const EX_TEMPFAIL = 75

/** The flags, as given. Unknown ones are refused rather than ignored: a typo must not silently change the window. */
export function parseArgs (argv) {
  const out = { zone: DEFAULT_ZONE, days: 7, countries: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--zone') { out.zone = String(argv[++i] || '') ; continue }
    if (a === '--days') { out.days = Number(argv[++i]); continue }
    if (a === '--countries') { out.countries = true; continue }
    throw new Error(`unknown argument ${a}`)
  }
  if (!out.zone || !/^[a-z0-9.-]+$/i.test(out.zone)) throw new Error('--zone takes a domain name')
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 365) throw new Error('--days takes 1 to 365')
  return out
}

/** The token, from the environment or from a file nobody else can read. Never returned anywhere it could be printed. */
export function loadToken (env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const inline = (env.CF_API_TOKEN || '').trim()
  if (inline) return inline
  const file = env.CF_TOKEN_FILE
  if (!file) throw new Error('no token: set CF_API_TOKEN, or point CF_TOKEN_FILE at a file holding one (a Cloudflare token with Zone -> Analytics -> Read on this zone alone)')
  let text = ''
  try { text = readFile(file) } catch (_) { throw new Error(`CF_TOKEN_FILE names ${file}, which cannot be read`) }
  const token = text.trim()
  if (token.length < 30) throw new Error(`the token in ${file} does not look like one`)
  return token
}

/** UTC dates, oldest first, ending yesterday: today is still being counted and would read as a drop. */
export function windowDates (days, now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400e3
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86400e3).toISOString().slice(0, 10))
}

const QUERY = `query ($zone: String!, $from: String!, $to: String!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    httpRequests1dGroups(limit: 365, filter: { date_geq: $from, date_leq: $to }, orderBy: [date_ASC]) {
      dimensions { date }
      sum { requests pageViews bytes cachedRequests threats }
      uniq { uniques }
    }
  } }
}`

const COUNTRY_QUERY = `query ($zone: String!, $from: String!, $to: String!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    httpRequests1dGroups(limit: 365, filter: { date_geq: $from, date_leq: $to }) {
      sum { countryMap { clientCountryName requests threats } }
    }
  } }
}`

/** One call. The token goes in a header and nowhere else; an error carries Cloudflare's words, never ours plus it. */
async function call (url, token, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body) {
    const said = (body && body.errors || []).map((e) => e.message).join('; ')
    const err = new Error(`cloudflare answered ${res.status}${said ? ': ' + said : ''}`)
    err.retryable = res.status >= 500 || res.status === 429
    throw err
  }
  return body
}

/** The zone's tag, looked up by name: the tag is what every analytics query takes. */
export async function zoneTag (name, token, fetchImpl = fetch) {
  const body = await call(`${API}/zones?name=${encodeURIComponent(name)}&status=active`, token, {}, fetchImpl)
  const zone = (body.result || [])[0]
  if (!zone) throw new Error(`no active zone named ${name} that this token can read`)
  return zone.id
}

async function graphql (query, variables, token, fetchImpl = fetch) {
  const body = await call(`${API}/graphql`, token, { method: 'POST', body: JSON.stringify({ query, variables }) }, fetchImpl)
  if (body.errors && body.errors.length) {
    const err = new Error('cloudflare refused the query: ' + body.errors.map((e) => e.message).join('; '))
    err.retryable = false
    throw err
  }
  return body.data?.viewer?.zones?.[0] || null
}

/** One row per day, oldest first, with the days Cloudflare has no row for shown as zero rather than left out. */
export function rowsFor (days, groups) {
  const byDate = new Map((groups || []).map((g) => [g.dimensions.date, g]))
  return days.map((date) => {
    const g = byDate.get(date)
    return {
      date,
      requests: g?.sum?.requests ?? 0,
      pageViews: g?.sum?.pageViews ?? 0,
      uniques: g?.uniq?.uniques ?? 0,
      cached: g?.sum?.cachedRequests ?? 0,
      threats: g?.sum?.threats ?? 0,
      bytes: g?.sum?.bytes ?? 0,
      missing: !g,
    }
  })
}

const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const mb = (b) => (b / 1048576).toFixed(1) + ' MB'
const pad = (s, w) => String(s).padStart(w)

export function render (zone, rows, countries) {
  const out = []
  const total = rows.reduce((a, r) => ({
    requests: a.requests + r.requests, pageViews: a.pageViews + r.pageViews,
    cached: a.cached + r.cached, threats: a.threats + r.threats, bytes: a.bytes + r.bytes,
  }), { requests: 0, pageViews: 0, cached: 0, threats: 0, bytes: 0 })
  out.push(`${zone}: what Cloudflare's edge counted, ${rows[0].date} to ${rows[rows.length - 1].date} UTC`)
  out.push('')
  out.push(['date        ', pad('requests', 10), pad('pages', 8), pad('visitors', 9), pad('cached', 7), pad('threats', 8), pad('traffic', 10)].join(' '))
  for (const r of rows) {
    const cached = r.requests ? Math.round(r.cached / r.requests * 100) + '%' : '-'
    out.push([r.date + (r.missing ? ' *' : '  '), pad(n(r.requests), 10), pad(n(r.pageViews), 8), pad(n(r.uniques), 9), pad(cached, 7), pad(n(r.threats), 8), pad(mb(r.bytes), 10)].join(' '))
  }
  out.push('')
  out.push(['total       ', pad(n(total.requests), 10), pad(n(total.pageViews), 8), pad('', 9), pad(total.requests ? Math.round(total.cached / total.requests * 100) + '%' : '-', 7), pad(n(total.threats), 8), pad(mb(total.bytes), 10)].join(' '))
  if (rows.some((r) => r.missing)) out.push('* no row for that day: Cloudflare keeps daily rows for a limited window on this plan.')
  out.push('Visitors are counted per day and do not add up across days, so the total leaves that column empty.')
  if (countries && countries.length) {
    out.push('')
    out.push('where the requests came from')
    for (const c of countries.slice(0, 12)) out.push(`  ${c.clientCountryName}  ${pad(n(c.requests), 9)}${c.threats ? `  (${n(c.threats)} blocked)` : ''}`)
  }
  out.push('')
  out.push('These are measurements: they belong in the local report directory, not in git.')
  return out.join('\n')
}

export async function main (argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  let args, token
  try { args = parseArgs(argv); token = loadToken(env) } catch (e) { console.error(e.message); return EX_USAGE }
  const days = windowDates(args.days, now)
  const from = days[0], to = days[days.length - 1]
  try {
    const tag = await zoneTag(args.zone, token, fetchImpl)
    const data = await graphql(QUERY, { zone: tag, from, to }, token, fetchImpl)
    if (!data) { console.error('the token reached Cloudflare but may not read this zone\'s analytics'); return EX_USAGE }
    const rows = rowsFor(days, data.httpRequests1dGroups)
    let countries = null
    if (args.countries) {
      const c = await graphql(COUNTRY_QUERY, { zone: tag, from, to }, token, fetchImpl).catch(() => null)
      const seen = new Map()
      for (const g of c?.httpRequests1dGroups || []) {
        for (const m of g.sum?.countryMap || []) {
          const prev = seen.get(m.clientCountryName) || { clientCountryName: m.clientCountryName, requests: 0, threats: 0 }
          prev.requests += m.requests; prev.threats += m.threats
          seen.set(m.clientCountryName, prev)
        }
      }
      countries = [...seen.values()].sort((a, b) => b.requests - a.requests)
    }
    console.log(render(args.zone, rows, countries))
    return 0
  } catch (e) {
    console.error(e.message)
    return e.retryable ? EX_TEMPFAIL : EX_USAGE
  }
}

if (process.argv[1] && process.argv[1].endsWith('cf-analytics.mjs')) {
  main().then((code) => { process.exitCode = code })
}
