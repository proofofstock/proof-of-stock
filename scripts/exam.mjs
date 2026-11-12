// scripts/exam.mjs: the public exam. Once a day (.github/workflows/exam.yml) proofofstock.xyz is asked about every token
// whose right answer can be known WITHOUT it, and the report says how it did, with the inputs' hashes so anyone can
// rerun it: `node scripts/exam.mjs --out=exam`.
//
// The truth comes from the issuers' own APIs, read here, never from us. What "listed" means is the issuer's list, so
// agreeing with it is expected; the exam's weight is elsewhere: no false "listed" for a look-alike or a stranger, no
// real token called a fake, honest refusals, and evidence that reproduces.
//
// The set (README of the report says the same):
//   A  every token on each issuer's list                           -> listed: true (and minted false where Coinbase says no supply)
//   B  the look-alikes we flag this week (/api/impostors, 7-day window) -> listed: false, impostor set
//   C  strangers: the chains' own dollar and ETH tokens our pools pair with, and addresses derived from the date that
//      were never deployed                                          -> listed: false, impostor null
//   D  Base listed tokens asked on Robinhood Chain                  -> listed: false
// Asked 50 at a time through GET /verify?addresses=, paced under the public rate limit.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isEntryPoint } from './lib/invoked-directly.mjs'
import { addressesSha256 } from '../evm/core/stocks/list-proof.mjs'

export const EXAM_VERSION = 1
const ISSUERS = Object.freeze({
  base: { issuer: 'coinbase', url: 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500', read: (b) => (Array.isArray(b?.tokens) && !b.next_page_token ? b.tokens.map((t) => ({ address: String(t.contract_address).toLowerCase(), minted: Number(t.total_supply) > 0 })) : null) },
  robinhood: { issuer: 'robinhood', url: 'https://api.robinhood.com/rhj/assets', read: (b) => (Array.isArray(b?.assets) ? b.assets.map((a) => (Array.isArray(a.deployments) ? a.deployments : []).find((d) => String(d.chainId) === '4663')?.contractAddress).filter((x) => x != null).map((x) => ({ address: String(x).toLowerCase(), minted: null })) : null) },
})
const PAIRED_FROM = { base: '0xb20000000000000000000078ee7ce2fe4908108c', robinhood: '0x322f0929c4625ed5bad873c95208d54e1c003b2d' }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const pct = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null)

/** Addresses no one deployed, derived from the day, so the set is reproducible and different each day. */
export function strangers (day, n = 10) {
  return Array.from({ length: n }, (_, i) => '0x' + sha(`proofofstock-exam-${day}-${i}`).slice(0, 40))
}

/**
 * @returns {Promise<object>} the report: { version, day, site, set: {...hashes, counts}, metrics, failures, timings }
 */
