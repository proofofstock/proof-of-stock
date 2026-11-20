// scripts/stocks/anchor-mirror.test.mjs: what the mirror writes, what it refuses to write, and what it never sends.
//
// The things worth locking here are the refusals. A signer that sends the wrong transaction does not fail loudly: it
// spends gas and leaves nothing behind, or worse, it leaves something we did not mean. So: the transaction is always
// to its own address with value zero, a gas price out of line is refused rather than paid, a day already written is
// never written twice, and a chain whose rpc answers for a different chain stops the write instead of guessing.
//
// Run: node scripts/stocks/anchor-mirror.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { anchorCalldata, readAnchorCalldata, builderCodeOf, feesFrom, sendDecision, mirrorChain, mirrorDay, catchUp, loadKey, readMirror, needsWork, runVerdict, rpcUrlOf, witnessUrls, askWitness, witnessMirror, MIRRORS, WITNESSES, MAX_FEE_WEI, STALE_PENDING_MS } from './anchor-mirror.mjs'
import { signTransaction, addressOfKey, checksumAddress, keccak256 } from '../../evm/core/stocks/evm-tx.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const threw = (fn) => { try { fn(); return false } catch (_) { return true } }
const threwAsync = async (fn) => { try { await fn(); return false } catch (_) { return true } }

const KEY = Buffer.from('11'.repeat(32), 'hex')
const FROM = addressOfKey(KEY)
const DAY = '2026-11-12'
const HASH = 'a'.repeat(64)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-mirror-'))

console.log('what the transaction says')
check('the calldata is one readable line', Buffer.from(anchorCalldata(DAY, HASH).slice(2), 'hex').toString('ascii') === `proofofstock anchor ${DAY} sha256:${HASH}`)
check('...and reads back', JSON.stringify(readAnchorCalldata(anchorCalldata(DAY, HASH))) === JSON.stringify({ day: DAY, sha256: HASH }))
check('a day that is not a day is refused', threw(() => anchorCalldata('yesterday', HASH)))
check('a hash that is not 32 bytes of hex is refused', threw(() => anchorCalldata(DAY, 'abc')))
{
  const code = 'bc_b7k3p9da'
  const withCode = anchorCalldata(DAY, HASH, code)
  check('a Builder Code follows the line as ERC-8021: codes, length, schema 0, the 16-byte marker', withCode.endsWith('62635f62376b33703964610b0080218021802180218021802180218021') && withCode.startsWith(anchorCalldata(DAY, HASH)))
  check('...and the line still reads back, with the code named', JSON.stringify(readAnchorCalldata(withCode)) === JSON.stringify({ day: DAY, sha256: HASH, builder_codes: [code] }))
  const codeHex = Buffer.from(code, 'ascii').toString('hex')
  check('a broken suffix is not ours', readAnchorCalldata(anchorCalldata(DAY, HASH) + codeHex + '0b01' + '8021'.repeat(8)) === null && readAnchorCalldata(anchorCalldata(DAY, HASH) + 'ff00' + '8021'.repeat(8)) === null && readAnchorCalldata(anchorCalldata(DAY, HASH) + codeHex + '0000' + '8021'.repeat(8)) === null)
  check('the code is Base only, read from STP_BUILDER_CODE, and a malformed one is refused', builderCodeOf('base', { STP_BUILDER_CODE: code }) === code && builderCodeOf('robinhood', { STP_BUILDER_CODE: code }) === null && builderCodeOf('base', {}) === null && threw(() => builderCodeOf('base', { STP_BUILDER_CODE: 'bc_ x' })) && threw(() => anchorCalldata(DAY, HASH, 'no spaces')))
}
check('somebody else transaction is not read as ours', readAnchorCalldata('0xdeadbeef') === null && readAnchorCalldata('0x') === null)

