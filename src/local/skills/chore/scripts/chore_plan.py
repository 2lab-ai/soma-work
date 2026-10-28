#!/usr/bin/env python3
"""chore_plan.py — chore 정리 계획 TSV(#chore-plan v3 + v4 Jira 행 + v4.3 move-issue 행)의 문법 한 벌 (2026-10-19,
chore-render.py에서 옮김; move-issue 2026-10-21).

판정(chore-judge.py)·렌더(chore-render.py)·보고(chore-report.py)·Jira 헬퍼(chore-jira.py)가 이 모듈 하나로 계획을 읽고
쓴다. 엔진(chore.sh P_PARSE awk)은 계약 fixture(__tests__/fixtures/chore-v4/)를 이 모듈과 똑같이 받고 거절해야 한다
(__tests__/py/chore-contract.test.py). python3 -I로 도는 스크립트는 같은 폴더 모듈을 import할 수 없으니 경로로 읽는다:

    spec = importlib.util.spec_from_file_location("chore_plan", Path(__file__).resolve().parent / "chore_plan.py")
    plan = importlib.util.module_from_spec(spec); spec.loader.exec_module(plan)

인코딩 층 (penc/pdec, 모든 층 sp=False — 머리 줄 값만 sp=True):
- 1층 = 행 칸과 snapshot 쌍 값. 구조(탭 · ; · 첫 =)를 바이트로 나눈 뒤 값마다 정확히 한 번.
- 2층 = 1층을 푼 문자열 안의 구조: items(, 와 : — 값이 전부 ASCII 토큰이라 더 인코딩하지 않음), reqs 요소의 요구사항 글
  (penc(글) + "=>" + 항목 id; 첫 "=>"에서 나눔), ledgers 요소(penc(경로), 쉼표로 이음), tier-3 jira 증거 값과 inventory
  증거 값(값마다 penc).
- 3층 = 증거 jira= 목록 요소의 상태 이름(KEY:penc(상태)) — 상태 이름의 , : 가 목록 구조를 깨지 않게.

검사 순서 (한 곳만 바꾼 fixture가 어느 문구로 거절되는지 고정 — 앞의 검사가 이긴다):
- parse_plan 행마다: 열 수 → tier → action → ref 디코딩 → (action, ref) 중복 → tier 허용표 → check_ref → snapshot 쌍
  → snapshot 끝 선택 키(title | verdict: 맨 끝인가 → 값) → snapshot 키 집합 → expected → check_row_values → check_move_issue
  → jira_row → unit_row (게시 댓글 제어 문자 검사는 check_row_values 바로 뒤). 끝에 check_plan_rows(한 대상 한 상태 —
  남김 쌍, 같은 이슈의 close-issue·move-issue → no_local → move-issue 행마다: 계획 날짜 하나(gh 표지 날짜가 모두 같음)
  → adopt KEY가 그 행 related에 없음 → adopt KEY는 한 행에만 → duplicate가 TO-CLOSED 행을 가리키나 → issue_id 중복
  → Jira site·project 하나(Jira 행 + move-issue 행) → inventory).
- tier-2 move-issue issue#N(GitHub 이슈를 바인딩 Jira 프로젝트의 새 티켓으로 옮기고 이슈를 닫음, row["move"] — "jira" 키가
  아니라 inventory 총수에 들지 않는다): check_move_issue = expected(ISO) → state OPEN → updated == expected → title·account
  ·gh_login·issuetype_name 비지 않음(author는 비어도 됨) → site → project → project_id·issuetype → source_sha·payload_sha
  → adopt → prior(adopt 필요) → 증거(decode_move_evidence: 키 → reason → gh → related). 생성 함수(move_comment,
  source_json, move_payload)와 읽기 함수(parse_blocks, points_at, ours_shape, migration_comment)가 이 모듈에 함께 있다 —
  build·apply·verify가 같은 바이트를 만들고 같은 술어를 쓴다. canon_json = payload 바이트의 인코더 하나(키 정렬·구분자
  고정·UTF-8 날것) — 읽는 쪽은 파일을 json.loads 한 뒤 canon_json으로 다시 인코딩해 같은 바이트인지로 정규형임을 증명한다.
  payload_bytes(project_id, issuetype_id, summary, account, doc) = POST 본문 필드 집합의 유일한 정의(move_payload도 이것으로
  만든다), doc_from_blocks(blocks) = parse_blocks(엄격)의 역(move_description도 이것으로 doc를 만든다) — 저장된 티켓에서
  payload를 다시 만드는 쪽은 payload_bytes(…, doc_from_blocks(parse_blocks(설명)))만 쓰고 필드·노드 모양을 베끼지 않는다.
- check_jira_transition: 댓글 비었나 → expected(Jira updated 형식·달력) → site → project == KEY 접두 → issue_id → status
  → to → to_status → status ≠ to_status → account 비었나 → assignee == account → level → items 형식
  → ledgers 형식(빈 요소 → 인코딩 → / 로 시작 → 제어 문자 → 중복) → TO-QA(S → run → run_url https → run_url == https://github.com/<remote>/actions/runs/<run> → items 비었나
  → reqs 비었나 → close_basis → reqs 형식 → reqs 대상)
  | TO-CLOSED(close_basis 형식 → 자기 자신이 아닌가 → duplicate면 같은 프로젝트 → S·run·run_url → reqs)
  → required 항목은 전부 commit 또는 MERGED PR → 댓글 마지막 줄 표지.
- tier-3 jira#<KEY>: expected = - → snapshot = - 또는 summary=…;status_name=…(이 순서, 둘 다 비지 않음) → 증거.
  tier-3 jira#<PROJECT>(inventory): expected = - → snapshot = - → 증거.
- 바인딩(repos.md jira=<site>/<PROJECT> jira-qa= jira-closed=)은 계획에 없어서 parse_plan이 보지 않는다 —
  바인딩을 아는 호출자가 check_jira_binding을 부른다.
- tier-3 pr#N / issue#N 행의 증거 = 날것 제목(지금까지), 또는 snapshot 맨 끝에 verdict=<KEEP|AMBIGUOUS|NOT-JUDGED>가
  있을 때만 구조형 t=…;v=…(decode_unit_evidence, v == verdict). 판단은 snapshot 키로만 — 제목 내용으로는 절대 안 한다.
- close-pr / close-issue snapshot 맨 끝에 선택 키 title=<제목>(비면 안 됨) → row["title"](없으면 None).
- 표지: 계획의 우리 댓글은 마지막 줄이 정확히 MARKER(strip 없음). Jira에 이미 있는 댓글에서 chore 표지를 찾는 쪽(collect,
  Jira 쓰기 헬퍼)은 has_chore_marker 하나 — 어느 줄이든 앞뒤 공백을 뗀 줄 전체가 MARKER.

CLI (엔진 chore.sh가 Jira 행·구조형 증거의 권위 파서로 부른다):

    python3 -I scripts/chore_plan.py check <plan.tsv> [--site S --project P [--qa ID] [--closed ID]]

parse_plan(+ --site/--project가 있으면 check_jira_binding) → 통과 = 출력 없이 exit 0, PlanError·읽기 실패 = stderr
한 줄 "chore_plan: <message>" + exit 1, 사용법 오류 = exit 2.
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone

HEADER_TAG = b"#chore-plan v3"
HEADER_KEYS = ("remote", "origin", "repo_id", "default", "created", "run_id", "I", "Itips",
               "P", "protect", "integrate", "no_local", "Ptips", "groups")
LIST_KEYS = {"I", "P", "protect", "integrate", "groups"}
TIP_KEYS = {"Itips", "Ptips"}
JIRA_ACTION = "jira-transition"
MOVE_ACTION = "move-issue"    # v4.3: GitHub 이슈 → 바인딩 Jira 프로젝트의 새 티켓(chore-jira.py가 쓴다)
ACTIONS = {"delete-remote", "delete-local", "delete-local-force", "worktree-prune",
           "close-pr", "close-issue", JIRA_ACTION, MOVE_ACTION, "report"}
PR_REF = re.compile(r"pr#([1-9][0-9]*)")
ISSUE_REF = re.compile(r"issue#([1-9][0-9]*)")
JIRA_KEY_REF = re.compile(r"jira#([A-Z][A-Z0-9]+)-([1-9][0-9]*)")   # 실행 행·판정 보존 행 = 티켓 하나
JIRA_PROJECT_REF = re.compile(r"jira#([A-Z][A-Z0-9]+)")        # tier-3 inventory 행 = 프로젝트 하나
CLOSE_ACTIONS = {"close-pr": PR_REF, "close-issue": ISSUE_REF}
LOCAL_ACTIONS = ("delete-local", "delete-local-force", "worktree-prune")
# (tier, action) 허용표 = 엔진 apply의 허용표(chore.sh P_PARSE ok[])와 같다
ALLOWED = {1: {"delete-local", "delete-local-force", "worktree-prune"},
           2: {"delete-local", "delete-local-force", "worktree-prune", "delete-remote", "close-pr", "close-issue",
               JIRA_ACTION, MOVE_ACTION},
           3: {"report"}}
# action별 snapshot 키 = 엔진 apply의 req[](정확히 이 집합). report 행은 엔진이 tier3에 쓰는 키의 합집합 안에서만.
SNAP_EXACT = {
    "delete-remote": {"basis", "pr", "pr_base", "pr_head_repo", "pr_head_oid", "pr_merge_commit", "pr_author",
                      "tip_author", "tip_date"},
    "delete-local": {"basis", "pr", "pr_base", "pr_head_repo", "pr_head_oid", "pr_merge_commit", "tip_author", "tip_date"},
    "close-pr": {"state", "updated", "head_repo", "head_ref", "head_oid", "base", "author"},
    "close-issue": {"state", "updated", "author"},
    "worktree-prune": set(),
}
SNAP_EXACT["delete-local-force"] = SNAP_EXACT["delete-local"]
# jira-transition snapshot 키 (이 순서 = 판정 build가 쓰는 순서; 검사는 집합). ledgers = collect가 읽은 제외 원장(다른
# 세션이 맡은 Jira 티켓 목록) 파일의 절대 경로 목록(- = 원장 없음) — 쓰기 직전 recheck가 같은 파일을 다시 읽는다
JIRA_SNAP_KEYS = ("site", "project", "issue_id", "status", "status_name", "assignee", "account", "to", "to_status",
                  "to_name", "summary", "level", "S", "run", "run_url", "items", "reqs", "close_basis", "ledgers")
SNAP_EXACT[JIRA_ACTION] = set(JIRA_SNAP_KEYS)
# move-issue snapshot 키 (이 순서 = 판정 build가 쓰는 순서; 검사는 집합, design v9 §2). source_sha = 자르기 전 원문 전체의
# 정규 JSON(source_json) sha256, payload_sha = 새 티켓 POST 본문 바이트(move_payload) sha256, adopt = - | 이미 만든 KEY,
# prior = - | <cid>:<csha>(승인 때 그 KEY의 유효 이관 댓글)
MOVE_SNAP_KEYS = ("state", "updated", "author", "title", "site", "project", "project_id", "issuetype", "issuetype_name",
                  "account", "gh_login", "source_sha", "payload_sha", "adopt", "prior")
SNAP_EXACT[MOVE_ACTION] = set(MOVE_SNAP_KEYS)
SNAP_REPORT = {"tip_author", "tip_date", "pr", "pr_state", "pr_author", "pr_base", "pr_merge_commit",
               "state", "updated", "head_repo", "head_ref", "head_oid", "base", "author"}
HEX = b"0123456789ABCDEF"
ESC = frozenset(range(0x01, 0x20)) | {0x7F} | frozenset(b"%;,=:")  # 엔진 penc가 인코딩하는 바이트(_esc)
ESC_SP = ESC | {0x20}                                                # 머리 줄 값은 공백도(penc sp=1)
# 엔진 P_PARSE의 형식 검사(hex40·iso·run_id)와 같은 정규식 — 문자 집합은 ASCII만(iso의 달력 검사는 iso_ok)
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX40B = re.compile(rb"[0-9a-f]{40}")
ISO = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z")
RUN_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}")
# ── v4 Jira 행 (spec-v4 §B5·§C, spec-v5 §A2) ──
DIGITS = re.compile(r"[0-9]+")
JIRA_UPDATED = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})"
                          r"([+-])([0-9]{2})([0-9]{2})")       # Jira updated, 예 2026-10-19T06:07:25.160+0900
JIRA_SITE = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")   # 호스트 이름만(/ @ : 없음)
HTTPS_URL = re.compile(r"https://[A-Za-z0-9.-]+(/[!-~]*)?")    # 사용자 정보·포트·공백·비ASCII 없음
JIRA_LEVELS = ("TO-QA", "TO-CLOSED")
ITEM_STATES = ("OPEN", "MERGED", "CLOSED")
ITEM_ROLES = ("required", "superseded", "unrelated")
PR_NUM = re.compile(r"[1-9][0-9]*")
ITEM_ID = re.compile(r"pr:[1-9][0-9]*|c:[0-9a-f]{40}")
CLOSE_BASIS = re.compile(r"(duplicate|superseded):([A-Z][A-Z0-9]+-[1-9][0-9]*)|superseded:pr:([1-9][0-9]*)")
JIRA_KEY = re.compile(r"[A-Z][A-Z0-9]+-[1-9][0-9]*")
MARKER = re.compile(r"chore 정리 → (.+) — by Claude triage ([0-9]{4}-[0-9]{2}-[0-9]{2})")
MARKER_FMT = "chore 정리 → %s — by Claude triage %s"
JIRA_EV_KEYS = ("v", "reason", "known", "missing", "owner", "decider", "recommend", "cites", "complete", "jira")
JIRA_VERDICTS = ("KEEP", "AMBIGUOUS", "TO-QA", "TO-CLOSED", "NOT-JUDGED", "EXCLUDED")   # Jira 단위에 CLOSE는 없다
AMBIGUOUS_NEEDS = ("known", "missing", "owner", "decider", "recommend")
OWNER = re.compile(r"me|creator|qa-team|unknown|author:\S+")
INV_KEYS = ("total", "jql", "site")
JIRA_UNIT_SNAP_KEYS = ("summary", "status_name")      # tier-3 jira#<KEY> snapshot: - 또는 정확히 이 두 키, 이 순서
UNIT_EV_KEYS = ("t",) + JIRA_EV_KEYS                 # tier-3 pr#N / issue#N 구조형 증거 (t = 제목)
UNIT_VERDICTS = ("KEEP", "AMBIGUOUS", "NOT-JUDGED")   # CLOSE는 실행 행(close-pr/close-issue), EXCLUDED·TO-*는 Jira만
# snapshot 끝에만 올 수 있는 선택 키: close-pr/close-issue의 title(제목, 비면 안 됨), tier-3 pr#N/issue#N의 verdict
# (구조형 증거의 표지 — 엔진은 verdict를 쓰지 않는다. 있으면 증거 = decode_unit_evidence, 없으면 언제나 날것 제목)
ITEM_KEYS = {"id", "kind", "pr", "state", "role", "sha"}
# 게시되는 댓글(close-pr·close-issue·jira-transition 증거)에 허용하지 않는 제어 문자 = \n·\t 외 전부
# (scripts/chore-jira.py BAD_TEXT_RE와 같은 집합 — 계획 검사가 받은 댓글을 apply 도중 헬퍼가 거절하지 않게)
COMMENT_ACTIONS = ("close-pr", "close-issue", JIRA_ACTION)
BAD_COMMENT = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
# ── v4.3 move-issue (design v9 §1 R6·§2·§4) ── 증거는 구조형(reason;gh;related) — gh(GitHub에 달 댓글 틀)는 COMMENT_ACTIONS의
# 칸 검사가 아니라 풀어서 _check_move_gh로 본다
MOVE_EV_KEYS = ("reason", "gh", "related")
MOVE_GH_MARKER = "Jira로 옮김"          # GitHub 이관 댓글 표지의 group1 (KEY 없음 — {KEY} 두 번은 본문에만)
MOVE_CAP = 32000                       # 설명 doc 저장 형태 상한: json.dumps(doc, ensure_ascii=False, separators=(",", ":"))의
                                       # UTF-16 단위 길이(잘림 안내 포함) — Jira 설명 한도 32,767 아래
MOVE_NOTICE = "나머지는 원 이슈에서: "    # 설명 블록 10(잘림 안내)의 머리 — move_description이 쓰고 move_truncated가 읽는다
SUMMARY_MAX = 255                      # Jira 요약 길이 상한
HEX64 = re.compile(r"[0-9a-f]{64}")
JIRA_PROJECT = re.compile(r"[A-Z][A-Z0-9]+")


class PlanError(Exception):
    pass


# ───────────────────────── 입력 파싱 ─────────────────────────

def pdec(raw, where, sp=False):
    """percent-decoding 정확히 한 번 (bytes → str) = 엔진 pdec(chore.sh AWK_LIB)과 같은 입력만 받는다.
    구조 분할은 호출자가 끝낸 상태여야 한다. 인코딩되는 바이트 = 0x01–0x1F·0x7F·% ; , = : (sp = 머리 줄 값이면
    공백도). 그 바이트는 반드시 %XX(대문자)로, 그 밖의 바이트는 반드시 날것으로 — 정규 인코딩이 하나뿐이라
    렌더러와 엔진이 같은 바이트를 같게 읽는다. 거절: 잘못된·잘린 %XX, %00, %80 이상(UTF-8 바이트는 날것),
    인코딩할 필요 없는 바이트의 %XX(%41, 행 값의 %20), 인코딩해야 할 바이트의 날것. 디코딩 결과가 UTF-8이
    아니면 역시 거절(엔진은 바이트로 통과시키지만 화면에 쓸 수 없다 — 더 좁은 쪽)."""
    esc = ESC_SP if sp else ESC
    out = bytearray()
    i, n = 0, len(raw)
    while i < n:
        c = raw[i]
        if c == 0x25:  # %
            h = raw[i + 1:i + 3]
            if len(h) != 2 or h[0] not in HEX or h[1] not in HEX:
                raise PlanError("%s: malformed percent-escape %r" % (where, bytes(raw[i:i + 3])))
            v = int(h, 16)
            if v == 0:
                raise PlanError("%s: NUL byte in value (%%00)" % where)
            if v > 0x7F:
                raise PlanError("%s: percent-escape %%%02X of a non-ASCII byte (UTF-8 bytes stay raw)" % (where, v))
            if v not in esc:
                raise PlanError("%s: non-canonical percent-escape %%%02X (%r is never encoded%s)"
                                % (where, v, chr(v), "" if sp or v != 0x20 else " in a row value"))
            out.append(v)
            i += 3
            continue
        if c < 0x20 or c == 0x7F:
            raise PlanError("%s: raw control byte 0x%02X (must be percent-encoded)" % (where, c))
        if c in esc:
            raise PlanError("%s: unencoded %r (must be percent-encoded)" % (where, chr(c)))
        out.append(c)
        i += 1
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError as e:
        raise PlanError("%s: value is not UTF-8 (%s)" % (where, e))


def iso_ok(s):
    """엔진 iso(x)와 같은 규칙: 형식 YYYY-MM-DDTHH:MM:SSZ이고 달력상 있는 UTC 시각 — 월 01–12, 일 01~그 달 마지막 날
    (윤년 = 4로 나눠지되 100으로 나눠지면 평년, 400으로 나눠지면 윤년), 시 00–23, 분 00–59, 초 00–59(윤초 없음).
    __tests__/py/chore-render.test.sh 34가 엔진의 iso와 대조한다."""
    m = ISO.fullmatch(s)
    if not m:
        return False
    y, mo, d, h, mi, se = (int(g) for g in m.groups())
    leap = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    last = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    return 1 <= mo <= 12 and 1 <= d <= last[mo - 1] and h <= 23 and mi <= 59 and se <= 59


def hasctl(s):
    """엔진 hasctl: 디코딩한 머리 줄 값에 든 제어 문자(0x01–0x1F, 0x7F)."""
    return any(ord(c) < 0x20 or ord(c) == 0x7F for c in s)


def raw_text(raw, where):
    """디코딩하지 않는 칸(expected) — 엔진도 이 칸은 바이트 그대로 비교한다(close-issue의 ISO 시각은 날것 ':')."""
    if any(c < 0x20 or c == 0x7F for c in raw):
        raise PlanError("%s: raw control byte in expected" % where)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise PlanError("%s: expected is not UTF-8 (%s)" % (where, e))


def valid_branch(name):
    """브랜치 이름 = git check-ref-format --branch 규칙(git 2.54로 대조, __tests__/py/chore-render.test.sh 25).
    거절: 빈 이름, HEAD, - 또는 / 로 시작, / 또는 . 으로 끝남, . 으로 시작하거나 .lock으로 끝나는 구성 요소, .., @{,
    //, 제어 문자, 공백 ~ ^ : ? * [ \\ . git과 다른 것은 @ 하나뿐(아래)."""
    # @ 단독: git --branch는 받지만 리비전 문법에서 @는 HEAD의 별칭이라 거절한다 — git보다 좁게 거르는 쪽이라 안전하다
    if not name or name in ("@", "HEAD") or name.startswith(("-", "/")) or name.endswith(("/", ".")):
        return False
    if any(c.startswith(".") or c.endswith(".lock") for c in name.split("/")):
        return False
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in name):
        return False
    if any(c in name for c in " ~^:?*[\\") or ".." in name or "@{" in name or "//" in name:
        return False
    return True


