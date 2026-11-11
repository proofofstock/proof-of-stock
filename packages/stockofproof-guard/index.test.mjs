// packages/stockofproof-guard/index.test.mjs — the guard buys only an issuer-listed token of the stock asked for,
// refuses an impostor and names the listed contract, refuses what it cannot vouch for, and fails closed.
// The verify answers are the calibration cases of docs/stocks-passport-agent.md, served by a fake fetch: no network.
//
// Run: node packages/stockofproof-guard/index.test.mjs

import { createGuard } from './index.mjs'
import { guardAction, ACTION_INPUT_SCHEMA } from './agentkit.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++
  const line = '  FAIL ' + label + (detail ? ': ' + detail : '')
  failures.push(line); console.log(line)
}

const LISTED = '0xb200000000000000000000397293cb8cda9a10c5', COPY = '0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703'
const NAMING = '0x8ee13668daa8a46f3605be5cc06c1c085c891f53', OTHER = '0x' + '12'.repeat(20)
const ans = (status, body) => ({ status, json: async () => body })
const answers = {
  [LISTED]: ans(200, { listed: true, symbol: 'SNDKc', address: LISTED, registries_checked: ['coinbase:base'], impostor: null }),
  [COPY]: ans(200, { listed: false, symbol: null, address: COPY, registries_checked: ['coinbase:base'], impostor: { kinds: ['registry_symbol'], imitates_symbol: 'SNDKc', listed_address: LISTED } }),
  [NAMING]: ans(200, { listed: false, address: NAMING, registries_checked: ['robinhood:robinhood'], impostor: { kinds: ['issuer_name_suffix'], imitates_symbol: null, listed_address: null } }),
  [OTHER]: ans(200, { listed: false, address: OTHER, registries_checked: ['coinbase:base'], impostor: null, listed_on_other_chain: { chain: 'robinhood', symbol: 'TSLA' } }),
}
const calls = []
const fetchImpl = async (url) => {
  calls.push(String(url))
  const a = new URL(url).searchParams.get('address')
  if (a === '0x' + '99'.repeat(20)) return ans(503, { error: 'registry unavailable' })
  if (a === '0x' + '98'.repeat(20)) throw new Error('connect ETIMEDOUT')
  if (a === '0x' + '97'.repeat(20)) return ans(200, { listed: 'false', symbol: 'SNDKc', address: a, registries_checked: ['coinbase:base'], impostor: null })
  if (a === '0x' + '96'.repeat(20)) return ans(200, { listed: true, symbol: 'SNDKc', address: LISTED, registries_checked: ['coinbase:base'], impostor: null })
  if (a === '0x' + '95'.repeat(20)) return ans(200, { listed: false, address: a })
  return answers[a] || ans(404, {})
}
const guard = createGuard({ fetchImpl })

console.log('decisions')
{
  const ok = await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'SNDK' })
  check('an issuer-listed token of the stock asked for is allowed', ok.allow === true && ok.decision === 'listed')
  check('...and the request went to /verify on proofofstock.xyz with a lower-case address', calls[0] === 'https://proofofstock.xyz/verify?chain=base&address=' + LISTED)
  const copy = await guard.beforeBuy({ chain: 'base', tokenAddress: COPY.toUpperCase().replace('0X', '0x'), claimedSymbol: 'SNDKc' })
  check('a token copying a listed symbol is refused, and the listed contract is offered instead', copy.allow === false && copy.decision === 'impostor' && copy.use_instead === LISTED && /imitates the issuer-listed SNDKc/.test(copy.reason))
  const naming = await guard.beforeBuy({ chain: 'robinhood', tokenAddress: NAMING })
  check('a token copying the issuer naming is refused, with nothing offered instead', naming.allow === false && naming.decision === 'impostor' && naming.use_instead === null)
  const other = await guard.beforeBuy({ chain: 'base', tokenAddress: OTHER })
  check('a token outside the registry is refused without being called fake, and the other chain is pointed out', other.allow === false && other.decision === 'not_listed' && /does not make it fake/.test(other.reason) && /listed on robinhood as TSLA/.test(other.reason))
  const wrong = await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'TSLA' })
  check('a listed token of ANOTHER stock than the one asked for is refused', wrong.allow === false && wrong.decision === 'wrong_stock')
  check('the claim NVDAc, NVDA or nvda is the same stock; a lowercase word is not trimmed', (await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'sndk' })).allow === true && (await guard.beforeBuy({ chain: 'base', tokenAddress: LISTED, claimedSymbol: 'sndkc' })).decision === 'wrong_stock')
}

console.log('failing closed')
{
  // A 200 is not enough: the answer must say listed === true about the address asked, in the documented shape.
  for (const [a, why] of [['97', 'listed is the string "false"'], ['96', 'the answer is about another contract'], ['95', 'registries_checked is missing']]) {
    let d, threw = null
    try { d = await guard.beforeBuy({ chain: 'base', tokenAddress: '0x' + a.repeat(20), claimedSymbol: 'SNDK' }) } catch (e) { threw = e.message }
    check('a malformed 200 (' + why + ') is unknown and refused, not allowed or thrown', !threw && d.allow === false && d.decision === 'unknown' && /malformed answer/.test(d.reason), threw || JSON.stringify(d && { allow: d.allow, decision: d.decision }))
  }
  const down = await guard.beforeBuy({ chain: 'base', tokenAddress: '0x' + '99'.repeat(20) })
  check('a registry that cannot be read refuses the buy', down.allow === false && down.decision === 'unknown')
  const net = await guard.beforeBuy({ chain: 'base', tokenAddress: '0x' + '98'.repeat(20) })
  check('a network failure refuses the buy', net.allow === false && net.decision === 'unknown' && /ETIMEDOUT/.test(net.reason))
  const open = await createGuard({ fetchImpl, failOpen: true }).beforeBuy({ chain: 'base', tokenAddress: '0x' + '99'.repeat(20) })
  check('...unless the caller chose failOpen, and then it says so', open.allow === true && /failOpen/.test(open.reason))
  let threw = 0
  try { await guard.beforeBuy({ chain: 'solana', tokenAddress: LISTED }) } catch (_) { threw++ }
  try { await guard.beforeBuy({ chain: 'base', tokenAddress: 'NVDA' }) } catch (_) { threw++ }
  check('a bad chain or address is a programming error, thrown', threw === 2)
}

console.log('the AgentKit action')
{
  const action = guardAction({ fetchImpl })
  const text = await action.invoke({ chain: 'base', tokenAddress: COPY, claimedSymbol: 'SNDKc' })
  check('the action answers in a line that starts with REFUSE and names the contract to use', /^REFUSE \(impostor\):/.test(text) && text.includes('Use instead: ' + LISTED))
  check('...ALLOW for the listed one', /^ALLOW \(listed\)/.test(await action.invoke({ chain: 'base', tokenAddress: LISTED })))
  check('the input schema requires chain and address and allows only the two chains', ACTION_INPUT_SCHEMA.required.join() === 'chain,tokenAddress' && ACTION_INPUT_SCHEMA.properties.chain.enum.join() === 'base,robinhood')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(f); process.exit(1) }
