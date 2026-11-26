// apps/stocks-denylist.mjs: every look-alike we flag RIGHT NOW, on both chains, as one file: /denylist.json.
//
// For wallets, DEX front ends, trackers and security APIs that want to warn before a swap without asking us per address
// (owner, 27.11: "free: the open look-alikes only"). The history, and a feed of what changed since a given time, are not
// here: they stay on request (hello@proofofstock.xyz).
//
// ⚠ IT IS NOT A TOKEN LIST. A wallet that imports a token list adds every entry to its token picker; a list of fakes in
//   that format would put the fakes in front of people. So this file has its own shape, says what it is in `warning`,
//   and carries no `tokens` array, no name, no logo and no decimals.
// ⚠ NO STRANGER'S TEXT. A look-alike's symbol and name are whatever its creator wrote, and the reader is often a
//   program or an agent. The file names a look-alike by its address and by the issuer's own symbol it copies; the
//   evidence link shows the rest, labelled, on our page.
// ⚠ A FLAG IS A CLAIM WITH EVIDENCE, NOT A VERDICT ON ITS CREATOR. The same rule as /api/impostors: published kinds only
//   (registry_symbol, issuer_name_suffix, registry_name), never a borrowed ticker alone.

export const DENYLIST_PATH = '/denylist.json'
export const DENYLIST_FORMAT = 'pos-denylist/1'
export const PUBLISHED_KINDS = Object.freeze(['registry_symbol', 'issuer_name_suffix', 'registry_name'])
export const DENYLIST_WARNING = 'Every address in this file is NOT the issuer\'s own stock token: it claims to be one by its symbol or name and is not on the issuer\'s list. Do not import these as tokens. A flag is a claim with evidence, not a verdict on whoever created the token.'
const HEX40 = /^0x[0-9a-f]{40}$/

/**
 * @param chains  [{ chain, chainId, generated_at, items: impostors.json items, listedAddressOf(addr) → issuer address or null }]
 * @param origin  the public origin, for the evidence links
 * @param at      when this file is answered (ISO)
 */
export function buildDenylist ({ chains, origin, at }) {
  const entries = []
  const counts = {}
  for (const c of chains) {
    let n = 0
    for (const i of c.items || []) {
      const address = String(i?.address || '').toLowerCase()
      if (!HEX40.test(address) || !PUBLISHED_KINDS.includes(i.kind)) continue
      const issuer = c.listedAddressOf ? c.listedAddressOf(i.registry_address) : null
      entries.push({
        chain: c.chain,
        chainId: c.chainId,
        address,
        imitates: { symbol: typeof i.registry_symbol === 'string' ? i.registry_symbol : null, ticker: typeof i.ticker === 'string' ? i.ticker : null, issuer_address: issuer },
        kind: i.kind,
        first_seen_at: i.first_seen_at ?? null,
        evidence: `${origin}/?chain=${encodeURIComponent(c.chain)}&address=${address}`,
      })
      n++
    }
    counts[c.chain] = n
  }
  entries.sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : String(b.first_seen_at).localeCompare(String(a.first_seen_at))))
  return {
    format: DENYLIST_FORMAT,
    name: 'Proof of Stock look-alikes',
    warning: DENYLIST_WARNING,
    generated_at: at,
    // When each chain's list of flags was last computed (every 6 hours): a reader can tell an old list from a new one.
    sources: Object.fromEntries(chains.map((c) => [c.chain, { chainId: c.chainId, flagged_at: c.generated_at ?? null, count: counts[c.chain] }])),
    kinds: {
      registry_symbol: 'uses the issuer token\'s exact symbol',
      issuer_name_suffix: 'names itself the way the issuer names its tokens',
      registry_name: 'uses a listed company\'s whole name, backed by its symbol when the name is one word',
    },
    method: `${origin}/docs/explanation/methodology.md`,
    history: 'Only open flags are here. Closed cases, the dated archive and a feed of changes are available on request: hello@proofofstock.xyz',
    entries,
  }
}

/** What is wrong with a built denylist; empty when it is well formed. Every answer is checked before it is served. */
export function denylistProblems (d) {
  const p = []
  if (d?.format !== DENYLIST_FORMAT) p.push('format')
  if ('tokens' in (d || {})) p.push('a tokens array: this must never be importable as a token list')
  if (!Array.isArray(d?.entries)) return [...p, 'entries']
  const seen = new Set()
  for (const e of d.entries) {
    if (!HEX40.test(e.address)) p.push(`address ${e.address}`)
    if (!PUBLISHED_KINDS.includes(e.kind)) p.push(`kind ${e.kind}`)
    if ('name' in e || 'symbol' in e || 'logoURI' in e) p.push(`stranger text or token fields on ${e.address}`)
    const k = e.chain + ':' + e.address
    if (seen.has(k)) p.push(`duplicate ${k}`)
    seen.add(k)
  }
  return p
}
