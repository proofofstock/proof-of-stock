// scripts/stocks/health-stale.test.mjs: the health checks for what lives outside the repository (owner, 27.11). The
// guard on npm and the server on the official MCP registry are an alert once they stay below the release's own version
// for more than 3 days, counted from the first run that saw it, kept in the alert state file; a registry that cannot be
// read is neither an alert nor a clear. A week of [Unreleased] entries past the newest dated release is an alert too.
// No network: every fetch here is injected.
//
// Run: node scripts/stocks/health-stale.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { versionBelow, changelogState, releaseState, readPublished, staleChecks, outsideChecks, readStaleSince, NPM_GUARD_URL, mcpRegistryUrl, STALE_PUBLISH_DAYS, STALE_RELEASE_DAYS, STALE_SINCE_KEY } from './health-check.mjs'
import { alert } from '../lib/alert.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-health-stale-'))
const NOW = Date.parse('2026-11-27T12:00:00Z')
const D = 864e5
const NAME = 'xyz.example/server'
const bad = (checks) => checks.filter((c) => c.bad).map((c) => c.key).sort()
const keys = (checks) => checks.map((c) => c.key).sort()
const release = (o = {}) => ({ guard: '1.3.0', server: '2.1.0', serverName: NAME, changelog: { unreleased: 0, newest: '2026-11-26' }, ...o })
const pub = (npm, mcp) => ({ npm: typeof npm === 'string' ? { version: npm } : npm, mcp: typeof mcp === 'string' ? { version: mcp } : mcp })

console.log('versions and the changelog')
{
  check('the thresholds are 3 days for a registry and 7 for a release', STALE_PUBLISH_DAYS === 3 && STALE_RELEASE_DAYS === 7)
  check('versions compare by number, not as text', versionBelow('0.9.0', '0.10.0') === true && versionBelow('0.10.0', '0.9.0') === false && versionBelow('1.2.3', '1.2.3') === false && versionBelow('1.2.3', '1.10.0') === true)
  check('a version that is not plain x.y.z is not compared', versionBelow('1.2.3-rc.1', '1.2.3') === null && versionBelow(null, '1.0.0') === null && versionBelow('1.0', '1.0.0') === null)
  const cl = changelogState('# Changelog\n\n## [Unreleased]\n\n### Added\n- one\n- two\n  - a sub-point\n\n## [1.1.0] - 2026-11-20\n\n- old\n\n## [1.0.0] - 2026-11-01\n')
  check('[Unreleased] entries are counted up to the next release, and the newest dated release is found', cl.unreleased === 2 && cl.newest === '2026-11-20', JSON.stringify(cl))
  check('an empty [Unreleased] holds nothing; a file without the section says so', changelogState('## [Unreleased]\n\n## [1.0.0] - 2026-11-01\n').unreleased === 0 && changelogState('## [1.0.0] - 2026-11-01\n').unreleased === null)
  // The repository's own files, as the release on the host holds them.
  const mine = releaseState()
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  check('the release is read from its own files: the guard, server.json and its name, the changelog', /^\d+\.\d+\.\d+$/.test(mine.guard) && mine.server === pkg.version && mine.serverName === 'xyz.proofofstock/proof-of-stock' && mine.changelog && Number.isInteger(mine.changelog.unreleased), JSON.stringify(mine))
  check('a release root with nothing in it gives nulls, never a throw', JSON.stringify(releaseState(tmp)) === JSON.stringify({ guard: null, server: null, serverName: null, changelog: null }))
}

console.log('the registries, asked with an injected fetch')
{
  const asked = []
  const fake = (answers) => async (url) => { asked.push(url); const a = answers[url]; if (a instanceof Error) throw a; return { ok: a.status == null, status: a.status ?? 200, json: async () => a } }
  const ok = await readPublished({ serverName: NAME, fetchImpl: fake({ [NPM_GUARD_URL]: { name: '@proofofstock/guard', version: '1.2.0' }, [mcpRegistryUrl(NAME)]: { server: { name: NAME, version: '2.0.0' }, _meta: {} } }) })
  check('npm\'s latest and the MCP registry\'s latest version, by the server\'s name', ok.npm.version === '1.2.0' && ok.mcp.version === '2.0.0' && asked.includes('https://registry.npmjs.org/@proofofstock%2fguard/latest') && asked.includes('https://registry.modelcontextprotocol.io/v0/servers/xyz.example%2Fserver/versions/latest'), JSON.stringify(ok))
  const odd = await readPublished({ serverName: NAME, fetchImpl: fake({ [NPM_GUARD_URL]: { name: 'someone-else', version: '9.0.0' }, [mcpRegistryUrl(NAME)]: { server: { name: 'other/name', version: '9.0.0' } } }) })
  check('an answer about another package or server is not a version', odd.npm.error && odd.mcp.error, JSON.stringify(odd))
  const down = await readPublished({ serverName: NAME, fetchImpl: fake({ [NPM_GUARD_URL]: new Error('offline'), [mcpRegistryUrl(NAME)]: { status: 503 } }) })
  check('a registry that throws or answers an error is an error, not a version', down.npm.error && down.mcp.error === 'HTTP 503', JSON.stringify(down))
}

