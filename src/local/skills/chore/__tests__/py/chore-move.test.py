#!/usr/bin/env python3
"""chore-move.test.py — scripts/chore-jira.py move-issue 회귀 표 (chore v4.3 U3, 2026-10-21).

가짜 Jira(http.server, 127.0.0.1)와 가짜 gh(JSON 상태 파일을 읽고 쓰는 파이썬 스크립트, CHORE_GH)에 실제 CLI를
subprocess(`python3 -I`)로 붙인다. 계획은 chore_plan(U1)으로 지금 가짜 GitHub 상태에서 만든다(판정 build가 하는 것과 같은
함수 — gh_issue · issue_check · move_comment · encode_move_evidence). 사례마다 ok/FAIL 한 줄, FAIL이 하나라도 있으면 exit 1.
모든 verify 호출은 contract-shared.md §4(마지막 RESULT → 허용 VERIFY 상태)를 검사하고 design §7 표의 몇 번째 행인지
기록한다 — 마지막 사례가 1–13행이 모두 한 번 이상 나왔는지 본다. 데이터는 전부 합성(실제 토큰·사이트·원장 없음).
Run: python3 -I __tests__/py/chore-move.test.py
"""
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "..", "scripts", "chore-jira.py"))   # this file is <skill>/__tests__/py/
_spec = importlib.util.spec_from_file_location("chore_jira", SCRIPT)
CJ = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(CJ)
P = CJ.plan_mod()

EMAIL, TOKEN = "tester@example.com", "test-token-move"
ME = "712020:00000000-0000-0000-0000-00000000aaaa"
OTHER = "712020:00000000-0000-0000-0000-00000000bbbb"
LOGIN, HUMAN = "chore-bot", "alice"
SITE, PROJECT, PID, TYPE = "example.atlassian.net", "TST", "10000", "10006"
REMOTE, REPO_URL = "test/repo", "https://github.com/test/repo"
RUN_A, RUN_B = "20261021T010000Z-0a0a0a0a", "20261020T010000Z-0b0b0b0b"
PLAN_DATE, PLAN_DATE_B = "2026-10-21", "2026-10-20"
KST = timezone(timedelta(hours=9))
HEADER_SRC = os.path.join(HERE, "..", "fixtures", "chore-v4", "move", "valid.tsv")
REPOS_MD = ("# 저장소\n\n| repo | local path | remote (owner/repo) | note |\n|---|---|---|---|\n"
            "| `test` | `~/t` | `test/repo` | 테스트 저장소. jira=example.atlassian.net/TST jira-qa=20004 jira-closed=20191 |\n")
ROOT = None
CASES, REACHED, REACHED_M = [], set(), set()
M_TEXTS = {f"M{i}": getattr(CJ, f"M{i}") for i in range(1, 22)}
# contract-shared.md §5 표 (2026-10-23) — 글자 그대로; 코드 상수가 이것과 바이트까지 같아야 한다
CONTRACT_M = {"M1": "만들기 결과 미확정 — 다시 만들지 않음", "M2": "댓글 결과 미확정", "M3": "승인한 티켓이 없어짐",
              "M4": "이 이슈의 티켓 여럿", "M5": "티켓 내용이 승인본과 다름 — 닫지 않음", "M6": "이관 댓글이 지워짐",
              "M7": "이관 댓글이 바뀜", "M8": "이관 댓글 중복", "M9": "누가 먼저 닫음 — 연결 기록 필요",
              "M10": "기록 없는 이관 댓글", "M11": "이관 댓글 없음", "M12": "이관 댓글이 보낸 본문과 다름",
              "M13": "이슈가 승인 뒤 바뀜 — 닫지 않음", "M14": "댓글이 게시됐을 수 있음 — 추가 재게시 없이 미결로 중단",
              "M15": "이슈를 닫지 못함", "M16": "댓글 결과 모름 — 다음 실행이 확인", "M17": "지워진 티켓의 댓글 결과 미확정",
              "M18": "이 실행의 결과 줄 없음 — 다시 실행하면 확인",
              "M19": "만든 티켓에 담당자가 붙었거나 보고자가 실행 계정이 아님", "M20": "만든 티켓을 다시 읽을 수 없음",
              "M21": "옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음"}


def root():
    global ROOT
    if ROOT is None:
        ROOT = tempfile.mkdtemp(prefix="chore-move-test.")
        with open(os.path.join(ROOT, "fake-gh.py"), "w") as fh:
            fh.write(FAKE_GH_SRC)
        os.makedirs(os.path.join(ROOT, "home"))
    return ROOT


def eq(got, want, what):
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")


def has(text, needle, what):
    if needle not in text:
        raise AssertionError(f"{what}: {needle!r} not in {text!r}")


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn
    return deco


def jts(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}" + dt.strftime("%z")


# ─────────────────────────── 가짜 gh ───────────────────────────
FAKE_GH_SRC = r'''
import fcntl, json, os, sys
from datetime import datetime, timedelta, timezone
path = os.environ["FAKE_GH_STATE"]
fd = os.open(path, os.O_RDWR)
fcntl.flock(fd, fcntl.LOCK_EX)
st = json.loads(open(path, encoding="utf-8").read())
argv = sys.argv[1:]
st["log"].append(argv)
modes = st["modes"]
out, rc, err = None, 0, ""

def now():
    st["tick"] += 1
    t = datetime(2026, 10, 21, 0, 0, 0, tzinfo=timezone.utc) + timedelta(seconds=st["tick"])
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")

def take(route):
    m = modes.get(route)
    ff = st["fail_first"].get(route)
    if ff and ff[1] > 0:
        ff[1] -= 1
        m = ff[0]
    return m

def issue_json(it):
    return {"number": it["number"], "title": it["title"], "body": it["body"],
            "labels": [{"id": 1, "name": x} for x in it["labels"]], "user": None if it["user"] is None else {"login": it["user"]},
            "created_at": it["created_at"], "updated_at": it["updated_at"], "state": it["state"], "closed_at": it["closed_at"],
            "comments": len(it["comments"])}

def comment_json(c):
    return {"id": c["id"], "user": None if c["user"] is None else {"login": c["user"]}, "created_at": c["created_at"],
            "updated_at": c["updated_at"], "body": c["body"]}

try:
    if argv[:2] == ["api", "user"]:
        if take("user") == "fail":
            rc, err = 1, "HTTP 401: Bad credentials"
        else:
            out = json.dumps({"login": st["login"]})
    elif argv and argv[0] == "api" and argv[1] == "--method":
        n = argv[3].split("/")[4]
        it = st["issues"][n]
        body = json.loads(sys.stdin.buffer.read().decode("utf-8"))["body"]
        m = take("post")
        if m == "fail":
            rc, err = 1, "HTTP 502: Bad Gateway"
        else:
            stored = body + " (편집됨)" if m == "mutate" else body
            st["next_id"] += 1
            t = now()
            c = {"id": st["next_id"], "user": st["login"], "created_at": t, "updated_at": t, "body": stored}
            it["comments"].append(c)
            it["updated_at"] = t
            if m == "reopen":                      # 게시하는 사이 사람이 이슈를 다시 엶
                it["state"], it["closed_at"], it["updated_at"] = "open", None, now()
            if m == "store-then-fail":
                rc, err = 1, "HTTP 502: Bad Gateway"
            else:
                out = json.dumps(comment_json(c), ensure_ascii=False)
    elif argv and argv[0] == "api" and argv[1] == "--paginate":
        n = argv[2].split("/")[4]
        m = take("comments")
        if m == "fail":
            rc, err = 1, "HTTP 500"
        else:
            cs = [comment_json(c) for c in st["issues"][n]["comments"]]
            if m == "drop-one":                    # 페이지 하나를 잃은 목록(성공으로 끝남)
                cs = cs[:-1]
            if m == "bump-on-list":                # 두 읽기 사이에 이슈가 바뀜
                st["issues"][n]["updated_at"] = now()
            pages = [cs[i:i + 2] for i in range(0, len(cs), 2)] or [[]]
            out = "".join(json.dumps(pg, ensure_ascii=False) for pg in pages)
    elif argv and argv[0] == "api":
        n = argv[1].split("/")[4]
        if take("issue") == "fail":
            rc, err = 1, "HTTP 500"
        else:
            out = json.dumps(issue_json(st["issues"][n]), ensure_ascii=False)
    elif argv[:2] == ["issue", "close"]:
        n = argv[2]
        assert argv[3:] == ["--repo", st["remote"], "--reason", "not planned"], argv
        m = take("close")
        if m == "fail":
            rc, err = 1, "HTTP 500"
        elif m != "noop":
            it = st["issues"][n]
            t = now()
            it["state"], it["closed_at"], it["updated_at"] = "closed", t, t
            st["closed"].append(int(n))
    else:
        rc, err = 2, "unknown command"
finally:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(st, ensure_ascii=False))
    os.close(fd)
if out is not None:
    sys.stdout.write(out + "\n")
if err:
    sys.stderr.write(err + "\n")
sys.exit(rc)
'''


class GH:
    """가짜 gh의 상태 파일. 이슈 = REST 모양 그대로(state open/closed)."""

    def __init__(self):
        self.path = os.path.join(root(), "gh-state.json")
        self.reset()

    def reset(self):
        self.write({"login": LOGIN, "remote": REMOTE, "issues": {}, "log": [], "modes": {}, "fail_first": {},
                    "tick": 0, "next_id": 5000, "closed": []})

    def read(self):
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def write(self, st):
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(st, fh, ensure_ascii=False)

    def edit(self, fn):
        st = self.read()
        out = fn(st)
        self.write(st)
        return out

    def tick(self, st):
        st["tick"] += 1
        t = datetime(2026, 10, 21, 0, 0, 0, tzinfo=timezone.utc) + timedelta(seconds=st["tick"])
        return t.strftime("%Y-%m-%dT%H:%M:%SZ")

    def add_issue(self, n, title=None, body="본문 첫 줄\n둘째 줄", labels=("bug",), user="frank", comments=()):
        def fn(st):
            t = self.tick(st)
            st["issues"][str(n)] = {"number": n, "title": title or f"이슈 {n} 제목", "body": body, "labels": list(labels),
                                    "user": user, "created_at": t, "updated_at": t, "state": "open", "closed_at": None,
                                    "comments": []}
            for who, text in comments:
                self._comment(st, n, who, text)
        self.edit(fn)

    def _comment(self, st, n, who, text, created=None):
        st["next_id"] += 1
        t = created or self.tick(st)
        it = st["issues"][str(n)]
        it["comments"].append({"id": st["next_id"], "user": who, "created_at": t, "updated_at": t, "body": text})
        it["updated_at"] = max(it["updated_at"], t)
        return st["next_id"]

    def comment(self, n, who, text, created=None):
        return self.edit(lambda st: self._comment(st, n, who, text, created))

    def issue(self, n):
        return self.read()["issues"][str(n)]

    def set_issue(self, n, **kw):
        def fn(st):
            it = st["issues"][str(n)]
            bump = kw.pop("bump", True)
            it.update(kw)
            if bump:
                it["updated_at"] = self.tick(st)
        self.edit(fn)

    def delete_comment(self, n, cid):
        def fn(st):
            it = st["issues"][str(n)]
            it["comments"] = [c for c in it["comments"] if c["id"] != int(cid)]
            it["updated_at"] = self.tick(st)
        self.edit(fn)

    def mode(self, route, mode, times=None):
        def fn(st):
            if times is None:
                st["modes"][route] = mode
            else:
                st["fail_first"][route] = [mode, times]
        self.edit(fn)

    def calls(self, kind):
        """kind: post · close · issue · comments"""
        out = []
        for a in self.read()["log"]:
            k = ("post" if a[:2] == ["api", "--method"] else "close" if a[:2] == ["issue", "close"] else
                 "comments" if a[:2] == ["api", "--paginate"] else "user" if a[:2] == ["api", "user"] else "issue")
            if k == kind:
                out.append(a)
        return out

    def migration(self, n):
        return [c for c in self.issue(n)["comments"] if P.migration_comment(c["body"], c["user"], LOGIN)]


# ─────────────────────────── 가짜 Jira ───────────────────────────
def _handler_for(fake):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            fake.handle(self, "GET")

        def do_POST(self):
            fake.handle(self, "POST")
    return H


def adf_problem(doc):
    """Jira가 거부할 ADF면 이유: 빈 text 노드 · doc/version · 블록 종류."""
    if not (isinstance(doc, dict) and doc.get("type") == "doc" and doc.get("version") == 1 and isinstance(doc.get("content"), list)):
        return "doc"
    for b in doc["content"]:
        if b.get("type") not in ("paragraph", "heading", "codeBlock") or not isinstance(b.get("content"), list):
            return "block"
        for t in b["content"]:
            if t.get("type") == "text" and (not isinstance(t.get("text"), str) or t["text"] == ""):
                return "empty text node"
    return None