def parse_header(line):
    fields = line.split(b"\t")
    if fields[0] != HEADER_TAG:
        raise PlanError("line 1: header must start with '#chore-plan v3'")
    hdr = {}
    for f in fields[1:]:
        if b"=" not in f:
            raise PlanError("line 1: header field without '=': %r" % f[:40])
        k, v = f.split(b"=", 1)
        key = k.decode("ascii", "replace")
        if key not in HEADER_KEYS:
            raise PlanError("line 1: unknown header key %r" % key)
        if key in hdr:
            raise PlanError("line 1: duplicate header key %r" % key)
        where = "line 1 %s" % key
        if key in LIST_KEYS or key in TIP_KEYS:
            items = [] if v == b"" else v.split(b",")
            vals = []
            for it in items:
                if it == b"":
                    raise PlanError("%s: empty list item" % where)
                if key in TIP_KEYS:
                    if b":" not in it:
                        raise PlanError("%s: item without name:oid" % where)
                    nm, oid = it.split(b":", 1)
                    if not HEX40B.fullmatch(oid):  # 엔진 htips: name:oid 정확히 둘, oid = 40자리 소문자 16진
                        raise PlanError("%s: malformed name:oid element (oid must be 40 lowercase hex)" % where)
                    name = pdec(nm, where, sp=True)
                    if name == "":
                        raise PlanError("%s: item with an empty name" % where)
                    vals.append((name, oid.decode("ascii")))
                else:
                    d = pdec(it, where, sp=True)
                    if hasctl(d):
                        raise PlanError("%s: control character in a value" % where)
                    vals.append(d)
            hdr[key] = vals
        else:
            d = pdec(v, where, sp=True)
            if hasctl(d):
                raise PlanError("%s: control character in a value" % where)
            hdr[key] = d
    missing = [k for k in HEADER_KEYS if k not in hdr]
    if missing:
        raise PlanError("line 1: missing header keys: %s" % " ".join(missing))
    if hdr["no_local"] not in ("0", "1"):
        raise PlanError("line 1: no_local must be 0 or 1")
    if not RUN_ID.fullmatch(hdr["run_id"]):
        raise PlanError("line 1: header run_id malformed (want YYYYMMDDTHHMMSSZ-<8 hex>)")
    if not iso_ok(hdr["created"]):  # apply·verify도 빈 값·형식 오류·달력에 없는 created를 die로 거부한다
        raise PlanError("line 1: header created must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ")
    want = {hdr["default"]} | set(hdr["integrate"])
    if set(hdr["I"]) != want or len(hdr["I"]) != len(set(hdr["I"])):
        raise PlanError("line 1: I (%s) must be exactly default + integrate (%s)"
                        % (",".join(hdr["I"]), ",".join(sorted(want))))
    if sorted(n for n, _ in hdr["Itips"]) != sorted(hdr["I"]):
        raise PlanError("line 1: Itips must name exactly the I refs")
    return hdr


def parse_snapshot(raw, where):
    if raw == b"-":
        return {}
    snap = {}
    for pair in raw.split(b";"):
        if b"=" not in pair:
            raise PlanError("%s: snapshot pair without '='" % where)
        k, v = pair.split(b"=", 1)
        key = pdec(k, where)
        if key == "":
            raise PlanError("%s: empty snapshot key" % where)
        if key in snap:
            raise PlanError("%s: duplicate snapshot key %r" % (where, key))
        snap[key] = pdec(v, where)
    return snap


