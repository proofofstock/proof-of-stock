// apps/fault-drills.test.mjs: what the site says when an issuer's API breaks, on recorded REAL answers (12.11) broken
// every way an issuer could break them. The promise: never "not listed" from a list we could not read; the last good
// list for 15 minutes, marked stale; then "registry unavailable" (503). A format that merely changed is read and seen.
//
// Run: node apps/fault-drills.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb } from './stocks-web.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL, readCoinbase, readRobinhood } from '../evm/core/stocks/registries.mjs'
import { shapeOf, shapeChanges } from '../evm/core/stocks/shape.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const fx = (f) => JSON.parse(fs.readFileSync(new URL('../tests/fixtures/issuers/' + f, import.meta.url), 'utf8'))
const CB = fx('coinbase-tokenized-stocks.json'), RHA = fx('robinhood-assets.json'), RHP = fx('robinhood-prices.json')
const LISTED = CB.tokens[0].contract_address.toLowerCase()
const RH_LISTED = RHA.assets[0].deployments.find((d) => String(d.chainId) === '4663').contractAddress.toLowerCase()
const ok = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body) })

// How an issuer's answer can break. Each yields the fetch answer for the list URL.
const BREAKS = {
  '503 for a while': () => ({ ok: false, status: 503, json: async () => ({}) }),
  '429 rate limit': () => ({ ok: false, status: 429, json: async () => ({ message: 'rate limit' }) }),
  'an HTML error page with 200': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }),
  'the list renamed': (b) => ok(b.tokens ? { items: b.tokens } : { data: b.assets }),
  'a record without its address': (b) => ok(b.tokens ? { tokens: b.tokens.map(({ contract_address, ...t }) => t) } : { assets: b.assets.map((a) => ({ ...a, deployments: a.deployments.map(({ contractAddress, ...d }) => d) })) }),
  'the network down': () => { throw new TypeError('fetch failed') },
}

console.log('the readers on real answers')
{
  const cb = await readCoinbase(async () => ok(CB), { chainId: 8453 })
  check('Coinbase: the recorded answer reads, absent fields stay null, not 0', cb.length === CB.tokens.length && cb.some((r) => r.supplied === false) && cb.every((r) => r.address === r.address.toLowerCase()))
  const rh = await readRobinhood(async (u) => ok(String(u).startsWith(ROBINHOOD_PRICES_URL) ? RHP : RHA), { chainId: 4663 })
  check('Robinhood: the recorded answers read, with token-unit quotes', rh.length === RHA.assets.length && rh.every((r) => r.supply_known === false))
  for (const [name, brk] of Object.entries(BREAKS)) {
    let threwC = false, threwR = false
    try { await readCoinbase(async () => brk(CB), { chainId: 8453 }) } catch (_) { threwC = true }
    try { await readRobinhood(async (u) => (String(u).startsWith(ROBINHOOD_PRICES_URL) ? ok(RHP) : brk(RHA)), { chainId: 4663 }) } catch (_) { threwR = true }
    check(`${name}: both readers throw (never a short or empty list)`, threwC && threwR)
  }
  const added = { tokens: CB.tokens.map((t) => ({ ...t, venue: 'NYSE' })) }
  const read = await readCoinbase(async () => ok(added), { chainId: 8453 })
  check('a new field is read through, and the shape check names it', read.length === CB.tokens.length && shapeChanges(shapeOf(CB), shapeOf(added)).some((c) => /new field tokens\[\]\.venue/.test(c)))
  const typed = { tokens: CB.tokens.map((t) => ('nav_price' in t ? { ...t, nav_price: String(t.nav_price) } : t)) }
  check('a field that changes type is seen', shapeChanges(shapeOf(CB), shapeOf(typed)).some((c) => /tokens\[\]\.nav_price is now string, was number/.test(c)))
}

console.log('the site through an outage')
for (const [name, brk] of Object.entries(BREAKS)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-drill-'))
  let t = Date.parse('2026-11-12T12:00:00Z'), down = false
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.startsWith(COINBASE_URL)) return down ? brk(CB) : ok(CB)
    if (u.startsWith(ROBINHOOD_PRICES_URL)) return ok(RHP)
    if (u.startsWith(ROBINHOOD_ASSETS_URL)) return down ? brk(RHA) : ok(RHA)
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const app = createStocksWeb({ roots: { base: path.join(tmp, 'b'), robinhood: path.join(tmp, 'r') }, fetchImpl, now: () => t, log: () => {}, analytics: { enabled: false } })
  const { port } = await app.start(0, '127.0.0.1')
  let ip = 0
  const verify = async (chain, a) => { const r = await fetch(`http://127.0.0.1:${port}/stocks/verify?chain=${chain}&address=${a}`, { headers: { 'x-real-ip': '198.51.100.' + (++ip % 250) } }); return { status: r.status, body: await r.json() } }
  const before = await verify('base', LISTED)
  down = true; t += 60e3; await app.refreshAll()
  const soon = await verify('base', LISTED), soonRh = await verify('robinhood', RH_LISTED)
  t += 16 * 60e3; await app.refreshAll()
  const later = await verify('base', LISTED), laterRh = await verify('robinhood', RH_LISTED), other = await verify('base', '0x' + '12'.repeat(20))
  await app.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
  check(`${name}: within 15 minutes the last good list answers, marked stale`, before.body.listed === true && soon.status === 200 && soon.body.listed === true && soon.body.list_proof?.stale === true && soonRh.body.list_proof?.stale === true, JSON.stringify([soon.status, soon.body.list_proof?.stale]))
  check(`${name}: past 15 minutes it is "registry unavailable" (503), never "not listed"`, later.status === 503 && laterRh.status === 503 && other.status === 503 && later.body.listed === undefined && other.body.listed === undefined, JSON.stringify([later.status, other.status, other.body.listed]))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
