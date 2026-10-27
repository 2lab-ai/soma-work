#!/usr/bin/env bash
# chore-render.test.sh — regression cases for scripts/chore-render.py (chore 계획 시각화, 2026-10-15).
# Fixtures are synthetic and built here in a temp dir (no company repo data). Each case prints one ok/FAIL line.
# Run: /bin/bash __tests__/py/chore-render.test.sh   → exits 0 only when every case passes. PYTHON=… overrides python3,
# RENDER=… another renderer file (e.g. the previous version, to see which cases it fails), ENGINE=… another chore.sh
# (cases 30–31 compare the page's --only-group keys with that engine's grp; they need git-free awk only). Case 52 = move-issue
# rows + --payloads; 52l compares pages without move rows with fixtures/chore-v4/move/render/no-move-*.html.
set -euo pipefail           # setup must not continue on a failed step; each case checks its own results
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # this file is <skill>/__tests__/py/
R="${RENDER:-$SKILL/scripts/chore-render.py}"
ENGINE="${ENGINE:-$SKILL/scripts/chore.sh}"   # cases 30–31 call the engine's own AWK_LIB grp (ENGINE=… another copy)
PY="${PYTHON:-python3}"
URL="https://github.com/test/repo"
RUN="20261015T051233Z-0a1b2c3d"
T=""; cleanup() { [ -n "$T" ] && rm -rf "$T"; }; trap cleanup EXIT
T=$(mktemp -d "${TMPDIR:-/tmp}/chore-render-test.XXXXXX")

OA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; OB=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
OC=cccccccccccccccccccccccccccccccccccccccc; OD=dddddddddddddddddddddddddddddddddddddddd
OE=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee; OM=1111111111111111111111111111111111111111

sha() { { shasum -a 256 "$1" 2>/dev/null || sha256sum "$1"; } | awk '{print $1}'; }
row() { local IFS=$'\t'; printf '%s\n' "$*"; }   # args joined by TAB = one TSV line

# ── plan TSV fixture ────────────────────────────────────────────────────────────────────────────
hdr_fields() {
  printf '%s\n' '#chore-plan v3' 'remote=test/repo' 'origin=git@github.com%3Atest/repo.git' 'repo_id=R_kgDOtest01' \
    'default=develop' 'created=2026-10-15T05%3A12%3A33Z' "run_id=$RUN" 'I=develop,deploy/staging,deploy/stage2,main' \
    "Itips=develop:$OD,deploy/staging:$OB,deploy/stage2:$OB,main:$OC" \
    'P=develop,deploy/staging,deploy/stage2,main,r2s/*,feat/live-work' 'protect=r2s/*' \
    'integrate=deploy/staging,deploy/stage2,main' "no_local=${NO_LOCAL:-1}" "Ptips=develop:$OD,deploy/staging:$OB" \
    'groups=.,PROJ-1234,deploy/*,develop,feat/*,feature/*,fix/*,hotfix/*,issues,main,pull-requests,r2s/*,spike/*,wip/*' "$@"
}
hdr() { hdr_fields "$@" | grep -v "^${DROP:-@@none@@}=" | paste -sd '\t' -; }
D() { # D <ref> <pr> <base> <pr_author> <tip_author> <tip_date> → delete-remote row
  row 2 delete-remote "$1" "$OA" \
    "basis=a;pr=$2;pr_base=$3;pr_head_repo=test/repo;pr_head_oid=$OA;pr_author=$4;tip_author=$5;tip_date=$6;pr_merge_commit=$OM" \
    "PR #$2 merged into $3%3B last commit $6 $5%3B PR by $4"
}
K() { row 3 report "remote:$1" "$OD" "$2" "$3"; }   # K <branch> <snapshot> <evidence> → kept row (engine prefixes remote:)
CMT_ENC='line one%09TAB%0A<script>alert(1)</script> & 100%25 done%0A%0A두 번째 줄 — 확인 부탁드립니다.%0A마지막 줄%3B 끝'
printf 'line one\tTAB\n<script>alert(1)</script> & 100%% done\n\n두 번째 줄 — 확인 부탁드립니다.\n마지막 줄; 끝' > "$T/cmt.txt"
base_rows() {
  D deploy/develop-to-staging-20260401 101 deploy/staging alice alice@example.com 2026-04-01
  D deploy/staging-to-stage2-20260402 102 deploy/stage2 bob carol@example.com 2026-04-02
  D feat/login-form 103 develop alice alice@example.com 2026-05-03
  D feature/search-box 104 develop dave 12345+dave@users.noreply.github.com 2026-05-10
  D feat/upload 105 develop Alice ALICE@Example.com 2026-06-01
  D fix/null-check 106 develop erin erin@example.com 2026-07-01
  D hotfix/prod-crash 107 main erin erin@example.com 2026-07-02
  D PROJ-1234 108 develop frank frank@example.com 2026-08-01
  D wip/scratch 109 develop gina unknown 2026-08-02
  row 2 close-pr 'pr#7' "$OC" \
    "state=OPEN;updated=2026-09-01T03%3A04%3A05Z;head_repo=test/repo;head_ref=feat/old-idea;head_oid=$OC;base=develop;author=erin" \
    "$CMT_ENC"
  row 2 close-issue 'issue#9' '2026-08-01T00:00:00Z' 'state=OPEN;updated=2026-08-01T00%3A00%3A00Z;author=frank' \
    '이 이슈는 PR #120에서 해결되어 닫습니다.%0A다시 필요하면 열어 주세요.'
  K develop 'tip_author=alice@example.com;tip_date=2026-10-14' 'protected (default%2C ruleset#77)'
  K deploy/staging 'tip_author=bob@example.com;tip_date=2026-10-13' 'protected (workflow#deploy-staging.yml%2C --integrate)'
  K deploy/stage2 'tip_author=bob@example.com;tip_date=2026-10-12' 'protected (--integrate%2C workflow#deploy-stage2.yml)'
  K main 'tip_author=erin@example.com;tip_date=2026-09-30' 'protected (workflow#a.yml%2C workflow#b.yml%2C --integrate +1 more)'
  K r2s/candidate-1 'tip_author=hank@example.com;tip_date=2026-01-05' 'protected (--protect)'
  K feat/live-work 'tip_author=gina@example.com;tip_date=2026-10-10;pr=8;pr_state=OPEN;pr_author=gina' 'protected (open-pr-head#8)'
  K legacy/keep 'tip_author=ivy@example.com;tip_date=2025-11-11' 'protected (frozen-list)'
  row 3 report local:develop "$OD" 'tip_author=alice@example.com;tip_date=2026-10-14' 'protected (default)'
  row 3 report local:feat/wip-local "$OD" 'tip_author=alice@example.com;tip_date=2026-10-15' 'checked out in a worktree'
  row 3 report local:feat/held-local "$OD" 'tip_author=alice@example.com;tip_date=2026-10-02;pr=300;pr_state=MERGED;pr_author=alice;pr_base=develop' \
    'local delete held (--no-local)%3B PR #300 merged into develop'
  K odd/branch 'tip_author=ivy@example.com;tip_date=2026-01-01' 'raw engine text xyz'
  K deploy/develop-to-staging-20260301 'tip_author=alice@example.com;tip_date=2026-03-01;pr=88;pr_state=MERGED;pr_author=alice;pr_base=deploy/staging' \
    'PR #88 merge commit is not in deploy/staging history — hold'
  K feat/old-split 'tip_author=dave@example.com;tip_date=2026-02-02' 'contained in develop — hold (no exact merged PR)'
  K spike/idea 'tip_author=zed@example.com;tip_date=2025-12-01' "${EV_STALE:-last commit 2025-12-01%2C no merged PR}"
  K fix/same-tip 'tip_author=erin@example.com;tip_date=2026-10-14;pr=111;pr_state=MERGED;pr_author=erin' 'same commit as develop tip — hold'
  row 3 report 'pr#8' "$OE" \
    "state=OPEN;updated=2026-09-20T01%3A02%3A03Z;head_repo=test/repo;head_ref=feat/live-work;head_oid=$OE;base=develop;author=gina" \
    'Add live work dashboard'
  row 3 report 'issue#10' '2026-09-21T01:02:03Z' 'state=OPEN;updated=2026-09-21T01%3A02%3A03Z;author=hank' '로그인 화면 오타'
  row 3 report . - - 'git worktree prune held (--no-local)'
}

# ── engine JSON fixture (decoded values; snapshot omitted — the renderer reads classification only) ─
J() { # J <tier> <action> <ref> <reason> <protected_by> <evidence> [group]
  printf '{"tier":%s,"action":"%s","ref":"%s","expected":"","snapshot":{},"evidence":"%s","group":"%s","reason":"%s","protected_by":"%s"}\n' \
    "$1" "$2" "$3" "$6" "${7:-}" "$4" "$5"
}
base_jrows() {
  local r
  for r in deploy/develop-to-staging-20260401 deploy/staging-to-stage2-20260402 feat/login-form feature/search-box feat/upload \
           fix/null-check hotfix/prod-crash PROJ-1234 wip/scratch; do J 2 delete-remote "$r" merged-pr "" "x"; done
  J 3 report 'pr#7' open-pr "" 'Old idea: experimental search' pull-requests
  J 3 report 'issue#9' open-issue "" '검색 결과가 비어 있음' issues
  J 3 report remote:develop protected 'default, ruleset#77' x
  J 3 report remote:deploy/staging protected 'workflow#deploy-staging.yml, --integrate' x
  J 3 report remote:deploy/stage2 protected '--integrate, workflow#deploy-stage2.yml' x
  J 3 report remote:main protected 'workflow#a.yml, workflow#b.yml, --integrate +1 more' x
  J 3 report remote:r2s/candidate-1 protected --protect x
  J 3 report remote:feat/live-work protected open-pr-head#8 x
  J 3 report remote:legacy/keep protected frozen-list x
  J 3 report local:develop protected default x
  J 3 report local:feat/wip-local checked-out "" x
  J 3 report local:feat/held-local local-held "" x
  J 3 report remote:odd/branch future-reason "" x
  J 3 report remote:deploy/develop-to-staging-20260301 merge-not-in-base "" x
  J 3 report remote:feat/old-split contained-hold "" x
  J 3 report remote:spike/idea stale "" x
  J 3 report remote:fix/same-tip same-as-integration-tip "" x
  J 3 report 'pr#8' open-pr "" x
  J 3 report 'issue#10' open-issue "" x
  J 3 report . local-held "" worktree
}
Z64=0000000000000000000000000000000000000000000000000000000000000000
json() { # json <plan_sha256 | x = a sha that is not this plan's> <row-producing function> [extra row json lines...]
  local s="$1" fn="$2"; shift 2; [ "$s" = x ] && s=$Z64
  printf '{"plan_sha256":"%s","header":{"remote":"test/repo","run_id":"%s","default":"develop","no_local":true},"rows":[' "$s" "${JRUN:-$RUN}"
  { "$fn"; for x in "$@"; do printf '%s\n' "$x"; done; } | paste -sd, - | tr -d '\n'
  printf ']}\n'
}
render() { # render <dir> [extra args] — writes out.html, records rc in $rc
  "$PY" -I "$R" --plan "$1/plan.tsv" --json "$1/plan.json" --out "$1/out.html" --repo-url "$URL" "${@:2}" \
    >"$1/stdout" 2>"$1/stderr"
}
mk() { mkdir -p "$T/$1"; printf '%s' "$T/$1"; }
u8f() { # u8f <plan.tsv>: rewrite %80–%FF escapes as the raw bytes, in place — the form the engine writes (it never
  # percent-encodes a byte >= 0x80), so this file can spell hidden characters as %XX and still hold none raw
  "$PY" -I -c 'import re, sys
p = sys.argv[1]; b = open(p, "rb").read()
open(p, "wb").write(re.sub(rb"%([89A-F][0-9A-F])", lambda m: bytes([int(m.group(1), 16)]), b))' "$1"; }

set +e                       # from here on every case records its own outcome
# pipefail stays on: a reader that stops early (grep -q) can SIGPIPE its writer and fail a pipeline whose match succeeded
# (case 43j flaked so, 2026-10-23) — after a pipe, grep reads everything: `| grep >/dev/null -F …`, never `| grep -q`
fail=0; n=0
ok()  { n=$((n+1)); printf 'ok   %s\n' "$1"; }
bad() { n=$((n+1)); fail=$((fail+1)); printf 'FAIL %s :: %s\n' "$1" "$2"; }
must_fail() { # must_fail <name> <dir> <stderr-substring> [extra render args…]
  render "$2" "${@:4}"; local rc=$?
  if [ "$rc" = 0 ]; then bad "$1" "exit 0, expected non-zero"
  elif [ -e "$2/out.html" ]; then bad "$1" "rc=$rc but out.html was written"
  elif ! grep -qF -- "$3" "$2/stderr"; then bad "$1" "rc=$rc, stderr lacks '$3': $(head -c 160 "$2/stderr")"
  else ok "$1 (rc=$rc: $(head -c 90 "$2/stderr"))"; fi
}

cat > "$T/complete.py" <<'PY'
import collections, html.parser, re, sys, unicodedata, urllib.parse
DI = ((0xAD, 0xAD), (0x34F, 0x34F), (0x61C, 0x61C), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F), (0x200B, 0x200F),
      (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0),
      (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF), (0x80, 0x9F), (0x2800, 0x2800))
def reveal(s):
    out = ""
    for c in s:
        o, cat = ord(c), unicodedata.category(c)
        hid = c not in "\t\n" and (any(a <= o <= b for a, b in DI) or cat in ("Cc", "Cf", "Zl", "Zp", "Co", "Cn", "Cs")
                                      or (cat == "Zs" and c != " "))   # tab/newline stay as text (comments keep them)
        out += "{hid:U+%04X}" % o if hid else c
    return out
if sys.argv[1] == "--page-marks":
    # the page's own record: distinct .hid marks in the body vs the legend list (exact meaning of "N종")
    h = open(sys.argv[2], encoding="utf-8").read()
    legend = re.search(r'id="hid-kinds">(\d+)</b>종: ([^<]*)</p>', h)
    marks = sorted(set(re.findall(r'<span class="hid"[^>]*>(U\+[0-9A-F]+)</span>', h)), key=lambda c: int(c[2:], 16))
    shown = legend.group(2).split(", ") if legend else []
    ok = (legend is None and not marks) or (legend and int(legend.group(1)) == len(marks) and shown == marks)
    print("marks=%d legend=%s" % (len(marks), legend.group(1) if legend else "none"))
    sys.exit(0 if ok else 1)
if sys.argv[1] == "--facts":
    # fixture facts the page must report, derived from the inputs alone (plan TSV + engine JSON): distinct hidden
    # characters in every field the page prints, and the number of branch names outside A-Za-z0-9._/#:+-.
    # Printed fields: header remote · created · run_id · I (= default ∪ integrate) · protect; per row the name and
    # the snapshot keys the page shows for that row; close comments and PR/issue titles; JSON protection sources of
    # protected rows and refs of rows the review removed. Not printed (so not counted): P, Ptips, origin, groups,
    # repo_id, expected, branch-row evidence, head_* keys.
    lines = open(sys.argv[2], encoding="utf-8").read().split("\n")
    jrows = []
    if len(sys.argv) > 3:
        import json
        jrows = json.load(open(sys.argv[3], encoding="utf-8"))["rows"]
    jidx = {(j["action"], j["ref"]): j for j in jrows}
    used = set()
    hdr = {}
    for f in lines[0].split("\t")[1:]:
        k, v = f.split("=", 1)
        hdr[k] = [urllib.parse.unquote(x.split(":", 1)[0] if k in ("Itips", "Ptips") else x) for x in v.split(",")] if v else []
    shown = []
    for k in ("remote", "created", "run_id", "I", "protect"):
        shown += hdr[k]
    remote = "".join(hdr["remote"]).lower()
    odd = 0
    ROW_KEYS = {"delete-remote": ("pr", "pr_author", "tip_author", "tip_date", "pr_base"),
                "report": ("tip_date", "tip_author", "pr", "pr_state", "author", "updated", "pr_base"),
                "close-pr": ("author", "updated"), "close-issue": ("author", "updated")}
    for line in lines[1:]:
        if not line:
            continue
        col = line.split("\t")
        action, ref, ev = col[1], urllib.parse.unquote(col[2]), urllib.parse.unquote(col[5])
        snap = {} if col[4] == "-" else {urllib.parse.unquote(k): urllib.parse.unquote(v)
                                         for k, v in (pair.split("=", 1) for pair in col[4].split(";"))}
        name = ref.split(":", 1)[1] if action == "report" and ref.startswith(("remote:", "local:")) else ref
        shown.append(name)
        for k in ROW_KEYS.get(action, ("tip_date", "tip_author", "pr", "pr_state", "author", "updated", "pr_base")):
            shown.append(snap.get(k, ""))
        if action == "delete-remote" and snap.get("pr_head_repo", "").lower() != remote:
            shown.append(snap.get("pr_head_repo", ""))
        is_item = action.startswith("close-") or (action == "report" and "#" in ref and ":" not in ref)
        if is_item:
            shown.append(ev)
        key = ("report", ref) if action.startswith("close-") else (action, ref)
        used.add(key)
        j = jidx.get(key, {})
        if action.startswith("close-"):
            shown.append(snap["title"] if snap.get("title") else j.get("evidence", ""))
        if action == "report" and j.get("reason") == "protected":
            shown.append(j.get("protected_by", ""))
        branch = action.startswith("delete-") or (action == "report" and ref.startswith(("remote:", "local:")))
        if branch and not re.fullmatch(r"[A-Za-z0-9._/#:+-]*", name):
            odd += 1
    for key, j in jidx.items():
        if key not in used:
            shown.append(j["ref"].split(":", 1)[1] if j["ref"].startswith(("remote:", "local:")) else j["ref"])
    hid = set()
    for v in shown:
        hid |= set(re.findall(r"\{hid:(U\+[0-9A-F]+)\}", reveal(v)))
    print("%d %d %s" % (len(hid), odd, ", ".join(sorted(hid, key=lambda c: int(c[2:], 16)))))
    sys.exit(0)
plan, page = sys.argv[1], sys.argv[2]
def kind_of(text):
    if text.startswith("PR #"): return "pr"
    if text.startswith("이슈 #"): return "issue"
    if text == "작업 폴더 목록": return "folder"
    if re.fullmatch(r"[A-Z][A-Z0-9]+(-[0-9]+)?", text): return "jira"   # Jira key / project (a branch PROJ-1234 too —
    return "local-branch" if text.endswith(" (로컬)") else "branch"     # both sides agree; the section tells them apart)
def v4_verdict(action, ref, snap, ev):
    """v4 tier-3 rows (decoded independently of the renderer): inventory jira#<PROJECT>, Jira unit jira#<KEY>, structured
    pr/issue row (snapshot key verdict=, the last key — a title that merely looks like t=…;v=… stays a title) — returns
    INVENTORY or the verdict, None for any other row."""
    if action != "report":
        return None
    if re.fullmatch(r"jira#[A-Z][A-Z0-9]+", ref):
        return "INVENTORY"
    if ref.startswith("jira#"):
        return urllib.parse.unquote(dict(p.split("=", 1) for p in urllib.parse.unquote(ev).split(";"))["v"])
    if snap != "-" and snap.split(";")[-1].startswith("verdict="):
        return urllib.parse.unquote(snap.split(";")[-1][len("verdict="):])
    return None
SECTION = {"s-del": "delete", "s-close": "close", "s-local": "local", "s-prot": "kept", "s-held": "kept",
           "s-jira": "jira", "s-ambig": "ambig", "s-move": "move"}
want, rows, cards, invs = collections.Counter(), 0, 0, 0
for line in open(plan, encoding="utf-8").read().split("\n")[1:]:
    if not line:
        continue
    tier, action, ref = line.split("\t")[:3]
    ref = urllib.parse.unquote(ref)
    v = v4_verdict(action, ref, line.split("\t")[4], line.split("\t")[5])
    cls = {"delete-remote": "delete", "close-pr": "close", "close-issue": "close", "jira-transition": "jira",
           "move-issue": "move", "report": "kept"}.get(action, "local")
    if v == "AMBIGUOUS":
        cls = "ambig"
    elif v == "INVENTORY":
        cls = "jira"
    if v == "INVENTORY":
        invs += 1
    elif cls in ("close", "ambig", "move") or action == "jira-transition":
        cards += 1
    else:
        rows += 1
    if ref == ".":
        text = "작업 폴더 목록"
    elif ref.startswith("jira#") and action in ("report", "jira-transition"):
        text = ref[len("jira#"):]
    elif action in ("close-pr", "report") and ref.startswith("pr#"):
        text = "PR #" + ref[3:]
    elif action in ("close-issue", "report", "move-issue") and ref.startswith("issue#"):
        text = "이슈 #" + ref[6:]
    elif action == "report":
        k, name = ref.split(":", 1)
        text = reveal(name) + (" (로컬)" if k == "local" else "")
    else:
        text = reveal(ref) + (" (로컬)" if action.startswith("delete-local") else "")
    want[(cls, kind_of(text), text)] += 1
