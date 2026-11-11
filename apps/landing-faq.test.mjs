// apps/landing-faq.test.mjs — the questions on the landing: what a visitor reads and what search engines read
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
