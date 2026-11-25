// apps/stocks-web/demo.js: the Demo Agent on /demo (apps/stocks-demo-page.mjs). It runs the guard package's own example,
// searchFlow from examples/agent-search.mjs (which ends in agent-buy.mjs's buyFlow), in the browser against this site:
// a market search for the stock, Proof of Stock's verdict on every token found, the original picked, then its passport,
// a live quote and a swap to sign. Each step is drawn three ways: plain words, a trader's numbers, and the calls a
// developer would make with what they answered.
//
// ⚠ NOTHING HERE SIGNS, SENDS OR ASKS A WALLET. There is no key and no call to a wallet provider. The last card is a link
// and, if the reader typed a public address, an unsigned transaction to copy.
// ⚠ EVERYTHING FROM THE NETWORK IS TEXT. Answers are drawn with textContent only, never as HTML.
import { searchFlow } from './guard/examples/agent-search.mjs'
import { KYBER_ROUTER, USDC_BASE } from './guard/examples/agent-buy.mjs'

const $ = (id) => document.getElementById(id)
const log = $('dm-log'), form = $('dm-ask'), run = $('dm-run'), live = $('dm-live')
const ENDPOINT = new URL('./', location.href).href.replace(/\/+$/, '')
const PACE = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 750
const VIEWS = ['plain', 'trader', 'dev']

const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || ''))
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`
const age = (s) => (s == null ? 'unknown' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A DOM node: h('div', { class: 'x' }, 'text', child). Strings become text nodes, never HTML. */
function h (tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k))
  return el
}

// ── the view switch ─────────────────────────────────────────────────────────────────────────────────────────────────
function setView (v) {
  if (!VIEWS.includes(v)) v = 'plain'
  document.body.dataset.view = v
  for (const b of document.querySelectorAll('.dm-view')) b.setAttribute('aria-pressed', String(b.dataset.view === v))
  history.replaceState(null, '', v === 'plain' ? location.pathname + location.search : '#' + v)
}
for (const b of document.querySelectorAll('.dm-view')) b.addEventListener('click', () => setView(b.dataset.view))
setView(location.hash.slice(1))

// ── what went over the wire, for the developer view ─────────────────────────────────────────────────────────────────
let wire = []
async function recordingFetch (url, init = {}) {
  const r = await fetch(url, init)
  const text = await r.text()
  let json = null; try { json = JSON.parse(text) } catch (_) {}
  let body = null; try { body = init.body ? JSON.parse(init.body) : null } catch (_) {}
  wire.push({ method: init.method || 'GET', url: String(url), body, status: r.status, json })
  return new Response(text, { status: r.status, headers: r.headers })
}
const takeWire = () => { const w = wire; wire = []; return w }

/** A JSON answer cut to what a reader can take in: long arrays and strings shortened, the 24 hours of series left out. */
function trim (v, depth = 0) {
  if (Array.isArray(v)) { const head = v.slice(0, 3).map((x) => trim(x, depth + 1)); return v.length > 3 ? [...head, `… ${v.length - 3} more`] : head }
  if (v && typeof v === 'object') {
    if (depth > 3) return '{…}'
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = k === 'series' || k === 'route' && depth > 0 ? (Array.isArray(x) ? `[… ${x.length}]` : '…') : trim(x, depth + 1)
    return o
  }
  if (typeof v === 'string' && v.length > 90) return v.slice(0, 66) + '…' + v.slice(-12)
  return v
}
const pretty = (v, lines = 28) => { const t = JSON.stringify(trim(v), null, 2).split('\n'); return t.length > lines ? [...t.slice(0, lines), '  …'].join('\n') : t.join('\n') }
const path = (u) => { try { const x = new URL(u); return x.origin === location.origin ? x.pathname.replace(/^\/stocks(?=\/)/, '') + x.search : x.host + x.pathname + x.search } catch (_) { return u } }

function devBlock ({ code, calls = [], mcp }) {
  const box = h('div', { class: 'dm-dev' })
  if (code) box.append(h('pre', { class: 'dm-code' }, code))
  for (const c of calls) {
    box.append(h('div', { class: 'dm-call' }, h('span', { class: 'dm-m' }, c.method), h('code', {}, path(c.url)), h('span', { class: 'dm-st' + (c.status === 200 ? ' ok' : ' bad') }, String(c.status))))
    if (c.body) box.append(h('pre', { class: 'dm-json dm-req' }, pretty(c.body, 10)))
    if (c.json) box.append(h('pre', { class: 'dm-json' }, pretty(c.json)))
  }
  if (mcp) box.append(h('p', { class: 'dm-mcp' }, 'Same over MCP: ', h('code', {}, mcp)))
  return box
}

/** One card: who says it, its tone, and the three tellings. Only the current view's telling is shown (demo.css). */
function card ({ who, tone = '', plain, trader, dev, extra }) {
  const li = h('li', { class: `dm-card ${tone}`.trim() },
    h('span', { class: 'dm-who' }, who),
    h('div', { class: 'dm-body' },
      h('div', { class: 'v-plain' }, plain),
      h('div', { class: 'v-trader' }, trader ?? plain),
      h('div', { class: 'v-dev' }, dev ?? trader ?? plain),
      extra))
  return li
}
// The main terminal's own blocks (owner, 25.11: "as in the main terminal"), with its classes from style.css: fields with a
// dotted leader, a card head with the chain mark and the state, link buttons.
const kv = (rows) => h('div', { class: 'fields' }, rows.filter(Boolean).map(([k, v, cls]) => h('div', { class: 'field' }, h('span', { class: 'k' }, String(k).toLowerCase()), h('span', { class: 'dots-fill' }), h('span', { class: 'v' + (cls ? ' ' + cls : '') }, v))))
const cardHead = (title, address, state, tone) => h('div', { class: 'cardhead' },
  h('div', null, h('h2', null, title), h('div', { class: 'sub' }, h('span', { class: 'chainmark base' }, 'Base'), h('span', { class: 'dm-addr' }, address))),
  state ? h('span', { class: `state ${tone}` }, state) : null)
const ext = (href, text) => h('a', { class: 'btn link', href, target: '_blank', rel: 'noopener noreferrer nofollow' }, text, h('span', { class: 'i i-ext', 'aria-hidden': 'true' }))
const tokenLinks = (address) => h('div', { class: 'actions' }, ext(`https://www.geckoterminal.com/base/tokens/${address}`, 'chart & pools on GeckoTerminal'), ext(`https://basescan.org/token/${address}`, 'contract on basescan.org'))

