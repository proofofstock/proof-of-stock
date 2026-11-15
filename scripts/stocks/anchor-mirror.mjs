// scripts/stocks/anchor-mirror.mjs: the day's root hash, written to Base and to Robinhood Chain as well.
//
// The root is Bitcoin (scripts/stocks/anchor.mjs, through OpenTimestamps), and it stays the root: Base is sequenced by
// Coinbase and Robinhood Chain by Robinhood, which are the two issuers this service checks, so neither can be the
// place where our history proves its own age. These two are mirrors, for reach and for speed: a block instead of a few
// hours, and a hash an agent working on that chain can read without leaving it. A mirror that disagrees with the root
// is a fact about the mirror (spec H4).
//
//   node scripts/stocks/anchor-mirror.mjs [--day=YYYY-MM-DD] [--out=/var/lib/stp-anchors] [--chain=base] [--dry-run]
//
// What it sends, and what it cannot send. One transaction per chain per day: TO ITS OWN ADDRESS, value zero, with the
// day and the manifest hash as plain ASCII calldata, so that anyone reading the transaction in an explorer sees what
// it says without a decoder and without us. The recipient is the signer and the value is zero in the code itself, not
// as a convention, so the worst a bug in this file can do is waste its own gas. There is no transfer, no approval and
// no call to anyone's contract anywhere in this project.
//
// Writes, in --out: mirror-<day>.json, beside the manifest it mirrors. A transaction already recorded for a day and a
// chain is never sent twice; a rerun only fills in what is missing and updates a pending one with its block.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isEntryPoint } from '../lib/invoked-directly.mjs'
import { signTransaction, addressOfKey, checksumAddress } from '../../evm/core/stocks/evm-tx.mjs'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const MIRROR_FILE_RE = /^mirror-(\d{4}-\d{2}-\d{2})\.json$/
export const MIRROR_SCHEMA = 'proofofstock-anchor-mirror/1'
export const TX_HASH_RE = /^0x[0-9a-f]{64}$/

