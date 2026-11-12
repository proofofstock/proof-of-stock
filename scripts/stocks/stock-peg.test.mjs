// scripts/stocks/stock-peg.test.mjs: one run writes a valid row per supplied token and one manifest row, always; a
// list it could not read writes the manifest and nothing else; a pair read that fails is a refusal, not a gap.
//
// Run: node scripts/stocks/stock-peg.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { runStockPeg, runExitCode, CHAINS, SUPPLEMENT_STOP_MS } from './stock-peg.mjs'
import { ONCHAIN } from './onchain-pools.mjs'
import { openRawStore } from './raw-store.mjs'
import { fakeChain, sqrtX96For } from './test-fake-chain.mjs'
import { validateV2 } from '../../schemas/v2/validate.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../../evm/core/stocks/registries.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-peg-'))
// No run in this file may reach the real private store, even with the store's switch broken (tests/locks/stock-peg-raw).
process.env.STP_RAW_DIR = path.join(tmp, 'stp-raw-default')
delete process.env.STP_RAW_SNAPSHOTS
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const NOW = Date.parse('2026-11-08T12:00:00Z')
// The GeckoTerminal lane tops up only tokens a previous run saw with a full DexScreener list (scripts/stocks/gecko-lane.mjs).
const seedCapped = (root, addrs) => { const d = path.join(root, 'stock-peg'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'gecko-topups.json'), JSON.stringify(Object.fromEntries(addrs.map((a) => [a, { capped_at: new Date(NOW - 3600e3).toISOString() }])))) }

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), C = '0x' + 'cc'.repeat(20)
// The chains' real reference assets: a pool prices a stock token only against one of them (evm/core/stocks/peg.mjs).
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const MEME = '0x' + '77'.repeat(20)
const pairOf = (addr, price, liq, quote = USDC, quoteSymbol = 'USDC') => ({ pairAddress: '0x' + '12'.repeat(20), dexId: 'aerodrome', baseToken: { address: addr }, quoteToken: { address: quote, symbol: quoteSymbol }, priceUsd: String(price), liquidity: { usd: liq }, volume: { h24: 5 } })
const respond = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer })
const fetchFor = ({ coinbase, pairs }) => async (url) => {
  const u = String(url)
  if (u.startsWith(COINBASE_URL)) return coinbase
  const m = u.match(/token-pairs\/v1\/[a-z]+\/(0x[0-9a-f]{40})$/)
  if (m) { const p = pairs[m[1]]; if (p instanceof Error) throw p; return respond(200, p ?? []) }
  return respond(404, {})
}

console.log('a Base run')
{
  const root = path.join(tmp, 'base')
  const coinbase = respond(200, { tokens: [
    { contract_address: A, symbol: 'NVDAc', isin: 'US1', multiplier: '1.011', nav_price: '100', nav_price_updated_at: '2026-11-06T21:00:00Z', total_supply: '10' },
    { contract_address: B, symbol: 'AAPLc', multiplier: '1', total_supply: '3' },
    { contract_address: C, symbol: 'NONEc', multiplier: '1' },
  ] })
  const run = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, log: () => {},
    fetchImpl: fetchFor({ coinbase, pairs: { [A]: [pairOf(A, 102, 2_000_000)], [B]: new Error('socket hang up') } }) })
  const rows = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  const runs = lines(path.join(root, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))
  check('an unminted token is not read: two rows for three records', rows.length === 2 && run.tokens_considered === 2, String(rows.length))
  check('every row validates', rows.every((r) => validateV2('stock-peg', r).valid))
  const a = rows.find((r) => r.token_address === A)
  check('the premium is DEX over NAV with no multiplier applied', Math.abs(a.premium - 0.02) < 1e-12, String(a.premium))
  check('the reference age is measured, not refused', a.reference.age_s === 39 * 3600 && a.premium_refused === null, String(a.reference.age_s))
  check('the multiplier is on the row', a.multiplier === 1.011)
  const b = rows.find((r) => r.token_address === B)
  check('no NAV refuses as no_reference', b.premium_refused === 'no_reference' && b.premium === null)
  check('a failed pair read is recorded on the row', b.pools.seen === null && /socket hang up/.test(b.pools.error))
  check('one manifest row, valid, complete', runs.length === 1 && validateV2('stock-peg-run', runs[0]).valid && runs[0].registry.complete === true)
  check('the manifest counts the refusals and the read errors', runs[0].refused.no_reference === 1 && runs[0].pair_read_errors === 1 && runs[0].rows_written === 2)
  // 12.11: a Robinhood run reached its deadline. The run row now says how long it took, what it was given, and where
  // the time went, per source (TZ recorder speed 4.1).
  const t = runs[0].timing
  check('the run row says where its time went: the issuer list and DexScreener, each counted, a failed read too', t.issuer?.n >= 1 && t.dexscreener?.n === 2 && Object.values(t).every((x) => x.total_ms >= 0 && x.p50_ms <= x.p95_ms && x.p95_ms <= x.max_ms), JSON.stringify(t))
  check('...its duration, and no budget when it ran without a deadline', runs[0].duration_s === 0 && runs[0].budget_s === null)
  {
  const { timedFetch } = await import('./stock-peg.mjs')
  let tick = 0
  const f = timedFetch(async () => ({ ok: true }), () => (tick += 10))
  const rpc = (method) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) })
  await f('https://api.dexscreener.com/token-pairs/v1/base/0x1')
  await f('https://api.geckoterminal.com/api/v2/networks/base/tokens/0x1/pools')
  await f('https://api.coinbase.com/v1/tokenized-stocks')
  await f('https://api.robinhood.com/x')
  await f('https://rpc.example', rpc('eth_getBlockByNumber'))
  await f('https://rpc.example', rpc('eth_blockNumber'))
  await f('https://rpc.example', rpc('eth_call'))
  await f('https://rpc.example', rpc('eth_chainId'))
  await f('https://rpc.mainnet.chain.robinhood.com', rpc('eth_call'))
  await f('https://rpc.example', { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [] }]) })
  await f('https://evil.dexscreener.com.example.org/x')
  await f('not a url')
  const s = f.summary()
  check('sources: the two aggregators, the issuers, a block read, an eth_call, other RPC, other hosts', s.dexscreener.n === 1 && s.geckoterminal.n === 1 && s.issuer.n === 2 && s.rpc_block.n === 3 && s.rpc_call.n === 2 && s.rpc_other.n === 1 && s.other.n === 2, JSON.stringify(s))
  check('...a host that only contains a source name is not that source', s.dexscreener.n === 1)
  check('...an RPC under an issuer domain is RPC, not the issuer, and a batch is read by its first call', s.issuer.n === 2 && s.rpc_call.n === 2 && s.rpc_block.n === 3)
  check('...each request timed by the clock, summed, with p50, p95 and max', s.rpc_block.total_ms === 30 && s.rpc_block.p50_ms === 10 && s.rpc_block.max_ms === 10)
  const failing = timedFetch(async () => { throw new Error('down') }, () => (tick += 5))
  let threw = false
  try { await failing('https://api.dexscreener.com/x') } catch (_) { threw = true }
  check('a request that fails is still timed, and the error still reaches the caller', threw && failing.summary().dexscreener.n === 1)
  const whole = timedFetch(async () => new Response(JSON.stringify({ pairs: [1, 2, 3] })))
  const answer = await whole('https://api.dexscreener.com/x')
  check('...the body is timed from a clone: the caller still reads the whole answer', (await answer.json()).pairs.length === 3 && whole.summary().dexscreener.n === 1)
  // The review of 12.11: GeckoTerminal top-ups fail 1 to 6 times a run and nothing said why. Now a 429 is counted apart.
  const codes = [429, 429, 503, 200]
  const counted = timedFetch(async () => { const c = codes.shift(); if (c == null) throw new Error('timeout'); return new Response('{}', { status: c }) })
  for (let i = 0; i < 5; i++) { try { await counted('https://api.geckoterminal.com/x') } catch (_) {} }
  const gs = counted.summary().geckoterminal
  check('...rate-limited answers (429) and other failures (a 503, a timeout) are counted per source', gs.n === 5 && gs.n_429 === 2 && gs.n_failed === 2, JSON.stringify(gs))
  const { validateV2: v2 } = await import('../../schemas/v2/validate.mjs')
  const row = { _schema_version: '1.0', run_id: 'x', chain_id: 1, issuer: 'coinbase', started_at: '2026-11-12T00:00:00.000Z', finished_at: '2026-11-12T00:01:00.000Z', registry: { records: 1, complete: true, error: null }, tokens_considered: 1, rows_written: 1, rows_invalid: 0, refused: {}, pair_read_errors: 0, supplemented: 0, supplement_errors: 0, duration_s: 60, budget_s: 240, timing: s }
  check('the schema takes the new fields, and refuses a source it does not know', v2('stock-peg-run', row).valid && !v2('stock-peg-run', { ...row, timing: { ...s, someone: s.other } }).valid)
  }
  check('rows and manifest share the run id', rows.every((r) => r.run_id === runs[0].run_id))
}

