#!/usr/bin/env bash
# chore.test.sh — regression table for scripts/chore.sh (plan v3: trinity design rounds R1–R4 + v4.1, code review round M1–M5 / S1–S6, 2026-10-15;
# plan v4 Jira rows + the Jira stage, cases 91–112, 2026-10-19; rerun SKIP-changed close reconcile, 113–116, 2026-10-20;
# v4.3 move-issue rows through the same Jira stage / abort / verify plumbing, 117–124, 2026-10-21; the registry named by
# CHORE_REPOS_MD is required (no default) and its own work tree is never a target, 125–126, 2026-10-27).
# Every case runs on its own copy of one fixture: a bare origin reached through a fake ssh (the origin URL
# stays git@github.com:test/repo.git, so identity checks see a real GitHub URL), a gh stub answering from
# JSON files, and a temp repos.md registry. One ok/FAIL line per case; exits 0 only when every case passes.
# Run: bash __tests__/py/chore.test.sh            (macOS /bin/bash 3.2)
#      docker run --rm -v "$PWD":/z -w /z bash:5 sh -c 'apk add --no-cache git jq ruby python3 >/dev/null && bash __tests__/py/chore.test.sh'
# python3 is required (the approval-page case renders the final TSV with scripts/chore-render.py); missing = FAIL, not skip.
set -euo pipefail           # setup must not continue on a failed step; cases record their own results
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # this file is <skill>/__tests__/py/
ENGINE="$SKILL/scripts/chore.sh"
SH="$BASH"
REAL_GIT="$(command -v git)"
W=""; cleanup() { if [ -n "$W" ] && [ -z "${CHORE_TEST_KEEP:-}" ]; then rm -rf "$W"; fi; }; trap cleanup EXIT
W=$(mktemp -d "${TMPDIR:-/tmp}/chore-test.XXXXXX"); W=$(cd "$W" && pwd -P)
mkdir -p "$W/bin" "$W/gitbin" "$W/c"
export GIT_CONFIG_GLOBAL="$W/gitconfig" GIT_CONFIG_NOSYSTEM=1 TZ=UTC
export GIT_AUTHOR_NAME=tester GIT_AUTHOR_EMAIL=tester@example.com GIT_COMMITTER_NAME=tester GIT_COMMITTER_EMAIL=tester@example.com
printf '[init]\n\tdefaultBranch = develop\n[advice]\n\tdetachedHead = false\n' > "$GIT_CONFIG_GLOBAL"

# fake ssh: run the requested git service (upload-pack / receive-pack) against $FAKE_BARE
printf '#!/bin/sh\nfor last; do :; done\nexec "${last%%%% *}" "$FAKE_BARE"\n' > "$W/bin/fakessh"
export GIT_SSH_COMMAND="$W/bin/fakessh" GIT_SSH_VARIANT=simple

# gh stub: answers from $GH_FIX/*.json, logs every call to $GH_LOG, GH_FAIL=<ERE> forces exit 1,
# swap.<kind>.<n> replaces prs.json and hook.<kind>.<n> (sh) runs right before the n-th call of that kind
# (kinds pr-list-open, pr-view), fail.<kind>.<n> makes that call exit 1 — state changes in the middle of an apply;
# pr close / issue close also append gh-close to $GIT_EVENT_LOG (stage order next to the git wrapper's push lines);
# answer.pr-view / answer.issue-view, when present, is the whole answer of every such view (malformed answers)
printf '#!%s\n' "$SH" > "$W/bin/gh"
cat >> "$W/bin/gh" <<'STUB'
set -uo pipefail
F="$GH_FIX"
printf '%s\n' "$*" >> "$GH_LOG"
if [ -n "${GH_FAIL:-}" ] && printf '%s' "$*" | grep -Eq -- "$GH_FAIL"; then echo "gh-stub: forced failure" >&2; exit 1; fi
q=""; state=""; comment=""; fv=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--jq) q="$2"; shift 2 ;;
    --paginate) shift ;;
    --state) state="$2"; shift 2 ;;
    --comment=*) comment="${1#--comment=}"; shift ;;
    --comment) comment="$2"; shift 2 ;;
    -f) fv="$fv $2"; shift 2 ;;
    --repo|--limit|--json) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
out() { if [ -n "$q" ]; then jq -r "$q"; else cat; fi; }
bump() { local n=0; if [ -f "$F/.n.$1" ]; then n=$(cat "$F/.n.$1"); fi; n=$((n+1)); echo "$n" > "$F/.n.$1"
         if [ -f "$F/swap.$1.$n" ]; then cp "$F/swap.$1.$n" "$F/prs.json"; fi
         if [ -f "$F/hook.$1.$n" ]; then sh "$F/hook.$1.$n"; fi
         if [ -f "$F/fail.$1.$n" ]; then echo "gh-stub: forced failure ($1 call $n)" >&2; exit 1; fi; }
setstate() { jq --argjson n "$2" --arg c "$3" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  'map(if .number == $n then .state = "CLOSED" | .comments = ((.comments // []) + [{body: $c, createdAt: $t}]) else . end)' "$F/$1" > "$F/$1.new" && mv "$F/$1.new" "$F/$1"; }
set -- "${args[@]}"
case "$1 ${2:-}" in
  "repo view") out < "$F/repo.json" ;;
  "pr list")
    if [ "$state" = open ]; then bump pr-list-open; jq '[.[] | select(.state == "OPEN")]' "$F/prs.json" | out
    else jq '.' "$F/prs.json" | out; fi ;;
  "pr view") bump pr-view
             if [ -f "$F/answer.pr-view" ]; then out < "$F/answer.pr-view"; else jq --argjson n "$3" '.[] | select(.number == $n)' "$F/prs.json" | out; fi ;;
  "pr close") printf '%s' "$comment" > "$F/comment.pr.$3"; setstate prs.json "$3" "$comment"
              if [ -n "${GIT_EVENT_LOG:-}" ]; then echo gh-close >> "$GIT_EVENT_LOG"; fi ;;
  "issue list") jq '[.[] | select(.state == "OPEN")]' "$F/issues.json" | out ;;
  "issue view") if [ -f "$F/answer.issue-view" ]; then out < "$F/answer.issue-view"; else jq --argjson n "$3" '.[] | select(.number == $n)' "$F/issues.json" | out; fi ;;
  "issue close") printf '%s' "$comment" > "$F/comment.issue.$3"; setstate issues.json "$3" "$comment"
                 if [ -n "${GIT_EVENT_LOG:-}" ]; then echo gh-close >> "$GIT_EVENT_LOG"; fi ;;
  "api graphql")
    case "$fv" in
      *"pullRequests(states:OPEN)"*) if [ -f "$F/pr-open-total" ]; then t=$(cat "$F/pr-open-total"); else t=$(jq '[.[] | select(.state == "OPEN")] | length' "$F/prs.json"); fi
                      printf '{"data":{"repository":{"pullRequests":{"totalCount":%s}}}}' "$t" | out ;;
      *pullRequests*) if [ -f "$F/pr-total" ]; then t=$(cat "$F/pr-total"); else t=$(jq length "$F/prs.json"); fi
                      printf '{"data":{"repository":{"pullRequests":{"totalCount":%s}}}}' "$t" | out ;;
      *issues*) t=$(jq '[.[] | select(.state == "OPEN")] | length' "$F/issues.json")
                printf '{"data":{"repository":{"issues":{"totalCount":%s}}}}' "$t" | out ;;
      *) echo "gh-stub: unknown graphql" >&2; exit 2 ;;
    esac ;;
  "api "*)
    p="${2%%\?*}"
    case "$p" in
      repos/*/branches) out < "$F/protected.json" ;;
      repos/*/rulesets) out < "$F/rulesets.json" ;;
      repos/*/rulesets/*) out < "$F/ruleset-${p##*/}.json" ;;
      repos/*/environments) out < "$F/environments.json" ;;
      repos/*/environments/*/deployment-branch-policies) e="${p#*/environments/}"; e="${e%%/*}"; out < "$F/env-$e.json" ;;
      *) echo "gh-stub: unknown api $p" >&2; exit 2 ;;
    esac ;;
  *) echo "gh-stub: unknown command $*" >&2; exit 2 ;;
esac
STUB
# git wrapper (only on PATH where a case needs it): logs every push's arguments to $GIT_PUSH_LOG, drops
# porcelain lines matching $GIT_DROP_PORCELAIN, fails ls-remote when $GIT_FAIL_LSREMOTE is set — real git always
# prints the lines, so this is the only way in. After a real push: $GIT_PUSH_RM_OUT removes the engine's
# $CHT/push.out (its control file), $GIT_PUSH_KILL=<TERM|INT|HUP> sends that signal to the engine (the wrapper's parent;
# INT also to the wrapper itself, like a terminal's Ctrl-C to the process group).
# $GIT_EVENT_LOG gets one line per push / ls-remote call, in call order (counts calls whose output is hidden too).
# $GIT_MOVE_BRANCH + $GIT_MOVE_TO: right before a `branch -d/-D` or `update-ref -d`, move that local branch to
# that oid — a concurrent commit landing between the engine's tip check and its delete.
printf '#!%s\nREAL=%s\n' "$SH" "$REAL_GIT" > "$W/gitbin/git"
cat >> "$W/gitbin/git" <<'WRAP'
p=0; l=0; for a in "$@"; do case "$a" in push) p=1 ;; ls-remote) l=1 ;; esac; done
if [ -n "${GIT_MOVE_BRANCH:-}" ] && [ "${1:-}" = -C ]; then
  dl=0; tg=0
  for a in "$@"; do case "$a" in -d|-D) dl=1 ;; esac; [ "$a" = "$GIT_MOVE_BRANCH" ] || [ "$a" = "refs/heads/$GIT_MOVE_BRANCH" ] && tg=1; done
  case " $* " in *" branch "*|*" update-ref "*) ;; *) dl=0 ;; esac
  [ "$tg" = 1 ] || dl=0                              # only the delete of that very branch
  if [ "$dl" = 1 ]; then "$REAL" -C "$2" update-ref "refs/heads/$GIT_MOVE_BRANCH" "$GIT_MOVE_TO"; fi
fi
if [ -n "${GIT_EVENT_LOG:-}" ]; then if [ "$p" = 1 ]; then echo push >> "$GIT_EVENT_LOG"; elif [ "$l" = 1 ]; then echo ls-remote >> "$GIT_EVENT_LOG"; fi; fi
if [ "$p" = 1 ] && [ -n "${GIT_PUSH_LOG:-}" ]; then printf 'PUSH' >> "$GIT_PUSH_LOG"; printf ' %s' "$@" >> "$GIT_PUSH_LOG"; echo >> "$GIT_PUSH_LOG"; fi
if [ "$l" = 1 ] && [ -n "${GIT_FAIL_LSREMOTE:-}" ]; then echo "git-wrapper: ls-remote failure" >&2; exit 128; fi
if [ "$p" = 1 ] && { [ -n "${GIT_PUSH_RM_OUT:-}" ] || [ -n "${GIT_PUSH_KILL:-}" ]; }; then
  "$REAL" "$@"; rc=$?
  if [ -n "${GIT_PUSH_RM_OUT:-}" ]; then rm -f "$CHT/push.out"; fi
  # INT as from a terminal reaches the whole process group: git dies of it too, so bash sees its child killed by INT
  # (a child that exits normally lets bash drop the INT — wait-and-cooperative-exit). TERM / HUP: the engine only.
  if [ "${GIT_PUSH_KILL:-}" = INT ]; then kill -s INT "$PPID"; kill -s INT $$; fi
  if [ -n "${GIT_PUSH_KILL:-}" ]; then kill -s "$GIT_PUSH_KILL" "$PPID"; fi
  exit "$rc"
fi
if [ "$p" = 1 ] && [ -n "${GIT_DROP_PORCELAIN:-}" ]; then
  "$REAL" "$@" > "$GIT_WRAP_OUT"; rc=$?
  grep -v -E -- "$GIT_DROP_PORCELAIN" "$GIT_WRAP_OUT" || true
  exit "$rc"
fi
exec "$REAL" "$@"
WRAP
chmod +x "$W/bin/fakessh" "$W/bin/gh" "$W/gitbin/git"
export PATH="$W/bin:$PATH"
# sigdfl <SIG> <cmd…>: run it with that signal at its default disposition. A job started with `&` from a
# non-interactive shell (e.g. this suite run in the background) inherits SIGINT ignored, under nohup SIGHUP is ignored,
# and bash cannot trap a signal that was ignored at its start — the engine's trap would silently not exist (case 71).
# SIGPIPE and SIGXFSZ go back to default too: CPython starts with them ignored and exec would hand that on.
cat > "$W/bin/sigdfl" <<'SIGDFL'
#!/bin/sh
exec python3 -I -c 'import os, signal, sys
for name in ("SIG" + sys.argv[1], "SIGPIPE", "SIGXFSZ"):
    if hasattr(signal, name):
        signal.signal(getattr(signal, name), signal.SIG_DFL)
os.execvp(sys.argv[2], sys.argv[2:])' "$@"
SIGDFL
chmod +x "$W/bin/sigdfl"
# chore_plan.py stand-ins (CHORE_PLAN_PY): plan-ok accepts every plan, so the engine's own awk parser is what refuses
# (its copies of the rules stay pinned); plan-no refuses with one line; plan-usage exits 2 with two lines
printf 'import sys\nsys.exit(0)\n' > "$W/bin/plan-ok.py"
printf 'import sys\nsys.stderr.write("chore_plan: forced by the test\\n")\nsys.exit(1)\n' > "$W/bin/plan-no.py"
printf 'import sys\nsys.stderr.write("usage: x\\nmore\\n")\nsys.exit(2)\n' > "$W/bin/plan-usage.py"

# ---------- template fixture ----------
TPL="$W/tpl"; S="$W/seed"
mkdir -p "$TPL/fix"
git init -q --bare "$TPL/origin.git"
git init -q "$S"
s() { git -C "$S" "$@"; }
put() { mkdir -p "$(dirname "$S/$1")"; printf '%s\n' "$2" > "$S/$1"; }
ci() { s add -A; s commit -q -m "$1"; s rev-parse HEAD; }
mergeno() { s merge -q --no-ff -m "merge $1" "$1"; s rev-parse HEAD; }

put README "seed"
# workflow variants: block list + quoted item, flow mapping, quoted "on" key with a scalar branch, non-workflow file
put .github/workflows/deploy.yml 'name: deploy
on:
  push:
    branches:
      - deploy/stage
      - "deploy/staging"
  workflow_dispatch: {}'
put .github/workflows/ci.yaml "on: { pull_request: { branches: [develop, 'main'] } }"
put .github/workflows/single.yml '"on":
  push:
    branches: deploy/single'
put .github/workflows/notes.md 'branches: [not-a-workflow]'
D0=$(GIT_AUTHOR_DATE='2025-01-01T00:00:00Z' GIT_COMMITTER_DATE='2025-01-01T00:00:00Z' ci D0)
s branch main; s branch deploy/staging; s branch deploy/single; s branch deploy/hidden; s branch r2s/x
s checkout -q -b deploy/stage                    # deploy/hidden is named only in this tree → closure round 2
put .github/workflows/hidden.yml 'on:
  push:
    branches: [deploy/hidden]'
S1=$(ci S1)
s checkout -q develop
s checkout -q -b feat/merged; put a1 x; A1=$(ci A1); s checkout -q develop; M1=$(mergeno feat/merged)
s checkout -q -b feat/squash; put a2 x; A2=$(ci A2); s checkout -q develop; put a2 x; S2=$(ci "squash feat/squash")
EB='enc/a%b;c,d=e-한글'
s checkout -q -b "$EB"; put a13 x; A13=$(ci A13); s checkout -q develop; M13=$(mergeno "$EB")
put s1squash x; M3=$(ci "squash deploy/stage")
s checkout -q -b feat/moved; put a4 x; A4=$(ci A4); s checkout -q develop; M4=$(mergeno feat/moved)
s checkout -q feat/moved; put a4b x; A4b=$(ci A4b); s checkout -q develop
s checkout -q -b feat/fork; put a5 x; A5=$(ci A5); s checkout -q develop; M5=$(mergeno feat/fork)
s checkout -q -b feat/base; put b1 x; B1=$(ci B1); s branch feat/anc; put b2 x; B2=$(ci B2)
s checkout -q -b feat/child; put c1 x; C1=$(ci C1)
s checkout -q -b feat/intobase feat/base; put a7 x; A7=$(ci A7); s checkout -q feat/base; M7=$(mergeno feat/intobase)
s checkout -q -b junk/x "$D0"; put j1 x; J1=$(ci J1)
s checkout -q -b feat/notin develop; put n1 x; N1=$(ci N1)
s checkout -q -b feat/nullmerge develop; put n2 x; N2=$(ci N2)
s checkout -q -b feat/missingobj develop; put n3 x; N3=$(ci N3)
s checkout -q -b feat/staging-a "$D0"; put x1 x; X1=$(ci X1); s checkout -q deploy/staging; MX=$(mergeno feat/staging-a); put x2 x; X2=$(ci X2)
s checkout -q -b 'rel;base' "$D0"; put rb1 x; RB1=$(ci RB1); s checkout -q -b 'semi;head'; put sh1 x; SH1=$(ci SH1)
s checkout -q 'rel;base'; MS=$(mergeno 'semi;head')
s checkout -q -b 'int,x' "$D0"; put ix1 x; IX1=$(ci IX1); s checkout -q -b feat/comma; put fc1 x; FC1=$(ci FC1)
s checkout -q 'int,x'; MC=$(mergeno feat/comma)
s checkout -q -b 'fix/a+b' develop; put fab x; FAB=$(ci FAB)
s checkout -q develop; DTIP=$(s rev-parse HEAD); s branch feat/sametip    # last: tip == develop tip
s push -q "$TPL/origin.git" --all 2>/dev/null
FAKE_BARE="$TPL/origin.git" git clone -q git@github.com:test/repo.git "$TPL/work" 2>/dev/null
git -C "$TPL/work" branch -q --track feat/merged origin/feat/merged
git -C "$TPL/work" branch -q --track feat/squash origin/feat/squash
rm -rf "$S"
: "$RB1 $IX1 $B1 $B2 $A4 $A4b $A5 $A7 $J1 $N2 $N3 $M4 $M5 $M7 $FAB $X1"   # referenced through the PR fixture

mkpr() { # num state head head_oid base merge_oid|null [cross] [owner]
  jq -n --argjson n "$1" --arg s "$2" --arg h "$3" --arg o "$4" --arg b "$5" --arg m "$6" --arg c "${7:-false}" --arg w "${8:-test}" \
    '{number: $n, state: $s, headRefName: $h, headRefOid: $o, baseRefName: $b, isCrossRepository: ($c == "true"),
      headRepositoryOwner: {login: $w}, headRepository: {name: "repo"}, author: {login: ("dev" + ($n | tostring))},
      updatedAt: "2026-10-01T00:00:00Z", title: ("PR " + ($n | tostring) + " " + $h),
      mergeCommit: (if $m == "null" then null else {oid: $m} end), comments: []}'
}
{
  mkpr 1 MERGED feat/merged "$A1" develop "$M1"
  mkpr 2 MERGED feat/squash "$A2" develop "$S2"
  mkpr 3 MERGED deploy/stage "$S1" develop "$M3"
  mkpr 4 MERGED feat/moved "$A4" develop "$M4"
  mkpr 5 MERGED feat/fork "$A5" develop "$M5" true someone
  mkpr 6 OPEN feat/child "$C1" feat/base null
  mkpr 7 MERGED feat/intobase "$A7" feat/base "$M7"
  mkpr 8 MERGED feat/sametip "$DTIP" develop "$DTIP"
  mkpr 9 MERGED feat/notin "$N1" develop "$J1"
  mkpr 10 MERGED feat/nullmerge "$N2" develop null
  mkpr 11 MERGED feat/missingobj "$N3" develop 0123456789abcdef0123456789abcdef01234567
  mkpr 13 MERGED "$EB" "$A13" develop "$M13"
  mkpr 14 MERGED 'semi;head' "$SH1" 'rel;base' "$MS"
  mkpr 15 MERGED feat/comma "$FC1" 'int,x' "$MC"
  mkpr 16 MERGED feat/staging-a "$X1" deploy/staging "$MX"
  mkpr 40 OPEN 'fix/a+b' "$FAB" develop null
} | jq -s . > "$TPL/fix/prs.json"
printf '%s\n' '[{"number":20,"state":"OPEN","title":"old question","labels":[],"updatedAt":"2026-09-01T00:00:00Z","author":{"login":"u1"},"comments":[]},
 {"number":21,"state":"OPEN","title":"dup; of #20","labels":[],"updatedAt":"2026-09-02T00:00:00Z","author":{"login":"u2"},"comments":[]}]' > "$TPL/fix/issues.json"
printf '%s\n' '{"id":"R_test","defaultBranchRef":{"name":"develop"},"hasIssuesEnabled":true}' > "$TPL/fix/repo.json"
printf '[]\n' > "$TPL/fix/protected.json"; printf '[]\n' > "$TPL/fix/rulesets.json"
printf '{"total_count":0,"environments":[]}\n' > "$TPL/fix/environments.json"

# ---------- case helpers ----------
set +e                       # from here on every case records its own results
fail=0; n=0; CASE=""; CF=""; RC=0
newcase() {
  C="$W/c/$1"; rm -rf "$C"; cp -R "$TPL" "$C"
  export FAKE_BARE="$C/origin.git" GH_FIX="$C/fix" GH_LOG="$C/gh.log" CHORE_REPOS_MD="$C/repos.md"
  unset GH_FAIL GIT_DROP_PORCELAIN GIT_FAIL_LSREMOTE CHORE_BATCH GIT_PUSH_RM_OUT GIT_PUSH_KILL GIT_MOVE_BRANCH GIT_MOVE_TO APP_WRAP
  unset CHORE_JIRA CHORE_JUDGE CHORE_PLAN_PY JSTUB_LOG JSTUB_OUT JSTUB_OUTTAIL JSTUB_ERR JSTUB_JOURNAL JSTUB_JTAIL JSTUB_JMODE \
    JSTUB_SLEEP JSTUB_READY JSTUB_APPOUT JSTUB_RC JSTUB_VOUT JSTUB_VERR JSTUB_VRC JSTUB_HOOK AWK_KILL_AT AWK_KILL_CNT AWK_KILL_SIG AWK_FAIL_COMMENT_READ CDPATH
  export GIT_PUSH_LOG="$C/push.log" GIT_EVENT_LOG="$C/git-events.log"; : > "$GIT_PUSH_LOG"; : > "$GIT_EVENT_LOG"
  printf '| repo | local path | remote | note |\n|---|---|---|---|\n| `t` | `%s` | `test/repo` | test |\n' "$C/work" > "$CHORE_REPOS_MD"
  : > "$GH_LOG"
}
begin() { CASE="$1"; CF=""; newcase "$2"; }
end() { n=$((n+1)); if [ -z "$CF" ]; then printf 'ok   %s\n' "$CASE"; else printf 'FAIL %s :: %s\n' "$CASE" "$CF"; fail=$((fail+1)); fi; }
need() { local d="$1"; shift; if ! "$@" >/dev/null 2>&1; then if [ -z "$CF" ]; then CF="$d"; fi; fi; }
dg() { { shasum -a 256 "$1" 2>/dev/null || sha256sum "$1"; } | awk '{ print $1 }'; }
rep() { "$SH" "$ENGINE" report t --plan "$C/plan.tsv" --json "$C/plan.json" "$@" > "$C/rep.out" 2> "$C/rep.err"; RC=$?; }
app() { local d; d=$(dg "$C/plan.tsv"); printf '%s\n' "$d" > "$C/approved.sha"      # the digest recorded at approval
        ${APP_WRAP[@]+"${APP_WRAP[@]}"} "$SH" "$ENGINE" apply t --plan "$C/plan.tsv" --digest "$d" "$@" > "$C/app.out" 2> "$C/app.err"; RC=$?; }
ver() { local r="${1:-$C/app.out}" d; if [ $# -gt 0 ]; then shift; fi        # later --digest in "$@" overrides
        if [ -f "$C/approved.sha" ]; then d=$(cat "$C/approved.sha"); else d=$(dg "$C/plan.tsv"); fi
        "$SH" "$ENGINE" verify t --plan "$C/plan.tsv" --results "$r" --digest "$d" "$@" > "$C/ver.out" 2> "$C/ver.err"; RC=$?; }
appw() { PATH="$W/gitbin:$PATH" app "$@"; }   # apply with the logging git wrapper first on PATH
rc() { [ "$RC" = "$1" ]; }
prow() { awk -F'\t' -v t="$1" -v a="$2" -v r="$3" 'NR > 1 && $1 == t && $2 == a && $3 == r { f = 1 } END { exit f ? 0 : 1 }' "$C/plan.tsv"; }
noact() { ! awk -F'\t' -v a="$1" -v r="$2" 'NR > 1 && $2 == a && $3 == r { f = 1 } END { exit f ? 0 : 1 }' "$C/plan.tsv"; }
norow() { ! awk -F'\t' -v r="$1" 'NR > 1 && ($3 == r || $3 == "remote:" r) { f = 1 } END { exit f ? 0 : 1 }' "$C/plan.tsv"; }
jrow() { jq -e --arg r "$1" "[.rows[] | select(.ref == \$r) | select($2)] | length == 1" "$C/plan.json"; }
jtrue() { jq -e "$1" "$C/plan.json"; }
res() { grep -qF "RESULT$(printf '\t')$1$(printf '\t')$2$(printf '\t')$3$(printf '\t')" "$C/app.out"; }
resr() { grep -F "RESULT$(printf '\t')$1$(printf '\t')$2$(printf '\t')$3$(printf '\t')" "$C/app.out" | grep -qF -- "$4"; }
noresult() { ! grep -qF "$(printf '\t')$1$(printf '\t')" "$C/app.out"; }
has() { grep -qF -- "$2" "$1"; }
nres() { awk -F'\t' -v r="$1" '$1 == "RESULT" && $4 == r { n++ } END { print n + 0 }' "$C/app.out"; }   # RESULT lines for one ref
nabort() { awk -F'\t' '$1 == "ABORTED" { n++ } END { print n + 0 }' "$C/app.out"; }
# a push happened and no ls-remote was called after it (the stop report must not touch the network)
no_lsremote_after_push() { awk '$0 == "push" { p = 1 } $0 == "ls-remote" && p { bad = 1 } END { exit (p && !bad) ? 0 : 1 }' "$C/git-events.log"; }
hasnt() { ! grep -qF -- "$2" "$1"; }
bare_has() { git --git-dir="$C/origin.git" show-ref --verify -q "refs/heads/$1"; }
bare_lacks() { ! bare_has "$1"; }
bare_set() { git --git-dir="$C/origin.git" update-ref "refs/heads/$1" "$2"; }
bare_advance() { local b="$C/origin.git" tip tree new
  tip=$(git --git-dir="$b" rev-parse "refs/heads/$1"); tree=$(git --git-dir="$b" rev-parse "$tip^{tree}")
  new=$(git --git-dir="$b" commit-tree "$tree" -p "$tip" -m "advance $1"); git --git-dir="$b" update-ref "refs/heads/$1" "$new"; }
bare_commit() { # <branch> <path> <content>: one commit on <branch> in the bare (through a scratch clone)
  local t="$C/scratch"; rm -rf "$t"; git clone -q "$C/origin.git" "$t" 2>/dev/null; git -C "$t" checkout -q "$1"
  mkdir -p "$(dirname "$t/$2")"; printf '%s\n' "$3" > "$t/$2"; git -C "$t" add -A; git -C "$t" commit -q -m "edit $2"
  git -C "$t" push -q origin "$1" 2>/dev/null; rm -rf "$t"; }
runid() { awk -F'\t' 'NR == 1 { for (i = 2; i <= NF; i++) if ($i ~ /^run_id=/) print substr($i, 8) }' "$C/plan.tsv"; }
local_has() { git -C "$C/work" show-ref --verify -q "refs/heads/$1"; }
edit_plan() { # awk program over the plan (FS/OFS tab) → rewritten in place
  awk -F'\t' -v OFS='\t' "$1" "$C/plan.tsv" > "$C/plan.new" && mv "$C/plan.new" "$C/plan.tsv"; }
promote_pr6() { # the semantic layer's promotion: the tier-3 pr#6 row BECOMES a tier-2 close-pr row with evidence $1
  # (already encoded) — replaced in place, never added beside it (one target, one state; chore-render.py agrees)
  awk -F'\t' -v OFS='\t' -v e="$1" 'NR > 1 && $1 == 3 && $2 == "report" && $3 == "pr#6" { print 2, "close-pr", $3, $4, $5, e; next } { print }' "$C/plan.tsv" > "$C/plan.new" && mv "$C/plan.new" "$C/plan.tsv"; }
std_report_ok() { rep; [ "$RC" = 0 ]; }

# ---------- report: classification ----------
begin "01 ① workflow-trigger branches stay protected (block/flow/quoted-on/scalar variants + closure), even with a merged PR as head" std
rep
need "report rc=$RC" rc 0
need "deploy/stage protected" jrow remote:deploy/stage '.tier == 3 and .reason == "protected" and (.protected_by | contains("workflow#deploy.yml"))'
need "deploy/stage has no delete row" noact delete-remote deploy/stage
need "deploy/staging (quoted item) protected" jrow remote:deploy/staging '.reason == "protected"'
need "main (flow style) protected" jrow remote:main '.reason == "protected" and (.protected_by | contains("workflow#ci.yaml"))'
need "deploy/single (quoted on key, scalar) protected" jrow remote:deploy/single '.reason == "protected"'
need "deploy/hidden (closure round 2) protected" jrow remote:deploy/hidden '.reason == "protected" and (.protected_by | contains("workflow#hidden.yml"))'
need "develop protected as default" jrow remote:develop '.reason == "protected" and (.protected_by | contains("default"))'
need "notes.md not read as a workflow" hasnt "$C/plan.tsv" not-a-workflow
need "report made no close call" hasnt "$GH_LOG" close
end

begin "02 ② --protect 'r2s/*' keeps a branch cut today from an old commit; PR-less ancestor is held, never deleted" std
rep
need "without --protect: contained-hold" jrow remote:r2s/x '.tier == 3 and .reason == "contained-hold" and (.evidence | startswith("contained in develop"))'
rep --protect 'r2s/*'
need "with --protect: protected" jrow remote:r2s/x '.reason == "protected" and (.protected_by | contains("--protect"))'
need "header protect=" jtrue '.header.protect == ["r2s/*"]'
end

begin "03 ③ tip moved after the merge → no delete basis" std
rep
need "no delete row for feat/moved" noact delete-remote feat/moved
end

begin "04 ④ same-name fork PR MERGED is not a basis" std
rep
need "no delete row for feat/fork" noact delete-remote feat/fork
need "held as contained" jrow remote:feat/fork '.reason == "contained-hold"'
end

begin "05 ⑤ ancestor of a non-I ref (OPEN PR base) is not evidence" std
rep
need "no row at all for feat/anc" norow feat/anc
need "feat/base protected as open-pr-base" jrow remote:feat/base '.reason == "protected" and (.protected_by | contains("open-pr-base#6"))'
end

begin "06 ⑮ PR merged into a protected non-I ref (OPEN PR base) is not a basis" std
rep
need "no delete row for feat/intobase" noact delete-remote feat/intobase
end

begin "07 ㉑ tip equal to an I tip → hold, even with a matching merged PR" std
rep
need "same-as-integration-tip" jrow remote:feat/sametip '.tier == 3 and .reason == "same-as-integration-tip" and (.evidence | startswith("same as develop tip"))'
end

begin "08 ㉛ merge commit not in the current base history → tier3, wording fixed" std
rep
need "merge-not-in-base row" jrow remote:feat/notin '.tier == 3 and .reason == "merge-not-in-base" and .evidence == "merge commit not found in current history of develop — hold"'
need "no hypothesis wording" hasnt "$C/plan.json" rewritten
end

begin "09 ㉜ mergeCommit null → tier3 merge-commit-unknown" std
rep
need "nullmerge held" jrow remote:feat/nullmerge '.reason == "merge-commit-unknown" and .evidence == "merge commit cannot be verified — hold"'
end

begin "10 merge commit oid present in PR data but object missing locally → merge-commit-unknown" std
rep
need "missingobj held" jrow remote:feat/missingobj '.reason == "merge-commit-unknown"'
need "no delete row" noact delete-remote feat/missingobj
end

begin "11 basis (a) positives incl. squash merge and a % ; , = + Korean name joined to its PR" std
rep
need "feat/merged tier2" prow 2 delete-remote feat/merged
need "feat/squash tier2 (squash: head not an ancestor)" prow 2 delete-remote feat/squash
need "encoded name tier2" prow 2 delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글'
need "snapshot keys" jrow 'enc/a%b;c,d=e-한글' '.snapshot.basis == "a" and .snapshot.pr == "13" and .snapshot.pr_merge_commit == "'"$M13"'" and .snapshot.pr_author == "dev13" and .snapshot.tip_author == "tester@example.com"'
need "exactly 3 remote deletes" jtrue '[.rows[] | select(.action == "delete-remote")] | length == 3'
end

begin "12 JSON shape = renderer contract (plan_sha256, header types, per-row reason/group/protected_by)" std
rep
need "plan_sha256" jtrue '.plan_sha256 == "'"$(dg "$C/plan.tsv")"'"'
need "header types" jtrue '(.header.I == ["develop"]) and (.header.no_local == false) and (.header.Itips.develop | test("^[0-9a-f]{40}$")) and (.header.groups | index("feat/*") != null) and (.header.Ptips | has("deploy/hidden"))'
need "row count = plan rows" jtrue '(.rows | length) == '"$(($(wc -l < "$C/plan.tsv") - 1))"
need "reason codes closed set" jtrue '[.rows[].reason] - ["protected","merged-pr","merge-not-in-base","merge-commit-unknown","same-as-integration-tip","contained-hold","stale","checked-out","local-held","open-pr","open-issue","worktree-prune"] == []'
need "group function" jrow feat/merged '.action == "delete-remote" and .group == "feat/*" and .reason == "merged-pr" and .protected_by == ""'
need "pr/issue groups" jtrue '([.rows[] | select(.ref == "pr#6") | .group] == ["pull-requests"]) and ([.rows[] | select(.ref == "issue#21") | .evidence] == ["dup; of #20"])'
need "stderr summary" has "$C/rep.err" "tier2 by group"
end

begin "13 M2 is for filter syntax only: an OPEN PR head named fix/a+b is a literal and protects itself" std
rep
need "report rc=$RC" rc 0
need "fix/a+b protected" jrow 'remote:fix/a+b' '.reason == "protected" and (.protected_by | contains("open-pr-head#40"))'
end

begin "14 ⑯ unsupported branch filters die (+ ? [0-9] !x), report writes no plan" std
for pat in "'release+x'" "'rel?'" "'v[0-9]'" "'!skip'"; do
  bare_commit develop .github/workflows/m2.yml "on: { push: { branches: [ $pat ] } }"
  rm -f "$C/plan.tsv"; rep
  need "die for $pat (rc=$RC)" rc 1
  need "message for $pat" has "$C/rep.err" "unsupported branch filter"
  need "names source for $pat" has "$C/rep.err" "workflow#m2.yml — extend the matcher (chore.sh) before running; --protect cannot exempt a source"
  need "no plan for $pat" test ! -e "$C/plan.tsv"
done
end

begin "15 ⑧ gh API failure / workflow YAML failure / partial PR index → die, no plan" std
GH_FAIL='rulesets' rep
need "gh failure dies" rc 1
need "gh failure message" has "$C/rep.err" "gh failed"
need "no plan" test ! -e "$C/plan.tsv"
bare_commit develop .github/workflows/bad.yml 'on: [push'
rep
need "yaml failure dies" rc 1
need "yaml failure names file and ref" has "$C/rep.err" "workflow parse failed: .github/workflows/bad.yml at origin/develop"
newcase std-count; echo 999 > "$GH_FIX/pr-total"; rep
need "count mismatch dies" rc 1
need "count message" has "$C/rep.err" "partial index"
end

begin "16 rulesets: active branch ruleset incl. ~DEFAULT_BRANCH + refs/heads/ prefix; evaluate / tag rulesets ignored" std
printf '[{"id":1},{"id":2},{"id":3}]\n' > "$GH_FIX/rulesets.json"
printf '{"id":1,"target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH","refs/heads/feat/merged"],"exclude":["refs/heads/x"]}}}\n' > "$GH_FIX/ruleset-1.json"
printf '{"id":2,"target":"branch","enforcement":"evaluate","conditions":{"ref_name":{"include":["refs/heads/feat/squash"]}}}\n' > "$GH_FIX/ruleset-2.json"
printf '{"id":3,"target":"tag","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/'"$EB"'"]}}}\n' > "$GH_FIX/ruleset-3.json"
rep
need "feat/merged protected by ruleset" jrow remote:feat/merged '.reason == "protected" and (.protected_by | contains("ruleset#1"))'
need "develop also via ruleset" jrow remote:develop '(.protected_by | contains("ruleset#1"))'
need "evaluate ruleset ignored" prow 2 delete-remote feat/squash
need "tag ruleset ignored" prow 2 delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글'
end

begin "17 ruleset ~ALL protects every branch → zero deletes" std
printf '[{"id":7}]\n' > "$GH_FIX/rulesets.json"
printf '{"id":7,"target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~ALL"]}}}\n' > "$GH_FIX/ruleset-7.json"
rep
need "report ok" rc 0
need "no tier2" jtrue '[.rows[] | select(.tier == 2)] | length == 0'
need "every remote row protected" jtrue '[.rows[] | select(.ref | startswith("remote:")) | select(.reason != "protected")] | length == 0'
end

begin "18 environment deployment-branch policy (name with a space) protects its branches; tag policies ignored" std
printf '{"total_count":1,"environments":[{"name":"prod env","deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}]}\n' > "$GH_FIX/environments.json"
printf '{"branch_policies":[{"name":"feat/squash","type":"branch"},{"name":"feat/merged","type":"tag"}]}\n' > "$GH_FIX/env-prod%20env.json"
rep
need "report ok" rc 0
need "feat/squash protected" jrow remote:feat/squash '.reason == "protected" and (.protected_by | contains("environment#prod env"))'
need "tag policy ignored" prow 2 delete-remote feat/merged
end

begin "19 ⑲ origin with two push URLs / push URL to another repo → die" std
git -C "$C/work" remote set-url --add --push origin git@github.com:test/repo.git
git -C "$C/work" remote set-url --add --push origin git@github.com:test/repo.git
rep
need "two push URLs die" rc 1
need "message" has "$C/rep.err" "push URLs"
newcase std-push; git -C "$C/work" remote set-url --push origin git@github.com:test/other.git; rep
need "foreign push URL dies" rc 1
need "message 2" has "$C/rep.err" "is not test/repo"
end

begin "20 local branches: merged → tier1 delete-local / -force, checked out → tier3, worktree-prune tier1" std
git -C "$C/work" worktree add -q "$C/wt" feat/squash 2>/dev/null
rep
need "feat/merged delete-local" prow 1 delete-local feat/merged
need "feat/squash checked out" jrow local:feat/squash '.reason == "checked-out"'
need "develop checked out" jrow local:develop '.reason == "checked-out"'
need "worktree-prune" prow 1 worktree-prune .
git -C "$C/work" worktree remove "$C/wt"
rep
need "feat/squash delete-local-force (not an I ancestor)" prow 1 delete-local-force feat/squash
end

begin "21 --no-local holds every local action; forged delete-local / worktree-prune rows in that plan are refused (S3)" std
rep --no-local
need "local-held" jrow local:feat/merged '.tier == 3 and .reason == "local-held"'
need "worktree held" jrow . '.tier == 3 and .reason == "local-held"'
need "header no_local" jtrue '.header.no_local == true'
need "no tier1" jtrue '[.rows[] | select(.tier == 1)] | length == 0'
awk -F'\t' -v OFS='\t' -v a="$A1" -v m="$M1" '{ print } END { print 1, "delete-local", "feat/merged", a, "basis=a;pr=1;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=" a ";pr_merge_commit=" m ";tip_author=x;tip_date=2026-01-01", "x" }' "$C/plan.tsv" > "$C/p2" && mv "$C/p2" "$C/plan.tsv"
app --tiers 1
need "forged local row dies" rc 1
# v4: chore_plan.py check runs first and refuses this row for being kept and deleted at once (its message is the
# contract); the no_local rule itself is reached by a forged row whose target has no kept row
need "message" has "$C/app.err" "delete-local feat/merged is also listed as kept (local:feat/merged)"
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 1
need "awk alone refuses the forged local row" has "$C/app.err" "delete-local row in a --no-local plan"
rep --no-local; printf '1\tworktree-prune\t.\t-\t-\tx\n' >> "$C/plan.tsv"
app --tiers 1
need "forged worktree-prune dies (S3)" rc 1
need "S3 message" has "$C/app.err" "worktree-prune . is also listed as kept (.)"
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 1
need "awk alone refuses the forged worktree-prune (S3)" has "$C/app.err" "worktree-prune row in a --no-local plan"
rep --no-local; git -C "$C/work" branch -q feat/nokept "$A1"
awk -F'\t' -v OFS='\t' -v a="$A1" -v m="$M1" '{ print } END { print 1, "delete-local", "feat/nokept", a, "basis=a;pr=1;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=" a ";pr_merge_commit=" m ";tip_author=x;tip_date=2026-01-01", "x" }' "$C/plan.tsv" > "$C/p2" && mv "$C/p2" "$C/plan.tsv"
app --tiers 1
need "forged local row without a kept twin dies (S3)" rc 1
need "S3 no_local message (local)" has "$C/app.err" "delete-local row in a no_local=1 plan"
need "never deleted" local_has feat/nokept
rep --no-local; edit_plan 'NR > 1 && $2 == "report" && $3 == "." { next } { print }'; printf '1\tworktree-prune\t.\t-\t-\tx\n' >> "$C/plan.tsv"
app --tiers 1
need "forged worktree-prune without a kept twin dies (S3)" rc 1
need "S3 no_local message (prune)" has "$C/app.err" "worktree-prune row in a no_local=1 plan"
end

# ---------- apply ----------
begin "22 apply tier2: deletes the three basis-(a) branches, backups first (㉒a), exit 0, verify passes" std
rep; app --tiers 2
need "needs --yes" rc 1
app --tiers 2 --yes
need "apply rc=$RC" rc 0
need "feat/merged OK" res OK delete-remote feat/merged
need "feat/squash OK" res OK delete-remote feat/squash
need "enc OK" res OK delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글'
need "remote gone" bare_lacks feat/merged
need "encoded name gone" bare_lacks "$EB"
need "protected untouched" bare_has deploy/stage
need "summary" has "$C/app.out" "SUMMARY$(printf '\t')ok=3$(printf '\t')skip=0$(printf '\t')fail=0$(printf '\t')unknown=0"
need "backup ref = expected" test "$(git -C "$C/work" rev-parse "refs/chore-backup/$(runid)/feat/merged")" = "$A1"
need "local untouched by tier 2" local_has feat/merged
ver
need "verify rc=$RC" rc 0
need "verify OK line" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')delete-remote$(printf '\t')feat/merged"
need "p-invariant checked" has "$C/ver.out" "p-invariant$(printf '\t')deploy/hidden"
end

begin "23 ⑥ remote tip moved after report → lease rejects that row (FAIL, exit 1), the branch survives" std
rep; bare_advance feat/merged; app --tiers 2 --yes
need "exit 1" rc 1
need "FAIL rejected" resr FAIL delete-remote feat/merged "rejected"
need "branch survives" bare_has feat/merged
end
begin "24 ⑫ one push, per-ref verdicts: the other rows of the same batch are OK" std
rep; bare_advance feat/merged; app --tiers 2 --yes
need "feat/squash OK" res OK delete-remote feat/squash
need "enc OK" res OK delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글'
need "single batch" test "$(grep -c 'pr list.*--state open' "$GH_LOG")" = 1
end

begin "25 ⑦ OPEN PR on the target at apply start → SKIP protected" std
rep
jq '. + [{"number":30,"state":"OPEN","headRefName":"feat/merged","headRefOid":"'"$A1"'","baseRefName":"develop","isCrossRepository":false,"headRepositoryOwner":{"login":"test"},"headRepository":{"name":"repo"},"author":{"login":"x"},"updatedAt":"2026-10-02T00:00:00Z","title":"reopen","mergeCommit":null}]' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
app --tiers 2 --yes
need "SKIP protected" resr SKIP delete-remote feat/merged "protected"
need "branch kept" bare_has feat/merged
end
begin "26 ⑦ OPEN PR appearing at the batch boundary (after the start load) → SKIP" std
rep
jq '. + [{"number":31,"state":"OPEN","headRefName":"feat/squash","headRefOid":"'"$A2"'","baseRefName":"develop","isCrossRepository":false,"headRepositoryOwner":{"login":"test"},"headRepository":{"name":"repo"},"author":{"login":"x"},"updatedAt":"2026-10-02T00:00:00Z","title":"late","mergeCommit":null}]' "$GH_FIX/prs.json" > "$GH_FIX/swap.pr-list-open.1"
app --tiers 2 --yes
need "SKIP at batch" resr SKIP delete-remote feat/squash "open PR"
need "branch kept" bare_has feat/squash
need "others deleted" res OK delete-remote feat/merged
end

begin "27 ⑨ tier-1 delete-remote row (forged tier) → plan refused" std
rep; edit_plan 'NR > 1 && $2 == "delete-remote" && $3 == "feat/merged" { $1 = 1 } { print }'
app --tiers 1
need "dies" rc 1
need "message" has "$C/app.err" "action delete-remote not allowed in tier 1"
need "nothing deleted" bare_has feat/merged
end

begin "28 ⑩ header remote / repo_id / origin not this repo → refused" std
rep; edit_plan 'NR == 1 { sub(/\tremote=test\/repo\t/, "\tremote=test/other\t") } { gsub(/pr_head_repo=test\/repo/, "pr_head_repo=test/other"); print }'
app --tiers 2 --yes
need "remote dies" rc 1
need "remote message" has "$C/app.err" "plan is for test/other"
rep; edit_plan 'NR == 1 { sub(/\trepo_id=R_test\t/, "\trepo_id=R_other\t") } { print }'
app --tiers 2 --yes
need "repo_id dies" rc 1
need "repo_id message" has "$C/app.err" "differs from GitHub repo id"
rep; edit_plan 'NR == 1 { sub(/\torigin=[^\t]*/, "\torigin=git@github.com%3Atest/repo") } { print }'
app --tiers 2 --yes
need "origin dies" rc 1
need "origin message" has "$C/app.err" "differs from current origin"
end

