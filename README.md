# Stock Token Passport

**Is this token the issuer's tokenized stock, and how far does the chain trade from the issuer's price?**

Live at [proofofstock.xyz](https://proofofstock.xyz) · MCP server `https://proofofstock.xyz/mcp` · Base (Coinbase registry)
and Robinhood Chain (Robinhood registry).

## What it does

1. **Identity.** A token is the issuer's only if its exact contract is in the issuer's own registry. A name or a symbol
   proves nothing. Tokens that copy a listed symbol or the issuer's naming are flagged, with the listed contract.
2. **Reference.** The issuer's price for one token (Coinbase NAV, Robinhood token bid/ask), always with its age, against
   the NYSE calendar.
3. **Premium.** The deepest on-chain pool against a dollar stable or wrapped ETH, recorded every 15 minutes, split by
   market session.

Every answer carries its time and source. It never trades and gives no advice.

## Surfaces

| Surface | Where |
|---|---|
| Terminal-style site | `apps/stocks-web.mjs`, `apps/stocks-web/` |
| `GET /verify`, `GET /badge.svg` | the one-bit check and an embeddable badge (`evm/core/stocks/verify.mjs`) |
| Public MCP server (Streamable HTTP, stateless) | `apps/stocks-mcp-http.mjs`; tools `find_stock_token`, `list_stock_tokens`, `stock_passport`, `verify_stock_tokens`, `recent_impostors` |
| Pre-trade guard for agents (AgentKit action) | `packages/stockofproof-guard/` |
| Recorder (every 15 min) and impostor list (every 6 h) | `scripts/stocks/stock-peg.mjs`, `scripts/stocks/impostor-list.mjs` |

## Layout

- `evm/core/stocks/`: pure logic, with no I/O: premium, pool rules, registries, NYSE calendar, impostors, passport,
  verify.
- `scripts/stocks/`: the recorder, the impostor list, GeckoTerminal completion, CLIs.
- `schemas/v2/`: the recorded row schemas, validated on every write.
- `tests/locks/`: mutation locks. Each one breaks the code on purpose and requires a test to go red.
- `deployment/`: nginx and systemd units.
- `docs/`: the agent guide and the truth-layer TZ.

## Run

```bash
npm install
npm test          # every suite, no network
npm run locks     # every mutation lock
STOCKS_ROOT_BASE=<dir> STOCKS_ROOT_ROBINHOOD=<dir> npm start   # the site on 127.0.0.1:3005
```

The recorder needs outbound HTTPS to the issuer APIs (Coinbase, Robinhood), DexScreener and GeckoTerminal:

```bash
node scripts/stocks/stock-peg.mjs --chain=base --root=<dir>
```

## Deploy

Production runs on one host from pinned releases: `/opt/stp/releases/<sha7>`, with `/opt/stp/current` pointing at the
live one. The units in `deployment/systemd/` (`stp-web`, `stp-peg` every 15 min, `stp-impostors` every 6 h) all work
there. The host holds no git checkout and no GitHub credential.

```bash
scripts/ship.sh <sha>       # from a checkout: refuses a non-descendant, lists what ships, uploads, gates, switches
scripts/ship.sh --status    # what runs
```

`scripts/deploy.sh`, on the host, installs dependencies, runs the whole test suite as the gate, re-checks that nothing
else was deployed meanwhile, switches the link and restarts the site, and restores the previous release if the health
check fails.

## Status

Private. Not investment advice. No affiliation with Coinbase or Robinhood; their names and tickers are their
trademarks. © the authors, all rights reserved until a licence is chosen.
