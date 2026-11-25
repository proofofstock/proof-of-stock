// apps/tokenlist.test.mjs: /tokenlist.json, the issuer-listed tokens as a Uniswap token list (apps/stocks-tokenlist.mjs,
// 25.11). What is held: only a token that is on the issuer's fresh list AND has known decimals is in it; never an
// impostor or an outside token; names are fitted to the schema's character set and length; addresses are checksummed;
// the list checks itself against the schema's rules; and the server answers 503, not an old list, when an issuer list is
// stale. All data here is synthetic.
//
// Run: node apps/tokenlist.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTokenList, cleanName, tokenListProblems, TOKEN_LIST_PATH, TOKEN_LIST_NAME } from './stocks-tokenlist.mjs'
import { createStocksWeb } from './stocks-web.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../evm/core/stocks/registries.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

console.log('names fitted to the schema')
check('the issuers\' bullet becomes a dash, a comma goes, a curly apostrophe straightens', cleanName('Apple • Robinhood Token', 'AAPL') === 'Apple - Robinhood Token' && cleanName('Apple Inc., Class A', 'X') === 'Apple Inc. Class A' && cleanName('Macy’s', 'M') === "Macy's")
const longName = 'International Business Machines Corporation Common Stock'
check('a name over 40 characters is cut at a word', cleanName(longName, 'IBM').length <= 40 && longName.startsWith(cleanName(longName, 'IBM')) && !/\s$/.test(cleanName(longName, 'IBM')), cleanName(longName, 'IBM'))
check('characters outside the set are dropped, and an empty name falls back to the symbol', cleanName('Wow! <b>', 'W') === 'Wow b' && cleanName('!!!', 'NVDAc') === 'NVDAc')

console.log('the list')
const A = '0x' + 'ab'.repeat(20), B = '0x' + 'cd'.repeat(20), C = '0x' + 'ef'.repeat(20)
const at = Date.parse('2026-11-25T10:07:00Z')
const list = buildTokenList({
  chains: [
    { chainId: 8453, issuer: 'coinbase', records: [{ address: A, symbol: 'NVDAc', name: 'NVIDIA Corporation, Common', isin: 'US67066G1040', multiplier: 1 }, { address: B, symbol: 'AAPLc', name: 'Apple' }], decimals: new Map([[A, 8]]) },
    { chainId: 4663, issuer: 'robinhood', records: [{ address: C, symbol: 'TSLA', name: 'Tesla • Robinhood Token' }], decimals: new Map([[C, 18]]) },
  ],
  at, logoURI: 'https://proofofstock.xyz/logo.png',
})
check('only listed tokens with known decimals are in it: one per chain here, B has no pool and is left out', list.tokens.length === 2 && list.tokens.every((t) => t.address.toLowerCase() !== B), JSON.stringify(list.tokens.map((t) => t.symbol)))
check('addresses are checksummed, as wallets expect', list.tokens.every((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address) && t.address !== t.address.toLowerCase()))
const nv = list.tokens.find((x) => x.symbol === 'NVDAc')
check('a token carries its issuer and ISIN as extensions, no longer than the schema allows', nv.extensions.issuer === 'coinbase' && nv.extensions.isin === 'US67066G1040' && Object.values(nv.extensions).every((v) => typeof v !== 'string' || v.length <= 42))
check('the version is the read time: minor the UTC day, patch the minute of it', list.version.major === 1 && list.version.minor === Math.floor(at / 86400e3) && list.version.patch === 10 * 60 + 7 && list.timestamp === '2026-11-25T10:07:00.000Z')
check('it keeps every rule of the schema it is checked against', tokenListProblems(list).length === 0, JSON.stringify(tokenListProblems(list)))
check('...and those checks do catch a broken entry', tokenListProblems({ ...list, tokens: [{ ...list.tokens[0], name: 'a,b' }, { ...list.tokens[0] }] }).length >= 2)
check('the list is named within the schema\'s 30 word characters', TOKEN_LIST_NAME.length <= 30 && /^[\w ]+$/.test(TOKEN_LIST_NAME))

