#!/usr/bin/env python3
"""chore-jira.py — chore 정리 엔진의 Jira REST 도우미 + Jira 행 apply/verify (chore v4 U1, 2026-10-19).

    python3 -I scripts/chore-jira.py --site example.atlassian.net <명령> ...      (HTTP 명령 9개)
    python3 -I scripts/chore-jira.py binding --repos-md F --remote owner/repo
    python3 -I scripts/chore-jira.py apply-rows --plan P --attempt A --journal J --lock L --parent-pid N
        --repos-md F --remote owner/repo --clone DIR --judge chore-judge.py [--repo X]
    python3 -I scripts/chore-jira.py verify-rows --plan P --results R --journal J --repos-md F --remote owner/repo
    python3 -I scripts/chore-jira.py resolve --repos-md F --remote owner/repo --clone DIR
        (--sid S (--found KEY | --not-created | --comment-found --cid C | --comment-not-posted)
         | --ref issue#N --key KEY --plan <run_id> --link)

v4.3 move-issue (design v9 §3–§8, 2026-10-21): apply-rows가 jira-transition 행들 다음에 move-issue 행(GitHub 이슈 → 바인딩
프로젝트의 새 티켓 → 이관 댓글 → 이슈 닫기)을 같은 프로세스·락·일지로 처리하고, verify-rows가 design §7 표로 확인하고,
resolve가 사람이 확인한 결과를 일지에 적는다. 공통 함수(판정 build도 경로로 읽어 그대로 부름): gh_login · gh_issue ·
move_history · source_b · live_candidates · created_by · ticket_check · issue_check · createmeta_ok.

HTTP 명령 (성공 = stdout에 JSON 문서 정확히 하나, UTF-8, 끝에 줄바꿈 하나):
  myself                          {"account"}
  view KEY                        {"id","key","project","status_id","status_name","updated","assignee"}
  transitions KEY                 [{"id","to_id","to_name"}]
  comments KEY                    [{"id","author","created","updated","text"}]  전 페이지, 모은 개수 == total
  changelog KEY [--since TS]      [{"created","author","field"}]  isLast까지 전 페이지, created > since (시각 비교)
  search --jql Q [--fields a,b]   [{"key","id","fields"}]  nextPageToken 전 페이지 (기본 필드 = SEARCH_FIELDS)
  evidence KEY                    {"key","id","summary","description_text","creator","created","updated",
                                   "status_id","status_name","assignee","labels","issuelinks"}
  comment KEY  < 본문             {"id","created"}  stdin UTF-8 → ADF (build_adf)
  transition KEY ID               {}
HTTP 명령 종료 코드: 0 ok · 2 사용법 · 3 쓰기 거부(HTTP 4xx 응답) · 4 쓰기 결과 미확정(5xx·3xx·시간 초과·연결
끊김 등 4xx 응답이 아닌 모든 쓰기 실패 — "거부"는 주장이고 "미확정"은 거짓말을 하지 않는다) · 5 인증(401/403
또는 자격 증명 없음, 고정 문구) · 6 읽기 실패/불완전(비-2xx, JSON 오류, 응답 형식, 페이지 불일치).
엔진 명령(binding/apply-rows/verify-rows)의 종료 코드는 아래 "엔진" 절 머리말.

- 자격 증명 = env JIRA_EMAIL / JIRA_API_TOKEN, 빈 것은 env CHORE_ENV_FILE이 가리키는 파일(KEY=VALUE 줄)에서 —
  CHORE_ENV_FILE이 없으면 파일을 읽지 않는다(정해 둔 .env 경로 없음).
  CHORE_JIRA_BASE(테스트용 전체 base URL, 예 http://127.0.0.1:PORT)가 있으면 env만 읽는다 — CHORE_ENV_FILE의
  실제 토큰이 가짜 서버로 가지 않게. CHORE_JIRA_TIMEOUT(초) = 테스트용 소켓 시간 제한(기본 30).
- stderr = 한 줄. URL·토큰·Authorization 헤더를 찍지 않고, 응답 본문은 정리해서 200자까지만.
- 리다이렉트는 따라가지 않는다(urllib은 POST를 GET으로 바꾸고 헤더를 새 주소로 넘긴다). 쓰기는 재시도하지
  않는다: 쓰기 함수 호출 1번 = HTTP 요청 1번 (일지가 `*-sent`를 요청 직전에 남긴다). 읽기(GET)는 연결 오류·5xx에
  최대 3번(0.5초·1초 쉼, CHORE_JIRA_RETRY_SLEEP = 첫 쉼 초, 테스트는 0).
- 표준 라이브러리만. 다른 스크립트는 경로로 읽어 함수를 쓴다(python3 -I는 같은 폴더 import를 막는다):
  client(site) · Client.call · myself/view/transitions/comments/changelog/search/evidence/comment/transition
  · JiraError(code, message, status) · parse_ts · build_adf · flatten · scrub · read_binding
  · (move) gh_login · gh_issue · move_history · source_b · live_candidates · created_by · ticket_check · issue_check
  · createmeta_ok · GhError · FormatError.
- gh = env CHORE_GH(테스트 — 공백으로 나눈 argv 머리)가 있으면 그것, 아니면 gh. 언제나 GH_PROMPT_DISABLED=1, 셸 없음, 시간 제한.
"""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True
TIMEOUT = 30.0
READ_TRIES = 3     # GET만: 연결 오류·5xx면 다시 (쓰기는 언제나 1번)
RETRY_SLEEP = 0.5  # 첫 쉼; 두 번째는 2배
PAGE = 100          # 요청하는 maxResults; 서버가 더 적게 줄 수 있으니 다음 startAt은 받은 개수로 센다
MAX_PAGES = 1000    # 페이지 루프 상한 (서버가 같은 페이지를 계속 줄 때)
DETAIL_MAX = 200
VIEW_FIELDS = "project,status,updated,assignee"
EVIDENCE_FIELDS = "summary,description,creator,created,updated,status,assignee,labels,issuelinks"
SEARCH_FIELDS = "summary,status,updated,assignee,project"

OK, USAGE, REJECTED, UNKNOWN, AUTH, READ = 0, 2, 3, 4, 5, 6
WRITE_COMMANDS = {"comment", "transition"}
AUTH_MSG = "chore-jira: Jira 인증 실패 — JIRA_EMAIL/JIRA_API_TOKEN 또는 CHORE_ENV_FILE의 값 확인"

KEY_RE = re.compile(r"[A-Z][A-Z0-9]+-[0-9]+")
ID_RE = re.compile(r"[0-9]+")
SITE_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?")
LOOPBACK_BASE = re.compile(r"https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?/?")
TS_RE = re.compile(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:?\d\d)")
URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:(?:\\*/){2}\S*")   # https:// 와 JSON 이스케이프 https:\/\/
AUTH_WORD_RE = re.compile(r"(?i)\b(basic|bearer)\s+\S+")
BAD_TEXT_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")   # 댓글 본문: \n·\t 외 제어 문자 거부


class JiraError(Exception):
    """code = 종료 코드 클래스(2/3/4/5/6), message = stderr 한 줄(정리됨), status = HTTP 상태 또는 None."""

    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# --- 출력 정리 -------------------------------------------------------------------
_SECRETS = []   # Client가 토큰과 base64 쌍을 등록한다


def scrub(text, limit=DETAIL_MAX):
    """비밀값·URL·Authorization 꼴을 지우고 한 줄로 접어 limit자까지 자른다."""
    s = str(text)
    for secret in _SECRETS:
        if secret:
            s = s.replace(secret, "<redacted>")
    s = URL_RE.sub("<url>", s)
    s = AUTH_WORD_RE.sub(r"\1 <redacted>", s)
    s = " ".join(s.split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


UNSUPPORTED_BODY = "응답 본문 형식 미지원"


def _detail(body):
    """HTTP 오류 본문 → 짧은 설명. 본문 날것은 절대 싣지 않는다: Jira 오류 JSON의 errorMessages(문자열 목록)와
    errors(문자열 → 문자열)에서 문자열만 꺼내 하나씩 scrub(토큰·base64 쌍·URL, \\/ 이스케이프 포함)하고 길이를 자른다.
    그 밖의 모양(HTML, 다른 JSON, 중첩·문자열 아닌 값) = 고정 문구. 빈 본문 = 설명 없음."""
    if not body or not body.strip():
        return ""
    try:
        d = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return " — " + UNSUPPORTED_BODY
    if not isinstance(d, dict) or not ("errorMessages" in d or "errors" in d):
        return " — " + UNSUPPORTED_BODY
    msgs, errs = d.get("errorMessages"), d.get("errors")
    if msgs is not None and not (isinstance(msgs, list) and all(isinstance(m, str) for m in msgs)):
        return " — " + UNSUPPORTED_BODY
    if errs is not None and not (isinstance(errs, dict) and all(isinstance(v, str) for v in errs.values())):
        return " — " + UNSUPPORTED_BODY
    parts = [scrub(m, 120) for m in msgs or [] if m.strip()]
    parts += [scrub(f"{k}: {v}", 120) for k, v in (errs or {}).items()]
    text = scrub("; ".join(parts))
    return f" — {text}" if text else ""


# --- 시각 · ADF --------------------------------------------------------------------
def parse_ts(s):
    """Jira/ISO 시각 → aware datetime. '2026-10-19T06:07:25.160+0900' · '…Z' · '…+09:00'. 그 외 ValueError."""
    m = TS_RE.fullmatch(s) if isinstance(s, str) else None
    if not m:
        raise ValueError("시각 형식 아님")
    y, mo, d, h, mi, se, frac, off = m.groups()
    us = int((frac or "0")[:6].ljust(6, "0"))
    if off == "Z":
        tz = timezone.utc
    else:
        oh, om = int(off[1:3]), int(off[-2:])
        if oh > 23 or om > 59:
            raise ValueError("시각 형식 아님")
        delta = timedelta(hours=oh, minutes=om)
        tz = timezone(-delta if off[0] == "-" else delta)
    return datetime(int(y), int(mo), int(d), int(h), int(mi), int(se), us, tzinfo=tz)


def build_adf(text):
    """줄마다 문단 하나, 빈 줄 = 빈 문단(빈 text 노드는 Jira가 거부), text 노드만·marks 없음.
    flatten(build_adf(t)) == t (text 노드에 '\\n'이 없으므로 split/join이 정확히 되돌린다)."""
    paragraphs = []
    for line in text.split("\n"):
        paragraphs.append({"type": "paragraph", "content": [{"type": "text", "text": line}] if line else []})
    return {"type": "doc", "version": 1, "content": paragraphs}


INLINE = {"text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status",
          "mediaInline", "placeholder", "inlineExtension"}


def flatten(node):
    """ADF → 평문 (댓글·설명 공용). 블록 자식은 '\\n'으로, 인라인 자식은 그대로 잇는다.
    남이 쓴 댓글도 읽으므로 hardBreak·mention·emoji·inlineCard 등을 글자로 남긴다. 문자열 본문은 그대로."""
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
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
    content = node.get("content") if isinstance(node.get("content"), list) else []
    kids = [k for k in content if isinstance(k, dict)]
    if all(k.get("type") in INLINE for k in kids):
        return "".join(flatten(k) for k in kids)
    return "\n".join(flatten(k) for k in kids)


# --- HTTP ---------------------------------------------------------------------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """3xx를 따라가지 않는다 → HTTPError로 올라온다."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _net_msg(exc, write):
    """연결 단계 예외 → 한 줄 (클래스 이름만; 예외 문자열에는 호스트가 들어갈 수 있다)."""
    inner = exc.reason if isinstance(exc, urllib.error.URLError) and isinstance(exc.reason, BaseException) else exc
    name = type(inner).__name__
    what = "시간 초과" if isinstance(inner, TimeoutError) else "연결 실패 또는 응답 끊김"
    return f"{what} ({name}) — 쓰기 결과 미확정" if write else f"{what} ({name})"


class Client:
    def __init__(self, base, email, token, timeout=TIMEOUT, retry_sleep=None):
        self.base = base.rstrip("/")
        pair = base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("ascii")
        self._auth = "Basic " + pair
        _SECRETS.extend([token, pair])
        self.timeout = timeout
        if retry_sleep is None:
            try:
                retry_sleep = float(os.environ.get("CHORE_JIRA_RETRY_SLEEP", RETRY_SLEEP))
            except ValueError:
                retry_sleep = RETRY_SLEEP
        self.retry_sleep = max(0.0, retry_sleep)
        self.abort_check = None   # 엔진이 거는 콜백: 참이면 읽기를 새로 시작·재시도하지 않는다(쓰기는 보지 않음)
        self._opener = urllib.request.build_opener(_NoRedirect())

    def call(self, method, path, params=None, payload=None, write=False, parse=True, body=None):
        """성공 = (HTTP 상태, JSON 또는 None). 실패 = JiraError: 401/403 → 5 · 쓰기: 4xx → 3, 그 밖의 모든 실패 → 4
        (재시도 없음) · 읽기: 연결 오류·5xx는 READ_TRIES번까지 다시, 그래도 실패하거나 다른 실패면 → 6.
        body = 보낼 바이트 그대로(payload 대신 — move-issue 만들기는 승인한 바이트를 다시 직렬화하지 않고 보낸다)."""
        tries = 1 if write else READ_TRIES
        for i in range(tries):
            if not write and self.abort_check is not None and self.abort_check():
                raise JiraError(READ, "중단 신호 — 읽기를 시작하지 않음")
            try:
                return self._once(method, path, params, payload, write, parse, body)
            except JiraError as e:
                transient = e.status is None or e.status >= 500
                if write or e.code != READ or not transient or i == tries - 1:
                    raise
            time.sleep(self.retry_sleep * (2 ** i))
        raise JiraError(READ, "읽기 재시도 소진")   # 도달하지 않음

    def _once(self, method, path, params, payload, write, parse, body=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = body if body is not None else None if payload is None else \
            json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method, headers={"Accept": "application/json"})
        if data is not None:
            req.add_header("Content-Type", "application/json")
        req.add_unredirected_header("Authorization", self._auth)
        fail = UNKNOWN if write else READ
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                status = resp.status
                raw = resp.read() if parse else b""
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                body = e.read()
            except Exception:
                body = b""
            if status in (401, 403):
                raise JiraError(AUTH, AUTH_MSG, status) from None
            code = REJECTED if write and 400 <= status < 500 else fail
            tail = " — 결과 미확정" if code == UNKNOWN else ""
            raise JiraError(code, f"HTTP {status}{_detail(body)}{tail}", status) from None
        except Exception as e:
            raise JiraError(fail, _net_msg(e, write)) from None
        if not parse or not raw.strip():
            return status, None
        try:
            return status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            tail = " — 결과 미확정" if write else ""
            raise JiraError(fail, f"HTTP {status} 응답이 JSON이 아님{tail}", status) from None

    def get(self, path, params=None):
        _, d = self.call("GET", path, params)
        _need(d is not None, "빈 응답")
        return d


def _env_file():
    """env CHORE_ENV_FILE이 가리키는 KEY=VALUE 파일 → dict. CHORE_ENV_FILE이 없거나 빈 값이면, 또는 파일이 없으면 {}."""
    out = {}
    name = os.environ.get("CHORE_ENV_FILE")
    if not name or not Path(name).is_file():
        return out
    for line in Path(name).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def credentials():
    """env JIRA_EMAIL / JIRA_API_TOKEN, 빈 것은 env CHORE_ENV_FILE이 가리키는 파일에서(CHORE_ENV_FILE이 없으면 읽지 않음).
    CHORE_JIRA_BASE가 있으면 파일을 읽지 않는다. 없으면 JiraError(5)."""
    email, token = os.environ.get("JIRA_EMAIL"), os.environ.get("JIRA_API_TOKEN")
    if not os.environ.get("CHORE_JIRA_BASE") and not (email and token):
        try:
            env = _env_file()
        except (OSError, UnicodeDecodeError):
            env = {}
        email, token = email or env.get("JIRA_EMAIL"), token or env.get("JIRA_API_TOKEN")
    if not email or not token:
        raise JiraError(AUTH, AUTH_MSG)
    return email, token


def client(site):
    """--site 호스트(또는 env CHORE_JIRA_BASE 전체 base)로 Client를 만든다."""
    if not isinstance(site, str) or not SITE_RE.fullmatch(site):
        raise JiraError(USAGE, "사용법 오류: --site는 호스트 이름 (예 example.atlassian.net)")
    base = os.environ.get("CHORE_JIRA_BASE") or f"https://{site}"
    if os.environ.get("CHORE_JIRA_BASE") and not LOOPBACK_BASE.fullmatch(base):
        raise JiraError(USAGE, "사용법 오류: CHORE_JIRA_BASE는 테스트용 — 127.0.0.1·localhost·[::1] 주소(포트 선택)만")
    timeout = TIMEOUT
    if os.environ.get("CHORE_JIRA_TIMEOUT"):
        try:
            timeout = float(os.environ["CHORE_JIRA_TIMEOUT"])
        except ValueError:
            timeout = -1.0
        if not timeout > 0:
            raise JiraError(USAGE, "사용법 오류: CHORE_JIRA_TIMEOUT은 양수 초")
    email, token = credentials()
    return Client(base, email, token, timeout)


# --- 응답 검사 ----------------------------------------------------------------------
def _need(cond, what):
    if not cond:
        raise JiraError(READ, f"응답 형식 오류: {what}")


def _str(v):
    return isinstance(v, str) and v != ""


def _int(v):
    return type(v) is int


def _ts(v, what):
    try:
        parse_ts(v)
    except ValueError:
        raise JiraError(READ, f"응답 형식 오류: {what} 시각") from None
    return v


def _adf(body, what, null_ok=False):
    """판정에 쓰는 본문 → 평문. ADF doc(dict, type "doc") 또는 문자열만; 없음·null(null_ok 아니면)·그 밖의 모양 →
    JiraError(6). 빈 글로 바꾸지 않는다 — 읽지 못한 본문을 "빈 댓글"로 판정하면 승인 댓글·표지를 놓친다."""
    if body is None and null_ok:
        return ""
    if isinstance(body, str):
        return body
    problem = adf_shape_error(body)
    _need(problem is None, f"{what} ({problem})")
    return flatten(body)


def adf_shape_error(doc):
    """flatten이 읽는 구조만 검사(맞으면 None, 아니면 첫 어긋남): 뿌리 = type "doc"이고 content가 목록(빈 목록 = 빈
    문서, 정상), 모든 노드 = type 문자열이 있는 객체, content가 있으면 목록, text 노드의 text = 문자열. 모르는 노드
    종류라도 모양이 맞으면 지금처럼 읽는다. 깊은 중첩도 재귀 한도에 걸리지 않게 스택으로 돈다."""
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        return "ADF doc 아님"
    if not isinstance(doc.get("content"), list):
        return "doc.content가 목록이 아님"
    stack = [doc]
    while stack:
        node = stack.pop()
        if not isinstance(node, dict) or not isinstance(node.get("type"), str):
            return "type 문자열이 있는 노드가 아님"
        if "content" in node and not isinstance(node["content"], list):
            return f"{node['type']}.content가 목록이 아님"
        if node["type"] == "text" and not isinstance(node.get("text"), str):
            return "text 노드의 text가 문자열이 아님"
        stack.extend(node.get("content") or ())
    return None


def _account(user, what):
    """사용자 객체 → accountId, 없으면(None) None. 형식이 틀리면 6."""
    if user is None:
        return None
    _need(isinstance(user, dict) and _str(user.get("accountId")), f"{what}.accountId")
    return user["accountId"]


def _status(fields):
    st = fields.get("status")
    _need(isinstance(st, dict) and _str(st.get("id")) and isinstance(st.get("name"), str), "status")
    return st["id"], st["name"]


def _issue(d):
    _need(isinstance(d, dict) and _str(d.get("id")) and _str(d.get("key")) and isinstance(d.get("fields"), dict),
          "issue id/key/fields")
    return d["fields"]


def _key(key):
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise JiraError(USAGE, "사용법 오류: 이슈 키 형식 아님 (예 PROJ-123)")
    return key


# --- 명령 함수 (part (b)가 그대로 쓴다) -------------------------------------------------
def myself(c):
    d = c.get("/rest/api/3/myself")
    _need(isinstance(d, dict) and _str(d.get("accountId")), "myself.accountId")
    return {"account": d["accountId"]}


def view(c, key):
    """반환 key = 응답의 key (옮겨진 이슈면 요청 키와 다를 수 있다 — 신원 확인용)."""
    d = c.get(f"/rest/api/3/issue/{_key(key)}", {"fields": VIEW_FIELDS})
    f = _issue(d)
    project = f.get("project")
    _need(isinstance(project, dict) and _str(project.get("key")), "project")
    status_id, status_name = _status(f)
    return {"id": d["id"], "key": d["key"], "project": project["key"], "status_id": status_id,
            "status_name": status_name, "updated": _ts(f.get("updated"), "updated"),
            "assignee": _account(f.get("assignee"), "assignee")}


def transitions(c, key):
    d = c.get(f"/rest/api/3/issue/{_key(key)}/transitions")
    _need(isinstance(d, dict) and isinstance(d.get("transitions"), list), "transitions")
    out = []
    for t in d["transitions"]:
        _need(isinstance(t, dict) and _str(t.get("id")) and isinstance(t.get("to"), dict), "transition")
        to = t["to"]
        _need(_str(to.get("id")) and isinstance(to.get("name"), str), "transition.to")
        out.append({"id": t["id"], "to_id": to["id"], "to_name": to["name"]})
    return out


def comments(c, key):
    """전 페이지. 다음 startAt = 지금까지 받은 개수. total이 페이지 사이에 바뀌거나, 중복 id, 모은 개수 ≠ total → 6."""
    path = f"/rest/api/3/issue/{_key(key)}/comment"
    out, seen, total = [], set(), None
    for _ in range(MAX_PAGES):
        d = c.get(path, {"startAt": len(out), "maxResults": PAGE, "orderBy": "created"})
        _need(isinstance(d, dict) and isinstance(d.get("comments"), list) and _int(d.get("total")), "comments page")
        if total is None:
            total = d["total"]
        elif d["total"] != total:
            raise JiraError(READ, f"댓글 목록 불완전: 읽는 중 total이 바뀜 ({total} → {d['total']})")
        if "startAt" in d and d["startAt"] != len(out):
            raise JiraError(READ, "댓글 목록 불완전: startAt 불일치")
        for cm in d["comments"]:
            _need(isinstance(cm, dict) and _str(cm.get("id")), "comment.id")
            if cm["id"] in seen:
                raise JiraError(READ, "댓글 목록 불완전: 중복 댓글 id")
            seen.add(cm["id"])
            out.append({"id": cm["id"], "author": _account(cm.get("author"), "comment.author"),
                        "created": _ts(cm.get("created"), "comment.created"),
                        "updated": _ts(cm.get("updated"), "comment.updated"),
                        "text": _adf(cm.get("body"), "comment.body")})
        if len(out) >= total or not d["comments"]:
            break
    else:
        raise JiraError(READ, "댓글 목록 불완전: 페이지 상한 초과")
    if len(out) != total:
        raise JiraError(READ, f"댓글 목록 불완전: {len(out)}개 받음, total {total}")
    return out


def changelog(c, key, since=None):
    """isLast까지 전 페이지; history.created > since(시각 비교, 오프셋 무관)인 history의 item마다 한 줄.
    isLast 없음, isLast=false인 빈 페이지, 중복 history id, 첫 페이지와 다른 total, 받은 수 ≠ 첫 total → 6.
    since 형식 오류 → 2."""
    path = f"/rest/api/3/issue/{_key(key)}/changelog"
    try:
        since_at = None if since is None else parse_ts(since)
    except ValueError:
        raise JiraError(USAGE, "사용법 오류: --since는 Jira 시각 (예 2026-10-19T06:07:25.160+0900)") from None
    out, seen, total, first = [], set(), None, True
    for _ in range(MAX_PAGES):
        d = c.get(path, {"startAt": len(seen), "maxResults": PAGE})
        _need(isinstance(d, dict) and isinstance(d.get("values"), list) and isinstance(d.get("isLast"), bool),
              "changelog page (values/isLast)")
        if "startAt" in d and d["startAt"] != len(seen):
            raise JiraError(READ, "변경 이력 불완전: startAt 불일치")
        page_total = d.get("total")
        _need(page_total is None or _int(page_total), "changelog total")
        if first:                     # 첫 페이지의 total이 기준 — 뒤 페이지가 다르면 읽는 중에 바뀐 것
            total, first = page_total, False
        elif page_total != total:
            raise JiraError(READ, f"변경 이력 불완전: 읽는 중 total이 바뀜 ({total} → {page_total})")
        for h in d["values"]:
            _need(isinstance(h, dict) and _str(h.get("id")) and isinstance(h.get("items"), list), "history")
            if h["id"] in seen:
                raise JiraError(READ, "변경 이력 불완전: 중복 history id")
            seen.add(h["id"])
            created = _ts(h.get("created"), "history.created")
            author = _account(h.get("author"), "history.author")
            keep = since_at is None or parse_ts(created) > since_at
            for item in h["items"]:
                _need(isinstance(item, dict) and isinstance(item.get("field"), str), "history.item.field")
                if keep:
                    out.append({"created": created, "author": author, "field": item["field"]})
        if d["isLast"]:
            break
        if not d["values"]:
            raise JiraError(READ, "변경 이력 불완전: 빈 페이지인데 isLast=false")
    else:
        raise JiraError(READ, "변경 이력 불완전: 페이지 상한 초과")
    if total is not None and total != len(seen):
        raise JiraError(READ, f"변경 이력 불완전: {len(seen)}건 받음, total {total}")
    return out


def search(c, jql, fields=None):
    """/rest/api/3/search/jql 전 페이지 (nextPageToken). isLast는 bool이어야 하고 True에서만 멈춘다.
    isLast 없음·null·bool 아님, isLast=false인데 토큰 없음, 같은 토큰 반복, 중복 id → 6."""
    _need(isinstance(jql, str) and jql.strip(), "jql")
    fields = fields or SEARCH_FIELDS
    out, seen, tokens, token = [], set(), set(), None
    for _ in range(MAX_PAGES):
        params = {"jql": jql, "fields": fields, "maxResults": PAGE}
        if token:
            params["nextPageToken"] = token
        d = c.get("/rest/api/3/search/jql", params)
        _need(isinstance(d, dict) and isinstance(d.get("issues"), list), "search page")
        for it in d["issues"]:
            _need(isinstance(it, dict) and _str(it.get("id")) and _str(it.get("key")), "search issue id/key")
            _need(isinstance(it.get("fields", {}), dict), "search issue fields")
            if it["id"] in seen:
                raise JiraError(READ, "검색 결과 불완전: 중복 이슈 id")
            seen.add(it["id"])
            out.append({"key": it["key"], "id": it["id"], "fields": it.get("fields", {})})
        nxt, last = d.get("nextPageToken"), d.get("isLast")
        _need(isinstance(last, bool), "search page isLast")
        if last:
            break
        if not _str(nxt):
            raise JiraError(READ, "검색 결과 불완전: isLast=false인데 nextPageToken 없음")
        if nxt in tokens:
            raise JiraError(READ, "검색 결과 불완전: 같은 nextPageToken 반복")
        tokens.add(nxt)
        token = nxt
    else:
        raise JiraError(READ, "검색 결과 불완전: 페이지 상한 초과")
    return out


def evidence(c, key):
    """판정용 사실 한 번의 GET. issuelinks = [{type, direction(inward|outward), key, status_name}]."""
    d = c.get(f"/rest/api/3/issue/{_key(key)}", {"fields": EVIDENCE_FIELDS})
    f = _issue(d)
    _need("description" in f, "description")     # 요청한 필드가 빠졌으면 읽기 실패 (null = 빈 설명은 정상)
    status_id, status_name = _status(f)
    labels = f.get("labels") or []
    _need(isinstance(labels, list) and all(isinstance(x, str) for x in labels), "labels")
    _need(isinstance(f.get("summary"), str), "summary")
    links = []
    for link in f.get("issuelinks") or []:
        _need(isinstance(link, dict) and isinstance(link.get("type"), dict), "issuelink.type")
        if isinstance(link.get("outwardIssue"), dict):
            direction, other = "outward", link["outwardIssue"]
        elif isinstance(link.get("inwardIssue"), dict):
            direction, other = "inward", link["inwardIssue"]
        else:
            raise JiraError(READ, "응답 형식 오류: issuelink 대상 없음")
        _need(_str(other.get("key")), "issuelink.key")
        st = (other.get("fields") or {}).get("status") if isinstance(other.get("fields"), dict) else None
        links.append({"type": str(link["type"].get("name") or ""), "direction": direction, "key": other["key"],
                      "status_name": st.get("name") if isinstance(st, dict) else None})
    return {"key": d["key"], "id": d["id"], "summary": f["summary"],
            "description_text": _adf(f.get("description"), "description", null_ok=True),
            "creator": _account(f.get("creator"), "creator"), "created": _ts(f.get("created"), "created"),
            "updated": _ts(f.get("updated"), "updated"), "status_id": status_id, "status_name": status_name,
            "assignee": _account(f.get("assignee"), "assignee"), "labels": labels, "issuelinks": links}


def check_comment_text(text):
    """게시할 본문 검사: 비어 있지 않음, \\n·\\t 외 제어 문자 없음(\\r 포함). 위반 → 2."""
    if not isinstance(text, str) or not text.strip():
        raise JiraError(USAGE, "사용법 오류: 댓글 본문이 비어 있음")
    if BAD_TEXT_RE.search(text):
        raise JiraError(USAGE, "사용법 오류: 댓글 본문에 제어 문자(\\r 등)")
    return text


def comment(c, key, text):
    """POST 1번. 4xx → 3, 401/403 → 5, 그 밖의 실패 또는 2xx인데 id/created 없음 → 4."""
    path = f"/rest/api/3/issue/{_key(key)}/comment"
    payload = {"body": build_adf(check_comment_text(text))}
    status, d = c.call("POST", path, payload=payload, write=True)
    if not (isinstance(d, dict) and _str(d.get("id")) and _str(d.get("created"))):
        raise JiraError(UNKNOWN, f"HTTP {status} 응답에 댓글 id/created 없음 — 결과 미확정", status)
    return {"id": d["id"], "created": d["created"]}


def transition(c, key, transition_id):
    """POST 1번 (Jira = 204, 본문 안 읽음). 4xx → 3, 401/403 → 5, 그 밖의 실패 → 4."""
    path = f"/rest/api/3/issue/{_key(key)}/transitions"
    if not isinstance(transition_id, str) or not ID_RE.fullmatch(transition_id):
        raise JiraError(USAGE, "사용법 오류: 전환 ID는 숫자")
    c.call("POST", path, payload={"transition": {"id": transition_id}}, write=True, parse=False)
    return {}


# --- 엔진: 바인딩 · 일지 · apply-rows · verify-rows (design-jira.md §2–§5) ---------------------------------
# 종료 코드
#   binding      0 JSON 한 줄(바인딩 없으면 null) · 1 사용법/파일/형식 오류(같은 토큰 두 번 등)
#   apply-rows   0 계획의 Jira 행을 전부 결정 · 1 사용법/계획/바인딩 오류(Jira 읽기 전) · 5 인증 · 6 읽기 실패(재시도
#                후)·증거 재확인 실패(0·10 아닌 종료)·일지/락 입출력·일지 형식 오류 · 7 락을 다른 apply가 잡음(계획 락
#                <lock>, 그다음 사용자별 프로젝트 락 ~/.cache/chore/jira-<site>-<project>.lock) · 8 부모(chore.sh) 없음
#                또는 TERM/INT/HUP(마지막 행을 끝낸 뒤에 받았어도 8) · 9 회로 차단기(게시한 댓글이 승인본 조건과 다름)
#                0이 아니면: 이미 결정한 행만 RESULT 줄이 있고 나머지 행은 없다(chore.sh 중단 규칙이 채운다).
#                move-issue 행: 9 = 이 계획이 만든 티켓의 C1 불일치 또는 이 실행이 방금 만든 티켓에 담당자가 붙음·보고자가 다름
#                (그 행 결과를 적은 뒤). 일지 문법 위반(어느 계획 일지든) = 6.
#   verify-rows  0 VERIFY 줄(계획의 Jira 도우미 행 — jira-transition·move-issue — 마다, 계획 순서) · 1 사용법/계획/바인딩/
#                결과·일지 형식 오류 · 5 인증 · 6 읽기 실패(Jira·GitHub·move 일지 — design §7 행 1)
#   resolve      0 줄을 적음(stdout 한 줄씩) · 1 사용법 오류·거절(design §8 규칙, 한 줄 이유) · 5 인증 · 6 읽기 실패·일지 형식
#                · 7 프로젝트 락을 apply가 잡음
# 테스트 전용 env: CHORE_JIRA_TEST_DELAY=<초> (*-sent 앞 부모 검사 직전에 쉼) · CHORE_JIRA_TEST_KILL_AFTER=<일지 사건>
# (그 줄을 fsync한 직후 자기에게 SIGKILL — 결과 줄 전 강제 종료 재현) · CHORE_JIRA_TEST_TERM_AFTER=<일지 사건>
# (그 줄을 fsync한 직후 자기에게 SIGTERM을 보내고 처리기가 돌 때까지 기다림 — 보냄과 POST 사이의 중단 재현).
# move 사건(mv-create-sent 등)에도 같고, 일지 줄 없는 지점 = "mv-create-posted"·"mv-comment-posted"(응답 직후, 결과 줄 앞)
# · "mv-close"(GitHub 닫기 직전 검사 앞) · "mv-gh-closed"(gh issue close 직후, mv-closed 줄 앞).
# CHORE_JIRA_J2_SLEEP=<초> = A1 J2의 다시 찾기 간격(기본 20). CHORE_GH_RETRY_SLEEP=<초> = gh_issue 다시 읽기 쉼(기본 1).
# CHORE_GH = 가짜 gh.
ENGINE_COMMANDS = ("binding", "apply-rows", "verify-rows", "resolve")
ATTEMPT_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}")
INSTANT_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
CID_RE = re.compile(r"[0-9A-Za-z_-]+")
JREF_RE = re.compile(r"jira#[A-Z][A-Z0-9]+-[0-9]+")
EVENTS = ("comment-sent", "comment-ok", "comment-rejected", "comment-withdrawn",
          "transition-sent", "transition-ok", "transition-rejected", "transition-withdrawn")
