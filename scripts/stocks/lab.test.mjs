// scripts/stocks/lab.test.mjs: the files behind /lab (scripts/stocks/lab.mjs), from synthetic lists only. The board must
// count only listed look-alikes, keep an unread pool apart from an empty one, name the richest fake beside its original
// and never copy a deployer; the weekly award must only ever go up within a week and start fresh the next; liquidity is
// read thirty addresses at a time.
//
// Run: node scripts/stocks/lab.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isoWeek, readLiquidity, realSideUsd, boardOf, updateGolden, crashTickers, onceFetch, runLab, LIVE_MIN_USD, DEX_BATCH, REFERENCE } from './lab.mjs'
const WETH = '0x4200000000000000000000000000000000000006', USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const A = (n) => '0x' + n.toString(16).padStart(40, '0')
const ORIG_C = A(0xc1), ORIG_T = A(0xc2)
const item = (n, sym, reg, orig, extra = {}) => ({ address: A(n), symbol: sym, name: sym, kind: 'registry_symbol', ticker: reg.replace(/c$/, ''), registry_symbol: reg, registry_address: orig, first_seen_at: `2026-11-${String(10 + (n % 10)).padStart(2, '0')}T00:00:00Z`, deployer: A(0xdead), ...extra })
const imp = { generated_at: '2026-11-25T00:00:00Z', items: [item(1, 'CRCLc', 'CRCLc', ORIG_C), item(2, 'CRCLc', 'CRCLc', ORIG_C), item(3, 'Visit evil.com', 'CRCLc', ORIG_C), item(4, 'TSLAc', 'TSLAc', ORIG_T), item(5, 'bad', 'TSLAc', 'nope')] }

console.log('ISO weeks, UTC')
check('a Wednesday in late November', isoWeek(Date.parse('2026-11-25T12:00:00Z')) === '2026-W48')
check('a year\'s last days can be the next year\'s week 1, or the last year\'s 53', isoWeek(Date.parse('2027-01-01T00:00:00Z')) === '2026-W53' && isoWeek(Date.parse('2027-01-04T00:00:00Z')) === '2027-W01' && isoWeek(Date.parse('2021-01-03T00:00:00Z')) === '2020-W53')
check('Sunday night and Monday morning are two weeks', isoWeek(Date.parse('2026-11-29T23:59:59Z')) === '2026-W48' && isoWeek(Date.parse('2026-11-30T00:00:00Z')) === '2026-W49')

console.log('the board')
{
  const liq = new Map([[A(1), { usd: 5000, pools: 2 }], [A(2), { usd: 40, pools: 1 }], [A(4), { usd: 0, pools: 0 }]]) // A(3) unread
  const b = boardOf('base', imp, liq)
  const c = b.rows.find((r) => r.original === ORIG_C), t = b.rows.find((r) => r.original === ORIG_T)
  check('one row per issuer stock; an item without a valid original is dropped', b.rows.length === 2 && c && t)
  check('fakes counted, live only at $' + LIVE_MIN_USD + ' or more', c.fakes === 3 && c.live === 1 && t.fakes === 1 && t.live === 0)
  check('an unread pool is counted apart, never as zero', c.unread === 1 && c.liquidity_usd === 5040 && b.totals.unread === 1)
  check('the richest fake, beside its original', c.richest.address === A(1) && c.richest.liquidity_usd === 5000 && c.original === ORIG_C)
  check('a stock whose fakes have no pool has no richest fake', t.richest === null)
  check('richest stocks first', b.rows[0].original === ORIG_C)
  check('the deployer is never copied', !JSON.stringify(b).includes(A(0xdead).slice(2)))
  const evil = boardOf('base', { items: [item(3, 'Visit https://evil.com‮ now', 'CRCLc', ORIG_C)] }, new Map([[A(3), { usd: 900, pools: 1 }]]))
  check('a fake\'s symbol is the deployer\'s text: labelled, no link, no control character', !/https?:|‮/.test(evil.rows[0].richest.symbol))
  check('the totals add up', b.totals.stocks === 2 && b.totals.fakes === 4 && b.totals.live === 1 && b.totals.liquidity_usd === 5040)
}

