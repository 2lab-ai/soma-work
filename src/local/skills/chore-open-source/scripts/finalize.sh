#!/usr/bin/env bash
# finalize.sh OWNER/REPO... — after swap.sh has run for every repository that shares the pattern
# list: store $CHOS_WORK/config/patterns.txt as the SANITIZE_PATTERNS_SHARED secret of each
# repository, then re-run each one's latest default-branch sanitize run against it.
#
# A pattern added to the shared list before the swap would have turned every gate red on the old
# history, so the list grows only here. The value is never printed.
# Env: CHOS_WORK, CHOS_MAIN (default main), SANITIZE_WORKFLOW (workflow file; default: the first
# workflow whose path contains "sanitize").
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: finalize.sh OWNER/REPO..." >&2; exit 2; }
WORK=${CHOS_WORK:?set CHOS_WORK to this run folder}
MAIN=${CHOS_MAIN:-main}
VALUE=$(grep -v '^[[:space:]]*$' "$WORK/config/patterns.txt" | paste -sd'|' - | tr -d '\n')
[ -n "$VALUE" ] || { echo "finalize.sh: $WORK/config/patterns.txt is empty" >&2; exit 2; }
for slug in "$@"; do
  printf '%s' "$VALUE" | gh secret set SANITIZE_PATTERNS_SHARED -R "$slug"
  echo "updated SANITIZE_PATTERNS_SHARED in $slug"
done
for slug in "$@"; do
  wf=${SANITIZE_WORKFLOW:-$(gh workflow list -R "$slug" --all --json path -q '.[].path' | grep -i sanitize | head -1 | xargs -n1 basename 2>/dev/null || true)}
  [ -n "$wf" ] || { echo "no sanitize workflow found in $slug"; continue; }
  id=$(gh run list -R "$slug" --workflow "$wf" --branch "$MAIN" --event push -L 1 --json databaseId -q '.[0].databaseId')
  [ -n "$id" ] && gh run rerun "$id" -R "$slug" && echo "re-running $wf run $id in $slug"
done
cat <<'EOF'

Left for the owner (no push reaches these):
  - closed pull requests (refs/pull/*) and cached commit pages keep the old commits until GitHub
    Support removes them: https://support.github.com/request (topic: removing sensitive data).
    Give: owner/repo, number of affected pull requests, the first changed commit(s)
    (out/<repo>/new.git/filter-repo/first-changed-commits).
  - forks keep the old history; only their owners can replace or delete them.
  - every clone keeps the old history: migrate-clone.py <OWNER/REPO> <clone> --apply, or re-clone.
EOF
