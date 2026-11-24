#!/bin/sh
# scripts/host-files.sh: the files that live on the host and not in this repository, carried into a release.
#
#   sh scripts/host-files.sh copy  <base> <release dir>   copy every host file into the release, print each
#   sh scripts/host-files.sh check <base> <release dir>   print one line per host file: in the release, or missing
#
# <base> is the deployment root (/opt/stp), and the files sit under <base>/host at the path they must have inside a
# release: <base>/host/evm/core/stocks/x402.mjs lands at <release>/evm/core/stocks/x402.mjs.
#
# Why this exists. The paid-pass module is deliberately in neither repository (owner, 15.11: this repository is
# exported to a public one and the money path is not for export). A release is built from `git archive`, so a module
# that is not in git is not in the release: installed by hand on 15.11, it was gone from the running release by the
# next deploy, silently, because a host without it is a working free service and says nothing. A host file is not an
# optional extra, it is part of what runs, and this is what makes a deploy carry it.
#
# Deliberately dumb: no deletion, no rename, no state. It copies files one way, and never writes into <base>/host.
set -eu

MODE=${1:?usage: host-files.sh copy|check <base> <release dir>}
BASE=${2:?base directory (the deployment root, e.g. /opt/stp)}
REL=${3:?release directory}
SRC="$BASE/host"

case "$MODE" in copy|check) ;; *) echo "unknown mode $MODE (copy or check)" >&2; exit 2 ;; esac
[ -d "$REL" ] || { echo "no release directory at $REL" >&2; exit 2; }
if [ ! -d "$SRC" ]; then
  [ "$MODE" = check ] && echo "host files      : none installed ($SRC does not exist)"
  exit 0
fi

# The list is taken first, and a failure to take it stops everything. Inside a pipeline it would be swallowed: the
# `while` at the end succeeds, and an unreadable host directory would look like a host with no host files, which is
# the silence this whole script exists to end (outside review, 16.11).
# Listed from inside the directory, so a name is relative without a pattern built out of the path itself: that path
# can hold characters a regular expression reads (a Windows checkout of this repository runs these tests).
LIST=$( cd "$SRC" && find . -type f ) || { echo "REFUSED: cannot list $SRC" >&2; exit 2; }
# A newline in a name splits the list into pieces that each look like an ordinary file. Counting the names twice,
# once by line and once by NUL, is how that is seen at all; it is refused, never guessed at.
BY_LINE=$(printf '%s\n' "$LIST" | grep -c . || true)
BY_NUL=$( cd "$SRC" && find . -type f -print0 | tr -cd '\0' | wc -c | tr -d ' ' ) || BY_NUL=-1
[ "$BY_LINE" = "$BY_NUL" ] || { echo "REFUSED: a host file name holds a newline ($BY_LINE lines, $BY_NUL files)" >&2; exit 2; }

# The release directory as the file system sees it, to compare against where a copy would actually land: a directory
# inside the release that is a symlink out of it would otherwise carry a host file outside the release.
REL_REAL=$( cd "$REL" && pwd -P )

printf '%s\n' "$LIST" | sed 's|^\./||' | while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *' '*|*'	'*) echo "REFUSED: host file name holds a space or a tab: $f" >&2; exit 2 ;;
    ../*|*/../*|/*) echo "REFUSED: host file name leaves its directory: $f" >&2; exit 2 ;;
  esac
  case "$MODE" in
    copy)
      d=$(dirname "$f")
      mkdir -p "$REL/$d"
      here=$( cd "$REL/$d" && pwd -P ) || { echo "REFUSED: cannot enter $REL/$d" >&2; exit 2; }
      case "$here" in
        "$REL_REAL"|"$REL_REAL"/*) ;;
        *) echo "REFUSED: $f would land outside the release, at $here" >&2; exit 2 ;;
      esac
      cp -a "$SRC/$f" "$REL/$f"
      echo "host file: $f"
      ;;
    check)
      if [ -f "$REL/$f" ]; then printf 'host file       : %s (in the release)\n' "$f"
      else printf 'host file       : %s MISSING FROM THE RELEASE\n' "$f"; fi
      ;;
  esac
done