class FakeJira:
    """메모리 Jira(move-issue 경로만). modes/fail_first[route] = 동작 주입. route = myself search ticket create createmeta.
    create 동작: 400 404 422 429 401 403 503(저장 안 함) store-then-503 drop store-then-drop mutate(설명 블록 7을 바꿔 저장)
    bad-key(저장하고 다른 프로젝트 키를 돌려줌). 만들기 본문에 labels가 있으면 400(이 프로젝트에는 라벨 필드가 없다 — 회귀 검사),
    assignee가 빠지면 프로젝트 리더에게 배정(R5 위반을 기록으로 보이게)."""

    def __init__(self):
        self.lock = threading.RLock()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(self))
        self.server.daemon_threads = True
        self.server.handle_error = lambda request, client_address: None
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.reset()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def reset(self):
        with self.lock:
            self.tickets, self.next_n, self.me, self.modes, self.fail_first = {}, 100, ME, {}, {}
            self.log, self.bodies, self.hidden, self.page, self.aliases = [], [], set(), 2, {}
            self.project_id, self.reporter_jql = PID, []
            self.create_n, self.create_fail_at = 0, {}   # create_fail_at[n] = n번째 만들기 요청의 동작(앞 행은 정상으로 두려고)
            self.createmeta = {TYPE: [
                {"fieldId": "project", "name": "프로젝트", "required": True, "hasDefaultValue": False},
                {"fieldId": "issuetype", "name": "이슈 유형", "required": True, "hasDefaultValue": False},
                {"fieldId": "summary", "name": "요약", "required": True, "hasDefaultValue": False},
                {"fieldId": "reporter", "name": "보고자", "required": True, "hasDefaultValue": True},
                {"fieldId": "assignee", "name": "담당자", "required": False, "hasDefaultValue": False},
                {"fieldId": "description", "name": "설명", "required": False, "hasDefaultValue": False},
                {"fieldId": "priority", "name": "우선순위", "required": False, "hasDefaultValue": True}]}

    def add_ticket(self, key=None, description=None, reporter=ME, summary="요약", created=None, project=PROJECT):
        with self.lock:
            if key is None:
                self.next_n += 1
                key = f"{project}-{self.next_n}"
            self.tickets[key] = {"id": str(20000 + len(self.tickets)), "key": key, "project": project,
                                 "project_id": PID if project == PROJECT else "19999", "summary": summary,
                                 "description": description, "reporter": reporter, "assignee": None,
                                 "created": created or jts(datetime.now(KST)), "issuetype": TYPE}
            return key

    def creates(self):
        return [x for x in self.log if x[1] == "create"]

    def searches(self):
        return [x for x in self.log if x[1] == "search"]

    def _send(self, req, code, obj=None, close=False):
        data = b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode()
        try:
            req.send_response(code)
            req.send_header("Content-Type", "application/json")
            req.send_header("Content-Length", str(len(data)))
            req.end_headers()
            if data:
                req.wfile.write(data)
        except OSError:
            pass

    def handle(self, req, method):
        u = urllib.parse.urlsplit(req.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        n = int(req.headers.get("Content-Length") or 0)
        body = req.rfile.read(n) if n else b""
        route, arg = self._route(method, u.path)
        with self.lock:
            self.log.append((method, route, q, body))
            mode = self.modes.get(route)
            if route == "create":
                self.create_n += 1
                mode = self.create_fail_at.get(self.create_n, mode)
            ff = self.fail_first.get(route)
            if ff and ff[1] > 0:
                ff[1] -= 1
                mode = ff[0]
        want = "Basic " + __import__("base64").b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
        if req.headers.get("Authorization") != want or mode == "401":
            return self._send(req, 401, {"errorMessages": ["bad auth"]})
        if mode == "403":
            return self._send(req, 403, {"errorMessages": ["forbidden"]})
        if route is None:
            return self._send(req, 404, {"errorMessages": ["no route"]})
        if mode in ("400", "404", "422", "429", "503", "500"):
            return self._send(req, int(mode), {"errorMessages": [f"mode {mode}"]})
        if mode == "drop":
            req.close_connection = True
            return None
        with self.lock:
            code, obj = self._dispatch(route, arg, q, body, mode)
        if mode == "store-then-503":
            return self._send(req, 503, {"errorMessages": ["stored, then failed"]})
        if mode == "store-then-drop":
            req.close_connection = True
            return None
        return self._send(req, code, obj)

    def _route(self, method, path):
        if path == "/rest/api/3/myself" and method == "GET":
            return "myself", None
        if path == "/rest/api/3/search/jql" and method == "GET":
            return "search", None
        if path == "/rest/api/3/issue" and method == "POST":
            return "create", None
        m = re.fullmatch(r"/rest/api/3/issue/createmeta/([0-9]+)/issuetypes/([0-9]+)", path)
        if m and method == "GET":
            return "createmeta", (m.group(1), m.group(2))
        m = re.fullmatch(r"/rest/api/3/issue/([A-Z][A-Z0-9]+-[0-9]+)", path)
        if m and method == "GET":
            return "ticket", m.group(1)
        m = re.fullmatch(r"/rest/api/3/project/([A-Z][A-Z0-9]+)", path)
        if m and method == "GET":
            return "project", m.group(1)
        return None, None

    def _view(self, t, fields):
        f = {"summary": t["summary"], "description": t["description"],
             "reporter": None if t["reporter"] is None else {"accountId": t["reporter"], "displayName": "x"},
             "assignee": None if t["assignee"] is None else {"accountId": t["assignee"]},
             "project": {"key": t["project"], "id": t["project_id"]}, "created": t["created"]}
        return {"id": t["id"], "key": t["key"], "fields": {k: v for k, v in f.items() if k in fields}}

    def _dispatch(self, route, arg, q, body, mode):
        if route == "myself":
            return 200, {"accountId": self.me}
        if route == "project":
            if arg != PROJECT:
                return 404, {"errorMessages": ["no project"]}
            return 200, {"id": self.project_id, "key": arg, "name": "테스트"}
        if route == "ticket":
            t = self.tickets.get(self.aliases.get(arg, arg))
            if t is None:
                return 404, {"errorMessages": ["Issue does not exist or you do not have permission to see it."]}
            return 200, self._view(t, q.get("fields", "").split(","))
        if route == "createmeta":
            pid, tid = arg
            fl = self.createmeta.get(tid)
            if pid != PID or fl is None:
                return 404, {"errorMessages": ["no such type"]}
            start = int(q.get("startAt", 0))
            if mode == "repeat":                     # 첫 페이지를 되풀이(startAt 0) — 다음 페이지의 필수 칸이 숨는다
                return 200, {"startAt": 0, "maxResults": 2, "total": len(fl), "fields": fl[0:2]}
            if mode == "repeat-lying":               # 같은 페이지를 요청한 startAt으로 거짓 표시
                return 200, {"startAt": start, "maxResults": 2, "total": len(fl), "fields": fl[0:2]}
            if mode == "empty":
                return 200, {"startAt": start, "maxResults": 2, "total": len(fl), "fields": []}
            return 200, {"startAt": start, "maxResults": 2, "total": len(fl), "fields": fl[start:start + 2]}
        if route == "search":
            m = re.fullmatch(r'project = ([A-Z][A-Z0-9]+) AND text ~ "\\"(.+)/issues\\""', q.get("jql", ""))
            r = re.fullmatch(r'project = ([A-Z][A-Z0-9]+) AND reporter = "([^"]+)" AND created >= "([0-9-]+ [0-9:]+)"',
                             q.get("jql", ""))
            if m:      # 글 색인 검색 — hidden = 색인 지연
                hits = [t for t in self.tickets.values() if t["project"] == m.group(1) and t["key"] not in self.hidden
                        and f"{m.group(2)}/issues" in CJ.flatten(t["description"] or {"type": "doc", "content": []})]
            elif r:    # 색인을 거치지 않는 보고자·만든 시각 검색(시각 = UTC 벽시계로 읽음)
                self.reporter_jql.append(q["jql"])
                since = datetime.strptime(r.group(3), "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
                hits = [t for t in self.tickets.values() if t["project"] == r.group(1) and t["reporter"] == r.group(2)
                        and CJ.parse_ts(t["created"]) >= since]
            else:
                return 400, {"errorMessages": ["bad jql"]}
            hits.sort(key=lambda t: int(t["key"].split("-")[1]))
            off = int(q["nextPageToken"][1:]) if q.get("nextPageToken") else 0
            chunk = hits[off:off + self.page]
            last = off + self.page >= len(hits)
            d = {"issues": [self._view(t, q.get("fields", "").split(",")) for t in chunk], "isLast": last}
            if not last:
                d["nextPageToken"] = f"p{off + self.page}"
            return 200, d
        if route == "create":
            self.bodies.append(body)
            d = json.loads(body.decode("utf-8"))
            f = d.get("fields", {})
            if "labels" in f:
                return 400, {"errors": {"labels": "Field 'labels' cannot be set. It is not on the appropriate screen."}}
            allowed = {"project", "issuetype", "summary", "reporter", "assignee", "description"}
            if set(f) - allowed or not {"project", "issuetype", "summary", "reporter"} <= set(f):
                return 400, {"errorMessages": ["bad fields"]}
            if not (isinstance(f["reporter"], dict) and set(f["reporter"]) == {"id"}):
                return 400, {"errors": {"reporter": "reporter must be {id}"}}
            if adf_problem(f.get("description")):
                return 400, {"errors": {"description": adf_problem(f.get("description"))}}
            desc = json.loads(json.dumps(f["description"]))
            for b in desc["content"]:              # Jira가 붙이는 속성(비교는 무시해야 한다)
                if b["type"] == "codeBlock":
                    b["attrs"] = {"language": None}
            if mode == "mutate":
                cbs = [b for b in desc["content"] if b["type"] == "codeBlock"]
                cbs[0]["content"] = [{"type": "text", "text": cbs[0]["content"][0]["text"] + " "}]
            key = self.add_ticket(description=desc, reporter=f["reporter"]["id"], summary=f["summary"])
            self.tickets[key]["assignee"] = f["assignee"] if "assignee" in f else "project-lead"
            if mode == "assign-lead":                 # 프로젝트 기본 담당자를 붙이는 저장(설정 차이)
                self.tickets[key]["assignee"] = "project-lead"
            if mode == "bad-key":
                return 201, {"id": "1", "key": "OTH-1"}
            if mode == "vanish":                     # 201로 KEY를 주지만 그 티켓은 읽히지 않음(404 — 권한·지연·삭제)
                self.tickets.pop(key)
                return 201, {"id": "1", "key": key}
            return 201, {"id": self.tickets[key]["id"], "key": key, "self": "x"}
        return 404, {"errorMessages": ["no route"]}


# ─────────────────────────── 계획 · 실행 ───────────────────────────
def gh_env():
    return {"CHORE_GH": f"{sys.executable} -I {os.path.join(root(), 'fake-gh.py')}", "FAKE_GH_STATE": GHS.path,
            "CHORE_GH_RETRY_SLEEP": "0"}


def in_proc_env():
    os.environ.update(gh_env())
    os.environ.update({"CHORE_JIRA_BASE": FJ.base, "JIRA_EMAIL": EMAIL, "JIRA_API_TOKEN": TOKEN,
                       "CHORE_JIRA_RETRY_SLEEP": "0"})


def client():
    in_proc_env()
    return CJ.client(SITE)


class Scn:
    """한 사례: git 클론 하나(일지 = <clone>/.git/chore/<run_id>.journal), 계획 하나 이상(run_id마다), 결과 파일."""

    def __init__(self, fj, run_id=RUN_A):
        self.f, self.run_id = fj, run_id
        self.dir = tempfile.mkdtemp(prefix="scn.", dir=root())
        self.clone = os.path.join(self.dir, "clone")
        subprocess.run(["git", "init", "-q", self.clone], check=True, timeout=60)
        self.chore = os.path.join(self.clone, ".git", "chore")
        os.makedirs(self.chore)
        self.md = os.path.join(self.dir, "repos.md")
        with open(self.md, "w", encoding="utf-8") as fh:
            fh.write(REPOS_MD)
        self.n = 0
        self.plans = {}

    def journal(self, run_id=None):
        return os.path.join(self.chore, (run_id or self.run_id) + ".journal")

    def results(self, run_id=None):
        return os.path.join(self.dir, (run_id or self.run_id) + ".results")

    def plan(self, run_id=None):
        return os.path.join(self.dir, (run_id or self.run_id) + ".tsv")

    def build(self, specs, run_id=None, date=PLAN_DATE, created=None):
        """specs = [(n, kw)] → move-issue 행(지금 가짜 GitHub 상태로 source_sha·payload_sha). created = 머리 줄 created=
        (보고 시각, YYYY-MM-DDTHH:MM:SSZ; 없으면 fixture 머리 줄 그대로 — 2026-10-15T05:12:33Z)."""
        run_id = run_id or self.run_id
        hdr = open(HEADER_SRC, "rb").read().split(b"\n")[0]
        hdr = re.sub(rb"\trun_id=[^\t]*", b"\trun_id=" + run_id.encode(), hdr)
        if created is not None:
            hdr = re.sub(rb"\tcreated=[^\t]*", b"\tcreated=" + P.penc(created, sp=True), hdr)
        out = [hdr]
        in_proc_env()
        for n, kw in specs:
            out.append(move_row(n, self.chore, date=date, **kw))
        with open(self.plan(run_id), "wb") as fh:
            fh.write(b"\n".join(out) + b"\n")
        P.parse_plan(open(self.plan(run_id), "rb").read())
        open(self.results(run_id), "a").close()
        self.plans[run_id] = [f"issue#{n}" for n, _ in specs]

    def env(self, extra=None):
        e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.path.join(root(), "home"),
             "CHORE_JIRA_BASE": self.f.base, "JIRA_EMAIL": EMAIL, "JIRA_API_TOKEN": TOKEN, "CHORE_JIRA_TIMEOUT": "5",
             "CHORE_JIRA_RETRY_SLEEP": "0", "CHORE_JIRA_J2_SLEEP": "0"}
        e.update(gh_env())
        e.update(extra or {})
        return e

    def next_attempt(self):
        self.n += 1
        return f"20261021T{self.n:06d}Z-{self.n:08x}"

    def apply(self, env=None, run_id=None):
        run_id = run_id or self.run_id
        att = self.next_attempt()
        cmd = [sys.executable, "-I", SCRIPT, "apply-rows", "--plan", self.plan(run_id), "--attempt", att, "--journal",
               self.journal(run_id), "--lock", os.path.join(self.chore, run_id + ".lock"), "--parent-pid", str(os.getpid()),
               "--repos-md", self.md, "--remote", REMOTE, "--clone", self.clone, "--judge", "/nonexistent-judge"]
        p = subprocess.run(cmd, capture_output=True, env=self.env(env), timeout=120)
        out, err = p.stdout.decode("utf-8"), p.stderr.decode("utf-8")
        hygiene(out, err)
        lines = [x for x in out.split("\n") if x]
        got = {}
        for x in lines:
            c = x.split("\t")
            if len(c) != 6 or c[0] != "RESULT" or c[2] != "move-issue" or c[5] != "attempt=" + att:
                raise AssertionError(f"RESULT 줄 형식: {x!r}")
            if c[1] in ("OK", "SKIP", "FAIL"):
                m = re.match(r"([a-z-]+): ", c[4])
                if not m or m.group(1) not in CJ.MOVE_CLASSES[c[1]]:
                    raise AssertionError(f"RESULT 분류: {x!r}")
            got[c[3]] = (c[1], c[4])
            why = re.sub(r"^[A-Z][A-Z0-9]+-[0-9]+ — ", "", re.sub(r"^[a-z-]+: ", "", c[4]))
            REACHED_M.update(k for k, t in M_TEXTS.items() if t == why)
        self.record(run_id, att, lines, p.returncode)
        return p.returncode, got, err

    def record(self, run_id, att, lines, rc):
        """chore.sh가 붙일 SUMMARY / 중단이면 남은 행의 UNKNOWN·NOT-ATTEMPTED(chore.sh P_JOURNALED 셈) + ABORTED."""
        add = list(lines)
        j = self.journal(run_id)
        if rc == 0:
            add.append(f"SUMMARY\tok=0\tskip=0\tfail=0\tunknown=0\trun_id={run_id}\tscope=full\tattempt={att}\tjournal={j}")
        else:
            done = {x.split("\t")[3] for x in lines}
            jl = jlines(j)
            net = CJ.journaled_count([(x.split(" ")[1], x.split(" ")[2], x.split(" ")[3], None) for x in jl])
            for ref in self.plans[run_id]:
                if ref in done:
                    continue
                if net.get((att, ref), 0) > 0:
                    add.append(f"RESULT\tUNKNOWN\tmove-issue\t{ref}\tjournal has a write of this attempt, outcome unread "
                               f"(run aborted at jira)\tattempt={att}")
                else:
                    add.append(f"RESULT\tNOT-ATTEMPTED\tmove-issue\t{ref}\trun aborted at jira\tattempt={att}")
            add.append(f"ABORTED\trun_id={run_id}\tat=jira\tok=0\tskip=0\tfail=0\tunknown=0\tunattempted=0\t"
                       f"scope=full\tattempt={att}\tjournal={j}\treason=helper exit {rc}")
        with open(self.results(run_id), "a", encoding="utf-8") as fh:
            fh.write("".join(x + "\n" for x in add))

    def verify(self, run_id=None, results=None):
        run_id = run_id or self.run_id
        path = self.results(run_id)
        if results is not None:
            path = os.path.join(self.dir, "custom.results")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(results)
        cmd = [sys.executable, "-I", SCRIPT, "verify-rows", "--plan", self.plan(run_id), "--results", path,
               "--journal", self.journal(run_id), "--repos-md", self.md, "--remote", REMOTE]
        p = subprocess.run(cmd, capture_output=True, env=self.env(), timeout=120)
        out, err = p.stdout.decode("utf-8"), p.stderr.decode("utf-8")
        hygiene(out, err)
        if p.returncode in (5, 6):
            REACHED.add(1)
            return p.returncode, {}, err
        got, order = {}, []
        for x in (y for y in out.split("\n") if y):
            c = x.split("\t")
            if len(c) != 5 or c[0] != "VERIFY" or c[2] != "move-issue":
                raise AssertionError(f"VERIFY 줄 형식: {x!r}")
            got[c[3]] = (c[1], c[4])
            order.append(c[3])
        if p.returncode == 0:
            eq(order, self.plans[run_id], "VERIFY 순서 = 계획 순서")
            text = open(path, encoding="utf-8").read()
            for ref, (st, msg) in got.items():
                row = contract_check(text, ref, st, msg)
                REACHED.add(row)
                body = re.sub(r"^[A-Z][A-Z0-9]+-[0-9]+ — ", "", msg.split(" · 지워진 티켓 ")[0])
                for prefix in ((CJ.VT2,) if row == 2 else (CJ.VT6,) if row == 6 else (CJ.VT10,) if row == 10 else
                               (CJ.VT10C,) if row == "10b" else ()):
                    REACHED_M.update(k for k, t in M_TEXTS.items() if body == prefix + t)
        return p.returncode, got, err

    def resolve(self, *args):
        cmd = [sys.executable, "-I", SCRIPT, "resolve", "--repos-md", self.md, "--remote", REMOTE, "--clone", self.clone]
        p = subprocess.run(cmd + list(args), capture_output=True, env=self.env(), timeout=120)
        out, err = p.stdout.decode("utf-8"), p.stderr.decode("utf-8")
        hygiene(out, err)
        return p.returncode, out, err

    def hist(self, n):
        return CJ.move_history(self.chore, f"issue#{n}", self.run_id)

    def events(self, n, run_id=None):
        return [x.split(" ")[3] for x in jlines(self.journal(run_id)) if x.split(" ")[2] == f"issue#{n}"]


def jlines(path):
    try:
        data = open(path, "rb").read().decode("utf-8")
    except FileNotFoundError:
        return []
    return data.split("\n")[:-1] if "\n" in data else []


def move_row(n, chore_dir, date=PLAN_DATE, adopt=None, prior=None, reason=None, related=(), account=ME, login=LOGIN,
             expected=None, R=None):
    """판정 build가 쓰는 같은 함수로 행 하나: gh_issue → issue_check(R = 일지) → snapshot·증거."""
    view = CJ.gh_issue(REMOTE, n)
    if R is None:
        R = CJ.move_history(chore_dir, f"issue#{n}")["R"]
    reason = reason or f"이슈 {n}은 아직 할 일이 남음"
    snap = {"state": "OPEN", "updated": view["updated"], "author": view["author"] or "", "title": view["title"],
            "site": SITE, "project": PROJECT, "project_id": PID, "issuetype": TYPE, "issuetype_name": "작업",
            "account": account, "gh_login": login}
    ic = CJ.issue_check(view, snap, {"reason": reason, "related": list(related)}, R, date, REPO_URL)
    snap.update(source_sha=ic["source_sha"], payload_sha=ic["payload_sha"], adopt=adopt or "-", prior=prior or "-")
    ev = P.encode_move_evidence({"reason": reason, "gh": P.move_comment(SITE, reason, date), "related": list(related)})
    return b"\t".join([b"2", b"move-issue", f"issue#{n}".encode(), (expected or view["updated"]).encode(),
                       P.encode_snapshot(snap), ev])


def hygiene(out, err):
    for bad in (TOKEN, "http://", "https://"):
        if bad in err:
            raise AssertionError(f"stderr에 {bad!r}: {err!r}")
    if TOKEN in out:
        raise AssertionError("stdout에 토큰")
    if err.count("\n") > 3:
        raise AssertionError(f"stderr가 너무 김: {err!r}")


def want(got, ref, st, needle=None):
    if ref not in got:
        raise AssertionError(f"{ref}: 결과 없음 ({got})")
    if got[ref][0] != st or (needle is not None and needle not in got[ref][1]):
        raise AssertionError(f"{ref}: got {got[ref]!r}, want {st} … {needle!r}")


# contract-shared.md §4 — 마지막 RESULT → verify가 낼 수 있는 상태
ALLOWED = {"OK": {"OK", "WARN", "FAIL", "UNRESOLVED"}, "SKIP manual": {"UNRESOLVED", "FAIL"},
           "SKIP exists": {"UNRESOLVED", "FAIL"}, "SKIP account": {"RESOLVED", "UNRESOLVED", "FAIL"},
           "SKIP changed": {"RESOLVED", "UNRESOLVED", "FAIL"}, "SKIP type": {"RESOLVED", "UNRESOLVED", "FAIL"},
           "FAIL create-rejected": {"FAIL", "UNRESOLVED"}, "FAIL comment-failed": {"UNRESOLVED", "FAIL"},
           "FAIL close-failed": {"UNRESOLVED", "FAIL"}, "UNKNOWN": {"UNRESOLVED", "FAIL", "RESOLVED"},
           "NOT-ATTEMPTED": {"UNRESOLVED", "FAIL", "RESOLVED"}, None: {"NOT-SCHEDULED", "UNRESOLVED", "FAIL"}}


def table_row(st, msg):
    """VERIFY 글 → design §7 행 번호(KEY 머리·지워진 티켓 꼬리를 떼고 VT 상수로)."""
    body = msg.split(" · 지워진 티켓 ")[0]
    m = re.match(r"([A-Z][A-Z0-9]+-[0-9]+) — (.*)", body)
    rest = m.group(2) if m else body
    for row, (prefix, need_key) in ((2, (CJ.VT2, False)), (4, (CJ.VT4, False)), (11, (CJ.VT11, False)),
                                    (12, (CJ.VT12, False)), (13, (CJ.VT13, False)), (0, (CJ.VTU, False)),
                                    (3, (CJ.VT3, True)), (5, (CJ.VT5, True)), (6, (CJ.VT6, True)), (7, (CJ.VT7, True)),
                                    (8, (CJ.VT8, True)), (10, (CJ.VT10, True)), ("10b", (CJ.VT10C, True)), (9, (CJ.VT9, True))):
        if (m is not None) == need_key and rest.startswith(prefix):
            return row
    raise AssertionError(f"VERIFY 글이 표의 어느 행도 아님: {st} {msg!r}")


def contract_check(results_text, ref, st, msg):
    last = None
    for line in results_text.split("\n"):
        c = line.split("\t")
        if len(c) == 6 and c[0] == "RESULT" and c[2] == "move-issue" and c[3] == ref:
            last = c[1] if c[1] in ("OK", "UNKNOWN", "NOT-ATTEMPTED") else f"{c[1]} {c[4].split(':')[0]}"
    if st not in ALLOWED[last]:
        raise AssertionError(f"계약 §4 위반: {ref} 마지막 결과 {last} → VERIFY {st} ({msg})")
    if st in ("OK", "WARN") and last != "OK":
        raise AssertionError("OK/WARN은 마지막 결과가 OK일 때만")
    return table_row(st, msg)


def key_of(text):
    return CJ.FREE_KEY_RE.search(text).group(0)


def deleted_comment_marker(other_group="닫음"):
    return P.MARKER_FMT % (other_group, "2026-09-01")


# ─────────────────────────── 사례 ───────────────────────────
@case("happy: create (exact approved bytes, assignee null, no labels) → comment → close → OK moved; verify OK row 9; rerun already-done")
def _(f):
    GHS.add_issue(11, comments=[(HUMAN, "저도 봤습니다")])
    s = Scn(f)
    s.build([(11, {})])
    rc, got, err = s.apply()
    eq(rc, 0, f"rc ({err})")
    want(got, "issue#11", "OK", "moved: ")
    key = key_of(got["issue#11"][1])
    eq(got["issue#11"][1], f"moved: {key} — {CJ.MT_MOVED_NEW}", "result text")
    eq(s.events(11), ["mv-create-sent", "mv-create-ok", "mv-comment-sent", "mv-comment-ok", "mv-closed"], "journal")
    eq(jlines(s.journal())[-1].split(" ")[4:], ["key=" + key], "mv-closed key=")
    line = jlines(s.journal())[0].split(" ")
    eq((line[4], line[5]), ("seq=1", "acct=" + ME), "create-sent fields")
    row = P.parse_plan(open(s.plan(), "rb").read())[1][0]
    eq(hashlib.sha256(f.bodies[0]).hexdigest(), row["snapshot"]["payload_sha"], "POST bytes = approved payload")
    t = f.tickets[key]
    eq((t["assignee"], t["reporter"]), (None, ME), "assignee null, reporter = account")
    body = json.loads(f.bodies[0])["fields"]
    eq(("labels" in body, body["assignee"], body["reporter"]), (False, None, {"id": ME}), "payload fields")
    mig = GHS.migration(11)
    eq(len(mig), 1, "one migration comment")
    eq(mig[0]["body"], P.comment_body(row["move"]["gh"], key), "posted body = comment_body(gh, KEY)")
    eq((GHS.issue(11)["state"], GHS.read()["closed"]), ("closed", [11]), "closed once")
    rc, v, _ = s.verify()
    eq((rc, v["issue#11"]), (0, ("OK", f"{key} — {CJ.VT9}")), "verify OK")
    rc, got, _ = s.apply()
    eq((rc, got["issue#11"]), (0, ("OK", f"already-done: {key} — {CJ.MT_ALREADY}")), "rerun already-done")
    eq((len(f.creates()), len(GHS.calls("post")), len(GHS.calls("close"))), (1, 1, 1), "no second write")
    eq(s.verify()[1]["issue#11"][0], "OK", "verify after rerun")


@case("adopt with prior: plan B made the ticket + comment, killed before close → plan A adopt=KEY prior=cid → adopt line, close, OK moved (이미 만든 티켓)")
def _(f):
    GHS.add_issue(12)
    s = Scn(f)
    s.build([(12, {"reason": "B의 이유"})], run_id=RUN_B, date=PLAN_DATE_B)
    rc, got, _ = s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-comment-ok"}, run_id=RUN_B)
    eq(rc, -signal.SIGKILL, "B killed")
    hb = CJ.move_history(s.chore, "issue#12")
    key = next(iter(hb["keys"]))
    (k, cid), csha = next(iter(hb["R"].items()))
    s.build([(12, {"adopt": key, "prior": f"{cid}:{csha}", "reason": "A의 다른 이유"})])
    rc, got, err = s.apply()
    eq(rc, 0, err)
    eq(got["issue#12"], ("OK", f"moved: {key} — {CJ.MT_MOVED_OLD}"), "adopt result")
    eq(s.events(12), ["mv-comment-adopt", "mv-closed"], "A journal = adopt, then the confirmed close")
    eq((len(f.creates()), len(GHS.migration(12)), GHS.issue(12)["state"]), (1, 1, "closed"), "one ticket, one comment")
    eq(s.verify()[1]["issue#12"], ("OK", f"{key} — {CJ.VT9}"), "verify A")


ABORT_TEXT = "journal has a write of this attempt, outcome unread (run aborted at jira)"   # Scn.record = chore.sh 중단 글


for _ev in ("mv-create-sent", "mv-create-posted", "mv-create-ok", "mv-comment-sent", "mv-comment-posted", "mv-comment-ok",
            "mv-gh-closed", "mv-closed"):
    def _make(ev):
        @case(f"KILL after {ev} → exact verify row; rerun (+ resolve where the design needs a human) ends with one ticket, one comment")
        def _(f):
            GHS.add_issue(13)
            s = Scn(f)
            s.build([(13, {})])
            rc, got, _ = s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": ev})
            eq((rc, got), (-signal.SIGKILL, {}), "killed")
            rc, v, _ = s.verify()
            eq(rc, 0, "verify after kill")
            key = next(iter(f.tickets), None)
            want_v = {"mv-create-sent": ("UNRESOLVED", CJ.VT2 + CJ.M1), "mv-create-posted": ("UNRESOLVED", CJ.VT2 + CJ.M1),
                      "mv-comment-sent": ("UNRESOLVED", CJ.VT2 + CJ.M2), "mv-comment-posted": ("UNRESOLVED", CJ.VT2 + CJ.M2),
                      "mv-create-ok": ("UNRESOLVED", f"{key} — {CJ.VT10}{ABORT_TEXT}"),
                      "mv-comment-ok": ("UNRESOLVED", f"{key} — {CJ.VT10}{ABORT_TEXT}"),
                      "mv-gh-closed": ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.M18}"),   # 닫고 mv-closed 줄 전
                      "mv-closed": ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.M18}")}[ev]   # 10b: 중단 채움 글은 싣지 않음 → M18
            eq(v["issue#13"], want_v, "verify row after the kill")
            if ev in ("mv-gh-closed", "mv-closed"):  # chore.sh의 다른 중단 채움(일지를 못 읽음)도 M18
                other = open(s.results(), encoding="utf-8").read().replace(
                    ABORT_TEXT, "journal unreadable at abort (run aborted at jira)")
                eq(s.verify(results=other)[1]["issue#13"], want_v, "unreadable-journal fill → M18 too")
            if ev in ("mv-create-sent", "mv-comment-sent"):
                rc, got, _ = s.apply()
                want(got, "issue#13", "SKIP", "manual: ")
                sid = (s.hist(13)["pending_creates"] + s.hist(13)["pending_comments"])[0]
                sub = ["--not-created"] if ev == "mv-create-sent" else ["--comment-not-posted"]
                rc, out, err = s.resolve("--sid", sid, *sub)
                eq(rc, 0, f"resolve ({err})")
            rc, got, err = s.apply()
            eq(rc, 0, err)
            key = next(iter(f.tickets))
            if ev in ("mv-gh-closed", "mv-closed"):
                eq(got["issue#13"], ("OK", f"already-done: {key} — {CJ.MT_ALREADY}"), "rerun after the close")
            else:
                eq(got["issue#13"], ("OK", f"moved: {key} — " + (CJ.MT_MOVED_NEW if ev == "mv-create-sent" else CJ.MT_MOVED_OLD)),
                   "rerun result")
            if ev == "mv-create-posted":
                eq(s.events(13)[:3], ["mv-create-sent", "mv-create-found", "mv-comment-sent"], "J2 recovery, then the comment")
            eq((len(f.tickets), len(GHS.migration(13)), GHS.issue(13)["state"]), (1, 1, "closed"), "1 ticket 1 comment")
            eq(s.verify()[1]["issue#13"], ("OK", f"{key} — {CJ.VT9}"), "verify row 9")
    _make(_ev)