console.log('DexScreener is paced by the start of each request')
{
  // Was a fixed pause after every token (51 s of a 290 s Robinhood run, 12.11). Now a start every paceMs: two tokens with
  // instant answers wait once, not twice, and the wait is the gap, not gap plus answer time.
  const root = path.join(tmp, 'pace')
  const coinbase = respond(200, { tokens: [A, B].map((t) => ({ contract_address: t, symbol: 'Xc', multiplier: '1', nav_price: '100', nav_price_updated_at: '2026-11-08T11:00:00Z', total_supply: '10' })) })
  const starts = []
  await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 120, log: () => {}, fetchImpl: async (url) => {
    const u = String(url)
    if (u.startsWith(COINBASE_URL)) return coinbase
    if (u.includes('/token-pairs/')) { starts.push(performance.now()); return respond(200, []) }
    return respond(404, {})
  } })
  const tail = performance.now() - starts[starts.length - 1]
  check('two tokens: their DexScreener requests start at least paceMs apart, and no pause follows the last one (it was a pause after every token)', starts.length === 2 && starts[1] - starts[0] >= 110 && tail < 110, JSON.stringify({ gap: Math.round(starts[1] - starts[0]), tail: Math.round(tail) }))
}

console.log('a run whose list could not be read')
{
  const root = path.join(tmp, 'down')
  const run = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, log: () => {}, fetchImpl: fetchFor({ coinbase: respond(503, {}), pairs: {} }) })
  check('no token rows', lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl')).length === 0)
  const runs = lines(path.join(root, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))
  check('the manifest row is still written, and says why', runs.length === 1 && runs[0].registry.complete === false && /503/.test(runs[0].registry.error) && validateV2('stock-peg-run', runs[0]).valid)
  check('the run reports incomplete to its caller', run.registry.complete === false)
}

console.log('a Robinhood run')
{
  const root = path.join(tmp, 'rh')
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.startsWith(ROBINHOOD_ASSETS_URL)) return respond(200, { assets: [{ tokenSymbol: 'TSLA', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: C }] }] })
    if (u.startsWith(ROBINHOOD_PRICES_URL)) return respond(200, { quotes: [{ tokenSymbol: 'TSLA', bid: '400', ask: '401', tokenBid: '399', tokenAsk: '401', isTradingHalt: false, generatedAt: '2026-11-08T11:59:45Z' }] })
    if (u.includes('/token-pairs/v1/robinhood/' + C)) return respond(200, [pairOf(C, 396, 40_000, USDG, 'USDG')])
    return respond(404, {})
  }
  await runStockPeg({ chain: 'robinhood', root, now: () => NOW, paceMs: 0, log: () => {}, fetchImpl })
  const [r] = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  check('Robinhood pools are read under the robinhood slug', r && r.pools.seen === 1)
  check('the premium is DEX over the token bid/ask mid', r && Math.abs(r.premium - (396 / 400 - 1)) < 1e-12, r && String(r.premium))
  check('the row is the Robinhood issuer on chain 4663', r && r.issuer === 'robinhood' && r.chain_id === 4663 && r.reference.kind === 'token_bid_ask_mid')
}

