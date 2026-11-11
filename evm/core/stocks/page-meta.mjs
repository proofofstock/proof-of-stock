// evm/core/stocks/page-meta.mjs — what a page says about itself before anyone opens it: the <title>, the canonical link,
// the Open Graph / Twitter tags that X, Farcaster, Telegram and messengers read for their preview, and JSON-LD.
//
// Pure. The server (apps/stocks-web.mjs) calls it when it serves the page, with whatever it already holds in memory —
// the registry record and the latest reading for a token in the link — and never fetches anything for a preview.
//
// ⚠ EVERY VALUE IS ESCAPED. A link can name any address, and a token outside the registry carries a name a stranger
// chose; it goes into an HTML attribute, so it is escaped here and nowhere else.

export const SITE_TITLE = 'Proof of Stock'
export const SITE_DESCRIPTION = 'Check whether a token is the issuer\'s stock token and how far its on-chain price is from the issuer price, on Base and Robinhood Chain.'
const CHAIN_LABEL = Object.freeze({ base: 'Base', robinhood: 'Robinhood Chain' })
const ISSUER_LABEL = Object.freeze({ coinbase: 'Coinbase', robinhood: 'Robinhood' })

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
const pct = (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(2) + '%'

/**
 * @param {object} p
 * @param {string} [p.chain]
 * @param {object} [p.record]    the issuer registry record, when the link names a registry token
 * @param {object} [p.latest]    its latest peg reading
 * @param {object} [p.impostor]  the impostor-list item, when the link names a listed impostor
 * @returns {{ title: string, description: string }}
 */
export function metaFor ({ chain, record, latest, impostor } = {}) {
  const where = CHAIN_LABEL[chain] || chain
  if (record) {
    const name = record.name ? ' (' + String(record.name).replace(/\s+Robinhood Token$/i, '') + ')' : ''
    const prem = latest && typeof latest.premium === 'number' ? `${pct(latest.premium)} vs the issuer's reference` : 'issuer reference and on-chain price'
    return {
      title: `${record.symbol}${name} on ${where}: ${prem} · ${SITE_TITLE}`,
      description: `Official ${ISSUER_LABEL[record.issuer] || record.issuer} stock token. Reference price with its age, on-chain price, premium by US market session and the same share on the other chain. Not advice.`,
    }
  }
  if (impostor) {
    // ⚠ The title is a sentence of ours that search engines and link previews repeat: it names the contract by its
    //   address and the ISSUER's symbol, never by the impostor's own symbol (its creator's text, untrusted-text.mjs).
    const short = (a) => (/^0x[0-9a-f]{40}$/.test(String(a)) ? 'Contract ' + a.slice(0, 6) + '…' + a.slice(-4) : 'A contract')
    return {
      title: impostor.registry_symbol || impostor.ticker
        ? `${short(impostor.address)} on ${where} is not the issuer's ${impostor.registry_symbol || impostor.ticker} · ${SITE_TITLE}`
        : `${short(impostor.address)} on ${where} copies the issuer's naming but is not its token · ${SITE_TITLE}`,
      description: `This contract is not in the issuer's registry, but its ${impostor.kind === 'registry_symbol' ? 'symbol is the same as' : 'name copies'} a listed stock token. See the official contract.`,
    }
  }
  return { title: SITE_TITLE, description: SITE_DESCRIPTION }
}


/** The organisation, the site and the product: one name (the owner's decision, 11.11). */
export const SITE_NAME = SITE_TITLE
/** The link-preview image (apps/stocks-web/og.png, from scripts/og/og.html). */
export const OG_IMAGE = Object.freeze({ width: 1200, height: 630, alt: 'Proof of Stock: is this stock token the issuer\'s? Check before you trade it. Base and Robinhood Chain.' })

/** JSON-LD as an inline data block. A browser does not execute it (CSP script-src stays 'self'); <, > and & are
 *  escaped, so no value can close the script element. */
export const jsonLdScript = (o) => '<script type="application/ld+json">' + JSON.stringify(o).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[c]) + '</script>'

