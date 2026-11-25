// apps/terminal-swap.test.mjs: the swap button in the main terminal's passport (owner, 25.11: the buy button lives in the
// terminal; the Demo Agent only simulates). It must appear on the issuer's own token on Base only, never on an impostor or
// a token outside the list, open Aerodrome with both sides pinned to Base and the passport's own address, and say that
// the price there is Aerodrome's and that this site never signs.
//
// Run: node apps/terminal-swap.test.mjs
import fs from 'node:fs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const app = read('./stocks-web/app.js'), css = read('./stocks-web/style.css')
const fn = (app.match(/  function swapBox \(p\) \{[\s\S]*?\n  \}\n/) || [''])[0]

console.log('the swap button in the passport')
check('there is one swapBox, and it is called once', Boolean(fn) && (app.match(/function swapBox /g) || []).length === 1 && (app.match(/swapBox\(p\)/g) || []).length === 1)
check('on the issuer-listed card only: right after its links, in the card marked Issuer-listed', /return h\('div', \{ class: 'card is-ok' \},[\s\S]*?officialLinks\(p\),\n      swapBox\(p\),/.test(app) && !/impostorLinks[^\n]*swapBox/.test(app))
check('on Base only, and only for a minted token with a real address', /if \(p\.chain !== 'base' \|\| !i \|\| i\.minted === false \|\| !\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(String\(p\.address\)\)\) return null/.test(fn))
check('Aerodrome, from USDC on Base to the passport\'s own address, both sides pinned to Base', /'https:\/\/aerodrome\.finance\/swap\?from=' \+ USDC_BASE \+ '&to=' \+ String\(p\.address\)\.toLowerCase\(\) \+ '&chain0=8453&chain1=8453'/.test(fn) && /const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'/.test(app))
check('it says: Base only, the price there is Aerodrome\'s, where 3% over the issuer\'s is, and this site never signs', /Base only: keep your wallet on Base, and stop if any screen shows another network\. /.test(fn) && /Aerodrome shows its own price/.test(fn) && /usd\(ref\.price_usd \* 1\.03\)/.test(fn) && /You sign in your own wallet; this site never does\./.test(fn))
check('it is the one filled button in a passport, styled in style.css', /\.btn\.swap \{[^}]*background: var\(--accent\)/.test(css) && /\.swapbox \{/.test(css))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
