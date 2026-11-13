# Proof of Stock

[![CI](https://github.com/proofofstock/proof-of-stock/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/proofofstock/proof-of-stock/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Proof of Stock tells you whether a tokenized-stock contract is the issuer's own. It looks the exact address up in the
issuer's registry: Coinbase's for Base, Robinhood's for Robinhood Chain. A name or a symbol proves nothing, so tokens
that copy a listed symbol are flagged and pointed at the listed contract.

For a listed token it also shows the issuer's price, how old that price is, and how far the deepest on-chain pool
trades from it.

It is for:

- **people buying stock tokens**, who want to check a contract before they buy;
- **agent builders**, whose agents need the same check before a swap.

Live at **[proofofstock.xyz](https://proofofstock.xyz)**. Documentation: [proofofstock.xyz/docs](https://proofofstock.xyz/docs/).

## Use it

No key and no sign-up for any of these.

| | |
|---|---|
| **Site** | [proofofstock.xyz](https://proofofstock.xyz): paste an address or type a ticker. |
| **MCP server** | `https://proofofstock.xyz/mcp` (Streamable HTTP, stateless). Six tools: `find_stock_token`, `list_stock_tokens`, `stock_passport`, `verify_stock_tokens`, `recent_impostors`, `compare_venues`. |
| **JSON API** | `GET /verify`, `GET /badge.svg`, `GET /api/passport` and more. See the [HTTP API reference](docs/reference/http-api.md). |
| **Guard** | `@proofofstock/guard`, a pre-trade check for Node agents, with a Coinbase AgentKit action. It lives in [`packages/proofofstock-guard`](packages/proofofstock-guard/). **Not on npm yet**: import it from this repository for now. |

Add the MCP server to Claude Code:

```bash
claude mcp add --transport http proofofstock https://proofofstock.xyz/mcp
```

Claude, ChatGPT, Cursor and raw JSON-RPC are covered in the [tutorial](docs/tutorials/connect-an-agent.md).

## Check us, not just our answers

A checker is worth something only if you do not have to take its word. Each of these works without trusting us:

- **The list behind a verdict.** Every answer names the issuer list it was decided against by the SHA-256 of its
  sorted addresses, with a shell command that computes the same hash from the issuer's own API, and a URL of that
  exact list frozen.
- **A receipt to keep.** `/verify?...&receipt=1` returns a record of the check that
  [`scripts/receipt-check.mjs`](scripts/receipt-check.mjs) can check again months later, after the issuer's list has
  changed. See [Keep a receipt of a check](docs/how-to/keep-a-receipt.md).
- **The issuer's factory, read from the chain.** Each issuer creates its tokens from a factory that logs every one.
  We read those logs as a second source (`issuer_factory` in each answer). On Base all 348 tokens on Coinbase's list
  are among the 359 its factory created; on Robinhood Chain all 203 listed tokens are among the 212 its factory
  created.
- **Prices you can replay.** An on-chain price carries its block and the exact call; `eth_call` at that block returns
  the same bytes.
- **A public exam, every day.** About 590 tokens whose right answer comes from the issuers; the reports are in the
  [`exam` branch](https://github.com/proofofstock/proof-of-stock/tree/exam).
- **History anchored in Bitcoin.** Once a day, a manifest of every data file of the day is timestamped through
  OpenTimestamps. See [Check that our data existed on a given day](docs/how-to/verify-an-anchor.md).

## Example

Check one address on Base. This one calls itself `SNDKc` but is not on Coinbase's registry:

```bash
curl -s 'https://proofofstock.xyz/verify?chain=base&address=0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703' \
  | jq '{listed, impostor, listed_on_other_chain, registry_age_s}'
```

```json
{
  "listed": false,
  "impostor": { "kinds": ["registry_symbol"], "imitates_symbol": "SNDKc", "listed_address": "0xb200000000000000000000397293cb8cda9a10c5" },
  "listed_on_other_chain": null,
  "registry_age_s": 112
}
```

`listed` is `true` only when this exact address is in the registry. `impostor.listed_address` is the contract the issuer
actually lists. A `503` means the registry could not be read: that is no answer, not "not listed". More in
[Check a contract before listing or buying it](docs/how-to/check-before-listing.md).

## What it does not do

- **It only reads.** It never trades, holds no keys or wallets, and has no accounts and no cookies.
- **It is not advice.** An answer is a fact about data at a stated time. See [Legal](docs/legal.md).
- **"Not listed" is not "fake".** A genuine token of another issuer answers the same. Only Coinbase on Base and
  Robinhood on Robinhood Chain are checked.
- **It is not a live quote.** On-chain prices are recorded every 15 minutes, and every answer says how old it is.
- **It is not affiliated** with Coinbase or Robinhood. Their names and tickers are their trademarks.

How the answers are computed, and the known limits: [Methodology](docs/explanation/methodology.md).

## Run the tests

Node 20 or later.

```bash
npm install
npm test        # every suite, no network
npm run locks   # mutation locks: each breaks the code on purpose and needs a test to go red
```

To run the site locally, point it at the recorder's data and open `127.0.0.1:3005`:

```bash
STOCKS_ROOT_BASE=<dir> STOCKS_ROOT_ROBINHOOD=<dir> npm start
```

The recorder (`scripts/stocks/stock-peg.mjs --chain=base --root=<dir>`) needs outbound HTTPS to the issuer APIs,
DexScreener and GeckoTerminal.

## Layout

| Path | What |
|---|---|
| `evm/core/stocks/` | the logic, with no I/O: registries, impostors, premium, pool rules, NYSE calendar, passport, verify |
| `apps/` | the site, the JSON API and the MCP server |
| `packages/proofofstock-guard/` | the guard |
| `scripts/stocks/` | the recorder (every 15 min), the impostor list (every 6 h), CLIs |
| `schemas/v2/` | schemas of the recorded rows, checked on every write |
| `tests/locks/` | the mutation locks |
| `deployment/` | the nginx and systemd units the live site runs on |
| `docs/` | the documentation served at [proofofstock.xyz/docs](https://proofofstock.xyz/docs/) |

## Licence, security, contact

- Code under the [MIT licence](LICENSE).
- Found a vulnerability? See [SECURITY.md](SECURITY.md). Please do not open a public issue for it.
- Contact: [hello@proofofstock.xyz](mailto:hello@proofofstock.xyz).
- What changed in each release: [CHANGELOG.md](CHANGELOG.md).
