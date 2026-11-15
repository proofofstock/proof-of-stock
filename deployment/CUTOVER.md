# Cutover: POS on its own data root and its own user

Until this cutover, Proof of Stock (POS) lives inside another project's data on the same host:

- its data roots `/var/lib/stp/base` and `/var/lib/stp/robinhood` are links into that project's datasets
  (the Base one under `/root`, the Robinhood one under `/var/lib`);
- POS writes its `stock-peg/` there, including the append-only `history/`;
- its only backups are that project's;
- every unit runs as root, only to read those directories.

After it:

| | Before | After |
|---|---|---|
| our data | `/var/lib/stp/<chain>/stock-peg` (inside the other project) | `/var/lib/pos/<chain>/stock-peg`, owned by `pos` |
| the token streams we read | the same root | `/var/lib/stp/<chain>`, read only, passed as `--token-dataset` / `POS_TOKEN_DATASET_*` |
| units | root | `pos` (site, recorder, impostor list, issuer mirror, anchors, health, alerts), `pos-backup` (backup) |
| capability | `CAP_DAC_READ_SEARCH` in six units | only `stp-impostors` and `stp-health`, which read the other project's directories |
| backup | the other project's | our own restic repository, every 6 hours ([BACKUP.md](BACKUP.md)) |
| alerts | | also: the token streams older than 8 h, no backup for 24 h |

The other project and its services are not touched: no file of it is re-owned or re-permissioned, nothing is
installed into it. The old `stock-peg/` stays where it is, frozen, for the rollback.

**Which fields POS reads from the other project:** `scripts/stocks/data-roots.mjs`, `TOKEN_DATASET_FIELDS`:
`static/token-static-<day>.jsonl[.gz]` (`token_address`, `symbol`, `name`, `deployer`, `observed_at`) and
`deployers/token-deployer-<day>.jsonl[.gz]` (`token_address`, `deployer`). Nothing else.

## Before the day

1. The PR is merged and shipped (`STP_HOST=<host> bash scripts/ship.sh <sha>`). Shipping alone changes nothing:
   the installed units still pass `--root=/var/lib/stp/<chain>` explicitly, and with no `--token-dataset` the token
   dataset defaults to the same `/var/lib/stp/<chain>`. The new health checks start too: the token-stream age (no
   alert while the streams are fresh); the backup check stays off until the new `stp-health` unit names its status
   file.
   One thing does move at once: the defaults of the tools run by hand. The stdio MCP (`passport-mcp.mjs`) and the
   passport CLI now look in `/var/lib/pos`, which exists only after step 3. Until then pass the old root to them:
   `STOCKS_ROOT_BASE=/var/lib/stp/base STOCKS_ROOT_ROBINHOOD=/var/lib/stp/robinhood node scripts/stocks/passport-mcp.mjs`
   (or `--root=/var/lib/stp/<chain>` to `passport.mjs`). Do the cutover soon after the ship.
2. Best done first: the B2 bucket and key, `/etc/pos/backup.env` and `posrestic init` ([BACKUP.md](BACKUP.md), steps 1
   and 2 and the start of step 3). Without them the new `stp-health` sends a `backup:pos` alert once an hour until
   they exist.
3. Optional: POS's own Telegram bot ([ALERTS.md](ALERTS.md#a-bot-of-its-own)).

Everything below runs as root on the host, in order. It takes about 15 minutes, most of it waiting for one recorder
run. The site stays up throughout; one or two recorder runs (15 minutes each) are skipped.

## 0. Keep the current units for the rollback

```sh
install -d -m 0700 /var/backups/pos-cutover
cp -a /etc/systemd/system/stp-*.service /etc/systemd/system/stp-*.timer /var/backups/pos-cutover/
ls -l /var/backups/pos-cutover
```

## 1. The users (once)

```sh
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pos
useradd --system --user-group --no-create-home --home-dir /var/lib/pos-backup --shell /usr/sbin/nologin pos-backup
id pos; id pos-backup
# pos must be able to read the release (root 0755): expect "ok"
runuser -u pos -- test -r /opt/stp/current/apps/stocks-web.mjs && echo ok
```

