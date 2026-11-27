// apps/simulate/fake-world.mjs: a fake chain and a fake KyberSwap behind one fetchImpl, for simulate_buy's tests
// (apps/stocks-simulate.test.mjs, apps/stocks-web.test.mjs). Not used by the site.
//
// The chain holds one stable (with the slot layout of STABLES, or another to break the read-back), one stock token
// that can refuse a recipient, the pinned routers and Aerodrome's Quoter, Factory and Multicall3. The routers wrap
// every inner revert as the real ones do ("STF" / TRANSFER_FROM_FAILED for the stable, a generic failure for the pool),
// so only the probes can tell who refused. Every request is recorded, every override too.
import { CHAINS_SIM } from '../stocks-simulate.mjs'
import { SLIPSTREAM, SELECTORS as AERO } from './quote-aerodrome.mjs'
import { STABLES, mapKey, allowanceKey } from './sim-evm.mjs'
import { KYBER_ROUTER } from '../../packages/proofofstock-guard/examples/agent-buy.mjs'
import { decodeAggregate3Calldata, encodeAggregate3Result, MULTICALL3 } from '../../scripts/stocks/onchain-pools.mjs'
import { keccak256 } from '../../evm/core/stocks/evm-tx.mjs'

export const T = '0xb2000000000000000000001e800a7f5189430cd0' // the listed token (made up)
export const X = '0x' + '5a'.repeat(20) // a look-alike
export const OTHER = '0x' + '6b'.repeat(20)
export const W = '0x' + '11'.repeat(20) // the wallet: empty unless a test funds it
export const POOL = '0x' + '9c'.repeat(20), POOL2 = '0x' + '9d'.repeat(20)
export const D = SLIPSTREAM[0]
export const sel = (sig) => keccak256(Buffer.from(sig)).subarray(0, 4).toString('hex')
export const S = { balanceOf: sel('balanceOf(address)'), allowance: sel('allowance(address,address)'), transferFrom: sel('transferFrom(address,address,uint256)'), transfer: sel('transfer(address,uint256)'), isBlacklisted: sel('isBlacklisted(address)'), decimals: '313ce567' }
export const strip = (h) => String(h || '').replace(/^0x/, '').toLowerCase()
export const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
export const at = (h, i) => BigInt('0x' + (strip(h).slice(8 + i * 64, 8 + i * 64 + 64) || '0'))
export const addrAt = (h, i) => '0x' + strip(h).slice(8 + i * 64 + 24, 8 + i * 64 + 64)
export const errorString = (s) => { const b = Buffer.from(s, 'utf8').toString('hex'); return '0x08c379a0' + w(32) + w(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64 || 64, '0') }
export const HIGH = 1n << 255n, LOW = HIGH - 1n
export const REVERT = Symbol('revert')
export const MIN_LIMIT = 4295128739n + 1n, MAX_LIMIT = 1461446703485210103287273052203988822378723970342n - 1n
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ROUTER_SWAP = sel('swap((address,address,bytes,(address,address,address[],uint256[],address[],uint256[],address,uint256,uint256,uint256,bytes),bytes))')

/**
 * KyberSwap's router call as its route/build returns it: swap(SwapExecutionParams), encoded here independently of the
 * decoder under test, with executor data (the real router refuses a swap without it), empty clientData, fee lists and
 * permit.
 */
