# Alerts

Until 12 Nov 2026 every ALARM went to the server journal only. Now the owner gets a Telegram message when something is
off, and one more when it clears.

## What raises an alert

| Check | When | Source |
|---|---|---|
| a unit failed | `stp-peg`, `stp-impostors`, `stp-web`, `stp-health` or `pos-backup` exits with an error | `OnFailure=stp-alert@%n.service` |
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
| no backup | the last successful backup of `/var/lib/pos` is older than 24 h, or none is recorded ([BACKUP.md](BACKUP.md)) | `backupChecks`, `/var/lib/pos-backup/status.json` |

The same alert is sent at most once an hour while it lasts. The thresholds are `THRESHOLDS` and the constants beside
each check in `scripts/stocks/health-check.mjs`.

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
