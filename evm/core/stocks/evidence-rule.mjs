// evm/core/stocks/evidence-rule.mjs: no evidence, no claim. Every positive statement an answer makes must carry the
// field that lets a reader check it; where that field is missing, the statement is null, not true.
//
// RULES is the table docs/explanation/methodology.md shows ("Evidence rule"). evidenceViolations() checks one answer
// against it and returns what breaks the rule, in words; the tests run every kind of answer through it (and a mutation
// lock proves they notice). The price rows join when on-chain price evidence ships (spec 1.1, the pool work).
export const RULES = Object.freeze([
  { claim: 'listed / in_registry', evidence: 'list_proof', without: 'the verdict is not given (503)' },
  { claim: 'minted: true', evidence: 'the issuer\'s own supply field (Coinbase total_supply)', without: 'minted: null (Robinhood reports no supply)' },
])

const mintedOk = (issuer, minted) => minted !== true || issuer === 'coinbase'

/**
 * @param {'verify'|'passport'|'mcp_verify'|'list'} kind
 * @param {object} a the answer body (for MCP, structuredContent)
 * @returns {string[]} what breaks the rule; empty when nothing does
 */
export function evidenceViolations (kind, a) {
  const out = []
  if (!a || typeof a !== 'object') return ['no answer']
  if (kind === 'verify') {
    if (a.listed === true && !a.list_proof?.addresses_sha256) out.push('listed without list_proof')
    if (!mintedOk(a.issuer, a.minted)) out.push(`minted true without a supply read (${a.issuer})`)
  } else if (kind === 'passport') {
    if (a.in_registry === true && !a.list_proof?.addresses_sha256) out.push('in_registry without list_proof')
    if (a.issuer && !mintedOk(a.issuer.name, a.issuer.minted)) out.push(`issuer.minted true without a supply read (${a.issuer.name})`)
  } else if (kind === 'mcp_verify') {
    if (a.listed > 0 && !a.list_proof?.addresses_sha256) out.push('listed results without list_proof')
    for (const r of a.results || []) if (!mintedOk(r.issuer, r.minted)) out.push(`minted true without a supply read (${r.address})`)
  } else if (kind === 'list') {
    for (const t of a.tokens || []) if (!mintedOk(a.issuer, t.minted)) { out.push(`minted true without a supply read (${a.issuer})`); break }
    if (a.minted != null && !mintedOk(a.issuer, true)) out.push(`a minted count without a supply read (${a.issuer})`)
  } else out.push(`unknown kind ${kind}`)
  return out
}
