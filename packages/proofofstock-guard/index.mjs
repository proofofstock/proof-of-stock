// @proofofstock/guard: a pre-trade check for agents that buy tokenized stocks on Base or Robinhood Chain.
//
// Before an agent swaps into a token that claims to be a stock, it asks proofofstock.xyz whether that exact contract is
// on the issuer's own registry (Coinbase on Base, Robinhood on Robinhood Chain). The guard turns the answer into a
// decision the agent can act on: buy, refuse, or refuse and use the issuer-listed address instead.
//
// ⚠ IT NEVER TRADES. It reads public endpoints (GET /verify) and returns a decision; the swap is the agent's own.
// ⚠ IT FAILS CLOSED. If the registry cannot be read, the answer is "unknown" and the default is not to buy. A guard that
// lets a trade through because it could not look is no guard. `failOpen: true` changes that, on the caller's word.
// ⚠ NO EVIDENCE, NO BUY. A listed answer must carry the issuer list it was decided against (`list_proof`), not stale,
// read within `maxRegistryAgeS`; otherwise it is "unknown". With `crossCheck: true` the guard also reads the issuer's
// own list itself and buys only if the address is on it (checkListProof).
// ⚠ "NOT LISTED" IS NOT "FAKE". A token outside these two registries may be another issuer's genuine token. The guard
// refuses it by default because it cannot vouch for it, and says so in those words.
// ⚠ BAD INPUT IS A REFUSAL, NOT A THROW. beforeBuy never throws: a malformed address or chain is decision invalid_input.
//
// No dependencies; Node 20.19+ (ESM, also loadable with require()) or any runtime with fetch and WebCrypto.

export const VERSION = '0.2.0'
export const DEFAULT_ENDPOINT = 'https://proofofstock.xyz'
export const MAX_BATCH = 50
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const CHAINS = new Set(['base', 'robinhood'])
const CHAIN_ID = Object.freeze({ base: 8453, robinhood: 4663 })

