#!/usr/bin/env python3
"""chore-jira.test.py — scripts/chore-jira.py 회귀 표 (chore v4 U1, 2026-10-19).

가짜 Jira(http.server, 127.0.0.1, 스레드 하나)에 CLI를 subprocess(`python3 -I`)로 붙인다: CHORE_JIRA_BASE +
가짜 자격 증명 env(JIRA_EMAIL, JIRA_API_TOKEN=test-token-xyz). 사례마다 ok/FAIL 한 줄, FAIL이 하나라도 있으면 exit 1.
모든 호출에서 검사: stderr에 토큰·base64 쌍·'http'가 없고 한 줄 이하; 성공이면 stderr가 비고 stdout = JSON 문서 한 줄;
실패면 stdout이 빈다. 가짜 서버는 Jira의 ADF 제약(빈 text 노드 거부)을 그대로 검사하고, 401 본문에 받은
Authorization 헤더와 URL을 되돌려 준다(노출 검사가 실제로 뭔가를 막는지 보려고).
Run: python3 -I __tests__/py/chore-jira.test.py
part (b) 테스트는 FakeJira · run_cli · CJ(모듈)를 그대로 쓴다.
"""
import base64
import fcntl
import importlib.util
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import types
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True
os.environ["CHORE_JIRA_RETRY_SLEEP"] = "0"   # in-process Client (모듈 API 사례)
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "..", "scripts", "chore-jira.py"))   # this file is <skill>/__tests__/py/
_spec = importlib.util.spec_from_file_location("chore_jira", SCRIPT)
CJ = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(CJ)

EMAIL, TOKEN = "tester@example.com", "test-token-xyz"
PAIR = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
ME, OTHER = "acct-me", "acct-other"
KST = timezone(timedelta(hours=9))
T0 = datetime(2026, 10, 19, 7, 0, 0, tzinfo=KST)
U0 = "2026-10-19T06:07:25.160+0900"
SITE = "example.atlassian.net"

TEXT_QA = ("저장소 정리 중 확인했습니다. 이 작업의 변경(PR #123(develop에 합쳐짐), 커밋 0123456789ab)은 staging 배포 "
           "https://github.com/test/repo/actions/runs/123456(2026-10-19 06:07)에 포함되어 있습니다. 그래서 QA (staging)로 "
           "옮깁니다. 배포 확인됨.\n\nchore 정리 → QA (staging) — by Claude triage 2026-10-19")
TEXT_CLOSED = ("저장소 정리 중 확인했습니다. 같은 요청이 PROJ-42로 다시 올라왔습니다. 근거: duplicate:PROJ-42. 그래서 닫습니다. "
               "필요하면 다시 열어 주세요.\nchore 정리 → Closed — by Claude triage 2026-10-19")
TEXT_EDGES = "\n\n앞에 빈 줄 둘\n\n\n가운데 빈 줄 둘 — 끝에 줄바꿈\n"
TEXT_MISC = "탭\t포함 · ‘따옴표’ \"쌍\" \\ 백슬래시 #123 → #456 <b>태그</b> & 100%"


def jts(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}" + dt.strftime("%z")


# --- fake Jira ----------------------------------------------------------------------------
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
    """Jira가 거부할 ADF면 이유, 아니면 None (빈 text 노드 · marks · doc/version/paragraph 모양)."""
    if not (isinstance(doc, dict) and doc.get("type") == "doc" and doc.get("version") == 1
            and isinstance(doc.get("content"), list) and doc["content"]):
        return "doc"
    for p in doc["content"]:
        if not (isinstance(p, dict) and p.get("type") == "paragraph" and isinstance(p.get("content"), list)):
            return "paragraph"
        for t in p["content"]:
            if t.get("type") != "text" or "marks" in t or not isinstance(t.get("text"), str) or t["text"] == "":
                return "text node"
    return None


class FakeJira:
    """메모리 Jira. modes[route] = 동작 주입: 401 403 500 302 400 bad-json drop store-then-500 store-then-drop
    store-then-sleep drift(comments) no-islast/empty-notlast(changelog) loop/no-token(search).
    route = myself view comments comment.post transitions transition.post changelog search."""

    def __init__(self):
        self.lock = threading.RLock()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(self))
        self.server.daemon_threads = True
        self.server.handle_error = lambda request, client_address: None
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.reset()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def reset(self):
        with self.lock:
            self.issues, self.comments, self.histories, self.transitions = {}, {}, {}, {}
            self.aliases, self.total_delta, self.modes = {}, {}, {}
            self.search_issues, self.page, self.log, self.key_log = [], 2, [], []
            self.tick, self.next_comment, self.redirect_hits, self.drift = 0, 20000, 0, 0
            self.me, self.fail_first, self.error_body = ME, {}, b""   # fail_first[route] = [mode, 남은 횟수] — 처음 n번만 그 동작
            # v4.3 move: chore-evidence가 바인딩 프로젝트의 id와 만들 수 있는 유형을 읽는다(project · issuetypes 경로)
            self.project_ids = {"TST": "10000", "PROJ": "10001", "OTH": "10002"}
            self.issuetypes = [{"id": "10006", "name": "작업", "subtask": False, "hierarchyLevel": 0},
                               {"id": "10005", "name": "버그", "subtask": False, "hierarchyLevel": 0},
                               {"id": "10002", "name": "에픽", "subtask": False, "hierarchyLevel": 1},
                               {"id": "10007", "name": "하위 작업", "subtask": True, "hierarchyLevel": -1}]

    def now(self):
        self.tick += 1
        return jts(T0 + timedelta(seconds=self.tick))

    def add_issue(self, key, **kw):
        issue = {"id": str(10000 + len(self.issues) + 1), "key": key, "project": key.split("-")[0],
                 "status": {"id": "10003", "name": "In Progress"}, "updated": U0, "assignee": ME,
                 "summary": f"{key} 요약", "description": None, "creator": OTHER, "created": "2026-10-01T10:00:00.000+0900",
                 "labels": [], "issuelinks": [], "bump": True}
        issue.update(kw)
        self.issues[key] = issue
        self.comments.setdefault(key, [])
        self.histories.setdefault(key, [])
        self.transitions.setdefault(key, [])
        return issue

    def add_comment(self, key, text, author=ME, created=None, updated=None):
        self.next_comment += 1
        created = created or self.now()
        c = {"id": str(self.next_comment), "author": author, "body": CJ.build_adf(text),
             "created": created, "updated": updated or created}
        self.comments[key].append(c)
        return c

    def calls(self, method, route):
        return [q for (m, r, q, _a) in self.log if m == method and r == route]

    # --- HTTP ---
    def _send(self, req, code, obj=None, raw=None, headers=()):
        data = raw if raw is not None else (b"" if obj is None else json.dumps(obj, ensure_ascii=False).encode())
        try:
            req.send_response(code)
            for k, v in headers:
                req.send_header(k, v)
            if code != 204:
                req.send_header("Content-Type", "application/json")
            req.send_header("Content-Length", str(len(data)))
            req.end_headers()
            if data:
                req.wfile.write(data)
        except OSError:
            pass

    def _route(self, method, path):
        if path == "/rest/api/3/myself" and method == "GET":
            return "myself", None
        if path == "/rest/api/3/search/jql" and method == "GET":
            return "search", None
        m = re.fullmatch(r"/rest/api/3/project/([^/]+)", path)
        if m and method == "GET":
            return "project", urllib.parse.unquote(m.group(1))
        m = re.fullmatch(r"/rest/api/3/issue/createmeta/([^/]+)/issuetypes", path)
        if m and method == "GET":
            return "issuetypes", urllib.parse.unquote(m.group(1))
        m = re.fullmatch(r"/rest/api/3/issue/([^/]+)(?:/(comment|transitions|changelog))?", path)
        if not m:
            return None, None
        key, sub = urllib.parse.unquote(m.group(1)), m.group(2)
        route = {("GET", None): "view", ("GET", "comment"): "comments", ("POST", "comment"): "comment.post",
                 ("GET", "transitions"): "transitions", ("POST", "transitions"): "transition.post",
                 ("GET", "changelog"): "changelog"}.get((method, sub))
        return route, key

    def handle(self, req, method):
        u = urllib.parse.urlsplit(req.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        n = int(req.headers.get("Content-Length") or 0)
        body = req.rfile.read(n) if n else b""          # 요청은 언제나 끝까지 읽는다 (응답 유실 사례 포함)
        auth = req.headers.get("Authorization")
        if u.path == "/redirected":
            with self.lock:
                self.redirect_hits += 1
            return self._send(req, 200, {"accountId": "redirected", "id": "1", "created": U0})
        route, key = self._route(method, u.path)
        with self.lock:
            self.log.append((method, route, q, auth))
            self.key_log.append(key)
            mode = self.modes.get(route)
            ff = self.fail_first.get(route)
            if ff and ff[1] > 0:
                ff[1] -= 1
                mode = ff[0]
        if auth != "Basic " + PAIR or mode == "401":
            return self._send(req, 401, {"errorMessages": [f"bad auth {auth} at {self.base}{req.path}"]})
        if mode == "403":
            return self._send(req, 403, {"errorMessages": [f"forbidden for {auth}"]})
        if route is None:
            return self._send(req, 404, {"errorMessages": ["no route"]})
        if mode == "500":
            return self._send(req, 500, {"errorMessages": ["internal"]})
        if mode == "302":
            return self._send(req, 302, headers=[("Location", f"{self.base}/redirected")])
        if mode == "bad-json":
            return self._send(req, 200, raw=b"<html>not json</html>")
        if mode == "drop":
            req.close_connection = True
            return None
        if mode == "sleep-nostore":
            time.sleep(1.5)
            return self._send(req, 500, {"errorMessages": ["late"]})
        if mode == "sleep-400":
            time.sleep(1.5)
            return self._send(req, 400, {"errorMessages": ["late reject"]})
        if mode == "400-custom":     # 오류 본문 = self.error_body 그대로
            return self._send(req, 400, raw=self.error_body)
        if mode == "400":
            return self._send(req, 400, {"errorMessages": [f"rejected token {TOKEN} basic {PAIR} see {self.base}/x"],
                                         "errors": {"comment": "too long " + "x" * 500}})
        with self.lock:
            code, obj = self._dispatch(route, key, q, body, mode)
        if mode == "store-then-500":
            return self._send(req, 500, {"errorMessages": ["stored, then failed"]})
        if mode == "store-then-drop":
            req.close_connection = True
            return None
        if mode == "store-then-sleep":
            time.sleep(1.5)
        return self._send(req, code, obj)

    def _issue(self, key):
        key = self.aliases.get(key, key)
        return self.issues.get(key)

    def _dispatch(self, route, key, q, body, mode):
        if route == "myself":
            return 200, {"accountId": self.me, "displayName": "operator", "self": f"{self.base}/rest/api/3/user?accountId={self.me}"}
        if route == "search":
            return self._search(q, mode)
        if route == "project":
            if key not in self.project_ids:
                return 404, {"errorMessages": ["No project could be found with key '%s'." % key]}
            return 200, {"id": self.project_ids[key], "key": key, "name": key + " 프로젝트"}
        if route == "issuetypes":
            if key not in self.project_ids:
                return 404, {"errorMessages": ["no project"]}
            start, size = int(q.get("startAt", 0)), min(int(q.get("maxResults", 50)), self.page)
            return 200, {"startAt": start, "maxResults": size, "total": len(self.issuetypes),
                         "issueTypes": [dict(t) for t in self.issuetypes[start:start + size]]}
        issue = self._issue(key)
        if issue is None:
            return 404, {"errorMessages": ["Issue does not exist or you do not have permission to see it."]}
        k = issue["key"]
        if route == "view":
            acct = lambda a: None if a is None else {"accountId": a, "displayName": a}
            f = {"project": {"key": issue["project"], "id": "10100"}, "status": dict(issue["status"]),
                 "updated": issue["updated"], "assignee": acct(issue["assignee"]), "summary": issue["summary"],
                 "description": issue["description"], "creator": acct(issue["creator"]), "created": issue["created"],
                 "labels": list(issue["labels"]), "issuelinks": issue["issuelinks"]}
            if issue.get("no_description"):
                del f["description"]
            return 200, {"id": issue["id"], "key": k, "self": f"{self.base}/rest/api/3/issue/{issue['id']}", "fields": f}
        if route == "comments":
            start, size = int(q.get("startAt", 0)), min(int(q.get("maxResults", 50)), self.page)
            lst = self.comments[k]
            total = len(lst) + self.total_delta.get(k, 0)
            if mode == "drift":
                self.drift += 1
                total += self.drift
            page = [dict({"id": c["id"], "author": {"accountId": c["author"]}, "created": c["created"],
                          "updated": c["updated"]}, **({"body": c["body"]} if "body" in c else {}))
                    for c in lst[start:start + size]]
            return 200, {"startAt": start, "maxResults": size, "total": total, "comments": page}
        if route == "comment.post":
            payload = json.loads(body.decode("utf-8"))
            problem = adf_problem(payload.get("body"))
            if problem:
                return 400, {"errorMessages": [f"INVALID_INPUT: {problem}"]}
            body = payload["body"]
            if mode == "mutate":         # 저장 쪽이 본문을 바꾼다(회로 차단기)
                body = CJ.build_adf(CJ.flatten(body).replace("확인했습니다", "확인했음"))
            self.next_comment += 1
            now = self.now()
            c = {"id": str(self.next_comment), "author": self.me, "body": body, "created": now,
                 "updated": self.now() if mode == "edited" else now}
            self.comments[k].append(c)
            if issue["bump"]:
                issue["updated"] = c["updated"]
            if mode == "store-and-foreign":   # 게시 직후 다른 사람이 댓글을 단다
                self.add_comment(k, "다른 사람의 새 댓글", author=OTHER)
            return 201, {"id": c["id"], "created": now, "updated": now, "author": {"accountId": ME},
                         "body": c["body"], "self": f"{self.base}/rest/api/3/issue/{issue['id']}/comment/{c['id']}"}
        if route == "transitions":
            return 200, {"expand": "transitions", "transitions": [dict(t) for t in self.transitions[k]]}
        if route == "transition.post":
            tid = json.loads(body.decode("utf-8"))["transition"]["id"]
            match = [t for t in self.transitions[k] if t["id"] == tid]
            if not match:
                return 400, {"errorMessages": [f"Transition id '{tid}' is not valid for this issue."]}
            issue["status"] = {"id": match[0]["to"]["id"], "name": match[0]["to"]["name"]}
            issue["updated"] = self.now()
            self.histories[k].append({"id": str(30000 + len(self.histories[k])), "author": {"accountId": ME},
                                      "created": issue["updated"], "items": [{"field": "status", "fieldId": "status"}]})
            return 204, None
        if route == "changelog":
            start, size = int(q.get("startAt", 0)), min(int(q.get("maxResults", 50)), self.page)
            hist = self.histories[k]
            vals = hist[start:start + size]
            d = {"startAt": start, "maxResults": size, "total": len(hist), "isLast": start + len(vals) >= len(hist),
                 "values": vals}
            if mode == "no-islast":
                del d["isLast"]
            if mode == "empty-notlast":
                d["values"], d["isLast"] = [], False
            if mode == "drift-down":     # 첫 페이지만 total이 하나 많다 — 마지막 페이지만 보면 맞아 보인다
                d["total"] = len(hist) + (1 if start == 0 else 0)
            return 200, d
        return 404, {"errorMessages": ["no route"]}

    def _search(self, q, mode):
        token = q.get("nextPageToken")
        if mode == "loop":
            return 200, {"issues": [], "isLast": False, "nextPageToken": "loop"}
        offset = int(token[1:]) if token else 0
        chunk = self.search_issues[offset:offset + self.page]
        fields = q.get("fields", "").split(",")
        issues = [{"id": i["id"], "key": i["key"], "self": f"{self.base}/rest/api/3/issue/{i['id']}",
                   "fields": {f: i.get(f) for f in fields if f in i}} for i in chunk]
        last = offset + self.page >= len(self.search_issues)
        d = {"issues": issues, "isLast": last}
        if not last and mode != "no-token":
            d["nextPageToken"] = f"p{offset + self.page}"
        if mode == "no-token":
            d["isLast"] = False
        if mode == "no-islast":
            del d["isLast"]
        if mode == "null-islast":
            d["isLast"] = None
        if mode == "str-islast":
            d["isLast"] = "true" if last else "false"
        return 200, d


# --- CLI 실행 -------------------------------------------------------------------------------
def run_cli(base, *args, stdin=b"", env=None, site=SITE):
    """CLI 한 번. 반환 (rc, JSON 또는 None, stderr). 노출·형식 위반은 AssertionError."""
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp"),
         "CHORE_JIRA_BASE": base, "JIRA_EMAIL": EMAIL, "JIRA_API_TOKEN": TOKEN, "CHORE_JIRA_TIMEOUT": "5",
         "CHORE_JIRA_RETRY_SLEEP": "0"}
    for k, v in (env or {}).items():
        if v is None:
            e.pop(k, None)
        else:
            e[k] = v
    cmd = [sys.executable, "-I", SCRIPT] + (["--site", site] if site else []) + list(args)
    p = subprocess.run(cmd, input=stdin, capture_output=True, env=e, timeout=60)
    out, err = p.stdout.decode("utf-8"), p.stderr.decode("utf-8")
    for bad in (TOKEN, PAIR, "http"):
        if bad in err:
            raise AssertionError(f"stderr에 {bad!r} 노출: {err!r}")
    if err.count("\n") > 1 or (err and not err.endswith("\n")):
        raise AssertionError(f"stderr가 한 줄이 아님: {err!r}")
    data = None
    if p.returncode == 0:
        if err:
            raise AssertionError(f"성공인데 stderr: {err!r}")
        if not out.endswith("\n") or out.count("\n") != 1:
            raise AssertionError(f"stdout이 JSON 한 줄이 아님: {out!r}")
        data = json.loads(out)
    elif out:
        raise AssertionError(f"실패(rc {p.returncode})인데 stdout: {out!r}")
    return p.returncode, data, err


