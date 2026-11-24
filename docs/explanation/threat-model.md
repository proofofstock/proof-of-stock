# Threat model

Who we do not trust, what we do about it, and what a successful attack on this service would look like.

This page exists because a security review without a threat model produces generic advice. It is also the honest
version of the sales pitch: the whole product is a claim about other people's tokens, so the only thing worth
attacking here is the claim itself.

## What there is to take

Nothing of yours. There are no accounts, no sessions, no cookies, no personal data, no custody, no approvals and no
transaction we can send on your behalf. If this server were taken over completely, nobody's tokens would move.

The project holds two private keys and two other credentials. All live on the host, in root-only files under
`/etc/pos`, and each reaches exactly one systemd unit through `LoadCredential`; no unit can read `/etc/pos` itself.

- **The anchor key** (`stp-anchor-mirror`) signs one kind of transaction: to its own address, value zero, carrying
  the day's manifest hash as text.
- **The settlement key** (`stp-web`, only on a host that sells paid passes) pays the gas to settle a pass a buyer
  has already paid for: it submits the buyer's own signed USDC `transferWithAuthorization` to the USDC contract on
  Base. The buyer's signature fixes the payee, the amount and a one-time nonce, so the key cannot change who is paid,
  how much, or reuse a payment; the USDC goes to the payee address, which is a separate wallet this key does not
  control. The server sends it only after checking that the payee and the amount are exactly the ones its own 402
  named. It holds no USDC and no token of anyone's. It settles x402 v1 payments, and v2 ones only where the next
  credential is absent.