def parse_plan(data):
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    if not lines:
        raise PlanError("plan file is empty")
    hdr = parse_header(lines[0])
    rows, seen = [], set()
    for no, line in enumerate(lines[1:], start=2):
        where = "line %d" % no
        cols = line.split(b"\t")
        if len(cols) != 6:
            raise PlanError("%s: expected 6 tab-separated columns, got %d" % (where, len(cols)))
        tier = pdec(cols[0], where)
        if tier not in ("1", "2", "3"):
            raise PlanError("%s: tier must be 1, 2 or 3" % where)
        action = pdec(cols[1], where)
        if action not in ACTIONS:
            raise PlanError("%s: unknown action %r" % (where, action))
        # 구조 접두 remote:/local:(날것 ':')를 먼저 떼고 이름만 한 번 디코딩한다 — 엔진 P_PARSE와 같은 순서.
        # %3A로 쓴 ':'는 접두가 아니다(보존 행이면 알 수 없는 ref, 브랜치 행이면 잘못된 이름).
        m = re.match(rb"(remote|local):", cols[2])
        prefix = m.group(0).decode("ascii") if m else ""
        ref = prefix + pdec(cols[2][len(prefix):], where)
        if ref == "":
            raise PlanError("%s: empty ref" % where)
        if (action, ref) in seen:
            raise PlanError("%s: duplicate (action, ref) %s %s" % (where, action, ref))
        seen.add((action, ref))
        if action not in ALLOWED[int(tier)]:
            raise PlanError("%s: action %s not allowed in tier %s" % (where, action, tier))
        check_ref(action, ref, where, bool(prefix))
        snap = parse_snapshot(cols[4], where)
        keys = set(snap)
        last = optional_last_key(action, ref)
        if last in snap:
            if list(snap)[-1] != last:
                raise PlanError("%s: snapshot key %s must be the last key" % (where, last))
            keys.discard(last)
            if last == "title" and snap["title"] == "":
                raise PlanError("%s: snapshot title must not be empty" % where)
            if last == "verdict" and snap["verdict"] not in UNIT_VERDICTS:
                raise PlanError("%s: snapshot verdict must be one of %s" % (where, " ".join(UNIT_VERDICTS)))
        if action in SNAP_EXACT:
            if action == "worktree-prune" and cols[4] != b"-":
                raise PlanError("%s: worktree-prune snapshot must be -" % where)
            missing = SNAP_EXACT[action] - keys
            extra = keys - SNAP_EXACT[action]
            if missing or extra:
                raise PlanError("%s: snapshot keys for %s: missing [%s] not allowed [%s]" % (
                    where, action, " ".join(sorted(missing)), " ".join(sorted(extra))))
        elif not is_jira_report(action, ref) and keys - SNAP_REPORT:
            raise PlanError("%s: unknown snapshot key(s) %s" % (where, " ".join(sorted(keys - SNAP_REPORT))))
        expected = raw_text(cols[3], where)
        check_row_values(action, expected, snap, cols[5], where)
        comment = pdec(cols[5], where)
        if action in COMMENT_ACTIONS:
            cc = BAD_COMMENT.search(comment)
            if cc:
                raise PlanError("%s: %s %s comment contains control character U+%04X (only \\n and \\t are allowed "
                                "in a posted comment)" % (where, action, ref, ord(cc.group())))
        row = {"line": no, "tier": int(tier), "action": action, "ref": ref,
               "expected": expected, "snapshot": snap,
               "evidence": comment}
        if action in CLOSE_ACTIONS:
            row["title"] = snap.get("title")
        if action == MOVE_ACTION:   # "move" 키(= "jira" 아님): inventory 총수·transition 규칙에 들어가지 않는다
            row["move"] = check_move_issue(ref, expected, snap, cols[5], where)
        jira = jira_row(action, ref, expected, snap, cols[5], where, hdr["remote"])
        if jira is not None:
            row["jira"] = jira
        unit = unit_row(action, ref, snap, cols[5], where)
        if unit is not None:
            row["unit"] = unit
        rows.append(row)
    check_plan_rows(hdr, rows)
    return hdr, rows


def check_ref(action, ref, where, prefixed):
    """ref 모양 = action이 정한다. 브랜치 이름은 git 규칙, PR·이슈 번호는 [1-9][0-9]*.
    prefixed = 날것 remote:/local: 접두가 있었는지(보존 행의 브랜치 표기는 그것뿐)."""
    if action in CLOSE_ACTIONS:
        if not CLOSE_ACTIONS[action].fullmatch(ref):
            raise PlanError("%s: %s ref must look like %s" % (
                where, action, "pr#<N>" if action == "close-pr" else "issue#<N>"))
    elif action == JIRA_ACTION:
        if not JIRA_KEY_REF.fullmatch(ref):
            raise PlanError("%s: jira-transition ref must look like jira#<KEY> (jira#<PROJECT>-<N>)" % where)
    elif action == MOVE_ACTION:
        if not ISSUE_REF.fullmatch(ref):
            raise PlanError("%s: move-issue ref must look like issue#<N>" % where)
    elif action == "worktree-prune":
        if ref != ".":
            raise PlanError("%s: worktree-prune ref must be ." % where)
    elif action != "report":
        if not valid_branch(ref):
            raise PlanError("%s: invalid branch name in ref %r" % (where, ref))
    elif prefixed:
        if not valid_branch(ref.split(":", 1)[1]):
            raise PlanError("%s: invalid branch name in ref %r" % (where, ref))
    elif ref != "." and not (PR_REF.fullmatch(ref) or ISSUE_REF.fullmatch(ref)
                             or JIRA_KEY_REF.fullmatch(ref) or JIRA_PROJECT_REF.fullmatch(ref)):
        raise PlanError("%s: unrecognised report ref %r (want remote:<b>, local:<b>, pr#N, issue#N, jira#KEY, "
                        "jira#PROJECT or .)" % (where, ref))


def check_row_values(action, x, s, ev_raw, where):
    """apply가 계획을 die로 거부하는 행 값 검사 = 엔진 P_PARSE의 action별 분기(같은 순서·같은 문구).
    x = expected(디코딩 안 함), s = 디코딩한 snapshot, ev_raw = evidence 칸 바이트. 예외 둘(pr_base가 통합 브랜치가
    아님, pr_head_repo가 이 저장소가 아님)은 여기서 거부하지 않고 화면에 표시한다 — render의 그 자리 주석 참고."""
    def bad(msg):
        raise PlanError("%s: %s" % (where, msg))
    if action.startswith("delete-"):
        if not HEX40.fullmatch(x):
            bad("expected must be a 40-hex oid")
        if s["basis"] != "a":
            bad("unsupported basis %r" % s["basis"])
        if not re.fullmatch(r"[0-9]+", s["pr"]):
            bad("snapshot pr must be a number")
        if s["pr_head_oid"] != x:
            bad("snapshot pr_head_oid differs from expected")
        if not HEX40.fullmatch(s["pr_merge_commit"]):
            bad("snapshot pr_merge_commit must be a 40-hex oid")
        if not valid_branch(s["pr_base"]):
            bad("invalid snapshot pr_base %r" % s["pr_base"])
    elif action == "close-pr":
        if ev_raw == b"":
            bad("close-pr evidence (the comment to post) is empty")
        if not HEX40.fullmatch(x):
            bad("close-pr expected must be the 40-hex head oid")
        if s["state"] != "OPEN":
            bad("snapshot state must be OPEN")
        if s["head_oid"] != x:
            bad("snapshot head_oid differs from expected")
        if not iso_ok(s["updated"]):
            bad("snapshot updated must be an ISO timestamp")
        if s["head_ref"] == "" or s["head_repo"] == "":
            bad("snapshot head_ref / head_repo must not be empty")
    elif action == "close-issue":
        if ev_raw == b"":
            bad("close-issue evidence (the comment to post) is empty")
        if not iso_ok(x):
            bad("close-issue expected must be the ISO updatedAt")
        if s["state"] != "OPEN":
            bad("snapshot state must be OPEN")
        if s["updated"] != x:
            bad("snapshot updated differs from expected")
    elif action == "worktree-prune":
        if x != "-":
            bad("worktree-prune row must be . - -")


def check_plan_rows(hdr, rows):
    """같은 대상이 두 상태로 들어간 계획(지우면서 남김, 닫으면서 남김, Jira 티켓을 옮기면서 남김, 이슈를 Jira로 옮기면서
    남기거나 닫음)과 원격 전용 계획의 로컬 행을 거부하고, Jira inventory 행의 total = 그 프로젝트의 jira#<KEY> 행 수
    (tier 2 + tier 3)를 확인한다. Jira 바인딩 하나 = Jira 행(row["jira"])과 move-issue 행(row["move"])의 site·project 전부."""
    kept = {r["ref"] for r in rows if r["action"] == "report"}
    local_del, issue_exec = {}, {}
    for r in rows:
        a, ref = r["action"], r["ref"]
        if a.startswith("delete-local"):
            if ref in local_del:
                raise PlanError("line %d: %s %s and line %d %s name the same local branch — one target, two states" % (
                    r["line"], a, ref, local_del[ref]["line"], local_del[ref]["action"]))
            local_del[ref] = r
        twin = ("remote:" + ref if a == "delete-remote" else "local:" + ref if a.startswith("delete-local")
                else ref if a in CLOSE_ACTIONS or a in ("worktree-prune", JIRA_ACTION, MOVE_ACTION) else None)
        if twin is not None and twin in kept:
            raise PlanError("line %d: %s %s is also listed as kept (%s) — one target, two states" % (
                r["line"], a, ref, twin))
        if a in ("close-issue", MOVE_ACTION):     # 한 이슈 = 닫기 또는 옮기기 하나
            if ref in issue_exec:
                raise PlanError("line %d: %s %s and line %d %s %s name the same issue — one target, two states" % (
                    r["line"], a, ref, issue_exec[ref]["line"], issue_exec[ref]["action"], ref))
            issue_exec[ref] = r
        if hdr["no_local"] == "1" and a in LOCAL_ACTIONS:
            raise PlanError("line %d: %s row in a no_local=1 plan" % (r["line"], a))
    # move-issue: one plan date (the gh marker date rebuilds every payload), one issue per adopted ticket, adopt ∉ related
    first_date, adopted = None, {}
    for r in rows:
        mv = r.get("move")
        if mv is None:
            continue
        if first_date is None:
            first_date = (mv["plan_date"], r["line"])
        elif mv["plan_date"] != first_date[0]:
            raise PlanError("line %d: move-issue %s plan date %s (its gh marker) differs from %s on line %d — one plan, "
                            "one plan date" % (r["line"], r["ref"], mv["plan_date"], first_date[0], first_date[1]))
        if mv["adopt"] is not None:
            if mv["adopt"] in mv["related"]:
                raise PlanError("line %d: move-issue %s adopt %s is also one of its related keys" % (
                    r["line"], r["ref"], mv["adopt"]))
            if mv["adopt"] in adopted:
                o = adopted[mv["adopt"]]
                raise PlanError("line %d: move-issue %s adopts %s, already adopted by line %d %s — one ticket, one issue" % (
                    r["line"], r["ref"], mv["adopt"], o["line"], o["ref"]))
            adopted[mv["adopt"]] = r
    moves = [r for r in rows if r.get("jira", {}).get("kind") == "transition"]
    closing = {r["jira"]["key"]: r for r in moves if r["jira"]["level"] == "TO-CLOSED"}
    ids = {}
    for r in moves:
        cb = r["jira"]["close_basis"]
        if cb is not None and cb["type"] == "duplicate" and cb["key"] in closing:
            raise PlanError("line %d: duplicate close_basis %s names another TO-CLOSED row (line %d)" % (
                r["line"], cb["key"], closing[cb["key"]]["line"]))
        iid = r["snapshot"]["issue_id"]
        if iid in ids:
            raise PlanError("line %d: issue_id %s repeats line %d — one ticket, one row" % (r["line"], iid, ids[iid]))
        ids[iid] = r["line"]
    bound = {}   # "site" / "project" → (값, 처음 나온 줄) — 계획 하나 = Jira 바인딩 하나(spec-v4 B1)
    for r in rows:
        j, mv = r.get("jira"), r.get("move")
        if j is not None:
            project = j["project"]
            site = j["site"] if j["kind"] == "inventory" else r["snapshot"]["site"] if j["kind"] == "transition" else None
        elif mv is not None:
            project, site = mv["project"], mv["site"]
        else:
            continue
        for what, val in (("project", project), ("site", site)):
            if val is None:
                continue
            if what in bound and bound[what][0] != val:
                raise PlanError("line %d: jira %s %s differs from jira %s %s on line %d — one Jira binding per plan" % (
                    r["line"], what, val, what, bound[what][0], bound[what][1]))
            bound.setdefault(what, (val, r["line"]))
    inventory, units = {}, {}
    for r in rows:
        j = r.get("jira")
        if j is None:
            continue
        if j["kind"] == "inventory":
            inventory[j["project"]] = r
        else:
            units.setdefault(j["project"], []).append(r)
    for project, r in inventory.items():
        n = len(units.get(project, ()))
        if n != r["jira"]["total"]:
            raise PlanError("line %d: inventory total for jira#%s is %d but the plan has %d jira#%s-<N> rows" % (
                r["line"], project, r["jira"]["total"], n, project))
    for project, rs in units.items():
        if project not in inventory:
            raise PlanError("line %d: %s has no inventory row jira#%s" % (rs[0]["line"], rs[0]["ref"], project))

# ───────────────────────── v4 Jira 행 ─────────────────────────

def jira_time(s):
    """Jira updated 형식(YYYY-MM-DDTHH:MM:SS.mmm±HHMM, 예 2026-10-19T06:07:25.160+0900)이고 달력상 있는 시각이면 그 순간
    (aware datetime), 아니면 None. 달력 규칙 = iso_ok와 같고(윤년·월말·시 00–23·분 00–59·초 00–59) 연도 0001 이상,
    시차 시 00–23·분 00–59. 시각 비교는 언제나 이 순간으로 한다 — 계획의 Z 시각과 Jira의 +0900을 문자열로 비교하지 않는다."""
    m = JIRA_UPDATED.fullmatch(s)
    if not m:
        return None
    y, mo, d, h, mi, se, ms, sign, oh, om = m.groups()
    if int(oh) > 23 or int(om) > 59:
        return None
    try:
        off = timedelta(hours=int(oh), minutes=int(om))
        return datetime(int(y), int(mo), int(d), int(h), int(mi), int(se), int(ms) * 1000,
                        tzinfo=timezone(-off if sign == "-" else off))
    except ValueError:
        return None


