// evm/core/stocks/b20.test.mjs: the state of a token's B20 transfer rules from what was read (docs/b20-transfers-tz.md
// §3, §7). Unreadable is `unknown`, never `open`: a failed read, a stale reading, an answer that does not decode, and a
// bound policy id the registry does not hold even when it answers `true` for everyone. The state follows isAuthorized,
// not the shape of the id. The pause comes before any other state, and the issuer's list is said beside the chain's.
// The enums are the passport schema's.
//
// Run: node evm/core/stocks/b20.test.mjs
import fs from 'node:fs'
import { keccak256 } from './evm-tx.mjs'
import {
  transfersOf, changesOf, changeText, accountsOf, snapshotOf, snapshotChanges, allowedIn, idOf, boolOf, noteOf, venueRefused, calldata,
  SCOPES, SCOPE_NAMES, SEL, ORDINARY_WALLET, ORDINARY_PHRASE, STATES, REASONS, VENUE_NAMES, STALE_S, MAX_POOLS, ALWAYS_ALLOW, UNISWAP_V4_POOL_MANAGER,
} from './b20.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

// Synthetic addresses, ids and time: nothing here is a reading of the chain.
const NOW = Date.parse('2026-12-01T15:00:00Z')
const T = '0xb2000000000000000000001e800a7f5189430cd0'
const K = '0x' + 'a1'.repeat(20), R = '0x' + 'a2'.repeat(20), P1 = '0x' + 'a3'.repeat(20), P2 = '0x' + 'a4'.repeat(20)
const ACC = accountsOf({ kyberRouter: K, aerodromeRouters: [R], pools: [P1, P2] })
const INV = 1n << 63n

/**
 * A model of the policy registry, as docs.base.org describes it: allowlists and blocklists by membership, union and
 * intersect of children, bit 63 inverts an existing base, and a well-formed unknown id is an empty set of its kind
 * (an allowlist or union refuses everyone, a blocklist or intersect lets everyone through). `kinds` says what each
 * id is; the shape of an id says nothing to the code under test.
 */
function registry (kinds) {
  const base = (id) => BigInt(id) & ~INV
  const known = (id) => kinds[String(base(id))] != null
  const answer = (id, a) => {
    const big = BigInt(id)
    if (big & INV) return known(big) ? !answer(base(big).toString(), a) : false
    const k = kinds[String(big)]
    if (!k) return Boolean(kinds['unknown:' + id]) // what an unknown id of a given kind answers: true for a blocklist
    if (k.type === 'allow') return k.members.includes(a)
    if (k.type === 'block') return !k.members.includes(a)
    if (k.type === 'union') return k.children.some((c) => answer(c, a))
    if (k.type === 'intersect') return k.children.every((c) => answer(c, a))
    return false
  }
  return { exists: (id) => known(id), answer }
}
/** A reading as apps/b20-reader.mjs makes it, from a model registry: policyExists first, isAuthorized only if it exists. */
function reading ({ policies = { sender: '0', receiver: '0', executor: '0' }, kinds = {}, paused = false, readAt = NOW - 60e3, error = null, accounts = ACC, drop = [] } = {}) {
  const reg = registry(kinds)
  const ids = [...new Set(Object.values(policies).filter((id) => id != null && id !== ALWAYS_ALLOW))]
  const exists = Object.fromEntries(ids.map((id) => [id, reg.exists(id)]))
  const auth = {}
  for (const a of accounts) for (const s of a.scopes) { const id = policies[s]; if (id && id !== '0' && exists[id]) auth[id + '|' + a.address] = reg.answer(id, a.address) }
  for (const k of drop) auth[k] = null
  return { token: T, block: 100, block_hash: '0x' + 'bb'.repeat(32), read_at: readAt, error, paused, policies, exists, auth, accounts }
}
const at = (r, o = {}) => transfersOf(r, { now: NOW, listPaused: [], ...o })