console.log('liquidity, thirty at a time')
{
  const asked = []
  const addrs = Array.from({ length: 65 }, (_, i) => A(100 + i))
  const fetchImpl = async (url) => {
    const list = String(url).split('/').pop().split(',')
    asked.push(list.length)
    if (asked.length === 2) return { status: 429, json: async () => ({}) }
    const p = { pairAddress: 'p1', baseToken: { address: list[0] }, quoteToken: { address: WETH }, priceUsd: '2', priceNative: '0.001', liquidity: { usd: 1000, base: 250, quote: 0.25 } }
    return { status: 200, json: async () => [p, { ...p }] }
  }
  const { liq, unread } = await readLiquidity('base', [...addrs, addrs[0].toUpperCase().replace('0X', '0x')], { fetchImpl, pauseMs: 0, reference: REFERENCE.base })
  check(`at most ${DEX_BATCH} addresses per call, each address once`, asked.join() === '30,30,5')
  check('a batch that failed is unread, not empty', unread === 30 && !liq.has(addrs[30]) && liq.get(addrs[31]) === undefined)
  check('a read address with no pool is zero', liq.get(addrs[1]).usd === 0 && liq.get(addrs[1]).pools === 0)
  check('the same pool twice in an answer counts once', liq.get(addrs[0]).usd === 500 && liq.get(addrs[0]).reported === 1000 && liq.get(addrs[0]).pools === 1)
}

console.log('real money: only the WETH or stablecoin side')
{
  const FAKE = A(7), JUNK = A(8)
  // The week's first winner, as it was: a billion fakes against a few dollars of WETH, reported as $739K.
  const selfPriced = { baseToken: { address: FAKE }, quoteToken: { address: WETH }, priceUsd: '0.0009859', priceNative: '0.00000033', liquidity: { usd: 739429.25, base: 749996980, quote: 0.001859 } }
  const v = realSideUsd(selfPriced, FAKE, REFERENCE.base)
  check('a pool priced by the fake itself is worth its WETH side, not what it reports', v > 1 && v < 10, String(v))
  check('the fake on the quote side: the base side counts, at the base\'s price', realSideUsd({ baseToken: { address: USDC }, quoteToken: { address: FAKE }, priceUsd: '1', priceNative: '50', liquidity: { base: 1200, quote: 24 } }, FAKE, REFERENCE.base) === 1200)
  check('a pool against anything but a reference asset is zero', realSideUsd({ baseToken: { address: FAKE }, quoteToken: { address: JUNK }, priceUsd: '5', priceNative: '1', liquidity: { usd: 9e6, base: 1, quote: 9e6 } }, FAKE, REFERENCE.base) === 0)
  check('a missing price is zero, never NaN', realSideUsd({ baseToken: { address: FAKE }, quoteToken: { address: WETH }, liquidity: { quote: 3 } }, FAKE, REFERENCE.base) === 0)
  check('the reference assets are the chains\' own: WETH and the stablecoins on Base, wrapped native on Robinhood', REFERENCE.base.has(WETH) && REFERENCE.base.has(USDC) && REFERENCE.robinhood.size >= 1 && !REFERENCE.base.has(JUNK))
}

