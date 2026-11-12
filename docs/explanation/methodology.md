v0.5.0 · updated 2026-11-11

# Methodology: where the data comes from and what counts as issuer-listed

```
registry   (every 5 min)   is this exact address on the issuer's own list?
reference  (every 15 min)  what does the issuer say one token is worth, and since when?
pools      (every 15 min)  what does the deepest eligible pool pay for it?
premium                    pool price / reference - 1, with both ages attached
```

This page explains why each of those layers works the way it does. The field-by-field description is in
[the passport reference](../reference/passport.md); the routes are in [the HTTP API reference](../reference/http-api.md).

## Sources, per layer

| Layer | Base (chain 8453) | Robinhood Chain (chain 4663) |
|---|---|---|
| Registry | Coinbase Tokenized Stocks API, `GET https://api.coinbase.com/v1/tokenized-stocks`, every page | Robinhood `GET https://api.robinhood.com/rhj/assets`, the deployments whose `chainId` is 4663 |
| Reference | `nav_price` from the same Coinbase records: a net asset value per token, total return | `tokenBid` / `tokenAsk` from `GET https://api.robinhood.com/rhj/prices`, mid of the two |
| Pools | DexScreener `token-pairs/v1/base/<address>` | DexScreener `token-pairs/v1/robinhood/<address>` |
| Pools, second source | GeckoTerminal, only when DexScreener lists 30 pairs (its cap), and not in the last 90 s of a run's time limit | the same |

None of these needs a key. The code is `evm/core/stocks/registries.mjs`, `scripts/stocks/stock-peg.mjs` and
`scripts/stocks/gecko-pools.mjs`.

Some details that matter when you read a number:

- **Both references are already per token.** Coinbase's NAV has the corporate-action multiplier inside it. Robinhood's
  `tokenBid` and `tokenAsk` are the share's quote multiplied by the token's `currentMultiplier`. The code never applies
  the multiplier again. It still records the multiplier on every reading, so you can see it.
- **Robinhood's token prices are not in its published docs.** If `tokenBid` or `tokenAsk` disappear, the code falls
  back to the documented share `bid` / `ask` times `currentMultiplier`.
- **A list is read whole or not at all.** If one page of a registry fails, the whole read fails. A short list would
  read as "these tokens are not stocks", which is the error this project exists to prevent. A missing price is
  different: the list is still true, and that token gets a null reference.
- **Absent is not zero.** Coinbase omits fields that hold their default. A missing `nav_price` becomes `null`, never 0.
- **GeckoTerminal is a supplement.** It is asked for up to three pages of 20 pools, paced, and merged with the
  DexScreener list by pool address. If it refuses, the DexScreener reading stands as it was.

## Cadence of each layer

| What | How often | Where it is set |
|---|---|---|
| The site rereads both registries | every 5 minutes | `REGISTRY_TTL_MS` in `apps/stocks-web.mjs` |
| The site rereads the recorded readings, the impostor list and the names file | every 5 minutes, with the registries | `refreshAll()` in `apps/stocks-web.mjs` |
| The recorder takes a reading of every token | every 15 minutes, at minutes 07, 22, 37 and 52, with up to 30 s of random delay | `deployment/systemd/stp-peg.timer` |
| The impostor list is rebuilt | every 6 hours, at 23 minutes past 00, 06, 12 and 18 (host time), and 5 minutes after boot | `deployment/systemd/stp-impostors.timer` |

One recorder run reads Base first, then Robinhood, one token at a time with a pause between tokens. So the readings
of one run are spread over several minutes, and each carries its own `observed_at`. On Base the recorder skips tokens
with no supply: Coinbase lists many tokens before any is minted, and they have no pool to read.

The site holds the last 72 hours of readings in memory for its own statistics; a passport shows at most the last 24. Nothing on a request path reads the dataset or calls out.

## How "issuer-listed" is decided

**By the exact contract address in the issuer's registry for that chain. Nothing else.**

```
listed = registry.some(r => r.address === address.toLowerCase())
```

- A symbol, a name or an address that looks similar never makes a token listed.
- Case does not matter: addresses are compared in lower case.
- A token outside the registry is "not in the Coinbase registry" or "not in the Robinhood registry". It is never
  called fake: it may be a genuine token of an issuer this project does not cover.
- If the registry could not be read for more than 15 minutes, `/verify` answers 503 with no verdict. An old copy could
  accuse a token that was simply listed since. The code is `evm/core/stocks/verify.mjs`.

## How impostors are detected

A token outside the registry can still *claim* an identity through its name. The impostor rules only ever look at
tokens that are not listed, and they only say what the name resembles.

| Kind | The rule | Published as an impostor? |
|---|---|---|
| `registry_symbol` | The symbol is, character for character, a listed symbol on the same chain, **and** that symbol is distinctive, that is, not just the bare ticker. Coinbase's `NVDAc` qualifies. Robinhood's `GME` does not, because Robinhood names its tokens with the bare ticker. | yes |
| `issuer_name_suffix` | On Robinhood Chain only: the name ends the way Robinhood names its tokens, `… Robinhood Token`. The target is filled in when a listed Robinhood token has the same ticker or a name that starts the same way; otherwise there is no target. | yes |
| `ticker` | The symbol equals a listed ticker, ignoring case (`NVDA`, `nvda`). | **no**: counted, not listed |