// ── the steps ───────────────────────────────────────────────────────────────────────────────────────────────────────
let ctx = {}
const VERDICT = {
  listed: { tone: 'ok', badge: () => 'Original · Coinbase\'s list' },
  impostor: { tone: 'bad', badge: (v) => `Fake · copies ${v.imitates || ctx.ticker}` },
  not_listed: { tone: 'grey', badge: () => 'Not on the issuer\'s list' },
  wrong_stock: { tone: 'grey', badge: (v) => `Another stock (${v.listed_symbol || 'listed'})` },
}
const verdictOf = (v) => VERDICT[v.decision] || { tone: 'warn', badge: () => 'Could not check' }
const liq = (n) => (n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + Math.round(n))
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
const draw = {
  search: (e) => {
    ctx.ticker = e.ticker
    return card({ who: 'Agent',
      plain: h('p', {}, `Searching Base for ${ctx.query}, the way anyone would: every token whose name or symbol says ${e.ticker}.`),
      trader: kv([['Looking for', `${ctx.query} · ${e.ticker}`], ['Chain', 'Base'], ['Search', 'GeckoTerminal, every pool'], ['Match', e.terms.join(' or ')]]),
      dev: devBlock({ code: `await searchFlow({ query: ${JSON.stringify(ctx.query)}, ticker: ${JSON.stringify(e.ticker)} })\n// 1. searchCandidates: GeckoTerminal pools on Base, tokens carrying ${e.terms.join(' or ')}` }) })
  },
  candidates: (e) => {
    const list = h('ul', { class: 'dm-cands', 'aria-label': 'Tokens found' }, e.candidates.map((c) => h('li', { class: 'dm-cand', 'data-address': c.address },
      h('span', { class: 'dm-c-sym' }, c.symbol || '?'), h('span', { class: 'dm-c-name' }, c.name || ''), h('code', { class: 'dm-c-addr' }, short(c.address)),
      h('span', { class: 'dm-c-liq' }, liq(c.liquidityUsd)), h('span', { class: 'dm-c-badge' }, 'unchecked'))))
    ctx.list = list
    return card({ who: 'Found', tone: e.candidates.length ? '' : 'warn',
      plain: h('p', {}, e.candidates.length ? `I found ${count(e.candidates.length, 'token', 'tokens')} on Base that call themselves ${e.ticker}. They look alike. Which one is real?` : `The search turned up no token called ${e.ticker} on Base.`),
      trader: h('p', {}, `${count(e.candidates.length, 'token', 'tokens')} carrying ${e.ticker}, most liquid first. Liquidity is no proof: fakes have pools too.`),
      dev: devBlock({ calls: e.wire }),
      extra: e.candidates.length ? list : null })
  },
  verdicts: (e) => {
    const n = { listed: 0, impostor: 0, other: 0 }
    for (const v of e.verdicts) { if (v.decision === 'listed') n.listed++; else if (v.decision === 'impostor') n.impostor++; else n.other++ }
    const summary = h('p', { class: 'dm-sum', hidden: true }, h('span', { class: 'dm-pos' }, 'Checked by Proof of Stock'),
      `${count(n.impostor, 'fake', 'fakes')}, ${n.other} not on the issuer's list, ${count(n.listed, 'original', 'originals')}.`)
    const note = n.other ? h('p', { class: 'dm-note', hidden: true }, 'Not on the issuer\'s list is not the same as fake: another issuer\'s token (Dinari\'s, say) is not on Coinbase\'s list either. I just cannot vouch for it, so I skip it.') : null
    const node = card({ who: 'Proof', tone: 'pos',
      plain: h('p', {}, `I ask Proof of Stock about all ${e.verdicts.length} at once: which one did the issuer itself put on Base?`),
      trader: kv([['Checked', `${e.verdicts.length} contracts, one call`], ['Against', 'Coinbase\'s own list of its tokenized stocks'], ['Fakes', String(n.impostor), n.impostor ? 'bad' : null], ['Not listed', String(n.other)], ['Original', String(n.listed), n.listed ? 'ok' : 'warn']]),
      dev: devBlock({ code: `// 2. one batch for every candidate\nawait guard.beforeBuyMany('base', candidates.map((c) => ({ tokenAddress: c.address, claimedSymbol: '${ctx.ticker}' })))\n// → ${JSON.stringify(e.verdicts.slice(0, 3).map((v) => ({ allow: v.allow, decision: v.decision })))}${e.verdicts.length > 3 ? ' …' : ''}`, calls: e.wire, mcp: `verify_stock_tokens({ chain: "base", addresses: [${e.verdicts.length} addresses] })` }),
      extra: [summary, note] })
    // The rows of the list above turn one by one, then the count shows.
    node.after = async () => {
      for (const v of e.verdicts) {
        const row = ctx.list && ctx.list.querySelector(`[data-address="${v.address}"]`)
        if (!row) continue
        const d = verdictOf(v)
        // The row being judged is on screen: the list sits above this card and may have scrolled away.
        row.scrollIntoView({ block: 'nearest', behavior: PACE ? 'smooth' : 'auto' })
        row.classList.add(d.tone); row.querySelector('.dm-c-badge').textContent = d.badge(v)
        await sleep(PACE ? 320 : 0)
      }
      summary.hidden = false; if (note) note.hidden = false
      summary.scrollIntoView({ block: 'nearest', behavior: PACE ? 'smooth' : 'auto' })
    }
    return node
  },
  pick: (e) => card({ who: 'Original', tone: e.address ? 'ok' : 'warn',
    plain: e.address ? h('p', {}, e.how === 'pointer' ? 'The fakes all point to the same original: ' : 'This is the one: ', h('code', {}, short(e.address)), `, the issuer's own ${e.ticker}. Found thanks to Proof of Stock. I buy this one only.`) : h('p', {}, `The search did not surface the issuer's own ${e.ticker}, so I ask Proof of Stock's issuer-listed search for it.`),
    trader: kv([['Buy', e.address || 'from the issuer-listed search', 'mono'], ['Why', e.how === 'search' ? 'the only one on the issuer\'s list' : e.how === 'pointer' ? 'named as the original in the fakes\' answers' : 'not among the search results']]),
    dev: devBlock({ code: `// 3. the pick: the listed one, else a look-alike's use_instead\n// 4. buyFlow({ request: 'buy $${ctx.usd} of ${e.ticker} on Base', handed: '${e.address ? short(e.address) : 'null'}' })` }) }),
  // agent-buy.mjs's own first steps: the pick is checked once more there; only a refusal is worth a card.
  request: (e) => { ctx.ask = e.ask; return null },
  handed: () => null,
  guard_handed: (e) => (e.decision.allow ? null : verdict(e, true)),
  guard_real: (e) => (e.decision.allow ? null : verdict(e, false)),
  find: (e) => card({ who: 'Agent',
    plain: h('p', {}, 'Proof of Stock\'s issuer-listed search names the original: ', h('code', {}, short(e.address)), '.'),
    trader: kv([['Issuer-listed', e.address, 'mono']]),
    dev: devBlock({ calls: e.wire, mcp: `find_stock_token({ chain: "base", query: "${ctx.ticker}" })` }) }),
  passport: (e) => {
    const p = e.passport, r = p.reference || {}, closed = e.session && e.session !== 'regular'
    ctx.symbol = e.symbol; ctx.name = p.issuer && p.issuer.token_name
    // One node per telling: a node has one parent, and the same head in two views would leave one of them without it.
    const head = () => cardHead(`${e.symbol}${ctx.name ? ' · ' + ctx.name : ''}`, e.address, 'Issuer-listed', 'ok')
    const listed = () => h('div', { class: 'plain ok' }, `Issuer-listed: this exact contract is on Coinbase's list of its stock tokens${p.registry_age_s != null ? ` (list read ${age(p.registry_age_s)} ago)` : ''}.`)
    return card({ who: 'Passport', tone: 'ok', boxed: true,
      plain: h('div', {}, head(), listed(), h('div', { class: 'plain' }, `Still issued, nothing is frozen, and the issuer's price is ${usd(e.ref)}.`, closed ? ` The US market is closed right now (${e.session}), so that is the last close.` : '')),
      trader: h('div', {}, head(), kv([['issuer', 'Coinbase'], ['issuer price', usd(e.ref)], ['price age', age(r.age_s), r.age_s > 3600 ? 'warn' : null], ['market', e.session || 'unknown', closed ? 'warn' : null], ['minted', p.issuer.minted ? 'yes' : 'no', 'ok'], ['paused', (p.issuer.paused || []).length ? p.issuer.paused.join(', ') : 'nothing', 'ok'], p.issuer.isin ? ['isin', p.issuer.isin] : null]), listed()),
      dev: devBlock({ calls: e.wire, mcp: `stock_passport({ chain: "base", address: "${short(e.address)}" })` }) })
  },
  quote: (e) => {
    const ok = Math.abs(e.premium) <= e.maxPremium
    const pools = [...new Set((e.routeSummary.route || []).flat().map((s) => s && s.exchange).filter(Boolean))]
    const minOut = e.tokens * (1 - e.slippageBps / 1e4)
    ctx.quote = e
    return card({ who: 'Quote', tone: ok ? 'ok' : 'bad',
      plain: h('p', {}, `The market quote, from an aggregator, gives ${e.tokens.toFixed(4)} ${e.symbol} for ${usd(e.usd)}: ${usd(e.price)} each, ${Math.abs(e.premium * 100).toFixed(2)}% ${e.premium >= 0 ? 'above' : 'below'} the issuer's price. `, ok ? 'That is fair: well inside my 3% limit.' : 'That is too far from the real price.'),
      trader: h('div', {}, gauge(e.premium, e.maxPremium), kv([['Quote', 'aggregator (KyberSwap)'], ['Quoted price', usd(e.price)], ['Issuer price', usd(e.ref)], ['Gap', pct(e.premium), ok ? 'ok' : 'bad'], ['Limit', `±${(e.maxPremium * 100).toFixed(2)}%`], ['You get', `${e.tokens.toFixed(6)} ${e.symbol}`], ['Minimum received', `${minOut.toFixed(6)} ${e.symbol} (0.50% slippage)`], ['Route', pools.length ? pools.join(' → ') : 'KyberSwap'], e.routeSummary.gasUsd ? ['Gas', usd(e.routeSummary.gasUsd)] : null])),
      dev: devBlock({ calls: e.wire, code: `// the quote must be for the checked contract, and within maxPremium of the reference\nprice = ${e.usd} / ${e.tokens.toFixed(8)} = ${e.price.toFixed(4)}\npremium = price / ${e.ref} - 1 = ${e.premium.toFixed(5)}  // |${e.premium.toFixed(5)}| ${ok ? '<=' : '>'} ${e.maxPremium}` }) })
  },
  link: (e) => card({ who: 'Ready', tone: 'done',
    plain: h('p', {}, `Ready. The swap opens on Aerodrome with the real contract already filled in. Aerodrome shows its own final price: accept it only up to ${usd(e.maxPrice)} per ${e.symbol}. You sign in your own wallet: I never touch your money.`),
    trader: kv([['Venue', 'Aerodrome · Base'], ['Network', `Base, chain id ${e.chainId}`], ['Pay', 'USDC'], ['Receive', `${e.symbol} · ${e.address}`, 'mono'], ['Accept at most', `${usd(e.maxPrice)} per ${e.symbol}: the issuer's ${usd(e.ref)} + ${(e.maxPremium * 100).toFixed(0)}%`, 'warn'], ['Price there', 'Aerodrome shows its own'], ['Notice', 'Aerodrome may ask you to accept its restricted-security notice'], ['Before you sign', 'check this address in your wallet']]),
    dev: devBlock({ code: `swapLink('${e.address}')\n// → ${e.link}` }),
    // The network line sits outside the three tellings: every reader sees it, whichever view is on.
    extra: [h('a', { class: 'dm-swap', href: e.link, target: '_blank', rel: 'noopener noreferrer' }, `Swap USDC → ${e.symbol} on Aerodrome`, h('span', { class: 'i i-ext', 'aria-hidden': 'true' })),
      h('p', { class: 'dm-chain' }, h('b', {}, 'Base only. '), e.network), tokenLinks(e.address)] }),
  built: (e) => card({ who: 'Unsigned', tone: 'done',
    plain: h('p', {}, `For developers, I also built the transaction for your wallet ${short(e.from)}, through KyberSwap's router (the Aerodrome button needs none of this). It is not signed: nothing moves until you approve ${usd(ctx.ask.usd)} of USDC and sign the swap yourself.`),
    trader: kv([['Network', `Base, chain id ${e.tx.chainId}: your wallet must be on Base`, 'warn'], ['1 · Approve', `exactly ${usd(ctx.ask.usd)} USDC to the KyberSwap router, not unlimited`], ['2 · Swap', `to router ${short(KYBER_ROUTER)}, value 0`], ['Minimum received', ctx.quote ? `${(ctx.quote.tokens * (1 - ctx.quote.slippageBps / 1e4)).toFixed(6)} ${e.symbol}` : 'not quoted'], ['Signed', 'no']]),
    dev: devBlock({ calls: e.wire, code: `// 1. approve (USDC ${short(USDC_BASE)})\n${JSON.stringify(e.approve, null, 2)}\n// 2. swap\n${JSON.stringify({ ...e.tx, data: e.tx.data.slice(0, 74) + '…' }, null, 2)}` }),
    extra: copyButton(JSON.stringify({ approve: e.approve, swap: e.tx }, null, 2)) }),
  stop: (e) => card({ who: e.code === 0 ? 'Agent' : 'Stopped', tone: e.code === 0 ? 'done' : e.code === 1 ? 'bad' : 'warn',
    plain: h('p', {}, e.why),
    trader: kv([['Outcome', e.outcome], ['Why', e.why]]),
    dev: devBlock({ calls: e.wire, code: `// buyFlow → { code: ${e.code}, outcome: '${e.outcome}' }` }) }),
}