export async function runExam ({ site = 'https://proofofstock.xyz', fetchImpl = globalThis.fetch, now = Date.now, pauseMs = 6000, replays = 10, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const S = site.replace(/\/+$/, '')
  const started = now(), day = new Date(started).toISOString().slice(0, 10)
  const get = async (url, init = {}) => {
    const t = now()
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', 'user-agent': 'proofofstock-exam' }, ...init })
    return { status: r.status, body: await r.json().catch(() => null), ms: now() - t }
  }
  const failures = [], latencies = []
  const fail = (group, address, why) => failures.push({ group, address, why })

  // 1. The truth, from the issuers.
  const truth = {}
  for (const [c, I] of Object.entries(ISSUERS)) {
    const r = await get(I.url)
    const list = r.status === 200 ? I.read(r.body) : null
    if (!list) throw new Error(`${I.issuer} list could not be read (HTTP ${r.status}); no exam without the truth`)
    truth[c] = { list, sha: addressesSha256(list) }
  }
  // 2. The look-alikes we flag (B) and the paired tokens (C).
  const imp = (await get(S + '/api/impostors')).body?.chains || {}
  const paired = {}
  for (const c of Object.keys(ISSUERS)) {
    const p = await get(`${S}/api/passport?chain=${c}&address=${PAIRED_FROM[c]}`)
    paired[c] = p.body?.sources?.pools_counted?.paired_with_addresses || []
    await sleep(pauseMs)
  }
  // 3. The set.
  const set = []
  for (const c of Object.keys(ISSUERS)) {
    for (const t of truth[c].list) set.push({ group: 'A', chain: c, address: t.address, expect: { listed: true, minted: t.minted } })
    for (const i of imp[c]?.items || []) set.push({ group: 'B', chain: c, address: String(i.address).toLowerCase(), expect: { listed: false, impostor: true } })
    for (const a of [...paired[c], ...strangers(day + c)]) set.push({ group: 'C', chain: c, address: String(a).toLowerCase(), expect: { listed: false, impostor: false } })
  }
  for (const t of truth.base.list.slice(0, 20)) set.push({ group: 'D', chain: 'robinhood', address: t.address, expect: { listed: false } })
  const setText = set.map((x) => `${x.group} ${x.chain} ${x.address}`).join('\n') + '\n'

  // 4. Ask, 50 at a time per chain, paced.
  const answers = new Map(), proofs = {}
  let refusals = 0
  for (const c of Object.keys(ISSUERS)) {
    const addrs = [...new Set(set.filter((x) => x.chain === c).map((x) => x.address))]
    for (let i = 0; i < addrs.length; i += 50) {
      const part = addrs.slice(i, i + 50)
      const r = await get(`${S}/verify?chain=${c}&addresses=${part.join(',')}`)
      latencies.push(r.ms)
      if (r.status === 503) { refusals += part.length; for (const a of part) answers.set(c + a, { refused: true }); continue }
      if (r.status !== 200 || !Array.isArray(r.body?.results)) { for (const a of part) fail('?', a, `HTTP ${r.status}`); continue }
      proofs[c] = r.body.list_proof
      for (const x of r.body.results) answers.set(c + x.address, x)
      if (i + 50 < addrs.length || c !== 'robinhood') await sleep(pauseMs)
    }
  }
  // 5. Score.
  const m = { false_listed: 0, false_not_listed: 0, real_called_fake: 0, lookalikes: 0, lookalikes_caught: 0, minted_wrong: 0, refused: refusals, not_listed_while_refusing: 0, asked: 0 }
  for (const x of set) {
    const a = answers.get(x.chain + x.address)
    if (!a) continue
    if (a.refused) continue
    m.asked++
    if (x.expect.listed && a.listed !== true) { m.false_not_listed++; fail(x.group, x.address, 'on the issuer list, answered not listed') }
    if (!x.expect.listed && a.listed === true) { m.false_listed++; fail(x.group, x.address, 'not on the issuer list, answered listed') }
    if (x.group === 'A' && a.impostor) { m.real_called_fake++; fail('A', x.address, 'issuer-listed, flagged as an impostor') }
    if (x.group === 'B') { m.lookalikes++; if (a.impostor) m.lookalikes_caught++; else fail('B', x.address, 'a flagged look-alike answered without impostor') }
    if (x.group === 'C' && a.impostor) fail('C', x.address, 'a stranger flagged as an impostor')
    if (x.group === 'A' && x.chain === 'base' && x.expect.minted != null && a.minted !== x.expect.minted) { m.minted_wrong++; fail('A', x.address, `minted ${a.minted}, the issuer says ${x.expect.minted}`) }
    if (x.group === 'D' && !a.listed_on_other_chain) fail('D', x.address, 'listed on Base, not said when asked on Robinhood Chain')
  }
  // 6. Evidence: the list proofs against the truth, and price evidence replayed.
  const listProof = Object.fromEntries(Object.keys(ISSUERS).map((c) => [c, { ours: proofs[c]?.addresses_sha256 ?? null, issuer: truth[c].sha, match: proofs[c]?.addresses_sha256 === truth[c].sha }]))
  const replay = { tried: 0, onchain: 0, same_bytes: 0, none: 0 }
  for (const t of truth.base.list.filter((x) => x.minted).slice(0, replays)) {
    const p = await get(`${S}/api/passport?chain=base&address=${t.address}`)
    const e = p.body?.latest?.price_evidence
    await sleep(pauseMs / 2)
    if (!e) continue
    replay.tried++
    if (e.evidence !== 'onchain') { replay.none++; continue }
    replay.onchain++
    const call = await get(e.rpc, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'proofofstock-exam' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: e.multicall, data: e.calldata }, '0x' + Number(e.block_number).toString(16)] }) })
    if (call.body?.result === e.return_data) replay.same_bytes++; else fail('price', t.address, `evidence at block ${e.block_number} did not replay`)
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null)
  const counts = Object.fromEntries(['A', 'B', 'C', 'D'].map((g) => [g, set.filter((x) => x.group === g).length]))
  return {
    version: EXAM_VERSION, day, site: S, started_at: new Date(started).toISOString(), finished_at: new Date(now()).toISOString(),
    set: { counts, sha256: sha(setText), issuer_list_sha256: Object.fromEntries(Object.entries(truth).map(([c, t]) => [c, t.sha])) },
    metrics: { ...m, lookalikes_caught_pct: pct(m.lookalikes_caught, m.lookalikes), list_proof: listProof, price_evidence: replay, verify_ms: { p50: q(0.5), p95: q(0.95), batches: latencies.length } },
    failures: failures.slice(0, 200), failures_total: failures.length,
    _set: setText,
  }
}

