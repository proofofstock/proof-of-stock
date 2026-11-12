v0.5.0 · updated 2026-11-11

# Proof of Stock documentation

```
Is 0x… on Base the issuer's tokenized stock?      → /verify, verify_stock_tokens
What does the issuer say it is worth, and since?  → stock_passport: reference, reference.age_s
How far does the chain trade from that?            → stock_passport: latest.premium
```

## Quick start

No key, no sign-up.

```bash
# an agent: the MCP server
claude mcp add --transport http proofofstock https://proofofstock.xyz/mcp
# anything else: plain HTTP
curl -s 'https://proofofstock.xyz/verify?chain=base&address=0xb20000000000000000000078ee7ce2fe4908108c'
```

## Tutorials

Learn by doing, start to finish.

- [Connect an agent and read your first passport](tutorials/connect-an-agent.md): Claude, Claude Code, Cursor or curl,
  in five minutes.

## How-to guides

Recipes for one task each.

- [Check a contract before listing or buying it](how-to/check-before-listing.md): `/verify`, the badge,
  `verify_stock_tokens` and `@proofofstock/guard`.
- [Alert when the on-chain price drifts from the issuer's reference](how-to/alert-on-gap.md): poll `/api/overview` or
  `stock_passport`, with a small Node script.
- [Compare one stock across Base and Robinhood Chain](how-to/compare-venues.md): `/api/matrix` and `compare_venues`.
- [Keep a receipt of a check](how-to/keep-a-receipt.md): `/verify?...&receipt=1` and `scripts/receipt-check.mjs`, to
  prove months later why a token was or was not listed.
- [Check that our data existed on a given day](how-to/verify-an-anchor.md): the daily OpenTimestamps anchors at
  `/anchors/`.

## Reference

Every field, tool and route.

- [The passport](reference/passport.md): every field and note code.
- [MCP tools](reference/tools.md): inputs and answers of each tool.
- [HTTP API](reference/http-api.md): routes, status codes, caching and rate limits.

## Explanation

Why it works the way it does.

- [Methodology](explanation/methodology.md): the sources and cadence of each layer, how "issuer-listed" and
  impostors are decided, how the premium is computed, market sessions, quarantine and known limitations.

## Also

- [Legal](legal.md): not advice, no affiliation, data as is, licence.
- [Changelog](changelog.md): every release, what changed and what broke.

[Not investment advice](legal.md)