begin "29 ⑰ digest of a changed plan ≠ approved digest → refused" std
rep
"$SH" "$ENGINE" apply t --plan "$C/plan.tsv" --digest 0000000000000000000000000000000000000000000000000000000000000000 --tiers 2 --yes > "$C/app.out" 2> "$C/app.err"; RC=$?
need "dies" rc 1
need "message" has "$C/app.err" "the plan changed after approval"
end

begin "30 ⑭ default branch unreadable at apply → die" std
rep; printf '{"id":"R_test","defaultBranchRef":null,"hasIssuesEnabled":true}\n' > "$GH_FIX/repo.json"
app --tiers 2 --yes
need "dies" rc 1
need "message" has "$C/app.err" "cannot detect the default branch"
end

begin "31 ⑱ PR no longer matches the snapshot (head oid changed) → SKIP basis-changed" std
rep
jq 'map(if .number == 1 then .headRefOid = "'"$A2"'" else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
app --tiers 2 --yes
need "SKIP basis-changed" resr SKIP delete-remote feat/merged "basis-changed"
need "kept" bare_has feat/merged
end

begin "32 ⑬+㉒b rerun of the same plan: backups reused, every row SKIP gone, exit 0" std
rep; app --tiers 2 --yes; app --tiers 2 --yes
need "rerun rc=$RC" rc 0
need "SKIP gone" resr SKIP delete-remote feat/merged "gone"
need "no FAIL" has "$C/app.out" "fail=0$(printf '\t')unknown=0"
end

begin "33 ㉒c backup exists with another oid / backup cannot be created → SKIP and never pushed" std
rep
git -C "$C/work" update-ref "refs/chore-backup/$(runid)/feat/squash" "$A1"
git -C "$C/work" update-ref "refs/chore-backup/$(runid)/enc" "$A1"        # file where a directory is needed
app --tiers 2 --yes
need "mismatch SKIP" resr SKIP delete-remote feat/squash "backup-mismatch"
need "failed SKIP" resr SKIP delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글' "backup-failed"
need "mismatch row not pushed" bare_has feat/squash
need "failed row not pushed" bare_has "$EB"
need "clean row deleted" bare_lacks feat/merged
end

begin "34 ⑳ porcelain line missing → ls-remote decides: absent = OK (worded as verified, not as deleted)" std
rep
GIT_DROP_PORCELAIN='refs/heads/feat/merged' GIT_WRAP_OUT="$C/wrap.out" PATH="$W/gitbin:$PATH" app --tiers 2 --yes
need "OK verified" resr OK delete-remote feat/merged "absent (verified by ls-remote)"
need "others normal" resr OK delete-remote feat/squash "deleted"
end
begin "35 ⑳ porcelain line missing + still present → FAIL; + ls-remote failing → UNKNOWN, exit 1" std
rep; bare_advance feat/merged
GIT_DROP_PORCELAIN='refs/heads/feat/merged' GIT_WRAP_OUT="$C/wrap.out" PATH="$W/gitbin:$PATH" app --tiers 2 --yes
need "FAIL present" resr FAIL delete-remote feat/merged "still present (verified by ls-remote)"
newcase std-unk; rep
GIT_DROP_PORCELAIN='refs/heads/feat/merged' GIT_FAIL_LSREMOTE=1 GIT_WRAP_OUT="$C/wrap.out" PATH="$W/gitbin:$PATH" app --tiers 2 --yes
need "UNKNOWN" res UNKNOWN delete-remote feat/merged
need "exit 1" rc 1
need "summary unknown=1" has "$C/app.out" "unknown=1"
end

begin "36 ㉓ integration ref rewound after report (merge still inside) → SKIP integration-ref-rewound" std
rep --integrate deploy/staging
need "feat/staging-a tier2" prow 2 delete-remote feat/staging-a
bare_set deploy/staging "$MX"
app --tiers 2 --yes
need "SKIP rewound" resr SKIP delete-remote feat/staging-a "integration-ref-rewound"
need "kept" bare_has feat/staging-a
need "develop rows unaffected" res OK delete-remote feat/merged
end
begin "37 merge commit in base at report, gone at apply (rewound past it) → SKIP merge-not-in-<base>" std
rep --integrate deploy/staging; bare_set deploy/staging "$D0"
app --tiers 2 --yes
need "SKIP merge-not-in" resr SKIP delete-remote feat/staging-a "merge-not-in-deploy/staging"
need "kept" bare_has feat/staging-a
end
begin "38 ㉔ integration ref fast-forwarded → delete proceeds" std
rep --integrate deploy/staging; bare_advance deploy/staging
app --tiers 2 --yes
need "OK" res OK delete-remote feat/staging-a
need "gone" bare_lacks feat/staging-a
end

begin "39 ㉕ ; in head and base round-trips through plan, JSON and apply" std
rep --integrate 'rel;base'
need "row" prow 2 delete-remote 'semi%3Bhead'
need "snapshot base encoded" has "$C/plan.tsv" "pr_base=rel%3Bbase"
need "JSON decoded" jrow 'semi;head' '.snapshot.pr_base == "rel;base"'
app --tiers 2 --yes
need "OK" res OK delete-remote 'semi%3Bhead'
need "gone" bare_lacks 'semi;head'
need "base kept" bare_has 'rel;base'
end

