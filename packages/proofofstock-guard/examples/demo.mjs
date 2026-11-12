// packages/proofofstock-guard/examples/demo.mjs: the contest demo, against the live endpoint.
//
// An agent is asked to buy SNDKc on Base and is handed an impostor's contract. The guard refuses it and names the
// issuer-listed contract; the agent checks that one and proceeds. Nothing is traded: the "swap" here only prints.
//
// Run (needs outbound HTTPS): node packages/proofofstock-guard/examples/demo.mjs

import { createGuard } from '../index.mjs'

const guard = createGuard()
const ask = { chain: 'base', claimedSymbol: 'SNDKc', tokenAddress: '0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703' }

console.log(`agent: the user wants ${ask.claimedSymbol} on ${ask.chain}; I was given ${ask.tokenAddress}`)
let d = await guard.beforeBuy(ask)
console.log(`guard: ${d.allow ? 'ALLOW' : 'REFUSE'} (${d.decision}) ${d.reason}`)
if (!d.allow && d.use_instead) {
  console.log(`agent: not buying ${ask.tokenAddress}; checking the issuer-listed contract instead`)
  d = await guard.beforeBuy({ ...ask, tokenAddress: d.use_instead })
  console.log(`guard: ${d.allow ? 'ALLOW' : 'REFUSE'} (${d.decision}) ${d.reason}`)
}
console.log(d.allow ? `agent: would swap into ${d.verify.address} (${d.verify.symbol}) now, dry run, nothing traded` : 'agent: no buy')
