#!/usr/bin/env python3
"""chore-report.test.py — the final chore report (scripts/chore-report.py) (2026-10-19).

    python3 -I __tests__/py/chore-report.test.py [path/to/chore-report.py]   → exit 0 only when every case passes

Two inputs:
- one real 2026-10-15 ledger of a large repository, read in place from the folder CHORE_REPORT_LEDGER names (plan.tsv,
  apply-1-deploy.out, apply-2-final.out, verify-1.out, verify-final.out; its plan digest is pinned below). That folder
  is operations data, so it is NOT copied into the plaintext fixtures folder; when CHORE_REPORT_LEDGER is unset, the
  folder is absent or it is locked (git-crypt), those cases print "skip" and do not count as failures.
- synthetic v4 fixtures in fixtures/chore-report/ built with chore_plan's encoders: v4-plan.tsv (+ an ABORTED only-group
  run, a full run, and the verify output of both) and v4-jira-plan.tsv (Jira only: an ABORTED full run with Jira results,
  a full rerun, verify). Refusal cases mutate copies in a temp folder; review-round item ids ([A1]…[D]) are in the case names.
Stdlib only, no network. One ok/FAIL/skip line per case.
"""
import atexit
import hashlib
import html
import importlib.util
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent.parent / "scripts"   # <skill>/scripts — this file is <skill>/__tests__/py/
SCRIPT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else SCRIPTS / "chore-report.py"   # mutation runs pass a copy
FIX = HERE.parent / "fixtures" / "chore-report"
# a real ledger is operations data and never lives in this tree: CHORE_REPORT_LEDGER=<folder> runs section 1 on it
LEDGER = Path(os.environ["CHORE_REPORT_LEDGER"]) if os.environ.get("CHORE_REPORT_LEDGER") else None
LEDGER_DIGEST = "d063e4ea853ec6a362f04e8aad56ec02a6ee89b276f43b0ab5f0386ff7553c93"   # README of that ledger
DEFINITION = "배포 확인 = 바인딩의 deploy-proof 워크플로가 성공한 push 실행에 포함됨 — 지금 그 환경이 그 코드라는 뜻은 아님"

_spec = importlib.util.spec_from_file_location("chore_report", SCRIPT)
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

n = fail = skipped = 0
TMP = Path(tempfile.mkdtemp(prefix="chore-report-test."))
atexit.register(shutil.rmtree, TMP, True)


def ok(name):
    global n
    n += 1
    print("ok   %s" % name)


def bad(name, why):
    global n, fail
    n += 1
    fail += 1
    print("FAIL %s :: %s" % (name, why))


def skip(name, why):
    global skipped
    skipped += 1
    print("skip %s :: %s" % (name, why))


def check(name, cond, why=""):
    if cond:
        ok(name)
    else:
        bad(name, why)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(plan, results, verify, digest=None, repo="https://github.com/test/repo", out=None, extra=()):
    """→ (rc, stderr, page or None). The page is read only when rc == 0."""
    out = out or TMP / ("out-%d.html" % n)
    if out.exists() and out.name.startswith("out-"):
        out.unlink()
    args = [sys.executable, "-I", str(SCRIPT), "--plan", str(plan), "--digest", digest or sha(plan)]
    for r in results:
        args += ["--results", str(r)]
    args += ["--verify", str(verify), "--out", str(out), "--repo-url", repo, "--title-date", "2026-10-19"] + list(extra)
    p = subprocess.run(args, capture_output=True)
    err = p.stderr.decode("utf-8", "replace")
    page = out.read_text(encoding="utf-8") if p.returncode == 0 and out.exists() else None
    return p.returncode, err, page


def nums(page):
    """id="x">1,234< → {x: 1234} for every numeric element on the page."""
    return {k: int(v.replace(",", "")) for k, v in re.findall(r'id="([A-Za-z0-9-]+)">([0-9][0-9,]*)<', page)}


def section(page, start_id, end_marker):
    i = page.find('id="%s"' % start_id)
    j = page.find(end_marker, i + 1)
    return page[i:j] if i >= 0 and j > i else ""


def fails_one_line(name, rc, err, needle):
    check(name, rc == 1 and needle in err and err.count("\n") == 1 and err.startswith("chore-report: error: "),
          "rc=%s err=%r" % (rc, err[:300]))


def mutate(src, dst_name, old, new, count=1):
    text = Path(src).read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit("test setup: %r not in %s" % (old, src))
    dst = TMP / dst_name
    dst.write_text(text.replace(old, new, count), encoding="utf-8")
    return dst


def write(name, lines):
    p = TMP / name
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


def run_args(args, cwd=None):
    p = subprocess.run([sys.executable, "-I", str(SCRIPT)] + args, capture_output=True, cwd=cwd)
    return p.returncode, p.stderr.decode("utf-8", "replace")


def next_cmd_tokens(page):
    """→ the recovery command split as a POSIX shell would (None when absent or not valid shell quoting)."""
    m = re.search(r'<pre class="cmd" id="next-cmd">(.*?)</pre>', page, re.S)
    try:
        return [shlex.split(ln) for ln in html.unescape(m.group(1)).split("\n")] if m else None
    except ValueError:
        return None


# ── 1. the real 2026-10-15 ledger (read in place from CHORE_REPORT_LEDGER) ─────────────────────────────
LP, A1, A2, V1, VF = ((LEDGER / x) if LEDGER else None
                      for x in ("plan.tsv", "apply-1-deploy.out", "apply-2-final.out", "verify-1.out", "verify-final.out"))
readable = LEDGER is not None and all(p.is_file() for p in (LP, A1, A2, V1, VF)) and LP.read_bytes()[:14] == b"#chore-plan v3"
if not readable:
    skip("1 real 2026-10-15 ledger cases", "ledger not readable as plaintext (CHORE_REPORT_LEDGER unset, absent or git-crypt locked)")
else:
    # --repo-url must name the plan's own repository (the report refuses any other), so it comes from the header remote=
    GH = "https://github.com/" + dict(f.split("=", 1) for f in LP.read_text(encoding="utf-8").split("\n", 1)[0].split("\t")[1:])["remote"]
    check("1a ledger plan digest = the approval digest in its README", sha(LP) == LEDGER_DIGEST, sha(LP))
    vf = VF.read_text(encoding="utf-8")
    plan_rows = [ln.split("\t") for ln in LP.read_text(encoding="utf-8").split("\n")[1:] if ln]
    want = {"t-branches": vf.count("VERIFY\tOK\tdelete-remote\t"), "t-prs": vf.count("VERIFY\tOK\tclose-pr\t"),
            "t-issues": vf.count("VERIFY\tOK\tclose-issue\t"), "t-jira-qa": 0, "t-jira-closed": 0, "t-decide": 0,
            "t-bad": 0, "t-recent": 0}
    rc, err, page = run(LP, [A1, A2], VF, digest=LEDGER_DIGEST, repo=GH)
    check("1b apply-1 + apply-2 + verify-final renders", rc == 0 and page, "rc=%s err=%r" % (rc, err))
    page = page or ""
    got = nums(page)
    check("1c tiles = counts of the VERIFY file (1822 / 1 / 6, nothing else)",
          {k: got.get(k) for k in want} == want and want["t-branches"] == 1822, "%r vs %r" % ({k: got.get(k) for k in want}, want))
    check("1d rows tried twice count once (325 deleted in run 1, SKIP gone in run 2 → 1822 not 2147)",
          got.get("f-branch-x-done") == 1822 and got.get("f-branch-r-act") == sum(1 for c in plan_rows if c[1] == "delete-remote"),
          "%r %r" % (got.get("f-branch-x-done"), got.get("f-branch-r-act")))
    n_pr = sum(1 for c in plan_rows if c[2].startswith("pr#"))
    n_issue = sum(1 for c in plan_rows if c[2].startswith("issue#"))
    check("1e area totals = plan row counts (PR %d, 이슈 %d, 브랜치 = the rest)" % (n_pr, n_issue),
          got.get("f-pr-total") == n_pr and got.get("f-issue-total") == n_issue
          and got.get("f-branch-total") == len(plan_rows) - n_pr - n_issue and got.get("f-jira-total") == 0, "")
    check("1f success with nothing skipped or not run → plain 모두 확인됨; 58 protected refs 아직 있음",
          '<span id="verdict-text">모두 확인됨</span>' in page and 'id="notrun-note"' not in page
          and "보호·통합 브랜치 <b>58</b>개가 정리 뒤에도 아직 있음" in page and "그대로 있음" not in page, "")
    check("1f2 old plan without close titles: closed PR / issues fall back to the posted comment's first line",
          section(page, "s-done", 'id="s-kept"').count('<span class="muted">남긴 댓글</span>') == 7, "")
    check("1g [C5] coverage: 판정 counts structured verdicts only (0), close rows as 닫기 결정 (1 / 6)",
          [got.get("cov-%d" % i) for i in (0, 1, 2, 3, 8, 9)] == [0, 1, 0, 6, 0, 1822] and "PR 닫기 결정" in page,
          repr([got.get("cov-%d" % i) for i in range(11)]))
    rc, err, page = run(LP, [A2], VF, digest=LEDGER_DIGEST, repo=GH)
    fails_one_line("1h apply-2 alone + verify-final (325 rows only skipped there) → exit 1", rc, err, "verify came from other results")
    rc, err, page = run(LP, [A1], V1, digest=LEDGER_DIGEST, repo=GH)
    got = nums(page or "")
    check("1i [C2] apply-1 + verify-1: headline 확인한 325건 모두 확인됨 · 실행 안 함 1,504건",
          rc == 0 and got.get("t-branches") == 325 and got.get("n-notrun") == 1504 and got.get("f-branch-x-notrun") == 1497
          and '<span id="verdict-text">확인한 325건 모두 확인됨 · 실행 안 함 1,504건</span>' in (page or ""), "rc=%s err=%r" % (rc, err))
    rc, err, page = run(LP, [A1, A2], V1, digest=LEDGER_DIGEST, repo=GH)
    fails_one_line("1j both applies + verify-1 (made from apply-1 only) → exit 1", rc, err, "no line for")
    rc, err, page = run(LP, [A1, A2], VF, digest="0" * 64, repo=GH)
    fails_one_line("1k digest mismatch on the ledger plan → exit 1", rc, err, "not the approved plan")
    rc, err, page = run(LP, [A1, A1], VF, digest=LEDGER_DIGEST, repo=GH)
    fails_one_line("1l [A5] v3 output (no attempt ids) given twice → exit 1", rc, err, "same bytes")

# ── 2. synthetic v4 plan: tiles and funnels ──────────────────────────────────────────────────────────
PLAN = FIX / "v4-plan.tsv"
AP1, AP2, VER = FIX / "v4-apply-1.out", FIX / "v4-apply-2.out", FIX / "v4-verify.out"
RUN = "20261015T051233Z-0a1b2c3d"
rc, err, page = run(PLAN, [AP1, AP2], VER)
check("2a v4 fixture renders", rc == 0 and page, "rc=%s err=%r" % (rc, err))
page = page or ""
got = nums(page)
WANT_TILES = {"t-branches": 3, "t-prs": 1, "t-issues": 1, "t-jira-qa": 1, "t-jira-closed": 0, "t-decide": 5, "t-bad": 2,
              "t-recent": 2}
check("2b [C3] tiles — Jira tiles count only rows this run moved (TST-102 is already-done → 닫음 0)",
      {k: got.get(k) for k in WANT_TILES} == WANT_TILES and "Jira 닫음 · 이번 실행이 옮김" in page
      and "Jira → QA · 이번 실행이 옮김" in page, repr({k: got.get(k) for k in WANT_TILES}))
WANT_FLOW = {"f-pr-total": 9, "f-pr-judged": 5, "f-pr-r-act": 2, "f-pr-r-keep": 1, "f-pr-r-ambiguous": 2, "f-pr-r-out": 4,
             "f-pr-x-done": 1, "f-pr-x-skip": 0, "f-pr-x-bad": 1,
             "f-issue-total": 5, "f-issue-r-act": 2, "f-issue-r-keep": 1, "f-issue-r-out": 2, "f-issue-x-done": 1, "f-issue-x-skip": 1,
             "f-jira-total": 11, "f-jira-judged": 9, "f-jira-r-act": 5, "f-jira-r-keep": 2, "f-jira-r-ambiguous": 2, "f-jira-r-out": 2,
             "f-branch-total": 6, "f-branch-r-act": 4, "f-branch-r-keep": 1, "f-branch-r-out": 1, "f-branch-x-done": 3,
             "f-branch-x-skip": 1, "f-branch-x-bad": 0}
check("2c funnel stage counts (review and execution axes)", {k: got.get(k) for k in WANT_FLOW} == WANT_FLOW,
      repr({k: (got.get(k), v) for k, v in WANT_FLOW.items() if got.get(k) != v}))
check("2d [C3] Jira: moved 1 apart from 목표 상태 확인 — 이번 실행이 옮긴 것 아님/미확정 2, skip 1, bad 1",
      (got.get("f-jira-x-done"), got.get("f-jira-x-already"), got.get("f-jira-x-skip"), got.get("f-jira-x-bad")) == (1, 2, 1, 1)
      and "목표 상태 확인 — 이번 실행이 옮긴 것 아님/미확정" in section(page, "f-jira", 'id="f-branch"')
      and "이미 목표 상태였음" not in page, repr({k: v for k, v in got.items() if k.startswith("f-jira-x")}))
done = section(page, "s-done", 'id="s-kept"')
qa_g, target_g = section(page, "done-jira-qa", "</div>\n</div>"), section(page, "done-jira-target", "</div>\n</div>")
check("2e [C3] TST-101 under Jira → QA as moved; TST-102 (already-done) in the not-moved group, no 닫음/옮김 level text",
      "TST-101" in qa_g and "QA로 옮김 — 배포 확인됨" in qa_g and "TST-102" in target_g
      and "닫음 — 중복·대체" not in target_g and "계획 때 할 일 · 목표 Closed" in target_g
      and 'id="done-jira-closed"' not in page, target_g[:300])
rest = section(page, "s-rest", "<footer>")
check("2f at-target WARN row (TST-106) in 목표 상태 확인 — 이번 실행이 옮긴 것 아님, not in 처리한 것",
      "TST-106" in section(page, "rest-warn", "</div>\n</div>") and "TST-106" not in done, "")
check("2g verdict line: 확인 안 된 것 2건 (실패 0 · 미해결 2 · 주의 1)",
      '<span id="verdict-text">확인 안 된 것 2건</span>' in page and "실패 0 · 미해결 2 · 주의 1" in page, "")
check("2h closed PR / issue named by the plan's title (snapshot title), not by the comment",
      re.search(r'/pull/7">PR #7</a></span><span class="c"><span class="k">내용</span>오래된 실험: 검색, 정렬; 100% 다시 보기', done) is not None
      and re.search(r'/issues/9">이슈 #9</a></span><span class="c"><span class="k">내용</span>로그인 실패 시 안내 문구 없음', done) is not None
      and "재시도 큐 &lt;정리&gt;" in rest and "재시도 큐 <정리>" not in page, "")
check("2i a close row without title (이슈 #31) falls back to the posted comment's first line",
      re.search(r'/issues/31">이슈 #31</a></span><span class="c"><span class="k">내용</span><span class="muted">남긴 댓글</span> 이 이슈는', rest)
      is not None, "")
check("2j delete-remote SKIP gone after UNKNOWN + VERIFY OK is a legitimate reconciliation (done)",
      "feat/unknown-then-gone" in done, "")

# ── 3. decisions grouped by owner, manual SKIP among them ────────────────────────────────────────────
dec = section(page, "s-decide", 'id="s-done"')
groups = re.findall(r'<div class="ogroup" id="og-\d+" data-owner="([^"]*)">(.*?)</div>\n(?=<div class="ogroup"|</section>)', dec, re.S)
owner_cards = [(o, re.findall(r'<article class="card attn" id="([^"]+)"', body)) for o, body in groups]
check("3a owner groups in order 나 → 작성자 alice → 작성자 dave → QA 팀, each with its cards",
      owner_cards == [("me", ["d-pr-26", "d-jira-TST-105"]), ("author:alice", ["d-jira-TST-103"]),
                      ("author:dave", ["d-pr-21"]), ("qa-team", ["d-jira-TST-201"])], repr(owner_cards))
check("3a2 AMBIGUOUS + manual SKIP are named 결정 필요 (tile, funnel, cards); 확인 필요 is not used for them",
      "결정 필요</span>" in section(page, "t-decide", "</li>") and "결정 필요 · Jira 실행 멈춤" in dec
      and "결정 필요 · PR" in dec and ">확인 필요" not in page and "확인 필요 ·" not in page, "")
check("3b group headings in plain words", all(h in dec for h in ("<h3>나 ", "<h3>작성자 alice ", "<h3>작성자 dave ", "<h3>QA 팀 ")), "")
card = section(page, "d-jira-TST-105", "</article>")
check("3c [C1] manual SKIP with no earlier write: 'this run did not write', never 'nothing changed'; not in 건너뜀·실패·미해결",
      "Jira 실행 멈춤" in card and "이번 실행은 이 티켓에 쓰지 않고 멈췄습니다" in card and "보냈을 수 있음" not in card
      and "아무것도 바꾸지" not in card and "사람 확인 필요: 정리 댓글이 예상과 다름" in card and "manual:" not in card
      and "TST-105" not in rest and "멈춘 Jira 1건" in rest, card[:300])
check("3c2 [C1] section intro with a stopped Jira row does not say the run changed nothing",
      "이 정리는 이 항목들에 아무것도 바꾸지 않았습니다" not in dec and "판정만 한 항목은 이 정리가 바꾸지 않았습니다" in dec, "")
card = section(page, "d-pr-21", "</article>")
check("3d AMBIGUOUS card fields: reason, 아는 것, 모르는 것, 누가 정하나, 추천, 근거, 연결된 티켓",
      all(x in card for x in ("기능 플래그 뒤에 있어", "<dt>아는 것</dt><dd>마지막 커밋 2026-07-01; develop과 충돌 없음",
                              "<dt>모르는 것</dt><dd>실험을 계속할지", "<dt>누가 정하나</dt><dd>검색 기능 담당",
                              "<dt>추천</dt><dd>계속하지 않으면 닫으세요, 계속하면 TST-77에 연결", "<dt>근거</dt>",
                              "TST-77</a> (In Progress)")), card[:400])

# ── 4. kept / not judged / excluded lists ────────────────────────────────────────────────────────────
recent = section(page, "s-recent", "</div>\n<div")
check("4a 판정 제외 — 최근 갱신: PR #23 (2026-10-12, dave) and 이슈 #32 with its linked ticket status",
      all(x in recent for x in ('/pull/23">PR #23</a>', "2026-10-12 18:00 KST", "작성자 dave", '/issues/32">이슈 #32</a>',
                                'TST-120</a> (In Progress)')), recent[:300])
excl = section(page, "s-excluded", "</div>\n<div")
check("4b 제외한 Jira: TST-104 and TST-202 with the reason",
      "TST-104" in excl and "TST-202" in excl and excl.count("보류 상태(jira-hold)라 판정하지 않음") == 2 and "보류 (외부 대기)" in excl, excl[:300])
keep = section(page, "s-keep", "</div>\n<div")
check("4c 판정 후 남긴 것: KEEP PR #25 / 이슈 #22 / TST-108, judged-not-acted TST-109 says it was not executed",
      all(x in keep for x in ("PR #25", "이슈 #22", "TST-108", "TST-109", "이번 계획에서는 실행하지 않음")), keep[:300])
plain = section(page, "s-plain", "</div>\n<div")
check("4e plain row titled t=a;v=b (no verdict key) = plain kept row with that literal title, never a decision card",
      re.search(r'/pull/34">PR #34</a></span><span class="c"><span class="k">제목</span>t=a;v=b<', plain) is not None
      and "PR #34" not in dec and 'id="d-pr-34"' not in page, plain[:200])
check("4f tiles keep 2 columns at the narrowest width (no 1-column rule)",
      ".stats{grid-template-columns:repeat(2,minmax(0,1fr))}" in page and ".stats{grid-template-columns:minmax(0,1fr)}" not in page, "")
check("4d plain PR/issue rows and branch hold groups listed", "판정 기록 없음, 손대지 않음" in page and "열린 PR #8의 브랜치" in page
      and "오래됐지만 병합 근거가 없는 브랜치" in page, "")

# ── 5. concatenated runs, encoded refs, skip / fail texts ───────────────────────────────────────────
check("5a feat/login-form (OK in run 1, SKIP gone in run 2) is done once", done.count("feat/login-form") == 1, "")
check("5b branch named feat/a=b%c (RESULT ref feat/a%3Db%25c) joins its row and counts as deleted",
      "feat/a=b%c" in done and "feat/a%3Db%25c" not in page, "")
check("5c NOT-ATTEMPTED then SKIP (feat/stale-skip) = 건너뜀, 2 attempts, resolved text in words",
      re.search(r"feat/stale-skip.*?2번 시도.*?해소됨 — 앞선 실행은 시도 안 함, 마지막 실행은 건너뜀", rest, re.S) is not None, "")
check("5d failed close (PR #30) under 실패·미해결 with the engine reason and the next command",
      "PR #30" in section(page, "rest-bad", "</div>\n</div>") and 'id="next-cmd"' in rest and sha(PLAN) in rest, "")
check("5e [C5] coverage: 판정 = structured verdict rows (PR 3 · 이슈 1 · Jira 4), 닫기/옮기기 결정 separate",
      [got.get("cov-%d" % i) for i in range(11)] == [3, 2, 1, 2, 4, 5, 2, 2, 5, 4, 0]
      and "그룹만 실행 1" in page and "중간에 멈춤 1" in page, repr([got.get("cov-%d" % i) for i in range(11)]))
check("5f definition line exact", '<p id="def-proof">%s</p>' % DEFINITION in page and "#def-proof{" in page, "")
check("5g [C7] inventory line does not claim the tickets are mine: 검색 조건에 걸린 미완료 n건 + the JQL",
      "검색 조건에 걸린 미완료 Jira 11건" in page and "내게 할당된" not in page and "currentUser()" in page, "")
check("5h [C7] protected refs reported as 아직 있음 (existence, not tip), never 그대로 있음",
      "보호·통합 브랜치 <b>2</b>개가 정리 뒤에도 아직 있음" in page and "그대로 있음" not in page, "")

# ── 6. escaping and links ────────────────────────────────────────────────────────────────────────────
check("6a hostile title / reason / engine text are escaped, never raw markup",
      "<script>" not in page and "&lt;script&gt;alert(1)&lt;/script&gt;" in page and "<img src=x" not in page
      and "&lt;img src=x onerror=alert(1)&gt;" in page and "<b>굵게</b>" not in page and "&lt;b&gt;굵게&lt;/b&gt;" in page, "")
