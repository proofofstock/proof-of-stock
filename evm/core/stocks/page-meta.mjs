// evm/core/stocks/page-meta.mjs — what a shared link to the passport page says before anyone opens it: the <title> and
// the Open Graph / Twitter tags that X, Telegram and messengers read for their preview.
//
// Pure. The server (apps/stocks-web.mjs) calls it when it serves the page, with whatever it already holds in memory —
// the registry record and the latest reading for a token in the link — and never fetches anything for a preview.
//
// ⚠ EVERY VALUE IS ESCAPED. A link can name any address, and a token outside the registry carries a name a stranger
// chose; it goes into an HTML attribute, so it is escaped here and nowhere else.

export const SITE_TITLE = 'Stock Token Passport'
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
    return {
      title: impostor.registry_symbol || impostor.ticker
        ? `${impostor.symbol || 'Token'} on ${where} is not the issuer's ${impostor.registry_symbol || impostor.ticker} · ${SITE_TITLE}`
        : `${impostor.symbol || 'Token'} on ${where} copies the issuer's naming but is not its token · ${SITE_TITLE}`,
      description: `This contract is not in the issuer's registry, but its ${impostor.kind === 'registry_symbol' ? 'symbol is the same as' : 'name copies'} a listed stock token. See the official contract.`,
    }
  }
  return { title: SITE_TITLE, description: SITE_DESCRIPTION }
}

/** Replace the page's <title> and fill the preview tags. `url` is the canonical link of what is shown. */
export function injectMeta (html, { title, description }, url) {
  const t = escapeHtml(title), d = escapeHtml(description), u = escapeHtml(url)
  const tags = [
    `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="${escapeHtml(SITE_TITLE)}">`,
    `<meta property="og:title" content="${t}">`, `<meta property="og:description" content="${d}">`, `<meta property="og:url" content="${u}">`,
    `<meta name="twitter:card" content="summary">`, `<meta name="twitter:title" content="${t}">`, `<meta name="twitter:description" content="${d}">`,
  ].join('\n  ')
  return String(html)
    .replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`)
    .replace('<!--og-->', tags)
}
