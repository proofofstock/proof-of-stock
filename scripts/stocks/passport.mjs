// scripts/stocks/passport.mjs: print the passport of one token (evm/core/stocks/passport.mjs) as JSON.
//
// Read-only. It reads the issuer's registry live (its public API), the peg readings recorded in <root>/stock-peg/ for
// the window, and, for a token outside the registry, its symbol and name from our own static rows (newest first). It
// writes nothing. One token per call: this is a lookup, not an export.
//
// Usage: node scripts/stocks/passport.mjs --chain=base|robinhood --address=0x… [--root=<dataset root>] [--hours=72]
//   roots on the server: Base /var/lib/stp/base, Robinhood /var/lib/stp/robinhood

import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { eachJsonl, dayFiles } from '../lib/jsonl.mjs'
import { buildPassport, DEFAULT_WINDOW_H } from '../../evm/core/stocks/passport.mjs'
import { CHAINS } from './stock-peg.mjs'

const IDENTITY_LOOKBACK_DAYS = 45
const day = (ms) => new Date(ms).toISOString().slice(0, 10)
const daysBack = (now, n) => new Set(Array.from({ length: n + 1 }, (_, i) => day(now - i * 864e5)))

/** The token's peg readings in the window. */
export async function readReadings (root, address, now, windowH) {
  const out = []
  const days = daysBack(now, Math.ceil(windowH / 24) + 1)
  for (const f of dayFiles(root, 'stock-peg', 'stock-peg-', days)) {
    try { await eachJsonl(f, (o) => { if (o.token_address === address) out.push(o) }) } catch (_) { /* a torn tail keeps what was read */ }
  }
  return out
}

/** Our dataset's symbol and name for the token: the newest static row that has them, within the lookback. */
export async function readIdentity (root, address, now) {
  const files = dayFiles(root, 'static', 'token-static-', daysBack(now, IDENTITY_LOOKBACK_DAYS)).reverse()
  for (const f of files) {
    let hit = null
    try { await eachJsonl(f, (o) => { if (String(o.token_address || '').toLowerCase() === address && (o.symbol || o.name)) hit = { symbol: o.symbol ?? null, name: o.name ?? null } }) } catch (_) { /* torn tail */ }
    if (hit) return hit
  }
  return {}
}

export async function passportFor ({ chain, address, root, hours = DEFAULT_WINDOW_H, now = Date.now(), fetchImpl = fetch }) {
  const C = CHAINS[chain]
  if (!C) throw new Error(`unknown chain ${chain}: expected one of ${Object.keys(CHAINS).join(', ')}`)
  const addr = String(address || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('address must be 0x + 40 hex characters')
  const registry = await C.read(fetchImpl, { chainId: C.chainId })
  const inRegistry = registry.some((r) => r.address === addr)
  const readings = inRegistry ? await readReadings(root, addr, now, hours) : []
  const identity = inRegistry ? {} : await readIdentity(root, addr, now)
  return buildPassport({ address: addr, chainId: C.chainId, registry, readings, identity, now, windowH: hours })
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const chain = arg('chain')
  const DEFAULT_ROOT = { base: '/var/lib/stp/base', robinhood: '/var/lib/stp/robinhood' }
  try {
    const p = await passportFor({ chain, address: arg('address'), root: path.resolve(arg('root') || DEFAULT_ROOT[chain] || '.'), hours: Number(arg('hours') || DEFAULT_WINDOW_H) })
    console.log(JSON.stringify(p, null, 2))
  } catch (e) {
    console.error('[passport] ' + (e && e.message || e)); process.exitCode = 1
  }
}