/**
 * The tags that tell a crawler and a link preview what a page is: canonical link, robots, Open Graph, Twitter card,
 * JSON-LD. Every value comes in raw and is escaped here, once.
 * @param {object} p
 * @param {string} p.title
 * @param {string} p.description
 * @param {string} p.url         the canonical link of what is shown
 * @param {string} [p.image]     absolute URL of the 1200×630 preview image (OG_IMAGE); without one the card is a summary
 * @param {string} [p.robots]    e.g. 'noindex'
 * @param {string} [p.type]      og:type: 'website' or 'article'
 * @param {object} [p.jsonLd]
 * @param {string} [p.logo]      absolute URL of the 512×512 PNG icon: a favicon a search result can show, and the touch icon
 */
export function headTags ({ title, description, url, image, robots, type = 'website', jsonLd, logo }) {
  const t = escapeHtml(title), d = escapeHtml(description), u = escapeHtml(url), alt = escapeHtml(OG_IMAGE.alt)
  return [
    `<link rel="canonical" href="${u}">`,
    robots ? `<meta name="robots" content="${escapeHtml(robots)}">` : null,
    `<meta property="og:type" content="${escapeHtml(type)}">`, `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:title" content="${t}">`, `<meta property="og:description" content="${d}">`, `<meta property="og:url" content="${u}">`,
    ...(image ? [`<meta property="og:image" content="${escapeHtml(image)}">`, '<meta property="og:image:type" content="image/png">',
      `<meta property="og:image:width" content="${OG_IMAGE.width}">`, `<meta property="og:image:height" content="${OG_IMAGE.height}">`, `<meta property="og:image:alt" content="${alt}">`] : []),
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`, `<meta name="twitter:title" content="${t}">`, `<meta name="twitter:description" content="${d}">`,
    ...(image ? [`<meta name="twitter:image" content="${escapeHtml(image)}">`, `<meta name="twitter:image:alt" content="${alt}">`] : []),
    ...(logo ? [`<link rel="icon" type="image/png" sizes="512x512" href="${escapeHtml(logo)}">`, `<link rel="apple-touch-icon" href="${escapeHtml(logo)}">`] : []),
    jsonLd ? jsonLdScript(jsonLd) : null,
  ].filter(Boolean).join('\n  ')
}

/** Replace the page's <title> and fill the head tags at <!--og-->. `url` is the canonical link of what is shown;
 *  `extra` is the rest of headTags (image, robots, jsonLd). */
export function injectMeta (html, { title, description }, url, extra = {}) {
  const t = escapeHtml(title), d = escapeHtml(description)
  return String(html)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${d}">`)
    .replace('<!--og-->', () => headTags({ title, description, url, ...extra }))
}

const UNESCAPE = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'' })
const unescapeHtml = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => UNESCAPE[e])

/** What a rendered page already says about itself: its <title> and meta description (null when it has none). */
export function headOf (html) {
  const h = String(html)
  const title = h.match(/<title>([^<]*)<\/title>/), description = h.match(/<meta name="description" content="([^"]*)">/)
  return { title: title ? unescapeHtml(title[1]) : '', description: description ? unescapeHtml(description[1]) : null }
}

/**
 * Add the head tags to a page another module rendered (docs, /status, /history), from that page's own title and
 * description. `description` is used only where the page has none, and is then added as its meta description too.
 */
export function withHead (html, { description, ...p }) {
  const own = headOf(html)
  const d = own.description ?? description ?? ''
  const add = (own.description == null && d ? `<meta name="description" content="${escapeHtml(d)}">\n  ` : '') + headTags({ title: own.title, description: d, ...p })
  return String(html).replace('</head>', () => '  ' + add + '\n</head>')
}