export function encodeKyberSwap ({ srcToken, dstToken, srcReceivers, srcAmounts, dstReceiver, amount, minReturnAmount, flags = 0, executor = null, selector = ROUTER_SWAP }) {
  // The executor call the fake pool runs: (tokenOut, recipient, amountIn), what a real executor's data would route.
  if (executor == null) executor = w(BigInt(dstToken)) + w(BigInt(dstReceiver)) + w(BigInt(amount))
  const addr = (a) => w(BigInt(a))
  const arr = (xs, f) => w(xs.length) + xs.map(f).join('')
  const descHead = 11 * 32
  const rcv = arr(srcReceivers, addr), amts = arr(srcAmounts, (x) => w(BigInt(x))), empty = w(0)
  const offR = descHead, offA = offR + rcv.length / 2, offFR = offA + amts.length / 2, offFA = offFR + 32, offP = offFA + 32
  const desc = addr(srcToken) + addr(dstToken) + w(offR) + w(offA) + w(offFR) + w(offFA) + addr(dstReceiver) + w(BigInt(amount)) + w(BigInt(minReturnAmount)) + w(BigInt(flags)) + w(offP) + rcv + amts + empty + empty + empty
  const target = w(executor.length / 2) + (executor ? executor.padEnd(Math.ceil(executor.length / 64) * 64, '0') : '')
  const tupleHead = 5 * 32
  const offTarget = tupleHead, offDesc = offTarget + target.length / 2, offClient = offDesc + desc.length / 2
  const tuple = w(BigInt(POOL)) + w(BigInt(POOL)) + w(offTarget) + w(offDesc) + w(offClient) + target + desc + empty
  return '0x' + selector + w(32) + tuple
}

/** The executor call inside a swap(SwapExecutionParams) calldata, decoded here on its own: { target, tokenOut, recipient, amountIn } or null. */
export function kyberExecutor (data) {
  const h = strip(data)
  if (h.slice(0, 8) !== ROUTER_SWAP) return null
  const word = (byteOff) => BigInt('0x' + (h.slice(8 + byteOff * 2, 8 + byteOff * 2 + 64) || 'x'))
  try {
    const t = Number(word(0)), target = '0x' + w(word(t)).slice(24)
    const off = t + Number(word(t + 64)), len = Number(word(off))
    if (len !== 96 || target !== POOL) return null
    return { target, tokenOut: '0x' + w(word(off + 32)).slice(24), recipient: '0x' + w(word(off + 64)).slice(24), amountIn: word(off + 96) }
  } catch (_) { return null }
}

