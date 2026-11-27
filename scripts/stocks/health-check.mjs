// scripts/stocks/health-check.mjs: every 15 minutes (deployment/systemd/stp-health.timer), look at what the site and the
// recorder say about themselves and tell the owner, in Telegram (scripts/lib/alert.mjs), when something is off, and
// once more when it clears.
//
// It reads, all local and read-only:
//   - the site's own numbers, GET http://127.0.0.1:3005/stocks/api/status (registry and reading ages, errors);
//   - each chain's last recorder run row, <root>/stock-peg/stock-peg-runs-<day>.jsonl (errors, refusals, format changes);
//   - the age of the newest token-static day file in each chain's token dataset, the input the look-alike list is built
//     from, which another project produces (tokenStreamChecks below; scripts/stocks/data-roots.mjs);
//   - the status file the backup of /var/lib/pos writes, when POS_BACKUP_STATUS names it (backupChecks below);
//   - the B20 transfer-rule changes the site saw and its current baselines (`base.b20.changes` and `.tokens` in
//     /api/status, docs/b20-transfers-tz.md §5): one alert per change not told before, and the difference with the
//     baseline this job last told the owner about, kept in a small file beside the alert state (sendB20Changes below).
//     The site holds no bot token; this job does.
// The thresholds are THRESHOLDS and the constants beside each check; the rules are pure, so the tests hold every one.
//
// Usage: node scripts/stocks/health-check.mjs [--site=http://127.0.0.1:3005/stocks] (roots from STOCKS_ROOT_BASE and
// STOCKS_ROOT_ROBINHOOD, the token datasets from POS_TOKEN_DATASET_BASE and POS_TOKEN_DATASET_ROBINHOOD, defaults in
// scripts/stocks/data-roots.mjs)
import fs from 'node:fs'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { alert } from '../lib/alert.mjs'
import { dataRoot, tokenDataset } from './data-roots.mjs'
import { readStatus } from '../ops/pos-backup.mjs'
import { changeText, snapshotChanges } from '../../evm/core/stocks/b20.mjs'

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
export function evaluate ({ status, siteError = null, runs = {}, prevRuns = {}, mirrors = {}, now }) {
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
      // The list locks (docs/list-locks-tz.md): a record the chain contradicts, or no factory check to lean on.
      if (s.factory_check) {
        const fc = s.factory_check
        put(`factory-check:${c}`, fc.state === 'unavailable', fc.state === 'unavailable' ? `${n}: the factory check is unavailable (no mirror this code trusts, or none that reached a finalized block), so every ${n} record is held: no verdict.${fc.last_error ? ' Last error: ' + String(fc.last_error).slice(0, 120) + '.' : ''}` : `${n}: the factory check is available again.`)
        const first = (s.held || []).find((h) => h.reason !== 'awaiting_factory_confirmation')
        const aw = s.held_awaiting_since ? Math.round((now - Date.parse(s.held_awaiting_since)) / 60e3) : null
        put(`list-awaiting:${c}`, aw != null && aw > 120, aw != null && aw > 120 ? `${n}: a record has been on the issuer list for ${aw} min without the factory check confirming it (normally under an hour). The mirror, or its second RPC, may be stuck; it stays without a verdict until then.` : `${n}: no record has waited long for the factory check.`)
        put(`list-conflict:${c}`, (s.held_conflicts || 0) > 0, s.held_conflicts > 0 ? `${n}: ${s.held_conflicts} record(s) on the issuer list are held because the chain contradicts them (first ${first ? first.address + ': ' + first.reason : 'unknown'}). Verdicts for them are withheld; look at the issuer's list.` : `${n}: no record on the issuer list is contradicted by the chain.`)
      }
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
    slowRuns(put, n, 'slow:' + c, run, prevRuns[c])
    mirrorChecks(put, n, c, mirrors[c], now)
    const sc = run.shape_changes || {}
    for (const [src, changes] of Object.entries(sc)) put(`shape:${c}:${src}:${run.finished_at}`, true, `${n}: the format of ${src} changed: ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? `; and ${changes.length - 5} more` : ''}. Check the reader before it matters.`)
  }
  return out
}

/** Below this the settlement wallet cannot pay a day's gas budget (DAILY_GAS_WEI in the x402 module): top it up. */
export const SETTLEMENT_GAS_MIN_WEI = 3n * 10n ** 14n
/** A late settlement is announced in the run after it is logged, once (alert() sends a key at most hourly). */
export const LATE_SETTLEMENT_WINDOW_S = 20 * 60

