// scripts/stocks/health-check.mjs: every 15 minutes (deployment/systemd/stp-health.timer), look at what the site and the
// recorder say about themselves and tell the owner, in Telegram (scripts/lib/alert.mjs), when something is off, and
// once more when it clears.
//
// It reads two things, both local and read-only:
//   - the site's own numbers, GET http://127.0.0.1:3005/stocks/api/status (registry and reading ages, errors);
//   - each chain's last recorder run row, <root>/stock-peg/stock-peg-runs-<day>.jsonl (errors, refusals, format changes).
// The thresholds are THRESHOLDS below; evaluate() is pure, so the tests hold every rule.
//
// Usage: node scripts/stocks/health-check.mjs [--site=http://127.0.0.1:3005/stocks] (roots from STOCKS_ROOT_BASE and
// STOCKS_ROOT_ROBINHOOD, as the site's own unit sets them)
import fs from 'node:fs'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { alert } from '../lib/alert.mjs'

export const THRESHOLDS = Object.freeze({
  registry_age_s: 900, // the site answers 503 for the chain past this (evm/core/stocks/verify.mjs REGISTRY_FRESH_S)
  reading_age_s: 1800, // the readings are marked stale past this
  impostors_age_s: 8 * 3600, // the list is rebuilt every 6 hours
  run_age_s: 1800, // the recorder runs every 15 minutes
  pair_error_share: 0.2, // DexScreener answered with an error (429 included) for more than this share of a run's tokens
  onchain_error_share: 0.2, // the chain could not be read for more than this share
  disagree_share: 0.1, // the chain and an aggregator priced more than this share of the deepest pools more than 2% apart
})
const CHAIN_NAME = { base: 'Base', robinhood: 'Robinhood Chain' }

/**
 * @param {object} p
 * @param {object|null} p.status   the site's /api/status answer, or null when the site did not answer
 * @param {string|null} p.siteError why the site did not answer
 * @param {object} p.runs           chain -> the last recorder run row, or null
 * @param {number} p.now
 * @returns {{ key: string, bad: boolean, text: string }[]} one entry per check; bad ones are alerts, good ones clear them
 */
