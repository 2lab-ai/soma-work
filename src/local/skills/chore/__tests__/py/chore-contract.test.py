#!/usr/bin/env python3
"""chore-contract.test.py — the chore plan v4 contract (scripts/chore_plan.py) against fixtures/chore-v4/ (2026-10-19).

    python3 -I __tests__/py/chore-contract.test.py [path/to/chore_plan.py]   → exit 0 only when every case passes

valid.tsv and valid-units.tsv must parse into the row structures written out below; every invalid/<case>.tsv must raise
PlanError whose message contains expected.json[<case>.tsv], in-process and through the CLI (`chore_plan.py check`, exit 1
with one stderr line); penc/pdec, items/reqs, ledgers, Jira evidence, unit evidence and inventory codecs round-trip;
has_chore_marker finds a marker line however its ends are padded.
The same fixtures are the acceptance set for the engine's awk parser, the judge, the renderer and the report.
Stdlib only, no network, synthetic data. One ok/FAIL line per case.
"""
import copy
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent.parent / "scripts"   # <skill>/scripts — this file is <skill>/__tests__/py/
FIX = HERE.parent / "fixtures" / "chore-v4"
MOD = Path(sys.argv[1]) if len(sys.argv) > 1 else SCRIPTS / "chore_plan.py"
_spec = importlib.util.spec_from_file_location("chore_plan", MOD)
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

n = fail = 0


def ok(name):
    global n
    n += 1
    print("ok   %s" % name)


def bad(name, why):
    global n, fail
    n += 1
    fail += 1
    print("FAIL %s :: %s" % (name, why))


def check(name, cond, why=""):
    (ok if cond else lambda nm: bad(nm, why))(name)


def raises(fn, *a):
    """→ the PlanError message, or None when fn did not raise PlanError."""
    try:
        fn(*a)
    except P.PlanError as e:
        return str(e)
    return None


OA, OB, OE = "a" * 40, "b" * 40, "e" * 40
M12, C1 = "2" * 40, "3" * 40
ACCT = "712020:00000000-0000-0000-0000-000000000001"
VALID = (FIX / "valid.tsv").read_bytes()

# ── 1. valid.tsv parses into exactly these structures ──────────────────────────────────────────────
WANT_ROWS = [  # (line, tier, action, ref, expected)
    (2, 2, "delete-remote", "feat/login-form", OA),
    (3, 2, "close-pr", "pr#7", "c" * 40),
    (4, 2, "close-issue", "issue#9", "2026-08-01T00:00:00Z"),
    (5, 2, "jira-transition", "jira#TST-101", "2026-10-19T06:07:25.160+0900"),
    (6, 2, "jira-transition", "jira#TST-102", "2026-10-18T17:07:25.160-0500"),
    (7, 3, "report", "pr#8", OE),
    (8, 3, "report", "issue#10", "2026-10-11T00:00:00Z"),
    (9, 3, "report", "jira#TST-103", "-"),
    (10, 3, "report", "jira#TST-104", "-"),
    (11, 3, "report", "jira#TST", "-"),
]
WANT_QA = {
    "kind": "transition", "key": "TST-101", "project": "TST", "level": "TO-QA",
    "items": [{"id": "pr:12", "kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": M12},
              {"id": "pr:13", "kind": "pr", "pr": 13, "state": "CLOSED", "role": "superseded", "sha": None},
              {"id": "c:" + C1, "kind": "c", "pr": None, "state": None, "role": "required", "sha": C1}],
    "reqs": [{"text": "로그인 폼 입력값 검증 (이메일, 비밀번호)", "target": "pr:12"},
             {"text": "오류 문구: 한글로 통일 => 화면 확인; 100% 반영", "target": "c:" + C1}],
    "close_basis": None, "ledgers": [], "marker": "chore 정리 → QA (staging) — by Claude triage 2026-10-19"}
WANT_CL = {
    "kind": "transition", "key": "TST-102", "project": "TST", "level": "TO-CLOSED", "items": [], "reqs": [],
    "close_basis": {"type": "duplicate", "key": "TST-101", "pr": None}, "ledgers": [],
    "marker": "chore 정리 → Closed — by Claude triage 2026-10-19"}
WANT_QA_SNAP = {
    "site": "example.atlassian.net", "project": "TST", "issue_id": "10101", "status": "20001", "status_name": "개발 완료",
    "assignee": ACCT, "account": ACCT, "to": "31", "to_status": "20004", "to_name": "QA (staging)",
    "summary": "로그인 폼 검증 추가, 오류 문구 정리", "level": "TO-QA", "S": OB, "run": "9000000001",
    "run_url": "https://github.com/test/repo/actions/runs/9000000001",
    "items": "pr:12:MERGED:required:%s,pr:13:CLOSED:superseded:-,c:%s:required" % (M12, C1),
    "reqs": "로그인 폼 입력값 검증 (이메일%2C 비밀번호)=>pr:12,오류 문구%3A 한글로 통일 %3D> 화면 확인%3B 100%25 반영=>c:" + C1,
    "close_basis": "-", "ledgers": "-"}
WANT_AMB = {"v": "AMBIGUOUS", "reason": "PR #15는 합쳐졌지만 비밀번호 재설정 요구사항이 PR에 없습니다",
            "known": "PR #15 develop에 합쳐짐; staging 배포에 포함", "missing": "비밀번호 재설정이 다른 작업으로 옮겨졌는지",
            "owner": "author:alice", "decider": "기획 담당", "recommend": "요구사항을 나눌지 정해 주세요, 나누면 이 티켓을 QA로",
            "cites": "pr:15", "complete": "yes",
            "jira": [{"key": "TST-90", "status": "In Progress"}, {"key": "TST-91", "status": "Done: 확인, 보류"}]}
WANT_EXC = {"v": "EXCLUDED", "reason": "보류 상태(jira-hold)라 판정하지 않음", "known": "", "missing": "", "owner": "",
            "decider": "", "recommend": "", "cites": "", "complete": "", "jira": []}
WANT_INV = {"kind": "inventory", "project": "TST", "total": 4,
            "jql": "project = TST AND assignee = currentUser() AND statusCategory != Done ORDER BY key",
            "site": "example.atlassian.net"}

try:
    HDR, ROWS = P.parse_plan(VALID)
except P.PlanError as e:
    HDR, ROWS = None, []
    bad("1a valid.tsv parses", str(e))
if HDR is not None:
    ok("1a valid.tsv parses (%d rows)" % len(ROWS))
    got = [(r["line"], r["tier"], r["action"], r["ref"], r["expected"]) for r in ROWS]
    check("1b row line/tier/action/ref/expected", got == WANT_ROWS, "got %r" % got)
    check("1c header: remote, run_id, no_local, groups", (HDR["remote"], HDR["run_id"], HDR["no_local"], HDR["groups"])
          == ("test/repo", "20261015T051233Z-0a1b2c3d", "1", ["feat/*", "issues", "jira", "pull-requests"]), repr(HDR))
    by = {r["ref"]: r for r in ROWS}
    check("1d jira-transition TO-QA: row['jira'] structure", by["jira#TST-101"].get("jira") == WANT_QA,
          repr(by["jira#TST-101"].get("jira")))
    check("1e jira-transition TO-QA: snapshot = 19 decoded strings in plan order",
          list(by["jira#TST-101"]["snapshot"].items()) == list(WANT_QA_SNAP.items())
          and tuple(by["jira#TST-101"]["snapshot"]) == P.JIRA_SNAP_KEYS, repr(by["jira#TST-101"]["snapshot"]))
    check("1f jira-transition TO-QA: evidence = the comment text (decoded once), marker last",
          by["jira#TST-101"]["evidence"].split("\n")[-1] == WANT_QA["marker"]
          and by["jira#TST-101"]["evidence"].startswith("저장소 정리 중 확인했습니다."), by["jira#TST-101"]["evidence"][:80])
    check("1g jira-transition TO-CLOSED: row['jira'] structure", by["jira#TST-102"].get("jira") == WANT_CL,
          repr(by["jira#TST-102"].get("jira")))
    check("1h tier-3 jira#KEY AMBIGUOUS: evidence decoded twice (status names decoded a third time)",
          by["jira#TST-103"].get("jira") == {"kind": "unit", "key": "TST-103", "project": "TST", "summary": None,
                                             "status_name": None, "evidence": WANT_AMB},
          repr(by["jira#TST-103"].get("jira")))
    check("1i tier-3 jira#KEY EXCLUDED: empty values stay empty", by["jira#TST-104"].get("jira")
          == {"kind": "unit", "key": "TST-104", "project": "TST", "summary": None, "status_name": None, "evidence": WANT_EXC},
          repr(by["jira#TST-104"].get("jira")))
    check("1j tier-3 jira#PROJECT inventory", by["jira#TST"].get("jira") == WANT_INV, repr(by["jira#TST"].get("jira")))
    V3F = {"line", "tier", "action", "ref", "expected", "snapshot", "evidence"}
    check("1k non-Jira rows carry no 'jira' key and keep their v3 fields (+ title = None on close rows without title=)",
          all("jira" not in r and set(r) == (V3F | {"title"} if r["action"] in P.CLOSE_ACTIONS else V3F)
              and r.get("title") is None for r in ROWS if not r["ref"].startswith("jira#")),
          repr([sorted(r) for r in ROWS if not r["ref"].startswith("jira#")]))
    check("1l mixed offsets compare as instants: TST-102 (2026-10-18 …-0500) is 1 h after TST-101 (2026-10-19 …+0900)",
          (P.jira_time(by["jira#TST-102"]["expected"]) - P.jira_time(by["jira#TST-101"]["expected"])).total_seconds() == 3600
          and by["jira#TST-102"]["expected"] < by["jira#TST-101"]["expected"]
          and P.jira_time(by["jira#TST-101"]["expected"]) == datetime(2026, 10, 18, 21, 7, 25, 160000, timezone.utc), "")
    lines = VALID.split(b"\n")[1:-1]
    check("1m every snapshot column is canonical: encode_snapshot(parse_snapshot(col)) == col",
          all(P.encode_snapshot(P.parse_snapshot(ln.split(b"\t")[4], "t")) == ln.split(b"\t")[4] for ln in lines), "")
    v3 = b"\n".join([VALID.split(b"\n")[0]] + [ln for ln in lines if b"\tjira#" not in ln]) + b"\n"
    try:
        _, v3rows = P.parse_plan(v3)
        check("1n the same plan without Jira rows (a v3 plan) parses to the same non-Jira rows",
              [{k: v for k, v in r.items() if k != "line"} for r in v3rows]
              == [{k: v for k, v in r.items() if k != "line"} for r in ROWS if not r["ref"].startswith("jira#")], "")
    except P.PlanError as e:
        bad("1n v3 plan without Jira rows", str(e))
    BIND = dict(site="example.atlassian.net", project="TST", qa_status="20004", closed_status="20191")
    check("1o check_jira_binding accepts the bound site / project / jira-qa / jira-closed",
          raises(P.check_jira_binding, ROWS, *BIND.values()) is None, raises(P.check_jira_binding, ROWS, *BIND.values()))
    for nm, over, sub in (("project", {"project": "OTH"}, "is not in the bound Jira project OTH"),
                          ("site", {"site": "other.atlassian.net"}, "is not the bound site other.atlassian.net"),
                          ("jira-qa", {"qa_status": "10004"}, "TO-QA to_status 20004 is not the bound jira-qa 10004"),
                          ("jira-closed unbound", {"closed_status": None}, "is not the bound jira-closed (not bound)")):
        m = raises(P.check_jira_binding, ROWS, *dict(BIND, **over).values())
        check("1p check_jira_binding rejects another %s" % nm, m is not None and sub in m, repr(m))

