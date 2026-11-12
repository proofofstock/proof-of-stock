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

/**
 * Check a receipt: its own hash, the frozen list's hash, and the verdict re-derived from that list.
 * @returns {Promise<{ ok: boolean, checks: Array<{ check: string, ok: boolean, detail: string }> }>}
 */
export async function checkReceipt (r, { fetchImpl = fetch } = {}) {
  const checks = []
  const add = (check, ok, detail) => checks.push({ check, ok: Boolean(ok), detail })
  if (!r || r.format !== RECEIPT_FORMAT) { add('format', false, `not a ${RECEIPT_FORMAT} receipt`); return { ok: false, checks } }
  add('receipt hash', receiptHash(r) === r.sha256, receiptHash(r) === r.sha256 ? 'the receipt is as it was issued' : 'the receipt was changed after it was issued')
  let text = null
  try {
    const res = await fetchImpl(r.list.addresses_url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    text = await res.text()
  } catch (e) { add('frozen list', false, 'could not fetch ' + r.list.addresses_url + ': ' + String(e && e.message || e).slice(0, 80)) }
  if (text != null) {
    const got = sha256(text)
    add('frozen list hash', got === r.list.addresses_sha256, got === r.list.addresses_sha256 ? `the list fetched is the one named (${got.slice(0, 12)}...)` : `the list fetched hashes to ${got.slice(0, 12)}..., not ${String(r.list.addresses_sha256).slice(0, 12)}...`)
    if (got === r.list.addresses_sha256) {
      const lines = text.split('\n').filter(Boolean)
      const inList = lines.includes(String(r.address).toLowerCase())
      add('verdict', inList === r.listed, `${r.address} is ${inList ? '' : 'not '}in that list of ${lines.length}, and the receipt says ${r.listed ? 'listed' : 'not listed'}`)
    }
  }
  return { ok: checks.every((c) => c.ok), checks }
}