# 한 (attempt, ref)의 일지 문법: [comment-sent [comment-ok | comment-rejected]] [transition-sent [transition-ok |
# transition-rejected]] — transition-sent는 그 시도에 comment-sent가 없거나 comment-ok가 있을 때만
# *-withdrawn = 보냄을 적은 뒤 중단 신호를 봐서 요청을 내보내지 않음(R10) — 그 시도에서 보내지 않은 것과 같다
GRAMMAR = {"start": {"comment-sent": "cs", "transition-sent": "ts"},
           "cs": {"comment-ok": "co", "comment-rejected": "end", "comment-withdrawn": "end"},
           "co": {"transition-sent": "ts"},
           "ts": {"transition-ok": "end", "transition-rejected": "end", "transition-withdrawn": "end"}, "end": {}}
GRAMMAR_WHY = {"cs": "답이 없는 댓글 보냄 뒤에 다른 줄", "ts": "답이 없는 옮기기 보냄 뒤에 다른 줄",
               "end": "거부·완료·철회 뒤에 다른 줄", "start": "순서가 틀림", "co": "순서가 틀림"}
RESULTS = ("OK", "SKIP", "FAIL", "UNKNOWN", "NOT-ATTEMPTED")
CLASSES = {"OK": {"moved", "already-done"},
           "SKIP": {"identity", "manual", "at-target", "assignee", "changed", "proof", "transition"},
           "FAIL": {"comment-rejected", "changed-after-comment", "transition-rejected"}}
ALL_CLASSES = set().union(*CLASSES.values())
RESOLVABLE = {"identity", "assignee", "changed", "proof", "transition", "at-target"}   # verify 규칙 8
ONE_WAY = {("OK", "moved"): "transition-ok", ("FAIL", "comment-rejected"): "comment-rejected",
           ("FAIL", "transition-rejected"): "transition-rejected", ("FAIL", "changed-after-comment"): "comment-ok"}
IGNORED_FIELDS = {"comment", "rank"}   # Δ에서 빼는 변경 이력 필드(대소문자 무시)
BINDING_TOKEN = re.compile(r"(?:^|[\s`(])(jira|jira-qa|jira-closed|jira-hold|jira-repos|deploy-proof|deploy-env)"
                           r"=([^\s`|)]+)")
DEPLOY_ENV = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}")   # deploy-env= 표시 이름(화면·댓글의 "<이름> 배포")
GH_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
RECHECK_TIMEOUT = 900.0
FORMAT = "결과/일지 형식 오류"
NOT_APPROVED = ("는 계획의 승인된 Jira 행이 아님 — 그 행을 계획에 되돌려 다시 실행하거나, 새 계획을 만드세요"
                "(이미 댓글이 달린 티켓은 새 계획에서 보류됨)")
RECOMMEND = {
    "proof": "증거가 사라짐 — 댓글을 고쳐 보류 사유를 남기거나 다음 정리에서 재판정",
    "changed": "누가 무엇을 바꿨는지 확인 후 직접 옮기기",
    "changed-after-comment": "누가 무엇을 바꿨는지 확인 후 직접 옮기기",
    "maybe_comment": "다음 정리에서 재판정",
    "manual": "티켓의 정리 댓글과 상태를 직접 확인한 뒤 다음 정리에서 재판정",
    "assignee": "담당자를 확인한 뒤 다음 정리에서 재판정",
    "identity": "티켓이 옮겨졌거나 바뀌었는지 확인한 뒤 다음 정리에서 재판정",
    "transition": "옮기는 경로가 왜 없는지 확인 후 직접 옮기기",
    "comment-rejected": "댓글이 거부된 이유를 확인한 뒤 같은 명령으로 다시 실행",
    "transition-rejected": "옮기기가 거부된 이유를 확인한 뒤 같은 명령으로 다시 실행(댓글은 다시 달지 않고 이어서 옮김)",
    "UNKNOWN": "같은 명령으로 다시 실행(이어서 확인)",
    "NOT-ATTEMPTED": "같은 명령으로 다시 실행",
    "none": "같은 명령으로 다시 실행",
}
RECOMMEND_DEFAULT = "다음 정리에서 재판정"
J2_TRIES, J2_SLEEP = 4, 20.0   # A1 J2: 0개면 20초 간격으로 최대 3번 다시 (테스트: CHORE_JIRA_J2_SLEEP)
# ── move-issue 행 (design v9 §6·§7, contract-shared.md §1·§2 — 보고서가 이 글로 읽는다; 글 하나 = 상수 하나) ──
MOVE_CLASSES = {"OK": {"moved", "already-done"}, "SKIP": {"account", "changed", "manual", "exists", "type"},
                "FAIL": {"create-rejected", "comment-failed", "close-failed"}}
MOVE_ALL_CLASSES = set().union(*MOVE_CLASSES.values())
MOVE_ONE_WAY = {("FAIL", "create-rejected"): "mv-create-rejected"}   # OK moved는 일지 없음(닫기는 적지 않는다)
# RESULT 글 (`<분류>: <글>`; KEY를 알면 `<KEY> — ` 다음)
MT_MOVED_NEW = "티켓을 만들고 이슈를 닫음"
MT_MOVED_OLD = "이미 만든 티켓으로 이슈를 닫음"
MT_ALREADY = "이미 닫혀 있고 이관 댓글 있음"
MT_ACCOUNT = "Jira 계정 또는 GitHub 로그인이 승인 때와 다름"
MT_CHANGED = "이슈가 승인 뒤 바뀜 — 닫지 않음"
MT_EXISTS = "이 이슈를 가리키는 티켓이 이미 있음: "
MT_TYPE = "티켓 유형을 만들 수 없음 — "
MT_PROJECT = "프로젝트가 승인 때와 다름"           # SKIP type의 <why>: GET project/<key>의 id ≠ 행의 project_id
MT_REJECTED = "Jira가 만들기를 거절함 (HTTP %s)"
MT_COMMENT_FAILED = "댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단"
MT_CLOSE_FAILED = "이슈를 닫지 못함"
MT_UNKNOWN_CREATE = "만들기 결과 모름 — 다음 실행이 확인"
MT_UNKNOWN_COMMENT = "댓글 결과 모름 — 다음 실행이 확인"
# 고정 이유 M1–M12 (contract-shared.md §5 — 보고서가 글 그대로 출구에 잇는다): SKIP manual의 <why>(KEY를 알면 `<KEY> — `
# 다음), VERIFY 2·6행의 <why>. 명령 이름은 싣지 않는다(SKILL이 이유 → 명령을 잇는다).
M1 = "만들기 결과 미확정 — 다시 만들지 않음"
M2 = "댓글 결과 미확정"
M3 = "승인한 티켓이 없어짐"
M4 = "이 이슈의 티켓 여럿"
M5 = "티켓 내용이 승인본과 다름 — 닫지 않음"
M6 = "이관 댓글이 지워짐"
M7 = "이관 댓글이 바뀜"
M8 = "이관 댓글 중복"
M9 = "누가 먼저 닫음 — 연결 기록 필요"
M10 = "기록 없는 이관 댓글"
M11 = "이관 댓글 없음"
M12 = "이관 댓글이 보낸 본문과 다름"
# VERIFY 10행이 그대로 싣는 RESULT 글(`<KEY> — ` 뒤) — §1 글과 바이트까지 같다
M13 = MT_CHANGED
M14 = MT_COMMENT_FAILED
M15 = MT_CLOSE_FAILED
M16 = MT_UNKNOWN_COMMENT
M17 = "지워진 티켓의 댓글 결과 미확정"    # F 앞: 살아 있는 KEY가 없는데 미결 댓글이 남음(그 KEY의 티켓이 지워짐)
M18 = "이 실행의 결과 줄 없음 — 다시 실행하면 확인"   # VERIFY 10b의 <why>(결과 줄 없음 / 마지막이 NOT-ATTEMPTED)
M19 = "만든 티켓에 담당자가 붙었거나 보고자가 실행 계정이 아님"   # 만든 뒤 확인 실패(담당자·보고자)
M20 = "만든 티켓을 다시 읽을 수 없음"                              # 만든 뒤 확인 실패(읽을 수 없음 · 이 계획의 확인 전 KEY가 404)
M21 = "옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음"   # 어느 계획이든 같은 이슈·같은 KEY로 닫은(mv-closed) 이슈를 사람이 다시 엶(C2 뒤·C6 앞)
FIXED_REASONS = (M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, M15, M16, M17, M18, M19, M20,
                 M21)   # contract §5
# chore.sh 중단 채움(scripts/chore.sh:117-118 apply_abort_report의 UNKNOWN 글 머리) — chore-jira가 쓴 결과가 아님(VERIFY 10b → M18)
ABORT_FILL_PREFIXES = ("journal has a write of this attempt, outcome unread", "journal unreadable at abort")
FIELD_NAMES = {"reporter": "보고자", "assignee": "담당자", "description": "설명", "summary": "요약"}   # 생성 화면에 없는 칸(이름을 Jira가 주지 않음)
MN_LATE = "현재 내용이 승인본과 다름 — 변경 시점 확정 불가"      # C2: CLOSED · updatedAt > closedAt — 계속하되 결과 이유에
# VERIFY 글 (design §7 표의 행 번호)
VT2 = "결과 미확정 — 사람이 확인 후 기록 필요: "
VT3 = "티켓이 안 보이거나 내용이 승인본과 다름: "
VT4 = "이 이슈의 티켓 여럿: "
VT5 = "옮겼는데 이슈가 열려 있음"
VT6 = "이관 댓글 없음·중복·바뀜: "
VT7 = "닫기 전에 이슈 내용이 바뀜"
VT8 = "현재 내용이 승인본과 다름 — 변경 시점 확정 불가"
VT9 = "옮김"
VT9W = "옮김, 닫은 뒤 새 댓글 %d개"
VT10 = "티켓 만듦, 이슈 닫지 않음: "
VT10C = "티켓 만듦, 이슈는 닫힘: "   # 10b: KEY · CLOSED · 행 6 통과 · C2가 계속할 내용 · 마지막 결과 OK 아님 (+ 마지막 결과 글 / M18)
VT11 = "이 이슈를 가리키는 티켓이 이미 있음: "
VT12 = "만든 것 없음 — "
VT12_WHY = {"account": "계정이 승인 때와 다름", "changed": "이슈가 승인 뒤 바뀜", "type": "티켓 유형을 만들 수 없음",
            "withdrawn": "보내기 전에 멈춤"}
VT12F = "만든 것 없음 — Jira가 거절함"
VT13 = "이번 실행에서 시도 안 함"
VTU = "확인 필요: "
VT_DELETED = " · 지워진 티켓 %s"                  # + " (지울 댓글 <cid>, …)" — 그 KEY를 가리키던 R 댓글이 있으면


