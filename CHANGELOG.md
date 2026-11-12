# Changelog

All notable changes to Proof of Stock. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

- **Major:** a breaking change to an answer's shape: a field removed or renamed, a unit changed, an enum value removed,
  or a schema in `schemas/v2/` or `docs/reference/passport.schema.json` changed incompatibly.
- **Minor:** new fields, tools, routes or pages.
- **Patch:** fixes that keep every shape.

The version is in `package.json`, and the site footer, the MCP `serverInfo.version` and the docs headers show it.

## [Unreleased]

### Security
- **`since` must be a whole ISO time** (MCP `recent_impostors`, `/api/history/cases`). `Date.parse` accepts `2026-11-09 (any text)`, and the MCP lead, the sentence an agent is told to quote, repeated `since` as given: a caller's text could ride on a valid date into our own words. Anything after the time is now `-32602` (HTTP: 400). From a GLM audit of the MCP servers, 12.11.

### Fixed
- **The stdio MCP server holds callers to the schemas it advertises** (`hours` past 720, an unknown argument, a number as `query` ran) and answers bad input as the HTTP server does: an unknown tool or bad argument is `-32602`, an `id` of `null` is `-32600`, a client's response and every notification get no reply, and the protocol version is negotiated. Both servers share one argument check (`scripts/lib/mcp-args.mjs`).

### Changed
- **The footer is tighter, and X, Telegram and GitHub are the last thing on the page:** three icons at the end of the bottom line, after the version; the GitHub pill leaves the link row. The docs footer ends with the same three icons.
- **A listed passport says what listed is not:** on the site and as the last sentence of the MCP passport lead, "Listed says which contract is the issuer's, not that its price is fair."
- **The row validator lives beside its schemas** (`schemas/v2/validate.mjs`, was `base/dataset-v2/schema-validator.mjs`): the old path looked like a published dataset. It held no data.
- `marked` 18.2.0 (was 15.0.12); every docs page renders the same.

### Fixed
- **The visit counter counts a landing section only after it has been on screen for a second.** It counted every section within half a second of some page loads (a restored scroll, a jump to the footer), which said the whole page had been read.
- **`premium_at_reference_time` is the same value on every route:** the matrix took it from the 72 h the site holds, the passport from its 24 h, so with an issuer price over a day old (a weekend) the matrix showed a reading the passport did not. Both use the public window now (`PUBLIC_WINDOW_H`).
- **The brand mark in the footer and the docs bar carries the icon inline:** as a file it was cached a day by the CDN and showed the old icon after 0.5.0.

## [0.5.0] - 2026-11-11

### Added
- **The source is public:** https://github.com/proofofstock/proof-of-stock. The site footer and the docs link to it.
- **The footer links the project on X (@proofofstock) and on Telegram (t.me/proofofstock1)**, with icons drawn in the site's own line style; the organisation's JSON-LD names the same profiles as `sameAs`.
- **The visit counter sees what people do, as kinds of action:** which button under the headline, what kind of search (ticker, name, ISIN, address) and whether it found anything, typed commands, which question opened, which sections were scrolled into view, what was copied, which kind of outside link was followed, the chain switch. A fixed list of kinds and values; never the text typed, no recording, no third party (docs/legal.md). The daily report has a line per kind.
- **Questions on the landing** (`#faq`): six questions a visitor or an agent developer doubts before trusting it (listed is not a price verdict, not listed is not proof of a fake, where the data comes from, how old an answer can be and what happens when a source is down, whether an agent is safe, cost), in words that stay true as issuers are added; the same text as FAQPage JSON-LD. The hero names no single issuer in its sentence.
- **Search engines, AI crawlers and link previews** (from an 11.11 audit of the live site: no robots rules, no sitemap, no canonical link, a text-only preview on `/` and none elsewhere, no structured data):
  - `/robots.txt` allows every page and keeps `/api/`, `/verify` and `/mcp` out; it names `/sitemap.xml`, which lists the home, the docs, `/status`, `/history` and one short link per issuer-listed token (`/?base=NVDAc`), from the registries in memory.
  - Every page names its canonical link (the docs home is `/docs/`; a token is its short link), and a markdown docs page points at its HTML one with a `Link` header. JSON answers carry `X-Robots-Tag: noindex`, and so does the empty passport of an address that is neither listed nor a listed impostor.
  - A 1200×630 preview image in the site's style (`/og.png`, from `scripts/og/og.html`) and a large Twitter card on every page; the docs, `/status` and `/history` get Open Graph tags too, and `/status` a description.
  - JSON-LD: the organisation (Proof of Stock, hello@proofofstock.xyz), the site, the web app and the MCP server on the home; a TechArticle per docs page; a WebPage elsewhere. A PNG icon (`/logo.png`, also `/favicon.ico`).
  - `/llms.txt` starts with where an agent begins: the MCP server, the HTTP API, the passport schema, the guard and `/llms-full.txt`.
  - **The site is named Proof of Stock** in every `<title>`, link preview, the JSON-LD and `/llms.txt` (was Stock Token Passport); a token's page keeps its ticker and chain first (`NVDAc (NVIDIA) on Base: … · Proof of Stock`).