console.log('the constants')
{
  const k = (s) => '0x' + keccak256(Buffer.from(s, 'utf8')).toString('hex')
  check('each scope is keccak256 of its name', Object.keys(SCOPES).every((s) => SCOPES[s] === k(SCOPE_NAMES[s])))
  const sel = (sig) => keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4).toString('hex')
  check('the selectors are the four signatures', SEL.policyId === sel('policyId(bytes32)') && SEL.isPaused === sel('isPaused(uint8)') && SEL.policyExists === sel('policyExists(uint64)') && SEL.isAuthorized === sel('isAuthorized(uint64,address)'))
  check('the ordinary wallet is the last 20 bytes of keccak256 of its phrase', ORDINARY_WALLET === '0x' + keccak256(Buffer.from(ORDINARY_PHRASE, 'utf8')).subarray(12).toString('hex'))
  check('isPaused asks TRANSFER, which is 0', calldata.isPaused() === '0x' + SEL.isPaused + '0'.repeat(64))
  check('the accounts: ordinary wallet in all three scopes, routers, pools (sender, executor, receiver), v4 PoolManager', ACC[0].address === ORDINARY_WALLET && ACC[0].scopes.length === 3 && ACC.find((a) => a.name === 'kyberswap_router').scopes.length === 3 && ACC.find((a) => a.name === 'aerodrome_router').scopes.join() === 'executor' && ACC.filter((a) => a.name === 'pool').every((a) => a.scopes.join() === 'sender,executor,receiver') && ACC[ACC.length - 1].address === UNISWAP_V4_POOL_MANAGER)
  const many = accountsOf({ kyberRouter: K, pools: Array.from({ length: 9 }, (_, i) => '0x' + String(i + 1).repeat(40)) })
  check(`at most ${MAX_POOLS} pools per token, a v4 pool id is not an address`, many.filter((a) => a.name === 'pool').length === MAX_POOLS && accountsOf({ pools: ['0x' + 'ab'.repeat(32)] }).every((a) => a.name !== 'pool'))
  check('a word above 2^64 is no policy id; a bool is exactly 0 or 1', idOf({ success: true, data: '0x' + '1'.padStart(64, '0') }) === '1' && idOf({ success: true, data: '0x' + '1' + '0'.repeat(63) }) === null && idOf({ success: false, data: '0x' + '0'.repeat(64) }) === null && boolOf({ success: true, data: '0x' + '2'.padStart(64, '0') }) === null && boolOf({ success: true, data: '0x' }) === null)
}

console.log('open, and what is not open')
{
  check('every scope at 0 (always allow): open, with no read of the registry', at(reading()).state === 'open' && at(reading()).reason === null && Object.keys(reading().auth).length === 0)
  const ok = at(reading({ policies: { sender: '5', receiver: '5', executor: '5' }, kinds: { 5: { type: 'block', members: ['0x' + '99'.repeat(20)] } } }))
  check('a blocklist that names none of ours: open, every venue allowed', ok.state === 'open' && ok.venues.every((v) => v.allowed === true) && ok.ordinary_wallet.send === true && ok.ordinary_wallet.receive === true)
  const unknownId = reading({ policies: { sender: '0', receiver: '77', executor: '0' }, kinds: { 'unknown:77': true } })
  check('an unknown id answering true for everyone (an empty blocklist): unknown, policy_missing, never open', at(unknownId).state === 'unknown' && at(unknownId).reason === 'policy_missing')
  check('...and isAuthorized was never asked of it', !Object.keys(unknownId.auth).some((k) => k.startsWith('77|')))
  check('a failed read: unknown, read_failed', at(reading({ error: 'read_failed' })).state === 'unknown' && at(reading({ error: 'read_failed' })).reason === 'read_failed')
  check(`a reading older than ${STALE_S} s: unknown, stale`, at(reading({ readAt: NOW - (STALE_S + 1) * 1000 })).reason === 'stale' && at(reading({ readAt: NOW - STALE_S * 1000 })).state === 'open')
  check('no reading: unknown, not_read', at(null).state === 'unknown' && at(null).reason === 'not_read')
  check('a pause that did not decode is not "not paused": unknown, undecodable', at(reading({ paused: null })).reason === 'undecodable')
  check('a policy id that did not decode: unknown, undecodable', at(reading({ policies: { sender: null, receiver: '0', executor: '0' } })).reason === 'undecodable')
  const one = reading({ policies: { sender: '5', receiver: '5', executor: '5' }, kinds: { 5: { type: 'block', members: [] } }, drop: ['5|' + P2] })
  check('one isAuthorized that failed: unknown, read_failed, and that venue allowed null', at(one).reason === 'read_failed' && at(one).venues.find((v) => v.address === P2).allowed === null)
}