check("6b U+202E shown as a marked code point, never raw; legend counts it",
      "‮" not in page and 'aria-label="숨김 문자 U+202E"' in page and 'id="hid-kinds">1<' in page, "")
check("6c links: PR / issue via --repo-url, Jira browse on the row / inventory site, deploy run",
      all(x in page for x in ('href="https://github.com/test/repo/pull/21"', 'href="https://github.com/test/repo/issues/9"',
                              'href="https://example.atlassian.net/browse/TST-201"', 'href="https://example.atlassian.net/browse/TST-103"',
                              'href="https://example.atlassian.net/browse/TST-101"',
                              'href="https://github.com/test/repo/actions/runs/9000000001"')), "")
check("6d no script, no external resource", "<script" not in page and not re.search(r'<(link|img|iframe)\b', page)
      and "@import" not in page and "url(" not in page, "")

check("6e screen-reader tables sit inside a clipped div (a table ignores width:1px and would cause sideways scrolling)",
      '<table class="sr"' not in page and page.count('<div class="sr"><table') == page.count("<table"), "")

# ── 7. only-group runs: NOT-SCHEDULED Jira rows, never-run rows, headline ───────────────────────────
VOG_LINES = [
    "VERIFY\tOK\tdelete-remote\tfeat/login-form\tabsent on origin",
    "VERIFY\tOK\tdelete-remote\tfeat/a%3Db%25c\tabsent on origin",
    "VERIFY\tUNRESOLVED\tdelete-remote\tfeat/stale-skip\tlast result NOT-ATTEMPTED: run aborted at remote-batch-1; still on origin",
    "VERIFY\tOK\tdelete-remote\tfeat/unknown-then-gone\treconciled: absent at verify (was UNKNOWN)"] + [
    "VERIFY\tNOT-SCHEDULED\tjira-transition\tjira#%s\t그룹 실행만 있어 이번에 다루지 않음" % k
    for k in ("TST-101", "TST-102", "TST-105", "TST-106", "TST-107")] + [
    "VERIFY\tOK\tp-invariant\tdevelop\tpresent", "VERIFY\tOK\tp-invariant\tdeploy/staging\tpresent",
    "VERIFY\tINCOMPLETE\trun\t%s\tapply stopped at remote-batch-1 with 1 rows not attempted" % RUN,
    "VERIFY-SUMMARY\tfail=0\twarn=0\tunresolved=1\trun=incomplete\tsuccess=no"]
v_og = write("verify-only-group.out", VOG_LINES)
rc, err, page = run(PLAN, [AP1], v_og)
page = page or ""
got = nums(page)
check("7a only-group ABORTED run: Jira rows NOT-SCHEDULED → 실행 안 함 (5th segment shown), closes not run",
      rc == 0 and got.get("f-jira-x-notrun") == 5 and got.get("f-pr-x-notrun") == 2 and got.get("n-notrun") == 9
      and got.get("t-branches") == 3, "rc=%s err=%r" % (rc, err))
check("7b incomplete run noted at the top and listed under 저장소 전체 확인",
      'id="run-incomplete"' in page and "멈춘 단계 remote-batch-1" in page and 'id="rest-meta"' in page, "")
notrun_g = section(page, "rest-notrun", "</div>\n</div>")
check("7c [C7] never-run rows say 실행되지 않아 확인 없음 (not 건너뛴 행은 확인하지 않음)",
      "실행되지 않아 확인 없음" in notrun_g and "건너뛴 행은 확인하지 않음" not in notrun_g and "PR #7" in notrun_g, notrun_g[:200])
check("7d [C1] decisions that are only judged units keep 'the run changed nothing' in the intro",
      "이 정리는 이 항목들에 아무것도 바꾸지 않았습니다" in section(page, "s-decide", 'id="s-done"'), "")
rc, err, _ = run(PLAN, [AP1], write("v-og-run.out", [x.replace("run=incomplete", "run=complete") for x in VOG_LINES]))
fails_one_line("7e verify run=complete while the last apply was ABORTED → exit 1", rc, err, "verify came from other results")
A_OG = "20261019T010000Z-abcdef01"
ap_og = write("apply-og-ok.out", [
    "RESULT\tOK\tdelete-remote\tfeat/login-form\tdeleted", "RESULT\tOK\tdelete-remote\tfeat/a%3Db%25c\tdeleted",
    "RESULT\tOK\tdelete-remote\tfeat/unknown-then-gone\tdeleted",
    "RESULT\tSKIP\tdelete-remote\tfeat/stale-skip\tbasis-changed (PR #105 no longer matches the snapshot)",
    "SUMMARY\tok=3\tskip=1\tfail=0\tunknown=0\trun_id=%s\tattempt=%s\tscope=only-group\tjournal=/j" % (RUN, A_OG)])
v_og_ok = write("verify-og-ok.out", VOG_LINES[:2] + ["VERIFY\tOK\tdelete-remote\tfeat/unknown-then-gone\tabsent on origin"]
                + VOG_LINES[4:11] + ["VERIFY-SUMMARY\tfail=0\twarn=0\tunresolved=0\trun=complete\tsuccess=yes"])
rc, err, page = run(PLAN, [ap_og], v_og_ok)
check("7f [C2] success=yes with rows not run and skipped → 확인한 3건 모두 확인됨 · 실행 안 함 9건 · 건너뜀 1건",
      rc == 0 and '<span id="verdict-text">확인한 3건 모두 확인됨 · 실행 안 함 9건 · 건너뜀 1건</span>' in (page or ""),
      "rc=%s err=%r" % (rc, err))

# ── 8. refusals: results provenance [A1–A5] ──────────────────────────────────────────────────────────
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-runid.out", "run_id=" + RUN, "run_id=20261015T051233Z-ffffffff")], VER)
fails_one_line("8a SUMMARY run_id ≠ plan run_id → exit 1", rc, err, "is not the plan's run")
rc, err, _ = run(PLAN, [mutate(AP1, "a1-runid.out", "run_id=" + RUN, "run_id=20261015T051233Z-ffffffff"), AP2], VER)
fails_one_line("8b ABORTED run_id ≠ plan run_id → exit 1", rc, err, "ABORTED run_id")
rc, err, _ = run(PLAN, [AP1, AP2], VER, digest="1" * 64)
fails_one_line("8c digest mismatch → exit 1", rc, err, "not the approved plan")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-tail.out", "scope=full\tjournal=/repo/.git/chore/%s.journal\n" % RUN,
                                    "scope=full\tjournal=/repo/.git/chore/%s.journal\nRESULT\tOK\tclose-issue\tissue#31\tclosed\n" % RUN)], VER)
fails_one_line("8d [A1] RESULT after the last SUMMARY (no closing line) → exit 1", rc, err, "결과 파일이 끝까지 기록되지 않음")
A2_ = Path(AP2).read_text(encoding="utf-8")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-5col.out", "\tattempt=20261019T030000Z-5e6f7a8b\nRESULT\tOK\tjira-transition\tjira#TST-102",
                                    "\nRESULT\tOK\tjira-transition\tjira#TST-102")], VER)
fails_one_line("8e [A2] Jira RESULT with 5 columns → exit 1", rc, err, "exactly 6 columns")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-att.out", "moved: QA (staging)로 옮김\tattempt=20261019T030000Z-5e6f7a8b",
                                    "moved: QA (staging)로 옮김\tattempt=20261019T030000Z-00000000")], VER)
fails_one_line("8f [A2] Jira RESULT attempt ≠ its run's closing attempt → exit 1", rc, err, "does not belong to this run")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-cls.out", "SKIP\tjira-transition\tjira#TST-105\tmanual:", "SKIP\tjira-transition\tjira#TST-105\tManual:")], VER)
fails_one_line("8g [A2] unknown Jira class (Manual:) → exit 1", rc, err, "reason must start with one of")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-cls2.out", "OK\tjira-transition\tjira#TST-102\talready-done:", "OK\tjira-transition\tjira#TST-102\tmanual:")], VER)
fails_one_line("8h [A2] class not allowed for the status (OK manual:) → exit 1", rc, err, "reason must start with one of")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-6col.out", "RESULT\tOK\tclose-pr\tpr#7\tclosed", "RESULT\tOK\tclose-pr\tpr#7\tclosed\tattempt=20261019T030000Z-5e6f7a8b")], VER)
fails_one_line("8i [A2] 6-column non-Jira RESULT → exit 1", rc, err, "exactly 5 columns")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-noatt.out", "\tattempt=20261019T030000Z-5e6f7a8b\tscope=full", "\tscope=full")], VER)
fails_one_line("8j [A2] Jira RESULT in a run whose closing line has no attempt → exit 1", rc, err, "does not belong to this run")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-dup.out", "RESULT\tOK\tclose-pr\tpr#7\tclosed\n", "RESULT\tOK\tclose-pr\tpr#7\tclosed\nRESULT\tOK\tclose-pr\tpr#7\tclosed\n")], VER)
fails_one_line("8k [A3] same row twice in one run → exit 1", rc, err, "second RESULT")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-ok.out", "SUMMARY\tok=4", "SUMMARY\tok=5")], VER)
fails_one_line("8l [A4] SUMMARY ok=5 with four OK lines → exit 1", rc, err, "results do not add up")
rc, err, _ = run(PLAN, [mutate(AP1, "a1-skip.out", "\tskip=0\t", "\tskip=1\t"), AP2], VER)
fails_one_line("8m [A4] ABORTED skip=1 with no SKIP line → exit 1", rc, err, "results do not add up")
rc, err, _ = run(PLAN, [mutate(AP1, "a1-una.out", "unattempted=1", "unattempted=2"), AP2], VER)
fails_one_line("8n [A4] ABORTED unattempted=2 with one NOT-ATTEMPTED line → exit 1", rc, err, "unattempted=2")
rc, err, _ = run(PLAN, [mutate(AP1, "a1-q.out", "unattempted=1", "unattempted=?"), AP2], VER)
fails_one_line("8o [A4] ABORTED unattempted=? while a NOT-ATTEMPTED line exists → exit 1", rc, err, "results do not add up")
rc, err, _ = run(PLAN, [AP1, AP2, mutate(AP2, "a2-copy.out", "closed\n", "closed \n")], VER)
fails_one_line("8p [A5] the same attempt closes two runs (one run given twice) → exit 1", rc, err, "already closed")
v3a = mutate(AP1, "a1-v3.out", "\tattempt=20261019T020000Z-1a2b3c4d\tscope=only-group\tjournal=/repo/.git/chore/%s.journal" % RUN, "")
rc, err, _ = run(PLAN, [v3a, v3a], v_og)
fails_one_line("8q [A5] v3 output without attempt ids, identical bytes twice → exit 1", rc, err, "same bytes")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-ref.out", "close-pr\tpr#7\t", "close-pr\tpr#77\t")], VER)
fails_one_line("8r RESULT for a row not in the plan → exit 1", rc, err, "not an action row of this plan")
rc, err, _ = run(PLAN, [AP1, mutate(AP2, "a2-junk.out", "RESULT\tOK\tclose-pr", "chore: note\nRESULT\tOK\tclose-pr")], VER)
fails_one_line("8s a line that is not RESULT/SUMMARY/ABORTED → exit 1", rc, err, "not a RESULT / SUMMARY / ABORTED line")
JA1, JA2 = FIX / "v4-jira-apply-1.out", FIX / "v4-jira-apply-2.out"
JPLAN, JVER = FIX / "v4-jira-plan.tsv", FIX / "v4-jira-verify.out"
rc, err, _ = run(JPLAN, [mutate(JA1, "ja1-cls.out", "jira#TST-101\tjournal has", "jira#TST-101\tmoved: journal has"), JA2], JVER)
fails_one_line("8t [A2] Jira UNKNOWN carrying a class → exit 1", rc, err, "UNKNOWN / NOT-ATTEMPTED have none")

# ── 9. refusals: verify output [A6, B] ───────────────────────────────────────────────────────────────
V_ = Path(VER).read_text(encoding="utf-8")


def vmut(name, old, new):
    return mutate(VER, name, old, new)


rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-warn.out", "warn=1", "warn=0"))
fails_one_line("9a VERIFY-SUMMARY warn=0 with one WARN line → exit 1", rc, err, "totals do not add up")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-succ.out", "success=no", "success=yes"))
fails_one_line("9b success=yes with unresolved=2 → exit 1", rc, err, "contradicts")
rc, err, _ = run(PLAN, [AP1], write("v-og-runref.out", [x.replace("\trun\t" + RUN, "\trun\t20261015T051233Z-ffffffff") for x in VOG_LINES]))
fails_one_line("9c [A6] VERIFY run line for another run id → exit 1", rc, err, "VERIFY run line names run")
rc, err, _ = run(PLAN, [AP1], write("v-og-noinc.out", [x for x in VOG_LINES if "\tINCOMPLETE\t" not in x]))
fails_one_line("9d [A6] run=incomplete without the INCOMPLETE run line → exit 1", rc, err, "verify came from other results")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-pres.out", "VERIFY\tOK\tp-invariant\tdevelop", "VERIFY\tRESOLVED\tp-invariant\tdevelop"))
fails_one_line("9e [A6] a status the engine never gives a protected-branch line → exit 1", rc, err, "not a status the engine gives a p-invariant")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-pref.out", "p-invariant\tdeploy/staging\t", "p-invariant\tfeat/other\t"))
fails_one_line("9f [A6] protected-branch line for a ref not in the plan's protected tips → exit 1", rc, err, "not one of the plan's protected tips")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-pcut.out", "VERIFY\tOK\tp-invariant\tdeploy/staging\tpresent\n", ""))
fails_one_line("9g [A6] a protected tip with no line (cut verify output) → exit 1", rc, err, "verify output is cut")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-ptouch.out", "VERIFY-SUMMARY\tfail=0", "VERIFY\tFAIL\tp-touched\tfeat/zzz\tx\nVERIFY-SUMMARY\tfail=1"))
fails_one_line("9h [A6] p-touched for a ref that is no remote delete of the plan → exit 1", rc, err, "not a remote delete of this plan")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-ref.out", "VERIFY\tOK\tclose-pr\tpr#7\tCLOSED", "VERIFY\tOK\tclose-pr\tpr#77\tCLOSED"))
fails_one_line("9i [A6] VERIFY for a row not in the plan → exit 1", rc, err, "not an action row of this plan")
rc, err, _ = run(PLAN, [AP1, AP2], write("v-nosum.out", V_.rstrip("\n").split("\n")[:-1]))
fails_one_line("9j [A6] no VERIFY-SUMMARY → exit 1", rc, err, "no VERIFY-SUMMARY")
rc, err, _ = run(PLAN, [AP1, AP2], write("v-after.out", V_.rstrip("\n").split("\n") + ["VERIFY\tOK\tclose-pr\tpr#7\tCLOSED"]))
fails_one_line("9k [A6] a line after VERIFY-SUMMARY → exit 1", rc, err, "line after VERIFY-SUMMARY")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-dup.out", "VERIFY\tOK\tclose-pr\tpr#7\tCLOSED", "VERIFY\tOK\tclose-pr\tpr#7\tCLOSED\nVERIFY\tOK\tclose-pr\tpr#7\tCLOSED"))
fails_one_line("9l second VERIFY line for one row → exit 1", rc, err, "second VERIFY line")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-extra.out", "VERIFY\tOK\tclose-issue\tissue#9\tCLOSED",
                                       "VERIFY\tOK\tclose-issue\tissue#9\tCLOSED\nVERIFY\tOK\tclose-issue\tissue#31\tCLOSED"))
fails_one_line("9m VERIFY for a row the results only skipped → exit 1", rc, err, "only skipped")
# 이슈 #31의 유일한 결과 = SKIP changed since approval (now: CLOSED …), 앞선 OK·FAIL·UNKNOWN·NOT-ATTEMPTED 없음. 닫은 실행이
# 엔진째 SIGKILL로 빠지고(SKILL.md 10단계) 다시 실행이 이미 닫힌 것을 본 경우 — chore.sh cmd_verify는 줄을 안 내거나
# 정확히 OK R.RECONCILED_CLOSE 한 문자열을 낸다(13b가 chore.sh 본문과 맞춰 봄).
RECON_CLOSE = "VERIFY\tOK\tclose-issue\tissue#31\t" + R.RECONCILED_CLOSE
CHECKED_SKIP = "확인함 — 이 계획의 승인 댓글과 함께 닫힌 흔적이 없어 건너뜀으로 둠"


def row_li(page, needle):
    """페이지 목록에서 needle이 든 행(<li class="row">…</li>) 하나, 없으면 ""."""
    return next((x for x in re.findall(r'<li class="row">(.*?)</li>', page, re.S) if needle in x), "")


rc, err, page = run(PLAN, [AP1, AP2], vmut("v-rc-ok.out", "VERIFY\tOK\tclose-issue\tissue#9\tCLOSED",
                                          "VERIFY\tOK\tclose-issue\tissue#9\tCLOSED\n" + RECON_CLOSE))
got, page = nums(page or ""), page or ""
check("9m2 close row with only SKIP changed + VERIFY OK reconciled: CLOSED … (rerun SKIP changed) → 닫음 (done), not 건너뜀",
      rc == 0 and (got.get("t-issues"), got.get("f-issue-x-done"), got.get("f-issue-x-skip")) == (2, 2, 0)
      and "/issues/31\">이슈 #31</a>" in section(page, "s-done", 'id="s-kept"')
      and "/issues/31\">" not in section(page, "s-rest", "<footer>")
      and "이 계획의 닫기로 셈 — 누가 닫았는지는 확인 안 됨" in row_li(section(page, "s-done", 'id="s-kept"'), '/issues/31">')
      and "처음 결과는 몰랐지만" not in row_li(page, '/issues/31">') and "닫은 실행" not in page
      and "확인 때 닫혀 있고 계획 시각 뒤에" in row_li(page, '/issues/31">') and "다시 실행했을 때 이미 닫혀" not in page,
      "rc=%s err=%r got=%r" % (rc, err, (got.get("t-issues"), got.get("f-issue-x-done"), got.get("f-issue-x-skip"))))
rc, err, page = run(PLAN, [AP1, AP2], VER)
got, page = nums(page or ""), page or ""
r31 = row_li(section(page, "s-rest", "<footer>"), '/issues/31">')
check("9m3 same close row with no VERIFY line → 건너뜀 (skip), not done; its 확인 cell says the engine checked "
      "(no close with the approved comment), never 건너뛴 행은 확인하지 않음",
      rc == 0 and (got.get("t-issues"), got.get("f-issue-x-done"), got.get("f-issue-x-skip")) == (1, 1, 1)
      and "/issues/31\">" not in section(page, "s-done", 'id="s-kept"') and CHECKED_SKIP in r31
      and "건너뛴 행은 확인하지 않음" not in r31, "rc=%s err=%r row=%r" % (rc, err, r31[:400]))
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-rc-pr7.out", "VERIFY\tOK\tclose-pr\tpr#7\tCLOSED", "VERIFY\tOK\tclose-pr\tpr#7\t" + R.RECONCILED_CLOSE))
fails_one_line("9m3b close row whose last result is OK + VERIFY OK with the SKIP-changed reconcile text → exit 1", rc, err,
               "close-pr pr#7, whose last result is not SKIP changed since approval")
RECON_PREFIX = RECON_CLOSE.rsplit(" (", 1)[0]   # "… reconciled: CLOSED with the approved comment at verify" — 끝만 바꾼다
for tag, line, needle in (
        ("OK, the same prefix + (rerun SKIP gone)", RECON_PREFIX + " (rerun SKIP gone)", "only skipped (changed since approval)"),
        ("OK, the bare prefix with no suffix", RECON_PREFIX, "only skipped (changed since approval)"),
        ("OK, the same prefix + (was UNKNOWN) (the UNKNOWN-branch text)", RECON_PREFIX + " (was UNKNOWN)",
         "only skipped (changed since approval)"),
        ("OK, the exact text + a trailing space", RECON_CLOSE + " ", "only skipped (changed since approval)"),
        ("RESOLVED with the exact text", RECON_CLOSE.replace("VERIFY\tOK\t", "VERIFY\tRESOLVED\t"), "the engine gives no line/OK")):
    rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-rc-%d.out" % n, "VERIFY\tOK\tclose-issue\tissue#9\tCLOSED",
                                           "VERIFY\tOK\tclose-issue\tissue#9\tCLOSED\n" + line))
    fails_one_line("9m4 same close row + VERIFY %s → exit 1" % tag, rc, err, needle)
a1_no_na = TMP / "a1-no-na.out"
a1_no_na.write_text(Path(AP1).read_text(encoding="utf-8").replace(
    "RESULT\tNOT-ATTEMPTED\tdelete-remote\tfeat/stale-skip\trun aborted at remote-batch-1\n", "")
    .replace("unattempted=1", "unattempted=0"), encoding="utf-8")
a2_chg = mutate(AP2, "a2-dr-chg.out", "feat/stale-skip\tbasis-changed (PR #105 no longer matches the snapshot)",
                "feat/stale-skip\tchanged since approval (now: x)")
rc, err, _ = run(PLAN, [a1_no_na, a2_chg], VER)
check("9m5 (setup) delete-remote row whose only result is SKIP changed: its RESOLVED line is refused as before",
      rc == 1 and "only skipped" in err and "feat/stale-skip" in err, "rc=%s err=%r" % (rc, err))
rc, err, _ = run(PLAN, [a1_no_na, a2_chg], vmut("v-dr-rc.out", "VERIFY\tRESOLVED\tdelete-remote\tfeat/stale-skip\t"
                                                "earlier NOT-ATTEMPTED, last run SKIP: basis-changed (PR #105 no longer matches the snapshot)",
                                                "VERIFY\tOK\tdelete-remote\tfeat/stale-skip\t" + R.RECONCILED_CLOSE))
fails_one_line("9m6 SKIP changed on a delete-remote row + VERIFY OK reconciled … → exit 1 (closes only)", rc, err,
               "delete-remote feat/stale-skip, which these results only skipped")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-dr-pb.out", "VERIFY\tRESOLVED\tdelete-remote\tfeat/stale-skip\t"
                                        "earlier NOT-ATTEMPTED, last run SKIP: basis-changed (PR #105 no longer matches the snapshot)",
                                        "VERIFY\tOK\tdelete-remote\tfeat/stale-skip\t" + R.RECONCILED_CLOSE))
fails_one_line("9m7 delete-remote SKIP after an earlier NOT-ATTEMPTED + VERIFY OK reconciled … → exit 1 (unchanged: RESOLVED only)",
               rc, err, "the engine gives RESOLVED;")
