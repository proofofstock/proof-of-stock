// docs/reference/passport-schema.test.mjs: the reference schema (docs/reference/passport.schema.json) against real
// answers: it starts the site on synthetic fixtures (tmp dirs, a fake fetch, no network) and validates what
// GET /stocks/api/passport and the MCP tool stock_passport return, for an issuer-listed token on each chain, an
// impostor, an unknown token and a listed token that is not minted yet. If the code changes the passport's shape, this
// fails, and the reference page has to change with it.
//
// Run: node docs/reference/passport-schema.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createStocksWeb } from '../../apps/stocks-web.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../../evm/core/stocks/registries.mjs'
import { NOTE_CODES } from '../../evm/core/stocks/passport.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}

const schemaFile = new URL('./passport.schema.json', import.meta.url)
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
const { $schema: _s, ...body } = schema
const validate = ajv.compile(body)
const errorsOf = () => JSON.stringify(validate.errors || []).slice(0, 600)

// Synthetic addresses and time: a Tuesday during the regular session (10:00 in New York).
const A = '0x' + 'aa'.repeat(20) // NVDAc, Coinbase, minted, with readings
const M = '0x' + 'ab'.repeat(20) // AAPLc, Coinbase, listed but not minted
const X = '0x' + 'ee'.repeat(20) // an impostor copying NVDAc
const U = '0x' + '77'.repeat(20) // a token nobody names
const N = '0x' + 'cc'.repeat(20) // NVDA, Robinhood, same ISIN as NVDAc
const POOL_A = '0x' + 'a1'.repeat(20), POOL_N = '0x' + 'c1'.repeat(20)
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const DEPLOYER = '0x' + 'de'.repeat(20)
const NOW = Date.parse('2026-11-10T15:00:00Z')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-schema-'))
const baseRoot = path.join(tmp, 'base'), rhRoot = path.join(tmp, 'rh')
for (const d of [baseRoot, rhRoot]) fs.mkdirSync(path.join(d, 'stock-peg'), { recursive: true })

// T: TSLAc, a NAV last updated on Friday, two days before any reading the server holds.
const T = '0x' + 'ad'.repeat(20)
const T_NAV_AT = '2026-11-06T21:00:00Z'
const baseRow = (iso, premium, { token = A, symbol = 'NVDAc', isin = 'US67066G1040', navAt = '2026-11-10T14:40:00Z' } = {}) => ({
  _schema_version: '1.0', run_id: 'r', observed_at: iso, chain_id: 8453, issuer: 'coinbase', token_address: token, symbol, isin,
  multiplier: 1.011, multiplier_pending: null, paused: [],
  reference: { kind: 'nav_total_return', price_usd: 180, bid: null, ask: null, updated_at: navAt, age_s: Math.round((Date.parse(iso) - Date.parse(navAt)) / 1000), halted: null },
  pools: { source: 'dexscreener', seen: 4, eligible: 1, capped: false, error: null, top: [{ pair_address: POOL_A, dex_id: 'uniswap', quote_symbol: 'USDC', price_usd: 180 * (1 + premium), side: 'base', liquidity_usd: 2e6, volume_h24_usd: 5e5 }] },
  dex_price_usd: 180 * (1 + premium), dex_pool: POOL_A, premium, premium_refused: null, dex_inside_quote: null,
})
const tsla = { token: T, symbol: 'TSLAc', isin: 'US88160R1014', navAt: T_NAV_AT }
fs.writeFileSync(path.join(baseRoot, 'stock-peg', 'stock-peg-2026-11-09.jsonl'), [baseRow('2026-11-09T20:00:00Z', 0.003), baseRow('2026-11-09T20:00:00Z', 0.05, tsla)].map((r) => JSON.stringify(r)).join('\n') + '\n')
fs.writeFileSync(path.join(baseRoot, 'stock-peg', 'stock-peg-2026-11-10.jsonl'), [baseRow('2026-11-10T14:30:00Z', 0.004), baseRow('2026-11-10T14:45:00Z', 0.0025), baseRow('2026-11-10T14:45:00Z', 0.01, tsla)].map((r) => JSON.stringify(r)).join('\n') + '\n')
// Q: TSLA on Robinhood, same ISIN as TSLAc, quoted by Robinhood but never read by our recorder.
const Q = '0x' + 'cd'.repeat(20)

