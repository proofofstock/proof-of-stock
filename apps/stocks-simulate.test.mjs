// apps/stocks-simulate.test.mjs: simulate_buy's orchestration against a fake aggregator and a fake node (docs/simulate-buy-tz.md
// §9.1). A refused token costs no outside call; a quote for another token or amount is no quote; a swap goes to the
// pinned router or is not run; the override covers only what is missing, keeps USDC's blocklist bit and never touches
// the stock token; a wrapped revert is attributed by probes, never by its own text; every failure is `unknown` with its
// reason; quotes are cached for QUOTE_TTL_S and a dry run never is; the aggregator's cap is shared fairly.
//
// The fake router wraps every inner revert as the real ones do ("STF" for the stable, a generic failure for the pool).
// No outside call is made: every request goes to the fakes in apps/simulate/fake-world.mjs.
//
// Run: node apps/stocks-simulate.test.mjs
import fs from 'node:fs'
import { createSimulator, CHAINS_SIM, BUSY } from './stocks-simulate.mjs'
import { parseInput, QUOTE_TTL_S } from '../evm/core/stocks/simulate.mjs'
import { SELECTORS as AERO } from './simulate/quote-aerodrome.mjs'
import { STABLES, mapKey, allowanceKey, simulateSwap } from './simulate/sim-evm.mjs'
import { world, T, X, OTHER, W, POOL, POOL2, D, REVERT, HIGH, OTHER_ROUTER, w, strip } from './simulate/fake-world.mjs'
import { KYBER_ROUTER } from '../packages/proofofstock-guard/examples/agent-buy.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const NOW0 = Date.parse('2026-12-01T15:00:00Z')
let clock = NOW0
const now = () => clock

/** The site's own functions, as stocks-web hands them in: counted, so a test sees one snapshot used throughout. */
function siteData ({ verdict = 'listed', chain = 'base', passport = {} } = {}) {
  const snap = { at: 1, id: Math.random() }
  const seen = { snapshot: 0, used: [] }
  const body = (a) => verdict === 'listed' && a === T ? { listed: true, chain, address: T, issuer: chain === 'base' ? 'coinbase' : 'robinhood', symbol: 'TSLAc', impostor: null, passport: 'p' }
    : verdict === 'impostor' || a === X ? { listed: false, chain, address: a, symbol: null, impostor: { kinds: ['registry_symbol'], imitates_symbol: 'TSLAc', listed_address: T } }
      : { listed: false, chain, address: a, symbol: null, impostor: null }
  return {
    seen,
    snapshot: () => { seen.snapshot++; return snap },
    find: (c, q) => ({ match: q === 'TSLA' ? 'exact' : 'fuzzy', matches: q === 'TSLA' || q === 'TS' ? [{ chain: c, symbol: 'TSLAc', address: T, match_quality: q === 'TSLA' ? 'exact' : 'prefix' }] : [] }),
    verify: (c, a, s) => { seen.used.push(s); return verdict === 'unavailable' ? { status: 'unavailable', body: { error: 'registry unavailable', registry_age_s: 9999 } } : { status: 'ok', body: body(a) } },
    listProof: (c, s) => { seen.used.push(s); return { registry_hash: 'sha256:' + 'ab'.repeat(32) } },
    passport: async (c, a, s) => { seen.used.push(s); return { status: 200, body: { issuer: { symbol: 'TSLAc', minted: chain === 'base' ? true : null, paused: [], ...(passport.issuer || {}) }, reference: { kind: 'nav', price_usd: 100, updated_at: '2026-12-01T14:59:20Z', age_s: 40, halted: false }, latest: null, notes: [], market_now: { session: 'regular' } } } },
  }
}
const inputOf = (o) => parseInput({ chain: 'base', token: T, usd: 25, ...o }).input
async function run (wd, o = {}, { data = siteData({ chain: wd.chain }), client = 'c1', sim = null } = {}) {
  const s = sim || createSimulator({ data, fetchImpl: wd.fetchImpl, env: {}, now, log: () => {} })
  const r = await s.run(inputOf({ chain: wd.chain, ...o }), { client })
  return { ...r, sim: s, data }
}
const outside = (wd) => wd.requests.length
const tokenTouched = (wd) => wd.overrides.some((ov) => Object.keys(ov).some((k) => k === T))

console.log('the verdict comes first, and a refusal costs nothing outside')
{
  for (const [verdict, token, why] of [['impostor', X, 'impostor'], ['none', OTHER, 'not_listed']]) {
    const wd = world('base')
    const r = await run(wd, { token, wallet: W }, { data: siteData({ verdict }) })
    check(`no outside call for a refused token (${why}): the fake aggregator and node count zero requests`, r.body.outcome === 'refused' && r.body.verdict.reason === why && outside(wd) === 0, JSON.stringify(wd.requests))
  }
  for (const [p, why] of [[{ issuer: { minted: false } }, 'not_minted'], [{ issuer: { paused: ['all'] } }, 'paused'], [{ issuer: { paused: null } }, 'paused_unknown']]) {
    const wd = world('robinhood')
    const r = await run(wd, { wallet: W }, { data: siteData({ chain: 'robinhood', passport: p }) })
    check(`...${why} too`, r.body.verdict.reason === why && outside(wd) === 0)
  }
  const wd = world('base')
  const r = await run(wd, { token: 'TS' })
  check('...a ticker that is not exact too, with its candidates', r.body.verdict.reason === 'ticker_not_exact' && r.body.verdict.candidates.length === 1 && outside(wd) === 0)
  const u = await run(world('base'), {}, { data: siteData({ verdict: 'unavailable' }) })
  check('registry unavailable: a 503, never a quote without a verdict', u.status === 503 && u.body.error === 'registry unavailable')
  const one = await run(world('base'), { wallet: W })
  check('one snapshot: the verdict, the list proof and the passport all get the one read', one.data.seen.snapshot === 1 && one.data.seen.used.length === 3 && one.data.seen.used.every((s) => s === one.data.seen.used[0]))
  const tick = await run(world('base'), { token: 'TSLA' })
  check('a ticker with one exact match resolves to it and is quoted', tick.body.outcome === 'quoted' && tick.body.verdict.address === T && tick.body.query === 'TSLA')
}

