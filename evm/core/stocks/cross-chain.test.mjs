// evm/core/stocks/cross-chain.test.mjs — search spans both issuer chains with exact tickers first; the same share on
// the other chain is found by ISIN only; the board ranks priced readings by distance from the reference and counts,
// never ranks, what could not be priced.
//
// Run: node evm/core/stocks/cross-chain.test.mjs

import { findAcross, sameStockElsewhere, overview, matrix, isinsOfTicker } from './cross-chain.mjs'
import { buildPassport } from './passport.mjs'
import { readingsOf } from './readings-window.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const a = (n) => '0x' + String(n).repeat(40).slice(0, 40)
const rec = (issuer, symbol, name, isin, address, price = 100) => ({ issuer, symbol, name, isin, address, multiplier: 1, reference: { price_usd: price } })
const latest = (premium, liquidity = 50_000) => ({ observed_at: '2026-11-08T14:00:00Z', premium, premium_refused: premium == null ? 'no_eligible_pool' : null, dex_price_usd: 100 * (1 + (premium || 0)), reference: { price_usd: 100, age_s: 3600, halted: false }, pools: { top: [{ liquidity_usd: liquidity }] } })
const win = (entries) => ({ loaded_at: Date.parse('2026-11-08T14:00:00Z'), byToken: new Map(entries.map(([addr, l]) => [addr, { latest: l, points: [] }])) })

const byChain = {
  base: {
    records: [rec('coinbase', 'NVDAc', 'NVIDIA', 'US67066G1040', a(1)), rec('coinbase', 'NVDLc', 'GraniteShares 2x Long NVDA', 'US38747R8115', a(2)), rec('coinbase', 'TSLAc', 'Tesla', 'US88160R1014', a(3))],
    window: win([[a(1), latest(0.004)], [a(3), latest(-0.03)], [a(2), latest(null)]]),
  },
  robinhood: {
    records: [rec('robinhood', 'NVDA', 'NVIDIA  Robinhood Token', 'US67066G1040', a(4)), rec('robinhood', 'NVDX', 'Not NVIDIA', 'XX0000000000', a(5))],
    window: win([[a(4), latest(-0.012)]]),
  },
}

