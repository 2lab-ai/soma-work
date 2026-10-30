#!/usr/bin/env bash
# Generic forbidden-pattern scanner over git history + refs.
# Patterns are injected via $SANITIZE_PATTERNS (extended regex, matched case-insensitively).
# Keep them plain POSIX ERE: git's regex engine locates hits, and it does not
# know grep-only extensions such as \d, \< or (?i).
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
#
# Known leaks (scripts/sanitize-known-leaks.txt, #610): a commit that is already
# published cannot be taken back by failing every later PR. Listed by full id —
# and only if it is already on the published base (the PR's base branch; main
# before a push), so a change cannot list itself — its own additions are
# tolerated wherever they persist: the matching text in its commit object and in
# the added lines of its diff. Nothing else is: a different hit, another commit
# (a merge's own resolution and a binary file included) adding the same text
# again or repeating it in its message, any path name, a branch or tag name, an
# annotated tag message. The list carries commit ids only, never the text.
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

# What a commit adds: its commit object (message included) and the added lines
# of its diff — binary files as text; for a merge, the lines no parent had (its
# own resolution). Not the `+++` path headers: a path is never known text.
# Never printed.
added_text() {
  local body patch
  body=$(git cat-file commit "$1") || return 1
  patch=$(git show -U0 --text --format= --no-color --no-ext-diff --no-textconv "$1") || return 1
  printf '%s\n' "$body"
  # Hunk lines always start with +, - or a space, so `diff ` opens a file header
  # and `@@` closes it: header lines (paths included) are never content.
  printf '%s\n' "$patch" | awk '/^diff / { h = 1; next } /^@@/ { h = 0; next } !h && /^[+]/ { print substr($0, 2) }'
}

# The commit a listed leak must already be in: the PR's base branch, main as it
# was before this push, or HEAD for a local run. None (no base to check against)
# exempts nothing.
published_base() {
  local before
  if [ "$pr" = 1 ]; then
    [ -n "${GITHUB_BASE_REF:-}" ] || return 1
    git rev-parse --verify -q "refs/remotes/origin/${GITHUB_BASE_REF}^{commit}"
  elif [ "${GITHUB_EVENT_NAME:-}" = push ]; then
    [ -n "${GITHUB_EVENT_PATH:-}" ] || { git rev-parse --verify -q 'HEAD^{commit}'; return; }
    before=$(awk 'match($0, /"before": *"[0-9a-f]+"/) { s = substr($0, RSTART, RLENGTH); sub(/.*: *"/, "", s); sub(/"$/, "", s); print s; exit }' "$GITHUB_EVENT_PATH") || return 1
    [[ "$before" =~ ^[0-9a-f]{40}$ ]] || return 1
    git rev-parse --verify -q "${before}^{commit}"
  else
    git rev-parse --verify -q 'HEAD^{commit}'
  fi
}

# KNOWN: the matches listed commits added, one per line. An unreadable listed
# commit is an error, never an empty exemption.
KNOWN=$(mktemp "${TMPDIR:-/tmp}/sanitize-known.XXXXXX") || exit 2
trap 'rm -f "$KNOWN"' EXIT
exempt=()
list="$(git rev-parse --show-toplevel)/scripts/sanitize-known-leaks.txt"
if [ -f "$list" ]; then
  base=$(published_base) || base=''
  while read -r sha _ || [ -n "${sha:-}" ]; do
    case "$sha" in '' | '#'*) continue ;; esac
    if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
      echo "sanitize-scan: $list: entries are full 40-hex commit ids — not a clean result" >&2
      exit 2
    fi
    if [ "$(git cat-file -t "$sha" 2>/dev/null)" != commit ]; then
      echo "sanitize-scan: known leak $sha is not a commit in this clone — nothing exempted for it" >&2
      continue
    fi
    if [ -z "$base" ] || ! git merge-base --is-ancestor "$sha" "$base" 2>/dev/null; then
      echo "sanitize-scan: known leak $sha is not on the published base — nothing exempted for it" >&2
      continue
    fi
    text=$(added_text "$sha") && { printf '%s\n' "$text" | grep -a -i -o -E "$P" >>"$KNOWN" || [ "$?" = 1 ]; } || {
      echo "sanitize-scan: could not read known leak $sha — not a clean result" >&2
      exit 2
    }
    exempt+=("$sha")
  done <"$list"
fi
is_exempt() {
  local e
  for e in ${exempt[@]+"${exempt[@]}"}; do [ "$e" = "$1" ] && return 0; done
  return 1
}

# Commits (their messages included), trees and blobs. Every git step must
# succeed: a failed listing is an error, never an empty — and therefore clean —
# result.
object_contents() {
  local list
  list=$(git rev-list --objects "${revs[@]}") || return 1
  printf '%s\n' "$list" | cut -d' ' -f1 | sort -u | git cat-file --batch
}

# Outside a PR, annotated tag objects (their messages): never exempt.
tag_contents() {
  local tags
  [ "$pr" = 0 ] || return 0
  tags=$(git for-each-ref --format='%(objectname) %(objecttype)' refs/tags) || return 1
  printf '%s\n' "$tags" | awk '$2 == "tag" { print $1 }' | git cat-file --batch
}