// Chain ids, gas prices and explorers read from each chain's own public RPC and docs on 13.11.2026. The RPC url can be
// replaced by a keyed provider through the env name, exactly as the pool reader does; the evidence always names the
// public one.
//
// Why both chains get the same plain transaction, and not an EAS attestation on Base (owner, 14.11, after both chains
// were checked; it had been the other way round in the spec). EAS is deployed on Base (the OP
// predeploy 0x4200...0021) and is NOT deployed on Robinhood Chain, on mainnet or testnet; it also costs about seven
// times the gas of this transaction. An attestation would therefore mean one chain mirrored one way and the other
// another way, two code paths, and a contract we do not control in the middle of the one thing that has to keep
// working every day. The same bytes on both chains is the simpler promise, and an attestation can be added on top
// later without changing what is anchored. The trade we accept: a CONTRACT cannot read the calldata of a past
// transaction, so these mirrors are for people, agents and indexers, not for other contracts.
export const MIRRORS = Object.freeze(Object.assign(Object.create(null), {
  base: { chainId: 8453, rpc: 'https://mainnet.base.org', env: 'STP_RPC_BASE', explorer: 'https://basescan.org/tx/' },
  // Robinhood Chain is an Arbitrum Orbit chain: the sequencer is first come first served, there is no priority gas
  // auction, and eth_maxPriorityFeePerGas answers zero. feesFrom handles that without a special case.
  robinhood: { chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com', env: 'STP_RPC_ROBINHOOD', explorer: 'https://robinhoodchain.blockscout.com/tx/' },
}))

// A WITNESS IS ONLY A WITNESS IF IT IS SOMEBODY ELSE. The endpoint we send a transaction to is run by the issuer this
// service judges, and a receipt is a message from that endpoint: on its own, "confirmed in block N" is one interested
// party's word, and the record used to repeat it as a fact forever (audit, 14.11). So a mirror is called confirmed
// only once a node run by somebody else says the same thing, and says it about the same bytes: this hash, in a block,
// successful, from and to the one address, value zero, carrying this day and this manifest hash as text. These are
// public endpoints of other operators on the same chains, replaceable through the env name.
export const WITNESSES = Object.freeze(Object.assign(Object.create(null), {
  base: { env: 'STP_WITNESS_BASE', urls: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://base.gateway.tenderly.co'] },
  robinhood: { env: 'STP_WITNESS_ROBINHOOD', urls: ['https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org'] },
}))
const WITNESS_TIMEOUT_MS = 12_000
export const WITNESSES_NEEDED = 2

/** The witnesses of a chain, never including the endpoint we sent to. */
export function witnessUrls (chain, env = process.env) {
  const cfg = WITNESSES[chain]
  if (!cfg) return []
  const given = env[cfg.env]
  const urls = given ? String(given).split(',').map((x) => x.trim()).filter(Boolean) : cfg.urls
  for (const u of urls) if (!/^https:\/\//.test(u)) throw new Error(`${cfg.env} must be https urls`)
  // By origin, not by string: a trailing slash, a :443 or a capital letter in STP_RPC_BASE would otherwise let the
  // very node we sent the transaction to into the list of witnesses, where it would confirm its own word.
  const sameHost = (a, b) => { try { return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase() } catch (_) { return a === b } }
  const primary = rpcUrlOf(chain, env)
  return urls.filter((u) => !sameHost(u, primary))
}

const hostOf = (u) => { try { return new URL(u).host } catch (_) { return String(u).slice(0, 40) } }

/**
 * What one witness can say: `agreed` (it has this transaction in a block and it carries what we say it carries),
 * `contradicted` (it has it and something does not match, which is an alarm, not a retry) or `silent` (it cannot say).
 */
export async function askWitness ({ url, tx, day, sha256, from, fetchImpl = fetch }) {
  const source = hostOf(url)
  const t = await rpc(fetchImpl, url, 'eth_getTransactionByHash', [tx], WITNESS_TIMEOUT_MS)
  if (!t) return { source, kind: 'silent', why: 'does not have this transaction' }
  const r = await rpc(fetchImpl, url, 'eth_getTransactionReceipt', [tx], WITNESS_TIMEOUT_MS)
  if (!r) return { source, kind: 'silent', why: 'has it but no receipt yet' }
  // An answer that is not shaped like an answer is SILENCE, never a contradiction. A proxy, a cache or a limited
  // gateway that drops a field would otherwise be read as "this transaction carries something else", which is the
  // loudest thing this file can say: it alerts, and it tells agents not to rely on the mirror. Anyone holding one
  // witness URL could raise that alarm at will (review, 14.11).
  const shaped = t && typeof t === 'object' && r && typeof r === 'object'
    && /^0x[0-9a-fA-F]{40}$/.test(String(t.from)) && /^0x[0-9a-fA-F]{40}$/.test(String(t.to || ''))
    && /^0x[0-9a-fA-F]*$/.test(String(t.value)) && /^0x[0-9a-fA-F]*$/.test(String(t.input || '0x'))
    && (r.status === '0x0' || r.status === '0x1') && /^0x[0-9a-fA-F]+$/.test(String(r.blockNumber))
  if (!shaped) return { source, kind: 'silent', why: 'answered something that is not a transaction' }
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
  const read = readAnchorCalldata(t.input)
  if (r.status !== '0x1') return { source, kind: 'contradicted', why: 'the transaction did not succeed' }
  if (!same(t.from, from) || !same(t.to, from)) return { source, kind: 'contradicted', why: 'another sender or recipient' }
  if (BigInt(t.value || 0) !== 0n) return { source, kind: 'contradicted', why: 'it moves value' }
  if (!read) return { source, kind: 'contradicted', why: 'its calldata is not one of ours' }
  if (read.day !== day || read.sha256 !== sha256) return { source, kind: 'contradicted', why: `it carries ${read.day} ${read.sha256.slice(0, 12)}, not this day and hash` }
  return { source, kind: 'agreed', block: Number(r.blockNumber) }
}

/** Ask every witness of a chain, and say what the mirror's status is as a result. */
export async function witnessMirror ({ chain, tx, day, sha256, from, fetchImpl = fetch, env = process.env, urls = null }) {
  const list = urls || witnessUrls(chain, env)
  const asked = []
  for (const url of list) {
    try { asked.push(await askWitness({ url, tx, day, sha256, from, fetchImpl })) } catch (e) { asked.push({ source: hostOf(url), kind: 'silent', why: String(e && e.message || e).slice(0, 60) }) }
  }
  const agreed = asked.filter((a) => a.kind === 'agreed')
  const against = asked.filter((a) => a.kind === 'contradicted')
  const out = { witnessed_by: agreed.map((a) => a.source) }
  // TWO witnesses, as for the Bitcoin block, and for the same reason. A witness is a stranger's node: it can simply
  // answer with a transaction that matches what we hope to see, and one of those is not evidence, it is a claim
  // (review, 14.11). Two operators have to be wrong together before this service says the word.
  if (against.length) { out.status = 'contradicted'; out.contradicted = against.map((a) => `${a.source}: ${a.why}`) }
  else if (agreed.length >= WITNESSES_NEEDED) { out.status = 'confirmed'; out.block = agreed[0].block }
  else { out.status = 'in-block-unwitnessed'; out.unwitnessed = asked.filter((a) => a.kind !== 'agreed').map((a) => `${a.source}: ${a.why}`).concat(agreed.map((a) => `${a.source}: agreed, but alone`)) }
  return out
}

// A day's writes must stay in the cents, whatever the chain is doing. 0.0002 ETH is a few hundred times the measured
// cost of one of these transactions: past that the chain is having a day we do not need to take part in.
export const MAX_FEE_WEI = 200_000_000_000_000n
// Below this many days of writes left, the unit fails so the alert goes out while there is still time to top it up.
export const LOW_BALANCE_DAYS = 30
const SEND_TIMEOUT_MS = 20_000
const RECEIPT_WAIT_MS = 90_000
const RECEIPT_EVERY_MS = 5_000

/** What the transaction carries: readable in any explorer, in one line, forever. */
export function anchorCalldata (day, sha256) {
  if (!DAY_RE.test(day)) throw new Error('day must be YYYY-MM-DD')
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 lower-case hex characters')
  return '0x' + Buffer.from(`proofofstock anchor ${day} sha256:${sha256}`, 'ascii').toString('hex')
}

/** The same line back out of the calldata, or null if it is not one of ours. */
export function readAnchorCalldata (data) {
  const hex = String(data || '').replace(/^0x/, '')
  if (!hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) return null
  const m = Buffer.from(hex, 'hex').toString('ascii').match(/^proofofstock anchor (\d{4}-\d{2}-\d{2}) sha256:([0-9a-f]{64})$/)
  return m ? { day: m[1], sha256: m[2] } : null
}

/**
 * The fees for one write, from what the chain says now. maxFee covers a base fee that doubles before the transaction
 * is mined, which is the usual advice and still costs almost nothing at these gas prices.
 */
export function feesFrom ({ baseFeePerGas, priorityFeePerGas, gas }) {
  // A missing base fee is not a zero one. Taking it as zero made maxFeePerGas zero, which made the worst case zero,
  // which made the cost cap and the balance check both pass trivially: a node that answers nothing about the fee
  // market could get a zero-fee transaction signed and sent (to be refused on arrival). Unknown means refuse.
  if (baseFeePerGas == null || BigInt(baseFeePerGas) <= 0n) throw new Error('the chain did not say what the base fee is')
  const base = BigInt(baseFeePerGas || 0)
  const priority = BigInt(priorityFeePerGas || 0)
  const maxFeePerGas = base * 2n + priority
  const gasLimit = BigInt(gas)
  return { maxFeePerGas, maxPriorityFeePerGas: priority, gasLimit, worstCaseWei: maxFeePerGas * gasLimit }
}

/** Whether to send at all, and what to say when not. Pure, so the refusals are tested rather than hoped for. */
export function sendDecision ({ worstCaseWei, balanceWei, maxFeeWei = MAX_FEE_WEI, lowBalanceDays = LOW_BALANCE_DAYS }) {
  if (worstCaseWei <= 0n) return { send: false, reason: 'a write that costs nothing means the fees are not known' }
  if (worstCaseWei > maxFeeWei) return { send: false, reason: `one write would cost up to ${worstCaseWei} wei, over the cap of ${maxFeeWei}` }
  if (BigInt(balanceWei) < worstCaseWei) return { send: false, reason: 'the balance does not cover one write' }
  const daysLeft = Number(BigInt(balanceWei) / worstCaseWei)
  return { send: true, daysLeft, lowBalance: daysLeft < lowBalanceDays }
}

export function rpcUrlOf (chain, env = process.env) {
  const url = env[MIRRORS[chain].env]
  // A keyed provider may replace the public endpoint, but only over https: everything here goes one way to a chain,
  // and a plain-http endpoint on the host would be a transaction of ours readable and replaceable on the wire.
  if (url && !/^https:\/\//.test(url)) throw new Error(`${MIRRORS[chain].env} must be an https url`)
  return url || MIRRORS[chain].rpc
}

/** One JSON-RPC call. Errors from the node are thrown with their message, never swallowed. */
export const MAX_RPC_BYTES = 512 * 1024
export async function rpc (fetchImpl, url, method, params = [], timeoutMs = SEND_TIMEOUT_MS) {
  const r = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
    // A node, or a witness, is a stranger: it does not get to decide how much memory we spend, or where we go next.
    redirect: 'error',
  })
  if (!r.ok) throw new Error(`${method}: the node answered ${r.status}`)
  const text = await r.text()
  if (text.length > MAX_RPC_BYTES) throw new Error(`${method}: the node answered ${text.length} bytes`)
  const j = JSON.parse(text)
  if (j && j.error) throw new Error(`${method}: ${String(j.error.message || j.error).slice(0, 120)}`)
  return j ? j.result : undefined
}

/**
 * Read the 32-byte key. It comes from systemd's credentials directory on the host, or from a file named by the
 * caller; it is never an argument, never an environment variable holding the key itself, and never logged.
 */
export function loadKey (env = process.env) {
  const file = env.STP_ANCHOR_KEY_FILE || (env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, 'anchor-key') : null)
  if (!file) throw new Error('no key: set STP_ANCHOR_KEY_FILE, or give the unit LoadCredential=anchor-key')
  const text = fs.readFileSync(file, 'utf8').trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error('the key file does not hold 32 bytes of hex')
  return Buffer.from(text, 'hex')
}

/** The mirror record of a day, as it stands on disk. */
export function readMirror (outDir, day) {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, `mirror-${day}.json`), 'utf8')) } catch (_) { return null }
}

