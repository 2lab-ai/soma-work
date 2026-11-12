#!/usr/bin/env bash
# rewrite.sh OWNER/REPO — rewrite every branch and tag so that no file, path, commit message,
# author line, tag or ref name carries a text the run's rules replace. Nothing is pushed.
#
# Run folder ($CHOS_WORK):
#   config/replace.txt      rules (see filter-args.py; filename-callback.py applies them to paths)
#   config/patterns.txt     the forbidden patterns, one extended regex per line (verification)
#   config/repo-patterns.txt  optional, extra patterns for this repository only (verification)
#   config/mailmap, config/blob-map.txt, config/filter-args   optional (filter-args.py)
#   config/post-rewrite.sh  optional hook, run in a worktree of the rewritten default branch;
#                           whatever it changes becomes the second post-rewrite commit (docs)
# Output ($CHOS_WORK/out/REPO):
#   orig.git        untouched mirror (rollback source)    snapshot.refs  remote refs at clone time
#   new.git         rewritten repo: refs/heads/<main> = list commit, refs/post/<main> = top commit
#   verify.txt      commit counts, tip-tree diff, pattern hits, gate scan result
#
# Env: CHOS_URL (clone source, default https://github.com/OWNER/REPO.git), CHOS_MAIN (default
# branch, default main), CHOS_REVIEW_BRANCH (branch name never rewritten, default main-rewritten),
# CHOS_DATE (date of the post-rewrite commits; fixed so reruns give the same ids).
# Deterministic: the same remote state in gives the same commit ids out.
set -euo pipefail
SLUG=${1:?usage: rewrite.sh OWNER/REPO}
case $SLUG in */*) ;; *) echo "rewrite.sh: expected OWNER/REPO, got '$SLUG'" >&2; exit 2;; esac
REPO=${SLUG#*/}
WORK=${CHOS_WORK:?set CHOS_WORK to this run folder}
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
CFG=$WORK/config
OUT=$WORK/out/$REPO
URL=${CHOS_URL:-https://github.com/$SLUG.git}
MAIN=${CHOS_MAIN:-main}
REVIEW=${CHOS_REVIEW_BRANCH:-main-rewritten}
[ -f "$CFG/replace.txt" ] || { echo "rewrite.sh: missing $CFG/replace.txt" >&2; exit 2; }
[ -f "$CFG/patterns.txt" ] || { echo "rewrite.sh: missing $CFG/patterns.txt" >&2; exit 2; }
DATE_FILE=$CFG/post-date
[ -f "$DATE_FILE" ] || date +%Y-%m-%dT%H:00:00%z > "$DATE_FILE"
POST_DATE=${CHOS_DATE:-$(cat "$DATE_FILE")}
export CHOS_WORK=$WORK

mkdir -p "$WORK/out" "$WORK/.trash"
if [ -e "$OUT" ]; then mv "$OUT" "$WORK/.trash/$REPO.$(date +%s)"; fi
mkdir -p "$OUT"

echo "==> mirror $URL"
git clone -q --mirror "$URL" "$OUT/orig.git"
git -C "$OUT/orig.git" for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags \
  | grep -v " refs/heads/$REVIEW\$" | sort > "$OUT/snapshot.refs" || true
git clone -q --mirror "$OUT/orig.git" "$OUT/new.git"
cd "$OUT/new.git"
git remote remove origin 2>/dev/null || true
# Pull request refs are read-only on GitHub (only Support can drop them); the review branch is ours.
git for-each-ref --format='delete %(refname)' refs/pull "refs/heads/$REVIEW" | git update-ref --stdin
count_refs() { git for-each-ref refs/heads refs/tags --format='%(refname)' | while read -r r; do echo "$r $(git rev-list --count "$r")"; done; }
count_refs > "$OUT/counts.before"

echo "==> filter-repo"
args=()
while IFS= read -r -d '' a; do args+=("$a"); done < <(python3 -I "$SCRIPTS/filter-args.py")
git filter-repo "${args[@]}" > "$OUT/filter-repo.log" 2>&1
count_refs > "$OUT/counts.after"

echo "==> post-rewrite commits on $MAIN"
export GIT_AUTHOR_DATE=$POST_DATE GIT_COMMITTER_DATE=$POST_DATE
export GIT_AUTHOR_NAME=${CHOS_AUTHOR_NAME:-$(git log -1 --format=%an "$MAIN")}
export GIT_AUTHOR_EMAIL=${CHOS_AUTHOR_EMAIL:-$(git log -1 --format=%ae "$MAIN")}
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
WT=$OUT/wt
git worktree add -q "$WT" "$MAIN"
LIST=$WT/scripts/sanitize-known-leaks.txt
if [ -f "$LIST" ] && grep -qE '^[0-9a-f]{40}' "$LIST"; then
  # Commits listed as published leaks no longer carry the text: the list goes empty.
  { grep '^#' "$LIST"; echo "# $(date +%Y-%m-%d): the history was rewritten and no commit carries the text any more; the list is"
    echo '# empty. A new hit is fixed by rewriting the commit, not by listing it.'; } > "$LIST.new"
  mv "$LIST.new" "$LIST"
  git -C "$WT" commit -q -am "ci(sanitize): empty the known-leaks list after the history rewrite"
fi
LIST_COMMIT=$(git -C "$WT" rev-parse HEAD)
if [ -x "$CFG/post-rewrite.sh" ]; then
  ( cd "$WT" && "$CFG/post-rewrite.sh" )
  if [ -n "$(git -C "$WT" status --porcelain)" ]; then
    git -C "$WT" add -A
    git -C "$WT" commit -q -m "${CHOS_POST_MESSAGE:-docs: the history is rewritten instead of listing known leaks}"
  fi
fi
TOP_COMMIT=$(git -C "$WT" rev-parse HEAD)
git -C "$WT" checkout -q --detach && git worktree remove --force "$WT"
# Two pushes at swap time: <main> = list commit (force), then the top commit on it (fast-forward).
# The second push gives the gate's push run a `before` that exists in the rewritten history.
git update-ref "refs/heads/$MAIN" "$LIST_COMMIT"
git update-ref "refs/post/$MAIN" "$TOP_COMMIT"

echo "==> verify"
P=$(grep -v '^[[:space:]]*$' "$CFG/patterns.txt" | paste -sd'|' -)
{
  echo "repo: $SLUG"
  echo "$MAIN (push 1): $LIST_COMMIT  top commit (push 2): $TOP_COMMIT"
  if diff <(grep -v "^refs/heads/$MAIN " "$OUT/counts.before") <(grep -v "^refs/heads/$MAIN " "$OUT/counts.after") >/dev/null; then
    echo "commit counts: identical on all $(wc -l < "$OUT/counts.after" | tr -d ' ') refs ($MAIN checked separately)"
  else
    echo "commit counts: DIFFER"; { diff "$OUT/counts.before" "$OUT/counts.after" || true; } | head
  fi
  echo "$MAIN: $(git -C "$OUT/orig.git" rev-list --count "$MAIN") commits before, $(git rev-list --count "refs/post/$MAIN") after"
  echo "tip tree differences vs the current remote $MAIN (path only):"
  { diff <(git -C "$OUT/orig.git" ls-tree -r "$MAIN") <(git ls-tree -r "refs/post/$MAIN") || true; } | awk '/^[<>]/ {print "  " $5}' | sort -u
  echo "pattern hits — messages+authors: $(git log --all --format='%B%n%an %ae%n%cn %ce' | grep -ciE "$P" || true)," \
       "tags: $(git for-each-ref refs/tags --format='%(contents)%(taggeremail)' | grep -ciE "$P" || true)," \
       "ref names: $(git for-each-ref --format='%(refname)' | grep -ciE "$P" || true)," \
       "paths: $(git rev-list --objects --all | grep -ciE "$P" || true)," \
       "contents: $(git grep -c -iE "$P" $(git for-each-ref --format='%(refname)' refs/heads refs/tags refs/post) 2>/dev/null | wc -l | tr -d ' ') file(s) at ref tips"
} > "$OUT/verify.txt"

echo "==> gate scan over every rewritten branch and tag"
SCAN=$OUT/scan-wt
git clone -q "$OUT/new.git" "$SCAN"
git -C "$SCAN" fetch -q origin "refs/post/$MAIN"
git -C "$SCAN" checkout -q --detach FETCH_HEAD
if git -C "$SCAN" cat-file -e HEAD:scripts/sanitize-scan.sh 2>/dev/null; then
  git -C "$SCAN" show HEAD:scripts/sanitize-scan.sh > "$OUT/sanitize-scan.sh"
elif [ -f "$CFG/sanitize-scan.sh" ]; then
  cp "$CFG/sanitize-scan.sh" "$OUT/sanitize-scan.sh"
fi
if [ -f "$OUT/sanitize-scan.sh" ]; then
  RP=""; [ -f "$CFG/repo-patterns.txt" ] && RP=$(grep -v '^[[:space:]]*$' "$CFG/repo-patterns.txt" | paste -sd'|' -)
  if ( cd "$SCAN" && unset GITHUB_EVENT_NAME GITHUB_EVENT_PATH GITHUB_BASE_REF GITHUB_HEAD_REF \
         && SANITIZE_PATTERNS_SHARED="$P" SANITIZE_PATTERNS="$RP" bash "$OUT/sanitize-scan.sh" ) > "$OUT/scan.log" 2>&1; then
    echo "scan: clean" >> "$OUT/verify.txt"
  else
    echo "scan: FAILED (see scan.log)" >> "$OUT/verify.txt"
  fi
  tail -2 "$OUT/scan.log" >> "$OUT/verify.txt"
else
  echo "scan: skipped (no scripts/sanitize-scan.sh in the repo and none in config/)" >> "$OUT/verify.txt"
fi
cat "$OUT/verify.txt"
