// deployment/cloudflare/killswitch/killswitch.test.mjs: the kill switch (logic.mjs, worker.mjs) on synthetic lists.
// It must trip on an address we call listed that the issuer does not list, on a missing Base prefix, on a list that
// does not hash to its own proof and on the known look-alike answered as listed; and it must NOT trip on an ordinary
// listing day, on the issuer's API being down, or on our own server being down. After outside review (25.11): a store
// it could not read is no run, an old state can never clear a trip, strikes are per chain and only a clean comparison
// clears them, the probe is drawn from the issuer's own list, a long silence on our side alerts, it writes little,
// odd spellings of a blocked path are blocked, a listing we saw first is given its grace, a stale list is unknown,
// Coinbase is read page by page, and the other hosts that serve /mcp are routed through it.
//
// Run: node deployment/cloudflare/killswitch/killswitch.test.mjs
import fs from 'node:fs'
import { observe, decide, addressesSha256, isBlocked, normalizePath, suspended, readIssuer, CONFIG, GRACE_MS, WARMUP_MS, STRIKES_TO_TRIP, UNKNOWN_ALERT_MS, PERSIST_EVERY_MS, USER_AGENT } from './logic.mjs'
import { runOnce, handle, readKey } from './worker.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const B = (n) => CONFIG.chains.base.prefix + n.toString(16).padStart(18, '0')
const R = (n) => '0x' + n.toString(16).padStart(40, '0')
const PROBE_B = CONFIG.chains.base.probe, PROBE_R = CONFIG.chains.robinhood.probe, FAKE = CONFIG.chains.base.knownFake
const SITE = CONFIG.site
const res = (status, body) => ({ status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })

// A world: the issuers' lists and ours, each changeable per test.
async function world ({ coinbase = [PROBE_B, B(1), B(2)], robinhood = [PROBE_R, R(1)], oursBase = null, oursRh = null, fakeListed = false, down = {}, badHash = false, stale = false, liesTo = null, pages = 1 } = {}) {
  const ob = oursBase || coinbase, or = oursRh || robinhood
  const shaB = badHash ? 'f'.repeat(64) : await addressesSha256(ob), shaR = await addressesSha256(or)
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ url: String(url), ua: init.headers && init.headers['user-agent'] })
    if (u.host === 'api.coinbase.com') {
      if (down.coinbase) return down.coinbase === 'throw' ? Promise.reject(new Error('timeout')) : res(down.coinbase, {})
      const page = Number(u.searchParams.get('page_token') || 0), per = Math.ceil(coinbase.length / pages)
      const slice = coinbase.slice(page * per, (page + 1) * per)
      return res(200, { tokens: slice.map((a) => ({ contract_address: a.toUpperCase().replace('0X', '0x') })), ...(page + 1 < pages ? { next_page_token: String(page + 1) } : {}) })
    }
    if (u.host === 'api.robinhood.com') return down.robinhood ? res(down.robinhood, {}) : res(200, { assets: robinhood.map((a) => ({ deployments: [{ chainId: 4663, contractAddress: a }] })) })
    if (u.origin === SITE && u.pathname === '/verify') {
      if (down.ours) return res(down.ours, {})
      const chain = u.searchParams.get('chain'), a = u.searchParams.get('address')
      if (a === FAKE) return res(200, { listed: fakeListed, address: a })
      // A server hiding from the switch: it answers the fixed probe as "not listed" so nothing is compared.
      if (liesTo && liesTo(a)) return res(200, { listed: false, address: a })
      const sha = chain === 'base' ? shaB : shaR
      return res(200, { listed: true, address: a, list_proof: { stale, addresses_sha256: sha, addresses_url: `${SITE}/api/list/${'a'.repeat(63)}${chain === 'base' ? 'b' : 'c'}/addresses` } })
    }
    if (u.origin === SITE && u.pathname.endsWith('b/addresses')) return res(200, ob.map((a) => a + '\n').join(''))
    if (u.origin === SITE && u.pathname.endsWith('c/addresses')) return res(200, or.map((a) => a + '\n').join(''))
    return res(404, {})
  }
  return { fetchImpl, calls }
}
const T0 = Date.parse('2026-11-25T12:00:00Z'), MIN = 60e3
// A state that has run long enough to trip, with the issuers' and our lists seen long ago.
const warmed = (seenBase = [PROBE_B, B(1), B(2)], at = T0 - MIN) => ({ strikes: {}, first_run_at: T0 - WARMUP_MS - 10 * MIN, seen: { base: Object.fromEntries(seenBase.map((a) => [a, at])), robinhood: {} }, ours_seen: { base: Object.fromEntries([...seenBase, B(0xbad), B(9)].map((a) => [a, T0 - 2 * GRACE_MS])), robinhood: {} }, written_at: T0 - MIN })
async function runs (prev, w, times, opts = {}) {
  let s = prev, tripped = false, out = []
  for (const t of times) { const r = decide(s, await observe({ fetchImpl: w.fetchImpl, random: opts.random }), t, undefined, { tripped }); s = r.state; tripped = tripped || Boolean(r.trip); out.push(r) }
  return out
}

