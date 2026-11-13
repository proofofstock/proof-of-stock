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

console.log('every unit')
{
  check('the units are all here', ['stp-web.service', 'stp-peg.service', 'stp-impostors.service', 'stp-mirror.service', 'stp-anchor.service', 'stp-health.service', 'stp-alert@.service', 'pos-backup.service'].every((u) => units[u]), Object.keys(units).join())
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
    if (READERS.has(name)) {
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
    if (name === 'pos-backup.service') continue
    const hidden = words(text, 'InaccessiblePaths')
    check(`${name}: the owner's secrets (/etc/pos, /etc/stp) do not exist for it`, hidden.includes('-/etc/pos') && hidden.includes('-/etc/stp'), hidden.join(' '))
    if (READERS.has(name)) check(`${name}: with its capability, the password files are hidden too`, hidden.includes('-/etc/shadow') && hidden.includes('-/etc/gshadow'))
  }
  const imp = units['stp-impostors.service']
  check('stp-impostors: reads each chain\'s token dataset explicitly', /--root=\/var\/lib\/pos\/base --token-dataset=\/var\/lib\/stp\/base /.test(imp) && /--root=\/var\/lib\/pos\/robinhood --token-dataset=\/var\/lib\/stp\/robinhood /.test(imp))
  check('stp-peg: reads no token dataset', !/token-dataset|\/var\/lib\/stp\//.test(units['stp-peg.service'].replace(/^#.*$/gm, '')))
  check('stp-anchor: reads our data roots, writes only its own directory', values(units['stp-anchor.service'], 'Environment').filter((e) => e.startsWith('STOCKS_ROOT_')).join() === 'STOCKS_ROOT_BASE=/var/lib/pos/base,STOCKS_ROOT_ROBINHOOD=/var/lib/pos/robinhood' && words(units['stp-anchor.service'], 'ReadWritePaths').join() === '/var/lib/stp-anchors' && words(units['stp-anchor.service'], 'StateDirectory').join() === 'stp-anchors')
  const web = units['stp-web.service']
  check('stp-web: reads our data only, writes only its own counter', values(web, 'Environment').filter((e) => e.startsWith('STOCKS_ROOT_')).join() === 'STOCKS_ROOT_BASE=/var/lib/pos/base,STOCKS_ROOT_ROBINHOOD=/var/lib/pos/robinhood' && words(web, 'ReadWritePaths').join() === '/var/lib/stp-analytics')
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