begin "40 ㉖ , in an integration ref round-trips through I / Itips / Ptips, apply and verify" std
rep --integrate 'int,x'
need "header I" has "$C/plan.tsv" "$(printf '\t')I=develop,int%2Cx$(printf '\t')"
need "header Ptips" has "$C/plan.tsv" "int%2Cx:"
need "JSON header" jtrue '.header.I == ["develop","int,x"] and (.header.Ptips | has("int,x"))'
app --tiers 2 --yes
need "OK" res OK delete-remote feat/comma
ver
need "verify rc=$RC" rc 0
end

begin "41 ㉗ duplicate snapshot key / ㉙ unknown key / malformed or non-canonical %XX (incl. %20, S6) → plan refused" std
rep; cp "$C/plan.tsv" "$C/plan.orig"
edit_plan 'NR > 1 && $3 == "feat/merged" && $2 == "delete-remote" { $5 = $5 ";pr=1" } { print }'
app --tiers 2 --yes
need "dup dies" rc 1
need "dup message" has "$C/app.err" "duplicate snapshot key 'pr'"      # v4: chore_plan.py check's wording (the contract)
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 2 --yes
need "awk alone: dup message" has "$C/app.err" "duplicate snapshot key pr"
cp "$C/plan.orig" "$C/plan.tsv"; edit_plan 'NR > 1 && $3 == "feat/merged" && $2 == "delete-remote" { $5 = $5 ";zzz=1" } { print }'
app --tiers 2 --yes
need "unknown dies" rc 1
need "unknown message" has "$C/app.err" "snapshot keys for delete-remote: missing [] not allowed [zzz]"
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 2 --yes
need "awk alone: unknown message" has "$C/app.err" "unknown snapshot key zzz"
cp "$C/plan.orig" "$C/plan.tsv"; edit_plan 'NR > 1 && $3 == "feat/merged" && $2 == "delete-remote" { $6 = $6 "%4" } { print }'
app --tiers 2 --yes
need "truncated % dies" has "$C/app.err" "malformed percent-escape"
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 2 --yes
need "awk alone: truncated % dies" has "$C/app.err" "malformed percent-encoding"
cp "$C/plan.orig" "$C/plan.tsv"; edit_plan 'NR > 1 && $3 == "feat/merged" && $2 == "delete-remote" { $6 = $6 "%41" } { print }'
app --tiers 2 --yes
need "non-canonical %41 dies" has "$C/app.err" "non-canonical percent-escape %41"
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 2 --yes
need "awk alone: non-canonical %41 dies" has "$C/app.err" "evidence: malformed percent-encoding"
cp "$C/plan.orig" "$C/plan.tsv"; edit_plan 'NR > 1 && $3 == "feat/merged" && $2 == "delete-remote" { $6 = $6 "%20x" } { print }'
app --tiers 2 --yes
need "S6 %20 outside the header dies (rc=$RC)" rc 1
need "S6 message" has "$C/app.err" "non-canonical percent-escape %20 (' ' is never encoded in a row value)"
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 2 --yes
need "awk alone: S6 %20 dies (rc=$RC)" rc 1
need "awk alone: S6 message" has "$C/app.err" "evidence: malformed percent-encoding"
need "nothing deleted" bare_has feat/merged
end

begin "42 ㉘ tab + newline + ; in a close comment reach gh pr close --comment= byte-exact; close-issue + verify" std
rep
printf '닫습니다.\t탭 하나\n둘째 줄; 끝\n' > "$C/comment.want"
promote_pr6 "$("$SH" "$ENGINE" penc < "$C/comment.want")"
awk -F'\t' -v OFS='\t' 'NR > 1 && $2 == "report" && $3 == "issue#20" { print 2, "close-issue", $3, $4, $5, "duplicate%3A see #21"; next } { print }' "$C/plan.tsv" > "$C/p2" && mv "$C/p2" "$C/plan.tsv"
app --tiers 2 --yes
need "close OK" res OK close-pr 'pr#6'
need "comment byte-exact" cmp -s "$C/comment.want" "$GH_FIX/comment.pr.6"
need "issue comment" test "$(cat "$GH_FIX/comment.issue.20")" = "duplicate: see #21"
need "equals form used" has "$GH_LOG" "--comment="
ver
need "verify CLOSED" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')close-pr$(printf '\t')pr#6$(printf '\t')CLOSED"
need "verify issue" has "$C/ver.out" "close-issue$(printf '\t')issue#20$(printf '\t')CLOSED"
end

begin "43 ⑪ close failure → FAIL counted, exit 1; a stale close row (updatedAt moved) → SKIP" std
rep; promote_pr6 "closing"
GH_FAIL='pr close' app --tiers 2 --yes
need "FAIL" res FAIL close-pr 'pr#6'
need "exit 1" rc 1
newcase std-stale; rep; promote_pr6 "closing"
jq 'map(if .number == 6 then .updatedAt = "2026-10-09T00:00:00Z" else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
app --tiers 2 --yes
need "SKIP changed" resr SKIP close-pr 'pr#6' "changed since approval"
need "no close call" hasnt "$GH_LOG" "pr close"
end

begin "44 ㉚ header I outside default ∪ integrate (I ⊄ P path) → refused" std
rep
edit_plan 'NR == 1 { sub(/\tI=develop\t/, "\tI=develop,main\t"); sub(/\tItips=/, "\tItips=main:'"$D0"',") } { print }'
app --tiers 2 --yes
need "dies" rc 1
need "message" has "$C/app.err" "I (develop,main) must be exactly default + integrate (develop)"   # v4: refused at parse (chore_plan.py check)
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 2 --yes
need "without the Python check the engine still refuses it" has "$C/app.err" "plan I list does not match default"
need "nothing deleted" bare_has feat/merged
end

begin "45 ㉝ --only-group: unknown group dies; feat/* deletes only that group, runs no close / local / prune (S1); final run without it does" std
rep; promote_pr6 "closing"
app --tiers 1,2 --yes --only-group nope/*
need "unknown dies" rc 1
need "message" has "$C/app.err" "is not in this plan's groups="
app --tiers 1,2 --yes --only-group 'feat/*'
need "rc=$RC" rc 0
need "feat/merged OK" res OK delete-remote feat/merged
need "enc group untouched" bare_has "$EB"
need "no local stage" local_has feat/merged
need "no prune" noresult worktree-prune
need "no close under --only-group" noresult close-pr
need "no close call" hasnt "$GH_LOG" "pr close"
app --tiers 2 --yes
need "second group same plan" res OK delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글'
need "first group now gone" resr SKIP delete-remote feat/merged gone
need "final run closes" res OK close-pr 'pr#6'
end

begin "46 apply tier1: local deletes after backup and tip check, worktree prune; remote untouched" std
rep; app --tiers 1
need "rc=$RC" rc 0
need "delete-local OK" res OK delete-local feat/merged
need "delete-local-force OK" res OK delete-local-force feat/squash
need "prune OK" res OK worktree-prune .
need "local gone" test -z "$(git -C "$C/work" for-each-ref refs/heads/feat/merged)"
need "backup kept" test "$(git -C "$C/work" rev-parse "refs/chore-backup/$(runid)/feat/squash")" = "$A2"
need "remote untouched" bare_has feat/merged
end
begin "47 apply tier1: branch checked out after the report → SKIP (never deleted)" std
rep; git -C "$C/work" worktree add -q "$C/wt" feat/merged 2>/dev/null; app --tiers 1
need "SKIP checked out" resr SKIP delete-local feat/merged "checked out"
need "kept" local_has feat/merged
end

# ---------- verify ----------
begin "48 verify: a still-protected ref vanished (P invariant) or a delete reached a protected name → FAIL, exit 1" std
rep; app --tiers 2 --yes
git --git-dir="$C/origin.git" update-ref -d refs/heads/deploy/single
ver
need "rc 1" rc 1
need "p-invariant FAIL" has "$C/ver.out" "VERIFY$(printf '\t')FAIL$(printf '\t')p-invariant$(printf '\t')deploy/single"
need "still-protected missing ref is FAIL, not WARN (S2)" hasnt "$C/ver.out" "WARN"
printf 'RESULT\tOK\tdelete-remote\tdeploy/stage\tdeleted\nSUMMARY\tok=1\tskip=0\tfail=0\tunknown=0\trun_id=%s\n' "$(runid)" > "$C/forged.out"
ver "$C/forged.out"
need "p-touched FAIL" has "$C/ver.out" "VERIFY$(printf '\t')FAIL$(printf '\t')p-touched$(printf '\t')deploy/stage"
end

begin "49 S2 verify: a Ptips name that left P (its OPEN PR merged, head auto-deleted) is WARN, not FAIL" std
rep; app --tiers 2 --yes
jq 'map(if .number == 6 then .state = "MERGED" else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
git --git-dir="$C/origin.git" update-ref -d refs/heads/feat/child
ver
need "verify rc=$RC" rc 0
need "WARN line" has "$C/ver.out" "VERIFY$(printf '\t')WARN$(printf '\t')p-invariant$(printf '\t')feat/child$(printf '\t')no longer protected"
need "not FAIL" hasnt "$C/ver.out" "FAIL$(printf '\t')p-invariant"
need "summary counts warn" has "$C/ver.out" "VERIFY-SUMMARY$(printf '\t')fail=0$(printf '\t')warn=1"
end

begin "50 S5 verify: --digest must match the plan; results run_id must equal the plan run_id; no SUMMARY = refused" std
rep; app --tiers 2 --yes
ver "$C/app.out" --digest "$(dg "$C/plan.tsv")"
need "matching digest ok (rc=$RC)" rc 0
ver "$C/app.out" --digest 0000000000000000000000000000000000000000000000000000000000000000
need "digest mismatch dies" rc 1
need "digest message" has "$C/ver.err" "the plan changed after approval"
sed "s/run_id=$(runid)/run_id=20990101T000000Z-deadbeef/" "$C/app.out" > "$C/other.out"
ver "$C/other.out"
need "run_id mismatch dies" rc 1
need "run_id message" has "$C/ver.err" "results belong to run"
grep -v '^SUMMARY' "$C/app.out" > "$C/nosum.out"
ver "$C/nosum.out"
need "no SUMMARY dies" rc 1
need "no SUMMARY message" has "$C/ver.err" "no SUMMARY or ABORTED line — not an apply output"
end

begin "51 header values: spaces are %20-encoded and round-trip; a raw space or a NUL byte in the plan is refused" std
rep --protect 'team a/*'
need "encoded in header" has "$C/plan.tsv" "$(printf '\t')protect=team%20a/*$(printf '\t')"
need "decoded in JSON" jtrue '.header.protect == ["team a/*"]'
app --tiers 1
need "plan with %20 accepted (rc=$RC)" rc 0
rep; edit_plan 'NR == 1 { sub(/\tdefault=develop\t/, "\tdefault=dev elop\t") } { print }'
app --tiers 1
need "raw space refused" has "$C/app.err" "line 1 default: unencoded ' ' (must be percent-encoded)"   # v4: chore_plan.py check's wording
CHORE_PLAN_PY="$W/bin/plan-ok.py" app --tiers 1
need "awk alone: raw space refused" has "$C/app.err" "header default: malformed percent-encoding"
rep; printf 'x\000y\n' >> "$C/plan.tsv"; app --tiers 1
need "NUL refused" has "$C/app.err" "plan contains NUL bytes"
end

begin "52 codec: penc/pdec round-trip, malformed input refused" std
v=$(printf 'a;b,c=d:e%%f\tg' | "$SH" "$ENGINE" penc)
need "penc" test "$v" = 'a%3Bb%2Cc%3Dd%3Ae%25f%09g'
need "pdec" test "$(printf '%s' "$v" | "$SH" "$ENGINE" pdec)" = "$(printf 'a;b,c=d:e%%f\tg')"
need "malformed refused" sh -c "printf 'x%%4' | '$SH' '$ENGINE' pdec; test \$? -ne 0"
need "S6 %20 refused by pdec" sh -c "printf 'a%%20b' | '$SH' '$ENGINE' pdec; test \$? -ne 0"
need "raw space kept" test "$(printf 'a b' | "$SH" "$ENGINE" penc)" = "a b"
end

# ---------- review round 2026-10-15 (gpt-6-astra + fable): M1–M5, S4 ----------
begin "53 M1 apply pins the approved bytes: the plan file rewritten mid-run never reaches gh (posted comment = approved text)" std
rep
printf 'approved text\n' > "$C/comment.want"
promote_pr6 "$("$SH" "$ENGINE" penc < "$C/comment.want")"
sed 's/approved text%0A/TAMPERED/' "$C/plan.tsv" > "$C/plan.tampered"
need "tampered copy differs" sh -c "! cmp -s '$C/plan.tsv' '$C/plan.tampered'"
printf 'cp "%s" "%s"\n' "$C/plan.tampered" "$C/plan.tsv" > "$GH_FIX/hook.pr-view.1"
app --tiers 2 --yes
need "close OK" res OK close-pr 'pr#6'
need "posted = approved bytes" cmp -s "$C/comment.want" "$GH_FIX/comment.pr.6"
need "the file really was rewritten during the run" has "$C/plan.tsv" TAMPERED
end

begin "54 M2 backup refs use the decoded branch name (; % kept raw): created, reused on rerun, other oid → SKIP backup-mismatch and not pushed" std
rep; appw --tiers 2 --yes
need "rc=$RC" rc 0
need "raw-name backup = expected" test "$(git -C "$C/work" rev-parse "refs/chore-backup/$(runid)/$EB")" = "$A13"
need "no encoded-name backup" test -z "$(git -C "$C/work" for-each-ref "refs/chore-backup/$(runid)/enc/a%25b%3Bc%2Cd%3De-한글")"
appw --tiers 2 --yes
need "rerun rc=$RC" rc 0
need "rerun reuses the backup" hasnt "$C/app.out" "backup-"
need "rerun SKIP gone" resr SKIP delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글' gone
newcase std-m2; rep
git -C "$C/work" update-ref "refs/chore-backup/$(runid)/$EB" "$A1"
appw --tiers 2 --yes
need "mismatch SKIP" resr SKIP delete-remote 'enc/a%25b%3Bc%2Cd%3De-한글' backup-mismatch
need "mismatch row not in push args" hasnt "$C/push.log" "$EB"
need "other rows pushed" has "$C/push.log" ":refs/heads/feat/merged"
need "mismatch row survives" bare_has "$EB"
end

begin "55 M3 apply re-checks same-as-integration-tip against the CURRENT I tips (remote and local rows)" std
rep --integrate main
need "remote candidate" prow 2 delete-remote feat/merged
need "local candidate" prow 1 delete-local feat/merged
bare_set main "$A1"
app --tiers 1,2 --yes
need "remote SKIP" resr SKIP delete-remote feat/merged "same-as-integration-tip (main)"
need "local SKIP" resr SKIP delete-local feat/merged "same-as-integration-tip (main)"
need "remote survives" bare_has feat/merged
need "local survives" local_has feat/merged
need "other rows proceed" res OK delete-remote feat/squash
end

begin "56 M4a/b multi-batch (CHORE_BATCH=2, 3 rows → 2 batches): OPEN PR list re-read once per batch, every row OK" std
rep; CHORE_BATCH=2 appw --tiers 2 --yes
need "rc=$RC" rc 0
need "3 OK" has "$C/app.out" "SUMMARY$(printf '\t')ok=3$(printf '\t')skip=0"
need "2 open-PR reloads" test "$(grep -c 'pr list.*--state open' "$GH_LOG")" = 2
need "2 pushes" test "$(grep -c '^PUSH' "$C/push.log")" = 2
need "all gone" sh -c "! git --git-dir='$C/origin.git' show-ref -q --verify refs/heads/feat/squash"
end

begin "57 M4c OPEN PR for a second-batch row appearing at the batch-2 reload → SKIP, never in the second push, survives" std
rep
jq '. + [{"number":32,"state":"OPEN","headRefName":"feat/squash","headRefOid":"'"$A2"'","baseRefName":"develop","isCrossRepository":false,"headRepositoryOwner":{"login":"test"},"headRepository":{"name":"repo"},"author":{"login":"x"},"updatedAt":"2026-10-02T00:00:00Z","title":"late","mergeCommit":null}]' "$GH_FIX/prs.json" > "$GH_FIX/swap.pr-list-open.2"
CHORE_BATCH=2 appw --tiers 2 --yes
need "SKIP open PR" resr SKIP delete-remote feat/squash "open PR"
need "never pushed" hasnt "$C/push.log" "refs/heads/feat/squash"
need "survives" bare_has feat/squash
need "first batch OK" res OK delete-remote feat/merged
end

begin "58 M4d integration ref rewound between batches → second-batch rows of that base SKIP integration-ref-rewound" std
rep
printf 'git --git-dir="%s" update-ref refs/heads/develop "%s"\n' "$C/origin.git" "$M4" > "$GH_FIX/hook.pr-list-open.1"
CHORE_BATCH=2 appw --tiers 2 --yes
need "first batch OK" res OK delete-remote feat/merged
need "second batch SKIP rewound" resr SKIP delete-remote feat/squash "integration-ref-rewound (develop)"
need "survives" bare_has feat/squash
need "one push only" test "$(grep -c '^PUSH' "$C/push.log")" = 1
end

begin "59 M5 PR-head guard: a forged row for another branch with feat/merged's valid snapshot → SKIP basis-changed; header protect= edit → SKIP protected (--protect)" std
rep
awk -F'\t' -v OFS='\t' '{ print } NR > 1 && $2 == "delete-remote" && $3 == "feat/merged" { $3 = "junk/x"; print }' "$C/plan.tsv" > "$C/p2" && mv "$C/p2" "$C/plan.tsv"
app --tiers 2 --yes
need "forged row SKIP basis-changed" resr SKIP delete-remote junk/x "basis-changed"
need "junk/x survives" bare_has junk/x
newcase std-m5; rep; edit_plan 'NR == 1 { sub(/\tprotect=\t/, "\tprotect=feat/*\t") } { print }'
app --tiers 2 --yes
need "protect edit SKIP protected" resr SKIP delete-remote feat/merged "protected ("
need "reason names --protect" resr SKIP delete-remote feat/merged "--protect"
need "feat/merged survives" bare_has feat/merged
end

begin "60 S4 a required control file missing mid-run (I.bad removed at the batch reload) → apply stops before any push" std
rep
printf 'rm -f "$CHT/I.bad"\n' > "$GH_FIX/hook.pr-list-open.1"
appw --tiers 2 --yes
need "non-zero exit" test "$RC" -ne 0
need "message" has "$C/app.err" "cannot read control file"
need "nothing pushed" test ! -s "$C/push.log"
need "rows survive" bare_has feat/merged
end

# ---------- review round R2 2026-10-15 (gpt-6-astra): approval page = final TSV, verify --digest, ABORTED ----------
begin "61 MF1 approval page renders the FINAL TSV (close row promoted, one delete row removed): page digest = that TSV's sha256, apply only with it" std
rep
CMT='PR 6은 PR 40에서 이어서 진행하므로 닫습니다 — 남은 작업 없음'
promote_pr6 "$(printf '%s' "$CMT" | "$SH" "$ENGINE" penc)"
edit_plan 'NR > 1 && $2 == "delete-remote" && $3 == "feat/squash" { next } { print }'
need "python3 present (required, not skipped)" command -v python3
python3 -I "$SKILL/scripts/chore-render.py" --plan "$C/plan.tsv" --json "$C/plan.json" --out "$C/plan.html" 2> "$C/render.err"; RC=$?
need "render rc=$RC $(head -c 200 "$C/render.err")" rc 0
PD=$(sed -n 's/.*<dd class="fp" id="fp">\([0-9a-f]*\)<\/dd>.*/\1/p' "$C/plan.html" | head -1)
need "page digest = sha256 of the final TSV" test "$PD" = "$(dg "$C/plan.tsv")"
need "page shows the promoted comment verbatim" has "$C/plan.html" "<div class=\"comment\">$CMT</div>"
sed -n '/<h2 id="s-del">/,/<\/section>/p' "$C/plan.html" > "$C/del.html"
need "delete section rendered" has "$C/del.html" "feat/merged"
need "removed ref absent from the delete section" hasnt "$C/del.html" "feat/squash"
"$SH" "$ENGINE" apply t --plan "$C/plan.tsv" --digest "$PD" --tiers 2 --yes > "$C/app.out" 2> "$C/app.err"; RC=$?
need "apply with the page digest rc=$RC" rc 0
need "close ran" res OK close-pr 'pr#6'
need "removed row never acted on" bare_has feat/squash
need "posted = page text" test "$(cat "$GH_FIX/comment.pr.6")" = "$CMT"
end

begin "62 MF2 verify requires the recorded --digest; a plan whose P / Ptips were edited (same run_id) is refused with the original digest" std
rep; app --tiers 2 --yes
"$SH" "$ENGINE" verify t --plan "$C/plan.tsv" --results "$C/app.out" > "$C/ver.out" 2> "$C/ver.err"; RC=$?
need "no --digest refused" rc 1
need "message" has "$C/ver.err" "verify needs --digest"
edit_plan 'NR == 1 { sub(/\tPtips=[^\t]*/, "\tPtips="); sub(/\tP=[^\t]*/, "\tP=develop") } { print }'
need "run_id unchanged" test -n "$(runid)"
ver
need "edited plan refused (rc=$RC)" rc 1
need "edited message" has "$C/ver.err" "the plan changed after approval"
end

begin "63 N1 a batch-boundary failure (OPEN PR list fails at batch 2) → NOT-ATTEMPTED rows + ABORTED line, exit 1; verify checks batch 1 OK rows and says incomplete" std
rep; : > "$GH_FIX/fail.pr-list-open.2"
CHORE_BATCH=2 appw --tiers 2 --yes
need "exit 1" rc 1
need "batch 1 deleted" res OK delete-remote feat/merged
need "batch 2 row NOT-ATTEMPTED" resr NOT-ATTEMPTED delete-remote feat/squash "run aborted at remote-batch-2"
need "ABORTED line" has "$C/app.out" "ABORTED$(printf '\t')run_id=$(runid)$(printf '\t')at=remote-batch-2$(printf '\t')ok=2$(printf '\t')skip=0$(printf '\t')fail=0$(printf '\t')unknown=0$(printf '\t')unattempted=1"
need "no SUMMARY" hasnt "$C/app.out" "SUMMARY"
need "batch 2 survives" bare_has feat/squash
need "one push" test "$(grep -c '^PUSH' "$C/push.log")" = 1
rm -f "$GH_FIX/fail.pr-list-open.2"
ver
need "verify non-zero (rc=$RC)" test "$RC" -ne 0
need "verify checked batch 1" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')delete-remote$(printf '\t')feat/merged"
need "verify says incomplete" has "$C/ver.out" "VERIFY$(printf '\t')INCOMPLETE$(printf '\t')run"
need "summary incomplete" has "$C/ver.out" "run=incomplete"
need "no false FAIL" hasnt "$C/ver.out" "VERIFY$(printf '\t')FAIL"
end

begin "64 N2 batch-boundary same-as-integration-tip: I fast-forwarded to a second-batch tip between batches → SKIP, survives, not pushed" std
rep --integrate main
printf 'git --git-dir="%s" update-ref refs/heads/main "%s"\n' "$C/origin.git" "$A2" > "$GH_FIX/hook.pr-list-open.1"
CHORE_BATCH=2 appw --tiers 2 --yes
need "rc=$RC" rc 0
need "batch 1 OK" res OK delete-remote feat/merged
need "batch 2 SKIP" resr SKIP delete-remote feat/squash "same-as-integration-tip (main)"
need "survives" bare_has feat/squash
need "not in push args" hasnt "$C/push.log" "refs/heads/feat/squash"
end

begin "65 Fa an ABORTED run + the same command again, results concatenated → verify checks run 1's OK rows and passes (exit 0)" std
rep; : > "$GH_FIX/fail.pr-list-open.2"
CHORE_BATCH=2 appw --tiers 2 --yes; cp "$C/app.out" "$C/run1.out"
need "run 1 aborted" has "$C/run1.out" "ABORTED"
rm -f "$GH_FIX/fail.pr-list-open.2"
CHORE_BATCH=2 appw --tiers 2 --yes; cp "$C/app.out" "$C/run2.out"
need "run 2 rc=$RC" rc 0
need "run 2: run-1 rows are SKIP gone" resr SKIP delete-remote feat/merged gone
need "run 2 finished the rest" res OK delete-remote feat/squash
cat "$C/run1.out" "$C/run2.out" > "$C/both.out"
ver "$C/both.out"
need "verify rc=$RC" rc 0
need "run-1 OK row verified" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')delete-remote$(printf '\t')feat/merged$(printf '\t')absent on origin"
need "run-2 OK row verified" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')delete-remote$(printf '\t')feat/squash"
need "complete" has "$C/ver.out" "run=complete"
end

begin "66 Fb a second-batch branch deleted by someone else mid-run → SKIP gone (not a lease FAIL), exit 0" std
rep
printf 'git --git-dir="%s" update-ref -d refs/heads/feat/squash\n' "$C/origin.git" > "$GH_FIX/hook.pr-list-open.1"
CHORE_BATCH=2 appw --tiers 2 --yes
need "rc=$RC" rc 0
need "SKIP gone" resr SKIP delete-remote feat/squash gone
need "no FAIL" has "$C/app.out" "fail=0$(printf '\t')unknown=0"
need "not pushed" hasnt "$C/push.log" "refs/heads/feat/squash"
end

begin "67 Fd verify: an integration ref vanished → one VERIFY FAIL p-invariant (integration ref missing) + VERIFY-SUMMARY, exit 1, no die" std
rep --integrate main; app --tiers 2 --yes
git --git-dir="$C/origin.git" update-ref -d refs/heads/main
ver
need "rc 1" rc 1
need "FAIL line" has "$C/ver.out" "VERIFY$(printf '\t')FAIL$(printf '\t')p-invariant$(printf '\t')main$(printf '\t')integration ref missing on origin"
need "summary printed" has "$C/ver.out" "VERIFY-SUMMARY$(printf '\t')fail=1"
need "no die message" hasnt "$C/ver.err" "does not exist on origin"
end

