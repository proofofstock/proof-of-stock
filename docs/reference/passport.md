# The passport answer

`v0.5.0 · updated 2026-11-12`

The passport is the answer to "what can be said, with its time and source, about this one token?". It is the body of
[`GET /api/passport`](./http-api.md#route-passport) and of the MCP tool [`stock_passport`](./tools.md#tool-stock_passport).
Machine-readable form: [`passport.schema.json`](./passport.schema.json) (draft-07), checked against real answers by
`node docs/reference/passport-schema.test.mjs`.

```bash
curl -s 'https://proofofstock.xyz/api/passport?chain=base&address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
```

```json
{
  "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "chain_id": 8453,
  "generated_at": "2026-11-10T15:00:00.000Z",
  "not_trading_signal": true,
  "market_now": { "session": "regular", "reason": "regular", "holiday": null, "early_close": false },
  "in_registry": true,
  "resembles": null,
  "issuer": {
    "name": "coinbase", "symbol": "NVDAc", "token_name": "NVIDIA", "isin": "US67066G1040", "minted": true,
    "multiplier": 1.011, "multiplier_pending": null, "paused": [],
    "rights": "set by the issuer's prospectus, not by the token contract"
  },
  "identity": { "symbol": "NVDAc", "name": "NVIDIA" },
  "reference": {
    "kind": "nav_total_return", "price_usd": 180, "updated_at": "2026-11-10T14:40:00Z", "age_s": 1200,
    "halted": null, "bid": null, "ask": null, "spread": null
  },
  "latest": {
    "observed_at": "2026-11-10T14:45:00Z", "dex_price_usd": 180.45, "dex_pool": "0xa1a1…a1a1",
    "premium": 0.0025, "premium_refused": null, "dex_inside_quote": null,
    "age_s": 900, "cadence_s": 900,
    "premium_at_reference_time": { "observed_at": "2026-11-10T14:45:00Z", "premium": 0.0025, "lag_s": 300 },
    "pools": {
      "seen": 4, "eligible": 1, "capped": false,
      "top": [{ "pair_address": "0xa1a1…a1a1", "dex_id": "uniswap", "quote_symbol": "USDC", "price_usd": 180.45,
                "side": "base", "liquidity_usd": 2000000, "volume_h24_usd": 500000 }]
    }
  },
  "series": {
    "window_h": 24, "readings": 3, "with_premium": 3, "first_at": "2026-11-09T20:00:00.000Z",
    "premium_all": { "n": 3, "median": 0.003, "p10": 0.0025, "p90": 0.004, "min": 0.0025, "max": 0.004 },
    "premium_by_session": {
      "regular": { "n": 3, "median": 0.003, "p10": 0.0025, "p90": 0.004, "min": 0.0025, "max": 0.004 }
    }
  },
  "notes": [],
  "chain": "base",
  "links": {
    "dex": "https://www.geckoterminal.com/base/pools/0xa1a1…a1a1",
    "explorer": "https://basescan.org/token/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "sources": { "registry": "https://api.coinbase.com/v1/tokenized-stocks", "...": "abridged: see sources" },
  "same_stock_elsewhere": [{ "chain": "robinhood", "symbol": "NVDA", "...": "see same_stock_elsewhere" }],
  "series_points": [[1794254400000, 0.003, "r"], [1794321000000, 0.004, "r"], [1794321900000, 0.0025, "r"]],
  "impostor_listing": null,
  "readings_loaded": true,
  "registry_age_s": 0
}
```

Addresses are shortened with `…` here only; the API always returns 42-character lower-case addresses.

## Contents

- [Units](#units)
- [Two shapes](#shapes)
- [Top level](#field-passport)
- [`market_now`](#field-market_now)
- [`issuer`](#field-issuer)
- [`identity`](#field-identity)
- [`reference`](#field-reference) and [reference kinds](#reference-kinds)
- [`latest`](#field-latest), [`premium`](#field-premium), [`premium_refused`](#field-premium_refused),
  [`premium_at_reference_time`](#field-premium_at_reference_time), [`pools`](#field-pools)
- [`series`](#field-series) and [`series_points`](#field-series_points)
- [`notes`](#field-notes)
- [`resembles`](#field-resembles) and [`impostor_listing`](#field-impostor_listing)
- [`same_stock_elsewhere`](#field-same_stock_elsewhere)
- [`links`](#field-links) and [`sources`](#field-sources)
- [`list_proof`](#field-list_proof): the issuer list the answer was decided against, and how to check it

<a id="units"></a>
## Units

| Quantity | Unit | Example |
|---|---|---|
| `premium`, `spread`, every value in `series` and `series_points` | fraction, not percent. `0.0025` = 0.25%. `premium > 0`: the on-chain price is above the issuer's reference | `0.0025` |
| `*_price_usd`, `bid`, `ask` | USD per **token** (not per share) | `180.45` |
| `age_s`, `*_age_s`, `lag_s`, `cadence_s`, `recorded_every_s` | seconds, integer. What each age is measured against is stated per field | `900` |
| `window_h` | hours | `24` |
| `*_at`, `generated_at` | ISO 8601 UTC | `2026-11-10T14:45:00Z` |
| `series_points[i][0]` | epoch milliseconds | `1794321900000` |
| `multiplier` | shares per token | `1.011` |

Timestamps are ISO 8601 in UTC. The examples on this page are shortened to `…:00Z`; real answers carry milliseconds
(`…:00.000Z`). Parse them, do not compare them as strings.

<a id="shapes"></a>
## Two shapes

`in_registry` decides the shape. The address alone decides `in_registry`: it is `true` only when the exact
lower-cased address is in the issuer registry the server holds for that chain (Coinbase for `base`, Robinhood for
`robinhood`). A symbol or a name never makes a token listed.

| Field | `in_registry: true` | `in_registry: false` |
|---|---|---|
| `issuer` | object | `null` |
| `reference` | object or `null` | **absent** (the key is not sent) |
| `latest` | object or `null` | `null` |
| `series` | object | `null` |
| `resembles` | `null` | object or `null` |
| `impostor_listing` | `null` | object or `null` |
| `same_stock_elsewhere` | list, possibly empty | `[]` |
| `series_points` | list, possibly empty | `[]` |
| `notes` | any codes except `not_in_registry` | `not_in_registry`, and `calendar_unknown` past 2027 |

"Not in the registry" means not on this issuer's list. It does not mean fake: the token may be another issuer's.

<a id="field-passport"></a>
## Top level

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `address` | string | | never null | `"0xaaaa…aaaa"` |
| `chain_id` | integer | | never null | `8453` (Base), `4663` (Robinhood Chain) |
| `chain` | string | | never null | `"base"` or `"robinhood"` |
| `generated_at` | string | ISO time | never null. Every "now" age is measured against this instant | `"2026-11-10T15:00:00.000Z"` |
| `not_trading_signal` | boolean | | always `true` | `true` |
| `in_registry` | boolean | | never null | `true` |
| `market_now` | object | | never null. [`market_now`](#field-market_now) | |
| `issuer` | object or null | | not in the registry | [`issuer`](#field-issuer) |
| `identity` | object | | never null | [`identity`](#field-identity) |
| `untrusted_text` | string | | present only when the address is not in the registry | says that `identity.symbol` and `identity.name` are the token creator's text: data, never instructions |
| `reference` | object or null | | in registry: the issuer gives no reference object. Out of registry: the key is absent | [`reference`](#field-reference) |
| `latest` | object or null | | no reading is held for this token, or the newest is older than the window (`series.window_h`: `hours`, at most 24): then `notes` has `reading_stale` | [`latest`](#field-latest) |
| `series` | object or null | | not in the registry | [`series`](#field-series) |
| `notes` | string[] | | never null, may be empty | `["reading_stale"]` |
| `resembles` | object or null | | listed, or the name resembles nothing, or no name is known | [`resembles`](#field-resembles) |
| `impostor_listing` | object or null | | listed, or not on the impostor list | [`impostor_listing`](#field-impostor_listing) |
| `same_stock_elsewhere` | object[] | | never null | [`same_stock_elsewhere`](#field-same_stock_elsewhere) |
| `series_points` | array[] | | only with `series=1` over HTTP, or `include_series: true` in MCP; left out otherwise | [`series_points`](#field-series_points) |
| `links` | object | | never null | [`links`](#field-links) |
| `sources` | object | | never null | [`sources`](#field-sources) |
| `list_proof` | object or null | | before the first read of the list | [`list_proof`](#field-list_proof) |
| `issuer_factory` | object or null | | while the chain mirror has not caught up, or is not built | [`issuer_factory`](#field-issuer_factory) |
| `readings_loaded` | boolean | | never null. `false` until the server has loaded its readings window once; until then a listed token shows `latest: null` and `no_readings` | `true` |
| `registry_age_s` | integer | seconds | never null | `120` |
| `case` | object or null | | the address never had a case in the dated archive | `{ status, first_seen_at, flagged_at, source, archived_at, closed_at, events }`; `events` is a count, the events themselves are at [`/api/history/cases`](./http-api.md#route-history) |

`registry_age_s` is seconds from the last successful registry read to `generated_at`. The server refreshes every 300 s
and keeps the last good copy when a refresh fails, so this number grows while the issuer's API is down. The passport
still answers from that copy, of any age; [`/verify`](./http-api.md#route-verify) refuses past 900 s. Check
`registry_age_s` before trusting `in_registry: false`.

<a id="field-market_now"></a>
## `market_now`

The US equity session (NYSE calendar, New York time) at `generated_at`. It describes the primary listing, not the
issuer: Robinhood quotes outside these hours.

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `session` | string | | never null. `pre` 04:00 to 09:30, `regular` 09:30 to 16:00 (13:00 on an early close), `post` to 20:00 (17:00), `closed`, `unknown` | `"regular"` |
| `reason` | string | | never null. `pre_market`, `regular`, `regular_early_close`, `after_hours`, `overnight`, `weekend`, `holiday`, `outside_calendar`, `not_a_time` | `"weekend"` |
| `holiday` | string or null | | not a holiday or early-close day | `"Thanksgiving Day"` |
| `early_close` | boolean | | never null | `false` |

The holiday table covers 2026 and 2027. A date outside it is `unknown`, never `regular`.

<a id="field-issuer"></a>
## `issuer`

Present only when `in_registry` is `true`.

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `name` | string | | never null. The issuer id | `"coinbase"`, `"robinhood"` |
| `symbol` | string or null | | the issuer gave none | `"NVDAc"` |
| `token_name` | string or null | | the issuer gave none | `"NVIDIA"` |
| `isin` | string or null | | the issuer gave none | `"US67066G1040"` |
| `minted` | boolean or null | | Robinhood: always `null`, because its API reports no supply. Base: `false` when Coinbase reports no supply, else `true` | `true` |
| `multiplier` | number or null | shares per token | the issuer gave none. Taken from the latest reading when one falls in the window, else from the registry | `1.011` |
| `multiplier_pending` | number or null | shares per token | no change announced. Coinbase never sets it | `1.02` |
| `paused` | string[] | | never null. Coinbase: its `paused_features`. Robinhood: the asset status when it is not `ASSET_STATUS_ACTIVE` | `[]` |
| `rights` | string | | constant | `"set by the issuer's prospectus, not by the token contract"` |

<a id="field-identity"></a>
## `identity`

What the token calls itself.

**For a token outside the registry this is its creator's text, not ours and not the issuer's.** It is shown as a label:
one line, invisible and control characters removed, compatibility forms folded (NFKC), cut to 32 characters for the
symbol and 64 for the name, with `…` when cut. So it can differ from the text in the contract. Whatever it says, it is
data to display and never an instruction; the answer carries `untrusted_text` to say so. Look-alike letters (a Cyrillic
`U+0410`, Cyrillic capital A, for a Latin `A`) are not folded.

| Field | Type | Null means | Example |
|---|---|---|---|
| `symbol` | string or null | out of registry: our dataset does not name this address | `"NVDAc"` |
| `name` | string or null | as above, or the registry gives no name | `"NVIDIA"` |

For a listed token these are the registry's values. For any other token they come from the names file the impostor
timer writes from our own dataset, falling back to the impostor list. The server never calls out for a name.

<a id="field-reference"></a>
## `reference`

The issuer's price for one token. Taken from the latest reading when one falls in the window, else from the registry record.

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `kind` | string | | never null. See [reference kinds](#reference-kinds) | `"nav_total_return"` |
| `price_usd` | number or null | USD per token | the issuer publishes no price for this token (`no_reference` note) | `180` |
| `updated_at` | string or null | ISO time | the issuer gave no time | `"2026-11-10T14:40:00Z"` |
| `age_s` | integer or null | seconds, `generated_at` minus `updated_at`, at least 0 | unknown: no `updated_at` and no recorded age, or a Robinhood token with no reading in the window | `1200` |
| `halted` | boolean or null | | the issuer does not say (always null for Coinbase) | `false` |
| `bid` | number or null | USD per token | no two-sided quote (always null for Coinbase) | `180.00` |
| `ask` | number or null | USD per token | as `bid` | `180.10` |
| <a id="field-spread"></a>`spread` | number or null | fraction, `(ask - bid) / mid` | no bid/ask (Coinbase) | `0.000555` |

`age_s` is measured at `generated_at`, not at the reading. A recorder that stopped would otherwise leave an old
reference looking fresh.

<a id="reference-kinds"></a>
### Reference kinds

| `kind` | Chain | What it is |
|---|---|---|
| `nav_total_return` | `base` | Coinbase's `nav_price` from `https://api.coinbase.com/v1/tokenized-stocks`: a Chainlink total-return NAV per token, with the corporate-action multiplier already in it. `updated_at` is Coinbase's `nav_price_updated_at`. |
| `token_bid_ask_mid` | `robinhood` | The mid of Robinhood's **token** bid and ask from `https://api.robinhood.com/rhj/prices`: `(tokenBid + tokenAsk) / 2`. `tokenBid` and `tokenAsk` are the share's quote times `currentMultiplier`, so per token. With multiplier 1 the mid equals the share's mid. If Robinhood stops sending them, the code scales the documented share `bid` / `ask` by `currentMultiplier` itself. `updated_at` is when the quote last changed, tracked by the recorder across runs; Robinhood's `generatedAt` is only when its server answered. |

Neither reference is multiplied again. The premium of a token with multiplier 1.011 is not shifted by 1.1%.

When a Robinhood token has no reading in the window, `reference` comes from the registry and its `updated_at` is Robinhood's
`generatedAt`: when Robinhood's server answered, not when the mid moved. Its `age_s` is therefore `null`, and neither
`reference_held_*` note can fire.

<a id="field-latest"></a>
## `latest`

The newest recorded reading for this token. The recorder runs every 900 s; this is a recorded reading, not a live quote.

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `observed_at` | string | ISO time | never null | `"2026-11-10T14:45:00Z"` |
| `dex_price_usd` | number or null | USD per token | no eligible pool | `180.45` |
| `dex_pool` | string or null | | no eligible pool | `"0xa1a1…a1a1"` |
| [`premium`](#field-premium) | number or null | fraction | refused, see `premium_refused` | `0.0025` |
| [`premium_refused`](#field-premium_refused) | string or null | | a premium was computed | `"no_eligible_pool"` |
| `dex_inside_quote` | boolean or null | | no bid/ask (Coinbase), a crossed quote, or no eligible pool | `false` |
| `age_s` | integer | seconds, `generated_at` minus `observed_at` | never null | `900` |
| `cadence_s` | integer | seconds | constant `900` | `900` |
| [`premium_at_reference_time`](#field-premium_at_reference_time) | object or null | | see below | |
| [`pools`](#field-pools) | object | | never null | |

`dex_inside_quote` is `true` when `bid <= dex_price_usd <= ask`. It is decided even when the premium is refused.

<a id="field-premium"></a>
### `premium`

```
premium = dex_price_usd / reference.price_usd - 1
```

`dex_price_usd` is the price of the deepest [eligible pool](#field-pools). Both prices are per token; no multiplier is
applied. `premium > 0` means the on-chain price is above the issuer's reference. A stale reference is not a refusal:
the premium is computed against it, and its age is in `reference.age_s` and in the notes.

<a id="field-premium_refused"></a>
### `premium_refused`

A null premium always carries exactly one reason. They are decided in this order; the first that applies wins.

| Value | When | `dex_price_usd` |
|---|---|---|
| `no_reference` | the issuer's `price_usd` is missing or not above 0 | set if a pool was eligible |
| `pairs_unavailable` | the DexScreener read failed and the chain priced no pool for the token | `null` |
| `no_pairs` | no source listed a pair | `null` |
| `no_eligible_pool` | pairs exist, none is [eligible](#field-pools) | `null` |
| `sources_disagree` | the chain and DexScreener or GeckoTerminal both priced the deepest eligible pool, and their prices for the token differ by more than 2% | set (the chain's) |
| `reference_spread_wide` | the issuer's `spread` is above `0.01` (1%) or below 0 (crossed) | set |

<a id="field-premium_at_reference_time"></a>
### `premium_at_reference_time`

The premium of one moment, for when `latest` and `reference` are far apart in time.

| Field | Type | Unit | Example |
|---|---|---|---|
| `observed_at` | string | ISO time of the reading used | `"2026-11-10T14:45:00Z"` |
| `premium` | number | fraction | `0.0025` |
| `lag_s` | integer | seconds, `observed_at` minus `reference.updated_at`, 0 to 1800 | `300` |

It is the first reading inside the window (`series.window_h`, set by `hours`), oldest first, whose `observed_at` is at
or after `reference.updated_at` and whose premium is not null, provided it falls within **1800 s** (two recorder runs)
after `reference.updated_at`. So `0 <= lag_s <= 1800`.

`null` when:

- `reference.updated_at` is null or unparsable;
- no priced reading in the window falls at or after `reference.updated_at`;
- the first one that does is more than 1800 s later. This covers a reference that last moved before the window began:
  the answer is `null`, never a reading from days later.

<a id="field-pools"></a>
### `pools`

| Field | Type | Null means | Example |
|---|---|---|---|
| `seen` | integer or null | the DexScreener read failed and the chain priced no pool | `4` |
| `eligible` | integer | never null | `1` |
| `capped` | boolean | never null. `true`: DexScreener returned its cap of 30 pairs, and GeckoTerminal was not asked in this run (its turn had not come, or the run was near its time limit), failed, or its last page was full too. The count is a minimum (`pools_capped`) | `false` |
| `topped_up_at` | string or null | for a full DexScreener list (`capped` from DexScreener): when GeckoTerminal last completed it, in this run or an earlier one; the pools it found then are read on the chain in between. `null` when never, or when the list was not full. |
| `top` | object[] | never null. The eligible pools, deepest first, at most 5 | |

A pool is **eligible** when all of these hold:

1. Its liquidity is at least **10,000 USD** (`MIN_POOL_LIQUIDITY_USD`): the pool's own balances read from the chain
   where the chain read it (the stock token's side at the issuer's reference price, or not counted when there is
   none), else (and for Uniswap v4 always) the aggregator's figure.
2. The token is on one side of the pair.
3. The other token is one of the chain's dollar stablecoins or its wrapped native token, **matched by address**, not
   by symbol. The addresses are listed in `sources.pools_counted.paired_with_addresses`. A pool against a memecoin is
   never eligible: that memecoin's dollar price is derived from the stock token itself.
4. The pool can price the token: from the chain (`slot0`, reserves, or Uniswap v4 `getSlot0`) where the chain read
   it; else on the base side, the pair's `priceUsd`; on the quote side, GeckoTerminal's `quotePriceUsd`, else
   `priceUsd / priceNative` (inversion).

How the chain is read, and the evidence each reading keeps, is in
[the methodology](../explanation/methodology.md#the-chain-as-a-source).

The deepest eligible pool by liquidity sets `dex_price_usd`, `dex_pool` and the premium.

Each entry of `top`:

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `pair_address` | string or null | | the source gave none | `"0xa1a1…a1a1"` |
| `dex_id` | string or null | | the source gave none | `"uniswap"` |
| `quote_symbol` | string or null | | the source gave none. The OTHER token of the pair, whichever side it is on | `"USDC"` |
| `price_usd` | number or null | USD per token | the pool cannot price the token | `180.45` |
| `side` | string | | may be absent on older readings. `base` or `quote`: which side our token is; `quote` is priced by inversion | `"base"` |
| `liquidity_usd` | number or null | USD | the source gave none | `2000000` |
| `volume_h24_usd` | number or null | USD | the source gave none | `500000` |

<a id="field-series"></a>
## `series`

Statistics of the premium over the window, split by the US session each reading fell in.

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `window_h` | number | hours | never null. `hours` from the request, clamped to 1..24 | `24` |
| `readings` | integer | | never null. Readings in the window | `3` |
| `with_premium` | integer | | never null. Of them, with a premium | `3` |
| `first_at` | string or null | ISO time | no reading in the window | `"2026-11-09T20:00:00.000Z"` |
| `premium_all` | stats | fraction | never null | |
| `premium_by_session` | object | | never null; a key appears only when a reading fell in that group | `{ "regular": {…} }` |

`premium_by_session` keys: `regular`, `extended` (pre and post), `closed`, `unknown`.

A stats object is `{ n, median, p10, p90, min, max }`. `n` counts the readings with a premium; the others are `null`
when `n` is 0. The quantile is the element at index `floor(q × n)` of the sorted values, so the median of an even count
is the upper of the two middle values.

<a id="field-series_points"></a>
## `series_points`

The premium time series for a chart: `[epoch_ms, premium_or_null, session]`, oldest first.

| Index | Type | Meaning |
|---|---|---|
| 0 | integer | epoch milliseconds of the reading |
| 1 | number or null | premium as a fraction; `null` for a refused reading |
| 2 | string | `r` regular, `e` extended, `c` closed, `u` unknown |

The server thins the 72 hours it holds evenly to at most 400 points, always keeping the newest (so up to 401), then
keeps only the points inside the window set by `hours` (at most 24). With `hours=24` you get the last 24 hours of that thinned
series. Not in the registry: `[]`.

The MCP tool `stock_passport` leaves `series_points` out unless the call sets `include_series: true`. `series` is
always there.

<a id="field-notes"></a>
## `notes`

Every gap in the answer is a code here. Codes appear in the order below, each at most once.

| Code | Exact trigger |
|---|---|
| `calendar_unknown` | `market_now.session` is `unknown`: `generated_at` is outside the 2026 to 2027 holiday table |
| `not_in_registry` | the address is not in the issuer registry for this chain |
| `not_minted` | listed on Base, and Coinbase reports no supply (`issuer.minted: false`). Never on Robinhood |
| `no_reference` | listed, and there is no reference or its `price_usd` is not above 0 |
| `reference_held_market_open` | a reference price exists, `market_now.session` is `regular`, and `reference.age_s > 1800` |
| `reference_held_market_closed` | a reference price exists, the session is anything but `regular` (pre, post, closed, unknown), and `reference.age_s > 3600` |
| `trading_halted` | `reference.halted` is `true` |
| `paused` | `issuer.paused` is not empty |
| `no_readings` | listed, not `not_minted`, and the server holds no reading of it from the last 72 h: never recorded, or the recorder stopped more than 72 h ago (Robinhood tokens included, though their `issuer.minted` is `null`) |
| `reading_stale` | `latest.age_s > 1800`: the recorder has missed two runs; `latest` is history. Past the window (`series.window_h`) `latest` is `null`: no price older than the window is shown |
| `no_dex_price` | `latest.premium` is null and `premium_refused` is `pairs_unavailable`, `no_pairs` or `no_eligible_pool` |
| `reference_spread_wide` | `latest.premium_refused` is `reference_spread_wide` |
| `sources_disagree` | `latest.premium_refused` is `sources_disagree`: the chain and an aggregator priced the deepest pool more than 2% apart. `latest.dex_price_usd` is the chain's price |
| `pools_capped` | `latest.pools.capped` is `true` |
| `multiplier_change_pending` | `multiplier_pending` is not null and differs from `multiplier` |

At most one of `no_reference`, `reference_held_market_open` and `reference_held_market_closed` appears.

<a id="field-resembles"></a>
## `resembles`

What the name of a token outside the registry imitates. A resemblance, not a verdict.

| Field | Type | Null means | Example |
|---|---|---|---|
| `kind` | string | never null | `"registry_symbol"` |
| `ticker` | string or null | no listed token could be named (`issuer_name_suffix` only) | `"NVDA"` |
| `registry_symbol` | string or null | as above | `"NVDAc"` |
| `registry_address` | string or null | as above. The official contract | `"0xaaaa…aaaa"` |

Kinds, strongest first; the strongest that fires is returned:

| `kind` | Fires when |
|---|---|
| `registry_symbol` | the symbol equals, case-sensitively, a listed symbol that is not just the bare ticker (Coinbase's `NVDAc`, not Robinhood's `NVDA`) |
| `issuer_name_suffix` | the name ends in "… Robinhood Token" and the registry is Robinhood's |
| `registry_name` | the whole name is a listed company's name, case, punctuation and corporate ending aside (`NVIDIA`, `McDonald's`) |
| `ticker` | the symbol equals a listed ticker ignoring case. Weak: many memecoins borrow a ticker |

`null` when: the token is listed; the server knows no symbol or name for the address; or the name matches none of the
kinds.

<a id="field-impostor_listing"></a>
## `impostor_listing`

| Field | Type | Null means | Example |
|---|---|---|---|
| `first_seen_at` | string or null | our dataset holds no first-seen time | `"2026-11-09T08:00:00.000Z"` |
| `same_deployer_impostors` | integer or null | the deployer is not known yet | `3`: three other listed impostors come from the same deployer |

Non-null only when the token is not listed and its address is on the chain's impostor list (`impostors.json`, written
every 6 hours). That list holds only the strong kinds, `registry_symbol`, `issuer_name_suffix` and `registry_name`. So a token can have
a `resembles` of kind `ticker` and `impostor_listing: null`, and a token first seen after the last list run has
`impostor_listing: null` while `resembles` already names it.

<a id="field-same_stock_elsewhere"></a>
## `same_stock_elsewhere`

The same security on every other chain whose registry is loaded, matched by **ISIN**, never by symbol. Two tokens with
one ISIN are claims on the same share from different issuers on different terms; compare their premiums, not their
prices.

| Field | Type | Unit | Null means | Example |
|---|---|---|---|---|
| `chain` | string | | never null | `"robinhood"` |
| `issuer` | string | | never null | `"robinhood"` |
| `symbol` | string or null | | the issuer gave none | `"NVDA"` |
| `name` | string or null | | the issuer gave none | `"NVIDIA  Robinhood Token"` (Robinhood's own text, double space included) |
| `address` | string | | never null | `"0xcccc…cccc"` |
| `multiplier` | number or null | shares per token | the issuer gave none | `1` |
| `latest` | object or null | | no reading of that token in the passport's window: as with the passport's own `latest`, no price older than the window is shown | |

`latest` here is compact:

| Field | Type | Unit | Example |
|---|---|---|---|
| `observed_at` | string | ISO time | `"2026-11-10T14:45:00Z"` |
| `premium` | number or null | fraction, over that token's own issuer reference | `0.0025` |
| `premium_refused` | string or null | | `null` |
| `dex_price_usd` | number or null | USD per token | `180.5` |
| `reference_price_usd` | number or null | USD per token | `180.05` |
| `reference_age_s` | integer or null | seconds before `generated_at`: from the reference's `updated_at` when known, otherwise the age recorded at the reading plus the reading's own age | `960` |
| `liquidity_usd` | number or null | USD, the deepest pool | `50000` |
| `halted` | boolean or null | | `false` |

`[]` when the token is not listed, has no ISIN, or no other chain lists that ISIN.

<a id="field-links"></a>
## `links`

| Field | Type | Null means | Example |
|---|---|---|---|
| `dex` | string | never null. GeckoTerminal: the deepest pool when the token is listed and has one, else the token page | `"https://www.geckoterminal.com/base/pools/0xa1a1…a1a1"` |
| `explorer` | string or null | the chain has no explorer configured | `"https://basescan.org/token/0xaaaa…aaaa"` |

An impostor gets the same links. Robinhood Chain's explorer is `https://robinhoodchain.blockscout.com`.

<a id="field-sources"></a>
## `sources`

Where every number comes from, per chain.

| Field | Type | Example |
|---|---|---|
| `registry` | string (URL) | `"https://api.coinbase.com/v1/tokenized-stocks"` or `"https://api.robinhood.com/rhj/assets"` |
| `reference` | string | `"Coinbase NAV per token (nav_price, total return), from the same registry"` |
| `dex` | string | `"the pools on the chain itself, read at one block, with DexScreener token-pairs (completed from GeckoTerminal when DexScreener lists 30); where both see a pool, the price and liquidity read from the chain are used"` |
| `recorded_every_s` | integer | `900` |
| `pools_counted.min_liquidity_usd` | number | `10000` |
| `pools_counted.paired_with_addresses` | string[] | Base: USDC `0x8335…2913`, `0xd9aa…b6ca`, `0x50c5…f0cb` and WETH `0x4200…0006` |
| `pools_counted.rule` | string | the eligibility rule in words |

<a id="field-issuer_factory"></a>
## `issuer_factory`

Did the issuer's own token factory create this contract? Each issuer deploys its stock tokens from a factory that logs
one event per token: Coinbase's on Base, Robinhood's on Robinhood Chain. We read those events from the chain every 15
minutes (`scripts/stocks/issuer-mirror.mjs`). This is a second source beside the issuer's list, never the list itself:
the factory also made tokens the list leaves out (tests, delisted, not yet listed), so `created: true` does not mean
listed. `/verify` and MCP verify carry the same object, also when the list cannot be read (then with status 503 and no
`listed`).

| Field | Type | Meaning |
|---|---|---|
| `created` | boolean | `true`: the factory's event names this contract. `false`: no event of the factory names it, up to `checked_to_block` |
| `source` | string | says what this is: the factory on chain, a second source, not the list |
| `factory` | address | the factory read |
| `checked_to_block` | integer | the last block read; a token created after it is not seen yet |
| `as_of` | ISO time or null | when the mirror last read the chain |
| `block`, `tx`, `log_index` | only when `created` | the factory's event: anyone can find it on the explorer |

<a id="field-list_proof"></a>
## `list_proof`

The issuer list this answer was decided against, stamped so you can check it yourself instead of taking our word. The same
object rides on `GET /verify` and on MCP `verify_stock_tokens` (once per answer, for the whole batch). `null` before
the server has read the list once.

The lists are JSON from the issuers' APIs, not chain state, so there is no block number to cite, and the raw bytes change
every few minutes because prices travel in the same body. What does not change while the issuer keeps the same tokens is
the set of addresses, so that is what is hashed.

| Field | Type | Example |
|---|---|---|
| `issuer` | string | `"coinbase"` |
| `source` | string (URL) | `"https://api.coinbase.com/v1/tokenized-stocks?page_size=500"` |
| `addresses` | integer | `338` |
| `addresses_sha256` | string | SHA-256 (hex) of the list's contract addresses, lowercase, sorted bytewise, one per line, each line ending in a newline |
| `registry_hash` | string | `"sha256:…"`: the canonical hash of the whole list (address, symbol, name, ISIN, multiplier, supplied, paused), the one the archive uses |
| `reproduce` | string or null | a shell command that computes `addresses_sha256` from the issuer |
| `reproduce_unavailable` | string or null | why there is no command, when there is none (a Coinbase list longer than one page of 500) |
| `read_at` | string | when this server read the list |
| `stale` | boolean | `true`: the latest read failed and this is the last good list |
| `ledger` | string (URL) | `/api/history/registry?chain=…`: every change of the list, each row naming the hash before it (`prev_hash`) |
| `list_url` | string (URL) | [`/api/list/<hex>`](./http-api.md#route-list): the exact list this verdict used, by its `registry_hash`. Its SHA-256 is `registry_hash` |
| `addresses_url` | string (URL) | `/api/list/<hex>/addresses`: its addresses, one per line. Their SHA-256 is `addresses_sha256` |
| `note` | string | the same in words |

To check a verdict, run `reproduce` (it needs `curl`, `jq` and `sha256sum`; on macOS use `shasum -a 256`):

```sh
curl -fsS 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500' | jq -r '.tokens[].contract_address' \
  | tr -d '\r' | tr 'A-F' 'a-f' | LC_ALL=C sort | sha256sum
```

The digest equals `addresses_sha256` while the issuer's list is unchanged; then look for the address in the same list.
After the list has changed, `list_url` still serves the exact list the verdict used: `curl -fsS <list_url> | sha256sum`
prints `registry_hash`, and `curl -fsS <addresses_url> | grep <address>` shows whether the address was on it.
A different digest means the issuer has added or removed a token since `read_at`, and the archive at `ledger` shows what
changed. `registry_hash` moves also when a token's name, multiplier or pause changes while `addresses_sha256` does not. Robinhood's
API reports no supply, so for Robinhood `supplied` is always `true` in that hash and says nothing.

The archive is written by the price recorder's own read every 15 minutes, apart from this server's read every 5, so a list
this server has just read appears there, with the same `registry_hash`, once the recorder has read it too.

What this does not prove: that the issuer's API told the truth, or that it told everyone the same. It proves which list
the verdict used and lets anyone compare it with the issuer's list now.

[Not investment advice](../legal.md)
