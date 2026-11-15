// scripts/stocks/test-fake-chain.mjs: a chain for the tests of scripts/stocks/onchain-pools.mjs and stock-peg.mjs. It answers
// eth_getBlockByNumber and Multicall3 aggregate3 eth_calls from a table of (contract, calldata) -> return bytes, the way a
// node would: a call it has no entry for fails, as a revert does inside aggregate3. Not a test suite itself.

import { MULTICALL3, SEL, args, decodeAggregate3Calldata, encodeAggregate3Result, priceFromSqrt } from './onchain-pools.mjs'

const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
const a32 = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** sqrtPriceX96 for `token1 per token0` in whole tokens. */
export function sqrtX96For (price1per0, dec0, dec1) {
  const raw = price1per0 * 10 ** (dec1 - dec0)
  const s = BigInt(Math.round(Math.sqrt(raw) * 2 ** 48)) * 2n ** 48n
  if (Math.abs(priceFromSqrt(s, dec0, dec1) / price1per0 - 1) > 1e-9) throw new Error('sqrtX96For: precision')
  return s
}

export function fakeChain ({ rpc, block = 4242, hash = '0x' + 'b1'.repeat(32) } = {}) {
  const table = new Map()
  const log = { blocks: 0, calls: 0, atBlocks: new Set() }
  const set = (to, data, ret) => table.set(to.toLowerCase() + ':' + data.toLowerCase(), '0x' + ret)
  const chain = {
    log, block, hash, table,
    set,
    erc20 (addr, decimals, balances = {}) {
      set(addr, '0x' + SEL.decimals, w(decimals))
      for (const [holder, raw] of Object.entries(balances)) set(addr, '0x' + SEL.balanceOf + a32(holder), w(raw))
    },
    v3 (pool, t0, t1, sqrtX96) {
      set(pool, '0x' + SEL.token0, a32(t0)); set(pool, '0x' + SEL.token1, a32(t1))
      set(pool, '0x' + SEL.slot0, w(sqrtX96) + w(1) + w(0) + w(1) + w(1) + w(0) + w(1))
    },
    v2 (pool, t0, t1, r0, r1, stable = false) {
      set(pool, '0x' + SEL.token0, a32(t0)); set(pool, '0x' + SEL.token1, a32(t1))
      set(pool, '0x' + SEL.getReserves, w(r0) + w(r1) + w(1))
      set(pool, '0x' + SEL.stable, w(stable ? 1 : 0))
    },
    v4 (stateView, poolId, sqrtX96) { set(stateView, '0x' + SEL.getSlot0 + args.bytes32(poolId), w(sqrtX96) + w(0) + w(0) + w(500)) },
    getPool (factory, byFee, a, b, param, pool) { set(factory, '0x' + (byFee ? SEL.getPoolByFee : SEL.getPoolBySpacing) + a32(a) + a32(b) + w(param), a32(pool)) },
    down: false,
    /** A fetch that answers this chain's RPC and hands anything else to `next`. */
    fetch (next) {
      return async (url, init) => {
        if (String(url) !== rpc) return next(url, init)
        if (chain.down) return { ok: false, status: 503, json: async () => ({}) }
        const req = JSON.parse(init.body)
        const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) })
        if (req.method === 'eth_getBlockByNumber') { log.blocks++; return reply({ number: '0x' + chain.block.toString(16), hash: chain.hash }) }
        if (req.method === 'eth_call') {
          const [{ to, data }, tag] = req.params
          log.calls++; log.atBlocks.add(tag)
          if (to.toLowerCase() !== MULTICALL3) return reply('0x')
          const calls = decodeAggregate3Calldata(data)
          return reply(encodeAggregate3Result(calls.map((c) => {
            const r = table.get(c.to.toLowerCase() + ':' + c.data.toLowerCase())
            return r ? { success: true, data: r } : { success: false, data: '0x' }
          })))
        }
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no such method' } }) }
      }
    },
  }
  return chain
}