def eq(got, want, what):
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")


CASES = []


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn
    return deco


# --- 읽기 성공 ------------------------------------------------------------------------------
@case("myself → {account}")
def _(f):
    rc, d, _ = run_cli(f.base, "myself")
    eq((rc, d), (0, {"account": ME}), "myself")


@case("view → 7 keys, updated exact, assignee accountId / null")
def _(f):
    f.add_issue("PROJ-1", status={"id": "10003", "name": "진행 중"})
    f.add_issue("PROJ-2", assignee=None)
    rc, d, _ = run_cli(f.base, "view", "PROJ-1")
    eq(rc, 0, "rc")
    eq(d, {"id": f.issues["PROJ-1"]["id"], "key": "PROJ-1", "project": "PROJ", "status_id": "10003",
           "status_name": "진행 중", "updated": U0, "assignee": ME}, "view")
    rc, d, _ = run_cli(f.base, "view", "PROJ-2")
    eq((rc, d["assignee"]), (0, None), "unassigned")
    eq(f.calls("GET", "view")[0].get("fields"), CJ.VIEW_FIELDS, "fields param")


@case("view of a moved issue reports the live key")
def _(f):
    f.add_issue("PROJ-9")
    f.aliases["OLD-1"] = "PROJ-9"
    rc, d, _ = run_cli(f.base, "view", "OLD-1")
    eq((rc, d["key"], d["project"]), (0, "PROJ-9", "PROJ"), "moved")


@case("transitions → [{id,to_id,to_name}]")
def _(f):
    f.add_issue("PROJ-1")
    f.transitions["PROJ-1"] = [{"id": "31", "name": "QA로", "to": {"id": "10004", "name": "QA (staging)"}},
                              {"id": "41", "name": "닫기", "to": {"id": "10191", "name": "Closed"}}]
    rc, d, _ = run_cli(f.base, "transitions", "PROJ-1")
    eq((rc, d), (0, [{"id": "31", "to_id": "10004", "to_name": "QA (staging)"},
                     {"id": "41", "to_id": "10191", "to_name": "Closed"}]), "transitions")


@case("comments: 5 comments over 3 pages (server caps page at 2), startAt counts received")
def _(f):
    f.add_issue("PROJ-1")
    texts = [TEXT_QA, "둘째", TEXT_EDGES, "넷째 — #4", TEXT_MISC]
    made = [f.add_comment("PROJ-1", t, author=ME if i % 2 == 0 else OTHER) for i, t in enumerate(texts)]
    made[3]["updated"] = jts(T0 + timedelta(hours=1))
    rc, d, _ = run_cli(f.base, "comments", "PROJ-1")
    eq(rc, 0, "rc")
    eq([c["id"] for c in d], [c["id"] for c in made], "ids")
    eq([c["text"] for c in d], texts, "texts")
    eq([c["author"] for c in d], [ME, OTHER, ME, OTHER, ME], "authors")
    eq(d[3]["updated"], made[3]["updated"], "updated kept")
    eq([q["startAt"] for q in f.calls("GET", "comments")], ["0", "2", "4"], "startAt sequence")


@case("comments: total says 6, server has 5 → exit 6")
def _(f):
    f.add_issue("PROJ-1")
    for i in range(5):
        f.add_comment("PROJ-1", f"c{i}")
    f.total_delta["PROJ-1"] = 1
    rc, d, err = run_cli(f.base, "comments", "PROJ-1")
    eq(rc, 6, "rc")
    if "불완전" not in err:
        raise AssertionError(err)


@case("comments: total changes between pages → exit 6")
def _(f):
    f.add_issue("PROJ-1")
    for i in range(3):
        f.add_comment("PROJ-1", f"c{i}")
    f.modes["comments"] = "drift"
    eq(run_cli(f.base, "comments", "PROJ-1")[0], 6, "rc")


@case("comments: no comments → []")
def _(f):
    f.add_issue("PROJ-1")
    eq(run_cli(f.base, "comments", "PROJ-1")[:2], (0, []), "empty")


@case("changelog: 2 pages to isLast, since compared as instants (+0900 / Z / +1200)")
def _(f):
    f.add_issue("PROJ-1")
    h = lambda i, created, *fields: {"id": str(i), "author": {"accountId": OTHER}, "created": created,
                                     "items": [{"field": x, "fieldtype": "jira"} for x in fields]}
    f.histories["PROJ-1"] = [
        h(1, "2026-10-18T21:00:00.000Z", "status"),         # == since → 제외 (strict >)
        h(2, "2026-10-18T22:00:00.000Z", "assignee", "labels"),  # 문자열로는 since보다 작지만 시각은 뒤 → 포함
        h(3, "2026-10-19T08:00:00.000+1200", "summary"),    # 문자열로는 뒤지만 시각은 20:00Z → 제외
        h(4, "2026-10-19T06:00:00.001+0900", "Comment"),    # 1ms 뒤 → 포함
    ]
    rc, d, _ = run_cli(f.base, "changelog", "PROJ-1", "--since", "2026-10-19T06:00:00.000+0900")
    eq(rc, 0, "rc")
    eq(d, [{"created": "2026-10-18T22:00:00.000Z", "author": OTHER, "field": "assignee"},
           {"created": "2026-10-18T22:00:00.000Z", "author": OTHER, "field": "labels"},
           {"created": "2026-10-19T06:00:00.001+0900", "author": OTHER, "field": "Comment"}], "filtered")
    eq([q["startAt"] for q in f.calls("GET", "changelog")], ["0", "2"], "pages")
    rc, d, _ = run_cli(f.base, "changelog", "PROJ-1")
    eq((rc, len(d)), (0, 5), "no --since = every item")


@case("changelog: page without isLast → 6; empty page with isLast=false → 6")
def _(f):
    f.add_issue("PROJ-1")
    f.histories["PROJ-1"] = [{"id": "1", "author": None, "created": U0, "items": [{"field": "status"}]}]
    f.modes["changelog"] = "no-islast"
    eq(run_cli(f.base, "changelog", "PROJ-1")[0], 6, "no isLast")
    f.modes["changelog"] = "empty-notlast"
    eq(run_cli(f.base, "changelog", "PROJ-1")[0], 6, "empty not last")


@case("search: 5 issues over 3 pages via nextPageToken, --fields passed through")
def _(f):
    f.search_issues = [{"id": str(500 + i), "key": f"PROJ-{i}", "summary": f"s{i}", "status": {"name": "To Do"}}
                       for i in range(1, 6)]
    rc, d, _ = run_cli(f.base, "search", "--jql", "project = PROJ AND assignee = currentUser()",
                       "--fields", "summary,status")
    eq(rc, 0, "rc")
    eq([i["key"] for i in d], [f"PROJ-{i}" for i in range(1, 6)], "keys")
    eq(d[0], {"key": "PROJ-1", "id": "501", "fields": {"summary": "s1", "status": {"name": "To Do"}}}, "row")
    calls = f.calls("GET", "search")
    eq([q.get("nextPageToken") for q in calls], [None, "p2", "p4"], "tokens")
    eq({q["fields"] for q in calls}, {"summary,status"}, "fields")
    eq(calls[0]["jql"], "project = PROJ AND assignee = currentUser()", "jql")
    run_cli(f.base, "search", "--jql", "project = PROJ")
    eq(f.calls("GET", "search")[-1]["fields"], CJ.SEARCH_FIELDS, "default fields")


@case("search: repeated nextPageToken → 6; isLast=false without token → 6")
def _(f):
    f.search_issues = [{"id": str(500 + i), "key": f"PROJ-{i}"} for i in range(1, 6)]
    f.modes["search"] = "loop"
    eq(run_cli(f.base, "search", "--jql", "x")[0], 6, "loop")
    f.modes["search"] = "no-token"
    eq(run_cli(f.base, "search", "--jql", "x")[0], 6, "no token")


@case("evidence → fields + flattened description + links both directions")
def _(f):
    desc = {"type": "doc", "version": 1, "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "로그인 오류"}, {"type": "hardBreak"},
                                          {"type": "text", "text": "재현: "},
                                          {"type": "inlineCard", "attrs": {"url": "https://x.example/1"}}]},
        {"type": "bulletList", "content": [
            {"type": "listItem", "content": [{"type": "paragraph", "content": [
                {"type": "mention", "attrs": {"id": OTHER, "text": "@누구"}}, {"type": "text", "text": " 확인"}]}]}]}]}
    links = [{"type": {"name": "Duplicate", "inward": "is duplicated by", "outward": "duplicates"},
              "outwardIssue": {"key": "PROJ-2", "fields": {"status": {"name": "Closed"}}}},
             {"type": {"name": "Relates"}, "inwardIssue": {"key": "PROJ-3", "fields": {"status": {"name": "QA (staging)"}}}}]
    f.add_issue("PROJ-1", description=desc, labels=["staging", "보안"], issuelinks=links, assignee=None)
    rc, d, _ = run_cli(f.base, "evidence", "PROJ-1")
    eq(rc, 0, "rc")
    eq(d, {"key": "PROJ-1", "id": f.issues["PROJ-1"]["id"], "summary": "PROJ-1 요약",
           "description_text": "로그인 오류\n재현: https://x.example/1\n@누구 확인", "creator": OTHER,
           "created": "2026-10-01T10:00:00.000+0900", "updated": U0, "status_id": "10003", "status_name": "In Progress",
           "assignee": None, "labels": ["staging", "보안"],
           "issuelinks": [{"type": "Duplicate", "direction": "outward", "key": "PROJ-2", "status_name": "Closed"},
                          {"type": "Relates", "direction": "inward", "key": "PROJ-3", "status_name": "QA (staging)"}]},
       "evidence")
    eq(f.calls("GET", "view")[0]["fields"], CJ.EVIDENCE_FIELDS, "one GET with the evidence fields")
    eq(len(f.log), 1, "request count")


# --- 쓰기 성공 · ADF ----------------------------------------------------------------------------
@case("ADF: flatten(build_adf(t)) == t; no marks, no empty text node")
def _(f):
    for t in (TEXT_QA, TEXT_CLOSED, TEXT_EDGES, TEXT_MISC, "한 줄", "a", "\n", "끝\n\n"):
        doc = CJ.build_adf(t)
        eq(CJ.flatten(doc), t, f"round trip {t[:12]!r}")
        eq(CJ.flatten(json.loads(json.dumps(doc, ensure_ascii=False))), t, "after JSON")
        if t.strip():
            eq(adf_problem(doc), None, "Jira ADF constraints")
    eq(len(CJ.build_adf(TEXT_EDGES)["content"]), 7, "one paragraph per line incl. empty")


@case("comment → {id,created}; stored ADF == build_adf; comments returns the same bytes")
def _(f):
    f.add_issue("PROJ-1")
    for text in (TEXT_QA, TEXT_CLOSED, TEXT_EDGES):
        rc, d, _ = run_cli(f.base, "comment", "PROJ-1", stdin=text.encode("utf-8"))
        eq(rc, 0, "rc")
        eq(set(d), {"id", "created"}, "keys")
        eq(f.comments["PROJ-1"][-1]["body"], CJ.build_adf(text), "stored body")
        eq(d["id"], f.comments["PROJ-1"][-1]["id"], "id")
    rc, d, _ = run_cli(f.base, "comments", "PROJ-1")
    eq([c["text"] for c in d], [TEXT_QA, TEXT_CLOSED, TEXT_EDGES], "round trip through Jira")


@case("comment that bumps updated: view.updated == comment.created")
def _(f):
    f.add_issue("PROJ-1", bump=True)
    rc, d, _ = run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())
    eq(rc, 0, "rc")
    rc, v, _ = run_cli(f.base, "view", "PROJ-1")
    eq((rc, v["updated"]), (0, d["created"]), "updated moved")
    if v["updated"] == U0:
        raise AssertionError("updated unchanged")


@case("comment that leaves updated: view.updated unchanged, comment still listed")
def _(f):
    f.add_issue("PROJ-1", bump=False)
    rc, d, _ = run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())
    eq(rc, 0, "rc")
    rc, v, _ = run_cli(f.base, "view", "PROJ-1")
    eq((rc, v["updated"]), (0, U0), "updated kept")
    rc, cs, _ = run_cli(f.base, "comments", "PROJ-1")
    eq([(c["id"], c["text"], c["author"]) for c in cs], [(d["id"], TEXT_QA, ME)], "comment listed")
    if not CJ.parse_ts(cs[0]["created"]) > CJ.parse_ts(U0):
        raise AssertionError("comment created not after updated")