/**
 * Paid passes (apps/stocks-web.mjs paymentsStatus): selling paused after failed settlements, a broadcast still without
 * a receipt after the module's watch (refund by hand if the USDC moved), and gas on the settlement wallet. Nothing when
 * passes are off. A late settlement is never "resolved": it is a task for a person, sent once.
 */
export function paymentChecks ({ payments, balanceWei = null, balanceError = null, now }) {
  if (!payments || !payments.enabled) return []
  const out = []
  const paused = Boolean(payments.paused_until) && Date.parse(payments.paused_until) > now
  out.push({ key: 'x402:paused', bad: paused, text: paused
    ? 'paid passes are paused until ' + payments.paused_until + ': several settlements in a row failed on chain after they were sent. Look at the stp-web journal ([x402] settlement failed) before it resumes.'
    : 'paid passes are on sale again.' })
  for (const e of Array.isArray(payments.late_settlements) ? payments.late_settlements : []) {
    if (!/^0x[0-9a-f]{64}$/.test(e?.transaction || '') || !(now - Date.parse(e.at) < LATE_SETTLEMENT_WINDOW_S * 1000)) continue
    out.push({ key: 'x402:late:' + e.transaction, bad: true, text: 'a pass payment was sent and has no receipt after 10 minutes: https://basescan.org/tx/' + e.transaction + '. If the USDC moved and no pass was given, refund it by hand (the stp-web journal line [x402] settled is the record).' })
  }
  if (balanceError) out.push({ key: 'x402:gas', bad: true, text: 'the gas balance of the settlement wallet ' + payments.settlement_wallet + ' could not be read (' + String(balanceError).slice(0, 80) + ').' })
  else if (balanceWei != null) {
    const low = BigInt(balanceWei) < SETTLEMENT_GAS_MIN_WEI
    out.push({ key: 'x402:gas', bad: low, text: low
      ? 'the settlement wallet ' + payments.settlement_wallet + ' holds ' + (Number(BigInt(balanceWei)) / 1e18).toFixed(6) + ' ETH on Base, less than a day of gas: top it up or passes will be refused.'
      : 'the settlement wallet has gas again.' })
  }
  return out
}

/** The ETH balance of an address on Base, through STP_RPC_BASE or the public node. */
export async function baseBalance (address, { env = process.env, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(env.STP_RPC_BASE || 'https://mainnet.base.org', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }) })
  const j = await r.json()
  if (!j || typeof j.result !== 'string') throw new Error((j && j.error && j.error.message) || 'no balance in the answer')
  return BigInt(j.result)
}

/**
 * The issuer's list against its factory on chain (scripts/stocks/issuer-mirror.mjs). A token on the list that the
 * factory never created is the one that matters: the list, or the mirror, is wrong, and a person should look. A mirror
 * that has not caught up says nothing; one not updated for 2 hours says so. Tokens the factory made that the list
 * leaves out are normal (tests, delisted, not yet listed) and never alert.
 */
