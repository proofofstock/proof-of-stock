// evm/core/stocks/verify.test.mjs: the address alone decides; an old registry is no answer; only a copied symbol or
// the issuer's naming is called an impostor; the badge prints the address it vouches for and nothing executable.
//
// Run: node evm/core/stocks/verify.test.mjs

import { verifyToken, badgeSvg, badgeState, REGISTRY_FRESH_S } from './verify.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}

const NOW = Date.parse('2026-11-10T12:00:00Z')
const LISTED = '0xb200000000000000000000397293cb8cda9a10c5', FAKE = '0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703'
const records = [{ issuer: 'coinbase', address: LISTED, symbol: 'SNDKc', name: 'Sandisk', isin: 'US80004C2008', supplied: true }]
const base = { chain: 'base', issuer: 'coinbase', records, registryAt: NOW - 120e3, now: NOW }

console.log('the answer')
{
  const ok = verifyToken({ ...base, address: LISTED })
  check('a registry address is listed, with its issuer and symbol', ok.status === 'ok' && ok.body.listed === true && ok.body.symbol === 'SNDKc' && ok.body.issuer === 'coinbase' && ok.body.minted === true)
  check('...and names the registry it checked and its age', ok.body.registries_checked[0] === 'coinbase:base' && ok.body.registry_age_s === 120)
  check('a mixed-case address is the same answer', verifyToken({ ...base, address: LISTED.toUpperCase().replace('0X', '0x') }).body.listed === true)
  const copy = verifyToken({ ...base, address: FAKE, impostor: { kind: 'registry_symbol', registry_symbol: 'SNDKc', registry_address: LISTED } })
  check('a token copying a listed symbol is not listed, and is named an impostor with the listed address', copy.body.listed === false && copy.body.impostor.imitates_symbol === 'SNDKc' && copy.body.impostor.listed_address === LISTED)
  // The symbol alone never makes a token listed: here the impostor even calls itself SNDKc.
  check('a token whose symbol equals a listed one is still not listed', copy.body.symbol === null)
  const borrow = verifyToken({ ...base, address: FAKE, impostor: { kind: 'ticker', registry_symbol: 'SNDKc', registry_address: LISTED } })
  check('reusing a bare ticker is not called an impostor', borrow.body.listed === false && borrow.body.impostor === null)
  const naming = verifyToken({ ...base, address: FAKE, impostor: { kind: 'issuer_name_suffix', registry_symbol: null, registry_address: null } })
  check('copying only the issuer naming is an impostor without a target', naming.body.impostor && naming.body.impostor.imitates_symbol === null)
  const other = verifyToken({ chain: 'robinhood', issuer: 'robinhood', records: [], registryAt: NOW, now: NOW, address: LISTED, otherChains: [{ chain: 'base', records }] })
  check('an address listed on the other chain says so', other.body.listed === false && other.body.listed_on_other_chain.chain === 'base' && other.body.listed_on_other_chain.symbol === 'SNDKc')
  const rh = verifyToken({ chain: 'robinhood', issuer: 'robinhood', records: [{ issuer: 'robinhood', address: FAKE, symbol: 'NVDA', supplied: true }], registryAt: NOW, now: NOW, address: FAKE })
  check('Robinhood reports no supply, so minted is null, not true', rh.body.listed === true && rh.body.minted === null)
  const gone = verifyToken({ ...base, records: [], address: LISTED, delisted: { at: NOW - 3600e3, symbol: 'SNDKc' } })
  check('a delisted address says when it left', gone.body.listed === false && gone.body.delisted_at === '2026-11-10T11:00:00.000Z')
  check('a junk address is refused', verifyToken({ ...base, address: 'nvda' }).status === 'bad_address')
}

console.log('a registry we could not read')
{
  const stale = verifyToken({ ...base, address: FAKE, registryAt: NOW - (REGISTRY_FRESH_S + 1) * 1000 })
  check('a registry older than the limit is unavailable, never "not listed"', stale.status === 'unavailable' && stale.body.listed === undefined, JSON.stringify(stale.body))
  check('a registry never read is unavailable', verifyToken({ ...base, address: FAKE, records: null, registryAt: null }).status === 'unavailable')
  check('at the limit it still answers', verifyToken({ ...base, address: FAKE, registryAt: NOW - REGISTRY_FRESH_S * 1000 }).status === 'ok')
}

console.log('the badge')
{
  const ok = badgeSvg(verifyToken({ ...base, address: LISTED }))
  check('a listed badge names the symbol and issuer and prints the short address', badgeState(verifyToken({ ...base, address: LISTED })) === 'listed' && ok.includes('Issuer-listed · SNDKc · Coinbase') && ok.includes('0xb200…10c5'))
  const fake = badgeSvg(verifyToken({ ...base, address: FAKE, impostor: { kind: 'registry_symbol', registry_symbol: 'SNDKc', registry_address: LISTED } }))
  check('an impostor badge says what it imitates and prints its own address', fake.includes('Imitates SNDKc') && fake.includes('0x35b7…f703'))
  const plain = badgeSvg(verifyToken({ ...base, address: FAKE }))
  check('a token outside the registry is "not in the registry", never "fake"', plain.includes('Not in the Coinbase registry') && !/fake|impostor|scam/i.test(plain))
  const down = badgeSvg({ status: 'unavailable', body: { address: FAKE } })
  check('an unavailable registry is a "?" badge, still with the address', down.includes('Registry unavailable') && down.includes('0x35b7…f703'))
  const evil = badgeSvg(verifyToken({ ...base, records: [{ ...records[0], symbol: '<script>alert(1)</script>' }], address: LISTED }))
  check('every value is escaped and the badge holds no script or link', !evil.includes('<script') && evil.includes('&lt;script&gt;') && !/<a\b|href=|on\w+=/.test(evil))
  check('no badge shows a price', ![ok, fake, plain, down].some((s) => /\$\d/.test(s)))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
