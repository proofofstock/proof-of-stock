// scripts/stocks/impostor-list.test.mjs — the list holds only strong claims, never a registry token, with the official
// contract beside each; weak ticker borrowing is counted, not listed; the file is written whole; GeckoTerminal pools
// come back in DexScreener's shape and merge without duplicates.
//
// Run: node scripts/stocks/impostor-list.test.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildImpostorList, writeAtomically, INTERNAL_FILE, MAX_INTERNAL_CANDIDATES } from './impostor-list.mjs'
import { geckoToPairs, mergePairs } from './gecko-pools.mjs'
import { COINBASE_URL } from '../../evm/core/stocks/registries.mjs'

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'impostors-'))
const A = '0x' + 'aa'.repeat(20), X = '0x' + 'e1'.repeat(20), Y = '0x' + 'e2'.repeat(20), Z = '0x' + 'e3'.repeat(20)
const fetchImpl = async (url) => (String(url).startsWith(COINBASE_URL)
  ? { ok: true, status: 200, json: async () => ({ tokens: [{ contract_address: A, symbol: 'NVDAc', name: 'NVIDIA', multiplier: '1' }] }) }
  : { ok: false, status: 404, json: async () => ({}) })
const write = (rel, rows) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n') }
write('static/token-static-2026-11-01.jsonl', [
  { token_address: X, symbol: 'NVDAc', name: 'NVIDIA', observed_at: '2026-11-01T10:00:00Z', deployer: '0x' + 'd1'.repeat(20) },
  { token_address: Y, symbol: 'nvda', name: 'nvda to the moon', observed_at: '2026-11-01T11:00:00Z' },
  { token_address: Z, symbol: 'PEPE', name: 'Pepe', observed_at: '2026-11-01T12:00:00Z' },
  { token_address: A, symbol: 'NVDAc', name: 'NVIDIA', observed_at: '2026-11-01T09:00:00Z' },
])
write('static/token-static-2026-11-02.jsonl', [{ token_address: X, symbol: 'NVDAc', name: 'NVIDIA', observed_at: '2026-10-30T10:00:00Z' }])

console.log('the impostor list')
{
  const l = await buildImpostorList({ chain: 'base', root: tmp, fetchImpl, now: () => Date.parse('2026-11-08T12:00:00Z') })
  check('only the strong claim is listed', l.items.length === 1 && l.items[0].address === X && l.items[0].kind === 'registry_symbol')
  check('it names the official contract it imitates', l.items[0].registry_address === A && l.items[0].registry_symbol === 'NVDAc')
  check('the registry token itself is never listed', !l.items.some((i) => i.address === A))
  check('weak ticker borrowing is counted, not listed', l.counts.ticker === 1 && !l.items.some((i) => i.address === Y))
  check('first seen is the earliest sighting across files', l.items[0].first_seen_at === '2026-10-30T10:00:00.000Z')
  check('the file says a listing is a claim, not a verdict', /not a verdict/.test(l.note))
  check('every resembling token is named from our dataset, ticker borrowers included', l.names[X][0] === 'NVDAc' && l.names[Y][1] === 'nvda to the moon' && !l.names[Z] && !l.names[A])
  const f = path.join(tmp, 'stock-peg', 'impostors.json')
  writeAtomically(f, l)
  check('written whole, with no temporary file left', JSON.parse(fs.readFileSync(f, 'utf8')).items.length === 1 && !fs.readdirSync(path.dirname(f)).some((n) => n.includes('.tmp-')))
}

console.log('a deployer the backfill found later')
{
  const root = path.join(tmp, 'sidecar')
  const w = (rel, rows) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n') }
  w('static/token-static-2026-11-01.jsonl', [{ token_address: X, symbol: 'NVDAc', name: 'NVIDIA', observed_at: '2026-11-01T10:00:00Z' }])
  w('deployers/token-deployer-2026-11-03.jsonl', [{ token_address: X, deployer: null, status: 'miss' }, { token_address: X, deployer: '0x' + 'D2'.repeat(20), status: 'found' }])
  const l = await buildImpostorList({ chain: 'base', root, fetchImpl, now: () => Date.parse('2026-11-08T12:00:00Z') })
  check('a deployer missing from token-static is taken from the backfill sidecar', l.items[0].deployer === '0x' + 'd2'.repeat(20), String(l.items[0].deployer))
}