function writeMirror (outDir, day, record) {
  const file = path.join(outDir, `mirror-${day}.json`)
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n')
  // ⚠ READABLE BY EVERYONE, ON PURPOSE, AND SET RATHER THAN INHERITED. This directory is served at /anchors/ and is
  // copied by the backup user, which is not the user that writes it. The unit that holds the key runs with UMask=0077,
  // so a file written here inherited 0600 and the backup stopped mid-snapshot, loudly (found on the host, 14.11, the
  // first time the anchors were included in a copy). Nothing secret is ever written to this directory.
  fs.chmodSync(tmp, 0o644)
  fs.renameSync(tmp, file)
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/**
 * Mirror one day on one chain. Returns what happened, and never throws for a chain being unreachable: one chain down
 * must not stop the other, and tomorrow's run picks up what is missing.
 */
export async function mirrorChain ({ chain, day, sha256, key, fetchImpl = fetch, env = process.env, previous = null, dryRun = false, now = () => Date.now(), nonces = null }) {
  const cfg = MIRRORS[chain]
  if (!cfg) throw new Error(`unknown chain ${chain}`)
  const url = rpcUrlOf(chain, env)
  const from = addressOfKey(key)
  const data = anchorCalldata(day, sha256)
  const out = { chain, chain_id: cfg.chainId, from: checksumAddress(from), to: checksumAddress(from), sha256 }

  // Already sent for this day and this hash? Then see whether it has a block yet. A transaction can also be DROPPED:
  // a sequencer restart or a fee spike past our headroom evicts it, and then the chain has neither a receipt nor the
  // transaction itself. Saying "pending" forever in that case would leave the record claiming a transaction that
  // exists nowhere, which is exactly the kind of false statement this whole service is against. So: no receipt and no
  // transaction means gone, and we send a new one at a fresh nonce. A reverted one is not retried from here either;
  // it falls through to a new send, since the old hash will never become good.
  // A day already in a block is finished as far as sending goes: a node that has lost the transaction (a pruned or
  // lagging one behind the public endpoint answers null to both questions) must not be able to talk us into sending a
  // second one, or into downgrading a record that names a block back to "not in a block yet". What is left to do for
  // such a day is get it witnessed by somebody who is not the endpoint we sent to.
  if (previous && previous.tx && previous.sha256 === sha256 && Number.isInteger(previous.block) && previous.status !== 'reverted') {
    // Confirmed, but by whom? A record written before there were witnesses (or by a run whose witnesses were all
    // silent) carries the word without anybody behind it. It is asked again until somebody is.
    if (previous.status === 'confirmed' && (previous.witnessed_by || []).length) return { ...previous }
    return { ...previous, ...await witnessMirror({ chain, tx: previous.tx, day, sha256, from, fetchImpl, env }) }
  }
  if (previous && previous.tx && previous.sha256 === sha256 && previous.status !== 'reverted') {
    const receipt = await rpc(fetchImpl, url, 'eth_getTransactionReceipt', [previous.tx]).catch(() => undefined)
    if (receipt && receipt.status !== '0x1') return { ...previous, status: 'reverted', block: Number(receipt.blockNumber) }
    if (receipt) return { ...previous, block: Number(receipt.blockNumber), ...await witnessMirror({ chain, tx: previous.tx, day, sha256, from, fetchImpl, env }) }
    const inPool = receipt === undefined ? undefined : await rpc(fetchImpl, url, 'eth_getTransactionByHash', [previous.tx]).catch(() => undefined)
    // undefined: we could not ask, so nothing is known and nothing changes. null: the chain does not have it at all.
    if (inPool === undefined || inPool) return { ...previous, status: previous.status === 'confirmed' ? 'confirmed' : 'pending' }
    out.replaces = previous.tx
  }

  const chainId = Number(await rpc(fetchImpl, url, 'eth_chainId'))
  if (chainId !== cfg.chainId) throw new Error(`${chain}: the rpc answers for chain ${chainId}, not ${cfg.chainId}`)
  const [nonceHex, balanceHex, block] = await Promise.all([
    rpc(fetchImpl, url, 'eth_getTransactionCount', [from, 'pending']),
    rpc(fetchImpl, url, 'eth_getBalance', [from, 'latest']),
    rpc(fetchImpl, url, 'eth_getBlockByNumber', ['latest', false]),
  ])
  const priority = await rpc(fetchImpl, url, 'eth_maxPriorityFeePerGas').catch(() => '0x0')
  const gas = await rpc(fetchImpl, url, 'eth_estimateGas', [{ from, to: from, value: '0x0', data }])
  const fees = feesFrom({ baseFeePerGas: block && block.baseFeePerGas, priorityFeePerGas: priority, gas })
  const decision = sendDecision({ worstCaseWei: fees.worstCaseWei, balanceWei: BigInt(balanceHex) })
  out.cost_cap_wei = String(fees.worstCaseWei)
  out.days_left = decision.send ? decision.daysLeft : 0
  if (!decision.send) return { ...out, status: 'skipped', reason: decision.reason }
  // Which nonce. Normally the pending count. But when we are replacing a transaction the chain says it has dropped,
  // and the count comes back HIGHER than the one that transaction used, some node behind the public endpoint still
  // holds it: taking the count would leave a hole at the old nonce that nothing would ever fill, because this key has
  // exactly one sender, and every later write would queue behind it forever. So the old nonce is taken back. If the
  // old transaction does turn out to be alive somewhere, the node answers "replacement underpriced", the write fails
  // loudly, and the day is tried again tomorrow.
  //
  // AND the count alone is not enough when a run sends more than one transaction on the same chain, which it does
  // every time it catches a day up. Robinhood Chain's sequencer answered the same pending count after accepting a
  // transaction (seen on the first real run, 14.11: the write for 11.11 took the nonce 12.11 was already using and
  // came back "nonce too low"). So the run keeps its own count per chain and takes whichever is further ahead: the
  // node's, in case something else moved, or its own, in case the node has not caught up with us. The alternative,
  // trusting the node, is worse than a loud failure: two transactions at one nonce can REPLACE each other, and one
  // day's mirror would quietly become another day's.
  const counted = Number(nonceHex)
  const reclaim = out.replaces && Number.isInteger(previous && previous.nonce) && previous.nonce < counted
  const ours = nonces && nonces.has(chain) ? nonces.get(chain) : 0
  const nonce = reclaim ? previous.nonce : Math.max(counted, ours)
  if (dryRun) return { ...out, status: 'dry-run', nonce, gas: Number(gas), text: Buffer.from(data.slice(2), 'hex').toString('ascii') }

  const signed = signTransaction({
    chainId: cfg.chainId, nonce: BigInt(nonce), maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas, gasLimit: fees.gasLimit, to: from, value: 0, data,
  }, key)
  if (signed.from.toLowerCase() !== from.toLowerCase()) throw new Error('the signature does not belong to the key we loaded')
  const tx = await rpc(fetchImpl, url, 'eth_sendRawTransaction', [signed.raw])
  if (nonces && !reclaim) nonces.set(chain, nonce + 1)
  // The node's answer is the node's text, and it ends up in a sentence we tell agents to quote. These two rpcs are
  // run BY the issuers this service judges (mainnet.base.org is Coinbase's, rpc.mainnet.chain.robinhood.com is
  // Robinhood's), so a transaction hash is checked like any other stranger's string before it is written down. Same
  // rule as a token's name (evm/core/stocks/untrusted-text.mjs).
  // eth_sendRawTransaction must answer keccak256(raw), and we already know that number: signTransaction computed it
  // before the send. So this is not a format check, it is an equality check, and the only one available without a
  // second source. A node that answers anything else is either broken or lying, and either way we do not write its
  // number down as ours (audit, 14.11: the format check alone let a made-up hash into the record).
  if (!TX_HASH_RE.test(String(tx))) throw new Error('the node did not answer with a transaction hash')
  if (String(tx) !== signed.hash) throw new Error(`the node answered a different transaction hash than the one we signed (${String(tx).slice(0, 12)}...)`)
  // first_sent_at is the DAY's clock, not this attempt's. A new attempt every night would otherwise keep resetting
  // the staleness check, and a day that is accepted and dropped over and over would never raise an alert: the quiet
  // stop all of this exists to prevent.
  const at = new Date(now()).toISOString()
  const same = previous && previous.sha256 === sha256
  return {
    ...out, tx, status: 'pending', nonce, sent_at: at,
    first_sent_at: (same && (previous.first_sent_at || previous.sent_at)) || at,
    attempts: ((same && (previous.attempts || 1)) || 0) + 1,
    low_balance: !!decision.lowBalance,
  }
}

/** Wait a little for a block, so that a normal run records the confirmation instead of leaving it to tomorrow. */
export async function waitForReceipt ({ chain, tx, fetchImpl = fetch, env = process.env, waitMs = RECEIPT_WAIT_MS, everyMs = RECEIPT_EVERY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const url = rpcUrlOf(chain, env)
  const until = now() + waitMs
  for (;;) {
    const receipt = await rpc(fetchImpl, url, 'eth_getTransactionReceipt', [tx]).catch(() => null)
    // In a block according to the one node we sent to, which is not the same thing as confirmed: the word is earned
    // only when somebody else has said it too (witnessMirror).
    if (receipt) return { status: receipt.status === '0x1' ? 'in-block-unwitnessed' : 'reverted', block: Number(receipt.blockNumber) }
    if (now() >= until) return { status: 'pending' }
    await sleep(everyMs)
  }
}

/** Mirror a day on every chain, and write the record beside the manifest. */
export async function mirrorDay ({ outDir, day, chains = Object.keys(MIRRORS), key, fetchImpl = fetch, env = process.env, dryRun = false, now = () => Date.now(), wait = waitForReceipt, log = console.log, nonces = null }) {
  const unknown = chains.filter((c) => !MIRRORS[c])
  if (unknown.length) throw new Error(`unknown chain: ${unknown.join(', ').slice(0, 60)}`)
  const mf = path.join(outDir, `manifest-${day}.json`)
  if (!fs.existsSync(mf)) throw new Error(`no manifest for ${day}: the anchor has not run for that day`)
  const sha256 = sha256File(mf)
  const before = readMirror(outDir, day)
  const kept = new Map((before && before.mirrors || []).map((m) => [m.chain, m]))
  // A run over one chain (--chain=) must not drop the other one out of the record: a chain whose write is not being
  // attempted keeps the entry it had. Losing it would make the next run think that day was never written there and
  // send a second transaction for a day already on chain.
  const byChain = new Map([...kept].filter(([c]) => !chains.includes(c)))
  const record = () => ({ _schema: MIRROR_SCHEMA, day, manifest: path.basename(mf), sha256, written_at: new Date(now()).toISOString(), mirrors: [...byChain.values()], note: 'The same hash as the Bitcoin anchor of this day, written to each chain as plain text. The Bitcoin proof is the root; these are mirrors.' })
  for (const chain of chains) {
    let r
    try {
      r = await mirrorChain({ chain, day, sha256, key, fetchImpl, env, previous: kept.get(chain) || null, dryRun, now, nonces })
      if (r.tx && r.status === 'pending' && !dryRun) {
        // Written down the moment the chain took it, BEFORE waiting for a block. Between a send and the end of the
        // run sit a wait and another chain's worth of calls; a kill in there used to lose the hash for good, and the
        // next run would then send a second transaction for a day that already had one, the first unfindable.
        byChain.set(chain, { ...r, ...(MIRRORS[chain].explorer ? { explorer: MIRRORS[chain].explorer + r.tx } : {}) })
        writeMirror(outDir, day, record())
        Object.assign(r, await wait({ chain, tx: r.tx, fetchImpl, env }))
        if (r.status === 'in-block-unwitnessed') Object.assign(r, await witnessMirror({ chain, tx: r.tx, day, sha256, from: r.from, fetchImpl, env }))
      }
    } catch (e) {
      // The kept record is only evidence about THIS hash: a transaction sent for other bytes is not shown beside
      // these, it is a failure for this day. And a chain we do not know must not throw a second time in here.
      const prev = kept.get(chain)
      const usable = prev && prev.tx && prev.sha256 === sha256
      r = usable ? { ...prev } : { chain, chain_id: (MIRRORS[chain] || {}).chainId ?? null, sha256, status: 'failed' }
      r.error = String(e && e.message || e).slice(0, 160)
    }
    if (MIRRORS[chain] && MIRRORS[chain].explorer && r.tx) r.explorer = MIRRORS[chain].explorer + r.tx
    byChain.set(chain, r)
  }
  const out = record()
  if (!dryRun) writeMirror(outDir, day, out)
  log('[anchor-mirror] ' + JSON.stringify({ day, mirrors: out.mirrors.map((m) => ({ chain: m.chain, status: m.status, tx: m.tx || null, days_left: m.days_left, error: m.error || undefined })) }))
  return out
}

export const CATCH_UP_DAYS = 3
// A transaction submitted and still without a block after this long is not "pending", it is lost: either it was
// dropped or we are being told nothing. Either way the day needs another write, and somebody needs to know.
export const STALE_PENDING_MS = 24 * 3600e3

/** Whether a day still has work: a chain missing, refused, reverted, or submitted over a day ago with no block. */
export function needsWork (record, chains = Object.keys(MIRRORS), at = Date.now()) {
  if (!record || !Array.isArray(record.mirrors)) return true
  for (const chain of chains) {
    const m = record.mirrors.find((x) => x.chain === chain)
    if (!m) return true
    if (m.status === 'confirmed' && (m.witnessed_by || []).length) continue
    if (m.status === 'confirmed') return true // the word without a witness behind it: ask again
    // In a block but nobody independent has said so yet: nothing to send, but something to ask again tomorrow.
    if (m.status === 'in-block-unwitnessed') return true
    if (m.status !== 'pending') return true
    const t = Date.parse(m.sent_at || '')
    if (!Number.isFinite(t) || at - t > STALE_PENDING_MS) return true
  }
  return false
}

/** What a run should say and whether it should fail: per day, the chains that have no good write and the thin keys. */
export function runVerdict (records, at = Date.now()) {
  const bad = [], low = []
  for (const r of records) {
    for (const m of r.mirrors || []) {
      // NaN beats every comparison, so a corrupted time must be read as unknown, never as fresh: `at - NaN > x` is
      // false, which would have left such a day pending forever with nothing said.
      const since = Date.parse(m.first_sent_at || m.sent_at || '')
      const stalePending = m.status === 'pending' && (!Number.isFinite(since) || at - since > STALE_PENDING_MS)
      // An error attached to a kept record used to raise nothing at all: the status stayed `pending` and recent, so a
      // run that hit, say, an rpc answering for the wrong chain exited 0 and told nobody.
      // A mirror in a block that no independent source will confirm after a day is its own kind of gap: either the
      // witnesses are all unreachable or the transaction is not what our endpoint says it is.
      const unwitnessedTooLong = m.status === 'in-block-unwitnessed' && (!Number.isFinite(since) || at - since > STALE_PENDING_MS)
      // A record that says confirmed with nobody named behind it is the same gap as an unwitnessed one, and it does
      // not heal by itself once the day falls out of the catch-up window (review, 14.11).
      const confirmedByNobody = m.status === 'confirmed' && !(m.witnessed_by || []).length
      if (['failed', 'reverted', 'skipped', 'contradicted'].includes(m.status) || stalePending || unwitnessedTooLong || confirmedByNobody || (m.error && m.status !== 'confirmed')) {
        const what = confirmedByNobody ? 'called confirmed with no independent source named'
          : stalePending ? 'submitted over a day ago and still not in a block'
          : unwitnessedTooLong ? `in a block for over a day with no independent source confirming it (${(m.unwitnessed || []).join('; ').slice(0, 120)})`
            : m.status === 'contradicted' ? `CONTRADICTED by an independent source (${(m.contradicted || []).join('; ').slice(0, 160)})`
              : m.status
        bad.push(`${r.day} ${m.chain}: ${what}${m.reason ? ' (' + m.reason + ')' : ''}${m.error ? ' (' + m.error + ')' : ''}`)
      }
      if (m.low_balance || (typeof m.days_left === 'number' && m.days_left < LOW_BALANCE_DAYS)) low.push(`${m.chain} has about ${m.days_left} days of writes left`)
    }
  }
  return { bad, low, ok: !bad.length && !low.length }
}

/**
 * The days before `day` that still have work, written again. The same catching up the Bitcoin proofs do: without it a
 * single dropped transaction would leave a hole in the record that nothing ever filled. It does not wait for a block,
 * because the unit has a time limit and four days each waiting out a receipt is what a congested chain would do to
 * it; tomorrow's run reads the receipt.
 */
export async function catchUp ({ outDir, day, days = CATCH_UP_DAYS, chains, key, fetchImpl, env, now = () => Date.now(), run = mirrorDay, log, nonces = null }) {
  const out = []
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.parse(day) - i * 864e5).toISOString().slice(0, 10)
    if (!fs.existsSync(path.join(outDir, `manifest-${d}.json`))) continue
    if (!needsWork(readMirror(outDir, d), chains, now())) continue
    out.push(await run({ outDir, day: d, key, fetchImpl, env, nonces, wait: async () => ({}), ...(chains ? { chains } : {}), ...(log ? { log } : {}) }))
  }
  return out
}

