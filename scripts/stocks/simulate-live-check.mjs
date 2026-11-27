#!/usr/bin/env node
// scripts/stocks/simulate-live-check.mjs: simulate_buy's adapters against the real chains and the real aggregator, by hand
// (docs/simulate-buy-tz.md §3.1, §5.2). Never part of `npm test`: it calls out. Read-only: eth_call and quotes only,
// with a wallet address that is made up and holds nothing.
//
// What it checks, and prints as pass or fail only (no number of a run is printed or kept):
//   1. Aerodrome's pinned Quoter and SwapRouter each answer factory() with their pinned factory (the pairing);
//   2. each chain's stable has the decimals the slot table assumes, and its balance and allowance slots read back an
//      override (the slot table is still right);
//   3. a $25 question with no wallet and with the empty wallet, through the orchestration, for one issuer-listed token
//      per chain taken from the issuer's own list: the quote, the sell-back, the second line, the dry run.
// The verdict is taken from the issuer's list read here, not from our server: the point is the adapters.
//
// Run: node scripts/stocks/simulate-live-check.mjs [--base <token>] [--robinhood <token>]
// Exit 0 when every check passes, 1 otherwise.

import { createSimulator } from '../../apps/stocks-simulate.mjs'
import { parseInput } from '../../evm/core/stocks/simulate.mjs'
import { SLIPSTREAM, SELECTORS } from '../../apps/simulate/quote-aerodrome.mjs'
import { STABLES, rpcCall, mapKey, allowanceKey } from '../../apps/simulate/sim-evm.mjs'
import { rpcUrlOf, args as abi } from './onchain-pools.mjs'
import { readCoinbase, readRobinhood } from '../../evm/core/stocks/registries.mjs'
import { CHAINS } from './stock-peg.mjs'

const EMPTY_WALLET = '0x7e57000000000000000000000000000000c0ffee' // made up; holds nothing
let bad = 0
const say = (ok, what) => { if (!ok) bad++; console.log(`${ok ? 'pass' : 'FAIL'}  ${what}`) }
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? String(process.argv[i + 1] || '').toLowerCase() : null }
const word = (r) => (r.ok ? BigInt('0x' + (String(r.result).replace(/^0x/, '') || '0')) : null)

const base = rpcUrlOf('base').url
for (const d of SLIPSTREAM) {
  const q = await rpcCall(fetch, base, 'eth_call', [{ to: d.quoter, data: '0x' + SELECTORS.factory }, 'latest'])
  const r = await rpcCall(fetch, base, 'eth_call', [{ to: d.router, data: '0x' + SELECTORS.factory }, 'latest'])
  say(q.ok && '0x' + String(q.result).slice(-40) === d.factory, `Aerodrome Quoter ${d.quoter} answers its pinned factory`)
  say(r.ok && '0x' + String(r.result).slice(-40) === d.factory, `Aerodrome SwapRouter ${d.router} answers its pinned factory`)
}

for (const chain of Object.keys(STABLES)) {
  const S = STABLES[chain], url = rpcUrlOf(chain).url
  const dec = word(await rpcCall(fetch, url, 'eth_call', [{ to: S.address, data: '0x313ce567' }, 'latest']))
  say(dec === BigInt(S.decimals), `${chain} ${S.symbol} has ${S.decimals} decimals`)
  const spender = '0x' + '22'.repeat(20)
  const ov = { [S.address]: { stateDiff: { [mapKey(EMPTY_WALLET, S.balanceSlot)]: '0x' + (12345n).toString(16).padStart(64, '0'), [allowanceKey(EMPTY_WALLET, spender, S.allowanceSlot)]: '0x' + (678n).toString(16).padStart(64, '0') } } }
  const b = word(await rpcCall(fetch, url, 'eth_call', [{ to: S.address, data: '0x70a08231' + abi.addr(EMPTY_WALLET) }, 'latest', ov]))
  const a = word(await rpcCall(fetch, url, 'eth_call', [{ to: S.address, data: '0xdd62ed3e' + abi.addr(EMPTY_WALLET) + abi.addr(spender) }, 'latest', ov]))
  say(b === 12345n && a === 678n, `${chain} ${S.symbol}: the balance slot ${S.balanceSlot} and the allowance slot ${S.allowanceSlot} read back an override`)
}

// One listed token per chain, from the issuer's own list (or as given).
const pick = async (chain) => {
  if (arg('--' + chain)) return arg('--' + chain)
  const recs = chain === 'base' ? await readCoinbase(fetch, { chainId: CHAINS.base.chainId }) : await readRobinhood(fetch, { chainId: CHAINS.robinhood.chainId })
  const r = recs.find((x) => (chain === 'base' ? x.supplied !== false && x.symbol === 'NVDAc' : x.symbol === 'TSLA')) || recs.find((x) => x.supplied !== false)
  return r ? { address: r.address, symbol: r.symbol } : null
}
for (const chain of ['base', 'robinhood']) {
  const t = await pick(chain)
  const token = typeof t === 'string' ? { address: t, symbol: 'the token' } : t
  if (!token) { say(false, `${chain}: no listed token to ask about`); continue }
  const data = {
    snapshot: () => ({}), find: () => ({}), listProof: () => null,
    verify: (c, address) => ({ status: 'ok', body: { listed: true, chain: c, address, symbol: token.symbol, impostor: null } }),
    passport: async () => ({ status: 200, body: { issuer: { symbol: token.symbol, minted: chain === 'base' ? true : null, paused: [] }, reference: null, latest: null, notes: [], market_now: { session: 'unknown' } } }),
  }
  const sim = createSimulator({ data, fetchImpl: fetch, log: () => {} })
  for (const wallet of [null, EMPTY_WALLET]) {
    const { input } = parseInput({ chain, token: token.address, usd: 25, ...(wallet ? { wallet } : {}) })
    const r = await sim.run(input, { client: 'live-check' })
    const b = r.body || {}
    const tag = `${chain} $25 ${wallet ? 'with the empty wallet' : 'no wallet'}`
    say(r.status === 200 && b.quote?.result === 'ok', `${tag}: ${b.quote?.source || 'the primary'} quote ${b.quote?.result || r.status}${b.quote?.reason ? ' (' + b.quote.reason + ')' : ''}`)
    say(b.sell_back?.result === 'ok', `${tag}: sell-back ${b.sell_back?.result}${b.sell_back?.reason ? ' (' + b.sell_back.reason + ')' : ''}`)
    if (chain === 'base' && !wallet) say(typeof b.quote?.gas?.usd === 'number' && b.quote.gas.basis === 'pool_swap_only', `${tag}: gas priced from the block header's base fee (${b.quote?.gas?.basis})`)
    if (chain === 'base') say(b.venues?.kyberswap?.result === 'ok', `${tag}: KyberSwap second line ${b.venues?.kyberswap?.result}${b.venues?.kyberswap?.reason ? ' (' + b.venues.kyberswap.reason + ')' : ''}`)
    if (wallet) say(b.simulation?.result === 'would_succeed' && b.simulation.transfers?.stable_debit_base_units === String(input.usd * 1e6), `${tag}: dry run, its net balance change read in one eth_simulateV1 block (debit exact, credit and the swap's own return at least the minimum; the read block's own child: ${b.simulation?.simulated_block?.child_of_read_block}): ${b.simulation?.result}${b.simulation?.reason ? ' (' + b.simulation.reason + ')' : ''}, overriding ${(b.simulation?.simulated_with || []).join(', ') || 'nothing'}`)
  }
}
console.log(bad ? `\n${bad} failed` : '\nall passed')
process.exit(bad ? 1 : 0)
