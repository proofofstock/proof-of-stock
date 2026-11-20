// scripts/ops/anchor-keygen.mjs: make one of this project's two keys, on the host, and print only its address.
//
//   sudo node scripts/ops/anchor-keygen.mjs --file=/etc/pos/anchor.key      make it (refuses to overwrite)
//   sudo node scripts/ops/anchor-keygen.mjs --file=/etc/pos/anchor.key --address   print the address again
//   sudo node scripts/ops/anchor-keygen.mjs --file=/etc/pos/x402.key        the settlement key for paid passes
//
// The settlement key (deployment/PUBLISHING.md "Paid passes") is made the same way and is the same kind of thing: a
// file of 32 bytes of hex, root-only, holding only gas. What it signs is described there and in the threat model; the
// rest of this header is about the anchor key.
//
// The key signs one kind of transaction and nothing else: our daily anchor mirror, to its own address, value zero
// (scripts/stocks/anchor-mirror.mjs). It is made here, on the machine that will use it, by the owner. It is never
// shown, never pasted into a chat, never sent to a model and never written to git: the only thing that leaves this
// command is the address, which is public by nature and is what gets funded.
//
// There is no seed phrase and no derivation path on purpose. A phrase is for a wallet a human must be able to restore
// somewhere else; this key is worth nothing to restore. If it is ever lost or suspected, make a new one, fund it, and
// the mirrors continue from the next day: the Bitcoin root is untouched by any of it, and the old transactions stay
// where they are, signed by an address the record names.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { addressOfKey, checksumAddress } from '../../evm/core/stocks/evm-tx.mjs'

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null
const file = arg('file') || '/etc/pos/anchor.key'
const showOnly = process.argv.includes('--address')

if (showOnly) {
  const text = fs.readFileSync(file, 'utf8').trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{64}$/i.test(text)) { console.error('that file does not hold 32 bytes of hex'); process.exit(1) }
  console.log(checksumAddress(addressOfKey(Buffer.from(text, 'hex'))))
  process.exit(0)
}

if (fs.existsSync(file)) {
  console.error(`${file} already exists. Delete it yourself if you really mean to replace the key; this command will not.`)
  process.exit(1)
}

// crypto.randomBytes is the operating system's own generator. A key of all zeros or past the curve's order is not a
// key: the chance is far below anything that happens, and it is still checked, because the cost of checking is a line.
let key
for (;;) {
  key = crypto.randomBytes(32)
  const n = BigInt('0x' + key.toString('hex'))
  if (n > 0n && n < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) break
}
fs.writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
fs.chmodSync(file, 0o600)
const address = checksumAddress(addressOfKey(key))
key.fill(0)

console.log(`Key written to ${file} (0600). It is never printed, here or anywhere else.`)
console.log('')
console.log(`  address: ${address}`)
console.log('')
console.log('Send it a little native token on each chain you mirror to (Base, Robinhood Chain). A day of writing costs')
console.log('a fraction of a cent, so a dollar or two is years. The unit alerts when under a month is left.')
