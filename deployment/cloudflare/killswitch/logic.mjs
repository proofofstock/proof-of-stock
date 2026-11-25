// deployment/cloudflare/killswitch/logic.mjs: the kill switch's decision, pure (owner, 25.11). It runs in a Cloudflare
// Worker in front of proofofstock.xyz (worker.mjs), so it stands outside our host: a host that was broken into cannot
// switch it off.
//
// Once a minute it reads, for each chain, two things that do not pass through each other:
//   - the issuer's own list, straight from the issuer's API (Coinbase on Base, page by page; Robinhood on its chain);
//   - the list our server says it decides against: /verify on a token drawn at random from the issuer's own list, its
//     list_proof, and the addresses at list_proof.addresses_url, which must hash to list_proof.addresses_sha256.
// It also asks our server about a known look-alike, which must never come back listed.
//
// THE RULE, fixed before it ever ran (revised after outside review, 25.11):
//   A problem is something that would let an agent buy what the issuer does not list:
//     - an address we call listed that is not on the issuer's current list, was not on it at any read in the last
//       GRACE_MS, and has been on our list for GRACE_MS or longer (a listing we saw before the switch did is not one);
//     - on Base, an address we call listed without the pinned issuer prefix;
//     - our addresses not hashing to the list_proof that names them, or a list_proof pointing elsewhere;
//     - the known look-alike answered as listed.
//   Never a problem, by design:
//     - the issuer listing an address we do not have yet (we are behind, and "not listed" refuses a buy);
//     - our server down, slow, answering 5xx, or saying its own list is stale (list_proof.stale): that chain is
//       "unknown" for the run;
//     - the issuer's API down, slow, rate-limited, malformed or empty: "unknown" too, never a mismatch.
//   STRIKES ARE PER CHAIN. STRIKES_TO_TRIP runs in a row with a problem on one chain trip the switch. A run in which a
//   chain was not compared leaves that chain's strikes as they were: only a clean comparison clears them (a server
//   that lied every other minute used to reset them, outside review 25.11).
//   OUR SIDE UNKNOWN WHILE THE ISSUER IS READABLE, for UNKNOWN_ALERT_MS in a row, alerts (once). It does not
//   trip: a server that is down fails closed already. It is how a server that hides from the switch is seen.
//   The switch never re-arms itself. For WARMUP_MS after the first run (or a reset) it counts but does not trip.
//
// ⚠ WHAT IT CANNOT SEE. A server that lies about one address only in /verify while serving a clean list: the guard
// (0.3.0) checks the issuer itself for that. And a server can tell the switch's requests apart (Cloudflare marks a
// Worker's subrequests with a CF-Worker header); the random probe and the unknown-streak alert make hiding costly, not
// impossible. deployment/KILLSWITCH.md says so.
// ⚠ IT WRITES LITTLE. Workers KV on the free plan takes 1,000 writes a day. The state is written only when what it
// decides on changed, or every PERSIST_EVERY_MS; the trip is one write of its own key, never overwritten.

export const GRACE_MS = 20 * 60e3
export const WARMUP_MS = GRACE_MS
export const STRIKES_TO_TRIP = 2
export const UNKNOWN_ALERT_MS = 10 * 60e3
export const SEEN_KEEP_MS = 24 * 3600e3
export const SEEN_REFRESH_MS = 15 * 60e3
export const PERSIST_EVERY_MS = 15 * 60e3
export const MAX_PROBLEMS_KEPT = 5
export const PROBE_TRIES = 3
export const ISSUER_MAX_PAGES = 5
/** A user-agent that does not name the switch. */
export const USER_AGENT = 'Mozilla/5.0 (compatible)'
const ADDRESS = /^0x[0-9a-f]{40}$/

export const CONFIG = Object.freeze({
  site: 'https://proofofstock.xyz',
  chains: Object.freeze({
    base: Object.freeze({
      issuer: 'coinbase',
      probe: '0xb20000000000000000000078ee7ce2fe4908108c', // NVDAc: the last fallback when no random probe answers
      knownFake: '0x02ecff464a843629b63b8462e42ffc35e38bb384', // a copy of SNDKc, the canary's look-alike
      prefix: '0xb200000000000000000000', // every Coinbase stock token (the guard pins the same)
    }),
    robinhood: Object.freeze({
      issuer: 'robinhood',
      probe: '0x322f0929c4625ed5bad873c95208d54e1c003b2d', // TSLA
      knownFake: null,
      prefix: null, // Robinhood's addresses share no start
    }),
  }),
})

