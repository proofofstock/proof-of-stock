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
//   - the B20 transfer-rule changes in the site's outbox (/api/status/b20/events, docs/b20-transfers-tz.md §5), read
//     with a cursor kept beside the alert state and told in batches (sendB20Events below); and whether the B20 reader is
//     blind (evaluate). The site holds no bot token; this job does.
// And, over the network, what lives outside the repository (outsideChecks below): the guard's latest version on npm, the
// server's on the official MCP registry, and whether a release was cut, against this release's own files.
// The thresholds are THRESHOLDS and the constants beside each check; the rules are pure, so the tests hold every one.
//
// Usage: node scripts/stocks/health-check.mjs [--site=http://127.0.0.1:3005/stocks] (roots from STOCKS_ROOT_BASE and
// STOCKS_ROOT_ROBINHOOD, the token datasets from POS_TOKEN_DATASET_BASE and POS_TOKEN_DATASET_ROBINHOOD, defaults in
// scripts/stocks/data-roots.mjs)
import fs from 'node:fs'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { alert, sendTelegram } from '../lib/alert.mjs'
import { dataRoot, tokenDataset } from './data-roots.mjs'
import { readStatus } from '../ops/pos-backup.mjs'
import { changeText } from '../../evm/core/stocks/b20.mjs'

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
  // The B20 reader (docs/b20-transfers-tz.md): blind when its last successful cycle is older than B20_BLIND_S, or it has
  // never had one. It clears when a cycle succeeds.
  const b20 = status?.base?.b20
  if (b20 && b20.reader === 'on') {
    const okAt = b20.last_ok_at ? Date.parse(b20.last_ok_at) : NaN
    const blind = !Number.isFinite(okAt) || now - okAt > B20_BLIND_S * 1000
    put('b20:base:blind', blind, blind ? `Base: the B20 transfer rules have not been read from both RPCs ${Number.isFinite(okAt) ? 'for ' + Math.round((now - okAt) / 60000) + ' min' : 'since the site started'}${b20.last_error ? ' (' + String(b20.last_error).slice(0, 40) + ')' : ''}. Passports say unknown and no change is seen until a read succeeds.` : 'Base: the B20 transfer rules are read again.')
  }
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
/** Where health-check keeps its B20 cursor: STP_B20_SENT, else beside the alert state, in the unit's state directory. */
export const b20SentFile = (env = process.env) => env.STP_B20_SENT || path.join(path.dirname(env.STP_ALERT_STATE || '/var/lib/stp-alerts/state.json'), 'b20-sent.json')
/** At most this many events in one Telegram message, and this many characters (Telegram takes 4,096). */
export const B20_BATCH_EVENTS = 25
export const B20_MESSAGE_CHARS = 3_800
/** A Telegram retry_after up to this long is waited for in the run; a longer one leaves the rest for the next run. */
export const B20_RETRY_WAIT_MAX_S = 30
/** The run's own budget for B20 messages, inside the unit's two minutes. */
export const B20_RUN_BUDGET_MS = 60_000
/** A reader whose last successful cycle is older than this is blind: four refresh cycles. */
export const B20_BLIND_S = 20 * 60

/** Runs a batch may fail to reach Telegram before it is moved past, and said as undelivered. */
export const B20_SKIP_AFTER_RUNS = 3

/**
 * The cursor file: { ok, state, legacy }. A missing file is { ok: true, state: null }. The file the deployed release
 * before this one kept here, `{ tokens, told }` (a baseline and the ids it told), is { ok: true, state: null, legacy:
 * true }: its outbox did not exist, so everything the new outbox holds is still to be told. Anything else without a valid
 * cursor, or a file that cannot be read or parsed, is { ok: false }, and stops the run with a health alert.
 */
