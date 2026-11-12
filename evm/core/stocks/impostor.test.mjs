// evm/core/stocks/impostor.test.mjs: the W2-static radar: resemblances() returns every kind, the three address signals
// fire on what they describe and nothing else, a registry address is never flagged, the full prefix is never an
// impostor, the self-check turns the prefix signals off, and resemblance() answers exactly as before.
// Synthetic addresses only.
//
// Run: node evm/core/stocks/impostor.test.mjs

import {
  resemblance, resemblances, prefixSelfCheck, addressLookalike, vanityZeros, chainOfRegistry,
  ADDRESS_SIGNAL_KINDS, NEVER_IMPOSTOR_KINDS, RESEMBLANCE_KINDS, FULL_PREFIX_ZEROS, VANITY_MIN_ZEROS, LOOKALIKE_RULES,
} from './impostor.mjs'
import { IMPOSTOR_KINDS } from './verify.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}
const kinds = (r) => r.hits.map((h) => h.kind)
const addr = (hex) => { if (hex.length !== 40) throw new Error('bad fixture ' + hex); return '0x' + hex }
const flip = (a, i) => a.slice(0, 2 + i) + (a[2 + i] === '7' ? '8' : '7') + a.slice(3 + i)

// Base: two Coinbase records on the full prefix.
const CB1 = addr('b2' + '0'.repeat(24) + '11aa22bb33cc44')
const CB2 = addr('b2' + '0'.repeat(22) + '9f8e7d6c5b4a3210')
const cb = (address, symbol, name) => ({ issuer: 'coinbase', address, symbol, name })
const BASE = [cb(CB1, 'NVDAc', 'NVIDIA'), cb(CB2, 'TSLAc', 'Tesla')]
// Robinhood: bare-ticker symbols, no prefix pattern.
const RH1 = addr('abcdef' + '1'.repeat(30) + '9876')
const RH = [{ issuer: 'robinhood', address: RH1, symbol: 'TSLA', name: 'Tesla' }]

console.log('the shape and the constants')
{
  check('the address kinds are the three the TZ names', ADDRESS_SIGNAL_KINDS.join() === 'address_lookalike,vanity_prefix_partial,unlisted_full_prefix')
  check('the full prefix is never an impostor kind, nor is a bare ticker', NEVER_IMPOSTOR_KINDS.includes('unlisted_full_prefix') && NEVER_IMPOSTOR_KINDS.includes('ticker'))
  check('no new signal is a published impostor kind', ADDRESS_SIGNAL_KINDS.every((k) => !IMPOSTOR_KINDS.includes(k) && !RESEMBLANCE_KINDS.includes(k)))
  check('the thresholds are 4 and 20 zeros', VANITY_MIN_ZEROS === 4 && FULL_PREFIX_ZEROS === 20)
  check('the chain is read off the issuer', chainOfRegistry(BASE) === 'base' && chainOfRegistry(RH) === 'robinhood' && chainOfRegistry([]) === null)
}

console.log('every kind, not the first')
{
  // A Robinhood token with the issuer's naming AND a borrowed ticker AND a lookalike address.
  const r = resemblances({ address: flip(RH1, 20), symbol: 'tsla', name: 'Tesla Robinhood Token' }, RH)
  check('every matching kind is returned, name kinds first in resemblance() order', kinds(r).join() === 'issuer_name_suffix,ticker,address_lookalike', kinds(r).join())
  check('resemblance() still returns only the strongest', resemblance({ address: flip(RH1, 20), symbol: 'tsla', name: 'Tesla Robinhood Token' }, RH).kind === 'issuer_name_suffix')
  const b = resemblances({ address: flip(CB1, 20), symbol: 'NVDAc', name: 'NVIDIA' }, BASE)
  check('a Base copy carries its symbol, its lookalike tail and its partial prefix at once', kinds(b).join() === 'registry_symbol,registry_name,address_lookalike,vanity_prefix_partial', kinds(b).join())
}

