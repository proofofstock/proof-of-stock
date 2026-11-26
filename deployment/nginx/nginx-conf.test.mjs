// deployment/nginx/nginx-conf.test.mjs: checks of the site's nginx config that need no nginx binary.
//
// 26.11.2026: a regex location with a `{32}` quantifier went to the host unquoted. nginx reads `{` as the start of a
// block, `nginx -t` failed, and only the old config kept serving. A regex location that holds a brace must be quoted.
import fs from 'node:fs'

let passed = 0, failed = 0
const check = (label, cond, detail) => { if (cond) { passed++; console.log('  ok   ' + label) } else { failed++; console.log('  FAIL ' + label + (detail ? ': ' + detail : '')) } }
const conf = fs.readFileSync(new URL('./proofofstock.xyz.conf', import.meta.url), 'utf8')

console.log('regex locations')
{
  const lines = conf.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^\s*location\s+~\*?\s/.test(l))
  // The pattern is the first token after `~`: a quoted string, or a run of non-space. A quantifier such as {32} in an
  // unquoted pattern is the failure; a one-line block (`location ~ /\. { return 404; }`) is fine.
  const bad = lines.filter(([, l]) => { const m = /^\s*location\s+~\*?\s+("[^"]*"|\S+)\s*\{/.exec(l); return !m || (!m[1].startsWith('"') && /\{\d/.test(l)) })
  check('every regex location that holds a brace is quoted', bad.length === 0, bad.map(([n, l]) => n + ': ' + l.trim()).join(' | '))
  check('the agent-test API location is anchored to its exact routes', conf.includes('location ~ "^/api/agent-test(/at_[0-9a-f]{32}(/answers|/hide)?)?$" {'))
  // /mcp has its own form (GET POST OPTIONS DELETE) on each host; the agent-test API is the one other POST.
  check('POST is allowed nowhere else outside /mcp', (conf.match(/limit_except[^{]*\{/g) || []).filter((x) => /POST/.test(x) && !/POST OPTIONS DELETE/.test(x)).length === 1)
  check('the badge location logs without the Referer', /location ~ "\^\/agent-test\/at_\[0-9a-f\]\{32\}\/badge\\\.svg\$" \{\n\s+access_log \/var\/log\/pos\/access\.log pos_badge;/.test(conf))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
