# Publishing: npm package and MCP catalogs

Each step needs the owner's own login. No credential for npm, GitHub or Smithery lives in this repository or on a host.

## 1. `@proofofstock/guard` on npm

Published, and from the next version on it is published **from CI, with provenance**, not from anyone's laptop.

**Why.** A package sitting inside somebody else's agent is a link in their supply chain: a stolen npm account would
be enough to put code there, and nothing we do on our own host would stop it. A publish from the workflow attaches
npm provenance, so the registry records and displays which public repository and which commit the tarball was built
from, signed by GitHub's OIDC token. "What you install is what the repository says" stops being our promise and
becomes a link on the package page.

**There is no publishing token.** npm's trusted publishing is used instead: the package names this repository and
this workflow file as the only thing allowed to publish it, and the job proves who it is with a short-lived OIDC
token GitHub mints for that run. Nothing long-lived exists to steal, rotate or leak.

**Set up once (the owner):** npmjs.com, Packages, `@proofofstock/guard`, Settings, **Trusted publishing**, GitHub
Actions:

| Field | Value |
|---|---|
| Organization or user | `proofofstock` |
| Repository | `proof-of-stock` |
| Workflow filename | `publish-guard.yml` |
| Environment name | leave empty |
| Allowed actions | leave BOTH unchecked: `npm stage publish` is always allowed, and that is all this workflow may do |

Two things to know. The first publish through it must happen **within two days** of saving, or the configuration
expires and has to be made again. And `repository.url` in the package's `package.json` must match that repository
exactly, which it does.

Afterwards, in Settings, Publishing access, choose **"Require two-factor authentication and disallow tokens"**: then
no token can publish this package at all, by anybody, and the workflow is the only way in.

**Each release:**

1. Bump `version` in `packages/proofofstock-guard/package.json`, merge it, and export the public repository as usual.
2. In the public repository: Actions, **Publish guard to npm**, Run workflow.
3. The workflow runs the package's tests, refuses a version that is already in the registry, and **stages** it.
4. On npmjs.com, the package page shows the staged version: look at it and release it. That click is the only way a
   version reaches anybody's install, so a compromised repository or workflow still cannot do it alone.
5. Check the package page afterwards: it should show the commit the tarball was built from.

Publishing by hand still works and needs the owner's own login (`npm login`, then `npm publish --access public` in
the package directory), but it produces a version without provenance, so it is for an emergency only. `npm pack
--dry-run` shows exactly which files go out.

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

### 402index.io domain claim

