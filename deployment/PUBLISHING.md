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

The name is on our own domain, `xyz.proofofstock/proof-of-stock` (reverse DNS of proofofstock.xyz, the registry's form), so a reader sees the listing comes from the domain the server runs on (owner, 12.11). The registry proves it over HTTP:

- `deployment/mcp-registry-auth` holds one line, `v=MCPv1; k=ed25519; p=<public key>`. The site serves it at `https://proofofstock.xyz/.well-known/mcp-registry-auth` (an exact nginx location, like security.txt).
- The private half lives only in the public repository's secret `MCP_REGISTRY_KEY`. The owner made the pair on their own machine and put the private half straight into the secret; it is in no file here and no host.
- `.github/workflows/mcp-registry.yml` (run by hand, public repository only) downloads `mcp-publisher` pinned by the SHA-256 of its release archive (the repository allows only GitHub's own actions), logs in with `login http`, and publishes.

To make or replace the key (the owner, in Git Bash, OpenSSL 3), then commit the printed line to `deployment/mcp-registry-auth` and deploy:

```bash
openssl genpkey -algorithm Ed25519 -out pos-mcp-key.pem && openssl pkey -in pos-mcp-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n' | gh secret set MCP_REGISTRY_KEY -R proofofstock/proof-of-stock && echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in pos-mcp-key.pem -pubout -outform DER | tail -c 32 | base64)"
```

Several catalogs (PulseMCP, GitHub's MCP list and others) read from the official registry.

## 3. Smithery

smithery.ai → Add server → "URL / remote" → `https://proofofstock.xyz/mcp`. It needs no key and no configuration.

## 4. Glama: claiming the connector

Glama lists the server by itself, taken from the official registry, so there is nothing to submit. To manage that
listing (its description, its thumbnail, its health checks and its analytics) the connector has to be claimed, and
the method that needs nothing of DNS or GitHub is a file we serve: `GET /mcp/.well-known/glama.json`.

**The claim belongs to the host, never to this repository.** The repository is exported to a public one, and an
ownership claim has no business being published. The site reads it from the environment, so it lives in one file on
the host, like the alert token and the statistics ignore list. Without it the path answers 404 and nothing breaks.

On the host, as root. The claim comes from the Claim ownership dialog on the connector's page:

```sh
umask 077
install -d -m 0755 /etc/pos
read -rp 'Glama claim (glama_claim_...): ' C
printf 'STP_GLAMA_CLAIM=%s\n' "$C" > /etc/pos/web.env
unset C
chown root:root /etc/pos/web.env; chmod 0600 /etc/pos/web.env
sed 's/=.*/=.../' /etc/pos/web.env; stat -c '%U:%G %a %n' /etc/pos/web.env
systemctl restart stp-web
curl -fsS https://proofofstock.xyz/mcp/.well-known/glama.json; echo
```

The unit reads `/etc/pos/web.env` through `EnvironmentFile=-`, so an absent file is the normal state. The vhost needs
the matching location (`deployment/nginx/proofofstock.xyz.conf`), which is the third and last dot-path it serves;
without it nginx answers 404 before the app is reached. `ship.sh` installs neither units nor nginx config, so both
have to be copied by hand after a release that changes them.

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
4. Run the MCP registry workflow (section 2).

## Each release

Bump `version` in `package.json` and `server.json` together, then run the MCP registry workflow again: `gh workflow run mcp-registry.yml -R proofofstock/proof-of-stock`. Bump the guard's own `version` only when its code changes.
