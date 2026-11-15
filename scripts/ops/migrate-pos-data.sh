#!/bin/sh
# scripts/ops/migrate-pos-data.sh: copy POS's own data, each chain's stock-peg/ INCLUDING history/, from its old place
# inside the other project's datasets (/var/lib/stp/<chain>/stock-peg, through the links) to /var/lib/pos/<chain>/stock-peg,
# and prove the copy. Step 3 of deployment/CUTOVER.md; run as root on the host with the POS timers stopped.
#
#   sh scripts/ops/migrate-pos-data.sh            copy what is not there yet, then verify every chain
#   sh scripts/ops/migrate-pos-data.sh --verify   verify only; change nothing
#
# ⚠ WHY IT MATTERS. The case archive (history/) is append-only. The impostor list started on an empty archive would write
#   a second, backfilled set of cases beside the real one, which cannot be undone; the recorder likewise for the
#   registry history. So the copy is complete or the target is left alone.
# ⚠ IT NEVER OVERWRITES. A non-empty target that is not an exact copy of the source is refused (exit 3): look before
#   deciding. A target that is already an exact copy is reported and left as it is, so a second run is harmless.
# ⚠ IT NEVER CHANGES THE SOURCE. The old stock-peg/ stays where it is, for the rollback.
# Verified per chain: the same files, directories and links with the same modes, sizes and SHA-256; and every entry of
# the target owned by $POS_OWNER (the units run as pos). Ownership is the one thing that changes: root before, pos now.
#
# Env (for tests; the defaults are the host's): POS_OLD_ROOT=/var/lib/stp POS_NEW_ROOT=/var/lib/pos POS_OWNER=pos:pos
# POS_CHAINS="base robinhood"; POS_MIGRATE_SKIP_UNIT_CHECK=1 skips the check that the POS units are stopped.
set -eu
umask 022

OLD=${POS_OLD_ROOT:-/var/lib/stp}
NEW=${POS_NEW_ROOT:-/var/lib/pos}
OWNER=${POS_OWNER:-pos:pos}
CHAINS=${POS_CHAINS:-base robinhood}
MODE=copy
case "${1:-}" in
  '') ;;
  --verify) MODE=verify ;;
  *) echo "usage: $0 [--verify]" >&2; exit 2 ;;
esac

say () { printf '%s\n' "$*"; }
die () { code=$1; shift; printf 'REFUSED: %s\n' "$*" >&2; exit "$code"; }

OWN_U=$(id -u "${OWNER%%:*}" 2>/dev/null) || die 2 "no user ${OWNER%%:*}: create it first (deployment/CUTOVER.md step 1)"
OWN_G=$(getent group "${OWNER#*:}" 2>/dev/null | cut -d: -f3) || true
[ -n "$OWN_G" ] || OWN_G=$(id -g "${OWNER%%:*}")

# The recorder or the impostor list writing during the copy would make it a copy of a moment that has passed.
if [ "$MODE" = copy ] && [ "${POS_MIGRATE_SKIP_UNIT_CHECK:-0}" != 1 ]; then
  for u in stp-peg.timer stp-impostors.timer stp-mirror.timer stp-peg.service stp-impostors.service stp-mirror.service; do
    if systemctl is-active --quiet "$u"; then die 2 "$u is active: stop the timers and wait for a running unit to finish (deployment/CUTOVER.md step 2)"; fi
  done
fi

# One line per entry: type, mode, size for files, link target for links, relative path. Sorted, so two trees compare.
listing () { ( cd "$1" && find . -mindepth 1 -printf '%y %m %s %l %P\n' | sed 's/^d \([0-7]*\) [0-9]* /d \1 - /' | LC_ALL=C sort ); }
sums () { ( cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ); }
same () {
  [ "$(listing "$1")" = "$(listing "$2")" ] || return 1
  [ "$(sums "$1")" = "$(sums "$2")" ] || return 1
}
counts () { printf '%s files, %s directories, %s bytes' "$(find "$1" -type f | wc -l | tr -d ' ')" "$(find "$1" -mindepth 1 -type d | wc -l | tr -d ' ')" "$(find "$1" -type f -printf '%s\n' | awk '{ s += $1 } END { print s + 0 }')"; }
owned () { [ -z "$(find "$1" \( ! -uid "$OWN_U" -o ! -gid "$OWN_G" \) -print -quit)" ]; }
nonempty () { [ -d "$1" ] && [ -n "$(ls -A "$1")" ]; }

bad=0
for c in $CHAINS; do
  src=$OLD/$c/stock-peg
  dst=$NEW/$c/stock-peg
  say "== $c: $src -> $dst"
  [ -d "$src" ] || die 2 "$src does not exist or is not a directory"
  [ -d "$src/history" ] || say "   note: $src has no history/ (nothing archived yet)"
  if nonempty "$dst"; then
    if same "$src" "$dst"; then
      if owned "$dst"; then say "   already an exact copy, owned by $OWNER: $(counts "$dst")"; continue; fi
      if [ "$MODE" = verify ]; then say "   MISMATCH: an exact copy, but not every entry is owned by $OWNER"; bad=1; continue; fi
      chown -R "$OWNER" "$dst"; owned "$dst" || die 3 "$dst could not be given to $OWNER"
      say "   already an exact copy; given to $OWNER: $(counts "$dst")"; continue
    fi
    [ "$MODE" = verify ] && { say "   MISMATCH: $dst differs from $src"; bad=1; continue; }
    die 3 "$dst is not empty and differs from $src. Nothing was changed. Compare them (sh $0 --verify) before deciding."
  fi
  if [ "$MODE" = verify ]; then say "   MISSING: $dst is absent or empty"; bad=1; continue; fi
  # The parents belong to root, like any /var/lib directory; only stock-peg/ and below belong to pos.
  install -d -m 0755 "$NEW" "$NEW/$c"
  part=$dst.partial-$$
  rm -rf "$part"
  cp -a "$src" "$part"
  chown -R "$OWNER" "$part"
  if ! same "$src" "$part"; then rm -rf "$part"; die 3 "the copy of $src does not match it (did a unit write meanwhile?); the partial copy was removed"; fi
  owned "$part" || { rm -rf "$part"; die 3 "the copy could not be given to $OWNER"; }
  # An empty target (systemd's StateDirectory may have made one) is replaced; a non-empty one never reaches here.
  [ -d "$dst" ] && rmdir "$dst"
  mv "$part" "$dst"
  same "$src" "$dst" || die 3 "$dst does not match $src after the move"
  say "   copied and verified: $(counts "$dst")"
  say "   history/: $(ls "$dst/history" 2>/dev/null | wc -l | tr -d ' ') files, sha256 of the listing $(sums "$dst/history" 2>/dev/null | sha256sum | cut -c1-16)"
done

if [ "$bad" != 0 ]; then echo "VERIFY FAILED: see above"; exit 1; fi
echo "OK: every chain's stock-peg/ in $NEW is an exact copy of the old one, owned by $OWNER"