@case("B2: ticket created default-assigned, KILL at mv-create-ok → rerun ×2 rechecks (no comment-sent yet) → exit 9 both, no comment, no close, row 2 never reached")
def _(f):
    for n in (151, 152):
        GHS.add_issue(n)
    s = Scn(f)
    s.build([(151, {}), (152, {})])
    f.fail_first["create"] = ["assign-lead", 1]
    eq(s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-create-ok"})[0], -signal.SIGKILL, "killed after create-ok")
    key = next(iter(f.tickets))
    for i in (1, 2):
        rc, got, err = s.apply()
        eq((rc, got.get("issue#151"), "issue#152" in got), (9, ("SKIP", f"manual: {key} — {CJ.M19}"), False), f"rerun {i}")
        has(err, f"만든 뒤 확인하지 못한 티켓 {key}: 담당자가 붙음(승인본은 담당자 없음) — Jira 단계를 멈춤", f"stderr {i}")
    eq((GHS.calls("post"), GHS.calls("close"), len(f.creates()), len(f.tickets)), ([], [], 1, 1), "one ticket, nothing else")


@case("B2: default-assigned ticket, KILL at mv-create-posted (before the result line) → rerun J2 recovers by identity → recheck → exit 9; unassigned recovery proceeds")
def _(f):
    GHS.add_issue(153)
    s = Scn(f)
    s.build([(153, {})])
    f.fail_first["create"] = ["assign-lead", 1]
    eq(s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-create-posted"})[0], -signal.SIGKILL, "killed before create-ok")
    key = next(iter(f.tickets))
    rc, got, err = s.apply()
    eq((rc, got["issue#153"]), (9, ("SKIP", f"manual: {key} — {CJ.M19}")), "breaker after J2")
    eq(s.events(153), ["mv-create-sent", "mv-create-found"], "found, nothing written after")
    has(err, f"만든 뒤 확인하지 못한 티켓 {key}", "stderr")
    eq((GHS.calls("post"), GHS.calls("close"), len(f.creates())), ([], [], 1), "no comment, no close, no second create")
    f.tickets[key]["assignee"] = None                  # 사람이 담당자를 뗀 뒤(또는 처음부터 담당자 없는 복구) → 진행
    rc, got, _ = s.apply()
    eq((rc, got["issue#153"][0], len(GHS.migration(153)), GHS.issue(153)["state"]), (0, "OK", 1, "closed"), "proceeds")


@case("TERM right after mv-create-sent / mv-comment-sent → *-withdrawn, no request, exit 8; rerun sends normally")
def _(f):
    GHS.add_issue(14)
    s = Scn(f)
    s.build([(14, {})])
    rc, got, _ = s.apply(env={"CHORE_JIRA_TEST_TERM_AFTER": "mv-create-sent"})
    eq((rc, got, len(f.creates())), (8, {}, 0), "create withdrawn")
    eq(s.events(14), ["mv-create-sent", "mv-create-withdrawn"], "journal")
    eq(jlines(s.journal())[1].split(" ")[4], f"sid={RUN_A}/20261021T000001Z-00000001/1", "withdrawn sid")
    rc, v, _ = s.verify()
    eq(v["issue#14"], ("RESOLVED", CJ.VT12 + CJ.VT12_WHY["withdrawn"]), "verify row 12 withdrawn")
    rc, got, _ = s.apply(env={"CHORE_JIRA_TEST_TERM_AFTER": "mv-comment-sent"})
    eq((rc, got, len(f.creates()), len(GHS.calls("post"))), (8, {}, 1, 0), "comment withdrawn")
    eq(s.events(14)[-2:], ["mv-comment-sent", "mv-comment-withdrawn"], "comment journal")
    rc, got, _ = s.apply()
    eq((rc, got["issue#14"][0], len(f.creates()), len(GHS.migration(14))), (0, "OK", 1, 1), "rerun")


@case("create 400 / 404 / 422 → FAIL create-rejected (journaled) and the next row runs; 429 → UNKNOWN (pending)")
def _(f):
    for n in (21, 22):
        GHS.add_issue(n)
    for code in ("400", "404", "422"):
        f.reset()
        s = Scn(f)
        s.build([(21, {}), (22, {})])
        f.fail_first["create"] = [code, 1]
        rc, got, _ = s.apply()
        eq((rc, got["issue#21"]), (0, ("FAIL", f"create-rejected: {CJ.MT_REJECTED % code}")), code)
        want(got, "issue#22", "OK", "moved: ")
        eq(s.events(21), ["mv-create-sent", "mv-create-rejected"], "journal " + code)
        rc, v, _ = s.verify()
        eq(v["issue#21"], ("FAIL", CJ.VT12F), "verify row 12 FAIL")
        GHS.set_issue(22, state="open", closed_at=None)
    f.reset()
    s = Scn(f)
    s.build([(21, {})])
    f.fail_first["create"] = ["429", 1]
    rc, got, _ = s.apply()
    eq((rc, got["issue#21"]), (0, ("UNKNOWN", CJ.MT_UNKNOWN_CREATE)), "429")
    eq(s.events(21), ["mv-create-sent"], "429 pending")


@case("503 create: stored → rerun J2 finds it by identity (create-found) → closes; not stored → J2 retries 3× then SKIP manual")
def _(f):
    GHS.add_issue(23)
    s = Scn(f)
    s.build([(23, {})])
    f.fail_first["create"] = ["store-then-503", 1]
    rc, got, _ = s.apply()
    eq((rc, got["issue#23"]), (0, ("UNKNOWN", CJ.MT_UNKNOWN_CREATE)), "UNKNOWN")
    f.hidden.add(next(iter(f.tickets)))            # 색인 지연: 첫 찾기에는 안 보임
    threading.Timer(0.3, lambda: f.hidden.clear()).start()
    rc, got, err = s.apply(env={"CHORE_JIRA_J2_SLEEP": "0.5"})
    eq(rc, 0, err)
    want(got, "issue#23", "OK", f"moved: {next(iter(f.tickets))} — {CJ.MT_MOVED_OLD}")
    eq(s.events(23)[:3], ["mv-create-sent", "mv-create-found", "mv-comment-sent"], "found then comment")
    eq(len(f.creates()), 1, "no second POST")
    f.reset()
    GHS.add_issue(24)
    s = Scn(f)
    s.build([(24, {})])
    f.fail_first["create"] = ["503", 1]
    rc, got, _ = s.apply()
    eq(got["issue#24"][0], "UNKNOWN", "503")
    n0 = len(f.searches())
    rc, got, _ = s.apply()
    eq((rc, got["issue#24"]), (0, ("SKIP", "manual: " + CJ.M1)), "SKIP manual")
    eq((len(f.searches()) - n0, len(f.creates())), (4 + 0, 1), "J2 = 1 + 3 searches, no new POST")


@case("breaker: Jira stores a different description → SKIP manual + exit 9, next row untouched; rerun stops on the same row, no new POST")
def _(f):
    for n in (25, 26):
        GHS.add_issue(n)
    s = Scn(f)
    s.build([(25, {}), (26, {})])
    f.modes["create"] = "mutate"
    rc, got, err = s.apply()
    eq(rc, 9, err)
    want(got, "issue#25", "SKIP", "manual: ")
    eq(got["issue#25"][1], f"manual: {next(iter(f.tickets))} — {CJ.M5}", "M5")
    eq("issue#26" in got, False, "row 26 not run")
    has(err, "설명 블록 6", "stderr names the block (6 = 본문 codeBlock, no 관련 block)")
    del f.modes["create"]
    rc, got, _ = s.apply()
    eq((rc, len(f.creates()), "issue#26" in got), (9, 1, False), "rerun stops again, no POST")
    eq(GHS.issue(25)["state"], "open", "not closed")
    rc, v, _ = s.verify()
    eq(v["issue#25"][0], "FAIL", "verify row 3")
    has(v["issue#25"][1], CJ.VT3, "row 3 text")
    eq(v["issue#26"][0], "UNRESOLVED", "row 26 NOT-ATTEMPTED → unmatched")


@case("project id differs from the plan (GET project once before any create) → every move row SKIP type, no POST; verify row 12")
def _(f):
    for n in (131, 132):
        GHS.add_issue(n)
    s = Scn(f)
    s.build([(131, {}), (132, {})])
    f.project_id = "10999"
    rc, got, _ = s.apply()
    want_t = ("SKIP", "type: " + CJ.MT_TYPE + CJ.MT_PROJECT)
    eq((rc, got["issue#131"], got["issue#132"], len(f.creates())), (0, want_t, want_t, 0), "SKIP type for all")
    eq(len([x for x in f.log if x[1] == "project"]), 1, "one GET project")
    eq(s.verify()[1]["issue#131"], ("RESOLVED", CJ.VT12 + CJ.VT12_WHY["type"]), "row 12")


@case("assignee check right after this attempt's create: Jira assigned the new ticket → SKIP manual M5 + exit 9, next row untouched")
def _(f):
    for n in (133, 134):
        GHS.add_issue(n)
    s = Scn(f)
    s.build([(133, {}), (134, {})])
    f.modes["create"] = "assign-lead"
    rc, got, err = s.apply()
    key = next(iter(f.tickets))
    eq((rc, got.get("issue#133")), (9, ("SKIP", f"manual: {key} — {CJ.M19}")), f"breaker ({err})")
    has(err, "담당자가 붙음", "stderr why")
    eq(("issue#134" in got, GHS.calls("post"), GHS.calls("close"), len(f.creates())), (False, [], [], 1), "one ticket of damage")


@case("team assigns / triages a moved ticket: verify stays OK; an adopt row whose ticket was assigned closes normally")
def _(f):
    GHS.add_issue(135)
    s = Scn(f)
    s.build([(135, {})])
    rc, got, _ = s.apply()
    key = key_of(got["issue#135"][1])
    f.tickets[key]["assignee"] = OTHER
    eq(s.verify()[1]["issue#135"], ("OK", f"{key} — {CJ.VT9}"), "verify after team assignment")
    GHS.add_issue(136)
    other = ours_ticket(f, 136)
    f.tickets[other]["assignee"] = OTHER
    s2 = Scn(f, run_id=RUN_B)
    s2.build([(136, {"adopt": other})])
    rc, got, err = s2.apply()
    eq((rc, got["issue#136"]), (0, ("OK", f"moved: {other} — {CJ.MT_MOVED_OLD}")), f"adopt closes ({err})")
    eq(s2.verify()[1]["issue#136"], ("OK", f"{other} — {CJ.VT9}"), "verify adopt")


@case("M17: a pending comment whose ticket was deleted → SKIP manual before any new create")
def _(f):
    GHS.add_issue(137)
    s = Scn(f)
    s.build([(137, {})])
    s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-comment-sent"})
    f.tickets.clear()
    rc, got, _ = s.apply()
    eq((rc, got["issue#137"], len(f.creates())), (0, ("SKIP", "manual: " + CJ.M17), 1), "M17, no second POST")


@case("ticket made by this plan, then the issue changes before close → C1 passes (rebuilt = approved), SKIP changed, no breaker")
def _(f):
    GHS.add_issue(27)
    s = Scn(f)
    s.build([(27, {})])
    s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-create-ok"})
    GHS.comment(27, HUMAN, "중간에 단 댓글")
    rc, got, err = s.apply()
    eq(rc, 0, err)
    key = next(iter(f.tickets))
    eq(got["issue#27"], ("SKIP", f"changed: {key} — {CJ.MT_CHANGED}"), "SKIP changed with KEY")
    eq((GHS.calls("post"), GHS.issue(27)["state"]), ([], "open"), "no comment, not closed")
    rc, v, _ = s.verify()
    eq(v["issue#27"], ("UNRESOLVED", f"{key} — {CJ.VT10}{CJ.MT_CHANGED}"), "verify row 10 (why verbatim)")


@case("close checkpoint: TERM right before the close → no gh close, exit 8; rerun closes → OK moved")
def _(f):
    GHS.add_issue(28)
    s = Scn(f)
    s.build([(28, {})])
    rc, got, _ = s.apply(env={"CHORE_JIRA_TEST_TERM_AFTER": "mv-close"})
    eq((rc, got, GHS.calls("close"), GHS.issue(28)["state"]), (8, {}, [], "open"), "not closed")
    rc, v, _ = s.verify()
    key = next(iter(f.tickets))
    eq(v["issue#28"][0], "UNRESOLVED", "verify row 10")
    has(v["issue#28"][1], f"{key} — {CJ.VT10}", "row 10 text")
    rc, got, _ = s.apply()
    eq((rc, got["issue#28"][0], len(GHS.calls("close")), len(GHS.migration(28))), (0, "OK", 1, 1), "closed on rerun")


@case("parent gone while waiting before the close (CHORE_JIRA_TEST_DELAY) → exit 8, no close")
def _(f):
    GHS.add_issue(29)
    s = Scn(f)
    s.build([(29, {"adopt": None})])
    key = ours_ticket(f, 29)       # 다른 계획이 만든 ours 티켓(일지 없음 → orig)
    s.build([(29, {"adopt": key})])
    att = s.next_attempt()
    out, errp = os.path.join(s.dir, "h.out"), os.path.join(s.dir, "h.err")
    src = ("import os,subprocess,sys,time\ncmd=[str(os.getpid()) if a=='@P@' else a for a in sys.argv[1:]]\n"
           f"o=open({out!r},'wb');e=open({errp!r},'wb')\np=subprocess.Popen(cmd,stdout=o,stderr=e)\n"
           "print(p.pid,flush=True)\ntime.sleep(60)\n")
    parent = os.path.join(s.dir, "parent.py")
    open(parent, "w").write(src)
    cmd = [sys.executable, "-I", parent, sys.executable, "-I", SCRIPT, "apply-rows", "--plan", s.plan(), "--attempt", att,
           "--journal", s.journal(), "--lock", os.path.join(s.chore, "x.lock"), "--parent-pid", "@P@", "--repos-md", s.md,
           "--remote", REMOTE, "--clone", s.clone, "--judge", "/nonexistent"]
    pp = subprocess.Popen(cmd, stdout=subprocess.PIPE, env=s.env({"CHORE_JIRA_TEST_DELAY": "3"}))
    hpid = int(pp.stdout.readline())
    deadline = time.time() + 30
    while time.time() < deadline and not os.path.exists(os.path.join(s.chore, RUN_A + ".journal")):
        time.sleep(0.05)       # adopt 줄을 쓴 뒤 닫기 직전 지연에 들어감
    time.sleep(0.5)
    pp.kill()
    pp.wait()
    for _ in range(200):
        try:
            os.kill(hpid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    eq((GHS.calls("close"), GHS.issue(29)["state"]), ([], "open"), "not closed")
    has(open(errp, encoding="utf-8").read(), "부모", "stderr names the parent")


def ours_ticket(f, n, reporter=ME, **kw):
    """다른 계획이 지금 이슈 내용으로 만들었을 ours 모양 티켓(요약 = move_summary(제목))."""
    return f.add_ticket(description=desc_for(n, **kw), reporter=reporter, summary=P.move_summary(GHS.issue(n)["title"]))


def desc_for(n, reason="다른 계획의 이유", date=PLAN_DATE_B, R=None, related=()):
    """지금 이슈 내용으로 다른 계획이 만들었을 설명 ADF."""
    in_proc_env()
    view = CJ.gh_issue(REMOTE, n)
    ic = CJ.issue_check(view, {"project_id": PID, "issuetype": TYPE, "account": ME}, {"reason": reason, "related": list(related)},
                        R or {}, date, REPO_URL)
    return json.loads(ic["payload"])["fields"]["description"]


@case("mixed journals: another plan's journal holds legacy jira-transition lines + mv lines → read; grammar mix-ups → exit 6, zero writes")
def _(f):
    GHS.add_issue(31)
    s = Scn(f)
    s.build([(31, {})])
    other = s.journal(RUN_B)
    legacy = ["2026-10-20T00:00:01.000Z 20261020T000001Z-00000001 jira#TST-7 comment-sent",
              "2026-10-20T00:00:02.000Z 20261020T000001Z-00000001 jira#TST-7 comment-ok 30001",
              f"2026-10-20T00:00:03.000Z 20261020T000002Z-00000002 issue#99 mv-create-sent seq=1 acct={ME}",
              "2026-10-20T00:00:04.000Z 20261020T000002Z-00000002 jira#TST-7 transition-sent",
              f"2026-10-20T00:00:05.000Z 20261020T000002Z-00000002 issue#99 mv-create-ok sid={RUN_B}/20261020T000002Z-00000002/1 key=TST-9"]
    open(other, "w").write("\n".join(legacy) + "\n" + "2026-10-20T00:00:06.000Z 2026102")   # 남의 일지의 잘린 꼬리 = 버림
    rc, got, err = s.apply()
    eq(rc, 0, err)
    want(got, "issue#31", "OK", "moved: ")
    eq(CJ.move_history(s.chore, "issue#99")["keys"]["TST-9"]["run_id"], RUN_B, "other plan's key read")
    for bad, needle in ((f"2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 issue#99 comment-sent", "형식이 틀림"),
                        (f"2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 jira#TST-7 mv-create-sent seq=1 acct={ME}",
                         "형식이 틀림"),
                        (f"2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 issue#99 mv-create-ok sid={RUN_B}/20261020T000003Z-00000003/1 key=TST-8",
                         "앞선 create 전송이 아님"),
                        (f"2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 issue#99 mv-create-sent seq=2 acct={ME}", "seq"),
                        (f"2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 issue#99 mv-create-sent acct={ME} seq=1", "칸은"),
                        (f"2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 issue#99 mv-create-found of={RUN_B}/20261020T000002Z-00000002/1 key=TST-9",
                         "결과·복구가 둘"),
                        (f"2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 issue#98 mv-create-found of={RUN_B}/20261020T000002Z-00000002/1 key=TST-9",
                         "같은 이슈"),
                        ("2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 issue#99 mv-bogus x=1", "모르는 move 사건"),
                        ("2026-10-20T00:00:07.000Z 20261020T000003Z-00000003 jira#TST-7 comment-ok 30002", "순서가 틀림"),
                        # R14: 모양은 맞지만 달력에 없는 시각(13월) — move 줄·jira-transition 줄 모두 형식 오류(파일·줄 번호)
                        (f"2026-13-20T00:00:07.000Z 20261020T000003Z-00000003 issue#99 mv-create-sent seq=1 acct={ME}",
                         f"{RUN_B}.journal 6번째 줄: 시각이 달력에 없음"),
                        ("2026-13-20T00:00:07.000Z 20261020T000003Z-00000003 jira#TST-8 comment-sent",
                         f"{RUN_B}.journal 6번째 줄: 시각이 달력에 없음"),
                        ("2026-10-20T00:00:07.000Z 20261020T000002Z-00000002 jira#TST-7 transition-sent",
                         "답이 없는 옮기기 보냄 뒤에 다른 줄")):
        open(other, "w").write("\n".join(legacy + [bad]) + "\n")
        n0 = (len(f.creates()), len(GHS.calls("post")))
        GHS.set_issue(31, state="open", closed_at=None)
        rc, got, err = s.apply()
        eq((rc, got, (len(f.creates()), len(GHS.calls("post")))), (6, {}, n0), bad)
        has(err, needle, bad)
        eq(s.verify()[0], 6, "verify reads the same journals → row 1")
    open(os.path.join(s.chore, "notes.journal"), "w").write("x\n")
    open(other, "w").write("\n".join(legacy) + "\n")
    rc, _g, err = s.apply()
    eq(rc, 6, "a *.journal not named <run_id>")
    has(err, "<run_id>.journal", "message")


@case("① known ticket with its MARKER block removed → rerun POSTs 0 (journal source beats shape) — C1 mismatch, breaker")
def _(f):
    GHS.add_issue(41)
    s = Scn(f)
    s.build([(41, {})])
    s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-create-ok"})
    key = next(iter(f.tickets))
    f.tickets[key]["description"]["content"].pop()
    rc, got, _ = s.apply()
    eq((rc, len(f.creates()), len(f.tickets)), (9, 1, 1), "no POST")
    eq(got["issue#41"][0], "SKIP", "SKIP manual")
    has(got["issue#41"][1], f"manual: {key} — ", "KEY first")


@case("② same-plan comment deleted → verify FAIL row 6 → resolve --link (retire + link) → one permitted replacement → verify OK")
def _(f):
    GHS.add_issue(42)
    s = Scn(f)
    s.build([(42, {})])
    rc, got, _ = s.apply()
    key = key_of(got["issue#42"][1])
    cid = GHS.migration(42)[0]["id"]
    GHS.delete_comment(42, cid)
    rc, v, _ = s.verify()
    eq(v["issue#42"], ("FAIL", f"{key} — {CJ.VT6}{CJ.M6}"), "row 6 M6")
    rc, got, _ = s.apply()
    eq(got["issue#42"], ("SKIP", f"manual: {key} — {CJ.M6}"), "recorded_bad (deleted) = M6")
    rc, out, err = s.resolve("--ref", "issue#42", "--key", key, "--plan", RUN_A, "--link")
    eq(rc, 0, err)
    eq(s.events(42)[-2:], ["mv-retire", "mv-link"], "retire + link")
    eq(s.verify()[1]["issue#42"], ("UNRESOLVED", f"{key} — {CJ.VT10}{CJ.M6}"), "row 10 carries the last reason")
    rc, got, err = s.apply()
    eq((rc, got["issue#42"]), (0, ("OK", f"already-done: {key} — {CJ.MT_ALREADY}")), "replacement posted")
    eq((len(GHS.migration(42)), len(GHS.calls("post"))), (1, 2), "one replacement")
    eq(s.verify()[1]["issue#42"], ("OK", f"{key} — {CJ.VT9}"), "verify OK")
    rc, got, _ = s.apply()
    eq((got["issue#42"][0], len(GHS.calls("post"))), ("OK", 2), "permission used once")
    GHS.delete_comment(42, GHS.migration(42)[0]["id"])                        # 교체본도 지워지고 연결만 기록 → M11
    eq(s.resolve("--ref", "issue#42", "--key", key, "--plan", RUN_A, "--link")[0], 0, "second link")
    eq(s.verify()[1]["issue#42"], ("FAIL", f"{key} — {CJ.VT6}{CJ.M11}"), "retired, not yet replaced = M11")


@case("③ a moved ticket quoting another issue's URL (block 7) is not that issue's candidate")
def _(f):
    GHS.add_issue(43, body="재현은 https://github.com/test/repo/issues/44 와 같음")
    GHS.add_issue(44)
    s = Scn(f)
    s.build([(43, {})])
    rc, got, _ = s.apply()
    k43 = key_of(got["issue#43"][1])
    c = client()
    h = CJ.move_history(s.chore, "issue#44")
    eq(CJ.live_candidates(c, h, CJ.source_b(c, PROJECT, "repo"), ME, REPO_URL, 44), ([], [], [], []), "not a candidate")
    s.build([(44, {})])
    rc, got, _ = s.apply()
    want(got, "issue#44", "OK", "moved: ")
    eq(key_of(got["issue#44"][1]) != k43, True, "own ticket")


@case("④ a reopened issue with an older chore close comment (other marker group1) moves normally; the comment goes into block 9")
def _(f):
    old = "예전 정리에서 닫았습니다\n" + deleted_comment_marker()
    GHS.add_issue(45, comments=[(LOGIN, old)])
    s = Scn(f)
    s.build([(45, {})])
    eq(s.hist(45)["R"], {}, "not a migration comment")
    rc, got, err = s.apply()
    eq(rc, 0, err)
    want(got, "issue#45", "OK", "moved: ")
    key = key_of(got["issue#45"][1])
    blocks = P.parse_blocks(f.tickets[key]["description"])
    eq(("codeBlock", old) in blocks, True, "old close comment carried")
    eq(s.verify()[1]["issue#45"][0], "OK", "verify")


@case("⑤ issue edited after approval → SKIP changed (F1), nothing written, not closed; verify RESOLVED row 12")
def _(f):
    GHS.add_issue(46)
    s = Scn(f)
    s.build([(46, {})])
    GHS.set_issue(46, body="바뀐 본문")
    rc, got, _ = s.apply()
    eq((rc, got["issue#46"]), (0, ("SKIP", "changed: " + CJ.MT_CHANGED)), "SKIP changed")
    eq((len(f.creates()), GHS.issue(46)["state"], s.events(46)), (0, "open", []), "no write")
    eq(s.verify()[1]["issue#46"], ("RESOLVED", CJ.VT12 + CJ.VT12_WHY["changed"]), "row 12")


@case("⑥ someone else's chore-shaped ticket → SKIP exists (b), verify row 4; when it disappears verify row 11")
def _(f):
    GHS.add_issue(47)
    s = Scn(f)
    s.build([(47, {})])
    other = ours_ticket(f, 47, reporter=OTHER)
    rc, got, _ = s.apply()
    eq((rc, got["issue#47"]), (0, ("SKIP", f"exists: {CJ.MT_EXISTS}{other}")), "SKIP exists")
    eq(len(f.creates()), 0, "no POST")
    eq(s.verify()[1]["issue#47"], ("UNRESOLVED", CJ.VT4 + other), "row 4")
    del f.tickets[other]
    eq(s.verify()[1]["issue#47"], ("UNRESOLVED", CJ.VT11 + other), "row 11")


@case("a human ticket naming the issue URL (c) does not block the create")
def _(f):
    GHS.add_issue(48)
    f.add_ticket(description={"type": "doc", "version": 1, "content": [
        {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "관련 https://github.com/test/repo/issues/48"}]}]}]}]}, reporter=OTHER)
    s = Scn(f)
    s.build([(48, {})])
    rc, got, _ = s.apply()
    want(got, "issue#48", "OK", "moved: ")


