#!/usr/bin/env bash
# finalize.sh OWNER/REPO... — after swap.sh has run for every repository that shares the pattern
# list: store $CHOS_WORK/config/patterns.txt as the SANITIZE_PATTERNS_SHARED secret of each
# repository, then re-run each one's latest default-branch sanitize run against it.
#
# A pattern added to the shared list before the swap would have turned every gate red on the old
# history, so the list grows only here. The value is never printed.
# Env: CHOS_WORK, CHOS_MAIN (default main), SANITIZE_WORKFLOW (workflow file; default: the first
# workflow whose path contains "sanitize"), CHOS_POLL_TRIES / CHOS_POLL_SECS (waiting for a run or a
# new attempt to appear; default 40 tries, 10 s apart).
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: finalize.sh OWNER/REPO..." >&2; exit 2; }
WORK=${CHOS_WORK:?set CHOS_WORK to this run folder}
MAIN=${CHOS_MAIN:-main}
TRIES=${CHOS_POLL_TRIES:-40}
SECS=${CHOS_POLL_SECS:-10}
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
  for _ in $(seq 1 "$TRIES"); do
    id=$(gh run list -R "$slug" --workflow "$wf" --branch "$MAIN" -L 20 --json databaseId,headSha \
           -q "map(select(.headSha == \"$tip\")) | .[0].databaseId // empty")
    [ -n "$id" ] && break
    sleep "$SECS"
  done
  if [ -z "$id" ]; then echo "no $wf run for the $MAIN tip ${tip:0:12} in $slug" >&2; status=1; continue; fi
  gh run watch "$id" -R "$slug" >/dev/null 2>&1 || true
  # Only a new attempt has read the new secret: a refused rerun, or one that never starts, leaves
  # the previous attempt's conclusion, which says nothing about the new list.
  a0=$(gh run view "$id" -R "$slug" --json attempt -q .attempt)
  if ! gh run rerun "$id" -R "$slug" >/dev/null; then
    echo "  $slug: rerun of $wf run $id was refused — the new list is untested" >&2; status=1; continue
  fi
  echo "re-running $wf run $id (tip ${tip:0:12}) in $slug with the new list"
  a=$a0
  for _ in $(seq 1 "$TRIES"); do
    a=$(gh run view "$id" -R "$slug" --json attempt -q .attempt)
    [ "$a" -gt "$a0" ] && break
    sleep "$SECS"
  done
  if [ "$a" -le "$a0" ]; then
    echo "  $slug: run $id shows no new attempt — the new list is untested" >&2; status=1; continue
  fi
  gh run watch "$id" -R "$slug" >/dev/null 2>&1 || true
  c=$(gh run view "$id" -R "$slug" --json conclusion,attempt -q "select(.attempt == $a) | .conclusion")
  echo "  $slug: $wf on ${tip:0:12} (attempt $a) -> ${c:-unknown}"
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