export function mirrorChecks (put, name, chain, mirror, now) {
  if (mirror === undefined) return
  // Freshness is the age of the newest finalized block the mirror has reached (last_ok.target_block_time), never the
  // last attempt (updated_at: a failing RPC looked fresh) nor the last success (last_ok.at: a finalized block stuck for
  // days was reached again every run and looked fresh; outside reviews, 25.11). Normal is about half an hour: the
  // finality lag plus one run. A first backfill that is moving, without an error, is reported but does not page.
  const okAge = mirror?.last_ok?.target_block_time ? Math.round((now - Date.parse(mirror.last_ok.target_block_time)) / 1000) : null
  const tryAge = mirror?.updated_at ? Math.round((now - Date.parse(mirror.updated_at)) / 1000) : null
  const backfilling = mirror && okAge == null && !mirror.last_error && tryAge != null && tryAge <= 7200
  const bad = mirror === null || (okAge == null ? !backfilling : okAge > 7200)
  const err = mirror?.last_error ? ` Last error: ${String(mirror.last_error).slice(0, 120)}.` : ''
  put('mirror-stale:' + chain, bad,
    mirror === null ? name + ': the chain mirror of the issuer list has not been built yet, or its file is not one this code trusts (it is rebuilt from the start).'
      : backfilling ? name + ': the chain mirror is backfilling to the finalized block (scanned to ' + mirror.scanned_to + ').'
        : okAge == null ? name + ': the chain mirror has never reached a finalized block.' + err
          : okAge > 7200 ? name + ': the newest finalized block the chain mirror has reached is ' + Math.round(okAge / 60) + ' min old (normally about 30): the mirror, or the chain\'s finality, is stuck.' + err
            : name + ': the chain mirror of the issuer list is caught up again.')
  // A creation the chain no longer holds (scripts/stocks/issuer-mirror.mjs revalidateMirror): a person looks. It stays
  // bad for 7 days after the last revocation, so it is seen, then rests; the record stays in the mirror for good.
  const recent = (mirror?.revoked || []).filter((r) => now - Date.parse(r.revoked_at) <= 7 * 864e5)
  put('mirror-revoked:' + chain, recent.length > 0, recent.length ? name + ': ' + recent.length + ' token creation(s) the issuer\'s factory was recorded making are no longer on the chain (first ' + recent[0].address + ': ' + recent[0].why + '). Look before trusting it.' : name + ': no token creation has been taken back in the last 7 days.')
  const c = mirror?.comparison
  if (!c) return
  const odd = c.on_list_not_created || []
  put('mirror-list:' + chain, odd.length > 0, odd.length ? name + ': ' + odd.length + ' token(s) on the issuer list were never created by its factory on chain (first ' + odd[0] + '). The list or the mirror is wrong; verdicts for those tokens are withheld.' : name + ': every token on the issuer list was created by its factory on chain again.')
}

/**
 * Warn before the deadline is hit (12.11: a Robinhood run stopped at its deadline with no warning before). Bad when
 * the last two runs both used 80% or more of their time budget; resolved when both are back under 70%; between the
 * two, nothing is said, so a run near the line neither pages nor resolves.
 */
export function slowRuns (put, name, key, run, prev) {
  const share = (r) => (r && r.duration_s != null && r.budget_s > 0 ? r.duration_s / r.budget_s : null)
  const a = share(run), b = share(prev)
  if (a == null || b == null) return
  if (a >= 0.8 && b >= 0.8) put(key, true, `${name}: the recorder used ${Math.round(a * 100)}% of its time budget (${Math.round(run.duration_s)} of ${run.budget_s} s) two runs in a row. Nothing is missing yet; one more slow source and a run stops early.`)
  else if (a < 0.7 && b < 0.7) put(key, false, `${name}: the recorder is back under 70% of its time budget.`)
}

/** The last n run rows of a chain's recorder, newest first (today's file, then yesterday's). */
export function lastRuns (root, now, n = 2) {
  const out = []
  for (const d of [0, 1]) {
    const f = path.join(root, 'stock-peg', `stock-peg-runs-${new Date(now - d * 864e5).toISOString().slice(0, 10)}.jsonl`)
    let text
    try { text = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    const lines = text.trim().split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) { try { out.push(JSON.parse(lines[i])) } catch (_) { /* a torn line */ } }
    if (out.length >= n) break
  }
  return out
}

// The token streams (scripts/stocks/data-roots.mjs): the collector writes a chain's token-static day file each time it
// sees a new token. Measured on the host on 12.11 over 30 days of observed_at: quiet stretches of up to 5.1 h on an
// ordinary day, and one real outage of about 30 h on both chains (1 to 2 Nov). 8 h is past every ordinary quiet stretch
// and catches an outage within a third of a day. STP_TOKEN_STREAM_MAX_AGE_H overrides it.
/**
 * Where health-check keeps the B20 baseline it last told the owner about: STP_B20_SENT, else beside the alert state, in
 * the unit's state directory.
 */
export const b20SentFile = (env = process.env) => env.STP_B20_SENT || path.join(path.dirname(env.STP_ALERT_STATE || '/var/lib/stp-alerts/state.json'), 'b20-sent.json')

/** One change applied to a kept snapshot: what the owner has now been told. */
function applyChange (snap, c) {
  if (c.kind === 'policy_id') snap.policies = { ...snap.policies, [c.scope]: c.to }
  else if (c.kind === 'paused') snap.paused = c.to
  else if (c.kind === 'answer') snap.answers = { ...snap.answers, [c.key]: c.to }
}

