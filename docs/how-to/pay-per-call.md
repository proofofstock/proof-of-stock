# Pay per call: a pass over the free minute

Use this when your agent or service needs more than the free minute of proofofstock.xyz (60 units in any 60 seconds)
and you would rather pay a small amount than wait. A pass is **0.01 USDC on Base for 10 minutes at 600 units a
minute**, ten times the free rate, bound to your client on the server. Nothing else changes: the same routes, the same
answers, no account and no key. A sporadic reader never pays anything, and never sees a price.

The payment is [x402](https://www.x402.org) over HTTP. A request the limiter refuses answers **402** with the offer;
your client retries the same request with an `X-PAYMENT` header; the server verifies the payment, settles it on chain,
serves that request, and keeps measuring your client against 600 units a minute until the pass ends. No further
payment is asked while the pass is live.

## With an x402 client library

Any x402-capable HTTP wrapper settles the 402 by itself. With the `x402-fetch` wrapper and an EIP-3009 capable wallet
on Base:

```js
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { wrapFetchWithPayment } from 'x402-fetch'

const account = privateKeyToAccount(process.env.PAYER_KEY)
const wallet = createWalletClient({ account, chain: base, transport: http() })
const fetchWithPay = wrapFetchWithPayment(fetch, wallet)

const res = await fetchWithPay('https://proofofstock.xyz/verify?chain=base&address=0x35b7...f703')
// a request under the free rate is served as always; a refused one is paid and retried by the wrapper
console.log(res.status, await res.json())
```

The wrapper reads the 402's `accepts`, builds the payment, retries, and exposes the settlement receipt in the
`X-PAYMENT-RESPONSE` response header.

## By hand, in a terminal

Two calls. The first names the price; the second pays it. Building `X-PAYMENT` by hand means signing an EIP-3009
`transferWithAuthorization` for USDC on Base, with the domain the 402's `extra` names (`USD Coin`, version `2`), so in
practice this is a job for a script, not for a person:

```bash
# 1. ask, and be told the price
curl -s -D - -o /dev/null 'https://proofofstock.xyz/api/status' | head -1            # HTTP/1.1 402
curl -s 'https://proofofstock.xyz/api/status' | jq '.accepts[0] | {maxAmountRequired, payTo, asset}'

# 2. pay: sign transferWithAuthorization for that exact amount to that exact payTo, then
#    send the same request again with X-PAYMENT: base64(JSON) of
#    { x402Version: 1, scheme: "exact", network: "base",
#      payload: { signature: "0x...", authorization: { from, to, value, validAfter, validBefore, nonce } } }
curl -s -D - -o /dev/null -H "X-PAYMENT: <base64 payment>" 'https://proofofstock.xyz/api/status' | grep -i x-payment-response
```

The answer carries `X-PAYMENT-RESPONSE`: base64 JSON `{ success, transaction, network, payer }`. The `transaction`
hash is on BaseScan, and anyone can check the payment there.

## What a pass does and does not

| | |
|---|---|
| It does | measure your client against 600 units a minute for 10 minutes, on every route, `/mcp` included |
| It does not | raise the proxy's own 10 requests per second per IP (burst 40), the batch cap of 50 addresses, or the 7-day window of the case list |
| It does not | change any answer: a paid route returns exactly what the free route returns |
| Refusals still cost nothing | a request the limiter refuses is never paid; only a settled purchase moves money |

## When things refuse

| Answer | Meaning |
|---|---|
| 402, `the free minute is used up` | the normal offer; pay it or wait `Retry-After` |
| 402, `it has not been taken` | the payment verified but settlement failed (the node is down, the window closed); nothing moved on chain, sign a fresh payment later |
| 402, `this payment has already been used` | a replay; sign a payment with a fresh nonce |
| 429, `a pass was bought for this client recently` | purchase pacing: one settled purchase per client per 5 minutes |
| 429, `your pass is active` | you are over even 600 units a minute; slow down, `Retry-After: 5` |

Prices and pass shape are decided by the server code, not by the client: the only amount accepted is the one the 402
itself named.