// The issuers' lists, read the way proofofstock.xyz reads them (evm/core/stocks/list-proof.mjs): the same addresses,
// lowercase, sorted bytewise, one per line, each line ending in "\n", hashed with SHA-256. A test in the repository holds
// the two in step on one fixture.
const ISSUER_LISTS = Object.freeze({
  coinbase: { url: 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500', addresses: (b) => (Array.isArray(b?.tokens) && !b.next_page_token ? b.tokens.map((t) => t.contract_address) : null) },
  robinhood: { url: 'https://api.robinhood.com/rhj/assets', addresses: (b) => (Array.isArray(b?.assets) ? b.assets.map((a) => (Array.isArray(a.deployments) ? a.deployments : []).find((d) => String(d.chainId) === String(CHAIN_ID.robinhood))?.contractAddress).filter((x) => x != null) : null) },
})

/** SHA-256 hex of the addresses as proofofstock.xyz hashes them (list_proof.addresses_sha256). */
export async function addressesSha256 (addresses) {
  const text = addresses.map((a) => String(a).toLowerCase()).sort().map((a) => a + '\n').join('')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Check a list_proof against the issuer itself: read the issuer's list now, hash it, and say whether it is the list the
 * verdict used, and whether `address` is on it. Never throws.
 * @returns {Promise<{ status: 'match'|'list_changed'|'issuer_unavailable'|'no_recipe', address_in_issuer_list: boolean|null, issuer_sha256: string|null }>}
 */
export async function checkListProof (proof, { address = null, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const recipe = proof && ISSUER_LISTS[proof.issuer]
  if (!recipe || !proof.addresses_sha256 || proof.reproduce == null) return { status: 'no_recipe', address_in_issuer_list: null, issuer_sha256: null }
  let list
  try {
    const r = await fetchImpl(recipe.url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', 'user-agent': `proofofstock-guard/${VERSION}` } })
    if (!r.ok) return { status: 'issuer_unavailable', address_in_issuer_list: null, issuer_sha256: null }
    list = recipe.addresses(await r.json())
  } catch (_) { return { status: 'issuer_unavailable', address_in_issuer_list: null, issuer_sha256: null } }
  if (!list) return { status: 'no_recipe', address_in_issuer_list: null, issuer_sha256: null }
  const sha = await addressesSha256(list)
  const on = address ? list.some((a) => String(a).toLowerCase() === String(address).toLowerCase()) : null
  return { status: sha === proof.addresses_sha256 ? 'match' : 'list_changed', address_in_issuer_list: on, issuer_sha256: sha }
}

// Coinbase's symbols carry a trailing "c" (NVDAc); Robinhood's are the bare ticker (NVDA). A claim of either is the same.
// ⚠ AN ANSWER IS CHECKED BEFORE IT IS BELIEVED. A buy is allowed on `listed === true` for the address asked about, never
// on a truthy field or an answer about another contract; anything malformed is "could not check", like an outage.
const malformed = (b, address) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'the answer is not an object'
  if (typeof b.listed !== 'boolean') return 'listed is not true or false'
  if (String(b.address || '').toLowerCase() !== address) return 'the answer is about another address'
  if (!Array.isArray(b.registries_checked) || !b.registries_checked.every((r) => typeof r === 'string')) return 'registries_checked is missing'
  if (b.listed && typeof b.symbol !== 'string') return 'a listed answer has no symbol'
  if (b.impostor != null && typeof b.impostor !== 'object') return 'impostor is not an object'
  return null
}
const ticker = (s) => { const t = String(s || '').trim(); return (/^[A-Z0-9.]+c$/.test(t) ? t.slice(0, -1) : t).toUpperCase() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} [o]
 * @param {string} [o.endpoint]         the passport site (default https://proofofstock.xyz)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.timeoutMs]        per request (default 8000)
 * @param {boolean} [o.failOpen]        allow a buy when the registry cannot be read (default false)
 * @param {number} [o.maxRegistryAgeS]  a listed answer from a list read longer ago than this is unknown (default 900)
 * @param {boolean} [o.crossCheck]      also read the issuer's own list and require the address on it (default false: it
 *                                      doubles the latency and calls the issuer's API)
 */
export function createGuard ({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 8000, failOpen = false, maxRegistryAgeS = 900, crossCheck = false, retryDelayMs = 500 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available: pass fetchImpl')
  const base = endpoint.replace(/\/+$/, '')
  const headers = { accept: 'application/json', 'user-agent': `proofofstock-guard/${VERSION}` }

  // One retry, on a network error or a 503 only: a 429 means the caller is over the limit, and asking again makes it worse.
  async function get (url) {
    for (let attempt = 0; ; attempt++) {
      let r
      try { r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers }) } catch (e) {
        if (attempt === 0) { await sleep(retryDelayMs); continue }
        return { status: 'error', http: null, body: { error: String(e && e.message || e) } }
      }
      const body = await r.json().catch(() => null)
      if (r.status === 503 && attempt === 0) { await sleep(retryDelayMs); continue }
      return { status: r.status === 200 && body ? 'ok' : r.status === 503 ? 'unavailable' : 'error', http: r.status, body: body || { error: `HTTP ${r.status}` } }
    }
  }

  /** The raw verify answer: { status: 'ok'|'unavailable'|'error', body }. Throws on a chain or address that cannot be. */
  async function verify (chain, address) {
    if (!CHAINS.has(chain)) throw new Error(`chain must be base or robinhood, not ${chain}`)
    if (!ADDRESS.test(String(address))) throw new Error('address must be 0x followed by 40 hex characters')
    const a = String(address).toLowerCase()
    const g = await get(`${base}/verify?chain=${chain}&address=${a}`)
    if (g.status !== 'ok') return { status: g.status, body: g.body }
    const bad = malformed(g.body, a)
    return bad ? { status: 'error', body: { error: `malformed answer: ${bad}` } } : { status: 'ok', body: g.body }
  }

  /** Up to any number of addresses, asked MAX_BATCH at a time: { status, body: { results, list_proofs } }. Throws on bad input. */
  async function verifyMany (chain, addresses) {
    if (!CHAINS.has(chain)) throw new Error(`chain must be base or robinhood, not ${chain}`)
    if (!Array.isArray(addresses) || !addresses.length) throw new Error('addresses must be a non-empty list')
    const bad = addresses.findIndex((x) => !ADDRESS.test(String(x)))
    if (bad >= 0) throw new Error(`addresses[${bad}] must be 0x followed by 40 hex characters`)
    const results = [], proofs = []
    for (let i = 0; i < addresses.length; i += MAX_BATCH) {
      const part = addresses.slice(i, i + MAX_BATCH).map((x) => String(x).toLowerCase())
      const g = await get(`${base}/verify?chain=${chain}&addresses=${part.join(',')}`)
      if (g.status !== 'ok') return { status: g.status, body: g.body }
      const rs = g.body.results
      if (!Array.isArray(rs) || rs.length !== part.length) return { status: 'error', body: { error: 'malformed answer: results do not match the addresses asked' } }
      for (let k = 0; k < part.length; k++) {
        const m = malformed(rs[k], part[k])
        if (m) return { status: 'error', body: { error: `malformed answer for ${part[k]}: ${m}` } }
        results.push({ ...rs[k], list_proof: g.body.list_proof ?? null })
      }
      proofs.push(g.body.list_proof ?? null)
    }
    return { status: 'ok', body: { results, list_proofs: proofs } }
  }

  // A verify answer (with its list_proof) into the decision.
  async function decide (b, { chain, tokenAddress, claimedSymbol }) {
    if (b.listed) {
      if (claimedSymbol && ticker(claimedSymbol) !== ticker(b.symbol)) {
        return { allow: false, decision: 'wrong_stock', reason: `${tokenAddress} is the issuer-listed ${b.symbol}, not ${claimedSymbol}. Check which stock was meant.`, use_instead: null, verify: b }
      }
      const p = b.list_proof
      const unknown = (why) => ({ allow: failOpen, decision: 'unknown', reason: `${tokenAddress} is listed, but ${why}. ${failOpen ? 'Allowed because failOpen is set.' : 'Not buying on an answer that cannot be checked.'}`, use_instead: null, verify: b })
      if (!p || !p.addresses_sha256) return unknown('the answer carries no list_proof')
      if (p?.stale) return unknown('the server could not read the issuer list lately (list_proof.stale)')
      const age = Number.isFinite(b.registry_age_s) ? b.registry_age_s : (p?.read_at ? Math.round((Date.now() - Date.parse(p.read_at)) / 1000) : null)
      if (age == null || age > maxRegistryAgeS) return unknown(`the issuer list was read ${age == null ? 'at an unknown time' : age + ' s ago'}, more than ${maxRegistryAgeS} s`)
      if (crossCheck) {
        const c = await checkListProof(p, { address: tokenAddress, fetchImpl, timeoutMs })
        if (c.address_in_issuer_list !== true) return { ...unknown(`the issuer's own list did not confirm it (${c.status})`), cross_check: c }
        return { allow: true, decision: 'listed', reason: `${b.symbol} at ${b.address} is on the ${b.registries_checked.join(', ')} registry, confirmed against the issuer's own list (${c.status}).`, use_instead: null, verify: b, cross_check: c }
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

  const invalid = (why) => ({ allow: false, decision: 'invalid_input', reason: why, use_instead: null, verify: null })
  const couldNot = (tokenAddress, chain, v) => ({ allow: failOpen, decision: 'unknown', reason: `Could not check ${tokenAddress} on ${chain} (${v.body && v.body.error || v.status}). ${failOpen ? 'Allowed because failOpen is set.' : 'Not buying a token that could not be checked.'}`, use_instead: null, verify: v.body })

  /**
   * The decision before a buy. Never throws.
   * @param {object} p
   * @param {'base'|'robinhood'} p.chain
   * @param {string} p.tokenAddress     the contract the agent is about to buy
   * @param {string} [p.claimedSymbol]  what the user asked for (NVDA, TSLAc, ...): a listed token of ANOTHER stock is refused too
   */
  async function beforeBuy ({ chain, tokenAddress, claimedSymbol } = {}) {
    if (!CHAINS.has(chain)) return invalid(`chain must be base or robinhood, not ${String(chain)}`)
    if (!ADDRESS.test(String(tokenAddress))) return invalid('tokenAddress must be 0x followed by 40 hex characters')
    const v = await verify(chain, tokenAddress)
    if (v.status !== 'ok') return couldNot(tokenAddress, chain, v)
    return decide(v.body, { chain, tokenAddress, claimedSymbol })
  }

  /** beforeBuy for several tokens of one chain, asked in batches. Never throws; one decision per input, in order. */
  async function beforeBuyMany (chain, tokens) {
    if (!CHAINS.has(chain)) return (tokens || []).map(() => invalid(`chain must be base or robinhood, not ${String(chain)}`))
    const list = Array.isArray(tokens) ? tokens : []
    const okIdx = list.map((t, i) => (ADDRESS.test(String(t && t.tokenAddress)) ? i : -1)).filter((i) => i >= 0)
    const out = list.map(() => invalid('tokenAddress must be 0x followed by 40 hex characters'))
    if (!okIdx.length) return out
    const v = await verifyMany(chain, okIdx.map((i) => list[i].tokenAddress))
    for (let k = 0; k < okIdx.length; k++) {
      const t = list[okIdx[k]]
      out[okIdx[k]] = v.status !== 'ok' ? couldNot(t.tokenAddress, chain, v) : await decide(v.body.results[k], { chain, tokenAddress: t.tokenAddress, claimedSymbol: t.claimedSymbol })
    }
    return out
  }

  return { verify, verifyMany, beforeBuy, beforeBuyMany }
}