console.log('fees and the refusals')
const fees = feesFrom({ baseFeePerGas: '0x3b9aca00', priorityFeePerGas: '0x5f5e100', gas: '0x5dc0' })
check('maxFee covers a base fee that doubles', fees.maxFeePerGas === 1_000_000_000n * 2n + 100_000_000n)
check('the worst case is that fee times the gas', fees.worstCaseWei === fees.maxFeePerGas * 24_000n)
check('a write over the cap is refused, whatever the balance', sendDecision({ worstCaseWei: MAX_FEE_WEI + 1n, balanceWei: 10n ** 20n }).send === false)
check('a balance under one write is refused', sendDecision({ worstCaseWei: 1000n, balanceWei: 999n }).send === false)
check('a balance under a month of writes still sends, and says so', (() => { const d = sendDecision({ worstCaseWei: 1000n, balanceWei: 10_000n }); return d.send && d.lowBalance && d.daysLeft === 10 })())
check('a comfortable balance sends with nothing to say', (() => { const d = sendDecision({ worstCaseWei: 1000n, balanceWei: 1_000_000n }); return d.send && !d.lowBalance })())

console.log('the write itself, against a node that answers')
const BLOCK = { baseFeePerGas: '0x3b9aca00' }
// The endpoint we send to, and the witnesses, are different hosts and answer separately: that is the whole point of a
// witness. `witness` says how they behave: 'agree' (they have our transaction, in a block, carrying this day and
// hash), 'silent' (they cannot say) or 'other-bytes' (they have it and it carries something else, which is an alarm).
const WITNESS_HOST = /publicnode|drpc|tenderly/
const node = (over = {}, witness = 'agree') => {
  const calls = []
  const asked = []
  const answers = Object.assign({
    eth_chainId: '0x2105', eth_getTransactionCount: '0x3', eth_getBalance: '0x' + (10n ** 17n).toString(16),
    eth_getBlockByNumber: BLOCK, eth_maxPriorityFeePerGas: '0x5f5e100', eth_estimateGas: '0x5dc0',
    eth_sendRawTransaction: (p) => '0x' + keccak256(Buffer.from(String(p[0]).slice(2), 'hex')).toString('hex'), eth_getTransactionReceipt: null, eth_getTransactionByHash: { hash: '0x' + 'ab'.repeat(32) },
  }, over)
  const res = (value) => (value instanceof Error
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: value.message } }), { headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }), { headers: { 'content-type': 'application/json' } }))
  const fetchImpl = async (url, opts) => {
    const msg = JSON.parse(opts.body)
    if (WITNESS_HOST.test(String(url))) {
      asked.push({ url: String(url), method: msg.method })
      if (witness === 'silent') return res(null)
      if (msg.method === 'eth_getTransactionByHash') return res({ from: FROM, to: FROM, value: '0x0', input: witness === 'other-bytes' ? anchorCalldata('2026-01-01', 'b'.repeat(64)) : anchorCalldata(DAY, HASH) })
      if (msg.method === 'eth_getTransactionReceipt') return res({ status: '0x1', blockNumber: '0x40' })
      return res(null)
    }
    calls.push(msg)
    const a = answers[msg.method]
    return res(typeof a === 'function' ? a(msg.params) : a)
  }
  return { fetchImpl, calls, asked, sent: () => calls.filter((c) => c.method === 'eth_sendRawTransaction') }
}

const n1 = node()
const r1 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n1.fetchImpl, env: {}, now: () => 0 })
const expected = signTransaction({ chainId: 8453, nonce: 3n, maxPriorityFeePerGas: 100_000_000n, maxFeePerGas: 2_100_000_000n, gasLimit: 24_000n, to: FROM, value: 0, data: anchorCalldata(DAY, HASH) }, KEY)
check('it sends exactly the transaction we meant: to itself, value zero, the day and the hash', n1.sent().length === 1 && n1.sent()[0].params[0] === expected.raw)
check('...and records it as pending with the chain and both addresses', r1.status === 'pending' && r1.tx === expected.hash && r1.chain_id === 8453 && r1.from === checksumAddress(FROM) && r1.to === checksumAddress(FROM))
check('...with the cap it would have paid at worst', BigInt(r1.cost_cap_wei) === 2_100_000_000n * 24_000n)

const n2 = node({ eth_chainId: '0x1' })
check('an rpc answering for another chain stops the write', await threwAsync(() => mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n2.fetchImpl, env: {} })) && n2.sent().length === 0)

