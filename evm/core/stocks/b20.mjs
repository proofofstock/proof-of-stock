// evm/core/stocks/b20.mjs: what a Coinbase stock token's own B20 transfer rules allow, from the reads of
// apps/b20-reader.mjs (docs/b20-transfers-tz.md). Pure: the scope constants, the state from the reads, the passport's
// `latest.transfers` block, and the change between two readings for the owner's alert. It fetches nothing.
//
// Every Coinbase stock token on Base is a B20 token (Base's native token standard). Since the Denim upgrade the issuer
// can bind a policy of the policy registry to each transfer scope (sender, receiver, executor) and pause transfers,
// without any change to the token's address. A policy's membership can change at any time, with no event on the token.
//
// ⚠ IT NEVER CHANGES "LISTED". A B20 rule is the issuer's own decision about its own token. Nothing here is read by the
//   verdict, the list locks or the impostor list; the only readers are the passport block, simulate_buy and the alert.
// ⚠ FACTS, NOT ADVICE. "restricted" says the chain refused one of the accounts we check, never "unsafe" or "avoid".
// ⚠ UNREADABLE IS `unknown`, NEVER `open`. A failed read, a stale reading, an answer that does not decode, or a bound
//   policy id the registry does not hold. The registry answers isAuthorized for a well-formed unknown id as an empty
//   set, so a blocklist-shaped or intersect-shaped unknown id says `true` for everyone: policyExists decides first.
// ⚠ THE STATE FOLLOWS isAuthorized, NOT THE ID'S SHAPE. No bit of an id is read here except that id 0 is the built-in
//   "always allow" (docs.base.org, B20 policies): inverted, union and intersect ids are whatever the registry answers.
//
// Selectors, scopes and the registry address from docs.base.org/specifications/b20 (constants, IB20, IPolicyRegistry,
// roles and pause), read 27.11.2026, and each selector answered on Base mainnet that day (scripts/stocks/b20-live-check.mjs).

/** The policy registry precompile. */
export const POLICY_REGISTRY = '0x8453000000000000000000000000000000000002'
/** keccak256 of each transfer scope's name, as IB20.policyId(bytes32) takes it. */
export const SCOPES = Object.freeze({
  sender: '0xb81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5', // TRANSFER_SENDER_POLICY, checked against `from`
  receiver: '0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363', // TRANSFER_RECEIVER_POLICY, against `to`
  executor: '0x10be5173aff2a44e748bd9acd8b19fe34689581398a9db7ba2fb671e786ff7d8', // TRANSFER_EXECUTOR_POLICY, against msg.sender
})
export const SCOPE_NAMES = Object.freeze({ sender: 'TRANSFER_SENDER_POLICY', receiver: 'TRANSFER_RECEIVER_POLICY', executor: 'TRANSFER_EXECUTOR_POLICY' })
export const SCOPE_KEYS = Object.freeze(['sender', 'receiver', 'executor'])
/** Four-byte selectors: policyId(bytes32), isPaused(uint8) on the token; policyExists(uint64), isAuthorized(uint64,address) on the registry. */
export const SEL = Object.freeze({ policyId: 'db3de624', isPaused: 'bc61e733', policyExists: '330f5637', isAuthorized: '55a1179e' })
/** PausableFeature.TRANSFER (bit 0). */
export const PAUSE_TRANSFER = 0
/** The built-in ALWAYS_ALLOW id, and the unset default of every scope: it needs no read. */
export const ALWAYS_ALLOW = '0'
/** A reading older than this is `unknown` (stale): three refresh cycles of 5 minutes. */
export const STALE_S = 900
/** At most this many of a token's pools are checked, deepest first. */
export const MAX_POOLS = 5
/**
 * "An ordinary wallet": an address nobody holds a key for, the last 20 bytes of keccak256 of ORDINARY_PHRASE (the test
 * recomputes it). If a scope refuses it, that scope is an allowlist, or blocks everyone.
 */