console.log('the rule, fixed before it ran')
check('two strikes trip; a delisting has 20 minutes of grace; no trip in the first 20 minutes', STRIKES_TO_TRIP === 2 && GRACE_MS === 20 * MIN && WARMUP_MS === GRACE_MS)
check('Base is checked by the pinned prefix (the guard\'s); Robinhood has none', CONFIG.chains.base.prefix === '0xb2' + '0'.repeat(20) && CONFIG.chains.robinhood.prefix === null)

console.log('trips on what would let an agent buy a fake')
{
  const FOREIGN = B(0xbad)
  let w = await world({ oursBase: [PROBE_B, B(1), B(2), FOREIGN] })
  let [a, b] = await runs(warmed(), w, [T0, T0 + MIN])
  check('an address we call listed and the issuer never listed: strike, then trip', !a.trip && a.state.strikes.base === 1 && b.trip && b.state.last_problems.some((x) => x.kind === 'not_on_issuer_list' && x.address === FOREIGN))
  check('...with an alert that names it and how to clear', b.alerts.some((l) => /TRIPPED/.test(l) && l.includes(FOREIGN) && /KILLSWITCH\.md/.test(l)))
  w = await world({ coinbase: [PROBE_B, B(1), R(0x77)], oursBase: [PROBE_B, B(1), R(0x77)] })
  ;[a, b] = await runs(warmed(), w, [T0, T0 + MIN])
  check('a Base address without the issuer prefix trips, even when the issuer\'s API lists it too', b.trip && b.state.last_problems.some((x) => x.kind === 'prefix'))
  ;[a, b] = await runs(warmed(), await world({ badHash: true }), [T0, T0 + MIN])
  check('our list not hashing to the list_proof that names it trips', b.trip && b.state.last_problems.some((x) => x.kind === 'proof_mismatch'))
  ;[a, b] = await runs(warmed(), await world({ fakeListed: true }), [T0, T0 + MIN])
  check('the known look-alike answered as listed trips', b.trip && b.state.last_problems.some((x) => x.kind === 'known_fake_listed'))
}