console.log('restricted')
{
  const allow = reading({ policies: { sender: '0', receiver: '9', executor: '0' }, kinds: { 9: { type: 'allow', members: [K, R, P1, P2, UNISWAP_V4_POOL_MANAGER] } } })
  const a = at(allow)
  check('the ordinary wallet refused in the receiver scope: restricted, ordinary_wallet_refused, receive false', a.state === 'restricted' && a.reason === 'ordinary_wallet_refused' && a.ordinary_wallet.receive === false && a.ordinary_wallet.send === true)
  check('...a note transfers_restricted', noteOf(a) === 'transfers_restricted')
  const kx = reading({ policies: { sender: '0', receiver: '0', executor: '4' }, kinds: { 4: { type: 'block', members: [K] } } })
  const b = at(kx)
  check('the KyberSwap router refused as executor: that venue allowed false, restricted, venue_refused', b.state === 'restricted' && b.reason === 'venue_refused' && b.venues.find((v) => v.name === 'kyberswap_router').allowed === false && venueRefused(b, K) && !venueRefused(b, R))
  check('the ordinary wallet refused as executor counts as not able to send', at(reading({ policies: { sender: '0', receiver: '0', executor: '4' }, kinds: { 4: { type: 'block', members: [ORDINARY_WALLET] } } })).ordinary_wallet.send === false)
  check('venueRefused says nothing from a reading that is not current', !venueRefused(at(reading({ ...kx, readAt: NOW - 3600e3, policies: kx.policies, kinds: { 4: { type: 'block', members: [K] } } })), K))
}

console.log('the state follows isAuthorized, not the shape of the id')
{
  // 5 is an allowlist of everyone we check; its inverted id refuses all of them.
  const everyone = [ORDINARY_WALLET, K, R, P1, P2, UNISWAP_V4_POOL_MANAGER]
  const inv = (BigInt(5) | INV).toString()
  const kinds = { 5: { type: 'allow', members: everyone }, 6: { type: 'block', members: [] }, 7: { type: 'allow', members: [] }, 8: { type: 'union', children: ['6', '7'] }, 10: { type: 'intersect', children: ['6', '7'] } }
  check('an inverted allowlist of everyone refuses everyone: restricted', at(reading({ policies: { sender: inv, receiver: '0', executor: '0' }, kinds })).state === 'restricted')
  check('an inverted blocklist of nobody refuses everyone: restricted', at(reading({ policies: { sender: '0', receiver: (6n | INV).toString(), executor: '0' }, kinds })).state === 'restricted')
  check('a union with an open blocklist lets everyone through: open', at(reading({ policies: { sender: '0', receiver: '8', executor: '0' }, kinds })).state === 'open')
  check('an intersection with an empty allowlist lets nobody through: restricted', at(reading({ policies: { sender: '0', receiver: '10', executor: '0' }, kinds })).state === 'restricted')
  const invUnknown = (99n | INV).toString()
  check('an inverted id whose base does not exist: unknown, policy_missing', at(reading({ policies: { sender: '0', receiver: invUnknown, executor: '0' }, kinds })).reason === 'policy_missing')
  check('allowedIn: id 0 true without a read, a missing id "missing"', allowedIn(reading(), 'sender', K) === true && allowedIn({ policies: { sender: '3' }, exists: { 3: false } }, 'sender', K) === 'missing')
}

console.log('the pause')
{
  const chainOnly = at(reading({ paused: true }), { listPaused: [] })
  check('paused on chain: paused, before any other state, with the note transfers_paused', chainOnly.state === 'paused' && noteOf(chainOnly) === 'transfers_paused')
  check('...paused on chain and not on the issuer\'s list: both said, labelled, agree false', chainOnly.pause.chain === true && chainOnly.pause.issuer_list === false && chainOnly.pause.agree === false && /isPaused/.test(chainOnly.pause.chain_source) && /paused_features/.test(chainOnly.pause.issuer_list_source))
  const listOnly = at(reading(), { listPaused: ['TRANSFER'] })
  check('the reverse: open on chain, paused on the list: both said, agree false, the state is the chain\'s', listOnly.state === 'open' && listOnly.pause.chain === false && listOnly.pause.issuer_list === true && listOnly.pause.agree === false && listOnly.pause.issuer_list_features[0] === 'TRANSFER')
  check('paused wins over a restriction', at(reading({ paused: true, policies: { sender: '0', receiver: '9', executor: '0' }, kinds: { 9: { type: 'allow', members: [] } } })).state === 'paused')
  check('a stale pause is not said: chain null, state unknown', at(reading({ paused: true, readAt: NOW - 3600e3 })).pause.chain === null && at(reading({ paused: true, readAt: NOW - 3600e3 })).state === 'unknown')
}

