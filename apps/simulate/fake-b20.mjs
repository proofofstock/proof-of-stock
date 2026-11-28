// apps/simulate/fake-b20.mjs: a fake B20 chain for the tests of the B20 transfer rules (apps/b20-reader.test.mjs,
// apps/stocks-simulate.test.mjs, apps/b20-web.test.mjs). Not used by the site.
//
// It answers the four reads of docs/b20-transfers-tz.md §1 inside Multicall3's aggregate3, as the policy registry is
// described on docs.base.org: allowlists and blocklists by membership, union and intersect of children, bit 63 inverts an
// existing base, a well-formed unknown id is an empty set of its kind (so an unknown "blocklist" says true for everyone).
// Every inner call is recorded with the batch it came in, so a test can see what was asked, in what order, how often.
import { decodeAggregate3Calldata, encodeAggregate3Result, MULTICALL3 } from '../../scripts/stocks/onchain-pools.mjs'
import { POLICY_REGISTRY, SCOPES, SEL } from '../../evm/core/stocks/b20.mjs'

const INV = 1n << 63n
const strip = (h) => String(h || '').replace(/^0x/, '').toLowerCase()
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
const scopeOf = Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [strip(v), k]))

/**
 * @param {object} o
 * @param {object} o.tokens  address -> { policies: { sender, receiver, executor } (decimal strings), paused }
 * @param {object} o.kinds   id -> { type: allow|block|union|intersect, members?, children? }; 'unknown:<id>': what an
 *                           unknown id answers (true for an empty blocklist)
 */
export function createB20Chain ({ tokens = {}, kinds = {} } = {}) {
  const st = { tokens, kinds, calls: [], batch: 0, failIds: new Set(), failAuth: new Set(), garbage: false }
  const base = (id) => BigInt(id) & ~INV
  const known = (id) => st.kinds[String(base(id))] != null
  const answer = (id, a) => {
    const big = BigInt(id)
    if (big & INV) return known(big) ? !answer(base(big).toString(), a) : false
    const k = st.kinds[String(big)]
    if (!k) return Boolean(st.kinds['unknown:' + String(big)])
    if (k.type === 'allow') return k.members.includes(a)
    if (k.type === 'block') return !k.members.includes(a)
    if (k.type === 'union') return k.children.some((c) => answer(c, a))
    if (k.type === 'intersect') return k.children.every((c) => answer(c, a))
    return false
  }
  /** One inner call of aggregate3: { success, data }, or null when it is not a B20 read. */
  st.answer = (c) => {
    const to = String(c.to).toLowerCase(), d = strip(c.data), f = d.slice(0, 8)
    const tok = st.tokens[to]
    if (tok && f === SEL.policyId) {
      const scope = scopeOf[d.slice(8, 72)]
      st.calls.push({ batch: st.batch, kind: 'policyId', token: to, scope })
      if (st.garbage) return { success: true, data: '0x' + 'f'.repeat(64) }
      if (st.failPolicyId && st.failPolicyId.token === to && st.failPolicyId.scope === scope) return { success: false, data: '0x' }
      return { success: true, data: '0x' + w(tok.policies[scope] ?? 0) }
    }
    if (tok && f === SEL.isPaused) { st.calls.push({ batch: st.batch, kind: 'isPaused', token: to, feature: Number(BigInt('0x' + d.slice(8, 72))) }); return { success: true, data: '0x' + w(tok.paused ? 1 : 0) } }
    if (to === POLICY_REGISTRY && f === SEL.policyExists) {
      const id = BigInt('0x' + d.slice(8, 72)).toString()
      st.calls.push({ batch: st.batch, kind: 'policyExists', id })
      if (st.failIds.has(id)) return { success: false, data: '0x' }
      return { success: true, data: '0x' + w(known(id) || BigInt(id) === 0n ? 1 : 0) }
    }
    if (to === POLICY_REGISTRY && f === SEL.isAuthorized) {
      const id = BigInt('0x' + d.slice(8, 72)).toString(), a = '0x' + d.slice(72 + 24, 136)
      st.calls.push({ batch: st.batch, kind: 'isAuthorized', id, account: a })
      if (st.failAuth.has(id + '|' + a)) return { success: false, data: '0x' }
      return { success: true, data: '0x' + w(answer(id, a) ? 1 : 0) }
    }
    return null
  }
  /** aggregate3 calldata in, its result out: every call a B20 read or a failure. */
  st.aggregate = (data) => { st.batch++; return encodeAggregate3Result(decodeAggregate3Calldata(data).map((c) => st.answer(c) || { success: false, data: '0x' })) }
  return st
}