export const ORDINARY_PHRASE = 'proofofstock.xyz: an ordinary wallet that nobody controls, for reading B20 transfer policies'
export const ORDINARY_WALLET = '0x27c44b0faa91ec545e66317d33bce08170783510'
/** Uniswap v4's PoolManager on Base: every v4 pool's tokens sit in it. */
export const UNISWAP_V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'

// ── The enums, held equal to docs/reference/passport.schema.json by evm/core/stocks/b20.test.mjs ──────────────────────
export const STATES = Object.freeze(['open', 'restricted', 'paused', 'unknown'])
export const REASONS = Object.freeze(['not_read', 'read_failed', 'stale', 'rpc_disagree', 'single_source', 'undecodable', 'policy_missing', 'ordinary_wallet_refused', 'venue_refused'])
/** The reasons a block carries no current, two-source reading: nothing in it may be acted on. */
export const NOT_CURRENT = Object.freeze(['not_read', 'read_failed', 'stale', 'rpc_disagree', 'single_source'])
export const VENUE_NAMES = Object.freeze(['kyberswap_router', 'aerodrome_router', 'pool', 'uniswap_v4'])
export const SOURCE = 'the token\'s B20 policies and pause state, read from Base'
const PAUSE_LIST_SOURCE = 'the issuer\'s list (paused_features)'
const PAUSE_CHAIN_SOURCE = 'isPaused(TRANSFER) on the token, read from Base'

const low = (s) => String(s || '').toLowerCase()
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const addrWord = (a) => low(a).replace(/^0x/, '').padStart(64, '0')

/** Calldata of the four reads. A policy id is a decimal string of a uint64. */
export const calldata = Object.freeze({
  policyId: (scope) => '0x' + SEL.policyId + SCOPES[scope].slice(2),
  isPaused: () => '0x' + SEL.isPaused + word(PAUSE_TRANSFER),
  policyExists: (id) => '0x' + SEL.policyExists + word(id),
  isAuthorized: (id, account) => '0x' + SEL.isAuthorized + word(id) + addrWord(account),
})

/** A uint64 from one returned word, as a decimal string; null for anything that is not exactly one word below 2^64. */
export function idOf (r) {
  if (!r || !r.success || typeof r.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.data)) return null
  const v = BigInt(r.data)
  return v < (1n << 64n) ? v.toString() : null
}
/** A bool from one returned word: exactly 0 or 1, anything else (a failed call, a short answer) is null. */
export function boolOf (r) {
  if (!r || !r.success || typeof r.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.data)) return null
  const v = BigInt(r.data)
  return v === 1n ? true : v === 0n ? false : null
}

/**
 * The accounts checked for one token (§2), in order: the ordinary wallet, the routers, the token's pools (deepest
 * first, at most MAX_POOLS), the v4 PoolManager.
 */
export function accountsOf ({ kyberRouter, aerodromeRouters = [], pools = [] }) {
  const out = [{ name: 'ordinary_wallet', address: ORDINARY_WALLET, scopes: ['sender', 'receiver', 'executor'] }]
  if (kyberRouter) out.push({ name: 'kyberswap_router', address: low(kyberRouter), scopes: ['executor', 'receiver', 'sender'] })
  for (const r of aerodromeRouters) out.push({ name: 'aerodrome_router', address: low(r), scopes: ['executor'] })
  const seen = new Set(out.map((a) => a.address))
  for (const p of pools) {
    const a = low(p)
    if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a) || out.filter((x) => x.name === 'pool').length >= MAX_POOLS) continue
    // A pool sends the token to a buyer and calls that transfer; it receives the token on a sell-back.
    seen.add(a); out.push({ name: 'pool', address: a, scopes: ['sender', 'executor', 'receiver'] })
  }
  out.push({ name: 'uniswap_v4', address: UNISWAP_V4_POOL_MANAGER, scopes: ['sender', 'executor', 'receiver'] })
  return out
}

/**
 * What one scope's policy says of one account in a reading: true, false, 'missing' (the bound id does not exist) or
 * null (not read, or not decoded). Id 0 is "always allow" without a read; every other id needs policyExists true first.
 */
