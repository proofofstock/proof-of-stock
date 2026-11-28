// scripts/stocks/health-b20.test.mjs: health-check tells the owner about the B20 changes in the site's outbox exactly as
// promised (docs/b20-transfers-tz.md §5, and the stress reviews after it): read with a resumable cursor, batched, each
// line with its stable event id; told only when Telegram took the message; a short retry_after waited for; the cursor
// saved after each message, and a save that fails stops the run; a cursor file that cannot be read stops and is a
// health alert; events the site dropped are said; a first run tells what the site holds. And a blind reader is a health
// alert that clears. Synthetic events, a fake Telegram; no outside call.
//
// Run: node scripts/stocks/health-b20.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendB20Events, readB20State, b20SentFile, evaluate, B20_BATCH_EVENTS, B20_BLIND_S, B20_SKIP_AFTER_RUNS } from './health-check.mjs'
import { sendTelegram, alert } from '../lib/alert.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-health-b20-'))
const T = '0xb2000000000000000000001e800a7f5189430cd0', K = '0x' + 'a1'.repeat(20)
const ev = (seq, o = {}) => ({ seq, id: `b20-${seq}-${'0'.repeat(11)}${seq % 10}`, token: T, symbol: 'TSLAc', block: 100 + seq, block_hash: '0x' + 'c'.repeat(64), at: 'z', kind: 'paused', scope: null, account: null, address: null, from: seq % 2 === 0, to: seq % 2 === 1, ...o })
/** A site outbox of `events`, paged like /api/status/b20/events. */
const site = (events, { oldest = events.length ? events[0].seq : null } = {}) => async (after) => ({ events: events.filter((e) => e.seq > after).slice(0, 200), oldest, last: events.length ? events[events.length - 1].seq : 0 })
const tg = () => { const msgs = []; const send = async (text) => { msgs.push(text); return { ok: true, messageId: msgs.length } }; return { msgs, send } }

console.log('a first run, then nothing twice')
{
  const file = path.join(tmp, 'a.json')
  const t = tg()
  const events = [ev(1), ev(2), ev(3, { kind: 'answer', scope: 'receiver', account: 'kyberswap_router', address: K, from: true, to: false })]
  const r = await sendB20Events({ fetchEvents: site(events), file, send: t.send })
  check('no cursor file yet: every event the site holds is told, in one message', r.sent.length === 3 && t.msgs.length === 1)
  check('...each line carries its stable event id and what changed', events.every((e) => t.msgs[0].includes(`[${e.id}]`)) && /transfers paused/.test(t.msgs[0]) && /kyberswap_router .* TRANSFER_RECEIVER_POLICY: allowed -> refused/.test(t.msgs[0]) && /not a verdict change/.test(t.msgs[0]))
  check('the cursor is the last event told', readB20State(file).state.cursor === 3)
  const again = await sendB20Events({ fetchEvents: site(events), file, send: t.send })
  check('the next run, the same outbox: nothing sent again', again.sent.length === 0 && t.msgs.length === 1)
  const more = [...events, ev(4)]
  check('a new event: only it', (await sendB20Events({ fetchEvents: site(more), file, send: t.send })).sent.join() === ev(4).id && t.msgs.length === 2)
}

console.log('a burst is batched')
{
  const file = path.join(tmp, 'b.json')
  const t = tg()
  const events = Array.from({ length: 2 * B20_BATCH_EVENTS + 10 }, (_, i) => ev(i + 1))
  const r = await sendB20Events({ fetchEvents: site(events), file, send: t.send })
  check(`${events.length} events: ${Math.ceil(events.length / B20_BATCH_EVENTS)} messages, all told`, r.sent.length === events.length && t.msgs.length === Math.ceil(events.length / B20_BATCH_EVENTS) && readB20State(file).state.cursor === events.length)
}

