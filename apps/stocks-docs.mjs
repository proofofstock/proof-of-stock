// apps/stocks-docs.mjs — the documentation as web pages: the markdown in docs/ rendered in a docs layout (top bar with
// search, catalogs with icons on the left, the article with its lede, contents on the right, previous / next at the end),
// with stable heading anchors (#field-premium).
//
// A browser gets HTML; an agent, curl or `?format=md` gets the markdown itself (apps/stocks-web.mjs decides). The docs
// are this repository's own files, but raw HTML in them is still not passed through: only `<a id="...">` anchors are,
// everything else is escaped. The only script is docs.js, the search box; the page reads fully without it.

import { Marked } from 'marked'
import { PROFILES } from './stocks-seo.mjs'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const titleOf = (md) => (String(md).match(/^#\s+(.+)$/m) || [])[1] || 'Untitled'
const plainTitle = (md) => titleOf(md).replace(/`/g, '')
const leadOf = (md) => (String(md).split('\n').find((l) => /^[A-Z][^|#`>\-*]/.test(l.trim()) && !/^v\d/.test(l.trim())) || '').trim().replace(/\s+/g, ' ').replace(/[*`]/g, '').slice(0, 160)
const HTTP = /^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)$/

// The catalogs, in reading order, and the icon of each page (docs.css .ic-*). A page not listed falls back to "doc".
const SECTIONS = [
  { label: 'Overview', match: (k) => !k.includes('/') && k !== 'legal.md' && k !== 'changelog.md' },
  { label: 'Get started', match: (k) => k.startsWith('tutorials/') },
  { label: 'Guides', match: (k) => k.startsWith('how-to/') },
  { label: 'Reference', match: (k) => k.startsWith('reference/') && k.endsWith('.md') },
  { label: 'Understand', match: (k) => k.startsWith('explanation/') },
  { label: 'Legal', match: (k) => k === 'legal.md' },
  { label: 'Releases', match: (k) => k === 'changelog.md' },
]
const ICON = {
  'README.md': 'home', 'tutorials/connect-an-agent.md': 'plug', 'how-to/check-before-listing.md': 'shield', 'how-to/alert-on-gap.md': 'bell',
  'how-to/compare-venues.md': 'scale', 'reference/passport.md': 'id', 'reference/tools.md': 'terminal', 'reference/http-api.md': 'globe',
  'explanation/methodology.md': 'bulb', 'legal.md': 'doc', 'changelog.md': 'doc',
}
const SHORT = {
  'tutorials/connect-an-agent.md': 'Connect an agent', 'how-to/check-before-listing.md': 'Check before listing', 'how-to/alert-on-gap.md': 'Alert on a gap',
  'how-to/compare-venues.md': 'Compare venues', 'reference/passport.md': 'The passport', 'reference/tools.md': 'MCP tools', 'reference/http-api.md': 'HTTP API',
  'explanation/methodology.md': 'Methodology', 'legal.md': 'Legal', 'changelog.md': 'Changelog',
}
const ORDER = ['README.md', 'tutorials/connect-an-agent.md', 'how-to/check-before-listing.md', 'how-to/alert-on-gap.md', 'how-to/compare-venues.md',
  'reference/passport.md', 'reference/tools.md', 'reference/http-api.md', 'explanation/methodology.md', 'legal.md']

/**
 * @param {object} p
 * @param {Map<string,string>} p.docs  path → markdown (apps/stocks-web.mjs loadDocs)
 * @param {string} p.version
 * @param {string} p.released
 * @param {{css:string, docsCss:string, docsJs:string}} p.assets  versioned asset paths, relative to the site root
 */
export function createDocsRenderer ({ docs, version, released, assets, sourceUrl = null }) {
  const pages = [...docs.keys()].filter((k) => k.endsWith('.md'))
  const rank = (k) => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i }
  const ordered = pages.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const nav = SECTIONS.map((s) => ({ label: s.label, items: ordered.filter(s.match) })).filter((s) => s.items.length)
  const label = (k) => (k === 'README.md' ? 'Welcome' : plainTitle(docs.get(k)))
  const short = (k) => SHORT[k] || label(k) // the sidebar and the pager: two or three words, the full title on the page

  function render (rel) {
    const md = docs.get(rel)
    if (md == null || !rel.endsWith('.md')) return null
    const toc = []
    let sawH1 = false, sawLede = false
    const marked = new Marked({ gfm: true })
    marked.use({
      renderer: {
        heading ({ tokens, depth }) {
          const html = this.parser.parseInline(tokens)
          const id = slug(html)
          if (depth === 1) { sawH1 = true; return `<h1>${html}</h1>\n` }
          if (depth === 2 || depth === 3) toc.push({ depth, id, text: html.replace(/<[^>]+>/g, '') })
          // A heading that is only a code span is a function: an MCP tool (`find_stock_token`) or an HTTP route
          // (`GET /verify`). It is drawn as a signature, so tools stand out while scrolling.
          const only = tokens.length === 1 && tokens[0].type === 'codespan' ? tokens[0].text : null
          if (only && depth <= 3) {
            const m = only.match(HTTP)
            return `<h${depth} id="${id}" class="fn"><span class="fn-kind${m ? ' http' : ''}">${esc(m ? m[1] : 'tool')}</span><code class="fn-name">${esc(m ? m[2] : only)}</code><a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`
          }
          return `<h${depth} id="${id}">${html}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`
        },
        paragraph ({ tokens }) {
          const html = this.parser.parseInline(tokens)
          const plain = html.replace(/<[^>]+>/g, '').trim()
          if (/^v\d+\.\d+\.\d+ · /.test(plain)) return '' // the version line moves into the page header
          if (!plain) return html + '\n' // an anchor alone: no empty paragraph, and it is not the lede
          // The first paragraph after the title is the page's lede, set larger and quieter.
          if (sawH1 && !sawLede) { sawLede = true; return `<p class="lede">${html}</p>\n` }
          return `<p>${html}</p>\n`
        },
        blockquote ({ tokens }) {
          return `<div class="callout"><span class="ic ic-info" aria-hidden="true"></span><div>${this.parser.parse(tokens)}</div></div>\n`
        },
        html ({ text }) {
          // Only anchors pass: <a id="field-premium"></a>. Inside a paragraph marked hands over each tag on its own, so
          // the opening and the closing tag are each accepted alone. Anything else in the markdown is shown as text.
          return /^\s*(?:<a id="[a-z0-9_-]+">|<\/a>|<a id="[a-z0-9_-]+"><\/a>)\s*$/i.test(text) ? text.trim() : esc(text)
        },
        link ({ href, title, tokens }) {
          const text = this.parser.parseInline(tokens)
          // Only web, mail, relative and in-page links: a javascript: or data: link is shown as its text.
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(https?|mailto):/i.test(href)) return text
          const external = /^https?:\/\//.test(href) && !href.startsWith('https://proofofstock.xyz')
          return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''}>${text}</a>`
        },
        table (token) {
          const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('')
          const body = token.rows.map((r) => '<tr>' + r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('') + '</tr>').join('')
          return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`
        },
        code ({ text, lang }) {
          return `<div class="code"><div class="code-bar"><span>${esc(lang || 'text')}</span></div><pre><code>${esc(text)}</code></pre></div>\n`
        },
      },
    })
    const body = rel === 'README.md' ? home() : marked.parse(md)
    // X, Telegram and, once the repository is public, GitHub: the same icons and order as the site's footer.
    const ICON = { 'x.com': ['x', 'Proof of Stock on X'], 't.me': ['tg', 'Proof of Stock on Telegram'] }
    const socials = '<span class="dx-social" aria-label="News and source">' + PROFILES.map((u) => { const [k, label] = ICON[new URL(u).hostname]; return `<a class="dx-ic" href="${esc(u)}" target="_blank" rel="me noopener noreferrer" aria-label="${label}"><span class="i i-${k}" aria-hidden="true"></span></a>` }).join('') +
      (sourceUrl ? `<a class="dx-ic" href="${esc(sourceUrl)}" target="_blank" rel="me noopener noreferrer" aria-label="Proof of Stock source on GitHub"><span class="i i-gh" aria-hidden="true"></span></a>` : '') + '</span>'
    const up = rel.split('/').length - 1
    const toRoot = up ? '../'.repeat(up) : './'
    const site = toRoot + '../'
    const href = (k) => (k === rel ? '#top' : toRoot + (k === 'README.md' ? '' : k))
    const section = nav.find((s) => s.items.includes(rel))
    const side = nav.map((s) => `<div class="side-sec"><div class="side-label">${esc(s.label)}</div>${s.items.map((k) =>
      `<a class="side-link${k === rel ? ' on' : ''}" href="${href(k)}"><span class="ic ic-${ICON[k] || 'doc'}" aria-hidden="true"></span>${esc(short(k))}</a>`).join('')}</div>`).join('')
    const idx = ordered.indexOf(rel)
    const prev = idx > 0 ? ordered[idx - 1] : null, next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null
    const pager = `<nav class="pager">${prev ? `<a class="pg prev" href="${href(prev)}"><span class="pg-dir">Previous</span><span class="pg-t">${esc(short(prev))}</span></a>` : '<span></span>'}${next ? `<a class="pg next" href="${href(next)}"><span class="pg-dir">Next</span><span class="pg-t">${esc(short(next))}</span></a>` : ''}</nav>`
    const tocHtml = toc.length > 1 ? `<nav class="toc" aria-label="On this page"><div class="side-label">On this page</div>${toc.map((t) => `<a class="toc-link d${t.depth}" href="#${t.id}">${esc(t.text)}</a>`).join('')}</nav>` : '<div></div>'
    const searchIndex = JSON.stringify(ordered.map((k) => ({ u: href(k) === '#top' ? '' : href(k), t: label(k), h: (docs.get(k).match(/^#{2,3}\s+(.+)$/gm) || []).map((x) => x.replace(/^#+\s+/, '').replace(/`/g, '')).slice(0, 40) }))).replace(/</g, '\\u003c')
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(plainTitle(md))} · Proof of Stock Docs</title>
  <meta name="description" content="${esc(leadOf(md) || plainTitle(md))}">
  <meta name="theme-color" content="#08090c">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23070C18'%3E%3C/rect%3E%3Ccircle cx='8' cy='8' r='7' fill='%234B87FF'%3E%3C/circle%3E%3Cpath d='M0 8h6V6h4v2h6v1H9V7H7v2H0z' fill='%23070C18'%3E%3C/path%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@300;400;600&amp;family=Onest:wght@400;500;600;700&amp;display=swap">
  <link rel="stylesheet" href="${site}${assets.css}">
  <link rel="stylesheet" href="${site}${assets.docsCss}">
  <link rel="alternate" type="text/markdown" href="?format=md">
  <script src="${site}${assets.docsJs}" defer></script>
  ${assets.beacon ? `<script src="${site}${assets.beacon}" defer></script>` : ''}