@case("A0 account / gh login differs → SKIP account, nothing read beyond; createmeta mismatch → SKIP type; verify row 12")
def _(f):
    GHS.add_issue(49)
    s = Scn(f)
    s.build([(49, {})])
    f.me = OTHER
    rc, got, _ = s.apply()
    eq(got["issue#49"], ("SKIP", "account: " + CJ.MT_ACCOUNT), "jira account")
    f.me = ME
    GHS.edit(lambda st: st.update(login="someone"))
    eq(s.apply()[1]["issue#49"][0], "SKIP", "gh login")
    eq(s.verify()[1]["issue#49"], ("RESOLVED", CJ.VT12 + CJ.VT12_WHY["account"]), "row 12 account")
    GHS.edit(lambda st: st.update(login=LOGIN))
    f.createmeta[TYPE].append({"fieldId": "customfield_1", "name": "고객 등급", "required": True, "hasDefaultValue": False})
    rc, got, _ = s.apply()
    eq(got["issue#49"], ("SKIP", "type: " + CJ.MT_TYPE + "필수 칸 고객 등급"), "type")
    eq(s.verify()[1]["issue#49"], ("RESOLVED", CJ.VT12 + CJ.VT12_WHY["type"]), "row 12 type")
    f.createmeta[TYPE] = [x for x in f.createmeta[TYPE] if x["fieldId"] not in ("customfield_1", "assignee")]
    eq(s.apply()[1]["issue#49"][1], "type: " + CJ.MT_TYPE + "생성 화면에 없는 칸 담당자", "assignee not on screen")
    eq(len(f.creates()), 0, "no POST")