/** How many told changes are remembered by id: far more than the site lists (apps/b20-reader.mjs CHANGES_KEPT). */
export const B20_TOLD_KEPT = 2000
/** A listed change's id: its token, kind, scope, account and block. The same change seen in two runs has the same id. */
export const b20ChangeKey = (token, c) => [token, c.kind, c.scope ?? '', c.account ?? '', c.address ?? '', c.block].join('|')
/** The answers key of a listed change, as snapshotOf names it. */
const answerKey = (c) => (c.account === 'ordinary_wallet' ? 'ordinary_wallet' : c.account + ':' + c.address) + '|' + c.scope

/**
 * One alert per B20 change (docs/b20-transfers-tz.md §5). Two sources from /api/status, `base.b20`:
 *   - `changes`, the site's recent changes with their block and time: each one not told before is sent, in block order,
 *     so a pause and an unpause between two runs of this job are two alerts;
 *   - `tokens`, the site's current baselines: after a restart of the site (whose list starts empty) the difference with
 *     the baseline this job last told the owner about is sent, so nothing is lost.
 * Never backwards: a change or a baseline at a block not above the one last told for that token is not compared. A
 * change counts as told only when Telegram took it ('sent'); 'logged' or 'failed' is tried again next run, and a token
 * whose change could not be sent waits whole, so the order holds. The kept file is written after each alert sent. A
 * token seen for the first time is kept without an alert. Never throws.
 * @returns {Promise<string[]>} one line per alert sent this run
 */
export async function sendB20Changes ({ status, file, alertImpl = alert, env = process.env }) {
  const b20 = status && status.base && status.base.b20
  const cur = b20 && b20.tokens && typeof b20.tokens === 'object' ? b20.tokens : null
  if (!cur) return []
  const listed = Array.isArray(b20.changes) ? b20.changes : []
  let kept = {}, told = []
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.tokens && typeof j.tokens === 'object') kept = j.tokens; if (j && Array.isArray(j.told)) told = j.told.filter((x) => typeof x === 'string') } catch (_) { /* nothing kept yet */ }
  const toldSet = new Set(told)
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ tokens: kept, told: told.slice(-B20_TOLD_KEPT) }), { mode: 0o600 }); fs.renameSync(tmp, file) } catch (_) { /* tried again next run */ } }
  const send = async (token, symbol, block, c) => {
    const text = changeText({ symbol: typeof symbol === 'string' ? symbol.slice(0, 16) : null, token, block }, [c])
    try { return (await alertImpl({ key: `b20:base:${token}`, text }, { env, everyMs: 0 })) === 'sent' } catch (_) { return false }
  }
  const out = []
  let dirty = false
  for (const [token, snap] of Object.entries(cur)) {
    if (!/^0x[0-9a-f]{40}$/.test(token) || !snap || typeof snap !== 'object' || !snap.policies || !Number.isInteger(snap.block)) continue
    const prev = kept[token]
    if (!prev) { kept[token] = { policies: { ...snap.policies }, paused: snap.paused ?? null, answers: { ...(snap.answers || {}) }, block: snap.block }; dirty = true; continue }
    const last = Number.isInteger(prev.block) ? prev.block : -1
    let waiting = false
    // 1. The site's list, in block order: each change at or above the last block told (two changes can share a block,
    // and one of them may still wait), not told before.
    const mine = listed.filter((c) => c && c.token === token && Number.isInteger(c.block) && c.block >= last && ['policy_id', 'paused', 'answer'].includes(c.kind)).sort((a, b) => a.block - b.block)
    for (const c of mine) {
      const id = b20ChangeKey(token, c)
      if (toldSet.has(id)) continue
      if (!(await send(token, snap.symbol, c.block, c))) { waiting = true; break }
      applyChange(prev, c.kind === 'answer' ? { ...c, key: answerKey(c) } : c); prev.block = c.block
      told.push(id); toldSet.add(id); save(); dirty = false
      out.push(`${token} ${c.kind} ${c.scope ?? ''} ${c.block}`.trim())
    }
    if (waiting) continue
    // 2. The baseline, never backwards: only a reading above the last block told is compared.
    if (!(snap.block > (Number.isInteger(prev.block) ? prev.block : -1))) continue
    let sentAll = true
    for (const c of snapshotChanges(prev, snap)) {
      if (!(await send(token, snap.symbol, snap.block, c))) { sentAll = false; break }
      applyChange(prev, c)
      save(); dirty = false
      out.push(`${token} ${c.kind} ${c.scope ?? ''} ${snap.block}`.trim())
    }
    if (!sentAll) continue
    // Values the kept baseline has not seen yet (a new venue, a pause that was unreadable) are taken without an alert,
    // and the baseline is now as of this block.
    if (prev.paused == null && (snap.paused === true || snap.paused === false)) prev.paused = snap.paused
    for (const [k, v] of Object.entries(snap.answers || {})) if (!(k in (prev.answers || {}))) prev.answers = { ...(prev.answers || {}), [k]: v }
    for (const sc of Object.keys(snap.policies)) if (prev.policies?.[sc] == null && snap.policies[sc] != null) prev.policies = { ...prev.policies, [sc]: snap.policies[sc] }
    prev.block = snap.block; dirty = true
  }
  if (dirty) save()
  return out
}

