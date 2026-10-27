#!/usr/bin/env bash
# chore.sh — repo hygiene engine: report (read-only) → approved plan → apply → verify
#
# usage:
#   chore.sh report <repo> --plan <tsv> [--json <file>] [--protect GLOB]... [--integrate REF]... [--no-local] [--print]
#   chore.sh apply  <repo> --plan <tsv> --digest <sha256> [--tiers 1|2|1,2] [--yes] [--only-group G]...
#   chore.sh verify <repo> --plan <tsv> --results <apply-stdout-file> [--digest <sha256>]
#   chore.sh check-plan --plan <tsv>   the plan grammar alone (no repo, no network): exit 0 = apply would parse it
#   chore.sh penc | pdec        plan value codec for hand-added rows (stdin → stdout)
#
#   <repo> = short name | owner/repo | GitHub URL — always resolved through the registry file named by CHORE_REPOS_MD.
#   CHORE_REPOS_MD (required by report / apply / verify; no default) = path of the registry, a markdown table whose rows
#   are `| name | local path | owner/repo | note |`. The git work tree that contains the registry is never a target.
#
# Two sets decide everything; both come from live GitHub + git state and fail closed:
#   P (never touched) = default ∪ protected branches ∪ active branch rulesets ∪ environment branch
#     policies ∪ workflow push/pull_request branch filters (read from every P tree until no new
#     name appears) ∪ OPEN PR heads (same repo) and bases ∪ --protect ∪ --integrate
#   I (refs whose history counts as evidence) = default ∪ --integrate, and I ⊆ P
# The only delete basis is (a): a same-repo MERGED PR into an I ref whose head oid equals the
# branch tip and whose merge commit is in the current history of that I ref. Everything else is
# tier 3 (held). Commit age never decides a delete.
#
# Plan v3 (TSV) = the approval contract: one header line `#chore-plan v3<TAB>key=value...`, then
# rows of exactly six columns `tier action ref expected snapshot evidence`. tier 1 = local ops,
# tier 2 = remote deletes and closes (needs --yes), tier 3 = report only. Header values, snapshot
# values, ref and evidence are percent-encoded (% ; , = : and control chars; header values also
# space), so any refname or multi-line comment round-trips. apply needs the approved sha256 and
# re-checks every row against live state right before acting. A local branch is deleted only while it
# is at the approved oid. What it cannot see — a PR opened or an integration ref rewound after its last
# check, another worktree checking the branch out or starting a rebase/bisect on it after the check —
# stays outside what it guarantees.
#
# Plan v4 rows on top of v3: tier-2 `jira-transition jira#KEY` (move one Jira ticket, comment first), tier-2
# `move-issue issue#N` (v4.3: a kept GitHub issue becomes a new ticket in the bound Jira project, then the issue gets the
# key and is closed) and tier-3 report rows `jira#KEY` / `jira#PROJECT`. scripts/chore_plan.py is the authoritative parser
# of every row kind; parse_plan runs its `check` before the awk parser below, which only has to accept what it accepts.
# apply runs the Jira-helper rows (jira-transition and move-issue) after the closes as ONE helper process (chore-jira.py
# apply-rows, the only Jira writer of the attempt; it journals every write in <git-common-dir>/chore/<run_id>.journal),
# verify hands them to chore-jira.py verify-rows.
set -euo pipefail
export LC_ALL=C GH_PROMPT_DISABLED=1

SCRIPTDIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PLAN_PY="${CHORE_PLAN_PY:-$SCRIPTDIR/chore_plan.py}"
JUDGE="${CHORE_JUDGE:-$SCRIPTDIR/chore-judge.py}"
# CHORE_JIRA (tests) = an executable used instead of the Jira helper; either way it is started as a direct child
if [ -n "${CHORE_JIRA:-}" ]; then JIRA_CMD=("$CHORE_JIRA"); else JIRA_CMD=(python3 -I "$SCRIPTDIR/chore-jira.py"); fi
REPOS_MD="${CHORE_REPOS_MD:-}"          # checked in main before any repo, git or network work
STALE_DAYS="${CHORE_STALE_DAYS:-30}"
RUBY="${CHORE_RUBY:-/usr/bin/ruby}"
BATCH="${CHORE_BATCH:-50}"
case "$BATCH" in ""|*[!0-9]*|0*) echo "chore: CHORE_BATCH must be a positive integer" >&2; exit 1 ;; esac
TAB=$(printf '\t')

LAST_ERR=""
die() { LAST_ERR="$*"; echo "chore: $*" >&2; exit 1; }
note() { echo "chore: $*" >&2; }
redact() { printf '%s' "$1" | sed -E 's#//[^/@]*@#//***@#'; }