Why `ticker` is not an accusation: many memecoins borrow a ticker without pretending to be the share. On Robinhood
Chain the same letters as Robinhood's bare tickers are common. The impostor list counts them in `counts.ticker` and
leaves them out of `items`.

The impostor list is built by `scripts/stocks/impostor-list.mjs` from the token names in our own dataset. The site
reads the result and makes no outbound call for a name.

**Address signals stay internal.** The code also computes three address-level signals: `address_lookalike` (the
characters a wallet shows match a listed address while the middle differs), `vanity_prefix_partial` (on Base, a
partial copy of the `0xb2000…` prefix every Coinbase address carries) and `unlisted_full_prefix` (the full prefix,
most likely a fresh Coinbase deploy the registry has not published yet). They are written to
`impostor-signals.internal.json`, which nothing public reads. They stay there until their precision has been
measured. A self-check switches the two prefix signals off if any Coinbase address ever lacks the full prefix.

## How the premium is computed

```
premium = deepest_eligible_pool_price / reference_price - 1
```

`premium` is a fraction: `0.004` means the on-chain price is 0.4% above the issuer's reference, and a negative value
means below. The code is `pegReading()` in `evm/core/stocks/peg.mjs`.

### Which pools count, and why

A pool prices the stock token only when **all** of these hold:

1. The token is on one side of the pool.
2. The other side is one of the chain's dollar stablecoins or its wrapped ETH, **matched by contract address**. The
   addresses come from the chain descriptor (`evm/chains/<chain>/descriptor.mjs`) and every passport lists them in
   `sources.pools_counted.paired_with_addresses`.