### Changed
- **A new site icon** (the owner's): a blue disc cut by a notched band. It is the favicon on every page, the touch icon and the organisation's logo (512 px), the brand mark in the footer and the docs bar, and the mark on the link preview.
- **robots.txt names the search and AI crawlers** of OpenAI, Anthropic, Google, Perplexity, Meta, Apple, Amazon, Mistral, Microsoft, Common Crawl, DuckDuckGo and Cohere, with the same rules as every other crawler: the pages, docs and llms.txt open, the JSON API and /mcp out.
- **The name is Proof of Stock** on every page, in MCP (`serverInfo.name: proof-of-stock`) and in `server.json`; the guard is `@proofofstock/guard` (not published yet). The rights line says the code is MIT.
- **The first screen says what the site is:** "Is this stock token the real one?", one sentence on what it checks, and chips "biggest gaps now" and "known fakes". A passport opens with the verdict in words and when the issuer list was read; "reference" is "issuer price" and "difference" is "on-chain vs issuer", with what + means and the reading's age. The greeting says how many listed tokens have prices. The colour legend matches the colours (green above the issuer, red below). Errors are sentences (no connection, too many checks). A section says what the service cannot do: it only reads.
- **Accessibility:** faint text at 4.7:1 contrast, the headline is the page's h1, the chain switch is toggle buttons, the typed greeting is announced once.
- **The changelog is a docs page:** `/docs/changelog.md`, in the docs menu under Releases; the footer version links there and `/CHANGELOG.md` redirects to it.

### Security
- **Both CIs name every GitHub Action by its commit** (`actions/checkout` and `actions/setup-node` v4.4.0), not by a tag that can be moved; a test keeps it so.
- **A token's own symbol and name are treated as a stranger's text.** For a token outside the issuer registry they are published as one-line labels (invisible and control characters removed, cut to 32 and 64 characters), never put into a sentence the service says (the MCP lead of `recent_impostors`, an impostor page's title and link preview), and every answer that carries them says so in `untrusted_text`. The MCP server's instructions say the same. An agent reading our answers could otherwise be handed instructions through a token's name.
- **The impostor rule compares normalized text:** an invisible character or a full-width letter in a symbol was a way past the exact comparison. Rule version `impostor-strong-v2`.

### Fixed
- **The same share on the other chain shows no price older than the passport's window**, like the passport's own `latest` (it could show one up to 72 h old).
- **The site:** the status bar showed when the server last read its files as the age of the readings; it now shows when a price was last read. A pasted address gets the chart and the by-session table, as a ticker search does. Aerodrome pools are named.
- **The docs match the code:** `latest` follows `hours`, `no_readings` after 72 h without a reading, the `case` field, `internal error` on MCP, `window_days` and `older` on the impostor list, the rate limit in units, GeckoTerminal's trigger, the fourth pool rule; the alert script in "Alert when the gap is wide" no longer crashes at its first alert.

## [0.4.0] - 2026-11-11

### Fixed
- **The case archive keeps what it knows** (from the 11.11 review): an archive or stream that cannot be read is an error, not an empty one, so no run backfills every case again and the site keeps its last good copy; a damaged line in a token stream makes the list partial, so it closes no case as gone; a row appended after a torn last line is no longer lost. The recorder exits non-zero when it dies midway or writes an invalid row.
- **The guard believes only a well-formed answer:** `listed` must be a boolean about the address asked; anything else is `unknown` and refuses the buy (a `listed: "false"` string used to allow it).
- **Smaller fixes:** `/history` printed a literal `${BULK_WINDOW_DAYS}` when empty; a registry row without its lists stopped that chain's history; the visit counter credited a passport's seconds to the next one; the docs say a passport costs 3 units, 24 h and IPv6 /56.
- **From a code review (11.11):** `?chain=constructor` and other Object member names are a 400 (they answered 500); no raw error text, paths included, reaches a public answer or an MCP client; a client that arrives while the rate-limit table is full keeps its 60 units a minute (it passed uncounted); `/healthz` is 503 until an issuer registry is loaded, and a deploy is refused while another runs, rolls back on a failed restart and health-checks the rollback.
- **From a site audit:** /llms-full.txt links are absolute (relative to the one file they all 404ed); the terminal says "impostors" and "issuer-listed" instead of "fakes" and "verified"; /history says when its case archive starts instead of a dash; the guard is described as unpublished, not private; /api/status documents its impostor fields.
- **The contact address is the project's own:** hello@proofofstock.xyz on the legal page, in place of another project's mailbox.
- **From a code review (11.11), the server side:** one client re-requesting a page can no longer fill the visit counter's day: each daily pseudonym gets at most 200 page loads and 400 beacons a day. `/status` and `/history` are built once per 30 s instead of on every request. The recorder stops itself short of its unit's timeout (no GeckoTerminal top-ups in the last 90 s, no more tokens at the deadline) and still writes its run row, which counts what it skipped in `supplement_skipped`. nginx keys its limits by an IPv6 /56 like the app, limits connections on the older names too, and sends HSTS; the site's unit hides other processes and writes its files private.

### Changed
- **No price older than the passport's window:** past 24 h without a reading, `latest` is `null` and `notes` carry `reading_stale`, instead of the last price the recorder left.
- **The two timed jobs run sandboxed like the site**, CI runs with a read-only token and `npm ci` only, and the public export is dry-run on every push.
- **⚠ Breaking: `/api/history/cases` has no cursor.** It answers the newest 50 events of the window at most; `cursor` is ignored and `next` is gone. Paging read the whole week 50 rows at a time, which the cap is there to prevent. `count` still says how many the window holds.
- **⚠ Breaking: no deployer address in public answers.** `/api/impostors` items and the passport's `impostor_listing` carry `same_deployer_impostors` (how many other listed impostors share the deployer) instead of `deployer`. The address is the collector's work.
- **The rate limit keys IPv6 by /56** (was /64), the block an ISP gives one customer, so one free /48 is 256 clients instead of 65,536.
- **Switching chain from the tabs repeats the last search there**, and says so in the terminal. Before, a Base passport stayed on screen under a Robinhood link. An address search is answered on both chains anyway, so it is not repeated.
- **The tape runs smoothly.** The background glow is a gradient instead of a 100 px blur filter that was redrawn every frame, the terminal no longer blurs the moving background behind it, and the tape no longer rebuilds itself when only the order of its tokens changes.
- **The footer and the docs say "beta".**
- **Charts open on GeckoTerminal** (CoinGecko's DEX charts) instead of DexScreener: `links.dex`, the passport's chart button and each pool row. DexScreener is still one of the price sources.
- **⚠ Breaking: lists are a window, an address is answered whole.** The archive and the recorder's prices are what nobody else has, so they are no longer a download:
  - `/api/history/cases`, `/api/impostors` and MCP `recent_impostors` list only the last 7 days, at most 50 rows; backfilled cases are not listed. They say so (`window_days`, `older`).
  - A passport shows at most 24 h (was 72), carries `series_points` only with `series=1`, and costs 3 units of the per-minute limit.
  - Any one address still gets its whole case and its passport; the counts cover the whole archive. The full archive is available on request.
- **Prices are coloured by direction.** An on-chain price above the issuer's is green and one below is red; under 0.5% it stays neutral, beyond 2% it is bold. Until now the colour was the gap's size whatever its sign, so a rise showed red. The tape is labelled "vs issuer", because its number is the gap to the issuer's price, not a price change.
- **The site is proofofstock.xyz.** Every link, the MCP URL (`https://proofofstock.xyz/mcp`), `server.json`, the docs and the guard default point there. stockofproof.xyz and tickerproof.xyz redirect every page to it, but serve `/mcp` in place, because an MCP client POSTs and a redirected POST is not reliably followed: agents set up with the old URL keep working. `deployment/nginx/proofofstock.xyz.conf` replaces `stockofproof.xyz.conf`.

### Added
- **Our own visit counter** (`apps/stocks-analytics.mjs`, `apps/stocks-web/beacon.js`, `scripts/stocks/analytics-report.mjs`), with no cookie, no third party and no stored address ([What we count](docs/legal.md#what-we-count)). Every page counts which page was shown and for how many visible seconds, the open passport and the referring host. The server counts the pages it sent by requester class (browser, bot, tool) and MCP calls by tool. A visitor is a daily pseudonym whose key lives only in memory. It is on only where `STP_ANALYTICS_DIR` is set (the unit sets `/var/lib/stp-analytics`), so tests and the deploy gate never write to it.
- **The history is public** (TZ §H6): the page `/history` and `GET /api/history/cases` and `/api/history/registry` (`apps/stocks-history.mjs`). Per chain: the registry snapshots, the snapshot in force on any day, and the case timeline, each event dated and marked observed or backfilled. A backfilled case says "first seen by our collector", never "flagged by us". `/verify` and `/api/passport` gain `case`; the passport says when a contract the issuer now lists was on our impostor list before. Nothing is read from disk on a request: the archive is loaded with the background refresh.
- **Source links to GitHub, hidden until the repository is public.** They are a footer chip with the GitHub mark, a link in the docs top bar and "Source on GitHub" in the docs footer. They show only when `package.json` `stp.source_public` is true; it is false today, so no page links to a 404. `package.json` gains `repository`.
- **History starts accumulating** (`evm/core/stocks/history.mjs`, TZ §H1-H2). Files go under `<root>/stock-peg/history/`.
  - **H1, the impostor case archive:** `cases-*.jsonl` holds one row per change of a case: `opened`, `kind_changed`, `listed` (the issuer listed it) or `gone`. It is append-only; a case's state is the replay of its rows.
    - The first archive of a chain is written as `backfilled`, with `flagged_at` null and the `first_seen_at` our collector recorded.
    - A partial list (a torn day file, or truncation) closes nothing.
  - **H2, registry snapshots:** `registry-*.jsonl` gets the full canonical list without prices, its hash, the previous hash and what changed by address, written only when the registry changed.
  - **Who writes them:** the existing `stp-impostors` and `stp-peg` units, after their own output. A history failure fails the unit loudly and never withholds the public files.
  - Schemas `schemas/v2/stock-case.schema.json` and `stock-registry-snapshot.schema.json`, tests, and `tests/locks/stock-history.mutations.json` (5 mutations).
- **A Coinbase-style query finds the share on Robinhood:** `TSLAc` with no exact match retries as the bare ticker `TSLA`, exact matches only, and says so in `reason` and `query_normalized`.
- **MIT licence** (`LICENSE`).
- **The guard can be published:** `@stockofproof/guard` is no longer private and ships its licence.
- **`server.json` for the official MCP registry.**

  The owner's publishing steps are in `deployment/PUBLISHING.md`.
- **The docs are web pages.** A browser opening `/docs/...` gets HTML:
  - a top bar with search (titles and section headings; ⌘K, Ctrl+K or `/`);
  - catalogs with icons on the left, contents on the right, previous/next at the end;
  - tools and routes drawn as signature cards;
  - a docs home with a "will never" safety card.

  Agents, curl and `?format=md` still get the markdown itself. Markdown is rendered by `marked` (new dependency, pinned to 15.0.12). Raw HTML in the docs is escaped, except `<a id>` anchors.
- **`/status` is a page for people.** It shows each part per chain (issuer registry, price readings, impostor list) as up to date, running late or not updating, against its own schedule, and it refreshes every minute. `/api/status` stays the JSON for code and now includes the impostor list's age. The footer's Status dot takes the same colour.

### Changed
- **The footer is redesigned:**
  - brand and tagline;
  - documentation and status links as chips in the page's style, with a live dot on Status;
  - one short note;
  - a rights line ("© 2026 Stock Token Passport. All rights reserved.");
  - Legal, and the version with its release date, taken from this changelog.
- **The landing names all six MCP tools** and links the tool reference.

## [0.3.0] - 2026-11-10

### Added
- **Documentation** at `/docs/`, as markdown, arranged as tutorials, how-to guides, reference and explanation:
  - a field-by-field passport reference with a JSON Schema;
  - a tool reference with curl examples, errors and limits;
  - an HTTP API reference with monitoring notes;
  - a methodology page with known limitations;
  - one canonical legal page.
- **`/llms.txt` and `/llms-full.txt`**, an index and the full docs for agents (llmstxt.org).
- **Base ↔ Robinhood premium matrix:** `GET /api/matrix`, MCP `compare_venues`, terminal command `matrix`. Venues are
  paired by ISIN, and premiums are compared, never raw prices.
- **Impostor radar, static part, internal only:** address look-alikes and Coinbase vanity-prefix signals, with a
  self-check. They go to `impostor-signals.internal.json` and are not published until measured.
- **Chart legend** for market phases and price holes; dotted bridges over holes of up to 2 h.
- **Pool links:** each pool in a passport links to that pool on DexScreener.
- **Own deploy:** `scripts/ship.sh` and `scripts/deploy.sh` (pinned releases under `/opt/stp`, gated by the full test
  suite), and units `stp-web`, `stp-peg`, `stp-impostors`.

### Changed
- **The project lives in this repository.** Until now it lived inside our collector's repository.
- **The disclaimer is one canonical text** (`docs/legal.md`). Tool descriptions and the MCP instructions point at it
  instead of repeating it.
- **The MCP `serverInfo.version`** comes from `package.json`.

### Fixed
- **Quarantined readings:** those of 2026-11-09 17:30-19:55 UTC priced through memecoin pools (circular prices) no
  longer reach charts or statistics.

## [0.2.0] - 2026-11-10

### Added
- **`GET /verify` and `GET /badge.svg`:** the one-bit registry check, and an embeddable badge that prints the address
  it vouches for.
- **MCP `verify_stock_tokens`** (up to 50 addresses) and **`recent_impostors`**.
- **`@stockofproof/guard`:** a pre-trade check for agents, with an AgentKit action.
- **Short links** for listed tokens (`?base=NVDAc`).
- **Copy the contract with a click.**
- **A seamless live tape** that refreshes in place.

### Changed
- **Exact search:** a ticker or ISIN that matches exactly returns only those tokens; other matches carry
  `match_quality`.
- **Pools count only against a dollar stable or wrapped ETH**, matched by address.
- **Plain text everywhere.**
- **The black and Base-blue palette.**

## [0.1.0] - 2026-11-08

### Added
- The passport, the recorder (every 15 min), the impostor list and the public site.