# 같은 이슈 #31에 앞선 실행의 FAIL / UNKNOWN이 있고(prevbad), 마지막은 그대로 SKIP changed since approval, OK는 없음(everok 0)
# → 엔진(6d)은 RESOLVED earlier <X>, last run SKIP: changed …, 또는 정확히 OK R.RECONCILED_CLOSE.
PRIOR = {"UNKNOWN": ["RESULT\tUNKNOWN\tclose-issue\tissue#31\tsent at close, outcome unread",
                     "ABORTED\trun_id=%s\tat=close\tok=0\tskip=0\tfail=0\tunknown=1\tunattempted=0\treason=killed"
                     "\tattempt=20261019T025000Z-31310001\tscope=full\tjournal=/j" % RUN],
         "FAIL": ["RESULT\tFAIL\tclose-issue\tissue#31\tgh issue close failed: HTTP 502",
                  "SUMMARY\tok=0\tskip=0\tfail=1\tunknown=0\trun_id=%s\tattempt=20261019T025000Z-31310002\tscope=full\tjournal=/j" % RUN],
         "NOT-ATTEMPTED": ["RESULT\tNOT-ATTEMPTED\tclose-issue\tissue#31\trun aborted at close",
                           "ABORTED\trun_id=%s\tat=close\tok=0\tskip=0\tfail=0\tunknown=0\tunattempted=1\treason=stopped"
                           "\tattempt=20261019T025000Z-31310003\tscope=full\tjournal=/j" % RUN]}
I9 = "VERIFY\tOK\tclose-issue\tissue#9\tCLOSED"
RESOLVED31 = "VERIFY\tRESOLVED\tclose-issue\tissue#31\tearlier %s, last run SKIP: changed since approval (now: CLOSED 2026-10-18T00:00:00Z)"
for pb, vline, want_exec in (("UNKNOWN", RECON_CLOSE, "done"), ("UNKNOWN", RESOLVED31 % "UNKNOWN", "skip"),
                             ("FAIL", RECON_CLOSE, "done"), ("FAIL", RESOLVED31 % "FAIL", "skip"),
                             ("NOT-ATTEMPTED", RECON_CLOSE, "done"), ("NOT-ATTEMPTED", RESOLVED31 % "NOT-ATTEMPTED", "skip")):
    prior = write("ap-prior-%s.out" % pb, PRIOR[pb])
    rc, err, page = run(PLAN, [AP1, prior, AP2], vmut("v-pb-%d.out" % n, I9, I9 + "\n" + vline))
    got, page = nums(page or ""), page or ""
    in_done = "/issues/31\">" in section(page, "s-done", 'id="s-kept"')
    want_n = (2, 2, 0) if want_exec == "done" else (1, 1, 1)
    check("9m8 %s then SKIP changed (close-issue) + VERIFY %s → %s"
          % (pb, "OK exact text" if vline == RECON_CLOSE else "RESOLVED earlier %s" % pb, "닫음 (done)" if want_exec == "done" else "건너뜀 (skip)"),
          rc == 0 and (got.get("t-issues"), got.get("f-issue-x-done"), got.get("f-issue-x-skip")) == want_n
          and in_done == (want_exec == "done"),
          "rc=%s err=%r got=%r" % (rc, err, (got.get("t-issues"), got.get("f-issue-x-done"), got.get("f-issue-x-skip"))))
for pb, line in (("UNKNOWN", RECON_PREFIX + " (was UNKNOWN)"), ("FAIL", RECON_PREFIX + " (rerun SKIP gone)"),
                 ("UNKNOWN", RECON_CLOSE.replace("issue#31\tr", "issue#31\tR")), ("NOT-ATTEMPTED", RECON_PREFIX + " (rerun SKIP gone)")):
    rc, err, _ = run(PLAN, [AP1, write("ap-prior-%s.out" % pb, PRIOR[pb]), AP2], vmut("v-pbx-%d.out" % n, I9, I9 + "\n" + line))
    vt = line.split("\t")[-1]
    fails_one_line("9m9 %s then SKIP changed (close-issue) + VERIFY OK %r → exit 1" % (pb, vt[:12] + "…" + vt[-22:]), rc, err,
                   "after an earlier %s — the engine gives RESOLVED there, or exactly OK" % pb)
for pb in ("NOT-ATTEMPTED", "UNKNOWN", "FAIL"):   # 앞선 실패가 있으면 엔진은 항상 줄을 낸다(RESOLVED 또는 OK)
    rc, err, _ = run(PLAN, [AP1, write("ap-prior-%s.out" % pb, PRIOR[pb]), AP2], VER)
    fails_one_line("9m10 %s then SKIP changed (close-issue) + no VERIFY line → exit 1" % pb, rc, err,
                   "no line for close-issue issue#31 (last result SKIP)")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-nojira.out", "VERIFY\tOK\tjira-transition\tjira#TST-101\t이번 실행이 옮김\n", ""))
fails_one_line("9n Jira row without its VERIFY line → exit 1", rc, err, "no line for")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-b1.out", "VERIFY\tOK\tclose-pr\tpr#7\tCLOSED", "VERIFY\tRESOLVED\tclose-pr\tpr#7\tCLOSED"))
fails_one_line("9o [B] last OK but VERIFY RESOLVED → exit 1", rc, err, "the engine gives OK/FAIL")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-b2.out", "VERIFY\tRESOLVED\tdelete-remote\tfeat/stale-skip", "VERIFY\tOK\tdelete-remote\tfeat/stale-skip"))
fails_one_line("9p [B] SKIP after an earlier NOT-ATTEMPTED but VERIFY OK → exit 1", rc, err, "the engine gives RESOLVED")
rc, err, _ = run(PLAN, [AP1], write("v-b3.out", [x.replace("VERIFY\tOK\tdelete-remote\tfeat/unknown-then-gone", "VERIFY\tFAIL\tdelete-remote\tfeat/unknown-then-gone")
                                                  .replace("fail=0", "fail=1") for x in VOG_LINES]))
fails_one_line("9q [B] last UNKNOWN but VERIFY FAIL → exit 1", rc, err, "the engine gives OK/UNRESOLVED")
rc, err, _ = run(PLAN, [AP1, AP2], write("v-b4.out", [x.replace("VERIFY\tUNRESOLVED\tclose-pr\tpr#30", "VERIFY\tOK\tclose-pr\tpr#30")
                                    .replace("unresolved=2", "unresolved=1") for x in V_.rstrip("\n").split("\n")]))
fails_one_line("9r [B] last FAIL but VERIFY OK → exit 1", rc, err, "the engine gives UNRESOLVED")
A3_ = "20261019T060000Z-77777777"
ap3 = write("apply-3.out", ["RESULT\tOK\tclose-pr\tpr#30\tclosed",
                            "SUMMARY\tok=1\tskip=0\tfail=0\tunknown=0\trun_id=%s\tattempt=%s\tscope=full\tjournal=/j" % (RUN, A3_)])
v3ok = write("v-recon.out", [x.replace("VERIFY\tUNRESOLVED\tclose-pr\tpr#30\t" + x.split("\t")[-1], "VERIFY\tOK\tclose-pr\tpr#30\tCLOSED")
                             .replace("unresolved=2", "unresolved=1") for x in V_.rstrip("\n").split("\n")])
rc, err, page = run(PLAN, [AP1, AP2, ap3], v3ok)
check("9s [B] FAIL then OK in a later run + VERIFY OK is accepted (legitimate reconciliation)",
      rc == 0 and nums(page or "").get("t-prs") == 2, "rc=%s err=%r" % (rc, err))
rc, err, _ = run(PLAN, [AP1, AP2], write("v-b5.out", [x.replace("VERIFY\tUNRESOLVED\tjira-transition\tjira#TST-105", "VERIFY\tRESOLVED\tjira-transition\tjira#TST-105")
                                                       .replace("unresolved=2", "unresolved=1") for x in V_.rstrip("\n").split("\n")]))
fails_one_line("9t [B] Jira SKIP manual but VERIFY RESOLVED → exit 1", rc, err, "the engine gives UNRESOLVED")
for tag, st, text, skip_bad in (("idr", "RESOLVED", "신원 바뀜, 쓰기 없음 — 프로젝트가 계획과 다름", (2, 0)),   # was UNRESOLVED (bad)
                                 ("idf", "FAIL", "신원 불일치(쓰기 있었음) — 프로젝트가 계획과 다름", (1, 1))):
    vlines = [x.replace("VERIFY\tUNRESOLVED\tjira-transition\tjira#TST-105\t" + x.split("\t")[-1],
                        "VERIFY\t%s\tjira-transition\tjira#TST-105\t%s" % (st, text)).replace("unresolved=2", "unresolved=1")
              for x in V_.rstrip("\n").split("\n")]
    if st == "FAIL":
        vlines = [x.replace("fail=0", "fail=1") for x in vlines]
    rc, err, page = run(PLAN, [AP1, AP2], write("v-%s.out" % tag, vlines))
    g = nums(page or "")
    check("9t2 [R4] SKIP manual + VERIFY %s with the identity text (rule 1 before rule 3) is accepted → %s"
          % (st, "건너뜀" if st == "RESOLVED" else "실패·미해결"),
          rc == 0 and (g.get("f-jira-x-skip"), g.get("f-jira-x-bad")) == skip_bad
          and ("보냈을 수 있음" in section(page, "d-jira-TST-105", "</article>")) == (st == "FAIL"),
          "rc=%s err=%r skip/bad=%r" % (rc, err, (g.get("f-jira-x-skip"), g.get("f-jira-x-bad"))))
rc, err, _ = run(PLAN, [AP1, AP2], write("v-idx.out", [x.replace("VERIFY\tUNRESOLVED\tjira-transition\tjira#TST-105\t" + x.split("\t")[-1],
                                                                "VERIFY\tFAIL\tjira-transition\tjira#TST-105\t신원 바뀜, 쓰기 없음 — x")
                                                      .replace("unresolved=2", "unresolved=1").replace("fail=0", "fail=1")
                                                      for x in V_.rstrip("\n").split("\n")]))
fails_one_line("9t3 [R4] SKIP manual + VERIFY FAIL with the no-write identity text → exit 1", rc, err, "the engine gives UNRESOLVED")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-b6.out", "VERIFY\tRESOLVED\tjira-transition\tjira#TST-107", "VERIFY\tNOT-SCHEDULED\tjira-transition\tjira#TST-107"))
fails_one_line("9u [B] Jira NOT-SCHEDULED for a row that has a RESULT → exit 1", rc, err, "the engine gives OK/WARN/RESOLVED/UNRESOLVED/FAIL")
rc, err, _ = run(PLAN, [mutate(AP1, "a1-full.out", "scope=only-group", "scope=full")], v_og)
fails_one_line("9v [B] Jira NOT-SCHEDULED while a full run is in the results → exit 1", rc, err, "the engine gives FAIL")
rc, err, _ = run(PLAN, [AP1, AP2], vmut("v-b7.out", "VERIFY\tOK\tjira-transition\tjira#TST-101\t이번 실행이 옮김",
                                       "VERIFY\tOK\tjira-transition\tjira#TST-101\t목표 상태와 승인 댓글 확인 — 전환 주체 미확정"))
fails_one_line("9w [B] last RESULT OK moved but VERIFY OK with another text → exit 1", rc, err, "whose last result is OK moved")
keep_out = TMP / "keep.html"
keep_out.write_text("SENTINEL", encoding="utf-8")
rc, err, _ = run(PLAN, [AP1, AP2], VER, digest="2" * 64, out=keep_out)
check("9x --out untouched on error", rc == 1 and keep_out.read_text(encoding="utf-8") == "SENTINEL", "rc=%s" % rc)
rc, err, _ = run(PLAN, [AP1, AP2], VER, repo="https://github.com/test/other")
fails_one_line("9y --repo-url of another repository → exit 1", rc, err, "is not the plan's repository")

# ── 10. Jira-only plan: NOT-JUDGED, earlier writes on a stopped row, moved decided by VERIFY text ───
rc, err, page = run(JPLAN, [JA1, JA2], JVER)
check("10a Jira-only fixture renders", rc == 0 and page, "rc=%s err=%r" % (rc, err))
page = page or ""
got = nums(page)
check("10b [C3] tiles: QA 1 (TST-105, moved per the VERIFY text though its last result is already-done), 닫음 1 (TST-102)",
      [got.get(k) for k in ("t-jira-qa", "t-jira-closed", "t-decide", "t-bad", "t-recent")] == [1, 1, 2, 1, 0]
      and "TST-105" in section(page, "done-jira-qa", "</div>\n</div>"), repr(got))
check("10c [C6] Jira NOT-JUDGED counted in the funnel's 제외·판정 안 함 (2 = EXCLUDED + NOT-JUDGED), not in the recent tile",
      [got.get(k) for k in ("f-jira-total", "f-jira-r-act", "f-jira-r-keep", "f-jira-r-ambiguous", "f-jira-r-out",
                            "f-jira-x-done", "f-jira-x-skip", "f-jira-x-bad")] == [8, 4, 1, 1, 2, 2, 1, 1], repr(got))
check("10d [C6] NOT-JUDGED TST-108 listed with reason 판정 못 함",
      "판정 못 함 — 판정 파일이 없어 판정 누락" in section(page, "s-excluded", "</section>") and "TST-108" in section(page, "s-excluded", "</section>"), "")
card = section(page, "d-jira-TST-101", "</article>")
check("10e [C1] stopped row with an earlier UNKNOWN: 'may have sent', every prior result listed, never 'nothing changed'",
      "이전 실행에서 댓글·옮기기 요청을 보냈을 수 있음" in card and "<li>1번째 실행: 결과 모름 — 이 실행이 요청을 보낸 기록은 있지만 결과를 읽지 못함 (jira 단계에서 멈춤)" in card
      and "<li>2번째 실행: 건너뜀 — " in card and "아무것도 바꾸지" not in card, card[:400])
check("10f [C1] intro names the stopped row that may have sent requests",
      "그중 1건은 이전 실행에서 댓글·옮기기 요청을 보냈을 수 있음" in section(page, "s-decide", 'id="s-done"'), "")

jp_lines = Path(JPLAN).read_bytes().rstrip(b"\n").split(b"\n")
inv = jp_lines[-1].split(b"\t")
inv[5] = R.P.encode_inventory_evidence(8, "project = TST AND assignee = currentUser() ORDER BY key", "example.atlassian.net")
jplan_all = TMP / "jplan-all.tsv"
jplan_all.write_bytes(b"\n".join(jp_lines[:-1] + [b"\t".join(inv)]) + b"\n")
rc, err, page = run(jplan_all, [JA1, JA2], JVER)
check("10i [R4] a JQL without statusCategory != Done is not called 미완료 (검색 조건에 걸린 Jira 8건)",
      rc == 0 and "검색 조건에 걸린 Jira 8건" in (page or "") and "미완료" not in (page or ""), "rc=%s err=%r" % (rc, err))

# ── 10b. "이번 실행이 옮김" needs a result that could have moved the row (OK moved or UNKNOWN) in some run [R3] ──
JRUN = "20261016T010203Z-1f2e3d4c"
JREST = [  # the other three Jira rows of v4-jira-plan.tsv, same in every scenario: results and their VERIFY lines
    ("RESULT\tSKIP\tjira-transition\tjira#TST-101\tchanged: 승인 뒤 상태가 바뀜", "VERIFY\tRESOLVED\tjira-transition\tjira#TST-101\tchanged: 승인 뒤 상태가 바뀜, 쓰기 없음"),
    ("RESULT\tSKIP\tjira-transition\tjira#TST-102\tchanged: 승인 뒤 상태가 바뀜", "VERIFY\tRESOLVED\tjira-transition\tjira#TST-102\tchanged: 승인 뒤 상태가 바뀜, 쓰기 없음"),
    ("RESULT\tSKIP\tjira-transition\tjira#TST-106\tchanged: 승인 뒤 상태가 바뀜", "VERIFY\tRESOLVED\tjira-transition\tjira#TST-106\tchanged: 승인 뒤 상태가 바뀜, 쓰기 없음")]


def jira_scenario(tag, history):
    """TST-105's results across runs (one RESULT line per run, the other rows SKIP changed in the last run) + VERIFY OK
    "이번 실행이 옮김" for TST-105 → (results files, verify file). Counters on every closing line match its lines."""
    files = []
    for i, line in enumerate(history):
        att = "20261019T0%d0000Z-%08x" % (8 + i, 0xabc000 + i)
        rows = ["RESULT\t%s\tjira-transition\tjira#TST-105\t%s" % line]
        if i == len(history) - 1:
            rows += [r for r, _ in JREST]
        rows = [r + "\tattempt=" + att for r in rows]
        st = [r.split("\t")[1] for r in rows]
        if line[0] == "UNKNOWN" and i < len(history) - 1:   # an earlier run stopped right after the transition journal line
            close = "ABORTED\trun_id=%s\tat=jira\tok=0\tskip=0\tfail=0\tunknown=1\tunattempted=0\treason=stopped" % JRUN
        else:
            close = "SUMMARY\tok=%d\tskip=%d\tfail=%d\tunknown=%d\trun_id=%s" % (
                st.count("OK"), st.count("SKIP"), st.count("FAIL"), st.count("UNKNOWN") + st.count("NOT-ATTEMPTED"), JRUN)
        files.append(write("j-%s-%d.out" % (tag, i), rows + [close + "\tattempt=%s\tscope=full\tjournal=/j" % att]))
    ver = write("j-%s-verify.out" % tag, ["VERIFY\tOK\tjira-transition\tjira#TST-105\t이번 실행이 옮김"] + [v for _, v in JREST]
                + ["VERIFY\tOK\tp-invariant\tdevelop\tpresent", "VERIFY\tOK\tp-invariant\tdeploy/staging\tpresent",
                   "VERIFY-SUMMARY\tfail=0\twarn=0\tunresolved=0\trun=complete\tsuccess=yes"])
    return files, ver


files, ver = jira_scenario("neg", [("SKIP", "at-target: 이미 목표 상태 — 이번 실행이 한 것 아님")])
keep_out = TMP / "r3-keep.html"
keep_out.write_text("SENTINEL", encoding="utf-8")
rc, err, _ = run(JPLAN, files, ver, out=keep_out)
fails_one_line("10g [R3] only result SKIP at-target + VERIFY OK 이번 실행이 옮김 → exit 1", rc, err,
               "no result of these runs could have moved it")
check("10g2 [R3] … and --out is left untouched", keep_out.read_text(encoding="utf-8") == "SENTINEL", "")
for tag, hist in (("unk-at", [("UNKNOWN", "journal has a write of this attempt, outcome unread (run aborted at jira)"),
                              ("SKIP", "at-target: 이미 목표 상태 — 이번 실행이 한 것 아님")]),
                  ("unk-done", [("UNKNOWN", "journal has a write of this attempt, outcome unread (run aborted at jira)"),
                                ("OK", "already-done: 승인 댓글과 목표 상태가 이미 있음")]),
                  ("moved", [("OK", "moved: QA (staging)로 옮김")])):
    files, ver = jira_scenario(tag, hist)
    rc, err, page = run(JPLAN, files, ver)
    got = nums(page or "")
    check("10h [R3] %s + VERIFY OK 이번 실행이 옮김 is accepted; the moved tile counts TST-105 once"
          % " → ".join("%s %s" % (a, b.split(":")[0] if a in ("OK", "SKIP") else "") for a, b in hist).replace("  ", " "),
          rc == 0 and got.get("t-jira-qa") == 1 and got.get("t-jira-closed") == 0 and got.get("f-jira-x-done") == 1
          and "TST-105" in section(page or "", "done-jira-qa", "</div>\n</div>"), "rc=%s err=%r" % (rc, err))
# 1번째 시도가 댓글·옮기기(일지 transition-ok)까지 하고 결과 줄 전에 SIGKILL → 그 결과 파일은 SUMMARY/ABORTED가 없어 절차상
# 빠지고, 다시 실행한 완전한 실행만 OK already-done을 낸다. 옮김은 결과 줄이 아니라 일지가 들고 있다(chore-jira.py rule 4).
files, ver = jira_scenario("done-only", [("OK", "already-done: 이미 QA (staging) 상태이고 승인 댓글이 있음 — 쓰기 없음")])
rc, err, page = run(JPLAN, files, ver)
got, page = nums(page or ""), page or ""
check("10h2 [R3] killed attempt excluded, only result OK already-done + VERIFY OK 이번 실행이 옮김 is accepted as moved "
      "(QA tile 1, 처리한 것 · Jira → QA, not the not-moved group)",
      rc == 0 and got.get("t-jira-qa") == 1 and got.get("t-jira-closed") == 0 and got.get("f-jira-x-done") == 1
      and got.get("f-jira-x-already") == 0 and "TST-105" in section(page, "done-jira-qa", "</div>\n</div>")
      and "TST-105" not in section(page, "done-jira-target", "</div>\n</div>"), "rc=%s err=%r" % (rc, err))

# ── 11. worktree-prune "nothing to check" [C4] ───────────────────────────────────────────────────────
hdr0 = Path(PLAN).read_bytes().split(b"\n")[0].replace(b"no_local=1", b"no_local=0")
wplan = TMP / "wt-plan.tsv"
wplan.write_bytes(hdr0 + b"\n1\tworktree-prune\t.\t-\t-\tprune\n")
wres = write("wt-apply.out", ["RESULT\tOK\tworktree-prune\t.\tpruned",
                              "SUMMARY\tok=1\tskip=0\tfail=0\tunknown=0\trun_id=%s\tattempt=20261019T070000Z-88888888\tscope=full\tjournal=/j" % RUN])
wver = write("wt-verify.out", ["VERIFY\tOK\tworktree-prune\t.\tnothing to check", "VERIFY\tOK\tp-invariant\tdevelop\tpresent",
                               "VERIFY\tOK\tp-invariant\tdeploy/staging\tpresent",
                               "VERIFY-SUMMARY\tfail=0\twarn=0\tunresolved=0\trun=complete\tsuccess=yes"])
rc, err, page = run(wplan, [wres], wver)
got = nums(page or "")
check("11a [C4] worktree-prune with 'nothing to check' = 확인할 것 없음, not a confirmed deletion",
      rc == 0 and got.get("f-branch-x-unchecked") == 1 and got.get("f-branch-x-done") == 0
      and "확인할 것 없음" in section(page or "", "done-unchecked", "</div>\n</div>")
      and '<span id="verdict-text">확인한 0건 모두 확인됨 · 확인할 것 없음 1건</span>' in (page or ""), "rc=%s err=%r" % (rc, err))

