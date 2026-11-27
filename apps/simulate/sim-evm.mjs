// apps/simulate/sim-evm.mjs: the EVM dry run of simulate_buy (docs/simulate-buy-tz.md §5.2): the exact swap a wallet would
// sign, run by eth_call and eth_estimateGas at one pinned block, with only the wallet's missing funding put in place by
// a state override.
//
// ⚠ IT NEVER SIGNS AND NEVER SENDS. eth_blockNumber, eth_getBalance, eth_getStorageAt, eth_call, eth_estimateGas and
//   eth_simulateV1 (the same call, for its logs) are the only methods here; there is no key in the code path and the tests read this file for anything that sends.
// ⚠ THE STOCK TOKEN RUNS AS IT IS. Its contract and storage are never in the override: its transfer rules (allowlists,
//   blocklists, pauses, restricted-securities gates) are exactly what the dry run is for.
// ⚠ ONLY WHAT IS MISSING IS OVERRIDDEN, AND EVERY OVERRIDE IS READ BACK. The stable's balance and allowance slots are
//   pinned per stable below; before the swap the same override is applied to a balanceOf and an allowance call, and a
//   slot that does not read back what we set is `override_unverified` (the stable was upgraded), never a guess. USDC
//   packs its blocklist flag into the high bit of the balance word, so the override keeps that bit: writing the whole
//   word would clear the flag and hide a real "blacklisted" revert.
// ⚠ A WRAPPED REVERT IS NEVER CLASSIFIED FROM ITS OWN TEXT. The routers pull the stable through a transfer helper and
//   call pools through an executor, and both replace the inner revert with their own ("STF", TRANSFER_FROM_FAILED, a
//   generic swap failure). A revert is followed by probe calls under the same override at the same block: the stable's
//   transferFrom from the router, then one unit of the token sent to the wallet from the pool that holds it.

import { keccak256 } from '../../evm/core/stocks/evm-tx.mjs'
import { args as abi } from '../../scripts/stocks/onchain-pools.mjs'

const sel = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4).toString('hex')
const SEL = Object.freeze({ balanceOf: sel('balanceOf(address)'), allowance: sel('allowance(address,address)'), transferFrom: sel('transferFrom(address,address,uint256)'), transfer: sel('transfer(address,uint256)'), isBlacklisted: sel('isBlacklisted(address)') })

/**
 * The stable each chain's dry run funds, with its storage layout. Found 25.11.2026 by probing each contract's storage
 * and checked on every call by the read-back: Base USDC (FiatToken v2.2) keeps balances at slot 9, with the blocklist
 * flag in the high bit of the same word, and allowances at slot 10; Robinhood Chain USDG keeps balances at slot 1 and
 * allowances at slot 3.
 */
export const STABLES = Object.freeze({
  base: Object.freeze({ symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, balanceSlot: 9, allowanceSlot: 10, blocklistHighBit: true, isBlacklisted: true }),
  robinhood: Object.freeze({ symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, balanceSlot: 1, allowanceSlot: 3, blocklistHighBit: false, isBlacklisted: false }),
})
/** Gas money a wallet below it is given in the dry run, and the line under which we say it lacks gas: 0.001 ETH, a
 * constant we choose, ample for one swap on either chain's fees. */
export const GAS_MONEY_WEI = 10n ** 15n
export const RPC_TIMEOUT_MS = 5_000
/** The whole dry run's budget: past it, the rest is `rpc_unavailable` rather than a request that outlives its caller. */
export const SIM_BUDGET_MS = 14_000
const HIGH_BIT = 1n << 255n
const LOW_BITS = HIGH_BIT - 1n
/**
 * The pinned routers' own minimum-out errors, exactly as their sources write them, each for its own router only:
 * Slipstream's SwapRouter (`require(amountOut >= params.amountOutMinimum, "Too little received")`) and KyberSwap's
 * MetaAggregationRouterV2 (`require(returnAmount >= desc.minReturnAmount, "Return amount is not enough")`). The caller
 * hands in the one of the router it runs; nothing else is a minimum-out revert.
 */
export const MIN_OUT_SLIPSTREAM = 'Too little received'
export const MIN_OUT_KYBER = 'Return amount is not enough'
const BLOCKLIST_RE = /blacklist|blocklist|blocked|frozen/i

