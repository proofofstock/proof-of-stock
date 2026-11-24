# Security

## Reporting a vulnerability

Write to **hello@proofofstock.xyz** with "security" in the subject (also in https://proofofstock.xyz/.well-known/security.txt). Please do not open a public issue for a
vulnerability. Say what you found, how to reproduce it and what it lets someone do. We reply as soon as we can and
tell you when a fix is live.

In scope:

- the site and its JSON API at https://proofofstock.xyz;
- the public MCP server at https://proofofstock.xyz/mcp;
- the Telegram bot [@ProofofStockBot](https://t.me/ProofofStockBot);
- paid passes over x402 (USDC on Base);
- the `@proofofstock/guard` package (`packages/proofofstock-guard`);
- the code in this repository.

Most valuable to us: a passport, guard or MCP answer that calls an impostor genuine (or a genuine token an impostor),
a way to make the site serve someone else's content, and anything that reaches past the read-only API.

Out of scope: volume-based denial of service, rate limits that work as documented, reports from automated scanners
with no working case, and the registries or chains themselves (report those to their operators).

## Reward

**100 USD, paid in USDC on Base, for a critical finding.** Critical means one of:

- an answer of ours (site, JSON API, MCP, the bot, the guard) that calls a contract the issuer's own when it is not on
  that issuer's list, or calls the issuer's own contract an impostor;
- a paid pass granted without the payment it names, or a payment taken from someone beyond the one they signed;
- text of a caller or of a token's creator reaching a sentence we tell agents to quote, or markup we serve.

The terms: the first private report of an issue gets it; it has to reproduce against the live service or the code in
this repository; and the test must not harm anyone else (no flooding, no other people's funds or data). We confirm,
fix, and pay to an address you name, and we credit you if you want to be credited. Anything less than critical gets
our thanks and a fix, not a reward.

## Threat model

Who we do not trust, what we do about it, and what a successful attack would look like:
[`docs/explanation/threat-model.md`](docs/explanation/threat-model.md), also at
https://proofofstock.xyz/docs/explanation/threat-model.md. Read that first if you are reviewing this service.

## What the service holds

No accounts, no cookies and no wallets of yours. A caller can change nothing we hold: the site and the MCP server read
public registries, public chain data and issuer prices; the visit counter appends an anonymous row; and a payment
header makes the server submit the payer's own signed USDC transfer, or hand it to Coinbase's facilitator, and
nothing else. The project holds two keys and two other credentials (a facilitator API key for x402 v2 and the Telegram
bot's token, see the threat model), all on the host in root-only files, each handed to exactly one unit. The keys:

- the **anchor key** writes the daily anchor mirror: it signs a transaction to its own address with zero value and
  nothing else;
- the **settlement key** (only where paid passes are on) pays the gas to submit a buyer's own signed USDC
  `transferWithAuthorization` on Base. The buyer's signature fixes the payee, the amount and the nonce, so the key
  cannot redirect or enlarge a payment, and the USDC goes to a payee wallet it does not control.

Each holds gas and nothing else, so the worst either can lose is its own gas. See
[`docs/explanation/threat-model.md`](docs/explanation/threat-model.md#what-there-is-to-take). The visit counter stores no address and sets no cookie
(`docs/legal.md`).

## Supported versions

Only the latest release, the one running at https://proofofstock.xyz, gets fixes.
