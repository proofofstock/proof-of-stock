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
check('read-only, no sign-in, no transaction for a caller', /never touches your wallet: no sign-in/.test(all) && /signs or sends a transaction/.test(all))
// The keys we do have are said here, in the answer about safety, and not only in a document nobody opens: once they
// exist, "no key" or "one key" would be a false claim, and the whole product is that we do not make those (spec H4).
check('...and both keys we hold are disclosed where the question is asked', /two keys/.test(all) && /value zero/.test(all) && /cannot change who is paid or how much/.test(all))
check('the cadences and the stale mark: lists 5 min, prices 15, stale past 30, no verdict past 15 min', /every 5 minutes/.test(all) && /recorded every 15/.test(all) && /past 30 minutes it is marked stale/.test(all) && /more than 15 minutes/.test(all) && /never "not listed"/.test(all))
check('listed is not a price verdict, and the first question says so', /safe to buy\?$/.test(shown[0][0]) && /says nothing about the price/.test(shown[0][1]))
check('an impostor is a distinctive copy, not a shared ticker', /distinctive symbol/.test(all) && /shares a ticker/.test(all))
check('not advice', /not investment advice/i.test(all))
check('no other contact than hello@', (all.match(/[\w.+-]+@[\w.-]+/g) || []).length === 0 && (section.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).every((e) => e === 'hello@proofofstock.xyz'))