# ── 12. recovery command is shell-quoted [D] ─────────────────────────────────────────────────────────
NASTY = TMP / "nasty dir"
NASTY.mkdir()
names = {"plan": "-plan it's;$(touch x).tsv", "r1": "-a 1 \"q\".out", "r2": "b;$(rm -rf y)`z`.out"}
shutil.copy(PLAN, NASTY / names["plan"])
shutil.copy(AP1, NASTY / names["r1"])
shutil.copy(AP2, NASTY / names["r2"])
out = TMP / "nasty.html"
rc, err = run_args(["--plan=" + names["plan"], "--digest", sha(PLAN), "--results=" + names["r1"], "--results", names["r2"],
                    "--verify", str(VER), "--out", str(out), "--repo-url", "https://github.com/test/repo", "--title-date", "2026-10-19"],
                   cwd=str(NASTY))
toks = next_cmd_tokens(out.read_text(encoding="utf-8")) if rc == 0 else None
want = [["scripts/chore.sh", "apply", "test/repo", "--plan", "./" + names["plan"], "--digest", sha(PLAN), "--tiers", "2", "--yes",
         ">", "apply-next.out"],
        ["cat", "./" + names["r1"], names["r2"], "apply-next.out", ">", "results-all.out"],
        ["scripts/chore.sh", "verify", "test/repo", "--plan", "./" + names["plan"], "--digest", sha(PLAN), "--results", "results-all.out"]]
check("12a [D] relative paths with spaces, quotes, ; $( ) ` and a leading - come back as the same single shell words",
      toks == want, "rc=%s err=%r toks=%r" % (rc, err, toks))
rc, err = run_args(["--plan", str(NASTY / names["plan"]), "--digest", sha(PLAN), "--results", str(NASTY / names["r1"]),
                    "--results", str(NASTY / names["r2"]), "--verify", str(VER), "--out", str(out),
                    "--repo-url", "https://github.com/test/repo", "--title-date", "2026-10-19"])
toks = next_cmd_tokens(out.read_text(encoding="utf-8")) if rc == 0 else None
check("12b [D] absolute paths stay absolute and quoted",
      toks is not None and toks[0][4] == str(NASTY / names["plan"]) and toks[1][1:3] == [str(NASTY / names["r1"]), str(NASTY / names["r2"])],
      "rc=%s err=%r toks=%r" % (rc, err, toks))

# ── 13. seam pins: the report's engine literals = the engine source (read as text, never imported or run) ──
jsrc = (SCRIPTS / "chore-jira.py").read_text(encoding="utf-8")
m = re.search(r"^def verify_decide\(.*?(?=^\S)", jsrc, re.S | re.M)
moved_lits = re.findall(r'^\s+t = "([^"\n]*)"', m.group(0), re.M) if m else None
check("13a MOVED_TEXT = the one t = \"…\" literal chore-jira.py verify_decide (rule 4) starts its moved text with",
      moved_lits == [R.MOVED_TEXT], "verify_decide %s, t = literals %r, MOVED_TEXT %r"
      % ("found" if m else "not found", moved_lits, R.MOVED_TEXT))
ssrc = (SCRIPTS / "chore.sh").read_text(encoding="utf-8")


def sh_body(name):
    """chore.sh의 `name() {` … 첫 0열 `}` 사이(함수 본문), 없으면 None."""
    b = re.search(r"^%s\(\) \{\n(.*?)^\}" % re.escape(name), ssrc, re.S | re.M)
    return b.group(1) if b else None


cv, sc = sh_body("cmd_verify"), sh_body("stage_close")
recon = R.RECONCILED_CLOSE
check("13b RECONCILED_CLOSE occurs exactly once in chore.sh cmd_verify",
      cv is not None and cv.count(recon) == 1, "cmd_verify %s, count %s, text %r"
      % ("found" if cv is not None else "not found", cv.count(recon) if cv is not None else "-", recon))
changed = re.findall(r'result SKIP "\$action" "\$ref" "(changed[^"]*)"', sc or "")
check("13c CHANGED_SKIP is how chore.sh stage_close starts its SKIP changed reason (every one of them)",
      sc is not None and changed != [] and all(c.startswith(R.CHANGED_SKIP) for c in changed),
      "stage_close %s, SKIP changed reasons %r, CHANGED_SKIP %r" % ("found" if sc is not None else "not found", changed, R.CHANGED_SKIP))
ab = sh_body("apply_abort_report")
check("13d each MOVE_ABORT_EXITS prefix is how a chore.sh apply_abort_report fill starts (the text row 10 carries verbatim)",
      ab is not None and all(re.search(r'"%s[^"]*\(run aborted at \$ABORT_AT\)"' % re.escape(p), ab) for p, _ in R.MOVE_ABORT_EXITS),
      "apply_abort_report %s, prefixes %r" % ("found" if ab is not None else "not found", [p for p, _ in R.MOVE_ABORT_EXITS]))

# ── 14. plans without move-issue rows: the page is byte-identical to the report before move-issue (2026-10-21) ──
# sha256 of the pages chore-report.py wrote for these fixtures before v4.3 move-issue support, run from the fixtures folder
# with relative input names (the recovery command embeds the given paths). A deliberate change to the page updates these.
# 2026-10-27: fixture branch names neutralized (the plan bytes and so the page's plan digest changed) — re-pinned by
# running that same pre-move-issue chore-report.py over the new fixtures; it still reproduces the old pins on the old ones.
# 2026-10-27 (phase 2): the sample environment renamed in the fixtures and the page wording made environment-neutral
# (QA tile / level text / definition line / def-proof id / deploy-run link) — re-pinned by running that pre-move-issue
# chore-report.py with the same wording table over the new fixtures; it equals this report's page byte for byte, and the
# unpatched one still reproduces the previous pins (a0f19c9f…, afaad801…) on the previous fixtures.
PRE_MOVE_PAGES = (("v4-plan", ["v4-apply-1.out", "v4-apply-2.out"], "v4-verify.out",
                   "0ab1b0691a303553cbff91490a196cdae09c5e09498516ec328cf99bc5c3e09a"),
                  ("v4-jira-plan", ["v4-jira-apply-1.out", "v4-jira-apply-2.out"], "v4-jira-verify.out",
                   "c91cfdfced29c4008a5d644f6b5d88cc77b49e4bb4dbde862c107da4df5178b9"))
EMPTY_PAYLOADS = TMP / "payloads-empty"      # the skill always passes --payloads; build makes it empty for a plan with no moves
EMPTY_PAYLOADS.mkdir()
for stem, res_names, ver_name, want_sha in PRE_MOVE_PAGES:
    for with_dir in (False, True):
        out = TMP / ("pre-move-%s-%d.html" % (stem, with_dir))
        args = ["--plan", stem + ".tsv", "--digest", sha(FIX / (stem + ".tsv"))]
        for x in res_names:
            args += ["--results", x]
        args += ["--payloads", str(EMPTY_PAYLOADS)] if with_dir else []
        rc, err = run_args(args + ["--verify", ver_name, "--out", str(out), "--repo-url", "https://github.com/test/repo",
                                   "--title-date", "2026-10-19"], cwd=str(FIX))
        got_sha = sha(out) if rc == 0 and out.exists() else None
        check("14a %s (no move-issue rows)%s: page byte-identical to the pre-move-issue report"
              % (stem, " + --payloads <empty folder>" if with_dir else ""), got_sha == want_sha,
              "rc=%s err=%r sha=%s" % (rc, err[:200], got_sha))

# ── 15. move-issue rows (v4.3): RESULT / VERIFY rules (contract §1·§4), --payloads (§3), the "Jira로 옮김" section ──
# Plans are built here with chore_plan's own encoders (move_payload / source_sha / move_comment / encode_move_evidence), so
# every payload_sha is the sha256 of the payload file written next to the plan. Synthetic data only.
PL = R.P
MV_SITE, MV_DATE, MV_REPO = "example.atlassian.net", "2026-10-21", "https://github.com/test/repo"
MV_ACCT = "712020:00000000-0000-0000-0000-000000000001"
MV_SNAP = {"project_id": "10000", "issuetype": "10001", "account": MV_ACCT}
MV_PINV = ["VERIFY\tOK\tp-invariant\tdevelop\tpresent", "VERIFY\tOK\tp-invariant\tdeploy/staging\tpresent"]


def K(n):
    return "TST-%d" % (400 + n)


def mv_rows(specs):
    """{n: spec} → (plan lines, {n: payload bytes}). spec keys: related, adopt, body, comments, payload (bytes written as the
    payload file instead of move_payload's — its sha goes into the snapshot, for the JSON / ADF refusal cases)."""
    lines, pays = [], {}
    for n, sp in specs.items():
        issue = {"number": n, "title": "옮길 이슈 %d <b>제목</b>" % n, "body": sp.get("body", "본문 %d" % n), "author": "frank",
                 "created": "2026-05-01T09:00:00Z", "labels": ["bug"], "comments": sp.get("comments", [])}
        reason, related = "남기는 이유 %d" % n, sp.get("related", [])
        payload = sp.get("payload") or PL.move_payload(issue, MV_REPO, MV_SNAP, reason, related, MV_DATE)[0]
        upd = "2026-08-%02dT00:00:00Z" % (n % 28 + 1)
        snap = {"state": "OPEN", "updated": upd, "author": "frank", "title": issue["title"], "site": MV_SITE, "project": "TST",
                "project_id": "10000", "issuetype": "10001", "issuetype_name": "작업", "account": MV_ACCT, "gh_login": "chore-bot",
                "source_sha": PL.source_sha(issue), "payload_sha": hashlib.sha256(payload).hexdigest(),
                "adopt": sp.get("adopt", "-"), "prior": "-"}
        ev = PL.encode_move_evidence({"reason": reason, "gh": PL.move_comment(MV_SITE, reason, MV_DATE), "related": related})
        lines.append(b"\t".join([b"2", b"move-issue", PL.penc("issue#%d" % n), upd.encode(), PL.encode_snapshot(snap), ev]))
        pays[n] = payload
    return lines, pays


def mv_verify(name, vlines, run_id=None):
    """VERIFY lines (rows + meta, no summary) → verify file with a VERIFY-SUMMARY that adds up (run=complete; with run_id =
    the last apply was ABORTED: + the INCOMPLETE run line and run=incomplete)."""
    if run_id:
        vlines = vlines + ["VERIFY\tINCOMPLETE\trun\t%s\tapply stopped at jira" % run_id]
    st = [x.split("\t")[1] for x in vlines]
    f, wn, u = st.count("FAIL"), st.count("WARN"), st.count("UNRESOLVED")
    return write(name, vlines + ["VERIFY-SUMMARY\tfail=%d\twarn=%d\tunresolved=%d\trun=%s\tsuccess=%s"
                                 % (f, wn, u, "incomplete" if run_id else "complete", "yes" if f == u == 0 else "no")])


def mv_scenario(tag, specs, runs, base_plan=None, base_results=()):
    """→ (plan, payload dir, results files). Plan = header of v4-jira-plan.tsv + the move rows, or base_plan + the move rows.
    runs = [(SUMMARY | ABORTED, attempt, [(status, n, reason)])], each closed by a line whose counters match its lines."""
    d = TMP / ("mv-" + tag)
    d.mkdir()
    lines, pays = mv_rows(specs)
    src = Path(base_plan or JPLAN).read_bytes().rstrip(b"\n").split(b"\n")
    plan = d / "plan.tsv"
    plan.write_bytes(b"\n".join((src if base_plan else src[:1]) + lines) + b"\n")
    pdir = d / "payloads"
    pdir.mkdir()
    for k, b in pays.items():
        (pdir / ("issue-%d.json" % k)).write_bytes(b)
    rid = re.search(rb"\trun_id=([^\t]+)", src[0]).group(1).decode()
    res = list(base_results)
    for i, run_ in enumerate(runs):
        kind, att, items = run_[:3]
        why = run_[3] if len(run_) > 3 else "stopped"     # ABORTED reason= (chore.sh LAST_ERR)
        st = [s for s, _, _ in items]
        if kind == "SUMMARY":
            close = "SUMMARY\tok=%d\tskip=%d\tfail=%d\tunknown=%d\trun_id=%s" % (
                st.count("OK"), st.count("SKIP"), st.count("FAIL"), st.count("UNKNOWN") + st.count("NOT-ATTEMPTED"), rid)
        else:
            close = "ABORTED\trun_id=%s\tat=jira\tok=%d\tskip=%d\tfail=%d\tunknown=%d\tunattempted=%d\treason=%s" % (
                rid, st.count("OK"), st.count("SKIP"), st.count("FAIL"), st.count("UNKNOWN"), st.count("NOT-ATTEMPTED"), why)
        res.append(write("mv-%s-run%d.out" % (tag, i), ["RESULT\t%s\tmove-issue\tissue#%d\t%s\tattempt=%s" % (s, k, why, att)
                                                        for s, k, why in items]
                         + [close + "\tattempt=%s\tscope=full\tjournal=/j" % att]))
    return plan, pdir, res


def mv_run(plan, pdir, res, ver, out=None):
    return run(plan, res, ver, out=out, extra=["--payloads", str(pdir)] if pdir else [])


# contract §4, written out here independently of the script's table: last RESULT kind → the VERIFY statuses verify-rows may print
OKS = ("OK", "WARN", "FAIL", "UNRESOLVED")
MV_ALLOWED = {101: OKS, 102: OKS, 103: ("UNRESOLVED", "FAIL"), 104: ("UNRESOLVED", "FAIL"),
              105: ("RESOLVED", "UNRESOLVED", "FAIL"), 106: ("RESOLVED", "UNRESOLVED", "FAIL"), 107: ("RESOLVED", "UNRESOLVED", "FAIL"),
              108: ("FAIL", "UNRESOLVED"), 109: ("UNRESOLVED", "FAIL"), 110: ("UNRESOLVED", "FAIL"),
              111: ("UNRESOLVED", "FAIL", "RESOLVED"), 112: ("UNRESOLVED", "FAIL", "RESOLVED"),
              113: ("NOT-SCHEDULED", "UNRESOLVED", "FAIL"), 114: OKS}
MV_KIND = {101: "OK already-done after OK moved", 102: "OK already-done", 103: "SKIP manual", 104: "SKIP exists",
           105: "SKIP account", 106: "SKIP changed", 107: "SKIP type", 108: "FAIL create-rejected", 109: "FAIL comment-failed",
           110: "FAIL close-failed", 111: "UNKNOWN", 112: "NOT-ATTEMPTED", 113: "no RESULT in any run", 114: "OK moved"}
MV_MOVED = {101, 114}          # some RESULT of these runs is OK moved
A1M, A2M = "20261021T010000Z-a1a1a1a1", "20261021T020000Z-b2b2b2b2"
MV_SPECS = {k: {} for k in range(101, 115)}
MV_SPECS[101] = {"related": ["TST-90", "TST-91"]}
MV_SPECS[112] = {"adopt": K(112)}
MV_SPECS[113] = {"adopt": K(113)}      # no RESULT, no key in its VERIFY text → the ticket cell falls back to the adopted key
MV_SPECS[114] = {"body": "가" * (PL.MOVE_CAP + 5), "comments": [{"author": "grace", "created": "2026-05-02T10:00:00Z", "body": "x"}]}
MV_RUNS = [("ABORTED", A1M, [("OK", 101, "moved: %s — 티켓을 만들고 이슈를 닫음" % K(101)),
                             ("NOT-ATTEMPTED", 112, "run aborted at jira")]),
           ("SUMMARY", A2M, [("OK", 101, "already-done: %s — 이미 닫혀 있고 이관 댓글 있음" % K(101)),
                             ("OK", 102, "already-done: %s — 이미 닫혀 있고 이관 댓글 있음" % K(102)),
                             ("SKIP", 103, "manual: %s — 누가 먼저 닫음 — 연결 기록 필요" % K(103)),                    # §5 M9
                             ("SKIP", 104, "exists: 이 이슈를 가리키는 티켓이 이미 있음: TST-521, TST-522"),
                             ("SKIP", 105, "account: Jira 계정 또는 GitHub 로그인이 승인 때와 다름"),
                             ("SKIP", 106, "changed: 이슈가 승인 뒤 바뀜 — 닫지 않음"),
                             ("SKIP", 107, "type: 티켓 유형을 만들 수 없음 — 필수 칸 구성 요소"),          # §5: createmeta field names
                             ("FAIL", 108, "create-rejected: Jira가 만들기를 거절함 (HTTP 403)"),
                             ("FAIL", 109, "comment-failed: %s — 댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단" % K(109)),
                             ("FAIL", 110, "close-failed: %s — 이슈를 닫지 못함" % K(110)),
                             ("UNKNOWN", 111, "만들기 결과 모름 — 다음 실행이 확인"),
                             ("OK", 114, "moved: %s — 티켓을 만들고 이슈를 닫음" % K(114))])]
MV_DEFAULT = {101: ("OK", "%s — 옮김" % K(101)),
              102: ("WARN", "%s — 현재 내용이 승인본과 다름 — 변경 시점 확정 불가" % K(102)),          # §7 row 8
              103: ("UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: 누가 먼저 닫음 — 연결 기록 필요" % K(103)),   # row 10, why = M9
              104: ("UNRESOLVED", "이 이슈의 티켓 여럿: TST-521, TST-522, TST-523"),                     # §7 row 4
              105: ("RESOLVED", "만든 것 없음 — 계정이 승인 때와 다름"),
              106: ("RESOLVED", "만든 것 없음 — 이슈가 승인 뒤 바뀜 · 지워진 티켓 TST-499 (지울 댓글 5551, 5552)"),
              107: ("RESOLVED", "만든 것 없음 — 티켓 유형을 만들 수 없음"),
              108: ("FAIL", "만든 것 없음 — Jira가 거절함"),
              109: ("UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: 댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단" % K(109)),
              110: ("UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: 이슈를 닫지 못함" % K(110)),
              111: ("UNRESOLVED", "결과 미확정 — 사람이 확인 후 기록 필요: 만들기 결과 미확정 — 다시 만들지 않음"),   # row 2, why = M1
              112: ("FAIL", "%s — 티켓이 안 보이거나 내용이 승인본과 다름: 요약이 다름" % K(112)),
              113: ("NOT-SCHEDULED", "이번 실행에서 시도 안 함"),
              114: ("WARN", "%s — 옮김, 닫은 뒤 새 댓글 2개" % K(114))}                               # §7 row 9 WARN
MV_TEXT = {"OK": "{} — 옮김", "WARN": "{} — 옮김, 닫은 뒤 새 댓글 1개", "FAIL": "{} — 옮겼는데 이슈가 열려 있음",
           "UNRESOLVED": "결과 미확정 — 사람이 확인 후 기록 필요: {} 확인", "RESOLVED": "만든 것 없음 — 보내기 전에 멈춤",
           "NOT-SCHEDULED": "이번 실행에서 시도 안 함"}      # amended contract §2 texts; {} = the row's key
MVP, MVD, MVR = mv_scenario("matrix", MV_SPECS, MV_RUNS)


def mv_vlines(statuses):
    """{n: (status, text)} → VERIFY lines for every move row (defaults for the rest) + the protected-branch lines."""
    st = dict(MV_DEFAULT)
    st.update(statuses)
    return ["VERIFY\t%s\tmove-issue\tissue#%d\t%s" % (st[k][0], k, st[k][1]) for k in sorted(st)] + MV_PINV


def mv_outcome(k, status):
    if status in ("OK", "WARN"):
        return "done" if k in MV_MOVED else "already"
    return {"RESOLVED": "skip", "FAIL": "bad", "UNRESOLVED": "bad", "NOT-SCHEDULED": "notrun"}[status]


def mv_funnel(page):
    g = nums(page)
    return {x: g.get("f-issue-m-" + x, 0) for x in ("done", "already", "skip", "bad", "notrun")}


MVV = mv_verify("mv-matrix-verify.out", mv_vlines({}))
rc, err, page = mv_run(MVP, MVD, MVR, MVV)
check("15a move-only plan (14 rows, one per last-RESULT kind of contract §4) renders", rc == 0 and page, "rc=%s err=%r" % (rc, err))
page = page or ""
got = nums(page)
want = {x: sum(1 for k, (s, _) in MV_DEFAULT.items() if mv_outcome(k, s) == x) for x in ("done", "already", "skip", "bad", "notrun")}
check("15b funnel: OK/WARN → 이번 실행이 옮김 when some RESULT is OK moved (101 run 1, 114), else 이미 옮겨져 있음 (102); "
      "RESOLVED → 건너뜀, FAIL/UNRESOLVED → 실패·미해결, NOT-SCHEDULED → 실행 안 함",
      mv_funnel(page) == want == {"done": 2, "already": 1, "skip": 3, "bad": 7, "notrun": 1}
      and (got.get("f-issue-total"), got.get("f-issue-moves"), got.get("f-issue-r-act"), got.get("f-issue-r-move")) == (14, 14, 0, 14),
      "%r vs %r; %r" % (mv_funnel(page), want, [got.get(x) for x in ("f-issue-total", "f-issue-moves", "f-issue-r-act", "f-issue-r-move")]))
check("15c tiles: Jira로 옮긴 이슈 = 2 (this run's moves) next to 닫은 이슈 = 0; t-bad = FAIL + UNRESOLVED lines",
      (got.get("t-issues"), got.get("t-moves"), got.get("t-bad")) == (0, 2, 7)
      and page.find('id="t-issues"') < page.find('id="t-moves"') < page.find('id="t-jira-qa"')
      and "Jira로 옮긴 이슈</span>" in section(page, "t-moves", "</li>"), repr([got.get(x) for x in ("t-issues", "t-moves", "t-bad")]))
for k_ in range(4):     # every (row, allowed status) pair of the contract table, four runs: row n takes its k-th status
    sts = {k: MV_ALLOWED[k][min(k_, len(MV_ALLOWED[k]) - 1)] for k in MV_ALLOWED}
    v = mv_verify("mv-allow-%d.out" % k_, mv_vlines({k: (s, MV_TEXT[s].format(K(k))) for k, s in sts.items()}))
    rc, err, page_k = mv_run(MVP, MVD, MVR, v)
    want_k = {x: sum(1 for k, s in sts.items() if mv_outcome(k, s) == x) for x in ("done", "already", "skip", "bad", "notrun")}
    check("15d [§4] accepted round %d: %s" % (k_ + 1, " · ".join("#%d %s" % (k, s) for k, s in sorted(sts.items()))),
          rc == 0 and mv_funnel(page_k or "") == want_k, "rc=%s err=%r funnel=%r want=%r" % (rc, err, mv_funnel(page_k or ""), want_k))
    if k_ == 2:
        page_nodone = (page_k or "") if want_k["done"] == 0 else None    # round 3: 101 / 102 / 114 FAIL → no row moved this run
