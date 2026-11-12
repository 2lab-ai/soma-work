#!/usr/bin/env bash
# swap.sh OWNER/REPO — replace every branch and tag of the remote with the history rewrite.sh made.
# Destructive and owner-approved only: needs a git credential that may force-push the default
# branch (lift branch protection for the minute it takes if it blocks force pushes).
#
# 1. if a remote branch or tag moved since rewrite.sh took its snapshot (someone pushed), runs
#    rewrite.sh again and re-checks, up to 5 times
# 2. pauses the workflows in SWAP_PAUSE (space-separated workflow files) — the ones these pushes
#    would start: deploys from rewritten deploy branches, releases from rewritten tags. Needs
#    actions:write; leave SWAP_PAUSE empty when the login lacks it and the pushes start nothing
#    harmful (GitHub creates no push event for a push that carries more than three tags)
# 3. pushes all branches and tags in one atomic push, each leased to its snapshot value: a ref
#    that moved in between makes the whole push fail and nothing changes
# 4. pushes the top commit (docs) on the default branch, a normal fast-forward
# 5. checks the remote now equals the rewritten repo, deletes the review branch
# 6. turns the paused workflows back on (also on failure), and fails naming any it could not
#
# Fail-closed: nothing is pushed unless verify.txt shows 0 pattern hits and `scan: clean`
# (SWAP_ALLOW_UNSCANNED=1 accepts `scan: skipped`). After step 3 succeeds, out/<repo>/swapped
# marks the run: a rerun resumes at step 4 instead of rewriting the already-rewritten remote
# (which would lose the commit map every clone migration needs).
#
# Env: CHOS_WORK (run folder), SWAP_PAUSE, CHOS_MAIN (default main), CHOS_REVIEW_BRANCH
# (default main-rewritten), SWAP_URL (push target; a local path for a dry run).
set -euo pipefail
SLUG=${1:?usage: swap.sh OWNER/REPO}
case $SLUG in */*) ;; *) echo "swap.sh: expected OWNER/REPO, got '$SLUG'" >&2; exit 2;; esac
REPO=${SLUG#*/}
WORK=${CHOS_WORK:?set CHOS_WORK to this run folder}
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
OUT=$WORK/out/$REPO
NEW=$OUT/new.git
MAIN=${CHOS_MAIN:-main}
REVIEW=${CHOS_REVIEW_BRANCH:-main-rewritten}
URL=${SWAP_URL:-https://github.com/$SLUG.git}
[ -d "$NEW" ] || { echo "swap.sh: run rewrite.sh $SLUG first" >&2; exit 1; }

remote_refs() {
  git ls-remote "$URL" 'refs/heads/*' 'refs/tags/*' | grep -v '\^{}$' | grep -v " *refs/heads/$REVIEW\$" \
    | awk '{print $1" "$2}' | sort
}
verified() {
  grep -qE '^pattern hits — messages\+authors: 0, tags: 0, ref names: 0, paths: 0, contents: 0 ' "$OUT/verify.txt" \
    && ! grep -q '^commit counts: DIFFER' "$OUT/verify.txt" \
    && { grep -q '^scan: clean' "$OUT/verify.txt" \
         || { [ "${SWAP_ALLOW_UNSCANNED:-}" = 1 ] && grep -q '^scan: skipped' "$OUT/verify.txt"; }; }
}
attempt=1
[ -e "$OUT/swapped" ] && echo "==> resuming: the branches and tags were already replaced by an earlier run"
while [ ! -e "$OUT/swapped" ]; do
  echo "==> 1. remote unchanged since the rewrite snapshot? (check $attempt)"
  remote_refs > "$OUT/remote-now.refs"
  diff -q "$OUT/snapshot.refs" "$OUT/remote-now.refs" >/dev/null && break
  { diff "$OUT/snapshot.refs" "$OUT/remote-now.refs" || true; } | head -10
  if [ "$attempt" -ge 5 ]; then
    echo "The remote keeps changing (someone is pushing). Ask them to pause, then run this again." >&2
    exit 1
  fi
  echo "    the remote moved: rewriting again (log: $WORK/out-$REPO.rewrite.log)"
  CHOS_URL=${SWAP_URL:-${CHOS_URL:-}} "$SCRIPTS/rewrite.sh" "$SLUG" > "$WORK/out-$REPO.rewrite.log" 2>&1 \
    || { echo "rewrite.sh failed or the rewrite is not clean: see $WORK/out-$REPO.rewrite.log" >&2; exit 1; }
  attempt=$((attempt + 1))
done
if [ ! -e "$OUT/swapped" ] && ! verified; then
  cat "$OUT/verify.txt" >&2
  echo "swap.sh: verify.txt does not show a clean rewrite; nothing pushed" >&2
  exit 1
fi

read -r -a PAUSE <<< "${SWAP_PAUSE:-}"
PAUSED=()
resume() {
  local failed=()
  for w in ${PAUSED[@]+"${PAUSED[@]}"}; do
    if gh workflow enable "$w" -R "$SLUG"; then echo "    enabled $w"; else failed+=("$w"); fi
  done
  PAUSED=()
  if [ ${#failed[@]} -gt 0 ]; then
    echo "swap.sh: could not re-enable: ${failed[*]} — run: gh workflow enable <file> -R $SLUG" >&2
    return 1
  fi
}
trap 'resume || true' EXIT
if [ ${#PAUSE[@]} -eq 0 ]; then
  echo "==> 2. no workflow to pause (SWAP_PAUSE empty)"
else
  echo "==> 2. pause ${PAUSE[*]}"
  for w in "${PAUSE[@]}"; do gh workflow disable "$w" -R "$SLUG"; PAUSED+=("$w"); done
fi

echo "==> 3. replace every branch and tag (atomic, each ref leased to its snapshot value)"
if [ -e "$OUT/swapped" ]; then
  echo "    already done"
else
  leases=()
  while read -r sha ref; do leases+=("--force-with-lease=$ref:$sha"); done < "$OUT/snapshot.refs"
  if ! git -C "$NEW" push --atomic ${leases[@]+"${leases[@]}"} "$URL" 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'; then
    echo "Nothing was changed: a ref moved after the check (stale info) or the push was refused." >&2
    echo "Run this script again; it rewrites again when the remote moved." >&2
    exit 1
  fi
  date > "$OUT/swapped"
fi

echo "==> 4. top commit on $MAIN"
git -C "$NEW" push "$URL" "refs/post/$MAIN:refs/heads/$MAIN"

echo "==> 5. verify the remote"
git -C "$NEW" for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags \
  | sed "s|^[0-9a-f]* refs/heads/$MAIN\$|$(git -C "$NEW" rev-parse "refs/post/$MAIN") refs/heads/$MAIN|" | sort > "$OUT/expected.refs"
remote_refs > "$OUT/remote-after.refs"
if diff -q "$OUT/expected.refs" "$OUT/remote-after.refs" >/dev/null; then
  echo "    remote matches the rewritten repo ($(wc -l < "$OUT/expected.refs" | tr -d ' ') refs)"
else
  echo "    MISMATCH:"; { diff "$OUT/expected.refs" "$OUT/remote-after.refs" || true; } | head -20; exit 1
fi
git -C "$NEW" push -q "$URL" --delete "$REVIEW" 2>/dev/null && echo "    deleted $REVIEW" || true

echo "==> 6. resume workflows"
trap - EXIT
resume || exit 1
echo "done: $SLUG. Next: finalize.sh, then migrate-clone.py for every local clone."