const strip = (h) => String(h || '').replace(/^0x/, '')
const hex32 = (n) => '0x' + BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
const qty = (n) => '0x' + BigInt(n).toString(16)
const word = (h, i = 0) => BigInt('0x' + (strip(h).slice(i * 64, i * 64 + 64) || '0'))
/** Exactly one 32-byte word, or null: `0x`, a short or a long answer is no reading. */
export const w32 = (h) => (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) ? BigInt(h) : null)
/** A JSON-RPC quantity, or null. */
export const qtyOf = (h) => (typeof h === 'string' && /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(h) ? BigInt(h) : null)
/** A boolean word: exactly 0 or 1, anything else is no answer. */
export const bool01 = (h) => { const x = w32(h); return x === 0n || x === 1n ? x : null }
// The build's own reasons, carried into the dry run's answer as they are.
const BUILD_REASONS = new Set(['no_quote', 'build_failed', 'build_unverified', 'build_mismatch', 'aggregator_busy', 'timed_out'])
const STATE_KEYS = new Set(['balance', 'stateDiff'])
const low = (s) => String(s || '').toLowerCase()

/** The storage key of mapping(address => uint) at `slot` for `addr`. */
export function mapKey (addr, slot) {
  return '0x' + keccak256(Buffer.from(abi.addr(addr) + abi.uint(slot), 'hex')).toString('hex')
}
/** The storage key of mapping(address => mapping(address => uint)) at `slot` for (owner, spender). */
export function allowanceKey (owner, spender, slot) {
  return '0x' + keccak256(Buffer.from(abi.addr(spender) + strip(mapKey(owner, slot)), 'hex')).toString('hex')
}

/** A revert's data in words we can show: Error(string), Panic(uint), or a custom error's selector. All of it is data. */
export function decodeRevert (data) {
  const h = strip(data).toLowerCase()
  const out = { reason: null, selector: h.length >= 8 ? '0x' + h.slice(0, 8) : null, data: h ? '0x' + h.slice(0, 512) : null }
  try {
    if (h.startsWith('08c379a0') && h.length >= 8 + 128) {
      const len = Number(word(h.slice(8), 1))
      if (len <= 4096) out.reason = Buffer.from(h.slice(8 + 128, 8 + 128 + len * 2), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '?').slice(0, 200)
    } else if (h.startsWith('4e487b71') && h.length >= 8 + 64) out.reason = `Panic(0x${word(h.slice(8), 0).toString(16)})`
  } catch (_) { /* undecodable stays data */ }
  return out
}

/** One JSON-RPC call, never batched: { ok, result } or { ok: false, kind: down|block|gas_cap|revert|rpc, data }. */
export async function rpcCall (fetchImpl, url, method, params) {
  let j
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    if (!r.ok) return { ok: false, kind: 'down' }
    j = await r.json()
  } catch (_) { return { ok: false, kind: 'down' } }
  if (j && !j.error && j.result !== undefined && j.result !== null) return { ok: true, result: j.result }
  const m = String(j?.error?.message || '')
  const data = typeof j?.error?.data === 'string' ? j.error.data : (j?.error?.data && typeof j.error.data.data === 'string' ? j.error.data.data : null)
  if (/header not found|missing trie node|unknown block|block not found|historical state/i.test(m)) return { ok: false, kind: 'block', message: m }
  if (/gas required exceeds|exceeds block gas limit|gas cap|out of gas|intrinsic gas/i.test(m)) return { ok: false, kind: 'gas_cap', message: m }
  if (j?.error?.code === 3 || /revert/i.test(m)) return { ok: false, kind: 'revert', data, message: m }
  return { ok: false, kind: 'rpc', message: m }
}

const unknown = (reason, extra = {}) => ({ result: 'unknown', reason, revert: null, amount_out_simulated_base_units: null, gas_units: null, ...extra })
const callErr = (e) => (e.kind === 'late' ? 'timed_out' : e.kind === 'block' ? 'block_unavailable' : e.kind === 'gas_cap' ? 'rpc_gas_cap' : 'rpc_unavailable')