console.log('a token whose DexScreener list is full')
{
  const root = path.join(tmp, 'capped')
  const coinbase = respond(200, { tokens: [{ contract_address: A, symbol: 'NVDAc', multiplier: '1', nav_price: '100', nav_price_updated_at: '2026-11-08T11:00:00Z', total_supply: '10' }] })
  const thirty = Array.from({ length: 30 }, (_, i) => ({ ...pairOf(A, 101, 20_000), pairAddress: '0x' + String(i).padStart(40, '0') }))
  let geckoCalls = 0
  const gecko = (fail) => async (url) => {
    const u = String(url)
    if (u.startsWith(COINBASE_URL)) return coinbase
    if (u.includes('/token-pairs/')) return respond(200, thirty)
    if (u.includes('api.geckoterminal.com')) {
      geckoCalls++
      if (fail) return respond(429, {})
      return respond(200, { data: [
        { attributes: { address: '0x' + 'ab'.repeat(20), name: 'NVDAc / USDC 0.05%', base_token_price_usd: '103', reserve_in_usd: '5000000', volume_usd: { h24: '900000' } }, relationships: { base_token: { data: { id: 'base_' + A } }, quote_token: { data: { id: 'base_' + USDC } }, dex: { data: { id: 'uniswap-v4-base' } } } },
        { attributes: { address: thirty[0].pairAddress, name: 'dup', base_token_price_usd: '1', reserve_in_usd: '1' }, relationships: { base_token: { data: { id: 'base_' + A } } } },
      ] })
    }
    return respond(404, {})
  }
  seedCapped(root, [A])
  const run = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(false) })
  const [r] = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  check('a full list is completed from GeckoTerminal and says so', r.pools.source === 'dexscreener+geckoterminal' && r.pools.seen === 31 && run.supplemented === 1, `${r.pools.source} ${r.pools.seen}`)
  check('the deeper pool GeckoTerminal found now prices the token', r.dex_pool === '0x' + 'ab'.repeat(20) && Math.abs(r.premium - 0.03) < 1e-12)
  check('a GeckoTerminal page that is not full clears the capped flag', r.pools.capped === false)
  check('the row and the manifest are valid', validateV2('stock-peg', r).valid && validateV2('stock-peg-run', lines(path.join(root, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))[0]).valid)
  check('...and the row says when the full list was completed: now', r.pools.topped_up_at === new Date(NOW).toISOString())
  {
    // The lane (review, 12.11: GeckoTerminal keyless is about 5 calls a minute per IP; 17 of 38 requests a run were 429).
    const fresh = path.join(tmp, 'lane-first')
    const before = geckoCalls
    const first = await runStockPeg({ chain: 'base', root: fresh, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(false) })
    const [f1] = lines(path.join(fresh, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
    const st = JSON.parse(fs.readFileSync(path.join(fresh, 'stock-peg', 'gecko-topups.json'), 'utf8'))
    check('a list seen full for the first time is not topped up in that run: deferred, remembered, and the row says never', geckoCalls === before && first.supplement_deferred === 1 && f1.pools.capped === true && f1.pools.topped_up_at === null && f1.pools.source === 'dexscreener' && st[A] && st[A].capped_at, JSON.stringify({ calls: geckoCalls - before, d: first.supplement_deferred }))
    const second = await runStockPeg({ chain: 'base', root: fresh, now: () => NOW + 900e3, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(false) })
    const st2 = JSON.parse(fs.readFileSync(path.join(fresh, 'stock-peg', 'gecko-topups.json'), 'utf8'))
    check('...the next run tops it up and remembers when, and how many pages it took', geckoCalls === before + 1 && second.supplemented === 1 && st2[A].topped_at === new Date(NOW + 900e3).toISOString() && st2[A].pages === 1 && st2[A].more === false, JSON.stringify(st2[A]))
    check('...a pool only GeckoTerminal saw that is a v4 pool marks the token as needing the aggregator', st2[A].needs_aggregator === true)
  }
  const root2 = path.join(tmp, 'capped-429')
  seedCapped(root2, [A])
  const run2 = await runStockPeg({ chain: 'base', root: root2, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(true) })
  const [r2] = lines(path.join(root2, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  check('a throttled GeckoTerminal leaves the DexScreener reading as it was', r2.pools.source === 'dexscreener' && r2.pools.seen === 30 && r2.pools.capped === true && run2.supplement_errors === 1)
  check('GeckoTerminal is asked only for full lists', geckoCalls === 3)
  // Near the deadline a full list is kept as DexScreener gave it; at the deadline the run stops, and says so in its row.
  const root3 = path.join(tmp, 'capped-late')
  seedCapped(root3, [A])
  const run3 = await runStockPeg({ chain: 'base', root: root3, now: () => NOW, deadline: NOW + SUPPLEMENT_STOP_MS - 1, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(false) })
  const [r3] = lines(path.join(root3, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  check('close to its deadline a run skips GeckoTerminal and counts it', geckoCalls === 3 && r3.pools.source === 'dexscreener' && r3.pools.capped === true && run3.supplement_skipped === 1 && run3.aborted === undefined)
  check('...and its run row is valid', validateV2('stock-peg-run', lines(path.join(root3, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))[0]).valid)
  const root4 = path.join(tmp, 'past-deadline')
  const run4 = await runStockPeg({ chain: 'base', root: root4, now: () => NOW, deadline: NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(false) })
  const runs4 = lines(path.join(root4, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))
  check('a run with a deadline writes the budget it was given, in seconds', run3.budget_s === Math.round((SUPPLEMENT_STOP_MS - 1) / 1000) && run4.budget_s === 0, `${run3.budget_s} ${run4.budget_s}`)
  check('at its deadline a run reads no more tokens but still writes a valid run row saying why', run4.rows_written === 0 && /time budget/.test(run4.aborted) && runs4.length === 1 && runs4[0].aborted === run4.aborted && validateV2('stock-peg-run', runs4[0]).valid && runExitCode(run4) === 1 && !fs.existsSync(path.join(root4, 'stock-peg', 'stock-peg-2026-11-08.jsonl')))
}

console.log('a Robinhood reference that does not move')
{
  const root = path.join(tmp, 'rh-held')
  let t = Date.parse('2026-11-08T12:00:00Z')
  const fetchHeld = (bid) => async (url) => {
    const u = String(url)
    if (u.startsWith(ROBINHOOD_ASSETS_URL)) return respond(200, { assets: [{ tokenSymbol: 'TSLA', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: C }] }] })
    if (u.startsWith(ROBINHOOD_PRICES_URL)) return respond(200, { quotes: [{ tokenSymbol: 'TSLA', bid: String(bid), ask: String(bid + 0.2), tokenBid: String(bid), tokenAsk: String(bid + 0.2), isTradingHalt: false, generatedAt: new Date(t - 10e3).toISOString() }] })
    if (u.includes('/token-pairs/v1/robinhood/')) return respond(200, [pairOf(C, 396, 40_000, USDG, 'USDG')])
    return respond(404, {})
  }
  await runStockPeg({ chain: 'robinhood', root, now: () => t, paceMs: 0, log: () => {}, fetchImpl: fetchHeld(399.9) })
  t += 6 * 3600e3
  await runStockPeg({ chain: 'robinhood', root, now: () => t, paceMs: 0, log: () => {}, fetchImpl: fetchHeld(399.9) })
  const rows = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  check('an unchanged quote ages from when it was first seen, not from the server time', rows[1].reference.age_s === 6 * 3600 + 10, String(rows[1].reference.age_s))
  check('...while the server time is kept as quoted_at', rows[1].reference.quoted_at === new Date(t - 10e3).toISOString())
  t += 3600e3
  await runStockPeg({ chain: 'robinhood', root, now: () => t, paceMs: 0, log: () => {}, fetchImpl: fetchHeld(401.3) })
  const after = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))[2]
  check('a quote that moved is fresh again', after.reference.age_s === 10, String(after.reference.age_s))
}

console.log('a run that dies midway')
{
  const root = path.join(tmp, 'dies')
  const coinbase = respond(200, { tokens: [{ contract_address: A, symbol: 'NVDAc', multiplier: '1', nav_price: '100', nav_price_updated_at: '2026-11-08T11:00:00Z', total_supply: '10' }] })
  const run = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: async (u) => (String(u).startsWith(COINBASE_URL) ? coinbase : respond(200, [pairOf(A, 101, 20_000)])), })
  check('a normal run has no aborted field set', run.aborted === undefined)
  // The day's readings file is a directory: writing a row throws, after the registry was read.
  const rows = path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl')
  fs.rmSync(rows); fs.mkdirSync(rows)
  const r2 = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: async (u) => (String(u).startsWith(COINBASE_URL) ? coinbase : respond(200, [pairOf(A, 101, 20_000)])) })
  const runs = lines(path.join(root, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))
  check('the run row is written for every run, a run that died saying why', runs.length === 2 && runs.every((x) => validateV2('stock-peg-run', x).valid) && typeof r2.aborted === 'string' && runs[1].aborted === r2.aborted, JSON.stringify(r2.aborted))
}