console.log('Base: Aerodrome\'s own quote first, KyberSwap the second line')
{
  const wd = world('base')
  const r = await run(wd)
  check('the primary quote is Aerodrome\'s, one pool, its tick spacing as the route', r.body.outcome === 'quoted' && r.body.quote.source === 'aerodrome' && r.body.quote.route.kind === 'single_pool' && r.body.quote.route.tick_spacing === 10 && r.body.quote.tokens_out_base_units === '24900000')
  check('a pool whose quote reverts is skipped, never zero: the reverted pools are counted, the answering one is taken', r.body.quote.route.pool === POOL && r.body.quote.route.tick_spacing === 10)
  check('the KyberSwap line is shown beside it, as a fact (which is larger), and its labels are cut', r.body.venues.kyberswap.result === 'ok' && r.body.venues.kyberswap.more_than_primary === true && r.body.venues.kyberswap.same_route === true && /^[a-z0-9\-/]+$/.test(r.body.venues.kyberswap.route.pools[0]))
  check('the Aerodrome link has the checked contract filled in', r.body.venues.aerodrome.link.includes('to=' + T))
  check('gas in dollars from the base fee and the ETH price in the same batch', r.body.quote.gas.units === 150000 && r.body.quote.gas.usd > 0)
  check('the sell-back is Aerodrome\'s too, for the tokens just quoted', r.body.sell_back.result === 'ok' && r.body.sell_back.source === 'aerodrome' && r.body.sell_back.tokens_in_base_units === '24900000')
  const mm = await run(world('base', { quoterFactory: OTHER }))
  check('a quoter whose factory() is another factory gives quoter_mismatch', mm.body.quote.result === 'unknown' && mm.body.quote.reason === 'quoter_mismatch' && mm.body.outcome === 'checked')
  const none = await run(world('base', { quotes: { 1: REVERT, 10: REVERT, 50: REVERT } }))
  check('no Aerodrome pool answers: quote no_route, the KyberSwap line still shown', none.body.quote.result === 'no_route' && none.body.venues.kyberswap.result === 'ok')
  const kd = await run(world('base', { aggregatorDown: true }))
  check('KyberSwap down on Base costs one line: venues.kyberswap unknown, the Aerodrome quote answers', kd.body.quote.result === 'ok' && kd.body.venues.kyberswap.result === 'unknown' && kd.body.venues.kyberswap.reason === 'aggregator_unavailable')
}

console.log('the quotes are held to what was asked')
{
  const swapTo = (patch) => world('robinhood', { kyber: ({ rs, sell }) => ({ status: 200, body: { code: 0, data: { routeSummary: { ...rs, ...patch(sell) } } } }) })
  const a = await run(swapTo((sell) => (sell ? {} : { tokenOut: OTHER })))
  check('a quote for another token is quote_mismatch', a.body.quote.result === 'unknown' && a.body.quote.reason === 'quote_mismatch' && a.body.verdict.listed === true)
  const b = await run(swapTo((sell) => (sell ? {} : { amountIn: '1' })))
  check('a quote for another amount is quote_mismatch', b.body.quote.reason === 'quote_mismatch')
  const c = await run(swapTo((sell) => (sell ? { tokenOut: OTHER } : {})))
  check('a sell-back for another token is quote_mismatch, the buy quote still shown', c.body.quote.result === 'ok' && c.body.sell_back.result === 'unknown' && c.body.sell_back.reason === 'quote_mismatch')
  const d = await run(swapTo((sell) => (sell ? { amountIn: '7' } : {})))
  check('a sell-back for another amount is quote_mismatch', d.body.sell_back.reason === 'quote_mismatch')
  const ew = swapTo(() => ({ amountOut: '0' }))
  const e = await run(ew)
  check('an amountOut of zero is quote_empty, and no sell-back is asked for nothing', e.body.quote.reason === 'quote_empty' && ew.requests.filter((q) => q.kind === 'aggregator').length === 1)
  const f = await run(world('robinhood', { aggregatorDown: true }))
  check('aggregator 5xx: quote unknown, the verdict still in the answer, outcome checked', f.status === 200 && f.body.quote.reason === 'aggregator_unavailable' && f.body.verdict.listed === true && f.body.outcome === 'checked')
  const g = await run(world('robinhood', { kyber: () => ({ status: 400, body: { code: 4008, message: 'route not found' } }) }))
  check('no route is a fact, not an error: quote no_route', g.body.quote.result === 'no_route')
  const h = await run(world('base', { decimalsDown: true }))
  check('decimals unreadable: the quote is unknown, never computed with a default', h.body.quote.result === 'unknown' && h.body.quote.reason === 'decimals_unavailable' && h.body.quote.tokens_out === null)
  const rh = await run(world('robinhood'))
  check('Robinhood Chain: KyberSwap is the primary, and its dollar figures for the token are not taken', rh.body.quote.source === 'kyberswap' && !JSON.stringify(rh.body).includes('999') && rh.body.context.notes.includes('minted_unknown'))
}

