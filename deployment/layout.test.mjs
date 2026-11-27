// deployment/layout.test.mjs: POS stands on its own data and its own user (deployment/CUTOVER.md).
//   - Every unit and every script default points our data at /var/lib/pos; nothing writes under /var/lib/stp (the
//     read-only links to the other project's token dataset) or under /root.
//   - No unit runs as root. Only the units that must read the other project's directories (stp-impostors for the
//     streams, stp-health for their age) hold a capability, and only CAP_DAC_READ_SEARCH: read, never write.
//   - The token dataset is passed explicitly, read only, to exactly those units.
//
// Run: node deployment/layout.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { POS_DATA_ROOT, TOKEN_DATASET, TOKEN_DATASET_FIELDS, dataRoot, tokenDataset } from '../scripts/stocks/data-roots.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UNITS_DIR = path.join(ROOT, 'deployment', 'systemd')
const units = Object.fromEntries(fs.readdirSync(UNITS_DIR).filter((f) => f.endsWith('.service')).map((f) => [f, fs.readFileSync(path.join(UNITS_DIR, f), 'utf8')]))
const values = (text, key) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((m) => m[1].trim())
const words = (text, key) => values(text, key).flatMap((v) => v.split(/\s+/)).filter(Boolean)
const OLD = /^-?(\/var\/lib\/stp(\/|$)|\/root(\/|$))/
// The units that read the other project's directories, and why (each says so in its own comments).
const READERS = new Set(['stp-impostors.service', 'stp-health.service'])

