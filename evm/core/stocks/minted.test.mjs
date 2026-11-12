// evm/core/stocks/minted.test.mjs: nothing says a Robinhood token is minted, because Robinhood's API reports no supply
// (spec 1.2, 12.11). One function decides (registries.mjs mintedOf); every place that answers "minted" uses it.
//
// Run: node evm/core/stocks/minted.test.mjs
import { mintedOf, readRobinhood } from './registries.mjs'
import { canonicalRegistry, registryHash } from './history.mjs'
import { findAcross, matrix } from './cross-chain.mjs'
import { verifyToken } from './verify.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20)
const ISIN = 'US88160R1014'

console.log('mintedOf')
check('Coinbase with supply is minted, without is not', mintedOf({ issuer: 'coinbase', supplied: true }) === true && mintedOf({ issuer: 'coinbase', supplied: false }) === false)
check('Robinhood is unknown whatever its record says', mintedOf({ issuer: 'robinhood', supplied: true }) === null && mintedOf({ issuer: 'robinhood', supplied: false }) === null)
check('a record that says its supply is unknown is unknown', mintedOf({ issuer: 'other', supplied: true, supply_known: false }) === null)
check('no record, no answer', mintedOf(null) === null)

console.log('the Robinhood reader')
const body = { assets: [{ tokenSymbol: 'TSLA', tokenName: 'Tesla', isin: ISIN, currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: B }] }] }
const fetchImpl = async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes('/prices') ? { quotes: [] } : body) })
const rh = await readRobinhood(fetchImpl, { chainId: 4663 })
check('its records say supply_known: false, and still supplied: true so the recorder reads them', rh[0].supply_known === false && rh[0].supplied === true)
check('registry_hash ignores supply_known: the archive\'s hashes do not move', registryHash(canonicalRegistry(rh)) === registryHash(canonicalRegistry(rh.map(({ supply_known: _, ...r }) => r))))

console.log('every answer that says "minted"')
const cb = { issuer: 'coinbase', chain_id: 8453, address: A, symbol: 'TSLAc', name: 'Tesla', isin: ISIN, multiplier: 1, supplied: true, reference: { price_usd: 1 } }
const byChain = { base: { records: [cb], window: null }, robinhood: { records: rh, window: null } }
const found = findAcross(byChain, 'TSLA').matches
check('find: Coinbase true, Robinhood null', found.find((m) => m.chain === 'base')?.minted === true && found.find((m) => m.chain === 'robinhood')?.minted === null, JSON.stringify(found.map((m) => [m.chain, m.minted])))
const row = matrix(byChain, { now: Date.parse('2026-11-12T12:00:00Z') }).rows[0]
check('matrix: the Robinhood cell says minted null, and no reading is no_readings, never not_minted', row.robinhood.minted === null && row.robinhood.premium_refused === 'no_readings' && row.base.minted === true, JSON.stringify(row.robinhood))
const v = verifyToken({ chain: 'robinhood', issuer: 'robinhood', address: B, records: rh, registryAt: 1, now: 2, impostor: null, delisted: null, otherChains: [] })
check('verify: Robinhood minted null', v.body.minted === null)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