class P(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0; self.buf = []; self.got = collections.Counter(); self.rows = 0; self.cards = 0; self.sec = None
        self.stack = []; self.invs = 0
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "section": self.sec = a.get("aria-labelledby")
        if tag == "li" and a.get("class") == "row": self.rows += 1
        if tag == "article" and a.get("class") == "card": self.cards += 1
        if tag == "p" and a.get("class") == "inv": self.invs += 1
        if self.depth:
            self.depth += 1
            hid = tag == "span" and a.get("class") == "hid"
            self.stack.append(hid)
            if hid: self.buf.append("{hid:")
        elif "it" in (a.get("class") or "").split(): self.depth = 1; self.buf = []; self.stack = []
    def handle_endtag(self, tag):
        if tag == "section": self.sec = None
        if self.depth:
            self.depth -= 1
            if self.depth and self.stack.pop(): self.buf.append("}")
            if not self.depth:
                text = "".join(self.buf)
                self.got[(SECTION.get(self.sec, "outside:%s" % self.sec), kind_of(text), text)] += 1
    def handle_data(self, d):
        if self.depth: self.buf.append(d)
p = P(); p.feed(open(page, encoding="utf-8").read())
bad = []
if p.rows != rows: bad.append("row elements %d != plan rows %d" % (p.rows, rows))
if p.cards != cards: bad.append("cards %d != close + Jira + AMBIGUOUS + move-issue rows %d" % (p.cards, cards))
if p.invs != invs: bad.append("inventory lines %d != inventory rows %d" % (p.invs, invs))
if p.got != want: bad.append("items differ: page-only %s plan-only %s" % (dict(p.got - want), dict(want - p.got)))
if any(c != 1 for c in want.values()): bad.append("a plan target appears twice")
per = collections.Counter(k[0] for k in want)
print("; ".join(bad) or "rows=%d cards=%d%s · %s" % (rows, cards, " inv=%d" % invs if invs else "",
                                                     " ".join("%s=%d" % kv for kv in sorted(per.items()))))
sys.exit(1 if bad else 0)
PY

# ── base render ─────────────────────────────────────────────────────────────────────────────────
B=$(mk base); { hdr; base_rows; } > "$B/plan.tsv"; S=$(sha "$B/plan.tsv")
json "$S" base_jrows > "$B/plan.json"
render "$B"; rc=$?; H="$B/out.html"
if [ "$rc" = 0 ] && [ -s "$H" ]; then ok "base fixture renders"; else bad "base fixture renders" "rc=$rc $(cat "$B/stderr")"; fi

# 1. fingerprint == shasum of the plan file; matching engine sha → no drift note
if grep -qF "id=\"fp\">$S<" "$H" && [ "$(grep -o "$S" "$H" | wc -l | tr -d ' ')" = 2 ]; then ok "1 fingerprint = shasum ($S)"
else bad "1 fingerprint" "sha $S not shown as fingerprint"; fi
if grep -q 'id="drift"' "$H"; then bad "1b no drift note when engine sha matches" "drift note present"; else ok "1b no drift note when engine sha matches"; fi
# 1c. the engine test (chore.test.sh) reads the approval digest from exactly this element — keep the coupling visible here
if [ "$(grep -o '<dd class="fp" id="fp">[0-9a-f]*</dd>' "$H")" = "<dd class=\"fp\" id=\"fp\">$S</dd>" ]; then
  ok "1c digest element <dd class=\"fp\" id=\"fp\"> holds the plan sha256, exactly once"
else bad "1c digest element" "$(grep -o '<dd class="fp" id="fp">[^<]*</dd>' "$H" | tr '\n' ' ')"; fi

# 2. four summary numbers recomputed from the TSV
nb=$(awk -F'\t' 'NR>1 && $1!=3 && $2=="delete-remote"' "$B/plan.tsv" | wc -l | tr -d ' ')
np=$(awk -F'\t' 'NR>1 && $1!=3 && $2=="close-pr"' "$B/plan.tsv" | wc -l | tr -d ' ')
ni=$(awk -F'\t' 'NR>1 && $1!=3 && $2=="close-issue"' "$B/plan.tsv" | wc -l | tr -d ' ')
nk=$(awk -F'\t' 'NR>1 && ($1==3 || $2=="report")' "$B/plan.tsv" | wc -l | tr -d ' ')
if [ "$nb/$np/$ni/$nk" = "9/1/1/18" ] && grep -qF "id=\"n-branches\">$nb<" "$H" && grep -qF "id=\"n-prs\">$np<" "$H" \
   && grep -qF "id=\"n-issues\">$ni<" "$H" && grep -qF "id=\"n-kept\">$nk<" "$H"; then ok "2 summary numbers = TSV rows ($nb/$np/$ni/$nk)"
else bad "2 summary numbers" "tsv=$nb/$np/$ni/$nk html=$(grep -oE 'id="n-[a-z]+">[0-9]+' "$H" | tr '\n' ' ')"; fi

# 3. close-pr comment: tab/newline/<script>/&/% decoded once, HTML-escaped, line breaks kept, no live <script>
if "$PY" -I -c 'import html,sys
h=open(sys.argv[1],encoding="utf-8").read(); c=open(sys.argv[2],encoding="utf-8").read()
sys.exit(0 if "<div class=\"comment\">"+html.escape(c,quote=True)+"</div>" in h else 1)' "$H" "$T/cmt.txt" \
   && [ "$(grep -c '<script' "$H")" = 0 ] && grep -qF 'alert(1)&lt;/script&gt; &amp; 100% done' "$H"; then ok "3 close comment escaped verbatim with line breaks"
else bad "3 close comment" "escaped comment not found verbatim"; fi
if grep -qF '<a class="it" href="https://github.com/test/repo/pull/7">PR #7</a> Old idea: experimental search' "$H" \
   && grep -qF 'href="https://github.com/test/repo/issues/9"' "$H" && grep -qF '이 코멘트를 남기고 닫습니다' "$H" \
   && grep -qF '2026-09-01 12:04 KST' "$H"; then ok "3b close cards: title from engine report row, links, KST update time"
else bad "3b close cards" "title/link/KST missing"; fi

# 4. plan row not in engine JSON → non-zero (non-close row), and a close row with no report partner
d=$(mk c4); { hdr; base_rows; D feat/ghost 110 develop zed zed@example.com 2026-09-09; } > "$d/plan.tsv"
json x base_jrows > "$d/plan.json"; must_fail "4 TSV row missing from JSON → error" "$d" "plan row not in engine JSON"
d=$(mk c4b); { hdr; base_rows; row 2 close-pr 'pr#99' "$OC" "state=OPEN;updated=2026-09-01T03%3A04%3A05Z;head_repo=test/repo;head_ref=a;head_oid=$OC;base=develop;author=z" 'bye'; } > "$d/plan.tsv"
json x base_jrows > "$d/plan.json"; must_fail "4b close row without engine report row → error" "$d" "plan row not in engine JSON"

# 5. malformed encoding / column count / header keys → non-zero
c5() { # c5 <name> <stderr-substring> — plan from current env/args, base JSON
  local d; d=$(mk "c5-$n"); { hdr "${HX[@]+"${HX[@]}"}" | sed -e "${HSED:-s/^//}"; base_rows; [ -z "${EXTRA:-}" ] || printf '%s\n' "$EXTRA"; } > "$d/plan.tsv"
  json x base_jrows ${JEXTRA:+"$JEXTRA"} > "$d/plan.json"; must_fail "$1" "$d" "$2"
}
HX=(); EXTRA=""
EV_STALE='bad %G1 escape' c5 "5a %G1 → error" "malformed percent-escape"
EV_STALE='cut %4' c5 "5b truncated %4 → error" "malformed percent-escape"
EV_STALE='lower %3a' c5 "5c lowercase hex %3a → error" "malformed percent-escape"
EV_STALE=$'carriage\r' c5 "5d raw control byte (CR) → error" "raw control byte"
EXTRA=$(row 3 report extra/five "$OD" -) c5 "5e 5-column row → error" "expected 6 tab-separated columns"
EXTRA=$(row 3 report extra/seven "$OD" - ev more) c5 "5f 7-column row → error" "expected 6 tab-separated columns"
EXTRA=$(row 4 report extra/tier "$OD" - ev) c5 "5g tier 4 → error" "tier must be"
EXTRA=$(row 3 report remote:develop "$OD" - dup) c5 "5h duplicate (action, ref) → error" "duplicate (action, ref)"
EXTRA=$(row 3 report remote:extra/snap "$OD" 'a=1;a=2' ev) c5 "5i duplicate snapshot key → error" "duplicate snapshot key"
HX=('color=blue'); c5 "5j unknown header key → error" "unknown header key"
HX=('default=main'); c5 "5k duplicate header key → error" "duplicate header key"; HX=()
DROP=groups c5 "5l missing header key → error" "missing header keys"
d=$(mk c5m); { hdr | sed 's/^#chore-plan v3/#chore-plan v2/'; base_rows; } > "$d/plan.tsv"; json x base_jrows > "$d/plan.json"
must_fail "5m wrong header tag → error" "$d" "header must start"

# 6. engine-only row → "계획에서 뺀 항목 1개" + drift note (sha differs)
d=$(mk c6); cp "$B/plan.tsv" "$d/plan.tsv"
json 0000000000000000000000000000000000000000000000000000000000000000 base_jrows "$(J 3 report remote:spike/removed stale '' x)" > "$d/plan.json"
render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '계획에서 뺀 항목 1개' "$d/out.html" \
   && grep -qF '이 페이지가 확인한 차이: 닫기 2행 추가, 1행 제외 — 그 밖의 차이는 확인하지 않음' "$d/out.html" \
   && grep -qF "<dt>엔진 출력 지문</dt><dd class=\"fp\">$Z64</dd>" "$d/out.html" \
   && grep -qF "<dt>이 계획 파일 지문</dt><dd class=\"fp\">$S</dd>" "$d/out.html"; then ok "6 engine-only row counted as removed + drift note with both fingerprints"
else bad "6 engine-only row" "rc=$rc $(grep -o '계획에서 뺀 항목 [0-9]*개' "$d/out.html" 2>/dev/null)"; fi
if grep -qF '<summary>뺀 항목 1개 보기</summary>' "$d/out.html" \
   && grep -qF '<li><code class="ref">spike/removed</code> <span class="muted">남기는 항목</span></li>' "$d/out.html"; then
  ok "6d removed rows listed (collapsed) next to the count"
else bad "6d removed list" "list missing"; fi
if grep -qF '계획에서 뺀 항목 0개' "$H"; then ok "6b close rows consume their report rows (0 removed in base)"; else bad "6b" "base page does not say 0 removed"; fi
d=$(mk c6c); { hdr; base_rows; row 3 report 'pr#7' "$OC" 'state=OPEN;updated=x;author=erin' 'kept report row too'; } > "$d/plan.tsv"
json x base_jrows > "$d/plan.json"; must_fail "6c close + kept report row on one PR → error" "$d" "one target, two states"

# 7. no internal codes in the HTML; no commit hash other than the fingerprint
codes='tier[123]|merge-not-in-base|contained-hold|merge-commit-unknown|same-as-integration-tip|local-held|worktree-prune|open-pr|open-issue|merged-pr|checked-out|delete-remote|delete-local|close-pr|close-issue|protected_by|basis=|remote:|local:|--integrate|--protect|ruleset#|workflow#'
if grep -nE "$codes" "$H" >/dev/null; then bad "7 internal codes absent" "$(grep -noE "$codes" "$H" | head -5 | tr '\n' ' ')"
else ok "7 internal codes absent"; fi
hx=$(grep -oE '[0-9a-f]{40,}' "$H" | sort -u | tr '\n' ' ')
if [ "$hx" = "$S " ]; then ok "7b only hash on the page is the plan fingerprint"; else bad "7b hashes" "$hx"; fi
# 7c. engine evidence for branch rows never reaches the page (English, flags, codes) — Korean sentences instead
raw='--no-local|hold|contained in|merge commit|merged into|checked out|raw engine text|future-reason|stale [0-9]|protected \('
if grep -nE -- "$raw" "$H" >/dev/null; then bad "7c raw branch evidence absent" "$(grep -noE -- "$raw" "$H" | head -5 | tr '\n' ' ')"
else ok "7c raw branch evidence absent (--no-local, hold, contained in, merge commit, …)"; fi
miss=""
for want in 'PR #88은 병합됐지만 그 병합 커밋이 지금 <code class="ref">deploy/staging</code> 히스토리에 없음' '<code class="ref">develop</code> 끝 커밋과 같음' \
            '통합 브랜치에 내용이 들어 있지만 정확히 맞는 병합 PR이 없음' '마지막 커밋 2025-12-01, 병합 근거 없음' \
            '작업 폴더에서 열려 있음' '로컬 정리는 다른 작업 세션이 끝난 뒤 따로 실행' '작업 폴더 목록 정리는 이번에 하지 않음' \
            '기본 브랜치 · 저장소 규칙(ruleset) 때문에 보호' '그 밖의 이유로 이번에는 남김' \
            '>Add live work dashboard<' '>로그인 화면 오타<'; do
  grep -qF -- "$want" "$H" || miss="$miss [$want]"
done
if [ -z "$miss" ]; then ok "7d Korean reason sentences per row; PR/issue titles kept verbatim"; else bad "7d reason sentences" "missing:$miss"; fi

# 8. no external resource loads; every http(s) URL is a repo-url <a href>
if grep -nE '<link|<script|@import|url\(|src=|<iframe|<img|<object|<embed' "$H" >/dev/null; then bad "8 no external resources" "$(grep -noE '<link|<script|@import|url\(|src=' "$H" | head -3)"
else ok "8 no external resources (link/script/@import/url()/src)"; fi
stray=$(grep -oE '.{0,6}https?://[^" <]*' "$H" | grep -vE '^href="https://github\.com/test/repo/(pull|issues)/[0-9]+$')
if [ -z "$stray" ]; then ok "8b every http(s) URL is a repo link href"; else bad "8b stray URLs" "$stray"; fi

# 9. deploy group first with the step-1 mark
first_h3=$(awk '/id="s-del"/{on=1} /id="s-close"/{on=0} on && /<h3/{print; exit}' "$H")
order=$(awk '/id="s-del"/{on=1} /id="s-close"/{on=0} on && /<h3/' "$H" | sed -E 's/.*<h3 id="g[0-9]+">([^<]*).*/\1/' | sed 's/ *$//' | paste -sd'|' -)
case "$first_h3" in *'배포 승격용 브랜치'*'실행 1단계 대상'*) okf=1;; *) okf=0;; esac
if [ "$okf" = 1 ] && [ "$(grep -o '실행 1단계 대상' "$H" | wc -l | tr -d ' ')" = 1 ] \
   && [ "$order" = "배포 승격용 브랜치|기능 브랜치|수정 브랜치|접두사 없는 브랜치(티켓 번호 등)|그 밖의 접두사 브랜치" ] \
   && grep -qF '배포 승격용 브랜치 <b>2</b>개를 먼저 삭제' "$H"; then ok "9 deploy group first + 1단계 mark, then by size ($order)"
else bad "9 group order" "first=$first_h3 order=$order"; fi
# 9b. no "작성자 다름" judgement anywhere; both author columns still shown as data (bob opened, carol committed)
row9b=$(grep -F '>deploy/staging-to-stage2-20260402<' "$H")
if ! grep -qF '작성자 다름' "$H" && printf '%s' "$row9b" | grep >/dev/null -F '<span class="k">PR 작성자</span>bob<' \
   && printf '%s' "$row9b" | grep >/dev/null -F '<span class="k">마지막 커밋 작성자</span>carol@example.com<'; then
  ok "9b 작성자 다름 never appears; PR author and last-commit author columns kept"
else bad "9b author columns" "badge present or columns missing"; fi

# 9c. no deploy group → largest group goes first, no step-1 badge
jr9() { J 2 delete-remote feat/a merged-pr '' x; J 2 delete-remote feat/b merged-pr '' x; J 2 delete-remote fix/c merged-pr '' x; J 3 report remote:develop protected default x; }
d=$(mk c9c); { hdr; D feat/a 1 develop a a@x.io 2026-01-01; D feat/b 2 develop b b@x.io 2026-01-02; D fix/c 3 develop c c@x.io 2026-01-03
  K develop 'tip_date=2026-10-01' 'protected'; } > "$d/plan.tsv"; json x jr9 > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && ! grep -q '실행 1단계 대상' "$d/out.html" && grep -qF '실행 그룹 키 하나로 고를 수 있는 그룹 중 가장 큰 기능 브랜치 <b>2</b>개를 먼저 삭제하고(실행 그룹 키 <code class="ref">feat/*</code>)' "$d/out.html" \
   && grep -qF 'PR <b>0</b>개·이슈 <b>0</b>개 닫기 → 나머지 브랜치 <b>1</b>개 삭제.' "$d/out.html"; then ok "9c no deploy group → the largest one-key group first, with its key"
else bad "9c" "rc=$rc $(head -c 200 "$d/stderr")"; fi
if grep -qF '이 페이지가 확인한 차이는 없습니다 — 무엇이 바뀌었는지는 확인하지 못했습니다' "$d/out.html" \
   && ! grep -qF '그 밖의 차이는 확인하지 않음' "$d/out.html"; then ok "9c2 digests differ with 0 closes / 0 removed → says the change was not identified"
else bad "9c2 drift 0/0" "wrong drift sentence"; fi

# 9d. prefix groups under 5 rows merge into "그 밖의 접두사 브랜치" after the named groups; 5+ keep their own group
jr9d() { local r; for r in deploy/a feat/a feat/b batch/a PROJ-3136/b proj-4082/c proj-4082/d iac/1 iac/2 iac/3 iac/4 iac/5; do
  J 2 delete-remote "$r" merged-pr '' x; done; }
d=$(mk c9d); { hdr; n9=200; for r in deploy/a feat/a feat/b batch/a PROJ-3136/b proj-4082/c proj-4082/d iac/1 iac/2 iac/3 iac/4 iac/5; do
  n9=$((n9+1)); D "$r" "$n9" develop a a@x.io 2026-02-02; done; } > "$d/plan.tsv"
json x jr9d > "$d/plan.json"; render "$d"; rc=$?; H9="$d/out.html"
order=$(awk '/id="s-del"/{on=1} /id="s-close"/{on=0} on && /<h3/' "$H9" | sed -E 's/.*<h3 id="g[0-9]+">([^<]*).*/\1/' | sed 's/ *$//' | paste -sd'|' -)
if [ "$rc" = 0 ] && [ "$order" = "배포 승격용 브랜치|iac/ 로 시작하는 브랜치|기능 브랜치|그 밖의 접두사 브랜치" ] \
   && grep -qF '그 밖의 접두사 브랜치</h3><span class="prefix mono ref">batch/, PROJ-3136/, proj-4082/</span>' "$H9" \
   && grep -A1 -F '그 밖의 접두사 브랜치</h3>' "$H9" | grep >/dev/null -F '<b>4</b>개' \
   && grep -qF '>PROJ-3136/b<' "$H9" && grep -qF '>proj-4082/d<' "$H9" && [ "$(grep -o '실행 1단계 대상' "$H9" | wc -l | tr -d ' ')" = 1 ] \
   && grep -qF '배포 승격용 브랜치 <b>1</b>개를 먼저 삭제' "$H9"; then ok "9d small prefix groups merged into 그 밖의 접두사 브랜치 ($order)"
else bad "9d small-group merge" "rc=$rc order=$order"; fi
d=$(mk c9e); { hdr; n9=300; for r in batch/a batch/b ops/c ops/d qa/e feat/x; do n9=$((n9+1)); D "$r" "$n9" develop a a@x.io 2026-02-02; done; } > "$d/plan.tsv"
jr9e() { local r; for r in batch/a batch/b ops/c ops/d qa/e feat/x; do J 2 delete-remote "$r" merged-pr '' x; done; }
json x jr9e > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '실행 그룹 키 하나로 고를 수 있는 그룹 중 가장 큰 기능 브랜치 <b>1</b>개를 먼저 삭제' "$d/out.html" \
   && ! grep -qF '그 밖의 접두사 브랜치 <b>5</b>개를 먼저' "$d/out.html" && ! grep -q '실행 1단계 대상' "$d/out.html"; then
  ok "9e the larger merged bucket (3 keys) is not a first batch; the one-key feat group is"
else bad "9e first batch" "rc=$rc $(grep -o '가장 큰[^<]*<b>[0-9]*' "$d/out.html")"; fi

# 10. integration list counts (pr_base) and protected sources in operator words
miss=""
for want in '<code class="ref">develop</code> <span class="muted">(기본 브랜치)</span></span><span>이 브랜치로 병합된 삭제 후보 <b>6</b>개' \
            '<code class="ref">deploy/staging</code></span><span>이 브랜치로 병합된 삭제 후보 <b>1</b>개' \
            '<code class="ref">deploy/stage2</code></span><span>이 브랜치로 병합된 삭제 후보 <b>1</b>개' \
            '<code class="ref">main</code></span><span>이 브랜치로 병합된 삭제 후보 <b>1</b>개' \
            '>기본 브랜치 · 저장소 규칙(ruleset)</h3>' '>배포 워크플로가 반응하는 브랜치 · 통합 브랜치로 직접 지정</h3>' \
            '>열린 PR의 브랜치</h3>' '<a href="https://github.com/test/repo/pull/8">PR #8</a> 브랜치' \
            '>직접 지정한 보호 패턴</h3>' '>기본 브랜치</h3>' '>기타 출처: frozen-list</h3>' '>출처</span>워크플로 deploy-staging.yml</span>' \
            '<code class="ref">develop</code> <span class="muted">(로컬)</span>' '워크플로 a.yml, 워크플로 b.yml, 외 1개 출처'; do
  grep -qF -- "$want" "$H" || miss="$miss [$want]"
done
if [ -z "$miss" ]; then ok "10 integration counts + protected source labels"; else bad "10 integration/protected" "missing:$miss"; fi
g3=$(grep -A1 -F '>배포 워크플로가 반응하는 브랜치 · 통합 브랜치로 직접 지정</h3>' "$H" | grep -c '<b>3</b>개')
if [ "$g3" = 1 ] && ! grep -q '외 출처\|more' "$H"; then ok "10c '+N more' does not split protected groups (3 rows in one group)"
else bad "10c +N more grouping" "g3=$g3"; fi
if grep -qF '현재 통합 히스토리에서 병합 커밋을 확인하지 못한 브랜치 — 보존' "$H" && grep -qF '열린 PR — 손대지 않음' "$H" \
   && grep -qF '로컬 브랜치 — 이번 실행에서는 정리하지 않음' "$H" && grep -qF '<span class="c"><span class="sr">항목</span><span class="it">작업 폴더 목록</span></span>' "$H" \
   && grep -qF '작업 폴더에서 열려 있는 로컬 브랜치 — 보존' "$H" && grep -qF '2026-10-15 14:12 KST' "$H"; then ok "10b hold groups in operator words + created in KST"
else bad "10b hold labels" "missing label or KST"; fi

# 10d. repository name keeps its real casing: --repo-url first, then origin, then the lowercased remote
c10d() { # c10d <name> <origin-enc> <repo-url or -> <expected title> <expected repo line>
  local d; d=$(mk "c10d-$n"); hdr | sed "s#origin=git@github.com%3Atest/repo.git#origin=$2#" > "$d/plan.tsv"; base_rows >> "$d/plan.tsv"
  json x base_jrows > "$d/plan.json"
  if [ "$3" = - ]; then "$PY" -I "$R" --plan "$d/plan.tsv" --json "$d/plan.json" --out "$d/out.html" 2>"$d/stderr"
  else "$PY" -I "$R" --plan "$d/plan.tsv" --json "$d/plan.json" --out "$d/out.html" --repo-url "$3" 2>"$d/stderr"; fi
  if grep -qF "<h1>$4 저장소 정리 계획 — 승인 요청</h1>" "$d/out.html" && grep -qF "<dt>저장소</dt><dd><code>$5</code>" "$d/out.html"; then ok "$1"
  else bad "$1" "$(grep -o '<h1>[^<]*' "$d/out.html" 2>/dev/null) $(head -c 160 "$d/stderr")"; fi
}
c10d "10d casing from --repo-url" 'git@github.com%3Atest/repo.git' 'https://github.com/Test/Repo/' Repo Test/Repo
c10d "10e casing from origin (scp form) without --repo-url" 'git@github.com%3ATest/RePo.git' - RePo Test/RePo
c10d "10f casing from origin (https form)" 'https%3A//github.com/TEST/Repo' - Repo TEST/Repo
c10d "10g origin of another repo is ignored → remote" 'git@github.com%3AOther/Thing.git' - repo test/repo
d=$(mk c10h); cp "$B/plan.tsv" "$B/plan.json" "$d/"; render "$d" --repo-url https://github.com/test/other; rc=$?
if [ "$rc" != 0 ] && [ ! -e "$d/out.html" ] && grep -qF "is not the plan's repository" "$d/stderr"; then ok "10h --repo-url of another repository → error (rc=$rc)"
else bad "10h repo-url mismatch" "rc=$rc"; fi

# 11. large plan (3000 delete rows) renders into one file with every list closed
d=$(mk c11)
{ hdr; awk -v oa="$OA" -v om="$OM" 'BEGIN{for(i=1;i<=3000;i++){p=(i%3==0)?"deploy":(i%3==1)?"feat":"chore";
  printf "2\tdelete-remote\t%s/b-%05d\t%s\tbasis=a;pr=%d;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=%s;pr_author=u%d;tip_author=u%d@x.io;tip_date=2026-0%d-1%d;pr_merge_commit=%s\tev\n",p,i,oa,i,oa,i%7,i%7,1+i%9,i%10,om}}'; } > "$d/plan.tsv"
jbig() { awk 'BEGIN{for(i=1;i<=3000;i++){p=(i%3==0)?"deploy":(i%3==1)?"feat":"chore";
  printf "{\"tier\":2,\"action\":\"delete-remote\",\"ref\":\"%s/b-%05d\",\"reason\":\"merged-pr\",\"protected_by\":\"\",\"group\":\"%s/*\"}\n",p,i,p}}'; }
json x jbig > "$d/plan.json"; t0=$(date +%s); render "$d"; rc=$?; t1=$(date +%s)
if [ "$rc" = 0 ] && grep -qF 'id="n-branches">3000<' "$d/out.html" && ! grep -q '<details open' "$d/out.html" \
   && [ "$(grep -c '<li class="row">' "$d/out.html")" = 3000 ] && [ $((t1 - t0)) -lt 30 ]; then
  ok "11 3000-row plan: one file, all closed, $((t1 - t0))s, $(wc -c < "$d/out.html" | tr -d ' ') bytes"
else bad "11 large plan" "rc=$rc $(head -c 200 "$d/stderr")"; fi

# 12. CLI: --help under -I, bad --repo-url, wrong engine run, deterministic output
if "$PY" -I "$R" --help 2>&1 | grep >/dev/null -F -- '--plan'; then ok "12a --help works under python3 -I"; else bad "12a --help" "no usage"; fi
d=$(mk c12b); cp "$B/plan.tsv" "$B/plan.json" "$d/"
render "$d" --repo-url 'javascript:alert(1)'; rc=$?
if [ "$rc" != 0 ] && [ ! -e "$d/out.html" ]; then ok "12b non-http --repo-url rejected (rc=$rc)"; else bad "12b repo-url" "rc=$rc"; fi
d=$(mk c12c); cp "$B/plan.tsv" "$d/"; JRUN=20250101T000000Z-ffffffff json "$S" base_jrows > "$d/plan.json"
must_fail "12c engine JSON from another run → error" "$d" "different engine run"
d=$(mk c12d); cp "$B/plan.tsv" "$B/plan.json" "$d/"; render "$d"; rc=$?
if [ "$rc" = 0 ] && cmp -s "$H" "$d/out.html"; then ok "12d same inputs → identical bytes"; else bad "12d deterministic" "rc=$rc or bytes differ"; fi

# 13. executable local rows (spec has no section for them) are shown, not hidden
LSNAP="basis=a;pr=200;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=$OA;tip_author=a@x.io;tip_date=2026-09-01;pr_merge_commit=$OM"
d=$(mk c13); H13="$d/out.html"; { NO_LOCAL=0 hdr; base_rows; row 1 delete-local feat/done-local "$OA" "$LSNAP" 'merged PR #200'
  row 2 delete-local-force 'pr#77' "$OA" "$LSNAP" 'a branch literally named pr#77'
  row 3 report local:feat/login-form "$OD" 'tip_author=a@x.io;tip_date=2026-09-01' 'local twin of a remote delete'; } > "$d/plan.tsv"
json x base_jrows "$(J 1 delete-local feat/done-local merged-pr '' x)" "$(J 2 delete-local-force 'pr#77' merged-pr '' x)" \
  "$(J 3 report local:feat/login-form stale '' x)" > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF 'id="n-local">2<' "$H13" && grep -qF '>로컬 정리</h2>' "$H13" \
   && grep -qF '<span class="it"><code class="ref">feat/done-local</code> <span class="muted">(로컬)</span></span>' "$H13" \
   && grep -qF '닫기 → 나머지 브랜치 <b>7</b>개 삭제 → 로컬 정리 <b>2</b>건.' "$H13" \
   && grep -qF 'PR #200이 <code class="ref">develop</code>에 병합됨' "$H13" && ! grep -qF 'merged PR #200' "$H13"; then ok "13 tier1/2 local delete rows are visible + in run order"
else bad "13 local rows" "rc=$rc $(head -c 200 "$d/stderr")"; fi
if grep -qF '<span class="it"><code class="ref">pr#77</code> <span class="muted">(로컬)</span></span>' "$H13" && ! grep -q '/pull/77' "$H13" \
   && ! grep -qF 'a branch literally named' "$H13"; then ok "13b object kind comes from the action: a branch named pr#77 is a branch, no PR link"