/** A fake chain (one stable, one stock token, the routers) and a fake KyberSwap, behind one fetchImpl. */
export function world (chain = 'base', o = {}) {
  const TOKEN = String(o.token || T).toLowerCase()
  const st = STABLES[chain]
  const layout = { bal: o.balanceSlot ?? st.balanceSlot, allow: st.allowanceSlot }
  const storage = new Map()
  const native = new Map()
  const set = (k, v) => storage.set(k.toLowerCase(), BigInt(v))
  const builds = new Map() // calldata -> { amountIn, minOut, recipient, dstToken }
  // Block hashes the fake chain knows: one per height, so a hash tag resolves to its height.
  const byHash = new Map()
  const hashOf = (n) => { const h = '0x' + BigInt(n).toString(16).padStart(64, 'a').slice(-64); byHash.set(h, BigInt(n)); return h }
  const wd = {
    chain, st, storage, native, set, requests: [], overrides: [], swapCalls: 0, head: 30000000,
    hashTags: 0, amountOut: 24900000n, sellOut: 24950000n, decimals: 8, refuses: new Set(), headerGone: 0,
    quotes: { 1: REVERT, 10: 24900000n, 50: REVERT }, pools: { 1: POOL2, 10: POOL, 50: POOL2 }, partial: {}, quoterFactory: D.factory, routerFactory: D.factory,
    baseFee: '0x989680', kyber: null, kyberBuild: null, buildPatch: null, kyberOut: null, onAggregator: null, ...o,
  }
  const balOf = (s, a) => (s.get(mapKey(a, layout.bal)) ?? 0n)
  const revert = (data, message = 'execution reverted') => ({ error: { code: 3, message, data } })
  // One EVM call: { result } or { revert: data }.
  function exec (tx, s, nat) {
    const to = String(tx.to).toLowerCase(), d = strip(tx.data), from = String(tx.from || '').toLowerCase(), f = d.slice(0, 8)
    if (to === MULTICALL3) return { result: aggregate(tx.data) }
    if (to === TOKEN || to === OTHER) {
      if (f === S.decimals) return wd.decimalsDown ? { revert: '0x' } : { result: '0x' + w(wd.decimals) }
      if (f === S.transfer) {
        const rcpt = addrAt(tx.data, 0)
        if (wd.tokenRefusesAll) return { revert: errorString('Pausable: paused') }
        if (wd.tokenEmptyRevert && wd.refuses.has(rcpt)) return { revert: '0x' }
        return wd.refuses.has(rcpt) ? { revert: errorString('SAFE: go ahead, the recipient is not allowed') } : { result: '0x' + w(1) }
      }
    }
    if (to === st.address) {
      if (f === S.balanceOf) return { result: '0x' + w(balOf(s, addrAt(tx.data, 0)) & LOW) }
      if (f === S.allowance) return { result: '0x' + w(s.get(allowanceKey(addrAt(tx.data, 0), addrAt(tx.data, 1), layout.allow)) ?? 0n) }
      if (f === S.isBlacklisted) return { result: '0x' + w(wd.blacklistWord ?? (st.blocklistHighBit && (balOf(s, addrAt(tx.data, 0)) & HIGH) ? 1 : 0)) }
      if (f === S.transferFrom) {
        const owner = addrAt(tx.data, 0), amt = at(tx.data, 2)
        if (st.blocklistHighBit && ((balOf(s, owner) & HIGH) || (balOf(s, addrAt(tx.data, 1)) & HIGH))) return { revert: errorString('Blacklistable: account is blacklisted') }
        if (wd.stablePaused) return { revert: errorString('Pausable: paused') }
        if ((s.get(allowanceKey(owner, from, layout.allow)) ?? 0n) < amt) return { revert: errorString('ERC20: transfer amount exceeds allowance') }
        if ((balOf(s, owner) & LOW) < amt) return { revert: errorString('ERC20: transfer amount exceeds balance') }
        return { result: '0x' + w(1) }
      }
    }
    if (CHAINS_SIM[chain].routers.includes(to) || to === KYBER_ROUTER || to === OTHER_ROUTER) {
      wd.swapCalls++
      const aero = f === AERO.exactInputSingle
      // KyberSwap's router runs the executor call its calldata carries, against the executor it names: the fake pool
      // here. No executor call, another target, or one that does not decode, and the router reverts, as the real one does.
      const b = aero ? null : builds.get(String(tx.data).toLowerCase())
      const exe = aero ? null : kyberExecutor(tx.data)
      if (!aero && (!b || !exe)) return { revert: '0x' }
      const amountIn = aero ? at(tx.data, 5) : exe.amountIn, minOut = aero ? at(tx.data, 6) : b.minOut
      const rcpt = aero ? addrAt(tx.data, 3) : /^0x0{40}$/.test(exe.recipient) ? from : exe.recipient
      if (!aero && exe.tokenOut !== TOKEN) return { revert: errorString('executor: unknown pool token') }
      // The router pulls the stable through its helper, and replaces the stable's own revert with its own.
      const pull = exec({ from: to, to: st.address, data: '0x' + S.transferFrom + w(BigInt(from)) + w(BigInt(POOL)) + w(amountIn) }, s, nat)
      if (pull.revert) return { revert: errorString(aero ? 'STF' : 'TRANSFER_FROM_FAILED') }
      if (wd.minOutFirst && wd.amountOut < minOut) return { revert: errorString(aero ? 'Too little received' : 'Return amount is not enough') }
      if (wd.bubble && wd.tokenRefusesAll) return { revert: errorString('Pausable: paused') }
      if (wd.bubble && wd.refuses.has(rcpt)) return { revert: errorString('SAFE: go ahead, the recipient is not allowed') }
      if (wd.revertText) return { revert: errorString(wd.revertText) }
      if (wd.refuses.has(rcpt) || wd.tokenRefusesAll) return { revert: errorString('swap failed') }
      if (wd.routerRevertsAnyway) return { revert: errorString('swap failed') }
      if (wd.emptyRevert) return { revert: '0x' }
      if (wd.amountOut < minOut) return { revert: errorString(aero ? 'Too little received' : 'Return amount is not enough') }
      if (wd.undecodable) return { result: '0x' }
      // What moved, as the logs say it: the stable out of the wallet (all of it, unless a test spends less, as a partial
      // fill would) and the token into the recipient.
      const topic = (a) => '0x' + w(BigInt(a))
      const logs = [
        { address: st.address, topics: [TRANSFER, topic(from), topic(POOL)], data: '0x' + w(wd.debit ?? amountIn) },
        { address: TOKEN, topics: [TRANSFER, topic(POOL), topic(wd.creditTo ?? rcpt)], data: '0x' + w(wd.credit ?? wd.amountOut) },
      ]
      const moved = { debit: wd.debit ?? amountIn, credit: wd.credit ?? wd.amountOut, creditTo: String(wd.creditTo ?? rcpt).toLowerCase() }
      // Slipstream's router returns amountOut; KyberSwap's returns (returnAmount, gasUsed).
      return { result: '0x' + w(wd.amountOut) + (aero ? '' : w(150000)), logs, moved }
    }
    return { revert: '0x' }
  }
  function aggregate (data) {
    const calls = decodeAggregate3Calldata(data)
    const out = calls.map((c) => {
      const f = strip(c.data).slice(0, 8)
      if (c.to === D.quoter && f === AERO.factory) return { success: true, data: '0x' + w(BigInt(wd.quoterFactory)) }
      if (c.to === D.router && f === AERO.factory) return { success: true, data: '0x' + w(BigInt(wd.routerFactory)) }
      if (c.to === D.factory && f === AERO.getPool) { const p = wd.pools[Number(at(c.data, 2))]; if (p === 'fail') return { success: false, data: '0x' }; return { success: true, data: '0x' + w(p ? BigInt(p) : 0) } }
      if (c.to === D.quoter && f === AERO.quoteExactInputSingle) {
        const tokenIn = addrAt(c.data, 0), tokenOut = addrAt(c.data, 1), ts = Number(at(c.data, 3))
        if (tokenIn === '0x4200000000000000000000000000000000000006') return { success: true, data: '0x' + w(3_000_000) + w(1n << 96n) + w(0) + w(100000) }
        // A sell-back that only one tick spacing can route (`sellTick`): its reverse quote takes another pool than the buy.
        const q = tokenIn === TOKEN && wd.sellTick != null ? (ts === wd.sellTick ? wd.sellOut : REVERT) : wd.quotes[ts]
        // A reverted quote carries revert data long enough to be misread as the Quoter's four words.
        if (q === REVERT || q == null) return { success: false, data: errorString('Unexpected error: no pool can route this size here, at this tick spacing') }
        if (q === 'short') return { success: true, data: '0x' + w(24900000n) }
        const out = tokenIn === TOKEN ? wd.sellOut : q
        // A pool that ran out of liquidity ends at the price limit, its output for less than the whole input.
        const zeroForOne = tokenIn < tokenOut
        const after = wd.partial[ts] || (tokenIn === TOKEN && wd.partial.sell) ? (zeroForOne ? MIN_LIMIT : MAX_LIMIT) : 1n << 96n
        return { success: true, data: '0x' + w(out) + w(after) + w(1) + w(150000) }
      }
      // The token's B20 rules and the policy registry, when a test gives the chain some (apps/simulate/fake-b20.mjs).
      const b20 = wd.b20 ? wd.b20.answer(c) : null
      if (b20) return b20
      return { success: false, data: '0x' }
    })
    return encodeAggregate3Result(out)
  }
  function applied (override) {
    const s = new Map(storage), nat = new Map(native)
    for (const [addr, v] of Object.entries(override || {})) {
      if (v.stateDiff) for (const [k, val] of Object.entries(v.stateDiff)) { if (addr !== st.address) throw new Error('override of a contract the fake does not model: ' + addr); s.set(k.toLowerCase(), BigInt(val)) }
      if (v.balance) nat.set(addr, BigInt(v.balance))
    }
    return { s, nat }
  }
  async function rpc (body) {
    const { method, params } = body
    if (wd.rpcDown && wd.rpcDown(method, params)) throw new Error('timeout')
    if (method === 'eth_blockNumber') { wd.readHead = wd.head; return { result: '0x' + (wd.head++).toString(16) } }
    if (method === 'eth_getBlockByNumber') { const n = params[0] === 'latest' ? BigInt(wd.head) : BigInt(params[0]); return { result: { number: '0x' + n.toString(16), timestamp: '0x' + (wd.blockTime ? BigInt(wd.blockTime(n)) : 1764600000n + n * 2n).toString(16), hash: hashOf(n), ...(wd.baseFee != null ? { baseFeePerGas: wd.baseFee } : {}) } } }
    const tag = params[1]
    if (tag && typeof tag === 'object') { if (!tag.blockHash || !byHash.has(String(tag.blockHash).toLowerCase())) return { error: { code: -32000, message: 'header for hash not found' } }; wd.hashTags++ }
    const pinned = tag !== 'latest'
    const toMulticall = method === 'eth_call' && String(params[0]?.to).toLowerCase() === MULTICALL3
    if (wd.headerGone > 0 && pinned && !toMulticall && ['eth_getBalance', 'eth_call', 'eth_getStorageAt'].includes(method)) { wd.headerGone--; return { error: { code: -32000, message: 'header not found' } } }
    if (method === 'eth_getBalance') return { result: wd.balanceHex ?? '0x' + (native.get(params[0]) ?? 0n).toString(16) }
    if (method === 'eth_getStorageAt') return { result: wd.storageShort ? '0x' : wd.storageLies ? '0x' + w(0) : '0x' + w(storage.get(String(params[1]).toLowerCase()) ?? 0n) }
    if (method === 'eth_simulateV1') {
      // One block of calls in order, the state carried from one call to the next: the swap moves the wallet's balances.
      if (wd.simulateV1Missing) return { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } }
      const bsc = params[0].blockStateCalls[0]
      const ov = bsc.stateOverrides || {}
      if (Object.keys(ov).length) wd.overrides.push(ov)
      const { s: st0, nat } = applied(ov)
      let stableDelta = 0n, tokenDelta = 0n
      const calls = bsc.calls.map((c) => {
        const to = String(c.to).toLowerCase(), f = strip(c.data).slice(0, 8)
        if (f === S.balanceOf && addrAt(c.data, 0) === String(c.from).toLowerCase()) {
          if (to === st.address) return { status: '0x1', returnData: '0x' + w((balOf(st0, c.from) & LOW) + stableDelta), logs: [] }
          if (to === TOKEN) return { status: '0x1', returnData: '0x' + w((wd.tokenHeld ?? 0n) + tokenDelta), logs: [] }
        }
        const r = wd.simSwapFails && CHAINS_SIM[chain].routers.concat([KYBER_ROUTER]).includes(to) ? { revert: '0x' } : exec(c, st0, nat)
        if (r.revert !== undefined) return { status: '0x0', returnData: r.revert, logs: [] }
        // A test's odd node: a failed status with a return that decodes, or a success whose return is below the minimum.
        if (r.moved && wd.simStatusFails) return { status: '0x0', returnData: r.result, logs: [] }
        if (r.moved && wd.simReturnLow) r.result = '0x' + w(1) + (r.result.length > 66 ? w(150000) : '')
        if (r.moved) {
          // A block built on an older parent than the read block can see more liquidity: a full fill there, a partial one
          // at the read block (the reviewer's controlled case).
          const atHead = (typeof params[1] === 'object' ? byHash.get(String(params[1].blockHash).toLowerCase()) : BigInt(params[1])) === BigInt(wd.readHead ?? -1)
          stableDelta -= wd.partialAtHead && atHead ? r.moved.debit - 100000n : r.moved.debit; stableDelta += wd.refund ?? 0n
          if (r.moved.creditTo === String(c.from).toLowerCase()) tokenDelta += r.moved.credit
          tokenDelta -= wd.feeTaken ?? 0n
        }
        return { status: '0x1', returnData: r.result, logs: [] }
      })
      // The simulated block is the base block's child (or, for a test, another number), with its own later time.
      const base = typeof params[1] === 'object' ? byHash.get(String(params[1].blockHash).toLowerCase()) : BigInt(params[1])
      const number = '0x' + (base + (wd.otherParent ? 5n : 1n)).toString(16)
      // A reorg: the node builds the child on another block of the same height, so its parent hash is not ours.
      const parentHash = wd.reorg ? '0x' + 'ee'.repeat(32) : hashOf(base)
      const timestamp = '0x' + (wd.simTimestamp ?? (1764000000n + (BigInt(number) - 30000000n) * 2n)).toString(16)
      return { result: [{ number, timestamp, parentHash, calls }] }
    }
    if (method === 'eth_call' || method === 'eth_estimateGas') {
      const tx = params[0], override = params[2]
      if (override) wd.overrides.push(override)
      const isSwap = CHAINS_SIM[chain].routers.includes(String(tx.to).toLowerCase()) || [KYBER_ROUTER, OTHER_ROUTER].includes(String(tx.to).toLowerCase())
      if (isSwap && wd.gasCap) return { error: { code: -32000, message: 'gas required exceeds allowance (25000000)' } }
      if (isSwap && method === 'eth_estimateGas' && wd.estimateFails) return { error: { code: -32000, message: 'gas estimation failed' } }
      const { s, nat } = applied(override)
      const r = exec(tx, s, nat)
      if (r.revert !== undefined) return revert(r.revert, 'execution reverted')
      return method === 'eth_estimateGas' ? { result: '0x249f0' } : { result: r.result }
    }
    return { error: { code: -32601, message: 'no such method' } }
  }
  function kyberRoute (q) {
    const tokenIn = q.get('tokenIn'), tokenOut = q.get('tokenOut'), amountIn = q.get('amountIn')
    const sell = tokenIn === TOKEN
    const out = wd.kyberOut ? wd.kyberOut(BigInt(amountIn), sell) : sell ? wd.sellOut : wd.amountOut + 50000n
    const rs = { tokenIn, tokenOut, amountIn, amountOut: String(out), gas: '200000', gasUsd: '0.02', amountInUsd: '999', amountOutUsd: '999',
      route: [[{ pool: POOL, tokenIn, tokenOut, exchange: 'Uniswap V3 <b>SAFE</b>', swapAmount: amountIn, amountOut: String(out) }]] }
    return wd.kyber ? wd.kyber({ tokenIn, tokenOut, amountIn, sell, rs }) : { status: 200, body: { code: 0, data: { routeSummary: rs, routerAddress: KYBER_ROUTER } } }
  }
  function kyberBuilt (b) {
    const rs = b.routeSummary
    const minOut = BigInt(rs.amountOut) * BigInt(10000 - b.slippageTolerance) / 10000n
    const desc = { srcToken: rs.tokenIn, dstToken: rs.tokenOut, srcReceivers: [POOL], srcAmounts: [rs.amountIn], dstReceiver: b.recipient, amount: rs.amountIn, minReturnAmount: minOut, ...(wd.buildPatch || {}) }
    const data = encodeKyberSwap(desc)
    builds.set(data.toLowerCase(), { amountIn: BigInt(desc.amount), minOut: BigInt(desc.minReturnAmount), recipient: String(desc.dstReceiver).toLowerCase(), dstToken: String(desc.dstToken).toLowerCase() })
    return { body: { code: 0, data: { routerAddress: KYBER_ROUTER, data, amountOut: rs.amountOut } } }
  }
  wd.fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url))
    const reply = ({ status = 200, body }) => ({ ok: status < 400, status, json: async () => body })
    if (u.hostname === 'aggregator-api.kyberswap.com') {
      const rec = { kind: 'aggregator', path: u.pathname, body: init.body || null, query: u.search }
      wd.requests.push(rec)
      if (wd.onAggregator) await wd.onAggregator(rec)
      if (wd.aggregatorDown) return reply({ status: 503, body: { message: 'down: no route to host' } })
      if (u.pathname.endsWith('/routes')) return reply(kyberRoute(u.searchParams))
      if (u.pathname.endsWith('/route/build')) {
        const b = JSON.parse(init.body)
        if (wd.kyberBuild) { const r = wd.kyberBuild(b, encodeKyberSwap); if (r.register) builds.set(r.body.data.data.toLowerCase(), r.register); return reply(r) }
        return reply(kyberBuilt(b))
      }
      return reply({ status: 404, body: {} })
    }
    const body = JSON.parse(init.body)
    wd.requests.push({ kind: 'rpc', method: body.method, params: body.params })
    return reply({ body: { jsonrpc: '2.0', id: 1, ...(await rpc(body)) } })
  }
  return wd
}
export const OTHER_ROUTER = '0x' + '7e'.repeat(20)