begin "68 Ff a tab in an environment name never shifts a column: label shown with ?, SKIP reason stays one field" std
printf '{"total_count":1,"environments":[{"name":"prod\\tenv","deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}]}\n' > "$GH_FIX/environments.json"
printf '{"branch_policies":[{"name":"feat/squash","type":"branch"}]}\n' > "$GH_FIX/env-prod%09env.json"
rep
need "report rc=$RC" rc 0
need "label without the tab" jrow remote:feat/squash '.reason == "protected" and (.protected_by | contains("environment#prod?env"))'
rep
awk -F'\t' -v OFS='\t' -v a="$A2" -v m="$S2" 'NR > 1 && $2 == "report" && $3 == "remote:feat/squash" { print 2, "delete-remote", "feat/squash", a, "basis=a;pr=2;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=" a ";pr_merge_commit=" m ";pr_author=x;tip_author=x;tip_date=2026-01-01", "x"; next } { print }' "$C/plan.tsv" > "$C/p2" && mv "$C/p2" "$C/plan.tsv"
app --tiers 2 --yes
need "SKIP protected" resr SKIP delete-remote feat/squash "environment#prod?env"
need "every RESULT line has 5 fields" sh -c "awk -F'\t' '\$1 == \"RESULT\" && NF != 5 { bad = 1 } END { exit bad }' '$C/app.out'"
need "survives" bare_has feat/squash
end

begin "69 Fg an empty close comment is refused at parse (no gh call with an empty comment); a close row beside its kept row is refused" std
rep; promote_pr6 ""
app --tiers 2 --yes
need "empty comment dies" rc 1
need "message" has "$C/app.err" "close-pr evidence (the comment to post) is empty"
need "no close call" hasnt "$GH_LOG" "pr close"
rep
awk -F'\t' -v OFS='\t' '{ print } NR > 1 && $3 == "pr#6" { print 2, "close-pr", $3, $4, $5, "closing" }' "$C/plan.tsv" > "$C/p2" && mv "$C/p2" "$C/plan.tsv"
app --tiers 2 --yes
need "two states dies" rc 1
need "two states message" has "$C/app.err" "is also listed as kept"
need "still no close call" hasnt "$GH_LOG" "pr close"
end

# ---------- review round R3 2026-10-15 (gpt-6-astra MUST 1–2 + fable): sent rows, last-result verify ----------
begin "70 R3 push succeeded but its output was lost (push.out removed) → sent rows are UNKNOWN, never NOT-ATTEMPTED; verify reconciles them (absent) → success" std
rep
GIT_PUSH_RM_OUT=1 appw --tiers 2 --yes
need "exit 1" rc 1
need "remote really deleted" bare_lacks feat/merged
need "UNKNOWN sent" resr UNKNOWN delete-remote feat/merged "sent at remote-batch-1, outcome unread"
need "reason is exactly the sent fact (no network call in the stop report)" sh -c "awk -F'\t' '\$1 == \"RESULT\" && \$2 == \"UNKNOWN\" && \$4 == \"feat/merged\" && \$5 == \"sent at remote-batch-1, outcome unread\" { f = 1 } END { exit f ? 0 : 1 }' '$C/app.out'"
need "no ls-remote call after the push (wrapper call log)" no_lsremote_after_push
need "nothing NOT-ATTEMPTED" hasnt "$C/app.out" "NOT-ATTEMPTED"
need "ABORTED counts unknown" has "$C/app.out" "unknown=3$(printf '\t')unattempted=0"
need "exactly one ABORTED line" test "$(nabort)" = 1
for r in 'enc/a%25b%3Bc%2Cd%3De-한글' feat/merged feat/squash; do need "exactly one RESULT for $r" test "$(nres "$r")" = 1; done
ver
need "verify rc=$RC" rc 0
need "reconciled" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')delete-remote$(printf '\t')feat/merged$(printf '\t')reconciled: absent at verify (was UNKNOWN)"
need "run incomplete but success" has "$C/ver.out" "unresolved=0$(printf '\t')run=incomplete$(printf '\t')success=yes"
cp "$C/app.out" "$C/run1.out"; appw --tiers 2 --yes; cp "$C/app.out" "$C/run2.out"
need "rerun SKIP gone" resr SKIP delete-remote feat/merged gone
cat "$C/run1.out" "$C/run2.out" > "$C/both.out"; ver "$C/both.out"
need "concat verify rc=$RC" rc 0
need "UNKNOWN then SKIP gone keeps the deletion fact" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')delete-remote$(printf '\t')feat/merged$(printf '\t')absent on origin (was UNKNOWN, rerun SKIP gone)"
need "concat success" has "$C/ver.out" "unresolved=0$(printf '\t')run=complete$(printf '\t')success=yes"
end

# Assumption these signal cases rely on: bash, waiting for a foreground child when a trapped signal arrives,
# runs the trap only after that child exits — so the push has finished and its rows are already in sent.keys.
# Each variant starts the engine with that signal at its default (sigdfl), whatever way this suite was started.
begin "71 R3 the engine gets TERM / INT / HUP right after a real push → sent rows UNKNOWN (one line each), one ABORTED, verify success" std
for sig in TERM INT HUP; do
  newcase "std-$sig"; rep
  APP_WRAP=("$W/bin/sigdfl" "$sig")
  GIT_PUSH_KILL=$sig appw --tiers 2 --yes
  unset APP_WRAP
  need "$sig exit 1 (rc=$RC)" rc 1
  need "$sig remote really deleted" bare_lacks feat/squash
  need "$sig UNKNOWN sent" resr UNKNOWN delete-remote feat/squash "outcome unread"
  need "$sig nothing NOT-ATTEMPTED" hasnt "$C/app.out" "NOT-ATTEMPTED"
  need "$sig ABORTED reason" has "$C/app.out" "unknown=3$(printf '\t')unattempted=0$(printf '\t')reason=terminated by signal"
  need "$sig exactly one ABORTED line" test "$(nabort)" = 1
  need "$sig no ls-remote call after the push (wrapper call log)" no_lsremote_after_push
  for r in 'enc/a%25b%3Bc%2Cd%3De-한글' feat/merged feat/squash; do need "$sig exactly one RESULT for $r" test "$(nres "$r")" = 1; done
  ver
  need "$sig verify rc=$RC" rc 0
  need "$sig success" has "$C/ver.out" "success=yes"
done
end

begin "72 R4 signal during the first batch's push (CHORE_BATCH=2): batch 1 UNKNOWN, batch 2 NOT-ATTEMPTED, one line each, one ABORTED" std
rep
CHORE_BATCH=2 GIT_PUSH_KILL=TERM appw --tiers 2 --yes
need "exit 1" rc 1
need "batch 1 UNKNOWN" resr UNKNOWN delete-remote feat/merged "sent at remote-batch-1, outcome unread"
need "batch 2 NOT-ATTEMPTED" resr NOT-ATTEMPTED delete-remote feat/squash "run aborted at remote-batch-1"
for r in 'enc/a%25b%3Bc%2Cd%3De-한글' feat/merged feat/squash; do need "exactly one RESULT for $r" test "$(nres "$r")" = 1; done
need "exactly one ABORTED line" test "$(nabort)" = 1
need "ABORTED counts" has "$C/app.out" "unknown=2$(printf '\t')unattempted=1"
need "no ls-remote call after the push (wrapper call log)" no_lsremote_after_push
need "batch 2 never pushed" bare_has feat/squash
need "one push" test "$(grep -c '^PUSH' "$C/push.log")" = 1
end

begin "73 R3 (i) a lease FAIL in the results → verify unresolved=1, run=complete, success=no, exit 1; a rerun whose SKIP has a reason resolves it" std
rep; bare_advance feat/merged; app --tiers 2 --yes
need "apply exit 1" rc 1
cp "$C/app.out" "$C/run1.out"
ver "$C/run1.out"
need "verify rc 1" rc 1
need "UNRESOLVED line" has "$C/ver.out" "VERIFY$(printf '\t')UNRESOLVED$(printf '\t')delete-remote$(printf '\t')feat/merged$(printf '\t')last result FAIL"
need "remote fact" has "$C/ver.out" "; still on origin"
need "summary" has "$C/ver.out" "fail=0$(printf '\t')warn=0$(printf '\t')unresolved=1$(printf '\t')run=complete$(printf '\t')success=no"
NEW=$(git --git-dir="$C/origin.git" rev-parse refs/heads/feat/merged)
jq --arg o "$NEW" 'map(if .number == 1 then .headRefOid = $o else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
app --tiers 2 --yes; cp "$C/app.out" "$C/run2.out"
need "rerun SKIP basis-changed" resr SKIP delete-remote feat/merged "basis-changed"
cat "$C/run1.out" "$C/run2.out" > "$C/both.out"
ver "$C/both.out"
need "concat verify rc=$RC" rc 0
need "RESOLVED keeps the SKIP reason" has "$C/ver.out" "VERIFY$(printf '\t')RESOLVED$(printf '\t')delete-remote$(printf '\t')feat/merged$(printf '\t')earlier FAIL, last run SKIP: basis-changed"
need "success" has "$C/ver.out" "unresolved=0$(printf '\t')run=complete$(printf '\t')success=yes"
end

begin "74 R3 (ii) ABORTED run, rerun ends in a FAIL, results concatenated → unresolved>0, exit 1" std
rep; : > "$GH_FIX/fail.pr-list-open.2"
CHORE_BATCH=2 appw --tiers 2 --yes; cp "$C/app.out" "$C/run1.out"
need "run 1 aborted" has "$C/run1.out" "ABORTED"
rm -f "$GH_FIX/fail.pr-list-open.2"; bare_advance feat/squash
CHORE_BATCH=2 appw --tiers 2 --yes; cp "$C/app.out" "$C/run2.out"
need "rerun FAIL" resr FAIL delete-remote feat/squash rejected
cat "$C/run1.out" "$C/run2.out" > "$C/both.out"
ver "$C/both.out"
need "verify rc 1" rc 1
need "unresolved counted" has "$C/ver.out" "unresolved=1$(printf '\t')run=complete$(printf '\t')success=no"
need "run 1 rows still verified" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')delete-remote$(printf '\t')feat/merged$(printf '\t')absent on origin"
end

# ---------- grok-4.7 post-review 2026-10-16: atomic local delete, OPEN recount, close head, close reconcile, refnames ----------
begin "75 grok-1 a local tip moving between the tip check and the delete → SKIP, the branch keeps the new commit (update-ref compare-and-delete)" std
rep
NEWT=$(git -C "$C/work" commit-tree "$(git -C "$C/work" rev-parse "$A2^{tree}")" -p "$A2" -m concurrent)
GIT_MOVE_BRANCH=feat/squash GIT_MOVE_TO="$NEWT" appw --tiers 1
need "SKIP, not deleted" resr SKIP delete-local-force feat/squash "moved"
need "branch kept with the new commit" test "$(git -C "$C/work" rev-parse refs/heads/feat/squash)" = "$NEWT"
need "the other row deleted" res OK delete-local feat/merged
need "its branch config removed like git branch -d did" test -z "$(git -C "$C/work" config --get branch.feat/merged.merge)"
need "backup still taken first" test "$(git -C "$C/work" rev-parse "refs/chore-backup/$(runid)/feat/squash")" = "$A2"
end

begin "76 grok-1 delete-local keeps git branch -d's merge rule: tip not merged into its upstream → SKIP, branch kept" std
rep
git -C "$C/work" branch -q --set-upstream-to=origin/junk/x feat/merged        # junk/x does not contain A1
app --tiers 1
need "SKIP not merged" resr SKIP delete-local feat/merged "not merged into refs/remotes/origin/junk/x"
need "kept" local_has feat/merged
need "parity: real git branch -d refuses the same branch" sh -c "! git -C '$C/work' branch -d feat/merged"
need "force row unaffected" res OK delete-local-force feat/squash
end

begin "77 grok-2 batch-boundary OPEN PR list shorter than GitHub's OPEN count → die before any push (ABORTED, branches kept)" std
rep; echo 99 > "$GH_FIX/pr-open-total"
appw --tiers 2 --yes
need "exit 1" rc 1
need "message" has "$C/app.err" "OPEN PR list returned"
need "nothing pushed" test ! -s "$C/push.log"
need "receipt" test "$(nabort)" = 1
need "kept" bare_has feat/merged
end

begin "78 grok-3 close re-check covers head ref and head repo (state / oid / updatedAt / base unchanged) → SKIP, no close call" std
rep; promote_pr6 "closing"
jq 'map(if .number == 6 then .headRefName = "feat/other" else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
app --tiers 2 --yes
need "head ref change SKIP" resr SKIP close-pr 'pr#6' "changed since approval"
need "no close call" hasnt "$GH_LOG" "pr close"
newcase std-g3; rep; promote_pr6 "closing"
jq 'map(if .number == 6 then .headRepositoryOwner.login = "someone" | .isCrossRepository = true else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
app --tiers 2 --yes
need "head repo change SKIP" resr SKIP close-pr 'pr#6' "changed since approval"
need "no close call (repo)" hasnt "$GH_LOG" "pr close"
end

begin "79 grok-4 verify reconciles an UNKNOWN close only when CLOSED with the approved comment posted after the report" std
rep
CMT='승인된 닫기 코멘트 — 두 번째 문장'
promote_pr6 "$(printf '%s' "$CMT" | "$SH" "$ENGINE" penc)"
printf 'RESULT\tUNKNOWN\tclose-pr\tpr#6\tsent at close, outcome unread\nABORTED\trun_id=%s\tat=close\tok=0\tskip=0\tfail=0\tunknown=1\tunattempted=0\treason=terminated by signal\n' "$(runid)" > "$C/r.out"
jq 'map(if .number == 6 then .state = "CLOSED" else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
ver "$C/r.out"
need "closed by someone else (no comment) → rc 1" rc 1
need "UNRESOLVED" has "$C/ver.out" "VERIFY$(printf '\t')UNRESOLVED$(printf '\t')close-pr$(printf '\t')pr#6"
jq --arg c "a different comment" 'map(if .number == 6 then .comments = [{body: $c, createdAt: "2099-01-01T00:00:00Z"}] else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
ver "$C/r.out"
need "other comment → still rc 1" rc 1
jq --arg c "$CMT" 'map(if .number == 6 then .comments = [{body: $c, createdAt: "2000-01-01T00:00:00Z"}] else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
ver "$C/r.out"
need "approved text but before the report → rc 1" rc 1
jq --arg c "$CMT" 'map(if .number == 6 then .comments = [{body: "x", createdAt: "2000-01-01T00:00:00Z"}, {body: $c, createdAt: "2099-01-01T00:00:00Z"}] else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
ver "$C/r.out"
need "approved comment after the report → rc 0 ($RC)" rc 0
need "reconciled with the comment" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')close-pr$(printf '\t')pr#6$(printf '\t')reconciled: CLOSED with the approved comment at verify (was UNKNOWN)"
end

begin "80 grok-5 refnames follow git check-ref-format --branch: .hidden component, exactly @, HEAD, .lock component, trailing .lock are refused" std
rep; cp "$C/plan.tsv" "$C/plan.orig"
for bad in 'feat/.hidden' '@' 'HEAD' 'foo.lock/bar' 'x/y.lock' '.lead'; do
  cp "$C/plan.orig" "$C/plan.tsv"
  CH_BAD="$bad" awk -F'\t' -v OFS='\t' '{ print } NR > 1 && $2 == "delete-remote" && $3 == "feat/merged" { $3 = ENVIRON["CH_BAD"]; print }' "$C/plan.orig" > "$C/plan.tsv"
  app --tiers 2 --yes
  need "'$bad' refused (rc=$RC)" rc 1
  need "'$bad' message" has "$C/app.err" "invalid branch name in ref"
done
need "nothing deleted" bare_has feat/merged
end

# ---------- gpt-6-astra review of the grok round, 2026-10-16: symref, created, rebase/bisect, group keys, config ----------
begin "81 rv1 an approved local branch that is a symbolic ref (to another branch at the same oid) → SKIP, both refs kept" std
rep
git -C "$C/work" update-ref refs/heads/feat/mtarget "$A1"
git -C "$C/work" symbolic-ref refs/heads/feat/merged refs/heads/feat/mtarget
app --tiers 1
need "SKIP symbolic" resr SKIP delete-local feat/merged "symbolic ref"
need "symref kept" test "$(git -C "$C/work" symbolic-ref -q refs/heads/feat/merged)" = refs/heads/feat/mtarget
need "target kept" test "$(git -C "$C/work" rev-parse -q --verify refs/heads/feat/mtarget)" = "$A1"
need "the plain row still deleted" res OK delete-local-force feat/squash
end

begin "82 rv2 header created must be a canonical UTC timestamp — empty or malformed → apply and verify refuse" std
rep; cp "$C/plan.tsv" "$C/plan.orig"
printf 'SUMMARY\tok=0\tskip=0\tfail=0\tunknown=0\trun_id=%s\n' "$(runid)" > "$C/r.out"
for v in '' 'yesterday' '2026-10-16'; do
  cp "$C/plan.orig" "$C/plan.tsv"
  CH_V="$v" awk -F'\t' -v OFS='\t' 'NR == 1 { for (i = 2; i <= NF; i++) if ($i ~ /^created=/) $i = "created=" ENVIRON["CH_V"] } { print }' "$C/plan.orig" > "$C/plan.tsv"
  app --tiers 1
  need "apply refuses created='$v' (rc=$RC)" rc 1
  need "apply message for '$v'" has "$C/app.err" "header created must be a UTC timestamp"
  ver "$C/r.out"
  need "verify refuses created='$v' (rc=$RC)" rc 1
  need "verify message for '$v'" has "$C/ver.err" "header created must be a UTC timestamp"
done
need "nothing deleted" local_has feat/merged
end

begin "83 rv3 a branch stopped mid-rebase in another worktree (detached) → SKIP in use, same verdict as git branch -d" std
rep
git -C "$C/work" worktree add -q "$C/wt" feat/merged 2>/dev/null
git -C "$C/wt" checkout -q --detach "$D0"; printf 'y\n' > "$C/wt/a1"; git -C "$C/wt" add a1; git -C "$C/wt" commit -q -m X
RX=$(git -C "$C/wt" rev-parse HEAD); git -C "$C/wt" checkout -q feat/merged
GIT_EDITOR=true git -C "$C/wt" rebase "$RX" >/dev/null 2>&1
need "fixture: rebase stopped" test -f "$(git -C "$C/wt" rev-parse --git-dir)/rebase-merge/head-name"
app --tiers 1
need "SKIP in use" resr SKIP delete-local feat/merged "in use by a rebase/bisect in $C/wt"
need "kept" local_has feat/merged
need "parity: git branch -d refuses too" sh -c "! git -C '$C/work' branch -d feat/merged"
rep
need "report holds it as well" jrow local:feat/merged '.tier == 3 and .reason == "checked-out" and (.evidence | startswith("in use by a rebase/bisect"))'
end

begin "84 rv3 a branch under bisect in another worktree (detached) → SKIP in use, same verdict as git branch -d" std
rep
git -C "$C/work" worktree add -q "$C/wt" feat/merged 2>/dev/null
git -C "$C/wt" bisect start >/dev/null 2>&1; git -C "$C/wt" checkout -q --detach
need "fixture: bisect started" test "$(cat "$(git -C "$C/wt" rev-parse --git-dir)/BISECT_START")" = feat/merged
app --tiers 1
need "SKIP in use" resr SKIP delete-local feat/merged "in use by a rebase/bisect in $C/wt"
need "kept" local_has feat/merged
need "parity: git branch -d refuses too" sh -c "! git -C '$C/work' branch -d feat/merged"
end

begin "85 rv4 group keys depend on the action: branches named pr#topic/a, pull-requests, issue#topic/a, issues get their own groups" std
for b in 'pr#topic/a' pull-requests 'issue#topic/a' issues; do bare_set "$b" "$A1"; done
jq --arg o "$A1" --arg m "$M1" '. + [range(0; 4) as $i | ["pr#topic/a", "pull-requests", "issue#topic/a", "issues"][$i] as $h
  | {number: (90 + $i), state: "MERGED", headRefName: $h, headRefOid: $o, baseRefName: "develop", isCrossRepository: false,
     headRepositoryOwner: {login: "test"}, headRepository: {name: "repo"}, author: {login: "dev9"}, updatedAt: "2026-10-01T00:00:00Z",
     title: ("PR " + $h), mergeCommit: {oid: $m}}]' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
rep
need "report rc=$RC" rc 0
need "groups lists pr#topic/* apart from pull-requests" jtrue '(.header.groups | index("pr#topic/*") != null) and (.header.groups | index("pull-requests") != null)'
need "groups lists issue#topic/* apart from issues" jtrue '(.header.groups | index("issue#topic/*") != null) and (.header.groups | index("issues") != null)'
need "row group pr#topic/a" jrow 'pr#topic/a' '.action == "delete-remote" and .group == "pr#topic/*"'
need "row group pull-requests branch" jrow 'pull-requests' '.action == "delete-remote" and .group == "pull-requests"'
app --tiers 2 --yes --only-group pull-requests
need "only-group pull-requests rc=$RC" rc 0
need "deletes the pull-requests branch" res OK delete-remote pull-requests
need "keeps pr#topic/a" bare_has 'pr#topic/a'
need "pr#topic/a not even selected" noresult 'pr#topic/a'
app --tiers 2 --yes --only-group issues
need "deletes the issues branch" res OK delete-remote issues
need "keeps issue#topic/a" bare_has 'issue#topic/a'
need "issue#topic/a not selected" noresult 'issue#topic/a'
app --tiers 2 --yes --only-group 'pr#topic/*'
need "its own group deletes it" res OK delete-remote 'pr#topic/a'
end

begin "86 rv5 config section removal: a missing section is silent; a failed write is noted in an OK result" std
rep
git -C "$C/work" config --remove-section branch.feat/squash
app --tiers 1
need "missing section: reason is exactly deleted" sh -c "awk -F'\t' '\$1 == \"RESULT\" && \$4 == \"feat/squash\" && \$2 == \"OK\" && \$5 == \"deleted\" { f = 1 } END { exit f ? 0 : 1 }' '$C/app.out'"
need "present section removed: reason is exactly deleted" sh -c "awk -F'\t' '\$1 == \"RESULT\" && \$4 == \"feat/merged\" && \$2 == \"OK\" && \$5 == \"deleted\" { f = 1 } END { exit f ? 0 : 1 }' '$C/app.out'"
need "section gone" test -z "$(git -C "$C/work" config --get branch.feat/merged.merge)"
newcase std-cfglock; rep
: > "$C/work/.git/config.lock"                      # another writer holds the config lock
app --tiers 1
need "apply rc=$RC" rc 0
need "OK with the note" resr OK delete-local feat/merged "deleted; branch.feat/merged config not removed:"
need "branch really deleted" sh -c "! git -C '$C/work' show-ref -q --verify refs/heads/feat/merged"
end

# ---------- round-2 review nice-to-haves, 2026-10-16: calendar iso(), in-use gitdir enumeration boundaries ----------
begin "87 iso() accepts only real UTC calendar times: month 00, Feb 30, 2025-02-29, hour 24, second 60 refused; 2024-02-29 and 2000-02-29 accepted" std
rep; cp "$C/plan.tsv" "$C/plan.orig"
setcreated() { CH_V="$1" awk -F'\t' -v OFS='\t' 'NR == 1 { for (i = 2; i <= NF; i++) if ($i ~ /^created=/) $i = "created=" ENVIRON["CH_V"] } { print }' "$C/plan.orig" > "$C/plan.tsv"; }
for v in 2026-00-10T00:00:00Z 2026-02-30T00:00:00Z 2025-02-29T00:00:00Z 2026-10-16T24:00:00Z 2026-10-16T00:00:60Z 2026-13-01T00:00:00Z 2026-04-31T00:00:00Z 1900-02-29T00:00:00Z 2100-02-29T00:00:00Z; do
  setcreated "$(printf '%s' "$v" | sed 's/:/%3A/g')"
  app --tiers 1
  need "refuses $v (rc=$RC)" rc 1
  need "message for $v" has "$C/app.err" "header created must be a UTC timestamp"
done
need "nothing deleted by the refused runs" local_has feat/merged
k=0
for v in 2024-02-29T00:00:00Z 2000-02-29T00:00:00Z; do
  k=$((k+1)); newcase "std-iso-ok$k"; rep; cp "$C/plan.tsv" "$C/plan.orig"
  setcreated "$(printf '%s' "$v" | sed 's/:/%3A/g')"
  app --tiers 1
  need "accepts $v (rc=$RC)" rc 0
  need "accepted run acts ($v)" res OK delete-local feat/merged
done
end

stop_rebase() { # <worktree dir> <branch>: that worktree rebases <branch> onto a commit that conflicts on a1, and stops
  local d="$1" b="$2" x
  git -C "$d" checkout -q --detach "$D0"; printf 'y\n' > "$d/a1"; git -C "$d" add a1; git -C "$d" commit -q -m X
  x=$(git -C "$d" rev-parse HEAD); git -C "$d" checkout -q "$b"
  GIT_EDITOR=true git -C "$d" rebase ${3:-} "$x" >/dev/null 2>&1
}
begin "88 in-use boundary (a): the MAIN worktree is stopped mid-rebase of the branch → SKIP in use, same verdict as git branch -d" std
rep
stop_rebase "$C/work" feat/merged
need "fixture: main worktree rebase-merge" test -f "$C/work/.git/rebase-merge/head-name"
app --tiers 1
need "SKIP in use (main)" resr SKIP delete-local feat/merged "in use by a rebase/bisect in $C/work"
need "kept" local_has feat/merged
need "parity: git branch -d refuses too" sh -c "! git -C '$C/work' branch -d feat/merged"
end

begin "89 in-use boundary (b): engine registered on a LINKED worktree, the main worktree rebasing the branch → SKIP, same verdict as git branch -d" std
git -C "$C/work" worktree add -q -b lwb "$C/lw" develop 2>/dev/null
printf '| repo | local path | remote | note |\n|---|---|---|---|\n| `t` | `%s` | `test/repo` | test |\n' "$C/lw" > "$CHORE_REPOS_MD"
rep
need "report from the linked worktree rc=$RC" rc 0
need "candidate planned from the linked worktree" prow 1 delete-local feat/merged
stop_rebase "$C/work" feat/merged
app --tiers 1
need "SKIP in use (seen from the linked worktree)" resr SKIP delete-local feat/merged "in use by a rebase/bisect in $C/work"
need "kept" local_has feat/merged
need "parity: git branch -d from the linked worktree refuses too" sh -c "! git -C '$C/lw' branch -d feat/merged"
end

