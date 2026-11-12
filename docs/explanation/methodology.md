v0.5.0 · updated 2026-11-12

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
| Pools, the chain itself | every pool known for the token, read at one block through Multicall3 on `https://mainnet.base.org` | the same, on `https://rpc.mainnet.chain.robinhood.com` |

None of these needs a key. The code is `evm/core/stocks/registries.mjs`, `scripts/stocks/stock-peg.mjs`,
`scripts/stocks/gecko-pools.mjs` and `scripts/stocks/onchain-pools.mjs`.

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
- **The chain is read too, and where it sees a pool it wins.** See [The chain as a source](#the-chain-as-a-source).
  If the chain cannot be read, the aggregators' reading stands as it was; if DexScreener cannot be read, the chain's
  pools give the reading on their own.

## The chain as a source

Every run reads each token's pools from the chain itself, at one block pinned for that token, in one `eth_call` to
Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, deployed on both chains). The public RPCs count every call
in a JSON-RPC batch on its own, so the calls go inside Multicall3 instead.

**Which pools.** A pool book per chain (`<root>/stock-peg/pool-book.json`) holds every pool DexScreener or
GeckoTerminal ever listed for the token against a stablecoin or WETH, and every pool the main factories return for
(token, USDC or USDG or WETH, fee or tick spacing). The factories are asked every 6 hours: on Base Uniswap v3 and both
Aerodrome concentrated-liquidity factories; on Robinhood Chain Uniswap v3, SushiSwap v3, Aero, Ramses and Up.
The chain is read while DexScreener answers, from the book as it stood, so a pool DexScreener lists for the first
time is read from the chain from the next run on (15 minutes later); the factories' pools are read from the first.

**What is read, per pool kind:**

| Kind | Calls | Price | Liquidity |
|---|---|---|---|
| A pool with its own contract and `slot0` (Uniswap v3 and its forks) | `token0`, `token1`, `slot0`, each token's `balanceOf(pool)` | from `sqrtPriceX96` | both balances in dollars |
| A constant-product pool | `token0`, `token1`, `getReserves`, `stable` | reserves ratio | both reserves in dollars; a pool whose `stable()` is true is a different curve and is not read |
| Uniswap v4 | `StateView.getSlot0(poolId)` | from `sqrtPriceX96` | **not readable**: v4 keeps all pools' tokens in one contract, so the aggregator's figure is used |

A stablecoin counts as $1. WETH is priced from the chain's deepest WETH/stable Uniswap v3 pool, read in the same call
at the same block. **A pool does not set its own depth:** in "both balances in dollars", the stock token's balance is
valued at the issuer's reference price, never at the pool's own price, and is not counted at all when the issuer gives
no price (then only the stablecoin or WETH side counts). On 12.11 two Base pools whose `slot0` said about 1e40 dollars
a token held dust of it; at their own price that dust would have been the deepest pool on the chain. A Uniswap v4 pool against WETH is not read: its currency may be native ETH, which sorts first, and
the pool id alone does not say which. A pool whose `token0`/`token1` are not the token and the asset the listing
claimed is not read either. Pools the code cannot decode (some forks) keep the aggregator's figures.

**The chain wins.** For a pool both the chain and an aggregator see, the price is the chain's, and so is the liquidity
unless the pool is Uniswap v4. This was decided on 12.11.2026, after the chain showed that 16 Base pools
from one Aerodrome factory, which DexScreener reported tens of thousands of dollars deep, each held about $0.01. For
14 of the 41 Base tokens that had an eligible pool, the premium had been read from one of them. **From the release of
this change, those Base readings move to another pool or become `no_eligible_pool`.** Robinhood's figures matched the
chain.

**slot0 is what the pool said at that block, not a fair price.** A pool can be pushed for one block. The liquidity
floor and the cross-check below are what stand against that, not the chain read itself.

**The cross-check.** When the chain and an aggregator both price the deepest pool and their prices for the token differ
by more than **2%**, the premium is refused as `sources_disagree`; the chain's price is kept in `dex_price_usd`. On
12.11 they differed by at most 0.2% for pools with their own contract and 1% for one v4 pool. The 2% is provisional
(`MAX_SOURCE_DISAGREEMENT` in `evm/core/stocks/peg.mjs`).

The RPC can be replaced by setting `STP_RPC_BASE` or `STP_RPC_ROBINHOOD` (a keyed provider). The run row then says
`onchain.rpc: "custom"`; the URL is never written, and the evidence always names the public RPC.

## Evidence for each price

Every reading says what its DEX price rests on, in `price_evidence`. It covers **the DEX leg only**. The issuer's
reference is an answer from the issuer's API that nobody can ask for again as it was, and every reading says so:
`reference_evidence: "issuer_api_not_reproducible"`.

**`onchain`: anyone can ask the chain again.** The row holds the block number and hash, the Multicall3 calldata of
exactly the calls the price used (the pool, and the WETH/USD pool when the pool is against WETH), and the bytes the
node returned. `reproduce` is that call:

```
cast call --block <block_number> 0xca11bde05977b3631167028862be2a173976ca11 <calldata> --rpc-url <rpc>
```

Its output is `return_data`, byte for byte. Decode it with the `decoder` named on the row and the `decimals` beside
it, and you have the price. On Base the public RPC answers at old blocks (checked back 120 days on 12.11).
**Robinhood Chain's public RPC keeps no state older than about an hour,** so there `reproduce_needs` is
`"archive_rpc"`: the call needs a node that keeps old state. The block hash still pins what was asked.

**`none`: there is nothing to show.** When DexScreener or GeckoTerminal alone priced the deepest pool, the row says
`price_evidence: { "evidence": "none" }`. Their answer cannot be asked for again, and a hash of it would not be
evidence of anything.

We may keep short-lived private copies of third-party responses for our own error checking; they are not published,
not resold, and not evidence. They are off unless switched on, kept for 30 days, and stored apart from the published
data (`scripts/stocks/raw-store.mjs`).

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
| `registry_name` | The whole name is a listed company's name, compared without case, punctuation and the corporate ending (`NVIDIA`, `McDonald's`, `Marvell Technology` for `Marvell Technology, Inc.`). A name that only contains the company (`McDonald's fan club`) does not count, nor one shorter than three letters. Added 2026-11-12: an eye check of tokens that resembled a listed stock by meaning found that real copies were mostly exactly this, and the two rules above let them through. | yes |
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
3. The pool holds at least **$10,000** of liquidity: as the chain reads it, where the chain read the pool; else (and
   for Uniswap v4 always) as the aggregator reports it.
4. There is a usable price for the token on its side of the pool: the chain's, where the chain read the pool; else the
   aggregator's (base side: `priceUsd`; quote side: GeckoTerminal's `quotePriceUsd`, else `priceUsd / priceNative`).

Of the pools that pass, the deepest one sets the price.

Why the pairing rule: a source's dollar price for a pool is the price of the *other* token carried across. Against a
stablecoin or WETH that is a market price. Against a memecoin it is circular. On Robinhood Chain memecoins are often
launched paired with a stock token, so their dollar price is derived from the stock token, and reading the stock token
back out of them returns a number unrelated to the share. Matching by address matters because a symbol such as `USDC`
is free to copy.

`pools.seen` counts every pool the sources listed or the chain read. `pools.eligible` counts the ones that passed.
`pools.capped` is true when DexScreener returned its maximum of 30 and GeckoTerminal could not show the end; the pool
book and the factories may still have found the rest. `pools.source` names the sources used: `dexscreener`,
`dexscreener+geckoterminal`, either with `+onchain`, or `onchain` alone when DexScreener could not be read.

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
| `pairs_unavailable` | DexScreener could not be read, and the chain priced no pool for the token |
| `no_pairs` | no pool lists the token |
| `no_eligible_pool` | pools exist, but none passes the rules above |
| `sources_disagree` | the chain and an aggregator priced the deepest pool more than 2% apart; `dex_price_usd` is the chain's |
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

<a id="evidence-rule"></a>
## Evidence rule

No evidence, no claim. Every positive statement an answer makes carries the field that lets you check it; where that
field is missing, the statement is `null`, not `true`. The tests run every kind of answer through this rule
(`evm/core/stocks/evidence-rule.mjs`), and a mutation lock proves they notice when evidence goes missing.

| Claim | Evidence | Without it |
|---|---|---|
| `listed`, `in_registry` | [`list_proof`](../reference/passport.md#field-list_proof): the issuer list, its SHA-256 and a command to recompute it | no verdict: `/verify` answers 503 |
| `minted: true` | the issuer's own supply field (Coinbase `total_supply`) | `minted: null`. Robinhood reports no supply, so nothing here says a Robinhood token is minted |
| `premium` | `latest.price_evidence`: the pool read at a block, with a command to repeat it ([how](#evidence-for-each-price)) | `price_evidence: { evidence: "none" }`: an aggregator alone priced it, so the premium is a figure with its source and time, not a proof |

The passport shows `latest.price_evidence` from 12.11. A reading recorded before the chain was read says
`evidence: "none"`. The matrix `gap` is a difference of two premiums: each side's evidence is in its passport.

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
- **Rate limits.** Per client address (an IPv6 client is keyed by its /56), 60 units in any 60 seconds, shared by `/api/*`,
  `/verify` and `/mcp`. A passport costs 3 units, and a `verify_stock_tokens` call of n addresses ⌈n/10⌉ units. Over the limit the answer is
  429 with `Retry-After: 60`. The proxy in front also caps bursts. `/badge.svg` is not limited per client, because
  image proxies fetch it from few addresses.
- **No SLA.** The site runs on one host. There is no uptime or freshness guarantee. Every answer carries its time, so
  you can tell when it is old.

[Not investment advice](../legal.md)
