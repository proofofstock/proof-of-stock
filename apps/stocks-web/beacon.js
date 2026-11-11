// beacon.js — our own visit counter (docs/legal.md "What we count"). It tells the server which page was shown, for how
// many visible seconds, which passport was open, the referring site's host, and what was done there as a KIND of action
// (which button, what kind of search and whether it found anything; never the text). No cookie, no storage, no identifier: the
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
  // What is on screen: page and passport, taken when it is shown. A hide reports the view it closes, not the URL the
  // terminal has already moved to (it used to credit passport A's seconds to the passport B that replaced it).
  const here = () => ({ p: page(), ...token() })
  let shown = null
  const send = (k, ctx, extra) => {
    const q = new URLSearchParams({ k, ...ctx, ...extra })
    if (ref) q.set('r', ref)
    try { fetch(endpoint + '?' + q, { keepalive: true, credentials: 'omit', cache: 'no-store' }).catch(() => {}) } catch (_) {}
  }
  let since = document.visibilityState === 'visible' ? Date.now() : null
  let viewed = false
  const show = () => { if (!viewed) { viewed = true; shown = here(); send('view', shown) } if (since == null) since = Date.now() }
  const hide = () => { if (since == null) return; const t = Math.round((Date.now() - since) / 1000); since = null; send('hide', shown || here(), { t: String(t) }) }
  if (since != null) show()
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? show() : hide()))
  addEventListener('pagehide', hide)
  // The terminal changes its URL when a passport opens: close the old page's time and count the new one.
  const wrap = (name) => { const f = history[name]; history[name] = function (...a) { const before = location.href; const r = f.apply(this, a); if (location.href !== before && document.visibilityState === 'visible') { hide(); viewed = false; show() } return r } }
  wrap('pushState'); wrap('replaceState')

  // ---- actions, as kinds (apps/stocks-analytics.mjs ACTIONS; the server drops anything else) ----
  const act = (x, v) => send('act', { p: page() }, { x, v: String(v) })
  // What the terminal decided (a search's kind and outcome, a typed command): app.js says it with a pos:act event.
  document.addEventListener('pos:act', (e) => { const d = e.detail || {}; if (d.x && d.v) act(d.x, d.v) })
  const OUT = [[/(^|\.)geckoterminal\.com$/, 'gecko'], [/(^|\.)(basescan\.org|explorer\.|blockscout)/, 'explorer'], [/(^|\.)github\.com$/, 'github'], [/(^|\.)(coinbase\.com|robinhood\.com)$/, 'registry']]
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null
    if (!el) return
    const run = el.closest('.hero [data-run]'); if (run) return act('chip', run.dataset.run)
    const tab = el.closest('.tab[data-chain]'); if (tab) return act('tab', tab.dataset.chain)
    const copy = el.closest('[data-copy]'); if (copy) return act('copy', copy.dataset.copy)
    if (el.closest('.addr-copy')) return act('copy', 'address')
    const a = el.closest('a[href]')
    if (a) { try { const u = new URL(a.href, location.href); if (u.host !== location.host) act('out', (OUT.find(([re]) => re.test(u.hostname)) || [, 'other'])[1]) } catch (_) {} }
  }, true)
  // Which question was opened: its place in the list, not its text.
  for (const [i, d] of [...document.querySelectorAll('.faq details')].entries()) d.addEventListener('toggle', () => { if (d.open) act('faq', 'q' + (i + 1)) })
  // How far down the landing a visitor got: each section once per page load, when half of it is on screen.
  if ('IntersectionObserver' in window) {
    const SECTIONS = [['.checks', 'checks'], ['.why', 'why'], ['.agents', 'agents'], ['.faq', 'faq'], ['.foot', 'foot']]
    const seen = new Set()
    const io = new IntersectionObserver((es) => { for (const en of es) { const n = en.target.dataset.posSection; if (en.isIntersecting && !seen.has(n)) { seen.add(n); act('section', n); io.unobserve(en.target) } } }, { threshold: 0.5 })
    for (const [sel, n] of SECTIONS) { const el = document.querySelector(sel); if (el) { el.dataset.posSection = n; io.observe(el) } }
  }
  addEventListener('popstate', () => { if (document.visibilityState === 'visible') { hide(); viewed = false; show() } })
})()
