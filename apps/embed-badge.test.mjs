// apps/embed-badge.test.mjs: the passport's "embed this badge" (owner, 23.11: nobody could find the badge). Each
// passport, the issuer's token and a stranger's alike, offers the badge it renders and its HTML and Markdown to copy;
// both are built from the chain and the checked address only, never from a token's own symbol or name (its creator's
// words); the how-to is in the docs index and the /api page points at it.
//
// Run: node apps/embed-badge.test.mjs
import fs from 'node:fs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const app = read('./stocks-web/app.js')
const fn = (app.match(/function embedFold \(p\) \{[\s\S]*?\n {2}\}\n/) || [''])[0]

console.log('the passport offers its badge')
check('embedFold builds the badge and the link from the chain and the address only', fn.length > 0 && /const q = `\?chain=\$\{encodeURIComponent\(p\.chain\)\}&address=\$\{encodeURIComponent\(p\.address\)\}`/.test(fn) && /new URL\('badge\.svg' \+ q, location\.href\)/.test(fn) && /new URL\(q, location\.href\)/.test(fn))
check('...and never from the token\'s own symbol or name', fn.length > 0 && !/identity|\.symbol|token_name|\.name\b/.test(fn))
check('...it shows the badge itself, then HTML and Markdown, each with a copy button', /h\('img', \{ class: 'embed-preview', src/.test(fn) && /snippet\('HTML', `<a href="\$\{page\}"><img src="\$\{src\}" alt="Proof of Stock verdict"><\/a>`\)/.test(fn) && /snippet\('Markdown', `\[!\[Proof of Stock verdict\]\(\$\{src\}\)\]\(\$\{page\}\)`\)/.test(fn) && /navigator\.clipboard\.writeText\(code\)/.test(fn))
check('...as text nodes: no innerHTML anywhere in it', fn.length > 0 && !/innerHTML|insertAdjacentHTML/.test(fn))
check('...and points at the how-to', /href: 'docs\/how-to\/embed-a-badge\.md'/.test(fn))
check('both passport cards carry it: the issuer\'s token and one outside the list', /\.\.\.folds,\n\s+embedFold\(p\),/.test(app) && /impostorLinks\(p, [^\n]*\),\n\s+embedFold\(p\)\)\n\s+return card/.test(app))

console.log('the how-to and the /api page')
const how = read('../docs/how-to/embed-a-badge.md')
check('the how-to says every state the badge can take, and that it never shows a price', ['Issuer-listed', 'Imitates', 'Not in the Coinbase registry', 'Registry unavailable'].every((s) => how.includes(s)) && /never shows a price/.test(how))
check('...with HTML and Markdown that match what the passport offers', how.includes('<img src="https://proofofstock.xyz/badge.svg?chain=base&address=0x…" alt="Proof of Stock verdict"') && how.includes('[![Proof of Stock verdict](https://proofofstock.xyz/badge.svg?chain=base&address=0x…)](https://proofofstock.xyz/?chain=base&address=0x…)'))
check('...and it is in the docs index', read('../docs/README.md').includes('(how-to/embed-a-badge.md)'))
check('the /api badge card points at it', /embed-a-badge\.md/.test(read('./stocks-api-page.mjs')))
const css = read('./stocks-web/style.css')
check('the code wraps on a phone instead of running off the card', /\.embed-code code \{[^}]*overflow-wrap: anywhere/.test(css) && /@media \(max-width: 560px\) \{ \.embed-code \{ grid-template-columns: 1fr; \} \}/.test(css))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