def has_chore_marker(text):
    """text(Jira 댓글 글)의 어느 줄이든 앞뒤 공백(스페이스·탭·CR 등 str.strip)을 뗀 줄 전체가 MARKER면 True — chore가 이미
    남긴 댓글을 알아보는 탐지 한 벌(collect와 Jira 쓰기 헬퍼가 같이 쓴다). 더 긴 줄 안에 든 표지 글은 표지가 아니다.
    계획의 우리 댓글 검사(check_jira_transition: 마지막 줄이 정확히 MARKER)와 다르다 — 그쪽은 우리가 쓰는 바이트다."""
    return any(MARKER.fullmatch(ln.strip()) for ln in text.split("\n"))


def check_jira_transition(ref, x, s, ev_raw, where, remote):
    """tier-2 jira-transition 행(키 집합은 parse_plan이 이미 확인) → row["jira"]. x = expected(디코딩 안 함, Jira updated),
    s = 디코딩한 snapshot, ev_raw = 댓글 칸 바이트, remote = 머리 줄 remote(<owner>/<repo>; TO-QA run_url 검사).
    검사 순서 = 모듈 docstring."""
    def bad(msg):
        raise PlanError("%s: %s" % (where, msg))
    m = JIRA_KEY_REF.fullmatch(ref)
    if ev_raw == b"":
        bad("jira-transition evidence (the comment to post) is empty")
    if jira_time(x) is None:
        bad("jira-transition expected must be the Jira updated time YYYY-MM-DDTHH:MM:SS.mmm+HHMM")
    if not JIRA_SITE.fullmatch(s["site"]):
        bad("snapshot site must be a host name")
    if s["project"] != m.group(1):
        bad("ref project %s differs from snapshot project %r" % (m.group(1), s["project"]))
    if not DIGITS.fullmatch(s["issue_id"]):
        bad("snapshot issue_id must be numeric")
    for k, what in (("status", "status id"), ("to", "transition id"), ("to_status", "status id")):
        if not DIGITS.fullmatch(s[k]):
            bad("snapshot %s must be a numeric %s" % (k, what))
    if s["status"] == s["to_status"]:
        bad("snapshot status equals to_status (the ticket is already at the target)")
    if s["account"] == "":
        bad("snapshot account must not be empty")
    if s["assignee"] != s["account"]:
        bad("snapshot assignee differs from account")
    level = s["level"]
    if level not in JIRA_LEVELS:
        bad("snapshot level must be TO-QA or TO-CLOSED")
    items = decode_items(s["items"], where)
    ledgers = decode_ledgers(s["ledgers"], where)
    if level == "TO-QA":
        if not HEX40.fullmatch(s["S"]):
            bad("TO-QA snapshot S must be a 40-hex oid")
        if not DIGITS.fullmatch(s["run"]):
            bad("TO-QA snapshot run must be a number")
        if not HTTPS_URL.fullmatch(s["run_url"]):
            bad("TO-QA snapshot run_url must be an https URL")
        if s["run_url"] != "https://github.com/%s/actions/runs/%s" % (remote, s["run"]):
            bad("TO-QA snapshot run_url must be https://github.com/<remote>/actions/runs/<run>")
        if not items:
            bad("TO-QA snapshot items must not be empty")
        if s["reqs"] == "-":
            bad("TO-QA snapshot reqs must not be empty")
        if s["close_basis"] != "-":
            bad("TO-QA snapshot close_basis must be -")
        reqs = decode_reqs(s["reqs"], where)
        by_id = {it["id"]: it for it in items}
        for rq in reqs:
            it = by_id.get(rq["target"])
            if it is None:
                bad("reqs target %s is not in items" % rq["target"])
            if it["role"] != "required":
                bad("reqs target %s is not a required item (role %s)" % (rq["target"], it["role"]))
            if it["kind"] == "pr" and it["state"] != "MERGED":
                bad("reqs target %s is not MERGED (state %s)" % (rq["target"], it["state"]))
        basis = None
    else:
        basis = decode_close_basis(s["close_basis"], where)
        if basis["key"] == ref[len("jira#"):]:
            bad("TO-CLOSED close_basis names the ticket itself")
        if basis["type"] == "duplicate" and basis["key"].rsplit("-", 1)[0] != m.group(1):
            bad("TO-CLOSED duplicate close_basis %s is not in project %s" % (basis["key"], m.group(1)))
        if (s["S"], s["run"], s["run_url"]) != ("-", "-", "-"):
            bad("TO-CLOSED snapshot S, run and run_url must be -")
        if s["reqs"] != "-":
            bad("TO-CLOSED snapshot reqs must be -")
        reqs = []
    for it in items:
        if it["role"] == "required" and it["kind"] == "pr" and it["state"] != "MERGED":
            bad("required item %s is not a MERGED PR or a commit (state %s)" % (it["id"], it["state"]))
    last = pdec(ev_raw, where).split("\n")[-1]
    mk = MARKER.fullmatch(last)
    if not mk:
        bad("jira-transition comment must end with the marker line 'chore 정리 → <to_name> — by Claude triage YYYY-MM-DD'")
    if mk.group(1) != s["to_name"]:
        bad("comment marker names %r, not the snapshot to_name %r" % (mk.group(1), s["to_name"]))
    return {"kind": "transition", "key": ref[len("jira#"):], "project": m.group(1), "level": level,
            "items": items, "reqs": reqs, "close_basis": basis, "ledgers": ledgers, "marker": last}


def jira_row(action, ref, x, s, ev_raw, where, remote):
    """Jira 행이면 row["jira"](kind = transition | unit | inventory), 아니면 None. unit = tier-3 jira#<KEY>(판정했지만
    실행 안 함·제외·다른 저장소), inventory = tier-3 jira#<PROJECT>(검색 총수)."""
    if action == JIRA_ACTION:
        return check_jira_transition(ref, x, s, ev_raw, where, remote)
    if action != "report":
        return None
    m = JIRA_KEY_REF.fullmatch(ref)
    if m:
        if x != "-":
            raise PlanError("%s: tier-3 jira row expected must be -" % where)
        if s and tuple(s) != JIRA_UNIT_SNAP_KEYS:
            raise PlanError("%s: tier-3 jira#<KEY> snapshot must be - or summary=<text>;status_name=<text> in this order"
                            % where)
        if s and (s["summary"] == "" or s["status_name"] == ""):
            raise PlanError("%s: tier-3 jira#<KEY> snapshot summary and status_name must not be empty" % where)
        return {"kind": "unit", "key": ref[len("jira#"):], "project": m.group(1),
                "summary": s.get("summary"), "status_name": s.get("status_name"),
                "evidence": decode_jira_evidence(ev_raw, where)}
    m = JIRA_PROJECT_REF.fullmatch(ref)
    if m:
        if x != "-":
            raise PlanError("%s: tier-3 jira row expected must be -" % where)
        if s:
            raise PlanError("%s: inventory row jira#<PROJECT> snapshot must be -" % where)
        return dict({"kind": "inventory", "project": m.group(1)}, **decode_inventory_evidence(ev_raw, where))
    return None


def is_jira_report(action, ref):
    """tier-3 report 행 중 Jira 행(jira#<KEY> 단위·jira#<PROJECT> inventory) — snapshot 규칙이 SNAP_REPORT가 아니라 jira_row."""
    return action == "report" and bool(JIRA_KEY_REF.fullmatch(ref) or JIRA_PROJECT_REF.fullmatch(ref))


def encode_jira_unit_snapshot(summary, status_name):
    """tier-3 jira#<KEY> 행의 snapshot 칸 바이트(summary=<penc>;status_name=<penc>, 이 순서; 둘 다 비면 안 됨)."""
    if not isinstance(summary, str) or not isinstance(status_name, str):
        raise PlanError("encode_jira_unit_snapshot: summary and status_name must be str")
    if summary == "" or status_name == "":
        raise PlanError("encode_jira_unit_snapshot: tier-3 jira#<KEY> snapshot summary and status_name must not be empty")
    return encode_snapshot({"summary": summary, "status_name": status_name})


def decode_items(text, where="items"):
    """snapshot items 값(1층을 푼 문자열) → [{"id", "kind", "pr", "state", "role", "sha"}]; "-" = 빈 목록.
    요소 = pr:<N>:<OPEN|MERGED|CLOSED>:<required|superseded|unrelated>:<merge_sha40|->(MERGED ⇔ 40-hex, 아니면 -)
    | c:<sha40>:<role>. pr 항목: pr = N, sha = 병합 커밋(MERGED가 아니면 None). c 항목: pr·state = None, sha = 커밋.
    id(pr:<N> | c:<sha40>)는 한 번만."""
    if text == "-":
        return []
    out, seen = [], set()
    for el in text.split(","):
        f = el.split(":")
        if len(f) == 5 and f[0] == "pr" and PR_NUM.fullmatch(f[1]) and f[2] in ITEM_STATES and f[3] in ITEM_ROLES \
                and (HEX40.fullmatch(f[4]) if f[2] == "MERGED" else f[4] == "-"):
            it = {"id": "pr:" + f[1], "kind": "pr", "pr": int(f[1]), "state": f[2], "role": f[3],
                  "sha": f[4] if f[2] == "MERGED" else None}
        elif len(f) == 3 and f[0] == "c" and HEX40.fullmatch(f[1]) and f[2] in ITEM_ROLES:
            it = {"id": "c:" + f[1], "kind": "c", "pr": None, "state": None, "role": f[2], "sha": f[1]}
        else:
            raise PlanError("%s: malformed items element %r (want pr:<N>:<OPEN|MERGED|CLOSED>:<role>:<merge_sha40|-> "
                            "or c:<sha40>:<role>)" % (where, el))
        if it["id"] in seen:
            raise PlanError("%s: duplicate items element %s" % (where, it["id"]))
        seen.add(it["id"])
        out.append(it)
    return out


def encode_items(items):
    """decode_items의 역: [{"kind", "pr", "state", "role", "sha"(, "id")}] → snapshot items 값(1층 인코딩 전 문자열).
    입력을 먼저 검사한다(키 = ITEM_KEYS 안, kind = pr | c, pr = 양의 int(bool 아님), state·role = 열거값, sha = 소문자
    40-hex — MERGED가 아닌 pr은 None, c 항목의 pr·state = None) → 형식화 → decode_items로 되읽어 입력의 모든 키가
    그대로 돌아오는지 확인(정체성 보존 왕복). 어긋나면 PlanError."""
    def bad(i, msg):
        raise PlanError("encode_items: item %d: %s" % (i, msg))
    if not isinstance(items, (list, tuple)):
        raise PlanError("encode_items: items must be a list")
    if not items:
        return "-"
    els = []
    for i, it in enumerate(items):
        if not isinstance(it, dict) or set(it) - ITEM_KEYS:
            bad(i, "must be a dict with keys from %s" % " ".join(sorted(ITEM_KEYS)))
        kind, sha, role = it.get("kind"), it.get("sha"), it.get("role")
        if role not in ITEM_ROLES:
            bad(i, "role must be one of %s" % " ".join(ITEM_ROLES))
        if kind == "pr":
            n, state = it.get("pr"), it.get("state")
            if type(n) is not int or n <= 0:
                bad(i, "pr must be a positive int")
            if state not in ITEM_STATES:
                bad(i, "state must be one of %s" % " ".join(ITEM_STATES))
            if not (isinstance(sha, str) and HEX40.fullmatch(sha) if state == "MERGED" else sha is None):
                bad(i, "sha must be a lowercase 40-hex merge commit for MERGED, None otherwise")
            els.append("pr:%d:%s:%s:%s" % (n, state, role, sha or "-"))
        elif kind == "c":
            if not (isinstance(sha, str) and HEX40.fullmatch(sha)):
                bad(i, "commit sha must be lowercase 40-hex")
            if it.get("pr") is not None or it.get("state") is not None:
                bad(i, "a commit item has no pr / state")
            els.append("c:%s:%s" % (sha, role))
        else:
            bad(i, "kind must be pr or c")
    text = ",".join(els)
    back = decode_items(text, "encode_items")
    for i, (it, b) in enumerate(zip(items, back)):
        if any(b[k] != v for k, v in it.items()):
            bad(i, "does not round-trip (%r ≠ %r)" % (it, b))
    return text


def decode_reqs(text, where="reqs"):
    """snapshot reqs 값(1층을 푼 문자열) → [{"text", "target"}]; "-" = 빈 목록. 요소 = penc(요구사항 글) + "=>" + 항목 id
    (pr:<N> | c:<sha40>); 글 안의 = 는 인코딩되어 있으므로 첫 "=>"가 경계, 글은 한 번 더 pdec."""
    if text == "-":
        return []
    out = []
    for el in text.split(","):
        i = el.find("=>")
        if i <= 0 or not ITEM_ID.fullmatch(el[i + 2:]):
            raise PlanError("%s: malformed reqs element %r (want <encoded text>=>pr:<N> | c:<sha40>)" % (where, el))
        out.append({"text": pdec(el[:i].encode("utf-8"), "%s reqs text" % where), "target": el[i + 2:]})
    return out


