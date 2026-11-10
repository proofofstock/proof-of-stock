// apps/stocks-web/app.js — the Stock Token Passport as a terminal. Every value goes into the page as TEXT (textContent),
// never as HTML: names of tokens outside the registry come from third parties and may contain markup.
//
//   run()       parses a command: help, how, now, matrix, fakes, clear, both/base/robinhood, a number from the last list;
//               anything else is a search
//   block()     adds a "command → answer" block to the feed; reveal() scrolls to it
//   lookup()    searches (api/find); one match opens the passport, several give a numbered list
//   passport()  fetches a passport; render() draws it: stamp, fields, plain-language line, notes, folded tables
//   bottomLine() the "In short:" sentence
//   boot()      the greeting, typed out unless the page was opened from a link or the reader asked for less motion
'use strict'
;(function () {
  const $ = (s) => document.querySelector(s)
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v)
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid))
    return el
  }
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/
  const CHAINS = ['base', 'robinhood']
  const CHAIN_LABEL = { all: 'both', base: 'Base', robinhood: 'Robinhood Chain' }
  const ISSUER_LABEL = { coinbase: 'Coinbase', robinhood: 'Robinhood' }
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches
  // The filter. Base is the default: the product is built on Base and Coinbase's registry; 'all' adds Robinhood Chain.
  let chain = 'base'
  let lastList = []         // the numbered matches the reader can pick from
  const past = []           // command history: this tab only, never stored
  let hpos = 0

  // ---------- formatting ----------
  // An empty value in a table reads n/a; in a passport field it is left blank, with the reason beside it.
  const NA = 'n/a'
  const blank = (v) => (v === NA ? '' : v)
  const usd = (x) => (x == null ? NA : '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: x >= 100 ? 2 : 4 }))
  const big = (x) => (x == null ? NA : '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x))
  const pct = (x) => (x == null ? NA : (x > 0 ? '+' : '') + (x * 100).toFixed(2) + '%')
  // The on-chain price against the issuer's: above it green, below it red, as a market reader expects; under 0.5% it is
  // noise and stays neutral, and beyond 2% it is bold. (Until 10.11 the colour was the gap's size whatever its sign, amber
  // then red, which read as "a rise is red".)
  const sign = (x) => (x == null || Math.abs(x) < 0.005 ? '' : (x > 0 ? 'up' : 'down') + (Math.abs(x) >= 0.02 ? ' wide' : ''))
  const mult = (m) => (m == null ? NA : '×' + String(+Number(m).toFixed(6)))
  const age = (s) => {
    if (s == null) return 'time unknown'
    if (s < 90) return s + ' s ago'
    if (s < 5400) return Math.round(s / 60) + ' min ago'
    if (s < 172800) return Math.round(s / 3600) + ' h ago'
    return Math.round(s / 86400) + ' days ago'
  }
  const SESSION = { regular: 'US market open', pre: 'pre-market', post: 'after hours', closed: 'US market closed', unknown: 'market calendar unknown' }
  const REF_KIND = { nav_total_return: 'Coinbase NAV', token_bid_ask_mid: 'Robinhood bid/ask' }
  // Codes from the API → [text, kind]. kind: info | warn | bad. New codes go here.
  const NOTES = {
    not_in_registry: ['This address is not in the issuer\'s registry.', 'bad'],
    no_readings: ['No price readings recorded for this token yet.', 'info'],
    no_reference: ['The issuer publishes no reference price for this token.', 'warn'],
    reference_held_market_closed: ['The issuer price does not move outside regular US trading hours. On-chain prices can drift from it until the next session.', 'info'],
    reference_held_market_open: ['The issuer price has not updated even though the US market is open.', 'warn'],
    trading_halted: ['The issuer reports a trading halt.', 'warn'],
    paused: ['The issuer has paused some token features.', 'warn'],
    no_dex_price: ['No on-chain pool is deep enough (≥ $10k) to price this token.', 'info'],
    pools_capped: ['It trades in more pools than our sources list, so the pool count is a minimum.', 'info'],
    multiplier_change_pending: ['A multiplier change (corporate action) is pending.', 'warn'],
    calendar_unknown: ['The market calendar does not cover this date.', 'info'],
    reference_spread_wide: ['The issuer\'s bid and ask are too far apart right now to use as one price, so there is no difference to show.', 'warn'],
    not_minted: ['Listed by the issuer, but not minted on this chain yet.', 'info'],
    reading_stale: ['Our latest reading is more than 30 minutes old. It shows the last one we have and may be out of date.', 'warn'],
  }

  // ---------- the feed ----------
  const log = () => $('#log')
  // Scroll the feed itself, never the page: scrollIntoView would also move the window off the top on a phone.
  function reveal (el) { requestAnimationFrame(() => { const lg = log(); lg.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: REDUCED ? 'auto' : 'smooth' }) }) }
  /** A "command → answer" block. Returns the answer container. */
  function block (command) {
    const out = h('div', { class: 'out' })
    const b = h('div', { class: 'block' }, command != null ? h('div', { class: 'echo' }, h('b', null, h('span', { class: 'i i-chev', 'aria-hidden': 'true' }), ' '), h('span', null, command)) : null, out)
    log().append(b)
    reveal(b)
    return out
  }
  const line = (text, cls) => h('div', { class: 'line' + (cls ? ' ' + cls : '') }, text)
  const mark = (c) => h('span', { class: 'chainmark ' + c }, CHAIN_LABEL[c] || c)

  async function api (path) {
    const r = await fetch(path, { headers: { accept: 'application/json' } })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || ('request failed: ' + r.status))
    return body
  }

  // ---------- chain and URL ----------
  function setChain (c, push) {
    chain = c
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.chain === c))
    $('.chain-ps1').textContent = c === 'all' ? 'both' : c
    if (push) syncUrl({})
  }
  function syncUrl (o) {
    const u = new URL(location.href)
    u.search = ''
    // An issuer-listed token has a short, readable link: ?base=NVDAc. Anything else is named by its address.
    if (o.listedOn && o.symbol) { u.searchParams.set(o.listedOn, o.symbol); return window.history.replaceState(null, '', u) }
    const c = o.chain || (chain !== 'all' ? chain : null)
    if (c) u.searchParams.set('chain', c)
    if (o.q) u.searchParams.set('q', o.q)
    if (o.address) u.searchParams.set('address', o.address)
    window.history.replaceState(null, '', u)
  }

  // ---------- commands ----------
  function run (raw) {
    const input = String(raw || '').trim()
    if (!input) return
    if (past[past.length - 1] !== input) past.push(input)
    hpos = past.length
    const cmd = input.toLowerCase()
    if (cmd === 'help' || cmd === '?') return help(input)
    if (cmd === 'how') return how(input)
    if (cmd === 'clear' || cmd === 'cls') { log().replaceChildren(); return }
    if (cmd === 'now') return board(input)
    if (cmd === 'matrix') return matrixView(input)
    if (cmd === 'fakes' || cmd === 'impostors') return fakes(input)
    if (cmd === 'both' || cmd === 'all' || CHAINS.includes(cmd)) {
      const c = cmd === 'both' ? 'all' : cmd
      setChain(c, true)
      block(input).append(line(c === 'all' ? 'Searching both chains.' : 'Searching ' + CHAIN_LABEL[c] + ' only (' + (c === 'base' ? 'Coinbase' : 'Robinhood') + ' tokens).', 'muted'))
      return
    }
    if (/^\d{1,2}$/.test(cmd) && lastList.length) {
      const m = lastList[Number(cmd) - 1]
      if (m) return passport(m.chain, m.address, input)
      block(input).append(line('No item ' + cmd + ' in the last list.', 'err'))
      return
    }
    lookup(input)
  }

  function help (input) {
    const out = block(input)
    const rows = [
      ['NVDA, Tesla, US67066G1040', 'find a stock token by ticker, company or ISIN'],
      ['0x address', 'check any contract: listed by its issuer or not'],
      ['1, 2, 3', 'open an item from the last list'],
      ['both · base · robinhood', 'choose the chains to search'],
      ['now', 'on-chain prices against the issuer price right now'],
      ['matrix', 'the same share on Base and Robinhood: each premium and the gap'],
      ['impostors', 'tokens using a listed stock\'s name, not in the issuer\'s registry'],
      ['how', 'what this checks'],
      ['clear', 'clear the screen'],
    ]
    out.append(...rows.map(([k, v]) => h('div', { class: 'field' }, h('span', { class: 'k' }, k), h('span', { class: 'dots-fill' }), h('span', { class: 'v muted' }, v))))
  }
  function how (input) {
    const out = block(input)
    out.append(
      line('Stock tokens trade on-chain all day and all week. The exchange does not.', ''),
      line('1. Identity. A token is the issuer\'s stock token only if its contract address is in the issuer\'s registry (Coinbase on Base, Robinhood on Robinhood Chain). The name does not count.', 'muted'),
      line('2. Reference. The issuer\'s price for one token and how old it is. It stops moving while the US market is closed.', 'muted'),
      line('3. Premium. How far the deepest on-chain pool is from that price, checked every 15 minutes.', 'muted'),
      line('Data with its time and source. Not advice.', 'faint'))
  }

  // ---------- search ----------
  async function lookup (q) {
    const out = block(q)
    if (ADDRESS.test(q)) return passportAnywhere(q.toLowerCase(), out)
    out.append(line('searching ' + (chain === 'all' ? 'both chains' : CHAIN_LABEL[chain]) + '', 'faint typing'))
    syncUrl({ q })
    try {
      const r = await api(`api/find?q=${encodeURIComponent(q)}${chain !== 'all' ? '&chain=' + encodeURIComponent(chain) : ''}`)
      out.replaceChildren()
      if (!r.matches.length) {
        out.append(line(`No issuer stock token matches “${q}”${chain !== 'all' ? ' on ' + CHAIN_LABEL[chain] : ''}.`, 'muted'))
        const acts = h('div', { class: 'actions' })
        if (chain !== 'all') acts.append(h('button', { type: 'button', class: 'btn', onclick: () => { setChain('all', true); run(q) } }, 'search both chains'))
        acts.append(h('button', { type: 'button', class: 'btn', onclick: () => run('fakes') }, 'see tokens pretending to be stocks'))
        out.append(acts, line('If you have a contract address, paste it to check it.', 'faint'))
        return
      }
      if (r.matches.length === 1) return renderInto(out, r.matches[0].chain, r.matches[0].address)
      lastList = r.matches
      out.append(line(`${r.matches.length}${r.more ? '+' : ''} matches. Type a number or click:`, 'muted'),
        h('ol', { class: 'pick' }, r.matches.map((m, i) => h('li', null, h('button', { type: 'button', onclick: () => passport(m.chain, m.address, String(i + 1)) },
          h('span', { class: 'n' }, String(i + 1)), h('span', { class: 'sym' }, m.symbol || '?'),
          h('span', { class: 'nm' }, mark(m.chain), (m.name || '').replace(/\s+Robinhood Token$/i, ''), m.minted === false ? h('span', { class: 'faint' }, ' · not minted yet') : m.has_reference_price ? '' : h('span', { class: 'faint' }, ' · no issuer price')),
          h('span', { class: 'addr' }, m.address))))))
      if (r.more) out.append(line(`${r.more} more. Narrow the search.`, 'faint'))
    } catch (e) { out.replaceChildren(line(e.message, 'err')) }
  }

  // An address's archived case (GET /api/history/cases): when we first saw it imitating, and whether the issuer later
  // listed it. A case archived from the collector's earlier history says so, and carries no flag time.
  function caseLine (c) {
    if (!c) return null
    const seen = String(c.first_seen_at || c.archived_at || '').slice(0, 10)
    const from = c.source === 'backfilled' ? 'first seen by our collector ' : 'flagged '
    const text = c.status === 'listed_by_issuer' ? 'Before the issuer listed it, this contract was on our impostor list (' + from + seen + ', listed ' + String(c.closed_at).slice(0, 10) + ').'
      : c.status === 'closed' ? 'Was on our impostor list (' + from + seen + '), left it ' + String(c.closed_at).slice(0, 10) + '.'
        : 'In our dated archive since ' + seen + (c.source === 'backfilled' ? ' (from collector history)' : '') + '.'
    return h('div', { class: 'line faint' }, text + ' ', h('a', { href: 'history' }, 'history'))
  }

  async function passport (c, address, command) {
    const out = block(command != null ? command : address)
    return renderInto(out, c, address)
  }
  async function renderInto (out, c, address) {
    syncUrl({ chain: c, address })
    out.replaceChildren(line('checking ' + address + ' on ' + (CHAIN_LABEL[c] || c) + '', 'faint typing'))
    try {
      const p = await api(`api/passport?chain=${encodeURIComponent(c)}&address=${encodeURIComponent(address)}`)
      out.replaceChildren(render(p))
      if (p.in_registry && p.issuer && p.issuer.symbol) syncUrl({ listedOn: c, symbol: p.issuer.symbol })
    } catch (e) { out.replaceChildren(line(e.message, 'err')) }
    reveal(out.parentElement)
  }
  // An address with no chain: ask the chains the tab allows; show the one whose registry lists it, else the one where it
  // imitates a listed token, else the first.
  async function passportAnywhere (address, out) {
    // Always ask every chain, the selected one first: an address pasted on the wrong tab still finds its passport.
    const chains = chain === 'all' ? CHAINS : [chain, ...CHAINS.filter((c) => c !== chain)]
    out.replaceChildren(line('checking ' + address + '', 'faint typing'))
    const got = await Promise.all(chains.map((c) => api(`api/passport?chain=${c}&address=${address}`).catch(() => null)))
    const pick = got.find((p) => p && p.in_registry) || got.find((p) => p && p.resembles) || got.find(Boolean)
    if (!pick) return out.replaceChildren(line('Could not check this address right now.', 'err'))
    syncUrl(pick.in_registry && pick.issuer ? { listedOn: pick.chain, symbol: pick.issuer.symbol } : { chain: pick.chain, address })
    out.replaceChildren(render(pick))
  }

  // ---------- copying an address ----------
  // A soft click, synthesised: no sound file to load, nothing for the page's CSP to allow. It plays only on the click
  // itself (browsers allow audio from a user gesture), very quietly, and not at all for readers who asked for less motion.
  let audio = null
  function softClick () {
    if (REDUCED) return
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)()
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(1650, t)
      o.frequency.exponentialRampToValueAtTime(900, t + 0.05)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.045, t + 0.004)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
      o.connect(g).connect(audio.destination)
      o.start(t); o.stop(t + 0.08)
    } catch (_) { /* no audio is fine */ }
  }
  // The address as a button: one click copies it whole. An official address says "copied"; one outside the registry says
  // what it is, so a copied impostor contract is never mistaken for the stock.
  function copyAddress (address, official) {
    const label = h('span', { class: 'addr-text' }, address)
    const tip = h('span', { class: 'addr-tip', 'aria-hidden': 'true' }, 'copy')
    const b = h('button', { type: 'button', class: 'addr-copy' + (official ? '' : ' unlisted'), title: 'Copy the contract address', 'aria-label': 'Copy contract address ' + address },
      label, h('span', { class: 'i i-copy', 'aria-hidden': 'true' }), tip)
    let timer = null
    b.addEventListener('click', async (e) => {
      e.stopPropagation()
      let ok = false
      try { await navigator.clipboard.writeText(address); ok = true } catch (_) {
        // Older or locked-down browsers: select the text so the reader can copy it themselves.
        const r = document.createRange(); r.selectNodeContents(label); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
      }
      if (ok) softClick()
      tip.textContent = ok ? (official ? 'copied' : 'copied · not the issuer\'s token') : 'press Ctrl+C'
      b.classList.add('done')
      clearTimeout(timer)
      timer = setTimeout(() => { b.classList.remove('done'); tip.textContent = 'copy' }, 1600)
    })
    return b
  }

  // ---------- the passport ----------
  const field = (k, v, small) => h('div', { class: 'field' }, h('span', { class: 'k' }, k), h('span', { class: 'dots-fill' }), h('span', { class: 'v' }, v, small ? h('small', null, small) : null))

  /** The plain-words line under the fields. Under 0.5% apart is "about the issuer price" and not coloured; under 2% "a bit"; more "noticeably". */
  // Each reason a difference could not be computed gets its own sentence, so the line never contradicts the fields above it.
  function bottomLine (p) {
    const l = p.latest, ref = p.reference
    if (p.issuer && p.issuer.minted === false) {
      return { text: `This is the issuer's token. ${ISSUER_LABEL[p.issuer.name] || p.issuer.name} lists it, but none has been minted on ${CHAIN_LABEL[p.chain] || p.chain} yet, so it does not trade on-chain and there is no price to compare.`, cls: '' }
    }
    const stale = p.notes.includes('reading_stale') ? ` (as of our last reading, ${age(l && l.age_s)})` : ''
    if (!l) return { text: 'This is the issuer\'s token. We have not recorded a price for it yet.', cls: '' }
    if (l.premium == null) {
      if (l.premium_refused === 'no_reference' || !ref || ref.price_usd == null) {
        return { text: `This is the issuer's token, but the issuer publishes no price for it, so there is nothing to compare the on-chain price with${stale}.`, cls: '' }
      }
      if (l.premium_refused === 'reference_spread_wide') {
        const inside = l.dex_inside_quote === true ? ' The on-chain price is inside the issuer\'s quote.' : l.dex_inside_quote === false ? ' The on-chain price is outside the issuer\'s quote.' : ''
        return { text: `This is the issuer's token. Its bid and ask are ${ref.spread != null ? pct(ref.spread).replace('+', '') + ' ' : ''}apart right now, too wide to use as one price${stale}.${inside}`, cls: '' }
      }
      return { text: `This is the issuer's token, but no on-chain pool is deep enough to compare with the issuer price${stale || ' right now'}.`, cls: '' }
    }
    const d = l.premium, a = Math.abs(d)
    if (a < 0.005) return { text: `On-chain it trades at about the issuer price (${pct(d)})${stale}.`, cls: '' }
    const how = a < 0.02 ? 'a bit' : 'noticeably'
    const side = d < 0 ? 'cheaper' : 'more expensive'
    return { text: `On-chain it trades ${how} ${side} than the issuer price (${pct(d)})${stale}.`, cls: a < 0.02 ? 'warn' : 'bad' }
  }

  function notesOf (p) {
    // pools_capped is already said by the pools block ("of 30+"); repeating it here is noise.
    // not_minted is the whole "In short" line; repeating it, or the missing price that follows from it, is noise.
    const unminted = p.notes.includes('not_minted')
    const items = p.notes.filter((n) => n !== 'pools_capped' && !(unminted && (n === 'not_minted' || n === 'no_reference'))).map((n) => NOTES[n] ? h('li', { class: NOTES[n][1] === 'info' ? '' : NOTES[n][1] }, NOTES[n][0]) : null).filter(Boolean)
    return items.length ? h('ul', { class: 'notes' }, items) : null
  }
  // What an impostor imitates, in words: a listed token, or — when it copies the issuer's naming for an asset the issuer
  // does not list at all — the naming itself.
  const imitates = (x) => x.registry_symbol || x.ticker || (x.kind === 'issuer_name_suffix' ? "copies Robinhood's naming" : NA)
  // Links out. An official token's links open directly. An impostor's first ask: the reader sees what they are about to
  // open, and the button that opens it says so again.
  const ext = (href, text) => h('a', { class: 'btn link', href, target: '_blank', rel: 'noopener noreferrer nofollow' }, text, h('span', { class: 'i i-ext', 'aria-hidden': 'true' }))
  const host = (u) => { try { return new URL(u).host } catch (_) { return 'explorer' } }
  function officialLinks (p) {
    if (!p.links) return null
    // A token not minted yet has no pool: only its contract is worth opening.
    return h('div', { class: 'actions' }, p.issuer && p.issuer.minted === false ? null : ext(p.links.dex, 'chart & pools on DexScreener'), p.links.explorer ? ext(p.links.explorer, 'contract on ' + host(p.links.explorer)) : null)
  }
  // `strong`: the token copies a listed symbol or the issuer's naming — an impostor. Otherwise it only borrows a ticker,
  // and is called what it is: a token outside the registry. A token that resembles nothing (USDC, WETH) gets plain links.
  function impostorLinks (p, imitated, strong) {
    if (!p.links) return null
    if (!imitated) return h('div', { class: 'actions' }, ext(p.links.dex, 'token on DexScreener'), p.links.explorer ? ext(p.links.explorer, 'contract on ' + host(p.links.explorer)) : null)
    const what = strong ? 'impostor' : 'token'
    const box = h('div', { class: 'actions' })
    const ask = (href, label) => h('button', { type: 'button', class: 'btn danger', onclick: () => {
      box.replaceChildren(h('div', { class: 'warnbox' },
        h('div', null, h('b', null, strong ? '⚠ This opens an impostor token. ' : '⚠ This opens a token outside the issuer\'s registry. '), `It is not the issuer's ${imitated}. Don't buy it thinking it is the stock.`),
        h('div', { class: 'actions' }, h('a', { class: 'btn danger', href, target: '_blank', rel: 'noopener noreferrer nofollow' }, `I understand, open the ${what}`, h('span', { class: 'i i-ext', 'aria-hidden': 'true' })),
          h('button', { type: 'button', class: 'btn', onclick: () => box.replaceChildren(...buttons()) }, 'cancel'))))
    } }, label)
    const buttons = () => [ask(p.links.dex, what + ' on DexScreener'), p.links.explorer ? ask(p.links.explorer, what + ' contract on ' + host(p.links.explorer)) : null].filter(Boolean)
    box.append(...buttons())
    return box
  }
  // A pool row's dex name opens that very pool on DexScreener, where its live price and trades are. A pool address is
  // 20 bytes on v2/v3 pools and 32 bytes on v4 pool ids; anything else stays plain text rather than a guessed link.
  const DEX_LABEL = { uniswap: 'Uniswap', aerodrome: 'Aerodrome', 'aero-slipstream-base': 'Aerodrome Slipstream', 'uniswap-v4-base': 'Uniswap v4', 'uniswap-v3-base': 'Uniswap v3', pancakeswap: 'PancakeSwap' }
  function poolLink (chain, x) {
    const name = DEX_LABEL[x.dex_id] || x.dex_id || '?'
    const id = String(x.pair_address || '')
    if (!/^0x([0-9a-f]{40}|[0-9a-f]{64})$/i.test(id) || !CHAINS.includes(chain)) return name
    return h('a', { class: 'pool-link', href: `https://dexscreener.com/${chain}/${id.toLowerCase()}`, target: '_blank', rel: 'noopener noreferrer nofollow', title: 'Open this pool on DexScreener' }, name, h('span', { class: 'i i-ext', 'aria-hidden': 'true' }))
  }
  const fold = (title, ...body) => h('details', { class: 'more' }, h('summary', null, title), h('div', { class: 'inner' }, ...body))
  const table = (head, rows) => h('table', { class: 'tbl' }, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))), h('tbody', null, rows))

  function render (p) {
    const where = mark(p.chain)
    if (!p.in_registry) {
      const r = p.resembles
      const strong = r && (r.kind === 'registry_symbol' || r.kind === 'issuer_name_suffix')
      const card = h('div', { class: 'card' },
        h('div', { class: 'cardhead' },
          h('div', null, h('h2', null, (p.identity.symbol || 'Unknown token') + (p.identity.name ? ' · ' + p.identity.name : '')), h('div', { class: 'sub' }, where, copyAddress(p.address, false))),
          h('span', { class: 'stamp ' + (strong ? 'bad' : 'warn') }, 'not official')),
        h('div', { class: 'plain bad' }, strong
          ? (r.registry_symbol || r.ticker
            ? `This is not the issuer's token. Its ${r.kind === 'registry_symbol' ? 'symbol is the same as' : 'name copies'} ${r.registry_symbol || r.ticker}, but the contract is not in the issuer's registry.`
            : "This is not the issuer's token. Its name copies the way Robinhood names its stock tokens, but Robinhood lists no such asset and the contract is not in its registry.")
          : r ? `Not the issuer's token. Its ticker matches ${r.ticker}. Many tokens reuse tickers, and this one is not the issuer's ${r.registry_symbol}.`
            : 'This contract is not in the issuer\'s registry for this chain, so it is not that issuer\'s stock token.'),
        p.impostor_listing ? line('On our list of tokens pretending to be stocks since ' + String(p.impostor_listing.first_seen_at).slice(0, 10) + '.', 'faint') : null,
        caseLine(p.case),
        r && r.registry_address ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => passport(p.chain, r.registry_address, 'official ' + (r.registry_symbol || r.ticker)) }, 'open the official ' + (r.registry_symbol || r.ticker), h('span', { class: 'i i-arrow', 'aria-hidden': 'true' }))) : null,
        impostorLinks(p, r ? (r.registry_symbol || r.ticker || 'stock token') : null, strong))
      return card
    }
    const i = p.issuer, ref = p.reference, l = p.latest
    const bl = bottomLine(p)
    const m = p.market_now
    const listedCase = p.case && p.case.status === 'listed_by_issuer' ? caseLine(p.case) : null
    const fields = h('div', { class: 'fields' },
      field('issuer', ISSUER_LABEL[i.name] || i.name),
      field('reference', blank(usd(ref && ref.price_usd)), ref && ref.price_usd > 0 ? (REF_KIND[ref.kind] || ref.kind) + ' · ' + (ref.kind === 'token_bid_ask_mid' ? 'last moved ' : 'updated ') + age(ref.age_s) + (ref.spread != null ? ' · bid/ask ' + pct(ref.spread).replace('+', '') + ' apart' : '') : 'the issuer publishes none'),
      field('on-chain price', h('span', { class: sign(l && l.premium) }, blank(usd(l && l.dex_price_usd))), i.minted === false ? 'not minted yet' : l ? (p.notes.includes('reading_stale') ? 'read ' + age(l.age_s) : l.dex_price_usd == null ? 'no pool deep enough' : 'deepest pool') : 'not recorded yet'),
      field('difference', h('span', { class: sign(l && l.premium) }, blank(pct(l && l.premium))), l && l.premium != null ? null : 'nothing to compare'),
      field('market', (SESSION[m.session] || m.session) + (m.holiday ? ' · ' + m.holiday : m.reason === 'weekend' ? ' · weekend' : '')),
      // A multiplier of exactly 1 with nothing pending says nothing; it is shown only when it matters.
      i.multiplier != null && (Number(i.multiplier) !== 1 || i.multiplier_pending != null) ? field('multiplier', String(+Number(i.multiplier).toFixed(6)), i.multiplier_pending != null ? 'pending ' + i.multiplier_pending : null) : null,
      i.isin ? field('isin', i.isin) : null)

    const folds = []
    const other = p.same_stock_elsewhere || []
    if (other.length) {
      folds.push(fold('same share on the other chain',
        table(['token', 'multiplier', 'reference', 'age', 'on-chain', 'difference'], [
          h('tr', null, h('td', null, mark(p.chain), i.symbol), h('td', null, mult(i.multiplier)), h('td', null, usd(ref && ref.price_usd)), h('td', null, ref ? age(ref.age_s) : NA), h('td', null, usd(l && l.dex_price_usd)), h('td', { class: sign(l && l.premium) }, pct(l && l.premium))),
          ...other.map((o) => h('tr', { class: 'click', onclick: () => passport(o.chain, o.address, o.symbol + ' on ' + CHAIN_LABEL[o.chain]) },
            h('td', null, mark(o.chain), o.symbol), h('td', null, mult(o.multiplier)), h('td', null, usd(o.latest && o.latest.reference_price_usd)), h('td', null, o.latest ? age(o.latest.reference_age_s) : NA),
            h('td', null, usd(o.latest && o.latest.dex_price_usd)), h('td', { class: sign(o.latest && o.latest.premium) }, pct(o.latest && o.latest.premium)))),
        ]), line('Same ISIN from a different issuer. These are two separate tokens. Each is worth its multiplier times one share, so their prices differ by the multipliers.', 'faint')))
    }
    const c = chart(p.series_points)
    if (c) {
      const key = (cls, text) => h('span', { class: 'key' }, h('i', { class: cls, 'aria-hidden': 'true' }), text)
      const legend = h('div', { class: 'legend' }, key('sw-line', 'on-chain vs issuer price'), key('sw-open', 'US market open'), key('sw-ext', 'pre/after hours'), key('sw-closed', 'market closed'), key('sw-gap', 'no price at those readings'))
      folds.push(fold(`difference over the last ${p.series.window_h} h`, c, legend))
    }
    const bs = p.series && p.series.premium_by_session
    if (bs) {
      const rows = [['regular', 'market open'], ['extended', 'extended hours'], ['closed', 'market closed'], ['unknown', 'calendar unknown']].filter(([k]) => bs[k] && bs[k].n)
        .map(([k, label]) => h('tr', null, h('td', null, label), h('td', null, String(bs[k].n)), h('td', { class: sign(bs[k].median) }, pct(bs[k].median)),
          h('td', null, bs[k].n >= 10 ? pct(bs[k].p10) + ' to ' + pct(bs[k].p90) : pct(bs[k].min) + ' to ' + pct(bs[k].max))))
      if (rows.length) folds.push(fold('by market session', table(['session', 'readings', 'median', 'range'], rows), line('range: the middle 80% of readings when there are 10 or more, otherwise lowest to highest.', 'faint')))
    }
    if (l && l.pools && l.pools.top && l.pools.top.length) {
      folds.push(fold(`pools · ${l.pools.eligible} deep enough of ${l.pools.seen}${l.pools.capped ? '+' : ''}`,
        table(['dex', 'paired with', 'price', 'liquidity', '24h volume'], l.pools.top.map((x) => h('tr', null, h('td', null, poolLink(p.chain, x)), h('td', null, x.quote_symbol || '?'), h('td', null, usd(x.price_usd)), h('td', null, big(x.liquidity_usd)), h('td', null, big(x.volume_h24_usd)))))))
    }
    return h('div', { class: 'card' },
      h('div', { class: 'cardhead' },
        h('div', null, h('h2', null, i.symbol + (i.token_name ? ' · ' + i.token_name.replace(/\s+Robinhood Token$/i, '') : '')), h('div', { class: 'sub' }, where, copyAddress(p.address, true))),
        h('span', { class: 'stamp ok' }, 'issuer-listed')),
      fields,
      h('div', { class: 'plain' + (bl.cls ? ' ' + bl.cls : '') }, bl.text),
      notesOf(p),
      listedCase,
      officialLinks(p),
      ...folds,
      line('Holder rights are set by the issuer\'s prospectus. This is not advice.', 'faint'))
  }

  // The difference over time: SVG from DOM nodes, never an HTML string.
  const SVGNS = 'http://www.w3.org/2000/svg'
  const s = (tag, attrs) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v)); return el }
  function chart (points) {
    const pts = (points || []).filter((x) => Number.isFinite(x[0]))
    const priced = pts.filter((x) => typeof x[1] === 'number')
    if (priced.length < 2) return null
    const W = 760, H = 170, L = 52, R = 8, T = 8, B = 22
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0]
    let lo = Math.min(0, ...priced.map((x) => x[1])), hi = Math.max(0, ...priced.map((x) => x[1]))
    if (hi - lo < 0.002) { const mid = (hi + lo) / 2; lo = mid - 0.001; hi = mid + 0.001 }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad
    const x = (t) => L + (W - L - R) * (t1 === t0 ? 0 : (t - t0) / (t1 - t0))
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo))
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Difference to the issuer reference over time' })
    // Market phases as background bands, merged into runs: closed is the darker band, pre/after-hours the lighter one,
    // the open session has none. The legend under the chart says so.
    for (let k = 0; k < pts.length;) {
      const g = pts[k][2]
      let j = k
      while (j + 1 < pts.length && pts[j + 1][2] === g) j++
      if (g === 'c' || g === 'e') {
        const a = x(pts[k][0]), b = x(j + 1 < pts.length ? pts[j + 1][0] : pts[j][0])
        svg.append(s('rect', { x: a, y: T, width: Math.max(1, b - a), height: H - T - B, class: g === 'c' ? 'band-c' : 'band-e' }))
      }
      k = j + 1
    }
    svg.append(s('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'zero' }))
    // The line. A reading with no price (no deep pool, a quote too wide) leaves a hole; a hole of up to two hours is
    // bridged with a dotted segment, so the eye follows the series without taking the bridge for data. Longer holes stay open.
    let d = '', gaps = '', prev = null, pen = false
    for (const [t, v] of pts) {
      if (typeof v !== 'number') { pen = false; continue }
      const px = x(t).toFixed(1), py = y(v).toFixed(1)
      if (!pen && prev && t - prev[0] <= 2 * 3600e3) gaps += 'M' + x(prev[0]).toFixed(1) + ' ' + y(prev[1]).toFixed(1) + ' L' + px + ' ' + py + ' '
      d += (pen ? 'L' : 'M') + px + ' ' + py + ' '
      pen = true; prev = [t, v]
    }
    if (gaps) svg.append(s('path', { d: gaps, class: 'gap' }))
    svg.append(s('path', { d, class: 'ln' }))
    const label = (txt, attrs) => { const el = s('text', attrs); el.textContent = txt; return el }
    const when = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ') + 'Z'
    svg.append(label(pct(hi), { x: L - 6, y: T + 10, 'text-anchor': 'end' }), label(pct(lo), { x: L - 6, y: H - B, 'text-anchor': 'end' }),
      label('0%', { x: L - 6, y: y(0) + 3.5, 'text-anchor': 'end', class: 'zero-l' }),
      label(when(t0), { x: L, y: H - 5 }), label(when(t1), { x: W - R, y: H - 5, 'text-anchor': 'end' }))
    return svg
  }

  // ---------- boards ----------
  async function board (input) {
    const out = block(input)
    try {
      const o = await api('api/overview')
      const m = o.market_now
      out.append(line((SESSION[m.session] || m.session) + (m.reason === 'weekend' ? ' (weekend)' : m.holiday ? ' (' + m.holiday + ')' : '') + '. Furthest from the issuer price:', 'muted'))
      for (const [c, b] of Object.entries(o.chains)) {
        if (chain !== 'all' && c !== chain) continue
        out.append(h('div', { class: 'line' }, mark(c), h('span', { class: 'faint' }, `${b.priced} priced · ${b.unpriced} without a deep pool or a price` + (b.stale ? ` · ${b.stale} not read in the last 30 min (newest ${String(b.newest_reading_at || '').slice(0, 16).replace('T', ' ')}Z)` : ''))),
          table(['token', 'difference', 'reference age', 'pool'], b.rows.slice(0, 8).map((r) => h('tr', { class: 'click', onclick: () => passport(c, r.address, r.symbol) },
            h('td', null, r.symbol), h('td', { class: sign(r.premium) }, pct(r.premium)), h('td', null, age(r.reference_age_s)), h('td', null, big(r.liquidity_usd))))))
      }
    } catch (e) { out.append(line(e.message, 'err')) }
  }
  // The same share (same ISIN) on both chains: each premium over its own issuer's reference, and the gap between them.
  async function matrixView (input) {
    const out = block(input)
    try {
      const o = await api('api/matrix')
      const pp = (x) => (x == null ? NA : (x > 0 ? '+' : '') + (x * 100).toFixed(2) + ' pp')
      const cell = (v) => (v.premium == null ? NA + ' (' + v.premium_refused + ')' : pct(v.premium) + (v.stale ? ' (old reading)' : ''))
      out.append(line(`${o.pairs} shares are listed on both Base and Robinhood Chain, matched by ISIN. ${o.with_gap} have a current premium on both.` + (o.stale ? ` ${o.stale} have a reading older than 30 min and get no gap.` : ''), 'muted'),
        line('Each premium is over its own issuer\'s price: Coinbase NAV on Base, Robinhood bid/ask on Robinhood Chain. The references differ, so the gap is a difference of two premiums, not of two prices.', 'faint'),
        table(['token', 'Base premium', 'Robinhood premium', 'gap', 'liquidity Base / Robinhood'], o.rows.map((r) => h('tr', { class: 'click', onclick: () => passport('base', r.base.address, r.base.symbol) },
          h('td', null, r.base.symbol + ' / ' + r.robinhood.symbol), h('td', { class: sign(r.base.premium) }, cell(r.base)), h('td', { class: sign(r.robinhood.premium) }, cell(r.robinhood)),
          h('td', { class: sign(r.gap) }, r.gap == null ? NA : pp(r.gap)), h('td', null, big(r.base.liquidity_usd) + ' / ' + big(r.robinhood.liquidity_usd))))))
    } catch (e) { out.append(line(e.message, 'err')) }
  }
  async function fakes (input) {
    const out = block(input)
    try {
      const o = await api('api/impostors?limit=10')
      out.append(line('Tokens that copy the symbol or naming of an issuer\'s stock token while their contract is not in that issuer\'s registry. Each row shows what it copies, so you can check.', 'muted'))
      for (const [c, b] of Object.entries(o.chains)) {
        if (chain !== 'all' && c !== chain) continue
        if (!b.items) { out.append(h('div', { class: 'line' }, mark(c), h('span', { class: 'faint' }, 'list not generated yet'))); continue }
        out.append(h('div', { class: 'line' }, mark(c), h('span', { class: 'faint' }, `${b.listed} listed · ${b.counts.ticker} more only borrow a ticker`)),
          table(['token', 'pretends to be', 'first seen'], b.items.map((i) => h('tr', { class: 'click', onclick: () => passport(c, i.address, i.symbol || i.address) },
            h('td', null, (i.symbol || '?') + ' ', h('span', { class: 'faint' }, (i.name || '').slice(0, 32))), h('td', null, imitates(i)), h('td', null, String(i.first_seen_at || '').slice(0, 10))))))
      }
    } catch (e) { out.append(line(e.message, 'err')) }
  }

  // ---------- the landing around the terminal ----------
  // The live tape: every priced issuer token on both chains, furthest from its reference first, coloured by the size of
  // the gap. The list is doubled so the CSS loop is seamless; a click opens that passport in the terminal.
  // The tape: two identical groups moved left by exactly one group's width, so the loop has no seam; the speed is a
  // constant number of pixels per second whatever the content; values are refreshed every minute IN PLACE, so the motion
  // never restarts. Measured before: a -50% shift of a run with a leading pad jumped a few pixels on every loop, and the
  // data never changed after the page loaded.
  const TAPE_PX_PER_S = 42
  let tapeKeys = ''
  const tapeKey = ({ c, r }) => c + ':' + r.address
  function tapeItem ({ c, r }) {
    return h('button', { type: 'button', class: 'tape-item', 'data-key': tapeKey({ c, r }), onclick: () => { toTerminal(); passport(c, r.address, r.symbol) } },
      h('b', null, r.symbol), h('span', { class: 'v ' + sign(r.premium) }, pct(r.premium)), h('span', { class: 'faint' }, ' ' + (c === 'base' ? 'base' : 'rh')))
  }
  async function tape () {
    const el = $('#tape')
    if (!el) return
    let items
    try {
      const o = await api('api/overview')
      items = []
      for (const [c, b] of Object.entries(o.chains)) for (const r of b.rows) items.push({ c, r })
      // Base first, then Robinhood; within each, furthest from the reference first.
      items.sort((x, y) => (x.c === 'base' ? 0 : 1) - (y.c === 'base' ? 0 : 1) || Math.abs(y.r.premium) - Math.abs(x.r.premium))
      items = items.slice(0, 24)
    } catch (_) { if (!tapeKeys) el.replaceChildren(h('span', { class: 'faint' }, 'live tape unavailable')); return }
    if (!items.length) { if (!tapeKeys) el.replaceChildren(h('span', { class: 'faint' }, 'no priced readings yet')); return }
    const keys = items.map(tapeKey).join('|')
    if (keys === tapeKeys) {
      // Same tokens: change only the numbers, and flash the ones that moved.
      for (const it of items) {
        for (const node of el.querySelectorAll(`[data-key="${tapeKey(it)}"] .v`)) {
          const text = pct(it.r.premium)
          if (node.textContent !== text) { node.textContent = text; node.className = 'v ' + sign(it.r.premium) + ' tick'; setTimeout(() => node.classList.remove('tick'), 900) }
        }
      }
      return
    }
    // A new set: rebuild, keeping where the motion was so the tape does not jump back to the start.
    const anim = el.getAnimations ? el.getAnimations()[0] : null
    const at = anim && anim.currentTime != null ? anim.currentTime / (anim.effect.getTiming().duration || 1) : 0
    // A group at least as wide as the visible track, repeating the items if there are few, so no gap ever shows.
    let reps = 1
    const group = () => h('div', { class: 'tape-group' }, Array.from({ length: reps }, () => items.map(tapeItem)).flat())
    el.replaceChildren(group(), group())
    const track = el.parentElement.getBoundingClientRect().width
    const one = el.firstElementChild.getBoundingClientRect().width
    if (one > 0 && one < track) { reps = Math.ceil(track / one); el.replaceChildren(group(), group()) }
    tapeKeys = keys
    const w = el.firstElementChild.getBoundingClientRect().width
    const dur = Math.max(8, w / TAPE_PX_PER_S)
    el.style.animationDuration = dur.toFixed(1) + 's'
    const a2 = el.getAnimations ? el.getAnimations()[0] : null
    if (a2 && at) a2.currentTime = (at % 1) * dur * 1000
  }
  function toTerminal () { $('#terminal').scrollIntoView({ block: 'start', behavior: REDUCED ? 'auto' : 'smooth' }) }

  // ---------- greeting ----------
  function typewrite (el, text, speed = 14) {
    if (REDUCED) { el.textContent = text; return Promise.resolve() }
    el.classList.add('typing')
    return new Promise((resolve) => {
      let k = 0
      const tick = () => { el.textContent = text.slice(0, ++k); if (k < text.length) setTimeout(tick, speed); else { el.classList.remove('typing'); resolve() } }
      tick()
    })
  }
  async function boot (animate) {
    const out = block(null)
    const first = line('', 'muted')
    out.append(first)
    let st = null
    try { st = await api('api/status') } catch (_) { /* the greeting still works */ }
    // The footer's Status dot: green when every part is on schedule, amber when one is late, red when one stopped.
    try {
      const ages = st ? Object.values(st) : []
      const late = ages.some((c) => c.newest_reading_age_s == null || c.newest_reading_age_s > 1800 || c.registry_age_s == null || c.registry_age_s > 600)
      const down = ages.some((c) => c.newest_reading_age_s == null || c.newest_reading_age_s > 3600 || c.registry_records == null)
      const dot = document.querySelector('#foot-status .foot-dot')
      if (dot && st) dot.classList.add(down ? 'down' : late ? 'late' : 'ok')
    } catch (_) { /* the dot is decoration */ }
    const counts = st ? `Base: ${st.base?.registry_records ?? '?'} Coinbase stock tokens · also Robinhood Chain: ${st.robinhood?.registry_records ?? '?'}` : 'issuer registries'
    const hello = `stock-token-passport · ${counts} · recorded every 15 min`
    const lines = [
      'Is this token the stock it claims to be, and what does it trade at right now?',
      'Type a ticker (NVDA), a company (Tesla) or paste a 0x address. Try: now · impostors · help',
    ]
    if (animate) {
      await typewrite(first, hello)
      for (const t of lines) { const el = line('', ''); out.append(el); await typewrite(el, t, 8) }
    } else {
      first.textContent = hello
      out.append(...lines.map((t) => line(t, '')))
    }
    status(st)
  }
  function status (st) {
    const el = $('#status')
    if (!st) { el.textContent = 'offline'; return }
    el.replaceChildren(h('span', { class: 'live' }, '● '), Object.entries(st).map(([c, v]) => `${c}: ${v.registry_records ?? '?'} listed, readings ${v.readings_age_s == null ? 'loading' : age(v.readings_age_s)}`).join(' · '))
  }

  // ---------- wiring ----------
  document.addEventListener('DOMContentLoaded', () => {
    const input = $('#cmd')
    $('#prompt').addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; run(v) })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && past.length) { hpos = Math.max(0, hpos - 1); input.value = past[hpos]; e.preventDefault() }
      if (e.key === 'ArrowDown' && past.length) { hpos = Math.min(past.length, hpos + 1); input.value = past[hpos] || ''; e.preventDefault() }
    })
    for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => { setChain(t.dataset.chain, true); input.focus() })
    // A plain click on the feed puts the cursor back in the prompt, but never after the reader selected text: that click
    // ends a selection, and moving focus would wipe it. A press that moved more than a few pixels is a drag, not a click.
    let down = null
    log().addEventListener('mousedown', (e) => { down = { x: e.clientX, y: e.clientY } })
    log().addEventListener('click', (e) => {
      if (e.target.closest('button, a, summary, tr.click, details')) return
      const dragged = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
      const sel = window.getSelection && window.getSelection()
      if (dragged || e.detail > 1 || (sel && !sel.isCollapsed && String(sel).trim())) return
      input.focus({ preventScroll: true })
    })

    const u = new URL(location.href)
    const uc = u.searchParams.get('chain'), ua = u.searchParams.get('address'), uq = u.searchParams.get('q')
    const us = CHAINS.map((c) => [c, u.searchParams.get(c)]).find(([, v]) => v && /^[A-Za-z0-9.]{1,15}$/.test(v))
    if (CHAINS.includes(uc)) setChain(uc, false)
    else if (us) setChain(us[0], false)
    const fromLink = Boolean(ua || uq || us)
    boot(!fromLink).then(async () => {
      if (us && !ua) {
        // ?base=NVDAc: the exact symbol on that chain's registry, else an ordinary search for it.
        const r = await api(`api/find?chain=${us[0]}&q=${encodeURIComponent(us[1])}`).catch(() => null)
        const m = r && r.matches && r.matches.find((x) => x.chain === us[0] && String(x.symbol).toLowerCase() === us[1].toLowerCase())
        return m ? passport(us[0], m.address, m.symbol) : run(us[1])
      }
      if (ua && CHAINS.includes(uc) && ADDRESS.test(ua)) passport(uc, ua.toLowerCase(), ua)
      else if (ua) run(ua)
      else if (uq) run(uq)
    })
    for (const b of document.querySelectorAll('[data-run]')) b.addEventListener('click', () => { toTerminal(); run(b.dataset.run) })
    // Window controls: red (and "clear screen") empties the feed, yellow is the normal size, green toggles the larger one.
    const term = $('#terminal'), grow = document.querySelector('[data-win="large"]')
    const sized = (large) => { term.classList.toggle('large', large); grow.setAttribute('aria-pressed', String(large)); if (large) toTerminal() }
    for (const b of document.querySelectorAll('[data-win]')) {
      b.addEventListener('click', () => {
        const w = b.dataset.win
        if (w === 'clear') { log().replaceChildren(); input.focus() }
        else if (w === 'normal') sized(false)
        else if (w === 'large') sized(!term.classList.contains('large'))
      })
    }
    for (const copy of document.querySelectorAll('[data-copy]')) {
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('#' + copy.dataset.copy).textContent); copy.textContent = 'copied' } catch (_) { copy.textContent = 'select & copy' }
        setTimeout(() => { copy.textContent = 'copy' }, 1600)
      })
    }
    tape()
    setInterval(() => { if (!document.hidden) tape() }, 60e3)
    if (!('ontouchstart' in window)) input.focus({ preventScroll: true })
  })
})()
