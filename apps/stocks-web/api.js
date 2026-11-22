// apps/stocks-web/api.js: the copy buttons on /api (apps/stocks-api-page.mjs). The page reads fully without it: the
// buttons are hidden until this script shows them, so a reader that runs no script never meets a dead one.
'use strict'
;(function () {
  for (const b of document.querySelectorAll('.ap-copy[data-copy]')) {
    const src = document.getElementById(b.dataset.copy)
    if (!src) continue
    b.hidden = false
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(src.textContent); b.textContent = 'Copied' } catch (_) { b.textContent = 'Select and copy' }
      setTimeout(() => { b.textContent = 'Copy' }, 1600)
    })
  }
})()