console.log('the dry run: only what is missing, the token as it is')
{
  const wd = world('base')
  const r = await run(wd, { wallet: W })
  const sim = r.body.simulation
  check('an empty wallet: would_succeed with the stable, the approval and the gas supplied, at the head block', sim.result === 'would_succeed' && sim.simulated_with.join() === 'stable_balance,stable_allowance,native_balance' && sim.head_block === 30000000 && sim.gas_units > 0)
  check('the swap went to the pinned router, encoded by us', wd.requests.some((q) => q.method === 'eth_call' && q.params[0].to === D.router && strip(q.params[0].data).startsWith(AERO.exactInputSingle)))
  const rich = world('base')
  rich.set(mapKey(W, 9), 10n ** 12n); rich.set(allowanceKey(W, D.router, 10), 10n ** 12n); rich.native.set(W, 10n ** 18n)
  const rr = await run(rich, { wallet: W })
  const swapOv = rich.requests.filter((q) => q.method === 'eth_call' && q.params[0].to === D.router).map((q) => q.params[2])
  check('a wallet with enough balance and allowance is simulated with no stable override', rr.body.simulation.result === 'would_succeed' && rr.body.simulation.simulated_with.length === 0 && swapOv.every((ov) => !ov || !ov[STABLES.base.address]), JSON.stringify(swapOv))
  // The token's own account and storage are never overridden, whatever the caller sends: even a wallet that is the token.
  const cases = [world('base'), world('robinhood'), world('base'), world('base', { refuses: new Set([W]) })]
  await run(cases[0], { wallet: W }); await run(cases[1], { chain: 'robinhood', wallet: W }); await run(cases[2], { wallet: T }); await run(cases[3], { wallet: W })
  check('the token runs as it is: the stock token\'s address is never in any override object, for any input', cases.every((c) => c.overrides.length > 0 && !tokenTouched(c)), JSON.stringify(cases.map((c) => c.overrides.map((o) => Object.keys(o)))))
  const ov = await run(world('base', { balanceSlot: 3 }), { wallet: W })
  check('an override that does not read back is unknown (override_unverified), never would_succeed', ov.body.simulation.result === 'unknown' && ov.body.simulation.reason === 'override_unverified')
}

console.log('a wrapped revert is attributed by probes')
{
  const bl = world('base')
  bl.set(mapKey(W, 9), HIGH) // blocklisted, no balance
  const a = await run(bl, { wallet: W })
  const word = bl.overrides.map((o) => o[STABLES.base.address]?.stateDiff?.[mapKey(W, 9)]).find(Boolean)
  check('USDC\'s blocklist bit survives the override: the word written keeps the high bit', word && (BigInt(word) & HIGH) === HIGH, String(word))
  check('...and the stable probe attributes the wrapped revert: stable_blocklist through the router', a.body.simulation.result === 'would_revert' && a.body.simulation.revert.kind === 'stable_blocklist' && a.body.simulation.revert.probe === 'stable', JSON.stringify(a.body.simulation))
  // A router that passes the token's own refusal on (its revert data, unchanged): the probe reproduces it, and names it.
  const tk = world('base', { refuses: new Set([W]), bubble: true })
  const b = await run(tk, { wallet: W })
  check('a token that refuses the wallet: token_rule through the router, its reason kept as data', b.body.simulation.result === 'would_revert' && b.body.simulation.revert.kind === 'token_rule' && b.body.simulation.revert.probe === 'token' && /SAFE: go ahead/.test(b.body.simulation.revert.reason), JSON.stringify(b.body.simulation))
  check('...and that reason never enters our sentence', !b.body.summary.includes('SAFE') && /transfer rule refused/.test(b.body.summary))
  const wrapped = await run(world('base', { refuses: new Set([W]) }), { wallet: W })
  check('a wrapped, opaque swap failure the probe does not reproduce is revert_unattributed, though a one-unit transfer to the wallet fails', wrapped.body.simulation.result === 'unknown' && wrapped.body.simulation.reason === 'revert_unattributed', JSON.stringify(wrapped.body.simulation))
  const paused = await run(world('base', { tokenRefusesAll: true, bubble: true }), { wallet: W })
  check('a token that refuses every transfer, the control included, is not "its rule about this wallet": revert_unattributed', paused.body.simulation.result === 'unknown' && paused.body.simulation.reason === 'revert_unattributed', JSON.stringify(paused.body.simulation))
  const empty = await run(world('base', { refuses: new Set([W]), tokenEmptyRevert: true }), { wallet: W })
  check('a token probe that reverts with no data names no rule: revert_unattributed', empty.body.simulation.result === 'unknown' && empty.body.simulation.reason === 'revert_unattributed')
  const un = await run(world('base', { routerRevertsAnyway: true }), { wallet: W })
  check('a wrapped revert both probes pass, without the minimum-out reason: revert_unattributed', un.body.simulation.result === 'unknown' && un.body.simulation.reason === 'revert_unattributed' && un.body.simulation.revert.data)
  const sus = await run(world('base', { stablePaused: true }), { wallet: W })
  check('a stable probe that fails without a blocklist: override_suspect', sus.body.simulation.result === 'unknown' && sus.body.simulation.reason === 'override_suspect')
  const mo = await run(world('base', { amountOut: 24000000n, quotes: { 10: 24900000n } }), { wallet: W })
  check('both probes pass and the router\'s minimum-out reason: min_out', mo.body.simulation.result === 'would_revert' && mo.body.simulation.revert.kind === 'min_out')
  const rhbl = await run(world('robinhood', { refuses: new Set([W]), bubble: true }), { chain: 'robinhood', wallet: W })
  check('Robinhood Chain: the same probes behind KyberSwap\'s router (the pool from its route)', rhbl.body.simulation.revert?.kind === 'token_rule', JSON.stringify(rhbl.body.simulation))
}

console.log('every failure of the dry run is unknown, with its reason')
{
  const cases = [
    ['empty revert data', { emptyRevert: true }, 'revert_empty'],
    ['the RPC\'s own gas cap', { gasCap: true }, 'rpc_gas_cap'],
    ['"header not found" twice', { headerGone: 8 }, 'block_unavailable'],
    ['an undecodable return', { undecodable: true }, 'return_undecodable'],
    ['eth_call passing while eth_estimateGas fails', { estimateFails: true }, 'estimate_disagrees'],
    ['an RPC timeout', { rpcDown: (m) => m === 'eth_blockNumber' }, 'rpc_unavailable'],
  ]
  for (const [what, o, reason] of cases) {
    const r = await run(world('base', o), { wallet: W })
    check(`${what}: simulation unknown, ${reason}`, r.body.simulation.result === 'unknown' && r.body.simulation.reason === reason && r.body.verdict.listed === true, JSON.stringify(r.body.simulation))
  }
  const once = await run(world('base', { headerGone: 1 }), { wallet: W })
  check('"header not found" once: retried at a fresh head, then answered', once.body.simulation.result === 'would_succeed' && once.body.simulation.head_block === 30000001)
  // A build that is right in every field but names another router.
  const toOther = (b, enc) => { const rs = b.routeSummary; const data = enc({ srcToken: rs.tokenIn, dstToken: rs.tokenOut, srcReceivers: [POOL], srcAmounts: [rs.amountIn], dstReceiver: b.recipient, amount: rs.amountIn, minReturnAmount: 1 }); return { body: { code: 0, data: { routerAddress: OTHER_ROUTER, data } }, register: { amountIn: BigInt(rs.amountIn), minOut: 1n, recipient: b.recipient.toLowerCase() } } }
  const otherWd = world('robinhood', { kyberBuild: toOther })
  const other = await run(otherWd, { chain: 'robinhood', wallet: W })
  check('a build to any router but the pinned one is not simulated: router_not_allowed', other.body.simulation.result === 'unknown' && other.body.simulation.reason === 'router_not_allowed', JSON.stringify(other.body.simulation))
  check('...and nothing is sent to that router at all', !otherWd.requests.some((q) => q.kind === 'rpc' && q.params?.[0]?.to === OTHER_ROUTER))
  const unp = await run(world('base', { routerFactory: OTHER }), { wallet: W })
  check('on Base, a SwapRouter whose factory() is another factory is not run: router_not_allowed', unp.body.simulation.reason === 'router_not_allowed')
}