def encode_reqs(reqs):
    """decode_reqs의 역: [{"text", "target"}] → snapshot reqs 값(1층 인코딩 전 문자열). 입력 검사(키 정확히 text·target,
    text = 비지 않은 str, target = pr:<N> | c:<sha40>) → 형식화 → 되읽어 같은지 확인."""
    if not isinstance(reqs, (list, tuple)):
        raise PlanError("encode_reqs: reqs must be a list")
    if not reqs:
        return "-"
    for i, r in enumerate(reqs):
        if not isinstance(r, dict) or set(r) != {"text", "target"} or not isinstance(r["text"], str) or r["text"] == "" \
                or not isinstance(r["target"], str) or not ITEM_ID.fullmatch(r["target"]):
            raise PlanError("encode_reqs: req %d must be {text: non-empty str, target: pr:<N> | c:<sha40>}" % i)
    text = ",".join(penc(r["text"]).decode("utf-8") + "=>" + r["target"] for r in reqs)
    if decode_reqs(text, "encode_reqs") != [dict(r) for r in reqs]:
        raise PlanError("encode_reqs: reqs do not round-trip")
    return text


def decode_ledgers(text, where="ledgers"):
    """snapshot ledgers 값(1층을 푼 문자열) → [경로]; "-" = 빈 목록(원장 없음). 요소 = penc(경로), 쉼표로 잇는다(경로 안의
    , 는 인코딩되어 있으므로 쉼표가 경계, 요소는 한 번 더 pdec). 경로는 받은 그대로(해석·정규화 안 함 — /a/../b와 /b는 둘).
    거절(이 순서): 빈 요소, 인코딩 오류, / 로 시작하지 않는 경로, 제어 문자(hasctl), 같은 경로 두 번."""
    if text == "-":
        return []
    out, seen = [], set()
    for el in text.split(","):
        if el == "":
            raise PlanError("%s: empty ledgers element" % where)
        path = pdec(el.encode("utf-8"), "%s ledgers path" % where)
        if not path.startswith("/"):
            raise PlanError("%s: ledgers path %r must be absolute (start with /)" % (where, path))
        if hasctl(path):
            raise PlanError("%s: ledgers path %r contains a control character" % (where, path))
        if path in seen:
            raise PlanError("%s: duplicate ledgers path %r" % (where, path))
        seen.add(path)
        out.append(path)
    return out


def encode_ledgers(paths):
    """decode_ledgers의 역: [경로 str] → snapshot ledgers 값(1층 인코딩 전 문자열; 빈 목록 = "-"). 입력 검사(list, 요소 = str)
    → 요소마다 penc → 쉼표로 잇기 → decode_ledgers로 되읽어 같은지 확인(빈·상대 경로·제어 문자·중복은 거기서 거절)."""
    if not isinstance(paths, (list, tuple)):
        raise PlanError("encode_ledgers: paths must be a list")
    if not paths:
        return "-"
    for i, path in enumerate(paths):
        if not isinstance(path, str):
            raise PlanError("encode_ledgers: path %d must be a str, not %s" % (i, type(path).__name__))
    text = ",".join(penc(path).decode("utf-8") for path in paths)
    if decode_ledgers(text, "encode_ledgers") != list(paths):
        raise PlanError("encode_ledgers: paths do not round-trip")
    return text


def decode_close_basis(text, where="close_basis"):
    """TO-CLOSED close_basis(duplicate:<KEY> | superseded:<KEY> | superseded:pr:<N>) → {"type", "key", "pr"}."""
    m = CLOSE_BASIS.fullmatch(text)
    if not m:
        raise PlanError("%s: TO-CLOSED snapshot close_basis must be duplicate:<KEY>, superseded:<KEY> or "
                        "superseded:pr:<N>" % where)
    if m.group(3):
        return {"type": "superseded", "key": None, "pr": int(m.group(3))}
    return {"type": m.group(1), "key": m.group(2), "pr": None}


def _pairs(raw, where, keys, what):
    """증거 칸 바이트 → 1층 pdec → ; 와 첫 = 로 나눈 (키, 2층 pdec 값) — 키는 정확히 keys, 이 순서."""
    got = [p.partition("=") for p in pdec(raw, where).split(";")]
    if tuple(k for k, eq, _ in got if eq) != keys or len(got) != len(keys):
        raise PlanError("%s: %s keys must be %s in this order" % (where, what, " ".join(keys)))
    return {k: pdec(v.encode("utf-8"), "%s %s %s" % (where, what, k)) for k, _, v in got}


def _verdict_fields(ev, where, what, verdicts):
    """증거 dict(2층까지 푼 값)의 판정 필드 규칙 — Jira 단위(jira evidence)와 PR·이슈 단위(unit evidence)가 같다.
    v ∈ verdicts, reason 필수, AMBIGUOUS면 known·missing·owner·decider·recommend 필수, owner = me | author:<login>
    | creator | qa-team | unknown(비어 있어도 됨), complete ∈ yes | no | 빈 값, jira = <KEY>:<penc(상태 이름)> 쉼표 목록
    → [{"key", "status"}]."""
    if ev["v"] not in verdicts:
        raise PlanError("%s: %s v must be one of %s" % (where, what, " ".join(verdicts)))
    if ev["reason"] == "":
        raise PlanError("%s: %s reason is empty" % (where, what))
    if ev["v"] == "AMBIGUOUS" and any(ev[k] == "" for k in AMBIGUOUS_NEEDS):
        raise PlanError("%s: AMBIGUOUS %s needs known, missing, owner, decider and recommend" % (where, what))
    if ev["owner"] != "" and not OWNER.fullmatch(ev["owner"]):
        raise PlanError("%s: %s owner must be me, author:<login>, creator, qa-team or unknown" % (where, what))
    if ev["complete"] not in ("", "yes", "no"):
        raise PlanError("%s: %s complete must be yes, no or empty" % (where, what))
    links = []
    for el in ev["jira"].split(",") if ev["jira"] != "" else ():
        key, colon, st = el.partition(":")
        if not colon or not JIRA_KEY.fullmatch(key) or st == "":
            raise PlanError("%s: malformed %s jira element %r (want <KEY>:<status>)" % (where, what, el))
        links.append({"key": key, "status": pdec(st.encode("utf-8"), "%s %s jira status" % (where, what))})
    ev["jira"] = links
    return ev


def _encode_ev(ev, keys):
    """증거 dict(빠진 키 = 빈 값, jira = [{"key", "status"}] 또는 [(key, status)]) → 증거 칸 바이트(검증 전).
    모르는 키·str이 아닌 값(None·0·False 포함)·모양이 다른 jira 요소 = PlanError — 아무것도 ""로 바꿔 치우지 않는다."""
    if not isinstance(ev, dict) or set(ev) - set(keys):
        raise PlanError("evidence must be a dict with keys from %s" % " ".join(keys))
    vals = []
    for k in keys:
        if k == "jira":
            links = []
            if not isinstance(ev.get("jira", []), (list, tuple)):
                raise PlanError("evidence jira must be a list")
            for j in ev.get("jira", []):
                pair = (j.get("key"), j.get("status")) if isinstance(j, dict) and set(j) == {"key", "status"} \
                    else tuple(j) if isinstance(j, (tuple, list)) and len(j) == 2 else (None, None)
                if not all(isinstance(x, str) for x in pair):
                    raise PlanError("evidence jira element must be {key, status} or (key, status) of str: %r" % (j,))
                links.append(pair[0] + ":" + penc(pair[1]).decode("utf-8"))
            v = ",".join(links)
        else:
            v = ev.get(k, "")
            if not isinstance(v, str):
                raise PlanError("evidence %s must be str, not %s" % (k, type(v).__name__))
        vals.append(k + "=" + penc(v).decode("utf-8"))
    return penc(";".join(vals))


def decode_jira_evidence(raw, where="evidence"):
    """tier-3 jira#<KEY> 행의 증거 칸 바이트 → {"v", "reason", "known", "missing", "owner", "decider", "recommend",
    "cites", "complete", "jira": [{"key", "status"}]}. 칸 = penc("v=<penc>;reason=<penc>;…;jira=<penc>")(두 번 디코딩).
    v ∈ JIRA_VERDICTS, 나머지 필드 규칙 = _verdict_fields."""
    return _verdict_fields(_pairs(raw, where, JIRA_EV_KEYS, "jira evidence"), where, "jira evidence", JIRA_VERDICTS)


def encode_jira_evidence(ev):
    """decode_jira_evidence의 역: dict(빠진 키 = 빈 값, jira = [{"key", "status"}] 또는 [(key, status)]) → 증거 칸 바이트.
    결과를 decode_jira_evidence로 다시 읽어 검증한다(형식에 안 맞으면 PlanError)."""
    raw = _encode_ev(ev, JIRA_EV_KEYS)
    decode_jira_evidence(raw, "encode_jira_evidence")
    return raw


def decode_unit_evidence(raw, where="evidence"):
    """tier-3 pr#N / issue#N 행의 구조형 증거 칸 바이트 → {"t", "v", "reason", "known", "missing", "owner", "decider",
    "recommend", "cites", "complete", "jira": [{"key", "status"}]}. 칸 = penc("t=<penc>;v=<penc>;…;jira=<penc>")
    (키 = t + JIRA_EV_KEYS 이 순서, 두 번 디코딩). t(제목) 필수, v ∈ UNIT_VERDICTS(NOT-JUDGED = 최근 행 — reason에 이유),
    나머지 필드 규칙 = Jira 단위와 같다(_verdict_fields)."""
    ev = _pairs(raw, where, UNIT_EV_KEYS, "unit evidence")
    if ev["t"] == "":
        raise PlanError("%s: unit evidence t (title) is empty" % where)
    return _verdict_fields(ev, where, "unit evidence", UNIT_VERDICTS)


def encode_unit_evidence(ev):
    """decode_unit_evidence의 역 → 증거 칸 바이트(검증 포함)."""
    raw = _encode_ev(ev, UNIT_EV_KEYS)
    decode_unit_evidence(raw, "encode_unit_evidence")
    return raw


def optional_last_key(action, ref):
    """그 행의 snapshot 끝에만 올 수 있는 선택 키: close-pr/close-issue = title, tier-3 pr#N/issue#N = verdict, 그 밖 = None."""
    if action in CLOSE_ACTIONS:
        return "title"
    if action == "report" and (PR_REF.fullmatch(ref) or ISSUE_REF.fullmatch(ref)):
        return "verdict"
    return None


def unit_row(action, ref, s, ev_raw, where):
    """tier-3 pr#N / issue#N 행의 snapshot에 verdict 키가 있으면 증거 = 구조형(decode_unit_evidence, v == verdict) →
    row["unit"] = {"kind": "pr" | "issue", "number", "evidence"}. verdict가 없으면 증거는 언제나 날것 제목(내용이 어떻게
    생겼든 — 제목은 남이 쓴 글이라 판정 표지가 될 수 없다) → None."""
    if action != "report" or "verdict" not in s:
        return None
    m, kind = PR_REF.fullmatch(ref), "pr"
    if not m:
        m, kind = ISSUE_REF.fullmatch(ref), "issue"
    ev = decode_unit_evidence(ev_raw, where)
    if ev["v"] != s["verdict"]:
        raise PlanError("%s: unit evidence v %s differs from snapshot verdict %s" % (where, ev["v"], s["verdict"]))
    return {"kind": kind, "number": int(m.group(1)), "evidence": ev}


def decode_inventory_evidence(raw, where="evidence"):
    """tier-3 jira#<PROJECT> 행의 증거 칸 바이트 → {"total": int, "jql", "site"}. 칸 = penc("total=<n>;jql=<penc>;site=<penc>")."""
    ev = _pairs(raw, where, INV_KEYS, "inventory evidence")
    if not re.fullmatch(r"0|[1-9][0-9]*", ev["total"]):
        raise PlanError("%s: inventory evidence total must be a number" % where)
    if ev["jql"] == "":
        raise PlanError("%s: inventory evidence jql is empty" % where)
    if not JIRA_SITE.fullmatch(ev["site"]):
        raise PlanError("%s: inventory evidence site must be a host name" % where)
    return {"total": int(ev["total"]), "jql": ev["jql"], "site": ev["site"]}


def encode_inventory_evidence(total, jql, site):
    """decode_inventory_evidence의 역 → 증거 칸 바이트(검증 포함; total = int ≥ 0(bool 아님), jql·site = str)."""
    if type(total) is not int or total < 0 or not isinstance(jql, str) or not isinstance(site, str):
        raise PlanError("encode_inventory_evidence: total must be an int >= 0, jql and site str")
    raw = penc(";".join(k + "=" + penc(v).decode("utf-8") for k, v in zip(INV_KEYS, (str(total), jql, site))))
    decode_inventory_evidence(raw, "encode_inventory_evidence")
    return raw


