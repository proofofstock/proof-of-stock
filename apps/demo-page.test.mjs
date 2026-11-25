// apps/demo-page.test.mjs: /demo, the Demo Agent (owner, 25.11): it searches the market for a stock and lets Proof of
// Stock tell the original from the fakes. The page must run the guard package's own examples (not copies), reach only
// GeckoTerminal, KyberSwap and Base's RPC beyond this site, and only on this page, never ask a wallet for anything, draw
// what the network says as text only, credit each verdict to Proof of Stock, and tell the run three ways.
//
// Run: node apps/demo-page.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb, SECURITY_HEADERS } from './stocks-web.mjs'
import { demoPage, demoCsp, DEMO_HOSTS, DEMO_STOCKS, VIEWS, STEPS } from './stocks-demo-page.mjs'
import { TABS } from './stocks-nav.mjs'
import { KYBER, BASE_RPC } from '../packages/proofofstock-guard/examples/agent-buy.mjs'
import { GECKO } from '../packages/proofofstock-guard/examples/agent-search.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const js = read('./stocks-web/demo.js'), css = read('./stocks-web/demo.css')
const buy = read('../packages/proofofstock-guard/examples/agent-buy.mjs'), search = read('../packages/proofofstock-guard/examples/agent-search.mjs')
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]))