console.log('behind for more than 3 days, from the first run that saw it')
{
  const first = staleChecks({ release: release(), published: pub('1.2.0', '2.0.0'), since: {}, now: NOW })
  check('behind, first seen now: neither an alert nor a clear, and the time is kept', first.checks.filter((c) => c.key.startsWith('stale:npm') || c.key.startsWith('stale:mcp')).length === 0 && first.since['stale:npm-guard'] === NOW && first.since['stale:mcp-registry'] === NOW, JSON.stringify(first))
  const day3 = staleChecks({ release: release(), published: pub('1.2.0', '2.0.0'), since: first.since, now: NOW + 3 * D })
  check('exactly 3 days is not yet an alert', bad(day3.checks).length === 0)
  const later = staleChecks({ release: release(), published: pub('1.2.0', '2.0.0'), since: first.since, now: NOW + 3 * D + 60e3 })
  check('past 3 days: stale:npm-guard and stale:mcp-registry', bad(later.checks).join() === 'stale:mcp-registry,stale:npm-guard', JSON.stringify(later.checks))
  const npmText = later.checks.find((c) => c.key === 'stale:npm-guard').text
  check('...saying which version is out there, which the release holds, and for how long', npmText.includes('1.2.0') && npmText.includes('1.3.0') && /for 3 days/.test(npmText) && /PUBLISHING\.md/.test(npmText), npmText)
  const caught = staleChecks({ release: release(), published: pub('1.3.0', '2.2.0'), since: later.since, now: NOW + 4 * D })
  check('caught up (or ahead): both clear, and the first-seen times are dropped', bad(caught.checks).length === 0 && keys(caught.checks).includes('stale:npm-guard') && keys(caught.checks).includes('stale:mcp-registry') && !('stale:npm-guard' in caught.since) && !('stale:mcp-registry' in caught.since))
  const again = staleChecks({ release: release(), published: pub('1.2.0', '2.1.0'), since: caught.since, now: NOW + 5 * D })
  check('behind again starts a new clock', again.since['stale:npm-guard'] === NOW + 5 * D && bad(again.checks).length === 0)
}

console.log('a registry that cannot be read')
{
  const since = { 'stale:npm-guard': NOW - 10 * D, 'stale:mcp-registry': NOW - 10 * D }
  const r = staleChecks({ release: release(), published: pub({ error: 'TimeoutError' }, { error: 'HTTP 503' }), since, now: NOW })
  check('is neither an alert nor a clear', !keys(r.checks).some((k) => k === 'stale:npm-guard' || k === 'stale:mcp-registry'), JSON.stringify(r.checks))
  check('...keeps the first-seen time, so the clock does not restart', r.since['stale:npm-guard'] === NOW - 10 * D && r.since['stale:mcp-registry'] === NOW - 10 * D)
  check('...and says so for the journal', r.notes.some((n) => /stale:npm-guard: npm could not be read \(TimeoutError\)/.test(n)) && r.notes.some((n) => /stale:mcp-registry: the official MCP registry could not be read \(HTTP 503\)/.test(n)), r.notes.join(' | '))
}

console.log('a release not cut for a week')
{
  const at = (newest, unreleased) => staleChecks({ release: release({ changelog: { unreleased, newest } }), published: pub('1.3.0', '2.1.0'), now: NOW }).checks.find((c) => c.key === 'stale:release')
  check('entries waiting and the newest release 8 days old: stale:release', at('2026-11-19', 4).bad === true && /4 unreleased entries/.test(at('2026-11-19', 4).text) && /2026-11-19/.test(at('2026-11-19', 4).text))
  check('...7 days old is not yet', at('2026-11-20', 4).bad === false)
  check('...an empty [Unreleased] is never stale, however old the release', at('2026-01-01', 0).bad === false)
  check('...entries and no dated release at all: stale', at(null, 1).bad === true)
  const none = staleChecks({ release: release({ changelog: null }), published: pub('1.3.0', '2.1.0'), now: NOW })
  check('a release without a readable changelog gives no check, and a note', !keys(none.checks).includes('stale:release') && none.notes.some((n) => /stale:release/.test(n)))
}

console.log('one run, its state in the alert state file')
{
  const file = path.join(tmp, 'state.json')
  const env = { STP_ALERT_STATE: file }
  const root = path.join(tmp, 'release')
  fs.mkdirSync(path.join(root, 'packages/proofofstock-guard'), { recursive: true })
  fs.writeFileSync(path.join(root, 'packages/proofofstock-guard/package.json'), JSON.stringify({ version: '1.3.0' }))
  fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify({ name: NAME, version: '2.1.0' }))
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## [Unreleased]\n\n## [2.1.0] - 2026-11-26\n')
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => url === NPM_GUARD_URL ? { name: '@proofofstock/guard', version: '1.2.0' } : { server: { name: NAME, version: '2.1.0' } } })
  const lines = []
  // An alert already in the file, so the first-seen times must sit beside it, not over it.
  await alert({ key: 'site:down', text: 'x' }, { env, fetchImpl: null, log: () => {} })
  const c1 = await outsideChecks({ now: NOW, env, fetchImpl, root, log: (m) => lines.push(m) })
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'))
  check('the first-seen time is kept under its own key in the alert state file, beside the alerts', kept[STALE_SINCE_KEY]?.['stale:npm-guard'] === NOW && kept['site:down']?.resolved === false && readStaleSince(file)['stale:npm-guard'] === NOW, JSON.stringify(kept))
  check('...the MCP registry at the release\'s version clears, the guard waits its 3 days', bad(c1).length === 0 && keys(c1).includes('stale:mcp-registry') && !keys(c1).includes('stale:npm-guard') && lines.some((l) => /stale:npm-guard: npm is behind/.test(l)), JSON.stringify(c1))
  const c2 = await outsideChecks({ now: NOW + 4 * D, env, fetchImpl, root, log: () => {} })
  check('...and a later run, past 3 days from that time, alerts', bad(c2).join() === 'stale:npm-guard')
  check('a state file that cannot be read starts empty', JSON.stringify(readStaleSince(path.join(tmp, 'none.json'))) === '{}')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const l of failures) console.log(l); process.exit(1) }