else bad "13b action decides kind" "pr#77 shown as PR or raw evidence"; fi

# 13c. the engine JSON calling an executed row "protected" is a plan/engine mismatch → clear error, no traceback
d=$(mk c13p); cp "$T/c13/plan.tsv" "$d/"
json x base_jrows "$(J 1 delete-local feat/done-local protected '' x)" "$(J 2 delete-local-force 'pr#77' merged-pr '' x)" \
  "$(J 3 report local:feat/login-form stale '' x)" > "$d/plan.json"
must_fail "13c engine marks a delete-local row protected → error" "$d" "marks delete-local feat/done-local as protected but the plan executes it"
if grep -q Traceback "$d/stderr"; then bad "13c no traceback" "$(head -c 160 "$d/stderr")"; else ok "13c no traceback on stderr"; fi

# 14. one target in two states → error (M1)
c5n() { # c5n <name> <stderr-substring> — like c5 but NO_LOCAL=0 header
  local d; d=$(mk "c5n-$n"); { NO_LOCAL=0 hdr; base_rows; printf '%s\n' "$EXTRA"; } > "$d/plan.tsv"
  json x base_jrows ${JEXTRA:+"$JEXTRA"} > "$d/plan.json"; must_fail "$1" "$d" "$2"
}
EXTRA=$(K feat/login-form 'tip_author=a@x.io;tip_date=2026-09-01' kept) c5 "14a delete-remote X + kept remote:X → error" "one target, two states"
EXTRA=$(row 1 delete-local feat/wip-local "$OA" "$LSNAP" x) c5n "14b delete-local X + kept local:X → error" "one target, two states"
EXTRA=$(row 1 worktree-prune . - - x) c5n "14c worktree-prune + kept work-folder row → error" "one target, two states"
EXTRA=$(row 3 report 'issue#9' 2026-08-01T00:00:00Z 'state=OPEN;updated=x;author=frank' kept) c5 "14d close-issue + kept issue → error" "one target, two states"

# 15. invisible / confusable characters in refs are revealed as a bordered <span class="hid">U+XXXX</span> mark (M2, round 2:
#     Default_Ignorable code points such as U+034F, non-ASCII spaces such as U+00A0, U+2800 braille blank); a name that
#     literally contains the ASCII text "<U+202E>" stays escaped text and renders differently from a real U+202E.
#     This file holds no raw hidden characters: TSV fixtures spell their bytes as %XX and u8f turns those into the raw
#     UTF-8 the engine writes; JSON and Python use \uXXXX escapes.
hidm() { printf '<span class="hid" role="img" aria-label="숨김 문자 %s" title="숨김 문자 %s">%s</span>' "$1" "$1" "$1"; }
R15ENC='feat/rlo-%E2%80%AE feat/shy-%C2%AD feat/fa-%E2%81%A1 feat/nel-%C2%85 feat/fill-%E3%85%A4 feat/vs-%EF%B8%8F feat/<b>x</b>
 feat/cgj-%CD%8F feat/alm-%D8%9C feat/mvs-%E1%A0%8E feat/mus-%F0%9D%85%B3 feat/nbsp%C2%A0 feat/x%E2%80%AE feat/x<U+202E>
 feat/braille-%E2%A0%80 feat/p%D0%B0y'
jr15() { local r; for r in 'feat/rlo-\u202e' 'feat/shy-\u00ad' 'feat/fa-\u2061' 'feat/nel-\u0085' 'feat/fill-\u3164' 'feat/vs-\ufe0f' 'feat/<b>x</b>' 'feat/cgj-\u034f' \
    'feat/alm-\u061c' 'feat/mvs-\u180e' 'feat/mus-\ud834\udd73' 'feat/nbsp\u00a0' 'feat/x\u202e' 'feat/x<U+202E>' 'feat/braille-\u2800' 'feat/p\u0430y'; do
  J 2 delete-remote "$r" merged-pr '' x; done; J 3 report 'remote:fix/kept-\u202e' stale '' x; J 3 report remote:keep/nosrc protected '' x
  J 3 report 'pr#31' open-pr '' 'Heart in the comment' pull-requests; }
d=$(mk c15); H15="$d/out.html"; { hdr; n9=400; for r in $R15ENC; do n9=$((n9+1)); D "$r" "$n9" develop a a@x.io 2026-02-02; done
  K 'fix/kept-%E2%80%AE' 'tip_author=a@x.io;tip_date=2026-01-01' x; K keep/nosrc 'tip_author=a@x.io;tip_date=2026-01-01' x
  row 2 close-pr 'pr#31' "$OC" "state=OPEN;updated=2026-09-01T03%3A04%3A05Z;head_repo=test/repo;head_ref=feat/h;head_oid=$OC;base=develop;author=erin" \
    '감사합니다 %E2%9D%A4%EF%B8%8F 다시 열어도 됩니다'; } > "$d/plan.tsv"; u8f "$d/plan.tsv"
json x jr15 > "$d/plan.json"; render "$d"; rc=$?
miss=""
for want in ">feat/rlo-$(hidm U+202E)<" ">feat/shy-$(hidm U+00AD)<" ">feat/fa-$(hidm U+2061)<" ">feat/nel-$(hidm U+0085)<" \
            ">feat/fill-$(hidm U+3164)<" ">feat/vs-$(hidm U+FE0F)<" ">fix/kept-$(hidm U+202E)<" '>feat/&lt;b&gt;x&lt;/b&gt;<' \
            ">feat/cgj-$(hidm U+034F)<" ">feat/alm-$(hidm U+061C)<" ">feat/mvs-$(hidm U+180E)<" ">feat/mus-$(hidm U+1D173)<" \
            ">feat/nbsp$(hidm U+00A0)<" ">feat/braille-$(hidm U+2800)<" 'unicode-bidi:isolate-override' '.hid,.hidex{display:inline-block;border:1px solid'; do
  grep -qF -- "$want" "$H15" || miss="$miss [$want]"; done
if [ "$rc" = 0 ] && [ -z "$miss" ] && ! grep -qF '<b>x</b>' "$H15" && ! grep -qF '&lt;U+' "$B/out.html" \
   && "$PY" -I -c 'import sys; h=open(sys.argv[1],encoding="utf-8").read(); sys.exit(any(c in h for c in "\u202e\u00ad\u2061\u0085\u3164\ufe0f\u034f\u061c\u180e\u2800\u00a0"))' "$H15"; then
  ok "15 hidden characters in refs → bordered U+XXXX marks (incl. U+034F, U+061C, U+180E, U+1D173, U+00A0, U+2800), markup escaped"
else bad "15 hidden chars" "rc=$rc missing:$miss $(head -c 160 "$d/stderr")"; fi
# 15a. the literal ASCII name feat/x<U+202E> and the name with a real U+202E render differently
lit='<code class="ref">feat/x&lt;U+202E&gt;</code>'; real="<code class=\"ref\">feat/x$(hidm U+202E)</code>"
if [ "$lit" != "$real" ] && grep -qF -- "$lit" "$H15" && grep -qF -- "$real" "$H15"; then ok "15a literal <U+202E> text and a real U+202E are told apart on the page"
else bad "15a reveal collision" "literal and real U+202E names not distinguished"; fi
# 15b. page legend once in the header when anything was revealed, none otherwise; the comment shows the mark, plain spaces stay
read -r f15_kinds f15_odd f15_list <<EOF15
$("$PY" -I "$T/complete.py" --facts "$d/plan.tsv" "$d/plan.json")
EOF15
if grep -qF "<div class=\"comment\">감사합니다 ❤$(hidm U+FE0F) 다시 열어도 됩니다</div>" "$H15" \
   && grep -qF "이 페이지에 나온 숨김 문자 <b id=\"hid-kinds\">$f15_kinds</b>종: $f15_list</p>" "$H15" && [ "$f15_kinds" -ge 12 ] \
   && "$PY" -I "$T/complete.py" --page-marks "$H15" >/dev/null && "$PY" -I "$T/complete.py" --page-marks "$H" >/dev/null \
   && [ "$(grep -c 'id="hid-legend"' "$H15")" = 1 ] && grep -qF '<span class="hidex">U+XXXX</span> 처럼 테두리 친 표기는 화면에 보이지 않는 문자를' "$H15" \
   && awk '/id="hid-legend"/{l=NR} /id="s-rule"/{r=NR} END{exit !(l && r && l < r)}' "$H15" \
   && ! grep -q 'id="hid-legend"' "$H" && ! grep -qF '검사용 표시' "$H15"; then
  ok "15b legend in the header only when something is revealed; counts $f15_kinds distinct characters (from the fixture), not marks"
else bad "15b legend" "legend placement or comment mark wrong"; fi
# 15c. a protected row without any source text
if grep -qF '보호 목록에 있음(출처 기재 없음)' "$H15" && ! grep -qF '출처 기재 없음 때문에 보호' "$H15"; then
  ok "15c protected row without a source reads 보호 목록에 있음(출처 기재 없음)"
else bad "15c no-source protected" "wrong sentence"; fi
# 15d. names with letters outside A-Za-z0-9._/#:+- are listed for a look-alike check; a clean page says so in one line
cyr=$'\xd0\xb0'
if [ "$f15_odd" -gt 0 ] && grep -qF "영문·숫자·._/#:+- 밖의 글자가 든 브랜치 이름 ${f15_odd}개가 있습니다." "$H15" \
   && grep -qF "<li><code class=\"ref\">feat/p${cyr}y</code> <span class=\"muted\">지울 원격 브랜치 · 그 밖의 글자: ${cyr} (U+0430)</span></li>" "$H15" \
   && grep -qF "<li><code class=\"ref\">fix/kept-$(hidm U+202E)</code> <span class=\"muted\">남기는 브랜치 · 그 밖의 글자: $(hidm U+202E)</span></li>" "$H15" \
   && ! grep -qF 'id="name-check">모든 브랜치' "$H15" \
   && grep -qF '<p class="note muted" id="name-check">모든 브랜치 이름이 영문·숫자·._/#:+- 로만 되어 있음</p>' "$H" \
   && ! grep -qF '밖의 글자가 든 브랜치 이름' "$H"; then
  ok "15d look-alike check: $f15_odd names (counted from the fixture) listed on the hidden-char page, one clean line on the base page"
else bad "15d look-alike check" "list or clean line wrong"; fi
# 15f. hidden characters in printed header values (I/integrate, protect) count in the legend; P alone is not printed
d=$(mk c15f); H15F="$d/out.html"
hdr | sed -e 's#I=develop,deploy/staging,deploy/stage2,main#&,deploy/s%E2%80%8Btage#' -e "s#main:$OC#&,deploy/s%E2%80%8Btage:$OB#" \
          -e 's#integrate=deploy/staging,deploy/stage2,main#&,deploy/s%E2%80%8Btage#' -e 's#protect=r2s/\*#&,keep%E2%81%A0/*#' \
          -e 's#feat/live-work#&,only-in-p%E2%80%8C#' > "$d/plan.tsv"
base_rows >> "$d/plan.tsv"; u8f "$d/plan.tsv"; json x base_jrows > "$d/plan.json"; render "$d"; rc=$?
read -r f15f_kinds f15f_odd f15f_list <<EOF15F
$("$PY" -I "$T/complete.py" --facts "$d/plan.tsv" "$d/plan.json")
EOF15F
if [ "$rc" = 0 ] && [ "$f15f_list" = "U+200B, U+2060" ] \
   && grep -qF "이 페이지에 나온 숨김 문자 <b id=\"hid-kinds\">$f15f_kinds</b>종: $f15f_list</p>" "$H15F" \
   && "$PY" -I "$T/complete.py" --page-marks "$H15F" >/dev/null && ! grep -qF 'U+200C' "$H15F" \
   && grep -qF "<code class=\"ref\">deploy/s$(hidm U+200B)tage</code>" "$H15F" && grep -qF "<code class=\"ref\">keep$(hidm U+2060)/*</code>" "$H15F"; then
  ok "15f header I/protect hidden chars counted by oracle and legend ($f15f_list); P-only U+200C neither printed nor counted"
else bad "15f header hidden chars" "rc=$rc oracle=[$f15f_kinds $f15f_list] $(head -c 160 "$d/stderr")"; fi

# 15e. <title> uses the same hidden rule without code notation: a real U+202E in the repo name becomes
#      "(숨김 문자 1개 포함)", a name that literally contains "[U+202E]" keeps its text — the two titles differ
c15e() { # c15e <dir> <remote-enc> <remote-json, sed-replacement escaped>
  hdr | sed "s#remote=test/repo#remote=$2#" > "$1/plan.tsv"; base_rows >> "$1/plan.tsv"; u8f "$1/plan.tsv"
  json x base_jrows | sed "s#\"remote\":\"test/repo\"#\"remote\":\"$3\"#" > "$1/plan.json"
  "$PY" -I "$R" --plan "$1/plan.tsv" --json "$1/plan.json" --out "$1/out.html" 2>"$1/stderr"
}
d1=$(mk c15e1); d2=$(mk c15e2)
c15e "$d1" 'test/re%E2%80%AEpo' 'test/re\\u202epo'; rc1=$?   # \\ = one backslash after sed
c15e "$d2" 'test/re[U+202E]po' 'test/re[U+202E]po'; rc2=$?
t1=$(grep -o '<title>[^<]*</title>' "$d1/out.html"); t2=$(grep -o '<title>[^<]*</title>' "$d2/out.html")
if [ "$rc1" = 0 ] && [ "$rc2" = 0 ] && [ "$t1" = '<title>repo (숨김 문자 1개 포함) 저장소 정리 계획 — 승인 요청</title>' ] \
   && [ "$t2" = '<title>re[U+202E]po 저장소 정리 계획 — 승인 요청</title>' ] && grep -qF "<h1>re$(hidm U+202E)po 저장소 정리 계획" "$d1/out.html"; then
  ok "15e title: real hidden char → (숨김 문자 1개 포함), literal [U+202E] text stays, h1 shows the mark"
else bad "15e title" "rc=$rc1/$rc2 t1=$t1 t2=$t2"; fi

# 16. (tier, action) allow-list = the engine's (M3); 17. no_local=1 with a local row (M4)
EXTRA=$(row 1 delete-remote feat/t1 "$OA" - x) c5 "16a tier1 delete-remote → error" "not allowed in tier 1"
EXTRA=$(row 3 delete-remote feat/t3 "$OA" - x) c5 "16b tier3 delete-remote → error" "not allowed in tier 3"
EXTRA=$(row 2 report remote:feat/t2 "$OA" - x) c5 "16c tier2 report → error" "not allowed in tier 2"
EXTRA=$(row 3 close-pr 'pr#5' "$OA" - x) c5 "16d tier3 close-pr → error" "not allowed in tier 3"
EXTRA=$(row 1 delete-local feat/nl "$OA" "$LSNAP" x) c5 "17 no_local=1 + delete-local row → error" "no_local=1 plan"

# 18. header I must be exactly default + integrate, Itips must cover I (S2)
HSED='s#I=develop,deploy/staging,deploy/stage2,main#I=develop,deploy/staging,main#' c5 "18a I without one integrate ref → error" "must be exactly default + integrate"
HSED='s#I=develop,deploy/staging,deploy/stage2,main#I=develop,deploy/staging,deploy/stage2,main,release#' c5 "18b I with an extra ref → error" "must be exactly default + integrate"
HSED="s#,main:$OC##" c5 "18c Itips missing an I ref → error" "Itips must name exactly"

# 19. delete rows whose recorded PR does not match the branch are flagged and listed (S3)
d=$(mk c19); { hdr; D feat/fine 501 develop a a@x.io 2026-02-02
  row 2 delete-remote feat/fork "$OA" "basis=a;pr=503;pr_base=develop;pr_head_repo=other/repo;pr_head_oid=$OA;pr_author=a;tip_author=a@x.io;tip_date=2026-02-02;pr_merge_commit=$OM" ev
  D feat/odd-base 504 release a a@x.io 2026-02-02; } > "$d/plan.tsv"
jr19() { local r; for r in feat/fine feat/fork feat/odd-base; do J 2 delete-remote "$r" merged-pr '' x; done; }
json x jr19 > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '기록된 PR 정보가 브랜치와 맞지 않는 삭제 후보 1개가 계획에 있습니다.' "$d/out.html" \
   && grep -qF '<li><code class="ref">feat/fork</code> <span class="muted">PR의 브랜치가 다른 저장소(other/repo)</span></li>' "$d/out.html" \
   && grep -qF '통합 브랜치가 아닌 대상으로 병합된 삭제 후보 1개가 계획에 있습니다.' "$d/out.html" \
   && grep -qF '<li><code class="ref">feat/odd-base</code> <span class="muted">병합 대상 <code class="ref">release</code></span></li>' "$d/out.html" \
   && [ "$(grep -c '<li><code class="ref">feat/fine</code>' "$d/out.html")" = 0 ]; then ok "19 other-repo PR and non-integration-base delete rows flagged with a list (display only, by design)"
else bad "19 mismatch flags" "rc=$rc $(head -c 160 "$d/stderr")"; fi

# 20. ref strictness: PR/issue numbers, git branch-name rules, report ref forms (S4)
EXTRA=$(row 3 report 'pr#07' "$OD" - x) c5 "20a report pr#07 → error" "unrecognised report ref"
EXTRA=$(row 3 report 'issue#0' "$OD" - x) c5 "20b report issue#0 → error" "unrecognised report ref"
EXTRA=$(row 3 report bare-name "$OD" - x) c5 "20c report ref without remote:/local: → error" "unrecognised report ref"
EXTRA=$(row 2 close-pr 'pr#0' "$OC" - x) c5 "20d close-pr pr#0 → error" "must look like"
for bad_ref in 'feat/a..b' 'feat/a%3Ab' 'feat/a b' 'feat/x.lock' '-lead' 'feat/' 'feat/a~1' 'feat/a^b' 'feat/a?b' 'feat/a*b' 'feat/a[b' 'feat/a\b' 'feat/a@{b'; do
  EXTRA=$(row 2 delete-remote "$bad_ref" "$OA" - x) c5 "20e delete-remote ref $bad_ref → error" "invalid branch name"
done
EXTRA=$(row 3 report 'remote:feat/a..b' "$OD" - x) c5 "20f kept remote:<bad name> → error" "invalid branch name"
for bad_ref in 'feat/.hidden' '.dot/start' 'feat/x.lock/y' '@'; do
  EXTRA=$(row 2 delete-remote "$bad_ref" "$OA" - x) c5 "20g delete-remote ref $bad_ref → error" "invalid branch name"
done
EXTRA=$(row 3 report 'remote:@' "$OD" - x) c5 "20h kept remote:@ → error" "invalid branch name"
EXTRA="$(row 1 delete-local feat/twin "$OA" "$LSNAP" x)
$(row 2 delete-local-force feat/twin "$OA" "$LSNAP" x)" c5n "20i delete-local X + delete-local-force X → error" "name the same local branch"
# 20j. the "." row (engine reason local-held) sits under the work-folder label, not with local branches
wt_block=$(awk '/>작업 폴더 목록 정리 — 이번 실행에서는 하지 않음</{on=1} on{print} on && /<\/details>/{exit}' "$H")
lb_block=$(awk '/>로컬 브랜치 — 이번 실행에서는 정리하지 않음</{on=1} on{print} on && /<\/details>/{exit}' "$H")
if printf '%s' "$wt_block" | grep >/dev/null -F '<span class="it">작업 폴더 목록</span>' && printf '%s' "$lb_block" | grep >/dev/null -F 'feat/held-local' \
   && ! printf '%s' "$lb_block" | grep >/dev/null -F '작업 폴더 목록'; then ok "20j work-folder row grouped under 작업 폴더 목록 정리, local-held branch stays with branches"
else bad "20j work-folder grouping" "work-folder row in the wrong group"; fi