- **The facilitator API key** (`stp-web`, where v2 payments are settled through Coinbase's x402 facilitator). We check
  a v2 payment ourselves first (payee, amount, asset, network, window, one-time nonce), then hand it to the
  facilitator. Its answer that the payment settled is not taken on trust: Coinbase is one of the two issuers this
  service checks, so before a pass is granted we read that transaction's receipt from the chain ourselves, the same
  check as our own settlement (it succeeded, and its Transfer log moves exactly this payment to our payee). No receipt
  yet is "pending"; a receipt that is not this payment grants nothing. Stolen, the key lets someone call the
  facilitator in our name; it moves no money of ours or of anyone's.
- **The Telegram bot token** (`stp-tg-bot`). It lets whoever holds it speak as @ProofofStockBot. The bot holds no
  key, reads only our own API on the loopback, and sends fixed words with every value escaped.

The settlement key and the facilitator key sit in `stp-web` for as long as it runs, which is the process that faces
the internet: the "thirty seconds a day" below is the anchor key's exposure, not theirs. What keeps that acceptable is
the same as for the anchor key: the settlement wallet holds gas only, and neither key can move a buyer's money beyond
the one payment that buyer signed.

What either key can do if stolen: spend its own gas, and sign transactions from its own address. Neither can move a
caller's tokens, a buyer's funds beyond the one payment that buyer signed, or the payments already received. The
balance on each is kept at gas only on purpose, so that losing one costs nothing worth defending. Neither is in any
backup: if one is lost or suspected, we make a new one and fund it. For the anchor key the mirrors continue from the
next day under a new address that the record names; for the settlement key the passes continue as soon as the new
address has gas, and until then a purchase is refused without taking the payment.

So the thing worth attacking is **what we say**. Two outcomes are worth something to an attacker: make this service
state something false (an impostor shown as listed, a day's archive shown as proved when it is not), or make it go
quiet while something changes (a drift that is never recorded, an alert nobody receives).

## The parties we do not trust

**You, the caller.** Every argument is validated before it reaches a reader. Text from a request reaches a sentence
the service says only where it has passed a strict pattern first: a ticker or ISIN you compared across venues
(letters, digits, a dot or a dash, at most 16 characters), an address (0x and 40 hex digits), a date. A free-text
search comes back as data, never inside the lead sentence that agents are told to quote. An error message may repeat
up to 64 characters of what you sent, to you alone.

**Somebody else's picture.** The footer shows our connector's score badge from Glama. The server fetches it, at most
hourly, and serves it from our own origin, so a reader's browser never asks Glama; the file is accepted only as
plain shapes and text with links to its own parts (no script, no handler, no link or `url()` out, no escape), and it is
served under a policy that runs nothing even when it is opened on its own.

**The token.** A symbol and a name are text their creator chose. They are shown as short labels, never interpreted,
never put into our sentences, and every answer carries a line saying so (`untrusted_text`).

**The issuers whose lists we read.** They are the subject of the service, not a party to it. Every verdict names the
list it was decided against by the SHA-256 of its sorted addresses, with the command that computes the same hash from
the issuer's own API, and that exact list stays served by its hash after the issuer changes it. We never editorialise
a list: if it cannot be read, the answer says it cannot verify, and never "not listed". A list the issuer has not
answered for 15 minutes counts as unreadable on every route (the passport, search, the list, the page, the board),
not only on `/verify`; and an answer that is empty, or that lost more than half the list in one read, is treated as a
failed read rather than as a mass delisting.

**The chains' RPC endpoints, which those same issuers run.** `mainnet.base.org` is Coinbase's and
`rpc.mainnet.chain.robinhood.com` is Robinhood's: the two companies this service checks. So an answer from them is
treated as an interested party's statement. The chain id is checked before anything is signed; the transaction hash a
node returns must equal the one we computed before sending; and a mirror is called confirmed only once a node run by
somebody else confirms the same transaction, in a block, from and to one address, value zero, carrying this day and
this hash. A node that sees something else at that hash makes the record say so.

**The OpenTimestamps calendars.** They are third parties, and their bytes are parsed by our own parser. A fresh answer
must contain nothing but a pending attestation: an answer that already names a Bitcoin block is one somebody made up.
A completed proof is reported as a claim, with the merkle root its path ends at, until that root has been compared
with what sources outside OpenTimestamps report for that block height. Then, and only then, the answer says the hash
is in that block.

**Block explorers.** Two of them, and they can only ever confirm something the proof already says. They cannot make
us state a block that the proof does not name.

**Price aggregators.** Where an aggregator and the chain both see a pool, the chain wins, and a reading is refused
rather than guessed when the two disagree past a threshold. An aggregator being wrong costs a reading, never a
verdict.

**Our own host.** An attacker with root could stop the service, write false readings from that moment on, and spend
the gas on the anchor key. What they could not do is change the past: every day's data files are hashed into a
manifest, the manifests are chained to each other, and each is timestamped into Bitcoin and mirrored on two chains.
Rewriting a day breaks its hash, and the break is visible to anybody who kept an answer or reads `/anchors/`.

One thing here is a deliberate trade rather than a defence. The unit that signs runs as `pos`, the same user as the
web server, so code execution as `pos` plus a permissive `ptrace_scope` could read the key out of that process while
it runs. A user of its own would close it. We have not done it, because the window is about thirty seconds a day, the
prize is a few days of gas, the key can be replaced in a minute with no loss to the archive, and a second user
writing the same directory as the anchor is a good way to break the one job that has to run every night. If the
balance on that key ever has to be larger, this is the first thing to change.

**Ourselves.** The code is public and MIT, the daily exam publishes its own wrong answers to a branch anyone can
rerun, and the archive is anchored. The point of all three is that we cannot quietly change our mind about what we
said last month.

## What we do not claim

- Nothing here is investment advice, and "listed" is never "safe to buy": it says which contract is the issuer's, at a
  named time, by a named list.
- "Not listed" is never "scam". It means the address is not in the issuer's registry we read for that chain.
- A reading has an age, and past 30 minutes it is marked stale rather than quietly shown.
- The site is independent: no issuer has reviewed or endorsed it.

## What is not defended against

- **Denial of service beyond the per-client rate limit.** A determined flood takes the site down. Nothing is lost by
  that: the archive is on disk, anchored, and backed up.
- **A deep Bitcoin reorganisation**, which would move what a block height means. The proofs name the block, so a reorg
  is visible rather than hidden.
- **A compromised dependency.** There are five, pinned, and two of them (`@noble/curves`, `@noble/hashes`) are the
  only ones in the signing path. We do not vendor them, and a malicious release of one would be a real problem.
- **Your own agent.** If an agent ignores the answer it was given, nothing here can help it. The guard package exists
  for that, and it fails closed.
- **Griefing the settlement breaker, at a price.** A payment its payer cancels between our check and our broadcast
  fails after we sent it. That payer is then refused for 30 minutes, and nobody else is: selling as a whole pauses
  only when ten different payers fail that way within an hour, which costs an attacker ten funded wallets and ten
  transactions on Base each time. The day's gas budget caps what it can cost us. Failed payments are also capped per
  client on every paid route.

The ledgers of passes and payments live on disk, so a restart keeps every live pass and every spent authorization: a
settled authorization copied from the chain is "already used", not a second pass. They name no client by address:
client addresses are kept as salted hashes.
- **The badge is not metered.** `/badge.svg` answers without the per-client limit, because image proxies fetch it
  from a handful of addresses. It says listed, look-alike or not listed per address, at the proxy's own rate.

## And now somebody depends on us

Publishing `@proofofstock/guard` to npm turns this project into a link in somebody else's supply chain. If the npm
account that owns it were taken, a version could be published into other people's agents, and nothing we do on our
own host would stop it. What holds that: from the second version on, the package is published
**only from a workflow in the public repository, with npm provenance**, so the registry itself records which public
commit a tarball was built from; there is no publishing token at all, because npm checks the short-lived OIDC
identity of that one workflow in that one repository instead, which means there is no long-lived credential anywhere
to steal; the workflow may only STAGE a version, and releasing it is a separate click by the owner on npm, so a
compromised repository cannot reach anybody's install by itself; the package has **no dependencies at all**, so there is nothing underneath us to take instead;
and the whole guard is one readable file, so a reader can compare what the registry serves with what the repository
says. The first version, 0.2.0, was published by hand before this was set up, and carries no provenance.

## What a successful attack would look like

In the order that would hurt most:

1. **A false "listed".** An address shown as the issuer's when it is not. This would need our registry read and the
   list hash to agree on something untrue, which is why the hash and the frozen list are published with every verdict.
2. **A forged proof of the past.** A day's archive shown as timestamped in Bitcoin when it is not, or shown with a
   block that does not contain it.
3. **A quiet stop.** Readings that stop, an alert that never fires, a proof that never completes and nobody notices.
   Most of the operational work in this repository is against this one.
4. **A sentence of ours carrying somebody else's words.** An agent is told to quote our lead sentence, so text that
   reaches it from a caller, a token, a node or a calendar is the attack surface for every reader downstream.

## What we run against ourselves

Besides the daily exam and the tests, the MCP server is scanned with Snyk's open-source Agent Scan, which looks for
the risks an agent-facing server carries: prompt injection in tool descriptions, untrusted content, private data and
destructive capability. It is run in a throwaway container that is given one configuration file naming nothing but
our public endpoint, so that the scanner cannot read anything else on the machine, and never with its auto-discovery,
which would send every agent configuration on the host to a third party:

```sh
docker run --rm --env-file <file with SNYK_TOKEN> -v <dir with only our mcp.json>:/scan:ro   --tmpfs /tmp:rw,exec,size=1g --tmpfs /home/u:rw,exec,size=512m -e HOME=/home/u -e UV_CACHE_DIR=/tmp/uvcache   --memory 2g --pids-limit 512 python:3.13-slim   bash -c "pip install -q uv && uvx -q snyk-agent-scan@latest /scan/mcp.json --no-skills --dangerously-run-mcp-servers"
```

What leaves the machine is what the scanner needs: the names and descriptions of our tools, which are public already,
since anyone can read them from `tools/list` on the open endpoint. What it finds stays in our own notes.

## Telling us

hello@proofofstock.xyz, or a private advisory on the repository. A critical finding (a false "listed", a pass without
its payment, somebody's text in a sentence of ours) earns 100 USD in USDC on Base; the terms are in `SECURITY.md`. If
you find a claim this service makes that is not true, that is the finding we want most.