/**
 * The dry run. Returns the `simulation` block of the answer (§8.1).
 * @param {string} o.chain          base | robinhood (its STABLES entry)
 * @param {string} o.url            the chain's RPC; `rpcLabel` says public or custom
 * @param {string} o.wallet         the caller's public address
 * @param {string} o.token          the checked stock token: never overridden
 * @param {bigint} o.amountIn       the stable's base units
 * @param {bigint} o.minOut         the least the swap may deliver
 * @param {object} o.build          { ok, to, data, payTo } the swap to run, or { ok: false, reason }
 * @param {string[]} o.routers      the routers the swap may go to: anything else is not run
 * @param {string|null} o.probePool the pool that holds the token, for the token probe
 * @param {(hex: string) => bigint|null} o.decodeOut  the router's return, decoded to the amount out
 * @param {number} [o.deadlineAt]   the answer's own deadline: past it, the rest is `timed_out`
 */
export async function simulateSwap ({ fetchImpl, chain, url, rpcLabel = 'public', wallet, token, amountIn, minOut, build, routers, probePool, decodeOut, minOutReason = null, now = Date.now, deadlineAt = Infinity }) {
  const S = STABLES[chain]
  const started = now()
  const head0 = { wallet: low(wallet), head_block: null, rpc: rpcLabel, wallet_state: { stable_balance_enough: null, allowance_enough: null, gas_balance_enough: null }, simulated_with: [] }
  if (!build || !build.ok) return { ...head0, ...unknown(BUILD_REASONS.has(build?.reason) ? build.reason : 'build_failed') }
  // Swaps go to the pinned router only: the aggregator chooses the route, never where the money goes.
  if (!routers.map(low).includes(low(build.to))) return { ...head0, ...unknown('router_not_allowed') }
  const router = low(build.to), stable = S.address
  // Where the router sends the stable: the pool on Base, the route's first receiver on KyberSwap. The stable probe pays
  // the same address, so a blocklist on the receiving side is seen too.
  const payTo = /^0x[0-9a-f]{40}$/.test(low(build.payTo)) ? low(build.payTo) : router
  const over = () => now() - started > SIM_BUDGET_MS || now() >= deadlineAt
  const late = () => 'timed_out'
  // Every outside call is checked against the deadline as it starts: past it, nothing more is asked of the node.
  const rc = (method, params) => (over() ? Promise.resolve({ ok: false, kind: 'late' }) : rpcCall(fetchImpl, url, method, params))
  const call = (to, data, from, block, override) => rc('eth_call', [{ from, to, data, value: '0x0' }, block, ...(override ? [override] : [])])

  // 1. One pinned block for every read; a non-archive node that lost it is asked once more at a fresh head. Every
  //    answer must be exactly what the method returns: a word of 32 bytes, a quantity. Anything else is no reading.
  //    The block is pinned by its HASH (EIP-1898), not its height: a reorg at that height cannot slip another block in
  //    under the same number. Both public RPCs take a block hash for every method used here (checked 27.11).
  let head = null, headHash = null, tag = null, reads = null
  for (let attempt = 0; attempt < 2 && !reads; attempt++) {
    const b = await rc('eth_blockNumber', [])
    if (!b.ok) return { ...head0, ...unknown(callErr(b)) }
    if (qtyOf(b.result) == null) return { ...head0, ...unknown('rpc_unavailable') }
    head = Number(qtyOf(b.result))
    const hb = await rc('eth_getBlockByNumber', [qty(head), false])
    if (!hb.ok && hb.kind === 'block' && attempt === 0) continue
    if (!hb.ok) return { ...head0, head_block: head, ...unknown(callErr(hb)) }
    headHash = hb.result && qtyOf(hb.result.number) === BigInt(head) && /^0x[0-9a-fA-F]{64}$/.test(String(hb.result.hash)) ? low(hb.result.hash) : null
    if (!headHash) return { ...head0, head_block: head, ...unknown('rpc_unavailable') }
    tag = { blockHash: headHash }
    const rs = await Promise.all([
      call(stable, '0x' + SEL.balanceOf + abi.addr(wallet), wallet, tag),
      call(stable, '0x' + SEL.allowance + abi.addr(wallet) + abi.addr(router), wallet, tag),
      rc('eth_getBalance', [wallet, tag]),
      S.blocklistHighBit ? rc('eth_getStorageAt', [stable, mapKey(wallet, S.balanceSlot), tag]) : Promise.resolve({ ok: true, result: '0x' + '0'.repeat(64) }),
      S.isBlacklisted ? call(stable, '0x' + SEL.isBlacklisted + abi.addr(wallet), wallet, tag) : Promise.resolve({ ok: true, result: '0x' + '0'.repeat(64) }),
    ])
    const bad = rs.find((r) => !r.ok)
    if (bad && bad.kind === 'block' && attempt === 0) continue
    if (bad) return { ...head0, head_block: head, ...unknown(callErr(bad)) }
    reads = rs
  }
  if (!reads) return { ...head0, head_block: head, ...unknown('block_unavailable') }
  const [balR, allowR, ethR, slotR, listR] = reads
  const bal = w32(balR.result), allowance = w32(allowR.result), eth = qtyOf(ethR.result), slotWord = w32(slotR.result), listed0 = bool01(listR.result)
  // An incomplete answer (`0x` for a storage slot, say) is not a zero: it would clear the blocklist bit below.
  if (bal == null || allowance == null || eth == null || slotWord == null || listed0 == null) return { ...head0, head_block: head, ...unknown('rpc_unavailable') }
  const state = { stable_balance_enough: bal >= amountIn, allowance_enough: allowance >= amountIn, gas_balance_enough: eth >= GAS_MONEY_WEI }

  // 2. The override: only what is missing, the blocklist bit kept, the token never touched.
  const stateDiff = {}, simulatedWith = []
  if (!state.stable_balance_enough) { stateDiff[mapKey(wallet, S.balanceSlot)] = hex32((S.blocklistHighBit ? slotWord & HIGH_BIT : 0n) | amountIn); simulatedWith.push('stable_balance') }
  if (!state.allowance_enough) { stateDiff[allowanceKey(wallet, router, S.allowanceSlot)] = hex32(amountIn); simulatedWith.push('stable_allowance') }
  const override = {}
  if (Object.keys(stateDiff).length) override[stable] = { stateDiff }
  if (!state.gas_balance_enough) { override[low(wallet)] = { balance: qty(GAS_MONEY_WEI) }; simulatedWith.push('native_balance') }
  // Whatever the caller sent (a wallet that is the token's own address, say), the token's account is never overridden.
  if (Object.hasOwn(override, low(token))) { delete override[low(token)]; for (const k of ['native_balance', 'stable_balance', 'stable_allowance']) if (low(token) === (k === 'native_balance' ? low(wallet) : stable) && simulatedWith.includes(k)) simulatedWith.splice(simulatedWith.indexOf(k), 1) }
  const ov = Object.keys(override).length ? override : null
  const head1 = { ...head0, head_block: head, wallet_state: state, simulated_with: simulatedWith }

  // 3. The override read back, under the same override at the same block: the balance and the allowance we set, and
  //    the stable's own blocklist answer unchanged by our write.
  if (simulatedWith.includes('stable_balance') || simulatedWith.includes('stable_allowance')) {
    const [b2, a2, l2] = await Promise.all([
      call(stable, '0x' + SEL.balanceOf + abi.addr(wallet), wallet, tag, ov),
      call(stable, '0x' + SEL.allowance + abi.addr(wallet) + abi.addr(router), wallet, tag, ov),
      S.isBlacklisted ? call(stable, '0x' + SEL.isBlacklisted + abi.addr(wallet), wallet, tag, ov) : Promise.resolve({ ok: true, result: listR.result }),
    ])
    if (!b2.ok || !a2.ok || !l2.ok) return { ...head1, ...unknown(callErr(!b2.ok ? b2 : !a2.ok ? a2 : l2)) }
    const wantBal = simulatedWith.includes('stable_balance') ? amountIn : bal
    const gotBal = w32(b2.result), gotAllow = w32(a2.result), listed1 = bool01(l2.result)
    if (gotBal == null || gotAllow == null || listed1 == null) return { ...head1, ...unknown('rpc_unavailable') }
    if ((gotBal & LOW_BITS) !== (wantBal & LOW_BITS) || gotAllow < amountIn) return { ...head1, ...unknown('override_unverified') }
    if (listed1 !== listed0) return { ...head1, ...unknown('override_unverified') }
  }
  if (over()) return { ...head1, ...unknown(late()) }

  // 4. The swap itself, and its gas, the same way.
  const tx = { from: low(wallet), to: router, data: build.data, value: '0x0' }
  const [sw, est] = await Promise.all([
    rc('eth_call', [tx, tag, ...(ov ? [ov] : [])]),
    rc('eth_estimateGas', [tx, tag, ...(ov ? [ov] : [])]),
  ])
  if (sw.ok) {
    const out = decodeOut(sw.result)
    if (out == null) return { ...head1, ...unknown('return_undecodable') }
    if (out < minOut) return { ...head1, ...unknown('below_min_out', { amount_out_simulated_base_units: out.toString() }) }
    // Both must agree: a call that returns while the estimate fails is not a swap that would succeed.
    if (!est.ok) return { ...head1, ...unknown(est.kind === 'gas_cap' ? 'rpc_gas_cap' : 'estimate_disagrees', { amount_out_simulated_base_units: out.toString() }) }
    if (qtyOf(est.result) == null) return { ...head1, ...unknown('return_undecodable', { amount_out_simulated_base_units: out.toString() }) }
    // The router's return and eth_call are its own word for what it did. The verdict rests on what the wallet holds:
    // one eth_simulateV1 block, under the same override, reads the wallet's stable and token balances, runs the swap
    // from the wallet, and reads both again. The stable must have fallen by exactly the amount asked and the token
    // risen by at least the minimum: net, so a refund back to the wallet or a fee taken from it counts. The block's
    // block is the read block's child: built on the read block's own post-state, the very state eth_call and
    // eth_estimateGas used, under the same override, and said as such in the answer. The swap's own return there must
    // be at least the minimum too. Logs are not read: nothing a token emits can vouch for it.
    const bal = (t) => ({ from: low(wallet), to: t, data: '0x' + SEL.balanceOf + abi.addr(wallet) })
    const stateOverrides = Object.fromEntries(Object.entries(ov || {}).map(([a, v]) => [a, Object.fromEntries(Object.entries(v).filter(([k]) => STATE_KEYS.has(k)))]))
    const ev = await rc('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides, calls: [bal(stable), bal(low(token)), tx, bal(stable), bal(low(token))] }], validation: false }, tag])
    const unverified = (reason, extra = {}) => ({ ...head1, ...unknown(reason, { amount_out_simulated_base_units: out.toString(), ...extra }) })
    if (!ev.ok && ev.kind === 'late') return unverified('timed_out')
    const blk = ev.ok && Array.isArray(ev.result) && ev.result.length === 1 ? ev.result[0] : null
    const cs = blk && Array.isArray(blk.calls) && blk.calls.length === 5 ? blk.calls : null
    const simulatedBlock = blk ? { number: qtyOf(blk.number) != null ? Number(qtyOf(blk.number)) : null, timestamp: qtyOf(blk.timestamp) != null ? Number(qtyOf(blk.timestamp)) : null, child_of_read_block: qtyOf(blk.number) === BigInt(head) + 1n && low(blk.parentHash) === headHash } : null
    // Built on the read block or not at all: its parent must be the read block's hash. A block of another parent (a
    // reorg at that height, say) is not the state the other calls saw.
    if (simulatedBlock && !simulatedBlock.child_of_read_block) return unverified('debit_unverified', { simulated_block: simulatedBlock })
    // The swap's own deadline must still hold in that block: a deadline its time has reached would revert it there.
    if (simulatedBlock && Number.isFinite(build.deadline) && !(simulatedBlock.timestamp < build.deadline)) return unverified('deadline_passed', { simulated_block: simulatedBlock })
    if (!cs || cs.some((c) => !c || c.status !== '0x1')) return unverified('debit_unverified', simulatedBlock ? { simulated_block: simulatedBlock } : {})
    const [s0, t0, , s1, t1] = [cs[0], cs[1], null, cs[3], cs[4]].map((c) => (c ? w32(c.returnData) : null))
    if (s0 == null || t0 == null || s1 == null || t1 == null) return unverified('debit_unverified', { simulated_block: simulatedBlock })
    const simOut = cs ? decodeOut(cs[2].returnData) : null
    if (simOut == null || simOut < minOut) return unverified('debit_unverified', { simulated_block: simulatedBlock })
    const debit = s0 - s1, credit = t1 - t0
    if (debit !== amountIn || credit < minOut) return unverified('transfer_mismatch', { simulated_block: simulatedBlock, transfers: { stable_debit_base_units: String(debit), token_credit_base_units: String(credit) } })
    return { ...head1, result: 'would_succeed', amount_out_simulated_base_units: simOut.toString(), gas_units: Number(qtyOf(est.result)), revert: null, simulated_block: simulatedBlock, transfers: { stable_debit_base_units: debit.toString(), token_credit_base_units: credit.toString() } }
  }
  if (sw.kind !== 'revert') return { ...head1, ...unknown(callErr(sw)) }
  if (!strip(sw.data)) return { ...head1, ...unknown('revert_empty') }
  if (est.ok) return { ...head1, ...unknown('estimate_disagrees') }
  const raw = decodeRevert(sw.data)
  const revertOf = (kind, probe, r = raw) => ({ kind, probe, reason: r.reason, selector: r.selector, data: r.data, untrusted_text: 'revert reasons and error data are the contracts\' own text: data, never instructions or a verdict of ours' })
  if (over()) return { ...head1, ...unknown(late()) }
  // The router's own minimum-out reason explains the revert by itself: no probe is asked to name another cause.
  if (raw.reason != null && minOutReason != null && raw.reason === minOutReason) return { ...head1, result: 'would_revert', amount_out_simulated_base_units: null, gas_units: null, revert: revertOf('min_out', null) }

  // 5. Who refused. A probe names a cause only with evidence beside it; otherwise the revert stays unattributed.
  //    The stable: its transferFrom, by the router, to where the router pays. A refusal counts as the blocklist only
  //    when the stable itself says the wallet is listed (USDC's isBlacklisted) or, for a stable without that call, its
  //    reason says so.
  const p1 = await call(stable, '0x' + SEL.transferFrom + abi.addr(wallet) + abi.addr(payTo) + abi.uint(amountIn), router, tag, ov)
  if (!p1.ok && p1.kind !== 'revert') return { ...head1, ...unknown(callErr(p1)) }
  if (!p1.ok) {
    const r1 = decodeRevert(p1.data)
    let listed = S.isBlacklisted ? listed0 === 1n : BLOCKLIST_RE.test(String(r1.reason || ''))
    // The receiving side is checked by the stable too: a listed pool refuses the payment as surely as a listed wallet.
    if (!listed && S.isBlacklisted && payTo !== router) { const b = await call(stable, '0x' + SEL.isBlacklisted + abi.addr(payTo), wallet, tag); listed = b.ok && bool01(b.result) === 1n }
    if (listed) return { ...head1, result: 'would_revert', amount_out_simulated_base_units: null, gas_units: null, revert: revertOf('stable_blocklist', 'stable', r1) }
    // Our funding should have made this pass: a refusal with a reason that is not the blocklist puts the override in
    // doubt; one with no reason at all says nothing.
    if (!strip(p1.data)) return { ...head1, ...unknown('revert_unattributed', { revert: revertOf(null, 'stable', r1) }) }
    return { ...head1, ...unknown('override_suspect', { revert: revertOf(null, 'stable', r1) }) }
  }
  if (!probePool) return { ...head1, ...unknown('no_probe_pool', { revert: revertOf(null, null) }) }
  // The token: one unit from the pool that holds it to the wallet, and the same unit to the router as a control.
  const [p2, ctl] = await Promise.all([
    call(low(token), '0x' + SEL.transfer + abi.addr(wallet) + abi.uint(1), low(probePool), tag, ov),
    call(low(token), '0x' + SEL.transfer + abi.addr(router) + abi.uint(1), low(probePool), tag, ov),
  ])
  if (!p2.ok && p2.kind !== 'revert') return { ...head1, ...unknown(callErr(p2)) }
  if (!p2.ok) {
    // Only a probe that reproduces the swap's own revert, byte for byte, names it: the token refused the wallet and the
    // router passed that refusal on. A different refusal of one unit is not the cause of this swap's failure.
    if (strip(p2.data) && low(p2.data) === low(sw.data) && ctl.ok) return { ...head1, result: 'would_revert', amount_out_simulated_base_units: null, gas_units: null, revert: revertOf('token_rule', 'token', decodeRevert(p2.data)) }
    return { ...head1, ...unknown('revert_unattributed', { revert: revertOf(null, 'token', decodeRevert(p2.data)) }) }
  }
  return { ...head1, ...unknown('revert_unattributed', { revert: revertOf(null, null) }) }
}