@case("comment POST: gh fails → UNKNOWN (pending, C0 next run); stored body differs → FAIL comment-failed, no retry; close fails → FAIL close-failed")
def _(f):
    GHS.add_issue(51)
    s = Scn(f)
    s.build([(51, {})])
    GHS.mode("post", "store-then-fail", times=1)
    rc, got, _ = s.apply()
    key = next(iter(f.tickets))
    eq(got["issue#51"], ("UNKNOWN", f"{key} — {CJ.MT_UNKNOWN_COMMENT}"), "UNKNOWN")
    eq(s.verify()[1]["issue#51"][0], "UNRESOLVED", "verify row 2 (pending comment)")
    rc, got, _ = s.apply()
    eq((got["issue#51"][0], len(GHS.migration(51)), len(GHS.calls("post"))), ("OK", 1, 1), "C0 found, no repost")
    has(" ".join(s.events(51)), "mv-comment-found", "found line")
    GHS.add_issue(52)
    s2 = Scn(f, run_id=RUN_B)
    s2.build([(52, {})])
    GHS.mode("post", "mutate", times=1)
    rc, got, err2 = s2.apply()
    k2 = key_of(got["issue#52"][1])
    eq(got["issue#52"], ("FAIL", f"comment-failed: {k2} — {CJ.MT_COMMENT_FAILED}"), "comment-failed")
    posted_id = [c for c in GHS.issue(52)["comments"] if c["user"] == LOGIN][-1]["id"]
    has(err2, f"issue #52: 게시된 댓글 {posted_id}의 내용이 보낸 것과 다름", "D5: the returned comment id goes to stderr")
    eq(s2.verify()[1]["issue#52"][0], "UNRESOLVED", "verify row 2")
    rc, got, _ = s2.apply()
    eq((got["issue#52"][0], len(GHS.calls("post"))), ("SKIP", 2), "C0: 0 hits (body differs) → SKIP manual, no repost")
    GHS.add_issue(53)
    s3 = Scn(f, run_id="20261019T010000Z-0c0c0c0c")
    s3.build([(53, {})])
    GHS.mode("close", "noop", times=1)
    rc, got, _ = s3.apply()
    k3 = key_of(got["issue#53"][1])
    eq(got["issue#53"], ("FAIL", f"close-failed: {k3} — {CJ.MT_CLOSE_FAILED}"), "close-failed")
    eq(s3.verify()[1]["issue#53"], ("UNRESOLVED", f"{k3} — {CJ.VT10}{CJ.MT_CLOSE_FAILED}"), "row 10")


@case("verify rows 5 · 7 · 8 · 9-WARN · 3 (deleted ticket + 지울 댓글) · 13 · unmatched")
def _(f):
    GHS.add_issue(61)
    s = Scn(f)
    s.build([(61, {})])
    rc, got, _ = s.apply()
    key = key_of(got["issue#61"][1])
    GHS.set_issue(61, state="open", closed_at=None)                              # 5: 다시 열림
    eq(s.verify()[1]["issue#61"], ("FAIL", f"{key} — {CJ.VT5}"), "row 5")
    GHS.set_issue(61, state="closed", closed_at=GHS.issue(61)["updated_at"], bump=False)
    closed = GHS.issue(61)["closed_at"]
    GHS.comment(61, HUMAN, "닫은 뒤 댓글")
    eq(s.verify()[1]["issue#61"], ("WARN", f"{key} — {CJ.VT9W % 1}"), "row 9 WARN")
    GHS.edit(lambda st: [c.update(created_at="2026-10-01T00:00:00Z") for c in st["issues"]["61"]["comments"]
                         if c["user"] == HUMAN] and None)
    GHS.set_issue(61, updated_at=closed, bump=False)
    eq(s.verify()[1]["issue#61"], ("FAIL", f"{key} — {CJ.VT7}"), "row 7 (changed, updated ≤ closed)")
    GHS.set_issue(61, title="닫은 뒤 바꾼 제목")
    eq(s.verify()[1]["issue#61"], ("WARN", f"{key} — {CJ.VT8}"), "row 8")
    cid = GHS.migration(61)[0]["id"]
    del f.tickets[key]
    eq(s.verify()[1]["issue#61"], ("FAIL", f"{key} — {CJ.VT3}없음" + CJ.VT_DELETED % key + f" (지울 댓글 {cid})"),
       "row 3 + deleted suffix")
    GHS.add_issue(62)
    s2 = Scn(f, run_id=RUN_B)
    s2.build([(62, {})])
    summary = f"SUMMARY\tok=0\trun_id={RUN_B}\tscope=full\tattempt=20261021T000009Z-00000009\tjournal={s2.journal()}\n"
    eq(s2.verify(results=summary)[1]["issue#62"], ("NOT-SCHEDULED", CJ.VT13), "row 13")
    s2.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-create-sent"})
    rc, _o, _e = s2.resolve("--sid", s2.hist(62)["pending_creates"][0], "--not-created")
    eq(rc, 0, "resolve")
    v = s2.verify()[1]["issue#62"]
    eq(v[0], "UNRESOLVED", "unmatched")
    has(v[1], CJ.VTU, "unmatched text")


@case("resolve: --found accept / refuse (reporter · too early · 404 · bound to another sid · not pending · kind)")
def _(f):
    GHS.add_issue(71)
    s = Scn(f)
    s.build([(71, {})])
    f.fail_first["create"] = ["503", 1]
    s.apply()
    sid = s.hist(71)["pending_creates"][0]
    early = jts(datetime.now(KST) - timedelta(minutes=10))
    bad_rep = ours_ticket(f, 71, reporter=OTHER)
    bad_time = ours_ticket(f, 71)
    f.tickets[bad_time]["created"] = early
    for args, needle in ((["--found", bad_rep], "만든 티켓이 아님"), (["--found", bad_time], "만든 티켓이 아님"),
                         (["--found", "TST-999"], "티켓이 없음"), (["--found", "OTH-1"], "바인딩 프로젝트"),
                         (["--comment-found", "--cid", "1"], "comment 전송용"), (["--comment-not-posted"], "comment 전송용")):
        rc, out, err = s.resolve("--sid", sid, *args)
        eq(rc, 1, args)
        has(err, needle, args)
    good = ours_ticket(f, 71, reason="이슈 71은 아직 할 일이 남음", date=PLAN_DATE)    # 이 계획 payload 그대로(full)
    rc, out, err = s.resolve("--sid", sid, "--found", good)
    eq(rc, 0, err)
    has(out, "mv-resolve-found", "stdout")
    last = jlines(s.journal())[-1].split(" ")
    eq((last[3], last[5], last[6]), ("mv-resolve-found", "key=" + good, f"by={LOGIN},{ME}"), "line")
    eq(s.hist(71)["keys"][good]["sid"], sid, "bound")
    eq(s.resolve("--sid", sid, "--found", good)[0], 1, "not pending any more")
    eq(s.resolve("--sid", sid, "--not-created")[0], 1, "not pending any more (2)")
    del f.tickets[bad_rep], f.tickets[bad_time]          # 남은 둘은 다른 계정의 chore 티켓(b)·ours(T) — 지운 뒤
    rc, got, _ = s.apply()
    eq(got["issue#71"], ("OK", f"moved: {good} — {CJ.MT_MOVED_OLD}"), "the found ticket is used")
    eq(len(f.creates()), 1, "no POST")


@case("resolve: --not-created refuses while created_by(t, S) matches; accepts when none; --sid not in any journal → 1")
def _(f):
    GHS.add_issue(72)
    s = Scn(f)
    s.build([(72, {})])
    f.fail_first["create"] = ["store-then-503", 1]
    s.apply()
    sid = s.hist(72)["pending_creates"][0]
    rc, _o, err = s.resolve("--sid", sid, "--not-created")
    eq(rc, 1, "refuse")
    has(err, "--found로", "hint")
    f.tickets.clear()
    rc, _o, err = s.resolve("--sid", sid, "--not-created")
    eq(rc, 0, err)
    eq(s.events(72)[-1], "mv-resolve-not-created", "line")
    eq(s.resolve("--sid", f"{RUN_A}/20261021T999999Z-00000999/1", "--not-created")[0], 1, "unknown sid")


@case("resolve: --comment-found accept / refuse (author · sha · already recorded · missing); --comment-not-posted refuse on tsha body or R-less migration comment")
def _(f):
    GHS.add_issue(73)
    s = Scn(f)
    s.build([(73, {})])
    GHS.mode("post", "fail", times=1)
    s.apply()
    key = next(iter(f.tickets))
    sid = s.hist(73)["pending_comments"][0]
    gh = P.parse_plan(open(s.plan(), "rb").read())[1][0]["move"]["gh"]
    body = P.comment_body(gh, key)
    by_human = GHS.comment(73, HUMAN, body)
    other_body = GHS.comment(73, LOGIN, body + " ")
    for cid, needle in ((by_human, "게시가 아님"), (other_body, "게시가 아님"), ("1", "게시가 아님")):
        rc, _o, err = s.resolve("--sid", sid, "--comment-found", "--cid", str(cid))
        eq(rc, 1, cid)
        has(err, needle, cid)
    rc, _o, err = s.resolve("--sid", sid, "--comment-not-posted")
    eq(rc, 1, "tsha body present (by a human)")
    GHS.delete_comment(73, by_human)
    loose = GHS.comment(73, LOGIN, "손으로 단 이관 댓글\n" + P.MARKER_FMT % (P.MOVE_GH_MARKER, PLAN_DATE))
    GHS.delete_comment(73, other_body)
    rc, _o, err = s.resolve("--sid", sid, "--comment-not-posted")
    eq(rc, 1, "R-less migration comment")
    has(err, str(loose), "names it")
    GHS.delete_comment(73, loose)
    mine = GHS.comment(73, LOGIN, body)
    eq(s.resolve("--sid", sid, "--comment-not-posted")[0], 1, "posted body present")
    rc, _o, err = s.resolve("--sid", sid, "--comment-found", "--cid", str(mine))
    eq(rc, 0, err)
    eq(s.events(73)[-1], "mv-resolve-comment-found", "line")
    eq(s.resolve("--sid", sid, "--comment-found", "--cid", str(mine))[0], 1, "already settled")
    rc, got, _ = s.apply()
    eq((got["issue#73"][0], len(GHS.migration(73))), ("OK", 1), "closes with the found comment")


@case("resolve: --comment-not-posted accept → rerun posts once; --link writes 0 retire + exactly 1 link; lock held → 7; usage → 1")
def _(f):
    GHS.add_issue(74)
    s = Scn(f)
    s.build([(74, {})])
    GHS.mode("post", "fail", times=1)
    s.apply()
    sid = s.hist(74)["pending_comments"][0]
    rc, _o, err = s.resolve("--sid", sid, "--comment-not-posted")
    eq(rc, 0, err)
    rc, got, _ = s.apply()
    eq((got["issue#74"][0], len(GHS.migration(74))), ("OK", 1), "posted once")
    key = key_of(got["issue#74"][1])
    rc, out, err = s.resolve("--ref", "issue#74", "--key", key, "--plan", RUN_A, "--link")
    eq((rc, s.events(74)[-1:], out.count("mv-retire")), (0, ["mv-link"], 0), "0 retire + 1 link")
    site = "example.atlassian.net"
    lock = os.path.join(root(), "home", ".cache", "chore", f"jira-{site}-{PROJECT}.lock")
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        n0 = len(jlines(s.journal()))
        rc, _o, err = s.resolve("--ref", "issue#74", "--key", key, "--plan", RUN_A, "--link")
        eq((rc, len(jlines(s.journal()))), (7, n0), "lock held → 7, nothing written")
    finally:
        os.close(fd)
    for args in ((), ("--sid", sid), ("--sid", sid, "--found", key, "--not-created"), ("--ref", "issue#74", "--link"),
                 ("--sid", "bad", "--not-created"), ("--sid", sid, "--cid", "5", "--comment-not-posted")):
        eq(s.resolve(*args)[0], 1, args)


@case("apply-rows: plan with move rows but no binding / journal not <run_id>.journal → exit 1 before any call")
def _(f):
    GHS.add_issue(81)
    s = Scn(f)
    s.build([(81, {})])
    open(s.md, "w").write("| a | b | remote | note |\n|---|---|---|---|\n| t | ~ | test/repo | 바인딩 없음 |\n")
    n0 = len(f.log)
    eq((s.apply()[0], len(f.log) - n0), (1, 0), "no binding")
    open(s.md, "w").write(REPOS_MD)
    os.rename(s.plan(), os.path.join(s.dir, "tmp.tsv"))
    s.run_id = RUN_B
    os.rename(os.path.join(s.dir, "tmp.tsv"), s.plan())
    s.plans[RUN_B] = ["issue#81"]
    eq((s.apply()[0], len(f.log) - n0), (1, 0), "journal name ≠ plan run_id")