ref_names() {
  if [ "$pr" = 1 ]; then
    printf '%s\n' "${GITHUB_HEAD_REF:-}"
  else
    git for-each-ref --format='%(refname)' refs/remotes/origin refs/tags
  fi
}

# Matches in a command's output, as "unknown known": a match equal to text a
# listed commit added is known (`known` is the file of that text — /dev/null for
# what is never exempt). Fails closed: only grep's "no match" (status 1) counts
# as zero; any other failure stops the scan with status 2.
count() {
  local r known=$1
  shift
  r=$("$@" | grep -a -i -o -E "$P" | awk -v kf="$known" '
    BEGIN { while ((getline l < kf) > 0) k[l] = 1 }
    { if ($0 in k) n++; else u++ }
    END { print u + 0, n + 0 }'; st=("${PIPESTATUS[@]}"); echo "${st[0]} ${st[1]} ${st[2]}") || true
  set -- $r
  if [ "$#" != 5 ] || [ "$3" != 0 ] || [ "$4" -gt 1 ] || [ "$5" != 0 ]; then
    echo "sanitize-scan: scan step failed (${*:3}) — not a clean result" >&2
    exit 2
  fi
  echo "$1 $2"
}

# A failing count exits its own subshell with 2: check each before reading it.
r=$(count "$KNOWN" object_contents) || exit 2
read -r a ka <<<"$r"
r=$(count /dev/null git rev-list --objects "${revs[@]}") || exit 2
read -r b _ <<<"$r"
r=$(count /dev/null tag_contents) || exit 2
read -r t _ <<<"$r"
r=$(count /dev/null ref_names) || exit 2
read -r c _ <<<"$r"
known=$ka
echo "sanitize-scan: objects=$a paths=$b tags=$t refs=$c known=$known"
if [ "$a$b$t$c$known" = "00000" ]; then
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
# A commit is a hit when what it adds matches. A listed commit is a known leak;
# a commit that only removes matching lines is the cleanup, and a clean merge
# adds nothing of its own. Unreadable means hit.
adds_hit() {
  local text n
  text=$(added_text "$1") || return 0
  n=$(printf '%s\n' "$text" | grep -a -i -c -E "$P") || true
  [ "${n:-0}" != 0 ]
}
attributed=1
shas=$({
  git log "${revs[@]}" -m --text -i -G"$P" --format=%H 2>/dev/null &&
    git log "${revs[@]}" -i -E --grep="$P" --format=%H 2>/dev/null
} | sort -u) || attributed=0
in_head=0
hits=0
for sha in $shas; do
  # Ids only reach the log: anything else from git log is an attribution failure.
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    attributed=0
    continue
  fi
  if is_exempt "$sha"; then
    echo "sanitize-scan: known leak $sha — exempted (scripts/sanitize-known-leaks.txt)" >&2
    continue
  fi
  if ! adds_hit "$sha"; then
    echo "sanitize-scan: commit $sha adds no matching text of its own (a removal, or a merge of known text)" >&2
    continue
  fi
  hits=1
  if git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
    in_head=1
    where='in HEAD'
  else
    where='not in HEAD'
  fi
  reach=$(git for-each-ref --contains "$sha" --format='%(refname:short)' refs/remotes/origin refs/tags | redact | tr '\n' ' ') ||
    reach='(branch lookup failed)'
  echo "sanitize-scan: hit in commit $sha ($where)${reach:+ — reached by: $reach}" >&2
done
# Only known text was found: clean, once attribution shows no other commit added it.
if [ "$a$b$t$c" = "0000" ] && [ "$attributed" = 1 ] && [ "$hits" = 0 ]; then
  echo "sanitize-scan: clean — $known match(es) are known-leak text, and no other commit adds it"
  exit 0
fi
if [ "$a$b$t$c" = "0000" ] && [ "$attributed" = 0 ]; then
  echo "sanitize-scan: could not tell whether another commit adds known-leak text (git log failed) — not a clean result" >&2
  exit 2
fi
if [ "$hits" = 1 ] && [ "$pr" = 0 ]; then
  if [ "$in_head" = 1 ]; then
    echo "sanitize-scan: HEAD itself carries a hit" >&2
  else
    echo "sanitize-scan: no attributed hit is in HEAD — they are on the branches named above" >&2
  fi
fi
[ "$c" = "0" ] || echo "sanitize-scan: a branch or tag name is a hit (name withheld)" >&2
[ "$t" = "0" ] || echo "sanitize-scan: an annotated tag message is a hit" >&2
if [ "$attributed" = 0 ]; then
  echo "sanitize-scan: could not attribute the hit (git log failed; a pattern git cannot compile?) — rerun the scan locally to locate it" >&2
elif [ "$hits" = 0 ] && [ "$c$t" = "00" ]; then
  echo "sanitize-scan: no commit diff or message matched — the hit is in a binary file, a path name, a merge resolution, an annotated tag message, or uses a grep-only regex extension" >&2
fi
echo "sanitize-scan: FORBIDDEN PATTERN FOUND" >&2
exit 1
