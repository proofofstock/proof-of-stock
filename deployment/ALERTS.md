# Alerts

Until 12 Nov 2026 every ALARM went to the server journal only. Now the owner gets a Telegram message when something is
off, and one more when it clears.

## What raises an alert

| Check | When | Source |
|---|---|---|
| a unit failed | `stp-peg`, `stp-impostors`, `stp-web`, `stp-health`, `stp-anchor`, `stp-anchor-mirror` or `pos-backup` exits with an error | `OnFailure=stp-alert@%n.service` |
| a day was not anchored | every OpenTimestamps calendar refused, or a proof is still pending after 3 days | `stp-anchor`, daily |
| a day was not mirrored | a chain refused the write, reverted it, skipped it because the gas price was out of line, or took a transaction that is still not in a block a day later (dropped by the sequencer). The run looks at the last 3 days and writes again what is missing, so an alert here means it could not | `stp-anchor-mirror`, daily |
| the anchor key is running out | under 30 days of writes left at the current gas price (a day costs a fraction of a cent, so this means months of warning) | `stp-anchor-mirror`, daily |
| the site does not answer | `GET http://127.0.0.1:3005/stocks/api/status` fails | `stp-health`, every 15 min |
| an issuer list is not read | older than 15 min, or a read error (the site then answers "registry unavailable", never "not listed") | `/api/status` |
| price readings are stale | the newest is older than 30 min | `/api/status` |
| the look-alike list is old | older than 8 h (rebuilt every 6 h) | `/api/status` |
| the recorder stopped | no run for 30 min, a list read error, or a run that stopped early | the last run row |
| DexScreener is failing | more than 20% of a run's tokens got an error or a 429 | the last run row |
| the chain is unreadable | the RPC failed, or more than 20% of tokens could not be read | the last run row |
| sources disagree | more than 10% of tokens refused with `sources_disagree` | the last run row |
| a source changed its format | a new field, a field gone, a type changed, or a list that shrank by more than 10% (Coinbase, Robinhood, DexScreener) | `shape_changes` in the run row (`evm/core/stocks/shape.mjs`) |
| the token streams stopped | the newest `static/token-static-*` day file of a chain's token dataset (another project's collector) is older than 8 h, or cannot be read: "the token streams that feed the look-alike list have not been updated for X h; the list may be stale" | `tokenStreamChecks`, `TOKEN_STREAM_MAX_AGE_S` |
| a token's B20 transfer rules changed | a Base token's bound policy id, its pause, or a policy's answer for an account we check changed between two readings both RPCs agreed on (docs/b20-transfers-tz.md §5). `stp-web` writes each change, with the baseline it leads to and a sequence high-water mark that never goes down, to one file written atomically, `/var/lib/stp-b20/b20-state.json` (`StateDirectory=stp-b20`), so a restart or a crash loses and repeats nothing; a write that fails commits nothing and shows as `outbox_write_failed` and one dated `[b20]` journal line; `stp-health` reads the outbox from `/api/status/b20/events` with its cursor in `/var/lib/stp-alerts/b20-sent.json`, batches a burst into few messages, each line with the change's stable id, and counts a message only when Telegram answered ok with a message id (a short `retry_after` is waited for). A cursor file it cannot read, or cannot write after a send, stops B20 alerts and is itself an alert; the file the deployed release before this one wrote there (`{ tokens, told }`) is taken as an upgrade: its outbox did not exist, so the cursor starts at 0 and everything the new outbox holds is told; any other file without a valid cursor is an error and an alert. Changes the site dropped before they were told, gaps inside the outbox and an outbox reset (a new outbox epoch) are said. During a Telegram outage nothing moves; a batch Telegram refuses while it takes other messages is moved past after three runs, and only once a loss notice naming its ids has been delivered. At-least-once: a message Telegram took whose answer was lost comes again, with the same ids. `stp-web` holds no bot token | `stp-health`, every 15 min |
| the B20 reader is blind | its last cycle that read both RPCs and agreed is older than 20 min, or there has been none (`base.b20.last_ok_at` in `/api/status`); clears when a cycle succeeds | `stp-health`, every 15 min |
| no backup | the last successful backup of `/var/lib/pos` is older than 24 h, or none is recorded ([BACKUP.md](BACKUP.md)) | `backupChecks`, `/var/lib/pos-backup/status.json` |
| `stale:npm-guard` | the latest `@proofofstock/guard` on npm (`registry.npmjs.org/@proofofstock%2fguard/latest`) has been below the deployed release's `packages/proofofstock-guard/package.json` for more than 3 days. Publishing is the owner's step ([PUBLISHING.md](PUBLISHING.md) §1) | `stp-health`, every 15 min, `staleChecks` |
| `stale:mcp-registry` | the official MCP registry's latest version of our server (`registry.modelcontextprotocol.io/v0/servers/<name>/versions/latest`, by the `name` in `server.json`) has been below the deployed release's `server.json` for more than 3 days ([PUBLISHING.md](PUBLISHING.md) §2) | `stp-health`, every 15 min, `staleChecks` |
| `stale:release` | `[Unreleased]` in the deployed release's `CHANGELOG.md` has entries and its newest dated release is more than 7 days old (counted in UTC days): changes are deployed but no release is cut | `stp-health`, every 15 min, `staleChecks` |

