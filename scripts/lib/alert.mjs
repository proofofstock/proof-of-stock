// scripts/lib/alert.mjs: tell the owner when something is wrong, in a Telegram message. Until now an ALARM went to the
// journal only, where nobody reads it (owner, 12.11).
//
// Configuration, from the environment (on the host: /etc/stp/alert.env, mode 0600, written by the owner; never in git):
//   STP_ALERT_TELEGRAM_TOKEN    the bot's token, from @BotFather
//   STP_ALERT_TELEGRAM_CHAT     the owner's chat id (the bot must have been sent /start once)
//   STP_ALERT_STATE             where the last-sent times are kept (default /var/lib/stp-alerts/state.json)
// Without a token and a chat the alert goes to stderr only, and nothing fails.
//
// ⚠ NEVER THROWS, NEVER BLOCKS LONG. An alert that cannot be sent is written to stderr; the job that raised it goes on.
// ⚠ NO SPAM. The same `key` is sent at most once per `everyMs` (default an hour); a cleared condition is sent once as
//   resolved, so a flapping check does not page twice an hour. The token is never logged.
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STATE = '/var/lib/stp-alerts/state.json'
const HOUR = 3600e3

function readState (file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return {} } }
function writeState (file, s) {
  // A temporary file of this writer's own: two writers never share one.
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, file) } catch (_) {}
}
/** A lock older than this is taken as left by a process that died. */
export const LOCK_STALE_MS = 30_000
/** How long a writer waits for the lock before it writes anyway (an alert is never held back by a stuck lock). */
export const LOCK_WAIT_MS = 5_000
/**
 * `fn()` with `<file>.lock` held: a file created exclusively (O_EXCL), the same on every host process, so stp-health and
 * the systemd failure notifier never interleave a read-modify-write of the shared state. A lock older than
 * LOCK_STALE_MS is broken. Returns fn's result.
 */
export async function withStateLock (file, fn, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const lock = file + '.lock'
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }) } catch (_) {}
  const start = Date.now()
  let held = false
  while (!held) {
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); held = true } catch (e) {
      if (!e || e.code !== 'EEXIST') break
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue } } catch (_) { continue }
      if (Date.now() - start > LOCK_WAIT_MS) break
      await sleep(10)
    }
  }
  try { return fn() } finally { if (held) { try { fs.unlinkSync(lock) } catch (_) {} } }
}

/**
 * @param {object} a
 * @param {string} a.key       what the alert is about, stable across runs (e.g. "registry:base:unreadable")
 * @param {string} a.text      one or two plain sentences for the owner
 * @param {boolean} [a.ok]     true: the condition has cleared (sent once if an alert for `key` was sent before)
 * @returns {Promise<'sent'|'suppressed'|'logged'|'failed'|'none'>}
 */
export async function alert ({ key, text, ok = false }, { env = process.env, fetchImpl = globalThis.fetch, now = Date.now, everyMs = HOUR, log = (m) => process.stderr.write(m + '\n') } = {}) {
  const file = env.STP_ALERT_STATE || DEFAULT_STATE
  const state = readState(file)
  const last = state[key]
  if (ok) {
    if (!last || last.resolved) return 'none'
  } else if (last && !last.resolved && now() - last.at < everyMs) return 'suppressed'
  // The throttle and the resolution are recorded only once the message is out (or, with no bot, once it is in the
  // journal): an alert that failed to reach Telegram is tried again next run, never taken as said.
  // Read again under the lock and change this key only: another writer's newer entry for another key (or this one) is
  // never overwritten with a stale copy.
  const record = () => withStateLock(file, () => { const fresh = readState(file); fresh[key] = { at: now(), resolved: Boolean(ok) }; writeState(file, fresh) })
  const body = (ok ? 'RESOLVED ' : 'ALERT ') + text
  const token = env.STP_ALERT_TELEGRAM_TOKEN, chat = env.STP_ALERT_TELEGRAM_CHAT
  if (!token || !chat || typeof fetchImpl !== 'function') { log(`[alert] ${key}: ${body}`); await record(); return 'logged' }
  const r = await sendTelegram(`Proof of Stock: ${body}`, { env, fetchImpl })
  if (r.ok) { await record(); return 'sent' }
  log(`[alert] ${key}: telegram ${r.why}${r.retryAfterS ? ' (retry after ' + r.retryAfterS + ' s)' : ''}; ${body}`)
  return 'failed'
}

/**
 * One Telegram message: { ok, messageId, retryAfterS, why }. Delivered only on HTTP 200 with `ok: true` and a
 * message_id in the answer; a 429 carries Telegram's retry_after. Never throws; the token is never in `why`.
 */
export async function sendTelegram (text, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const token = env.STP_ALERT_TELEGRAM_TOKEN, chat = env.STP_ALERT_TELEGRAM_CHAT
  if (!token || !chat || typeof fetchImpl !== 'function') return { ok: false, why: 'not_configured' }
  let r
  try {
    r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) { return { ok: false, why: 'unreachable (' + String(e && e.name || 'error') + ')' } }
  let j = null
  try { j = await r.json() } catch (_) { /* no body */ }
  const retry = j && j.parameters && Number.isFinite(Number(j.parameters.retry_after)) ? Number(j.parameters.retry_after) : null
  if (r.status === 200 && j && j.ok === true && j.result && Number.isInteger(j.result.message_id)) return { ok: true, messageId: j.result.message_id }
  return { ok: false, why: 'answered ' + r.status + (j && j.ok === false ? ' not ok' : ''), retryAfterS: r.status === 429 ? retry : null }
}
