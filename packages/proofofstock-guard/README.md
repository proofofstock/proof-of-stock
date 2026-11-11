# @proofofstock/guard

A pre-trade check for agents that buy tokenized stocks on **Base** (Coinbase's tokens) and **Robinhood Chain**
(Robinhood's). Before a swap, the guard asks one question: is this exact contract on the issuer's own registry? The
answer comes from [proofofstock.xyz](https://proofofstock.xyz).

- **Never trades.** The guard reads one public endpoint and returns a decision.
- **Fails closed.** If the registry cannot be read, it does not allow the buy, unless you set `failOpen`.
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
| `unknown` | `failOpen` | could not check |

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
(up to 50 addresses), `recent_impostors`, `stock_passport`, `find_stock_token` and `list_stock_tokens`.

## Demo

```bash
node examples/demo.mjs
```

An agent is handed an impostor of SNDKc. It refuses it, checks the issuer-listed contract, and would proceed. It is a
dry run: nothing is traded.

Facts with their time and source; not investment advice. No affiliation with Coinbase or Robinhood; their names and
tickers are their trademarks.