const COINBASE = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500'
export const ISSUERS = Object.freeze({
  coinbase: { url: COINBASE, page: (b) => (Array.isArray(b?.tokens) ? { addresses: b.tokens.map((t) => t.contract_address), next: b.next_page_token ? String(b.next_page_token) : null } : null), pageUrl: (t) => COINBASE + '&page_token=' + encodeURIComponent(t) },
  robinhood: { url: 'https://api.robinhood.com/rhj/assets', page: (b) => (Array.isArray(b?.assets) ? { addresses: b.assets.map((a) => (Array.isArray(a.deployments) ? a.deployments : []).find((d) => String(d.chainId) === '4663')?.contractAddress).filter((x) => x != null), next: null } : null) },
})

/** SHA-256 hex of addresses as list_proof hashes them: lowercase, sorted bytewise, each line ending in "\n". */
export async function addressesSha256 (addresses) {
  const text = addresses.map((a) => String(a).toLowerCase()).sort().map((a) => a + '\n').join('')
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

async function get (fetchImpl, url, timeoutMs, kind = 'json') {
  try {
    const r = await fetchImpl(url, { headers: { accept: kind === 'json' ? 'application/json' : 'text/plain', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) })
    if (r.status !== 200) return { ok: false, status: r.status }
    return { ok: true, body: kind === 'json' ? await r.json() : await r.text() }
  } catch (e) { return { ok: false, status: 'error' } }
}

/** The issuer's list now, every page: { state: 'ok', addresses } or { state: 'unknown', why }. Never throws. */
export async function readIssuer (issuer, { fetchImpl, timeoutMs = 15000 }) {
  const recipe = ISSUERS[issuer]
  const out = []
  let url = recipe.url
  for (let i = 0; i < ISSUER_MAX_PAGES; i++) {
    const g = await get(fetchImpl, url, timeoutMs)
    if (!g.ok) return { state: 'unknown', why: `issuer ${issuer} answered ${g.status}` }
    const pg = recipe.page(g.body)
    if (!pg) return { state: 'unknown', why: `issuer ${issuer} list unreadable` }
    out.push(...pg.addresses)
    if (!pg.next) return out.length ? { state: 'ok', addresses: out.map((a) => String(a).toLowerCase()) } : { state: 'unknown', why: `issuer ${issuer} list empty` }
    url = recipe.pageUrl(pg.next)
  }
  return { state: 'unknown', why: `issuer ${issuer} list longer than ${ISSUER_MAX_PAGES} pages` }
}

/**
 * What our server says now, for one chain. The probe is drawn at random from the issuer's own list (up to PROBE_TRIES),
 * then the fixed one: a server cannot answer a fixed probe honestly and lie to the rest. { state: 'unknown' } when
 * nothing usable came back (never a problem).
 */
export async function readOurs (chain, cfg, { fetchImpl, site, issuerAddresses = null, random = Math.random, timeoutMs = 15000 }) {
  const pool = (issuerAddresses || []).filter((a) => ADDRESS.test(a))
  const probes = []
  for (let i = 0; i < PROBE_TRIES && pool.length; i++) probes.push(pool[Math.floor(random() * pool.length)])
  probes.push(cfg.probe)
  let v = null, why = 'no probe answered with a list'
  for (const probe of probes) {
    const g = await get(fetchImpl, `${site}/verify?chain=${chain}&address=${probe}`, timeoutMs)
    if (!g.ok || !g.body || typeof g.body !== 'object') { why = `our /verify answered ${g.status}`; continue }
    const p = g.body.list_proof
    if (g.body.listed !== true || !p || !p.addresses_url || !/^[0-9a-f]{64}$/.test(String(p.addresses_sha256))) { why = 'our probe answer carries no list to compare'; continue }
    if (p.stale === true) return { state: 'unknown', why: 'our server says its issuer list is stale' }
    v = g.body; break
  }
  if (!v) return { state: 'unknown', why }
  const p = v.list_proof
  if (!String(p.addresses_url).startsWith(site + '/')) return { state: 'ok', listed: [], problems: [{ kind: 'proof_elsewhere', detail: `list_proof points outside ${site}` }] }
  const a = await get(fetchImpl, p.addresses_url, timeoutMs, 'text')
  if (!a.ok) return { state: 'unknown', why: `our list answered ${a.status}` }
  const listed = String(a.body).split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const problems = []
  if (!listed.every((x) => ADDRESS.test(x))) problems.push({ kind: 'proof_malformed', detail: 'our list holds something that is not an address' })
  else if (await addressesSha256(listed) !== p.addresses_sha256) problems.push({ kind: 'proof_mismatch', detail: 'our list does not hash to the list_proof that names it' })
  if (cfg.knownFake) {
    const f = await get(fetchImpl, `${site}/verify?chain=${chain}&address=${cfg.knownFake}`, timeoutMs)
    if (f.ok && f.body && f.body.listed === true) problems.push({ kind: 'known_fake_listed', address: cfg.knownFake, detail: 'the known look-alike is answered as listed' })
  }
  return { state: 'ok', listed, problems }
}

/** One run's readings, for every chain: the issuer first, so our side can be probed with the issuer's own tokens. */
export async function observe ({ fetchImpl = globalThis.fetch, config = CONFIG, timeoutMs = 15000, random = Math.random } = {}) {
  const out = {}
  for (const [chain, cfg] of Object.entries(config.chains)) {
    const issuer = await readIssuer(cfg.issuer, { fetchImpl, timeoutMs })
    const ours = await readOurs(chain, cfg, { fetchImpl, site: config.site, timeoutMs, random, issuerAddresses: issuer.state === 'ok' ? issuer.addresses : null })
    out[chain] = { issuer, ours }
  }
  return out
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/**
 * The decision. Pure. Returns the new state, whether it should be written (`persist`), a trip to record once (`trip`),
 * and alert lines. The trip itself lives in its own key (worker.mjs); `state.tripped` only mirrors it.
 * state: { strikes: {chain: n}, unknown_since: {chain: ms|null}, unknown_alerted: {chain: bool}, first_run_at, seen: {chain:
 * {address: ms}}, ours_seen: {chain: {address: ms}}, last_problems, last_unknown, last_run_at, written_at, tripped }
 */
export function decide (prev, obs, now, config = CONFIG, { tripped = false } = {}) {
  const p = obj(prev)
  const chains = Object.keys(config.chains)
  const seen = {}, oursSeen = {}, strikes = {}, unknownSince = {}, unknownAlerted = {}
  const problems = [], unknown = [], alerts = []
  for (const c of chains) {
    // The issuer's addresses, refreshed only every SEEN_REFRESH_MS so the state does not change every minute.
    const old = obj(obj(p.seen)[c])
    seen[c] = {}
    for (const [a, t] of Object.entries(old)) if (Number.isFinite(t) && now - t <= SEEN_KEEP_MS) seen[c][a] = t
    const iss = obs[c] && obs[c].issuer
    if (iss && iss.state === 'ok') for (const a of iss.addresses) if (!(a in seen[c]) || now - seen[c][a] >= SEEN_REFRESH_MS) seen[c][a] = now
    // When each address first showed on OUR list, so a listing we saw before the switch did is given its grace.
    const os = obj(obj(p.ours_seen)[c])
    oursSeen[c] = {}
    const ours = obs[c] && obs[c].ours
    if (ours && ours.state === 'ok') for (const a of ours.listed) oursSeen[c][a] = Number.isFinite(os[a]) ? os[a] : now
    else for (const [a, t] of Object.entries(os)) if (Number.isFinite(t)) oursSeen[c][a] = t
  }
  for (const [c, cfg] of Object.entries(config.chains)) {
    const o = obs[c] || {}
    const ours = o.ours || { state: 'unknown', why: 'not read' }, iss = o.issuer || { state: 'unknown', why: 'not read' }
    const mine = []
    let compared = false
    if (ours.state !== 'ok') unknown.push(`${c}: ${ours.why}`)
    else {
      for (const x of ours.problems || []) mine.push({ chain: c, ...x })
      if (cfg.prefix) for (const a of ours.listed) if (!a.startsWith(cfg.prefix)) mine.push({ chain: c, kind: 'prefix', address: a, detail: `listed without the issuer prefix ${cfg.prefix}` })
      if (iss.state !== 'ok') unknown.push(`${c}: ${iss.why}`)
      else {
        compared = true
        const current = new Set(iss.addresses)
        for (const a of ours.listed) {
          if (current.has(a)) continue
          const t = seen[c][a]
          if (t != null && now - t <= GRACE_MS) continue // the issuer delisted it moments ago
          if (now - oursSeen[c][a] < GRACE_MS) continue // new on our list: the issuer's API may not show it to us yet
          mine.push({ chain: c, kind: 'not_on_issuer_list', address: a, detail: 'we call it listed; the issuer does not, and did not within the grace window' })
        }
      }
    }
    const before = Number.isFinite(obj(p.strikes)[c]) ? obj(p.strikes)[c] : 0
    strikes[c] = mine.length ? before + 1 : compared ? 0 : before
    problems.push(...mine)
    // Our side unknown while the issuer answers: when it began (a time, so the state does not change every minute),
    // and one alert once it has lasted UNKNOWN_ALERT_MS.
    const us = obj(p.unknown_since)[c]
    unknownSince[c] = ours.state !== 'ok' && iss.state === 'ok' ? (Number.isFinite(us) ? us : now) : null
    const long = unknownSince[c] != null && now - unknownSince[c] >= UNKNOWN_ALERT_MS
    unknownAlerted[c] = long
    if (long && !obj(p.unknown_alerted)[c]) alerts.push(`Proof of Stock kill switch: for ${Math.round((now - unknownSince[c]) / 60e3)} minutes our server has given no ${c} list to compare while the issuer answers (${ours.why}). The switch cannot check that chain until it does.`)
  }
  const firstRun = Number.isFinite(p.first_run_at) ? p.first_run_at : now
  const warm = now - firstRun >= WARMUP_MS
  const trips = !tripped && warm && chains.some((c) => strikes[c] >= STRIKES_TO_TRIP)
  const reason = trips ? summarize(problems) : null
  if (trips) alerts.push(`Proof of Stock kill switch TRIPPED: ${reason}. Every verdict route answers 503 until it is cleared (deployment/KILLSWITCH.md).`)
  const decided = { strikes, unknown_since: unknownSince, unknown_alerted: unknownAlerted, first_run_at: firstRun, seen, ours_seen: oursSeen, last_problems: problems.slice(0, MAX_PROBLEMS_KEPT), tripped: tripped || trips }
  const changed = JSON.stringify(decided) !== JSON.stringify({ strikes: p.strikes, unknown_since: p.unknown_since, unknown_alerted: p.unknown_alerted, first_run_at: p.first_run_at, seen: p.seen, ours_seen: p.ours_seen, last_problems: p.last_problems, tripped: p.tripped })
  const due = !Number.isFinite(p.written_at) || now - p.written_at >= PERSIST_EVERY_MS
  const persist = changed || due
  const state = { ...decided, last_unknown: unknown, last_run_at: now, written_at: persist ? now : p.written_at }
  return { state, persist, trip: trips ? { at: new Date(now).toISOString(), reason } : null, alerts }
}

export function summarize (problems) {
  if (!problems.length) return null
  const f = problems[0]
  return `${problems.length} problem(s), first: ${f.chain} ${f.kind}${f.address ? ' ' + f.address : ''} (${f.detail})`
}

/** The routes that carry a verdict: blocked while tripped. Pages stay up and say nothing they did not say before. */
export const BLOCKED = /^\/(?:verify|badge\.svg|tokenlist\.json)(?:\/|$)|^\/api\/|^\/mcp(?:\/|$)/

/**
 * The path as the origin will see it: percent-decoded segment by segment, runs of slashes collapsed, dot segments
 * resolved. "//verify" and "/%76erify" reach nginx as /verify, so they must be matched as /verify (outside review, 25.11).
 * An undecodable path counts as blocked-shaped: it is matched in its raw form and in its collapsed form.
 */
export function normalizePath (pathname) {
  let p = String(pathname || '/')
  for (let i = 0; i < 3; i++) { let d; try { d = decodeURIComponent(p) } catch (_) { break } if (d === p) break; p = d }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const out = []
  for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg !== '.') out.push(seg) }
  const r = out.join('/')
  return r.startsWith('/') ? r : '/' + r
}
export const isBlocked = (pathname) => BLOCKED.test(normalizePath(pathname)) || BLOCKED.test(pathname)

/** The answer while tripped: a plain 503 the guard reads as "could not check". */
export function suspended (trip) {
  return {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '300' },
    body: JSON.stringify({ error: 'verdicts suspended: our list disagrees with the issuer\'s, so no verdict is given until a person has checked', since: (trip && trip.at) || null }),
  }
}