console.log('pools against a memecoin never price a stock token')
{
  // Robinhood Chain, 09.11: memecoins launched paired with DJT, $5M "liquidity" each by the source's own pricing, and
  // DJT read back out of them at ~$990 against an issuer price of ~$4.10. The recorder must take the USDG pool.
  const D = '0x' + 'd7'.repeat(20)
  const assets = { assets: [{ tokenSymbol: 'DJT', isin: 'US25400Q1058', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: D }] }] }
  const quotes = { quotes: [{ tokenSymbol: 'DJT', bid: '4.09', ask: '4.10', tokenBid: '4.09', tokenAsk: '4.10', isTradingHalt: false, generatedAt: '2026-11-08T11:59:50Z' }] }
  const memeAsBase = { pairAddress: '0x' + '31'.repeat(32), dexId: 'uniswap', baseToken: { address: MEME, symbol: 'IALI' }, quoteToken: { address: D, symbol: 'DJT' }, priceUsd: '0.0099', priceNative: '0.00001', liquidity: { usd: 5_008_085 }, volume: { h24: 9 } }
  const djtOverMeme = { pairAddress: '0x' + '32'.repeat(20), dexId: 'uniswap', baseToken: { address: D, symbol: 'DJT' }, quoteToken: { address: MEME, symbol: 'IALI' }, priceUsd: '991', liquidity: { usd: 4_900_000 }, volume: { h24: 9 } }
  const usdg = { ...pairOf(D, 4.12, 60_000, USDG, 'USDG'), pairAddress: '0x' + '33'.repeat(20) }
  const fakeUsdg = { ...pairOf(D, 7, 900_000, MEME, 'USDG'), pairAddress: '0x' + '34'.repeat(20) }
  const run = (pairs) => async (url) => {
    const u = String(url)
    if (u.startsWith(ROBINHOOD_ASSETS_URL)) return respond(200, assets)
    if (u.startsWith(ROBINHOOD_PRICES_URL)) return respond(200, quotes)
    if (u.includes('/token-pairs/v1/robinhood/')) return respond(200, pairs)
    return respond(404, {})
  }
  const r1 = path.join(tmp, 'djt-1')
  await runStockPeg({ chain: 'robinhood', root: r1, now: () => NOW, paceMs: 0, log: () => {}, fetchImpl: run([memeAsBase, djtOverMeme, fakeUsdg, usdg]) })
  const row = lines(path.join(r1, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))[0]
  check('the recorder prices DJT from its USDG pool, not from the deeper memecoin pools', row.dex_pool === '0x' + '33'.repeat(20) && row.dex_price_usd === 4.12, JSON.stringify({ pool: row.dex_pool, price: row.dex_price_usd }))
  check('...so the premium is a market gap, not thousands of percent', Math.abs(row.premium - (4.12 / 4.095 - 1)) < 1e-9, String(row.premium))
  check('...the memecoin pools and the look-alike "USDG" are not counted as eligible', row.pools.eligible === 1 && row.pools.seen === 4)
  check('...and the row validates', validateV2('stock-peg', row).valid)
  const r2 = path.join(tmp, 'djt-2')
  await runStockPeg({ chain: 'robinhood', root: r2, now: () => NOW, paceMs: 0, log: () => {}, fetchImpl: run([memeAsBase, djtOverMeme]) })
  const only = lines(path.join(r2, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))[0]
  check('with only memecoin pools there is no price at all, and the reason is named', only.premium === null && only.dex_price_usd === null && only.premium_refused === 'no_eligible_pool', JSON.stringify({ p: only.premium, r: only.premium_refused }))
}
{
  // The same rule on Base, and for pools GeckoTerminal adds when DexScreener's list is full.
  const root = path.join(tmp, 'meme-base')
  seedCapped(root, [A])
  const coinbase = respond(200, { tokens: [{ contract_address: A, symbol: 'NVDAc', multiplier: '1', nav_price: '100', nav_price_updated_at: '2026-11-08T11:00:00Z', total_supply: '10' }] })
  const thirty = Array.from({ length: 30 }, (_, i) => ({ ...pairOf(A, 101, 20_000), pairAddress: '0x' + String(i + 100).padStart(40, '0') }))
  const gecko = { data: [
    { attributes: { address: '0x' + 'ef'.repeat(20), name: 'MEME / NVDAc', base_token_price_usd: '0.01', quote_token_price_usd: '5000', base_token_price_quote_token: '0.000002', reserve_in_usd: '9000000' }, relationships: { base_token: { data: { id: 'base_' + MEME } }, quote_token: { data: { id: 'base_' + A } } } },
  ] }
  const gRun = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: async (url) => {
    const u = String(url)
    if (u.startsWith(COINBASE_URL)) return coinbase
    if (u.includes('geckoterminal')) return respond(200, u.includes('page=1') || !u.includes('page=') ? gecko : { data: [] })
    return respond(200, thirty)
  } })
  const row = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))[0]
  check('the GeckoTerminal pool was read and merged', gRun.supplemented === 1 && row.pools.seen === 31, JSON.stringify({ sup: gRun.supplemented, seen: row.pools.seen }))
  check('a GeckoTerminal pool against a memecoin does not price the token either, however deep', row.dex_price_usd === 101 && Math.abs(row.premium - 0.01) < 1e-12, JSON.stringify({ price: row.dex_price_usd, premium: row.premium }))
  check('every pool the row keeps is paired with a reference asset', row.pools.top.every((t) => t.quote_symbol === 'USDC'))
}