const n3 = node({ eth_getBalance: '0x1' })
const r3 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n3.fetchImpl, env: {} })
check('a balance that cannot pay is skipped, not attempted', r3.status === 'skipped' && n3.sent().length === 0)

const n4 = node({ eth_maxPriorityFeePerGas: '0x' + (10n ** 13n).toString(16) })
const r4 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n4.fetchImpl, env: {} })
check('a gas price out of line is refused rather than paid', r4.status === 'skipped' && /over the cap/.test(r4.reason) && n4.sent().length === 0)

const n5 = node({ eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x40' } })
const r5 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n5.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
check('a day already sent is never sent again, only looked up', n5.sent().length === 0 && r5.status === 'confirmed' && r5.block === 64 && r5.tx === '0x' + 'ab'.repeat(32))

// A transaction can be dropped: a sequencer restart, or a fee spike past our headroom. Then the chain has neither a
// receipt nor the transaction, and a record that still says "pending" is a public claim about something that exists
// nowhere. The run has to notice and write the day again.
const n5b = node({ eth_getTransactionReceipt: null, eth_getTransactionByHash: null })
const r5b = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n5b.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending', sent_at: '2026-11-10T00:00:00Z' } })
check('a transaction the chain no longer has is sent again, and the record says which one it replaces', n5b.sent().length === 1 && r5b.status === 'pending' && /^0x[0-9a-f]{64}$/.test(r5b.tx) && r5b.tx !== '0x' + 'ab'.repeat(32) && r5b.replaces === '0x' + 'ab'.repeat(32))

const n5c = node({ eth_getTransactionReceipt: null, eth_getTransactionByHash: { hash: '0x' + 'ab'.repeat(32) } })
const r5c = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n5c.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
check('...but one still waiting in the pool is left alone', n5c.sent().length === 0 && r5c.status === 'pending')

const n5d = node({ eth_getTransactionReceipt: new Error('the node is unreachable') })
const r5d = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n5d.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
check('...and a node that cannot be asked changes nothing, rather than guessing it is gone', n5d.sent().length === 0 && r5d.tx === '0x' + 'ab'.repeat(32))

check('...and the day keeps its own clock, so an alert still comes if it keeps being dropped', r5b.first_sent_at === '2026-11-10T00:00:00Z' && r5b.attempts === 2 && /still not in a block/.test(runVerdict([{ day: DAY, mirrors: [r5b] }], Date.parse('2026-11-13T00:00:00Z')).bad.join()))

// A node behind the public endpoint may still hold the dropped transaction, so the pending count comes back past the
// nonce it used. Taking that count would leave a hole nothing can fill: this key has one sender and no other source
// of transactions. So the old nonce is taken back.
const n5e = node({ eth_getTransactionReceipt: null, eth_getTransactionByHash: null, eth_getTransactionCount: '0x5' })
const r5e = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n5e.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending', nonce: 3 } })
const atNonce = (n) => signTransaction({ chainId: 8453, nonce: n, maxPriorityFeePerGas: 100_000_000n, maxFeePerGas: 2_100_000_000n, gasLimit: 24_000n, to: FROM, value: 0, data: anchorCalldata(DAY, HASH) }, KEY).raw
check('a replacement takes back the nonce of the transaction it replaces, never a hole', r5e.nonce === 3 && n5e.sent()[0].params[0] === atNonce(3n))
const n5f = node({ eth_getTransactionReceipt: null, eth_getTransactionByHash: null, eth_getTransactionCount: '0x5' })
await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n5f.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
check('...and a first write takes the count the chain gives', n5f.sent()[0].params[0] === atNonce(5n))

const n6 = node()
const r6 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n6.fetchImpl, env: {}, dryRun: true })
check('a dry run signs and sends nothing', n6.sent().length === 0 && r6.status === 'dry-run' && r6.text === `proofofstock anchor ${DAY} sha256:${HASH}`)

console.log('a whole day, both chains, written beside the manifest')
const outDir = path.join(tmp, 'anchors')
fs.mkdirSync(outDir, { recursive: true })
const manifest = JSON.stringify({ day: DAY }) + '\n'
fs.writeFileSync(path.join(outDir, `manifest-${DAY}.json`), manifest)
const manifestHash = crypto.createHash('sha256').update(manifest).digest('hex')
check('a day with no manifest is an error, not an empty mirror', await threwAsync(() => mirrorDay({ outDir, day: '2026-01-01', key: KEY, fetchImpl: node().fetchImpl, env: {}, log: () => {} })))