@case("transition → {}; view shows target status")
def _(f):
    f.add_issue("PROJ-1")
    f.transitions["PROJ-1"] = [{"id": "31", "name": "QA로", "to": {"id": "10004", "name": "QA (staging)"}}]
    rc, d, _ = run_cli(f.base, "transition", "PROJ-1", "31")
    eq((rc, d), (0, {}), "transition")
    rc, v, _ = run_cli(f.base, "view", "PROJ-1")
    eq((v["status_id"], v["status_name"]), ("10004", "QA (staging)"), "status")
    eq(len(f.calls("POST", "transition.post")), 1, "one POST")


# --- 쓰기 실패 분류 ---------------------------------------------------------------------------
@case("comment applied-then-500 → 4; comment is on the ticket")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "store-then-500"
    rc, _, err = run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())
    eq(rc, 4, "rc")
    if "미확정" not in err:
        raise AssertionError(err)
    f.modes.clear()
    rc, cs, _ = run_cli(f.base, "comments", "PROJ-1")
    eq([c["text"] for c in cs], [TEXT_QA], "stored")


@case("comment response lost (server reads request, stores, closes socket) → 4")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "store-then-drop"
    eq(run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())[0], 4, "rc")
    eq(len(f.comments["PROJ-1"]), 1, "stored")


@case("comment response lost without storing → 4 (unknown, never 3)")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "drop"
    eq(run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())[0], 4, "rc")
    eq(len(f.comments["PROJ-1"]), 0, "not stored")


@case("comment timeout after the server stored it → 4")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "store-then-sleep"
    t = time.monotonic()
    rc, _, err = run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode(), env={"CHORE_JIRA_TIMEOUT": "0.4"})
    eq(rc, 4, "rc")
    if "시간 초과" not in err or time.monotonic() - t > 5:
        raise AssertionError(err)


@case("comment rejected 400 (body echoes token + URL) → 3, nothing stored, detail scrubbed ≤ 200")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "400"
    rc, _, err = run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())
    eq(rc, 3, "rc")
    eq(len(f.comments["PROJ-1"]), 0, "not stored")
    if "HTTP 400" not in err or "rejected token" not in err or len(err) > 320:
        raise AssertionError(err)


@case("comment 302 → 4, redirect not followed")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "302"
    eq(run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())[0], 4, "rc")
    eq(f.redirect_hits, 0, "redirect target hit")


@case("comment 2xx with non-JSON body → 4")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "bad-json"
    eq(run_cli(f.base, "comment", "PROJ-1", stdin=TEXT_QA.encode())[0], 4, "rc")


@case("transition 400 → 3, status unchanged; transition 500 → 4; 403 → 5")
def _(f):
    f.add_issue("PROJ-1")
    f.transitions["PROJ-1"] = [{"id": "31", "name": "QA로", "to": {"id": "10004", "name": "QA (staging)"}}]
    rc, _, err = run_cli(f.base, "transition", "PROJ-1", "99")
    eq(rc, 3, "invalid id")
    eq(f.issues["PROJ-1"]["status"]["id"], "10003", "status unchanged")
    f.modes["transition.post"] = "500"
    eq(run_cli(f.base, "transition", "PROJ-1", "31")[0], 4, "500")
    f.modes["transition.post"] = "drop"
    eq(run_cli(f.base, "transition", "PROJ-1", "31")[0], 4, "lost")
    f.modes["transition.post"] = "403"
    eq(run_cli(f.base, "transition", "PROJ-1", "31")[0], 5, "403")
    eq(f.issues["PROJ-1"]["status"]["id"], "10003", "status unchanged")


@case("write to a closed port → 4; read → 6")
def _(f):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    dead = f"http://127.0.0.1:{port}"
    eq(run_cli(dead, "comment", "PROJ-1", stdin=b"x")[0], 4, "write")
    eq(run_cli(dead, "transition", "PROJ-1", "31")[0], 4, "transition")
    eq(run_cli(dead, "view", "PROJ-1")[0], 6, "read")


# --- 인증 · 읽기 실패 -----------------------------------------------------------------------------
@case("401 on a read → 5 with the fixed text; no token, no URL")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["view"] = "401"
    rc, _, err = run_cli(f.base, "view", "PROJ-1")
    eq((rc, err), (5, CJ.AUTH_MSG + "\n"), "auth")
    if "test-token-xyz" in err or "http" in err:
        raise AssertionError(err)


@case("wrong token → 5 on read and on write; missing token under CHORE_JIRA_BASE → 5 with no request")
def _(f):
    f.add_issue("PROJ-1")
    eq(run_cli(f.base, "myself", env={"JIRA_API_TOKEN": "wrong-token"})[:3:2], (5, CJ.AUTH_MSG + "\n"), "read")
    eq(run_cli(f.base, "comment", "PROJ-1", stdin=b"x", env={"JIRA_API_TOKEN": "wrong-token"})[0], 5, "write")
    eq(len(f.comments["PROJ-1"]), 0, "not stored")
    n = len(f.log)
    eq(run_cli(f.base, "myself", env={"JIRA_API_TOKEN": None})[0], 5, "no token")
    eq(len(f.log), n, "no request sent")


@case("read 500 → 6 on every read command")
def _(f):
    f.add_issue("PROJ-1")
    for route, args in (("myself", ["myself"]), ("view", ["view", "PROJ-1"]), ("view", ["evidence", "PROJ-1"]),
                        ("transitions", ["transitions", "PROJ-1"]), ("comments", ["comments", "PROJ-1"]),
                        ("changelog", ["changelog", "PROJ-1"]), ("search", ["search", "--jql", "x"])):
        f.modes = {route: "500"}
        eq(run_cli(f.base, *args)[0], 6, " ".join(args))


@case("read bad JSON / 302 / dropped connection / 404 → 6")
def _(f):
    f.add_issue("PROJ-1")
    for mode in ("bad-json", "302", "drop"):
        f.modes = {"view": mode}
        eq(run_cli(f.base, "view", "PROJ-1")[0], 6, mode)
    eq(f.redirect_hits, 0, "redirect target hit")
    f.modes = {}
    eq(run_cli(f.base, "view", "PROJ-404")[0], 6, "404")


@case("usage errors → 2, one line, no request")
def _(f):
    f.add_issue("PROJ-1")
    for args, stdin, site in ((["view", "proj-1"], b"", SITE), (["view", "../x"], b"", SITE), (["view"], b"", SITE),
                              (["myself"], b"", None), (["myself"], b"", "bad host/x"), (["nope"], b"", SITE),
                              (["comment", "PROJ-1"], b"", SITE), (["comment", "PROJ-1"], b" \n \n", SITE),
                              (["comment", "PROJ-1"], "줄\r\n끝".encode(), SITE), (["comment", "PROJ-1"], b"\xff\xfe", SITE),
                              (["transition", "PROJ-1", "3a"], b"", SITE),
                              (["changelog", "PROJ-1", "--since", "2026-10-19 06:00"], b"", SITE),
                              (["search"], b"", SITE), (["search", "--jql", "x", "--fields", "a b"], b"", SITE)):
        rc, _, err = run_cli(f.base, *args, stdin=stdin, site=site)
        eq(rc, 2, f"{args} rc")
        if not err.startswith("chore-jira: ") or "사용법 오류" not in err:
            raise AssertionError(err)
    eq(f.log, [], "requests")


# --- 모듈 API (part (b)가 쓰는 것) ---------------------------------------------------------------
@case("module API: functions return objects, raise JiraError(code, status)")
def _(f):
    f.add_issue("PROJ-1")
    c = CJ.Client(f.base, EMAIL, TOKEN, 5)
    eq(CJ.myself(c), {"account": ME}, "myself")
    eq(CJ.view(c, "PROJ-1")["updated"], U0, "view")
    got = CJ.comment(c, "PROJ-1", TEXT_QA)
    eq(CJ.comments(c, "PROJ-1")[0]["id"], got["id"], "comment then comments")
    for route, mode, fn, code, status in (("view", "500", lambda: CJ.view(c, "PROJ-1"), 6, 500),
                                          ("comment.post", "400", lambda: CJ.comment(c, "PROJ-1", "x"), 3, 400),
                                          ("comment.post", "store-then-500", lambda: CJ.comment(c, "PROJ-1", "x"), 4, 500),
                                          ("transition.post", "drop", lambda: CJ.transition(c, "PROJ-1", "31"), 4, None),
                                          ("view", "401", lambda: CJ.view(c, "PROJ-1"), 5, 401)):
        f.modes = {route: mode}
        try:
            fn()
            raise AssertionError(f"{route} {mode}: no error")
        except CJ.JiraError as e:
            eq((e.code, e.status), (code, status), f"{route} {mode}")
            for bad in (TOKEN, PAIR, "http"):
                if bad in CJ.scrub(e.message):
                    raise AssertionError(e.message)
    eq(CJ.parse_ts("2026-10-19T06:07:25.160+0900"), CJ.parse_ts("2026-10-18T21:07:25.160Z"), "parse_ts offsets")
    for bad in ("2026-10-19", "2026-10-19T06:07:25+2500", "2026-13-01T00:00:00Z", 5):
        try:
            CJ.parse_ts(bad)
            raise AssertionError(f"parse_ts accepted {bad!r}")
        except ValueError:
            pass


# ======================== part (b): binding · apply-rows · verify-rows (design-jira.md §2–§6) ========================
P = CJ.plan_mod()
ROOT = JUDGE = PARENT = None   # root()가 처음 쓸 때 만든다 — 이 모듈을 import만 하는 다른 테스트(chore-evidence)가 임시 폴더를 남기지 않게
VALID = os.path.join(HERE, "..", "fixtures", "chore-v4", "valid.tsv")
RUN_ID = "20261018T213000Z-0a1b2c3d"
PLAN_CREATED = "2026-10-18T21:30:00Z"   # = 2026-10-19 06:30 +0900: expected(06:07 +0900)보다 뒤, 가짜 시각(07:00 +0900~)보다 앞
FROM, QA = "20001", "20004"
REPOS_MD = ("# 저장소\n\n| repo | local path | remote (owner/repo) | note |\n|---|---|---|---|\n"
            "| `other` | `~/o` | `test/other` | 다른 저장소 jira=example.atlassian.net/OTH |\n"
            "| `test` | `~/t` | `Test/Repo` | 테스트 저장소. 배포 `deploy/staging`. jira=example.atlassian.net/TST jira-qa=20004 "
            "jira-closed=20191 (jira-hold=10370,10258) `deploy-proof=deploy-staging.yml@deploy/staging` |\n")
JUDGE_SRC = r'''
import json, os, re, sys
lines = sys.stdin.buffer.read().split(b"\n")
ok = len(lines) == 3 and lines[2] == b"" and lines[0].startswith(b"#chore-plan v3\t") and b"\tjira-transition\t" in lines[1]
m = re.search(rb"\tjira#([A-Z][A-Z0-9]+-[0-9]+)\t", lines[1] if len(lines) > 1 else b"")
key = m.group(1).decode() if m else "?"
with open(os.environ["FAKE_JUDGE_LOG"], "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "key": key, "stdin_ok": ok}) + "\n")
import time
time.sleep(float(os.environ.get("FAKE_JUDGE_SLEEP", "0")))
rules = dict(x.split("=", 1) for x in os.environ.get("FAKE_JUDGE_RULES", "").split(",") if x)
code = int(rules.get(key, "0")) if ok else 2
if code == 10:
    print("staging 배포에서 PR #12가 빠짐")
elif code:
    print("judge failed", file=sys.stderr)
sys.exit(code)
'''
PARENT_SRC = r'''
import os, subprocess, sys, time
cmd = [str(os.getpid()) if a == "@PARENT@" else a for a in sys.argv[1:]]
with open(os.environ["HELPER_OUT"], "wb") as o, open(os.environ["HELPER_ERR"], "wb") as e:
    p = subprocess.Popen(cmd, stdout=o, stderr=e)
print(p.pid, flush=True)
time.sleep(120)
'''


def root():
    global ROOT, JUDGE, PARENT
    if ROOT is None:
        ROOT = tempfile.mkdtemp(prefix="chore-jira-test.")
        JUDGE, PARENT = os.path.join(ROOT, "fake-judge.py"), os.path.join(ROOT, "fake-parent.py")
        for path, src in ((JUDGE, JUDGE_SRC), (PARENT, PARENT_SRC)):
            with open(path, "w") as fh:
                fh.write(src)
    return ROOT


def qa_text(key):
    return (f"저장소 정리 중 확인했습니다. {key}의 변경(PR #12(develop에 합쳐짐))은 staging 배포 "
            "https://github.com/test/repo/actions/runs/9000000001(2026-10-19 06:00)에 포함되어 있습니다. "
            "그래서 QA (staging)로 옮깁니다.\nchore 정리 → QA (staging) — by Claude triage 2026-10-19")


def plan_bytes(keys, snap_over=None):
    hdr = open(VALID, "rb").read().split(b"\n")[0]
    hdr = re.sub(rb"\tcreated=[^\t]*", b"\tcreated=" + P.penc(PLAN_CREATED, sp=True), hdr)
    hdr = re.sub(rb"\trun_id=[^\t]*", b"\trun_id=" + RUN_ID.encode(), hdr)
    out = [hdr]
    for i, key in enumerate(keys):
        snap = {"site": "example.atlassian.net", "project": "TST", "issue_id": str(10101 + i), "status": FROM,
                "status_name": "개발 완료", "assignee": ME, "account": ME, "to": "31", "to_status": QA,
                "to_name": "QA (staging)", "summary": f"{key} 요약", "level": "TO-QA", "S": "b" * 40,
                "run": "9000000001", "run_url": "https://github.com/test/repo/actions/runs/9000000001",
                "items": "pr:12:MERGED:required:" + "2" * 40,
                "reqs": P.encode_reqs([{"text": "로그인 검증", "target": "pr:12"}]), "close_basis": "-",
                "ledgers": "-"}
        snap.update((snap_over or {}).get(key, {}))
        out.append(b"\t".join([b"2", b"jira-transition", ("jira#" + key).encode(), U0.encode(),
                               P.encode_snapshot(snap), P.penc(qa_text(key))]))
    out.append(b"\t".join([b"3", b"report", b"jira#TST", b"-", b"-",
                           P.encode_inventory_evidence(len(keys), "project = TST", "example.atlassian.net")]))
    return b"\n".join(out) + b"\n"


def hygiene(out, err):
    for bad in (TOKEN, PAIR):
        if bad in out or bad in err:
            raise AssertionError(f"출력에 {bad!r} 노출")
    if "http" in err:
        raise AssertionError(f"stderr에 http: {err!r}")


def jl(att, key, event, cid=None):
    return f"2026-10-19T00:00:00.000Z {att} jira#{key} {event}" + (f" {cid}" if cid else "")