console.log('KyberSwap is held to the swap asked for, in the route and in the build')
{
  const lookalike = await run(world('robinhood', { kyber: ({ rs, sell }) => ({ status: 200, body: { code: 0, data: { routeSummary: sell ? rs : { ...rs, route: [[{ ...rs.route[0][0], tokenOut: X }]] } } } }) }))
  check('a route whose last hop delivers another token is quote_mismatch, whatever the summary says', lookalike.body.quote.result === 'unknown' && lookalike.body.quote.reason === 'quote_mismatch')
  const short = await run(world('robinhood', { kyber: ({ rs, sell }) => ({ status: 200, body: { code: 0, data: { routeSummary: sell ? rs : { ...rs, route: [[{ ...rs.route[0][0], swapAmount: '1' }]] } } } }) }))
  check('...and one whose paths spend another amount than asked', short.body.quote.reason === 'quote_mismatch')
  for (const [what, patch] of [['another output token', { dstToken: X }], ['another recipient', { dstReceiver: OTHER }], ['another input amount', { amount: '1' }], ['another input token', { srcToken: OTHER }]]) {
    const r = await run(world('robinhood', { buildPatch: patch }), { chain: 'robinhood', wallet: W })
    check(`a build for ${what} is not run: build_mismatch, never would_succeed`, r.body.simulation.result === 'unknown' && r.body.simulation.reason === 'build_mismatch', JSON.stringify(r.body.simulation))
  }
  const unv = await run(world('robinhood', { kyberBuild: (b, enc) => ({ body: { code: 0, data: { routerAddress: KYBER_ROUTER, data: enc({ srcToken: b.routeSummary.tokenIn, dstToken: b.routeSummary.tokenOut, srcReceivers: [POOL], srcAmounts: [b.routeSummary.amountIn], dstReceiver: b.recipient, amount: b.routeSummary.amountIn, minReturnAmount: 1, selector: 'deadbeef' }) } } }) }), { chain: 'robinhood', wallet: W })
  check('a build with an entry point we do not decode is not run: build_unverified', unv.body.simulation.result === 'unknown' && unv.body.simulation.reason === 'build_unverified')
  const ok = await run(world('robinhood'), { chain: 'robinhood', wallet: W })
  check('...the realistic build (swap, its description decoded) is run and answers', ok.body.simulation.result === 'would_succeed', JSON.stringify(ok.body.simulation))
  const nul = await run(world('robinhood', { kyber: ({ rs }) => ({ status: 200, body: { code: 0, data: { routeSummary: { ...rs, gasUsd: null } } } }) }))
  check('a missing gasUsd stays null, never a zero', nul.body.quote.result === 'ok' && nul.body.quote.gas.usd === null)
  const numW = world('robinhood', { kyber: ({ rs, sell }) => ({ status: 200, body: { code: 0, data: { routeSummary: sell ? rs : { ...rs, amountOut: Number(rs.amountOut) } } } }) })
  const num = await run(numW)
  check('an amountOut sent as a JSON number (maybe rounded already) is no amount: quote_empty, and nothing is asked on it', num.body.quote.result === 'unknown' && num.body.quote.reason === 'quote_empty' && numW.requests.filter((q) => q.kind === 'aggregator').length === 1)
  const five = await run(world('robinhood', { kyber: () => ({ status: 502, body: { code: 4008, message: 'no route: upstream timeout' } }) }))
  check('a 5xx that says "no route" is an outage, not a fact: aggregator_unavailable', five.body.quote.result === 'unknown' && five.body.quote.reason === 'aggregator_unavailable')
}

console.log('Aerodrome: the whole input, read strictly')
{
  const part = await run(world('base', { quotes: { 1: REVERT, 10: 24900000n, 50: 25900000n }, pools: { 1: POOL2, 10: POOL, 50: POOL2 }, partial: { 50: true } }))
  check('a pool whose quote stopped at the price limit (input left over) is skipped, though it gave more', part.body.quote.result === 'ok' && part.body.quote.route.tick_spacing === 10 && part.body.quote.tokens_out_base_units === '24900000', JSON.stringify(part.body.quote.route))
  const allPart = await run(world('base', { partial: { 10: true } }))
  check('...and when every pool stopped short, there is no route for this size', allPart.body.quote.result === 'no_route')
  const sellPart = await run(world('base', { partial: { sell: true } }))
  check('...the sell-back is held to the same rule', sellPart.body.quote.result === 'ok' && sellPart.body.sell_back.result === 'no_route')
  const shortQ = await run(world('base', { quotes: { 1: REVERT, 10: 'short', 50: REVERT } }))
  check('a successful answer that is not the Quoter\'s four words is unreadable, not "no route": quote_empty', shortQ.body.quote.result === 'unknown' && shortQ.body.quote.reason === 'quote_empty')
  const fee0 = await run(world('base', { baseFee: null }))
  check('the base fee comes from the block header: none there, no gas in dollars (never a zero)', fee0.body.quote.result === 'ok' && fee0.body.quote.gas.usd === null && fee0.body.quote.gas.units === 150000)
  const fee = await run(world('base'))
  check('...with one, the gas in dollars is the pool swap\'s only, and says so', fee.body.quote.gas.usd > 0 && fee.body.quote.gas.basis === 'pool_swap_only')
}

