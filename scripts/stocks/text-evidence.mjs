// scripts/stocks/text-evidence.mjs: the symbol() and name() a flagged contract returns on chain, at a pinned block, as
// raw bytes (spec item G, docs ASSAY 1.4). A new case says "this token's symbol copies NVDAc"; until now that symbol came
// from our collector's files, with no block. Now a new case carries what the contract itself answered, the block, and
// the command that asks it again.
//
// Rules: the bytes stay hex and are never put into our sentences; they are decoded only to compare with the collector's
// text (normalizeUntrusted on both sides). A mismatch does not close the case; it is recorded (matches_collector: false).
// The chain unreachable: no evidence (the case opens as before). Robinhood's public RPC keeps no old state, so there
// replaying needs an archive node (needs_archive_rpc: true). One multicall per run, through the pool reader's helpers.
import { multicall, pinBlock, rpcUrlOf, call, ONCHAIN } from './onchain-pools.mjs'
import { normalizeUntrusted } from '../../evm/core/stocks/untrusted-text.mjs'

const SYMBOL = '95d89b41', NAME = '06fdde03'
export const MAX_PER_RUN = 300

/** ABI string (or bytes32) return data to text, for comparison only; null when it is neither. */
export function decodeText (hex) {
  const h = String(hex || '').replace(/^0x/, '')
  if (!h) return null
  try {
    if (h.length >= 128) {
      const off = parseInt(h.slice(0, 64), 16) * 2, len = parseInt(h.slice(off, off + 64), 16)
      if (Number.isFinite(len) && len <= 512 && off + 64 + len * 2 <= h.length) return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8')
    }
    if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '')
  } catch (_) { /* not text */ }
  return null
}

/**
 * Read symbol() and name() of `addresses` at one block. Returns Map address -> evidence; empty when the chain cannot be
 * read (the caller then records no evidence). `collector`: Map address -> { symbol, name } as the collector saw them.
 */
export async function readTextEvidence ({ chain, chainId = null, addresses, collector = new Map(), fetchImpl = fetch, env = process.env }) {
  const out = new Map()
  const cfg = ONCHAIN[chain]
  const { url, label } = rpcUrlOf(chain, env)
  const list = [...new Set(addresses.map((a) => String(a).toLowerCase()))].slice(0, MAX_PER_RUN)
  if (!cfg || !url || !list.length) return out
  try {
    const block = await pinBlock(fetchImpl, url)
    const res = await multicall(fetchImpl, url, list.flatMap((a) => [call(a, SYMBOL), call(a, NAME)]), block.number)
    list.forEach((a, i) => {
      const s = res[2 * i], n = res[2 * i + 1]
      const symbolReturn = s && s.success ? s.data : null, nameReturn = n && n.success ? n.data : null
      const seen = collector.get(a) || {}
      const same = (ret, text) => ret != null && normalizeUntrusted(decodeText(ret) || '') === normalizeUntrusted(text || '')
      out.set(a, {
        chain_id: chainId,
        block_number: block.number,
        block_hash: block.hash,
        symbol_return: symbolReturn,
        name_return: nameReturn,
        matches_collector: same(symbolReturn, seen.symbol) && same(nameReturn, seen.name),
        reproduce: `cast call --block ${block.number} ${a} 'symbol()(string)' --rpc-url ${label === 'public' ? url : '<an RPC for this chain>'}`,
        needs_archive_rpc: !cfg.archive,
      })
    })
  } catch (_) { return new Map() }
  return out
}
