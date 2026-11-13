// scripts/canary.mjs: proofofstock.xyz checked from OUTSIDE its own host, on a schedule (.github/workflows/canary.yml,
// GitHub's runners). The host's own health check (scripts/stocks/health-check.mjs) cannot say the host is gone; this can.
//
// It asks questions whose answers are known and checks the evidence itself, independently of our server:
//   - the page and /api/status answer, and the lists and prices are fresh;
//   - a known listed token is listed, with a list_proof; a known look-alike is not listed;
//   - the MCP server answers initialize and lists its six tools;
//   - each issuer list hashed here, from the issuer's own API, equals our list_proof.addresses_sha256 (one retry six
//     minutes later, since the issuer may have changed its list between our read and this one);
//   - the passport's on-chain price evidence, called again at its block on the public RPC, returns the same bytes.
// Any failure exits non-zero and, with STP_ALERT_TELEGRAM_TOKEN and STP_ALERT_TELEGRAM_CHAT set (repository secrets),
// sends one Telegram message (scripts/lib/alert.mjs).
//
// Usage: node scripts/canary.mjs [--site=https://proofofstock.xyz] [--no-retry]
import { isEntryPoint } from './lib/invoked-directly.mjs'
import { alert } from './lib/alert.mjs'
import { addressesSha256 } from '../evm/core/stocks/list-proof.mjs'

// Known answers. A known token that changes for a real reason (delisted, the copy removed) shows here first: the
// message says which, so the fixture can be updated.
export const KNOWN = Object.freeze({
  listed: { chain: 'base', address: '0xb20000000000000000000078ee7ce2fe4908108c', symbol: 'NVDAc' },
  lookalike: { chain: 'base', address: '0x02ecff464a843629b63b8462e42ffc35e38bb384' },
  tools: 6,
})
const ISSUERS = Object.freeze({
  base: { url: 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500', addresses: (b) => (Array.isArray(b?.tokens) && !b.next_page_token ? b.tokens.map((t) => t.contract_address) : null) },
  robinhood: { url: 'https://api.robinhood.com/rhj/assets', addresses: (b) => (Array.isArray(b?.assets) ? b.assets.map((a) => (Array.isArray(a.deployments) ? a.deployments : []).find((d) => String(d.chainId) === '4663')?.contractAddress).filter((x) => x != null) : null) },
})

// It names itself in every request to our own site, so the visit counter can leave it out: the runners' addresses
// change, the name does not (apps/stocks-analytics.mjs IGNORE_UA).
export const CANARY_UA = 'proofofstock-canary'

const getJson = async (fetchImpl, url, init = {}) => {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'user-agent': CANARY_UA }, ...init })
  const body = await r.json().catch(() => null)
  return { status: r.status, body }
}

/**
 * Run every check. Returns [{ name, ok, detail }]. Never throws: a check that throws fails with its error.
 * @param {object} o
 * @param {string} [o.site]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(ms: number) => Promise<void>} [o.wait]  the pause before a hash retry (six minutes on the real run)
 */