export function readB20State (file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { return e && e.code === 'ENOENT' ? { ok: true, state: null } : { ok: false } }
  let j
  try { j = JSON.parse(raw) } catch (_) { return { ok: false } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false }
  if (Number.isInteger(j.cursor) && j.cursor >= 0) return { ok: true, state: j }
  const legacy = !('cursor' in j) && Object.keys(j).length > 0 && Object.keys(j).every((k) => k === 'tokens' || k === 'told') && (j.tokens == null || (typeof j.tokens === 'object' && !Array.isArray(j.tokens))) && (j.told == null || Array.isArray(j.told))
  return legacy ? { ok: true, state: null, legacy: true } : { ok: false }
}
/** Write the cursor file, atomically: true when it landed. */
export function writeB20State (file, state) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file); return true } catch (_) { return false }
}
/** One event as a line of the message: its stable id first, then what changed. */
export const b20EventLine = (e) => `[${e.id}] ` + changeText({ symbol: typeof e.symbol === 'string' ? e.symbol.slice(0, 16) : null, token: e.token, block: e.block }, [e]).replace(/ The issuer's own rule, not a verdict change\.$/, '')

/**
 * The B20 changes the site's outbox holds (docs/b20-transfers-tz.md §5), told to the owner exactly as promised: read with
 * a resumable cursor (`fetchEvents(after)` gives { events, oldest, last }, `last` the outbox's high-water mark), a burst
 * batched into few messages, each line with its event's stable id. An event counts as told only when Telegram took the
 * message (HTTP 200, ok and a message id); a short 429 retry_after is waited for. The cursor is saved after each
 * message, and a save that fails stops the run. A batch Telegram keeps refusing is tried again for B20_SKIP_AFTER_RUNS
 * runs, then moved past and said as undelivered, so it never blocks the ones after it. A missing cursor file is a first
 * run, which tells every event the site still holds; the release before this one's file (no cursor) starts the cursor at
 * the outbox's high-water mark, telling nothing twice; a file that cannot be read stops and is a health alert. Events
 * the site no longer holds, gaps inside the outbox, and an outbox that was reset are said, never skipped in silence.
 * Every fetch and send is held to the run's budget. At-least-once: a message Telegram took whose answer was lost is
 * sent again, with the same ids.
 * @returns {Promise<{ sent: string[], checks: object[] }>}
 */
export async function sendB20Events ({ fetchEvents, file, send = (text) => sendTelegram(text, { env: process.env }), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => Date.now(), budgetMs = B20_RUN_BUDGET_MS, write = writeB20State }) {
  const st = readB20State(file)
  const stateCheck = (bad, text) => ({ key: 'b20:state', bad, text })
  if (!st.ok) return { sent: [], checks: [stateCheck(true, 'The B20 alert cursor file cannot be read, so B20 changes are not being told. Fix or remove it (removing it tells again every change the site still holds).')] }
  const start = clock()
  const left = () => budgetMs - (clock() - start)
  const within = (p) => { let tm; return Promise.race([p, new Promise((r) => { tm = setTimeout(() => r(TIMEOUT), Math.max(0, left())) })]).finally(() => clearTimeout(tm)) }
  const TIMEOUT = Symbol('timeout')
  const sent = [], checks = []
  // The deployed release before this one kept a baseline here, and had no outbox: the outbox is new, so everything it
  // holds is still to be told. The cursor starts at 0, like a first run.
  let cursor = st.state ? st.state.cursor : 0
  let epoch = st.state && typeof st.state.epoch === 'string' ? st.state.epoch : null
  let fail = st.state && st.state.fail && Number.isInteger(st.state.fail.first) ? st.state.fail : null
  const save = (extra = {}) => write(file, { cursor, ...(epoch ? { epoch } : {}), ...(fail ? { fail } : {}), ...extra })
  let first = true
  for (;;) {
    if (left() <= 0) break
    let page
    try { page = await within(fetchEvents(cursor)) } catch (_) { break }
    if (page === TIMEOUT || !page || !Array.isArray(page.events)) break
    const lines = []
    // The outbox was reset: another epoch than the one our cursor counts in, or a high-water mark below our cursor.
    // Said, and read from its new start.
    const otherEpoch = first && typeof page.epoch === 'string' && epoch && page.epoch !== epoch
    if (first && typeof page.epoch === 'string' && !epoch) epoch = page.epoch
    if (otherEpoch || (first && Number.isInteger(page.last) && page.last < cursor)) {
      lines.push(`B20: the site's outbox was reset (a new outbox${Number.isInteger(page.last) ? ', its last change ' + page.last : ''}, ours was ${cursor}); its changes are told from the start.`)
      epoch = typeof page.epoch === 'string' ? page.epoch : epoch
      cursor = 0
      try { page = await within(fetchEvents(0)) } catch (_) { break }
      if (page === TIMEOUT || !page || !Array.isArray(page.events)) break
    }
    first = false
    const batch = []
    let prev = cursor
    for (const e of page.events) {
      if (!e || !Number.isInteger(e.seq) || e.seq <= prev || typeof e.id !== 'string') continue
      const line = b20EventLine(e)
      const gap = e.seq > prev + 1 ? `B20: changes ${prev + 1} to ${e.seq - 1} are not in the site's outbox; they were dropped before they were told (its journal, [b20] lines, holds them).` : null
      if (batch.length >= B20_BATCH_EVENTS || lines.join('\n').length + line.length + (gap ? gap.length : 0) > B20_MESSAGE_CHARS) break
      if (gap) lines.push(gap)
      batch.push(e); lines.push(line); prev = e.seq
    }
    // Everything after our cursor is gone from the outbox (only its high-water mark is left): said, and moved past.
    let skipTo = batch.length ? batch[batch.length - 1].seq : cursor
    if (!batch.length && Number.isInteger(page.last) && page.last > cursor && !page.events.some((e) => e && e.seq > cursor)) {
      lines.push(`B20: changes ${cursor + 1} to ${page.last} are not in the site's outbox; they were dropped before they were told.`)
      skipTo = page.last
    }
    if (!lines.length) break
    const text = `Proof of Stock: B20 transfer rules changed on Base (the issuer's own rules, not a verdict change):\n` + lines.join('\n')
    let r = await within(send(text))
    if (r !== TIMEOUT && !r.ok && Number.isFinite(r.retryAfterS) && r.retryAfterS <= B20_RETRY_WAIT_MAX_S && left() > r.retryAfterS * 1000) { await sleep(r.retryAfterS * 1000); r = await within(send(text)) }
    if (r === TIMEOUT || !r.ok) {
      // Not taken. Counted per batch across runs. Past B20_SKIP_AFTER_RUNS it is moved past only when Telegram is shown
      // to work: a short loss notice naming its ids is sent, and only if that one is taken is the batch moved past. In
      // an outage (the notice fails too) everything stays pending.
      const head = batch.length ? batch[0].seq : skipTo
      fail = fail && fail.first === head ? { first: head, runs: fail.runs + 1 } : { first: head, runs: 1 }
      if (fail.runs < B20_SKIP_AFTER_RUNS) { save(); break }
      const notice = `B20: ${batch.length} change(s) could not be delivered after ${fail.runs} runs and were moved past so the ones after them are told: ${batch.map((e) => e.id).join(', ').slice(0, 900)}. The site's journal ([b20] lines) holds them.`
      const n = await within(send('Proof of Stock: ' + notice))
      if (n === TIMEOUT || !n.ok) { save(); break }
      checks.push({ key: `b20:undelivered:${head}`, bad: true, text: notice })
      fail = null
    }
    if (!save({ cursor: skipTo, fail: undefined })) { checks.push(stateCheck(true, 'The B20 alert cursor file cannot be written; the last message was sent and may be sent again. B20 alerts are stopped until it is fixed.')); return { sent: [...sent, ...(r !== TIMEOUT && r.ok ? batch.map((e) => e.id) : [])], checks } }
    if (r !== TIMEOUT && r.ok) sent.push(...batch.map((e) => e.id))
    cursor = skipTo
    fail = null
  }
  checks.push(stateCheck(false, 'The B20 alert cursor file is readable and written again.'))
  return { sent, checks }
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

// What lives outside the repository (owner, 27.11): the guard on npm, the server on the official MCP registry, and a
// release cut at all. Each went stale silently, because every merge is deployed but publishing is the owner's own step
// (deployment/PUBLISHING.md) and no test looks outside the repository. These compare the deployed release's own files
// (this script's release, /opt/stp/current on the host) with what the registries say now.
export const STALE_PUBLISH_DAYS = 3
export const STALE_RELEASE_DAYS = 7
export const NPM_GUARD_URL = 'https://registry.npmjs.org/@proofofstock%2fguard/latest'
/** The official MCP registry's latest version of a server, by its name: `{ server: { name, version }, _meta }`. */
export const mcpRegistryUrl = (name) => `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(name)}/versions/latest`
/** Where the first-seen times live: a key of their own in the alert state file (scripts/lib/alert.mjs). */
export const STALE_SINCE_KEY = 'stale-since'
const RELEASE_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
/** a < b for two plain x.y.z versions; null when either is not one (a pre-release is not compared). */
export function versionBelow (a, b) {
  const x = SEMVER.exec(String(a ?? '')), y = SEMVER.exec(String(b ?? ''))
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i])
  return false
}