export const TOKEN_STREAM_MAX_AGE_S = 8 * 3600
const STATIC_DAY = /^token-static-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/

/**
 * The newest token-static day file of a token dataset, by the day in its name (a day compressed later gets a new mtime,
 * so the newest mtime would lie), with its mtime. Null when there is none; an unreadable directory throws.
 */
export function newestTokenStatic (dataset) {
  const dir = path.join(dataset, 'static')
  let best = null
  for (const f of fs.readdirSync(dir)) {
    const m = STATIC_DAY.exec(f)
    if (!m) continue
    // The collector compresses an old day by writing the .gz and deleting the .jsonl: a file gone since readdir is skipped.
    let mtimeMs
    try { mtimeMs = fs.statSync(path.join(dir, f)).mtimeMs } catch (e) { if (e && e.code === 'ENOENT') continue; throw e }
    // No write to a day can come after that day ends: a day compressed later (a new mtime) is never fresher than its end,
    // so a collector that stopped is not made to look alive by the compression of its last day.
    mtimeMs = Math.min(mtimeMs, Date.parse(m[1] + 'T00:00:00Z') + 864e5)
    if (!best || m[1] > best.day || (m[1] === best.day && mtimeMs > best.mtimeMs)) best = { day: m[1], file: f, mtimeMs }
  }
  return best
}

/**
 * @param {object} p
 * @param {object} p.newest  chain -> { mtimeMs } (newestTokenStatic), null (no day file), or { error }
 * @returns {{ key: string, bad: boolean, text: string }[]}
 */
export function tokenStreamChecks ({ newest = {}, now, maxAgeS = TOKEN_STREAM_MAX_AGE_S }) {
  const out = []
  for (const [c, n] of Object.entries(CHAIN_NAME)) {
    if (!(c in newest)) continue
    const s = newest[c]
    const what = `${n}: the token streams that feed the look-alike list`
    if (!s || s.error) {
      out.push({ key: `token-streams:${c}`, bad: true, text: `${what} cannot be read (${s ? String(s.error).slice(0, 100) : 'no day file'}); the list may be stale.` })
      continue
    }
    const ageS = Math.round((now - s.mtimeMs) / 1000)
    const old = ageS > maxAgeS
    out.push({ key: `token-streams:${c}`, bad: old, text: old ? `${what} have not been updated for ${Math.floor(ageS / 3600)} h; the list may be stale.` : `${what} are updated again.` })
  }
  return out
}

// The backup (deployment/BACKUP.md, scripts/ops/pos-backup.mjs) runs every 6 hours over the data root and the anchors
// beside it, and writes its status file. A day without a success is four missed runs in a row.
export const BACKUP_MAX_AGE_S = 24 * 3600

/** The backup's status file, or null when it is missing or unreadable (the backup's own reader). */
export const readBackupStatus = readStatus

/**
 * @param {object} p
 * @param {object|null} p.status  the backup's status file (null: none yet)
 * @returns {{ key: string, bad: boolean, text: string }[]}
 */
