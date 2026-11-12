v0.5.0 · updated 2026-11-11

# Alert when the on-chain price drifts from the issuer's reference

Use this when you want to know that a tokenized stock's deepest pool trades more than 0.5% away from its issuer's
reference, while the US market is open and the reference is fresh.

This is a monitoring recipe. A gap is a fact about two prices at two times. It is not a trading signal and not advice.

## The rule

Alert on a token when all of these hold:

1. `|premium| > 0.005` (`premium` is a fraction: 0.005 is 0.5%);
2. the US market is in its regular session (`market_now.session === "regular"`);
3. the reference is at most 30 minutes old, measured now;
4. the reading itself is current (the overview already drops readings older than 30 minutes);
5. trading is not halted.

Why the market and freshness conditions: outside the regular session the issuer's reference holds still, and the pool
drifts against a held price. A gap then is expected and says little. While the market is open, a reference older than
30 minutes is the passport's own line for `reference_held_market_open`. See
[the methodology](../explanation/methodology.md#why-us-market-sessions-matter).

## Option A: poll `/api/overview` (all tokens, one request)

`GET https://proofofstock.xyz/api/overview` returns, per chain, the tokens with a current premium, furthest from their
reference first, at most 12 per chain. Each row has `premium`, `observed_at`, `reference_age_s` and `halted`.

`reference_age_s` is the reference's age now, in seconds. `observed_at` is when our reading was taken; readings are
recorded every 15 minutes.

Save as `gap-alert.mjs` and run `node gap-alert.mjs` (Node 18 or later):

```js
// gap-alert.mjs: print an alert when |premium| > 0.5% while the market is open and the reference is fresh.
const SITE = 'https://proofofstock.xyz'
const THRESHOLD = 0.005            // a fraction: 0.5%
const MAX_REFERENCE_AGE_S = 1800   // 30 min, the passport's reference_held_market_open line
const POLL_MS = 15 * 60e3          // the recorder writes every 15 min; polling faster finds nothing new

const alerted = new Set()          // chain:address already alerted, until it falls back under the threshold

async function check () {
  const r = await fetch(`${SITE}/api/overview`, { headers: { accept: 'application/json' } })
  if (!r.ok) { console.warn(`overview answered ${r.status}; trying again next poll`); return }
  const o = await r.json()
  if (o.market_now.session !== 'regular') { alerted.clear(); return }

  const now = Date.now()
  for (const [chain, c] of Object.entries(o.chains)) {
    for (const row of c.rows) {
      const key = `${chain}:${row.address}`
      const refAgeS = row.reference_age_s
      const readingAgeS = Math.round((now - Date.parse(row.observed_at)) / 1000)
      const fresh = refAgeS != null && refAgeS <= MAX_REFERENCE_AGE_S
      const wide = Math.abs(row.premium) > THRESHOLD

      if (wide && fresh && row.halted !== true) {
        if (alerted.has(key)) continue
        alerted.add(key)
        console.log(`[${new Date(now).toISOString()}] ${chain} ${row.symbol} ${(row.premium * 100).toFixed(2)}% ` +
          `vs reference (reference ${Math.round(refAgeS / 60)} min old, reading ${Math.round(readingAgeS / 60)} min old) ` +
          `https://proofofstock.xyz/?chain=${chain}&address=${row.address}`)
      } else if (!wide) {
        alerted.delete(key)
      }
    }
    // Rows are sorted by |premium| and capped at 12: if the last one is still wide, there may be more beyond it.
    const last = c.rows[c.rows.length - 1]
    if (last && Math.abs(last.premium) > THRESHOLD && c.priced > c.rows.length) {
      console.warn(`${chain}: more than ${c.rows.length} tokens may be over the threshold; check them with stock_passport`)
    }
  }
}

await check()
setInterval(() => check().catch((e) => console.warn(String(e))), POLL_MS)
```

Replace `console.log` with whatever delivers your alerts.

## Option B: watch a few tokens with `stock_passport`

When you care about specific tokens, the passport gives the same facts with the reference age already measured now.

```js
async function passport (chain, address) {
  const r = await fetch('https://proofofstock.xyz/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'stock_passport', arguments: { chain, address } } }),
  })
  const res = (await r.json()).result
  if (res.isError) throw new Error(res.content[0].text)
  return res.structuredContent
}

const p = await passport('base', '0xb200000000000000000000397293cb8cda9a10c5')
const alert = p.in_registry
  && p.market_now.session === 'regular'
  && p.latest?.premium != null && Math.abs(p.latest.premium) > 0.005
  && p.reference?.age_s != null && p.reference.age_s <= 1800
  && !p.notes.includes('reading_stale')
  && !p.notes.includes('trading_halted')
console.log(alert ? `ALERT ${p.summary}` : 'no alert')
```

`p.summary` is the passport's lead sentence.

## Mind the limits

- 60 units in any 60 seconds per client, shared by every route (a passport is 3). One overview poll every 15 minutes is far below it. For
  Option B, one passport per token per poll adds up: stay under 60 units in any 60 seconds, or use Option A.
- A 429 or a 503 is not a quiet market. The script above logs it and waits for the next poll.
- Readings are every 15 minutes. An alert can arrive up to about 20 minutes after the gap opened.

[Not investment advice](../legal.md)
