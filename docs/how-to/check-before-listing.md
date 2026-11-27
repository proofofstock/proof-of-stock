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
   - `503`: **no answer.** Do not treat it as "not listed". Retry after the `Retry-After` delay. It comes in three
     kinds:
     - the registry has not been read in the last 15 minutes;
     - the issuer's list names the address, but the chain does not back it yet or contradicts it. The body carries a
       `reason`: `issuer_prefix_mismatch`, `factory_check_unavailable`, `factory_conflict` or
       `awaiting_factory_confirmation`. A genuine new listing answers `awaiting_factory_confirmation` for some minutes
       after its creation; `factory_conflict` and `issuer_prefix_mismatch` mean the chain contradicts the list;
     - the [kill switch](../reference/http-api.md#kill-switch) is tripped.
   - `429`: over the rate limit. Wait a minute.
2. **`listed`.** `true` only when the exact address is in the registry and the chain backs it: the issuer's factory
   created it, read from finalized blocks; on Base a second RPC confirms it and the address carries Coinbase's pinned
   prefix `0xb200000000000000000000`. Then `symbol`, `name` and `isin` are the issuer's.
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
- If the registry is unavailable, or one address is held because the chain does not back it, the whole call fails with
  `isError: true`, naming the held address and its reason. No partial answer is given.
- A batch of n addresses costs ⌈n/10⌉ units of the 60-per-minute limit.

## Guard a trading agent with `@proofofstock/guard`

Install it with `npm install @proofofstock/guard` (its source is in this repository at `packages/proofofstock-guard/`).
It has no dependencies and needs Node 20.19 or newer.

```js
import { createGuard } from '@proofofstock/guard'

const guard = createGuard()   // { endpoint, fetchImpl, timeoutMs: 8000, failOpen: false, crossCheck: true outside a browser }

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

`beforeBuy` calls `GET /verify` once and returns `{ allow, decision, reason, use_instead, verify }`.

**It does not take our word for "listed"** (from 0.3.0). A listed answer is believed only if:

- on Base, the address has the form every Coinbase stock token has, `0xb2` and twenty zero hex digits, pinned in the
  package;
- with `crossCheck` (on by default outside a browser), the issuer's own list, read by the guard itself and kept for a
  minute, has the address. In a browser the issuers' APIs cannot be read (they send no CORS headers), so there
  `crossCheck` is off and the prefix check stands alone.

So a proofofstock.xyz that was broken into can still refuse a buy, but cannot make one.

| `decision` | `allow` | When |
|---|---|---|
| `listed` | `true` | the address is issuer-listed, matches `claimedSymbol` if you gave one, and passes the checks above |
| `wrong_stock` | `false` | the address is issuer-listed, but as a different stock from `claimedSymbol` |
| `impostor` | `false` | not listed, and copies a listed symbol or the issuer's naming |
| `not_listed` | `false` | not listed, no mimicry seen |
| `unknown` | `failOpen`, with exceptions below | the check could not be made: a 503, a 429, a timeout or a network error, a listed answer without its issuer-list proof, or an issuer list the guard could not read |
| `unknown` | `false` | a listed answer that fails the Base prefix, or that names another issuer's list |
| `invalid_input` | `false` | the chain or the address is not one the guard can check |

Two `unknown` answers are refused whatever `failOpen` says, because they are answers, not outages:

- a listed answer for an address that the issuer's own list, read just now, does not have (from 0.3.0);
- from 0.3.1 (in this repository), a `503` whose `reason` is `factory_conflict` or `issuer_prefix_mismatch`: the chain
  contradicts the issuer's list.

Any other `503`, an outage or a listing only `awaiting_factory_confirmation`, is still decided by `failOpen`, and the
`reason` is named in the decision.

`claimedSymbol` accepts either issuer's form: `NVDA` and `NVDAc` name the same stock. Only a Coinbase-style symbol
(upper-case letters, digits or dots, then a lower-case `c`) loses its trailing `c`; `sndkc` stays `SNDKC`.

**`failOpen`.** By default the guard fails closed: if it cannot check, it does not allow the buy. Set
`createGuard({ failOpen: true })` only if a missed check is acceptable to you. The `reason` then says the buy was
allowed because `failOpen` is set. It never lets through the contradicted answers listed above.

**Bad input is a refusal, not a throw.** A chain other than `base` or `robinhood`, or a malformed address, gives the
decision `invalid_input`; `beforeBuy` never rejects on it.

For Coinbase AgentKit, `packages/proofofstock-guard/agentkit.mjs` exports the same check as an action named
`check_stock_token_before_buy`. Its answer starts with `ALLOW` or `REFUSE`. The package README shows how to register
it with `customActionProvider`.

## What this check does not tell you

- Whether the price is fair. For that, read the passport: [tutorial](../tutorials/connect-an-agent.md).
- What a holder is entitled to. That is set by the issuer's prospectus.
- Anything about issuers other than Coinbase on Base and Robinhood on Robinhood Chain.

Field details: [HTTP API reference](../reference/http-api.md), [tools reference](../reference/tools.md).

[Not investment advice](../legal.md)