// A Robinhood row: a token bid/ask reference with its spread, priced from a quote-side pool.
const rhRow = {
  _schema_version: '1.0', run_id: 'r', observed_at: '2026-11-10T14:45:00Z', chain_id: 4663, issuer: 'robinhood', token_address: N, symbol: 'NVDA', isin: 'US67066G1040',
  multiplier: 1, multiplier_pending: null, paused: [],
  reference: { kind: 'token_bid_ask_mid', price_usd: 180.05, bid: 180, ask: 180.1, spread: 0.1 / 180.05, updated_at: '2026-11-10T14:44:00Z', quoted_at: '2026-11-10T14:45:00Z', age_s: 60, halted: false },
  pools: { source: 'dexscreener', seen: 2, eligible: 1, capped: false, error: null, top: [{ pair_address: POOL_N, dex_id: 'uniswap', quote_symbol: 'WETH', price_usd: 180.5, side: 'quote', liquidity_usd: 50000, volume_h24_usd: 1000 }] },
  dex_price_usd: 180.5, dex_pool: POOL_N, premium: 180.5 / 180.05 - 1, premium_refused: null, dex_inside_quote: false,
}
fs.writeFileSync(path.join(rhRoot, 'stock-peg', 'stock-peg-2026-11-10.jsonl'), JSON.stringify(rhRow) + '\n')

// The files the impostor timer writes: the names of outside tokens, and the impostor list.
fs.writeFileSync(path.join(baseRoot, 'stock-peg', 'stock-names.json'), JSON.stringify({ generated_at: '2026-11-10T12:00:00Z', chain: 'base', count: 1, names: { [X]: ['NVDAc', 'NVIDIA'] } }))
fs.writeFileSync(path.join(baseRoot, 'stock-peg', 'impostors.json'), JSON.stringify({
  generated_at: '2026-11-10T12:00:00Z', chain: 'base', note: 'synthetic', counts: { registry_symbol: 1, issuer_name_suffix: 0, ticker: 0 }, listed: 1, more: 0, truncated: false,
  items: [{ address: X, symbol: 'NVDAc', name: 'NVIDIA', kind: 'registry_symbol', ticker: 'NVDA', registry_symbol: 'NVDAc', registry_address: A, first_seen_at: '2026-11-09T08:00:00.000Z', deployer: DEPLOYER }],
}))

