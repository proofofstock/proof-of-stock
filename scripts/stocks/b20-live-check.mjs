#!/usr/bin/env node
// scripts/stocks/b20-live-check.mjs: a read-only live check of the B20 transfer-rule reads against Base mainnet
// (docs/b20-transfers-tz.md §6). Not part of npm test: it calls out. Run it by hand before a deploy that touches the
// reads, or when Base changes the B20 interfaces.
//
// What it checks, for one token (by default NVDAc, the token the selectors were first checked on):
//   1. each of the factory mirror's RPC pair pins a block and answers aggregate3 at that block's hash;
//   2. the token's three policyId reads and isPaused decode as a uint64 and a bool, by direct eth_call and through
//      Multicall3 alike, and the two agree;
//   3. the policy registry answers policyExists for each bound id, and isAuthorized for the ordinary wallet;
//   4. the reader (apps/b20-reader.mjs) gives the token a state from STATES that is not "could not read";
//   5. the Uniswap v4 PoolManager we name has code.
// It prints PASS or FAIL per step and the state category it found. It writes nothing, signs nothing and sends nothing.
//
// Run: node scripts/stocks/b20-live-check.mjs [--token 0x...]
import { createB20Reader, rpcPairOf, pinHead, pinTag, multicallAt, pinOf, rolesAt, VENUE_ROUTERS } from '../../apps/b20-reader.mjs'
import { POLICY_REGISTRY, SCOPE_KEYS, ALWAYS_ALLOW, ORDINARY_WALLET, UNISWAP_V4_POOL_MANAGER, STATES, calldata, idOf, boolOf, transfersOf } from '../../evm/core/stocks/b20.mjs'

const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c'
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const token = String(arg('--token') || NVDAC).toLowerCase()
if (!/^0x[0-9a-f]{40}$/.test(token)) { console.log('FAIL --token must be an address'); process.exit(2) }

let bad = 0
const step = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) bad++ }
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) })
  const j = await r.json()
  if (j.error || j.result == null) throw new Error(String(j?.error?.message || 'no result').slice(0, 120))
  return j.result
}

const urls = rpcPairOf(process.env)
for (const [k, url] of urls.entries()) {
  const name = k === 0 ? 'the mirror\'s first RPC' : 'the mirror\'s second RPC'
  try {
    const head = await pinHead(fetch, url)
    const calls = [...SCOPE_KEYS.map((s) => ({ to: token, data: calldata.policyId(s) })), { to: token, data: calldata.isPaused() }]
    const viaMc = await multicallAt(fetch, url, calls, head.hash)
    const direct = []
    for (const c of calls) direct.push({ success: true, data: await rpc(url, 'eth_call', [c, pinOf(head.hash)]) })
    const ids = viaMc.slice(0, 3).map(idOf), paused = boolOf(viaMc[3])
    step(ids.every((x) => x != null) && paused != null, `${name}: policyId x3 and isPaused decode through Multicall3, strictly, at a canonical block hash`)
    step(Math.abs(Date.now() - head.time) < 120e3, `${name}: the head's own time is current`)
    step(JSON.stringify(direct.map((d) => d.data)) === JSON.stringify(viaMc.map((d) => d.data)), `${name}: the direct eth_call answers equal the Multicall3 answers`)
    const used = [...new Set(ids.filter((x) => x != null && x !== ALWAYS_ALLOW))]
    if (used.length) {
      const ex = await multicallAt(fetch, url, used.map((id) => ({ to: POLICY_REGISTRY, data: calldata.policyExists(id) })), head.hash)
      step(ex.every((r) => boolOf(r) != null), `${name}: policyExists decodes for every bound id`)
      const au = await multicallAt(fetch, url, used.map((id) => ({ to: POLICY_REGISTRY, data: calldata.isAuthorized(id, ORDINARY_WALLET) })), head.hash)
      step(au.every((r) => boolOf(r) != null), `${name}: isAuthorized decodes for the ordinary wallet`)
    } else step(true, `${name}: every scope is ALWAYS_ALLOW, no registry read needed`)
    if (k === 0) {
      const code = await rpc(url, 'eth_getCode', [UNISWAP_V4_POOL_MANAGER, pinOf(head.hash)])
      step(typeof code === 'string' && code.length > 2, 'the Uniswap v4 PoolManager we name has code')
    }
  } catch (e) { step(false, `${name}: ${String(e && e.message || e).slice(0, 120)}`) }
}

// Both RPCs at one common safe block: each one's safe head, the lower one fetched by number on both, the same hash.
try {
  const safes = await Promise.all(urls.map((u) => pinTag(fetch, u, 'safe')))
  step(safes.every((h) => Math.abs(Date.now() - h.time) < 900e3), 'both RPCs answer a safe head, current by its own time')
  const n = Math.min(...safes.map((h) => h.number))
  const common = await Promise.all(urls.map((u) => pinTag(fetch, u, n)))
  step(common.length === 2 && common[0].hash === common[1].hash, 'both RPCs give the same hash for the common safe block')
} catch (e) { step(false, 'the safe heads: ' + String(e && e.code || 'error')) }

// simulate_buy's head read: the same roles on both RPCs at one common latest block.
const roles = await rolesAt({ fetchImpl: fetch, urls, token, accounts: [{ address: ORDINARY_WALLET, scopes: ['receiver', 'sender'] }, { address: VENUE_ROUTERS.kyberRouter, scopes: ['executor'] }] })
step(roles && typeof roles.roles === 'object', 'rolesAt: both RPCs agree at one common latest block')

const reader = createB20Reader({ fetchImpl: fetch, env: process.env, log: (m) => console.log('  ' + m) })
await reader.refresh([{ address: token, symbol: null, paused: [] }], { poolsOf: () => [] })
const t = transfersOf(reader.get(token), { now: Date.now(), listPaused: null })
step(STATES.includes(t.state) && !(t.state === 'unknown' && ['read_failed', 'undecodable', 'not_read', 'rpc_disagree', 'single_source'].includes(t.reason)) && reader.get(token)?.sources === 2, `the reader, from both RPCs at one safe block, gives a state: ${t.state}${t.reason ? ' (' + t.reason + ')' : ''}`)
step(t.venues.length === 1 + VENUE_ROUTERS.aerodromeRouters.length + 1 && t.venues.every((v) => v.allowed === true || v.allowed === false || t.state === 'unknown'), 'every venue we name has an answer')
console.log(bad ? `\n${bad} step(s) failed` : '\nall steps passed')
process.exit(bad ? 1 : 0)