class Stop(Exception):
    """엔진을 멈춘다: code = 종료 코드, message = stderr 한 줄."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


class BindingError(Exception):
    pass


class FormatError(Exception):
    pass


_PLAN = None


def plan_mod():
    """scripts/chore_plan.py (U0) — 계획 문법 한 벌. 경로로 읽는다(python3 -I)."""
    global _PLAN
    if _PLAN is None:
        spec = importlib.util.spec_from_file_location("chore_plan", Path(__file__).resolve().parent / "chore_plan.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _PLAN = mod
    return _PLAN


def one_line(text):
    """결과·확인 줄의 이유 칸: TAB/CR/LF → 공백 하나, 비밀값 지움."""
    s = re.sub(r"[\t\r\n]", " ", str(text))
    for secret in _SECRETS:
        if secret:
            s = s.replace(secret, "<redacted>")
    return s


def _note(msg):
    try:
        sys.stderr.write("chore-jira: " + scrub(msg, 300) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


# --- 바인딩 (the registry (CHORE_REPOS_MD)) ---
def read_binding(repos_md, remote):
    """the registry (CHORE_REPOS_MD) 표에서 remote 칸(| 로 나눈 4번째, 백틱 제거, 대소문자 무시) == remote인 행의
    note 칸 토큰 → {site, project, qa, closed, hold:[…], proof_workflow, proof_branch, proof_label, other_repos:[…]}(없는
    선택 토큰 = None, other_repos는 없으면 []). jira= 없으면 None. jira-repos=owner/a,owner/b = 같은 Jira 프로젝트를 쓰는
    다른 GitHub 저장소(자기 remote는 넣지 않음). proof_label = 화면·댓글에 쓰는 배포 환경 이름: deploy-env=<이름>이 있으면
    그것, 없으면 deploy-proof 브랜치의 마지막 `/` 조각, deploy-proof도 없으면 None. 같은 토큰 두 번·같은 remote 행 둘·
    형식 오류·목록 중복 = BindingError."""
    try:
        text = Path(repos_md).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise BindingError(f"repos.md를 읽을 수 없음 ({type(e).__name__})") from None
    want = str(remote).strip().strip("`").strip().casefold()
    found = []
    for no, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s.startswith("|"):
            continue
        parts = s.split("|")
        if len(parts) < 5 or parts[3].strip().strip("`").strip().casefold() != want:
            continue
        found.append((no, "|".join(parts[4:-1] if s.endswith("|") else parts[4:])))
    if not found:
        return None
    if len(found) > 1:
        raise BindingError(f"repos.md에 {remote} 행이 {len(found)}개 (줄 {', '.join(str(n) for n, _ in found)})")
    no, note = found[0]
    tok = {}
    for m in BINDING_TOKEN.finditer(note):
        if m.group(1) in tok:
            raise BindingError(f"repos.md {no}번째 줄: {m.group(1)}= 토큰이 두 번")
        tok[m.group(1)] = m.group(2)
    if "jira" not in tok:
        return None
    site, _, project = tok["jira"].rpartition("/")
    if not SITE_RE.fullmatch(site) or not re.fullmatch(r"[A-Z][A-Z0-9]+", project):
        raise BindingError(f"repos.md {no}번째 줄: jira=는 <site>/<PROJECT>")
    for k in ("jira-qa", "jira-closed"):
        if k in tok and not ID_RE.fullmatch(tok[k]):
            raise BindingError(f"repos.md {no}번째 줄: {k}=는 상태 id(숫자)")
    hold = None
    if "jira-hold" in tok:
        hold = tok["jira-hold"].split(",")
        if not all(ID_RE.fullmatch(h) for h in hold):
            raise BindingError(f"repos.md {no}번째 줄: jira-hold=는 쉼표로 구분한 상태 id")
    wf = br = None
    if "deploy-proof" in tok:
        wf, at, br = tok["deploy-proof"].partition("@")
        if not wf or not at or not br:
            raise BindingError(f"repos.md {no}번째 줄: deploy-proof=는 <workflow 파일>@<브랜치>")
    label = (br.rsplit("/", 1)[-1] or None) if br else None
    if "deploy-env" in tok:
        if not DEPLOY_ENV.fullmatch(tok["deploy-env"]):
            raise BindingError(f"repos.md {no}번째 줄: deploy-env=는 영문자·숫자로 시작하는 32자 이하 이름(영문자·숫자·._-)")
        label = tok["deploy-env"]
    others = []
    if "jira-repos" in tok:
        for repo in tok["jira-repos"].split(","):
            if not GH_REPO.fullmatch(repo):
                raise BindingError(f"repos.md {no}번째 줄: jira-repos=는 쉼표로 구분한 owner/repo")
            if repo.casefold() == want:
                raise BindingError(f"repos.md {no}번째 줄: jira-repos=에 이 저장소 자신({repo})이 있음")
            if repo.casefold() in (o.casefold() for o in others):
                raise BindingError(f"repos.md {no}번째 줄: jira-repos=에 {repo}가 두 번")
            others.append(repo)
    return {"site": site, "project": project, "qa": tok.get("jira-qa"), "closed": tok.get("jira-closed"),
            "hold": hold, "proof_workflow": wf, "proof_branch": br, "proof_label": label, "other_repos": others}


# --- 일지 ---
def _write_all(fd, data):
    """짧은 쓰기를 이어서 끝까지 쓴다 (os.write는 요청보다 적게 쓸 수 있다)."""
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        if n <= 0:
            raise OSError("write returned 0")
        view = view[n:]


def now_instant():
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def split_journal(data):
    """일지 바이트 → (완전한 줄 목록, 끝의 줄바꿈 없는 바이트)."""
    cut = data.rfind(b"\n") + 1
    try:
        text = data[:cut].decode("utf-8")
    except UnicodeDecodeError:
        raise FormatError("일지가 UTF-8이 아님") from None
    return (text.split("\n")[:-1] if text else []), data[cut:]


def parse_journal(lines, approved):
    """완전한 줄 → [(attempt, ref, event, comment id 또는 None)]. 줄 형식·(attempt, ref)별 문법·승인된 행인지 검사,
    위반 = FormatError. 다른 시도의 줄이 섞여 있어도 된다(짝은 (attempt, ref) 안에서만 맞춘다).
    event 칸이 `mv-`로 시작하는 줄(move-issue, v4.3)은 여기서 검사하지 않고 (attempt, ref, event, None)으로 그대로 넘긴다 —
    문법은 move_history가 본다. 넘기는 이유: journaled_count가 chore.sh P_JOURNALED처럼 이 시도의 모든 줄을 센다."""
    out, state = [], {}
    for no, line in enumerate(lines, 1):
        f = line.split(" ")
        if len(f) >= 4 and f[3].startswith("mv-"):
            out.append((f[1], f[2], f[3], None))
            continue
        if len(f) not in (4, 5) or not INSTANT_RE.fullmatch(f[0]) or not ATTEMPT_RE.fullmatch(f[1]) \
                or not JREF_RE.fullmatch(f[2]) or f[3] not in EVENTS:
            raise FormatError(f"일지 {no}번째 줄 형식이 틀림: {line[:120]}")
        has_id = len(f) == 5
        if (f[3] == "comment-ok") != has_id or (has_id and not CID_RE.fullmatch(f[4])):
            raise FormatError(f"일지 {no}번째 줄의 댓글 id 자리가 틀림: {line[:120]}")
        if f[2] not in approved:
            raise FormatError(f"일지 {no}번째 줄의 {f[2]}{NOT_APPROVED}")
        k = (f[1], f[2])
        st = state.get(k, "start")
        nxt = GRAMMAR[st].get(f[3])
        if nxt is None:
            raise FormatError(f"일지 {no}번째 줄: {GRAMMAR_WHY[st]} ({f[3]}): {line[:120]}")
        state[k] = nxt
        out.append((f[1], f[2], f[3], f[4] if has_id else None))
    return out


def journal_facts(entries, ref):
    """design §3 일지 사실 (전 시도에 걸쳐, 서로 지우지 않음)."""
    per = {}
    for att, r, ev, cid in entries:
        if r == ref:
            per.setdefault(att, []).append((ev, cid))
    sets = {att: {ev for ev, _ in evs} for att, evs in per.items()}

    def maybe(kind):   # 같은 시도 안에서 거부되거나 철회(요청을 내보내지 않음)된 보냄은 보내지 않은 것
        return any(kind + "-sent" in s and kind + "-rejected" not in s and kind + "-withdrawn" not in s
                   for s in sets.values())
    mc, mt = maybe("comment"), maybe("transition")
    return {"posted_ids": [cid for evs in per.values() for ev, cid in evs if ev == "comment-ok"],
            "maybe_comment": mc, "maybe_transition": mt, "wrote": mc or mt,
            "transition_ok": any("transition-ok" in s for s in sets.values()), "any": bool(per), "per": sets}


def append_line(path, line):
    """일지에 한 줄 = O_APPEND 쓰기 1번 + fsync (새 파일이면 폴더도 fsync). 실패 = Stop(6)."""
    try:
        new = not os.path.exists(path)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)
        try:
            _write_all(fd, line.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        if new:
            dfd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
    except OSError as e:
        raise Stop(READ, f"일지 기록 실패 ({type(e).__name__}) — 그 뒤 단계를 하지 않음") from None


# --- move-issue 일지 (design v9 §3) ---
# 줄 = `<instant> <attempt> issue#N <event> k=v[ k=v…]` (값에 공백 없음). sid = <run_id>/<attempt>/<seq> — run_id = 일지 파일
# 이름(<run_id>.journal), seq = 그 attempt 안의 전송 순번(1부터). by = <gh 로그인>,<Jira 계정>(resolve만).
MV_FIELDS = {
    "mv-create-sent": ("seq", "acct"),
    "mv-create-ok": ("sid", "key"),
    "mv-create-rejected": ("sid",),
    "mv-create-withdrawn": ("sid",),
    "mv-comment-sent": ("seq", "key", "tsha"),
    "mv-comment-ok": ("sid", "cid", "csha"),
    "mv-comment-withdrawn": ("sid",),
    "mv-create-found": ("of", "key"),
    "mv-comment-found": ("of", "cid", "csha"),
    "mv-comment-adopt": ("key", "cid", "csha"),
    "mv-resolve-found": ("of", "key", "by"),
    "mv-resolve-not-created": ("of", "by"),
    "mv-resolve-comment-found": ("of", "cid", "csha", "by"),
    "mv-resolve-comment-not-posted": ("of", "by"),
    "mv-retire": ("key", "cid", "by"),
    "mv-link": ("key", "plan", "by"),
    "mv-closed": ("key",),               # C6 닫기 뒤 다시 읽어 CLOSED를 확인한 직후(그 계획이 닫았다는 기록 — 다시 열면 다시 닫지 않음)
}
MV_SEND = {"mv-create-sent": "create", "mv-comment-sent": "comment"}
MV_RESULT = {"mv-create-ok": "create", "mv-create-rejected": "create", "mv-create-withdrawn": "create",
             "mv-comment-ok": "comment", "mv-comment-withdrawn": "comment"}           # sid = 같은 attempt·같은 ref의 전송
MV_OF = {"mv-create-found": "create", "mv-comment-found": "comment", "mv-resolve-found": "create",
         "mv-resolve-not-created": "create", "mv-resolve-comment-found": "comment",
         "mv-resolve-comment-not-posted": "comment"}                                  # of = 같은 ref·같은 종류의 전송
ISSUE_RE = re.compile(r"issue#([1-9][0-9]*)")
MV_KEY_RE = re.compile(r"[A-Z][A-Z0-9]+-[1-9][0-9]*")
FREE_KEY_RE = re.compile(r"(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]+-[1-9][0-9]*(?![A-Za-z0-9_-])")   # 글 속 KEY(양쪽 경계, contract §5)
SID_RE = re.compile(r"([0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})/([0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})/([1-9][0-9]*)")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
ACCT_RE = re.compile(r"[A-Za-z0-9:._-]+")                  # Jira accountId (예 712020:uuid) — 일지에 그대로 적을 수 있는 것만
LOGIN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*(?:\[bot\])?")   # GitHub 로그인
MV_VALUE = {"seq": re.compile(r"[1-9][0-9]*"), "acct": ACCT_RE, "sid": SID_RE, "of": SID_RE, "key": MV_KEY_RE,
            "tsha": HEX64_RE, "csha": HEX64_RE, "cid": re.compile(r"[0-9]+"), "plan": ATTEMPT_RE,
            "by": re.compile(LOGIN_RE.pattern + "," + ACCT_RE.pattern)}


def sha_text(text):
    """본문 sha = UTF-8 바이트 그대로의 sha256 hex (정규화 없음 — design §10c)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def mv_line(instant, attempt, ref, event, fields):
    """move 줄 하나(끝 \\n 포함). 사건·칸 순서·값 형식이 MV_FIELDS/MV_VALUE와 다르면 Stop(1) — 쓰기 전에 멈춘다."""
    keys = tuple(k for k, _ in fields)
    if event not in MV_FIELDS or keys != MV_FIELDS[event] or not ISSUE_RE.fullmatch(ref):
        raise Stop(1, f"일지 줄을 만들 수 없음: {event} {' '.join(keys)}")
    for k, v in fields:
        if not isinstance(v, str) or not MV_VALUE[k].fullmatch(v):
            raise Stop(1, f"일지 줄을 만들 수 없음: {event}의 {k} 값 형식")
    return f"{instant} {attempt} {ref} {event} " + " ".join(f"{k}={v}" for k, v in fields) + "\n"


def legacy_form_ok(f):
    """jira-transition 일지 줄의 모양만(승인·문법은 보지 않음) — move_history가 건너뛰는 줄."""
    return (len(f) in (4, 5) and INSTANT_RE.fullmatch(f[0]) and ATTEMPT_RE.fullmatch(f[1]) and JREF_RE.fullmatch(f[2])
            and f[3] in EVENTS and (f[3] == "comment-ok") == (len(f) == 5) and (len(f) == 4 or CID_RE.fullmatch(f[4])))


def _instant_ok(instant, where, line):
    """일지 줄의 시각이 달력에 있는 시각인지(parse_ts) — 모양만 맞는 13월 같은 값이 뒤에서 ValueError로 터지지 않게."""
    try:
        parse_ts(instant)
    except ValueError:
        raise FormatError(f"{where}: 시각이 달력에 없음: {line[:120]}") from None


def read_moves(chore_dir):
    """<chore_dir>/*.journal 전부 → move 줄 기록 목록(파일 이름순, 줄 순). 파일마다 마지막 \\n 뒤 바이트는 버린다.
    mv- 줄 = MV 문법(모르는 사건·칸 빠짐/더함·값 형식·결과 sid가 같은 attempt·ref의 앞선 전송이 아님·of=가 같은 ref·종류의
    전송이 아님·전송 하나에 결과/복구 둘·seq가 attempt 안에서 1부터 차례가 아님·한 KEY를 두 전송이 만듦·같은 댓글(KEY, cid)에
    서로 다른 sha), 그 밖 = jira-transition 줄이면 모양 + 파일마다 (attempt, ref)별 GRAMMAR 차례(parse_journal과 같은 걸음,
    승인 여부는 안 봄 — 다른 계획 일지도 읽는다)를 보고 건너뜀, 둘 다 아님·읽기 실패·이름이 <run_id>.journal이 아닌 일지 =
    FormatError (0건으로 읽지 않는다).
    기록 = {"file": run_id, "no": 줄 번호, "at", "attempt", "ref", "event", "f": {k: v}, "order": 전체 순번}."""
    try:
        names = sorted(n for n in os.listdir(chore_dir) if n.endswith(".journal"))
    except FileNotFoundError:
        return []
    except OSError as e:
        raise FormatError(f"일지 폴더를 읽을 수 없음 ({type(e).__name__})") from None
    recs, sends, seqs = [], {}, {}
    for name in names:
        stem = name[:-len(".journal")]
        if not ATTEMPT_RE.fullmatch(stem):
            raise FormatError(f"일지 이름이 <run_id>.journal이 아님: {name[:80]}")
        try:
            with open(os.path.join(chore_dir, name), "rb") as fh:
                data = fh.read()
        except OSError as e:
            raise FormatError(f"일지를 읽을 수 없음 ({type(e).__name__}): {name}") from None
        lines, _torn = split_journal(data)
        gstate = {}                                  # 이 파일의 jira-transition (attempt, ref) → GRAMMAR 상태
        for no, line in enumerate(lines, 1):
            f = line.split(" ")
            where = f"{name} {no}번째 줄"
            if not (len(f) >= 4 and f[3].startswith("mv-")):
                if not legacy_form_ok(f):
                    raise FormatError(f"{where} 형식이 틀림(move도 jira-transition도 아님): {line[:120]}")
                _instant_ok(f[0], where, line)
                st = gstate.get((f[1], f[2]), "start")
                nxt = GRAMMAR[st].get(f[3])
                if nxt is None:
                    raise FormatError(f"{where}: {GRAMMAR_WHY[st]} ({f[3]}): {line[:120]}")
                gstate[(f[1], f[2])] = nxt
                continue
            if not INSTANT_RE.fullmatch(f[0]) or not ATTEMPT_RE.fullmatch(f[1]) or not ISSUE_RE.fullmatch(f[2]):
                raise FormatError(f"{where} 형식이 틀림: {line[:120]}")
            _instant_ok(f[0], where, line)
            ev = f[3]
            if ev not in MV_FIELDS:
                raise FormatError(f"{where}: 모르는 move 사건 {ev[:40]}")
            kv = []
            for item in f[4:]:
                k, eq_, v = item.partition("=")
                if not eq_:
                    raise FormatError(f"{where}: k=v 아닌 칸: {line[:120]}")
                kv.append((k, v))
            if tuple(k for k, _ in kv) != MV_FIELDS[ev]:
                raise FormatError(f"{where}: {ev}의 칸은 {' '.join(MV_FIELDS[ev])} (이 순서): {line[:120]}")
            for k, v in kv:
                if not MV_VALUE[k].fullmatch(v):
                    raise FormatError(f"{where}: {k} 값 형식이 틀림: {line[:120]}")
            rec = {"file": stem, "no": no, "at": f[0], "attempt": f[1], "ref": f[2], "event": ev, "f": dict(kv),
                   "order": len(recs)}
            if ev in MV_SEND:
                n = seqs.get((stem, f[1]), 0) + 1
                if int(rec["f"]["seq"]) != n:
                    raise FormatError(f"{where}: seq {rec['f']['seq']}는 이 attempt의 {n}번째 전송이어야 함")
                seqs[(stem, f[1])] = n
                sid = f"{stem}/{f[1]}/{n}"
                rec["sid"] = sid
                sends[sid] = rec
            elif ev in MV_RESULT:
                run, att, _seq = SID_RE.fullmatch(rec["f"]["sid"]).groups()
                s = sends.get(rec["f"]["sid"])
                if run != stem or att != f[1] or s is None or s["ref"] != f[2] or MV_SEND[s["event"]] != MV_RESULT[ev]:
                    raise FormatError(f"{where}: 결과의 sid가 같은 attempt·같은 이슈의 앞선 {MV_RESULT[ev]} 전송이 아님")
            elif ev == "mv-link" and rec["f"]["plan"] != stem:
                raise FormatError(f"{where}: mv-link plan={rec['f']['plan']}이 이 일지({stem})가 아님")
            recs.append(rec)
    settled, bound = {}, {}
    for rec in recs:
        sid = rec["f"].get("sid") if rec["event"] in MV_RESULT else rec["f"].get("of")
        if sid is None:
            continue
        s = sends.get(sid)
        if rec["event"] in MV_OF and (s is None or s["ref"] != rec["ref"] or MV_SEND[s["event"]] != MV_OF[rec["event"]]):
            raise FormatError(f"{rec['file']}.journal {rec['no']}번째 줄: of={sid}가 같은 이슈의 {MV_OF[rec['event']]} 전송이 아님")
        if sid in settled:
            raise FormatError(f"{rec['file']}.journal {rec['no']}번째 줄: 전송 {sid}에 결과·복구가 둘 ({settled[sid]}, {rec['event']})")
        settled[sid] = rec["event"]
        key = rec["f"].get("key") if rec["event"] in ("mv-create-ok", "mv-create-found", "mv-resolve-found") else None
        if key is not None:
            if key in bound and bound[key] != sid:
                raise FormatError(f"{rec['file']}.journal {rec['no']}번째 줄: {key}를 두 전송이 만들었다고 적힘")
            bound[key] = sid
    shas = {}                                        # (ref, KEY, cid) → csha: 한 댓글에 내용 기록은 하나
    for rec in recs:
        ev, f = rec["event"], rec["f"]
        if ev not in ("mv-comment-ok", "mv-comment-found", "mv-resolve-comment-found", "mv-comment-adopt"):
            continue
        key = f["key"] if ev == "mv-comment-adopt" else sends[f.get("sid") or f.get("of")]["f"]["key"]
        ident = (rec["ref"], key, f["cid"])
        if ident in shas and shas[ident] != f["csha"]:
            raise FormatError(f"{rec['file']}.journal {rec['no']}번째 줄: 같은 댓글에 서로 다른 내용 기록 ({key} 댓글 {f['cid']})")
        shas[ident] = f["csha"]
    # mv-closed: (일지, attempt, ref)마다 하나 · 같은 일지 파일 안에서 그 줄보다 앞에(어느 attempt든) 같은 (ref, KEY)의 이관 댓글
    # 기록(comment-ok·found·resolve comment-found·adopt)이 있어야 한다 — 시각이 아니라 일지의 물리적 순서로 본다(시계가 뒤로
    # 가도 맞게). 쓰는 쪽: C6는 C4(이 계획 일지에 그 댓글 기록이 없으면 mv-comment-adopt를 이 일지에 쓴다) 또는 C5(mv-comment-ok)
    # 뒤에만 닿으므로 정상 경로의 mv-closed는 언제나 같은 파일에 앞선 기록이 있다.
    seen, closed = set(), set()
    for rec in recs:                                 # recs = 파일 이름순, 파일 안은 줄 순
        ev, f = rec["event"], rec["f"]
        if ev in ("mv-comment-ok", "mv-comment-found", "mv-resolve-comment-found", "mv-comment-adopt"):
            key = f["key"] if ev == "mv-comment-adopt" else sends[f.get("sid") or f.get("of")]["f"]["key"]
            seen.add((rec["file"], rec["ref"], key))
        elif ev == "mv-closed":
            where = f"{rec['file']}.journal {rec['no']}번째 줄"
            if (rec["file"], rec["attempt"], rec["ref"]) in closed:
                raise FormatError(f"{where}: 한 시도·한 이슈에 mv-closed가 둘")
            closed.add((rec["file"], rec["attempt"], rec["ref"]))
            if (rec["file"], rec["ref"], f["key"]) not in seen:
                raise FormatError(f"{where}: mv-closed {f['key']} 앞(같은 일지)에 그 KEY의 이관 댓글 기록이 없음")
    return recs


