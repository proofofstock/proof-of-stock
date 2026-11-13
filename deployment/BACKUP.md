# Backup of /var/lib/pos to Backblaze B2

POS's own data, `/var/lib/pos`, is backed up with [restic](https://restic.net) every 6 hours. That covers the price
readings, run rows, pool book, look-alike files and the append-only `history/`. The backups go to a Backblaze B2
bucket of POS's own (not the other project's), through B2's S3 API. restic encrypts everything on the host before
it leaves; B2 sees only encrypted blobs.

| Piece | What |
|---|---|
| `deployment/systemd/pos-backup.service` | runs `scripts/ops/pos-backup.mjs` as the user `pos-backup`; skipped while `/etc/pos/backup.env` does not exist |
| `deployment/systemd/pos-backup.timer` | 00:47, 06:47, 12:47, 18:47 UTC |
| `/etc/pos/backup.env` | the four values below: root, 0600, written by the owner on the host |
| `/var/lib/pos-backup/status.json` | the last success, attempt and prune, and the failed step if any; no secret |
| `stp-health` | alert `backup:pos` when the last success is older than 24 h, or there is none |

The unit reads exactly these variables from `/etc/pos/backup.env`:

| Variable | Value |
|---|---|
| `RESTIC_REPOSITORY` | `s3:<endpoint>/<bucket>/pos`, e.g. `s3:s3.eu-central-003.backblazeb2.com/pos-backup-k3x9q/pos` |
| `RESTIC_PASSWORD` | the repository's encryption password |
| `AWS_ACCESS_KEY_ID` | the B2 application key's `keyID` |
| `AWS_SECRET_ACCESS_KEY` | the B2 `applicationKey` |

