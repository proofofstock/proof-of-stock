// scripts/stocks/impostor-list.mjs — the tokens in our dataset that present themselves as an issuer-listed stock they are
// not, written as one small JSON file the public passport site can show (apps/stocks-web.mjs reads it).
//
// A oneshot on a timer (deployment/systemd/stp-impostors.{service,timer}), every 6 hours: it walks every static
// day file of a chain, which takes minutes on Robinhood, so it never runs on a request path.
//
// ⚠ ONLY THE STRONG CLAIMS ARE LISTED (evm/core/stocks/impostor.mjs): the exact issuer symbol (`NVDAc`) and the issuer's
// naming convention ("… Robinhood Token"). A memecoin that borrows a ticker is counted, not listed — publishing it as an
// impostor would accuse it of something it may not be doing.
// ⚠ A LISTED TOKEN IS A CLAIM WITH EVIDENCE, NOT A VERDICT. Each item carries what it imitates and the official
// contract, so a reader can check; the file says the same in `note`.
//
// Output: <root>/stock-peg/impostors.json, and <root>/stock-peg/stock-names.json — the symbol and name, from our own
// dataset, of every token that resembles an issuer token in any way (ticker borrowers included), so the public site can
// name a token outside the registry without asking anyone (apps/stocks-web.mjs makes no outbound call for a name).
// Both are written to a temporary file and renamed, so a reader never sees half of one.
// Usage: node scripts/stocks/impostor-list.mjs --chain=base|robinhood [--root=<dataset root>]

import fs from 'node:fs'
import path from 'node:path'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { eachJsonl, dayFiles } from '../lib/jsonl.mjs'
import { resemblance, resemblances, prefixSelfCheck, RESEMBLANCE_KINDS, ADDRESS_SIGNAL_KINDS } from '../../evm/core/stocks/impostor.mjs'
import { CHAINS } from './stock-peg.mjs'
import { recordCases } from '../../evm/core/stocks/history.mjs'
import { validateV2 } from '../../schemas/v2/validate.mjs'

export const STRONG_KINDS = Object.freeze(['registry_symbol', 'issuer_name_suffix'])
// A safety cap on the file, not a display limit: the site's verify lookup is built from every item (the API pages them).
export const MAX_ITEMS = 20_000
export const MAX_NAMES = 100_000
// The internal radar file (W2-static). Nothing under apps/ reads it; it stays internal until W2c (docs/stocks-truth-layer-tz.md).
export const INTERNAL_FILE = 'impostor-signals.internal.json'
export const MAX_INTERNAL_CANDIDATES = 5_000