class Scn:
    """한 사례의 계획·repos.md·일지·락·결과 파일. apply/verify는 실제 CLI를 subprocess로 부른다.
    결과 파일 = apply 출력 + chore.sh가 붙일 SUMMARY / (중단이면) 남은 행의 UNKNOWN·NOT-ATTEMPTED + ABORTED."""

    def __init__(self, f, keys=("TST-1",), snap_over=None):
        self.f, self.keys = f, list(keys)
        self.dir = tempfile.mkdtemp(prefix="scn.", dir=root())
        self.md, self.plan = os.path.join(self.dir, "repos.md"), os.path.join(self.dir, "plan.tsv")
        with open(self.md, "w", encoding="utf-8") as fh:
            fh.write(REPOS_MD)
        with open(self.plan, "wb") as fh:
            fh.write(plan_bytes(self.keys, snap_over))
        self.journal = os.path.join(self.dir, "chore", RUN_ID + ".journal")
        self.lock = os.path.join(self.dir, "chore", RUN_ID + ".lock")
        self.results, self.judge_log = os.path.join(self.dir, "results.txt"), os.path.join(self.dir, "judge.log")
        open(self.results, "w").close()
        self.n = 0
        self.text = {r["jira"]["key"]: r["evidence"] for r in P.parse_plan(open(self.plan, "rb").read())[1]
                     if r["action"] == "jira-transition"}
        for i, key in enumerate(self.keys):
            f.add_issue(key, id=str(10101 + i), status={"id": FROM, "name": "개발 완료"})
            f.transitions[key] = [{"id": "31", "name": "QA로", "to": {"id": QA, "name": "QA (staging)"}}]

    def env(self, extra=None):
        e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.path.join(root(), "home"),
             "CHORE_JIRA_BASE": self.f.base, "JIRA_EMAIL": EMAIL, "JIRA_API_TOKEN": TOKEN, "CHORE_JIRA_TIMEOUT": "5",
             "CHORE_JIRA_RETRY_SLEEP": "0", "FAKE_JUDGE_LOG": self.judge_log}
        e.update(extra or {})
        return e

    def next_attempt(self):
        self.n += 1
        return f"20261019T{self.n:06d}Z-{self.n:08x}"

    def cmd(self, att, parent):
        return [sys.executable, "-I", SCRIPT, "apply-rows", "--plan", self.plan, "--attempt", att, "--journal",
                self.journal, "--lock", self.lock, "--parent-pid", str(parent), "--repos-md", self.md, "--remote",
                "test/repo", "--clone", self.dir, "--judge", JUDGE]

    def apply(self, env=None):
        att = self.next_attempt()
        p = subprocess.run(self.cmd(att, os.getpid()), capture_output=True, env=self.env(env), timeout=90)
        return self.finish(att, p.returncode, p.stdout.decode("utf-8"), p.stderr.decode("utf-8"))

    def finish(self, att, rc, out, err):
        hygiene(out, err)
        lines = [x for x in out.split("\n") if x]
        got = {}
        for x in lines:
            c = x.split("\t")
            if len(c) != 6 or c[0] != "RESULT" or c[2] != "jira-transition" or c[5] != "attempt=" + att:
                raise AssertionError(f"RESULT 줄 형식: {x!r}")
            got[c[3][len("jira#"):]] = (c[1], c[4])
        self.record(att, lines, rc)
        return rc, got, err

    def record(self, att, lines, rc):
        add = list(lines)
        if rc == 0:
            add.append(f"SUMMARY\tok=0\tskip=0\tfail=0\tunknown=0\trun_id={RUN_ID}\tscope=full\tattempt={att}\tjournal={self.journal}")
        else:   # chore.sh 중단 규칙(jira_journaled, chore.sh 76–91)을 그대로: 이 시도의 줄 중 *-withdrawn이 짝인
            # *-sent를 지우고 나머지 줄을 센다 — 0보다 크면 UNKNOWN, 0이면 NOT-ATTEMPTED
            done = {x.split("\t")[3] for x in lines}
            pend, net = {}, {}
            for x in (y.split(" ") for y in self.jlines()):
                if x[1] != att:
                    continue
                r, e = x[2], x[3]
                k = e.rsplit("-", 1)[0]
                if e.endswith("-withdrawn") and pend.get((r, k), 0) > 0:
                    pend[(r, k)] -= 1
                    net[r] = net.get(r, 0) - 1
                    continue
                if e.endswith("-sent"):
                    pend[(r, k)] = pend.get((r, k), 0) + 1
                elif (e.endswith("-ok") or e.endswith("-rejected")) and pend.get((r, k), 0) > 0:
                    pend[(r, k)] -= 1
                net[r] = net.get(r, 0) + 1
            for key in self.keys:
                ref = "jira#" + key
                if ref in done:
                    continue
                if net.get(ref, 0) > 0:
                    add.append(f"RESULT\tUNKNOWN\tjira-transition\t{ref}\tsent at jira, outcome unread\tattempt={att}")
                else:
                    add.append(f"RESULT\tNOT-ATTEMPTED\tjira-transition\t{ref}\trun aborted at jira\tattempt={att}")
            add.append(f"ABORTED\trun_id={RUN_ID}\tat=jira\tok=0\tskip=0\tfail=0\tunknown=0\tunattempted=0\t"
                       f"scope=full\tattempt={att}\tjournal={self.journal}\treason=helper exit {rc}")
        with open(self.results, "a", encoding="utf-8") as fh:
            fh.write("".join(x + "\n" for x in add))

    def jlines(self):
        try:
            data = open(self.journal, "rb").read().decode("utf-8")
        except FileNotFoundError:
            return []
        return data.split("\n")[:-1] if "\n" in data else []

    def write_journal(self, text):
        os.makedirs(os.path.dirname(self.journal), exist_ok=True)
        with open(self.journal, "wb") as fh:
            fh.write(text.encode("utf-8"))

    def verify(self, results=None, journal=None):
        if results is not None:
            path = os.path.join(self.dir, "results.custom")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(results)
        cmd = [sys.executable, "-I", SCRIPT, "verify-rows", "--plan", self.plan, "--results",
               path if results is not None else self.results, "--journal", journal or self.journal,
               "--repos-md", self.md, "--remote", "test/repo"]
        p = subprocess.run(cmd, capture_output=True, env=self.env(), timeout=90)
        out, err = p.stdout.decode("utf-8"), p.stderr.decode("utf-8")
        hygiene(out, err)
        got, order = {}, []
        for x in (y for y in out.split("\n") if y):
            c = x.split("\t")
            if len(c) != 5 or c[0] != "VERIFY" or c[2] != "jira-transition":
                raise AssertionError(f"VERIFY 줄 형식: {x!r}")
            got[c[3][len("jira#"):]] = (c[1], c[4])
            order.append(c[3][len("jira#"):])
        if p.returncode == 0 and order != self.keys:
            raise AssertionError(f"VERIFY 순서 {order} != 계획 {self.keys}")
        return p.returncode, got, err

    def judge_calls(self):
        try:
            return [json.loads(x) for x in open(self.judge_log, encoding="utf-8")]
        except FileNotFoundError:
            return []


def want(got, key, result, cls_or_text=None):
    if key not in got:
        raise AssertionError(f"{key}: 결과 없음 ({got})")
    r, text = got[key]
    if r != result or (cls_or_text and cls_or_text not in text):
        raise AssertionError(f"{key}: got {got[key]!r}, want {result} … {cls_or_text!r}")


def events(scn, key="TST-1"):
    return [x.split(" ")[3] for x in scn.jlines() if x.split(" ")[2] == "jira#" + key]


def to_qa(f, key="TST-1"):
    f.issues[key]["status"] = {"id": QA, "name": "QA (staging)"}
    f.issues[key]["updated"] = f.now()


def posts(f):
    return len(f.calls("POST", "comment.post")) + len(f.calls("POST", "transition.post"))


# --- binding ---
@case("binding: tokens from the note cell (backticks, parens), remote case-insensitive, CLI JSON")
def _(f):
    path = os.path.join(root(), "b1.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(REPOS_MD)
    eq(CJ.read_binding(path, "test/repo"), {"site": "example.atlassian.net", "project": "TST", "qa": "20004",
                                            "closed": "20191", "hold": ["10370", "10258"],
                                            "proof_workflow": "deploy-staging.yml", "proof_branch": "deploy/staging",
                                            "proof_label": "staging", "other_repos": []}, "full")
    eq(CJ.read_binding(path, "test/other"), {"site": "example.atlassian.net", "project": "OTH", "qa": None,
                                             "closed": None, "hold": None, "proof_workflow": None, "proof_branch": None,
                                             "proof_label": None, "other_repos": []},
       "optional missing")
    eq(CJ.read_binding(path, "test/none"), None, "no row")
    p = subprocess.run([sys.executable, "-I", SCRIPT, "binding", "--repos-md", path, "--remote", "TEST/REPO"],
                       capture_output=True, timeout=30)
    eq((p.returncode, json.loads(p.stdout)["project"], p.stderr), (0, "TST", b""), "cli")
    p = subprocess.run([sys.executable, "-I", SCRIPT, "binding", "--repos-md", path, "--remote", "x/y"],
                       capture_output=True, timeout=30)
    eq((p.returncode, p.stdout), (0, b"null\n"), "cli null")


@case("binding: no jira= → null; duplicate token / bad value / two rows → exit 1")
def _(f):
    def run_b(text):
        path = os.path.join(root(), "b2.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("| a | b | remote | note |\n" + text)
        return subprocess.run([sys.executable, "-I", SCRIPT, "binding", "--repos-md", path, "--remote", "t/r"],
                              capture_output=True, timeout=30)
    p = run_b("| x | y | `t/r` | deploy-proof=a.yml@b jira-qa=1 |\n")
    eq((p.returncode, p.stdout), (0, b"null\n"), "no jira=")
    for text, needle in (("| x | y | t/r | jira=h.example/TS jira=h.example/TS |\n", "두 번"),
                         ("| x | y | t/r | jira=h.example/lower |\n", "<site>/<PROJECT>"),
                         ("| x | y | t/r | jira=h.example/TS jira-qa=abc |\n", "jira-qa="),
                         ("| x | y | t/r | jira=h.example/TS deploy-proof=a.yml |\n", "deploy-proof="),
                         ("| x | y | t/r | jira=h.example/TS |\n| z | w | T/R | x |\n", "행이 2개")):
        p = run_b(text)
        eq(p.returncode, 1, text)
        err = p.stderr.decode()
        if not err.startswith("chore-jira: binding: ") or err.count("\n") != 1 or needle not in err:
            raise AssertionError(f"{text!r}: {err!r}")


@case("binding: deploy-env= → proof_label; else the last /-segment of the deploy-proof branch; no deploy-proof → None")
def _(f):
    def label(note):
        path = os.path.join(root(), "b3.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("| a | b | remote | note |\n| x | y | `t/r` | %s |\n" % note)
        b = CJ.read_binding(path, "t/r")
        return b["proof_label"], b["proof_branch"]
    eq(label("jira=h.example/TS deploy-proof=d.yml@deploy/staging `deploy-env=qa.env_2-B`"),
       ("qa.env_2-B", "deploy/staging"), "deploy-env parsed (backticks), wins over the branch")
    eq(label("deploy-env=Z jira=h.example/TS (deploy-proof=d.yml@deploy/staging)"), ("Z", "deploy/staging"),
       "token order free, one character label")
    eq(label("jira=h.example/TS deploy-env=%s deploy-proof=d.yml@x" % ("a" * 32)), ("a" * 32, "x"), "32 characters")
    eq(label("jira=h.example/TS deploy-proof=d.yml@deploy/staging"), ("staging", "deploy/staging"),
       "no deploy-env → last segment of the proof branch")
    eq(label("jira=h.example/TS deploy-proof=d.yml@release/eu/prod-1"), ("prod-1", "release/eu/prod-1"), "deep branch")
    eq(label("jira=h.example/TS deploy-proof=d.yml@main"), ("main", "main"), "branch without /")
    eq(label("jira=h.example/TS jira-qa=1"), (None, None), "no deploy-proof → None")


@case("binding: duplicate deploy-env= / bad deploy-env value → BindingError, CLI exit 1 with one line")
def _(f):
    path = os.path.join(root(), "b4.md")
    for value_note, needle in (("deploy-env=a deploy-env=a", "두 번"), ("deploy-env=a deploy-env=b", "두 번"),
                               ("deploy-env=-x", "deploy-env="), ("deploy-env=.x", "deploy-env="),
                               ("deploy-env=%s" % ("a" * 33), "deploy-env="), ("deploy-env=a/b", "deploy-env="),
                               ("deploy-env=a:b", "deploy-env="), ("deploy-env=환경", "deploy-env=")):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("| a | b | remote | note |\n| x | y | t/r | jira=h.example/TS deploy-proof=d.yml@deploy/s %s |\n"
                     % value_note)
        try:
            CJ.read_binding(path, "t/r")
        except CJ.BindingError as e:
            if needle not in str(e):
                raise AssertionError(f"{value_note!r}: {e}") from None
        else:
            raise AssertionError(f"{value_note!r}: accepted")
        p = subprocess.run([sys.executable, "-I", SCRIPT, "binding", "--repos-md", path, "--remote", "t/r"],
                           capture_output=True, timeout=30)
        err = p.stderr.decode()
        eq((p.returncode, p.stdout, err.startswith("chore-jira: binding: "), err.count("\n"), needle in err),
           (1, b"", True, 1, True), value_note)


class _Env:
    """credentials()를 이 프로세스에서 부를 때 os.environ을 통째로 바꾸고, 실패해도 되돌린다."""

    def __init__(self, **kv):
        self.kv, self.saved = kv, None

    def __enter__(self):
        self.saved = dict(os.environ)
        for k in ("CHORE_JIRA_BASE", "CHORE_ENV_FILE", "JIRA_EMAIL", "JIRA_API_TOKEN"):
            os.environ.pop(k, None)
        os.environ.update({k: v for k, v in self.kv.items() if v is not None})
        return self

    def __exit__(self, *exc):
        os.environ.clear()
        os.environ.update(self.saved)
        return False


def creds_or_code():
    try:
        return CJ.credentials()
    except CJ.JiraError as e:
        return (e.code, e.message)


@case("credentials: empty env values are read from the file CHORE_ENV_FILE names (KEY=VALUE, quotes, comments)")
def _(f):
    path = os.path.join(root(), "creds.env")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("# 주석\n\nJIRA_EMAIL = file@example.com\nJIRA_API_TOKEN=\"file-token\"\nOTHER=x\n")
    with _Env(CHORE_ENV_FILE=path):
        eq(creds_or_code(), ("file@example.com", "file-token"), "both from the file")
    with _Env(CHORE_ENV_FILE=path, JIRA_EMAIL="env@example.com", JIRA_API_TOKEN=""):
        eq(creds_or_code(), ("env@example.com", "file-token"), "env value wins, empty one from the file")
    with _Env(CHORE_ENV_FILE=path, JIRA_EMAIL="env@example.com", JIRA_API_TOKEN="env-token"):
        eq(creds_or_code(), ("env@example.com", "env-token"), "env complete")
    with _Env(CHORE_ENV_FILE=path, CHORE_JIRA_BASE="http://127.0.0.1:1"):
        eq(creds_or_code(), (5, CJ.AUTH_MSG), "test mode (CHORE_JIRA_BASE) = env only, the file is not read")


@case("credentials: CHORE_ENV_FILE unset → no file is read (no implicit .env), fixed auth text; CLI exit 5 with that text")
def _(f):
    d = os.path.join(root(), "cwd-env")
    os.makedirs(os.path.join(d, "workflow"), exist_ok=True)
    for name in (".env", os.path.join("workflow", ".env")):
        with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
            fh.write("JIRA_EMAIL=cwd@example.com\nJIRA_API_TOKEN=cwd-token\n")
    old = os.getcwd()
    os.chdir(d)
    try:
        with _Env():
            eq(creds_or_code(), (5, CJ.AUTH_MSG), "unset")
        with _Env(CHORE_ENV_FILE=""):
            eq(creds_or_code(), (5, CJ.AUTH_MSG), "empty")
        with _Env(CHORE_ENV_FILE=os.path.join(d, "missing.env")):
            eq(creds_or_code(), (5, CJ.AUTH_MSG), "names a missing file")
    finally:
        os.chdir(old)
    eq(CJ.AUTH_MSG, "chore-jira: Jira 인증 실패 — JIRA_EMAIL/JIRA_API_TOKEN 또는 CHORE_ENV_FILE의 값 확인", "auth text")
    p = subprocess.run([sys.executable, "-I", SCRIPT, "--site", "example.atlassian.net", "myself"], cwd=d,
                       capture_output=True, timeout=60,
                       env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": d})
    eq((p.returncode, p.stdout, p.stderr.decode()), (5, b"", CJ.AUTH_MSG + "\n"), "cli")


# --- apply-rows: steps 1–13 ---
@case("apply 12+13: fresh row → comment then move, OK moved; journal 4 lines; judge got header+row on stdin")
def _(f):
    s = Scn(f)
    rc, got, err = s.apply()
    eq(rc, 0, "rc")
    want(got, "TST-1", "OK", "moved: 개발 완료 → QA (staging)")
    eq(events(s), ["comment-sent", "comment-ok", "transition-sent", "transition-ok"], "journal")
    eq(s.jlines()[1].split(" ")[4], f.comments["TST-1"][0]["id"], "comment id journaled")
    eq(CJ.flatten(f.comments["TST-1"][0]["body"]), s.text["TST-1"], "posted text")
    eq(f.issues["TST-1"]["status"]["id"], QA, "moved")
    calls = s.judge_calls()
    eq(len(calls), 1, "judge calls")
    eq((calls[0]["stdin_ok"], calls[0]["key"]), (True, "TST-1"), "judge stdin")
    eq(calls[0]["argv"], ["recheck", "--clone", s.dir, "--remote", "test/repo", "--repos-md", s.md], "judge argv")
    eq(oct(os.stat(s.journal).st_mode & 0o777), "0o600", "journal mode")


@case("apply 2: issue id differs from snapshot → SKIP identity, no write")
def _(f):
    s = Scn(f)
    f.issues["TST-1"]["id"] = "99999"
    rc, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "identity: ")
    eq((rc, posts(f), s.jlines()), (0, 0, []), "no write")


@case("apply 3: two approved comments → SKIP manual (승인 댓글이 2개)")
def _(f):
    s = Scn(f)
    f.add_comment("TST-1", s.text["TST-1"])
    f.add_comment("TST-1", s.text["TST-1"])
    rc, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "승인 댓글이 2개")
    eq(posts(f), 0, "no write")


@case("apply 3: another chore marker comment by the account (M) → SKIP manual")
def _(f):
    s = Scn(f)
    f.add_comment("TST-1", "예전 정리\nchore 정리 → Closed — by Claude triage 2026-10-01")
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "다른 정리 댓글")
    eq(posts(f), 0, "no write")


@case("apply 3 / verify 2: marker line with trailing spaces · tab · CR is M like an exact marker (collect의 strip 한 벌)")
def _(f):
    tails = {"TST-1": "", "TST-2": "   ", "TST-3": "\t", "TST-4": "\r"}
    s = Scn(f, keys=tuple(tails))
    for key, tail in tails.items():
        f.add_comment(key, "예전 정리\nchore 정리 → Closed — by Claude triage 2026-10-01" + tail)
    rc, got, _ = s.apply()
    eq((rc, posts(f)), (0, 0), "apply exit · no write")
    rc, v, _ = s.verify()
    for key in tails:
        want(got, key, "SKIP", "manual: 정리 댓글이 예상과 다름 — 이 계정의 다른 정리 댓글이 있음")
        want(v, key, "UNRESOLVED", "manual: 정리 댓글이 예상과 다름 — 이 계정의 다른 정리 댓글이 있음")


@case("apply 3: journaled comment later edited (lost) → SKIP manual")
def _(f):
    s = Scn(f)
    c = f.add_comment("TST-1", s.text["TST-1"])
    c["updated"] = f.now()
    s.write_journal(jl("20261019T000000Z-aaaaaaaa", "TST-1", "comment-sent") + "\n"
                    + jl("20261019T000000Z-aaaaaaaa", "TST-1", "comment-ok", c["id"]) + "\n")
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "지금 조건에 안 맞음")
    eq(posts(f), 0, "no write")


