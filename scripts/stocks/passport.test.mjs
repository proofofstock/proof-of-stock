// scripts/stocks/passport.test.mjs: the passport CLI reads only the token's own readings in the window and, for a
// token outside the registry, our newest static name; the census counts resemblances and prints no token.
//
// Run: node scripts/stocks/passport.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { passportFor } from './passport.mjs'
import { census } from './impostor-census.mjs'
import { COINBASE_URL } from '../../evm/core/stocks/registries.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-passport-'))
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), X = '0x' + 'ee'.repeat(20), Y = '0x' + 'ff'.repeat(20), Z = '0x' + '12'.repeat(20)
const NOW = Date.parse('2026-11-08T14:00:00Z')
const fetchImpl = async (url) => {
  if (String(url).startsWith(COINBASE_URL)) return { ok: true, status: 200, json: async () => ({ tokens: [{ contract_address: A, symbol: 'NVDAc', name: 'NVIDIA', isin: 'US1', multiplier: '1', nav_price: '180', nav_price_updated_at: '2026-11-06T21:00:00Z', total_supply: '5' }] }) }
  return { ok: false, status: 404, json: async () => ({}) }
}
const write = (rel, rows) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n') }
const peg = (addr, iso, premium) => ({ token_address: addr, observed_at: iso, multiplier: 1, multiplier_pending: null, paused: [], reference: { kind: 'nav_total_return', price_usd: 180, updated_at: '2026-11-06T21:00:00Z', age_s: 1, halted: null }, pools: { seen: 1, eligible: 1, capped: false, top: [] }, dex_price_usd: 180, dex_pool: '0xp', premium, premium_refused: null })

write('stock-peg/stock-peg-2026-11-08.jsonl', [peg(A, '2026-11-08T13:45:00Z', 0.02), peg(B, '2026-11-08T13:45:00Z', 0.5)])
write('stock-peg/stock-peg-2026-11-01.jsonl', [peg(A, '2026-11-01T13:45:00Z', 0.9)])
write('stock-peg/stock-peg-runs-2026-11-08.jsonl', [{ run_id: 'r' }])
write('static/token-static-2026-11-07.jsonl', [{ token_address: X, symbol: 'NVDAc', name: 'NVIDIA' }, { token_address: Y, symbol: 'NVDA', name: 'nvda meme' }, { token_address: Z, symbol: 'PEPE', name: 'Pepe' }, { token_address: A, symbol: 'NVDAc', name: 'NVIDIA' }])
write('static/token-static-2026-11-08.jsonl', [{ token_address: X, symbol: 'NVDAc', name: 'NVIDIA xStock' }])

console.log('passport')
{
  const p = await passportFor({ chain: 'base', address: A, root: tmp, now: NOW, fetchImpl })
  check('a registry token gets its own readings only', p.in_registry && p.series.readings === 1 && p.latest.premium === 0.02, JSON.stringify(p.series))
  check('readings older than the window are not read', p.series.premium_all.max === 0.02)
  const f = await passportFor({ chain: 'base', address: X, root: tmp, now: NOW, fetchImpl })
  check('an impostor gets the newest static name and the strong resemblance', f.in_registry === false && f.identity.name === 'NVIDIA xStock' && f.resembles.kind === 'registry_symbol')
  let threw = false
  try { await passportFor({ chain: 'base', address: 'nvda', root: tmp, now: NOW, fetchImpl }) } catch (_) { threw = true }
  check('a malformed address is refused', threw)
}

console.log('census')
{
  const c = await census({ chain: 'base', root: tmp, fetchImpl })
  check('counts tokens by resemblance kind', c.resembling.registry_symbol === 1 && c.resembling.ticker === 1 && c.resembling.issuer_name_suffix === 0, JSON.stringify(c.resembling))
  check('a registry token in the dataset is counted apart', c.registry_tokens_in_dataset === 1 && c.tokens_with_identity === 4)
  check('the output names tickers, never a non-registry address', !JSON.stringify(c).includes(X) && !JSON.stringify(c).includes(Y))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
