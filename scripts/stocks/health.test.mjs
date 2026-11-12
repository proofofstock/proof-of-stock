// scripts/stocks/health.test.mjs: alerts reach the owner once, clear once, never leak the token and never throw; every
// health rule fires on its condition and clears without it; a change in a third party's format is seen.
//
// Run: node scripts/stocks/health.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alert } from '../lib/alert.mjs'
import { evaluate, lastRun, THRESHOLDS } from './health-check.mjs'
import { shapeOf, mergeShapes, shapeChanges } from '../../evm/core/stocks/shape.mjs'
import { recordShapes } from './stock-peg.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-health-'))

console.log('alerts')
{
  const sentTo = [], logs = []
  const env = { STP_ALERT_TELEGRAM_TOKEN: 'TOKEN-123', STP_ALERT_TELEGRAM_CHAT: '42', STP_ALERT_STATE: path.join(tmp, 'state.json') }
  const fetchImpl = async (url, init) => { sentTo.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 } }
  let t = 1_000_000
  const o = { env, fetchImpl, now: () => t, log: (m) => logs.push(m) }
  check('an alert goes to the owner\'s chat through the bot', (await alert({ key: 'a', text: 'x broke' }, o)) === 'sent' && sentTo[0].body.chat_id === '42' && /^Proof of Stock: ALERT x broke$/.test(sentTo[0].body.text) && sentTo[0].url.includes('/botTOKEN-123/sendMessage'))
  t += 60e3
  check('...the same key within the hour is not sent again', (await alert({ key: 'a', text: 'x broke' }, o)) === 'suppressed' && sentTo.length === 1)
  t += 3600e3
  check('...but after an hour it reminds', (await alert({ key: 'a', text: 'x broke' }, o)) === 'sent' && sentTo.length === 2)
  check('a cleared condition is said once', (await alert({ key: 'a', text: 'x works', ok: true }, o)) === 'sent' && /RESOLVED x works/.test(sentTo[2].body.text) && (await alert({ key: 'a', text: 'x works', ok: true }, o)) === 'none')
  check('...and a check that was never bad says nothing', (await alert({ key: 'b', text: 'fine', ok: true }, o)) === 'none' && sentTo.length === 3)
  const down = await alert({ key: 'c', text: 'y broke' }, { ...o, fetchImpl: async () => { throw new Error('ECONNRESET TOKEN-123') } })
  check('Telegram unreachable: no throw, written to the log, and the token never is', down === 'failed' && logs.some((l) => /y broke/.test(l)) && !logs.some((l) => l.includes('TOKEN-123')))
  check('no token or chat configured: the alert goes to the log only', (await alert({ key: 'd', text: 'z broke' }, { ...o, env: { STP_ALERT_STATE: env.STP_ALERT_STATE } })) === 'logged')
}