@case("apply 3: approved comment with no journal line (orphan) → SKIP manual")
def _(f):
    s = Scn(f)
    f.add_comment("TST-1", s.text["TST-1"])
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "일지에 없는 승인 댓글")
    eq(posts(f), 0, "no write")


@case("apply 4 + verify 4: moved → rerun OK already-done (no write) → cat verify OK 이번 실행이 옮김")
def _(f):
    s = Scn(f)
    eq(s.apply()[0], 0, "first")
    n = posts(f)
    rc, got, _ = s.apply()
    want(got, "TST-1", "OK", "already-done: ")
    eq((rc, posts(f) - n), (0, 0), "no write on rerun")
    rc, v, err = s.verify()
    eq(rc, 0, err)
    want(v, "TST-1", "OK", "이번 실행이 옮김")


@case("apply 5: comment timed out and never stored → rerun SKIP manual 댓글을 보냈지만 지금 안 보임")
def _(f):
    s = Scn(f)
    f.modes["comment.post"] = "sleep-nostore"
    rc, got, _ = s.apply({"CHORE_JIRA_TIMEOUT": "0.4"})
    want(got, "TST-1", "UNKNOWN", "결과 미확정")
    f.modes.clear()
    rc, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "manual: 댓글을 보냈지만 지금 안 보임")
    eq(len(f.calls("POST", "comment.post")), 1, "not re-posted")


@case("apply 6: already at the target status → SKIP at-target")
def _(f):
    s = Scn(f)
    to_qa(f)
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "at-target: ")
    eq(posts(f), 0, "no write")


@case("apply 7: assignee is someone else / running account differs → SKIP assignee")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    f.issues["TST-1"]["assignee"] = OTHER
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "assignee: 담당자가")
    want(got, "TST-2", "OK", "moved")
    s2 = Scn(f, keys=("TST-3",))
    f.me = OTHER
    f.issues["TST-3"]["assignee"] = OTHER
    _, got, _ = s2.apply()
    want(got, "TST-3", "SKIP", "assignee: 실행 계정")


@case("apply 8: status moved / field changed / foreign comment after expected → SKIP changed")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2", "TST-3"))
    f.issues["TST-1"]["status"] = {"id": "20002", "name": "검토"}
    f.histories["TST-2"] = [{"id": "1", "author": {"accountId": OTHER}, "created": "2026-10-19T06:30:00.000+0900",
                             "items": [{"field": "priority"}]}]
    f.add_comment("TST-3", "질문 있습니다", author=OTHER)
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "changed: 계획 뒤에 티켓이 바뀜 — 상태 개발 완료 → 검토")
    want(got, "TST-2", "SKIP", "priority 변경")
    want(got, "TST-3", "SKIP", "새 댓글")
    eq(posts(f), 0, "no write")


@case("apply 9: only updated moved (no change set, no comment) → SKIP manual 갱신 시각만 바뀜")
def _(f):
    s = Scn(f)
    f.issues["TST-1"]["updated"] = f.now()
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "manual: 갱신 시각만 바뀜")


@case("apply 10: recheck exit 10 → SKIP proof (우리 댓글 없음); exit 3 → stage stops exit 6, later rows untouched")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    rc, got, _ = s.apply({"FAKE_JUDGE_RULES": "TST-1=10"})
    want(got, "TST-1", "SKIP", "proof: staging 배포에서 PR #12가 빠짐 (우리 댓글 없음)")
    want(got, "TST-2", "OK", "moved")
    s2 = Scn(f, keys=("TST-3", "TST-4"))
    n = len(f.log)
    rc, got, err = s2.apply({"FAKE_JUDGE_RULES": "TST-3=3"})
    eq((rc, got), (6, {}), "stopped")
    if "증거 재확인 실패 (종료 코드 3)" not in err:
        raise AssertionError(err)
    eq(("TST-3" in f.key_log[n:], "TST-4" in f.key_log[n:]), (True, False), "TST-4 never read")


@case("apply 11: snapshot transition not offered → SKIP transition")
def _(f):
    s = Scn(f)
    f.transitions["TST-1"] = [{"id": "31", "name": "QA로", "to": {"id": "29999", "name": "다른 곳"}}]
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "transition: QA (staging)(으)로")
    eq(posts(f), 0, "no write")


@case("apply 12: comment 400 → FAIL comment-rejected + journal; 500 (stored) → UNKNOWN, journal sent only")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    f.modes["comment.post"] = "400"
    _, got, _ = s.apply()
    want(got, "TST-1", "FAIL", "comment-rejected: 댓글 거부됨")
    eq(events(s, "TST-1"), ["comment-sent", "comment-rejected"], "journal 1")
    eq(len(f.calls("POST", "transition.post")), 0, "no transition")
    s2 = Scn(f, keys=("TST-3",))
    f.modes["comment.post"] = "store-then-500"
    _, got, _ = s2.apply()
    want(got, "TST-3", "UNKNOWN", "댓글을 보냈지만 결과 미확정")
    eq(events(s2, "TST-3"), ["comment-sent"], "journal 2")


@case("apply 12: foreign comment right after ours → FAIL changed-after-comment, next row still runs")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    f.modes["comment.post"] = "store-and-foreign"
    rc, got, _ = s.apply()
    want(got, "TST-1", "FAIL", "changed-after-comment: 댓글 게시 후 다른 변경 발생")
    eq(rc, 0, "stage continues")
    eq("transition-sent" in events(s, "TST-1"), False, "not moved")
    want(got, "TST-2", "FAIL", "changed-after-comment")   # 같은 모드라 둘째 행도 같은 이유 — 단계는 계속


@case("apply 12 circuit breaker: Jira stores a different text → FAIL + exit 9, later rows untouched")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    f.modes["comment.post"] = "mutate"
    rc, got, err = s.apply()
    eq(rc, 9, "rc")
    want(got, "TST-1", "FAIL", "게시된 댓글이 승인본 조건과 다름: 본문이 승인본과 다름")
    eq(list(got), ["TST-1"], "only TST-1 decided")
    eq(events(s, "TST-2"), [], "TST-2 journal")
    eq("TST-2" in f.key_log, False, "TST-2 was read")
    rc, v, _ = s.verify()
    want(v, "TST-2", "UNRESOLVED", "NOT-ATTEMPTED")


@case("apply 12 circuit breaker: stored comment edited (updated ≠ created) → exit 9 names the predicate")
def _(f):
    s = Scn(f)
    f.modes["comment.post"] = "edited"
    rc, got, _ = s.apply()
    eq(rc, 9, "rc")
    want(got, "TST-1", "FAIL", "수정된 댓글")


@case("apply 13: transition 400 → FAIL transition-rejected; 500 → UNKNOWN")
def _(f):
    s = Scn(f)
    f.modes["transition.post"] = "400"
    _, got, _ = s.apply()
    want(got, "TST-1", "FAIL", "transition-rejected: 옮기기 거부됨")
    eq(events(s), ["comment-sent", "comment-ok", "transition-sent", "transition-rejected"], "journal 1")
    s2 = Scn(f, keys=("TST-2",))
    f.modes["transition.post"] = "500"
    _, got, _ = s2.apply()
    want(got, "TST-2", "UNKNOWN", "옮기기를 보냈지만 결과 미확정")
    eq(events(s2, "TST-2"), ["comment-sent", "comment-ok", "transition-sent"], "journal 2")


@case("transition-rejected → rerun resumes without a second comment → OK moved → verify OK")
def _(f):
    s = Scn(f)
    f.modes["transition.post"] = "400"
    s.apply()
    f.modes.clear()
    rc, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")
    eq(len(f.calls("POST", "comment.post")), 1, "one comment")
    rc, v, err = s.verify()
    eq(rc, 0, err)
    want(v, "TST-1", "OK", "이번 실행이 옮김")


@case("transition-ok fsynced then SIGKILL before RESULT → ABORTED UNKNOWN → verify OK")
def _(f):
    s = Scn(f)
    rc, got, _ = s.apply({"CHORE_JIRA_TEST_KILL_AFTER": "transition-ok"})
    eq((rc, got), (-9, {}), "killed")
    eq(events(s)[-1], "transition-ok", "journal")
    rc, v, err = s.verify()
    eq(rc, 0, err)
    want(v, "TST-1", "OK", "이번 실행이 옮김")


@case("transition-ok then SIGKILL, that run's results excluded (no SUMMARY/ABORTED) → rerun OK already-done → "
      "verify on the rerun alone OK 이번 실행이 옮김")
def _(f):
    s = Scn(f)
    rc, got, _ = s.apply({"CHORE_JIRA_TEST_KILL_AFTER": "transition-ok"})
    eq((rc, got), (-9, {}), "killed")
    eq(events(s), ["comment-sent", "comment-ok", "transition-sent", "transition-ok"], "journal of attempt 1")
    open(s.results, "w").close()   # 엔진째 죽은 실행의 결과 파일은 SUMMARY/ABORTED가 없어 절차상 빠진다 — 일지는 그대로
    n = posts(f)
    rc, got, _ = s.apply()
    want(got, "TST-1", "OK", "already-done: ")
    eq((rc, posts(f) - n), (0, 0), "no write on rerun")
    res = open(s.results, encoding="utf-8").read()
    eq(("attempt=20261019T000001Z-00000001" in res, "attempt=20261019T000002Z-00000002" in res), (False, True),
       "only attempt 2 in the results")
    rc, v, err = s.verify()
    eq(rc, 0, err)
    want(v, "TST-1", "OK", "이번 실행이 옮김")


@case("comment-ok then SIGKILL → UNKNOWN → verify rule 5 UNRESOLVED 댓글만 남음 → rerun OK → verify OK")
def _(f):
    s = Scn(f)
    rc, _, _ = s.apply({"CHORE_JIRA_TEST_KILL_AFTER": "comment-ok"})
    eq(rc, -9, "killed")
    rc, v, err = s.verify()
    eq(rc, 0, err)
    want(v, "TST-1", "UNRESOLVED", "댓글만 남음 — UNKNOWN")
    if "권장: 같은 명령으로 다시 실행" not in v["TST-1"][1]:
        raise AssertionError(v)
    rc, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")
    eq(len(f.calls("POST", "comment.post")), 1, "one comment")
    want(s.verify()[1], "TST-1", "OK", "이번 실행이 옮김")


