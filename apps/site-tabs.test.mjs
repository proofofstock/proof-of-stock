// apps/site-tabs.test.mjs: the tabs at the top of every page (owner, 22.11). Each page kind the site renders (the
// landing, /status, /history, /api, the docs) arrives with the same tabs in the same order, the right one marked as
// current, and every tab's link, resolved from that page, opens a page that exists. The landing's ticker moved from the
// top of the page to under the terminal, and Robinhood Chain stays hidden there.
//
// Run: node apps/site-tabs.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb } from './stocks-web.mjs'
import { TABS, siteTabs, siteBar, tabOfDoc } from './stocks-nav.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const css = read('./stocks-web/style.css'), docsCss = read('./stocks-web/docs.css'), html = read('./stocks-web/index.html')
const navOf = (page) => (String(page).match(/<nav class="site-tabs" aria-label="Site">[\s\S]*?<\/nav>/) || [''])[0]
const tabsOf = (nav) => [...nav.matchAll(/<a class="site-tab" href="([^"]*)"( aria-current="page")?>([^<]*)<\/a>/g)].map((m) => ({ href: m[1], current: Boolean(m[2]), label: m[3] }))

console.log('the tabs themselves')
{
  check('eight tabs in the owner\'s order: Home, Demo Agent, Methodology, Proofs, API, Status, History, Docs', TABS.map((t) => t.label).join(',') === 'Home,Demo Agent,Methodology,Proofs,API,Status,History,Docs')
  check('Methodology opens the methodology, Proofs the page on checking us without us', TABS.find((t) => t.id === 'methodology').href === 'docs/explanation/methodology.md' && TABS.find((t) => t.id === 'proofs').href === 'docs/how-to/check-us.md')
  for (const t of TABS) {
    const tabs = tabsOf(siteTabs({ current: t.id, root: '../' }))
    check(`with ${t.id} current, exactly that one tab is marked`, tabs.length === TABS.length && tabs.filter((x) => x.current).length === 1 && tabs.find((x) => x.current).label === t.label)
  }
  check('every href is relative to the root it is handed', tabsOf(siteTabs({ current: 'home', root: '../../' })).every((x, i) => x.href === '../../' + TABS[i].href))
  check('an unknown page marks no tab rather than a wrong one', tabsOf(siteTabs({ current: 'nope' })).every((x) => !x.current))
  check('docs pages sit under their tab: methodology, proofs, API; the rest under Docs', tabOfDoc('explanation/methodology.md') === 'methodology' && tabOfDoc('how-to/check-us.md') === 'proofs' && tabOfDoc('how-to/verify-an-anchor.md') === 'proofs' && tabOfDoc('how-to/keep-a-receipt.md') === 'proofs' && tabOfDoc('reference/http-api.md') === 'api' && tabOfDoc('reference/tools.md') === 'api' && tabOfDoc('how-to/alert-on-gap.md') === 'docs' && tabOfDoc('README.md') === 'docs')
  const bar = siteBar({ current: 'api', extra: '<b>x</b>' })
  check('the bar needs nothing the CSP forbids: no inline style, script or handler', !/<script|<style|\sstyle=|\son[a-z]+=/.test(siteBar({ current: 'home' })))
  check('every class the bar uses is styled in style.css, which every page loads', [...new Set([...bar.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].every((c) => new RegExp('\\.' + c + '[\\s{.:,\\[]').test(css)))
  check('the current tab is told to screen readers, not only drawn', /\.site-tab\[aria-current="page"\]/.test(css) && bar.includes('aria-current="page"'))
}

console.log('the landing: tabs on top, the ticker under the terminal')
{
  check('the landing has one placeholder for the bar, right after the background and before the hero', /<div class="bg"[^\n]*\n  <!--site-bar-->\n\n  <header class="hero">/.test(html) && html.split('<!--site-bar-->').length === 2)
  const tape = html.indexOf('<div class="tape"'), term = html.indexOf('</main>'), checks = html.indexOf('<section class="checks"')
  check('the ticker is still on the page (moved, not removed): after the terminal, before the three checks', tape > 0 && term > 0 && tape > term && tape < checks, `tape ${tape}, terminal ends ${term}, checks ${checks}`)
  check('the ticker keeps what app.js fills: #tape inside a .tape-track', /<div class="tape-track"><div id="tape" class="tape-run"><\/div><\/div>/.test(html) && read('./stocks-web/app.js').includes("$('#tape')"))
  check('Robinhood Chain stays hidden on the landing', /<body class="no-rh">/.test(html))
  // Owner, 23.11: out of beta. Neither the landing's footer nor a docs page's header says beta any more.
  check('no page says beta: not the landing footer, not the docs header', !/beta-tag|>beta</i.test(html) && !/beta-tag|>beta</i.test(read('./stocks-docs.mjs')))
  // The footer does not repeat the tabs (owner, 23.11): Docs, Methodology, API and History are in the bar above.
  const foot = (html.match(/<nav class="foot-nav"[\s\S]*?<\/nav>/) || [''])[0]
  check('the footer repeats none of the tabs: no Docs, Methodology, API or History link there', foot.length > 0 && !/href="(docs\/|docs\/explanation\/methodology\.md|api|history)"/.test(foot) && /href="status"/.test(foot) && /href="llms\.txt"/.test(foot), foot.slice(0, 200))
  // Measured in a browser on 25.11 with eight tabs: one row from 901px (from 1181px beside the docs search box, with the
  // call to connect an agent from 1341px), below that the tabs take a row of their own instead of scrolling out of sight.
  check('eight tabs never scroll out of sight: below 900px the tabs take their own row, beside the docs search from 1180px', /@media \(max-width: 900px\) \{\n  \.site-bar \{ grid-template-columns: auto minmax\(0, 1fr\); grid-template-areas: "brand extra" "tabs tabs";/.test(css) && /@media \(max-width: 1180px\) \{\n  \.site-bar\.has-extra \{ grid-template-columns: auto minmax\(0, 1fr\); grid-template-areas: "brand extra" "tabs tabs";/.test(css) && /@media \(max-width: 1340px\) \{ \.site-bar\.has-extra \.site-cta \{ display: none; \} \}/.test(css))
  check('on a phone the bar scrolls away and the tabs wrap, so the current one is always in view', /@media \(max-width: 760px\) \{\n  \.site-bar, \.site-bar\.has-extra \{ position: static;/.test(css) && /\.site-tabs \{ flex-wrap: wrap;/.test(css))
  check('docs: the sticky sidebar starts below the two-row bar between a tablet and a phone', /@media \(max-width: 1000px\) and \(min-width: 761px\) \{ \.dx-side \{ top: 98px;/.test(docsCss))
}

console.log('served: every page kind has the tabs, and every tab opens a page')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-tabs-'))
const app = createStocksWeb({ roots: { base: path.join(root, 'b'), robinhood: path.join(root, 'r') }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module: null })
const { port } = await app.start(0, '127.0.0.1')
const base = `http://127.0.0.1:${port}`
const get = (p) => fetch(base + p, { headers: { accept: 'text/html' } })
try {
  const pages = [
    ['/stocks/', 'home'], ['/stocks/status', 'status'], ['/stocks/history', 'history'], ['/stocks/api', 'api'], ['/stocks/demo', 'demo'],
    ['/stocks/docs/', 'docs'], ['/stocks/docs/explanation/methodology.md', 'methodology'], ['/stocks/docs/how-to/verify-an-anchor.md', 'proofs'],
    ['/stocks/docs/reference/http-api.md', 'api'], ['/stocks/docs/how-to/alert-on-gap.md', 'docs'],
  ]
  const opened = new Map()
  for (const [p, current] of pages) {
    const r = await get(p)
    const page = await r.text()
    const tabs = tabsOf(navOf(page))
    check(`${p}: 200, with the eight tabs in order`, r.status === 200 && tabs.map((t) => t.label).join(',') === TABS.map((t) => t.label).join(','), `${r.status} ${tabs.map((t) => t.label)}`)
    check(`${p}: ${current} is the current tab, and only it`, tabs.filter((t) => t.current).map((t) => t.label).join() === TABS.find((t) => t.id === current).label)
    check(`${p}: one bar, and no placeholder left over`, page.split('class="site-bar').length === 2 && !page.includes('<!--site-bar-->'))
    // Every tab, resolved the way a browser resolves it from this page, is a page of the site.
    const want = TABS.map((t) => '/stocks/' + t.href)
    const got = tabs.map((t) => new URL(t.href, base + p).pathname)
    check(`${p}: each tab resolves to its page under the site's root`, got.join() === want.join(), got.join(' '))
    for (const u of got) if (!opened.has(u)) opened.set(u, (await get(u)).status)
  }
  check('every page a tab opens answers 200', [...opened.values()].every((s) => s === 200), JSON.stringify(Object.fromEntries(opened)))
  const landing = await (await get('/stocks/')).text()
  check('the served landing: the bar comes before the hero, the ticker after the terminal', landing.indexOf('class="site-bar') < landing.indexOf('<header class="hero">') && landing.indexOf('<div class="tape"') > landing.indexOf('id="terminal"'))
  const docsPage = await (await get('/stocks/docs/how-to/alert-on-gap.md')).text()
  check('the docs keep their search box, now in the bar', /<header class="site-bar has-extra">[\s\S]*?<input id="dx-q"[\s\S]*?<\/header>/.test(docsPage))
} finally {
  await app.stop()
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