export function allowedIn (reading, scope, account) {
  const id = reading?.policies?.[scope]
  if (id == null) return null
  if (id === ALWAYS_ALLOW) return true
  const ex = reading.exists?.[id]
  if (ex === false) return 'missing'
  if (ex !== true) return null
  const a = reading.auth?.[id + '|' + low(account)]
  return a === true || a === false ? a : null
}
const all = (xs) => (xs.includes('missing') ? 'missing' : xs.includes(null) ? null : xs.every((x) => x === true))

/** The issuer list's pause beside the chain's: both, labelled by source, and whether they agree. */
export function pauseOf (reading, listPaused, fresh) {
  const chain = fresh && reading && (reading.paused === true || reading.paused === false) ? reading.paused : null
  const list = Array.isArray(listPaused) ? listPaused.length > 0 : null
  return { chain, chain_source: PAUSE_CHAIN_SOURCE, issuer_list: list, issuer_list_features: Array.isArray(listPaused) ? listPaused.map(String) : null, issuer_list_source: PAUSE_LIST_SOURCE, agree: chain == null || list == null ? null : chain === list }
}

/**
 * The passport's `latest.transfers` block (§3) from one reading of apps/b20-reader.mjs, or the `unknown` block when
 * there is none. `listPaused` is the issuer's own paused features for the token, said beside the chain's.
 * @param {object|null} reading  { token, block, block_hash, read_at, error, paused, policies, exists, auth, accounts }
 */
export function transfersOf (reading, { now, listPaused = null, mono = null } = {}) {
  const checkedAt = reading && Number.isFinite(reading.read_at) ? reading.read_at : null
  const ageMs = checkedAt == null ? null : now - checkedAt
  const ageS = ageMs == null ? null : Math.max(0, Math.round(ageMs / 1000))
  // Fresh by exact milliseconds, never a rounded age; and, where the reader stamped one, by a monotonic expiry too, so a
  // wall clock moved back cannot make an expired reading current again.
  const monoOk = !(reading && Number.isFinite(reading.expires_mono) && Number.isFinite(mono)) || mono <= reading.expires_mono
  const fresh = Boolean(reading && !reading.error && !reading.source_state && ageMs != null && ageMs <= STALE_S * 1000 && monoOk)
  const out = {
    state: 'unknown', reason: null, checked_at: checkedAt == null ? null : new Date(checkedAt).toISOString(), age_s: ageS,
    block: reading && Number.isInteger(reading.block) ? reading.block : null,
    policies: { sender: reading?.policies?.sender ?? null, receiver: reading?.policies?.receiver ?? null, executor: reading?.policies?.executor ?? null },
    ordinary_wallet: { send: null, receive: null },
    venues: [],
    pause: pauseOf(reading, listPaused, fresh),
    // A current reading the two RPCs agreed on: its definite answers may be acted on, even when another of its
    // sub-calls failed and the state is unknown.
    current: fresh,
    source: SOURCE,
  }
  const accounts = Array.isArray(reading?.accounts) ? reading.accounts : []
  const verdictOf = (acc) => all(acc.scopes.map((s) => allowedIn(reading, s, acc.address)))
  const asBool = (v) => (v === true || v === false ? v : null)
  const ordinary = accounts.find((a) => a.name === 'ordinary_wallet') || null
  // A wallet sending its own tokens is both `from` and the caller: the sender and the executor scopes.
  const send = ordinary ? all(['sender', 'executor'].map((s) => allowedIn(reading, s, ordinary.address))) : null
  const receive = ordinary ? allowedIn(reading, 'receiver', ordinary.address) : null
  out.ordinary_wallet = { send: asBool(send), receive: asBool(receive) }
  const venues = accounts.filter((a) => VENUE_NAMES.includes(a.name)).map((a) => ({ name: a.name, address: a.address, v: verdictOf(a), scopes: Object.fromEntries(a.scopes.map((s) => [s, asBool(allowedIn(reading, s, a.address))])) }))
  // `allowed` is every scope we check for that venue; `scopes` says each one, so a caller can ask the role it needs.
  out.venues = venues.map((x) => ({ name: x.name, address: x.address, allowed: asBool(x.v), scopes: x.scopes }))

  // Nothing actionable from a reading that is not current: its venues and probe answers are cleared.
  const blank = () => ({ ...out, ordinary_wallet: { send: null, receive: null }, venues: out.venues.map((v) => ({ ...v, allowed: null, scopes: Object.fromEntries(Object.keys(v.scopes).map((k) => [k, null])) })) })
  if (!reading) return { ...out, reason: 'not_read' }
  if (reading.error) return { ...blank(), reason: 'read_failed' }
  // One node must not decide: the two RPCs disagreed, or only one answered.
  if (reading.source_state === 'rpc_disagree' || reading.source_state === 'single_source') return { ...blank(), reason: reading.source_state }
  if (!fresh) return { ...blank(), reason: 'stale' }
  // Paused comes before any other state; a pause that could not be read is no "not paused".
  if (reading.paused === true) return { ...out, state: 'paused', reason: null }
  if (reading.paused !== false) return { ...out, reason: 'undecodable' }
  if (SCOPE_KEYS.some((s) => reading.policies?.[s] == null)) return { ...out, reason: 'undecodable' }
  if (!ordinary) return { ...out, reason: 'read_failed' }
  const verdicts = [send, receive, ...venues.map((x) => x.v)]
  if (verdicts.includes('missing')) return { ...out, reason: 'policy_missing' }
  if (verdicts.includes(null)) return { ...out, reason: 'read_failed' }
  if (send === false || receive === false) return { ...out, state: 'restricted', reason: 'ordinary_wallet_refused' }
  if (venues.some((x) => x.v === false)) return { ...out, state: 'restricted', reason: 'venue_refused' }
  return { ...out, state: 'open', reason: null }
}