@case("in-process API: move_history pending/R/links, issue_check carry rules, ticket_check orig P-shape, createmeta 404")
def _(f):
    d = tempfile.mkdtemp(prefix="hist.", dir=root())
    A = "20261021T000001Z-00000001"
    lines = [f"2026-10-21T00:00:01.000Z {A} issue#5 mv-create-sent seq=1 acct={ME}",
             f"2026-10-21T00:00:02.000Z {A} issue#5 mv-create-ok sid={RUN_A}/{A}/1 key=TST-5",
             f"2026-10-21T00:00:03.000Z {A} issue#5 mv-comment-sent seq=2 key=TST-5 tsha={'a' * 64}",
             f"2026-10-21T00:00:04.000Z {A} issue#5 mv-comment-ok sid={RUN_A}/{A}/2 cid=900 csha={'a' * 64}",
             f"2026-10-21T00:00:05.000Z {A} issue#5 mv-comment-sent seq=3 key=TST-5 tsha={'b' * 64}",
             f"2026-10-21T00:00:06.000Z 20261021T000002Z-00000002 issue#5 mv-retire key=TST-5 cid=900 by={LOGIN},{ME}",
             f"2026-10-21T00:00:07.000Z 20261021T000002Z-00000002 issue#5 mv-link key=TST-5 plan={RUN_A} by={LOGIN},{ME}"]
    open(os.path.join(d, RUN_A + ".journal"), "w").write("\n".join(lines) + "\n")
    h = CJ.move_history(d, "issue#5", RUN_A)
    eq((h["pending_creates"], h["pending_comments"]), ([], [f"{RUN_A}/{A}/3"]), "pending")
    eq((h["R"], h["retired"], h["links"]), ({}, {("TST-5", "900")}, {(RUN_A, "TST-5"): True}), "retire/link")
    eq(h["keys"]["TST-5"]["acct"], ME, "key acct")
    lines.append(f"2026-10-21T00:00:08.000Z 20261021T000003Z-00000003 issue#5 mv-comment-found of={RUN_A}/{A}/3 cid=901 csha={'b' * 64}")
    open(os.path.join(d, RUN_A + ".journal"), "w").write("\n".join(lines) + "\n")
    h = CJ.move_history(d, "issue#5", RUN_A)
    eq((h["R"], h["links"][(RUN_A, "TST-5")], h["pending_comments"]), ({("TST-5", "901"): "b" * 64}, False, []),
       "found consumes the link")
    view = {"number": 5, "title": "t", "body": "b", "labels": [], "author": "x", "created": "2026-10-01T00:00:00Z",
            "updated": "2026-10-02T00:00:00Z", "state": "CLOSED", "closed_at": "2026-10-02T00:00:00Z",
            "comments": [{"id": "901", "author": LOGIN, "created": "2026-10-01T01:00:00Z", "updated": "x", "body": "z"},
                         {"id": "902", "author": HUMAN, "created": "2026-10-03T00:00:00Z", "updated": "x", "body": "after"}]}
    ic = CJ.issue_check(view, {"project_id": PID, "issuetype": TYPE, "account": ME}, {"reason": "r", "related": []},
                        {("TST-5", "901"): CJ.sha_text("z")}, PLAN_DATE, REPO_URL)
    eq((ic["recorded_bad"], ic["carry"], ic["after_close"], ic["m"]("TST-5")), ([], [], 1, 1), "carry rules")
    ic2 = CJ.issue_check(view, {"project_id": PID, "issuetype": TYPE, "account": ME}, {"reason": "r", "related": []},
                         {("TST-5", "901"): "c" * 64}, PLAN_DATE, REPO_URL)
    eq((ic2["recorded_bad"], len(ic2["carry"])), ([("TST-5", "901")], 1), "changed R comment = bad and carried")
    lines.append(f"2026-10-21T00:00:09.000Z 20261021T000004Z-00000004 issue#5 mv-comment-adopt key=TST-5 cid=901 csha={'c' * 64}")
    open(os.path.join(d, RUN_A + ".journal"), "w").write("\n".join(lines) + "\n")
    try:
        CJ.move_history(d, "issue#5", RUN_A)
        raise AssertionError("A2: two hashes for one comment accepted")
    except CJ.FormatError as e:
        has(str(e), "같은 댓글에 서로 다른 내용 기록", "A2 message")
    GHS.add_issue(91)
    c = client()
    k = ours_ticket(f, 91, reason="옛 이유", related=["TST-1"])
    vw = CJ.gh_issue(REMOTE, 91)
    exp = CJ.issue_check(vw, {"project_id": PID, "issuetype": TYPE, "account": ME}, {"reason": "새 이유", "related": []},
                         {}, PLAN_DATE, REPO_URL)["payload"]
    eq(CJ.ticket_check(c, k, "orig", exp, ME, REPO_URL, 91), None, "orig: P blocks shape only")
    has(CJ.ticket_check(c, k, "full", exp, ME, REPO_URL, 91), "블록", "full: blocks exact")
    eq(CJ.ticket_check(c, k, "orig", exp, OTHER, REPO_URL, 91), "보고자가 이 계정이 아님", "reporter")
    eq(CJ.ticket_check(c, "TST-998", "orig", exp, ME, REPO_URL, 91), "없음", "404")
    eq(CJ.createmeta_ok(c, PID, "10999"), "유형 10999의 생성 화면을 찾을 수 없음 (HTTP 404)", "createmeta 404")
    eq(CJ.createmeta_ok(c, PID, TYPE), None, "createmeta ok")


@case("M3 approved adopt ticket gone · M4 two ours tickets · M9 someone closed first → link → post once")
def _(f):
    GHS.add_issue(101)
    s = Scn(f)
    s.build([(101, {"adopt": "TST-555"})])
    rc, got, _ = s.apply()
    eq(got["issue#101"], ("SKIP", f"manual: TST-555 — {CJ.M3}"), "M3")
    GHS.add_issue(102)
    ours_ticket(f, 102)
    ours_ticket(f, 102, reason="또 다른 이유")
    s = Scn(f)
    s.build([(102, {})])
    eq(s.apply()[1]["issue#102"], ("SKIP", "manual: " + CJ.M4), "M4")
    rc, v, err = s.verify()
    eq((rc, len(f.creates()), v.get("issue#102", ("?",))[0]), (0, 0, "UNRESOLVED"), f"verify row 4 ({err})")
    GHS.add_issue(103)
    s3 = Scn(f, run_id=RUN_B)
    s3.build([(103, {})])
    s3.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-create-ok"})
    key = next(k for k, t in f.tickets.items() if "issues/103" in json.dumps(t["description"], ensure_ascii=False))
    GHS.set_issue(103, state="closed", closed_at=None, bump=False)
    GHS.edit(lambda st: st["issues"]["103"].update(closed_at=st["issues"]["103"]["updated_at"]))
    rc, got, _ = s3.apply()
    eq(got["issue#103"], ("SKIP", f"manual: {key} — {CJ.M9}"), "M9")
    eq(GHS.calls("post"), [], "no post without the link")
    eq(s3.resolve("--ref", "issue#103", "--key", key, "--plan", RUN_B, "--link")[0], 0, "link")
    rc, got, _ = s3.apply()
    eq((got["issue#103"], len(GHS.migration(103))), (("OK", f"already-done: {key} — {CJ.MT_ALREADY}"), 1), "posted once")


@case("M7 migration comment edited (apply C2 + verify 6) · M8 duplicate recorded comments · M10 not in this plan's journal · M12 csha ≠ tsha")
def _(f):
    GHS.add_issue(111)
    s = Scn(f)
    s.build([(111, {})])
    rc, got, _ = s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-comment-ok"})
    key = next(iter(f.tickets))
    cid = GHS.migration(111)[0]["id"]
    body = GHS.migration(111)[0]["body"]
    GHS.edit(lambda st: [c.update(body=c["body"] + " 편집") for c in st["issues"]["111"]["comments"] if c["id"] == cid] and None)
    eq(s.apply()[1]["issue#111"], ("SKIP", f"manual: {key} — {CJ.M7}"), "apply M7")
    GHS.edit(lambda st: [c.update(body=body) for c in st["issues"]["111"]["comments"] if c["id"] == cid] and None)
    rc, got, _ = s.apply()
    eq(got["issue#111"][0], "OK", "restored → closes")
    GHS.edit(lambda st: [c.update(body=body + " 편집") for c in st["issues"]["111"]["comments"] if c["id"] == cid] and None)
    eq(s.verify()[1]["issue#111"], ("FAIL", f"{key} — {CJ.VT6}{CJ.M7}"), "verify M7")
    GHS.edit(lambda st: [c.update(body=body) for c in st["issues"]["111"]["comments"] if c["id"] == cid] and None)
    # M12: 이 계획이 보낸 본문(tsha)과 기록된 본문(csha)이 다름 — 일지·댓글을 함께 바꿔 재현
    x = "다른 본문\n" + P.MARKER_FMT % (P.MOVE_GH_MARKER, PLAN_DATE)
    lines = jlines(s.journal())
    lines = [re.sub(r"csha=[0-9a-f]{64}", "csha=" + CJ.sha_text(x), ln) if " mv-comment-ok " in ln else ln for ln in lines]
    open(s.journal(), "w").write("\n".join(lines) + "\n")
    GHS.edit(lambda st: [c.update(body=x) for c in st["issues"]["111"]["comments"] if c["id"] == cid] and None)
    eq(s.verify()[1]["issue#111"], ("FAIL", f"{key} — {CJ.VT6}{CJ.M12}"), "verify M12")
    # M10: 그 댓글을 이 계획 일지가 아니라 다른 계획 일지만 기록
    ok_line = next(ln for ln in lines if " mv-comment-ok " in ln)
    sent = next(ln for ln in lines if " mv-comment-sent " in ln)
    other = [re.sub(r"seq=[0-9]+", "seq=1", sent),
             re.sub(r"sid=[^/ ]+/([^/ ]+)/[0-9]+", lambda m: f"sid={RUN_B}/{m.group(1)}/1", ok_line)]
    open(s.journal(RUN_B), "w").write("\n".join(other) + "\n")
    # 이 계획 일지에서 댓글 기록을 빼면 그 뒤의 mv-closed도 함께 뺀다(같은 일지 앞선 기록 없이는 문법 위반 — R12)
    open(s.journal(), "w").write("\n".join(ln for ln in lines if " mv-comment-" not in ln and " mv-closed " not in ln) + "\n")
    eq(s.verify()[1]["issue#111"], ("FAIL", f"{key} — {CJ.VT6}{CJ.M10}"), "verify M10")
    os.remove(s.journal(RUN_B))
    open(s.journal(), "w").write("\n".join(lines) + "\n")
    # M8: 이 계획이 같은 KEY로 둘을 기록(채택 줄) — apply C4 · verify 6. 이슈는 닫힌 채로 둔다(다시 열면 R15 가드가 C4보다 먼저 M21)
    second = GHS.comment(111, LOGIN, x)
    open(s.journal(), "a").write(f"2026-10-21T09:00:00.000Z 20261021T090000Z-00000099 issue#111 mv-comment-adopt "
                                 f"key={key} cid={second} csha={CJ.sha_text(x)}\n")
    eq(s.apply()[1]["issue#111"], ("SKIP", f"manual: {key} — {CJ.M8}"), "apply M8 (closed issue, C4)")
    with open(s.results(), "a") as fh:
        fh.write(f"RESULT\tOK\tmove-issue\tissue#111\talready-done: {key} — {CJ.MT_ALREADY}\tattempt=20261021T090001Z-00000098\n"
                 f"SUMMARY\tok=1\trun_id={RUN_A}\tscope=full\tattempt=20261021T090001Z-00000098\tjournal={s.journal()}\n")
    eq(s.verify()[1]["issue#111"], ("FAIL", f"{key} — {CJ.VT6}{CJ.M8}"), "verify M8")


@case("B1-1 + R4 gh_issue completeness: short list / updated_at moving between the reads → re-read (3 reads); once then exact = ok, 3× = GhError; apply exit 6, nothing sent")
def _(f):
    GHS.add_issue(171, comments=[(HUMAN, "하나"), (HUMAN, "둘"), (HUMAN, "셋")])
    in_proc_env()
    eq(len(CJ.gh_issue(REMOTE, 171)["comments"]), 3, "exact list ok")
    for mode in ("drop-one", "bump-on-list"):
        GHS.mode("comments", mode, times=1)
        n0 = len(GHS.calls("comments"))
        eq(len(CJ.gh_issue(REMOTE, 171)["comments"]), 3, f"{mode} once → second read exact")
        eq(len(GHS.calls("comments")) - n0, 2, f"{mode}: listed twice")
        GHS.mode("comments", mode, times=3)
        try:
            CJ.gh_issue(REMOTE, 171)
            raise AssertionError(f"{mode} ×3 accepted")
        except CJ.GhError as e:
            has(str(e), "읽는 중 이슈가 바뀜 — 다시 실행", mode)
    GHS.mode("comments", "fail", times=1)
    n0 = len(GHS.calls("comments"))
    try:
        CJ.gh_issue(REMOTE, 171)
        raise AssertionError("gh failure accepted")
    except CJ.GhError:
        eq(len(GHS.calls("comments")) - n0, 1, "other failures are not re-read")
    s = Scn(f)
    s.build([(171, {})])
    GHS.mode("comments", "drop-one", times=3)
    rc, got, err = s.apply()
    eq((rc, got, len(f.creates()), GHS.calls("post")), (6, {}, 0, []), "apply stops on the partial read")
    has(err, "읽는 중 이슈가 바뀜", "stderr")


@case("B1-2 createmeta paging: repeated first page (startAt 0) / same page under a new startAt / empty page before total → JiraError; apply exit 6, no POST /issue")
def _(f):
    c = client()
    for mode, needle in (("repeat", "startAt"), ("repeat-lying", "같은 칸이 두 번"), ("empty", "빈 페이지")):
        f.modes["createmeta"] = mode
        try:
            CJ.createmeta_ok(c, PID, TYPE)
            raise AssertionError(f"{mode} accepted")
        except CJ.JiraError as e:
            eq(e.code, CJ.READ, mode)
            has(e.message, needle, mode)
    f.modes.clear()
    eq(CJ.createmeta_ok(c, PID, TYPE), None, "paged normally")
    GHS.add_issue(172)
    s = Scn(f)
    s.build([(172, {})])
    f.modes["createmeta"] = "repeat-lying"
    rc, got, err = s.apply()
    eq((rc, got, len(f.creates())), (6, {}, 0), "no create on an incomplete createmeta")


@case("C: another plan's mv-create-found settles this plan's lone mv-create-sent → this plan's verify sees the KEY (row 10), not RESOLVED 보내기 전에 멈춤")
def _(f):
    GHS.add_issue(161)
    s = Scn(f)
    s.build([(161, {})])
    f.fail_first["create"] = ["store-then-503", 1]
    eq(s.apply()[1]["issue#161"], ("UNKNOWN", CJ.MT_UNKNOWN_CREATE), "A: create result unknown")
    s.build([(161, {})], run_id=RUN_B)
    rc, got, err = s.apply(run_id=RUN_B)
    key = next(iter(f.tickets))
    eq((rc, got["issue#161"]), (0, ("OK", f"moved: {key} — {CJ.MT_MOVED_OLD}")), f"B recovers A's send ({err})")
    eq(s.events(161, RUN_B)[0], "mv-create-found", "found line in B's journal")
    eq(s.verify()[1]["issue#161"], ("UNRESOLVED", f"{key} — {CJ.VT10}{CJ.MT_UNKNOWN_CREATE}"), "A: row 10 with the KEY")


@case("D1: adopted (orig) row OK moved, label added after the close → verify WARN row 8 (not FAIL row 3); apply rerun OK already-done with the late-change note")
def _(f):
    GHS.add_issue(181)
    s = Scn(f)
    s.build([(181, {"reason": "B의 이유"})], run_id=RUN_B, date=PLAN_DATE_B)
    s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-comment-ok"}, run_id=RUN_B)
    hb = CJ.move_history(s.chore, "issue#181")
    key = next(iter(hb["keys"]))
    (_k, cid), csha = next(iter(hb["R"].items()))
    s.build([(181, {"adopt": key, "prior": f"{cid}:{csha}", "reason": "A의 다른 이유"})])
    rc, got, _ = s.apply()
    eq(got["issue#181"], ("OK", f"moved: {key} — {CJ.MT_MOVED_OLD}"), "adopt moved")
    GHS.set_issue(181, labels=["bug", "나중에 붙인 라벨"])
    eq(s.verify()[1]["issue#181"], ("WARN", f"{key} — {CJ.VT8}"), "row 8")
    rc, got, _ = s.apply()
    eq((rc, got["issue#181"]), (0, ("OK", f"already-done: {key} — {CJ.MT_ALREADY} ({CJ.MN_LATE})")), "rerun")
    eq((len(GHS.calls("post")), len(GHS.calls("close"))), (1, 1), "no new write")