const fetchImpl = async (url) => {
  const u = String(url)
  const ok = (b) => ({ ok: true, status: 200, json: async () => b })
  if (u.startsWith(COINBASE_URL)) {
    return ok({ tokens: [
      { contract_address: A, symbol: 'NVDAc', name: 'NVIDIA', isin: 'US67066G1040', multiplier: '1.011', nav_price: '180', nav_price_updated_at: '2026-11-10T14:40:00Z', total_supply: '5' },
      // Coinbase omits default fields: no total_supply means none minted, no nav_price means no feed.
      { contract_address: M, symbol: 'AAPLc', name: 'Apple', isin: 'US0378331005', multiplier: '1' },
      { contract_address: T, symbol: 'TSLAc', name: 'Tesla', isin: 'US88160R1014', multiplier: '1.011', nav_price: '180', nav_price_updated_at: T_NAV_AT, total_supply: '5' },
    ] })
  }
  if (u.startsWith(ROBINHOOD_ASSETS_URL)) {
    return ok({ assets: [
      { tokenSymbol: 'NVDA', tokenName: 'NVIDIA  Robinhood Token', isin: 'US67066G1040', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: N }] },
      { tokenSymbol: 'TSLA', tokenName: 'Tesla  Robinhood Token', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: Q }] },
    ] })
  }
  if (u.startsWith(ROBINHOOD_PRICES_URL)) {
    return ok({ quotes: [
      { tokenSymbol: 'NVDA', bid: '180', ask: '180.1', tokenBid: '180', tokenAsk: '180.1', generatedAt: '2026-11-10T14:59:30Z', isTradingHalt: false },
      { tokenSymbol: 'TSLA', bid: '400', ask: '400.2', tokenBid: '400', tokenAsk: '400.2', generatedAt: '2026-11-10T14:59:30Z', isTradingHalt: false },
    ] })
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

const app = createStocksWeb({ roots: { base: baseRoot, robinhood: rhRoot }, fetchImpl, now: () => NOW, log: () => {} })
const { port } = await app.start(0, '127.0.0.1')
const passport = async (chain, address, extra = '') => {
  const r = await fetch(`http://127.0.0.1:${port}/stocks/api/passport?chain=${chain}&address=${address}${extra}`)
  return { status: r.status, body: await r.json() }
}
let rpcId = 0
const mcpPassport = async (args) => {
  const r = await fetch(`http://127.0.0.1:${port}/stocks/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.40' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'stock_passport', arguments: args } }) })
  return (await r.json()).result
}

console.log('the schema itself')
{
  check('it is draft-07 and compiles', schema.$schema === 'http://json-schema.org/draft-07/schema#' && typeof validate === 'function')
  check('its note codes are exactly NOTE_CODES', JSON.stringify([...schema.definitions.note.enum].sort()) === JSON.stringify([...NOTE_CODES].sort()))
}

console.log('an issuer-listed token (Base)')
{
  const { status, body: p } = await passport('base', A)
  check('200', status === 200)
  check('validates against the schema', validate(p), errorsOf())
  check('it is the in-registry shape, with a reference and a latest reading', p.in_registry === true && p.reference.kind === 'nav_total_return' && p.latest.premium === 0.0025)
  check('the premium is the deepest eligible pool over the reference, minus one', Math.abs(p.latest.dex_price_usd / p.reference.price_usd - 1 - p.latest.premium) < 1e-12)
  check('premium_at_reference_time is the first reading at or after the reference update', Date.parse(p.latest.premium_at_reference_time.observed_at) === Date.parse('2026-11-10T14:45:00Z') && p.latest.premium_at_reference_time.lag_s === 300, JSON.stringify(p.latest.premium_at_reference_time))
  check('ages are seconds before generated_at', p.reference.age_s === 1200 && p.latest.age_s === 900)
  check('the same share elsewhere is matched by ISIN', p.same_stock_elsewhere.length === 1 && p.same_stock_elsewhere[0].chain === 'robinhood' && p.same_stock_elsewhere[0].address === N)
  check('...and its reference age is measured now, not at its reading', p.same_stock_elsewhere[0].latest.reference_age_s === 960, String(p.same_stock_elsewhere[0].latest.reference_age_s))
  check('a Coinbase token says minted true', p.issuer.minted === true)
  check('the HTTP answer carries no series_points unless asked', !('series_points' in p))
  const ps = (await passport('base', A, '&series=1')).body
  check('with series=1 it carries series_points and still validates', validate(ps) && ps.series_points.length === 3 && ps.series_points.every((x) => x.length === 3))
  check('impostor_listing and resembles are null for a listed token', p.impostor_listing === null && p.resembles === null)
  check('the DEX link points at the deepest pool on GeckoTerminal', p.links.dex === `https://www.geckoterminal.com/base/pools/${POOL_A}`)
  check('the pool rule lists the chain\'s reference assets by address', p.sources.pools_counted.paired_with_addresses.includes(USDC_BASE))
  const short = await passport('base', A, '&hours=1&series=1')
  check('hours narrows series and series_points alike', short.body.series.window_h === 1 && short.body.series.readings === 2 && short.body.series_points.length === 2 && short.body.series_points.every(([t]) => t >= NOW - 3600e3) && validate(short.body), errorsOf())
}

console.log('premium_at_reference_time')
{
  const { status, body: p } = await passport('base', T)
  check('a token whose NAV moved before the window: 200 and validates', status === 200 && validate(p), errorsOf())
  check('...gives null, never the oldest reading days later', p.latest.premium != null && p.latest.premium_at_reference_time === null, JSON.stringify(p.latest.premium_at_reference_time))
  const { body: a } = await passport('base', A, '&hours=1')
  check('within 1800 s of the reference move, inside the window, it is that reading', a.latest.premium_at_reference_time && a.latest.premium_at_reference_time.lag_s === 300 && a.latest.premium_at_reference_time.lag_s <= 1800)
}

console.log('an issuer-listed token (Robinhood)')
{
  const { status, body: p } = await passport('robinhood', N)
  check('200 and validates', status === 200 && validate(p), errorsOf())
  check('the reference is the token bid/ask mid, with its spread as a fraction', p.reference.kind === 'token_bid_ask_mid' && p.reference.bid === 180 && p.reference.ask === 180.1 && Math.abs(p.reference.spread - 0.1 / 180.05) < 1e-12)
  check('dex_inside_quote says the on-chain price is outside the issuer quote', p.latest.dex_inside_quote === false)
  check('a quote-side pool keeps its side', p.latest.pools.top[0].side === 'quote')
  check('a Robinhood token says minted null: Robinhood reports no supply', p.issuer.minted === null)
  check('the schema refuses minted true on Robinhood', !validate({ ...p, issuer: { ...p.issuer, minted: true } }))
}

console.log('a Robinhood token with no reading')
{
  const { status, body: p } = await passport('robinhood', Q)
  check('200 and validates', status === 200 && validate(p), errorsOf())
  check('the reference has a price but no age: its time is when Robinhood answered', p.reference.price_usd === 400.1 && p.reference.age_s === null && p.latest === null, JSON.stringify(p.reference))
  check('...so no held note fires, and no_readings is named', !p.notes.some((n) => n.startsWith('reference_held')) && p.notes.includes('no_readings') && p.issuer.minted === null, JSON.stringify(p.notes))
}

console.log('an impostor')
{
  const { status, body: p } = await passport('base', X)
  check('200 and validates', status === 200 && validate(p), errorsOf())
  check('the not-in-registry shape: no issuer, no reference key, no latest, no series', p.in_registry === false && p.issuer === null && !('reference' in p) && p.latest === null && p.series === null)
  check('resembles names what it imitates', p.resembles.kind === 'registry_symbol' && p.resembles.registry_address === A)
  check('impostor_listing carries the list entry, and the deployer address appears nowhere', p.impostor_listing.first_seen_at === '2026-11-09T08:00:00.000Z' && p.impostor_listing.same_deployer_impostors === 0 && !JSON.stringify(p).includes(DEPLOYER))
  check('notes is not_in_registry alone', JSON.stringify(p.notes) === '["not_in_registry"]')
}

console.log('an unknown token')
{
  const { status, body: p } = await passport('base', U)
  check('200 and validates', status === 200 && validate(p), errorsOf())
  check('no name, no resemblance, no listing', p.identity.symbol === null && p.identity.name === null && p.resembles === null && p.impostor_listing === null)
  check('nothing elsewhere and no points', p.same_stock_elsewhere.length === 0 && !('series_points' in p))
}

console.log('a listed token that is not minted')
{
  const { status, body: p } = await passport('base', M)
  check('200 and validates', status === 200 && validate(p), errorsOf())
  check('minted is false, there is no latest, and the notes say not_minted and no_reference but not no_readings', p.issuer.minted === false && p.latest === null && p.notes.includes('not_minted') && p.notes.includes('no_reference') && !p.notes.includes('no_readings'), JSON.stringify(p.notes))
  check('the reference object is there, with a null price', p.reference !== null && p.reference.price_usd === null)
}

console.log('the MCP answer')
{
  const full = await mcpPassport({ chain: 'base', address: A, include_series: true })
  const { summary, ...sc } = full.structuredContent
  check('with include_series, structuredContent minus summary validates', typeof summary === 'string' && validate(sc), errorsOf())
  check('summary equals content[0], and content[1] is the same JSON', full.content[0].text === summary && JSON.parse(full.content[1].text).address === A)
  const lean = await mcpPassport({ chain: 'base', address: A })
  check('without it, series_points is left out', !('series_points' in lean.structuredContent))
}

console.log('the schema is not vacuous')
{
  const { body: p } = await passport('base', A)
  check('a premium given as a percent string is refused', !validate({ ...p, latest: { ...p.latest, premium: '0.25%' } }))
  check('a note that is not a code is refused', !validate({ ...p, notes: [...p.notes, 'looks_fine'] }))
  const { body: f } = await passport('base', X)
  check('a reference on a token outside the registry is refused', !validate({ ...f, reference: null }))
  check('an unknown field is refused', !validate({ ...p, score: 1 }))
}

await app.stop()
fs.rmSync(tmp, { recursive: true, force: true })
if (failed) for (const f of failures) console.log(f)
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
