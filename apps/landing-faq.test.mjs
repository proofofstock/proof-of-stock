// apps/landing-faq.test.mjs: the questions on the landing: what a visitor reads and what search engines read
// (FAQPage JSON-LD) are the same questions and answers, and the answers keep to what the code does.
//
// Run: node apps/landing-faq.test.mjs
import fs from 'node:fs'
import { SECURITY_HEADERS } from './stocks-web.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const html = fs.readFileSync(new URL('./stocks-web/index.html', import.meta.url), 'utf8')
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const section = (html.match(/<section class="faq"[\s\S]*?<\/section>/) || [''])[0]
const shown = [...section.matchAll(/<details class="qa">\s*<summary>([^<]*)<\/summary>\s*<p>([^<]*)<\/p>\s*<\/details>/g)].map((m) => [unesc(m[1]), unesc(m[2])])
const ldText = (section.match(/<script type="application\/ld\+json" id="faq-ld">([^<]*)<\/script>/) || [])[1]
let ld = null
try { ld = JSON.parse(ldText) } catch (_) { /* checked below */ }

console.log('the questions')
check('no "official site" question (more issuers to come)', !shown.some(([q]) => /official/i.test(q)))
check('six to eight questions, each with an answer', shown.length >= 6 && shown.length <= 8 && shown.every(([q, a]) => q.endsWith('?') && a.length > 40), String(shown.length))
check('the section has a heading and is reachable as #faq', /id="faq"/.test(section) && /aria-labelledby="faq-title"/.test(section) && /<h3 id="faq-title">/.test(section))
check('it sits after the agents section and before the footer', html.indexOf('class="agents"') < html.indexOf('class="faq"') && html.indexOf('class="faq"') < html.indexOf('<footer class="foot">'))

console.log('what search engines read')
check('the FAQPage JSON-LD parses', ld && ld['@type'] === 'FAQPage' && Array.isArray(ld.mainEntity))
check('...with the same questions and answers, in the same order', ld && ld.mainEntity.length === shown.length && ld.mainEntity.every((e, i) => e['@type'] === 'Question' && e.name === shown[i][0] && e.acceptedAnswer?.text === shown[i][1]))
check('...and no raw < inside the script (it cannot end the block early)', ldText != null && !ldText.includes('<'))
check('a data block, not a script: the CSP needs no change', /script-src 'self'/.test(SECURITY_HEADERS['content-security-policy']) && !/<script(?![^>]*application\/ld\+json)[^>]*>[^<]+<\/script>/.test(section))

console.log('the answers keep to the code')
const all = shown.map(([q, a]) => q + ' ' + a).join(' ')
check('independence is said, and no answer frames the site around one issuer', /Proof of Stock is independent/.test(all) && !/Coinbase|Robinhood/.test(all))
check('read-only, no keys, no transaction', /no wallet, no key/.test(all) && /signs or sends a transaction/.test(all))
check('the cadences and the stale mark: lists 5 min, prices 15, stale past 30, no verdict past 15 min', /every 5 minutes/.test(all) && /recorded every 15/.test(all) && /past 30 minutes it is marked stale/.test(all) && /more than 15 minutes/.test(all) && /never "not listed"/.test(all))
check('listed is not a price verdict, and the first question says so', /safe to buy\?$/.test(shown[0][0]) && /says nothing about the price/.test(shown[0][1]))
check('an impostor is a distinctive copy, not a shared ticker', /distinctive symbol/.test(all) && /shares a ticker/.test(all))
check('not advice', /not investment advice/i.test(all))
check('no other contact than hello@', (all.match(/[\w.+-]+@[\w.-]+/g) || []).length === 0 && (section.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).every((e) => e === 'hello@proofofstock.xyz'))