console.log('the health rules')
{
  const NOW = Date.parse('2026-11-12T12:00:00Z')
  const fresh = { registry_age_s: 60, registry_error: null, newest_reading_age_s: 300, impostors_age_s: 3600 }
  const run = { started_at: '2026-11-12T11:50:00Z', finished_at: '2026-11-12T11:55:00Z', tokens_considered: 100, pair_read_errors: 0, refused: {}, onchain: { error: null, read_errors: 0 }, registry: { error: null } }
  const bad = (checks) => checks.filter((c) => c.bad).map((c) => c.key).sort()
  const healthy = evaluate({ status: { base: fresh, robinhood: fresh }, runs: { base: run, robinhood: run }, now: NOW })
  check('a healthy site and recorder raise nothing', bad(healthy).length === 0, bad(healthy).join(','))
  check('the site not answering is an alert', bad(evaluate({ status: null, siteError: 'ECONNREFUSED', runs: {}, now: NOW })).includes('site:down'))
  const old = evaluate({ status: { base: { ...fresh, registry_age_s: THRESHOLDS.registry_age_s + 1 }, robinhood: fresh }, runs: {}, now: NOW })
  check('an issuer list older than 15 minutes is an alert that says the site answers "unavailable", never "not listed"', bad(old).join() === 'registry:base' && /never "not listed"/.test(old.find((c) => c.key === 'registry:base').text))
  check('a list read error is an alert too', bad(evaluate({ status: { base: { ...fresh, registry_error: 'the issuer registry could not be read' }, robinhood: fresh }, runs: {}, now: NOW })).join() === 'registry:base')
  check('stale readings and an old look-alike list are alerts', bad(evaluate({ status: { base: { ...fresh, newest_reading_age_s: 4000 }, robinhood: { ...fresh, impostors_age_s: 9 * 3600 } }, runs: {}, now: NOW })).join() === 'impostors:robinhood,readings:base')
  const rk = (r) => bad(evaluate({ status: { base: fresh, robinhood: fresh }, runs: { base: { ...run, ...r } }, now: NOW }))
  check('DexScreener failing for over 20% of a run (a 429 week) is an alert', rk({ pair_read_errors: 21 }).join() === 'dexscreener:base' && rk({ pair_read_errors: 20 }).length === 0)
  check('the chain unreadable is an alert', rk({ onchain: { error: 'rpc: no block', read_errors: 0 } }).join() === 'rpc:base' && rk({ onchain: { error: null, read_errors: 30 } }).join() === 'rpc:base')
  check('sources disagreeing on over 10% of tokens is an alert', rk({ refused: { sources_disagree: 11 } }).join() === 'disagree:base')
  check('a recorder that has not run for 30 minutes, or could not read its list, is an alert', rk({ finished_at: '2026-11-12T11:20:00Z' }).join() === 'run:base' && rk({ registry: { error: 'coinbase answered 503' } }).join() === 'run:base')
  const shaped = evaluate({ status: { base: fresh, robinhood: fresh }, runs: { base: { ...run, shape_changes: { 'coinbase:tokenized-stocks': ['new field tokens[].nav_source (string)'] } } }, now: NOW })
  check('a change in a source\'s format is an alert that names the change', bad(shaped).length === 1 && /new field tokens\[\]\.nav_source/.test(shaped.find((c) => c.bad).text))
  // lastRun reads the newest row of today's file, skipping a torn last line.
  const root = path.join(tmp, 'root'), d = path.join(root, 'stock-peg'); fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'stock-peg-runs-2026-11-12.jsonl'), JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }) + '\n{"torn')
  check('the last run row is today\'s newest whole line', lastRun(root, NOW)?.n === 2 && lastRun(path.join(tmp, 'none'), NOW) === null)
}

