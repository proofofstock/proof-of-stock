# Restore Robinhood Chain on the landing

For the hackathon (owner, 19.11.2026) the landing page shows Base only. The terminal, the API, MCP, docs, /status
and /history still answer for Robinhood Chain; nothing about the data changed. This is how to put the landing back.

## Fast: one class

`apps/stocks-web/index.html` has `<body class="no-rh">`. Remove the class (keep `<body>`). Every Robinhood passage
on the page is in a `.rh-only` span and comes back; the Base-only wording in `.base-only` spans goes away
(`apps/stocks-web/style.css`, the two rules at the top). The seal block (`apps/stocks-web/seal.js`) reads the same
class and names both mirrors again.

The look-alikes board (`apps/stocks-web/app.js` `findingsBoard`) reads the same class and shows both chains again.

Three texts outside the page were edited and need their Robinhood words back by hand:

- `evm/core/stocks/page-meta.mjs`: `SITE_DESCRIPTION` ends "on Base and Robinhood Chain."; `OG_IMAGE.alt` ends
  "Base and Robinhood Chain."
- `apps/stocks-seo.mjs`: the feature line reads "(Coinbase on Base, Robinhood on Robinhood Chain)".
- `apps/stocks-web/index.html` `<meta name="description">` ends "on Base and Robinhood Chain."

## Exact: the files as shipped

- The git tag `landing-with-robinhood-2026-11-19` is the release as it was before (0c02ffb). Bring the files back
  with `git checkout landing-with-robinhood-2026-11-19 -- apps/stocks-web/index.html apps/stocks-web/seal.js
  apps/stocks-web/style.css apps/stocks-web/app.js evm/core/stocks/page-meta.mjs apps/stocks-seo.mjs`. Check the diff: later changes to
  these files would be undone too.
- The same six files are copied here as `*.orig`.

Then `npm test` and ship as usual.
