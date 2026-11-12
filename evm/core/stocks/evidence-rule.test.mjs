// evm/core/stocks/evidence-rule.test.mjs: the checker finds a claim without its evidence, and passes one with it.
//
// Run: node evm/core/stocks/evidence-rule.test.mjs
import { evidenceViolations, RULES } from './evidence-rule.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const proof = { addresses_sha256: 'a'.repeat(64) }

check('the rules name each claim, its evidence and what is said without it', RULES.length >= 2 && RULES.every((r) => r.claim && r.evidence && r.without))
check('verify: listed with a proof, minted from Coinbase, passes', evidenceViolations('verify', { listed: true, list_proof: proof, issuer: 'coinbase', minted: true }).length === 0)
check('verify: listed without a proof is a violation', evidenceViolations('verify', { listed: true, list_proof: null }).length === 1)
check('verify: not listed needs no proof', evidenceViolations('verify', { listed: false, list_proof: null }).length === 0)
check('verify: Robinhood minted true is a violation, null is not', evidenceViolations('verify', { listed: true, list_proof: proof, issuer: 'robinhood', minted: true }).length === 1 && evidenceViolations('verify', { listed: true, list_proof: proof, issuer: 'robinhood', minted: null }).length === 0)
check('passport: in_registry without a proof, and Robinhood minted true, are two violations', evidenceViolations('passport', { in_registry: true, issuer: { name: 'robinhood', minted: true } }).length === 2)
check('MCP verify: listed results need the batch proof; each result\'s minted is checked', evidenceViolations('mcp_verify', { listed: 1, list_proof: null, results: [{ issuer: 'robinhood', minted: true, address: '0x1' }] }).length === 2)
check('list: a Robinhood token marked minted, or a Robinhood minted count, is a violation', evidenceViolations('list', { issuer: 'robinhood', tokens: [{ minted: true }], minted: null }).length === 1 && evidenceViolations('list', { issuer: 'robinhood', tokens: [{ minted: null }], minted: 3 }).length === 1)
check('list: a Coinbase list with counts passes', evidenceViolations('list', { issuer: 'coinbase', tokens: [{ minted: true }, { minted: false }], minted: 1 }).length === 0)
check('an unknown kind or no answer is never a silent pass', evidenceViolations('other', {}).length === 1 && evidenceViolations('verify', null).length === 1)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
