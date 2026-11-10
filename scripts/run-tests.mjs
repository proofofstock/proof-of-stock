// Run every *.test.mjs in the repository (node_modules and .git skipped); exit non-zero if any fails.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SKIP = new Set(['node_modules', '.git'])
const tests = []
const walk = (dir) => {
  for (const n of fs.readdirSync(dir)) {
    if (SKIP.has(n)) continue
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (n.endsWith('.test.mjs')) tests.push(path.relative('.', p).split(path.sep).join('/'))
  }
}
walk('.')
tests.sort()
let bad = 0
for (const t of tests) {
  const r = spawnSync(process.execPath, [t], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const last = (r.stdout.trim().split('\n').pop() || '').trim()
  console.log((r.status === 0 ? 'ok   ' : 'FAIL ') + t + '  ' + last)
  if (r.status !== 0) { bad++; process.stdout.write(r.stdout.slice(-2000) + r.stderr.slice(-2000)) }
}
console.log(`\n${tests.length - bad}/${tests.length} suites passed`)
process.exit(bad ? 1 : 0)