/** The report in words, for people: what was asked, what came back, what failed. */
export function reportMarkdown (r) {
  const m = r.metrics, lp = m.list_proof, pe = m.price_evidence
  const yes = (b) => (b ? 'yes' : '**no**')
  return [
    `# Proof of Stock exam, ${r.day}`, '',
    `Asked ${r.site} about ${Object.values(r.set.counts).reduce((a, b) => a + b, 0)} tokens whose right answer comes from the issuers, not from us. Set SHA-256 \`${r.set.sha256}\`; rerun with \`node scripts/exam.mjs\`.`, '',
    '| Check | Result | Target |', '|---|---|---|',
    `| False "listed" (look-alikes, strangers, wrong chain) | ${m.false_listed} | 0 |`,
    `| False "not listed" (tokens on the issuer list) | ${m.false_not_listed} | 0 |`,
    `| A real token called a fake | ${m.real_called_fake} | 0 |`,
    `| Look-alikes of the week flagged | ${m.lookalikes_caught} of ${m.lookalikes} | all |`,
    `| Coinbase "minted" agrees with total_supply | ${m.minted_wrong ? m.minted_wrong + ' wrong' : 'all'} | all |`,
    `| Refused ("registry unavailable") | ${m.refused} | honest when it happens |`,
    `| Base list_proof equals the hash of Coinbase's list | ${yes(lp.base?.match)} | yes |`,
    `| Robinhood list_proof equals the hash of Robinhood's list | ${yes(lp.robinhood?.match)} | yes |`,
    `| Price evidence replayed on chain, same bytes | ${pe.same_bytes} of ${pe.onchain} on-chain (${pe.none} aggregator-only) | all on-chain |`,
    `| /verify batch latency p50 / p95 | ${m.verify_ms.p50} / ${m.verify_ms.p95} ms | reported as is |`, '',
    `Set: A ${r.set.counts.A} issuer-listed, B ${r.set.counts.B} look-alikes flagged this week, C ${r.set.counts.C} strangers, D ${r.set.counts.D} asked on the other chain.`, '',
    r.failures_total ? `## Failures (${r.failures_total})\n\n` + r.failures.map((f) => `- ${f.group} \`${f.address}\`: ${f.why}`).join('\n') : 'No failures.', '',
    'Listed agrees with the issuer by definition; the weight of this exam is in the look-alikes, the honest refusals and the evidence. Found a wrong verdict? hello@proofofstock.xyz', '',
  ].join('\n')
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const out = arg('out') || 'exam'
  const r = await runExam({ site: arg('site') || 'https://proofofstock.xyz' })
  fs.mkdirSync(out, { recursive: true })
  const { _set, ...report } = r
  fs.writeFileSync(path.join(out, `${r.day}.json`), JSON.stringify(report, null, 1) + '\n')
  fs.writeFileSync(path.join(out, `${r.day}.set.txt`), _set)
  fs.writeFileSync(path.join(out, `${r.day}.md`), reportMarkdown(r))
  fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(report, null, 1) + '\n')
  fs.writeFileSync(path.join(out, 'README.md'), reportMarkdown(r))
  console.log(reportMarkdown(r))
  const hard = r.metrics.false_listed + r.metrics.false_not_listed + r.metrics.real_called_fake
  if (hard) process.exit(1)
}