# ── 2. every invalid fixture is refused with its expected message ──────────────────────────────────
expected = json.loads((FIX / "expected.json").read_text(encoding="utf-8"))
files = sorted(p.name for p in (FIX / "invalid").glob("*.tsv"))
check("2a expected.json names exactly the invalid/*.tsv files (%d)" % len(files), sorted(expected) == files,
      "only in expected.json: %s; only on disk: %s" % (sorted(set(expected) - set(files)), sorted(set(files) - set(expected))))
for name in files:
    data = (FIX / "invalid" / name).read_bytes()
    m = raises(P.parse_plan, data)
    if m is None:
        bad("2 %s" % name, "parsed (want PlanError containing %r)" % expected.get(name))
    elif expected.get(name) is None or expected[name] not in m:
        bad("2 %s" % name, "error %r lacks %r" % (m, expected.get(name)))
    else:
        ok("2 %s → %s" % (name, m))

# ── 3. penc / pdec ─────────────────────────────────────────────────────────────────────────────────
EDGE = ["%", ";", ",", "=", ":", "=>", " ", "\t", "\n", "\r", "\x01", "\x1f", "\x7f", "한글", "%25", "%3A", "a=>b,c:d;e%f",
        "줄1\n줄2\t탭 — 끝 %; ,=:", "‮­", "😀", "~!@#$^&*()_+-[]{}|\\'\"<>?/`"]
all_ascii = "".join(chr(i) for i in range(1, 128))
for sp in (False, True):
    bad_rt = [s for s in EDGE + [all_ascii] if P.pdec(P.penc(s, sp), "t", sp) != s]
    check("3a pdec(penc(s)) == s on edge strings and every ASCII byte (sp=%s)" % sp, not bad_rt, repr(bad_rt))
    esc = P.ESC_SP if sp else P.ESC
    enc = P.penc(all_ascii, sp)
    want = b"".join(b"%%%02X" % c if c in esc else bytes([c]) for c in all_ascii.encode())
    check("3b penc = exactly the bytes pdec requires encoded, uppercase %%XX, nothing else (sp=%s)" % sp, enc == want,
          repr(enc[:80]))
canon = [P.penc(s) for s in EDGE] + [b"plain", b"", "날것 UTF-8".encode(), b"100%25 %3B%2C%3D%3A %0A"]
check("3c penc(pdec(b)) == b on canonical bytes", all(P.penc(P.pdec(b, "t")) == b for b in canon),
      repr([b for b in canon if P.penc(P.pdec(b, "t")) != b]))
check("3d penc(' ') raw in a row value, %20 in a header value", P.penc(" ") == b" " and P.penc(" ", True) == b"%20", "")
m = raises(P.penc, "a\x00b")
check("3e penc refuses NUL (pdec accepts neither %00 nor a raw NUL)", m is not None and "NUL" in m, repr(m))
for raw, sub in ((b"%3a", "malformed percent-escape"), (b"%41", "non-canonical percent-escape"),
                 (b"a:b", "unencoded ':'"), (b"%EA%B8", "non-ASCII byte")):
    m = raises(P.pdec, raw, "t")
    check("3f pdec refuses %r (%s)" % (raw, sub), m is not None and sub in m, repr(m))

# ── 4. nested items / reqs / close_basis ───────────────────────────────────────────────────────────
ITEMS = [{"id": "pr:1", "kind": "pr", "pr": 1, "state": "OPEN", "role": "unrelated", "sha": None},
         {"id": "pr:22", "kind": "pr", "pr": 22, "state": "MERGED", "role": "required", "sha": M12},
         {"id": "c:" + C1, "kind": "c", "pr": None, "state": None, "role": "superseded", "sha": C1}]
txt = P.encode_items(ITEMS)
check("4a decode_items(encode_items(x)) == x", P.decode_items(txt) == ITEMS, repr(P.decode_items(txt)))
check("4b encode_items(decode_items(t)) == t, empty list = '-'",
      P.encode_items(P.decode_items(txt)) == txt and P.encode_items([]) == "-" and P.decode_items("-") == [], txt)
REQS = [{"text": t, "target": tg} for t, tg in (("a,b=c:d;e%f", "pr:22"), ("x=>y", "c:" + C1), ("줄1\n줄2", "pr:22"),
                                                 ("=>", "pr:1"), ("끝에 =", "pr:22"))]
rtxt = P.encode_reqs(REQS)
check("4c decode_reqs(encode_reqs(x)) == x on , = : ; %% => newline in the text", P.decode_reqs(rtxt) == REQS,
      repr(P.decode_reqs(rtxt)))
check("4d encode_reqs(decode_reqs(t)) == t, empty list = '-'",
      P.encode_reqs(P.decode_reqs(rtxt)) == rtxt and P.encode_reqs([]) == "-" and P.decode_reqs("-") == [], rtxt)
snap_rt = P.parse_snapshot(P.encode_snapshot({"items": txt, "reqs": rtxt}), "t")
check("4e items/reqs survive the snapshot layer (encode_snapshot → parse_snapshot → decode)",
      P.decode_items(snap_rt["items"]) == ITEMS and P.decode_reqs(snap_rt["reqs"]) == REQS, repr(snap_rt))
m = raises(P.encode_items, [{"kind": "pr", "pr": 3, "state": "MERGED", "role": "required", "sha": None}])
check("4f encode_items refuses what decode_items refuses (MERGED without a merge sha)",
      m is not None and "sha must be a lowercase 40-hex merge commit" in m, repr(m))
PRI = {"kind": "pr", "pr": 5, "state": "MERGED", "role": "required", "sha": M12}
CI = {"kind": "c", "sha": C1, "role": "required"}
for nm, it, sub in (("kind PR", dict(PRI, kind="PR"), "kind must be pr or c"), ("no kind", {"sha": C1, "role": "required"},
                    "kind must be pr or c"), ("pr True", dict(PRI, pr=True), "pr must be a positive int"),
                    ("pr 0", dict(PRI, pr=0), "pr must be a positive int"), ("pr '5'", dict(PRI, pr="5"), "pr must be a positive int"),
                    ("state merged", dict(PRI, state="merged"), "state must be one of"),
                    ("role req", dict(PRI, role="req"), "role must be one of"),
                    ("sha uppercase", dict(PRI, sha=M12.upper().replace("2", "A")), "sha must be a lowercase 40-hex"),
                    ("sha on OPEN", dict(PRI, state="OPEN"), "sha must be a lowercase 40-hex merge commit for MERGED, None"),
                    ("commit short sha", dict(CI, sha="abc"), "commit sha must be lowercase 40-hex"),
                    ("commit with pr", dict(CI, pr=5), "a commit item has no pr / state"),
                    ("unknown key", dict(PRI, url="x"), "must be a dict with keys from"),
                    ("id mismatch", dict(PRI, id="pr:6"), "does not round-trip"), ("not a dict", "pr:5", "must be a dict")):
    m = raises(P.encode_items, [it])
    check("4h encode_items refuses %s" % nm, m is not None and sub in m, repr(m))
m = raises(P.encode_items, "pr:5:MERGED:required:" + M12)
check("4h encode_items refuses a string instead of a list", m is not None and "must be a list" in m, repr(m))
for nm, rq, sub in (("empty text", {"text": "", "target": "pr:1"}, "req 0 must be"),
                    ("UNMET target", {"text": "x", "target": "UNMET"}, "req 0 must be"),
                    ("extra key", {"text": "x", "target": "pr:1", "n": 1}, "req 0 must be"),
                    ("int text", {"text": 5, "target": "pr:1"}, "req 0 must be")):
    m = raises(P.encode_reqs, [rq])
    check("4i encode_reqs refuses %s" % nm, m is not None and sub in m, repr(m))
for cb, want in (("duplicate:TST-1", {"type": "duplicate", "key": "TST-1", "pr": None}),
                 ("superseded:AB2-30", {"type": "superseded", "key": "AB2-30", "pr": None}),
                 ("superseded:pr:9", {"type": "superseded", "key": None, "pr": 9})):
    check("4g decode_close_basis(%s)" % cb, P.decode_close_basis(cb) == want, repr(P.decode_close_basis(cb)))

# ── 5. Jira evidence / inventory codecs ────────────────────────────────────────────────────────────
EV = {"v": "AMBIGUOUS", "reason": "r;=,:%\n끝", "known": "k=>v", "missing": "m%25", "owner": "author:bob-1",
      "decider": "QA 팀, 기획", "recommend": "a:b;c", "cites": "pr:1,c:abc", "complete": "no",
      "jira": [{"key": "AB-1", "status": "QA (staging)"}, {"key": "AB-22", "status": "x:y,z;%=>"}]}
raw = P.encode_jira_evidence(EV)
check("5a decode_jira_evidence(encode_jira_evidence(x)) == x", P.decode_jira_evidence(raw) == EV,
      repr(P.decode_jira_evidence(raw)))
check("5b encode_jira_evidence(decode_jira_evidence(b)) == b (canonical column bytes)",
      P.encode_jira_evidence(P.decode_jira_evidence(raw)) == raw, repr(raw[:120]))
check("5c the evidence column is canonical row bytes (pdec accepts it, no raw ; = , :)",
      raises(P.pdec, raw, "t") is None and not any(c in raw for c in b";=,:\t\n"), repr(raw[:120]))
m = raises(P.encode_jira_evidence, {"v": "CLOSE", "reason": "x"})
check("5d encode_jira_evidence refuses a CLOSE verdict (not a Jira verdict)", m is not None and "v must be one of" in m, repr(m))
m = raises(P.encode_jira_evidence, dict(copy.deepcopy(EV), decider=""))
check("5e encode_jira_evidence refuses AMBIGUOUS without decider", m is not None and "AMBIGUOUS" in m, repr(m))
for v in ("KEEP", "TO-QA", "TO-CLOSED", "NOT-JUDGED", "EXCLUDED"):
    e = {"v": v, "reason": "이유"}
    d = P.decode_jira_evidence(P.encode_jira_evidence(e))
    check("5f verdict %s round-trips with the other fields empty" % v,
          d == dict({k: "" for k in P.JIRA_EV_KEYS}, v=v, reason="이유", jira=[]), repr(d))
iraw = P.encode_inventory_evidence(17, 'project = "AB" AND x in (1,2) AND y ~ "a:b;c"', "x-1.example.com")
check("5g decode_inventory_evidence(encode_inventory_evidence(...)) round-trips",
      P.decode_inventory_evidence(iraw) == {"total": 17, "jql": 'project = "AB" AND x in (1,2) AND y ~ "a:b;c"',
                                            "site": "x-1.example.com"}, repr(P.decode_inventory_evidence(iraw)))
check("5h encode_inventory_evidence(0, …) is a legal empty inventory",
      P.decode_inventory_evidence(P.encode_inventory_evidence(0, "q", "a.b"))["total"] == 0, "")

