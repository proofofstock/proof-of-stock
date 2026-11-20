// apps/stocks-web/seal.js: the "we cannot rewrite yesterday" block on the landing. One real line of our record, the
// seal of the day it belongs to, and a visitor who is invited to rewrite the answer and watch the seal stop fitting.
//
// What is real here, and what is drawn. The record is a case event from the public archive (api/history/cases). The
// seal is the SHA-256 of that day's manifest, computed IN THE BROWSER from the manifest's own bytes (anchors/) and
// compared with the hash our Base transaction carries (anchors/mirror-<day>.json). The block stays hidden unless the
// two are equal and the mirror was confirmed by a node that is not the chain's operator: a block about proof that
// showed "sealed" on our say-so would be the one thing it argues against. What is drawn: the 64 squares are the 64
// hex digits of the hash, coloured; and a visitor's rewrite changes the hash of the day's cases file in the manifest,
// which is what rewriting a line of that file would do. Nothing a visitor does here leaves the page.
//
//   SEAL.pickCases()  the case events worth showing, newest first, then one pinned case that is always sealed;
//                     each says whether its day has a Bitcoin check on file (`checked`)
//   SEAL.dailyOrder() those cases, the newest sealed day first, so the block shows that the seal is set every night;
//                     within one day the record rotates by today's date, the same for everyone that day
//   SEAL.sealOf()     the Base mirror of a day, only if it is confirmed, witnessed and carries this very hash
//   SEAL.rewrite()    the manifest as it would read after the record was changed
// Every value goes into the page as TEXT: a token's symbol and name are its creator's words.
'use strict'
const SEAL = (function () {
  const DAY = /^\d{4}-\d{2}-\d{2}$/
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/
  const TX = /^0x[0-9a-f]{64}$/
  const HEX64 = /^[0-9a-f]{64}$/
  const SYMBOL = /^[A-Za-z0-9.]{1,15}$/
  // A case from the archive whose day is anchored in Bitcoin and mirrored on Base. Shown when the 7-day window holds no
  // sealed case of its own, so that the block does not depend on a look-alike having turned up this week.
  const PINNED = Object.freeze({ day: '2026-11-14', at: '2026-11-14T06:23:50Z', address: '0x77d1db15e423762aff479ecd67c49bf6bdbf4ba3', symbol: 'HOG', name: 'Harley-Davidson', imitates: 'HOGc' })

  async function sha256Hex (data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** Opened cases whose day has a mirror file, newest first as the archive gives them, then the pinned one. */
  function pickCases (events, days) {
    const sealed = new Map((Array.isArray(days) ? days : []).filter((d) => d && DAY.test(d.day) && d.mirror).map((d) => [d.day, Boolean(d.btc_check)]))
    const out = []
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || e.event !== 'opened') continue
      const day = String(e.at || '').slice(0, 10)
      if (!sealed.has(day) || !ADDRESS.test(e.address || '') || !SYMBOL.test(e.imitates_symbol || '')) continue
      out.push({ day, at: String(e.at), address: e.address.toLowerCase(), symbol: String(e.symbol || '').slice(0, 15), name: String(e.name || '').slice(0, 32), imitates: e.imitates_symbol, checked: sealed.get(day) })
    }
    if (!out.some((c) => c.day === PINNED.day && c.address === PINNED.address)) out.push({ ...PINNED, checked: sealed.get(PINNED.day) === true })
    return out
  }

  /** The Base mirror of a day's hash: { tx, block, sent_at }, or null unless it is confirmed, witnessed and about `hash`. */
  function sealOf (mirror, hash, chain = 'base') {
    if (!HEX64.test(hash || '') || !mirror || mirror.sha256 !== hash) return null
    const m = (Array.isArray(mirror.mirrors) ? mirror.mirrors : []).find((x) => x && x.chain === chain)
    if (!m || m.status !== 'confirmed' || m.sha256 !== hash || !TX.test(m.tx || '')) return null
    if (!Array.isArray(m.witnessed_by) || !m.witnessed_by.length) return null
    return { tx: m.tx, block: Number.isInteger(m.block) ? m.block : null, sent_at: String(m.sent_at || '') }
  }

  /** The Bitcoin block a day's proof was checked against, or null while it is still pending. */
  function bitcoinOf (check) {
    const c = (check && Array.isArray(check.checks) ? check.checks : []).find((x) => x && Number.isInteger(x.height) && x.height > 0)
    return c ? c.height : null
  }

  /** The manifest text after a line of the day's Base cases file was rewritten: that file's hash changes, so the manifest does. */
  async function rewrite (text) {
    let m
    try { m = JSON.parse(text) } catch (_) { return null }
    if (!m || !Array.isArray(m.files) || !m.files.length) return null
    const f = m.files.find((x) => x && x.chain === 'base' && /^history\/cases-/.test(x.file || '')) || m.files[0]
    if (!f || !HEX64.test(f.sha256 || '')) return null
    f.sha256 = await sha256Hex(f.sha256 + ':rewritten')
    return JSON.stringify(m, null, 2) + '\n'
  }

  /**
   * The cases in the order the page tries them on `day` (YYYY-MM-DD, UTC): the newest sealed day first, then the older
   * ones, newest first (owner, 20.11: a week-old record on top cannot show that last night's seal was set). Within one day
   * the cases rotate by `day`, so the record changes daily and is the same for every visitor that day. The page shows
   * the first whose seal checks out, so a newest day whose mirror is not confirmed yet falls through to the day before;
   * the pinned case stays last.
   */
  function dailyOrder (cases, day) {
    const list = Array.isArray(cases) ? cases : []
    const real = list.filter((c) => !(c.day === PINNED.day && c.address === PINNED.address))
    const pinned = list.filter((c) => !real.includes(c))
    const byDay = new Map()
    for (const c of real) { if (!byDay.has(c.day)) byDay.set(c.day, []); byDay.get(c.day).push(c) }
    const k = DAY.test(day || '') ? Math.floor(Date.parse(day + 'T00:00:00Z') / 864e5) : 0
    const out = [...byDay.keys()].sort().reverse().flatMap((d) => { const g = byDay.get(d), i = k % g.length; return g.slice(i).concat(g.slice(0, i)) })
    return out.concat(pinned)
  }

  const differ = (a, b) => [...a].filter((c, k) => c !== b[k]).length
  const colour = (c) => { const v = parseInt(c, 16); return `hsl(${212 + v * 7} ${58 + (v % 4) * 8}% ${24 + v * 3.6}%)` }

  /** The one line a day's Base transaction carries, word for word (scripts/stocks/anchor-mirror.mjs anchorCalldata);
   *  a mirror is confirmed only after a witness has read exactly this back from the chain. */
  /** When a day was sealed: the manifest's own built_at (it is stamped into Bitcoin then), if it falls after the day it
   *  covers; otherwise the mirror's send time. A mirror sent later (the mirrors began on 14 Nov and copied older days)
   *  is a copy, not the seal. */
  function sealedAt (text, day, fallback) {
    let at = null
    try { at = JSON.parse(text).built_at } catch (_) { /* no manifest date */ }
    const t = Date.parse(at || ''), end = Date.parse((day || '') + 'T00:00:00Z') + 864e5
    return Number.isFinite(t) && Number.isFinite(end) && t >= end ? new Date(t).toISOString() : String(fallback || '')
  }

  const wireLine = (day, hash) => DAY.test(day || '') && HEX64.test(hash || '') ? `proofofstock anchor ${day} sha256:${hash}` : null

  return { PINNED, sha256Hex, pickCases, dailyOrder, sealOf, bitcoinOf, rewrite, differ, colour, wireLine, sealedAt }
})()

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id)
  const root = $('seal')
  if (!root || !window.crypto || !crypto.subtle) return
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches
  const json = async (path) => { const r = await fetch(path, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(path + ' ' + r.status); return r.json() }
  const el = (tag, text) => { const e = document.createElement(tag); if (text != null) e.textContent = text; return e }
  const dayOf = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'

  /** The first candidate whose seal checks out in this browser, with everything the block draws; null if none does. */
  async function find () {
    const [cases, list] = await Promise.all([json('api/history/cases?chain=base&event=opened').catch(() => ({})), json('anchors/')])
    const today = new Date().toISOString().slice(0, 10)
    for (const c of SEAL.dailyOrder(SEAL.pickCases(cases.events, list.days), today).slice(0, 3)) {
      try {
        const r = await fetch(`anchors/manifest-${c.day}.json`)
        if (!r.ok) continue
        const bytes = await r.arrayBuffer()
        const hash = await SEAL.sha256Hex(bytes)
        const mirror = await json(`anchors/mirror-${c.day}.json`)
        const seal = SEAL.sealOf(mirror, hash)
        const robinhood = SEAL.sealOf(mirror, hash, 'robinhood')
        const changed = seal && await SEAL.rewrite(new TextDecoder().decode(bytes))
        if (!changed) continue
        // Asked for only when the listing names it: for the newest day it does not exist yet, and a request that
        // can only answer 404 is an error in a reader's console for nothing.
        const bitcoin = c.checked ? await json(`anchors/btc-check-${c.day}.json`).then(SEAL.bitcoinOf, () => null) : null
        const sealed = SEAL.sealedAt(new TextDecoder().decode(bytes), c.day, seal.sent_at)
        return { c, hash, other: await SEAL.sha256Hex(changed), seal, robinhood, bitcoin, sealed }
      } catch (_) { /* this candidate cannot be shown; the next one may */ }
    }
    return null
  }

  find().then((s) => { if (s) draw(s) }, () => {})

  function draw ({ c, hash, other, seal, robinhood, bitcoin, sealed }) {
    // The page may hide Robinhood Chain (index.html <body class="no-rh">); the mirrors named here follow it.
    const mirrors = document.body.classList.contains('no-rh') ? 'Base' : 'Base and Robinhood Chain'
    let run = 0, rewritten = false, touched = false // a replay or a click starts a new run; timers of an older run do nothing
    const later = (ms, fn) => { const mine = run; setTimeout(() => { if (mine === run) fn() }, still ? 0 : ms) }
    const mosaic = (box) => { for (let k = 0; k < 64; k++) box.append(el('i')); return [...box.children] }
    const kept = mosaic($('seal-kept')), now = mosaic($('seal-now'))
    function paint (cells, hex, step) {
      cells.forEach((cell, k) => {
        const want = hex ? SEAL.colour(hex[k]) : ''
        if (cell.dataset.c === want) return
        cell.dataset.c = want
        const set = () => { cell.style.background = want; cell.classList.remove('flip') }
        if (!step || still) return set()
        cell.classList.add('flip'); later(120 + k * step, set)
      })
    }
    const sealedOn = dayOf(sealed)
    $('seal-when').textContent = `Our record · Base · ${dayOf(c.at)} · ${timeOf(c.at)}`
    const token = $('seal-token')
    token.append(el('b', c.symbol || '?'), el('span', c.name), el('code', c.address.slice(0, 6) + '…' + c.address.slice(-4)))
    $('seal-question').textContent = 'On Coinbase\'s list?'
    const rows = [...$('seal-rec').children], answer = $('seal-answer'), strip = $('seal-strip')
    function say (cls, head, body) {
      strip.className = 'seal-strip' + (cls ? ' ' + cls : '')
      $('seal-say').replaceChildren(el('strong', head), el('span', body))
    }
    // What actually goes on the chain, word for word: one line a day, not the record.
    $('seal-wire-line').textContent = SEAL.wireLine(c.day, hash)
    $('seal-wire-tx').href = 'https://basescan.org/tx/' + seal.tx
    const rh = $('seal-wire-rh')
    if (robinhood) { rh.href = 'https://robinhoodchain.blockscout.com/tx/' + robinhood.tx; rh.hidden = false; $('seal-wire-rh-sep').hidden = false }
    /** The state at rest: recorded, sealed, and compared with the record as it stands now. */
    function settle (step) {
      rows.forEach((r) => r.classList.remove('off'))
      const text = $('seal-answer-text')
      text.replaceChildren(...(rewritten ? [el('s', `No, a look-alike of ${c.imitates}`), 'Yes, genuine'] : [`No, a look-alike of ${c.imitates}`]))
      answer.className = 'seal-edit' + (rewritten ? ' changed' : '') + (touched ? '' : ' beacon')
      answer.setAttribute('aria-label', rewritten ? 'Put our answer back' : 'Rewrite our answer to: Yes, genuine')
      $('seal-card').classList.toggle('broken', rewritten)
      $('seal-lock').className = 'seal-lock' + (rewritten ? ' broken' : '')
      $('seal-lock-text').textContent = rewritten ? 'Seal broken' : 'Sealed ' + sealedOn
      $('seal-undo').hidden = !rewritten
      $('seal-hint').textContent = rewritten ? '' : touched ? 'Back to what we recorded.' : 'Click the highlighted answer to rewrite it.'
      $('seal-hint').className = touched ? 'done' : ''
      paint(kept, hash); paint(now, rewritten ? other : hash, step)
      $('seal-eq').textContent = rewritten ? '≠' : '='
      if (rewritten) say('no', 'Caught: changed after it was sealed.', `One answer changed, and ${SEAL.differ(other, hash)} of 64 squares changed with it. The seal in Bitcoin still holds the old pattern, and nobody can change that, not you and not us. So the change shows.`)
      else say('', 'Untouched: exactly what was sealed.', bitcoin ? `Your browser just computed this seal from the day's files. The same one is kept in Bitcoin (block ${bitcoin}), where nobody can change it, and mirrored on ${mirrors}.` : `Your browser just computed this seal from the day's files. The same one is mirrored on ${mirrors} already, and on its way into Bitcoin, where nobody can change it.`)
    }
    answer.addEventListener('click', () => { run++; touched = true; rewritten = !rewritten; settle(9) })
    $('seal-undo').addEventListener('click', () => { run++; rewritten = false; settle(9) })
    $('seal-replay').addEventListener('click', () => {
      run++; rewritten = false; touched = false; settle(0)
      if (still) return
      rows.forEach((r) => r.classList.add('off')); $('seal-lock').className = 'seal-lock off'; $('seal-hint').textContent = ''
      paint(kept, null); paint(now, null); $('seal-eq').textContent = ''
      say('idle', '1. We write down what we see.', 'All day, every finding goes into the record.')
      rows.forEach((r, i) => later(300 + i * 420, () => r.classList.remove('off')))
      later(1900, () => paint(now, hash, 12))
      later(3200, () => { say('idle', '2. That night we seal the day.', `The whole record becomes one pattern, kept in Bitcoin and mirrored on ${mirrors}.`); $('seal-lock').className = 'seal-lock'; paint(kept, hash, 12) })
      later(4600, () => { $('seal-eq').textContent = '=' })
      later(5600, () => { settle(0); say('', '3. Now nobody can change it unseen.', 'Not even us. Try: rewrite the highlighted answer above.') })
    })
    settle(0)
    root.hidden = false
  }
})