MV_REFUSE = {101: "NOT-SCHEDULED", 102: "RESOLVED", 103: "RESOLVED", 104: "OK", 105: "OK", 106: "WARN", 107: "NOT-SCHEDULED",
             108: "RESOLVED", 109: "OK", 110: "WARN", 111: "OK", 112: "WARN", 113: "OK", 114: "RESOLVED"}
for k, s in sorted(MV_REFUSE.items()):
    assert s not in MV_ALLOWED[k]
    sentinel = TMP / ("mv-refuse-%d.html" % k)
    sentinel.write_text("SENTINEL", encoding="utf-8")
    rc, err, _ = mv_run(MVP, MVD, MVR, mv_verify("mv-refuse-%d.out" % k, mv_vlines({k: (s, MV_TEXT[s].format(K(k)))})), out=sentinel)
    fails_one_line("15e [§4] last RESULT %s + VERIFY %s → exit 1 (verify came from other results), page not written" % (MV_KIND[k], s),
                   rc if sentinel.read_text(encoding="utf-8") == "SENTINEL" else "page written", err,
                   "for move-issue issue#%d but its last result is" % k)
    check("15e2 … and the message names the verify mismatch (#%d %s)" % (k, s), "verify came from other results" in err, err[:300])
vl = mv_vlines({})
rc, err, _ = mv_run(MVP, MVD, MVR, mv_verify("mv-noline.out", [x for x in vl if "\tissue#113\t" not in x]))
fails_one_line("15f a move-issue row without its VERIFY line → exit 1", rc, err, "no line for move-issue issue#113")
rc, err, _ = mv_run(MVP, MVD, MVR, mv_verify("mv-twice.out", vl + [vl[0]]))
fails_one_line("15g a second VERIFY line for a move-issue row → exit 1", rc, err, "second VERIFY line for move-issue issue#101")
rc, err, _ = mv_run(MVP, MVD, MVR, mv_verify("mv-inc.out", [x.replace("VERIFY\tNOT-SCHEDULED\t", "VERIFY\tINCOMPLETE\t") for x in vl]))
fails_one_line("15h VERIFY INCOMPLETE on a move-issue row → exit 1", rc, err, "not a status the engine gives a move-issue row")

# RESULT format: 6 columns, the move-issue class table (the jira-transition table is untouched)
check("15i jira-transition RESULT classes unchanged by move-issue",
      R.JIRA_CLASSES == {"OK": ("moved", "already-done"),
                         "SKIP": ("identity", "manual", "at-target", "assignee", "changed", "proof", "transition"),
                         "FAIL": ("comment-rejected", "changed-after-comment", "transition-rejected")}, repr(R.JIRA_CLASSES))
for tag, old, new, needle in (
        ("5 columns", "\tattempt=%s\nRESULT\tOK\tmove-issue\tissue#102" % A2M, "\nRESULT\tOK\tmove-issue\tissue#102",
         "a move-issue RESULT has exactly 6 columns"),
        ("a jira-transition class (SKIP identity)", "SKIP\tmove-issue\tissue#105\taccount:", "SKIP\tmove-issue\tissue#105\tidentity:",
         "move-issue SKIP reason must start with one of account/changed/manual/exists/type"),
        ("FAIL with an OK class", "FAIL\tmove-issue\tissue#110\tclose-failed:", "FAIL\tmove-issue\tissue#110\tmoved:",
         "move-issue FAIL reason must start with one of create-rejected/comment-failed/close-failed"),
        ("UNKNOWN carrying a class", "UNKNOWN\tmove-issue\tissue#111\t만들기", "UNKNOWN\tmove-issue\tissue#111\tmoved: 만들기",
         "move-issue UNKNOWN reason carries a class (moved)")):
    rc, err, _ = mv_run(MVP, MVD, [MVR[0], mutate(MVR[1], "mv-res-%d.out" % n, old, new)], MVV)
    fails_one_line("15j move-issue RESULT with %s → exit 1" % tag, rc, err, needle)
jsk = mutate(JA2, "ja2-exists.out", "SKIP\tjira-transition\tjira#TST-106\tchanged:", "SKIP\tjira-transition\tjira#TST-106\texists:")
rc, err, _ = run(JPLAN, [JA1, jsk], JVER)
fails_one_line("15j2 a move-issue class (SKIP exists) on a jira-transition row → exit 1", rc, err, "Jira SKIP reason must start with one of")

# --payloads (contract §3): required iff the plan has move rows; missing / extra / sha mismatch / not JSON / not ADF → exit 1
def payload_refusal(name, pdir, needle, plan=MVP, res=None, ver=MVV, extra=None):
    sentinel = TMP / ("mv-pay-%d.html" % n)
    sentinel.write_text("SENTINEL", encoding="utf-8")
    args = ["--payloads", str(pdir)] if pdir else []
    rc, err, _ = run(plan, res or MVR, ver, out=sentinel, extra=args)
    fails_one_line(name, rc if sentinel.read_text(encoding="utf-8") == "SENTINEL" else "page written", err, needle)


def payload_copy(tag):
    d = TMP / ("mv-pay-" + tag)
    shutil.copytree(MVD, d)
    return d


payload_refusal("15k move rows and no --payloads → exit 1, page not written", None, "--payloads DIR")
d = payload_copy("missing")
(d / "issue-113.json").unlink()
payload_refusal("15l a payload file missing → exit 1, page not written", d, "has no issue-113.json for move-issue issue#113")
d = payload_copy("extra")
(d / "issue-999.json").write_bytes(b"{}")
payload_refusal("15m an extra entry in the payload folder → exit 1, page not written", d, "belong to no move-issue row")
d = payload_copy("sha")
(d / "issue-107.json").write_bytes((d / "issue-107.json").read_bytes().replace("본문 107".encode(), "본문 108".encode()))
payload_refusal("15n a payload file whose sha256 is not the plan's payload_sha → exit 1, page not written", d,
                "issue-107.json sha256")
d = payload_copy("dir")
(d / "issue-101.json").unlink()
(d / "issue-101.json").mkdir()
payload_refusal("15o a payload entry that is a folder → exit 1, page not written", d, "issue-101.json is not a regular file")
payload_refusal("15p --payloads with payload files on a plan without move-issue rows → exit 1, page not written", MVD,
                "must be an empty folder — the plan has no move-issue rows", plan=PLAN, res=[AP1, AP2], ver=VER)
d = TMP / "mv-pay-stray"
d.mkdir()
(d / ".DS_Store").write_bytes(b"x")
payload_refusal("15p2 --payloads folder holding only a stray dotfile, plan without move-issue rows → exit 1, page not written", d,
                "has 1 entries (first: '.DS_Store')", plan=PLAN, res=[AP1, AP2], ver=VER)
d = TMP / "mv-pay-subdir"
d.mkdir()
(d / "x").mkdir()
payload_refusal("15p3 --payloads folder holding an empty sub-folder, plan without move-issue rows → exit 1", d,
                "must be an empty folder", plan=PLAN, res=[AP1, AP2], ver=VER)
payload_refusal("15p4 --payloads naming a folder that does not exist, plan without move-issue rows → exit 1", TMP / "mv-pay-none",
                "cannot read --payloads", plan=PLAN, res=[AP1, AP2], ver=VER)
payload_refusal("15p5 --payloads naming a file, plan without move-issue rows → exit 1", PLAN, "cannot read --payloads",
                plan=PLAN, res=[AP1, AP2], ver=VER)
rc, err, pe = run(PLAN, [AP1, AP2], VER, extra=["--payloads", str(EMPTY_PAYLOADS)])
check("15p6 plan without move-issue rows + an empty --payloads folder → page written, no move section",
      rc == 0 and pe and 'id="s-move"' not in pe and 'id="t-moves"' not in pe, "rc=%s err=%r" % (rc, err[:200]))
d = payload_copy("empty-moves")
for f in d.iterdir():
    f.unlink()
payload_refusal("15p7 plan with move-issue rows + an empty --payloads folder → exit 1 (one file per row still required)", d,
                "has no issue-101.json for move-issue issue#101")
for tag, blob, needle in (("not JSON", b"not json", "is not UTF-8 JSON"),
                          ("a description that is not heading / paragraph / codeBlock blocks",
                           b'{"fields":{"description":{"type":"doc","version":1,"content":[{"type":"table","content":[]}]}}}',
                           "fields.description: ADF block 1")):
    bp, bd, br = mv_scenario("bad-%d" % n, {121: {"payload": blob}}, [("SUMMARY", A2M, [("SKIP", 121, "changed: 이슈가 승인 뒤 바뀜 — 닫지 않음")])])
    payload_refusal("15q payload file with matching sha but %s → exit 1, page not written" % tag, bd, needle, plan=bp, res=br,
                    ver=mv_verify("mv-bad-%d.out" % n, ["VERIFY\tRESOLVED\tmove-issue\tissue#121\t만든 것 없음 — 이슈가 승인 뒤 바뀜"] + MV_PINV))

# the section "Jira로 옮김" (default matrix page)
mvs = section(page, "s-move", 'id="s-kept"')
lst = section(page, "mv-list", 'id="mv-merge"')


def li(text, needle):
    return row_li(text, needle)


def cells(row_html):
    """<li class="row"> body → {column label: cell html}."""
    return dict(re.findall(r'<span class="c"><span class="k">([^<]*)</span>(.*?)</span>(?=<span class="c">|$)', row_html, re.S))


r104 = cells(li(lst, '/issues/104">'))
check("15r 여럿 row: every key of the message is a Jira link, in the ticket cell and in the verify text",
      all('href="https://example.atlassian.net/browse/%s">%s</a>' % (k, k) in r104.get(c, "")
          for k in ("TST-521", "TST-522", "TST-523") for c in ("이슈 → 티켓", "확인 결과")), repr(r104)[:700])
check("15s other rows show the first key of the verify text (else of the last result, else the adopted key), linked",
      'href="https://example.atlassian.net/browse/%s"' % K(103) in li(lst, '/issues/103">')
      and 'href="https://example.atlassian.net/browse/%s"' % K(111) not in lst
      and '<span class="muted">티켓이 생겼을 수 있음 — 키 미확정</span>' in li(lst, '/issues/111">')   # create UNKNOWN (B)
      and '<span class="muted">티켓 없음</span>' in li(lst, '/issues/105">')                      # row 12: nothing made
      and 'browse/%s">%s</a> <span class="muted">(승인 때 고른 기존 티켓)' % (K(112), K(112)) not in li(lst, '/issues/112">')
      and 'browse/%s"' % K(112) in li(lst, '/issues/112">')
      and 'browse/%s">%s</a> <span class="muted">(승인 때 고른 기존 티켓)</span>' % (K(113), K(113)) in li(lst, '/issues/113">'),
      li(lst, '/issues/113">')[:300])
check("15t 잘림 flag only on the truncated payload (block 10 = move_description's 나머지는 원 이슈에서 notice)",
      "<b>잘림</b> — 나머지는 원 이슈에서: 본문 잘림 · 댓글 1개 안 실음" in li(lst, '/issues/114">') and lst.count("<b>잘림</b>") == 1, "")
check("15u result word per row: 이번 실행이 옮김 / 이미 옮겨져 있음 / 건너뜀 / 실패·미해결 / 실행 안 함, class codes in words",
      "이번 실행이 옮김<span" in li(lst, '/issues/101">') and "이미 옮겨져 있음<span" in li(lst, '/issues/102">')
      and "건너뜀<span" in li(lst, '/issues/105">') and "실패·미해결<span" in li(lst, '/issues/108">')
      and "실행 안 함<span" in li(lst, '/issues/113">') and "(2번 시도, 마지막 결과 기준)" in li(lst, '/issues/101">')
      and "이미 옮겨져 있음: <a" in li(lst, '/issues/101">') and "Jira 계정 또는 GitHub 로그인이 승인 때와 다름" in li(lst, '/issues/105">')
      and "already-done" not in mvs and "moved:" not in mvs and "account:" not in mvs and "move-issue" not in mvs, li(lst, '/issues/101">')[:500])
mv_words = html.unescape(re.sub(r"<[^>]+>", " ", mvs[mvs.index(">") + 1:mvs.rindex("<")]))   # visible text only (whole tags,
                                                                                            # hrefs go with them)
for k in MV_SPECS:                                                  # issue titles are GitHub data, not report wording
    mv_words = mv_words.replace("옮길 이슈 %d <b>제목</b>" % k, " ")
mv_words = re.sub(r"(?<![A-Za-z0-9_-])TST-[1-9][0-9]*(?![A-Za-z0-9_-])", " ", mv_words.replace(MV_SITE, " "))
mv_latin = [x for x in re.findall(r"[A-Za-z]+", mv_words) if x not in ("Jira", "GitHub", "HTTP", "TST")]
check("15u2 [contract §2 amended] the section's visible text is operator Korean: no Latin-letter word except ticket keys, "
      "the site / project, issue titles and the names Jira · GitHub · HTTP (no engine English such as 'run aborted at jira')",
      mv_latin == [] and "엔진 기록" not in mvs and "Jira 단계에서 실행이 멈춰 시도하지 않음" in li(lst, '/issues/112">'),
      repr(mv_latin[:20]))
check("15v titles escaped, never raw markup", "옮길 이슈 101 &lt;b&gt;제목&lt;/b&gt;" in lst and "<b>제목</b>" not in page, "")
merge = section(page, "mv-merge", 'id="mv-deleted"')
check("15w 합칠 후보: issue → its related keys (linked) with the sentence",
      "옮긴 티켓과 같은 일을 다루는 기존 티켓일 수 있음 — 합칠지 사람이 정함" in merge and '/issues/101">' in merge
      and 'browse/TST-90"' in merge and 'browse/TST-91"' in merge and merge.count('<li class="row">') == 1, merge[:400])
check("15x backlog line when a row moved this run (2 here), absent when none did (round 3 of 15d)",
      '<p id="mv-backlog">새 티켓은 담당자 없이 팀 백로그로 들어갔고, 보고자는 정리를 실행한 계정입니다.</p>' in mvs
      and page_nodone is not None and 'id="s-move"' in page_nodone and 'id="mv-backlog"' not in page_nodone
      and "라벨" not in mvs, "")
gone = section(page, "mv-deleted", 'id="mv-exits"')
check("15y 지워진 티켓: the key and the comment ids to delete (links to those issue comments)",
      '/issues/106">' in gone and 'browse/TST-499"' in gone
      and '<a href="https://github.com/test/repo/issues/106#issuecomment-5551">댓글 5551</a>' in gone
      and '<a href="https://github.com/test/repo/issues/106#issuecomment-5552">댓글 5552</a>' in gone, gone[:500])
def exits_of(pg_html):
    """→ {issue number: the 다음 할 일 cell text} of the section's unfinished-issue list."""
    out = {}
    for x in re.findall(r'<li class="row">(.*?)</li>', section(pg_html, "mv-exits", 'id="mv-reopened"'), re.S):
        out[int(re.search(r'/issues/([0-9]+)">', x).group(1))] = html.unescape(cells(x).get("다음 할 일", ""))
    return out


# contract §5 exit texts, written out here independently of the script's table
X_M1 = "Jira에서 이 이슈 주소로 티켓이 생겼는지 확인하고 그 결과를 기록한 뒤 같은 계획으로 다시 실행"
X_LINK = "확인 후 연결을 기록하고 같은 계획으로 다시 실행"
X_CHECK_COMMENT = "이슈에 이관 댓글이 달렸는지 확인하고 그 결과를 기록한 뒤 같은 계획으로 다시 실행"
X_FIX_COMMENT = "바뀐 이관 댓글을 지우고 연결을 기록한 뒤 같은 계획으로 다시 실행"
X_M4 = "남길 티켓 하나만 두고 나머지를 지운 뒤 다음 정리에서 다시 판단"
X_NONE = "만든 티켓 없음 — 이슈는 GitHub에 그대로이고 다음 정리가 다시 판단"
X_OTHER = "확인 결과를 보고 사람이 정함"
X_ROW3 = "이슈가 열려 있으면 그 티켓을 지울 때 다음 정리가 새로 만듦"             # row 3, no OK result (conditional)
X_M5 = "이슈가 열려 있으면 그 티켓을 지울 때 다음 정리가 새로 만듦 (옮긴 뒤 다시 열린 이슈면 GitHub에서 다시 닫아도 끝남)"
X_ROW3_DONE = ("이관 댓글이 달리고 닫힌 이슈 — 그 뒤 티켓이 바뀌었거나 없어짐. Jira에서 확인해 바뀐 티켓은 그대로 두거나 고치고, "
               "없어졌으면 오너가 정함 (닫힌 이슈는 정리가 다시 만들지 않음)")    # row 3 after OK moved / already-done
M19 = "만든 티켓에 담당자가 붙었거나 보고자가 실행 계정이 아님"
M20 = "만든 티켓을 다시 읽을 수 없음"
X_M19 = "그 티켓의 담당자를 떼고 보고자를 실행 계정으로 고친 뒤 같은 계획으로 다시 실행"
X_M20 = "Jira에서 그 티켓이 있는지 확인 — 같은 계획은 다시 실행하지 않음, 다음 정리에서 다시 판단"
M21 = "옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음"
X_REOPENED = "옮긴 뒤 다시 열린 이슈 — GitHub에서 다시 닫거나(진행 기록 보존) 티켓을 지우면(다음 정리가 새로 만들어 다시 닫음) 끝남"   # row 5 = M21
ABORT_WRITE = "journal has a write of this attempt, outcome unread (run aborted at jira)"   # chore.sh apply_abort_report fills
ABORT_UNREAD = "journal unreadable at abort (run aborted at jira)"
WANT_EXITS = {103: X_LINK,                                       # SKIP manual + row 10 why M9 (누가 먼저 닫음)
              104: X_M4,                                         # row 4 (SKIP exists) = M4's exit
              105: X_NONE, 106: X_NONE, 107: X_NONE, 108: X_NONE,  # row 12: nothing created
              109: X_CHECK_COMMENT,                              # row 10 why M14 (comment may have been posted)
              110: "같은 계획으로 다시 실행",                       # row 10 why M15 (close failed)
              111: X_M1,                                         # row 2 why M1 (create outcome open)
              112: X_ROW3,                                       # row 3 on a NOT-ATTEMPTED row (no OK result)
              113: "같은 계획으로 다시 실행"}                       # row 13 not scheduled
check("15z exits by exact §5 reason (rows 2 / 10 why, SKIP manual reason) or the row's fixed exit; done rows not listed",
      exits_of(page) == WANT_EXITS, repr({k: v for k, v in exits_of(page).items() if WANT_EXITS.get(k) != v}))
check("15z2 the reopened-issue line and the limits (comment response ≠ sent body: may have been posted, never 'not posted')",
      '<p id="mv-reopened">옮긴 뒤 다시 열린 이슈는 GitHub에서 다시 닫거나(진행 기록 보존) 티켓을 지우면(다음 정리가 새로 만들어 다시 닫음) 끝남</p>' in mvs
      and all(x in section(page, "mv-limits", "</p>") for x in (
          "마지막 확인과 쓰기 사이 몇 밀리초의 원격 변경은 막을 수 없고 사후 확인이 본다",
          "이 기계·이 클론·이 Jira 계정 범위만 중복을 막는다", "“댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단”"))
      and "게시되지 않" not in page and "게시 안 됨" not in page, section(page, "mv-limits", "</p>")[:400])