begin "90 in-use boundary (c): rebase-apply backend (git rebase --apply stopped on a conflict) in a linked worktree → SKIP, same verdict as git branch -d" std
rep
git -C "$C/work" worktree add -q "$C/wa" feat/merged 2>/dev/null
stop_rebase "$C/wa" feat/merged --apply
need "fixture: rebase-apply/head-name" test -f "$(git -C "$C/wa" rev-parse --git-dir)/rebase-apply/head-name"
app --tiers 1
need "SKIP in use (rebase-apply)" resr SKIP delete-local feat/merged "in use by a rebase/bisect in $C/wa"
need "kept" local_has feat/merged
need "parity: git branch -d refuses too" sh -c "! git -C '$C/work' branch -d feat/merged"
end

# ---------- chore v4 2026-10-19: Jira rows — plan check, the Jira stage (helper stub), abort, verify ----------
FIXV4="$SKILL/__tests__/fixtures/chore-v4"
# Jira helper stub (CHORE_JIRA). apply-rows: logs CMD / PPID / every ARG to $JSTUB_LOG, appends jira-start and jira-exit
# to $GIT_EVENT_LOG, appends $JSTUB_JOURNAL lines (+ $JSTUB_JTAIL without a newline) to --journal, $JSTUB_JMODE = dir
# (journal path becomes a directory) | a chmod mode, prints $JSTUB_OUT lines (+ $JSTUB_OUTTAIL without a newline), one
# stderr line $JSTUB_ERR, runs $JSTUB_HOOK (sh; state changing while the Jira stage runs); $JSTUB_SLEEP = touch
# $JSTUB_READY and wait for TERM (then log term, wait 1 s, log whether $JSTUB_APPOUT already has ABORTED, exit 8); else
# exit $JSTUB_RC. verify-rows: prints $JSTUB_VOUT, stderr $JSTUB_VERR, exit $JSTUB_VRC. @A@ = the --attempt it was given.
printf '#!%s\n' "$SH" > "$W/bin/jstub"
cat >> "$W/bin/jstub" <<'JSTUB'
set -u
cmd="$1"; shift
{ printf 'CMD %s\nPPID %s\n' "$cmd" "$PPID"; for a in "$@"; do printf 'ARG %s\n' "$a"; done; } >> "$JSTUB_LOG"
att=""; jn=""
while [ $# -gt 0 ]; do case "$1" in --attempt) att="$2"; shift 2 ;; --journal) jn="$2"; shift 2 ;; *) shift ;; esac; done
if [ "$cmd" = verify-rows ]; then
  if [ -n "${JSTUB_VOUT:-}" ]; then cat "$JSTUB_VOUT"; fi
  if [ -n "${JSTUB_VERR:-}" ]; then printf '%s\n' "$JSTUB_VERR" >&2; fi
  exit "${JSTUB_VRC:-0}"
fi
echo jira-start >> "$GIT_EVENT_LOG"
if [ -n "${JSTUB_JOURNAL:-}" ]; then sed "s/@A@/$att/g" "$JSTUB_JOURNAL" >> "$jn"; fi
if [ -n "${JSTUB_JTAIL:-}" ]; then t="${JSTUB_JTAIL//@A@/$att}"; printf '%s' "$t" >> "$jn"; fi
case "${JSTUB_JMODE:-}" in "") ;; dir) rm -f "$jn"; mkdir -p "$jn" ;; *) chmod "$JSTUB_JMODE" "$jn" ;; esac
if [ -n "${JSTUB_OUT:-}" ]; then sed "s/@A@/$att/g" "$JSTUB_OUT"; fi
if [ -n "${JSTUB_OUTTAIL:-}" ]; then t="${JSTUB_OUTTAIL//@A@/$att}"; printf '%s' "$t"; fi
if [ -n "${JSTUB_ERR:-}" ]; then printf '%s\n' "$JSTUB_ERR" >&2; fi
if [ -n "${JSTUB_HOOK:-}" ]; then sh -c "$JSTUB_HOOK"; fi
if [ -n "${JSTUB_SLEEP:-}" ]; then
  sp=""
  trap 'echo term >> "$JSTUB_LOG"; if [ -n "$sp" ]; then kill "$sp" 2>/dev/null; fi; sleep 1
        if grep -q "^ABORTED" "$JSTUB_APPOUT" 2>/dev/null; then echo aborted-before-exit >> "$JSTUB_LOG"; else echo exit-before-aborted >> "$JSTUB_LOG"; fi
        echo jira-exit >> "$GIT_EVENT_LOG"; exit 8' TERM
  sleep "$JSTUB_SLEEP" & sp=$!
  : > "$JSTUB_READY"
  wait "$sp"
  echo sleep-ended-without-term >> "$JSTUB_LOG"
fi
echo jira-exit >> "$GIT_EVENT_LOG"
exit "${JSTUB_RC:-0}"
JSTUB
chmod +x "$W/bin/jstub"
# awk wrapper (PATH only where a case needs it): on the $AWK_KILL_AT-th check of a Jira helper line (the engine's
# P_JLINE call, the only one with CH_L set) it signals like a TERM to the whole process group — TERM to the engine
# (the stub's PPID in $JSTUB_LOG) and to itself — so the check dies mid-taking; AWK_KILL_SIG=KILL: only the check
# itself dies (SIGKILL), the engine gets no signal. AWK_FAIL_COMMENT_READ: the read of a row's approved comment (the one
# awk call with CH_A and CH_R set) exits 2
mkdir -p "$W/awkbin"; printf '#!%s\nREAL=%s\n' "$SH" "$(command -v awk)" > "$W/awkbin/awk"
cat >> "$W/awkbin/awk" <<'AWKW'
if [ -n "${AWK_FAIL_COMMENT_READ:-}" ] && [ -n "${CH_A:-}" ] && [ -n "${CH_R:-}" ]; then echo "awk-wrapper: forced failure" >&2; exit 2; fi
if [ -n "${CH_L:-}" ] && [ -n "${AWK_KILL_AT:-}" ]; then
  k=0; if [ -f "$AWK_KILL_CNT" ]; then k=$(cat "$AWK_KILL_CNT"); fi; k=$((k+1)); echo "$k" > "$AWK_KILL_CNT"
  if [ "$k" = "$AWK_KILL_AT" ] && [ "${AWK_KILL_SIG:-}" = KILL ]; then kill -KILL $$; fi
  if [ "$k" = "$AWK_KILL_AT" ]; then
    kill -TERM "$(sed -n 's/^PPID //p' "$JSTUB_LOG" | head -1)"; kill -TERM $$
  fi
fi
exec "$REAL" "$@"
AWKW
chmod +x "$W/awkbin/awk"

add_jira() { # [3]: append valid.tsv's Jira rows (transitions TST-101 / TST-102, kept TST-103 / TST-104, inventory jira#TST);
  # 3 = also a third transition TST-105 (TST-101's row under another key and issue id; the inventory total follows)
  awk -F'\t' -v OFS='\t' -v three="${1:-}" 'NR > 1 && $3 ~ /^jira#/ {
      if ($3 == "jira#TST" && three != "") sub(/total%3D4%3B/, "total%3D5%3B", $6)
      print
      if ($3 == "jira#TST-101" && three != "") { $3 = "jira#TST-105"; sub(/issue_id=10101;/, "issue_id=10105;", $5); print } }' "$FIXV4/valid.tsv" >> "$C/plan.tsv"; }
jstub() { export CHORE_JIRA="$W/bin/jstub" JSTUB_LOG="$C/jstub.log"; }
# apply in the background (its pid = $AP, the engine's $$); with JSTUB_SLEEP set: TERM it once the stub is waiting
appbg() { local d i=0; d=$(dg "$C/plan.tsv"); printf '%s\n' "$d" > "$C/approved.sha"
  PATH="$W/gitbin:$PATH" "$SH" "$ENGINE" apply t --plan "$C/plan.tsv" --digest "$d" "$@" > "$C/app.out" 2> "$C/app.err" &
  AP=$!
  if [ -n "${JSTUB_SLEEP:-}" ]; then
    while [ ! -f "$JSTUB_READY" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i+1)); done
    kill -TERM "$AP"
  fi
  wait "$AP"; RC=$?; }
sumf() { awk -F'\t' -v k="$1" '$1 == "SUMMARY" || $1 == "ABORTED" { for (i = 2; i <= NF; i++) if (index($i, k "=") == 1) print substr($i, length(k) + 2) }' "$C/app.out"; }
argv() { awk 'substr($0, 1, 4) == "ARG " { print substr($0, 5) }' "$C/jstub.log"; }
argval() { argv | awk -v f="$1" 'p { print; exit } $0 == f { p = 1 }'; }
gcd() { git -C "$C/work" rev-parse --path-format=absolute --git-common-dir; }
jline() { printf 'RESULT\t%s\tjira-transition\t%s\t%s\tattempt=%s\n' "$1" "$2" "$3" "$4"; }   # status ref reason attempt
hasx() { grep -qxF -- "$2" "$1"; }                       # an exact whole line
evpos() { awk -v e="$1" '$0 == e { print NR; exit }' "$C/git-events.log"; }
cols_ok() { awk -F'\t' '$1 == "RESULT" && NF != (($3 == "jira-transition" || $3 == "move-issue") ? 6 : 5) { bad = 1 } END { exit bad }' "$C/app.out"; }

begin "91 v4 full run with Jira rows: close → jira → remote; the helper is a direct child (ppid = --parent-pid = engine pid) with the whole argv; its lines pass byte-for-byte; counters; SUMMARY attempt / scope / journal" std
rep; promote_pr6 "closing"; add_jira; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: QA (staging)로 옮김 — 100%% ; =,: 끝\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 승인 뒤 바뀜\tattempt=@A@\n' > "$C/jout"
JSTUB_OUT="$C/jout" JSTUB_ERR="일지 끝을 정리함" appbg --tiers 2 --yes
need "rc=$RC $(head -c 300 "$C/app.err")" rc 0
A=$(sumf attempt)
need "SUMMARY attempt= well-formed ($A)" sh -c "printf '%s' '$A' | grep -Eqx '[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}'"
need "SUMMARY scope=full" test "$(sumf scope)" = full
need "SUMMARY journal = <git-common-dir>/chore/<run_id>.journal" test "$(sumf journal)" = "$(gcd)/chore/$(runid).journal"
need "SUMMARY fields after the v3 ones" has "$C/app.out" "SUMMARY$(printf '\t')ok=5$(printf '\t')skip=1$(printf '\t')fail=0$(printf '\t')unknown=0$(printf '\t')run_id=$(runid)$(printf '\t')attempt=$A$(printf '\t')scope=full$(printf '\t')journal="
need "chore dir created" test -d "$(gcd)/chore"
need "helper called once with apply-rows" test "$(grep -c '^CMD ' "$C/jstub.log")" = 1
need "CMD apply-rows" hasx "$C/jstub.log" "CMD apply-rows"
need "helper ppid = engine pid" hasx "$C/jstub.log" "PPID $AP"
need "--parent-pid = engine pid" test "$(argval --parent-pid)" = "$AP"
need "--attempt = SUMMARY attempt" test "$(argval --attempt)" = "$A"
need "--journal" test "$(argval --journal)" = "$(gcd)/chore/$(runid).journal"
need "--lock" test "$(argval --lock)" = "$(gcd)/chore/$(runid).lock"
need "--plan = the private pinned copy" sh -c "case '$(argval --plan)' in */plan.snap) exit 0 ;; *) exit 1 ;; esac"
need "--repos-md" test "$(argval --repos-md)" = "$CHORE_REPOS_MD"
need "--remote" test "$(argval --remote)" = test/repo
need "--clone" test "$(argval --clone)" = "$C/work"
need "--judge default = scripts/chore-judge.py" test "$(argval --judge)" = "$SKILL/scripts/chore-judge.py"
need "argv = exactly these flags in this order" test "$(argv | awk 'substr($0, 1, 2) == "--"' | tr '\n' ' ')" = "--plan --attempt --journal --lock --parent-pid --repos-md --remote --clone --judge "
sed "s/@A@/$A/g" "$C/jout" > "$C/jout.want"
need "line 1 byte-for-byte" hasx "$C/app.out" "$(sed -n 1p "$C/jout.want")"
need "line 2 byte-for-byte" hasx "$C/app.out" "$(sed -n 2p "$C/jout.want")"
need "one RESULT per Jira row" test "$(nres jira#TST-101)$(nres jira#TST-102)" = 11
need "kept Jira rows never acted on" test "$(nres jira#TST-103)$(nres jira#TST-104)$(nres jira#TST)" = 000
need "order: close before jira" test "$(evpos gh-close)" -lt "$(evpos jira-start)"
need "order: jira finished before the first push" test "$(evpos jira-exit)" -lt "$(evpos push)"
need "remote stage ran" bare_lacks feat/merged
need "helper stderr forwarded" has "$C/app.err" "chore: jira: 일지 끝을 정리함"
need "RESULT columns: 6 for Jira, 5 for the rest" cols_ok
end

begin "92 v4 --only-group run with Jira rows: helper never started, no Jira RESULT at all (not NOT-ATTEMPTED), SUMMARY scope=only-group" std
rep; add_jira; jstub
app --tiers 2 --yes --only-group 'feat/*'
need "rc=$RC" rc 0
need "helper never started" test ! -e "$C/jstub.log"
need "no Jira RESULT" noresult jira-transition
need "nothing NOT-ATTEMPTED" hasnt "$C/app.out" NOT-ATTEMPTED
need "scope=only-group" test "$(sumf scope)" = only-group
need "attempt= present" test -n "$(sumf attempt)"
need "its group deleted" res OK delete-remote feat/merged
end

begin "93 v4 --only-group jira dies before acting (Jira rows only in a full run)" std
rep; add_jira; jstub
app --tiers 2 --yes --only-group jira
need "rc=$RC" rc 1
need "message" has "$C/app.err" "Jira 행은 --only-group 없이 전체 실행에서만 처리됩니다"
need "helper never started" test ! -e "$C/jstub.log"
need "no receipt" hasnt "$C/app.out" RESULT
need "nothing deleted" bare_has feat/merged
end

begin "94 v4 helper exit 7 (plan or project lock held) → die with its message, remote stage not run; ABORTED: Jira rows and the rest NOT-ATTEMPTED, attempt= on both" std
rep; promote_pr6 "closing"; add_jira; jstub
JSTUB_RC=7 appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "message" has "$C/app.err" "다른 apply가 이 계획이나 같은 Jira 프로젝트를 쓰는 중 — 끝난 뒤 같은 명령으로 다시 실행"
need "close ran first" res OK close-pr 'pr#6'
need "no push" test ! -s "$C/push.log"
need "branches kept" bare_has feat/merged
need "TST-101 NOT-ATTEMPTED with attempt" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-101 "run aborted at jira" "$A")"
need "TST-102 NOT-ATTEMPTED with attempt" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-102 "run aborted at jira" "$A")"
need "delete rows NOT-ATTEMPTED" resr NOT-ATTEMPTED delete-remote feat/merged "run aborted at jira"
need "ABORTED with the new fields" has "$C/app.out" "ABORTED$(printf '\t')run_id=$(runid)$(printf '\t')at=jira$(printf '\t')ok=1$(printf '\t')skip=0$(printf '\t')fail=0$(printf '\t')unknown=0$(printf '\t')unattempted=5$(printf '\t')reason=다른 apply가 이 계획이나 같은 Jira 프로젝트를 쓰는 중 — 끝난 뒤 같은 명령으로 다시 실행$(printf '\t')attempt=$A$(printf '\t')scope=full$(printf '\t')journal=$(gcd)/chore/$(runid).journal"
need "exactly one ABORTED" test "$(nabort)" = 1
need "no SUMMARY" hasnt "$C/app.out" SUMMARY
need "RESULT columns" cols_ok
end

begin "95 v4 helper exit 6 after one RESULT: that row keeps it; a journal line of this attempt → UNKNOWN; another attempt's line only, or a torn line of this attempt → NOT-ATTEMPTED" std
rep; add_jira 3; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\n' > "$C/jout"
printf '2026-10-19T00:00:01.000Z @A@ jira#TST-102 comment-sent\n2026-10-19T00:00:02.000Z 20261019T000000Z-00000000 jira#TST-105 comment-sent\n' > "$C/jrn"
JSTUB_OUT="$C/jout" JSTUB_JOURNAL="$C/jrn" JSTUB_JTAIL="2026-10-19T00:00:03.000Z @A@ jira#TST-105 comment-se" JSTUB_RC=6 appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "message" has "$C/app.err" "Jira 읽기 실패 — 잠시 뒤 같은 명령으로 다시 실행"
need "TST-101 keeps its RESULT (one line)" test "$(nres jira#TST-101)" = 1
need "TST-101 is the helper's line" hasx "$C/app.out" "$(jline OK jira#TST-101 "moved: 옮김" "$A")"
need "TST-102 UNKNOWN" hasx "$C/app.out" "$(jline UNKNOWN jira#TST-102 "journal has a write of this attempt, outcome unread (run aborted at jira)" "$A")"
need "TST-105 NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-105 "run aborted at jira" "$A")"
need "ABORTED counts" has "$C/app.out" "ok=1$(printf '\t')skip=0$(printf '\t')fail=0$(printf '\t')unknown=1$(printf '\t')unattempted=4$(printf '\t')"
need "RESULT columns" cols_ok
end

begin "96 v4 TERM while the helper runs: the helper gets TERM and is waited for (its exit before ABORTED); B keeps its RESULT, A (journaled) UNKNOWN, C NOT-ATTEMPTED; no tab inside a reason" std
rep; add_jira 3; jstub
printf 'RESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 승인 뒤 바뀜\tattempt=@A@\n' > "$C/jout"
printf '2026-10-19T00:00:01.000Z @A@ jira#TST-101 comment-sent\n' > "$C/jrn"
JSTUB_OUT="$C/jout" JSTUB_JOURNAL="$C/jrn" JSTUB_SLEEP=30 JSTUB_READY="$C/ready" JSTUB_APPOUT="$C/app.out" appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "the helper got TERM" hasx "$C/jstub.log" term
need "engine waited: helper exit before ABORTED" hasx "$C/jstub.log" exit-before-aborted
need "helper did not run out its sleep" hasnt "$C/jstub.log" sleep-ended-without-term
need "B keeps its RESULT (one line)" test "$(nres jira#TST-102)" = 1
need "B = the helper's line" hasx "$C/app.out" "$(jline SKIP jira#TST-102 "changed: 승인 뒤 바뀜" "$A")"
need "A UNKNOWN" hasx "$C/app.out" "$(jline UNKNOWN jira#TST-101 "journal has a write of this attempt, outcome unread (run aborted at jira)" "$A")"
need "C NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-105 "run aborted at jira" "$A")"
need "ABORTED at jira by the signal, with attempt" has "$C/app.out" "at=jira$(printf '\t')ok=0$(printf '\t')skip=1$(printf '\t')fail=0$(printf '\t')unknown=1$(printf '\t')unattempted=4$(printf '\t')reason=terminated by signal$(printf '\t')attempt=$A$(printf '\t')scope=full"
need "exactly one ABORTED" test "$(nabort)" = 1
need "no tab inside any reason" cols_ok
need "remote stage never ran" bare_has feat/merged
end

begin "97 v4 journal unreadable at abort (chmod 000 when not root; a directory always) → every undecided Jira row UNKNOWN" std
for mode in dir 000; do
  if [ "$mode" = 000 ] && [ "$(id -u)" = 0 ]; then continue; fi     # root reads a mode-000 file
  newcase "std-jr-$mode"; rep; add_jira; jstub
  printf '2026-10-19T00:00:01.000Z 20261019T000000Z-00000000 jira#TST-102 comment-sent\n' > "$C/jrn"
  JSTUB_JOURNAL="$C/jrn" JSTUB_JMODE="$mode" JSTUB_RC=6 appbg --tiers 2 --yes
  A=$(sumf attempt)
  need "$mode rc=$RC" rc 1
  need "$mode TST-101 UNKNOWN" hasx "$C/app.out" "$(jline UNKNOWN jira#TST-101 "journal unreadable at abort (run aborted at jira)" "$A")"
  need "$mode TST-102 UNKNOWN" hasx "$C/app.out" "$(jline UNKNOWN jira#TST-102 "journal unreadable at abort (run aborted at jira)" "$A")"
  need "$mode ABORTED counts" has "$C/app.out" "unknown=2$(printf '\t')unattempted=3$(printf '\t')"
  if [ "$mode" = 000 ]; then chmod 600 "$(gcd)/chore/$(runid).journal"; fi
done
end

begin "98 v4 a helper line that is not a RESULT of this run → die (never printed); taken lines before it stay; the row settles from the journal" std
rep; add_jira; jstub; cp "$C/plan.tsv" "$C/plan.orig"
k=0
while IFS='|' read -r what line tail; do
  k=$((k+1)); printf '%b' "$line" > "$C/jout"
  JSTUB_OUT="$C/jout" JSTUB_OUTTAIL="$(printf '%b' "$tail")" appbg --tiers 2 --yes
  need "[$what] rc=$RC" rc 1
  if [ -n "$tail" ]; then need "[$what] message" has "$C/app.err" "Jira 단계 출력의 마지막 줄이 끊김"
  else need "[$what] message" has "$C/app.err" "Jira 단계 출력 형식 오류"; fi
  need "[$what] ABORTED" test "$(nabort)" = 1
  need "[$what] nothing pushed" bare_has feat/merged
  need "[$what] RESULT columns" cols_ok
  need "[$what] TST-102 NOT-ATTEMPTED" resr NOT-ATTEMPTED jira-transition jira#TST-102 "run aborted at jira"
  need "[$what] TST-101 has exactly one RESULT" test "$(nres jira#TST-101)" = 1
  case "$what" in
    dup|"cut line") need "[$what] the good first line was taken" has "$C/app.out" "moved: x$(printf '\t')attempt=" ;;
    *) need "[$what] the bad line is not printed" sh -c "! grep -E 'moved: x|moved:x|done: x|$(printf '\t')x$(printf '\t')|$(printf '\t\t')|TST-103' '$C/app.out' | grep -q '^RESULT'"
       need "[$what] TST-101 settled by the engine" resr NOT-ATTEMPTED jira-transition jira#TST-101 "run aborted at jira" ;;
  esac
done <<'BAD'
5 columns|RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: x\n|
other attempt|RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: x\tattempt=20261019T000000Z-00000000\n|
kept row|RESULT\tOK\tjira-transition\tjira#TST-103\tmoved: x\tattempt=@A@\n|
unknown class|RESULT\tOK\tjira-transition\tjira#TST-101\tdone: x\tattempt=@A@\n|
class without its space|RESULT\tOK\tjira-transition\tjira#TST-101\tmoved:x\tattempt=@A@\n|
UNKNOWN with a class|RESULT\tUNKNOWN\tjira-transition\tjira#TST-101\tmoved: x\tattempt=@A@\n|
empty reason|RESULT\tOK\tjira-transition\tjira#TST-101\t\tattempt=@A@\n|
NOT-ATTEMPTED|RESULT\tNOT-ATTEMPTED\tjira-transition\tjira#TST-101\tx\tattempt=@A@\n|
dup|RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: x\tattempt=@A@\nRESULT\tOK\tjira-transition\tjira#TST-101\tmoved: x\tattempt=@A@\n|
cut line|RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: x\tattempt=@A@\n|RESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: x
BAD
end

begin "99 v4 verify: verify-rows lines join the totals (FAIL / WARN / UNRESOLVED; OK / RESOLVED / NOT-SCHEDULED none); exit 1 dies with its line; Jira rows never go through the last-result loop" std
rep; add_jira; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\nRESULT\tUNKNOWN\tjira-transition\tjira#TST-102\t보냈지만 결과 모름\tattempt=@A@\n' > "$C/jout"
JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
need "apply rc=$RC (UNKNOWN → 1)" rc 1
: > "$C/jstub.log"
while IFS='|' read -r what v1 v2 want; do
  printf 'VERIFY\t%s\tjira-transition\tjira#TST-101\t첫 줄 — %s\nVERIFY\t%s\tjira-transition\tjira#TST-102\t둘째 줄\n' "$v1" "$what" "$v2" > "$C/vout"
  JSTUB_VOUT="$C/vout" ver
  want=$(printf '%s' "$want" | tr ' ' '\t')
  need "[$what] summary $want (rc=$RC)" has "$C/ver.out" "VERIFY-SUMMARY$(printf '\t')$want"
  case "$want" in *success=yes) need "[$what] rc 0" rc 0 ;; *) need "[$what] rc 1" rc 1 ;; esac
  need "[$what] line 1 verbatim" hasx "$C/ver.out" "$(sed -n 1p "$C/vout")"
  need "[$what] line 2 verbatim" hasx "$C/ver.out" "$(sed -n 2p "$C/vout")"
  need "[$what] no generic verdict for a Jira row" test "$(grep -c "$(printf '\t')jira-transition$(printf '\t')" "$C/ver.out")" = 2
