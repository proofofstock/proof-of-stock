# Alerts

Until 12 Nov 2026 every ALARM went to the server journal only. Now the owner gets a Telegram message when something is
off, and one more when it clears.

## What raises an alert

| Check | When | Source |
|---|---|---|
| a unit failed | `stp-peg`, `stp-impostors`, `stp-web` or `stp-health` exits with an error | `OnFailure=stp-alert@%n.service` |
| the site does not answer | `GET http://127.0.0.1:3005/stocks/api/status` fails | `stp-health`, every 15 min |
| an issuer list is not read | older than 15 min, or a read error (the site then answers "registry unavailable", never "not listed") | `/api/status` |
| price readings are stale | the newest is older than 30 min | `/api/status` |
| the look-alike list is old | older than 8 h (rebuilt every 6 h) | `/api/status` |
| the recorder stopped | no run for 30 min, a list read error, or a run that stopped early | the last run row |
| DexScreener is failing | more than 20% of a run's tokens got an error or a 429 | the last run row |
| the chain is unreadable | the RPC failed, or more than 20% of tokens could not be read | the last run row |
| sources disagree | more than 10% of tokens refused with `sources_disagree` | the last run row |
| a source changed its format | a new field, a field gone, a type changed, or a list that shrank by more than 10% (Coinbase, Robinhood, DexScreener) | `shape_changes` in the run row (`evm/core/stocks/shape.mjs`) |

The same alert is sent at most once an hour while it lasts. The thresholds are `THRESHOLDS` in
`scripts/stocks/health-check.mjs`.

## Set up (the owner)

1. In Telegram, talk to **@BotFather**: send `/newbot`, choose a name and a username. It answers with a token.
2. Send any message (`/start`) to your new bot, so it may write to you.
3. Find your chat id: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. The number at
   `"chat":{"id":…}` is it.
4. On the host, as root, create the file the units read. Do not put the token anywhere else:

   ```sh
   install -d -m 0700 /etc/stp
   install -m 0600 /dev/null /etc/stp/alert.env
   printf 'STP_ALERT_TELEGRAM_TOKEN=%s\nSTP_ALERT_TELEGRAM_CHAT=%s\n' '<TOKEN>' '<CHAT ID>' > /etc/stp/alert.env
   ```

## Install the units (on the owner's word)

The units on the host are copies; a deploy does not update them.

```sh
cd /opt/stp/current
cp deployment/systemd/stp-alert@.service deployment/systemd/stp-health.service deployment/systemd/stp-health.timer /etc/systemd/system/
cp deployment/systemd/stp-peg.service deployment/systemd/stp-impostors.service deployment/systemd/stp-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now stp-health.timer
systemctl start stp-health.service && journalctl -u stp-health -n 5 --no-pager
```

Check the chain end to end: `systemctl start stp-alert@test.service` sends "test: it failed" to the chat.
