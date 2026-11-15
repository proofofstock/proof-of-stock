// apps/stocks-exam.mjs: the public exam's latest result, for GET /api/exam, the status bar chip and the `exam` command.
//
// Once a day the public repository runs scripts/exam.mjs against the site and commits the report to its `exam` branch.
// This reads that report, at most once every EXAM_EVERY_MS, in the background (never on a request), and keeps a
// SUMMARY in memory: the day, the set's counts and hash, the metrics as numbers, failures_total. Nothing else from the
// report is kept, so no text from GitHub ever reaches a response: every field is a number, a boolean, or a string
// checked against a strict pattern, and the links are built here from constants.
//
// ⚠ NEVER A STALE RESULT AS FRESH. A report older than EXAM_MAX_AGE_MS is not shown; a failed read drops the copy.

export const EXAM_REPO = 'https://github.com/proofofstock/proof-of-stock'
export const EXAM_REPORTS_URL = EXAM_REPO + '/tree/exam'
export const EXAM_RAW_URL = 'https://raw.githubusercontent.com/proofofstock/proof-of-stock/exam/reports/latest.json'
export const EXAM_EVERY_MS = 30 * 60e3
export const EXAM_MAX_AGE_MS = 36 * 3600e3
export const EXAM_MAX_BYTES = 256 * 1024
/**
 * The chip beside Status in the footer (apps/stocks-web/index.html <!--exam-->): hidden until app.js has a fresh result
 * to fill in. It sits with the other proof links, not in the terminal status bar: the exam is not terminal state. The
 * server puts it in only while the source is public (package.json stp.source_public), like the footer's GitHub link.
 */
export const EXAM_CHIP_HTML = `<a id="exam-chip" class="foot-link exam" href="${EXAM_REPORTS_URL}" target="_blank" rel="noopener noreferrer" hidden><span class="foot-dot" aria-hidden="true"></span><span class="exam-k">Exam</span><span class="exam-s"></span></a>`
const DAY = /^\d{4}-\d{2}-\d{2}$/
const SHA = /^[0-9a-f]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

// A count: a non-negative integer below a sane ceiling, else the report is refused.
const count = (x) => (Number.isSafeInteger(x) && x >= 0 && x < 1e7 ? x : undefined)
const countOrNull = (x) => (x == null ? null : count(x))
const bool = (x) => (typeof x === 'boolean' ? x : undefined)

/**
 * The summary of one report (scripts/exam.mjs runExam's shape), or null when any field it needs is missing or not of
 * its kind. Pure; `now` decides freshness.
 */
export function summarizeExam (r, now) {
  if (!r || typeof r !== 'object' || r.version !== 1) return null
  if (typeof r.day !== 'string' || !DAY.test(r.day)) return null
  if (typeof r.finished_at !== 'string' || !ISO.test(r.finished_at)) return null
  const finished = Date.parse(r.finished_at)
  // A report from the future (beyond a little clock skew) is not one we can date: refused.
  if (!Number.isFinite(finished) || finished - now > 10 * 60e3 || r.finished_at.slice(0, 10) < r.day) return null
  const s = r.set || {}, m = r.metrics || {}
  if (typeof s.sha256 !== 'string' || !SHA.test(s.sha256)) return null
  const counts = { A: count(s.counts?.A), B: count(s.counts?.B), C: count(s.counts?.C), D: count(s.counts?.D) }
  const metrics = {
    asked: count(m.asked), false_listed: count(m.false_listed), false_not_listed: count(m.false_not_listed), real_called_fake: count(m.real_called_fake),
    lookalikes: count(m.lookalikes), lookalikes_caught: count(m.lookalikes_caught), minted_wrong: count(m.minted_wrong), refused: count(m.refused),
    list_proof: { base: bool(m.list_proof?.base?.match), robinhood: bool(m.list_proof?.robinhood?.match) },
    price_evidence: { tried: count(m.price_evidence?.tried), onchain: count(m.price_evidence?.onchain), same_bytes: count(m.price_evidence?.same_bytes), none: count(m.price_evidence?.none) },
    verify_ms: { p50: countOrNull(m.verify_ms?.p50), p95: countOrNull(m.verify_ms?.p95) },
  }
  const failures = count(r.failures_total)
  const flat = [...Object.values(counts), ...Object.values(metrics).flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : [v])), failures]
  if (flat.some((v) => v === undefined)) return null
  const total = counts.A + counts.B + counts.C + counts.D
  return {
    day: r.day, finished_at: new Date(finished).toISOString(), age_s: Math.max(0, Math.round((now - finished) / 1000)),
    // A conservative score: every refusal and every failure (a price replay too) counts against a token.
    total, passed: Math.max(0, total - metrics.refused - failures), failures_total: failures,
    set: { counts, sha256: s.sha256 },
    metrics,
    report_url: EXAM_REPORTS_URL, report_day_url: `${EXAM_REPO}/blob/exam/reports/${r.day}.md`, rerun: 'node scripts/exam.mjs', repo: EXAM_REPO,
  }
}

/** A response body as text, refused past `max` bytes without reading the rest. */
async function readCapped (res, max) {
  const len = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(len) && len > max) throw new Error(`exam report too large (${len} bytes)`)
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader(), chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) { reader.cancel().catch(() => {}); throw new Error('exam report too large') }
      chunks.push(value)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  }
  const t = await res.text()
  if (Buffer.byteLength(t) > max) throw new Error('exam report too large')
  return t
}

/**
 * The cache: refresh() reads the report when the last attempt is EXAM_EVERY_MS old (or `force`); get() answers from
 * memory. url null turns it off.
 */
export function createExamCache ({ fetchImpl = fetch, now = () => Date.now(), url = EXAM_RAW_URL, everyMs = EXAM_EVERY_MS, maxAgeMs = EXAM_MAX_AGE_MS, maxBytes = EXAM_MAX_BYTES, log = () => {} } = {}) {
  let report = null // the summary's source fields, as parsed and checked
  let tried = -Infinity, inFlight = null
  async function load () {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'proofofstock-site' } })
      if (res.status !== 200) throw new Error(`exam report HTTP ${res.status}`)
      const body = JSON.parse(await readCapped(res, maxBytes))
      if (!summarizeExam(body, now())) throw new Error('exam report not of the expected shape')
      // Only what summarizeExam reads is kept; the failures list and everything else is dropped here.
      const { version, day, finished_at, set, metrics, failures_total } = body
      report = { version, day, finished_at, set: { counts: set.counts, sha256: set.sha256 }, metrics: { ...metrics }, failures_total }
    } catch (e) {
      report = null
      log(`[exam] ${String(e && e.message || e).slice(0, 200)}`)
    }
  }
  return {
    refresh (force = false) {
      if (!url) return Promise.resolve()
      if (inFlight) return inFlight
      if (!force && now() - tried < everyMs) return Promise.resolve()
      tried = now()
      inFlight = load().finally(() => { inFlight = null })
      return inFlight
    },
    /** { status, body }: 200 with the summary, or 503 with a plain sentence. */
    get () {
      const s = report && summarizeExam(report, now())
      if (!s) return { status: 503, body: { error: 'the latest exam report could not be read', reports: EXAM_REPORTS_URL } }
      if (now() - Date.parse(s.finished_at) > maxAgeMs) return { status: 503, body: { error: 'no exam report from the last 36 hours', reports: EXAM_REPORTS_URL } }
      return { status: 200, body: s }
    },
  }
}