console.log('the chain as a second source')
{
  // Base, 12.11: DexScreener listed a pool $43,954 deep that held $0.01 of USDC. The chain's figure wins, and a pool the
  // factory knows, which DexScreener did not list, prices the token.
  const cfg = ONCHAIN.base
  const PHANTOM = '0x' + 'f0'.repeat(20), DEEP = '0x' + 'd0'.repeat(20), ETHPOOL = '0x' + 'e7'.repeat(20), WETH = '0x4200000000000000000000000000000000000006'
  const coinbase = respond(200, { tokens: [{ contract_address: A, symbol: 'NVDAc', multiplier: '1', nav_price: '100', nav_price_updated_at: '2026-11-08T11:00:00Z', total_supply: '10' }] })
  const makeChain = (deepPrice = 101) => {
    const chain = fakeChain({ rpc: cfg.rpc })
    chain.erc20(USDC, 6, { [ETHPOOL]: 10n ** 15n, [PHANTOM]: 12_610n, [DEEP]: 600_000n * 10n ** 6n })
    chain.erc20(WETH, 18)
    chain.erc20(A, 18, { [PHANTOM]: 123_325n, [DEEP]: 4_000n * 10n ** 18n })
    chain.getPool(cfg.ethFactory, true, WETH, USDC, 500, ETHPOOL)
    chain.v3(ETHPOOL, WETH, USDC, sqrtX96For(3000, 18, 6))
    // USDC sorts before A, so token0 is USDC and the pools hold USDC per token inverted.
    chain.v3(PHANTOM, USDC, A, sqrtX96For(1 / 102, 6, 18))
    // Both pools come from factories the chain is asked about, as the Aerodrome pools did on 12.11.
    chain.getPool(cfg.factories[2].address, false, A, USDC, 1, PHANTOM)
    chain.getPool(cfg.factories[0].address, true, A, USDC, 500, DEEP)
    chain.v3(DEEP, USDC, A, sqrtX96For(1 / deepPrice, 6, 18))
    return chain
  }
  const listed = (over = {}) => [{ ...pairOf(A, 102, 43_954), pairAddress: PHANTOM, ...over }]
  const base = (dex) => async (url) => {
    const u = String(url)
    if (u.startsWith(COINBASE_URL)) return coinbase
    if (u.includes('/token-pairs/')) return dex()
    return respond(404, {})
  }
  // Every run here points the private store at the test dir, so even a store switched on by mistake writes nowhere else.
  const rawDefault = path.join(tmp, 'stp-raw-default')
  const runWith = async (name, chain, dex, opts = {}) => {
    const root = path.join(tmp, name)
    const run = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, env: { STP_RAW_DIR: rawDefault }, fetchImpl: chain.fetch(base(dex)), ...opts })
    return { run, root, rows: lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl')), runs: lines(path.join(root, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl')) }
  }

  const chain1 = makeChain()
  const one = await runWith('chain-wins', chain1, () => respond(200, listed()))
  const r = one.rows[0]
  check('an empty pool DexScreener calls deep is not the price: the chain says what it holds', r.dex_pool === DEEP && Math.abs(r.premium - 0.01) < 1e-9 && r.pools.eligible === 1 && r.pools.seen === 2, JSON.stringify({ pool: r.dex_pool, premium: r.premium, seen: r.pools.seen }))
  check('...and the row names both sources', r.pools.source === 'dexscreener+onchain' && r.pools.onchain_error === null)
  const ev = r.price_evidence
  check('the price carries the chain\'s evidence: block, hash, calldata and the bytes returned', ev && ev.evidence === 'onchain' && ev.block_number === chain1.block && ev.block_hash === chain1.hash && ev.pool === DEEP && ev.decoder === 'v3_slot0' && /^cast call --block 4242 /.test(ev.reproduce), JSON.stringify(ev && { e: ev.evidence, b: ev.block_number }))
  const again = await chain1.fetch(() => null)(cfg.rpc, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ev.multicall, data: ev.calldata }, '0x' + ev.block_number.toString(16)] }) })
  check('...which the chain gives back byte for byte', (await again.json()).result === ev.return_data)
  check('the evidence covers the DEX leg; the reference is named as an API answer nobody can replay', r.reference_evidence === 'issuer_api_not_reproducible' && ev.reproduce_needs === null)
  check('the row and the run row are valid, and the run says what the chain did', validateV2('stock-peg', r).valid && validateV2('stock-peg-run', one.runs[0]).valid && one.runs[0].onchain.tokens_read === 1 && one.runs[0].onchain.discovered >= 1 && one.runs[0].onchain.rpc === 'public', JSON.stringify(validateV2('stock-peg', r).errors || one.runs[0].onchain).slice(0, 300))
  // A usable directory, so only the switch can keep the store off (the default /var/lib/stp-raw is not writable on every
  // test host, and a store that cannot open is off for that reason instead).
  check('private copies are off unless STP_RAW_SNAPSHOTS=1', openRawStore({ chain: 'base', env: { STP_RAW_DIR: rawDefault } }).on === false && openRawStore({ chain: 'base', env: { STP_RAW_DIR: rawDefault, STP_RAW_SNAPSHOTS: 'true' } }).on === false && !fs.existsSync(rawDefault))
  check('no aggregator answer is copied anywhere by default', !fs.readdirSync(path.join(one.root, 'stock-peg')).some((f) => /raw|snapshot/.test(f)) && !fs.existsSync(rawDefault))
  check('the pool book is kept for the next run', fs.existsSync(path.join(one.root, 'stock-peg', 'pool-book.json')))

  // DexScreener down: the chain prices the pools it knows; the reading is not lost.
  const two = await runWith('dex-down', makeChain(), () => respond(503, {}))
  const d = two.rows[0]
  check('with DexScreener down the chain alone gives the reading', d.pools.source === 'onchain' && d.premium_refused === null && d.dex_pool === DEEP && /503/.test(d.pools.error) && d.price_evidence.evidence === 'onchain', JSON.stringify({ s: d.pools.source, r: d.premium_refused }))
  check('...and the row is valid', validateV2('stock-peg', d).valid)

  // The chain down from the start: today's reading exactly, with the aggregator's answer as its evidence.
  const dead = makeChain(); dead.down = true
  const three = await runWith('chain-down', dead, () => respond(200, listed()))
  const c = three.rows[0] || { pools: {}, price_evidence: undefined }
  check('with the chain down the DexScreener reading stands as it was', c.pools.source === 'dexscreener' && c.dex_pool === PHANTOM && Math.abs(c.premium - 0.02) < 1e-9 && three.runs[0].onchain.error && runExitCode(three.run) === 0, JSON.stringify({ s: c.pools.source, p: c.dex_pool }))
  check('...and its evidence says honestly that there is none: no hash, no source, no flag', JSON.stringify(c.price_evidence) === '{"evidence":"none"}' && !/sha256|[a-f0-9]{64}|snapshot|stored|digest/.test(JSON.stringify(c)), JSON.stringify(c.price_evidence))
  check('...and the rows are valid', validateV2('stock-peg', c).valid && validateV2('stock-peg-run', three.runs[0]).valid)

  // The chain fails after the run began.
  const flaky = makeChain()
  let blocks = 0
  const flakyFetch = (inner) => async (url, init) => { if (String(url) === cfg.rpc && init && /eth_getBlockByNumber/.test(init.body) && ++blocks > 1) return respond(503, {}); return inner(url, init) }
  const root4 = path.join(tmp, 'chain-flaky')
  const run4 = await runStockPeg({ chain: 'base', root: root4, now: () => NOW, paceMs: 0, log: () => {}, env: { STP_RAW_DIR: rawDefault }, fetchImpl: flakyFetch(flaky.fetch(base(() => respond(200, listed())))) })
  const f = lines(path.join(root4, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))[0] || { pools: {} }
  check('a chain read that fails mid-run is named on the row, and the DexScreener reading stands', f.pools.source === 'dexscreener' && /503/.test(f.pools.onchain_error) && f.premium != null && run4.onchain.read_errors === 1 && validateV2('stock-peg', f).valid, JSON.stringify({ s: f.pools.source, e: f.pools.onchain_error }))

  // A pool only DexScreener lists (no factory the chain asks returns it) is learned this run and read from the next.
  const lagChain = makeChain()
  const NEWPOOL = '0x' + 'ce'.repeat(20)
  lagChain.v3(NEWPOOL, USDC, A, sqrtX96For(1 / 102, 6, 18))
  lagChain.erc20(USDC, 6, { [ETHPOOL]: 10n ** 15n, [PHANTOM]: 12_610n, [DEEP]: 600_000n * 10n ** 6n, [NEWPOOL]: 5n * 10n ** 6n })
  lagChain.erc20(A, 18, { [PHANTOM]: 123_325n, [DEEP]: 4_000n * 10n ** 18n, [NEWPOOL]: 0n })
  const lagRoot = path.join(tmp, 'lag')
  const lagRun = () => runStockPeg({ chain: 'base', root: lagRoot, now: () => NOW, paceMs: 0, log: () => {}, env: { STP_RAW_DIR: rawDefault }, fetchImpl: lagChain.fetch(base(() => respond(200, [{ ...pairOf(A, 102, 80_000), pairAddress: NEWPOOL }]))) })
  await lagRun(); await lagRun()
  const [lag1, lag2] = lines(path.join(lagRoot, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  const depthOf = (row) => (row.pools.top.find((t) => t.pair_address === NEWPOOL) || {}).liquidity_usd ?? null
  check('a pool only DexScreener lists keeps its figure on the first run and is read from the chain from the next', depthOf(lag1) === 80_000 && depthOf(lag2) === null && lag2.pools.eligible === 1, JSON.stringify({ first: depthOf(lag1), second: depthOf(lag2) }))

  // The two sources price the same pool more than 2% apart.
  const five = await runWith('disagree', makeChain(101), () => respond(200, [{ ...pairOf(A, 120, 900_000), pairAddress: DEEP }]))
  const x = five.rows[0]
  check('the chain and DexScreener more than 2% apart on the deepest pool refuse the premium', x.premium === null && x.premium_refused === 'sources_disagree' && Math.abs(x.dex_price_usd - 101) < 1e-6 && five.runs[0].refused.sources_disagree === 1, JSON.stringify({ r: x.premium_refused, p: x.dex_price_usd }))
  check('...and the row is valid', validateV2('stock-peg', x).valid)

  // Private copies of the aggregators' answers: off by default; on, outside the dataset, private, rolling, capped, and
  // never at the cost of a reading.
  const rawBase = path.join(tmp, 'stp-raw')
  const envOn = { STP_RAW_SNAPSHOTS: '1', STP_RAW_DIR: rawBase }
  const rawFile = path.join(rawBase, 'base', 'raw-2026-11-08.jsonl.gz')
  fs.mkdirSync(path.join(rawBase, 'base', 'pinned'), { recursive: true })
  fs.writeFileSync(path.join(rawBase, 'base', 'raw-2026-10-01.jsonl.gz'), 'old')
  fs.writeFileSync(path.join(rawBase, 'base', 'raw-2026-10-20.jsonl.gz'), 'recent')
  fs.writeFileSync(path.join(rawBase, 'base', 'pinned', 'raw-2026-09-01.jsonl.gz'), 'dispute')
  const six = await runWith('raw-on', makeChain(), () => respond(200, listed()), { env: envOn })
  const lines6 = fs.existsSync(rawFile) ? zlib.gunzipSync(fs.readFileSync(rawFile)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  check('turned on, the answer behind a premium is copied outside the dataset, with its hash only there', six.rows[0].premium != null && lines6.length === 1 && lines6[0].run_id === six.rows[0].run_id && crypto.createHash('sha256').update(Buffer.from(lines6[0].body, 'utf8')).digest('hex') === lines6[0].sha256 && !rawFile.startsWith(six.root))
  check('...and the public row still carries no hash of it', !JSON.stringify(six.rows[0]).includes(lines6[0]?.sha256 || 'x'))
  check('copies older than 30 days are deleted, a pinned one and a recent one are not', !fs.existsSync(path.join(rawBase, 'base', 'raw-2026-10-01.jsonl.gz')) && fs.existsSync(path.join(rawBase, 'base', 'raw-2026-10-20.jsonl.gz')) && fs.existsSync(path.join(rawBase, 'base', 'pinned', 'raw-2026-09-01.jsonl.gz')))
  if (process.platform !== 'win32') check('the store is private: directories 0700, files 0600', (fs.statSync(path.join(rawBase, 'base')).mode & 0o777) === 0o700 && (fs.statSync(rawFile).mode & 0o777) === 0o600)
  const seven = await runWith('raw-noprem', makeChain(101), () => respond(200, [{ ...pairOf(A, 120, 900_000), pairAddress: DEEP }]), { env: envOn })
  check('a reading with no premium is not copied', seven.rows[0].premium === null && zlib.gunzipSync(fs.readFileSync(rawFile)).toString('utf8').trim().split('\n').length === 1)
  const before = fs.statSync(rawFile).size
  const eight = await runWith('raw-full', makeChain(), () => respond(200, listed()), { env: { ...envOn, STP_RAW_MAX_BYTES: '1' } })
  check('a full store stops writing, and the reading is written all the same', fs.statSync(rawFile).size === before && eight.rows[0].premium != null)
  const blocked = path.join(tmp, 'raw-is-a-file'); fs.writeFileSync(blocked, 'x')
  const nine = await runWith('raw-broken', makeChain(), () => respond(200, listed()), { env: { STP_RAW_SNAPSHOTS: '1', STP_RAW_DIR: blocked } })
  check('a store that cannot be written never costs the reading or fails the run', nine.rows.length === 1 && nine.rows[0].premium != null && runExitCode(nine.run) === 0)
}

console.log('a chain that stops answering mid-run')
{
  // 12.11: a run reached its deadline. A chain that fails token after token can cost two RPC timeouts each; after
  // ONCHAIN_BREAKER failed tokens in a row the run stops asking it, the rows stand on DexScreener, and the book learns on.
  const { ONCHAIN_BREAKER } = await import('./stock-peg.mjs')
  const cfg = ONCHAIN.base
  const N = ONCHAIN_BREAKER + 3
  const tokens = Array.from({ length: N }, (_, i) => '0x' + (0xa1 + i).toString(16).repeat(20))
  const pools = tokens.map((_, i) => '0x' + (0xc1 + i).toString(16).repeat(20))
  const dexPools = tokens.map((_, i) => '0x' + (0x31 + i).toString(16).repeat(20))
  const chain = fakeChain({ rpc: cfg.rpc })
  chain.erc20(USDC, 6, Object.fromEntries(pools.map((p) => [p, 600_000n * 10n ** 6n])))
  tokens.forEach((t, i) => {
    chain.erc20(t, 18, { [pools[i]]: 4_000n * 10n ** 18n })
    chain.getPool(cfg.factories[0].address, true, t, USDC, 500, pools[i])
    chain.v3(pools[i], USDC, t, sqrtX96For(1 / 101, 6, 18))
  })
  const coinbase = respond(200, { tokens: tokens.map((t) => ({ contract_address: t, symbol: 'Xc', multiplier: '1', nav_price: '100', nav_price_updated_at: '2026-11-08T11:00:00Z', total_supply: '10' })) })
  let broken = false, rpcAfterBreak = 0
  const inner = chain.fetch(async (url) => {
    const u = String(url)
    if (u.startsWith(COINBASE_URL)) return coinbase
    const m = u.match(/token-pairs\/v1\/[a-z]+\/(0x[0-9a-f]{40})$/)
    if (m) { broken = true; const i = tokens.indexOf(m[1]); return respond(200, [{ ...pairOf(m[1], 101, 2_000_000), pairAddress: dexPools[i] }]) }
    return respond(404, {})
  })
  // The chain answers the run's start (discovery), then refuses every JSON-RPC request once the token loop has begun.
  const fetchImpl = async (url, init) => {
    if (broken && init && typeof init.body === 'string' && init.body.includes('"jsonrpc"')) { rpcAfterBreak++; return respond(503, {}) }
    return inner(url, init)
  }
  const root = path.join(tmp, 'chain-breaker')
  const run = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, env: { STP_RAW_DIR: path.join(tmp, 'stp-raw-default') }, fetchImpl })
  const rows = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  const runRow = lines(path.join(root, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))[0]
  check('after ONCHAIN_BREAKER failed tokens in a row the run stops asking the chain, and says so', run.onchain.read_errors === ONCHAIN_BREAKER && new RegExp(`after ${ONCHAIN_BREAKER} failed tokens in a row, at token ${ONCHAIN_BREAKER} of ${N}`).test(run.onchain.breaker || ''), JSON.stringify(run.onchain))
  check('...every token still gets its row from DexScreener, and the later rows asked the chain nothing', rows.length === N && rows.slice(ONCHAIN_BREAKER).every((r) => r.pools.source === 'dexscreener' && r.pools.onchain_error === null) && rpcAfterBreak <= ONCHAIN_BREAKER * 2, JSON.stringify({ rows: rows.length, rpcAfterBreak, src: rows.map((r) => r.pools.source) }))
  const book = JSON.parse(fs.readFileSync(path.join(root, 'stock-peg', 'pool-book.json'), 'utf8'))
  check('...and the pool book still learned the pools DexScreener listed after the breaker', Object.values(book.pools).some((e) => e.token === tokens[N - 1] && e.pool === dexPools[N - 1]), Object.keys(book.pools).length + ' pools')
  check('...the run row is valid and counts the refused RPC answers', validateV2('stock-peg-run', runRow).valid && (runRow.timing.rpc_block?.n_failed || 0) + (runRow.timing.rpc_call?.n_failed || 0) >= ONCHAIN_BREAKER, JSON.stringify(runRow.timing))
}

