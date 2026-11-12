// scripts/receipt-check.mjs: check a stored Proof of Stock receipt, now or months later.
//
//   node scripts/receipt-check.mjs receipt.json
//
// Get a receipt with: curl 'https://proofofstock.xyz/verify?chain=base&address=0x...&receipt=1' | jq .receipt
// It checks the receipt's own SHA-256, fetches the frozen issuer list it names, checks that list's SHA-256, and derives
// the verdict again from it. Exit 0 when every check passes, 1 when one fails. Node 20 or newer, no dependencies.
import fs from 'node:fs'
import { checkReceipt } from '../evm/core/stocks/receipt.mjs'
import { isEntryPoint } from './lib/invoked-directly.mjs'

if (isEntryPoint(import.meta.url)) {
  const file = process.argv[2]
  if (!file) { console.error('usage: node scripts/receipt-check.mjs receipt.json'); process.exit(2) }
  let r
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); if (r && r.receipt && !r.format) r = r.receipt } catch (e) { console.error('cannot read ' + file + ': ' + e.message); process.exit(2) }
  const res = await checkReceipt(r)
  for (const c of res.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.check}: ${c.detail}`)
  console.log(res.ok ? `\nThe receipt holds: ${r.address} on ${r.chain} was ${r.verdict} by the issuer list it names (${r.issued_at}).` : '\nThe receipt does not hold.')
  process.exitCode = res.ok ? 0 : 1
}