def move_history(chore_dir, ref, plan_run_id=None):
    """design §3 history(ref): 일지 전부(read_moves)를 이 이슈 하나에 대해 줄인다. 반환
    {"ref", "records": 이 ref의 기록(순서대로), "sends": {sid: {"sid","kind","at","acct","key","tsha","run_id","attempt"}},
     "settled": {sid: 사건}, "pending_creates"/"pending_comments": [sid](결과 줄도, 그 sid를 가리키는 복구·사람 줄도 없는 전송),
     "keys": {KEY: {"acct","sid","run_id","at","attempt"}}(create-ok/found·resolve found),
     "R": {(key, cid): csha}(comment-ok/found/adopt·resolve comment-found − retire), "retired": {(key, cid)},
     "confirmed": {run_id: {(key, cid): csha}}(그 계획 일지의 ok/found/adopt/resolve 확인 — retire 전),
     "posted": {(key, cid): sid}(전송에서 온 확인), "links": {(run_id, key): 남은 게시 허가 bool},
     "lines": {run_id: 이 ref 줄 수}, "closed": {(run_id, KEY)}(이 이슈에서 그 계획이 그 KEY로 닫고 확인한 mv-closed —
     다시 열린 이슈 가드는 어느 계획의 것이든 같은 이슈·같은 KEY면 막는다)}
    + plan_run_id를 주면 "mine"(= confirmed[plan]) · "plan_lines".
    문법 위반·읽기 실패 = FormatError (호출자 → Stop READ)."""
    recs = [r for r in read_moves(chore_dir) if r["ref"] == ref]
    sends, settled, keys, conf, posted, retired, lines, closed = {}, {}, {}, {}, {}, set(), {}, set()
    for r in recs:
        lines[r["file"]] = lines.get(r["file"], 0) + 1
        if r["event"] in MV_SEND:
            sends[r["sid"]] = {"sid": r["sid"], "kind": MV_SEND[r["event"]], "at": r["at"], "acct": r["f"].get("acct"),
                               "key": r["f"].get("key"), "tsha": r["f"].get("tsha"), "run_id": r["file"],
                               "attempt": r["attempt"]}
    for r in recs:
        ev, f = r["event"], r["f"]
        sid = f.get("sid") if ev in MV_RESULT else f.get("of")
        if sid is not None:
            settled[sid] = ev
        if ev in ("mv-create-ok", "mv-create-found", "mv-resolve-found"):
            s = sends[sid]
            keys[f["key"]] = {"acct": s["acct"], "sid": sid, "run_id": s["run_id"], "at": s["at"], "attempt": s["attempt"]}
        elif ev in ("mv-comment-ok", "mv-comment-found", "mv-resolve-comment-found", "mv-comment-adopt"):
            key = f["key"] if ev == "mv-comment-adopt" else sends[sid]["key"]
            conf.setdefault(r["file"], {})[(key, f["cid"])] = f["csha"]
            if sid is not None:
                posted[(key, f["cid"])] = sid
        elif ev == "mv-retire":
            retired.add((f["key"], f["cid"]))
        elif ev == "mv-closed":
            closed.add((r["file"], f["key"]))
    R = {}
    for per in conf.values():                        # 같은 댓글에 다른 sha는 read_moves가 이미 거절했다
        for ident, csha in per.items():
            if ident not in retired:
                R[ident] = csha
    links = {}
    for r in sorted(recs, key=lambda x: (x["at"], x["order"])):
        ev, f = r["event"], r["f"]
        if ev == "mv-link":
            links[(f["plan"], f["key"])] = True
        elif ev in ("mv-comment-ok", "mv-comment-found", "mv-resolve-comment-found"):
            s = sends[f.get("sid") or f.get("of")]
            if (s["run_id"], s["key"]) in links:
                links[(s["run_id"], s["key"])] = False
    pend = [sid for sid in sends if sid not in settled]
    pend.sort(key=lambda sid: (sends[sid]["at"], sid))
    h = {"ref": ref, "records": recs, "sends": sends, "settled": settled,
         "pending_creates": [s for s in pend if sends[s]["kind"] == "create"],
         "pending_comments": [s for s in pend if sends[s]["kind"] == "comment"],
         "keys": keys, "R": R, "retired": retired, "confirmed": conf, "posted": posted, "links": links, "lines": lines,
         "closed": closed}
    if plan_run_id is not None:
        h["mine"] = conf.get(plan_run_id, {})
        h["plan_lines"] = lines.get(plan_run_id, 0)
    return h


# --- 라이브 사실 ---
def c_failure(cm, account, approved, created_at):
    """댓글이 C(이번 계획의 승인 댓글)에 들면 None, 아니면 처음 어긋난 조건(한국어)."""
    if cm["author"] != account:
        return "작성자가 이 계정이 아님"
    if cm["text"] != approved:
        return "본문이 승인본과 다름"
    if parse_ts(cm["created"]) < created_at:
        return "작성 시각이 계획 시각보다 이름(시계 차이)"
    if parse_ts(cm["updated"]) != parse_ts(cm["created"]):
        return "수정된 댓글(수정 시각 ≠ 작성 시각)"
    return None


def live_facts(row, hdr, jf, account, v, cs, cl=None, exclude=()):
    """design §3 라이브 사실. cl = changelog(since=expected) 결과(verify는 None — Δ를 쓰지 않는다).
    exclude = Δ에서 뺄 댓글 id(방금 게시한 댓글 — 회로 차단기 판단용)."""
    snap = row["snapshot"]
    approved, created_at, expected_at = row["evidence"], parse_ts(hdr["created"]), parse_ts(row["expected"])
    C = [cm for cm in cs if c_failure(cm, account, approved, created_at) is None]
    cids = {cm["id"] for cm in C}
    # M의 표지 탐지 = collect와 같은 한 벌(chore_plan.has_chore_marker, 줄마다 strip); C는 승인본과 바이트가 같아야 한다
    M = [cm for cm in cs
         if cm["author"] == account and cm["id"] not in cids and plan_mod().has_chore_marker(cm["text"])]
    delta, delta_key = [], []
    for it in cl or ():
        if it["field"].casefold() not in IGNORED_FIELDS and parse_ts(it["created"]) > expected_at:
            delta.append(f"{it['field']} 변경")
            delta_key.append(("h", it["created"], it["field"], it["author"] or ""))
    for cm in cs:
        if cm["id"] not in cids and cm["id"] not in exclude and (
                parse_ts(cm["created"]) > expected_at or parse_ts(cm["updated"]) > expected_at):
            delta.append("새 댓글·고친 댓글")
            delta_key.append(("c", cm["id"], cm["updated"], ""))
    # updated가 움직인 것을 설명하는 것은 expected 뒤의 Rank 변경 이력뿐이다(보드 순서 — 2026-10-19 리뷰 결정).
    # comment 필드 항목이나 그 밖의 것은 설명이 되지 않는다; Δ가 비고 C가 비고 Rank도 없으면 "원인 미확인".
    rank_after = any(it["field"].casefold() == "rank" and parse_ts(it["created"]) > expected_at for it in cl or ())
    return {"C": C, "M": M, "delta": delta, "delta_key": sorted(delta_key),
            "lost": any(pid not in cids for pid in jf["posted_ids"]),
            "orphan": len(C) == 1 and not jf["maybe_comment"],
            "unexplained": parse_ts(v["updated"]) != expected_at and not delta and not C and not rank_after,
            "moved": len(C) == 1 and (v["status_id"] == snap["to_status"] or jf["transition_ok"])}


def fingerprint(v, lf):
    """쓰기 직전 다시 읽기와 비교할 것(design §4 리뷰 보강): 상태 · updated(시각) · C id · M id · Δ 항목."""
    return {"상태": v["status_id"], "갱신 시각": parse_ts(v["updated"]),
            "승인 댓글": sorted(cm["id"] for cm in lf["C"]), "다른 정리 댓글": sorted(cm["id"] for cm in lf["M"]),
            "변경 이력·댓글": lf["delta_key"]}


def describe(items):
    order, n = [], {}
    for x in items:
        if x not in n:
            order.append(x)
        n[x] = n.get(x, 0) + 1
    return ", ".join(f"{x} {n[x]}건" if n[x] > 1 else x for x in order)


def identity_diff(v, snap, key):
    d = []
    if v["id"] != snap["issue_id"]:
        d.append(f"id {snap['issue_id']} → {v['id']}")
    if v["key"] != key:
        d.append(f"키 {key} → {v['key']}")
    if v["project"] != snap["project"]:
        d.append(f"프로젝트 {snap['project']} → {v['project']}")
    return ", ".join(d)


def manual_why(lf):
    why = []
    if len(lf["C"]) >= 2:
        why.append(f"승인 댓글이 {len(lf['C'])}개")
    if lf["M"]:
        why.append("이 계정의 다른 정리 댓글이 있음")
    if lf["lost"]:
        why.append("보낸 승인 댓글이 지금 조건에 안 맞음(수정·삭제)")
    if lf["orphan"]:
        why.append("일지에 없는 승인 댓글이 있음")
    return why


def parent_alive(pid):
    if os.getppid() != pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


# --- move-issue: GitHub(gh) · Jira 읽기와 공통 검사 (design v9 §4 — build·apply·verify·resolve가 같은 함수) ---
GH_TIMEOUT = 60.0
GH_READ_TRIES, GH_RETRY_SLEEP = 3, 1.0   # gh_issue: "읽는 중 이슈가 바뀜"일 때만 다시 읽기
TICKET_FIELDS = "summary,description,reporter,assignee,project,created"
CREATE_OK_FIELDS = {"project", "issuetype", "summary", "reporter"}     # 필수(기본값 없음)는 이 안에서만 (design §10f ④)
CREATE_NEED_FIELDS = ("reporter", "assignee", "description", "summary")   # 생성 화면에 있어야 하는 필드
CREATED_SLACK = timedelta(minutes=5)                                  # created_by: 만든 시각 ≥ 보낸 시각 − 5분


class GhError(Exception):
    """gh 실패 — 읽기면 읽기 실패(부분 목록 없음), 쓰기면 결과 미확정. 메시지 = 한 줄(URL·토큰 없음)."""


def gh_cmd():
    """gh 실행 argv 머리: env CHORE_GH(테스트 — 공백으로 나눔)가 있으면 그것, 아니면 ["gh"]."""
    v = os.environ.get("CHORE_GH")
    return v.split() if v else ["gh"]