/**
 * A whole fake pair of nodes for the B20 reads, behind one fetchImpl (each request's URL says which node). Each node has
 * a head (`heads` per URL, else `head`), a header time from `now` (less `lags` per URL or `lagS`, and two seconds per
 * block below the head), and answers `latest`, `safe` and a block by number. A node's hashes carry its own `forks` salt,
 * so two nodes on different chains give different hashes for one number. aggregate3 is answered at any hash the node
 * gave, with requireCanonical, from `chains` per URL or `chain`; `mangle` can rewrite an answer (a truncated one).
 */
export function b20Node (chain, { head = 40_000_000, now = () => Date.now() } = {}) {
  const node = { chain, chains: new Map(), head, now, lagS: 0, lags: new Map(), heads: new Map(), forks: new Map(), mangle: null, requests: [], down: new Set(), downMethods: new Map(), hashTags: 0, issued: new Map() }
  const headOf = (u) => (node.heads.has(String(u)) ? node.heads.get(String(u)) : node.head)
  const hashOf = (u, n) => '0x' + (BigInt(n).toString(16) + (node.forks.get(String(u)) || '')).padStart(64, 'c').slice(-64)
  const timeOf = (u, n) => Math.floor(node.now() / 1000 - (node.lags.has(String(u)) ? node.lags.get(String(u)) : node.lagS) - (headOf(u) - n) * 2)
  node.fetchImpl = async (url, init = {}) => {
    const body = JSON.parse(init.body)
    const u = String(url)
    node.requests.push({ url: u, method: body.method, params: body.params })
    const reply = (j, status = 200) => ({ ok: status < 400, status, json: async () => ({ jsonrpc: '2.0', id: 1, ...j }) })
    if (node.down.has(u) || node.down.has('*')) return reply({ error: { code: -32000, message: 'down 0x' + 'ab'.repeat(20) } }, 503)
    const dm = node.downMethods.get(u)
    if (dm && dm(body)) return reply({ error: { code: -32000, message: 'failed for 0x' + 'ab'.repeat(20) } })
    if (body.method === 'eth_getBlockByNumber') {
      const tag = body.params[0]
      const n = tag === 'latest' || tag === 'safe' ? headOf(u) : Number(BigInt(tag))
      if (n > headOf(u)) return reply({ result: null })
      const h = hashOf(u, n)
      if (!node.issued.has(u)) node.issued.set(u, new Set())
      node.issued.get(u).add(h)
      return reply({ result: { number: '0x' + BigInt(n).toString(16), hash: h, timestamp: '0x' + timeOf(u, n).toString(16) } })
    }
    if (body.method === 'eth_call' && String(body.params[0].to).toLowerCase() === MULTICALL3) {
      const tag = body.params[1]
      if (!tag || typeof tag !== 'object' || !(node.issued.get(u) || new Set()).has(tag.blockHash)) return reply({ error: { code: -32000, message: 'header for hash not found' } })
      if (tag.requireCanonical !== true) return reply({ error: { code: -32000, message: 'the fake insists on requireCanonical' } })
      node.hashTags++
      const out = (node.chains.get(u) || node.chain).aggregate(body.params[0].data)
      return reply({ result: node.mangle ? node.mangle(out, u) : out })
    }
    return reply({ error: { code: -32601, message: 'no such method' } })
  }
  return node
}