console.log('the company name as the whole name (registry_name, owner 2026-11-12)')
{
  const X = addr('e2'.repeat(20))
  const RHC = [{ issuer: 'robinhood', address: RH1, symbol: 'MCD', name: "McDonald's " + String.fromCharCode(0x2022) + ' Robinhood Token' }]
  const CBC = [cb(CB1, 'MRVLc', 'Marvell Technology, Inc.')]
  check('the bare company name of a Robinhood token is a strong claim', resemblance({ address: X, symbol: 'Mc', name: "McDonald's" }, RHC)?.kind === 'registry_name')
  check('the corporate ending and the case do not hide it', resemblance({ address: X, symbol: 'MRVLB', name: 'marvell technology' }, CBC)?.kind === 'registry_name')
  check('the copy names the listed token it imitates', resemblance({ address: X, symbol: 'Mc', name: "McDonald's" }, RHC)?.registry_symbol === 'MCD')
  check('a name that only contains the company is not the company', resemblance({ address: X, symbol: 'MCF', name: "McDonald's fan club" }, RHC) === null)
  check('the issuer naming stays its own kind, not doubled as a company name', kinds(resemblances({ address: X, symbol: 'ZZZ', name: "McDonald's Robinhood Token" }, RHC)).join() === 'issuer_name_suffix')
  check('the listed token itself is never its own copy', resemblance({ address: RH1, symbol: 'MCD', name: "McDonald's" }, RHC) === null)
  check('a name shorter than three letters is a word, not a company', resemblance({ address: X, symbol: 'NU2', name: 'Nu' }, [{ issuer: 'robinhood', address: RH1, symbol: 'NU', name: 'Nu ' + String.fromCharCode(0x2022) + ' Robinhood Token' }]) === null)
  check('registry_name is a published impostor kind and ranks above the bare ticker', IMPOSTOR_KINDS.includes('registry_name') && RESEMBLANCE_KINDS.indexOf('registry_name') < RESEMBLANCE_KINDS.indexOf('ticker'))
}

console.log('resemblance() is unchanged')
{
  const X = addr('e1'.repeat(20))
  const cases = [
    [{ address: CB1, symbol: 'NVDAc' }, BASE], [{ address: X, symbol: 'nvda' }, BASE], [{ address: X, symbol: 'NVDAc' }, BASE],
    [{ address: X, symbol: 'TSL4', name: 'Tesla Robinhood Token' }, RH], [{ address: X, symbol: 'TSLA', name: 'tsla to the moon' }, RH],
    [{ address: X, symbol: 'HOOD2', name: 'Robinhood Tokenomics' }, RH], [{ address: X, symbol: 'PEPE' }, BASE], [{ address: null, symbol: 'NVDAc' }, BASE],
    [{ address: flip(CB1, 20), symbol: 'PEPE' }, BASE],
  ]
  const want = ['null', 'ticker', 'registry_symbol', 'issuer_name_suffix', 'ticker', 'null', 'null', 'null', 'null']
  const got = cases.map(([i, reg]) => String(resemblance(i, reg)?.kind ?? null))
  check('resemblance() gives today\'s answers, and ignores the address signals', got.join() === want.join(), got.join())
  const agree = cases.every(([i, reg]) => {
    const one = resemblance(i, reg)
    const first = resemblances(i, reg).hits.find((h) => RESEMBLANCE_KINDS.includes(h.kind)) || null
    return JSON.stringify(one) === JSON.stringify(first)
  })
  check('resemblances()\' first name kind is exactly resemblance()', agree)
}

console.log('a registry address is never flagged')
{
  const r = resemblances({ address: CB1, symbol: 'NVDAc', name: 'NVIDIA' }, BASE)
  check('a listed Base address has no hit at all, though it carries the full prefix', r.listed === true && r.hits.length === 0)
  check('a listed address in mixed case is still listed', resemblances({ address: CB1.toUpperCase().replace('0X', '0x') }, BASE).listed === true)
  check('a listed Robinhood address is not its own lookalike', resemblances({ address: RH1, symbol: 'TSLA' }, RH).hits.length === 0 && addressLookalike(RH1, RH) === null)
  const fresh = addr('b2' + '0'.repeat(21) + '5'.repeat(17))
  check('a fresh full-prefix address is flagged while unlisted', kinds(resemblances({ address: fresh }, BASE)).join() === 'unlisted_full_prefix')
  check('and not once the registry lists it', resemblances({ address: fresh }, [...BASE, cb(fresh, 'AAPLc', 'Apple')]).hits.length === 0)
}

