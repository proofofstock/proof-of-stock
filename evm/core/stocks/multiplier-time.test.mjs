// evm/core/stocks/multiplier-time.test.mjs: when an announced multiplier change takes effect. Robinhood added
// pendingMultiplierEffectiveTime to its assets on 20.11.2026 (first seen: SNDK, x8 at 14:30Z). The reader takes it only
// beside an announced change, the passport passes it on, and the canonical list never carries it (its hash would move).
//
// Run: node evm/core/stocks/multiplier-time.test.mjs
import { readRobinhood, readCoinbase, ROBINHOOD_ASSETS_URL, COINBASE_URL } from './registries.mjs'
import { buildPassport } from './passport.mjs'
import { canonicalRegistry } from './history.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const A = '0x' + 'b9'.repeat(20), B = '0x' + 'c1'.repeat(20)
const dep = (a) => [{ chainId: '4663', contractAddress: a }]
const assets = { assets: [
  { tokenSymbol: 'SNDK', tokenName: 'Sandisk', isin: 'US80004C2008', deployments: dep(A), currentMultiplier: '1.000000000000000000', pendingMultiplier: '8.000000000000000000', pendingMultiplierEffectiveTime: '2026-11-20T14:30:00Z', status: 'ASSET_STATUS_ACTIVE' },
  { tokenSymbol: 'TSLA', tokenName: 'Tesla', isin: 'US88160R1014', deployments: dep(B), currentMultiplier: '1.0', pendingMultiplier: '', pendingMultiplierEffectiveTime: '2026-11-21T14:30:00Z', status: 'ASSET_STATUS_ACTIVE' },
] }
const fetchImpl = async (url) => (String(url).startsWith(ROBINHOOD_ASSETS_URL)
  ? { ok: true, status: 200, json: async () => assets }
  : { ok: false, status: 503, json: async () => ({}) })

const list = await readRobinhood(fetchImpl, { chainId: 4663 })
const sndk = list.find((r) => r.address === A), tsla = list.find((r) => r.address === B)
check('an announced change carries when it takes effect, as ISO', sndk.multiplier_pending === 8 && sndk.multiplier_pending_at === '2026-11-20T14:30:00.000Z', JSON.stringify(sndk.multiplier_pending_at))
check('a time with no announced change is not taken', tsla.multiplier_pending == null && tsla.multiplier_pending_at === null)
const cbFetch = async (url) => (String(url).startsWith(COINBASE_URL) ? { ok: true, status: 200, json: async () => ({ tokens: [{ contract_address: A, symbol: 'NVDAc', name: 'NVIDIA', multiplier: '1' }] }) } : { ok: false, status: 404, json: async () => ({}) })
check('Coinbase gives no time: null', (await readCoinbase(cbFetch, { chainId: 8453 }))[0].multiplier_pending_at === null)

const p = buildPassport({ address: A, chainId: 4663, registry: list, readings: [], now: Date.parse('2026-11-20T14:00:00Z') })
check('the passport says when the announced change takes effect', p.issuer.multiplier_pending === 8 && p.issuer.multiplier_pending_at === '2026-11-20T14:30:00.000Z' && p.notes.includes('multiplier_change_pending'), JSON.stringify(p.issuer))
const q = buildPassport({ address: B, chainId: 4663, registry: list, readings: [], now: Date.parse('2026-11-20T14:00:00Z') })
check('...and null where nothing is announced', q.issuer.multiplier_pending_at === null)

const canon = JSON.stringify(canonicalRegistry(list))
check('the canonical list never carries the time, so the list hash does not move with it', !canon.includes('multiplier_pending_at') && !canon.includes('14:30'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