# ── 6. jira_time ───────────────────────────────────────────────────────────────────────────────────
for s, good in (("2024-02-29T23:59:59.999+0900", True), ("2025-02-29T00:00:00.000+0900", False),
                ("2026-10-19T24:00:00.000+0900", False), ("2026-10-19T06:07:25.160+2400", False),
                ("2026-10-19T06:07:25.160Z", False), ("2026-10-19T06:07:25.16+0900", False),
                ("2026-10-19T06:07:25.160+09:00", False), ("２０２６-10-19T06:07:25.160+0900", False)):
    check("6 jira_time(%s) %s" % (s, "accepts" if good else "refuses"), (P.jira_time(s) is not None) == good, "")

# ── 7. tier-3 pr#N / issue#N structured evidence (valid-units.tsv) ─────────────────────────────────
F1 = "f" * 40
WANT_UNITS = {
    "pr#21": {"kind": "pr", "number": 21, "evidence": {
        "t": "검색창 자동완성 실험", "v": "AMBIGUOUS", "reason": "기능 플래그 뒤에 있어 아직 쓰이는지 알 수 없습니다",
        "known": "마지막 커밋 2026-07-01; develop과 충돌 없음", "missing": "실험을 계속할지", "owner": "author:dave",
        "decider": "검색 기능 담당", "recommend": "계속하지 않으면 닫으세요, 계속하면 TST-77에 연결", "cites": "pr:21",
        "complete": "yes", "jira": [{"key": "TST-77", "status": "In Progress"}]}},
    "issue#22": {"kind": "issue", "number": 22, "evidence": dict(
        {k: "" for k in P.UNIT_EV_KEYS}, t="로그아웃 후 세션이 남는 문제", v="KEEP",
        reason="재현 절차가 있고 아직 해결 PR이 없습니다", cites="issue#22", complete="yes", jira=[])},
    "pr#23": {"kind": "pr", "number": 23, "evidence": dict(
        {k: "" for k in P.UNIT_EV_KEYS}, t="업로드 진행률 표시", v="NOT-JUDGED", reason="최근 30일 안에 갱신 — 판정 제외",
        jira=[])},
}
UNITS = (FIX / "valid-units.tsv").read_bytes()
try:
    _, UROWS = P.parse_plan(UNITS)
    ok("7a valid-units.tsv parses (%d rows)" % len(UROWS))
except P.PlanError as e:
    UROWS = []
    bad("7a valid-units.tsv parses", str(e))
ub = {r["ref"]: r for r in UROWS}
for ref, want in WANT_UNITS.items():
    got = ub.get(ref, {}).get("unit")
    check("7b %s structured evidence → row['unit']" % ref, got == want, repr(got))
check("7c plain title row pr#24 keeps evidence as the title, no 'unit' key",
      "pr#24" in ub and "unit" not in ub["pr#24"] and ub["pr#24"]["evidence"] == "로그인 화면 문구 정리", repr(ub.get("pr#24")))
check("7d no unit row carries a 'jira' key", all("jira" not in r for r in UROWS), "")
ulines = UNITS.split(b"\n")[1:-1]
check("7e encode_unit_evidence(decode_unit_evidence(col)) == col on every structured row",
      all(P.encode_unit_evidence(P.decode_unit_evidence(ln.split(b"\t")[5])) == ln.split(b"\t")[5]
          for ln in ulines[:3]), "")
UEV = dict(WANT_UNITS["pr#21"]["evidence"], t="제목; =, : % => 끝", reason="a:b,c;d")
check("7f decode_unit_evidence(encode_unit_evidence(x)) == x on , = : ; %% => in title and reason",
      P.decode_unit_evidence(P.encode_unit_evidence(UEV)) == UEV, repr(P.decode_unit_evidence(P.encode_unit_evidence(UEV))))
for v in ("CLOSE", "EXCLUDED", "TO-QA", "TO-CLOSED"):
    m = raises(P.encode_unit_evidence, {"t": "x", "v": v, "reason": "r"})
    check("7g encode_unit_evidence refuses v=%s" % v, m is not None and "unit evidence v must be one of" in m, repr(m))
UHDR = UNITS.split(b"\n")[0]
UROW = b"3\treport\tpr#30\t" + b"6" * 40 + b"\t-\t"
FORGED = "t=x;v=KEEP;reason=r;known=;missing=;owner=;decider=;recommend=;cites=;complete=;jira="
for title in ("t=abc", "t=a;v=b", FORGED, "제목;v=KEEP", P.encode_unit_evidence({"t": "x", "v": "KEEP", "reason": "r"}).decode()):
    try:
        _, rr = P.parse_plan(UHDR + b"\n" + UROW + P.penc(title) + b"\n")
        check("7h title %r without snapshot verdict= is always plain" % title[:40],
              "unit" not in rr[0] and rr[0]["evidence"] == title, repr(rr[0]))
    except P.PlanError as e:
        bad("7h plain title %r" % title, str(e))
check("7i no content-based detection left (is_unit_evidence removed)", not hasattr(P, "is_unit_evidence"), "")
check("7j valid-units.tsv: structured rows end their snapshot with verdict = evidence v; the plain row has no verdict",
      all(list(r["snapshot"])[-1] == "verdict" and r["snapshot"]["verdict"] == r["unit"]["evidence"]["v"]
          for r in UROWS if "unit" in r) and "verdict" not in ub.get("pr#24", {}).get("snapshot", {"verdict": 1}), "")

# ── 8. CLI: python3 -I chore_plan.py check <plan.tsv> [--site S --project P --qa ID --closed ID] ─────
import subprocess


def cli(*args):
    r = subprocess.run([sys.executable, "-I", str(MOD), *args], capture_output=True)
    return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace")


VALIDS = sorted(p.name for p in FIX.glob("valid*.tsv"))
for f in VALIDS:
    rc, out, err = cli("check", str(FIX / f))
    check("8a check %s → exit 0, no output" % f, (rc, out, err) == (0, b"", ""), "rc=%s out=%r err=%r" % (rc, out, err))
BARGS = ["--site", "example.atlassian.net", "--project", "TST", "--qa", "20004", "--closed", "20191"]
rc, out, err = cli("check", str(FIX / "valid.tsv"), *BARGS)
check("8b check valid.tsv with the matching binding → exit 0, no output", (rc, out, err) == (0, b"", ""),
      "rc=%s out=%r err=%r" % (rc, out, err))
for nm, args, sub in (("jira-qa", BARGS[:5] + ["10004"] + BARGS[6:], "TO-QA to_status 20004 is not the bound jira-qa 10004"),
                      ("project", BARGS[:3] + ["OTH"] + BARGS[4:], "is not in the bound Jira project OTH"),
                      ("unbound jira-closed", BARGS[:6], "is not the bound jira-closed (not bound)")):
    rc, out, err = cli("check", str(FIX / "valid.tsv"), *args)
    check("8c check valid.tsv with another %s → exit 1, one stderr line" % nm,
          rc == 1 and out == b"" and err.count("\n") == 1 and err.startswith("chore_plan: ") and sub in err,
          "rc=%s err=%r" % (rc, err))
cli_bad = []
for name in files:
    rc, out, err = cli("check", str(FIX / "invalid" / name))
    if not (rc == 1 and out == b"" and err.endswith("\n") and err.count("\n") == 1 and err.startswith("chore_plan: ")
            and expected.get(name, "\0") in err):
        cli_bad.append("%s rc=%s err=%r" % (name, rc, err[:120]))
check("8d check invalid/*.tsv (%d) → exit 1, exactly one stderr line 'chore_plan: <expected message>'" % len(files),
      not cli_bad, "; ".join(cli_bad[:3]))
rc, out, err = cli("check", str(FIX / "no-such-plan.tsv"))
check("8e check on a missing file → exit 1, one stderr line", rc == 1 and err.count("\n") == 1
      and err.startswith("chore_plan: cannot read plan"), "rc=%s err=%r" % (rc, err))
for args in ((), ("check",), ("lint", str(FIX / "valid.tsv")), ("check", str(FIX / "valid.tsv"), "--site", "x.y"),
             ("check", str(FIX / "valid.tsv"), "--qa", "1"), ("check", str(FIX / "valid.tsv"), "--sit", "x.y", "--project", "P")):
    rc, out, err = cli(*args)
    check("8f usage error %r → exit 2" % (args,), rc == 2, "rc=%s err=%r" % (rc, err[:120]))

# ── 9. tier-3 jira#<KEY> snapshot summary / status_name (valid-jira-units.tsv) ──────────────────────
JU = (FIX / "valid-jira-units.tsv").read_bytes()
try:
    _, JROWS = P.parse_plan(JU)
    ok("9a valid-jira-units.tsv parses (%d rows)" % len(JROWS))
except P.PlanError as e:
    JROWS = []
    bad("9a valid-jira-units.tsv parses", str(e))
jb = {r["ref"]: r.get("jira") or {} for r in JROWS}
check("9b jira#TST-201 summary / status_name decoded once (: , ; %% in the summary)",
      (jb.get("jira#TST-201", {}).get("summary"), jb.get("jira#TST-201", {}).get("status_name"))
      == ("결제 화면: 금액 표시, 오류; 100% 확인", "In Progress"), repr(jb.get("jira#TST-201")))
check("9c jira#TST-202 summary / status_name", (jb.get("jira#TST-202", {}).get("summary"),
      jb.get("jira#TST-202", {}).get("status_name")) == ("알림 설정 저장 안 됨", "보류 (외부 대기)"), repr(jb.get("jira#TST-202")))
check("9d inventory jira#TST total 2 = its two jira#TST-<N> rows", jb.get("jira#TST", {}).get("total") == 2,
      repr(jb.get("jira#TST")))
check("9e encode_jira_unit_snapshot = the fixture's snapshot column bytes",
      P.encode_jira_unit_snapshot("결제 화면: 금액 표시, 오류; 100% 확인", "In Progress") == JU.split(b"\n")[1].split(b"\t")[4],
      repr(P.encode_jira_unit_snapshot("결제 화면: 금액 표시, 오류; 100% 확인", "In Progress")))
m = raises(P.encode_jira_unit_snapshot, "", "Open")
check("9f encode_jira_unit_snapshot refuses an empty summary", m is not None and "must not be empty" in m, repr(m))

rc, out, err = cli("check", str(FIX / "valid-jira-units.tsv"), "--site", "other.atlassian.net", "--project", "TST")
check("8g check valid-jira-units.tsv with another site → exit 1 from the inventory row (line 4)",
      rc == 1 and err.count("\n") == 1 and "line 4: Jira site example.atlassian.net is not the bound site other.atlassian.net" in err,
      "rc=%s err=%r" % (rc, err))

# ── 10. review round: title collisions, close-row titles, binding on inventory-only plans ──────────
try:
    _, TROWS = P.parse_plan((FIX / "valid-title-collide.tsv").read_bytes())
    check("10a valid-title-collide.tsv: titles t=a;v=b and the full forged evidence string stay plain titles",
          [(r["ref"], r["evidence"], "unit" in r) for r in TROWS]
          == [("pr#31", "t=a;v=b", False), ("issue#32", FORGED, False), ("pr#33", FORGED, False)], repr(TROWS))
except P.PlanError as e:
    bad("10a valid-title-collide.tsv parses", str(e))
try:
    _, CROWS = P.parse_plan((FIX / "valid-close-title.tsv").read_bytes())
    check("10b valid-close-title.tsv: row['title'] = the snapshot's last key title",
          [(r["ref"], r["title"], list(r["snapshot"])[-1]) for r in CROWS]
          == [("pr#7", "오래된 실험: 검색, 정렬; 100% 다시 보기", "title"), ("issue#9", "로그인 실패 시 안내 문구 없음", "title")],
          repr([(r["ref"], r.get("title")) for r in CROWS]))