console.log('the page itself')
{
  const html = demoPage({ version: '9.9.9', assets: { css: 'style.css', docsCss: 'docs.css', demoCss: 'demo.css', demoJs: 'demo.js' } })
  check('Demo Agent is a tab, right after Home, and it is this page\'s', TABS[1].id === 'demo' && TABS[1].href === 'demo' && /<a class="site-tab" href="\.\/demo" aria-current="page">Demo Agent<\/a>/.test(html))
  check('it is called the Demo Agent, never a bare Demo: in the title, the H1 and the tab', /<title>Demo Agent: [^<]*<\/title>/.test(html) && /<h1>Demo Agent /.test(html) && /Demo Agent · live/.test(html) && !/>Demo</.test(html) && !/<title>Demo:/.test(html))
  const views = [...html.matchAll(/<button type="button" class="dm-view" data-view="([a-z]+)" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)]
  check('one switch, three views in order: Plain, Trader, Developer, Plain first', views.map((m) => m[3]).join() === 'Plain,Trader,Developer' && views.map((m) => m[2]).join() === 'true,false,false' && VIEWS.map((v) => v.id).join() === 'plain,trader,dev')
  const chips = [...html.matchAll(/<button type="button" class="dm-chip" data-query="([^"]+)" data-ticker="([A-Z]+)" aria-pressed="(true|false)">/g)]
  check('no command to type: one button per stock, Circle first and chosen (owner, 25.11)', chips.map((m) => m[1]).join() === 'Circle,Tesla,SanDisk,NVIDIA' && chips.map((m) => m[3]).join() === 'true,false,false,false' && DEMO_STOCKS[0].ticker === 'CRCL' && /<input id="dm-q" name="q" value="Circle"/.test(html) && !/buy \$20 of/.test(html))
  check('nothing is handed to the agent: no contract field', !/dm-handed/.test(html) && !/dm-handed/.test(js))
  // Owner, 25.11: the wallet is for developers only. It sits in its own block, apart from the amount everyone may set.
  check('the wallet field sits in a developer-only block, apart from the amount', /<details class="dm-more dm-dev-only" id="dm-wallet">[\s\S]*?<input id="dm-from"[\s\S]*?<\/details>/.test(html) && /<details class="dm-more">\s*<summary>Amount<\/summary>[\s\S]*?<input id="dm-usd"[^>]*>\s*<\/details>/.test(html) && html.indexOf('id="dm-from"') > html.indexOf('id="dm-wallet"'))
  check('a reader that runs no script still reads every step', STEPS.length === 7 && STEPS.every(([t]) => html.includes(t.replace(/'/g, '&#39;'))))
  check('it says what it never does: sign, hold a key, connect a wallet', /Never signs/.test(html) && /No keys, no wallet connection/.test(html))
  check('the script is a module, from this site', /<script type="module" src="demo\.js"><\/script>/.test(html))
}

console.log('the CSP: three more hosts, on this page only')
{
  const base = directives(SECURITY_HEADERS['content-security-policy']), demo = directives(demoCsp(SECURITY_HEADERS['content-security-policy']))
  check('the hosts are the examples\' own: GeckoTerminal\'s search, KyberSwap\'s aggregator and Base\'s RPC', DEMO_HOSTS.join() === [new URL(GECKO).origin, new URL(KYBER).origin, new URL(BASE_RPC).origin].join() && DEMO_HOSTS.every((h) => /^https:\/\/[a-z0-9.-]+$/.test(h)))
  check('connect-src gains exactly those three', demo['connect-src'] === `'self' ${DEMO_HOSTS.join(' ')}`, demo['connect-src'])
  check('...and every other directive is the site\'s, unchanged', Object.keys(base).every((k) => k === 'connect-src' || base[k] === demo[k]) && Object.keys(demo).length === Object.keys(base).length)
}

console.log('the script: the examples themselves, text only, no wallet')
{
  check('it runs searchFlow from the guard\'s example as served, not a copy', /^import \{ searchFlow \} from '\.\/guard\/examples\/agent-search\.mjs'$/m.test(js) && !/async function (searchFlow|buyFlow)/.test(js) && /^import \{ buyFlow \} from '\.\/agent-buy\.mjs'$/m.test(search))
  check('it never asks a wallet, signs or sends', !/ethereum|eth_send|eth_sign|personal_sign|signTypedData|sendTransaction|privateKey|mnemonic|seed/i.test(js))
  check('what the network says is drawn as text, never as HTML', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/.test(js))
  check('the examples it runs are browser-safe: no process at import time', [buy, search].every((s) => /const isMain = globalThis\.process\?\.argv\?\.\[1\]/.test(s)))
  check('the wallet block shows in the Developer view only, and is read there only', /\.dm:not\(\[data-view="dev"\]\) \.dm-dev-only \{ display: none; \}/.test(css) && /from = document\.body\.dataset\.view === 'dev' \? \$\('dm-from'\)\.value\.trim\(\) \|\| null : null/.test(js) && (js.match(/\$\('dm-from'\)/g) || []).length === 1)
  // Owner, 25.11: the blocks inside the demo look like the main terminal's: its fields with a dotted leader, its card head
  // and its link buttons, by the same classes from style.css, not look-alikes.
  check('the blocks are the main terminal\'s own: fields with a dotted leader, the card head, the link buttons', /h\('div', \{ class: 'field' \}, h\('span', \{ class: 'k' \}, String\(k\)\.toLowerCase\(\)\), h\('span', \{ class: 'dots-fill' \}\)/.test(js) && /h\('span', \{ class: 'chainmark base' \}, 'Base'\)/.test(js) && /class: 'btn link'/.test(js) && !/dm-kv/.test(js + css) && ['.field .dots-fill', '.cardhead h2', '.chainmark', '.plain.ok', '.btn.link', '.actions'].every((c) => read('./stocks-web/style.css').includes(c + ' {') || read('./stocks-web/style.css').includes(c + '{') || read('./stocks-web/style.css').includes(c + ',') || read('./stocks-web/style.css').includes(c + '.')))
  check('one telling shows at a time', /\.dm \.v-trader, \.dm \.v-dev \{ display: none; \}/.test(css) && /\.dm\[data-view="trader"\] \.v-trader, \.dm\[data-view="dev"\] \.v-dev \{ display: block; \}/.test(css))
  check('every verdict is credited to Proof of Stock, and a token off the list is not called fake', /'Checked by Proof of Stock'/.test(js) && /Found thanks to Proof of Stock/.test(js) && /not_listed: \{ tone: 'grey', badge: \(\) => 'Not on the issuer\\'s list' \}/.test(js) && /is not the same as fake/.test(js))
  // Owner, 25.11: the button opened KyberSwap on Ethereum for a wallet left there. The line stands outside the three
  // tellings, so every view shows it, and the button names the network too.
  check('beside the swap button, in every view: the trade is on Base, and stop on any other network', /extra: \[h\('a', \{ class: 'dm-swap'[^\n]*on Aerodrome`/.test(js) && /\n {6}h\('p', \{ class: 'dm-chain' \}, h\('b', \{\}, 'Base only\. '\), e\.network\), tokenLinks\(e\.address\)\] \}\),/.test(js) && /network: BASE_ONLY/.test(buy) && /\.dm-chain \{/.test(css) && !/\.dm-chain[^{]*\{[^}]*display: none/.test(css))
  // Owner, 25.11: the button opens Aerodrome, while the quote is an aggregator's. The page says so, and gives the
  // highest price to accept there, in plain words and in the trader's view.
  check('the quote is named as the aggregator\'s, and the reader is given the most to pay on Aerodrome', /The market quote, from an aggregator/.test(js) && /Aerodrome shows its own final price: accept it only up to \$\{usd\(e\.maxPrice\)\}/.test(js) && /\['Accept at most', /.test(js) && /maxPrice = ref \* \(1 \+ maxPremium\)/.test(buy) && /restricted-security notice/.test(js))
  for (const [step, file] of [['search', search], ['candidates', search], ['verdicts', search], ['pick', search], ['find', buy], ['guard_real', buy], ['passport', buy], ['quote', buy], ['link', buy], ['built', buy], ['stop', buy]]) {
    check(`it draws the examples' ${step} step`, new RegExp(`\\b${step}: \\(e\\) =>`).test(js) && file.includes(`step('${step}'`))
  }
}

console.log('served')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-page-'))
const app = createStocksWeb({ roots: { base: path.join(root, 'b'), robinhood: path.join(root, 'r') }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module: null })
const { port } = await app.start(0, '127.0.0.1')
const origin = `http://127.0.0.1:${port}`
try {
  const r = await fetch(origin + '/stocks/demo')
  const page = await r.text()
  check('/demo answers the page', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && page.includes('<h1>Demo Agent <em>finds the real stock</em></h1>'))
  check('served /demo lets the browser reach KyberSwap and Base\'s RPC, nothing more', r.headers.get('content-security-policy') === demoCsp(SECURITY_HEADERS['content-security-policy']), r.headers.get('content-security-policy'))
  for (const p of ['/stocks/', '/stocks/api', '/stocks/status']) {
    const o = await fetch(origin + p)
    check(`${p} keeps connect-src 'self'`, directives(o.headers.get('content-security-policy'))['connect-src'] === "'self'")
  }
  // Each file the page loads, and each module those import, resolved the way a browser resolves it.
  const assets = [...page.matchAll(/(?:href|src)="((?:style|docs|demo|beacon)\.(?:css|js)\?v=[0-9a-f]{12})"/g)].map((m) => new URL(m[1], origin + '/stocks/demo').href)
  check('the page loads its two stylesheets of the site, its own, and its script', assets.length >= 4 && assets.some((a) => a.includes('/demo.js?v=')) && assets.some((a) => a.includes('/demo.css?v=')))
  for (const a of assets) check(`${new URL(a).pathname} answers 200`, (await fetch(a)).status === 200)
  const modules = [[new URL('./guard/examples/agent-search.mjs', origin + '/stocks/demo.js').href, '../packages/proofofstock-guard/examples/agent-search.mjs'], [new URL('./agent-buy.mjs', origin + '/stocks/guard/examples/agent-search.mjs').href, '../packages/proofofstock-guard/examples/agent-buy.mjs'], [new URL('../index.mjs', origin + '/stocks/guard/examples/agent-buy.mjs').href, '../packages/proofofstock-guard/index.mjs']]
  for (const [url, file] of modules) {
    const m = await fetch(url)
    const body = await m.text()
    check(`${new URL(url).pathname} is the package's ${path.basename(file)}, byte for byte, as JavaScript`, m.status === 200 && /javascript/.test(m.headers.get('content-type')) && body === read(file))
  }
  check('the examples import the guard by the path the server serves it at', /^import \{ createGuard, DEFAULT_ENDPOINT \} from '\.\.\/index\.mjs'$/m.test(buy) && /^import \{ createGuard, DEFAULT_ENDPOINT, MAX_BATCH \} from '\.\.\/index\.mjs'$/m.test(search))
} finally {
  await app.stop()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
