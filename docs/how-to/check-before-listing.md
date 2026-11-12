v0.5.0 · updated 2026-11-11

# Check a contract before listing or buying it

Use this when you are about to list a tokenized stock on a venue, show it in a wallet, or let an agent buy it, and you
need to know whether the exact contract is on the issuer's own registry.

Four ways, from one address by hand to a check inside your code:

| You have | Use |
|---|---|
| one address, a terminal | `GET /verify` |
| a page that shows a token | the badge, `GET /badge.svg` |
| an agent, up to 50 addresses | the MCP tool `verify_stock_tokens` |
| a trading agent in Node | the `@proofofstock/guard` package, `beforeBuy()` |

All four ask the same question and get the same answer. Base is checked against Coinbase's registry, Robinhood Chain
against Robinhood's.

## Check one address with `/verify`

```bash
curl -s 'https://proofofstock.xyz/verify?chain=base&address=0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703' | jq '{listed, impostor, listed_on_other_chain, registry_age_s}'
```

```json
{
  "listed": false,
  "impostor": { "kinds": ["registry_symbol"], "imitates_symbol": "SNDKc", "listed_address": "0xb200000000000000000000397293cb8cda9a10c5" },
  "listed_on_other_chain": null,
  "registry_age_s": 112
}
```

Read it in this order:

1. **The HTTP status.**
   - `200`: an answer.
   - `400`: the chain is not `base` or `robinhood`, or the address is not `0x` and 40 hex characters.
   - `503`: the registry has not been read in the last 15 minutes. **This is no answer.** Do not treat it as "not
     listed". Retry after the `Retry-After` delay.
   - `429`: over the rate limit. Wait a minute.
2. **`listed`.** `true` only when the exact address is in the registry. Then `symbol`, `name` and `isin` are the
   issuer's.
3. **`impostor`.** Set only when the token is not listed **and** copies a listed symbol (`registry_symbol`), the
   issuer's naming (`issuer_name_suffix`) or a listed company's whole name (`registry_name`). `listed_address` is the issuer-listed contract, when there is one.
4. **`listed_on_other_chain`.** The address is listed, but on the other chain. Check that you asked about the right
   chain.
5. **`delisted_at`.** The address was listed and has left the registry since the site last restarted.

`listed: false` with no `impostor` means "not in this registry". It does not mean fake: a genuine token of another
issuer would answer the same. Decide what your venue does with such tokens; this check cannot vouch for them.

Two more fields worth knowing:

- `minted` is `false` for a Coinbase token that is listed but not yet minted on Base. Robinhood's API reports no
  supply, so on Robinhood Chain `minted` is `null`.
- `impostor_list_truncated: true` means the impostor list hit its size cap, so a missing `impostor` is less certain.

## Show the answer on a page with the badge

```html
<a href="https://proofofstock.xyz/?chain=base&address=0xb200000000000000000000397293cb8cda9a10c5">
  <img src="https://proofofstock.xyz/badge.svg?chain=base&address=0xb200000000000000000000397293cb8cda9a10c5" alt="Proof of Stock">
</a>
```

The badge has four states:

| State | Text |
|---|---|
| listed | `✓ Issuer-listed · SNDKc · Coinbase` |
| impostor | `✗ Imitates SNDKc`, or `✗ Copies the issuer's naming` |
| not listed | `• Not in the Coinbase registry` |
| unavailable | `? Registry unavailable` |

The second line prints the shortened address and the time of the check, so the badge cannot be moved onto a page
about another token. It never shows a price. It always answers 200, so a stale registry shows `?` rather than a broken
image. It is cached for 5 minutes when listed, 1 minute otherwise, and not at all when unavailable.

## Check a batch from an agent with `verify_stock_tokens`

Connect the agent first ([tutorial](../tutorials/connect-an-agent.md)). Then call the tool with up to 50 addresses:

```bash
curl -s https://proofofstock.xyz/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"verify_stock_tokens","arguments":{"chain":"base","addresses":["0xb200000000000000000000397293cb8cda9a10c5","0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703"]}}}' \
  | jq -r '.result.content[0].text'
```

```
1 of 2 addresses is issuer-listed on Base (SNDKc). 1 imitates a listed token: 0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703 imitates SNDKc, listed 0xb200000000000000000000397293cb8cda9a10c5.
```

- `structuredContent.results` holds one `/verify` answer per address, in the order you sent them.
- If the registry is unavailable, the whole call fails with `isError: true`. No partial answer is given.
- A batch of n addresses costs ⌈n/10⌉ units of the 60-per-minute limit.

## Guard a trading agent with `@proofofstock/guard`

The package is in this repository at `packages/proofofstock-guard/`. It is ready to publish to npm but not published
yet, so import it from the repository for now. It has no dependencies and needs Node 18 or later.

```js
import { createGuard } from './packages/proofofstock-guard/index.mjs'

const guard = createGuard()   // { endpoint, fetchImpl, timeoutMs: 8000, failOpen: false }

const d = await guard.beforeBuy({
  chain: 'base',
  tokenAddress: '0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703',
  claimedSymbol: 'SNDKc',
})

if (!d.allow) {
  console.log(d.decision, d.reason)
  // d.use_instead is the issuer-listed contract, when the token imitates one.
  // Run beforeBuy on it before you use it.
}
```

`beforeBuy` calls `GET /verify` once and returns `{ allow, decision, reason, use_instead, verify }`:

| `decision` | `allow` | When |
|---|---|---|
| `listed` | `true` | the address is issuer-listed, and matches `claimedSymbol` if you gave one |
| `wrong_stock` | `false` | the address is issuer-listed, but as a different stock from `claimedSymbol` |
| `impostor` | `false` | not listed, and copies a listed symbol or the issuer's naming |
| `not_listed` | `false` | not listed, no mimicry seen |
| `unknown` | `failOpen` | the check could not be made: a 503, a 429, a timeout or a network error |

`claimedSymbol` accepts either issuer's form: `NVDA` and `NVDAc` name the same stock. Only a Coinbase-style symbol
(upper-case letters, digits or dots, then a lower-case `c`) loses its trailing `c`; `sndkc` stays `SNDKC`.

**`failOpen`.** By default the guard fails closed: if it cannot check, it does not allow the buy. Set
`createGuard({ failOpen: true })` only if a missed check is acceptable to you. The `reason` then says the buy was
allowed because `failOpen` is set.

**Bad input throws.** A chain other than `base` or `robinhood`, or a malformed address, rejects the promise instead of
returning a decision. Validate input first, or catch the error and treat it as a refusal.

For Coinbase AgentKit, `packages/proofofstock-guard/agentkit.mjs` exports the same check as an action named
`check_stock_token_before_buy`. Its answer starts with `ALLOW` or `REFUSE`. The package README shows how to register
it with `customActionProvider`.

## What this check does not tell you

- Whether the price is fair. For that, read the passport: [tutorial](../tutorials/connect-an-agent.md).
- What a holder is entitled to. That is set by the issuer's prospectus.
- Anything about issuers other than Coinbase on Base and Robinhood on Robinhood Chain.

Field details: [HTTP API reference](../reference/http-api.md), [tools reference](../reference/tools.md).

[Not investment advice](../legal.md)
