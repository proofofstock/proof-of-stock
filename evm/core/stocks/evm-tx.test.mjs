// evm/core/stocks/evm-tx.test.mjs: the transaction builder is checked against things we did not write.
//
// The strongest check here is the last one: a real transaction taken from Base mainnet, with its fields, its
// signature and the sender the node reports. We rebuild its bytes from the fields alone; if our RLP or our envelope
// were wrong by one byte, the hash would differ and the recovered sender would be somebody else. A wrong signer does
// not fail loudly on its own - it spends gas and writes nothing anyone can find - so it has to be proven here.
//
// Run: node evm/core/stocks/evm-tx.test.mjs
import { rlp, quantity, keccak256, addressOf, addressOfKey, checksumAddress, signingPayload, signTransaction, recoverSender } from './evm-tx.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const hex = (b) => Buffer.from(b).toString('hex')
const str = (s) => Buffer.from(s, 'utf8')

console.log('rlp, against the vectors in the yellow paper and the wiki')
check('a short string carries its length', hex(rlp(str('dog'))) === '83646f67')
check('a single low byte is itself', hex(rlp(str('\x0f'))) === '0f')
check('a single high byte gets a prefix', hex(rlp(Buffer.from([0x80]))) === '8180')
check('the empty string is 0x80', hex(rlp(Buffer.alloc(0))) === '80')
check('the empty list is 0xc0', hex(rlp([])) === 'c0')
check('a list of strings', hex(rlp([str('cat'), str('dog')])) === 'c88363617483646f67')
check('nested lists', hex(rlp([[], [[]], [[], [[]]]])) === 'c7c0c1c0c3c0c1c0')
check('55 bytes still uses the short form', hex(rlp(Buffer.alloc(55))).startsWith('b7'))
check('56 bytes switches to the long form', hex(rlp(Buffer.alloc(56))).startsWith('b838'))
check('a long string says how many bytes the length takes', hex(rlp(str('a'.repeat(1024)))).startsWith('b90400'))
check('rlp refuses a number, so that zero cannot mean two things', (() => { try { rlp(0); return false } catch (_) { return true } })())

console.log('quantities')
check('zero is no bytes at all, which rlp writes as 0x80', hex(quantity(0)) === '' && hex(rlp(quantity(0))) === '80')
check('a quantity has no leading zero', hex(quantity(1024)) === '0400' && hex(quantity('0x000400')) === '0400')
check('bigint, number and hex agree', hex(quantity(8453n)) === hex(quantity(8453)) && hex(quantity('0x2105')) === hex(quantity(8453)))
check('a negative quantity is refused', (() => { try { quantity(-1); return false } catch (_) { return true } })())
check('an unsafe integer is refused rather than rounded', (() => { try { quantity(2 ** 53); return false } catch (_) { return true } })())

console.log('addresses')
// EIP-55's own examples.
check('checksum capitals match EIP-55', checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed') === '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
check('...for a lower-heavy address too', checksumAddress('0xde709f2102306220921060314715629080e2fb77') === '0xde709f2102306220921060314715629080e2fb77')
check('...and it is only capitals, never different letters', checksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359').toLowerCase() === '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')
check('a public key must be the uncompressed 65 bytes', (() => { try { addressOf(Buffer.alloc(33)); return false } catch (_) { return true } })())
check('keccak-256 of nothing is the known empty hash', hex(keccak256(Buffer.alloc(0))) === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')

console.log('signing, and getting the same key back out')
const sk = Buffer.from('4646464646464646464646464646464646464646464646464646464646464646', 'hex')
const tx = { chainId: 8453, nonce: 7, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 2_000_000n, gasLimit: 30_000, to: '0x' + '11'.repeat(20), value: 0, data: '0x' + 'ab'.repeat(32) }
const signed = signTransaction(tx, sk)
check('the signed bytes are a type 2 transaction', signed.raw.startsWith('0x02'))
check('it says who signed it, so a caller can refuse a key it did not mean', signed.from === addressOfKey(sk))
check('the signature recovers the signer from the payload we hashed', recoverSender({ payload: signingPayload(tx), ...sigOf(signed.raw) }) === signed.from)
check('the hash is the hash of what is sent, not of what is signed', signed.hash === '0x' + hex(keccak256(Buffer.from(signed.raw.slice(2), 'hex'))))
// Twenty-one, not twenty: dropping the address takes the list under 56 bytes, so its own length prefix gets shorter too.
check('an empty to is one byte where an address is twenty-one', signingPayload({ ...tx, to: null }).length === signingPayload(tx).length - 21)
check('a key that is not 32 bytes is refused', (() => { try { signTransaction(tx, Buffer.alloc(31)); return false } catch (_) { return true } })())
check('signing twice gives the same bytes: nothing here depends on a clock', signTransaction(tx, sk).raw === signed.raw)

console.log('a real transaction from Base mainnet (block read 13.11.2026), rebuilt from its fields')
// Public chain data, copied from eth_getBlockByNumber: the fields, the signature, and the sender the node reports.
const real = {
  hash: '0x7878577661861b9cca56aa974e4608298ef63296bb4852c5fb73ee8c954a3177',
  from: '0x96dcdec755aa8bdbe22278e631879e3addc1a24c',
  chainId: '0x2105', nonce: '0x27235e', maxPriorityFeePerGas: '0x1312d02', maxFeePerGas: '0x1312d02', gasLimit: '0x186a0',
  to: '0x4fda06b1da35e8faedfe19f3f4cd3d780ad158ec', value: '0x0',
  data: '0x8d6cc56d00000000000000000000000074619f5300003691d6afc001000000006af77237',
  yParity: '0x1',
  r: '0x80cc2c9d06d5e162051b7ab7e3fda889888952dc2768884694bf3e33fad7abec',
  s: '0x3ad6f7be5a7527424ec142aa88c43612a630b8b9016d591deb20d200f6aba69a',
}
const rebuilt = Buffer.concat([
  Buffer.from([0x02]),
  rlp([quantity(real.chainId), quantity(real.nonce), quantity(real.maxPriorityFeePerGas), quantity(real.maxFeePerGas), quantity(real.gasLimit),
    Buffer.from(real.to.slice(2), 'hex'), quantity(real.value), Buffer.from(real.data.slice(2), 'hex'), [],
    quantity(real.yParity), quantity(real.r), quantity(real.s)]),
])
check('our encoding of its fields hashes to the hash it has on chain', '0x' + hex(keccak256(rebuilt)) === real.hash)
check('and our payload recovers the sender the node reports', recoverSender({ payload: signingPayload(real), r: real.r, s: real.s, yParity: real.yParity }) === real.from)

/** r, s and yParity read back out of a signed type 2 transaction, for the round trip above. */
function sigOf (raw) {
  const b = Buffer.from(raw.slice(4), 'hex') // past 0x02 and the list prefix is not needed: read from the end
  const L = b.length
  if (b[L - 33] !== 0xa0 || b[L - 66] !== 0xa0) throw new Error('r and s are not both 32 bytes in this signature')
  return { r: '0x' + hex(b.subarray(L - 65, L - 33)), s: '0x' + hex(b.subarray(L - 32)), yParity: b[L - 67] === 0x80 ? 0 : b[L - 67] }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