def check_jira_binding(rows, site, project, qa_status=None, closed_status=None):
    """spec-v4 §C 바인딩 검사(repos.md jira=<site>/<PROJECT> jira-qa=<id> jira-closed=<id>) — 계획에는 바인딩이 없어서
    parse_plan은 부르지 않는다. 바인딩을 아는 호출자(판정 build, apply 전 recheck)가 parse_plan 결과에 부른다.
    모든 Jira 행 project = 바인딩 project, inventory·실행 행 site = 바인딩 site, TO-QA to_status = jira-qa,
    TO-CLOSED to_status = jira-closed(바인딩에 없으면 그 level 행은 거절). move-issue 행: project·site = 바인딩."""
    for r in rows:
        j, mv = r.get("jira"), r.get("move")
        if mv is not None:
            where = "line %d" % r["line"]
            if mv["project"] != project:
                raise PlanError("%s: move-issue %s targets Jira project %s, not the bound Jira project %s" % (
                    where, r["ref"], mv["project"], project))
            if mv["site"] != site:
                raise PlanError("%s: Jira site %s is not the bound site %s" % (where, mv["site"], site))
            continue
        if j is None:
            continue
        where = "line %d" % r["line"]
        if j["project"] != project:
            raise PlanError("%s: %s is not in the bound Jira project %s" % (where, r["ref"], project))
        row_site = j["site"] if j["kind"] == "inventory" else r["snapshot"]["site"] if j["kind"] == "transition" else site
        if row_site != site:
            raise PlanError("%s: Jira site %s is not the bound site %s" % (where, row_site, site))
        if j["kind"] == "transition":
            want = qa_status if j["level"] == "TO-QA" else closed_status
            if want is None or r["snapshot"]["to_status"] != want:
                raise PlanError("%s: %s to_status %s is not the bound %s %s" % (
                    where, j["level"], r["snapshot"]["to_status"],
                    "jira-qa" if j["level"] == "TO-QA" else "jira-closed", want if want is not None else "(not bound)"))


# ───────────────────────── v4.3 move-issue 행 (GitHub 이슈 → 바인딩 Jira 프로젝트의 새 티켓, design v9 §1 R6·§2·§4) ─────────────────────────

def check_move_issue(ref, x, s, ev_raw, where):
    """tier-2 move-issue 행(키 집합은 parse_plan이 이미 확인) → row["move"]. x = expected(디코딩 안 함, GitHub updatedAt),
    s = 디코딩한 snapshot, ev_raw = 증거 칸 바이트(구조형 reason;gh;related — decode_move_evidence). 검사 순서 = 모듈 docstring.
    author는 비어도 된다(GitHub가 지워진 계정을 작성자 없음으로 준다 — close-issue도 요구하지 않는다).
    반환 {"number", "site", "project", "project_id", "issuetype", "issuetype_name", "account", "gh_login", "source_sha",
    "payload_sha", "adopt": KEY | None, "prior": {"cid", "csha"} | None, "reason", "gh", "related": [KEY…], "plan_date"}
    (cid = 숫자 문자열; plan_date = gh 표지 줄의 날짜 YYYY-MM-DD — 계획에 따로 적지 않는 payload 재생성의 유일한 날짜 출처:
    move_payload / move_description은 언제나 row["move"]["plan_date"]로 부른다). id(project_id·issuetype·prior cid) = [1-9][0-9]*."""
    def bad(msg):
        raise PlanError("%s: %s" % (where, msg))
    if not iso_ok(x):
        bad("move-issue expected must be the ISO updatedAt")
    if s["state"] != "OPEN":
        bad("snapshot state must be OPEN")
    if s["updated"] != x:
        bad("snapshot updated differs from expected")
    for k in ("title", "account", "gh_login", "issuetype_name"):
        if s[k] == "":
            bad("move-issue snapshot %s must not be empty" % k)
    if not JIRA_SITE.fullmatch(s["site"]):
        bad("snapshot site must be a host name")
    if not JIRA_PROJECT.fullmatch(s["project"]):
        bad("move-issue snapshot project must be a Jira project key [A-Z][A-Z0-9]+")
    for k in ("project_id", "issuetype"):
        if not PR_NUM.fullmatch(s[k]):
            bad("move-issue snapshot %s must be a numeric id [1-9][0-9]* (no 0, no leading zero)" % k)
    for k in ("source_sha", "payload_sha"):
        if not HEX64.fullmatch(s[k]):
            bad("move-issue snapshot %s must be a sha256 (64 lowercase hex)" % k)
    adopt = None
    if s["adopt"] != "-":
        if not JIRA_KEY.fullmatch(s["adopt"]):
            bad("move-issue snapshot adopt must be - or a Jira key")
        if s["adopt"].rsplit("-", 1)[0] != s["project"]:
            bad("move-issue snapshot adopt %s is not in project %s" % (s["adopt"], s["project"]))
        adopt = s["adopt"]
    prior = None
    if s["prior"] != "-":
        cid, colon, csha = s["prior"].partition(":")
        if not colon or not PR_NUM.fullmatch(cid) or not HEX64.fullmatch(csha):
            bad("move-issue snapshot prior must be - or <comment id [1-9][0-9]*>:<sha256 hex>")
        if adopt is None:
            bad("move-issue snapshot prior needs adopt (a recorded migration comment points at an adopted ticket)")
        prior = {"cid": cid, "csha": csha}
    ev = decode_move_evidence(ev_raw, where, s["project"])
    out = {"number": int(ISSUE_REF.fullmatch(ref).group(1))}
    out.update((k, s[k]) for k in ("site", "project", "project_id", "issuetype", "issuetype_name", "account", "gh_login",
                                   "source_sha", "payload_sha"))
    out.update(adopt=adopt, prior=prior, reason=ev["reason"], gh=ev["gh"], related=ev["related"],
               plan_date=MARKER.fullmatch(ev["gh"].split("\n")[-1]).group(2))
    return out


def _check_move_gh(gh, where):
    """move-issue 증거 gh = GitHub에 달 승인 댓글 틀(정규형): 비지 않음 · CR 없음(줄 끝 LF만) · \\n \\t 외 제어 문자 없음
    · 끝 개행 없음 · {KEY} 정확히 2번(키, 링크 끝 — comment_body가 바꾼다) · 마지막 줄 = MARKER, group1 == MOVE_GH_MARKER,
    날짜 = 달력에 있는 날(그 날짜가 행의 plan_date). → 그 날짜."""
    def bad(msg):
        raise PlanError("%s: move evidence gh %s" % (where, msg))
    if gh == "":
        bad("(the GitHub comment) is empty")
    if "\r" in gh:
        bad("contains a CR (line ends must be LF only)")
    cc = BAD_COMMENT.search(gh)
    if cc:
        bad("contains control character U+%04X (only \\n and \\t are allowed in a posted comment)" % ord(cc.group()))
    if gh.endswith("\n"):
        bad("must not end with a newline")
    if gh.count("{KEY}") != 2:
        bad("must contain {KEY} exactly twice (the key and the link end), found %d" % gh.count("{KEY}"))
    mk = MARKER.fullmatch(gh.split("\n")[-1])
    if not mk:
        bad("must end with the marker line 'chore 정리 → %s — by Claude triage YYYY-MM-DD'" % MOVE_GH_MARKER)
    if mk.group(1) != MOVE_GH_MARKER:
        bad("marker names %r, not %r" % (mk.group(1), MOVE_GH_MARKER))
    if not iso_ok(mk.group(2) + "T00:00:00Z"):
        bad("marker date %s is not a calendar day (it is the plan date the payload is rebuilt with)" % mk.group(2))
    return mk.group(2)


def decode_move_evidence(raw, where="evidence", project=None):
    """move-issue 행의 증거 칸 바이트 → {"reason", "gh", "related": [KEY…]}. 칸 = penc("reason=<penc>;gh=<penc>;related=<penc>")
    (키 = MOVE_EV_KEYS 이 순서, 두 번 디코딩 — _pairs). reason 필수, gh = _check_move_gh, related = "-"(없음) 또는 서로 다른
    Jira 키의 쉼표 목록. project를 주면 related 키마다 그 프로젝트 키여야 한다(adopt와 같은 규칙; check_move_issue가 준다)."""
    ev = _pairs(raw, where, MOVE_EV_KEYS, "move evidence")
    if ev["reason"] == "":
        raise PlanError("%s: move evidence reason is empty" % where)
    _check_move_gh(ev["gh"], where)
    related = []
    for key in ev["related"].split(",") if ev["related"] != "-" else ():
        if not JIRA_KEY.fullmatch(key):
            raise PlanError("%s: malformed move evidence related element %r (want - or <KEY>,<KEY>…)" % (where, key))
        if key in related:
            raise PlanError("%s: duplicate move evidence related key %s" % (where, key))
        if project is not None and key.rsplit("-", 1)[0] != project:
            raise PlanError("%s: move evidence related key %s is not in project %s" % (where, key, project))
        related.append(key)
    return {"reason": ev["reason"], "gh": ev["gh"], "related": related}


def encode_move_evidence(ev):
    """decode_move_evidence의 역: {"reason": str, "gh": str, "related": [KEY…](빠지면 [])} → 증거 칸 바이트. 결과를 되읽어
    입력과 같은지 확인한다(형식 오류·왕복 불일치 = PlanError; 프로젝트 검사는 행을 읽을 때)."""
    if not isinstance(ev, dict) or set(ev) - set(MOVE_EV_KEYS):
        raise PlanError("evidence must be a dict with keys from %s" % " ".join(MOVE_EV_KEYS))
    rel = ev.get("related", [])
    if not isinstance(rel, (list, tuple)) or not all(isinstance(k, str) for k in rel):
        raise PlanError("evidence related must be a list of Jira keys (str)")
    raw = _encode_ev(dict(ev, related=",".join(rel) if rel else "-"), MOVE_EV_KEYS)
    back = decode_move_evidence(raw, "encode_move_evidence")
    if back["related"] != list(rel):
        raise PlanError("encode_move_evidence: related does not round-trip (%r)" % (rel,))
    return raw


def _plan_date(d, what):
    if not isinstance(d, str) or not iso_ok(d + "T00:00:00Z"):
        raise PlanError("%s: plan date must be YYYY-MM-DD (a real calendar day), not %r" % (what, d))


def move_comment(site, reason, plan_date):
    """기본 승인 댓글 틀(gh) 4줄: 키·링크 줄 · 남기는 이유(줄바꿈 → 공백, 그 밖 제어 문자 제거 = 한 줄) · 안내 · MARKER(Jira로 옮김).
    {KEY}는 comment_body가 실제 키로 바꾼다. 결과는 계획 검사(_check_move_gh)를 통과해야 한다 — reason에 {KEY}가 들어 있으면 거절."""
    if not isinstance(site, str) or not JIRA_SITE.fullmatch(site):
        raise PlanError("move_comment: site must be a host name, not %r" % (site,))
    if not isinstance(reason, str):
        raise PlanError("move_comment: reason must be str")
    one = BAD_COMMENT.sub("", re.sub(r"\r\n|\r|\n", " ", reason)).strip()
    if one == "":
        raise PlanError("move_comment: reason is empty")
    _plan_date(plan_date, "move_comment")
    gh = "\n".join(("이 이슈는 Jira {KEY}로 옮겼습니다: https://%s/browse/{KEY}" % site, "남기는 이유: %s" % one,
                    "이후 진행은 Jira 티켓에서 이어갑니다. 이 이슈는 닫습니다.", MARKER_FMT % (MOVE_GH_MARKER, plan_date)))
    _check_move_gh(gh, "move_comment")
    return gh


def comment_body(gh, key):
    """승인 댓글 틀 → 실제로 게시하는 본문({KEY} 두 자리를 그 키로)."""
    if not isinstance(gh, str) or not isinstance(key, str) or not JIRA_KEY.fullmatch(key):
        raise PlanError("comment_body: gh must be str and key a Jira key, not %r" % (key,))
    return gh.replace("{KEY}", key)


def migration_comment(body, author, gh_login):
    """이관 기록 댓글 술어(design §4): 작성자 == gh_login · 마지막 줄(끝 CR 뗌)이 MARKER · group1 == MOVE_GH_MARKER.
    기존 chore 닫기 댓글(group1이 다름)은 보통 댓글이다 — 원문에 들어가고 설명 블록 9로 옮겨진다."""
    if not isinstance(body, str) or not isinstance(gh_login, str) or gh_login == "" or author != gh_login:
        return False
    mk = MARKER.fullmatch(body.split("\n")[-1].rstrip("\r"))
    return bool(mk) and mk.group(1) == MOVE_GH_MARKER


def canon_json(obj, what="canon_json"):
    """정규 JSON 바이트 하나(키 정렬 · 구분자 , : · 공백 없음 · UTF-8 날것) — payload 바이트의 인코더 한 벌: source_sha와 POST
    본문(payload_sha)이 같은 규칙이고, 읽는 쪽은 json.loads 한 값을 이것으로 다시 인코딩해 같은 바이트면 정규형이다."""
    try:
        return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as e:
        raise PlanError("%s: not encodable as canonical JSON (%s)" % (what, e))


_canon_json = canon_json   # 옛 이름(chore-jira.py·render 테스트가 (obj, what)로 부른다)


