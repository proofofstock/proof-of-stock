// scripts/stocks/stock-peg.test.mjs — one run writes a valid row per supplied token and one manifest row, always; a
// list it could not read writes the manifest and nothing else; a pair read that fails is a refusal, not a gap.
//
// Run: node scripts/stocks/stock-peg.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runStockPeg, CHAINS } from './stock-peg.mjs'
import { validateV2 } from '../../base/dataset-v2/schema-validator.mjs'
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
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const NOW = Date.parse('2026-11-08T12:00:00Z')

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), C = '0x' + 'cc'.repeat(20)
// The chains' real reference assets: a pool prices a stock token only against one of them (evm/core/stocks/peg.mjs).
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const MEME = '0x' + '77'.repeat(20)
const pairOf = (addr, price, liq, quote = USDC, quoteSymbol = 'USDC') => ({ pairAddress: '0x' + '12'.repeat(20), dexId: 'aerodrome', baseToken: { address: addr }, quoteToken: { address: quote, symbol: quoteSymbol }, priceUsd: String(price), liquidity: { usd: liq }, volume: { h24: 5 } })
const respond = (status, body) => ({ ok: status < 400, status, json: async () => body })
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
  check('rows and manifest share the run id', rows.every((r) => r.run_id === runs[0].run_id))
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
  const run = await runStockPeg({ chain: 'base', root, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(false) })
  const [r] = lines(path.join(root, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  check('a full list is completed from GeckoTerminal and says so', r.pools.source === 'dexscreener+geckoterminal' && r.pools.seen === 31 && run.supplemented === 1, `${r.pools.source} ${r.pools.seen}`)
  check('the deeper pool GeckoTerminal found now prices the token', r.dex_pool === '0x' + 'ab'.repeat(20) && Math.abs(r.premium - 0.03) < 1e-12)
  check('a GeckoTerminal page that is not full clears the capped flag', r.pools.capped === false)
  check('the row and the manifest are valid', validateV2('stock-peg', r).valid && validateV2('stock-peg-run', lines(path.join(root, 'stock-peg', 'stock-peg-runs-2026-11-08.jsonl'))[0]).valid)
  const root2 = path.join(tmp, 'capped-429')
  const run2 = await runStockPeg({ chain: 'base', root: root2, now: () => NOW, paceMs: 0, geckoPaceMs: 0, log: () => {}, fetchImpl: gecko(true) })
  const [r2] = lines(path.join(root2, 'stock-peg', 'stock-peg-2026-11-08.jsonl'))
  check('a throttled GeckoTerminal leaves the DexScreener reading as it was', r2.pools.source === 'dexscreener' && r2.pools.seen === 30 && r2.pools.capped === true && run2.supplement_errors === 1)
  check('GeckoTerminal is asked only for full lists', geckoCalls === 2)
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
  check('the timer fires the service every 15 minutes', /Unit=stp-peg\.service/.test(timer) && /OnCalendar=\*:7\/15/.test(timer))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