console.log('search across chains')
{
  const r = findAcross(byChain, 'nvda')
  check('one query finds the share on both chains', r.matches.some((m) => m.chain === 'base' && m.symbol === 'NVDAc') && r.matches.some((m) => m.chain === 'robinhood' && m.symbol === 'NVDA'))
  check('exact tickers come first', ['NVDAc', 'NVDA'].includes(r.matches[0].symbol) && ['NVDAc', 'NVDA'].includes(r.matches[1].symbol), JSON.stringify(r.matches.map((m) => m.symbol)))
  check('every match says its chain and issuer', r.matches.every((m) => m.chain && m.issuer))
  check('a search by ISIN works', findAcross(byChain, 'US88160R1014').matches[0].symbol === 'TSLAc')
  check('an empty query finds nothing', findAcross(byChain, '  ').matches.length === 0)
  // Live 09.11: COIN came back as USDEc, HOOD as AAOI, SPY as Krispy Kreme, all by a substring inside another name.
  const reg = { base: { records: [rec('coinbase', 'KRSPc', 'Krispy Kreme', 'US50101L1061', a(6)), rec('coinbase', 'SPYc', 'SPDR S&P 500 ETF', 'US78462F1030', a(7)), rec('coinbase', 'SPYDc', 'SPDR Portfolio S&P 500 High Dividend ETF', 'US78468R7888', a(9))] }, robinhood: { records: [rec('robinhood', 'AAOI', 'Applied Optoelectronics  Robinhood Token', 'US03823U1025', a(8))] } }
  const spy = findAcross(reg, 'SPY')
  check('an exact ticker returns only the exact token, never one whose name contains it', spy.match === 'exact' && spy.matches.length === 1 && spy.matches[0].symbol === 'SPYc' && spy.matches[0].match_quality === 'exact', JSON.stringify(spy.matches.map((m) => m.symbol)))
  const hood = findAcross(reg, 'HOOD')
  check('a ticker the registry lacks is an empty answer with its reason, not "... Robinhood Token"', hood.match === 'none' && hood.matches.length === 0 && /no issuer-listed token/.test(hood.reason), JSON.stringify(hood))
  check('a query inside a word matches nothing (SPY is not Krispy)', findAcross({ base: reg.base }, 'rispy').matches.length === 0)
  const name = findAcross(reg, 'krispy')
  check('a company name still finds its token, labelled as a name match', name.match === 'fuzzy' && name.matches[0].symbol === 'KRSPc' && name.matches[0].match_quality === 'name')
  check('the ISIN is an exact match', findAcross(reg, 'us78462f1030').matches[0].match_quality === 'exact')
  // Live 10.11: find "TSLAc" on Robinhood answered nothing, though Robinhood lists TSLA.
  const rhOnly = { robinhood: { records: [rec('robinhood', 'TSLA', 'Tesla  Robinhood Token', 'US88160R1014', a(5))] } }
  const tc = findAcross(rhOnly, 'TSLAc')
  check('Coinbase naming on another chain finds that chain\'s ticker, and says it did', tc.match === 'exact' && tc.matches[0]?.symbol === 'TSLA' && tc.query_normalized === 'TSLA' && /Coinbase's naming/.test(tc.reason), JSON.stringify(tc))
  check('a query that matches as typed is never rewritten', findAcross(byChain, 'TSLAc').query_normalized === undefined && findAcross(byChain, 'TSLAc').matches[0].symbol === 'TSLAc')
  check('another issuer\'s suffix is not stripped (TSLAx is not ours)', findAcross(rhOnly, 'TSLAx').match === 'none')
  check('stripping only promotes exact tickers, never fuzzy names', findAcross({ robinhood: { records: [rec('robinhood', 'TSLAQ', 'Something', 'XX1', a(6))] } }, 'TSLAc').match === 'none')
  check('the limit is honoured and the rest counted', (() => { const x = findAcross(byChain, 'n', 2); return x.matches.length === 2 && x.more > 0 })())
}

console.log('the same share elsewhere')
{
  const s = sameStockElsewhere(byChain, 'base', a(1))
  check('NVDAc on Base finds NVDA on Robinhood by ISIN', s.length === 1 && s[0].chain === 'robinhood' && s[0].address === a(4))
  check('...with its latest reading', s[0].latest.premium === -0.012 && s[0].latest.reference_price_usd === 100)
  check('a look-alike symbol with another ISIN is not the same share', !sameStockElsewhere(byChain, 'robinhood', a(5)).length)
  check('a share listed on one chain only has no counterpart', sameStockElsewhere(byChain, 'base', a(2)).length === 0)
  check('an address outside the registry has no counterpart', sameStockElsewhere(byChain, 'base', a(9)).length === 0)
}

console.log('the board')
{
  const o = overview(byChain)
  check('furthest from the reference first', o.base.rows[0].symbol === 'TSLAc' && o.base.rows[1].symbol === 'NVDAc', JSON.stringify(o.base.rows.map((r) => r.symbol)))
  check('an unpriced token is counted, not ranked', o.base.priced === 2 && o.base.unpriced === 1 && !o.base.rows.some((r) => r.symbol === 'NVDLc'))
  check('both chains are on the board', o.robinhood.rows.length === 1 && o.robinhood.issuer === 'robinhood')
  check('a liquidity floor moves thin pools to unpriced', overview(byChain, { minLiquidityUsd: 100_000 }).base.priced === 0)
  const now = Date.parse('2026-11-08T14:10:00Z')
  check('fresh readings stay on the board when the time is given', overview(byChain, { now }).base.priced === 2)
  check('the board gives the reference age now, not at the reading', overview(byChain, { now }).base.rows[0].reference_age_s === 3600 + 600, String(overview(byChain, { now }).base.rows[0].reference_age_s))
  const late = overview(byChain, { now: Date.parse('2026-11-08T15:00:00Z') })
  check('readings older than two recorder runs leave the board and are counted as stale', late.base.priced === 0 && late.base.stale === 3 && late.base.rows.length === 0, JSON.stringify(late.base))
  check('...and the board says when its newest reading was taken', late.base.newest_reading_at === '2026-11-08T14:00:00.000Z')
  check('a chain with no readings yet is an empty board, not an error', overview({ base: { records: byChain.base.records, window: null } }).base.priced === 0)
}

console.log('the Base and Robinhood matrix')
{
  const NOW = Date.parse('2026-11-08T14:10:00Z')
  const REF_AT = '2026-11-08T13:30:00Z'
  // A reading as the recorder writes it: the premium is over the venue's own reference, per token, at its multiplier.
  const rd = (address, premium, { at = '2026-11-08T14:00:00Z', mult = 1, ref = 100, kind = 'nav_total_return', liq = 50_000, refused = 'no_eligible_pool' } = {}) => ({
    token_address: address, observed_at: at, multiplier: mult, premium, premium_refused: premium == null ? refused : null,
    dex_price_usd: premium == null ? null : ref * (1 + premium), dex_pool: '0xpool',
    reference: { kind, price_usd: ref, updated_at: REF_AT, age_s: 60, halted: false }, pools: { seen: 2, eligible: 1, capped: false, top: [{ liquidity_usd: liq }] },
  })
  // A window entry with earlier points, so the premium at the reference's own time has something to find.
  const ent = (row, earlier = []) => ({ latest: row, latestAt: Date.parse(row.observed_at), points: [...earlier, [Date.parse(row.observed_at), row.premium]] })
  const w = (list) => ({ loaded_at: NOW, byToken: new Map(list.map((e) => [e.latest.token_address, e])) })
  const RH = { kind: 'token_bid_ask_mid' }
  const I = { nvda: 'US67066G1040', tsla: 'US88160R1014', brk: 'US0846707026', goog: 'US02079K1079', amzn: 'US0231351067', meta: 'US30303M1027' }
  const m = matrix({
    base: {
      records: [rec('coinbase', 'NVDAc', 'NVIDIA', I.nvda, a(1)), rec('coinbase', 'TSLAc', 'Tesla', I.tsla, a(2)), rec('coinbase', 'BRKBc', 'Berkshire', I.brk, a(3)),
        rec('coinbase', 'GOOGc', 'Alphabet', I.goog, a(4)), rec('coinbase', 'AMZNc', 'Amazon', I.amzn, a(5)), rec('coinbase', 'METAc', 'Meta', I.meta, a(6))],
      window: w([ent(rd(a(1), 0.004), [[Date.parse('2026-11-08T13:15:00Z'), 0.001], [Date.parse('2026-11-08T13:45:00Z'), 0.002]]), ent(rd(a(2), -0.03, { ref: 400 })), ent(rd(a(3), null)),
        ent(rd(a(4), 0.05, { at: '2026-11-08T13:00:00Z' })), ent(rd(a(5), 0.001)), ent(rd(a(6), 0.002))]),
    },
    robinhood: {
      records: [rec('robinhood', 'NVDA', 'NVIDIA  Robinhood Token', I.nvda, a(7)), rec('robinhood', 'TSLA', 'Tesla  Robinhood Token', I.tsla, a(8)), rec('robinhood', 'BRK.B', 'Berkshire  Robinhood Token', I.brk, a(9)),
        rec('robinhood', 'GOOG', 'Alphabet  Robinhood Token', I.goog, a('a')), rec('robinhood', 'AMZN', 'Amazon  Robinhood Token', I.amzn, a('b')),
        // A look-alike: the same ticker letters as Meta, another security.
        rec('robinhood', 'META', 'Metaverse Fund  Robinhood Token', 'XX1111111111', a('c'))],
      window: w([ent(rd(a(7), -0.06, { ...RH, liq: 20_000 })), ent(rd(a(8), 0.01, { ...RH, mult: 0.5, ref: 200 })), ent(rd(a(9), 0.002, RH)), ent(rd(a('a'), 0.001, RH)), ent(rd(a('c'), 0.2, RH))]),
    },
  }, { now: NOW })
  const row = (sym) => m.rows.find((r) => r.base.symbol === sym)
  check('one row per ISIN listed on both chains', m.pairs === 5 && m.rows.length === 5, JSON.stringify(m.rows.map((r) => r.base.symbol)))
  check('a share is paired by ISIN even when the tickers differ (BRKBc and BRK.B)', row('BRKBc')?.robinhood.symbol === 'BRK.B')
  check('a look-alike symbol with another ISIN is not paired', !row('METAc') && !m.rows.some((r) => r.robinhood.symbol === 'META'))
  const t = row('TSLAc'), n = row('NVDAc')
  check('the gap is the Robinhood premium minus the Base premium', t.gap === 0.01 - -0.03 && n.gap === -0.06 - 0.004, `${t.gap} ${n.gap}`)
  check('premiums are compared, never raw prices: the multipliers and references differ', t.robinhood.multiplier === 0.5 && Math.abs(t.gap) < 1 && t.base.dex_price_usd !== t.robinhood.dex_price_usd)
  check('rows with a gap come first, the largest |gap| first', m.rows[0].base.symbol === 'NVDAc' && m.rows[1].base.symbol === 'TSLAc' && m.with_gap === 2, JSON.stringify(m.rows.map((r) => [r.base.symbol, r.gap])))
  check('rows without a gap go last, each with its reason', m.rows.slice(2).every((r) => r.gap == null && r.gap_refused) && m.without_gap === 3)
  const b = row('BRKBc')
  check('a missing premium carries its reason', b.base.premium === null && b.base.premium_refused === 'no_eligible_pool' && b.gap_refused === 'base: no_eligible_pool', JSON.stringify(b.gap_refused))
  check('a venue with no reading at all says so', row('AMZNc').robinhood.premium_refused === 'no_readings' && row('AMZNc').gap_refused === 'robinhood: no_readings')
  const g = row('GOOGc')
  check('a reading older than 30 min is flagged stale and gets no gap', g.base.stale === true && g.base.premium === 0.05 && g.gap === null && g.gap_refused === 'base: reading_stale' && m.stale === 1, JSON.stringify(g.base))
  check('a stale row is never ranked among the current ones', m.rows.indexOf(g) >= m.with_gap)
  check('fresh readings are not flagged', n.base.stale === false && n.robinhood.stale === false)
  check('Coinbase NAV against Robinhood bid/ask is flagged as different references, in words', m.rows.every((r) => r.reference_kinds_differ === true) && /different references/.test(n.reference_note) && /Coinbase NAV/.test(n.reference_note) && /bid\/ask/.test(n.reference_note))
  check('the matrix says it compares premiums', m.compares === 'premium' && /never compared/.test(m.note))
  check('each venue names its symbol, address, multiplier, reference and pool', n.base.address === a(1) && n.robinhood.address === a(7) && n.base.multiplier === 1 && n.base.reference_kind === 'nav_total_return' && n.base.reference_price_usd === 100 && n.robinhood.liquidity_usd === 20_000)
  check('the reference age is computed against now, not the stored age', n.base.reference_age_s === 2400, String(n.base.reference_age_s))
  // Acceptance: each cell equals the passport's value.
  const p = buildPassport({ address: a(1), chainId: 8453, registry: [rec('coinbase', 'NVDAc', 'NVIDIA', I.nvda, a(1))], readings: readingsOf(ent(rd(a(1), 0.004), [[Date.parse('2026-11-08T13:15:00Z'), 0.001], [Date.parse('2026-11-08T13:45:00Z'), 0.002]]), a(1)), now: NOW })
  check('each cell equals the passport', n.base.premium === p.latest.premium && n.base.reference_age_s === p.reference.age_s && n.base.multiplier === p.issuer.multiplier && n.base.dex_price_usd === p.latest.dex_price_usd &&
    JSON.stringify(n.base.premium_at_reference_time) === JSON.stringify(p.latest.premium_at_reference_time) && n.base.premium_at_reference_time?.premium === 0.002, JSON.stringify([n.base.premium_at_reference_time, p.latest.premium_at_reference_time]))
  check('a matrix without the time is refused', (() => { try { matrix({}); return false } catch (_) { return true } })())
  check('one chain missing is an empty matrix, not an error', matrix({ base: { records: [rec('coinbase', 'NVDAc', 'NVIDIA', I.nvda, a(1))], window: null } }, { now: NOW }).pairs === 0)
  const reg = { base: { records: [rec('coinbase', 'NVDAc', 'NVIDIA', I.nvda, a(1))] }, robinhood: { records: [rec('robinhood', 'NVDA', 'NVIDIA', I.nvda, a(7))] } }
  check('a ticker resolves to its ISIN: NVDA, NVDAc and nvdac alike', ['NVDA', 'NVDAc', 'nvdac'].every((s) => JSON.stringify(isinsOfTicker(reg, s)) === JSON.stringify([I.nvda])))
  check('an unknown ticker resolves to nothing', isinsOfTicker(reg, 'ZZZZ').length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