console.log('told only when Telegram took it')
{
  const file = path.join(tmp, 'c.json')
  const events = [ev(1), ev(2)]
  const no = await sendB20Events({ fetchEvents: site(events), file, send: async () => ({ ok: false, why: 'answered 200 not ok' }) })
  check('Telegram answered but not ok: nothing told, the cursor where it was', no.sent.length === 0 && readB20State(file).state.cursor === 0 && readB20State(file).state.fail.runs === 1)
  let waits = [], calls = 0
  const r = await sendB20Events({ fetchEvents: site(events), file, sleep: async (ms) => { waits.push(ms) }, send: async () => (++calls === 1 ? { ok: false, retryAfterS: 3 } : { ok: true, messageId: 9 }) })
  check('a 429 with a short retry_after: waited for, then sent', waits.join() === '3000' && r.sent.length === 2)
  const file2 = path.join(tmp, 'c2.json')
  const long = await sendB20Events({ fetchEvents: site(events), file: file2, sleep: async (ms) => { waits.push(ms) }, send: async () => ({ ok: false, retryAfterS: 600 }) })
  check('a long retry_after: not waited for in the run; the events wait for the next one', long.sent.length === 0 && !waits.includes(600000))
  // sendTelegram itself: a 200 without ok, a 200 with ok but no message id, and a real answer.
  const env = { STP_ALERT_TELEGRAM_TOKEN: 't', STP_ALERT_TELEGRAM_CHAT: 'c' }
  const ans = (status, body) => async () => ({ ok: status < 400, status, json: async () => body })
  check('sendTelegram: delivered only on 200, ok:true and a message id', !(await sendTelegram('x', { env, fetchImpl: ans(200, { ok: false }) })).ok && !(await sendTelegram('x', { env, fetchImpl: ans(200, { ok: true, result: {} }) })).ok && (await sendTelegram('x', { env, fetchImpl: ans(200, { ok: true, result: { message_id: 7 } }) })).messageId === 7)
  check('...and a 429 gives its retry_after', (await sendTelegram('x', { env, fetchImpl: ans(429, { ok: false, parameters: { retry_after: 12 } }) })).retryAfterS === 12)
  check('...and without a bot configured nothing counts as sent', !(await sendTelegram('x', { env: {} })).ok)
}

console.log('the cursor file')
{
  const bad = path.join(tmp, 'corrupt.json')
  fs.writeFileSync(bad, '{ not json')
  const t = tg()
  const r = await sendB20Events({ fetchEvents: site([ev(1)]), file: bad, send: t.send })
  check('a cursor file that cannot be read: nothing sent, and a health alert', r.sent.length === 0 && t.msgs.length === 0 && r.checks.some((c) => c.key === 'b20:state' && c.bad))
  const file = path.join(tmp, 'd.json')
  let writes = 0
  const t2 = tg()
  const events = Array.from({ length: B20_BATCH_EVENTS + 5 }, (_, i) => ev(i + 1))
  const w = await sendB20Events({ fetchEvents: site(events), file, send: t2.send, write: () => (++writes, false) })
  check('a cursor save that fails after a send: the run stops at once, and a health alert', t2.msgs.length === 1 && writes === 1 && w.checks.some((c) => c.key === 'b20:state' && c.bad))
  check('the file sits beside the alert state, in the unit\'s state directory', b20SentFile({ STP_ALERT_STATE: '/var/lib/stp-alerts/state.json' }).replace(/\\/g, '/') === '/var/lib/stp-alerts/b20-sent.json')
}

