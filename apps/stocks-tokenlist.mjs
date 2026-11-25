// apps/stocks-tokenlist.mjs: the issuer-listed stock tokens as a token list in the Uniswap Token Lists format
// (https://tokenlists.org), served at /tokenlist.json for wallets and DEX front ends to import.
//
// What is in it: every token that is on its issuer's own published list for that chain AND trades in a pool on that
// chain, so its decimals are known from the chain (the recorder's pool book). A listed token with no pool cannot be
// bought on a DEX, and a token list entry without decimals is not a token list entry.
//
// What is never in it: impostors. A token list is a list of tokens to SHOW: a wallet that imports it adds every entry to
// its token picker. A list of fakes in this format would put the fakes in front of people. Impostors stay at
// /api/impostors, a JSON of warnings, in no format a wallet imports as tokens.
//
// It is built only from issuer lists read within the freshness window (the rule every verdict keeps): the server
// answers 503 rather than a list built from an old copy, so a wallet never shows "listed" from a stale read.

import { checksumAddress } from '../evm/core/stocks/evm-tx.mjs'

export const TOKEN_LIST_PATH = '/tokenlist.json'
export const TOKEN_LIST_NAME = 'Proof of Stock issuer listed'

// The schema's limits (https://uniswap.org/tokenlist.schema.json, v2): a token's name is 1-40 characters of a fixed set,
// a symbol 1-20 of another, a list name 1-30 word characters and spaces.
const NAME_RE = /^[ \w.'+\-%/À-ÖØ-öø-ÿ:&[\]()]+$/
const SYMBOL_RE = /^[a-zA-Z0-9+\-%/$.]+$/
const LIST_NAME_RE = /^[\w ]+$/
const KEYWORD_RE = /^[\w ]+$/
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const EXT_KEY_RE = /^[\w]+$/

/**
 * An issuer's token name, fitted to the schema: the bullet and comma the issuers write become a dash and nothing,
 * a curly apostrophe a straight one, any other character outside the set is dropped, and a name over 40 characters is
 * cut at a word. Empty after that: the symbol stands in.
 */
export function cleanName (name, symbol) {
  let s = String(name ?? '').normalize('NFC')
    .replace(/\s*•\s*/g, ' - ').replace(/,/g, '').replace(/[‘’]/g, "'")
  s = [...s].filter((ch) => NAME_RE.test(ch)).join('').replace(/\s+/g, ' ').trim()
  if (s.length > 40) {
    const cut = s.slice(0, 41)
    const sp = cut.lastIndexOf(' ')
    s = (sp > 10 ? cut.slice(0, sp) : s.slice(0, 40)).replace(/[\s\-:&/(]+$/, '').trim()
  }
  return s || String(symbol ?? '').slice(0, 40)
}

/** UTC days since 1970: the list's minor version. */
const dayOf = (ms) => Math.floor(ms / 86400e3)

/**
 * @param {{ chains: Array<{ chainId: number, issuer: string, records: Array<object>, decimals: Map<string, number> }>,
 *           at: number, logoURI?: string|null }} o
 *   `at`: when the oldest of these issuer lists was read (ms). It is the list's timestamp, and its version: the minor is
 *   the UTC day and the patch the minute of that day, so a client sees a newer version after every read.
 */
export function buildTokenList ({ chains, at, logoURI = null }) {
  const tokens = []
  for (const c of chains) {
    for (const r of c.records) {
      const a = String(r.address || '').toLowerCase()
      const d = c.decimals.get(a)
      if (!ADDRESS_RE.test(a) || !Number.isInteger(d) || d < 0 || d > 255) continue
      const symbol = String(r.symbol || '')
      if (!symbol || symbol.length > 20 || !SYMBOL_RE.test(symbol)) continue
      const extensions = { issuer: c.issuer }
      if (r.isin) extensions.isin = String(r.isin)
      if (Number.isFinite(r.multiplier)) extensions.multiplier = r.multiplier
      tokens.push({ chainId: c.chainId, address: checksumAddress(a), name: cleanName(r.name, symbol), symbol, decimals: d, extensions })
    }
  }
  tokens.sort((x, y) => x.chainId - y.chainId || x.symbol.localeCompare(y.symbol) || x.address.localeCompare(y.address))
  const list = {
    name: TOKEN_LIST_NAME,
    timestamp: new Date(at).toISOString(),
    version: { major: 1, minor: dayOf(at), patch: Math.floor((at % 86400e3) / 60e3) },
    keywords: ['tokenized stocks', 'issuer listed', 'rwa'],
    tokens,
  }
  if (logoURI) list.logoURI = logoURI
  return list
}

/**
 * The schema's rules this list must keep, checked here rather than trusted: every problem as a sentence, [] when none.
 * A wallet that validates the list (most do) drops it whole on one bad entry.
 */
export function tokenListProblems (list) {
  const out = []
  if (!list || typeof list !== 'object') return ['not an object']
  const allowed = new Set(['name', 'timestamp', 'version', 'tokens', 'keywords', 'tags', 'logoURI', 'tokenMap'])
  for (const k of Object.keys(list)) if (!allowed.has(k)) out.push(`unknown top-level key ${k}`)
  if (typeof list.name !== 'string' || list.name.length < 1 || list.name.length > 30 || !LIST_NAME_RE.test(list.name)) out.push('name')
  if (typeof list.timestamp !== 'string' || Number.isNaN(Date.parse(list.timestamp))) out.push('timestamp')
  const v = list.version || {}
  if (!['major', 'minor', 'patch'].every((k) => Number.isInteger(v[k]) && v[k] >= 0)) out.push('version')
  if (list.keywords && (!Array.isArray(list.keywords) || list.keywords.length > 20 || !list.keywords.every((k) => typeof k === 'string' && k.length >= 1 && k.length <= 20 && KEYWORD_RE.test(k)))) out.push('keywords')
  if (list.logoURI != null && !/^(https|ipfs|ipns):\/\//.test(list.logoURI)) out.push('logoURI')
  if (!Array.isArray(list.tokens) || list.tokens.length < 1 || list.tokens.length > 10000) { out.push('tokens: 1 to 10000'); return out }
  const seen = new Set()
  list.tokens.forEach((t, i) => {
    const at = `tokens[${i}]`
    const keys = new Set(['chainId', 'address', 'name', 'symbol', 'decimals', 'logoURI', 'tags', 'extensions'])
    for (const k of Object.keys(t)) if (!keys.has(k)) out.push(`${at}: unknown key ${k}`)
    if (!Number.isInteger(t.chainId) || t.chainId < 1) out.push(`${at}.chainId`)
    if (typeof t.address !== 'string' || !ADDRESS_RE.test(t.address) || checksumAddress(t.address.toLowerCase()) !== t.address) out.push(`${at}.address`)
    if (typeof t.name !== 'string' || t.name.length < 1 || t.name.length > 40 || !NAME_RE.test(t.name)) out.push(`${at}.name`)
    if (typeof t.symbol !== 'string' || t.symbol.length < 1 || t.symbol.length > 20 || !SYMBOL_RE.test(t.symbol)) out.push(`${at}.symbol`)
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255) out.push(`${at}.decimals`)
    if (t.extensions != null) {
      const e = Object.entries(t.extensions)
      if (e.length > 10 || !e.every(([k, x]) => EXT_KEY_RE.test(k) && k.length <= 40 && (x === null || ['string', 'number', 'boolean'].includes(typeof x)) && (typeof x !== 'string' || x.length <= 42))) out.push(`${at}.extensions`)
    }
    const key = `${t.chainId}:${String(t.address).toLowerCase()}`
    if (seen.has(key)) out.push(`${at}: duplicate ${key}`)
    seen.add(key)
  })
  return out
}