export async function buildImpostorList ({ chain, root, fetchImpl = fetch, now = () => Date.now() }) {
  const C = CHAINS[chain]
  if (!C) throw new Error(`unknown chain ${chain}`)
  const registry = await C.read(fetchImpl, { chainId: C.chainId })
  const regSet = new Set(registry.map((r) => r.address))
  const tok = new Map() // address → { symbol, name, first, deployer }
  let tornFiles = 0
  for (const f of dayFiles(root, 'static', 'token-static-')) {
    try {
      // A damaged line in the middle may be a token this list now misses: the file counts as torn, so no case closes.
      const bad = await eachJsonl(f, (o) => {
        const a = String(o.token_address || '').toLowerCase()
        if (!/^0x[0-9a-f]{40}$/.test(a) || regSet.has(a)) return
        const at = Date.parse(o.observed_at)
        let t = tok.get(a)
        if (!t) { t = { symbol: null, name: null, first: null, deployer: null }; tok.set(a, t) }
        if (t.symbol == null && o.symbol) t.symbol = String(o.symbol)
        if (t.name == null && o.name) t.name = String(o.name)
        if (t.deployer == null && o.deployer) t.deployer = String(o.deployer).toLowerCase()
        if (Number.isFinite(at) && (t.first == null || at < t.first)) t.first = at
      })
      if (bad) tornFiles++
    } catch (_) { tornFiles++ }
  }
  // Most tokens reach token-static before their deployer is known; the deployer backfill writes it later to its own
  // sidecar (docs/deployer-backfill-tz.md, deployers/token-deployer-*.jsonl). Only found rows fill a gap; a miss stays null.
  for (const f of dayFiles(root, 'deployers', 'token-deployer-')) {
    try {
      await eachJsonl(f, (o) => {
        const t = tok.get(String(o.token_address || '').toLowerCase())
        if (t && t.deployer == null && o.deployer) t.deployer = String(o.deployer).toLowerCase()
      })
    } catch (_) { tornFiles++ }
  }
  const counts = Object.fromEntries(RESEMBLANCE_KINDS.map((k) => [k, 0]))
  const items = []
  const names = {}
  let named = 0
  // W2-static's internal radar (evm/core/stocks/impostor.mjs, resemblances()). ⚠ It changes NOTHING above: the items,
  // counts and names keep coming from resemblance(), and the address signals go only into `internal`, which the entry
  // point writes to its own file that the site never reads, until W2c has measured their precision.
  const prefixCheck = prefixSelfCheck(registry, chain)
  const signalCounts = Object.fromEntries(ADDRESS_SIGNAL_KINDS.map((k) => [k, 0]))
  const itemSignals = {} // address of a published item → the internal signals it also carries
  const candidates = [] // tokens flagged by an internal signal only
  for (const [address, t] of tok) {
    const all = resemblances({ address, symbol: t.symbol, name: t.name }, registry, { chain, prefixCheck })
    const signals = all.hits.filter((h) => ADDRESS_SIGNAL_KINDS.includes(h.kind))
    for (const s of signals) signalCounts[s.kind]++
    const published = (t.symbol || t.name) ? resemblance({ address, symbol: t.symbol, name: t.name }, registry) : null
    if (signals.length) {
      const brief = signals.map((s) => ({ kind: s.kind, registry_symbol: s.registry_symbol, registry_address: s.registry_address, ...(s.zeros != null ? { zeros: s.zeros } : {}) }))
      if (published && STRONG_KINDS.includes(published.kind)) itemSignals[address] = brief
      else candidates.push({ address, symbol: t.symbol, name: t.name, signals: brief, name_kind: published ? published.kind : null,
        first_seen_at: t.first != null ? new Date(t.first).toISOString() : null, deployer: t.deployer })
    }
    const r = published // null for a token with neither symbol nor name, exactly as before
    if (!r) continue
    counts[r.kind]++
    if (named < MAX_NAMES) { names[address] = [t.symbol, t.name]; named++ }
    if (!STRONG_KINDS.includes(r.kind)) continue
    items.push({ address, symbol: t.symbol, name: t.name, kind: r.kind, ticker: r.ticker, registry_symbol: r.registry_symbol, registry_address: r.registry_address,
      first_seen_at: t.first != null ? new Date(t.first).toISOString() : null, deployer: t.deployer })
  }
  items.sort((a, b) => STRONG_KINDS.indexOf(a.kind) - STRONG_KINDS.indexOf(b.kind) || String(b.first_seen_at).localeCompare(String(a.first_seen_at)))
  return {
    generated_at: new Date(now()).toISOString(), chain, chain_id: C.chainId, issuer: C.issuer,
    note: 'Tokens outside the issuer registry whose symbol or name claims an issuer token. A claim with evidence, not a verdict.',
    registry_records: registry.length, tokens_scanned: tok.size, torn_files: tornFiles, counts,
    listed: Math.min(items.length, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS), truncated: items.length > MAX_ITEMS, items: items.slice(0, MAX_ITEMS),
    names,
    registry_addresses: regSet,
    internal: {
      generated_at: new Date(now()).toISOString(), chain, chain_id: C.chainId,
      note: 'INTERNAL. Address-level radar signals, not published until their precision is measured (docs/stocks-truth-layer-tz.md §W2c).',
      prefix_check: prefixCheck, signal_counts: signalCounts, item_signals: itemSignals,
      candidates: candidates.length, truncated: candidates.length > MAX_INTERNAL_CANDIDATES,
      internal_candidates: candidates.slice(0, MAX_INTERNAL_CANDIDATES),
    },
  }
}

/** The names file the site reads: address → [symbol, name] for every token that resembles an issuer token. */
export function namesFile (list) {
  return { generated_at: list.generated_at, chain: list.chain, chain_id: list.chain_id, count: Object.keys(list.names).length, names: list.names }
}

export function writeAtomically (file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj))
  fs.renameSync(tmp, file)
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const chain = arg('chain')
  const DEFAULT_ROOT = { base: '/var/lib/stp/base', robinhood: '/var/lib/stp/robinhood' }
  const root = path.resolve(arg('root') || DEFAULT_ROOT[chain] || '.')
  const at = Date.now()
  const { names, internal, registry_addresses: registryAddresses, ...list } = await buildImpostorList({ chain, root, now: () => at })
  writeAtomically(path.join(root, 'stock-peg', 'impostors.json'), list)
  writeAtomically(path.join(root, 'stock-peg', 'stock-names.json'), namesFile({ ...list, names }))
  writeAtomically(path.join(root, 'stock-peg', INTERNAL_FILE), internal)
  console.log('[stock-impostors] ' + JSON.stringify({ chain, scanned: list.tokens_scanned, counts: list.counts, listed: list.listed, torn_files: list.torn_files,
    prefix_check: internal.prefix_check.active ? 'on' : `off:${internal.prefix_check.reason}` }))
  // The self-check firing on Base means Coinbase changed its deploy pattern: say it loudly in the journal.
  if (chain === 'base' && !internal.prefix_check.active) console.error('[stock-impostors] ALARM prefix signals off: ' + internal.prefix_check.reason)
  // H1: the case archive (docs/stocks-truth-layer-tz.md §H). After the public files, so a failure here never withholds
  // the list; but it fails the unit, because a gap in an append-only history cannot be filled later.
  try {
    const h = recordCases({ root, list, registry: registryAddresses, chainId: CHAINS[chain].chainId, at, validate: validateV2, log: console.error })
    console.log('[stock-impostors] history ' + JSON.stringify({ chain, ...h }))
    if (h.invalid) process.exitCode = 1
  } catch (e) { console.error('[stock-impostors] ALARM case archive not written: ' + (e && e.message || e)); process.exitCode = 1 }
}