export function backupChecks ({ status, now, maxAgeS = BACKUP_MAX_AGE_S }) {
  const okAt = Date.parse(status?.last_success_at)
  const lastError = status?.last_error ? String(status.last_error).slice(0, 100) : null
  if (!Number.isFinite(okAt)) {
    return [{ key: 'backup:pos', bad: true, text: `no successful backup of /var/lib/pos is recorded yet${lastError ? ` (last attempt: ${lastError})` : ''}. The price history and the case archive have no copy off this host (deployment/BACKUP.md).` }]
  }
  const ageS = Math.round((now - okAt) / 1000)
  const old = ageS > maxAgeS
  const out = [{ key: 'backup:pos', bad: old, text: old
    ? `the last successful backup of /var/lib/pos was ${Math.floor(ageS / 3600)} h ago (it runs every 6 h)${lastError ? `; last attempt: ${lastError}` : ''}.`
    : 'the backup of /var/lib/pos succeeds again.' }]
  // A backup that succeeded can still be short: a path POS_BACKUP_SOURCE names was not on the host, so nothing of it
  // is in the copy. The run does not fail for it (the data root matters more), so this is its own alert. The backup
  // writes this list only beside a success, so it describes the newest snapshot, never a run that wrote nothing.
  const missing = Array.isArray(status.missing_sources) ? status.missing_sources.filter((p) => typeof p === 'string') : []
  out.push({ key: 'backup:sources', bad: missing.length > 0, text: missing.length
    ? `the backup left out ${missing.join(', ')}: ${missing.length === 1 ? 'that path is' : 'those paths are'} not on the host, so nothing of ${missing.length === 1 ? 'it' : 'them'} is in the copy.`
    : 'the backup copies every path it is given again.' })
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

/** The checks that keep POS standing on its own (deployment/CUTOVER.md): its input from another project, its backup. */
export function standaloneChecks (now, { env = process.env } = {}) {
  const newest = {}
  for (const c of Object.keys(CHAIN_NAME)) {
    try { newest[c] = newestTokenStatic(tokenDataset(c, { env })) } catch (e) { newest[c] = { error: (e && e.code) || String(e) } }
  }
  const maxH = Number(env.STP_TOKEN_STREAM_MAX_AGE_H)
  const out = tokenStreamChecks({ newest, now, maxAgeS: maxH > 0 ? maxH * 3600 : TOKEN_STREAM_MAX_AGE_S })
  // Only where the unit names the status file: before the cutover there is no backup to check, and no alert for it.
  if (env.POS_BACKUP_STATUS) out.push(...backupChecks({ status: readBackupStatus(env.POS_BACKUP_STATUS), now }))
  return out
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const site = (arg('site') || 'http://127.0.0.1:3005/stocks').replace(/\/+$/, '')
  const roots = Object.fromEntries(Object.keys(CHAIN_NAME).map((c) => [c, dataRoot(c)]))
  const now = Date.now()
  let status = null, siteError = null
  try {
    const r = await fetch(site + '/api/status', { signal: AbortSignal.timeout(10_000) })
    if (r.ok) status = await r.json(); else siteError = `HTTP ${r.status}`
  } catch (e) { siteError = String(e && e.name || e) }
  const recent = Object.fromEntries(Object.entries(roots).map(([c, root]) => [c, lastRuns(root, now, 2)]))
  const runs = Object.fromEntries(Object.entries(recent).map(([c, r]) => [c, r[0] || null]))
  const prevRuns = Object.fromEntries(Object.entries(recent).map(([c, r]) => [c, r[1] || null]))
  const { readMirror } = await import('./issuer-mirror.mjs')
  const mirrors = Object.fromEntries(Object.entries(roots).map(([c, root]) => [c, readMirror(path.join(root, 'stock-peg'), c)]))
  const checks = evaluate({ status, siteError, runs, prevRuns, mirrors, now })
  checks.push(...standaloneChecks(now))
  let payments = null
  try { const r = await fetch(site + '/api/status/payments', { signal: AbortSignal.timeout(10_000) }); if (r.ok) payments = await r.json() } catch (_) { /* the site check above already says the site is down */ }
  if (payments && payments.enabled) {
    let balanceWei = null, balanceError = null
    if (/^0x[0-9a-fA-F]{40}$/.test(payments.settlement_wallet || '')) { try { balanceWei = await baseBalance(payments.settlement_wallet) } catch (e) { balanceError = String(e && e.message || e) } }
    checks.push(...paymentChecks({ payments, balanceWei, balanceError, now }))
  }
  const sent = []
  for (const ch of checks) sent.push([ch.key, await alert({ key: ch.key, text: ch.text, ok: !ch.bad })])
  for (const line of await sendB20Changes({ status, file: b20SentFile() })) sent.push(['b20:' + line, 'sent'])
  const bad = checks.filter((c) => c.bad).map((c) => c.key)
  console.log('[stp-health] ' + JSON.stringify({ bad, sent: sent.filter(([, s]) => s === 'sent').map(([k]) => k) }))
}
