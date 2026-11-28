// apps/capabilities-coverage.test.mjs: every public capability is said where people and agents look (owner, 27.11).
// The B20 transfer rules shipped and the landing did not say so; nothing in the tests looked. Here each capability must
// be on the landing page, and in the MCP registry's description (server.json) or in llms.txt:
//   - every MCP tool, by its name, as the server lists it (a new tool fails here until it is mentioned);
//   - every top-level route the kill switch guards (deployment/cloudflare/killswitch/logic.mjs BLOCKED): those are the
//     routes that answer a verdict, so a new one there fails here until it is mentioned;
//   - /tokenlist.json, /denylist.json, the agent test and the B20 transfer rules, by name.
// The routes under /api/ are held by apps/api-page.test.mjs (every documented route has a card on /api), and the tool
// descriptions by apps/mcp-site-tools.test.mjs; this test does not repeat them.
//
// Run: node apps/capabilities-coverage.test.mjs
import fs from 'node:fs'
import { toolsFor } from './stocks-mcp-http.mjs'
import { llmsTxt, loadDocs } from './stocks-web.mjs'
import { TOKEN_LIST_PATH } from './stocks-tokenlist.mjs'
import { DENYLIST_PATH } from './stocks-denylist.mjs'
import { BLOCKED } from '../deployment/cloudflare/killswitch/logic.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const html = read('./stocks-web/index.html')
const description = JSON.parse(read('../server.json')).description
const llms = llmsTxt(loadDocs(), 'https://proofofstock.xyz', '0.0.0')
// The landing's links are relative to the site's root ("tokenlist.json"); llms.txt names full URLs.
const linked = (route) => html.includes(`href="${route.slice(1)}"`) || html.includes(`href="${route}"`)
const outside = (s) => description.includes(s) || llms.includes(s)

console.log('every MCP tool, by its name')
{
  const tools = toolsFor(24).map((t) => t.name)
  check('the server lists its tools (the parse found them)', tools.length >= 11, tools.join(' '))
  const offLanding = tools.filter((n) => !html.includes(`<code>${n}</code>`) && !html.includes(n))
  check('each tool is named on the landing page', offLanding.length === 0, offLanding.join(', '))
  const offOutside = tools.filter((n) => !outside(n))
  check('...and in server.json\'s description or llms.txt', offOutside.length === 0, offOutside.join(', '))
}

console.log('every route the kill switch guards')
{
  // BLOCKED is one regex; its top-level names are the alternatives of its first group, plus /mcp and /agent-test.
  const src = BLOCKED.source
  const first = ((src.match(/\^\\\/\(\?:([^)]*)\)/) || [])[1] || '').split('|').map((s) => '/' + s.replace(/\\\./g, '.'))
  const others = [...src.matchAll(/\^\\\/([a-z-]+)\(\?:\\\/\|\$\)|\^\\\/([a-z-]+)\\\//g)].map((m) => '/' + (m[1] || m[2])).filter((r) => r !== '/api')
  const routes = [...new Set([...first, ...others])]
  check('the parse found the guarded routes', routes.length >= 6 && routes.includes(TOKEN_LIST_PATH) && routes.includes(DENYLIST_PATH) && routes.includes('/mcp') && routes.includes('/agent-test'), routes.join(' '))
  const offLanding = routes.filter((r) => !linked(r) && !html.includes(r) && !(r === '/mcp' && html.includes('__MCP_URL__')))
  check('each is named or linked on the landing page', offLanding.length === 0, offLanding.join(', '))
  const offOutside = routes.filter((r) => !llms.includes('https://proofofstock.xyz' + r) && !outside(r))
  check('...and in llms.txt', offOutside.length === 0, offOutside.join(', '))
}

console.log('the capabilities the owner named, 27.11')
{
  check('/tokenlist.json: linked from the landing and named in llms.txt', linked(TOKEN_LIST_PATH) && llms.includes('https://proofofstock.xyz' + TOKEN_LIST_PATH))
  check('/denylist.json: linked from the landing and named in llms.txt', linked(DENYLIST_PATH) && llms.includes('https://proofofstock.xyz' + DENYLIST_PATH))
  check('the agent test: linked from the landing and named in llms.txt', linked('/agent-test') && /\[Agent test\]\(https:\/\/proofofstock\.xyz\/agent-test\)/.test(llms))
  // The landing says it among what we check, in plain words; outside, the registry's description says "transfer rules"
  // and llms.txt names B20.
  const checks = (html.match(/<section class="checks"[\s\S]*?<\/section>/) || [''])[0]
  check('the B20 transfer rules: in what the landing checks, with what the chain can say (open, restricted or paused)', /transfer rules \(B20\)/.test(checks) && /open, restricted or paused/.test(checks))
  check('...and in server.json\'s description or llms.txt', /transfer rules/.test(description) || /B20/.test(llms))
}

console.log('the first screen says the check and the simulated buy, not only "real or fake"')
{
  const lede = (html.match(/<p class="lede">([\s\S]*?)<\/p>/) || [])[1] || ''
  check('the lede names the check against the issuer\'s list and the simulated buy', /issuer's own list/.test(lede) && /simulate a buy/.test(lede.replace(/<span class="wide-only">[^<]*<\/span>/g, '')), lede)
  check('server.json says the verdict, the passport and the simulated buy within the registry\'s 100 characters', description.length <= 100 && /issuer's/.test(description) && /simulate a buy/.test(description) && /Base/.test(description) && /Robinhood Chain/.test(description), description.length + ' ' + description)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const l of failures) console.log(l); process.exit(1) }
