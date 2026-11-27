// apps/stocks-agent-test.mjs: the agent test's routes and store (docs/agent-test-tz.md v3, §2 and §5).
//
// The pure core is evm/core/stocks/agent-test.mjs; this file is the server half: secrets, the disk, the limits, and the
// four API routes. apps/stocks-web.mjs calls handle() for every path under /api/agent-test and gives it what only it
// knows (the frozen issuer lists, the held records, the published look-alikes).
//
// The store (TZ §5.2), under `dir`:
//   lists/<sha256>              one frozen issuer list, stored once whoever froze it
//   <test_id>.json              the record, written at the start (temp + rename)
//   <test_id>.graded.json       the receipt, published by link(): one wins, none is half-written
//   <test_id>.hidden            hidden by its key holder (or listed in the host's hidden file)
// ⚠ No IP, user agent or header is ever written (TZ §5.3). The retake count is a number; the client key stays in memory.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  newSecrets, TEST_ID, keyHash, freezeInputs, drawTasks, commitTasks, publicTasks, checkLabel, checkAnswers,
  gradeAgentTest, buildReceipt, jcs, ANSWER_WINDOW_MS, CHAINS,
} from '../evm/core/stocks/agent-test.mjs'

export const STARTS_PER_HOUR = 6
export const ANSWERS_PER_MINUTE = 20
export const UNGRADED_GRACE_MS = 60 * 60e3 // an ungraded record is deleted an hour after its window
export const NOT_PASSED_KEEP_MS = 90 * 86400e3
export const RETAKE_WINDOW_MS = 24 * 3600e3
export const MAX_BODY = 8 * 1024
export const DEFAULT_MAX_MB = 512

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const KEY_FORM = /^ak_[0-9a-f]{64}$/
const keyOk = (body, record) => typeof body?.answer_key === 'string' && KEY_FORM.test(body.answer_key) && keyHash(body.answer_key) === record.key_hash

/**
 * @param dir        the store's directory
 * @param now        the clock
 * @param origin     the public origin written into receipts
 * @param inputsFor  () => { lists, held, lookalikes, pairTokens } or null when either registry is not fresh
 * @param companies  the parsed agent-test-companies.json
 * @param hiddenFile a host file of hidden test ids, one per line (abuse)
 */
