#!/usr/bin/env python3
"""chore-report.py — chore 정리 실행이 끝난 뒤의 결과 보고서(HTML 한 장, 팀 공유용) (2026-10-19).

    python3 -I scripts/chore-report.py --plan plan.tsv --digest <sha256> \
        --results apply-1.out [--results apply-2.out]… --verify verify.out --out report.html \
        --repo-url https://github.com/<owner>/<repo> [--payloads DIR] [--title-date YYYY-MM-DD]

입력은 이것뿐이다 (증거 폴더·판정 파일·네트워크 없음):
- --plan = 승인된 계획 TSV. 바이트 sha256 == --digest 여야 하고, 문법은 scripts/chore_plan.py 한 벌(parse_plan).
- --results = chore.sh apply 표준 출력, 여러 개면 준 순서대로 이어 붙인 실행들. RESULT / SUMMARY / ABORTED 줄만 받는다.
  SUMMARY·ABORTED의 run_id = 계획의 run_id, SUMMARY의 ok/skip/fail/unknown = 그 실행 RESULT 줄 수, ABORTED의 ok/skip/fail
  = 그 실행 RESULT 줄 수. 행마다 마지막 결과가 이기고(엔진 verify의 lastres와 같은 규칙: 앞서 OK였던 행의 SKIP은 확인
  대상), 두 번 시도된 행도 한 번만 센다.
- --verify = chore.sh verify 표준 출력. VERIFY 줄 + 마지막 줄 VERIFY-SUMMARY 하나. fail/warn/unresolved = 그 상태 줄 수,
  success=yes ⇔ fail=0 ∧ unresolved=0, run=incomplete ⇔ 결과의 마지막 SUMMARY/ABORTED가 ABORTED. 행 VERIFY 줄은 엔진이
  내는 행에만 있어야 한다(Jira 행 = 정확히 하나, 그 밖의 실행 행 = 결과가 있고 '앞선 OK·실패 없는 SKIP만'이 아니면 하나,
  아니면 없음. 예외: 닫기 행의 마지막이 SKIP changed since approval이고 앞선 OK가 없으면 엔진이 닫힘을 확인한다 —
  앞선 실패가 없으면 줄 없음 또는 정확히 OK RECONCILED_CLOSE, 있으면 RESOLVED 또는 그 OK) — 다르면 다른 결과로 만든
  확인 출력이다.
- move-issue 행(v4.3, GitHub 이슈 → 바인딩 Jira 프로젝트의 새 티켓 + 이슈 닫기): RESULT = Jira 행처럼 정확히 6열(마지막
  attempt=), 사유 분류는 move-issue 허용표(MOVE_CLASSES — jira-transition 표와 따로). VERIFY = 행마다 정확히 하나, 상태는
  마지막 RESULT로 정해진 집합 안(MOVE_VERIFY = 계약 §4 표; WARN·NOT-SCHEDULED도 이 행에 있다), 밖이면 다른 결과로 만든
  확인 출력. OK/WARN = 이 실행들 어딘가에 RESULT OK moved가 있으면 '이번 실행이 옮김', 없으면 '이미 옮겨져 있음'.
  '이슈 → 티켓' 칸의 키 = 확인 문구의 첫 키, 없으면 마지막 결과 글의 첫 키(계약 §2), 키를 여럿 드는 확인 문구(§7 행 4·11)는
  전부. 둘 다 키가 없으면 계획의 adopt 키를 "(승인 때 고른 기존 티켓)"으로 보인다 — 계약에 없는 해석(계획에 있는 사실이라
  보인다). 끝나지 않은 행의 다음 할 일 = 계약 §5의 정해진 사유 글로(move_exit): 확인 문구의 행이 먼저 이기고(행 2·6·10·10b의
  사유 → §5 표, 행 4 → M4, 행 3·5·7·11·12·13 → 그 행의 출구), 마지막 SKIP manual 사유는 확인 문구가 어느 행에도 안 맞을 때만
  본다 — 행 3의 예외: 이 실행들에 OK moved·already-done이 있으면 '이 계획이 옮겨 닫은 이슈' 출구(MOVE_ROW3_DONE — 닫힌
  이슈는 다음 정리가 다시 만들지 않으니 티켓 지우기 안내 없음, 2026-10-26), 아니면 사유 M3(승인한 티켓이 없어짐)·M19·M20
  (만든 직후 확인 실패)은 그 사유의 출구(조정자 결정 2026-10-23; M19·M20은 행 3의 티켓 지우기 출구를 보이지 않으려고 넓힘).
  행 3·M5의 "다음 정리가 새로 만듦"은 "이슈가 열려 있으면"을 앞에 단다(닫힌 이슈는 다음 정리가 보지 않는다).
- --payloads DIR = 승인 때 만든 새 티켓 본문 파일 폴더. 계획에 move-issue 행이 있을 때만, 그때는 필수: 행마다
  issue-<N>.json 하나, 그 밖 항목 없음, 파일 sha256 == 그 행 snapshot payload_sha, JSON이고 fields.description이
  chore_plan.parse_blocks로 읽힘 — 하나라도 어긋나면 exit 1. 설명이 잘렸는지(블록 10 잘림 안내)를 보이는 데만 쓴다.
- RESULT·VERIFY 줄의 ref는 계획 3열 바이트(인코딩된 그대로)라서 행과는 penc(디코딩한 ref)로 맞춘다(정규 인코딩이 하나뿐).
- 수량은 전부 행에서 센다. 영역 합계 = 행 합(검토 축·실행 축 각각), 어긋나면 exit 1 — 페이지를 만들지 않는다.
- 형식 오류·불일치 = stderr 한 줄 + exit 1, --out은 건드리지 않는다(임시 파일 → os.replace).
- 표준 라이브러리만, 출력 HTML에 스크립트·외부 글꼴·외부 요청 없음(펼침 = <details>). 계획·결과에서 온 글자는 모두
  이스케이프하고, 보이지 않는 문자는 승인 화면(chore-render.py)과 같은 방식으로 테두리 친 U+XXXX 표지로 드러낸다.
"""
import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import shlex
import sys
import tempfile
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


def _load_plan_module():
    """계획 TSV 문법 = scripts/chore_plan.py 한 벌. python3 -I로는 같은 폴더 모듈이 import 경로에 없어서 경로로 읽는다."""
    spec = importlib.util.spec_from_file_location("chore_plan", Path(__file__).resolve().parent / "chore_plan.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


P = _load_plan_module()
PlanError = P.PlanError
JIRA = P.JIRA_ACTION
MOVE = P.MOVE_ACTION
HELPER_ACTIONS = (JIRA, MOVE)          # Jira 도우미(chore-jira.py)가 결과를 내는 행 — RESULT 6열(attempt=)
LOCAL_ACTIONS = P.LOCAL_ACTIONS
KST = timezone(timedelta(hours=9))


class ReportError(Exception):
    pass


# ───────────────────────── 입력 줄 문법 ─────────────────────────

RESULT_STATUSES = ("OK", "SKIP", "FAIL", "UNKNOWN", "NOT-ATTEMPTED")
BAD_RESULTS = ("FAIL", "UNKNOWN", "NOT-ATTEMPTED")
SENT_RESULTS = ("OK", "FAIL", "UNKNOWN")          # 그 실행이 바깥에 요청을 보냈을 수 있는 결과
VERIFY_STATUSES = ("OK", "WARN", "RESOLVED", "UNRESOLVED", "FAIL", "NOT-SCHEDULED", "INCOMPLETE")
# 엔진이 행 아닌 확인 줄에 쓰는 상태 (chore.sh cmd_verify: p-invariant OK/FAIL/WARN, p-touched FAIL, run INCOMPLETE/UNRESOLVED)
META_VERIFY = {"p-invariant": ("OK", "FAIL", "WARN"), "p-touched": ("FAIL",), "run": ("INCOMPLETE", "UNRESOLVED")}
# Jira RESULT 사유 분류 (design-jira §5 V.2) — OK/SKIP/FAIL은 "<class>: <text>", UNKNOWN/NOT-ATTEMPTED는 분류 없음
JIRA_CLASSES = {"OK": ("moved", "already-done"),
                "SKIP": ("identity", "manual", "at-target", "assignee", "changed", "proof", "transition"),
                "FAIL": ("comment-rejected", "changed-after-comment", "transition-rejected")}
ALL_CLASSES = {c for cs in JIRA_CLASSES.values() for c in cs}
# move-issue RESULT 사유 분류 (계약 §1, design v9 §6) — jira-transition 표와 따로 본다
MOVE_CLASSES = {"OK": ("moved", "already-done"),
                "SKIP": ("account", "changed", "manual", "exists", "type"),
                "FAIL": ("create-rejected", "comment-failed", "close-failed")}
ALL_MOVE_CLASSES = {c for cs in MOVE_CLASSES.values() for c in cs}
# move-issue 행: 마지막 RESULT (상태, 분류) → verify-rows가 낼 수 있는 VERIFY 상태 (계약 §4 표 그대로, design v9 §7).
# None = 이어 붙인 실행 어디에도 RESULT가 없는 행.
MOVE_VERIFY = {("OK", "moved"): ("OK", "WARN", "FAIL", "UNRESOLVED"),
               ("OK", "already-done"): ("OK", "WARN", "FAIL", "UNRESOLVED"),
               ("SKIP", "manual"): ("UNRESOLVED", "FAIL"),
               ("SKIP", "exists"): ("UNRESOLVED", "FAIL"),
               ("SKIP", "account"): ("RESOLVED", "UNRESOLVED", "FAIL"),
               ("SKIP", "changed"): ("RESOLVED", "UNRESOLVED", "FAIL"),
               ("SKIP", "type"): ("RESOLVED", "UNRESOLVED", "FAIL"),
               ("FAIL", "create-rejected"): ("FAIL", "UNRESOLVED"),
               ("FAIL", "comment-failed"): ("UNRESOLVED", "FAIL"),
               ("FAIL", "close-failed"): ("UNRESOLVED", "FAIL"),
               ("UNKNOWN", None): ("UNRESOLVED", "FAIL", "RESOLVED"),
               ("NOT-ATTEMPTED", None): ("UNRESOLVED", "FAIL", "RESOLVED"),
               None: ("NOT-SCHEDULED", "UNRESOLVED", "FAIL")}
MOVE_EXEC = {"RESOLVED": "skip", "FAIL": "bad", "UNRESOLVED": "bad", "NOT-SCHEDULED": "notrun"}   # OK/WARN = done | already
ATTEMPT_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}")
JIRA_CLASS = re.compile(r"([a-z-]+): (.*)", re.S)
COUNT = re.compile(r"0|[1-9][0-9]*")
MOVED_TEXT = "이번 실행이 옮김"                  # design-jira §5 rule 4 — 이 VERIFY 문구만이 '이번 실행이 옮김'을 정한다
# verify-rows 규칙 1(신원 비교)은 규칙 3(SKIP manual)보다 먼저다 — 멈춘 행도 이 두 문구로는 RESOLVED / FAIL이 될 수 있다
ID_RESOLVED = "신원 바뀜, 쓰기 없음"
ID_FAIL = "신원 불일치(쓰기 있었음)"
NOTHING_TO_CHECK = "nothing to check"            # chore.sh verify_ok_row의 그 밖 행(작업 폴더 목록 정리)
# 닫기 행의 유일한 결과가 SKIP changed since approval(chore.sh stage_close)일 때 cmd_verify가 낼 수 있는 OK 문구 — 이 한
# 문자열 그대로만(chore.sh cmd_verify). 앞부분이 같고 끝이 다른 것(" (was UNKNOWN)" = 마지막 결과가 UNKNOWN인 행 등)은 다른
# 결과로 만든 확인 출력. 두 값 모두 시험 13b·13c가 chore.sh 본문과 맞춰 본다.
CHANGED_SKIP = "changed since approval (now: "
RECONCILED_CLOSE = "reconciled: CLOSED with the approved comment at verify (rerun SKIP changed)"
WRITE_HINTS = ("쓰기 있었음", "댓글만 남음", "댓글을 보냈")   # Jira VERIFY 문구 중 '쓰기가 있었다'를 말하는 것


def read_bytes(path, what):
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError as e:
        raise ReportError("cannot read %s %s: %s" % (what, path, e.strerror or e))


def split_lines(data, path, what):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ReportError("%s %s is not UTF-8 (%s)" % (what, path, e))
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        raise ReportError("%s %s is empty" % (what, path))
    return lines


def kv_fields(cols, where):
    out = {}
    for c in cols:
        k, eq, v = c.partition("=")
        if not eq or not k:
            raise ReportError("%s: field without key=value: %r" % (where, c[:40]))
        if k in out:
            raise ReportError("%s: duplicate field %s" % (where, k))
        out[k] = v
    return out


def count_field(fields, key, where):
    v = fields.get(key)
    if v is None or not COUNT.fullmatch(v):
        raise ReportError("%s: %s= is missing or not a count" % (where, key))
    return int(v)


def enc_ref(ref):
    """행 ref → RESULT·VERIFY 줄의 ref(계획 3열의 인코딩된 바이트). 접두 remote:/local:은 실행 행에 없다."""
    return P.penc(ref).decode("utf-8")


def parse_result_line(cols, where, idx):
    """RESULT 줄 하나 → 결과 dict. Jira 도우미 행(jira-transition, move-issue) = 정확히 6열(마지막 attempt=), 사유 분류는
    그 action의 상태별 허용표 안(jira-transition = JIRA_CLASSES, design-jira V.2; move-issue = MOVE_CLASSES, 계약 §1);
    그 밖의 행 = 정확히 5열."""
    if len(cols) < 5:
        raise ReportError("%s: RESULT needs 5 tab-separated columns, got %d" % (where, len(cols)))
    st, action, ref, reason = cols[1:5]
    if st not in RESULT_STATUSES:
        raise ReportError("%s: unknown RESULT status %r" % (where, st))
    row = idx.get((action, ref))
    if row is None:
        raise ReportError("%s: RESULT for %s %s, which is not an action row of this plan" % (where, action, ref))
    cls, text, attempt = None, reason, None
    if action in HELPER_ACTIONS:
        what = "Jira" if action == JIRA else "move-issue"
        if len(cols) != 6 or not cols[5].startswith("attempt=") or not ATTEMPT_ID.fullmatch(cols[5][8:]):
            raise ReportError("%s: a %s RESULT has exactly 6 columns ending in attempt=<YYYYMMDDTHHMMSSZ-8hex>" % (where, what))
        attempt = cols[5][8:]
        classes, every = (JIRA_CLASSES, ALL_CLASSES) if action == JIRA else (MOVE_CLASSES, ALL_MOVE_CLASSES)
        m = JIRA_CLASS.match(reason)
        if st in classes:
            if not m or m.group(1) not in classes[st]:
                raise ReportError("%s: %s %s reason must start with one of %s followed by ': '"
                                  % (where, what, st, "/".join(classes[st])))
            cls, text = m.group(1), m.group(2)
        elif m and m.group(1) in every:
            raise ReportError("%s: %s %s reason carries a class (%s) — UNKNOWN / NOT-ATTEMPTED have none"
                              % (where, what, st, m.group(1)))
    elif len(cols) != 5:
        raise ReportError("%s: a %s RESULT has exactly 5 columns, got %d" % (where, action, len(cols)))
    return {"status": st, "row": row, "reason": reason, "cls": cls, "text": text, "attempt": attempt, "where": where}


def parse_results(paths, hdr, idx):
    """apply 출력들 → (실행 목록, 결과 목록). 실행 = 끝 줄(SUMMARY·ABORTED)로 닫힌 RESULT 묶음. 거절(ReportError):
    끝 줄 없이 끝난 묶음, 끝 줄 run_id ≠ 계획, 끝 줄 수 ≠ 그 묶음 줄 수, 한 묶음에 같은 행 두 번, Jira 결과의
    attempt ≠ 끝 줄 attempt, 두 끝 줄의 같은 attempt(같은 실행을 두 번 줌), 바이트가 같은 결과 파일 두 번."""
    runs, results, seen_files, seen_attempts = [], [], {}, {}
    for path in paths:
        name = os.path.basename(path)
        data = read_bytes(path, "results file")
        h = hashlib.sha256(data).hexdigest()
        if h in seen_files:
            raise ReportError("results %s has the same bytes as %s — one apply output given twice" % (path, seen_files[h]))
        seen_files[h] = path
        seg, keys = [], set()
        for no, line in enumerate(split_lines(data, path, "results file"), start=1):
            where = "results %s line %d" % (name, no)
            cols = line.split("\t")
            kind = cols[0]
            if kind == "RESULT":
                res = parse_result_line(cols, where, idx)
                key = (res["row"]["action"], res["row"]["ref"])
                if key in keys:
                    raise ReportError("%s: second RESULT for %s %s in one run" % (where, key[0], cols[3]))
                keys.add(key)
                seg.append(res)
            elif kind in ("SUMMARY", "ABORTED"):
                f = kv_fields(cols[1:], where)
                if f.get("run_id") != hdr["run_id"]:
                    raise ReportError("%s: %s run_id=%s is not the plan's run %s" % (where, kind, f.get("run_id"), hdr["run_id"]))
                attempt = f.get("attempt")
                if attempt is not None and not ATTEMPT_ID.fullmatch(attempt):
                    raise ReportError("%s: %s attempt=%r is malformed" % (where, kind, attempt))
                if f.get("scope") not in (None, "full", "only-group"):
                    raise ReportError("%s: %s scope must be full or only-group" % (where, kind))
                n = {s: sum(1 for x in seg if x["status"] == s) for s in RESULT_STATUSES}
                checks = [("ok", n["OK"]), ("skip", n["SKIP"]), ("fail", n["FAIL"])]
                una = f.get("unattempted")
                if kind == "SUMMARY":
                    checks.append(("unknown", n["UNKNOWN"] + n["NOT-ATTEMPTED"]))
                for key, want in checks:
                    if count_field(f, key, where) != want:
                        raise ReportError("%s: %s %s=%s but this run has %d such RESULT lines — results do not add up"
                                          % (where, kind, key, f[key], want))
                if kind == "ABORTED":
                    unk = count_field(f, "unknown", where)
                    if una is None or not (una == "?" or COUNT.fullmatch(una)):
                        raise ReportError("%s: ABORTED unattempted= is missing or not a count" % where)
                    got = unk + (int(una) if una != "?" else 0)
                    if got != n["UNKNOWN"] + n["NOT-ATTEMPTED"]:
                        raise ReportError("%s: ABORTED unknown=%d unattempted=%s but this run has %d UNKNOWN / NOT-ATTEMPTED "
                                          "lines — results do not add up" % (where, unk, una, n["UNKNOWN"] + n["NOT-ATTEMPTED"]))
                for x in seg:
                    if x["attempt"] is not None and x["attempt"] != attempt:
                        raise ReportError("%s: Jira RESULT attempt=%s does not belong to this run's closing line (attempt=%s)"
                                          % (x["where"], x["attempt"], attempt))
                if attempt is not None:
                    if attempt in seen_attempts:
                        raise ReportError("%s: attempt=%s already closed %s — one apply run given twice"
                                          % (where, attempt, seen_attempts[attempt]))
                    seen_attempts[attempt] = where
                for x in seg:
                    x["run"] = len(runs)
                results.extend(seg)
                runs.append({"kind": kind, "file": name, "scope": f.get("scope"), "attempt": attempt, "rows": len(seg),
                             "at": f.get("at"), "unattempted": una, "reason": f.get("reason")})
                seg, keys = [], set()
            else:
                raise ReportError("%s: not a RESULT / SUMMARY / ABORTED line" % where)
        if seg:
            raise ReportError("results %s: 결과 파일이 끝까지 기록되지 않음 — %d RESULT lines after the last SUMMARY / ABORTED"
                              % (name, len(seg)))
    if not runs:
        raise ReportError("results have no SUMMARY or ABORTED line — not an apply output")
    return runs, results