def _move_issue(issue, what):
    """move_* 입력 이슈 → 정규 dict {"number", "title", "body", "author", "created", "labels", "comments"}. 입력 = {"number": int,
    "title": str, "body": str | None, "author": str | None, "created": str, "labels": [str], "comments": [{"author", "created",
    "body"}]}(옮길 댓글 = 기록된 이관 댓글을 뺀 것, 오래된 순 — 호출자 책임). body None → "", author "" → None(지워진
    계정), 그 밖 키는 보지 않는다. 같은 바이트 보증의 전제 = build와 apply가 둘 다 writer의 REST 읽기(chore-jira.py
    gh_issue: issues/N + 댓글 전 페이지)로 이 dict를 만든다는 것 — GraphQL 읽기는 봇·지워진 계정의 작성자 모양이 달라
    source_sha가 깨진다."""
    def bad(msg):
        raise PlanError("%s: issue %s" % (what, msg))
    if not isinstance(issue, dict):
        bad("must be a dict")
    for k in ("number", "title", "body", "author", "created", "labels", "comments"):
        if k not in issue:
            bad("lacks %r" % k)
    n = issue["number"]
    if type(n) is not int or n <= 0:
        bad("number must be a positive int")

    def text(v, k, nullable):
        if v is None and nullable:
            return ""
        if not isinstance(v, str):
            bad("%s must be str%s" % (k, " or None" if nullable else ""))
        return v

    def who(v, k):
        if v is not None and not isinstance(v, str):
            bad("%s must be a login (str) or None" % k)
        return v or None
    if not isinstance(issue["labels"], (list, tuple)) or not all(isinstance(x, str) for x in issue["labels"]):
        bad("labels must be a list of str")
    if not isinstance(issue["comments"], (list, tuple)):
        bad("comments must be a list")
    comments = []
    for i, c in enumerate(issue["comments"]):
        if not isinstance(c, dict) or not {"author", "created", "body"} <= set(c):
            bad("comment %d must be a dict with author, created, body" % i)
        comments.append({"author": who(c["author"], "comment %d author" % i),
                         "created": text(c["created"], "comment %d created" % i, False),
                         "body": text(c["body"], "comment %d body" % i, True)})
    return {"number": n, "title": text(issue["title"], "title", False), "body": text(issue["body"], "body", True),
            "author": who(issue["author"], "author"), "created": text(issue["created"], "created", False),
            "labels": sorted(issue["labels"]), "comments": comments}


def source_json(issue):
    """자르기 전 원문 전체의 정규 JSON 바이트(design §2 source_sha): {"title", "body", "labels"(정렬), "comments": [{"author",
    "created", "body"}](옮길 댓글 전부, 오래된 순)}. 텍스트는 받은 그대로(정규화 없음 — 비교용이다)."""
    it = _move_issue(issue, "source_json")
    return _canon_json({"title": it["title"], "body": it["body"], "labels": it["labels"], "comments": it["comments"]},
                       "source_json")


def source_sha(issue):
    """sha256 hex of source_json(issue)."""
    return hashlib.sha256(source_json(issue)).hexdigest()


def _len16(s):
    """글 길이 = UTF-16 코드 단위(Jira의 글자 수 — BMP 밖 문자 하나 = 2)."""
    return len(s) + sum(1 for ch in s if ord(ch) > 0xFFFF)


