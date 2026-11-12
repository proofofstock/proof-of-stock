# Publishing: npm package and MCP catalogs

Each step needs the owner's own login. No credential for npm, GitHub or Smithery lives in this repository or on a host.

## 1. `@proofofstock/guard` on npm

The scope `@proofofstock` must exist as an npm organisation, which is free for public packages: npmjs.com → Add Organization → `proofofstock`.

```bash
npm login
cd packages/proofofstock-guard
npm test
npm pack --dry-run        # shows exactly which files go out: index.mjs, agentkit.mjs, README.md, LICENSE, package.json
npm publish               # publishConfig.access is public
```

## 2. The official MCP registry

`server.json` at the repository root describes the remote server (`https://proofofstock.xyz/mcp`). Its `version` must match `package.json`, and a test checks this.

```bash
# mcp-publisher: https://github.com/modelcontextprotocol/registry/releases
mcp-publisher login github     # device flow in the browser, as an admin of the proofofstock organisation
mcp-publisher publish          # run from the repository root
```

The name `io.github.proofofstock/proof-of-stock` is tied to the `proofofstock` organisation on GitHub, which holds the
public copy of the source. Publish once the repository is public, so the listing's link works.

A name on our own domain (`xyz.proofofstock/passport`) is the alternative. It needs a key pair, with the public key served at `/.well-known/mcp-registry-auth`; that is a later change.

Several catalogs (PulseMCP, Glama and others) read from the official registry.

## 3. Smithery

smithery.ai → Add server → "URL / remote" → `https://proofofstock.xyz/mcp`. It needs no key and no configuration.

## Opening the source

This repository stays private. The public one, `proofofstock/proof-of-stock`, is a copy built by
`scripts/export-public.sh`: the tree at a commit, internal notes replaced by a stub, as one commit with no history,
refused if it names anything on `scripts/public-deny.txt`. CI dry-runs that export on every push.

The site's GitHub links (a footer chip, the docs top bar and the docs footer) point at `repository.url` in
`package.json` and stay hidden while `stp.source_public` is false, so no visitor follows one to a 404. To open:

1. Export the commit that runs in production and add it on top of the public repository's `main` (no force-push: each
   release is one new commit there, the tree exactly as exported):
   ```bash
   scripts/export-public.sh /tmp/pos-public <sha>
   cd /tmp/pos-public
   git remote add origin https://github.com/proofofstock/proof-of-stock && git fetch -q origin main
   git reset --soft FETCH_HEAD                                 # same tree, parent = the public main
   git -c user.name='Proof of Stock' -c user.email=hello@proofofstock.xyz commit -q -C HEAD@{1}
   git log -1 --format='%an <%ae> / %cn <%ce>'                  # both must be Proof of Stock <hello@…>, never a person
   git push origin HEAD:main
   ```
   Every commit of the public history becomes visible, so an old one must pass today's deny list too (checked 11.11).
2. Make `proofofstock/proof-of-stock` public (Settings → Danger zone → Change visibility).
3. Set `"stp": { "source_public": true }` in `package.json`, merge and deploy. The links appear with that release.
4. `mcp-publisher publish` (section 2).

## Each release

Bump `version` in `package.json` and `server.json` together, then run `mcp-publisher publish` again. Bump the guard's own `version` only when its code changes.
