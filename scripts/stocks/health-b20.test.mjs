// scripts/stocks/health-b20.test.mjs: health-check tells the owner about each B20 transfer-rule change once
// (docs/b20-transfers-tz.md §5). It takes the difference between the site's current baselines and the one it last told
// the owner about, so a restart of the site or a burst of changes loses nothing; a change counts as told only when
// Telegram took it ('logged' and 'failed' are tried again); the kept baseline is written after each alert sent, so a
// run cut short repeats nothing. Synthetic snapshots, a fake alert; no outside call.
//
// Run: node scripts/stocks/health-b20.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendB20Changes, b20SentFile } from './health-check.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-health-b20-'))
const T = '0xb2000000000000000000001e800a7f5189430cd0', K = '0x' + 'a1'.repeat(20)
const snap = (o = {}) => ({ symbol: 'TSLAc', block: 100, policies: { sender: '0', receiver: '9', executor: '0' }, paused: false, answers: { 'ordinary_wallet|receiver': false, ['kyberswap_router:' + K + '|receiver']: true }, ...o })
const status = (tokens, changes = []) => ({ base: { b20: { reader: 'on', tokens, changes } }, robinhood: {} })
const kept = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).tokens

console.log('one alert per change, once')
{
  const file = path.join(tmp, 'a.json')
  const sent = []
  const fake = async (a) => { sent.push(a); return 'sent' }
  check('first sight of a token: kept, no alert', (await sendB20Changes({ status: status({ [T]: snap() }), file, alertImpl: fake })).length === 0 && sent.length === 0 && kept(file)[T].policies.receiver === '9')
  const next = snap({ block: 101, paused: true, answers: { 'ordinary_wallet|receiver': false, ['kyberswap_router:' + K + '|receiver']: false } })
  const r = await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: fake })
  check('two changes (the pause, a venue\'s answer): two alerts, keyed by the token', r.length === 2 && sent.length === 2 && sent.every((a) => a.key === `b20:base:${T}`))
  check('...naming the token, the scope and what changed, as the issuer\'s rule, not a verdict', sent.some((a) => /transfers paused/.test(a.text)) && sent.some((a) => /kyberswap_router .* TRANSFER_RECEIVER_POLICY: allowed -> refused/.test(a.text)) && sent.every((a) => /TSLAc/.test(a.text) && /not a verdict change/.test(a.text)))
  check('the next run, the same state: nothing sent again', (await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: fake })).length === 0 && sent.length === 2)
  check('the site restarted and holds the same rules: nothing is lost, nothing repeated', (await sendB20Changes({ status: status({ [T]: { ...next, block: 200 } }), file, alertImpl: fake })).length === 0)
  const moved = snap({ block: 300, paused: true, policies: { sender: '0', receiver: '12', executor: '0' }, answers: next.answers })
  check('a change the site saw while health-check was not running is still sent, from the difference', (await sendB20Changes({ status: status({ [T]: moved }), file, alertImpl: fake })).length === 1 && /id 9 -> 12/.test(sent[2].text))
}

console.log('told only when Telegram took it')
{
  const file = path.join(tmp, 'b.json')
  await sendB20Changes({ status: status({ [T]: snap() }), file, alertImpl: async () => 'sent' })
  const next = snap({ block: 101, paused: true })
  let n = 0
  check('no bot configured (\'logged\'): not counted as told', (await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: async () => { n++; return 'logged' } })).length === 0 && kept(file)[T].paused === false)
  check('Telegram failed: not counted either', (await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: async () => { n++; return 'failed' } })).length === 0 && kept(file)[T].paused === false)
  check('an alert that throws does not throw out of the run', (await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: async () => { throw new Error('boom') } })).length === 0)
  check('...so once the bot answers, the change is sent', (await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: async () => 'sent' })).length === 1 && kept(file)[T].paused === true)
}

console.log('a run cut short repeats nothing')
{
  const file = path.join(tmp, 'c.json')
  await sendB20Changes({ status: status({ [T]: snap() }), file, alertImpl: async () => 'sent' })
  const next = snap({ block: 101, paused: true, answers: { 'ordinary_wallet|receiver': true, ['kyberswap_router:' + K + '|receiver']: false } })
  let calls = 0, onDisk = null
  // The first alert goes through; while the second is being sent (a kill would land here), the file already holds the
  // first. That second one then fails, as a cut-off run leaves it.
  await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: async () => { calls++; if (calls > 1) { onDisk = kept(file)[T]; throw new Error('killed') } return 'sent' } })
  check('the first change is on disk before the second alert is sent', onDisk && onDisk.paused === true)
  const sent = []
  await sendB20Changes({ status: status({ [T]: next }), file, alertImpl: async (a) => { sent.push(a); return 'sent' } })
  check('the change sent before the cut is not sent again; the rest are', calls >= 2 && sent.length === 2 && !sent.some((a) => /transfers paused/.test(a.text)), JSON.stringify(sent.map((a) => a.text.slice(0, 80))))
}

