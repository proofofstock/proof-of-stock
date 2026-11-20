// apps/seal-block.test.mjs: the seal block on the landing (apps/stocks-web/seal.js). It may say "sealed" only about a
// hash this browser computed and a mirror somebody else confirmed; and a token's own words reach the page as text.
//
// Run: node apps/seal-block.test.mjs
import fs from 'node:fs'
import crypto from 'node:crypto'
import { SECURITY_HEADERS } from './stocks-web.mjs'

let passed = 0, failed = 0
const failures = []
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + label); return }
  failed++; const l = '  FAIL ' + label + (detail ? ': ' + detail : ''); failures.push(l); console.log(l)
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const html = read('./stocks-web/index.html'), js = read('./stocks-web/seal.js'), server = read('./stocks-web.mjs')
// The script is a classic browser script: outside a page it only defines SEAL, which is what is tested here.
const SEAL = new Function(js + '\nreturn SEAL')()
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

const DAY = '2026-11-14'
const manifest = JSON.stringify({
  _schema: 'proofofstock-anchor-manifest/1', day: DAY, previous: null,
  files: [
    { chain: 'base', file: `stock-peg-${DAY}.jsonl`, bytes: 10, sha256: sha('a') },
    { chain: 'base', file: `history/cases-${DAY}.jsonl`, bytes: 20, sha256: sha('b') },
    { chain: 'robinhood', file: `stock-peg-${DAY}.jsonl`, bytes: 30, sha256: sha('c') }
  ]
}, null, 2) + '\n'
const HASH = sha(manifest)
const TX = '0x' + 'ab'.repeat(32)
const mirror = (over = {}, top = {}) => ({ sha256: HASH, mirrors: [{ chain: 'robinhood', status: 'confirmed', sha256: HASH, tx: '0x' + 'cd'.repeat(32), witnessed_by: ['x'] }, { chain: 'base', status: 'confirmed', sha256: HASH, tx: TX, block: 57565332, sent_at: '2026-11-15T00:44:01.636Z', witnessed_by: ['base-rpc.publicnode.com'], ...over }], ...top })
const ev = (over = {}) => ({ event: 'opened', at: `${DAY}T06:23:50.771Z`, address: '0x' + '1A'.repeat(20), symbol: 'XYZ', name: 'Example Corp', imitates_symbol: 'XYZc', ...over })
const days = [{ day: '2026-11-16', manifest: 'anchors/manifest-2026-11-16.json', mirror: null }, { day: DAY, manifest: `anchors/manifest-${DAY}.json`, mirror: `anchors/mirror-${DAY}.json`, btc_check: `anchors/btc-check-${DAY}.json` }]

