#!/usr/bin/env bash
# scripts/export-public.sh: the public copy of this repository: the tree at a commit, with the internal notes replaced
# by a one-line stub, as ONE fresh commit with no history. This repository stays private; the public one is rebuilt from
# it on each release.
#
#   scripts/export-public.sh <dest-dir> [<rev>]            build the copy and commit it; rev defaults to HEAD
#   scripts/export-public.sh --check [<tmp-dir>] [<rev>]   dry run: build the tree and run every refusal check, then stop
#                                                          before git init. Without a dir it uses a temp dir and removes it.
#                                                          CI runs this on every push.
#
# It refuses to finish when the exported tree still names a host, a path or a project that is not this one, in a file's
# contents or in a file's name. The list is scripts/public-deny.txt (not exported), read from <rev> itself, so a commit
# is checked against the list it was committed with. It also refuses an internal-looking doc that has no stub.
# On a hit it prints file names only, never the matched text; a name component that matches is printed as <redacted>.
set -euo pipefail
CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1; shift
  if [ -z "${1:-}" ]; then
    DEST=$(mktemp -d); trap 'rm -rf "$DEST"' EXIT
  else
    # The directory comes first and the revision second, so "--check HEAD" means "work in ./HEAD", and that is how two
    # copies of the whole tree ended up in the repository root and then in a commit (16.11). A first argument that
    # names a commit is a mistake, not a directory: say so instead of making it.
    if [ ! -e "$1" ] && git rev-parse -q --verify "$1^{commit}" >/dev/null 2>&1; then
      echo "refusing: $1 is a revision, and the first argument after --check is the directory to work in." >&2
      echo "          for a check of $1, run: scripts/export-public.sh --check '' $1   (or leave both out for HEAD)" >&2
      exit 2
    fi
    DEST=$1
  fi
else
  DEST=${1:?usage: scripts/export-public.sh <dest-dir> [<rev>] | --check [<tmp-dir>] [<rev>]}
fi
REV=${2:-HEAD}
ROOT=$(git rev-parse --show-toplevel)
git -C "$ROOT" rev-parse -q --verify "$REV^{commit}" >/dev/null || { echo "refusing: $REV is not a commit" >&2; exit 2; }
[ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ] && { echo "$DEST is not empty" >&2; exit 2; }
mkdir -p "$DEST"

# The deny list, from the exported revision (not the working tree): one extended regex per line, # comments.
DENY=$(git -C "$ROOT" show "$REV:scripts/public-deny.txt" 2>/dev/null | grep -v '^\s*#' | grep -v '^\s*$' | paste -sd'|') || true
[ -n "$DENY" ] || { echo "refusing: $REV has no scripts/public-deny.txt or it is empty; nothing to check against" >&2; exit 1; }

git -C "$ROOT" archive "$REV" | tar -x -C "$DEST"

# Internal notes: design notes and the operator's own access, kept private.
STUB='This page is internal design notes and is not published. The public documentation is in docs/README.md.'
STUBBED='docs/stocks-truth-layer-tz.md docs/stocks-passport-agent.md docs/list-locks-tz.md docs/agent-test-tz.md docs/simulate-buy-tz.md docs/b20-transfers-tz.md'
for f in $STUBBED; do
  [ -e "$DEST/$f" ] && printf '# Internal\n\n%s\n' "$STUB" > "$DEST/$f"
done
rm -f "$DEST/scripts/public-deny.txt"

# CI: the private repository runs on our own runner. A public repository must not: anyone's pull request would run
# its code on our machine. The public copy runs on GitHub's hosted runners, read-only token, no secrets.
mkdir -p "$DEST/.github/workflows"
cat > "$DEST/.github/workflows/ci.yml" <<'YML'
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - run: npm ci --no-audit --no-fund
      - run: npm test
      - run: npm run locks
YML

# Dependabot: in the public copy only. Its pull requests there run on GitHub's hosted runners with no secrets; in the
# private repository they would run a new package version's install scripts on our own runner. An update it proposes
# is taken into the private repository and comes back with the next export. One pull request per ecosystem: CodeQL's
# init and analyze only work at the same version, and one at a time they each failed (25.11).
cat > "$DEST/.github/dependabot.yml" <<'YML'
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 2
    groups:
      actions:
        patterns: ['*']
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 2
    groups:
      npm:
        patterns: ['*']
YML

