#!/bin/sh
# scripts/deploy.sh: install an uploaded release of the Stock Token Passport on its host, gate it, switch, check.
#
#   sh <incoming>/scripts/deploy.sh <sha> <incoming dir> <expected running sha|none>   (called by scripts/ship.sh)
#   sh /opt/stp/current/scripts/deploy.sh --status
#
# The host holds no git checkout and no GitHub credential: scripts/ship.sh, run where the repository is, checks that the
# target descends from what runs, makes `git archive <sha>`, uploads it to /opt/stp/incoming/<sha7>, and calls this.
# Every unit (stp-web, stp-peg, stp-impostors) works in /opt/stp/current; the timers pick a new release up at their
# next start, the site is restarted here.
#
# ⚠ The running release is re-read right before switching and must still be the one ship.sh checked against: a deploy
#   that landed in between is never replaced.
# ⚠ One deploy at a time: a second one started meanwhile is refused (flock on $BASE/.deploy.lock), not interleaved.
# ⚠ /healthz is 200 only once an issuer registry is loaded. A restart that fails or a release that never gets healthy is
#   rolled back, and the rolled-back release is health-checked too: the script says which state the host is left in.
set -eu

BASE=${STP_BASE:-/opt/stp}
WEB_UNIT=stp-web.service
HEALTH=http://127.0.0.1:3005/healthz
KEEP=5
wait_healthy () {
  for _ in $(seq 1 "${HEALTH_WAIT_S:-45}"); do curl -fsS -m 3 "$HEALTH" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
running_sha () { [ -f "$BASE/current/.release-sha" ] && cat "$BASE/current/.release-sha" || echo none; }

if [ "${1:-}" = "--status" ]; then
  echo "running release : $(readlink -f "$BASE/current" 2>/dev/null || echo none)"
  echo "running commit  : $(running_sha)"
  for u in stp-web.service stp-peg.timer stp-impostors.timer; do printf '%-22s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
  printf 'health          : '; curl -fsS -m 5 "$HEALTH" >/dev/null 2>&1 && echo 200 || echo FAIL
  exit 0
fi

FULL=${1:?sha}; SRC=${2:?incoming dir}; EXPECT=${3:?expected running sha or none}
exec 9>"$BASE/.deploy.lock"
flock -n 9 || { echo "REFUSED: another deploy is running on this host; re-run when it ends"; exit 3; }
SHORT=$(printf '%s' "$FULL" | cut -c1-7)
REL="$BASE/releases/$SHORT"
[ "$(running_sha)" = "$EXPECT" ] || { echo "REFUSED: running is $(running_sha), ship.sh checked against $EXPECT; re-run"; exit 3; }

if [ ! -f "$REL/.release-sha" ]; then
  echo "building $REL"
  rm -rf "$REL.tmp"; mkdir -p "$BASE/releases"; cp -a "$SRC" "$REL.tmp"
  ( cd "$REL.tmp" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )
  echo "gate: npm test in the release"
  ( cd "$REL.tmp" && npm test ) > "$BASE/gate-$SHORT.log" 2>&1 || { tail -30 "$BASE/gate-$SHORT.log"; echo "GATE FAILED: nothing switched"; exit 1; }
  tail -1 "$BASE/gate-$SHORT.log"
  printf '%s\n' "$FULL" > "$REL.tmp/.release-sha"
  rm -rf "$REL"; mv "$REL.tmp" "$REL"
fi

[ "$(running_sha)" = "$EXPECT" ] || { echo "REFUSED: the running release changed during the gate; re-run"; exit 3; }
PREV=$(readlink -f "$BASE/current" 2>/dev/null || true)
ln -sfn "$REL" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
if systemctl cat "$WEB_UNIT" >/dev/null 2>&1; then
  # A failed restart must not end the script under set -e with the new release switched in: it falls to the rollback.
  systemctl restart "$WEB_UNIT" || echo "restart of $WEB_UNIT failed"
  # The site reads both issuer registries before it listens, which takes seconds and depends on the issuers: wait for
  # it up to HEALTH_WAIT_S, polling, rather than judging it once after a fixed pause (10.11: a 3 s pause failed a healthy
  # release that listened after 6 s, and the release was rolled back).
  if ! wait_healthy; then
    echo "HEALTH FAILED after switch: restoring $PREV"
    if [ -n "$PREV" ] && ln -sfn "$PREV" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; then
      systemctl restart "$WEB_UNIT" || echo "restart of the restored release failed"
      if wait_healthy; then echo "ROLLED BACK: $(running_sha) is healthy"; else echo "ROLLED BACK BUT UNHEALTHY: $(running_sha) does not answer /healthz; look at journalctl -u $WEB_UNIT"; exit 4; fi
    else
      echo "ROLLBACK FAILED: no previous release to restore"; exit 4
    fi
    exit 1
  fi
fi
rm -rf "$SRC"
echo "deployed OK: $SHORT  ($(readlink -f "$BASE/current"))"
ls -1dt "$BASE"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r d; do
  [ "$(readlink -f "$d")" = "$(readlink -f "$BASE/current")" ] || { rm -rf "$d"; echo "pruned $(basename "$d")"; }
done