except P.PlanError as e:
    bad("10b valid-close-title.tsv parses", str(e))
m = raises(P.check_jira_binding, JROWS, "other.atlassian.net", "TST", None, None)
check("10c check_jira_binding on valid-jira-units.tsv (tier-3 + inventory only) refuses another site at the inventory row",
      m is not None and m.startswith("line 4: Jira site example.atlassian.net is not the bound site"), repr(m))
check("10d check_jira_binding on valid-jira-units.tsv with the right site / project passes",
      raises(P.check_jira_binding, JROWS, "example.atlassian.net", "TST", None, None) is None, "")
for nm, fn, a, sub in (("penc(5)", P.penc, (5,), "must be str or bytes"), ("penc(None)", P.penc, (None,), "must be str or bytes"),
                       ("penc([65])", P.penc, ([65],), "must be str or bytes"),
                       ("jira evidence unknown key", P.encode_jira_evidence, ({"v": "KEEP", "reason": "r", "why": "x"},),
                        "evidence must be a dict with keys from"),
                       ("jira evidence reason=0", P.encode_jira_evidence, ({"v": "KEEP", "reason": 0},), "evidence reason must be str"),
                       ("jira evidence cites=False", P.encode_jira_evidence, ({"v": "KEEP", "reason": "r", "cites": False},),
                        "evidence cites must be str"),
                       ("jira evidence known=None", P.encode_jira_evidence, ({"v": "KEEP", "reason": "r", "known": None},),
                        "evidence known must be str"),
                       ("jira evidence jira=None", P.encode_jira_evidence, ({"v": "KEEP", "reason": "r", "jira": None},),
                        "evidence jira must be a list"),
                       ("jira evidence jira element int status", P.encode_jira_evidence,
                        ({"v": "KEEP", "reason": "r", "jira": [{"key": "AB-1", "status": 3}]},), "evidence jira element must be"),
                       ("unit evidence t=0", P.encode_unit_evidence, ({"t": 0, "v": "KEEP", "reason": "r"},), "evidence t must be str"),
                       ("inventory total True", P.encode_inventory_evidence, (True, "q", "a.b"), "total must be an int >= 0"),
                       ("inventory total '4'", P.encode_inventory_evidence, ("4", "q", "a.b"), "total must be an int >= 0"),
                       ("inventory total -1", P.encode_inventory_evidence, (-1, "q", "a.b"), "total must be an int >= 0"),
                       ("snapshot int value", P.encode_snapshot, ({"a": 1},), "must be str or bytes"),
                       ("jira unit snapshot None", P.encode_jira_unit_snapshot, (None, "Open"), "must be str")):
    m = raises(fn, *a)
    check("10e %s → PlanError" % nm, m is not None and sub in m, repr(m))

# ── 11. posted comments: only \n and \t among the control characters (= chore-jira.py BAD_TEXT_RE) ───────
CI_LINE = VALID.split(b"\n")[3]   # close-issue issue#9
refused = []
for c in list(range(1, 0x20)) + [0x7F]:
    cl = CI_LINE.split(b"\t")
    cl[5] = P.penc("앞" + chr(c) + "뒤")
    m = raises(P.parse_plan, VALID.split(b"\n")[0] + b"\n" + b"\t".join(cl) + b"\n")
    if (m is None) != (c in (0x09, 0x0A)):
        refused.append("0x%02X: %r" % (c, m))
check("11a close comment: every C0 control and DEL refused, \\t and \\n accepted", not refused, "; ".join(refused[:3]))
JH = SCRIPTS / "chore-jira.py"
if JH.exists():
    import re as _re
    mm = _re.search(r'^BAD_TEXT_RE = re\.compile\(r"([^"]*)"\)', JH.read_text(encoding="utf-8"), _re.M)
    check("11b BAD_COMMENT pattern = scripts/chore-jira.py BAD_TEXT_RE", mm is not None and mm.group(1) == P.BAD_COMMENT.pattern,
          "%r vs %r" % (mm and mm.group(1), P.BAD_COMMENT.pattern))

# ── 12. ledgers: the exclusion-ledger paths collect read, part of every jira-transition snapshot (2026-10-20) ──────────
# The right-before-write recheck re-reads these files, so they are approved plan bytes. 1st layer = the snapshot value,
# 2nd layer = each path penc'd, elements joined by ","; "-" = no ledger used. Paths are kept exactly as given.
check("12a ledgers is the last jira-transition snapshot key and in the exact key set",
      P.JIRA_SNAP_KEYS[-1] == "ledgers" and P.SNAP_EXACT[P.JIRA_ACTION] == set(P.JIRA_SNAP_KEYS), repr(P.JIRA_SNAP_KEYS))
LEDGERS = ["/home/me/.claude/chore ledger.tsv", "/tmp/a,b;c=d:e%f/잠금 => x.json"]
ltxt = P.encode_ledgers(LEDGERS)
check("12b decode_ledgers(encode_ledgers(x)) == x on , ; = : %% => space and UTF-8 in two absolute paths",
      P.decode_ledgers(ltxt) == LEDGERS and ltxt.count(",") == 1, repr(ltxt))
check("12c encode_ledgers(decode_ledgers(t)) == t, empty list = '-'",
      P.encode_ledgers(P.decode_ledgers(ltxt)) == ltxt and P.encode_ledgers([]) == "-" and P.decode_ledgers("-") == [], ltxt)
check("12d the paths survive the snapshot layer (encode_snapshot → parse_snapshot → decode_ledgers)",
      P.decode_ledgers(P.parse_snapshot(P.encode_snapshot({"ledgers": ltxt}), "t")["ledgers"]) == LEDGERS, "")
ASIS = ["/a/../b", "/b", "/a//b/", "/a/./b"]
check("12e paths are kept as given (no resolving): /a/../b and /b are two paths",
      P.decode_ledgers(P.encode_ledgers(ASIS)) == ASIS, repr(P.decode_ledgers(P.encode_ledgers(ASIS))))
for nm, arg, sub in (("a string instead of a list", "/a", "encode_ledgers: paths must be a list"),
                     ("a non-str path", ["/a", 5], "encode_ledgers: path 1 must be a str"),
                     ("an empty path", [""], "empty ledgers element"),
                     ("a relative path", ["a/b"], "must be absolute"),
                     ("a duplicate path", ["/a", "/a"], "duplicate ledgers path"),
                     ("a control character", ["/a\x1fb"], "control character"),
                     ("a newline", ["/a\nb"], "control character"),
                     ("NUL", ["/a\x00b"], "NUL")):
    m = raises(P.encode_ledgers, arg)
    check("12f encode_ledgers refuses %s" % nm, m is not None and sub in m, repr(m))
HEADER = VALID.split(b"\n")[0]


def ledger_plan(value, idx, comment=None):
    """header + valid.tsv line idx+1 (a jira-transition row) with snapshot ledgers = value (1st-layer string; None = key
    left out) + its inventory row (total 1)."""
    col = VALID.split(b"\n")[idx].split(b"\t")
    snap = P.parse_snapshot(col[4], "t")
    snap["ledgers"] = value
    col[4] = P.encode_snapshot({k: snap[k] for k in P.JIRA_SNAP_KEYS if snap[k] is not None})
    if comment is not None:
        col[5] = P.penc(comment)
    inv = b"\t".join([b"3", b"report", b"jira#TST", b"-", b"-", P.encode_inventory_evidence(1, "q", "example.atlassian.net")])
    return HEADER + b"\n" + b"\t".join(col) + b"\n" + inv + b"\n"


for idx, lvl in ((4, "TO-QA"), (5, "TO-CLOSED")):
    for val, want in ((ltxt, LEDGERS), ("-", [])):
        try:
            _, LR = P.parse_plan(ledger_plan(val, idx))
            check("12g %s row with ledgers %s → row['jira']['ledgers'] = %r" % (lvl, "two paths" if want else "-", want),
                  LR[0]["jira"].get("ledgers") == want and LR[0]["snapshot"]["ledgers"] == val, repr(LR[0]["jira"].get("ledgers")))
        except P.PlanError as e:
            bad("12g %s row with ledgers %r parses" % (lvl, val), str(e))
    for nm, val, sub in (("no ledgers key", None, "snapshot keys for jira-transition: missing [ledgers]"),
                         ("a relative path", "rel/ledger.tsv", "must be absolute"),
                         ("a '-' element in a list", "/a,-", "must be absolute"),
                         ("a duplicate path", "/a/x.tsv,/a/x.tsv", "duplicate ledgers path"),
                         ("a control character (%01 inside the path)", "/a%01b", "control character"),
                         ("DEL (%7F inside the path)", "/a%7Fb", "control character"),
                         ("an empty element (trailing comma)", "/a,", "empty ledgers element"),
                         ("an empty element (leading comma)", ",/a", "empty ledgers element"),
                         ("an empty value", "", "empty ledgers element"),
                         ("an unencoded ':' inside a path", "/a:b", "unencoded ':'"),
                         ("a raw control byte inside a path", "/a\x01b", "raw control byte"),
                         ("a non-canonical escape", "/a%41", "non-canonical percent-escape"),
                         ("a malformed escape", "/a%4", "malformed percent-escape"),
                         ("%00", "/a%00b", "NUL byte")):
        m = raises(P.parse_plan, ledger_plan(val, idx))
        check("12h %s row: ledgers with %s → parse error" % (lvl, nm), m is not None and m.startswith("line 2") and sub in m,
              repr(m))

# ── 13. has_chore_marker: one detector for "chore already commented" (collect and the Jira writer share it) ─────────────
MK = P.MARKER_FMT % ("QA (staging)", "2026-10-19")
for nm, text, want in (("the marker line alone", MK, True), ("the last line of a comment", "본문\n" + MK, True),
                       ("a middle line", "앞\n" + MK + "\n뒤", True), ("trailing spaces", "본문\n" + MK + "   ", True),
                       ("a trailing tab", MK + "\t", True), ("CRLF line ends", "본문\r\n" + MK + "\r\n", True),
                       ("a trailing CR", MK + "\r", True), ("leading spaces", "  " + MK, True),
                       ("marker text inside a longer line (prefix)", "참고: " + MK, False),
                       ("marker text inside a longer line (suffix)", MK + " 끝", False), ("empty text", "", False),
                       ("no marker", "본문\n끝", False), ("another date shape", MK.replace("2026-10-19", "2026-1-19"), False)):
    got = P.has_chore_marker(text)
    check("13a has_chore_marker(%s) is %s" % (nm, want), got is want, repr(got))
QA_COMMENT = P.pdec(VALID.split(b"\n")[4].split(b"\t")[5], "t")
m = raises(P.parse_plan, ledger_plan("-", 4, QA_COMMENT + " "))
check("13b the plan grammar still wants our comment's last line to be exactly the marker (a trailing space is refused, "
      "has_chore_marker would find it)", m is not None and "must end with the marker line" in m
      and P.has_chore_marker(QA_COMMENT + " "), repr(m))