console.log('the golden impostor of the week')
{
  const board = (usd, n = 1) => ({ chain: 'base', rows: [{ symbol: 'CRCLc', original: ORIG_C, richest: { address: A(n), symbol: 'CRCLc', liquidity_usd: usd } }] })
  const mon = Date.parse('2026-11-23T06:00:00Z'), wed = Date.parse('2026-11-25T06:00:00Z'), next = Date.parse('2026-11-30T06:00:00Z')
  let g = updateGolden(null, [board(5000)], mon)
  check('the first run of a week crowns its richest fake', g.weeks['2026-W48'].address === A(1) && g.weeks['2026-W48'].liquidity_usd === 5000 && g.weeks['2026-W48'].copied === 'CRCLc' && g.weeks['2026-W48'].original === ORIG_C)
  g = updateGolden(g, [board(300, 2)], wed)
  check('a poorer fake later in the week does not take the title', g.weeks['2026-W48'].address === A(1))
  g = updateGolden(g, [board(9000, 3)], wed)
  check('a richer one does', g.weeks['2026-W48'].address === A(3) && g.weeks['2026-W48'].liquidity_usd === 9000)
  g = updateGolden(g, [board(50, 4)], next)
  check('a fake under $' + LIVE_MIN_USD + ' wins nothing, and last week stays as it was', !g.weeks['2026-W49'] && g.weeks['2026-W48'].address === A(3))
  check('the rule is written into the file', /ISO week/.test(g.rule))
}

console.log('the crash test runs on Circle and the most-copied stocks')
check('Circle first, then by number of fakes, at most four, each once', crashTickers({ rows: [{ symbol: 'TSLAc', fakes: 2 }, { symbol: 'NVDAc', fakes: 9 }, { symbol: 'CRCLc', fakes: 50 }, { symbol: 'AAPLc', fakes: 3 }, { symbol: 'MSFTc', fakes: 1 }] }).join() === 'CRCL,NVDA,AAPL,TSLA')
check('with no board, Circle alone', crashTickers(null).join() === 'CRCL')

console.log('one download per list per run')
{
  let n = 0
  const f = onceFetch(async () => { n++; return { status: 200, text: async () => '{"tokens":[]}' } })
  const a = await f('https://tokens.uniswap.org'), b = await f('https://tokens.uniswap.org')
  check('the same URL is fetched once and read twice', n === 1 && (await a.json()).tokens.length === 0 && (await b.json()).tokens.length === 0)
}

console.log('a whole run writes the three files')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'))
  try {
    const roots = { base: path.join(dir, 'b'), robinhood: path.join(dir, 'r') }
    fs.mkdirSync(path.join(roots.base, 'stock-peg'), { recursive: true })
    fs.writeFileSync(path.join(roots.base, 'stock-peg', 'impostors.json'), JSON.stringify(imp))
    const fetchImpl = async (url) => ({ status: 200, json: async () => String(url).includes(A(1).slice(2)) ? [{ pairAddress: 'p', baseToken: { address: A(1) }, quoteToken: { address: USDC }, priceUsd: '0.5', priceNative: '0.5', liquidity: { usd: 99999, base: 1e5, quote: 777 } }] : [] })
    const seen = []
    await runLab({ out: path.join(dir, 'lab'), roots, fetchImpl, now: () => Date.parse('2026-11-25T00:00:00Z'), pauseMs: 0, crashTest: async ({ ticker }) => { seen.push(ticker); return { code: 0, stock: { ticker }, rows: [] } } })
    const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, 'lab', f), 'utf8'))
    const board = read('board.json'), golden = read('golden.json'), crash = read('crash.json')
    check('board.json: Base built, Robinhood says its list is missing', board.chains.find((c) => c.chain === 'base').totals.fakes === 4 && /not readable/.test(board.chains.find((c) => c.chain === 'robinhood').error))
    check('golden.json: this week\'s winner', golden.weeks['2026-W48'].liquidity_usd === 777)
    check('crash.json: Circle and the Base stocks with the most fakes, and the command to rerun it', seen.join() === 'CRCL,TSLA' && /crash-test\.mjs/.test(crash.method) && crash.stocks.length === 2)
    check('no temporary file is left behind', fs.readdirSync(path.join(dir, 'lab')).sort().join() === 'board.json,crash.json,golden.json')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
