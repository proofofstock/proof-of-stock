// apps/stocks-nav.mjs: the bar at the top of every page the site renders, with the site's tabs (owner, 22.11: "tabs at
// the top, like a product": Home, Methodology, Proofs, API, Status, History, and the docs; Demo Agent after Home since 25.11).
// One function writes it for the landing (apps/stocks-web/index.html, through its <!--site-bar--> placeholder), /status, /history, /api and every
// docs page, so the tabs are the same everywhere and only the current one changes. Plain links, no script: a reader that
// runs none (a crawler, an agent, a judge's AI helper) gets the same navigation.
//
// Every href is relative to the site's root, handed in as `root` ('./' at the top level, '../../' two folders down in
// the docs), because the public site lives at the domain's root and the app under /stocks (stocks-web.mjs BASE_PATH):
// a relative link is right in both.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * The tabs, in order. Proofs opens "Check us" (24.11): what we could and could not fake, and the three checks of an
 * answer a person can run without us (the issuer's list, the past in Bitcoin, a price at its block). It links the
 * how-to on a day's anchor and the receipts, which sit under the same tab.
 */
export const TABS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home', href: '' }),
  // An agent buying through the guard, live (owner, 25.11): right after Home, the first thing a newcomer should see.
  // "Demo Agent", never a bare "Demo" (owner, 25.11): alone it reads as if the product itself were a demo.
  Object.freeze({ id: 'demo', label: 'Demo Agent', href: 'demo' }),
  Object.freeze({ id: 'methodology', label: 'Methodology', href: 'docs/explanation/methodology.md' }),
  Object.freeze({ id: 'proofs', label: 'Proofs', href: 'docs/how-to/check-us.md' }),
  Object.freeze({ id: 'api', label: 'API', href: 'api' }),
  Object.freeze({ id: 'status', label: 'Status', href: 'status' }),
  Object.freeze({ id: 'history', label: 'History', href: 'history' }),
  Object.freeze({ id: 'docs', label: 'Docs', href: 'docs/' }),
])

/** The docs pages that belong to a tab other than Docs: a reader on one sees that tab marked. */
const DOC_TAB = Object.freeze({
  'explanation/methodology.md': 'methodology',
  'how-to/check-us.md': 'proofs',
  'how-to/verify-an-anchor.md': 'proofs',
  'how-to/keep-a-receipt.md': 'proofs',
  'reference/http-api.md': 'api',
  'reference/tools.md': 'api',
  'how-to/pay-per-call.md': 'api',
})

/** Which tab a docs page (its path under docs/, e.g. how-to/x.md) is under. */
export const tabOfDoc = (rel) => DOC_TAB[rel] || 'docs'

/**
 * The site's tabs, the current one marked with aria-current="page".
 * @param {object} p
 * @param {string} p.current  a TABS id
 * @param {string} [p.root]   the site's root relative to the page: './' or '../' …
 */
export function siteTabs ({ current, root = './' }) {
  return `<nav class="site-tabs" aria-label="Site">${TABS.map((t) =>
    `<a class="site-tab" href="${esc(root + t.href)}"${t.id === current ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')}</nav>`
}

/**
 * The whole bar: the brand (home), the tabs, an optional slot (the docs search box) and the call to connect an agent.
 * @param {object} p
 * @param {string} p.current
 * @param {string} [p.root]
 * @param {string} [p.extra]  trusted HTML of our own, placed between the tabs and the call
 */
export function siteBar ({ current, root = './', extra = '' }) {
  return `<header class="site-bar${extra ? ' has-extra' : ''}">
    <a class="site-brand" href="${esc(root)}" aria-label="Proof of Stock, home"><span class="site-logo" aria-hidden="true"></span><span>Proof of Stock</span></a>
    ${siteTabs({ current, root })}${extra ? `\n    <div class="site-extra">${extra}</div>` : ''}
    <a class="site-cta" href="${esc(root)}docs/tutorials/connect-an-agent.md"><span aria-hidden="true">+</span> Connect an agent</a>
  </header>`
}