# ── 14. v4.3 move-issue rows (fixtures/chore-v4/move/: valid.tsv, issues.json, invalid/*.tsv + expected.json) ────────────
# Kept GitHub issues of a repo with a Jira binding become new tickets (design v9 §1 R6, §2, §4). The fixtures live in their
# own folder: the renderer learns move rows later, and chore-render.test.sh globs fixtures/chore-v4/{valid*,invalid/*}.tsv.
import hashlib
MV = FIX / "move"
MV_VALID = (MV / "valid.tsv").read_bytes()
MV_IN = json.loads((MV / "issues.json").read_text(encoding="utf-8"))
MV_URL, MV_DATE, MV_SNAPIN = MV_IN["repo_url"], MV_IN["plan_date"], MV_IN["snap"]
MV_ISSUE = {d["ref"]: d for d in MV_IN["rows"]}
OLD_MIG = ("이 이슈는 Jira TST-130로 옮겼습니다: https://example.atlassian.net/browse/TST-130\n남기는 이유: 이전 계획\n"
           "이후 진행은 Jira 티켓에서 이어갑니다. 이 이슈는 닫습니다.\nchore 정리 → Jira로 옮김 — by Claude triage 2026-10-01")
check("14a constants: move-issue only in tier 2, exact snapshot key set, evidence keys, no ticket label (§10f), marker, caps",
      P.MOVE_ACTION == "move-issue" and P.MOVE_ACTION in P.ACTIONS and P.MOVE_ACTION in P.ALLOWED[2]
      and all(P.MOVE_ACTION not in P.ALLOWED[t] for t in (1, 3)) and P.SNAP_EXACT[P.MOVE_ACTION] == set(P.MOVE_SNAP_KEYS)
      and len(P.MOVE_SNAP_KEYS) == 15 and P.MOVE_EV_KEYS == ("reason", "gh", "related") and not hasattr(P, "MOVE_LABEL")
      and P.MOVE_GH_MARKER == "Jira로 옮김" and (P.MOVE_CAP, P.SUMMARY_MAX) == (32000, 255)
      and P.MOVE_ACTION not in P.COMMENT_ACTIONS, "")


def mv_gh(reason):
    return "\n".join(("이 이슈는 Jira {KEY}로 옮겼습니다: https://example.atlassian.net/browse/{KEY}", "남기는 이유: " + reason,
                      "이후 진행은 Jira 티켓에서 이어갑니다. 이 이슈는 닫습니다.", "chore 정리 → Jira로 옮김 — by Claude triage " + MV_DATE))


def mv_want(ref, adopt, prior, related):
    d = MV_ISSUE[ref]
    payload, _ = P.move_payload(d["issue"], MV_URL, MV_SNAPIN, d["reason"], d["related"], MV_DATE)
    return dict(number=int(ref[6:]), site="example.atlassian.net", project="TST", project_id="10000", issuetype="10001",
                issuetype_name="작업", account=ACCT, gh_login="chore-bot", source_sha=P.source_sha(d["issue"]),
                payload_sha=hashlib.sha256(payload).hexdigest(), adopt=adopt, prior=prior, reason=d["reason"],
                gh=mv_gh(d["reason"]), related=related, plan_date=MV_DATE)


try:
    MV_HDR, MV_ROWS = P.parse_plan(MV_VALID)
except P.PlanError as e:
    MV_HDR, MV_ROWS = None, []
    bad("14b move/valid.tsv parses", str(e))
if MV_HDR is not None:
    ok("14b move/valid.tsv parses (%d rows, no jira-transition row)" % len(MV_ROWS))
    got = [(r["line"], r["tier"], r["action"], r["ref"], r["expected"]) for r in MV_ROWS]
    check("14c row line/tier/action/ref/expected", got == [
        (2, 2, "move-issue", "issue#11", "2026-08-02T00:00:00Z"), (3, 2, "move-issue", "issue#12", "2026-08-03T00:00:00Z"),
        (4, 2, "move-issue", "issue#13", "2026-08-04T00:00:00Z"), (5, 2, "close-issue", "issue#9", "2026-08-01T00:00:00Z"),
        (6, 3, "report", "issue#10", "2026-10-11T00:00:00Z")], repr(got))
    mb = {r["ref"]: r for r in MV_ROWS}
    PRIOR13 = {"cid": "4001", "csha": hashlib.sha256(OLD_MIG.encode("utf-8")).hexdigest()}
    for ref, want in (("issue#11", mv_want("issue#11", None, None, [])),
                      ("issue#12", mv_want("issue#12", "TST-120", None, ["TST-90", "TST-91"])),
                      ("issue#13", mv_want("issue#13", "TST-130", PRIOR13, []))):
        check("14d %s → row['move'] (source_sha / payload_sha = the issues.json inputs through source_sha / move_payload)" % ref,
              mb[ref].get("move") == want, "got %r" % (mb[ref].get("move"),))
    check("14e move rows carry 'move' and no 'jira'; the others carry neither; snapshot keys in MOVE_SNAP_KEYS order",
          all(("move" in r) == (r["action"] == "move-issue") and "jira" not in r for r in MV_ROWS)
          and all(tuple(r["snapshot"]) == P.MOVE_SNAP_KEYS for r in MV_ROWS if r["action"] == "move-issue"), "")
    check("14f author may be empty (a deleted account): issue#13 snapshot author = ''", mb["issue#13"]["snapshot"]["author"] == "", "")
    rebuilt = []
    for r in MV_ROWS:
        if "move" in r:
            d, mv = MV_ISSUE[r["ref"]], r["move"]
            rebuilt.append(hashlib.sha256(P.move_payload(d["issue"], MV_URL, r["snapshot"], mv["reason"], mv["related"],
                                                         mv["plan_date"])[0]).hexdigest() == mv["payload_sha"])
    check("14f' the payload is rebuilt from the row alone: move_payload(issue, repo_url, snapshot, reason, related, "
          "row['move']['plan_date']) hashes to the row's payload_sha (plan_date = the gh marker date)",
          rebuilt == [True, True, True] and {r["move"]["plan_date"] for r in MV_ROWS if "move" in r} == {MV_DATE}, repr(rebuilt))
    canon = []
    for r in MV_ROWS:
        if "move" in r:
            d, mv = MV_ISSUE[r["ref"]], r["move"]
            pb = P.move_payload(d["issue"], MV_URL, r["snapshot"], mv["reason"], mv["related"], mv["plan_date"])[0]
            canon.append(P.canon_json(json.loads(pb)) == pb and P.canon_json(json.loads(pb), "t") == pb)
    check("14f'' canon_json is the one payload encoder: canon_json(json.loads(payload)) == payload for each fixture row; "
          "_canon_json is the same function", canon == [True, True, True] and P._canon_json is P.canon_json, repr(canon))
    again = []
    for r in MV_ROWS:
        if "move" in r:
            d, mv, sn = MV_ISSUE[r["ref"]], r["move"], r["snapshot"]
            ddoc = P.move_description(d["issue"], MV_URL, mv["reason"], mv["related"], mv["plan_date"])[0]
            pb = P.payload_bytes(sn["project_id"], sn["issuetype"], P.move_summary(d["issue"]["title"]), sn["account"],
                                 P.doc_from_blocks(P.parse_blocks(ddoc)))
            again.append(P.doc_from_blocks(P.parse_blocks(ddoc)) == ddoc and hashlib.sha256(pb).hexdigest() == mv["payload_sha"]
                         and pb == P.move_payload(d["issue"], MV_URL, sn, mv["reason"], mv["related"], mv["plan_date"])[0])
    check("14f''' a stored ticket rebuilds to the approved bytes: payload_bytes(fixture row fields, doc_from_blocks(parse_blocks("
          "description))) == move_payload bytes, sha256 == payload_sha; doc_from_blocks round-trips every fixture description",
          again == [True, True, True], repr(again))
    check("14g every move/valid.tsv snapshot column is canonical", all(
        P.encode_snapshot(P.parse_snapshot(ln.split(b"\t")[4], "t")) == ln.split(b"\t")[4]
        for ln in MV_VALID.split(b"\n")[1:-1]), "")
    check("14h the evidence column = encode_move_evidence(decoded) (canonical bytes)", all(
        P.encode_move_evidence({k: r["move"][k] for k in P.MOVE_EV_KEYS}) == MV_VALID.split(b"\n")[r["line"] - 1].split(b"\t")[5]
        for r in MV_ROWS if "move" in r), "")
    MV_BIND = ("example.atlassian.net", "TST", None, None)
    check("14i check_jira_binding accepts the bound site / project for move rows (no jira-qa / jira-closed needed)",
          raises(P.check_jira_binding, MV_ROWS, *MV_BIND) is None, raises(P.check_jira_binding, MV_ROWS, *MV_BIND))
    m = raises(P.check_jira_binding, MV_ROWS, "example.atlassian.net", "OTH", None, None)
    check("14j check_jira_binding refuses another project at the first move row",
          m == "line 2: move-issue issue#11 targets Jira project TST, not the bound Jira project OTH", repr(m))
    m = raises(P.check_jira_binding, MV_ROWS, "other.atlassian.net", "TST", None, None)
    check("14k check_jira_binding refuses another site", m == "line 2: Jira site example.atlassian.net is not the bound site "
          "other.atlassian.net", repr(m))
    rc, out, err = cli("check", str(MV / "valid.tsv"), "--site", "example.atlassian.net", "--project", "TST")
    check("14l CLI check move/valid.tsv with its binding → exit 0, silent", (rc, out, err) == (0, b"", ""), "rc=%s err=%r" % (rc, err))
    rc, out, err = cli("check", str(MV / "valid.tsv"), "--site", "example.atlassian.net", "--project", "OTH")
    check("14l CLI check with another project → exit 1, one line", rc == 1 and err.count("\n") == 1
          and "targets Jira project TST, not the bound Jira project OTH" in err, "rc=%s err=%r" % (rc, err))
    # a plan with both kinds (valid.tsv's Jira rows + the move rows): one binding, the inventory total ignores move rows
    MIX = VALID + b"\n".join(MV_VALID.split(b"\n")[1:4]) + b"\n"
    try:
        _, XR = P.parse_plan(MIX)
        check("14m jira-transition + move-issue rows in one plan parse; the inventory total (4) counts jira#TST-<N> rows only",
              sum("move" in r for r in XR) == 3 and sum("jira" in r for r in XR) == 5
              and raises(P.check_jira_binding, XR, "example.atlassian.net", "TST", "20004", "20191") is None, "")
    except P.PlanError as e:
        bad("14m mixed plan parses", str(e))
    MIXO = VALID + b"\n".join(MV_VALID.split(b"\n")[1:2]).replace(b"project=TST", b"project=OTH") + b"\n"
    m = raises(P.parse_plan, MIXO)
    check("14n a move row in another project than the Jira rows → one Jira binding per plan",
          m is not None and "jira project OTH differs from jira project TST on line 5 — one Jira binding per plan" in m, repr(m))
    m = raises(P.parse_plan, MV_VALID.split(b"\n")[0] + b"\n" + MV_VALID.split(b"\n")[4] + b"\n"
               + MV_VALID.split(b"\n")[1].replace(b"issue#11", b"issue#9") + b"\n")
    check("14o close-issue first, then move-issue for the same issue → one target, two states",
          m == "line 3: move-issue issue#9 and line 2 close-issue issue#9 name the same issue — one target, two states", repr(m))