console.log('the footer: the project\'s own profiles')
{
  const foot = (html.match(/<footer class="foot">[\s\S]*?<\/footer>/) || [''])[0]
  const links = [...foot.matchAll(/<a class="foot-ic" href="([^"]+)"([^>]*)>/g)].map((m) => [m[1], m[2]])
  check('X and Telegram, in that order; the email is not in the footer (owner, 11.11: spam)', JSON.stringify(links.map(([h]) => h)) === JSON.stringify(['https://x.com/proofofstock', 'https://t.me/proofofstock1']) && !/mailto:/.test(foot))
  check('each has a label a screen reader says, and its icon is hidden from it', links.every(([, at]) => /aria-label="[^"]+"/.test(at)) && (foot.match(/class="i i-(x|tg)" aria-hidden="true"/g) || []).length === 2)
  check('the outside ones open apart and pass no opener or referrer', links.filter(([h]) => h.startsWith('https:')).every(([, at]) => /target="_blank"/.test(at) && /rel="me noopener noreferrer"/.test(at)))
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  const iconSrc = (k) => decodeURIComponent((css.match(new RegExp('\\.i-' + k + ' \\{ --i: url\\("data:image/svg\\+xml,([^"]+)"\\)')) || [])[1] || '')
  check('the icons are drawn here in the site\'s style: inline masks on the 16-unit grid, no image file, no third party', ['x', 'tg'].every((k) => /viewBox='0 0 16 16'/.test(iconSrc(k)) && /stroke-linecap='round'/.test(iconSrc(k))))
  const { PROFILES } = await import('./stocks-seo.mjs')
  check('the organisation names the same profiles as sameAs', JSON.stringify(PROFILES) === JSON.stringify(['https://x.com/proofofstock', 'https://t.me/proofofstock1']))
}

console.log('switching chains does not repeat a question')
{
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  const re = new RegExp((js.match(/const LOOKUP = \/(.+)\/\n/) || [])[1] || '$^')
  check('lookups (find, passport, verify) are kept a minute, the live views are not', ['api/find?q=NVDA', 'api/passport?chain=base&address=0x1', 'api/verify?chain=base'].every((p) => re.test(p)) && ['api/status', 'api/overview', 'api/history/cases?limit=8', 'api/impostors?limit=10'].every((p) => !re.test(p)) && /KEEP_MS = 60e3/.test(js))
  check('...a failure is never kept, and every caller gets its own copy', /p\.catch\(\(\) => kept\.delete\(path\)\)/.test(js) && (js.match(/structuredClone\(b\)/g) || []).length === 2)
}

console.log('the wall of findings')
{
  const board = (html.match(/<section class="board"[\s\S]*?<\/section>/) || [''])[0]
  check('it sits between what it checks and why it matters, reachable as #findings', html.indexOf('class="checks"') < html.indexOf('class="board"') && html.indexOf('class="board"') < html.indexOf('class="why"') && /id="findings"/.test(board) && /aria-labelledby="board-title"/.test(board))
  check('...says what it is and is not, and has an honest empty state', /A claim with evidence, not a verdict\./.test(board) && /No new look-alikes flagged in the last 7 days\./.test(board))
  check('...links nowhere outside the site: it must not advertise a fake', !/href="https?:/.test(board))
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  const fn = (js.match(/async function findingsBoard \(\) \{[\s\S]*?\n {2}\}\n/) || [''])[0]
  check('...fills its rows as text only, from the 7-day case window, and shows our misses', fn && !/innerHTML|insertAdjacentHTML/.test(fn) && /api\/history\/cases\?limit=8/.test(fn) && /later listed by the issuer: we were early or wrong/.test(js))
}

console.log('the terminal script')
{
  {
    // 12.11: a quote lost in an edit left app.js unparseable and the whole terminal dead, with every suite green.
    const { Script } = await import('node:vm')
    let err = null
    try { new Script(fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8'), { filename: 'app.js' }) } catch (e) { err = e }
    check('app.js parses', !err, err && err.message)
  }
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  // 12.11: a second "function board" (the wall of findings) silently replaced the one behind the "now" command, and
  // the "biggest gaps now" button did nothing. A name declared twice is a bug, always.
  const names = [...js.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])
  const twice = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  check('no function is declared twice in app.js', twice.length === 0, twice.join(', '))
  const bar = (html.match(/<footer class="statusbar">[\s\S]*?<\/footer>/) || [''])[0]
  check('every key in the status bar is a button that does something: history, help, clear', /<button type="button" class="key" data-hist[^>]*><kbd>/.test(bar) && /<button type="button" class="key" data-run="help"><kbd>help<\/kbd>/.test(bar) && /<button type="button" class="key" data-win="clear"><kbd>clear<\/kbd>/.test(bar) && !/<span class="key">/.test(bar))
  check('...and the history key has its handler', /querySelectorAll\('\[data-hist\]'\)/.test(js))
}

console.log('the public exam on the landing')
{
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  const { EXAM_CHIP_HTML, EXAM_REPORTS_URL } = await import('./stocks-exam.mjs')
  const bar = (html.match(/<footer class="statusbar">[\s\S]*?<\/footer>/) || [''])[0]
  check('the exam is not in the terminal status bar: that line carries the state of the data, nothing else', !/exam/i.test(bar))
  check('...it sits with the proof links instead, right after Status', /id="foot-status"[\s\S]{0,80}<!--exam-->/.test(html))
  check('...the chip links to the reports on GitHub, opens apart, and is hidden until filled', EXAM_REPORTS_URL === 'https://github.com/proofofstock/proof-of-stock/tree/exam' && EXAM_CHIP_HTML.startsWith(`<a id="exam-chip" class="foot-link exam" href="${EXAM_REPORTS_URL}" target="_blank" rel="noopener noreferrer" hidden>`))
  const fns = ['examChip', 'examView'].map((n) => (js.match(new RegExp(`async function ${n} \\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`)) || [''])[0])
  check('...both read only our own api/exam, never GitHub from the browser (connect-src self)',fns.every((f) => /api\('api\/exam'\)/.test(f)) && !/githubusercontent|fetch\(['"`]https?:/.test(js) && /connect-src 'self'/.test(SECURITY_HEADERS['content-security-policy']))
  check('...and put everything in as text: no innerHTML anywhere in them', fns.every((f) => f && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(f)))
  check('...the chip stays hidden without a report from the last 36 hours', /EXAM_MAX_AGE_S = 36 \* 3600/.test(js) && /if \(!fresh\(e\)\) \{ el\.hidden = true; return \}/.test(fns[0]))
  check('...the command is in help, prints the metrics, the set hash and how to rerun it', /\['exam', '[^']+'\]/.test(js) && /if \(cmd === 'exam'\) return examView\(input\)/.test(js) && /set SHA-256/.test(fns[1]) && /rerun it yourself: /.test(fns[1]) && /false "listed"/.test(fns[1]))
  const exq = shown.find(([q]) => q === 'How do we know the answers are right?')
  check('...and the FAQ says how the answers are checked: the daily public exam and its branch', exq && /public exam/.test(exq[1]) && /exam branch/.test(exq[1]) && /rerun/.test(exq[1]))
}

console.log('the agent wire in the hero')
{
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  const hero = (html.match(/<header class="hero">[\s\S]*?<\/header>/) || [''])[0]
  const wire = (hero.match(/<a class="wire"[\s\S]*?<\/a>/) || [''])[0]
  check('it leads to the agents section on the page and nowhere else', /^<a class="wire" href="#mcp" aria-label="[^"]+">/.test(wire) && html.includes('id="mcp"') && !/href="https?:/.test(wire))
  check('...shows a real tool, a real listed address and real field names', /verify_stock_tokens\("0xb200&hellip;108c"\)/.test(wire) && /"listed":<\/i> <span class="wire-ok">true/.test(wire) && /"impostor":<\/i> null/.test(wire) && /"list_proof":/.test(wire))
  check('...only on a wide screen, still under reduced motion, with the lede kept clear of it', /\.wire \{ display: none; \}/.test(css) && /@media \(min-width: 1100px\) \{\n {2}\.hero \.lede \{ max-width: calc\(100% - 372px\); \}/.test(css) && /prefers-reduced-motion: reduce\) \{ \.wire-l \{ animation: none; opacity: 1; \} \.wire-packet \{ animation: none; \}/.test(css))
}

console.log('the passport fits a phone')
{
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  // Owner, 12.11: on a phone the passport ran past the right edge; a value like "$167.63 Coinbase NAV, updated ..."
  // could not wrap. In the phone layout every value may wrap and no value is wider than its row.
  const phone = (css.match(/@media \(max-width: 700px\) \{\n {2}body \{[\s\S]*?\n\}/) || [''])[0]
  check('on a phone a passport value wraps instead of pushing the card off the screen', /\.field \.v, \.field \.v small \{ white-space: normal; overflow-wrap: anywhere; \}/.test(phone) && /\.field \.v \{ margin-left: auto; min-width: 0; max-width: 100%; \}/.test(phone))
}

console.log('a jump to a section stops below the ticker')
{
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  // Owner, 12.11: "Ask it from your agent" landed under the sticky ticker. The page keeps a scroll padding taller than
  // the ticker, and the terminal's own margin adds to it rather than doubling it.
  const tape = Number((css.match(/\.tape \{[^}]*height: (\d+)px/) || [])[1])
  // Scoped to a page that has the ticker: the docs and history pages load the same sheet and keep their own offsets.
  const pad = Number((css.match(/^html:has\(\.tape\) \{ scroll-padding-top: (\d+)px; \}/m) || [])[1])
  const termMargin = Number((css.match(/\.term \{[^}]*scroll-margin-top: (\d+)px/) || [])[1])
  check('the scroll padding clears the sticky ticker with room to spare', tape > 0 && pad >= tape + 12, `tape ${tape}, padding ${pad}`)
  check('...and the terminal still lands where it did (padding plus its margin, 60px)', pad + termMargin === 60, `${pad} + ${termMargin}`)
}

console.log('the prompt waits with a cursor')
{
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  const form = (html.match(/<form id="prompt"[\s\S]*?<\/form>/) || [''])[0]
  check('a cursor block sits in the input line, hidden from screen readers', /<span class="cmd-wrap"><input id="cmd"[^>]*><span class="cmd-cursor" aria-hidden="true"><\/span><\/span>/.test(form))
  check('...shown only on an empty, unfocused line, blinking, and still under reduced motion', /\.cmd-wrap:focus-within \.cmd-cursor, \.cmd-wrap input:not\(:placeholder-shown\) \+ \.cmd-cursor \{ display: none; \}/.test(css) && /\.cmd-cursor \{[^}]*animation: blink/.test(css) && /prefers-reduced-motion: reduce\) \{ \.cmd-cursor \{ animation: none; \} \}/.test(css))
}

console.log('connecting from Claude and ChatGPT')
{
  const agents = (html.match(/<section class="agents"[\s\S]*?<\/section>/) || [''])[0]
  const items = [...agents.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1])
  const gpt = items[1] || ''
  check('Claude, ChatGPT, then Claude Code and other clients, one line each', items.length === 3 && items[0].startsWith('<b>Claude:</b>') && gpt.startsWith('<b>ChatGPT</b>') && /^<b>Claude Code:<\/b>[\s\S]*Other MCP clients/.test(items[2]))
  check('...ChatGPT names its current path: Plugins, Add custom MCP server, No authentication, Create as a plugin', /Plugins → \+ → Add custom MCP server → paste the URL, No authentication → Create as a plugin/.test(gpt) && /type @/.test(gpt) && /\(web; /.test(gpt))
  const urlBlock = (agents.match(/<pre id="mcp-url">([^<]*)<\/pre>/) || [])[1]
  const ccUrl = (agents.match(/<pre id="mcp-cc">claude mcp add --transport http proofofstock (\S+)<\/pre>/) || [])[1]
  const jsonUrl = (agents.match(/"url": "([^"]+)"/) || [])[1]
  check('...the URL it says to paste is the one block that the command and the JSON also name', urlBlock === '__MCP_URL__' && ccUrl === urlBlock && jsonUrl === urlBlock && /data-copy="mcp-url"/.test(agents))
  const card = (agents.match(/<div class="code">([\s\S]*?)<\/div>\s*<\/section>/) || [])[1] || ''
  const heads = [...card.matchAll(/<div class="code-head"><span>([^<]*)<\/span>/g)].map((m) => m[1])
  const gptSteps = (card.match(/<pre id="mcp-gpt">([\s\S]*?)<\/pre>/) || [])[1] || ''
  const gptUrl = (gptSteps.match(/<span id="mcp-gpt-url">([^<]*)<\/span>/) || [])[1]
  check('the connect card: URL, Claude Code, ChatGPT, then mcp.json', heads.length === 4 && heads[0] === 'MCP server URL' && heads[1] === 'Claude Code' && heads[2] === 'ChatGPT (web)' && heads[3] === 'mcp.json')
  check('...the ChatGPT block is one line, like Claude Code: the same path as the line above and the tutorial', !gptSteps.includes('\n') && /^Plugins → \+ → Add custom MCP server → .+ → No authentication → Create as a plugin$/.test(gptSteps))
  check('...its URL is the one the other blocks use, and its copy button copies just that URL', gptUrl === urlBlock && /<button type="button" class="btn" data-copy="mcp-gpt-url">copy URL<\/button>/.test(card) && (gptSteps.match(/<span/g) || []).length === 1)
  const howTo = ['../README.md', '../docs/README.md', '../docs/stocks-passport-agent.md', '../docs/tutorials/connect-an-agent.md'].map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8'))
  const tut = howTo[3]
  const appJs = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  check('...after a click every copy button gets its own label back (copy URL stays copy URL)', /const label = copy\.textContent\n/.test(appJs) && /setTimeout\(\(\) => \{ copy\.textContent = label \}, 1600\)/.test(appJs) && !/copy\.textContent = 'copy'/.test(appJs))
  check('the client name is proofofstock in the command and the JSON, here and in every how-to; stock-passport is left only in the tutorial\'s remove line', /<pre id="mcp-cc">claude mcp add --transport http proofofstock /.test(agents) && /"mcpServers": \{\n {4}"proofofstock": \{ "type": "http", "url": "[^"]+" \}\n {2}\}/.test(agents) && ![agents, ...howTo].some((t) => t.replace('claude mcp remove stock-passport', '').includes('stock-passport')) && tut.includes('claude mcp remove stock-passport') &&howTo.every((t) => !/claude mcp add/.test(t) || /claude mcp add --transport http proofofstock https:\/\/proofofstock\.xyz\/mcp/.test(t)))
  const tutGpt = (tut.match(/### ChatGPT \(web\)\n([\s\S]*?)\n### /) || [])[1] || ''
  check('...the tutorial gives the same ChatGPT plans and steps as the card, install and @ included, with the public URL', /\*\*Plugins\*\*/.test(tutGpt) && /\*\*Add custom MCP server\*\*/.test(tutGpt) && /`https:\/\/proofofstock\.xyz\/mcp`/.test(tutGpt) && /\*\*No authentication\*\*/.test(tutGpt) && /\*\*Create as a plugin\*\*/.test(tutGpt) && /Pro, Business or Enterprise\/Edu/.test(tutGpt) && /Install the plugin\. In a new chat, type `@` and pick it/.test(tutGpt))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