/** The passport note a block carries, or null. */
export const noteOf = (t) => (t && t.state === 'restricted' ? 'transfers_restricted' : t && t.state === 'paused' ? 'transfers_paused' : null)

/**
 * Whether a block says the venue at `address` (one we named) is refused, from a current reading only: in any scope we
 * check for it, or, with `scopes`, in one of those (the role it plays in a given transfer).
 */
export function venueRefused (t, address, scopes = null) {
  // A confirmed denial from a current, two-source reading holds even when another sub-call of that reading failed
  // (the state is then `unknown`); nothing from a reading that is not current is acted on.
  if (!t || t.current !== true) return false
  return (t.venues || []).some((v) => v.address === low(address) && (scopes ? scopes.some((s) => v.scopes && v.scopes[s] === false) : v.allowed === false))
}

/**
 * Whether a current reading says, for the venue at `address`, a definite answer for every one of `scopes`: true when
 * all allow, false when one refuses, null when the reading cannot say (the venue was not checked, or a value is
 * missing). A caller reads a venue that is null at the chain's head before it counts it as checked.
 */
export function venueChecked (t, address, scopes) {
  if (!t || t.current !== true) return null
  const v = (t.venues || []).find((x) => x.address === low(address))
  if (!v || !v.scopes) return null
  const xs = scopes.map((s) => v.scopes[s])
  if (xs.includes(false)) return false
  return xs.every((x) => x === true) ? true : null
}

/** A baseline after a snapshot: each value the snapshot holds replaces the old one; one it lacks keeps the old one. */
export function mergeSnapshot (prev, snap) {
  if (!prev) return snap
  if (!snap) return prev
  const policies = Object.fromEntries(SCOPE_KEYS.map((s) => [s, snap.policies?.[s] ?? prev.policies?.[s] ?? null]))
  return { ...prev, block: snap.block ?? prev.block, block_hash: snap.block_hash ?? prev.block_hash ?? null, policies, paused: snap.paused === true || snap.paused === false ? snap.paused : prev.paused ?? null, answers: { ...(prev.answers || {}), ...(snap.answers || {}) } }
}

/**
 * What changed between two good readings of one token (§5): a bound policy id, the pause, or a policy's answer for an
 * account checked in both. A reading that failed is never compared (the reader keeps the last good one), so a flaky
 * RPC raises nothing. Returns [] when nothing changed.
 */