console.log('the blocklist bit and strict words')
{
  const bl = world('base', { storageShort: true })
  bl.set(mapKey(W, 9), HIGH)
  const r = await run(bl, { wallet: W })
  check('an incomplete storage answer (0x) is no reading: unknown, never a funded override that clears the blocklist bit', r.body.simulation.result === 'unknown' && r.body.simulation.reason === 'rpc_unavailable', JSON.stringify(r.body.simulation))
  check('...and no swap was run on it', bl.swapCalls === 0)
  const lies = world('base', { storageLies: true })
  lies.set(mapKey(W, 9), HIGH)
  const lr = await run(lies, { wallet: W })
  check('a storage read the stable\'s own isBlacklisted contradicts under the override: override_unverified, never would_succeed', lr.body.simulation.result === 'unknown' && lr.body.simulation.reason === 'override_unverified', JSON.stringify(lr.body.simulation))
  const rcv = world('base')
  rcv.set(mapKey(POOL, 9), HIGH)
  const rr = await run(rcv, { wallet: W })
  check('the stable probe pays where the router pays (the pool): a listed pool is stable_blocklist', rr.body.simulation.result === 'would_revert' && rr.body.simulation.revert.kind === 'stable_blocklist', JSON.stringify(rr.body.simulation))
}

console.log('a held record by any name, and the pause from the snapshot')
{
  const NEWH = '0x' + '4e'.repeat(20)
  const heldData = (held, matches = [], match = 'none') => ({ ...siteData(), find: () => ({ match, matches, held }), verify: (c, a) => (a === NEWH ? { status: 'unavailable', body: { error: 'no verdict: the issuer list names this address, but the chain does not back it', reason: 'awaiting_factory_confirmation', chain: c, address: a } } : siteData().verify(c, a)) })
  const wd = world('base')
  const r = await run(wd, { token: 'NEW' }, { data: heldData([{ chain: 'base', symbol: 'NEWc', address: NEWH, reason: 'awaiting_factory_confirmation', match_quality: 'exact' }]) })
  check('a held record reached by an alias (a bare ticker, an ISIN) gets the 503 with its reason, and no outside call', r.status === 503 && r.body.reason === 'awaiting_factory_confirmation' && outside(wd) === 0)
  const col = await run(world('base'), { token: 'NEW' }, { data: heldData([{ chain: 'base', symbol: 'NEWc', address: NEWH, reason: 'awaiting_factory_confirmation', match_quality: 'exact' }], [{ chain: 'base', symbol: 'NEWX', address: T, match_quality: 'exact' }], 'exact') })
  check('...one that collides with a trusted exact match is ticker_ambiguous, never the trusted one quoted', col.status === 200 && col.body.verdict.reason === 'ticker_ambiguous' && col.body.verdict.candidates.length === 2)
  const pd = siteData()
  const paused = await run(world('base'), {}, { data: { ...pd, passport: async (c, a, s) => ({ ...(await pd.passport(c, a, s)), current: { paused: ['transfers'] } }) } })
  check('a token paused in the issuer\'s snapshot now is refused, whatever the last reading said', paused.body.verdict.reason === 'paused')
}

console.log('one deadline for the whole answer')
{
  const hang = world('robinhood', { onAggregator: (q) => (q.path.endsWith('/routes') && new URLSearchParams(q.query).get('tokenIn') === T ? new Promise(() => {}) : null) })
  const sim = createSimulator({ data: siteData({ chain: 'robinhood' }), fetchImpl: hang.fetchImpl, env: {}, now: Date.now, log: () => {}, budgetMs: 300 })
  const t = Date.now()
  const r = await sim.run(inputOf({ chain: 'robinhood' }), { client: 'd1' })
  check('a sell-back that never answers: the answer comes within the deadline, the buy quote kept, the sell-back timed_out', r.status === 200 && r.body.quote.result === 'ok' && r.body.sell_back.result === 'unknown' && r.body.sell_back.reason === 'timed_out' && Date.now() - t < 2000)
}

