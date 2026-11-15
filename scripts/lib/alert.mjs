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
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, file) } catch (_) {}
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
    state[key] = { at: now(), resolved: true }
  } else {
    if (last && !last.resolved && now() - last.at < everyMs) return 'suppressed'
    state[key] = { at: now(), resolved: false }
  }
  writeState(file, state)
  const body = (ok ? 'RESOLVED ' : 'ALERT ') + text
  const token = env.STP_ALERT_TELEGRAM_TOKEN, chat = env.STP_ALERT_TELEGRAM_CHAT
  if (!token || !chat || typeof fetchImpl !== 'function') { log(`[alert] ${key}: ${body}`); return 'logged' }
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `Proof of Stock: ${body}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) { log(`[alert] ${key}: telegram answered ${r.status}; ${body}`); return 'failed' }
    return 'sent'
  } catch (e) {
    log(`[alert] ${key}: telegram unreachable (${String(e && e.name || 'error')}); ${body}`)
    return 'failed'
  }
}