# one row changed per run: (tag, issue, VERIFY status, VERIFY text, (old, new) in the last results file or None, exit)
R6 = "%s — 이관 댓글 없음·중복·바뀜: " % K(101)                 # §7 row 6 on #101 (last RESULT OK already-done)
EXIT_CASES = (
    ("M6 row 6 이관 댓글이 지워짐", 101, "FAIL", R6 + "이관 댓글이 지워짐", None, X_LINK),
    ("M7 row 6 이관 댓글이 바뀜 (delete the changed comment first)", 101, "FAIL", R6 + "이관 댓글이 바뀜", None, X_FIX_COMMENT),
    ("M8 row 6 이관 댓글 중복 (delete the extras)", 101, "FAIL", R6 + "이관 댓글 중복", None,
     "이 계획이 기록한 하나만 남기고 나머지 이관 댓글을 지운 뒤 같은 계획으로 다시 실행"),
    ("M10 row 6 기록 없는 이관 댓글", 101, "FAIL", R6 + "기록 없는 이관 댓글", None, "그 댓글을 지운 뒤 같은 계획으로 다시 실행"),
    ("M11 row 6 이관 댓글 없음", 101, "FAIL", R6 + "이관 댓글 없음", None, X_LINK),
    ("M12 row 6 이관 댓글이 보낸 본문과 다름", 101, "FAIL", R6 + "이관 댓글이 보낸 본문과 다름", None, X_FIX_COMMENT),
    ("M8 row 6 with a deleted-ticket tail (reason read before it)", 101, "FAIL",
     R6 + "이관 댓글 중복 · 지워진 티켓 TST-498 (지울 댓글 7001)", None,
     "이 계획이 기록한 하나만 남기고 나머지 이관 댓글을 지운 뒤 같은 계획으로 다시 실행"),
    ("row 5 옮겼는데 이슈가 열려 있음", 101, "FAIL", "%s — 옮겼는데 이슈가 열려 있음" % K(101), None, X_REOPENED),
    ("M2 row 2 댓글 결과 미확정", 109, "UNRESOLVED", "결과 미확정 — 사람이 확인 후 기록 필요: 댓글 결과 미확정", None, X_CHECK_COMMENT),
    ("M13 row 10 이슈가 승인 뒤 바뀜 (next cleanup decides, not a rerun)", 106, "UNRESOLVED",
     "%s — 티켓 만듦, 이슈 닫지 않음: 이슈가 승인 뒤 바뀜 — 닫지 않음" % K(106),
     ("changed: 이슈가 승인 뒤 바뀜", "changed: %s — 이슈가 승인 뒤 바뀜" % K(106)),
     "다음 정리에서 다시 판단 (만든 티켓은 남고, 다음 계획이 그 티켓으로 닫음)"),
    ("M16 row 10 댓글 결과 모름", 111, "UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: 댓글 결과 모름 — 다음 실행이 확인" % K(111),
     ("UNKNOWN\tmove-issue\tissue#111\t만들기 결과 모름", "UNKNOWN\tmove-issue\tissue#111\t%s — 댓글 결과 모름" % K(111)),
     "같은 계획으로 다시 실행 (다음 실행이 댓글을 확인)"),
    # precedence (coordinator decision 2026-10-23): the current VERIFY finding wins over the last SKIP manual reason
    ("M3 SKIP manual 승인한 티켓이 없어짐 + row 3 → M3 (the one exception: the approved ticket is gone)", 103, "FAIL",
     "%s — 티켓이 안 보이거나 내용이 승인본과 다름: 없음" % K(103), ("누가 먼저 닫음 — 연결 기록 필요", "승인한 티켓이 없어짐"),
     "다음 정리에서 다시 판단"),
    ("M5 SKIP manual + row 3 → row 3's exit", 103, "FAIL", "%s — 티켓이 안 보이거나 내용이 승인본과 다름: 요약" % K(103),
     ("누가 먼저 닫음 — 연결 기록 필요", "티켓 내용이 승인본과 다름 — 닫지 않음"), X_ROW3),
    ("M7 SKIP manual (comment changed) + row 3 → row 3's exit, not M7's", 103, "FAIL",
     "%s — 티켓이 안 보이거나 내용이 승인본과 다름: 요약" % K(103), ("누가 먼저 닫음 — 연결 기록 필요", "이관 댓글이 바뀜"), X_ROW3),
    ("M4 SKIP manual + row 4 → M4", 103, "UNRESOLVED", "이 이슈의 티켓 여럿: %s, TST-530" % K(103),
     ("누가 먼저 닫음 — 연결 기록 필요", "이 이슈의 티켓 여럿"), X_M4),
    ("M9 SKIP manual + row 4 → M4 (duplicate-ticket cleanup), not M9's link-and-rerun", 103, "UNRESOLVED",
     "이 이슈의 티켓 여럿: %s, TST-530" % K(103), None, X_M4),
    ("M8 SKIP manual + an unmatched verify text → M8 (the SKIP reason only when no row matches)", 103, "UNRESOLVED",
     "다른 확인 문구", ("누가 먼저 닫음 — 연결 기록 필요", "이관 댓글 중복"),
     "이 계획이 기록한 하나만 남기고 나머지 이관 댓글을 지운 뒤 같은 계획으로 다시 실행"),
    ("row 7 닫기 전에 이슈 내용이 바뀜 (no fixed exit)", 101, "FAIL", "%s — 닫기 전에 이슈 내용이 바뀜" % K(101), None, X_OTHER),
    ("row 10b 티켓 만듦, 이슈는 닫힘 (why M18) on a NOT-ATTEMPTED row", 112, "UNRESOLVED",
     "%s — 티켓 만듦, 이슈는 닫힘: 이 실행의 결과 줄 없음 — 다시 실행하면 확인" % K(112), None,
     "같은 계획으로 다시 실행 (이미 옮긴 행은 다시 확인만 함)"),
    # chore.sh's English abort fill carried verbatim by row 10 (contract §6 round 3b): prefix match, "(run aborted at <stage>)" tail
    ("row 10 carrying the abort fill 'journal has a write …'", 111, "UNRESOLVED",
     "%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(111), ABORT_WRITE),
     ("UNKNOWN\tmove-issue\tissue#111\t만들기 결과 모름 — 다음 실행이 확인", "UNKNOWN\tmove-issue\tissue#111\t" + ABORT_WRITE),
     "같은 계획으로 다시 실행 (다음 실행이 확인)"),
    ("row 10 carrying the abort fill 'journal unreadable at abort …'", 111, "UNRESOLVED",
     "%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(111), ABORT_UNREAD),
     ("UNKNOWN\tmove-issue\tissue#111\t만들기 결과 모름 — 다음 실행이 확인", "UNKNOWN\tmove-issue\tissue#111\t" + ABORT_UNREAD),
     "일지를 읽을 수 없음 — 사람이 확인"),
    ("abort fill 'journal has a write …' carried by row 10b (older engine; the engine now sends M18 there)", 111, "UNRESOLVED",
     "%s — 티켓 만듦, 이슈는 닫힘: %s" % (K(111), ABORT_WRITE),
     ("UNKNOWN\tmove-issue\tissue#111\t만들기 결과 모름 — 다음 실행이 확인", "UNKNOWN\tmove-issue\tissue#111\t" + ABORT_WRITE),
     "같은 계획으로 다시 실행 (다음 실행이 확인)"),
    # M21 = a moved issue a person reopened; this plan never closes it again (contract §6 round 5) — exit = row 5's exit
    ("M21 carried by row 10 (reopened issue, not closed again)", 103, "UNRESOLVED",
     "%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(103), M21), ("누가 먼저 닫음 — 연결 기록 필요", M21), X_REOPENED),
    ("M21 bare SKIP manual + an unmatched verify text", 103, "UNRESOLVED", "다른 확인 문구",
     ("누가 먼저 닫음 — 연결 기록 필요", M21), X_REOPENED),
    # M19 / M20 = the post-create check (contract §6 round 3): never the delete-the-ticket wording of M5 / row 3
    ("M19 SKIP manual + an unmatched verify text", 103, "UNRESOLVED", "다른 확인 문구",
     ("누가 먼저 닫음 — 연결 기록 필요", M19), X_M19),
    ("M19 SKIP manual + row 3 (reporter mismatch fails the ticket check)", 103, "FAIL",
     "%s — 티켓이 안 보이거나 내용이 승인본과 다름: 보고자가 다름" % K(103), ("누가 먼저 닫음 — 연결 기록 필요", M19), X_M19),
    ("M19 carried by row 10", 103, "UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(103), M19),
     ("누가 먼저 닫음 — 연결 기록 필요", M19), X_M19),
    ("M20 SKIP manual + an unmatched verify text", 103, "UNRESOLVED", "다른 확인 문구",
     ("누가 먼저 닫음 — 연결 기록 필요", M20), X_M20),
    ("M20 SKIP manual + row 3 (this plan's unchecked KEY reads 404)", 103, "FAIL",
     "%s — 티켓이 안 보이거나 내용이 승인본과 다름: 없음" % K(103), ("누가 먼저 닫음 — 연결 기록 필요", M20), X_M20),
    ("M20 carried by row 10b", 103, "UNRESOLVED", "%s — 티켓 만듦, 이슈는 닫힘: %s" % (K(103), M20),
     ("누가 먼저 닫음 — 연결 기록 필요", M20), X_M20),
    ("M17 SKIP manual (ticket gone, comment result pending; no live KEY) + an unmatched verify text", 103, "UNRESOLVED",
     "다른 확인 문구 · 지워진 티켓 TST-497 (지울 댓글 7002)",
     ("%s — 누가 먼저 닫음 — 연결 기록 필요" % K(103), "지워진 티켓의 댓글 결과 미확정"),
     "이슈에 지워진 티켓을 가리키는 이관 댓글이 달렸는지 확인해 있으면 지우고, 결과를 기록한 뒤 같은 계획으로 다시 실행"),
    ("an unknown reason on row 10 (human decides; keys need both-sided boundaries)", 103, "UNRESOLVED",
     "%s — 티켓 만듦, 이슈 닫지 않음: 알 수 없는 사유 xTST-1 TST-123abc TST-123-extra TST-77" % K(103), None, X_OTHER),
    ("an unknown SKIP manual reason with an unmatched verify text", 103, "UNRESOLVED", "다른 확인 문구",
     ("누가 먼저 닫음 — 연결 기록 필요", "처음 보는 사유"), X_OTHER))
for tag, k, st, vtext, res_change, want_exit in EXIT_CASES:
    res = MVR if res_change is None else [MVR[0], mutate(MVR[1], "mv-exit-res-%d.out" % n, res_change[0], res_change[1])]
    rc, err, pgx = mv_run(MVP, MVD, res, mv_verify("mv-exit-%d.out" % n, mv_vlines({k: (st, vtext)})))
    got_exit = exits_of(pgx or "").get(k)
    check("15z3 [§5] #%d %s → %s" % (k, tag, want_exit), rc == 0 and got_exit == want_exit,
          "rc=%s err=%r exit=%r" % (rc, err[:200], got_exit))
    if "abort fill" in tag:
        vcell = cells(li(section(pgx or "", "mv-list", 'id="mv-merge"'), '/issues/111">')).get("확인 결과", "")
        rcell = cells(li(section(pgx or "", "mv-list", 'id="mv-merge"'), '/issues/111">')).get("결과", "")
        want_k = ("이 실행이 요청을 보낸 기록은 있지만 결과를 읽지 못함 (Jira 단계에서 멈춤)" if ABORT_WRITE in vtext
                  else "멈출 때 기록을 읽지 못해 보냈는지 알 수 없음 (Jira 단계에서 멈춤)")
        check("15z3g #111 %s: the carried engine English is shown in operator words only (verify and result cells)" % tag,
              rc == 0 and want_k in vcell and want_k in rcell and "journal" not in vcell + rcell and "aborted" not in vcell + rcell
              and 'browse/%s">' % K(111) in vcell, (vcell + " || " + rcell)[:500])
    if tag.startswith(("M19", "M20")):
        rowx = li(section(pgx or "", "s-move", 'id="s-kept"'), '/issues/103">')
        check("15z3f #103 %s: no delete-the-ticket wording anywhere on the row (M5 / row 3 exits)" % tag,
              rc == 0 and "그 티켓을 지" not in (got_exit or "") and "그 티켓을 지" not in exits_of(pgx or "").get(103, "")
              and "그 티켓을 지" not in rowx, (got_exit or "")[:200])     # 그 티켓을 지우면 / 지울 때 (row 3, M5)
    if tag.startswith("row 10b"):
        r112 = li(section(pgx or "", "s-move", 'id="s-kept"'), '/issues/112">')
        vcell = cells(li(section(pgx or "", "mv-list", 'id="mv-merge"'), '/issues/112">')).get("확인 결과", "")
        check("15z3d row 10b reads as ticket made and issue closed (never 이슈 닫지 않음), key linked, counted 실패·미해결",
              "티켓 만듦, 이슈는 닫힘: 이 실행의 결과 줄 없음 — 다시 실행하면 확인" in vcell and 'browse/%s">' % K(112) in vcell
              and "이슈 닫지 않음" not in r112 and "실패·미해결<span" in li(section(pgx or "", "mv-list", 'id="mv-merge"'), '/issues/112">'),
              vcell[:400])
        g10b = nums(pgx or "")
        st10b = {kk: (s if kk != k else st) for kk, (s, _) in MV_DEFAULT.items()}
        want10b = {x: sum(1 for kk, s in st10b.items() if mv_outcome(kk, s) == x) for x in ("done", "already", "skip", "bad", "notrun")}
        done10b = section(pgx or "", "s-done", 'id="s-move"')
        check("15z3e row 10b is not counted as moved: 옮긴 이슈 tile / section count / move funnel still 2 (101, 114), #112 under "
              "실패·미해결, not in 처리한 것",
              want10b == {"done": 2, "already": 1, "skip": 3, "bad": 7, "notrun": 1} and mv_funnel(pgx or "") == want10b
              and (g10b.get("t-moves"), g10b.get("mv-done"), g10b.get("mv-bad"), g10b.get("t-bad")) == (2, 2, 7, 7)
              and '/issues/112">' not in done10b and '/issues/101">' in done10b
              and '/issues/112">' in section(pgx or "", "rest-bad", "</div>\n</div>"),
              "funnel=%r want=%r tiles=%r" % (mv_funnel(pgx or ""), want10b,
                                              [g10b.get(x) for x in ("t-moves", "mv-done", "mv-bad", "t-bad")]))
    if tag.startswith("an unknown reason on row 10"):
        vcell = cells(li(section(pgx or "", "mv-list", 'id="mv-merge"'), '/issues/103">')).get("확인 결과", "")
        check("15z3b [§5 last line] keys need key-character boundaries on both sides: TST-77 linked; TST-123abc, TST-123-extra, "
              "xTST-1 shown as text",
              'browse/TST-77">TST-77</a>' in vcell and "xTST-1 TST-123abc TST-123-extra" in vcell
              and "browse/TST-123" not in vcell and "browse/TST-1\"" not in vcell, vcell[:400])
pat = R.move_key_re("TST")
check("15z3c move_key_re finds TST-9 / TST-10 only: not in TST-123abc, TST-123-extra, xTST-1, TST-1_x, _TST-2",
      pat.findall("TST-9, (TST-10) TST-123abc TST-123-extra xTST-1 TST-1_x _TST-2 TST-0") == ["TST-9", "TST-10"],
      repr(pat.findall("TST-9, (TST-10) TST-123abc TST-123-extra xTST-1 TST-1_x _TST-2 TST-0")))
done = section(page, "s-done", 'id="s-move"')
check("15z4 처리한 것: OK and WARN move rows under Jira로 옮긴 이슈 (101, 114 WARN row 9) / 이미 Jira로 옮겨져 있던 이슈 (102 WARN row 8), "
      "none under 닫은 이슈 or the Jira not-moved WARN group",
      '/issues/101">' in section(page, "done-move-issue", "</div>\n</div>") and '/issues/114">' in section(page, "done-move-issue", "</div>\n</div>")
      and "주의 — " in li(section(page, "done-move-issue", "</div>\n</div>"), '/issues/114">')
      and '/issues/102">' in section(page, "done-move-already", "</div>\n</div>") and 'id="done-close-issue"' not in page
      and 'id="rest-warn"' not in page and "Jira로 옮긴 이슈 <span" in done, done[:300])
rest_ = section(page, "s-rest", "<footer>")
check("15z5 건너뜀·실패·미해결 lists the move rows that are not done (move wording, no Jira class labels)",
      all('/issues/%d">' % k in rest_ for k in (103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113))
      and "사람 확인 필요: " in li(rest_, '/issues/103">') and "승인 뒤 티켓이 바뀜" not in rest_
      and "결과 모름 — 만들기 결과 모름 — 다음 실행이 확인" in li(rest_, '/issues/111">'), li(rest_, '/issues/103">')[:400])
check("15z6 coverage adds 이슈 Jira로 옮기기 결정 / 실행 (12 attempted: #112 only NOT-ATTEMPTED, #113 never ran); 이슈 닫기 결정 = closes only",
      "이슈 닫기 결정 <span id=\"cov-3\">0</span>건 · 이슈 Jira로 옮기기 결정 <span id=\"cov-4\">14</span>건" in page
      and "이슈 Jira로 옮기기 실행 <span id=\"cov-9\">12</span>건" in page, section(page, "coverage", "</p>")[:600])

# success=yes with move WARN rows: headline count = 처리한 것 = 옮긴 이슈 tile + 이미 옮겨져 있던 이슈
sp, sd, sr = mv_scenario("ok", {k: MV_SPECS[k] for k in (101, 102, 113, 114)},
                         [("ABORTED", A1M, [("OK", 101, "moved: %s — 티켓을 만들고 이슈를 닫음" % K(101))]),
                          ("SUMMARY", A2M, [x for x in MV_RUNS[1][2] if x[1] in (101, 102, 114)])])
rc, err, pok = mv_run(sp, sd, sr, mv_verify("mv-ok.out", ["VERIFY\t%s\tmove-issue\tissue#%d\t%s" % (MV_DEFAULT[k][0], k, MV_DEFAULT[k][1])
                                                           for k in (101, 102, 113, 114)] + MV_PINV))
pok = pok or ""
g = nums(pok)
check("15z7 success=yes, WARN rows 8/9 among them: headline 확인한 3건 = 처리한 것 3건 = 옮긴 이슈 2 + 이미 옮겨져 있던 이슈 1",
      rc == 0 and '<span id="verdict-text">확인한 3건 모두 확인됨 · 실행 안 함 1건</span>' in pok and "주의 2" in pok
      and '<h2 id="s-done">처리한 것 <span class="muted">3건</span></h2>' in pok and g.get("t-moves") == 2
      and "이미 Jira로 옮겨져 있던 이슈 <span class=\"muted\">1건</span>" in pok
      and "없음 — 모든 이슈가 옮겨졌거나 이미 옮겨져 있습니다." not in pok, "rc=%s err=%r" % (rc, err))

# move rows mixed with closes, Jira transitions and branches (v4-plan.tsv + 3 move rows, one more full run): sums balance
A3M = "20261021T030000Z-c3c3c3c3"
xp, xd, xr = mv_scenario("mixed", {41: {}, 42: {}, 43: {}},
                         [("SUMMARY", A3M, [("OK", 41, "moved: %s — 티켓을 만들고 이슈를 닫음" % K(41)),
                                            ("SKIP", 42, "changed: 이슈가 승인 뒤 바뀜 — 닫지 않음"),
                                            ("UNKNOWN", 43, "만들기 결과 모름 — 다음 실행이 확인")])],
                         base_plan=PLAN, base_results=[AP1, AP2])
xv = mv_verify("mv-mixed.out", [x for x in V_.rstrip("\n").split("\n") if not x.startswith("VERIFY-SUMMARY")]
               + ["VERIFY\tOK\tmove-issue\tissue#41\t%s — 옮김" % K(41), "VERIFY\tRESOLVED\tmove-issue\tissue#42\t만든 것 없음 — 이슈가 승인 뒤 바뀜",
                  "VERIFY\tUNRESOLVED\tmove-issue\tissue#43\t결과 미확정 — 사람이 확인 후 기록 필요: 만들기 결과 미확정 — 다시 만들지 않음"])
rc, err, pmx = mv_run(xp, xd, xr, xv)
pmx = pmx or ""
g = nums(pmx)
check("15z8 mixed plan renders; area sums balance (issue area 5 + 3 move rows), closes and moves counted apart",
      rc == 0 and [g.get(x) for x in ("f-issue-total", "f-issue-r-act", "f-issue-r-move", "f-issue-r-keep", "f-issue-r-out",
                                     "f-issue-x-done", "f-issue-x-skip", "f-issue-m-done", "f-issue-m-skip", "f-issue-m-bad")]
      == [8, 2, 3, 1, 2, 1, 1, 1, 1, 1], "rc=%s err=%r %r" % (rc, err, {k: v for k, v in g.items() if k.startswith("f-issue")}))
check("15z9 mixed: tiles — 닫은 이슈 1 (closes only), Jira로 옮긴 이슈 1, Jira QA 1 as before, 실패·미해결 3",
      [g.get(x) for x in ("t-branches", "t-prs", "t-issues", "t-moves", "t-jira-qa", "t-jira-closed", "t-bad")] == [3, 1, 1, 1, 1, 0, 3]
      and '/issues/41">' not in section(pmx, "done-close-issue", "</div>\n</div>")
      and '/issues/9">' in section(pmx, "done-close-issue", "</div>\n</div>")
      and '/issues/41">' in section(pmx, "done-move-issue", "</div>\n</div>"), repr(g))
check("15z10 mixed: coverage keeps closes and moves apart (이슈 닫기 결정 2 · 이슈 Jira로 옮기기 결정 3, 실행 2 / 3)",
      [g.get("cov-%d" % i) for i in range(13)] == [3, 2, 1, 2, 3, 4, 5, 2, 2, 3, 5, 4, 0], repr([g.get("cov-%d" % i) for i in range(13)]))
mx_flow = section(pmx, "f-issue", 'id="f-jira"')
check("15z11 mixed: the issue funnel names 닫기 and Jira로 옮기기 separately, each with its own execution bar",
      "(닫기 2 · Jira로 옮기기 <span id=\"f-issue-moves\">3</span> · 남김 1 · 결정 필요 0)" in mx_flow
      and "<b>실행</b> — 닫기 2건 → 닫힘 확인 1 · 건너뜀 1 · 실패·미해결 0</p>" in mx_flow
      and "<b>실행</b> — Jira로 옮기기 3건 → 이번 실행이 옮김 1 · 건너뜀 1 · 실패·미해결 1</p>" in mx_flow, mx_flow[:900])

# ── 16. trinity R1: the next command agrees with each move row's next step; a possibly-made ticket is never "티켓 없음" ──
def next_block(pg_html):
    """→ the 건너뜀·실패·미해결 section's next-step block (from its heading to the section end), "" when absent."""
    rest_ = section(pg_html, "s-rest", "<footer>")
    i = rest_.find('id="s-next"')
    return rest_[i:] if i >= 0 else ""


def small_move(tag, rows, base_plan=None):
    """rows = [(n, last RESULT (status, reason) or None, VERIFY (status, text))] → page (rc, err, html)."""
    items = [(st, k, why) for k, res_, _ in rows if res_ for st, why in [res_]]
    plan, pdir, res = mv_scenario(tag, {k: {} for k, _, _ in rows}, [("SUMMARY", A2M, items)] if items else [],
                                  base_plan=base_plan)
    if not items:      # parse_results needs one closed run: an empty full run
        res = [write("mv-%s-empty.out" % tag, ["SUMMARY\tok=0\tskip=0\tfail=0\tunknown=0\trun_id=%s\tattempt=%s\tscope=full\tjournal=/j"
                                               % (re.search(r"\trun_id=([^\t]+)", Path(plan).read_text(encoding="utf-8")).group(1), A2M)])]
    v = mv_verify("mv-%s-verify.out" % tag, ["VERIFY\t%s\tmove-issue\tissue#%d\t%s" % (vs, k, vt) for k, _, (vs, vt) in rows]
                  + MV_PINV)
    return mv_run(plan, pdir, res, v)


# (A1) an M20 row next to a plain rerun row (M15): no rerun command at all; the paragraph names the M20 row
rc, err, pa = small_move("m20", [(141, ("SKIP", "manual: %s — %s" % (K(141), M20)), ("UNRESOLVED", "다른 확인 문구")),
                                 (142, ("FAIL", "close-failed: %s — 이슈를 닫지 못함" % K(142)),
                                  ("UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: 이슈를 닫지 못함" % K(142)))])
nb = next_block(pa or "")
check("16a M20 row (+ an M15 rerun row): no rerun command; the no-rerun paragraph names the M20 row and sends the rest to the "
      "next chore",
      rc == 0 and 'id="next-cmd"' not in (pa or "") and "scripts/chore.sh apply" not in (pa or "")
      and '<p id="next-stop">이 계획은 다시 실행하지 않습니다 — 다시 실행하면 Jira 단계가 이 행에서 또 멈춥니다: ' in nb
      and '/issues/141">이슈 #141</a>. 나머지 행은 다음 정리에서 다룹니다.</p>' in nb and '/issues/142">' not in nb,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# (A2) an M19 row + a close row never run: command shown, 먼저 할 일 lists the M19 row with its exit text
cbase = TMP / "close-base.tsv"
cbase.write_bytes(Path(JPLAN).read_bytes().split(b"\n")[0] + b"\n" + b"\t".join(
    [b"2", b"close-issue", b"issue#61", b"2026-08-01T00:00:00Z", PL.encode_snapshot({"state": "OPEN", "updated": "2026-08-01T00:00:00Z",
                                                                                   "author": "frank"}), PL.penc("오래된 이슈라 닫습니다")]) + b"\n")
rc, err, pb_ = small_move("m19", [(143, ("SKIP", "manual: %s — %s" % (K(143), M19)),
                                   ("UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(143), M19)))], base_plan=cbase)
nb = next_block(pb_ or "")
check("16b M19 row + a close row never run: the rerun command is shown, after 먼저 할 일 with the M19 row and its exit",
      rc == 0 and 'id="next-cmd"' in nb and nums(pb_ or "").get("f-issue-x-notrun") == 1
      and '<p id="next-first-head">다시 실행하기 전에 먼저 할 일</p>' in nb
      and re.search(r'<ul class="hist" id="next-first"><li><a href="[^"]*/issues/143">이슈 #143</a> — %s</li></ul>' % re.escape(X_M19), nb)
      is not None and nb.find('id="next-first"') < nb.find('id="next-cmd"') and 'id="next-stop"' not in nb,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:600]))
# (A3) only an M13 row (다음 정리): no command; one line says nothing to rerun and names it under 다음 정리
rc, err, pc = small_move("m13", [(144, ("SKIP", "changed: %s — 이슈가 승인 뒤 바뀜 — 닫지 않음" % K(144)),
                                  ("UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: 이슈가 승인 뒤 바뀜 — 닫지 않음" % K(144)))])
nb = next_block(pc or "")
check("16c only an M13 row: no command; 같은 계획으로 다시 실행할 행이 없습니다 + the row under 이 계획으로 끝나지 않음 — 다음 정리",
      rc == 0 and 'id="next-cmd"' not in (pc or "")
      and re.search(r'<p id="next-none">같은 계획으로 다시 실행할 행이 없습니다\. 이 계획으로 끝나지 않음 — 다음 정리: '
                    r'<a href="[^"]*/issues/144">이슈 #144</a>\.</p>', nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# (A4) an owner-decides row (unknown reason) alone: no command, named under 오너가 정함
rc, err, pd_ = small_move("owner", [(145, ("SKIP", "manual: %s — 처음 보는 사유" % K(145)), ("UNRESOLVED", "다른 확인 문구"))])
nb = next_block(pd_ or "")
check("16d only an owner-decides row: no command, the row under 오너가 정함",
      rc == 0 and 'id="next-cmd"' not in (pd_ or "")
      and re.search(r'<p id="next-none">같은 계획으로 다시 실행할 행이 없습니다\. 오너가 정함: <a href="[^"]*/issues/145">이슈 #145</a>\.</p>',
                    nb) is not None, "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# (A5) the default matrix page: command shown (M15 / not-run rows), first-step rows 103 / 109 / 111, 다음 정리 rows 104 / 108 / 112
nb = next_block(page)
check("16e matrix page: command with 먼저 할 일 (103 M9, 109 M14, 111 M1) and 다음 정리 (104, 108, 112); no owner line",
      'id="next-cmd"' in nb and [int(x) for x in re.findall(r'/issues/([0-9]+)">', section(nb, "next-first", "</ul>"))] == [103, 109, 111]
      and [int(x) for x in re.findall(r'/issues/([0-9]+)">', section(nb, "next-later", "</p>"))] == [104, 108, 112]
      and 'id="next-owner"' not in nb, nb[:800])

# (B) a create that may have been sent and has no key yet: "티켓이 생겼을 수 있음 — 키 미확정" wherever the ticket cell renders
MAYBE, NOKEY = '<span class="muted">티켓이 생겼을 수 있음 — 키 미확정</span>', '<span class="muted">티켓 없음</span>'
check("16f create UNKNOWN (#111, row 2 M1): the per-issue table and the unfinished list both say 티켓이 생겼을 수 있음 — 키 미확정",
      MAYBE in li(lst, '/issues/111">') and MAYBE in li(section(page, "mv-exits", 'id="mv-reopened"'), '/issues/111">')
      and NOKEY not in li(section(page, "s-move", 'id="s-kept"'), '/issues/111">'), li(lst, '/issues/111">')[:300])
check("16g row 12 만든 것 없음 (#105 account, #108 Jira가 거절함): 티켓 없음 in both lists",
      all(NOKEY in li(lst, '/issues/%d">' % k) and NOKEY in li(section(page, "mv-exits", 'id="mv-reopened"'), '/issues/%d">' % k)
          and MAYBE not in li(section(page, "s-move", 'id="s-kept"'), '/issues/%d">' % k) for k in (105, 108)), "")
for tag, k, vline, want in (
        ("UNKNOWN alone (verify text matches no row)", 111, ("UNRESOLVED", "다른 확인 문구"), MAYBE),
        ("verify row 2 alone (SKIP account, no UNKNOWN)", 105,
         ("UNRESOLVED", "결과 미확정 — 사람이 확인 후 기록 필요: 만들기 결과 미확정 — 다시 만들지 않음"), MAYBE)):
    rc, err, pgk = mv_run(MVP, MVD, MVR, mv_verify("mv-keycell-%d.out" % n, mv_vlines({k: vline})))
    check("16h #%d %s → %s" % (k, tag, re.sub(r"<[^>]+>", "", want)),
          rc == 0 and want in li(section(pgk or "", "mv-list", 'id="mv-merge"'), '/issues/%d">' % k), "rc=%s err=%r" % (rc, err[:200]))

# ── 17. trinity R1 T3: row 3 after this plan moved and closed the issue never says "delete it, the next chore remakes it" ──
check("17a MOVE_ROW3_DONE is the exact text, has no 다음 정리, and sorts as 오너가 정함 in the next-step block",
      R.MOVE_ROW3_DONE == X_ROW3_DONE and "다음 정리" not in R.MOVE_ROW3_DONE and R.move_next_kind(R.MOVE_ROW3_DONE) == "owner"
      and R.move_next_kind(X_ROW3) == "later" and R.move_next_kind(X_M5) == "later", repr(R.move_next_kind(R.MOVE_ROW3_DONE)))
R3 = "티켓이 안 보이거나 내용이 승인본과 다름: "
for k, cls_text, tag in ((151, "moved: %s — 티켓을 만들고 이슈를 닫음", "OK moved"),
                         (152, "already-done: %s — 이미 닫혀 있고 이관 댓글 있음", "OK already-done")):
    rc, err, p3 = small_move("r3done-%d" % k, [(k, ("OK", cls_text % K(k)), ("FAIL", "%s — %s요약이 다름" % (K(k), R3)))])
    nb = next_block(p3 or "")
    check("17b %s, then verify row 3 FAIL → the closed-issue exit (no delete-and-remake) in the unfinished list" % tag,
          rc == 0 and exits_of(p3 or "").get(k) == X_ROW3_DONE and "그 티켓을 지울 때" not in section(p3 or "", "s-move", 'id="s-kept"'),
          "rc=%s err=%r exit=%r" % (rc, err[:200], exits_of(p3 or "").get(k)))
    check("17c %s + row 3 as the only unfinished row: no rerun command, the row under 오너가 정함" % tag,
          rc == 0 and 'id="next-cmd"' not in (p3 or "")
          and re.search(r'<p id="next-none">같은 계획으로 다시 실행할 행이 없습니다\. 오너가 정함: <a href="[^"]*/issues/%d">이슈 #%d</a>\.</p>'
                        % (k, k), nb) is not None, "rc=%s block=%r" % (rc, nb[:400]))
# an earlier OK moved (run 1) and a later SKIP manual M3 (run 2: the adopted ticket is gone after the move), verify row 3
r3m3 = mutate(mutate(MVR[1], "r3m3-a.out", "RESULT\tOK\tmove-issue\tissue#101\talready-done: %s — 이미 닫혀 있고 이관 댓글 있음" % K(101),
                     "RESULT\tSKIP\tmove-issue\tissue#101\tmanual: %s — 승인한 티켓이 없어짐" % K(101)),
              "r3m3-b.out", "SUMMARY\tok=3\tskip=5\t", "SUMMARY\tok=2\tskip=6\t")
rc, err, p4 = mv_run(MVP, MVD, [MVR[0], r3m3], mv_verify("mv-r3m3.out", mv_vlines({101: ("FAIL", "%s — %s없음" % (K(101), R3))})))
check("17d OK moved earlier + later SKIP manual M3 + verify row 3 → the closed-issue exit, not M3's 다음 정리에서 다시 판단",
      rc == 0 and exits_of(p4 or "").get(101) == X_ROW3_DONE, "rc=%s err=%r exit=%r" % (rc, err[:200], exits_of(p4 or "").get(101)))
rc, err, p5 = mv_run(MVP, MVD, [MVR[0], mutate(MVR[1], "m5-bare.out", "누가 먼저 닫음 — 연결 기록 필요", "티켓 내용이 승인본과 다름 — 닫지 않음")],
                     mv_verify("mv-m5-bare.out", mv_vlines({103: ("UNRESOLVED", "다른 확인 문구")})))
check("17e M5 SKIP manual + an unmatched verify text → M5's exit, now conditional on the issue being open",
      rc == 0 and exits_of(p5 or "").get(103) == X_M5, "rc=%s err=%r exit=%r" % (rc, err[:200], exits_of(p5 or "").get(103)))

# ── 18. trinity R2 ──
# (C) every exit text → its class in the next-step block (stop = the M20 text with MOVE_NO_RERUN). A text change that moves
# an exit to another class fails here; a new §5 reason without an entry fails the key check.
def next_class(e):
    return "stop" if R.MOVE_NO_RERUN in e else R.move_next_kind(e)


WANT_KIND = {"만들기 결과 미확정 — 다시 만들지 않음": "first", "댓글 결과 미확정": "first", "승인한 티켓이 없어짐": "later",
             "이 이슈의 티켓 여럿": "later", "티켓 내용이 승인본과 다름 — 닫지 않음": "later", "이관 댓글이 지워짐": "first",
             "이관 댓글이 바뀜": "first", "이관 댓글 중복": "first", "누가 먼저 닫음 — 연결 기록 필요": "first",
             "기록 없는 이관 댓글": "first", "이관 댓글 없음": "first", "이관 댓글이 보낸 본문과 다름": "first",
             "이슈가 승인 뒤 바뀜 — 닫지 않음": "later", "댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단": "first",
             "이슈를 닫지 못함": "rerun", "댓글 결과 모름 — 다음 실행이 확인": "rerun", "지워진 티켓의 댓글 결과 미확정": "first",
             "이 실행의 결과 줄 없음 — 다시 실행하면 확인": "rerun", "만든 티켓에 담당자가 붙었거나 보고자가 실행 계정이 아님": "first",
             "만든 티켓을 다시 읽을 수 없음": "stop", "옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음": "later"}
WANT_ROW_KIND = {"이 이슈의 티켓 여럿": "later", "티켓이 안 보이거나 내용이 승인본과 다름": "later", "옮겼는데 이슈가 열려 있음": "later",
                 "닫기 전에 이슈 내용이 바뀜": "owner", "이 이슈를 가리키는 티켓이 이미 있음": "later", "만든 것 없음": "later",
                 "이번 실행에서 시도 안 함": "rerun"}
WANT_ABORT_KIND = {"journal has a write of this attempt, outcome unread": "rerun", "journal unreadable at abort": "owner"}
got_kind = {k: next_class(v) for k, v in R.MOVE_REASON_EXITS.items()}
got_row = {k: next_class(v) for k, v in R.MOVE_ROW_EXITS}
got_abort = {k: next_class(v) for k, v in R.MOVE_ABORT_EXITS}
check("18a [C] every exit text's next-step class is pinned: §5 M1–M21, the row exits, the abort exits, MOVE_ROW3_DONE (owner), "
      "MOVE_REOPENED_EXIT (later), MOVE_EXIT_OTHER (owner)",
      got_kind == WANT_KIND and got_row == WANT_ROW_KIND and got_abort == WANT_ABORT_KIND
      and next_class(R.MOVE_ROW3_DONE) == "owner" and next_class(R.MOVE_REOPENED_EXIT) == "later"
      and next_class(R.MOVE_EXIT_OTHER) == "owner",
      repr({k: (got_kind.get(k), WANT_KIND.get(k)) for k in set(got_kind) | set(WANT_KIND) if got_kind.get(k) != WANT_KIND.get(k)})
      + repr({k: (got_row.get(k), v) for k, v in WANT_ROW_KIND.items() if got_row.get(k) != v})
      + repr({k: (got_abort.get(k), v) for k, v in WANT_ABORT_KIND.items() if got_abort.get(k) != v}))
check("13e JIRA_BREAKER_HEAD is how chore.sh's Jira-stage breaker die text starts (the ABORTED reason the report reads)",
      re.search(r'9\) die "%s[^"]*"' % re.escape(R.JIRA_BREAKER_HEAD), ssrc) is not None, R.JIRA_BREAKER_HEAD)

# (A) the breaker: the last run ABORTED with the breaker reason → never print the rerun command
BRK = "Jira 단계가 차단기로 멈춤 — 원인을 고치기 전에는 다시 실행하지 않음"   # chore.sh:1362, verbatim
JRUN_ID = re.search(r"\trun_id=([^\t]+)", Path(JPLAN).read_text(encoding="utf-8").split("\n")[0]).group(1)
X_BREAKER_REST = ("원인을 고치기 전에는 같은 계획을 다시 실행하지 않습니다. 원인이 된 티켓과 이유는 차단기로 멈춘 실행의 오류 출력"
                  "(chore: jira: …)에 있습니다. 원인을 고쳤으면 같은 실행 명령을 다시 쓰고, 고칠 수 없으면 남은 행은 다음 정리에서 다룹니다.")
X_BREAKER = "Jira 단계가 차단기로 멈춘 뒤, 원인 행이 성공(OK)으로 끝난 실행이 아직 없습니다 — " + X_BREAKER_REST
X_BREAKER_UNKNOWN = "Jira 단계가 차단기로 멈췄고 원인 행을 결과에서 찾지 못했습니다 — " + X_BREAKER_REST
X_CAUSE_UNKNOWN = "차단기 원인 행: 결과에서 찾지 못함 — 차단기로 멈춘 실행의 오류 출력(chore: jira: …)을 보세요"


def cause_re(n_, key, why):
    """the cause line of a move row whose cause RESULT is SKIP manual '<key> — <why>' (the reason at the stop, history wording,
    key linked)."""
    return (r'차단기 원인 행: <a href="[^"]*/issues/%d">이슈 #%d</a> — 멈출 때 사유: 사람 확인 필요: <a href="[^"]*/browse/%s">%s</a> — %s'
            % (n_, n_, key, key, re.escape(why)))
NA_VERIFY = "확인 필요: run aborted at jira"     # what chore-jira.py verify-rows writes for a not-attempted row (VTU + result text)


def breaker_case(tag, rows, reason=BRK, runs_before=()):
    """rows = [(n, (status, reason) | None, (verify status, text))] in one last run closed by ABORTED reason=<reason>
    (runs_before = earlier (kind, attempt, items[, reason]) runs) → (rc, err, page)."""
    items = [(st, k, why) for k, res_, _ in rows if res_ for st, why in [res_]]
    plan, pdir, res = mv_scenario(tag, {k: {} for k, _, _ in rows}, list(runs_before) + [("ABORTED", A2M, items, reason)])
    v = mv_verify("mv-%s-verify.out" % tag, ["VERIFY\t%s\tmove-issue\tissue#%d\t%s" % (vs, k, vt) for k, _, (vs, vt) in rows]
                  + MV_PINV, run_id=JRUN_ID)
    return mv_run(plan, pdir, res, v)


M5_ROW = (161, ("SKIP", "manual: %s — 티켓 내용이 승인본과 다름 — 닫지 않음" % K(161)),
          ("FAIL", "%s — 티켓이 안 보이거나 내용이 승인본과 다름: 설명이 다름" % K(161)))
NA_ROW = (162, ("NOT-ATTEMPTED", "run aborted at jira"), ("UNRESOLVED", NA_VERIFY))
rc, err, pa = breaker_case("brk-m5", [M5_ROW, NA_ROW])
nb = next_block(pa or "")
check("18b [A-a] M5 breaker run (#161 M5 + row 3, #162 not attempted): no command; the breaker paragraph; #161 on the cause "
      "line (not in any list), #162 on 원인을 고친 뒤 다시 실행할 행",
      rc == 0 and 'id="next-cmd"' not in (pa or "") and "scripts/chore.sh apply" not in (pa or "")
      and nb.startswith('id="s-next" class="group">다음 할 일</h3>\n<p id="next-breaker">%s</p>' % X_BREAKER)
      and re.search(r'<p id="next-rerun">원인을 고친 뒤 다시 실행할 행: <a href="[^"]*/issues/162">이슈 #162</a></p>', nb) is not None
      and re.search(r'<p id="next-cause">%s</p>' % cause_re(161, K(161), "티켓 내용이 승인본과 다름 — 닫지 않음"), nb)
      is not None and 'id="next-later"' not in nb and 'id="next-stop"' not in nb,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:700]))
v162 = cells(li(section(pa or "", "mv-list", 'id="mv-exits"'), '/issues/162">')).get("확인 결과", "")
check("18c a not-attempted row the writer marks '확인 필요: <result text>' → next step 같은 계획으로 다시 실행, the English "
      "result text shown in operator words",
      rc == 0 and exits_of(pa or "").get(162) == "같은 계획으로 다시 실행"
      and "확인 필요: Jira 단계에서 실행이 멈춰 시도하지 않음" in v162 and "aborted" not in v162, v162[:300])
rc, err, pb2 = breaker_case("brk-m19", [(163, ("SKIP", "manual: %s — %s" % (K(163), M19)),
                                         ("UNRESOLVED", "%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(163), M19))), NA_ROW])
nb = next_block(pb2 or "")
check("18d [A-b] M19 breaker run: no command; the M19 row (the cause) is on the cause line with its cause reason, not in 먼저 할 일",
      rc == 0 and 'id="next-cmd"' not in (pb2 or "") and 'id="next-breaker"' in nb
      and re.search(r'<p id="next-cause">%s</p>' % cause_re(163, K(163), M19), nb) is not None and 'id="next-first"' not in nb, "rc=%s err=%r block=%r" % (rc, err[:200], nb[:600]))
# (A-c) Jira transitions only: the full rerun (JA2) closed by the breaker instead of SUMMARY
JSUM = "SUMMARY\tok=2\tskip=2\tfail=0\tunknown=0\trun_id=%s" % JRUN_ID


def jira_abort(name, reason):
    return mutate(JA2, name, JSUM, "ABORTED\trun_id=%s\tat=jira\tok=2\tskip=2\tfail=0\tunknown=0\tunattempted=0\treason=%s"
                  % (JRUN_ID, reason))


jver_inc = write("jv-inc.out", [x for x in Path(JVER).read_text(encoding="utf-8").rstrip("\n").split("\n")
                                if not x.startswith("VERIFY-SUMMARY")]
                 + ["VERIFY\tINCOMPLETE\trun\t%s\tapply stopped at jira" % JRUN_ID,
                    "VERIFY-SUMMARY\tfail=0\twarn=0\tunresolved=1\trun=incomplete\tsuccess=no"])
rc, err, pc2 = run(JPLAN, [JA1, jira_abort("ja2-brk.out", BRK)], jver_inc)
nb = next_block(pc2 or "")
check("18e [A-c] breaker run with jira-transition rows only (no move rows): no command, the breaker paragraph",
      rc == 0 and 'id="next-cmd"' not in (pc2 or "")
      and nb.startswith('id="s-next" class="group">다음 할 일</h3>\n<p id="next-breaker">%s</p>' % X_BREAKER),
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:400]))
NONBRK = "Jira 읽기 실패 — 잠시 뒤 같은 명령으로 다시 실행"
rc, err, pd2 = run(JPLAN, [JA1, jira_abort("ja2-read.out", NONBRK)], jver_inc)
check("18f [A-d] jira-transition rows only, last run ABORTED with a non-breaker reason → the command as before",
      rc == 0 and 'id="next-cmd"' in (pd2 or "") and 'id="next-breaker"' not in (pd2 or ""), "rc=%s err=%r" % (rc, err[:200]))
rc, err, pe2 = breaker_case("nonbrk", [M5_ROW, NA_ROW], reason=NONBRK)
nb = next_block(pe2 or "")
check("18g [A-d] the same move rows, last run ABORTED with a non-breaker reason → the command as before (#162 is a rerun row)",
      rc == 0 and 'id="next-cmd"' in nb and 'id="next-breaker"' not in nb and 'id="next-rerun"' not in nb,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:400]))
# (A-e) an earlier run hit the breaker, a later full run (SUMMARY) ends the cause row OK → cleared, today's rule (command)
for tag_, r161, v161, cleared in (
        ("cause row OK in the later run", ("OK", 161, "moved: %s — 이미 만든 티켓으로 이슈를 닫음" % K(161)),
         "VERIFY\tOK\tmove-issue\tissue#161\t%s — 옮김" % K(161), True),
        ("later run's results on other rows only", None, "VERIFY\tFAIL\tmove-issue\tissue#161\t%s" % M5_ROW[2][1], False)):
    plan_e, pdir_e, res_e = mv_scenario("brk-earlier-%d" % cleared, {161: {}, 162: {}},
                                        [("ABORTED", A1M, [("SKIP", 161, M5_ROW[1][1]), ("NOT-ATTEMPTED", 162, "run aborted at jira")], BRK),
                                         ("SUMMARY", A2M, ([r161] if r161 else []) + [("FAIL", 162, "close-failed: %s — 이슈를 닫지 못함" % K(162))])])
    rc, err, pf2 = mv_run(plan_e, pdir_e, res_e, mv_verify("brk-earlier-v%d.out" % cleared, [
        v161, "VERIFY\tUNRESOLVED\tmove-issue\tissue#162\t%s — 티켓 만듦, 이슈 닫지 않음: 이슈를 닫지 못함" % K(162)] + MV_PINV))
    nb = next_block(pf2 or "")
    check("18h%s [A-e / R5b] the breaker in an earlier run, then a full SUMMARY run with %s → %s"
          % ("" if cleared else "2", tag_, "cleared: the command" if cleared else "still on: no command, cause #161"),
          rc == 0 and (('id="next-cmd"' in nb and 'id="next-breaker"' not in nb) if cleared else
                       ('id="next-cmd"' not in nb and 'id="next-breaker"' in nb and '/issues/161">' in section(nb, "next-cause", "</p>"))),
          "rc=%s err=%r block=%r" % (rc, err[:200], nb[:400]))
# (A-f) an M20 row plus the breaker → the M20 stop paragraph only
rc, err, pg2 = breaker_case("brk-m20", [(164, ("SKIP", "manual: %s — %s" % (K(164), M20)), ("UNRESOLVED", "다른 확인 문구")), NA_ROW])
nb = next_block(pg2 or "")
check("18i [A-f] an M20 row and the breaker → the existing M20 stop paragraph only (no breaker paragraph, no command)",
      rc == 0 and 'id="next-stop"' in nb and '/issues/164">' in section(nb, "next-stop", "</p>")
      and 'id="next-breaker"' not in nb and 'id="next-cmd"' not in nb, "rc=%s err=%r block=%r" % (rc, err[:200], nb[:400]))

# ── 19. trinity R4: the breaker survives runs that skipped the Jira stage; the cause row; a last-result M20 row stops ──
A1R, A2R, A3R = "20261026T010000Z-c1c1c1c1", "20261026T020000Z-c2c2c2c2", "20261026T030000Z-c3c3c3c3"
M5_171 = ("SKIP", 171, "manual: %s — 티켓 내용이 승인본과 다름 — 닫지 않음" % K(171))
V171 = "VERIFY\tFAIL\tmove-issue\tissue#171\t%s — 티켓이 안 보이거나 내용이 승인본과 다름: 설명이 다름" % K(171)
V172 = "VERIFY\tUNRESOLVED\tmove-issue\tissue#172\t" + NA_VERIFY


def r4_case(tag, runs, extra_runs=(), vlines=(V171, V172), incomplete=False):
    """move rows 171/172; runs = mv_scenario runs (with ABORTED reasons); extra_runs = literal result-file lines appended
    as further runs (an only-group run has no Jira rows) → (rc, err, page)."""
    plan, pdir, res = mv_scenario(tag, {171: {}, 172: {}}, runs)
    res = list(res) + [write("mv-%s-x%d.out" % (tag, i), lines) for i, lines in enumerate(extra_runs)]
    return mv_run(plan, pdir, res, mv_verify("mv-%s-v.out" % tag, list(vlines) + MV_PINV, run_id=JRUN_ID if incomplete else None))


RUN_A = ("ABORTED", A1R, [M5_171, ("NOT-ATTEMPTED", 172, "run aborted at jira")], BRK)
ONLY_GROUP_B = ["SUMMARY\tok=0\tskip=0\tfail=0\tunknown=0\trun_id=%s\tattempt=%s\tscope=only-group\tjournal=/j" % (JRUN_ID, A2R)]
rc, err, ra = r4_case("r4a", [RUN_A], [ONLY_GROUP_B])
nb = next_block(ra or "")
check("19a [R4-a] breaker run, then an --only-group SUMMARY with no Jira result: still the breaker — no command, new head, cause "
      "line #171 with its cause reason (M5), #172 on 원인을 고친 뒤 다시 실행할 행, #171 in no list",
      rc == 0 and 'id="next-cmd"' not in (ra or "")
      and nb.startswith('id="s-next" class="group">다음 할 일</h3>\n<p id="next-breaker">%s</p>\n' % X_BREAKER)
      and X_BREAKER.startswith("Jira 단계가 차단기로 멈춘 뒤, 원인 행이 성공(OK)으로 끝난 실행이 아직 없습니다 — ")
      and re.search(r'<p id="next-cause">%s</p>' % cause_re(171, K(171), "티켓 내용이 승인본과 다름 — 닫지 않음"), nb) is not None
      and re.search(r'<p id="next-rerun">원인을 고친 뒤 다시 실행할 행: <a href="[^"]*/issues/172">이슈 #172</a></p>', nb) is not None
      and nb.count('/issues/171">') == 1 and 'id="next-later"' not in nb and "차단기로 멈춘 실행의 오류 출력" in nb, "rc=%s err=%r block=%r" % (rc, err[:200], nb[:800]))
rc, err, rb = r4_case("r4b", [RUN_A, ("ABORTED", A2R, [("NOT-ATTEMPTED", 171, "run aborted at close"),
                                                       ("NOT-ATTEMPTED", 172, "run aborted at close")], "push failed: connection reset")],
                      incomplete=True)
nb = next_block(rb or "")
check("19b [R4-b] breaker run, then a full run that stopped before Jira (rows NOT-ATTEMPTED run aborted at close, non-breaker "
      "reason): still the breaker, cause #171 from the first run",
      rc == 0 and 'id="next-cmd"' not in (rb or "") and 'id="next-breaker"' in nb
      and re.search(r'<p id="next-cause">차단기 원인 행: <a href="[^"]*/issues/171">이슈 #171</a> — ', nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:600]))
V172F = "VERIFY\tUNRESOLVED\tmove-issue\tissue#172\t%s — 티켓 만듦, 이슈 닫지 않음: 이슈를 닫지 못함" % K(172)
F172 = ("FAIL", 172, "close-failed: %s — 이슈를 닫지 못함" % K(172))
rc, err, rc_ = r4_case("r4c", [RUN_A, ("SUMMARY", A2R, [("OK", 171, "already-done: %s — 이미 닫혀 있고 이관 댓글 있음" % K(171)), F172])],
                       vlines=("VERIFY\tOK\tmove-issue\tissue#171\t%s — 옮김" % K(171), V172F))
nb = next_block(rc_ or "")
check("19c [R4-c / R5b] breaker run, then a full SUMMARY where the cause row ends OK: no breaker — the command",
      rc == 0 and 'id="next-cmd"' in nb and 'id="next-breaker"' not in nb and 'id="next-cause"' not in nb,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:400]))
rc, err, rc2 = r4_case("r4c2", [RUN_A, ("SUMMARY", A2R, [F172])], vlines=(V171, V172F))
nb = next_block(rc2 or "")
check("19c2 [R5b] breaker run, then a full SUMMARY whose move results are on other rows only: still on — no command, cause #171",
      rc == 0 and 'id="next-cmd"' not in (rc2 or "") and 'id="next-breaker"' in nb
      and '/issues/171">' in section(nb, "next-cause", "</p>"), "rc=%s err=%r block=%r" % (rc, err[:200], nb[:400]))
rc, err, rd = r4_case("r4d", [RUN_A, ("ABORTED", A2R, [("UNKNOWN", 171, "%s — 댓글 결과 모름 — 다음 실행이 확인" % K(171)),
                                                       ("NOT-ATTEMPTED", 172, "run aborted at jira")], "Jira 단계 오류: exit 1")],
                     incomplete=True)
nb = next_block(rd or "")
check("19d [R4-d / R5b] breaker run, then a full run ABORTED during Jira (non-breaker reason) where the helper itself answered "
      "the cause row UNKNOWN (not OK): still on — no command, the cause line still names #171",
      rc == 0 and 'id="next-cmd"' not in (rd or "") and 'id="next-breaker"' in nb
      and re.search(r'<p id="next-cause">%s</p>' % cause_re(171, K(171), "티켓 내용이 승인본과 다름 — 닫지 않음"), nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# (e) a row OK already-done in run 1, SKIP manual M20 in run 2, verify row 3: its exit stays MOVE_ROW3_DONE, but it stops the plan
rc, err, re_ = r4_case("r4e", [("SUMMARY", A1R, [("OK", 171, "already-done: %s — 이미 닫혀 있고 이관 댓글 있음" % K(171))]),
                               ("SUMMARY", A2R, [("SKIP", 171, "manual: %s — %s" % (K(171), M20)),
                                                 ("FAIL", 172, "close-failed: %s — 이슈를 닫지 못함" % K(172))])],
                       vlines=(V171, "VERIFY\tUNRESOLVED\tmove-issue\tissue#172\t%s — 티켓 만듦, 이슈 닫지 않음: 이슈를 닫지 못함" % K(172)))
nb = next_block(re_ or "")
check("19e [R4-e] OK already-done then SKIP manual M20, verify row 3: the M20 stop paragraph names it (no command); its exit cell "
      "is still MOVE_ROW3_DONE",
      rc == 0 and 'id="next-cmd"' not in (re_ or "") and '/issues/171">' in section(nb, "next-stop", "</p>")
      and '/issues/172">' not in section(nb, "next-stop", "</p>") and exits_of(re_ or "").get(171) == X_ROW3_DONE,
      "rc=%s err=%r exit=%r block=%r" % (rc, err[:200], exits_of(re_ or "").get(171), nb[:400]))
# (f) a jira-transition cause row (FAIL changed-after-comment, the last Jira result of the breaker run), no move rows
ja2_f = mutate(mutate(JA2, "ja2-f1.out", "RESULT\tSKIP\tjira-transition\tjira#TST-106\tchanged: 승인 뒤 상태가 바뀜 (지금 In Progress)",
                      "RESULT\tFAIL\tjira-transition\tjira#TST-106\tchanged-after-comment: 댓글을 단 뒤 상태가 바뀜"),
               "ja2-f2.out", JSUM, "ABORTED\trun_id=%s\tat=jira\tok=2\tskip=1\tfail=1\tunknown=0\tunattempted=0\treason=%s" % (JRUN_ID, BRK))
rc, err, rf = run(JPLAN, [JA1, ja2_f], jver_inc)
nb = next_block(rf or "")
check("19f [R4-f] jira-transition cause row (FAIL changed-after-comment), no move rows: the breaker paragraph + the cause line in "
      "the report's own wording for that result",
      rc == 0 and 'id="next-cmd"' not in (rf or "") and 'id="next-breaker"' in nb
      and re.search(r'<p id="next-cause">차단기 원인 행: <a href="https://example\.atlassian\.net/browse/TST-106">TST-106</a> — '
                    r'멈출 때 사유: 댓글을 단 뒤 다른 변경이 생김: 댓글을 단 뒤 상태가 바뀜</p>', nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:600]))

# ── 20. trinity R5: a breaker cause clears only when a later run's helper answered THAT row; chore.sh fills never count ──
B1, B2, B3 = "20261026T040000Z-d1d1d1d1", "20261026T050000Z-d2d2d2d2", "20261026T060000Z-d3d3d3d3"
OK181 = ("OK", 181, "moved: %s — 티켓을 만들고 이슈를 닫음" % K(181))
OK181B = ("OK", 181, "already-done: %s — 이미 닫혀 있고 이관 댓글 있음" % K(181))
M5_182 = ("SKIP", 182, "manual: %s — 티켓 내용이 승인본과 다름 — 닫지 않음" % K(182))
VOK181 = "VERIFY\tOK\tmove-issue\tissue#181\t%s — 옮김" % K(181)
V182 = "VERIFY\tFAIL\tmove-issue\tissue#182\t%s — 티켓이 안 보이거나 내용이 승인본과 다름: 설명이 다름" % K(182)
V18X = "VERIFY\tUNRESOLVED\tmove-issue\tissue#%d\t" + NA_VERIFY


def r5_case(tag, rows, runs, vlines, incomplete):
    plan, pdir, res = mv_scenario(tag, {k: {} for k in rows}, runs)
    return mv_run(plan, pdir, res, mv_verify("mv-%s-v.out" % tag, list(vlines) + MV_PINV, run_id=JRUN_ID if incomplete else None))


def cause_lines(nb):
    """→ issue numbers named by the cause line(s), in order."""
    return [int(x) for x in re.findall(r'차단기 원인 행: <a href="[^"]*/issues/([0-9]+)">', nb)]


# (a) gpt-6-astra R4: run A — 181 OK, 182 M5 breaker, 183 not attempted; run B (cause not fixed) — 181 OK already-done, then B
# stops (non-breaker reason) before 182; 182 / 183 NOT-ATTEMPTED → still the breaker
rc, err, qa = r5_case("r5a", (181, 182, 183),
                      [("ABORTED", B1, [OK181, M5_182, ("NOT-ATTEMPTED", 183, "run aborted at jira")], BRK),
                       ("ABORTED", B2, [OK181B, ("NOT-ATTEMPTED", 182, "run aborted at jira"), ("NOT-ATTEMPTED", 183, "run aborted at jira")],
                        "Jira 읽기 실패 — 잠시 뒤 같은 명령으로 다시 실행")],
                      (VOK181, V182, V18X % 183), True)
nb = next_block(qa or "")
check("20a [R5-a] breaker on #182, a later run answers #181 only and stops before #182: still the breaker, cause #182, no command",
      rc == 0 and 'id="next-cmd"' not in (qa or "") and 'id="next-breaker"' in nb and cause_lines(nb) == [182]
      and re.search(r'<p id="next-cause">%s</p>' % cause_re(182, K(182), "티켓 내용이 승인본과 다름 — 닫지 않음"), nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:600]))
# (b) the later run reprocesses #182 (OK moved) and ends SUMMARY → off, the command per rows (#183 close failed = rerun)
rc, err, qb = r5_case("r5b", (181, 182, 183),
                      [("ABORTED", B1, [OK181, M5_182, ("NOT-ATTEMPTED", 183, "run aborted at jira")], BRK),
                       ("SUMMARY", B2, [OK181B, ("OK", 182, "moved: %s — 이미 만든 티켓으로 이슈를 닫음" % K(182)),
                                        ("FAIL", 183, "close-failed: %s — 이슈를 닫지 못함" % K(183))])],
                      (VOK181, "VERIFY\tOK\tmove-issue\tissue#182\t%s — 옮김" % K(182),
                       "VERIFY\tUNRESOLVED\tmove-issue\tissue#183\t%s — 티켓 만듦, 이슈 닫지 않음: 이슈를 닫지 못함" % K(183)), False)
nb = next_block(qb or "")
check("20b [R5-b] the later run reprocesses the cause row (#182 OK moved) and ends SUMMARY: breaker off, the command",
      rc == 0 and 'id="next-cmd"' in nb and 'id="next-breaker"' not in nb and cause_lines(nb) == [],
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:400]))
# (c) the later run stops with an unreadable journal after #181: chore.sh fills #182 / #183 with the 'journal unreadable' UNKNOWN
rc, err, qc = r5_case("r5c", (181, 182, 183),
                      [("ABORTED", B1, [OK181, M5_182, ("NOT-ATTEMPTED", 183, "run aborted at jira")], BRK),
                       ("ABORTED", B2, [OK181B, ("UNKNOWN", 182, ABORT_UNREAD), ("UNKNOWN", 183, ABORT_UNREAD)], "Jira 단계 오류: exit 1")],
                      (VOK181, V182, V18X % 183), True)