# 21. prefix groups are case-insensitive (S5)
jr21() { local r; for r in IAC/1 IAC/2 IAC/3 iac/4 iac/5 iac/6; do J 2 delete-remote "$r" merged-pr '' x; done; }
d=$(mk c21); { hdr; n9=600; for r in IAC/1 IAC/2 IAC/3 iac/4 iac/5 iac/6; do n9=$((n9+1)); D "$r" "$n9" develop a a@x.io 2026-02-02; done; } > "$d/plan.tsv"
json x jr21 > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '<h3 id="g1">IAC/ 로 시작하는 브랜치</h3><span class="prefix mono ref">IAC/, iac/</span>' "$d/out.html" \
   && [ "$(grep -c '<h3 id="g' "$d/out.html")" = 1 ] && grep -A1 -F 'IAC/, iac/</span>' "$d/out.html" | grep >/dev/null -F '<b>6</b>개'; then
  ok "21 IAC/ and iac/ form one group listing both prefixes"
else bad "21 case-insensitive prefix" "rc=$rc"; fi

# 22. snapshot key sets = the engine's (S7)
EXTRA=$(row 3 report remote:feat/k "$OD" 'tip_date=2026-01-01;foo=1' x) c5 "22a unknown snapshot key on a kept row → error" "unknown snapshot key"
EXTRA=$(row 2 delete-remote feat/k "$OA" "basis=a;pr=1;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=$OA;pr_author=a;tip_author=a@x.io;tip_date=2026-01-01" x) \
  c5 "22b delete-remote without pr_merge_commit → error" "missing [pr_merge_commit]"
EXTRA=$(row 2 delete-remote feat/k "$OA" "basis=a;pr=1;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=$OA;pr_author=a;tip_author=a@x.io;tip_date=2026-01-01;pr_merge_commit=$OM;pr_state=MERGED" x) \
  c5 "22c delete-remote with an extra key → error" "not allowed [pr_state]"
EXTRA=$(row 2 delete-local feat/k "$OA" "$LSNAP;pr_author=a" x) c5n "22d delete-local with pr_author → error" "not allowed [pr_author]"
EXTRA=$(row 2 close-issue 'issue#44' 2026-08-01T00:00:00Z 'state=OPEN;updated=x;author=f;base=develop' x) c5 "22e close-issue with an extra key → error" "not allowed [base]"
EXTRA=$(row 1 worktree-prune . - 'a=1' x) c5n "22f worktree-prune with a snapshot → error" "worktree-prune snapshot must be -"

# 23. completeness per section: each plan row appears exactly once, in the section its action belongs to, as the
#     right kind of object (branch / local branch / PR / issue / work folder); counts of rows and cards match the TSV.
#     The plan side applies its own reveal of hidden characters (independent of the renderer); a .hid mark on the
#     page is read as the token {hid:U+XXXX}, so a literal "<U+202E>" in a name cannot pass for a revealed one.
for pair in "base:$B" "local rows:$T/c13" "bucketing:$T/c9d" "hidden chars:$T/c15"; do
  out=$("$PY" -I "$T/complete.py" "${pair#*:}/plan.tsv" "${pair#*:}/out.html"); rc=$?
  if [ "$rc" = 0 ]; then ok "23 completeness by section (${pair%%:*}): $out"; else bad "23 completeness (${pair%%:*})" "$out"; fi
done

# ── grok-4.7 post-review 2026-10-16 (handoffs/grok-review-chore-v41): the renderer takes only what apply takes ──
# 24. value codec = engine pdec (chore.sh AWK_LIB): encoded bytes are exactly 0x01-0x1F 0x7F % ; , = : (+ space in the
#     header), as %XX uppercase; every other byte raw. Non-canonical, non-ASCII, truncated and NUL escapes are errors.
EV_STALE='a %41 b' c5 "24a %41 (A needs no encoding) → error" "non-canonical percent-escape %41"
EV_STALE='a%20b' c5 "24b %20 in a row value (space stays raw in rows) → error" "non-canonical percent-escape %20"
EV_STALE='back%5Cslash' c5 "24c %5C (backslash needs no encoding) → error" "non-canonical percent-escape %5C"
EV_STALE='lone %ED byte' c5 "24d %ED alone (bytes >= 0x80 stay raw UTF-8) → error" "non-ASCII byte"
EV_STALE='rlo %E2%80%AE' c5 "24e percent-encoded UTF-8 %E2%80%AE → error" "non-ASCII byte"
EV_STALE='cut at the end %E' c5 "24f truncated %E at the end → error" "malformed percent-escape"
EV_STALE='nul %00 here' c5 "24g %00 → error" "NUL byte"
EV_STALE='raw : colon' c5 "24h raw ':' in a value → error" "unencoded ':'"
EV_STALE='raw ; semicolon' c5 "24i raw ';' in a value → error" "unencoded ';'"
EXTRA=$(row 3 report remote:extra/eq "$OD" 'tip_date=2026=01' x) c5 "24j raw '=' inside a snapshot value → error" "unencoded '='"
EXTRA=$(row 3 report remote:extra/key "$OD" 'tip%5Fdate=2026-01-01' x) c5 "24k encoded snapshot key tip%5Fdate → error" "non-canonical percent-escape %5F"
EXTRA=$(row 3 report 'remote%3Afeat/x' "$OD" - x) c5 "24l kept ref remote%3A… (prefix must be a raw remote:) → error" "unrecognised report ref"
HSED='s#created=2026-10-15T05%3A12%3A33Z#created=2026-10-15 05%3A12%3A33Z#' c5 "24m raw space in a header value → error" "unencoded ' '"
HSED='s#protect=r2s/\*#protect=r2s%2F*#' c5 "24n %2F in a header value → error" "non-canonical percent-escape %2F"
HSED='s#protect=r2s/\*#protect=r2s/*,bad%0Aline#' c5 "24o control character in a decoded header value → error" "control character in a value"
HSED="s#Ptips=develop:$OD#Ptips=:$OD#" c5 "24p Ptips item with an empty name → error" "empty name"
d=$(mk c24q); hdr | sed 's#protect=r2s/\*#protect=r2s/*,keep%20me/*#' > "$d/plan.tsv"; base_rows >> "$d/plan.tsv"
json x base_jrows > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '<code class="ref">keep me/*</code>' "$d/out.html" \
   && grep -qF "$(printf 'close-issue\tissue#9\t2026-08-01T00:00:00Z\t')" "$B/plan.tsv" && [ -s "$H" ]; then
  ok "24q engine forms accepted: %20 in a header value, raw ISO with ':' in expected (close-issue), raw space and UTF-8 in row values"
else bad "24q engine forms" "rc=$rc $(head -c 160 "$d/stderr")"; fi

# 25. branch-name rule = git check-ref-format --branch, asked here for every name (oracle = the installed git), with two
#     one documented difference: "@" alone is refused (git takes it as a branch name, but @ is HEAD's alias in revision
#     syntax — refusing is the narrower, safe side).
penc_row() { "$PY" -I -c 'import sys
out = bytearray()
for c in sys.argv[1].encode():
    out += b"%%%02X" % c if c < 0x20 or c == 0x7F or c in b"%;,=:" else bytes([c])
sys.stdout.buffer.write(bytes(out))' "$1"; }
git_branch_ok() { (cd "$T" && git check-ref-format --branch "$1" >/dev/null 2>&1); }
c25() { # c25 <name> [accept|reject = documented difference from git]
  local name="$1" d g want rc
  d=$(mk "c25-$n"); if git_branch_ok "$name"; then g=accept; else g=reject; fi
  want="${2:-$g}"
  if [ -n "${2:-}" ] && [ "$want" = "$g" ]; then bad "25 name $(printf '%q' "$name")" "listed as a difference but git now says $g"; return; fi
  { hdr; base_rows; D "$(penc_row "$name")" 900 develop a a@x.io 2026-02-02; } > "$d/plan.tsv"
  json x base_jrows "$(J 2 delete-remote "$name" merged-pr '' x)" > "$d/plan.json"; render "$d"; rc=$?
  if [ "$want" = accept ] && [ "$rc" = 0 ]; then ok "25 name $(printf '%q' "$name") → accepted (git: $g)"
  elif [ "$want" = reject ] && [ "$rc" != 0 ] && grep -qF 'invalid branch name' "$d/stderr"; then ok "25 name $(printf '%q' "$name") → refused (git: $g)"
  else bad "25 name $(printf '%q' "$name")" "want $want (git: $g), rc=$rc $(head -c 120 "$d/stderr")"; fi
}
for nm in 'a]b' 'a{b' 'a}b' 'a@b' '@a' 'a/@' '@@' 'a.lockb' 'a.lock.b' 'a/-x' 'a!b' 'a%b' 'a,b' 'a;b' 'a=b' "a'b" 'a#b' \
          'a<b' 'a|b' 'a$b' 'a&b' 'feat/HEAD' 'é/ü' 'feat/.hidden' '.a' 'x.lock' 'foo.lock/bar' 'y/.lock' 'a/./b' 'a..b' \
          'a@{b' 'a.' 'a/' '/a' 'a//b' 'a b' 'a~b' 'a^b' 'a:b' 'a?b' 'a*b' 'a[b' 'a\b' $'a\x7fb' $'a\x01b' '-x'; do
  c25 "$nm"
done
c25 '@' reject
c25 'HEAD'

# 26. --repo-url: links go to github.com only — https, no user info / port / query / fragment, exactly <owner>/<repo>
for u in 'https://evil.example/test/repo' 'http://github.com/test/repo' 'https://github.com@evil.example/test/repo' \
         'https://user@github.com/test/repo' 'https://github.com:443/test/repo' 'https://www.github.com/test/repo' \
         'https://GITHUB.com/test/repo' 'https://github.com/test/repo.git' 'https://github.com/x/test/repo' \
         'https://github.com/test/repo?tab=1' 'https://github.com/test/repo#x' 'https://github.com/test/..'; do
  d=$(mk "c26-$n"); cp "$B/plan.tsv" "$B/plan.json" "$d/"
  render "$d" --repo-url "$u"; rc=$?
  if [ "$rc" != 0 ] && [ ! -e "$d/out.html" ] && grep -qF 'must be https://github.com/<owner>/<repo>' "$d/stderr"; then ok "26 --repo-url $u → error"
  else bad "26 --repo-url $u" "rc=$rc $(head -c 120 "$d/stderr")"; fi
done

# 27. each delete group shows its apply --only-group key(s) beside the title (engine grp: first prefix + "/*", or the
#     bare name); a key missing from the header groups= list is flagged (apply refuses it as --only-group)
miss=""
for want in '<span class="prefix mono ref">deploy/</span><span class="gkey">실행 그룹 키 <code class="ref">deploy/*</code></span></div>' \
            '<span class="gkey">실행 그룹 키 <code class="ref">feat/*</code>, <code class="ref">feature/*</code></span></div>' \
            '<span class="gkey">실행 그룹 키 <code class="ref">fix/*</code>, <code class="ref">hotfix/*</code></span></div>' \
            '<span class="prefix">접두사 없음</span><span class="gkey">실행 그룹 키 = 브랜치마다 이름 그대로</span></div>' \
            '<span class="gkey">실행 그룹 키 <code class="ref">wip/*</code></span></div>' \
            '그룹 제목 옆 <b>실행 그룹 키</b>는 그 그룹만 골라 지울 때 실행 명령(--only-group)에 넣는 값입니다.'; do
  grep -qF -- "$want" "$H" || miss="$miss [$want]"
done
if [ -z "$miss" ] && ! grep -q 'id="gkey-missing-' "$H"; then ok "27a base page: group keys beside every delete-group title, none missing from groups="
else bad "27a group keys" "missing:$miss"; fi
if grep -qF '그 밖의 접두사 브랜치</h3><span class="prefix mono ref">batch/, PROJ-3136/, proj-4082/</span><span class="gkey">실행 그룹 키 <code class="ref">batch/*</code>, <code class="ref">PROJ-3136/*</code>, <code class="ref">proj-4082/*</code></span>' "$H9" \
   && [ "$(grep -c 'id="gkey-missing-' "$H9")" = 2 ] \
   && grep -qF '그룹으로 골라 실행할 수 없는 키: <code class="ref">batch/*</code>, <code class="ref">PROJ-3136/*</code>, <code class="ref">proj-4082/*</code></span>' "$H9" \
   && grep -qF '그룹으로 골라 실행할 수 없는 키: <code class="ref">iac/*</code></span>' "$H9" \
   && ! grep -F 'deploy/</span>' "$H9" | grep >/dev/null 'gkey-missing'; then
  ok "27b merged bucket lists every key; keys absent from groups= flagged (iac/*, batch/*, PROJ-3136/*, proj-4082/*), deploy/* not"
else bad "27b group keys / missing flag" "$(grep -o 'id="gkey-missing-[^>]*>' "$H9" | tr '\n' ' ')"; fi

# 28. the step-1 batch is a group ONE --only-group key selects (exactly one key, present in groups=): deploy first, else
#     the largest such group; none → "1단계 생략, 한 번에 실행" (SKILL step 6 path), never a multi-key group as one batch
c28() { # c28 <dir-name> <refs...> → renders a delete-only plan with base groups=, sets $d and $rc
  local r k=700; d=$(mk "$1"); shift
  { hdr; for r in "$@"; do k=$((k+1)); D "$r" "$k" develop a a@x.io 2026-02-02; done; } > "$d/plan.tsv"
  { printf '{"plan_sha256":"%s","header":{"remote":"test/repo","run_id":"%s"},"rows":[' "$Z64" "$RUN"
    for r in "$@"; do J 2 delete-remote "$r" merged-pr '' x; done | paste -sd, - | tr -d '\n'; printf ']}\n'; } > "$d/plan.json"
  render "$d"; rc=$?
}
c28 c28a feature/x feat/y batch/a ops/b
if [ "$rc" = 0 ] && grep -qF '<li id="step1-skip">1단계 생략, 한 번에 실행 — 실행 그룹 키 하나로 고를 수 있는 그룹이 없습니다.</li>' "$d/out.html" \
   && grep -qF '1단계 없이 전체를 이 순서로 한 번에 실행합니다: PR <b>0</b>개·이슈 <b>0</b>개 닫기 → 브랜치 <b>4</b>개 삭제.' "$d/out.html" \
   && ! grep -qF '먼저 삭제' "$d/out.html" && ! grep -qF '나머지 브랜치' "$d/out.html" && ! grep -q '실행 1단계 대상' "$d/out.html"; then
  ok "28a no group selectable by one key (feat/*+feature/*, batch/*+ops/*) → 1단계 생략, 한 번에 실행"
else bad "28a step-1 skip" "rc=$rc $(grep -o '<li[^>]*>[^<]*먼저[^<]*' "$d/out.html" | head -2) $(head -c 160 "$d/stderr")"; fi
c28 c28b Deploy/a deploy/b fix/c
if [ "$rc" = 0 ] && ! grep -q '실행 1단계 대상' "$d/out.html" \
   && grep -qF '실행 그룹 키 하나로 고를 수 있는 그룹 중 가장 큰 수정 브랜치 <b>1</b>개를 먼저 삭제하고(실행 그룹 키 <code class="ref">fix/*</code>)' "$d/out.html" \
   && grep -qF '<span class="gkey">실행 그룹 키 <code class="ref">Deploy/*</code>, <code class="ref">deploy/*</code></span>' "$d/out.html"; then
  ok "28b deploy group with two keys (Deploy/*, deploy/*) is not step 1; the one-key fix/* group is, no badge"
else bad "28b two-key deploy group" "rc=$rc $(grep -o '<li>[^<]*먼저[^<]*' "$d/out.html") $(head -c 160 "$d/stderr")"; fi
c28 c28c iac/1 iac/2 iac/3 iac/4 iac/5 feat/a
if [ "$rc" = 0 ] && grep -qF '실행 그룹 키 하나로 고를 수 있는 그룹 중 가장 큰 기능 브랜치 <b>1</b>개를 먼저 삭제하고(실행 그룹 키 <code class="ref">feat/*</code>)' "$d/out.html" \
   && ! grep -qF 'iac/ 로 시작하는 브랜치 <b>5</b>개를 먼저' "$d/out.html"; then
  ok "28c a one-key group whose key is not in groups= (iac/*, 5 rows) is passed over for feat/* (1 row)"
else bad "28c key outside groups=" "rc=$rc $(grep -o '<li>[^<]*먼저[^<]*' "$d/out.html") $(head -c 160 "$d/stderr")"; fi
if grep -qF '배포 승격용 브랜치 <b>2</b>개를 먼저 삭제하고(실행 그룹 키 <code class="ref">deploy/*</code>)' "$H" \
   && [ "$(grep -o '실행 1단계 대상' "$H" | wc -l | tr -d ' ')" = 1 ]; then
  ok "28d base page: one-key deploy group is step 1, badge + its key in the step sentence"
else bad "28d deploy step 1" "$(grep -o '<li>[^<]*먼저[^<]*' "$H")"; fi

# 29. a plan apply refuses (chore.sh P_PARSE, per-action value checks + header run_id / tips oids) is refused here too,
#     with the engine's wording; each case adds the engine JSON row so a parser that took the row would render (rc 0).
#     Two checks stay display-only by design (case 19): pr_base outside I, pr_head_repo of another repo.
UP=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
DSN="basis=a;pr=1;pr_base=develop;pr_head_repo=test/repo;pr_head_oid=$OA;pr_author=a;tip_author=a@x.io;tip_date=2026-01-01;pr_merge_commit=$OM"
CPS="state=OPEN;updated=2026-09-01T03%3A04%3A05Z;head_repo=test/repo;head_ref=feat/h;head_oid=$OC;base=develop;author=erin"
CIS="state=OPEN;updated=2026-08-01T00%3A00%3A00Z;author=frank"; CIX=2026-08-01T00:00:00Z
JD=$(J 2 delete-remote feat/k29 merged-pr '' x); JP=$(J 3 report 'pr#50' open-pr '' 'Old PR' pull-requests)
JI=$(J 3 report 'issue#51' open-issue '' 'Old issue' issues)
c29d() { EXTRA=$(row 2 delete-remote feat/k29 "$1" "$2" x) JEXTRA="$JD" c5 "$3" "$4"; }
c29d "$UP" "${DSN//$OA/$UP}" "29a delete-remote expected not lowercase 40-hex → error" "expected must be a 40-hex oid"
c29d "$OA" "${DSN/basis=a/basis=b}" "29b basis=b → error" "unsupported basis"
c29d "$OA" "${DSN/pr=1;/pr=12a;}" "29c pr=12a → error" "snapshot pr must be a number"
c29d "$OA" "${DSN/pr_head_oid=$OA/pr_head_oid=$OB}" "29d PR head oid ≠ expected tip → error" "snapshot pr_head_oid differs from expected"
c29d "$OA" "${DSN/pr_merge_commit=$OM/pr_merge_commit=1234}" "29e pr_merge_commit not 40-hex → error" "snapshot pr_merge_commit must be a 40-hex oid"
c29d "$OA" "${DSN/pr_base=develop/pr_base=a..b}" "29f pr_base not a branch name → error" "invalid snapshot pr_base"
EXTRA=$(row 1 delete-local feat/k29l "$OA" "${LSNAP/basis=a/basis=b}" x) JEXTRA=$(J 1 delete-local feat/k29l merged-pr '' x) \
  c5n "29g delete-local basis=b → error" "unsupported basis"
JRUN=2026-10-15 HSED="s#run_id=$RUN#run_id=2026-10-15#" c5 "29h run_id not YYYYMMDDTHHMMSSZ-<8 hex> → error" "header run_id malformed"
HSED="s#Itips=develop:$OD#Itips=develop:$UP#" c5 "29i Itips oid not lowercase 40-hex → error" "malformed name:oid element"
HSED="s#Ptips=develop:$OD#Ptips=develop:dddd#" c5 "29j Ptips oid too short → error" "malformed name:oid element"
c29p() { EXTRA=$(row 2 close-pr 'pr#50' "$1" "$2" "$3") JEXTRA="$JP" c5 "$4" "$5"; }
c29p "$OC" "$CPS" '' "29k close-pr with an empty comment → error" "close-pr evidence (the comment to post) is empty"
c29p "$UP" "${CPS//$OC/$UP}" bye "29l close-pr expected not 40-hex → error" "close-pr expected must be the 40-hex head oid"
c29p "$OC" "${CPS/state=OPEN/state=CLOSED}" bye "29m close-pr state=CLOSED → error" "snapshot state must be OPEN"
c29p "$OC" "${CPS/head_oid=$OC/head_oid=$OB}" bye "29n close-pr head_oid ≠ expected → error" "snapshot head_oid differs from expected"
c29p "$OC" "${CPS/updated=2026-09-01T03%3A04%3A05Z/updated=2026-09-01}" bye "29o close-pr updated not ISO → error" "snapshot updated must be an ISO timestamp"
c29p "$OC" "${CPS/head_ref=feat\/h/head_ref=}" bye "29p close-pr empty head_ref → error" "snapshot head_ref / head_repo must not be empty"
c29i() { EXTRA=$(row 2 close-issue 'issue#51' "$1" "$2" "$3") JEXTRA="$JI" c5 "$4" "$5"; }
c29i "$CIX" "$CIS" '' "29q close-issue with an empty comment → error" "close-issue evidence (the comment to post) is empty"
c29i '2026-08-01T00%3A00%3A00Z' "$CIS" bye "29r close-issue expected percent-encoded (not the raw ISO) → error" "close-issue expected must be the ISO updatedAt"
c29i "$CIX" "${CIS/state=OPEN/state=CLOSED}" bye "29s close-issue state=CLOSED → error" "snapshot state must be OPEN"
c29i "$CIX" "${CIS/2026-08-01T/2026-08-02T}" bye "29t close-issue updated ≠ expected → error" "snapshot updated differs from expected"
EXTRA=$(row 1 worktree-prune . "$OA" - x) c5n "29u worktree-prune with an expected oid → error" "worktree-prune row must be . - -"

# 30. --only-group key = the engine's grp(ref, action), called from the engine's own AWK_LIB over a name corpus
#     (pr#… / issue#… branches, report pr#N / issue#N, ".", case, multi-level paths, bytes the codec encodes; Jira rows →
#     jira, move-issue rows → move — both refused as --only-group by the engine, never offered by the page).
#     The engine sees the encoded ref (structural remote:/local: prefix raw) and the user types the decoded key.
awk "/^AWK_LIB='\$/{on=1; next} on && /^'\$/{exit} on{print}" "$ENGINE" > "$T/awklib.awk" 2>/dev/null
diff_ok() { # diff_ok <case> <what> <corpus> <renderer out> <renderer rc> <engine out> <engine rc> — a differential passes
  # only when both processes exit 0, each prints exactly one line per corpus line, and the outputs are byte-identical
  # (an awk that prints everything and then fails in END, or a renderer that stops early, is a FAIL)
  local nc nr ne
  nc=$(wc -l < "$3" | tr -d ' '); nr=$(wc -l < "$4" | tr -d ' '); ne=$(wc -l < "$6" | tr -d ' ')
  if [ "$5" != 0 ] || [ "$7" != 0 ]; then
    bad "$1" "exit status renderer=$5 engine=$7: $(head -c 120 "$4.err" 2>/dev/null) | $(head -c 120 "$6.err" 2>/dev/null)"
  elif [ "$nr" != "$nc" ] || [ "$ne" != "$nc" ]; then bad "$1" "row counts corpus=$nc renderer=$nr engine=$ne"
  elif cmp -s "$4" "$6"; then ok "$1 = engine $2 on all $nc corpus rows (both exit 0, $nc rows each)"
  else bad "$1" "$(diff "$6" "$4" | grep -c '^<') of $nc rows differ; first: $(diff "$6" "$4" | grep '^[<>]' | head -4 | tr '\t\n' '| ')"; fi
}
cat > "$T/grp.awk" <<'AWK'
{ r = $2; p = ""; if (r ~ /^(remote|local):/) { p = substr(r, 1, index(r, ":")); r = substr(r, length(p) + 1) }
  k = grp(p penc(r, 0), $1); d = pdec(k, 0); if (_bad) d = "<undecodable:" k ">"; print $1 "\t" $2 "\t" d }
AWK
"$PY" -I -B -c 'import sys
names = ["pr#topic/a", "pr#topic", "pr#12", "PR#12", "pr#", "issue#topic/a", "issue#3", "Issue#3/x", "feat/x", "Feat/X",
         "a/b/c", "deploy/staging/x", "PROJ-1", "noslash", "a,b/c", "x%y/z", "semi;colon/x", "a=b/c", "é/ü", "@a/b"]
rows = []
for a in ("delete-remote", "delete-local", "delete-local-force"):
    rows += [(a, n) for n in names]
rows += [("report", p + n) for p in ("remote:", "local:") for n in names]
rows += [("report", r) for r in ("pr#12", "pr#007", "issue#3", ".")]
rows += [("close-pr", "pr#7"), ("close-pr", "pr#12"), ("close-issue", "issue#9"), ("worktree-prune", ".")]
rows += [("move-issue", "issue#11"), ("move-issue", "issue#3"), ("jira-transition", "jira#TST-101"), ("report", "jira#TST")]
sys.stdout.write("".join("%s\t%s\n" % r for r in rows))' > "$T/grp.corpus"
"$PY" -I -B -c 'import importlib.util, sys
spec = importlib.util.spec_from_file_location("chore_render", sys.argv[1]); m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
for line in open(sys.argv[2], encoding="utf-8").read().splitlines():
    a, ref = line.split("\t")
    print("%s\t%s\t%s" % (a, ref, m.only_group_key(ref, a)))' "$R" "$T/grp.corpus" > "$T/grp.render" 2>"$T/grp.render.err"; rc_r=$?
LC_ALL=C awk -F'\t' -f "$T/awklib.awk" -f "$T/grp.awk" "$T/grp.corpus" > "$T/grp.engine" 2>"$T/grp.engine.err"; rc_e=$?
if ! grep -q '^function grp(' "$T/awklib.awk"; then bad "30 grp differential" "no AWK_LIB grp in $ENGINE"
else diff_ok "30 --only-group key" "grp(ref, action)" "$T/grp.corpus" "$T/grp.render" "$rc_r" "$T/grp.engine" "$rc_e"
fi

# 31. the rows the page names as step 1 = the delete-remote rows apply selects with that --only-group key (engine grp
#     over the plan's encoded refs); a pr#topic/… / issue#topic/… branch group is never the pull-requests / issues key
cat > "$T/sel.awk" <<'AWK'
NR > 1 && $2 == "delete-remote" && grp($3, $2) == penc(ENVIRON["CH_K"], 0) { print pdec($3, 0) }
AWK
printf '{ print grp($2, $1) }\n' > "$T/one.awk"
TAB=$'\t'
c31() { # c31 <name> <branch-1> <branch-2> <close row> <close JSON row> <type key>
  local d k page_rows eng_rows tk
  d=$(mk "c31-$n")
  { hdr | sed "s|${TAB}groups=[^${TAB}]*|${TAB}groups=${2%%/*}/*,pull-requests,issues,deploy/*|"; D "$2" 801 develop a a@x.io 2026-02-02
    D "$3" 802 develop a a@x.io 2026-02-02; printf '%s\n' "$4"; } > "$d/plan.tsv"
  { printf '{"plan_sha256":"%s","header":{"remote":"test/repo","run_id":"%s"},"rows":[' "$Z64" "$RUN"
    { J 2 delete-remote "$2" merged-pr '' x; J 2 delete-remote "$3" merged-pr '' x; printf '%s\n' "$5"; } | paste -sd, - | tr -d '\n'
    printf ']}\n'; } > "$d/plan.json"
  render "$d"; rc=$?
  k=$("$PY" -I -c 'import html, re, sys
h = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"먼저 삭제하고\(실행 그룹 키 <code class=\"ref\">([^<]*)</code>\)", h)
print(html.unescape(m.group(1)) if m else "")' "$d/out.html" 2>/dev/null)
  page_rows=$("$PY" -I -c 'import html, re, sys
h, k = open(sys.argv[1], encoding="utf-8").read(), sys.argv[2]
for b in h.split("<div class=\"group del\">")[1:]:
    b = b.split("</section>")[0].split("<div class=\"group")[0]
    if "<span class=\"gkey\">실행 그룹 키 <code class=\"ref\">%s</code></span>" % html.escape(k, quote=True) in b:
        print("\n".join(sorted(html.unescape(x) for x in re.findall(r"<span class=\"it\"><code class=\"ref\">([^<]*)</code>", b))))' "$d/out.html" "$k" 2>/dev/null)
  CH_K="$k" LC_ALL=C awk -F'\t' -f "$T/awklib.awk" -f "$T/sel.awk" "$d/plan.tsv" > "$d/eng.rows" 2>"$d/eng.err"; rce=$?
  eng_rows=$(sort "$d/eng.rows")
  printf '%s\n' "$4" | cut -f2,3 | LC_ALL=C awk -F'\t' -f "$T/awklib.awk" -f "$T/one.awk" > "$d/tk" 2>>"$d/eng.err"; rct=$?
  tk=$(cat "$d/tk")   # the close row's key
  if [ "$rce" != 0 ] || [ "$rct" != 0 ] || [ "$(wc -l < "$d/tk" | tr -d ' ')" != 1 ]; then
    bad "$1" "engine awk exit status sel=$rce key=$rct, key lines=$(wc -l < "$d/tk" | tr -d ' '): $(head -c 120 "$d/eng.err")"
  elif [ "$rc" = 0 ] && [ "$k" = "${2%%/*}/*" ] && [ "$tk" = "$6" ] && [ -n "$page_rows" ] && [ "$page_rows" = "$eng_rows" ] \
     && ! grep -qF "<code class=\"ref\">$6</code>" "$d/out.html"; then
    ok "$1: step-1 key $k, close row key $tk; page rows = engine --only-group rows ($(printf '%s' "$page_rows" | tr '\n' ' '))"
  else bad "$1" "rc=$rc key=[$k] close-key=[$tk] page=[$(printf '%s' "$page_rows" | tr '\n' ' ')] engine=[$(printf '%s' "$eng_rows" | tr '\n' ' ')] $(head -c 120 "$d/stderr")"; fi
}
c31 "31a pr#topic/… branches vs PR closes" 'pr#topic/a' 'pr#topic/b' \
  "$(row 2 close-pr 'pr#7' "$OC" "state=OPEN;updated=2026-09-01T03%3A04%3A05Z;head_repo=test/repo;head_ref=feat/old-idea;head_oid=$OC;base=develop;author=erin" bye)" \
  "$(J 3 report 'pr#7' open-pr '' 'Old PR' pull-requests)" pull-requests
c31 "31b issue#topic/… branches vs issue closes" 'issue#topic/a' 'issue#topic/b' \
  "$(row 2 close-issue 'issue#9' 2026-08-01T00:00:00Z 'state=OPEN;updated=2026-08-01T00%3A00%3A00Z;author=frank' bye)" \
  "$(J 3 report 'issue#9' open-issue '' 'Old issue' issues)" issues

# 32. header created = a non-empty canonical UTC timestamp (apply / verify refuse anything else)
HSED='s#created=2026-10-15T05%3A12%3A33Z#created=#' c5 "32a empty created → error" "header created must be a UTC timestamp"
HSED='s#created=2026-10-15T05%3A12%3A33Z#created=2026-10-15#' c5 "32b created without a time → error" "header created must be a UTC timestamp"
HSED='s#created=2026-10-15T05%3A12%3A33Z#created=2026-10-15T05%3A12%3A33+09%3A00#' c5 "32c created with an offset (not Z) → error" "header created must be a UTC timestamp"

# 33. a refused --repo-url never echoes its text: a token in user info or the query stays off stdout and stderr
for u in 'https://x-access-token:tok-XYZ123@github.com/test/repo' 'https://github.com/test/repo?access_token=tok-XYZ123' \
         'https://tok-XYZ123@evil.example/test/repo'; do
  d=$(mk "c33-$n"); cp "$B/plan.tsv" "$B/plan.json" "$d/"
  render "$d" --repo-url "$u"; rc=$?
  if [ "$rc" != 0 ] && [ ! -e "$d/out.html" ] && grep -qF 'must be https://github.com/<owner>/<repo>' "$d/stderr" \
     && ! grep -qF 'tok-XYZ123' "$d/stdout" "$d/stderr"; then ok "33 --repo-url with a token refused, token on neither stream (${u%%tok-*}…)"
  else bad "33 token echo" "rc=$rc $(grep -c 'tok-XYZ123' "$d/stdout" "$d/stderr" | tr '\n' ' ')"; fi
done

# 34. iso = the engine's iso(x) (a calendar-valid UTC time), called from the engine's own function library: AWK_LIB plus
#     the plan parser's function definitions (P_PARSE up to its BEGIN rule, where iso lives) — differential over boundaries,
#     Feb 29 (2024 2025 2000 1900 2100 2400), the 31st of 30-day months, 24h / 60m / 60s, and malformed shapes
{ cat "$T/awklib.awk"; awk "/^P_PARSE='\$/{on=1; next} on && /^BEGIN/{exit} on{print}" "$ENGINE"; } > "$T/isolib.awk" 2>/dev/null
printf '{ print (iso($0) ? 1 : 0) "\\t" $0 }\n' > "$T/iso.awk"
"$PY" -I -B -c 'import sys
v = ["0000-01-01T00:00:00Z", "0000-02-29T00:00:00Z", "1970-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "2026-10-15T05:12:33Z"]
for y in ("2024", "2025", "2000", "1900", "2100", "2400"):
    v += ["%s-02-28T12:00:00Z" % y, "%s-02-29T12:00:00Z" % y, "%s-02-30T12:00:00Z" % y]
last = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
for mo in range(0, 14):
    v += ["2023-%02d-01T00:00:00Z" % mo]
    if 1 <= mo <= 12:
        v += ["2023-%02d-%02dT00:00:00Z" % (mo, last[mo - 1]), "2023-%02d-%02dT00:00:00Z" % (mo, last[mo - 1] + 1)]
v += ["2023-%02d-31T00:00:00Z" % mo for mo in (4, 6, 9, 11)] + ["2023-01-00T00:00:00Z", "2023-01-32T00:00:00Z", "2023-01-39T00:00:00Z"]
v += ["2023-01-01T%02d:00:00Z" % h for h in (0, 23, 24, 29)] + ["2023-01-01T00:%02d:00Z" % m for m in (0, 59, 60, 69)]
v += ["2023-01-01T00:00:%02dZ" % s for s in (0, 59, 60, 61, 69)]
v += ["", "2023-01-01T00:00:00", "2023-01-01T00:00:00z", "2023-01-01t00:00:00Z", "2023-01-01 00:00:00Z", "2023-1-01T00:00:00Z",
      "2023-01-01T00:00:00+00:00", "2023-01-01T00:00:00.000Z", "2023-01-01T00:00:00ZZ", " 2023-01-01T00:00:00Z", "20230101T000000Z",
      "23-01-01T00:00:00Z", "+2023-01-01T00:00:00Z", "2023-01-01T00:00Z", "２０２３-01-01T00:00:00Z", "2023-01-01T00:00:0٠Z"]
sys.stdout.write("".join(x + "\n" for x in v))' > "$T/iso.corpus"
"$PY" -I -B -c 'import importlib.util, sys
spec = importlib.util.spec_from_file_location("chore_render", sys.argv[1]); m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
for x in open(sys.argv[2], encoding="utf-8").read().split("\n")[:-1]:
    print("%d\t%s" % (1 if m.iso_ok(x) else 0, x))' "$R" "$T/iso.corpus" > "$T/iso.render" 2>"$T/iso.render.err"; rc_r=$?
LC_ALL=C awk -f "$T/isolib.awk" -f "$T/iso.awk" "$T/iso.corpus" > "$T/iso.engine" 2>"$T/iso.engine.err"; rc_e=$?
if ! grep -q '^function iso(' "$T/isolib.awk"; then bad "34 iso differential" "no iso function in $ENGINE (AWK_LIB / P_PARSE)"
else diff_ok "34 iso (calendar UTC time)" "iso(x)" "$T/iso.corpus" "$T/iso.render" "$rc_r" "$T/iso.engine" "$rc_e"; fi

# 35. calendar-invalid times in a plan are refused wherever the engine calls iso: header created, close-pr updated,
#     close-issue expected; a real Feb 29 renders
HSED='s#created=2026-10-15T05%3A12%3A33Z#created=2025-02-29T05%3A12%3A33Z#' c5 "35a created 2025-02-29 (not a leap year) → error" "header created must be a UTC timestamp"
HSED='s#created=2026-10-15T05%3A12%3A33Z#created=2026-10-15T05%3A12%3A60Z#' c5 "35b created with second 60 → error" "header created must be a UTC timestamp"
c29p "$OC" "${CPS/updated=2026-09-01T03%3A04%3A05Z/updated=2026-09-01T24%3A00%3A00Z}" bye "35c close-pr updated at 24:00 → error" "snapshot updated must be an ISO timestamp"
c29i '2026-04-31T00:00:00Z' "${CIS/2026-08-01T00%3A00%3A00Z/2026-04-31T00%3A00%3A00Z}" bye "35d close-issue expected 2026-04-31 → error" "close-issue expected must be the ISO updatedAt"
d=$(mk c35e); hdr | sed 's#created=2026-10-15T05%3A12%3A33Z#created=2024-02-29T23%3A59%3A59Z#' > "$d/plan.tsv"; base_rows >> "$d/plan.tsv"
json x base_jrows > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '2024-03-01 08:59 KST' "$d/out.html"; then ok "35e created 2024-02-29T23:59:59Z (leap day) renders, shown as 2024-03-01 08:59 KST"
else bad "35e leap-day created" "rc=$rc $(head -c 160 "$d/stderr")"; fi

# ── chore v4 (2026-10-19): Jira 옮기기 cards, 결정 필요 cards, judged kept rows, inventory check ─────────────────────
# Contract fixtures from __tests__/fixtures/chore-v4/ (shared with chore_plan / engine / build / report) plus one
# fixture generated here with chore_plan's own encoders (hostile text, ordering, every owner kind). Expected numbers come
# from v4facts.py, which decodes the TSV with urllib only (not with the renderer or chore_plan).
V4="$SKILL/__tests__/fixtures/chore-v4"
cat > "$T/v4facts.py" <<'PY'
import re, sys, urllib.parse
u = urllib.parse.unquote
c = dict.fromkeys(("branches", "prs", "issues", "jira_qa", "jira_closed", "ambiguous", "kept", "not_judged", "local", "move"), 0)
inv = {}
for line in open(sys.argv[1], encoding="utf-8").read().split("\n")[1:]:
    if not line:
        continue
    col = line.split("\t")
    action, ref = col[1], u(col[2])
    snap = {} if col[4] == "-" else {u(k): u(v) for k, v in (p.split("=", 1) for p in col[4].split(";"))}
    ev1 = u(col[5])
    if action == "delete-remote": c["branches"] += 1
    elif action == "close-pr": c["prs"] += 1
    elif action == "close-issue": c["issues"] += 1
    elif action == "move-issue": c["move"] += 1
    elif action == "jira-transition":
        c["jira_qa" if snap["level"] == "TO-QA" else "jira_closed"] += 1
        inv.setdefault(ref[5:].rsplit("-", 1)[0], {"total": None, "moved": 0, "kept": 0, "excluded": 0})["moved"] += 1
    elif action == "report":
        if re.fullmatch(r"jira#[A-Z][A-Z0-9]+", ref):
            d = dict(p.split("=", 1) for p in ev1.split(";"))
            inv.setdefault(ref[5:], {"total": None, "moved": 0, "kept": 0, "excluded": 0})["total"] = int(u(d["total"]))
            continue
        v = None
        if ref.startswith("jira#"):
            v = u(dict(p.split("=", 1) for p in ev1.split(";"))["v"])
        elif col[4] != "-" and col[4].split(";")[-1].startswith("verdict="):   # structured pr/issue row: last key
            v = u(col[4].split(";")[-1][len("verdict="):])
        if ref.startswith("jira#"):
            inv.setdefault(ref[5:].rsplit("-", 1)[0], {"total": None, "moved": 0, "kept": 0, "excluded": 0})[
                "excluded" if v in ("EXCLUDED", "NOT-JUDGED") else "kept"] += 1
        if v == "AMBIGUOUS": c["ambiguous"] += 1
        else:
            c["kept"] += 1
            if v == "NOT-JUDGED" and not ref.startswith("jira#"): c["not_judged"] += 1
    else: c["local"] += 1
for k, v in c.items():
    print("%s=%d" % (k, v))
for p, d in sorted(inv.items()):
    assert d["total"] == d["moved"] + d["kept"] + d["excluded"], (p, d)
    print("inv %s %d %d %d %d" % (p, d["total"], d["moved"], d["kept"], d["excluded"]))
print("confirm=PR 닫기 %d · 이슈 닫기 %d · 브랜치 삭제 %d · Jira → QA %d · Jira 닫기 %d%s · 결정 필요 %d" % (
    c["prs"], c["issues"], c["branches"], c["jira_qa"], c["jira_closed"],
    " · Jira로 옮기기 %d건" % c["move"] if c["move"] else "", c["ambiguous"]))
PY
# v4_check <name> <dir>: every tile / confirm number and every inventory line = v4facts over the plan TSV
v4_check() {
  local name="$1" d="$2" facts miss="" k v id line p tot mv kp ex txt want
  facts=$("$PY" -I "$T/v4facts.py" "$d/plan.tsv") || { bad "$name" "oracle failed"; return; }
  for k in branches prs issues jira_qa jira_closed ambiguous kept not_judged; do
    v=$(printf '%s\n' "$facts" | sed -n "s/^$k=//p"); id="n-$(printf '%s' "$k" | tr _ -)"
    grep -qF "id=\"$id\">$v<" "$d/out.html" || miss="$miss [$id=$v]"
  done
  for k in prs issues branches jira_qa jira_closed ambiguous; do
    v=$(printf '%s\n' "$facts" | sed -n "s/^$k=//p"); id="c-$(printf '%s' "$k" | tr _ -)"
    grep -qF "id=\"$id\">$v<" "$d/out.html" || miss="$miss [$id=$v]"
  done
  # move-issue rows: tile n-move and confirm c-move exactly when the plan has them (absent otherwise — the page without
  # move rows is byte-identical to the one before move support, case 52l)
  v=$(printf '%s\n' "$facts" | sed -n 's/^move=//p')
  for id in n-move c-move; do
    if [ "$v" != 0 ]; then grep -qF "id=\"$id\">$v<" "$d/out.html" || miss="$miss [$id=$v]"
    elif grep -qF "id=\"$id\"" "$d/out.html"; then miss="$miss [$id present without move rows]"; fi
  done
  while read -r line p tot mv kp ex; do
    [ "$line" = inv ] || continue
    for want in "id=\"inv-total-$p\">$tot<" "id=\"inv-moved-$p\">$mv<" "id=\"inv-kept-$p\">$kp<" "id=\"inv-excluded-$p\">$ex<"; do
      grep -qF "$want" "$d/out.html" || miss="$miss [$want]"; done
  done <<EOF
$facts
EOF
  txt=$("$PY" -I -c 'import html, re, sys
m = re.search(r"<span id=\"confirm\">(.*?)</span></p>", open(sys.argv[1], encoding="utf-8").read())
print(html.unescape(re.sub(r"<[^>]+>", "", m.group(1))) if m else "")' "$d/out.html")
  want=$(printf '%s\n' "$facts" | sed -n 's/^confirm=//p')
  [ "$txt" = "$want" ] || miss="$miss [confirm '$txt' != '$want']"
  if [ -z "$miss" ]; then ok "$name: tiles, confirm line and inventory ids = rows ($(printf '%s' "$facts" | grep -E '^(jira_qa|jira_closed|ambiguous|kept|not_judged)=' | tr '\n' ' ')$(printf '%s\n' "$facts" | grep '^inv' | tr '\n' ' '))"
  else bad "$name" "missing:$miss"; fi
}
# v4_links <name> <dir>: every href is a repo PR/issue link, a browse link on the inventory site or a run link the plan's
# own move rows carry; a URL outside an href only inside a posted-comment block or a ticket-description preview
# (<details class="pv"> — description text quoted from the issue, never a link)
v4_links() {
  local out
  [ -s "$2/out.html" ] || { bad "$1" "no page to check ($2/out.html missing)"; return; }
  out=$("$PY" -I -c 'import re, sys, urllib.parse
h = open(sys.argv[1], encoding="utf-8").read()
run = set()
for line in open(sys.argv[2], encoding="utf-8").read().split("\n")[1:]:
    col = line.split("\t")
    if len(col) == 6 and col[1] == "jira-transition":
        run |= {urllib.parse.unquote(p[len("run_url="):]) for p in col[4].split(";") if p.startswith("run_url=")}
bad = [x for x in re.findall(r"href=\"([^\"]*)\"", h) if not (re.fullmatch(r"https://github\.com/test/repo/(pull|issues)/[0-9]+(#issuecomment-[0-9]+)?", x)
       or re.fullmatch(r"https://example\.atlassian\.net/browse/[A-Z][A-Z0-9]+-[0-9]+", x) or x in run)]
rest = re.sub(r"<div class=\"comment\">.*?</div>|<details class=\"pv\">.*?</details>", "", re.sub(r"href=\"[^\"]*\"", "", h), flags=re.S)
bad += re.findall(r"https?://\S{0,40}", rest)
print(" ".join(bad))' "$2/out.html" "$2/plan.tsv")
  if [ -z "$out" ]; then ok "$1: every link is a repo / Jira browse / deploy run link; other URLs only inside comments"
  else bad "$1" "stray: $out"; fi
}
# v4_nohex <name> <dir> <digest>: no full 40-hex sha on the page (S, merge, commit) — only the plan / engine fingerprints
v4_nohex() {
  [ -s "$2/out.html" ] || { bad "$1" "no page to check ($2/out.html missing)"; return; }
  local hx; hx=$(grep -oE '[0-9a-f]{40,}' "$2/out.html" | sort -u | grep -vxF -e "$3" -e "$Z64" | tr '\n' ' ')
  if [ -z "$hx" ]; then ok "$1: no full commit hash on the page (12-digit prefixes only)"; else bad "$1" "$hx"; fi
}
v4codes='TO-QA|TO-CLOSED|AMBIGUOUS|NOT-JUDGED|EXCLUDED|jira-transition|close_basis|ledgers|run_url|to_status|status_name|%3D|;v=|reason=|owner=|decider=|recommend='
jv4() { J 2 delete-remote feat/login-form merged-pr '' x; J 3 report 'pr#7' open-pr '' 'Old idea: experimental search' pull-requests
  J 3 report 'issue#9' open-issue '' '검색 결과가 비어 있음' issues; J 3 report 'pr#8' open-pr '' x; J 3 report 'issue#10' open-issue '' x; }
jv4u() { J 3 report 'pr#21' open-pr '' x; J 3 report 'issue#22' open-issue '' x; J 3 report 'pr#23' open-pr '' x; J 3 report 'pr#24' open-pr '' x; }
jnone() { :; }

# 36. valid.tsv (contract fixture): renders; tiles / confirm line / inventory numbers recomputed from the rows
A4=$(mk v4a); cp "$V4/valid.tsv" "$A4/plan.tsv"; S4=$(sha "$A4/plan.tsv"); json x jv4 > "$A4/plan.json"; render "$A4"; rc=$?; H4="$A4/out.html"
if [ "$rc" = 0 ] && [ -s "$H4" ]; then ok "36 contract fixture valid.tsv renders"; else bad "36 valid.tsv renders" "rc=$rc $(head -c 200 "$A4/stderr")"; fi
v4_check "36b valid.tsv" "$A4"
v4_links "36c valid.tsv" "$A4"
v4_nohex "36d valid.tsv" "$A4" "$S4"
if grep -nE "$v4codes" "$H4" >/dev/null; then bad "36e no plan codes on the page" "$(grep -noE "$v4codes" "$H4" | head -5 | tr '\n' ' ')"
else ok "36e no plan codes (levels, verdicts, snapshot keys, encoded evidence) on the page"; fi

# 37. Jira 옮기기 cards: key → browse link, summary, status → target, level, items, deploy run, requirement lines, the exact
#     comment (decoded once, escaped, line breaks kept), sorted by key, inside the Jira section
jt101=$(awk '/<article class="card" aria-labelledby="jt-TST-101">/{on=1} on{print} on && /<\/article>/{exit}' "$H4")
jt102=$(awk '/<article class="card" aria-labelledby="jt-TST-102">/{on=1} on{print} on && /<\/article>/{exit}' "$H4")
miss=""
for want in '<h3 id="jt-TST-101"><a class="it" href="https://example.atlassian.net/browse/TST-101">TST-101</a> 로그인 폼 검증 추가, 오류 문구 정리</h3>' \
            '<p class="say">현재 상태 개발 완료 → QA (staging) <span class="flag">배포 확인됨</span></p>' \
            '<p class="who">Jira 마지막 갱신 2026-10-19 06:07 KST</p>' \
            '<dt>필요한 변경</dt><dd><ul class="xlist"><li><a href="https://github.com/test/repo/pull/12">PR #12</a> 병합됨 · 병합 커밋 <code>222222222222</code></li><li>커밋 <code>333333333333</code></li></ul></dd>' \
            '<dt>관련 있지만 필요하지 않음</dt><dd><ul class="xlist"><li><a href="https://github.com/test/repo/pull/13">PR #13</a> 닫힘 · <span class="muted">대체됨</span></li></ul></dd>' \
            '<dt>배포</dt><dd><a href="https://github.com/test/repo/actions/runs/9000000001">배포 실행 #9000000001</a> · 배포 기준 커밋 <code>bbbbbbbbbbbb</code></dd>' \
            '<li>로그인 폼 입력값 검증 (이메일, 비밀번호) <span class="muted">→</span> <a href="https://github.com/test/repo/pull/12">PR #12</a></li>' \
            '<li>오류 문구: 한글로 통일 =&gt; 화면 확인; 100% 반영 <span class="muted">→</span> 커밋 <code>333333333333</code></li>' \
            '<p class="say">이 댓글을 남기고 옮깁니다</p>'; do
  printf '%s' "$jt101" | grep >/dev/null -F -- "$want" || miss="$miss [$want]"; done
for want in '<h3 id="jt-TST-102"><a class="it" href="https://example.atlassian.net/browse/TST-102">TST-102</a> 로그인 폼 검증 (중복)</h3>' \
            '<p class="say">현재 상태 할 일 → Closed <span class="flag">중복·대체</span></p>' '<p class="who">Jira 마지막 갱신 2026-10-19 07:07 KST</p>' \
            '<dt>닫는 근거</dt><dd>중복 — 같은 작업을 하는 티켓: <a href="https://example.atlassian.net/browse/TST-101">TST-101</a></dd>'; do
  printf '%s' "$jt102" | grep >/dev/null -F -- "$want" || miss="$miss [$want]"; done
for want in '<span class="lbl">Jira → QA</span>' \
            '<p class="muted">배포 확인 = 바인딩의 deploy-proof 워크플로가 성공한 push 실행에 포함됨 — 지금 그 환경이 그 코드라는 뜻은 아님</p>'; do
  grep >/dev/null -F -- "$want" "$H4" || miss="$miss [$want]"; done
if [ -z "$miss" ]; then ok "37 Jira cards: browse link, summary, status → target, level, items, deploy run link, requirement lines, close basis"
else bad "37 Jira card fields" "missing:$miss"; fi
if "$PY" -I -c 'import html, sys, urllib.parse
h = open(sys.argv[1], encoding="utf-8").read()
for line in open(sys.argv[2], encoding="utf-8").read().split("\n")[1:]:
    col = line.split("\t")
    if len(col) == 6 and col[1] == "jira-transition":
        key = urllib.parse.unquote(col[2])[5:]
        card = h.split("aria-labelledby=\"jt-%s\">" % key, 1)[1].split("</article>", 1)[0]
        want = "<div class=\"comment\">%s</div>" % html.escape(urllib.parse.unquote(col[5]), quote=True)
        if want not in card or card.count("<div class=\"comment\">") != 1:
            sys.exit("comment of %s differs" % key)' "$H4" "$A4/plan.tsv"; then ok "37b each Jira card shows the exact comment to be posted (decoded once, escaped)"
else bad "37b Jira comment verbatim" "comment block differs"; fi
order=$(grep -oE 'aria-labelledby="jt-[A-Z0-9-]+"' "$H4" | paste -sd' ' -)
sec=$(awk '/<h2 id="s-jira">/{on=1} /<\/section>/{on=0} on' "$H4" | grep -c '<article class="card" aria-labelledby="jt-')
if [ "$order" = 'aria-labelledby="jt-TST-101" aria-labelledby="jt-TST-102"' ] && [ "$sec" = 2 ] \
   && awk '/id="s-close"/{c=NR} /id="s-jira"/{j=NR} /id="s-ambig"/{a=NR} /id="s-held"/{h=NR} END{exit !(c < j && j < a && a < h)}' "$H4"; then
  ok "37c Jira cards sorted by key inside 'Jira 옮기기', which sits after 닫을 PR·이슈; 결정이 필요한 것 before 이번에 남기는 것"
else bad "37c Jira card order / sections" "order=$order in-section=$sec"; fi
if grep -qF 'Jira 프로젝트 <span class="it">TST</span> — 담당 Jira 미완료 <b id="inv-total-TST">4</b>건 = 옮김 <b id="inv-moved-TST">2</b> + 남김/결정 필요 <b id="inv-kept-TST">1</b> + 제외 <b id="inv-excluded-TST">1</b>' "$H4" \
   && grep -qF '검색 조건 <code>project = TST AND assignee = currentUser() AND statusCategory != Done ORDER BY key</code> · 사이트 <code>example.atlassian.net</code>' "$H4"; then
  ok "37d inventory line per project: total from the search row = moved + kept/ambiguous + excluded rows, with the search and site"
else bad "37d inventory line" "line missing"; fi

# 38. 결정이 필요한 것: AMBIGUOUS units as cards grouped by owner, every field, no action (said once)
amb=$(awk '/<h2 id="s-ambig">/{on=1} on{print} on && /<\/section>/{exit}' "$H4")
miss=""
for want in '<h3 id="o4">작성자 alice에게 물어볼 것</h3>' '<h4 id="amb-TST-103"><a class="it" href="https://example.atlassian.net/browse/TST-103">TST-103</a> <span class="muted">(제목 기록 없음)</span></h4>' \
            '<p class="say">PR #15는 합쳐졌지만 비밀번호 재설정 요구사항이 PR에 없습니다</p>' '<dt>확인된 것</dt><dd>PR #15 develop에 합쳐짐; staging 배포에 포함</dd>' \
            '<dt>확인 안 된 것</dt><dd>비밀번호 재설정이 다른 작업으로 옮겨졌는지</dd>' '<dt>정할 사람</dt><dd>기획 담당</dd>' \
            '<dt>추천</dt><dd>요구사항을 나눌지 정해 주세요, 나누면 이 티켓을 QA로</dd>' '<dt>근거</dt><dd><a href="https://github.com/test/repo/pull/15">PR #15</a></dd>' \
            '<dt>연결된 Jira</dt><dd><a href="https://example.atlassian.net/browse/TST-90">TST-90</a> (In Progress), <a href="https://example.atlassian.net/browse/TST-91">TST-91</a> (Done: 확인, 보류)</dd>'; do
  printf '%s' "$amb" | grep >/dev/null -F -- "$want" || miss="$miss [$want]"; done
if [ -z "$miss" ] && [ "$(grep -o '이번 실행은 이 항목들에 아무것도 하지 않습니다' "$H4" | wc -l | tr -d ' ')" = 1 ]; then
  ok "38 결정 필요 card: owner group, title + link, reason, known / missing / decider / recommend, cites, linked tickets; 'no action' said once"
else bad "38 결정 필요 card" "missing:$miss"; fi

# 39. judged PR/issue rows (valid-units.tsv): AMBIGUOUS card, KEEP with reason, NOT-JUDGED with last update + author, plain row as today
U4=$(mk v4u); cp "$V4/valid-units.tsv" "$U4/plan.tsv"; json x jv4u > "$U4/plan.json"; render "$U4"; rc=$?; HU="$U4/out.html"
v4_check "39 valid-units.tsv" "$U4"
grp_of() { awk -v t="$2" 'index($0, ">" t "</h3>"){on=1} on{print} on && /<\/details>/{exit}' "$1"; }
keep=$(grp_of "$HU" '내용을 확인하고 남기는 PR·이슈'); recent=$(grp_of "$HU" '최근 30일 안에 갱신 — 판정 제외'); plain=$(grp_of "$HU" '열린 PR — 손대지 않음')
miss=""
printf '%s' "$keep" | grep >/dev/null -F '<a class="it" href="https://github.com/test/repo/issues/22">이슈 #22</a></span><span class="c"><span class="sr">근거</span>로그아웃 후 세션이 남는 문제<span class="muted"> — </span>재현 절차가 있고 아직 해결 PR이 없습니다</span>' || miss="$miss [keep]"
printf '%s' "$recent" | grep >/dev/null -F '<p class="gmeta"><b>1</b>개 · 마지막 갱신 2026-10-12</p>' || miss="$miss [recent gmeta]"
printf '%s' "$recent" | grep >/dev/null -F '업로드 진행률 표시<span class="muted"> — </span>최근 30일 안에 갱신 — 판정 제외</span><span class="c"><span class="sr">기록</span><span class="kv"><span class="muted">작성자</span>dave</span><span class="kv"><span class="muted">마지막 갱신</span>2026-10-12 18:00 KST</span>' || miss="$miss [recent row]"
printf '%s' "$plain" | grep >/dev/null -F '<a class="it" href="https://github.com/test/repo/pull/24">PR #24</a></span><span class="c"><span class="sr">근거</span>로그인 화면 문구 정리</span>' || miss="$miss [plain]"
grep -qF '<h3 id="o1">작성자 dave에게 물어볼 것</h3>' "$HU" || miss="$miss [owner]"
grep -qF '<h4 id="amb-pr-21"><a class="it" href="https://github.com/test/repo/pull/21">PR #21</a> 검색창 자동완성 실험</h4>' "$HU" || miss="$miss [amb title]"
grep -qF '<p class="who">작성자 dave · 마지막 갱신 2026-07-01 18:00 KST</p>' "$HU" || miss="$miss [amb who]"
grep -qF '<dt>연결된 Jira</dt><dd>TST-77 (In Progress)</dd>' "$HU" || miss="$miss [unlinked TST-77: no Jira project in this plan]"
grep -qF '<p class="muted">이 계획에는 Jira 항목이 없습니다.</p>' "$HU" || miss="$miss [no jira line]"
if [ "$rc" = 0 ] && [ -z "$miss" ] && ! grep -nE "$v4codes" "$HU" >/dev/null; then
  ok "39b judged PR/issue rows: KEEP + reason, NOT-JUDGED group (last update, author), plain title row, AMBIGUOUS card; no Jira project → key not linked"
else bad "39b judged PR/issue rows" "rc=$rc missing:$miss $(grep -noE "$v4codes" "$HU" | head -3 | tr '\n' ' ')"; fi

# 40. Jira-only plan (valid-jira-units.tsv): AMBIGUOUS Jira card with snapshot summary + status, EXCLUDED Jira in its group
J4=$(mk v4j); cp "$V4/valid-jira-units.tsv" "$J4/plan.tsv"; json x jnone > "$J4/plan.json"; render "$J4"; rc=$?; HJ="$J4/out.html"
v4_check "40 valid-jira-units.tsv" "$J4"
ex=$(grp_of "$HJ" '판정에서 제외한 Jira 티켓')
if [ "$rc" = 0 ] && grep -qF '<h3 id="o1">QA 담당에게 물어볼 것</h3>' "$HJ" \
   && grep -qF '<h4 id="amb-TST-201"><a class="it" href="https://example.atlassian.net/browse/TST-201">TST-201</a> 결제 화면: 금액 표시, 오류; 100% 확인</h4>' "$HJ" \
   && grep -qF '<p class="who">현재 상태 In Progress</p>' "$HJ" \
   && printf '%s' "$ex" | grep >/dev/null -F '<a class="it" href="https://example.atlassian.net/browse/TST-202">TST-202</a></span><span class="c"><span class="sr">근거</span>알림 설정 저장 안 됨<span class="muted"> — </span>보류 상태(jira-hold)라 판정하지 않음</span><span class="c"><span class="sr">기록</span><span class="kv"><span class="muted">현재 상태</span>보류 (외부 대기)</span>' \
   && grep -qF '<p class="muted">이 계획에는 옮길 Jira 티켓이 없습니다.</p>' "$HJ" && ! grep -q 'id="step-jira"' "$HJ"; then
  ok "40b Jira units: AMBIGUOUS card (snapshot summary + status), EXCLUDED row with reason and status, no move step"
else bad "40b Jira units" "rc=$rc $(head -c 200 "$J4/stderr")"; fi

# 41. engine JSON join: Jira rows are never "뺀 항목" nor a mismatch; an engine-only row still counts; drift note names them
if grep -qF '계획에서 뺀 항목 0개' "$H4" && grep -qF '이 페이지가 확인한 차이: 닫기 2행 추가, Jira 5행 추가, 0행 제외 — 그 밖의 차이는 확인하지 않음' "$H4" \
   && grep -qF '이 페이지가 확인한 차이: 닫기 0행 추가, 판정 기록이 붙은 PR·이슈 3행, 0행 제외' "$HU" \
   && grep -qF '이 페이지가 확인한 차이: 닫기 0행 추가, Jira 3행 추가, 0행 제외' "$HJ"; then
  ok "41 Jira rows and judged PR/issue rows join without errors, 0 removed; drift note counts them"
else bad "41 v4 join" "$(grep -o '이 페이지가 확인한 차이[^<]*' "$H4" "$HU" "$HJ" | tr '\n' ' ')"; fi
d=$(mk v4x); cp "$V4/valid.tsv" "$d/plan.tsv"
json x jv4 "$(J 3 report remote:spike/removed stale '' x)" "$(J 2 jira-transition 'jira#TST-101' '' '' x)" > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '계획에서 뺀 항목 1개' "$d/out.html" && grep -qF '<li><code class="ref">spike/removed</code> <span class="muted">남기는 항목</span></li>' "$d/out.html"; then
  ok "41b an engine row for a Jira ref is consumed, not removed; a real engine-only row is still listed as removed"
else bad "41b engine-only rows" "rc=$rc $(grep -o '계획에서 뺀 항목 [0-9]*개' "$d/out.html" 2>/dev/null)"; fi

# 42. run order: Jira moves only in the full run, never in the one-group step; undo line; base page has none of it
if grep -qF '<li id="step-full">나머지를 이 순서로 한 번에 실행합니다: PR <b>1</b>개·이슈 <b>1</b>개 닫기 → Jira 티켓 <b>2</b>건 옮기기 → 나머지 브랜치 <b>0</b>개 삭제. 끝나면 원격에서 사라졌는지와 보호 브랜치가 그대로인지 확인합니다. <span id="step-jira">Jira 티켓은 이 전체 실행에서만 옮기고(그룹 하나만 골라 지우는 1단계 실행에서는 옮기지 않음), 티켓마다 댓글을 먼저 남긴 뒤 상태를 바꿉니다.</span></li>' "$H4" \
   && grep -qF '옮긴 Jira 티켓은 Jira에서 이전 상태로 다시 옮기고 남긴 댓글을 고칠 수 있습니다.' "$H4" \
   && ! grep -q 'id="step-jira"' "$H" && ! grep -qF '옮긴 Jira 티켓' "$H" && grep -qF '<p class="muted">이 계획에는 Jira 항목이 없습니다.</p>' "$H" \
   && grep -qF '<span id="confirm">PR 닫기 <b id="c-prs">1</b> · 이슈 닫기 <b id="c-issues">1</b> · 브랜치 삭제 <b id="c-branches">9</b> · Jira → QA <b id="c-jira-qa">0</b> · Jira 닫기 <b id="c-jira-closed">0</b> · 결정 필요 <b id="c-ambiguous">0</b></span>' "$H" \
   && grep -qF ' · 로컬 정리 <b id="c-local">2</b></span>' "$H13"; then
  ok "42 run order states Jira moves run only in the full run (not step 1); base page: no Jira step, confirm line with zeros; local count appended when present"
else bad "42 run order / confirm" "step or confirm line wrong"; fi

# 43. hostile + ordering fixture, generated with chore_plan's encoders: HTML and bidi / zero-width text in summary, status,
#     target name, requirement text, comment, reason fields, owner login and the search; keys TST-9 / TST-10; every owner kind
G4=$(mk v4g)
"$PY" -I - "$SKILL/scripts/chore_plan.py" "$V4/valid.tsv" "$G4/plan.tsv" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("chore_plan", sys.argv[1]); P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
hdr = open(sys.argv[2], "rb").read().split(b"\n")[0]
A = "712020:00000000-0000-0000-0000-000000000001"
def row(tier, action, ref, expected, snap, ev):
    return b"\t".join([tier, action, ref.encode(), expected.encode(), snap, ev])
def jt(key, expected, comment, **kw):
    snap = dict(site="example.atlassian.net", project="TST", issue_id="1" + key.split("-")[1], status="20001",
                status_name="할 일", assignee=A, account=A, to="31", to_status="20004", to_name="QA (staging)", summary="",
                level="TO-QA", S="-", run="-", run_url="-", items="-", reqs="-", close_basis="-", ledgers="-")
    snap.update(kw)
    text = comment + "\n" + P.MARKER_FMT % (snap["to_name"], "2026-10-19")
    return row(b"2", b"jira-transition", "jira#" + key, expected, P.encode_snapshot({k: snap[k] for k in P.JIRA_SNAP_KEYS}), P.penc(text))
def ev(v, reason, **kw):
    d = dict(v=v, reason=reason)
    d.update(kw)
    return d
def ju(key, summary, status, e):
    snap = P.encode_jira_unit_snapshot(summary, status) if summary else b"-"
    return row(b"3", b"report", "jira#" + key, "-", snap, P.encode_jira_evidence(e))
def pu(num, title, e, author="dave"):
    oid = "%040x" % (0xabc000 + num)
    snap = P.encode_snapshot(dict(state="OPEN", updated="2026-07-01T09:00:00Z", head_repo="test/repo", head_ref="feat/p%d" % num,
                                  head_oid=oid, base="develop", author=author, verdict=e["v"]))
    return row(b"3", b"report", "pr#%d" % num, oid, snap, P.encode_unit_evidence(dict(e, t=title)))
def iu(num, title, e, updated="2026-07-02T00:00:00Z"):
    snap = P.encode_snapshot(dict(state="OPEN", updated=updated, author="frank", verdict=e["v"]))
    return row(b"3", b"report", "issue#%d" % num, updated, snap, P.encode_unit_evidence(dict(e, t=title)))
amb = dict(known="확인됨 <b>굵게</b>", missing="모름\u200b", decider="기획 <담당>", recommend="정해 주세요 & 알려 주세요")
rows = [
    jt("TST-10", "2026-10-19T06:07:25.160+0900", '<img src=x onerror=alert(1)> 저장소 정리 & "확인" \u202e거꾸로\u202c 끝\t탭',
       status_name="개발 <i>완료</i>\u2066", to_name="QA <i>staging</i>", summary='결제 <script>alert(1)</script> & "q" \u202e\u200b끝',
       S="b" * 40, run="77", run_url="https://github.com/test/repo/actions/runs/77",
       items=P.encode_items([dict(kind="pr", pr=40, state="MERGED", role="required", sha="4" * 40),
                             dict(kind="c", sha="5" * 40, role="required"),
                             dict(kind="pr", pr=41, state="OPEN", role="unrelated", sha=None)]),
       reqs=P.encode_reqs([dict(text="<b>굵게</b> 요구\u200b사항, 하나: =>", target="pr:40"), dict(text="두 번째", target="c:" + "5" * 40)])),
    jt("TST-9", "2026-10-18T17:07:25.160-0500", "저장소 정리 중 확인했습니다. PR #5로 대체되었습니다. 근거: PR #5. 그래서 닫습니다.",
       to="41", to_status="20191", to_name="Closed", summary="옛 결제 화면", level="TO-CLOSED", close_basis="superseded:pr:5",
       ledgers=P.encode_ledgers(["/home/me/.claude/chore ledger <x>.tsv", "/tmp/a,b;c=d:e%f/잠금 => 원장.json"])),
    ju("TST-11", '요약 <script>alert(2)</script>\u200b끝', "In Progress",
       ev("AMBIGUOUS", "이유 \u202e거꾸로", owner="me", complete="no",
          cites="jira:TST-9, c:" + "6" * 40 + ", path:src/<a>\u200b.py:absent, pr:5:merged, issue#7, path:docs/<b>\u2060.md, "
                "알 수 없는 <근거>\u202e",
          jira=[dict(key="TST-9", status="할 <s>일</s>\u200b"), dict(key="OTH-1", status="Done")], **amb)),
    ju("TST-12", "담당 모름", "Waiting", ev("AMBIGUOUS", "누가 정할지 모름", owner="unknown", **amb)),
    ju("TST-13", "남길 <i>티켓</i>\u2060", "Ready <b>to</b>\u200b work",
       ev("KEEP", "아직 <작업> 중\u202e", complete="no", jira=[dict(key="TST-12", status="Waiting <u>x</u>\u2066")])),
    ju("TST-14", "다른 저장소 작업", "Review", ev("TO-QA", "변경이 다른 저장소에 있음")),
    ju("TST-15", "", "", ev("NOT-JUDGED", "이번에는 제외")),
    ju("TST-16", "닫자는 의견 티켓", "To Do", ev("TO-CLOSED", "중복으로 보임")),
    row(b"3", b"report", "jira#TST", "-", b"-",
        P.encode_inventory_evidence(8, "project = TST AND assignee = currentUser() <x> \u2060", "example.atlassian.net")),
    pu(31, "PR 제목 <svg onload=alert(3)>\u2060", ev("AMBIGUOUS", "작성자에게 물어봄", owner="author:b<o>b", **amb)),
    iu(32, "이슈 제목 하나", ev("AMBIGUOUS", "만든 사람 확인", owner="creator", **amb)),
    pu(33, "PR 제목 둘", ev("AMBIGUOUS", "앨리스 확인", owner="author:alice", **amb)),
    iu(34, "최근 이슈", ev("NOT-JUDGED", "최근 30일 안에 갱신 — 판정 제외"), updated="2026-10-12T20:00:00Z"),
    iu(35, "내 이슈", ev("AMBIGUOUS", "직접 확인", owner="me", **amb)),
    iu(36, "이슈 <u>제목</u>\u200b", ev("KEEP", "재현됨 <em>확인</em>\u2066", complete="no")),
    iu(37, "QA 확인 이슈", ev("AMBIGUOUS", "QA 확인", owner="qa-team", **amb)),
]
open(sys.argv[3], "wb").write(hdr + b"\n" + b"\n".join(rows) + b"\n")
P.parse_plan(open(sys.argv[3], "rb").read())
PY
jv4g() { J 3 report 'pr#31' open-pr '' x; J 3 report 'issue#32' open-issue '' x; J 3 report 'pr#33' open-pr '' x
  J 3 report 'issue#34' open-issue '' x; J 3 report 'issue#35' open-issue '' x; J 3 report 'issue#36' open-issue '' x
  J 3 report 'issue#37' open-issue '' x; }
json x jv4g > "$G4/plan.json"; render "$G4"; rc=$?; HG="$G4/out.html"
if [ "$rc" = 0 ]; then ok "43 generated hostile fixture renders"; else bad "43 hostile fixture" "rc=$rc $(head -c 200 "$G4/stderr")"; fi
v4_check "43b hostile fixture" "$G4"
v4_links "43c hostile fixture" "$G4"
v4_nohex "43d hostile fixture" "$G4" "$(sha "$G4/plan.tsv")"
if [ "$(grep -cE '<script|<img|<svg|<i>|<b>굵게|<담당>|<x>|b<o>b' "$HG")" = 0 ] \
   && grep -qF '&lt;img src=x onerror=alert(1)&gt;' "$HG" && grep -qF 'QA &lt;i&gt;staging&lt;/i&gt;' "$HG" && grep -qF '작성자 b&lt;o&gt;b에게 물어볼 것' "$HG" \
   && "$PY" -I -c 'import sys; h=open(sys.argv[1],encoding="utf-8").read(); sys.exit(any(c in h for c in "\u202e\u202c\u200b\u2060\u2066"))' "$HG" \
   && "$PY" -I "$T/complete.py" --page-marks "$HG" >/dev/null && grep -q 'id="hid-legend"' "$HG"; then
  ok "43e hostile text escaped everywhere (summary, status, target, requirement, comment, reason fields, owner, search); no raw bidi / zero-width character; legend = marks"
else bad "43e hostile escaping" "$(grep -oE '<script|<img|<svg|<i>|<b>굵게|<담당>' "$HG" | head -3 | tr '\n' ' ')"; fi
out=$("$PY" -I -c 'import html, sys
h = open(sys.argv[1], encoding="utf-8").read()
def v(s):
    s = html.escape(s, quote=True)
    for c in "\u202e\u202c\u200b\u2060\u2066":
        m = "U+%04X" % ord(c)
        s = s.replace(c, "<span class=\"hid\" role=\"img\" aria-label=\"숨김 문자 %s\" title=\"숨김 문자 %s\">%s</span>" % (m, m, m))
    return s
card = h.split("aria-labelledby=\"jt-TST-10\">", 1)[1].split("</article>", 1)[0]
want = [
    "<h3 id=\"jt-TST-10\"><a class=\"it\" href=\"https://example.atlassian.net/browse/TST-10\">TST-10</a> %s</h3>" % v("결제 <script>alert(1)</script> & \"q\" \u202e\u200b끝"),
    "<p class=\"say\">현재 상태 %s → %s <span class=\"flag\">배포 확인됨</span></p>" % (v("개발 <i>완료</i>\u2066"), v("QA <i>staging</i>")),
    "<li>%s <span class=\"muted\">→</span> <a href=\"https://github.com/test/repo/pull/40\">PR #40</a></li>" % v("<b>굵게</b> 요구\u200b사항, 하나: =>"),
    "<li><a href=\"https://github.com/test/repo/pull/41\">PR #41</a> 열림 · <span class=\"muted\">관련 없음</span></li>",
    "<div class=\"comment\">%s</div>" % v("<img src=x onerror=alert(1)> 저장소 정리 & \"확인\" \u202e거꾸로\u202c 끝\t탭\nchore 정리 → QA <i>staging</i> — by Claude triage 2026-10-19"),
]
amb = h.split("aria-labelledby=\"amb-TST-11\">", 1)[1].split("</article>", 1)[0]
want_amb = ["<p class=\"say\">%s</p>" % v("이유 \u202e거꾸로"), "<dt>확인된 것</dt><dd>%s</dd>" % v("확인됨 <b>굵게</b>"),
            "<dt>확인 안 된 것</dt><dd>%s</dd>" % v("모름\u200b"), "<dt>정할 사람</dt><dd>%s</dd>" % v("기획 <담당>"),
            "<dt>추천</dt><dd>%s</dd>" % v("정해 주세요 & 알려 주세요")]
miss = [x for x in want if x not in card] + [x for x in want_amb if x not in amb]
if "검색 조건 <code>%s</code>" % v("project = TST AND assignee = currentUser() <x> \u2060") not in h:
    miss.append("search line")
print(" | ".join(miss))' "$HG" 2>&1)
if [ -z "$out" ]; then ok "43f hostile card fields exact: summary, status → target, requirement, item, comment, reason fields, search (escaped + marked)"
else bad "43f hostile exact fields" "missing: $out"; fi
order=$(grep -oE 'aria-labelledby="jt-[A-Z0-9-]+"' "$HG" | paste -sd' ' -)
owners=$(awk '/<h2 id="s-ambig">/{on=1} /<h2 id="s-held">/{on=0} on && /<h3 id="o[0-9]+">/' "$HG" | sed -E 's/.*<h3 id="o[0-9]+">([^<]*)<\/h3>.*/\1/' | paste -sd'|' -)
me_cards=$(awk '/>직접 정할 것</{on=1} on && /<h3 id="o/ && !/직접 정할 것/{exit} on' "$HG" | grep -oE 'aria-labelledby="amb-[a-zA-Z0-9-]+"' | paste -sd' ' -)
if [ "$order" = 'aria-labelledby="jt-TST-9" aria-labelledby="jt-TST-10"' ] \
   && [ "$owners" = '직접 정할 것|작성자 alice에게 물어볼 것|작성자 b&lt;o&gt;b에게 물어볼 것|티켓을 만든 사람에게 물어볼 것|QA 담당에게 물어볼 것|정할 사람이 아직 정해지지 않은 것' ] \
   && [ "$me_cards" = 'aria-labelledby="amb-issue-35" aria-labelledby="amb-TST-11"' ] \
   && grep -A1 -F '>직접 정할 것</h3>' "$HG" | grep >/dev/null -F '<p class="gmeta"><b>2</b>건</p>'; then
  ok "43g Jira cards by key number (TST-9 before TST-10); owner groups me → author:<login> → creator → qa-team → unknown; PR, issue, Jira inside a group"
else bad "43g ordering" "jira=[$order] owners=[$owners] me=[$me_cards]"; fi
miss=""
for want in '<dt>닫는 근거</dt><dd>다른 작업으로 대체됨 — 대신한 PR: <a href="https://github.com/test/repo/pull/5">PR #5</a></dd>' \
            '<dt>증거</dt><dd><span class="flag">일부 누락</span> 증거를 다 모으지 못한 채 판정함</dd>' \
            '다른 저장소 작업<span class="muted"> — </span>판정 의견은 QA로 옮기기 — 이 계획에서 배포를 확인하지 않아 옮기지 않음. 판정 이유: 변경이 다른 저장소에 있음</span>' \
            '닫자는 의견 티켓<span class="muted"> — </span>판정 의견은 닫기 — 이 계획에서 근거를 확인하지 않아 닫지 않음. 판정 이유: 중복으로 보임</span>' \
            '<a class="it" href="https://example.atlassian.net/browse/TST-15">TST-15</a></span><span class="c"><span class="sr">근거</span><span class="muted">(제목 기록 없음)</span><span class="muted"> — </span>이번에는 제외' \
            '<span id="step-jira">Jira 티켓은 이 전체 실행에서만 옮기고, 티켓마다 댓글을 먼저 남긴 뒤 상태를 바꿉니다.</span></li>' \
            '내용을 보고도 판단을 끝내지 못한 PR <b>2</b>개, 이슈 <b>3</b>개, Jira 티켓 <b>2</b>건입니다.'; do
  grep -qF -- "$want" "$HG" || miss="$miss [$want]"; done
held=$(awk '/<h2 id="s-held">/{on=1} /<h2 id="s-run">/{on=0} on' "$HG")
if [ -z "$miss" ] && [ "$(grp_of "$HG" '판정에서 제외한 Jira 티켓' | grep -c 'class="it"')" = 1 ] \
   && [ "$(grp_of "$HG" '내용을 확인하고 남기는 Jira 티켓' | grep -c 'class="it"')" = 3 ] \
   && ! printf '%s' "$held" | grep >/dev/null -F '배포 확인됨' && ! printf '%s' "$held" | grep >/dev/null -F '중복·대체'; then
  ok "43h close basis by PR, partial evidence flag, tier-3 move verdicts as opinion only (no deploy-proof / close-basis words in the kept list), no-summary row"
else bad "43h hostile fixture details" "missing:$miss $(printf '%s' "$held" | grep -oE '.{0,20}(배포 확인됨|중복·대체).{0,20}' | head -2)"; fi
# 43i. every display path of judged text escapes and marks: kept Jira summary + reason, kept Jira status, kept linked-Jira
#      status, judged issue title + reason, partial-evidence mark on KEEP rows, the 결정 필요 card's linked-Jira status, raw and
#      path cites — each expected string below disappears if its vis() is removed (raw <…> instead of &lt;…&gt;, no marks)
out=$("$PY" -I -c 'import html, sys
h = open(sys.argv[1], encoding="utf-8").read()
def v(s):
    s = html.escape(s, quote=True)
    for c in "\u202e\u202c\u200b\u2060\u2066":
        m = "U+%04X" % ord(c)
        s = s.replace(c, "<span class=\"hid\" role=\"img\" aria-label=\"숨김 문자 %s\" title=\"숨김 문자 %s\">%s</span>" % (m, m, m))
    return s
B = "https://example.atlassian.net/browse/"
def row(it):
    return h.split(">%s</a></span><span class=\"c\"><span class=\"sr\">근거</span>" % it, 1)[1].split("</li>", 1)[0]
r13, r36 = row("TST-13"), row("이슈 #36")
amb = h.split("aria-labelledby=\"amb-TST-11\">", 1)[1].split("</article>", 1)[0]
checks = [
    (r13, "%s<span class=\"muted\"> — </span>%s</span>" % (v("남길 <i>티켓</i>\u2060"), v("아직 <작업> 중\u202e"))),
    (r13, "<span class=\"kv\"><span class=\"muted\">현재 상태</span>%s</span>" % v("Ready <b>to</b>\u200b work")),
    (r13, "<span class=\"kv\"><span class=\"muted\">연결된 Jira</span><a href=\"%sTST-12\">TST-12</a> (%s)</span>" % (B, v("Waiting <u>x</u>\u2066"))),
    (r13, "<span class=\"kv\"><span class=\"muted\">증거</span>일부 누락</span>"),
    (r36, "%s<span class=\"muted\"> — </span>%s</span>" % (v("이슈 <u>제목</u>\u200b"), v("재현됨 <em>확인</em>\u2066"))),
    (r36, "<span class=\"kv\"><span class=\"muted\">증거</span>일부 누락</span>"),
    (amb, "<dt>연결된 Jira</dt><dd><a href=\"%sTST-9\">TST-9</a> (%s), OTH-1 (Done)</dd>" % (B, v("할 <s>일</s>\u200b"))),
    (amb, "<dt>근거</dt><dd><a href=\"%sTST-9\">TST-9</a>, 커밋 <code>666666666666</code>, <code class=\"ref\">%s</code> 파일이 기본 브랜치에 "
          "없음, <a href=\"https://github.com/test/repo/pull/5\">PR #5</a> (병합됨), <a href=\"https://github.com/test/repo/issues/7\">"
          "이슈 #7</a>, <code class=\"ref\">%s</code> 파일, %s</dd>" % (B, v("src/<a>\u200b.py"), v("docs/<b>\u2060.md"), v("알 수 없는 <근거>\u202e"))),
]
print(" | ".join(want for part, want in checks if want not in part))' "$HG" 2>&1)
if [ -z "$out" ]; then ok "43i judged text escaped + marked on every path (kept summary/reason/status/linked status, issue title, cites, card linked status); KEEP rows flag partial evidence"
else bad "43i escaping with teeth" "missing: $out"; fi
# 43j. the recent group's date range is the rows' Korean date (2026-10-12T20:00Z = 2026-10-13 05:00 KST), not the UTC date
if printf '%s' "$(grp_of "$HG" '최근 30일 안에 갱신 — 판정 제외')" | grep >/dev/null -F '<p class="gmeta"><b>1</b>개 · 마지막 갱신 2026-10-13</p>' \
   && grep -qF '<span class="muted">마지막 갱신</span>2026-10-13 05:00 KST</span>' "$HG"; then
  ok "43j recent group date range in KST, same day as its rows"
else bad "43j recent date range" "$(grp_of "$HG" '최근 30일 안에 갱신 — 판정 제외' | grep -o '마지막 갱신 [0-9-]*' | head -2 | tr '\n' ' ')"; fi
# 43k. the AMBIGUOUS count is "결정 필요" everywhere (tile, confirm line, section, inventory); "확인 필요" only as the flag
#      on rows apply refuses
miss=""
for f in "$H4" "$HU" "$HJ" "$HG"; do
  grep -qF '<span class="lbl">결정 필요</span>' "$f" && grep -qF '<h2 id="s-ambig">결정이 필요한 것</h2>' "$f" \
    && grep -qF '· 결정 필요 <b id="c-ambiguous">' "$f" || miss="$miss [$(basename "$(dirname "$f")") labels]"
  if sed 's#<span class="flag">확인 필요</span>##g' "$f" | grep >/dev/null -F '확인 필요'; then miss="$miss [$(basename "$(dirname "$f")") 확인 필요 outside a flag]"; fi
done
grep -qF '+ 남김/결정 필요 <b id="inv-kept-TST">' "$HG" || miss="$miss [inventory]"
if [ -z "$miss" ]; then ok "43k 결정 필요 on tile / confirm line / section / inventory line; 확인 필요 only as a refuse flag"
else bad "43k wording" "$miss"; fi

# 44. completeness by section for the v4 pages: each plan row appears once, in its section, as the right kind of object
for pair in "valid:$A4" "valid-units:$U4" "valid-jira-units:$J4" "hostile:$G4"; do
  out=$("$PY" -I "$T/complete.py" "${pair#*:}/plan.tsv" "${pair#*:}/out.html"); rc=$?
  if [ "$rc" = 0 ]; then ok "44 completeness by section (v4 ${pair%%:*}): $out"; else bad "44 completeness (v4 ${pair%%:*})" "$out"; fi
done

# 45. fail closed on Jira links: a move row's site ≠ the search row's site, a deploy link that is not this repository's run
#     (both chore_plan checks — the renderer refuses them through the shared parser, no page written)
c45() { # c45 <name> <sed expression on valid.tsv> <stderr substring> [secret that must stay off both streams]
  local d; d=$(mk "c45-$n"); sed -e "$2" "$V4/valid.tsv" > "$d/plan.tsv"; json x jv4 > "$d/plan.json"
  if cmp -s "$d/plan.tsv" "$V4/valid.tsv"; then bad "$1" "sed did not change the fixture"; return; fi
  must_fail "$1" "$d" "$3"
  if [ -n "${4:-}" ] && grep -qF -- "$4" "$d/stdout" "$d/stderr"; then bad "$1 (secret)" "secret echoed"; fi
}
c45 "45a move row site ≠ inventory site → error" 's/site=example.atlassian.net;project=TST;issue_id=10101/site=evil.example.net;project=TST;issue_id=10101/' \
  "jira site example.atlassian.net differs from jira site evil.example.net on line 5 — one Jira binding per plan"
c45 "45b inventory site ≠ move rows' site → error" 's/%3Bsite%3Dexample.atlassian.net$/%3Bsite%3Dother.atlassian.net/' \
  "jira site other.atlassian.net differs from jira site example.atlassian.net on line 5 — one Jira binding per plan"
c45 "45c run link of another repository → error" 's#run_url=https%3A//github.com/test/repo/#run_url=https%3A//github.com/other/repo/#' \
  "TO-QA snapshot run_url must be https://github.com/<remote>/actions/runs/<run>"
c45 "45d run link on another host → error" 's#run_url=https%3A//github.com/#run_url=https%3A//evil.example/#' \
  "TO-QA snapshot run_url must be https://github.com/<remote>/actions/runs/<run>"
c45 "45e run link to another run number → error" 's#actions/runs/9000000001;#actions/runs/9000000002;#' \
  "TO-QA snapshot run_url must be https://github.com/<remote>/actions/runs/<run>"
c45 "45f run link with a query (token) → error, token not echoed" 's#actions/runs/9000000001;#actions/runs/9000000001?token%3Dtok-XYZ123;#' \
  "TO-QA snapshot run_url must be https://github.com/<remote>/actions/runs/<run>" tok-XYZ123
c45 "45g http run link → error" 's#run_url=https%3A//#run_url=http%3A//#' "TO-QA snapshot run_url must be an https URL"

# 46. every contract fixture the plan grammar rejects (globbed from fixtures/chore-v4/invalid, message from expected.json) is
#     refused by the renderer with that message, no page written; a fixture missing from expected.json is a failure
while IFS=$'\t' read -r f msg; do
  if [ -z "$msg" ]; then bad "46 invalid/$f" "no expected message in expected.json"; continue; fi
  d=$(mk "c46-$n"); cp "$V4/invalid/$f" "$d/plan.tsv"; json x jv4 > "$d/plan.json"
  must_fail "46 invalid/$f → error" "$d" "$msg"
done < <("$PY" -I -c 'import json, os, sys
e = json.load(open(sys.argv[1], encoding="utf-8"))
for f in sorted(x for x in os.listdir(sys.argv[2]) if x.endswith(".tsv")):
    print("%s\t%s" % (f, e.get(f, "")))' "$V4/expected.json" "$V4/invalid")

# 48. every contract fixture valid*.tsv (globbed — a new fixture is covered without editing this file), with an engine JSON
#     derived from its rows (branches, PR/issue report rows; a close row's engine title is "엔진 제목 <ref>"): renders,
#     numbers = rows, links, no full hash, completeness; a plain PR/issue row (no verdict key) shows its title verbatim even
#     when it looks like t=…;v=…; a close row with a plan title shows that title, never the engine's
cat > "$T/v4json.py" <<'PY'
import json, re, sys, urllib.parse
u = urllib.parse.unquote
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
hdr = dict(f.split("=", 1) for f in lines[0].split("\t")[1:])
rows = []
for line in lines[1:]:
    if not line:
        continue
    col = line.split("\t")
    action, ref = col[1], u(col[2])
    if action in ("delete-remote", "delete-local", "delete-local-force", "worktree-prune"):
        rows.append({"tier": int(col[0]), "action": action, "ref": ref, "reason": "merged-pr", "protected_by": ""})
    elif action in ("close-pr", "close-issue"):
        rows.append({"tier": 3, "action": "report", "ref": ref, "reason": "open-" + action[6:], "evidence": "엔진 제목 " + ref})
    elif action == "report" and re.fullmatch(r"(pr|issue)#[0-9]+", ref):
        rows.append({"tier": 3, "action": "report", "ref": ref, "reason": "open-pr" if ref[0] == "p" else "open-issue", "evidence": "x"})
    elif action == "report" and (ref == "." or ref.startswith(("remote:", "local:"))):
        rows.append({"tier": 3, "action": "report", "ref": ref, "reason": "local-held" if ref == "." else "stale", "protected_by": ""})
print(json.dumps({"plan_sha256": "0" * 64, "header": {"remote": u(hdr["remote"]), "run_id": u(hdr["run_id"])}, "rows": rows},
                 ensure_ascii=False))
PY
for f in "$V4"/valid*.tsv; do
  nm=$(basename "$f" .tsv); d=$(mk "c48-$nm"); cp "$f" "$d/plan.tsv"; "$PY" -I "$T/v4json.py" "$d/plan.tsv" > "$d/plan.json"
  render "$d"; rc=$?
  if [ "$rc" != 0 ]; then bad "48 $nm renders" "rc=$rc $(head -c 200 "$d/stderr")"; continue; fi
  v4_check "48 $nm" "$d"; v4_links "48 $nm" "$d"; v4_nohex "48 $nm" "$d" "$(sha "$d/plan.tsv")"
  out=$("$PY" -I "$T/complete.py" "$d/plan.tsv" "$d/out.html"); rc=$?
  if [ "$rc" = 0 ]; then ok "48 $nm completeness by section: $out"; else bad "48 $nm completeness" "$out"; fi
  out=$("$PY" -I -c 'import html, re, sys, urllib.parse
u = urllib.parse.unquote
h, miss, n = open(sys.argv[1], encoding="utf-8").read(), [], 0
for line in open(sys.argv[2], encoding="utf-8").read().split("\n")[1:]:
    col = line.split("\t")
    if len(col) != 6:
        continue
    action, ref, last = col[1], u(col[2]), col[4].split(";")[-1]
    if action == "report" and re.fullmatch(r"(pr|issue)#[0-9]+", ref) and not last.startswith("verdict="):
        n += 1
        if "<span class=\"sr\">근거</span>%s</span>" % html.escape(u(col[5]), quote=True) not in h:
            miss.append(ref + " plain title")
    if action in ("close-pr", "close-issue"):
        n += 1
        label = ("PR #" if action == "close-pr" else "이슈 #") + ref.split("#")[1]
        title = u(last[len("title="):]) if last.startswith("title=") else "엔진 제목 " + ref
        if "%s</a> %s</h3>" % (label, html.escape(title, quote=True)) not in h:
            miss.append(ref + " close title")
print("%d rows checked" % n if not miss else "missing: " + " ".join(miss))' "$d/out.html" "$d/plan.tsv")
  case "$out" in missing:*) bad "48 $nm titles" "$out";; *) ok "48 $nm titles: plain PR/issue rows verbatim, close cards plan title else engine title ($out)";; esac
done

# 49. close card title = the plan row's own title (last snapshot key, covered by the digest) when present, escaped and
#     marked — the engine JSON title only for a row without one (older plans)
d=$(mk c49); "$PY" -I -c 'import sys
b = open(sys.argv[1], "rb").read()
old = "author=erin\t이 PR은".encode()
assert b.count(old) == 1
t = "계획 제목 <b>굵게</b> & \u202e끝"
open(sys.argv[2], "wb").write(b.replace(old, ("author=erin;title=%s\t이 PR은" % t).encode()))' "$V4/valid.tsv" "$d/plan.tsv"
json x jv4 > "$d/plan.json"; render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF "<a class=\"it\" href=\"https://github.com/test/repo/pull/7\">PR #7</a> 계획 제목 &lt;b&gt;굵게&lt;/b&gt; &amp; $(hidm U+202E)끝</h3>" "$d/out.html" \
   && ! grep -qF 'Old idea: experimental search' "$d/out.html" \
   && grep -qF '<a class="it" href="https://github.com/test/repo/issues/9">이슈 #9</a> 검색 결과가 비어 있음</h3>' "$d/out.html" \
   && "$PY" -I "$T/complete.py" --page-marks "$d/out.html" >/dev/null; then
  ok "49 close card shows the plan row's title (escaped, hidden char marked) instead of the engine's; a row without one keeps the engine title"
else bad "49 close title" "rc=$rc $(grep -o 'PR #7</a>[^<]*' "$d/out.html" 2>/dev/null) $(head -c 160 "$d/stderr")"; fi
d=$(mk c49b); "$PY" -I -c 'import sys
b = open(sys.argv[1], "rb").read()
open(sys.argv[2], "wb").write(b.replace("author=erin\t이 PR은".encode(), "author=erin;title=\t이 PR은".encode()))' "$V4/valid.tsv" "$d/plan.tsv"
json x jv4 > "$d/plan.json"; must_fail "49b empty plan title → error" "$d" "snapshot title must not be empty"

# 50. the inventory recount can fail: kept / excluded columns are counted by named verdicts, so a verdict the page does not
#     know (injected after parsing — the grammar never lets one through) makes the sum differ and the render stops
out=$("$PY" -I -B -c 'import importlib.util, sys
spec = importlib.util.spec_from_file_location("chore_render", sys.argv[1]); m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
hdr, rows = m.parse_plan(open(sys.argv[2], "rb").read())
for r in rows:   # what join_rows sets from the engine JSON (classification only)
    r.update(reason="", protected_by="", group="", title=r.get("title") or "")
m.render(hdr, rows, "p.tsv", "0" * 64, "0" * 64, [], "")
for r in rows:
    if r["ref"] == "jira#TST-104":
        r["jira"]["evidence"]["v"] = "LATER"
try:
    m.render(hdr, rows, "p.tsv", "0" * 64, "0" * 64, [], "")
    print("rendered")
except m.PlanError as e:
    print(e)' "$R" "$V4/valid.tsv" 2>&1)
case "$out" in *"inventory total 4 for jira#TST but the page counts 3 rows"*) ok "50 inventory recount stops on a verdict outside its columns ($out)";;
  *) bad "50 inventory recount" "$out";; esac

# 51. the full-run step lists the stages in apply order: 닫기 → Jira → 나머지 브랜치 삭제 → 로컬 (plan with all four)
d=$(mk c51); { cat "$T/c13/plan.tsv"; awk 'NR==5 || NR==6 || NR>=9' "$V4/valid.tsv"; } > "$d/plan.tsv"; cp "$T/c13/plan.json" "$d/"
render "$d"; rc=$?
if [ "$rc" = 0 ] && grep -qF '<li id="step-full">나머지를 이 순서로 한 번에 실행합니다: PR <b>1</b>개·이슈 <b>1</b>개 닫기 → Jira 티켓 <b>2</b>건 옮기기 → 나머지 브랜치 <b>7</b>개 삭제 → 로컬 정리 <b>2</b>건. 끝나면' "$d/out.html" \
   && [ "$(grep -c '<li' "$d/out.html" | tr -d ' ')" -gt 0 ] && ! grep -qF '건을 실행합니다' "$d/out.html" \
   && [ "$(awk '/<ol class="steps">/{on=1} on && /<li/{n++} /<\/ol>/{on=0} END{print n}' "$d/out.html")" = 4 ]; then
  ok "51 full-run step in apply order (close → Jira → remaining branches → local) as one step after step 1"
else bad "51 apply order" "rc=$rc $(grep -o '<li id="step-full">[^.]*' "$d/out.html" 2>/dev/null) $(head -c 160 "$d/stderr")"; fi

# ── chore v4.3 (2026-10-21): Jira로 옮기기 — move-issue rows and their --payloads files (design v9 §9, contract §3) ───────
# 52. V4 valid.tsv + two generated move-issue rows, built with chore_plan's own encoders (move_payload, move_comment,
#     encode_move_evidence, source_sha — so payload_sha is the real sha256 of the file bytes build would write):
#     issue#21 = new ticket, related TST-90 / TST-91, its second comment over the cap (→ truncation notice, 잘림 flag);
#     issue#22 = adopts TST-130 with a recorded migration comment (prior 4001:<sha>), author deleted. HTML, bidi and
#     zero-width text in title, type name, reason, labels, body and comment. Variants whose payload_sha matches a file
#     that is not JSON / whose description parse_blocks refuses (the sha check alone would let them through).
MV="$V4/move"
M5=$(mk mv52)
"$PY" -I - "$SKILL/scripts/chore_plan.py" "$V4/valid.tsv" "$M5" <<'PY'
import hashlib, importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("chore_plan", sys.argv[1]); P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
base, out = open(sys.argv[2], "rb").read(), sys.argv[3]
URL, DATE, SITE = "https://github.com/test/repo", "2026-10-21", "example.atlassian.net"
A = "712020:00000000-0000-0000-0000-000000000001"
OLD = ("이 이슈는 Jira TST-130로 옮겼습니다: https://example.atlassian.net/browse/TST-130\n남기는 이유: 이전 계획\n"
       "이후 진행은 Jira 티켓에서 이어갑니다. 이 이슈는 닫습니다.\nchore 정리 → Jira로 옮김 — by Claude triage 2026-10-01")
ISSUES = [
    dict(n=21, updated="2026-08-05T00:00:00Z", adopt="-", prior="-", related=["TST-90", "TST-91"], typename="버그 <i>b</i>\u200b",
         reason="재현됨 <i>확인</i> & 100%; 다음 분기 = 결제, 끝 \u2066",
         issue=dict(number=21, title='결제 <b>오류</b> & "q" \u202e끝', author="frank", created="2026-06-01T09:00:00Z",
                    labels=["ui <x>", "bug"], body="재현 <script>alert(1)</script>\n1. 결제\t탭\n2. 오류 \u200b표시",
                    comments=[dict(author="grace", created="2026-06-02T10:00:00Z",
                                   body="저도 봤습니다 <i>크롬</i>: https://github.com/test/repo/issues/3"),
                              dict(author="henry", created="2026-06-03T11:00:00Z", body="긴 로그\n" + "x" * (P.MOVE_CAP + 1000))])),
    dict(n=22, updated="2026-08-06T00:00:00Z", adopt="TST-130", prior="4001:" + hashlib.sha256(OLD.encode()).hexdigest(),
         related=[], typename="작업", reason="이미 만든 TST-130으로 닫기만",
         issue=dict(number=22, title="세션 만료 후 화면 멈춤", author=None, created="2026-05-04T00:00:00Z", labels=[],
                    body="\n\n줄 1\r\n줄 2\r\n", comments=[dict(author="grace", created="2026-05-05T00:00:00Z", body="확인 <b>했음</b>")])),
]
os.makedirs(out + "/payloads")
rows, facts = [], {}
for d in ISSUES:
    it = d["issue"]
    snap = dict(state="OPEN", updated=d["updated"], author=it["author"] or "", title=it["title"], site=SITE, project="TST",
                project_id="10000", issuetype="10001", issuetype_name=d["typename"], account=A, gh_login="chore-bot",
                source_sha=P.source_sha(it), payload_sha="", adopt=d["adopt"], prior=d["prior"])
    payload, trunc = P.move_payload(it, URL, snap, d["reason"], d["related"], DATE)
    snap["payload_sha"] = hashlib.sha256(payload).hexdigest()
    open(out + "/payloads/issue-%d.json" % d["n"], "wb").write(payload)
    gh = P.move_comment(SITE, d["reason"], DATE)
    ev = P.encode_move_evidence(dict(reason=d["reason"], gh=gh, related=d["related"]))
    rows.append(b"\t".join([b"2", b"move-issue", b"issue#%d" % d["n"], d["updated"].encode(),
                            P.encode_snapshot({k: snap[k] for k in P.MOVE_SNAP_KEYS}), ev]))
    facts[d["n"]] = dict(gh=gh, sha=snap["payload_sha"], cut=trunc["body_cut"] or trunc["comments_included"] < trunc["comments_total"])
    if d["prior"] != "-":   # the kept comment (OLD: another reason and date) is not what the current template would post
        facts[d["n"]]["prior_differs"] = hashlib.sha256(P.comment_body(gh, d["adopt"]).encode()).hexdigest() != d["prior"][5:]
plan = base + b"\n".join(rows) + b"\n"
open(out + "/plan.tsv", "wb").write(plan)
P.parse_plan(plan)
json.dump(facts, open(out + "/facts.json", "w"), ensure_ascii=False)
good21 = open(out + "/payloads/issue-21.json", "rb").read()
bad_adf = P.canon_json({"fields": dict(json.loads(good21)["fields"], description={"type": "doc", "version": 1,   # every other
                                       "content": [{"type": "table", "content": []}]})}, "t")                  # field as built
spaced = json.dumps(json.loads(good21), sort_keys=True, ensure_ascii=False).encode()   # same value, ", " / ": " spacing
dupkey = b'{"fields":{"summary":"x",' + good21[len(b'{"fields":{'):]                   # same value after json.loads (last wins)
assert json.loads(spaced) == json.loads(good21) == json.loads(dupkey) and spaced != good21 and dupkey != good21
g21 = json.loads(good21)
def fvariant(**kw):   # issue#21's payload with some fields changed, still canonical bytes (only the field check can stop it)
    f = dict(g21["fields"])
    f.update(kw)
    return P.canon_json({"fields": f})
fields_bad = (("flabels", fvariant(labels=["github-issue"])), ("fassignee", fvariant(assignee={"id": A})),
              ("freporter", fvariant(reporter={"id": A[:-1] + "9"})), ("fproject", fvariant(project={"id": "10099"})),
              ("fitype", fvariant(issuetype={"id": "10002"})), ("ftop", P.canon_json({"fields": g21["fields"], "update": {}})))
for name, body in (("badjson", b'{"fields": {"summary": '), ("badadf", bad_adf), ("spaced", spaced), ("dupkey", dupkey)) + fields_bad:
    os.makedirs(out + "/" + name + "/payloads")
    open(out + "/" + name + "/payloads/issue-21.json", "wb").write(body)
    open(out + "/" + name + "/payloads/issue-22.json", "wb").write(open(out + "/payloads/issue-22.json", "rb").read())
    v = plan.replace(b"payload_sha=" + facts[21]["sha"].encode(), b"payload_sha=" + hashlib.sha256(body).hexdigest().encode())
    assert v != plan
    P.parse_plan(v)
    open(out + "/" + name + "/plan.tsv", "wb").write(v)
PY
jv4m() { jv4; J 3 report 'issue#21' open-issue '' x issues; J 3 report 'issue#22' open-issue '' x issues; }
json x jv4m > "$M5/plan.json"; render "$M5" --payloads "$M5/payloads"; rc=$?; HM="$M5/out.html"
if [ "$rc" = 0 ] && [ -s "$HM" ]; then ok "52 move-issue plan renders with --payloads"; else bad "52 move plan renders" "rc=$rc $(head -c 200 "$M5/stderr")"; fi
v4_check "52a move plan" "$M5"
v4_links "52b move plan" "$M5"
v4_nohex "52c move plan" "$M5" "$(sha "$M5/plan.tsv")"
out=$("$PY" -I "$T/complete.py" "$M5/plan.tsv" "$HM"); rc=$?
if [ "$rc" = 0 ]; then ok "52d completeness by section (move plan): $out"; else bad "52d completeness (move plan)" "$out"; fi
# 52e/f. each card field as approved — escaped + marked (oracle v() below marks the fixture's hidden characters itself), the
#     comment exactly (new ticket: {KEY} as the bordered [새 티켓 키] slot; adopt: comment_body(gh, KEY) = the posted body),
#     the preview = the payload's summary then every block of fields.description, read here from the file's JSON
#     (an ADF walk of its own, not chore_plan.parse_blocks); a lost vis() or a dropped block fails a check
cat > "$T/mvcard.py" <<'PY'
import html, json, sys
h, facts, pdir = open(sys.argv[1], encoding="utf-8").read(), json.load(open(sys.argv[2], encoding="utf-8")), sys.argv[3]
which = sys.argv[4]
def v(s):
    s = html.escape(s, quote=True)
    for c in "\u202e\u202c\u200b\u2060\u2066":
        m = "U+%04X" % ord(c)
        s = s.replace(c, "<span class=\"hid\" role=\"img\" aria-label=\"숨김 문자 %s\" title=\"숨김 문자 %s\">%s</span>" % (m, m, m))
    return s
def card(n):
    return h.split("<article class=\"card\" aria-labelledby=\"mv-%d\">" % n, 1)[1].split("</article>", 1)[0]
def preview(n):
    f = json.load(open("%s/issue-%d.json" % (pdir, n), encoding="utf-8"))["fields"]
    out = ["<details class=\"pv\">\n<summary>Jira 티켓 설명 미리보기</summary>\n"]
    if n == 22:
        out.append("<p class=\"muted\">새 티켓은 만들지 않음 — 닫기 전에 이미 만든 티켓 TST-130의 내용을 이 승인본과 대조합니다</p>\n")
    out.append(PP + "<span class=\"muted\">요약</span> %s</p>\n" % v(f["summary"]))
    for node in f["description"]["content"]:
        text = "".join(k["text"] if k["type"] == "text" else "\n" for k in node.get("content", []))
        out.append({"heading": PP + "<b>%s</b></p>\n", "paragraph": PP + "%s</p>\n",
                    "codeBlock": "<pre class=\"comment\">\n%s</pre>\n"}[
            node["type"]] % (v(text) if node["type"] == "codeBlock" else v(text).replace("\n", "<br>")))
    return "".join(out) + "</details>\n"
PP = "<p style=\"white-space:pre-wrap\">"   # preview text keeps spaces / tabs; <pre> always opens with a newline
SLOT = "<span class=\"flag\">[새 티켓 키]</span>"
B = "https://example.atlassian.net/browse/"
c21, c22 = card(21), card(22)
want = [
    (c21, "<h3 id=\"mv-21\"><a class=\"it\" href=\"https://github.com/test/repo/issues/21\">이슈 #21</a> %s <span class=\"flag\">잘림</span></h3>"
          % v('결제 <b>오류</b> & "q" \u202e끝')),
    (c21, "<p class=\"say\">새 티켓 <code>example.atlassian.net/TST</code> · 유형 %s</p>" % v("버그 <i>b</i>\u200b")),
    (c21, "<p class=\"who\">작성자 frank · 마지막 갱신 2026-08-05 09:00 KST</p>"),
    (c21, "<dt>남기는 이유</dt><dd>%s</dd>" % v("재현됨 <i>확인</i> & 100%; 다음 분기 = 결제, 끝 \u2066")),
    (c21, "<dt>관련 티켓</dt><dd><a href=\"%sTST-90\">TST-90</a>, <a href=\"%sTST-91\">TST-91</a></dd>" % (B, B)),
    (c21, "<p class=\"say\">GitHub 이슈에 남길 댓글</p>\n<div class=\"comment\">%s</div>\n"
          % SLOT.join(v(p) for p in facts["21"]["gh"].split("{KEY}"))),
    (c21, preview(21)),
    (c21, PP + "GitHub 이슈에서 옮김: https://github.com/test/repo/issues/21</p>\n"),
    (c21, PP + "%s</p>\n" % v("작성: frank · 2026-06-01T09:00:00Z · 라벨: bug, ui <x> · 댓글 2개")),
    (c21, (PP + "관련: TST-90, TST-91</p>\n" + PP + "<b>본문</b></p>\n<pre class=\"comment\">\n%s</pre>\n" + PP + "<b>댓글</b></p>\n"
           + PP + "grace · 2026-06-02T10:00:00Z</p>\n<pre class=\"comment\">\n%s</pre>\n" + PP + "나머지는 원 이슈에서: 댓글 1개 안 실음</p>\n"
           + PP + "chore 정리 → GitHub issue #21 — by Claude triage 2026-10-21</p>\n</details>\n")
          % (v("재현 <script>alert(1)</script>\n1. 결제\t탭\n2. 오류 \u200b표시"), v("저도 봤습니다 <i>크롬</i>: https://github.com/test/repo/issues/3"))),
    (c21, "</details>\n<p class=\"muted\">담당자 없음 · 보고자 = 실행 계정 · 첫 상태</p>\n"),
    (c22, "<h3 id=\"mv-22\"><a class=\"it\" href=\"https://github.com/test/repo/issues/22\">이슈 #22</a> 세션 만료 후 화면 멈춤</h3>"),
    (c22, "<p class=\"say\">이미 만든 티켓 <a href=\"%sTST-130\">TST-130</a>로 닫기만 (새 티켓 없음)</p>" % B),
    (c22, "<p class=\"who\">작성자 알 수 없음 · 마지막 갱신 2026-08-06 09:00 KST</p>"),
    (c22, "<dt>관련 티켓</dt><dd>없음</dd>"),
    (c22, "</dl>\n<p class=\"say\">이슈에 이미 있는 이관 댓글을 그대로 둠 — 새 댓글 없음 (<a href=\"https://github.com/test/repo/issues/22"
          "#issuecomment-4001\">댓글 4001 보기</a>)</p>\n<details class=\"prior-alt\">\n<summary>기존 댓글을 지운 것으로 기록한 뒤 다시 실행할 때만 "
          "남길 문구</summary>\n<div class=\"comment\">%s</div>\n</details>\n" % v(facts["22"]["gh"].replace("{KEY}", "TST-130"))),
    (c22, preview(22)),
    (c22, PP + "작성: (삭제된 계정) · 2026-05-04T00:00:00Z · 라벨: 없음 · 댓글 1개</p>\n"),
    (c22, "<pre class=\"comment\">\n\n\n줄 1\n줄 2</pre>\n"),   # body opens with two blank lines: both survive the <pre> newline rule
]
mine = c21 if which == "21" else c22
miss = [w for part, w in want if part is mine and w not in part]
if which == "21" and ("이관 댓글을 그대로" in c21 or "prior-alt" in c21 or "{KEY}" in h or not facts["21"]["cut"]):
    miss.append("prior line on a new-ticket card / a raw {KEY} on the page / fixture issue#21 not truncated")
if which == "22" and ("잘림" in c22 or "담당자 없음" in c22 or SLOT in c22 or facts["22"]["cut"]):
    miss.append("잘림 flag / R5 line / key slot on the adopt card, or fixture issue#22 truncated")
if which == "22":
    # the kept comment differs from the current template (another reason and date), so the template must never read as
    # that comment: outside the collapsed prior-alt block there is no comment block, no template line, no "남길 댓글"
    tmpl = v(facts["22"]["gh"].replace("{KEY}", "TST-130"))
    outside = c22.split("<details class=\"prior-alt\">", 1)[0] + c22.split("</details>", 1)[-1]
    if not facts["22"].get("prior_differs"):
        miss.append("fixture: the prior comment must differ from the current template")
    if c22.count(tmpl) != 1 or "<div class=\"comment\">" in outside or "이 이슈는 Jira TST-130로" in outside \
            or "GitHub 이슈에 남길 댓글" in c22:
        miss.append("template text shown outside the collapsed block (would read as the kept comment)")
print(" | ".join(miss[:3]))
PY
out=$("$PY" -I "$T/mvcard.py" "$HM" "$M5/facts.json" "$M5/payloads" 21 2>&1)
if [ -z "$out" ]; then ok "52e new-ticket card exact: title link + 잘림 flag, site/project + type, author/updated, reason, related links, comment with [새 티켓 키] slots, preview = summary + every block, R5 line"
else bad "52e new-ticket card fields" "missing: $out"; fi
out=$("$PY" -I "$T/mvcard.py" "$HM" "$M5/facts.json" "$M5/payloads" 22 2>&1)
if [ -z "$out" ]; then ok "52f adopt card with a kept migration comment: 이미 만든 티켓 TST-130로 닫기만, related 없음, '이관 댓글을 그대로 둠' + link to comment 4001, template only in the collapsed block, preview (pre keeps a leading blank line), no 잘림 / R5 line / slot"
else bad "52f adopt card fields" "missing: $out"; fi
# 52g. cards in issue-number order inside 'Jira로 옮기기', which sits after Jira 옮기기 and before 결정이 필요한 것
order=$(grep -oE 'aria-labelledby="mv-[0-9]+"' "$HM" | paste -sd' ' -)
sec=$(awk '/<h2 id="s-move">/{on=1} /<\/section>/{on=0} on' "$HM" | grep -c '<article class="card" aria-labelledby="mv-')
if [ "$order" = 'aria-labelledby="mv-21" aria-labelledby="mv-22"' ] && [ "$sec" = 2 ] \
   && awk '/id="s-close"/{c=NR} /id="s-jira"/{j=NR} /id="s-move"/{m=NR} /id="s-ambig"/{a=NR} END{exit !(c < j && j < m && m < a)}' "$HM" \
   && grep -qF '<h2 id="s-move">Jira로 옮기기</h2>' "$HM" \
   && grep -qF '<p>남기기로 판정한 GitHub 이슈 <b>2</b>건을 Jira <code>example.atlassian.net/TST</code>로 옮깁니다. 새 티켓 <b>1</b>건을 만들고, 이미 만든 티켓이 있는 <b>1</b>건은 그 티켓으로 닫기만 합니다.</p>' "$HM"; then
  ok "52g move cards by issue number in 'Jira로 옮기기' (after Jira 옮기기, before 결정이 필요한 것); section counts new / adopt"
else bad "52g move order / section" "order=$order in-section=$sec"; fi
# 52h. run order + counts: the full run lists the move stage after the Jira transitions, says moves are full-run only,
#     never offers move as an --only-group key; tile + confirm count; engine report rows consumed (0 removed); drift note
if grep -qF '→ Jira 티켓 <b>2</b>건 옮기기 → GitHub 이슈 <b>2</b>건 Jira로 옮기기 → 나머지 브랜치 <b>0</b>개 삭제.' "$HM" \
   && grep -qF '<span id="step-move">GitHub 이슈는 이 전체 실행에서만 Jira로 옮기고(1단계 실행에서는 옮기지 않음), 새 티켓을 만들거나 이미 만든 티켓을 쓰고, 필요할 때만 이관 댓글을 남긴 뒤 이슈를 닫습니다.</span>' "$HM" \
   && grep -qF '<p>이슈마다 새 티켓을 만들거나 이미 만든 티켓을 쓰고, 이관 댓글(티켓 키와 링크)은 이슈에 아직 없을 때만 남긴 뒤 이슈를 닫습니다(닫는 이유: 계획 안 함).' "$HM" \
   && ! grep -qF '이슈마다 티켓을 만든 뒤' "$HM" && ! grep -qF '이슈마다 티켓 키와 링크를 댓글로 남긴 뒤' "$HM" \
   && ! grep -qF '<code class="ref">move</code>' "$HM" && ! grep -qF -- '--only-group move' "$HM" \
   && grep -qF '<li><span class="num" id="n-move">2</span><span class="lbl">Jira로 옮길 이슈</span></li>' "$HM" \
   && grep -qF ' · Jira 닫기 <b id="c-jira-closed">1</b> · Jira로 옮기기 <b id="c-move">2</b>건 · 결정 필요 <b id="c-ambiguous">1</b></span>' "$HM" \
   && grep -qF '계획에서 뺀 항목 0개' "$HM" \
   && grep -qF '이 페이지가 확인한 차이: 닫기 2행 추가, Jira 5행 추가, Jira로 옮길 이슈 2행 추가, 0행 제외' "$HM" \
   && grep -qF '<p>Jira로 옮긴 이슈도 GitHub에서 다시 열 수 있습니다. 새로 만든 Jira 티켓과 이슈에 남긴 댓글은 자동으로 지우지 않습니다.</p>' "$HM" \
   && "$PY" -I "$T/complete.py" --page-marks "$HM" >/dev/null && [ "$(grep -cE '<script|<b>오류|<i>(b|확인|크롬)|<x>' "$HM")" = 0 ] \
   && "$PY" -I -c 'import sys; h=open(sys.argv[1],encoding="utf-8").read(); sys.exit(any(c in h for c in "\u202e\u200b\u2066"))' "$HM"; then
  ok "52h full-run stage + step note for moves (new or existing ticket, comment only when needed; no --only-group move offered), tile n-move / confirm c-move, report rows joined, drift note, undo line, legend = marks, no raw tag / bidi / zero-width text"
else bad "52h move run order / counts" "$(grep -o '<li id="step-full">[^.]*' "$HM" | head -c 300)"; fi
# 52i. refusals (exit 1, one stderr line, no page): no --payloads, missing / extra / changed / linked file, a file whose
#     sha matches but is not JSON, not canonical JSON (spacing, duplicate key), not the payload_bytes field set / values
#     of its row (extra field, assignee, reporter, project, issuetype, top-level key) or not a description parse_blocks takes,
#     a non-empty or non-folder --payloads on a plan without move rows, a move row with no engine report row; an entry
#     name with a newline stays on one line (%r)
mvfail() { # mvfail <name> <plan dir> <stderr substring> [render args…]
  local d rc; d=$(mk "c52i-$n"); cp "$2/plan.tsv" "$d/"; cp "${JSON52:-$M5/plan.json}" "$d/plan.json"
  render "$d" "${@:4}"; rc=$?
  if [ "$rc" != 1 ]; then bad "$1" "rc=$rc, expected 1"
  elif [ -e "$d/out.html" ]; then bad "$1" "out.html was written"
  elif [ "$(wc -l < "$d/stderr" | tr -d ' ')" != 1 ]; then bad "$1" "stderr is not one line: $(head -c 160 "$d/stderr" | tr '\n' '|')"
  elif ! grep -qF -- "$3" "$d/stderr"; then bad "$1" "stderr lacks '$3': $(head -c 200 "$d/stderr")"
  else ok "$1 (rc=1: $(sed -E "s#'[^']*/(p52-[^/']*|mv52[^']*)'#DIR#" "$d/stderr" | head -c 110))"; fi
}
pdir() { local p; p=$(mk "p52-$n-$1"); cp "$M5/payloads/"* "$p/"; printf '%s' "$p"; }
mvfail "52i no --payloads on a plan with move rows → error" "$M5" "the plan has 2 move-issue rows — --payloads DIR"
p=$(pdir miss); rm "$p/issue-21.json"
mvfail "52i payload file missing → error" "$M5" "missing issue-21.json (one file per move-issue row)" --payloads "$p"
p=$(pdir extra); : > "$p/.DS_Store"
mvfail "52i extra entry in the payload folder → error" "$M5" "unexpected entries '.DS_Store'" --payloads "$p"
p=$(pdir nl); : > "$p/a"$'\n'"b"
mvfail "52i extra entry named with a newline → one-line error" "$M5" "unexpected entries 'a\\nb'" --payloads "$p"
p=$(pdir sha); printf ' ' >> "$p/issue-21.json"
mvfail "52i payload bytes ≠ payload_sha → error" "$M5" "issue-21.json sha256 " --payloads "$p"
mvfail "52i … and names the plan's payload_sha" "$M5" \
  "payload_sha $("$PY" -I -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["21"]["sha"])' "$M5/facts.json")" --payloads "$p"
p=$(pdir link); rm "$p/issue-21.json"; ln -s "$M5/payloads/issue-21.json" "$p/issue-21.json"
mvfail "52i payload file is a symlink → error" "$M5" "issue-21.json is not a regular file" --payloads "$p"
mvfail "52i payload_sha matches a file that is not JSON → error" "$M5/badjson" "issue-21.json is not UTF-8 JSON" --payloads "$M5/badjson/payloads"
mvfail "52i payload_sha matches a description parse_blocks refuses → error" "$M5/badadf" \
  "issue-21.json description: ADF block 1: node type 'table'" --payloads "$M5/badadf/payloads"
mvfail "52i payload_sha matches a file with the same JSON value but other spacing → error (not canonical)" "$M5/spaced" \
  "issue-21.json is not canonical JSON (re-encoding it with chore_plan.canon_json gives other bytes" --payloads "$M5/spaced/payloads"
mvfail "52i payload_sha matches a file with a duplicate key → error (not canonical)" "$M5/dupkey" \
  "issue-21.json is not canonical JSON" --payloads "$M5/dupkey/payloads"
# fields = what chore_plan.payload_bytes makes from the row's snapshot (the card's 담당자 없음 · 보고자 = 실행 계정 · type ·
# project claims); each file is canonical and its sha is the plan's payload_sha, so only the field check refuses it
A52="712020:00000000-0000-0000-0000-000000000001"
mvfail "52i payload with an extra field (labels) → error" "$M5/flabels" \
  "issue-21.json fields ['assignee', 'description', 'issuetype', 'labels', 'project', 'reporter', 'summary'] are not exactly ['assignee', 'description', 'issuetype', 'project', 'reporter', 'summary']" \
  --payloads "$M5/flabels/payloads"
mvfail "52i payload with an assignee → error" "$M5/fassignee" "issue-21.json fields.assignee {'id': '$A52'} is not None (line 12 snapshot)" \
  --payloads "$M5/fassignee/payloads"
mvfail "52i payload reporter ≠ the row's account → error" "$M5/freporter" \
  "issue-21.json fields.reporter {'id': '${A52%1}9'} is not {'id': '$A52'} (line 12 snapshot)" --payloads "$M5/freporter/payloads"
mvfail "52i payload project id ≠ the row's project_id → error" "$M5/fproject" \
  "issue-21.json fields.project {'id': '10099'} is not {'id': '10000'} (line 12 snapshot)" --payloads "$M5/fproject/payloads"
mvfail "52i payload issuetype ≠ the row's issuetype → error" "$M5/fitype" \
  "issue-21.json fields.issuetype {'id': '10002'} is not {'id': '10001'} (line 12 snapshot)" --payloads "$M5/fitype/payloads"
mvfail "52i payload with a second top-level key → error" "$M5/ftop" \
  "issue-21.json top-level keys ['fields', 'update'] are not exactly ['fields']" --payloads "$M5/ftop/payloads"
# a plan without move rows: the skill still passes --payloads, and build made the folder empty — any entry is refused
JSON52="$A4/plan.json" mvfail "52i --payloads with move payload files on a plan without move rows → error" "$A4" \
  "the plan has no move-issue rows, so the folder must be empty — found 'issue-21.json', 'issue-22.json'" --payloads "$M5/payloads"
p=$(mk p52-stray); : > "$p/.keep"
JSON52="$A4/plan.json" mvfail "52i one stray dotfile in --payloads, plan without move rows → error" "$A4" \
  "the plan has no move-issue rows, so the folder must be empty — found '.keep'" --payloads "$p"
JSON52="$A4/plan.json" mvfail "52i --payloads that is a file, plan without move rows → error" "$A4" "cannot list the directory" \
  --payloads "$A4/plan.tsv"
json x jv4 "$(J 3 report 'issue#22' open-issue '' x issues)" > "$T/j52.json"
JSON52="$T/j52.json" mvfail "52i move row without its engine report row → error" "$M5" \
  "plan row not in engine JSON: move-issue issue#21 (looked for its report row)" --payloads "$M5/payloads"
# 52j. U1's contract fixture move/valid.tsv with the payload files build would write for it (move_payload over
#      move/issues.json): renders, numbers / links / completeness; issue#12 adopts TST-120 without a recorded comment,
#      issue#13 adopts TST-130 with one (4001); no search-total row → the Jira section says no ticket moves
M6=$(mk mv52j); cp "$MV/valid.tsv" "$M6/plan.tsv"; mkdir -p "$M6/payloads"
"$PY" -I - "$SKILL/scripts/chore_plan.py" "$MV/issues.json" "$M6/payloads" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("chore_plan", sys.argv[1]); P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
d = json.load(open(sys.argv[2], encoding="utf-8"))
for r in d["rows"]:
    payload, _ = P.move_payload(r["issue"], d["repo_url"], d["snap"], r["reason"], r["related"], d["plan_date"])
    open("%s/issue-%d.json" % (sys.argv[3], r["issue"]["number"]), "wb").write(payload)
PY
jmv() { J 3 report 'issue#9' open-issue '' '검색 결과가 비어 있음' issues; J 3 report 'issue#10' open-issue '' x issues
  for i in 11 12 13; do J 3 report "issue#$i" open-issue '' x issues; done; }
json x jmv > "$M6/plan.json"; render "$M6" --payloads "$M6/payloads"; rc=$?; H6="$M6/out.html"
if [ "$rc" = 0 ]; then ok "52j contract fixture move/valid.tsv renders with its payloads"
else bad "52j move/valid.tsv renders" "rc=$rc $(head -c 240 "$M6/stderr")"; fi
v4_check "52j move/valid.tsv" "$M6"; v4_links "52j move/valid.tsv" "$M6"
out=$("$PY" -I "$T/complete.py" "$M6/plan.tsv" "$H6"); rc=$?
if [ "$rc" = 0 ]; then ok "52j move/valid.tsv completeness by section: $out"; else bad "52j move/valid.tsv completeness" "$out"; fi
c12=$(awk '/aria-labelledby="mv-12"/{on=1} on{print} on && /<\/article>/{exit}' "$H6")
c13=$(awk '/aria-labelledby="mv-13"/{on=1} on{print} on && /<\/article>/{exit}' "$H6")
if printf '%s' "$c12" | grep >/dev/null -F '이미 만든 티켓 <a href="https://example.atlassian.net/browse/TST-120">TST-120</a>로 닫기만 (새 티켓 없음)' \
   && printf '%s' "$c12" | grep >/dev/null -F '<dt>관련 티켓</dt><dd><a href="https://example.atlassian.net/browse/TST-90">TST-90</a>, <a href="https://example.atlassian.net/browse/TST-91">TST-91</a></dd>' \
   && ! printf '%s' "$c12" | grep >/dev/null -F 'prior-alt' \
   && printf '%s' "$c12" | grep >/dev/null -F '<p class="say">GitHub 이슈에 남길 댓글</p>' \
   && printf '%s' "$c12" | grep >/dev/null -F '<div class="comment">이 이슈는 Jira TST-120로 옮겼습니다: https://example.atlassian.net/browse/TST-120' \
   && printf '%s' "$c13" | grep >/dev/null -F '이슈에 이미 있는 이관 댓글을 그대로 둠 — 새 댓글 없음 (<a href="https://github.com/test/repo/issues/13#issuecomment-4001">댓글 4001 보기</a>)' \
   && printf '%s' "$c13" | awk '/<details class="prior-alt">/{on=1} on && /이 이슈는 Jira TST-130로 옮겼습니다/{f=1} /<\/details>/{on=0} END{exit !f}' \
   && ! printf '%s' "$c13" | grep >/dev/null -F 'GitHub 이슈에 남길 댓글' \
   && grep -qF '<p class="say">새 티켓 <code>example.atlassian.net/TST</code> · 유형 작업</p>' "$H6" \
   && grep -qF '<p class="muted">이 계획에는 옮길 Jira 티켓이 없습니다.</p>' "$H6" && ! grep -qF '<span class="flag">잘림</span>' "$H6"; then
  ok "52j move/valid.tsv cards: adopt TST-120 (related TST-90, TST-91, no prior → comment shown), adopt TST-130 with prior 4001 (link, template collapsed), new ticket in 작업, no 잘림"
else bad "52j move/valid.tsv cards" "card text differs"; fi
# 52h2. no plan codes on either move page (action name, snapshot keys, encoded evidence, levels, verdicts) — like 36e
mvcodes="$v4codes|move-issue|payload_sha|source_sha|adopt=|prior=|issuetype|gh_login|project_id|related=|gh="
if [ ! -s "$HM" ] || [ ! -s "$H6" ]; then bad "52h2 no plan codes on move pages" "a move page is missing"
elif grep -nE "$mvcodes" "$HM" "$H6" >/dev/null; then bad "52h2 no plan codes on move pages" "$(grep -noE "$mvcodes" "$HM" "$H6" | head -5 | tr '\n' ' ')"
else ok "52h2 no plan codes on the move pages (action name, snapshot keys, encoded evidence, levels, verdicts)"; fi
# 52k. same move inputs → identical bytes
d=$(mk mv52k); cp "$M5/plan.tsv" "$M5/plan.json" "$d/"; render "$d" --payloads "$M5/payloads"; rc=$?
if [ "$rc" = 0 ] && cmp -s "$HM" "$d/out.html"; then ok "52k move page deterministic"; else bad "52k move page deterministic" "rc=$rc or bytes differ"; fi
# 52l. a plan without move-issue rows renders byte-identically to the renderer before move support: the pages of cases
#      base, 36 (valid.tsv), 51 (every run stage) and 43 (hostile) = the files saved from that renderer
#      (fixtures/chore-v4/move/render/no-move-*.html, rendered 2026-10-21 from git HEAD c56fcaf6's chore-render.py over
#      these same inputs; re-rendered 2026-10-27 by that same renderer after the inputs' branch and key names were
#      neutralized — it still reproduces the old files from the old inputs; re-rendered again 2026-10-27 (phase 2) by
#      that renderer with this renderer's environment-neutral wording table applied — QA tile, level flag, deploy
#      sentence and definition line, deploy-run label — over the inputs with the sample environment renamed; the result
#      equals this renderer's pages byte for byte). An intended change to pages without move rows replaces those files
#      in the same commit.
#      52l2: the same plans rendered again with --payloads <an existing empty folder> (what the skill passes and build
#      makes for a plan without move rows) → exit 0 and the same bytes.
E52=$(mk p52-empty)
for spec in "base:$B" "valid:$A4" "steps:$T/c51" "hostile:$G4"; do
  nm=${spec%%:*}; src=${spec#*:}; g="$MV/render/no-move-$nm.html"
  if [ ! -f "$g" ]; then bad "52l $nm" "golden $g missing"; continue; fi
  if cmp -s "$g" "$src/out.html"; then ok "52l no move rows → page byte-identical to before move support ($nm, $(wc -c < "$g" | tr -d ' ') bytes)"
  else bad "52l $nm page changed" "$(diff "$g" "$src/out.html" | grep '^[<>]' | head -4 | cut -c1-160 | tr '\n' '|')"; fi
  d=$(mk "c52l-$nm"); cp "$src/plan.tsv" "$src/plan.json" "$d/"; render "$d" --payloads "$E52"; rc=$?
  if [ "$rc" = 0 ] && cmp -s "$g" "$d/out.html" && [ -z "$(ls -A "$E52")" ]; then
    ok "52l2 no move rows + empty --payloads folder → exit 0, same bytes as without it ($nm)"
  else bad "52l2 $nm with an empty --payloads folder" "rc=$rc $(head -c 160 "$d/stderr") $(diff "$g" "$d/out.html" 2>/dev/null | grep '^[<>]' | head -2 | cut -c1-120 | tr '\n' '|')"; fi
done

# 47. same v4 inputs → identical bytes
d=$(mk v4det); cp "$A4/plan.tsv" "$A4/plan.json" "$d/"; render "$d"; rc=$?
if [ "$rc" = 0 ] && cmp -s "$H4" "$d/out.html"; then ok "47 v4 page deterministic"; else bad "47 v4 deterministic" "rc=$rc or bytes differ"; fi

printf '%s\n' "---- $n cases, $fail failed"
[ "$fail" = 0 ]
