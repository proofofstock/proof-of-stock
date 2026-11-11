# HTTP API

`v0.4.0 · updated 2026-11-11`

Read-only JSON routes on `https://proofofstock.xyz`. No key, no account, no cookies. (`GET /api/hit` is the site's
own visit counter, [What we count](../legal.md#what-we-count); it answers 204 and is not for integrations.)

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
- [`GET /api/matrix`](#route-matrix)
- [`GET /api/status`](#route-status)
- [Monitoring](#monitoring)

<a id="basics"></a>
## Basics

| | |
|---|---|
| Base URL | `https://proofofstock.xyz`. The proxy maps the domain's `/` onto the app's `/stocks/`, so `/api/find` here is `/stocks/api/find` in the app |
| Methods | `GET` and `HEAD`. Any other method is refused by the proxy (403) |
| Rate limit | 60 requests per minute per client IP (IPv6: per /56) across `/verify`, `/api/*` and `/mcp` together. Over it: 429, `{ "error": "too many requests, try again in a minute" }`, `Retry-After: 60`. The proxy also caps 10 requests per second (burst 40) and 20 open connections per IP |
| Not rate limited by the app | `/badge.svg`, the page and its assets |
| Errors | JSON `{ "error": "<words>" }`. 400 bad input, 404 unknown path (`{ "error": "not found" }`), 503 a registry not loaded yet, 500 `{ "error": "internal error" }`. Error texts are fixed public sentences; internal causes are never returned |
| Freshness | Every answer comes from memory. The server rereads the issuer registries and the readings every 300 s; nothing on the request path calls out |
| Units | as in the [passport](./passport.md#units): premium and spread are fractions, prices USD per token, ages integer seconds |
| `chain` | `base` (Coinbase registry, chain id 8453) or `robinhood` (Robinhood registry, chain id 4663) |
| `address` | `0x` and 40 hex characters, any case; answers use lower case |

Every answer carries `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin` and `X-Frame-Options: DENY`.

Other public paths: `/` (the page; `/?base=NVDAc` and `/?chain=base&address=0x…` open one token), `/docs/`,
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
  "passport": "https://proofofstock.xyz/?chain=base&address=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
}
```

| Parameter | Required | Constraint |
|---|---|---|
| `chain` | yes | `base` or `robinhood` |
| `address` | yes | `0x` + 40 hex |

The fields are documented under [`verify_stock_tokens`](./tools.md#tool-verify_stock_tokens). `listed: false` means
"not in this issuer's registry", never "fake".

| Status | Body | Headers |
|---|---|---|
| 200 | the result | `Cache-Control: public, max-age=300` when listed, `max-age=60` otherwise; `Access-Control-Allow-Origin: *` |
| 400 | `chain must be one of base, robinhood` or `address must be 0x followed by 40 hex characters` | CORS |
| 503 | `{ "error": "registry unavailable", "registries_checked", "chain", "address", "registry_age_s", "checked_at" }`: the registry was never read, or was read more than 900 s ago | `Cache-Control: no-store`, `Retry-After: 60`, CORS |
| 429 | rate limit | `Retry-After: 60`, CORS |

A registry the server cannot read is never answered `listed: false`.

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

`impostor` is shown only for the strong kinds (`registry_symbol`, `issuer_name_suffix`). `unavailable` covers a
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
      "isin": "US67066G1040", "match_quality": "exact", "has_reference_price": true, "minted": true }
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

`series_points` (the chart) is included only with `series=1`. A passport costs 3 units of the per-minute limit, so 20 passports a minute per client.

| Status | Body | Headers |
|---|---|---|
| 200 | the passport | `Cache-Control: public, max-age=60` |
| 400 | `chain must be one of base, robinhood`, or `address must be 0x followed by 40 hex characters` | |
| 503 | `{ "error": "the issuer registry is not loaded yet", "detail": "the issuer registry could not be read" or null }` | `Retry-After: 30` |

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
      "issuer": "coinbase", "priced": 1, "unpriced": 0, "stale": 0,
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
      "counts": { "registry_symbol": 1, "issuer_name_suffix": 0, "ticker": 0 },
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
| `counts` | tokens per resemblance kind, `ticker` included. Only `registry_symbol` and `issuer_name_suffix` are listed in `items` |
| `listed` | items in the file (capped at 20,000) |
| `items` | tokens first seen in the last 7 days, strongest kind first, then newest `first_seen_at`; at most 50 |
| `window_days`, `in_window`, `older` | the list's window (7), how many fall in it, and where the rest is |

A chain with no list yet answers `{ "error": "not generated yet" }` in its slot, not an empty list.
`Cache-Control: public, max-age=300`. 400 for an unknown `chain`.

---

<a id="route-history"></a>
## `GET /api/history/cases` and `GET /api/history/registry`

The dated archive (`/history` is the same for people). **A list shows the last 7 days of observed events, at most 50 rows; cases archived from the collector's earlier history are not listed.** Any one address keeps its whole case in `/verify` and `/api/passport` (`case`), and the counts cover the whole archive. The full archive is available on request: hello@proofofstock.xyz. Every row is appended and never rewritten. A case is one
address outside the registry that claimed an issuer token; each change of it is an event: `opened`, `kind_changed`,
`listed` (the issuer later listed that address) or `gone` (it left our list). The archive began on 10 Nov 2026; cases
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

What the server holds, per chain.

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