@case("comment timeout + someone moves it to target → apply SKIP manual, verify UNRESOLVED")
def _(f):
    s = Scn(f)
    f.modes["comment.post"] = "sleep-nostore"
    s.apply({"CHORE_JIRA_TIMEOUT": "0.4"})
    f.modes.clear()
    to_qa(f)
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "manual: 댓글을 보냈지만 지금 안 보임")
    want(s.verify()[1], "TST-1", "UNRESOLVED", "manual: ")


@case("moved, then QA advances to Done → verify OK 이번 실행이 옮김 — 현재 Done")
def _(f):
    s = Scn(f)
    s.apply()
    f.issues["TST-1"]["status"] = {"id": "10050", "name": "Done"}
    want(s.verify()[1], "TST-1", "OK", "이번 실행이 옮김 — 현재 Done")


@case("at-target, then advanced → verify RESOLVED (rule 8)")
def _(f):
    s = Scn(f)
    to_qa(f)
    s.apply()
    f.issues["TST-1"]["status"] = {"id": "10050", "name": "Done"}
    want(s.verify()[1], "TST-1", "RESOLVED", "at-target: 이미 목표 상태 — 이번 실행이 한 것 아님, 쓰기 없음")


@case("comment-rejected, then someone moves it → verify WARN (rule 7)")
def _(f):
    s = Scn(f)
    f.modes["comment.post"] = "400"
    s.apply()
    f.modes.clear()
    to_qa(f)
    want(s.verify()[1], "TST-1", "WARN", "목표 상태지만 이번 실행이 한 것은 아님")


# --- torn journal tails ---
@case("torn outcome, comment absent → repaired (.torn-<attempt>) → SKIP manual → verify twice UNRESOLVED")
def _(f):
    s = Scn(f)
    a0 = "20261019T000000Z-aaaaaaaa"
    s.write_journal(jl(a0, "TST-1", "comment-sent") + "\n" + jl(a0, "TST-1", "comment-o")[:-1])
    rc, got, err = s.apply()
    want(got, "TST-1", "SKIP", "manual: 댓글을 보냈지만 지금 안 보임")
    if "잘린 줄" not in err:
        raise AssertionError(err)
    torn = s.journal + ".torn-20261019T000001Z-00000001"
    eq(open(torn, "rb").read(), jl(a0, "TST-1", "comment-o")[:-1].encode(), "torn bytes moved")
    eq(s.jlines(), [jl(a0, "TST-1", "comment-sent")], "journal cut at the line end")
    for _i in range(2):
        rc, v, err = s.verify()
        eq(rc, 0, err)
        want(v, "TST-1", "UNRESOLVED", "manual")


@case("torn outcome, comment live → resume → OK moved")
def _(f):
    s = Scn(f)
    a0 = "20261019T000000Z-aaaaaaaa"
    f.add_comment("TST-1", s.text["TST-1"])
    s.write_journal(jl(a0, "TST-1", "comment-sent") + "\n" + jl(a0, "TST-1", "comment-ok", "7")[:30])
    _, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")
    eq(len(f.calls("POST", "comment.post")), 0, "no second comment")
    want(s.verify()[1], "TST-1", "OK", "이번 실행이 옮김")


@case("torn *-sent (no newline at all) → whole file moved → fresh run")
def _(f):
    s = Scn(f)
    s.write_journal(jl("20261019T000000Z-aaaaaaaa", "TST-1", "comment-sent")[:40])
    _, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")
    eq(events(s), ["comment-sent", "comment-ok", "transition-sent", "transition-ok"], "fresh journal")


@case("torn 'transition-o' → step 1 does not die → OK already-done")
def _(f):
    s = Scn(f)
    a0 = "20261019T000000Z-aaaaaaaa"
    c = f.add_comment("TST-1", s.text["TST-1"])
    to_qa(f)
    s.write_journal("\n".join([jl(a0, "TST-1", "comment-sent"), jl(a0, "TST-1", "comment-ok", c["id"]),
                               jl(a0, "TST-1", "transition-sent")]) + "\n" + jl(a0, "TST-1", "transition-o")[:-3])
    rc, got, _ = s.apply()
    eq(rc, 0, "rc")
    want(got, "TST-1", "OK", "already-done")