console.log('vanity_prefix_partial and unlisted_full_prefix')
{
  const z = (k) => addr('b2' + '0'.repeat(k) + 'f'.repeat(38 - k))
  check('k zeros are counted after 0xb2', vanityZeros(z(4)) === 4 && vanityZeros(z(19)) === 19 && vanityZeros(addr('b3' + '0'.repeat(38))) === -1)
  check('4 zeros after 0xb2 is a partial vanity prefix', kinds(resemblances({ address: z(4) }, BASE)).join() === 'vanity_prefix_partial')
  check('19 zeros is still partial', kinds(resemblances({ address: z(19) }, BASE)).join() === 'vanity_prefix_partial')
  check('3 zeros is noise, not a signal', resemblances({ address: z(3) }, BASE).hits.length === 0)
  check('zeros after another head are nothing', resemblances({ address: addr('b3' + '0'.repeat(20) + 'f'.repeat(18)) }, BASE).hits.length === 0)
  const full = resemblances({ address: z(20) }, BASE)
  check('20 zeros is the full prefix: unlisted_full_prefix, not partial', kinds(full).join() === 'unlisted_full_prefix' && full.hits[0].zeros === 20)
  check('the full prefix is never an impostor', full.hits.every((h) => !IMPOSTOR_KINDS.includes(h.kind)) && resemblance({ address: z(20) }, BASE) === null)
  check('the prefix signals are Base only', resemblances({ address: z(4) }, RH).hits.length === 0 && resemblances({ address: z(20) }, RH).hits.length === 0)
}

console.log('the self-check')
{
  const ok = prefixSelfCheck(BASE)
  check('a registry on the full prefix keeps the signals on', ok.active === true && ok.checked === 2)
  const bad = addr('b2' + '0'.repeat(10) + '1'.repeat(28))
  const off = prefixSelfCheck([...BASE, cb(bad, 'AMZNc', 'Amazon')])
  check('one Coinbase address without the full prefix turns them off and says which', off.active === false && off.reason === 'registry_address_without_full_prefix' && off.without_prefix.join() === bad)
  const r = resemblances({ address: addr('b2' + '0'.repeat(6) + 'f'.repeat(32)) }, [...BASE, cb(bad, 'AMZNc', 'Amazon')])
  check('with the self-check off no prefix signal fires, and the caller sees why', r.hits.length === 0 && r.prefix_check.active === false && r.prefix_check.reason === 'registry_address_without_full_prefix')
  check('an empty Base registry turns them off', prefixSelfCheck([], 'base').active === false && prefixSelfCheck([], 'base').reason === 'empty_registry')
  check('on Robinhood the check is not applicable', prefixSelfCheck(RH).reason === 'not_applicable')
}

console.log('address_lookalike')
{
  check('Robinhood compares the first 6 and the last 4; Base the last 6', LOOKALIKE_RULES.robinhood.head === 6 && LOOKALIKE_RULES.robinhood.tail === 4 && LOOKALIKE_RULES.base.head === 0 && LOOKALIKE_RULES.base.tail === 6)
  check('Robinhood: one changed character in the middle is caught', addressLookalike(flip(RH1, 20), RH)?.address === RH1)
  check('Robinhood: a whole different middle with the same head and tail is caught', kinds(resemblances({ address: addr('abcdef' + '2'.repeat(30) + '9876') }, RH)).join() === 'address_lookalike')
  check('Robinhood: a different head is not a lookalike', addressLookalike(addr('abcdee' + '2'.repeat(30) + '9876'), RH) === null)
  check('Robinhood: a different tail is not a lookalike', addressLookalike(addr('abcdef' + '2'.repeat(30) + '9875'), RH) === null)
  check('Robinhood: the tail alone is not enough', addressLookalike(addr('000000' + '2'.repeat(30) + '9876'), RH) === null)
  check('Base: one changed character in the middle is caught', addressLookalike(flip(CB1, 20), BASE)?.address === CB1)
  const t = resemblances({ address: addr('de'.repeat(17) + '33cc44'), symbol: 'PEPE' }, BASE)
  check('Base: the same last 6 hex without the shared head is caught, and names the listed token', kinds(t).join() === 'address_lookalike' && t.hits[0].registry_address === CB1 && t.hits[0].registry_symbol === 'NVDAc')
  check('Base: a different last character is not a lookalike', addressLookalike(addr('de'.repeat(17) + '33cc45'), BASE) === null)
  check('Base: matching only the last 5 is not a lookalike', addressLookalike(addr('de'.repeat(17) + '43cc44'), BASE) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
