// @stockofproof/guard — a pre-trade check for agents that buy tokenized stocks on Base or Robinhood Chain.
//
// Before an agent swaps into a token that claims to be a stock, it asks proofofstock.xyz whether that exact contract is
// on the issuer's own registry (Coinbase on Base, Robinhood on Robinhood Chain). The guard turns the answer into a
// decision the agent can act on: buy, refuse, or refuse and use the issuer-listed address instead.
//
// ⚠ IT NEVER TRADES. It reads one public endpoint (GET /verify) and returns a decision; the swap is the agent's own.
// ⚠ IT FAILS CLOSED. If the registry cannot be read, the answer is "unknown" and the default is not to buy. A guard that
// lets a trade through because it could not look is no guard. `failOpen: true` changes that, on the caller's word.
// ⚠ "NOT LISTED" IS NOT "FAKE". A token outside these two registries may be another issuer's genuine token. The guard
// refuses it by default because it cannot vouch for it, and says so in those words.
//
// No dependencies; Node 18+ or any runtime with fetch.

export const DEFAULT_ENDPOINT = 'https://proofofstock.xyz'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const CHAINS = new Set(['base', 'robinhood'])
// Coinbase's symbols carry a trailing "c" (NVDAc); Robinhood's are the bare ticker (NVDA). A claim of either is the same.
const ticker = (s) => { const t = String(s || '').trim(); return (/^[A-Z0-9.]+c$/.test(t) ? t.slice(0, -1) : t).toUpperCase() }

/**
 * @param {object} [o]
 * @param {string} [o.endpoint]    the passport site (default https://proofofstock.xyz)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.timeoutMs]   per request (default 8000)
 * @param {boolean} [o.failOpen]   allow a buy when the registry cannot be read (default false)
 */
export function createGuard ({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 8000, failOpen = false } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available: pass fetchImpl')
  const base = endpoint.replace(/\/+$/, '')

  /** The raw verify answer: { status: 'ok'|'unavailable'|'error', body } */
  async function verify (chain, address) {
    if (!CHAINS.has(chain)) throw new Error(`chain must be base or robinhood, not ${chain}`)
    if (!ADDRESS.test(String(address))) throw new Error('address must be 0x followed by 40 hex characters')
    try {
      const r = await fetchImpl(`${base}/verify?chain=${chain}&address=${String(address).toLowerCase()}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
      const body = await r.json().catch(() => null)
      if (r.status === 200 && body) return { status: 'ok', body }
      if (r.status === 503) return { status: 'unavailable', body }
      return { status: 'error', body: body || { error: `HTTP ${r.status}` } }
    } catch (e) {
      return { status: 'error', body: { error: String(e && e.message || e) } }
    }
  }

  /**
   * The decision before a buy.
   * @param {object} p
   * @param {'base'|'robinhood'} p.chain
   * @param {string} p.tokenAddress     the contract the agent is about to buy
   * @param {string} [p.claimedSymbol]  what the user asked for (NVDA, TSLAc, ...): a listed token of ANOTHER stock is refused too
   * @returns {Promise<{ allow: boolean, decision: 'listed'|'impostor'|'not_listed'|'wrong_stock'|'unknown', reason: string, use_instead: string|null, verify: object }>}
   */
  async function beforeBuy ({ chain, tokenAddress, claimedSymbol } = {}) {
    const v = await verify(chain, tokenAddress)
    if (v.status !== 'ok') {
      return { allow: failOpen, decision: 'unknown', reason: `Could not check ${tokenAddress} on ${chain} (${v.body && v.body.error || v.status}). ${failOpen ? 'Allowed because failOpen is set.' : 'Not buying a token that could not be checked.'}`, use_instead: null, verify: v.body }
    }
    const b = v.body
    if (b.listed) {
      if (claimedSymbol && ticker(claimedSymbol) !== ticker(b.symbol)) {
        return { allow: false, decision: 'wrong_stock', reason: `${tokenAddress} is the issuer-listed ${b.symbol}, not ${claimedSymbol}. Check which stock was meant.`, use_instead: null, verify: b }
      }
      return { allow: true, decision: 'listed', reason: `${b.symbol} at ${b.address} is on the ${b.registries_checked.join(', ')} registry.`, use_instead: null, verify: b }
    }
    if (b.impostor) {
      const what = b.impostor.imitates_symbol ? `imitates the issuer-listed ${b.impostor.imitates_symbol}` : 'copies the issuer\'s naming for an asset it does not list'
      return { allow: false, decision: 'impostor', reason: `${tokenAddress} is not on the issuer registry; it ${what}.${b.impostor.listed_address ? ` The issuer-listed contract is ${b.impostor.listed_address}.` : ''}`, use_instead: b.impostor.listed_address || null, verify: b }
    }
    const elsewhere = b.listed_on_other_chain ? ` It is issuer-listed on ${b.listed_on_other_chain.chain} as ${b.listed_on_other_chain.symbol}: check the chain.` : ''
    return { allow: false, decision: 'not_listed', reason: `${tokenAddress} is not on the ${b.registries_checked.join(', ')} registry. That does not make it fake (another issuer's token would not be there either), but this guard cannot vouch for it.${elsewhere}`, use_instead: null, verify: b }
  }

  return { verify, beforeBuy }
}
