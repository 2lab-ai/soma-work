#!/usr/bin/env bash
# Generic forbidden-pattern scanner over the FULL git history + refs.
# Patterns are injected via $SANITIZE_PATTERNS (extended regex, matched case-insensitively).
# This file intentionally contains no pattern literals — see repo docs on sanitize policy.
#
# Scope: objects REACHABLE from a ref (every branch, every tag, all of their
# history), plus the paths and ref names themselves. Unreachable objects are
# deliberately out of scope. They are not part of any published history, and on
# a self-hosted runner the workspace clone is reused between runs — a
# force-pushed-away commit lingers there as a dangling object and would
# otherwise red-light every later PR in the repo, including ones whose tree is
# byte-identical to main, with no content change able to clear it.
set -euo pipefail
P="${SANITIZE_PATTERNS:-}"
if [ -z "$P" ]; then echo "SANITIZE_PATTERNS env var required" >&2; exit 2; fi

# Commits (their messages included), trees, blobs, and annotated tag objects.
reachable_objects() {
  {
    git rev-list --objects --all | cut -d' ' -f1
    git for-each-ref --format='%(objectname)'
  } | sort -u
}

a=$(reachable_objects | git cat-file --batch 2>/dev/null | grep -a -i -c -E "$P" || true)
b=$(git rev-list --all --objects | grep -i -c -E "$P" || true)
c=$(git for-each-ref --format='%(refname)' | grep -i -c -E "$P" || true)
echo "sanitize-scan: objects=$a paths=$b refs=$c"
if [ "$a" != "0" ] || [ "$b" != "0" ] || [ "$c" != "0" ]; then
  echo "sanitize-scan: FORBIDDEN PATTERN FOUND" >&2
  exit 1
fi
echo "sanitize-scan: clean"
