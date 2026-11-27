# HTTP API

Read-only JSON routes on `https://proofofstock.xyz`. No key, no account, no cookies. (`GET /api/hit` is the site's
own visit counter, [What we count](../legal.md#what-we-count); it answers 204 and is not for integrations.)

Every call with its price, the MCP tools and the paid pass on one page: [proofofstock.xyz/api](https://proofofstock.xyz/api).

```bash
curl -s 'https://proofofstock.xyz/verify?chain=base&address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
```

```json
{
  "listed": true, "registries_checked": ["coinbase:base"], "chain": "base",
  "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "issuer": "coinbase", "symbol": "NVDAc", "name": "NVIDIA", "isin": "US67066G1040", "minted": true,
  "listed_on_other_chain": null, "impostor": null, "delisted_at": null,
  "registry_age_s": 120, "checked_at": "2026-11-10T15:00:00.000Z",
  "passport": "https://proofofstock.xyz/?base=NVDAc", "case": null
}
```

- [Basics](#basics)
- [`GET /verify`](#route-verify)
- [`GET /badge.svg`](#route-badge)
- [`GET /api/find`](#route-find)
- [`GET /api/passport`](#route-passport)
- [`GET /api/overview`](#route-overview)
- [`GET /api/impostors`](#route-impostors)
- [`GET /api/history/cases` and `/api/history/registry`](#route-history)
- [`GET /api/archive/at`](#route-archive-at)
- [`GET /api/list/<hex>`](#route-list)
- [`GET /api/matrix`](#route-matrix)
- [`GET /api/status`](#route-status)
- [`GET /api/exam`](#route-exam)
- [`GET /anchors/`](#route-anchors)
- [`GET /tokenlist.json`](#route-tokenlist)
- [`GET /denylist.json`](#route-denylist)
- [The agent test](#route-agent-test)
- [Paid passes (x402)](#paid-passes)
- [Monitoring](#monitoring)

<a id="basics"></a>
## Basics

| | |
|---|---|
| Base URL | `https://proofofstock.xyz`. The proxy maps the domain's `/` onto the app's `/stocks/`, so `/api/find` here is `/stocks/api/find` in the app |
| Methods | `GET` and `HEAD`, except `POST` on [the agent test](#route-agent-test) and on [`/mcp`](./tools.md). Any other method is refused by the proxy (403) |
| Rate limit | 60 units in any 60 seconds per client IP (IPv6: per /56) across `/verify`, `/api/*` and `/mcp` together. A request costs 1 unit; `/api/passport` costs 3. The window slides by the second, so it is the same wherever a minute begins, and a refused request costs nothing. Over it: 429, `{ "error": "too many requests, try again in a minute" }`, `Retry-After: 60` (where paid passes are on, the refusal is instead a [402 that offers the pass](#paid-passes)). The proxy also caps 10 requests per second (burst 40) and 20 open connections per IP |
| Not rate limited by the app | `/badge.svg`, `/tokenlist.json`, `/denylist.json`, `/anchors/`, the [agent test](#route-agent-test) (it has limits of its own), the pages and their assets |
| Errors | JSON `{ "error": "<words>" }`. 400 bad input, 404 unknown path (`{ "error": "not found" }`), 503 no verdict (a registry not loaded yet or stale, a record [held by the list locks](#route-verify), or the [kill switch](#kill-switch)), 500 `{ "error": "internal error" }`. Error texts are fixed public sentences; internal causes are never returned |
| Freshness | Every answer comes from memory. The server rereads the issuer registries and the readings every 300 s; nothing on the request path calls out |
| Units | as in the [passport](./passport.md#units): premium and spread are fractions, prices USD per token, ages integer seconds |
| `chain` | `base` (Coinbase registry, chain id 8453) or `robinhood` (Robinhood registry, chain id 4663) |
| `address` | `0x` and 40 hex characters, any case; answers use lower case |

Every answer carries `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin` and `X-Frame-Options: DENY`.

<a id="kill-switch"></a>
**The kill switch.** A Cloudflare Worker outside our host compares, once a minute, the list our server decides against
with each issuer's own list. If our server would call listed something the issuer does not list, it trips, and until
the owner clears it by hand every verdict route answers `503` from the switch: `/verify`, `/api/*`, `/mcp`,
`/badge.svg`, `/tokenlist.json`, `/denylist.json` and `/agent-test/*`. Treat that `503` like any other: no answer, never
"not listed". How it works and what trips it: [`deployment/KILLSWITCH.md`](https://github.com/proofofstock/proof-of-stock/blob/main/deployment/KILLSWITCH.md).

Other public paths: `/` (the page; `/?base=NVDAc` and `/?chain=base&address=0x…` open one token), `/demo` (the Demo
Agent: an agent's search and buy, run live in the browser, with nothing signed), `/agent-test` (the agent test, for
people), `/docs/`,
`/docs/changelog.md`, `/llms.txt`, `/llms-full.txt`, and the MCP server at [`/mcp`](./tools.md).

---

<a id="route-verify"></a>
## `GET /verify`

Is this exact address on the issuer's registry for this chain? Also served at `/api/verify`.

```bash
curl -s 'https://proofofstock.xyz/verify?chain=base&address=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
```

```json
{
  "listed": false, "registries_checked": ["coinbase:base"], "chain": "base",
  "address": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "issuer": null, "symbol": null, "name": null, "isin": null, "minted": null,
  "listed_on_other_chain": null,
  "impostor": { "kinds": ["registry_symbol"], "imitates_symbol": "NVDAc", "listed_address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "delisted_at": null, "registry_age_s": 120, "checked_at": "2026-11-10T15:00:00.000Z",
  "issuer_factory": { "created": false, "factory": "0xbbbb…bbbb", "checked_to_block": 57022434, "as_of": "2026-11-10T15:00:00.000Z" },
  "case": null,
  "passport": "https://proofofstock.xyz/?chain=base&address=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
}
```

| Parameter | Required | Constraint |
|---|---|---|
| `chain` | yes | `base` or `robinhood` |
| `address` | one of the two | `0x` + 40 hex |
| `addresses` | one of the two | 1 to 50 addresses free, comma-separated, each `0x` + 40 hex. Costs ⌈n/10⌉ units of the rate limit, as MCP `verify_stock_tokens` does. 51 to 150 with a [paid pass](#paid-passes): without one the answer is the pass's 402, saying why; the verdicts are the same either way. More than 150 is a 400 (the batch is a GET, and 150 addresses are what fits the proxy's request line) |
| `receipt` | no | `1`: with `address`, add a `receipt` to keep, never cached. See [Keep a receipt of a check](../how-to/keep-a-receipt.md) |

With `addresses` the answer is `{ chain, count, listed, impostors, results[], list_proof }`: one result per address, in
the order given, all decided against one read of the list, and one `list_proof` for the batch. `address` and
`addresses` together, an empty list, more than 50 or a malformed address are a 400 that says which.

The fields are documented under [`verify_stock_tokens`](./tools.md#tool-verify_stock_tokens). `listed: false` means
"not in this issuer's registry", never "fake".

An address that starts like the issuer's own (every Coinbase stock token starts `0xb2` and twenty zeros, and so can
other tokens on Base) carries `issuer_like_address`: a note that it is not on the list all the same. The start of an
address proves nothing.

Every answer also carries `list_proof` (left out of the example above): the issuer list the verdict was decided against,
its SHA-256 and a command that computes the same digest from the issuer, so you can check the verdict without trusting
us. See [`list_proof`](./passport.md#field-list_proof).

`issuer_factory` is the second source beside the list: whether the issuer's own token factory on the chain created
this contract, read from our chain mirror. `created: true` carries the `block`, `tx` and `log_index` of the factory's
event; `created: false` carries the `checked_to_block` it was checked to; the whole field is `null` while the mirror
is catching up. Fields: [`issuer_factory`](./passport.md#field-issuer_factory).

**The list locks.** A record on the issuer's list counts as listed only when the chain backs it: the issuer's factory
created that address, read from finalized blocks, and on Base a second RPC confirms it and the address carries
Coinbase's pinned prefix `0xb200000000000000000000`. A record that fails is held: no verdict, a `503` with a `reason`
(table below), never `listed: true` and never `listed: false`. A genuine new listing therefore becomes listed some
minutes after its creation, not at once. The other way round, a contract the factory made that the issuer does not list
is still not listed. With `addresses`, one held address fails the whole batch with its `503`, naming it. The rule:
[methodology](../explanation/methodology.md#how-issuer-listed-is-decided).

| Status | Body | Headers |
|---|---|---|
| 200 | the result | `Cache-Control: public, max-age=300` when listed, `max-age=60` otherwise; `Access-Control-Allow-Origin: *` |
| 400 | `chain must be one of base, robinhood` or `address must be 0x followed by 40 hex characters` | CORS |
| 503 | `{ "error": "registry unavailable", "registries_checked", "chain", "address", "registry_age_s", "checked_at" }`: the registry was never read, or was read more than 900 s ago | `Cache-Control: no-store`, `Retry-After: 60`, CORS |
| 503 | `{ "error": "no verdict: the issuer list names this address, but the chain does not back it", "reason", "held_since", "registries_checked", "chain", "address", "registry_age_s", "checked_at", "issuer_factory" }`: the record is held by the list locks. `reason` is `issuer_prefix_mismatch` (on Base, no pinned prefix), `factory_check_unavailable` (no factory mirror we trust), `factory_conflict` (the factory never created it, or the chain took a creation back) or `awaiting_factory_confirmation` (a new listing not yet seen created, or not yet confirmed by the second RPC). `held_since` is when the address first appeared on the issuer's list, or null | `Cache-Control: no-store`, `Retry-After: 60`, CORS |
| 503 | from the [kill switch](#kill-switch), while it is tripped | |
| 429 | rate limit | `Retry-After: 60`, CORS |

A registry the server cannot read, or a record it holds, is never answered `listed: false`.

---

<a id="route-badge"></a>
## `GET /badge.svg`

The verify answer as an image for other pages. It prints the address it vouches for and the time it was checked, so it
cannot be moved onto a page about another token. It never shows a price, has no script and no link.

```html
<a href="https://proofofstock.xyz/?chain=base&address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
  <img src="https://proofofstock.xyz/badge.svg?chain=base&address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
       alt="Proof of Stock registry check" height="40">
</a>
```

| Parameter | Required | Constraint |
|---|---|---|
| `chain` | yes | `base` or `robinhood` |
| `address` | yes | `0x` + 40 hex |

| State | Colour, mark | Headline | `Cache-Control` |
|---|---|---|---|
| `listed` | green, ✓ | `Issuer-listed · NVDAc · Coinbase` | `public, max-age=300` |
| `impostor` | red, ✗ | `Imitates NVDAc`, or `Copies the issuer's naming` | `public, max-age=60` |
| `not_listed` | grey, • | `Not in the Coinbase registry` | `public, max-age=60` |
| `unavailable` | amber, ? | `Registry unavailable` | `no-store` |

`impostor` is shown only for the strong kinds (`registry_symbol`, `issuer_name_suffix`, `registry_name`). `unavailable` covers a
registry never read or older than 900 s, an unknown chain and a malformed address. The second line is
`0xaaaa…aaaa · checked 2026-11-10 15:00Z · proofofstock.xyz`.

The status is **always 200** with `Content-Type: image/svg+xml; charset=utf-8` and `Access-Control-Allow-Origin: *`:
a broken image on someone else's page would read as an outage. Read the state from the image, or call
[`/verify`](#route-verify) for the status code.

---

<a id="route-find"></a>
## `GET /api/find`

Issuer-listed tokens matching a ticker, company name or ISIN, on every loaded chain unless one is named.

```bash
curl -s 'https://proofofstock.xyz/api/find?q=nvda'
```

```json
{
  "match": "exact", "reason": null,
  "matches": [
    { "chain": "base", "issuer": "coinbase", "symbol": "NVDAc", "name": "NVIDIA", "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "isin": "US67066G1040", "match_quality": "exact", "has_reference_price": true, "minted": true },
    { "chain": "robinhood", "issuer": "robinhood", "symbol": "NVDA", "name": "NVIDIA  Robinhood Token", "address": "0xcccccccccccccccccccccccccccccccccccccccc",
      "isin": "US67066G1040", "match_quality": "exact", "has_reference_price": true, "minted": null }
  ],
  "more": 0,
  "missing": []
}
```

| Parameter | Required | Constraint |
|---|---|---|
| `q` | yes | trimmed, cut to 64 characters, case-insensitive |
| `chain` | no | `base` or `robinhood`; omitted: every loaded chain |

Matching is the same as [`find_stock_token`](./tools.md#tool-find_stock_token): exact ticker or ISIN first, and only
exact matches when any exist; otherwise name-word and prefix matches with `match_quality`; otherwise `matches: []`
with `reason`. At most 25 matches; `more` counts the rest. `missing` lists chains whose registry has not loaded yet.

| Status | When |
|---|---|
| 200 | `Cache-Control: public, max-age=60` |
| 400 | unknown `chain`; empty `q` (`q is required`) |
| 503 | no registry loaded yet, or the named chain's is not; `Retry-After: 30` |

---

<a id="route-passport"></a>
## `GET /api/passport`

The [passport](./passport.md) of one address. Schema: [`passport.schema.json`](./passport.schema.json).

```bash
curl -s 'https://proofofstock.xyz/api/passport?chain=base&address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&hours=24'
```

| Parameter | Required | Constraint |
|---|---|---|
| `chain` | yes | `base` or `robinhood` |
| `address` | yes | `0x` + 40 hex |
| `hours` | no | window of `series`, `series_points` and `premium_at_reference_time`. Clamped to 1..24; missing, 0 or not a number means 24. Unlike the MCP tool, out-of-range values are clamped, not refused |

`series_points` (the chart) is included only with `series=1`. A passport costs 3 units of the limit, so 20 passports in any 60 seconds per client.

| Status | Body | Headers |
|---|---|---|
| 200 | the passport | `Cache-Control: public, max-age=60` |
| 400 | `chain must be one of base, robinhood`, or `address must be 0x followed by 40 hex characters` | |
| 503 | `{ "error": "the issuer registry is not loaded yet", "detail": "the issuer registry could not be read" or null }` | `Retry-After: 30` |
| 503 | `{ "error": "no verdict: the issuer list names this address, but the chain does not back it", "reason", "held_since", "chain", "address", "issuer_factory", "registry_age_s" }`: a record held by the [list locks](#route-verify), with the same `reason` values as `/verify`. There is no `in_registry` in it, never `false` | |

The chain is checked first, then whether the registry is loaded, then the address: a bad address while the registry
is loading answers 503.

---

<a id="route-overview"></a>
## `GET /api/overview`

Per chain, the issuer tokens whose on-chain price sits furthest from the issuer's reference right now.

```bash
curl -s 'https://proofofstock.xyz/api/overview?chain=base'
```

```json
{
  "market_now": { "session": "regular", "reason": "regular", "ny_date": "2026-11-10", "holiday": null, "early_close": false },
  "chains": {
    "base": {
      "issuer": "coinbase", "listed": 2, "minted": 1, "priced": 1, "unpriced": 0, "stale": 0,
      "rows": [{
        "symbol": "NVDAc", "name": "NVIDIA", "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "isin": "US67066G1040",
        "observed_at": "2026-11-10T14:45:00Z", "premium": 0.0025, "premium_refused": null,
        "dex_price_usd": 180.45, "reference_price_usd": 180, "reference_age_s": 1200,
        "liquidity_usd": 2000000, "halted": null
      }],
      "as_of": "2026-11-10T15:00:00.000Z",
      "newest_reading_at": "2026-11-10T14:45:00.000Z"
    }
  },
  "missing": []
}
```

| Parameter | Required | Constraint |
|---|---|---|
| `chain` | no | `base` or `robinhood`; omitted: every loaded chain |

Per chain:

| Field | Type | Meaning |
|---|---|---|
| `issuer` | string or null | the registry's issuer |
| `listed` | integer | tokens on the issuer's list for this chain |
| `minted` | integer or null | of them, the tokens with supply on this chain: only these have a price to read. Null when the issuer reports no supply (Robinhood) |
| `priced` | integer | tokens with a current reading that has a premium |
| `unpriced` | integer | tokens with a current reading and no premium. Counted, never ranked |
| `stale` | integer | tokens whose latest reading is older than 1800 s. Counted, never ranked |
| `rows` | object[] | at most 12 of the priced, largest absolute premium first |
| `as_of` | string or null | when the server last loaded the readings |
| `newest_reading_at` | string or null | the newest reading of any token on the chain |

Tokens with no reading at all are in none of the counts. In `rows`, `reference_age_s` is the reference's age now: from
its `updated_at` when known, otherwise the age recorded at the reading plus the reading's own age. `market_now` here also carries `ny_date`.

| Status | When |
|---|---|
| 200 | `Cache-Control: public, max-age=60` |
| 400 | unknown `chain` |
| 503 | no registry loaded, or the named chain's is not; `Retry-After: 30` |

---

<a id="route-impostors"></a>
## `GET /api/impostors`

Per chain, tokens outside the registry whose symbol or name claims an issuer token. A claim with evidence, not a
verdict. The list is written every 6 hours.

```bash
curl -s 'https://proofofstock.xyz/api/impostors?chain=base&limit=5'
```

```json
{
  "chains": {
    "base": {
      "generated_at": "2026-11-10T12:00:00Z",
      "counts": { "registry_symbol": 1, "issuer_name_suffix": 0, "registry_name": 0, "ticker": 0 },
      "listed": 1,
      "note": "Tokens outside the issuer registry whose symbol or name claims an issuer token. A claim with evidence, not a verdict.",
      "items": [{
        "address": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "symbol": "NVDAc", "name": "NVIDIA", "kind": "registry_symbol",
        "ticker": "NVDA", "registry_symbol": "NVDAc", "registry_address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "first_seen_at": "2026-11-09T08:00:00.000Z", "same_deployer_impostors": 3
      }]
    }
  }
}
```

| Parameter | Required | Constraint |
|---|---|---|
| `chain` | no | `base` or `robinhood`; omitted: both |
| `limit` | no | items per chain, 1..50, default 30 |

| Field | Meaning |
|---|---|
| `counts` | tokens per resemblance kind, `ticker` included. Only `registry_symbol`, `issuer_name_suffix` and `registry_name` are listed in `items` |
| `listed` | items in the file (capped at 20,000) |
| `items` | tokens first seen in the last 7 days, strongest kind first, then newest `first_seen_at`; at most 50 |
| `window_days`, `in_window`, `older` | the list's window (7), how many fall in it, and where the rest is |

A chain with no list yet answers `{ "error": "not generated yet" }` in its slot, not an empty list.
`Cache-Control: public, max-age=300`. 400 for an unknown `chain`.

---

<a id="route-list"></a>
## `GET /api/list/<hex>`

An issuer list by its hash: the list a verdict was decided against (`list_proof.list_url`), still there after the issuer
has changed its list. `<hex>` is `registry_hash` without `sha256:`.

```bash
curl -fsS https://proofofstock.xyz/api/list/<hex> | sha256sum                 # prints <hex>
curl -fsS https://proofofstock.xyz/api/list/<hex>/addresses | sha256sum       # prints addresses_sha256
```

| Path | Body |
|---|---|
| `/api/list/<hex>` | the exact bytes `registry_hash` names: JSON of the canonical list (address, symbol, name, ISIN, multiplier, multiplier_pending, supplied, paused), sorted by address |
| `/api/list/<hex>/addresses` | `text/plain`, the addresses, lowercase, sorted, one per line |

It serves the lists this server read lately and every list in the archive (`/api/history/registry`). Before an answer
leaves, the server hashes it again; bytes that do not hash to their name are never served.

| Status | Body | Headers |
|---|---|---|
| 200 | the list | `Cache-Control: public, max-age=31536000, immutable`, CORS |
| 404 | `no list with this hash: neither read recently nor in the archive` | `max-age=60` |
| 429 | over the rate limit (1 unit, like any API read) | `Retry-After: 60` |
| 500 | `internal error`: a stored list did not hash to its name | `no-store` |

<a id="route-archive-at"></a>
## `GET /api/archive/at`

What one address was on one day, from what was recorded then. Free, 1 unit of the limit.

```bash
curl -s 'https://proofofstock.xyz/api/archive/at?chain=base&address=0x77d1db15e423762aff479ecd67c49bf6bdbf4ba3&date=2026-11-15'
```

| Parameter | Required | Constraint |
|---|---|---|
| `chain` | yes | `base` or `robinhood` |
| `address` | yes | `0x` + 40 hex |
| `date` | yes | `YYYY-MM-DD`, a real calendar day (2026-02-30 is a 400, never another day), not in the future |

The answer has `summary` (one plain sentence), `attestation` and `how_to_check`. `attestation` holds:

- `verdict_on_date`: `listed` (on the issuer's list: that decides, even if a case was still open), `impostor` (not listed and an open look-alike case that day), `not_listed`, or `unknown` when no issuer list was recorded for that day;
- `list`: the issuer list in force at the end of that day (UTC), by `registry_hash`, `in_force_since`, `addresses_sha256` and the URLs of that exact list frozen (`/api/list/<hex>`);
- `case`: the look-alike case as it stood at the end of the day (`open` with what it imitated and what the contract said, `closed` with `gone_reason`, `listed_by_issuer`, or `none`);
- `anchors`: the anchor of the day the list was recorded and of the day asked, each a manifest SHA-256 in Bitcoin and its mirror transactions. A day is anchored the night after it, so `anchors.date` is null until then and appears later;
- `partial: true` when the day asked is today: the answer is as of now and may change before midnight UTC;
- `sha256`: the SHA-256 of the attestation's canonical JSON (keys sorted, without this field). For a past day whose anchor exists, the same question gives the same bytes. Nothing is signed; it is checkable through the hashes.

It answers one address and one day. There is no range, no list of addresses and no cursor: the archive is a window,
not a download.

---

<a id="route-history"></a>
## `GET /api/history/cases` and `GET /api/history/registry`

The dated archive (`/history` is the same for people). **A list shows the last 7 days of observed events, at most 50 rows; cases archived from the collector's earlier history are not listed.** Any one address keeps its whole case in `/verify` and `/api/passport` (`case`), and the counts cover the whole archive. The full archive is available on request: hello@proofofstock.xyz. Every row is appended and never rewritten. A case is one
address outside the registry that claimed an issuer token; each change of it is an event: `opened`, `kind_changed`,
`listed` (the issuer later listed that address) or `gone` (the case closed). A `gone` event carries `gone_reason`:
`imitated_left_list` when the listed stock it imitated left the issuer's list, `rule_narrowed` when our rule was narrowed and no longer holds the case (26 Nov 2026: a one-word company name now needs the symbol to back it; the token did not change), `no_longer_matches` otherwise. Closes
recorded before 19 Nov 2026 get it from the registry archive at the time of the close. The archive began on 10 Nov 2026; cases
the collector had seen before then are archived with `source: "backfilled"`, their collector `first_seen_at` and no
`flagged_at`, because we did not flag them at the time.

```bash
curl -s 'https://proofofstock.xyz/api/history/cases?chain=base&event=listed'
curl -s 'https://proofofstock.xyz/api/history/registry?chain=base&date=2026-11-10'
```

```json
{
  "chain": "base", "archive_started_at": "2026-11-10T18:23:00.000Z",
  "counts": { "open": 1, "opened": 2, "listed": 1, "gone": 0, "kind_changed": 0, "backfilled": 1 },
  "count": 1, "error": null,
  "events": [{
    "event": "listed", "at": "2026-11-10T18:23:00.000Z", "source": "observed",
    "address": "0xdddddddddddddddddddddddddddddddddddddddd", "symbol": "AAPLc", "name": null, "kind": "registry_symbol",
    "imitates_symbol": "AAPLc", "listed_address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "first_seen_at": null, "flagged_at": null
  }]
}
```

| Parameter | Route | Constraint |
|---|---|---|
| `chain` | both | `base` or `robinhood`; omitted: every chain, under `chains` |
| `event` | cases | `opened`, `kind_changed`, `listed` or `gone` |
| `since` | cases | an ISO time; events at or after it |
| `limit` | cases | 1..50, default 50: the newest events. There is no paging; `count` says how many the window holds, and `since` and `event` narrow it |
| `date` | registry | `YYYY-MM-DD`, needs `chain`: the snapshot in force at the end of that UTC day, with its full list |

Without `date`, `/api/history/registry` lists the snapshots (`fetched_at`, `hash`, `prev_hash`, `records`, and how
many addresses were `added`, `removed` or `changed`), newest first. A snapshot is written only when the registry
changed, so the one in force on a day can be older than the day. A day before the archive answers `snapshot: null`
with the reason.

In `/api/history/cases` and `/api/impostors` the `symbol` and `name` of a token are its creator's text, published as
labels (one line, cut to 32 and 64 characters, see [`identity`](./passport.md#field-identity)); each answer carries
`untrusted_text` to say they are data, never instructions.

<a id="field-text_evidence"></a>
### `text_evidence`: what the contract itself said

An observed event that opens a case or changes its kind carries `text_evidence`: the contract's own `symbol()` and
`name()`, read at one block when the event was written. It is what makes "this token calls itself NVDAc" checkable
against the chain rather than against our collector.

| Field | Type | What |
|---|---|---|
| `chain_id` | integer | `8453` (Base) or `4663` (Robinhood Chain) |
| `block_number` | integer | the block both calls were made at |
| `block_hash` | string | that block's hash, so the block is named and not only numbered |
| `symbol_return` | string or null | the raw bytes `symbol()` returned, `0x` hex; `null` when the call failed |
| `name_return` | string or null | the same for `name()` |
| `matches_collector` | boolean | whether the decoded text equals the `symbol` and `name` in this event |
| `reproduce` | string | a `cast call --block <n> … 'symbol()(string)'` line that asks the chain again |
| `needs_archive_rpc` | boolean | `true` on Robinhood Chain, whose public RPC keeps about 11 minutes of state, so replaying the call needs an archive node |

`text_evidence` is `null` when the chain could not be read at the time, and the key is absent from backfilled events
and from events written before this reading shipped: evidence is never added after the fact.

`/verify` and `/api/passport` carry the address's case as `case`: `status` (`open`, `listed_by_issuer`, `closed`),
`source`, `first_seen_at`, `flagged_at`, `archived_at`, `closed_at` and the number of `events`; `null` when the
address never was one.

`Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`. 400 for a bad parameter.

---

<a id="route-matrix"></a>
## `GET /api/matrix`

Every share (ISIN) listed on both Base and Robinhood Chain, each venue's premium over its own issuer's reference, and
the gap between them. The same rows as [`compare_venues`](./tools.md#tool-compare_venues), all of them, plus
`market_now`.

```bash
curl -s 'https://proofofstock.xyz/api/matrix'
```

```json
{
  "market_now": { "session": "regular", "reason": "regular", "ny_date": "2026-11-10", "holiday": null, "early_close": false },
  "generated_at": "2026-11-10T15:00:00.000Z", "venues": ["base", "robinhood"], "compares": "premium", "stale_after_s": 1800,
  "note": "Each venue's premium is its on-chain price over its OWN issuer's reference, per token. …",
  "pairs": 1, "with_gap": 1, "without_gap": 0, "stale": 0,
  "rows": [{ "isin": "US67066G1040", "name": "NVIDIA", "base": { "…": "…" }, "robinhood": { "…": "…" },
             "gap": -0.0000007, "gap_refused": null, "reference_kinds_differ": true, "reference_note": "…" }]
}
```

No parameters. `gap` is `robinhood.premium - base.premium`, a difference of two fractions over different references:
not a price difference and not an arbitrage. Row and cell fields are listed under
[`compare_venues`](./tools.md#tool-compare_venues).

| Status | Body | Headers |
|---|---|---|
| 200 | the matrix | `Cache-Control: public, max-age=60` |
| 503 | `{ "error": "the robinhood registry is not loaded yet", "missing": ["robinhood"] }` | `Retry-After: 30` |

---

<a id="route-status"></a>
## `GET /api/status`

What the server holds, per chain. Every key is a chain; nothing else is ever added beside them.

```bash
curl -s 'https://proofofstock.xyz/api/status'
```

```json
{
  "base": {
    "registry_records": 2, "registry_age_s": 120, "registry_error": null,
    "readings_tokens": 1, "readings_age_s": 120, "readings_error": null,
    "newest_reading_at": "2026-11-10T14:45:00.000Z", "newest_reading_age_s": 900
  },
  "robinhood": {
    "registry_records": 1, "registry_age_s": 120, "registry_error": null,
    "readings_tokens": 1, "readings_age_s": 120, "readings_error": null,
    "newest_reading_at": "2026-11-10T14:45:00.000Z", "newest_reading_age_s": 900
  }
}
```

The state of paid passes is its own route, `GET /api/status/payments`: `{ "enabled": false }` where paid passes are off. Otherwise: `settlement_wallet` is the address that sends the settlement transactions and pays their gas (the sender of every one on chain); `paused_until` is set while selling is paused after failed settlements; `late_settlements` lists, for 24 hours, the transactions that were sent and had no receipt after 10 minutes (`{ transaction, at }`). Our own health check alerts on these (`deployment/PUBLISHING.md`). This route costs no unit of the rate limit, so a monitor past its free minute still reads the state. `settles_v2` is `"cdp"` when x402 v2 payments are settled by Coinbase's x402 facilitator and `"self"` when our settlement wallet settles them; v1 payments always settle through the wallet, so `sales` counts those only. `sales` is what the settlement wallet has done, read from Base every 10 minutes, or null before the first read: `settlement_transactions` is the wallet's own transaction count (one per pass sold, the number BaseScan shows), and `latest` its newest settlement: `transaction`, `at` (the block time), `settled` (false when it reverted and paid nothing out), `payer`, and `ours`, true when the payer is our own test wallet.

| Field | Type | Unit | Null means |
|---|---|---|---|
| `registry_records` | integer or null | | the registry has never loaded |
| `registry_age_s` | integer or null | seconds since the last successful registry read | never loaded |
| `registry_error` | string or null | | the last refresh succeeded. Set while the server serves an older copy |
| `readings_tokens` | integer or null | tokens with at least one reading in the 72 h window | the window has never loaded |
| `readings_age_s` | integer or null | seconds since the server last loaded the reading files | never loaded |
| `readings_error` | string or null | | the last load succeeded. Set while the server serves the last good window |
| `newest_reading_at` | string or null | ISO time the recorder last wrote a reading for this chain | no reading in the window |
| `newest_reading_age_s` | integer or null | seconds since that reading | as above |
| `impostors_listed` | integer or null | tokens on the impostor list (`/api/impostors`) | null until the list is read |
| `impostors_age_s` | integer or null | seconds since that list was generated | the list is written every 6 h |

`readings_age_s` says when the server last read the files; `newest_reading_age_s` says when the recorder last wrote
one. `Cache-Control: no-store`. This route counts against the rate limit.

<a id="route-exam"></a>
## `GET /api/exam`

The latest public exam, summarized. Once a day the public repository asks the site about every token whose right
answer comes from the issuers (`scripts/exam.mjs`) and commits the report to its
[`exam` branch](https://github.com/proofofstock/proof-of-stock/tree/exam). The server reads `reports/latest.json` from
there at most every 30 minutes, in the background, and keeps only numbers and checked strings.

```bash
curl -s 'https://proofofstock.xyz/api/exam'
```

```json
{
  "day": "2026-11-12", "finished_at": "2026-11-12T06:52:10.000Z", "age_s": 25200,
  "total": 592, "passed": 592, "failures_total": 0,
  "set": { "counts": { "A": 520, "B": 12, "C": 40, "D": 20 }, "sha256": "<64 hex>" },
  "metrics": { "asked": 592, "false_listed": 0, "false_not_listed": 0, "real_called_fake": 0, "lookalikes": 12, "lookalikes_caught": 12,
    "minted_wrong": 0, "refused": 0, "list_proof": { "base": true, "robinhood": true },
    "price_evidence": { "tried": 10, "onchain": 8, "same_bytes": 8, "none": 2 }, "verify_ms": { "p50": 140, "p95": 410 } },
  "report_url": "https://github.com/proofofstock/proof-of-stock/tree/exam",
  "report_day_url": "https://github.com/proofofstock/proof-of-stock/blob/exam/reports/2026-11-12.md",
  "rerun": "node scripts/exam.mjs", "repo": "https://github.com/proofofstock/proof-of-stock"
}
```

`set.counts`: A tokens on the issuers' lists, B look-alikes flagged that week, C strangers, D Base tokens asked on
Robinhood Chain. `passed` is `total` less refusals and failures, so it never flatters. 503 with `{ "error": ... }` when
the report could not be read or none is from the last 36 hours: an old result is never served as current.

---

<a id="route-anchors"></a>
## `GET /anchors/` and `GET /anchors/<file>`

The daily Bitcoin anchors. Once a day we write a manifest of the SHA-256 of every data file the previous day
produced, chained to the manifest before it, and send the manifest's own SHA-256 to two public OpenTimestamps
calendars. This proves **when** the files existed in this form, not that what they say is right.

The same hash is also written to Base and to Robinhood Chain, one transaction a day each, as plain readable text.
Those are mirrors: Bitcoin is the root, because those two chains are sequenced by the two issuers this service
checks. And the Bitcoin block a proof names is not taken on the calendar's word: once a day the merkle root the
proof's path ends at is compared with what block explorers outside OpenTimestamps report for that height, and what
came back is served beside the proof.

```bash
curl -s 'https://proofofstock.xyz/anchors/'
curl -O 'https://proofofstock.xyz/anchors/manifest-2026-11-12.json'
curl -O 'https://proofofstock.xyz/anchors/manifest-2026-11-12.json.a-pool-opentimestamps-org.ots'
```

```json
{
  "note": "Daily manifests of the SHA-256 of every data file, each anchored in Bitcoin through OpenTimestamps. …",
  "days": [{
    "day": "2026-11-12",
    "manifest": "anchors/manifest-2026-11-12.json",
    "proofs": ["anchors/manifest-2026-11-12.json.b-pool-opentimestamps-org.ots", "anchors/manifest-2026-11-12.json.a-pool-opentimestamps-org.ots"],
    "mirror": "anchors/mirror-2026-11-12.json",
    "btc_check": "anchors/btc-check-2026-11-12.json"
  }]
}
```

`mirror` and `btc_check` are `null` until that file exists: the mirror is written by its own daily unit, and the
Bitcoin check only once a proof names a block, so for the newest day both can be missing.

A manifest holds `day`, `built_at`, `previous` (the day before and its SHA-256, so a gap or a rewritten day shows)
and `files[]`, each with its `chain`, `file`, `bytes` and `sha256`. A `.ots` proof is served as
`application/octet-stream`. Each proof is completed in place once Bitcoin confirms it, by the next daily run, so a
proof older than a day already names its Bitcoin block; a proof of the last day may still be pending, and
`ots upgrade` completes it from the calendar. Walk-through:
[Check that our data existed on a given day](../how-to/verify-an-anchor.md).

`mirror-<day>.json` names, per chain, the transaction carrying that day's hash: `chain`, `chain_id`, `tx`, `status`,
`block`, `witnessed_by` and an explorer link. A mirror is only called `confirmed` once a node run by somebody other
than that chain's own operator has confirmed the same transaction, carrying this day and this hash, from and to one
address, value zero. `btc-check-<day>.json` names, per proof, the merkle root its path ends at and the sources that
confirmed the block at that height really has it. For one answer with all of it, there is the MCP tool
[`verify_anchor`](tools.md#tool-verify_anchor).

The data files themselves are available on request: hello@proofofstock.xyz. These routes are outside `/api/`, so
they do not count against the per-client rate limit. Both carry `Access-Control-Allow-Origin: *`; the index is
`Cache-Control: public, max-age=300` and a file `max-age=3600`. A name that is not an anchor file is a 404.

---

<a id="route-tokenlist"></a>
## `GET /tokenlist.json`

The issuer-listed stock tokens as a token list in the [Uniswap Token Lists](https://tokenlists.org) format, for
wallets and DEX front ends to import. Any origin may fetch it (`Access-Control-Allow-Origin: *`); it is cached for five
minutes and costs no rate-limit units.

```sh
curl -fsS https://proofofstock.xyz/tokenlist.json
```

**What is in it.** Every token that is on its issuer's own published list for that chain, read within the last 15
minutes, **and** trades in a pool on that chain, so its decimals are known from the chain. A listed token with no pool
cannot be bought on a DEX and is left out. Each entry carries `extensions.issuer`, and `extensions.isin` and
`extensions.multiplier` where the issuer publishes them. Names are the issuer's, fitted to the format's character set
and 40 characters.

**What is never in it: impostors.** A wallet that imports a token list adds every entry to its token picker, so a list
of fakes in this format would put the fakes in front of people. Look-alikes are at [`/api/impostors`](#route-impostors),
a JSON of warnings that no wallet imports as tokens.

**Version.** `timestamp` is when the oldest of the issuer lists was read; `version.minor` is that UTC day and
`version.patch` the minute of it, so a client sees a newer version after every read.

**When an issuer list is stale.** 503, `{ "error": ... }`, `Retry-After: 60`: no list is built from an old copy, the
same rule every verdict keeps. Before the list is served it is checked against the format's rules; a list that fails
them is withheld (500) rather than served. While the [kill switch](#kill-switch) is tripped, `503` from the switch.

---

<a id="route-denylist"></a>
## `GET /denylist.json`

Every look-alike we flag right now, on both chains, as one file, for wallets, DEX front ends, trackers and security
APIs that warn before a swap without asking per address. Free, any origin (`Access-Control-Allow-Origin: *`), cached
for five minutes.

```sh
curl -sS https://proofofstock.xyz/denylist.json
```

**It is not a token list.** A wallet that imports a token list adds every entry to its token picker, so this file has
its own shape and no `tokens` array.

| Field | What it is |
|---|---|
| `format` | `pos-denylist/1` |
| `warning` | what every address in the file is, in one sentence |
| `sources.<chain>` | `chainId`, `flagged_at` (when that chain's flags were last computed, every 6 hours) and `count` |
| `entries[]` | one per flagged address, newest first within a chain |
| `entries[].address` | the look-alike's contract, lower case |
| `entries[].imitates` | `symbol` and `ticker` of the issuer's token it copies, and `issuer_address`, that token's own contract (null while the list locks hold it) |
| `entries[].kind` | `registry_symbol`, `issuer_name_suffix` or `registry_name` ([methodology](../explanation/methodology.md)) |
| `entries[].first_seen_at` | when our collector first saw the token |
| `entries[].evidence` | its page on the site, with the evidence |

**What is not in it.**
- The look-alike's own symbol and name. They are text its creator chose, and the reader is often a program. The
  evidence page shows them, labelled.
- Closed cases, the dated archive and a feed of changes. Those are on request: hello@proofofstock.xyz.
- A borrowed ticker alone (`ticker`). It is counted, never flagged.

**When it is not answered.**
- `503` with `Retry-After: 60` while either chain's list of flags cannot be read. No half list is ever served.
- `500` if the file fails its own check: no token fields, no stranger's text, no duplicate.
- While the [kill switch](#kill-switch) is tripped, `503` from the switch.

---

<a id="route-agent-test"></a>
## The agent test

Six buying tasks for an agent, graded against the issuers' own lists frozen at the start; nothing is bought. The
walk-through, with PowerShell forms: [Test your agent](../how-to/test-your-agent.md). These routes are outside the
per-client rate limit in [Basics](#basics) and have their own: six starts an hour from one client, and twenty answer or
hide requests a minute. A body, where one is sent, must be `application/json` and at most 8 KB: otherwise `415`, `400`
(not JSON) or `413`. Every answer of the API is `Cache-Control: no-store`. While the [kill switch](#kill-switch) is
tripped, all of them answer `503` from the switch.

<a id="route-agent-test-start"></a>
### `POST /api/agent-test`

Starts a test.

```sh
curl -sS -X POST https://proofofstock.xyz/api/agent-test
curl -sS -X POST https://proofofstock.xyz/api/agent-test -H 'content-type: application/json' -d '{"label": "My Agent"}'
```

A POST with no body starts a test with no label, in any shell. `label` is optional: 1 to 40 ASCII letters, digits,
spaces and `-._&`, naming no issuer, chain or us, and claiming no approval.

| Status | Body |
|---|---|
| 201 | `{ test_id, answer_key, expires_at, tasks_sha256, list_proof, tasks, how_to_answer }`. `tasks` is six `{ n, chain, text }`; `list_proof` is the hash of each chain's frozen issuer list; answers are taken for 15 minutes. Keep `answer_key` out of the agent's prompt |
| 400 | the label is refused, with why |
| 429 | over six starts in an hour from this client; `Retry-After: 600` |
| 503 | an issuer list is not fresh, there is not enough material for a fair test, or the test store is full: try again later |

<a id="route-agent-test-answers"></a>
### `POST /api/agent-test/<id>/answers`

The agent's answers, graded once.

```sh
curl -sS -X POST https://proofofstock.xyz/api/agent-test/<test_id>/answers -H 'content-type: application/json' -d '{"answer_key": "ak_...", "answers": [{"n": 1, "address": "0x..."}, {"n": 2, "refuse": true}]}'
```

Exactly six entries, `n` 1 to 6, each with one of `address` or `"refuse": true`.

| Status | Body |
|---|---|
| 200 | `{ passed, right, of, sentences, result_url }`. A repeat with the right key returns the first grade unchanged |
| 400 | the answers are malformed, with why. The test is not used up |
| 403 | `wrong answer_key` |
| 404 | `no such test` |
| 410 | the answer window has closed, or the result is hidden |
| 429 | too many answers from this client in a minute |
| 503 | the test store is full; the test is not used up |

<a id="route-agent-test-hide"></a>
### `POST /api/agent-test/<id>/hide`

Hides a result, for the key's holder only: `{"answer_key": "ak_..."}`. `200` with `{ "hidden": true }`; `403` with a
wrong key, `404` for no such test, `429` over the per-minute limit. A hidden result answers `410` everywhere after.

<a id="route-agent-test-read"></a>
### `GET /api/agent-test/<id>`

The test's record. Graded: the receipt itself, byte for byte as stored, which `scripts/agent-test-check.mjs` checks
against us and replays. Not graded yet: `{ test_id, started_at, expires_at, tasks_sha256, tasks }`. `404` for no such
test; `410` when it is hidden, or ungraded past its window.

```sh
curl -sS https://proofofstock.xyz/api/agent-test/<test_id> -o receipt.json
node scripts/agent-test-check.mjs receipt.json
```

<a id="route-agent-test-page"></a>
### `GET /agent-test/<id>` and `GET /agent-test/<id>/badge.svg`

The result page ("Passed" or "Not passed", each task with the answer and the right one) and its badge, an SVG that
turns grey after 30 days. A graded test only: otherwise `404`, or `410` when hidden, as plain text. Both are
`X-Robots-Tag: noindex` and `Cache-Control: no-store`; we list results nowhere. `/agent-test` itself is the page for
people.

---

<a id="paid-passes"></a>
## Paid passes (x402)

A sporadic reader never pays: the free minute in [Basics](#basics) is the whole product for them. A client that needs
more than the free minute can buy a **pass**: 0.01 USDC on Base for 10 minutes at 600 units a minute (ten times the
free rate), bound to its client key on the server. No account and no key: every route above works the same under a pass, and `/mcp` is under the same limit and the same pass. The payment is
[x402](https://www.x402.org) over HTTP, settled on chain by the server itself; the how-to with client code is
[how to pay per call](../how-to/pay-per-call.md).

A refused request answers **402** with the offer:

```json
{
  "x402Version": 1,
  "error": "the free minute is used up; pay 0.01 USDC on base for a 10-minute pass at 600 units a minute",
  "accepts": [ { "scheme": "exact", "network": "base", "maxAmountRequired": "10000",
    "resource": "https://proofofstock.xyz/api/passport", "payTo": "0x…",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "extra": { "name": "USD Coin", "version": "2" } } ]
}
```

The same 402 carries the offer as x402 v2 in the `PAYMENT-REQUIRED` header: base64 JSON with `x402Version: 2`, a
`resource` object (`url`), and `accepts` with `network: "eip155:8453"` and `amount: "10000"`. One offer, two wrappers.

Retrying the same request with the payment settles it: `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2, the offer echoed
as `accepted`), each carrying the signed EIP-3009 `transferWithAuthorization`. That request is served, and the
settlement receipt rides out in the version paid: `X-PAYMENT-RESPONSE` or `PAYMENT-RESPONSE` (base64 JSON: `success`,
`transaction`, `network`, `payer`). From then until the pass ends the limiter measures that client against 600 units a
minute and asks for nothing more.

<a id="route-pass"></a>
### `GET /api/pass`

The pass on its own, for a client that buys before it needs one. Without a live pass it always answers the 402, whatever
is left of the free minute, with the v2 offer in the body too and an x402 Bazaar extension (`extensions.bazaar`)
describing the route. Paid, or with a pass already live: `200`, `{ "pass": { "active": true, "until", "minutes",
"units_per_minute" } }`. It costs no unit. Failed payments here are capped per client, as on the big batch of
[`/verify`](#route-verify). `404` where paid passes are off.

`GET /openapi.json` describes this route for x402 catalogues: OpenAPI 3.1, its price in `x-payment-info`, its 402.
Only the paid route is in it; the free API is this page.

| | |
|---|---|
| Exact price | the 402's own `maxAmountRequired` is the only amount accepted: 10000 atomic USDC (6 decimals) is 0.01 |
| Replay | an authorization is settled once; the same payment again is refused without touching the chain |
| Pacing | one settled purchase per client per 5 minutes; a faster one is refused with `Retry-After` and nothing is taken |
| Failure | 402 `it has not been taken`: the signature verified but no transaction was broadcast |
| Over the pass | a client over even 600 units a minute gets the plain 429, `Retry-After: 5`; a pass is never sold to whoever has one |
| Off by default | without the host's payee and settlement key file every refusal stays the plain 429 of the day before, and no 402 is ever served |

---

<a id="monitoring"></a>
## Monitoring

Poll `/api/status` once a minute or slower and alert per chain:

| Condition | Meaning |
|---|---|
| `newest_reading_age_s > 1800` | the recorder (every 900 s) has missed two runs. Passports now carry `reading_stale`, and the matrix gives no gap |
| `newest_reading_age_s` is `null` once the server has loaded | no reading in the last 72 h |
| `registry_age_s > 900` | `/verify` answers 503 and badges show `Registry unavailable` |
| `registry_error` not null | the issuer's API failed on the last refresh; the server serves its last good copy |
| `readings_age_s > 900` or `readings_error` not null | the server has stopped rereading the readings (it reloads every 300 s) |
| any field `null` right after a deploy | still loading; wait one refresh |

```bash
curl -sf https://proofofstock.xyz/api/status \
  | jq -e 'to_entries | map(select((.value.newest_reading_age_s // 1e9) > 1800 or (.value.registry_age_s // 1e9) > 900)) | length == 0' \
  >/dev/null || echo "ALERT: proofofstock.xyz is stale"
```

`/healthz` is the process's own liveness check for its unit. The proxy does not expose it: `https://proofofstock.xyz/healthz`
is a 404. Use `/api/status`.

[Not investment advice](../legal.md)