@case("E1: this plan's ticket reads 404 before any check passed → not 'deleted' here: exit 9 (same run and rerun ×2), never a second POST /issue")
def _(f):
    for n in (191, 192):
        GHS.add_issue(n)
    s = Scn(f)
    s.build([(191, {}), (192, {})])
    f.fail_first["create"] = ["vanish", 1]
    rc, got, err = s.apply()
    key = CJ.move_history(s.chore, "issue#191")["keys"].popitem()[0]
    eq((rc, got.get("issue#191"), "issue#192" in got), (9, ("SKIP", f"manual: {key} — {CJ.M20}"), False), "same run")
    has(err, f"방금 만든 티켓 {key}: 만든 티켓을 다시 읽지 못함(없음)", "same-run cause")
    for i in (1, 2):
        rc, got, err = s.apply()
        eq((rc, got.get("issue#191"), "issue#192" in got), (9, ("SKIP", f"manual: {key} — {CJ.M20}"), False), f"rerun {i}")
        has(err, f"만든 뒤 확인하지 못한 티켓 {key}: 만든 티켓을 다시 읽지 못함(없음) — Jira 단계를 멈춤", f"rerun {i} cause")
    eq((len(f.creates()), GHS.calls("post"), GHS.calls("close")), (1, [], []), "one POST /issue in total")


@case("R11 E1 boundary: another plan's unchecked 404 KEY sent exactly at created= (.000) or later in that second (.500) → stop M20, no POST; at .999 of the second before → deleted, created once")
def _(f):
    created = P.parse_plan(open(HEADER_SRC, "rb").read())[0]["created"]      # 2026-10-15T05:12:33Z (whole seconds)
    eq(created, "2026-10-15T05:12:33Z", "fixture header created=")
    # parse_ts는 소수 초까지 시각으로 비교한다: 같은 초의 .500은 created=보다 뒤, .000은 같음(≥ 참), 앞 초의 .999는 앞
    eq((CJ.parse_ts("2026-10-15T05:12:33.000Z") == CJ.parse_ts(created),
        CJ.parse_ts("2026-10-15T05:12:33.500Z") > CJ.parse_ts(created),
        CJ.parse_ts("2026-10-15T05:12:32.999Z") < CJ.parse_ts(created)), (True, True, True), "parse_ts ordering")
    s = Scn(f)
    lines = ""
    for i, (n, at) in enumerate(((231, "2026-10-15T05:12:33.000Z"), (232, "2026-10-15T05:12:33.500Z"),
                                 (233, "2026-10-15T05:12:32.999Z")), 1):
        GHS.add_issue(n)
        att = f"20261015T051200Z-0000000{i}"
        lines += (CJ.mv_line(at, att, f"issue#{n}", "mv-create-sent", [("seq", "1"), ("acct", ME)]) +
                  CJ.mv_line(at, att, f"issue#{n}", "mv-create-ok", [("sid", f"{RUN_B}/{att}/1"), ("key", f"TST-{n}")]))
    open(s.journal(RUN_B), "w").write(lines)                   # 다른 계획(RUN_B)이 만들고 확인 전에 멈춘 KEY들 — 지금 모두 404
    for i, n in enumerate((231, 232), 1):
        run = f"20261016T00000{i}Z-0e0e0e0{i}"
        s.build([(n, {})], run_id=run)
        rc, got, err = s.apply(run_id=run)
        eq((rc, got[f"issue#{n}"], len(f.creates())), (9, ("SKIP", f"manual: TST-{n} — {CJ.M20}"), 0), f"issue {n} stops ({err})")
        has(err, f"만든 뒤 확인하지 못한 티켓 TST-{n}: 만든 티켓을 다시 읽지 못함(없음) — Jira 단계를 멈춤", f"issue {n} cause")
    run = "20261016T000003Z-0e0e0e03"
    s.build([(233, {})], run_id=run)
    rc, got, err = s.apply(run_id=run)
    want(got, "issue#233", "OK", "moved: ")
    eq((rc, len(f.creates())), (0, 1), f"before created= → deleted, one create ({err})")


@case("R13 E1 ownership: this plan's own unchecked KEY whose recorded send at is earlier than created= (clock moved back) reads 404 → stop M20, exit 9, no POST")
def _(f):
    GHS.add_issue(241)
    s = Scn(f)
    att = "20261014T000000Z-000000f1"                            # 보고(2026-10-15T05:12:33Z)보다 이른 at — 이 계획(RUN_A)의 전송
    open(s.journal(), "w").write(
        CJ.mv_line("2026-10-14T00:00:00.000Z", att, "issue#241", "mv-create-sent", [("seq", "1"), ("acct", ME)]) +
        CJ.mv_line("2026-10-14T00:00:01.000Z", att, "issue#241", "mv-create-ok", [("sid", f"{RUN_A}/{att}/1"), ("key", "TST-241")]))
    s.build([(241, {})])
    rc, got, err = s.apply()
    eq((rc, got["issue#241"], len(f.creates())), (9, ("SKIP", f"manual: TST-241 — {CJ.M20}"), 0), f"own KEY blocks ({err})")
    has(err, "만든 뒤 확인하지 못한 티켓 TST-241: 만든 티켓을 다시 읽지 못함(없음) — Jira 단계를 멈춤", "cause")


@case("R10/R15 M21: moved OK → a person reopens → rerun SKIP manual M21, no gh close; verify row 10 + M21; a next plan's adopt row is blocked too; a next plan's NEW ticket (old one deleted) closes it")
def _(f):
    GHS.add_issue(221)
    s = Scn(f)
    s.build([(221, {})])
    rc, got, _ = s.apply()
    key = key_of(got["issue#221"][1])
    eq((rc, CJ.move_history(s.chore, "issue#221")["closed"]), (0, {(RUN_A, key)}), "mv-closed recorded")
    GHS.set_issue(221, state="open", closed_at=None)              # 사람이 다시 엶(그 밖은 그대로)
    n0 = len(GHS.calls("close"))
    rc, got, _ = s.apply()
    eq((rc, got["issue#221"], len(GHS.calls("close")) - n0), (0, ("SKIP", f"manual: {key} — {CJ.M21}"), 0), "not re-closed")
    eq(s.verify()[1]["issue#221"], ("UNRESOLVED", f"{key} — {CJ.VT10}{CJ.M21}"), "row 10 + M21")
    (_k, cid), csha = next(iter(CJ.move_history(s.chore, "issue#221")["R"].items()))
    s.build([(221, {"adopt": key, "prior": f"{cid}:{csha}", "reason": "다음 계획의 이유"})], run_id=RUN_B)
    rc, got, err = s.apply(run_id=RUN_B)
    eq((rc, got["issue#221"]), (0, ("SKIP", f"manual: {key} — {CJ.M21}")), f"any plan's mv-closed blocks (R15) ({err})")
    eq((GHS.issue(221)["state"], len(GHS.calls("close")) - n0, len(GHS.calls("post")), s.events(221, RUN_B)),
       ("open", 0, 1, []), "B: no adopt line, no comment, no close")
    eq(s.verify(run_id=RUN_B)[1]["issue#221"], ("UNRESOLVED", f"{key} — {CJ.VT10}{CJ.M21}"), "B: row 10 + M21")
    del f.tickets[key]                                           # 오너가 티켓을 지움 → 다음 정리가 새 티켓을 만들어 닫는다(round 5c)
    run_c = "20261019T020000Z-0f0f0f0f"
    s.build([(221, {})], run_id=run_c)
    rc, got, err = s.apply(run_id=run_c)
    k2 = key_of(got["issue#221"][1])
    eq((rc, got["issue#221"], k2 != key), (0, ("OK", f"moved: {k2} — {CJ.MT_MOVED_NEW}"), True), f"new ticket closes it ({err})")
    eq((GHS.issue(221)["state"], len(GHS.calls("close")) - n0, len(GHS.migration(221))), ("closed", 1, 2),
       "closed once more; the old migration comment remains next to the new one")


@case("R18 (a): a row this plan moved, whose ticket a teammate later edited → rerun: OK already-done, no breaker, the next row moves; verify row 3 FAIL for it")
def _(f):
    for n in (251, 252):
        GHS.add_issue(n)
    s = Scn(f)
    s.build([(251, {}), (252, {})])
    f.create_fail_at[2] = "400"                                  # 둘째 행만 이번에 끝나지 않게(만들기 거절)
    rc, got, _ = s.apply()
    key = key_of(got["issue#251"][1])
    eq((rc, got["issue#251"][0], got["issue#252"][0]), (0, "OK", "FAIL"), "first run: 251 moved, 252 rejected")
    f.tickets[key]["summary"] = "팀원이 고친 요약"                 # 닫은 뒤 누가 티켓을 고침
    rc, got, err = s.apply()
    eq((rc, got["issue#251"]), (0, ("OK", f"already-done: {key} — {CJ.MT_ALREADY}")), f"no breaker on a closed row ({err})")
    want(got, "issue#252", "OK", "moved: ")
    eq((GHS.issue(252)["state"], len(GHS.calls("close"))), ("closed", 2), "the later row ran and closed")
    rc, v, _ = s.verify()
    eq(v["issue#251"], ("FAIL", f"{key} — {CJ.VT3}요약이 승인본과 다름"), "verify still reports the ticket difference (row 3)")