console.log('a change, for the alert')
{
  const a = reading({ policies: { sender: '0', receiver: '5', executor: '0' }, kinds: { 5: { type: 'block', members: [] } } })
  check('the same reading twice: no change', changesOf(a, reading({ policies: a.policies, kinds: { 5: { type: 'block', members: [] } } })).length === 0)
  const b = reading({ policies: { sender: '0', receiver: '5', executor: '0' }, kinds: { 5: { type: 'block', members: [K] } } })
  const ch = changesOf(a, b)
  check('a policy\'s answer for an account changes: one change, naming the scope and the account', ch.length === 1 && ch[0].kind === 'answer' && ch[0].scope === 'receiver' && ch[0].address === K && ch[0].from === true && ch[0].to === false)
  const c = changesOf(a, reading({ policies: { sender: '0', receiver: '6', executor: '0' }, kinds: { 6: { type: 'block', members: [] } } }))
  check('a bound id changes: said as a policy_id change', c.some((x) => x.kind === 'policy_id' && x.scope === 'receiver' && x.from === '5' && x.to === '6'))
  check('paused or unpaused: said', changesOf(a, { ...a, paused: true }).some((x) => x.kind === 'paused' && x.to === true) && changesOf({ ...a, paused: true }, a).some((x) => x.kind === 'paused' && x.to === false))
  check('a failed reading is never compared', changesOf(a, { ...b, error: 'read_failed' }).length === 0 && changesOf(null, b).length === 0)
  check('an answer that could not be read is not a change', changesOf(a, reading({ policies: a.policies, kinds: { 5: { type: 'block', members: [] } }, drop: ['5|' + K] })).length === 0)
  const text = changeText({ symbol: 'TSLAc', token: T, block: 101 }, ch)
  check('the alert names the token, the scope and what changed, and says it is not a verdict change', text.includes('TSLAc') && text.includes(T) && text.includes('TRANSFER_RECEIVER_POLICY') && text.includes('allowed -> refused') && /not a verdict change/.test(text))
}

console.log('a venue by its role, and the probe wallet by its name')
{
  const r = reading({ policies: { sender: '0', receiver: '7', executor: '0' }, kinds: { 7: { type: 'block', members: [P1] } } })
  const t = at(r)
  check('a pool refused only as a receiver: refused in that role, not as a sender', venueRefused(t, P1, ['receiver']) && !venueRefused(t, P1, ['sender', 'executor']) && t.venues.find((v) => v.address === P1).scopes.receiver === false)
  const w = reading({ policies: { sender: '0', receiver: '7', executor: '0' }, kinds: { 7: { type: 'block', members: [ORDINARY_WALLET] } } })
  const ch = changesOf(reading({ policies: w.policies, kinds: { 7: { type: 'block', members: [] } } }), w)
  check('a change of the ordinary wallet\'s answer names it, without its address', ch.length === 1 && ch[0].account === 'ordinary_wallet' && ch[0].address === null && !changeText({ symbol: 'X', token: T, block: 1 }, ch).includes(ORDINARY_WALLET))
  const snap = snapshotOf(w)
  check('the snapshot for health-check: no probe address anywhere, venues by name and contract', !JSON.stringify(snap).includes(ORDINARY_WALLET.slice(2)) && snap.answers['ordinary_wallet|receiver'] === false && snap.answers['pool:' + P1 + '|receiver'] === true)
  const sc = snapshotChanges(snapshotOf(reading({ policies: w.policies, kinds: { 7: { type: 'block', members: [] } } })), snap)
  check('snapshotChanges sees the same change, and nothing when equal', sc.length === 1 && sc[0].account === 'ordinary_wallet' && sc[0].address === null && snapshotChanges(snap, snap).length === 0)
}

console.log('the enums are the passport schema\'s')
{
  const schema = JSON.parse(fs.readFileSync(new URL('../../../docs/reference/passport.schema.json', import.meta.url), 'utf8'))
  const t = schema.definitions.transfers.properties
  check('state', JSON.stringify(t.state.enum) === JSON.stringify([...STATES]))
  check('reason', JSON.stringify(t.reason.enum.filter(Boolean)) === JSON.stringify([...REASONS]))
  check('venue name', JSON.stringify(t.venues.items.properties.name.enum) === JSON.stringify([...VENUE_NAMES]))
  const block = at(reading())
  check('a block has exactly the schema\'s fields', JSON.stringify(Object.keys(block).sort()) === JSON.stringify([...schema.definitions.transfers.required].sort()))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
