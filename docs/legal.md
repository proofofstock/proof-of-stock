v0.4.0 · updated 2026-11-11

# Legal

This is the one canonical text for Proof of Stock: the site at proofofstock.xyz, its HTTP API, its MCP
server and the `@proofofstock/guard` package. Other pages link here instead of repeating it.

## Not investment advice

Nothing here is investment, financial, legal or tax advice. Nothing here is a trading signal or a recommendation to
buy, sell or hold anything. A premium, a gap, an "issuer-listed" answer or an impostor flag is a fact about data at a
stated time. What you do with it is your decision.

## No affiliation

Proof of Stock is not affiliated with, endorsed by or sponsored by Coinbase or Robinhood. It reads their
public APIs. "Issuer-listed" means the address appears on the issuer's public registry as we last read it. It does
not mean the issuer has verified, approved or reviewed anything here. Coinbase, Robinhood, their product names and the
tickers they use are their trademarks, and the names and tickers of the underlying companies belong to those
companies.

## Holder rights

What a token holder is entitled to is set by the issuer's prospectus and terms, not by the token contract and not by
this project. Read the issuer's documents.

## Data as is

All data is provided as is, with its time and its source, and without warranty of any kind: not of accuracy,
completeness, timeliness or fitness for a purpose. Sources can be wrong, late or unavailable, and so can we. There is
no service level agreement. Every answer carries the time it was produced and the age of each number in it; check
them.

## Not a trading service

This is not a trading service, a broker, an exchange or a wallet. Nothing here enables trading: there are no
accounts, no order routing, no custody and no trading tools. That holds for everyone, including US persons. Whether
you may hold or trade a tokenized stock is a matter between you, the issuer and the law that applies to you.

## Data licensing

- Public data on the site, the API and the MCP server is free to read.
- Automated use must respect the published rate limits (see
  [Known limitations](explanation/methodology.md#known-limitations)).
- The code is under the MIT licence. The data the site serves is free to read and to quote with its time and source.

## What we count

The site counts its own visits, with no cookie, no third-party counter and no stored address
(`apps/stocks-analytics.mjs`, `apps/stocks-web/beacon.js`). One thing is not ours: the pages load two fonts from Google
Fonts, so your browser asks Google for them. For each visit we keep:

- which page was shown, and for how many seconds it was on screen;
- which passport was open, and the host name of the site that linked here, if any;
- the country Cloudflare reports, and whether the requester looks like a browser, a bot or a tool;
- for the MCP server, the method and the tool name, never the arguments.

A visitor is a pseudonym: a hash of the address and the browser string with a random key that is held only in memory and
replaced every day. Nobody, us included, can turn it back into an address, and the same person is a new visitor the
next day. The counts are for us; nothing is sold or shared. A day's file is deleted after 180 days.

## Contact

hello@proofofstock.xyz

[Not investment advice](#not-investment-advice)
