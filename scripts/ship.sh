#!/bin/sh
# scripts/ship.sh — ship a commit of this repository to the host. Run where the repository is checked out.
#
#   scripts/ship.sh <sha> [--rollback]     STP_HOST, or git config stp.host, is the ssh alias of the host
#   scripts/ship.sh --status
#
# 1. Reads what runs on the host (/opt/stp/current/.release-sha).
# 2. Refuses a target that is not a descendant of it, unless --rollback: that would remove what lies between.
# 3. Prints every commit the deploy ships.
# 4. Uploads `git archive <sha>` and runs scripts/deploy.sh from it, which gates with the tests and switches.
set -eu
HOST=${STP_HOST:-$(git config --get stp.host || true)}
[ -n "$HOST" ] || { echo "set STP_HOST or: git config stp.host <ssh alias>" >&2; exit 2; }
if [ "${1:-}" = "--status" ]; then exec ssh "$HOST" 'sh /opt/stp/current/scripts/deploy.sh --status'; fi
TARGET=${1:?usage: scripts/ship.sh <sha> [--rollback] | --status}
FULL=$(git rev-parse --verify "$TARGET^{commit}")
SHORT=$(printf '%s' "$FULL" | cut -c1-7)
git fetch -q origin 2>/dev/null || true
git merge-base --is-ancestor "$FULL" origin/main 2>/dev/null || { echo "REFUSED: $SHORT is not on origin/main"; exit 2; }
RUNNING=$(ssh "$HOST" 'cat /opt/stp/current/.release-sha 2>/dev/null || echo none')
if [ "$RUNNING" != none ] && [ "$RUNNING" != "$FULL" ]; then
  git cat-file -e "$RUNNING^{commit}" 2>/dev/null || { echo "REFUSED: the running $RUNNING is not in this checkout; fetch first"; exit 2; }
  if ! git merge-base --is-ancestor "$RUNNING" "$FULL"; then
    echo "REFUSED: $SHORT is not a descendant of the running one; it would remove:"; git log --oneline "$FULL..$RUNNING" | sed 's/^/  /'
    [ "${2:-}" = "--rollback" ] || exit 2
  fi
  echo "ships:"; git log --oneline "$RUNNING..$FULL" | sed 's/^/  /'
fi
IN=/opt/stp/incoming/$SHORT
git archive "$FULL" | ssh "$HOST" "rm -rf $IN && mkdir -p $IN && tar -x -C $IN"
ssh "$HOST" "sh $IN/scripts/deploy.sh $FULL $IN $RUNNING"
