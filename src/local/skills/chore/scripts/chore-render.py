#!/usr/bin/env python3
"""chore-render.py — chore 정리 계획(TSV v3 + 엔진 JSON)을 승인용 HTML 한 장으로 렌더 (2026-10-15).

    python3 -I scripts/chore-render.py --plan plan.tsv --json plan.json --out plan.html \
        [--repo-url https://github.com/<owner>/<repo>] [--payloads DIR]

- 권위 원본 = --plan TSV. 페이지의 수량·목록은 전부 이 파일에서 계산하고, 승인 대상 = 페이지에 찍힌
  이 파일 바이트 전체의 sha256. 엔진 JSON은 분류(reason·protected_by·group)와, 계획 행에 title이 없는 옛 계획의
  닫을 PR·이슈 제목만 준다.
- 값 디코딩: 구조(탭→열, ;→쌍, 첫 =→키/값, ,→목록, 첫 :→이름/oid, 행 ref의 날것 remote:/local: 접두)를
  바이트로 먼저 나눈 뒤 값마다 percent-decoding 정확히 한 번 → UTF-8. 받는 입력 = 엔진 pdec가 받는 정규 인코딩뿐
  (0x01–0x1F·0x7F·% ; , = : 와 머리 줄의 공백만 %XX 대문자, 나머지는 날것; 자세히는 chore_plan.pdec). expected 칸은
  엔진처럼 디코딩하지 않는다. 비정규 이스케이프·raw 제어 바이트·NUL·머리 줄 값의 제어 문자 = 오류.
- v4 판정 행(2026-10-19): Jira 옮기기 행 = "Jira 옮기기" 카드(키 순), 판정이 갈리지 않은(AMBIGUOUS) PR·이슈·Jira =
  "결정이 필요한 것" 카드(정할 사람별, 실행 없음), 그 밖의 판정 행 = "이번에 남기는 것", Jira 검색 총수 행 = 프로젝트별
  대조 줄. 화면 값은 전부 지문을 찍은 계획 행에서만 온다(판정 파일·verdicts.json은 읽지 않는다). Jira 행은 엔진 JSON에
  없는 행이라 결합하지 않는다. Jira 링크 사이트 = 검색 총수 행의 site — 계획 하나에 Jira 사이트·프로젝트 하나와
  배포 실행 링크 모양(이 저장소의 actions/runs/<run>)은 chore_plan이 검사한다.
- v4.3 move-issue 행(2026-10-21, design v9 §9): 남길 GitHub 이슈를 바인딩 Jira 프로젝트로 옮기는 행 = "Jira로 옮기기" 카드
  (이슈 번호 순, Jira 옮기기 칸 다음). 엔진의 report 행 issue#N을 같은 자리에서 바꾼 행이라 닫기 행처럼 그 report 행과
  결합하고, 제목은 계획 snapshot title. 계획에 move-issue 행이 있으면 --payloads DIR이 필수다: 판정 build가 쓴
  행마다 issue-<N>.json 정확히 하나, 그 밖의 항목 없음, 파일 바이트 sha256 == snapshot payload_sha, 정규형 JSON(canon_json),
  fields.description이 chore_plan.parse_blocks를 통과 — 하나라도 어기면 오류. 행이 없으면 --payloads는 빼거나 빈 폴더(build가
  만든 것, 점 파일도 없음)만 받는다 — 페이지는 둘 다 같은 바이트. 카드의 설명 미리보기·요약·잘림 표시는 이 검사를 통과한 파일에서만 온다.
- 형식 오류 = stderr 한 줄 + exit 1, --out은 건드리지 않는다(임시 파일 → os.replace).
- 표준 라이브러리만, 네트워크 접근 없음, 출력 HTML에 외부 리소스·스크립트 없음(펼침 = <details>).
"""
import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import unicodedata
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _load_plan_module():
    """계획 TSV 문법 = scripts/chore_plan.py 한 벌(판정·렌더·보고·헬퍼가 같은 파서). python3 -I로는 같은 폴더의
    모듈이 import 경로에 없어서, 이 파일 옆의 chore_plan.py를 경로로 읽는다."""
    spec = importlib.util.spec_from_file_location("chore_plan", Path(__file__).resolve().parent / "chore_plan.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_PLAN = _load_plan_module()
_PLAN_NAMES = ("HEADER_TAG", "HEADER_KEYS", "LIST_KEYS", "TIP_KEYS", "ACTIONS", "PR_REF", "ISSUE_REF", "CLOSE_ACTIONS",
               "LOCAL_ACTIONS", "ALLOWED", "SNAP_EXACT", "SNAP_REPORT", "HEX", "ESC", "ESC_SP", "HEX40", "HEX40B", "ISO",
               "RUN_ID", "PlanError", "pdec", "penc", "iso_ok", "hasctl", "raw_text", "valid_branch", "parse_header",
               "parse_snapshot", "parse_plan", "check_ref", "check_row_values", "check_plan_rows",
               "JIRA_ACTION", "JIRA_KEY_REF", "JIRA_PROJECT_REF", "JIRA_KEY", "jira_time",
               "MOVE_ACTION", "parse_blocks", "comment_body", "move_truncated", "canon_json", "payload_bytes")
globals().update({_n: getattr(_PLAN, _n) for _n in _PLAN_NAMES})

KST = timezone(timedelta(hours=9))

# 보존 사유 코드 → 운영자 문구 (화면에는 문구만 나간다; 순서 = 페이지 표시 순서)
HOLD_LABELS = (
    ("merge-not-in-base", "현재 통합 히스토리에서 병합 커밋을 확인하지 못한 브랜치 — 보존"),
    ("merge-commit-unknown", "병합 커밋 확인 불가 — 보존"),
    ("same-as-integration-tip", "통합 브랜치 끝과 같은 커밋인 브랜치 — 보존"),
    ("contained-hold", "통합 브랜치에 내용은 들어 있지만 정확히 맞는 병합 PR이 없는 브랜치 — 보존"),
    ("stale", "오래됐지만 병합 근거가 없는 브랜치 — 보존"),
    ("checked-out", "작업 폴더에서 열려 있는 로컬 브랜치 — 보존"),
    ("local-held", "로컬 브랜치 — 이번 실행에서는 정리하지 않음"),
    ("worktree-prune", "작업 폴더 목록 정리 — 이번 실행에서는 하지 않음"),
    ("open-pr", "열린 PR — 손대지 않음"),
    ("open-issue", "열린 이슈 — 손대지 않음"),
    ("close", "닫기 행이지만 이번 실행 대상이 아님 — 손대지 않음"),
)
HOLD_OTHER = "그 밖의 이유로 남기는 항목 — 보존"
# 판정 기록이 붙은 tier-3 행(PR·이슈 구조형 증거, Jira 티켓)의 보존 묶음 — 브랜치 묶음(HOLD_LABELS) 앞에 보인다.
# 결정 필요(AMBIGUOUS)는 여기 없다: "결정이 필요한 것" 칸에 따로 나온다. ("확인 필요" 표지는 apply가 계획을 거부하는
# 행에만 쓴다 — check_note)
UNIT_LABELS = (
    ("unit-keep", "내용을 확인하고 남기는 PR·이슈"),
    ("jira-keep", "내용을 확인하고 남기는 Jira 티켓"),
    ("unit-recent", "최근 30일 안에 갱신 — 판정 제외"),
    ("jira-excluded", "판정에서 제외한 Jira 티켓"),
)
# 결정 필요 항목의 정할 사람(owner) → 묶음 제목. author:<login>은 로그인마다 한 묶음.
OWNER_LABELS = {"me": "직접 정할 것", "creator": "티켓을 만든 사람에게 물어볼 것", "qa-team": "QA 담당에게 물어볼 것",
                "unknown": "정할 사람이 아직 정해지지 않은 것"}
OWNER_ORDER = {"me": 0, "author": 1, "creator": 2, "qa-team": 3, "unknown": 4}
LEVEL_WORD = {"TO-QA": "배포 확인됨", "TO-CLOSED": "중복·대체"}   # 실행 행(옮기기 카드)에만 — 증명이 붙은 행
# 실행하지 않는 tier-3 Jira 행의 판정 의견(옮기기 판정이지만 이 계획이 증명을 확인하지 않음) — 증명 문구를 쓰지 않는다
OPINION_WORD = {"TO-QA": "판정 의견은 QA로 옮기기 — 이 계획에서 배포를 확인하지 않아 옮기지 않음",
                "TO-CLOSED": "판정 의견은 닫기 — 이 계획에서 근거를 확인하지 않아 닫지 않음"}
# 검색 총수 대조의 칸 = 판정 값 목록(모르는 값이 오면 합이 어긋나 렌더가 멈춘다)
INV_KEPT = ("KEEP", "AMBIGUOUS", "TO-QA", "TO-CLOSED")
INV_EXCLUDED = ("EXCLUDED", "NOT-JUDGED")
ROLE_WORD = {"required": "필요한 변경", "superseded": "대체됨", "unrelated": "관련 없음"}

# protected_by 출처 → 사람 말. 엔진(chore.sh P_MATCH) 형식 = "출처, 출처, … +N more"(최대 4개),
# 출처 = kind 또는 kind#상세(ruleset#<id>, environment#<이름>, workflow#<파일>, open-pr-head#<N>, open-pr-base#<N>).
# 표기 차이(--접두·밑줄·대소문자·kind:상세)는 흡수하고, 모르는 출처는 원문 그대로 쓴다. 순서 = 화면 표시 순서.
SOURCE_KINDS = (
    ("default", ("default", "default-branch"), "기본 브랜치"),
    ("protection", ("branch-protection", "protected-branch", "protected-branches", "protection", "protected"),
     "브랜치 보호 규칙"),
    ("ruleset", ("ruleset", "rulesets"), "저장소 규칙(ruleset)"),
    ("environment", ("environment", "environments", "env"), "배포 환경"),
    ("workflow", ("workflow", "workflows", "workflow-trigger"), "배포 워크플로가 반응하는 브랜치"),
    ("pr-head", ("open-pr-head", "pr-head"), "열린 PR의 브랜치"),
    ("pr-base", ("open-pr-base", "pr-base"), "열린 PR의 대상 브랜치"),
    ("protect", ("protect", "manual"), "직접 지정한 보호 패턴"),
    ("integrate", ("integrate",), "통합 브랜치로 직접 지정"),
)
SOURCE_ALIAS = {alias: (i, kind, label) for i, (kind, aliases, label) in enumerate(SOURCE_KINDS) for alias in aliases}
SOURCE_DETAIL = {"ruleset": "규칙 #%s", "environment": "환경 %s", "workflow": "워크플로 %s"}

DELETE_GROUPS = (  # (그룹 키, 접두사들, 표시 이름) — 첫 / 앞 접두사(소문자 비교)
    ("deploy", ("deploy",), "배포 승격용 브랜치"),
    ("feature", ("feature", "feat"), "기능 브랜치"),
    ("fix", ("fix", "hotfix", "bugfix"), "수정 브랜치"),
    ("chore", ("chore", "docs", "refactor", "test", "ci", "build"), "정리·문서·설정 브랜치"),
)

# 승인 화면에서 보이지 않거나 다른 글자로 착각될 수 있는 문자 → 테두리 친 U+XXXX 표지(.hid)로 드러낸다:
# 제어·서식·구분·사용자 정의·미할당·서러게이트 범주, C1 제어
# + 일반 공백(U+0020)이 아닌 공백(Zs: U+00A0·U+2000–200A·U+202F·U+205F·U+3000 …)
# + Default_Ignorable_Code_Point 고정표 = Unicode 16.0 DerivedCoreProperties.txt 그대로
#   (범주로는 안 잡히는 U+034F = Mn, 한글 채움 문자, 이체 선택자, 태그 문자 E0000–E0FFF 포함)
# + 빈칸처럼 보이는 글자 U+2800(BRAILLE PATTERN BLANK, 범주 So)
HIDDEN_CATS = {"Cc", "Cf", "Zl", "Zp", "Co", "Cn", "Cs"}
BLANK_LOOKING = {0x2800}
DEFAULT_IGNORABLE = ((0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5),
                     (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
                     (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
                     (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF))


def hidden_char(o):
    if 0x80 <= o <= 0x9F or o in BLANK_LOOKING or any(lo <= o <= hi for lo, hi in DEFAULT_IGNORABLE):
        return True
    cat = unicodedata.category(chr(o))
    return cat in HIDDEN_CATS or (cat == "Zs" and o != 0x20)


def load_engine_json(path, hdr):
    try:
        with open(path, "rb") as fh:
            doc = json.loads(fh.read().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise PlanError("engine JSON %s: %s" % (path, e))
    if not isinstance(doc, dict) or not isinstance(doc.get("rows"), list) \
            or not isinstance(doc.get("header"), dict) or not isinstance(doc.get("plan_sha256"), str):
        raise PlanError("engine JSON: expected an object with plan_sha256, header and rows")
    if not re.fullmatch(r"[0-9a-f]{64}", doc["plan_sha256"]):
        raise PlanError("engine JSON: plan_sha256 is not a sha256 hex digest")
    jh = doc["header"]
    for k in ("remote", "run_id"):
        if jh.get(k) != hdr[k]:
            raise PlanError("engine JSON header %s=%r differs from plan %r (different engine run?)"
                            % (k, jh.get(k), hdr[k]))
    idx = {}
    for i, r in enumerate(doc["rows"]):
        if not isinstance(r, dict) or not isinstance(r.get("action"), str) \
                or not isinstance(r.get("ref"), str):
            raise PlanError("engine JSON rows[%d]: action/ref missing" % i)
        key = (r["action"], r["ref"])
        if key in idx:
            raise PlanError("engine JSON: duplicate (action, ref) %s %s" % key)
        idx[key] = r
    return doc["plan_sha256"], idx


def join_rows(rows, jidx):
    """TSV가 이긴다: 행마다 JSON에서 분류만 가져온다. close 행은 (report, 같은 ref)와 결합.
    Jira 행(옮기기·티켓·검색 총수)은 판정 build가 엔진 출력 뒤에 붙인 행이라 엔진 JSON에 없다 — 결합하지 않고, 뺀
    항목으로도 세지 않는다(엔진 JSON에 같은 행이 있으면 그 행만 소비). 판정 기록이 붙은 PR·이슈 행은 ref가 같으니
    지금처럼 엔진의 report 행과 결합한다. move-issue 행은 판정 build가 엔진의 report 행 issue#N을 같은 자리에서 바꾼
    행이라 닫기 행처럼 (report, 같은 ref)와 결합하고, 카드 제목은 계획 snapshot title(지문에 묶임)."""
    used = set()
    for r in rows:
        if r.get("jira") is not None:
            if (r["action"], r["ref"]) in jidx:
                used.add((r["action"], r["ref"]))
            r["reason"] = r["protected_by"] = r["group"] = r["title"] = ""
            continue
        if r["action"] == MOVE_ACTION:
            key = ("report", r["ref"])
            j = jidx.get(key)
            if j is None:
                raise PlanError("line %d: plan row not in engine JSON: %s %s (looked for its report row)"
                                % (r["line"], r["action"], r["ref"]))
            used.add(key)
            r["reason"] = "move"
            r["protected_by"] = str(j.get("protected_by") or "")
            r["group"] = str(j.get("group") or "")
            r["title"] = r["snapshot"]["title"]
            continue
        close = r["action"] in CLOSE_ACTIONS
        key = ("report", r["ref"]) if close else (r["action"], r["ref"])
        j = jidx.get(key)
        if j is None:
            raise PlanError("line %d: plan row not in engine JSON: %s %s%s" % (
                r["line"], r["action"], r["ref"], " (looked for its report row)" if close else ""))
        used.add(key)
        if not close and r["action"] != "report" and j.get("reason") == "protected":
            raise PlanError("line %d: engine JSON marks %s %s as protected but the plan executes it — plan/engine mismatch"
                            % (r["line"], r["action"], r["ref"]))
        r["reason"] = "close" if close else str(j.get("reason") or "")
        r["protected_by"] = str(j.get("protected_by") or "")
        r["group"] = str(j.get("group") or "")
        # 닫기 카드 제목: 계획 행의 title(snapshot 마지막 키, 지문에 묶임)이 이기고, 없는 옛 계획만 엔진 JSON 제목
        r["title"] = r["title"] if r.get("title") else str(j.get("evidence") or "")
    return [j for k, j in jidx.items() if k not in used]


# ───────────────────────── v4.3 move-issue 설명 파일 (--payloads, 계약 §3) ─────────────────────────

PAYLOAD_NAME = "issue-%d.json"   # 잘림(설명 블록 10) 판정은 chore_plan.move_truncated 하나 — 안내 머리 글을 베끼지 않는다


def payload_skeleton(mv):
    """그 행이 승인한 POST 본문의 fields — 필드 집합과 요약·설명 밖의 값을 chore_plan.payload_bytes(유일한 정의)에서 직접
    얻는다(사본 집합을 두지 않는다): 행 snapshot의 project_id · issuetype · account로 만든 본문의 fields, 요약·설명 자리는 빈 값."""
    try:
        return json.loads(payload_bytes(mv["project_id"], mv["issuetype"], "-", mv["account"], {}))["fields"]
    except PlanError as e:
        raise PlanError("move row %s: %s" % (mv["number"], e))


def load_payloads(path, rows):
    """--payloads DIR → {이슈 번호: {"summary", "blocks", "trunc"}} (계약 §3). 계획에 move-issue 행이 있으면 DIR 필수,
    없으면 DIR은 빼거나 항목이 하나도 없는(점 파일 포함) 폴더 — 그 밖은 오류. DIR = 행마다 issue-<N>.json 정확히 하나
    (보통 파일), 그 밖의 항목 없음; 파일마다 sha256(바이트) == 그 행 snapshot payload_sha → UTF-8 JSON →
    canon_json(읽은 값) == 파일 바이트(정규형) → 맨 위 키 = {"fields"} → 필드 집합과 요약·설명 밖의 값 = payload_skeleton(그 행)
    (chore_plan.payload_bytes가 그 행 snapshot으로 만드는 것: assignee null · reporter {"id": account} · project {"id": project_id}
    · issuetype {"id": issuetype}) — 카드의 담당자·보고자·프로젝트·유형 표기는 이렇게 바이트와 대조한 것이다 →
    fields.summary(글) · fields.description이 parse_blocks를 통과. 오류 문구의 경로·이름은 %r(한 줄 보장)."""
    moves = sorted((r for r in rows if r["action"] == MOVE_ACTION), key=lambda r: r["move"]["number"])
    if path is None:
        if moves:
            raise PlanError("the plan has %d move-issue rows — --payloads DIR (the ticket descriptions build wrote) is required"
                            % len(moves))
        return {}
    try:
        names = set(os.listdir(path))
    except OSError as e:
        raise PlanError("--payloads %r: cannot list the directory (%s)" % (path, e.strerror or e))
    if not moves:   # 스킬은 언제나 --payloads를 준다 — 옮기기 행이 없는 계획이면 build가 빈 폴더를 만든다
        if names:
            raise PlanError("--payloads %r: the plan has no move-issue rows, so the folder must be empty — found %s"
                            % (path, ", ".join("%r" % n for n in sorted(names))))
        return {}
    want = {PAYLOAD_NAME % r["move"]["number"]: r for r in moves}
    missing = [n for n in want if n not in names]
    if missing:
        raise PlanError("--payloads %r: missing %s (one file per move-issue row)" % (path, ", ".join(missing)))
    extra = sorted(names - set(want))
    if extra:
        raise PlanError("--payloads %r: unexpected entries %s (only issue-<N>.json for the plan's move-issue rows)"
                        % (path, ", ".join("%r" % n for n in extra)))
    out = {}
    for name, r in want.items():
        p = os.path.join(path, name)
        try:
            if not stat.S_ISREG(os.lstat(p).st_mode):
                raise PlanError("--payloads %r: %s is not a regular file" % (path, name))
            with open(p, "rb") as fh:
                data = fh.read()
        except OSError as e:
            raise PlanError("--payloads %r: cannot read %s (%s)" % (path, name, e.strerror or e))
        got = hashlib.sha256(data).hexdigest()
        if got != r["move"]["payload_sha"]:
            raise PlanError("--payloads %r: %s sha256 %s is not line %d payload_sha %s (not the approved ticket body)"
                            % (path, name, got, r["line"], r["move"]["payload_sha"]))
        try:
            doc = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as e:
            raise PlanError("--payloads %r: %s is not UTF-8 JSON (%s)" % (path, name, str(e).replace("\n", " ")))
        # 정규형 = move_payload가 쓰는 인코더 한 벌(canon_json)로 다시 인코딩한 바이트와 같음 — 중복 키·공백·키 순서가 다른
        # 파일은 읽은 값과 파일 바이트가 같은 것을 뜻하지 않는다
        if canon_json(doc, "--payloads") != data:
            raise PlanError("--payloads %r: %s is not canonical JSON (re-encoding it with chore_plan.canon_json gives other "
                            "bytes — duplicate keys, spacing or key order)" % (path, name))
        # 필드 집합과 담당자·보고자·프로젝트·유형 값 = 그 행 snapshot으로 payload_bytes가 만드는 것 — 카드의
        # "담당자 없음 · 보고자 = 실행 계정" 줄과 유형·프로젝트 표기는 이 검사를 통과한 파일에만 붙는다
        if not isinstance(doc, dict) or set(doc) != {"fields"} or not isinstance(doc["fields"], dict):
            raise PlanError("--payloads %r: %s top-level keys %r are not exactly ['fields'] (an object)"
                            % (path, name, sorted(doc) if isinstance(doc, dict) else type(doc).__name__))
        fields, skel = doc["fields"], payload_skeleton(r["move"])
        if set(fields) != set(skel):
            raise PlanError("--payloads %r: %s fields %r are not exactly %r (chore_plan.payload_bytes)"
                            % (path, name, sorted(fields), sorted(skel)))
        for key in sorted(set(skel) - {"summary", "description"}):   # assignee · issuetype · project · reporter (요약·설명은 아래)
            if json.dumps(fields[key], sort_keys=True) != json.dumps(skel[key], sort_keys=True):
                raise PlanError("--payloads %r: %s fields.%s %r is not %r (line %d snapshot)"
                                % (path, name, key, fields[key], skel[key], r["line"]))
        if not isinstance(fields["summary"], str):
            raise PlanError("--payloads %r: %s fields.summary is not text" % (path, name))
        try:
            blocks = parse_blocks(fields["description"])
        except PlanError as e:
            raise PlanError("--payloads %r: %s description: %s" % (path, name, e))
        out[r["move"]["number"]] = {"summary": fields["summary"], "blocks": blocks, "trunc": move_truncated(blocks)}
    return out


# ───────────────────────── v4 Jira·판정 행 ─────────────────────────

def unit_ev(r):
    """판정 기록이 붙은 tier-3 행의 증거(chore_plan이 푼 dict) — PR·이슈 구조형 증거 또는 Jira 티켓 행. 아니면 None."""
    if r.get("unit") is not None:
        return r["unit"]["evidence"]
    j = r.get("jira")
    if j is not None and j["kind"] == "unit":
        return j["evidence"]
    return None


def verdict(r):
    ev = unit_ev(r)
    return ev["v"] if ev is not None else None


def is_inventory(r):
    return r.get("jira") is not None and r["jira"]["kind"] == "inventory"


def key_order(key):
    """Jira 키 정렬 = (프로젝트, 번호 숫자) — TST-9가 TST-10보다 앞."""
    p, _, num = key.rpartition("-")
    return p, int(num)


def jira_sites(rows):
    """Jira 링크 사이트 = 프로젝트의 검색 총수 행 site. 계획 하나에 Jira 사이트·프로젝트가 하나뿐이고(옮기기 행 site도
    같음) 사이트 모양과 배포 실행 링크(https://github.com/<remote>/actions/runs/<run>)도 chore_plan.parse_plan이 이미
    확인했다 — 여기서는 다시 검사하지 않는다. → {프로젝트: 사이트}"""
    return {r["jira"]["project"]: r["jira"]["site"] for r in rows if is_inventory(r)}


# ───────────────────────── 표시 도우미 ─────────────────────────

REVEALED = set()  # 이번 렌더에서 드러낸 숨김 문자(코드포인트) — 머리 범례에 종류와 목록으로 찍는다


def hid_mark(o):
    code = "U+%04X" % o
    return '<span class="hid" role="img" aria-label="숨김 문자 %s" title="숨김 문자 %s">%s</span>' % (code, code, code)


def vis(s):
    """데이터 문자열 → HTML. 탭·개행은 그대로, 보이지 않거나 착각될 문자는 테두리 친 U+XXXX 표지(.hid)로
    드러낸다. 데이터에 글자 그대로 든 "<U+202E>"는 이스케이프 평문이라 표지와 구별된다."""
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


def is_hidden(ch):
    """vis·vis_plain 공통 판정: 탭·개행은 글자 그대로 두고, 나머지는 hidden_char 규칙."""
    return ch not in "\t\n" and hidden_char(ord(ch))


def vis_plain(s):
    """마크업을 넣을 수 없는 자리(<title>)용. 숨김 문자는 빼고 "(숨김 문자 N개 포함)"을 덧붙인다 — 코드 표기를
    글자로 쓰지 않으니 이름에 글자 그대로 든 "[U+XXXX]" 표기와의 충돌은 없앤다. 다만 이름에 그 덧붙임 문구가
    글자 그대로 들어 있으면 title이 같아질 수 있다: title은 탭 라벨일 뿐이고, 완전한 구별은 본문 h1의 테두리
    표지(.hid)가 맡는다."""
    s = str(s)
    n = sum(1 for ch in s if is_hidden(ch))
    text = "".join(ch for ch in s if not is_hidden(ch))
    return html.escape(text + (" (숨김 문자 %d개 포함)" % n if n else ""), quote=True)


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


def date_range(vals):
    ds = sorted(v for v in vals if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v or ""))
    if not ds:
        return "알 수 없음"
    return ds[0] if ds[0] == ds[-1] else "%s ~ %s" % (ds[0], ds[-1])


def parse_sources(src):
    """protected_by → (묶음 이름, [(kind, 상세)…], 생략된 출처 수).
    묶음 = 받은 문자열에 든 출처 종류의 조합(고정 순서). 엔진이 덧붙인 " +N more"는 묶음에 넣지 않고
    행마다 "외 N개 출처"로만 보인다 — 같은 종류 조합이면 생략 수가 달라도 한 묶음."""
    text = (src or "").strip()
    more = 0
    m = re.fullmatch(r"(.*?)\s*\+([0-9]+) more", text)
    if m:
        text, more = m.group(1), int(m.group(2))
    kinds, details = {}, []
    for part in (p.strip() for p in text.split(",")):
        if not part:
            continue
        key = part.lstrip("-").lower().replace("_", "-")
        m = re.fullmatch(r"-*([A-Za-z_-]+)[#:](.+)", part)
        if key in SOURCE_ALIAS:
            (i, kind, label), det = SOURCE_ALIAS[key], ""
        elif m and m.group(1).lower().replace("_", "-") in SOURCE_ALIAS:
            (i, kind, label), det = SOURCE_ALIAS[m.group(1).lower().replace("_", "-")], m.group(2)
        else:
            kinds.setdefault((len(SOURCE_KINDS), part), "기타 출처: " + part)
            continue
        kinds.setdefault((i, ""), label)
        if det:
            details.append((kind, det))
    if not kinds:
        return "출처 기재 없음", details, more
    label = " · ".join(kinds[key] for key in sorted(kinds))
    return label, details, more


def display_ref(ref):
    """엔진은 보존 행 ref에 remote:/local: 접두를 붙인다(git 브랜치 이름에는 ':'가 올 수 없다). → (이름, 로컬 여부)"""
    if ref.startswith("remote:"):
        return ref[7:], False
    if ref.startswith("local:"):
        return ref[6:], True
    return ref, False


SMALL_GROUP = 5  # 이보다 작은 "<접두사>/ 로 시작하는" 그룹은 "그 밖의 접두사 브랜치"로 모은다


def repo_slug(url):
    """GitHub 원격 표기(https·ssh·scp형) 또는 웹 URL → 원래 대소문자의 owner/repo, 못 읽으면 ""."""
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
    """화면용 owner/repo — 머리 줄 remote는 소문자라 원래 대소문자를 --repo-url → origin 순으로 찾는다.
    둘 다 remote와 (대소문자 무시) 같을 때만 쓴다; 없으면 remote 그대로."""
    for cand in (repo_slug(repo_url), repo_slug(hdr["origin"])):
        if cand and cand.lower() == hdr["remote"].lower():
            return cand
    return hdr["remote"]


def only_group_key(ref, action):
    """apply --only-group 값 = 엔진 grp(ref, action). close-pr → pull-requests, close-issue → issues, report 행의
    pr#N / issue#N → pull-requests / issues, "." → worktree, 나머지는 remote:/local: 접두를 뗀 이름의 첫 / 앞 + "/*"
    (/ 가 없으면 이름 그대로, 대소문자 유지) — 그래서 브랜치 pr#topic/a는 pr#topic/* 이지 pull-requests가 아니다.
    / · # · . 와 접두의 ':'는 정규 인코딩에서 늘 날것이라 디코딩한 ref에서 계산해도 엔진(인코딩된 ref)과 같다
    (__tests__/py/chore-render.test.sh 30이 엔진 AWK_LIB의 grp와 대조한다)."""
    if action == "close-pr":
        return "pull-requests"
    if action == "close-issue":
        return "issues"
    if action == JIRA_ACTION or (action == "report" and ref.startswith("jira#")):
        return "jira"  # 엔진 grp도 같다 — Jira 행은 --only-group으로 고를 수 없다(전체 실행에서만)
    if action == MOVE_ACTION:
        return "move"  # 이슈 → Jira 옮기기도 전체 실행에서만(엔진이 --only-group move를 거부한다)
    if action == "report" and re.fullmatch(r"pr#[0-9]+", ref):
        return "pull-requests"
    if action == "report" and re.fullmatch(r"issue#[0-9]+", ref):
        return "issues"
    if ref == ".":
        return "worktree"
    name = re.sub(r"^(remote|local):", "", ref, count=1)
    return name.split("/", 1)[0] + "/*" if "/" in name else name


def delete_group(ref):
    if "/" not in ref:
        return "noprefix", "접두사 없는 브랜치(티켓 번호 등)", ""
    p = ref.split("/", 1)[0]
    for key, prefixes, label in DELETE_GROUPS:
        if p.lower() in prefixes:
            return key, label, p + "/"
    return "x:" + p.lower(), "", p + "/"


class Page:
    def __init__(self, repo_url):
        self.repo_url = repo_url
        self.buf = []
        self.ids = 0
        self.itip_names = {}  # 통합 브랜치 끝 커밋 oid → 이름들 (머리 줄 Itips)
        self.jira_sites = {}  # Jira 프로젝트 → 사이트 (검색 총수 행; jira_sites)

    def w(self, *parts):
        self.buf.extend(parts)

    def nid(self, stem):
        self.ids += 1
        return "%s%d" % (stem, self.ids)

    def link(self, kind, num, text, cls=""):
        t = vis(text)
        c = ' class="%s"' % cls if cls else ""
        if not self.repo_url:
            return '<span%s>%s</span>' % (c, t) if cls else t
        return '<a%s href="%s/%s/%s">%s</a>' % (c, html.escape(self.repo_url, quote=True), kind, num, t)

    def jira_link(self, key, cls="", site=None):
        """Jira 티켓 키 → https://<사이트>/browse/<KEY> 링크. 사이트 = 주어진 값, 없으면 그 키 프로젝트의 검색 총수 행
        사이트; 둘 다 없으면(이 계획에 없는 프로젝트) 링크 없이 키만. 키·사이트는 chore_plan이 ASCII 모양을 확인한 값."""
        site = site or self.jira_sites.get(key.rpartition("-")[0])
        c = ' class="%s"' % cls if cls else ""
        if not site:
            return '<span%s>%s</span>' % (c, vis(key)) if cls else vis(key)
        return '<a%s href="%s">%s</a>' % (c, html.escape("https://%s/browse/%s" % (site, key), quote=True), vis(key))

    def ref_html(self, action, ref, it=True):
        """행의 대상 표시. 종류는 action이 정한다(브랜치 이름이 pr#7이어도 브랜치). it = 행 대상 표지(완전성 검사용)."""
        cls = "it" if it else ""
        if action in (JIRA_ACTION, "report") and JIRA_KEY_REF.fullmatch(ref):
            return self.jira_link(ref[len("jira#"):], cls)
        num = PR_REF.fullmatch(ref) if action in ("close-pr", "report") else None
        if num:
            return self.link("pull", num.group(1), "PR #" + num.group(1), cls)
        num = ISSUE_REF.fullmatch(ref) if action in ("close-issue", "report", MOVE_ACTION) else None
        if num:
            return self.link("issues", num.group(1), "이슈 #" + num.group(1), cls)
        if ref == "." and action in ("worktree-prune", "report"):
            return '<span class="%s">작업 폴더 목록</span>' % cls if cls else "작업 폴더 목록"
        if action == "report":
            name, local = display_ref(ref)
        else:
            name, local = ref, action.startswith("delete-local")
        body = '<code class="ref">%s</code>%s' % (vis(name), ' <span class="muted">(로컬)</span>' if local else "")
        return '<span class="%s">%s</span>' % (cls, body) if cls else body

    def pr_html(self, pr):
        p = (pr or "").lstrip("#")
        if re.fullmatch(r"[0-9]+", p):
            return self.link("pull", p, "#" + p)
        return vis(known(pr))


PR_STATE = {"MERGED": "병합됨", "OPEN": "열림", "CLOSED": "닫힘"}

CSS = """
:root{--ink:#000;--ink-60:rgba(0,0,0,.6);--ink-44:rgba(0,0,0,.44);--hair:rgba(0,0,0,.12);--fill:rgba(0,0,0,.04)}
*{box-sizing:border-box;border-radius:0}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--ink);font:400 16px/1.6 Inter,"Inter var",-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic","Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:1120px;margin:0 auto;padding:56px 24px 96px}
h1{font-size:clamp(30px,5vw,46px);line-height:1.2;font-weight:700;letter-spacing:-.015em;margin:0 0 20px}
h2{font-size:26px;line-height:1.3;font-weight:700;letter-spacing:-.01em;margin:0 0 16px}
h3,h4{font-size:20px;line-height:1.4;font-weight:600;margin:0}
p{margin:0 0 12px;max-width:72ch}
a{color:var(--ink);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
a:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"D2Coding",monospace;font-size:16px}
.ref{word-break:normal;overflow-wrap:anywhere;direction:ltr;unicode-bidi:bidi-override;unicode-bidi:isolate-override}
.muted{color:var(--ink-60)}
.part{border-top:1px solid var(--ink);margin-top:64px;padding-top:32px}
.lead{font-size:18px}
.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 20px;margin:24px 0 0}
.meta dt{color:var(--ink-60)}
.meta dd{margin:0;min-width:0}
.fp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:32px 0 0;padding:0;list-style:none;border-top:1px solid var(--hair)}
.stats li{padding:20px 20px 20px 0;border-bottom:1px solid var(--hair)}
.num{font-size:44px;line-height:1.1;font-weight:700;letter-spacing:-.02em;display:block}
.stats .lbl{color:var(--ink-60)}
.note{margin-top:16px}
.plain{list-style:none;margin:0;padding:0}
.plain>li{display:flex;flex-wrap:wrap;gap:4px 16px;padding:12px 0;border-bottom:1px solid var(--hair)}
.integ>li{display:grid;grid-template-columns:minmax(0,22rem) minmax(0,1fr)}
.group{margin-top:36px}
.ghead{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px}
.prefix{color:var(--ink-60)}
.gkey{color:var(--ink-60)}
.gkey code{color:var(--ink)}
.gmeta{margin:8px 0 0;color:var(--ink-60)}
.gmeta b{color:var(--ink);font-weight:600}
.badge{display:inline-block;background:var(--ink);color:#fff;padding:1px 10px;font-size:16px;font-weight:600;line-height:1.6}
.flag{display:inline-block;border:1px solid var(--ink);padding:0 6px;font-weight:600;line-height:1.5}
details{margin-top:12px;border-top:1px solid var(--hair)}
summary{cursor:pointer;padding:12px 0;font-weight:600}
summary:hover{text-decoration:underline;text-underline-offset:3px}
.rows{list-style:none;margin:0;padding:0}
.row{display:grid;gap:2px 16px;padding:10px 0;border-bottom:1px solid var(--hair)}
.del .row{grid-template-columns:minmax(0,3.2fr) minmax(0,.8fr) minmax(0,1.1fr) minmax(0,2fr) minmax(0,1.2fr) minmax(0,1.4fr)}
.kept .row{grid-template-columns:minmax(0,1.7fr) minmax(0,2fr) minmax(0,2.2fr)}
.kv{display:inline-block;max-width:100%;margin-right:16px}
.kv .muted{margin-right:6px}
.row.head{color:var(--ink-60);font-weight:600;border-bottom:1px solid var(--ink)}
.c{min-width:0}
.k,.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.card{border:1px solid var(--ink);padding:24px;margin-top:24px}
.card .say{margin:8px 0 0;font-weight:600}
.card .who{margin:8px 0 0;color:var(--ink-60)}
.comment{white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;background:var(--fill);border-left:2px solid var(--ink);padding:16px 18px;margin:16px 0 0;tab-size:4}
ol.steps{margin:0;padding-left:28px}
ol.steps li{padding:6px 0;max-width:80ch}
.undo{margin-top:28px;margin-bottom:8px}
.cmd{display:inline-block;max-width:100%;background:var(--fill);padding:6px 10px;overflow-wrap:anywhere}
.hid,.hidex{display:inline-block;border:1px solid var(--ink);background:var(--fill);padding:0 3px;margin:0 1px;
 font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:inherit;font-weight:600;line-height:1.3;
 direction:ltr;unicode-bidi:isolate}
.xlist{list-style:none;margin:0;padding:0}
.xlist li{padding:6px 0;border-bottom:1px solid var(--hair)}
footer{border-top:1px solid var(--ink);margin-top:72px;padding-top:24px;color:var(--ink-60)}
footer .meta dd{color:var(--ink)}
@media (max-width:760px){
 main{padding:32px 16px 72px}
 .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
 .num{font-size:36px}
 .meta{grid-template-columns:minmax(0,1fr);gap:0}
 .meta dd{margin-bottom:10px}
 .integ>li{grid-template-columns:minmax(0,1fr)}
 .del .row,.kept .row{grid-template-columns:minmax(0,1fr)}
 .row.head{display:none}
 .k{position:static;width:auto;height:auto;overflow:visible;clip:auto;clip-path:none;white-space:nowrap;color:var(--ink-60);margin-right:8px}
 .card{padding:18px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""


# ───────────────────────── 렌더 ─────────────────────────

def cell(label, value_html, extra="", label_class="k"):
    """격자 칸. label_class k = 좁은 화면에서 보이는 칸 이름, sr = 화면 낭독기 전용."""
    return '<span class="c%s"><span class="%s">%s</span>%s</span>' % (extra, label_class, label, value_html)


def ref_code(name):
    """문장 안의 브랜치 이름 — 양방향 문자가 주변 글자 순서를 바꾸지 못하게 .ref로 감싼다."""
    return '<code class="ref">%s</code>' % vis(name)


EXCLUDED_KIND = {"delete-remote": "원격 브랜치 삭제 후보", "delete-local": "로컬 브랜치 삭제 후보",
                 "delete-local-force": "로컬 브랜치 삭제 후보", "worktree-prune": "작업 폴더 목록 정리",
                 "report": "남기는 항목", "close-pr": "PR 닫기", "close-issue": "이슈 닫기", JIRA_ACTION: "Jira 옮기기"}


def render(hdr, rows, plan_name, digest, engine_sha, excluded_rows, repo_url, payloads=None):
    """payloads = load_payloads 결과(이슈 번호 → 검사를 통과한 설명). move-issue 행이 없는 계획의 페이지는 이 기능 전과
    바이트까지 같다 — 옮기기 칸·타일·요약 줄 조각·실행 단계는 move-issue 행이 있을 때만 나온다."""
    pg = Page(repo_url)
    REVEALED.clear()
    pg.jira_sites = jira_sites(rows)
    excluded = len(excluded_rows)
    # 허용표(ALLOWED)로 tier와 action이 묶여 있다: tier3 = report만, 실행 행 = tier1·2
    deletes = [r for r in rows if r["action"] == "delete-remote"]
    closes = [r for r in rows if r["action"] in CLOSE_ACTIONS]
    locals_ = [r for r in rows if r["action"] in LOCAL_ACTIONS]
    jira_moves = sorted((r for r in rows if r["action"] == JIRA_ACTION), key=lambda r: key_order(r["jira"]["key"]))
    jira_qa = [r for r in jira_moves if r["jira"]["level"] == "TO-QA"]
    jira_closed = [r for r in jira_moves if r["jira"]["level"] == "TO-CLOSED"]
    inventory = sorted((r for r in rows if is_inventory(r)), key=lambda r: r["jira"]["project"])
    issue_moves = sorted((r for r in rows if r["action"] == MOVE_ACTION), key=lambda r: r["move"]["number"])
    payloads = payloads or {}
    for r in issue_moves:
        if r["move"]["number"] not in payloads:
            raise PlanError("line %d: no verified ticket description for %s (--payloads)" % (r["line"], r["ref"]))
    # 화면 칸이 서로 겹치지 않게 나눈다: 결정 필요(AMBIGUOUS) = 그 칸, 검색 총수 행 = Jira 칸의 대조 줄, 나머지 report = 남김
    reports = [r for r in rows if r["action"] == "report" and not is_inventory(r)]
    ambiguous = [r for r in reports if verdict(r) == "AMBIGUOUS"]
    kept = [r for r in reports if verdict(r) != "AMBIGUOUS"]
    not_judged = [r for r in kept if r.get("unit") is not None and verdict(r) == "NOT-JUDGED"]
    close_prs = sorted((r for r in closes if r["action"] == "close-pr"), key=lambda r: int(r["ref"][3:]))
    close_issues = sorted((r for r in closes if r["action"] == "close-issue"), key=lambda r: int(r["ref"][6:]))
    protected = [r for r in kept if r["reason"] == "protected"]
    held = [r for r in kept if r["reason"] != "protected"]
    n_units = sum(1 for r in rows if r.get("unit") is not None)
    repo = display_repo(hdr, repo_url)
    repo_name = repo.rsplit("/", 1)[-1] or repo

    # 지울 브랜치 화면 그룹
    groups = {}
    for r in deletes:
        key, label, prefix = delete_group(r["ref"])
        g = groups.setdefault(key, {"key": key, "label": label, "prefixes": set(), "okeys": set(), "rows": []})
        if prefix:
            g["prefixes"].add(prefix)
        g["okeys"].add(only_group_key(r["ref"], r["action"]))
        g["rows"].append(r)
    for g in groups.values():  # 대소문자만 다른 접두사(IAC/·iac/)는 한 그룹; 제목은 정렬 첫 표기
        if not g["label"]:
            g["label"] = "%s 로 시작하는 브랜치" % sorted(g["prefixes"], key=lambda x: (x.lower(), x))[0]
    # 이름 붙은 그룹이 아닌 접두사 그룹 중 5개 미만은 "그 밖의 접두사 브랜치" 하나로 모아 이름 붙은 그룹 뒤에 둔다
    small = [g for g in groups.values() if g["key"].startswith("x:") and len(g["rows"]) < SMALL_GROUP]
    if small:
        other = {"key": "other", "label": "그 밖의 접두사 브랜치", "prefixes": set(), "okeys": set(), "rows": []}
        for g in small:
            del groups[g["key"]]
            other["prefixes"] |= g["prefixes"]
            other["okeys"] |= g["okeys"]
            other["rows"].extend(g["rows"])
        groups["other"] = other
    glist = sorted(groups.values(), key=lambda g: (g["key"] != "deploy", g["key"] == "other", -len(g["rows"]), g["label"]))
    # 실행 3단계에서 먼저 지울 그룹 = apply --only-group 키 하나로 고를 수 있는 그룹(키가 정확히 1개이고 그 키가 머리 줄
    # groups=에 있음) 중 배포 승격용, 없으면 행 수가 가장 많은 그룹(동률이면 화면 순서). 그런 그룹이 없으면 1단계를
    # 생략하고 한 번에 실행한다(SKILL 6단계 경로) — 키 여럿을 한 그룹처럼 안내하지 않는다.
    plan_groups = set(hdr["groups"])
    single = [g for g in glist if len(g["okeys"]) == 1 and next(iter(g["okeys"])) in plan_groups]
    deploy1 = [g for g in single if g["key"] == "deploy"]
    first = deploy1[0] if deploy1 else (max(single, key=lambda g: len(g["rows"])) if single else None)
    first_is_deploy = bool(deploy1)

    for name, oid in hdr["Itips"]:
        pg.itip_names.setdefault(oid, []).append(name)

    w = pg.w
    w('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n',
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n',
      '<meta name="color-scheme" content="light">\n',
      '<title>%s 저장소 정리 계획 — 승인 요청</title>\n' % vis_plain(repo_name),
      '<style>%s</style>\n</head>\n<body>\n<main>\n' % CSS)

    # 1. 머리
    w('<header>\n<h1>%s 저장소 정리 계획 — 승인 요청</h1>\n' % vis(repo_name),
      '<p class="lead">아래 계획 파일 하나를 승인해 주세요. 이 페이지의 수량과 목록은 모두 그 파일에서 계산했습니다.</p>\n',
      '<dl class="meta">\n',
      '<dt>저장소</dt><dd><code>%s</code></dd>\n' % vis(repo),
      '<dt>계획 생성 시각</dt><dd>%s</dd>\n' % vis(kst(hdr["created"])),
      '<dt>계획 파일 지문</dt><dd class="fp" id="fp">%s</dd>\n' % digest,
      '</dl>\n<ul class="stats">\n',
      '<li><span class="num" id="n-branches">%d</span><span class="lbl">지울 원격 브랜치</span></li>\n' % len(deletes),
      '<li><span class="num" id="n-prs">%d</span><span class="lbl">닫을 PR</span></li>\n' % len(close_prs),
      '<li><span class="num" id="n-issues">%d</span><span class="lbl">닫을 이슈</span></li>\n' % len(close_issues),
      '<li><span class="num" id="n-jira-qa">%d</span><span class="lbl">Jira → QA</span></li>\n' % len(jira_qa),
      '<li><span class="num" id="n-jira-closed">%d</span><span class="lbl">Jira → 닫기</span></li>\n' % len(jira_closed),
      '<li><span class="num" id="n-move">%d</span><span class="lbl">Jira로 옮길 이슈</span></li>\n' % len(issue_moves)
      if issue_moves else "",
      '<li><span class="num" id="n-ambiguous">%d</span><span class="lbl">결정 필요</span></li>\n' % len(ambiguous),
      '<li><span class="num" id="n-kept">%d</span><span class="lbl">이번에 남기는 항목</span></li>\n' % len(kept),
      '<li><span class="num" id="n-not-judged">%d</span><span class="lbl">그중 판정 제외(최근 갱신)</span></li>\n'
      % len(not_judged),
      '</ul>\n')
    # 승인 질문(AskUserQuestion)에 그대로 옮길 한 줄 — #confirm의 글자 = 그 줄 (Jira로 옮기기는 그 행이 있을 때만)
    w('<p class="note"><span class="muted">승인 질문 요약</span> <span id="confirm">PR 닫기 <b id="c-prs">%d</b> · '
      '이슈 닫기 <b id="c-issues">%d</b> · 브랜치 삭제 <b id="c-branches">%d</b> · Jira → QA <b id="c-jira-qa">%d</b> · '
      'Jira 닫기 <b id="c-jira-closed">%d</b>%s · 결정 필요 <b id="c-ambiguous">%d</b>%s</span></p>\n'
      % (len(close_prs), len(close_issues), len(deletes), len(jira_qa), len(jira_closed),
         ' · Jira로 옮기기 <b id="c-move">%d</b>건' % len(issue_moves) if issue_moves else "", len(ambiguous),
         ' · 로컬 정리 <b id="c-local">%d</b>' % len(locals_) if locals_ else ""))
    if locals_:
        w('<p class="note">이 밖에 로컬 정리 <b id="n-local">%d</b>건이 계획에 있습니다(아래 “로컬 정리”).</p>\n' % len(locals_))
    legend_at = len(pg.buf)
    w("")  # 범례 자리 — 페이지를 다 만든 뒤 드러낸 문자가 있으면 채운다
    name_check(pg, rows)
    w('<div class="note" id="excluded"><p class="muted">검토 단계에서 계획에서 뺀 항목 %d개</p>\n' % excluded)
    if excluded_rows:
        w('<details>\n<summary>뺀 항목 %d개 보기</summary>\n<ul class="xlist">\n' % excluded)
        for j in sorted(excluded_rows, key=lambda j: (str(j.get("action")), str(j.get("ref")))):
            act = str(j.get("action"))
            w('<li>%s <span class="muted">%s</span></li>\n'
              % (pg.ref_html(act, str(j.get("ref")), it=False), EXCLUDED_KIND.get(act, "기타 항목")))
        w('</ul>\n</details>\n')
    w('</div>\n</header>\n')

    # 2. 지우는 기준
    w('<section class="part" aria-labelledby="s-rule">\n<h2 id="s-rule">지우는 기준</h2>\n',
      '<p>원격 브랜치는 다음을 모두 만족할 때만 지웁니다. 같은 저장소의 브랜치이고, 병합이 끝난 PR이 있으며, '
      '그 PR의 병합 대상이 아래 통합 브랜치 중 하나여야 합니다.</p>\n',
      '<p>또 그 PR이 병합한 커밋이 지금 브랜치의 끝 커밋과 같고, 병합 커밋이 지금 통합 브랜치 히스토리에 들어 있어야 합니다.</p>\n',
      '<p>지운 브랜치는 계획에 기록된 끝 커밋으로 다시 만들 수 있습니다.</p>\n</section>\n')

    # 3. 통합 브랜치
    integ = list(hdr["I"])  # = default ∪ integrate (머리 줄 검사에서 확인)
    base_count = Counter(r["snapshot"].get("pr_base", "") for r in deletes)
    w('<section class="part" aria-labelledby="s-integ">\n<h2 id="s-integ">통합 브랜치</h2>\n',
      '<p>병합이 끝났다고 인정하는 대상 브랜치입니다. 이 목록에 없는 브랜치로 병합된 PR은 지우는 근거가 되지 않습니다.</p>\n',
      '<ul class="plain integ">\n')
    for n in integ:
        tag = ' <span class="muted">(기본 브랜치)</span>' if n == hdr["default"] else ""
        w('<li><span><code class="ref">%s</code>%s</span><span>이 브랜치로 병합된 삭제 후보 <b>%d</b>개</span></li>\n'
          % (vis(n), tag, base_count.get(n, 0)))
    w('</ul>\n')
    # 표시만 하는 이유: 승인자가 계획에서 뺄 행을 보도록 거부 대신 짚는다(검토 라운드 S3 설계, 테스트 19) —
    # apply는 이 계획을 "snapshot pr_base is not an integration ref of this plan"으로 거부한다
    stray = [r for r in deletes if r["snapshot"].get("pr_base", "") not in integ]
    if stray:
        check_note(pg, "통합 브랜치가 아닌 대상으로 병합된 삭제 후보 %d개가 계획에 있습니다." % len(stray),
                   [(r, "병합 대상 " + ref_code(known(r["snapshot"].get("pr_base", "")))) for r in stray])
    w('</section>\n')

    # 4. 절대 건드리지 않는 브랜치
    w('<section class="part" aria-labelledby="s-prot">\n<h2 id="s-prot">절대 건드리지 않는 브랜치</h2>\n',
      '<p>아래 출처 중 하나에라도 걸리는 브랜치는 어떤 근거가 있어도 지우지 않습니다. 모두 <b>%d</b>개입니다.</p>\n' % len(protected))
    if hdr["protect"]:
        w('<p>직접 지정한 보호 패턴: %s</p>\n' % ", ".join(ref_code(p) for p in hdr["protect"]))
    pgroups = {}
    for r in protected:
        label, r["sources"], r["sources_more"] = parse_sources(r["protected_by"])
        r["source_label"] = label
        pgroups.setdefault(label, []).append(r)
    for label, rs in sorted(pgroups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        hid = pg.nid("p")
        w('<div class="group kept">\n<div class="ghead"><h3 id="%s">%s</h3></div>\n' % (hid, vis(label)),
          '<p class="gmeta"><b>%d</b>개</p>\n' % len(rs))
        render_kept_rows(pg, rs, "브랜치 %d개 목록 펼치기" % len(rs))
        w('</div>\n')
    if not protected:
        w('<p class="muted">이 계획에는 해당 항목이 없습니다.</p>\n')
    w('</section>\n')

    # 5. 지울 브랜치 — 그룹별
    w('<section class="part" aria-labelledby="s-del">\n<h2 id="s-del">지울 브랜치 — 그룹별</h2>\n',
      '<p>원격 브랜치 <b>%d</b>개를 지웁니다. 승인은 그룹 단위로 받습니다.</p>\n' % len(deletes))
    if deletes:
        w('<p>그룹 제목 옆 <b>실행 그룹 키</b>는 그 그룹만 골라 지울 때 실행 명령(--only-group)에 넣는 값입니다.</p>\n')
    # 표시만 하는 이유: 승인자가 계획에서 뺄 행을 보도록 거부 대신 짚는다(검토 라운드 S3 설계, 테스트 19) —
    # apply는 이 계획을 "snapshot pr_head_repo is not this repo"로 거부한다.
    # (PR head oid ≠ 끝 커밋은 표시가 아니라 파싱 오류다 — check_row_values)
    odd = [(r, "PR의 브랜치가 다른 저장소(%s)" % vis(r["snapshot"].get("pr_head_repo", "")))
           for r in deletes if r["snapshot"].get("pr_head_repo", "").lower() != hdr["remote"].lower()]
    if odd:
        check_note(pg, "기록된 PR 정보가 브랜치와 맞지 않는 삭제 후보 %d개가 계획에 있습니다." % len(odd), odd)
    for g in glist:
        render_delete_group(pg, g, g is first and first_is_deploy, plan_groups)
    if not glist:
        w('<p class="muted">이 계획에는 지울 원격 브랜치가 없습니다.</p>\n')
    w('</section>\n')

    # 6. 닫을 PR·이슈
    w('<section class="part" aria-labelledby="s-close">\n<h2 id="s-close">닫을 PR·이슈</h2>\n',
      '<p>PR <b>%d</b>개, 이슈 <b>%d</b>개를 코멘트를 남기고 닫습니다. 승인은 한 건씩 받습니다.</p>\n'
      % (len(close_prs), len(close_issues)))
    for r in close_prs + close_issues:
        render_close_card(pg, r)
    if not closes:
        w('<p class="muted">이 계획에는 닫을 PR·이슈가 없습니다.</p>\n')
    w('</section>\n')

    # 6b. Jira 옮기기 — 프로젝트마다 검색 총수 대조 줄, 옮기기 행마다 카드(키 순)
    w('<section class="part" aria-labelledby="s-jira">\n<h2 id="s-jira">Jira 옮기기</h2>\n')
    if jira_moves:
        w('<p>Jira 티켓 <b>%d</b>건에 댓글을 남긴 뒤 상태를 옮깁니다. 배포가 확인된 티켓 <b>%d</b>건은 QA 단계로, '
          '중복이거나 다른 작업으로 대체된 티켓 <b>%d</b>건은 닫힘으로 옮깁니다. 승인은 한 건씩 받습니다.</p>\n'
          % (len(jira_moves), len(jira_qa), len(jira_closed)))
    if jira_qa:
        w('<p class="muted">배포 확인 = 바인딩의 deploy-proof 워크플로가 성공한 push 실행에 포함됨 — '
          '지금 그 환경이 그 코드라는 뜻은 아님</p>\n')
    for inv in inventory:
        render_inventory_line(pg, inv, rows)
    for r in jira_moves:
        render_jira_card(pg, r)
    if not inventory and not issue_moves:
        w('<p class="muted">이 계획에는 Jira 항목이 없습니다.</p>\n')
    elif not jira_moves:   # 검색 총수 행 없이 이슈 옮기기만 있는 계획도 여기(아래 "Jira로 옮기기" 칸이 따로 있다)
        w('<p class="muted">이 계획에는 옮길 Jira 티켓이 없습니다.</p>\n')
    w('</section>\n')

    # 6b'. Jira로 옮기기 — 남길 GitHub 이슈를 바인딩 Jira 프로젝트로(행이 있을 때만 칸이 생긴다), 이슈 번호 순
    if issue_moves:
        mv0 = issue_moves[0]["move"]   # 계획 하나 = Jira 바인딩 하나(chore_plan.check_plan_rows)
        n_adopt = sum(1 for r in issue_moves if r["move"]["adopt"] is not None)
        w('<section class="part" aria-labelledby="s-move">\n<h2 id="s-move">Jira로 옮기기</h2>\n',
          '<p>남기기로 판정한 GitHub 이슈 <b>%d</b>건을 Jira <code>%s</code>로 옮깁니다. 새 티켓 <b>%d</b>건을 만들고, '
          '이미 만든 티켓이 있는 <b>%d</b>건은 그 티켓으로 닫기만 합니다.</p>\n'
          % (len(issue_moves), vis("%s/%s" % (mv0["site"], mv0["project"])), len(issue_moves) - n_adopt, n_adopt),
          '<p>이슈마다 새 티켓을 만들거나 이미 만든 티켓을 쓰고, 이관 댓글(티켓 키와 링크)은 이슈에 아직 없을 때만 남긴 뒤 '
          '이슈를 닫습니다(닫는 이유: 계획 안 함). 아래 설명 미리보기는 승인 지문에 묶인 티켓 본문 파일 그대로입니다.</p>\n')
        for r in issue_moves:
            render_move_card(pg, r, payloads[r["move"]["number"]])
        w('</section>\n')

    # (스펙 밖) 실행될 로컬 정리 행 — 계획에 있으면 반드시 보인다
    if locals_:
        w('<section class="part" aria-labelledby="s-local">\n<h2 id="s-local">로컬 정리</h2>\n',
          '<p>이 컴퓨터의 로컬 저장소에서 실행되는 정리 <b>%d</b>건입니다.</p>\n' % len(locals_))
        names = (("delete-local", "병합이 확인된 로컬 브랜치 삭제"),
                 ("delete-local-force", "병합 PR로 확인된 로컬 브랜치 강제 삭제"),
                 ("worktree-prune", "작업 폴더 목록 정리"))
        for act, label in names:
            rs = [r for r in locals_ if r["action"] == act]
            if not rs:
                continue
            hid = pg.nid("l")
            w('<div class="group kept">\n<div class="ghead"><h3 id="%s">%s</h3></div>\n' % (hid, label),
              '<p class="gmeta"><b>%d</b>건</p>\n' % len(rs))
            render_kept_rows(pg, rs, "%d건 목록 펼치기" % len(rs))
            w('</div>\n')
        w('</section>\n')

    # 6c. 결정이 필요한 것 — 판정이 갈리지 않은 PR·이슈·Jira, 정할 사람별 (실행 없음)
    w('<section class="part" aria-labelledby="s-ambig">\n<h2 id="s-ambig">결정이 필요한 것</h2>\n')
    if ambiguous:
        kinds = Counter("jira" if r.get("jira") is not None else r["unit"]["kind"] for r in ambiguous)
        parts = ["%s <b>%d</b>%s" % (name, kinds[k], unit) for k, name, unit in
                 (("pr", "PR", "개"), ("issue", "이슈", "개"), ("jira", "Jira 티켓", "건")) if kinds[k]]
        w('<p>내용을 보고도 판단을 끝내지 못한 %s입니다. <b>이번 실행은 이 항목들에 아무것도 하지 않습니다.</b> '
          '정할 사람별로 묶었습니다.</p>\n' % ", ".join(parts))
        render_ambiguous(pg, ambiguous)
    else:
        w('<p class="muted">이 계획에는 결정이 필요한 항목이 없습니다.</p>\n')
    w('</section>\n')

    # 7. 이번에 남기는 것
    w('<section class="part" aria-labelledby="s-held">\n<h2 id="s-held">이번에 남기는 것</h2>\n',
      '<p>지우지도 닫지도 옮기지도 않는 항목입니다. 위 “절대 건드리지 않는 브랜치” %d개를 빼고 <b>%d</b>개를 이유별로 '
      '묶었습니다.</p>\n' % (len(protected), len(held)))
    if hdr["no_local"] == "1":
        w('<p>이번 계획은 원격만 정리합니다. 로컬 브랜치와 작업 폴더는 건드리지 않습니다.</p>\n')
    order = {code: i for i, (code, _) in enumerate(UNIT_LABELS + HOLD_LABELS)}
    labels = dict(UNIT_LABELS + HOLD_LABELS)
    hgroups = {}
    for r in held:
        hgroups.setdefault(held_code(r, labels), []).append(r)
    for code in sorted(hgroups, key=lambda c: order.get(c, len(order))):
        rs = hgroups[code]
        hid = pg.nid("h")
        w('<div class="group kept">\n<div class="ghead"><h3 id="%s">%s</h3></div>\n'
          % (hid, vis(labels.get(code, HOLD_OTHER))))
        if code == "unit-recent":
            dr = date_range([kst(r["snapshot"].get("updated", ""))[:10] for r in rs])   # 행과 같은 한국 날짜
            extra = " · 마지막 갱신 %s" % vis(dr) if dr != "알 수 없음" else ""
        else:
            dr = date_range([r["snapshot"].get("tip_date", "") for r in rs])
            extra = " · 마지막 커밋 %s" % vis(dr) if dr != "알 수 없음" else ""
        w('<p class="gmeta"><b>%d</b>개%s</p>\n' % (len(rs), extra))
        render_kept_rows(pg, rs, "%d개 목록 펼치기" % len(rs))
        w('</div>\n')
    if not held:
        w('<p class="muted">이 계획에는 해당 항목이 없습니다.</p>\n')
    w('</section>\n')

    # 8. 실행 순서와 되돌리기
    n_backup = len(deletes) + len([r for r in locals_ if r["action"] != "worktree-prune"])
    n_first = len(first["rows"]) if first else 0
    w('<section class="part" aria-labelledby="s-run">\n<h2 id="s-run">실행 순서와 되돌리기</h2>\n<ol class="steps">\n',
      '<li>이 계획 파일과 지문을 기록 저장소에 커밋합니다.</li>\n',
      '<li>지우기 전에 대상 브랜치 끝 커밋 <b>%d</b>개를 로컬 백업으로 보관합니다.</li>\n' % n_backup)
    fkey = '<code class="ref">%s</code>' % vis(next(iter(first["okeys"]))) if first else ""
    if not glist:
        w('<li>지울 원격 브랜치가 없어 이 단계는 건너뜁니다.</li>\n')
    elif not first:
        w('<li id="step1-skip">1단계 생략, 한 번에 실행 — 실행 그룹 키 하나로 고를 수 있는 그룹이 없습니다.</li>\n')
    elif first_is_deploy:
        w('<li>배포 승격용 브랜치 <b>%d</b>개를 먼저 삭제하고(실행 그룹 키 %s), 원격에서 사라졌는지와 보호 브랜치가 그대로인지 '
          '확인합니다.</li>\n' % (n_first, fkey))
    else:
        w('<li>실행 그룹 키 하나로 고를 수 있는 그룹 중 가장 큰 %s <b>%d</b>개를 먼저 삭제하고(실행 그룹 키 %s), '
          '원격에서 사라졌는지와 보호 브랜치가 그대로인지 확인합니다.</li>\n' % (vis(first["label"]), n_first, fkey))
    # 전체 실행 한 단계 = 엔진 apply 순서 그대로(닫기 → Jira → 원격 삭제 → 로컬). Jira는 --only-group 실행(1단계)에 없다.
    stages = ["PR <b>%d</b>개·이슈 <b>%d</b>개 닫기" % (len(close_prs), len(close_issues))]
    if jira_moves:
        stages.append("Jira 티켓 <b>%d</b>건 옮기기" % len(jira_moves))
    if issue_moves:   # 엔진 Jira 단계 안에서 Jira 옮기기 행들 다음(chore-jira.py apply)
        stages.append("GitHub 이슈 <b>%d</b>건 Jira로 옮기기" % len(issue_moves))
    stages.append("%s <b>%d</b>개 삭제" % ("브랜치" if glist and not first else "나머지 브랜치", len(deletes) - n_first))
    if locals_:
        stages.append("로컬 정리 <b>%d</b>건" % len(locals_))
    w('<li id="step-full">%s: %s. 끝나면 원격에서 사라졌는지와 보호 브랜치가 그대로인지 확인합니다.%s%s</li>\n'
      % ("1단계 없이 전체를 이 순서로 한 번에 실행합니다" if glist and not first else "나머지를 이 순서로 한 번에 실행합니다",
         " → ".join(stages),
         ' <span id="step-jira">Jira 티켓은 이 전체 실행에서만 옮기고%s, 티켓마다 댓글을 먼저 남긴 뒤 상태를 바꿉니다.</span>'
         % ("(그룹 하나만 골라 지우는 1단계 실행에서는 옮기지 않음)" if first else "") if jira_moves else "",
         ' <span id="step-move">GitHub 이슈는 이 전체 실행에서만 Jira로 옮기고%s, 새 티켓을 만들거나 이미 만든 티켓을 쓰고, '
         '필요할 때만 이관 댓글을 남긴 뒤 이슈를 닫습니다.</span>' % ("(1단계 실행에서는 옮기지 않음)" if first else "")
         if issue_moves else ""))
    w('</ol>\n',
      '<h3 id="s-undo" class="undo">되돌리기</h3>\n'
      '<p>지운 브랜치는 계획에 기록된 끝 커밋으로 다시 만들 수 있습니다. 예:</p>\n'
      '<p><code class="cmd">git push origin &lt;끝 커밋&gt;:refs/heads/&lt;브랜치&gt;</code></p>\n'
      '<p>닫은 PR·이슈는 다시 열 수 있습니다. 자동으로 되살리지는 않습니다(다시 만든 브랜치가 배포를 일으킬 수 있습니다).</p>\n')
    if jira_moves:
        w('<p>옮긴 Jira 티켓은 Jira에서 이전 상태로 다시 옮기고 남긴 댓글을 고칠 수 있습니다. 자동으로 되돌리지는 않습니다.</p>\n')
    if issue_moves:
        w('<p>Jira로 옮긴 이슈도 GitHub에서 다시 열 수 있습니다. 새로 만든 Jira 티켓과 이슈에 남긴 댓글은 자동으로 지우지 '
          '않습니다.</p>\n')
    w('</section>\n')

    # 9. 하단
    n_close = len(closes)
    w('<footer>\n<dl class="meta">\n',
      '<dt>계획 파일</dt><dd><code>%s</code></dd>\n' % vis(plan_name),
      '<dt>지문</dt><dd class="fp">%s</dd>\n' % digest,
      '<dt>실행 기록 번호</dt><dd><code>%s</code></dd>\n' % vis(hdr["run_id"]),
      '</dl>\n')
    n_jira_rows = sum(1 for r in rows if r.get("jira") is not None)
    if engine_sha != digest:
        if n_close or excluded or n_jira_rows or n_units or issue_moves:
            found = "이 페이지가 확인한 차이: 닫기 %d행 추가, %s%d행 제외 — 그 밖의 차이는 확인하지 않음" % (
                n_close, "".join(("Jira %d행 추가, " % n_jira_rows if n_jira_rows else "",
                                  "Jira로 옮길 이슈 %d행 추가, " % len(issue_moves) if issue_moves else "",
                                  "판정 기록이 붙은 PR·이슈 %d행, " % n_units if n_units else "")), excluded)
        else:
            found = "이 페이지가 확인한 차이는 없습니다 — 무엇이 바뀌었는지는 확인하지 못했습니다"
        w('<div class="note" id="drift">\n<p>엔진 출력 이후 검토 단계에서 계획 파일이 바뀌었습니다.</p>\n',
          '<dl class="meta">\n<dt>엔진 출력 지문</dt><dd class="fp">%s</dd>\n' % engine_sha,
          '<dt>이 계획 파일 지문</dt><dd class="fp">%s</dd>\n</dl>\n' % digest,
          '<p>%s</p>\n</div>\n' % found)
    w('</footer>\n</main>\n</body>\n</html>\n')
    if REVEALED:
        pg.buf[legend_at] = (
            '<p class="note" id="hid-legend"><span class="hidex">U+XXXX</span> 처럼 테두리 친 표기는 화면에 보이지 않는 문자를 '
            '드러낸 것입니다. 실제 이름과 게시되는 글에는 그 문자 자체가 들어 있고, 이 표기는 들어가지 않습니다. '
            '이 페이지에 나온 숨김 문자 <b id="hid-kinds">%d</b>종: %s</p>\n'
            % (len(REVEALED), ", ".join("U+%04X" % o for o in sorted(REVEALED))))
    return "".join(pg.buf)


SAFE_NAME = re.compile(r"[A-Za-z0-9._/#:+-]*")
ROW_KIND = {"delete-remote": "지울 원격 브랜치", "delete-local": "지울 로컬 브랜치", "delete-local-force": "지울 로컬 브랜치",
            "report": "남기는 브랜치"}


def name_check(pg, rows):
    """혼동 글자 방어: 영문·숫자·._/#:+- 밖의 글자가 든 브랜치 이름을 모두 짚는다(비슷하게 생긴 다른 글자 대비)."""
    odd = []
    for r in rows:
        a, ref = r["action"], r["ref"]
        if a in ("delete-remote", "delete-local", "delete-local-force"):
            name = ref
        elif a == "report" and ref.startswith(("remote:", "local:")):
            name = display_ref(ref)[0]
        else:
            continue
        if SAFE_NAME.fullmatch(name):
            continue
        chars = []
        for c in sorted(set(name) - set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/#:+-")):
            chars.append(vis(c) if is_hidden(c) else "%s (U+%04X)" % (vis(c), ord(c)))
        odd.append((r, "%s · 그 밖의 글자: %s" % (ROW_KIND[a], ", ".join(chars))))
    if odd:
        check_note(pg, "영문·숫자·._/#:+- 밖의 글자가 든 브랜치 이름 %d개가 있습니다. 비슷하게 생긴 다른 글자일 수 있습니다." % len(odd),
                   odd, note_id="name-check")
    else:
        pg.w('<p class="note muted" id="name-check">모든 브랜치 이름이 영문·숫자·._/#:+- 로만 되어 있음</p>\n')


def check_note(pg, text, items, note_id=""):
    """확인 필요 표시 + 해당 행 목록(펼침)."""
    pg.w('<div class="note"%s><p><span class="flag">확인 필요</span> %s</p>\n' % (' id="%s"' % note_id if note_id else "", vis(text)),
         '<details>\n<summary>%d개 보기</summary>\n<ul class="xlist">\n' % len(items))
    for r, why in items:
        pg.w('<li>%s <span class="muted">%s</span></li>\n' % (pg.ref_html(r["action"], r["ref"], it=False), why))
    pg.w('</ul>\n</details>\n</div>\n')


def render_delete_group(pg, g, is_step1, plan_groups):
    rs = sorted(g["rows"], key=lambda r: r["ref"])
    hid = pg.nid("g")
    w = pg.w
    badge = ' <span class="badge">실행 1단계 대상</span>' if is_step1 else ""
    prefixes = ('<span class="prefix mono ref">%s</span>' % vis(", ".join(sorted(g["prefixes"], key=lambda x: (x.lower(), x))))
                if g["prefixes"] else '<span class="prefix">접두사 없음</span>')
    # 실행 그룹 키 = apply --only-group 값(엔진 grp). 접두사 없는 브랜치는 이름 하나가 그룹 하나다.
    keys = sorted(g["okeys"], key=lambda x: (x.lower(), x))
    if g["key"] == "noprefix":
        gkey = '<span class="gkey">실행 그룹 키 = 브랜치마다 이름 그대로</span>'
    else:
        gkey = '<span class="gkey">실행 그룹 키 %s</span>' % ", ".join('<code class="ref">%s</code>' % vis(k) for k in keys)
    missing = [k for k in keys if k not in plan_groups]
    if missing:  # 머리 줄 groups=에 없는 키는 apply가 --only-group으로 받지 않는다
        gkey += ('<span class="gkey" id="gkey-missing-%s"><span class="flag">확인 필요</span> 이 계획의 그룹 목록에 없어 '
                 '그룹으로 골라 실행할 수 없는 키: %s</span>'
                 % (hid, ", ".join('<code class="ref">%s</code>' % vis(k) for k in missing)))
    w('<div class="group del">\n<div class="ghead"><h3 id="%s">%s%s</h3>%s%s</div>\n'
      % (hid, vis(g["label"]), badge, prefixes, gkey))
    authors = Counter(known(r["snapshot"].get("pr_author", "")) for r in rs)
    top = sorted(authors.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    top_s = " · ".join("%s %d" % (vis(a), c) for a, c in top)
    w('<p class="gmeta"><b>%d</b>개 · 마지막 커밋 %s · PR 작성자 상위 %s</p>\n'
      % (len(rs), vis(date_range([r["snapshot"].get("tip_date", "") for r in rs])), top_s))
    w('<details>\n<summary>브랜치 %d개 목록 펼치기</summary>\n' % len(rs),
      '<div class="row head" aria-hidden="true"><span>브랜치</span><span>병합 PR</span><span>PR 작성자</span>'
      '<span>마지막 커밋 작성자</span><span>마지막 커밋 날짜</span><span>병합 대상</span></div>\n'
      '<ul class="rows">\n')
    for r in rs:
        s = r["snapshot"]
        w('<li class="row">',
          cell("브랜치", pg.ref_html(r["action"], r["ref"])),
          cell("병합 PR", pg.pr_html(s.get("pr", ""))),
          cell("PR 작성자", vis(known(s.get("pr_author", "")))),
          cell("마지막 커밋 작성자", vis(known(s.get("tip_author", "")))),
          cell("마지막 커밋 날짜", vis(known(s.get("tip_date", "")))),
          cell("병합 대상", '<code class="ref">%s</code>' % vis(known(s.get("pr_base", "")))),
          '</li>\n')
    w('</ul>\n</details>\n</div>\n')


KEPT_FIELDS = (("tip_date", "마지막 커밋 날짜"), ("tip_author", "마지막 커밋 작성자"),
               ("pr", "같은 이름 PR"), ("pr_state", "PR 상태"), ("author", "작성자"),
               ("updated", "마지막 갱신"))


def reason_line(pg, r):
    """행마다 사람이 읽는 한 줄. 브랜치 행은 엔진 evidence(영어·플래그·코드)를 쓰지 않고 reason과 snapshot으로
    만든다. PR·이슈 행의 evidence는 제목(데이터)이라 그대로 보인다."""
    a, ref, s, reason = r["action"], r["ref"], r["snapshot"], r["reason"]
    ev = unit_ev(r)
    if ev is not None:  # 판정 기록이 붙은 행: 제목(PR·이슈 t, Jira 요약) — 판정 이유
        title = ev["t"] if r.get("unit") is not None else r["jira"]["summary"]
        head = vis(title) if title else '<span class="muted">(제목 기록 없음)</span>'
        tail = vis(ev["reason"])
        if ev["v"] in OPINION_WORD:
            tail = "%s. 판정 이유: %s" % (OPINION_WORD[ev["v"]], tail)
        return '%s<span class="muted"> — </span>%s' % (head, tail)
    if a == "report" and (PR_REF.fullmatch(ref) or ISSUE_REF.fullmatch(ref)):
        return vis(r["evidence"])
    if ref == "." and a in ("worktree-prune", "report"):
        return "이미 사라진 작업 폴더의 목록만 정리" if a == "worktree-prune" else "작업 폴더 목록 정리는 이번에 하지 않음"
    pr = (s.get("pr") or "").lstrip("#")
    prs = "PR #" + pr if re.fullmatch(r"[0-9]+", pr) else "병합 PR"
    base = ref_code(s["pr_base"]) if s.get("pr_base") else "통합 브랜치"
    if reason == "protected":
        label = r["source_label"]
        if label == "출처 기재 없음":
            return "보호 목록에 있음(출처 기재 없음)"
        return "%s 때문에 보호" % vis(label)
    if reason == "merged-pr":
        return "%s이 %s에 병합됨" % (vis(prs), base)
    if reason == "merge-not-in-base":
        return "%s은 병합됐지만 그 병합 커밋이 지금 %s 히스토리에 없음" % (vis(prs), base)
    if reason == "merge-commit-unknown":
        return "%s의 병합 커밋을 확인할 수 없음" % vis(prs)
    if reason == "same-as-integration-tip":
        names = pg.itip_names.get(r["expected"])
        return "%s 끝 커밋과 같음" % (", ".join(ref_code(n) for n in names) if names else "통합 브랜치")
    text = {"contained-hold": "통합 브랜치에 내용이 들어 있지만 정확히 맞는 병합 PR이 없음",
            "stale": "마지막 커밋 %s, 병합 근거 없음" % known(s.get("tip_date", "")),
            "checked-out": "작업 폴더에서 열려 있음",
            "local-held": "로컬 정리는 다른 작업 세션이 끝난 뒤 따로 실행"}.get(reason, "그 밖의 이유로 이번에는 남김")
    return vis(text)


def render_kept_rows(pg, rs, summary):
    w = pg.w
    w('<details>\n<summary>%s</summary>\n<ul class="rows">\n' % summary)
    for r in sorted(rs, key=lambda r: display_ref(r["ref"]) + (r["action"], r["ref"])):
        s = r["snapshot"]
        bits = []
        if r.get("sources") or r.get("sources_more"):
            bits.append('<span class="kv"><span class="muted">출처</span>%s</span>' % source_details(pg, r))
        for key, label in KEPT_FIELDS:
            if key not in s:
                continue
            v = s[key]
            if key == "pr":
                val = pg.pr_html(v)
            elif key == "pr_state":
                val = vis(PR_STATE.get(v, v))
            elif key == "updated":
                val = vis(kst(v))
            else:
                val = vis(known(v))
            bits.append('<span class="kv"><span class="muted">%s</span>%s</span>' % (label, val))
        ev = unit_ev(r)
        if ev is not None:
            j = r.get("jira")
            if j is not None and j["status_name"]:
                bits.append('<span class="kv"><span class="muted">현재 상태</span>%s</span>' % vis(j["status_name"]))
            if ev["jira"]:
                bits.append('<span class="kv"><span class="muted">연결된 Jira</span>%s</span>' % jira_list_html(pg, ev["jira"]))
            if ev["complete"] == "no":
                bits.append('<span class="kv"><span class="muted">증거</span>일부 누락</span>')
        w('<li class="row">',
          cell("항목", pg.ref_html(r["action"], r["ref"]), label_class="sr"),
          cell("근거", reason_line(pg, r), label_class="sr"),
          cell("기록", "".join(bits) or '<span class="muted">추가 기록 없음</span>', label_class="sr"),
          '</li>\n')
    w('</ul>\n</details>\n')


def source_details(pg, r):
    out = []
    for kind, det in r.get("sources", []):
        if kind in ("pr-head", "pr-base") and re.fullmatch(r"[0-9]+", det):
            out.append(pg.link("pull", det, "PR #" + det) + (" 브랜치" if kind == "pr-head" else " 대상"))
        else:
            out.append(vis(SOURCE_DETAIL.get(kind, "%s") % det))
    if r.get("sources_more"):
        out.append("외 %d개 출처" % r["sources_more"])
    return ", ".join(out)


def render_close_card(pg, r):
    w = pg.w
    s = r["snapshot"]
    title_link = pg.ref_html(r["action"], r["ref"])
    hid = pg.nid("c")
    w('<article class="card" aria-labelledby="%s">\n' % hid,
      '<h3 id="%s">%s %s</h3>\n' % (hid, title_link, vis(r["title"] or "(제목 없음)")),
      '<p class="say">이 코멘트를 남기고 닫습니다</p>\n',
      '<p class="who">작성자 %s · 마지막 갱신 %s</p>\n'
      % (vis(known(s.get("author", ""))), vis(kst(s.get("updated", "")))),
      '<div class="comment">%s</div>\n</article>\n' % vis(r["evidence"]))


# ───────────────────────── v4: Jira 옮기기 · 결정 필요 · 판정 보존 ─────────────────────────

def held_code(r, labels):
    """이번에 남기는 것 묶음 코드. 판정 기록이 붙은 행은 판정으로(엔진 reason은 PR·이슈 행이면 늘 열린 PR·이슈라
    쓰지 않는다), 브랜치·날것 PR·이슈 행은 지금처럼 엔진 reason으로."""
    v = verdict(r)
    if v is not None:
        if r.get("unit") is not None:
            return "unit-recent" if v == "NOT-JUDGED" else "unit-keep"
        return "jira-excluded" if v in ("EXCLUDED", "NOT-JUDGED") else "jira-keep"
    # "." 행은 브랜치가 아니라 작업 폴더 목록 — 엔진이 local-held로 보내도 작업 폴더 묶음에 둔다
    return "worktree-prune" if r["ref"] == "." else r["reason"] if r["reason"] in labels else "?"


def jira_kst(x):
    """Jira updated(2026-10-19T06:07:25.160+0900) → 한국 시각 분 단위. 형식은 chore_plan이 이미 확인했다."""
    t = jira_time(x)
    return t.astimezone(KST).strftime("%Y-%m-%d %H:%M KST") if t else known(x)


def item_html(pg, it, role=False):
    """옮기기 행 items 요소 하나 → 사람 말. 커밋은 앞 12자리만 (전체 해시는 페이지에 찍지 않는다)."""
    if it["kind"] == "pr":
        out = "%s %s" % (pg.link("pull", str(it["pr"]), "PR #%d" % it["pr"]), PR_STATE[it["state"]])
        if it["sha"]:
            out += " · 병합 커밋 <code>%s</code>" % it["sha"][:12]
    else:
        out = "커밋 <code>%s</code>" % it["sha"][:12]
    if role:
        out += ' · <span class="muted">%s</span>' % ROLE_WORD[it["role"]]
    return out


def item_short(pg, it):
    """요구사항 줄의 대상 = 항목 이름만 (상태·병합 커밋은 위 "필요한 변경" 목록에 있다)."""
    return pg.link("pull", str(it["pr"]), "PR #%d" % it["pr"]) if it["kind"] == "pr" else "커밋 <code>%s</code>" % it["sha"][:12]


def item_list(pg, items, role):
    return '<ul class="xlist">%s</ul>' % "".join("<li>%s</li>" % item_html(pg, it, role) for it in items)


def basis_html(pg, b, site):
    """닫는 근거(close_basis) → 사람 말 + 링크. 티켓 링크는 그 행의 사이트(Jira 키는 사이트 안에서만 뜻이 있다)."""
    if b["pr"] is not None:
        return "다른 작업으로 대체됨 — 대신한 PR: %s" % pg.link("pull", str(b["pr"]), "PR #%d" % b["pr"])
    if b["type"] == "duplicate":
        return "중복 — 같은 작업을 하는 티켓: %s" % pg.jira_link(b["key"], site=site)
    return "다른 작업으로 대체됨 — 대신한 티켓: %s" % pg.jira_link(b["key"], site=site)


def jira_list_html(pg, links):
    return ", ".join("%s (%s)" % (pg.jira_link(x["key"]), vis(x["status"])) for x in links)


def cite_html(pg, c):
    """판정 근거 하나 → 사람 말. 판정 파일 표기(pr:N[:merged], issue:N, jira:KEY, c:<sha>, path:<p>[:absent])와
    사람이 쓴 표기(PR #N, issue#N, KEY)를 읽고, 모르는 모양은 글자 그대로."""
    m = re.fullmatch(r"(?:pr[:#]|PR #)([1-9][0-9]*)(:merged)?", c)
    if m:
        return pg.link("pull", m.group(1), "PR #" + m.group(1)) + (" (병합됨)" if m.group(2) else "")
    m = re.fullmatch(r"(?:issue[:#]|이슈 #)([1-9][0-9]*)", c)
    if m:
        return pg.link("issues", m.group(1), "이슈 #" + m.group(1))
    m = re.fullmatch(r"(?:jira:)?([A-Z][A-Z0-9]+-[0-9]+)", c)
    if m:
        return pg.jira_link(m.group(1))
    m = re.fullmatch(r"c:([0-9a-f]{7,40})", c)
    if m:
        return "커밋 <code>%s</code>" % m.group(1)[:12]
    if c.startswith("path:"):
        p = c[len("path:"):]
        if p.endswith(":absent"):
            return '<code class="ref">%s</code> 파일이 기본 브랜치에 없음' % vis(p[:-len(":absent")])
        return '<code class="ref">%s</code> 파일' % vis(p)
    return vis(c)


def cites_html(pg, text):
    return ", ".join(cite_html(pg, c.strip()) for c in text.split(",") if c.strip())


def render_inventory_line(pg, inv, rows):
    """프로젝트 하나의 검색 총수 대조: 총수(검색 결과) = 옮김 + 남김/결정 필요 + 제외(행 수). 같다는 건 계획 문법이
    이미 보장하지만, 화면은 칸마다 판정 값을 이름으로 골라 따로 세고(INV_KEPT·INV_EXCLUDED) 합이 총수와 다르면 오류로
    멈춘다 — 목록에 없는 판정 값이 오면 어느 칸에도 안 들어가 합이 어긋난다."""
    j = inv["jira"]
    p = j["project"]
    mine = [r for r in rows if r.get("jira") is not None and r["jira"]["kind"] != "inventory" and r["jira"]["project"] == p]
    moved = sum(1 for r in mine if r["jira"]["kind"] == "transition")
    units = [r["jira"]["evidence"]["v"] for r in mine if r["jira"]["kind"] == "unit"]
    excl = sum(1 for v in units if v in INV_EXCLUDED)
    rest = sum(1 for v in units if v in INV_KEPT)
    if moved + rest + excl != j["total"]:
        raise PlanError("line %d: inventory total %d for jira#%s but the page counts %d rows"
                        % (inv["line"], j["total"], p, moved + rest + excl))
    pg.w('<p class="inv" id="inv-%s">Jira 프로젝트 <span class="it">%s</span> — 담당 Jira 미완료 <b id="inv-total-%s">%d</b>건 '
         '= 옮김 <b id="inv-moved-%s">%d</b> + 남김/결정 필요 <b id="inv-kept-%s">%d</b> + 제외 <b id="inv-excluded-%s">%d</b></p>\n'
         % (p, vis(p), p, j["total"], p, moved, p, rest, p, excl),
         '<p class="gmeta">검색 조건 <code>%s</code> · 사이트 <code>%s</code></p>\n' % (vis(j["jql"]), vis(j["site"])))


def render_jira_card(pg, r):
    s, j = r["snapshot"], r["jira"]
    hid = "jt-" + j["key"]
    w = pg.w
    w('<article class="card" aria-labelledby="%s">\n' % hid,
      '<h3 id="%s">%s %s</h3>\n' % (hid, pg.ref_html(r["action"], r["ref"]), vis(s["summary"] or "(제목 없음)")),
      '<p class="say">현재 상태 %s → %s <span class="flag">%s</span></p>\n'
      % (vis(s["status_name"]), vis(s["to_name"]), LEVEL_WORD[j["level"]]),
      '<p class="who">Jira 마지막 갱신 %s</p>\n<dl class="meta">\n' % vis(jira_kst(r["expected"])))
    items = j["items"]
    if j["level"] == "TO-QA":
        by_id = {it["id"]: it for it in items}
        other = [it for it in items if it["role"] != "required"]
        w('<dt>필요한 변경</dt><dd>%s</dd>\n' % item_list(pg, [it for it in items if it["role"] == "required"], False))
        if other:
            w('<dt>관련 있지만 필요하지 않음</dt><dd>%s</dd>\n' % item_list(pg, other, True))
        w('<dt>배포</dt><dd><a href="%s">배포 실행 #%s</a> · 배포 기준 커밋 <code>%s</code></dd>\n'
          % (html.escape(s["run_url"], quote=True), vis(s["run"]), s["S"][:12]),
          '<dt>요구사항</dt><dd><ul class="xlist">%s</ul></dd>\n'
          % "".join('<li>%s <span class="muted">→</span> %s</li>' % (vis(rq["text"]), item_short(pg, by_id[rq["target"]]))
                    for rq in j["reqs"]))
    else:
        w('<dt>닫는 근거</dt><dd>%s</dd>\n' % basis_html(pg, j["close_basis"], s["site"]))
        if items:
            w('<dt>관련 변경</dt><dd>%s</dd>\n' % item_list(pg, items, True))
    w('</dl>\n<p class="say">이 댓글을 남기고 옮깁니다</p>\n',
      '<div class="comment">%s</div>\n</article>\n' % vis(r["evidence"]))


KEY_SLOT = '<span class="flag">[새 티켓 키]</span>'   # 새 티켓 행 댓글의 {KEY} 자리(만들어야 정해지는 키) — 글자 그대로의
                                                     # "[새 티켓 키]"(이스케이프 평문)와 구별되는 테두리 표지


PV_P = '<p style="white-space:pre-wrap">'   # 미리보기 문단: 공백·탭을 접지 않는다(스타일시트는 그대로 — 옮기기 행이 없는
                                            # 페이지의 바이트가 바뀌지 않게 이 자리에만 인라인)


def preview_html(blocks):
    """설명 블록 열(parse_blocks 결과) → HTML, 글은 parse_blocks가 준 그대로: heading → 굵은 줄, paragraph → 문단
    (줄바꿈 = <br>, 공백 그대로), codeBlock → <pre>(공백·줄바꿈 그대로 — 브라우저는 <pre> 바로 뒤 개행 하나를 버리므로
    언제나 개행 하나를 먼저 쓴다: 글이 빈 줄로 시작해도 그 줄이 보인다)."""
    out = []
    for kind, text in blocks:
        if kind == "heading":
            out.append('%s<b>%s</b></p>\n' % (PV_P, vis(text).replace("\n", "<br>")))
        elif kind == "paragraph":
            out.append('%s%s</p>\n' % (PV_P, vis(text).replace("\n", "<br>")))
        else:
            out.append('<pre class="comment">\n%s</pre>\n' % vis(text))
    return "".join(out)


def render_move_card(pg, r, pl):
    """move-issue 행 하나 = 카드: 이슈 링크 + 제목(잘렸으면 잘림 표지), 새 티켓의 사이트/프로젝트·유형(adopt면 이미 만든 티켓으로
    닫기만), 남기는 이유, 관련 티켓, GitHub에 남길 댓글(새 티켓 = {KEY} 자리 표지, adopt = comment_body(gh, KEY) — 게시 본문
    그대로; prior가 있으면 그 댓글을 그대로 둔다는 줄 + 그 댓글 링크, 틀 문구는 접힌 칸에만), 설명 미리보기(pl = load_payloads가
    검사한 그 행의 파일), 새 티켓의 담당자·보고자·상태 한 줄(담당자·보고자는 load_payloads가 그 파일 바이트와 대조했다)."""
    s, mv = r["snapshot"], r["move"]
    site, adopt = mv["site"], mv["adopt"]
    hid = "mv-%d" % mv["number"]
    w = pg.w
    w('<article class="card" aria-labelledby="%s">\n' % hid,
      '<h3 id="%s">%s %s%s</h3>\n' % (hid, pg.ref_html(r["action"], r["ref"]), vis(r["title"]),
                                      ' <span class="flag">잘림</span>' if pl["trunc"] else ""))
    if adopt is None:
        w('<p class="say">새 티켓 <code>%s</code> · 유형 %s</p>\n'
          % (vis("%s/%s" % (site, mv["project"])), vis(mv["issuetype_name"])))
    else:
        w('<p class="say">이미 만든 티켓 %s로 닫기만 (새 티켓 없음)</p>\n' % pg.jira_link(adopt, site=site))
    w('<p class="who">작성자 %s · 마지막 갱신 %s</p>\n' % (vis(known(s.get("author", ""))), vis(kst(s.get("updated", "")))),
      '<dl class="meta">\n<dt>남기는 이유</dt><dd>%s</dd>\n' % vis(mv["reason"]),
      '<dt>관련 티켓</dt><dd>%s</dd>\n</dl>\n'
      % (", ".join(pg.jira_link(k, site=site) for k in mv["related"]) if mv["related"] else "없음"))
    comment = (KEY_SLOT.join(vis(part) for part in mv["gh"].split("{KEY}")) if adopt is None
               else vis(comment_body(mv["gh"], adopt)))
    if mv["prior"] is None:
        w('<p class="say">GitHub 이슈에 남길 댓글</p>\n<div class="comment">%s</div>\n' % comment)
    else:
        # 승인 때 이미 있던 이관 댓글(prior)은 그대로 두고 새로 달지 않는다 — 그 댓글의 글은 계획에 없다(cid와 본문 sha뿐).
        # 지금 틀로 다시 만든 문구를 그 댓글처럼 보이면 안 되니 실제 댓글로 링크하고, 틀 문구는 접힌 칸에만 둔다
        cid = mv["prior"]["cid"]
        if not re.fullmatch(r"[0-9]+", cid):
            raise PlanError("line %d: %s prior comment id %r is not a number" % (r["line"], r["ref"], cid))
        w('<p class="say">이슈에 이미 있는 이관 댓글을 그대로 둠 — 새 댓글 없음 (%s)</p>\n'
          % pg.link("issues", "%d#issuecomment-%s" % (mv["number"], cid), "댓글 %s 보기" % cid),
          '<details class="prior-alt">\n<summary>기존 댓글을 지운 것으로 기록한 뒤 다시 실행할 때만 남길 문구</summary>\n'
          '<div class="comment">%s</div>\n</details>\n' % comment)
    w('<details class="pv">\n<summary>Jira 티켓 설명 미리보기</summary>\n')
    if adopt is not None:
        w('<p class="muted">새 티켓은 만들지 않음 — 닫기 전에 이미 만든 티켓 %s의 내용을 이 승인본과 대조합니다</p>\n' % vis(adopt))
    w('%s<span class="muted">요약</span> %s</p>\n' % (PV_P, vis(pl["summary"])), preview_html(pl["blocks"]), '</details>\n')
    if adopt is None:
        w('<p class="muted">담당자 없음 · 보고자 = 실행 계정 · 첫 상태</p>\n')
    w('</article>\n')


def owner_order(owner):
    return OWNER_ORDER.get("author" if owner.startswith("author:") else owner, len(OWNER_ORDER)), owner


def amb_order(r):
    if r.get("jira") is not None:
        return (2,) + key_order(r["jira"]["key"])
    return (0 if r["unit"]["kind"] == "pr" else 1, "", r["unit"]["number"])


def render_ambiguous(pg, rs):
    groups = {}
    for r in rs:
        groups.setdefault(unit_ev(r)["owner"], []).append(r)
    for owner in sorted(groups, key=owner_order):
        grp = groups[owner]
        label = ("작성자 %s에게 물어볼 것" % vis(owner[len("author:"):]) if owner.startswith("author:")
                 else vis(OWNER_LABELS.get(owner, owner)))
        hid = pg.nid("o")
        pg.w('<div class="group">\n<div class="ghead"><h3 id="%s">%s</h3></div>\n' % (hid, label),
             '<p class="gmeta"><b>%d</b>건</p>\n' % len(grp))
        for r in sorted(grp, key=amb_order):
            render_ambiguous_card(pg, r)
        pg.w('</div>\n')


def render_ambiguous_card(pg, r):
    ev = unit_ev(r)
    if r.get("jira") is not None:
        j = r["jira"]
        hid, title = "amb-" + j["key"], j["summary"]
        who = "현재 상태 %s" % vis(j["status_name"]) if j["status_name"] else ""
    else:
        u, s = r["unit"], r["snapshot"]
        hid, title = "amb-%s-%d" % (u["kind"], u["number"]), ev["t"]
        who = "작성자 %s · 마지막 갱신 %s" % (vis(known(s.get("author", ""))), vis(kst(s.get("updated", ""))))
    w = pg.w
    w('<article class="card" aria-labelledby="%s">\n' % hid,
      '<h4 id="%s">%s %s</h4>\n' % (hid, pg.ref_html(r["action"], r["ref"]),
                                     vis(title) if title else '<span class="muted">(제목 기록 없음)</span>'),
      '<p class="say">%s</p>\n' % vis(ev["reason"]))
    if who:
        w('<p class="who">%s</p>\n' % who)
    w('<dl class="meta">\n')
    for label, k in (("확인된 것", "known"), ("확인 안 된 것", "missing"), ("정할 사람", "decider"), ("추천", "recommend")):
        w('<dt>%s</dt><dd>%s</dd>\n' % (label, vis(ev[k])))
    if ev["cites"]:
        w('<dt>근거</dt><dd>%s</dd>\n' % cites_html(pg, ev["cites"]))
    if ev["jira"]:
        w('<dt>연결된 Jira</dt><dd>%s</dd>\n' % jira_list_html(pg, ev["jira"]))
    if ev["complete"] == "no":
        w('<dt>증거</dt><dd><span class="flag">일부 누락</span> 증거를 다 모으지 못한 채 판정함</dd>\n')
    w('</dl>\n</article>\n')


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="chore-render.py",
        description="chore 정리 계획(TSV v3 + 엔진 JSON)을 승인용 HTML 한 장으로 렌더한다.")
    ap.add_argument("--plan", required=True, help="계획 TSV (권위 원본; 페이지 지문 = 이 파일의 sha256)")
    ap.add_argument("--json", required=True, help="chore.sh report --json 출력 (분류 코드 출처)")
    ap.add_argument("--out", required=True, help="쓸 HTML 경로")
    ap.add_argument("--repo-url", default="",
                    help="PR·이슈 링크용 저장소 URL — https://github.com/<owner>/<repo> 만 (예: https://github.com/o/r)")
    ap.add_argument("--payloads", default=None, metavar="DIR",
                    help="move-issue 행의 새 티켓 본문 폴더(chore-judge.py build --payloads) — 계획에 move-issue 행이 있으면 "
                         "필수, 없으면 빼거나 빈 폴더")
    a = ap.parse_args(argv)
    try:
        # 링크 호스트는 github.com 하나: https, 사용자 정보·포트·질의·조각 없이 정확히 owner/repo 두 경로
        repo_url = a.repo_url.rstrip("/")
        m = re.fullmatch(r"https://github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)", repo_url)
        if repo_url and (not m or m.group(2) in (".", "..") or m.group(2).lower().endswith(".git")):
            raise PlanError("--repo-url must be https://github.com/<owner>/<repo> (host github.com, no .git)")
        try:
            with open(a.plan, "rb") as fh:
                data = fh.read()
        except OSError as e:
            raise PlanError("cannot read plan: %s" % e)
        digest = hashlib.sha256(data).hexdigest()
        hdr, rows = parse_plan(data)
        if repo_url and repo_slug(repo_url).lower() != hdr["remote"].lower():
            raise PlanError("--repo-url %s is not the plan's repository %s" % (repo_url, hdr["remote"]))
        payloads = load_payloads(a.payloads, rows)
        engine_sha, jidx = load_engine_json(a.json, hdr)
        excluded = join_rows(rows, jidx)  # 계획에서 뺀 엔진 행들
        page = render(hdr, rows, os.path.basename(a.plan), digest, engine_sha, excluded, repo_url, payloads)
        out_dir = os.path.dirname(os.path.abspath(a.out))
        fd, tmp = tempfile.mkstemp(prefix=".chore-render.", suffix=".html", dir=out_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(page)
            os.chmod(tmp, 0o644)
            os.replace(tmp, a.out)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
    except PlanError as e:
        print("chore-render: error: %s" % e, file=sys.stderr)
        return 1
    except OSError as e:
        print("chore-render: error: %s" % e, file=sys.stderr)
        return 1
    print("chore-render: wrote %s (sha256 %s, %d rows)" % (a.out, digest, len(rows)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