done <<'VER'
ok+resolved|OK|RESOLVED|fail=0 warn=0 unresolved=0 run=complete success=yes
warn|OK|WARN|fail=0 warn=1 unresolved=0 run=complete success=yes
not-scheduled|NOT-SCHEDULED|NOT-SCHEDULED|fail=0 warn=0 unresolved=0 run=complete success=yes
unresolved|UNRESOLVED|OK|fail=0 warn=0 unresolved=1 run=complete success=no
fail|FAIL|RESOLVED|fail=1 warn=0 unresolved=0 run=complete success=no
VER
need "verify-rows called per verify" test "$(grep -c '^CMD verify-rows' "$C/jstub.log")" = 5
need "verify argv flags" test "$(argv | awk 'substr($0, 1, 2) == "--"' | sort -u | tr '\n' ' ')" = "--journal --plan --remote --repos-md --results "
need "verify --journal" test "$(argval --journal)" = "$(gcd)/chore/$(runid).journal"
need "verify --results" test "$(argval --results)" = "$C/app.out"
need "verify --remote" test "$(argval --remote)" = test/repo
JSTUB_VERR="결과/일지 형식 오류: line 3" JSTUB_VRC=1 ver
need "exit 1 dies (rc=$RC)" rc 1
need "with its line" has "$C/ver.err" "chore: 결과/일지 형식 오류: line 3"
need "no VERIFY-SUMMARY after the die" hasnt "$C/ver.out" VERIFY-SUMMARY
printf 'VERIFY\tOK\tjira-transition\tjira#TST-101\tx\n' > "$C/vout"
JSTUB_VOUT="$C/vout" ver
need "a missing Jira row dies (rc=$RC)" rc 1
need "missing-row message" has "$C/ver.err" "Jira 확인 출력 형식 오류: 1 of 2 Jira rows answered"
printf 'VERIFY\tOK\tjira-transition\tjira#TST-101\tx\nVERIFY\tMAYBE\tjira-transition\tjira#TST-102\tx\n' > "$C/vout"
JSTUB_VOUT="$C/vout" ver
need "an unknown verdict dies (rc=$RC)" rc 1
need "unknown-verdict message" has "$C/ver.err" "Jira 확인 출력 형식 오류: line 2"
newcase std-v4-nojira; rep; jstub; app --tiers 2 --yes; ver
need "plan without Jira rows: verify rc=$RC" rc 0
need "plan without Jira rows: helper never started" test ! -e "$C/jstub.log"
end

begin "100 v4 check-plan: every contract fixture accepted / refused exactly like chore_plan.py (one stderr line = its message); awk alone accepts the valid ones; apply refuses a bad Jira row before acting" std
for f in "$FIXV4"/valid*.tsv; do
  "$SH" "$ENGINE" check-plan --plan "$f" > "$C/cp.out" 2> "$C/cp.err"; RC=$?
  need "$(basename "$f") accepted (rc=$RC $(head -c 200 "$C/cp.err"))" rc 0
  need "$(basename "$f") silent" test ! -s "$C/cp.err" -a ! -s "$C/cp.out"
  CHORE_PLAN_PY="$W/bin/plan-ok.py" "$SH" "$ENGINE" check-plan --plan "$f" > /dev/null 2> "$C/cp.err"; RC=$?
  need "$(basename "$f") awk alone accepts it (rc=$RC $(head -c 200 "$C/cp.err"))" rc 0