console.log('does NOT trip on an ordinary day')
{
  let w = await world({ coinbase: [PROBE_B, B(1), B(2), B(3)], oursBase: [PROBE_B, B(1), B(2)] })
  let out = await runs(warmed(), w, [T0, T0 + MIN, T0 + 2 * MIN])
  check('the issuer lists a token we do not have yet: never a problem', out.every((r) => !r.trip && r.state.strikes.base === 0))
  w = await world({ coinbase: [PROBE_B, B(1)], oursBase: [PROBE_B, B(1), B(2)] })
  out = await runs(warmed([PROBE_B, B(1), B(2)], T0 - MIN), w, [T0, T0 + MIN, T0 + 15 * MIN])
  check('the issuer delists a token we still list: tolerated for the grace window', out.every((r) => !r.trip && r.state.strikes.base === 0))
  out = await runs(out[2].state, w, [T0 + GRACE_MS + 2 * MIN, T0 + GRACE_MS + 3 * MIN])
  check('...but past it, a problem like any other', out[1].trip !== null)
  // A listing our server sees before the switch's read of the issuer does: new on OUR list, given the grace too.
  const NEWB = B(0x4e)
  w = await world({ coinbase: [PROBE_B, B(1), B(2)], oursBase: [PROBE_B, B(1), B(2), NEWB] })
  out = await runs(warmed(), w, [T0, T0 + MIN, T0 + 5 * MIN])
  check('a listing new on our list (the issuer\'s API not showing it to us yet): no strike within the grace window', out.every((r) => !r.trip && r.state.strikes.base === 0) && out[0].state.ours_seen.base[NEWB] === T0)
  for (const [label, d] of [['503', { coinbase: 503, robinhood: 503 }], ['429', { coinbase: 429, robinhood: 429 }], ['a timeout', { coinbase: 'throw', robinhood: 503 }]]) {
    w = await world({ oursBase: [PROBE_B, B(1), B(2), B(9)], down: d })
    out = await runs(warmed([PROBE_B, B(1), B(2)], T0 - 2 * GRACE_MS), w, [T0, T0 + MIN, T0 + 2 * MIN])
    check(`the issuer answering ${label}: "unknown", never a mismatch, so no strike`, out.every((r) => !r.trip && !r.state.strikes.base) && out[0].state.last_unknown.some((x) => /issuer/.test(x)))
  }
  w = await world({ stale: true, oursBase: [PROBE_B, B(1), B(2), B(0xbad)] })
  out = await runs(warmed(), w, [T0, T0 + MIN])
  check('our server saying its own list is stale: that chain is unknown, not compared', out.every((r) => !r.trip) && out[0].state.last_unknown.some((x) => /stale/.test(x)))
  out = await runs({ ...warmed(), strikes: { base: 1 } }, await world({ down: { ours: 502 } }), [T0, T0 + MIN])
  check('our server down: no strike, and a pending strike is neither added to nor cleared', out.every((r) => !r.trip && r.state.strikes.base === 1))
  const fresh = { strikes: {}, seen: {}, ours_seen: warmed().ours_seen }
  const fw = await world({ oursBase: [PROBE_B, B(1), B(2), B(0xbad)] })
  out = await runs(fresh, fw, [T0, T0 + MIN, T0 + 2 * MIN])
  check('a fresh start: strikes counted, no trip during the warm-up', out.every((r) => !r.trip) && out[2].state.strikes.base === 3)
  out = await runs(out[2].state, fw, [T0 + WARMUP_MS + MIN])
  check('...and a trip once the warm-up is over', out[0].trip !== null)
}

console.log('a server that hides from the switch')
{
  const FOREIGN = B(0xbad)
  // It lies every other minute: a problem, then an answer that cannot be compared, then the problem again.
  const lying = await world({ oursBase: [PROBE_B, B(1), B(2), FOREIGN] })
  const hiding = await world({ oursBase: [PROBE_B, B(1), B(2), FOREIGN], liesTo: () => true })
  let s = warmed()
  let r = decide(s, await observe({ fetchImpl: lying.fetchImpl }), T0); s = r.state
  r = decide(s, await observe({ fetchImpl: hiding.fetchImpl }), T0 + MIN); s = r.state
  const r3 = decide(s, await observe({ fetchImpl: lying.fetchImpl }), T0 + 2 * MIN)
  check('strikes are per chain, and a run that did not compare does not clear them: lying every other minute still trips', r.state.strikes.base === 1 && r3.trip !== null)
  // The probe: drawn from the issuer's own list, not the fixed one, and the user-agent does not name the switch.
  const w = await world()
  await observe({ fetchImpl: w.fetchImpl, random: () => 0.99 })
  const probes = w.calls.filter((c) => c.url.startsWith(SITE + '/verify?chain=base')).map((c) => new URL(c.url).searchParams.get('address'))
  check('the probe is drawn from the issuer\'s own list', probes[0] === B(2) && probes[0] !== PROBE_B)
  check('...and no request names the switch', w.calls.every((c) => c.ua === USER_AGENT) && !/kill|switch|proofofstock/i.test(USER_AGENT))
  // A server answering every probe "not listed": nothing compared, so after UNKNOWN_ALERT_MS one alert, and no trip.
  const h = await world({ liesTo: () => true })
  let st = warmed(), alerts = []
  for (let i = 0; i <= 12; i++) { const x = decide(st, await observe({ fetchImpl: h.fetchImpl }), T0 + i * MIN); st = x.state; alerts.push(...x.alerts) }
  check('our side giving nothing to compare while the issuer answers: one alert per chain after 10 minutes, then quiet, no trip', alerts.length === 2 && alerts.some((l) => /no base list to compare/.test(l)) && alerts.some((l) => /no robinhood list/.test(l)) && !st.tripped && UNKNOWN_ALERT_MS === 10 * MIN, alerts.length)
}