# Once apply has started acting (APPLY_ACTING=1), any stop before SUMMARY — die, a failed control-file
# read, a failed batch-boundary recheck, a TERM/INT/HUP — settles every row of this run that got no
# RESULT: a row whose external change was already sent (recorded in sent.keys right before the push / gh
# close / git branch / worktree prune) = RESULT UNKNOWN "sent at <at>, outcome unread" (no network call
# here — verify reconciles against the remote), a row never sent = RESULT NOT-ATTEMPTED. Then one ABORTED
# line — always, even when the rows cannot be listed (unattempted=?) — and exit 1.
# Jira-helper rows (jira-transition, move-issue): the helper still running is sent TERM and waited for (its in-flight call journals its own outcome),
# the RESULT lines it printed and this run has not yet taken are taken, and every other Jira row of run.keys is
# settled from the journal: a complete journal line of this attempt for the row (or a journal that cannot be read)
# = UNKNOWN, none = NOT-ATTEMPTED — both with the 6th column attempt=<id>.
T=""; APPLY_ACTING=0; FINISHED=0; ABORT_AT="start"
ATTEMPT=""; SCOPE=""; CHDIR=""; JOURNAL=""; JLOCK=""
JIRA_PID=""; JIRA_STARTED=0; JIRA_N=0; JIRA_READ_DONE=0; JIRA_SIG=0
cleanup() { if [ -n "$T" ]; then rm -rf "$T"; fi; }
mark_sent() { printf '%s\t%s\n' "$1" "$2" >> "$T/sent.keys"; }
jres() { # status action ref reason → one Jira-helper RESULT line of this attempt (reason: TAB / CR / LF → one space each)
  local r; r=$(printf '%s' "$4" | tr '\t\n\r' '   ')
  printf 'RESULT\t%s\t%s\t%s\t%s\tattempt=%s\n' "$1" "$2" "$3" "$r" "$ATTEMPT"
}
# journal → the refs this attempt (CH_AT) wrote to; awk -v n=<complete lines>. Line = <instant> <attempt> <ref> <event>
# [<comment id>]; bytes after the last newline are a torn write, not a line. A `*-sent` answered by its `*-withdrawn`
# (the helper stopped before the request left) is no write; any other line is. Same count as chore-jira.py
# journaled_count (__tests__/py/chore.test.sh case 110 feeds both the same journals).
P_JOURNALED='
NR <= n + 0 && $2 == ENVIRON["CH_AT"] {
  r = $3; e = $4; k = e; sub(/-[a-z]+$/, "", k)
  if (e ~ /-withdrawn$/ && p[r, k] > 0) { p[r, k]--; w[r]--; next }
  if (e ~ /-sent$/) p[r, k]++
  else if (e ~ /-(ok|rejected)$/ && p[r, k] > 0) p[r, k]--
  w[r]++
}
END { for (r in w) if (w[r] > 0) print r }'
jira_journaled() { # → $T/jira.jr = refs with a complete journal line of this attempt; rc 1 = the journal cannot be read
  local nl
  : > "$T/jira.jr" || return 1
  if [ ! -e "$JOURNAL" ] && [ ! -L "$JOURNAL" ]; then return 0; fi   # never created = nothing was sent
  if [ ! -f "$JOURNAL" ] || [ ! -r "$JOURNAL" ]; then return 1; fi
  cp "$JOURNAL" "$T/journal.snap" 2>/dev/null || return 1
  nl=$(tr -cd '\n' < "$T/journal.snap" | wc -l | tr -d ' ') || return 1
  CH_AT="$ATTEMPT" awk -v n="${nl:-0}" "$P_JOURNALED" "$T/journal.snap" > "$T/jira.jr" || return 1
}
apply_abort_report() {
  local n=0 kind action ref why tail jr=0
  why="$LAST_ERR"; if [ -z "$why" ] && [ -s "$T/awk.err" ]; then why=$(head -1 "$T/awk.err"); fi
  why=$(printf '%s' "${why:-stopped}" | tr '\t\n\r' '   ')
  if [ -n "$JIRA_PID" ]; then kill -TERM "$JIRA_PID" 2>/dev/null; wait "$JIRA_PID" 2>/dev/null; JIRA_PID=""; fi
  if [ "$JIRA_STARTED" = 1 ] && [ "$JIRA_READ_DONE" = 0 ]; then jira_take abort; fi
  # the journal speaks only for an attempt whose helper was started; before that no Jira write of this run exists
  if [ "$JIRA_STARTED" = 1 ]; then jira_journaled || jr=1; else : > "$T/jira.jr"; fi
  tail="attempt=$ATTEMPT${TAB}scope=$SCOPE${TAB}journal=$JOURNAL"
  if ! awk -F'\t' 'FILENAME == ARGV[1] { d[$0] = 1; next } FILENAME == ARGV[2] { f[$0] = 1; next }
      !($0 in d) { print (($0 in f) ? "F" : "N") "\t" $0 }' "$T/done.keys" "$T/sent.keys" "$T/run.keys" > "$T/unatt"; then
    printf 'ABORTED\trun_id=%s\tat=%s\tok=%d\tskip=%d\tfail=%d\tunknown=%d\tunattempted=?\treason=%s; rows could not be listed\t%s\n' \
      "$H_RUN_ID" "$ABORT_AT" "$N_OK" "$N_SKIP" "$N_FAIL" "$N_UNK" "$why" "$tail"
    return 0
  fi
  while IFS="$TAB" read -r kind action ref; do
    if [ "$action" = jira-transition ] || [ "$action" = move-issue ]; then
      if [ "$jr" = 1 ]; then jres UNKNOWN "$action" "$ref" "journal unreadable at abort (run aborted at $ABORT_AT)"
      elif has_line "$ref" "$T/jira.jr"; then jres UNKNOWN "$action" "$ref" "journal has a write of this attempt, outcome unread (run aborted at $ABORT_AT)"
      else jres NOT-ATTEMPTED "$action" "$ref" "run aborted at $ABORT_AT"; n=$((n+1)); continue
      fi
      printf '%s\t%s\n' "$action" "$ref" >> "$T/done.keys"
      N_UNK=$((N_UNK+1)); continue
    fi
    if [ "$kind" = N ]; then
      printf 'RESULT\tNOT-ATTEMPTED\t%s\t%s\trun aborted at %s\n' "$action" "$ref" "$ABORT_AT"; n=$((n+1)); continue
    fi
    printf 'RESULT\tUNKNOWN\t%s\t%s\tsent at %s, outcome unread\n' "$action" "$ref" "$ABORT_AT"
    printf '%s\t%s\n' "$action" "$ref" >> "$T/done.keys"
    N_UNK=$((N_UNK+1))
  done < "$T/unatt"
  printf 'ABORTED\trun_id=%s\tat=%s\tok=%d\tskip=%d\tfail=%d\tunknown=%d\tunattempted=%d\treason=%s\t%s\n' \
    "$H_RUN_ID" "$ABORT_AT" "$N_OK" "$N_SKIP" "$N_FAIL" "$N_UNK" "$n" "$why" "$tail"
}
# the traps can fire inside a redirected call (`g push … > push.out`, `ak … > file`): the receipt goes to the
# stdout / stderr this script was started with, kept on fds 9 / 8
exec 9>&1 8>&2
on_exit() {
  local rc=$?
  trap '' TERM INT HUP          # a second signal must not cut the receipt short or skip cleanup
  if [ "$APPLY_ACTING" = 1 ] && [ "$FINISHED" = 0 ]; then
    set +e; apply_abort_report >&9; rc=1
    echo "chore: apply stopped at $ABORT_AT (${LAST_ERR:-see above}) — ABORTED receipt written; verify it before any rerun (its reason decides)" >&8
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT
on_signal() { LAST_ERR="terminated by signal"; exit 143; }
trap on_signal TERM INT HUP
T=$(mktemp -d "${TMPDIR:-/tmp}/chore.XXXXXX")
export CHT="$T"

# every gh call fails closed: an error never turns into an empty answer
ghq() { local out; out=$(gh "$@") || die "gh failed: $*"; printf '%s' "$out"; }
ghq_to() { local f="$1"; shift; gh "$@" > "$f" || die "gh failed: $*"; }

plan_digest() { { shasum -a 256 "$1" 2>/dev/null || sha256sum "$1"; } | awk '{ print $1 }'; }

# ---------- value codec (shared by every awk program) ----------
# penc: % ; , = : 0x01-0x1F 0x7F (and space when sp=1) → %XX uppercase. pdec: its exact inverse;
# rejects malformed, truncated, NUL and non-canonical escapes (incl. %20 where space is not encoded)
# and raw bytes that should have been encoded (sets _bad). rl: the one reader for control files — a
# missing or unreadable file stops the program (exit 3), never reads as empty. gmatch: `*`-only glob
# where `*` also crosses `/`, like bash case (wider than GitHub = protects more). grp: the one group
# function behind groups=, JSON group and --only-group: grp(ref, action).
AWK_LIB='
function rl(f,   r) {
  r = (getline _L < f)
  if (r < 0) {
    printf "cannot read control file %s\n", f > (ENVIRON["CHT"] "/awk.err")
    printf "chore: cannot read control file %s\n", f > "/dev/stderr"
    exit 3
  }
  return r
}
function _ei(   i) {
  _hx = "0123456789ABCDEF"
  for (i = 1; i < 128; i++) _ord[sprintf("%c", i)] = i
  for (i = 1; i < 32; i++) _esc[sprintf("%c", i)] = 1
  _esc[sprintf("%c", 127)] = 1; _esc["%"] = 1; _esc[";"] = 1; _esc[","] = 1; _esc["="] = 1; _esc[":"] = 1
  _ok = 1
}
function penc(s, sp,   o, i, n, c, v) {
  if (s ~ /^[A-Za-z0-9._\/@+#-]*$/) return s
  if (!_ok) _ei()
  o = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if ((c in _esc) || (sp && c == " ")) { v = _ord[c]; o = o "%" substr(_hx, int(v / 16) + 1, 1) substr(_hx, v % 16 + 1, 1) }
    else o = o c
  }
  return o
}
function pdec(s, sp,   o, i, n, c, h1, h2, v) {
  _bad = 0
  if (s ~ /^[A-Za-z0-9._\/@+#-]*$/) return s
  if (!_ok) _ei()
  o = ""; n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "%") {
      if (i + 2 > n) { _bad = 1; return "" }
      h1 = index(_hx, substr(s, i + 1, 1)); h2 = index(_hx, substr(s, i + 2, 1))
      if (h1 == 0 || h2 == 0) { _bad = 1; return "" }
      v = (h1 - 1) * 16 + h2 - 1
      if (v == 0 || v > 127) { _bad = 1; return "" }
      c = sprintf("%c", v)
      if (!((c in _esc) || (sp && c == " "))) { _bad = 1; return "" }
      o = o c; i += 3; continue
    }
    if ((c in _esc) || (sp && c == " ")) { _bad = 1; return "" }
    o = o c; i++
  }
  return o
}
function iso(x,   y, mo, d, h, mi, sc, dim) {   # YYYY-MM-DDTHH:MM:SSZ that is a real UTC calendar time
  if (x !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/) return 0
  y = substr(x, 1, 4) + 0; mo = substr(x, 6, 2) + 0; d = substr(x, 9, 2) + 0
  h = substr(x, 12, 2) + 0; mi = substr(x, 15, 2) + 0; sc = substr(x, 18, 2) + 0
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sc > 59) return 0
  dim = substr("312831303130313130313031", mo * 2 - 1, 2) + 0
  if (mo == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0)) dim = 29
  return d <= dim
}
function hasctl(s,   i, n, c) {
  if (!_ok) _ei()
  n = length(s)
  for (i = 1; i <= n; i++) { c = substr(s, i, 1); if ((c in _esc) && index("%;,=:", c) == 0) return 1 }
  return 0
}
function gmatch(s, p,   n, seg, i, pos, k, ls) {
  n = split(p, seg, "*")
  if (n == 1) return s == p
  if (substr(s, 1, length(seg[1])) != seg[1]) return 0
  pos = length(seg[1]) + 1
  for (i = 2; i < n; i++) {
    if (seg[i] == "") continue
    k = index(substr(s, pos), seg[i])
    if (k == 0) return 0
    pos = pos + k - 1 + length(seg[i])
  }
  ls = length(seg[n])
  if (length(s) - ls + 1 < pos) return 0
  return ls == 0 || substr(s, length(s) - ls + 1) == seg[n]
}
function rdec(ref,   p) { p = ""; if (ref ~ /^(remote|local):/) { p = substr(ref, 1, index(ref, ":")); ref = substr(ref, length(p) + 1) }; return p pdec(ref, 0) }
function grp(ref, action,   name, i) {
  if (action == "close-pr") return "pull-requests"
  if (action == "close-issue") return "issues"
  if (action == "jira-transition" || (action == "report" && ref ~ /^jira#/)) return "jira"
  if (action == "move-issue") return "move"
  if (action == "report" && ref ~ /^pr#[0-9]+$/) return "pull-requests"
  if (action == "report" && ref ~ /^issue#[0-9]+$/) return "issues"
  if (ref == ".") return "worktree"
  name = ref; sub(/^(remote|local):/, "", name)
  i = index(name, "/")
  if (i > 0) return substr(name, 1, i - 1) "/*"
  return name
}
'
ak() { local p="$1"; shift; awk -F'\t' -v OFS='\t' "$AWK_LIB$p" "$@"; }
penc1() { CH_V="$1" CH_SP="${2:-0}" awk "$AWK_LIB"'BEGIN { printf "%s", penc(ENVIRON["CH_V"], ENVIRON["CH_SP"] + 0) }'; }
pdec1() { CH_V="$1" awk "$AWK_LIB"'BEGIN { v = pdec(ENVIRON["CH_V"], 0); if (_bad) exit 3; printf "%s", v }'; }
has_line() { CH_N="$1" awk '$0 == ENVIRON["CH_N"] { f = 1 } END { exit f ? 0 : 1 }' "$2"; }

# the same encoder in jq (gh data); hrepo = lowercased head owner/name, "unknown" when untrustworthy
JQ_LIB='def penc: if test("^[A-Za-z0-9._/@+#-]*$") then . else [explode[] | if (. < 32 or . == 127 or . == 37 or . == 59 or . == 44 or . == 61 or . == 58) then "%" + ("0123456789ABCDEF"[(. / 16 | floor):(. / 16 | floor) + 1]) + ("0123456789ABCDEF"[(. % 16):(. % 16) + 1]) else ([.] | implode) end] | join("") end;
def hrepo($r): (((.headRepositoryOwner.login // "") + "/" + (.headRepository.name // "")) | ascii_downcase) as $h
  | if ($h | startswith("/")) or ($h | endswith("/")) then "unknown"
    elif .isCrossRepository == false then $h
    elif $h == $r then "unknown" else $h end;
'

# ---------- repo identity ----------
resolve_repo() { # $1 = name | owner/repo | url → LOCAL, REMOTE, REMOTE_LC, OWNER, NAME (REPOS_MD already checked)
  local in="$1" row home here re='github\.com[/:]([^/]+)/([^/]+)'
  if [[ "$in" =~ $re ]]; then in="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"; in="${in%.git}"; fi
  if [[ "$in" == */* ]]; then
    row=$(awk -F'|' -v r="$in" '/^\|/ { x = $4; gsub(/[ `]/, "", x); if (tolower(x) == tolower(r)) { print; exit } }' "$REPOS_MD")
  else
    row=$(awk -F'|' -v n="$in" '/^\|/ { x = $2; gsub(/[ `]/, "", x); if (x == n) { print; exit } }' "$REPOS_MD")
  fi
  [ -n "$row" ] || die "repo '$in' not in $REPOS_MD — register it first (never guess a path)"
  LOCAL=$(printf '%s\n' "$row" | awk -F'|' '{ x = $3; gsub(/[ `]/, "", x); print x }')
  LOCAL="${LOCAL/#\~/$HOME}"
  REMOTE=$(printf '%s\n' "$row" | awk -F'|' '{ x = $4; gsub(/[ `]/, "", x); print x }')
  [ -d "$LOCAL/.git" ] || [ -f "$LOCAL/.git" ] || die "local path $LOCAL is not a git checkout"
  # the registry's home = the top level of the git work tree that contains the registry file (none when it is not in
  # one); the clone of the target must not be that work tree. Both sides physical (pwd -P), so a symlink is no way around.
  home=$(git -C "$(dirname -- "$REPOS_MD")" rev-parse --show-toplevel 2>/dev/null) || home=""
  if [ -n "$home" ]; then
    home=$(CDPATH= cd -- "$home" && pwd -P) || die "cannot resolve the registry's work tree $home"
    here=$(CDPATH= cd -- "$LOCAL" && pwd -P) || die "cannot resolve local path $LOCAL"
    [ "$here" != "$home" ] || die "refusing to run on the registry's own repository ($here holds $REPOS_MD)"
  fi
  REMOTE_LC=$(printf '%s' "$REMOTE" | tr 'A-Z' 'a-z')
  case "$REMOTE_LC" in
    */*/*|/*|*/) die "bad remote '$REMOTE' in registry" ;;
    */*) ;;
    *) die "bad remote '$REMOTE' in registry" ;;
  esac
  OWNER="${REMOTE%%/*}"; NAME="${REMOTE#*/}"
  export CH_REMOTE="$REMOTE_LC"
}

g() { git -C "$LOCAL" "$@"; }

norm_url() { # github ssh/https URL → lowercase owner/repo; anything else → ?
  local u="$1" p
  case "$u" in
    git@github.com:*) p="${u#git@github.com:}" ;;
    ssh://git@github.com/*) p="${u#ssh://git@github.com/}" ;;
    https://github.com/*) p="${u#https://github.com/}" ;;
    *) printf '?'; return 0 ;;
  esac
  p="${p%/}"; p="${p%.git}"
  case "$p" in
    */*/*|/*|*/|"") printf '?' ;;
    */*) printf '%s' "$p" | tr 'A-Z' 'a-z' ;;
    *) printf '?' ;;
  esac
}

check_identity() { # exactly one fetch and one push URL, both = REMOTE; repo id + default from GitHub
  local urls pushes nu np
  urls=$(g remote get-url --all origin 2>/dev/null) || die "repo has no origin remote"
  pushes=$(g remote get-url --push --all origin 2>/dev/null) || die "cannot read the origin push URL"
  nu=$(printf '%s\n' "$urls" | awk 'NF { n++ } END { print n + 0 }')
  np=$(printf '%s\n' "$pushes" | awk 'NF { n++ } END { print n + 0 }')
  [ "$nu" = 1 ] || die "origin has $nu fetch URLs — exactly one required"
  [ "$np" = 1 ] || die "origin has $np push URLs — exactly one required"
  [ "$(norm_url "$urls")" = "$REMOTE_LC" ] || die "origin fetch URL $(redact "$urls") is not $REMOTE_LC"
  [ "$(norm_url "$pushes")" = "$REMOTE_LC" ] || die "origin push URL $(redact "$pushes") is not $REMOTE_LC"
  ORIGIN_URL="$urls"
  ghq_to "$T/repo.json" repo view "$REMOTE" --json id,defaultBranchRef,hasIssuesEnabled
  REPO_ID=$(jq -r '.id // ""' "$T/repo.json") || die "unreadable repo view answer"
  DEFAULT=$(jq -r '.defaultBranchRef.name // ""' "$T/repo.json") || die "unreadable repo view answer"
  HAS_ISSUES=$(jq -r 'if .hasIssuesEnabled == true then 1 else 0 end' "$T/repo.json") || die "unreadable repo view answer"
  [ -n "$REPO_ID" ] || die "cannot read the repo id"
  [ -n "$DEFAULT" ] || die "cannot detect the default branch"
}

# ---------- data load (report, apply and verify share it; any failure = die) ----------
load_data() {
  local n_list n_api
  ghq_to "$T/prs.json" pr list --repo "$REMOTE" --state all --limit 100000 \
    --json number,state,headRefName,headRefOid,baseRefName,isCrossRepository,headRepositoryOwner,headRepository,author,updatedAt,title,mergeCommit
  n_list=$(jq 'length' "$T/prs.json") || die "unreadable PR list"
  n_api=$(ghq api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests{totalCount}}}' \
    -f o="$OWNER" -f n="$NAME" -q .data.repository.pullRequests.totalCount) || exit 1
  [ "$n_list" = "$n_api" ] || die "PR list returned $n_list of $n_api PRs — refusing to work from a partial index"
  # prs.tsv: num state head_repo head_ref head_oid base author updatedAt merge_oid title
  jq -r --arg r "$REMOTE_LC" "$JQ_LIB"'.[] | [(.number | tostring), (.state // "UNKNOWN"), hrepo($r),
      ((.headRefName // "") | penc), ((.headRefOid // "") | if . == "" then "null" else . end),
      ((.baseRefName // "") | penc), ((.author.login // "") | if . == "" then "unknown" else penc end),
      ((.updatedAt // "") | if . == "" then "unknown" else penc end), (.mergeCommit.oid // "null"),
      ((.title // "") | penc)] | join("\t")' "$T/prs.json" > "$T/prs.tsv" || die "unreadable PR list"
  : > "$T/issues.tsv"
  if [ "$HAS_ISSUES" = 1 ]; then
    ghq_to "$T/issues.json" issue list --repo "$REMOTE" --state open --limit 100000 --json number,title,labels,updatedAt,author
    n_list=$(jq 'length' "$T/issues.json") || die "unreadable issue list"
    n_api=$(ghq api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){issues(states:OPEN){totalCount}}}' \
      -f o="$OWNER" -f n="$NAME" -q .data.repository.issues.totalCount) || exit 1
    [ "$n_list" = "$n_api" ] || die "issue list returned $n_list of $n_api open issues — refusing to work from a partial index"
    jq -r "$JQ_LIB"'.[] | [(.number | tostring), ((.updatedAt // "") | if . == "" then "unknown" else penc end),
        ((.author.login // "") | if . == "" then "unknown" else penc end), ((.title // "") | penc)] | join("\t")' \
      "$T/issues.json" > "$T/issues.tsv" || die "unreadable issue list"
  fi
  load_protection_sources
}

# P sources from GitHub → pats.raw: kind (lit = a refname, pat = branch filter syntax) source value
load_protection_sources() {
  local id en eu
  : > "$T/pats.raw"
  printf 'lit\tdefault\t%s\n' "$DEFAULT" >> "$T/pats.raw"
  ghq_to "$T/protected.txt" api --paginate "repos/$REMOTE/branches?protected=true&per_page=100" -q '.[].name'
  awk 'NF { print "lit\tbranch-protection\t" $0 }' "$T/protected.txt" >> "$T/pats.raw"
  ghq_to "$T/rs.ids" api --paginate "repos/$REMOTE/rulesets?per_page=100" -q '.[].id'
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    case "$id" in *[!0-9]*) die "unexpected ruleset id '$id'" ;; esac
    ghq_to "$T/rs.json" api "repos/$REMOTE/rulesets/$id"
    jq -r --arg id "$id" --arg d "$DEFAULT" 'select(.target == "branch" and .enforcement == "active")
        | (.conditions.ref_name.include // [])[]
        | if . == "~DEFAULT_BRANCH" then $d elif . == "~ALL" then "*" elif startswith("refs/heads/") then ltrimstr("refs/heads/") else . end
        | if (explode | any(. < 32 or . == 127)) then error("control character in ruleset \($id) pattern") else . end
        | "pat\truleset#\($id)\t\(.)"' "$T/rs.json" >> "$T/pats.raw" || die "unreadable ruleset $id"
  done < "$T/rs.ids"
  ghq_to "$T/env.names" api --paginate "repos/$REMOTE/environments?per_page=100" \
    -q '.environments[]? | select(.deployment_branch_policy.custom_branch_policies == true)
        | [(.name | @uri), (.name | [explode[] | if . < 32 or . == 127 then 63 else . end] | implode)] | join("\t")'
  while IFS="$TAB" read -r eu en; do                 # eu = URL form (path), en = label without control chars
    [ -n "$eu" ] || continue
    ghq_to "$T/env.pol" api --paginate "repos/$REMOTE/environments/$eu/deployment-branch-policies?per_page=100" \
      -q '.branch_policies[]? | select(.type != "tag") | .name'
    CH_SRC="environment#$en" awk 'NF { print "pat\t" ENVIRON["CH_SRC"] "\t" $0 }' "$T/env.pol" >> "$T/pats.raw"
  done < "$T/env.names"
}

add_cli_sources() { # protect.raw / integrate.raw (raw values, one per line) → pats.raw
  awk 'NF { print "pat\t--protect\t" $0 }' "$T/protect.raw" >> "$T/pats.raw"
  awk 'NF { print "lit\t--integrate\t" $0 }' "$T/integrate.raw" >> "$T/pats.raw"
}

# pats.raw + workflow filters + OPEN PR names → pats.tsv (pattern_enc, source_enc). A branch filter
# using syntax beyond literal / * / ** dies (M2): the matcher would silently misread it. Refnames
# (kind lit) are compared exactly and may legally contain + ! { }.
P_PATS='
BEGIN { bad = ENVIRON["CHT"] "/m2.bad" }
{
  k = $1; s = $2; p = $3
  for (i = 4; i <= NF; i++) p = p "\t" $i
  if (p == "") next
  if (k == "pat" && (p ~ /[?{}!+~]/ || index(p, "[") || index(p, "]") || index(p, "\\") || hasctl(p))) {
    print p "\t" s > bad; close(bad); exit 3
  }
  print penc(p, 0), penc(s, 0)
}'
build_pats() {
  cat "$T/pats.raw" "$T/wf.raw" > "$T/pats.all"
  rm -f "$T/m2.bad"
  if ! ak "$P_PATS" "$T/pats.all" > "$T/pats.tsv"; then
    if [ -s "$T/m2.bad" ]; then
      die "unsupported branch filter $(cut -f1 "$T/m2.bad") in $(cut -f2 "$T/m2.bad") — extend the matcher (chore.sh) before running; --protect cannot exempt a source"
    fi
    die "building the protected set failed"
  fi
  ak '$2 == "OPEN" { if ($4 != "" && ($3 == ENVIRON["CH_REMOTE"] || $3 == "unknown")) print $4, "open-pr-head#" $1; if ($6 != "") print $6, "open-pr-base#" $1 }' \
    "$T/prs.tsv" >> "$T/pats.tsv"
}

# workflow branch filters, read from origin/<default> and every literal P name that exists on the
# remote, repeated until no new tree appears (max 5 rounds; still growing = die)
RB_WF='
require "yaml"
require "date"
ARGV.each do |f|
  id = File.basename(f, ".yml")
  begin
    d = YAML.safe_load(File.read(f, mode: "r:UTF-8"), permitted_classes: [Date, Time, Symbol], aliases: true)
  rescue Exception => e
    STDERR.puts "#{id}\t#{e.class}: #{e.message.to_s.gsub(/\s+/, " ")}"
    exit 3
  end
  next unless d.is_a?(Hash)
  on = d.key?(true) ? d[true] : d["on"]
  next unless on.is_a?(Hash)
  %w[push pull_request pull_request_target].each do |ev|
    c = on[ev]
    next unless c.is_a?(Hash) && c.key?("branches")
    b = c["branches"]
    (b.is_a?(Array) ? b : [b]).each do |x|
      next if x.nil?
      s = x.to_s
      if s =~ /[\x00-\x1f\x7f]/
        STDERR.puts "#{id}\tcontrol character in a branch filter"
        exit 3
      end
      puts "#{id}\t#{s}"
    end
  end
end
'
P_TODO='
BEGIN {
  T = ENVIRON["CHT"]
  while (rl(T "/pats.tsv") > 0) { split(_L, a, "\t"); if (index(a[1], "*") == 0) want[a[1]] = 1 }
  while (rl(T "/wf.scanned") > 0) seen[_L] = 1
}
($1 in want) && !($1 in seen) { print $1, pdec($1, 0) }'
scan_workflows() {
  local round=0 enc raw oid id msg ref path
  : > "$T/wf.raw"; : > "$T/wf.scanned"; : > "$T/wf.blobs"; : > "$T/wf.parsed"
  rm -rf "$T/wf"; mkdir -p "$T/wf"
  command -v "$RUBY" >/dev/null 2>&1 || die "ruby not found at $RUBY — the YAML parser is required (set CHORE_RUBY)"
  build_pats
  while :; do
    ak "$P_TODO" "$T/rb.tsv" > "$T/wf.todo"
    [ -s "$T/wf.todo" ] || break
    round=$((round+1))
    [ "$round" -le 5 ] || die "workflow trigger closure still growing after 5 rounds — refusing to plan"
    while IFS="$TAB" read -r enc raw; do
      printf '%s\n' "$enc" >> "$T/wf.scanned"
      g -c core.quotepath=false ls-tree "refs/remotes/origin/$raw" -- .github/workflows/ > "$T/wf.ls" \
        || die "cannot list workflows of origin/$raw"
      CH_REF="$raw" awk -F'\t' '{
          split($1, a, " "); if (a[2] != "blob") next
          p = $2; if (p ~ /^".*"$/) p = substr(p, 2, length(p) - 2)
          if (p ~ /\.ya?ml$/) print a[3] "\t" ENVIRON["CH_REF"] "\t" $2 }' "$T/wf.ls" >> "$T/wf.blobs"
    done < "$T/wf.todo"
    awk -F'\t' 'FILENAME == ARGV[1] { seen[$1] = 1; next } !($1 in seen) && !($1 in out) { out[$1] = 1; print $1 }' \
      "$T/wf.parsed" "$T/wf.blobs" > "$T/wf.new"
    if [ -s "$T/wf.new" ]; then
      set --
      while IFS= read -r oid; do
        g cat-file blob "$oid" > "$T/wf/$oid.yml" || die "cannot read workflow blob $oid"
        set -- "$@" "$T/wf/$oid.yml"
        printf '%s\n' "$oid" >> "$T/wf.parsed"
      done < "$T/wf.new"
      if ! "$RUBY" -e "$RB_WF" "$@" > "$T/wf.out" 2> "$T/wf.err"; then
        id=$(awk -F'\t' 'NR == 1 { print $1 }' "$T/wf.err")
        msg=$(awk -F'\t' 'NR == 1 { $1 = ""; print substr($0, 2) }' "$T/wf.err")
        ref=$(CH_ID="$id" awk -F'\t' '$1 == ENVIRON["CH_ID"] { print $2; exit }' "$T/wf.blobs")
        path=$(CH_ID="$id" awk -F'\t' '$1 == ENVIRON["CH_ID"] { print $3; exit }' "$T/wf.blobs")
        die "workflow parse failed: ${path:-?} at origin/${ref:-?}: ${msg:-$(head -c 300 "$T/wf.err")}"
      fi
      awk -F'\t' 'FILENAME == ARGV[1] { if (!($1 in p)) { n = split($3, s, "/"); p[$1] = s[n] }; next }
          { x = $2; for (i = 3; i <= NF; i++) x = x "\t" $i; print "pat\tworkflow#" p[$1] "\t" x }' \
        "$T/wf.blobs" "$T/wf.out" >> "$T/wf.raw"
    fi
    build_pats
  done
}

# protection matcher: input = names (enc, first column) → name_enc, sources_enc (protected only)
P_MATCH='
function add(list, s) { return index(SUBSEP list SUBSEP, SUBSEP s SUBSEP) ? list : (list == "" ? s : list SUBSEP s) }
function fmt(list,   n, a, i, o) { n = split(list, a, SUBSEP); o = ""; for (i = 1; i <= n && i <= 4; i++) o = o (i > 1 ? ", " : "") a[i]; if (n > 4) o = o " +" (n - 4) " more"; return o }
BEGIN {
  while (rl(ENVIRON["CH_PATS"]) > 0) {
    split(_L, a, "\t"); p = a[1]; s = pdec(a[2], 0)
    if (index(p, "*")) { if (!(p in gi)) { gi[p] = ++ng; gp[ng] = pdec(p, 0) }; k = gi[p]; gs[k] = add(gs[k], s) }
    else ls[p] = add(ls[p], s)
  }
}
{
  n = $1; src = (n in ls) ? ls[n] : ""
  if (ng) { d = pdec(n, 0); for (k = 1; k <= ng; k++) if (gmatch(d, gp[k])) { m = split(gs[k], b, SUBSEP); for (j = 1; j <= m; j++) src = add(src, b[j]) } }
  if (src != "") print n, penc(fmt(src), 0)
}'
match_protected() { CH_PATS="$1" ak "$P_MATCH" "$2"; }

list_remote_branches() { # → rb.tsv: name_enc oid email_enc date epoch (refname order)
  g for-each-ref --format='%(refname)%09%(objectname)%09%(authoremail)%09%(committerdate:short)%09%(committerdate:unix)' \
    refs/remotes/origin > "$T/rb.raw" || die "for-each-ref failed"
  ak '{ n = $1; if (substr(n, 1, 20) != "refs/remotes/origin/") next; n = substr(n, 21); if (n == "HEAD") next
        e = $3; sub(/^</, "", e); sub(/>$/, "", e); if (e == "") e = "unknown"
        print penc(n, 0), $2, penc(e, 0), ($4 == "" ? "unknown" : $4), ($5 == "" ? 0 : $5) }' "$T/rb.raw" > "$T/rb.tsv"
}

build_integration() { # I.raw (raw names, default first) → I.tsv: enc tip reachfile; dies on a missing ref
  local r enc tip k=0
  : > "$T/I.tsv"
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    k=$((k+1))
    enc=$(penc1 "$r")
    tip=$(CH_N="$enc" awk -F'\t' '$1 == ENVIRON["CH_N"] { print $2; exit }' "$T/rb.tsv")
    [ -n "$tip" ] || die "integration ref '$r' does not exist on origin"
    g rev-list "refs/remotes/origin/$r" > "$T/reach.$k" || die "rev-list failed on origin/$r"
    printf '%s\t%s\t%s\n' "$enc" "$tip" "$T/reach.$k" >> "$T/I.tsv"
  done < "$T/I.raw"
  cut -f1 "$T/I.tsv" > "$T/I.names"
}

inuse_scan() { # → $T/inuse.tsv: branch (raw) <TAB> worktree — held by a stopped rebase or a bisect anywhere
  # (the states `git branch -d` refuses although `worktree list` shows the worktree detached)
  local cd gd wt b f
  cd=$(g rev-parse --path-format=absolute --git-common-dir) || die "cannot find the git common dir"
  : > "$T/inuse.tsv"
  for gd in "$cd" "$cd"/worktrees/*; do
    [ -d "$gd" ] || continue
    if [ "$gd" = "$cd" ]; then wt="${cd%/.git}"
    elif [ -f "$gd/gitdir" ]; then wt=$(dirname "$(head -1 "$gd/gitdir")"); else wt="$gd"; fi
    for f in rebase-merge/head-name rebase-apply/head-name; do
      if [ -f "$gd/$f" ]; then
        b=$(head -1 "$gd/$f")
        case "$b" in refs/heads/*) printf '%s\t%s\n' "${b#refs/heads/}" "$wt" >> "$T/inuse.tsv" ;; esac
      fi
    done
    if [ -f "$gd/BISECT_START" ]; then
      b=$(head -1 "$gd/BISECT_START"); printf '%s\t%s\n' "${b#refs/heads/}" "$wt" >> "$T/inuse.tsv"
    fi
  done
}

check_i_in_p() { # I ⊆ P, or die
  local miss
  match_protected "$T/pats.tsv" "$T/I.names" > "$T/I.prot"
  miss=$(awk -F'\t' 'FILENAME == ARGV[1] { p[$1] = 1; next } !($1 in p) { print $1 }' "$T/I.prot" "$T/I.names")
  [ -z "$miss" ] || die "integration ref(s) not in the protected set: $miss"
}

# ---------- report ----------
# classify one branch list (CH_MODE remote|local) → 9 columns: the plan's 6 + group reason protected_by
P_CLASSIFY='
function out(t, a, r, x, s, e, why, pb) { print t, a, r, x, (s == "" ? "-" : s), penc(e, 0), grp(r, a), why, (pb == "" ? "-" : pb) }
BEGIN {
  T = ENVIRON["CHT"]; R = ENVIRON["CH_REMOTE"]; MODE = ENVIRON["CH_MODE"]; NOLOCAL = ENVIRON["CH_NOLOCAL"] + 0
  NOW = ENVIRON["CH_NOW"] + 0; STALE = ENVIRON["CH_STALE"] + 0
  while (rl(T "/I.tsv") > 0) {
    split(_L, a, "\t"); nI++; iname[nI] = a[1]; ix[a[1]] = nI; if (!(a[2] in itip)) itip[a[2]] = a[1]
    while (rl(a[3]) > 0) reach[nI, _L] = 1
    close(a[3])
  }
  while (rl(ENVIRON["CH_PROT"]) > 0) { split(_L, a, "\t"); prot[a[1]] = a[2] }
  while (rl(T "/objs.txt") > 0) { split(_L, a, " "); if (a[2] == "commit") have[a[1]] = 1 }
  while (rl(T "/co.txt") > 0) co[_L] = 1
  while (rl(T "/inuse.enc") > 0) { split(_L, a, "\t"); iu[a[1]] = a[2] }
  while (rl(T "/prs.tsv") > 0) {
    split(_L, a, "\t")
    if (a[3] != R) continue
    if (!(a[4] in anyn)) { anyn[a[4]] = a[1]; anys[a[4]] = a[2]; anya[a[4]] = a[7] }
    if (a[2] == "MERGED" && (a[6] in ix)) {
      k = ++nc[a[4]]; cnum[a[4], k] = a[1]; coid[a[4], k] = a[5]; cbase[a[4], k] = a[6]; cauth[a[4], k] = a[7]; cmerge[a[4], k] = a[9]
    }
  }
}
{
  name = $1; tip = $2; em = $3; dt = $4; ep = $5; trk = (NF >= 6 ? $6 : "-")
  ref3 = (MODE == "remote" ? "remote:" : "local:") name
  tsnap = "tip_author=" em ";tip_date=" dt
  info = (name in anyn) ? ";pr=" anyn[name] ";pr_state=" anys[name] ";pr_author=" anya[name] : ""
  if (MODE == "local" && (name in co)) { out(3, "report", ref3, tip, tsnap info, "checked out in a worktree", "checked-out", ""); next }
  if (MODE == "local" && (name in iu)) { out(3, "report", ref3, tip, tsnap info, "in use by a rebase/bisect in " iu[name], "checked-out", ""); next }
  if (name in prot) { out(3, "report", ref3, tip, tsnap info, "protected (" pdec(prot[name], 0) ")", "protected", prot[name]); next }
  # basis (a): first PR that fully qualifies — head oid == tip AND merge commit in the current base history
  sel = 0; fail = ""; fk = 0
  for (k = 1; k <= nc[name]; k++) {
    if (coid[name, k] != tip) continue
    m = cmerge[name, k]
    if (m == "null" || !(m in have)) { if (fail == "") { fail = "merge-commit-unknown"; fk = k }; continue }
    if (!((ix[cbase[name, k]], m) in reach)) { if (fail == "") { fail = "merge-not-in-base"; fk = k }; continue }
    sel = k; break
  }
  if (sel) {
    pn = cnum[name, sel]; pb = cbase[name, sel]; pa = cauth[name, sel]; pm = cmerge[name, sel]
    pinfo = "pr=" pn ";pr_base=" pb ";pr_head_repo=" penc(R, 0) ";pr_head_oid=" tip ";pr_merge_commit=" pm
    evd = "PR #" pn " merged into " pdec(pb, 0) "; last commit " dt " " pdec(em, 0) "; PR by " pdec(pa, 0)
    hsnap = tsnap ";pr=" pn ";pr_state=MERGED;pr_author=" pa ";pr_base=" pb ";pr_merge_commit=" pm
    if (tip in itip) { out(3, "report", ref3, tip, hsnap, "same as " pdec(itip[tip], 0) " tip — hold", "same-as-integration-tip", ""); next }
    if (MODE == "remote") { out(2, "delete-remote", name, tip, "basis=a;" pinfo ";pr_author=" pa ";" tsnap, evd, "merged-pr", ""); next }
    if (NOLOCAL) { out(3, "report", ref3, tip, hsnap, "local delete held (--no-local); " evd, "local-held", ""); next }
    anc = 0; for (k = 1; k <= nI; k++) if ((k, tip) in reach) { anc = 1; break }
    out(1, anc ? "delete-local" : "delete-local-force", name, tip, "basis=a;" pinfo ";" tsnap, evd, "merged-pr", ""); next
  }
  if (fail != "") {
    pb = cbase[name, fk]
    s = tsnap ";pr=" cnum[name, fk] ";pr_state=MERGED;pr_author=" cauth[name, fk] ";pr_base=" pb ";pr_merge_commit=" cmerge[name, fk]
    if (fail == "merge-not-in-base") e = "merge commit not found in current history of " pdec(pb, 0) " — hold"
    else e = "merge commit cannot be verified — hold"
    out(3, "report", ref3, tip, s, e, fail, ""); next
  }
  if (MODE == "remote") for (k = 1; k <= nI; k++) if ((k, tip) in reach) {
    out(3, "report", ref3, tip, tsnap info, "contained in " pdec(iname[k], 0) " — hold (no exact merged-PR match)", "contained-hold", ""); next
  }
  if (MODE == "local" && trk == "[gone]") { out(3, "report", ref3, tip, tsnap info, "upstream gone — no exact merged-PR match; last commit " dt " " pdec(em, 0), "stale", ""); next }
  age = int((NOW - ep) / 86400)
  if (age > STALE) out(3, "report", ref3, tip, tsnap info, "stale " age "d — last commit " dt " " pdec(em, 0) "; no exact merged-PR match", "stale", "")
}'

P_SUMMARY='
{ t[$1]++; n++
  if ($1 == 2) { m = split($5, kv, ";"); b = "-"; for (i = 1; i <= m; i++) if (kv[i] ~ /^basis=/) b = substr(kv[i], 7); g2[pdec($7, 0) "\t" $2 "\t" b]++ }
  if ($1 == 3) g3[$8 "\t" pdec($7, 0)]++ }
END {
  printf "TOT\ttier1=%d tier2=%d tier3=%d rows=%d\n", t[1], t[2], t[3], n
  for (k in g2) print "T2", g2[k], k
  for (k in g3) print "T3", g3[k], k
}'
print_summary() { # rows9 → stderr
  ak "$P_SUMMARY" "$1" > "$T/sum.txt"
  note "$(awk -F'\t' '$1 == "TOT" { print $2 }' "$T/sum.txt")"
  note "tier2 by group × action × basis:"
  awk -F'\t' '$1 == "T2"' "$T/sum.txt" | sort -t"$TAB" -k2,2nr -k3,3 \
    | awk -F'\t' '{ printf "chore:   %6d  %-40s %-20s basis=%s\n", $2, $3, $4, $5 }' >&2
  note "tier3 by reason × group (top 15 groups per reason):"
  awk -F'\t' '$1 == "T3"' "$T/sum.txt" | sort -t"$TAB" -k3,3 -k2,2nr \
    | awk -F'\t' '{ if ($3 != r) { if (more) printf "chore:            ... %d more groups, %d rows\n", more, mrows; r = $3; c = 0; more = 0; mrows = 0 }
                    c++; if (c <= 15) printf "chore:   %-24s %6d  %s\n", $3, $2, $4; else { more++; mrows += $2 } }
                  END { if (more) printf "chore:            ... %d more groups, %d rows\n", more, mrows }' >&2
}

cmd_report() {
  local d tmp hdr v now
  SECONDS=0
  [ -n "$PLAN" ] || die "report needs --plan <out.tsv>"
  for v in ${PROTECT[@]+"${PROTECT[@]}"} ${INTEGRATE[@]+"${INTEGRATE[@]}"}; do
    case "$v" in ""|*[[:cntrl:]]*) die "empty value or control characters in --protect/--integrate" ;; esac
  done
  check_identity
  note "target=$REMOTE local=$LOCAL default=$DEFAULT"
  g fetch --prune --quiet origin || die "fetch failed"
  load_data
  list_remote_branches
  : > "$T/protect.raw"; : > "$T/integrate.raw"
  for v in ${PROTECT[@]+"${PROTECT[@]}"}; do printf '%s\n' "$v" >> "$T/protect.raw"; done
  for v in ${INTEGRATE[@]+"${INTEGRATE[@]}"}; do printf '%s\n' "$v" >> "$T/integrate.raw"; done
  add_cli_sources
  { printf '%s\n' "$DEFAULT"; cat "$T/integrate.raw"; } | awk 'NF && !s[$0]++' > "$T/I.raw"
  build_integration
  scan_workflows
  check_i_in_p
  note "P = $(wc -l < "$T/pats.tsv" | tr -d ' ') pattern entries; I = $(tr '\n' ' ' < "$T/I.names")"

  # merge-commit objects present locally, checked-out branches, protection of every branch
  awk -F'\t' '$9 != "null" { print $9 }' "$T/prs.tsv" | sort -u > "$T/mo.txt"
  g cat-file --batch-check < "$T/mo.txt" > "$T/objs.txt" || die "cat-file failed"
  g worktree list --porcelain > "$T/wt.txt" || die "worktree list failed"
  ak '/^branch refs\/heads\// { print penc(substr($0, 19), 0) }' "$T/wt.txt" > "$T/co.txt"
  inuse_scan
  ak '{ print penc($1, 0), $2 }' "$T/inuse.tsv" > "$T/inuse.enc"
  g for-each-ref --format='%(refname)%09%(objectname)%09%(authoremail)%09%(committerdate:short)%09%(committerdate:unix)%09%(upstream:track)' \
    refs/heads > "$T/lb.raw" || die "for-each-ref failed"
  ak '{ n = $1; if (substr(n, 1, 11) != "refs/heads/") next; n = substr(n, 12)
        e = $3; sub(/^</, "", e); sub(/>$/, "", e); if (e == "") e = "unknown"
        print penc(n, 0), $2, penc(e, 0), ($4 == "" ? "unknown" : $4), ($5 == "" ? 0 : $5), ($6 == "" ? "-" : $6) }' "$T/lb.raw" > "$T/lb.tsv"
  cut -f1 "$T/rb.tsv" > "$T/rb.names"; cut -f1 "$T/lb.tsv" > "$T/lb.names"
  match_protected "$T/pats.tsv" "$T/rb.names" > "$T/rb.prot"
  match_protected "$T/pats.tsv" "$T/lb.names" > "$T/lb.prot"

  now=$(date +%s)
  export CH_NOW="$now" CH_STALE="$STALE_DAYS" CH_NOLOCAL="$NO_LOCAL"
  CH_MODE=remote CH_PROT="$T/rb.prot" ak "$P_CLASSIFY" "$T/rb.tsv" > "$T/rows9"
  CH_MODE=local CH_PROT="$T/lb.prot" ak "$P_CLASSIFY" "$T/lb.tsv" >> "$T/rows9"
  if [ "$NO_LOCAL" = 1 ]; then
    printf '3\treport\t.\t-\t-\t%s\tworktree\tlocal-held\t-\n' "$(penc1 "git worktree prune held (--no-local)")" >> "$T/rows9"
  else
    printf '1\tworktree-prune\t.\t-\t-\t%s\tworktree\tworktree-prune\t-\n' "$(penc1 "git worktree prune (stale admin entries only)")" >> "$T/rows9"
  fi
  sort -t"$TAB" -k1,1n "$T/prs.tsv" | ak '$2 == "OPEN" {
      print 3, "report", "pr#" $1, $5, "state=OPEN;updated=" $8 ";head_repo=" $3 ";head_ref=" $4 ";head_oid=" $5 ";base=" $6 ";author=" $7, $10, "pull-requests", "open-pr", "-" }' >> "$T/rows9"
  sort -t"$TAB" -k1,1n "$T/issues.tsv" | ak '{
      print 3, "report", "issue#" $1, pdec($2, 0), "state=OPEN;updated=" $2 ";author=" $3, $4, "issues", "open-issue", "-" }' >> "$T/rows9"

  # header: values percent-encoded including space; lists joined by ","
  cut -f1 "$T/pats.tsv" | sort -u > "$T/P.names"
  ak 'FILENAME == ARGV[1] { if (index($1, "*") == 0) w[$1] = 1; next } ($1 in w) { print $1 "\t" $2 }' \
    "$T/P.names" "$T/rb.tsv" | sort -u > "$T/Ptips"
  cut -f7 "$T/rows9" | sort -u > "$T/groups"
  hlist() { ak '{ o = o (NR > 1 ? "," : "") penc(pdec($1, 0), 1) } END { printf "%s", o }' "$1"; }
  hraw() { ak '{ o = o (NR > 1 ? "," : "") penc($0, 1) } END { printf "%s", o }' "$1"; }
  htips() { ak '{ o = o (NR > 1 ? "," : "") penc(pdec($1, 0), 1) ":" $2 } END { printf "%s", o }' "$1"; }
  d=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
  hdr="#chore-plan v3"
  hdr="$hdr${TAB}remote=$(penc1 "$REMOTE_LC" 1)${TAB}origin=$(penc1 "$ORIGIN_URL" 1)${TAB}repo_id=$(penc1 "$REPO_ID" 1)"
  hdr="$hdr${TAB}default=$(penc1 "$DEFAULT" 1)${TAB}created=$(penc1 "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 1)"
  hdr="$hdr${TAB}run_id=$(date -u +%Y%m%dT%H%M%SZ)-$d"
  hdr="$hdr${TAB}I=$(hlist "$T/I.names")${TAB}Itips=$(htips "$T/I.tsv")"
  hdr="$hdr${TAB}P=$(hlist "$T/P.names")${TAB}protect=$(hraw "$T/protect.raw")${TAB}integrate=$(hraw "$T/integrate.raw")"
  hdr="$hdr${TAB}no_local=$NO_LOCAL${TAB}Ptips=$(htips "$T/Ptips")${TAB}groups=$(hlist "$T/groups")"

  tmp=$(mktemp "$(dirname "$PLAN")/.chore-plan.XXXXXX")
  { printf '%s\n' "$hdr"; cut -f1-6 "$T/rows9"; } > "$tmp"
  mv "$tmp" "$PLAN"
  d=$(plan_digest "$PLAN")
  if [ -n "$JSON" ]; then
    printf '%s' "$hdr" > "$T/hdr.txt"
    tmp=$(mktemp "$(dirname "$JSON")/.chore-plan-json.XXXXXX")
    jq -n -R --arg sha "$d" --rawfile hdr "$T/hdr.txt" '
      def hexd: ascii_downcase | explode | map(if . >= 97 then . - 87 else . - 48 end) | .[0] * 16 + .[1];
      def pdec: if test("%") then [scan("%[0-9A-F]{2}|[^%]+")] | map(if startswith("%") then ([.[1:3] | hexd] | implode) else . end) | join("") else . end;
      def lst: if . == "" then [] else split(",") | map(pdec) end;
      def tips: if . == "" then {} else split(",") | map(split(":") | {key: (.[0] | pdec), value: .[1]}) | from_entries end;
      def snap: if . == "-" or . == "" then {} else split(";") | map(index("=") as $i | {key: .[:$i], value: (.[$i + 1:] | pdec)}) | from_entries end;
      ($hdr | split("\t") | .[1:] | map(index("=") as $i | {key: .[:$i], value: .[$i + 1:]}) | from_entries) as $h
      | {plan_sha256: $sha,
         header: {remote: ($h.remote | pdec), origin: ($h.origin | pdec), repo_id: ($h.repo_id | pdec), default: ($h.default | pdec),
                  created: ($h.created | pdec), run_id: $h.run_id, I: ($h.I | lst), Itips: ($h.Itips | tips), P: ($h.P | lst),
                  protect: ($h.protect | lst), integrate: ($h.integrate | lst), no_local: ($h.no_local == "1"),
                  Ptips: ($h.Ptips | tips), groups: ($h.groups | lst)},
         rows: [inputs | split("\t") | {tier: (.[0] | tonumber), action: .[1], ref: (.[2] | pdec), expected: .[3],
                snapshot: (.[4] | snap), evidence: (.[5] | pdec), group: (.[6] | pdec), reason: .[7],
                protected_by: (if .[8] == "-" then "" else (.[8] | pdec) end)}]}' < "$T/rows9" > "$tmp" || die "JSON render failed"
    mv "$tmp" "$JSON"
  fi
  note "plan written: $PLAN"
  note "sha256 $d · ${SECONDS}s"
  print_summary "$T/rows9"
  if [ "$PRINT" = 1 ]; then
    ak '{ printf "%s  %-18s %-50s %s\n", $1, $2, rdec($3), pdec($6, 0) }' "$T/rows9"
  fi
}

# ---------- plan parse (apply / verify) ----------
# Strict: fixed header keys, exactly six columns, tier×action allow-list, action-specific ref /
# expected / snapshot schema (no missing, duplicate or unknown key), canonical encoding everywhere.
# Jira rows (tier-2 jira-transition and move-issue, tier-3 report jira#…): chore_plan.py check (run first) owns their ref
# shape, snapshot keys and values and the comment; here they get the generic checks only and a well-formed work row
# (move-issue also its ref shape and exact key set).
# Writes $CHT/h.* and prints one work row per data line (no empty field; "-" = none):
#  1 idx 2 tier 3 action 4 ref_enc 5 ref_dec 6 expected 7 group 8 pr 9 pr_base 10 pr_head_repo
#  11 pr_head_oid 12 pr_merge 13 s_updated 14 s_base 15 pr_base_dec 16 s_head_ref 17 s_head_repo
#  18 "e" + evidence_enc (the approved bytes)
P_PARSE='
function bad(m) { if (!_dead) { printf "%s\n", m > ERRF; close(ERRF) }; _dead = 1; exit 3 }
function chk(v, sp, what) { pdec(v, sp); if (_bad) bad(what ": malformed percent-encoding") }
function hex40(x) { return length(x) == 40 && x ~ /^[0-9a-f]+$/ }
function bname(v,   d) {
  if (v == "" || v ~ /%[01][0-9A-F]/ || index(v, "%7F") || index(v, "%3A") || index(v, "%20")) return 0
  d = pdec(v, 0); if (_bad) return 0
  if (d ~ /^-/ || d ~ /^\// || d ~ /\/$/ || d ~ /\.$/ || index(d, "..") || index(d, "@{") || index(d, "//")) return 0
  # git check-ref-format: no component starts with "." or ends with ".lock"; `--branch HEAD` is refused (rc 128)
  if (d == "HEAD" || d ~ /^\./ || index(d, "/.") || d ~ /\.lock$/ || index(d, ".lock/")) return 0
  # "@" alone: git accepts it as a refname, but in revision syntax it means HEAD — refused (narrower than git = safe)
  if (d == "@") return 0
  if (index(d, " ") || index(d, "~") || index(d, "^") || index(d, "?") || index(d, "*") || index(d, "[") || index(d, "\\")) return 0
  return 1
}
function hlist(k, v, f,   n, a, i, d) {
  printf "" > f
  if (v != "") {
    n = split(v, a, ",")
    for (i = 1; i <= n; i++) {
      d = pdec(a[i], 1); if (_bad || a[i] == "") bad("header " k ": malformed list element")
      if (hasctl(d)) bad("header " k ": control character in a value")
      if (k == "I") inI[penc(d, 0)] = 1
      print ((k == "protect" || k == "integrate") ? d : penc(d, 0)) > f
    }
  }
  close(f)
}
function htips(k, v, f,   n, a, i, b, d) {
  printf "" > f
  if (v != "") {
    n = split(v, a, ",")
    for (i = 1; i <= n; i++) {
      if (split(a[i], b, ":") != 2 || !hex40(b[2])) bad("header " k ": malformed name:oid element")
      d = pdec(b[1], 1); if (_bad || d == "") bad("header " k ": malformed name")
      if (k == "Itips") tipI[penc(d, 0)] = 1
      print penc(d, 0) "\t" b[2] > f
    }
  }
  close(f)
}
BEGIN {
  FS = "\t"; OFS = "\t"; T = ENVIRON["CHT"]; ERRF = T "/parse.err"
  nk = split("remote origin repo_id default created run_id I Itips P protect integrate no_local Ptips groups", hk, " ")
  for (i = 1; i <= nk; i++) want[hk[i]] = 1
  nk = split("basis pr pr_base pr_head_repo pr_head_oid pr_merge_commit pr_author pr_state tip_author tip_date state updated head_repo head_ref head_oid base author title verdict", kk, " ")
  for (i = 1; i <= nk; i++) known[kk[i]] = 1
  # optional keys (chore_plan.py checks that they come last and their values): close rows may carry the title,
  # tier-3 pr#N / issue#N rows the judge verdict (report rows are checked against known[] only)
  opt["close-pr", "title"] = 1; opt["close-issue", "title"] = 1
  req["delete-remote"] = "basis pr pr_base pr_head_repo pr_head_oid pr_merge_commit pr_author tip_author tip_date"
  req["delete-local"] = "basis pr pr_base pr_head_repo pr_head_oid pr_merge_commit tip_author tip_date"
  req["delete-local-force"] = req["delete-local"]
  req["close-pr"] = "state updated head_repo head_ref head_oid base author"
  req["close-issue"] = "state updated author"
  # move-issue: the exact key set (= chore_plan.py MOVE_SNAP_KEYS); chore_plan.py checks its values and evidence
  req["move-issue"] = "state updated author title site project project_id issuetype issuetype_name account gh_login source_sha payload_sha adopt prior"
  ok[1, "worktree-prune"] = 1; ok[1, "delete-local"] = 1; ok[1, "delete-local-force"] = 1
  ok[2, "worktree-prune"] = 1; ok[2, "delete-local"] = 1; ok[2, "delete-local-force"] = 1
  ok[2, "delete-remote"] = 1; ok[2, "close-pr"] = 1; ok[2, "close-issue"] = 1; ok[2, "jira-transition"] = 1
  ok[2, "move-issue"] = 1
  ok[3, "report"] = 1
}
NR == 1 {
  n = split($0, f, "\t")
  if (f[1] != "#chore-plan v3") bad("not a v3 plan (the header must start with #chore-plan v3)")
  for (i = 2; i <= n; i++) {
    j = index(f[i], "="); if (j < 2) bad("malformed header field " i)
    k = substr(f[i], 1, j - 1); v = substr(f[i], j + 1)
    if (!(k in want)) bad("unknown header key " k)
    if (k in got) bad("duplicate header key " k)
    got[k] = 1; hv[k] = v
  }
  for (k in want) if (!(k in got)) bad("missing header key " k)
  printf "" > (T "/h.scalars")
  for (k in hv) if (k ~ /^(remote|origin|repo_id|default|created|run_id|no_local)$/) {
    d = pdec(hv[k], 1); if (_bad) bad("header " k ": malformed percent-encoding")
    if (hasctl(d)) bad("header " k ": control character in a value")
    print k "\t" d > (T "/h.scalars")
  }
  close(T "/h.scalars")
  if (hv["no_local"] != "0" && hv["no_local"] != "1") bad("header no_local must be 0 or 1")
  if (!iso(pdec(hv["created"], 1))) bad("header created must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ")
  if (hv["run_id"] !~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]$/) bad("header run_id malformed")
  hlist("I", hv["I"], T "/h.I"); hlist("P", hv["P"], T "/h.P"); hlist("groups", hv["groups"], T "/h.groups")
  hlist("protect", hv["protect"], T "/h.protect"); hlist("integrate", hv["integrate"], T "/h.integrate")
  htips("Itips", hv["Itips"], T "/h.Itips"); htips("Ptips", hv["Ptips"], T "/h.Ptips")
  for (k in inI) if (!(k in tipI)) bad("header Itips does not cover integration ref " k)
  for (k in tipI) if (!(k in inI)) bad("header Itips names a ref outside I: " k)
  nolocal = hv["no_local"] + 0; remote_enc = penc(pdec(hv["remote"], 1), 0)
  next
}
{
  L = "line " NR
  if (NF != 6) bad(L ": expected 6 columns, got " NF)
  t = $1; a = $2; r = $3; x = $4; s = $5; e = $6
  if (!((t, a) in ok)) bad(L ": action " a " not allowed in tier " t)
  if ((a, r) in seen) bad(L ": duplicate row for " a " " r)
  seen[a, r] = 1
  rv = r; sub(/^(remote|local):/, "", rv)              # structural prefix first, then decode the name once
  chk(rv, 0, L " ref"); chk(e, 0, L " evidence")
  jr = (a == "jira-transition" || a == "move-issue" || (a == "report" && r ~ /^jira#/))
  split("", sv)
  if (s != "-") {
    n = split(s, kv, ";")
    for (i = 1; i <= n; i++) {
      j = index(kv[i], "="); if (j < 2) bad(L ": malformed snapshot pair")
      k = substr(kv[i], 1, j - 1); v = substr(kv[i], j + 1)
      if (!(k in known) && !jr) bad(L ": unknown snapshot key " k)
      if (k in sv) bad(L ": duplicate snapshot key " k)
      if (index(v, "=")) bad(L ": unencoded = in snapshot value")
      chk(v, 0, L " snapshot " k); sv[k] = v
    }
  }
  if (a in req) {
    m = split(req[a], rk, " "); split("", rq)
    for (i = 1; i <= m; i++) { rq[rk[i]] = 1; if (!(rk[i] in sv)) bad(L ": snapshot key " rk[i] " missing for " a) }
    for (k in sv) if (!(k in rq) && !((a, k) in opt)) bad(L ": snapshot key " k " not allowed for " a)
  }
  rd = "-"; pr = "-"; pb = "-"; phr = "-"; pho = "-"; pmc = "-"; su = "-"; sb = "-"; pbd = "-"; shr = "-"; shp = "-"
  if (a ~ /^delete-/) {
    if (nolocal && a ~ /^delete-local/) bad(L ": delete-local row in a --no-local plan")
    if (!bname(r)) bad(L ": invalid branch name in ref")
    if (!hex40(x)) bad(L ": expected must be a 40-hex oid")
    if (sv["basis"] != "a") bad(L ": unsupported basis " sv["basis"])
    if (sv["pr"] !~ /^[0-9]+$/) bad(L ": snapshot pr must be a number")
    if (sv["pr_head_oid"] != x) bad(L ": snapshot pr_head_oid differs from expected")
    if (!hex40(sv["pr_merge_commit"])) bad(L ": snapshot pr_merge_commit must be a 40-hex oid")
    if (!bname(sv["pr_base"])) bad(L ": invalid snapshot pr_base")
    if (!(sv["pr_base"] in inI)) bad(L ": snapshot pr_base is not an integration ref of this plan")
    if (sv["pr_head_repo"] != remote_enc) bad(L ": snapshot pr_head_repo is not this repo")
    rd = pdec(r, 0); pr = sv["pr"]; pb = sv["pr_base"]; phr = sv["pr_head_repo"]; pho = sv["pr_head_oid"]; pmc = sv["pr_merge_commit"]; pbd = pdec(pb, 0)
  } else if (a == "close-pr") {
    if (r !~ /^pr#[0-9]+$/) bad(L ": close-pr ref must be pr#N")
    if (e == "") bad(L ": close-pr evidence (the comment to post) is empty")
    if (!hex40(x)) bad(L ": close-pr expected must be the 40-hex head oid")
    if (sv["state"] != "OPEN") bad(L ": snapshot state must be OPEN")
    if (sv["head_oid"] != x) bad(L ": snapshot head_oid differs from expected")
    su = pdec(sv["updated"], 0); if (!iso(su)) bad(L ": snapshot updated must be an ISO timestamp")
    sb = sv["base"]; shr = sv["head_ref"]; shp = sv["head_repo"]; rd = substr(r, 4)
    if (shr == "" || shp == "") bad(L ": snapshot head_ref / head_repo must not be empty")
  } else if (a == "close-issue") {
    if (r !~ /^issue#[0-9]+$/) bad(L ": close-issue ref must be issue#N")
    if (e == "") bad(L ": close-issue evidence (the comment to post) is empty")
    if (!iso(x)) bad(L ": close-issue expected must be the ISO updatedAt")
    if (sv["state"] != "OPEN") bad(L ": snapshot state must be OPEN")
    su = pdec(sv["updated"], 0); if (su != x) bad(L ": snapshot updated differs from expected")
    rd = substr(r, 7)
  } else if (a == "worktree-prune") {
    if (nolocal) bad(L ": worktree-prune row in a --no-local plan")
    if (r != "." || x != "-" || s != "-") bad(L ": worktree-prune row must be . - -")
  } else if (a == "jira-transition") {
    rd = r
  } else if (a == "move-issue") {
    if (r !~ /^issue#[0-9]+$/) bad(L ": move-issue ref must be issue#N")
    rd = r
  } else {
    if (r ~ /^(remote|local):/) { if (!bname(substr(r, index(r, ":") + 1))) bad(L ": invalid branch name in ref") }
    else if (r !~ /^(pr#|issue#)[0-9]+$/ && r !~ /^jira#/ && r != ".") bad(L ": unrecognised report ref")
  }
  # one target, one state: an executed row may not also be listed as kept (same rule as chore-render.py)
  if (a == "report") kept[r] = NR
  else {
    tw = (a == "delete-remote") ? "remote:" r : (a ~ /^delete-local/) ? "local:" r : r
    if (tw in twin) bad(L ": " a " " r " and line " twin[tw] " name the same target — one target, two states")
    twin[tw] = NR; twa[tw] = a " " r
  }
  print NR, t, a, r, rd, x, grp(r, a), pr, pb, phr, pho, pmc, su, sb, pbd, shr, shp, "e" e
}
END {
  if (_dead) exit 3
  if (NR < 1) { printf "empty plan\n" > ERRF; exit 3 }
  for (k in twin) if (k in kept) { printf "line %d: %s is also listed as kept (line %d) — one target, two states\n", twin[k], twa[k], kept[k] > ERRF; exit 3 }
}'

hs() { awk -F'\t' -v k="$1" '$1 == k { print substr($0, length(k) + 2); exit }' "$T/h.scalars"; }

parse_plan() { # $1 = plan file → h.*, work.tsv, H_*; dies on any violation
  local f="$1" a b rc=0 m
  [ -f "$f" ] || die "plan $f not found"
  a=$(wc -c < "$f"); b=$(tr -d '\000' < "$f" | wc -c)
  [ "$a" -eq "$b" ] || die "plan contains NUL bytes"
  # the authoritative grammar first (every row kind, incl. Jira rows and structured evidence); its message is the contract
  python3 -I "$PLAN_PY" check "$f" > /dev/null 2> "$T/plan.err" || rc=$?
  if [ "$rc" = 1 ]; then m=$(head -1 "$T/plan.err"); m="${m#chore_plan: }"; die "plan rejected: ${m:-unreadable}"
  elif [ "$rc" != 0 ]; then die "plan check failed (python3 -I $PLAN_PY check: exit $rc)"; fi
  rm -f "$T/parse.err"
  if ! ak "$P_PARSE" "$f" > "$T/work.tsv"; then
    die "plan rejected: $(cat "$T/parse.err" 2>/dev/null || echo 'unreadable')"
  fi
  H_REMOTE=$(hs remote); H_ORIGIN=$(hs origin); H_REPO_ID=$(hs repo_id); H_DEFAULT=$(hs default)
  H_RUN_ID=$(hs run_id); H_NO_LOCAL=$(hs no_local); H_CREATED=$(hs created)
}

check_plan_identity() { # header vs live repo (after check_identity)
  [ "$H_REMOTE" = "$REMOTE_LC" ] || die "plan is for $H_REMOTE, not $REMOTE_LC"
  [ "$H_ORIGIN" = "$ORIGIN_URL" ] || die "plan origin $(redact "$H_ORIGIN") differs from current origin $(redact "$ORIGIN_URL")"
  [ "$H_REPO_ID" = "$REPO_ID" ] || die "plan repo_id $H_REPO_ID differs from GitHub repo id $REPO_ID"
  [ "$H_DEFAULT" = "$DEFAULT" ] || die "plan default branch $H_DEFAULT differs from current default $DEFAULT"
}

# recompute I and P from live state + the header's protect/integrate (never from CLI flags)
rebuild_sets() {
  list_remote_branches
  cp "$T/h.protect" "$T/protect.raw"; cp "$T/h.integrate" "$T/integrate.raw"
  add_cli_sources
  { printf '%s\n' "$DEFAULT"; cat "$T/integrate.raw"; } | awk 'NF && !s[$0]++' > "$T/I.raw"
  ak '{ print penc($0, 0) }' "$T/I.raw" | sort > "$T/I.want"
  sort "$T/h.I" > "$T/I.have"
  cmp -s "$T/I.want" "$T/I.have" || die "plan I list does not match default ∪ integrate — plan edited or default changed"
  build_integration
  scan_workflows
  check_i_in_p
}

check_itips() { # → I.bad (planned tip not an ancestor of the current tip) and I.now (current tips)
  local enc oid raw cur
  : > "$T/I.bad"; : > "$T/I.now"
  while IFS="$TAB" read -r enc oid; do
    raw=$(pdec1 "$enc") || die "bad Itips name"
    cur=$(g rev-parse -q --verify "refs/remotes/origin/$raw" 2>/dev/null) || cur=""
    if [ -n "$cur" ]; then printf '%s\t%s\n' "$enc" "$cur" >> "$T/I.now"; fi
    if [ -n "$cur" ] && g merge-base --is-ancestor "$oid" "$cur" >/dev/null 2>&1; then :
    else printf '%s\n' "$enc" >> "$T/I.bad"
    fi
  done < "$T/h.Itips"
}

reload_open() { # OPEN PR heads (same repo / unknown) and bases now ∪ the start-of-run set → open.now
  local n_list n_api
  ghq_to "$T/open.json" pr list --repo "$REMOTE" --state open --limit 100000 \
    --json number,headRefName,baseRefName,isCrossRepository,headRepositoryOwner,headRepository
  # a short list would let this batch delete a fresh OPEN PR's head: count against GitHub, like load_data
  n_list=$(jq 'length' "$T/open.json") || die "unreadable open PR list"
  n_api=$(ghq api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(states:OPEN){totalCount}}}' \
    -f o="$OWNER" -f n="$NAME" -q .data.repository.pullRequests.totalCount) || exit 1
  [ "$n_list" = "$n_api" ] || die "OPEN PR list returned $n_list of $n_api open PRs at $ABORT_AT — refusing to delete from a partial list"
  jq -r --arg r "$REMOTE_LC" "$JQ_LIB"'.[] | (hrepo($r)) as $h
      | (if ($h == $r or $h == "unknown") and (.headRefName // "") != "" then (.headRefName | penc) else empty end),
        ((.baseRefName // "") | select(. != "") | penc)' "$T/open.json" > "$T/open.now" || die "unreadable open PR list"
  cat "$T/open.start" >> "$T/open.now" || die "cannot extend the OPEN PR set"
}

N_OK=0; N_SKIP=0; N_FAIL=0; N_UNK=0
result() { # status action ref_enc reason
  local r; r=$(printf '%s' "$4" | tr '\t\n\r' '   ')
  printf 'RESULT\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$r"
  printf '%s\t%s\n' "$2" "$3" >> "$T/done.keys"
  case "$1" in OK) N_OK=$((N_OK+1)) ;; SKIP) N_SKIP=$((N_SKIP+1)) ;; FAIL) N_FAIL=$((N_FAIL+1)) ;; *) N_UNK=$((N_UNK+1)) ;; esac
}

# live checks for delete rows, in this order (it decides which reason a row reports): protected →
# basis-changed → merge-not-in-<base> → integration-ref-rewound → same-as-integration-tip (tip equals a
# CURRENT I tip) → gone → backup. output: verdict why <work row>
P_PRECHECK='
BEGIN {
  T = ENVIRON["CHT"]
  while (rl(ENVIRON["CH_PROT"]) > 0) { split(_L, a, "\t"); prot[a[1]] = a[2] }
  while (rl(T "/prs.tsv") > 0) { split(_L, a, "\t"); st[a[1]] = a[2]; hr[a[1]] = a[3]; hf[a[1]] = a[4]; ho[a[1]] = a[5]; ba[a[1]] = a[6]; mo[a[1]] = a[9] }
  while (rl(T "/I.tsv") > 0) { split(_L, a, "\t"); nI++; ix[a[1]] = nI; while (rl(a[3]) > 0) reach[nI, _L] = 1; close(a[3]) }
  while (rl(T "/I.bad") > 0) rew[_L] = 1
  while (rl(T "/I.now") > 0) { split(_L, a, "\t"); if (!(a[2] in itip)) itip[a[2]] = a[1] }
  while (rl(ENVIRON["CH_PRESENT"]) > 0) { split(_L, a, "\t"); here[a[1]] = 1 }
  while (rl(ENVIRON["CH_BACKUP"]) > 0) { split(_L, a, "\t"); bk[a[1]] = a[2] }
}
{
  ref = $4; pr = $8; pb = $9; why = "-"
  if (ref in prot) why = "protected (" pdec(prot[ref], 0) ")"
  else if (!(pr in st) || st[pr] != "MERGED" || ba[pr] != pb || ho[pr] != $11 || hr[pr] != $10 || hf[pr] != ref || mo[pr] != $12)
    why = "basis-changed (PR #" pr " no longer matches the snapshot)"
  else if (!(pb in ix) || !((ix[pb], $12) in reach)) why = "merge-not-in-" $15
  else if (pb in rew) why = "integration-ref-rewound (" $15 ")"
  else if ($6 in itip) why = "same-as-integration-tip (" pdec(itip[$6], 0) ")"
  else if (!(ref in here)) why = "gone"
  else if (bk[$1] != "ok") why = (bk[$1] == "" ? "backup-missing" : bk[$1])
  gsub(/[\t\n\r]/, " ", why)                         # a reason never shifts the RESULT columns
  print (why == "-" ? "go" : "SKIP"), why, $0
}'

backup_rows() { # $1 work rows → $2 idx status, backup ref = refs/chore-backup/<run_id>/<decoded branch name>
  # absent → create-only; same oid → ok (rerun); other oid → backup-mismatch
  local idx st ref exp
  g for-each-ref --format='%(refname)%09%(objectname)' "refs/chore-backup/$H_RUN_ID/" > "$T/bk.have" || die "for-each-ref failed"
  CH_PFX="refs/chore-backup/$H_RUN_ID/" awk -F'\t' -v OFS='\t' 'FILENAME == ARGV[1] { h[$1] = $2; next }
      { b = ENVIRON["CH_PFX"] $5; if (b in h) print $1, (h[b] == $6 ? "ok" : "backup-mismatch"), $5, $6; else print $1, "new", $5, $6 }' \
    "$T/bk.have" "$1" > "$T/bk.plan"
  : > "$2"
  while IFS="$TAB" read -r idx st ref exp; do
    if [ "$st" = new ]; then
      if g update-ref "refs/chore-backup/$H_RUN_ID/$ref" "$exp" "" >/dev/null 2>&1; then st=ok; else st=backup-failed; fi
    fi
    printf '%s\t%s\n' "$idx" "$st" >> "$2"
  done < "$T/bk.plan"
}

sel_tiers() { CH_TI="$TIERS" CH_A="$1" ak '$3 ~ ENVIRON["CH_A"] && index("," ENVIRON["CH_TI"] ",", "," $2 ",")' "$T/work.tsv"; }

stage_close() {
  local idx tier action ref rdec exp grp pr pb phr pho pmc su sb pbd shr shp ev cur want text out
  ABORT_AT="close"
  sel_tiers '^close-(pr|issue)$' > "$T/cl.rows"
  while IFS="$TAB" read -r idx tier action ref rdec exp grp pr pb phr pho pmc su sb pbd shr shp ev; do
    if [ "$action" = close-pr ]; then
      # the whole approved head: state, head oid, updatedAt, base, head ref, head repo
      ghq_to "$T/view.json" pr view "$rdec" --repo "$REMOTE" \
        --json state,headRefOid,updatedAt,baseRefName,headRefName,headRepository,headRepositoryOwner,isCrossRepository
      cur=$(jq -r --arg r "$REMOTE_LC" "$JQ_LIB"'[(.state // ""), (.headRefOid // ""), (.updatedAt // ""), ((.baseRefName // "") | penc),
          ((.headRefName // "") | penc), hrepo($r)] | join("\t")' "$T/view.json") || die "unreadable pr view answer"
      want="OPEN${TAB}$exp${TAB}$su${TAB}$sb${TAB}$shr${TAB}$shp"
    else
      ghq_to "$T/view.json" issue view "$rdec" --repo "$REMOTE" --json state,updatedAt
      cur=$(jq -r '[(.state // ""), (.updatedAt // "")] | join("\t")' "$T/view.json") || die "unreadable issue view answer"
      want="OPEN${TAB}$exp"
    fi
    if [ "$cur" != "$want" ]; then result SKIP "$action" "$ref" "changed since approval (now: $cur)"; continue; fi
    text=$(pdec1 "${ev#e}" && printf x) || die "evidence of $ref does not decode"   # the snapshot's bytes, never the file
    text="${text%x}"
    mark_sent "$action" "$ref"
    if [ "$action" = close-pr ]; then
      if out=$(gh pr close "$rdec" --repo "$REMOTE" --comment="$text" 2>&1); then result OK "$action" "$ref" "closed"
      else result FAIL "$action" "$ref" "gh pr close failed: $out"; fi
    else
      if out=$(gh issue close "$rdec" --repo "$REMOTE" --comment="$text" 2>&1); then result OK "$action" "$ref" "closed"
      else result FAIL "$action" "$ref" "gh issue close failed: $out"; fi
    fi
  done < "$T/cl.rows"
}

stage_remote() {
  local v why idx tier action ref rdec exp rest chunk=0
  local -a LEASES DELS
  ABORT_AT="remote-precheck"
  sel_tiers '^delete-remote$' > "$T/dr.all"
  [ -s "$T/dr.all" ] || return 0
  backup_rows "$T/dr.all" "$T/dr.bk"                  # every approved target, before any delete
  if [ -s "$T/only.groups" ]; then
    awk -F'\t' 'FILENAME == ARGV[1] { w[$1] = 1; next } ($7 in w)' "$T/only.groups" "$T/dr.all" > "$T/dr.sel"
  else cp "$T/dr.all" "$T/dr.sel"; fi
  cut -f4 "$T/dr.sel" > "$T/dr.names"
  match_protected "$T/pats.tsv" "$T/dr.names" > "$T/dr.prot"
  CH_PROT="$T/dr.prot" CH_PRESENT="$T/rb.tsv" CH_BACKUP="$T/dr.bk" ak "$P_PRECHECK" "$T/dr.sel" > "$T/dr.verdict"
  : > "$T/dr.go"
  while IFS="$TAB" read -r v why idx tier action ref rest; do
    if [ "$v" = go ]; then printf '%s\t%s\t%s\t%s\t%s\n' "$idx" "$tier" "$action" "$ref" "$rest" >> "$T/dr.go"
    else result SKIP delete-remote "$ref" "$why"; fi
  done < "$T/dr.verdict"
  [ -s "$T/dr.go" ] || return 0
  rm -f "$T"/dr.chunk.*
  awk -v B="$BATCH" -v D="$T" '{ f = D "/dr.chunk." int((NR - 1) / B); print > f }' "$T/dr.go"
  while [ -f "$T/dr.chunk.$chunk" ]; do
    # batch boundary: fresh refs, integration refs still forward, OPEN PRs re-read, branch still there
    ABORT_AT="remote-batch-$((chunk+1))"
    g fetch --prune --quiet origin || die "fetch failed at $ABORT_AT"
    list_remote_branches
    check_itips
    reload_open
    ak 'BEGIN { T = ENVIRON["CHT"]; while (rl(T "/open.now") > 0) op[_L] = 1; while (rl(T "/I.bad") > 0) rw[_L] = 1
                while (rl(T "/I.now") > 0) { split(_L, a, "\t"); if (!(a[2] in it)) it[a[2]] = a[1] }
                while (rl(T "/rb.tsv") > 0) { split(_L, a, "\t"); here[a[1]] = 1 } }
        { why = "-"
          if ($9 in rw) why = "integration-ref-rewound (" $15 ")"
          else if ($6 in it) why = "same-as-integration-tip (" pdec(it[$6], 0) ")"
          else if ($4 in op) why = "protected (open PR head/base)"
          else if (!($4 in here)) why = "gone"
          gsub(/[\t\n\r]/, " ", why)
          print (why == "-" ? "go" : "SKIP"), why, $0 }' "$T/dr.chunk.$chunk" > "$T/dr.cv" || die "batch check failed at $ABORT_AT"
    LEASES=(); DELS=(); : > "$T/dr.push"
    while IFS="$TAB" read -r v why idx tier action ref rdec exp rest; do
      if [ "$v" != go ]; then result SKIP delete-remote "$ref" "$why"; continue; fi
      LEASES+=("--force-with-lease=refs/heads/$rdec:$exp"); DELS+=(":refs/heads/$rdec")
      printf '%s\t%s\t%s\n' "$ref" "$rdec" "$exp" >> "$T/dr.push"
    done < "$T/dr.cv"
    if [ -s "$T/dr.push" ]; then
      awk -F'\t' -v OFS='\t' '{ print "delete-remote", $1 }' "$T/dr.push" >> "$T/sent.keys" || die "cannot record the rows being sent"
      set +e
      g push --porcelain "${LEASES[@]}" origin "${DELS[@]}" > "$T/push.out" 2> "$T/push.err"
      set -e
      judge_push
    fi
    chunk=$((chunk+1))
  done
}

judge_push() { # per-ref verdict from porcelain lines; a ref without its line is settled by ls-remote
  local ref rdec exp fl summ out
  CH_OUT="$T/push.out" ak 'BEGIN {
        while (rl(ENVIRON["CH_OUT"]) > 0) { n = split(_L, a, "\t"); if (n < 2) continue; i = index(a[2], ":"); if (!i) continue
          to = substr(a[2], i + 1); if (!(to in fl)) { fl[to] = (a[1] == "" ? "?" : a[1]); sm[to] = (n >= 3 && a[3] != "" ? a[3] : "-") } } }
      { to = "refs/heads/" $2; print $1, $2, $3, ((to in fl) ? fl[to] : "?"), ((to in sm) ? sm[to] : "-") }' "$T/dr.push" > "$T/dr.judge"
  while IFS="$TAB" read -r ref rdec exp fl summ; do
    case "$fl" in
      -) result OK delete-remote "$ref" "deleted" ;;
      !) result FAIL delete-remote "$ref" "rejected: $summ" ;;
      *)
        if out=$(g ls-remote --heads origin "refs/heads/$rdec" 2>/dev/null); then
          if printf '%s\n' "$out" | CH_R="refs/heads/$rdec" awk -F'\t' '$2 == ENVIRON["CH_R"] { f = 1 } END { exit f ? 0 : 1 }'; then
            result FAIL delete-remote "$ref" "still present (verified by ls-remote); push stderr: $(head -c 200 "$T/push.err")"
          else
            result OK delete-remote "$ref" "absent (verified by ls-remote)"
          fi
        else
          result UNKNOWN delete-remote "$ref" "no porcelain line and ls-remote failed"
        fi ;;
    esac
  done < "$T/dr.judge"
}

stage_local() {
  local v why idx tier action ref rdec exp rest cur out up mref mlabel wtu symt cerr
  ABORT_AT="local"
  sel_tiers '^delete-local(-force)?$' > "$T/dl.sel"
  [ -s "$T/dl.sel" ] || return 0
  backup_rows "$T/dl.sel" "$T/dl.bk"
  g for-each-ref --format='%(refname)' refs/heads > "$T/lb.now" || die "for-each-ref failed"
  ak 'substr($1, 1, 11) == "refs/heads/" { print penc(substr($1, 12), 0) }' "$T/lb.now" > "$T/lb.present"
  cut -f4 "$T/dl.sel" > "$T/dl.names"
  match_protected "$T/pats.tsv" "$T/dl.names" > "$T/dl.prot"
  CH_PROT="$T/dl.prot" CH_PRESENT="$T/lb.present" CH_BACKUP="$T/dl.bk" ak "$P_PRECHECK" "$T/dl.sel" > "$T/dl.verdict"
  while IFS="$TAB" read -r v why idx tier action ref rdec exp rest; do
    g worktree list --porcelain > "$T/wt.now" || die "worktree list failed"
    if has_line "branch refs/heads/$rdec" "$T/wt.now"; then result SKIP "$action" "$ref" "checked out in a worktree"; continue; fi
    inuse_scan
    wtu=$(CH_B="$rdec" awk -F'\t' '$1 == ENVIRON["CH_B"] { print $2; exit }' "$T/inuse.tsv")
    if [ -n "$wtu" ]; then result SKIP "$action" "$ref" "in use by a rebase/bisect in $wtu"; continue; fi
    if [ "$v" != go ]; then result SKIP "$action" "$ref" "$why"; continue; fi
    if symt=$(g symbolic-ref -q "refs/heads/$rdec" 2>/dev/null); then
      result SKIP "$action" "$ref" "symbolic ref (to $symt) — not deleted"; continue
    fi
    cur=$(g rev-parse -q --verify "refs/heads/$rdec" 2>/dev/null || true)
    if [ "$cur" != "$exp" ]; then result SKIP "$action" "$ref" "moved (now ${cur:-absent})"; continue; fi
    if [ "$action" = delete-local ]; then
      # the rule `git branch -d` applied: merged into the branch's upstream when it resolves, else into HEAD
      up=$(g for-each-ref --format='%(refname)%09%(upstream)' refs/heads \
           | CH_R="refs/heads/$rdec" awk -F'\t' '$1 == ENVIRON["CH_R"] { u = $2 } END { print u }') || die "for-each-ref failed"
      mref=""; mlabel=HEAD
      if [ -n "$up" ] && mref=$(g rev-parse -q --verify "$up^{commit}" 2>/dev/null); then mlabel="$up"
      else mref=$(g rev-parse -q --verify "HEAD^{commit}" 2>/dev/null || true); fi
      if [ -z "$mref" ] || ! g merge-base --is-ancestor "$exp" "$mref" 2>/dev/null; then
        result SKIP "$action" "$ref" "not merged into $mlabel (git branch -d would refuse)"; continue
      fi
    fi
    # compare-and-delete of the ref itself (never through a symref): only while it still points at the
    # approved oid. Checked-out, rebase/bisect-held and symbolic branches are refused above.
    mark_sent "$action" "$ref"
    if out=$(g update-ref --no-deref -d "refs/heads/$rdec" "$exp" 2>&1); then
      # git branch -d dropped the branch.<name> section too; a section that never existed is not an error
      if cerr=$(g config --remove-section "branch.$rdec" 2>&1) || [ "$cerr" = "fatal: no such section: branch.$rdec" ]; then
        result OK "$action" "$ref" "deleted"
      else
        result OK "$action" "$ref" "deleted; branch.$rdec config not removed: $cerr"
      fi
    else
      result SKIP "$action" "$ref" "moved or locked, not deleted: $out"
    fi
  done < "$T/dl.verdict"
}

stage_prune() {
  local out
  ABORT_AT="prune"
  sel_tiers '^worktree-prune$' > "$T/wp.sel"
  [ -s "$T/wp.sel" ] || return 0
  mark_sent worktree-prune .
  if out=$(g worktree prune 2>&1); then result OK worktree-prune . "pruned"; else result FAIL worktree-prune . "$out"; fi
}

# Jira-helper rows = jira-transition and move-issue (chore-jira.py apply-rows / verify-rows decides both)
plan_has_jira() { awk -F'\t' '$3 == "jira-transition" || $3 == "move-issue" { f = 1 } END { exit f ? 0 : 1 }' "$T/work.tsv"; }

# the Jira stage can take long: once it ran, P and I are read again from live state exactly as at apply start
# (repo identity + default branch, PRs, protections, rulesets, environment branch policies, workflow filters,
# integration tips) before any delete;
# a branch protected meanwhile then SKIPs like any other protected one. The OPEN-PR start set only grows.
reload_after_jira() {
  ABORT_AT="remote-reload"
  check_identity                      # default branch, repo id and origin again: a switched default must not leave P
  check_plan_identity
  g fetch --prune --quiet origin || die "fetch failed at $ABORT_AT"
  load_data
  rebuild_sets
  ak '$2 == "OPEN" { if ($4 != "" && ($3 == ENVIRON["CH_REMOTE"] || $3 == "unknown")) print $4; if ($6 != "") print $6 }' "$T/prs.tsv" >> "$T/open.start"
  check_itips
  if [ -s "$T/I.bad" ]; then note "integration ref(s) not forward of the plan after the Jira stage: $(tr '\n' ' ' < "$T/I.bad")— their rows will SKIP"; fi
}

chore_paths() { # → CHDIR JOURNAL JLOCK: the Jira journal and writer lock of this plan live in the clone's git common dir
  local cd
  cd=$(g rev-parse --path-format=absolute --git-common-dir) || die "cannot find the git common dir"
  CHDIR="$cd/chore"; JOURNAL="$CHDIR/$H_RUN_ID.journal"; JLOCK="$CHDIR/$H_RUN_ID.lock"
  case "$CHDIR" in *[[:cntrl:]]*) die "git common dir path has a control character — it cannot go into the receipt" ;; esac
}

# one helper stdout line → "<status>\t<action>\t<ref>" when it is a Jira-helper RESULT of this attempt for a run.keys row
# (action jira-transition or move-issue, the row's own) that has no RESULT yet: exactly 6 columns, status OK / SKIP / FAIL
# with a known class of that action (`<class>: <text>`) or UNKNOWN (free text, no class of that action) — the classes
# verify-rows accepts (design §5 V.2; move-issue = design v9 §6), so a line taken here never fails its format check
P_JLINE='
BEGIN {
  T = ENVIRON["CHT"]; L = ENVIRON["CH_L"]
  while (rl(T "/run.keys") > 0) want[_L] = 1
  while (rl(T "/done.keys") > 0) got[_L] = 1
  if (split(L, f, "\t") != 6 || f[1] != "RESULT" || (f[3] != "jira-transition" && f[3] != "move-issue") || f[6] != "attempt=" ENVIRON["CH_AT"]) exit 1
  k = f[3] "\t" f[4]
  if (!(k in want) || (k in got) || f[5] == "" || index(f[5], "\r")) exit 1
  c = (match(f[5], /^[a-z-]+: /) ? substr(f[5], 1, RLENGTH - 2) : "")
  if (f[3] == "jira-transition") {
    if (f[2] == "OK") { if (c !~ /^(moved|already-done)$/) exit 1 }
    else if (f[2] == "SKIP") { if (c !~ /^(identity|manual|at-target|assignee|changed|proof|transition)$/) exit 1 }
    else if (f[2] == "FAIL") { if (c !~ /^(comment-rejected|changed-after-comment|transition-rejected)$/) exit 1 }
    else if (f[2] != "UNKNOWN" || c ~ /^(moved|already-done|identity|manual|at-target|assignee|changed|proof|transition|comment-rejected|changed-after-comment|transition-rejected)$/) exit 1
  } else {
    if (f[2] == "OK") { if (c !~ /^(moved|already-done)$/) exit 1 }
    else if (f[2] == "SKIP") { if (c !~ /^(account|changed|manual|exists|type)$/) exit 1 }
    else if (f[2] == "FAIL") { if (c !~ /^(create-rejected|comment-failed|close-failed)$/) exit 1 }
    else if (f[2] != "UNKNOWN" || c ~ /^(moved|already-done|account|changed|manual|exists|type|create-rejected|comment-failed|close-failed)$/) exit 1
  }
  print f[2] "\t" f[3] "\t" f[4]
}'
# helper stdout → this run: lines after the JIRA_N already taken are checked, recorded (done.keys, counters) and
# printed byte-for-byte, so no line prints twice. A line the check rejects (exit 1) is consumed but never taken: mode
# run dies (the abort path then takes the lines after it), mode abort reports it and goes on. A check that did not
# finish (killed by a signal to the process group, a control file unreadable) consumes nothing: mode run stops so the
# abort path — signals ignored there — checks that line again.
jira_take() {
  local mode="$1" line i=0 v vrc st act ref
  while IFS= read -r line; do
    i=$((i+1))
    [ "$i" -gt "$JIRA_N" ] || continue
    vrc=0; v=$(CH_L="$line" CH_AT="$ATTEMPT" ak "$P_JLINE" 2>/dev/null) || vrc=$?
    if [ "$vrc" != 0 ] && [ "$vrc" != 1 ] && [ "$mode" = run ]; then
      # a signal only when ours arrived too (the process group got it); the check dying alone (SIGKILL, SIGSEGV) is a failure
      if [ "$vrc" -gt 128 ] && [ "$JIRA_SIG" = 1 ]; then on_signal; fi
      die "line check failed (exit $vrc) on the Jira helper's line $i"
    fi
    if [ "$vrc" != 0 ]; then
      JIRA_N=$i
      line=$(printf '%s' "$line" | tr '\t\r' '  ')
      if [ "$mode" = run ]; then note "the Jira helper's line $i: $line"; die "Jira 단계 출력 형식 오류 (줄 $i)"; fi
      echo "chore: the Jira helper's line $i is not a RESULT of this run (not taken): $line" >&8
      continue
    fi
    st="${v%%"$TAB"*}"; ref="${v#*"$TAB"}"; act="${ref%%"$TAB"*}"; ref="${ref#*"$TAB"}"
    printf '%s\t%s\n' "$act" "$ref" >> "$T/done.keys"
    case "$st" in OK) N_OK=$((N_OK+1)) ;; SKIP) N_SKIP=$((N_SKIP+1)) ;; FAIL) N_FAIL=$((N_FAIL+1)) ;; *) N_UNK=$((N_UNK+1)) ;; esac
    JIRA_N=$i
    printf '%s\n' "$line"
  done < "$T/jira.out"
  JIRA_READ_DONE=1
  if [ -n "$(tail -c 1 "$T/jira.out")" ]; then             # bytes after the last newline = a cut line, never taken
    if [ "$mode" = run ]; then die "Jira 단계 출력의 마지막 줄이 끊김"; fi
    echo "chore: the Jira helper's last output line is cut (not taken)" >&8
  fi
}

# Jira rows of run.keys: one helper process (the only Jira writer of this attempt; it takes the plan's writer lock
# and journals every write). It is a direct child of this script — ppid == $$ == --parent-pid — and its stdout is
# read from a file after `wait`, never through a pipe, so the counters and the pid stay in this shell.
stage_jira() {
  local rc=0 e
  ABORT_AT="jira"
  if ! awk -F'\t' '$1 == "jira-transition" || $1 == "move-issue" { f = 1 } END { exit f ? 0 : 1 }' "$T/run.keys"; then return 0; fi
  : > "$T/jira.out"; : > "$T/jira.err"
  JIRA_STARTED=1
  trap 'JIRA_SIG=1' TERM INT HUP      # until JIRA_PID is known: a signal now would leave the helper unwaited
  "${JIRA_CMD[@]}" apply-rows --plan "$T/plan.snap" --attempt "$ATTEMPT" --journal "$JOURNAL" --lock "$JLOCK" \
    --parent-pid "$$" --repos-md "$REPOS_MD" --remote "$H_REMOTE" --clone "$LOCAL" --judge "$JUDGE" \
    > "$T/jira.out" 2> "$T/jira.err" &
  JIRA_PID=$!
  trap on_signal TERM INT HUP
  if [ "$JIRA_SIG" = 1 ]; then on_signal; fi
  wait "$JIRA_PID" || rc=$?
  JIRA_PID=""
  if [ -s "$T/jira.err" ]; then sed 's/^/chore: jira: /' "$T/jira.err" >&2; fi
  trap 'JIRA_SIG=1' TERM INT HUP      # while lines are taken a signal only marks: each line is recorded and printed whole
  jira_take run
  trap on_signal TERM INT HUP
  if [ "$JIRA_SIG" = 1 ]; then on_signal; fi
  case "$rc" in
    0) ;;
    7) die "다른 apply가 이 계획이나 같은 Jira 프로젝트를 쓰는 중 — 끝난 뒤 같은 명령으로 다시 실행" ;;
    5) die "Jira 인증 실패 — JIRA_EMAIL/JIRA_API_TOKEN 또는 CHORE_ENV_FILE의 값 확인" ;;
    6) die "Jira 읽기 실패 — 잠시 뒤 같은 명령으로 다시 실행" ;;
    9) die "Jira 단계가 차단기로 멈춤 — 원인을 고치기 전에는 다시 실행하지 않음" ;;
    8) die "Jira 단계가 중단됨" ;;
    *) e=$(head -1 "$T/jira.err" | tr '\t\r' '  '); die "Jira 단계 오류: ${e:-exit $rc}" ;;
  esac
  # exit 0 = every row decided
  if ! awk -F'\t' 'FILENAME == ARGV[1] { d[$0] = 1; next } ($1 == "jira-transition" || $1 == "move-issue") && !($0 in d) { f = 1 } END { exit f ? 1 : 0 }' \
      "$T/done.keys" "$T/run.keys"; then
    die "Jira 단계 오류: 끝났지만 결과 줄이 없는 행이 있음"
  fi
}

cmd_apply() {
  local d v re
  [ -n "$PLAN" ] || die "apply needs --plan"
  [ -n "$DIGEST" ] || die "apply needs --digest <sha256> (the digest recorded at approval)"
  [ -f "$PLAN" ] || die "plan $PLAN not found"
  # pin the approved bytes: digest, parse and every later read use this private copy only
  cp "$PLAN" "$T/plan.snap" || die "cannot snapshot the plan"
  d=$(plan_digest "$T/plan.snap")
  [ "$d" = "$DIGEST" ] || die "plan digest $d != approved --digest $DIGEST — the plan changed after approval"
  case "$TIERS" in 1|2|1,2|2,1) ;; *) die "--tiers must be 1, 2 or 1,2" ;; esac
  if [[ "$TIERS" == *2* && "$YES" != 1 ]]; then die "tier 2 requires --yes (remote deletes / closes)"; fi
  parse_plan "$T/plan.snap"
  # a run without tier 2 would skip the Jira rows while its SUMMARY says scope=full (verify then reads them as missing)
  if [[ "$TIERS" != *2* ]] && plan_has_jira; then die "Jira 행이 있는 계획은 --tiers에 2를 넣어야 합니다"; fi
  : > "$T/only.groups"
  for v in ${ONLY[@]+"${ONLY[@]}"}; do
    if { [ "$v" = jira ] || [ "$v" = move ]; } && plan_has_jira; then die "Jira 행은 --only-group 없이 전체 실행에서만 처리됩니다"; fi
    [[ "$TIERS" == *2* ]] || die "--only-group selects remote deletes — it needs --tiers 2 (or 1,2) --yes"
    d=$(penc1 "$v")
    has_line "$d" "$T/h.groups" || die "group '$v' is not in this plan's groups="
    printf '%s\n' "$d" >> "$T/only.groups"
  done
  check_identity
  check_plan_identity
  g fetch --prune --quiet origin || die "fetch failed"
  load_data
  rebuild_sets
  ak '$2 == "OPEN" { if ($4 != "" && ($3 == ENVIRON["CH_REMOTE"] || $3 == "unknown")) print $4; if ($6 != "") print $6 }' "$T/prs.tsv" > "$T/open.start"
  check_itips
  if [ -s "$T/I.bad" ]; then note "integration ref(s) not forward of the plan: $(tr '\n' ' ' < "$T/I.bad")— their rows will SKIP"; fi
  # this apply's attempt id (one per run; the Jira helper journals under it) and where its journal / lock live
  ATTEMPT="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  re='^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'; [[ "$ATTEMPT" =~ $re ]] || die "cannot make an attempt id"
  if [ -s "$T/only.groups" ]; then SCOPE=only-group; else SCOPE=full; fi
  chore_paths
  mkdir -p "$CHDIR" || die "cannot create $CHDIR"
  # the rows this run will act on (for UNKNOWN / NOT-ATTEMPTED if it stops early); Jira rows only in a full run
  : > "$T/done.keys"; : > "$T/sent.keys"
  if [ -s "$T/only.groups" ]; then
    sel_tiers '^delete-remote$' | awk -F'\t' -v OFS='\t' 'FILENAME == ARGV[1] { w[$1] = 1; next } ($7 in w) { print $3, $4 }' "$T/only.groups" - > "$T/run.keys"
  else
    sel_tiers '^(close-pr|close-issue|jira-transition|move-issue|delete-remote|delete-local|delete-local-force|worktree-prune)$' | awk -F'\t' -v OFS='\t' '{ print $3, $4 }' > "$T/run.keys"
  fi
  APPLY_ACTING=1
  if [ ! -s "$T/only.groups" ]; then stage_close; stage_jira; fi
  if [ "$JIRA_STARTED" = 1 ]; then reload_after_jira; fi
  stage_remote
  if [ ! -s "$T/only.groups" ]; then stage_local; stage_prune; fi
  printf 'SUMMARY\tok=%d\tskip=%d\tfail=%d\tunknown=%d\trun_id=%s\tattempt=%s\tscope=%s\tjournal=%s\n' \
    "$N_OK" "$N_SKIP" "$N_FAIL" "$N_UNK" "$H_RUN_ID" "$ATTEMPT" "$SCOPE" "$JOURNAL"
  FINISHED=1
  g fetch --prune --quiet origin || note "final fetch failed"
  [ $((N_FAIL + N_UNK)) -eq 0 ] || exit 1
}

# ---------- verify ----------
N_BAD=0; N_WARN=0; N_UNRES=0
vline() { printf 'VERIFY\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4"
          case "$1" in FAIL) N_BAD=$((N_BAD+1)) ;; WARN) N_WARN=$((N_WARN+1)) ;; UNRESOLVED) N_UNRES=$((N_UNRES+1)) ;; esac; }

verify_ok_row() { # action ref_enc [note] — the change an OK row claims is visible now; an action without a check here dies
  # (Jira-helper rows never come here — verify_jira decides them)
  local action="$1" ref="$2" note="${3:-}" rdec state
  case "$action" in
    delete-remote)
      if has_line "$ref" "$T/heads.now"; then vline FAIL "$action" "$ref" "still on origin$note"
      else vline OK "$action" "$ref" "absent on origin$note"; fi ;;
    delete-local|delete-local-force)
      rdec=$(pdec1 "$ref") || die "bad ref in results: $ref"
      if g show-ref --verify -q "refs/heads/$rdec"; then vline FAIL "$action" "$ref" "still present locally"
      else vline OK "$action" "$ref" "absent locally"; fi ;;
    close-pr)
      state=$(ghq pr view "${ref#pr#}" --repo "$REMOTE" --json state -q .state) || exit 1
      if [ "$state" = CLOSED ]; then vline OK "$action" "$ref" "CLOSED"; else vline FAIL "$action" "$ref" "state $state"; fi ;;
    close-issue)
      state=$(ghq issue view "${ref#issue#}" --repo "$REMOTE" --json state -q .state) || exit 1
      if [ "$state" = CLOSED ]; then vline OK "$action" "$ref" "CLOSED"; else vline FAIL "$action" "$ref" "state $state"; fi ;;
    worktree-prune) vline OK "$action" "$ref" "nothing to check" ;;
    *) die "results: no OK check for action $action ($ref) — not an apply output of this engine" ;;
  esac
}

# Jira rows: chore-jira.py verify-rows decides every one (journal + live Jira; one VERIFY line per Jira row of the
# plan, in plan order); its lines are printed as they are and join the totals — FAIL → fail, WARN → warn,
# UNRESOLVED → unresolved, OK / RESOLVED / NOT-SCHEDULED (never run, like a close row absent from the results) → none
verify_jira() {
  local rc=0 e line st
  chore_paths
  "${JIRA_CMD[@]}" verify-rows --plan "$T/plan.snap" --results "$RESULTS" --journal "$JOURNAL" --repos-md "$REPOS_MD" \
    --remote "$H_REMOTE" > "$T/jv.out" 2> "$T/jv.err" || rc=$?
  if [ "$rc" != 0 ]; then e=$(head -1 "$T/jv.err" | tr '\t\r' '  '); die "${e:-Jira 확인 실패 (exit $rc)}"; fi
  if [ -s "$T/jv.err" ]; then sed 's/^/chore: jira: /' "$T/jv.err" >&2; fi
  [ -z "$(tail -c 1 "$T/jv.out")" ] || die "Jira 확인 출력의 마지막 줄이 끊김"
  ak 'FILENAME == ARGV[1] { if ($3 == "jira-transition" || $3 == "move-issue") { want[$3, $4] = 1; nw++ }; next }
      { ok = (NF == 5 && $1 == "VERIFY" && $2 ~ /^(OK|WARN|RESOLVED|UNRESOLVED|FAIL|NOT-SCHEDULED)$/ && ($3 == "jira-transition" || $3 == "move-issue"))
        if (!ok || !(($3, $4) in want) || (($3, $4) in got) || $5 == "") { printf "line %d: %s\n", FNR, substr($0, 1, 200); bad = 1; exit }
        got[$3, $4] = 1; ng++ }
      END { if (!bad && ng != nw) printf "%d of %d Jira rows answered\n", ng, nw; exit (bad || ng != nw) }' \
    "$T/work.tsv" "$T/jv.out" > "$T/jv.bad" || die "Jira 확인 출력 형식 오류: $(head -1 "$T/jv.bad" | tr '\t\r' '  ')"
  while IFS= read -r line; do
    printf '%s\n' "$line"
    st="${line#VERIFY"$TAB"}"; st="${st%%"$TAB"*}"
    case "$st" in FAIL) N_BAD=$((N_BAD+1)) ;; WARN) N_WARN=$((N_WARN+1)) ;; UNRESOLVED) N_UNRES=$((N_UNRES+1)) ;; esac
  done < "$T/jv.out"
}

# close-pr / close-issue $2 is CLOSED now and carries a comment with the approved text created at or after the plan's
# created → counted as this plan's close (e.g. a rerun of the same plan); it does not prove who closed it
closed_by_plan() { # a gh, jq or plan read failure dies (a failed read is never "not closed by this plan"); the comment text was validated at parse
  local action="$1" ref="$2" text v
  text=$(CH_A="$action" CH_R="$ref" ak '$3 == ENVIRON["CH_A"] && $4 == ENVIRON["CH_R"] { printf "%s", pdec(substr($18, 2), 0); exit }' \
    "$T/work.tsv" && printf x) || die "cannot read the approved comment of $ref"
  text="${text%x}"
  [ -n "$text" ] || die "cannot read the approved comment of $ref"     # no such row in the plan (parse refuses empty ones)
  rm -f "$T/cv.json"                                                   # never judge a previous row's answer
  if [ "$action" = close-pr ]; then ghq_to "$T/cv.json" pr view "${ref#pr#}" --repo "$REMOTE" --json state,comments
  else ghq_to "$T/cv.json" issue view "${ref#issue#}" --repo "$REMOTE" --json state,comments; fi
  # schema first, no fallbacks: the answer is exactly one JSON document {state: OPEN|CLOSED|MERGED, comments: [{body:
  # string, createdAt: a real UTC calendar time}]}, else "bad" (a missing / null field, an empty answer or a second
  # document must never read as "no comment"). ts checks the calendar by arithmetic only (no strptime: same on every
  # jq and libc); \A \z anchor the whole string (Oniguruma's $ also matches before a final newline). createdAt is
  # compared at second precision, like the plan's created. Only "yes" / "no" are verdicts.
  v=$(jq -rs --arg t "$text" --arg c "$H_CREATED" '
       def ts: type == "string" and test("\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z\\z")
         and ((.[0:4] | tonumber) as $y | (.[5:7] | tonumber) as $mo | (.[8:10] | tonumber) as $d
              | (if $mo == 2 then (if ($y % 4 == 0 and $y % 100 != 0) or $y % 400 == 0 then 29 else 28 end)
                 elif ($mo == 4 or $mo == 6 or $mo == 9 or $mo == 11) then 30 else 31 end) as $dim
              | $mo >= 1 and $mo <= 12 and $d >= 1 and $d <= $dim
                and (.[11:13] | tonumber) <= 23 and (.[14:16] | tonumber) <= 59 and (.[17:19] | tonumber) <= 59);
       if length != 1 then "bad" else .[0] |
         if type != "object" then "bad"
         elif (.state as $s | $s == "OPEN" or $s == "CLOSED" or $s == "MERGED") | not then "bad"
         elif ((.comments | type) == "array" and all(.comments[]; type == "object" and (.body | type) == "string" and (.createdAt | ts))) | not then "bad"
         elif .state == "CLOSED" and ([.comments[] | select((.createdAt[0:19] + "Z") >= $c and .body == $t)] | length) > 0 then "yes"
         else "no" end
       end' "$T/cv.json") || die "unreadable $action view answer for $ref"
  case "$v" in yes|no) ;; *) die "malformed $action view answer for $ref" ;; esac   # the shell keeps its own guard
  [ "$v" = yes ]
}

cmd_verify() {
  local st action ref reason rest d ids last at una everok prevbad inI=0
  [ -n "$PLAN" ] || die "verify needs --plan"
  if [ -z "$RESULTS" ] || [ ! -f "$RESULTS" ]; then die "verify needs --results <apply stdout file>"; fi
  [ -n "$DIGEST" ] || die "verify needs --digest <sha256> (the digest recorded at approval)"
  [ -f "$PLAN" ] || die "plan $PLAN not found"
  cp "$PLAN" "$T/plan.snap" || die "cannot snapshot the plan"
  d=$(plan_digest "$T/plan.snap")
  [ "$d" = "$DIGEST" ] || die "plan digest $d != approved --digest $DIGEST — the plan changed after approval"
  parse_plan "$T/plan.snap"
  # the results must come from applies of this plan (run_id of every SUMMARY / ABORTED line). Runs may be
  # concatenated (an ABORTED run, then the same command again): an OK in any of them is checked, and the
  # last terminal line decides whether the run as a whole is complete.
  ids=$(awk -F'\t' '$1 == "SUMMARY" || $1 == "ABORTED" { for (i = 2; i <= NF; i++) if ($i ~ /^run_id=/) print substr($i, 8) }' "$RESULTS" | sort -u)
  [ -n "$ids" ] || die "results file has no SUMMARY or ABORTED line — not an apply output"
  [ "$ids" = "$H_RUN_ID" ] || die "results belong to run $(printf '%s' "$ids" | tr '\n' ' ')— the plan is run $H_RUN_ID"
  last=$(awk -F'\t' '$1 == "SUMMARY" || $1 == "ABORTED" { l = $0 } END { print l }' "$RESULTS")
  check_identity
  check_plan_identity
  g fetch --prune --quiet origin || die "fetch failed"
  g ls-remote --heads origin > "$T/heads.raw" || die "ls-remote failed"
  ak '{ n = $2; if (substr(n, 1, 11) == "refs/heads/") print penc(substr(n, 12), 0) }' "$T/heads.raw" > "$T/heads.now"
  # every delete ever sent (OK / FAIL / UNKNOWN in any run) is checked against P below
  awk -F'\t' '$1 == "RESULT" && $3 == "delete-remote" && ($2 == "OK" || $2 == "FAIL" || $2 == "UNKNOWN") { print $4 }' \
    "$RESULTS" | sort -u > "$T/attempted"
  # per (action, ref) across all concatenated runs, the LAST result decides:
  #   OK, or SKIP after an earlier OK (e.g. SKIP gone on a rerun) → check the change is visible
  #   SKIP changed on a close row never OK → OK when the item shows this plan's close (closed_by_plan), else as below
  #   SKIP after an earlier FAIL / UNKNOWN / NOT-ATTEMPTED → resolved, its SKIP reason is kept
  #   UNKNOWN (sent, outcome unread) → reconciled when the change is visible now, else unresolved
  #   FAIL / NOT-ATTEMPTED → unresolved (with the current remote fact for remote deletes)
  # (Jira-helper rows — jira-transition, move-issue — are skipped here: verify_jira below hands them to verify-rows; their
  # RESULT lines have 6 columns)
  awk -F'\t' -v OFS='\t' '$1 == "RESULT" && $3 != "jira-transition" && $3 != "move-issue" { k = $3 "\t" $4; if (!(k in ls)) o[++n] = k
        ls[k] = $2; lr[k] = ($5 == "" ? "-" : $5); if ($2 == "OK") ok[k] = 1
        if ($2 == "FAIL" || $2 == "UNKNOWN" || $2 == "NOT-ATTEMPTED") bad[k] = $2 }
      END { for (i = 1; i <= n; i++) { k = o[i]; print k, ls[k], ((k in ok) ? 1 : 0), ((k in bad) ? bad[k] : "-"), lr[k] } }' \
    "$RESULTS" > "$T/lastres"
  while IFS="$TAB" read -r action ref st everok prevbad reason; do
    case "$st" in
      OK) verify_ok_row "$action" "$ref" ;;
      SKIP)
        if [ "$everok" = 1 ]; then verify_ok_row "$action" "$ref"
        elif [ "$prevbad" = UNKNOWN ] && [ "$action" = delete-remote ] && [ "${reason%% *}" = gone ]; then
          verify_ok_row "$action" "$ref" " (was UNKNOWN, rerun SKIP gone)"     # the ledger keeps the deletion fact
        elif [ "${reason%% *}" = changed ] && { [ "$action" = close-pr ] || [ "$action" = close-issue ]; } \
             && closed_by_plan "$action" "$ref"; then
          # the run that closed it may have been killed before its receipt (OK line dropped) or stopped as UNKNOWN /
          # FAIL / NOT-ATTEMPTED; the rerun saw it changed and SKIPped — the same evidence as an UNKNOWN close decides, before RESOLVED
          vline OK "$action" "$ref" "reconciled: CLOSED with the approved comment at verify (rerun SKIP changed)"
        elif [ "$prevbad" != "-" ]; then vline RESOLVED "$action" "$ref" "earlier $prevbad, last run SKIP: $reason"; fi ;;
      UNKNOWN)
        rest=""
        case "$action" in
          delete-remote) if ! has_line "$ref" "$T/heads.now"; then rest="absent at verify"; fi ;;
          delete-local|delete-local-force)
            rdec=$(pdec1 "$ref") || die "bad ref in results: $ref"
            if ! g show-ref --verify -q "refs/heads/$rdec"; then rest="absent locally at verify"; fi ;;
          close-pr|close-issue)
            if closed_by_plan "$action" "$ref"; then rest="CLOSED with the approved comment at verify"; fi ;;
        esac
        if [ -n "$rest" ]; then vline OK "$action" "$ref" "reconciled: $rest (was UNKNOWN)"
        else vline UNRESOLVED "$action" "$ref" "last result UNKNOWN: $reason; change not visible at verify"; fi ;;
      *)
        rest=""
        if [ "$action" = delete-remote ]; then
          if has_line "$ref" "$T/heads.now"; then rest="; still on origin"; else rest="; absent on origin now"; fi
        fi
        vline UNRESOLVED "$action" "$ref" "last result $st: $reason$rest" ;;
    esac
  done < "$T/lastres"
  if plan_has_jira; then verify_jira; fi
  # P unchanged = every protected name that existed at report time still exists (tip moves are normal).
  # A missing one is FAIL while the current P still protects it, WARN once nothing protects it any more
  # (e.g. its OPEN PR merged and GitHub deleted the head). A missing integration ref = FAIL without
  # rebuilding P (the rebuild needs every integration ref).
  : > "$T/missing"
  while IFS="$TAB" read -r ref rest; do
    if has_line "$ref" "$T/heads.now"; then vline OK p-invariant "$ref" "present"
    else printf '%s\n' "$ref" >> "$T/missing"; fi
  done < "$T/h.Ptips"
  if awk 'FILENAME == ARGV[1] { i[$0] = 1; next } ($0 in i) { f = 1 } END { exit f ? 0 : 1 }' "$T/h.I" "$T/missing"; then inI=1; fi
  if [ "$inI" = 1 ]; then
    while IFS= read -r ref; do
      if has_line "$ref" "$T/h.I"; then vline FAIL p-invariant "$ref" "integration ref missing on origin"
      else vline FAIL p-invariant "$ref" "protected ref missing on origin (current P not rebuilt: an integration ref is missing)"; fi
    done < "$T/missing"
    awk '{ print $0 "\tplan-P" }' "$T/h.P" > "$T/pats.tsv"
  else
    if [ -s "$T/missing" ] || [ -s "$T/attempted" ]; then
      load_data
      rebuild_sets
    fi
    if [ -s "$T/missing" ]; then
      match_protected "$T/pats.tsv" "$T/missing" > "$T/miss.prot"
      while IFS= read -r ref; do
        rest=$(CH_N="$ref" awk -F'\t' '$1 == ENVIRON["CH_N"] { print $2; exit }' "$T/miss.prot")
        if [ -n "$rest" ]; then vline FAIL p-invariant "$ref" "protected ref missing on origin (still protected: $(pdec1 "$rest" || echo '?'))"
        else vline WARN p-invariant "$ref" "no longer protected — missing on origin after its protection source went away"; fi
      done < "$T/missing"
    fi
    if [ -s "$T/attempted" ]; then awk '{ print $0 "\tplan-P" }' "$T/h.P" >> "$T/pats.tsv"; fi
  fi
  # no delete may have been sent to a protected name (plan-time P ∪ P recomputed now when it could be)
  if [ -s "$T/attempted" ]; then
    match_protected "$T/pats.tsv" "$T/attempted" > "$T/att.prot"
    while IFS="$TAB" read -r ref rest; do
      vline FAIL p-touched "$ref" "a delete was sent to a protected ref ($(pdec1 "$rest" || echo '?'))"
    done < "$T/att.prot"
  fi
  # run=complete = the last apply went to its end; success = no verify FAIL AND nothing unresolved
  # (an aborted run whose rows were all sent and are now visible can still succeed)
  local run=complete ok=yes
  if [ "${last%%$TAB*}" = ABORTED ]; then
    run=incomplete
    at=$(printf '%s\n' "$last" | tr '\t' '\n' | sed -n 's/^at=//p'); una=$(printf '%s\n' "$last" | tr '\t' '\n' | sed -n 's/^unattempted=//p')
    vline INCOMPLETE run "$H_RUN_ID" "apply stopped at ${at:-?} with ${una:-?} rows not attempted — rerun only if the ABORTED reason allows it (same plan, same digest), then verify the concatenated results"
    if [ "${una:-?}" = "?" ]; then vline UNRESOLVED run "$H_RUN_ID" "the aborted run could not list its rows"; fi
  fi
  if [ "$N_BAD" -ne 0 ] || [ "$N_UNRES" -ne 0 ]; then ok=no; fi
  printf 'VERIFY-SUMMARY\tfail=%d\twarn=%d\tunresolved=%d\trun=%s\tsuccess=%s\n' "$N_BAD" "$N_WARN" "$N_UNRES" "$run" "$ok"
  [ "$ok" = yes ] || exit 1
}

# ---------- codec subcommands ----------
cmd_codec() { # penc | pdec, stdin → stdout
  local a b s
  cat > "$T/in"
  a=$(wc -c < "$T/in"); b=$(tr -d '\000' < "$T/in" | wc -c)
  [ "$a" -eq "$b" ] || die "input contains NUL bytes"
  s=$(cat "$T/in"; printf x); s="${s%x}"
  if [ "$1" = penc ]; then
    CH_V="$s" awk "$AWK_LIB"'BEGIN { printf "%s", penc(ENVIRON["CH_V"], 0) }'
  else
    s="${s%$'\n'}"
    CH_V="$s" awk "$AWK_LIB"'BEGIN { v = pdec(ENVIRON["CH_V"], 0); if (_bad) exit 3; printf "%s", v }' || die "malformed percent-encoding"
  fi
}

cmd_check_plan() { # check-plan --plan F: NUL check + chore_plan.py check + the awk parser, no repo → exit 0 / 1 (one line)
  local f=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --plan) [ $# -ge 2 ] || die "--plan needs a value"; f="$2"; shift 2 ;;
      *) die "unknown flag $1 (usage: chore.sh check-plan --plan <tsv>)" ;;
    esac
  done
  [ -n "$f" ] || die "check-plan needs --plan <tsv>"
  parse_plan "$f"
}

# ---------- main ----------
cmd="${1:-}"; shift || true
case "$cmd" in
  penc|pdec) cmd_codec "$cmd"; exit 0 ;;
  check-plan) cmd_check_plan "$@"; exit 0 ;;
esac
repo_arg="${1:-}"; shift || true
if [ -z "$cmd" ] || [ -z "$repo_arg" ]; then die "usage: chore.sh report|apply|verify <repo> --plan <tsv> ... (see the header of this file)"; fi
case "$cmd" in report|apply|verify) ;; *) die "unknown command $cmd" ;; esac
# every command from here on resolves <repo> through the registry: no registry = a usage error, before any git or gh call
if [ -z "$REPOS_MD" ]; then
  die "usage: CHORE_REPOS_MD is not set — it must name the registry file (markdown table: | name | local path | owner/repo | note |) that $cmd resolves <repo> through"
fi
if [ ! -f "$REPOS_MD" ] || [ ! -r "$REPOS_MD" ]; then
  die "usage: CHORE_REPOS_MD=$REPOS_MD is not a readable file — it must name the registry file (markdown table: | name | local path | owner/repo | note |)"
fi

PLAN=""; JSON=""; DIGEST=""; RESULTS=""; TIERS="1"; YES=0; NO_LOCAL=0; PRINT=0
PROTECT=(); INTEGRATE=(); ONLY=()
while [ $# -gt 0 ]; do
  case "$1" in
    --plan|--json|--protect|--integrate|--digest|--tiers|--only-group|--results) [ $# -ge 2 ] || die "$1 needs a value" ;;
  esac
  case "$1" in
    --plan) PLAN="$2"; shift 2 ;;
    --json) [ "$cmd" = report ] || die "--json is a report flag"; JSON="$2"; shift 2 ;;
    --protect) [ "$cmd" = report ] || die "--protect is a report flag (apply reads the plan header)"; PROTECT+=("$2"); shift 2 ;;
    --integrate) [ "$cmd" = report ] || die "--integrate is a report flag (apply reads the plan header)"; INTEGRATE+=("$2"); shift 2 ;;
    --no-local) [ "$cmd" = report ] || die "--no-local is a report flag"; NO_LOCAL=1; shift ;;
    --print) PRINT=1; shift ;;
    --digest) [ "$cmd" = apply ] || [ "$cmd" = verify ] || die "--digest is an apply / verify flag"; DIGEST="$2"; shift 2 ;;
    --tiers) [ "$cmd" = apply ] || die "--tiers is an apply flag"; TIERS="$2"; shift 2 ;;
    --yes) YES=1; shift ;;
    --only-group) [ "$cmd" = apply ] || die "--only-group is an apply flag"; ONLY+=("$2"); shift 2 ;;
    --results) [ "$cmd" = verify ] || die "--results is a verify flag"; RESULTS="$2"; shift 2 ;;
    *) die "unknown flag $1" ;;
  esac
done

resolve_repo "$repo_arg"
case "$cmd" in
  report) cmd_report ;;
  apply) cmd_apply ;;
  verify) cmd_verify ;;
  *) die "unknown command $cmd" ;;
esac
