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
status=0
for slug in "$@"; do
  wf=${SANITIZE_WORKFLOW:-$(gh workflow list -R "$slug" --all --json path -q '.[].path' | grep -i sanitize | head -1 | xargs -n1 basename 2>/dev/null || true)}
  [ -n "$wf" ] || { echo "no sanitize workflow found in $slug" >&2; status=1; continue; }
  # The run of the rewritten tip — not merely the latest one, which may predate the swap.
  tip=$(gh api "repos/$slug/commits/$MAIN" --jq .sha)
  id=""
  for _ in $(seq 1 40); do
    id=$(gh run list -R "$slug" --workflow "$wf" --branch "$MAIN" -L 20 --json databaseId,headSha \
           -q "map(select(.headSha == \"$tip\")) | .[0].databaseId // empty")
    [ -n "$id" ] && break
    sleep 15
  done
  if [ -z "$id" ]; then echo "no $wf run for the $MAIN tip ${tip:0:12} in $slug" >&2; status=1; continue; fi
  gh run watch "$id" -R "$slug" >/dev/null 2>&1 || true
  gh run rerun "$id" -R "$slug" >/dev/null && echo "re-running $wf run $id (tip ${tip:0:12}) in $slug with the new list"
  sleep 10
  gh run watch "$id" -R "$slug" >/dev/null 2>&1 || true
  c=$(gh run view "$id" -R "$slug" --json conclusion -q .conclusion)
  echo "  $slug: $wf on ${tip:0:12} -> $c"
  [ "$c" = success ] || status=1
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
exit $status