function verdict (e, handed) {
  const d = e.decision, v = d.verify || {}, imp = v.impostor || {}
  const tone = d.allow ? 'ok' : d.decision === 'unknown' ? 'warn' : 'bad'
  const plain = d.allow
    ? `That is the real one: the issuer's own ${v.symbol || (ctx.ask ? ctx.ask.ticker : ctx.ticker)} contract, on ${(v.registries_checked || [])[0]?.startsWith('coinbase') ? 'Coinbase\'s' : 'the issuer\'s'} official list.`
    : d.decision === 'impostor'
      ? `Stop. That is a fake. It copies the name ${imp.imitates_symbol || (ctx.ask ? ctx.ask.ticker : ctx.ticker)}, but the issuer never made it. I won't buy it.`
      : d.decision === 'unknown' ? 'I could not check it, so I will not buy it.' : `It is not on the issuer's list, so I can't vouch for it. I won't buy it.`
  const next = handed && !d.allow && d.use_instead ? ` The issuer's real one is ${short(d.use_instead)}. Checking that instead.` : ''
  return card({ who: 'Guard', tone,
    plain: h('p', {}, plain + next),
    trader: kv([['Verdict', `${d.allow ? 'ALLOW' : 'REFUSE'} · ${d.decision}`, tone], ['Contract', e.address, 'mono'], imp.imitates_symbol ? ['Imitates', imp.imitates_symbol] : null, d.use_instead ? ['Issuer-listed', d.use_instead, 'mono'] : null, (v.registries_checked || []).length ? ['Registry', v.registries_checked.join(', ')] : null, v.registry_age_s != null ? ['List read', `${age(v.registry_age_s)} ago`] : null]),
    dev: devBlock({ code: `await guard.beforeBuy({ chain: 'base', tokenAddress: '${short(e.address)}', claimedSymbol: '${(ctx.ask ? ctx.ask.ticker : ctx.ticker)}' })\n// → ${JSON.stringify({ allow: d.allow, decision: d.decision, ...(d.use_instead ? { use_instead: d.use_instead } : {}) })}`, calls: e.wire, mcp: `verify_stock_tokens({ chain: "base", addresses: ["${short(e.address)}"] })` }) })
}