console.log('would_succeed rests on what the call moved (eth_simulateV1 logs)')
{
  const ok = await run(world('base'), { wallet: W })
  check('would_succeed carries the stable debit and the token credit read from the call\'s own logs', ok.body.simulation.result === 'would_succeed' && ok.body.simulation.transfers.stable_debit_base_units === '25000000' && BigInt(ok.body.simulation.transfers.token_credit_base_units) > 0n, JSON.stringify(ok.body.simulation))
  for (const [chain, what, o, reason] of [
    ['base', 'a swap that spent less than asked (a partial fill), though the router returned enough', { debit: 20000000n }, 'transfer_mismatch'],
    ['robinhood', 'a swap that spent less than asked (a partial fill), though the router returned enough', { debit: 20000000n }, 'transfer_mismatch'],
    ['base', 'a swap whose token went to someone else', { creditTo: OTHER }, 'transfer_mismatch'],
    ['base', 'a node without eth_simulateV1', { simulateV1Missing: true }, 'debit_unverified'],
    ['base', 'a swap that took the full amount and refunded part of it to the wallet (net spend short)', { refund: 5000000n }, 'transfer_mismatch'],
    ['robinhood', 'a swap that paid the minimum and took a fee of the token back from the wallet', { feeTaken: 2000000n }, 'transfer_mismatch'],
    ['robinhood', 'a swap that fails inside the simulated block', { simSwapFails: true }, 'debit_unverified'],
    ['base', 'a swap whose status in the simulated block is a failure, whatever it returned', { simStatusFails: true }, 'debit_unverified'],
    ['robinhood', "a swap whose own return in the simulated block is below the minimum, the balances aside", { simReturnLow: true }, 'debit_unverified'],
  ]) {
    const r = await run(world(chain, o), { chain, wallet: W })
    check(`${chain}: ${what}: ${reason}, never would_succeed`, r.body.simulation.result === 'unknown' && r.body.simulation.reason === reason, JSON.stringify(r.body.simulation))
  }
  const logsGone = await run(world('robinhood', { noLogs: true }), { chain: 'robinhood', wallet: W })
  check('logs are not read: the verdict comes from the balances, in the read block\'s own child', logsGone.body.simulation.result === 'would_succeed' && logsGone.body.simulation.simulated_block.child_of_read_block === true && logsGone.body.simulation.simulated_block.number === logsGone.body.simulation.head_block + 1)
  const drift = await run(world('base', { otherParent: true }), { wallet: W })
  check('a block of another parent than the read block is no evidence: debit_unverified', drift.body.simulation.result === 'unknown' && drift.body.simulation.reason === 'debit_unverified' && drift.body.simulation.simulated_block.child_of_read_block === false)
  const reorg = await run(world('base', { reorg: true }), { wallet: W })
  check('a reorg (the simulated block\'s parent is another block of the read height) is no evidence: debit_unverified', reorg.body.simulation.result === 'unknown' && reorg.body.simulation.reason === 'debit_unverified' && reorg.body.simulation.simulated_block.child_of_read_block === false, JSON.stringify(reorg.body.simulation))
  const pinW = world('base')
  await run(pinW, { wallet: W })
  const tags = pinW.requests.filter((q) => q.kind === 'rpc' && ['eth_call', 'eth_estimateGas', 'eth_simulateV1', 'eth_getBalance', 'eth_getStorageAt'].includes(q.method) && String(q.params?.[0]?.to).toLowerCase() !== '0xca11bde05977b3631167028862be2a173976ca11' && q.params?.[0]?.data !== '0x313ce567').map((q) => q.params[q.params.length - (q.method === 'eth_call' || q.method === 'eth_estimateGas' ? (q.params.length === 3 ? 2 : 1) : 1)])
  check('every read of the dry run is pinned by the block\'s hash (EIP-1898), never its height', tags.length > 5 && tags.every((t) => t && typeof t === 'object' && /^0x[0-9a-f]{64}$/.test(t.blockHash)), JSON.stringify(tags.slice(0, 3)))
  // The reviewer's controlled case: a full fill on an older parent's state, a partial one on the read block's own.
  const parent = await run(world('base', { partialAtHead: true }), { wallet: W })
  check('a partial fill on the read block\'s own post-state is not would_succeed, whatever an older parent would have done', parent.body.simulation.result === 'unknown' && parent.body.simulation.reason === 'transfer_mismatch', JSON.stringify(parent.body.simulation))
  const late = await run(world('robinhood', { simTimestamp: 99999999999n }), { chain: 'robinhood', wallet: W })
  check('a swap whose deadline the simulated block\'s time has reached is deadline_passed, never would_succeed', late.body.simulation.result === 'unknown' && late.body.simulation.reason === 'deadline_passed', JSON.stringify(late.body.simulation))
  const refundW = await run(world('base', { refund: 30000000n }), { wallet: W })
  check('a net gain of the stable is a signed delta in the answer', refundW.body.simulation.reason === 'transfer_mismatch' && refundW.body.simulation.transfers.stable_debit_base_units === '-5000000', JSON.stringify(refundW.body.simulation.transfers))
  const phrase = await run(world('base', { refuses: new Set([W]), revertText: 'pool: minimum out not met downstream' }), { wallet: W })
  check('a revert that only mentions a minimum is not min_out: only the pinned routers\' exact errors are', phrase.body.simulation.revert?.kind !== 'min_out', JSON.stringify(phrase.body.simulation))
  const crossed = await run(world('robinhood', { revertText: 'Too little received' }), { chain: 'robinhood', wallet: W })
  check('each router\'s own minimum-out string only: Slipstream\'s text behind KyberSwap\'s router is not min_out', crossed.body.simulation.revert?.kind !== 'min_out', JSON.stringify(crossed.body.simulation))
  const mo = await run(world('base', { amountOut: 24000000n, quotes: { 10: 24900000n }, refuses: new Set([W]), minOutFirst: true }), { wallet: W })
  check('a revert the router explains by its own minimum-out reason is min_out, whatever a probe would say', mo.body.simulation.result === 'would_revert' && mo.body.simulation.revert.kind === 'min_out', JSON.stringify(mo.body.simulation))
  const two = await run(world('base', { blacklistWord: 2n }), { wallet: W })
  check('a boolean answer that is not 0 or 1 is no answer: unknown', two.body.simulation.result === 'unknown' && two.body.simulation.reason === 'rpc_unavailable')
  const nc = await run(world('base', { balanceHex: '0x00' }), { wallet: W })
  check('a quantity that is not canonical (0x00) is no answer: unknown', nc.body.simulation.result === 'unknown' && nc.body.simulation.reason === 'rpc_unavailable')
}