3. The pool holds at least **$10,000** of liquidity, as the source reports it.
4. The source gives a usable price for the token on its side of the pool (base side: `priceUsd`; quote side:
   GeckoTerminal's `quotePriceUsd`, else `priceUsd / priceNative`).

Of the pools that pass, the deepest one sets the price.

Why the pairing rule: a source's dollar price for a pool is the price of the *other* token carried across. Against a
stablecoin or WETH that is a market price. Against a memecoin it is circular. On Robinhood Chain memecoins are often
launched paired with a stock token, so their dollar price is derived from the stock token, and reading the stock token
back out of them returns a number unrelated to the share. Matching by address matters because a symbol such as `USDC`
is free to copy.

`pools.seen` counts every pool the sources listed. `pools.eligible` counts the ones that passed. `pools.capped` is
true when the list may be incomplete: DexScreener returned its maximum of 30 and GeckoTerminal could not show the end.

### The 1% spread gate

When the reference has a bid and an ask, the code checks the spread, `(ask - bid) / mid`. If it is wider than **1%**,
or the quote is crossed, there is no premium and the reading says `premium_refused: "reference_spread_wide"`. A mid of
a wide quote would mostly measure the quote's own spread. Only Robinhood's reference has a bid and an ask, so in
practice the gate applies to Robinhood. Weekend quotes are where it usually triggers.

With a bid and an ask there is a second, simpler fact: `dex_inside_quote` says whether the pool price sits between
them.

### Refusals

A null premium always comes with exactly one reason, decided in this order:

| `premium_refused` | Meaning |
|---|---|
| `no_reference` | the issuer publishes no usable price for this token |
| `pairs_unavailable` | DexScreener could not be read |
| `no_pairs` | no pool lists the token |
| `no_eligible_pool` | pools exist, but none passes the rules above |
| `reference_spread_wide` | the issuer's quote is wider than 1%, or crossed |

### The reference's age

The premium is only as meaningful as the reference is recent, so every reference carries its age.

- **Coinbase** gives the NAV's own update time, `nav_price_updated_at`. The age is measured from that.
- **Robinhood** stamps every quote with the time its server answered, which is seconds old even when the quote has not
  moved all weekend. So the recorder keeps, per token, the last mid it saw and since when
  (`<root>/stock-peg/reference-since.json`). The age is the time since the mid last **changed**.

The passport recomputes the age against the time you ask, so a stopped recorder cannot leave an old reference looking
fresh.

### Two moments: `premium` and `premium_at_reference_time`

`premium` compares the latest pool price, read minutes ago, with the latest reference, which may be hours old. Those
are two different moments. `latest.premium_at_reference_time` answers the other question: it is the premium of the
first priced reading taken at or after the reference last moved, so both prices belong to one moment. Its `lag_s` says
how long after the reference change that reading was taken. Only a reading within two recorder runs (1800 s) of the
change counts, and only inside the requested window: when the reference moved before the window began, or no priced
reading followed it within 1800 s, the field is `null` rather than a reading from another moment.

## Why US market sessions matter

```
pre      04:00-09:30 New York
regular  09:30-16:00   (13:00 on an early-close day)
post     16:00-20:00   (17:00 on an early-close day)
closed   otherwise, all day on weekends and NYSE holidays
unknown  any date outside the holiday table (2026 and 2027 today)
```

The issuer's reference follows the primary listing. While the exchange is closed, the reference holds its last value,
and the on-chain pool keeps trading against it. The gap that opens over a weekend is a different thing from a gap
during the session, so the passport splits the premium series into `regular`, `extended` (pre and post), `closed` and
`unknown`.

The notes follow the same logic:

- `reference_held_market_closed`: outside the regular session, the reference is more than 1 hour old. This is
  expected.
- `reference_held_market_open`: during the regular session, the reference is more than 30 minutes old. This is worth
  flagging: the price should be moving.

A date past the end of the holiday table is `unknown`, never `regular`, and the passport adds `calendar_unknown`.
Guessing an open market on a holiday the table does not know would make a held reference look fresh.

Robinhood's tokens trade around the clock on weekdays, so a Robinhood reference can be live at 02:00 New York time while
the session says `closed`. That is not a contradiction. The session describes the primary listing; the reference's own
age says whether the issuer was quoting.

## Why the NAV lags

Coinbase's `nav_price` is a published value with its own update time, not a trade-by-trade quote. It moves in steps,
and between steps it holds. It is also a **total return** value: it carries dividends and corporate actions, so it is
not the share's last trade price either. When the pool price is minutes old and the NAV is older, a premium can be
partly the market moving between the two times. That is why every passport shows `reference.age_s` next to `premium`,
and why `premium_at_reference_time` exists.

## Quarantine of known-bad readings

The dataset is append-only. When readings are known to be wrong, they stay on disk, and the site leaves them out of
every chart and statistic. The list is `KNOWN_BAD` in `evm/core/stocks/quarantine.mjs`.

One window is quarantined today:

| Window (UTC) | What went wrong | Which rows | Fixed by |
|---|---|---|---|
| 2026-11-09 17:30 to 19:55 | the recorder priced stock tokens from memecoin pools, which is circular (see above) | rows of that span with a premium whose deepest pool was not against `USDC`, `USDBC`, `DAI`, `WETH`, `USDG` or `ETH` | the same day: the recorder now prices only against dollar stables or WETH, matched by address |

Rows of that window that were priced against one of those assets are kept. This filter matches the pool by
`quote_symbol`, because rows of that span store no quote address.

## Known limitations

- **Recorded, not live.** Readings are taken every 15 minutes. `latest` is the last recorded reading, and the site
  rereads the files every 5 minutes, so it can be up to about 20 minutes old in normal operation. `latest.age_s` says
  how old it is. Over 30 minutes the passport adds `reading_stale`, and the overview stops ranking the token.
- **A stale NAV against a fresh pool price.** `premium` mixes two moments whenever the reference is old. Read
  `reference.age_s` first. `premium_at_reference_time` is the answer when you need one moment.
- **A Robinhood reference seen for the first time** is dated from the quote's own time, because the recorder has no
  earlier mid to compare with. The age is then an underestimate until the mid next changes. This also happens if the
  recorder's `reference-since.json` is lost. A Robinhood token with no reading of ours at all has
  `reference.age_s: null`: its only time is when Robinhood's server answered, which says nothing about when the mid moved.
- **Two chains, two issuers.** Base is checked against Coinbase's registry and Robinhood Chain against Robinhood's.
  A genuine tokenized stock of another issuer shows as "not in the registry". That is a statement about these two
  lists, not about the token.
- **Impostor coverage is limited to tokens our dataset has seen.** The list is built from the names our own collector
  recorded. A token it never saw has no name here, so the passport cannot say what it resembles.
- **The Base tail-6 look-alike rule is unmeasured.** On Base every Coinbase address starts the same way, so the
  look-alike rule there compares only the last 6 hex characters. Chance matches are expected. The signal is internal
  and stays unpublished until its precision is measured.
- **Delisting is tracked per process.** `delisted_at` is set only for addresses that left the registry since the site
  last started.
- **An outside token's name is its creator's text.** It is compared after normalization (NFKC, invisible characters
  removed), so those are not a way past the comparison; look-alike letters from another alphabet still are. It is
  published as a short one-line label and never put into a sentence the service says.
- **Rate limits.** Per client address (an IPv6 client is keyed by its /56), 60 units per minute, shared by `/api/*`,
  `/verify` and `/mcp`. A passport costs 3 units, and a `verify_stock_tokens` call of n addresses ⌈n/10⌉ units. Over the limit the answer is
  429 with `Retry-After: 60`. The proxy in front also caps bursts. `/badge.svg` is not limited per client, because
  image proxies fetch it from few addresses.
- **No SLA.** The site runs on one host. There is no uptime or freshness guarantee. Every answer carries its time, so
  you can tell when it is old.

[Not investment advice](../legal.md)