console.log('the page')
const section = (html.match(/<section class="seal"[\s\S]*?<\/section>/) || [''])[0]
check('the block sits between the stance and the board', html.indexOf('class="stance"') < html.indexOf('class="seal"') && html.indexOf('class="seal"') < html.indexOf('class="board"'))
check('it is hidden until the script has verified a seal', /<section class="seal" id="seal"[^>]* hidden>/.test(section))
check('no inline script, style or handler in it: the CSP needs no change', !/<script|<style|\sstyle=|\son[a-z]+=/.test(section) && /script-src 'self'/.test(SECURITY_HEADERS['content-security-policy']) && /connect-src 'self'/.test(SECURITY_HEADERS['content-security-policy']))
check('the script is loaded, served and versioned', /<script src="seal\.js" defer><\/script>/.test(html) && /'\/seal\.js': \['seal\.js'/.test(server) && /src="seal\.js\?v=/.test(server))
check('the script reads only this site (connect-src self)', !/fetch\(\s*['"`]https?:/.test(js) && !/fetch\(\s*['"`]\//.test(js))
check('nothing reaches the page as HTML: a token\'s name is its creator\'s text', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js))
check('every id the script asks for is in the page', [...js.matchAll(/\$\('([a-z-]+)'\)/g)].every((m) => html.includes(`id="${m[1]}"`)), [...js.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]).filter((id) => !html.includes(`id="${id}"`)).join(' '))

console.log('which record is shown')
{
  const got = SEAL.pickCases([ev({ at: '2026-11-16T01:00:00Z', address: '0x' + '22'.repeat(20) }), ev({ event: 'gone' }), ev()], days)
  check('the newest opened case whose day has a mirror comes first', got[0] && got[0].day === DAY && got[0].address === '0x' + '1a'.repeat(20), JSON.stringify(got[0]))
  check('a case of a day that is not mirrored yet is not offered', !got.some((c) => c.day === '2026-11-16'))
  check('only an opened case is a record of what we said that day', got.filter((c) => c.symbol === 'XYZ').length === 1)
  const last = got[got.length - 1]
  check('the pinned case closes the list, once', last.address === SEAL.PINNED.address && last.day === SEAL.PINNED.day && SEAL.pickCases([], []).length === 1 && SEAL.pickCases(null, null)[0].address === SEAL.PINNED.address)
  const bare = [{ day: DAY, mirror: `anchors/mirror-${DAY}.json`, btc_check: null }]
  check('a case says whether its day has a Bitcoin check on file', got[0].checked === true && last.checked === true && SEAL.pickCases([ev()], bare)[0].checked === false && SEAL.pickCases([], bare)[0].checked === false && SEAL.pickCases([], [])[0].checked === false)
  check('the page asks for the Bitcoin check only when the listing names it', js.includes('c.checked ? await json(`anchors/btc-check-'))
  const three = SEAL.pickCases(['33', '44', '55'].map((x) => ev({ address: '0x' + x.repeat(20) })), days)
  const on = (d) => SEAL.dailyOrder(three, d).map((c) => c.address.slice(2, 4)).join(' ')
  const sealedDays = [{ day: '2026-11-13', mirror: 'm' }, { day: '2026-11-15', mirror: 'm' }]
  const mixed = SEAL.pickCases([ev({ at: '2026-11-13T01:00:00Z', address: '0x' + '66'.repeat(20) }), ev({ at: '2026-11-15T01:00:00Z', address: '0x' + '77'.repeat(20) }), ev({ at: '2026-11-15T02:00:00Z', address: '0x' + '88'.repeat(20) })], sealedDays)
  const dayOrder = (d) => SEAL.dailyOrder(mixed, d).map((c) => c.day).join()
  check('the newest sealed day comes first, whatever the date, so the block shows last night\'s seal', ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].every((d) => SEAL.dailyOrder(mixed, d)[0].day === '2026-11-15'), dayOrder('2026-11-20'))
  check('...older days follow, newest first, so a newest day not sealed yet falls through to the day before', dayOrder('2026-11-20') === '2026-11-15,2026-11-15,2026-11-13,' + SEAL.PINNED.day, dayOrder('2026-11-20'))
  check('...and within that day the record still changes daily', SEAL.dailyOrder(mixed, '2026-11-20')[0].address !== SEAL.dailyOrder(mixed, '2026-11-21')[0].address)
  check('within one day the record shown rotates once a day through that day\'s cases', new Set(['2026-11-19', '2026-11-20', '2026-11-21'].map((d) => on(d).split(' ')[0])).size === 3 && on('2026-11-19') === on('2026-11-19'), ['2026-11-19', '2026-11-20', '2026-11-21'].map(on).join(' | '))
  check('...keeps every case, with the pinned one last', ['2026-11-19', '2026-11-20'].every((d) => { const o = SEAL.dailyOrder(three, d); return o.length === 4 && o[3].address === SEAL.PINNED.address && new Set(o.map((c) => c.address)).size === 4 }))
  check('...and with no archive case or no date, the order is left as it was', SEAL.dailyOrder(SEAL.pickCases([], []), '2026-11-19')[0].address === SEAL.PINNED.address && SEAL.dailyOrder(three, '').map((c) => c.address).join() === three.map((c) => c.address).join() && SEAL.dailyOrder(null, '2026-11-19').length === 0)
  check('the page tries them in today\'s order', js.includes('SEAL.dailyOrder(SEAL.pickCases(cases.events, list.days), today)'))
  check('a case with no address or no listed symbol to compare with is skipped', SEAL.pickCases([ev({ address: 'nope' }), ev({ imitates_symbol: '<b>' })], days).length === 1)
  const long = SEAL.pickCases([ev({ symbol: 'S'.repeat(40), name: 'N'.repeat(80) })], days)[0]
  check('the creator\'s text is cut to a label', long.symbol.length === 15 && long.name.length === 32)
}

console.log('when the block may say sealed')
check('a confirmed, witnessed Base mirror of this very hash is a seal', JSON.stringify(SEAL.sealOf(mirror(), HASH)) === JSON.stringify({ tx: TX, block: 57565332, sent_at: '2026-11-15T00:44:01.636Z' }))
check('a mirror that is in a block but not witnessed is not', SEAL.sealOf(mirror({ status: 'in-block-unwitnessed' }), HASH) === null && SEAL.sealOf(mirror({ status: 'pending' }), HASH) === null)
check('...nor one called confirmed with nobody named as witness', SEAL.sealOf(mirror({ witnessed_by: [] }), HASH) === null && SEAL.sealOf(mirror({ witnessed_by: undefined }), HASH) === null)
check('a mirror of other bytes is not a seal of these', SEAL.sealOf(mirror({ sha256: sha('other') }), HASH) === null && SEAL.sealOf(mirror({}, { sha256: sha('other') }), HASH) === null && SEAL.sealOf(mirror(), sha('other')) === null)
check('only the Base entry counts, and only with a transaction hash', SEAL.sealOf({ sha256: HASH, mirrors: [mirror().mirrors[0]] }, HASH) === null && SEAL.sealOf(mirror({ tx: '0x12' }), HASH) === null)
check('the Robinhood Chain mirror is read by the same rule, and linked only when it holds', JSON.stringify(SEAL.sealOf(mirror(), HASH, 'robinhood')) === JSON.stringify({ tx: '0x' + 'cd'.repeat(32), block: null, sent_at: '' }) && SEAL.sealOf({ sha256: HASH, mirrors: [mirror().mirrors[1]] }, HASH, 'robinhood') === null && js.includes("const robinhood = SEAL.sealOf(mirror, hash, 'robinhood')") && js.includes('if (robinhood) {') && /id="seal-wire-rh"[^>]* hidden>/.test(html))
check('a day is sealed when its manifest was built, not when a mirror copied it later', SEAL.sealedAt(manifest.replace('"previous"', '"built_at": "2026-11-15T00:24:39.966Z", "previous"'), DAY, '2026-11-16T09:08:22Z') === '2026-11-15T00:24:39.966Z' && js.includes('dayOf(sealed)') && js.includes('SEAL.sealedAt(new TextDecoder().decode(bytes), c.day, seal.sent_at)'))
check('...and a manifest with no date, or one dated inside its own day, falls back to the mirror', SEAL.sealedAt(manifest, DAY, 'M') === 'M' && SEAL.sealedAt('not json', DAY, 'M') === 'M' && SEAL.sealedAt(JSON.stringify({ built_at: DAY + 'T12:00:00Z' }), DAY, 'M') === 'M')
check('no mirror record is no seal', SEAL.sealOf(null, HASH) === null && SEAL.sealOf({}, HASH) === null && SEAL.sealOf(mirror(), '') === null)
check('the Bitcoin block is named only when a check names one', SEAL.bitcoinOf({ checks: [{ height: 975864 }] }) === 975864 && SEAL.bitcoinOf({ checks: [] }) === null && SEAL.bitcoinOf(null) === null && SEAL.bitcoinOf({ checks: [{ height: '975864' }] }) === null)

console.log('what the block says goes on the chain')
{
  const { anchorCalldata } = await import('../scripts/stocks/anchor-mirror.mjs')
  const sent = Buffer.from(anchorCalldata(DAY, HASH).slice(2), 'hex').toString('ascii')
  check('the line shown is, letter for letter, the one the Base transaction carries', SEAL.wireLine(DAY, HASH) === sent, SEAL.wireLine(DAY, HASH))
  check('...and nothing is shown for a day or a hash that is not one', SEAL.wireLine('yesterday', HASH) === null && SEAL.wireLine(DAY, 'zz') === null && SEAL.wireLine(DAY, HASH.toUpperCase()) === null)
  check('the page shows the line for the hash this browser computed, and links that day\'s transaction', js.includes("$('seal-wire-line').textContent = SEAL.wireLine(c.day, hash)") && js.includes("'https://basescan.org/tx/' + seal.tx") && /id="seal-wire-line"/.test(html) && /id="seal-wire-tx"/.test(html))
}

console.log('what a rewrite does')
{
  check('the browser hash of the untouched manifest is the anchored one', await SEAL.sha256Hex(manifest) === HASH && await SEAL.sha256Hex(new TextEncoder().encode(manifest)) === HASH)
  const after = await SEAL.rewrite(manifest)
  const a = JSON.parse(after), b = JSON.parse(manifest)
  check('a rewrite changes the hash of the day\'s Base cases file and of no other file', a.files[1].sha256 !== b.files[1].sha256 && a.files[0].sha256 === b.files[0].sha256 && a.files[2].sha256 === b.files[2].sha256)
  const other = await SEAL.sha256Hex(after)
  check('...and then the seal no longer fits: most of the 64 squares differ', other !== HASH && SEAL.differ(other, HASH) >= 40, String(SEAL.differ(other, HASH)))
  check('differ counts squares, and none for the same hash', SEAL.differ(HASH, HASH) === 0)
  check('a manifest that cannot be read gives no rewrite to show', await SEAL.rewrite('not json') === null && await SEAL.rewrite('{"files":[]}') === null && await SEAL.rewrite('{"files":[{"chain":"base","file":"x","sha256":"zz"}]}') === null)
  check('sixteen digits, sixteen colours', new Set([...'0123456789abcdef'].map(SEAL.colour)).size === 16)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log(failures.join('\n')); process.exit(1) }