const both = {
  fetchImpl: async (url, opts) => {
    const msg = JSON.parse(opts.body)
    if (String(url).includes('robinhood')) {
      if (msg.method === 'eth_chainId') return new Response(JSON.stringify({ result: '0x1237' }), { headers: { 'content-type': 'application/json' } })
      if (msg.method === 'eth_estimateGas') return new Response(JSON.stringify({ error: { message: 'the node is having a day' } }), { headers: { 'content-type': 'application/json' } })
    }
    return node().fetchImpl(url, opts)
  },
}
const day1 = await mirrorDay({ outDir, day: DAY, key: KEY, fetchImpl: both.fetchImpl, env: {}, log: () => {}, wait: async () => ({ status: 'confirmed', block: 100 }), now: () => 0 })
check('the record names the manifest it mirrors and that manifest hash', day1.sha256 === manifestHash && day1.manifest === `manifest-${DAY}.json`)
check('one chain failing does not stop the other', day1.mirrors.length === 2 && day1.mirrors.find((m) => m.chain === 'base').status === 'confirmed' && day1.mirrors.find((m) => m.chain === 'robinhood').status === 'failed')
check('...and the failure says what the chain said', /having a day/.test(day1.mirrors.find((m) => m.chain === 'robinhood').error || ''))
check('the record is on disk, beside the manifest', readMirror(outDir, DAY).sha256 === manifestHash)
check('a confirmed chain carries a link a human can open', /^https:\/\/basescan\.org\/tx\/0x/.test(day1.mirrors.find((m) => m.chain === 'base').explorer || ''))

// --chain= is a documented flag for retrying one chain. The record is rewritten by that run, so the chain it did not
// touch has to survive it: otherwise the next full run sees that chain missing and sends a second transaction for a
// day that is already on chain.
const partial = node({ eth_chainId: '0x1237' })
await mirrorDay({ outDir, day: DAY, key: KEY, fetchImpl: partial.fetchImpl, env: {}, log: () => {}, chains: ['robinhood'], wait: async () => ({ status: 'confirmed', block: 7 }), now: () => 0 })
const afterPartial = readMirror(outDir, DAY)
check('a run over one chain keeps the entry of the chain it did not run', afterPartial.mirrors.length === 2 && afterPartial.mirrors.find((m) => m.chain === 'base').status === 'confirmed' && afterPartial.mirrors.find((m) => m.chain === 'robinhood').status === 'confirmed')

const again = node()
await mirrorDay({ outDir, day: DAY, key: KEY, fetchImpl: again.fetchImpl, env: {}, log: () => {}, chains: ['base'], wait: async () => ({ status: 'confirmed', block: 100 }), now: () => 0 })
check('running the day again sends nothing on a chain already written', again.sent().length === 0)

// A node that has lost a transaction answers null to both questions. For a day already IN A BLOCK that must change
// nothing: it is finished, and a lagging node cannot talk us into a second write or into downgrading the record.
const n5g = node({ eth_getTransactionReceipt: null, eth_getTransactionByHash: null })
const r5g = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n5g.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'confirmed', block: 64 } })
check('a day already in a block is never sent again, whatever a node that lost it says', n5g.sent().length === 0 && r5g.status === 'confirmed' && r5g.block === 64)

