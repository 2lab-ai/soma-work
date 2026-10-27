#!/usr/bin/env bash
# Generic forbidden-pattern scanner over git history + refs.
# Patterns are injected via $SANITIZE_PATTERNS (extended regex, matched case-insensitively).
# This file intentionally contains no pattern literals — see repo docs on sanitize policy.
#
# Scope depends on the event that runs it ($GITHUB_EVENT_NAME):
#
#   pull_request — the commit under test (GitHub's merge of the PR into its base)
#     and everything it reaches, plus the PR's branch name. A PR is judged on what
#     it would merge. It used to be judged on every ref in the runner's clone: on
#     2026-10-27 one dirty branch turned every PR and main's push run red for six
#     hours, and the red landed on whoever ran next.
#
#   anything else (push to main, a local run) — HEAD plus every published branch
#     and tag (refs/remotes/origin/*, refs/tags/*). Not `--all`: the runner's clone
#     is reused and keeps refs/remotes/pull/N/merge from earlier PR runs, so a
#     force-pushed-away commit would stay reachable there and red-light every
#     later run. Unreachable objects are out of scope for the same reason.
#
# A hit names the commits that carry it and the published branches that reach
# them. It never prints the matching text: the repository and its logs are public.
set -euo pipefail
P="${SANITIZE_PATTERNS:-}"
if [ -z "$P" ]; then echo "SANITIZE_PATTERNS env var required" >&2; exit 2; fi

if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  pr=1
  revs=(HEAD)
else
  pr=0
  revs=(HEAD --remotes=origin --tags)
fi

git rev-parse --verify -q HEAD >/dev/null || { echo "sanitize-scan: no HEAD to scan" >&2; exit 2; }

# Commits (their messages included), trees, blobs, and, outside a PR, annotated
# tag objects. Every git step must succeed: a failed listing is an error, never
# an empty — and therefore clean — result.
objects() {
  local list tags=''
  list=$(git rev-list --objects "${revs[@]}") || return 1
  [ "$pr" = 1 ] || tags=$(git for-each-ref --format='%(objectname)' refs/tags) || return 1
  { printf '%s\n' "$list" | cut -d' ' -f1; [ -z "$tags" ] || printf '%s\n' "$tags"; } | sort -u
}

object_contents() {
  local ids
  ids=$(objects) || return 1
  printf '%s\n' "$ids" | git cat-file --batch
}

ref_names() {
  if [ "$pr" = 1 ]; then
    printf '%s\n' "${GITHUB_HEAD_REF:-}"
  else
    git for-each-ref --format='%(refname)' refs/remotes/origin refs/tags
  fi
}

# Matching lines in a command's output. Fails closed: only grep's "no match"
# (status 1) counts as zero; any other failure stops the scan with status 2.
count() {
  local r
  r=$("$@" | grep -a -i -c -E "$P"; st=("${PIPESTATUS[@]}"); echo "${st[0]} ${st[1]}") || true
  set -- $r
  if [ "$#" != 3 ] || [ "$2" != 0 ] || [ "$3" -gt 1 ]; then
    echo "sanitize-scan: scan step failed ($*) — not a clean result" >&2
    exit 2
  fi
  echo "$1"
}

a=$(count object_contents)
b=$(count git rev-list --objects "${revs[@]}")
c=$(count ref_names)
echo "sanitize-scan: objects=$a paths=$b refs=$c"
if [ "$a" = "0" ] && [ "$b" = "0" ] && [ "$c" = "0" ]; then
  echo "sanitize-scan: clean"
  exit 0
fi

# Where. Commits whose diff adds or removes a matching line, or whose message
# matches; then which published branches reach each one. Branch names that are
# themselves hits are redacted.
redact() {
  while read -r ref; do
    if printf '%s' "$ref" | grep -q -i -E "$P"; then echo '<redacted ref>'; else echo "$ref"; fi
  done
}
shas=$({
  git log "${revs[@]}" -i -G"$P" --format=%H || true
  git log "${revs[@]}" -i -E --grep="$P" --format=%H || true
} | sort -u)
in_head=0
for sha in $shas; do
  if git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
    in_head=1
    where='in HEAD'
  else
    where='not in HEAD'
  fi
  reach=$( (git for-each-ref --contains "$sha" --format='%(refname:short)' refs/remotes/origin refs/tags || true) | redact | tr '\n' ' ')
  echo "sanitize-scan: hit in commit $sha ($where)${reach:+ — reached by: $reach}" >&2
done
if [ -n "$shas" ] && [ "$pr" = 0 ]; then
  if [ "$in_head" = 1 ]; then
    echo "sanitize-scan: HEAD itself carries a hit" >&2
  else
    echo "sanitize-scan: no attributed hit is in HEAD — they are on the branches named above" >&2
  fi
fi
[ "$c" = "0" ] || echo "sanitize-scan: a branch or tag name is a hit (name withheld)" >&2
if [ -z "$shas" ] && [ "$c" = "0" ]; then
  echo "sanitize-scan: no commit diff or message matched — the hit is in a binary file, a path name or a merge resolution" >&2
fi
echo "sanitize-scan: FORBIDDEN PATTERN FOUND" >&2
exit 1
