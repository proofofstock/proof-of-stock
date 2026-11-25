// apps/stocks-web/demo.js: the agent on /demo (apps/stocks-demo-page.mjs). It runs the guard package's own example,
// buyFlow from examples/agent-buy.mjs, in the browser against this site, and draws each step it reports three ways:
// plain words, a trader's numbers, and the calls a developer would make with what they answered.
//
// ⚠ NOTHING HERE SIGNS, SENDS OR ASKS A WALLET. There is no key and no call to a wallet provider. The last card is a link
// and, if the reader typed a public address, an unsigned transaction to copy.
// ⚠ EVERYTHING FROM THE NETWORK IS TEXT. Answers are drawn with textContent only, never as HTML.
import { buyFlow, parseRequest, KYBER_ROUTER, USDC_BASE } from './guard/examples/agent-buy.mjs'

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
const kv = (rows) => h('dl', { class: 'dm-kv' }, rows.filter(Boolean).map(([k, v, cls]) => [h('dt', {}, k), h('dd', { class: cls || null }, v)]))

// ── the steps ───────────────────────────────────────────────────────────────────────────────────────────────────────
let ctx = {}
const draw = {
  request: (e) => {
    ctx.ask = e.ask
    return card({ who: 'Agent',
      plain: h('p', {}, `On it: ${usd(e.ask.usd)} of ${e.ask.ticker}. Before I spend anything, I check what I'm buying.`),
      trader: kv([['Order', `${usd(e.ask.usd)} USDC → ${e.ask.ticker}`], ['Chain', e.ask.chain === 'base' ? 'Base' : e.ask.chain], ['Price limit', '±3.00% of the issuer\'s price'], ['Slippage', '0.50%']]),
      dev: devBlock({ code: `parseRequest(${JSON.stringify(ctx.text)})\n// → ${JSON.stringify(e.ask)}\nconst guard = createGuard({ endpoint: '${ENDPOINT}' })` }) })
  },
  handed: (e) => card({ who: 'Tip', tone: 'tip',
    plain: h('p', {}, `Someone sent me a ${ctx.ask.ticker} contract: `, h('code', {}, short(e.address)), '. It looks right. I check it before anything else.'),
    trader: kv([['Handed', e.address, 'mono'], ['Claims to be', ctx.ask.ticker], ['Source', 'a tip: unknown']]),
    dev: devBlock({ code: `// the agent was handed this address\nconst handed = '${e.address}'` }) }),
  guard_handed: (e) => verdict(e, true),
  find: (e) => card({ who: 'Agent',
    plain: h('p', {}, `I looked ${ctx.ask.ticker} up on the issuer's own list.`),
    trader: kv([['Issuer-listed', e.address, 'mono']]),
    dev: devBlock({ calls: e.wire, mcp: `find_stock_token({ chain: "base", query: "${ctx.ask.ticker}" })` }) }),
  guard_real: (e) => verdict(e, false),
  passport: (e) => {
    const p = e.passport, r = p.reference || {}, closed = e.session && e.session !== 'regular'
    ctx.symbol = e.symbol; ctx.name = p.issuer && p.issuer.token_name
    return card({ who: 'Passport', tone: 'ok',
      plain: h('p', {}, `Its passport is clean: ${ctx.name || e.symbol} is still issued, nothing is frozen, and the issuer's price is ${usd(e.ref)}.`, closed ? ` The US market is closed right now (${e.session}), so that is the last close.` : ''),
      trader: kv([['Token', `${e.symbol}${ctx.name ? ' · ' + ctx.name : ''}`], ['Issuer price', usd(e.ref)], ['Price age', age(r.age_s), r.age_s > 3600 ? 'warn' : null], ['Market', e.session || 'unknown', closed ? 'warn' : null], ['Minted', p.issuer.minted ? 'yes' : 'no', 'ok'], ['Paused', (p.issuer.paused || []).length ? p.issuer.paused.join(', ') : 'nothing', 'ok']]),
      dev: devBlock({ calls: e.wire, mcp: `stock_passport({ chain: "base", address: "${short(e.address)}" })` }) })
  },
  quote: (e) => {
    const ok = Math.abs(e.premium) <= e.maxPremium
    const pools = [...new Set((e.routeSummary.route || []).flat().map((s) => s && s.exchange).filter(Boolean))]
    const minOut = e.tokens * (1 - e.slippageBps / 1e4)
    ctx.quote = e
    return card({ who: 'Quote', tone: ok ? 'ok' : 'bad',
      plain: h('p', {}, `The exchange gives ${e.tokens.toFixed(4)} ${e.symbol} for ${usd(e.usd)}: ${usd(e.price)} each, ${Math.abs(e.premium * 100).toFixed(2)}% ${e.premium >= 0 ? 'above' : 'below'} the issuer's price. `, ok ? 'That is fair: well inside my 3% limit.' : 'That is too far from the real price.'),
      trader: h('div', {}, gauge(e.premium, e.maxPremium), kv([['Pool price', usd(e.price)], ['Issuer price', usd(e.ref)], ['Gap', pct(e.premium), ok ? 'ok' : 'bad'], ['Limit', `±${(e.maxPremium * 100).toFixed(2)}%`], ['You get', `${e.tokens.toFixed(6)} ${e.symbol}`], ['Minimum received', `${minOut.toFixed(6)} ${e.symbol} (0.50% slippage)`], ['Route', pools.length ? pools.join(' → ') : 'KyberSwap'], e.routeSummary.gasUsd ? ['Gas', usd(e.routeSummary.gasUsd)] : null])),
      dev: devBlock({ calls: e.wire, code: `// the quote must be for the checked contract, and within maxPremium of the reference\nprice = ${e.usd} / ${e.tokens.toFixed(8)} = ${e.price.toFixed(4)}\npremium = price / ${e.ref} - 1 = ${e.premium.toFixed(5)}  // |${e.premium.toFixed(5)}| ${ok ? '<=' : '>'} ${e.maxPremium}` }) })
  },
  link: (e) => card({ who: 'Ready', tone: 'done',
    plain: h('p', {}, 'Ready. The swap opens on KyberSwap with the real contract already filled in. You sign in your own wallet: I never touch your money.'),
    trader: kv([['Venue', 'KyberSwap · Base'], ['Pay', 'USDC'], ['Receive', `${e.symbol} · ${e.address}`, 'mono'], ['Before you sign', 'check this address in your wallet']]),
    dev: devBlock({ code: `swapLink('${e.address}')\n// → ${e.link}` }),
    extra: h('a', { class: 'dm-swap', href: e.link, target: '_blank', rel: 'noopener noreferrer' }, `Swap USDC → ${e.symbol} on KyberSwap`, h('span', { class: 'i i-ext', 'aria-hidden': 'true' })) }),
  built: (e) => card({ who: 'Unsigned', tone: 'done',
    plain: h('p', {}, `I built the transaction for your wallet ${short(e.from)}. It is not signed: nothing moves until you approve ${usd(ctx.ask.usd)} of USDC and sign the swap yourself.`),
    trader: kv([['1 · Approve', `exactly ${usd(ctx.ask.usd)} USDC to the KyberSwap router, not unlimited`], ['2 · Swap', `to router ${short(KYBER_ROUTER)}, value 0`], ['Minimum received', ctx.quote ? `${(ctx.quote.tokens * (1 - ctx.quote.slippageBps / 1e4)).toFixed(6)} ${e.symbol}` : 'not quoted'], ['Signed', 'no']]),
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
    ? `That is the real one: the issuer's own ${v.symbol || ctx.ask.ticker} contract, on ${(v.registries_checked || [])[0]?.startsWith('coinbase') ? 'Coinbase\'s' : 'the issuer\'s'} official list.`
    : d.decision === 'impostor'
      ? `Stop. That is a fake. It copies the name ${imp.imitates_symbol || ctx.ask.ticker}, but the issuer never made it. I won't buy it.`
      : d.decision === 'unknown' ? 'I could not check it, so I will not buy it.' : `It is not on the issuer's list, so I can't vouch for it. I won't buy it.`
  const next = handed && !d.allow && d.use_instead ? ` The issuer's real one is ${short(d.use_instead)}. Checking that instead.` : ''
  return card({ who: 'Guard', tone,
    plain: h('p', {}, plain + next),
    trader: kv([['Verdict', `${d.allow ? 'ALLOW' : 'REFUSE'} · ${d.decision}`, tone], ['Contract', e.address, 'mono'], imp.imitates_symbol ? ['Imitates', imp.imitates_symbol] : null, d.use_instead ? ['Issuer-listed', d.use_instead, 'mono'] : null, (v.registries_checked || []).length ? ['Registry', v.registries_checked.join(', ')] : null, v.registry_age_s != null ? ['List read', `${age(v.registry_age_s)} ago`] : null]),
    dev: devBlock({ code: `await guard.beforeBuy({ chain: 'base', tokenAddress: '${short(e.address)}', claimedSymbol: '${ctx.ask.ticker}' })\n// → ${JSON.stringify({ allow: d.allow, decision: d.decision, ...(d.use_instead ? { use_instead: d.use_instead } : {}) })}`, calls: e.wire, mcp: `verify_stock_tokens({ chain: "base", addresses: ["${short(e.address)}"] })` }) })
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
  const text = $('dm-q').value.trim(), handed = $('dm-handed').value.trim() || null, from = $('dm-from').value.trim() || null
  busy = true; run.disabled = true; live.hidden = false
  log.replaceChildren(); wire = []; ctx = { text }
  await show(h('li', { class: 'dm-card you' }, h('span', { class: 'dm-who' }, 'You'), h('div', { class: 'dm-body' }, h('p', {}, text))))
  const queue = []
  let wake = null
  // The calls a step made are the ones recorded since the step before it, taken as the flow reports it (drawing lags).
  const onStep = (e) => { queue.push({ e: { ...e, wire: takeWire() } }); if (wake) wake() }
  let done = false
  const flow = (parseRequest(text) ? buyFlow({ request: text, handed, from, endpoint: ENDPOINT, fetchImpl: recordingFetch, print: () => {}, onStep })
    : Promise.resolve(onStep({ step: 'stop', code: 2, outcome: 'bad_input', why: 'I read requests like "buy $20 of SNDK on Base". Nothing bought.' })))
    .catch(() => onStep({ step: 'stop', code: 3, outcome: 'unavailable', why: 'Something could not be read, so I do not buy.' }))
    .finally(() => { done = true; if (wake) wake() })
  // Draw as the steps arrive, at a reading pace.
  for (;;) {
    if (!queue.length) { if (done) break; await new Promise((r) => { wake = r }); wake = null; continue }
    const { e } = queue.shift()
    if (e.step !== 'request') await typing()
    const node = draw[e.step] ? draw[e.step](e) : null
    if (node) await show(node)
  }
  await flow
  await show(h('li', { class: 'dm-card end' }, h('span', { class: 'dm-who' }, ''), h('div', { class: 'dm-body' }, h('p', {}, h('span', { class: 'i i-check', 'aria-hidden': 'true' }), 'Nothing was signed. No key was used. Live data at ' + new Date().toISOString().slice(11, 16) + ' UTC.'))))
  busy = false; run.disabled = false; live.hidden = true; run.firstChild.textContent = 'Run again'
}

$('dm-noscript').hidden = true
form.addEventListener('submit', (ev) => { ev.preventDefault(); go() })
