// evm/core/stocks/list-proof.test.mjs: the stamp on an issuer list is the digest the reproduce command computes, and it
// moves only when the set of addresses moves.
//
// Run: node evm/core/stocks/list-proof.test.mjs
import crypto from 'node:crypto'
import { addressesSha256, recipeFor, stampList, listProof } from './list-proof.mjs'
import { canonicalRegistry, registryHash } from './history.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const a = (n) => '0x' + String(n).repeat(40).slice(0, 40)
const rec = (addr, extra = {}) => ({ address: addr, symbol: 'X', name: 'X', isin: null, multiplier: 1, multiplier_pending: null, supplied: true, paused: [], reference: { price_usd: 1 }, ...extra })

console.log('addresses_sha256')
{
  const list = [rec(a('b')), rec(a(1)), rec(a('a'))]
  // What `tr 'A-F' 'a-f' | LC_ALL=C sort | sha256sum` hashes: lowercase lines, bytewise order, each ending in a newline.
  const expected = crypto.createHash('sha256').update([a(1), a('a'), a('b')].map((x) => x + '\n').join('')).digest('hex')
  check('it is SHA-256 of the sorted addresses, one per line, as sha256sum prints it', addressesSha256(list) === expected)
  check('the order the issuer sends does not matter', addressesSha256([...list].reverse()) === expected)
  check('mixed-case addresses hash as lowercase, as tr does', addressesSha256([rec(a('B')), rec(a(1)), rec(a('a'))]) === expected)
  check('a price, a name or a status change does not move it (the set is the same)', addressesSha256(list.map((r) => ({ ...r, name: 'Y', reference: { price_usd: 2 }, paused: ['x'] }))) === expected)
  check('a token added or removed does', addressesSha256([...list, rec(a(2))]) !== expected && addressesSha256(list.slice(1)) !== expected)
  check('an empty list has the digest of nothing', addressesSha256([]) === crypto.createHash('sha256').update('').digest('hex'))
}

console.log('the recipe')
{
  const cb = recipeFor('coinbase', 8453, 338)
  check('Coinbase: one page of 500, every contract_address, then the shared tail', cb.source === 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500' && cb.reproduce === "curl -fsS 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500' | jq -r '.tokens[].contract_address' | tr -d '\\r' | tr 'A-F' 'a-f' | LC_ALL=C sort | sha256sum" && cb.reproduce_unavailable === null, cb.reproduce)
  check('...and no recipe once the list outgrows one page, rather than a wrong one, with the reason', recipeFor('coinbase', 8453, 500).reproduce === null && /next_page_token/.test(recipeFor('coinbase', 8453, 500).reproduce_unavailable))
  // Review of #60: the recipe reads one page, so it follows the pages the reader needed, not the record count.
  check('...and none when the reader needed two pages, even for under 500 records (a server capping pages lower)', recipeFor('coinbase', 8453, 338, 2).reproduce === null && recipeFor('coinbase', 8453, 338, 1).reproduce !== null)
  const paged = Object.defineProperty([{ address: a(1) }], 'pages', { value: 3, enumerable: false })
  check('...the stamp reads the pages the reader left on its list', stampList({ issuer: 'coinbase', chainId: 8453, records: paged }).reproduce === null)
  const rh = recipeFor('robinhood', 4663, 203)
  check('Robinhood: the first deployment on this chain of each asset, as the reader takes it', rh.source === 'https://api.robinhood.com/rhj/assets' && rh.reproduce.includes('first(.deployments[]? | select((.chainId|tostring) == "4663"))') && rh.reproduce.startsWith("curl -fsS ") && rh.reproduce.endsWith("| tr -d '\\r' | tr 'A-F' 'a-f' | LC_ALL=C sort | sha256sum"))
  check('an unknown issuer gets no recipe', recipeFor('other', 1, 1).reproduce === null && recipeFor('other', 1, 1).source === null)
}

console.log('the stamp and the proof')
{
  const list = [rec(a(1)), rec(a(2))]
  const s = stampList({ issuer: 'coinbase', chainId: 8453, records: list })
  check('the stamp counts the addresses and carries both digests', s.addresses === 2 && s.addresses_sha256 === addressesSha256(list) && s.registry_hash === registryHash(canonicalRegistry(list)))
  check('registry_hash is the archive\'s hash of the same list (/api/history/registry rows)', /^sha256:[0-9a-f]{64}$/.test(s.registry_hash))
  const p = listProof(s, { readAt: Date.parse('2026-11-12T10:00:00Z'), ledgerUrl: 'https://proofofstock.xyz/api/history/registry?chain=base' })
  check('the proof adds when the list was read and where the archive is', p.read_at === '2026-11-12T10:00:00.000Z' && p.ledger.endsWith('?chain=base') && p.stale === false && /reproduce/.test(p.note))
  check('a list kept after a failed read says so (stale)', listProof(s, { readAt: 1, ledgerUrl: 'x', stale: true }).stale === true)
  check('the note never claims the archive already holds this list (the recorder reads on its own clock)', !/matches the archive/.test(p.note) && /once the recorder has read it/.test(p.note))
  check('no stamp yet (no list read) is no proof, not an empty one', listProof(null, { readAt: 1, ledgerUrl: 'x' }) === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