# .gitignore: the private one explains, file by file, what is kept off the repository and why: where the keys live on
# the host, which module is the money path, where a claim of ownership is stored. That is a map of what is worth
# taking, and a public reader needs none of it (owner, 24.11). The public copy gets the plain patterns that keep a
# contributor's own secrets, data and build output out of a pull request, and nothing about our host.
cat > "$DEST/.gitignore" <<'IGN'
node_modules/
coverage/
dist/
build/
.env
.env.*
*.env
!*.env.example
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*
.npmrc
data/
*.jsonl
!tests/**/*.jsonl
*.sqlite
*.sqlite3
*.db
*.ots
*.log
*.tmp
.idea/
.vscode/
.DS_Store
Thumbs.db
.mutation-run-in-progress
IGN

# ---- refusal checks: every one runs, then a single verdict. Output is file names only. ----
fail=0
refuse() { echo "refusing: $*" >&2; fail=1; }
# A path whose name components hit the deny list is printed with those components replaced, so a name never leaks.
show() {
  local out='' c parts
  IFS=/ read -ra parts <<<"$1"
  for c in "${parts[@]}"; do
    if printf '%s\n' "$c" | grep -qiE "$DENY"; then c='<redacted>'; fi
    out=${out:+$out/}$c
  done
  echo "  $out" >&2
}
FILES=$(cd "$DEST" && find . -mindepth 1 -not -path './.git' -not -path './.git/*' | sed 's|^\./||' | LC_ALL=C sort)

# 1. No workflow may run on a self-hosted runner.
if grep -rqi 'self-hosted' "$DEST/.github"; then refuse "a workflow still names a self-hosted runner"; fi

# 1b. The public .gitignore is the plain one: no comment, nothing about the host or the money path.
if grep -qE '^#|/etc/|x402|glama|claim' "$DEST/.gitignore"; then refuse ".gitignore is not the plain public one"; fi

# 2. Every stubbed doc that is exported holds the stub and nothing else.
for f in $STUBBED; do
  if [ -e "$DEST/$f" ] && [ "$(cat "$DEST/$f")" != "$(printf '# Internal\n\n%s' "$STUB")" ]; then refuse "$f is not the stub"; fi
done

# 3. A new internal-looking doc (design notes, agent notes, hand-overs) must be added to STUBBED, not exported as is.
INTERNAL=$(printf '%s\n' "$FILES" | grep -iE '^docs/[^/]*-(tz|agent|notes|internal)\.md$|(^|/)(CLAUDE|AGENTS?|HANDOFF)[^/]*\.md$' || true)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case " $STUBBED " in *" $f "*) ;; *) refuse "an internal-looking doc is exported without a stub (add it to STUBBED):"; show "$f" ;; esac
done <<<"$INTERNAL"

# 4. No file NAME hits the deny list.
rc=0; NAMEHITS=$(printf '%s\n' "$FILES" | grep -iE "$DENY") || rc=$?
case $rc in
  0) refuse "a file name in the public tree names something private:"; while IFS= read -r f; do show "$f"; done <<<"$NAMEHITS" ;;
  1) ;;
  *) refuse "the file-name scan did not finish (grep exit $rc)" ;;
esac

# 5. No file CONTENT hits the deny list. A scan that could not finish (grep exit 2: an unreadable file is not a clean
#    one) is a refusal too.
rc=0; HITS=$(grep -rliE "$DENY" "$DEST" --exclude-dir=.git) || rc=$?
case $rc in
  0) refuse "the public tree still names something private, in:"; while IFS= read -r f; do show "${f#"$DEST"/}"; done <<<"$HITS" ;;
  1) ;;
  *) refuse "the deny-list scan did not finish (grep exit $rc)" ;;
esac

[ "$fail" = 0 ] || { echo "nothing exported" >&2; exit 1; }

if [ "$CHECK" = 1 ]; then
  echo "check passed: $(git -C "$ROOT" rev-parse --short "$REV") exports cleanly ($(printf '%s\n' "$FILES" | grep -c .) paths); nothing committed"
  exit 0
fi

cd "$DEST"
git init -q -b main
git add -A
git -c user.name='Proof of Stock' -c user.email='hello@proofofstock.xyz' commit -q -m "Proof of Stock $(node -p "require('./package.json').version")"
echo "exported $(git -C "$ROOT" rev-parse --short "$REV") to $DEST as one commit: $(git rev-parse --short HEAD), $(git ls-files | wc -l) files"
