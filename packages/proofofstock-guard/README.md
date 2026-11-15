# @proofofstock/guard

A pre-trade check for agents that buy tokenized stocks on **Base** (Coinbase's tokens) and **Robinhood Chain**
(Robinhood's). Before a swap, the guard asks one question: is this exact contract on the issuer's own registry? The
answer comes from [proofofstock.xyz](https://proofofstock.xyz).

- **Never trades.** The guard reads one public endpoint and returns a decision.
- **Fails closed.** If the registry cannot be read, it does not allow the buy, unless you set `failOpen`.
- **No evidence, no buy.** A listed answer must carry the issuer list it was decided against (`list_proof`), not stale
  and read within `maxRegistryAgeS` (900 s). With `crossCheck: true` the guard also reads the issuer's own list and buys
  only if the address is on it.
- **Never throws on bad input.** `beforeBuy` answers `invalid_input` instead.
- **"Not listed" is not "fake".** A token outside these two registries may be another issuer's genuine token. The guard
  refuses it because it cannot vouch for it, and says so in those words.

## Use

```js
import { createGuard } from '@proofofstock/guard'

const guard = createGuard()
const d = await guard.beforeBuy({ chain: 'base', tokenAddress: '0x35b7…f703', claimedSymbol: 'SNDKc' })
if (!d.allow) {
  console.log(d.reason)              // "… is not on the issuer registry; it imitates the issuer-listed SNDKc. The issuer-listed contract is 0xb200…10c5."
  if (d.use_instead) { /* check and use d.use_instead */ }
}
```

`decision` is one of:

| `decision` | `allow` | Meaning |
|---|---|---|
| `listed` | true | on the issuer's registry |
| `impostor` | false | copies a listed symbol or the issuer's naming; `use_instead` is the listed contract when known |
| `not_listed` | false | not on the registry, and no mimicry seen |
| `wrong_stock` | false | issuer-listed, but a different stock from `claimedSymbol` |
| `unknown` | `failOpen` | could not check: the service is down, the answer is malformed, it carries no `list_proof`, the list is stale or too old, or `crossCheck` could not confirm it |
| `invalid_input` | false | the chain or the address is not one the guard can check |

## Install

Node 20.19 or newer (ESM; `require()` works too), no dependencies.

```sh
npm install @proofofstock/guard
```

```js
const { createGuard } = require('@proofofstock/guard') // CommonJS works as well
```

Types ship with the package (`index.d.ts`).

## Several tokens at once

```js
const ds = await guard.beforeBuyMany('base', [{ tokenAddress: '0x…', claimedSymbol: 'NVDA' }, { tokenAddress: '0x…' }])
// one decision per token, in order; asked 50 at a time (GET /verify?addresses=)
```

## Options

| Option | Default | |
|---|---|---|
| `endpoint` | `https://proofofstock.xyz` | |
| `timeoutMs` | `8000` | per request; a network error or a 503 is asked once more, a 429 never |
| `failOpen` | `false` | allow the buy when it cannot check |
| `maxRegistryAgeS` | `900` | a listed answer from a list read longer ago is `unknown` |
| `crossCheck` | `false` | also read the issuer's own list (doubles the latency, calls the issuer's API) |

## Verify it yourself

Every listed answer carries `list_proof`: the SHA-256 of the issuer list's addresses and a command that computes the
same digest from the issuer. The guard can run that check for you:

```js
import { checkListProof } from '@proofofstock/guard'
const c = await checkListProof(d.verify.list_proof, { address: tokenAddress })
// c.status: 'match' | 'list_changed' | 'issuer_unavailable' | 'no_recipe'; c.address_in_issuer_list: true | false | null
```

`match` means the issuer's list right now is the one the verdict used. `list_changed` means the issuer has changed it
since; `address_in_issuer_list` then says whether the address is still on it. See
[list_proof](https://proofofstock.xyz/docs/reference/passport.md#field-list_proof).

## AgentKit

```js
import { customActionProvider } from '@coinbase/agentkit'
import { z } from 'zod'
import { guardAction } from '@proofofstock/guard/agentkit'

const g = guardAction()
const stockGuard = customActionProvider({
  name: g.name, description: g.description,
  schema: z.object({ chain: z.enum(['base', 'robinhood']), tokenAddress: z.string(), claimedSymbol: z.string().optional() }),
  invoke: (_wallet, args) => g.invoke(args),
})
// add stockGuard to the agent's action providers; the description tells the model to call it before any stock buy
```

## MCP

The same checks are on the public MCP server at `https://proofofstock.xyz/mcp`. Its tools are `verify_stock_tokens`
(up to 50 addresses), `recent_impostors`, `stock_passport`, `find_stock_token`, `list_stock_tokens` and `compare_venues`.

## Demo

```bash
node examples/demo.mjs
```

An agent is handed an impostor of SNDKc. It refuses it, checks the issuer-listed contract, and would proceed. It is a
dry run: nothing is traded.

Facts with their time and source; not investment advice. No affiliation with Coinbase or Robinhood; their names and
tickers are their trademarks.