export function changesOf (prev, next) {
  if (!prev || !next || prev.error || next.error) return []
  const out = []
  for (const s of SCOPE_KEYS) {
    const a = prev.policies?.[s] ?? null, b = next.policies?.[s] ?? null
    if (a != null && b != null && a !== b) out.push({ kind: 'policy_id', scope: s, from: a, to: b })
  }
  if ((prev.paused === true || prev.paused === false) && (next.paused === true || next.paused === false) && prev.paused !== next.paused) out.push({ kind: 'paused', scope: null, from: prev.paused, to: next.paused })
  const before = new Map((prev.accounts || []).map((a) => [a.name + '|' + a.address, a]))
  for (const acc of next.accounts || []) {
    if (!before.has(acc.name + '|' + acc.address)) continue
    for (const s of acc.scopes) {
      const a = allowedIn(prev, s, acc.address), b = allowedIn(next, s, acc.address)
      // The probe wallet is named, never given by its address: it is ours, and no wallet is in a change.
      if (a !== b && a !== null && b !== null) out.push({ kind: 'answer', scope: s, account: acc.name, address: acc.name === 'ordinary_wallet' ? null : acc.address, from: a, to: b })
    }
  }
  return out
}

/**
 * A token's baseline as health-check reads it from /api/status (docs/b20-transfers-tz.md §5): the bound ids, the pause,
 * and each answer by account and scope. The probe wallet is `ordinary_wallet`, never its address; a venue is its name and
 * its contract's address. Only definite values: null is left out.
 */
export function snapshotOf (reading) {
  if (!reading || reading.error) return null
  const answers = {}
  for (const a of reading.accounts || []) for (const s of a.scopes) {
    const v = allowedIn(reading, s, a.address)
    if (v === true || v === false) answers[(a.name === 'ordinary_wallet' ? 'ordinary_wallet' : a.name + ':' + a.address) + '|' + s] = v
  }
  return { block: reading.block, block_hash: reading.block_hash ?? null, policies: { ...reading.policies }, paused: reading.paused === true || reading.paused === false ? reading.paused : null, answers }
}

/** What changed between two snapshots: the same change kinds as changesOf, from snapshotOf's shape. */
export function snapshotChanges (prev, next) {
  if (!prev || !next) return []
  const out = []
  for (const s of SCOPE_KEYS) {
    const a = prev.policies?.[s] ?? null, b = next.policies?.[s] ?? null
    if (a != null && b != null && a !== b) out.push({ kind: 'policy_id', scope: s, account: null, address: null, from: a, to: b })
  }
  if ((prev.paused === true || prev.paused === false) && (next.paused === true || next.paused === false) && prev.paused !== next.paused) out.push({ kind: 'paused', scope: null, account: null, address: null, from: prev.paused, to: next.paused })
  for (const [k, b] of Object.entries(next.answers || {})) {
    const a = prev.answers?.[k]
    if (a === true || a === false) {
      if (a !== b) { const [who, scope] = k.split('|'); const [name, address = null] = who.split(':'); out.push({ kind: 'answer', scope, account: name, address, from: a, to: b, key: k }) }
    }
  }
  return out
}

const said = (v) => (v === true ? 'allowed' : v === false ? 'refused' : v === 'missing' ? 'policy missing' : 'unknown')
/** One alert's text: the token, each scope and what changed. Plain words, no verdict. */
export function changeText ({ symbol, token, block }, changes) {
  const parts = changes.map((c) => c.kind === 'policy_id' ? `${SCOPE_NAMES[c.scope]} id ${c.from} -> ${c.to}`
    : c.kind === 'paused' ? `transfers ${c.to ? 'paused' : 'unpaused'} (isPaused(TRANSFER) ${c.from} -> ${c.to})`
      : `${c.account}${c.account === 'ordinary_wallet' || !c.address ? '' : ' ' + c.address} under ${SCOPE_NAMES[c.scope]}: ${said(c.from)} -> ${said(c.to)}`)
  return `B20 transfer rules changed on Base for ${symbol || 'a listed token'} (${token}), read at block ${block}: ${parts.join('; ')}. The issuer's own rule, not a verdict change.`
}