def parse_verify(path, idx, hdr, runs):
    """verify 출력 → (행 VERIFY, 행 아닌 확인 줄, 요약). 거절: 모르는 줄·상태, 계획에 없는 행, 한 행 두 줄, 엔진이 그 확인
    줄에 쓰지 않는 상태, run 줄 ref ≠ 계획 run_id, 보호 브랜치 줄(p-invariant) ≠ 머리 줄 Ptips 이름 한 번씩, 요약 없음·요약
    뒤 줄, 요약 수 ≠ 줄 수, success·run 모순(마지막 실행이 멈췄으면 run=incomplete + INCOMPLETE 줄, 그 실행이 행을 못 셌으면
    UNRESOLVED run 줄)."""
    name = os.path.basename(path)
    rows, meta, summary = {}, [], None
    counts = {s: 0 for s in VERIFY_STATUSES}
    ptips = {enc_ref(n) for n, _ in hdr["Ptips"]}
    deletes = {k[1] for k in idx if k[0] == "delete-remote"}
    seen_p = set()
    for no, line in enumerate(split_lines(read_bytes(path, "verify file"), path, "verify file"), start=1):
        where = "verify %s line %d" % (name, no)
        if summary is not None:
            raise ReportError("%s: line after VERIFY-SUMMARY" % where)
        cols = line.split("\t")
        if cols[0] == "VERIFY":
            if len(cols) != 5:
                raise ReportError("%s: VERIFY needs 5 tab-separated columns, got %d" % (where, len(cols)))
            st, action, ref, text = cols[1:]
            if st not in VERIFY_STATUSES:
                raise ReportError("%s: unknown VERIFY status %r" % (where, st))
            counts[st] += 1
            if action in META_VERIFY:
                if st not in META_VERIFY[action]:
                    raise ReportError("%s: VERIFY %s is not a status the engine gives a %s line" % (where, st, action))
                if action == "run" and ref != hdr["run_id"]:
                    raise ReportError("%s: VERIFY run line names run %s, the plan is run %s" % (where, ref, hdr["run_id"]))
                if action == "p-invariant":
                    if ref not in ptips or ref in seen_p:
                        raise ReportError("%s: protected-branch line for %s is not one of the plan's protected tips, or repeats"
                                          % (where, ref))
                    seen_p.add(ref)
                if action == "p-touched" and ref not in deletes:
                    raise ReportError("%s: p-touched names %s, which is not a remote delete of this plan" % (where, ref))
                meta.append({"status": st, "action": action, "ref": ref, "text": text})
                continue
            row = idx.get((action, ref))
            if row is None:
                raise ReportError("%s: VERIFY for %s %s, which is not an action row of this plan" % (where, action, ref))
            if (action, ref) in rows:
                raise ReportError("%s: second VERIFY line for %s %s" % (where, action, ref))
            if st == "INCOMPLETE" or (action not in HELPER_ACTIONS and st in ("WARN", "NOT-SCHEDULED")):
                raise ReportError("%s: VERIFY %s is not a status the engine gives a %s row" % (where, st, action))
            rows[(action, ref)] = {"status": st, "text": text}
        elif cols[0] == "VERIFY-SUMMARY":
            f = kv_fields(cols[1:], where)
            summary = {k: count_field(f, k, where) for k in ("fail", "warn", "unresolved")}
            if f.get("run") not in ("complete", "incomplete") or f.get("success") not in ("yes", "no"):
                raise ReportError("%s: VERIFY-SUMMARY run= must be complete|incomplete and success= yes|no" % where)
            summary["run"], summary["success"] = f["run"], f["success"]
        else:
            raise ReportError("%s: not a VERIFY / VERIFY-SUMMARY line" % where)
    if summary is None:
        raise ReportError("verify %s has no VERIFY-SUMMARY line" % name)
    for key, st in (("fail", "FAIL"), ("warn", "WARN"), ("unresolved", "UNRESOLVED")):
        if summary[key] != counts[st]:
            raise ReportError("verify %s: VERIFY-SUMMARY %s=%d but there are %d VERIFY %s lines — totals do not add up"
                              % (name, key, summary[key], counts[st], st))
    if (summary["success"] == "yes") != (summary["fail"] == 0 and summary["unresolved"] == 0):
        raise ReportError("verify %s: success=%s contradicts fail=%d unresolved=%d"
                          % (name, summary["success"], summary["fail"], summary["unresolved"]))
    if seen_p != ptips:
        raise ReportError("verify %s: %d of the plan's %d protected tips have no protected-branch line — verify output is cut"
                          % (name, len(ptips - seen_p), len(ptips)))
    last = runs[-1]
    want_run = "incomplete" if last["kind"] == "ABORTED" else "complete"
    run_lines = [x["status"] for x in meta if x["action"] == "run"]
    want_lines = (["INCOMPLETE"] + (["UNRESOLVED"] if last["unattempted"] == "?" else [])) if want_run == "incomplete" else []
    if summary["run"] != want_run or sorted(run_lines) != sorted(want_lines):
        raise ReportError("verify says run=%s (run lines %s) but the last apply in the results %s — verify came from other results"
                          % (summary["run"], ",".join(run_lines) or "none",
                             "was ABORTED" if want_run == "incomplete" else "finished (SUMMARY)"))
    return rows, meta, summary


def load_payloads(path, rows):
    """--payloads DIR(계약 §3) → move-issue 행마다 row["payload"] = {"blocks", "trunc"}. 계획에 move-issue 행이 있으면 필수.
    없는 계획: 안 줘도 되고, 주면 있는 빈 폴더여야 한다(항목 하나도 없음, 점 파일 포함 — 스킬은 언제나 주고 build는 move 행이
    없어도 빈 폴더를 만든다; 체인 규칙 2026-10-23). 거절: 행에 없는 항목, 빠진 파일, 일반 파일 아님, sha256 ≠ snapshot payload_sha, UTF-8 JSON 아님,
    fields.description이 chore_plan.parse_blocks로 안 읽힘. 잘림 판단은 chore_plan.move_truncated 한 벌(안내 머리 글을 여기에
    베끼지 않는다); trunc = 잘렸으면 그 안내 문단(블록 10, chore_plan.MOVE_NOTICE로 시작)의 글, 아니면 None."""
    moves = [r for r in rows if r["action"] == MOVE]
    if path is None:
        if moves:
            raise ReportError("the plan has %d move-issue rows — --payloads DIR (the payload files written with the approved "
                              "plan) is required" % len(moves))
        return
    try:
        names = set(os.listdir(path))
    except OSError as e:
        raise ReportError("cannot read --payloads %s: %s" % (path, e.strerror or e))
    if not moves:
        if names:
            raise ReportError("--payloads %s must be an empty folder — the plan has no move-issue rows, the folder has %d "
                              "entries (first: %r)" % (path, len(names), sorted(names)[0]))
        return
    want ={"issue-%d.json" % r["move"]["number"]: r for r in moves}
    extra = sorted(names - set(want))
    if extra:
        raise ReportError("--payloads %s has %d entries that belong to no move-issue row of this plan (first: %r)"
                          % (path, len(extra), extra[0]))
    for r in moves:
        name = "issue-%d.json" % r["move"]["number"]
        p = os.path.join(path, name)
        if name not in names:
            raise ReportError("--payloads %s has no %s for move-issue %s" % (path, name, r["ref"]))
        if not os.path.isfile(p):
            raise ReportError("--payloads %s: %s is not a regular file" % (path, name))
        data = read_bytes(p, "payload file")
        got = hashlib.sha256(data).hexdigest()
        if got != r["move"]["payload_sha"]:
            raise ReportError("payload %s sha256 %s != the plan's payload_sha %s for %s — not the approved payload"
                              % (name, got, r["move"]["payload_sha"], r["ref"]))
        try:
            doc = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as e:
            raise ReportError("payload %s is not UTF-8 JSON (%s)" % (name, e))
        fields = doc.get("fields") if isinstance(doc, dict) else None
        try:
            blocks = P.parse_blocks(fields.get("description") if isinstance(fields, dict) else None)
            cut = P.move_truncated(blocks)
        except PlanError as e:
            raise ReportError("payload %s fields.description: %s" % (name, e))
        notice = [text for kind, text in blocks if kind == "paragraph" and text.startswith(P.MOVE_NOTICE)] if cut else []
        r["payload"] = {"blocks": blocks, "trunc": notice[0] if notice else None}


# ───────────────────────── 분류 ─────────────────────────

AREAS = ("pr", "issue", "jira", "branch")
AREA_NAME = {"pr": "PR", "issue": "이슈", "jira": "Jira", "branch": "브랜치"}
REVIEW_KEYS = ("act", "keep", "ambiguous", "out")
EXEC_KEYS = ("done", "already", "unchecked", "skip", "bad", "notrun")

# 보존 브랜치 행의 엔진 사유(증거 칸의 앞부분, chore.sh report) → 코드 → 문구. 순서 = 화면 순서. 제외 = HOLD_OUT.
HOLD_PREFIX = (("protected (", "protected"), ("local delete held", "local-held"),
               ("checked out in a worktree", "checked-out"), ("in use by a rebase/bisect", "checked-out"),
               ("merge commit not found in current history", "merge-not-in-base"),
               ("merge commit cannot be verified", "merge-commit-unknown"),
               ("contained in ", "contained-hold"), ("stale ", "stale"), ("upstream gone", "stale"))
HOLD_LABELS = (
    ("protected", "보호 규칙에 걸린 브랜치 — 손대지 않음"),
    ("merge-not-in-base", "현재 통합 히스토리에서 병합 커밋을 확인하지 못한 브랜치 — 보존"),
    ("merge-commit-unknown", "병합 커밋 확인 불가 — 보존"),
    ("same-as-integration-tip", "통합 브랜치 끝과 같은 커밋인 브랜치 — 보존"),
    ("contained-hold", "통합 브랜치에 내용은 들어 있지만 정확히 맞는 병합 PR이 없는 브랜치 — 보존"),
    ("stale", "오래됐지만 병합 근거가 없는 브랜치 — 보존"),
    ("checked-out", "작업 폴더에서 열려 있는 로컬 브랜치 — 보존"),
    ("local-held", "로컬 브랜치 — 이번 실행에서는 정리하지 않음"),
    ("worktree-prune", "작업 폴더 목록 정리 — 이번 실행에서는 하지 않음"),
    ("?", "그 밖의 이유로 남기는 브랜치 — 보존"),
)
HOLD_OUT = {"protected", "local-held", "worktree-prune"}


def hold_code(row):
    if row["ref"] == ".":
        return "worktree-prune"
    ev = row["evidence"]
    if ev.startswith("same as ") and " tip — hold" in ev:
        return "same-as-integration-tip"
    for prefix, code in HOLD_PREFIX:
        if ev.startswith(prefix):
            return code
    return "?"


def classify(row):
    """행 → (영역, 검토 결과, 세부). 검토 결과: act = 실행 행(닫기·옮김·지우기), keep = 판정 후 남김, ambiguous = 결정 필요,
    out = 판정 안 함·제외. inventory 행(jira#<PROJECT>)은 영역 행이 아니라 Jira 전체 수(meta)."""
    a, ref = row["action"], row["ref"]
    if a == "close-pr":
        return "pr", "act", "close"
    if a == "close-issue":
        return "issue", "act", "close"
    if a == MOVE:                    # 이슈 영역의 실행 행이지만 닫기와 따로 센다(세부 move)
        return "issue", "act", "move"
    if a == JIRA:
        return "jira", "act", row["jira"]["level"]
    if a == "delete-remote" or a in LOCAL_ACTIONS:
        return "branch", "act", a
    j = row.get("jira")
    if j is not None:
        if j["kind"] == "inventory":
            return "meta", None, "inventory"
        v = j["evidence"]["v"]
        return "jira", {"KEEP": "keep", "TO-QA": "keep", "TO-CLOSED": "keep", "AMBIGUOUS": "ambiguous",
                        "NOT-JUDGED": "out", "EXCLUDED": "out"}[v], v
    u = row.get("unit")
    if u is not None:
        v = u["evidence"]["v"]
        return u["kind"], {"KEEP": "keep", "AMBIGUOUS": "ambiguous", "NOT-JUDGED": "out"}[v], v
    if P.PR_REF.fullmatch(ref):
        return "pr", "out", "plain"
    if P.ISSUE_REF.fullmatch(ref):
        return "issue", "out", "plain"
    code = hold_code(row)
    return "branch", "out" if code in HOLD_OUT else "keep", code


def expected_verify(row, all_only_group):
    """그 행의 마지막 결과에서 엔진이 낼 수 있는 VERIFY 상태들(None = 줄을 내지 않음; 상태 묶음 안의 None = 줄이 없어도
    됨). 그 밖 행 = chore.sh cmd_verify의 lastres 표, Jira = design-jira §5 규칙 0·3과 '옮김 판정은 VERIFY 문구만',
    move-issue = 계약 §4 표(MOVE_VERIFY — 언제나 줄 하나)."""
    res = row["results"]
    if row["action"] == MOVE:
        return MOVE_VERIFY[(res[-1]["status"], res[-1]["cls"]) if res else None]
    if row["action"] == JIRA:
        if not res:
            return ("NOT-SCHEDULED",) if all_only_group else ("FAIL",)
        last = res[-1]
        if last["status"] == "SKIP" and last["cls"] == "manual":
            return ("UNRESOLVED", "RESOLVED", "FAIL")      # RESOLVED / FAIL = 규칙 1 문구일 때만 (exec_outcome)
        return ("OK", "WARN", "RESOLVED", "UNRESOLVED", "FAIL")
    if not res:
        return None
    last, st = res[-1], res[-1]["status"]
    if st == "OK" or (st == "SKIP" and row["everok"]):
        return ("OK", "FAIL")
    if st == "SKIP" and row["prevbad"] == "UNKNOWN" and row["action"] == "delete-remote" and last["reason"].split(" ", 1)[0] == "gone":
        return ("OK", "FAIL")
    if changed_close(row):
        # 다시 실행이 이미 닫힌 것을 봄(닫은 실행은 엔진째 SIGKILL로 빠졌을 수 있음, SKILL.md 10단계) — 엔진은 닫힘 + 계획 뒤
        # 승인 댓글을 먼저 본다: 보이면 정확히 OK RECONCILED_CLOSE, 아니면 prevbad 없음 = 줄 없음, 있음 = RESOLVED
        return ("RESOLVED", "OK") if row["prevbad"] else (None, "OK")
    if st == "SKIP":
        return ("RESOLVED",) if row["prevbad"] else None
    if st == "UNKNOWN":
        return ("OK", "UNRESOLVED")
    return ("UNRESOLVED",)


def changed_close(row):
    """닫기 행의 마지막 결과가 SKIP changed since approval이고 앞선 OK가 없음(chore.sh cmd_verify가 닫힘 + 승인 댓글을
    먼저 보는 행). 이 행의 OK 문구는 RECONCILED_CLOSE 한 문자열뿐이다."""
    last = row["results"][-1] if row["results"] else None
    return (row["action"] in ("close-pr", "close-issue") and last is not None and last["status"] == "SKIP"
            and not row["everok"] and last["reason"].startswith(CHANGED_SKIP))


def exec_outcome(row, all_only_group):
    """실행 행의 결과 = 엔진 verify가 낸 줄. 그 줄이 마지막 결과와 맞지 않으면(없어야 할 줄·빠진 줄·맞지 않는 상태)
    다른 결과로 만든 확인 출력 = ReportError."""
    v, a = row["verify"], row["action"]
    where = "%s %s" % (a, row["ref"])
    want = expected_verify(row, all_only_group)
    last = row["results"][-1] if row["results"] else None
    if want is None:
        if v is not None:
            raise ReportError("verify output has a line for %s, which these results %s — verify came from other results"
                              % (where, "only skipped" if last else "never ran"))
        return "skip" if last else "notrun"
    if v is None:
        if None in want:              # changed_close, 앞선 실패 없음: 엔진이 확인했고 승인 댓글과 함께 닫힌 것을 못 봄
            row["checked_skip"] = True
            return "skip"
        raise ReportError("verify output has no line for %s (last result %s) — run verify on the same concatenated results"
                          % (where, last["status"] if last else "none"))
    if v["status"] not in want:
        raise ReportError("verify says %s for %s but its last result is %s%s — the engine gives %s; verify came from other results"
                          % (v["status"], where, last["status"] if last else "none",
                             " " + last["cls"] if last and last["cls"] else "", "/".join(x or "no line" for x in want)))
    st = v["status"]
    if st == "OK" and v["text"] == RECONCILED_CLOSE and not changed_close(row):
        raise ReportError("verify says OK %r for %s, whose last result is not SKIP changed since approval on a close row with "
                          "no earlier OK — the engine prints that text nowhere else; verify came from other results"
                          % (v["text"], where))
    if st == "OK" and changed_close(row) and v["text"] != RECONCILED_CLOSE:
        raise ReportError("verify says OK %r for %s, %s — the engine gives %s there, or exactly OK %r; verify came from other results"
                          % (v["text"][:100], where, "whose last result is SKIP changed since approval after an earlier %s"
                             % row["prevbad"] if row["prevbad"] else "which these results only skipped (changed since approval)",
                             "RESOLVED" if row["prevbad"] else "no line", RECONCILED_CLOSE))
    if a == MOVE:
        # 계약 §4: OK/WARN = 이 실행들 어딘가에 OK moved(이번 실행이 GitHub 이슈를 닫음)가 있으면 이번 실행이 옮김, 없으면 이미
        # 옮겨져 있음(앞서 빠진 실행이 옮겼거나 승인 전에 옮겨져 있던 것)
        if st in ("OK", "WARN"):
            row["moved"] = any(x["status"] == "OK" and x["cls"] == "moved" for x in row["results"])
            return "done" if row["moved"] else "already"
        return MOVE_EXEC[st]
    if a == JIRA:
        if last and last["status"] == "SKIP" and last["cls"] == "manual" and st != "UNRESOLVED" \
                and not v["text"].startswith(ID_RESOLVED if st == "RESOLVED" else ID_FAIL):
            raise ReportError("verify says %s %r for %s but its last result is SKIP manual — the engine gives UNRESOLVED there, "
                              "or RESOLVED / FAIL only for a changed ticket identity; verify came from other results"
                              % (st, v["text"][:60], where))
        moved = st == "OK" and v["text"].startswith(MOVED_TEXT)
        # "이번 실행이 옮김" = 일지에 transition-ok(chore-jira.py rule 4). 그 줄 뒤에 오는 결과는 OK moved뿐이고, 그 사이에
        # 멈추면 chore.sh가 UNKNOWN을 채운다. 엔진째 SIGKILL이면 그 실행의 결과 파일은 SUMMARY/ABORTED가 없어 절차상
        # 빠지고, 다시 실행하면 OK already-done(목표 상태 + 승인 댓글을 봄)만 남는다 — 옮김은 결과 줄이 아니라 일지가
        # 들고 있으니 그것도 옮겼을 수 있는 결과다. 이어 붙인 실행 어디에도 셋 다 없으면 다른 결과로 만든 확인 출력이다.
        if moved and not any(x["status"] == "UNKNOWN" or (x["status"] == "OK" and x["cls"] in ("moved", "already-done"))
                             for x in row["results"]):
            raise ReportError("verify says this run moved %s but no result of these runs could have moved it — verify came from "
                              "other results" % row["ref"])
        if last and last["status"] == "OK" and last["cls"] == "moved" and st == "OK" and not moved:
            raise ReportError("verify says OK %r for %s, whose last result is OK moved — the engine says %s there"
                              % (v["text"], where, MOVED_TEXT))
        row["moved"] = moved
        if st == "OK":
            return "done" if moved else "already"
        return {"WARN": "already", "RESOLVED": "skip", "FAIL": "bad", "UNRESOLVED": "bad", "NOT-SCHEDULED": "notrun"}[st]
    if st == "OK":
        return "unchecked" if v["text"] == NOTHING_TO_CHECK else "done"
    return {"RESOLVED": "skip", "FAIL": "bad", "UNRESOLVED": "bad"}[st]


