#!/usr/bin/env bash
# Generic forbidden-pattern scanner over git content, path names and ref names.
# Patterns are injected via $SANITIZE_PATTERNS (extended regex, matched case-insensitively).
# This file intentionally contains no pattern literals — see repo docs on sanitize policy.
#
# Baseline. Everything reachable from the commit $BASELINE is published history
# that cannot be rewritten, and is accepted as it stands. Content scanning
# covers what is new relative to it, plus the tree being checked:
#
#   A  every object reachable from any ref (every branch, every tag, and HEAD)
#      that is not reachable from the baseline — commits (messages included),
#      trees, blobs and annotated tag objects. Reachability is the full closure
#      of the baseline commit, not just the trees at the walk's boundary.
#   B  every blob a commit on HEAD's ancestry since the baseline introduces,
#      diffed against each of its parents separately (a root commit against the
#      empty tree): added, modified and type-changed entries, with no rename
#      detection, so a copy or a rename shows up as an addition. A blob's age
#      does not matter: a baseline blob re-added, copied, renamed, or kept by a
#      merge where one parent had dropped it is scanned like new content, even
#      if a later commit deletes it. Deletions and gitlinks are not content.
#   C  every blob in HEAD's tree.
#
# A commit that only carries baseline content forward unchanged introduces
# nothing, so it is not flagged for that content. B follows HEAD's ancestry
# alone rather than every ref because other refs — a deploy branch, say — can
# carry merges of baseline content that cannot be rewritten either; whatever
# those refs add that is new is still in A. HEAD is the checked-out commit: the
# branch tip on push, the merge ref on a pull request.
#
# Path names (every path in the history of every ref) and ref names are checked
# across the full history, baseline included.
#
# Unreachable objects are deliberately out of scope. They are not part of any
# published history, and on a self-hosted runner the workspace clone is reused
# between runs — a force-pushed-away commit lingers there as a dangling object
# and would otherwise red-light every later PR in the repo, including ones whose
# tree is byte-identical to main, with no content change able to clear it.
set -euo pipefail
P="${SANITIZE_PATTERNS:-}"
if [ -z "$P" ]; then echo "SANITIZE_PATTERNS env var required" >&2; exit 2; fi

# A full commit ID, never a ref name: a ref could be moved to accept anything.
# The override exists for this script's own tests; the workflow does not set it.
BASELINE="${SANITIZE_BASELINE:-0477d8f12d8f643e7d5fe756d14d2e19e7321ccd}"
if ! [[ "$BASELINE" =~ ^[0-9a-f]{40}$ ]] || [ "$(git cat-file -t "$BASELINE" 2>/dev/null)" != "commit" ]; then
  echo "sanitize-scan: baseline $BASELINE is not a full commit ID present in this clone (a full-history checkout is required)" >&2
  exit 2
fi
if ! HEAD_SHA=$(git rev-parse --verify --quiet 'HEAD^{commit}'); then
  echo "sanitize-scan: HEAD does not name a commit" >&2
  exit 2
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sanitize-scan.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# Every git command writes to a file and has its exit status checked before
# anything reads that file. Piped straight into grep, a git process that died
# mid-stream would hand over a short input that counts as zero matches — a
# clean result for a scan that never ran.
run_git() { # run_git <output file> <git arguments...>
  local out=$1
  shift
  git "$@" >"$out" || {
    echo "sanitize-scan: git $1 failed (exit $?); no scan result" >&2
    exit 2
  }
}

# grep -c prints the count and exits 1 when it is zero; that is the only
# non-zero exit a count may absorb. Anything else (a malformed pattern, say)
# is an error, not a clean result.
count_matches() { # count_matches <file> <grep options...>
  local file=$1 n status=0
  shift
  n=$(grep "$@" -c -E "$P" "$file") || status=$?
  if [ "$status" -gt 1 ]; then
    echo "sanitize-scan: grep failed (exit $status); no scan result" >&2
    exit 2
  fi
  echo "$n"
}

# Sets are files of object IDs, one per line, byte-sorted and de-duplicated.
id_set() { LC_ALL=C sort -u; }

run_git "$tmp/baseline.raw" rev-list --objects "$BASELINE"
cut -d' ' -f1 "$tmp/baseline.raw" | id_set >"$tmp/baseline"

# A. `rev-list --not` alone would still list baseline objects that are absent
# from the boundary trees, so the baseline closure is subtracted explicitly.
# A ref can point straight at an annotated tag object, which no commit reaches.
run_git "$tmp/new.raw" rev-list --objects --all --not "$BASELINE"
run_git "$tmp/ref-targets" for-each-ref --format='%(objectname)'
cut -d' ' -f1 "$tmp/new.raw" "$tmp/ref-targets" | id_set | LC_ALL=C comm -23 - "$tmp/baseline" >"$tmp/a"

# B. One "<commit> <parent>" line per parent (a bare "<commit>" for a root,
# which --root compares with the empty tree), diffed in a single process.
run_git "$tmp/ancestry" rev-list --parents "$HEAD_SHA" --not "$BASELINE"
awk '{ if (NF == 1) print $1; else for (i = 2; i <= NF; i++) print $1, $i }' "$tmp/ancestry" >"$tmp/pairs"
run_git "$tmp/introduced.raw" diff-tree --stdin -r --root --no-renames --no-commit-id --diff-filter=d <"$tmp/pairs"
awk '/^:/ && $2 != "160000" && $4 !~ /^0+$/ { print $4 }' "$tmp/introduced.raw" | id_set >"$tmp/b"

# C.
run_git "$tmp/head-tree" ls-tree -r "$HEAD_SHA"
awk '$2 == "blob" { print $3 }' "$tmp/head-tree" | id_set >"$tmp/c"

LC_ALL=C sort -u "$tmp/a" "$tmp/b" "$tmp/c" >"$tmp/scan"

if [ "${SANITIZE_DEBUG:-}" = "1" ]; then
  count() { wc -l <"$1" | tr -d ' '; }
  echo "sanitize-scan: debug A=$(count "$tmp/a") B=$(count "$tmp/b") C=$(count "$tmp/c") scanned=$(count "$tmp/scan")" >&2
fi

run_git "$tmp/contents" cat-file --batch <"$tmp/scan"
run_git "$tmp/paths" rev-list --all --objects
run_git "$tmp/ref-names" for-each-ref --format='%(refname)'
objects=$(count_matches "$tmp/contents" -a -i) || exit 2
paths=$(count_matches "$tmp/paths" -i) || exit 2
refs=$(count_matches "$tmp/ref-names" -i) || exit 2
echo "sanitize-scan: objects=$objects paths=$paths refs=$refs"
if [ "$objects" != "0" ] || [ "$paths" != "0" ] || [ "$refs" != "0" ]; then
  echo "sanitize-scan: FORBIDDEN PATTERN FOUND" >&2
  exit 1
fi
echo "sanitize-scan: clean"
