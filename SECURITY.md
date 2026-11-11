# Security

## Reporting a vulnerability

Write to **hello@proofofstock.xyz** with "security" in the subject. Please do not open a public issue for a
vulnerability. Say what you found, how to reproduce it and what it lets someone do. We reply as soon as we can and
tell you when a fix is live.

In scope:

- the site and its JSON API at https://proofofstock.xyz;
- the public MCP server at https://proofofstock.xyz/mcp;
- the `@stockofproof/guard` package (`packages/stockofproof-guard`);
- the code in this repository.

Most valuable to us: a passport, guard or MCP answer that calls an impostor genuine (or a genuine token an impostor),
a way to make the site serve someone else's content, and anything that reaches past the read-only API.

Out of scope: volume-based denial of service, rate limits that work as documented, reports from automated scanners
with no working case, and the registries or chains themselves (report those to their operators).

## What the service holds

No accounts, no cookies, no wallets, no keys and no write path: the site and the MCP server only read public registries,
public chain data and issuer prices. The visit counter stores no address and sets no cookie
(`docs/legal.md`).

## Supported versions

Only the latest release, the one running at https://proofofstock.xyz, gets fixes.