console.log('KyberSwap builds, the rest of the shape')
{
  const flag = await run(world('robinhood', { buildPatch: { flags: 1 } }), { chain: 'robinhood', wallet: W })
  check('a build with the partial-fill flag is build_mismatch', flag.body.simulation.reason === 'build_mismatch')
  const less = await run(world('robinhood', { buildPatch: { srcAmounts: ['1'] } }), { chain: 'robinhood', wallet: W })
  check('the description\'s source amounts are not the measure: such a build is run, and the balance change decides', less.body.simulation.result === 'would_succeed', JSON.stringify(less.body.simulation))
  const noExec = await run(world('robinhood', { buildPatch: { executor: '' } }), { chain: 'robinhood', wallet: W })
  check('a swap build with no executor data (the real router refuses it) is build_unverified', noExec.body.simulation.reason === 'build_unverified')
  const zero = await run(world('robinhood', { buildPatch: { dstReceiver: '0x' + '0'.repeat(40) } }), { chain: 'robinhood', wallet: W })
  check('a build that pays msg.sender (dstReceiver zero) is the wallet\'s, since the dry run calls from it', zero.body.simulation.result === 'would_succeed', JSON.stringify(zero.body.simulation))
  const gap = await run(world('robinhood', { kyber: ({ rs, sell }) => ({ status: 200, body: { code: 0, data: { routeSummary: sell ? rs : { ...rs, route: [[{ ...rs.route[0][0], tokenOut: undefined }, { ...rs.route[0][0], tokenIn: undefined }]] } } } }) }))
  check('two adjacent hops with no intermediate address are quote_mismatch', gap.body.quote.reason === 'quote_mismatch')
  const r429 = await run(world('robinhood', { kyber: () => ({ status: 429, body: { code: 4008, message: 'no route to host' } }) }))
  check('a 429 is busy, whatever its body says', r429.status === 503 && r429.busy === true)
  const host = await run(world('robinhood', { kyber: () => ({ status: 400, body: { message: 'no route to host' } }) }))
  check('a 4xx saying "no route" without the documented code is no fact: aggregator_unavailable', host.body.quote.result === 'unknown' && host.body.quote.reason === 'aggregator_unavailable')
  const neg = await run(world('robinhood', { kyber: ({ rs }) => ({ status: 200, body: { code: 0, data: { routeSummary: { ...rs, gasUsd: -1 } } } }) }))
  check('a negative gasUsd is null, never a negative cost', neg.body.quote.gas.usd === null)
  const pool = await run(world('base', { pools: { 1: POOL2, 10: 'fail', 50: POOL2 } }))
  check('a failed getPool read is unreadable: unknown, never no_route', pool.body.quote.result === 'unknown' && pool.body.quote.reason === 'quote_empty', JSON.stringify(pool.body.quote))
}

console.log('nothing starts after the answer')
{
  let release
  const gateP = new Promise((r) => { release = r })
  const slowBuild = world('robinhood', { onAggregator: (q) => (q.path.endsWith('/route/build') ? gateP : null) })
  const sim = createSimulator({ data: siteData({ chain: 'robinhood' }), fetchImpl: slowBuild.fetchImpl, env: {}, now: Date.now, log: () => {}, budgetMs: 300 })
  const r = await sim.run(inputOf({ chain: 'robinhood', wallet: W }), { client: 'late' })
  const at = slowBuild.requests.length
  release()
  await new Promise((res) => setTimeout(res, 100))
  check('a build released after the deadline starts no wallet read: no request after the answer', r.body.simulation.reason === 'timed_out' && slowBuild.requests.length === at, JSON.stringify([r.body.simulation.reason, at, slowBuild.requests.slice(at).map((q) => q.method || q.path)]))
  // The dry run itself checks its deadline before each call, whatever fetch it is handed.
  const direct = world('base')
  const late = await simulateSwap({ fetchImpl: direct.fetchImpl, chain: 'base', url: 'https://rpc.invalid', wallet: W, token: T, amountIn: 25000000n, minOut: 1n, build: { ok: true, to: D.router, data: '0x' }, routers: [D.router], probePool: POOL, decodeOut: () => 1n, now: Date.now, deadlineAt: Date.now() - 1 })
  check('the dry run past its deadline asks the node nothing: timed_out, zero requests', late.result === 'unknown' && late.reason === 'timed_out' && direct.requests.length === 0, JSON.stringify([late.reason, direct.requests.length]))
  const old = world('robinhood')
  const sim2 = createSimulator({ data: siteData({ chain: 'robinhood' }), fetchImpl: old.fetchImpl, env: {}, now: Date.now, log: () => {}, budgetMs: 300 })
  const r2 = await sim2.run(inputOf({ chain: 'robinhood' }), { client: 'x', startedAt: Date.now() - 1000 })
  check('the deadline runs from the request\'s arrival: one already past makes no outside call at all', r2.status === 200 && r2.body.quote.result === 'unknown' && old.requests.length === 0, JSON.stringify(r2.body.quote))
  let refused = null
  try { createSimulator({ data: siteData(), fetchImpl: old.fetchImpl, env: {}, aggregatorPerS: 3 }) } catch (e) { refused = e }
  check('a cap below 4 is refused at start, so the quarter share always holds', refused && /at least 4/.test(refused.message) && createSimulator({ data: siteData(), fetchImpl: old.fetchImpl, env: {}, aggregatorPerS: 4 }).cap.perClient === 1)
  const bad = []
  for (const v of ['0', '4.5', 'eight', '-8']) { try { createSimulator({ data: siteData(), fetchImpl: old.fetchImpl, env: { STP_AGGREGATOR_PER_S: v } }) } catch (e) { bad.push(v) } }
  check('STP_AGGREGATOR_PER_S of 0, a fraction or a word is refused at start, never read as the default', bad.length === 4 && createSimulator({ data: siteData(), fetchImpl: old.fetchImpl, env: { STP_AGGREGATOR_PER_S: '' } }).cap.perS === 12, JSON.stringify(bad))
}