def in_done(r):
    """'처리한 것'에 드는 실행 행: VERIFY OK, move-issue 행은 WARN도(옮김은 확인됐고 주의가 붙음 — 계약 §4의 done / already).
    Jira 행의 WARN(이미 목표 상태)은 '건너뜀·실패·미해결'의 주의 묶음에 남는다."""
    v = r["verify"]
    return v is not None and (v["status"] == "OK" or (r["action"] == MOVE and v["status"] == "WARN"))


def helper_emitted(x):
    """Jira 도우미가 실제로 낸 결과인가: jira-transition·move-issue 행 · NOT-ATTEMPTED 아님 · chore.sh가 멈출 때 채우는 세 글
    (journal unreadable at abort … / journal has a write … / run aborted at …, abort_words가 정확히 이 셋을 안다)이 아님.
    채운 결과는 그 행을 다시 처리했다는 증거가 아니다(chore.sh apply_abort_report)."""
    return x["row"]["action"] in HELPER_ACTIONS and x["status"] != "NOT-ATTEMPTED" and abort_words(x["reason"]) is None


def breaker_state(runs, results):
    """Jira 단계 차단기 상태 → (켜짐, [풀리지 않은 원인 결과, 차단 순서], 원인 모름 표시). 실행을 차례로, 실행 i마다:
    1. 실행 i에 그 원인 행의 OK 결과(도우미가 낸 것 — moved·already-done)가 있으면 그 원인만 풀린다. OK만 그 행이 차단기를 건
       검사를 지났다는 증거다: 쓰기 쪽은 SKIP account·type·M3·exists·M4·M2 같은 결과를 검사보다 먼저 내고, FAIL·UNKNOWN은 검사
       전이거나 행이 안 끝난 것이다(chore-jira.py mrow·mv_c 순서). chore.sh가 채운 결과는 helper_emitted가 이미 뺀다.
    2. 실행 i가 ABORTED이고 reason이 JIRA_BREAKER_HEAD로 시작하면(chore.sh:1362) 원인 = 실행 i의 마지막 낸 결과(쓰기 쪽은 그
       행의 RESULT를 낸 직후 멈춘다 — Stop 9; 그 뒤 행은 chore.sh가 채운다). 낸 결과가 없으면 '원인 모름' 표시 — 이 표시는 지워지지
       않는다(원인 행을 모르니 어느 행의 OK도 그것을 풀었다고 할 수 없다).
    켜짐 = 풀리지 않은 원인이 있거나 '원인 모름' 표시가 있음."""
    causes, unknown = [], False
    for i, run_ in enumerate(runs):
        em = [x for x in results if x["run"] == i and helper_emitted(x)]
        passed = {id(x["row"]) for x in em if x["status"] == "OK"}
        causes = [c for c in causes if id(c["row"]) not in passed]
        if run_["kind"] == "ABORTED" and (run_["reason"] or "").startswith(JIRA_BREAKER_HEAD):
            if em:      # 같은 행이 다시 원인이면 앞 원인을 빼고 새로 — 원인 줄은 행마다 하나, 가장 최근 멈춤의 사유
                causes = [c for c in causes if c["row"] is not em[-1]["row"]] + [em[-1]]
            else:
                unknown = True
    return bool(causes) or unknown, causes, unknown


def build_model(hdr, rows, runs, results, vrows, vmeta, vsum):
    all_only_group = all(r["scope"] == "only-group" for r in runs)
    for r in rows:
        r["area"], r["review"], r["detail"] = classify(r)
        r["results"], r["verify"], r["moved"] = [], None, False
    for res in results:
        res["row"]["results"].append(res)
    for r in rows:
        if r["review"] != "act":
            continue
        res = r["results"]
        r["last"] = res[-1] if res else None
        r["everok"] = any(x["status"] == "OK" for x in res)
        bad = [x["status"] for x in res if x["status"] in BAD_RESULTS]
        r["prevbad"] = bad[-1] if bad else None
        r["attempted"] = any(x["status"] != "NOT-ATTEMPTED" for x in res)
        r["verify"] = vrows.get((r["action"], enc_ref(r["ref"])))
        r["exec"] = exec_outcome(r, all_only_group)
        vt = r["verify"]["text"] if r["verify"] else ""
        r["maybe_sent"] = (any(x["status"] in SENT_RESULTS for x in res)
                           or (r["action"] == JIRA and any(h in vt for h in WRITE_HINTS)))

    areas = {}
    for name in AREAS:
        rs = [r for r in rows if r["area"] == name]
        review = {k: sum(1 for r in rs if r["review"] == k) for k in REVIEW_KEYS}
        acts = [r for r in rs if r["review"] == "act"]
        ex = {k: sum(1 for r in acts if r["exec"] == k) for k in EXEC_KEYS}
        structured = sum(1 for r in rs if r["review"] in ("keep", "ambiguous") and (r.get("unit") or r.get("jira")))
        areas[name] = {"rows": rs, "total": len(rs), "review": review, "exec": ex,
                       "decided": review["act"] + review["keep"] + review["ambiguous"], "structured": structured,
                       "attempted": sum(1 for r in acts if r["attempted"])}
    inventory = [r for r in rows if r["area"] == "meta"]
    decisions = []
    for r in rows:
        if r["review"] == "ambiguous":
            ev = (r.get("jira") or r.get("unit"))["evidence"]
            decisions.append({"row": r, "kind": "unit", "owner": ev["owner"]})
        elif r["action"] == JIRA and r["last"] and r["last"]["status"] == "SKIP" and r["last"]["cls"] == "manual":
            decisions.append({"row": r, "kind": "manual", "owner": "me"})

    def ok(action):
        return sum(1 for r in rows if r["action"] == action and r["review"] == "act" and r["exec"] == "done")
    tiles = {"t-branches": ok("delete-remote"), "t-prs": ok("close-pr"), "t-issues": ok("close-issue"),
             "t-jira-qa": sum(1 for r in rows if r["action"] == JIRA and r["moved"] and r["jira"]["level"] == "TO-QA"),
             "t-jira-closed": sum(1 for r in rows if r["action"] == JIRA and r["moved"] and r["jira"]["level"] == "TO-CLOSED"),
             "t-decide": len(decisions), "t-bad": vsum["fail"] + vsum["unresolved"],
             "t-recent": sum(1 for r in rows if r.get("unit") and r["unit"]["evidence"]["v"] == "NOT-JUDGED"),
             "t-moves": ok(MOVE)}       # 타일은 계획에 move-issue 행이 있을 때만 보인다(render_head)
    moves = [r for r in rows if r["action"] == MOVE]
    sites = sorted({r["jira"]["site"] for r in inventory} | {r["snapshot"]["site"] for r in rows if r["action"] == JIRA}
                   | {r["move"]["site"] for r in moves})
    breaker = breaker_state(runs, results)
    model = {"hdr": hdr, "rows": rows, "runs": runs, "areas": areas, "inventory": inventory, "decisions": decisions,
             "breaker": breaker,
             "tiles": tiles, "vmeta": vmeta, "vsum": vsum, "n_rows": len(rows), "moves": moves,
             "confirmed": sum(1 for r in rows if r["review"] == "act" and r["verify"] and r["exec"] != "unchecked"
                              and in_done(r)),
             "site_by_project": {r["jira"]["project"]: r["jira"]["site"] for r in inventory},
             "jira_site": sites[0] if len(sites) == 1 else None}
    assert_sums(model)
    return model


def assert_sums(m):
    """내부 불변식(구성상 항상 참 — 시험 대상이 아니라 코드 결함 감지용): 영역 검토 축 합 = 영역 행 수, 실행 축 합 = 실행
    행 수, 영역 합 + inventory 행 = 계획 행 수, Jira 영역 = inventory total 합. 입력 불일치는 parse_results /
    parse_verify / exec_outcome이 거절한다."""
    total = 0
    for name in AREAS:
        a = m["areas"][name]
        if sum(a["review"].values()) != a["total"] or sum(a["exec"].values()) != a["review"]["act"]:
            raise ReportError("internal: %s funnel stages do not add up to its rows" % name)
        total += a["total"]
    if total + len(m["inventory"]) != m["n_rows"]:
        raise ReportError("internal: areas hold %d rows + %d inventory rows, the plan has %d" % (total, len(m["inventory"]), m["n_rows"]))
    if sum(r["jira"]["total"] for r in m["inventory"]) != m["areas"]["jira"]["total"]:
        raise ReportError("internal: Jira inventory total differs from the Jira ticket rows")


# ───────────────────────── 표시 도우미 (승인 화면 chore-render.py와 같은 규칙) ─────────────────────────

