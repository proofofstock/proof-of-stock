v0.5.0 · updated 2026-11-11

# Compare one stock across Base and Robinhood Chain

Use this when the same share is tokenized on both chains (Coinbase's token on Base, Robinhood's on Robinhood Chain)
and you want to see how each trades against its own issuer.

## With the HTTP API: `/api/matrix`

Every share listed on both chains, matched by ISIN:

```bash
curl -s https://proofofstock.xyz/api/matrix | jq '{pairs, with_gap, without_gap, stale, session: .market_now.session}'
```

One share, picked by its Base symbol:

```bash
curl -s https://proofofstock.xyz/api/matrix | jq '.rows[] | select(.base.symbol == "NVDAc")
  | {isin, gap, gap_refused,
     base:      .base      | {symbol, premium, reference_kind, reference_age_s, multiplier, liquidity_usd, stale},
     robinhood: .robinhood | {symbol, premium, reference_kind, reference_age_s, multiplier, liquidity_usd, stale}}'
```

Each row has:

- `base` and `robinhood`: one cell per venue, with that venue's `premium` over **its own** issuer's reference, the
  reference's kind and age (measured now), the multiplier, the deepest pool's liquidity and
  `premium_at_reference_time`;
- `gap`: the Robinhood premium minus the Base premium, as a fraction. `0.0031` is 0.31 percentage points;
- `gap_refused`: when there is no gap, why, per venue, for example `robinhood: reference_spread_wide` or
  `base: reading_stale`;
- `reference_note`: in words, which references the two premiums are over.

Rows with a gap come first, largest |gap| first.

## With an agent: `compare_venues`

```bash
curl -s https://proofofstock.xyz/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"compare_venues","arguments":{"symbol":"NVDA"}}}' \
  | jq -r '.result.content[0].text'
```

- Name the share by `symbol` (either form: `NVDA` or `NVDAc`) or by `isin`. If you give both, a row must match both.
- With no argument, you get the 20 rows with the largest gap.
- In chat, ask: "Compare NVDA on Base and Robinhood Chain."

The lead sentence gives the gap in percentage points, then each venue's premium:

```
1 pair for the ticker NVDA on Base and Robinhood Chain, 1 with a current gap: NVDAc/NVDA gap +0.31 pp
(Base +0.12%, Robinhood +0.43%). Each premium is over its own issuer's reference (Coinbase NAV, Robinhood bid/ask),
so a gap is not a price difference.
```

(The values are illustrative.)

## Why premiums are compared, never raw prices

Two raw prices for "the same stock" on the two chains are not comparable:

- **The multipliers differ.** A token is worth `multiplier` shares, and each issuer sets its own. Two tokens of one
  share can carry different multipliers, so their dollar prices differ by design.
- **The references differ.** Coinbase publishes a NAV per token, total return. Robinhood publishes a token bid and
  ask. They are not the same number and are not updated at the same moments. Every row on the matrix has
  `reference_kinds_differ: true` for that reason.
- **The issuers differ.** One ISIN means both tokens are claims on the same security, under different issuers'
  terms. They are not interchangeable.

So each venue is measured against its own issuer: premium = pool price / own reference - 1. The gap is the difference
of those two premiums. It says how differently the two chains trade against their issuers. It is not a price
difference between the chains and not an arbitrage.

## When there is no gap

A gap needs a current premium on both venues. There is none when:

- either venue has no premium (`gap_refused` carries the venue's `premium_refused`);
- either reading is older than 30 minutes (`stale: true`, `gap_refused: "<chain>: reading_stale"`). A stopped recorder
  is not today's market.

Check `reference_age_s` on both cells too. A gap over a reference held since the last close compares two held prices,
which is a different question from a gap during the session. See
[the methodology](../explanation/methodology.md#why-us-market-sessions-matter).

Field details: [HTTP API reference](../reference/http-api.md), [tools reference](../reference/tools.md).

[Not investment advice](../legal.md)
