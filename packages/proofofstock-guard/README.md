# @proofofstock/guard

A pre-trade check for agents that buy tokenized stocks on **Base** (Coinbase's tokens) and **Robinhood Chain**
(Robinhood's). Before a swap, the guard asks one question: is this exact contract on the issuer's own registry? The
answer comes from [proofofstock.xyz](https://proofofstock.xyz).

- **Never trades.** The guard reads one public endpoint and returns a decision.
- **Fails closed.** If the registry cannot be read, it does not allow the buy, unless you set `failOpen`.
- **No evidence, no buy.** A listed answer must carry the issuer list it was decided against (`list_proof`), not stale
  and read within `maxRegistryAgeS` (900 s).
- **It does not take our word for it (0.3.0).** A listed answer is believed only if, on Base, the address has the
  form of every Coinbase stock token (`0xb2` and twenty zero hex digits, pinned in the package), and, by default, the
  issuer's own list, read by the guard itself, has the address. The issuer is chosen by the chain, never by the answer.
  So a proofofstock.xyz that was broken into could still refuse a buy, but could not make one. In a browser the
  issuers' APIs cannot be read (no CORS), so `crossCheck` defaults to off there and the prefix check stands alone.
  Two limits, said plainly:
  - **The prefix is pinned.** If Coinbase ever creates stock tokens at a new kind of address, this version answers
    `unknown` for them (a refusal, never a crash) until a new version updates the pin.
  - **Only 0.3.0 and later check this.** Agents on 0.2.x still take a listed answer as it comes; update to get it.
  - **`failOpen` covers an outage, not a contradiction (0.3.1).** A `503` from proofofstock.xyz saying the chain contradicts the issuer's list for the address (`factory_conflict`, `issuer_prefix_mismatch`) is refused too.
  - **`failOpen` covers an outage, not a contradiction.** An issuer that cannot be read may be let through with `failOpen`; an issuer's list that was read and does not have the address never is.
  - **A failed read of the issuer's list is kept for 15 seconds**, so a batch asks once. Coinbase's list is followed page by page, up to 5 pages.
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
| `crossCheck` | `true` (`false` in a browser) | also read the issuer's own list, once a minute at most, and require the address on it |

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

### The whole buy, from the user's sentence to an unsigned swap

```bash
node examples/agent-buy.mjs                                    # "buy $20 of SNDK on Base", handed a look-alike
node examples/agent-buy.mjs "buy $20 of NVDA on Base" --from 0xYourWallet
```

The user asks for $20 of SNDK and the agent is handed a look-alike. The guard refuses it and names the issuer's
contract; the agent checks that one, reads its passport (minted, not paused, the issuer's reference price), asks a
public DEX aggregator (KyberSwap, no key) for a USDC quote, and refuses the quote unless it is for the very contract it
checked and sits within 3% of the reference. It then prints a KyberSwap link with that contract already filled in,
so a person can make the same swap in the browser without searching by name. With `--from` it builds the swap for that
wallet, to KyberSwap's router only. It never signs and never sends: the transaction is printed for the user's own wallet to review. Anything it
cannot read stops the buy (exit 3). Tests with every answer faked: `node examples/agent-buy.test.mjs`.

Facts with their time and source; not investment advice. No affiliation with Coinbase or Robinhood; their names and
tickers are their trademarks.