// The move to our own user and our own data root is written once, as a procedure, in CUTOVER.md. A unit added after
// it was written is a unit that procedure does not stop, does not wait for and does not start again: stp-anchor-mirror
// was missing from all three for a week (16.11). It is the one that signs, so a run of it caught by a data move is a
// transaction in flight. Every timer there is has to be named in each of the three places, this one most of all.
console.log('the cutover knows every unit')
{
  const cutover = fs.readFileSync(path.join(ROOT, 'deployment', 'CUTOVER.md'), 'utf8')
  const timers = fs.readdirSync(UNITS_DIR).filter((f) => f.endsWith('.timer')).map((f) => f.replace(/\.timer$/, ''))
  const stops = [...cutover.matchAll(/systemctl stop ([^\n]+)/g)].map((m) => m[1])
  const starts = [...cutover.matchAll(/systemctl (?:start|enable --now) ([^\n#]+)/g)].map((m) => m[1]).filter((l) => l.includes('.timer'))
  const waits = [...cutover.matchAll(/while systemctl[^\n]*do sleep[^\n]*/g)].map((m) => m[0])
  check('there are the three places: stop the timers, wait for the runs, start the timers again', stops.length >= 2 && starts.length >= 2 && waits.length >= 2, `${stops.length} stop, ${waits.length} wait, ${starts.length} start`)
  // The wait has to be true WHILE a run is going, and these are oneshots: mid-run they read `activating`, which is
  // what `systemctl is-active --quiet` calls false. The loop here asked that question for a year and returned at
  // once (measured on the host, 16.11). A wait that cannot wait is worse than none: it reads as a guarantee.
  const blind = waits.filter((w) => /is-active/.test(w) || !/ActiveState/.test(w) || !/activating/.test(w))
  check('...and the wait asks a question that is true while a oneshot runs', blind.length === 0, blind.join(' | ').slice(0, 120))
  // The ones that matter in all three places are the ones that write the data being moved: their StateDirectory is
  // our own data or the anchors. The rest (the site, the health check, the backup, the alert) are named where the
  // procedure needs them and are not part of this rule.
  const writes = (t) => /(^|\s)(pos\/|stp-anchors)/.test(values(units[t + '.service'] || '', 'StateDirectory').join(' '))
  const WRITERS = timers.filter(writes)
  check('the writers are the ones we think they are', WRITERS.length >= 5 && WRITERS.includes('stp-anchor-mirror'), WRITERS.join())
  // Named in a command, not only in a sentence about it: prose moves nothing.
  const commands = cutover.split('\n').filter((l) => /systemctl|journalctl/.test(l))
  const absent = timers.filter((t) => !commands.some((l) => l.includes(t)))
  check('no timer is a stranger to the procedure', absent.length === 0, absent.join())
  // A line that moves one writer moves all of them: a procedure that stops four of the five and starts four again is
  // how one gets left running over a data move. Lines about something else (the backup's own timer) are not in it.
  const about = (lines, suffix) => lines.filter((l) => WRITERS.some((t) => l.includes(t + suffix)))
  const missing = (lines, suffix) => WRITERS.filter((t) => !about(lines, suffix).every((l) => l.includes(t + suffix)))
  check('every writer is stopped, in each place that stops them', about(stops, '.timer').length >= 2 && missing(stops, '.timer').length === 0, missing(stops, '.timer').join())
  check('...and started again, in each place that starts them', about(starts, '.timer').length >= 2 && missing(starts, '.timer').length === 0, missing(starts, '.timer').join())
  check('...and waited for before anything moves: a run in flight is the whole risk', missing(waits, '.service').length === 0, missing(waits, '.service').join())
  // ...and the one that signs is explained where it is stopped, in the same breath as its own name: a reader who
  // skips the paragraph is the reader who kills the run.
  const para = cutover.split(/\n\s*\n/).find((b) => /only unit in this project that signs/.test(b.replace(/\n/g, ' ')))
  check('and the one that signs is explained by name, not left as an item in a list', !!para && /stp-anchor-mirror/.test(para) && /nonce/.test(para.replace(/\n/g, ' ')), (para || '').slice(0, 60))
}

console.log('every unit')
{
  check('the units are all here', ['stp-web.service', 'stp-peg.service', 'stp-impostors.service', 'stp-mirror.service', 'stp-anchor.service', 'stp-anchor-mirror.service', 'stp-health.service', 'stp-alert@.service', 'pos-backup.service'].every((u) => units[u]), Object.keys(units).join())
  for (const [name, text] of Object.entries(units)) {
    const user = values(text, 'User')
    check(`${name}: runs as a dedicated user, never root`, user.length === 1 && ['pos', 'pos-backup'].includes(user[0]) && values(text, 'Group')[0] === user[0], user.join())
    check(`${name}: the file system is read-only to it except what it names`, values(text, 'ProtectSystem').join() === 'strict' && values(text, 'NoNewPrivileges').join() === 'true')
    const writes = [...words(text, 'ReadWritePaths'), ...words(text, 'StateDirectory').map((d) => '/var/lib/' + d), ...words(text, 'CacheDirectory').map((d) => '/var/cache/' + d)]
    check(`${name}: writes nothing under /var/lib/stp or /root`, writes.every((p) => !OLD.test(p)), writes.join(' '))
    const roots = [...text.matchAll(/--root=(\S+)/g)].map((m) => m[1])
    check(`${name}: every --root= is under /var/lib/pos`, roots.every((r) => r.startsWith('/var/lib/pos/')), roots.join(' '))
    const envRoots = values(text, 'Environment').filter((e) => e.startsWith('STOCKS_ROOT_'))
    check(`${name}: STOCKS_ROOT_* (our data) is under /var/lib/pos`, envRoots.every((e) => /=\/var\/lib\/pos\//.test(e)), envRoots.join(' '))
    const amb = words(text, 'AmbientCapabilities'), bound = words(text, 'CapabilityBoundingSet')
    if (READERS.has(name) || name === 'pos-backup.service') {
      check(`${name}: holds exactly one capability, to read past permissions`, amb.join() === 'CAP_DAC_READ_SEARCH' && bound.join() === 'CAP_DAC_READ_SEARCH', `${amb} / ${bound}`)
    } else {
      check(`${name}: holds no capability at all`, amb.length === 0 && bound.length === 0 && values(text, 'CapabilityBoundingSet').length === 1, `${amb} / ${bound}`)
    }
    // systemd replaces a bare $name in a command line with its own (usually empty) value: the shell must get $$name.
    const bare = [...values(text, 'ExecStart'), ...values(text, 'ExecStartPre')].filter((c) => /(?<!\$)\$(?!\$)[A-Za-z_(]/.test(c))
    check(`${name}: no shell variable in a command line that systemd would replace`, bare.length === 0, bare.join(' | ').slice(0, 160))
    const readsDataset = /--token-dataset=|POS_TOKEN_DATASET_/.test(text)
    check(`${name}: ${READERS.has(name) ? 'is given' : 'is not given'} the token dataset`, readsDataset === READERS.has(name))
  }
}

console.log('the units that write our data')
{
  for (const name of ['stp-peg.service', 'stp-impostors.service', 'stp-mirror.service']) {
    const text = units[name]
    check(`${name}: writes only each chain's stock-peg/ under /var/lib/pos, created for pos`, words(text, 'StateDirectory').sort().join() === 'pos/base/stock-peg,pos/robinhood/stock-peg' && values(text, 'StateDirectoryMode').join() === '0755')
    check(`${name}: both chains on /var/lib/pos`, /--chain=base --root=\/var\/lib\/pos\/base/.test(text) && /--chain=robinhood --root=\/var\/lib\/pos\/robinhood/.test(text))
  }
  for (const name of ['stp-peg.service', 'stp-impostors.service']) {
    const pre = values(units[name], 'ExecStartPre')
    check(`${name}: refuses to start while either chain's history/ holds no archive`, pre.length === 1 && pre[0].includes('for c in base robinhood') && pre[0].includes('/var/lib/pos/$$c/stock-peg/history/*.jsonl') && /exit 1/.test(pre[0]) && /^OnFailure=stp-alert@%n\.service$/m.test(units[name]), pre.join())
  }
  for (const [name, text] of Object.entries(units)) {
    const hidden = words(text, 'InaccessiblePaths')
    check(`${name}: the owner's secrets (/etc/pos, /etc/stp) do not exist for it`, hidden.includes('-/etc/pos') && hidden.includes('-/etc/stp'), hidden.join(' '))
    if (READERS.has(name) || name === 'pos-backup.service') check(`${name}: with its capability, the password files are hidden too`, hidden.includes('-/etc/shadow') && hidden.includes('-/etc/gshadow'))
  }
  const imp = units['stp-impostors.service']
  check('stp-impostors: reads each chain\'s token dataset explicitly', /--root=\/var\/lib\/pos\/base --token-dataset=\/var\/lib\/stp\/base /.test(imp) && /--root=\/var\/lib\/pos\/robinhood --token-dataset=\/var\/lib\/stp\/robinhood /.test(imp))
  check('stp-peg: reads no token dataset', !/token-dataset|\/var\/lib\/stp\//.test(units['stp-peg.service'].replace(/^#.*$/gm, '')))
  check('stp-anchor: reads our data roots, writes only its own directory', values(units['stp-anchor.service'], 'Environment').filter((e) => e.startsWith('STOCKS_ROOT_')).join() === 'STOCKS_ROOT_BASE=/var/lib/pos/base,STOCKS_ROOT_ROBINHOOD=/var/lib/pos/robinhood' && words(units['stp-anchor.service'], 'ReadWritePaths').join() === '/var/lib/stp-anchors' && words(units['stp-anchor.service'], 'StateDirectory').join() === 'stp-anchors')
  // The one key in the repository's units (spec H4). It reaches exactly one unit, by LoadCredential, which systemd reads
  // as root before the unit's sandbox exists: no unit can read /etc/pos itself, this one included. If a second unit ever
  // asks for a credential here, this fails, because a key that spreads is a key nobody can reason about any more. The
  // settlement key for paid passes is the one other key, and it is deliberately not in these files: it reaches stp-web
  // by a host-only drop-in (deployment/PUBLISHING.md "Paid passes"), because a host without it must still start.
  const mirror = units['stp-anchor-mirror.service']
  const credentialed = Object.entries(units).filter(([, t]) => values(t, 'LoadCredential').length).map(([n]) => n)
  // The Telegram bot (23.11) is the one other unit given a credential, and it was let in by name: its token speaks for a
  // chat bot, it signs nothing and moves nothing, so it goes by the same LoadCredential path rather than the environment.
  // Any third unit still fails here.
  check('exactly two units are given a credential: the anchor mirror (the key) and the Telegram bot (a chat token)', credentialed.sort().join() === 'stp-anchor-mirror.service,stp-tg-bot.service', credentialed.join())
  const tg = units['stp-tg-bot.service']
  check('stp-tg-bot: the token comes from the owner file, by name, never from the environment or a command line', values(tg, 'LoadCredential').join() === 'tg-bot:/etc/pos/tg-bot.env' && !/TG_BOT_TOKEN=/.test(tg.replace(/^#.*$/gm, '')))
  check('...it reads none of our data roots and writes only its own state directory', values(tg, 'Environment').every((e) => !e.startsWith('STOCKS_ROOT_')) && !values(tg, 'ReadWritePaths').length && words(tg, 'StateDirectory').join() === 'stp-tg-bot' && words(tg, 'InaccessiblePaths').includes('-/var/lib/pos'))
  check('...and it may only reach the network and name resolution: nothing group-readable, no other process visible', words(tg, 'RestrictAddressFamilies').sort().join() === 'AF_INET,AF_INET6,AF_UNIX' && /^UMask=0077$/m.test(tg) && /^ProtectProc=invisible$/m.test(tg) && /^SystemCallFilter=@system-service$/m.test(tg))
  check('stp-anchor-mirror: the key comes from the owner file, by name, never from the environment', values(mirror, 'LoadCredential').join() === 'anchor-key:/etc/pos/anchor.key' && !/anchor.key=|STP_ANCHOR_KEY=/.test(mirror))
  check('...it writes only the anchors directory and runs after the anchor itself', words(mirror, 'ReadWritePaths').join() === '/var/lib/stp-anchors' && /^After=stp-anchor\.service$/m.test(mirror))
  // AF_UNIX is name resolution (nss-resolve and nscd both answer over a unix socket), not a path of ours.
  check('...and it may reach the two chains and nothing else of the host', words(mirror, 'RestrictAddressFamilies').sort().join() === 'AF_INET,AF_INET6,AF_UNIX')
  check('...the unit with the key is the most closed of them: no stray syscall, nothing group-readable, no other process visible', /^SystemCallFilter=@system-service$/m.test(mirror) && /^SystemCallArchitectures=native$/m.test(mirror) && /^UMask=0077$/m.test(mirror) && /^ProcSubset=pid$/m.test(mirror))
  check('the unit that holds the key never reads our data roots: it needs the manifest hash, not the rows', values(mirror, 'Environment').every((e) => !e.startsWith('STOCKS_ROOT_')))
  const web = units['stp-web.service']
  check('stp-web: reads our data only, writes only its own counter and the agent test store', values(web, 'Environment').filter((e) => e.startsWith('STOCKS_ROOT_')).join() === 'STOCKS_ROOT_BASE=/var/lib/pos/base,STOCKS_ROOT_ROBINHOOD=/var/lib/pos/robinhood' && words(web, 'ReadWritePaths').join() === '/var/lib/stp-analytics,/var/lib/stp-agent-test' && values(web, 'Environment').includes('STP_AGENT_TEST_DIR=/var/lib/stp-agent-test'))
  // The port held across restarts (deploy 502s, 20.11): the socket listens exactly where the server would bind, hands
  // over to this service, and the service only orders itself after it, so disabling the socket is a real way back.
  const sock = fs.readFileSync(path.join(UNITS_DIR, 'stp-web.socket'), 'utf8')
  const webAt = `${values(web, 'Environment').find((e) => e.startsWith('STOCKS_WEB_HOST='))?.split('=')[1]}:${values(web, 'Environment').find((e) => e.startsWith('STOCKS_WEB_PORT='))?.split('=')[1]}`
  check('stp-web.socket listens where stp-web would bind, and hands over to it', values(sock, 'ListenStream').join() === webAt && webAt === '127.0.0.1:3005' && values(sock, 'Service').join() === 'stp-web.service' && values(sock, 'WantedBy').join() === 'sockets.target', `${values(sock, 'ListenStream')} vs ${webAt}`)
  check('...stp-web is ordered after it and does not pull it in', values(web, 'After').includes('stp-web.socket') && !/stp-web\.socket/.test([...values(web, 'Wants'), ...values(web, 'Requires'), ...values(web, 'BindsTo')].join(' ')))
  check('...and the server takes a socket only through the protocol, never a fixed descriptor', /systemdListenFd\(\)/.test(fs.readFileSync(path.join(ROOT, 'apps', 'stocks-web.mjs'), 'utf8')))
  const health = units['stp-health.service']
  check('stp-health: our roots, the token datasets, and the backup status', /^Environment=POS_TOKEN_DATASET_BASE=\/var\/lib\/stp\/base$/m.test(health) && /^Environment=POS_TOKEN_DATASET_ROBINHOOD=\/var\/lib\/stp\/robinhood$/m.test(health) && /^Environment=POS_BACKUP_STATUS=\/var\/lib\/pos-backup\/status\.json$/m.test(health))
  for (const name of ['stp-health.service', 'stp-alert@.service']) {
    check(`${name}: the bot token from /etc/pos/alert.env, the old /etc/stp file only until it exists`, values(units[name], 'EnvironmentFile').join() === '-/etc/stp/alert.env,-/etc/pos/alert.env')
  }
}

console.log('the script defaults')
{
  check('our data root is /var/lib/pos/<chain>', POS_DATA_ROOT.base === '/var/lib/pos/base' && POS_DATA_ROOT.robinhood === '/var/lib/pos/robinhood' && dataRoot('base', { env: {} }) === '/var/lib/pos/base')
  check('the token dataset is a separate, explicit default with its own env', TOKEN_DATASET.base === '/var/lib/stp/base' && tokenDataset('robinhood', { env: { POS_TOKEN_DATASET_ROBINHOOD: '/x' } }) === '/x' && tokenDataset('base', { arg: '/y', env: { POS_TOKEN_DATASET_BASE: '/x' } }) === '/y' && tokenDataset('base', { env: {} }) === '/var/lib/stp/base')
  check('the read contract names its files and fields', Object.keys(TOKEN_DATASET_FIELDS).join() === 'static/token-static-,deployers/token-deployer-' && Object.keys(TOKEN_DATASET_FIELDS['static/token-static-']).sort().join() === 'deployer,name,observed_at,symbol,token_address')
  // Every source file (tests aside) that names /var/lib/stp/<chain> as a path does it only through data-roots.mjs.
  const files = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mjs|js|sh)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) files.push(p) } }
  for (const d of ['apps', 'scripts', 'evm']) walk(path.join(ROOT, d))
  const code = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|#|\*)/.test(l)).join('\n')
  const naming = files.filter((f) => /['"`]\/var\/lib\/stp\//.test(code(f))).map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  check('no script or app defaults to /var/lib/stp/<chain> except the token dataset in data-roots.mjs', naming.join() === 'scripts/stocks/data-roots.mjs', naming.join())
  const rootHome = files.filter((f) => /['"`]\/root(\/|['"`])/.test(code(f))).map((f) => path.relative(ROOT, f))
  check('no script or app names /root', rootHome.length === 0, rootHome.join())
  const web = fs.readFileSync(path.join(ROOT, 'apps', 'stocks-web.mjs'), 'utf8')
  check('the site defaults to /var/lib/pos', /STOCKS_ROOT_BASE \|\| '\/var\/lib\/pos\/base'/.test(web) && /STOCKS_ROOT_ROBINHOOD \|\| '\/var\/lib\/pos\/robinhood'/.test(web))
  for (const s of ['impostor-list', 'passport', 'impostor-census', 'health-check', 'stock-peg', 'passport-mcp']) {
    check(`scripts/stocks/${s}.mjs takes its roots from data-roots.mjs`, /data-roots\.mjs/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'stocks', s + '.mjs'), 'utf8')))
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { for (const x of failures) console.log(x); process.exit(1) }
