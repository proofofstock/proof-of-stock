# Publishing: npm package and MCP catalogs

Each step needs the owner's own login. No credential for npm, GitHub or Smithery lives in this repository or on a host.

## 1. `@stockofproof/guard` on npm

The scope `@stockofproof` must exist as an npm organisation, which is free for public packages: npmjs.com → Add Organization → `stockofproof`.

```bash
npm login
cd packages/stockofproof-guard
npm test
npm pack --dry-run        # shows exactly which files go out: index.mjs, agentkit.mjs, README.md, LICENSE, package.json
npm publish               # publishConfig.access is public
```

## 2. The official MCP registry

`server.json` at the repository root describes the remote server (`https://proofofstock.xyz/mcp`). Its `version` must match `package.json`, and a test checks this.

```bash
# mcp-publisher: https://github.com/modelcontextprotocol/registry/releases
mcp-publisher login github     # device flow in the browser, as the GitHub account that owns Coconatrm
mcp-publisher publish          # run from the repository root
```

The name `io.github.Coconatrm/stock-token-passport` is tied to that GitHub login.

A name on our own domain (`xyz.stockofproof/passport`) is the alternative. It needs a key pair, with the public key served at `/.well-known/mcp-registry-auth`; that is a later change.

Several catalogs (PulseMCP, Glama and others) read from the official registry.

## 3. Smithery

smithery.ai → Add server → "URL / remote" → `https://proofofstock.xyz/mcp`. It needs no key and no configuration.

## Opening the source

The site's GitHub links (a footer chip, the docs top bar and the docs footer) are wired in and hidden while the
repository is private, so no visitor follows one to a 404. To open the source:

1. Make `Coconatrm/stock-token-passport` public (GitHub → Settings → Danger zone → Change visibility).
2. Set `"stp": { "source_public": true }` in `package.json`.
3. Optionally add `"repository"` to the guard's `package.json`, so npm links to the code.
4. Merge and deploy. The links appear with that release.

## Each release

Bump `version` in `package.json` and `server.json` together, then run `mcp-publisher publish` again. Bump the guard's own `version` only when its code changes.
