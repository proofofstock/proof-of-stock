// evm/core/stocks/evm-tx.mjs: everything needed to sign ONE kind of transaction, by hand.
//
// The anchor mirrors (spec H4) write the day's root hash to Base and to Robinhood Chain. That is the only transaction
// this project will ever send: no transfer, no approval, no contract call that moves anyone's token. A library that
// can do all of those would be a much larger thing to trust and to keep updated, so the transaction is built here,
// from two audited primitives and about a hundred lines: @noble/hashes for keccak-256 and @noble/curves for the
// signature. Both are pinned to an exact version (the owner's decision, 13.11).
//
// Everything in this file is pure: bytes in, bytes out, no clock, no network, no file. The key arrives as 32 bytes
// from the caller, is used, and is never written anywhere by this module.
//
// What is implemented: RLP, and the typed transaction of EIP-1559 (type 0x02), which both chains accept. Legacy and
// the other typed transactions are not implemented, because we do not send them.
import { keccak_256 } from '@noble/hashes/sha3.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'

export const keccak256 = (bytes) => Buffer.from(keccak_256(Uint8Array.from(bytes)))

const hexToBytes = (h) => {
  const s = String(h == null ? '' : h).replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new Error('not a hex string of whole bytes')
  return Buffer.from(s, 'hex')
}

/** A quantity as RLP wants it: big-endian, no leading zero, and zero itself as no bytes at all. */
export function quantity (v) {
  let n
  if (typeof v === 'bigint') n = v
  else if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error('number is not a safe integer'); n = BigInt(v) }
  else if (typeof v === 'string') n = BigInt(v.startsWith('0x') || v.startsWith('0X') ? v : v === '' ? '0' : v)
  else if (v == null) n = 0n
  else throw new Error('not a quantity')
  if (n < 0n) throw new Error('a quantity is never negative')
  if (n === 0n) return Buffer.alloc(0)
  const h = n.toString(16)
  return Buffer.from(h.length % 2 ? '0' + h : h, 'hex')
}

const lengthPrefix = (len, offset) => {
  if (len < 56) return Buffer.from([offset + len])
  const h = len.toString(16)
  const l = Buffer.from(h.length % 2 ? '0' + h : h, 'hex')
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l])
}

/**
 * RLP (Ethereum's one encoding). A Buffer or Uint8Array is a byte string; an array is a list, encoded recursively.
 * Numbers are not accepted on purpose: pass them through quantity() first, so that "zero" cannot mean two things.
 */
export function rlp (value) {
  if (Array.isArray(value)) {
    const body = Buffer.concat(value.map(rlp))
    return Buffer.concat([lengthPrefix(body.length, 0xc0), body])
  }
  if (!(value instanceof Uint8Array)) throw new Error('rlp takes bytes or a list of them')
  const b = Buffer.from(value)
  if (b.length === 1 && b[0] < 0x80) return b
  return Buffer.concat([lengthPrefix(b.length, 0x80), b])
}

/** The 20-byte address of an uncompressed (65 byte) public key, lower case with 0x. */
export function addressOf (publicKey) {
  const pub = Buffer.from(publicKey)
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('an uncompressed public key is 65 bytes starting 0x04')
  return '0x' + keccak256(pub.subarray(1)).subarray(12).toString('hex')
}

/** The same address with EIP-55 capitals, which is the form a human should ever see or paste. */
export function checksumAddress (address) {
  const a = String(address).replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error('not an address')
  const h = keccak256(Buffer.from(a, 'utf8')).toString('hex')
  let out = '0x'
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i]
  return out
}

/** The address of a 32-byte private key. The key is read, never kept. */
export function addressOfKey (privateKey) {
  const sk = Buffer.from(privateKey)
  if (sk.length !== 32) throw new Error('a private key is 32 bytes')
  return addressOf(secp256k1.getPublicKey(sk, false))
}

const txFields = (tx) => [
  quantity(tx.chainId), quantity(tx.nonce), quantity(tx.maxPriorityFeePerGas), quantity(tx.maxFeePerGas), quantity(tx.gasLimit),
  tx.to == null || tx.to === '' ? Buffer.alloc(0) : hexToBytes(tx.to),
  quantity(tx.value), hexToBytes(tx.data || '0x'),
  [], // no access list: this transaction touches one account, its own
]

/** The bytes that get hashed and signed for an EIP-1559 transaction: 0x02 || rlp(fields). */
export function signingPayload (tx) {
  const to = tx.to == null || tx.to === '' ? Buffer.alloc(0) : hexToBytes(tx.to)
  if (to.length && to.length !== 20) throw new Error('to is an address or nothing')
  return Buffer.concat([Buffer.from([0x02]), rlp(txFields(tx))])
}

/**
 * Sign an EIP-1559 transaction. Returns the raw bytes to send (`raw`), the hash it will have on chain (`hash`) and
 * the sender, so a caller can check it is signing as the account it meant to.
 */
export function signTransaction (tx, privateKey) {
  const sk = Buffer.from(privateKey)
  if (sk.length !== 32) throw new Error('a private key is 32 bytes')
  const payload = signingPayload(tx)
  // lowS is noble's default and is what EVM chains accept; prehash is off because we hash with keccak, not sha256.
  const sig = Buffer.from(secp256k1.sign(keccak256(payload), sk, { format: 'recovered', prehash: false }))
  const recovery = sig[0]
  const r = trimLeadingZeros(sig.subarray(1, 33))
  const s = trimLeadingZeros(sig.subarray(33, 65))
  const raw = Buffer.concat([Buffer.from([0x02]), rlp([...txFields(tx), quantity(recovery), r, s])])
  return { raw: '0x' + raw.toString('hex'), hash: '0x' + keccak256(raw).toString('hex'), from: addressOfKey(sk) }
}

const trimLeadingZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return Buffer.from(b.subarray(i)) }

/**
 * Who signed a transaction, from its unsigned payload and its signature. Nothing in the writer needs this; it is what
 * lets a test take a real transaction from a public chain and prove this file rebuilds it byte for byte.
 */
export function recoverSender ({ payload, r, s, yParity }) {
  const sig = Buffer.concat([Buffer.from([Number(yParity)]), pad32(hexToBytes(r)), pad32(hexToBytes(s))])
  // noble hands back the compressed point; an address is keccak of the uncompressed one.
  const pub = secp256k1.recoverPublicKey(sig, keccak256(payload), { prehash: false, format: 'recovered' })
  return addressOf(secp256k1.Point.fromBytes(pub).toBytes(false))
}

const pad32 = (b) => Buffer.concat([Buffer.alloc(Math.max(0, 32 - b.length)), b])
