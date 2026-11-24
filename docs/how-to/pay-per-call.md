# Pay per call: a pass over the free minute

Use this when your agent or service needs more than the free minute of proofofstock.xyz (60 units in any 60 seconds)
and you would rather pay a small amount than wait. A pass is **0.01 USDC on Base for 10 minutes at 600 units a
minute**, ten times the free rate, bound to your client on the server. Nothing else changes: the same routes, the same
answers, no account and no key. A sporadic reader never pays anything, and never sees a price.

The payment is [x402](https://www.x402.org) over HTTP, version 1 or 2. A request the limiter refuses answers **402**
with the offer; your client retries the same request with the payment; the server verifies it, settles it on chain,
serves that request, and keeps measuring your client against 600 units a minute until the pass ends. No further
payment is asked while the pass is live.

| | x402 v1 | x402 v2 |
|---|---|---|
| the offer | the 402 body: `{ x402Version: 1, accepts: [{ network: "base", maxAmountRequired, ... }] }` | the `PAYMENT-REQUIRED` header: base64 JSON `{ x402Version: 2, resource, accepts: [{ network: "eip155:8453", amount, ... }] }` |
| the payment | `X-PAYMENT` | `PAYMENT-SIGNATURE`, with the offer echoed as `accepted` |
| the receipt | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |

Every 402 carries both: the v1 body and the v2 header. It is one offer in two wrappers: the same price, payee, asset
and EIP-3009 authorization for USDC on Base. Pay in either; the receipt comes back in the version you paid in.

A v2 payment is settled by Coinbase's x402 facilitator; a v1 payment by our own settlement wallet. Either way we
check the payment ourselves first, and the USDC goes to the same payee named in the 402.

## Buying a pass up front: `GET /api/pass`

To buy before you need it, ask `https://proofofstock.xyz/api/pass`. Without a live pass it always answers the 402,
whatever is left of your free minute, with the v2 offer in the body as well as the header and an x402 Bazaar
description of the route. Paid, it answers what the pass is:

```json
{ "pass": { "active": true, "until": "2026-11-22T12:10:00.000Z", "minutes": 10, "units_per_minute": 600 } }
```

With a live pass it answers the same without asking for anything. The route is listed for x402 catalogues at
`https://proofofstock.xyz/openapi.json`. It costs no unit of the free minute.

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
# 1. ask, and be told the price (once the free minute is used up; or ask /api/pass, which always names it)
URL='https://proofofstock.xyz/api/passport?chain=base&address=<token address>'
curl -s -D - -o /dev/null "$URL" | head -1            # HTTP/1.1 402
curl -s "$URL" | jq '.accepts[0] | {maxAmountRequired, payTo, asset}'

# 2. pay: sign transferWithAuthorization for that exact amount to that exact payTo, then
#    send the same request again with X-PAYMENT: base64(JSON) of
#    { x402Version: 1, scheme: "exact", network: "base",
#      payload: { signature: "0x...", authorization: { from, to, value, validAfter, validBefore, nonce } } }
curl -s -D - -o /dev/null -H "X-PAYMENT: <base64 payment>" "$URL" | grep -i x-payment-response
```

The answer carries `X-PAYMENT-RESPONSE`: base64 JSON `{ success, transaction, network, payer }`. The `transaction`
hash is on BaseScan, and anyone can check the payment there.

## What a pass does and does not

| | |
|---|---|
| It does | measure your client against 600 units a minute for 10 minutes, on every route, `/mcp` included |
| It does | open the big batch: `/verify?addresses=` with 51 to 150 addresses (free up to 50) |
| It does not | raise the proxy's own 10 requests per second per IP (burst 40), or the 7-day window of the case list |
| It does not | change any answer: a paid route returns exactly what the free route returns |
| Refusals still cost nothing | a request the limiter refuses is never paid; only a settled purchase moves money |

## When things refuse

| Answer | Meaning |
|---|---|
| 402, `the free minute is used up` | the normal offer; pay it or wait `Retry-After` |
| 402, `it has not been taken` | checked against the chain before anything was sent, and refused: the window too short, no USDC, a contract wallet, the node down; nothing moved, the authorization is still yours |
| 402, `pending: true`, `the payment was broadcast and is not confirmed yet (tx 0x…)` | the transaction is on its way; `X-PAYMENT-RESPONSE` carries `settlement_pending` and the hash. Send the same request with the **same** `X-PAYMENT` again every 10 to 15 seconds: once it lands you get the pass, and you are never charged twice. The pass is granted when it lands even if you never ask again |
| 402, `if your USDC moved, it is on the record and will be refunded` | sent, but it did not settle as our payment; every settlement is logged with its transaction, write to hello@proofofstock.xyz with the hash |
| 402, `this payment has already been used` | a replay, or another client presenting your authorization; sign a payment with a fresh nonce |
| 429, `this payment is being settled` | the same authorization is in flight already; send it again in a few seconds |
| 429, `a pass was bought here recently` | purchase pacing: one broadcast purchase per client and per payer every 5 minutes |
| 429, `paid passes are paused` | several settlements in a row failed on chain; selling stops for a while |
| 429, `a purchase from here is being settled` | another payment from the same client or the same payer is in flight; wait for its answer instead of signing a second one |
| 429, `too many failed payments from this client; try again in N minutes` | five refused payments within 10 minutes, on any route that takes a payment; a payment that is only pending does not count. The body's `retry_after_s` and `Retry-After` give the same wait in seconds |
| 429, `your pass is active` | you are over even 600 units a minute; slow down, `Retry-After: 5` |

Prices and pass shape are decided by the server code, not by the client: the only amount accepted is the one the 402
itself named.

## What the payment must look like

- **A plain wallet.** A contract wallet or an EIP-7702 delegated account is refused: the token checks those through
  ERC-1271, which can approve a simulation and reject the real transaction, at our expense.
- **A window of at least 60 seconds.** `validBefore` must leave at least 45 seconds when the request arrives and 30
  when we broadcast; the 402 names `maxTimeoutSeconds: 120`, and an x402 client that signs for that is fine. At most
  300 seconds. Sign for the full 120: a shorter window leaves less room for a network hiccup before we broadcast.
- **USDC in the wallet** at the moment of settlement.
- **Numbers as strings.** In the authorization, `value`, `validAfter` and `validBefore` are decimal strings
  (`"10000"`), as the x402 `exact` scheme has them; JSON numbers are refused as the wrong form.
- **v of 27 or 28, or 0 or 1.** Either is accepted; we send the token 27 or 28, which is all USDC takes.

Once a payment has been broadcast, its window no longer matters: the same `X-PAYMENT` sent again is answered from our
record of that transaction (pending, then the pass), however late it arrives, for as long as its pass lasts.

## Before your agent pays any 402 (ours included)

The 402 body is not signed; anything between the agent and the server can change it. **Set a hard ceiling in the
client, not in the prompt: never sign more than 0.01 USDC (`10000` atomic units) for one of our passes without a
person confirming it.** That is our only price, and a 402 that asks for more is not ours, or not the service this page
describes. A client that takes its price from the 402 alone has no ceiling at all. Before signing:

- check `payTo`, `asset`, the network and the EIP-712 domain against values you got another way (for us: this page,
  and `payTo` is the same on every 402 we send);
- check the amount against the expected price of that resource, not only against a spending cap;
- keep `validBefore` short and the nonce fresh;
- use a client with spend controls, and a wallet that holds only what it may spend;
- keep the 402, the signed authorization and the `X-PAYMENT-RESPONSE` transaction hash, so a payment can be traced.

The protocol has no refunds and no disputes. Ours are by hand, from the settlement log; the payer's address and the
transaction are public on chain, like any transfer.
