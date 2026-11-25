// deployment/cloudflare/killswitch/worker.mjs: the kill switch as a Cloudflare Worker (owner, 25.11). The decision is
// logic.mjs; this file only wires it to Cloudflare:
//   - scheduled (cron, every minute): read the stored state, observe, decide, write only what changed, alert;
//   - fetch (routes on the verdict paths of every host that serves them, wrangler.toml.example): while tripped, answer
//     503; otherwise pass the request on unchanged.
//
// Bindings (set by the owner in Cloudflare, never in this repository):
//   POS_KS            a KV namespace: "trip" (written once, when it trips) and "state" (the decision's memory)
//   TG_TOKEN, TG_CHAT optional secrets: a Telegram bot and chat for the alerts
//
// ⚠ THE TRIP IS ITS OWN KEY, WRITTEN ONCE AND NEVER BY A LATER RUN. A run that read an old "state" (KV is eventually
// consistent) or none at all can no longer write tripped:false over a trip (outside review, 25.11). Only the owner
// clears it (deployment/KILLSWITCH.md).
// ⚠ A STORE THAT COULD NOT BE READ IS NOT AN EMPTY ONE. A run whose read of "trip" or "state" failed writes nothing and
// alerts. A missing key is a fresh start; a failed read is no run.
// ⚠ NO BYPASS. There is no header, cookie or query that lets a request past a tripped switch: anything a request can
// carry, an attacker can send. The path is matched as the origin will see it (normalizePath).
// ⚠ FAILS OPEN ON ITS OWN FAULT, CLOSED ON OURS. If the trip key cannot be read when a request comes, the request passes
// as if the switch were not there: a broken switch must not take the site down. A trip that was read is always obeyed.

import { observe, decide, isBlocked, suspended } from './logic.mjs'

/** A KV read that tells a missing key ({ ok: true, value: null }) from a failed read ({ ok: false }). */
export async function readKey (env, key, cacheTtl = 30) {
  try { const v = await env.POS_KS.get(key, { type: 'json', cacheTtl }); return { ok: true, value: v && typeof v === 'object' ? v : null } } catch (_) { return { ok: false, value: null } }
}

async function alert (env, fetchImpl, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return
  try { await fetchImpl(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TG_CHAT, text }) }) } catch (_) { /* best effort */ }
}

export async function runOnce (env, { fetchImpl = globalThis.fetch, now = () => Date.now(), random = Math.random } = {}) {
  const [trip, prev] = await Promise.all([readKey(env, 'trip', 60), readKey(env, 'state', 60)])
  if (!trip.ok || !prev.ok) {
    await alert(env, fetchImpl, 'Proof of Stock kill switch: its store could not be read, so this run checked nothing and wrote nothing.')
    return { skipped: 'store unreadable' }
  }
  const obs = await observe({ fetchImpl, random })
  const r = decide(prev.value, obs, now(), undefined, { tripped: Boolean(trip.value) })
  // The trip first, once: if writing the state fails after it, the trip still stands.
  if (r.trip && !trip.value) await env.POS_KS.put('trip', JSON.stringify(r.trip))
  if (r.persist) await env.POS_KS.put('state', JSON.stringify(r.state))
  for (const line of r.alerts) await alert(env, fetchImpl, line)
  return r
}

export async function handle (request, env, { fetchImpl = globalThis.fetch } = {}) {
  if (isBlocked(new URL(request.url).pathname)) {
    const t = await readKey(env, 'trip', 30)
    if (t.ok && t.value) { const r = suspended(t.value); return new Response(r.body, { status: r.status, headers: r.headers }) }
  }
  return fetchImpl(request)
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(runOnce(env).catch((e) => alert(env, globalThis.fetch, `Proof of Stock kill switch: a run failed (${String(e && e.message || e).slice(0, 200)}). It checks nothing until this is fixed.`)))
  },
}
