// apps/check-us.test.mjs: "Check us, not just our answers" (docs/how-to/check-us.md, 24.11). What is held: the page
// says plainly that no audit has been published and gives agents a sentence that is true; it claims no audit or
// verification by anyone; every page it links exists; the Proofs tab opens it; and the MCP server's instructions point
// agents at it when they are asked whether the service is audited.
//
// Run: node apps/check-us.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { TABS, tabOfDoc } from './stocks-nav.mjs'
import { createMcpHttp } from './stocks-mcp-http.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}

const rel = 'docs/how-to/check-us.md'
const page = fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
check('the page says first that no outside firm has audited the service', /^No outside firm has audited this service\./m.test(page))
const quote = page.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join(' ')
check('it gives agents one sentence to say: no audit published, the answers checkable, and where', /No independent audit of Proof of Stock has been published/.test(quote) && /recompute from the issuer's own API/.test(quote) && /anchored in Bitcoin/.test(quote) && /check-us\.md/.test(quote), quote.slice(0, 120))
// "audited" and "verified by" appear only where the page says what NOT to say.
const claims = page.split('\n').filter((l) => /\baudited by\b|\bverified by\b|\bcertified\b/i.test(l) && !/^Do not say/.test(l))
check('it claims no audit, verification or certification by anyone', claims.length === 0, claims.join(' | '))
check('it is honest about the one thing nobody can prove: that the server runs the public code', /We cannot prove it/.test(page))
const links = [...page.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)].map((m) => m[1]).filter((h) => !/^https?:/.test(h))
const missing = links.filter((h) => !fs.existsSync(path.join(path.dirname(new URL('../' + rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), h)))
check('every page it links exists', links.length >= 4 && missing.length === 0, missing.join(', '))
check('the Proofs tab opens it, and it sits under that tab', TABS.find((t) => t.id === 'proofs').href === 'docs/how-to/check-us.md' && tabOfDoc('how-to/check-us.md') === 'proofs')
const mcp = createMcpHttp({ chains: ['base'], find: () => ({}), list: () => ({}), passport: async () => ({}) })
const init = await mcp.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
const instructions = init.json?.result?.instructions || ''
check('the MCP instructions tell an agent asked about an audit what is true, and point here', /no independent audit has been published/.test(instructions) && /docs\/how-to\/check-us\.md/.test(instructions), instructions.slice(0, 80))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
