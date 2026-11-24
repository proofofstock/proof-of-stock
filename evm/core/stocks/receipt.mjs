// evm/core/stocks/receipt.mjs: a receipt of one check, to keep. A wallet or an agent that showed a user a warning (or
// let a buy through) can store this, and months later prove why: which list was used, by which rule, and what it said.
//
// The receipt names the issuer list by the SHA-256 of its sorted addresses, and the URL of that exact list frozen
// (/api/list/<registry_hash>/addresses, kept in the history archive). So the verdict can be re-derived later from that
// frozen list, even after the issuer's current list has changed: scripts/receipt-check.mjs does it with nothing of ours
// but the frozen list's bytes, whose hash it checks first. The receipt's own SHA-256 covers every other field, so a
// stored receipt that was edited shows. Our daily anchors (/anchors/) put the archive's files in Bitcoin's timeline.
// No signature and no key: what makes it checkable is the hashes, not trust in us.
import crypto from 'node:crypto'

export const RECEIPT_FORMAT = 'proofofstock-receipt/1'
export const VERIFY_RULE = 'listed: the exact contract address (lower case) is one of the addresses of the issuer list named by list.addresses_sha256. impostor: not listed, and its symbol or name copies a listed token or the issuer\'s naming. not_listed: neither.'

/** JSON with object keys sorted at every level: the bytes the receipt's hash is taken over. */
export function canonical (v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
export function receiptHash (r) { const { sha256: _, ...rest } = r; return sha256(canonical(rest)) }

/** A receipt from a /verify answer body and its list_proof; null when there is no list proof to name. */
export function makeReceipt ({ body, proof, appVersion, at }) {
  if (!proof || !proof.addresses_sha256 || !proof.addresses_url) return null
  const r = {
    format: RECEIPT_FORMAT,
    issued_at: new Date(at).toISOString(),
    rule: { verify: VERIFY_RULE, app_version: String(appVersion) },
    chain: body.chain,
    address: body.address,
    verdict: body.listed ? 'listed' : body.impostor ? 'impostor' : 'not_listed',
    listed: Boolean(body.listed),
    symbol: body.symbol ?? null,
    impostor: body.impostor ?? null,
    list: { issuer: proof.issuer, addresses: proof.addresses, addresses_sha256: proof.addresses_sha256, addresses_url: proof.addresses_url, list_url: proof.list_url ?? null, read_at: proof.read_at ?? null, stale: Boolean(proof.stale) },
    issuer_factory: body.issuer_factory ?? null,
  }
  r.sha256 = receiptHash(r)
  return r
}

// The archive a receipt can be checked against. A self-hosted instance passes its own through `origins`.
export const LIST_ORIGINS = Object.freeze(['https://proofofstock.xyz'])
// What a receipt may say, and the header our archive names a frozen list's chain by (the body is the hashed list, so the
// chain cannot ride inside it). Outside review, 24.11: a receipt that pointed at another chain's list, or that said
// "impostor" while its own listed field said otherwise, was printed as holding.
export const RECEIPT_CHAINS = Object.freeze(['base', 'robinhood'])
export const LIST_CHAIN_HEADER = 'x-pos-chain'
const RECEIPT_ADDRESS = /^0x[0-9a-f]{40}$/
const VERDICTS = Object.freeze(['listed', 'impostor', 'not_listed'])
const FROZEN_PATH = /^\/api\/list\/[0-9a-f]{64}\/addresses$/
/** Whether a URL is served by one of those origins, over https, with no credentials and no port games. */
export function isOurs (url, origins = LIST_ORIGINS) {
  let u
  try { u = new URL(String(url)) } catch (_) { return false }
  return u.protocol === 'https:' && !u.username && !u.password && origins.includes(u.origin)
}

/**
 * Check a receipt: its own hash, the frozen list's hash, and the verdict re-derived from that list.
 * @returns {Promise<{ ok: boolean, checks: Array<{ check: string, ok: boolean, detail: string }> }>}
 */
export async function checkReceipt (r, { fetchImpl = fetch, origins = LIST_ORIGINS } = {}) {
  const checks = []
  const add = (check, ok, detail) => checks.push({ check, ok: Boolean(ok), detail })
  if (!r || r.format !== RECEIPT_FORMAT) { add('format', false, `not a ${RECEIPT_FORMAT} receipt`); return { ok: false, checks } }
  add('receipt hash', receiptHash(r) === r.sha256, receiptHash(r) === r.sha256 ? 'the receipt is as it was issued' : 'the receipt was changed after it was issued')
  // The fields a reader is told about must be well-formed and agree with each other before anything is printed from them:
  // a free-form address, chain or verdict once reached the "The receipt holds:" line as written by whoever made it.
  const fieldsOk = RECEIPT_ADDRESS.test(String(r.address)) && RECEIPT_CHAINS.includes(r.chain) && VERDICTS.includes(r.verdict) &&
    typeof r.listed === 'boolean' && (r.verdict === 'listed') === r.listed && (r.verdict === 'impostor') === (r.impostor != null)
  add('fields', fieldsOk, fieldsOk ? 'the address, the chain and the verdict are well-formed and agree with each other' : 'the address, chain or verdict is malformed, or the verdict contradicts listed or impostor')
  if (!fieldsOk) return { ok: false, checks }
  // ⚠ THE LIST URL IS TAKEN FROM THE RECEIPT, AND A RECEIPT IS A FILE SOMEBODY HANDED YOU. Its own hash proves only
  // that it was not edited after whoever made it made it: anyone can write a receipt, serve a list that hashes to
  // what it claims, and recompute the receipt's hash. The one thing that ties it to us is WHERE that list is served
  // from, so the origin is pinned here. Without this, `receipt-check` printed "The receipt holds" over an impostor's
  // own bytes, and fetched the author's URL from the reader's machine while it was at it (audit, 14.11).
  if (!isOurs(r.list && r.list.addresses_url, origins) || !FROZEN_PATH.test(new URL(String(r.list.addresses_url)).pathname)) {
    add('frozen list', false, `${String(r.list && r.list.addresses_url).slice(0, 80)} is not our archive: a receipt can only be checked against ${origins.join(' or ')}`)
    return { ok: false, checks }
  }
  let text = null
  try {
    // `redirect: 'error'`, because fetch follows redirects by default and the pin above only sees the first hop: one
    // redirect on our own origin, now or in some future configuration, would otherwise serve the "frozen list" from
    // anywhere at all, which is exactly what the pin exists to stop (review, 14.11).
    const res = await fetchImpl(r.list.addresses_url, { signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    text = await res.text()
    // The chain our archive says this list is from: a Robinhood list cannot stand behind a Base verdict.
    const listChain = res.headers && typeof res.headers.get === 'function' ? res.headers.get(LIST_CHAIN_HEADER) : null
    add('list chain', listChain === r.chain, listChain === r.chain ? `the archive serves this list as ${r.chain}'s` : `the archive serves this list as ${String(listChain).slice(0, 20)}'s, not ${r.chain}'s`)
  } catch (e) { add('frozen list', false, 'could not fetch ' + r.list.addresses_url + ': ' + String(e && e.message || e).slice(0, 80)) }
  if (text != null) {
    const got = sha256(text)
    add('frozen list hash', got === r.list.addresses_sha256, got === r.list.addresses_sha256 ? `the list fetched is the one named (${got.slice(0, 12)}...)` : `the list fetched hashes to ${got.slice(0, 12)}..., not ${String(r.list.addresses_sha256).slice(0, 12)}...`)
    if (got === r.list.addresses_sha256) {
      const lines = text.split('\n').filter(Boolean)
      const inList = lines.includes(String(r.address).toLowerCase())
      add('verdict', inList === r.listed, `${r.address} is ${inList ? '' : 'not '}in that list of ${lines.length}, and the receipt says ${r.listed ? 'listed' : 'not listed'}`)
      // What the list can show is listed or not. "Impostor" is the service's own finding at issued_at (the symbol or
      // name copied a listed token), so it is said as that, never as something this check re-derived.
      if (r.verdict === 'impostor') add('impostor', true, 'the impostor flag is the service\'s own finding at issued_at; the list shows only that the address was not on it')
    }
  }
  return { ok: checks.every((c) => c.ok), checks }
}