def _ser16(obj):
    """MOVE_CAP의 잣대: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))의 UTF-16 단위 길이(키 순서와 무관)."""
    return _len16(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def _json16(ch):
    """글자 하나가 json.dumps(ensure_ascii=False) 문자열 안에서 차지하는 UTF-16 단위: " \\ 와 \\n \\r \\t \\b \\f = 2,
    그 밖 0x00–0x1F = 6(\\u00XX), BMP 밖 = 2, 나머지 = 1 (json 모듈 ESCAPE 규칙 그대로)."""
    if ch in '"\\\n\r\t\b\f':
        return 2
    o = ord(ch)
    return 6 if o < 0x20 else 2 if o > 0xFFFF else 1


def _cut_json16(s, n):
    """직렬화하면 n 단위 이하인 가장 긴 앞부분(글자 사이에서만 자른다)."""
    units = 0
    for i, ch in enumerate(s):
        units += _json16(ch)
        if units > n:
            return s[:i]
    return s


def _cut16(s, n):
    """UTF-16 단위로 n 이하인 가장 긴 앞부분(서로게이트 쌍을 가르지 않는다)."""
    units = 0
    for i, ch in enumerate(s):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > n:
            return s[:i]
    return s


def move_summary(title):
    """Jira 요약 = 제목에서 줄바꿈·탭 → 공백, 그 밖 C0 제어 문자·DEL 제거, 앞뒤 공백 제거, SUMMARY_MAX자로 자름(UTF-16 단위로
    세어 서로게이트 쌍을 가르지 않는다 — 코드 포인트로도 언제나 ≤ SUMMARY_MAX), 자른 끝의 공백도 뗀다. 비면 PlanError."""
    if not isinstance(title, str):
        raise PlanError("move_summary: title must be str")
    s = _cut16(re.sub(r"[\x00-\x1f\x7f]", "", re.sub(r"[\r\n\t]", " ", title)).strip(), SUMMARY_MAX).rstrip()
    if s == "":
        raise PlanError("move_summary: the title is empty after removing control characters")
    return s


def _adf_norm(s):
    """ADF 글 정규화(생성할 때만 — 비교에는 절대 쓰지 않는다): CRLF·CR → LF, \\t \\n 외 C0 제어 문자와 DEL 제거."""
    return BAD_COMMENT.sub("", s.replace("\r\n", "\n").replace("\r", "\n"))


def _adf_inline(text):
    """한 블록의 글 → inline 노드 목록: "\\n" 자리마다 hardBreak, 그 사이 글 = text 노드(빈 text 노드는 만들지 않는다)."""
    nodes = []
    for i, seg in enumerate(text.split("\n")):
        if i:
            nodes.append({"type": "hardBreak"})
        if seg:
            nodes.append({"type": "text", "text": seg})
    if not nodes:
        raise PlanError("ADF: empty block text (Jira refuses an empty text node)")
    return nodes


def _adf_para(text):
    return {"type": "paragraph", "content": _adf_inline(text)}


def _adf_heading(text):
    return {"type": "heading", "attrs": {"level": 3}, "content": _adf_inline(text)}


def _adf_code(text):
    return {"type": "codeBlock", "content": [{"type": "text", "text": text}]}


_ADF_BUILD = {"paragraph": _adf_para, "heading": _adf_heading, "codeBlock": _adf_code}


def _adf_node(block):
    """(kind, text) 하나 → ADF 블록 노드 (doc_from_blocks와 move_description의 크기 계산이 같은 노드를 쓴다)."""
    if not isinstance(block, (tuple, list)) or len(block) != 2 or block[0] not in _ADF_BUILD or not isinstance(block[1], str):
        raise PlanError("doc_from_blocks: block %r is not (paragraph | heading | codeBlock, text)" % (block,))
    if block[0] == "codeBlock" and block[1] == "":
        raise PlanError("doc_from_blocks: empty codeBlock text (Jira refuses an empty text node)")
    return _ADF_BUILD[block[0]](block[1])


def doc_from_blocks(blocks):
    """parse_blocks(엄격)의 정확한 역(move 설명): [(kind, text)] → ADF doc {"type": "doc", "version": 1, "content": [...]}.
    paragraph·heading(level 3 — move 설명의 heading은 모두 3)의 "\\n" = hardBreak, 그 사이 글 = text 노드, codeBlock = text
    노드 하나. move_description이 이 함수로 doc를 만든다 — 저장된 티켓의 엄격 블록에서 다시 만든 doc가 생성한 doc와 같은
    바이트가 되는 한 벌(payload_bytes와 함께 payload를 다시 만드는 길). "other"(관대한 읽기)·빈 글·모르는 종류 = PlanError."""
    if not isinstance(blocks, (list, tuple)):
        raise PlanError("doc_from_blocks: blocks must be a list of (kind, text)")
    return {"type": "doc", "version": 1, "content": [_adf_node(b) for b in blocks]}


def move_url_line(repo_url, n):
    """설명 블록 1의 정확한 글 — 이 티켓이 어느 이슈에서 왔는지(chore 모양 티켓은 이 줄로만 가리킨다)."""
    return "GitHub 이슈에서 옮김: %s/issues/%d" % (repo_url, n)


def _move_args(repo_url, reason, related, plan_date, what):
    if not isinstance(repo_url, str) or not HTTPS_URL.fullmatch(repo_url) or repo_url.endswith("/"):
        raise PlanError("%s: repo_url must be an https URL without a trailing / (https://github.com/<owner>/<repo>)" % what)
    if not isinstance(reason, str) or reason == "":
        raise PlanError("%s: reason must be a non-empty str" % what)
    if not isinstance(related, (list, tuple)) or not all(isinstance(k, str) and JIRA_KEY.fullmatch(k) for k in related) \
            or len(set(related)) != len(related):
        raise PlanError("%s: related must be a list of distinct Jira keys" % what)
    _plan_date(plan_date, what)


def move_description(issue, repo_url, reason, related, plan_date):
    """새 티켓 설명(ADF) → (doc, trunc). 블록 순서 고정(design §1 R6): 1 옮김 URL · 2 제목 · 3 작성·라벨·댓글 수 · 4 남기는 이유 ·
    5 관련(있을 때만) · 6 heading 본문 · 7 codeBlock 본문 · 8 heading 댓글(실은 댓글이 있을 때만) · 9 댓글마다 머리 문단 + codeBlock ·
    10 잘림 안내(잘렸을 때만) · 11 표지 MARKER(GitHub issue #N, 계획 날짜 = row["move"]["plan_date"]).
    상한 = 저장 형태 하나(U1 리뷰 S1): doc를 json.dumps(doc, ensure_ascii=False, separators=(",", ":"))로 직렬화한 UTF-16 단위
    길이 ≤ MOVE_CAP(잘림 안내 블록 포함 — 따옴표·줄바꿈·노드 틀까지 세므로 짧은 댓글이 많거나 본문이 따옴표·줄바꿈투성이여도
    Jira 설명 한도 32,767을 넘지 않는다). 채우는 순서: 고정 블록(1–5, heading 본문, 11) → 본문 → 댓글마다 머리 문단 + codeBlock
    (첫 댓글은 heading 댓글도), 오래된 순. 전부 들어가면 안내 없음; 아니면 안내가 들어갈 자리를 남기고 들어가지 않는 첫 댓글과
    그 뒤 댓글을 모두 뺀다; 고정 블록 + 본문 + 안내가 넘으면 본문을 남은 만큼(JSON 이스케이프 후 단위)에서 자르고 댓글 0개.
    고정 블록 + 빈 본문 + 안내만으로 넘으면 PlanError.
    trunc = {"body_cut", "comments_total" (= k = 옮길 댓글 수), "comments_included"}."""
    it = _move_issue(issue, "move_description")
    _move_args(repo_url, reason, related, plan_date, "move_description")

    def who(a):
        return _adf_norm(a) if a else "(삭제된 계정)"
    no_body, no_text = "(본문 없음)", "(내용 없음)"
    comments = [("%s · %s" % (who(c["author"]), _adf_norm(c["created"])), _adf_norm(c["body"]).rstrip("\n") or no_text)
                for c in it["comments"]]
    k = len(comments)
    labels = _adf_norm(", ".join(it["labels"])) or "없음"
    head = [move_url_line(repo_url, it["number"]), "제목: " + _adf_norm(it["title"]),
            "작성: %s · %s · 라벨: %s · 댓글 %d개" % (who(it["author"]), _adf_norm(it["created"]), labels, k),
            "남기는 이유: " + _adf_norm(reason)] + (["관련: " + ", ".join(related)] if related else [])
    marker = MARKER_FMT % ("GitHub issue #%d" % it["number"], plan_date)

    def notice(cut, j):
        return ("paragraph", MOVE_NOTICE + ("본문 잘림 · " if cut else "") + "댓글 %d개 안 실음" % j)

    def cost(block):         # one more block in the content list = its serialized node + the "," before it
        return _ser16(_adf_node(block)) + 1
    fixed = [("paragraph", t) for t in head] + [("heading", "본문"), ("paragraph", marker)]
    used = _ser16({"type": "doc", "version": 1, "content": []}) + sum(cost(b) for b in fixed) - 1
    code0 = _ser16(_adf_code("")) + 1                 # a code block's frame, without its text
    if used + code0 + sum(map(_json16, no_body)) + cost(notice(True, k)) > MOVE_CAP:
        raise PlanError("move_description: the fixed blocks (title, reason, related, marker) do not fit under MOVE_CAP")
    body = _adf_norm(it["body"]).rstrip("\n") or no_body
    cblocks = [(("paragraph", hd), ("codeBlock", code)) for hd, code in comments]
    ccost = [cost(h) + cost(c) + (cost(("heading", "댓글")) if i == 0 else 0) for i, (h, c) in enumerate(cblocks)]
    left = MOVE_CAP - used - cost(("codeBlock", body))
    cut, n_in = False, 0
    if sum(ccost) <= left:                               # everything fits: no notice
        n_in = k
    elif cost(notice(False, k)) <= left:                 # the body fits: whole comments while the notice still fits
        while n_in < k and ccost[n_in] + (cost(notice(False, k - n_in - 1)) if n_in + 1 < k else 0) <= left:
            left -= ccost[n_in]
            n_in += 1
    else:                                                # cut the body to what the fixed blocks and the notice leave
        cut = True
        room = MOVE_CAP - used - code0 - cost(notice(True, k))
        body = _cut_json16(body, room).rstrip("\n") or no_body
    blocks = fixed[:-1] + [("codeBlock", body)]
    if n_in:
        blocks.append(("heading", "댓글"))
        for h, c in cblocks[:n_in]:
            blocks += [h, c]
    if cut or n_in < k:
        blocks.append(notice(cut, k - n_in))
    blocks.append(fixed[-1])
    doc = doc_from_blocks(blocks)
    if _ser16(doc) > MOVE_CAP:                          # the accounting above is exact; this only guards a regression
        raise PlanError("move_description: serialized description %d > MOVE_CAP %d" % (_ser16(doc), MOVE_CAP))
    return doc, {"body_cut": cut, "comments_total": k, "comments_included": n_in}


def move_payload(issue, repo_url, snap, reason, related, plan_date):
    """새 티켓 POST 본문 바이트(이 바이트 그대로 보낸다; payload_sha = sha256 hex) → (bytes, trunc). 정규 JSON(_canon_json)
    {"fields": {"project": {"id": project_id}, "issuetype": {"id": issuetype}, "summary": move_summary(제목),
    "reporter": {"id": account}, "assignee": null, "description": move_description(…)}}. assignee는 명시적 null — 빼면
    프로젝트 기본 담당자(PROJECT_LEAD)에게 배정된다(design §10f ①). 라벨은 없다(바인딩 프로젝트에 labels 필드가 없음, §10f ②).
    snap = 그 행의 snapshot(project_id·issuetype·account만 읽는다). 계획 행에서 다시 만들 때(apply·verify의 payload_sha 대조)는
    reason·related·plan_date = row["move"]의 reason·related·plan_date(plan_date = gh 표지 날짜 — 계획에 따로 없다)."""
    doc, trunc = move_description(issue, repo_url, reason, related, plan_date)
    if not isinstance(snap, dict) or not all(isinstance(snap.get(k), str) for k in ("project_id", "issuetype", "account")):
        raise PlanError("move_payload: snap needs project_id, issuetype and account (str)")
    return payload_bytes(snap["project_id"], snap["issuetype"], move_summary(issue["title"]), snap["account"], doc), trunc


def payload_bytes(project_id, issuetype_id, summary, account, doc):
    """새 티켓 POST 본문 바이트 — 필드 집합의 유일한 정의: canon_json({"fields": {"project": {"id": project_id}, "issuetype":
    {"id": issuetype_id}, "summary": summary, "reporter": {"id": account}, "assignee": null, "description": doc}}). 라벨 없음,
    assignee는 명시적 null(§10f). move_payload가 이것으로 만들고, 저장된 티켓에서 다시 만드는 쪽(chore-jira.py rebuilt_payload)은
    payload_bytes(…, 요약, …, doc_from_blocks(parse_blocks(설명)))로 같은 바이트를 얻는다 — 사본 필드 집합은 두지 않는다."""
    if not all(isinstance(x, str) for x in (project_id, issuetype_id, summary, account)) or not isinstance(doc, dict):
        raise PlanError("payload_bytes: project_id, issuetype_id, summary and account must be str, doc a dict")
    if not PR_NUM.fullmatch(project_id) or not PR_NUM.fullmatch(issuetype_id) or account == "" or summary == "":
        raise PlanError("payload_bytes: project_id / issuetype_id must be numeric ids [1-9][0-9]*, account and summary non-empty")
    fields = {"project": {"id": project_id}, "issuetype": {"id": issuetype_id}, "summary": summary,
              "reporter": {"id": account}, "assignee": None, "description": doc}
    return canon_json({"fields": fields}, "payload_bytes")


ADF_BLOCKS = ("heading", "paragraph", "codeBlock")


ADF_INLINE = frozenset(("text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status", "mediaInline", "placeholder",
                        "inlineExtension"))


def _adf_flatten(node):
    """모르는 노드 → 글(관대한 읽기용; chore-jira.py flatten과 같은 규칙): text → 글, hardBreak → "\\n", mention·status →
    attrs.text, emoji → attrs.text | shortName, inlineCard → attrs.url, date → attrs.timestamp, 그 밖 = 자식(인라인뿐이면
    이어 붙이고, 아니면 "\\n"으로)."""
    if not isinstance(node, dict):
        return ""
    kind, attrs = node.get("type"), node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    if kind == "text":
        return node["text"] if isinstance(node.get("text"), str) else ""
    if kind == "hardBreak":
        return "\n"
    if kind in ("mention", "status"):
        return str(attrs.get("text") or "")
    if kind == "emoji":
        return str(attrs.get("text") or attrs.get("shortName") or "")
    if kind == "inlineCard":
        return str(attrs.get("url") or "")
    if kind == "date":
        return str(attrs.get("timestamp") or "")
    kids = [k for k in node.get("content", ()) if isinstance(k, dict)] if isinstance(node.get("content"), list) else []
    return ("" if all(k.get("type") in ADF_INLINE for k in kids) else "\n").join(_adf_flatten(k) for k in kids)


def parse_blocks(doc, lenient=False):
    """티켓 설명 ADF → [(kind, text)] (맨 위 블록마다; kind = heading | paragraph | codeBlock). inline: text → 그 글,
    hardBreak → "\\n", inlineCard → attrs.url. attrs·marks는 무시한다. move_description이 만든 문서는 생성한 글 그대로 돌아온다.
    엄격(기본, ticket_check의 블록 비교): 그 밖 노드 종류·모양이 틀린 블록 = PlanError(예상 밖 = 불일치로 읽히게).
    lenient=True(후보 분류 — chore_shaped·points_at·ours_shape에 줄 블록): 그런 블록 = ("other", _adf_flatten(블록)) — 사람이
    중간에 목록을 넣어도 블록 1과 마지막 블록으로 우리 티켓을 알아본다(design §10f ⑦). 뿌리가 doc가 아니면 둘 다 PlanError."""
    if not isinstance(doc, dict) or doc.get("type") != "doc" or not isinstance(doc.get("content"), list):
        raise PlanError("ADF: not a doc with a content list")
    out = []
    for i, node in enumerate(doc["content"]):
        try:
            out.append(_parse_block(node, i))
        except PlanError:
            if not lenient:
                raise
            out.append(("other", _adf_flatten(node)))
    return out


def _parse_block(node, i):
    kind = node.get("type") if isinstance(node, dict) else None
    if kind not in ADF_BLOCKS:
        raise PlanError("ADF block %d: node type %r is not heading, paragraph or codeBlock" % (i + 1, kind))
    kids = node.get("content", [])
    if not isinstance(kids, list):
        raise PlanError("ADF block %d: content is not a list" % (i + 1))
    parts = []
    for kid in kids:
        t = kid.get("type") if isinstance(kid, dict) else None
        attrs = kid.get("attrs") if isinstance(kid, dict) else None
        if t == "text" and isinstance(kid.get("text"), str):
            parts.append(kid["text"])
        elif t == "hardBreak":
            parts.append("\n")
        elif t == "inlineCard" and isinstance(attrs, dict) and isinstance(attrs.get("url"), str):
            parts.append(attrs["url"])
        else:
            raise PlanError("ADF block %d: inline node %r is not text, hardBreak or inlineCard with a url" % (i + 1, t))
    return kind, "".join(parts)


def move_truncated(blocks):
    """설명에 잘림 안내(블록 10)가 있나 = MOVE_NOTICE로 시작하는 paragraph가 있다(승인 화면·최종 리포트가 머리 글을 베끼지 않고
    이 함수로 묻는다). blocks = parse_blocks(설명) 또는 parse_blocks(설명, lenient=True) — 사람이 블록을 끼워 넣어도 찾는다.
    다른 paragraph는 정해진 머리(블록 1–5)이거나 댓글 머리 "<로그인 | (삭제된 계정)> · <시각>"이라 이 머리로 시작할 수 없고,
    본문·댓글 원문은 codeBlock이라 세지 않는다."""
    return any(kind == "paragraph" and text.startswith(MOVE_NOTICE) for kind, text in blocks)


def chore_shaped(blocks):
    """chore가 만든 모양의 티켓: 마지막 블록이 MARKER 문단(누가·어느 이슈로 만들었든). 라벨은 조건이 아니다 — 바인딩
    프로젝트에 labels 필드가 없다(design §10f ②). blocks = parse_blocks(설명, lenient=True) — points_at·ours_shape도 같다."""
    return bool(blocks) and blocks[-1][0] == "paragraph" and bool(MARKER.fullmatch(blocks[-1][1]))


def points_at(blocks, repo_url, n):
    """출처 B 티켓이 이슈 n을 가리키나(design §4): chore 모양이면 블록 1이 정확히 move_url_line일 때만(설명 안에 인용된 다른
    이슈 URL은 무관), 아니면 블록 글 어디든 <repo_url>/issues/<n>이 숫자 경계로(뒤가 숫자 아님)나올 때."""
    if chore_shaped(blocks):
        return blocks[0] == ("paragraph", move_url_line(repo_url, n))
    url = re.compile(re.escape("%s/issues/%d" % (repo_url, n)) + r"(?![0-9])")
    return any(url.search(text) for _, text in blocks)


def ours_shape(blocks, reporter, acct, repo_url, n):
    """이 계정이 이 이슈를 옮긴 모양(design §5 (a) · §10f ②): 보고자 == acct · 마지막 블록 MARKER · 블록 1 = move_url_line.
    표지 group1·날짜는 보지 않는다(내용 비교는 ticket_check)."""
    return reporter == acct and chore_shaped(blocks) and blocks[0] == ("paragraph", move_url_line(repo_url, n))


# ───────────────────────── 인코딩 (pdec의 역) ─────────────────────────

def penc(text, sp=False):
    """pdec의 역(str → bytes): 정규 인코딩 하나뿐 — ESC(sp면 ESC_SP) 바이트만 %XX 대문자, 나머지 바이트는 날것.
    NUL은 pdec가 받지 않으므로(%00·날것 둘 다 거절) 인코딩할 수 없다 = PlanError."""
    if not isinstance(text, (str, bytes, bytearray)):
        raise PlanError("penc: value must be str or bytes, not %s" % type(text).__name__)
    try:
        raw = text.encode("utf-8") if isinstance(text, str) else bytes(text)
    except UnicodeEncodeError as e:
        raise PlanError("penc: text is not encodable as UTF-8 (%s)" % e)
    esc = ESC_SP if sp else ESC
    out = bytearray()
    for c in raw:
        if c == 0:
            raise PlanError("penc: NUL byte cannot be encoded")
        if c in esc:
            out += b"%%%02X" % c
        else:
            out.append(c)
    return bytes(out)


def encode_snapshot(snap):
    """parse_snapshot의 역: dict(삽입 순서 유지) → snapshot 칸 바이트(빈 dict = "-"). 키·값 = str(아니면 PlanError)."""
    if not isinstance(snap, dict):
        raise PlanError("encode_snapshot: snapshot must be a dict")
    if not snap:
        return b"-"
    return b";".join(penc(k) + b"=" + penc(v) for k, v in snap.items())


# ───────────────────────── CLI ─────────────────────────

def _fail(msg):
    """stderr 정확히 한 줄 + exit 1 (메시지 안의 줄바꿈은 \\n으로 — 엔진이 첫 줄만 읽어도 전부 보이게)."""
    line = "chore_plan: %s" % str(msg).replace("\r", "\\r").replace("\n", "\\n")
    sys.stderr.buffer.write(line.encode("utf-8", "backslashreplace") + b"\n")
    sys.stderr.flush()
    return 1


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="chore_plan", allow_abbrev=False,
                                 description="chore 정리 계획 TSV 검사 (scripts/chore_plan.py 문법 한 벌).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", allow_abbrev=False, help="parse_plan (+ check_jira_binding); 통과 = 출력 없이 exit 0")
    c.add_argument("plan", help="계획 TSV 경로")
    c.add_argument("--site", help="바인딩 Jira site (repos.md jira=<site>/<PROJECT>)")
    c.add_argument("--project", help="바인딩 Jira project")
    c.add_argument("--qa", help="바인딩 jira-qa 상태 id")
    c.add_argument("--closed", help="바인딩 jira-closed 상태 id")
    a = ap.parse_args(argv)
    if (a.site is None) != (a.project is None):
        c.error("--site and --project go together")
    if a.site is None and (a.qa is not None or a.closed is not None):
        c.error("--qa / --closed need --site and --project")
    try:
        with open(a.plan, "rb") as fh:
            data = fh.read()
    except OSError as e:
        return _fail("cannot read plan %r: %s" % (a.plan, e.strerror or e))
    try:
        _, rows = parse_plan(data)
        if a.site is not None:
            check_jira_binding(rows, a.site, a.project, a.qa, a.closed)
    except PlanError as e:
        return _fail(e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