console.log('a change of format')
{
  const v1 = { tokens: [{ contract_address: '0x1', symbol: 'A', nav_price: '1.2' }, { contract_address: '0x2', symbol: 'B' }], next_page_token: '' }
  const s1 = shapeOf(v1)
  check('the shape lists every path with its types, and the size of the list', s1.paths['tokens[].contract_address'].join() === 'string' && s1.paths['tokens[].nav_price'].join() === 'string' && s1.sizes.tokens === 2)
  check('the same format again changes nothing', shapeChanges(s1, shapeOf(v1)).length === 0)
  const added = shapeChanges(s1, shapeOf({ ...v1, tokens: v1.tokens.map((t) => ({ ...t, venue: 'x' })) }))
  check('a new field is seen', added.length === 1 && /new field tokens\[\]\.venue \(string\)/.test(added[0]))
  check('a field that is gone is seen, and a type that changed', shapeChanges(s1, shapeOf({ tokens: [{ contract_address: '0x1', symbol: 1 }, { contract_address: '0x2', symbol: 'B' }], next_page_token: '' })).some((c) => /tokens\[\]\.nav_price is gone/.test(c)) && shapeChanges(s1, shapeOf({ tokens: [{ contract_address: '0x1', symbol: 1 }] })).some((c) => /tokens\[\]\.symbol is now number\|string, was string/.test(c) || /symbol is now/.test(c)))
  check('a list that shrank by more than 10% is seen', shapeChanges({ paths: {}, sizes: { tokens: 338 } }, { paths: {}, sizes: { tokens: 300 } }).some((c) => /shrank from 338 to 300/.test(c)))
  check('a run that read part of a source does not call missing fields gone', shapeChanges(s1, shapeOf({ tokens: [{ contract_address: '0x1' }] }), { complete: false }).every((c) => !/is gone/.test(c)))
  check('shapes of pages merge into one', mergeShapes([shapeOf({ a: [1] }), shapeOf({ a: ['x'] })]).paths['a[]'].join() === 'number,string')
  // The recorder keeps the last shape and returns only what changed.
  const out = path.join(tmp, 'peg'); fs.mkdirSync(out)
  check('the first run keeps a baseline and reports nothing', JSON.stringify(recordShapes(out, { 'coinbase:tokenized-stocks': [s1] })) === '{}')
  const ch = recordShapes(out, { 'coinbase:tokenized-stocks': [shapeOf({ ...v1, tokens: v1.tokens.map((t) => ({ ...t, venue: 'x' })) })] })
  check('...the next run reports the change, and keeps the new shape', ch['coinbase:tokenized-stocks']?.length === 1 && JSON.stringify(recordShapes(out, { 'coinbase:tokenized-stocks': [shapeOf({ ...v1, tokens: v1.tokens.map((t) => ({ ...t, venue: 'x' })) })] })) === '{}')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('a recorder close to its deadline')
{
  const { slowRuns, lastRuns } = await import('./health-check.mjs')
  const said = []
  const put = (key, bad, text) => said.push({ key, bad, text })
  const r = (d) => ({ duration_s: d, budget_s: 460 })
  slowRuns(put, 'Robinhood Chain', 'slow:robinhood', r(400), r(380))
  check('two runs at 80% or more of their budget: a warning, before anything is missing', said.length === 1 && said[0].bad === true && /87% of its time budget \(400 of 460 s\) two runs in a row/.test(said[0].text), JSON.stringify(said))
  said.length = 0; slowRuns(put, 'Robinhood Chain', 'slow:robinhood', r(400), r(300))
  check('...one slow run alone says nothing', said.length === 0)
  said.length = 0; slowRuns(put, 'Robinhood Chain', 'slow:robinhood', r(340), r(330))
  check('...between 70% and 80% says nothing either, so it neither pages nor resolves early', said.length === 0)
  said.length = 0; slowRuns(put, 'Robinhood Chain', 'slow:robinhood', r(120), r(130))
  check('...both under 70%: resolved', said.length === 1 && said[0].bad === false)
  said.length = 0; slowRuns(put, 'x', 'k', { duration_s: 10 }, r(400)); slowRuns(put, 'x', 'k', r(400), null)
  check('...a run row without duration or budget (older rows), or no earlier run: nothing', said.length === 0)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-runs-'))
  fs.mkdirSync(path.join(dir, 'stock-peg'))
  fs.writeFileSync(path.join(dir, 'stock-peg', 'stock-peg-runs-2026-11-12.jsonl'), JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }) + '\n')
  fs.writeFileSync(path.join(dir, 'stock-peg', 'stock-peg-runs-2026-11-11.jsonl'), JSON.stringify({ n: 0 }) + '\n')
  const two = lastRuns(dir, Date.parse('2026-11-12T12:00:00Z'), 2), three = lastRuns(dir, Date.parse('2026-11-12T12:00:00Z'), 3)
  check('lastRuns: newest first, reaching into yesterday when today has too few', two.map((x) => x.n).join() === '2,1' && three.map((x) => x.n).join() === '2,1,0')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('the chain mirror of the issuer list')
{
  const { mirrorChecks } = await import('./health-check.mjs')
  const now = Date.parse('2026-11-12T22:00:00Z')
  const said = []
  const put = (key, bad, text) => said.push({ key, bad, text })
  mirrorChecks(put, 'Robinhood Chain', 'robinhood', { updated_at: '2026-11-12T21:50:00Z', comparison: { on_list_not_created: ['0xdd'], created_not_on_list: ['0xcc'] } }, now)
  check('a listed token the factory never created: an alert naming it; a fresh mirror is fine', said.find((x) => x.key === 'mirror-list:robinhood')?.bad === true && /0xdd/.test(said.find((x) => x.key === 'mirror-list:robinhood').text) && said.find((x) => x.key === 'mirror-stale:robinhood')?.bad === false)
  said.length = 0
  mirrorChecks(put, 'Base', 'base', { updated_at: '2026-11-12T21:50:00Z', comparison: { on_list_not_created: [], created_not_on_list: ['0xcc', '0xee'] } }, now)
  check('...tokens the factory made that the list leaves out never alert', said.every((x) => x.bad === false))
  said.length = 0
  mirrorChecks(put, 'Base', 'base', { updated_at: '2026-11-12T19:00:00Z' }, now)
  check('...a mirror not updated for 2 hours says so, and one still backfilling compares nothing', said.length === 1 && said[0].key === 'mirror-stale:base' && said[0].bad === true)
  said.length = 0
  mirrorChecks(put, 'Base', 'base', undefined, now)
  check('...and a chain without a mirror says nothing', said.length === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
