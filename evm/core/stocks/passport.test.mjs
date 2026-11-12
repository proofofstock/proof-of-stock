// evm/core/stocks/passport.test.mjs: a registry token gets its issuer, reference with its age, latest reading and a
// premium series split by market session; a token outside the registry gets no issuer and, if its name claims one, the
// resemblance; every gap is a named note; nothing here is a trading signal.
//
// Run: node evm/core/stocks/passport.test.mjs

import { buildPassport, NOTE_CODES } from './passport.mjs'
import { resemblance, tickerOf } from './impostor.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}

const A = '0x' + 'aa'.repeat(20), X = '0x' + 'ee'.repeat(20)
const cb = (over = {}) => ({ issuer: 'coinbase', chain_id: 8453, address: A, symbol: 'NVDAc', name: 'NVIDIA', isin: 'US67066G1040', multiplier: 1.011, multiplier_pending: null, supplied: true, paused: [], reference: { kind: 'nav_total_return', price_usd: 180, bid: null, ask: null, updated_at: '2026-11-06T21:00:00Z', halted: null }, ...over })
const reading = (iso, premium, over = {}) => ({ token_address: A, observed_at: iso, multiplier: 1.011, multiplier_pending: null, paused: [], reference: { kind: 'nav_total_return', price_usd: 180, updated_at: '2026-11-06T21:00:00Z', age_s: Math.round((Date.parse(iso) - Date.parse('2026-11-06T21:00:00Z')) / 1000), halted: null }, pools: { seen: 3, eligible: 2, capped: false, top: [] }, dex_price_usd: premium == null ? null : 180 * (1 + premium), dex_pool: '0xpool', premium, premium_refused: premium == null ? 'no_eligible_pool' : null, ...over })

console.log('a registry token')
{
  const now = Date.parse('2026-11-08T14:00:00Z') // Sunday
  const readings = [
    reading('2026-11-06T15:00:00Z', 0.001), // Friday regular
    reading('2026-11-06T22:00:00Z', 0.004), // Friday after hours
    reading('2026-11-07T15:00:00Z', 0.010), // Saturday
    reading('2026-11-08T13:45:00Z', 0.020), // Sunday, latest
  ]
  const p = buildPassport({ address: A.toUpperCase().replace('0X', '0x'), chainId: 8453, registry: [cb()], readings, now })
  check('in the registry, issuer named, ISIN carried', p.in_registry === true && p.issuer.name === 'coinbase' && p.issuer.isin === 'US67066G1040')
  check('never a trading signal', p.not_trading_signal === true)
  check('rights are pointed at the prospectus, never stated', /prospectus/.test(p.issuer.rights))
  check('the latest reading is the newest one', p.latest.premium === 0.02 && p.latest.observed_at === '2026-11-08T13:45:00Z')
  check('a Sunday reference two days old is held, market closed', p.notes.includes('reference_held_market_closed') && !p.notes.includes('reference_held_market_open'), JSON.stringify(p.notes))
  check('the market now is closed for the weekend', p.market_now.session === 'closed' && p.market_now.reason === 'weekend')
  check('the series is split by session', p.series.premium_by_session.regular.n === 1 && p.series.premium_by_session.extended.n === 1 && p.series.premium_by_session.closed.n === 2, JSON.stringify(p.series.premium_by_session))
  check('...with its spread', p.series.premium_by_session.closed.max === 0.02 && p.series.premium_all.n === 4)
  check('every note is a declared code', p.notes.every((n) => NOTE_CODES.includes(n)))

  const old = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings, now, windowH: 24 })
  check('the window bounds the series', old.series.readings === 2 && old.series.first_at === '2026-11-07T15:00:00Z', String(old.series.readings))
  // The owner's rule (11.11): no price older than the window, latest included. A recorder stopped for 48 h shows none.
  const gone = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T12:00:00Z', 0.01)], now: Date.parse('2026-11-10T12:00:00Z'), windowH: 24 })
  check('a newest reading older than the window is not shown: latest is null and the passport says reading_stale', gone.latest === null && gone.notes.includes('reading_stale') && !gone.notes.includes('no_readings') && gone.series.readings === 0, JSON.stringify({ latest: gone.latest && gone.latest.observed_at, notes: gone.notes }))
  const inside = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-09T13:00:00Z', 0.01)], now: Date.parse('2026-11-10T12:00:00Z'), windowH: 24 })
  check('a reading inside the window is still latest, flagged stale when old', inside.latest && inside.latest.observed_at === '2026-11-09T13:00:00Z' && inside.notes.includes('reading_stale'))

  const open = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-10T15:00:00Z', 0)], now: Date.parse('2026-11-10T15:05:00Z') })
  check('a reference days old while the exchange is OPEN is flagged as such', open.notes.includes('reference_held_market_open'))

  const none = buildPassport({ address: A, chainId: 8453, registry: [cb({ reference: { kind: 'nav_total_return', price_usd: null, updated_at: null, halted: null } })], readings: [], now })
  check('no NAV and no readings are both named', none.notes.includes('no_reference') && none.notes.includes('no_readings') && none.latest === null)

  const thin = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T13:45:00Z', null, { pools: { seen: 30, eligible: 0, capped: true, top: [] } })], now })
  check('no DEX price and a capped pool list are named', thin.notes.includes('no_dex_price') && thin.notes.includes('pools_capped'))

  const pend = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T13:45:00Z', 0, { multiplier_pending: 1.02 })], now })
  check('a pending multiplier change is named', pend.notes.includes('multiplier_change_pending') && pend.issuer.multiplier_pending === 1.02)

  // A token with no NAV still has a DEX price: saying "no DEX price" there would contradict the price shown beside it.
  const noNav = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T13:45:00Z', null, { premium_refused: 'no_reference', dex_price_usd: 181, reference: { kind: 'nav_total_return', price_usd: null, updated_at: null, age_s: null, halted: null } })], now })
  check('no reference is named as such, never as no DEX price', noNav.notes.includes('no_reference') && !noNav.notes.includes('no_dex_price'), JSON.stringify(noNav.notes))
  const wide = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T13:45:00Z', null, { premium_refused: 'reference_spread_wide', dex_price_usd: 181, dex_inside_quote: true })], now })
  check('a quote too wide to price against is named, not called a missing DEX price', wide.notes.includes('reference_spread_wide') && !wide.notes.includes('no_dex_price') && wide.latest.dex_inside_quote === true)
  const stale = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T13:00:00Z', 0.01)], now })
  const series = buildPassport({ address: A, chainId: 8453, registry: [cb({ reference: { kind: 'nav_total_return', price_usd: 180, updated_at: '2026-11-08T13:00:00Z', halted: null } })], readings: [reading('2026-11-08T12:50:00Z', 0.03), reading('2026-11-08T13:05:00Z', -0.001, { reference: { kind: 'nav_total_return', price_usd: 180, updated_at: '2026-11-08T13:00:00Z', halted: null } }), reading('2026-11-08T13:45:00Z', 0.02, { reference: { kind: 'nav_total_return', price_usd: 180, updated_at: '2026-11-08T13:00:00Z', halted: null } })], now })
  check('the premium as of the reference time comes from the first reading after the reference moved', series.latest.premium_at_reference_time && series.latest.premium_at_reference_time.premium === -0.001 && series.latest.premium_at_reference_time.lag_s === 300, JSON.stringify(series.latest.premium_at_reference_time))
  check('the latest says how often the recorder reads', series.latest.cadence_s === 900)
  const openLag = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-10T15:00:00Z', 0, { reference: { kind: 'nav_total_return', price_usd: 180, updated_at: '2026-11-10T14:25:00Z', halted: null } })], now: Date.parse('2026-11-10T15:05:00Z') })
  check('with the market open, a reference 40 minutes old is already named', openLag.notes.includes('reference_held_market_open'), JSON.stringify(openLag.notes))
  check('the reference age is measured now, not at the reading', stale.reference.age_s === Math.round((now - Date.parse('2026-11-06T21:00:00Z')) / 1000), String(stale.reference.age_s))
  check('a latest reading an hour old says the recorder is behind', stale.notes.includes('reading_stale') && stale.latest.age_s === 3600)
  check('a reading fifteen minutes old does not', !buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T13:45:00Z', 0.01)], now }).notes.includes('reading_stale'))
  check('the new notes are declared codes', ['reference_spread_wide', 'reading_stale'].every((c) => NOTE_CODES.includes(c)))

  const unminted = buildPassport({ address: A, chainId: 8453, registry: [cb({ supplied: false, reference: { kind: 'nav_total_return', price_usd: null, updated_at: null, halted: null } })], readings: [], now })
  check('a listed token not minted yet says so once, not as missing readings', unminted.issuer.minted === false && unminted.notes.includes('not_minted') && !unminted.notes.includes('no_readings'), JSON.stringify(unminted.notes))
  check('a minted token is minted', buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [], now }).issuer.minted === true)

  const halted = buildPassport({ address: A, chainId: 8453, registry: [cb()], readings: [reading('2026-11-08T13:45:00Z', 0, { reference: { kind: 'token_bid_ask_mid', price_usd: 1, age_s: 5, halted: true } })], now })
  check('a trading halt is named', halted.notes.includes('trading_halted'))
}