# 보이지 않거나 다른 글자로 착각될 수 있는 문자 → 테두리 친 U+XXXX 표지(.hid). 표 = chore-render.py와 같다:
# 제어·서식·구분·사용자 정의·미할당·서러게이트 범주, C1 제어, 일반 공백이 아닌 공백(Zs), Default_Ignorable_Code_Point
# (Unicode 16.0), 빈칸처럼 보이는 U+2800.
HIDDEN_CATS = {"Cc", "Cf", "Zl", "Zp", "Co", "Cn", "Cs"}
BLANK_LOOKING = {0x2800}
DEFAULT_IGNORABLE = ((0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5),
                     (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
                     (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
                     (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF))
REVEALED = set()  # 이번 렌더에서 드러낸 숨김 문자 — 머리 범례에 찍는다


def hidden_char(o):
    if 0x80 <= o <= 0x9F or o in BLANK_LOOKING or any(lo <= o <= hi for lo, hi in DEFAULT_IGNORABLE):
        return True
    cat = unicodedata.category(chr(o))
    return cat in HIDDEN_CATS or (cat == "Zs" and o != 0x20)


def is_hidden(ch):
    return ch not in "\t\n" and hidden_char(ord(ch))


def hid_mark(o):
    code = "U+%04X" % o
    return '<span class="hid" role="img" aria-label="숨김 문자 %s" title="숨김 문자 %s">%s</span>' % (code, code, code)


def vis(s):
    """데이터 문자열 → HTML. 숨김 문자는 표지로, 나머지는 이스케이프."""
    s = str(s)
    if not any(is_hidden(ch) for ch in s):
        return html.escape(s, quote=True)
    out = []
    for ch in s:
        if is_hidden(ch):
            REVEALED.add(ord(ch))
            out.append(hid_mark(ord(ch)))
        else:
            out.append(html.escape(ch, quote=True))
    return "".join(out)


def vis_plain(s):
    """마크업을 넣을 수 없는 자리(<title>): 숨김 문자는 빼고 개수를 덧붙인다."""
    s = str(s)
    n = sum(1 for ch in s if is_hidden(ch))
    return html.escape("".join(ch for ch in s if not is_hidden(ch)) + (" (숨김 문자 %d개 포함)" % n if n else ""), quote=True)


def kst(ts):
    t = (ts or "").strip()
    if not t:
        return "알 수 없음"
    try:
        dt = datetime.fromisoformat(t[:-1] + "+00:00" if t.endswith("Z") else t)
    except ValueError:
        return t
    if dt.tzinfo is None:
        return t
    return dt.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")


def known(v):
    return v if (v and v.strip() and v.strip().lower() != "unknown") else "알 수 없음"


def fmt(n):
    return format(n, ",")


def pct(c, t):
    if not t or not c:
        return "0%"
    v = 100.0 * c / t
    if v < 0.1:
        return "0.1% 미만"
    return "%d%%" % round(v) if v >= 10 else "%.1f%%" % v


def repo_slug(url):
    u = (url or "").strip()
    m = re.fullmatch(r"(?:[A-Za-z][A-Za-z0-9+.-]*://)?(?:[^@/\s]+@)?[^/:\s]+(?::[0-9]+)?[/:](.+)", u)
    if not m:
        return ""
    parts = [x for x in m.group(1).split("/") if x]
    if len(parts) < 2:
        return ""
    name = parts[-1][:-4] if parts[-1].endswith(".git") else parts[-1]
    return "%s/%s" % (parts[-2], name) if name else ""


def display_repo(hdr, repo_url):
    """화면용 owner/repo — 머리 줄 remote는 소문자라 원래 대소문자를 --repo-url → origin 순으로 찾는다."""
    for cand in (repo_slug(repo_url), repo_slug(hdr["origin"])):
        if cand and cand.lower() == hdr["remote"].lower():
            return cand
    return hdr["remote"]


def display_ref(ref):
    if ref.startswith("remote:"):
        return ref[7:], False
    if ref.startswith("local:"):
        return ref[6:], True
    return ref, False


# ───────────────────────── 문구 ─────────────────────────

OWNER_ORDER = {"me": 0, "author": 1, "creator": 2, "qa-team": 3, "unknown": 4}
LEVEL_TEXT = {"TO-QA": "QA로 옮김 — 배포 확인됨", "TO-CLOSED": "닫음 — 중복·대체"}
CLASS_TEXT = {"identity": "티켓 정보가 계획과 다름", "manual": "사람 확인 필요", "at-target": "이미 목표 상태",
              "assignee": "담당자가 바뀜", "changed": "승인 뒤 티켓이 바뀜", "proof": "배포 증거가 지금은 성립하지 않음",
              "transition": "옮길 수 있는 전환이 없음", "moved": "이번 실행이 옮김", "already-done": "이미 옮겨져 있음",
              "comment-rejected": "댓글이 거부됨", "changed-after-comment": "댓글을 단 뒤 다른 변경이 생김",
              "transition-rejected": "옮기기가 거부됨"}
RESULT_WORD = {"OK": "성공", "SKIP": "건너뜀", "FAIL": "실패", "UNKNOWN": "결과 모름", "NOT-ATTEMPTED": "시도 안 함"}
VERIFY_WORD = {"OK": "확인됨", "WARN": "주의", "RESOLVED": "해소됨", "UNRESOLVED": "미해결", "FAIL": "실패",
               "NOT-SCHEDULED": "실행 안 함", "INCOMPLETE": "실행이 중간에 멈춤"}
ACT_LABEL = {"pr": "닫기", "issue": "닫기", "jira": "옮기기(QA·닫기)", "branch": "지우기"}
OUT_LABEL = {"pr": "판정 안 함", "issue": "판정 안 함", "jira": "제외·판정 안 함", "branch": "제외(보호·이번 범위 밖)"}
DONE_LABEL = {"pr": "닫힘 확인", "issue": "닫힘 확인", "jira": "이번 실행이 옮김", "branch": "지움 확인"}
SOURCE_TEXT = {"default": "기본 브랜치", "default-branch": "기본 브랜치", "branch-protection": "브랜치 보호 규칙",
               "protected-branch": "브랜치 보호 규칙", "protection": "브랜치 보호 규칙", "protected": "브랜치 보호 규칙",
               "ruleset": "저장소 규칙 #%s", "environment": "배포 환경 %s", "workflow": "배포 워크플로 %s",
               "open-pr-head": "열린 PR #%s의 브랜치", "open-pr-base": "열린 PR #%s의 대상", "protect": "직접 지정한 보호 패턴",
               "manual": "직접 지정한 보호 패턴", "integrate": "통합 브랜치로 직접 지정"}
ALREADY_LABEL = "목표 상태 확인 — 이번 실행이 옮긴 것 아님/미확정"
# move-issue 결과 분류(MOVE_CLASSES) → 운영자 말. 결과 글(키 앞머리 "<KEY> — "를 뗀 것)이 이 말로 시작하면 코드만 뺀다
MOVE_CLASS_TEXT = {"moved": "이번 실행이 옮김", "already-done": "이미 옮겨져 있음",
                   "account": "Jira 계정 또는 GitHub 로그인이 승인 때와 다름", "changed": "이슈가 승인 뒤 바뀜",
                   "manual": "사람 확인 필요", "exists": "이 이슈를 가리키는 티켓이 이미 있음",
                   "type": "티켓 유형을 만들 수 없음", "create-rejected": "Jira가 만들기를 거절함",
                   "comment-failed": "댓글이 게시됐을 수 있음", "close-failed": "이슈를 닫지 못함"}
MOVE_OUTCOME = {"done": "이번 실행이 옮김", "already": "이미 옮겨져 있음", "skip": "건너뜀", "bad": "실패·미해결",
                "notrun": "실행 안 함"}
MOVE_DELETED = " · 지워진 티켓 "          # 계약 §2: 확인 문구 끝에 지워진 KEY마다 한 번 (design §10e)
MOVE_MANY = ("이 이슈의 티켓 여럿", "이 이슈를 가리키는 티켓이 이미 있음")   # 키를 여럿 드는 확인 문구(§7 행 4·11) — 모두 보인다
MOVE_REOPENED = "옮긴 뒤 다시 열린 이슈는 GitHub에서 다시 닫거나(진행 기록 보존) 티켓을 지우면(다음 정리가 새로 만들어 다시 닫음) 끝남"
MOVE_RERUN = "같은 계획으로 다시 실행"
MOVE_LINK_EXIT = "확인 후 연결을 기록하고 같은 계획으로 다시 실행"
MOVE_FIX_COMMENT = "바뀐 이관 댓글을 지우고 연결을 기록한 뒤 같은 계획으로 다시 실행"
MOVE_CHECK_COMMENT = "이슈에 이관 댓글이 달렸는지 확인하고 그 결과를 기록한 뒤 같은 계획으로 다시 실행"
# 행 5(옮겼는데 이슈가 열려 있음)의 출구 = §5 M21(옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음)의 출구 (계약 §6 round 5)
MOVE_REOPENED_EXIT = "옮긴 뒤 다시 열린 이슈 — GitHub에서 다시 닫거나(진행 기록 보존) 티켓을 지우면(다음 정리가 새로 만들어 다시 닫음) 끝남"
# 계약 §5 M1–M21: 정해진 사유 글(정확히 이 글) → 다음 할 일. 표에 없는 사유 = MOVE_EXIT_OTHER (move_exit)
MOVE_REASON_EXITS = {
    "만들기 결과 미확정 — 다시 만들지 않음":
        "Jira에서 이 이슈 주소로 티켓이 생겼는지 확인하고 그 결과를 기록한 뒤 같은 계획으로 다시 실행",           # M1
    "댓글 결과 미확정": MOVE_CHECK_COMMENT,                                                               # M2
    "승인한 티켓이 없어짐": "다음 정리에서 다시 판단",                                                      # M3
    "이 이슈의 티켓 여럿": "남길 티켓 하나만 두고 나머지를 지운 뒤 다음 정리에서 다시 판단",                      # M4
    "티켓 내용이 승인본과 다름 — 닫지 않음":
        "이슈가 열려 있으면 그 티켓을 지울 때 다음 정리가 새로 만듦 (옮긴 뒤 다시 열린 이슈면 GitHub에서 다시 닫아도 끝남)",  # M5
    "이관 댓글이 지워짐": MOVE_LINK_EXIT,                                                                # M6
    "이관 댓글이 바뀜": MOVE_FIX_COMMENT,                                                               # M7
    "이관 댓글 중복": "이 계획이 기록한 하나만 남기고 나머지 이관 댓글을 지운 뒤 같은 계획으로 다시 실행",           # M8
    "누가 먼저 닫음 — 연결 기록 필요": MOVE_LINK_EXIT,                                                    # M9
    "기록 없는 이관 댓글": "그 댓글을 지운 뒤 같은 계획으로 다시 실행",                                       # M10
    "이관 댓글 없음": MOVE_LINK_EXIT,                                                                   # M11
    "이관 댓글이 보낸 본문과 다름": MOVE_FIX_COMMENT,                                                     # M12
    "이슈가 승인 뒤 바뀜 — 닫지 않음": "다음 정리에서 다시 판단 (만든 티켓은 남고, 다음 계획이 그 티켓으로 닫음)",  # M13
    "댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단": MOVE_CHECK_COMMENT,                              # M14
    "이슈를 닫지 못함": MOVE_RERUN,                                                                     # M15
    "댓글 결과 모름 — 다음 실행이 확인": "같은 계획으로 다시 실행 (다음 실행이 댓글을 확인)",                     # M16
    "지워진 티켓의 댓글 결과 미확정":
        "이슈에 지워진 티켓을 가리키는 이관 댓글이 달렸는지 확인해 있으면 지우고, 결과를 기록한 뒤 같은 계획으로 다시 실행",  # M17
    "이 실행의 결과 줄 없음 — 다시 실행하면 확인": "같은 계획으로 다시 실행 (이미 옮긴 행은 다시 확인만 함)",             # M18
    "만든 티켓에 담당자가 붙었거나 보고자가 실행 계정이 아님":
        "그 티켓의 담당자를 떼고 보고자를 실행 계정으로 고친 뒤 같은 계획으로 다시 실행",                            # M19
    "만든 티켓을 다시 읽을 수 없음":
        "Jira에서 그 티켓이 있는지 확인 — 같은 계획은 다시 실행하지 않음, 다음 정리에서 다시 판단",                   # M20
    "옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음": MOVE_REOPENED_EXIT,                                         # M21
}
# chore.sh가 멈춘 실행의 move 행에 채우는 영어 사유(apply_abort_report; 끝에 "(run aborted at <단계>)") — 행 10이 그대로 실어
# 오면 접두로 출구를 고른다(계약 §6 round 3b). 정확히 맞추는 MOVE_REASON_EXITS보다 먼저.
MOVE_ABORT_EXITS = (("journal has a write of this attempt, outcome unread", "같은 계획으로 다시 실행 (다음 실행이 확인)"),
                    ("journal unreadable at abort", "일지를 읽을 수 없음 — 사람이 확인"))
# 사유를 든 확인 문구(§7 행 2·6·10·10b, 키 앞머리를 뗀 본문의 시작) — 사유 = 이 머리 뒤의 글 전부. 10b = 티켓을 만들었고 이슈도
# 닫혔지만 마지막 결과가 OK가 아님(닫은 직후 멈춤 등, 사유 M18) — 행 10("이슈 닫지 않음")과 머리가 다르다
MOVE_WHY_ROWS = ("결과 미확정 — 사람이 확인 후 기록 필요: ", "이관 댓글 없음·중복·바뀜: ", "티켓 만듦, 이슈 닫지 않음: ",
                 "티켓 만듦, 이슈는 닫힘: ")
MOVE_EXIT_OTHER = "확인 결과를 보고 사람이 정함"
# 행 3인데 이 실행들 어딘가에 OK(moved·already-done)가 있는 행 — 이 계획이 옮겨 이슈를 닫았다. 다음 정리는 열린 이슈만 보고
# (chore.sh issue list --state open), 다시 열면 M21로 멈추니 "지우면 다음 정리가 새로 만듦"은 거짓 — 티켓을 지우면 닫힌 이슈의
# 하나뿐인 티켓을 잃는다. "다음 정리"를 넣지 않는다(move_next_kind = owner).
MOVE_ROW3_DONE = ("이관 댓글이 달리고 닫힌 이슈 — 그 뒤 티켓이 바뀌었거나 없어짐. Jira에서 확인해 바뀐 티켓은 그대로 두거나 고치고, "
                  "없어졌으면 오너가 정함 (닫힌 이슈는 정리가 다시 만들지 않음)")   # already-done = 남이 닫았을 수도 있다
# Jira 단계 차단기(쓰기 쪽 Stop 9)로 멈춘 실행의 ABORTED reason= 머리 — chore.sh:1362 `9) die "Jira 단계가 차단기로 멈춤 — 원인을
# 고치기 전에는 다시 실행하지 않음"`(die → LAST_ERR → apply_abort_report의 reason=). 이런 실행의 원인 행은 그 뒤 실행에서 그 행이
# OK로 끝나기 전까지 풀리지 않은 원인으로 남고(원인 모름 표시는 지워지지 않음), 풀리지 않은 원인이 있으면 다시 실행 명령을 보이지
# 않는다 — breaker_state
JIRA_BREAKER_HEAD = "Jira 단계가 차단기로 멈춤"
BREAKER_REST = ("원인을 고치기 전에는 같은 계획을 다시 실행하지 않습니다. 원인이 된 티켓과 이유는 차단기로 멈춘 실행의 오류 출력"
                "(chore: jira: …)에 있습니다. 원인을 고쳤으면 같은 실행 명령을 다시 쓰고, 고칠 수 없으면 남은 행은 다음 정리에서 다룹니다.")
BREAKER_TEXT = "Jira 단계가 차단기로 멈춘 뒤, 원인 행이 성공(OK)으로 끝난 실행이 아직 없습니다 — " + BREAKER_REST   # 원인 행을 앎
BREAKER_TEXT_UNKNOWN = "Jira 단계가 차단기로 멈췄고 원인 행을 결과에서 찾지 못했습니다 — " + BREAKER_REST   # 원인 모름 표시만
BREAKER_CAUSE_UNKNOWN = "결과에서 찾지 못함 — 차단기로 멈춘 실행의 오류 출력(chore: jira: …)을 보세요"
MOVE_NO_RERUN = "같은 계획은 다시 실행하지 않음"   # M20의 출구에 있는 말 — 이런 행이 있으면 다시 실행 명령을 보이지 않는다(next_moves)
MOVE_ROW3 ="티켓이 안 보이거나 내용이 승인본과 다름"
# 행 3과 함께 오면 행 3의 '티켓 지우기' 출구 대신 이 사유의 출구가 이기는 SKIP manual 사유: M3(승인한 티켓이 없어짐 = 행 3의
# "안 보이거나"), M19(만든 직후 확인: 담당자·보고자 — 보고자 불일치도 행 3), M20(만든 티켓을 다시 읽을 수 없음 — 404도 행 3).
# M19·M20 행에 지우기 출구를 보이면 같은 계획에서 티켓이 하나 더 생기거나 고칠 수 있는 티켓을 잃는다(계약 §6 round 3)
MOVE_M20 = "만든 티켓을 다시 읽을 수 없음"     # 마지막 결과가 SKIP manual 이 사유면 다음 명령은 멈춤 문단(next_moves 1) — 출구 글과 무관
MOVE_ROW3_REASONS = ("승인한 티켓이 없어짐", "만든 티켓에 담당자가 붙었거나 보고자가 실행 계정이 아님", MOVE_M20)
# 사유를 들지 않는 확인 문구(계약 §2 행 3·4·5·7·11·12·13, 키 앞머리를 뗀 본문의 시작) → 정해진 다음 할 일. 행 4는 언제나 §5 M4의
# 출구, 행 7은 정해진 출구가 없다(사람이 정함). 접두가 서로 겹치지 않는다.
MOVE_ROW_EXITS = (("이 이슈의 티켓 여럿", MOVE_REASON_EXITS["이 이슈의 티켓 여럿"]),                       # 행 4
                  (MOVE_ROW3, "이슈가 열려 있으면 그 티켓을 지울 때 다음 정리가 새로 만듦"),                 # 행 3
                  ("옮겼는데 이슈가 열려 있음", MOVE_REOPENED_EXIT),                                    # 행 5
                  ("닫기 전에 이슈 내용이 바뀜", MOVE_EXIT_OTHER),                                     # 행 7
                  ("이 이슈를 가리키는 티켓이 이미 있음", "다음 정리가 그 티켓을 보고 다시 판단"),              # 행 11
                  ("만든 것 없음", "만든 티켓 없음 — 이슈는 GitHub에 그대로이고 다음 정리가 다시 판단"),          # 행 12
                  ("이번 실행에서 시도 안 함", MOVE_RERUN))                                          # 행 13
# 엔진이 멈춘 단계 이름(chore.sh ABORT_AT) → move-issue 행에 보이는 말(영어 이름을 그대로 보이지 않는다)
MOVE_STAGE = {"start": "시작", "close": "이슈·PR 닫기", "jira": "Jira", "remote-precheck": "원격 브랜치 확인",
              "remote-reload": "원격 브랜치 다시 읽기", "local": "로컬 정리", "prune": "작업 폴더 목록 정리"}


def move_stage(s):
    return "원격 브랜치 지우기" if s.startswith("remote-batch-") else MOVE_STAGE.get(s, "다른")
MOVE_LIMITS = ("마지막 확인과 쓰기 사이 몇 밀리초의 원격 변경은 막을 수 없고 사후 확인이 본다",
               "이 기계·이 클론·이 Jira 계정 범위만 중복을 막는다",
               "댓글 응답이 보낸 본문과 다르면 “댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단”",
               "이 계획이 만든 티켓 하나라도 저장된 내용이 승인본과 다르면 그 자리에서 Jira 단계 전체가 멈춘다(같은 차이로 "
               "티켓이 더 생기지 않게)",
               "읽을 권한을 잃은 티켓도 지워진 티켓으로 보이고, 다른 프로젝트로 옮겨진 티켓은 없는 것으로 읽힌다")
DEFINITION ="배포 확인 = 바인딩의 deploy-proof 워크플로가 성공한 push 실행에 포함됨 — 지금 그 환경이 그 코드라는 뜻은 아님"


def owner_key(o):
    o = o or "unknown"
    if o.startswith("author:"):
        return (OWNER_ORDER["author"], o[7:])
    return (OWNER_ORDER.get(o, OWNER_ORDER["unknown"]), "")


def owner_label(o):
    o = o or "unknown"
    if o == "me":
        return "나"
    if o.startswith("author:"):
        return "작성자 %s" % vis(o[7:])
    return {"creator": "티켓 만든 사람", "qa-team": "QA 팀"}.get(o, "미상")


def engine_words(text):
    """엔진 verify 문구(영어) → 운영자 문구. 모르는 문구는 None(원문을 그대로 보인다)."""
    t = text
    if t == "absent on origin":
        return "원격에 없음 확인"
    if t == "absent on origin (was UNKNOWN, rerun SKIP gone)":
        return "원격에 없음 확인 — 처음 결과는 몰랐고, 다시 실행했을 때 이미 없었음"
    if t == "absent locally":
        return "로컬에 없음 확인"
    if t == "CLOSED":
        return "닫힘 확인"
    if t == RECONCILED_CLOSE:
        return "확인 때 닫혀 있고 계획 시각 뒤에 달린 승인 댓글이 있어 이 계획의 닫기로 셈 — 누가 닫았는지는 확인 안 됨"
    if t == "nothing to check":
        return "확인할 것 없음"
    m = re.fullmatch(r"reconciled: (.*) \(was UNKNOWN\)", t)
    if m:
        what = {"absent at verify": "원격에 없음", "absent locally at verify": "로컬에 없음",
                "CLOSED with the approved comment at verify": "승인한 댓글과 함께 닫혀 있음"}.get(m.group(1))
        return "처음 결과는 몰랐지만 확인 때 %s" % what if what else None
    if t.startswith("still on origin"):
        return "아직 원격에 있음"
    if t == "still present locally":
        return "아직 로컬에 있음"
    m = re.fullmatch(r"state ([A-Z_]+)", t)
    if m:
        return "아직 닫히지 않음 (상태 %s)" % m.group(1)
    m = re.match(r"earlier ([A-Z-]+), last run SKIP: ", t)
    if m:
        return "앞선 실행은 %s, 마지막 실행은 건너뜀" % RESULT_WORD.get(m.group(1), m.group(1))
    m = re.match(r"last result ([A-Z-]+): ", t)
    if m:
        return "마지막 결과 %s — 반영이 보이지 않음" % RESULT_WORD.get(m.group(1), m.group(1))
    return None


def abort_words(t, stage=None):
    """엔진이 멈출 때 쓰는 UNKNOWN / NOT-ATTEMPTED 사유(chore.sh apply_abort_report) → 운영자 말. 모르면 None.
    stage = 단계 이름을 바꾸는 함수(move-issue 행 = move_stage), 없으면 엔진 이름 그대로."""
    st = stage or (lambda s: s)
    m = re.fullmatch(r"journal has a write of this attempt, outcome unread \(run aborted at (.+)\)", t)
    if m:
        return "이 실행이 요청을 보낸 기록은 있지만 결과를 읽지 못함 (%s 단계에서 멈춤)" % st(m.group(1))
    m = re.fullmatch(r"journal unreadable at abort \(run aborted at (.+)\)", t)
    if m:
        return "멈출 때 기록을 읽지 못해 보냈는지 알 수 없음 (%s 단계에서 멈춤)" % st(m.group(1))
    m = re.fullmatch(r"sent at (.+), outcome unread", t)
    if m:
        return "%s 단계에서 보냈지만 결과를 읽지 못함" % st(m.group(1))
    m = re.fullmatch(r"run aborted at (.+)", t)
    if m:
        return "%s 단계에서 실행이 멈춰 시도하지 않음" % st(m.group(1))
    return None


def class_text(t):
    """Jira 사유·확인 문구의 앞 "<class>: "(엔진 분류 코드)를 운영자 말로. 뒤 글이 이미 그 말로 시작하면 코드만 뺀다."""
    m = JIRA_CLASS.fullmatch(t)
    if not m or m.group(1) not in CLASS_TEXT:
        return vis(t)
    label, rest = CLASS_TEXT[m.group(1)], m.group(2)
    return vis(rest) if rest.startswith(label) else "%s: %s" % (vis(label), vis(rest))


def source_text(src):
    """보호 출처(엔진 protected (…) 괄호 안) → 사람 말. 모르는 출처는 원문."""
    out = []
    text = src.strip()
    more = re.fullmatch(r"(.*?)\s*\+([0-9]+) more", text)
    if more:
        text = more.group(1)
    for part in (p.strip() for p in text.split(",")):
        if not part:
            continue
        m = re.fullmatch(r"-*([A-Za-z_-]+)(?:[#:](.+))?", part)
        key = m.group(1).lower().replace("_", "-") if m else ""
        fmt_ = SOURCE_TEXT.get(key)
        if fmt_ is None:
            out.append(vis(part))
        elif "%s" in fmt_:
            out.append(vis(fmt_ % (m.group(2) or "?")))
        else:
            out.append(vis(fmt_))
    if more:
        out.append("외 %s개" % more.group(2))
    return ", ".join(out) or "출처 기재 없음"


CSS = """
:root{--ink:#000;--ink-60:rgba(0,0,0,.6);--ink-44:rgba(0,0,0,.44);--hair:rgba(0,0,0,.12);--fill:rgba(0,0,0,.04);--amber:#B45309;--red:#B91C1C}
*{box-sizing:border-box;border-radius:0}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--ink);font:400 16px/1.6 Inter,"Inter var",-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic","Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:1120px;margin:0 auto;padding:56px 24px 96px}
h1{font-size:clamp(30px,5vw,46px);line-height:1.2;font-weight:700;letter-spacing:-.015em;margin:0 0 20px}
h2{font-size:26px;line-height:1.3;font-weight:700;letter-spacing:-.01em;margin:0 0 16px}
h3{font-size:20px;line-height:1.4;font-weight:600;margin:0}
h4{font-size:18px;line-height:1.45;font-weight:600;margin:8px 0 0}
p{margin:0 0 12px;max-width:72ch}
a{color:var(--ink);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
a:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"D2Coding",monospace;font-size:16px}
.ref{word-break:normal;overflow-wrap:anywhere;direction:ltr;unicode-bidi:bidi-override;unicode-bidi:isolate-override}
.muted{color:var(--ink-60)}
.part{border-top:1px solid var(--ink);margin-top:64px;padding-top:32px}
.lead{font-size:18px}
.kicker{color:var(--ink-60);margin:0 0 8px}
.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 20px;margin:24px 0 0}
.meta dt{color:var(--ink-60)}
.meta dd{margin:0;min-width:0}
.fp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.verdict{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:24px;line-height:1.35;font-weight:700;margin:0 0 16px;max-width:none}
.verdict .muted{font-size:18px;font-weight:400}
.verdict.bad #verdict-text{color:var(--red)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:32px 0 0;padding:0;list-style:none;border-top:1px solid var(--hair)}
.stats li{padding:20px 20px 20px 0;border-bottom:1px solid var(--hair);min-width:0}
.stats a{display:block;color:inherit;text-decoration:none}
.stats a:hover .lbl{text-decoration:underline;text-underline-offset:3px}
.num{font-size:44px;line-height:1.1;font-weight:700;letter-spacing:-.02em;display:block}
.stats .lbl{color:var(--ink-60);display:flex;align-items:center}
.stats .sub{display:block;color:var(--ink-60);font-size:14px;line-height:1.5}
.stats .attn .num{color:var(--amber)}
.stats .bad .num{color:var(--red)}
.note{margin-top:16px}
.shape{display:inline-block;width:13px;height:13px;flex:none;margin-right:6px}
.shape.tri{background:var(--amber);clip-path:polygon(50% 0,100% 100%,0 100%)}
.shape.sq{background:var(--red);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.area{margin-top:40px}
.area h3 .muted{font-weight:400}
.axis{margin:18px 0 8px;max-width:none}
.axis b{font-weight:600}
.bar{display:flex;gap:2px;width:100%;height:40px;margin:0}
.seg{display:flex;align-items:center;justify-content:center;min-width:3px;overflow:hidden;white-space:nowrap;font-weight:600;font-size:15px}
.seg .sn{display:none;padding:0 6px}
.seg.lw .sn{display:inline}
.s-done{background:#000;color:#fff}
.s-mid{background:rgba(0,0,0,.6);color:#fff}
.s-keep{background:repeating-linear-gradient(45deg,rgba(0,0,0,.12) 0 3px,#fff 3px 8px);box-shadow:inset 0 0 0 1px var(--hair);color:#000}
.s-out{background:#fff;box-shadow:inset 0 0 0 1px #000;color:#000}
.s-skip{background:rgba(0,0,0,.44);color:#000}
.s-attn{background:var(--amber);color:#fff}
.s-bad{background:var(--red);color:#fff}
.legend{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px 22px}
.legend li{display:flex;align-items:center;gap:8px}
.legend b{font-weight:600}
.sw{display:inline-block;width:16px;height:16px;flex:none}
.legend .shape{margin-right:0;width:16px;height:16px}
.k,.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.card{border:1px solid var(--ink);padding:24px;margin-top:20px}
.card.attn{border-left:4px solid var(--amber)}
.card .say{margin:10px 0 0;font-weight:600}
.flag-attn{display:flex;align-items:center;color:var(--amber);font-weight:700;margin:0}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 20px;margin:16px 0 0}
.facts dt{color:var(--ink-60)}
.facts dd{margin:0;min-width:0}
.hist{margin:0;padding-left:20px}
.ogroup{margin-top:36px}
.ogroup h3 .muted{font-weight:400}
.group{margin-top:32px}
.gmeta{margin:6px 0 0;color:var(--ink-60)}
details{margin-top:12px;border-top:1px solid var(--hair)}
summary{cursor:pointer;padding:12px 0;font-weight:600}
summary:hover{text-decoration:underline;text-underline-offset:3px}
.rows{list-style:none;margin:0;padding:0}
.row{display:grid;gap:2px 16px;padding:10px 0;border-bottom:1px solid var(--hair)}
.l4 .row{grid-template-columns:minmax(0,1.7fr) minmax(0,2.4fr) minmax(0,1.3fr) minmax(0,2.2fr)}
.l3 .row{grid-template-columns:minmax(0,1.7fr) minmax(0,2.6fr) minmax(0,2.4fr)}
.row.head{color:var(--ink-60);font-weight:600;border-bottom:1px solid var(--ink)}
.c{min-width:0}
.eng{display:block;color:var(--ink-60);font-size:14px;line-height:1.5}
.cmd{display:block;max-width:100%;background:var(--fill);padding:12px 14px;margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all}
.hid,.hidex{display:inline-block;border:1px solid var(--ink);background:var(--fill);padding:0 3px;margin:0 1px;
 font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:inherit;font-weight:600;line-height:1.3;
 direction:ltr;unicode-bidi:isolate}
footer{border-top:1px solid var(--ink);margin-top:72px;padding-top:24px}
footer .meta dt{color:var(--ink-60)}
#coverage,#def-proof{max-width:none}
@media (max-width:900px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:760px){
 main{padding:32px 16px 72px}
 .num{font-size:36px}
 .verdict{font-size:21px}
 .meta,.facts{grid-template-columns:minmax(0,1fr);gap:0}
 .meta dd,.facts dd{margin-bottom:10px}
 .l4 .row,.l3 .row{grid-template-columns:minmax(0,1fr)}
 .row.head{display:none}
 .k{position:static;width:auto;height:auto;overflow:visible;clip:auto;clip-path:none;white-space:nowrap;color:var(--ink-60);margin-right:8px}
 .seg.lw:not(.lw2) .sn{display:none}
 .card{padding:18px}
}
@media (max-width:480px){.stats li{padding:16px 12px 16px 0}.num{font-size:32px}}
@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}main{padding:0;max-width:none}.card{break-inside:avoid}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""


def cell(label, value_html):
    return '<span class="c"><span class="k">%s</span>%s</span>' % (label, value_html)


def shape(cls):
    if cls == "s-attn":
        return '<span class="shape tri" aria-hidden="true"></span>'
    if cls == "s-bad":
        return '<span class="shape sq" aria-hidden="true"></span>'
    return ""


_KEY_RE = {}


def move_key_re(project, lead=False):
    """그 프로젝트 키 하나(<PROJECT>-<n>, 앞뒤 모두 키 글자 [A-Za-z0-9_-]가 아닌 자리 — 계약 §5 끝 줄: TST-123abc·TST-123-extra
    ·xTST-1은 키가 아니다)를 잡는 정규식(split용 그룹 하나). lead = 글 맨 앞의 "<KEY> — "(계약 §1·§2: 키를 아는 사유는 키를
    먼저 쓴다)만."""
    if (project, lead) not in _KEY_RE:
        key = re.escape(project) + r"-[1-9][0-9]*"
        _KEY_RE[project, lead] = (re.compile(r"\A%s — " % key) if lead else
                                  re.compile(r"(?<![A-Za-z0-9_-])(%s)(?![A-Za-z0-9_-])" % key))
    return _KEY_RE[project, lead]


def move_core(row):
    """move-issue 행의 확인 문구 → (본문, 키 앞머리를 뗀 본문). 본문 = 끝의 ' · 지워진 티켓 …' 꼬리를 뗀 앞부분."""
    v = row["verify"]["text"] if row["verify"] else ""
    main = v.split(MOVE_DELETED, 1)[0]
    return main, move_key_re(row["move"]["project"], lead=True).sub("", main, count=1)


def move_keys(row):
    """그 행이 보이는 티켓 키(계약 §2): 확인 문구 본문의 첫 키, 없으면 마지막 결과 글의 첫 키. 키를 여럿 드는 확인 문구
    (MOVE_MANY — 행 4 '여럿', 행 11)는 본문의 키 전부. 어디에도 없으면 승인 때 고른 기존 티켓(adopt). → (키 목록, 출처)."""
    pat = move_key_re(row["move"]["project"])
    main, core = move_core(row)
    found = pat.findall(main)
    if core.startswith(MOVE_MANY):
        return list(dict.fromkeys(found)), "many"
    if found:
        return found[:1], "verify"
    last = row.get("last")
    found = pat.findall(last["reason"]) if last else []
    if found:
        return found[:1], "result"
    if row["move"]["adopt"]:
        return [row["move"]["adopt"]], "adopt"
    return [], None


def move_deleted(row):
    """확인 문구 끝의 ' · 지워진 티켓 <KEY> (지울 댓글 <cid>, …)' 꼬리들(지워진 KEY마다 하나, design §10e) → [(KEY, [cid…])]."""
    v = row["verify"]["text"] if row["verify"] else ""
    pat = re.compile(re.escape(MOVE_DELETED) + r"(%s-[1-9][0-9]*)(?![A-Za-z0-9_-])(?: \(지울 댓글 ([^()]*)\))?"
                     % re.escape(row["move"]["project"]))
    return [(m.group(1), [c.strip() for c in (m.group(2) or "").split(",") if c.strip()]) for m in pat.finditer(v)]


def move_verify_shown(row):
    """move-issue 확인 문구 → 화면에 보일 글. 사유를 드는 행(MOVE_WHY_ROWS)이 엔진의 영어 중단 사유(행 10이 그대로 실어 온
    chore.sh 채움)를 실어 오면 그 사유만 운영자 말로(abort_words + move_stage) — 키·머리·' · 지워진 티켓 …' 꼬리는 그대로.
    그 밖의 확인 문구도 마지막 ': ' 뒤가 엔진 중단 사유 그대로면 그 부분만 번역한다(쓰기 쪽 맞는 행 없음 "확인 필요: <결과 글>").
    나머지는 바꾸지 않는다(계약 §2 글 그대로, 이스케이프는 호출자)."""
    v = row["verify"]["text"]
    main, sep, tail = v.partition(MOVE_DELETED)
    lead = move_key_re(row["move"]["project"], lead=True).match(main)
    at = lead.end() if lead else 0
    for head in MOVE_WHY_ROWS:
        if main.startswith(head, at):
            k = abort_words(main[at + len(head):], move_stage)
            if k:
                return main[:at + len(head)] + k + sep + tail
    pre, colon, last = main.rpartition(": ")       # 그 밖 확인 문구가 끝에 엔진 중단 사유를 실어 와도(쓰기 쪽 "확인 필요: …") 번역
    k = abort_words(last, move_stage) if colon else None
    return pre + colon + k + sep + tail if k else v


def reason_exit(why):
    """실려 온 사유 글 → 다음 할 일: 엔진이 멈출 때 채우는 영어 사유는 접두로(MOVE_ABORT_EXITS), 그 밖은 §5 표에서 정확히,
    표에 없으면 MOVE_EXIT_OTHER."""
    for prefix, text in MOVE_ABORT_EXITS:
        if why.startswith(prefix):
            return text
    return MOVE_REASON_EXITS.get(why, MOVE_EXIT_OTHER)


def last_manual(row):
    """마지막 결과가 SKIP manual이면 그 사유 글(키 앞머리 "<KEY> — "를 뗀 것), 아니면 None."""
    last = row.get("last")
    if last and last["status"] == "SKIP" and last["cls"] == "manual":
        return move_key_re(row["move"]["project"], lead=True).sub("", last["text"], count=1)
    return None


def move_exit(row):
    """끝나지 않은 move-issue 행의 다음 할 일(계약 §5). 지금의 확인 결과가 이긴다 — 처음 맞는 것:
    1. 확인 문구가 사유를 드는 행(§7 행 2·6·10·10b, MOVE_WHY_ROWS) → 그 머리 뒤의 사유 글로 출구(reason_exit: 엔진 중단 사유는
       접두, 그 밖은 §5 표에서 정확히).
    2. 사유를 들지 않는 행(MOVE_ROW_EXITS: 행 4 → 언제나 M4의 출구, 행 3·5·7·11·12·13 → 그 행의 출구). 행 3의 예외, 이 순서:
       이 실행들 어딘가에 OK moved·already-done이 있으면 MOVE_ROW3_DONE(이관 댓글이 달리고 닫힌 이슈 — 티켓을 지우라고 하지 않는다),
       아니면 마지막 결과가 SKIP manual 정확히 M3·M19·M20(MOVE_ROW3_REASONS)이면 그 사유의 출구.
    3. 확인 문구가 어느 행에도 안 맞을 때만(§4의 '맞는 행 없음' UNRESOLVED) 마지막 SKIP manual 사유 글(키 앞머리 "<KEY> — "를
       뗀 것)을 같은 표에서 정확히 찾는다 — 옛 결과의 사유가 지금의 확인 결과를 가리지 않게. 마지막 결과가 NOT-ATTEMPTED면
       (키도 미결도 없어 맞는 행이 없음 — 시도 전에 멈춤) MOVE_RERUN.
    표에 없는 사유, 또는 어디에도 안 맞는 행 = MOVE_EXIT_OTHER. 끝의 ' · 지워진 티켓 …'은 보지 않는다(move_core)."""
    core = move_core(row)[1]
    for head in MOVE_WHY_ROWS:
        if core.startswith(head):
            return reason_exit(core[len(head):])
    last = row.get("last")
    manual = last_manual(row)
    for prefix, text in MOVE_ROW_EXITS:
        if core.startswith(prefix):
            if prefix == MOVE_ROW3:
                if any(x["status"] == "OK" and x["cls"] in ("moved", "already-done") for x in row["results"]):
                    return MOVE_ROW3_DONE          # 이 계획이 옮겨 닫은 이슈 — M3·M19·M20 예외보다 먼저
                if manual in MOVE_ROW3_REASONS:
                    return MOVE_REASON_EXITS[manual]
            return text
    if manual is not None:
        return reason_exit(manual)
    if last and last["status"] == "NOT-ATTEMPTED":    # 맞는 행 없음 + 시도 안 함(키·미결 없음, 쓰기 쪽 "확인 필요: …") = 시도 전
        return MOVE_RERUN
    return MOVE_EXIT_OTHER


class Page:
    def __init__(self, model, repo_url, names, given):
        self.m, self.repo_url, self.names = model, repo_url, names
        self.given = given          # 명령 줄에 준 그대로의 경로(다음 명령에 쓴다): {"plan": …, "results": […]}
        self.buf, self.ids = [], 0

    def w(self, *parts):
        self.buf.extend(parts)

    def nid(self, stem):
        self.ids += 1
        return "%s%d" % (stem, self.ids)

    # ── 링크·대상 ──
    def gh(self, kind, num, text):
        return '<a href="%s/%s/%d">%s</a>' % (html.escape(self.repo_url, quote=True), kind, num, vis(text))

    def jira_link(self, key, site):
        if site and P.JIRA_SITE.fullmatch(site) and P.JIRA_KEY.fullmatch(key):
            return '<a href="https://%s/browse/%s">%s</a>' % (site, key, vis(key))
        return vis(key)

    def site_of(self, row):
        if row["action"] == JIRA:
            return row["snapshot"]["site"]
        return self.m["site_by_project"].get(row["jira"]["project"])

    def target(self, row):
        """행의 대상 표시(링크). 종류는 action이 정한다 — 브랜치 이름이 pr#7이어도 브랜치."""
        a, ref = row["action"], row["ref"]
        if row.get("jira") is not None:
            return self.jira_link(row["jira"]["key"], self.site_of(row))
        if a in ("close-pr", "report") and P.PR_REF.fullmatch(ref):
            n = int(ref[3:])
            return self.gh("pull", n, "PR #%d" % n)
        if a in ("close-issue", "report", MOVE) and P.ISSUE_REF.fullmatch(ref):
            n = int(ref[6:])
            return self.gh("issues", n, "이슈 #%d" % n)
        if ref == ".":
            return "작업 폴더 목록"
        if a == "report":
            name, local = display_ref(ref)
        else:
            name, local = ref, a.startswith("delete-local")
        return '<code class="ref">%s</code>%s' % (vis(name), ' <span class="muted">(로컬)</span>' if local else "")

    def title(self, row):
        """계획에 있는 제목만: PR·이슈 구조형 증거 t, 판정 기록 없는 PR·이슈 행의 증거(제목), Jira summary, 닫기 행의
        snapshot title(row["title"]). title이 없는 옛 계획의 닫기 행은 증거(남긴 댓글)의 첫 줄로 대신한다."""
        a = row["action"]
        if a == JIRA:
            return vis(row["snapshot"]["summary"])
        if a == MOVE:
            return vis(row["snapshot"]["title"])
        j = row.get("jira")
        if j is not None:
            return vis(j["summary"]) if j.get("summary") else '<span class="muted">요약은 계획에 없음</span>'
        if row.get("unit"):
            return vis(row["unit"]["evidence"]["t"])
        if a == "report" and (P.PR_REF.fullmatch(row["ref"]) or P.ISSUE_REF.fullmatch(row["ref"])):
            return vis(row["evidence"]) if row["evidence"] else '<span class="muted">(제목 없음)</span>'
        if a in P.CLOSE_ACTIONS:
            if row.get("title"):
                return vis(row["title"])
            first = row["evidence"].split("\n", 1)[0]
            return '<span class="muted">남긴 댓글</span> %s' % vis(first)
        return ""

    def cites(self, text):
        """증거 cites 칸(쉼표 목록) → 링크가 되는 것은 링크로(PR·이슈·Jira 키), 커밋은 앞 12자리."""
        out = []
        for tok in (t.strip() for t in text.split(",")):
            if not tok:
                continue
            m = re.fullmatch(r"(?:pr[:#]|PR #)([1-9][0-9]*)", tok)
            if m:
                out.append(self.gh("pull", int(m.group(1)), "PR #" + m.group(1)))
                continue
            m = re.fullmatch(r"(?:issue[:#]|이슈 #)([1-9][0-9]*)", tok)
            if m:
                out.append(self.gh("issues", int(m.group(1)), "이슈 #" + m.group(1)))
                continue
            m = re.fullmatch(r"(?:c:)?([0-9a-f]{7,40})", tok)
            if m:
                out.append('<code>%s</code>' % m.group(1)[:12])
                continue
            if P.JIRA_KEY.fullmatch(tok):
                out.append(self.jira_link(tok, self.m["jira_site"]))
                continue
            out.append(vis(tok))
        return ", ".join(out)

    def tickets(self, links):
        return ", ".join("%s (%s)" % (self.jira_link(t["key"], self.m["jira_site"]), vis(t["status"])) for t in links)

    def verify_html(self, row, raw=False):
        v = row["verify"]
        if v is None:
            if row.get("exec") == "notrun":
                return '<span class="muted">실행되지 않아 확인 없음</span>'
            if row.get("checked_skip"):
                return '<span class="muted">확인함 — 이 계획의 승인 댓글과 함께 닫힌 흔적이 없어 건너뜀으로 둠</span>'
            return '<span class="muted">확인 줄 없음 — 건너뛴 행은 확인하지 않음</span>'
        if v["status"] == "OK" and row["action"] != JIRA and v["text"] == NOTHING_TO_CHECK:
            return "확인할 것 없음"
        word = VERIFY_WORD[v["status"]]
        if row["action"] == JIRA:
            return "%s — %s" % (word, class_text(v["text"])) if v["text"] else word
        if row["action"] == MOVE:
            return "%s — %s" % (word, self.keys_html(move_verify_shown(row), row))
        k = engine_words(v["text"])
        body = "%s — %s" % (word, vis(k)) if k else "%s — %s" % (word, vis(v["text"]))
        if raw and k and v["text"]:
            body += '<span class="eng">엔진 기록: %s</span>' % vis(v["text"])
        return body

    def result_html(self, row):
        last = row["last"]
        if last is None:
            return '<span class="muted">이번 결과 파일에 실행 기록 없음</span>'
        word = RESULT_WORD[last["status"]]
        n = len(row["results"])
        tries = ' <span class="muted">(%d번 시도, 마지막 결과 기준)</span>' % n if n > 1 else ""
        if row["action"] == MOVE:      # 운영자 말만 — 엔진의 영어 사유는 붙이지 않는다(번역이 없는 낯선 사유만 그대로)
            return "%s — %s%s" % (word, self.move_reason_html(row, last), tries)
        if last["cls"]:
            return "%s — %s%s" % (word, class_text(last["reason"]), tries)
        k = abort_words(last["reason"])
        return '%s%s%s<span class="eng">엔진 기록: %s</span>' % (word, " — " + vis(k) if k else "", tries,
                                                                vis(last["reason"]) if last["reason"] else "(없음)")

    def history_html(self, row):
        """그 행의 모든 결과(실행 순서대로) — 이전 실행이 보냈을 수 있는 요청을 숨기지 않는다."""
        out = []
        for x in row["results"]:
            out.append("<li>%d번째 실행: %s — %s</li>" % (x["run"] + 1, RESULT_WORD[x["status"]], self.result_words(row, x)))
        return '<ol class="hist">%s</ol>' % "".join(out) if out else '<span class="muted">실행 기록 없음</span>'

    def result_words(self, row, x):
        """결과 하나의 사유 → 운영자 말(실행 기록과 차단기 원인 줄이 함께 쓴다): move-issue = move_reason_html, 그 밖 = 분류 말 /
        엔진 중단 사유 번역 / 원문."""
        if row["action"] == MOVE:
            return self.move_reason_html(row, x)
        k = None if x["cls"] else abort_words(x["reason"])
        return class_text(x["reason"]) if x["cls"] else vis(k) if k else vis(x["reason"] or "(사유 없음)")

    # ── move-issue 행 ──
    def keys_html(self, text, row):
        """글 → HTML: 그 행 프로젝트의 키(<PROJECT>-<n>)는 모두 Jira 링크, 나머지는 vis(숨김 문자 표지 + 이스케이프)."""
        parts = move_key_re(row["move"]["project"]).split(text)
        return "".join(self.jira_link(p, row["move"]["site"]) if i % 2 else vis(p) for i, p in enumerate(parts))

    def move_reason_html(self, row, x):
        """move-issue RESULT 사유 → 운영자 말(분류 코드 대신 MOVE_CLASS_TEXT) + 키 링크. 분류 없는 사유: 엔진이 멈출 때 쓰는 영어
        사유는 번역만(abort_words + move_stage, 원문 없음), 그 밖(도우미의 UNKNOWN 한국어 사유)은 글 그대로."""
        if not x["cls"]:
            k = abort_words(x["reason"], move_stage)
            return vis(k) if k else self.keys_html(x["reason"] or "(사유 없음)", row)
        label, rest = MOVE_CLASS_TEXT[x["cls"]], x["text"]
        core = move_key_re(row["move"]["project"], lead=True).sub("", rest, count=1)
        return self.keys_html(rest, row) if core.startswith(label) else "%s: %s" % (vis(label), self.keys_html(rest, row))

    def move_keys_html(self, row):
        """'→ 티켓' 칸. 키가 없을 때: 만들기 요청을 보냈을 수 있는 행(결과 중 UNKNOWN이 있거나 확인 문구가 행 2 '결과 미확정')은
        "티켓이 생겼을 수 있음 — 키 미확정"(티켓이 있을 수 있다 — 없다고 쓰지 않는다), 그 밖은 "티켓 없음"."""
        keys, how = move_keys(row)
        if not keys:
            maybe = (any(x["status"] == "UNKNOWN" for x in row["results"])
                     or move_core(row)[1].startswith(MOVE_WHY_ROWS[0]))
            return '<span class="muted">%s</span>' % ("티켓이 생겼을 수 있음 — 키 미확정" if maybe else "티켓 없음")
        out = ", ".join(self.jira_link(k, row["move"]["site"]) for k in keys)
        return out + (' <span class="muted">(승인 때 고른 기존 티켓)</span>' if how == "adopt" else "")

    # ── 목록 ──
    def rows_block(self, cls, head, items, summary):
        """목록 하나. 12개 넘으면 <details> 안에(요약 줄에 개수)."""
        w = self.w
        folded = len(items) > 12
        if folded:
            w('<details>\n<summary>%s</summary>\n' % summary)
        w('<div class="%s">\n<div class="row head" aria-hidden="true">%s</div>\n<ul class="rows">\n'
          % (cls, "".join("<span>%s</span>" % h for h in head)))
        for cells in items:
            w('<li class="row">%s</li>\n' % "".join(cell(h, c) for h, c in zip(head, cells)))
        w('</ul>\n</div>\n')
        if folded:
            w('</details>\n')

    # ── 막대 ──
    def bar(self, bid, title, segs):
        """가로 누적 막대 하나 + 범례(항상 보임) + 화면 낭독기용 표. segs = [(key, 이름, 수, 스타일, 0이어도 범례에 둘지)]."""
        w = self.w
        total = sum(s[2] for s in segs)
        tid = bid + "-tbl"
        w('<div class="bar" id="%s" role="img" aria-label="%s" aria-describedby="%s">' % (bid, html.escape(title, quote=True), tid))
        for key, label, c, cls, _ in segs:
            if not c:
                continue
            share = c / total
            extra = (" lw" if share >= 0.06 else "") + (" lw2" if share >= 0.15 else "")
            w('<span class="seg %s%s" style="flex:%d 1 0%%"><span class="sn">%s</span></span>' % (cls, extra, c, fmt(c)))
        w('</div>\n<ul class="legend">\n')
        for key, label, c, cls, keep in segs:
            if c or keep:
                mark = shape(cls) or '<span class="sw %s" aria-hidden="true"></span>' % cls
                w('<li>%s%s <b id="%s-%s">%s</b> <span class="muted">%s</span></li>\n'
                  % (mark, label, bid, key, fmt(c), pct(c, total)))
        # 표는 너비 1px을 따르지 않아(표 상자에는 overflow도 안 먹는다) 가린 div 안에 둔다 — 좁은 화면에서 가로 스크롤 방지
        w('</ul>\n<div class="sr"><table id="%s"><caption>%s</caption><tr><th>단계</th><th>건수</th><th>비율</th></tr>'
          % (tid, html.escape(title, quote=True)))
        for key, label, c, cls, keep in segs:
            if c or keep:
                w('<tr><td>%s</td><td>%s</td><td>%s</td></tr>' % (label, fmt(c), pct(c, total)))
        w('</table></div>\n')


# ───────────────────────── 렌더 ─────────────────────────

def render(m, plan_name, digest, result_names, verify_name, repo_url, title_date, given):
    REVEALED.clear()
    hdr = m["hdr"]
    pg = Page(m, repo_url, result_names, given)
    repo = display_repo(hdr, repo_url)
    repo_name = repo.rsplit("/", 1)[-1] or repo
    w = pg.w
    w('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n',
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light">\n',
      '<title>%s 저장소 정리 결과 — %s</title>\n' % (vis_plain(repo_name), title_date),
      '<style>%s</style>\n</head>\n<body>\n<main>\n' % CSS)
    render_head(pg, repo, repo_name, digest, title_date)
    legend_at = len(pg.buf)
    w("")
    w('</header>\n')
    render_flow(pg)
    render_decisions(pg)
    render_done(pg)
    render_moves(pg)
    render_kept(pg)
    render_rest(pg, plan_name, digest)
    render_footer(pg, plan_name, digest, verify_name)
    w('</main>\n</body>\n</html>\n')
    if REVEALED:
        pg.buf[legend_at] = (
            '<p class="note" id="hid-legend"><span class="hidex">U+XXXX</span> 처럼 테두리 친 표기는 화면에 보이지 않는 문자를 '
            '드러낸 것입니다. 실제 이름과 글에는 그 문자 자체가 들어 있고, 이 표기는 들어가지 않습니다. '
            '이 페이지에 나온 숨김 문자 <b id="hid-kinds">%d</b>종: %s</p>\n'
            % (len(REVEALED), ", ".join("U+%04X" % o for o in sorted(REVEALED))))
    return "".join(pg.buf)


TILES = (("t-branches", "지운 원격 브랜치", "", ""), ("t-prs", "닫은 PR", "", ""), ("t-issues", "닫은 이슈", "", ""),
         ("t-jira-qa", "Jira → QA · 이번 실행이 옮김", "", ""), ("t-jira-closed", "Jira 닫음 · 이번 실행이 옮김", "", ""),
         ("t-decide", "결정 필요", "attn", "#s-decide"), ("t-bad", "실패·미해결", "bad", "#s-rest"),
         ("t-recent", "판정 제외(최근 갱신)", "", "#s-recent"))
MOVE_TILE = ("t-moves", "Jira로 옮긴 이슈", "", "#s-move")   # 계획에 move-issue 행이 있을 때만, '닫은 이슈' 바로 뒤


def render_head(pg, repo, repo_name, digest, title_date):
    m, w = pg.m, pg.w
    hdr, vs, t = m["hdr"], m["vsum"], m["tiles"]
    notrun = sum(m["areas"][a]["exec"]["notrun"] for a in AREAS)
    w('<header>\n<p class="kicker">저장소 정리 결과 · %s</p>\n' % title_date,
      '<h1>%s 저장소 정리 결과</h1>\n' % vis(repo_name))
    warn = ' · 주의 %s' % fmt(vs["warn"]) if vs["warn"] else ""
    skipped = sum(m["areas"][a]["exec"]["skip"] for a in AREAS)
    unchecked = sum(m["areas"][a]["exec"]["unchecked"] for a in AREAS)
    if vs["success"] == "yes" and not notrun and not skipped and not unchecked:
        w('<p class="verdict" id="verdict"><span id="verdict-text">모두 확인됨</span>'
          '<span class="muted">확인 결과 실패 0 · 미해결 0%s</span></p>\n' % warn)
    elif vs["success"] == "yes":
        parts = ["확인한 %s건 모두 확인됨" % fmt(m["confirmed"])]
        if notrun:
            parts.append("실행 안 함 %s건" % fmt(notrun))
        if skipped:
            parts.append("건너뜀 %s건" % fmt(skipped))
        if unchecked:
            parts.append("확인할 것 없음 %s건" % fmt(unchecked))
        w('<p class="verdict" id="verdict"><span id="verdict-text">%s</span>'
          '<span class="muted">확인 결과 실패 0 · 미해결 0%s</span></p>\n' % (" · ".join(parts), warn))
    else:
        n = vs["fail"] + vs["unresolved"]
        w('<p class="verdict bad" id="verdict"><span class="shape sq" aria-hidden="true"></span>'
          '<span id="verdict-text">확인 안 된 것 %s건</span><span class="muted">실패 %s · 미해결 %s%s</span></p>\n'
          % (fmt(n), fmt(vs["fail"]), fmt(vs["unresolved"]), warn))
    if vs["run"] == "incomplete":
        last = m["runs"][-1]
        w('<p class="note" id="run-incomplete">마지막 실행이 중간에 멈췄습니다%s. 같은 명령으로 다시 실행한 뒤, 모든 실행 결과를 '
          '이어 붙여 다시 확인하세요(아래 “건너뜀·실패·미해결”).</p>\n'
          % (" (멈춘 단계 %s)" % vis(last["at"]) if last["at"] else ""))
    if notrun:
        w('<p class="note" id="notrun-note">승인했지만 이번 결과에 실행 기록이 없는 항목이 <b id="n-notrun">%s</b>건 있습니다 — '
          '확인 결과는 실행한 행만 봅니다(아래 “건너뜀·실패·미해결”).</p>\n' % fmt(notrun))
    w('<p class="lead">아래 수는 모두 승인된 계획 파일의 행과 실행·확인 기록에서 셌습니다. 두 번 시도된 항목도 한 번만 셉니다.</p>\n',
      '<dl class="meta">\n<dt>저장소</dt><dd><code>%s</code></dd>\n' % vis(repo),
      '<dt>계획 생성 시각</dt><dd>%s</dd>\n' % vis(kst(hdr["created"])),
      '<dt>계획 지문</dt><dd class="fp" id="fp">%s</dd>\n' % digest,
      '<dt>실행 기록 번호</dt><dd><code>%s</code></dd>\n</dl>\n' % vis(hdr["run_id"]),
      '<ul class="stats">\n')
    overlap = sum(1 for d in m["decisions"] if d["row"]["review"] == "act" and d["row"]["verify"]
                  and d["row"]["verify"]["status"] in ("FAIL", "UNRESOLVED"))
    tiles = TILES[:3] + (MOVE_TILE,) + TILES[3:] if m["moves"] else TILES
    for tid, label, cls, href in tiles:
        n = t[tid]
        on = cls if n else ""
        sub = ""
        if tid == "t-bad" and overlap:
            sub = '<span class="sub">그중 %s건은 결정이 필요한 것에도 있음</span>' % fmt(overlap)
        body = '<span class="num" id="%s">%s</span><span class="lbl">%s%s</span>%s' % (
            tid, fmt(n), shape("s-" + on) if on else "", label, sub)
        if href and n:
            body = '<a href="%s">%s</a>' % (href, body)
        w('<li%s>%s</li>\n' % (' class="%s"' % on if on else "", body))
    w('</ul>\n')


def render_flow(pg):
    m, w = pg.m, pg.w
    w('<section class="part" aria-labelledby="s-flow">\n<h2 id="s-flow">영역별 흐름</h2>\n',
      '<p>영역마다 검토(무엇을 하기로 정했나)와 실행(실제로 어떻게 됐나)을 따로 그렸습니다. 막대 길이는 건수 비율이고, '
      '수는 막대 아래 범례에 모두 있습니다.</p>\n')
    for name in AREAS:
        a = m["areas"][name]
        rv, ex = a["review"], a["exec"]
        area = AREA_NAME[name]
        w('<div class="area" id="f-%s">\n<h3>%s <span class="muted">전체 <b id="f-%s-total">%s</b>건</span></h3>\n'
          % (name, area, name, fmt(a["total"])))
        if name == "jira":
            for r in m["inventory"]:
                j = r["jira"]
                # "미완료"는 검색 조건이 완료 범주를 빼는 경우에만 사실이다 — 조건 자체에서 읽는다
                open_only = re.search(r"statusCategory\s*!=\s*Done", j["jql"], re.I) is not None
                w('<p class="muted" id="inv-%s">검색 조건에 걸린 %sJira %s건 (프로젝트 %s, 검색 조건 <code>%s</code>)</p>\n'
                  % (j["project"], "미완료 " if open_only else "", fmt(j["total"]), vis(j["project"]), vis(j["jql"])))
        if not a["total"]:
            w('<p class="muted">이 계획에는 %s 항목이 없습니다 — %s 판정·실행 0건.</p>\n</div>\n' % (area, area))
            continue
        if name == "issue" and any(r["detail"] == "move" for r in a["rows"]):
            flow_issue_moves(pg, a)
            continue
        amb ="" if name == "branch" else " · 결정 필요 %s" % fmt(rv["ambiguous"])
        w('<p class="axis"><b>검토</b> — 전체 %s → %s %s → 결정 <span id="f-%s-judged">%s</span> (%s %s · 남김 %s%s)</p>\n'
          % (fmt(a["total"]), OUT_LABEL[name], fmt(rv["out"]), name, fmt(a["decided"]), ACT_LABEL[name],
             fmt(rv["act"]), fmt(rv["keep"]), amb))
        segs = [("act", ACT_LABEL[name], rv["act"], "s-done", True), ("keep", "남김", rv["keep"], "s-keep", True)]
        if name != "branch":
            segs.append(("ambiguous", "결정 필요", rv["ambiguous"], "s-attn", True))
        segs.append(("out", OUT_LABEL[name], rv["out"], "s-out", True))
        pg.bar("f-%s-r" % name, "%s 검토: 전체 %d건" % (area, a["total"]), segs)
        if not rv["act"]:
            w('<p class="axis muted"><b>실행</b> — 이번 계획에 %s 행이 없습니다.</p>\n</div>\n' % ACT_LABEL[name])
            continue
        extra = "".join(" · %s %s" % (lbl, fmt(ex[k])) for k, lbl in (("already", "목표 상태 확인(이번 실행이 옮긴 것 아님/미확정)"),
                                                                     ("unchecked", "확인할 것 없음"), ("notrun", "실행 안 함"))
                        if ex[k])
        w('<p class="axis"><b>실행</b> — %s %s건 → %s %s · 건너뜀 %s · 실패·미해결 %s%s</p>\n'
          % (ACT_LABEL[name], fmt(rv["act"]), DONE_LABEL[name], fmt(ex["done"]), fmt(ex["skip"]), fmt(ex["bad"]), extra))
        segs = [("done", DONE_LABEL[name], ex["done"], "s-done", True)]
        if name == "jira":
            segs.append(("already", ALREADY_LABEL, ex["already"], "s-mid", True))
        if ex["unchecked"]:
            segs.append(("unchecked", "실행함 — 확인할 것 없음", ex["unchecked"], "s-out", False))
        segs += [("skip", "건너뜀", ex["skip"], "s-skip", True), ("bad", "실패·미해결", ex["bad"], "s-bad", True),
                 ("notrun", "실행 안 함", ex["notrun"], "s-out", False)]
        pg.bar("f-%s-x" % name, "%s 실행: %s %d건" % (area, ACT_LABEL[name], rv["act"]), segs)
        w('</div>\n')
    w('</section>\n')


def flow_issue_moves(pg, a):
    """이슈 영역에 move-issue 행이 있을 때의 흐름: 검토 막대에서 닫기와 Jira로 옮기기를 나누고 실행 막대도 따로 그린다
    (닫은 이슈와 옮긴 이슈를 한 수로 섞지 않는다). 영역 합계(a["review"]["act"], a["exec"])는 둘을 합친 그대로다."""
    w = pg.w
    rv = a["review"]
    acts = [r for r in a["rows"] if r["review"] == "act"]
    closes = [r for r in acts if r["detail"] != "move"]
    moves = [r for r in acts if r["detail"] == "move"]
    w('<p class="axis"><b>검토</b> — 전체 %s → %s %s → 결정 <span id="f-issue-judged">%s</span> (닫기 %s · Jira로 옮기기 '
      '<span id="f-issue-moves">%s</span> · 남김 %s · 결정 필요 %s)</p>\n'
      % (fmt(a["total"]), OUT_LABEL["issue"], fmt(rv["out"]), fmt(a["decided"]), fmt(len(closes)), fmt(len(moves)),
         fmt(rv["keep"]), fmt(rv["ambiguous"])))
    pg.bar("f-issue-r", "이슈 검토: 전체 %d건" % a["total"],
           [("act", "닫기", len(closes), "s-done", True), ("move", "Jira로 옮기기", len(moves), "s-mid", True),
            ("keep", "남김", rv["keep"], "s-keep", True), ("ambiguous", "결정 필요", rv["ambiguous"], "s-attn", True),
            ("out", OUT_LABEL["issue"], rv["out"], "s-out", True)])
    for bid, label, done_label, rs in (("x", "닫기", DONE_LABEL["issue"], closes), ("m", "Jira로 옮기기", MOVE_OUTCOME["done"], moves)):
        if not rs:
            w('<p class="axis muted"><b>실행</b> — 이번 계획에 %s 행이 없습니다.</p>\n' % label)
            continue
        ex = {k: sum(1 for r in rs if r["exec"] == k) for k in EXEC_KEYS}
        extra = "".join(" · %s %s" % (lbl, fmt(ex[k])) for k, lbl in (("already", MOVE_OUTCOME["already"]),
                                                                     ("unchecked", "확인할 것 없음"), ("notrun", "실행 안 함"))
                        if ex[k])
        w('<p class="axis"><b>실행</b> — %s %s건 → %s %s · 건너뜀 %s · 실패·미해결 %s%s</p>\n'
          % (label, fmt(len(rs)), done_label, fmt(ex["done"]), fmt(ex["skip"]), fmt(ex["bad"]), extra))
        segs = [("done", done_label, ex["done"], "s-done", True)]
        if bid == "m":
            segs.append(("already", MOVE_OUTCOME["already"], ex["already"], "s-mid", True))
        segs += [("skip", "건너뜀", ex["skip"], "s-skip", True), ("bad", "실패·미해결", ex["bad"], "s-bad", True),
                 ("notrun", "실행 안 함", ex["notrun"], "s-out", False)]
        pg.bar("f-issue-%s" % bid, "이슈 실행: %s %d건" % (label, len(rs)), segs)
    w('</div>\n')


def render_decisions(pg):
    m, w = pg.m, pg.w
    ds = m["decisions"]
    w('<section class="part" aria-labelledby="s-decide">\n<h2 id="s-decide">결정이 필요한 것 <span class="muted">%s건</span></h2>\n'
      % fmt(len(ds)))
    if not ds:
        w('<p class="muted" id="no-decisions">결정이 필요한 항목이 없습니다.</p>\n</section>\n')
        return
    manual = [d for d in ds if d["kind"] == "manual"]
    sent = sum(1 for d in manual if d["row"]["maybe_sent"])
    if not manual:
        w('<p id="decide-intro">자동으로 정하지 않고 남긴 항목입니다. 이 정리는 이 항목들에 아무것도 바꾸지 않았습니다. '
          '누가 정하는지별로 묶었습니다.</p>\n')
    else:
        w('<p id="decide-intro">자동으로 정하지 않고 남긴 항목입니다. 판정만 한 항목은 이 정리가 바꾸지 않았습니다. 실행 중 멈춘 Jira '
          '%s건은 카드에 실행 기록을 모두 적었습니다%s. 누가 정하는지별로 묶었습니다.</p>\n'
          % (fmt(len(manual)), " — 그중 %s건은 이전 실행에서 댓글·옮기기 요청을 보냈을 수 있음" % fmt(sent) if sent else ""))
    groups = {}
    for d in ds:
        groups.setdefault(d["owner"] or "unknown", []).append(d)
    for gi, owner in enumerate(sorted(groups, key=owner_key), start=1):
        items = groups[owner]
        w('<div class="ogroup" id="og-%d" data-owner="%s">\n<h3>%s <span class="muted">%s건</span></h3>\n'
          % (gi, html.escape(owner, quote=True), owner_label(owner), fmt(len(items))))
        for d in sorted(items, key=lambda d: d["row"]["line"]):
            render_card(pg, d)
        w('</div>\n')
    w('</section>\n')


def card_id(row):
    j = row.get("jira")
    if j is not None:
        return "d-jira-" + j["key"]
    u = row.get("unit")
    return "d-%s-%d" % (u["kind"], u["number"])


def render_card(pg, d):
    w, row = pg.w, d["row"]
    hid = pg.nid("dc")
    facts = []
    if d["kind"] == "manual":
        s = row["snapshot"]
        kind = "Jira 실행 멈춤"
        if row["maybe_sent"]:
            say = "마지막 실행이 이 티켓에서 멈췄습니다. 이전 실행에서 댓글·옮기기 요청을 보냈을 수 있음 — 사람이 확인해야 합니다."
        else:
            say = "이번 실행은 이 티켓에 쓰지 않고 멈췄습니다 — 사람이 확인해야 합니다."
        facts = [("실행 기록", pg.history_html(row)),
                 ("확인 결과", pg.verify_html(row)),
                 ("계획 시점 상태", "%s → 목표 %s" % (vis(s["status_name"]), vis(s["to_name"]))),
                 ("모르는 것", "티켓의 댓글·상태가 왜 계획과 달라졌는지 — 자동으로는 판단하지 않음"),
                 ("누가 정하나", "나 (티켓 담당자)"),
                 ("추천", "티켓의 댓글과 변경 기록을 직접 보고, 맞으면 직접 옮기고 아니면 다음 정리에서 다시 판단")]
    else:
        j, u = row.get("jira"), row.get("unit")
        ev = (j or u)["evidence"]
        kind = "Jira" if j else ("PR" if u["kind"] == "pr" else "이슈")
        say = vis(ev["reason"])
        if j and j.get("status_name"):
            facts.append(("지금 상태", vis(j["status_name"])))
        if u:
            s = row["snapshot"]
            facts.append(("작성자 · 마지막 갱신", "%s · %s" % (vis(known(s.get("author", ""))), vis(kst(s.get("updated", ""))))))
        facts += [("아는 것", vis(ev["known"])), ("모르는 것", vis(ev["missing"])), ("누가 정하나", vis(ev["decider"])),
                  ("추천", vis(ev["recommend"]))]
        if ev["cites"]:
            facts.append(("근거", pg.cites(ev["cites"])))
        if ev["jira"]:
            facts.append(("연결된 티켓", pg.tickets(ev["jira"])))
        if ev["complete"]:
            facts.append(("증거", "모두 읽음" if ev["complete"] == "yes" else "일부를 읽지 못함"))
    title = pg.title(row)
    w('<article class="card attn" id="%s" aria-labelledby="%s">\n' % (card_id(row), hid),
      '<p class="flag-attn"><span class="shape tri" aria-hidden="true"></span>결정 필요 · %s</p>\n' % kind,
      '<h4 id="%s">%s %s</h4>\n' % (hid, pg.target(row), title),
      '<p class="say">%s</p>\n<dl class="facts">\n' % say)
    for dt, dd in facts:
        w('<dt>%s</dt><dd>%s</dd>\n' % (dt, dd))
    w('</dl>\n</article>\n')


DONE_GROUPS = (("delete-remote", "지운 원격 브랜치"), ("close-pr", "닫은 PR"), ("close-issue", "닫은 이슈"),
               ("move-issue", "Jira로 옮긴 이슈"), ("move-already", "이미 Jira로 옮겨져 있던 이슈"),
               ("jira-qa", "Jira → QA · 이번 실행이 옮김"), ("jira-closed", "Jira 닫음 · 이번 실행이 옮김"),
               ("jira-target", ALREADY_LABEL), ("local", "로컬 정리 — 지움 확인"), ("unchecked", "실행함 — 확인할 것 없음"))


def done_group(r):
    a = r["action"]
    if r["exec"] == "unchecked":
        return "unchecked"
    if a == MOVE:            # 이번 실행이 옮긴 것(타일 '옮긴 이슈'와 같은 수)과 이미 옮겨져 있던 것을 따로 묶는다
        return "move-issue" if r["exec"] == "done" else "move-already"
    if a == JIRA:
        if not r["moved"]:
            return "jira-target"
        return "jira-qa" if r["jira"]["level"] == "TO-QA" else "jira-closed"
    return "local" if a in LOCAL_ACTIONS else a


def before_after(pg, row):
    a = row["action"]
    if a == JIRA:
        s = row["snapshot"]
        if not row["moved"]:
            return "계획 때 %s · 목표 %s" % (vis(s["status_name"]), vis(s["to_name"]))
        return "%s → %s" % (vis(s["status_name"]), vis(s["to_name"]))
    if a == MOVE:
        return "열림 → Jira 티켓 · 닫힘" if row["exec"] == "done" else "이미 옮겨져 닫혀 있음"
    if a in P.CLOSE_ACTIONS:
        return "열림 → 닫힘"
    if a == "worktree-prune":
        return "사라진 작업 폴더 목록 → 정리"
    return "있음 → 지움"


def detail(pg, row):
    """처리한 것 목록의 내용 칸."""
    a, s = row["action"], row["snapshot"]
    if a == JIRA:
        j = row["jira"]
        level = LEVEL_TEXT[j["level"]] if row["moved"] else "목표 %s — 이번 실행이 옮겼는지는 확인되지 않음" % row["snapshot"]["to_name"]
        bits = [pg.title(row), '<span class="eng">%s</span>' % vis(level)]
        if j["level"] == "TO-QA":
            req = [it for it in j["items"] if it["role"] == "required"]
            names = [pg.gh("pull", it["pr"], "PR #%d" % it["pr"]) if it["kind"] == "pr" else "커밋 <code>%s</code>" % it["sha"][:12]
                     for it in req]
            bits.append('<span class="eng">필요한 변경 %s · <a href="%s">배포 실행 #%s</a></span>'
                        % (", ".join(names), html.escape(s["run_url"], quote=True), vis(s["run"])))
        else:
            b = j["close_basis"]
            what = ("대체 — PR #%d" % b["pr"]) if b["pr"] else ("%s — %s" % ("중복" if b["type"] == "duplicate" else "대체", b["key"]))
            bits.append('<span class="eng">근거: %s</span>' % vis(what))
        return "".join(bits)
    if a == MOVE:
        return '%s<span class="eng">Jira 티켓 %s · 유형 %s%s</span>' % (
            pg.title(row), pg.move_keys_html(row), vis(row["move"]["issuetype_name"]),
            " · 설명 잘림" if row["payload"]["trunc"] else "")
    if a in P.CLOSE_ACTIONS:
        return '%s<span class="eng">작성자 %s</span>' % (pg.title(row), vis(known(s.get("author", ""))))
    if a == "worktree-prune":
        return "이미 사라진 작업 폴더의 목록만 정리"
    pr = s.get("pr", "")
    prl = pg.gh("pull", int(pr), "PR #" + pr) if re.fullmatch(r"[1-9][0-9]*", pr) else "PR 번호 없음"
    return "병합 %s · 대상 <code class=\"ref\">%s</code><span class=\"eng\">마지막 커밋 %s · %s</span>" % (
        prl, vis(s.get("pr_base", "")), vis(known(s.get("tip_date", ""))), vis(known(s.get("tip_author", ""))))


def render_done(pg):
    m, w = pg.m, pg.w
    done = [r for r in m["rows"] if r["review"] == "act" and in_done(r)]
    w('<section class="part" aria-labelledby="s-done">\n<h2 id="s-done">처리한 것 <span class="muted">%s건</span></h2>\n'
      % fmt(len(done)))
    w('<p>실행했고 확인 단계에서 맞다고 나온 항목입니다. 이번 실행이 옮겼는지 확인되지 않은 Jira와 확인할 것이 없는 정리는 '
      '따로 묶었습니다.</p>\n')
    for key, label in DONE_GROUPS:
        rs = [r for r in done if done_group(r) == key]
        if not rs:
            continue
        gid = pg.nid("dg")
        w('<div class="group" id="done-%s">\n<h3 id="%s">%s <span class="muted">%s건</span></h3>\n' % (key, gid, label, fmt(len(rs))))
        items = [(pg.target(r), detail(pg, r), before_after(pg, r), pg.verify_html(r)) for r in sorted(rs, key=sort_key)]
        pg.rows_block("l4", ("대상", "내용", "전 → 후", "확인"), items, "%s %s건 펼치기" % (label, fmt(len(rs))))
        w('</div>\n')
    if not done:
        w('<p class="muted">반영이 확인된 항목이 없습니다.</p>\n')
    pinv = [x for x in m["vmeta"] if x["action"] == "p-invariant" and x["status"] == "OK"]
    if pinv:
        w('<p class="note" id="p-invariant-ok">보호·통합 브랜치 <b>%s</b>개가 정리 뒤에도 아직 있음을 확인했습니다.</p>\n' % fmt(len(pinv)))
    w('</section>\n')


def render_moves(pg):
    """'Jira로 옮김' (design v9 §9) — move-issue 행 전부, 이슈 번호 순: 이슈 → 티켓 목록(유형·잘림·결과·확인 문구), 합칠 후보,
    담당자·보고자 한 줄, 지워진 티켓과 지울 댓글, 끝나지 않은 행의 다음 할 일(§8), 한계. move-issue 행이 없으면 쓰지 않는다."""
    m, w = pg.m, pg.w
    rows = sorted(m["moves"], key=lambda r: r["move"]["number"])
    if not rows:
        return
    mv = rows[0]["move"]
    cnt = {k: sum(1 for r in rows if r["exec"] == k) for k in MOVE_OUTCOME}
    w('<section class="part" aria-labelledby="s-move">\n<h2 id="s-move">Jira로 옮김 <span class="muted">%s건</span></h2>\n'
      % fmt(len(rows)),
      '<p>남기기로 판정한 GitHub 이슈를 Jira 프로젝트 <code>%s</code>(%s)의 새 티켓으로 옮기고, 이슈에 티켓 링크 댓글을 단 뒤 '
      '닫는 작업입니다. 이번 실행이 옮김 <b id="mv-done">%s</b>건 · 이미 옮겨져 있음 <b id="mv-already">%s</b>건 · 건너뜀 '
      '<b id="mv-skip">%s</b>건 · 실패·미해결 <b id="mv-bad">%s</b>건 · 실행 안 함 <b id="mv-notrun">%s</b>건.</p>\n'
      % (vis(mv["project"]), vis(mv["site"]), fmt(cnt["done"]), fmt(cnt["already"]), fmt(cnt["skip"]), fmt(cnt["bad"]),
         fmt(cnt["notrun"])))
    if cnt["done"]:      # 이번 실행이 옮긴 행이 있을 때만 — 없으면 "들어갔고"가 사실이 아니다
        w('<p id="mv-backlog">새 티켓은 담당자 없이 팀 백로그로 들어갔고, 보고자는 정리를 실행한 계정입니다.</p>\n')

    def issue_to(r):
        return "%s → %s" % (pg.target(r), pg.move_keys_html(r))
    items = []
    for r in rows:
        trunc = r["payload"]["trunc"]
        kind = vis(r["move"]["issuetype_name"]) + ('<span class="eng"><b>잘림</b> — %s</span>' % vis(trunc) if trunc else "")
        items.append(('%s<span class="eng">%s</span>' % (issue_to(r), pg.title(r)), kind,
                      '%s<span class="eng">마지막 실행: %s</span>' % (MOVE_OUTCOME[r["exec"]], pg.result_html(r)), pg.verify_html(r)))
    w('<div class="group" id="mv-list">\n<h3>이슈별 결과 <span class="muted">%s건</span></h3>\n' % fmt(len(rows)))
    pg.rows_block("l4", ("이슈 → 티켓", "유형", "결과", "확인 결과"), items, "옮긴 이슈 %s건 펼치기" % fmt(len(rows)))
    w('</div>\n')

    merge = [r for r in rows if r["move"]["related"]]
    if merge:
        w('<div class="group" id="mv-merge">\n<h3>합칠 후보 <span class="muted">%s건</span></h3>\n' % fmt(len(merge)),
          '<p>옮긴 티켓과 같은 일을 다루는 기존 티켓일 수 있음 — 합칠지 사람이 정함</p>\n')
        pg.rows_block("l3", ("이슈", "옮긴 티켓", "합칠 후보 티켓"),
                      [(pg.target(r), pg.move_keys_html(r), ", ".join(pg.jira_link(k, r["move"]["site"]) for k in r["move"]["related"]))
                       for r in merge], "합칠 후보 %s건 펼치기" % fmt(len(merge)))
        w('</div>\n')

    deleted = [(r, key, cids) for r in rows for key, cids in move_deleted(r)]
    if deleted:
        def comment_link(r, cid):
            if not re.fullmatch(r"[1-9][0-9]*", cid):
                return vis(cid)
            return '<a href="%s/issues/%d#issuecomment-%s">댓글 %s</a>' % (html.escape(pg.repo_url, quote=True),
                                                                        r["move"]["number"], cid, cid)
        w('<div class="group" id="mv-deleted">\n<h3>지워진 티켓 <span class="muted">%s건</span></h3>\n' % fmt(len(deleted)),
          '<p>옮긴 뒤 Jira에서 지워졌거나 읽을 수 없게 된 티켓입니다. 그 티켓을 가리키던 GitHub 이관 댓글은 사람이 지웁니다 — '
          '새 티켓의 이관 댓글과 둘이 남지 않게.</p>\n')
        pg.rows_block("l3", ("이슈", "지워진 티켓", "지울 댓글"),
                      [(pg.target(r), pg.jira_link(key, r["move"]["site"]),
                        ", ".join(comment_link(r, c) for c in cids) or '<span class="muted">기록된 이관 댓글 없음</span>')
                       for r, key, cids in deleted], "지워진 티켓 %s건 펼치기" % fmt(len(deleted)))
        w('</div>\n')

    left = [r for r in rows if r["exec"] not in ("done", "already")]
    w('<div class="group" id="mv-exits">\n<h3>끝나지 않은 이슈 — 다음 할 일 <span class="muted">%s건</span></h3>\n' % fmt(len(left)))
    if left:
        pg.rows_block("l3", ("이슈 → 티켓", "확인 결과", "다음 할 일"),
                      [(issue_to(r), pg.verify_html(r), vis(move_exit(r))) for r in left], "%s건 펼치기" % fmt(len(left)))
    else:
        w('<p class="muted">없음 — 모든 이슈가 옮겨졌거나 이미 옮겨져 있습니다.</p>\n')
    w('<p id="mv-reopened">%s</p>\n</div>\n' % vis(MOVE_REOPENED),
      '<p class="note" id="mv-limits"><b>한계</b> — %s</p>\n</section>\n' % " · ".join(vis(x) for x in MOVE_LIMITS))


def sort_key(r):
    a, ref = r["action"], r["ref"]
    m = re.fullmatch(r"(?:pr|issue)#([0-9]+)", ref)
    if m:
        return (0, int(m.group(1)), "")
    m = re.fullmatch(r"jira#([A-Z][A-Z0-9]+)-([0-9]+)", ref)
    if m:
        return (1, int(m.group(2)), m.group(1))
    return (2, 0, display_ref(ref)[0])


def render_kept(pg):
    m, w = pg.m, pg.w
    rows = m["rows"]
    w('<section class="part" aria-labelledby="s-kept">\n<h2 id="s-kept">남긴 것</h2>\n'
      '<p>판정한 뒤 남긴 항목, 판정하지 않은 항목, 계획에서 제외한 항목입니다. 이 정리는 이것들을 바꾸지 않았습니다.</p>\n')
    # 판정 후 남김
    keep = [r for r in rows if r["review"] == "keep" and r["area"] in ("pr", "issue", "jira")]
    w('<div class="group">\n<h3 id="s-keep">판정 후 남긴 것 <span class="muted">%s건</span></h3>\n' % fmt(len(keep)))
    if keep:
        items = []
        for r in sorted(keep, key=sort_key):
            ev = (r.get("jira") or r.get("unit"))["evidence"]
            why = vis(ev["reason"])
            if ev["v"] in P.JIRA_LEVELS:
                why = "옮김 판정(%s) — 이번 계획에서는 실행하지 않음: %s" % ("QA" if ev["v"] == "TO-QA" else "닫기", why)
            items.append((pg.target(r), pg.title(r), why))
        pg.rows_block("l3", ("대상", "제목", "남긴 이유"), items, "남긴 것 %s건 펼치기" % fmt(len(keep)))
    else:
        w('<p class="muted">없음</p>\n')
    w('</div>\n')
    # 판정 제외 — 최근 갱신
    recent = [r for r in rows if r.get("unit") and r["unit"]["evidence"]["v"] == "NOT-JUDGED"]
    w('<div class="group">\n<h3 id="s-recent">판정 제외 — 최근 30일 안에 갱신 <span class="muted">%s건</span></h3>\n' % fmt(len(recent)))
    if recent:
        items = []
        for r in sorted(recent, key=sort_key):
            s, ev = r["snapshot"], r["unit"]["evidence"]
            items.append((pg.target(r), "%s<span class=\"eng\">%s</span>" % (pg.title(r), vis(ev["reason"])),
                          "%s · 작성자 %s" % (vis(kst(s.get("updated", ""))), vis(known(s.get("author", "")))),
                          pg.tickets(ev["jira"]) if ev["jira"] else '<span class="muted">연결된 티켓 없음</span>'))
        pg.rows_block("l4", ("대상", "제목", "마지막 갱신 · 작성자", "연결된 티켓"), items, "%s건 펼치기" % fmt(len(recent)))
    else:
        w('<p class="muted">없음</p>\n')
    w('</div>\n')
    # 제외한 Jira
    xj = [r for r in rows if r.get("jira") and r["jira"]["kind"] == "unit" and r["jira"]["evidence"]["v"] in ("EXCLUDED", "NOT-JUDGED")]
    w('<div class="group">\n<h3 id="s-excluded">제외한 Jira <span class="muted">%s건</span></h3>\n' % fmt(len(xj)))
    if xj:
        items = [(pg.target(r), pg.title(r), vis(r["jira"]["status_name"]) if r["jira"].get("status_name") else
                  '<span class="muted">상태는 계획에 없음</span>',
                  "%s%s" % ("" if r["jira"]["evidence"]["v"] == "EXCLUDED" else "판정 못 함 — ", vis(r["jira"]["evidence"]["reason"])))
                 for r in sorted(xj, key=sort_key)]
        pg.rows_block("l4", ("대상", "요약", "지금 상태", "이유"), items, "%s건 펼치기" % fmt(len(xj)))
    else:
        w('<p class="muted">없음</p>\n')
    w('</div>\n')
    # 판정 기록 없는 PR·이슈
    plain = [r for r in rows if r["detail"] == "plain"]
    if plain:
        w('<div class="group">\n<h3 id="s-plain">열린 PR·이슈 — 판정 기록 없음, 손대지 않음 <span class="muted">%s건</span></h3>\n'
          % fmt(len(plain)))
        items = [(pg.target(r), pg.title(r), "%s · 작성자 %s" % (vis(kst(r["snapshot"].get("updated", ""))),
                                                              vis(known(r["snapshot"].get("author", "")))))
                 for r in sorted(plain, key=sort_key)]
        pg.rows_block("l3", ("대상", "제목", "마지막 갱신 · 작성자"), items, "%s건 펼치기" % fmt(len(plain)))
        w('</div>\n')
    # 브랜치 — 남김·제외 (승인 화면과 같은 사유 묶음)
    br = [r for r in rows if r["area"] == "branch" and r["review"] != "act"]
    order = {code: i for i, (code, _) in enumerate(HOLD_LABELS)}
    labels = dict(HOLD_LABELS)
    groups = {}
    for r in br:
        groups.setdefault(r["detail"], []).append(r)
    for code in sorted(groups, key=lambda c: order.get(c, len(order))):
        rs = groups[code]
        w('<div class="group">\n<h3 id="%s">%s <span class="muted">%s개</span></h3>\n' % (pg.nid("bg"), labels.get(code, labels["?"]), fmt(len(rs))))
        items = []
        for r in sorted(rs, key=sort_key):
            s = r["snapshot"]
            pr = (s.get("pr") or "").lstrip("#")
            prl = pg.gh("pull", int(pr), "PR #" + pr) + (" (%s)" % vis(s["pr_state"]) if s.get("pr_state") else "") \
                if re.fullmatch(r"[1-9][0-9]*", pr) else '<span class="muted">같은 이름 PR 없음</span>'
            why = source_text(r["evidence"][len("protected ("):].rstrip(")")) if code == "protected" else prl
            items.append((pg.target(r), "%s · %s" % (vis(known(s.get("tip_date", ""))), vis(known(s.get("tip_author", "")))), why))
        pg.rows_block("l3", ("브랜치", "마지막 커밋", "보호 출처" if code == "protected" else "같은 이름 PR"), items,
                      "%s개 목록 펼치기" % fmt(len(rs)))
        w('</div>\n')
    w('</section>\n')


def render_rest(pg, plan_name, digest):
    m, w = pg.m, pg.w
    manual = {id(d["row"]) for d in m["decisions"] if d["kind"] == "manual"}
    acts = [r for r in m["rows"] if r["review"] == "act" and id(r) not in manual]
    groups = (("bad", "실패·미해결", [r for r in acts if r["exec"] == "bad"]),
              ("warn", "목표 상태 확인 — 이번 실행이 옮긴 것 아님",
               [r for r in acts if r["exec"] == "already" and r["verify"]["status"] == "WARN" and not in_done(r)]),
              ("skip", "건너뜀", [r for r in acts if r["exec"] == "skip"]),
              ("notrun", "실행 안 함 — 이번 결과에 실행 기록이 없음", [r for r in acts if r["exec"] == "notrun"]))
    meta_bad = [x for x in m["vmeta"] if x["status"] != "OK"]
    n = sum(len(g[2]) for g in groups) + len(meta_bad)
    w('<section class="part" aria-labelledby="s-rest">\n<h2 id="s-rest">건너뜀·실패·미해결 <span class="muted">%s건</span></h2>\n' % fmt(n))
    if manual:
        w('<p>사람 확인이 필요해 멈춘 Jira %s건은 위 “결정이 필요한 것”에 있습니다.</p>\n' % fmt(len(manual)))
    if not n:
        w('<p class="muted" id="rest-none">건너뛰거나 실패한 항목이 없습니다.</p>\n</section>\n')
        return
    for key, label, rs in groups:
        if not rs:
            continue
        w('<div class="group" id="rest-%s">\n<h3>%s%s <span class="muted">%s건</span></h3>\n'
          % (key, shape("s-bad") if key == "bad" else "", label, fmt(len(rs))))
        items = [(pg.target(r), pg.title(r) or detail(pg, r), pg.result_html(r), pg.verify_html(r, raw=True))
                 for r in sorted(rs, key=sort_key)]
        pg.rows_block("l4", ("대상", "내용", "실행 기록", "확인 결과"), items, "%s %s건 펼치기" % (label, fmt(len(rs))))
        w('</div>\n')
    if meta_bad:
        what = {"p-invariant": "보호 브랜치", "p-touched": "보호 브랜치에 삭제 요청", "run": "실행 기록"}
        w('<div class="group" id="rest-meta">\n<h3>저장소 전체 확인 <span class="muted">%s건</span></h3>\n' % fmt(len(meta_bad)))
        items = []
        for x in meta_bad:
            try:
                ref = P.pdec(x["ref"].encode("utf-8"), "verify ref")
            except PlanError:
                ref = x["ref"]
            items.append(('<code class="ref">%s</code>' % vis(ref), what[x["action"]], VERIFY_WORD[x["status"]],
                          '<span class="eng">엔진 기록: %s</span>' % vis(x["text"])))
        pg.rows_block("l4", ("대상", "무엇", "결과", "확인 결과"), items, "%s건 펼치기" % fmt(len(meta_bad)))
        w('</div>\n')
    again_rows = [r for g in groups if g[0] in ("bad", "notrun") for r in g[2]]
    moves_left = [r for r in again_rows if r["action"] == MOVE]
    breaker = m["breaker"]
    if moves_left:          # move-issue 행이 있으면 다음 명령은 그 행들의 다음 할 일과 맞춘다(next_moves)
        next_moves(pg, digest, moves_left, any(r["action"] != MOVE for r in again_rows) or bool(meta_bad), breaker)
    elif (again_rows or meta_bad) and breaker[0]:
        w(breaker_html(pg, breaker))
    elif again_rows or meta_bad:
        w('<h3 id="s-next" class="group">다음 명령</h3>\n', next_command_html(pg, digest))
    if groups[2][2]:
        w('<p class="note">건너뛴 항목은 승인한 뒤 대상이 바뀌었거나 이미 처리돼 있던 것입니다. 다시 실행해도 같은 이유로 건너뛰니, '
          '다시 정리하려면 새 계획을 만드세요.</p>\n')
    w('</section>\n')


def next_command_html(pg, digest):
    """다시 실행 + 이어 붙여 확인 안내 문단과 명령(move-issue 행이 없는 보고서와 같은 바이트)."""
    return ('<p>같은 계획·같은 지문으로 실행을 다시 하고, 지금까지의 실행 결과에 새 결과를 이어 붙여 '
            '확인합니다. 이미 끝난 행은 다시 실행해도 바뀌지 않습니다.</p>\n'
            '<pre class="cmd" id="next-cmd">%s</pre>\n' % vis(next_command(pg.m, pg.given, digest)))


def move_next_kind(exit_text):
    """move-issue 행의 다음 할 일(move_exit) → 다음 명령에서의 몫, 처음 맞는 것(SKILL 10단계): '다음 정리'가 들어 있으면 later
    (이 계획으로 끝나지 않음 — 다시 실행할 이유 아님) · MOVE_RERUN으로 시작하면 rerun · MOVE_RERUN으로 끝나면 first(그 일을 먼저
    한 뒤 다시 실행) · 그 밖 owner(오너가 정함)."""
    if "다음 정리" in exit_text:
        return "later"
    if exit_text.startswith(MOVE_RERUN):
        return "rerun"
    if exit_text.endswith(MOVE_RERUN):
        return "first"
    return "owner"


def breaker_html(pg, breaker):
    """차단기 묶음의 머리와 원인 줄. 원인 행을 알면 BREAKER_TEXT + 풀리지 않은 원인마다 "차단기 원인 행: <대상> — 멈출 때 사유:
    <그 원인 결과의 사유>"(멈춘 실행의 결과 — 그 행의 지금 상태가 아니다; 그 행 실행 기록과 같은 말 — result_words; 다음 할 일은
    이슈별 표에) — 하나면 <p id="next-cause">, 여럿이면 <ul
    class="hist" id="next-cause">에 <li> 하나씩(차단 순서); '원인 모름' 표시도 있으면 BREAKER_CAUSE_UNKNOWN 한 줄을 더
    (<p id="next-cause-unknown">). '원인 모름' 표시만 있으면 BREAKER_TEXT_UNKNOWN 머리만(따로 원인 줄 없음)."""
    _on, causes, unknown = breaker
    head = '<h3 id="s-next" class="group">다음 할 일</h3>\n<p id="next-breaker">%s</p>\n'
    if not causes:
        return head % BREAKER_TEXT_UNKNOWN
    lines = ["차단기 원인 행: %s — 멈출 때 사유: %s" % (pg.target(c["row"]), pg.result_words(c["row"], c)) for c in causes]
    out = head % BREAKER_TEXT + ('<p id="next-cause">%s</p>\n' % lines[0] if len(lines) == 1 else
                                 '<ul class="hist" id="next-cause">%s</ul>\n' % "".join("<li>%s</li>" % x for x in lines))
    if unknown:
        out += '<p id="next-cause-unknown">차단기 원인 행: %s</p>\n' % BREAKER_CAUSE_UNKNOWN
    return out


def next_moves(pg, digest, moves_left, other_reason, breaker=(False, [], False)):
    """'건너뜀·실패·미해결'의 다음 명령 — 끝나지 않은 move-issue 행이 있을 때(실패·미해결·실행 안 함). 그 행마다 move_exit을
    move_next_kind로 나누고 처음 맞는 것:
    1. 다음 할 일에 MOVE_NO_RERUN(M20)이 있는 행, 또는 마지막 결과가 SKIP manual M20인 행(출구가 MOVE_ROW3_DONE이어도) → 명령
       없음: 다시 실행하면 Jira 단계가 그 행에서 또 멈춘다(쓰기 쪽 차단기), 나머지 행은 다음 정리로.
    1b. 차단기가 켜짐(breaker_state — 차단기로 멈춘 뒤 원인 행을 끝낸(OK) 실행이 없음, 또는 원인 모름) → 명령 없음: breaker_html
       (머리 + 원인 줄), 그리고 원인 행을 뺀 먼저 할 일 목록 · 원인을 고친 뒤 다시 실행할 행(rerun) · 다음 정리 · 오너가 정함.
    2. 다시 실행할 이유(rerun·first 행, 또는 move-issue가 아닌 실패·미해결·실행 안 함 행·저장소 전체 확인) → 명령. 그 앞에
       먼저 할 일 목록(first 행과 그 다음 할 일), 다음 정리 행 한 줄, 오너가 정할 행 한 줄.
    3. 그 밖(다음 정리·오너 행뿐) → 명령 없음, 다시 실행할 행이 없다는 한 줄과 두 묶음."""
    w = pg.w
    ex = [(r, move_exit(r)) for r in sorted(moves_left, key=sort_key)]
    by = {k: [r for r, e in ex if move_next_kind(e) == k] for k in ("later", "rerun", "first", "owner")}

    def names(rs):
        return ", ".join(pg.target(r) for r in rs)
    stop = [r for r, e in ex if MOVE_NO_RERUN in e or last_manual(r) == MOVE_M20]
    if stop:
        w('<h3 id="s-next" class="group">다음 할 일</h3>\n<p id="next-stop">이 계획은 다시 실행하지 않습니다 — 다시 실행하면 Jira 단계가 '
          '이 행에서 또 멈춥니다: %s. 나머지 행은 다음 정리에서 다룹니다.</p>\n' % names(stop))
        return
    on, causes, _unknown = breaker
    if on:       # 원인 행은 원인 줄에만 — 묶음에서 뺀다(원인이 여럿이면 전부)
        crows = {id(c["row"]) for c in causes}
        ex = [(r, e) for r, e in ex if id(r) not in crows]
        by = {k: [r for r, e in ex if move_next_kind(e) == k] for k in ("later", "rerun", "first", "owner")}
    later = '이 계획으로 끝나지 않음 — 다음 정리: %s' % names(by["later"]) if by["later"] else ""
    owner = '오너가 정함: %s' % names(by["owner"]) if by["owner"] else ""

    def first_list():
        if by["first"]:
            w('<p id="next-first-head">다시 실행하기 전에 먼저 할 일</p>\n<ul class="hist" id="next-first">%s</ul>\n'
              % "".join("<li>%s — %s</li>" % (pg.target(r), vis(e)) for r, e in ex if move_next_kind(e) == "first"))
    if on:
        w(breaker_html(pg, breaker))
        first_list()
        if by["rerun"]:
            w('<p id="next-rerun">원인을 고친 뒤 다시 실행할 행: %s</p>\n' % names(by["rerun"]))
        if later:
            w('<p id="next-later">%s</p>\n' % later)
        if owner:
            w('<p id="next-owner">%s</p>\n' % owner)
        return
    if by["rerun"] or by["first"] or other_reason:
        w('<h3 id="s-next" class="group">다음 명령</h3>\n')
        first_list()
        if later:
            w('<p id="next-later">%s</p>\n' % later)
        if owner:
            w('<p id="next-owner">%s</p>\n' % owner)
        w(next_command_html(pg, digest))
        return
    w('<h3 id="s-next" class="group">다음 할 일</h3>\n<p id="next-none">같은 계획으로 다시 실행할 행이 없습니다.%s%s</p>\n'
      % (" %s." % later if later else "", " %s." % owner if owner else ""))


def shell_path(p):
    """명령 줄에 준 경로 그대로 → 셸 단어 하나. - 로 시작하는 상대 경로는 ./ 를 붙여 옵션으로 읽히지 않게 한다."""
    return shlex.quote("./" + p if p.startswith("-") else p)


def next_command(m, given, digest):
    """다시 실행 + 이어 붙여 확인 — 모든 동적 인자는 shlex.quote(HTML 이스케이프는 그다음, 호출자가)."""
    tiers = sorted({r["tier"] for r in m["rows"] if r["review"] == "act"})
    repo, plan, dg = shlex.quote(m["hdr"]["remote"]), shell_path(given["plan"]), shlex.quote(digest)
    cat = " ".join(shell_path(x) for x in given["results"]) + " apply-next.out"
    return ("scripts/chore.sh apply %s --plan %s --digest %s --tiers %s%s > apply-next.out\n"
            "cat %s > results-all.out\n"
            "scripts/chore.sh verify %s --plan %s --digest %s --results results-all.out"
            % (repo, plan, dg, ",".join(str(t) for t in tiers), " --yes" if 2 in tiers else "", cat, repo, plan, dg))


def render_footer(pg, plan_name, digest, verify_name):
    m, w = pg.m, pg.w
    A = m["areas"]

    def att(actions):
        return sum(1 for r in m["rows"] if r["action"] in actions and r.get("attempted"))
    n_moves = len(m["moves"])
    cov = [("PR 판정", A["pr"]["structured"]), ("PR 닫기 결정", A["pr"]["review"]["act"]),
           ("이슈 판정", A["issue"]["structured"]), ("이슈 닫기 결정", A["issue"]["review"]["act"] - n_moves)]
    cov += [("이슈 Jira로 옮기기 결정", n_moves)] if n_moves else []
    cov += [("Jira 판정", A["jira"]["structured"]), ("Jira 옮기기 결정", A["jira"]["review"]["act"]),
            ("PR 닫기 실행", att(("close-pr",))), ("이슈 닫기 실행", att(("close-issue",)))]
    cov += [("이슈 Jira로 옮기기 실행", att((MOVE,)))] if n_moves else []
    cov += [("Jira 옮기기 실행", att((JIRA,))), ("원격 브랜치 삭제 실행", att(("delete-remote",))), ("로컬 정리 실행", att(LOCAL_ACTIONS))]
    runs = m["runs"]
    scope = {"full": 0, "only-group": 0, None: 0}
    for r in runs:
        scope[r["scope"] if r["scope"] in ("full", "only-group") else None] += 1
    run_bits = ["전체 실행 %d" % scope["full"], "그룹만 실행 %d" % scope["only-group"]]
    if scope[None]:
        run_bits.append("범위 기록 없음 %d" % scope[None])
    stopped = sum(1 for r in runs if r["kind"] == "ABORTED")
    if stopped:
        run_bits.append("중간에 멈춤 %d" % stopped)
    w('<footer>\n<p id="coverage"><b>이번에 실제로 한 것</b> — %s · 실행 %d회(%s)</p>\n'
      % (" · ".join('%s <span id="cov-%d">%s</span>건' % (k, i, fmt(v)) for i, (k, v) in enumerate(cov)), len(runs), " · ".join(run_bits)),
      '<p id="def-proof">%s</p>\n' % DEFINITION,
      '<dl class="meta">\n<dt>계획 파일</dt><dd><code>%s</code></dd>\n' % vis(plan_name),
      '<dt>지문</dt><dd class="fp">%s</dd>\n' % digest,
      '<dt>실행 결과</dt><dd>%s</dd>\n' % ", ".join("<code>%s</code>" % vis(x) for x in pg.names),
      '<dt>확인 결과</dt><dd><code>%s</code></dd>\n</dl>\n</footer>\n' % vis(verify_name))


# ───────────────────────── 실행 ─────────────────────────

def one_line(e):
    return str(e).replace("\r", "\\r").replace("\n", "\\n")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="chore-report.py", allow_abbrev=False,
                                 description="chore 정리 실행 결과(계획 + apply 출력 + verify 출력)를 보고서 HTML 한 장으로 만든다.")
    ap.add_argument("--plan", required=True, help="승인된 계획 TSV (sha256 = --digest)")
    ap.add_argument("--digest", required=True, help="승인 때 기록한 계획 sha256")
    ap.add_argument("--results", required=True, action="append", help="chore.sh apply 표준 출력 (여러 번 = 준 순서로 이어 붙인 실행들)")
    ap.add_argument("--verify", required=True, help="chore.sh verify 표준 출력 (위 결과들을 이어 붙여 확인한 것)")
    ap.add_argument("--out", required=True, help="쓸 HTML 경로")
    ap.add_argument("--repo-url", required=True, help="https://github.com/<owner>/<repo> (계획의 저장소)")
    ap.add_argument("--payloads", help="승인 때 만든 새 티켓 본문 파일 폴더 (계획에 move-issue 행이 있을 때만, 그때는 필수)")
    ap.add_argument("--title-date", help="보고서 날짜 YYYY-MM-DD (기본 = 오늘, KST)")
    a = ap.parse_args(argv)
    try:
        repo_url = a.repo_url.rstrip("/")
        m = re.fullmatch(r"https://github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)", repo_url)
        if not m or m.group(2) in (".", "..") or m.group(2).lower().endswith(".git"):
            raise ReportError("--repo-url must be https://github.com/<owner>/<repo> (host github.com, no .git)")
        if not re.fullmatch(r"[0-9a-f]{64}", a.digest):
            raise ReportError("--digest must be a lowercase sha256 hex digest")
        if a.title_date is None:
            title_date = datetime.now(KST).strftime("%Y-%m-%d")
        else:
            try:
                ok = re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", a.title_date) and date.fromisoformat(a.title_date)
            except ValueError:
                ok = False
            if not ok:
                raise ReportError("--title-date must be a calendar date YYYY-MM-DD")
            title_date = a.title_date
        try:
            with open(a.plan, "rb") as fh:
                data = fh.read()
        except OSError as e:
            raise ReportError("cannot read plan %s: %s" % (a.plan, e.strerror or e))
        digest = hashlib.sha256(data).hexdigest()
        if digest != a.digest:
            raise ReportError("plan digest %s != --digest %s — not the approved plan" % (digest, a.digest))
        hdr, rows = P.parse_plan(data)
        if repo_slug(repo_url).lower() != hdr["remote"].lower():
            raise ReportError("--repo-url %s is not the plan's repository %s" % (repo_url, hdr["remote"]))
        load_payloads(a.payloads, rows)
        idx ={(r["action"], enc_ref(r["ref"])): r for r in rows if r["tier"] in (1, 2)}
        runs, results = parse_results(a.results, hdr, idx)
        vrows, vmeta, vsum = parse_verify(a.verify, idx, hdr, runs)
        model = build_model(hdr, rows, runs, results, vrows, vmeta, vsum)
        page = render(model, os.path.basename(a.plan), digest, [os.path.basename(x) for x in a.results],
                      os.path.basename(a.verify), repo_url, title_date, {"plan": a.plan, "results": list(a.results)})
        out_dir = os.path.dirname(os.path.abspath(a.out))
        fd, tmp = tempfile.mkstemp(prefix=".chore-report.", suffix=".html", dir=out_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(page)
            os.chmod(tmp, 0o644)
            os.replace(tmp, a.out)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    except (PlanError, ReportError, OSError) as e:
        print("chore-report: error: %s" % one_line(e), file=sys.stderr)
        return 1
    print("chore-report: wrote %s (plan %s, %d rows, %d runs, success=%s)"
          % (a.out, digest, len(rows), len(runs), vsum["success"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
