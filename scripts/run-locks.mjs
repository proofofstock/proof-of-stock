// Run every mutation lock: each breaks the code on purpose and requires its test to go red.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const locks = fs.readdirSync('tests/locks').filter((f) => f.endsWith('.mutations.json')).sort()
let bad = 0
for (const l of locks) {
  const r = spawnSync(process.execPath, ['scripts/mutate-lock.mjs', 'tests/locks/' + l], { encoding: 'utf8' })
  const last = (r.stdout.trim().split('\n').pop() || '').trim()
  console.log((r.status === 0 ? 'ok   ' : 'FAIL ') + l + '  ' + last)
  if (r.status !== 0) bad++
}
process.exit(bad ? 1 : 0)