mv_expected = json.loads((MV / "expected.json").read_text(encoding="utf-8"))
mv_files = sorted(p.name for p in (MV / "invalid").glob("*.tsv"))
check("14p move/expected.json names exactly the move/invalid/*.tsv files (%d)" % len(mv_files), sorted(mv_expected) == mv_files,
      "only in expected.json: %s; only on disk: %s" % (sorted(set(mv_expected) - set(mv_files)), sorted(set(mv_files) - set(mv_expected))))
for name in ("mv-ref-shape.tsv", "mv-snap-missing-key.tsv", "mv-prior-without-adopt.tsv", "mv-adopt-other-project.tsv",
             "mv-gh-one-key.tsv", "mv-gh-trailing-newline.tsv", "mv-gh-marker-group.tsv", "mv-gh-cr.tsv", "mv-reason-empty.tsv",
             "mv-bad-source-sha.tsv", "mv-bad-payload-sha.tsv", "mv-state-closed.tsv", "mv-expected-updated.tsv",
             "mv-kept-twin.tsv", "mv-close-twin.tsv", "mv-two-sites.tsv", "mv-gh-marker-date.tsv", "mv-plan-date-differs.tsv",
             "mv-project-id-zero.tsv", "mv-issuetype-leading-zero.tsv", "mv-prior-cid-zero.tsv", "mv-prior-cid-leading-zero.tsv",
             "mv-adopt-twice.tsv", "mv-adopt-in-related.tsv"):
    check("14q required invalid case %s is in the set" % name, name in mv_files, "")
mv_cli_bad = []
for name in mv_files:
    data = (MV / "invalid" / name).read_bytes()
    m = raises(P.parse_plan, data)
    if m is None:
        bad("14r %s" % name, "parsed (want PlanError containing %r)" % mv_expected.get(name))
    elif mv_expected.get(name) is None or mv_expected[name] not in m:
        bad("14r %s" % name, "error %r lacks %r" % (m, mv_expected.get(name)))
    else:
        ok("14r %s → %s" % (name, m))
    rc, out, err = cli("check", str(MV / "invalid" / name))
    if not (rc == 1 and out == b"" and err.count("\n") == 1 and err.startswith("chore_plan: ") and mv_expected.get(name, "\0") in err):
        mv_cli_bad.append("%s rc=%s err=%r" % (name, rc, err[:120]))
check("14s CLI check move/invalid/*.tsv (%d) → exit 1, one stderr line with the expected message" % len(mv_files),
      not mv_cli_bad, "; ".join(mv_cli_bad[:3]))

# ── 15. move-issue generators and readers (one module = the same bytes and predicates for build / apply / verify) ───────
MEV = {"reason": "이유; =, : % => 끝\n둘째 줄", "gh": mv_gh("x"), "related": ["TST-1", "TST-22"]}
mraw = P.encode_move_evidence(MEV)
check("15a decode_move_evidence(encode_move_evidence(x)) == x on ; = , : %% => and a newline in the reason",
      P.decode_move_evidence(mraw) == MEV, repr(P.decode_move_evidence(mraw)))
check("15b encode_move_evidence(decode_move_evidence(b)) == b, column bytes canonical (no raw ; = , : tab newline)",
      P.encode_move_evidence(P.decode_move_evidence(mraw)) == mraw and not any(c in mraw for c in b";=,:\t\n"), repr(mraw[:80]))
check("15c related [] ⇄ '-'", P.decode_move_evidence(P.encode_move_evidence(dict(MEV, related=[])))["related"] == []
      and b"related%3D-" in P.encode_move_evidence(dict(MEV, related=[])), "")
m = raises(P.decode_move_evidence, mraw, "t", "OTH")
check("15d decode_move_evidence(project=OTH) refuses a related key of another project", m is not None
      and "related key TST-1 is not in project OTH" in m, repr(m))
for nm, ev, sub in (("an unknown key", dict(MEV, why="x"), "evidence must be a dict with keys from reason gh related"),
                    ("related as a string", dict(MEV, related="TST-1"), "evidence related must be a list"),
                    ("related ['-']", dict(MEV, related=["-"]), "related does not round-trip"),
                    ("related with a bad key", dict(MEV, related=["tst-1"]), "malformed move evidence related element"),
                    ("reason None", dict(MEV, reason=None), "evidence reason must be str"),
                    ("gh without its marker", dict(MEV, gh="{KEY} {KEY}"), "must end with the marker line")):
    m = raises(P.encode_move_evidence, ev)
    check("15e encode_move_evidence refuses %s" % nm, m is not None and sub in m, repr(m))

GH1 = P.move_comment("example.atlassian.net", "줄1\n줄2\r\n줄3 \x01끝", MV_DATE)
check("15f move_comment = the 4-line template, reason on one line (newlines → space, other controls dropped)",
      GH1 == mv_gh("줄1 줄2 줄3 끝") and GH1.count("\n") == 3 and GH1.count("{KEY}") == 2, repr(GH1))
check("15g move_comment output passes the plan check (encode → decode)",
      P.decode_move_evidence(P.encode_move_evidence({"reason": "r", "gh": GH1}))["gh"] == GH1, "")
for nm, a, sub in (("{KEY} in the reason", ("example.atlassian.net", "see {KEY}", MV_DATE), "exactly twice"),
                   ("a bad site", ("bad_host", "r", MV_DATE), "site must be a host name"),
                   ("an empty reason", ("example.atlassian.net", " \n ", MV_DATE), "reason is empty"),
                   ("a non-calendar date", ("example.atlassian.net", "r", "2026-02-30"), "plan date must be YYYY-MM-DD")):
    m = raises(P.move_comment, *a)
    check("15h move_comment refuses %s" % nm, m is not None and sub in m, repr(m))
BODY1 = P.comment_body(GH1, "TST-501")
check("15i comment_body puts the key in both places", BODY1.split("\n")[0]
      == "이 이슈는 Jira TST-501로 옮겼습니다: https://example.atlassian.net/browse/TST-501" and "{KEY}" not in BODY1, BODY1)
check("15j comment_body refuses a non-key", raises(P.comment_body, GH1, "tst-1") is not None, "")
OLD_CLOSE = "이 이슈는 PR #120에서 해결되어 닫습니다.\nchore 정리 → issue closed — by Claude triage 2026-09-01"
for nm, args, want in (("our posted comment", (BODY1, "chore-bot", "chore-bot"), True),
                       ("the recorded comment of an earlier plan", (OLD_MIG, "chore-bot", "chore-bot"), True),
                       ("CRLF line ends (last line rstrip CR)", (BODY1.replace("\n", "\r\n") + "\r", "chore-bot", "chore-bot"), True),
                       ("another author", (BODY1, "someone", "chore-bot"), False),
                       ("a deleted author (None)", (BODY1, None, "chore-bot"), False),
                       ("an old chore close comment (another group1)", (OLD_CLOSE, "chore-bot", "chore-bot"), False),
                       ("marker not on the last line", (BODY1 + "\n추가", "chore-bot", "chore-bot"), False),
                       ("a trailing newline", (BODY1 + "\n", "chore-bot", "chore-bot"), False),
                       ("an empty gh_login", (BODY1, "", ""), False)):
    check("15k migration_comment(%s) is %s" % (nm, want), P.migration_comment(*args) is want, "")

for nm, title, want in (("300 ASCII chars → 255", "a" * 300, "a" * 255),
                        ("tab / LF / CR → space, other C0 and DEL dropped, ends stripped", "  a\tb\nc\rd\x01e\x7f  ", "a b c de"),
                        ("a cut that ends on a space is stripped", "a" * 254 + " b", "a" * 254),
                        ("astral characters count 2 (UTF-16), never split", "😀" * 200, "😀" * 127),
                        ("Korean title unchanged", "로그인 실패: 안내 문구 없음", "로그인 실패: 안내 문구 없음")):
    got = P.move_summary(title)
    check("15l move_summary %s" % nm, got == want and len(got) <= 255, repr(got[:20]) + " len %d" % len(got))
check("15l move_summary refuses a title of control characters only", raises(P.move_summary, "\x01\x02") is not None, "")


def issue(n=7, title="제목", body="본문", author="frank", created="2026-05-01T09:00:00Z", labels=(), comments=()):
    return {"number": n, "title": title, "body": body, "author": author, "created": created, "labels": list(labels),
            "comments": [{"author": a, "created": c, "body": b} for a, c, b in comments]}


def walk(node):
    yield node
    for k in node.get("content", ()) if isinstance(node, dict) else ():
        yield from walk(k)


URL7 = "GitHub 이슈에서 옮김: https://github.com/test/repo/issues/7"
MK7 = "chore 정리 → GitHub issue #7 — by Claude triage 2026-10-21"
I7 = issue(labels=["ui", "bug"], body="줄 1\n줄 2\n\n", comments=[("grace", "2026-05-02T10:00:00Z", "봤어요\r\n크롬"),
                                                                  (None, "2026-05-03T00:00:00Z", "")])
doc, tr = P.move_description(I7, "https://github.com/test/repo", "이유\n둘째", ["TST-9"], MV_DATE)
WANT7 = [("paragraph", URL7), ("paragraph", "제목: 제목"),
         ("paragraph", "작성: frank · 2026-05-01T09:00:00Z · 라벨: bug, ui · 댓글 2개"), ("paragraph", "남기는 이유: 이유\n둘째"),
         ("paragraph", "관련: TST-9"), ("heading", "본문"), ("codeBlock", "줄 1\n줄 2"), ("heading", "댓글"),
         ("paragraph", "grace · 2026-05-02T10:00:00Z"), ("codeBlock", "봤어요\n크롬"),
         ("paragraph", "(삭제된 계정) · 2026-05-03T00:00:00Z"), ("codeBlock", "(내용 없음)"), ("paragraph", MK7)]
check("15m move_description: block order 1–11 (related, two comments incl. a deleted author and an empty body, labels sorted)",
      P.parse_blocks(doc) == WANT7 and tr == {"body_cut": False, "comments_total": 2, "comments_included": 2},
      repr(P.parse_blocks(doc)))
check("15n ADF shape: doc version 1; heading level 3; no empty text node; a paragraph newline is a hardBreak",
      doc["type"] == "doc" and doc["version"] == 1 and all(b["attrs"] == {"level": 3} for b in doc["content"] if b["type"] == "heading")
      and all(x.get("text") != "" for x in walk(doc) if x.get("type") == "text")
      and [x["type"] for x in doc["content"][3]["content"]] == ["text", "hardBreak", "text"], "")
doc0, tr0 = P.move_description(issue(body=None), "https://github.com/test/repo", "r", [], MV_DATE)
check("15o no comments, no related, empty (None) body: no 댓글 heading, no notice, (본문 없음), labels 없음",
      P.parse_blocks(doc0) == [("paragraph", URL7), ("paragraph", "제목: 제목"),
                               ("paragraph", "작성: frank · 2026-05-01T09:00:00Z · 라벨: 없음 · 댓글 0개"),
                               ("paragraph", "남기는 이유: r"), ("heading", "본문"), ("codeBlock", "(본문 없음)"), ("paragraph", MK7)]
      and tr0 == {"body_cut": False, "comments_total": 0, "comments_included": 0}, repr(P.parse_blocks(doc0)))
check("15o empty-string body = None body (same description)", P.move_description(issue(body=""), "https://github.com/test/repo",
      "r", [], MV_DATE) == (doc0, tr0), "")