console.log('reference assets come from the chain descriptors')
{
  const { referenceAssetsOf } = await import('./stock-peg.mjs')
  const b = CHAINS.base.referenceAssets, r = CHAINS.robinhood.referenceAssets
  check('Base: USDC and WETH, by address', b.has('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') && b.has('0x4200000000000000000000000000000000000006'))
  check('Robinhood: USDG and WETH', r.has('0x5fc5360d0400a0fd4f2af552add042d716f1d168') && r.size === 2)
  check('addresses are lower-cased', referenceAssetsOf({ stableAssets: ['0xABC'], wrappedNative: '0xDEF' }).has('0xabc'))
}

console.log('the units')
{
  const unit = fs.readFileSync(path.join(ROOT, 'deployment', 'systemd', 'stp-peg.service'), 'utf8')
  const timer = fs.readFileSync(path.join(ROOT, 'deployment', 'systemd', 'stp-peg.timer'), 'utf8')
  check('the service runs from the deployed release', /WorkingDirectory=\/opt\/stp\/current/.test(unit))
  check('the service reads both chains, each into its own dataset root', /--chain=base --root=\/var\/lib\/stp\/base/.test(unit) && /--chain=robinhood --root=\/var\/lib\/stp\/robinhood/.test(unit))
  check('a Base failure does not skip the Robinhood reading', !/stock-peg\.mjs --chain=base[^;]*&&/.test(unit))
  const timeout = Number((/TimeoutStartSec=(\d+)min/.exec(unit) || [])[1]) * 60
  const end = Number((/end=\$\$\(\( \$\$\(date \+%%s\) \+ (\d+) \)\)/.exec(unit) || [])[1])
  check('both chains get a deadline short of the unit timeout, Base an earlier one', end > 0 && end < timeout && /--chain=base --root=\S+ --deadline=\$\$\(\( end - \d+ \)\)/.test(unit) && /--chain=robinhood --root=\S+ --deadline=\$\$end/.test(unit), `${end} ${timeout}`)
  check('the timer fires the service every 15 minutes', /Unit=stp-peg\.service/.test(timer) && /OnCalendar=\*:7\/15/.test(timer))
}