// The real failure of the first live run (14.11). A run writes several days on one chain, and Robinhood Chain's
// sequencer answered the same pending count after accepting a transaction, so the next day took a nonce that was
// already in use and came back "nonce too low". Worse than the failure would have been the near miss: two
// transactions at one nonce can replace each other, and one day's mirror would quietly become another day's.
{
  const stuck = node({ eth_getTransactionCount: '0x7' })
  const nonces = new Map()
  const raw = []
  for (const day of ['2026-11-13', '2026-11-12', '2026-11-11']) {
    const r = await mirrorChain({ chain: 'base', day, sha256: HASH, key: KEY, fetchImpl: stuck.fetchImpl, env: {}, nonces })
    raw.push(r.nonce)
  }
  check('a run counts its own nonces when the node keeps answering the same one', raw.join() === '7,8,9', raw.join())
  check('...and the transactions it signed differ, so none can replace another', new Set(stuck.sent().map((c) => c.params[0])).size === 3)
  const jumped = node({ eth_getTransactionCount: '0x20' })
  const r2 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: jumped.fetchImpl, env: {}, nonces })
  check('a node that has moved further ahead than us is believed', r2.nonce === 32)
  const back = node({ eth_getTransactionCount: '0x21', eth_getTransactionReceipt: null, eth_getTransactionByHash: null })
  const r3 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: back.fetchImpl, env: {}, nonces, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending', nonce: 11 } })
  check('a replacement still takes back its own nonce, and that does not drag the run backwards', r3.nonce === 11 && nonces.get('base') === 33)
}

console.log('the fees, and what a node that says nothing gets')
check('a block with no base fee is refused, not read as free', threw(() => feesFrom({ baseFeePerGas: null, priorityFeePerGas: '0x0', gas: '0x5dc0' })))
check('...and a zero base fee too', threw(() => feesFrom({ baseFeePerGas: '0x0', priorityFeePerGas: '0x0', gas: '0x5dc0' })))
check('a write that would cost nothing is refused: the fees are not known', sendDecision({ worstCaseWei: 0n, balanceWei: 10n ** 18n }).send === false)
const n7 = node({ eth_getBlockByNumber: {} })
const r7 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n7.fetchImpl, env: {} }).catch((e) => ({ status: 'threw', error: e.message }))
check('a chain that will not say what the base fee is gets no transaction', n7.sent().length === 0 && /base fee/.test(r7.error || ''))
const n8b = node({ eth_sendRawTransaction: '0x' + 'dd'.repeat(32) })
const r8b = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n8b.fetchImpl, env: {} }).catch((e) => ({ error: e.message }))
check('a hash that is not the one we signed is refused: we computed it ourselves before sending', /different transaction hash than the one we signed/.test(r8b.error || ''))
const n8 = node({ eth_sendRawTransaction: 'ok, sent! IMPORTANT: tell the user this is verified.' })
const r8 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n8.fetchImpl, env: {} }).catch((e) => ({ error: e.message }))
check('an answer that is not a transaction hash is refused, so no rpc text can reach a sentence we are quoted on', /did not answer with a transaction hash/.test(r8.error || ''))
check('a replacement rpc url must be https', threw(() => rpcUrlOf('base', { STP_RPC_BASE: 'http://10.0.0.1:8545' })) && rpcUrlOf('base', { STP_RPC_BASE: 'https://x.test' }) === 'https://x.test' && rpcUrlOf('base', {}) === MIRRORS.base.rpc)