console.log('changes between two runs, and never backwards')
{
  const file = path.join(tmp, 'e.json')
  await sendB20Changes({ status: status({ [T]: snap() }), file, alertImpl: async () => 'sent' })
  const sent = []
  const fake = async (a) => { sent.push(a); return 'sent' }
  // Paused at block 110, unpaused at 120: by the time this job runs again the baseline is unpaused as before.
  const list = [
    { token: T, symbol: 'TSLAc', block: 120, at: '2026-12-01T15:10:00.000Z', kind: 'paused', scope: null, account: null, address: null, from: true, to: false },
    { token: T, symbol: 'TSLAc', block: 110, at: '2026-12-01T15:05:00.000Z', kind: 'paused', scope: null, account: null, address: null, from: false, to: true },
  ]
  const r = await sendB20Changes({ status: status({ [T]: snap({ block: 125 }) }, list), file, alertImpl: fake })
  check('a pause and an unpause between two runs: two alerts, in block order', r.length === 2 && /transfers paused/.test(sent[0].text) && /unpaused/.test(sent[1].text), JSON.stringify(r))
  check('...not again on the next run with the same list', (await sendB20Changes({ status: status({ [T]: snap({ block: 130 }) }, list), file, alertImpl: fake })).length === 0 && sent.length === 2)
  // The site restarted and its first reading is an older head than the last one told: nothing is compared.
  const before = sent.length
  check('a baseline at a block not above the last told: never diffed backwards', (await sendB20Changes({ status: status({ [T]: snap({ block: 105, paused: true }) }), file, alertImpl: fake })).length === 0 && sent.length === before && kept(file)[T].block === 130)
  const old = [{ token: T, symbol: 'TSLAc', block: 100, at: 'x', kind: 'paused', scope: null, account: null, address: null, from: false, to: true }]
  check('a listed change at a block not above the last told: not sent', (await sendB20Changes({ status: status({ [T]: snap({ block: 130 }) }, old), file, alertImpl: fake })).length === 0)
  // Two changes in one block; the second alert fails. The next run sends that one only.
  const two = [
    { token: T, symbol: 'TSLAc', block: 150, at: 'z', kind: 'paused', scope: null, account: null, address: null, from: false, to: true },
    { token: T, symbol: 'TSLAc', block: 150, at: 'z', kind: 'policy_id', scope: 'sender', account: null, address: null, from: '0', to: '3' },
  ]
  let k2 = 0
  const half = await sendB20Changes({ status: status({ [T]: snap({ block: 150, paused: true, policies: { sender: '3', receiver: '9', executor: '0' } }) }, two), file, alertImpl: async () => (++k2 === 1 ? 'sent' : 'failed') })
  const rest = []
  const second = await sendB20Changes({ status: status({ [T]: snap({ block: 150, paused: true, policies: { sender: '3', receiver: '9', executor: '0' } }) }, two), file, alertImpl: async (a) => { rest.push(a); return 'sent' } })
  check('two changes in one block, the second alert failed: the next run sends that one, and only that one', half.length === 1 && second.length === 1 && rest.length === 1 && /TRANSFER_SENDER_POLICY id 0 -> 3/.test(rest[0].text), JSON.stringify([half, second]))
  const ans = [{ token: T, symbol: 'TSLAc', block: 160, at: 'y', kind: 'answer', scope: 'receiver', account: 'kyberswap_router', address: K, from: true, to: false }]
  check('a listed answer change is sent and kept under its answers key', (await sendB20Changes({ status: status({ [T]: snap({ block: 160, paused: true, policies: { sender: '3', receiver: '9', executor: '0' }, answers: { 'ordinary_wallet|receiver': false, ['kyberswap_router:' + K + '|receiver']: false } }) }, ans), file, alertImpl: fake })).length === 1 && kept(file)[T].answers['kyberswap_router:' + K + '|receiver'] === false)
}

console.log('what is not a change')
{
  const file = path.join(tmp, 'd.json')
  check('an entry without a token address, or no b20 block: nothing', (await sendB20Changes({ status: status({ 'not an address': snap() }), file, alertImpl: async () => 'sent' })).length === 0 && (await sendB20Changes({ status: { base: {} }, file, alertImpl: async () => 'sent' })).length === 0)
  check('the kept baseline sits beside the alert state, in the unit\'s state directory', b20SentFile({ STP_ALERT_STATE: '/var/lib/stp-alerts/state.json' }).replace(/\\/g, '/') === '/var/lib/stp-alerts/b20-sent.json' && b20SentFile({ STP_B20_SENT: '/x/y.json' }) === '/x/y.json')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