Any other repository address (SFTP, a local path, another S3 store, restic's native `b2:` backend) is refused, and so
is a B2 address without a bucket.

Retention (`KEEP` in `scripts/ops/pos-backup.mjs`):
- every snapshot of the last 2 days;
- then one a day for 14 days;
- one a week for 8 weeks;
- one a month for 12 months.

The prune and a `restic check` run once a day.

**No secret passes through a chat, a commit or a command line.** Every secret is typed into `read -rsp` (no echo) on
the host, and the shell's own `printf` writes it straight to the file. Keep the repository password in your password
manager as well: without it, nobody can read the backup.

## 1. In the Backblaze B2 console

1. **Buckets > Create a Bucket**
   - **Name:** `pos-backup-` plus a few random letters and digits, e.g. `pos-backup-k3x9q`. B2 bucket names are
     global, 6 to 63 characters.
   - **Files in Bucket are:** Private.
   - **Default Encryption:** Enable (server-side, SSE-B2). This comes on top of restic's own encryption.
   - **Object Lock:** Disable. restic deletes its lock file at the end of every run, which locked objects would refuse.
   - Note the **Endpoint** shown on the new bucket, e.g. `s3.eu-central-003.backblazeb2.com`.
2. **Lifecycle Settings** of that bucket: **Keep prior versions for this number of days: 30**.
   - Over the S3 API a delete only hides a file. The rule removes hidden files after 30 days.
   - So anything restic's prune removes, or anyone using restic from this host deletes, can still be recovered in
     the console for 30 days.
   - "Keep only the last version" would remove them after a day; "Keep all versions" would never free the space.
3. **Application Keys > Add a New Application Key**
   - **Name of Key:** `pos-backup`.
   - **Allow access to Bucket(s):** only the bucket from step 1.
   - **Type of Access:** Read and Write.
   - **Allow List All Bucket Names:** leave it off.
   - **File name prefix** and **Duration:** leave them empty.
   - The console shows the `keyID` and the `applicationKey` **once**. Keep the window open for step 2 and copy them
     nowhere else.

   **Why the key can delete.** A key without delete would be safer, but restic cannot work with one: every run
   removes the lock file it created, and the prune removes data that no snapshot keeps. In the console the choice is
   only Read and Write, Read Only or Write Only, and a Write Only key cannot read the repository at all. The 30-day
   rule in step 2 is what protects the backups from deletion through restic. It does not stop someone holding the key
   from deleting old file versions directly through the B2 API. Protection against that would need Object Lock, which
   restic does not use, or a second copy elsewhere.

## 2. On the host: the env file

As root on the POS host. The user `pos-backup` comes from [CUTOVER.md](CUTOVER.md) step 1; the first line creates it
if this runs before the cutover.

```sh
id pos-backup >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /var/lib/pos-backup --shell /usr/sbin/nologin pos-backup
install -d -m 0755 /etc/pos
umask 077
read -rp  'B2 endpoint (e.g. s3.eu-central-003.backblazeb2.com): ' EP
read -rp  'Bucket name: ' BK
read -rsp 'keyID (not shown): ' KID; echo
read -rsp 'applicationKey (not shown): ' KEY; echo
read -rsp 'Repository password, from your password manager (not shown): ' PW; echo
printf 'RESTIC_REPOSITORY=s3:%s/%s/pos\nRESTIC_PASSWORD=%s\nAWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$EP" "$BK" "$PW" "$KID" "$KEY" > /etc/pos/backup.env
unset EP BK KID KEY PW
chown root:root /etc/pos/backup.env; chmod 0600 /etc/pos/backup.env
sed 's/=.*/=.../' /etc/pos/backup.env; stat -c '%U:%G %a %n' /etc/pos/backup.env
```

- The last line shows only the variable names and `root:root 600`, never a value.
- Use a repository password of letters and digits, 32 or more, made by the password manager. A value with spaces,
  quotes, `$` or backslashes would not read back exactly (systemd's env-file rules).
- systemd reads the file as root and hands the values to the backup alone. The site and the other POS units cannot
  see `/etc/pos` at all.

## 3. Create the repository, the first backup, a restore test

A helper for this shell: one restic command as `pos-backup`, with the env file. It goes through the same script as the
timer, so the address is checked the same way.

```sh
posrestic () {
  systemd-run --quiet --wait --pipe --collect -p User=pos-backup -p Group=pos-backup \
    -p EnvironmentFile=/etc/pos/backup.env -p WorkingDirectory=/opt/stp/current \
    -p StateDirectory=pos-backup -p CacheDirectory=pos-backup \
    -E RESTIC_CACHE_DIR=/var/cache/pos-backup -E HOME=/var/lib/pos-backup \
    /usr/bin/node scripts/ops/pos-backup.mjs --restic "$@"
}
```

**Create the repository, once.** The timer never does this: a typo in the address must not quietly start an empty
second repository.

```sh
posrestic init
posrestic cat config >/dev/null && echo 'repository OK'
```

`init` prints `created restic repository ... at s3:...`. A `403` or `AccessDenied` means the key is not for this
bucket, or not Read and Write. `Fatal: unable to open config` on `cat config` means the password differs from the one
used at `init`.

**The first backup.** It needs `/var/lib/pos`, which exists from [CUTOVER.md](CUTOVER.md) step 3 on. Before the
cutover, stop here: step 6 of the cutover runs these lines.

```sh
cp /opt/stp/current/deployment/systemd/pos-backup.service /opt/stp/current/deployment/systemd/pos-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pos-backup.timer
systemctl start pos-backup.service; journalctl -u pos-backup -n 15 --no-pager
cat /var/lib/pos-backup/status.json
posrestic snapshots --tag pos
```

- `status.json` shows `last_success_at` and `last_prune_at` as now and `last_error` as null.
- `snapshots` lists one snapshot of `/var/lib/pos`.
- From here, `stp-health` alerts when the last success is older than 24 h, and a failed run alerts at once through
  `OnFailure=`.

**A restore test.** Do it once now, and again after any change of key or bucket.

```sh
posrestic restore latest --target /var/lib/pos-backup/restore-test --include /var/lib/pos/base/stock-peg/history
diff -r /var/lib/pos/base/stock-peg/history /var/lib/pos-backup/restore-test/var/lib/pos/base/stock-peg/history && echo 'restore OK'
rm -rf /var/lib/pos-backup/restore-test
```

`diff` may name a history file that was appended to since the snapshot; take a fresh one
(`systemctl start pos-backup.service`) and repeat.

## After a loss of the host

On the new host:
1. Install restic.
2. Recreate `/etc/pos/backup.env` with step 2, from the password manager and a new B2 key.
3. Restore as root:

   ```sh
   ( set -a; . /etc/pos/backup.env; set +a; restic restore latest --tag pos --target / )
   ```

4. Follow [CUTOVER.md](CUTOVER.md) steps 1, 4, 5 and 6.

## Change the key

1. Create a new key (step 1.3).
2. Rewrite the env file (step 2).
3. Run `systemctl start pos-backup.service`, then check `status.json`.
4. Delete the old key in the console.

A new bucket also needs `posrestic init` again, and its first backup is a full one.