done
for f in "$FIXV4"/invalid/*.tsv; do
  b=$(basename "$f"); want=$(jq -r --arg k "$b" '.[$k] // empty' "$FIXV4/expected.json")
  "$SH" "$ENGINE" check-plan --plan "$f" > /dev/null 2> "$C/cp.err"; RC=$?
  need "$b refused (rc=$RC)" rc 1
  need "$b one stderr line" test "$(wc -l < "$C/cp.err" | tr -d ' ')" = 1
  need "$b = chore_plan.py's message" sh -c "grep -q '^chore: plan rejected: line ' '$C/cp.err' && grep -qF -- \"\$1\" '$C/cp.err'" _ "$want"
done
CHORE_PLAN_PY="$W/bin/plan-ok.py" "$SH" "$ENGINE" check-plan --plan "$FIXV4/invalid/jt-tier3.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "awk runs too: tier-3 jira-transition refused by awk alone (rc=$RC)" rc 1
need "awk message" has "$C/cp.err" "action jira-transition not allowed in tier 3"
CHORE_PLAN_PY="$W/bin/plan-no.py" "$SH" "$ENGINE" check-plan --plan "$FIXV4/valid.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "exit 1 → plan rejected: <message without its prefix>" test "$RC:$(cat "$C/cp.err")" = "1:chore: plan rejected: forced by the test"
CHORE_PLAN_PY="$W/bin/plan-usage.py" "$SH" "$ENGINE" check-plan --plan "$FIXV4/valid.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "other exit → plan check failed, one line (rc=$RC)" test "$RC:$(wc -l < "$C/cp.err" | tr -d ' ')" = "1:1"
need "plan check failed message" has "$C/cp.err" "chore: plan check failed"
"$SH" "$ENGINE" check-plan > /dev/null 2> "$C/cp.err"; RC=$?
need "no --plan → rc 1" rc 1
rep; promote_pr6 "closing"; add_jira; jstub
edit_plan '$3 == "jira#TST-101" { sub(/site=example.atlassian.net/, "site=bad_host", $5) } { print }'
app --tiers 2 --yes
need "apply refuses a bad Jira row (rc=$RC)" rc 1
need "with chore_plan.py's message" has "$C/app.err" "chore: plan rejected: line"
need "site message" has "$C/app.err" "snapshot site must be a host name"
need "nothing closed" hasnt "$GH_LOG" "pr close"
need "helper never started" test ! -e "$C/jstub.log"
end

begin "101 v4 optional last snapshot keys: close-pr title= is closed as usual, tier-3 issue#N verdict= with structured evidence parses; title on a delete row is still refused" std
rep; promote_pr6 "closing"
edit_plan 'NR > 1 && $2 == "close-pr" && $3 == "pr#6" { $5 = $5 ";title=PR 6 제목%3A 검색%2C 정렬" } { print }'
UEV=$(awk -F'\t' '$3 == "issue#22" { print $6 }' "$FIXV4/valid-units.tsv")
CH_E="$UEV" edit_plan 'NR > 1 && $2 == "report" && $3 == "issue#21" { $5 = $5 ";verdict=KEEP"; $6 = ENVIRON["CH_E"] } { print }'
need "fixture evidence found" test -n "$UEV"
"$SH" "$ENGINE" check-plan --plan "$C/plan.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "check-plan accepts both keys (rc=$RC $(head -c 200 "$C/cp.err"))" rc 0
CHORE_PLAN_PY="$W/bin/plan-ok.py" "$SH" "$ENGINE" check-plan --plan "$C/plan.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "awk alone accepts both keys (rc=$RC $(head -c 200 "$C/cp.err"))" rc 0
app --tiers 2 --yes
need "apply rc=$RC $(head -c 200 "$C/app.err")" rc 0
need "close with a title row OK" res OK close-pr 'pr#6'
need "posted comment unchanged" test "$(cat "$GH_FIX/comment.pr.6")" = closing
ver
need "verify rc=$RC" rc 0
cp "$C/plan.tsv" "$C/plan.t"
edit_plan 'NR > 1 && $2 == "delete-remote" && $3 == "feat/merged" { $5 = $5 ";title=x" } { print }'
CHORE_PLAN_PY="$W/bin/plan-ok.py" "$SH" "$ENGINE" check-plan --plan "$C/plan.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "awk alone refuses title on a delete row (rc=$RC)" rc 1
need "awk message" has "$C/cp.err" "snapshot key title not allowed for delete-remote"
"$SH" "$ENGINE" check-plan --plan "$C/plan.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "chore_plan.py refuses it too (rc=$RC)" rc 1
end

# ---------- U3 review round 2026-10-19 (opus): taking under signals, exit codes, --tiers, pre-start abort, re-read P, withdrawn ----------
begin "102 v4 helper exit 5 / 8 / 9 → each its own die message (ABORTED); exit 0 with a row left without a line → die, that row settles from the journal" std
for x in "5|Jira 인증 실패 — JIRA_EMAIL/JIRA_API_TOKEN 또는 CHORE_ENV_FILE의 값 확인" "8|Jira 단계가 중단됨" "9|Jira 단계가 차단기로 멈춤 — 원인을 고치기 전에는 다시 실행하지 않음"; do
  code="${x%%|*}"; msg="${x#*|}"
  newcase "std-rc$code"; rep; add_jira; jstub
  JSTUB_RC="$code" appbg --tiers 2 --yes
  need "exit $code: rc=$RC" rc 1
  need "exit $code: message" has "$C/app.err" "chore: $msg"
  need "exit $code: ABORTED reason" has "$C/app.out" "reason=$msg$(printf '\t')attempt="
  need "exit $code: remote stage not run" bare_has feat/merged
done
newcase std-rc0-missing; rep; add_jira; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\n' > "$C/jout"
JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
A=$(sumf attempt)
need "exit 0, a row without a line: rc=$RC" rc 1
need "message" has "$C/app.err" "Jira 단계 오류: 끝났지만 결과 줄이 없는 행이 있음"
need "the decided row keeps the helper's line" hasx "$C/app.out" "$(jline OK jira#TST-101 "moved: 옮김" "$A")"
need "the other row settles NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-102 "run aborted at jira" "$A")"
need "remote stage not run" bare_has feat/merged
end

begin "103 v4 a signal while helper lines are taken (the check of line 2 killed, TERM to the engine) → the abort path takes lines 2 and 3; in the abort path a bad line is skipped and later lines are still taken" std
rep; add_jira 3; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 바뀜\tattempt=@A@\nRESULT\tFAIL\tjira-transition\tjira#TST-105\tcomment-rejected: 거부\tattempt=@A@\n' > "$C/jout"
AWK_KILL_AT=2 AWK_KILL_CNT="$C/awk.cnt" JSTUB_OUT="$C/jout" PATH="$W/awkbin:$PATH" appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "the check of line 2 really was killed" test "$(cat "$C/awk.cnt")" -ge 3
need "line 1 taken once" hasx "$C/app.out" "$(jline OK jira#TST-101 "moved: 옮김" "$A")"
need "line 2 taken by the abort path" hasx "$C/app.out" "$(jline SKIP jira#TST-102 "changed: 바뀜" "$A")"
need "line 3 taken by the abort path" hasx "$C/app.out" "$(jline FAIL jira#TST-105 "comment-rejected: 거부" "$A")"
need "one RESULT per Jira row" test "$(nres jira#TST-101)$(nres jira#TST-102)$(nres jira#TST-105)" = 111
need "not misread as a bad line" hasnt "$C/app.err" "형식 오류"
need "ABORTED by the signal, counts from all three" has "$C/app.out" "at=jira$(printf '\t')ok=1$(printf '\t')skip=1$(printf '\t')fail=1$(printf '\t')unknown=0$(printf '\t')unattempted=3$(printf '\t')reason=terminated by signal$(printf '\t')attempt=$A"
newcase std-abort-skip; rep; add_jira 3; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\nRESULT\tOK\tjira-transition\tjira#TST-102\tnot a class\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-105\tchanged: 바뀜\tattempt=@A@\n' > "$C/jout"
JSTUB_OUT="$C/jout" JSTUB_SLEEP=30 JSTUB_READY="$C/ready" JSTUB_APPOUT="$C/app.out" appbg --tiers 2 --yes
A=$(sumf attempt)
need "abort path: rc=$RC" rc 1
need "abort path: line 1 taken" hasx "$C/app.out" "$(jline OK jira#TST-101 "moved: 옮김" "$A")"
need "abort path: bad line 2 reported" has "$C/app.err" "the Jira helper's line 2 is not a RESULT of this run (not taken)"
need "abort path: its row settles NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-102 "run aborted at jira" "$A")"
need "abort path: line 3 still taken" hasx "$C/app.out" "$(jline SKIP jira#TST-105 "changed: 바뀜" "$A")"
newcase std-run-skip; rep; add_jira; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tnot a class\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 바뀜\tattempt=@A@\n' > "$C/jout"
JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
A=$(sumf attempt)
need "run path: bad line 1 dies (rc=$RC)" has "$C/app.err" "Jira 단계 출력 형식 오류 (줄 1)"
need "run path: the line after it is taken by the abort path" hasx "$C/app.out" "$(jline SKIP jira#TST-102 "changed: 바뀜" "$A")"
need "run path: the bad line's row NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-101 "run aborted at jira" "$A")"
end

begin "104 v4 --tiers without 2 on a plan with Jira rows → die before acting" std
rep; add_jira; jstub
app --tiers 1
need "rc=$RC" rc 1
need "message" has "$C/app.err" "Jira 행이 있는 계획은 --tiers에 2를 넣어야 합니다"
need "no local delete" local_has feat/merged
need "helper never started" test ! -e "$C/jstub.log"
need "no receipt" hasnt "$C/app.out" RESULT
end

begin "105 v4 abort before the helper started (close stage fails) → Jira rows NOT-ATTEMPTED; the journal is not read (even an unreadable one)" std
rep; promote_pr6 "closing"; add_jira; jstub
mkdir -p "$(gcd)/chore/$(runid).journal"                 # a journal path that cannot be read as a file
GH_FAIL='pr view' appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "stopped in the close stage" has "$C/app.out" "at=close"
need "helper never started" test ! -e "$C/jstub.log"
need "TST-101 NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-101 "run aborted at close" "$A")"
need "TST-102 NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-102 "run aborted at close" "$A")"
need "no UNKNOWN" hasnt "$C/app.out" UNKNOWN
end

begin "106 v4 the engine finds its own folder whatever CDPATH says (relative call from the repo root, CDPATH with another scripts/)" std
mkdir -p "$W/cdp/scripts"; cp "$W/bin/plan-no.py" "$W/cdp/scripts/chore_plan.py"
(cd "$SKILL" && CDPATH="$W/cdp" "$SH" scripts/chore.sh check-plan --plan "$FIXV4/valid.tsv") > "$C/cp.out" 2> "$C/cp.err"; RC=$?
need "accepted with its own chore_plan.py (rc=$RC $(head -c 200 "$C/cp.err"))" rc 0
need "nothing printed" test ! -s "$C/cp.out"
end

begin "107 v4 --only-group jira: a branch group literally named jira stays selectable in a plan without Jira rows; with Jira rows it dies" std
bare_set jira "$A1"
jq --arg o "$A1" --arg m "$M1" '. + [{number: 95, state: "MERGED", headRefName: "jira", headRefOid: $o, baseRefName: "develop", isCrossRepository: false,
  headRepositoryOwner: {login: "test"}, headRepository: {name: "repo"}, author: {login: "dev9"}, updatedAt: "2026-10-01T00:00:00Z",
  title: "PR jira", mergeCommit: {oid: $m}}]' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
rep
need "branch jira planned in group jira" jrow jira '.action == "delete-remote" and .group == "jira"'
cp "$C/plan.tsv" "$C/plan.v3"
app --tiers 2 --yes --only-group jira
need "no Jira rows: rc=$RC" rc 0
need "no Jira rows: the branch group runs" res OK delete-remote jira
need "no Jira rows: other groups untouched" bare_has feat/merged
cp "$C/plan.v3" "$C/plan.tsv"; add_jira; jstub
app --tiers 2 --yes --only-group jira
need "with Jira rows: rc=$RC" rc 1
need "with Jira rows: message" has "$C/app.err" "Jira 행은 --only-group 없이 전체 실행에서만 처리됩니다"
end

begin "108 v4 after the Jira stage P is read again before any delete: a branch protected while it ran → SKIP protected; no re-read when the helper did not run" std
rep; add_jira; jstub; : > "$GH_LOG"                     # count apply's loads only
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 바뀜\tattempt=@A@\n' > "$C/jout"
JSTUB_OUT="$C/jout" JSTUB_HOOK="printf '[{\"name\":\"feat/merged\"}]\n' > '$GH_FIX/protected.json'" appbg --tiers 2 --yes
need "rc=$RC" rc 0
need "protected meanwhile → SKIP" resr SKIP delete-remote feat/merged "protected (branch-protection)"
need "branch kept" bare_has feat/merged
need "the others deleted" res OK delete-remote feat/squash
need "two full loads (start + after Jira)" test "$(grep -c '^pr list .*--state all' "$GH_LOG")" = 2
newcase std-noreread; rep; jstub; : > "$GH_LOG"
app --tiers 2 --yes
need "plan without Jira rows: one load" test "$(grep -c '^pr list .*--state all' "$GH_LOG")" = 1
newcase std-noreread-og; rep; add_jira; jstub; : > "$GH_LOG"
app --tiers 2 --yes --only-group 'feat/*'
need "--only-group run: one load" test "$(grep -c '^pr list .*--state all' "$GH_LOG")" = 1
end

begin "109 v4 journal *-withdrawn: a row whose only writes were withdrawn settles NOT-ATTEMPTED; a real write before a withdrawn one, or a withdrawn of another kind, stays UNKNOWN" std
rep; add_jira 3; jstub
printf '%s\n' '2026-10-19T00:00:01.000Z @A@ jira#TST-101 comment-sent' '2026-10-19T00:00:01.100Z @A@ jira#TST-101 comment-withdrawn' \
  '2026-10-19T00:00:02.000Z @A@ jira#TST-102 comment-sent' '2026-10-19T00:00:02.100Z @A@ jira#TST-102 comment-ok 10001' \
  '2026-10-19T00:00:02.200Z @A@ jira#TST-102 transition-sent' '2026-10-19T00:00:02.300Z @A@ jira#TST-102 transition-withdrawn' \
  '2026-10-19T00:00:03.000Z @A@ jira#TST-105 transition-sent' '2026-10-19T00:00:03.100Z @A@ jira#TST-105 comment-withdrawn' > "$C/jrn"
JSTUB_JOURNAL="$C/jrn" JSTUB_RC=8 appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "message" has "$C/app.err" "Jira 단계가 중단됨"
need "sent + withdrawn only → NOT-ATTEMPTED" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-101 "run aborted at jira" "$A")"
need "comment written, transition withdrawn → UNKNOWN" hasx "$C/app.out" "$(jline UNKNOWN jira#TST-102 "journal has a write of this attempt, outcome unread (run aborted at jira)" "$A")"
need "withdrawn of another kind → UNKNOWN" hasx "$C/app.out" "$(jline UNKNOWN jira#TST-105 "journal has a write of this attempt, outcome unread (run aborted at jira)" "$A")"
end

begin "110 v4 abort journal count = chore-jira.py journaled_count: the same journals fed to the engine's awk program and to the helper's function give the same refs with a write" std
eval "$(sed -n "/^P_JOURNALED='\$/,/'\$/p" "$ENGINE")"
need "awk program found in the engine" test -n "${P_JOURNALED:-}"
AT=20261019T010101Z-0000000a; AO=20261019T010101Z-0000000b
k=0
while IFS='|' read -r what body tail; do
  # lines "<n> <attempt> <ref> <event> [id]" → instant 2026-10-19T00:00:0<n>.000Z; the tail = bytes without a newline
  k=$((k+1)); jf="$C/j.$k"; printf '%b' "$body" | sed "s/@A@/$AT/g; s/@B@/$AO/g; s/^\([0-9]\) /2026-10-19T00:00:0\1.000Z /" > "$jf"
  if [ -n "$tail" ]; then t="${tail//@A@/$AT}"; printf '2026-10-19T00:00:0%s.000Z %s' "${t%% *}" "${t#* }" >> "$jf"; fi
  nl=$(tr -cd '\n' < "$jf" | wc -l | tr -d ' ')
  a=$(CH_AT="$AT" awk -v n="$nl" "$P_JOURNALED" "$jf" | sort | tr '\n' ' ')
  p=$(python3 -I -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("chore_jira", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
lines, torn = m.split_journal(open(sys.argv[2], "rb").read())
refs = {ln.split(" ")[2] for ln in lines}
net = m.journaled_count(m.parse_journal(lines, refs))
print(" ".join(sorted(r for (att, r), c in net.items() if att == sys.argv[3] and c > 0)) + (" " if any(att == sys.argv[3] and c > 0 for (att, r), c in net.items()) else ""), end="")
' "$SKILL/scripts/chore-jira.py" "$jf" "$AT" 2> "$C/py.err")
  need "[$what] helper parses it ($(head -c 200 "$C/py.err"))" test ! -s "$C/py.err"
  need "[$what] same refs: engine '$a' helper '$p'" test "$a" = "$p"
done <<'JRN'
sent only|1 @A@ jira#TST-1 comment-sent\n|
sent + withdrawn|1 @A@ jira#TST-1 comment-sent\n2 @A@ jira#TST-1 comment-withdrawn\n|
sent + ok|1 @A@ jira#TST-1 comment-sent\n2 @A@ jira#TST-1 comment-ok 10001\n|
sent + rejected|1 @A@ jira#TST-1 comment-sent\n2 @A@ jira#TST-1 comment-rejected\n|
comment ok + transition withdrawn|1 @A@ jira#TST-1 comment-sent\n2 @A@ jira#TST-1 comment-ok 10001\n3 @A@ jira#TST-1 transition-sent\n4 @A@ jira#TST-1 transition-withdrawn\n|
transition sent + withdrawn only|1 @A@ jira#TST-1 transition-sent\n2 @A@ jira#TST-1 transition-withdrawn\n|
another attempt's lines|1 @B@ jira#TST-1 comment-sent\n2 @B@ jira#TST-1 comment-ok 10001\n3 @A@ jira#TST-2 comment-sent\n4 @A@ jira#TST-2 comment-withdrawn\n|
torn last line|1 @A@ jira#TST-1 comment-sent\n2 @A@ jira#TST-1 comment-withdrawn\n|3 @A@ jira#TST-2 comment-se
torn withdrawn|1 @A@ jira#TST-1 comment-sent\n|2 @A@ jira#TST-1 comment-withdr
two refs interleaved|1 @A@ jira#TST-1 comment-sent\n2 @A@ jira#TST-2 comment-sent\n3 @A@ jira#TST-1 comment-withdrawn\n4 @A@ jira#TST-2 comment-ok 10002\n5 @A@ jira#TST-2 transition-sent\n6 @A@ jira#TST-2 transition-withdrawn\n7 @A@ jira#TST-3 transition-sent\n8 @A@ jira#TST-3 transition-ok\n|
empty journal||
JRN
end

begin "111 v4 the reload after the Jira stage re-checks the repo identity: default branch switched while the helper ran → die at remote-reload before any push" std
rep; add_jira; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 바뀜\tattempt=@A@\n' > "$C/jout"
JSTUB_OUT="$C/jout" JSTUB_HOOK="printf '{\"id\":\"R_test\",\"defaultBranchRef\":{\"name\":\"main\"},\"hasIssuesEnabled\":true}\n' > '$GH_FIX/repo.json'" appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "message (same as the start-of-run check)" has "$C/app.err" "plan default branch develop differs from current default main"
need "ABORTED at remote-reload" has "$C/app.out" "ABORTED$(printf '\t')run_id=$(runid)$(printf '\t')at=remote-reload"
need "Jira lines kept" hasx "$C/app.out" "$(jline OK jira#TST-101 "moved: 옮김" "$A")"
need "delete rows NOT-ATTEMPTED" resr NOT-ATTEMPTED delete-remote feat/merged "run aborted at remote-reload"
need "nothing pushed" test ! -s "$C/push.log"
need "branches kept" bare_has feat/merged
end

begin "112 v4 the line check dying alone (SIGKILL, no signal to the engine) is a failed check, not a signal: reason says so; the abort path still takes that line and the next" std
rep; add_jira 3; jstub
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 바뀜\tattempt=@A@\nRESULT\tFAIL\tjira-transition\tjira#TST-105\tcomment-rejected: 거부\tattempt=@A@\n' > "$C/jout"
AWK_KILL_AT=2 AWK_KILL_SIG=KILL AWK_KILL_CNT="$C/awk.cnt" JSTUB_OUT="$C/jout" PATH="$W/awkbin:$PATH" appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC" rc 1
need "reason = the failed check" has "$C/app.out" "reason=line check failed (exit 137) on the Jira helper's line 2$(printf '\t')attempt=$A"
need "not called a signal" hasnt "$C/app.out" "terminated by signal"
need "line 2 taken by the abort path" hasx "$C/app.out" "$(jline SKIP jira#TST-102 "changed: 바뀜" "$A")"
need "line 3 taken by the abort path" hasx "$C/app.out" "$(jline FAIL jira#TST-105 "comment-rejected: 거부" "$A")"
need "one RESULT per Jira row" test "$(nres jira#TST-101)$(nres jira#TST-102)$(nres jira#TST-105)" = 111
end

# ---------- 2026-10-20 external review: a close whose OK line was lost with a receipt-less run (SIGKILL) ----------
# The rerun's close stage sees the item CLOSED → SKIP "changed since approval"; verify then applies the same evidence
# rule as an UNKNOWN close (CLOSED + the approved comment created at or after the plan) instead of saying nothing.
skipres() { # results of a rerun whose close rows all SKIP changed: lines "<action> <ref> <now-state>"
  { while read -r a r st; do printf 'RESULT\tSKIP\t%s\t%s\tchanged since approval (now: %s 2026-10-19T00:00:00Z)\n' "$a" "$r" "$st"; done
    printf 'SUMMARY\tok=0\tskip=2\tfail=0\tunknown=0\trun_id=%s\tattempt=20261019T010101Z-0000000c\tscope=full\tjournal=-\n' "$(runid)"; } > "$C/r.out"; }
begin "113 verify: a rerun SKIP changed on a close row reconciles to OK only when the state is CLOSED and the approved comment was created at or after the plan; CLOSED without that comment, or still OPEN → no line" std
rep
CMT='승인된 닫기 코멘트 — 두 번째 문장'; ICMT='이슈 닫기 — 승인본'
promote_pr6 "$(printf '%s' "$CMT" | "$SH" "$ENGINE" penc)"
edit_plan 'NR > 1 && $2 == "report" && $3 == "issue#20" { $1 = 2; $2 = "close-issue"; $6 = "'"$(printf '%s' "$ICMT" | "$SH" "$ENGINE" penc)"'" } { print }'
printf 'close-pr pr#6 CLOSED\nclose-issue issue#20 CLOSED\n' | skipres
# (a) CLOSED with the approved comment, created after the plan
jq --arg c "$CMT" 'map(if .number == 6 then .state = "CLOSED" | .comments = [{body: "x", createdAt: "2000-01-01T00:00:00Z"}, {body: $c, createdAt: "2099-01-01T00:00:00Z"}] else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
jq --arg c "$ICMT" 'map(if .number == 20 then .state = "CLOSED" | .comments = [{body: $c, createdAt: "2099-01-01T00:00:00Z"}] else . end)' "$GH_FIX/issues.json" > "$C/i.json" && mv "$C/i.json" "$GH_FIX/issues.json"
ver "$C/r.out"
need "(a) rc=$RC" rc 0
need "(a) close-pr reconciled with the exact text" hasx "$C/ver.out" "$(printf 'VERIFY\tOK\tclose-pr\tpr#6\treconciled: CLOSED with the approved comment at verify (rerun SKIP changed)')"
need "(a) close-issue reconciled with the exact text" hasx "$C/ver.out" "$(printf 'VERIFY\tOK\tclose-issue\tissue#20\treconciled: CLOSED with the approved comment at verify (rerun SKIP changed)')"
need "(a) success=yes" has "$C/ver.out" "unresolved=0$(printf '\t')run=complete$(printf '\t')success=yes"
# (b) CLOSED, but no approved comment created at or after the plan: none / another text / the approved text before it
for cm in '[]' '[{"body":"another text","createdAt":"2099-01-01T00:00:00Z"}]' "$(jq -cn --arg c "$CMT" '[{body: $c, createdAt: "2000-01-01T00:00:00Z"}]')"; do
  jq --argjson cm "$cm" 'map(if .number == 6 then .state = "CLOSED" | .comments = $cm else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
  ver "$C/r.out"
  need "(b) $cm: rc=$RC" rc 0
  need "(b) $cm: no line for pr#6" hasnt "$C/ver.out" "$(printf '\tpr#6\t')"
done
# (c) still OPEN (updated by someone) → no line, one state read for the row
jq 'map(if .number == 6 then .state = "OPEN" | .comments = [] else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
printf 'close-pr pr#6 OPEN\n' | skipres; : > "$GH_LOG"
ver "$C/r.out"
need "(c) rc=$RC" rc 0
need "(c) no line for pr#6" hasnt "$C/ver.out" "$(printf '\tpr#6\t')"
need "(c) one view of pr#6" test "$(grep -c '^pr view 6 ' "$GH_LOG")" = 1
need "(c) no write" hasnt "$GH_LOG" close
# other SKIP reasons never trigger the check
printf 'RESULT\tSKIP\tclose-pr\tpr#6\tnot changed\nSUMMARY\tok=0\tskip=1\tfail=0\tunknown=0\trun_id=%s\n' "$(runid)" > "$C/r.out"; : > "$GH_LOG"
ver "$C/r.out"
need "other SKIP reason: no view" hasnt "$GH_LOG" "pr view 6 "
end

begin "114 end to end: the engine SIGKILLed after its close stage (no receipt, dropped); the rerun SKIPs the closed PR; verify of the rerun reports it closed by this plan" std
rep
CMT='끝까지 — 승인된 닫기 코멘트'
promote_pr6 "$(printf '%s' "$CMT" | "$SH" "$ENGINE" penc)"
mkdir -p "$C/tmp"                                         # a SIGKILLed engine leaves its temp dir behind: keep it in $C
GIT_PUSH_KILL=KILL TMPDIR="$C/tmp" PATH="$W/gitbin:$PATH" "$SH" "$ENGINE" apply t --plan "$C/plan.tsv" --digest "$(dg "$C/plan.tsv")" \
  --tiers 2 --yes > "$C/app.out" 2> "$C/app.err" &
{ wait $!; } 2>/dev/null; RC=$?                           # (no "Killed" job notice in the test output)
dg "$C/plan.tsv" > "$C/approved.sha"
need "run 1 killed (rc=$RC)" test "$RC" -ne 0
need "run 1 closed pr#6" res OK close-pr 'pr#6'
need "run 1 left no receipt" sh -c "! grep -qE '^(SUMMARY|ABORTED)' '$C/app.out'"
app --tiers 2 --yes
need "rerun rc=$RC" rc 0
need "rerun SKIP changed" resr SKIP close-pr 'pr#6' "changed since approval (now: CLOSED"
ver
need "verify rc=$RC" rc 0
need "closed by this plan" hasx "$C/ver.out" "$(printf 'VERIFY\tOK\tclose-pr\tpr#6\treconciled: CLOSED with the approved comment at verify (rerun SKIP changed)')"
need "success=yes" has "$C/ver.out" "success=yes"
end

begin "115 verify: SKIP changed on a close row after an earlier UNKNOWN / FAIL → closed_by_plan decides first (OK, same line) else RESOLVED as before; OPEN with the comment → no line; created == plan created counts; a failed read dies" std
rep
CMT='승인된 닫기 코멘트 — 앞선 결과 있음'
promote_pr6 "$(printf '%s' "$CMT" | "$SH" "$ENGINE" penc)"
CR=$(awk -F'\t' 'NR == 1 { for (i = 2; i <= NF; i++) if ($i ~ /^created=/) print substr($i, 9) }' "$C/plan.tsv" | sed 's/%3A/:/g')
need "plan created read ($CR)" sh -c "printf '%s' '$CR' | grep -Eqx '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'"
SKIPLINE="$(printf 'RESULT\tSKIP\tclose-pr\tpr#6\tchanged since approval (now: CLOSED x 2026-10-19T00:00:00Z)')"
OKLINE="$(printf 'VERIFY\tOK\tclose-pr\tpr#6\treconciled: CLOSED with the approved comment at verify (rerun SKIP changed)')"
setpr6() { jq --arg s "$1" --argjson cm "$2" 'map(if .number == 6 then .state = $s | .comments = $cm else . end)' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"; }
twoRuns() { # $1 = run-1 RESULT status for pr#6 (UNKNOWN | FAIL), then a rerun SKIP changed
  { if [ "$1" = UNKNOWN ]; then printf 'RESULT\tUNKNOWN\tclose-pr\tpr#6\tsent at close, outcome unread\nABORTED\trun_id=%s\tat=close\tok=0\tskip=0\tfail=0\tunknown=1\tunattempted=0\treason=terminated by signal\n' "$(runid)"
    else printf 'RESULT\tFAIL\tclose-pr\tpr#6\tgh pr close failed: timeout\nSUMMARY\tok=0\tskip=0\tfail=1\tunknown=0\trun_id=%s\n' "$(runid)"; fi
    printf '%s\nSUMMARY\tok=0\tskip=1\tfail=0\tunknown=0\trun_id=%s\n' "$SKIPLINE" "$(runid)"; } > "$C/r.out"; }
for first in UNKNOWN FAIL; do
  twoRuns "$first"
  setpr6 CLOSED "$(jq -cn --arg c "$CMT" '[{body: $c, createdAt: "2099-01-01T00:00:00Z"}]')"
  ver "$C/r.out"
  need "($first) CLOSED + approved comment: rc=$RC" rc 0
  need "($first) OK, the same line as without an earlier result" hasx "$C/ver.out" "$OKLINE"
  need "($first) no RESOLVED for it" hasnt "$C/ver.out" "RESOLVED"
  setpr6 CLOSED '[]'
  ver "$C/r.out"
  need "($first) CLOSED without the comment: rc=$RC" rc 0
  need "($first) RESOLVED with today's text" hasx "$C/ver.out" "$(printf 'VERIFY\tRESOLVED\tclose-pr\tpr#6\tearlier %s, last run SKIP: changed since approval (now: CLOSED x 2026-10-19T00:00:00Z)' "$first")"
  need "($first) no OK for it" hasnt "$C/ver.out" "$OKLINE"
done
# (c) OPEN, with the approved comment after the plan: the CLOSED state is required on its own
printf '%s\nSUMMARY\tok=0\tskip=1\tfail=0\tunknown=0\trun_id=%s\n' "$SKIPLINE" "$(runid)" > "$C/r1.out"
setpr6 OPEN "$(jq -cn --arg c "$CMT" '[{body: $c, createdAt: "2099-01-01T00:00:00Z"}]')"
ver "$C/r1.out"
need "(c) OPEN with the comment: rc=$RC" rc 0
need "(c) no line for pr#6" hasnt "$C/ver.out" "$(printf '\tpr#6\t')"
# (d) created exactly at the plan's created (the boundary is inclusive)
setpr6 CLOSED "$(jq -cn --arg c "$CMT" --arg t "$CR" '[{body: $c, createdAt: $t}]')"
ver "$C/r1.out"
need "(d) createdAt == plan created → OK (rc=$RC)" hasx "$C/ver.out" "$OKLINE"
# (e) the state read fails in that arm → verify dies, no summary
GH_FAIL='pr view' ver "$C/r1.out"
need "(e) gh failure: rc=$RC" test "$RC" -ne 0
need "(e) message" has "$C/ver.err" "gh failed: pr view 6"
need "(e) no VERIFY-SUMMARY" hasnt "$C/ver.out" VERIFY-SUMMARY
# (g) an answer outside the schema (comments not a list) dies as malformed, never counts as "no" (case 116 has the rest)
setpr6 CLOSED '"not a list"'
ver "$C/r1.out"
need "(g) malformed answer: rc=$RC" test "$RC" -ne 0
need "(g) message" has "$C/ver.err" "malformed close-pr view answer for pr#6"
need "(g) no VERIFY-SUMMARY" hasnt "$C/ver.out" VERIFY-SUMMARY
# (g2) an answer jq cannot parse at all dies as unreadable
printf '{"state":"CLOSED","comments":[\n' > "$GH_FIX/answer.pr-view"
ver "$C/r1.out"
rm -f "$GH_FIX/answer.pr-view"
need "(g2) jq failure: rc=$RC" test "$RC" -ne 0
need "(g2) message" has "$C/ver.err" "unreadable close-pr view answer for pr#6"
need "(g2) no VERIFY-SUMMARY" hasnt "$C/ver.out" VERIFY-SUMMARY
# (h) the approved comment cannot be read from the plan → dies, never an empty comparison
setpr6 CLOSED "$(jq -cn --arg c "$CMT" '[{body: $c, createdAt: "2099-01-01T00:00:00Z"}]')"
AWK_FAIL_COMMENT_READ=1 PATH="$W/awkbin:$PATH" ver "$C/r1.out"
need "(h) comment read failure: rc=$RC" test "$RC" -ne 0
need "(h) message" has "$C/ver.err" "cannot read the approved comment of pr#6"
need "(h) no VERIFY-SUMMARY" hasnt "$C/ver.out" VERIFY-SUMMARY
end

begin "116 verify: the close-evidence read is schema-strict — every malformed view answer (incl. empty, two documents, impossible calendar / clock times) dies in all four arms that use it (UNKNOWN close, SKIP changed after UNKNOWN / FAIL / nothing); a valid empty comment list keeps today's verdicts" std
rep
CMT='승인된 닫기 코멘트 — 형식 검사'
promote_pr6 "$(printf '%s' "$CMT" | "$SH" "$ENGINE" penc)"
SKIPLINE="$(printf 'RESULT\tSKIP\tclose-pr\tpr#6\tchanged since approval (now: CLOSED x 2026-10-19T00:00:00Z)')"
CR=$(awk -F'\t' 'NR == 1 { for (i = 2; i <= NF; i++) if ($i ~ /^created=/) print substr($i, 9) }' "$C/plan.tsv" | sed 's/%3A/:/g')
CRM1=$(python3 -I -c 'import datetime, sys; print((datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ") - datetime.timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$CR")
need "plan created - 1 s computed ($CR → $CRM1)" test -n "$CRM1"
armres() { # $1 = unknown | skip-after-unknown | skip-after-fail | skip-only → $C/r.out
  { case "$1" in unknown|skip-after-unknown)
      printf 'RESULT\tUNKNOWN\tclose-pr\tpr#6\tsent at close, outcome unread\nABORTED\trun_id=%s\tat=close\tok=0\tskip=0\tfail=0\tunknown=1\tunattempted=0\treason=terminated by signal\n' "$(runid)" ;;
    skip-after-fail) printf 'RESULT\tFAIL\tclose-pr\tpr#6\tgh pr close failed: timeout\nSUMMARY\tok=0\tskip=0\tfail=1\tunknown=0\trun_id=%s\n' "$(runid)" ;;
    esac
    case "$1" in skip-*) printf '%s\nSUMMARY\tok=0\tskip=1\tfail=0\tunknown=0\trun_id=%s\n' "$SKIPLINE" "$(runid)" ;; esac; } > "$C/r.out"; }
for arm in unknown skip-after-unknown skip-after-fail skip-only; do
  armres "$arm"
  k=0
  while IFS= read -r ans; do
    # @EMPTY@ = zero bytes, @WS@ / @NL@ = whitespace only, @TWO@ = two documents, @YESBAD@ = a document that would
    # reconcile followed by a bad one, @TRAILNL@ = the approved comment with a createdAt ending in a newline;
    # @CMT@ = the approved comment (a bad time
    # with the approved text must still die, never reconcile)
    k=$((k+1)); ans="${ans//@CMT@/$CMT}"
    case "$ans" in
      @EMPTY@) : > "$GH_FIX/answer.pr-view" ;;
      @WS@) printf ' \n\t\n' > "$GH_FIX/answer.pr-view" ;;
      @TWO@) printf '{}\n{"state":"CLOSED","comments":[]}\n' > "$GH_FIX/answer.pr-view" ;;
      @NL@) printf '\n' > "$GH_FIX/answer.pr-view" ;;
      @YESBAD@) jq -cn --arg c "$CMT" '{state: "CLOSED", comments: [{body: $c, createdAt: "2099-01-01T00:00:00Z"}]}, {}' > "$GH_FIX/answer.pr-view" ;;
      @TRAILNL@) jq -cn --arg c "$CMT" '{state: "CLOSED", comments: [{body: $c, createdAt: "2099-01-01T00:00:00Z\n"}]}' > "$GH_FIX/answer.pr-view" ;;
      *) printf '%s\n' "$ans" > "$GH_FIX/answer.pr-view" ;;
    esac
    ver "$C/r.out" < /dev/null                               # nothing on the verify path may read this here-doc
    need "[$arm] answer $k $ans: dies (rc=$RC)" test "$RC" -ne 0
    need "[$arm] answer $k: malformed message" has "$C/ver.err" "chore: malformed close-pr view answer for pr#6"
    need "[$arm] answer $k: no VERIFY-SUMMARY" hasnt "$C/ver.out" VERIFY-SUMMARY
  done <<'BADANS'
{}
{"state":"CLOSED","comments":null}
{"state":"CLOSED"}
{"state":"CLOSED","comments":[{"body":"x","createdAt":null}]}
{"state":"CLOSED","comments":[{"body":5,"createdAt":"2099-01-01T00:00:00Z"}]}
{"state":"closed","comments":[]}
[]
{"state":"CLOSED","comments":["x"]}
{"state":"CLOSED","comments":[{"body":"x","createdAt":"2099-01-01 00:00:00"}]}
@EMPTY@
@WS@
@NL@
@TWO@
@YESBAD@
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-13-01T00:00:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-01-32T00:00:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-02-29T00:00:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-99-99T99:99:99Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-01-01T24:00:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-01-01T00:60:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-01-01T00:00:60Z"}]}
@TRAILNL@
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-00-01T00:00:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-01-00T00:00:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2099-04-31T00:00:00Z"}]}
{"state":"CLOSED","comments":[{"body":"@CMT@","createdAt":"2100-02-29T00:00:00Z"}]}
BADANS
  need "[$arm] all answers ran" test "$k" = 26
  # positive control: a valid answer with an empty comment list = today's verdicts
  printf '{"state":"CLOSED","comments":[]}\n' > "$GH_FIX/answer.pr-view"
  ver "$C/r.out"
  case "$arm" in
    unknown) need "[$arm] empty list: UNRESOLVED as today (rc=$RC)" has "$C/ver.out" "VERIFY$(printf '\t')UNRESOLVED$(printf '\t')close-pr$(printf '\t')pr#6$(printf '\t')last result UNKNOWN: sent at close, outcome unread; change not visible at verify" ;;
    skip-after-*) need "[$arm] empty list: RESOLVED as today (rc=$RC)" has "$C/ver.out" "VERIFY$(printf '\t')RESOLVED$(printf '\t')close-pr$(printf '\t')pr#6$(printf '\t')earlier " ;;
    skip-only) need "[$arm] empty list: no line, success (rc=$RC)" sh -c "! grep -q '$(printf '\t')pr#6$(printf '\t')' '$C/ver.out' && grep -q 'success=yes' '$C/ver.out'" ;;
  esac
  need "[$arm] empty list: summary printed" has "$C/ver.out" VERIFY-SUMMARY
  # boundary: the approved text created one second before the plan's created does not count (same verdict as no comment)
  jq -cn --arg c "$CMT" --arg tv "$CRM1" '{state: "CLOSED", comments: [{body: $c, createdAt: $tv}]}' > "$GH_FIX/answer.pr-view"
  ver "$C/r.out"
  case "$arm" in
    unknown) need "[$arm] created - 1 s: UNRESOLVED (rc=$RC)" has "$C/ver.out" "VERIFY$(printf '\t')UNRESOLVED$(printf '\t')close-pr$(printf '\t')pr#6$(printf '\t')last result UNKNOWN" ;;
    skip-after-*) need "[$arm] created - 1 s: RESOLVED (rc=$RC)" has "$C/ver.out" "VERIFY$(printf '\t')RESOLVED$(printf '\t')close-pr$(printf '\t')pr#6$(printf '\t')earlier " ;;
    skip-only) need "[$arm] created - 1 s: no line, success (rc=$RC)" sh -c "! grep -q '$(printf '\t')pr#6$(printf '\t')' '$C/ver.out' && grep -q 'success=yes' '$C/ver.out'" ;;
  esac
  need "[$arm] created - 1 s: never reconciled" hasnt "$C/ver.out" "reconciled"
  # valid times count: a fractional second (compared at second precision), leap days (2028, the 400-year 2400), and
  # exactly the plan's created — with and without a fraction (without the [0:19] cut "….000Z" sorts below "…Z")
  for tv in 2099-01-01T00:00:00.123Z 2028-02-29T23:59:59Z 2400-02-29T00:00:00Z "$CR" "${CR%Z}.000Z"; do
    jq -cn --arg c "$CMT" --arg tv "$tv" '{state: "CLOSED", comments: [{body: $c, createdAt: $tv}]}' > "$GH_FIX/answer.pr-view"
    ver "$C/r.out"
    case "$arm" in
      unknown) need "[$arm] createdAt $tv: reconciled (rc=$RC)" has "$C/ver.out" "VERIFY$(printf '\t')OK$(printf '\t')close-pr$(printf '\t')pr#6$(printf '\t')reconciled: CLOSED with the approved comment at verify (was UNKNOWN)" ;;
      *) need "[$arm] createdAt $tv: OK (rc=$RC)" hasx "$C/ver.out" "$(printf 'VERIFY\tOK\tclose-pr\tpr#6\treconciled: CLOSED with the approved comment at verify (rerun SKIP changed)')" ;;
    esac
  done
done
rm -f "$GH_FIX/answer.pr-view"
# a close result for a row the plan does not have: the approved comment cannot be read → dies before any gh view
printf 'RESULT\tUNKNOWN\tclose-pr\tpr#40\tsent at close, outcome unread\nABORTED\trun_id=%s\tat=close\tok=0\tskip=0\tfail=0\tunknown=1\tunattempted=0\treason=x\n' "$(runid)" > "$C/r.out"
: > "$GH_LOG"; ver "$C/r.out"
need "row not in the plan: dies (rc=$RC)" test "$RC" -ne 0
need "row not in the plan: message" has "$C/ver.err" "chore: cannot read the approved comment of pr#40"
need "row not in the plan: no view of it" hasnt "$GH_LOG" "pr view 40 "
need "row not in the plan: no VERIFY-SUMMARY" hasnt "$C/ver.out" VERIFY-SUMMARY
end

# ---------- chore v4.3 2026-10-21: move-issue rows (a kept GitHub issue → a new ticket in the bound Jira project) ----------
# The engine treats move-issue as a second Jira-helper action (design v9 §6.1): same helper process, same journal, same abort
# and verify paths; the helper's RESULT lines carry the row's own action and that action's classes.
FIXMV="$FIXV4/move"
add_move() { # append move/valid.tsv's move-issue rows: issue#11 (new ticket), issue#12 (adopt TST-120), issue#13 (adopt + prior)
  awk -F'\t' 'NR > 1 && $2 == "move-issue"' "$FIXMV/valid.tsv" >> "$C/plan.tsv"; }
mline() { printf 'RESULT\t%s\tmove-issue\t%s\t%s\tattempt=%s\n' "$1" "$2" "$3" "$4"; }   # status ref reason attempt
MVOUT='RESULT\tOK\tmove-issue\tissue#11\tmoved: TST-501\tattempt=@A@\nRESULT\tOK\tmove-issue\tissue#12\talready-done: TST-120\tattempt=@A@\nRESULT\tSKIP\tmove-issue\tissue#13\tchanged: 티켓 TST-130 있음, 이슈가 승인 뒤 바뀜 — 닫지 않음\tattempt=@A@\n'

begin "117 v4.3 a plan whose only Jira-helper rows are move-issue rows: the helper starts once, its move-issue lines are taken byte-for-byte and recorded under move-issue (no 'no result line' die, nothing settled twice), counters, SUMMARY" std
rep; add_move; jstub
printf "$MVOUT" > "$C/jout"
JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
A=$(sumf attempt)
need "rc=$RC $(head -c 300 "$C/app.err")" rc 0
need "fixture rows appended" test "$(grep -c "$(printf '\t')move-issue$(printf '\t')" "$C/plan.tsv")" = 3
need "helper called once with apply-rows" test "$(grep -c '^CMD apply-rows' "$C/jstub.log")" = 1
need "--attempt = SUMMARY attempt" test "$(argval --attempt)" = "$A"
need "--journal" test "$(argval --journal)" = "$(gcd)/chore/$(runid).journal"
sed "s/@A@/$A/g" "$C/jout" > "$C/jout.want"
need "line 1 byte-for-byte" hasx "$C/app.out" "$(sed -n 1p "$C/jout.want")"
need "line 2 byte-for-byte" hasx "$C/app.out" "$(sed -n 2p "$C/jout.want")"
need "line 3 byte-for-byte" hasx "$C/app.out" "$(sed -n 3p "$C/jout.want")"
need "one RESULT per move row" test "$(nres issue#11)$(nres issue#12)$(nres issue#13)" = 111
need "no jira-transition line" noresult jira-transition
need "SUMMARY counts the move lines (3 deletes + 2 OK, 1 SKIP)" has "$C/app.out" "SUMMARY$(printf '\t')ok=5$(printf '\t')skip=1$(printf '\t')fail=0$(printf '\t')unknown=0$(printf '\t')run_id=$(runid)$(printf '\t')attempt=$A$(printf '\t')scope=full"
need "order: jira finished before the first push" test "$(evpos jira-exit)" -lt "$(evpos push)"
need "remote stage ran" bare_lacks feat/merged
need "RESULT columns: 6 for move-issue" cols_ok
end

begin "118 v4.3 the line check is per action: every move-issue class is taken; a jira-transition class on a move-issue row, UNKNOWN with a move-issue class, or the row under another action is refused" std
rep; add_move; jstub; cp "$C/plan.tsv" "$C/plan.orig"
k=0
while IFS='|' read -r l1 l2 l3 want; do
  k=$((k+1)); printf 'RESULT\t%s\tmove-issue\tissue#11\t%s\tattempt=@A@\nRESULT\t%s\tmove-issue\tissue#12\t%s\tattempt=@A@\nRESULT\t%s\tmove-issue\tissue#13\t%s\tattempt=@A@\n' \
    "${l1%% *}" "${l1#* }" "${l2%% *}" "${l2#* }" "${l3%% *}" "${l3#* }" > "$C/jout"
  JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
  A=$(sumf attempt); sed "s/@A@/$A/g" "$C/jout" > "$C/jout.want"
  need "[ok $k] rc=$RC (want $want) $(head -c 200 "$C/app.err")" rc "$want"
  need "[ok $k] SUMMARY, no ABORTED" sh -c "grep -q '^SUMMARY' '$C/app.out' && ! grep -q '^ABORTED' '$C/app.out'"
  need "[ok $k] all three taken" sh -c "grep -qxF -- \"\$(sed -n 1p '$C/jout.want')\" '$C/app.out' && grep -qxF -- \"\$(sed -n 2p '$C/jout.want')\" '$C/app.out' && grep -qxF -- \"\$(sed -n 3p '$C/jout.want')\" '$C/app.out'"
done <<'GOOD'
OK moved: TST-501|OK already-done: TST-120|SKIP account: Jira 계정이 승인본과 다름|0
SKIP changed: 이슈가 승인 뒤 바뀜|SKIP manual: 댓글 결과 미확정 — resolve|SKIP exists: 이 이슈를 가리키는 티켓이 이미 있음|0
SKIP type: 필수 필드 있음|FAIL create-rejected: 401|FAIL comment-failed: 응답 본문이 다름|1
FAIL close-failed: 아직 OPEN|UNKNOWN 보냈지만 결과 모름|UNKNOWN identity: a jira-transition class is free text here|1
GOOD
while IFS='|' read -r what line; do
  printf '%b' "$line" > "$C/jout"
  JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
  A=$(sumf attempt)
  need "[$what] rc=$RC" rc 1
  need "[$what] message" has "$C/app.err" "Jira 단계 출력 형식 오류 (줄 1)"
  need "[$what] the bad line is not printed" hasnt "$C/app.out" "x-bad"
  need "[$what] the bad line is reported on stderr" has "$C/app.err" "x-bad"
  need "[$what] the row settles NOT-ATTEMPTED under move-issue" hasx "$C/app.out" "$(mline NOT-ATTEMPTED issue#11 "run aborted at jira" "$A")"
  need "[$what] one RESULT for the row" test "$(nres issue#11)" = 1
  need "[$what] RESULT columns" cols_ok
done <<'BAD'
jira SKIP class|RESULT\tSKIP\tmove-issue\tissue#11\tidentity: x-bad\tattempt=@A@\n
jira FAIL class|RESULT\tFAIL\tmove-issue\tissue#11\tcomment-rejected: x-bad\tattempt=@A@\n
jira OK-only reading of SKIP|RESULT\tSKIP\tmove-issue\tissue#11\ttransition: x-bad\tattempt=@A@\n
UNKNOWN with a move class|RESULT\tUNKNOWN\tmove-issue\tissue#11\texists: x-bad\tattempt=@A@\n
move row under jira-transition|RESULT\tOK\tjira-transition\tissue#11\tmoved: x-bad\tattempt=@A@\n
unknown action|RESULT\tOK\tmove-issues\tissue#11\tmoved: x-bad\tattempt=@A@\n
BAD
end

begin "119 v4.3 abort with mv- journal lines (helper exit 6) in a plan with both Jira-helper actions: each row settles under its own action — a mv-create-sent of this attempt → UNKNOWN, sent + withdrawn → NOT-ATTEMPTED, a decided row keeps its line" std
rep; add_jira; add_move; jstub
printf 'RESULT\tOK\tmove-issue\tissue#11\tmoved: TST-501\tattempt=@A@\n' > "$C/jout"
# journal lines in the k=v shape chore-jira.py (U3) writes: sent = seq= acct= (seq = the send's number within the attempt,
# distinct per send), results / withdrawn = sid=<run_id>/<attempt>/<seq> of that very send
ACC=712020:00000000-0000-0000-0000-000000000001
printf '%s\n' "2026-10-21T00:00:00.500Z @A@ issue#11 mv-create-sent seq=1 acct=$ACC" \
  "2026-10-21T00:00:00.900Z @A@ issue#11 mv-create-ok sid=$(runid)/@A@/1 key=TST-501" \
  "2026-10-21T00:00:01.000Z @A@ issue#12 mv-create-sent seq=2 acct=$ACC" \
  "2026-10-21T00:00:02.000Z @A@ issue#13 mv-create-sent seq=3 acct=$ACC" \
  "2026-10-21T00:00:02.100Z @A@ issue#13 mv-create-withdrawn sid=$(runid)/@A@/3" \
  "2026-10-21T00:00:03.000Z @A@ jira#TST-101 comment-sent" \
  "2026-10-21T00:00:04.000Z 20261021T000000Z-00000000 issue#13 mv-create-sent seq=1 acct=$ACC" > "$C/jrn"
JSTUB_OUT="$C/jout" JSTUB_JOURNAL="$C/jrn" JSTUB_RC=6 appbg --tiers 2 --yes
A=$(sumf attempt)
eval "$(sed -n "/^P_JOURNALED='\$/,/'\$/p" "$ENGINE")"
JF="$(gcd)/chore/$(runid).journal"
need "the journal the engine read has the k=v lines" test "$(grep -cE ' mv-create-[a-z]+ (seq|sid)=' "$JF")" = 6
need "a journal the writer could emit: seq distinct per send within this attempt, every sid names a send of the same ref and attempt" \
  sh -c "awk -v a='$A' -v run='$(runid)' '\$2 == a && \$4 ~ /^mv-.*-sent\$/ { for (i = 5; i <= NF; i++) if (\$i ~ /^seq=/) { q = substr(\$i, 5); if (q in seen) bad = 1; seen[q] = 1; ref[q] = \$3 } }
    \$2 == a && \$4 ~ /^mv-.*-(ok|withdrawn)\$/ { for (i = 5; i <= NF; i++) if (\$i ~ /^sid=/) { n = split(substr(\$i, 5), f, \"/\"); if (n != 3 || f[1] != run || f[2] != a || ref[f[3]] != \$3) bad = 1; nsid++ } }
    END { exit (bad || nsid != 2 || length(seen) != 3) }' '$JF'"
need "engine journal count on these line shapes: sent+ok and sent are writes, sent+withdrawn is none, another attempt is not this one" \
  test "$(CH_AT="$A" awk -v n="$(tr -cd '\n' < "$JF" | wc -l | tr -d ' ')" "$P_JOURNALED" "$JF" | sort | tr '\n' ' ')" = "issue#11 issue#12 jira#TST-101 "
need "rc=$RC" rc 1
need "message" has "$C/app.err" "Jira 읽기 실패 — 잠시 뒤 같은 명령으로 다시 실행"
need "issue#11 keeps the helper's line (one line)" test "$(nres issue#11):$(grep -cxF -- "$(mline OK issue#11 "moved: TST-501" "$A")" "$C/app.out")" = "1:1"
need "issue#12 UNKNOWN under move-issue" hasx "$C/app.out" "$(mline UNKNOWN issue#12 "journal has a write of this attempt, outcome unread (run aborted at jira)" "$A")"
need "issue#13 NOT-ATTEMPTED under move-issue (another attempt's sent does not count)" hasx "$C/app.out" "$(mline NOT-ATTEMPTED issue#13 "run aborted at jira" "$A")"
need "jira#TST-101 UNKNOWN under jira-transition" hasx "$C/app.out" "$(jline UNKNOWN jira#TST-101 "journal has a write of this attempt, outcome unread (run aborted at jira)" "$A")"
need "jira#TST-102 NOT-ATTEMPTED under jira-transition" hasx "$C/app.out" "$(jline NOT-ATTEMPTED jira#TST-102 "run aborted at jira" "$A")"
need "no move row under jira-transition" sh -c "! grep -q 'jira-transition$(printf '\t')issue#' '$C/app.out'"
need "ABORTED counts" has "$C/app.out" "ok=1$(printf '\t')skip=0$(printf '\t')fail=0$(printf '\t')unknown=2$(printf '\t')unattempted=5$(printf '\t')"
need "remote stage not run" bare_has feat/merged
need "RESULT columns" cols_ok
newcase std-mv-unreadable; rep; add_move; jstub
JSTUB_JMODE=dir JSTUB_RC=6 appbg --tiers 2 --yes
A=$(sumf attempt)
need "unreadable journal: every move row UNKNOWN" sh -c "test \"\$(grep -c '^RESULT$(printf '\t')UNKNOWN$(printf '\t')move-issue$(printf '\t')issue#1[123]$(printf '\t')journal unreadable at abort (run aborted at jira)$(printf '\t')attempt=$A\$' '$C/app.out')\" = 3"
end

begin "120 v4.3 helper exit 9 (the C1 breaker) on a move-only plan → its die message (ABORTED), remote stage not run" std
rep; add_move; jstub
JSTUB_RC=9 appbg --tiers 2 --yes
need "rc=$RC" rc 1
need "message" has "$C/app.err" "chore: Jira 단계가 차단기로 멈춤 — 원인을 고치기 전에는 다시 실행하지 않음"
need "ABORTED reason" has "$C/app.out" "reason=Jira 단계가 차단기로 멈춤 — 원인을 고치기 전에는 다시 실행하지 않음$(printf '\t')attempt="
need "old wording gone" hasnt "$C/app.err" "연속 실패"
need "remote stage not run" bare_has feat/merged
end

begin "121 v4.3 --only-group move / jira die with move-issue rows (and move with jira-transition rows only); a branch group literally named move stays selectable without Jira-helper rows" std
bare_set move "$A1"
jq --arg o "$A1" --arg m "$M1" '. + [{number: 96, state: "MERGED", headRefName: "move", headRefOid: $o, baseRefName: "develop", isCrossRepository: false,
  headRepositoryOwner: {login: "test"}, headRepository: {name: "repo"}, author: {login: "dev9"}, updatedAt: "2026-10-01T00:00:00Z",
  title: "PR move", mergeCommit: {oid: $m}}]' "$GH_FIX/prs.json" > "$C/p.json" && mv "$C/p.json" "$GH_FIX/prs.json"
rep
need "branch move planned in group move" jrow move '.action == "delete-remote" and .group == "move"'
cp "$C/plan.tsv" "$C/plan.v3"
app --tiers 2 --yes --only-group move
need "no Jira-helper rows: rc=$RC" rc 0
need "no Jira-helper rows: the branch group runs" res OK delete-remote move
cp "$C/plan.v3" "$C/plan.tsv"; add_move; jstub
for g in move jira; do
  app --tiers 2 --yes --only-group "$g"
  need "move rows, --only-group $g: rc=$RC" rc 1
  need "move rows, --only-group $g: message" has "$C/app.err" "Jira 행은 --only-group 없이 전체 실행에서만 처리됩니다"
  need "move rows, --only-group $g: helper never started" test ! -e "$C/jstub.log"
done
cp "$C/plan.v3" "$C/plan.tsv"; add_jira
app --tiers 2 --yes --only-group move
need "jira-transition rows only, --only-group move: rc=$RC" rc 1
need "jira-transition rows only: message" has "$C/app.err" "Jira 행은 --only-group 없이 전체 실행에서만 처리됩니다"
cp "$C/plan.v3" "$C/plan.tsv"; add_move
app --tiers 1
need "--tiers 1 with move rows dies (rc=$RC)" has "$C/app.err" "Jira 행이 있는 계획은 --tiers에 2를 넣어야 합니다"
end

begin "122 v4.3 verify with move-issue rows: verify-rows lines keyed on (action, ref) join the totals; move rows never reach the generic last-result loop; a VERIFY line whose action is not the row's own, or a missing row, dies" std
rep; add_jira; add_move; jstub
printf "$MVOUT" > "$C/jout"
printf 'RESULT\tOK\tjira-transition\tjira#TST-101\tmoved: 옮김\tattempt=@A@\nRESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 바뀜\tattempt=@A@\n' >> "$C/jout"
JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
need "apply rc=$RC $(head -c 200 "$C/app.err")" rc 0
: > "$C/jstub.log"
printf 'VERIFY\tOK\tjira-transition\tjira#TST-101\tj1\nVERIFY\tRESOLVED\tjira-transition\tjira#TST-102\tj2\nVERIFY\tOK\tmove-issue\tissue#11\tm1\nVERIFY\tWARN\tmove-issue\tissue#12\tm2\nVERIFY\tUNRESOLVED\tmove-issue\tissue#13\tm3\n' > "$C/vout"
JSTUB_VOUT="$C/vout" ver
need "verify rc=$RC (unresolved → 1)" rc 1
need "summary" has "$C/ver.out" "VERIFY-SUMMARY$(printf '\t')fail=0$(printf '\t')warn=1$(printf '\t')unresolved=1$(printf '\t')run=complete$(printf '\t')success=no"
for i in 1 2 3 4 5; do need "line $i verbatim" hasx "$C/ver.out" "$(sed -n ${i}p "$C/vout")"; done
need "no generic verdict for a move row" test "$(grep -c "$(printf '\t')move-issue$(printf '\t')" "$C/ver.out")" = 3
need "verify-rows called" test "$(grep -c '^CMD verify-rows' "$C/jstub.log")" = 1
printf 'VERIFY\tOK\tjira-transition\tjira#TST-101\tj1\nVERIFY\tOK\tjira-transition\tjira#TST-102\tj2\nVERIFY\tOK\tjira-transition\tissue#11\tm1\nVERIFY\tOK\tmove-issue\tissue#12\tm2\nVERIFY\tOK\tmove-issue\tissue#13\tm3\n' > "$C/vout"
JSTUB_VOUT="$C/vout" ver
need "a move row answered under jira-transition dies (rc=$RC)" rc 1
need "its line" has "$C/ver.err" "Jira 확인 출력 형식 오류: line 3"
printf 'VERIFY\tOK\tjira-transition\tjira#TST-101\tj1\nVERIFY\tOK\tjira-transition\tjira#TST-102\tj2\nVERIFY\tOK\tmove-issue\tjira#TST-101\tm\n' > "$C/vout"
JSTUB_VOUT="$C/vout" ver
need "a jira row answered under move-issue dies (rc=$RC)" has "$C/ver.err" "Jira 확인 출력 형식 오류: line 3"
printf 'VERIFY\tOK\tjira-transition\tjira#TST-101\tj1\nVERIFY\tOK\tjira-transition\tjira#TST-102\tj2\nVERIFY\tOK\tmove-issue\tissue#11\tm1\nVERIFY\tOK\tmove-issue\tissue#12\tm2\n' > "$C/vout"
JSTUB_VOUT="$C/vout" ver
need "a missing move row dies (rc=$RC)" has "$C/ver.err" "Jira 확인 출력 형식 오류: 4 of 5 Jira rows answered"
printf 'VERIFY\tOK\tjira-transition\tjira#TST-101\tj1\nVERIFY\tOK\tjira-transition\tjira#TST-102\tj2\nVERIFY\tOK\tmove-issue\tissue#11\tm1\nVERIFY\tOK\tmove-issue\tissue#11\tm1\nVERIFY\tOK\tmove-issue\tissue#13\tm3\n' > "$C/vout"
JSTUB_VOUT="$C/vout" ver
need "a row answered twice dies (rc=$RC)" has "$C/ver.err" "Jira 확인 출력 형식 오류: line 4"
newcase std-mv-only-verify; rep; add_move; jstub
printf "$MVOUT" > "$C/jout"; JSTUB_OUT="$C/jout" appbg --tiers 2 --yes
printf 'VERIFY\tOK\tmove-issue\tissue#11\tm1\nVERIFY\tOK\tmove-issue\tissue#12\tm2\nVERIFY\tRESOLVED\tmove-issue\tissue#13\tm3\n' > "$C/vout"
: > "$C/jstub.log"; JSTUB_VOUT="$C/vout" ver
need "move-only plan: verify-rows called (rc=$RC)" test "$(grep -c '^CMD verify-rows' "$C/jstub.log")" = 1
need "move-only plan: success" has "$C/ver.out" "unresolved=0$(printf '\t')run=complete$(printf '\t')success=yes"
end

begin "123 v4.3 verify_ok_row checks every action it can get: worktree-prune OK = nothing to check (as before); an OK row of an action without a check dies instead of reading as OK" std
rep
printf 'RESULT\tOK\tworktree-prune\t.\tpruned\nSUMMARY\tok=1\tskip=0\tfail=0\tunknown=0\trun_id=%s\n' "$(runid)" > "$C/r.out"
ver "$C/r.out"
need "worktree-prune: rc=$RC" rc 0
need "worktree-prune: nothing to check" hasx "$C/ver.out" "$(printf 'VERIFY\tOK\tworktree-prune\t.\tnothing to check')"
for a in report frobnicate; do
  printf 'RESULT\tOK\t%s\tissue#20\tx\nSUMMARY\tok=1\tskip=0\tfail=0\tunknown=0\trun_id=%s\n' "$a" "$(runid)" > "$C/r.out"
  ver "$C/r.out"
  need "OK $a: dies (rc=$RC)" rc 1
  need "OK $a: message" has "$C/ver.err" "chore: results: no OK check for action $a (issue#20)"
  need "OK $a: never OK" hasnt "$C/ver.out" "$(printf 'VERIFY\tOK\t%s' "$a")"
  need "OK $a: no VERIFY-SUMMARY" hasnt "$C/ver.out" VERIFY-SUMMARY
done
end

begin "124 v4.3 check-plan on fixtures/chore-v4/move: valid accepted (awk alone too); every invalid refused with chore_plan.py's message; awk alone refuses tier / ref / key-set / same-target faults; apply refuses a bad move row before acting" std
"$SH" "$ENGINE" check-plan --plan "$FIXMV/valid.tsv" > "$C/cp.out" 2> "$C/cp.err"; RC=$?
need "move/valid.tsv accepted (rc=$RC $(head -c 200 "$C/cp.err"))" rc 0
need "move/valid.tsv silent" test ! -s "$C/cp.err" -a ! -s "$C/cp.out"
CHORE_PLAN_PY="$W/bin/plan-ok.py" "$SH" "$ENGINE" check-plan --plan "$FIXMV/valid.tsv" > /dev/null 2> "$C/cp.err"; RC=$?
need "awk alone accepts move/valid.tsv (rc=$RC $(head -c 200 "$C/cp.err"))" rc 0
k=0
for f in "$FIXMV"/invalid/*.tsv; do
  k=$((k+1)); b=$(basename "$f"); want=$(jq -r --arg k "$b" '.[$k] // empty' "$FIXMV/expected.json")
  "$SH" "$ENGINE" check-plan --plan "$f" > /dev/null 2> "$C/cp.err"; RC=$?
  need "$b refused (rc=$RC)" rc 1
  need "$b one stderr line" test "$(wc -l < "$C/cp.err" | tr -d ' ')" = 1
  need "$b = chore_plan.py's message" sh -c "test -n \"\$1\" && grep -q '^chore: plan rejected: line ' '$C/cp.err' && grep -qF -- \"\$1\" '$C/cp.err'" _ "$want"
done
need "every move/invalid case ran ($k)" test "$k" -ge 39
while IFS='|' read -r b msg; do
  CHORE_PLAN_PY="$W/bin/plan-ok.py" "$SH" "$ENGINE" check-plan --plan "$FIXMV/invalid/$b" > /dev/null 2> "$C/cp.err"; RC=$?
  need "awk alone refuses $b (rc=$RC)" rc 1
  need "awk alone: $b message" has "$C/cp.err" "$msg"
done <<'AWK'
mv-tier3.tsv|action move-issue not allowed in tier 3
mv-ref-shape.tsv|move-issue ref must be issue#N
mv-snap-missing-key.tsv|snapshot key prior missing for move-issue
mv-snap-extra-key.tsv|snapshot key base not allowed for move-issue
mv-close-twin.tsv|close-issue issue#11 and line 2 name the same target — one target, two states
mv-kept-twin.tsv|move-issue issue#11 is also listed as kept (line 7) — one target, two states
AWK
rep; add_move; jstub
edit_plan '$3 == "issue#11" && $2 == "move-issue" { sub(/;prior=-/, ";prior=4001%3A" sprintf("%064d", 0), $5) } { print }'
app --tiers 2 --yes
need "apply refuses a bad move row (rc=$RC)" rc 1
need "with chore_plan.py's message" has "$C/app.err" "chore: plan rejected: line"
need "prior message" has "$C/app.err" "move-issue snapshot prior needs adopt"
need "helper never started" test ! -e "$C/jstub.log"
need "nothing pushed" bare_has feat/merged
end

# ---------- the registry (CHORE_REPOS_MD): required, and its own work tree is never a target (2026-10-27) ----------
# noreg <value|unset> <engine args…>: the engine with CHORE_REPOS_MD unset or set to <value>, in a subshell (the case's
# export stays), a git that logs every call ($C/git-all.log) first on PATH; gh calls land in $GH_LOG as everywhere.
# stdin = /dev/null: an engine that read the registry from an empty path (awk with "" reads stdin) fails here, never hangs
noreg() { ( if [ "$1" = unset ]; then unset CHORE_REPOS_MD; else export CHORE_REPOS_MD="$1"; fi; shift
            PATH="$C/allbin:$PATH" "$SH" "$ENGINE" "$@" < /dev/null > "$C/nr.out" 2> "$C/nr.err" ); RC=$?; }
begin "125 CHORE_REPOS_MD unset / empty / missing / a directory / unreadable → report, apply and verify stop with a usage error naming it before any gh or git call; an unknown command still says so; check-plan and the codec need no registry" std
mkdir -p "$C/allbin" "$C/adir"
printf '#!%s\nREAL=%s\nLOG=%s\n' "$SH" "$REAL_GIT" "$C/git-all.log" > "$C/allbin/git"
cat >> "$C/allbin/git" <<'WRAP'
printf '%s\n' "$*" >> "$LOG"
exec "$REAL" "$@"
WRAP
chmod +x "$C/allbin/git"
rep; need "fixture report rc=$RC" rc 0                  # a real plan for check-plan below
D=$(dg "$C/plan.tsv")
printf 'x\n' > "$C/unread.md"; chmod 000 "$C/unread.md"
HOWS=(unset "" "$C/missing.md" "$C/adir")
if [ ! -r "$C/unread.md" ]; then HOWS+=("$C/unread.md"); fi   # as root every file reads: that variant cannot be made
for how in "${HOWS[@]}"; do
  case "$how" in unset) lb=unset; want="chore: usage: CHORE_REPOS_MD is not set" ;; "") lb=empty; want="chore: usage: CHORE_REPOS_MD is not set" ;;
                 *) lb="${how##*/}"; want="chore: usage: CHORE_REPOS_MD=$how is not a readable file" ;; esac
  for cmd in report apply verify; do
    : > "$GH_LOG"; : > "$C/git-all.log"
    case "$cmd" in
      report) noreg "$how" report t --plan "$C/np.tsv" --json "$C/np.json" ;;
      apply) noreg "$how" apply t --plan "$C/plan.tsv" --digest "$D" --tiers 1,2 --yes ;;
      verify) noreg "$how" verify t --plan "$C/plan.tsv" --results "$C/plan.tsv" --digest "$D" ;;
    esac
    need "$lb $cmd: rc=$RC" rc 1
    need "$lb $cmd: usage error naming CHORE_REPOS_MD ($(head -c 200 "$C/nr.err"))" has "$C/nr.err" "$want"
    need "$lb $cmd: one stderr line" test "$(wc -l < "$C/nr.err" | tr -d ' ')" = 1
    need "$lb $cmd: no stdout" test ! -s "$C/nr.out"
    need "$lb $cmd: no gh call" test ! -s "$GH_LOG"
    need "$lb $cmd: no git call" test ! -s "$C/git-all.log"
  done
