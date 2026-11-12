// scripts/stocks/impostor-census.mjs: how many tokens in our dataset present themselves as an issuer-listed stock
// they are not, by how strongly (evm/core/stocks/impostor.mjs). AGGREGATES ONLY: counts per kind, and the registry
// tickers most often borrowed with their counts. No token row, address or name of a non-registry token is printed.
//
// Usage: node scripts/stocks/impostor-census.mjs --chain=base|robinhood [--root=<dataset root>]

import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { eachJsonl, dayFiles } from '../lib/jsonl.mjs'
import { resemblance, RESEMBLANCE_KINDS } from '../../evm/core/stocks/impostor.mjs'
import { CHAINS } from './stock-peg.mjs'

export async function census ({ chain, root, fetchImpl = fetch }) {
  const C = CHAINS[chain]
  if (!C) throw new Error(`unknown chain ${chain}`)
  const registry = await C.read(fetchImpl, { chainId: C.chainId })
  const ident = new Map()
  let tornFiles = 0
  for (const f of dayFiles(root, 'static', 'token-static-')) {
    try {
      await eachJsonl(f, (o) => {
        const a = String(o.token_address || '').toLowerCase()
        if (!a || ident.has(a) || !(o.symbol || o.name)) return
        ident.set(a, { symbol: o.symbol ?? null, name: o.name ?? null })
      })
    } catch (_) { tornFiles++ }
  }
  const byKind = Object.fromEntries(RESEMBLANCE_KINDS.map((k) => [k, 0]))
  const tickers = {}
  let inRegistry = 0
  const regSet = new Set(registry.map((r) => r.address))
  for (const [a, id] of ident) {
    if (regSet.has(a)) { inRegistry++; continue }
    const r = resemblance({ address: a, ...id }, registry)
    if (!r) continue
    byKind[r.kind]++
    const key = `${r.kind}:${r.ticker ?? '?'}`
    tickers[key] = (tickers[key] || 0) + 1
  }
  return {
    chain, registry_records: registry.length, tokens_with_identity: ident.size, registry_tokens_in_dataset: inRegistry,
    resembling: byKind, top_borrowed: Object.entries(tickers).sort((a, b) => b[1] - a[1]).slice(0, 12), torn_files: tornFiles,
  }
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const chain = arg('chain')
  const DEFAULT_ROOT = { base: '/var/lib/stp/base', robinhood: '/var/lib/stp/robinhood' }
  console.log(JSON.stringify(await census({ chain, root: path.resolve(arg('root') || DEFAULT_ROOT[chain] || '.') })))
}
