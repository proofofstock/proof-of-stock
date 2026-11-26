// apps/landing-pay.test.mjs: the landing's "AI agents can now pay for themselves" block. It is shown only where paid
// passes are on (a page must not promise a payment path the server lacks), it sits right before the questions, it
// needs nothing the CSP forbids, and its figures are the server's and the how-to's, not a second copy that drifts.
//
// Run: node apps/landing-pay.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStocksWeb, PAY_SECTION_RE, PAID_VERIFY_BATCH } from './stocks-web.mjs'
import { MAX_VERIFY_BATCH } from './stocks-mcp-http.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const html = read('./stocks-web/index.html'), css = read('./stocks-web/style.css'), server = read('./stocks-web.mjs'), howto = read('../docs/how-to/pay-per-call.md')
const block = (html.match(PAY_SECTION_RE) || [''])[0]

console.log('the block on the page')
check('there is one paid-pass block, and it comes right before the questions', block && html.split(block).length === 2 && html.slice(html.indexOf(block) + block.length).startsWith('\n  <section class="faq"'))
check('it needs nothing the CSP forbids: no inline style, script or handler', !/<script|<style|\sstyle=|\son[a-z]+=/.test(block))
check('every class it uses is styled', [...new Set([...block.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].filter((c) => c.startsWith('pay')).every((c) => css.includes('.' + c)))
check('it links to the how-to and to the settled transaction on BaseScan, opened safely', block.includes('href="docs/how-to/pay-per-call.md"') && /href="https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}" target="_blank" rel="noopener noreferrer"/.test(block))
check('the phone layout stacks the three steps', /@media \(max-width: 760px\) \{[\s\S]*?\.pay-steps \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(css))

console.log('its figures are the server\'s')
check(`the paid batch it names is the server's (${PAID_VERIFY_BATCH})`, block.includes(`${PAID_VERIFY_BATCH} checked`))
// The limit is in units (60 a minute); a batch of n costs ceil(n/10) (docs/reference/http-api.md). "50 a call" and
// "60 calls a minute" are each true but not together (an outside test, 20.11: the 13th batch of 50 was a 402), so the
// block names what a minute really buys: whole batches of the largest free size.
const batchUnits = Math.ceil(MAX_VERIFY_BATCH / 10)
check('the free batch cost is the one the reference states', /Costs ⌈n\/10⌉ units of the rate limit/.test(read('../docs/reference/http-api.md')))
const perMinute = Number((server.match(/const RATE = \{ perMinute: (\d+) \}/) || [])[1])
const perMinuteAddresses = Math.floor(perMinute / batchUnits) * MAX_VERIFY_BATCH
check(`the free tier is what a minute really buys: up to ${perMinuteAddresses} addresses, ${MAX_VERIFY_BATCH} per call`, perMinute > 0 && block.includes(`up to ${perMinuteAddresses} addresses a minute, ${MAX_VERIFY_BATCH} per call`), block.match(/Free stays free[^<]*/)?.[0])
check('it never promises calls a minute next to a batch size: the two are not reachable together', !/calls a minute/.test(block))
check('the price, the pass length and the pass rate are the how-to\'s', /0\.01 USDC/.test(block) && /0\.01 USDC/.test(howto) && /10 minutes/.test(block) && /10-minute|10 minutes/.test(howto) && /ten times the free limit/.test(block) && /600 units a minute/.test(howto) && /ten times/.test(read('../docs/reference/http-api.md')))

console.log('shown only where passes are on')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-pay-'))
const fake = () => ({ enabled: true, wallet: '0x' + '02'.repeat(20), priceUsd: 0.01, passMinutes: 10, passRate: 600, description: 'a pass',
  pausedUntil: () => 0, passActive: () => false, passRateOf: () => null, accepts: () => null, purchase: async () => ({ ok: false }) })
const page = async (x402Module) => {
  const app = createStocksWeb({ listLocks: false, roots: { base: path.join(root, 'b'), robinhood: path.join(root, 'r') }, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    log: () => {}, analytics: { enabled: false }, exam: { url: null }, x402Module })
  const { port } = await app.start(0, '127.0.0.1')
  try { return await (await fetch(`http://127.0.0.1:${port}/stocks/`)).text() } finally { await app.stop() }
}
const on = await page(fake), off = await page(null)
check('with passes on, the landing shows the block', on.includes('id="pay"') && on.includes('pay for themselves'))
check('with passes off, the block is gone and the questions stay', !off.includes('id="pay"') && !off.includes('pay for themselves') && off.includes('id="faq"'))
check('the server cuts it by the block itself, not by a guess', server.includes('.replace(PAY_SECTION_RE, (block) => (x402.enabled ? block : \'\\n\')))'))
fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