@case("R18 (b): a KEY this plan created but did not close (no mv-closed) whose ticket differs → still breaker + M5, open or closed by someone else")
def _(f):
    for n, closed in ((253, False), (254, True)):
        GHS.add_issue(n)
        s = Scn(f, run_id=RUN_A if n == 253 else RUN_B)
        s.build([(n, {})])
        eq(s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-comment-ok"})[0], -signal.SIGKILL, f"{n}: killed before the close")
        key = CJ.move_history(s.chore, f"issue#{n}")["keys"].popitem()[0]
        f.tickets[key]["summary"] = "팀원이 고친 요약"
        if closed:                                               # 다른 사람이 닫음 — 이 계획의 mv-closed는 없다
            GHS.edit(lambda st: st["issues"][str(n)].update(state="closed", closed_at=st["issues"][str(n)]["updated_at"]))
        n_close = len(GHS.calls("close"))
        rc, got, err = s.apply()
        eq((rc, got[f"issue#{n}"]), (9, ("SKIP", f"manual: {key} — {CJ.M5}")), f"{n}: breaker ({err})")
        eq(len(GHS.calls("close")) - n_close, 0, f"{n}: no close")


@case("R16: CLOSED + linked replacement comment → C5 posts; a person reopens during the POST → re-read OPEN → SKIP M21 right before C6, no close, the posted comment recorded")
def _(f):
    GHS.add_issue(224)
    s = Scn(f)
    s.build([(224, {})])
    rc, got, _ = s.apply()
    key = key_of(got["issue#224"][1])
    GHS.delete_comment(224, GHS.migration(224)[0]["id"])          # 닫힌 채로 이관 댓글만 지워짐
    eq(s.resolve("--ref", "issue#224", "--key", key, "--plan", RUN_A, "--link")[0], 0, "link authorizes one replacement")
    GHS.mode("post", "reopen", times=1)
    n_close = len(GHS.calls("close"))
    rc, got, err = s.apply()
    eq((rc, got["issue#224"]), (0, ("SKIP", f"manual: {key} — {CJ.M21}")), f"stopped before the close ({err})")
    eq((len(GHS.calls("close")) - n_close, GHS.issue(224)["state"], len(GHS.migration(224))), (0, "open", 1),
       "no close; the approved replacement comment stays")
    eq(s.events(224)[-2:], ["mv-comment-sent", "mv-comment-ok"], "the post is recorded")
    eq(s.verify()[1]["issue#224"], ("UNRESOLVED", f"{key} — 티켓 만듦, 이슈 닫지 않음: 옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음"),
       "verify row 10 + M21")


@case("R15: reopened + migration comment deleted + operator --link (retire) → rerun stops at M21 before C5: zero comment posts, zero closes")
def _(f):
    GHS.add_issue(223)
    s = Scn(f)
    s.build([(223, {})])
    rc, got, _ = s.apply()
    key = key_of(got["issue#223"][1])
    GHS.set_issue(223, state="open", closed_at=None)
    GHS.delete_comment(223, GHS.migration(223)[0]["id"])
    eq(s.apply()[1]["issue#223"], ("SKIP", f"manual: {key} — {CJ.M6}"), "deleted migration comment shows first (C2)")
    eq(s.resolve("--ref", "issue#223", "--key", key, "--plan", RUN_A, "--link")[0], 0, "operator links (retire + link)")
    n_post, n_close = len(GHS.calls("post")), len(GHS.calls("close"))
    rc, got, _ = s.apply()
    eq((rc, got["issue#223"]), (0, ("SKIP", f"manual: {key} — {CJ.M21}")), "M21 before C5")
    eq((len(GHS.calls("post")) - n_post, len(GHS.calls("close")) - n_close, GHS.issue(223)["state"]), (0, 0, "open"),
       "no re-post, no close")
    eq(s.events(223)[-2:], ["mv-retire", "mv-link"], "nothing journaled by the rerun")


@case("R10 kill between gh close and mv-closed (hook mv-gh-closed): the rerun has no mv-closed → if a person reopened meanwhile it closes again (accepted); if not, already-done")
def _(f):
    GHS.add_issue(222)
    s = Scn(f)
    s.build([(222, {})])
    eq(s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-gh-closed"})[0], -signal.SIGKILL, "killed after gh close")
    key = next(iter(f.tickets))
    eq((GHS.issue(222)["state"], "mv-closed" in s.events(222)), ("closed", False), "closed, not recorded")
    eq(s.verify()[1]["issue#222"], ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.M18}"), "right after the kill: 10b + M18")
    GHS.set_issue(222, state="open", closed_at=None)
    rc, got, _ = s.apply()
    eq((rc, got["issue#222"]), (0, ("OK", f"moved: {key} — {CJ.MT_MOVED_OLD}")), "closes again (contract: accepted)")
    eq((len(GHS.calls("close")), s.events(222)[-1]), (2, "mv-closed"), "second close, now recorded")


@case("R10 journal grammar: mv-closed malformed / twice in one (attempt, ref) / before any migration-comment record for KEY → FormatError")
def _(f):
    d = tempfile.mkdtemp(prefix="closed.", dir=root())
    A = "20261021T000001Z-00000001"
    base = [f"2026-10-21T00:00:01.000Z {A} issue#7 mv-create-sent seq=1 acct={ME}",
            f"2026-10-21T00:00:02.000Z {A} issue#7 mv-create-ok sid={RUN_A}/{A}/1 key=TST-7",
            f"2026-10-21T00:00:03.000Z {A} issue#7 mv-comment-sent seq=2 key=TST-7 tsha={'a' * 64}",
            f"2026-10-21T00:00:04.000Z {A} issue#7 mv-comment-ok sid={RUN_A}/{A}/2 cid=70 csha={'a' * 64}"]
    good = f"2026-10-21T00:00:05.000Z {A} issue#7 mv-closed key=TST-7"
    open(os.path.join(d, RUN_A + ".journal"), "w").write("\n".join(base + [good]) + "\n")
    eq(CJ.move_history(d, "issue#7", RUN_A)["closed"], {(RUN_A, "TST-7")}, "accepted")
    for lines, needle in ((base + [f"2026-10-21T00:00:05.000Z {A} issue#7 mv-closed key=tst-7"], "값 형식"),
                          (base + [f"2026-10-21T00:00:05.000Z {A} issue#7 mv-closed key=TST-7 cid=70"], "칸은"),
                          (base + [f"2026-10-21T00:00:05.000Z {A} issue#7 mv-closed"], "칸은"),
                          (base + [good, good.replace("00:00:05", "00:00:06")], "mv-closed가 둘"),
                          (base[:2] + [f"2026-10-21T00:00:03.000Z {A} issue#7 mv-closed key=TST-7"], "이관 댓글 기록이 없음"),
                          (base + [f"2026-10-21T00:00:05.000Z {A} issue#7 mv-closed key=TST-8"], "이관 댓글 기록이 없음"),
                          # R12 (a) 닫힘이 채택 줄보다 앞(같은 시각, 같은 일지) — 시각이 아니라 순서로 거절
                          (base[:2] + [f"2026-10-21T00:00:05.000Z {A} issue#7 mv-closed key=TST-7",
                                       f"2026-10-21T00:00:05.000Z {A} issue#7 mv-comment-adopt key=TST-7 cid=71 csha={'b' * 64}"],
                           "이관 댓글 기록이 없음")):
        open(os.path.join(d, RUN_A + ".journal"), "w").write("\n".join(lines) + "\n")
        try:
            CJ.move_history(d, "issue#7", RUN_A)
            raise AssertionError(f"accepted: {lines[-1]}")
        except CJ.FormatError as e:
            has(str(e), needle, lines[-1])
    # R12 (b) 댓글 기록 → mv-closed, 닫힘 시각이 더 이름(시계가 뒤로 감), 같은 일지 → 받음
    back = f"2026-10-21T00:00:00.500Z {A} issue#7 mv-closed key=TST-7"
    open(os.path.join(d, RUN_A + ".journal"), "w").write("\n".join(base + [back]) + "\n")
    eq(CJ.move_history(d, "issue#7", RUN_A)["closed"], {(RUN_A, "TST-7")}, "backward clock, physical order ok")
    # R12 (c) 이관 댓글 기록은 다른 계획(RUN_B) 일지에만, mv-closed는 이 일지 → 거절
    B = "20261021T000009Z-00000009"
    open(os.path.join(d, RUN_B + ".journal"), "w").write("\n".join(
        [x.replace(RUN_A, RUN_B).replace(A, B) for x in base]) + "\n")
    open(os.path.join(d, RUN_A + ".journal"), "w").write(f"2026-10-21T00:00:05.000Z {A} issue#7 mv-closed key=TST-7\n")
    try:
        CJ.move_history(d, "issue#7", RUN_A)
        raise AssertionError("mv-closed accepted with the comment record only in another plan's journal")
    except CJ.FormatError as e:
        has(str(e), "앞(같은 일지)에 그 KEY의 이관 댓글 기록이 없음", "cross-file")


@case("R9 E1 by time: plans A and B both reported before either applies; A's new ticket reads 404 (A stops) → B stops too (M20, exit 9), no second create")
def _(f):
    GHS.add_issue(211)
    s = Scn(f)
    s.build([(211, {})])                                         # A (RUN_A)
    s.build([(211, {})], run_id=RUN_B)                           # B — 같은 보고 시각(fixture created=), A가 만들기 전
    f.fail_first["create"] = ["vanish", 1]
    rc, got, err = s.apply()
    key = CJ.move_history(s.chore, "issue#211")["keys"].popitem()[0]
    eq((rc, got["issue#211"]), (9, ("SKIP", f"manual: {key} — {CJ.M20}")), f"A stops ({err})")
    rc, got, err = s.apply(run_id=RUN_B)
    eq((rc, got["issue#211"]), (9, ("SKIP", f"manual: {key} — {CJ.M20}")), "B stops on A's unchecked 404 KEY")
    has(err, f"만든 뒤 확인하지 못한 티켓 {key}: 만든 티켓을 다시 읽지 못함(없음) — Jira 단계를 멈춤", "B stderr cause")
    eq((len(f.creates()), GHS.calls("post"), GHS.calls("close")), (1, [], []), "no second POST /issue")


@case("R9 E1 by time: another plan's unchecked KEY made BEFORE this plan's created= that reads 404 → still deleted → this plan creates once; made after → stop")
def _(f):
    s = Scn(f)
    att = "20261014T000000Z-000000c1"
    lines = ""
    for n, k in ((212, "TST-77"), (213, "TST-78")):            # B가 2026-10-14에 만들고 확인 전에 멈춘 KEY, 지금 둘 다 404
        GHS.add_issue(n)
        seq = 1 if n == 212 else 2
        lines += (CJ.mv_line("2026-10-14T00:00:00.000Z", att, f"issue#{n}", "mv-create-sent", [("seq", str(seq)), ("acct", ME)]) +
                  CJ.mv_line("2026-10-14T00:00:01.000Z", att, f"issue#{n}", "mv-create-ok",
                             [("sid", f"{RUN_B}/{att}/{seq}"), ("key", k)]))
    open(s.journal(RUN_B), "w").write(lines)
    s.build([(212, {})])                                         # 보고 2026-10-15T05:12:33Z (TST-77 뒤) → 지워짐
    rc, got, err = s.apply()
    want(got, "issue#212", "OK", "moved: ")
    eq((rc, len(f.creates()), key_of(got["issue#212"][1]) != "TST-77"), (0, 1, True), f"created once ({err})")
    run_c = "20261013T000000Z-0d0d0d0d"
    s.build([(213, {})], run_id=run_c, created="2026-10-13T00:00:00Z")   # 보고가 TST-78보다 앞 → build가 본 적 없음 → 멈춤
    rc, got, err = s.apply(run_id=run_c)
    eq((rc, got["issue#213"], len(f.creates())), (9, ("SKIP", f"manual: TST-78 — {CJ.M20}"), 1), f"stops ({err})")


@case("E2: resolve --not-created refuses when the text search misses the ticket but the reporter + created search finds it; no journal line")
def _(f):
    GHS.add_issue(193)
    s = Scn(f)
    s.build([(193, {})])
    f.fail_first["create"] = ["store-then-503", 1]
    s.apply()
    sid = s.hist(193)["pending_creates"][0]
    f.hidden.update(f.tickets)                       # 글 색인에 아직 없음
    n0 = len(jlines(s.journal()))
    rc, _o, err = s.resolve("--sid", sid, "--not-created")
    eq((rc, len(jlines(s.journal()))), (1, n0), "refused, nothing written")
    has(err, "--found로", "same refusal path")
    has(err, next(iter(f.tickets)), "names the ticket")
    jql = f.reporter_jql[-1]
    has(jql, f'reporter = "{ME}" AND created >= "', "reporter + created JQL")
    other = f.add_ticket(description=desc_for(193), reporter=ME)   # 같은 보고자의 다른 이슈 티켓은 무관
    f.tickets[other]["description"]["content"][0]["content"][0]["text"] = P.move_url_line(REPO_URL, 999)
    f.tickets.pop(next(k for k in f.tickets if k != other))
    rc, _o, err = s.resolve("--sid", sid, "--not-created")
    eq(rc, 0, f"accepted once only another issue's ticket remains ({err})")


@case("R1 10b: kill at mv-comment-ok, then a human closes with a comment (comment before closed_at, updated == closed_at) → rerun SKIP changed; verify row 10 + M13, not 10b")
def _(f):
    GHS.add_issue(201)
    s = Scn(f)
    s.build([(201, {})])
    s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-comment-ok"})
    key = next(iter(f.tickets))
    GHS.comment(201, HUMAN, "제가 닫습니다")                    # "close with comment": 댓글 → 닫기, 한 번에
    GHS.edit(lambda st: st["issues"]["201"].update(state="closed", closed_at=st["issues"]["201"]["updated_at"]))
    rc, got, _ = s.apply()
    eq((rc, got["issue#201"]), (0, ("SKIP", f"changed: {key} — {CJ.M13}")), "C2 stops")
    eq(s.verify()[1]["issue#201"], ("UNRESOLVED", f"{key} — {CJ.VT10}{CJ.M13}"), "row 10, not 10b")


@case("R1 10b: FAIL close-failed, then someone else closes → verify 10b with the carried reason (M15); a later aborted run (NOT-ATTEMPTED) → 10b + M18; rerun OK")
def _(f):
    GHS.add_issue(202)
    s = Scn(f)
    s.build([(202, {})])
    GHS.mode("close", "noop", times=1)
    rc, got, _ = s.apply()
    key = key_of(got["issue#202"][1])
    eq(got["issue#202"], ("FAIL", f"close-failed: {key} — {CJ.M15}"), "close-failed")
    GHS.edit(lambda st: st["issues"]["202"].update(state="closed", closed_at=st["issues"]["202"]["updated_at"]))
    eq(s.verify()[1]["issue#202"], ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.M15}"), "10b + M15")
    f.modes["project"] = "500"                                   # 다음 실행이 행 앞에서 멈춤 → 마지막 결과 NOT-ATTEMPTED
    eq(s.apply()[0], 6, "aborted run")
    del f.modes["project"]
    eq(s.verify()[1]["issue#202"], ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.M18}"), "10b + M18")
    rc, got, _ = s.apply()
    eq((rc, got["issue#202"]), (0, ("OK", f"already-done: {key} — {CJ.MT_ALREADY}")), "rerun closes the loop")


@case("R7 10b: kill after mv-closed, rerun with another gh login → SKIP account; verify 10b carries that reason (not M18)")
def _(f):
    GHS.add_issue(204)
    s = Scn(f)
    s.build([(204, {})])
    eq(s.apply(env={"CHORE_JIRA_TEST_KILL_AFTER": "mv-closed"})[0], -signal.SIGKILL, "killed after the close")
    key = next(iter(f.tickets))
    eq(s.verify()[1]["issue#204"], ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.M18}"), "abort fill → M18")
    GHS.edit(lambda st: st.update(login="someone-else"))
    eq(s.apply()[1]["issue#204"], ("SKIP", "account: " + CJ.MT_ACCOUNT), "rerun with another login")
    eq(s.verify()[1]["issue#204"], ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.MT_ACCOUNT}"), "10b carries the real reason")
    GHS.edit(lambda st: st.update(login=LOGIN))
    f.project_id = "10999"                                       # SKIP type(프로젝트가 승인 때와 다름)도 그대로 싣는다
    eq(s.apply()[1]["issue#204"], ("SKIP", "type: " + CJ.MT_TYPE + CJ.MT_PROJECT), "rerun SKIP type")
    eq(s.verify()[1]["issue#204"], ("UNRESOLVED", f"{key} — {CJ.VT10C}{CJ.MT_TYPE}{CJ.MT_PROJECT}"), "10b carries SKIP type")


@case("R2: --not-created for S is accepted when the only matching ticket is bound to another send S2 (same reporter, URL, window); --found K for S is refused")
def _(f):
    GHS.add_issue(203)
    s = Scn(f)
    s.build([(203, {})])
    k = ours_ticket(f, 203)
    f.hidden.add(k)                                              # 글 색인 밖 — 두 번째 찾기(보고자·만든 시각)만 본다
    at = CJ.now_instant()
    a_att, b_att = "20261021T120000Z-000000a1", "20261021T120000Z-000000b1"
    open(s.journal(RUN_B), "w").write(
        CJ.mv_line(at, b_att, "issue#203", "mv-create-sent", [("seq", "1"), ("acct", ME)]) +
        CJ.mv_line(at, b_att, "issue#203", "mv-create-ok", [("sid", f"{RUN_B}/{b_att}/1"), ("key", k)]))
    open(s.journal(), "w").write(CJ.mv_line(at, a_att, "issue#203", "mv-create-sent", [("seq", "1"), ("acct", ME)]))
    sid = f"{RUN_A}/{a_att}/1"
    rc, _o, err = s.resolve("--sid", sid, "--found", k)
    eq(rc, 1, "--found of a KEY bound to another send")
    has(err, "만든 티켓이 아님", "refusal")
    n0 = len(f.reporter_jql)
    rc, _o, err = s.resolve("--sid", sid, "--not-created")
    eq((rc, len(f.reporter_jql) - n0), (0, 1), f"accepted after the second search ({err})")
    eq(s.events(203)[-1], "mv-resolve-not-created", "line written")


@case("a ticket whose marker names another issue (block 1 = this issue) is not accepted: ticket_check orig → mismatch, apply SKIP manual M5, no close")
def _(f):
    GHS.add_issue(121)
    s = Scn(f)
    s.build([(121, {})])
    doc = desc_for(121)
    doc["content"][-1]["content"][0]["text"] = P.MARKER_FMT % ("GitHub issue #122", PLAN_DATE_B)
    key = f.add_ticket(description=doc, reporter=ME, summary=P.move_summary(GHS.issue(121)["title"]))
    c = client()
    view = CJ.gh_issue(REMOTE, 121)
    row = P.parse_plan(open(s.plan(), "rb").read())[1][0]
    ic = CJ.issue_check(view, row["snapshot"], row["move"], {}, row["move"]["plan_date"], REPO_URL)
    eq(CJ.ticket_check(c, key, "orig", ic["payload"], ME, REPO_URL, 121), "표지가 다른 이슈를 가리킴", "orig marker")
    rc, got, _ = s.apply()
    eq((rc, got["issue#121"]), (0, ("SKIP", f"manual: {key} — {CJ.M5}")), "SKIP manual, no breaker (orig)")
    eq((GHS.calls("post"), GHS.calls("close"), len(f.creates())), ([], [], 0), "nothing written")


@case("fixed reasons M1–M21 = contract-shared.md §5 byte for byte; RESULT/VERIFY prefixes = §1/§2")
def _(f):
    for k, t in CONTRACT_M.items():
        eq(getattr(CJ, k).encode("utf-8"), t.encode("utf-8"), k)
    eq(CJ.FIXED_REASONS, tuple(CONTRACT_M[f"M{i}"] for i in range(1, 22)), "FIXED_REASONS = §5 M1–M21 in order")
    eq(CJ.ABORT_FILL_PREFIXES, ("journal has a write of this attempt, outcome unread", "journal unreadable at abort"),
       "chore.sh:117-118 abort-fill heads")
    for name, text in (("VT2", "결과 미확정 — 사람이 확인 후 기록 필요: "), ("VT3", "티켓이 안 보이거나 내용이 승인본과 다름: "),
                       ("VT4", "이 이슈의 티켓 여럿: "), ("VT5", "옮겼는데 이슈가 열려 있음"), ("VT6", "이관 댓글 없음·중복·바뀜: "),
                       ("VT7", "닫기 전에 이슈 내용이 바뀜"), ("VT8", "현재 내용이 승인본과 다름 — 변경 시점 확정 불가"),
                       ("VT9", "옮김"), ("VT10", "티켓 만듦, 이슈 닫지 않음: "), ("VT10C", "티켓 만듦, 이슈는 닫힘: "), ("VT11", "이 이슈를 가리키는 티켓이 이미 있음: "),
                       ("VT12F", "만든 것 없음 — Jira가 거절함"), ("VT13", "이번 실행에서 시도 안 함"),
                       ("MT_MOVED_NEW", "티켓을 만들고 이슈를 닫음"), ("MT_MOVED_OLD", "이미 만든 티켓으로 이슈를 닫음"),
                       ("MT_ALREADY", "이미 닫혀 있고 이관 댓글 있음"), ("MT_ACCOUNT", "Jira 계정 또는 GitHub 로그인이 승인 때와 다름"),
                       ("MT_EXISTS", "이 이슈를 가리키는 티켓이 이미 있음: "), ("MT_TYPE", "티켓 유형을 만들 수 없음 — "),
                       ("MT_UNKNOWN_CREATE", "만들기 결과 모름 — 다음 실행이 확인")):
        eq(getattr(CJ, name), text, name)
    eq(CJ.VT12_WHY, {"account": "계정이 승인 때와 다름", "changed": "이슈가 승인 뒤 바뀜", "type": "티켓 유형을 만들 수 없음",
                     "withdrawn": "보내기 전에 멈춤"}, "row 12 사유")


@case("chore-jira.py calls no private chore_plan name (plan._x / P._x / plan_mod()._x); rebuilt_payload == approved bytes")
def _(f):
    src = open(SCRIPT, encoding="utf-8").read()
    hits = [(i, ln.strip()) for i, ln in enumerate(src.split("\n"), 1)
            if re.search(r"\b(?:plan|P|PLAN|_PLAN|plan_mod\(\))\._[A-Za-z]", ln)]
    eq(hits, [], "private chore_plan names referenced")
    GHS.add_issue(141, comments=[(HUMAN, "줄1\n줄2")])
    c = client()
    view = CJ.gh_issue(REMOTE, 141)
    snap = {"project_id": PID, "issuetype": TYPE, "account": ME}
    ic = CJ.issue_check(view, snap, {"reason": "이유\n둘째 줄", "related": ["TST-3"]}, {}, PLAN_DATE, REPO_URL)
    key = f.add_ticket(description=json.loads(ic["payload"])["fields"]["description"], reporter=ME,
                       summary=json.loads(ic["payload"])["fields"]["summary"])
    eq(CJ.rebuilt_payload(CJ.ticket_view(c, key), snap), ic["payload"], "rebuilt bytes = approved bytes (Jira attrs ignored)")
    f.tickets[key]["description"]["content"].append({"type": "bulletList", "content": []})
    eq(CJ.rebuilt_payload(CJ.ticket_view(c, key), snap), None, "unknown block → None")


@case("every RESULT / VERIFY text constant is reachable — verify table rows 1–13 + 10b and fixed reasons M1–M21 all seen")
def _(f):
    missing = sorted(set(range(1, 14)) - REACHED) + ([] if "10b" in REACHED else ["10b"])
    if missing:
        raise AssertionError(f"design §7 rows never reached: {missing} (reached {sorted(REACHED)})")
    mm = sorted(set(M_TEXTS) - REACHED_M, key=lambda k: int(k[1:]))
    if mm:
        raise AssertionError(f"fixed reasons never produced: {mm}")


def main():
    global FJ, GHS
    FJ = FakeJira()
    GHS = GH()
    if " " in sys.executable or " " in root():
        print("FAIL paths with spaces — CHORE_GH is split on spaces")
        return 1
    failed = 0
    try:
        for name, fn in CASES:
            FJ.reset()
            GHS.reset()
            shutil.rmtree(os.path.join(root(), "home"), ignore_errors=True)
            os.makedirs(os.path.join(root(), "home"))
            try:
                fn(FJ)
                print(f"ok   {name}")
            except Exception as e:
                failed += 1
                detail = e if isinstance(e, AssertionError) else traceback.format_exc().strip().splitlines()[-3:]
                print(f"FAIL {name}: {detail}")
    finally:
        FJ.close()
        if ROOT is not None and not os.environ.get("CHORE_TEST_KEEP"):
            shutil.rmtree(ROOT, ignore_errors=True)
    print(f"{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


FJ = GHS = None
if __name__ == "__main__":
    sys.exit(main())