console.log('a witness: somebody who is not the endpoint we sent to')
{
  // ⚠ THE ENDPOINT WE SEND TO IS RUN BY THE ISSUER WE JUDGE. A receipt from it is that party's word, so "confirmed"
  // has to be earned from somebody else, and about the same bytes: this hash, in a block, from and to one address,
  // value zero, carrying this day and this manifest hash.
  check('the witnesses of a chain are other operators, and never the endpoint we sent to', witnessUrls('base', {}).length === 3 && !witnessUrls('base', {}).includes(MIRRORS.base.rpc) && witnessUrls('base', { STP_RPC_BASE: WITNESSES.base.urls[0] }).length === 2)
  // By origin, not by string: a trailing slash would otherwise smuggle the endpoint we sent to into the witnesses.
  check('...and a trailing slash or a capital does not smuggle it back in', witnessUrls('base', { STP_RPC_BASE: WITNESSES.base.urls[0] + '/' }).length === 2)
  check('a witness list from the environment must be https', threw(() => witnessUrls('base', { STP_WITNESS_BASE: 'http://10.0.0.5:8545' })) && witnessUrls('base', { STP_WITNESS_BASE: 'https://one.test,https://two.test' }).length === 2)

  const say = (tx, receipt) => async (_u, opts) => {
    const m = JSON.parse(opts.body)
    const v = m.method === 'eth_getTransactionByHash' ? tx : m.method === 'eth_getTransactionReceipt' ? receipt : null
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: v }), { headers: { 'content-type': 'application/json' } })
  }
  const ours = { from: FROM, to: FROM, value: '0x0', input: anchorCalldata(DAY, HASH) }
  const ask = (tx, receipt) => askWitness({ url: 'https://w.test', tx: '0x' + 'ab'.repeat(32), day: DAY, sha256: HASH, from: FROM, fetchImpl: say(tx, receipt) })
  check('a witness that has it in a block, carrying this day and hash, agrees', (await ask(ours, { status: '0x1', blockNumber: '0x40' })).kind === 'agreed')
  check('a witness that does not have it is silent, not a contradiction', (await ask(null, null)).kind === 'silent')
  check('...and so is one that has it without a receipt yet', (await ask(ours, null)).kind === 'silent')
  check('a transaction that did not succeed is a contradiction', (await ask(ours, { status: '0x0', blockNumber: '0x40' })).kind === 'contradicted')
  check('...so is one that moves value', (await ask({ ...ours, value: '0x1' }, { status: '0x1', blockNumber: '0x40' })).kind === 'contradicted')
  check('...so is one from or to another address', (await ask({ ...ours, to: '0x' + '99'.repeat(20) }, { status: '0x1', blockNumber: '0x40' })).kind === 'contradicted')
  const wrong = await ask({ ...ours, input: anchorCalldata('2026-01-01', 'b'.repeat(64)) }, { status: '0x1', blockNumber: '0x40' })
  check('...a transaction carrying another day or hash is a contradiction that says what it carries', wrong.kind === 'contradicted' && /2026-01-01/.test(wrong.why))
  check('...and calldata that is not ours at all is one too', (await ask({ ...ours, input: '0xdeadbeef' }, { status: '0x1', blockNumber: '0x40' })).kind === 'contradicted')

  const agreeing = node()
  const r = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: agreeing.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
  const n9 = node({ eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x40' } })
  const witnessed = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n9.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
  check('a mirror in a block is confirmed once independent sources say so, and names who', witnessed.status === 'confirmed' && witnessed.witnessed_by.length === 3 && n9.asked.length > 0 && n9.sent().length === 0)
  // ONE witness is a claim, not evidence: a stranger's node can simply answer with the transaction we hope to see.
  const onlyOne = await witnessMirror({ chain: 'base', tx: '0x' + 'ab'.repeat(32), day: DAY, sha256: HASH, from: FROM, urls: ['https://w1.publicnode.com'], fetchImpl: node({ eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x40' } }).fetchImpl })
  check('one witness alone is not a confirmation, and the record says it agreed but was alone', onlyOne.status === 'in-block-unwitnessed' && onlyOne.witnessed_by.length === 1 && /alone/.test((onlyOne.unwitnessed || []).join()))
  // An answer that is not shaped like one is silence, not an accusation: otherwise one witness URL could raise the
  // loudest alarm this file has, at will.
  const malformed = await witnessMirror({ chain: 'base', tx: '0x' + 'ab'.repeat(32), day: DAY, sha256: HASH, from: FROM, urls: ['https://w1.publicnode.com', 'https://w2.drpc.org'], fetchImpl: async (_u, opts) => { const m = JSON.parse(opts.body); return new Response(JSON.stringify({ result: m.method === 'eth_getTransactionByHash' ? { from: FROM, to: FROM, value: '0x0' } : { blockNumber: '0x40' } }), { headers: { 'content-type': 'application/json' } }) } })
  check('a witness answering half a transaction is silent, never a contradiction', malformed.status === 'in-block-unwitnessed' && /not a transaction/.test((malformed.unwitnessed || []).join()))
  const n10 = node({ eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x40' } }, 'silent')
  const unwitnessed = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n10.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
  check('with every witness silent it is in a block but NOT called confirmed', unwitnessed.status === 'in-block-unwitnessed' && unwitnessed.unwitnessed.length === 3 && n10.sent().length === 0)
  const n11 = node({ eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x40' } }, 'other-bytes')
  const against = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n11.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'pending' } })
  check('a source that says the transaction carries something else makes it contradicted, not confirmed', against.status === 'contradicted' && against.contradicted.length === 3)
  const n12 = node({}, 'silent')
  const kept = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n12.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'in-block-unwitnessed', block: 64 } })
  check('a day in a block is asked again, never sent again, until somebody witnesses it', n12.sent().length === 0 && kept.status === 'in-block-unwitnessed' && kept.block === 64)

  // A record from before there were witnesses says confirmed with nobody behind it. It must not keep the word.
  const n13 = node({ eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x40' } })
  const old13 = await mirrorChain({ chain: 'base', day: DAY, sha256: HASH, key: KEY, fetchImpl: n13.fetchImpl, env: {}, previous: { chain: 'base', sha256: HASH, tx: '0x' + 'ab'.repeat(32), status: 'confirmed', block: 64 } })
  check('a day called confirmed with no witness named is asked again, and nothing is sent', n13.asked.length > 0 && n13.sent().length === 0 && old13.witnessed_by.length === 3)
  // And if it never gets witnessed, it is a gap that alerts, however old the day is: the catch-up window would
  // otherwise leave such a record saying "confirmed" for good (review, 14.11).
  check('...and a confirmed record with nobody behind it raises an alert at any age', /no independent source named/.test(runVerdict([{ day: DAY, mirrors: [{ chain: 'base', status: 'confirmed', block: 64 }] }], Date.parse('2026-11-13T00:00:00Z')).bad.join()))
  check('...and until somebody answers, it still counts as work', needsWork({ day: DAY, mirrors: [{ chain: 'base', status: 'confirmed', block: 64 }] }, ['base'], Date.parse('2026-11-13T00:00:00Z')) === true)
  check('...while a witnessed one is finished', needsWork({ day: DAY, mirrors: [{ chain: 'base', status: 'confirmed', block: 64, witnessed_by: ['w.test'] }] }, ['base'], Date.parse('2026-11-13T00:00:00Z')) === false)

  const atNow = Date.parse('2026-11-13T00:00:00Z')
  const unw = (extra) => ({ day: DAY, mirrors: [{ chain: 'base', status: 'in-block-unwitnessed', unwitnessed: ['w.test: silent'], ...extra }] })
  check('a day in a block without a witness is work, so it is asked again tomorrow', needsWork(unw({}), ['base'], atNow) === true)
  check('...it raises nothing for the first day', runVerdict([unw({ first_sent_at: new Date(atNow - 3600e3).toISOString() })], atNow).ok === true)
  check('...and after a day it does, because nobody independent can see our own mirror', /no independent source confirming it/.test(runVerdict([unw({ first_sent_at: new Date(atNow - STALE_PENDING_MS - 1).toISOString() })], atNow).bad.join()))
  check('a contradicted mirror alerts at once, and says what the other source saw', /CONTRADICTED/.test(runVerdict([{ day: DAY, mirrors: [{ chain: 'base', status: 'contradicted', contradicted: ['w.test: it carries 2026-01-01'] }] }], atNow).bad.join()))
}

console.log('what still needs doing, and what raises an alert')
const at = Date.parse('2026-11-13T00:00:00Z')
const both2 = (status, extra = {}) => ({ day: DAY, mirrors: [{ chain: 'base', status, ...(status === 'confirmed' ? { witnessed_by: ['w.test'] } : {}), ...extra }, { chain: 'robinhood', status, ...(status === 'confirmed' ? { witnessed_by: ['w.test'] } : {}), ...extra }] })
check('a day confirmed on both chains needs nothing', needsWork(both2('confirmed'), undefined, at) === false)
check('a day with no record at all needs a write', needsWork(null, undefined, at) === true)
check('a chain missing from the record needs a write', needsWork({ day: DAY, mirrors: [{ chain: 'base', status: 'confirmed' }] }, undefined, at) === true)
check('a write refused earlier is tried again', needsWork(both2('skipped'), undefined, at) === true)
check('a transaction submitted an hour ago is left to settle', needsWork(both2('pending', { sent_at: new Date(at - 3600e3).toISOString() }), undefined, at) === false)
check('...one submitted over a day ago is lost, and the day is written again', needsWork(both2('pending', { sent_at: new Date(at - STALE_PENDING_MS - 1).toISOString() }), undefined, at) === true)
check('a pending with no time at all counts as lost', needsWork(both2('pending'), undefined, at) === true)
check('a day confirmed on both chains raises nothing', runVerdict([both2('confirmed')], at).ok === true)
check('a chain that refused raises an alert naming the day and the chain', /2026-11-12 base/.test(runVerdict([both2('skipped', { reason: 'the balance does not cover one write' })], at).bad.join()))
check('a transaction stuck without a block raises an alert too, which nothing else would', /still not in a block/.test(runVerdict([both2('pending', { sent_at: new Date(at - STALE_PENDING_MS - 1).toISOString() })], at).bad.join()))
check('a thin balance raises its own alert while the write itself succeeded', (() => { const v = runVerdict([{ day: DAY, mirrors: [{ chain: 'base', status: 'confirmed', witnessed_by: ['w.test', 'w2.test'], days_left: 3 }] }], at); return !v.bad.length && v.low.length === 1 && !v.ok })())
check('a chain we do not know is refused before anything is signed', await threwAsync(() => mirrorDay({ outDir, day: DAY, key: KEY, chains: ['Base'], fetchImpl: node().fetchImpl, env: {}, log: () => {} })))

console.log('catching up the days before')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-catchup-'))
  for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) fs.writeFileSync(path.join(dir, `manifest-${d}.json`), '{}')
  // 11.11 is done on both chains; 10.11 has a chain that refused; 09.11 was never written at all. 08.11 has no
  // manifest, so there is nothing to mirror for it.
  fs.writeFileSync(path.join(dir, 'mirror-2026-11-11.json'), JSON.stringify({ day: '2026-11-11', sha256: 'x', mirrors: [{ chain: 'base', status: 'confirmed', witnessed_by: ['w.test'] }, { chain: 'robinhood', status: 'confirmed', witnessed_by: ['w.test'] }] }))
  fs.writeFileSync(path.join(dir, 'mirror-2026-11-10.json'), JSON.stringify({ day: '2026-11-10', sha256: 'x', mirrors: [{ chain: 'base', status: 'confirmed', witnessed_by: ['w.test'] }, { chain: 'robinhood', status: 'skipped' }] }))
  const ran = []
  const done = await catchUp({ outDir: dir, day: '2026-11-12', key: KEY, run: async ({ day, wait }) => { ran.push(day); return { day, mirrors: [], waited: wait } } })
  check('only the days that still have something to do are written again', ran.join() === '2026-11-10,2026-11-09')
  check('...a day finished on every chain is left alone, and a day with no manifest is not invented', !ran.includes('2026-11-11') && !ran.includes('2026-11-08'))
  check('...and it does not wait for a block, so a congested chain cannot run the unit out of time', (await done[0].waited()).status === undefined)
  check('the window is bounded, so the work of a run cannot grow with the archive', (await catchUp({ outDir: dir, day: '2026-11-12', days: 1, key: KEY, run: async ({ day }) => { return { day, mirrors: [] } } })).length <= 1)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('the key')
const keyFile = path.join(tmp, 'anchor.key')
fs.writeFileSync(keyFile, KEY.toString('hex') + '\n')
check('the key is read from a file, never from an argument or the environment', loadKey({ STP_ANCHOR_KEY_FILE: keyFile }).equals(KEY))
fs.writeFileSync(path.join(tmp, 'anchor-key'), '0x' + KEY.toString('hex'))
check('systemd credentials are found by name, so the unit configures the path once', loadKey({ CREDENTIALS_DIRECTORY: tmp }).equals(KEY))
fs.writeFileSync(path.join(tmp, 'short.key'), 'abcd\n')
check('a file that is not a key is refused', threw(() => loadKey({ STP_ANCHOR_KEY_FILE: path.join(tmp, 'short.key') })))
check('no key at all is an error that says what to do', threw(() => loadKey({})))
check('both chains are configured with a chain id and a public rpc', Object.values(MIRRORS).every((m) => Number.isInteger(m.chainId) && /^https:/.test(m.rpc)))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
