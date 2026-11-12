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
WORK=$(cd "$WORK" 2>/dev/null && pwd) || { echo "$(basename "$0"): run folder $CHOS_WORK does not exist" >&2; exit 2; }
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
OUT=$WORK/out/$REPO
NEW=$OUT/new.git
MAIN=${CHOS_MAIN:-main}
REVIEW=${CHOS_REVIEW_BRANCH:-main-rewritten}
URL=${SWAP_URL:-https://github.com/$SLUG.git}
[ -d "$NEW" ] || { echo "swap.sh: run rewrite.sh $SLUG first" >&2; exit 1; }

# Rewrites the value of refs/heads/<main> in "<sha> <ref>" lines. Branch names travel in the
# environment, never inside a program text.
with_main() { M="refs/heads/$MAIN" T=$1 awk '$2 == ENVIRON["M"] { $1 = ENVIRON["T"] } { print }'; }
landed() {
  local proven=0 sha ref was rem
  git -C "$NEW" fetch -q "$URL" '+refs/heads/*:refs/swap-check/heads/*' '+refs/tags/*:refs/swap-check/tags/*' 2>/dev/null || return 1
  while read -r sha ref; do
    was=$(R=$ref awk '$2 == ENVIRON["R"] { print $1 }' "$OUT/snapshot.refs")
    [ "$sha" = "$was" ] && continue                      # not changed by the rewrite: proves nothing
    rem=$(git -C "$NEW" rev-parse -q --verify "refs/swap-check/${ref#refs/}") || continue   # deleted since
    if [ "$rem" = "$sha" ]; then proven=1
    elif [ -n "$was" ] && [ "$rem" = "$was" ]; then proven=0; break   # still the original: not landed
    elif case $ref in refs/heads/*) git -C "$NEW" merge-base --is-ancestor "$sha" "$rem";; *) false;; esac; then proven=1
    else proven=0; break
    fi
  done < <(git -C "$NEW" for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags)
  git -C "$NEW" for-each-ref --format='delete %(refname)' refs/swap-check | git -C "$NEW" update-ref --stdin
  [ "$proven" = 1 ]
}
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
  # An earlier run whose atomic push landed but which stopped before writing the marker. Proof: a ref
  # this rewrite changed is on the remote at its rewritten value (a branch may have moved on from it),
  # and no changed ref is still at its original value — the push is atomic, so it is all or nothing.
  # Resume; rewriting the rewritten remote would replace the commit map clone migration needs.
  if landed; then
    echo "    the remote already holds this rewrite (an earlier push completed): resuming"
    date > "$OUT/swapped"
    break
  fi
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
  for w in "${PAUSE[@]}"; do
    # One that is already off stays off afterwards: only what this run disabled is turned back on.
    state=$(W=$w gh workflow list -R "$SLUG" --all --json path,state -q '.[] | select(.path | endswith("/" + env.W)) | .state')
    case $state in disabled*) echo "    $w is already disabled (left as it is)"; continue;; esac
    gh workflow disable "$w" -R "$SLUG"; PAUSED+=("$w")
  done
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
TOP=$(git -C "$NEW" rev-parse "refs/post/$MAIN")
git -C "$NEW" fetch -q "$URL" "+refs/heads/$MAIN:refs/swap-check/main" 2>/dev/null || true
if git -C "$NEW" merge-base --is-ancestor "$TOP" refs/swap-check/main 2>/dev/null; then
  echo "    $MAIN already contains it"   # a resumed run, possibly after $MAIN moved on
else
  git -C "$NEW" push "$URL" "refs/post/$MAIN:refs/heads/$MAIN"
fi

echo "==> 5. verify the remote"
git -C "$NEW" for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags | with_main "$TOP" | sort > "$OUT/expected.refs"
remote_refs > "$OUT/remote-after.refs"
if diff -q "$OUT/expected.refs" "$OUT/remote-after.refs" >/dev/null; then
  echo "    remote matches the rewritten repo ($(wc -l < "$OUT/expected.refs" | tr -d ' ') refs)"
else
  # Refs that moved or appeared after the replacement (a resumed run, people pushing on the new
  # history) are fine; a ref whose history holds a commit of the original history is not.
  git -C "$NEW" fetch -q "$URL" '+refs/heads/*:refs/swap-check/heads/*' '+refs/tags/*:refs/swap-check/tags/*'
  exp=(); while read -r sha _; do exp+=("^$sha"); done < "$OUT/expected.refs"
  bad=0 moved=0
  while read -r sha ref; do
    grep -qxF "$sha $ref" "$OUT/expected.refs" && continue
    moved=$((moved + 1))
    # An object of the original repository itself (a tag object pushed back, a branch reset to an
    # original commit) is refused outright: its own text — a tag message — is not a commit.
    if git -C "$OUT/orig.git" cat-file -e "$sha" 2>/dev/null; then
      echo "    $ref ${sha:0:12} is an object of the original history"; bad=$((bad + 1)); continue
    fi
    # Read the whole list before counting: `grep -q` would stop early, and under pipefail the
    # writer's SIGPIPE would turn a hit into a pass. A list that cannot be read is a failure.
    if ! list=$(git -C "$NEW" rev-list "$sha" ${exp[@]+"${exp[@]}"}); then
      echo "    $ref ${sha:0:12} could not be read"; bad=$((bad + 1)); continue
    fi
    [ -n "$list" ] || continue
    olds=$(printf '%s\n' "$list" | git -C "$OUT/orig.git" cat-file --batch-check='%(objecttype)' | grep -cx commit || true)
    if [ "${olds:-0}" -gt 0 ]; then
      echo "    $ref ${sha:0:12} carries $olds commit(s) of the original history"; bad=$((bad + 1))
    fi
  done < "$OUT/remote-after.refs"
  git -C "$NEW" for-each-ref --format='delete %(refname)' refs/swap-check | git -C "$NEW" update-ref --stdin
  if [ "$bad" -gt 0 ]; then
    echo "    MISMATCH:"; { diff "$OUT/expected.refs" "$OUT/remote-after.refs" || true; } | head -20; exit 1
  fi
  echo "    remote holds the rewritten history; $moved ref(s) moved or appeared since, all on the new history"
fi
if git ls-remote --exit-code "$URL" "refs/heads/$REVIEW" >/dev/null 2>&1; then
  git -C "$NEW" push -q "$URL" --delete "$REVIEW" && echo "    deleted $REVIEW" \
    || { echo "swap.sh: could not delete the review branch $REVIEW — delete it by hand" >&2; exit 1; }
fi

echo "==> 6. resume workflows"
trap - EXIT
resume || exit 1
echo "done: $SLUG. Next: finalize.sh, then migrate-clone.py for every local clone."