[402index.io](https://402index.io/verify) verifies that the domain is ours by reading the SHA-256 hash of a token it
issues at `https://proofofstock.xyz/.well-known/402index-verify.txt`. The token is the credential for editing the
listing: it stays with the owner (a password manager), never on the host and never in git. Only its hash goes on the
host, in the same `/etc/pos/web.env`, as `STP_402INDEX_HASH`; the app serves it as plain text and answers 404 without
it. The vhost has the matching exact location, a fourth dot-path.

1. `POST https://402index.io/api/v1/claim` with `{"domain": "proofofstock.xyz"}`: the answer holds `verification_token`
   and `verification_hash`. Keep the token; the claim expires after 72 hours if not verified.
2. On the host, append `STP_402INDEX_HASH=<verification_hash>` to `/etc/pos/web.env` (as above: root, 0600), copy the
   vhost, `nginx -t && systemctl reload nginx`, `systemctl restart stp-web`, and check the path answers the hash.
3. `POST https://402index.io/api/v1/claim/verify` with `{"domain": "proofofstock.xyz"}`: the answer says `verified`.

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

## After a deploy that changes what the canary pins

The outside check lives in the PUBLIC repository and pins facts about the live site: how many MCP tools there are, a
known listed address, a known look-alike (`scripts/canary.mjs`, `KNOWN`). The host is deployed from the private
repository, so between a deploy and the next public export those two disagree, and the check alerts about a
difference that is only our own lag. That happened on 14.11: the seventh tool went live in the morning and the public
copy followed in the evening, so the outside check was red for hours and every alert it sent was false.

**So: a deploy that changes anything in `KNOWN` is followed by the public export in the same sitting**, not next
week. A false alert costs more than a late export: it is the thing that teaches everybody to ignore the alarm.

## Each release

Bump `version` in `package.json` and `server.json` together, then run the MCP registry workflow again: `gh workflow run mcp-registry.yml -R proofofstock/proof-of-stock`. Bump the guard's own `version` only when its code changes.

## Paid passes (x402): turning them on

**Off by default.** Without the two host facts below every refusal stays the plain 429 and no 402 is ever served,
which is the free service exactly as it was.

**The module is a host file.** `evm/core/stocks/x402.mjs` and its test are **gitignored** (owner, 15.11): the money
path does not belong in a repository that is exported to a public one. So it is in neither repository, and therefore
in no release built from `git archive`.

A repository of its own, private, for the money path alone was weighed and declined (owner, 16.11). The module is not
self-contained (it imports `evm-tx.mjs` from this tree and its test runs inside this checkout), so a second repository
buys a history we already have three copies of, at the price of one more place the money path lives. Revisit it when
somebody outside this pair touches that code, or when its tests have to run in CI rather than in the host's own gate.

That has one consequence worth more than the rest of this section. **A release only has it because the deploy puts
it there.** The deploy copies everything under `/opt/stp/host/` into the new release before the gate runs, so:

```sh
install -D -m 644 x402.mjs      /opt/stp/host/evm/core/stocks/x402.mjs
install -D -m 644 x402.test.mjs /opt/stp/host/evm/core/stocks/x402.test.mjs
sh /opt/stp/current/scripts/deploy.sh --status        # says which host files the running release has
```

Put them there, not into a release: a release is replaced by the next deploy. On 15.11 the module was copied into the
release tree by hand, and the first deploy after that built a tree without it. Nothing complained, because a host
without the module is a working free service. `--status` now names every host file and says MISSING when a release
does not carry one, and the site logs a line at startup if the host names a payee or a key file and the module is
not there.

`/opt/stp/host` holds no secrets (the settlement key stays in `/etc/pos/`), but it is the only copy of the money path
on the machine: it belongs in the host's config backup.

To turn the passes on, give the web unit both facts (in `/etc/pos/web.env` or the unit's environment):

1. `STP_X402_PAY_TO` : the Base address that receives the payments. A fresh wallet made for this; it is public and it
   appears in every 402 the site serves.
2. The settlement key: a file with 32 bytes of hex, never in the repository, never an env value. This is the same
   pattern as the anchor mirror's key (`loadKey` there), and it is made the same way, on the host, printing only the
   address:

   ```sh
   sudo node /opt/stp/current/scripts/ops/anchor-keygen.mjs --file=/etc/pos/x402.key    # root:root 0600
   ```

   `stp-web` cannot read `/etc/pos` (`InaccessiblePaths=`), so `STP_X402_KEY_FILE` pointing there does not work
   for it. The key reaches it through `LoadCredential`, which systemd reads as root before the sandbox exists; the
   module then finds it at `$CREDENTIALS_DIRECTORY/x402-key`. That line is a **host-only drop-in**, not part of
   `deployment/systemd/stp-web.service`, because a unit naming a credential file that is absent does not start, and a
   host without passes must still serve:

   ```ini
   # /etc/systemd/system/stp-web.service.d/x402.conf
   [Service]
   LoadCredential=x402-key:/etc/pos/x402.key
   ```

   Like the anchor key, it is deliberately in no backup: it holds only gas, and a lost one is replaced by making a new
   one and funding it. The drop-in and `/etc/pos/web.env` are host config, and belong in the host's config backup.

   What the key signs: one transaction per purchase, calling USDC's `transferWithAuthorization` with the buyer's own
   signature. That signature fixes the payee, the amount and the nonce, and the server sends it only after checking
   the payee and amount are the ones its own 402 named, so the key cannot redirect or enlarge a payment. The USDC goes
   to `STP_X402_PAY_TO`, a wallet this key does not control.

The settlement wallet needs gas on Base: about 0.001 ETH covers thousands of settlements at the fee cap in the module.
A dry wallet refuses politely (the buyer is told the payment was not taken) and the journal says
`the settlement wallet is out of gas`. The node it settles through is `STP_RPC_BASE`, the same env the anchor mirror
reads; the default is `mainnet.base.org`.

**The alarms reach Telegram through stp-health** (since 20.11; before that they were journal lines nobody read). The
site keeps what is needed in `/api/status/payments`, and stp-health turns it into alerts every 15 minutes:

- `x402:paused`: several settlements in a row failed after broadcast, the griefing pattern. Selling resumes by itself
  after 30 minutes, and a day's settlements may not cost more than 0.0003 ETH of gas in any case (`DAILY_GAS_WEI` in
  the module).
- `x402:late:<tx>`: a broadcast had no receipt for 10 minutes. Look the hash up on BaseScan and refund by hand if the
  USDC moved and no pass was given. Sent once; it is a task, never "resolved".
- `x402:gas`: the settlement wallet holds less than a day of gas (0.0003 ETH), or its balance could not be read.

Every settlement writes `[x402] settled <tx> payer <address>` to the journal: that line is the refund record.

The price, the pass length, the cooldown and the queue cap live in `evm/core/stocks/x402.mjs`, not in env: changing
them is a code change and a release, so that the price a buyer was shown in a 402 and the price settled can never
disagree. After enabling, watch the journal for `[x402] settled <tx> payer <address>` on the first live purchase, and run the how-to's
own two-step curl against the live site.

### x402 v2 payments through Coinbase's facilitator (CDP)

Since 22.11 an x402 v2 payment (`PAYMENT-SIGNATURE`) is settled by Coinbase's x402 facilitator, not by the settlement
wallet: the module still verifies the payment itself first (payee, amount, window, signature, replay), then asks CDP to
verify and settle it. Catalogues such as x402scan and the Bazaar count settlements they see through a facilitator they
know, and the gas is Coinbase's. v1 payments (`X-PAYMENT`) keep the settlement wallet above, which therefore stays.

The facilitator needs a CDP **secret API key** (portal.cdp.coinbase.com, API Keys, Secret API Keys, Ed25519), made by
the owner and kept in their password manager. Its **IP allowlist** names this server's outbound addresses: **on a move
to another server, add the new addresses to the key's allowlist before traffic moves**, or v2 payments are refused
(the module then answers that the payment was not taken; nothing moves). On the host the key lives in
`/etc/pos/x402-cdp.env` (`CDP_API_KEY_ID=` and `CDP_API_KEY_SECRET=`, root:root 0600), typed in by the owner with
`read -rs` so it never passes through a chat or a log. It reaches the unit like the settlement key, through a second
host-only drop-in:

```ini
# /etc/systemd/system/stp-web.service.d/x402-cdp.conf
[Service]
LoadCredential=x402-cdp:/etc/pos/x402-cdp.env
```

then `systemctl daemon-reload && systemctl restart stp-web`. The module reads `$CREDENTIALS_DIRECTORY/x402-cdp`;
`/api/status/payments` says `settles_v2: "cdp"`. **To fall back** to our own settlement for v2 too, remove the drop-in
and restart: without the key every payment settles through the wallet, as before 22.11. A key file that does not read
does the same and logs why, never the key.

A settle whose answer is lost may still have landed on chain: the module never settles it a second time. The payer is
told to send the same payment again, and that retry asks the chain (the USDC `AuthorizationUsed` log) before anything
else. Sales settled by CDP do not come from the settlement wallet, so the wallet's count on `/status` covers v1 only;
the v2 ones are on x402scan.
