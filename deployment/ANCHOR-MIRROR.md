# The anchor mirrors: Base and Robinhood Chain

The daily root hash already goes into Bitcoin through OpenTimestamps, with no key and no transaction of ours
(`stp-anchor.service`). This adds the same hash on the two chains the service covers, one transaction a day each:
faster to read, readable from those chains, and useless as a proof of time on its own, which is why Bitcoin stays the
root. The reasoning is in the spec, H4.

Everything below is the owner's to run, on the host. The key is made there and never leaves it.

## 1. Make the key

```sh
sudo install -d -m 0700 /etc/pos
sudo node /opt/stp/current/scripts/ops/anchor-keygen.mjs --file=/etc/pos/anchor.key
```

It prints one line: the address. The key itself is never printed, never pasted into a chat and never sent to a model.
To see the address again later:

```sh
sudo node /opt/stp/current/scripts/ops/anchor-keygen.mjs --file=/etc/pos/anchor.key --address
```

## 2. Fund it

Send a little native token to that address on each chain:

- **Base** (chain 8453): ETH.
- **Robinhood Chain** (chain 4663): its native token.

A day's write costs a fraction of a cent on both, so a dollar or two per chain is years of writing. The unit alerts
when under a month is left, which at that price means it has been failing to be noticed for a long time.

## 3. Install the unit

```sh
sudo cp /opt/stp/current/deployment/systemd/stp-anchor-mirror.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
```

A dry run first, which asks both chains what a write would cost and sends nothing:

```sh
sudo -u pos STP_ANCHOR_DIR=/var/lib/stp-anchors STP_ANCHOR_KEY_FILE=/etc/pos/anchor.key \
  node /opt/stp/current/scripts/stocks/anchor-mirror.mjs --dry-run
```

(The dry run needs the key file readable by `pos`, which it is not: run it with `sudo` as root instead, or simply
skip to the unit, which gets the key through `LoadCredential`.)

Then one real day, by hand, and look at it:

```sh
sudo systemctl start stp-anchor-mirror.service
sudo journalctl -u stp-anchor-mirror -n 5 --no-pager
cat /var/lib/stp-anchors/mirror-$(date -u -d yesterday +%F).json
```

The record names the transaction on each chain. Open one in an explorer: the calldata is ASCII and reads
`proofofstock anchor <day> sha256:<hash>`, and the hash must be the SHA-256 of that day's manifest.

```sh
sudo systemctl enable --now stp-anchor-mirror.timer
```

## What it can and cannot do

- The transaction is **to its own address, with value zero**, in the code, not by convention. The worst a bug can do
  is spend its own gas.
- The key lives in `/etc/pos/anchor.key` (root, 0600) and reaches exactly one unit, through `LoadCredential`.
  `/etc/pos` stays inaccessible to every unit, that one included: systemd reads the file as root before the sandbox
  exists. `deployment/layout.test.mjs` fails the build if a second unit ever asks for a credential.
- A gas price far out of line means the write is **skipped and alerted**, not paid. Each run then looks at the last
  three days as well and writes again whatever is missing: a day a chain refused, and a day whose transaction was
  taken and then dropped (no receipt and no transaction on the chain, which the run checks rather than assuming).
  An alert about a day means the catching up could not fix it either.
- **The key is deliberately in no backup.** `/var/lib/pos` and the anchors are copied nightly; `/etc/pos` is not, and
  that is the decision, not an oversight: a key that is worth backing up is a key worth stealing, and this one is
  worth a few days of gas. What the owner should keep in his own password manager is `/etc/pos/backup.env`, because
  losing those credentials loses access to the backup repository itself, which is the one thing here that is not
  reproducible.
- Losing the key costs nothing but the gas left on it: make a new one, fund it, and the mirrors continue. The Bitcoin
  root is untouched by any of that, and the old transactions stay where they are, with the record naming the address
  that sent each one.

## Our Base Builder Code

Optional. `/etc/pos/anchor.env` may set `STP_BUILDER_CODE` to the project's code from Base Dashboard (Settings →
Project Settings → Builder Code, e.g. `bc_…`). The Base transaction then carries it after our line as an ERC-8021
suffix, so Base counts the anchor as our app's activity; Robinhood Chain never gets it. The line itself is unchanged,
and the witnesses and `readAnchorCalldata` cut the suffix off before they read it. Unset, the anchor is sent as before.
A malformed code stops the run instead of sending something we did not mean.

## A keyed RPC provider

Optional. `/etc/pos/anchor.env` may set `STP_RPC_BASE` or `STP_RPC_ROBINHOOD` to a provider URL; the public URL is
the default, and it is the one named in everything we publish.
