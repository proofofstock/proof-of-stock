#!/usr/bin/env bash
# scripts/export-public.sh — the public copy of this repository: the tree at a commit, with the internal notes replaced
# by a one-line stub, as ONE fresh commit with no history. This repository stays private; the public one is rebuilt from
# it on each release.
#
#   scripts/export-public.sh <dest-dir> [<rev>]      rev defaults to HEAD
#
# It refuses to finish when the exported tree still names a host, a path or a project that is not this one. The list is
# in scripts/public-deny.txt (not exported).
set -euo pipefail
DEST=${1:?usage: scripts/export-public.sh <dest-dir> [<rev>]}
REV=${2:-HEAD}
ROOT=$(git rev-parse --show-toplevel)
[ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ] && { echo "$DEST is not empty" >&2; exit 2; }
mkdir -p "$DEST"

git -C "$ROOT" archive "$REV" | tar -x -C "$DEST"

# Internal notes: design notes and the operator's own access, kept private.
STUB='This page is internal design notes and is not published. The public documentation is in docs/README.md.'
for f in docs/stocks-truth-layer-tz.md docs/stocks-passport-agent.md; do
  [ -e "$DEST/$f" ] && printf '# Internal\n\n%s\n' "$STUB" > "$DEST/$f"
done
rm -f "$DEST/scripts/public-deny.txt"

# The deny list: one extended regex per line, # comments. A hit anywhere stops the export.
DENY=$(grep -v '^\s*#' "$ROOT/scripts/public-deny.txt" | grep -v '^\s*$' | paste -sd'|')
if HITS=$(grep -rniE "$DENY" "$DEST" --exclude-dir=.git | cut -c1-200); then
  echo "refusing: the public tree still names something private:" >&2
  echo "$HITS" >&2
  exit 1
fi

cd "$DEST"
git init -q -b main
git add -A
git -c user.name='Proof of Stock' -c user.email='hello@proofofstock.xyz' commit -q -m "Proof of Stock $(node -p "require('./package.json').version")"
echo "exported $(git -C "$ROOT" rev-parse --short "$REV") to $DEST as one commit: $(git rev-parse --short HEAD), $(git ls-files | wc -l) files"