/** Where the quote sits between −limit and +limit. */
function gauge (premium, limit) {
  const span = limit * 2, x = Math.max(0, Math.min(1, (premium + limit) / span))
  const g = h('div', { class: 'dm-gauge' + (Math.abs(premium) <= limit ? '' : ' out'), role: 'img', 'aria-label': `gap ${pct(premium)}, limit ±${(limit * 100).toFixed(1)}%` },
    h('span', { class: 'dm-g-zero' }), h('span', { class: 'dm-g-mark' }), h('span', { class: 'dm-g-l' }, `−${(limit * 100).toFixed(0)}%`), h('span', { class: 'dm-g-r' }, `+${(limit * 100).toFixed(0)}%`))
  g.style.setProperty('--x', String(x))
  return g
}

function copyButton (text) {
  const b = h('button', { type: 'button', class: 'dm-copy' }, 'Copy the unsigned transactions')
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied' } catch (_) { b.textContent = 'Select it in the Developer view' }
    setTimeout(() => { b.textContent = 'Copy the unsigned transactions' }, 1800)
  })
  return b
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function show (node) {
  log.append(node)
  node.scrollIntoView({ block: 'nearest', behavior: PACE ? 'smooth' : 'auto' })
}
async function typing () {
  if (!PACE) return
  const t = h('li', { class: 'dm-card dm-typing','aria-hidden': 'true' }, h('span', { class: 'dm-who' }, 'Agent'), h('div', { class: 'dm-body' }, h('span', { class: 'dm-dots' }, h('i'), h('i'), h('i'))))
  log.append(t); await sleep(PACE); t.remove()
}