# --- lock · parent · TERM ---
@case("second helper while the lock is held → exit 7, no journal line, no Jira call")
def _(f):
    s = Scn(f)
    os.makedirs(os.path.dirname(s.lock), exist_ok=True)
    fd = os.open(s.lock, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        rc, got, err = s.apply()
    finally:
        os.close(fd)
    eq((rc, got, s.jlines(), f.log), (7, {}, [], []), "held")
    if "다른 apply가 이 계획으로 Jira를 쓰는 중" not in err:
        raise AssertionError(err)
    eq(os.path.exists(s.lock), True, "lock file kept")


@case("parent SIGKILLed while the helper waits before its first *-sent → helper exits, nothing written")
def _(f):
    s = Scn(f)
    att = s.next_attempt()
    out_p, err_p = os.path.join(s.dir, "h.out"), os.path.join(s.dir, "h.err")
    env = s.env({"CHORE_JIRA_TEST_DELAY": "2", "HELPER_OUT": out_p, "HELPER_ERR": err_p})
    par = subprocess.Popen([sys.executable, "-I", PARENT] + s.cmd(att, "@PARENT@"), stdout=subprocess.PIPE, env=env)
    hpid = int(par.stdout.readline())
    t = time.monotonic()
    while not s.judge_calls() and time.monotonic() - t < 15:     # 판정기 로그가 보인 뒤에 부모를 죽인다(부하에 안정)
        time.sleep(0.05)
    time.sleep(0.3)
    par.kill()
    par.wait()
    t = time.monotonic()
    while time.monotonic() - t < 20:
        try:
            os.kill(hpid, 0)
            time.sleep(0.1)
        except ProcessLookupError:
            break
    else:
        raise AssertionError("helper still running")
    eq((s.jlines(), posts(f)), ([], 0), "nothing written")
    err = open(err_p, encoding="utf-8").read()
    if "부모 프로세스" not in err and "증거 재확인을 멈춤" not in err:
        raise AssertionError(err)


@case("TERM during an in-flight comment → outcome journaled once, no further step, exit 8")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    f.modes["comment.post"] = "store-then-sleep"
    att = s.next_attempt()
    p = subprocess.Popen(s.cmd(att, os.getpid()), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=s.env())
    t = time.monotonic()
    while not f.calls("POST", "comment.post") and time.monotonic() - t < 15:
        time.sleep(0.05)
    time.sleep(0.3)
    p.send_signal(signal.SIGTERM)
    out, err = p.communicate(timeout=30)
    rc, got, err = s.finish(att, p.returncode, out.decode(), err.decode())
    eq((rc, got), (8, {}), "stopped without a RESULT")
    eq(events(s), ["comment-sent", "comment-ok"], "outcome journaled")
    eq(len(f.calls("POST", "transition.post")), 0, "no transition")
    eq("TST-2" in f.key_log, False, "TST-2 never read")
    want(s.verify()[1], "TST-1", "UNRESOLVED", "댓글만 남음 — UNKNOWN")


# --- times · retries · binding guard ---
@case("mixed offsets: plan created Z vs comment +0900 (equal = in C, 1 ms earlier = not); changelog Z after expected")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2", "TST-3"))
    a0 = "20261019T000000Z-aaaaaaaa"
    f.add_comment("TST-1", s.text["TST-1"], created="2026-10-19T06:30:00.000+0900")
    f.add_comment("TST-2", s.text["TST-2"], created="2026-10-19T06:29:59.999+0900")
    s.write_journal(jl(a0, "TST-1", "comment-sent") + "\n" + jl(a0, "TST-2", "comment-sent") + "\n")
    f.histories["TST-3"] = [{"id": "1", "author": {"accountId": OTHER}, "created": "2026-10-18T21:08:00.000Z",
                             "items": [{"field": "labels"}]}]
    _, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")
    want(got, "TST-2", "SKIP", "manual")
    want(got, "TST-3", "SKIP", "changed: 계획 뒤에 티켓이 바뀜 — labels 변경")


@case("Rank-only (and comment-field) changelog items are not a change → OK moved")
def _(f):
    s = Scn(f)
    f.histories["TST-1"] = [{"id": "1", "author": {"accountId": OTHER}, "created": "2026-10-19T06:40:00.000+0900",
                             "items": [{"field": "Rank"}, {"field": "Comment"}]}]
    _, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")


@case("updated moved: Rank item after expected explains it → OK moved; no item at all → SKIP manual 갱신 시각만 바뀜")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    f.histories["TST-1"] = [{"id": "1", "author": {"accountId": OTHER}, "created": "2026-10-19T06:40:00.000+0900",
                             "items": [{"field": "Rank"}]}]
    f.issues["TST-1"]["updated"] = "2026-10-19T06:40:00.000+0900"
    f.issues["TST-2"]["updated"] = "2026-10-19T06:40:00.000+0900"
    _, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")
    want(got, "TST-2", "SKIP", "manual: 갱신 시각만 바뀜")


@case("read retries: GET 500×2 / reset×1 recover; 500×3 → exit 6; POST never retried")
def _(f):
    s = Scn(f)
    f.fail_first = {"view": ["500", 2], "comments": ["drop", 1]}
    _, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")
    s2 = Scn(f, keys=("TST-2",))
    f.fail_first = {"view": ["500", 3]}
    rc, got, err = s2.apply()
    eq((rc, got), (6, {}), "gave up")
    s3 = Scn(f, keys=("TST-3",))
    f.modes["comment.post"] = "500"
    n = len(f.calls("POST", "comment.post"))
    s3.apply()
    eq(len(f.calls("POST", "comment.post")) - n, 1, "one POST")
    f.modes.clear()
    f.fail_first = {"view": ["500", 2]}
    rc, d, _ = run_cli(f.base, "view", "TST-3")
    eq((rc, d["key"]), (0, "TST-3"), "cli read retried")


@case("apply-rows: binding mismatch / bad attempt / plan for another repo → exit 1 before any Jira call")
def _(f):
    s = Scn(f)
    with open(s.md, "w", encoding="utf-8") as fh:
        fh.write(REPOS_MD.replace("jira-qa=20004", "jira-qa=20005"))
    rc, got, err = s.apply()
    eq((rc, f.log), (1, []), "binding")
    if "바인딩 불일치" not in err:
        raise AssertionError(err)
    with open(s.md, "w", encoding="utf-8") as fh:
        fh.write(REPOS_MD)
    cmd = s.cmd("not-an-attempt", os.getpid())
    p = subprocess.run(cmd, capture_output=True, env=s.env(), timeout=30)
    eq((p.returncode, f.log), (1, []), "attempt")
    cmd = s.cmd(s.next_attempt(), os.getpid())
    cmd[cmd.index("--remote") + 1] = "test/other"
    p = subprocess.run(cmd, capture_output=True, env=s.env(), timeout=30)
    eq((p.returncode, f.log), (1, []), "remote")
    p = subprocess.run(cmd[:-2], capture_output=True, env=s.env(), timeout=30)
    eq(p.returncode, 1, "missing --judge = usage 1")


# --- verify-rows: rule V ---
def _good(s):
    """moved 한 번 → (결과 글, 일지 글, attempt)."""
    s.apply()
    return open(s.results, encoding="utf-8").read(), open(s.journal, encoding="utf-8").read(), "20261019T000001Z-00000001"


def _dies(s, results, journal, needle):
    jp = os.path.join(s.dir, "journal.custom")
    with open(jp, "w", encoding="utf-8") as fh:
        fh.write(journal)
    rc, got, err = s.verify(results=results.replace(f"journal={s.journal}", f"journal={jp}"), journal=jp)
    eq((rc, got), (1, {}), f"die ({needle})")
    if not err.startswith("chore-jira: verify-rows: 결과/일지 형식 오류: ") or needle not in err:
        raise AssertionError(err)


@case("verify V1: journal order / kind twice / unapproved ref / bad attempt → die; torn tail only noted")
def _(f):
    s = Scn(f)
    res, jr, a = _good(s)
    b = "20261019T000009Z-bbbbbbbb"
    _dies(s, res, jr + jl(b, "TST-1", "comment-sent") + "\n" + jl(b, "TST-1", "transition-sent") + "\n", "답이 없는 댓글")
    _dies(s, res, jr + jl(b, "TST-1", "comment-sent") + "\n" + jl(b, "TST-1", "comment-sent") + "\n", "답이 없는 댓글")
    _dies(s, res, jr + jl(b, "TST-1", "transition-rejected") + "\n", "순서가 틀림")
    _dies(s, res, jr + jl(b, "TST-9", "comment-sent") + "\n", "새 계획을 만드세요")
    _dies(s, res, jr + jl("2026-bad", "TST-1", "comment-sent") + "\n", "형식이 틀림")
    _dies(s, res, jr + jl(b, "TST-1", "comment-ok") + "\n", "댓글 id")
    jp = os.path.join(s.dir, "journal.torn")
    with open(jp, "w", encoding="utf-8") as fh:
        fh.write(jr + jl(b, "TST-1", "comment-se")[:-2])
    rc, v, err = s.verify(results=res.replace(f"journal={s.journal}", f"journal={jp}"), journal=jp)
    eq(rc, 0, err)
    want(v, "TST-1", "OK")
    if "무시함" not in err:
        raise AssertionError(err)


@case("verify V2: bad class / class on UNKNOWN / missing or bad attempt= / unknown result → die")
def _(f):
    s = Scn(f)
    res, jr, a = _good(s)
    line = f"RESULT\tOK\tjira-transition\tjira#TST-1\tmoved: x\tattempt={a}"
    for bad, needle in ((line.replace("moved:", "finished:"), "허용 목록"),
                        (line.replace("OK\t", "UNKNOWN\t", 1), "분류가 없어야"),
                        (line.replace("OK\t", "SKIP\t", 1).replace("moved:", "already-done:"), "허용 목록"),
                        (line.rsplit("\t", 1)[0], "6칸"), (line.replace("attempt=", "attempt=x"), "attempt="),
                        (line.replace("OK\t", "DONE\t", 1), "목록에 없음")):
        _dies(s, res + bad + "\n", jr, needle)


@case("verify V3: OK moved / FAIL claims without the journal event; NOT-ATTEMPTED with journal lines → die")
def _(f):
    s = Scn(f)
    res, jr, a = _good(s)
    b = "20261019T000009Z-bbbbbbbb"
    res += f"ABORTED\trun_id={RUN_ID}\tat=jira\tscope=full\tattempt={b}\tjournal={s.journal}\treason=x\n"
    base = f"RESULT\t%s\tjira-transition\tjira#TST-1\t%s\tattempt={b}\n"
    j1 = jr + jl(b, "TST-1", "comment-sent") + "\n" + jl(b, "TST-1", "comment-ok", "5") + "\n"
    _dies(s, res + base % ("OK", "moved: x"), j1, "transition-ok 없음")
    _dies(s, res + base % ("FAIL", "comment-rejected: x"), j1, "comment-rejected 없음")
    _dies(s, res + base % ("FAIL", "changed-after-comment: x"), jr + jl(b, "TST-1", "comment-sent") + "\n", "comment-ok 없음")
    _dies(s, res + base % ("FAIL", "transition-rejected: x"), j1, "transition-rejected 없음")
    _dies(s, res + base % ("NOT-ATTEMPTED", "run aborted"), j1, "NOT-ATTEMPTED")


@case("verify V4: SUMMARY run_id differs / scope missing / no SUMMARY at all → die")
def _(f):
    s = Scn(f)
    res, jr, a = _good(s)
    _dies(s, res.replace(f"run_id={RUN_ID}", "run_id=20261018T000000Z-ffffffff"), jr, "run_id")
    _dies(s, res.replace("\tscope=full", ""), jr, "scope=")
    _dies(s, "\n".join(x for x in res.split("\n") if not x.startswith("SUMMARY")), jr, "SUMMARY/ABORTED")


# --- verify-rows: rules 0–9 ---
@case("verify 0: only-group runs only → NOT-SCHEDULED (no Jira read); a full run with no result → FAIL 결과 없음")
def _(f):
    s = Scn(f)
    og = (f"SUMMARY\tok=0\tskip=0\tfail=0\tunknown=0\trun_id={RUN_ID}\tscope=only-group\t"
          f"attempt=20261019T000001Z-00000001\tjournal={s.journal}\n")
    rc, v, err = s.verify(results=og)
    eq(rc, 0, err)
    want(v, "TST-1", "NOT-SCHEDULED")
    eq(f.log, [], "no Jira read")
    rc, v, _ = s.verify(results=og + og.replace("only-group", "full"))
    want(v, "TST-1", "FAIL", "결과 없음")


@case("verify 1: identity changed — no write → RESOLVED; after a write → FAIL")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    f.issues["TST-1"]["id"] = "99999"
    s.apply()
    f.issues["TST-2"]["project"] = "OTH"
    rc, v, err = s.verify()
    eq(rc, 0, err)
    want(v, "TST-1", "RESOLVED", "신원 바뀜, 쓰기 없음")
    want(v, "TST-2", "FAIL", "신원 불일치(쓰기 있었음)")


@case("verify 2: a second approved comment appears after the move → UNRESOLVED manual")
def _(f):
    s = Scn(f)
    s.apply()
    f.add_comment("TST-1", s.text["TST-1"])
    want(s.verify()[1], "TST-1", "UNRESOLVED", "승인 댓글이 2개")


@case("verify 3: last result SKIP manual (갱신 시각만 바뀜) → UNRESOLVED with its reason")
def _(f):
    s = Scn(f)
    f.issues["TST-1"]["updated"] = f.now()
    s.apply()
    rc, v, _ = s.verify()
    want(v, "TST-1", "UNRESOLVED", "manual: 갱신 시각만 바뀜")
    if "권장: 티켓의 정리 댓글과 상태를 직접 확인" not in v["TST-1"][1]:
        raise AssertionError(v)
    to_qa(f)    # 규칙 3이 규칙 7(WARN)보다 먼저: 사람이 옮겼어도 manual은 UNRESOLVED로 남는다
    want(s.verify()[1], "TST-1", "UNRESOLVED", "manual: 갱신 시각만 바뀜")


@case("verify 4: transition sent, applied, answer lost (UNKNOWN) → OK 전환 주체 미확정")
def _(f):
    s = Scn(f)
    f.modes["transition.post"] = "store-then-500"
    _, got, _ = s.apply()
    want(got, "TST-1", "UNKNOWN")
    want(s.verify()[1], "TST-1", "OK", "목표 상태와 승인 댓글 확인 — 전환 주체 미확정")


@case("verify 5: our comment present, proof now fails → SKIP proof (우리 댓글 있음) → UNRESOLVED with proof RECOMMEND")
def _(f):
    s = Scn(f)
    f.modes["transition.post"] = "400"
    s.apply()
    f.modes.clear()
    _, got, _ = s.apply({"FAKE_JUDGE_RULES": "TST-1=10"})
    want(got, "TST-1", "SKIP", "proof: staging 배포에서 PR #12가 빠짐 (우리 댓글 있음)")
    v = s.verify()[1]
    want(v, "TST-1", "UNRESOLVED", "댓글만 남음 — SKIP proof: ")
    if not v["TST-1"][1].endswith("권장: 증거가 사라짐 — 댓글을 고쳐 보류 사유를 남기거나 다음 정리에서 재판정"):
        raise AssertionError(v)


@case("verify 6: comment sent, 500, never stored → UNRESOLVED 댓글을 보냈지만 보이지 않음")
def _(f):
    s = Scn(f)
    f.modes["comment.post"] = "500"
    s.apply()
    v = s.verify()[1]
    want(v, "TST-1", "UNRESOLVED", "댓글을 보냈지만 보이지 않음 — 효과 미확정")
    if "권장: 다음 정리에서 재판정" not in v["TST-1"][1]:
        raise AssertionError(v)


@case("verify 8: SKIP changed, nothing written → RESOLVED changed: …, 쓰기 없음")
def _(f):
    s = Scn(f)
    f.issues["TST-1"]["status"] = {"id": "20002", "name": "검토"}
    s.apply()
    want(s.verify()[1], "TST-1", "RESOLVED", "changed: 계획 뒤에 티켓이 바뀜 — 상태 개발 완료 → 검토, 쓰기 없음")


@case("verify 9: NOT-ATTEMPTED (stage stopped by recheck) / FAIL comment-rejected → UNRESOLVED with RECOMMEND")
def _(f):
    s = Scn(f, keys=("TST-1", "TST-2"))
    eq(s.apply({"FAKE_JUDGE_RULES": "TST-1=3"})[0], 6, "stopped")
    v = s.verify()[1]
    want(v, "TST-1", "UNRESOLVED", "NOT-ATTEMPTED run aborted at jira — 권장: 같은 명령으로 다시 실행")
    want(v, "TST-2", "UNRESOLVED", "NOT-ATTEMPTED")
    s2 = Scn(f, keys=("TST-3",))
    f.modes["comment.post"] = "400"
    s2.apply()
    want(s2.verify()[1], "TST-3", "UNRESOLVED", "FAIL comment-rejected: 댓글 거부됨")


@case("verify: live read failure → exit 6; 401 → exit 5 with the fixed text")
def _(f):
    s = Scn(f)
    s.apply()
    f.modes["comments"] = "500"
    eq(s.verify()[0], 6, "read failure")
    f.modes = {"view": "401"}
    rc, _, err = s.verify()
    eq((rc, err), (5, CJ.AUTH_MSG + "\n"), "auth")


# --- review round (2026-10-19): one case per item ---
@case("review 1: error body — only errorMessages/errors strings, scrubbed (incl. \\/ URLs); other shapes → fixed text")
def _(f):
    f.add_issue("PROJ-1")
    f.modes["comment.post"] = "400-custom"
    for body, leak, fixed in (
            (b'{"message":"test-token-xyz secret-abc-123"}', "secret-abc-123", True),
            (b'{"errorMessages":["see https:\\\\/\\\\/h.example\\\\/p?x=secret-def-456"]}', "h.example", False),
            (b'{"errorMessages":["see https:\\/\\/h2.example\\/p"]}', "h2.example", False),
            (b'{"errorMessages":["x"],"errors":{"a":{"nested":"secret-ghi"}}}', "secret-ghi", True),
            (b'{"errorMessages":[{"m":"secret-mno"}]}', "secret-mno", True),
            (b"<html>secret-jkl</html>", "secret-jkl", True)):
        f.error_body = body
        rc, _, err = run_cli(f.base, "comment", "PROJ-1", stdin=b"x")
        eq(rc, 3, body)
        if leak in err or TOKEN in err or ("응답 본문 형식 미지원" in err) != fixed:
            raise AssertionError(f"{body!r} → {err!r}")


@case("review 2: search isLast missing / null / non-bool → 6 (no lenient stop)")
def _(f):
    f.search_issues = [{"id": str(500 + i), "key": f"PROJ-{i}"} for i in range(1, 6)]
    for mode in ("no-islast", "null-islast", "str-islast"):
        f.modes = {"search": mode}
        eq(run_cli(f.base, "search", "--jql", "x")[0], 6, mode)


@case("review 3: changelog — the first page's total is the baseline; a later page with another total → 6")
def _(f):
    f.add_issue("PROJ-1")
    f.histories["PROJ-1"] = [{"id": str(i), "author": None, "created": U0, "items": [{"field": "status"}]}
                            for i in range(3)]
    f.modes["changelog"] = "drift-down"
    eq(run_cli(f.base, "changelog", "PROJ-1")[0], 6, "total changed between pages")


@case("review 4: two apply-rows on different plans, same Jira project → second exits 7, no journal line")
def _(f):
    s1 = Scn(f, keys=("TST-1",))
    att = s1.next_attempt()
    p = subprocess.Popen(s1.cmd(att, os.getpid()), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=s1.env({"CHORE_JIRA_TEST_DELAY": "3"}))
    t = time.monotonic()
    while "TST-1" not in f.key_log and time.monotonic() - t < 15:
        time.sleep(0.05)
    s2 = Scn(f, keys=("TST-5",))
    rc, got, err = s2.apply()
    out, err1 = p.communicate(timeout=60)
    eq((rc, got, s2.jlines(), "TST-5" in f.key_log), (7, {}, [], False), "second blocked")
    if "같은 Jira 프로젝트" not in err:
        raise AssertionError(err)
    eq(p.returncode, 0, err1.decode())
    lock = os.path.join(root(), "home", ".cache", "chore", "jira-example.atlassian.net-TST.lock")
    eq((os.path.isfile(lock), oct(os.stat(os.path.dirname(lock)).st_mode & 0o777)), (True, "0o700"), "project lock")


def _during_recheck(f, s, mutate, env=None):
    """느린 가짜 judge가 도는 동안 티켓을 바꾼다 → (rc, got, err)."""
    att = s.next_attempt()
    p = subprocess.Popen(s.cmd(att, os.getpid()), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=s.env(dict({"FAKE_JUDGE_SLEEP": "1.5"}, **(env or {}))))
    t = time.monotonic()
    while not s.judge_calls() and time.monotonic() - t < 15:
        time.sleep(0.05)
    mutate()
    out, err = p.communicate(timeout=60)
    return s.finish(att, p.returncode, out.decode(), err.decode())


@case("review 5: ticket changes during recheck → SKIP changed 확인하는 동안 티켓이 바뀜, no write (fresh and resume)")
def _(f):
    s = Scn(f, keys=("TST-1",))
    _, got, _ = _during_recheck(f, s, lambda: f.issues["TST-1"].update(status={"id": "20002", "name": "검토"}))
    want(got, "TST-1", "SKIP", "changed: 확인하는 동안 티켓이 바뀜")
    eq(posts(f), 0, "no write (fresh)")
    s2 = Scn(f, keys=("TST-2",))
    a0 = "20261019T000000Z-aaaaaaaa"
    c = f.add_comment("TST-2", s2.text["TST-2"])
    s2.write_journal(jl(a0, "TST-2", "comment-sent") + "\n" + jl(a0, "TST-2", "comment-ok", c["id"]) + "\n")

    def edit():
        c["updated"] = f.now()
    _, got, _ = _during_recheck(f, s2, edit)
    want(got, "TST-2", "SKIP", "changed: 확인하는 동안 티켓이 바뀜")
    eq(posts(f), 0, "no transition (resume)")


@case("review 6: comment-field changelog item only + updated moved → SKIP manual (only Rank explains it)")
def _(f):
    s = Scn(f)
    f.histories["TST-1"] = [{"id": "1", "author": {"accountId": OTHER}, "created": "2026-10-19T06:40:00.000+0900",
                             "items": [{"field": "Comment"}]}]
    f.issues["TST-1"]["updated"] = "2026-10-19T06:40:00.000+0900"
    _, got, _ = s.apply()
    want(got, "TST-1", "SKIP", "manual: 갱신 시각만 바뀜")


@case("review 7: TERM during the last row's transition → its RESULT is written, exit 8 (ok and rejected)")
def _(f):
    for mode, result in (("store-then-sleep", "OK"), ("sleep-400", "FAIL")):
        f.reset()
        s = Scn(f)
        f.modes["transition.post"] = mode
        att = s.next_attempt()
        p = subprocess.Popen(s.cmd(att, os.getpid()), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=s.env())
        t = time.monotonic()
        while not f.calls("POST", "transition.post") and time.monotonic() - t < 15:
            time.sleep(0.05)
        time.sleep(0.3)
        p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=30)
        rc, got, _ = s.finish(att, p.returncode, out.decode(), err.decode())
        eq(rc, 8, mode)
        want(got, "TST-1", result)


@case("review 8: verify — jira ref with a corrupted action / RESULT attempt without its SUMMARY / journal= ≠ --journal → exit 1")
def _(f):
    s = Scn(f)
    res, jr, a = _good(s)
    _dies(s, res + f"RESULT\tOK\tjira-transitio\tjira#TST-1\tmoved: x\tattempt={a}\n", jr, "jira-transition")
    _dies(s, res + f"RESULT\tOK\tjira-transition\tjira#TST-1\tmoved: x\n".replace("\n", "\tattempt=20261019T000009Z-bbbbbbbb\n"),
          jr, "SUMMARY/ABORTED")
    rc, got, err = s.verify(results=res.replace(f"journal={s.journal}", "journal=/elsewhere/x.journal"))
    eq(rc, 1, err)
    if "journal=" not in err:
        raise AssertionError(err)


@case("review 9: torn-tail save writes the whole tail even with short writes, then truncates")
def _(f):
    d = tempfile.mkdtemp(prefix="torn.", dir=root())
    j = os.path.join(d, "x.journal")
    tail = ("2026-10-19T00:00:00.000Z 20261019T000000Z-aaaaaaaa jira#TST-1 comment-o" * 3).encode()
    with open(j, "wb") as fh:
        fh.write(b"line one\n" + tail)
    eng = CJ.Apply(types.SimpleNamespace(journal=j, attempt="20261019T000001Z-00000001"))
    real = os.write
    os.write = lambda fd, data: real(fd, bytes(data)[:7])      # 한 번에 7바이트까지만
    try:
        eng.repair()
    finally:
        os.write = real
    eq(open(j + ".torn-20261019T000001Z-00000001", "rb").read(), tail, "whole tail saved")
    eq(open(j, "rb").read(), b"line one\n", "truncated at the line end")



# --- re-review R10 (2026-10-19) ---
@case("R10 c: comment body missing / null / not an ADF doc → exit 6, zero POSTs; description missing or odd → 6")
def _(f):
    s = Scn(f)
    c = f.add_comment("TST-1", "다른 사람 댓글", author=OTHER, created="2026-10-19T05:00:00.000+0900")
    del c["body"]
    rc, got, err = s.apply()
    eq((rc, got, posts(f)), (6, {}, 0), "apply stops")
    for body in (None, {"type": "paragraph", "content": []}, ["x"], 5):
        c["body"] = body
        eq(run_cli(f.base, "comments", "TST-1")[0], 6, repr(body))
    c["body"] = "plain v2 text"
    eq(run_cli(f.base, "comments", "TST-1")[1][0]["text"], "plain v2 text", "str body ok")
    f.issues["TST-1"]["description"] = {"type": "paragraph", "content": []}
    eq(run_cli(f.base, "evidence", "TST-1")[0], 6, "description not a doc")
    f.issues["TST-1"]["no_description"] = True
    eq(run_cli(f.base, "evidence", "TST-1")[0], 6, "description missing")
    f.issues["TST-1"]["no_description"] = False
    f.issues["TST-1"]["description"] = None
    eq(run_cli(f.base, "evidence", "TST-1")[1]["description_text"], "", "null description = empty")