def _gh(args, stdin=None, timeout=GH_TIMEOUT):
    """gh 한 번(셸 없음, GH_PROMPT_DISABLED=1, 시간 제한) → (rc, stdout bytes, stderr 첫 줄 정리본)."""
    env = dict(os.environ, GH_PROMPT_DISABLED="1")
    try:
        p = subprocess.run(gh_cmd() + list(args), input=stdin, capture_output=True, env=env, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise GhError(f"gh {args[0]} 시간 초과") from None
    except OSError as e:
        raise GhError(f"gh를 실행할 수 없음 ({type(e).__name__})") from None
    first = (p.stderr.decode("utf-8", "replace").strip().splitlines() or [""])[0]
    return p.returncode, p.stdout, scrub(first, 160)


def _gh_json(args, what, many=False):
    """gh 읽기 → JSON. many = `--paginate` 출력(페이지마다 JSON 배열이 이어 붙음) → 배열들을 이은 목록. 0 아닌 종료·JSON
    오류·모양 오류 = GhError (부분 목록을 돌려주지 않는다)."""
    rc, out, err = _gh(args)
    if rc != 0:
        raise GhError(f"{what}: gh 실패 (exit {rc}){' — ' + err if err else ''}")
    try:
        text = out.decode("utf-8")
    except UnicodeDecodeError:
        raise GhError(f"{what}: gh 출력이 UTF-8이 아님") from None
    if not many:
        try:
            return json.loads(text)
        except ValueError:
            raise GhError(f"{what}: gh 출력이 JSON이 아님") from None
    dec, i, items = json.JSONDecoder(), 0, []
    while True:
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            break
        try:
            page, i = dec.raw_decode(text, i)
        except ValueError:
            raise GhError(f"{what}: gh 출력이 JSON 배열이 아님") from None
        if not isinstance(page, list):
            raise GhError(f"{what}: gh 페이지가 배열이 아님")
        items.extend(page)
    if not text.strip():
        raise GhError(f"{what}: gh 출력이 비었음")
    return items


def _gh_need(cond, what):
    if not cond:
        raise GhError(f"GitHub 응답 형식 오류: {what}")


def _gh_ts(v, what):
    _gh_need(isinstance(v, str), what)
    try:
        parse_ts(v)
    except ValueError:
        raise GhError(f"GitHub 응답 형식 오류: {what} 시각") from None
    return v


def _gh_user(u, what):
    if u is None:
        return None
    _gh_need(isinstance(u, dict) and isinstance(u.get("login"), str) and u["login"] != "", f"{what}.login")
    return u["login"]


def gh_login():
    """지금 gh가 쓰는 GitHub 로그인 (gh api user). 실패 = GhError."""
    d = _gh_json(["api", "user"], "gh api user")
    _gh_need(isinstance(d, dict) and isinstance(d.get("login"), str) and LOGIN_RE.fullmatch(d["login"]), "user.login")
    return d["login"]


def gh_issue(remote, n):
    """GitHub 이슈 엄격 읽기(design §4 view): REST issues/N + 댓글 전부(`gh api --paginate`). 반환 {"number", "title", "body",
    "labels": [이름], "author": 로그인|None, "created", "updated", "state": OPEN|CLOSED, "closed_at": CLOSED면 시각 아니면 None,
    "comments": [{"id": 숫자 문자열, "author", "created", "updated", "body"}](API 순서 = 오래된 순)}. 0 아닌 종료·JSON 오류·필드
    빠짐·PR = GhError. 완결 검사: 이슈의 comments(개수)를 받고, 댓글 목록 뒤에 이슈를 다시 읽어 updated_at·comments가 같고
    목록 길이 == comments여야 한다 — 아니면 GhError "읽는 중 이슈가 바뀜 — 다시 실행"(부분 목록으로 판정하지 않는다). 이 어긋남만
    GH_READ_TRIES번까지 다시 읽는다(쉼 GH_RETRY_SLEEP초, 테스트: CHORE_GH_RETRY_SLEEP) — 마지막 어긋남이 그 GhError, 다른
    실패는 다시 읽지 않는다."""
    _gh_need(isinstance(remote, str) and GH_REPO.fullmatch(remote) and type(n) is int and n > 0, "remote/number")
    try:
        pause = max(0.0, float(os.environ.get("CHORE_GH_RETRY_SLEEP", GH_RETRY_SLEEP)))
    except ValueError:
        pause = GH_RETRY_SLEEP
    for i in range(GH_READ_TRIES):
        out, count = _gh_issue_obj(remote, n)
        items = _gh_json(["api", "--paginate", f"repos/{remote}/issues/{n}/comments?per_page=100"], f"issue #{n} 댓글",
                         many=True)
        again, count2 = _gh_issue_obj(remote, n)
        if again["updated"] == out["updated"] and count2 == count and len(items) == count:
            break
        if i == GH_READ_TRIES - 1:
            raise GhError(f"issue #{n}: 읽는 중 이슈가 바뀜 — 다시 실행 (댓글 {len(items)}개 받음, 이슈의 댓글 수 "
                          f"{count}→{count2})")
        time.sleep(pause)
    cms, seen = [], set()
    for cm in items:
        _gh_need(isinstance(cm, dict) and type(cm.get("id")) is int, "comment.id")
        cid = str(cm["id"])
        _gh_need(cid not in seen, "comment.id 중복")
        seen.add(cid)
        _gh_need("user" in cm and isinstance(cm.get("body"), str), "comment.user/body")
        cms.append({"id": cid, "author": _gh_user(cm["user"], "comment.user"),
                    "created": _gh_ts(cm.get("created_at"), "comment.created_at"),
                    "updated": _gh_ts(cm.get("updated_at"), "comment.updated_at"), "body": cm["body"]})
    out["comments"] = cms
    return out


def _gh_issue_obj(remote, n):
    """REST issues/N 한 번 → (gh_issue 머리 dict, 댓글 수 comments)."""
    d = _gh_json(["api", f"repos/{remote}/issues/{n}"], f"issue #{n}")
    _gh_need(isinstance(d, dict), "issue")
    _gh_need("pull_request" not in d, f"#{n}은 PR (이슈가 아님)")
    _gh_need(d.get("number") == n, "issue.number")
    _gh_need(isinstance(d.get("title"), str), "issue.title")
    _gh_need("body" in d and (d["body"] is None or isinstance(d["body"], str)), "issue.body")
    _gh_need(isinstance(d.get("labels"), list) and all(isinstance(x, dict) and isinstance(x.get("name"), str)
                                                      for x in d["labels"]), "issue.labels")
    _gh_need("user" in d, "issue.user")
    _gh_need(d.get("state") in ("open", "closed"), "issue.state")
    _gh_need("closed_at" in d, "issue.closed_at")
    state = d["state"].upper()
    closed_at = None
    if state == "CLOSED":
        closed_at = _gh_ts(d["closed_at"], "issue.closed_at")
    _gh_need(type(d.get("comments")) is int and d["comments"] >= 0, "issue.comments(개수)")
    out = {"number": n, "title": d["title"], "body": d["body"], "labels": [x["name"] for x in d["labels"]],
           "author": _gh_user(d["user"], "issue.user"), "created": _gh_ts(d.get("created_at"), "issue.created_at"),
           "updated": _gh_ts(d.get("updated_at"), "issue.updated_at"), "state": state, "closed_at": closed_at}
    return out, d["comments"]


def gh_post_comment(remote, n, text):
    """`gh api --method POST repos/<o>/<r>/issues/<n>/comments --input -` 1번 → {"id", "body"}. 실패·응답 형식 오류 =
    GhError(결과 미확정 — 다시 보내지 않는다)."""
    body = json.dumps({"body": text}, ensure_ascii=False).encode("utf-8")
    rc, out, err = _gh(["api", "--method", "POST", f"repos/{remote}/issues/{n}/comments", "--input", "-"], stdin=body)
    if rc != 0:
        raise GhError(f"댓글 게시 gh 실패 (exit {rc}){' — ' + err if err else ''}")
    try:
        d = json.loads(out.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise GhError("댓글 게시 응답이 JSON이 아님") from None
    if not (isinstance(d, dict) and type(d.get("id")) is int and isinstance(d.get("body"), str)):
        raise GhError("댓글 게시 응답에 id/body 없음")
    return {"id": str(d["id"]), "body": d["body"]}


def gh_close(remote, n):
    """`gh issue close N --repo R --reason "not planned"` 1번 → 종료 코드(결과는 호출자가 다시 읽어 확인한다)."""
    try:
        return _gh(["issue", "close", str(n), "--repo", remote, "--reason", "not planned"])[0]
    except GhError:
        return -1


def key_order(key):
    project, _, num = key.rpartition("-")
    return (project, int(num))


def _blocks(doc, lenient):
    """설명 ADF → 블록 열(chore_plan.parse_blocks) 또는 None(읽을 수 없는 문서). lenient = 후보 분류용(사람이 목록 등을 더한
    chore 티켓도 chore 티켓으로) — 내용 비교(ticket_check)는 언제나 엄격."""
    plan = plan_mod()
    try:
        return plan.parse_blocks(doc, lenient=True) if lenient else plan.parse_blocks(doc)
    except plan.PlanError:
        return None


def _ticket(d, what):
    """Jira 이슈 JSON(view 또는 search 한 건) → {"key", "id", "project", "project_id", "summary", "reporter", "created",
    "blocks"(엄격, 못 읽으면 None), "lblocks"(분류용), "text"(flatten)}. 응답 모양 오류 = JiraError(6)."""
    f = _issue(d)
    project = f.get("project")
    _need(isinstance(project, dict) and _str(project.get("key")) and _str(project.get("id")), f"{what}.project")
    _need(isinstance(f.get("summary"), str), f"{what}.summary")
    _need("description" in f, f"{what}.description")
    desc = f["description"]
    if desc is None:                       # 빈 설명 = 블록 0개(정상)
        strict, lenient, text = [], [], ""
    else:
        problem = adf_shape_error(desc)
        _need(problem is None, f"{what}.description ({problem})")
        strict, lenient, text = _blocks(desc, False), _blocks(desc, True), flatten(desc)
    return {"key": d["key"], "id": d["id"], "project": project["key"], "project_id": project["id"],
            "summary": f["summary"], "reporter": _account(f.get("reporter"), f"{what}.reporter"),
            "assignee": _account(f.get("assignee"), f"{what}.assignee"),
            "created": _ts(f.get("created"), f"{what}.created"), "blocks": strict, "lblocks": lenient, "text": text}


def project_id(c, project):
    """GET project/<key> → id(숫자 문자열), 확정 404 = None. 응답 key가 다르면 읽기 실패."""
    try:
        d = c.get(f"/rest/api/3/project/{project}")
    except JiraError as e:
        if e.code == READ and e.status == 404:
            return None
        raise
    _need(isinstance(d, dict) and _str(d.get("id")) and ID_RE.fullmatch(d["id"]) and d.get("key") == project, "project")
    return d["id"]


def ticket_view(c, key):
    """Jira 티켓 엄격 읽기 → _ticket 모양, 확정 404 = None. 그 밖의 실패 = JiraError."""
    try:
        d = c.get(f"/rest/api/3/issue/{_key(key)}", {"fields": TICKET_FIELDS})
    except JiraError as e:
        if e.code == READ and e.status == 404:
            return None
        raise
    return _ticket(d, "ticket")


def source_jql(project, repo_name):
    """출처 B의 JQL (구 문장 검색 — 실측 2026-10-21 PROJ에서 동작)."""
    if not re.fullmatch(r"[A-Z][A-Z0-9]+", str(project)) or not re.fullmatch(r"[A-Za-z0-9_.-]+", str(repo_name)):
        raise JiraError(USAGE, "사용법 오류: 출처 B 검색의 프로젝트·저장소 이름 형식")
    return f'project = {project} AND text ~ "\\"{repo_name}/issues\\""'


def source_b(c, project, repo_name):
    """출처 B(design §4·§5): JQL `project = P AND text ~ "\\"<repo>/issues\\""` 전 페이지(엄격, search) → 티켓마다 _ticket
    모양. 다른 프로젝트 결과 = 읽기 실패."""
    out = []
    for it in search(c, source_jql(project, repo_name), TICKET_FIELDS):
        t = _ticket({"id": it["id"], "key": it["key"], "fields": it["fields"]}, "search")
        _need(t["project"] == project, "search 결과의 프로젝트")
        out.append(t)
    return out


def _points(t, repo_url, n):
    """t가 이슈 n을 가리키나 — chore_plan.points_at 한 술어. 설명을 블록으로 못 읽으면 비-chore 티켓으로(글 전체 = 문단 하나)."""
    plan = plan_mod()
    if t["lblocks"] is None:
        return plan.points_at([("paragraph", t["text"])], repo_url, n)
    return plan.points_at(t["lblocks"], repo_url, n)


def reopened(view, hist, key):
    """다시 열린 이슈 가드(contract round 5d·R16): 이슈가 OPEN이고 어느 계획이든 같은 이슈(hist = 이 ref의 history)·같은 KEY로
    mv-closed를 남겼다. apply는 C2 바로 뒤와 C6 닫기 바로 앞(다시 읽은 view·history로) 두 번 본다."""
    return view["state"] == "OPEN" and any(k == key for _run, k in hist["closed"])


def needs_post_create_check(hist, key):
    """만든 뒤 확인이 아직 필요한가(design §10f ① · contract §6): KEY를 chore 전송이 만들었고(hist["keys"] — create-ok/found·
    resolve found) 그 KEY를 적은 mv-comment-sent가 어느 일지에도 없다. apply(C 앞·E1)와 판정 build가 같은 술어를 쓴다."""
    return key in hist["keys"] and not any(s["kind"] == "comment" and s["key"] == key for s in hist["sends"].values())


def post_create_detail(c, key, acct):
    """만든 뒤 확인 → (None | M19 | M20, stderr용 자세한 이유). 읽기 실패(404 밖) = JiraError."""
    tk = ticket_view(c, key)
    if tk is None:
        return M20, "만든 티켓을 다시 읽지 못함(없음)"
    if tk["assignee"] is not None:
        return M19, "담당자가 붙음(승인본은 담당자 없음)"
    if tk["reporter"] != acct:
        return M19, "보고자가 실행 계정이 아님"
    return None, None


def post_create_why(c, key, acct):
    """만든 뒤 확인(읽을 수 있음 · 담당자 없음 · 보고자 == acct) → None | M19 | M20. apply와 판정 build가 같은 함수를 쓴다."""
    return post_create_detail(c, key, acct)[0]


def created_since(c, project, sidinfo, repo_url, n, hist):
    """resolve --not-created의 두 번째 찾기(글 색인 없이): `project = P AND reporter = "<그 전송의 acct>" AND created >=
    "<보낸 시각 − 5분>"` 전 페이지 → created_by(t, 그 전송)인 티켓 KEY 목록(보고자 · 블록 1 = 이 이슈 URL · 만든 시각 ≥ 보낸
    시각 − 5분 · 다른 전송에 묶인 KEY 아님 — 첫 찾기와 같은 술어). JQL 시각은 검색하는 사용자의 시간대로 읽히므로 12시간 더
    일찍(UTC 벽시계, 모든 시간대 −12h…+14h를 덮음) 묻고 정확한 하한은 created_by가 다시 본다."""
    if not ACCT_RE.fullmatch(str(sidinfo["acct"])):
        raise JiraError(USAGE, "사용법 오류: 보고자 계정 형식")
    since = parse_ts(sidinfo["at"]) - CREATED_SLACK
    wall = (since - timedelta(hours=12)).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")
    jql = f'project = {project} AND reporter = "{sidinfo["acct"]}" AND created >= "{wall}"'
    out = []
    for it in search(c, jql, TICKET_FIELDS):
        t = _ticket({"id": it["id"], "key": it["key"], "fields": it["fields"]}, "search")
        if created_by(t, sidinfo, repo_url, n, hist):
            out.append(t["key"])
    return sorted(set(out), key=key_order)


def live_candidates(c, hist, src_b, account, repo_url, n):
    """design §4 live_candidates(ref) → (T, b, c, deleted), 각각 키 순서 목록. 출처를 먼저 나눈다: 일지가 아는 KEY(hist["keys"])는
    모양과 무관하게 T — 확정 404만 deleted(어디에도 안 셈). 일지에 없는 출처 B 티켓 중 이 이슈를 가리키는 것(points_at)만:
    (a) ours 모양(보고자 == account · 마지막 블록 MARKER · 블록 1 = 이 이슈 URL) → T, (b) chore 모양인데 (a) 아님 → b,
    (c) 그 밖 → c (생성을 막지 않음 — related·합칠 후보). 읽기 실패 = JiraError."""
    plan = plan_mod()
    T, b, cc, deleted = [], [], [], []
    for key in sorted(hist["keys"], key=key_order):
        (T if ticket_view(c, key) is not None else deleted).append(key)
    for t in src_b:
        if t["key"] in hist["keys"] or not _points(t, repo_url, n):
            continue
        blocks = t["lblocks"]
        if blocks is not None and plan.ours_shape(blocks, t["reporter"], account, repo_url, n):
            T.append(t["key"])
        elif blocks is not None and plan.chore_shaped(blocks):
            b.append(t["key"])
        else:
            cc.append(t["key"])
    return (sorted(set(T), key=key_order), sorted(set(b), key=key_order), sorted(set(cc), key=key_order),
            sorted(deleted, key=key_order))


def created_by(ticket, sidinfo, repo_url, n, hist):
    """design §4 생성 신원 created_by(t, sid) (라벨·표지·내용과 무관): 보고자 == 그 sid의 acct · 블록 1 = 이 이슈 URL ·
    만든 시각 ≥ 보낸 시각 − 5분 · 다른 sid에 이미 묶인 KEY가 아님. J2·resolve --found·--not-created가 쓴다."""
    blocks = ticket["lblocks"]
    if ticket["reporter"] != sidinfo["acct"] or not blocks or blocks[0] != ("paragraph", plan_mod().move_url_line(repo_url, n)):
        return False
    if parse_ts(ticket["created"]) < parse_ts(sidinfo["at"]) - CREATED_SLACK:
        return False
    bound = hist["keys"].get(ticket["key"])
    return bound is None or bound["sid"] == sidinfo["sid"]


def createmeta_ok(c, project_id, type_id):
    """design §2·§10f ④ 생성 필드 검사: createmeta(project, issuetype) 전 페이지의 필수(기본값 없음) ⊆ {project, issuetype,
    summary, reporter} 그리고 reporter·assignee·description·summary가 생성 화면에 있음 → None, 아니면 한국어 이유(칸은
    createmeta의 name으로 — contract §5: `필수 칸 <이름들>` / `생성 화면에 없는 칸 <이름들>`).
    유형이 그 프로젝트에 없음(404) = 이유. 그 밖의 실패 = JiraError."""
    if not ID_RE.fullmatch(str(project_id)) or not ID_RE.fullmatch(str(type_id)):
        raise JiraError(USAGE, "사용법 오류: createmeta의 프로젝트·유형 id는 숫자")
    path = f"/rest/api/3/issue/createmeta/{project_id}/issuetypes/{type_id}"
    fields, total = [], None
    for _ in range(MAX_PAGES):
        try:
            d = c.get(path, {"startAt": len(fields), "maxResults": PAGE})
        except JiraError as e:
            if e.code == READ and e.status == 404:
                return f"유형 {type_id}의 생성 화면을 찾을 수 없음 (HTTP 404)"
            raise
        _need(isinstance(d, dict) and isinstance(d.get("fields"), list) and _int(d.get("total")), "createmeta page")
        if not _int(d.get("startAt")) or d["startAt"] != len(fields):
            raise JiraError(READ, f"createmeta 불완전: 페이지 startAt이 요청({len(fields)})과 다름")
        if total is None:
            total = d["total"]
        elif d["total"] != total:
            raise JiraError(READ, "createmeta 불완전: 읽는 중 total이 바뀜")
        if not d["fields"] and len(fields) < total:
            raise JiraError(READ, f"createmeta 불완전: {len(fields)}개 뒤 빈 페이지, total {total}")
        for fd in d["fields"]:
            _need(isinstance(fd, dict) and _str(fd.get("fieldId")) and isinstance(fd.get("required"), bool)
                  and isinstance(fd.get("hasDefaultValue", False), bool) and _str(fd.get("name")), "createmeta field")
            if any(x["fieldId"] == fd["fieldId"] for x in fields):
                raise JiraError(READ, "createmeta 불완전: 같은 칸이 두 번")
            fields.append(fd)
        if len(fields) >= total:
            break
    else:
        raise JiraError(READ, "createmeta 불완전: 페이지 상한 초과")
    if len(fields) != total:
        raise JiraError(READ, f"createmeta 불완전: {len(fields)}개 받음, total {total}")
    present = {fd["fieldId"] for fd in fields}
    extra = [fd["name"] for fd in fields if fd["required"] and not fd.get("hasDefaultValue", False)
             and fd["fieldId"] not in CREATE_OK_FIELDS]
    if extra:
        return "필수 칸 " + ", ".join(extra)
    missing = [FIELD_NAMES[k] for k in CREATE_NEED_FIELDS if k not in present]
    if missing:
        return "생성 화면에 없는 칸 " + ", ".join(missing)
    return None


def _split_op(blocks):
    """설명 블록 열 → (O 앞 1–3, P 4·5, O 6…10, P 11) 네 조각, P 자리 모양이 틀리면 None. 4 = `남기는 이유: `, 5(있으면) =
    `관련: `, 11 = MARKER."""
    if len(blocks) < 6 or blocks[3][0] != "paragraph" or not blocks[3][1].startswith("남기는 이유: "):
        return None
    i = 5 if blocks[4][0] == "paragraph" and blocks[4][1].startswith("관련: ") else 4
    last = blocks[-1]
    if last[0] != "paragraph" or not plan_mod().MARKER.fullmatch(last[1]):
        return None
    return blocks[:3], blocks[3:i], blocks[i:-1], blocks[-1:]


def _o_part(blocks):
    """설명 블록 열 → O(원문) 블록 목록, P 자리(4·5·11) 모양이 틀리면 None."""
    parts = _split_op(blocks)
    return None if parts is None else parts[0] + parts[2]


def ticket_check(c, key, mode, expected_payload_bytes, acct, repo_url, n):
    """design §4 ticket_check(KEY, mode) → None(통과) 또는 한국어 불일치 이유. 404·다른 프로젝트·키가 바뀜 = "없음".
    통과 = ours(보고자 == acct · 마지막 블록 MARKER, group1 == `GitHub issue #N` · 블록 1 = 이 이슈 URL) + summary == 승인본
    summary + 블록 열: mode "full"(이 계획 payload로 만든 티켓) = 전부 정확히 같음, "orig"(다른 계획이 만든 티켓) = O 블록
    전부 같고 P 자리(4·5·11)는 모양만. 블록 비교 = (종류, 글) 정확히(엄격 parse_blocks — 모르는 노드 = 불일치).
    담당자는 보지 않는다 — 팀이 옮겨진 티켓을 배정·분류해도 C1·verify #3은 실패하지 않는다(담당자 없음 확인은 이 실행이 만든
    직후 한 번, Apply.mv_f — contract §6).
    expected_payload_bytes = 승인 payload 바이트(None = 다시 만들 수 없음 → 불일치). 읽기 실패 = JiraError."""
    plan = plan_mod()
    exp = None
    if expected_payload_bytes is not None:
        exp = json.loads(expected_payload_bytes.decode("utf-8"))["fields"]
    tk = ticket_view(c, key)
    if tk is None or tk["key"] != key or (exp is not None and tk["project_id"] != exp["project"]["id"]):
        return "없음"
    if exp is None:
        return "승인본을 지금 이슈 내용으로 다시 만들 수 없음"
    blocks = tk["blocks"]
    if blocks is None:
        return "설명에 모르는 블록이 있음"
    if tk["reporter"] != acct:
        return "보고자가 이 계정이 아님"
    if not plan.chore_shaped(blocks):
        return "마지막 블록이 chore 표지가 아님"
    if blocks[0] != ("paragraph", plan.move_url_line(repo_url, n)):
        return "블록 1이 이 이슈 주소가 아님"
    if plan.MARKER.fullmatch(blocks[-1][1]).group(1) != f"GitHub issue #{n}":
        return "표지가 다른 이슈를 가리킴"
    if tk["summary"] != exp["summary"]:
        return "요약이 승인본과 다름"
    want = _blocks(exp["description"], False)
    if mode == "full":
        if len(blocks) != len(want):
            return f"설명 블록 수가 승인본과 다름 ({len(blocks)} ≠ {len(want)})"
        for i, (x, y) in enumerate(zip(blocks, want), 1):
            if x != y:
                return f"설명 블록 {i}이 승인본과 다름"
        return None
    o, wo = _o_part(blocks), _o_part(want)
    if o is None:
        return "설명의 계획 부분(남기는 이유·관련·표지) 모양이 틀림"
    if o != wo:
        return "설명의 원문 부분이 승인본과 다름"
    return None


def rebuilt_payload(tk, snap):
    """저장된 티켓(엄격 블록·요약) + 계획 필드(project_id·issuetype·account)로 POST 본문을 다시 만든다 —
    chore_plan.payload_bytes(…, doc_from_blocks(parse_blocks(설명))) (필드 집합·인코더는 chore_plan 한 벌). sha256 == snap
    payload_sha이면 이 티켓이 승인 payload 그대로다(이슈가 그 뒤 바뀌어 지금 내용으로는 승인본을 못 만들 때 full 모드
    C1·verify #3이 쓴다). 블록을 엄격하게 못 읽거나 다시 만들 수 없으면 None. tk["blocks"] = _ticket의 엄격 parse_blocks."""
    plan = plan_mod()
    if tk is None or tk["blocks"] is None:
        return None
    try:
        return plan.payload_bytes(snap["project_id"], snap["issuetype"], tk["summary"], snap["account"],
                                  plan.doc_from_blocks(tk["blocks"]))
    except plan.PlanError:
        return None


def rebuilt_orig_payload(tk, want_payload, snap):
    """orig 모드(다른 계획이 만든 티켓): 티켓의 O 블록 + 이 계획의 P 블록(4·5·11 — 이유·관련·표지, 이슈 내용과 무관하므로
    지금 만든 payload 쪽에서 가져온다) + 티켓 요약 → chore_plan.payload_bytes(…, doc_from_blocks(이은 블록)). sha256 == snap
    payload_sha이면 티켓의 O(와 요약)가 승인본 O 그대로다 — 이슈가 닫힌 뒤 바뀌어도 C1·verify #3이 통과하고 C2·verify #7·#8이
    본다. 블록·모양을 못 읽으면 None."""
    plan = plan_mod()
    if tk is None or tk["blocks"] is None or want_payload is None:
        return None
    mine = _split_op(tk["blocks"])
    want = _split_op(_blocks(json.loads(want_payload.decode("utf-8"))["fields"]["description"], False) or [])
    if mine is None or want is None:
        return None
    try:
        return plan.payload_bytes(snap["project_id"], snap["issuetype"], tk["summary"], snap["account"],
                                  plan.doc_from_blocks(mine[0] + want[1] + mine[2] + want[3]))
    except plan.PlanError:
        return None


def issue_check(view, snap, mv, R, plan_date, repo_url):
    """design §4 issue_check(view, snap, R, closed_at): closed_at = CLOSED면 view의 closed_at. 반환
    {"recorded_bad": [(key, cid)](R 중 없거나 본문 sha ≠ csha), "valid": {(key, cid): csha}(지금 본문 일치),
     "carry": 옮길 댓글(view 댓글 − 본문 일치하는 R 댓글 − closed_at 뒤에 만든 댓글), "after_close": closed_at 뒤 새 댓글 수,
     "source_sha", "payload"(move_payload 바이트), "payload_sha", "trunc", "content_ok", "m"(KEY → 본문 일치 R 댓글 수)}.
    content_ok = source_sha == snap source_sha 그리고 payload sha == snap payload_sha. 지금 내용으로 move_payload를 만들 수 없으면
    (PlanError) payload None · content_ok False. build는 snap에 project_id·issuetype·account만 주고 payload·source_sha를 쓴다."""
    plan = plan_mod()
    closed_at = view["closed_at"] if view["state"] == "CLOSED" else None
    by_id = {cm["id"]: cm for cm in view["comments"]}
    bad, valid, changed = [], {}, []
    for (k, cid), csha in R.items():
        cm = by_id.get(cid)
        if cm is None or sha_text(cm["body"]) != csha:
            bad.append((k, cid))
            if cm is not None:
                changed.append((k, cid))
        else:
            valid[(k, cid)] = csha
    ok_ids = {cid for _k, cid in valid}
    carry, after = [], 0
    for cm in view["comments"]:
        if cm["id"] in ok_ids:
            continue
        if closed_at is not None and parse_ts(cm["created"]) > parse_ts(closed_at):
            after += 1
            continue
        carry.append(cm)
    issue = {"number": view["number"], "title": view["title"], "body": view["body"], "author": view["author"],
             "created": view["created"], "labels": list(view["labels"]),
             "comments": [{"author": cm["author"], "created": cm["created"], "body": cm["body"]} for cm in carry]}
    try:
        ssha = plan.source_sha(issue)
        payload, trunc = plan.move_payload(issue, repo_url, snap, mv["reason"], mv["related"], plan_date)
    except plan.PlanError:
        ssha = payload = trunc = None
    psha = hashlib.sha256(payload).hexdigest() if payload is not None else None
    ok = ssha is not None and ssha == snap.get("source_sha") and psha == snap.get("payload_sha")
    return {"recorded_bad": sorted(bad, key=lambda x: (key_order(x[0]), int(x[1]))), "changed": changed, "valid": valid,
            "carry": carry,
            "after_close": after, "source_sha": ssha, "payload": payload, "payload_sha": psha, "trunc": trunc,
            "content_ok": ok, "m": lambda key: sum(1 for k, _c in valid if k == key)}


def bad_reason(ic):
    """recorded_bad의 고정 이유: 있지만 본문이 다른 R 댓글이 하나라도 있으면 M7(바뀜), 아니면 M6(지워짐)."""
    return M7 if ic["changed"] else M6


def expected_payload(c, key, mode, ic, snap):
    """ticket_check에 줄 승인 payload 바이트: 지금 이슈 내용이 승인본이면(content_ok) 지금 만든 바이트, 아니면 저장된 티켓으로
    다시 만든 바이트(full = rebuilt_payload, orig = rebuilt_orig_payload)가 payload_sha와 같을 때 그것(티켓은 승인본 그대로 —
    바뀐 것은 이슈, C2·verify #7·#8이 본다). 그 밖 = 지금 내용으로 만든 바이트(불일치로 읽힌다 — 결정 필요 쪽으로 닫힌다)."""
    if ic["content_ok"]:
        return ic["payload"]
    tk = ticket_view(c, key)
    rb = rebuilt_payload(tk, snap) if mode == "full" else rebuilt_orig_payload(tk, ic["payload"], snap)
    if rb is not None and hashlib.sha256(rb).hexdigest() == snap["payload_sha"]:
        return rb
    return ic["payload"]


def load_plan(args):
    """계획 + 바인딩 + 바인딩 검사 → (plan bytes, hdr, 모든 행, jira-transition 행, move-issue 행, binding). 실패 = Stop(1).
    jira 행·move-issue 행이 있는데 바인딩이 없으면 거절."""
    plan = plan_mod()
    try:
        data = Path(args.plan).read_bytes()
    except OSError as e:
        raise Stop(1, f"계획을 읽을 수 없음 ({type(e).__name__})") from None
    try:
        hdr, rows = plan.parse_plan(data)
    except plan.PlanError as e:
        raise Stop(1, f"계획 오류: {e}") from None
    if hdr["remote"].casefold() != str(args.remote).casefold():
        raise Stop(1, f"계획의 저장소({hdr['remote']})가 --remote({args.remote})와 다름")
    try:
        binding = read_binding(args.repos_md, args.remote)
    except BindingError as e:
        raise Stop(1, f"바인딩 오류: {e}") from None
    if binding is None:
        if any(r.get("jira") or r.get("move") for r in rows):
            raise Stop(1, "repos.md에 이 저장소의 Jira 바인딩(jira=)이 없음")
    else:
        try:
            plan.check_jira_binding(rows, binding["site"], binding["project"], binding["qa"], binding["closed"])
        except plan.PlanError as e:
            raise Stop(1, f"바인딩 불일치: {e}") from None
    jrows = [r for r in rows if r["action"] == plan.JIRA_ACTION]
    mrows = [r for r in rows if r["action"] == plan.MOVE_ACTION]
    return data, hdr, rows, jrows, mrows, binding


def _client_for(binding):
    try:
        return client(binding["site"])
    except JiraError as e:
        raise Stop(AUTH if e.code == AUTH else 1, e.message) from None


def _read_file(path, missing_ok):
    try:
        return Path(path).read_bytes()
    except FileNotFoundError:
        if missing_ok:
            return b""
        raise Stop(1, f"파일 없음: {os.path.basename(path)}") from None
    except OSError as e:
        raise Stop(READ, f"파일을 읽을 수 없음 ({type(e).__name__}): {os.path.basename(path)}") from None


def repair_journal(j, attempt):
    """일지가 \\n으로 끝나지 않으면 마지막 \\n 뒤 바이트(없으면 파일 전체)를 <journal>.torn-<attempt>로 옮기고 거기서 자른다.
    (apply와 resolve가 락을 잡은 뒤 부른다.)"""
    data = _read_file(j, missing_ok=True)
    if not data or data.endswith(b"\n"):
        return
    cut = data.rfind(b"\n") + 1
    torn = f"{j}.torn-{attempt}"
    try:
        fd = os.open(torn, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_CLOEXEC", 0), 0o600)
        try:
            _write_all(fd, data[cut:])     # 끝까지 쓰고 fsync한 다음에야 일지를 자른다
            os.fsync(fd)
        finally:
            os.close(fd)
        dfd = os.open(os.path.dirname(os.path.abspath(j)), os.O_RDONLY)   # .torn 파일의 이름도 디스크에 남긴 뒤
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        fd = os.open(j, os.O_WRONLY | getattr(os, "O_CLOEXEC", 0))
        try:
            os.ftruncate(fd, cut)
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as e:
        raise Stop(READ, f"잘린 일지를 고칠 수 없음 ({type(e).__name__})") from None
    _note(f"일지 끝의 잘린 줄 {len(data) - cut}바이트를 {os.path.basename(torn)}로 옮기고 일지를 줄 끝에서 자름")


def take_project_lock(binding, who):
    """사용자별 프로젝트 락 ~/.cache/chore/jira-<site 소문자>-<project>.lock (apply·resolve 공용). 잡힘 = Stop(7)."""
    home = os.path.expanduser("~")
    if home.startswith("~"):
        raise Stop(READ, "HOME을 알 수 없어 프로젝트 락을 잡을 수 없음")
    site, project = binding["site"].lower(), binding["project"]   # 호스트 이름은 대소문자 무관
    pdir = os.path.join(home, ".cache", "chore")
    try:
        os.makedirs(pdir, mode=0o700, exist_ok=True)
    except OSError as e:
        raise Stop(READ, f"프로젝트 락 폴더를 만들 수 없음 ({type(e).__name__})") from None
    held = f"같은 Jira 프로젝트({site}/{project})를 다른 apply가 쓰는 중 — 끝난 뒤 다시 실행"
    if who == "resolve":
        held = f"같은 Jira 프로젝트({site}/{project})를 apply가 쓰는 중 — 끝난 뒤 resolve"
    return Apply._flock(os.path.join(pdir, f"jira-{site}-{project}.lock"), held)


# --- apply-rows (design §2, §4) ---
class Apply:
    def __init__(self, args):
        self.args, self.stop, self.breaker, self.lock_fd, self.c = args, False, False, None, None

    def on_signal(self, signum, frame):
        self.stop = True          # HTTP 호출 안에서 예외를 던지지 않는다 — 지금 호출의 결과는 평소 경로로 일지에 남는다

    def load(self):
        a = self.args
        if not ATTEMPT_RE.fullmatch(a.attempt):
            raise Stop(1, "사용법 오류: --attempt는 YYYYMMDDTHHMMSSZ-<8 hex>")
        if a.parent_pid <= 1:
            raise Stop(1, "사용법 오류: --parent-pid는 chore.sh의 pid")
        self.data, self.hdr, self.all_rows, self.rows, self.mrows, self.binding = load_plan(a)
        self.lines = self.data.split(b"\n")
        self.approved = {r["ref"] for r in self.rows}
        for r in self.rows:
            try:
                check_comment_text(r["evidence"])
            except JiraError as e:
                raise Stop(1, f"계획 오류: {r['ref']} {e.message}") from None
        if self.rows and not os.path.isfile(a.judge):
            raise Stop(1, "사용법 오류: --judge 파일이 없음")
        # move-issue 행: sid의 run_id = 일지 파일 이름 — 계획 run_id와 같아야 일지가 한 벌로 읽힌다
        self.run_id, self.seq = self.hdr["run_id"], 0
        self.chore_dir = os.path.dirname(os.path.abspath(a.journal))
        self.remote = self.hdr["remote"]
        self.repo_url = "https://github.com/" + self.remote
        self.repo_name = self.remote.split("/", 1)[-1]
        if self.mrows:
            if os.path.basename(a.journal) != self.run_id + ".journal":
                raise Stop(1, f"사용법 오류: --journal 이름이 계획 run_id({self.run_id}).journal이 아님")
            if not GH_REPO.fullmatch(self.remote):
                raise Stop(1, "계획 오류: remote가 owner/repo 모양이 아님")
            for r in self.mrows:
                mv = r["move"]
                if not ACCT_RE.fullmatch(mv["account"]) or not LOGIN_RE.fullmatch(mv["gh_login"]):
                    raise Stop(1, f"계획 오류: {r['ref']} account·gh_login을 일지에 적을 수 없는 모양")

    def checkpoint(self):
        if self.stop:
            raise Stop(8, "중단 신호를 받음 — 다음 단계를 시작하지 않음")
        if not parent_alive(self.args.parent_pid):
            raise Stop(8, "부모 프로세스(chore.sh)가 없음 — 쓰기를 멈춤")

    def before_sent(self):
        delay = os.environ.get("CHORE_JIRA_TEST_DELAY")
        if delay:
            time.sleep(float(delay))
        self.checkpoint()

    @staticmethod
    def _flock(path, held):
        """path를 열어(없으면 만들 뿐, 지우거나 다시 만들지 않는다) LOCK_EX|LOCK_NB, fd는 상속 안 됨, 프로세스가
        끝날 때까지 쥔다. 다른 프로세스가 쥐고 있으면 Stop(7, held)."""
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)
            os.set_inheritable(fd, False)
        except OSError as e:
            raise Stop(READ, f"락 파일을 열 수 없음 ({type(e).__name__})") from None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise Stop(7, held) from None
        except OSError as e:
            raise Stop(READ, f"락을 잡을 수 없음 ({type(e).__name__})") from None
        return fd

    def take_lock(self):
        """계획 락(--lock), 그다음 사용자별 프로젝트 락 — 다른 계획의 apply가 같은 Jira 프로젝트를 동시에 쓰지 않게."""
        try:
            os.makedirs(os.path.dirname(os.path.abspath(self.args.lock)), exist_ok=True)
            os.makedirs(os.path.dirname(os.path.abspath(self.args.journal)), exist_ok=True)
        except OSError as e:
            raise Stop(READ, f"락 폴더를 만들 수 없음 ({type(e).__name__})") from None
        self.lock_fd = self._flock(self.args.lock, "다른 apply가 이 계획으로 Jira를 쓰는 중 — 끝난 뒤 다시 실행")
        self.project_lock_fd = take_project_lock(self.binding, "apply")

    def repair(self):
        repair_journal(self.args.journal, self.args.attempt)

    def journal(self, ref, event, cid=None, fields=None):
        """한 줄 = 쓰기 1번 + fsync. 실패하면 Stop — 그 뒤의 HTTP 호출은 하지 않는다. fields = move 줄의 [(k, v)…]
        (` k=v`로 이어 붙임, mv_line이 문법을 확인) — 없으면 기존 jira-transition 줄과 바이트까지 같다."""
        if fields is not None:
            line = mv_line(now_instant(), self.args.attempt, ref, event, fields)
        else:
            line = f"{now_instant()} {self.args.attempt} {ref} {event}" + (f" {cid}" if cid else "") + "\n"
        append_line(self.args.journal, line)
        self.test_hook(event)

    def test_hook(self, event):
        """테스트 전용: CHORE_JIRA_TEST_KILL_AFTER / _TERM_AFTER == event면 자기에게 SIGKILL / SIGTERM(처리기가 돌 때까지
        기다림). event = 방금 fsync한 일지 사건, 또는 일지 줄 없는 지점: "mv-create-posted"·"mv-comment-posted"(HTTP·gh 응답을
        받은 직후, 결과 줄 앞) · "mv-close"(닫기 직전 검사 바로 앞) · "mv-gh-closed"(gh issue close 직후, 다시 읽기·mv-closed
        줄 앞). "mv-closed"는 일지 사건(닫힘을 다시 읽어 확인한 뒤의 줄)."""
        if os.environ.get("CHORE_JIRA_TEST_KILL_AFTER") == event:
            os.kill(os.getpid(), signal.SIGKILL)
        if os.environ.get("CHORE_JIRA_TEST_TERM_AFTER") == event:
            os.kill(os.getpid(), signal.SIGTERM)
            until = time.monotonic() + 2
            while not self.stop and time.monotonic() < until:
                time.sleep(0.001)

    def send_or_withdraw(self, ref, kind, fields=None, sid=None):
        """*-sent를 적고(fsync) 바로 중단 신호를 본다: 켜져 있으면 *-withdrawn을 적고 exit 8 — 요청은 나가지 않았다.
        move 종류(mv-create, mv-comment)는 sent에 fields, withdrawn에 sid= 하나."""
        self.journal(ref, kind + "-sent", fields=fields)
        if self.stop:
            self.journal(ref, kind + "-withdrawn", fields=None if sid is None else [("sid", sid)])
            raise Stop(8, "중단 신호를 받음 — 보냄을 적었지만 요청은 내보내지 않음(철회로 기록)")

    def read_journal(self):
        lines, torn = split_journal(_read_file(self.args.journal, missing_ok=True))
        try:
            if torn:
                raise FormatError("일지 끝이 잘림(락을 잡은 뒤)")
            return parse_journal(lines, self.approved)
        except FormatError as e:
            raise Stop(READ, f"{FORMAT}: {e}") from None

    def read(self, fn, *a):
        try:
            return fn(self.c, *a)
        except JiraError as e:
            if self.stop:
                raise Stop(8, "중단 신호를 받음 — 읽기 중단") from None
            raise Stop(AUTH if e.code == AUTH else READ, f"{a[0] if a else fn.__name__}: {e.message}") from None

    def emit(self, res, ref, reason, action="jira-transition"):
        line = "\t".join(("RESULT", res, action, ref, one_line(reason), "attempt=" + self.args.attempt))
        try:
            sys.stdout.buffer.write(line.encode("utf-8") + b"\n")
            sys.stdout.buffer.flush()
        except OSError:
            raise Stop(8, "결과를 쓸 수 없음(부모 쪽 파이프가 닫힘)") from None

    def recheck(self, row):
        """step 10: 0 = 증거 유지, 10 = 증거 깨짐(stdout 첫 줄 = 이유) → 이유 문자열, 그 밖 = Stop(6)."""
        a = self.args
        cmd = [sys.executable, "-I", a.judge, "recheck", "--clone", a.clone, "--remote", a.remote,
               "--repos-md", a.repos_md] + (["--repo", a.repo] if a.repo else [])
        stdin = self.lines[0] + b"\n" + self.lines[row["line"] - 1] + b"\n"
        try:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            raise Stop(READ, f"증거 재확인을 시작할 수 없음 ({type(e).__name__})") from None
        deadline, inp = time.monotonic() + RECHECK_TIMEOUT, stdin
        while True:
            try:
                out, err = p.communicate(inp, timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                inp = None
                gone = self.stop or not parent_alive(a.parent_pid)
                if gone or time.monotonic() > deadline:
                    p.kill()
                    p.communicate()
                    if gone:
                        raise Stop(8, "중단 — 증거 재확인을 멈춤") from None
                    raise Stop(READ, "증거 재확인 시간 초과") from None

        def first(b):
            return (b.decode("utf-8", "replace").strip().splitlines() or [""])[0].strip()
        if p.returncode == 0:
            return None
        if p.returncode == 10:
            return one_line(first(out))[:300] or "증거 재확인에서 깨짐"
        raise Stop(READ, f"증거 재확인 실패 (종료 코드 {p.returncode}): {first(err)}")

    def row(self, row):
        """design §4 steps 1–13, 처음 맞는 것이 결정. 반환 (result, reason); 단계 전체를 멈출 때는 Stop."""
        snap, key, ref = row["snapshot"], row["jira"]["key"], row["ref"]
        self.checkpoint()                                                         # 1
        account = self.read(myself)["account"]
        v = self.read(view, key)
        cs = self.read(comments, key)
        cl = self.read(changelog, key, row["expected"])
        tr = self.read(transitions, key)
        jf = journal_facts(self.read_journal(), ref)
        lf = live_facts(row, self.hdr, jf, account, v, cs, cl)
        base = fingerprint(v, lf)
        idw = identity_diff(v, snap, key)
        if idw:                                                                   # 2
            return "SKIP", "identity: 티켓 신원이 계획과 다름 — " + idw
        why = manual_why(lf)
        if why:                                                                   # 3
            return "SKIP", "manual: 정리 댓글이 예상과 다름 — " + ", ".join(why)
        if lf["moved"]:                                                           # 4
            return "OK", f"already-done: 이미 {v['status_name']} 상태이고 승인 댓글이 있음 — 쓰기 없음"
        if not lf["C"] and jf["maybe_comment"]:                                   # 5
            return "SKIP", "manual: 댓글을 보냈지만 지금 안 보임 — 다시 달지 않음"
        if v["status_id"] == snap["to_status"]:                                   # 6
            return "SKIP", "at-target: 이미 목표 상태 — 이번 실행이 한 것 아님"
        if v["assignee"] != account:                                              # 7
            return "SKIP", "assignee: 담당자가 이 계정이 아님"
        if account != snap["account"]:
            return "SKIP", "assignee: 실행 계정이 계획의 계정과 다름"
        if v["status_id"] != snap["status"] or lf["delta"]:                       # 8
            what = ([f"상태 {snap['status_name']} → {v['status_name']}"] if v["status_id"] != snap["status"] else []) \
                + lf["delta"]
            return "SKIP", "changed: 계획 뒤에 티켓이 바뀜 — " + describe(what)
        if lf["unexplained"]:                                                     # 9
            return "SKIP", "manual: 갱신 시각만 바뀜 — 원인 미확인"
        proof = self.recheck(row)                                                 # 10
        if proof is not None:
            return "SKIP", f"proof: {proof} ({'우리 댓글 있음' if lf['C'] else '우리 댓글 없음'})"
        if not any(t["id"] == snap["to"] and t["to_id"] == snap["to_status"] for t in tr):   # 11
            return "SKIP", f"transition: {snap['to_name']}(으)로 옮기는 전환이 지금 없음"
        skip = self.still_same(row, account, base)    # 증거 재확인은 오래 걸릴 수 있다 — 쓰기 직전에 다시 읽는다
        if skip is not None:
            return skip
        if not lf["C"]:                                                           # 12
            out = self.post_comment(row, account, v)
            if out is not None:
                return out
        return self.move(row)                                                     # 13

    def still_same(self, row, account, base):
        """첫 쓰기(comment-sent, 이어 하기면 transition-sent) 직전: view·comments·changelog를 다시 읽어 step 1과
        상태·updated·C id(이어 하기면 같은 댓글)·M·Δ가 같은지 본다. 다르면 SKIP changed, 같으면 None."""
        key, ref = row["jira"]["key"], row["ref"]
        v = self.read(view, key)
        cs = self.read(comments, key)
        cl = self.read(changelog, key, row["expected"])
        lf = live_facts(row, self.hdr, journal_facts(self.read_journal(), ref), account, v, cs, cl)
        now = fingerprint(v, lf)
        diff = [k for k in base if base[k] != now[k]]
        if diff:
            return "SKIP", "changed: 확인하는 동안 티켓이 바뀜 — " + ", ".join(diff) + " 다름, 쓰기 없음"
        return None

    def post_comment(self, row, account, v0):
        key, ref = row["jira"]["key"], row["ref"]
        self.before_sent()
        self.send_or_withdraw(ref, "comment")
        try:
            got = comment(self.c, key, row["evidence"])
        except JiraError as e:
            if e.code == REJECTED:
                self.journal(ref, "comment-rejected")
                return "FAIL", "comment-rejected: 댓글 거부됨, 변경 없음 — " + e.message
            if e.code == AUTH:             # 401/403 = 거부(적용 안 됨): 먼저 일지에 남기고 단계를 멈춘다
                self.journal(ref, "comment-rejected")
                raise Stop(AUTH, "comment: 인증 실패") from None
            return "UNKNOWN", "댓글을 보냈지만 결과 미확정 — " + e.message
        if not CID_RE.fullmatch(got["id"]):
            return "UNKNOWN", "댓글 응답의 id 형식이 이상함 — 결과 미확정"
        self.journal(ref, "comment-ok", got["id"])
        if self.stop:
            raise Stop(8, "중단 신호를 받음 — 댓글은 게시됨, 옮기지 않음")
        v = self.read(view, key)
        cs = self.read(comments, key)
        cl = self.read(changelog, key, row["expected"])
        jf = journal_facts(self.read_journal(), ref)
        lf = live_facts(row, self.hdr, jf, account, v, cs, cl, exclude={got["id"]})
        foreign = ([f"상태 {v0['status_name']} → {v['status_name']}"] if v["status_id"] != v0["status_id"] else []) \
            + lf["delta"]
        if foreign:
            return "FAIL", "changed-after-comment: 댓글 게시 후 다른 변경 발생, 옮기지 않음 — " + describe(foreign)
        mine = next((cm for cm in cs if cm["id"] == got["id"]), None)
        why = "게시한 댓글 id가 목록에 없음" if mine is None else \
            c_failure(mine, account, row["evidence"], parse_ts(self.hdr["created"]))
        if why:
            self.breaker = True
            return "FAIL", "changed-after-comment: 게시된 댓글이 승인본 조건과 다름: " + why
        if len(lf["C"]) != 1:
            return "FAIL", f"changed-after-comment: 승인 댓글이 {len(lf['C'])}개 — 옮기지 않음"
        return None

    def move(self, row):
        snap, key, ref = row["snapshot"], row["jira"]["key"], row["ref"]
        self.before_sent()
        self.send_or_withdraw(ref, "transition")
        try:
            transition(self.c, key, snap["to"])
        except JiraError as e:
            if e.code == REJECTED:
                self.journal(ref, "transition-rejected")
                return "FAIL", "transition-rejected: 옮기기 거부됨 — " + e.message
            if e.code == AUTH:
                self.journal(ref, "transition-rejected")
                raise Stop(AUTH, "transition: 인증 실패") from None
            return "UNKNOWN", "옮기기를 보냈지만 결과 미확정 — " + e.message
        self.journal(ref, "transition-ok")
        return "OK", f"moved: {snap['status_name']} → {snap['to_name']}"

    # --- move-issue 행 (design v9 §6: A0 → A1 → A2 → F → C) ---
    def jr(self, what, fn, *a):
        """Jira 읽기(self.c 첫 인자). 실패 → Stop(5 인증 · 8 중단 중 · 6 그 밖)."""
        try:
            return fn(self.c, *a)
        except JiraError as e:
            if self.stop:
                raise Stop(8, "중단 신호를 받음 — 읽기 중단") from None
            raise Stop(AUTH if e.code == AUTH else READ, f"{what}: {e.message}") from None

    def gr(self, what, fn, *a):
        """GitHub(gh) 읽기. 실패 → Stop(6), 중단 중이면 8."""
        try:
            return fn(*a)
        except GhError as e:
            if self.stop:
                raise Stop(8, "중단 신호를 받음 — 읽기 중단") from None
            raise Stop(READ, f"{what}: {e}") from None

    def hist(self, ref):
        try:
            return move_history(self.chore_dir, ref, self.run_id)
        except FormatError as e:
            raise Stop(READ, f"{FORMAT}: {e}") from None

    def wait(self, seconds):
        """J2 다시 찾기 간격 — 조각으로 쉬며 중단 신호·부모 생존을 본다."""
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            self.checkpoint()
            time.sleep(min(0.05, max(0.0, until - time.monotonic())))
        self.checkpoint()

    def mv_send(self, ref, kind, fields):
        """before_sent → `<kind>-sent seq=…` (fsync) → 중단이면 withdrawn + exit 8. 반환 sid."""
        self.before_sent()
        self.seq += 1
        sid = f"{self.run_id}/{self.args.attempt}/{self.seq}"
        self.send_or_withdraw(ref, kind, [("seq", str(self.seq))] + fields, sid)
        return sid

    def candidates(self, row, h):
        src = self.jr("출처 B 검색", source_b, self.binding["project"], self.repo_name)
        return self.jr("후보 티켓", live_candidates, h, src, row["move"]["account"], self.repo_url, row["move"]["number"])

    def mrow(self, row):
        """move-issue 행 하나 → (결과, 이유). 막히면 거기서 끝. 단계 전체를 멈출 때는 Stop(차단기 = self.breaker)."""
        mv, ref, n = row["move"], row["ref"], row["move"]["number"]
        self.checkpoint()
        account = self.jr("myself", myself)["account"]                                      # A0
        login = self.gr("gh 로그인", gh_login)
        if account != mv["account"] or login != mv["gh_login"]:
            return "SKIP", "account: " + MT_ACCOUNT
        h = self.hist(ref)                                                                   # A1
        if h["pending_creates"]:
            out = self.j2(row, h)
            if out is not None:
                return out
            h = self.hist(ref)                       # 복구 줄을 쓴 직후 다시 계산
        adopt = mv["adopt"]                                                                  # A2
        if adopt is not None and self.jr(adopt, ticket_view, adopt) is None:
            return "SKIP", f"manual: {adopt} — " + M3
        T, b, _c, gone = self.candidates(row, h)
        # E1: 404인 chore KEY가 아직 확인을 마친 적이 없고 이 계획의 보고(머리 줄 created=) 뒤에 만든 전송의 것이면 "지워짐"이
        # 아니다 — 어느 계획이 만들었든(이 계획의 build는 그 KEY를 본 적이 없다). 보고 전에 만든 KEY는 build가 판단했다 → 지워짐.
        # created=는 parse_plan(parse_header)이 UTC 시각 YYYY-MM-DDTHH:MM:SSZ로 보장한다(아니면 load에서 exit 1, Jira 전).
        # 이 계획이 만든 KEY는 시계와 무관하게 막는다(소유) — 보고 뒤 시계가 뒤로 가 at < created=여도 둘째 티켓을 만들지 않게.
        # 시각(at ≥ created=)은 그 막음을 다른 계획의 KEY로 넓힌다(contract round 4b·4d).
        reported = parse_ts(self.hdr["created"])
        for key in gone:
            if needs_post_create_check(h, key) and (h["keys"][key]["run_id"] == self.run_id
                                                     or parse_ts(h["keys"][key]["at"]) >= reported):
                self.breaker = True                  # Jira 404는 지워짐과 못 읽음을 가르지 못한다 — 재실행이 둘째 티켓을 만들지 않게
                self.breaker_msg = f"만든 뒤 확인하지 못한 티켓 {key}: 만든 티켓을 다시 읽지 못함(없음) — Jira 단계를 멈춤"
                _note(f"{ref}: {self.breaker_msg}")
                return "SKIP", f"manual: {key} — " + M20
        if b:
            return "SKIP", "exists: " + MT_EXISTS + ", ".join(b)
        K = sorted(set(T) | ({adopt} if adopt else set()), key=key_order)
        if len(K) >= 2:
            _note(f"{ref}: 이 이슈의 티켓 {', '.join(K)}")
            return "SKIP", "manual: " + M4
        if len(K) == 1:
            mode = "full" if h["keys"].get(K[0], {}).get("run_id") == self.run_id else "orig"
            return self.mv_c(row, K[0], mode, h, None)
        if h["pending_comments"]:                    # 지워진 티켓의 미결 댓글 — 새 티켓을 만들기 전에 사람이 resolve
            return "SKIP", "manual: " + M17
        return self.mv_f(row, h)

    def j2(self, row, h):
        """A1 J2: 미결 create의 신원만 확인(내용은 KEY가 정해진 뒤 C1). 정확히 1개 미결 · created_by 티켓 정확히 1개 →
        mv-create-found, 그 밖 → SKIP manual. 0개면 J2_SLEEP초 간격으로 최대 3번 다시 찾는다."""
        mv, ref, n = row["move"], row["ref"], row["move"]["number"]
        why = "manual: " + M1
        if len(h["pending_creates"]) != 1:
            return "SKIP", why
        sid = h["pending_creates"][0]
        try:
            pause = float(os.environ.get("CHORE_JIRA_J2_SLEEP", J2_SLEEP))
        except ValueError:
            pause = J2_SLEEP
        for i in range(J2_TRIES):
            src = self.jr("출처 B 검색", source_b, self.binding["project"], self.repo_name)
            found = [t for t in src if created_by(t, h["sends"][sid], self.repo_url, n, h)]
            if found or i == J2_TRIES - 1:
                break
            self.wait(pause)
        if len(found) != 1:
            return "SKIP", why
        self.journal(ref, "mv-create-found", fields=[("of", sid), ("key", found[0]["key"])])
        return None

    def mv_f(self, row, h):
        """F (|K| == 0): createmeta → F1 → F2 → mv-create-sent → POST(승인 payload 바이트) → mv-create-ok → C(full)."""
        mv, snap, ref, n = row["move"], row["snapshot"], row["ref"], row["move"]["number"]
        why = self.jr("createmeta", createmeta_ok, mv["project_id"], mv["issuetype"])
        if why is not None:
            return "SKIP", "type: " + MT_TYPE + why
        view = self.gr(f"issue #{n}", gh_issue, self.remote, n)                             # F1
        ic = issue_check(view, snap, mv, h["R"], mv["plan_date"], self.repo_url)
        if view["state"] != "OPEN" or view["updated"] != row["expected"] or not ic["content_ok"]:
            return "SKIP", "changed: " + MT_CHANGED
        T, b, _c, _gone = self.candidates(row, h)                                             # F2
        if T or b:
            return "SKIP", "exists: " + MT_EXISTS + ", ".join(sorted(set(T) | set(b), key=key_order))
        payload = ic["payload"]                      # sha256 == snap payload_sha (content_ok)
        sid = self.mv_send(ref, "mv-create", [("acct", mv["account"])])
        try:
            _st, d = self.c.call("POST", "/rest/api/3/issue", write=True, body=payload)
            self.test_hook("mv-create-posted")
        except JiraError as e:
            if e.code == AUTH:                       # 401/403 = 만들어지지 않음: 먼저 일지에 남기고 단계를 멈춘다
                self.journal(ref, "mv-create-rejected", fields=[("sid", sid)])
                raise Stop(AUTH, "issue create: 인증 실패") from None
            if e.code == REJECTED and e.status != 429:   # 400·404·422 등 = 티켓 없음(확정); 429는 미결
                self.journal(ref, "mv-create-rejected", fields=[("sid", sid)])
                return "FAIL", "create-rejected: " + MT_REJECTED % e.status
            return "UNKNOWN", MT_UNKNOWN_CREATE     # 429·5xx·3xx·시간 초과·연결 끊김 = 결과 줄 없음(미결)
        key = d.get("key") if isinstance(d, dict) else None
        if not (isinstance(key, str) and MV_KEY_RE.fullmatch(key) and key.rsplit("-", 1)[0] == self.binding["project"]):
            return "UNKNOWN", MT_UNKNOWN_CREATE     # 응답 키를 믿을 수 없음 — 다음 실행의 J2가 신원으로 찾는다
        self.journal(ref, "mv-create-ok", fields=[("sid", sid), ("key", key)])
        if self.stop:
            raise Stop(8, f"중단 신호를 받음 — 티켓 {key}는 만듦, 이슈는 닫지 않음")
        return self.mv_c(row, key, "full", self.hist(ref), payload, fresh=True)


    def c1(self, row, key, mode, h, ic, exp):
        """C1 ticket_check(KEY, mode) → None 또는 SKIP manual(full = 이 계획이 만든 티켓이면 차단기)."""
        mv, n = row["move"], row["move"]["number"]
        acct = h["keys"][key]["acct"] if key in h["keys"] else mv["account"]
        if exp is None:
            exp = self.jr(key, expected_payload, key, mode, ic, row["snapshot"])
        why = self.jr(key, ticket_check, key, mode, exp, acct, self.repo_url, n)
        if why is None:
            return None, exp
        if mode == "full":
            self.breaker = True
            self.breaker_msg = f"이 계획이 만든 티켓 {key}가 승인본과 다름({why}) — 체계적 저장 차이일 수 있어 Jira 단계를 멈춤"
        _note(f"{row['ref']}: 티켓 {key}가 승인본과 다름 — {why}")
        return ("SKIP", f"manual: {key} — " + M5), exp

    def c2(self, row, key, h, ic, view):
        """C2 → (결과 또는 None, 결과 이유에 붙일 말 또는 None)."""
        mv = row["move"]
        prior = {(mv["adopt"], mv["prior"]["cid"]): mv["prior"]["csha"]} if mv["prior"] else {}
        mine = {i: c for i, c in h["confirmed"].get(self.run_id, {}).items() if i[0] == key}
        want = {i: c for i, c in {**prior, **mine}.items() if i[0] == key and i not in h["retired"]}
        have = {i: c for i, c in h["R"].items() if i[0] == key}
        if have != want:
            _note(f"{row['ref']}: {key} 이관 댓글 기록이 승인 때와 다름")
            return ("SKIP", f"changed: {key} — " + M13), None
        if ic["recorded_bad"]:
            return ("SKIP", f"manual: {key} — " + bad_reason(ic)), None
        if not ic["content_ok"]:
            if view["state"] == "CLOSED" and parse_ts(view["updated"]) > parse_ts(view["closed_at"]):
                return None, MN_LATE
            return ("SKIP", f"changed: {key} — " + M13), None
        return None, None

    def look(self, row, key, h):
        n = row["move"]["number"]
        view = self.gr(f"issue #{n}", gh_issue, self.remote, n)
        return view, issue_check(view, row["snapshot"], row["move"], h["R"], row["move"]["plan_date"], self.repo_url)

    def mv_c(self, row, key, mode, h, posted, fresh=False):
        """C(KEY, mode): [만든 뒤 확인] → C0 → C1 → C2 → [다시 열린 이슈] → C4 → C5 → C6. posted = 이 실행이 방금 POST한
        바이트(full).
        만든 뒤 확인 = chore 전송이 만든 KEY(h["keys"])인데 그 KEY를 적은 mv-comment-sent가 어느 일지에도 없으면(= 확인을 마친
        적이 없음: 만든 직후 fresh, 또는 그 사이 강제 종료·J2 복구) C가 무엇이든 쓰기 전에 한 번. 실패 = 차단기(exit 9).
        comment-sent가 있는 KEY는 다시 보지 않는다 — 팀이 나중에 배정해도 된다(contract §6).
        이 계획이 닫은 행(이슈 CLOSED · 이 계획의 mv-closed가 그 KEY)은 C1을 건너뛴다 — C1은 닫기 전에 통과했으므로 지금의 티켓
        차이는 그 뒤 누군가의 편집이고, 새 티켓·이슈 닫기는 없다(이슈가 이미 CLOSED); --link로 허가한 교체 이관 댓글만 기존처럼
        게시될 수 있다(already-done; 차이는 verify #3이 보인다)."""
        mv, ref, n = row["move"], row["ref"], row["move"]["number"]
        new = h["keys"].get(key, {}).get("attempt") == self.args.attempt
        if needs_post_create_check(h, key):
            code, why = self.jr(key, post_create_detail, key, h["keys"][key]["acct"])
            if code is not None:                     # 모든 만들기에서 되풀이될 수 있는 저장 차이 — 티켓 하나에서 멈춘다
                self.breaker = True
                head = "방금 만든 티켓" if fresh else "만든 뒤 확인하지 못한 티켓"
                self.breaker_msg = f"{head} {key}: {why} — Jira 단계를 멈춤"
                _note(f"{ref}: {head} {key}: {why}")
                return "SKIP", f"manual: {key} — " + code
        if h["pending_comments"]:                                                            # C0
            view = self.gr(f"issue #{n}", gh_issue, self.remote, n)
            for sid in list(h["pending_comments"]):
                s, rc = h["sends"][sid], {cid for _k, cid in h["R"]}
                hits = [cm for cm in view["comments"] if cm["author"] == mv["gh_login"]
                        and sha_text(cm["body"]) == s["tsha"] and cm["id"] not in rc]
                if len(hits) != 1:
                    return "SKIP", f"manual: {key} — " + M2
                self.journal(ref, "mv-comment-found", fields=[("of", sid), ("cid", hits[0]["id"]),
                                                              ("csha", sha_text(hits[0]["body"]))])
                h = self.hist(ref)
        view, ic = self.look(row, key, h)
        done = view["state"] == "CLOSED" and (self.run_id, key) in h["closed"]   # 이 계획이 닫은 행 — C1은 이미 통과했다
        exp = None
        if not done:
            out, exp = self.c1(row, key, mode, h, ic, posted)                               # C1
            if out is not None:
                return out
        out, note = self.c2(row, key, h, ic, view)                                          # C2
        if out is not None:
            return out
        # 다시 열린 이슈(어느 계획이든 같은 이슈·같은 KEY로 닫고 mv-closed를 남긴 뒤 OPEN): 댓글 채택·게시·닫기 전에 멈춘다 —
        # 사람이 다시 연 결정이고, 지워진 이관 댓글을 --link 뒤에 다시 달거나 다른 계획의 adopt 행이 다시 닫지 않게(round 5d)
        if reopened(view, h, key):
            return "SKIP", f"manual: {key} — " + M21
        m = ic["m"](key)                                                                     # C4
        if m >= 2:
            return "SKIP", f"manual: {key} — " + M8
        if m == 1:
            (k, cid), csha = next((i, c) for i, c in ic["valid"].items() if i[0] == key)
            if (k, cid) not in h["confirmed"].get(self.run_id, {}):
                self.journal(ref, "mv-comment-adopt", fields=[("key", key), ("cid", cid), ("csha", csha)])
                h = self.hist(ref)
        else:                                                                                # C5
            if view["state"] == "CLOSED" and not h["links"].get((self.run_id, key)):
                return "SKIP", f"manual: {key} — " + M9
            text = plan_mod().comment_body(mv["gh"], key)
            tsha = sha_text(text)
            sid = self.mv_send(ref, "mv-comment", [("key", key), ("tsha", tsha)])
            try:
                got = gh_post_comment(self.remote, n, text)
            except GhError:
                return "UNKNOWN", f"{key} — " + M16
            self.test_hook("mv-comment-posted")
            if not re.fullmatch(r"[0-9]+", got["id"]) or sha_text(got["body"]) != tsha:
                _note(f"issue #{n}: 게시된 댓글 {got['id']}의 내용이 보낸 것과 다름")
                return "FAIL", f"comment-failed: {key} — " + M14
            self.journal(ref, "mv-comment-ok", fields=[("sid", sid), ("cid", got["id"]), ("csha", tsha)])
            if self.stop:
                raise Stop(8, f"중단 신호를 받음 — {key} 이관 댓글은 게시됨, 이슈는 닫지 않음")
            h = self.hist(ref)
            view, ic = self.look(row, key, h)
            if not done:
                out, _exp = self.c1(row, key, mode, h, ic, exp)                             # C1 다시
                if out is not None:
                    return out
            out, note = self.c2(row, key, h, ic, view)                                      # C2 다시
            if out is not None:
                return out
        tail = f" ({note})" if note else ""
        if reopened(view, h, key):                   # 닫기 직전 다시: 게시 중에 사람이 다시 연 경우(방금 단 댓글은 승인본이라 남김)
            return "SKIP", f"manual: {key} — " + M21
        if view["state"] == "OPEN":                                                          # C6
            self.test_hook("mv-close")
            self.before_sent()                       # 닫기 직전: 부모 생존·중단 신호(일지 줄은 없음 — 닫기는 멱등)
            gh_close(self.remote, n)
            self.test_hook("mv-gh-closed")
            try:
                after = gh_issue(self.remote, n)
            except GhError as e:
                _note(f"{row['ref']}: 닫은 뒤 다시 읽지 못함 — {e}")
                return "FAIL", f"close-failed: {key} — " + M15
            if after["state"] != "CLOSED":
                return "FAIL", f"close-failed: {key} — " + M15
            self.journal(ref, "mv-closed", fields=[("key", key)])   # 이 계획이 닫았다 — 사람이 다시 열면 다시 닫지 않는다(M21)
            return "OK", f"moved: {key} — " + (MT_MOVED_NEW if new else MT_MOVED_OLD) + tail
        return "OK", f"already-done: {key} — " + MT_ALREADY + tail


def apply_rows(args):
    eng = Apply(args)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, eng.on_signal)
    eng.load()
    if not eng.rows and not eng.mrows:
        return OK
    eng.c = _client_for(eng.binding)
    eng.c.abort_check = lambda: eng.stop
    eng.take_lock()
    eng.repair()
    if any(att == args.attempt for att, _r, _e, _c in eng.read_journal()):
        raise Stop(1, f"--attempt {args.attempt}가 이미 일지에 있음 — 새 attempt로 다시 실행")
    if eng.mrows:
        try:
            read_moves(eng.chore_dir)                # 모든 일지의 move 문법을 첫 쓰기 전에 (위반 = 단계 실패)
        except FormatError as e:
            raise Stop(READ, f"{FORMAT}: {e}") from None
    for row in eng.rows:
        res, reason = eng.row(row)
        eng.emit(res, row["ref"], reason)
        if eng.breaker:
            raise Stop(9, "게시한 댓글이 승인본 조건과 맞지 않음 — 모든 행에서 되풀이될 문제라 Jira 단계를 멈춤")
    project_ok = True
    if eng.mrows:                                    # 첫 만들기 전에 읽기 한 번: 바인딩 프로젝트 id == 모든 행의 project_id
        eng.checkpoint()
        pid = eng.jr("project", project_id, eng.binding["project"])
        project_ok = pid is not None and all(r["move"]["project_id"] == pid for r in eng.mrows)
    for row in eng.mrows:                            # jira-transition 행들 다음, 같은 프로세스·락·일지
        res, reason = eng.mrow(row) if project_ok else ("SKIP", "type: " + MT_TYPE + MT_PROJECT)
        eng.emit(res, row["ref"], reason, "move-issue")
        if eng.breaker:
            raise Stop(9, eng.breaker_msg)
    if eng.stop:      # 마지막 행의 쓰기 중에 받은 TERM — 그 행의 결과는 적었고, 종료 코드로 중단을 알린다
        raise Stop(8, "중단 신호를 받음 — 마지막 행의 결과까지 적고 멈춤")
    return OK


# --- verify-rows (design §5) ---
def parse_results(text, run_id, approved, journal=None, mapproved=()):
    """apply 출력(이어 붙인 것) → (runs: SUMMARY/ABORTED의 k=v, Jira 도우미 RESULT 목록). 위반 = FormatError.
    SUMMARY/ABORTED: run_id = 계획, scope=full|only-group, attempt= 형식, journal= 필수이고 == --journal.
    RESULT 줄은 전부 본다: 어느 칸이든 jira-transition이거나 jira#로 시작하면 6칸 jira-transition 줄이어야 하고,
    어느 칸이든 move-issue면 6칸 move-issue issue#N 줄(mapproved = 계획의 move-issue ref, 분류 = MOVE_CLASSES)이어야 하며,
    그 attempt=는 이 파일의 SUMMARY/ABORTED 중 하나의 attempt=와 같아야 한다. 결과 dict의 "action" = 그 줄의 action."""
    runs, res = [], []
    for no, line in enumerate(text.split("\n"), 1):
        cols = line.split("\t")
        if cols[0] in ("SUMMARY", "ABORTED"):
            kv = dict(c.split("=", 1) for c in cols[1:] if "=" in c)
            if kv.get("run_id") != run_id:
                raise FormatError(f"결과 {no}번째 줄의 run_id가 계획({run_id})과 다름: {line[:160]}")
            if kv.get("scope") not in ("full", "only-group"):
                raise FormatError(f"결과 {no}번째 줄에 scope=full|only-group 없음: {line[:160]}")
            if not ATTEMPT_RE.fullmatch(kv.get("attempt", "")):
                raise FormatError(f"결과 {no}번째 줄에 attempt= 없음 또는 형식 오류: {line[:160]}")
            if not kv.get("journal"):
                raise FormatError(f"결과 {no}번째 줄에 journal= 없음: {line[:160]}")
            if journal is not None and os.path.realpath(kv["journal"]) != os.path.realpath(journal):
                raise FormatError(f"결과 {no}번째 줄의 journal=이 --journal과 다른 일지: {line[:160]}")
            runs.append(kv)
        elif cols[0] == "RESULT" and any(c == "jira-transition" or c.startswith("jira#") or c == "move-issue"
                                         for c in cols[1:]):
            is_move = any(c == "move-issue" for c in cols[1:])
            if is_move:
                if len(cols) != 6 or cols[2] != "move-issue" or not ISSUE_RE.fullmatch(cols[3]):
                    raise FormatError(f"결과 {no}번째 줄: move 결과 줄은 6칸 move-issue issue#N … attempt=: {line[:160]}")
                classes, all_classes, ok_refs = MOVE_CLASSES, MOVE_ALL_CLASSES, mapproved
            else:
                if len(cols) != 6 or cols[2] != "jira-transition" or not JREF_RE.fullmatch(cols[3]):
                    raise FormatError(f"결과 {no}번째 줄: Jira 결과 줄은 6칸 jira-transition jira#KEY … attempt=: {line[:160]}")
                classes, all_classes, ok_refs = CLASSES, ALL_CLASSES, approved
            result, ref, reason, att = cols[1], cols[3], cols[4], cols[5]
            if result not in RESULTS:
                raise FormatError(f"결과 {no}번째 줄의 결과 {result!r}가 목록에 없음")
            if ref not in ok_refs:
                raise FormatError(f"결과 {no}번째 줄의 {ref}{NOT_APPROVED}")
            if not att.startswith("attempt=") or not ATTEMPT_RE.fullmatch(att[8:]):
                raise FormatError(f"결과 {no}번째 줄의 attempt= 형식이 틀림: {line[:160]}")
            m = re.match(r"([a-z-]+): ", reason)
            cls = m.group(1) if m else None
            if result in classes:
                if cls not in classes[result]:
                    raise FormatError(f"결과 {no}번째 줄: {result}의 분류 {cls or '(없음)'}가 허용 목록에 없음: {line[:160]}")
            elif cls in all_classes:
                raise FormatError(f"결과 {no}번째 줄: {result}에는 분류가 없어야 함: {line[:160]}")
            res.append({"attempt": att[8:], "ref": ref, "result": result, "cls": cls if result in classes else None,
                        "reason": reason, "line": line, "action": "move-issue" if is_move else "jira-transition"})
    if not runs:
        raise FormatError("결과에 SUMMARY/ABORTED 줄이 없음 — apply 출력이 아님")
    attempts, seen = {r["attempt"] for r in runs}, set()
    for r in res:
        if (r["attempt"], r["ref"]) in seen:
            raise FormatError(f"같은 시도·같은 행의 결과 줄이 두 번: {r['line'][:160]}")
        seen.add((r["attempt"], r["ref"]))
        if r["attempt"] not in attempts:
            raise FormatError(f"결과 줄의 attempt={r['attempt']}에 맞는 SUMMARY/ABORTED 줄이 없음: {r['line'][:160]}")
    return runs, res


def journaled_count(entries):
    """(attempt, ref) → 쓰기로 셀 일지 줄 수 = chore.sh jira_journaled(76–91)와 같은 셈: 일지 순서대로, *-withdrawn이
    같은 종류의 아직 답 없는 *-sent를 지우면 둘 다 세지 않고(요청이 나가지 않음), 그 밖의 줄은 하나씩 센다(*-ok·
    *-rejected는 답 없는 *-sent를 답한 것으로 지운다). 0 = 이 시도는 이 행에 아무것도 쓰지 않았다."""
    pend, net = {}, {}
    for att, ref, ev, _ in entries:
        kind, _, what = ev.rpartition("-")
        pk, key = (att, ref, kind), (att, ref)
        if what == "withdrawn" and pend.get(pk, 0) > 0:
            pend[pk] -= 1
            net[key] = net.get(key, 0) - 1
            continue
        if what == "sent":
            pend[pk] = pend.get(pk, 0) + 1
        elif what in ("ok", "rejected") and pend.get(pk, 0) > 0:
            pend[pk] -= 1
        net[key] = net.get(key, 0) + 1
    return net


def check_one_way(res, entries):
    """design §5 V3: 결과 줄은 그 시도의 일지가 보여 주는 것보다 많이 주장할 수 없다. NOT-ATTEMPTED는 그 시도의
    journaled_count가 0일 때만(보냄+철회 짝뿐이면 0 — chore.sh 중단 규칙이 NOT-ATTEMPTED를 쓰는 바로 그 경우)."""
    per = {}
    for att, ref, ev, _ in entries:
        per.setdefault((att, ref), set()).add(ev)
    net = journaled_count(entries)
    for r in res:
        evs = per.get((r["attempt"], r["ref"]), set())
        want = (MOVE_ONE_WAY if r.get("action") == "move-issue" else ONE_WAY).get((r["result"], r["cls"]))
        if want and want not in evs:
            raise FormatError(f"{r['result']} {r['cls']}인데 같은 시도의 일지에 {want} 없음: {r['line'][:160]}")
        if r["result"] == "NOT-ATTEMPTED" and net.get((r["attempt"], r["ref"]), 0) > 0:
            raise FormatError(f"NOT-ATTEMPTED인데 같은 시도의 일지에 쓰기 줄이 있음: {r['line'][:160]}")


def _rec(text, kind):
    return f"{text} — 권장: {RECOMMEND.get(kind, RECOMMEND_DEFAULT)}"


def _kind(last):
    if last is None:
        return "none"
    return last["cls"] if last["result"] in ("SKIP", "FAIL") else last["result"]


def verify_decide(row, hdr, jf, rlist, scopes, account=None, v=None, cs=None):
    """design §5 규칙 0–9, 처음 맞는 것이 결정 → (VERIFY 상태, 글). 규칙 0이면 라이브 값 없이 부를 수 있다."""
    snap, key = row["snapshot"], row["jira"]["key"]
    if not rlist and not jf["any"]:                                                       # 0
        if scopes and all(s == "only-group" for s in scopes):
            return "NOT-SCHEDULED", "이번 실행 범위(only-group)에 없음 — 세지 않음"
        return "FAIL", "결과 없음 — 전체 실행인데 이 행의 결과 줄이 없음"
    lf = live_facts(row, hdr, jf, account, v, cs)
    last = rlist[-1] if rlist else None
    last_text = f"{last['result']} {last['reason']}" if last else "결과 줄 없음"
    idw = identity_diff(v, snap, key)
    if idw:                                                                               # 1
        return ("FAIL", f"신원 불일치(쓰기 있었음) — {idw}") if jf["wrote"] else ("RESOLVED", f"신원 바뀜, 쓰기 없음 — {idw}")
    why = manual_why(lf)
    if why:                                                                               # 2
        return "UNRESOLVED", _rec("manual: 정리 댓글이 예상과 다름 — " + ", ".join(why), "manual")
    if last and last["result"] == "SKIP" and last["cls"] == "manual":                     # 3
        return "UNRESOLVED", _rec(last["reason"], "manual")
    if lf["moved"]:                                                                       # 4
        if jf["transition_ok"]:
            t = "이번 실행이 옮김"
            if v["status_id"] != snap["to_status"]:
                t += f" — 현재 {v['status_name']}"
            return "OK", t
        return "OK", "목표 상태와 승인 댓글 확인 — 전환 주체 미확정"
    if len(lf["C"]) == 1:                                                                 # 5
        return "UNRESOLVED", _rec(f"댓글만 남음 — {last_text}", _kind(last))
    if jf["maybe_comment"]:                                                               # 6
        return "UNRESOLVED", _rec("댓글을 보냈지만 보이지 않음 — 효과 미확정", "maybe_comment")
    if v["status_id"] == snap["to_status"] and not jf["wrote"]:                           # 7
        return "WARN", "목표 상태지만 이번 실행이 한 것은 아님"
    if not jf["wrote"] and last and last["result"] == "SKIP" and last["cls"] in RESOLVABLE:   # 8
        return "RESOLVED", f"{last['reason']}, 쓰기 없음"
    return "UNRESOLVED", _rec(last_text, _kind(last))                                     # 9


def verify_rows(args):
    _, hdr, rows, jrows, mrows, binding = load_plan(args)
    approved = {r["ref"] for r in jrows}
    mapproved = {r["ref"] for r in mrows}
    try:
        text = _read_file(args.results, missing_ok=False).decode("utf-8")
    except UnicodeDecodeError:
        raise Stop(1, f"{FORMAT}: 결과 파일이 UTF-8이 아님") from None
    try:
        lines, torn = split_journal(_read_file(args.journal, missing_ok=True))
        runs, res = parse_results(text, hdr["run_id"], approved, args.journal, mapproved)
        entries = parse_journal(lines, approved)
        check_one_way(res, entries)
    except FormatError as e:
        raise Stop(1, f"{FORMAT}: {e}") from None
    if torn:
        _note(f"일지 끝의 줄바꿈 없는 {len(torn)}바이트는 무시함")
    scopes = [r["scope"] for r in runs]
    out, c, account = [], None, None
    mctx = None
    for row in rows:
        if row["action"] == MOVE_ACTION_NAME:
            if c is None:
                c = _client_for(binding)
            if mctx is None:
                mctx = MoveVerify(args, hdr, binding, c)
            status, msg = mctx.decide(row, [r for r in res if r["ref"] == row["ref"] and r["action"] == "move-issue"])
            out.append("\t".join(("VERIFY", status, "move-issue", row["ref"], one_line(msg))))
            continue
        if row["action"] != "jira-transition":
            continue
        jf = journal_facts(entries, row["ref"])
        rlist = [r for r in res if r["ref"] == row["ref"]]
        if not rlist and not jf["any"]:
            status, msg = verify_decide(row, hdr, jf, rlist, scopes)
        else:
            if c is None:
                c = _client_for(binding)
            if account is None:
                account = _verify_read(myself, c)["account"]
            key = row["jira"]["key"]
            status, msg = verify_decide(row, hdr, jf, rlist, scopes, account, _verify_read(view, c, key),
                                        _verify_read(comments, c, key))
        out.append("\t".join(("VERIFY", status, "jira-transition", row["ref"], one_line(msg))))
    sys.stdout.buffer.write("".join(x + "\n" for x in out).encode("utf-8"))
    sys.stdout.buffer.flush()
    return OK


LEAD_KEY = re.compile(r"(?:[a-z-]+: )?([A-Z][A-Z0-9]+-[1-9][0-9]*) — ")


def result_text(r):
    """RESULT 이유 칸에서 분류 접두(`<class>: `)를 뗀 글 — VERIFY 글에는 분류 코드를 싣지 않는다. 결과 없음 = "결과 없음"."""
    if r is None:
        return "결과 없음"
    if r["cls"] is not None and r["reason"].startswith(r["cls"] + ": "):
        return r["reason"][len(r["cls"]) + 2:]
    return r["reason"]
MOVE_ACTION_NAME = "move-issue"


class MoveVerify:
    """design §7 verify — move-issue 행마다 표 13행, 위에서 처음 맞는 것(표에 없는 조합 = UNRESOLVED). 읽기 실패 = Stop
    (행 1 — verify 중단). 일지 = --journal이 있는 폴더의 모든 *.journal(move_history)."""

    def __init__(self, args, hdr, binding, c):
        self.c, self.binding, self.run_id = c, binding, hdr["run_id"]
        self.chore_dir = os.path.dirname(os.path.abspath(args.journal))
        self.remote = hdr["remote"]
        self.repo_url = "https://github.com/" + self.remote
        self.repo_name = self.remote.split("/", 1)[-1]
        self.src = None

    def jr(self, what, fn, *a):
        try:
            return fn(self.c, *a)
        except JiraError as e:
            raise Stop(AUTH if e.code == AUTH else READ, f"{what}: {e.message}") from None

    def row_key(self, h, last, adopt):
        """이 행이 주장하는 KEY: 마지막 결과 글의 앞 KEY → 이 계획 일지에서 KEY를 적은 마지막 줄(다른 계획 일지의
        mv-create-found·mv-resolve-found 중 of=가 이 계획의 전송인 줄 포함) → adopt → None."""
        if last is not None:
            m = LEAD_KEY.match(last["reason"])
            if m:
                return m.group(1)
        key = None
        for r in h["records"]:
            ours = r["file"] == self.run_id or (r["event"] in ("mv-create-found", "mv-resolve-found")
                                                and h["sends"][r["f"]["of"]]["run_id"] == self.run_id)
            if not ours or r["event"] == "mv-retire":
                continue
            f = r["f"]
            if "key" in f:
                key = f["key"]
            elif r["event"] in ("mv-comment-ok", "mv-comment-found", "mv-resolve-comment-found"):
                key = h["sends"][f.get("sid") or f.get("of")]["key"]
        return key or adopt

    def comment_why(self, h, ic, key):
        """design §7 행 6이 보는 것(이관 댓글) → None(통과) 또는 고정 이유 M6·M7·M8·M10·M11·M12."""
        m = ic["m"](key)
        if ic["recorded_bad"]:
            return bad_reason(ic)
        if m >= 2:
            return M8
        if m == 0:
            return M11
        ident = next(i for i in ic["valid"] if i[0] == key)
        sid = h["posted"].get(ident)
        if ident not in h["mine"]:
            return M10
        if sid is not None and h["sends"][sid]["run_id"] == self.run_id and h["R"][ident] != h["sends"][sid]["tsha"]:
            return M12
        return None

    def decide(self, row, rlist):
        mv, snap, ref, n = row["move"], row["snapshot"], row["ref"], row["move"]["number"]
        try:                                                                                 # 1 (읽기)
            h = move_history(self.chore_dir, ref, self.run_id)
        except FormatError as e:
            raise Stop(READ, f"{FORMAT}: {e}") from None
        try:
            view = gh_issue(self.remote, n)
        except GhError as e:
            raise Stop(READ, f"issue #{n}: {e}") from None
        if self.src is None:
            self.src = self.jr("출처 B 검색", source_b, self.binding["project"], self.repo_name)
        T, b, _c, deleted = self.jr("후보 티켓", live_candidates, h, self.src, mv["account"], self.repo_url, n)
        ic = issue_check(view, snap, mv, h["R"], mv["plan_date"], self.repo_url)
        tail = ""
        for k in deleted:
            cids = sorted((cid for kk, cid in h["R"] if kk == k), key=int)
            tail += VT_DELETED % k + (f" (지울 댓글 {', '.join(cids)})" if cids else "")
        st, msg = self.table(row, rlist, h, view, ic, T, b)
        return st, msg + tail

    def table(self, row, rlist, h, view, ic, T, b):
        mv, snap, n = row["move"], row["snapshot"], row["move"]["number"]
        last = rlist[-1] if rlist else None
        last_text = result_text(last)
        pend = h["pending_creates"] + h["pending_comments"]
        if pend:                                                                             # 2
            return "UNRESOLVED", VT2 + (M1 if h["pending_creates"] else M2)
        key = self.row_key(h, last, mv["adopt"])
        if key is not None:                                                                  # 3
            mode = "full" if h["keys"].get(key, {}).get("run_id") == self.run_id else "orig"
            acct = h["keys"][key]["acct"] if key in h["keys"] else mv["account"]
            exp = self.jr(key, expected_payload, key, mode, ic, snap)
            why = self.jr(key, ticket_check, key, mode, exp, acct, self.repo_url, n)
            if why is not None:
                return "FAIL", f"{key} — " + VT3 + why
        allk = set(T) | ({key} if key else set())
        if len(allk) >= 2 or b:                                                              # 4
            return "UNRESOLVED", VT4 + ", ".join(sorted(allk | set(b), key=key_order))
        if last is not None and last["result"] == "OK" and key is not None:
            if view["state"] == "OPEN":                                                      # 5
                return "FAIL", f"{key} — " + VT5
            why = self.comment_why(h, ic, key)                                               # 6
            if why is not None:
                return "FAIL", f"{key} — " + VT6 + why
            if not ic["content_ok"]:
                if parse_ts(view["updated"]) <= parse_ts(view["closed_at"]):                 # 7
                    return "FAIL", f"{key} — " + VT7
                return "WARN", f"{key} — " + VT8                                            # 8
            if ic["after_close"]:                                                            # 9
                return "WARN", f"{key} — " + VT9W % ic["after_close"]
            return "OK", f"{key} — " + VT9
        if key is not None:
            text = last_text[len(key) + 3:] if last_text.startswith(key + " — ") else last_text
            # 10b: 이슈 CLOSED · 행 6 통과 · 다시 실행하면 C2가 계속할 때만(content_ok 또는 updated > closed_at — C2와 같은 술어)
            if view["state"] == "CLOSED" and self.comment_why(h, ic, key) is None and (
                    ic["content_ok"] or parse_ts(view["updated"]) > parse_ts(view["closed_at"])):
                from_engine = last is None or last["result"] == "NOT-ATTEMPTED" or text.startswith(ABORT_FILL_PREFIXES)
                why = M18 if from_engine else text           # chore-jira가 쓴 결과가 아닐 때만 M18 — 그 밖은 10행처럼 그대로
                return "UNRESOLVED", f"{key} — " + VT10C + why
            return "UNRESOLVED", f"{key} — " + VT10 + text                                  # 10
        if last is not None and last["result"] == "SKIP" and last["cls"] == "exists":         # 11
            keys = sorted(set(T) | set(b), key=key_order) or \
                sorted(set(FREE_KEY_RE.findall(last["reason"])), key=key_order)
            return "UNRESOLVED", VT11 + ", ".join(keys)
        mine = [r["event"] for r in h["records"] if r["file"] == self.run_id]               # 12
        if last is not None and last["result"] == "SKIP" and last["cls"] in ("account", "changed", "type"):
            return "RESOLVED", VT12 + VT12_WHY[last["cls"]]
        if last is not None and last["result"] == "FAIL" and last["cls"] == "create-rejected":
            return "FAIL", VT12F
        sends = [sid for sid, x in h["sends"].items() if x["run_id"] == self.run_id and x["kind"] == "create"]
        if last is not None and last["result"] in ("UNKNOWN", "NOT-ATTEMPTED") and mine \
                and set(mine) <= {"mv-create-sent", "mv-create-withdrawn"} \
                and all(h["settled"].get(sid) == "mv-create-withdrawn" for sid in sends):
            return "RESOLVED", VT12 + VT12_WHY["withdrawn"]      # 이 계획의 만들기 전송이 모두 자기 철회로만 풀림
        if not rlist and h["plan_lines"] == 0:                                               # 13
            return "NOT-SCHEDULED", VT13
        return "UNRESOLVED", VTU + last_text


def _verify_read(fn, c, *a):
    try:
        return fn(c, *a)
    except JiraError as e:
        raise Stop(AUTH if e.code == AUTH else READ, f"{a[0] if a else fn.__name__}: {e.message}") from None


# --- resolve (design v9 §8) — 사람이 확인한 결과를 일지에 적는 유일한 경로 ---
def _git_common_dir(clone):
    try:
        p = subprocess.run(["git", "-C", clone, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Stop(1, f"git을 실행할 수 없음 ({type(e).__name__})") from None
    out = p.stdout.decode("utf-8", "replace").strip()
    if p.returncode != 0 or not out or "\n" in out:
        raise Stop(1, "--clone의 git 폴더를 찾을 수 없음")
    return out


def new_attempt():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + os.urandom(4).hex()


def resolve(args):
    """design §8. --sid S (--found KEY | --not-created | --comment-found --cid C | --comment-not-posted) 또는
    --ref issue#N --key KEY --plan P --link. 프로젝트 락(apply가 쥐고 있으면 7), 줄은 S가 있는 일지(link·retire는 P의 일지)에
    fsync로 덧붙이고 by=<gh 로그인>,<Jira 계정>, attempt = 이 resolve의 새 id. 거절 = exit 1(한 줄 이유)."""
    plan = plan_mod()
    subs = [x for x in ("found", "not_created", "comment_found", "comment_not_posted") if getattr(args, x)]
    link_mode = bool(args.link)
    if link_mode == bool(args.sid) or (args.sid and len(subs) != 1) or (link_mode and subs):
        raise Stop(1, "사용법 오류: --sid S와 (--found KEY | --not-created | --comment-found --cid C | "
                      "--comment-not-posted) 하나, 또는 --ref issue#N --key KEY --plan P --link")
    if (args.cid is not None) != bool(args.comment_found):
        raise Stop(1, "사용법 오류: --cid는 --comment-found와 함께")
    if link_mode and not (args.ref and args.key and args.plan):
        raise Stop(1, "사용법 오류: --link에는 --ref issue#N --key KEY --plan <run_id>")
    if not link_mode and (args.ref or args.key or args.plan):
        raise Stop(1, "사용법 오류: --ref·--key·--plan은 --link와 함께")
    if args.sid and not SID_RE.fullmatch(args.sid):
        raise Stop(1, "사용법 오류: --sid는 <run_id>/<attempt>/<seq>")
    if args.cid is not None and not re.fullmatch(r"[0-9]+", args.cid):
        raise Stop(1, "사용법 오류: --cid는 댓글 id(숫자)")
    if link_mode and (not ISSUE_RE.fullmatch(args.ref) or not ATTEMPT_RE.fullmatch(args.plan)):
        raise Stop(1, "사용법 오류: --ref는 issue#N, --plan은 계획 run_id")
    if not GH_REPO.fullmatch(str(args.remote)):
        raise Stop(1, "사용법 오류: --remote는 owner/repo")
    try:
        binding = read_binding(args.repos_md, args.remote)
    except BindingError as e:
        raise Stop(1, f"바인딩 오류: {e}") from None
    if binding is None:
        raise Stop(1, "repos.md에 이 저장소의 Jira 바인딩(jira=)이 없음")
    key = args.found or args.key
    if key is not None and (not MV_KEY_RE.fullmatch(key) or key.rsplit("-", 1)[0] != binding["project"]):
        raise Stop(1, f"사용법 오류: KEY는 바인딩 프로젝트 {binding['project']}의 티켓 키")
    repo_url, repo_name = "https://github.com/" + args.remote, args.remote.split("/", 1)[1]
    chore_dir = os.path.join(_git_common_dir(args.clone), "chore")
    c = _client_for(binding)
    take_project_lock(binding, "resolve")

    def jr(what, fn, *a):
        try:
            return fn(c, *a)
        except JiraError as e:
            raise Stop(AUTH if e.code == AUTH else READ, f"{what}: {e.message}") from None

    def gr(what, fn, *a):
        try:
            return fn(*a)
        except GhError as e:
            raise Stop(READ, f"{what}: {e}") from None

    def hist(ref):
        try:
            return move_history(chore_dir, ref)
        except FormatError as e:
            raise Stop(READ, f"{FORMAT}: {e}") from None
    login = gr("gh 로그인", gh_login)
    by = f"{login},{jr('myself', myself)['account']}"
    if not MV_VALUE["by"].fullmatch(by):
        raise Stop(1, "by= 서명을 일지에 적을 수 없는 모양(gh 로그인·Jira 계정)")
    attempt = new_attempt()
    lines = []
    if link_mode:
        ref, n = args.ref, int(ISSUE_RE.fullmatch(args.ref).group(1))
        h = hist(ref)
        journal = os.path.join(chore_dir, args.plan + ".journal")
        view = gr(f"issue #{n}", gh_issue, args.remote, n)
        ids = {cm["id"] for cm in view["comments"]}
        for (k, cid) in sorted(h["R"], key=lambda x: int(x[1])):
            if k == key and cid not in ids:           # 지금 없는 R 댓글만 retire(영구); 바뀐 댓글은 사람이 먼저 지운다
                lines.append(("mv-retire", [("key", key), ("cid", cid), ("by", by)]))
        lines.append(("mv-link", [("key", key), ("plan", args.plan), ("by", by)]))
    else:
        try:
            recs = read_moves(chore_dir)
        except FormatError as e:
            raise Stop(READ, f"{FORMAT}: {e}") from None
        send = next((r for r in recs if r.get("sid") == args.sid), None)
        if send is None:
            raise Stop(1, f"거절: 일지에 전송 {args.sid}가 없음")
        ref, n = send["ref"], int(ISSUE_RE.fullmatch(send["ref"]).group(1))
        h = hist(ref)
        s = h["sends"][args.sid]
        if args.sid in h["settled"]:
            raise Stop(1, f"거절: 전송 {args.sid}는 이미 결과가 있음 ({h['settled'][args.sid]})")
        want = "create" if (args.found or args.not_created) else "comment"
        if s["kind"] != want:
            raise Stop(1, f"거절: 전송 {args.sid}는 {s['kind']} 전송 — 이 하위 명령은 {want} 전송용")
        journal = os.path.join(chore_dir, SID_RE.fullmatch(args.sid).group(1) + ".journal")
        if args.found:
            tk = jr(key, ticket_view, key)
            if tk is None or tk["key"] != key or tk["project"] != binding["project"]:
                raise Stop(1, f"거절: {key} 티켓이 없음(404 또는 다른 프로젝트)")
            if not created_by(tk, s, repo_url, n, h):
                raise Stop(1, f"거절: {key}는 전송 {args.sid}가 만든 티켓이 아님(보고자·블록 1·만든 시각·다른 전송에 묶임)")
            lines.append(("mv-resolve-found", [("of", args.sid), ("key", key), ("by", by)]))
        elif args.not_created:
            src = jr("출처 B 검색", source_b, binding["project"], repo_name)
            hits = sorted((t["key"] for t in src if created_by(t, s, repo_url, n, h)), key=key_order)
            if not hits:                             # 글 색인을 거치지 않는 두 번째 찾기(색인 지연 중에 만든 티켓)
                hits = jr("보고자·만든 시각 검색", created_since, binding["project"], s, repo_url, n, h)
            if hits:
                raise Stop(1, f"거절: 전송 {args.sid}가 만들었을 수 있는 티켓이 있음 ({', '.join(hits)}) — --found로")
            lines.append(("mv-resolve-not-created", [("of", args.sid), ("by", by)]))
        else:
            view = gr(f"issue #{n}", gh_issue, args.remote, n)
            in_r = {cid for _k, cid in h["R"]}
            if args.comment_found:
                cm = next((x for x in view["comments"] if x["id"] == args.cid), None)
                if cm is None or cm["author"] != login or sha_text(cm["body"]) != s["tsha"] or cm["id"] in in_r:
                    raise Stop(1, f"거절: 댓글 {args.cid}는 전송 {args.sid}의 게시가 아님(없음·작성자·본문 sha·이미 기록됨)")
                lines.append(("mv-resolve-comment-found", [("of", args.sid), ("cid", cm["id"]),
                                                           ("csha", sha_text(cm["body"])), ("by", by)]))
            else:
                same = [x["id"] for x in view["comments"] if sha_text(x["body"]) == s["tsha"]]
                loose = [x["id"] for x in view["comments"] if x["id"] not in in_r
                         and plan.migration_comment(x["body"], x["author"], login)]
                if same or loose:
                    raise Stop(1, "거절: 그 댓글이 게시 결과일 수 있음 — 확인 후 --comment-found 또는 그 댓글을 지운 뒤 "
                                  f"({', '.join(sorted(set(same + loose), key=int))})")
                lines.append(("mv-resolve-comment-not-posted", [("of", args.sid), ("by", by)]))
    try:
        os.makedirs(chore_dir, exist_ok=True)
    except OSError as e:
        raise Stop(READ, f"일지 폴더를 만들 수 없음 ({type(e).__name__})") from None
    repair_journal(journal, attempt)
    for ev, fields in lines:
        append_line(journal, mv_line(now_instant(), attempt, ref, ev, fields))
    try:
        move_history(chore_dir, ref)                  # 쓴 줄이 문법대로 읽히는지 바로 확인
    except FormatError as e:
        raise Stop(READ, f"{FORMAT}(쓴 뒤): {e}") from None
    out = "".join(f"resolve: {ev} {ref} → {os.path.basename(journal)}\n" for ev, _f in lines)
    sys.stdout.buffer.write(out.encode("utf-8"))
    sys.stdout.buffer.flush()
    return OK


def engine_main(args):
    try:
        if args.cmd == "binding":
            try:
                b = read_binding(args.repos_md, args.remote)
            except BindingError as e:
                raise Stop(1, f"바인딩 오류: {e}") from None
            sys.stdout.buffer.write(json.dumps(b, ensure_ascii=False).encode("utf-8") + b"\n")
            sys.stdout.buffer.flush()
            return OK
        if args.cmd == "apply-rows":
            return apply_rows(args)
        if args.cmd == "resolve":
            return resolve(args)
        return verify_rows(args)
    except Stop as e:
        return _die(e.code, f"{args.cmd}: {e.message}")
    except Exception as e:
        return _die(1 if args.cmd == "binding" else READ, f"{args.cmd}: 예상 못 한 오류 ({type(e).__name__})")


# --- CLI -------------------------------------------------------------------------------
class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise JiraError(USAGE, "사용법 오류: " + message)


def build_parser():
    p = _Parser(prog="chore-jira.py", description="chore 정리 엔진의 Jira REST 도우미")
    p.add_argument("--site", help="Jira 호스트 (예 example.atlassian.net) — HTTP 명령 9개에 필수")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("myself")
    for name in ("view", "transitions", "comments", "evidence", "comment"):
        sub.add_parser(name).add_argument("key")
    cl = sub.add_parser("changelog")
    cl.add_argument("key")
    cl.add_argument("--since")
    se = sub.add_parser("search")
    se.add_argument("--jql", required=True)
    se.add_argument("--fields")
    tr = sub.add_parser("transition")
    tr.add_argument("key")
    tr.add_argument("id")
    bd = sub.add_parser("binding")
    bd.add_argument("--repos-md", required=True)
    bd.add_argument("--remote", required=True)
    ap = sub.add_parser("apply-rows")
    for opt in ("--plan", "--attempt", "--journal", "--lock", "--repos-md", "--remote", "--clone", "--judge"):
        ap.add_argument(opt, required=True)
    ap.add_argument("--parent-pid", required=True, type=int)
    ap.add_argument("--repo", help="증거 재확인(chore-judge.py recheck)에 그대로 넘김 — 주면 넘기고 안 주면 안 넘긴다")
    vr = sub.add_parser("verify-rows")
    for opt in ("--plan", "--results", "--journal", "--repos-md", "--remote"):
        vr.add_argument(opt, required=True)
    vr.add_argument("--clone", help="받기만 하고 쓰지 않음")
    vr.add_argument("--judge", help="받기만 하고 쓰지 않음")
    rs = sub.add_parser("resolve")
    for opt in ("--repos-md", "--remote", "--clone"):
        rs.add_argument(opt, required=True)
    rs.add_argument("--sid")
    rs.add_argument("--found", metavar="KEY")
    rs.add_argument("--not-created", action="store_true")
    rs.add_argument("--comment-found", action="store_true")
    rs.add_argument("--cid")
    rs.add_argument("--comment-not-posted", action="store_true")
    rs.add_argument("--ref")
    rs.add_argument("--key")
    rs.add_argument("--plan")
    rs.add_argument("--link", action="store_true")
    return p


def run(args):
    cmd = args.cmd
    if cmd == "comment":
        _key(args.key)
        try:
            text = sys.stdin.buffer.read().decode("utf-8")
        except UnicodeDecodeError:
            raise JiraError(USAGE, "사용법 오류: 댓글 본문이 UTF-8이 아님") from None
        check_comment_text(text)
        return comment(client(args.site), args.key, text)
    if cmd == "transition":
        _key(args.key)
        if not ID_RE.fullmatch(args.id):
            raise JiraError(USAGE, "사용법 오류: 전환 ID는 숫자")
        return transition(client(args.site), args.key, args.id)
    if cmd == "changelog":
        _key(args.key)
        if args.since is not None:
            try:
                parse_ts(args.since)
            except ValueError:
                raise JiraError(USAGE, "사용법 오류: --since는 Jira 시각 (예 2026-10-19T06:07:25.160+0900)") from None
        return changelog(client(args.site), args.key, args.since)
    if cmd == "search":
        if not args.jql.strip():
            raise JiraError(USAGE, "사용법 오류: --jql이 비어 있음")
        fields = args.fields
        if fields is not None and not re.fullmatch(r"[A-Za-z0-9_.*-]+(,[A-Za-z0-9_.*-]+)*", fields):
            raise JiraError(USAGE, "사용법 오류: --fields는 쉼표로 구분한 필드 이름")
        return search(client(args.site), args.jql, fields)
    if cmd == "myself":
        return myself(client(args.site))
    fn = {"view": view, "transitions": transitions, "comments": comments, "evidence": evidence}[cmd]
    _key(args.key)
    return fn(client(args.site), args.key)


def _die(code, message):
    line = AUTH_MSG if code == AUTH else "chore-jira: " + scrub(message, 300)
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass
    return code


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    first = next((a for a in argv if not a.startswith("-") and a in _ALL_COMMANDS), None)
    try:
        args = build_parser().parse_args(argv)
    except JiraError as e:
        return _die(1 if first in ENGINE_COMMANDS else e.code, e.message)
    if args.cmd in ENGINE_COMMANDS:
        return engine_main(args)
    cmd, ctx = None, ""
    try:
        cmd = args.cmd
        ctx = " ".join(x for x in (cmd, getattr(args, "key", None)) if x) + ": "
        result = run(args)
    except JiraError as e:
        return _die(e.code, ctx + e.message)
    except KeyboardInterrupt:
        return _die(UNKNOWN if cmd in WRITE_COMMANDS else READ, ctx + "중단됨")
    except Exception as e:
        return _die(UNKNOWN if cmd in WRITE_COMMANDS else READ, ctx + f"예상 못 한 오류 ({type(e).__name__})")
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return OK


_ALL_COMMANDS = {"myself", "view", "transitions", "comments", "changelog", "search", "evidence", "comment",
                 "transition", *ENGINE_COMMANDS}


if __name__ == "__main__":
    sys.exit(main())
