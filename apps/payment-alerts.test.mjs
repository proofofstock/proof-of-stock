// apps/payment-alerts.test.mjs: the paid-pass alarms reach the owner. The site keeps what stp-health needs in
// /api/status (payments: paused, late settlements, the gas wallet), catching the one alarm the host-only payment module
// can only write to the journal; stp-health turns it into Telegram alerts (scripts/stocks/health-check.mjs).
// A fake payment module stands in for the host-only one, so this runs everywhere.
//
// Run: node apps/payment-alerts.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb } from './stocks-web.mjs'
import { paymentChecks, baseBalance, SETTLEMENT_GAS_MIN_WEI } from '../scripts/stocks/health-check.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const NOW = Date.parse('2026-11-20T12:00:00Z')
const TX = '0x' + 'f6'.repeat(32), WALLET = '0x' + '02'.repeat(20)

console.log('the site keeps the payment state for stp-health')
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-alerts-'))
  let modLog = null, pausedUntil = 0, t = NOW
  const fake = (opts) => {
    modLog = opts.log
    return { enabled: true, wallet: WALLET, priceUsd: 0.01, passMinutes: 10, passRate: 600, description: 'a pass',
      pausedUntil: () => pausedUntil, passActive: () => false, passRateOf: () => null, accepts: () => null, purchase: async () => ({ ok: false, status: 402, error: 'no' }) }
  }
  const said = []
  const app = createStocksWeb({ roots: { base: path.join(root, 'b'), robinhood: path.join(root, 'r') }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    now: () => t, log: (m) => said.push(String(m)), analytics: { enabled: false }, exam: { url: null }, x402Module: fake })
  const { port } = await app.start(0, '127.0.0.1')
  const status = async () => (await (await fetch(`http://127.0.0.1:${port}/stocks/api/status`)).json()).payments
  try {
    const s0 = await status()
    check('with passes on, status names the settlement wallet, not paused, nothing late', s0.enabled === true && s0.settlement_wallet === WALLET && s0.paused_until === null && s0.late_settlements.length === 0, JSON.stringify(s0))
    modLog(`[x402] ALERT late settlement ${TX} still has no receipt after 10 min; reconcile by hand`)
    modLog('[x402] settled 0x' + 'aa'.repeat(32) + ' payer 0x' + '11'.repeat(20) + ' for 0.01 USDC')
    const s1 = await status()
    check('a late settlement the module could only log is kept, with its transaction', s1.late_settlements.length === 1 && s1.late_settlements[0].transaction === TX && s1.late_settlements[0].at === new Date(NOW).toISOString(), JSON.stringify(s1))
    check('...and the line still reaches the journal', said.some((m) => m.includes('ALERT late settlement')))
    pausedUntil = NOW + 30 * 60e3
    check('a pause shows until when', (await status()).paused_until === new Date(NOW + 30 * 60e3).toISOString())
    t = NOW + 25 * 3600e3
    const s2 = await status()
    check('a day later the late settlement has left the status, and the pause is over', s2.late_settlements.length === 0 && s2.paused_until === null)
  } finally { await app.stop?.(); fs.rmSync(root, { recursive: true, force: true }) }
  const app2 = createStocksWeb({ roots: { base: path.join(os.tmpdir(), 'none-b'), robinhood: path.join(os.tmpdir(), 'none-r') }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    now: () => NOW, log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module: null })
  const { port: p2 } = await app2.start(0, '127.0.0.1')
  try {
    const off = (await (await fetch(`http://127.0.0.1:${p2}/stocks/api/status`)).json()).payments
    check('with passes off, status says only that', JSON.stringify(off) === '{"enabled":false}')
  } finally { await app2.stop?.() }
}

console.log('stp-health turns it into alerts')
{
  const base = { enabled: true, settlement_wallet: WALLET, paused_until: null, late_settlements: [] }
  const keys = (cs) => cs.map((c) => (c.bad ? '!' : '') + c.key).join(' ')
  check('passes off: no check at all', paymentChecks({ payments: { enabled: false }, now: NOW }).length === 0 && paymentChecks({ payments: null, now: NOW }).length === 0)
  const fine = paymentChecks({ payments: base, balanceWei: 10n ** 15n, now: NOW })
  check('all well: the pause and the gas checks are good, so they clear an earlier alert', keys(fine) === 'x402:paused x402:gas')
  const paused = paymentChecks({ payments: { ...base, paused_until: new Date(NOW + 60e3).toISOString() }, balanceWei: 10n ** 15n, now: NOW })
  check('paused: an alert that says until when', paused[0].bad && paused[0].key === 'x402:paused' && paused[0].text.includes(new Date(NOW + 60e3).toISOString()))
  const late = paymentChecks({ payments: { ...base, late_settlements: [{ transaction: TX, at: new Date(NOW - 5 * 60e3).toISOString() }] }, balanceWei: 10n ** 15n, now: NOW })
  const l = late.find((c) => c.key === 'x402:late:' + TX)
  check('a fresh late settlement: one alert of its own, with the BaseScan link and what to do', l && l.bad && l.text.includes('https://basescan.org/tx/' + TX) && /refund it by hand/.test(l.text))
  const old = paymentChecks({ payments: { ...base, late_settlements: [{ transaction: TX, at: new Date(NOW - 60 * 60e3).toISOString() }] }, balanceWei: 10n ** 15n, now: NOW })
  check('...an hour later it is not sent again, and never "resolved": it is a task for a person', !old.some((c) => c.key.startsWith('x402:late:')))
  check('a malformed transaction in the status is ignored', !paymentChecks({ payments: { ...base, late_settlements: [{ transaction: '<b>', at: new Date(NOW).toISOString() }] }, now: NOW }).some((c) => c.key.startsWith('x402:late')))
  const low = paymentChecks({ payments: base, balanceWei: SETTLEMENT_GAS_MIN_WEI - 1n, now: NOW }).find((c) => c.key === 'x402:gas')
  check('gas below a day of settlements: an alert naming the wallet and the balance', low.bad && low.text.includes(WALLET) && /top it up/.test(low.text))
  check('...at the threshold it is fine', !paymentChecks({ payments: base, balanceWei: SETTLEMENT_GAS_MIN_WEI, now: NOW }).find((c) => c.key === 'x402:gas').bad)
  const unread = paymentChecks({ payments: base, balanceError: 'timeout', now: NOW }).find((c) => c.key === 'x402:gas')
  check('a balance that cannot be read is an alert, never silence', unread && unread.bad && /could not be read/.test(unread.text))
  const asked = []
  const wei = await baseBalance(WALLET, { env: {}, fetchImpl: async (url, o) => { asked.push([url, JSON.parse(o.body)]); return { json: async () => ({ result: '0x38d7ea4c68000' }) } } })
  check('the balance is read with eth_getBalance from the public Base node by default', wei === 10n ** 15n && asked[0][0] === 'https://mainnet.base.org' && asked[0][1].method === 'eth_getBalance' && asked[0][1].params[0] === WALLET)
  let threw = false
  try { await baseBalance(WALLET, { env: {}, fetchImpl: async () => ({ json: async () => ({ error: { message: 'rate limited' } }) }) }) } catch (e) { threw = /rate limited/.test(e.message) }
  check('...and an RPC error is an error, not a zero balance', threw)
}
const src = fs.readFileSync(new URL('../scripts/stocks/health-check.mjs', import.meta.url), 'utf8')
check('stp-health runs the payment checks on what /api/status says', src.includes('checks.push(...paymentChecks({ payments, balanceWei, balanceError, now }))'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