@case("R10 a: TERM right after comment-sent / transition-sent is fsynced → *-withdrawn, no POST, exit 8; rerun = unsent")
def _(f):
    s = Scn(f)
    rc, got, _ = s.apply({"CHORE_JIRA_TEST_TERM_AFTER": "comment-sent"})
    eq((rc, got, posts(f)), (8, {}, 0), "withdrawn before the POST")
    eq(events(s), ["comment-sent", "comment-withdrawn"], "journal")
    if "RESULT\tNOT-ATTEMPTED\tjira-transition\tjira#TST-1\t" not in open(s.results, encoding="utf-8").read():
        raise AssertionError("chore.sh abort rule: sent+withdrawn only → NOT-ATTEMPTED")
    rc, v, err = s.verify()                   # 중단 직후 확인: 형식 오류가 아니라 NOT-ATTEMPTED → UNRESOLVED
    eq(rc, 0, err)
    want(v, "TST-1", "UNRESOLVED", "NOT-ATTEMPTED")
    rc, got, _ = s.apply()
    want(got, "TST-1", "OK", "moved")         # 5단계 "보냈지만 안 보임"이 아니다
    rc, v, err = s.verify()                   # 이어 붙인 결과(중단 + 재실행)도 확인된다
    eq(rc, 0, err)
    want(v, "TST-1", "OK", "이번 실행이 옮김")
    # 이어 하기(댓글은 앞 시도에 있음)에서 transition-sent 직후 중단 → 그 시도의 줄은 sent+withdrawn뿐 → NOT-ATTEMPTED
    s2 = Scn(f, keys=("TST-2",))
    f.modes["transition.post"] = "400"
    want(s2.apply()[1], "TST-2", "FAIL", "transition-rejected")
    f.modes.clear()
    rc, got, _ = s2.apply({"CHORE_JIRA_TEST_TERM_AFTER": "transition-sent"})
    eq((rc, got, len(f.calls("POST", "transition.post"))), (8, {}, 2), "resume transition withdrawn")
    eq(events(s2, "TST-2")[-2:], ["transition-sent", "transition-withdrawn"], "journal 2")
    rc, v, err = s2.verify()
    eq(rc, 0, err)
    want(v, "TST-2", "UNRESOLVED", "NOT-ATTEMPTED")
    want(s2.apply()[1], "TST-2", "OK", "moved")
    rc, v, err = s2.verify()
    eq(rc, 0, err)
    want(v, "TST-2", "OK", "이번 실행이 옮김")
    # 같은 시도에서 댓글을 단 뒤 transition-sent 직후 중단 → 진짜 쓰기가 있었으므로 UNKNOWN → 확인은 "댓글만 남음"
    s3 = Scn(f, keys=("TST-3",))
    rc, got, _ = s3.apply({"CHORE_JIRA_TEST_TERM_AFTER": "transition-sent"})
    eq((rc, got), (8, {}), "fresh transition withdrawn")
    eq(events(s3, "TST-3"), ["comment-sent", "comment-ok", "transition-sent", "transition-withdrawn"], "journal 3")
    rc, v, err = s3.verify()
    eq(rc, 0, err)
    want(v, "TST-3", "UNRESOLVED", "댓글만 남음 — UNKNOWN")
    want(s3.apply()[1], "TST-3", "OK", "moved")
    want(s3.verify()[1], "TST-3", "OK", "이번 실행이 옮김")


@case("R10 d: --attempt already in the journal → exit 1 after torn repair, before any Jira call")
def _(f):
    s = Scn(f)
    att = "20261019T000001Z-00000001"           # Scn이 처음 쓸 attempt
    s.write_journal(jl(att, "TST-1", "comment-sent") + "\n" + jl(att, "TST-1", "comment-ok", "9")[:20])
    rc, got, err = s.apply()
    eq((rc, got, f.log), (1, {}, []), "refused")
    eq(s.jlines(), [jl(att, "TST-1", "comment-sent")], "torn tail repaired first, nothing appended")
    if "attempt" not in err:
        raise AssertionError(err)


@case("R10 b: 401/403 on a write → *-rejected journaled, exit 5; rerun posts normally")
def _(f):
    s = Scn(f)
    f.modes["comment.post"] = "401"
    rc, got, err = s.apply()
    eq((rc, got, err), (5, {}, CJ.AUTH_MSG + "\n"), "auth")
    eq(events(s), ["comment-sent", "comment-rejected"], "journal")
    f.modes.clear()
    want(s.apply()[1], "TST-1", "OK", "moved")
    s2 = Scn(f, keys=("TST-2",))
    f.modes["transition.post"] = "403"
    eq(s2.apply()[0], 5, "transition 403")
    eq(events(s2, "TST-2")[-2:], ["transition-sent", "transition-rejected"], "journal 2")


@case("v4.3: a journal that also holds move-issue (mv-) lines does not break the transition path; journaled_count counts them")
def _(f):
    s = Scn(f)
    att = "20261019T235959Z-0000abcd"
    mv = [f"2026-10-19T00:00:01.000Z {att} issue#5 mv-create-sent seq=1 acct={ME}",
          f"2026-10-19T00:00:02.000Z {att} issue#5 mv-create-ok sid={RUN_ID}/{att}/1 key=TST-50"]
    s.write_journal("\n".join(mv) + "\n")
    rc, got, err = s.apply()
    eq(rc, 0, err)
    want(got, "TST-1", "OK", "moved: 개발 완료 → QA (staging)")
    eq(events(s), ["comment-sent", "comment-ok", "transition-sent", "transition-ok"], "transition journal")
    eq(s.jlines()[:2], mv, "mv lines kept in place")
    rc, v, _ = s.verify()
    eq((rc, v["TST-1"][0]), (0, "OK"), "verify")
    entries = CJ.parse_journal(s.jlines(), {"jira#TST-1"})
    eq([e[2] for e in entries[:2]], ["mv-create-sent", "mv-create-ok"], "mv lines passed through unchecked")
    eq(CJ.journaled_count(entries)[(att, "issue#5")], 2, "counted like chore.sh P_JOURNALED")


@case("R10 e: project-lock file name uses the lowercased site")
def _(f):
    d = tempfile.mkdtemp(prefix="plock.", dir=root())
    eng = CJ.Apply(types.SimpleNamespace(lock=os.path.join(d, "p.lock"), journal=os.path.join(d, "p.journal")))
    eng.binding = {"site": "Example.Atlassian.NET", "project": "TST"}
    old = os.environ.get("HOME")
    os.environ["HOME"] = d
    try:
        eng.take_lock()
    finally:
        os.environ["HOME"] = old
        for fd in (eng.lock_fd, getattr(eng, "project_lock_fd", None)):
            if fd is not None:
                os.close(fd)
    eq(os.listdir(os.path.join(d, ".cache", "chore")), ["jira-example.atlassian.net-TST.lock"], "name")


@case("R10 f: verify — SUMMARY/ABORTED without journal= → exit 1; two RESULTs for one (attempt, ref) → exit 1")
def _(f):
    s = Scn(f)
    res, jr, a = _good(s)
    _dies(s, res.replace(f"\tjournal={s.journal}", ""), jr, "journal=")
    dup = [x for x in res.split("\n") if x.startswith("RESULT")][0]
    _dies(s, res + dup + "\n", jr, "두 번")


@case("R10 g: CHORE_JIRA_BASE only for 127.0.0.1 / localhost / [::1] — else refused before any request")
def _(f):
    f.add_issue("PROJ-1")
    port = f.base.rsplit(":", 1)[1]
    for bad in ("http://evil.example:" + port, "https://10.0.0.1", "http://127.0.0.1.evil.example:" + port,
                "http://user@127.0.0.1:" + port, "ftp://127.0.0.1"):
        rc, _, err = run_cli(bad, "myself")
        eq(rc, 2, bad)
        if "CHORE_JIRA_BASE" not in err:
            raise AssertionError(err)
    eq(run_cli("http://localhost:" + port, "myself")[:2], (0, {"account": ME}), "localhost ok")
    s = Scn(f, keys=("TST-1",))
    s.f = types.SimpleNamespace(base="http://evil.example:" + port)
    n = len(f.log)
    rc, got, _ = s.apply()
    eq((rc, len(f.log) - n), (1, 0), "apply-rows exit 1")


@case("R10 (9): torn save fsyncs the journal directory after the .torn file and before truncating")
def _(f):
    d = tempfile.mkdtemp(prefix="tornd.", dir=root())
    j = os.path.join(d, "x.journal")
    with open(j, "wb") as fh:
        fh.write(b"line one\npartial")
    seq = []
    real_fsync, real_trunc = os.fsync, os.ftruncate
    os.fsync = lambda fd: (seq.append("dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "file"), real_fsync(fd))[1]
    os.ftruncate = lambda fd, n: (seq.append("truncate"), real_trunc(fd, n))[1]
    try:
        CJ.Apply(types.SimpleNamespace(journal=j, attempt="20261019T000001Z-00000001")).repair()
    finally:
        os.fsync, os.ftruncate = real_fsync, real_trunc
    i = seq.index("truncate")
    if "dir" not in seq[:i] or seq.index("file") > seq.index("dir"):
        raise AssertionError(seq)



@case("binding 11: jira-repos=owner/a,owner/b → other_repos; malformed / duplicate / own remote → exit 1")
def _(f):
    def run_b(note):
        path = os.path.join(root(), "b11.md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("| a | b | remote | note |\n| x | y | `t/r` | " + note + " |\n")
        p = subprocess.run([sys.executable, "-I", SCRIPT, "binding", "--repos-md", path, "--remote", "t/r"],
                           capture_output=True, timeout=30)
        return p.returncode, (json.loads(p.stdout) if p.returncode == 0 else None), p.stderr.decode()
    rc, b, err = run_b("jira=h.example/TS jira-repos=Org/Api-2,org/web.app_x")
    eq((rc, b and b["other_repos"], b and b["project"]), (0, ["Org/Api-2", "org/web.app_x"], "TS"), err)
    eq(run_b("jira=h.example/TS")[1]["other_repos"], [], "absent = []")
    for note, needle in (("jira-repos=a", "owner/repo"), ("jira-repos=a/b,", "owner/repo"),
                         ("jira-repos=a/b/c", "owner/repo"), ("jira-repos=a/b,,c/d", "owner/repo"),
                         ("jira-repos=a/b;c/d", "owner/repo"), ("jira-repos=a/b,A/B", "두 번"),
                         ("jira-repos=x/y,T/R", "자신"), ("jira-repos=a/b jira-repos=c/d", "토큰이 두 번")):
        rc, _, err = run_b("jira=h.example/TS " + note)
        eq(rc, 1, note)
        if not err.startswith("chore-jira: binding: ") or err.count("\n") != 1 or needle not in err:
            raise AssertionError(f"{note}: {err!r}")



# --- round 3: ADF contents are validated, not silently dropped ---
def _doc(content):
    return {"type": "doc", "version": 1, "content": content}


MALFORMED_ADF = (
    ("root content null", {"type": "doc", "version": 1, "content": None}),
    ("root content dict", {"type": "doc", "version": 1, "content": {"type": "paragraph"}}),
    ("root content string", {"type": "doc", "version": 1, "content": "chore 정리 → Closed — by Claude triage 2026-10-01"}),
    ("root content missing", {"type": "doc", "version": 1}),
    ("text null", _doc([{"type": "paragraph", "content": [{"type": "text", "text": None}]}])),
    ("text int", _doc([{"type": "paragraph", "content": [{"type": "text", "text": 5}]}])),
    ("node not a dict", _doc([{"type": "paragraph", "content": ["chore 정리 → Closed — by Claude triage 2026-10-01"]}])),
    ("content not a list", _doc([{"type": "paragraph", "content": "x"}])),
    ("content null", _doc([{"type": "paragraph", "content": None}])),
    ("type missing", _doc([{"content": []}])),
    ("type not a string", _doc([{"type": 5, "content": []}])),
)


@case("R11-1: comment body with a malformed ADF shape → apply exit 6 and no POST; comments CLI → 6")
def _(f):
    s = Scn(f)
    c = f.add_comment("TST-1", "x", author=ME, created="2026-10-19T05:00:00.000+0900")
    for name, body in MALFORMED_ADF:
        c["body"] = body
        rc, got, _ = s.apply()
        eq((rc, got, posts(f)), (6, {}, 0), name)
        eq(run_cli(f.base, "comments", "TST-1")[0], 6, "cli " + name)


@case("R11-2: description with a malformed ADF shape → evidence exit 6; null description still empty")
def _(f):
    f.add_issue("PROJ-1")
    for name, body in MALFORMED_ADF:
        f.issues["PROJ-1"]["description"] = body
        eq(run_cli(f.base, "evidence", "PROJ-1")[0], 6, name)
    f.issues["PROJ-1"]["description"] = None
    eq(run_cli(f.base, "evidence", "PROJ-1")[1]["description_text"], "", "null description")


@case("R11-3: well-formed edge docs still read — content [] = \"\", unknown node types recurse, str body as is")
def _(f):
    s = Scn(f)
    c = f.add_comment("TST-1", "x", author=OTHER, created="2026-10-19T05:00:00.000+0900")
    c["body"] = _doc([])
    eq(run_cli(f.base, "comments", "TST-1")[1][0]["text"], "", "empty doc")
    want(s.apply()[1], "TST-1", "OK", "moved")          # 빈 남의 댓글은 정상 — 그대로 진행
    c["body"] = _doc([{"type": "weirdBlock", "attrs": {"x": 1},
                       "content": [{"type": "paragraph", "content": [{"type": "text", "text": "가"}]}]},
                      {"type": "rule"}])
    eq(run_cli(f.base, "comments", "TST-1")[1][0]["text"], "가\n", "unknown block recurses, leaf ignored")
    f.issues["TST-1"]["description"] = _doc([])
    eq(run_cli(f.base, "evidence", "TST-1")[1]["description_text"], "", "empty description doc")



def main():
    fake = FakeJira()
    failed = 0
    try:
        for name, fn in CASES:
            fake.reset()
            try:
                fn(fake)
                print(f"ok   {name}")
            except Exception as e:
                failed += 1
                detail = e if isinstance(e, AssertionError) else traceback.format_exc().strip().splitlines()[-1]
                print(f"FAIL {name}: {detail}")
    finally:
        fake.close()
        if ROOT is not None and not os.environ.get("CHORE_TEST_KEEP"):
            shutil.rmtree(ROOT, ignore_errors=True)
    print(f"{len(CASES) - failed}/{len(CASES)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