console.log('events the site dropped are said')
{
  const file = path.join(tmp, 'e.json')
  fs.writeFileSync(file, JSON.stringify({ cursor: 2 }))
  const t = tg()
  const r = await sendB20Events({ fetchEvents: site([ev(10), ev(11)], { oldest: 10 }), file, send: t.send })
  check('the outbox starts after our cursor: the gap is said in the message, then the events', r.sent.length === 2 && /changes 3 to 9 are not in the site's outbox/.test(t.msgs[0]))
}

console.log('the upgrade from the release before')
{
  // The exact shape the release before this one wrote to the same file.
  const file = path.join(tmp, 'legacy.json')
  fs.writeFileSync(file, JSON.stringify({ tokens: { [T]: { policies: { sender: '0', receiver: '9', executor: '0' }, paused: false, answers: { 'ordinary_wallet|receiver': false }, block: 100 } }, told: [`${T}|paused||||120`] }))
  const t = tg()
  const r = await sendB20Events({ fetchEvents: site([ev(1), ev(2), ev(3)]), file, send: t.send })
  check('the deployed release\'s { tokens, told } file is no error: its outbox did not exist, so every event the new one holds is told', r.sent.length === 3 && t.msgs.length === 1 && !r.checks.some((c) => c.bad) && readB20State(file).state.cursor === 3)
  const r2 = await sendB20Events({ fetchEvents: site([ev(1), ev(2), ev(3), ev(4)]), file, send: t.send })
  check('...and after that only the next change', r2.sent.join() === ev(4).id)
  const odd = path.join(tmp, 'odd.json')
  fs.writeFileSync(odd, JSON.stringify({ cursor: 'x', extra: 1 }))
  const r3 = await sendB20Events({ fetchEvents: site([ev(1)]), file: odd, send: t.send })
  check('an object with no valid cursor that is not the legacy shape: an error with a health alert, nothing sent', r3.sent.length === 0 && r3.checks.some((c) => c.key === 'b20:state' && c.bad))
}

console.log('gaps and resets inside the outbox')
{
  const file = path.join(tmp, 'g.json')
  const t = tg()
  const r = await sendB20Events({ fetchEvents: site([ev(1), ev(2), ev(5), ev(6)]), file, send: t.send })
  check('a gap inside the outbox (3 and 4 missing): said, and the events around it told', r.sent.length === 4 && /changes 3 to 4 are not in the site's outbox/.test(t.msgs[0]))
  fs.writeFileSync(file, JSON.stringify({ cursor: 40 }))
  const t2 = tg()
  const r2 = await sendB20Events({ fetchEvents: site([ev(1), ev(2)]), file, send: t2.send })
  check('an outbox reset below our cursor: said, and its new events told from the start', r2.sent.length === 2 && /outbox was reset/.test(t2.msgs[0]) && readB20State(file).state.cursor === 2)
}

console.log('a batch Telegram keeps refusing does not block the rest')
{
  const file = path.join(tmp, 'f.json')
  const events = Array.from({ length: B20_BATCH_EVENTS + 3 }, (_, i) => ev(i + 1))
  let n = 0
  const sendBad = async () => { n++; return n <= B20_SKIP_AFTER_RUNS ? { ok: false, why: 'answered 400' } : { ok: true, messageId: n } }
  for (let i = 0; i < B20_SKIP_AFTER_RUNS - 1; i++) await sendB20Events({ fetchEvents: site(events), file, send: sendBad })
  check('refused in the runs before the last try: the cursor waits', readB20State(file).state.cursor === 0)
  const r = await sendB20Events({ fetchEvents: site(events), file, send: sendBad })
  check(`refused ${B20_SKIP_AFTER_RUNS} runs: moved past with a health alert naming its ids, and the next batch is told`, r.checks.some((c) => c.key.startsWith('b20:undelivered:') && c.bad && c.text.includes(events[0].id)) && r.sent.length > 0 && !r.sent.includes(events[0].id) && r.sent.includes(events[events.length - 1].id) && readB20State(file).state.cursor === events.length)
  // A send that never answers: the run's budget holds.
  const file2 = path.join(tmp, 'h.json')
  const t0 = Date.now()
  const hang = await sendB20Events({ fetchEvents: site([ev(1)]), file: file2, send: () => new Promise((r) => setTimeout(() => r({ ok: false, why: 'late' }), 5000)), budgetMs: 200 })
  check('a send that does not answer in time: the run ends within its budget, nothing told', hang.sent.length === 0 && Date.now() - t0 < 2000)
}

console.log('the alert throttle is recorded only after delivery')
{
  const state = path.join(tmp, 'alert-state.json')
  const env = { STP_ALERT_TELEGRAM_TOKEN: 't', STP_ALERT_TELEGRAM_CHAT: 'c', STP_ALERT_STATE: state }
  const down = async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) })
  const up = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) })
  check('an outage alert Telegram did not take: failed, and not recorded', (await alert({ key: 'k', text: 'x' }, { env, fetchImpl: down, log: () => {} })) === 'failed' && !fs.existsSync(state))
  check('...so the next run sends it, and only then is it recorded', (await alert({ key: 'k', text: 'x' }, { env, fetchImpl: up, log: () => {} })) === 'sent' && JSON.parse(fs.readFileSync(state, 'utf8')).k.resolved === false)
  check('a recovery Telegram did not take: failed, and the outage stays open', (await alert({ key: 'k', text: 'y', ok: true }, { env, fetchImpl: down, log: () => {} })) === 'failed' && JSON.parse(fs.readFileSync(state, 'utf8')).k.resolved === false)
  check('...so the recovery is sent next run', (await alert({ key: 'k', text: 'y', ok: true }, { env, fetchImpl: up, log: () => {} })) === 'sent' && JSON.parse(fs.readFileSync(state, 'utf8')).k.resolved === true)
}

