// apps/demo-page.test.mjs: /demo, an agent that checks with Proof of Stock before it buys (owner, 25.11). The page must
// run the guard package's own example (not a copy), reach only KyberSwap and Base's RPC beyond this site, and only on
// this page, never ask a wallet for anything, draw what the network says as text only, and tell the run three ways.
//
// Run: node apps/demo-page.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb, SECURITY_HEADERS } from './stocks-web.mjs'
import { demoPage, demoCsp, DEMO_HOSTS, DEMO_LOOKALIKE, DEMO_REQUEST, VIEWS, STEPS } from './stocks-demo-page.mjs'
import { TABS } from './stocks-nav.mjs'
import { parseRequest, KYBER, BASE_RPC } from '../packages/proofofstock-guard/examples/agent-buy.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const js = read('./stocks-web/demo.js'), css = read('./stocks-web/demo.css'), example = read('../packages/proofofstock-guard/examples/agent-buy.mjs')
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]))

console.log('the page itself')
{
  const html = demoPage({ version: '9.9.9', assets: { css: 'style.css', docsCss: 'docs.css', demoCss: 'demo.css', demoJs: 'demo.js' } })
  check('Demo Agent is a tab, right after Home, and it is this page\'s', TABS[1].id === 'demo' && TABS[1].href === 'demo' && /<a class="site-tab" href="\.\/demo" aria-current="page">Demo Agent<\/a>/.test(html))
  check('it is called the Demo Agent, never a bare Demo: in the title, the H1 and the tab', /<title>Demo Agent: [^<]*<\/title>/.test(html) && /<h1>Demo Agent /.test(html) && /Demo Agent · live/.test(html) && !/>Demo</.test(html) && !/<title>Demo:/.test(html))
  const views = [...html.matchAll(/<button type="button" class="dm-view" data-view="([a-z]+)" aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)]
  check('one switch, three views in order: Plain, Trader, Developer, Plain first', views.map((m) => m[3]).join() === 'Plain,Trader,Developer' && views.map((m) => m[2]).join() === 'true,false,false' && VIEWS.map((v) => v.id).join() === 'plain,trader,dev')
  check('the request it starts with is one the example reads', html.includes(`value="${DEMO_REQUEST.replace('$', '$')}"`) && JSON.stringify(parseRequest(DEMO_REQUEST)) === JSON.stringify({ usd: 20, ticker: 'SNDK', chain: 'base' }))
  check('the agent is handed the look-alike the example is handed', html.includes(`value="${DEMO_LOOKALIKE}"`) && example.includes(`'${DEMO_LOOKALIKE}'`))
  check('a reader that runs no script still reads every step', STEPS.length === 7 && STEPS.every(([t]) => html.includes(t.replace(/'/g, '&#39;'))))
  check('it says what it never does: sign, hold a key, connect a wallet', /Never signs/.test(html) && /No keys, no wallet connection/.test(html))
  check('the script is a module, from this site', /<script type="module" src="demo\.js"><\/script>/.test(html))
}

console.log('the CSP: two more hosts, on this page only')
{
  const base = directives(SECURITY_HEADERS['content-security-policy']), demo = directives(demoCsp(SECURITY_HEADERS['content-security-policy']))
  check('the hosts are the example\'s own: KyberSwap\'s aggregator and Base\'s RPC', DEMO_HOSTS.join() === [new URL(KYBER).origin, new URL(BASE_RPC).origin].join() && DEMO_HOSTS.every((h) => /^https:\/\/[a-z0-9.-]+$/.test(h)))
  check('connect-src gains exactly those two', demo['connect-src'] === `'self' ${DEMO_HOSTS.join(' ')}`, demo['connect-src'])
  check('...and every other directive is the site\'s, unchanged', Object.keys(base).every((k) => k === 'connect-src' || base[k] === demo[k]) && Object.keys(demo).length === Object.keys(base).length)
}

console.log('the script: the example itself, text only, no wallet')
{
  check('it runs buyFlow from the guard\'s example as served, not a copy', /^import \{ buyFlow, parseRequest[^}]*\} from '\.\/guard\/examples\/agent-buy\.mjs'$/m.test(js) && !/async function buyFlow/.test(js))
  check('it never asks a wallet, signs or sends', !/ethereum|eth_send|eth_sign|personal_sign|signTypedData|sendTransaction|privateKey|mnemonic|seed/i.test(js))
  check('what the network says is drawn as text, never as HTML', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/.test(js))
  check('the example it runs is browser-safe: no process at import time', /const isMain = globalThis\.process\?\.argv\?\.\[1\]/.test(example))
  check('one telling shows at a time', /\.dm \.v-trader, \.dm \.v-dev \{ display: none; \}/.test(css) && /\.dm\[data-view="trader"\] \.v-trader, \.dm\[data-view="dev"\] \.v-dev \{ display: block; \}/.test(css))
  for (const step of ['request', 'handed', 'guard_handed', 'find', 'guard_real', 'passport', 'quote', 'link', 'built', 'stop']) {
    check(`it draws the example's ${step} step`, new RegExp(`\\b${step}: \\(e\\) =>`).test(js) && example.includes(`step('${step}'`))
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
  check('/demo answers the page', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && page.includes('<h1>Demo Agent <em>checks before it buys</em></h1>'))
  check('served /demo lets the browser reach KyberSwap and Base\'s RPC, nothing more', r.headers.get('content-security-policy') === demoCsp(SECURITY_HEADERS['content-security-policy']), r.headers.get('content-security-policy'))
  for (const p of ['/stocks/', '/stocks/api', '/stocks/status']) {
    const o = await fetch(origin + p)
    check(`${p} keeps connect-src 'self'`, directives(o.headers.get('content-security-policy'))['connect-src'] === "'self'")
  }
  // Each file the page loads, and each module those import, resolved the way a browser resolves it.
  const assets = [...page.matchAll(/(?:href|src)="((?:style|docs|demo|beacon)\.(?:css|js)\?v=[0-9a-f]{12})"/g)].map((m) => new URL(m[1], origin + '/stocks/demo').href)
  check('the page loads its two stylesheets of the site, its own, and its script', assets.length >= 4 && assets.some((a) => a.includes('/demo.js?v=')) && assets.some((a) => a.includes('/demo.css?v=')))
  for (const a of assets) check(`${new URL(a).pathname} answers 200`, (await fetch(a)).status === 200)
  const modules = [[new URL('./guard/examples/agent-buy.mjs', origin + '/stocks/demo.js').href, '../packages/proofofstock-guard/examples/agent-buy.mjs'], [new URL('../index.mjs', origin + '/stocks/guard/examples/agent-buy.mjs').href, '../packages/proofofstock-guard/index.mjs']]
  for (const [url, file] of modules) {
    const m = await fetch(url)
    const body = await m.text()
    check(`${new URL(url).pathname} is the package's ${path.basename(file)}, byte for byte, as JavaScript`, m.status === 200 && /javascript/.test(m.headers.get('content-type')) && body === read(file))
  }
  check('the example imports the guard by the path the server serves it at', /^import \{ createGuard, DEFAULT_ENDPOINT \} from '\.\.\/index\.mjs'$/m.test(example))
} finally {
  await app.stop()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
