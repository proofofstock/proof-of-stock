// apps/pass-sales.mjs: what the settlement wallet has done on Base, read from the chain, for the Paid passes block on
// /status and for /api/status/payments.
//
// Why from the chain (outside review, 21.11: "nothing shows a paid pass ever happened"): a count we kept ourselves is
// one more number to take on trust. The settlement wallet sends one transaction per pass sold and nothing else, so its
// own transaction count on Base is the number of settlements, and anyone can read the same number on BaseScan. The
// latest one is found on the chain too and linked, with who paid it, so a sale of our own is said to be ours.
//
// How the latest transaction is found with nothing but a public node: the wallet's count at a block is monotone in the
// block, so a binary search finds the first block where it reached its current value; that block holds the latest
// settlement, the wallet's transaction with the nonce just below the count. Its receipt's USDC transfer to our payee
// says it paid out and names the payer. Each answer is kept for good (a mined transaction does not change), so a new
// search runs only when the count moves.
//
// Read in the background, at most every REFRESH_MS, and only when somebody asks: a request never waits for the chain.
// A node that fails keeps the last good answer and says how old it is.

export const REFRESH_MS = 10 * 60e3
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ADDR_RE = /^0x[0-9a-f]{40}$/
const HASH_RE = /^0x[0-9a-f]{64}$/

/**
 * Payers that are us: the test wallet that made the first purchase end to end. A sale from one of these is shown as
 * our own, never as a customer's.
 */
export const OUR_PAYERS = Object.freeze(['0x376a832d9827b157c9e7502e11af1e45c8224a88'])

/**
 * One JSON-RPC call to a Base node, for the search above. A block with its transactions can run past the anchor
 * mirror's 512 KB cap, so this one allows MAX_BYTES; the node is still a stranger: no redirects, a timeout, a cap.
 */
export const MAX_BYTES = 8 * 1024 * 1024
export function rpcCaller ({ url, fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (!/^https:\/\//.test(String(url))) throw new Error('the Base node must be an https url')
  return async (method, params = []) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) throw new Error(`${method}: the node answered ${r.status}`)
    const text = await r.text()
    if (text.length > MAX_BYTES) throw new Error(`${method}: the node answered ${text.length} bytes`)
    const j = JSON.parse(text)
    if (j && j.error) throw new Error(`${method}: ${String(j.error.message || j.error).slice(0, 120)}`)
    return j ? j.result : undefined
  }
}

const addrOfTopic = (t) => (typeof t === 'string' && t.length === 66 ? '0x' + t.slice(26).toLowerCase() : null)
const num = (hex) => { const n = Number.parseInt(String(hex), 16); return Number.isFinite(n) ? n : null }
const hex = (n) => '0x' + n.toString(16)

/**
 * @param {{ wallet: string, payTo: string, call: (method: string, params: any[]) => Promise<any>, now?: () => number,
 *           refreshMs?: number, ourPayers?: string[], log?: (m: string) => void }} o
 */
export function createPassSales ({ wallet, payTo, call: callRaw, now = () => Date.now(), refreshMs = REFRESH_MS, ourPayers = OUR_PAYERS, log = () => {}, pauseMs = 200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // A public node answers a burst with 429. The search is a few dozen small calls once per sale, so it goes at an easy
  // pace and a refused call is tried again after a wait, three times at most.
  const call = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      if (pauseMs) await sleep(pauseMs)
      try { return await callRaw(method, params) } catch (e) {
        if (attempt >= 3 || !/429|rate|limit/i.test(String(e && e.message || e))) throw e
        await sleep(pauseMs * 5 * (attempt + 1))
      }
    }
  }
  const w = String(wallet || '').toLowerCase()
  const p = String(payTo || '').toLowerCase()
  if (!ADDR_RE.test(w) || !ADDR_RE.test(p)) return { snapshot: () => null, refresh: async () => null }
  const ours = new Set(ourPayers.map((a) => a.toLowerCase()))
  const latestByCount = new Map() // count → the settlement that brought the wallet to it (immutable once found)
  let state = null // { settlement_transactions, latest, read_at }
  let inFlight = null
  let lastTry = -Infinity

  async function countAt (block) { const n = num(await call('eth_getTransactionCount', [w, block])); if (n == null) throw new Error('no count in the answer'); return n }

  async function findLatest (count) {
    if (latestByCount.has(count)) return latestByCount.get(count)
    const head = num(await call('eth_blockNumber', []))
    if (head == null) throw new Error('no block number in the answer')
    let lo = 0, hi = head // the first block at which the wallet's count is `count`
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (await countAt(hex(mid)) >= count) hi = mid; else lo = mid + 1
    }
    // The block with its transactions: public nodes refuse eth_getLogs under load, and this is one call per sale.
    const block = await call('eth_getBlockByNumber', [hex(lo), true])
    const at = block && num(block.timestamp) != null ? new Date(num(block.timestamp) * 1000).toISOString() : null
    const tx = (Array.isArray(block?.transactions) ? block.transactions : [])
      .find((t) => t && String(t.from).toLowerCase() === w && num(t.nonce) === count - 1 && HASH_RE.test(String(t.hash)))
    if (!tx) throw new Error(`no transaction of the wallet with nonce ${count - 1} in block ${lo}`)
    // The receipt says whether it paid out: a USDC transfer from the payer to our payee. A settlement that reverted
    // still counts as sent; the page says the latest one did not pay out.
    const receipt = await call('eth_getTransactionReceipt', [tx.hash])
    const paid = (Array.isArray(receipt?.logs) ? receipt.logs : []).find((l) => String(l.address).toLowerCase() === USDC_BASE &&
      l.topics?.[0] === TRANSFER_TOPIC && addrOfTopic(l.topics?.[2]) === p)
    const settled = num(receipt?.status) === 1 && Boolean(paid)
    const payer = settled ? addrOfTopic(paid.topics[1]) : null
    const latest = { transaction: tx.hash, at, settled, payer, ours: payer != null && ours.has(payer) }
    latestByCount.set(count, latest)
    return latest
  }

  async function refresh () {
    if (inFlight) return inFlight
    lastTry = now()
    inFlight = (async () => {
      try {
        const count = await countAt('latest')
        const latest = count > 0 ? await findLatest(count) : null
        state = { settlement_transactions: count, latest, read_at: new Date(now()).toISOString() }
      } catch (e) {
        log(`[pass-sales] read failed: ${String(e && e.message || e).slice(0, 160)}`)
      } finally { inFlight = null }
      return state
    })()
    return inFlight
  }

  /** The last answer read from the chain, or null before the first one; starts a background read when stale. */
  function snapshot () {
    if (!inFlight && now() - lastTry >= refreshMs) refresh().catch(() => {})
    return state
  }

  return { snapshot, refresh }
}