console.log('the route')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenlist-'))
const roots = { base: path.join(tmp, 'base'), robinhood: path.join(tmp, 'rh') }
for (const r of Object.values(roots)) fs.mkdirSync(path.join(r, 'stock-peg'), { recursive: true })
const R = '0x' + 'cc'.repeat(20), IMP = '0x' + '99'.repeat(20)
fs.writeFileSync(path.join(roots.base, 'stock-peg', 'pool-book.json'), JSON.stringify({ pools: {}, decimals: { [A]: 8, [IMP]: 8, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6 } }))
fs.writeFileSync(path.join(roots.robinhood, 'stock-peg', 'pool-book.json'), JSON.stringify({ pools: {}, decimals: { [R]: 18 } }))
fs.writeFileSync(path.join(roots.base, 'stock-peg', 'impostors.json'), JSON.stringify({ generated_at: '2026-11-25T09:00:00Z', items: [{ address: IMP, symbol: 'NVDAc', name: 'NVIDIA', first_seen_at: '2026-11-25T08:00:00Z' }] }))
let t = Date.parse('2026-11-25T10:00:00Z'), down = false
const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const fetchImpl = async (url) => {
  const u = String(url)
  if (down && u.startsWith(COINBASE_URL)) throw new Error('down')
  if (u.startsWith(COINBASE_URL)) return ok({ tokens: [{ contract_address: A, symbol: 'NVDAc', name: 'NVIDIA', isin: 'US67066G1040', multiplier: '1', nav_price: '180', nav_price_updated_at: '2026-11-25T09:00:00Z', total_supply: '5' }] })
  if (u.startsWith(ROBINHOOD_ASSETS_URL)) return ok({ assets: [{ tokenSymbol: 'TSLA', tokenName: 'Tesla • Robinhood Token', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: R }] }] })
  if (u.startsWith(ROBINHOOD_PRICES_URL)) return ok({ quotes: [] })
  return { ok: false, status: 404, json: async () => ({}) }
}
const app = createStocksWeb({ roots, fetchImpl, now: () => t, log: () => {}, analytics: { enabled: false }, exam: { url: null }, glama: { url: null }, x402Module: null })
const { port } = await app.start(0, '127.0.0.1')
// The site lives under /stocks behind nginx, as in apps/stocks-web.test.mjs.
const get = (p) => fetch(`http://127.0.0.1:${port}/stocks${p}`)
try {
  const r = await get(TOKEN_LIST_PATH)
  const j = await r.json()
  const addrs = (j.tokens || []).map((x) => x.address.toLowerCase())
  check('served as JSON to any origin, cached five minutes', r.status === 200 && r.headers.get('access-control-allow-origin') === '*' && /max-age=300/.test(r.headers.get('cache-control') || '') && /json/.test(r.headers.get('content-type') || ''), r.status + ' ' + r.headers.get('cache-control'))
  check('it holds the listed token of each chain, with the chain\'s own id', addrs.includes(A) && addrs.includes(R) && j.tokens.find((x) => x.address.toLowerCase() === R).chainId === 4663, JSON.stringify(addrs))
  check('never the impostor, and never an outside token from the pool book (USDC)', !addrs.includes(IMP) && !addrs.includes('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'))
  check('what it serves passes its own schema check', tokenListProblems(j).length === 0, JSON.stringify(tokenListProblems(j)))
  down = true; t += 20 * 60e3
  await app.refreshAll()
  const s = await get(TOKEN_LIST_PATH)
  const sj = await s.json()
  check('an issuer list not read within the window gets 503 and no list, never an old copy', s.status === 503 && !sj.tokens && /base/.test(sj.error) && s.headers.get('retry-after') === '60', s.status + ' ' + JSON.stringify(sj).slice(0, 120))
} finally {
  await app.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