if (isEntryPoint(import.meta.url)) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
  const has = (k) => process.argv.includes(`--${k}`)
  const day = arg('day') || new Date(Date.now() - 864e5).toISOString().slice(0, 10)
  if (!DAY_RE.test(day)) { console.error('--day must be YYYY-MM-DD'); process.exit(2) }
  const outDir = arg('out') || process.env.STP_ANCHOR_DIR || '/var/lib/stp-anchors'
  const chains = (arg('chain') || '').split(',').filter(Boolean)
  const only = chains.length ? { chains } : {}
  const key = loadKey()
  // One nonce counter for the whole run, shared by every day it writes on a chain.
  const nonces = new Map()
  const records = [await mirrorDay({ outDir, day, key, dryRun: has('dry-run'), nonces, ...only })]
  if (!has('dry-run') && !arg('day')) records.push(...await catchUp({ outDir, day, key, nonces, ...(chains.length ? { chains } : {}) }))
  // A chain that did not take the write is a failure of the unit, and so is a balance with under a month of days in
  // it: both are alerts, because a mirror nobody notices has stopped is a mirror that quietly stops.
  const { bad, low } = runVerdict(records)
  // Through JSON.stringify, like the line above: `bad` carries text from the node, and a newline in it would print a
  // line of its own in the journal, shaped like one of ours (audit, 14.11). Same rule as a stranger's token name.
  if (bad.length) console.log('[anchor-mirror] not written: ' + JSON.stringify(bad))
  if (low.length) console.log('[anchor-mirror] low balance: ' + JSON.stringify([...new Set(low)]))
  if (bad.length || low.length) process.exitCode = 1
}
