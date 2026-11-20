// scripts/stocks/symbol-sweep.test.mjs: the symbol sweep finds look-alikes the token dataset never saw, takes their
// text from the chain and never from a provider, keeps within the providers' budgets, and the impostor list judges its
// finds by the same rule as everything else while the published file keeps its keys.
//
// Run: node scripts/stocks/symbol-sweep.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fromDexScreener, fromGecko, queriesOf, searchSymbols, mergeSweep, sweptForList, runSweep, readSweep, SWEEP_FILE, DS_BREAKER } from './symbol-sweep.mjs'
import { buildImpostorList } from './impostor-list.mjs'
import { COINBASE_URL } from '../../evm/core/stocks/registries.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const REAL = '0x' + 'b2'.repeat(20), COPY = '0x' + 'd7'.repeat(20), COPY2 = '0x' + 'f5'.repeat(20), MEME = '0x' + '48'.repeat(20), BSC = '0x' + '05'.repeat(20), USDC = '0x' + '83'.repeat(20)
const reg = new Set([REAL])
const abi = (s) => { const b = Buffer.from(s, 'utf8'); return '0x' + (32).toString(16).padStart(64, '0') + b.length.toString(16).padStart(64, '0') + b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0') }
const dsBody = { pairs: [
  { chainId: 'base', baseToken: { address: REAL, symbol: 'SNDKc', name: 'Sandisk' }, quoteToken: { address: USDC, symbol: 'USDC', name: 'USD Coin' } },
  { chainId: 'base', baseToken: { address: COPY.toUpperCase().replace('0X', '0x'), symbol: 'SNDKc', name: 'Sandisk Corporation' }, quoteToken: { address: USDC, symbol: 'USDC', name: 'USD Coin' } },
  { chainId: 'base', baseToken: { address: MEME, symbol: 'MOON', name: 'Moon' }, quoteToken: { address: REAL, symbol: 'SNDKc', name: 'Sandisk' } },
  { chainId: 'bsc', baseToken: { address: BSC, symbol: 'SNDKc', name: 'Sandisk' }, quoteToken: { address: USDC, symbol: 'X', name: 'X' } },
] }
const gtBody = { data: [], included: [
  { type: 'token', id: 'base_' + REAL, attributes: { symbol: 'SNDKc', name: 'Sandisk' } },
  { type: 'token', id: 'base_' + COPY2, attributes: { symbol: 'SNDKc', name: 'Sandisk Corporations' } },
  { type: 'token', id: 'bsc_' + BSC, attributes: { symbol: 'SNDKc', name: 'Sandisk' } },
  { type: 'dex', id: 'base_' + MEME, attributes: {} },
] }

console.log('what an answer yields')
{
  const d = fromDexScreener(dsBody, 'base', reg)
  check('DexScreener: every token on the chain, either side of the pair, outside the registry, lower-cased', d.has(COPY) && d.has(MEME) && d.has(USDC) && !d.has(REAL) && !d.has(BSC) && d.size === 3, [...d.keys()].join())
  check('...with the provider\'s text as found', d.get(COPY).symbol === 'SNDKc' && d.get(COPY).name === 'Sandisk Corporation')
  const g = fromGecko(gtBody, 'base', reg)
  check('GeckoTerminal: only tokens of this network, outside the registry', g.has(COPY2) && !g.has(REAL) && !g.has(BSC) && !g.has(MEME) && g.size === 1)
  check('a malformed answer yields nothing, never throws', fromDexScreener(null, 'base', reg).size === 0 && fromGecko({ included: 'x' }, 'base', reg).size === 0)
  check('queries: each issuer symbol once, sorted, nothing that is not a symbol', queriesOf([{ symbol: 'NVDAc' }, { symbol: 'AAPLc' }, { symbol: 'NVDAc' }, { symbol: 'a b' }, { symbol: '' }, {}]).join() === 'AAPLc,NVDAc')
}

console.log('asking within the budgets')
{
  const urls = []
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const f = async (u) => { urls.push(String(u)); return String(u).includes('geckoterminal') ? ok(gtBody) : ok(dsBody) }
  const r = await searchSymbols({ queries: ['A', 'B', 'C', 'D'], slug: 'base', network: 'base', registrySet: reg, fetchImpl: f, sleep: async () => {}, geckoBudget: 2, geckoCursor: 3 })
  const ds = urls.filter((u) => u.includes('dexscreener')), gt = urls.filter((u) => u.includes('geckoterminal'))
  check('DexScreener is asked for every symbol', ds.length === 4 && r.asked.dexscreener === 4)
  check('GeckoTerminal only within its budget, from the cursor, wrapping around', gt.length === 2 && /query=D&/.test(gt[0]) && /query=A&/.test(gt[1]) && r.gecko_cursor === 1, gt.join(' '))
  check('GeckoTerminal is asked scoped to the network', gt.every((u) => u.includes('network=base')))
  check('a token both found is one find with both sources', r.found.size === 4 && [...r.found.get(COPY).sources].sort().join() === 'dexscreener' && r.found.get(COPY2).sources.has('geckoterminal'))
  let n = 0
  const down = async (u) => { n++; return String(u).includes('geckoterminal') ? { ok: false, status: 429, json: async () => ({}) } : { ok: false, status: 503, json: async () => ({}) } }
  const r2 = await searchSymbols({ queries: Array.from({ length: 20 }, (_, i) => 'S' + i), slug: 'base', network: 'base', registrySet: reg, fetchImpl: down, sleep: async () => {}, geckoBudget: 3 })
  check(`after ${DS_BREAKER} DexScreener failures in a row it stops asking`, r2.asked.dexscreener === DS_BREAKER && r2.failed.dexscreener === DS_BREAKER)
  check('a 429 from GeckoTerminal ends it for the run, and the cursor stays on the symbol not answered', r2.asked.geckoterminal === 1 && r2.gecko_cursor === 0)
  const seen = []
  const r3 = await searchSymbols({ queries: ['A', 'B', 'C', 'D', 'E'], slug: 'base', network: 'base', registrySet: reg, fetchImpl: async (u) => { seen.push(new URL(u).searchParams.get('q')); return ok(dsBody) }, sleep: async () => {}, dsBudget: 3, dsCursor: 4 })
  check('a registry longer than the DexScreener budget is walked in rotation, from the cursor', seen.join() === 'E,A,B' && r3.ds_cursor === 2, seen.join() + ' ' + r3.ds_cursor)
  const paces = []
  await searchSymbols({ queries: ['A', 'B'], slug: 'base', network: 'base', registrySet: reg, fetchImpl: f, sleep: async (ms) => { paces.push(ms) }, geckoBudget: 1 })
  check('requests are paced: DexScreener between symbols, GeckoTerminal before each', paces.join() === '1100,12500', paces.join())
}

console.log('the text comes from the chain')
{
  const found = new Map([[COPY, { symbol: 'SNDKc', name: 'Sandisk Corporation', sources: new Set(['dexscreener']) }], [MEME, { symbol: 'NVDAc', name: 'lie', sources: new Set(['dexscreener']) }]])
  const ev = new Map([[COPY, { symbol_return: abi('SNDKc'), name_return: abi('Sandisk Corporation'), block_number: 42 }]])
  const m = mergeSweep({ tokens: {} }, found, ev, '2026-11-20T00:00:00.000Z')
  check('a find the chain answered carries the chain\'s text and block', m.state.tokens[COPY].text_from === 'chain' && m.state.tokens[COPY].symbol === 'SNDKc' && m.state.tokens[COPY].block_number === 42 && m.added === 2 && m.confirmed === 1)
  check('a find the chain did not answer is kept as the provider said, marked so', m.state.tokens[MEME].text_from === 'provider' && m.state.tokens[MEME].symbol === 'NVDAc')
  const list = sweptForList(m.state, reg)
  check('only text read from the chain is offered to the list', list.has(COPY) && !list.has(MEME))
  const later = mergeSweep(m.state, new Map([[COPY, { symbol: 'OTHER', name: 'x', sources: new Set(['geckoterminal']) }]]), new Map(), '2026-11-21T00:00:00.000Z')
  check('a chain answer is never replaced by a provider\'s text later; first seen stays, sources grow', later.state.tokens[COPY].symbol === 'SNDKc' && later.state.tokens[COPY].first_seen_at === '2026-11-20T00:00:00.000Z' && later.state.tokens[COPY].last_seen_at === '2026-11-21T00:00:00.000Z' && later.state.tokens[COPY].sources.join() === 'dexscreener,geckoterminal')
  const fixed = mergeSweep(m.state, new Map([[MEME, { symbol: 'NVDAc', name: 'lie', sources: new Set(['dexscreener']) }]]), new Map([[MEME, { symbol_return: abi('MOON'), name_return: abi('Moon'), block_number: 50 }]]), '2026-11-21T00:00:00.000Z')
  check('a provider-only find is read again, and the chain\'s text wins', fixed.state.tokens[MEME].text_from === 'chain' && fixed.state.tokens[MEME].symbol === 'MOON')
  check('a registry address is never offered, whatever the state holds', !sweptForList({ tokens: { [REAL]: { text_from: 'chain', symbol: 'SNDKc' } } }, reg).has(REAL))
}

console.log('one run, end to end')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'))
{
  const dir = path.join(tmp, 'stock-peg')
  const fetchImpl = async (u) => String(u).includes('geckoterminal') ? { ok: true, status: 200, json: async () => gtBody } : { ok: true, status: 200, json: async () => dsBody }
  let asked = null
  const readEvidence = async ({ addresses }) => { asked = addresses.slice().sort(); return new Map(addresses.map((a) => [a, { symbol_return: abi(a === COPY || a === COPY2 ? 'SNDKc' : 'X'), name_return: abi(a === COPY ? 'Sandisk Corporation' : 'Sandisk Corporations'), block_number: 7 }])) }
  const chainCfg = { slug: 'base', gecko: 'base', chainId: 8453, read: async () => [{ address: REAL, symbol: 'SNDKc', name: 'Sandisk' }] }
  const s = await runSweep({ chain: 'base', chainCfg, dir, fetchImpl, sleep: async () => {}, readEvidence, env: {}, now: () => Date.parse('2026-11-20T06:23:00Z') })
  check('the run reports what it asked and found', s.queries === 1 && s.asked.dexscreener === 1 && s.asked.geckoterminal === 1 && s.new === 4 && s.read_on_chain === 4, JSON.stringify(s))
  check('every new find is read on chain, never a registry token', asked.join() === [COPY, COPY2, MEME, USDC].sort().join())
  const st = readSweep(dir)
  check('the state is written whole, with the cursor and no temporary file', Object.keys(st.tokens).length === 4 && st.gecko_cursor === 0 && !fs.readdirSync(dir).some((n) => n.includes('.tmp-')) && fs.existsSync(path.join(dir, SWEEP_FILE)))
  asked = null
  await runSweep({ chain: 'base', chainCfg, dir, fetchImpl, sleep: async () => {}, readEvidence, env: {}, now: () => Date.parse('2026-11-20T12:23:00Z') })
  check('the next run does not ask the chain again about what it answered', asked === null)
  const off = await runSweep({ chain: 'base', chainCfg, dir, fetchImpl: async () => { throw new Error('must not be called') }, env: { POS_SYMBOL_SWEEP: '0' } })
  check('POS_SYMBOL_SWEEP=0 turns it off without a request', off.skipped === 'POS_SYMBOL_SWEEP=0')

  console.log('the impostor list judges the finds')
  const ds = path.join(tmp, 'dataset')
  fs.mkdirSync(path.join(ds, 'static'), { recursive: true })
  fs.writeFileSync(path.join(ds, 'static', 'token-static-2026-11-01.jsonl'), JSON.stringify({ token_address: '0x' + 'e1'.repeat(20), symbol: 'PEPE', name: 'Pepe', observed_at: '2026-11-01T00:00:00Z' }) + '\n')
  const cb = async (url) => (String(url).startsWith(COINBASE_URL)
    ? { ok: true, status: 200, json: async () => ({ tokens: [{ contract_address: REAL, symbol: 'SNDKc', name: 'Sandisk', multiplier: '1' }] }) }
    : { ok: false, status: 404, json: async () => ({}) })
  const l = await buildImpostorList({ chain: 'base', tokenDataset: ds, fetchImpl: cb, now: () => Date.parse('2026-11-20T12:30:00Z'), sweepState: st })
  const listed = l.items.map((i) => i.address).sort()
  check('the copies the dataset never saw are listed, by the same rule', listed.join() === [COPY, COPY2].sort().join() && l.items.every((i) => i.kind === 'registry_symbol' && i.registry_address === REAL), JSON.stringify(l.items))
  check('...first seen when the sweep first found them', l.items.find((i) => i.address === COPY).first_seen_at === '2026-11-20T06:23:00.000Z')
  check('coverage: the internal file says what only the sweep found', l.internal.sweep.tokens_only_swept === 4 && l.internal.sweep.listed_only_swept.join() === [COPY, COPY2].sort().join())
  check('the published keys are unchanged', Object.keys(l).join() === 'generated_at,chain,chain_id,issuer,note,registry_records,tokens_scanned,torn_files,counts,listed,more,truncated,items,names,registry_addresses,internal')
  const providerOnly = { tokens: { [COPY]: { symbol: 'SNDKc', name: 'Sandisk', text_from: 'provider', first_seen_at: '2026-11-20T00:00:00Z' } } }
  const l2 = await buildImpostorList({ chain: 'base', tokenDataset: ds, fetchImpl: cb, now: () => Date.now(), sweepState: providerOnly })
  check('a find the chain never answered is not listed on a provider\'s word', l2.items.length === 0 && l2.internal.sweep.tokens_only_swept === 0)
}
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
