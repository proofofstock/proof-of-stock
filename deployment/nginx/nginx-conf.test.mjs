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
  // /mcp has its own form (GET POST OPTIONS DELETE) on each host; the agent-test API and /api/simulate are the two others.
  check('POST is allowed nowhere else outside /mcp, the agent-test API and /api/simulate', (conf.match(/limit_except[^{]*\{/g) || []).filter((x) => /POST/.test(x) && !/POST OPTIONS DELETE/.test(x)).length === 2)
  check('the badge location logs without the Referer', /location ~ "\^\/agent-test\/at_\[0-9a-f\]\{32\}\/badge\\\.svg\$" \{\n\s+access_log \/var\/log\/pos\/access\.log pos_badge;/.test(conf))
}

console.log('simulate_buy: the wallet only in a body the logs never write (docs/simulate-buy-tz.md §5.3)')
{
  const loc = (conf.match(/location = \/api\/simulate \{[\s\S]*?\n {4}\}/) || [''])[0]
  check('the nginx config allows POST on /api/simulate, an exact location with its own 1 KB body cap', /limit_except GET HEAD POST OPTIONS \{ deny all; \}/.test(loc) && /client_max_body_size 1k;/.test(loc) && /proxy_pass http:\/\/127\.0\.0\.1:3005\/stocks\/api\/simulate;/.test(loc))
  check('no log_format in it writes $request_body, and no location logs the body some other way', !/\$request_body/.test(conf))
  // A GET with ?wallet=... is refused by the app, but nginx logs the request before the app answers: this location's
  // access log keeps neither the query string nor the Referer, and its error log only what names no request.
  const fmt = (conf.match(/log_format pos_simulate '([^']*)';/) || [])[1] || ''
  check('/api/simulate logs with a format that has no query string, no Referer and no body ($uri, never $request or $args)', /access_log \/var\/log\/pos\/access\.log pos_simulate;/.test(loc) && fmt.includes('$uri') && !/\$request\b|\$request_uri|\$args|\$query_string|\$http_referer|\$request_body/.test(fmt), fmt)
  check('...and its error log is at emerg, the one level no message naming a request reaches (an access-log write failure is an alert)', /error_log \/var\/log\/pos\/error\.log emerg;/.test(loc))
  // Every server block, the redirecting ones included (www, the older names, plain http), has its own /api/simulate
  // location with the same query-free access log and emerg error log, and no server-level return that would run
  // before any location is chosen.
  const blocks = conf.split(/\n(?=server \{)/).filter((b) => b.startsWith('server {'))
  const bad = blocks.filter((b) => {
    const l = (b.match(/location = \/api\/simulate \{[\s\S]*?\n {4}\}/) || [''])[0]
    return !l || !/access_log \/var\/log\/pos\/access\.log pos_simulate;/.test(l) || !/error_log \/var\/log\/pos\/error\.log emerg;/.test(l) || /\n {4}return /.test(b)
  })
  check('every server block logs /api/simulate without its query and with an emerg error log, redirects included', blocks.length === 5 && bad.length === 0, bad.map((b) => (b.match(/server_name ([^;]+);/) || [])[1]).join(' | '))
  // nginx's own choice, modelled: an exact location wins its path; otherwise the longest prefix, and a ^~ prefix stops
  // the regex locations from being tried. Every host must send these paths to its quiet 404 location.
  const choose = (b, path) => {
    const locs = [...b.matchAll(/\n {4}location (=|\^~|~\*?)?\s*("[^"]*"|\S+) \{/g)].map((m) => ({ mod: m[1] || '', pat: m[2].replace(/^"|"$/g, ''), at: m.index }))
    const exact = locs.find((l) => l.mod === '=' && l.pat === path)
    if (exact) return exact
    const prefix = locs.filter((l) => (l.mod === '' || l.mod === '^~') && path.startsWith(l.pat)).sort((x, y) => y.pat.length - x.pat.length)[0]
    if (prefix && prefix.mod === '^~') return prefix
    const rx = locs.find((l) => l.mod.startsWith('~') && new RegExp(l.pat).test(path))
    return rx || prefix || null
  }
  const lands = (b, path) => { const l = choose(b, path); return l ? b.slice(l.at, b.indexOf('\n    }', l.at)) : '' }
  const odd = []
  for (const b of blocks) for (const path of ['/api/simulate.json', '/api/simulate/x', '/api/simulate/.env', '/api/simulatex']) if (!/return 404;/.test(lands(b, path)) || !/pos_simulate/.test(lands(b, path))) odd.push((b.match(/server_name ([^;]+);/) || [])[1] + ' ' + path)
  check('/api/simulate.json, /api/simulate/x and /api/simulate/.env land in the quiet 404 location on every host, the exact path in its own', odd.length === 0 && blocks.every((b) => /location = \/api\/simulate/.test(lands(b, '/api/simulate'))), odd.join(' | '))
  check('...and on every host anything starting /api/simulate is answered 404 in place, never proxied, logged the same quiet way', blocks.every((b) => { const sub = (b.match(/location \^~ \/api\/simulate \{[\s\S]*?\n {4}\}/) || [''])[0]; return /access_log \/var\/log\/pos\/access\.log pos_simulate;/.test(sub) && /error_log \/var\/log\/pos\/error\.log emerg;/.test(sub) && /return 404;/.test(sub) && !/proxy_pass/.test(sub) }) && (conf.match(/location = \/api\/simulate \{/g) || []).length === 5)
  const noLimit = blocks.filter((b) => !/location = \/mcp/.test(b) && !/proxy_pass/.test(b))
  check('the blocks that only redirect read no body, so no body size turns a redirect into a 413', noLimit.length === 2 && noLimit.every((b) => /\n {4}client_max_body_size 0;/.test(b)))
  check('...the location comes before the catch-all, which takes GET and HEAD only', conf.indexOf('location = /api/simulate {') > 0 && conf.indexOf('location = /api/simulate {') < conf.indexOf('    location / {'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
