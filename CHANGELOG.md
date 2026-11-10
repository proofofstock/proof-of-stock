# Changelog

All notable changes to the Stock Token Passport. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

- **Major:** a breaking change to an answer's shape: a field removed or renamed, a unit changed, an enum value removed,
  or a schema in `schemas/v2/` or `docs/reference/passport.schema.json` changed incompatibly.
- **Minor:** new fields, tools, routes or pages.
- **Patch:** fixes that keep every shape.

The version is in `package.json`, and the site footer, the MCP `serverInfo.version` and the docs headers show it.

## [Unreleased]

### Fixed
- **From a site audit:** /llms-full.txt links are absolute (relative to the one file they all 404ed); the terminal says "impostors" and "issuer-listed" instead of "fakes" and "verified"; /history says when its case archive starts instead of a dash; the guard is described as unpublished, not private; /api/status documents its impostor fields.
- **The contact address is the project's own:** hello@proofofstock.xyz on the legal page, in place of another project's mailbox.

### Changed
- **Prices are coloured by direction.** An on-chain price above the issuer's is green and one below is red; under 0.5% it stays neutral, beyond 2% it is bold. Until now the colour was the gap's size whatever its sign, so a rise showed red. The tape is labelled "vs issuer", because its number is the gap to the issuer's price, not a price change.
- **The site is proofofstock.xyz.** Every link, the MCP URL (`https://proofofstock.xyz/mcp`), `server.json`, the docs and the guard default point there. stockofproof.xyz and tickerproof.xyz redirect every page to it, but serve `/mcp` in place, because an MCP client POSTs and a redirected POST is not reliably followed: agents set up with the old URL keep working. `deployment/nginx/proofofstock.xyz.conf` replaces `stockofproof.xyz.conf`.

### Added
- **Our own visit counter** (`apps/stocks-analytics.mjs`, `apps/stocks-web/beacon.js`, `scripts/stocks/analytics-report.mjs`), with no cookie, no third party and no stored address ([What we count](docs/legal.md#what-we-count)). Every page counts which page was shown and for how many visible seconds, the open passport and the referring host. The server counts the pages it sent by requester class (browser, bot, tool) and MCP calls by tool. A visitor is a daily pseudonym whose key lives only in memory. It is on only where `STP_ANALYTICS_DIR` is set (the unit sets `/var/lib/stp-analytics`), so tests and the deploy gate never write to it.
- **The history is public** (TZ §H6): the page `/history` and `GET /api/history/cases` and `/api/history/registry` (`apps/stocks-history.mjs`). Per chain: the registry snapshots, the snapshot in force on any day, and the case timeline, each event dated and marked observed or backfilled. A backfilled case says "first seen by our collector", never "flagged by us". `/verify` and `/api/passport` gain `case`; the passport says when a contract the issuer now lists was on our impostor list before. Nothing is read from disk on a request: the archive is loaded with the background refresh.
- **Source links to GitHub, hidden until the repository is public.** They are a footer chip with the GitHub mark, a link in the docs top bar and "Source on GitHub" in the docs footer. They show only when `package.json` `stp.source_public` is true; it is false today, so no page links to a 404. `package.json` gains `repository`.
- **History starts accumulating** (`evm/core/stocks/history.mjs`, TZ §H1–H2). Files go under `<root>/stock-peg/history/`.
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
- **Quarantined readings:** those of 2026-11-09 17:30–19:55 UTC priced through memecoin pools (circular prices) no
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