console.log('the internal radar signals (W2-static)')
{
  // Synthetic Coinbase registry on the full prefix, so the prefix signals are on.
  const CB = '0xb2' + '0'.repeat(24) + '11aa22bb33cc44'
  const COPY = '0xb2' + '0'.repeat(18) + '70' + '0'.repeat(4) + '11aa22bb33cc44' // one middle char changed, symbol copied
  const VAN = '0xb2' + '0'.repeat(5) + 'f'.repeat(33) // partial vanity prefix only
  const FRESH = '0xb2' + '0'.repeat(21) + '5'.repeat(17) // unlisted full prefix
  const TAIL = '0x' + 'de'.repeat(17) + '33cc44' // lookalike tail, no name at all
  const PLAIN = '0x' + 'e4'.repeat(20)
  const fx = async (url) => (String(url).startsWith(COINBASE_URL)
    ? { ok: true, status: 200, json: async () => ({ tokens: [{ contract_address: CB, symbol: 'NVDAc', name: 'NVIDIA', multiplier: '1' }] }) }
    : { ok: false, status: 404, json: async () => ({}) })
  const root = path.join(tmp, 'radar')
  const w = (rel, rows) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n') }
  w('static/token-static-2026-11-01.jsonl', [
    { token_address: COPY, symbol: 'NVDAc', name: 'NVIDIA', observed_at: '2026-11-01T10:00:00Z' },
    { token_address: VAN, symbol: 'PEPE', name: 'Pepe', observed_at: '2026-11-01T10:00:00Z' },
    { token_address: FRESH, symbol: 'AAPLc', name: 'Apple', observed_at: '2026-11-01T10:00:00Z' },
    { token_address: TAIL, observed_at: '2026-11-01T10:00:00Z' },
    { token_address: PLAIN, symbol: 'nvda', name: 'nvda', observed_at: '2026-11-01T10:00:00Z' },
    { token_address: CB, symbol: 'NVDAc', name: 'NVIDIA', observed_at: '2026-11-01T10:00:00Z' },
  ])
  const l = await buildImpostorList({ chain: 'base', root, fetchImpl: fx, now: () => Date.parse('2026-11-08T12:00:00Z') })
  // names, registry_addresses (for the case archive, TZ §H1) and internal are split off by the entry point before
  // impostors.json is written, so the published file keeps exactly the legacy keys.
  const LEGACY_KEYS = 'generated_at,chain,chain_id,issuer,note,registry_records,tokens_scanned,torn_files,counts,listed,more,truncated,items,names,registry_addresses,internal'
  const ITEM_KEYS = 'address,symbol,name,kind,ticker,registry_symbol,registry_address,first_seen_at,deployer'
  check('the published list keeps today\'s keys; the radar sits only under `internal`', Object.keys(l).join() === LEGACY_KEYS, Object.keys(l).join())
  check('published items keep today\'s fields, with no signals on them', l.items.every((i) => Object.keys(i).join() === ITEM_KEYS))
  check('only the strong claim is published: a new signal adds nothing to items', l.items.length === 1 && l.items[0].address === COPY && l.items[0].kind === 'registry_symbol')
  check('the published counts are today\'s kinds only', Object.keys(l.counts).join() === 'registry_symbol,issuer_name_suffix,ticker' && l.counts.ticker === 1)
  check('the names file gains no token flagged by an address signal only', !l.names[VAN] && !l.names[FRESH] && !l.names[TAIL])
  const I = l.internal
  check('the self-check is on for a registry on the full prefix', I.prefix_check.active === true)
  check('a published item\'s internal signals are recorded beside it, internally', I.item_signals[COPY].map((s) => s.kind).join() === 'address_lookalike,vanity_prefix_partial')
  const cand = Object.fromEntries(I.internal_candidates.map((c) => [c.address, c.signals.map((s) => s.kind).join()]))
  check('tokens flagged only by a new signal are internal candidates', cand[VAN] === 'vanity_prefix_partial' && cand[FRESH] === 'unlisted_full_prefix' && cand[TAIL] === 'address_lookalike' && !cand[COPY] && !cand[PLAIN])
  check('the registry token is never a candidate', !cand[CB] && !I.item_signals[CB])
  check('signal counts aggregate every token', I.signal_counts.address_lookalike === 2 && I.signal_counts.vanity_prefix_partial === 2 && I.signal_counts.unlisted_full_prefix === 1, JSON.stringify(I.signal_counts))
  check('the internal file is named internal and capped', /internal/.test(INTERNAL_FILE) && I.truncated === false && MAX_INTERNAL_CANDIDATES > 0)
  const off = await buildImpostorList({ chain: 'base', root: tmp, fetchImpl, now: () => Date.parse('2026-11-08T12:00:00Z') })
  check('a registry address off the prefix turns the prefix signals off, visibly', off.internal.prefix_check.active === false && off.internal.prefix_check.reason === 'registry_address_without_full_prefix')
}