console.log('a Telegram outage never moves the cursor')
{
  const file = path.join(tmp, 'out.json')
  const events = Array.from({ length: B20_BATCH_EVENTS + 3 }, (_, i) => ev(i + 1))
  const down = async () => ({ ok: false, why: 'unreachable' })
  for (let i = 0; i < B20_SKIP_AFTER_RUNS + 2; i++) await sendB20Events({ fetchEvents: site(events), file, send: down })
  check('Telegram down for more runs than the skip threshold: the cursor stays, nothing moved past', readB20State(file).state.cursor === 0)
  const t = tg()
  const r = await sendB20Events({ fetchEvents: site(events), file, send: t.send })
  check('...and when it comes back every change is told, the first batch included', r.sent.length === events.length && r.sent.includes(events[0].id) && !r.checks.some((c) => c.key.startsWith('b20:undelivered')))
  // A batch Telegram refuses while it takes other messages: moved past only once the loss notice was taken.
  const file2 = path.join(tmp, 'out2.json')
  const msgs = []
  const picky = async (text) => { msgs.push(text); return /B20 transfer rules changed/.test(text) && text.includes(`[${events[0].id}]`) ? { ok: false, why: 'answered 400' } : { ok: true, messageId: msgs.length } }
  for (let i = 0; i < B20_SKIP_AFTER_RUNS - 1; i++) await sendB20Events({ fetchEvents: site(events), file: file2, send: picky })
  const r2 = await sendB20Events({ fetchEvents: site(events), file: file2, send: picky })
  check('a batch refused while Telegram works: its loss notice is delivered first, then it is moved past', msgs.some((m) => /could not be delivered after/.test(m) && m.includes(events[0].id)) && readB20State(file2).state.cursor === events.length && r2.checks.some((c) => c.key.startsWith('b20:undelivered')))
}

console.log('an outbox reset seen by its epoch')
{
  const file = path.join(tmp, 'ep.json')
  fs.writeFileSync(file, JSON.stringify({ cursor: 2, epoch: 'a'.repeat(16) }))
  const t = tg()
  const page = async (after) => ({ events: [ev(1), ev(2), ev(3)].filter((e) => e.seq > after), oldest: 1, last: 3, epoch: 'b'.repeat(16) })
  const r = await sendB20Events({ fetchEvents: page, file, send: t.send })
  check('another epoch with a sequence past our cursor: the reset is said and the new outbox told from its start', r.sent.length === 3 && /outbox was reset/.test(t.msgs[0]) && readB20State(file).state.epoch === 'b'.repeat(16))
}

console.log('the shared alert state: no lost update between two writers')
{
  const state = path.join(tmp, 'shared', 'state.json')
  fs.mkdirSync(path.dirname(state), { recursive: true })
  const env = { STP_ALERT_STATE: state }
  // Another writer (the systemd notifier) holds the lock, having read the state before this alert starts.
  fs.writeFileSync(state + '.lock', '')
  const theirs = {}
  const p = alert({ key: 'health:a', text: 'x' }, { env, log: () => {} })
  await new Promise((r) => setTimeout(r, 30))
  theirs['notifier:b'] = { at: 1, resolved: false }
  fs.writeFileSync(state, JSON.stringify(theirs))
  fs.unlinkSync(state + '.lock')
  await p
  const both = JSON.parse(fs.readFileSync(state, 'utf8'))
  check('a writer waits for the lock, then reads again: both entries are kept', both['health:a'] && both['notifier:b'])
  // Eight processes recording at once.
  const { spawn } = await import('node:child_process')
  const lib = new URL('../lib/alert.mjs', import.meta.url).href
  const state2 = path.join(tmp, 'shared2', 'state.json')
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', `import { alert } from ${JSON.stringify(lib)}; await alert({ key: 'k${i}', text: 'x' }, { env: { STP_ALERT_STATE: ${JSON.stringify(state2)} }, log: () => {} })`], { stdio: 'ignore' })
    c.on('exit', resolve)
  })))
  const all = JSON.parse(fs.readFileSync(state2, 'utf8'))
  check('eight processes recording at once: all eight entries kept', Array.from({ length: 8 }, (_, i) => 'k' + i).every((k) => all[k]), Object.keys(all).join())
}

console.log('a blind reader')
{
  const now = Date.parse('2026-12-01T15:00:00Z')
  const st = (o) => ({ base: { b20: { reader: 'on', ...o } }, robinhood: {} })
  const key = (s) => evaluate({ status: s, now }).find((c) => c.key === 'b20:base:blind')
  check('no successful cycle since the start: bad', key(st({ last_ok_at: null, last_error: 'single_source' })).bad === true)
  check(`a last successful cycle older than ${B20_BLIND_S / 60} min: bad`, key(st({ last_ok_at: new Date(now - (B20_BLIND_S + 60) * 1000).toISOString() })).bad === true)
  check('a recent successful cycle: clears', key(st({ last_ok_at: new Date(now - 300e3).toISOString() })).bad === false)
  check('the reader off: no such check', evaluate({ status: { base: { b20: { reader: 'off' } }, robinhood: {} }, now }).every((c) => c.key !== 'b20:base:blind'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