export function createAgentTest ({ dir, now = () => Date.now(), origin, inputsFor, companies, companiesRaw = JSON.stringify(companies), hiddenFile = null, maxMb = DEFAULT_MAX_MB, randomBytes = crypto.randomBytes, log = () => {} }) {
  const companiesSha256 = sha256(companiesRaw)
  const listsDir = path.join(dir, 'lists')
  const starts = new Map() // client key → [start times], last RETAKE_WINDOW_MS
  const answerHits = new Map() // test id → [times], last minute
  let usage = null, usageAt = 0

  const ensure = () => fs.mkdirSync(listsDir, { recursive: true })
  const recPath = (id) => path.join(dir, id + '.json')
  const gradedPath = (id) => path.join(dir, id + '.graded.json')
  const hiddenPath = (id) => path.join(dir, id + '.hidden')

  function writeAtomic (file, body) {
    const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp'
    const fd = fs.openSync(tmp, 'w')
    try { fs.writeSync(fd, body); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, file)
  }
  function diskUsage () {
    if (usage != null && now() - usageAt < 60e3) return usage
    let n = 0
    const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { n += fs.statSync(p).size } catch {} } }
    walk(dir); usage = n; usageAt = now()
    return n
  }
  let hiddenCache = { mtime: -1, ids: new Set() }
  function hostHidden (id) {
    if (!hiddenFile) return false
    try {
      const m = fs.statSync(hiddenFile).mtimeMs
      if (m !== hiddenCache.mtime) hiddenCache = { mtime: m, ids: new Set(fs.readFileSync(hiddenFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) }
      return hiddenCache.ids.has(id)
    } catch { return false }
  }
  const isHidden = (id) => fs.existsSync(hiddenPath(id)) || hostHidden(id)

  // Lists are stored once by the hash of their bytes; a record names them.
  function storeLists (inputs) {
    const refs = {}
    for (const c of CHAINS) {
      const body = JSON.stringify(inputs.lists[c]) // as frozen, key order kept: registry_hash is over JSON.stringify
      const h = sha256(body)
      const f = path.join(listsDir, h)
      if (!fs.existsSync(f)) writeAtomic(f, body)
      refs[c] = h
    }
    return { ...inputs, lists: refs }
  }
  function loadLists (inputs) {
    const lists = {}
    for (const c of CHAINS) {
      const body = fs.readFileSync(path.join(listsDir, inputs.lists[c]), 'utf8')
      if (sha256(body) !== inputs.lists[c]) throw new Error('agent-test: a stored list does not match its name')
      lists[c] = JSON.parse(body)
    }
    return { ...inputs, lists }
  }
  function readRawRecord (id) {
    try { return JSON.parse(fs.readFileSync(recPath(id), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  }
  // The graded file is the receipt with its two lists by reference (outside review: full lists in every receipt let a
  // flood of grades fill the disk). assemble() puts them back in place; JSON.stringify keeps every key where it was, so
  // the bytes are the receipt's, and receipt_sha256 holds over them.
  const readCompact = (id) => { try { return JSON.parse(fs.readFileSync(gradedPath(id), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
  const assemble = (compact) => JSON.stringify({ ...compact, inputs: loadLists(compact.inputs) })
  const readGraded = (id) => { const c = readCompact(id); return c ? Buffer.from(assemble(c)) : null }

  let lastSweep = -Infinity
  // Over the cap, a request may sweep once every five minutes; otherwise it answers 503 without walking the store.
  function overCap () {
    if (diskUsage() <= maxMb * 1024 * 1024) return false
    if (now() - lastSweep > 5 * 60e3) { lastSweep = now(); sweep() }
    return diskUsage() > maxMb * 1024 * 1024
  }

  function countRetakes (key) {
    const t = now(), xs = (starts.get(key) || []).filter((x) => t - x < RETAKE_WINDOW_MS)
    return xs
  }

  /** POST /api/agent-test */
  function start (body, key) {
    const t = now()
    const recent = countRetakes(key)
    if (recent.filter((x) => t - x < 3600e3).length >= STARTS_PER_HOUR) return [429, { error: `at most ${STARTS_PER_HOUR} tests an hour from one client` }, { 'retry-after': '600' }]
    const lab = checkLabel(body?.label)
    if (!lab.ok) return [400, { error: lab.error }]
    const src = inputsFor()
    if (!src) return [503, { error: 'an issuer list is not fresh right now; no test can be graded fairly. Try again in a few minutes.' }]
    if (overCap()) { log('[agent-test] disk cap reached'); return [503, { error: 'the test store is full right now; try again later' }] }
    const sec = newSecrets(randomBytes)
    const inputs = freezeInputs({ ...src, companies, companiesSha256, nonce: sec.nonce })
    let tasks
    try { tasks = drawTasks(sec.nonce, inputs) } catch (e) {
      if (e.code === 'no_material') return [503, { error: 'not enough material for a fair test now; try again later' }]
      throw e
    }
    ensure()
    const record = {
      test_id: sec.test_id, started_at: new Date(t).toISOString(), expires_at: new Date(t + ANSWER_WINDOW_MS).toISOString(),
      key_hash: keyHash(sec.answer_key), label: lab.label, retake_count: recent.length + 1,
      nonce: sec.nonce, tasks, tasks_sha256: commitTasks(sec.nonce, inputs, tasks), inputs: storeLists(inputs),
    }
    const body2 = JSON.stringify(record)
    writeAtomic(recPath(sec.test_id), body2)
    usage = (usage ?? 0) + body2.length
    starts.set(key, [...recent, t])
    return [201, {
      test_id: record.test_id, answer_key: sec.answer_key, expires_at: record.expires_at, tasks_sha256: record.tasks_sha256,
      list_proof: Object.fromEntries(CHAINS.map((c) => [c, inputs.lists[c].registry_hash])),
      tasks: publicTasks(tasks),
      how_to_answer: `POST ${origin}/api/agent-test/${record.test_id}/answers with {"answer_key": "...", "answers": [{"n": 1, "address": "0x..."}, {"n": 2, "refuse": true}, ...]}`,
    }]
  }

  const answerResponse = (r) => {
    return { passed: r.grade.passed, right: r.grade.right, of: r.grade.of, sentences: r.grade.sentences, result_url: `${origin}/agent-test/${r.test_id}` }
  }

  /** POST /api/agent-test/<id>/answers */
  function answer (id, body, client = 'anon') {
    const t = now()
    const hits = (answerHits.get(client) || []).filter((x) => t - x < 60e3)
    if (hits.length >= ANSWERS_PER_MINUTE) return [429, { error: 'too many answers from this client in a minute' }]
    answerHits.set(client, [...hits, t])
    if (isHidden(id)) return [410, { error: 'gone' }]
    const raw = readRawRecord(id)
    if (!raw) return [404, { error: 'no such test' }]
    if (!keyOk(body, raw)) return [403, { error: 'wrong answer_key' }]
    const prior = readCompact(id)
    if (prior) return [200, answerResponse(prior)] // a lost response, fetched again: the first grade, unchanged
    if (t > Date.parse(raw.expires_at)) return [410, { error: 'the answer window has closed' }]
    const chk = checkAnswers(body?.answers)
    if (!chk.ok) return [400, { error: chk.error }] // the attempt is not used
    const full = { ...raw, inputs: loadLists(raw.inputs), answered_at: new Date(t).toISOString() }
    const grade = gradeAgentTest(full, chk.answers)
    if (overCap()) return [503, { error: 'the test store is full right now; try again later' }] // attempt unused
    const receipt = buildReceipt({ origin, record: full, answers: chk.answers, grade })
    const compact = { ...receipt, inputs: { ...receipt.inputs, lists: Object.fromEntries(CHAINS.map((c) => [c, sha256(JSON.stringify(receipt.inputs.lists[c]))])) } }
    const buf = Buffer.from(JSON.stringify(compact))
    const tmp = gradedPath(id) + '.' + randomBytes(6).toString('hex') + '.tmp'
    const fd = fs.openSync(tmp, 'w')
    try { fs.writeSync(fd, buf); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    try { fs.linkSync(tmp, gradedPath(id)) } catch (e) {
      fs.rmSync(tmp, { force: true })
      if (e.code === 'EEXIST') return [200, answerResponse(readCompact(id))] // a parallel submission won
      throw e
    }
    fs.rmSync(tmp, { force: true })
    usage = (usage ?? 0) + buf.length
    return [200, answerResponse(compact)]
  }

  /** GET /api/agent-test/<id>: TZ §2.4. Returns [status, body, raw?] where raw means "send these bytes as they are". */
  function read (id) {
    if (isHidden(id)) return [410, { error: 'gone' }]
    const g = readGraded(id)
    if (g) return [200, g, true]
    let raw
    try { raw = fs.readFileSync(recPath(id), 'utf8') } catch (e) { if (e.code === 'ENOENT') return [404, { error: 'no such test' }]; throw e }
    const r = JSON.parse(raw)
    if (now() > Date.parse(r.expires_at)) return [410, { error: 'the answer window has closed' }]
    return [200, { test_id: r.test_id, started_at: r.started_at, expires_at: r.expires_at, tasks_sha256: r.tasks_sha256, tasks: publicTasks(r.tasks) }]
  }

  /** POST /api/agent-test/<id>/hide: only the key's holder. */
  function hide (id, body, client = 'anon') {
    const t = now(), hits = (answerHits.get(client) || []).filter((x) => t - x < 60e3)
    if (hits.length >= ANSWERS_PER_MINUTE) return [429, { error: 'too many requests from this client in a minute' }]
    answerHits.set(client, [...hits, t])
    let raw
    try { raw = fs.readFileSync(recPath(id), 'utf8') } catch (e) { if (e.code === 'ENOENT') return [404, { error: 'no such test' }]; throw e }
    if (!keyOk(body, JSON.parse(raw))) return [403, { error: 'wrong answer_key' }]
    fs.writeFileSync(hiddenPath(id), '')
    return [200, { hidden: true }]
  }

  /** The graded receipt for the result page and the badge, or { status }. */
  function result (id) {
    if (!TEST_ID.test(id)) return { status: 404 }
    if (isHidden(id)) return { status: 410 }
    const g = readGraded(id)
    // An orphan receipt (its record deleted by a sweep that stopped halfway) is never served.
    if (!fs.existsSync(recPath(id))) return { status: 404 }
    return g ? { status: 200, receipt: JSON.parse(g) } : { status: 404 }
  }

  /** Retention (TZ §5.2): ungraded an hour after the window, Not passed after 90 days, stray temp files, orphan lists. */
  function sweep () {
    const t = now()
    let names = []
    try { names = fs.readdirSync(dir) } catch { return { deleted: 0 } }
    let deleted = 0
    const del = (f) => { try { fs.rmSync(path.join(dir, f), { force: true }); deleted++ } catch {} }
    const keepLists = new Set()
    for (const f of names) {
      if (f.endsWith('.tmp')) { try { if (t - fs.statSync(path.join(dir, f)).mtimeMs > 60e3) del(f) } catch {} continue }
      const m = /^(at_[0-9a-f]{32})\.json$/.exec(f)
      if (!m) continue
      const id = m[1]
      let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { log(`[agent-test] sweep: unreadable ${f}`); continue }
      let g; try { g = readCompact(id) } catch { log(`[agent-test] sweep: unreadable receipt of ${id}`); continue }
      let drop = false
      if (!g) drop = t > Date.parse(r.expires_at) + UNGRADED_GRACE_MS
      else drop = !g.grade?.passed && t - Date.parse(g.answered_at) > NOT_PASSED_KEEP_MS
      if (drop) { if (g) del(id + '.graded.json'); del(f); del(id + '.hidden') } else {
        for (const c of CHAINS) keepLists.add(r.inputs.lists[c])
        if (g && g.inputs?.lists) for (const c of CHAINS) keepLists.add(g.inputs.lists[c])
      }
    }
    for (const f of names) { const m = /^(at_[0-9a-f]{32})\.graded\.json$/.exec(f); if (m && !names.includes(m[1] + '.json')) del(f) }
    for (const [k, xs] of answerHits) if (!xs.some((x) => t - x < 60e3)) answerHits.delete(k)
    for (const [k, xs] of starts) if (!xs.some((x) => t - x < RETAKE_WINDOW_MS)) starts.delete(k)
    let lists = []
    try { lists = fs.readdirSync(listsDir) } catch {}
    for (const h of lists) if (!keepLists.has(h)) { try { fs.rmSync(path.join(listsDir, h), { force: true }); deleted++ } catch {} }
    usage = null
    return { deleted }
  }

  /**
   * Route one request under /api/agent-test. `sub` is the path after the base path. Returns [status, body, extra, raw]
   * or null when the path is not ours.
   */
  async function handle (method, sub, readBody, key) {
    const m = /^\/api\/agent-test(?:\/([^/]+)(?:\/(answers|hide))?)?$/.exec(sub)
    if (!m) return null
    const [, id, action] = m
    if (id && !TEST_ID.test(id)) return [404, { error: 'no such test' }]
    const wantPost = !id || action
    if (wantPost && method !== 'POST') return [405, { error: 'method not allowed' }, { allow: 'POST' }]
    if (!wantPost && method !== 'GET' && method !== 'HEAD') return [405, { error: 'method not allowed' }, { allow: 'GET, HEAD' }]
    if (!wantPost) { const [s, b, raw] = read(id); return [s, b, { 'cache-control': 'no-store' }, raw] }
    const parsed = await readBody()
    if (parsed.error) return [parsed.status, { error: parsed.error }]
    const [s, b, extra] = !id ? start(parsed.json, key) : action === 'answers' ? answer(id, parsed.json, key) : hide(id, parsed.json, key)
    return [s, b, { 'cache-control': 'no-store', ...(extra || {}) }]
  }

  return { handle, start, answer, read, hide, result, sweep, diskUsage }
}

/** Read a JSON body for the agent-test routes: application/json only, at most `max` bytes (MAX_BODY; /api/simulate 1 KB). */
export async function readJsonBody (req, max = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const c of req) { size += c.length; if (size > max) return { status: 413, error: 'request too large' }; chunks.push(c) }
  const raw = Buffer.concat(chunks).toString('utf8')
  // No body at all: a start without a label, so `curl -X POST <url>` works in bash, cmd and PowerShell alike (27.11).
  if (!raw.trim()) return { json: {} }
  if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return { status: 415, error: "a body must be JSON and say so: add -H 'content-type: application/json'" }
  try { return { json: JSON.parse(raw) } } catch { return { status: 400, error: 'the body is not JSON. In PowerShell, build it with ConvertTo-Json (see /agent-test); in a POSIX shell, wrap it in single quotes' } }
}