docc, trc = P.move_description(issue(body="a\r\nb\rc\r\n\x01d\x7f\te"), "https://github.com/test/repo", "r", [], MV_DATE)
check("15p CRLF / CR body → LF, controls dropped, tab kept", P.parse_blocks(docc)[5] == ("codeBlock", "a\nb\nc\nd\te"),
      repr(P.parse_blocks(docc)[5]))
# The cap (U1 review S1): the description doc serialized as json.dumps(doc, ensure_ascii=False, separators=(",", ":")) is at
# most MOVE_CAP UTF-16 units, truncation notice included — the stored form Jira limits to 32,767, not the visible text. Every
# expectation below is measured with json.dumps on a built doc (ser16), never with the module's own counter.
CAP = P.MOVE_CAP
NOTICE = "나머지는 원 이슈에서: "
JIRA_LIMIT = 32767


def ser16(doc):
    return len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-16-le")) // 2


def desc(iss):
    d, t = P.move_description(iss, "https://github.com/test/repo", "r", [], MV_DATE)
    return d, P.parse_blocks(d), t


def para(t):
    return {"type": "paragraph", "content": [{"type": "text", "text": t}]}


def code(t):
    return {"type": "codeBlock", "content": [{"type": "text", "text": t}]}


def body_at(d):
    """index of the body code block = right after the 본문 heading."""
    return next(j for j, b in enumerate(d["content"]) if b["type"] == "heading" and b["content"][0]["text"] == "본문") + 1


def with_body(d, text):
    c = list(d["content"])
    c[body_at(d)] = code(text)
    return dict(d, content=c)


check("15p' MOVE_CAP = 32000 serialized UTF-16 units, under Jira's 32,767", CAP == 32000 < JIRA_LIMIT, repr(CAP))
ONE = ("u", "2026-05-01T00:00:00Z", "한 줄 댓글")
d12, b12, t12 = desc(issue(body="b", comments=[ONE] * 1200))
i12 = t12["comments_included"]
more = list(d12["content"])
more[-2:] = [para("u · 2026-05-01T00:00:00Z"), code("한 줄 댓글"), para(NOTICE + "댓글 %d개 안 실음" % (1200 - i12 - 1)), more[-1]]
allc = dict(d12, content=d12["content"][:body_at(d12) + 1] + [{"type": "heading", "attrs": {"level": 3}, "content": [
    {"type": "text", "text": "댓글"}]}] + [n for _ in range(1200) for n in (para("u · 2026-05-01T00:00:00Z"), code("한 줄 댓글"))]
    + [d12["content"][-1]])
check("15q 1,200 one-line comments: serialized ≤ %d (%d), %d carried, one more would not fit (%d); all of them would serialize "
      "to %d > Jira's %d" % (CAP, ser16(d12), i12, ser16(dict(d12, content=more)), ser16(allc), JIRA_LIMIT),
      ser16(d12) <= CAP < ser16(dict(d12, content=more)) and 0 < i12 < 1200 and ser16(allc) > JIRA_LIMIT
      and t12 == {"body_cut": False, "comments_total": 1200, "comments_included": i12}
      and b12[-2] == ("paragraph", NOTICE + "댓글 %d개 안 실음" % (1200 - i12)), repr(t12))
QB = ('"' * 9 + "\n") * 2700
dq, bq, tq = desc(issue(body=QB))
check("15r a body of quotes and newlines (27,000 visible characters, each escaped to 2): cut, serialized %d within 3 of the cap; "
      "uncut it would serialize to %d > Jira's %d" % (ser16(dq), ser16(with_body(dq, QB.rstrip("\n"))), JIRA_LIMIT),
      tq["body_cut"] and CAP - 3 <= ser16(dq) <= CAP and QB.startswith(bq[body_at(dq)][1])
      and ser16(with_body(dq, QB.rstrip("\n"))) > JIRA_LIMIT and bq[-2] == ("paragraph", NOTICE + "본문 잘림 · 댓글 0개 안 실음"),
      "%d %r" % (ser16(dq), tq))
dz, bz, tz = desc(issue(body="z" * 40000))
zl = len(bz[body_at(dz)][1])
check("15s exact fill, body cut: one-unit characters fill the budget to exactly %d (notice included); one more character = %d"
      % (CAP, ser16(with_body(dz, "z" * (zl + 1)))),
      tz["body_cut"] and ser16(dz) == CAP and ser16(with_body(dz, "z" * (zl + 1))) == CAP + 1, "%d %d" % (ser16(dz), zl))
C1 = [("a", "t", "1")]
d0, _, _ = desc(issue(body="z" * 100, comments=C1))
L = 100 + CAP - ser16(d0)
d1, _, t1 = desc(issue(body="z" * L, comments=C1))
d2, b2, t2 = desc(issue(body="z" * (L + 1), comments=C1))
check("15s' exact fill, nothing cut: a body of %d fills the doc to exactly %d with the comment and no notice; one character more "
      "drops the comment and adds the notice (still ≤ the cap)" % (L, CAP),
      t1 == {"body_cut": False, "comments_total": 1, "comments_included": 1} and ser16(d1) == CAP
      and t2 == {"body_cut": False, "comments_total": 1, "comments_included": 0} and ser16(d2) <= CAP
      and b2[-2] == ("paragraph", NOTICE + "댓글 1개 안 실음"), "%r %d %r %d" % (t1, ser16(d1), t2, ser16(d2)))
ds, bs, ts = desc(issue(body="b", comments=[("a", "t", "x" * 40000), ("b", "t", "1")]))
_, _, ts1 = desc(issue(body="b", comments=[("b", "t", "1")]))
check("15s'' a comment that does not fit drops every later one, even one that would fit on its own",
      ts == {"body_cut": False, "comments_total": 2, "comments_included": 0} and ts1["comments_included"] == 1
      and ser16(ds) <= CAP, repr(ts))
da, ba, ta = desc(issue(body="😀" * 20000))
check("15s''' astral body: cut between characters (😀 = 2 units), serialized within 1 of the cap",
      ta["body_cut"] and CAP - 1 <= ser16(da) <= CAP and ba[body_at(da)][1] == "😀" * len(ba[body_at(da)][1]), repr(ta))
check("15s'''' fixed blocks that do not fit even with an empty body and the notice → PlanError", raises(
    P.move_description, issue(), "https://github.com/test/repo", "r" * CAP, [], MV_DATE) is not None, "")
check("15s5 the small fixture descriptions stay far below the cap (their payload_sha did not change)",
      all(ser16(P.move_description(d["issue"], MV_URL, d["reason"], d["related"], MV_DATE)[0]) < 2000 for d in MV_IN["rows"]), "")
for nm, a in (("a non-https repo_url", (I7, "github.com/test/repo", "r", [], MV_DATE)),
              ("a repo_url with a trailing /", (I7, "https://github.com/test/repo/", "r", [], MV_DATE)),
              ("an empty reason", (I7, "https://github.com/test/repo", "", [], MV_DATE)),
              ("a duplicate related key", (I7, "https://github.com/test/repo", "r", ["TST-1", "TST-1"], MV_DATE)),
              ("a bad plan date", (I7, "https://github.com/test/repo", "r", [], "2026-10-32")),
              ("number True", (dict(I7, number=True), "https://github.com/test/repo", "r", [], MV_DATE)),
              ("a missing key", ({k: v for k, v in I7.items() if k != "labels"}, "https://github.com/test/repo", "r", [], MV_DATE)),
              ("an int comment body", (dict(I7, comments=[{"author": "a", "created": "t", "body": 5}]),
                                       "https://github.com/test/repo", "r", [], MV_DATE))):
    check("15t move_description refuses %s" % nm, raises(P.move_description, *a) is not None, "")

SN = {"project_id": "10000", "issuetype": "10001", "account": ACCT}
pay, ptr = P.move_payload(I7, "https://github.com/test/repo", SN, "이유\n둘째", ["TST-9"], MV_DATE)
pj = json.loads(pay.decode("utf-8"))
check("15u move_payload = canonical JSON of exactly fields {project.id, issuetype.id, summary, reporter.id, assignee: null, "
      "description} (design §10f)", pay == json.dumps(pj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
      and set(pj) == {"fields"} and pj["fields"] == {"project": {"id": "10000"}, "issuetype": {"id": "10001"}, "summary": "제목",
                                                      "reporter": {"id": ACCT}, "assignee": None, "description": doc}
      and ptr == tr, pay[:120].decode("utf-8", "replace"))
PAY_HEAD = b'{"fields":{"assignee":null,"description":{'
PAY_TAIL = ('},"issuetype":{"id":"10001"},"project":{"id":"10000"},"reporter":{"id":"%s"},"summary":"제목"}}' % ACCT).encode("utf-8")
check("15u' payload golden bytes: starts %r, ends with issuetype / project / reporter.id / summary; explicit \"assignee\":null "
      "(omitting it assigns the project lead); no labels key anywhere in the fields" % PAY_HEAD.decode(),
      pay.startswith(PAY_HEAD) and pay.endswith(PAY_TAIL) and pay.count(b'"assignee":null') == 1 and "labels" not in pj["fields"]
      and b'"accountId"' not in pay and b"github-issue" not in pay, pay[:60].decode() + " … " + pay[-140:].decode())
I7b = dict(reversed(list(I7.items())), labels=["bug", "ui"])
check("15v move_payload / source_json do not depend on dict order or label order",
      P.move_payload(I7b, "https://github.com/test/repo", dict(reversed(list(SN.items()))), "이유\n둘째", ["TST-9"], MV_DATE)[0] == pay
      and P.source_json(I7b) == P.source_json(I7), "")
check("15w source_json = canonical {title, body, labels sorted, comments[{author, created, body}]} of the raw text (no CRLF "
      "normalisation)", json.loads(P.source_json(I7)) == {"title": "제목", "body": "줄 1\n줄 2\n\n", "labels": ["bug", "ui"],
      "comments": [{"author": "grace", "created": "2026-05-02T10:00:00Z", "body": "봤어요\r\n크롬"},
                   {"author": None, "created": "2026-05-03T00:00:00Z", "body": ""}]}
      and P.source_sha(I7) == hashlib.sha256(P.source_json(I7)).hexdigest(), P.source_json(I7)[:120].decode())
big = issue(body="x" * (CAP + 10), comments=[("a", "t1", "c1"), ("b", "t2", "c2")])
big2 = dict(big, body="x" * (CAP + 9) + "Q")
check("15x a change in the cut tail moves source_sha but not payload: payload_sha alone cannot see it",
      P.source_sha(big2) != P.source_sha(big) and P.move_payload(big2, "https://github.com/test/repo", SN, "r", [], MV_DATE)[0]
      == P.move_payload(big, "https://github.com/test/repo", SN, "r", [], MV_DATE)[0], "")
check("15y author '' = None (a deleted account reads the same either way)",
      P.source_json(issue(author="")) == P.source_json(issue(author=None)), "")
m = raises(P.move_payload, I7, "https://github.com/test/repo", dict(SN, issuetype="Task"), "r", [], MV_DATE)
check("15z move_payload refuses a non-numeric issuetype id", m is not None and "numeric ids" in m, repr(m))

# parse_blocks: what it reads and what it refuses
RD = {"type": "doc", "version": 1, "content": [
    {"type": "paragraph", "attrs": {"localId": "x"}, "content": [{"type": "text", "text": "a", "marks": [{"type": "strong"}]},
                                                                 {"type": "hardBreak"}, {"type": "inlineCard", "attrs": {"url": "https://u"}}]},
    {"type": "codeBlock", "attrs": {"language": None}, "content": [{"type": "text", "text": "x\ny"}]},
    {"type": "paragraph"}]}
check("15A parse_blocks: text, hardBreak → \\n, inlineCard → url; attrs / marks ignored; a paragraph without content = ''",
      P.parse_blocks(RD) == [("paragraph", "a\nhttps://u"), ("codeBlock", "x\ny"), ("paragraph", "")], repr(P.parse_blocks(RD)))
for nm, d in (("an unknown block (bulletList)", {"type": "doc", "content": [{"type": "bulletList", "content": []}]}),
              ("an unknown inline node (mention)", {"type": "doc", "content": [{"type": "paragraph", "content": [
                  {"type": "mention", "attrs": {"text": "@a"}}]}]}),
              ("an inlineCard without url", {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "inlineCard"}]}]}),
              ("a text node without text", {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text"}]}]}),
              ("content not a list", {"type": "doc", "content": [{"type": "paragraph", "content": "x"}]}),
              ("not a doc", {"type": "paragraph", "content": []}), ("a doc without content", {"type": "doc"}),
              ("a string", "text")):
    check("15B parse_blocks refuses %s" % nm, raises(P.parse_blocks, d) is not None, "")
LEN = {"type": "doc", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "a"}]},
    {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "one "}, {"type": "mention", "attrs": {"text": "@kim"}}]}]},
        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "two"}]}]}]},
    {"type": "paragraph", "content": [{"type": "emoji", "attrs": {"shortName": ":ok:"}}, {"type": "text", "text": " b"}]},
    "not a node",
    {"type": "codeBlock", "content": [{"type": "text", "text": "c"}]}]}


