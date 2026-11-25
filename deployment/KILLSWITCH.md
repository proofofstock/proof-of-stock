# The kill switch (Cloudflare Worker)

**What it is.** A Cloudflare Worker in front of the verdict routes. It stands outside our host, so a host that was
broken into cannot switch it off.

**What it does.**
- Once a minute it compares the list our server decides against with each issuer's own list, read straight from the
  issuer.
- If our server would let an agent buy something the issuer does not list, on two runs in a row for the same chain,
  it trips.
- While tripped, every verdict route answers `503`, and the guard does not buy on a `503`.
- It never re-arms itself.

Code: `deployment/cloudflare/killswitch/`. `logic.mjs` holds the rule, `worker.mjs` the wiring, and
`killswitch.test.mjs` the cases. It was revised after an outside review on 25.11.

## What trips it, and what never does

**Trips it** (two runs in a row on the same chain; a run that compared nothing leaves the count as it was):
- **Not on the issuer's list:** an address we call listed that the issuer does not list now, did not list at any read
  in the last 20 minutes, and has been on our list for 20 minutes or longer.
- **No issuer prefix:** on Base, an address we call listed without the pinned prefix `0xb200000000000000000000`.
- **Proof mismatch:** our list does not hash to the `list_proof` that names it, or the proof points outside our site.
- **Look-alike listed:** the known look-alike `0x02ec…b384` answered as listed.

**Never trips it:**
- **We are behind the issuer.** The issuer lists a token we do not have yet.
- **A recent delisting.** The issuer delisted a token within the last 20 minutes.
- **A listing we saw first.** A token new on our list within the last 20 minutes: the issuer's API may not show it to
  the switch yet.
- **The issuer's API is unavailable:** down, slow, rate-limited (429), 5xx, malformed or empty. That chain is
  "unknown" for that run.
- **Our server is unavailable:** down, 5xx, or saying its own list is stale (`list_proof.stale`). That chain is
  "unknown" too.
- **The first 20 minutes after setup or a reset.**

**Alerts without tripping:**
- **Our side silent.** For 10 minutes our server has given no list to compare while the issuer answers. One alert per
  chain. This is how a server that hides from the switch is seen.
- **Store unreadable.** A run could not read its store. That run writes nothing.
- **A run failed.** A run threw an error.

## Routes it blocks

**Paths:**
- `/verify*`
- `/api/*`
- `/mcp*`
- `/badge.svg*`
- `/tokenlist.json*`

**How a path is matched.** It is matched as the origin will see it: `//verify`, `/%76erify` and `/a/../verify` are all
`/verify`. Also turn on Cloudflare's URL normalization for the zone (Rules → Settings → Normalize incoming URLs).

**Hosts:**
- `proofofstock.xyz`;
- `/mcp` on `stockofproof.xyz` and `tickerproof.xyz`, with their `www`. nginx serves `/mcp` there too; everything else
  on those hosts is a 301 to `proofofstock.xyz`.

Each zone must be in the same Cloudflare account. No header, cookie or query gets past a tripped switch.

## Limits, said plainly

- **A targeted lie.** A server that lies about one address only in `/verify`, while serving a clean list, is not seen
  here. The guard (0.3.0) catches it, because it checks the issuer itself.
- **The switch can be recognised.** Cloudflare marks every Worker subrequest with a `CF-Worker` header. A server that
  was broken into can therefore tell the switch's requests apart and answer them honestly.
  - The probe is drawn at random from the issuer's own list, so lying to everyone else means answering each address
    two ways.
  - A server that gives the switch nothing to compare is alerted on after 10 minutes.
  - Hiding is made costly, not impossible.
- **Pages are not blocked.** The home page's server-rendered preview (title and description of a token link) still
  says what it said before the trip. Only the verdict routes are blocked.
- **A broken switch lets requests through.** If its store cannot be read when a request comes, the request passes.
  A broken switch must not take the site down.

## Plan and writes

Workers KV on the free plan allows 1,000 writes a day (Cloudflare's KV limits page; check before relying on it).

**Writes are kept low:**
- the state is written only when what the decision rests on changed, or every 15 minutes;
- the trip is written once.

A quiet day is under 250 writes. Over the limit, writes fail and the switch cannot record a trip until 00:00 UTC.
Each failed run alerts, so a run of such alerts means: move to the Workers Paid plan, where KV writes are not capped
this way.

The cron trigger and the routes also need the zone to allow Workers. The free plan's Worker request quota covers the
verdict routes' traffic today; check it against `/status` before relying on it.

## Setup (the owner, once)

Everything runs in the owner's own Cloudflare account. No token or key goes into this repository.

1. `cd deployment/cloudflare/killswitch && cp wrangler.toml.example wrangler.toml`
2. `npx wrangler login` (the owner signs in).
3. `npx wrangler kv namespace create POS_KS`, then put the printed `id` into `wrangler.toml`.
4. Optional alerts: `npx wrangler secret put TG_TOKEN` and `npx wrangler secret put TG_CHAT`, using the same bot and
   chat as the other alerts.
5. Turn on URL normalization in each zone (see "Routes it blocks").
6. `npx wrangler deploy`.
7. Check after 2 or 3 minutes:
   - `npx wrangler kv key get --binding=POS_KS state --remote` shows `strikes` and `last_problems: []`;
   - `npx wrangler kv key get --binding=POS_KS trip --remote` shows nothing;
   - `/verify` still answers normally.

The first 20 minutes are the warm-up: the switch reads but cannot trip.

## Tripped: what to do

1. **Read why:** `npx wrangler kv key get --binding=POS_KS trip --remote` gives the reason and the time.
   `... state --remote` gives `last_problems`.
2. **Check by hand** whether the address it names is on the issuer's list.
   - Base: `curl -fsS 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500' | jq -r '.tokens[].contract_address'`,
     following `next_page_token` if there is one.
   - Then, on the host: what our server read, and when it last deployed.
   - Treat it as an incident until it is explained.
3. **Clear it**, only after the cause is fixed:
   `npx wrangler kv key delete --binding=POS_KS trip --remote`, then `... delete --binding=POS_KS state --remote` for a
   fresh start with a 20-minute warm-up. A later run never deletes the trip by itself.
4. **To take it out entirely:** `npx wrangler delete`. The routes then go straight to the host again.