nb = next_block(qc or "")
check("20c [R5-c] a later 'journal unreadable at abort' UNKNOWN fill on the cause row is not reprocessing: still on, cause #182",
      rc == 0 and 'id="next-cmd"' not in (qc or "") and cause_lines(nb) == [182], "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# (d) a breaker run whose journal was unreadable: #182 answered (the cause), #183 an UNKNOWN fill after it
rc, err, qd = r5_case("r5d", (181, 182, 183), [("ABORTED", B1, [OK181, M5_182, ("UNKNOWN", 183, ABORT_UNREAD)], BRK)],
                      (VOK181, V182, V18X % 183), True)
nb = next_block(qd or "")
check("20d [R5-d] breaker run with an unreadable journal: the cause line names the answered row #182, not the fill row #183",
      rc == 0 and cause_lines(nb) == [182] and 'id="next-cmd"' not in (qd or ""), "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# (e) two breakers: A on #182; B passes #182 (OK moved) and breaks on #185 → only #185 is a cause
rc, err, qe = r5_case("r5e", (181, 182, 185),
                      [("ABORTED", B1, [OK181, M5_182, ("NOT-ATTEMPTED", 185, "run aborted at jira")], BRK),
                       ("ABORTED", B2, [OK181B, ("OK", 182, "moved: %s — 이미 만든 티켓으로 이슈를 닫음" % K(182)),
                                        ("SKIP", 185, "manual: %s — %s" % (K(185), M19))], BRK)],
                      (VOK181, "VERIFY\tOK\tmove-issue\tissue#182\t%s — 옮김" % K(182),
                       "VERIFY\tUNRESOLVED\tmove-issue\tissue#185\t%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(185), M19)), True)
nb = next_block(qe or "")
check("20e [R5-e] two breakers, the second run passed the first cause (#182 OK) and broke on #185: only #185 is a cause",
      rc == 0 and cause_lines(nb) == [185] and re.search(r'<p id="next-cause">%s</p>' % cause_re(185, K(185), M19), nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# (g) two unresolved causes: A broke on #185 (after #182 SKIP M9); B broke on #182 before reaching #185 (#185 NOT-ATTEMPTED)
rc, err, qg = r5_case("r5g", (181, 182, 185),
                      [("ABORTED", B1, [OK181, ("SKIP", 182, "manual: %s — 누가 먼저 닫음 — 연결 기록 필요" % K(182)),
                                        ("SKIP", 185, "manual: %s — 티켓 내용이 승인본과 다름 — 닫지 않음" % K(185))], BRK),
                       ("ABORTED", B2, [OK181B, ("SKIP", 182, "manual: %s — %s" % (K(182), M19)),
                                        ("NOT-ATTEMPTED", 185, "run aborted at jira")], BRK)],
                      (VOK181, "VERIFY\tUNRESOLVED\tmove-issue\tissue#182\t%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(182), M19),
                       "VERIFY\tFAIL\tmove-issue\tissue#185\t%s — 티켓이 안 보이거나 내용이 승인본과 다름: 설명이 다름" % K(185)), True)
nb = next_block(qg or "")
check("20g [R5-C] two unresolved causes: one <ul id=\"next-cause\"> with an <li> each, in breaker order (#185 then #182); "
      "neither row in the do-first / rerun / later / owner lists",
      rc == 0 and re.search(r'<ul class="hist" id="next-cause"><li>%s</li><li>%s</li></ul>'
                            % (cause_re(185, K(185), "티켓 내용이 승인본과 다름 — 닫지 않음"), cause_re(182, K(182), M19)), nb) is not None
      and nb.count('/issues/185">') == 1 and nb.count('/issues/182">') == 1 and 'id="next-cmd"' not in (qg or ""),
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:800]))
# (h) a breaker run with no answered result (the helper's output was lost — only chore.sh fills): the cause is not identifiable
rc, err, qh = r5_case("r5h", (181, 182), [("ABORTED", B1, [("UNKNOWN", 181, ABORT_UNREAD), ("NOT-ATTEMPTED", 182, "run aborted at jira")], BRK),
                                           ("SUMMARY", B2, [("OK", 182, "moved: %s — 티켓을 만들고 이슈를 닫음" % K(182))])],
                      ("VERIFY\tUNRESOLVED\tmove-issue\tissue#181\t확인 필요: " + ABORT_UNREAD,
                       "VERIFY\tOK\tmove-issue\tissue#182\t%s — 옮김" % K(182)), False)
nb = next_block(qh or "")
check("20h [R5b] breaker run with no answered result, then a run with OK on another row: still on — the marker-only head, no "
      "separate cause line, no command",
      rc == 0 and 'id="next-cmd"' not in (qh or "")
      and nb.startswith('id="s-next" class="group">다음 할 일</h3>\n<p id="next-breaker">%s</p>\n' % X_BREAKER_UNKNOWN)
      and 'id="next-cause' not in nb, "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))

# ── 21. R5b: only an OK result of the cause row clears it; the unknown-cause marker never clears ──
V172ACC = "VERIFY\tRESOLVED\tmove-issue\tissue#172\t만든 것 없음 — 계정이 승인 때와 다름"
rc, err, sa = r4_case("r5b-acc", [RUN_A, ("SUMMARY", A2R, [("SKIP", 171, "account: Jira 계정 또는 GitHub 로그인이 승인 때와 다름"),
                                                           ("SKIP", 172, "account: Jira 계정 또는 GitHub 로그인이 승인 때와 다름")])],
                      vlines=(V171, V172ACC))
nb = next_block(sa or "")
check("21a [R5b] breaker on #171, then a full run with the wrong account (every row SKIP account, before any breaker check): still "
      "on — no command, the cause line names #171 with the reason at the stop",
      rc == 0 and 'id="next-cmd"' not in (sa or "") and 'id="next-breaker"' in nb
      and re.search(r'<p id="next-cause">%s</p>' % cause_re(171, K(171), "티켓 내용이 승인본과 다름 — 닫지 않음"), nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
rc, err, sb = r4_case("r5b-cf", [RUN_A, ("SUMMARY", A2R, [("FAIL", 171, "comment-failed: %s — 댓글이 게시됐을 수 있음 — 추가 재게시 없이 "
                                                                       "미결로 중단" % K(171)), F172])], vlines=(V171, V172F))
nb = next_block(sb or "")
check("21b [R5b] breaker on #171, then a later FAIL comment-failed on #171: still on — no command, cause #171",
      rc == 0 and 'id="next-cmd"' not in (sb or "") and 'id="next-breaker"' in nb and cause_lines(nb) == [171],
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:500]))
# identified causes AND the marker: normal head, the cause line, plus the 결과에서 찾지 못함 line
rc, err, sc = r5_case("r5b-both", (181, 182),
                      [("ABORTED", B1, [("UNKNOWN", 181, ABORT_UNREAD), ("NOT-ATTEMPTED", 182, "run aborted at jira")], BRK),
                       ("ABORTED", B2, [("OK", 181, "moved: %s — 티켓을 만들고 이슈를 닫음" % K(181)), M5_182], BRK)],
                      (VOK181, V182), True)
nb = next_block(sc or "")
check("21c [R5b] an unidentified breaker, then an identified one (#182): the normal head, the #182 cause line, then the "
      "결과에서 찾지 못함 line",
      rc == 0 and nb.startswith('id="s-next" class="group">다음 할 일</h3>\n<p id="next-breaker">%s</p>\n' % X_BREAKER)
      and re.search(r'<p id="next-cause">%s</p>\n<p id="next-cause-unknown">%s</p>'
                    % (cause_re(182, K(182), "티켓 내용이 승인본과 다름 — 닫지 않음"), re.escape(X_CAUSE_UNKNOWN)), nb) is not None,
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:700]))
check("21d [R5b] an OK on another row does not clear the cause: 20a (later run has #181 OK, cause #182) stays on",
      cause_lines(next_block(qa or "")) == [182] and 'id="next-cmd"' not in (qa or ""), "")

# the same row stops the Jira stage twice (rerun without fixing it): one cause line, the latest stop's reason
rc, err, sd = r5_case("r5b-twice", (181, 182),
                      [("ABORTED", B1, [OK181, M5_182], BRK),
                       ("ABORTED", B2, [OK181B, ("SKIP", 182, "manual: %s — %s" % (K(182), M19))], BRK)],
                      (VOK181, "VERIFY\tUNRESOLVED\tmove-issue\tissue#182\t%s — 티켓 만듦, 이슈 닫지 않음: %s" % (K(182), M19)), True)
nb = next_block(sd or "")
check("21e [R5b] #182 is the breaker cause in run A (M5) and again in run B (M19): exactly one cause line, with B's reason",
      rc == 0 and cause_lines(nb) == [182] and 'id="next-cmd"' not in (sd or "")
      and re.search(r'<p id="next-cause">%s</p>' % cause_re(182, K(182), M19), nb) is not None
      and "티켓 내용이 승인본과 다름 — 닫지 않음" not in section(nb, "next-cause", "</p>"),
      "rc=%s err=%r block=%r" % (rc, err[:200], nb[:600]))

print("---- %d cases, %d failed, %d skipped" % (n, fail, skipped))
sys.exit(1 if fail else 0)