console.log('a token outside the registry')
{
  const now = Date.parse('2026-11-08T14:00:00Z')
  const fake = buildPassport({ address: X, chainId: 8453, registry: [cb()], identity: { symbol: 'NVDAc', name: 'NVIDIA' }, now })
  check('not in the registry, no issuer, no reading', fake.in_registry === false && fake.issuer === null && fake.latest === null && fake.notes.includes('not_in_registry'))
  check('the same symbol as a registry token is the strongest resemblance', fake.resembles && fake.resembles.kind === 'registry_symbol' && fake.resembles.registry_address === A)
  const meme = buildPassport({ address: X, chainId: 8453, registry: [cb()], identity: { symbol: 'PEPE', name: 'Pepe' }, now })
  check('a token that resembles nothing says so', meme.resembles === null)
}

console.log('resemblance')
{
  const rh = { issuer: 'robinhood', chain_id: 4663, address: A, symbol: 'TSLA', name: 'Tesla  Robinhood Token' }
  check('Coinbase tickers drop the c suffix', tickerOf(cb()) === 'NVDA' && tickerOf(rh) === 'TSLA')
  check('a registry token resembles nothing: it IS the asset', resemblance({ address: A, symbol: 'NVDAc' }, [cb()]) === null)
  check('the bare ticker is a weak resemblance', resemblance({ address: X, symbol: 'nvda' }, [cb()])?.kind === 'ticker')
  check('the case-sensitive symbol is the strong one', resemblance({ address: X, symbol: 'NVDAc' }, [cb()])?.kind === 'registry_symbol')
  check('the issuer naming convention is recognised', resemblance({ address: X, symbol: 'TSL4', name: 'Tesla Robinhood Token' }, [rh])?.kind === 'issuer_name_suffix')
  check('a bare-ticker issuer symbol (Robinhood GME) is only a weak resemblance', resemblance({ address: X, symbol: 'TSLA', name: 'tsla to the moon' }, [rh])?.kind === 'ticker')
  check('a name merely containing Robinhood is not the convention', resemblance({ address: X, symbol: 'HOOD2', name: 'Robinhood Tokenomics' }, [rh]) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
