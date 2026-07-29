#!/usr/bin/env bash
# Generic forbidden-pattern scanner over the FULL git history + refs.
# Patterns are injected via $SANITIZE_PATTERNS (extended regex, matched case-insensitively).
# This file intentionally contains no pattern literals — see repo docs on sanitize policy.
set -euo pipefail
P="${SANITIZE_PATTERNS:-}"
if [ -z "$P" ]; then echo "SANITIZE_PATTERNS env var required" >&2; exit 2; fi
a=$(git cat-file --batch-all-objects --batch 2>/dev/null | grep -a -i -c -E "$P" || true)
b=$(git rev-list --all --objects | grep -i -c -E "$P" || true)
c=$(git for-each-ref --format='%(refname)' | grep -i -c -E "$P" || true)
echo "sanitize-scan: objects=$a paths=$b refs=$c"
if [ "$a" != "0" ] || [ "$b" != "0" ] || [ "$c" != "0" ]; then
  echo "sanitize-scan: FORBIDDEN PATTERN FOUND" >&2
  exit 1
fi
echo "sanitize-scan: clean"