export function evaluate ({ status, siteError = null, runs = {}, now }) {
  const out = []
  const put = (key, bad, text) => out.push({ key, bad: Boolean(bad), text })
  put('site:down', !status, status ? 'the site answers again.' : `the site does not answer on the host (${siteError || 'no answer'}). Every verdict is unavailable until it does.`)
  for (const c of Object.keys(CHAIN_NAME)) {
    const n = CHAIN_NAME[c], s = status?.[c], run = runs[c]
    if (s) {
      const regOld = s.registry_age_s == null || s.registry_age_s > THRESHOLDS.registry_age_s
      put(`registry:${c}`, regOld || s.registry_error, regOld || s.registry_error
        ? `${n}: the issuer list has not been read for ${s.registry_age_s == null ? 'ever' : Math.round(s.registry_age_s / 60) + ' min'}${s.registry_error ? ` (${s.registry_error})` : ''}. Past 15 minutes the site answers "registry unavailable" for ${n}, never "not listed".`
        : `${n}: the issuer list is read again.`)
      const rdOld = s.newest_reading_age_s == null || s.newest_reading_age_s > THRESHOLDS.reading_age_s
      put(`readings:${c}`, rdOld, rdOld ? `${n}: the newest price reading is ${s.newest_reading_age_s == null ? 'missing' : Math.round(s.newest_reading_age_s / 60) + ' min old'}. Passports show it as stale.` : `${n}: price readings are fresh again.`)
      const impOld = s.impostors_age_s == null || s.impostors_age_s > THRESHOLDS.impostors_age_s
      put(`impostors:${c}`, impOld, impOld ? `${n}: the look-alike list is ${s.impostors_age_s == null ? 'missing' : Math.round(s.impostors_age_s / 3600) + ' h old'} (it is rebuilt every 6 h).` : `${n}: the look-alike list is fresh again.`)
    }
    if (run === undefined) continue
    const runAge = run ? Math.round((now - Date.parse(run.finished_at || run.started_at)) / 1000) : null
    put(`run:${c}`, !run || runAge > THRESHOLDS.run_age_s || run.registry?.error || run.aborted,
      !run ? `${n}: the recorder has written no run today.`
        : runAge > THRESHOLDS.run_age_s ? `${n}: the recorder's last run finished ${Math.round(runAge / 60)} min ago (it runs every 15).`
          : run.registry?.error ? `${n}: the recorder could not read the issuer list (${String(run.registry.error).slice(0, 120)}).`
            : run.aborted ? `${n}: the recorder's last run stopped early (${String(run.aborted).slice(0, 120)}).`
              : `${n}: the recorder runs normally again.`)
    if (!run) continue
    const tokens = run.tokens_considered || 0
    if (tokens > 0) {
      const pe = (run.pair_read_errors || 0) / tokens
      put(`dexscreener:${c}`, pe > THRESHOLDS.pair_error_share, pe > THRESHOLDS.pair_error_share ? `${n}: DexScreener failed for ${run.pair_read_errors} of ${tokens} tokens in the last run (rate limit or outage). Prices then rest on the chain alone where it can read them.` : `${n}: DexScreener answers again.`)
      const oc = run.onchain
      const oe = oc ? (oc.error ? 1 : (oc.read_errors || 0) / tokens) : 0
      put(`rpc:${c}`, oe > THRESHOLDS.onchain_error_share, oe > THRESHOLDS.onchain_error_share ? `${n}: the chain could not be read${oc?.error ? ` (${String(oc.error).slice(0, 100)})` : ` for ${oc?.read_errors} of ${tokens} tokens`}. Prices then rest on the aggregators, with evidence: none.` : `${n}: the chain is read again.`)
      const dis = (run.refused?.sources_disagree || 0) / tokens
      put(`disagree:${c}`, dis > THRESHOLDS.disagree_share, dis > THRESHOLDS.disagree_share ? `${n}: for ${run.refused.sources_disagree} of ${tokens} tokens the chain and an aggregator disagree by more than 2% on the deepest pool. One of the sources may be wrong.` : `${n}: the price sources agree again.`)
    }
    const sc = run.shape_changes || {}
    for (const [src, changes] of Object.entries(sc)) put(`shape:${c}:${src}:${run.finished_at}`, true, `${n}: the format of ${src} changed: ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? `; and ${changes.length - 5} more` : ''}. Check the reader before it matters.`)
  }
  return out
}

/** The last run row of a chain's recorder (today's file, else yesterday's), or null. */
export function lastRun (root, now) {
  for (const d of [0, 1]) {
    const f = path.join(root, 'stock-peg', `stock-peg-runs-${new Date(now - d * 864e5).toISOString().slice(0, 10)}.jsonl`)
    let text
    try { text = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    const lines = text.trim().split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]) } catch (_) { /* a torn last line */ } }
  }
  return null
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const site = (arg('site') || 'http://127.0.0.1:3005/stocks').replace(/\/+$/, '')
  const roots = { base: process.env.STOCKS_ROOT_BASE || '/var/lib/stp/base', robinhood: process.env.STOCKS_ROOT_ROBINHOOD || '/var/lib/stp/robinhood' }
  const now = Date.now()
  let status = null, siteError = null
  try {
    const r = await fetch(site + '/api/status', { signal: AbortSignal.timeout(10_000) })
    if (r.ok) status = await r.json(); else siteError = `HTTP ${r.status}`
  } catch (e) { siteError = String(e && e.name || e) }
  const runs = Object.fromEntries(Object.entries(roots).map(([c, root]) => [c, lastRun(root, now)]))
  const checks = evaluate({ status, siteError, runs, now })
  const sent = []
  for (const ch of checks) sent.push([ch.key, await alert({ key: ch.key, text: ch.text, ok: !ch.bad })])
  const bad = checks.filter((c) => c.bad).map((c) => c.key)
  console.log('[stp-health] ' + JSON.stringify({ bad, sent: sent.filter(([, s]) => s === 'sent').map(([k]) => k) }))
}