done
need "report wrote no plan" test ! -e "$C/np.tsv"
need "nothing deleted" bare_has feat/merged
chmod 600 "$C/unread.md"
noreg unset bogus t --plan "$C/plan.tsv"
need "unknown command: rc=$RC" rc 1
need "unknown command named, not the registry" sh -c "grep -qxF 'chore: unknown command bogus' '$C/nr.err'"
noreg unset check-plan --plan "$C/plan.tsv"
need "check-plan without a registry: rc=$RC $(head -c 200 "$C/nr.err")" rc 0
( unset CHORE_REPOS_MD; printf 'a;b' | "$SH" "$ENGINE" penc > "$C/penc.out" 2>&1 ); RC=$?
need "penc without a registry: rc=$RC" rc 0
need "penc output" test "$(cat "$C/penc.out")" = "a%3Bb"
end

begin "126 the registry's own work tree is refused (registry in a subdirectory of the clone; the row or the registry path through a directory symlink, or the registry path itself a file symlink (its directory in no work tree or in another one)) for report, apply and verify before any gh call; a registry in another git work tree or in none → no refusal" std
mkdir -p "$C/work/reg"; ln -s "$C/work" "$C/wlink"
printf '| repo | local path | remote | note |\n|---|---|---|---|\n| `t` | `%s` | `test/repo` | test |\n' "$C/wlink" > "$C/work/reg/repos.md"
export CHORE_REPOS_MD="$C/work/reg/repos.md"
rep
need "report refused: rc=$RC" rc 1
need "report: message ($(head -c 200 "$C/rep.err"))" has "$C/rep.err" "chore: refusing to run on the registry's own repository"
need "report: no plan written" test ! -e "$C/plan.tsv"
"$SH" "$ENGINE" apply t --plan "$C/none.tsv" --digest 0 --tiers 1,2 --yes > "$C/app.out" 2> "$C/app.err"; RC=$?
need "apply refused: rc=$RC" rc 1
need "apply: message ($(head -c 200 "$C/app.err"))" has "$C/app.err" "chore: refusing to run on the registry's own repository"
"$SH" "$ENGINE" verify t --plan "$C/none.tsv" --results "$C/none.out" --digest 0 > "$C/ver.out" 2> "$C/ver.err"; RC=$?
need "verify refused: rc=$RC" rc 1
need "verify: message ($(head -c 200 "$C/ver.err"))" has "$C/ver.err" "chore: refusing to run on the registry's own repository"
# the registry path itself through the symlink, the row naming the clone directly
printf '| repo | local path | remote | note |\n|---|---|---|---|\n| `t` | `%s` | `test/repo` | test |\n' "$C/work" > "$C/work/reg/repos.md"
export CHORE_REPOS_MD="$C/wlink/reg/repos.md"
rep
need "symlinked registry path: refused rc=$RC" rc 1
need "symlinked registry path: message" has "$C/rep.err" "chore: refusing to run on the registry's own repository"
# CHORE_REPOS_MD = a file symlink to that registry, the symlink in a directory in no git work tree / in another one
mkdir -p "$C/nowt"; ln -s "$C/work/reg/repos.md" "$C/nowt/repos.md"
need "precondition: the file symlink's directory is in no work tree" sh -c "! git -C '$C/nowt' rev-parse --show-toplevel"
export CHORE_REPOS_MD="$C/nowt/repos.md"
rep
need "file symlink outside any work tree: refused rc=$RC $(head -c 200 "$C/rep.err")" rc 1
need "file symlink outside any work tree: message" has "$C/rep.err" "chore: refusing to run on the registry's own repository"
git init -q "$C/otherwt"; ln -s "$C/work/reg/repos.md" "$C/otherwt/repos.md"
need "precondition: the file symlink's directory is another work tree" test "$(git -C "$C/otherwt" rev-parse --show-toplevel)" = "$C/otherwt"
export CHORE_REPOS_MD="$C/otherwt/repos.md"
rep
need "file symlink in another work tree: refused rc=$RC $(head -c 200 "$C/rep.err")" rc 1
need "file symlink in another work tree: message" has "$C/rep.err" "chore: refusing to run on the registry's own repository"
need "no gh call in any refused run (so no fetch either: it follows repo view)" test ! -s "$GH_LOG"
need "nothing deleted" bare_has feat/merged
newcase std-reg-other                                   # registry in a git work tree that is not the target's clone
git init -q "$C/reg"
printf '| repo | local path | remote | note |\n|---|---|---|---|\n| `t` | `%s` | `test/repo` | test |\n' "$C/work" > "$C/reg/repos.md"
export CHORE_REPOS_MD="$C/reg/repos.md"
need "precondition: the registry is in a work tree" test "$(git -C "$C/reg" rev-parse --show-toplevel)" = "$C/reg"
rep
need "registry in another work tree: report rc=$RC $(head -c 200 "$C/rep.err")" rc 0
need "registry in another work tree: no refusal" hasnt "$C/rep.err" "refusing"
newcase std-reg-none                                    # the standard registry: in no git work tree at all
need "precondition: the registry is in no work tree" sh -c "! git -C '$C' rev-parse --show-toplevel"
rep
need "registry in no work tree: report rc=$RC $(head -c 200 "$C/rep.err")" rc 0
need "registry in no work tree: no refusal" hasnt "$C/rep.err" "refusing"
end

echo "chore.test: $((n-fail))/$n passed"
[ "$fail" -eq 0 ]