console.log('GeckoTerminal pools')
{
  const body = { data: [
    { attributes: { address: '0xPOOL' + '0'.repeat(36), name: 'NVDAc / USDC 0.05%', base_token_price_usd: '187.1', reserve_in_usd: '845712.45', volume_usd: { h24: '1000' } }, relationships: { base_token: { data: { id: 'base_' + A } }, quote_token: { data: { id: 'base_0x' + '11'.repeat(20) } }, dex: { data: { id: 'aero-slipstream-base' } } } },
    { attributes: { name: 'broken' }, relationships: {} },
  ] }
  const p = geckoToPairs(body)
  check('a pool comes back in DexScreener shape', p.length === 1 && p[0].baseToken.address === A && p[0].priceUsd === 187.1 && p[0].liquidity.usd === 845712.45 && p[0].quoteToken.symbol === 'USDC' && p[0].dexId === 'aero-slipstream-base')
  check('a pool without an address or base is skipped', p.every((x) => x.pairAddress && x.baseToken.address))
  const q = geckoToPairs({ data: [{ attributes: { address: '0x' + '9'.repeat(40), name: 'USDC / NVDAc', base_token_price_usd: '1', quote_token_price_usd: '187.3', base_token_price_quote_token: '0.00534', reserve_in_usd: '50000' }, relationships: { base_token: { data: { id: 'base_0x' + '11'.repeat(20) } }, quote_token: { data: { id: 'base_' + A } } } }] })
  check('a pool where the token is the quote side carries its own USD price', q[0].quotePriceUsd === 187.3 && q[0].priceNative === 0.00534 && q[0].quoteToken.address === A)
  const merged = mergePairs([{ pairAddress: p[0].pairAddress.toUpperCase().replace('0X', '0x') }], p)
  check('merging drops a pool both sources listed', merged.length === 1)
}

{
  let n = 0
  const pages = async () => { n++; if (n === 1) return { ok: true, status: 200, json: async () => ({ data: Array.from({ length: 20 }, (_, i) => ({ attributes: { address: '0x' + String(i).padStart(40, '0'), base_token_price_usd: '1', reserve_in_usd: '20000' }, relationships: { base_token: { data: { id: 'base_' + A } } } })) }) }; return { ok: false, status: 429, json: async () => ({}) } }
  const { readGeckoPools } = await import('./gecko-pools.mjs')
  const r = await readGeckoPools(pages, 'base', A, { paceMs: 0 })
  check('a later page refused keeps the pages read and says there may be more', r.pairs.length === 20 && r.more === true)
  let threw = false
  try { await readGeckoPools(async () => ({ ok: false, status: 429, json: async () => ({}) }), 'base', A, { paceMs: 0 }) } catch (_) { threw = true }
  check('a refused first page throws, so the caller keeps the DexScreener list', threw)
}

console.log('the units')
{
  const unit = fs.readFileSync(path.join(ROOT, 'deployment', 'systemd', 'stp-impostors.service'), 'utf8')
  const timer = fs.readFileSync(path.join(ROOT, 'deployment', 'systemd', 'stp-impostors.timer'), 'utf8')
  check('the service runs from the deployed release, both chains, one failure not skipping the other', /WorkingDirectory=\/opt\/stp\/current/.test(unit) && /--chain=base/.test(unit) && /--chain=robinhood/.test(unit) && !/impostor-list\.mjs --chain=base[^;]*&&/.test(unit))
  check('the timer fires the service every 6 hours', /Unit=stp-impostors\.service/.test(timer) && /00\/6/.test(timer))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