export async function runCanary ({ site = 'https://proofofstock.xyz', fetchImpl = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), retryMs = 6 * 60e3 } = {}) {
  const out = []
  const run = async (name, fn) => { try { const d = await fn(); out.push({ name, ok: d === true || d?.ok === true, detail: d?.detail || '' }) } catch (e) { out.push({ name, ok: false, detail: String(e && e.message || e).slice(0, 200) }) } }
  const S = site.replace(/\/+$/, '')

  await run('page', async () => {
    const r = await fetchImpl(S + '/', { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': CANARY_UA } })
    const t = await r.text()
    return { ok: r.status === 200 && t.includes('Proof of Stock'), detail: `HTTP ${r.status}` }
  })
  let status = null
  await run('status fresh', async () => {
    const r = await getJson(fetchImpl, S + '/api/status')
    status = r.body
    const bad = Object.entries(r.body || {}).filter(([, s]) => !(s.registry_age_s <= 900) || !(s.newest_reading_age_s <= 1800)).map(([c, s]) => `${c}: list ${s.registry_age_s}s, readings ${s.newest_reading_age_s}s`)
    return { ok: r.status === 200 && r.body && Object.keys(r.body).length >= 2 && bad.length === 0, detail: bad.join('; ') || `HTTP ${r.status}` }
  })
  const proofs = {}
  await run('a listed token is listed, with its proof', async () => {
    const k = KNOWN.listed
    const r = await getJson(fetchImpl, `${S}/verify?chain=${k.chain}&address=${k.address}`)
    proofs[k.chain] = r.body?.list_proof
    return { ok: r.status === 200 && r.body?.listed === true && r.body?.symbol === k.symbol && /^[0-9a-f]{64}$/.test(r.body?.list_proof?.addresses_sha256 || ''), detail: `HTTP ${r.status}, listed ${r.body?.listed}, symbol ${r.body?.symbol}` }
  })
  await run('a known look-alike is not listed', async () => {
    const k = KNOWN.lookalike
    const r = await getJson(fetchImpl, `${S}/verify?chain=${k.chain}&address=${k.address}`)
    return { ok: r.status === 200 && r.body?.listed === false, detail: `HTTP ${r.status}, listed ${r.body?.listed}, impostor ${Boolean(r.body?.impostor)}` }
  })
  await run('robinhood answers with a proof', async () => {
    const r = await getJson(fetchImpl, `${S}/verify?chain=robinhood&address=0x${'0'.repeat(39)}1`)
    proofs.robinhood = r.body?.list_proof
    return { ok: r.status === 200 && /^[0-9a-f]{64}$/.test(r.body?.list_proof?.addresses_sha256 || ''), detail: `HTTP ${r.status}` }
  })
  await run('the MCP server lists its tools', async () => {
    const r = await getJson(fetchImpl, S + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': CANARY_UA }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const n = r.body?.result?.tools?.length
    return { ok: r.status === 200 && n === KNOWN.tools, detail: `HTTP ${r.status}, ${n} tools` }
  })
  // The issuer's own list, hashed here: equal to what our server says it decided against.
  for (const c of Object.keys(ISSUERS)) {
    await run(`${c} list hash equals the issuer's`, async () => {
      const ours = proofs[c]?.addresses_sha256
      if (!ours) return { ok: false, detail: 'no list_proof to compare' }
      const theirs = async () => { const r = await getJson(fetchImpl, ISSUERS[c].url); const a = ISSUERS[c].addresses(r.body); return a ? addressesSha256(a.map((address) => ({ address }))) : null }
      let h = await theirs()
      if (h === ours) return true
      if (retryMs > 0) {
        await wait(retryMs)
        const again = await getJson(fetchImpl, `${S}/verify?chain=${c}&address=${c === 'base' ? KNOWN.listed.address : '0x' + '0'.repeat(39) + '1'}`)
        const ours2 = again.body?.list_proof?.addresses_sha256
        h = await theirs()
        if (h && h === ours2) return true
        return { ok: false, detail: `ours ${String(ours2).slice(0, 12)}, the issuer's ${String(h).slice(0, 12)} (after a retry)` }
      }
      return { ok: false, detail: `ours ${ours.slice(0, 12)}, the issuer's ${String(h).slice(0, 12)}` }
    })
  }
  // The on-chain price evidence, called again at its block: the same bytes, or the proof is not one.
  await run('price evidence replays on chain', async () => {
    const k = KNOWN.listed
    const r = await getJson(fetchImpl, `${S}/api/passport?chain=${k.chain}&address=${k.address}`)
    const e = r.body?.latest?.price_evidence
    if (!e) return { ok: false, detail: 'no price_evidence' }
    if (e.evidence !== 'onchain') return { ok: true, detail: `evidence ${e.evidence}: nothing to replay` }
    const call = await getJson(fetchImpl, e.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: e.multicall, data: e.calldata }, '0x' + Number(e.block_number).toString(16)] }) })
    return { ok: call.body?.result === e.return_data, detail: `block ${e.block_number}, ${call.body?.result === e.return_data ? 'same bytes' : 'DIFFERENT bytes'}` }
  })
  void status
  return out
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const results = await runCanary({ site: arg('site') || 'https://proofofstock.xyz', retryMs: process.argv.includes('--no-retry') ? 0 : 6 * 60e3 })
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ': ' + r.detail : ''}`)
  const bad = results.filter((r) => !r.ok)
  if (bad.length) {
    // No state between runs on a hosted runner: one message per failing run (the schedule is every 30 minutes).
    await alert({ key: 'canary', text: `the outside check failed: ${bad.map((r) => r.name + (r.detail ? ` (${r.detail})` : '')).join('; ')}.` }, { env: { ...process.env, STP_ALERT_STATE: process.env.RUNNER_TEMP ? process.env.RUNNER_TEMP + '/alert-state.json' : '/tmp/stp-canary-state.json' } })
    process.exit(1)
  }
}