console.log('the cache and the cap')
{
  clock = NOW0
  const wd = world('robinhood')
  const sim = createSimulator({ data: siteData({ chain: 'robinhood' }), fetchImpl: wd.fetchImpl, env: {}, now, log: () => {} })
  const a = await run(wd, { chain: 'robinhood' }, { sim })
  clock += 5000
  const b = await run(wd, { chain: 'robinhood' }, { sim })
  const n1 = wd.requests.filter((q) => q.kind === 'aggregator').length
  check('the same question within QUOTE_TTL_S is answered from the cache, with cached: true and its age', a.body.quote.cached === false && b.body.quote.cached === true && b.body.quote.age_s === 5 && b.body.quote.valid_for_s === QUOTE_TTL_S - 5 && n1 === 2)
  clock += QUOTE_TTL_S * 1000
  const c = await run(wd, { chain: 'robinhood' }, { sim })
  check('...and asked again after it', c.body.quote.cached === false && wd.requests.filter((q) => q.kind === 'aggregator').length === 4)
  clock += 1000
  const ws = world('base')
  const simB = createSimulator({ data: siteData(), fetchImpl: ws.fetchImpl, env: {}, now, log: () => {} })
  await run(ws, { wallet: W }, { sim: simB }); await run(ws, { wallet: W }, { sim: simB })
  const swaps = ws.requests.filter((q) => q.method === 'eth_call' && q.params[0].to === D.router).length
  check('a simulation is never cached: two asks, two dry runs', swaps === 2, String(swaps))

  // A cap of 4 a second: each client may send 1 of them. Five clients in one second: four buy quotes go out, each
  // client's sell-back is refused by its share, and the fifth buy is refused by the cap.
  clock = NOW0 + 3_600_000
  const capW = world('robinhood')
  const capSim = createSimulator({ data: siteData({ chain: 'robinhood' }), fetchImpl: capW.fetchImpl, env: {}, now, log: () => {}, aggregatorPerS: 4 })
  check('the per-client share is a quarter of the cap, never more', capSim.cap.perClient === 1 && createSimulator({ data: siteData(), fetchImpl: capW.fetchImpl, env: {}, aggregatorPerS: 8 }).cap.perClient === 2 && createSimulator({ data: siteData(), fetchImpl: capW.fetchImpl, env: {} }).cap.perClient === 3)
  const rs = []
  for (let i = 1; i <= 5; i++) rs.push(await run(capW, { chain: 'robinhood', usd: 10 + i }, { sim: capSim, client: 'k' + i }))
  check('the global aggregator cap refuses with "busy" and Retry-After, never a 402', rs.slice(0, 4).every((r) => r.status === 200 && r.body.sell_back.reason === 'aggregator_busy') && rs[4].status === 503 && rs[4].busy === true && rs[4].body.error === BUSY && rs[4].headers['retry-after'] && capW.requests.filter((q) => q.kind === 'aggregator').length === 4, JSON.stringify(rs.map((r) => [r.status, r.body.sell_back?.reason])))
  const again = await run(capW, { chain: 'robinhood', usd: 11 }, { sim: capSim, client: 'k1' })
  check('...a cached quote takes no permit: the same question again in the same second is answered from the cache', again.status === 200 && again.body.quote.cached === true && capW.requests.filter((q) => q.kind === 'aggregator').length === 4)
  clock += 1000
  const r4 = await run(capW, { chain: 'robinhood', usd: 14 }, { sim: capSim, client: 'k5' })
  check('...and the next second answers again', r4.status === 200)

  // Permits are taken when a call goes out, in the second it goes out: responses that take most of a second each push
  // the sell-backs and builds into later seconds, and no second ever sends more than the cap, or more than one client's
  // share for any client.
  clock = NOW0 + 5_400_000
  const sent = []
  const owner = new Map()
  const slow = world('robinhood', {
    kyberOut: (amt, sell) => (sell ? amt / 10n : amt * 10n),
    onAggregator: async (q) => {
      const amt = q.path.endsWith('/routes') ? BigInt(new URLSearchParams(q.query).get('amountIn')) : BigInt(JSON.parse(q.body).routeSummary.amountIn)
      const who = owner.get(amt) || owner.get(amt / 10n) || 'unknown'
      sent.push({ sec: Math.floor(clock / 1000), who })
      await new Promise((r) => setTimeout(r, 1))
      clock += 700
    },
  })
  const slowSim = createSimulator({ data: siteData({ chain: 'robinhood' }), fetchImpl: slow.fetchImpl, env: {}, now, log: () => {}, aggregatorPerS: 4 })
  const clients = ['a', 'b', 'c', 'd', 'e', 'f']
  clients.forEach((c, i) => owner.set(BigInt((30 + i) * 1e6), c))
  const answers = await Promise.all(clients.map((c, i) => run(slow, { chain: 'robinhood', usd: 30 + i, wallet: W }, { sim: slowSim, client: c })))
  const perSec = new Map(), perClientSec = new Map()
  for (const x of sent) { perSec.set(x.sec, (perSec.get(x.sec) || 0) + 1); perClientSec.set(x.sec + x.who, (perClientSec.get(x.sec + x.who) || 0) + 1) }
  check('counted by dispatch time across second boundaries: no second sends more than the cap, no client more than its share', sent.length > 4 && [...perSec.values()].every((n) => n <= 4) && [...perClientSec.values()].every((n) => n <= 1) && !sent.some((x) => x.who === 'unknown') && answers.every((r) => r.status === 200 || r.busy), JSON.stringify([...perSec]))

  clock = NOW0 + 7_200_000
  const fair = world('robinhood')
  const fairSim = createSimulator({ data: siteData({ chain: 'robinhood' }), fetchImpl: fair.fetchImpl, env: {}, now, log: () => {}, aggregatorPerS: 8 })
  const greedy = []
  for (let i = 0; i < 6; i++) greedy.push((await run(fair, { chain: 'robinhood', usd: 20 + i }, { sim: fairSim, client: 'greedy' })).status)
  const quiet = await run(fair, { chain: 'robinhood', usd: 99 }, { sim: fairSim, client: 'quiet' })
  check('one greedy client sending distinct amounts beside a quiet one: the quiet client is answered', quiet.status === 200 && greedy.includes(503), JSON.stringify(greedy))
}

console.log('it never sends')
{
  const files = ['./stocks-simulate.mjs', '../evm/core/stocks/simulate.mjs', './simulate/sim-evm.mjs', './simulate/quote-kyberswap.mjs', './simulate/quote-aerodrome.mjs']
  const hits = files.filter((f) => /eth_sendRawTransaction|eth_sendTransaction|signTransaction|privateKey/.test(fs.readFileSync(new URL(f, import.meta.url), 'utf8')))
  check('the module never sends: no send, no signature and no key in any of its files', hits.length === 0, hits.join(', '))
  const wd = world('base')
  await run(wd, { wallet: W })
  const methods = new Set(wd.requests.filter((q) => q.kind === 'rpc').map((q) => q.method))
  check('...and the node is asked only to read and to call', [...methods].every((m) => ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas', 'eth_simulateV1'].includes(m)), [...methods].join(' '))
  check('every chain it answers on has an issuer list (the tool\'s chain enum)', JSON.stringify(Object.keys(CHAINS_SIM).sort()) === JSON.stringify(['base', 'robinhood']))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