console.log('the footer: the project\'s own profiles')
{
  const foot = (html.match(/<footer class="foot">[\s\S]*?<\/footer>/) || [''])[0]
  const links = [...foot.matchAll(/<a class="foot-ic" href="([^"]+)"([^>]*)>/g)].map((m) => [m[1], m[2]])
  check('X, Telegram, then the bot, in that order; the email is not in the footer (owner, 11.11: spam)', JSON.stringify(links.map(([h]) => h)) === JSON.stringify(['https://x.com/proofofstock', 'https://t.me/proofofstockchannel', 'https://t.me/ProofofStockBot']) && !/mailto:/.test(foot))
  check('each has a label a screen reader says, and its icon is hidden from it', links.every(([, at]) => /aria-label="[^"]+"/.test(at)) && (foot.match(/class="i i-(x|tg|bot)" aria-hidden="true"/g) || []).length === 3)
  check('the outside ones open apart and pass no opener or referrer', links.filter(([h]) => h.startsWith('https:')).every(([, at]) => /target="_blank"/.test(at) && /rel="me noopener noreferrer"/.test(at)))
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  const iconSrc = (k) => decodeURIComponent((css.match(new RegExp('\\.i-' + k + ' \\{ --i: url\\("data:image/svg\\+xml,([^"]+)"\\)')) || [])[1] || '')
  check('the icons are drawn here in the site\'s style: inline masks on the 16-unit grid, no image file, no third party', ['x', 'tg', 'bot'].every((k) => /viewBox='0 0 16 16'/.test(iconSrc(k)) && /stroke-linecap='round'/.test(iconSrc(k))))
  const { PROFILES } = await import('./stocks-seo.mjs')
  check('the organisation names the same profiles as sameAs', JSON.stringify(PROFILES) === JSON.stringify(['https://x.com/proofofstock', 'https://t.me/proofofstockchannel']))
  // The bot is a tool, not a profile of the organisation: it is in the footer, never in sameAs or the docs' profiles.
  check('the bot is the footer\'s, not a profile: not in sameAs', !PROFILES.some((u) => /ProofofStockBot/i.test(u)))
}

console.log('switching chains does not repeat a question')
{
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  const re = new RegExp((js.match(/const LOOKUP = \/(.+)\/\n/) || [])[1] || '$^')
  check('lookups (find, passport, verify) are kept a minute, the live views are not', ['api/find?q=NVDA', 'api/passport?chain=base&address=0x1', 'api/verify?chain=base'].every((p) => re.test(p)) && ['api/status', 'api/overview', 'api/history/cases?limit=8', 'api/impostors?limit=10'].every((p) => !re.test(p)) && /KEEP_MS = 60e3/.test(js))
  check('...a failure is never kept, and every caller gets its own copy', /p\.catch\(\(\) => kept\.delete\(path\)\)/.test(js) && (js.match(/structuredClone\(b\)/g) || []).length === 2)
}

console.log('examples and captions say what they are')
{
  // Outside review, 21.11: a price with no stock ("$188.42") and two squares captioned "Seal" and "Record now" read as
  // unexplained. The example names its token; each mosaic says which seal it is.
  check('the price example names its token', /<span class="faint">NVDAc, for example<\/span> \$188\.42/.test(html))
  check('...and the two seal mosaics say which is the seal of the day and which is the record as shown', html.includes('<figcaption>Sealed that day</figcaption>') && html.includes('<figcaption>Seal of the record as shown</figcaption>'))
}

console.log('Bankr in the connect list')
{
  // The Bankr skill was nowhere on the site (owner, 21.11). It is in review at Bankr, so the page says so and links the
  // submission, never "available in Bankr" before it is.
  const agents = (html.match(/<section class="agents"[\s\S]*?<\/section>/) || [''])[0]
  check('the agents section names the Bankr skill, says it is in review, and links the submission', /<li><b>Bankr:<\/b>/.test(agents) && /in review/.test(agents) && agents.includes('href="https://github.com/BankrBot/skills/pull/860"'))
}

console.log('the wall of findings')
{
  const board = (html.match(/<section class="board"[\s\S]*?<\/section>/) || [''])[0]
  check('it sits between what it checks and why it matters, reachable as #findings', html.indexOf('class="checks"') < html.indexOf('class="board"') && html.indexOf('class="board"') < html.indexOf('class="why"') && /id="findings"/.test(board) && /aria-labelledby="board-title"/.test(board))
  check('...says what it is and is not', /A claim with evidence, not a verdict\./.test(board))
  check('...links nowhere outside the site: it must not advertise a fake', !/href="https?:/.test(board))
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  const fn = (js.match(/async function findingsBoard \(\) \{[\s\S]*?\n {2}\}\n/) || [''])[0]
  // A reader that runs no script (a search engine, an agent, a judge's crawler) takes a hidden sentence as a claim: on
  // 21.11 it read "No new look-alikes" in the page while the board showed 24 rows. The page says nothing about the
  // count; the script writes the empty state, and only when the 7-day window came back empty.
  check('...the empty state is written by the script, only for an empty window, never by the page', !/No new look-alikes|nothing flagged|no look-alikes/i.test(board) && /empty\.textContent = ev\.length \? '' : 'No new look-alikes flagged in the last 7 days\.'/.test(fn))
  check('...fills its rows as text only, from the 7-day case window, and shows our misses', fn && !/innerHTML|insertAdjacentHTML/.test(fn) && /api\/history\/cases\?limit=\d+/.test(fn) && /later listed by the issuer: we were early or wrong/.test(js))
  // Most look-alikes copy the listed company's NAME, not its ticker, so a row that shows only symbols reads as
  // arbitrary: "CHIPSTER copies NVDA" is true because that contract calls itself NVIDIA. Owner asked, 13.11.
  check('...and each row says what the token calls itself and what it matched on', /board-name/.test(fn) && /board-why/.test(fn) && /by name/.test(fn) && /by ticker/.test(fn), fn.slice(0, 60))
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
  {
    // The hidden commands. A joke swallowing a real question is the one thing that would really hurt, and a list of
    // patterns cannot prove it will not: the search matches a ticker by its first two characters and a company name
    // by the first three of a word, so "sl" is the start of SLB and "wen" is Wendy's. The guarantee is structural
    // instead, and that is what is locked here: egg() is reachable from exactly one place, the branch of lookup()
    // where the issuers matched nothing. (Review finding, 13.11; the first version ran them before the lookup.)
    const eggs = (js.match(/\/\*\*\n {3}\* One of the hidden commands[\s\S]*?\n {2}\}\n/) || [''])[0]
    // Comments talk about egg() too, so the call sites are counted in the code alone.
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const calls = [...code.matchAll(/\begg\(/g)].length
    check('the hidden commands are called from one place only', calls === 1, String(calls) + ' calls')
    const run = (code.match(/function run \([\s\S]*?\n {2}\}\n/) || [''])[0]
    check('...and never from run(), which is where a real question is still on its way', !/\begg\(/.test(run) && /lookup\(input, typed\)/.test(run))
    const look = (code.match(/async function lookup \([\s\S]*?\n {2}\}\n/) || [''])[0]
    check('...only where the issuers matched nothing, and counted as a command rather than a search', /if \(!r\.matches\.length && egg\(q, out\)\)/.test(look) && look.indexOf('egg(q, out)') < look.indexOf("act('search'"))
    check('the hidden commands answer from the page alone: nothing fetched, nothing navigated, nothing timed', eggs.length > 800 && !/\bapi\(|fetch\(|location|window\.open|set(Timeout|Interval)|innerHTML|insertAdjacentHTML|eval\(|new Function/.test(eggs), String(eggs.length))
    const wanted = ['sudo', '\\^rm', 'whoami', 'chmod', "'sl'", 'vim', 'cowsay', 'fortune', 'hodl', "'42'", 'towel', 'xyzzy', 'npm']
    check('...and each one the owner picked is there', wanted.every((w) => new RegExp(w).test(eggs)), wanted.filter((w) => !new RegExp(w).test(eggs)).join())
    const says = [...(js.match(/const COW_SAYS = \[[\s\S]*?\n {2}\]/) || [''])[0].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
    const max = Number((js.match(/const COW_MAX = (\d+)/) || [0, 0])[1])
    check('the cow is given only lines that fit it whole, never a sentence it would cut', says.length >= 6 && max > 0 && says.every((s) => s.length <= max), says.filter((s) => s.length > max).join(' | '))
    check('help admits they exist without naming them', /not on this list/.test(js) && !/xyzzy|cowsay/.test((js.match(/function help \([\s\S]*?\n {2}\}\n/) || [''])[0]))
  }
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

console.log('a jump to a section stops below the sticky bar')
{
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  // Owner, 12.11: "Ask it from your agent" landed under the sticky ticker. Since 22.11 the sticky thing at the top is
  // the site bar with the tabs, and the ticker sits under the terminal and scrolls with the page. The page keeps a scroll
  // padding taller than the bar, and the terminal's own margin adds to it rather than doubling it.
  const bar = Number((css.match(/^\.site-bar \{[^}]*height: (\d+)px/m) || [])[1])
  check('the site bar is sticky and the ticker no longer is', /^\.site-bar \{[^}]*position: sticky; top: 0;/m.test(css) && !/^\.tape \{[^}]*position: sticky/m.test(css))
  // Scoped to the landing (the page with the ticker): the docs and history pages load the same sheet and keep their own offsets.
  const pad = Number((css.match(/^html:has\(\.tape\) \{ scroll-padding-top: (\d+)px; \}/m) || [])[1])
  const termMargin = Number((css.match(/\.term \{[^}]*scroll-margin-top: (\d+)px/) || [])[1])
  check('the scroll padding clears the sticky site bar with room to spare', bar > 0 && pad >= bar + 12, `bar ${bar}, padding ${pad}`)
  check('...and the terminal lands 20px under the bar (padding plus its margin, 80px)', pad + termMargin === 80, `${pad} + ${termMargin}`)
}

console.log('the guard has a mark, and it is a door')
{
  // Owner, 16.11: the package needed a face and a way in. The shield carries our own emblem, and it sits where the
  // install line is, so the picture and the thing it stands for are in the same row.
  const svg = fs.readFileSync(new URL('./stocks-web/shield.svg', import.meta.url), 'utf8')
  // A reference to #something inside this file is how a shape is reused and a clip is named. A reference to anything
  // else is a fetch, and this file must make none: it is served under a policy that allows no outside image, and a
  // badge that quietly loads something from elsewhere is the exact thing we tell people to watch for.
  const refs = [...svg.matchAll(/(?:xlink:)?href\s*=\s*"([^"]*)"/g)].map((m) => m[1])
    .concat([...svg.matchAll(/url\(\s*['"]?([^'")]*)/g)].map((m) => m[1]))
  const outside = refs.filter((r) => !r.startsWith('#'))
  check('the shield is one file, drawn here, with nothing fetched from anywhere', /<svg[\s\S]*<\/svg>/.test(svg) && !/<image[\s>]/.test(svg) && outside.length === 0, outside.join())
  // The badge is lit, so it needs shades: a light rim, a deep one, a gloss, a shadow. What it must never do is
  // bring in a colour that is not ours. Every colour here is either our blue (blue the strongest channel) or a
  // neutral (white for light, near-black for shadow), and nothing else.
  const colours = [...new Set(svg.match(/#[0-9A-Fa-f]{6}/g) || [])]
  const foreign = colours.filter((c) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
    const neutral = Math.max(r, g, b) - Math.min(r, g, b) <= 12
    return !neutral && !(b > r && b >= g)
  })
  check('...in our blue and neutrals, with no colour of its own invented', colours.length > 0 && foreign.length === 0, foreign.join())
  check('...and it says what it is to a screen reader', /role="img"/.test(svg) && /aria-label="Proof of Stock guard"/.test(svg) && /<title>/.test(svg))
  const head = (html.match(/<div class="code-head">(?:(?!<\/div>)[\s\S])*guard-head[\s\S]*?<\/div>/) || [''])[0]
  check('it stands beside the line that installs the package', /guard-shield/.test(head) && /npm, for your own code/.test(head))
  check('...and the whole thing is a link to what the package does', /<a class="guard-head" href="docs\/how-to\/check-before-listing\.md">/.test(head) && fs.existsSync(new URL('../docs/how-to/check-before-listing.md', import.meta.url)))
  // A picture that repeats the words beside it is noise to a screen reader: the link already says them.
  check('...with the picture itself hidden from a screen reader, because the link already speaks', /class="guard-shield"[^>]*alt=""[^>]*aria-hidden="true"/.test(head), head.slice(0, 80))
  const web = fs.readFileSync(new URL('./stocks-web.mjs', import.meta.url), 'utf8')
  check('and the site serves it', /'\/shield\.svg': \['shield\.svg', 'image\/svg\+xml'\]/.test(web))
}

console.log('what kind of service this is, said once')
{
  // Owner, 16.11, after asking whether this could be sold as decentralised: it cannot, and the honest sentence is
  // stronger than the fashionable one. It is said on the page and to the agents that read llms.txt, in the same
  // words, so the two can never drift into two different positions.
  const stance = (html.match(/<p class="stance">([\s\S]*?)<\/p>/) || [])[1] || ''
  const plain = stance.replace(/<[^>]*>/g, '')
  check('the page says it is centralised, and why that is the reason for the proofs', /centralised service/.test(plain) && /check it without us/.test(plain))
  check('...and says what the chain is for, which is not being trusted', /not here so that we can be trusted/.test(plain) && /cannot rewrite yesterday/.test(plain))
  check('...where a reader meets it: after what we check, before what we flag', html.indexOf('class="checks"') < html.indexOf('class="stance"') && html.indexOf('class="stance"') < html.indexOf('class="board"'))
  const web = fs.readFileSync(new URL('./stocks-web.mjs', import.meta.url), 'utf8')
  const forAgents = (web.match(/head\.push\('## How to check us'[\s\S]*?\n\s*'',/) || [''])[0]
  check('the same sentence heads the section an agent reads, word for word', forAgents.includes('centralised service') && forAgents.includes('cannot rewrite yesterday'), forAgents.slice(0, 60))
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  check('...and the repository says it too, where it says what this is', /centralised service/.test(readme) && /cannot rewrite yesterday/.test(readme))
}

console.log('one question, one frame')
{
  // Owner, 16.11: in a long feed an answer ran into the next question and a passport read as more of the same wall of
  // text. Each answered question is a rectangle now. Two things keep it from becoming a form: the greeting, which
  // answers nothing, has no frame, and the passport inside drops its own box rather than sitting in a second one.
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  const framed = (css.match(/^\.block:has\(> \.echo\) \{([^}]*)\}/m) || [])[1] || ''
  check('a block that answers a question is a thin rectangle', /border: 1px solid var\(--line\)/.test(framed) && /border-radius: 12px/.test(framed), framed.trim().slice(0, 60))
  check('...with the question itself as its head, cut off from the answer by a hairline', /^\.block > \.echo \{[^}]*border-bottom: 1px solid var\(--line\)/m.test(css) && /^\.block > \.echo \{[^}]*padding:/m.test(css))
  // Not one rule: every rule in the sheet that reaches a plain .block, phone overrides included. One of them giving
  // the greeting a border of any kind is what this has to catch (outside review, 16.11).
  const plainBlock = [...css.matchAll(/(^|\})\s*([^{}@]*?\.block(?![\w:.-])[^{}]*?)\{([^}]*)\}/g)]
    .filter((m) => !/:has|\.echo/.test(m[2])).map((m) => m[3])
  check('...and the greeting, which answers nothing, keeps none: the frame is tied to the echo, not to the block', plainBlock.length > 0 && !plainBlock.some((d) => /(^|[;\s])border(-\w+)*\s*:/.test(d)), plainBlock.join(' | ').slice(0, 80))
  const inner = (css.match(/^\.block:has\(> \.echo\) \.card \{([^}]*)\}/m) || [])[1] || ''
  check('the passport inside drops its own box rather than being a frame in a frame', /border-top: 0/.test(inner) && /border-right: 0/.test(inner) && /border-bottom: 0/.test(inner) && /border-radius: 0/.test(inner))
  // The verdict's colour has to survive that: it is the one thing in the card a reader takes at a glance. It travels
  // as a variable now, so the spine keeps it whether the card is a box or a panel against the frame's edge. This reads
  // the sheet, not a rendered page: that the three shapes look right was checked in a browser, by a person.
  check('...but keeps the spine, in the colour of the verdict, in both shapes', ['ok', 'bad', 'warn'].every((k) => new RegExp(`\\.card\\.is-${k} \\{ --spine: var\\(--${k}\\); \\}`).test(css)) && /\.card\.is-ok, \.card\.is-bad, \.card\.is-warn \{ border-left: 3px solid var\(--spine/.test(css) && /border-left: 3px solid var\(--spine, var\(--line\)\)/.test(inner))
  check('and the frame itself takes a hint of the verdict, quieter than the spine', ['ok', 'bad', 'warn'].every((k) => new RegExp(`\\.block:has\\(\\.card\\.is-${k}\\) \\{ border-color: color-mix\\(in srgb, var\\(--${k}\\) \\d\\d%, var\\(--line\\)\\)`).test(css)))
}

console.log('what a phone does not get')
{
  // Owner, 15.11: the page reads long on a phone. The cut is a class, not a second copy of the text: .wide-only is a
  // clause the phone drops. Two things have to hold, or the cut starts telling a phone something untrue - what stays
  // must still be a whole sentence, and nothing only a phone-sized screen hides may be the sole place a fact or a
  // link lives.
  const css = fs.readFileSync(new URL('./stocks-web/style.css', import.meta.url), 'utf8')
  const phone = (css.match(/@media \(max-width: 700px\) \{\n([\s\S]*?)\n\}/g) || []).join('\n')
  check('the cut lives in one rule, and only on a phone', /\.wide-only \{ display: none; \}/.test(phone) && (css.match(/\.wide-only \{/g) || []).length === 1)
  // Every element the class is on, whatever its tag: the chips wear it too, and a check that looked only at spans
  // would have said nothing about them (outside review, 15.11).
  const hidden = [...html.matchAll(/<(\w+)[^>]*class="[^"]*\bwide-only\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2])
  const chips = [...html.matchAll(/<button type="button" class="chip( wide-only)?" data-run="([^"]+)">/g)].map((m) => [!m[1], m[2]])
  check('something is actually dropped, and no link goes with it', hidden.length >= 7 && hidden.every((t) => !/<a[\s>]/.test(t)), String(hidden.length))
  // What this can prove is punctuation, not grammar: strip the clause and whatever ended in a full stop still does,
  // with no comma or double space left hanging where it was. That a phone's shorter sentence still says something
  // true is a human reading, and it is the reason the cut is a clause and never a fact of its own.
  const paras = [...html.matchAll(/<(p|li)(?=[ >])[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]).filter((t) => t.includes('wide-only'))
  const plain = (t) => t.replace(/<[^>]*>/g, '').trim()
  const short = paras.map((t) => [plain(t), plain(t.replace(/<span class="[^"]*wide-only[^"]*">[\s\S]*?<\/span>/g, ''))])
  check('...and the phone is left with punctuation that closes: no comma or gap where the clause was', paras.length >= 4 && short.every(([full, cut]) => cut.length > 20 && !/[,;] *[.?]?$/.test(cut) && !/ {2}/.test(cut) && (!/[.?]$/.test(full) || /[.?]$/.test(cut))), short.filter(([full, cut]) => /[.?]$/.test(full) && !/[.?]$/.test(cut)).map(([, c]) => c).join(' | '))
  check('the hero keeps a few examples and help on a phone, not the whole row', chips.filter(([keep]) => keep).length >= 3 && chips.filter(([keep]) => keep).length <= 4 && chips.some(([keep, run]) => keep && run === 'help') && chips.some(([keep]) => !keep), chips.filter(([k]) => k).map(([, r]) => r).join())
  // The narrow branch itself, not the pair: a check that only found the counts somewhere in the file would pass with
  // a narrow greeting that dropped them (outside review, 15.11).
  const js = fs.readFileSync(new URL('./stocks-web/app.js', import.meta.url), 'utf8')
  const narrowHello = (js.match(/const counts = st\n\s*\? \(narrow\n\s*\? (`[^`]*`)/) || [])[1] || ''
  const wideHello = (js.match(/const counts = st\n[\s\S]*?\n\s*: (`[^`]*`)\)\n/) || [])[1] || ''
  const greet = (js.match(/const lines = narrow \? \[\n([\s\S]*?)\n {4}\] : \[\n([\s\S]*?)\n {4}\]/) || [])
  check('the terminal greets a narrow screen in fewer words', /const narrow = \(window\.innerWidth \|\| 1024\) < 560/.test(js) && narrowHello.length > 0 && narrowHello.length < wideHello.length && greet[1] && greet[1].length < greet[2].length, `${narrowHello.length} vs ${wideHello.length}`)
  check('...with both chains still counted in it, and a way in still offered', /counted\(st\.base\)/.test(narrowHello) && /counted\(st\.robinhood\)/.test(narrowHello) && /help/.test(greet[1] || ''), narrowHello)
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
  // Three lines, one each, and each one short: the column stood taller than the card beside it, and a reader who has
  // already decided to connect does not read a paragraph about it (owner, 15.11). The exact steps are not lost - the
  // card below carries the whole ChatGPT path and the tutorial carries the plans and the @ step, both checked here.
  check('Claude, ChatGPT, the clients that copy from the card, then Bankr, one short line each', items.length === 4 && items[0].startsWith('<b>Claude:</b>') && gpt.startsWith('<b>ChatGPT</b>') && /^<b>Claude Code, other clients, npm:<\/b>/.test(items[2]) && items[3].startsWith('<b>Bankr:</b>') && items.every((t) => t.replace(/<[^>]*>/g, '').length < 135), items.map((t) => t.replace(/<[^>]*>/g, '').length).join())
  // The rest of the path is one link away, so the link has to point at a page that exists and is the one checked at
  // the end of this block for the plans and the @ step (outside review, 15.11: an href proves nothing on its own).
  const tutHref = (gpt.match(/href="(docs\/tutorials\/[^"]+)"/) || [])[1]
  check('...ChatGPT keeps the two things a reader cannot guess: which plans have it, and where the button is', /\(web, paid plans\)/.test(gpt) && /Plugins → \+ → Add custom MCP server/.test(gpt) && tutHref === 'docs/tutorials/connect-an-agent.md' && fs.existsSync(new URL('../' + tutHref, import.meta.url)), String(tutHref))
  const urlBlock = (agents.match(/<pre id="mcp-url">([^<]*)<\/pre>/) || [])[1]
  const ccUrl = (agents.match(/<pre id="mcp-cc">claude mcp add --transport http proofofstock (\S+)<\/pre>/) || [])[1]
  const jsonUrl = (agents.match(/"url": "([^"]+)"/) || [])[1]
  check('...the URL it says to paste is the one block that the command and the JSON also name', urlBlock === '__MCP_URL__' && ccUrl === urlBlock && jsonUrl === urlBlock && /data-copy="mcp-url"/.test(agents))
  const card = (agents.match(/<div class="code">([\s\S]*?)<\/div>\s*<\/section>/) || [])[1] || ''
  // A head's label may be wrapped in a link now (the npm row, whose shield links to what the package does), so the
  // label is read from the first span of the row either way.
  const heads = [...card.matchAll(/<div class="code-head">(?:<a [^>]*>)?(?:<img [^>]*>)?<span>([^<]*)<\/span>/g)].map((m) => m[1])
  const gptSteps = (card.match(/<pre id="mcp-gpt">([\s\S]*?)<\/pre>/) || [])[1] || ''
  const gptUrl = (gptSteps.match(/<span id="mcp-gpt-url">([^<]*)<\/span>/) || [])[1]
  // The order is the reader's: connect an agent first (URL, then the two clients that need their own steps), then the
// file for every other client, and last the line for somebody who is writing code instead of connecting anything.
check('the connect card: URL, Claude Code, ChatGPT, npm, then mcp.json', heads.length === 5 && heads[0] === 'MCP server URL' && heads[1] === 'Claude Code' && heads[2] === 'ChatGPT (web)' && heads[3] === 'npm, for your own code' && heads[4] === 'mcp.json')
check('...and the npm line installs the published package, which the page says has no dependencies', /<pre id="npm-i">npm install @proofofstock\/guard<\/pre>/.test(card) && /no dependencies/i.test(agents))
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

// Outside review (21.11): "units" is our internal word. The FAQ says calls, in the page and in its FAQ markup alike,
// and the README puts the exam score beside its title from the live site, never as a number written into git.
console.log('plain words, and the exam beside the README title')
{
  const faq = (html.match(/<section class="faq"[\s\S]*?<\/section>/) || [''])[0]
  const ld = (html.match(/<script type="application\/ld\+json" id="faq-ld">([\s\S]*?)<\/script>/) || [, ''])[1]
  const said = 'each client gets 60 calls in any 60 seconds across both: a passport counts as 3 calls, so about 20 passports a minute, and a batch of up to 10 addresses as one.'
  check('the FAQ says calls, not units, and the page and its FAQ markup say the same', faq.includes(said) && ld.includes(said) && !/\bunits?\b/.test(faq) && !/\bunits?\b/.test(ld))
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const head = readme.split('\n## ')[0]
  check('the README shows the public exam beside its title, read live from the site', head.includes('https://img.shields.io/endpoint?url=https%3A%2F%2Fproofofstock.xyz%2Fapi%2Fexam%2Fbadge.json') && head.includes('](https://github.com/proofofstock/proof-of-stock/tree/exam)'))
  check('...and writes no score into the repository', !/exam[^\n]*\b\d+\/\d+\b/i.test(head))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