def lenient(d):
    """parse_blocks(d, lenient=True), or the PlanError text (so a regression is a FAIL line, not a traceback)."""
    try:
        return P.parse_blocks(d, lenient=True)
    except P.PlanError as e:
        return "PlanError: %s" % e


check("15B' parse_blocks(lenient=True): an unreadable block → ('other', its flattened text) — lists, mentions, emoji, junk; "
      "readable blocks unchanged", lenient(LEN) == [
          ("paragraph", "a"), ("other", "one @kim\ntwo"), ("other", ":ok: b"), ("other", ""), ("codeBlock", "c")],
      repr(lenient(LEN)))
check("15B'' the same doc strict → PlanError; a non-doc root → PlanError even when lenient",
      raises(P.parse_blocks, LEN) is not None and raises(P.parse_blocks, {"type": "paragraph"}, True) is not None, "")

# points_at / chore_shaped / ours_shape (design §4: chore-shaped tickets point only through block 1; §10f: no label condition —
# the bound project has no labels field, so the shape is content only: MARKER last, block 1, reporter)
R = "https://github.com/test/repo"
B11 = P.parse_blocks(P.move_description(dict(issue(n=11), body="이전 이슈 https://github.com/test/repo/issues/12 참고"),
                                        R, "r", [], MV_DATE)[0])
check("15C chore_shaped(blocks): MARKER paragraph last; another last block, a MARKER heading, or no blocks → not",
      P.chore_shaped(B11) and not P.chore_shaped(B11[:-1]) and not P.chore_shaped([]) and not P.chore_shaped(B11[:-1] + [
          ("heading", B11[-1][1])]) and not P.chore_shaped(B11[:-1] + [("paragraph", B11[-1][1] + " ")]), "")
check("15D move_url_line = block 1 exactly", B11[0] == ("paragraph", P.move_url_line(R, 11)), repr(B11[0]))
check("15E points_at: a moved ticket of #11 quoting #12's URL in its body points at #11 only",
      P.points_at(B11, R, 11) and not P.points_at(B11, R, 12), "")
HUMAN = [("paragraph", "참고 https://github.com/test/repo/issues/123 와 https://github.com/test/repo/issues/7."),
         ("codeBlock", "끝 https://github.com/test/repo/issues/45")]
check("15F points_at on a non-chore ticket: anywhere, digit boundary (/issues/12 never matches /issues/123)",
      P.points_at(HUMAN, R, 123) and P.points_at(HUMAN, R, 7) and P.points_at(HUMAN, R, 45)
      and not P.points_at(HUMAN, R, 12) and not P.points_at(HUMAN, R, 1)
      and not P.points_at(HUMAN, "https://github.com/test/rep", 123), "")
check("15G points_at on a chore-shaped ticket whose block 1 names another issue: never this one, even if quoted elsewhere",
      not P.points_at([("paragraph", P.move_url_line(R, 5))] + B11[1:], R, 11), "")
check("15G' the moved ticket with its MARKER removed reads as non-chore: then any URL in it counts (#12 quoted in the body)",
      P.points_at(B11[:-1], R, 12) and P.points_at(B11[:-1], R, 11), "")
check("15H ours_shape(blocks, reporter, acct, repo_url, n) = reporter == acct · MARKER last · block 1 = this issue's URL "
      "(MARKER date and group1 not looked at — ticket_check compares content)",
      P.ours_shape(B11, ACCT, ACCT, R, 11)
      and P.ours_shape(B11[:-1] + [("paragraph", "chore 정리 → GitHub issue #11 — by Claude triage 2020-01-01")], ACCT, ACCT, R, 11)
      and P.ours_shape(B11[:-1] + [("paragraph", "chore 정리 → GitHub issue #12 — by Claude triage 2026-10-21")], ACCT, ACCT, R, 11)
      and not P.ours_shape(B11, "other", ACCT, R, 11) and not P.ours_shape(B11, None, ACCT, R, 11)
      and not P.ours_shape(B11, ACCT, ACCT, R, 12) and not P.ours_shape(B11[:-1], ACCT, ACCT, R, 11)
      and not P.ours_shape([("paragraph", P.move_url_line(R, 5))] + B11[1:], ACCT, ACCT, R, 11), "")
D11 = P.move_description(dict(issue(n=11), body="이전 이슈 https://github.com/test/repo/issues/12 참고"), R, "r", [], MV_DATE)[0]
D11e = dict(D11, content=D11["content"][:4] + [{"type": "bulletList", "content": [{"type": "listItem", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "사람이 넣은 할 일"}]}]}]}] + D11["content"][4:])
L11 = lenient(D11e)
check("15I a chore-made description with a bullet list inserted by a person: strict parse refuses it (ticket_check sees a "
      "difference), lenient parse keeps block 1 and the MARKER — still chore_shaped, points_at #11 only, ours_shape",
      raises(P.parse_blocks, D11e) is not None and isinstance(L11, list) and L11[4] == ("other", "사람이 넣은 할 일")
      and P.chore_shaped(L11)
      and P.points_at(L11, R, 11) and not P.points_at(L11, R, 12) and P.ours_shape(L11, ACCT, ACCT, R, 11), repr(L11[:6]))

# move_truncated: the approval page and the report ask this function, never copy the notice prefix
DT, _ = P.move_description(issue(body="x" * (CAP + 10), comments=[("a", "t1", "c1")]), R, "r", [], MV_DATE)
DP, _ = P.move_description(issue(body="b", comments=[ONE] * 1200), R, "r", [], MV_DATE)   # comments cut, body whole
DN, _ = P.move_description(I7, R, "r", [], MV_DATE)


def insert_list(d, at):
    return dict(d, content=d["content"][:at] + [{"type": "bulletList", "content": [{"type": "listItem", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": NOTICE + "목록 안의 글"}]}]}]}] + d["content"][at:])


check("15J move_truncated: MOVE_NOTICE is the prefix move_description writes (one constant)",
      P.MOVE_NOTICE == NOTICE and P.parse_blocks(DT)[-2][1].startswith(P.MOVE_NOTICE), repr(P.MOVE_NOTICE))
check("15J move_truncated on strict block lists: body cut → True, comments cut → True, nothing cut → False",
      P.move_truncated(P.parse_blocks(DT)) and P.move_truncated(P.parse_blocks(DP)) and not P.move_truncated(P.parse_blocks(DN)), "")
check("15J move_truncated on lenient block lists (a person inserted a list — even one quoting the prefix, read as 'other'): "
      "truncated → True, not truncated → False",
      P.move_truncated(lenient(insert_list(DT, len(DT["content"]) - 2))) and not P.move_truncated(lenient(insert_list(DN, 5))), "")
check("15J move_truncated counts paragraphs only: a body code block that starts with the prefix is not a notice",
      not P.move_truncated(P.parse_blocks(P.move_description(issue(body=NOTICE + "본문 잘림 · 댓글 9개 안 실음"), R, "r", [],
                                                             MV_DATE)[0])), "")

# doc_from_blocks / payload_bytes: one owner for the node shapes and the field set (the writer rebuilds through these)
GOLD = {"related + 2 comments": doc, "no comments": doc0, "CRLF body": docc, "1,200 comments": d12, "quote body": dq,
        "body cut": dz, "exact fill": d1, "comment dropped": d2, "big comment dropped": ds, "astral": da, "truncated": DT,
        "plain": DN, "quoted URL": D11}
bad_rt = [nm for nm, g in GOLD.items() if P.doc_from_blocks(P.parse_blocks(g)) != g
          or P.parse_blocks(P.doc_from_blocks(P.parse_blocks(g))) != P.parse_blocks(g)]
check("15K doc_from_blocks is the exact inverse of strict parse_blocks on every generated description (%d docs)" % len(GOLD),
      not bad_rt, repr(bad_rt))
for nm, b, sub in (("a lenient 'other' block", [("other", "x")], "is not (paragraph | heading | codeBlock, text)"),
                   ("an unknown kind", [("bulletList", "x")], "is not (paragraph | heading | codeBlock, text)"),
                   ("an empty paragraph", [("paragraph", "")], "empty block text"),
                   ("an empty code block", [("codeBlock", "")], "empty codeBlock text"),
                   ("a 3-tuple", [("paragraph", "a", "b")], "is not (paragraph"),
                   ("a non-str text", [("paragraph", 5)], "is not (paragraph"),
                   ("not a list", "paragraph", "blocks must be a list")):
    m = raises(P.doc_from_blocks, b)
    check("15K' doc_from_blocks refuses %s" % nm, m is not None and sub in m, repr(m))
check("15L payload_bytes(project_id, issuetype_id, summary, account, doc) = the move_payload bytes (one field set)",
      P.payload_bytes("10000", "10001", "제목", ACCT, doc) == pay
      and P.payload_bytes("10000", "10001", "제목", ACCT, P.doc_from_blocks(P.parse_blocks(doc))) == pay, "")
for nm, a, sub in (("a non-numeric issuetype", ("10000", "Task", "s", ACCT, doc), "numeric ids"),
                   ("a zero project id", ("0", "10001", "s", ACCT, doc), "numeric ids"),
                   ("an empty account", ("10000", "10001", "s", "", doc), "account and summary non-empty"),
                   ("an empty summary", ("10000", "10001", "", ACCT, doc), "account and summary non-empty"),
                   ("a doc that is not a dict", ("10000", "10001", "s", ACCT, "doc"), "doc a dict"),
                   ("an int id", (10000, "10001", "s", ACCT, doc), "must be str")):
    m = raises(P.payload_bytes, *a)
    check("15L' payload_bytes refuses %s" % nm, m is not None and sub in m, repr(m))

print("---- %d cases, %d failed" % (n, fail))
sys.exit(1 if fail else 0)