No ACL and no group change on the other project's directories. The Base dataset sits under `/root` (0700) and the
Robinhood one belongs to the collector's own user (0750). A supplementary group would cover Robinhood only, and an ACL
would change files that are not ours (the `acl` package is not even installed). Instead the two units that read them,
`stp-impostors` and `stp-health`, run as `pos` with the one ambient capability `CAP_DAC_READ_SEARCH`: read past
permissions, never write (`ProtectSystem=strict` keeps everything but our own directories read-only).

## 2. Stop the writers

```sh
systemctl stop stp-peg.timer stp-impostors.timer stp-mirror.timer stp-anchor.timer stp-health.timer
# wait for a run in progress to finish (the recorder takes up to 9 minutes)
while systemctl is-active --quiet stp-peg.service || systemctl is-active --quiet stp-impostors.service || systemctl is-active --quiet stp-mirror.service || systemctl is-active --quiet stp-anchor.service; do sleep 5; done; echo stopped
```

The site keeps running on the old units and the old root meanwhile.

## 3. Copy and verify

```sh
cd /opt/stp/current
sh scripts/ops/migrate-pos-data.sh
```

It copies each chain's `stock-peg/` **including `history/`** to `/var/lib/pos/<chain>/stock-peg`, keeps every mode,
gives the copy to `pos:pos` (the files were root's), and verifies it: the same files, directories and links with the
same modes, sizes and SHA-256. It refuses while a POS unit runs, and it refuses a target that is not empty and not an
exact copy (exit 3, nothing changed). A second run is harmless. Expect, per chain, `copied and verified: N files`.

**Why the copy must come first:** the case archive is append-only. The impostor list started on an empty
`history/` would write a second, backfilled set of cases beside the real one, and that cannot be undone. The impostor
list also refuses on its own: while the old place holds a `history/` and ours has none, it writes no history and fails
(`historyNotMigrated`, `scripts/stocks/impostor-list.mjs`).

Check by hand as well:

```sh
sh scripts/ops/migrate-pos-data.sh --verify
for c in base robinhood; do
  echo "$c: $(ls /var/lib/stp/$c/stock-peg/history | wc -l) -> $(ls /var/lib/pos/$c/stock-peg/history | wc -l) history files"
  ( cd /var/lib/stp/$c/stock-peg && find . -type f -print0 | sort -z | xargs -0 sha256sum ) | sha256sum
  ( cd /var/lib/pos/$c/stock-peg && find . -type f -print0 | sort -z | xargs -0 sha256sum ) | sha256sum
done
stat -c '%U:%G %a %n' /var/lib/pos /var/lib/pos/*/ /var/lib/pos/*/stock-peg /var/lib/pos/*/stock-peg/history
```

The two sums of each chain must be equal; `/var/lib/pos` and `/var/lib/pos/<chain>` are `root:root 755`,
`stock-peg` and below `pos:pos`.

## 4. Install the units

```sh
cd /opt/stp/current
cp deployment/systemd/stp-*.service deployment/systemd/stp-*.timer /etc/systemd/system/
cp deployment/systemd/pos-backup.service deployment/systemd/pos-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/stp-*.service /etc/systemd/system/pos-backup.service
```

`systemd-analyze verify` prints nothing when the units are sound.

## 5. Start and check

The site first:

```sh
systemctl restart stp-web.service
for i in $(seq 1 45); do curl -fsS -m 3 http://127.0.0.1:3005/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -o /dev/null -w 'healthz %{http_code}\n' http://127.0.0.1:3005/healthz
ps -o user=,pid=,cmd= -p "$(systemctl show -p MainPID --value stp-web)"     # user: pos
curl -fsS http://127.0.0.1:3005/stocks/api/status; echo                    # readings and look-alike ages as before
A=$(curl -fsS 'http://127.0.0.1:3005/stocks/api/find?chain=base&q=NVDA' | grep -o '0x[0-9a-f]\{40\}' | head -1)
curl -fsS "http://127.0.0.1:3005/stocks/api/passport?chain=base&address=$A" | head -c 400; echo
curl -fsS -o /dev/null -w 'history %{http_code}\n' http://127.0.0.1:3005/stocks/history
```

The recorder, one run by hand (it waits for the run, up to 10 minutes):

```sh
systemctl start stp-peg.service; systemctl status stp-peg.service --no-pager | head -5
journalctl -u stp-peg -n 5 --no-pager
D=$(date -u +%F)
tail -c 300 /var/lib/pos/base/stock-peg/stock-peg-runs-$D.jsonl; echo
stat -c '%U %y %n' /var/lib/pos/*/stock-peg/stock-peg-runs-$D.jsonl            # pos, just now
stat -c '%y %n' /var/lib/stp/*/stock-peg/stock-peg-runs-$D.jsonl                 # unchanged since step 2
```

The impostor list, one run by hand (a few minutes):

```sh
systemctl start stp-impostors.service
journalctl -u stp-impostors -n 6 --no-pager
```

Its `history` line must show `open_before` equal to the number of open cases before the cutover and only a handful
of `written` events, NOT one `opened` per listed token (that would be a second backfill: stop and roll back). An
`ALARM case archive not written ... copy it first` means step 3 did not happen. Both `stp-peg` and `stp-impostors`
also refuse to start at all while either chain's `/var/lib/pos/<chain>/stock-peg/history` holds no archive
(`ExecStartPre`, an alert through `OnFailure`): the registry history is as append-only as the case archive.

The issuer mirror and the anchors, one run each, now as `pos` (a minute or two):

```sh
systemctl start stp-mirror.service; journalctl -u stp-mirror -n 4 --no-pager
ls -l /var/lib/pos/*/stock-peg/mirror.json          # owner pos, modified just now
systemctl start stp-anchor.service; journalctl -u stp-anchor -n 2 --no-pager
stat -c '%U %n' /var/lib/stp-anchors | head -1      # pos: systemd re-owned the directory of the root runs
```

The mirror continues from the `mirror.json` copied in step 3, so it costs a call or two. The anchor run rebuilds
nothing: yesterday's manifest exists, so it only completes pending proofs.

The health check:

```sh
systemctl start stp-health.service; journalctl -u stp-health -n 3 --no-pager
```

`bad` lists nothing, or only `backup:pos` if the backup is not set up yet.

## 6. Start the timers

```sh
systemctl start stp-peg.timer stp-impostors.timer stp-mirror.timer stp-anchor.timer stp-health.timer
systemctl enable --now pos-backup.timer
systemctl list-timers --no-pager | grep -E 'stp-|pos-'
sh /opt/stp/current/scripts/deploy.sh --status
```

If `/etc/pos/backup.env` exists and the repository was created, run the first backup and the restore test now:
[BACKUP.md](BACKUP.md) step 3, from "The first backup" on.

The next scheduled recorder run (at :07, :22, :37 or :52) must write to `/var/lib/pos` again; check with the `tail`
from step 5 a quarter of an hour later.

## Rollback

At any point after step 3. It carries what was recorded since the cutover back to the old place, so no reading is
lost, and restores the old units.

```sh
systemctl stop stp-peg.timer stp-impostors.timer stp-mirror.timer stp-anchor.timer stp-health.timer pos-backup.timer
while systemctl is-active --quiet stp-peg.service || systemctl is-active --quiet stp-impostors.service || systemctl is-active --quiet stp-mirror.service || systemctl is-active --quiet stp-anchor.service; do sleep 5; done
# the files only grew since the copy (append-only days and history) or were rewritten whole (pool book, lists):
# copy them back over the frozen old ones, root-owned as before, deleting nothing
for c in base robinhood; do rsync -a --chown=root:root /var/lib/pos/$c/stock-peg/ /var/lib/stp/$c/stock-peg/; done
rm -f /etc/systemd/system/pos-backup.service /etc/systemd/system/pos-backup.timer
cp -a /var/backups/pos-cutover/* /etc/systemd/system/
systemctl daemon-reload
systemctl restart stp-web.service
curl -fsS -o /dev/null -w 'healthz %{http_code}\n' http://127.0.0.1:3005/healthz
systemctl start stp-peg.timer stp-impostors.timer stp-mirror.timer stp-anchor.timer stp-health.timer
```

The code does not need rolling back: it runs the old units as before. `/var/lib/pos` stays as it was, for a second
try (the migration script then refuses it as a target that differs: move it aside first, after looking at it).
The users `pos` and `pos-backup` may stay; nothing else uses them.

## Afterwards

- The frozen old `stock-peg/` under `/var/lib/stp/<chain>` stays until the owner decides otherwise; deleting it is a
  separate step with its own yes. It still sits inside the other project's backups.
- What POS still shares with the other project: the token streams it reads (read only, with an alert when they stop),
  the host, and nginx. Producing the needed fields ourselves would remove the first.
