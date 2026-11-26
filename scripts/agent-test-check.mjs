// scripts/agent-test-check.mjs: check an agent test receipt, now or months later (docs/agent-test-tz.md v3 §6).
//
//   node scripts/agent-test-check.mjs receipt.json            online: proves the receipt is ours, then replays it
//   node scripts/agent-test-check.mjs receipt.json --offline  consistency only: it never says "passed"
//
// Get a receipt with: curl -fsS https://proofofstock.xyz/api/agent-test/<test_id> > receipt.json
//
// Exit codes: 0 every online step passed; 2 offline and consistent, not proved ours; 3 the origin could not be reached,
// nothing proved; 1 a check failed. Node 20 or newer, no dependencies beyond this repository.
//
// ⚠ ONLY THE ONLINE STEP PROVES A RECEIPT IS OURS. Every hash in a receipt can be recomputed by whoever writes one, so a
//   forgery can be consistent with itself. Step 1 fetches the record from our pinned origin (receipt.mjs LIST_ORIGINS,
//   redirect: 'error') and compares the bytes; a receipt we never issued fails there.
import fs from 'node:fs'
import { isEntryPoint } from './lib/invoked-directly.mjs'
import { checkReceiptOffline, TEST_ID } from '../evm/core/stocks/agent-test.mjs'
import { canonicalRegistry, registryHash } from '../evm/core/stocks/history.mjs'
import { LIST_ORIGINS, isOurs } from '../evm/core/stocks/receipt.mjs'

export const EXIT = Object.freeze({ ok: 0, failed: 1, offline: 2, unreachable: 3, notPassed: 4, usage: 64 })
// The frozen lists are hashed in canonicalRegistry's own key order, whatever order a file holds them in.
const listHash = (canon) => registryHash(canonicalRegistry(canon))

/**
 * @param raw        the receipt file's bytes (Buffer or string)
 * @returns { code, lines: [string] }
 */
export async function checkAgentTestReceipt (raw, { offline = false, fetchImpl = fetch, origins = LIST_ORIGINS } = {}) {
  const lines = []
  const say = (ok, check, detail) => lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${check}: ${detail}`)
  let r
  try { r = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) } catch { lines.push('FAIL  the file is not JSON'); return { code: EXIT.failed, lines } }
  if (!r || typeof r !== 'object' || r.format !== 'pos-agent-test/1' || !TEST_ID.test(String(r.test_id))) {
    lines.push('FAIL  this is not an agent test receipt (format pos-agent-test/1 and a test id at_ + 32 hex)')
    return { code: EXIT.failed, lines }
  }
  let ours = false
  if (!offline) {
    // Step 1: the record, from our origin, byte for byte. The origin is pinned; the receipt's own `origin` must be one of ours.
    if (!isOurs(r.origin, origins)) { say(false, 'origin', 'the receipt names an origin that is not Proof of Stock'); return { code: EXIT.failed, lines } }
    const url = `${new URL(r.origin).origin}/api/agent-test/${r.test_id}`
    let res
    try { res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'proofofstock-agent-test-check' } }) } catch (e) {
      lines.push(`--    could not reach ${url} (${String(e && e.message || e).slice(0, 120)}): nothing is proved`)
      return { code: EXIT.unreachable, lines }
    }
    if (res.status === 404 || res.status === 410) { say(false, 'online', `${url} answers ${res.status}: Proof of Stock holds no such graded test now`); return { code: EXIT.failed, lines } }
    if (res.status !== 200) { lines.push(`--    ${url} answered ${res.status}: nothing is proved`); return { code: EXIT.unreachable, lines } }
    const served = Buffer.from(await res.arrayBuffer())
    const mine = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    ours = Buffer.compare(served, mine) === 0
    say(ours, 'online', ours ? 'the record Proof of Stock serves is this file, byte for byte' : 'the record Proof of Stock serves differs from this file')
    if (!ours) return { code: EXIT.failed, lines }
  }
  const checks = checkReceiptOffline(r, { registryHash: listHash })
  for (const c of checks) say(c.ok, c.check, c.detail)
  if (checks.some((c) => !c.ok)) return { code: EXIT.failed, lines }
  lines.push('')
  lines.push('Never proved here: who or what wrote the answers, and that Proof of Stock flagged a look-alike at the time (context, not graded).')
  if (offline) {
    lines.push('Consistent with itself. This does not prove Proof of Stock issued it.')
    return { code: EXIT.offline, lines }
  }
  lines.push(`The receipt holds: the answers submitted for test ${r.test_id} on ${String(r.answered_at).slice(0, 10)} ${r.grade.passed ? 'passed' : 'did not pass'}, ${r.grade.right} of ${r.grade.of} right, against the issuers' lists frozen at the start.`)
  return { code: EXIT.ok, lines, receipt: r }
}

if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith('--'))
  const flags = args.filter((a) => a.startsWith('--'))
  const usage = 'usage: node scripts/agent-test-check.mjs receipt.json [--offline] [--require-pass]'
  if (!file || flags.some((f) => f !== '--offline' && f !== '--require-pass')) { console.error(usage); process.exit(EXIT.usage) }
  let raw
  try { raw = fs.readFileSync(file) } catch (e) { console.error('cannot read ' + file + ': ' + e.message); process.exit(1) }
  const { code, lines, receipt } = await checkAgentTestReceipt(raw, { offline: args.includes('--offline') })
  for (const l of lines) console.log(l)
  // --require-pass: exit 4 unless the receipt holds AND says passed. Exit 0 alone means "ours and consistent", pass or not.
  process.exitCode = code === EXIT.ok && args.includes('--require-pass') && !(receipt && receipt.grade && receipt.grade.passed) ? EXIT.notPassed : code
}