The same alert is sent at most once an hour while it lasts. The throttle and a resolution are recorded only once the message is delivered, under a lock on the state file shared by `stp-health` and `stp-alert@`, so a failed alert is tried again and no writer loses another's entry. The thresholds are `THRESHOLDS` and the constants beside
each check in `scripts/stocks/health-check.mjs`.

The three `stale:` checks compare the release `stp-health` runs from (`/opt/stp/current`) with what the world sees
(owner, 27.11: every merge was deployed, but nothing was published or released, and nothing said so). "More than 3
days" counts from the first run that saw the registry behind; that time is kept under `stale-since` in the alert state
file (`/var/lib/stp-alerts/state.json`) and dropped once the registry catches up. Within the 3 days the check is neither
an alert nor a clear, so a lost state file never sends RESOLVED for something still behind. A registry that does not
answer, or answers about another package or server, is not compared: the run writes one `[stp-health]` line to the
journal saying so and keeps the first-seen time, and it is never an alert by itself. The registries are asked only in the
run itself; `npm test` injects its fetch and asks nobody.

The 8 hours for the token streams come from the host (12.11, 30 days of `observed_at`): ordinary quiet stretches last
up to 5.1 h, and the one real outage (1 to 2 Nov) lasted about 30 h on both chains. `STP_TOKEN_STREAM_MAX_AGE_H` in the
unit overrides it.

## Set up (the owner)

1. In Telegram, talk to **@BotFather**: send `/newbot`, choose a name and a username. It answers with a token.
2. Send any message (`/start`) to your new bot, so it may write to you.
3. Find your chat id: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. The number at
   `"chat":{"id":…}` is it.
4. On the host, as root, write the file the units read, typing the token into the prompt (it is not shown and goes
   nowhere else): the steps in [A bot of its own](#a-bot-of-its-own), point 3.

## Install the units (on the owner's word)

The units on the host are copies; a deploy does not update them. Since the move to /var/lib/pos and the user pos, all
of them are installed together by [CUTOVER.md](CUTOVER.md) step 4; the lines below are the first install of 12.11.

```sh
cd /opt/stp/current
cp deployment/systemd/stp-alert@.service deployment/systemd/stp-health.service deployment/systemd/stp-health.timer /etc/systemd/system/
cp deployment/systemd/stp-peg.service deployment/systemd/stp-impostors.service deployment/systemd/stp-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now stp-health.timer
systemctl start stp-health.service && journalctl -u stp-health -n 5 --no-pager
```

Check the chain end to end: `systemctl start stp-alert@test.service` sends "test: it failed" to the chat.

## A bot of its own

Until now the alerts may go through a bot that belongs to another project: if that bot's token is rotated there, POS
goes silent. POS's own bot needs no code change, only a new token in two places.

1. Create the bot with **@BotFather** (`/newbot`), send it `/start` from your own Telegram, and find your chat id
   (`https://api.telegram.org/bot<TOKEN>/getUpdates`, in your own browser).
2. Check that the units on the host already read `/etc/pos/alert.env` (installed by [CUTOVER.md](CUTOVER.md)):
   `grep EnvironmentFile /etc/systemd/system/stp-health.service` lists it after `/etc/stp/alert.env`; the later file
   wins. Before the cutover, write `/etc/stp/alert.env` instead in point 3.
3. On the host, as root:

   ```sh
   install -d -m 0755 /etc/pos
   umask 077
   read -rsp 'Bot token (not shown): ' T; echo
   read -rp  'Chat id: ' C
   printf 'STP_ALERT_TELEGRAM_TOKEN=%s\nSTP_ALERT_TELEGRAM_CHAT=%s\n' "$T" "$C" > /etc/pos/alert.env
   unset T C
   chown root:root /etc/pos/alert.env; chmod 0600 /etc/pos/alert.env
   systemctl start stp-alert@test.service
   ```

   The last line sends "test: it failed" through the new bot. systemd reads the file as root and hands the values to
   the unit; the user `pos` cannot read the file itself.
4. The outside check (`.github/workflows/canary.yml`, in the public repository) has its own copy. From a terminal
   logged in to GitHub, each command asks for the value without showing it:

   ```sh
   gh secret set STP_ALERT_TELEGRAM_TOKEN --repo proofofstock/proof-of-stock
   gh secret set STP_ALERT_TELEGRAM_CHAT --repo proofofstock/proof-of-stock
   ```

5. Once the test message arrived from the new bot, `/etc/stp/alert.env` may be deleted
   (`rm /etc/stp/alert.env`); the units ignore a missing one.

## B20 outbox (host step, once)

`deployment/systemd/stp-web.service` gives the site a state directory for the B20 outbox: `StateDirectory=stp-b20` and
`STP_B20_DIR=/var/lib/stp-b20`. After the release that carries it, as root: `systemctl daemon-reload && systemctl
restart stp-web`. systemd creates `/var/lib/stp-b20` owned by `pos`; nothing else is needed. Without it the site keeps
the outbox in memory, and a restart forgets changes not yet told (`base.b20.durable` in `/api/status` says which).
