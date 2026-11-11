v0.3.0 · updated 2026-11-10

# Connect an agent and read your first passport

In five minutes you will connect an AI agent to the public Stock Token Passport server and read the passport of one
real tokenized stock: `SNDKc`, a Coinbase-listed token on Base.

The server is public, read-only and needs no key:

```
https://proofofstock.xyz/mcp
```

Pick one client in step 1. Step 2 is the same for all of them.

## Step 1: connect

### Claude (claude.ai or the desktop app)

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Name it `Stock Token Passport` and paste `https://proofofstock.xyz/mcp` as the URL.
4. Save. In a new chat, turn the connector on.

### Claude Code

```bash
claude mcp add --transport http stock-passport https://proofofstock.xyz/mcp
```

Check that it is there:

```bash
claude mcp list
```

### Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "stock-passport": { "url": "https://proofofstock.xyz/mcp" }
  }
}
```

Restart Cursor, or reload the MCP servers from its settings.

### Raw JSON-RPC with curl

The server speaks MCP over Streamable HTTP, stateless: one JSON-RPC message per POST, no session, no event stream.
You need `curl` and, to read the answers comfortably, `jq`.

Open the connection:

```bash
curl -s https://proofofstock.xyz/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"tutorial","version":"0"}}}' | jq .result.serverInfo
```

You should see the server's name, `stock-token-passport`.

List the tools:

```bash
curl -s https://proofofstock.xyz/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq -r '.result.tools[].name'
```

You should see six names: `find_stock_token`, `list_stock_tokens`, `stock_passport`, `verify_stock_tokens`,
`recent_impostors` and `compare_venues`. Each is described in [the tools reference](../reference/tools.md).

## Step 2: ask for a passport

In Claude, Claude Code or Cursor, ask:

> Is `0xb200000000000000000000397293cb8cda9a10c5` on Base an issuer-listed stock token? Use the stock passport.

The agent calls `stock_passport`. With curl, make the same call yourself:

```bash
curl -s https://proofofstock.xyz/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stock_passport","arguments":{"chain":"base","address":"0xb200000000000000000000397293cb8cda9a10c5"}}}' \
  > passport.json

jq -r '.result.content[0].text' passport.json
```

The first line of every answer is one plain sentence. It looks like this (the values here are illustrative):

```
ISSUER-LISTED: SNDKc on Base is in the Coinbase registry. Issuer reference $… per token, 40 h old. Deepest on-chain
price $…, +0.42% against the reference, read 6 min ago. Notes: reference_held_market_closed.
```

The full passport is in `structuredContent`, and again as JSON in the second content block.

## Step 3: read the answer

Take the fields one at a time.

**1. Is it listed?**

```bash
jq '.result.structuredContent | {in_registry, issuer: .issuer.name, symbol: .issuer.symbol}' passport.json
```

`in_registry: true` means this exact address is on Coinbase's registry for Base. That is the only thing that decides
it. Try the calibration impostor `0x35b76a8fbfbac68c449a4a4a8d1bcda0d486f703`, which also calls itself `SNDKc`: you
get `in_registry: false` and a `resembles` block pointing at the listed address.

**2. The premium is a fraction.**

```bash
jq '.result.structuredContent.latest | {premium, premium_refused, dex_price_usd, age_s}' passport.json
```

`premium: 0.0042` means the deepest eligible pool trades 0.42% above the issuer's reference. A negative value means
below. When `premium` is null, `premium_refused` names the reason, for example `no_eligible_pool`. `latest.age_s` is
how many seconds ago the recorder took that reading. Readings are taken every 15 minutes, so this is not a live quote.

**3. Check the reference's age before you trust the premium.**

```bash
jq '.result.structuredContent | {reference: .reference | {kind, price_usd, age_s}, market: .market_now.session, at_ref: .latest.premium_at_reference_time}' passport.json
```

- `reference.age_s` is how old the issuer's price is, in seconds, at the time of your request.
- `market_now.session` is the US equity session right now: `regular`, `pre`, `post`, `closed` or `unknown`.
- A reference hours old while the market is `closed` is normal. The issuer holds its price until the market reopens.
- `latest.premium_at_reference_time` is the reading taken just after the reference last moved, so both prices
  belong to one moment: `{ observed_at, premium, lag_s }`, where `lag_s` is how long after the move it was taken. Use
  its `premium` when the reference is old. It is `null` when no priced reading falls within 30 minutes after that move
  inside the window you asked for.

**4. Read the notes.**

```bash
jq '.result.structuredContent.notes' passport.json
```

Every gap is named here instead of being filled in. Common ones:

| Note | Meaning |
|---|---|
| `reference_held_market_closed` | the market is closed and the reference is held; expected |
| `reference_held_market_open` | the market is open but the reference is over 30 minutes old |
| `reading_stale` | our last reading is over 30 minutes old |
| `no_dex_price` | no pool could price the token |
| `pools_capped` | the pool count is a minimum; the sources may hold more |
| `not_minted` | listed by the issuer but not minted on this chain yet |

The whole list is in [the passport reference](../reference/passport.md).

## What you have now

An agent that can check whether a token is issuer-listed and how far its on-chain price sits from the issuer's
reference, with the age of each number. Next:

- [Check a contract before listing or buying it](../how-to/check-before-listing.md)
- [Alert when the gap is wide](../how-to/alert-on-gap.md)
- [Compare one stock across Base and Robinhood Chain](../how-to/compare-venues.md)
- [Why the numbers are computed the way they are](../explanation/methodology.md)

The server allows 60 requests per minute per client; a passport costs 3 of them. Over that it answers 429; wait a minute.

[Not investment advice](../legal.md)