let busy = false
async function go () {
  if (busy) return
  const query = cleanQuery($('dm-q').value), chip = chosenChip(query)
  // The wallet is read in the Developer view only (owner, 25.11): elsewhere it is hidden, and a value typed earlier is ignored.
  const usdIn = Number($('dm-usd').value), from = document.body.dataset.view === 'dev' ? $('dm-from').value.trim() || null : null
  if (!query) { $('dm-q').focus(); return }
  busy = true; run.disabled = true; live.hidden = false
  log.replaceChildren(); wire = []; ctx = { query, usd: usdIn > 0 ? usdIn : 20 }
  await show(h('li', { class: 'dm-card you' }, h('span', { class: 'dm-who' }, 'You'), h('div', { class: 'dm-body' }, h('p', {}, `Find me ${query} on Base`))))
  const queue = []
  let wake = null
  // The calls a step made are the ones recorded since the step before it, taken as the flow reports it (drawing lags).
  const onStep = (e) => { queue.push({ e: { ...e, wire: takeWire() } }); if (wake) wake() }
  let done = false
  const flow = searchFlow({ query, ticker: chip ? chip.dataset.ticker : null, usd: ctx.usd, from, endpoint: ENDPOINT, fetchImpl: recordingFetch, print: () => {}, onStep })
    .catch(() => onStep({ step: 'stop', code: 3, outcome: 'unavailable', why: 'Something could not be read, so I do not buy.' }))
    .finally(() => { done = true; if (wake) wake() })
  // Draw as the steps arrive, at a reading pace; a step with nothing to show costs no time.
  for (;;) {
    if (!queue.length) { if (done) break; await new Promise((r) => { wake = r }); wake = null; continue }
    const { e } = queue.shift()
    const node = draw[e.step] ? draw[e.step](e) : null
    if (!node) continue
    await typing()
    await show(node)
    if (node.after) await node.after()
  }
  await flow
  await show(h('li', { class: 'dm-card end' }, h('span', { class: 'dm-who' }, ''), h('div', { class: 'dm-body' }, h('p', {}, h('span', { class: 'i i-check', 'aria-hidden': 'true' }), 'Nothing was signed. No key was used. Live data at ' + new Date().toISOString().slice(11, 16) + ' UTC.'))))
  busy = false; run.disabled = false; live.hidden = true; run.firstChild.textContent = 'Search again'
}

// ── the stocks to pick ──────────────────────────────────────────────────────────────────────────────────────────────
const chips = [...document.querySelectorAll('.dm-chip')]
const cleanQuery = (s) => String(s || '').replace(/[^\p{L}\p{N} .&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)
const chosenChip = (q) => chips.find((c) => c.dataset.query.toLowerCase() === q.toLowerCase()) || null
const mark = () => { const c = chosenChip(cleanQuery($('dm-q').value)); for (const x of chips) x.setAttribute('aria-pressed', String(x === c)) }
for (const c of chips) c.addEventListener('click', () => { $('dm-q').value = c.dataset.query; mark(); go() })
$('dm-q').addEventListener('input', mark)

$('dm-noscript').hidden = true
form.addEventListener('submit', (ev) => { ev.preventDefault(); go() })