/**
 * The changelog's state: how many entries `[Unreleased]` holds (lines that start with "- " before the next "## "), and
 * the newest dated release, `## [x.y.z] - YYYY-MM-DD`. Null fields when the file does not say.
 */
export function changelogState (text) {
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l))
  let entries = 0
  if (at >= 0) for (let i = at + 1; i < lines.length && !/^## /.test(lines[i]); i++) if (/^- /.test(lines[i])) entries++
  const dates = lines.map((l) => (/^## \[\d+\.\d+\.\d+\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(l) || [])[1]).filter(Boolean).sort()
  return { unreleased: at >= 0 ? entries : null, newest: dates.length ? dates[dates.length - 1] : null }
}

/** The release's own versions and changelog, read from its files. A file that cannot be read gives null, never a throw. */
export function releaseState (root = RELEASE_ROOT) {
  const json = (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')) } catch (_) { return null } }
  let changelog = null
  try { changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') } catch (_) { /* said below */ }
  const server = json('server.json')
  return { guard: json('packages/proofofstock-guard/package.json')?.version ?? null, server: server?.version ?? null, serverName: server?.name ?? null, changelog: changelog == null ? null : changelogState(changelog) }
}

/**
 * The latest published versions, each `{ version }` or `{ error }`. A registry that does not answer, or answers in a
 * shape this code does not know, is an error here: unknown, never "behind".
 */
export async function readPublished ({ serverName, fetchImpl = fetch } = {}) {
  const get = async (url, pick) => {
    try {
      const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) return { error: `HTTP ${r.status}` }
      const v = pick(await r.json())
      return SEMVER.test(String(v ?? '')) ? { version: v } : { error: 'no version in the answer' }
    } catch (e) { return { error: String((e && e.name) || e).slice(0, 60) } }
  }
  const npm = await get(NPM_GUARD_URL, (j) => j && j.name === '@proofofstock/guard' ? j.version : null)
  const mcp = serverName ? await get(mcpRegistryUrl(serverName), (j) => j && j.server && j.server.name === serverName ? j.server.version : null) : { error: 'server.json names no server' }
  return { npm, mcp }
}

/**
 * The three staleness checks. `since` is the first-seen time of each condition, as kept; the new one is returned.
 *   stale:npm-guard    npm's latest @proofofstock/guard below the release's packages/proofofstock-guard for > 3 days
 *   stale:mcp-registry the MCP registry's latest version below the release's server.json for > 3 days
 *   stale:release      [Unreleased] has entries and the newest dated release is > 7 days old
 * A registry that could not be read gives no check (no alert, no clear) and keeps its first-seen time; `notes` says so,
 * for the journal. A condition that clears drops its first-seen time.
 * @returns {{ checks: { key: string, bad: boolean, text: string }[], since: object, notes: string[] }}
 */
export function staleChecks ({ release, published, since = {}, now, publishDays = STALE_PUBLISH_DAYS, releaseDays = STALE_RELEASE_DAYS }) {
  const checks = [], notes = [], next = {}
  const days = (ms) => Math.floor(ms / 864e5)
  const behind = (key, what, mine, got, where) => {
    if (!got || got.error) { notes.push(`${key}: ${where} could not be read (${got ? got.error : 'not asked'}); not compared this run`); if (Number.isFinite(since[key])) next[key] = since[key]; return }
    const below = versionBelow(got.version, mine)
    if (below == null) { notes.push(`${key}: cannot compare ${where}'s ${got.version} with the release's ${mine}`); if (Number.isFinite(since[key])) next[key] = since[key]; return }
    if (!below) { checks.push({ key, bad: false, text: `${what} on ${where} has caught up with the release (${got.version}).` }); return }
    const first = Number.isFinite(since[key]) ? since[key] : now
    next[key] = first
    // Within the grace the condition is neither an alert nor a clear: a lost first-seen time must never send RESOLVED
    // for something still behind.
    if (!(now - first > publishDays * 864e5)) { notes.push(`${key}: ${where} is behind the release, for less than ${publishDays} days`); return }
    checks.push({ key, bad: true, text: `${what} on ${where} is ${got.version}, below the release's ${mine}, for ${days(now - first)} days. Publishing it is the owner's step (deployment/PUBLISHING.md).` })
  }
  if (release.guard) behind('stale:npm-guard', '@proofofstock/guard', release.guard, published.npm, 'npm')
  else notes.push('stale:npm-guard: the release has no readable packages/proofofstock-guard/package.json')
  if (release.server) behind('stale:mcp-registry', 'The MCP server', release.server, published.mcp, 'the official MCP registry')
  else notes.push('stale:mcp-registry: the release has no readable server.json')
  const cl = release.changelog
  if (cl && cl.unreleased != null) {
    // By UTC days: a release dated the 20th is 7 days old on the 27th, all day, and stale from the 28th.
    const ageDays = cl.newest ? days(now - Date.parse(cl.newest + 'T00:00:00Z')) : Infinity
    const old = cl.unreleased > 0 && ageDays > releaseDays
    checks.push({ key: 'stale:release', bad: old, text: old
      ? `CHANGELOG.md holds ${cl.unreleased} unreleased entries and the newest release${cl.newest ? ` is from ${cl.newest}, ${ageDays} days ago` : ' has no date'}. Cut a release (CHANGELOG.md, package.json, server.json).`
      : 'a release is cut again: nothing waits in [Unreleased] past a week.' })
  } else notes.push('stale:release: the release has no readable CHANGELOG.md with an [Unreleased] section')
  return { checks, since: next, notes }
}

/** The first-seen times, kept under their own key in the alert state file; never throws. */
export function readStaleSince (file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8'))[STALE_SINCE_KEY]; return s && typeof s === 'object' ? s : {} } catch (_) { return {} }
}
export function writeStaleSince (file, since) {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch (_) { /* a new file */ }
  s[STALE_SINCE_KEY] = since
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, file) } catch (_) { /* tried again next run */ }
}

/** One run of the three: read the release, ask the two registries, keep the first-seen times. Never throws. */
export async function outsideChecks ({ now, env = process.env, fetchImpl = fetch, root = RELEASE_ROOT, log = (m) => console.log(m) } = {}) {
  const file = env.STP_ALERT_STATE || '/var/lib/stp-alerts/state.json'
  const release = releaseState(root)
  const published = await readPublished({ serverName: release.serverName, fetchImpl })
  const { checks, since, notes } = staleChecks({ release, published, since: readStaleSince(file), now })
  writeStaleSince(file, since)
  for (const n of notes) log('[stp-health] ' + n)
  return checks
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
  checks.push(...await outsideChecks({ now }))
  let payments = null
  try { const r = await fetch(site + '/api/status/payments', { signal: AbortSignal.timeout(10_000) }); if (r.ok) payments = await r.json() } catch (_) { /* the site check above already says the site is down */ }
  if (payments && payments.enabled) {
    let balanceWei = null, balanceError = null
    if (/^0x[0-9a-fA-F]{40}$/.test(payments.settlement_wallet || '')) { try { balanceWei = await baseBalance(payments.settlement_wallet) } catch (e) { balanceError = String(e && e.message || e) } }
    checks.push(...paymentChecks({ payments, balanceWei, balanceError, now }))
  }
  const sent = []
  for (const ch of checks) sent.push([ch.key, await alert({ key: ch.key, text: ch.text, ok: !ch.bad })])
  // The B20 outbox: its events after our cursor, read page by page from the site (docs/b20-transfers-tz.md §5).
  const b20 = await sendB20Events({ file: b20SentFile(), fetchEvents: async (after) => { const r = await fetch(site + '/api/status/b20/events?after=' + after, { signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error('b20 events'); return r.json() } })
  for (const id of b20.sent) sent.push(['b20:' + id, 'sent'])
  for (const ch of b20.checks) sent.push([ch.key, await alert({ key: ch.key, text: ch.text, ok: !ch.bad })])
  const bad = checks.filter((c) => c.bad).map((c) => c.key)
  console.log('[stp-health] ' + JSON.stringify({ bad, sent: sent.filter(([, s]) => s === 'sent').map(([k]) => k) }))
}
