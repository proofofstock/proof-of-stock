// apps/stocks-web/docs.js: the docs search box: titles and section headings of every page, filtered as you type.
// ⌘K / Ctrl+K or "/" focuses it, arrows move, Enter opens. The pages read fully without this script.
'use strict'
;(function () {
  const q = document.getElementById('dx-q'), box = document.getElementById('dx-res'), raw = document.getElementById('dx-index')
  if (!q || !box || !raw) return
  let index = []
  try { index = JSON.parse(raw.textContent) } catch (_) { return }
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const entries = []
  for (const p of index) {
    entries.push({ title: p.t, where: '', url: p.u || '#top' })
    for (const h of p.h || []) entries.push({ title: h, where: p.t, url: (p.u || '') + '#' + slug(h) })
  }
  let hits = [], at = 0
  function draw () {
    box.replaceChildren()
    if (!hits.length) { box.hidden = !q.value.trim(); if (q.value.trim()) { const e = document.createElement('div'); e.className = 'dx-none'; e.textContent = 'Nothing found'; box.append(e) } return }
    hits.forEach((h, i) => {
      const a = document.createElement('a'); a.href = h.url; a.className = 'dx-hit' + (i === at ? ' on' : '')
      const t = document.createElement('span'); t.className = 'dx-hit-t'; t.textContent = h.title
      a.append(t)
      if (h.where) { const w = document.createElement('span'); w.className = 'dx-hit-w'; w.textContent = h.where; a.append(w) }
      box.append(a)
    })
    box.hidden = false
  }
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase()
    at = 0
    hits = s ? entries.filter((e) => e.title.toLowerCase().includes(s)).slice(0, 8) : []
    draw()
  })
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { at = Math.min(hits.length - 1, at + 1); draw(); e.preventDefault() }
    else if (e.key === 'ArrowUp') { at = Math.max(0, at - 1); draw(); e.preventDefault() }
    else if (e.key === 'Enter' && hits[at]) { location.href = hits[at].url }
    else if (e.key === 'Escape') { q.value = ''; hits = []; draw(); q.blur() }
  })
  q.addEventListener('blur', () => setTimeout(() => { box.hidden = true }, 150))
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && document.activeElement !== q)) { e.preventDefault(); q.focus(); q.select() }
  })
})()
