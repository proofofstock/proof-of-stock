// evm/core/stocks/verify.mjs: the one-bit answer: is this address on the issuer's own list for this chain? And the
// badge that carries that answer into other people's pages (docs/stocks-truth-layer-tz.md, W1).
//
// Pure. It is handed the registry records the site holds, when they were read, the impostor entry for the address if
// there is one, and the time. It fetches nothing.
//
// ⚠ THE ADDRESS DECIDES, NOTHING ELSE. `listed` is true only when the exact address is in the registry. A symbol, a
// name or a vanity prefix never makes a token listed, and a token outside the registry is "not in the registry",
// never "fake": it may be a genuine token of another issuer this site does not cover.
// ⚠ A REGISTRY WE COULD NOT READ IS NO ANSWER. Past REGISTRY_FRESH_S the result is `unavailable`, never `listed:false`:
// a false "not listed" from an old copy would accuse a token we simply failed to look up.
import { mintedOf } from './registries.mjs'

export const REGISTRY_FRESH_S = 900
// Only these kinds are called impostors on a badge: the token copies an issuer-listed symbol, or the issuer's own way of
// naming its tokens. Borrowing a bare ticker is common and is not an accusation (evm/core/stocks/impostor.mjs).
export const IMPOSTOR_KINDS = Object.freeze(['registry_symbol', 'issuer_name_suffix', 'registry_name'])
export const ISSUER_LABEL = Object.freeze({ coinbase: 'Coinbase', robinhood: 'Robinhood' })

const ADDRESS = /^0x[0-9a-f]{40}$/

/**
 * @param {object} p
 * @param {string} p.chain            'base' | 'robinhood'
 * @param {string} p.issuer           the issuer whose registry this chain uses
 * @param {string} p.address
 * @param {object[]|null} p.records   the registry, or null when it was never read
 * @param {number|null} p.registryAt  when the records were read (ms)
 * @param {number} p.now
 * @param {object|null} [p.impostor]  the impostor-list entry for this address, if any
 * @param {Array<{chain:string, records:object[]}>} [p.otherChains]
 * @param {{at:number, symbol:string}|null} [p.delisted]  set when this address was listed and has left the registry
 * @returns {{ status: 'ok'|'unavailable'|'bad_address', body: object }}
 */
export function verifyToken ({ chain, issuer, address, records, registryAt, now, impostor = null, otherChains = [], delisted = null, freshS = REGISTRY_FRESH_S }) {
  const addr = String(address || '').toLowerCase()
  if (!ADDRESS.test(addr)) return { status: 'bad_address', body: { error: 'address must be 0x followed by 40 hex characters' } }
  const ageS = registryAt != null ? Math.max(0, Math.round((now - registryAt) / 1000)) : null
  const checked = `${issuer}:${chain}`
  if (!records || ageS == null || ageS > freshS) {
    return { status: 'unavailable', body: { error: 'registry unavailable', registries_checked: [checked], chain, address: addr, registry_age_s: ageS, checked_at: new Date(now).toISOString() } }
  }
  const rec = records.find((r) => r.address === addr) || null
  const elsewhere = rec ? null : (otherChains.map((o) => ({ chain: o.chain, r: (o.records || []).find((r) => r.address === addr) })).find((x) => x.r) || null)
  const strong = !rec && impostor && IMPOSTOR_KINDS.includes(impostor.kind)
  return {
    status: 'ok',
    body: {
      listed: Boolean(rec),
      registries_checked: [checked],
      chain,
      address: addr,
      issuer: rec ? issuer : null,
      symbol: rec ? rec.symbol : null,
      name: rec ? rec.name ?? null : null,
      isin: rec ? rec.isin ?? null : null,
      // Robinhood's API reports no supply, so its records all say supplied: true; that is not an answer.
      minted: mintedOf(rec),
      listed_on_other_chain: elsewhere ? { chain: elsewhere.chain, symbol: elsewhere.r.symbol } : null,
      impostor: strong ? { kinds: [impostor.kind], imitates_symbol: impostor.registry_symbol ?? null, listed_address: impostor.registry_address ?? null } : null,
      delisted_at: !rec && delisted ? new Date(delisted.at).toISOString() : null,
      registry_age_s: ageS,
      checked_at: new Date(now).toISOString(),
    },
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
const short = (a) => (ADDRESS.test(String(a)) ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const STATES = Object.freeze({
  listed: { fill: '#0b7a43', mark: '✓' },
  not_listed: { fill: '#4a5366', mark: '•' },
  impostor: { fill: '#b3261e', mark: '✗' },
  unavailable: { fill: '#8a6d1d', mark: '?' },
})

/** Which of the four badge states a verify result is. */
export function badgeState (result) {
  if (!result || result.status !== 'ok') return 'unavailable'
  const b = result.body
  return b.listed ? 'listed' : b.impostor ? 'impostor' : 'not_listed'
}

/**
 * The badge, as SVG text. It prints the address it vouches for and the time it was checked, so it cannot be lifted onto
 * a page about another token; it never shows a price. Every value is XML-escaped; there is no script and no link.
 */
export function badgeSvg (result, { address } = {}) {
  const state = badgeState(result)
  const b = result && result.body ? result.body : {}
  const addr = short(b.address || address)
  const head = state === 'listed' ? `Issuer-listed · ${b.symbol} · ${ISSUER_LABEL[b.issuer] || b.issuer}`
    : state === 'impostor' ? (b.impostor.imitates_symbol ? `Imitates ${b.impostor.imitates_symbol}` : 'Copies the issuer\'s naming')
      : state === 'not_listed' ? `Not in the ${(b.registries_checked || []).map((x) => ISSUER_LABEL[x.split(':')[0]] || x).join(' / ')} registry`
        : 'Registry unavailable'
  const foot = `${addr}${b.checked_at ? ' · checked ' + b.checked_at.slice(0, 16).replace('T', ' ') + 'Z' : ''} · proofofstock.xyz`
  const s = STATES[state]
  const w = Math.max(220, Math.ceil(Math.max(head.length * 7.2, foot.length * 5.9)) + 44)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="40" viewBox="0 0 ${w} 40" role="img" aria-label="${esc(head + '. ' + foot)}">` +
    `<title>${esc(head + '. ' + foot)}</title>` +
    `<rect width="${w}" height="40" rx="7" fill="${s.fill}"/>` +
    `<text x="14" y="25" font-family="ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif" font-size="16" font-weight="700" fill="#fff">${esc(s.mark)}</text>` +
    `<text x="34" y="17" font-family="ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif" font-size="12.5" font-weight="600" fill="#fff">${esc(head)}</text>` +
    `<text x="34" y="31" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="10" fill="#ffffffcc">${esc(foot)}</text>` +
    '</svg>'
}