console.log('it writes little')
{
  const w = await world()
  let s = warmed(), writes = 0
  for (let i = 0; i < 60; i++) { const r = decide(s, await observe({ fetchImpl: w.fetchImpl }), T0 + i * MIN); if (r.persist) writes++; s = r.state }
  check(`a quiet hour writes the state at most 10 times, not 60 (Workers KV free: 1,000 writes a day)`, writes > 0 && writes <= 10, `writes=${writes}`)
  check('...at least every 15 minutes, so the owner sees it is alive', PERSIST_EVERY_MS === 15 * MIN)
}

console.log('the worker')
{
  const store = new Map()
  const env = { POS_KS: { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null), put: async (k, v) => { store.set(k, v) } }, TG_TOKEN: 't', TG_CHAT: 'c' }
  const w = await world({ oursBase: [PROBE_B, B(1), B(2), B(0xbad)] })
  const sent = []
  const f = async (url, init) => { if (String(url).startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(init.body)); return res(200, {}) } return w.fetchImpl(url, init) }
  store.set('state', JSON.stringify(warmed()))
  await runOnce(env, { fetchImpl: f, now: () => T0 })
  await runOnce(env, { fetchImpl: f, now: () => T0 + MIN })
  const trip = JSON.parse(store.get('trip'))
  check('two runs: the trip is written once in its own key, with one alert', trip && trip.at === new Date(T0 + MIN).toISOString() && sent.filter((m) => /TRIPPED/.test(m.text)).length === 1)
  // KV eventual consistency: a later run reads the state from BEFORE the trip, and a clean world.
  store.set('state', JSON.stringify(warmed()))
  const clean = await world()
  await runOnce(env, { fetchImpl: async (u, i) => (String(u).startsWith('https://api.telegram.org/') ? res(200, {}) : clean.fetchImpl(u, i)), now: () => T0 + 2 * MIN })
  check('a run that read an old state cannot clear the trip: the trip key is never overwritten, and the state it writes says tripped', JSON.parse(store.get('trip')).at === trip.at && JSON.parse(store.get('state')).tripped === true)
  // A store that could not be read: no run, nothing written, an alert.
  const before = store.get('state')
  const broken = { ...env, POS_KS: { get: async (k) => { if (k === 'state') throw new Error('kv down'); return store.has(k) ? JSON.parse(store.get(k)) : null }, put: async (k, v) => { store.set(k, v) } } }
  const rr = await runOnce(broken, { fetchImpl: f, now: () => T0 + 3 * MIN })
  check('a failed read of the store is no run: nothing written, the trip stays, an alert goes out', rr.skipped && store.get('state') === before && store.has('trip') && sent.some((m) => /could not be read/.test(m.text)))
  check('readKey tells a missing key from a failed read', (await readKey({ POS_KS: { get: async () => null } }, 'x')).ok === true && (await readKey({ POS_KS: { get: async () => { throw new Error('x') } } }, 'x')).ok === false)
  const passed_ = []
  const origin = async (req) => { passed_.push(new URL(req.url).pathname); return new Response('ok', { status: 200 }) }
  const blocked = await handle(new Request(`${SITE}/verify?chain=base&address=${B(1)}`), env, { fetchImpl: origin })
  const page = await handle(new Request(`${SITE}/demo`), env, { fetchImpl: origin })
  check('tripped: /verify answers 503 and never reaches the origin; a page passes', blocked.status === 503 && page.status === 200 && passed_.join() === '/demo')
  for (const p of ['//verify', '/%76erify', '/./verify', '/demo/../verify', '/api//passport', '/%2Fverify', '//mcp']) {
    const x = await handle(new Request(`${SITE}${p}?chain=base`), env, { fetchImpl: origin })
    check(`...an odd spelling of a blocked path is blocked too: ${p}`, x.status === 503, String(x.status))
  }
  check('...normalizePath resolves them as nginx does', normalizePath('//verify') === '/verify' && normalizePath('/%76erify') === '/verify' && normalizePath('/a/../api/x') === '/api/x' && isBlocked('/mcp') && !isBlocked('/demo') && !isBlocked('/verifyx'))
  check('the agent test result pages and badges are blocked while tripped, its explainer is not', isBlocked('/agent-test/at_' + 'a'.repeat(32)) && isBlocked('/agent-test/at_' + 'a'.repeat(32) + '/badge.svg') && isBlocked('/api/agent-test') && !isBlocked('/agent-test'))
  // simulate_buy over HTTP has no route of its own here: /api/* covers it, GET and POST alike (docs/simulate-buy-tz.md).
  const simPost = await handle(new Request(`${SITE}/api/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env, { fetchImpl: origin })
  check('/api/simulate is blocked while tripped, GET and POST alike, under the /api/* route', isBlocked('/api/simulate') && simPost.status === 503 && fs.readFileSync(new URL('./wrangler.toml.example', import.meta.url), 'utf8').includes('pattern = "proofofstock.xyz/api/*"'), String(simPost.status))
  const bypass = await handle(new Request(`${SITE}/api/verify?x=1`, { headers: { 'x-killswitch-bypass': '1', cookie: 'admin=1' } }), env, { fetchImpl: origin })
  check('no header, cookie or query gets past it', bypass.status === 503)
  store.delete('trip')
  check('cleared (the trip key deleted): the request passes on unchanged', (await handle(new Request(`${SITE}/verify?chain=base`), env, { fetchImpl: origin })).status === 200)
  check('KV unreadable on a request: it passes (a broken switch must not take the site down)', (await handle(new Request(`${SITE}/verify`), { POS_KS: { get: async () => { throw new Error('kv down') } } }, { fetchImpl: origin })).status === 200)
  const r = suspended({ at: '2026-11-25T12:01:00.000Z' })
  check('503, no-store, a reason a person can read, and the time', r.status === 503 && r.headers['cache-control'] === 'no-store' && /verdicts suspended/.test(r.body) && /2026-11-25T12:01/.test(r.body))
}

console.log('Coinbase page by page; every host that serves /mcp')
{
  const many = Array.from({ length: 9 }, (_, i) => B(i + 1))
  const w = await world({ coinbase: many, pages: 3 })
  const r = await readIssuer('coinbase', { fetchImpl: w.fetchImpl })
  check('a Coinbase list over several pages is read whole', r.state === 'ok' && r.addresses.length === 9 && w.calls.filter((c) => c.url.includes('api.coinbase.com')).length === 3)
  const endless = await readIssuer('coinbase', { fetchImpl: async () => res(200, { tokens: [{ contract_address: B(1) }], next_page_token: 'x' }) })
  check('...a list that never ends is unknown, never half a list', endless.state === 'unknown')
  const toml = fs.readFileSync(new URL('./wrangler.toml.example', import.meta.url), 'utf8')
  const nginx = fs.readFileSync(new URL('../../nginx/proofofstock.xyz.conf', import.meta.url), 'utf8')
  const mcpHosts = [...nginx.matchAll(/server_name ([^;]+);[\s\S]*?(?=server_name|$)/g)].filter((m) => /location = \/mcp \{/.test(m[0])).flatMap((m) => m[1].trim().split(/\s+/))
  check('every host nginx serves /mcp on has a route through the switch', mcpHosts.length >= 3 && mcpHosts.every((h) => toml.includes(`pattern = "${h}/mcp*"`)), mcpHosts.join(','))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
