// evm/core/stocks/list-proof.mjs: what a "listed" verdict was decided against, in a form anyone can check again.
//
// The issuer lists are JSON from the issuers' APIs, not chain state: there is no block number to cite, and the raw bytes
// change every few minutes because prices ride in the same body. What does not change while the issuer keeps the same
// tokens is the SET OF ADDRESSES. So each read of a list is stamped with:
//
//   addresses_sha256  SHA-256 of the list's contract addresses, lowercase, sorted bytewise, one per line, each line ending
//                     in "\n". The `reproduce` command computes the same digest from the issuer's API with curl, jq, tr,
//                     sort and sha256sum: while the issuer's list is unchanged, the two match.
//   registry_hash     the canonical-registry hash (evm/core/stocks/history.mjs registryHash: address, symbol, name, ISIN,
//                     multiplier, supplied, paused), the same hash the archive's /api/history/registry rows carry, each
//                     row naming the one before it (prev_hash).
//
// ⚠ THE RECIPE MUST MIRROR THE READER (evm/core/stocks/registries.mjs): every Coinbase token on one page of 500, and for
// Robinhood the first deployment on this chain of each asset. A list that outgrows one Coinbase page gets no recipe
// rather than a wrong one. The recipes were run against both live APIs on 12.11.2026 and matched this code.
import crypto from 'node:crypto'
import { COINBASE_URL, ROBINHOOD_ASSETS_URL } from './registries.mjs'
import { canonicalRegistry, registryHash } from './history.mjs'

const COINBASE_PAGE = 500
// curl -f: an error page must fail, not hash as an empty list (e3b0c442...). tr -d '\r': jq on Windows ends lines in CRLF.
const TAIL = " | tr -d '\\r' | tr 'A-F' 'a-f' | LC_ALL=C sort | sha256sum"

/** SHA-256 hex of the addresses, lowercase, bytewise sorted, one per line. */
export function addressesSha256 (records) {
  const lines = records.map((r) => String(r.address).toLowerCase()).sort().map((a) => a + '\n').join('')
  return crypto.createHash('sha256').update(lines).digest('hex')
}

/** The source URL and the shell command that reproduce addresses_sha256 for an issuer's list, or null. */
// `pages`: how many pages the reader followed (registries.mjs sets it). The recipe reads one page, so it is offered only
// when the reader also needed one: a server that starts capping pages below 500 must not make an honest digest look wrong.
export function recipeFor (issuer, chainId, count, pages = null) {
  if (issuer === 'coinbase') {
    const url = `${COINBASE_URL}?page_size=${COINBASE_PAGE}`
    return (pages == null ? count < COINBASE_PAGE : pages === 1)
      ? { source: url, reproduce: `curl -fsS '${url}' | jq -r '.tokens[].contract_address'${TAIL}`, reproduce_unavailable: null }
      : { source: url, reproduce: null, reproduce_unavailable: 'the list spans more than one page; follow next_page_token' }
  }
  if (issuer === 'robinhood' && Number.isInteger(chainId)) {
    return { source: ROBINHOOD_ASSETS_URL, reproduce_unavailable: null, reproduce: `curl -fsS '${ROBINHOOD_ASSETS_URL}' | jq -r '.assets[] | first(.deployments[]? | select((.chainId|tostring) == "${chainId}")) | .contractAddress'${TAIL}` }
  }
  return { source: null, reproduce: null, reproduce_unavailable: 'no recipe for this issuer' }
}

/**
 * The exact bytes registry_hash names (JSON of the canonical list) and the address lines addresses_sha256 names, for
 * GET /api/list/<hex>. Returns null unless the bytes hash to the name asked: a server never serves a list under a hash
 * it does not have.
 */
export function listBytes (canonicalBody, hex) {
  const body = JSON.stringify(canonicalBody)
  if (crypto.createHash('sha256').update(body).digest('hex') !== hex) return null
  const addresses = canonicalBody.map((r) => String(r.address).toLowerCase()).sort().map((a) => a + '\n').join('')
  return { body, addresses }
}

/** The stamp for one read of one list. Computed once per read, not per answer. */
export function stampList ({ issuer, chainId, records }) {
  const { source, reproduce, reproduce_unavailable } = recipeFor(issuer, chainId, records.length, records.pages ?? null)
  return { issuer, source, addresses: records.length, addresses_sha256: addressesSha256(records), registry_hash: registryHash(canonicalRegistry(records)), reproduce, reproduce_unavailable }
}

// ⚠ SAY ONLY WHAT HOLDS. This server reads the lists every 5 minutes; the archive at `ledger` is written by the price
//   recorder's own read every 15. The same list has the same registry_hash in both, but a list this server just read may
//   not be in the archive yet, so the note says "once", never "matches".
export const PROOF_NOTE = 'Decided against this list as read at read_at. Run `reproduce` to compute addresses_sha256 from the issuer yourself (on macOS use shasum -a 256): equal while the issuer\'s list is unchanged. registry_hash is the canonical hash the archive at `ledger` records for each list the price recorder reads (every 15 minutes), so this list appears there with the same hash once the recorder has read it. stale: true means the latest read failed and this is the last good list. list_url serves the exact list this verdict used, by its hash, after the issuer\'s list has changed too (curl it and sha256sum: the digest is registry_hash); addresses_url serves its addresses, whose digest is addresses_sha256.'

/** The proof an answer carries: the stamp, when the list was read, whether it is the last good one, and the archive. */
export function listProof (stamp, { readAt, ledgerUrl, listBase = null, stale = false }) {
  if (!stamp) return null
  const hex = stamp.registry_hash.slice('sha256:'.length)
  return { ...stamp, read_at: Number.isFinite(readAt) ? new Date(readAt).toISOString() : null, stale: !!stale, ledger: ledgerUrl,
    list_url: listBase ? `${listBase}/${hex}` : null, addresses_url: listBase ? `${listBase}/${hex}/addresses` : null, note: PROOF_NOTE }
}