</head>
<body class="dx" id="top">
  <header class="dx-bar">
    <a class="dx-brand" href="${toRoot}"><span class="dx-logo" aria-hidden="true"></span><span>Proof of Stock</span><span class="dx-docs">Docs</span></a>
    <label class="dx-search"><span class="ic ic-search" aria-hidden="true"></span><input id="dx-q" type="search" placeholder="Search" autocomplete="off" spellcheck="false" aria-label="Search the docs"><kbd>⌘K</kbd><div id="dx-res" class="dx-res" hidden></div></label>
    <nav class="dx-links">
      <a href="${site}"><span class="ic ic-terminal" aria-hidden="true"></span>Terminal</a>
      <a href="${site}status"><span class="ic ic-pulse" aria-hidden="true"></span>Status</a>
      <a href="${toRoot}reference/tools.md"><span class="ic ic-code" aria-hidden="true"></span>MCP</a>
      ${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer"><span class="ic ic-gh" aria-hidden="true"></span>GitHub</a>` : ''}
    </nav>
    <a class="dx-cta" href="${toRoot}tutorials/connect-an-agent.md"><span aria-hidden="true">+</span> Connect an agent</a>
  </header>
  <div class="dx-shell">
    <aside class="dx-side" aria-label="Documentation">${side}</aside>
    <main class="dx-main">
      <div class="dx-crumbs">${section ? esc(section.label) : 'Docs'}<span class="dx-ver"><span class="beta-tag">beta</span>v${esc(version)} · ${esc(released)}</span></div>
      <article class="prose">${body}</article>
      ${pager}
      <footer class="dx-foot"><span>© 2026 Proof of Stock. Code under the MIT licence.</span><span><a href="${href('legal.md')}">Not investment advice</a> · <a href="?format=md">View as markdown</a></span>${socials}</footer>
    </main>
    ${tocHtml}
  </div>
  <script type="application/json" id="dx-index">${searchIndex}</script>
</body>
</html>`
  }

  // The docs home: a lede, the "never" card, the questions it answers, and the catalogs as cards.
  function home () {
    const cards = nav.filter((s) => s.label !== 'Overview').map((s) => `<section class="cat"><div class="side-label">${esc(s.label)}</div>${s.items.map((k) =>
      `<a class="cat-item" href="${k}"><span class="ic ic-${ICON[k] || 'doc'}" aria-hidden="true"></span><span class="cat-text"><span class="cat-title">${esc(label(k))}</span><span class="cat-lead">${esc(leadOf(docs.get(k)))}</span></span></a>`).join('')}</section>`).join('')
    const never = [
      ['Trade for you.', 'Every tool is read-only. Nothing here buys, sells or swaps.'],
      ['Ask for keys or a wallet.', 'No account, no wallet connection, no seed phrase. Ever.'],
      ['Sell a token.', 'There is no Proof of Stock token. Any one is fake.'],
      ['Tell you what to buy.', 'Facts with their time and source. Not advice.'],
    ].map(([t, d]) => `<div class="never-item"><span class="ic ic-no" aria-hidden="true"></span><div><b>${esc(t)}</b><span>${esc(d)}</span></div></div>`).join('')
    return `<h1>Welcome to Proof of Stock</h1>
<p class="lede">Check whether a token is the issuer's tokenized stock, what the issuer prices it at and how fresh that is, and how far the chain trades from it. Base and Robinhood Chain, for people, agents and code.</p>
<div class="never"><div class="never-head"><span class="ic ic-shield" aria-hidden="true"></span><b>Stay safe: Proof of Stock will never</b></div><div class="never-grid">${never}</div><div class="never-foot"><span class="ic ic-check" aria-hidden="true"></span>A token is the issuer's only if its exact contract is in the issuer's registry. A name proves nothing.</div></div>
<h2 id="three-questions">Three questions, three answers</h2>
<div class="qa">
  <a class="qa-item" href="how-to/check-before-listing.md"><span class="qa-q">Is this the real stock token?</span><code>/verify</code><code>verify_stock_tokens</code></a>
  <a class="qa-item" href="reference/passport.md#reference"><span class="qa-q">What does the issuer say it is worth?</span><code>stock_passport → reference</code></a>
  <a class="qa-item" href="reference/passport.md#latest"><span class="qa-q">How far does the chain trade from it?</span><code>stock_passport → latest.premium</code></a>
</div>
<div class="cats">${cards}</div>`
  }

  return { render, nav }
}
