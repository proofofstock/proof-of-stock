// apps/pass-sales.test.mjs: the settlement wallet's sales, read from a chain (apps/pass-sales.mjs). The count is the
// wallet's own transaction count; the latest settlement is found by a search over blocks, and a sale of our own is
// named ours. A node that fails keeps the last good answer, and a request never waits for the chain.
//
// Run: node apps/pass-sales.test.mjs
import { createPassSales, USDC_BASE, TRANSFER_TOPIC, OUR_PAYERS } from './pass-sales.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const WALLET = '0x025297a6729ea9df0bb1f75c216c2b3a9b5cbf4a'
const PAYEE = '0xd68824b1386b5df3c8503defea9085ee23ab4b6f'
const CUSTOMER = '0x' + 'ab'.repeat(20)
const OURS = OUR_PAYERS[0]
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2)
const hash = (n) => '0x' + n.toString(16).padStart(64, '0')
const hex = (n) => '0x' + n.toString(16)

/** A chain of `head` blocks; `sends` are the wallet's transactions in nonce order: { block, payer, reverted }. */
function chain ({ head = 1000, sends = [], failOn = null } = {}) {
  const calls = []
  const byHash = new Map(sends.map((s, i) => [hash(0xa000 + i), { ...s, nonce: i }]))
  const call = async (method, params) => {
    calls.push(method)
    if (failOn && failOn(method, calls.length)) throw new Error(`${method}: the node answered 503`)
    if (method === 'eth_blockNumber') return hex(head)
    if (method === 'eth_getTransactionCount') {
      const at = params[1] === 'latest' ? head : parseInt(params[1], 16)
      return hex(sends.filter((s) => s.block <= at).length)
    }
    if (method === 'eth_getBlockByNumber') {
      const b = parseInt(params[0], 16)
      const own = [...byHash].filter(([, s]) => s.block === b).map(([h, s]) => ({ hash: h, from: WALLET, nonce: hex(s.nonce) }))
      // Strangers' transactions in the same block, one of them with the same nonce, to be told apart by sender.
      return { number: params[0], timestamp: hex(1763639535 + b), transactions: [{ hash: hash(1), from: CUSTOMER, nonce: own[0]?.nonce || '0x0' }, ...own] }
    }
    if (method === 'eth_getTransactionReceipt') {
      const s = byHash.get(params[0])
      if (!s) return null
      return { status: s.reverted ? '0x0' : '0x1', logs: s.reverted ? [] : [
        { address: '0x' + 'cd'.repeat(20), topics: [TRANSFER_TOPIC, topic('0x' + 'ee'.repeat(20)), topic(PAYEE)] }, // another token: not the pay
        { address: USDC_BASE, topics: [TRANSFER_TOPIC, topic(s.payer), topic(PAYEE)] },
      ] }
    }
    throw new Error('unexpected ' + method)
  }
  return { call, calls }
}

console.log('the count and the latest sale')
{
  const c = chain({ sends: [{ block: 400, payer: OURS }, { block: 700, payer: CUSTOMER }] })
  const s = createPassSales({ wallet: WALLET, payTo: PAYEE, call: c.call, pauseMs: 0 })
  const r = await s.refresh()
  check('the count is the wallet\'s own transaction count', r?.settlement_transactions === 2)
  check('the latest settlement is the wallet\'s transaction in the block where the count reached it, with its day', r?.latest?.transaction === hash(0xa001) && r?.latest?.at === new Date((1763639535 + 700) * 1000).toISOString(), JSON.stringify(r?.latest))
  check('...it paid out, the payer is read from the USDC transfer to our payee, and a customer is not ours', r?.latest?.settled === true && r?.latest?.payer === CUSTOMER && r?.latest?.ours === false)
  const before = c.calls.length
  const again = await s.refresh()
  check('a count that has not moved costs one call: the latest is kept, a mined transaction does not change', c.calls.length - before === 1 && again?.latest?.transaction === hash(0xa001))
}
{
  const c = chain({ sends: [{ block: 1, payer: OURS }] })
  const r = await createPassSales({ wallet: WALLET, payTo: PAYEE, call: c.call, pauseMs: 0 }).refresh()
  check('a sale from our own test wallet is named ours', r?.settlement_transactions === 1 && r?.latest?.ours === true && r?.latest?.payer === OURS)
}
{
  const c = chain({ sends: [{ block: 400, payer: CUSTOMER }, { block: 999, payer: CUSTOMER, reverted: true }] })
  const r = await createPassSales({ wallet: WALLET, payTo: PAYEE, call: c.call, pauseMs: 0 }).refresh()
  check('a settlement that reverted counts as sent and is said not to have paid out', r?.settlement_transactions === 2 && r?.latest?.transaction === hash(0xa001) && r?.latest?.settled === false && r?.latest?.payer === null)
}
{
  const c = chain({ sends: [] })
  const r = await createPassSales({ wallet: WALLET, payTo: PAYEE, call: c.call, pauseMs: 0 }).refresh()
  check('no sale yet: a zero count, no latest, and no search', r?.settlement_transactions === 0 && r?.latest === null && c.calls.length === 1)
}

console.log('a node that fails, a request that does not wait')
{
  let broken = false
  const c = chain({ sends: [{ block: 400, payer: CUSTOMER }], failOn: () => broken })
  const logs = []
  let t = 0
  const s = createPassSales({ wallet: WALLET, payTo: PAYEE, call: c.call, pauseMs: 0, now: () => t, refreshMs: 60e3, log: (m) => logs.push(m) })
  check('before the first read there is nothing to show, and asking starts the read', s.snapshot() === null)
  await s.refresh()
  check('...which then answers', s.snapshot()?.settlement_transactions === 1)
  broken = true
  t = 61e3
  await s.refresh()
  check('a node that fails keeps the last good answer and logs the failure', s.snapshot()?.settlement_transactions === 1 && s.snapshot().read_at === new Date(0).toISOString() && logs.some((m) => /\[pass-sales\] read failed/.test(m)))
  const n = c.calls.length
  t = 70e3
  s.snapshot()
  check('a snapshot within the refresh interval reads nothing from the chain', c.calls.length === n)
}
{
  let tries = 0
  const c = chain({ sends: [{ block: 5, payer: CUSTOMER }], failOn: (m) => m === 'eth_getBlockByNumber' && ++tries < 3 })
  const slept = []
  const flaky = async (m, p) => { try { return await c.call(m, p) } catch (e) { throw new Error(String(e.message).replace('503', '429')) } }
  const r = await createPassSales({ wallet: WALLET, payTo: PAYEE, call: flaky, pauseMs: 1, sleep: async (ms) => { slept.push(ms) } }).refresh()
  check('a node that answers 429 is asked again after a wait, and the read completes', r?.latest?.transaction === hash(0xa000) && tries === 3 && slept.some((ms) => ms > 1))
}
{
  const s = createPassSales({ wallet: 'not an address', payTo: PAYEE, call: async () => { throw new Error('no call expected') } })
  check('a wallet or payee that is not an address reads nothing and shows nothing', s.snapshot() === null && (await s.refresh()) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
