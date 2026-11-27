// apps/b20-web.test.mjs: the B20 transfer rules on the served routes (docs/b20-transfers-tz.md §0.1, §3, §7). A B20
// refusal or pause never changes "listed", the impostor verdict or a held record, on /verify and on the passport; the
// passport carries latest.transfers and its note, the MCP lead says it, the token page renders it, and only the trusted
// Base records are read. The site runs on synthetic fixtures with a fake issuer list and a fake node; no outside call.
//
// Run: node apps/b20-web.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createStocksWeb } from './stocks-web.mjs'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL, ROBINHOOD_PRICES_URL } from '../evm/core/stocks/registries.mjs'
import { MIRRORS } from '../scripts/stocks/issuer-mirror.mjs'
import { ISSUER_ADDRESS_PREFIX } from '../evm/core/stocks/verify.mjs'
import { createB20Chain, b20Node } from './simulate/fake-b20.mjs'
import { ORDINARY_WALLET } from '../evm/core/stocks/b20.mjs'
import { transfersWords } from './stocks-mcp-http.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

// Synthetic addresses and time.
const P = ISSUER_ADDRESS_PREFIX.base
const B = (n) => P + n.toString(16).padStart(18, '0')
const OK = B(1), PAU = B(2), NEW = B(3), FRESH = B(4), IMP = '0x' + '1b'.repeat(20), R = '0x' + 'cc'.repeat(20)
const NOW = Date.parse('2026-11-25T14:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const H = (c) => '0x' + c.repeat(32)
const tok = (address, extra = {}) => ({ address, block: MIRRORS.base.from_block + 10, block_hash: H('d2'), tx: H('bb'), log_index: 1, second_at: iso(NOW - 3600e3), ...extra })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-web-'))
const base = path.join(tmp, 'base'), rh = path.join(tmp, 'rh')
for (const r of [base, rh]) fs.mkdirSync(path.join(r, 'stock-peg', 'history'), { recursive: true })
const lastOk = { at: iso(NOW - 5 * 60e3), started_at: iso(NOW - 6 * 60e3), target_block: MIRRORS.base.from_block + 1000, target_block_time: iso(NOW - 20 * 60e3) }
// OK and PAU were created by the factory; NEW was not, and is held. IMP copies OKc.
fs.writeFileSync(path.join(base, 'stock-peg', 'mirror.json'), JSON.stringify({ schema: 2, chain: 'base', issuer: 'coinbase', factory: MIRRORS.base.factory, topic0: MIRRORS.base.topic0, from_block: MIRRORS.base.from_block, scanned_to: MIRRORS.base.from_block + 1000, sources: 2, tokens: [tok(OK), tok(PAU), tok(FRESH)], revoked: [], last_ok: lastOk, last_error: null, updated_at: iso(NOW - 5 * 60e3) }))
fs.writeFileSync(path.join(rh, 'stock-peg', 'mirror.json'), JSON.stringify({ schema: 2, chain: 'robinhood', issuer: 'robinhood', factory: MIRRORS.robinhood.factory, topic0: MIRRORS.robinhood.topic0, from_block: 0, scanned_to: 1000, sources: 1, tokens: [tok(R, { block: 10 })], last_ok: { ...lastOk, target_block: 1000 }, last_error: null, updated_at: iso(NOW) }))
fs.writeFileSync(path.join(base, 'stock-peg', 'history', 'registry-2026-11-25.jsonl'), JSON.stringify({ _schema_version: '1.0', chain_id: 8453, issuer: 'coinbase', fetched_at: iso(NOW - 3 * 3600e3), hash: 'sha256:' + 'a'.repeat(64), prev_hash: null, records: 4, added: [], removed: [], changed: [], body: [OK, PAU, NEW, FRESH].map((address) => ({ address })) }) + '\n')
const POOL = '0x' + '9c'.repeat(20)
fs.writeFileSync(path.join(base, 'stock-peg', 'pool-book.json'), JSON.stringify({ pools: { [POOL]: { pool: POOL, token: OK, other: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', kind: 'own' } }, decimals: { [OK]: 8, [PAU]: 8, [NEW]: 8 } }))
fs.writeFileSync(path.join(rh, 'stock-peg', 'pool-book.json'), JSON.stringify({ pools: {}, decimals: { [R]: 18 } }))
fs.writeFileSync(path.join(base, 'stock-peg', 'stock-names.json'), JSON.stringify({ generated_at: iso(NOW - 3600e3), chain: 'base', count: 1, names: { [IMP]: ['OKc', 'Ok Inc.'] } }))
fs.writeFileSync(path.join(base, 'stock-peg', 'impostors.json'), JSON.stringify({ generated_at: iso(NOW - 3600e3), chain: 'base', listed: 1, counts: {}, note: 'n', items: [{ address: IMP, symbol: 'OKc', name: 'Ok', kind: 'registry_symbol', ticker: 'OK', registry_symbol: 'OKc', registry_address: OK, first_seen_at: iso(NOW - 3600e3) }] }))
// A reading of OK in the window, so its passport has a `latest`.
const row = (token, symbol) => ({ _schema_version: '1.0', run_id: 'r', observed_at: iso(NOW - 600e3), chain_id: 8453, issuer: 'coinbase', token_address: token, symbol, isin: 'US0000000000', multiplier: 1, multiplier_pending: null, paused: [],
  reference: { kind: 'nav_total_return', price_usd: 10, bid: null, ask: null, updated_at: iso(NOW - 900e3), age_s: 300, halted: null },
  pools: { source: 'dexscreener', seen: 1, eligible: 1, capped: false, error: null, top: [{ pair_address: POOL, dex_id: 'uniswap', quote_symbol: 'USDC', price_usd: 10, side: 'base', liquidity_usd: 2e6, volume_h24_usd: 1 }] },
  dex_price_usd: 10, dex_pool: POOL, premium: 0, premium_refused: null, dex_inside_quote: null })
fs.writeFileSync(path.join(base, 'stock-peg', 'stock-peg-2026-11-25.jsonl'), [row(OK, 'OKc'), row(PAU, 'PAUc')].map((r) => JSON.stringify(r)).join('\n') + '\n')

const rec = (address, symbol) => ({ contract_address: address, symbol, name: symbol + ' Inc.', isin: 'US0000000000', multiplier: '1', nav_price: '10', nav_price_updated_at: iso(NOW - 900e3), total_supply: '5' })
const fetchImpl = async (url) => {
  const u = String(url)
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (u.startsWith(COINBASE_URL)) return ok({ tokens: [rec(OK, 'OKc'), rec(PAU, 'PAUc'), rec(NEW, 'NEWc'), rec(FRESH, 'FRSc')] })
  if (u.startsWith(ROBINHOOD_ASSETS_URL)) return ok({ assets: [{ tokenSymbol: 'TSLA', tokenName: 'Tesla Robinhood Token', isin: 'US88160R1014', currentMultiplier: '1', status: 'ASSET_STATUS_ACTIVE', deployments: [{ chainId: 4663, contractAddress: R }] }] })
  if (u.startsWith(ROBINHOOD_PRICES_URL)) return ok({ quotes: [] })
  return { ok: false, status: 404, json: async () => ({}) }
}
// OK: an allowlist that refuses the ordinary wallet. PAU: transfers paused on chain. NEW (held): wide open, never read.
// FRESH: listed today, no price reading yet, and already paused on chain.
const chain = createB20Chain({
  tokens: { [OK]: { policies: { sender: '0', receiver: '9', executor: '0' }, paused: false }, [PAU]: { policies: { sender: '0', receiver: '0', executor: '0' }, paused: true }, [NEW]: { policies: { sender: '0', receiver: '0', executor: '0' }, paused: false }, [FRESH]: { policies: { sender: '0', receiver: '0', executor: '0' }, paused: true } },
  kinds: { 9: { type: 'allow', members: [] } },
})
const node = b20Node(chain, { now: () => NOW })
const app = createStocksWeb({ roots: { base, robinhood: rh }, fetchImpl, now: () => NOW, log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module: null, b20: { fetchImpl: node.fetchImpl, env: {} } })
const { port } = await app.start(0, '127.0.0.1')
await app.b20Refresh()
const get = async (p) => { const res = await fetch(`http://127.0.0.1:${port}/stocks${p}`); return { status: res.status, json: await res.json().catch(() => null) } }
const mcp = async (name, args) => (await (await fetch(`http://127.0.0.1:${port}/stocks/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result
const schema = JSON.parse(fs.readFileSync(new URL('../docs/reference/passport.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv)
const { $schema: _s, ...body } = schema
// The latest block and its transfers against the schema. (The whole answer is validated by docs/reference/passport-schema.test.mjs, which runs without a factory mirror.)
const validate = ajv.compile({ definitions: body.definitions, $ref: '#/definitions/latest' })

console.log('only the trusted Base records are read')
{
  const read = new Set(chain.calls.filter((c) => c.token).map((c) => c.token))
  check('OK and PAU are read; NEW (held) and the impostor never', read.has(OK) && read.has(PAU) && !read.has(NEW) && !read.has(IMP))
}

console.log('a B20 refusal never changes the verdict')
{
  const v = await get(`/verify?chain=base&address=${OK}`)
  check('restricted on chain: /verify still says listed', v.status === 200 && v.json.listed === true, JSON.stringify(v.json).slice(0, 300))
  const vp = await get(`/verify?chain=base&address=${PAU}`)
  check('paused on chain: /verify still says listed', vp.status === 200 && vp.json.listed === true)
  const p = await get(`/api/passport?chain=base&address=${OK}`)
  check('the passport: in_registry, the issuer named, latest.transfers restricted with its note', p.status === 200 && p.json.in_registry === true && p.json.issuer.symbol === 'OKc' && p.json.latest.transfers?.state === 'restricted' && p.json.latest.transfers?.ordinary_wallet?.receive === false && p.json.notes.includes('transfers_restricted'))
  check('...and its latest block validates against the passport schema', validate(p.json.latest), JSON.stringify(validate.errors || []).slice(0, 400))
  const pp = await get(`/api/passport?chain=base&address=${PAU}`)
  check('paused: in_registry, latest.transfers paused, the chain and the issuer\'s list both said', pp.json.in_registry === true && pp.json.latest.transfers?.state === 'paused' && pp.json.notes.includes('transfers_paused') && pp.json.latest.transfers?.pause?.chain === true && pp.json.latest.transfers?.pause?.issuer_list === false && pp.json.latest.transfers?.pause?.agree === false && validate(pp.json.latest), JSON.stringify(validate.errors || []).slice(0, 400))
  const held = await get(`/verify?chain=base&address=${NEW}`)
  check('a held record stays held: 503 with its reason, whatever the chain\'s rules', held.status === 503 && held.json.reason && held.json.listed === undefined)
  const hp = await get(`/api/passport?chain=base&address=${NEW}`)
  check('...its passport too: no verdict, no transfers', hp.status === 503 && !JSON.stringify(hp.json).includes('transfers'))
  const imp = await get(`/verify?chain=base&address=${IMP}`)
  check('the impostor stays an impostor, and its passport carries no transfers', imp.json.listed === false && imp.json.impostor && (await get(`/api/passport?chain=base&address=${IMP}`)).json.latest === null)
}

console.log('a token with no price reading')
{
  const f = await get(`/api/passport?chain=base&address=${FRESH}`)
  check('listed today, no reading, paused on chain: the passport says it at the top level, with its note', f.status === 200 && f.json.latest === null && f.json.transfers?.state === 'paused' && f.json.notes.includes('transfers_paused'))
  check('...and the MCP lead says it', /Transfers: paused on chain/.test((await mcp('stock_passport', { chain: 'base', address: FRESH })).structuredContent.summary))
  const ok = await get(`/api/passport?chain=base&address=${OK}`)
  check('with a reading, the top-level block and latest.transfers are the same object', JSON.stringify(ok.json.transfers) === JSON.stringify(ok.json.latest.transfers))
}

console.log('the status path for health-check')
{
  const st = await get('/api/status')
  const tk = st.json.base.b20.tokens
  check('/api/status carries base.b20 with its reader on and each trusted token\'s baseline', st.status === 200 && st.json.base.b20.reader === 'on' && tk[PAU]?.paused === true && tk[OK]?.policies?.receiver === '9' && tk[OK]?.answers?.['ordinary_wallet|receiver'] === false && !(NEW in tk) && !('b20' in st.json.robinhood))
  // PAU is unpaused on chain; the next cycle's baseline says it, for health-check to diff against its own copy.
  chain.tokens[PAU].paused = false
  node.head++
  await app.b20Refresh()
  const st2 = await get('/api/status')
  check('after a change the baseline on /api/status follows it, with its block', st2.json.base.b20.tokens[PAU]?.paused === false && st2.json.base.b20.tokens[PAU]?.block === node.head)
  const lst = st2.json.base.b20.changes || []
  check('...and the change itself is listed, with its block and time, for the polls that would miss it', lst.some((c) => c.token === PAU && c.kind === 'paused' && c.from === true && c.to === false && c.block === node.head && typeof c.at === 'string'), JSON.stringify(lst))
  const raw = JSON.stringify(st2.json)
  check('the public status never carries the probe wallet\'s address', !raw.includes(ORDINARY_WALLET.slice(2)))
  chain.tokens[PAU].paused = true
  node.head++
  await app.b20Refresh()
}

console.log('the lead and the token page')
{
  const r = await mcp('stock_passport', { chain: 'base', address: PAU })
  check('the MCP lead names the pause, the chain first, then the issuer\'s list', /Transfers: paused on chain/.test(r.structuredContent.summary) && /The chain says transfers are paused and the issuer's list says not paused/.test(r.structuredContent.summary) && r.structuredContent.notes.includes('transfers_paused'))
  const rr = await mcp('stock_passport', { chain: 'base', address: OK })
  check('...restricted said as the chain\'s fact, with its reason', /Transfers: restricted by the issuer's B20 rules \(ordinary_wallet_refused\)/.test(rr.structuredContent.summary))
  check('no reading: the lead says unknown, never open', /unknown \(not_read\)/.test(transfersWords({ state: 'unknown', reason: 'not_read', age_s: null })) && transfersWords(null) === null)
  const rh1 = await get(`/api/passport?chain=robinhood&address=${R}`)
  check('Robinhood Chain: transfers null where there is a latest, and no note', rh1.status === 200 && (rh1.json.latest === null || rh1.json.latest.transfers === null) && !rh1.json.notes.some((n) => n.startsWith('transfers_')))
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  check('the token page has words for both notes, and draws the line from the top-level block, not the price row', /transfers_restricted:/.test(js) && /transfers_paused:/.test(js) && /p\.chain === 'base' \? transfersField\(p\.transfers\) : null/.test(js))
  // The page's own view of the line, lifted out of app.js and run here: what a reader sees, now and later.
  const src = (js.match(/\n  function transfersView \(t, nowMs\) \{[\s\S]*?\n  \}\n/) || [''])[0]
  const transfersView = src ? new Function(src + '\nreturn transfersView')() : null
  const fresh = (await get(`/api/passport?chain=base&address=${FRESH}`)).json.transfers
  const v0 = transfersView && transfersView(fresh, NOW)
  check('rendered: a fresh pause with no price row shows paused, read from Base', v0 && v0.state === 'paused' && /read from Base/.test(v0.small), JSON.stringify(v0))
  const open = (await get(`/api/passport?chain=base&address=${OK}`)).json.transfers
  const opened = { ...open, state: 'open', reason: null }
  const v1 = transfersView && transfersView(opened, NOW + 60e3), v2 = transfersView && transfersView(opened, NOW + 3600e3)
  check('rendered: open a minute later is open; an hour later the same line is unknown, stale, with its last read', v1 && v1.state === 'open' && v2 && v2.state === 'unknown' && /too old/.test(v2.small) && /last read/.test(v2.small), JSON.stringify([v1, v2]))
  check('the ordinary wallet is the pinned one', chain.calls.some((c) => c.kind === 'isAuthorized' && c.account === ORDINARY_WALLET))
}

console.log('the token page, rendered')
{
  // The page's own render code (h, NOTES, transfersView, transfersField, notesOf), lifted out of app.js and run on a
  // small stand-in DOM with a clock and timers we hold.
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  const part = (re) => (js.match(re) || [''])[0]
  const src = [
    part(/\n  const h = \(tag, attrs, \.\.\.kids\) => \{[\s\S]*?\n  \}\n/), part(/\n  const NOTES = \{[\s\S]*?\n  \}\n/),
    part(/\n  function transfersView \(t, nowMs\) \{[\s\S]*?\n  \}\n/), part(/\n  function transfersField \(t\) \{[\s\S]*?\n  \}\n/), part(/\n  function notesOf \(p\) \{[\s\S]*?\n  \}\n/),
  ]
  class FakeNode {
    constructor (tag) { this.tag = tag; this.kids = []; this.className = ''; this.attrs = {}; this.parent = null; this.root = false }
    append (...xs) { for (const x of xs) { if (x instanceof FakeNode) { x.parent = this; this.kids.push(x) } else this.kids.push(String(x)) } }
    setAttribute (k, v) { this.attrs[k] = v }
    addEventListener () {}
    remove () { if (this.parent) { this.parent.kids = this.parent.kids.filter((c) => c !== this); this.parent = null } }
    get isConnected () { let n = this; while (n.parent) n = n.parent; return n.root }
    set textContent (v) { this.kids = [String(v)] }
    get textContent () { return this.kids.map((c) => (typeof c === 'string' ? c : c.textContent)).join('') }
  }
  let t = NOW
  const timers = []
  const fakeDate = { now: () => t, parse: (x) => Date.parse(x) }
  const page = src.every(Boolean) ? new Function('document', 'Node', 'setInterval', 'clearInterval', 'Date', src.join('') + '\nreturn { transfersField, notesOf }')({ createElement: (tag) => new FakeNode(tag) }, FakeNode, (f) => { timers.push(f); return timers.length }, () => {}, fakeDate) : null
  check('the render code is found in app.js', Boolean(page), src.map((x) => x.length).join(','))
  const p = (await get(`/api/passport?chain=base&address=${FRESH}`)).json
  const root = new FakeNode('main'); root.root = true
  const line = page.transfersField(p.transfers), notes = page.notesOf(p)
  root.append(line, notes)
  check('rendered now: the line says paused, read from Base, and the pause note is shown', /paused/.test(line.textContent) && /read from Base/.test(line.textContent) && notes && /paused transfers/.test(notes.textContent))
  t = NOW + 3600e3
  const later = page.notesOf(p)
  check('rendered an hour later: no pause note at all, and the line says unknown', (later === null || !/paused transfers/.test(later.textContent)) && /^transfers.*unknown/.test(page.transfersField(p.transfers).textContent))
  for (const f of timers) f()
  check('the page left open an hour: the line turns unknown, stale, and the pause note is taken off', /unknown/.test(line.textContent) && /too old/.test(line.textContent) && !/paused transfers/.test(root.textContent))
}

await app.stop()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