console.log('the exit code')
{
  const ok = { registry: { complete: true }, aborted: undefined, rows_invalid: 0 }
  check('a whole run exits 0', runExitCode(ok) === 0)
  check('a run that died midway exits 1 even with its registry read', runExitCode({ ...ok, aborted: 'boom' }) === 1)
  check('a run that wrote an invalid row exits 1', runExitCode({ ...ok, rows_invalid: 1 }) === 1)
  check('a run without its registry exits 1', runExitCode({ ...ok, registry: { complete: false } }) === 1)
}

console.log('the GeckoTerminal lane')
{
  const { schedule, startLane, needsAggregator, GECKO_BUDGET, GECKO_PACE_MS } = await import('./gecko-lane.mjs')
  const T = Date.parse('2026-11-12T12:00:00Z'), iso = (ms) => new Date(T - ms).toISOString()
  const state = {
    a: { capped_at: iso(60e3), topped_at: iso(3 * 3600e3), pages: 3 },
    b: { capped_at: iso(60e3), topped_at: iso(600e3), pages: 1 },
    c: { capped_at: iso(60e3) },
    d: { capped_at: iso(48 * 3600e3) },
    e: { capped_at: iso(60e3), topped_at: iso(60e3), pages: 1, needs_aggregator: true },
  }
  const plan = schedule(state, ['a', 'b', 'c', 'd', 'e', 'z'], 6, T)
  check('the plan: never or longest without a top-up first, a token needing the aggregator an hour older; a stale cap is left out', JSON.stringify(plan) === JSON.stringify(['c', 'a', 'e']), JSON.stringify(plan))
  check('...within the budget, a token costing the pages it took last time', JSON.stringify(schedule(state, ['a', 'b', 'c'], 3, T)) === JSON.stringify(['c', 'b']) && schedule(state, ['a'], 0, T).length === 0)
  check('the pace and budgets keep under the keyless limit of about 5 calls a minute', GECKO_PACE_MS >= 12_000 && GECKO_BUDGET.robinhood * GECKO_PACE_MS <= 150e3 && GECKO_BUDGET.base * GECKO_PACE_MS <= 60e3)
  let t = 0, asked = []
  const lane = startLane({ fetchImpl: null, network: 'base', addresses: ['p', 'q', 'r'], paceMs: 0, stopAt: 2, now: () => t, read: async (_f, _n, a) => { asked.push(a); t++; if (a === 'q') throw new Error('429'); return { pairs: [], more: false, snaps: [] } } })
  const got = await Promise.all(['p', 'q', 'r'].map((a) => lane.get(a)))
  const stopping = startLane({ fetchImpl: null, network: 'base', addresses: ['s1', 's2'], paceMs: 0, read: async () => ({ pairs: [], more: false, snaps: [] }) })
  stopping.stop()
  const afterStop = await Promise.all([stopping.get('s1'), stopping.get('s2')])
  check('a lane stopped by the run asks nothing more: the request in flight ends, the rest are skipped', afterStop[1].skipped === true)
  check('the lane asks one at a time, turns a failure into an error answer, and skips what is left at its stop time', JSON.stringify(asked) === JSON.stringify(['p', 'q']) && Array.isArray(got[0].pairs) && /429/.test(got[1].error) && got[2].skipped === true)
  check('needsAggregator: a v4 pool id or an undecodable pool only GeckoTerminal saw; not one DexScreener listed too', needsAggregator([{ pairAddress: '0x1' }], [{ pairAddress: '0x' + 'a'.repeat(64) }], {}) && needsAggregator([], [{ pairAddress: '0xbb' }], { pools: { '0xbb': { decoder: 'none' } } }) && !needsAggregator([{ pairAddress: '0xcc' }], [{ pairAddress: '0xCC', dexId: 'uniswap-v4' }], {}) && !needsAggregator([], [{ pairAddress: '0x' + 'd'.repeat(40), dexId: 'aerodrome' }], {}))
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
