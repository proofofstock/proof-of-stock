// beacon.js — our own visit counter (docs/legal.md "What we count"). It tells the server which page was shown, for how
// many visible seconds, which passport was open and the referring site's host. No cookie, no storage, no identifier: the
// server derives a pseudonym that changes every day (apps/stocks-analytics.mjs).
(() => {
  const me = document.currentScript && document.currentScript.src
  if (!me || !window.fetch) return
  const endpoint = new URL('api/hit', me)
  const root = new URL('./', me).pathname
  const page = () => '/' + location.pathname.slice(root.length).replace(/\/index\.html$/, '')
  const token = () => {
    const q = new URLSearchParams(location.search)
    const c = q.get('chain')
    if (c && q.get('address')) return { c, a: q.get('address') }
    for (const k of ['base', 'robinhood']) if (q.get(k)) return { c: k, s: q.get(k) }
    return {}
  }
  let ref = ''
  try { const r = document.referrer && new URL(document.referrer); if (r && r.host !== location.host) ref = r.hostname } catch (_) {}
  const send = (k, extra) => {
    const q = new URLSearchParams({ k, p: page(), ...token(), ...extra })
    if (ref) q.set('r', ref)
    try { fetch(endpoint + '?' + q, { keepalive: true, credentials: 'omit', cache: 'no-store' }).catch(() => {}) } catch (_) {}
  }
  let since = document.visibilityState === 'visible' ? Date.now() : null
  let viewed = false
  const show = () => { if (!viewed) { viewed = true; send('view') } if (since == null) since = Date.now() }
  const hide = () => { if (since == null) return; const t = Math.round((Date.now() - since) / 1000); since = null; send('hide', { t: String(t) }) }
  if (since != null) show()
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? show() : hide()))
  addEventListener('pagehide', hide)
  // The terminal changes its URL when a passport opens: close the old page's time and count the new one.
  const wrap = (name) => { const f = history[name]; history[name] = function (...a) { const before = location.href; const r = f.apply(this, a); if (location.href !== before && document.visibilityState === 'visible') { hide(); viewed = false; show() } return r } }
  wrap('pushState'); wrap('replaceState')
  addEventListener('popstate', () => { if (document.visibilityState === 'visible') { hide(); viewed = false; show() } })
})()
