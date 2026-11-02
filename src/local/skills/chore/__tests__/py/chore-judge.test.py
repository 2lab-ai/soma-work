#!/usr/bin/env python3
"""chore-judge.test.py — scripts/chore-judge.py 회귀 표 (chore v4 U2b, 2026-10-19).

    python3 -I __tests__/py/chore-judge.test.py        → 사례마다 ok/FAIL 한 줄, FAIL이 하나라도 있으면 exit 1

build·recheck를 subprocess(`python3 -I`)로 돌린다. 네트워크 없음: gh = PATH 앞의 Python 스텁(GH_FIX의 json에서 답하고
GH_LOG에 호출을 남김, GH_FAIL=<정규식>이면 exit 1), Jira = chore-jira.test.py의 FakeJira(CHORE_JIRA_BASE + 가짜 자격
증명), git = 임시 origin(bare) + clone. 계획 머리 줄 = fixtures/chore-v4/valid.tsv 첫 줄.
아직 없는 모듈은 대역을 쓴다(실물이 생기면 자동으로 실물):
  - scripts/chore-evidence.py 없음 → CHORE_EVIDENCE_PY = 아래 EV_DOUBLE(ev-schema.md 후보 규칙을 git으로 구현).
  - chore-jira.py에 read_binding 없음 → CHORE_JIRA_PY = 실물을 읽고 read_binding만 덧붙이는 감싸개.
첫 줄에 어느 쪽을 썼는지 찍는다.
v4.3 Jira로 옮기기(M 사례): chore-move.test.py를 경로로 읽어 그 가짜 Jira(project·issuetypes·createmeta·search·ticket)와
가짜 gh(CHORE_GH + JSON 상태 파일)를 그대로 쓰고, 사례마다 자기 git 클론(일지 = <clone>/.git/chore)에 일지 줄을 chore-jira.py
mv_line으로 쓴다. 기대 payload는 같은 함수(gh_issue · move_history · issue_check)로 따로 다시 만들어 바이트를 대조한다.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent.parent / "scripts"   # <skill>/scripts — this file is <skill>/__tests__/py/
JUDGE = SCRIPTS / "chore-judge.py"
REAL_EV = SCRIPTS / "chore-evidence.py"
REAL_CJ = SCRIPTS / "chore-jira.py"
HEADER = (HERE.parent / "fixtures" / "chore-v4" / "valid.tsv").read_bytes().split(b"\n", 1)[0]
VALID_ROWS = (HERE.parent / "fixtures" / "chore-v4" / "valid.tsv").read_bytes().split(b"\n")


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


P = _load("chore_plan", SCRIPTS / "chore_plan.py")
JT = _load("chore_jira_test", HERE / "chore-jira.test.py")      # FakeJira, EMAIL, TOKEN, ME, OTHER
CJ = JT.CJ
MV = _load("chore_move_test", HERE / "chore-move.test.py")      # move 가짜 Jira·가짜 gh·ours_ticket (main은 돌지 않음)
HDR = P.parse_header(HEADER)
RUN_ID = HDR["run_id"]
SITE, PROJECT, QA, CLOSED, HOLD = "example.atlassian.net", "TST", "20004", "20191", "20370"
ME, OTHER, BOT = JT.ME, JT.OTHER, "acct-bot"
BINDING = {"site": SITE, "project": PROJECT, "qa": QA, "closed": CLOSED, "hold": [HOLD],
           "proof_workflow": "deploy-staging.yml", "proof_branch": "deploy/staging", "proof_label": "staging"}
JQL = "project = TST AND assignee = currentUser() AND statusCategory != Done ORDER BY key"
RUN_URL = "https://github.com/test/repo/actions/runs/9000000001"
UPDATED = "2026-10-19T06:07:25.160+0900"
DATE = "2026-10-19"
T_QA = [{"id": "31", "to_id": QA, "to_name": "QA (staging)"}, {"id": "41", "to_id": CLOSED, "to_name": "Closed"},
        {"id": "13", "to_id": "20001", "to_name": "In Progress"}]
REPOS_MD = ("| repo | local path | remote (owner/repo) | note |\n|---|---|---|---|\n"
            "| `repo` | `~/x` | `test/repo` | 시험용 jira=%s/TST jira-qa=%s jira-closed=%s jira-hold=%s "
            "deploy-proof=deploy-staging.yml@deploy/staging |\n")

GH_STUB = r'''
import json, os, re, sys
argv = sys.argv[1:]
with open(os.environ["GH_LOG"], "a", encoding="utf-8") as fh:
    fh.write(" ".join(argv) + "\n")
fail = os.environ.get("GH_FAIL")
if fail and re.search(fail, " ".join(argv)):
    sys.stderr.write("gh-stub: forced failure\n"); sys.exit(1)
opts, pos, i = {}, [], 0
while i < len(argv):
    if argv[i].startswith("--") and argv[i] != "--paginate" and i + 1 < len(argv):
        opts[argv[i]] = argv[i + 1]; i += 2
    else:
        pos.append(argv[i]); i += 1
REPO = opts.get("--repo", "test/repo")
OWNER = next((a[6:] for a in argv if a.startswith("owner=")), None)
NAME = next((a[5:] for a in argv if a.startswith("name=")), None)
if OWNER and NAME:
    REPO = OWNER + "/" + NAME
SFX = "" if REPO.lower() == "test/repo" else "-" + REPO.replace("/", "-")
def load(name):
    if SFX and name in ("prs.json", "pr-total.json"):
        name = name[:-5] + SFX + ".json"
    try:
        with open(os.path.join(os.environ["GH_FIX"], name), encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return []
def pick(d):
    fs = opts.get("--json")
    return {k: d.get(k) for k in fs.split(",")} if fs else d
def out(x):
    sys.stdout.write(json.dumps(x)); sys.exit(0)
cmd = " ".join(pos[:2])
if cmd in ("pr view", "issue view"):
    for d in load("prs.json" if pos[0] == "pr" else "issues.json"):
        if str(d["number"]) == pos[2]:
            out(pick(d))
    sys.stderr.write("no such item\n"); sys.exit(1)
if cmd == "pr list":
    st = opts.get("--state", "open").upper()
    out([pick(d) for d in load("prs.json") if st == "ALL" or d["state"] == st])
if cmd == "api graphql":
    q = " ".join(a for a in argv if a.startswith("query="))
    if "pullRequests{totalCount}" in q:
        t = load("pr-total.json")
        out({"data": {"repository": {"pullRequests": {"totalCount": t if t != [] else len(load("prs.json"))}}}})
if cmd == "run list":
    runs = load("runs-all.json") if "--status" not in opts and load("runs-all.json") != [] else load("runs.json")
    out([pick(d) for d in runs][:int(opts.get("--limit", "20"))])
sys.stderr.write("gh-stub: unknown command\n"); sys.exit(2)
'''

EV_DOUBLE = r'''
"""chore-evidence.py 대역 (ev-schema.md API + 2026-10-19 리뷰 [E] 모양). gh = PATH의 스텁, git = 실제 clone.
[E] 모양: PR 후보의 reverted_by = 병합 커밋과 그 브랜치 커밋(두 부모면 merge^1..merge^2, 아니면 gh commits) 전부의 합,
--no-ff 병합이 들여온 커밋 중 키를 언급하는 것은 folded_commits로 접음, deploy에 stale/stale_reason(최근 실행이 고른
성공 push 실행이 아니면), 커밋이 클론에 없으면 complete=False."""
import json, re, subprocess

class EvidenceError(Exception):
    pass

def _inl(s):
    """chore-evidence.py _inl 그대로 (판정 build의 JIRA_TYPE 대조가 부른다)."""
    if s is None or s == "":
        return "(없음)"
    s = " ".join(str(s).replace("`", "'").split())
    return "`%s`" % (s if len(s) <= 300 else s[:299] + "…")

def _gh(args):
    p = subprocess.run(["gh"] + args, capture_output=True, timeout=60)
    if p.returncode != 0:
        raise EvidenceError("gh %s 실패" % " ".join(args[:2]))
    return json.loads(p.stdout)

def _git(clone, *args):
    return subprocess.run(["git", "-C", clone] + list(args), capture_output=True, timeout=60)

def deploy_head(remote, binding):
    wf, br = binding["proof_workflow"], binding["proof_branch"]
    runs = _gh(["run", "list", "--repo", remote, "--workflow", wf, "--branch", br, "--event", "push", "--status",
                "success", "--limit", "1", "--json", "headSha,databaseId,url,updatedAt"])
    if not runs:
        return None
    r = runs[0]
    d = {"workflow": wf, "branch": br, "S": r["headSha"], "run": str(r["databaseId"]), "run_url": r["url"],
         "completed": r["updatedAt"]}
    newest = _gh(["run", "list", "--repo", remote, "--workflow", wf, "--branch", br, "--limit", "1",
                  "--json", "databaseId"])
    if newest and newest[0]["databaseId"] != r["databaseId"]:
        d.update(stale=True, stale_reason="최근 실행 %s이 성공한 push 실행이 아님" % newest[0]["databaseId"])
    return d

def load_all_prs(remote):
    raw = _gh(["pr", "list", "--repo", remote, "--state", "all", "--limit", "100000", "--json",
               "number,title,headRefName,headRefOid,body,state,baseRefName,mergeCommit,commits"])
    o, n = _owner_name(remote)
    total = _gh(["api", "graphql", "-f", "query=query{repository{pullRequests{totalCount}}}", "-f", "owner=" + o,
                 "-f", "name=" + n])
    complete = total["data"]["repository"]["pullRequests"]["totalCount"] == len(raw)
    return [{"number": p["number"], "title": p["title"], "head_ref": p["headRefName"], "body": p["body"],
             "state": p["state"], "base": p["baseRefName"],
             "merge_sha": (p.get("mergeCommit") or {}).get("oid") if p["state"] == "MERGED" else None,
             "commits": [c["oid"] for c in p.get("commits") or []], "head_oid": p.get("headRefOid"),
             "is_cross_repo": False}
            for p in raw], complete

def _mentions(key, *texts):
    rx = re.compile(r"(?<![A-Za-z0-9])" + re.escape(key) + r"(?![0-9])", re.I)
    return any(rx.search(t or "") for t in texts)

def read_ledgers(paths, project):
    """{KEY: (사유, None)} — 줄 어디든 project 키가 나오면 그 키(증거 모듈과 같은 사유 문구), 못 읽으면 EvidenceError."""
    import pathlib
    out = {}
    for path in paths or ():
        pth = pathlib.Path(path)
        base = "다른 작업(%s)에서 진행 중인 티켓" % (pth.resolve().parent.name or pth.stem)
        try:
            lines = pth.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as e:
            raise EvidenceError("제외 원장 %s를 읽을 수 없음 (%s)" % (pth.name, type(e).__name__))
        for line in lines:
            if not line.strip() or line.strip().startswith("#"):
                continue
            for m in re.finditer(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)-([1-9][0-9]*)(?![0-9])", line):
                key = "%s-%s" % (m.group(1).upper(), m.group(2))
                if project and key.startswith(project + "-"):
                    out[key] = (base, None)
    return out

def _owner_name(remote):
    parts = remote.split("/") if isinstance(remote, str) else []
    if len(parts) != 2 or not all(parts):
        raise EvidenceError("remote는 owner/name 꼴이어야 함")
    return parts

def _other_repos(binding, remote):
    raw = binding.get("other_repos") if binding else None
    items = raw.split(",") if isinstance(raw, str) else list(raw or [])
    out = []
    for r in items:
        r = str(r).strip()
        if not r or r.lower() == remote.lower() or r.lower() in (x.lower() for x in out):
            continue
        _owner_name(r)
        out.append(r)
    return out

def key_pattern(key):
    return re.compile(r"(?<![A-Za-z0-9])" + re.escape(key) + r"(?![0-9])", re.I)

def _pr_mentions(rx, pr):
    return any(rx.search(pr.get(f) or "") for f in ("title", "head_ref", "body"))

def open_pr_mentions(key, all_prs):
    return sorted(p["number"] for p in all_prs
                  if p["state"] == "OPEN" and _mentions(key, p["title"], p["head_ref"], p["body"]))

def open_work(key, clone, default, i_refs, all_prs):
    """(열린 PR 번호, 키 이름 브랜치, complete): 제목·브랜치·본문 언급 + default..head 커밋 메시지 언급, 그리고
    origin의 키 이름 브랜치 중 통합 브랜치·그 PR들의 head·끝난 PR의 마지막 head·기본 브랜치에 들어간 것을 뺀 것."""
    complete, prs = True, set(open_pr_mentions(key, all_prs))
    for p in all_prs:
        if p["state"] != "OPEN" or p["number"] in prs:
            continue
        h = p.get("head_oid")
        if not h or not _has(clone, h):
            complete = False
            continue
        msgs = _git(clone, "log", "--format=%B", "refs/remotes/origin/%s..%s" % (default, h)).stdout.decode()
        if _mentions(key, msgs):
            prs.add(p["number"])
    finished = {p.get("head_oid") for p in all_prs if p["state"] != "OPEN"}
    heads = {p["head_ref"] for p in all_prs if p["state"] == "OPEN" and p["number"] in prs}
    rx = re.compile(r"(?<![A-Za-z0-9])" + re.escape(key) + r"(?![0-9])", re.I)
    branches = []
    for line in _git(clone, "for-each-ref", "--format=%(refname)%1f%(objectname)", "refs/remotes/origin").stdout.decode().splitlines():
        ref, _, tip = line.partition("\x1f")
        name = ref[len("refs/remotes/origin/"):]
        if name in ("HEAD",) or name in i_refs or name in heads or not rx.search(name) or tip in finished:
            continue
        if _git(clone, "merge-base", "--is-ancestor", tip, "refs/remotes/origin/" + default).returncode == 0:
            continue
        branches.append(name)
    return sorted(prs), sorted(branches), complete

def _has(clone, sha):
    return _git(clone, "cat-file", "-e", sha + "^{commit}").returncode == 0

def _reverts(clone, S):
    rv = _git(clone, "log", "--format=%H%x1f%B%x1e", "-E", "--grep=This reverts commit [0-9a-f]{7,40}", S, "--")
    if rv.returncode:
        raise EvidenceError("git log")
    out = []
    for rec in rv.stdout.decode().split("\x1e"):
        h, _, msg = rec.strip("\n").partition("\x1f")
        out += [(h, m) for m in re.findall(r"This reverts commit ([0-9a-f]{7,40})", msg)]
    return out

def _branch(clone, sha, pr):
    if _git(clone, "rev-parse", "--verify", "--quiet", sha + "^2").returncode == 0:
        return _git(clone, "rev-list", sha + "^1.." + sha + "^2", "--").stdout.decode().split()
    return [c for c in (pr or {}).get("commits") or [] if c != sha]

def _facts(clone, sha, S, state, pr=None):
    if not sha or not S:
        return {"on_S": None, "reverted_by": [], "patch_equivalent_on_S": None}
    if not _has(clone, sha):
        state["complete"] = False
        return {"on_S": False, "reverted_by": [], "patch_equivalent_on_S": None}
    a = _git(clone, "merge-base", "--is-ancestor", sha, S)
    if a.returncode not in (0, 1):
        raise EvidenceError("git merge-base")
    shas = [sha] + _branch(clone, sha, pr)
    rev = sorted({h for h, pre in _reverts(clone, S) for x in shas if x.startswith(pre)} - set(shas))
    pe = False
    if a.returncode == 1:
        ch = _git(clone, "cherry", S, sha, sha + "~1")
        pe = ch.returncode == 0 and ch.stdout.decode().startswith("-")
    return {"on_S": a.returncode == 0, "reverted_by": rev, "patch_equivalent_on_S": pe}

def jira_candidates(key, remote, clone, i_refs, S, all_prs, *, fold_bases):
    state = {"complete": True}
    out, folded, hits = [], set(), []
    for ref in i_refs:
        lg = _git(clone, "log", "--format=%H%x1f%B%x1e", "refs/remotes/origin/" + ref, "--")
        if lg.returncode:
            raise EvidenceError("git log " + ref)
        for rec in lg.stdout.decode().split("\x1e"):
            sha, _, msg = rec.strip("\n").partition("\x1f")
            if sha and sha not in [h for h, _ in hits] and _mentions(key, msg):
                hits.append((sha, msg))
    for p in sorted(all_prs, key=lambda p: p["number"]):
        if not _mentions(key, p["title"], p["head_ref"], p["body"]):
            continue
        sha = p["merge_sha"]
        f = _facts(clone, sha, S, state, p) if sha else {"on_S": None, "reverted_by": [], "patch_equivalent_on_S": None}
        fold = []
        if sha:
            folded.add(sha)
            if _has(clone, sha) and p["base"] in fold_bases:
                br = set(_branch(clone, sha, p))
                fold = [h for h, _ in hits if h in br]
                folded.update(fold)
        out.append(dict({"id": "pr:%d" % p["number"], "kind": "pr", "number": p["number"], "title": p["title"],
                         "state": p["state"], "base": p["base"], "merge_sha": sha, "folded_commits": fold}, **f))
    for sha, msg in hits:
        if sha not in folded:
            out.append(dict({"id": "c:" + sha, "kind": "commit", "sha": sha, "subject": msg.split("\n")[0],
                             "refs": []}, **_facts(clone, sha, S, state)))
    return out, state["complete"]
'''

CJ_WRAP = r'''
"""chore-jira.py 감싸개: 실물을 그대로 내보내고 read_binding이 아직 없으면 대역을 덧붙인다."""
import importlib.util
_spec = importlib.util.spec_from_file_location("chore_jira_real", %r)
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)
for _k in dir(_m):
    if not _k.startswith("__"):
        globals()[_k] = getattr(_m, _k)
DOUBLE_BINDING = not hasattr(_m, "read_binding")
if DOUBLE_BINDING:
    def read_binding(repos_md, remote):
        with open(repos_md, encoding="utf-8") as fh:
            for line in fh:
                cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
                if len(cells) < 4 or cells[2].lower() != remote.lower():
                    continue
                tok = dict(t.split("=", 1) for t in cells[3].split() if "=" in t)
                if "jira" not in tok:
                    return None
                site, _, project = tok["jira"].partition("/")
                wf, _, br = tok.get("deploy-proof", "").partition("@")
                return {"site": site, "project": project, "qa": tok.get("jira-qa"), "closed": tok.get("jira-closed"),
                        "hold": [h for h in tok.get("jira-hold", "").split(",") if h],
                        "proof_workflow": wf or None, "proof_branch": br or None}
        return None
'''

# ───────────────────────── 하네스 ─────────────────────────
CASES = []
W = FAKE = None
ENV = {}


def case(name):
    def deco(fn):
        CASES.append((name, fn))
        return fn
    return deco


def eq(got, want, what):
    if got != want:
        raise AssertionError("%s: got %r, want %r" % (what, got, want))


def has(text, part, what):
    if part not in text:
        raise AssertionError("%s: %r not in %r" % (what, part, text))


def sh(*cmd, cwd=None, env=None):
    p = subprocess.run([str(c) for c in cmd], cwd=cwd, capture_output=True, env=env or ENV, timeout=60)
    if p.returncode != 0:
        raise AssertionError("%s 실패: %s" % (" ".join(map(str, cmd[:3])), p.stderr.decode()[:300]))
    return p.stdout.decode().strip()


def run_judge(*args, stdin=b"", env=None, script=JUDGE, preexec=None):
    e = dict(ENV)
    e.update(env or {})
    p = subprocess.run([sys.executable, "-I", str(script)] + [str(a) for a in args], input=stdin,
                       capture_output=True, env=e, timeout=120, preexec_fn=preexec)
    out, err = p.stdout.decode("utf-8"), p.stderr.decode("utf-8")
    for bad in (JT.TOKEN, JT.PAIR, MV.TOKEN):
        if bad in out or bad in err:
            raise AssertionError("토큰 노출: %r" % err)
    if err.count("\n") > 1 or (err and not err.endswith("\n")):
        raise AssertionError("stderr가 한 줄이 아님: %r" % err)
    return p.returncode, out, err


# ───────────────────────── git · gh 고정물 ─────────────────────────

def make_git(root):
    """origin(bare) + clone. develop: c0 → (feat/login p1, merge m12 'PR #12') → c1 'TST-1 …'.
    deploy/staging = develop, deploy/stage2 = main = c0."""
    root.mkdir(parents=True)
    bare, seed, clone = root / "origin.git", root / "seed", root / "clone"
    sh("git", "init", "-q", "--bare", "-b", "develop", bare)
    sh("git", "init", "-q", "-b", "develop", seed)
    (seed / "src").mkdir()
    (seed / "src" / "old.ts").write_text("old\n")
    (seed / "README.md").write_text("readme\n")
    sh("git", "-C", seed, "add", "-A")
    sh("git", "-C", seed, "commit", "-q", "-m", "init")
    c0 = sh("git", "-C", seed, "rev-parse", "HEAD")
    sh("git", "-C", seed, "checkout", "-q", "-b", "feat/login")
    (seed / "login.ts").write_text("login\n")
    sh("git", "-C", seed, "add", "-A")
    sh("git", "-C", seed, "commit", "-q", "-m", "로그인 검증 추가")
    p1 = sh("git", "-C", seed, "rev-parse", "HEAD")
    sh("git", "-C", seed, "checkout", "-q", "develop")
    sh("git", "-C", seed, "merge", "-q", "--no-ff", "feat/login", "-m", "Merge pull request #12 from test/feat/login")
    m12 = sh("git", "-C", seed, "rev-parse", "HEAD")
    (seed / "err.txt").write_text("오류 문구\n")
    sh("git", "-C", seed, "add", "-A")
    sh("git", "-C", seed, "commit", "-q", "-m", "TST-1 오류 문구 정리")
    c1 = sh("git", "-C", seed, "rev-parse", "HEAD")
    sh("git", "-C", seed, "remote", "add", "origin", bare)
    sh("git", "-C", seed, "push", "-q", "origin", "develop", "develop:refs/heads/deploy/staging",
       c0 + ":refs/heads/deploy/stage2", c0 + ":refs/heads/main")
    sh("git", "clone", "-q", bare, clone)
    return {"root": root, "bare": bare, "seed": seed, "clone": clone, "c0": c0, "p1": p1, "m12": m12, "c1": c1}


def seed_commit(g, msg, fname, branches=("develop", "deploy/staging")):
    (g["seed"] / fname).write_text(msg + "\n")
    sh("git", "-C", g["seed"], "add", "-A")
    sh("git", "-C", g["seed"], "commit", "-q", "-m", msg)
    head = sh("git", "-C", g["seed"], "rev-parse", "HEAD")
    sh("git", "-C", g["seed"], "push", "-q", "-f", "origin", *["HEAD:refs/heads/" + b for b in branches])
    return head


def pr(n, title, state, sha=None, head=None, body="", base="develop", head_oid=None):
    return {"number": n, "title": title, "headRefName": head or "feat/p%d" % n, "body": body, "state": state,
            "baseRefName": base, "mergeCommit": {"oid": sha} if sha else None, "headRefOid": head_oid or sha}


def gh_fix(d, g, prs=None, issues=None, runs=None):
    d.mkdir(parents=True, exist_ok=True)
    prs = prs if prs is not None else [
        pr(7, "오래된 실험", "OPEN", head_oid=g["c0"]), pr(12, "TST-1 로그인 폼 검증", "MERGED", g["m12"], "feat/login"),
        pr(13, "TST-1 다른 방식 시도", "CLOSED", head="feat/login-alt"), pr(120, "새 로그인 화면", "MERGED", "f" * 40),
        pr(121, "아직 열린 작업", "OPEN", head_oid=g["c0"]), pr(17, "자기만 인용한 PR", "OPEN", head_oid=g["c0"])]
    issues = issues if issues is not None else [{"number": 3, "state": "CLOSED", "title": "옛 이슈"},
                                                {"number": 19, "state": "OPEN", "title": "자기만 인용한 이슈"}]
    runs = runs if runs is not None else [{"headSha": g["c1"], "databaseId": 9000000001, "url": RUN_URL,
                                           "updatedAt": "2026-10-18T18:06:00Z"}]
    for name, obj in (("prs.json", prs), ("issues.json", issues), ("runs.json", runs)):
        (d / name).write_text(json.dumps(obj, ensure_ascii=False))
    (d / "gh.log").write_text("")
    return {"GH_FIX": str(d), "GH_LOG": str(d / "gh.log")}


# ───────────────────────── 계획 · 증거 · 판정 ─────────────────────────

def pr_row(n, updated, oid, title):
    snap = P.encode_snapshot({"state": "OPEN", "updated": updated, "head_repo": "test/repo", "head_ref": "feat/p%d" % n,
                              "head_oid": oid, "base": "develop", "author": "erin"})
    return b"\t".join([b"3", b"report", P.penc("pr#%d" % n), oid.encode(), snap, P.penc(title)])


def issue_row(n, updated, title):
    snap = P.encode_snapshot({"state": "OPEN", "updated": updated, "author": "frank"})
    return b"\t".join([b"3", b"report", P.penc("issue#%d" % n), updated.encode(), snap, P.penc(title)])


PASS_ROWS = [VALID_ROWS[1],    # 2 delete-remote feat/login-form (valid.tsv 2행 그대로)
             b"3\treport\tremote:feat/live-work\t-\t-\t" + P.penc("보호 브랜치라 남김 (feat/live-work)"),
             b"3\treport\t.\t-\t-\t" + P.penc("git worktree prune held (--no-local)")]


def pr_ev(n, title, complete=True, jira=()):
    return {"unit": "pr#%d" % n, "kind": "pr", "complete": complete, "incomplete": [] if complete else ["reviews"],
            "title": title, "updated": "2026-09-01T03:04:05Z",
            "pr": {"number": n, "title": title, "body": "", "author": "erin", "state": "OPEN", "base": "develop"},
            "cherry": {"commits": 1, "already_in_default": 0}, "behind_default": 3,
            "jira": [{"key": k, "status_name": s, "assignee": None, "last_comments": []} for k, s in jira],
            "later_merged_same_key": []}


def issue_ev(n, title, complete=True):
    return {"unit": "issue#%d" % n, "kind": "issue", "complete": complete, "incomplete": [], "title": title,
            "updated": "2026-08-01T00:00:00Z", "issue": {"number": n, "title": title, "labels": []},
            "timeline": [], "jira": [], "paths": []}


def jc_pr(n, state, sha=None, on_s=True, rev=(), pe=None, base="develop", folded=()):
    return {"id": "pr:%d" % n, "kind": "pr", "number": n, "title": "TST PR %d" % n, "state": state, "base": base,
            "merge_sha": sha, "on_S": on_s if state == "MERGED" else None, "reverted_by": list(rev),
            "patch_equivalent_on_S": pe, "folded_commits": list(folded)}


def jc_c(sha, on_s=True, rev=(), pe=None, refs=("develop",)):
    return {"id": "c:" + sha, "kind": "commit", "sha": sha, "subject": "TST 커밋", "refs": list(refs), "on_S": on_s,
            "reverted_by": list(rev), "patch_equivalent_on_S": pe}


def jira_ev(key, cands=(), status=("20002", "Waiting"), assignee=ME, transitions=None, excluded=None,
            complete=True, open_prs=(), deploy="default", created="2026-09-01T10:00:00.000+0900", creator=BOT,
            summary=None, links=(), prior=(), branches=(), other=()):
    return {"unit": "jira#" + key, "kind": "jira", "complete": complete, "incomplete": [] if complete else ["changelog"],
            "issue": {"id": str(50000 + int(key.split("-")[1])), "key": key, "project": key.split("-")[0],
                      "summary": summary or "%s 요약" % key, "description_text": "", "creator": creator,
                      "created": created, "updated": UPDATED, "status_id": status[0], "status_name": status[1],
                      "status_category": "new", "assignee": assignee, "labels": []},
            "comments": [], "changelog": [], "links": [{"type": "Relates", "direction": "outward", "key": k,
                                                        "status_name": "Done"} for k in links],
            "transitions": T_QA if transitions is None else transitions,
            "deploy": ({"workflow": "deploy-staging.yml", "branch": "deploy/staging", "S": "b" * 40, "run": 9000000001,
                        "run_url": RUN_URL, "completed": "2026-10-18T18:06:00Z"} if deploy == "default" else deploy),
            "candidates": list(cands), "open_pr_mentions": list(open_prs), "open_branches": list(branches),
            "other_repo_mentions": list(other), "prior_marker_comments": list(prior),
            "excluded": excluded}


def write_ev(d, units, binding=BINDING, total=None, judge=None, deploy="default", extra=None, ledgers=()):
    """units = [(unit json, judge?, why_not)]."""
    d.mkdir(parents=True)
    jira = [u for u, _, _ in units if u["kind"] == "jira"]
    index = {"repo": "repo", "remote": "test/repo", "run_id": RUN_ID, "created": "2026-10-19T00:00:00Z",
             "binding": binding, "account": ME, "default": "develop", "i_refs": list(HDR["I"]),
             "deploy": jira_ev("TST-0")["deploy"] if deploy == "default" else deploy, "stale_days": 30,
             "ledgers": list(ledgers),
             "units": [{"unit": u["unit"], "kind": u["kind"], "path_md": "x.md", "path_json": "x.json", "judge": j,
                        "why_not": w} for u, j, w in units],
             "inventory": {"pr": {"open": 0, "stale": 0, "recent": 0}, "issue": {"open": 0, "stale": 0, "recent": 0},
                           "jira": {"jql": JQL, "site": SITE, "total": len(jira) if total is None else total,
                                    "excluded": 0, "candidates": len(jira)}}}
    index.update(extra or {})
    (d / "index.json").write_text(json.dumps(index, ensure_ascii=False))
    for u, _, _ in units:
        kind, _, rest = u["unit"].partition("#")
        (d / ("%s-%s.json" % (kind, rest))).write_text(json.dumps(u, ensure_ascii=False))


def verdict(d, uid, **f):
    d.mkdir(parents=True, exist_ok=True)
    lines = ["UNIT: " + f.pop("UNIT", uid)]
    for k, v in f.items():
        for x in (v if isinstance(v, list) else [v]):
            lines.append("%s: %s" % (k, x))
    kind, _, rest = uid.partition("#")
    (d / ("%s-%s.txt" % (kind, rest))).write_text("\n".join(lines) + "\n", encoding="utf-8")


def plan_file(path, rows):
    path.write_bytes(HEADER + b"\n" + b"\n".join(rows) + b"\n")
    return path


def rows_by_ref(data):
    _, rows = P.parse_plan(data)
    return {(r["action"], r["ref"]): r for r in rows}


AMB = dict(KNOWN="아는 것", MISSING="모르는 것", OWNER="author:erin", DECIDER="작성자", RECOMMEND="물어보기")

# ───────────────────────── 큰 build 한 번 (B1) ─────────────────────────
B1 = {}
# 단위 → (기대 결과 class, MISSING/reason에 들어 있어야 할 글)
EXPECT = {}


def b1():
    if B1:
        return B1
    root = W / "b1"
    g = make_git(root / "git")
    g["st"] = seed_commit(g, "stage 핫픽스", "st.txt", branches=("deploy/stage2", "main"))
    sh("git", "-C", g["clone"], "fetch", "-q", "origin")
    env = gh_fix(root / "gh", g)
    a, c1, st = "a" * 40, g["c1"], g["st"]
    rows = [PASS_ROWS[0], pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "오래된 실험"),
            pr_row(8, "2026-10-10T00:00:00Z", "e" * 40, "새 기능 작업"), PASS_ROWS[1],
            pr_row(11, "2026-07-01T09:00:00Z", "1" * 40, "검색창 실험"),
            pr_row(14, "2026-07-02T09:00:00Z", "4" * 40, "근거가 틀린 PR"),
            pr_row(15, "2026-07-03T09:00:00Z", "5" * 40, "증거가 덜 모인 PR"),
            pr_row(16, "2026-07-04T09:00:00Z", "6" * 40, "근거 없는 PR"),
            pr_row(17, "2026-07-05T09:00:00Z", "7" * 40, "자기만 인용한 PR"),
            pr_row(18, "2026-07-06T09:00:00Z", "8" * 40, "안 합친 PR을 합쳤다고 인용"),
            pr_row(20, "2026-07-07T09:00:00Z", "9" * 40, "기본 브랜치에 없는 커밋 인용"),
            pr_row(25, "2026-07-08T09:00:00Z", "a" * 40, "없는 이슈 인용"),
            pr_row(26, "2026-07-09T09:00:00Z", "b" * 40, "없는 티켓 인용"),
            issue_row(9, "2026-08-01T00:00:00Z", "로그인 오류"), issue_row(10, "2026-09-20T00:00:00Z", "세션 문제"),
            issue_row(19, "2026-08-02T00:00:00Z", "자기만 인용한 이슈"),
            PASS_ROWS[2]]
    plan = plan_file(root / "plan.tsv", rows)
    vd = root / "verdicts"
    units = [(pr_ev(7, "오래된 실험", jira=[("TST-77", "Waiting")]), True, ""),
             (pr_ev(8, "새 기능 작업"), False, "최근 30일 안에 갱신 — 판정 제외"),
             (pr_ev(11, "검색창 실험"), True, ""), (pr_ev(14, "근거가 틀린 PR"), True, ""),
             (pr_ev(15, "증거가 덜 모인 PR", complete=False), True, ""), (pr_ev(16, "근거 없는 PR"), True, ""),
             (pr_ev(17, "자기만 인용한 PR"), True, ""), (pr_ev(18, "안 합친 PR을 합쳤다고 인용"), True, ""),
             (pr_ev(20, "기본 브랜치에 없는 커밋 인용"), True, ""), (pr_ev(25, "없는 이슈 인용"), True, ""),
             (pr_ev(26, "없는 티켓 인용"), True, ""),
             (issue_ev(9, "로그인 오류"), True, ""), (issue_ev(10, "세션 문제"), True, ""),
             (issue_ev(19, "자기만 인용한 이슈"), True, "")]
    verdict(vd, "pr#7", VERDICT="CLOSE", REASON="새 로그인 화면 PR #120이 같은 일을 이미 끝냈습니다", CITES="pr:120:merged")
    verdict(vd, "pr#11", VERDICT="AMBIGUOUS", REASON="실험을 계속하는지 알 수 없습니다", CITES="pr:11", **AMB)
    verdict(vd, "pr#14", VERDICT="CLOSE", REASON="대체됨", CITES="pr:99, path:src/old.ts:absent, c:deadbeefdead")
    verdict(vd, "pr#15", VERDICT="CLOSE", REASON="대체됨", CITES="pr:120")
    verdict(vd, "pr#16", VERDICT="CLOSE", REASON="대체됨", CITES="")
    verdict(vd, "pr#17", VERDICT="CLOSE", REASON="대체됨", CITES="pr:17")
    verdict(vd, "pr#18", VERDICT="CLOSE", REASON="대체됨", CITES="pr:121:merged")
    verdict(vd, "pr#20", VERDICT="CLOSE", REASON="대체됨", CITES="c:" + st[:12])
    verdict(vd, "pr#25", VERDICT="CLOSE", REASON="대체됨", CITES="issue:404")
    verdict(vd, "pr#26", VERDICT="CLOSE", REASON="대체됨", CITES="jira:TST-404")
    verdict(vd, "issue#9", VERDICT="CLOSE", REASON="PR #12로 고쳐졌습니다",
            CITES="pr:12:merged, c:%s, path:src/gone.ts:absent, jira:TST-2, issue:3" % c1[:12])
    verdict(vd, "issue#10", VERDICT="KEEP", REASON="재현 절차가 있고 아직 해결 PR이 없습니다", CITES="issue:10")
    verdict(vd, "issue#19", VERDICT="CLOSE", REASON="해결됨", CITES="issue:19")
    selfc = "닫는 근거 인용 없음 (자기 자신 인용은 근거가 아님)"
    # (결과, 글): 기계 확인이 만든 AMBIGUOUS는 글 == MISSING 전체(= 그 조건 하나만 실패), 그 밖은 글이 reason·known·missing에
    EXPECT.update({"pr#7": ("close-pr", ""), "pr#8": ("not-judged", "최근 30일"), "pr#11": ("ambiguous", "모르는 것"),
                   "pr#14": ("ambiguous", "확인 안 됨: PR #99; 기본 브랜치에 아직 있음: src/old.ts; "
                                          "확인 안 됨: 커밋 deadbeefdead 없음"),
                   "pr#15": ("ambiguous", "증거 수집이 끝나지 않음 (reviews)"),
                   "pr#16": ("ambiguous", "닫는 근거 인용 없음"), "pr#17": ("ambiguous", selfc),
                   "pr#18": ("ambiguous", "합쳐진 PR 아님: PR #121"),
                   "pr#20": ("ambiguous", "기본 브랜치에 없음: 커밋 " + st[:12]),
                   "pr#25": ("ambiguous", "확인 안 됨: 이슈 #404"), "pr#26": ("ambiguous", "확인 안 됨: TST-404"),
                   "issue#9": ("close-issue", ""), "issue#10": ("keep", "재현 절차"), "issue#19": ("ambiguous", selfc)})
    std_items = "pr:12=required, c:%s=required, pr:13=superseded" % c1[:12]
    std_reqs = ['"로그인 폼 입력값 검증" => pr:12', '"오류 문구 정리" => c:%s' % c1[:12]]
    std_cands = [jc_pr(12, "MERGED", g["m12"]), jc_c(c1), jc_pr(13, "CLOSED")]

    def jira(key, ev, cls, part, judge=True, **v):
        units.append((ev, judge, "" if judge else "보류"))
        if v:
            verdict(vd, "jira#" + key, **v)
        EXPECT["jira#" + key] = (cls, part)

    qa = dict(VERDICT="TO-QA", REASON="요구사항 두 줄이 모두 staging에 들어갔습니다", ITEMS=std_items, REQUIREMENTS=std_reqs,
              CITES="pr:12:merged, c:" + c1[:12])
    jira("TST-1", jira_ev("TST-1", std_cands, deploy={"workflow": "deploy-staging.yml", "branch": "deploy/staging",
                                                      "S": c1, "run": "9000000001", "run_url": RUN_URL,
                                                      "completed": "2026-10-18T18:06:00Z"},
                          summary="로그인 폼 검증, 오류 문구 정리"), "to-qa", "", **qa)
    one = [jc_pr(12, "MERGED", a)]
    one_v = dict(VERDICT="TO-QA", REASON="반영됨", ITEMS="pr:12=required", REQUIREMENTS=['"검증" => pr:12'],
                 CITES="pr:12:merged")
    dep = jira_ev("TST-0")["deploy"]
    jira("TST-18", jira_ev("TST-18", one, deploy=dict(dep, run_url=RUN_URL.replace("test/repo", "Test/Repo"))), "to-qa",
         "", **one_v)
    jira("TST-19", jira_ev("TST-19", one, deploy=dict(dep, run_url=RUN_URL.replace("test/repo", "other/repo"))),
         "ambiguous", "staging 배포 주소가 이 저장소의 그 실행이 아님", **one_v)
    jira("TST-3", jira_ev("TST-3", [jc_pr(12, "MERGED", a, on_s=False, pe=False)]), "keep",
         "staging 배포 대기 — 아직 staging 배포에 없음: PR #12", **one_v)
    jira("TST-4", jira_ev("TST-4", one + [jc_c(g["p1"], on_s=False, pe=False)]), "ambiguous",
         "합쳐졌지만 staging 배포에 없음: 커밋 " + g["p1"][:12],
         **dict(one_v, ITEMS="pr:12=required, c:%s=unrelated" % g["p1"][:12]))
    jira("TST-46", jira_ev("TST-46", one + [jc_c("d" * 40, on_s=False, pe=False)]), "ambiguous",
         "합쳐졌지만 staging 배포에 없음: 커밋 dddddddddddd", **dict(one_v, ITEMS="pr:12=required, c:dddddddddddd=unrelated"))
    promo = [jc_pr(60, "MERGED", "6" * 40, on_s=False, pe=False, base="deploy/stage2")]
    stc = [jc_c(st, on_s=False, pe=False, refs=("deploy/stage2", "main"))]
    sv = dict(one_v, ITEMS="pr:12=required, pr:60=unrelated, c:%s=unrelated" % st[:12])
    jira("TST-35", jira_ev("TST-35", one + promo + stc), "to-qa", "", **sv)
    jira("TST-36", jira_ev("TST-36", one + promo + stc), "ambiguous", "아직 반영 안 된 요구사항: 문서",
         **dict(sv, REQUIREMENTS=['"검증" => pr:12', '"문서" => UNMET']))
    jira("TST-37", jira_ev("TST-37", one + [jc_pr(61, "MERGED", "7" * 40, on_s=False, pe=False, base="deploy/staging")]),
         "ambiguous", "합쳐졌지만 staging 배포에 없음: PR #61", **dict(one_v, ITEMS="pr:12=required, pr:61=unrelated"))
    jira("TST-38", jira_ev("TST-38", one + stc), "keep", "staging 배포 대기 — 아직 staging 배포에 없음: 커밋 " + st[:12],
         **dict(one_v, ITEMS="pr:12=required, c:%s=required" % st[:12],
                REQUIREMENTS=['"검증" => pr:12', '"핫픽스" => c:%s' % st[:12]]))
    jira("TST-39", jira_ev("TST-39", [jc_pr(60, "MERGED", "6" * 40, base="deploy/stage2")]), "ambiguous",
         "다른 브랜치로 합쳐진 PR이 필요한 변경으로 표시됨: PR #60(deploy/stage2)",
         **dict(one_v, ITEMS="pr:60=required", REQUIREMENTS=['"검증" => pr:60']))
    jira("TST-45", jira_ev("TST-45", [jc_pr(12, "MERGED", g["m12"], folded=[g["p1"]])]), "to-qa", "", **one_v)
    jira("TST-5", jira_ev("TST-5", [jc_c("e" * 40, on_s=False, pe=True)]), "ambiguous",
         "체리픽으로만 들어감: 커밋 eeeeeeeeeeee",
         **dict(one_v, ITEMS="c:eeeeeeeeeeee=required", REQUIREMENTS=['"검증" => c:eeeeeeeeeeee']))
    # [E] 모양: 병합 커밋은 staging에 있고(on_S 참), 그 PR 브랜치 안의 커밋을 되돌린 커밋이 reverted_by에 들어 있음
    jira("TST-6", jira_ev("TST-6", [jc_pr(12, "MERGED", g["m12"], rev=["9" * 40], folded=[g["p1"]])]), "ambiguous",
         "staging 배포에서 되돌려진 변경: PR #12", **one_v)
    jira("TST-7", jira_ev("TST-7", one), "ambiguous", "아직 반영 안 된 요구사항: 비밀번호 재설정",
         **dict(one_v, REQUIREMENTS=['"검증" => pr:12', '"비밀번호 재설정" => UNMET']))
    jira("TST-8", jira_ev("TST-8", one + [jc_pr(13, "CLOSED")]), "ambiguous",
         "필요한 변경으로 표시된 PR·커밋에 연결 안 된 요구사항: 다른 방식",
         **dict(one_v, ITEMS="pr:12=required, pr:13=superseded", REQUIREMENTS=['"검증" => pr:12', '"다른 방식" => pr:13']))
    jira("TST-9", jira_ev("TST-9", one + [jc_pr(13, "CLOSED")]), "ambiguous",
         "합쳐지지 않은 PR이 필요한 변경으로 표시됨: PR #13", **dict(one_v, ITEMS="pr:12=required, pr:13=required"))
    jira("TST-10", jira_ev("TST-10", one, open_prs=[30]), "ambiguous", "이 티켓을 언급하는 열린 PR: PR #30", **one_v)
    jira("TST-11", jira_ev("TST-11", one, complete=False), "ambiguous", "증거 수집이 끝나지 않음 (changelog)", **one_v)
    jira("TST-12", jira_ev("TST-12", one, transitions=T_QA[1:]), "ambiguous", "QA로 가는 전환이 없음", **one_v)
    jira("TST-13", jira_ev("TST-13", one, status=(HOLD, "Done (staging)")), "ambiguous", "보류 상태: Done (staging)", **one_v)
    jira("TST-14", jira_ev("TST-14", one), "ambiguous", "요구사항 목록 없음", **dict(one_v, REQUIREMENTS=[]))
    jira("TST-16", jira_ev("TST-16", one, assignee=OTHER), "ambiguous", "담당자가 내가 아님", **one_v)
    jira("TST-15", jira_ev("TST-15", one, status=(QA, "QA (staging)")), "ambiguous", "이미 목표 상태", **one_v)
    jira("TST-17", jira_ev("TST-17", one + [jc_pr(18, "MERGED", "7" * 40, on_s=None)]), "ambiguous",
         "staging 배포 포함 여부를 모름: PR #18", **dict(one_v, ITEMS="pr:12=required, pr:18=unrelated"))
    jira("TST-49", jira_ev("TST-49", one, deploy=None), "ambiguous", "staging 배포 성공 기록 없음", **one_v)
    jira("TST-101", jira_ev("TST-101", one), "ambiguous", "옮기는 근거 인용 없음", **dict(one_v, CITES=""))
    jira("TST-102", jira_ev("TST-102", one), "ambiguous", "확인 안 됨: PR #99", **dict(one_v, CITES="pr:99"))
    jira("TST-108", jira_ev("TST-108", one, deploy=dict(dep, stale=True, stale_reason="최근 실행 9000000002가 진행 중")),
         "ambiguous", "staging 배포 기준을 확정 못 함: 최근 실행 9000000002가 진행 중", **one_v)
    cl = dict(VERDICT="TO-CLOSED", REASON="TST-20과 같은 작업입니다", CLOSE_BASIS="duplicate:TST-20", CITES="jira:TST-20")
    jira("TST-2", jira_ev("TST-2"), "to-closed", "", **cl)
    jira("TST-109", jira_ev("TST-109", deploy=None), "to-closed", "", **cl)
    jira("TST-21", jira_ev("TST-21"), "ambiguous", "근거 티켓 없음: TST-404", **dict(cl, CLOSE_BASIS="duplicate:TST-404"))
    jira("TST-22", jira_ev("TST-22"), "ambiguous", "근거 티켓이 이 티켓 자신임", **dict(cl, CLOSE_BASIS="duplicate:TST-22"))
    jira("TST-23", jira_ev("TST-23"), "ambiguous", "중복 근거 티켓이 다른 프로젝트: OTH-1",
         **dict(cl, CLOSE_BASIS="duplicate:OTH-1"))
    jira("TST-112", jira_ev("TST-112"), "ambiguous", "중복 근거 티켓이 다른 프로젝트: TST-61",
         **dict(cl, CLOSE_BASIS="duplicate:TST-61"))
    jira("TST-24", jira_ev("TST-24"), "ambiguous", "중복 근거 티켓도 이번 계획에서 닫힘: TST-25",
         **dict(cl, CLOSE_BASIS="duplicate:TST-25"))
    jira("TST-25", jira_ev("TST-25"), "ambiguous", "중복 근거 티켓도 이번 계획에서 닫힘: TST-24",
         **dict(cl, CLOSE_BASIS="duplicate:TST-24"))
    jira("TST-103", jira_ev("TST-103"), "ambiguous", "닫는 근거 인용 없음", **dict(cl, CITES=""))
    jira("TST-104", jira_ev("TST-104"), "ambiguous", selfc, **dict(cl, CITES="jira:TST-104"))
    jira("TST-105", jira_ev("TST-105", open_prs=[30]), "ambiguous", "이 티켓을 언급하는 열린 PR: PR #30", **cl)
    jira("TST-106", jira_ev("TST-106", one), "ambiguous", "이 티켓의 작업으로 보임 — QA 경로로 판단",
         **dict(cl, ITEMS="pr:12=required"))
    jira("TST-111", jira_ev("TST-111", status=(HOLD, "Done (staging)")), "ambiguous", "보류 상태: Done (staging)", **cl)
    jira("TST-113", jira_ev("TST-113"), "ambiguous", "확인 안 됨: PR #99", **dict(cl, CITES="pr:99"))
    jira("TST-114", jira_ev("TST-114", branches=["feat/TST-114-x"]), "ambiguous",
         "이 티켓 이름의 브랜치가 진행 중: feat/TST-114-x", **cl)
    jira("TST-115", jira_ev("TST-115", one, other=[{"repo": "org/web", "number": 5, "state": "OPEN", "title": "x"}]),
         "ambiguous", "다른 저장소에도 이 티켓 작업이 있음: org/web#5", **one_v)
    sup = dict(VERDICT="TO-CLOSED", REASON="새 티켓이 이 일을 이어받았습니다", CITES="pr:120:merged")
    jira("TST-107", jira_ev("TST-107", [jc_pr(12, "MERGED", a)]), "ambiguous", "이 티켓의 작업으로 보임 — QA 경로로 판단",
         **dict(sup, CLOSE_BASIS="superseded:pr:12", ITEMS="pr:12=unrelated"))
    jira("TST-26", jira_ev("TST-26", links=["TST-50"]), "to-closed", "", **dict(sup, CLOSE_BASIS="superseded:TST-50"))
    jira("TST-27", jira_ev("TST-27", links=["TST-51"]), "ambiguous", "대체 티켓이 더 먼저 만들어졌고 아직 끝나지 않음: TST-51",
         **dict(sup, CLOSE_BASIS="superseded:TST-51"))
    jira("TST-28", jira_ev("TST-28"), "ambiguous", "대체 티켓과 잇는 링크가 없고 같은 작성자의 같은 제목도 아님: TST-52",
         **dict(sup, CLOSE_BASIS="superseded:TST-52"))
    jira("TST-29", jira_ev("TST-29", summary="[Security Daily] 2026-09-01 점검 결과"), "to-closed", "",
         **dict(sup, CLOSE_BASIS="superseded:TST-53"))
    jira("TST-30", jira_ev("TST-30"), "to-closed", "", **dict(sup, CLOSE_BASIS="superseded:pr:120"))
    jira("TST-31", jira_ev("TST-31"), "ambiguous", "근거 PR이 합쳐지지 않음: PR #121",
         **dict(sup, CLOSE_BASIS="superseded:pr:121"))
    jira("TST-32", jira_ev("TST-32", status=("20001", "In Progress")), "ambiguous",
         "진행·리뷰 중인 티켓은 닫지 않음: In Progress", **cl)
    jira("TST-33", jira_ev("TST-33", status=("20003", "review")), "ambiguous", "진행·리뷰 중인 티켓은 닫지 않음: review",
         **cl)
    jira("TST-34", jira_ev("TST-34", transitions=[T_QA[0]]), "ambiguous", "닫기(Closed)로 가는 전환이 없음", **cl)
    jira("TST-47", jira_ev("TST-47", complete=False), "ambiguous", "이 티켓에 연결된 변경 목록을 끝까지 읽지 못함", **cl)
    jira("TST-40", jira_ev("TST-40", status=(HOLD, "Done (staging)"), excluded={"code": "hold", "reason": "QA 진행 중 — 손대지 않음"}),
         "excluded", "QA 진행 중", judge=False)
    jira("TST-41", jira_ev("TST-41", excluded={"code": "ledger", "reason": "다른 작업(app-rtw)에서 진행 중인 티켓"}),
         "excluded", "다른 작업", judge=False, VERDICT="TO-CLOSED", REASON="무시돼야 함", CLOSE_BASIS="duplicate:TST-20")
    jira("TST-110", jira_ev("TST-110", excluded={"code": "other-repo", "reason": "다른 저장소(app-web)에서 진행 중인 작업"}),
         "excluded", "다른 저장소(app-web)에서 진행 중인 작업", judge=False)
    jira("TST-42", jira_ev("TST-42", excluded={"code": "prior-marker", "reason": "이전 정리 댓글"}, prior=["777"]),
         "ambiguous", "이전 정리 댓글 있음 — 그 결론을 확인하고 다음 계획에서 다시 판단", judge=False)
    jira("TST-43", jira_ev("TST-43"), "keep", "아직 작업 중", VERDICT="KEEP", REASON="아직 작업 중입니다")
    jira("TST-44", jira_ev("TST-44"), "ambiguous", "모르는 것", VERDICT="AMBIGUOUS", REASON="판단 어려움", **AMB)
    (root / "ledgers").mkdir()
    (root / "ledgers" / "work.jsonl").write_text('{"key": "OTH-9", "status": "다른 프로젝트"}\n')
    write_ev(root / "ev", units, ledgers=[str((root / "ledgers" / "work.jsonl").resolve())])
    out = root / "final.tsv"
    rc, so, se = run_judge("build", "--plan", plan, "--ev", root / "ev", "--verdicts", vd, "--out", out,
                           "--date", DATE, "--clone", g["clone"], env=env)
    B1.update(root=root, g=g, env=env, plan=plan, rows=rows, out=out, rc=rc, so=so, se=se, ev=root / "ev", vd=vd,
              data=out.read_bytes() if out.exists() else b"")
    return B1


NOT_GATED = ("pr#8", "pr#11", "issue#10", "jira#TST-40", "jira#TST-41", "jira#TST-42", "jira#TST-43", "jira#TST-44",
             "jira#TST-110")


def setup_fake():
    f = FAKE
    f.reset()
    for key, kw in (("TST-2", {}), ("TST-20", {}), ("OTH-1", {}), ("TST-24", {}), ("TST-25", {}), ("TST-104", {}),
                    ("TST-61", {"project": "OTH"}),
                    ("TST-50", {"created": "2026-10-10T10:00:00.000+0900"}),
                    ("TST-51", {"created": "2026-08-01T10:00:00.000+0900",
                                "status": {"id": "20001", "name": "In Progress",
                                           "statusCategory": {"key": "indeterminate"}}}),
                    ("TST-52", {"created": "2026-10-10T10:00:00.000+0900", "creator": OTHER, "summary": "다른 일"}),
                    ("TST-53", {"created": "2026-08-01T10:00:00.000+0900", "creator": BOT,
                                "summary": "[Security Daily] 2026-10-15 점검 결과",
                                "status": {"id": "10002", "name": "Done", "statusCategory": {"key": "done"}}})):
        f.add_issue(key, **kw)


# ───────────────────────── build 사례 ─────────────────────────

@case("B1 build exit 0, stderr 없음")
def _():
    b = b1()
    eq((b["rc"], b["se"]), (0, ""), "rc/stderr")


@case("B1 stdout = 분류별 개수 줄 + 출력 sha256")
def _():
    b = b1()
    counts = {k: 0 for k in ("close-pr", "close-issue", "to-qa", "to-closed", "keep", "ambiguous", "not-judged",
                             "excluded")}
    for cls, _ in EXPECT.values():
        counts[cls] += 1
    down = sum(1 for u, (cls, _) in EXPECT.items() if u not in NOT_GATED
               and cls not in ("close-pr", "close-issue", "to-qa", "to-closed"))
    want = ("build: " + " ".join("%s=%d" % kv for kv in counts.items()) + " gate-downgraded=%d held=0 move-issue=0\n"
            % down + "build: sha256=%s\n" % hashlib.sha256(b["data"]).hexdigest())
    eq(b["so"], want, "stdout")


@case("B1 머리 줄·건드리지 않는 행 바이트 그대로, 입력 순서 유지, CLOSE는 그 자리에서 바뀜")
def _():
    b = b1()
    out = b["data"].split(b"\n")
    eq(out[0], HEADER, "header")
    n = len(b["rows"])
    for i, raw in enumerate(b["rows"]):
        got = out[i + 1]
        if raw in PASS_ROWS:
            eq(got, raw, "pass-through line %d" % (i + 2))
            continue
        cols, gcols = raw.split(b"\t"), got.split(b"\t")
        eq(gcols[2:4], cols[2:4], "ref/expected line %d" % (i + 2))
        tail = b";title=" if gcols[0] == b"2" else b";verdict="
        eq(gcols[4][:len(cols[4]) + len(tail)], cols[4] + tail, "engine snapshot + %r last, line %d" % (tail, i + 2))
    nj = sum(1 for u in EXPECT if u.startswith("jira#"))
    eq(len(out), 1 + n + nj + 1 + 1, "line count (header + rows + jira rows + inventory + final newline)")
    at = lambda ref: next(i for i, l in enumerate(b["rows"]) if l.split(b"\t")[2] == ref.encode()) + 1
    eq(out[at("pr#7")].split(b"\t")[:3], [b"2", b"close-pr", b"pr#7"], "pr#7 replaced in place")
    eq(out[at("issue#9")].split(b"\t")[:3], [b"2", b"close-issue", b"issue#9"], "issue#9 replaced in place")


@case("B1 출력 = parse_plan + check_jira_binding 통과, inventory = jira#KEY 행 수")
def _():
    b = b1()
    _, rows = P.parse_plan(b["data"])
    P.check_jira_binding(rows, SITE, PROJECT, QA, CLOSED)
    keys = [r for r in rows if r.get("jira") and r["jira"]["kind"] != "inventory"]
    inv = [r for r in rows if r.get("jira") and r["jira"]["kind"] == "inventory"]
    eq((len(inv), inv[0]["jira"]["total"], inv[0]["jira"]["jql"], inv[0]["jira"]["site"]),
       (1, len(keys), JQL, SITE), "inventory")
    eq(inv[0] is rows[-1], True, "inventory is last")
    t2 = [r["ref"] for r in rows if r["action"] == "jira-transition"]
    t3 = [r["ref"] for r in rows if r.get("jira") and r["jira"]["kind"] == "unit"]
    order = lambda refs: sorted(refs, key=lambda x: int(x.rsplit("-", 1)[1]))
    eq((t2, t3), (order(t2), order(t3)), "jira rows in key order")
    eq(rows.index(next(r for r in rows if r["action"] == "jira-transition")) <
       rows.index(next(r for r in rows if r.get("jira") and r["jira"]["kind"] == "unit")), True, "tier2 before tier3")


@case("B1 모든 단위가 기대한 결과·문구 (게이트마다 하나)")
def _():
    rows = rows_by_ref(b1()["data"])
    errs = []
    for uid, (cls, part) in EXPECT.items():
        if cls in ("close-pr", "close-issue"):
            ok = (cls, uid) in rows
            text = ""
        elif cls in ("to-qa", "to-closed"):
            r = rows.get(("jira-transition", uid))
            ok = r is not None and r["jira"]["level"] == cls.upper()
            text = ""
        else:
            r = rows.get(("report", uid))
            ev = (r or {}).get("jira", {}).get("evidence") if uid.startswith("jira#") else \
                ((r or {}).get("unit") or {}).get("evidence")
            ok = ev is not None and ev["v"] == cls.upper()
            text = " ".join(str(ev.get(k)) for k in ("reason", "known", "missing")) if ev else ""
            if ok and uid not in NOT_GATED:          # 기계 확인이 만든 결과 = 그 조건 하나만 실패
                ok = (ev["missing"] if cls == "ambiguous" else ev["reason"]) == part
                text = ev["missing"] if cls == "ambiguous" else ev["reason"]
        if not ok or part not in text:
            errs.append("%s: want %s %r, got %r" % (uid, cls, part, text or rows.get(("report", uid))))
    if errs:
        raise AssertionError("; ".join(errs))


@case("B1 CLOSE pr 댓글 = S1 문구 (마지막 갱신 날짜 + 작업 티켓)")
def _():
    r = rows_by_ref(b1()["data"])[("close-pr", "pr#7")]
    eq(r["evidence"], "저장소 정리 중 열린 PR을 하나씩 확인했습니다. 새 로그인 화면 PR #120이 같은 일을 이미 끝냈습니다. "
                      "이 PR의 마지막 갱신은 2026-09-01입니다 (작업 티켓 TST-77: Waiting). 필요하면 다시 열어 주세요. "
                      "브랜치는 지우지 않고 그대로 둡니다.", "comment")
    eq(r["snapshot"]["head_oid"], "c" * 40, "snapshot kept")
    eq((r["title"], list(r["snapshot"])[-1]), ("오래된 실험", "title"), "title last")


@case("B1 CLOSE issue 댓글 = S2 문구 (근거를 쉬운 말로)")
def _():
    b = b1()
    r = rows_by_ref(b["data"])[("close-issue", "issue#9")]
    eq(r["evidence"], "저장소 정리 중 열린 이슈를 하나씩 확인했습니다. PR #12로 고쳐졌습니다. 근거: PR #12(합쳐짐), "
                      "커밋 %s, src/gone.ts 파일이 기본 브랜치에 없음, TST-2, 이슈 #3. 마지막 갱신은 2026-08-01입니다. "
                      "필요하면 다시 열어 주세요." % b["g"]["c1"][:12], "comment")
    eq(r["expected"], "2026-08-01T00:00:00Z", "expected kept")


@case("B1 확인 안 되는 근거 → AMBIGUOUS, MISSING에 실패한 근거마다")
def _():
    ev = rows_by_ref(b1()["data"])[("report", "pr#14")]["unit"]["evidence"]
    for part in ("확인 안 됨: PR #99", "기본 브랜치에 아직 있음: src/old.ts", "커밋 deadbeefdead 없음"):
        has(ev["missing"], part, "missing")
    eq((ev["owner"], ev["t"]), ("me", "근거가 틀린 PR"), "owner/title")
    has(ev["known"], "판정 의견: 대체됨", "known")
    has(ev["reason"], "닫기", "reason")


@case("B1 KEEP / AMBIGUOUS / NOT-JUDGED 구조형 행 왕복")
def _():
    rows = rows_by_ref(b1()["data"])
    k = rows[("report", "issue#10")]["unit"]["evidence"]
    eq((k["t"], k["v"], k["reason"], k["cites"], k["complete"]),
       ("세션 문제", "KEEP", "재현 절차가 있고 아직 해결 PR이 없습니다", "issue:10", "yes"), "keep")
    a = rows[("report", "pr#11")]["unit"]["evidence"]
    eq({x: a[x] for x in ("v", "known", "missing", "owner", "decider", "recommend")},
       {"v": "AMBIGUOUS", "known": "아는 것", "missing": "모르는 것", "owner": "author:erin", "decider": "작성자",
        "recommend": "물어보기"}, "ambiguous")
    n = rows[("report", "pr#8")]["unit"]["evidence"]
    eq((n["t"], n["v"], n["reason"]), ("새 기능 작업", "NOT-JUDGED", "최근 30일 안에 갱신 — 판정 제외"), "not-judged")
    eq(rows[("report", "pr#8")]["snapshot"]["updated"], "2026-10-10T00:00:00Z", "snapshot kept")
    eq([(rows[("report", k)]["snapshot"]["verdict"], list(rows[("report", k)]["snapshot"])[-1])
        for k in ("issue#10", "pr#11", "pr#8")], [("KEEP", "verdict"), ("AMBIGUOUS", "verdict"),
                                                   ("NOT-JUDGED", "verdict")], "snapshot verdict = v, last")


@case("B1 TO-QA 행: check_jira_transition 통과, snapshot·items·reqs·댓글 정확")
def _():
    b = b1()
    g = b["g"]
    r = rows_by_ref(b["data"])[("jira-transition", "jira#TST-1")]
    s = r["snapshot"]
    eq(r["expected"], UPDATED, "expected")
    eq({k: s[k] for k in ("site", "project", "issue_id", "status", "status_name", "assignee", "account", "to",
                          "to_status", "to_name", "level", "S", "run", "run_url", "close_basis")},
       {"site": SITE, "project": PROJECT, "issue_id": "50001", "status": "20002", "status_name": "Waiting",
        "assignee": ME, "account": ME, "to": "31", "to_status": QA, "to_name": "QA (staging)", "level": "TO-QA",
        "S": g["c1"], "run": "9000000001", "run_url": RUN_URL, "close_basis": "-"}, "snapshot")
    eq(s["items"], "pr:12:MERGED:required:%s,c:%s:required,pr:13:CLOSED:superseded:-" % (g["m12"], g["c1"]), "items")
    eq(P.decode_reqs(s["reqs"]), [{"text": "로그인 폼 입력값 검증", "target": "pr:12"},
                                  {"text": "오류 문구 정리", "target": "c:" + g["c1"]}], "reqs")
    eq(s["summary"], "로그인 폼 검증, 오류 문구 정리", "summary")
    eq(r["evidence"], "저장소 정리 중 확인했습니다. 이 작업의 변경(PR #12(develop에 합쳐짐), 커밋 %s)은 staging 배포 %s"
                      "(한국 시각 2026-10-19 03:06)에 포함되어 있습니다. 그래서 QA (staging)로 옮깁니다. "
                      "요구사항 두 줄이 모두 staging에 들어갔습니다.\nchore 정리 → QA (staging) — by Claude triage 2026-10-19"
       % (g["c1"][:12], RUN_URL), "comment")


@case("B1 TO-CLOSED 행: 중복·대체(링크)·대체(같은 작성자+같은 제목)·대체 PR, 댓글 정확")
def _():
    rows = rows_by_ref(b1()["data"])
    r = rows[("jira-transition", "jira#TST-2")]
    eq((r["snapshot"]["to"], r["snapshot"]["to_status"], r["snapshot"]["close_basis"], r["snapshot"]["S"],
        r["snapshot"]["items"], r["snapshot"]["reqs"]), ("41", CLOSED, "duplicate:TST-20", "-", "-", "-"), "snapshot")
    eq(r["evidence"], "저장소 정리 중 확인했습니다. TST-20과 같은 작업입니다. 근거: TST-20. 그래서 닫습니다. "
                      "필요하면 다시 열어 주세요.\nchore 정리 → Closed — by Claude triage 2026-10-19", "comment")
    eq(rows[("jira-transition", "jira#TST-30")]["evidence"].split("\n")[0],
       "저장소 정리 중 확인했습니다. 새 티켓이 이 일을 이어받았습니다. 근거: PR #120. 그래서 닫습니다. 필요하면 다시 열어 주세요.",
       "pr basis comment")
    for k in ("jira#TST-26", "jira#TST-29"):
        eq(rows[("jira-transition", k)]["jira"]["level"], "TO-CLOSED", k)
    r18 = rows[("jira-transition", "jira#TST-18")]
    eq((r18["snapshot"]["run_url"], RUN_URL in r18["evidence"]), (RUN_URL, True), "run_url canonical (header remote)")


@case("B1 tier-3 jira#KEY 행: snapshot summary·status_name, 제외 사유, 이전 정리 댓글")
def _():
    rows = rows_by_ref(b1()["data"])
    r = rows[("report", "jira#TST-40")]
    eq((r["jira"]["summary"], r["jira"]["status_name"], r["jira"]["evidence"]["v"], r["jira"]["evidence"]["reason"]),
       ("TST-40 요약", "Done (staging)", "EXCLUDED", "QA 진행 중 — 손대지 않음"), "excluded")
    p = rows[("report", "jira#TST-42")]["jira"]["evidence"]
    eq((p["v"], p["owner"], p["reason"]), ("AMBIGUOUS", "me", "이전 정리 댓글 있음 — 그 결론을 확인하고 다음 계획에서 다시 판단"),
       "prior-marker")
    eq(rows[("report", "jira#TST-41")]["jira"]["evidence"]["v"], "EXCLUDED", "excluded verdict file ignored")
    k = rows[("report", "jira#TST-3")]["jira"]["evidence"]
    eq((k["v"], k["reason"]), ("KEEP", "staging 배포 대기 — 아직 staging 배포에 없음: PR #12"), "deploy wait")
    a = rows[("report", "jira#TST-27")]["jira"]["evidence"]
    eq(a["jira"], [{"key": "TST-51", "status": "Done"}], "links into jira=")


@case("B1 기계 확인이 만든 AMBIGUOUS: KNOWN의 '확인된 것'은 실제로 확인한 사실만, OWNER me, 고정 DECIDER/RECOMMEND")
def _():
    rows = rows_by_ref(b1()["data"])
    ev = lambda k: rows[("report", k)]["jira"]["evidence"]
    cp = ev("jira#TST-5")
    for wrong in ("필요한 변경 모두 staging 배포에 포함", "관련 변경 모두 staging 배포에 포함"):
        if wrong in cp["known"]:
            raise AssertionError("cherry-pick KNOWN claims %r: %r" % (wrong, cp["known"]))
    eq((cp["owner"], cp["decider"]), ("me", "staging 배포 담당"), "cherry-pick owner/decider")
    has(ev("jira#TST-12")["known"], "관련 변경 모두 staging 배포에 포함", "held S fact when S family passed")
    dup = ev("jira#TST-24")["known"]
    for wrong in ("대체 티켓", "근거 PR"):
        if wrong in dup:
            raise AssertionError("duplicate KNOWN lists an inapplicable check %r: %r" % (wrong, dup))
    has(dup, "근거 티켓 있음, 중복 근거가 같은 프로젝트", "duplicate held facts")
    has(ev("jira#TST-21")["known"], "판정 의견: TST-20과 같은 작업입니다", "known starts with the judge reason")
    for k in ("jira#TST-6", "jira#TST-49", "jira#TST-108"):          # 되돌림·배포 기록 실패 = S 사실 주장 금지
        if "관련 변경 모두 staging 배포에 포함" in ev(k)["known"]:
            raise AssertionError("%s KNOWN claims all changes are on staging: %r" % (k, ev(k)["known"]))
    k36 = ev("jira#TST-36")["known"]
    has(k36, "기본 브랜치에 없는 커밋 %s(deploy/stage2, main) — 배포 판단에서 제외" % b1()["g"]["st"][:12], "commit note")
    eq("배포 판단에서 제외" in ev("jira#TST-37")["known"], False, "staging-branch PR stays in the deploy check")


@case("B1 댓글 전부: check_comment_text + ADF 왕복 + Jira 표지가 MARKER·to_name과 맞음")
def _():
    _, rows = P.parse_plan(b1()["data"])
    n = 0
    for r in rows:
        if r["action"] in ("close-pr", "close-issue", "jira-transition"):
            t = r["evidence"]
            CJ.check_comment_text(t)
            eq(CJ.flatten(CJ.build_adf(t)), t, r["ref"] + " ADF")
            if r["action"] == "jira-transition":
                m = P.MARKER.fullmatch(t.split("\n")[-1])
                eq((bool(m), m and m.group(1), m and m.group(2)), (True, r["snapshot"]["to_name"], DATE), r["ref"])
            n += 1
    eq(n, sum(1 for c, _ in EXPECT.values() if c in ("close-pr", "close-issue", "to-qa", "to-closed")), "comment rows")


@case("B1 같은 입력 → 같은 바이트 (결정적)")
def _():
    b = b1()
    out2 = b["root"] / "final2.tsv"
    rc, so, _ = run_judge("build", "--plan", b["plan"], "--ev", b["ev"], "--verdicts", b["vd"], "--out", out2,
                          "--date", DATE, "--clone", b["g"]["clone"], env=b["env"])
    eq((rc, out2.read_bytes() == b["data"], so == b["so"]), (0, True, True), "rebuild")


def small(name, units, rows, verdicts, extra_args=(), binding=BINDING, total=None, deploy="default", clone=True,
          index_extra=None):
    root = W / name
    g = b1()["g"]
    env = gh_fix(root / "gh", g)
    plan = plan_file(root / "plan.tsv", rows) if not isinstance(rows, Path) else rows
    vd = root / "verdicts"
    vd.mkdir(parents=True)
    for uid, f in verdicts:
        verdict(vd, uid, **f)
    write_ev(root / "ev", units, binding=binding, total=total, deploy=deploy, extra=index_extra)
    out = root / "final.tsv"
    args = ["build", "--plan", plan, "--ev", root / "ev", "--verdicts", vd, "--out", out, "--date", DATE]
    if clone:
        args += ["--clone", g["clone"]]
    rc, so, se = run_judge(*(args + list(extra_args)), env=env)
    return rc, so, se, out


@case("B2 바인딩에 QA·배포 기준 없음 + 배포 기록 없음 → TO-QA는 AMBIGUOUS, MISSING에 둘 다(배포 이름 없음 → \"배포\")")
def _():
    b = dict(BINDING, qa=None, proof_workflow=None, proof_branch=None, proof_label=None)
    one = [jc_pr(12, "MERGED", "a" * 40)]
    rc, so, se, out = small("b2", [(jira_ev("TST-1", one, deploy=None), True, "")], [PASS_ROWS[0]],
                            [("jira#TST-1", dict(VERDICT="TO-QA", REASON="반영됨", ITEMS="pr:12=required",
                                                  REQUIREMENTS=['"검증" => pr:12']))], binding=b, deploy=None)
    eq((rc, se), (0, ""), "rc")
    ev = rows_by_ref(out.read_bytes())[("report", "jira#TST-1")]["jira"]["evidence"]
    has(ev["missing"], "저장소 등록부에 QA 상태 또는 배포 기준(deploy-proof)이 없음", "missing")
    has(ev["missing"], "배포 성공 기록 없음", "missing")
    eq("staging" in ev["missing"] or "배포 환경" in ev["missing"], False, "no label without deploy-proof")
    eq((ev["decider"], ev["owner"]), ("저장소 등록부 담당", "me"), "decider from first failing condition")


@case("B3 바인딩 없음 → Jira 행 없음, jira: 근거는 확인 안 됨")
def _():
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "t=가짜;v=KEEP 제목")]
    rc, so, se, out = small("b3", [(pr_ev(7, "t=가짜;v=KEEP 제목"), True, "")], rows,
                            [("pr#7", dict(VERDICT="CLOSE", REASON="대체됨", CITES="jira:TST-2"))], binding=None)
    eq((rc, se), (0, ""), "rc")
    data = out.read_bytes()
    eq(data.count(b"\n"), 2, "header + one row, no jira rows")
    ev = rows_by_ref(data)[("report", "pr#7")]["unit"]["evidence"]
    has(ev["missing"], "Jira 연결 없음", "missing")
    eq(ev["t"], "t=가짜;v=KEEP 제목", "a title that looks structured stays the title")
    has(so, "ambiguous=1 not-judged=0 excluded=0 gate-downgraded=1", "counts")


@case("B4 판정 파일 없음 → exit 1, 빠진 단위 전부 나열, 출력 파일 없음")
def _():
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A"), issue_row(9, "2026-08-01T00:00:00Z", "B")]
    units = [(pr_ev(7, "A"), True, ""), (issue_ev(9, "B"), True, ""), (jira_ev("TST-1"), True, "")]
    rc, so, se, out = small("b4", units, rows, [])
    eq((rc, so, out.exists()), (1, "", False), "rc/stdout/out")
    has(se, "판정 파일 없음 3건: pr#7, issue#9, jira#TST-1", "stderr")


@case("B4 --allow-missing → AMBIGUOUS '판정 누락' (고정 문구)")
def _():
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A")]
    rc, so, se, out = small("b4b", [(pr_ev(7, "A"), True, ""), (jira_ev("TST-1"), True, "")], rows, [],
                            extra_args=["--allow-missing"])
    eq((rc, se), (0, ""), "rc")
    rows = rows_by_ref(out.read_bytes())
    for ev in (rows[("report", "pr#7")]["unit"]["evidence"], rows[("report", "jira#TST-1")]["jira"]["evidence"]):
        eq({k: ev[k] for k in ("v", "reason", "known", "missing", "owner", "decider", "recommend")},
           {"v": "AMBIGUOUS", "reason": "판정 누락", "known": "판정 파일 없음", "missing": "판정", "owner": "me",
            "decider": "이 저장소 정리 담당", "recommend": "판정을 다시 돌린 뒤 다음 계획에서 처리"}, "fill")


@case("B5 형식 오류(모르는 필드·중복·UNIT 불일치·ITEMS 후보 빠짐) → exit 1, 전부 이유와 함께, --allow-missing도 같음")
def _():
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A"), pr_row(8, "2026-09-01T03:04:05Z", "d" * 40, "B"),
            issue_row(9, "2026-08-01T00:00:00Z", "C")]
    units = [(pr_ev(7, "A"), True, ""), (pr_ev(8, "B"), True, ""), (issue_ev(9, "C"), True, ""),
             (jira_ev("TST-1", [jc_pr(12, "MERGED", "a" * 40), jc_c("b" * 40)]), True, "")]
    vs = [("pr#7", dict(VERDICT="KEEP", REASON="x", NOTE="y")),
          ("issue#9", dict(VERDICT="KEEP", REASON="x", CITES=["issue:9", "issue:9"])),
          ("pr#8", dict(UNIT="pr#80", VERDICT="KEEP", REASON="x")),
          ("jira#TST-1", dict(VERDICT="KEEP", REASON="x", ITEMS="pr:12=required"))]
    for extra in ([], ["--allow-missing"]):
        rc, so, se, out = small("b5" + str(len(extra)), units, rows, vs, extra_args=extra)
        eq((rc, out.exists()), (1, False), "rc/out")
        for part in ("판정 형식 오류 4건", "pr#7 (알 수 없는 필드 NOTE)", "issue#9 (필드 CITES가 두 번)",
                     "pr#8 (UNIT 'pr#80' ≠ pr#8)", "jira#TST-1 (ITEMS에 후보 c:bbbbbbbbbbbb 빠짐)"):
            has(se, part, "stderr")


@case("B6 inventory 총수 ≠ Jira 단위 수 → exit 1, 출력 없음")
def _():
    rc, so, se, out = small("b6", [(jira_ev("TST-43"), True, "")], [PASS_ROWS[0]],
                            [("jira#TST-43", dict(VERDICT="KEEP", REASON="x"))], total=2)
    eq((rc, out.exists()), (1, False), "rc/out")
    has(se, "Jira 검색 총수 2 ≠ 증거의 Jira 단위 1개", "stderr")


@case("B7 계획과 증거가 어긋남(다른 run_id, 증거 없는 행) → exit 1")
def _():
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A")]
    rc, _, se, _ = small("b7", [(pr_ev(7, "A"), True, "")], rows, [("pr#7", dict(VERDICT="KEEP", REASON="x"))],
                         index_extra={"run_id": "20261019T000000Z-deadbeef"})
    eq(rc, 1, "rc")
    has(se, "증거가 다른 계획에서 나옴", "stderr")
    rc, _, se, _ = small("b7b", [], rows, [])
    eq(rc, 1, "rc")
    has(se, "증거에 없는 계획 행: pr#7", "stderr")


@case("B8 --clone 필수: 없으면 사용법 오류 exit 2, git 저장소가 아니면 exit 1")
def _():
    rows = [issue_row(9, "2026-08-01T00:00:00Z", "C")]
    vs = [("issue#9", dict(VERDICT="KEEP", REASON="x"))]
    rc, so, se, out = small("b8", [(issue_ev(9, "C"), True, "")], rows, vs, clone=False, binding=None)
    eq((rc, out.exists()), (2, False), "rc without --clone")
    has(se, "--clone", "stderr")
    rc, so, se, out = small("b8b", [(issue_ev(9, "C"), True, "")], rows, vs, clone=False, binding=None,
                            extra_args=["--clone", str(W)])
    eq((rc, out.exists()), (1, False), "rc with a non-git --clone")
    has(se, "--clone이 git 저장소가 아님", "stderr")


HEADER_NOJ = HEADER.replace(b"groups=feat/*,issues,jira,pull-requests", b"groups=feat/*,issues,pull-requests")


@case("B10 머리 줄 groups=: Jira 행이 있으면 jira를 더함(정렬 그대로), 없으면 입력과 바이트 같음")
def _():
    assert HEADER_NOJ != HEADER
    root = W / "b10"
    root.mkdir()
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A")]
    (root / "plan.tsv").write_bytes(HEADER_NOJ + b"\n" + b"\n".join(rows) + b"\n")
    rc, so, se, out = small("b10a", [(pr_ev(7, "A"), False, "최근"), (jira_ev("TST-43"), True, "")], root / "plan.tsv",
                            [("jira#TST-43", dict(VERDICT="KEEP", REASON="x"))])
    eq((rc, se), (0, ""), "rc")
    eq(out.read_bytes().split(b"\n", 1)[0], HEADER, "groups gains jira, nothing else changes")
    rc, so, se, out = small("b10b", [(pr_ev(7, "A"), False, "최근")], root / "plan.tsv", [], binding=None)
    eq((rc, se), (0, ""), "rc")
    eq(out.read_bytes().split(b"\n", 1)[0], HEADER_NOJ, "no jira rows: header byte-identical")


@case("B9 --out 폴더 없음 → exit 1 한 줄 (traceback 없음)")
def _():
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A")]
    root = W / "b9"
    plan = plan_file((root.mkdir() or root) / "plan.tsv", rows)
    write_ev(root / "ev", [(pr_ev(7, "A"), False, "최근")], binding=None)
    rc, so, se = run_judge("build", "--plan", plan, "--ev", root / "ev", "--verdicts", root, "--out",
                           root / "no-such-dir" / "final.tsv", "--date", DATE, "--clone", b1()["g"]["clone"])
    eq((rc, so), (1, ""), "rc")
    has(se, "chore-judge: build: 출력을 쓸 수 없음", "stderr")


# ───────────────────────── 판정 파일 문법 (모듈 직접) ─────────────────────────
J = None


def judge_mod():
    global J
    if J is None:
        for k in ("CHORE_JIRA_PY", "CHORE_EVIDENCE_PY"):
            if k in ENV:
                os.environ[k] = ENV[k]
        J = _load("chore_judge", JUDGE)
    return J


def bad_verdict(text, kind="jira", cands=()):
    try:
        judge_mod().parse_verdict(text, "jira#TST-1" if kind == "jira" else "pr#7", kind, list(cands))
    except judge_mod().Malformed as e:
        return str(e)
    return None


@case("V 문법: 거절 사례마다 이유 (AMBIGUOUS 필드·OWNER·ITEMS·sha 모호·CITES·Jira 전용 필드·줄 형식)")
def _():
    c2 = [jc_c("ab" + "1" * 38), jc_c("ab" + "1" * 10 + "2" * 28)]
    for text, kind, cands, want in (
            ("UNIT: pr#7\nVERDICT: AMBIGUOUS\nREASON: x\nKNOWN: a\n", "pr", (), "AMBIGUOUS인데 MISSING, OWNER"),
            ("UNIT: pr#7\nVERDICT: KEEP\nREASON: x\nOWNER: boss\n", "pr", (), "OWNER 'boss'"),
            ("UNIT: pr#7\nVERDICT: TO-QA\nREASON: x\n", "pr", (), "VERDICT 'TO-QA'"),
            ("UNIT: pr#7\nVERDICT: KEEP\nREASON: x\nITEMS: pr:1=required\n", "pr", (), "Jira 판정에만"),
            ("UNIT: pr#7\nVERDICT: KEEP\nREASON:\n", "pr", (), "REASON 없음"),
            ("UNIT: pr#7\nVERDICT: KEEP\nREASON: x\n이어지는 줄\n", "pr", (), "4번째 줄"),
            ("UNIT: pr#7\nVERDICT: CLOSE\nREASON: x\nCITES: PR #12\n", "pr", (), "CITES 요소 'PR #12'"),
            ("UNIT: jira#TST-1\nVERDICT: KEEP\nREASON: x\nITEMS: pr:9=required\n", "jira", (), "후보가 아님"),
            ("UNIT: jira#TST-1\nVERDICT: KEEP\nREASON: x\nITEMS: c:ab1111111111=required\n", "jira", c2, "2개와 맞음"),
            ("UNIT: jira#TST-1\nVERDICT: KEEP\nREASON: x\nITEMS: c:ab1111111111=maybe\n", "jira", c2, "형식 오류"),
            ("UNIT: jira#TST-1\nVERDICT: TO-CLOSED\nREASON: x\n", "jira", (), "CLOSE_BASIS 없음"),
            ("UNIT: jira#TST-1\nVERDICT: TO-CLOSED\nREASON: x\nCLOSE_BASIS: dup:TST-2\n", "jira", (), "CLOSE_BASIS"),
            ("UNIT: jira#TST-1\nVERDICT: TO-QA\nREASON: x\nREQUIREMENTS: 검증 => pr:1\n", "jira", (), "REQUIREMENTS"),
            ("UNIT: jira#TST-1\nVERDICT: CLOSE\nREASON: x\n", "jira", (), "VERDICT 'CLOSE'"),
            ("UNIT: jira#TST-1\nVERDICT: KEEP\nREASON: a\tb\n", "jira", (), "제어 문자"),
            ("UNIT: jira#TST-1\nVERDICT: KEEP\nREASON: x\nITEMS: pr:12=required, c:%s=required\n" % ("f" * 12), "jira",
             [jc_pr(12, "MERGED", "a" * 40, folded=["f" * 40])], "후보가 아님")):
        got = bad_verdict(text, kind, cands)
        if got is None or want not in got:
            raise AssertionError("%r → %r (want %r)" % (text, got, want))


@case("V 문법: 받는 사례 (CRLF·BOM·빈 줄·sha 접두 → 전체 id·여러 REQUIREMENTS)")
def _():
    sha = "ab" + "1" * 38
    t = ("﻿UNIT: jira#TST-1\r\nVERDICT: TO-QA\r\n\r\nREASON: 됨\r\nITEMS: pr:12=required , c:ab1111111111=required\r\n"
         'REQUIREMENTS: "가, 나 => 다" => c:ab1111111111\r\nREQUIREMENTS: "라" => pr:12\r\nCITES: pr:12:merged, path:a b/c.ts\r\n')
    v = judge_mod().parse_verdict(t, "jira#TST-1", "jira", [jc_pr(12, "MERGED", "a" * 40), jc_c(sha)])
    eq(v["roles"], {"pr:12": "required", "c:" + sha: "required"}, "roles")
    eq(v["reqs"], [{"text": "가, 나 => 다", "target": "c:" + sha}, {"text": "라", "target": "pr:12"}], "reqs")
    eq([c["raw"] for c in v["cites"]], ["pr:12:merged", "path:a b/c.ts"], "cites")


@case("T 조사 로/으로·한국 시각·문장 끝")
def _():
    j = judge_mod()
    eq([j.ro(w) for w in ("QA (staging)", "Closed", "완료", "검증", "준비 단계 3", "1")],
       ["로", "로", "로", "으로", "으로", "로"], "ro")
    eq(j.kst("2026-10-18T18:06:00Z").strftime("%Y-%m-%d %H:%M"), "2026-10-19 03:06", "kst")
    eq((j.sentence("끝났습니다"), j.sentence("끝났습니다.")), ("끝났습니다.", "끝났습니다."), "sentence")
    eq(j.norm_summary("[Security Daily] 2026-10-15 점검 3건"), "[Security Daily] 점검 건", "norm_summary")


# ───────────────────────── recheck ─────────────────────────

def repos_md(path, site=SITE, extra="", others=None, hold=HOLD):
    text = REPOS_MD % (site, QA, CLOSED, hold)
    if others:
        text = text.replace("deploy-proof=", "jira-repos=%s deploy-proof=" % others)
    path.write_text(text + extra, encoding="utf-8")
    return path


def qa_line(g, items=None, key="TST-1", ledgers=()):
    items = items or [{"kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": g["m12"]},
                      {"kind": "c", "pr": None, "state": None, "role": "required", "sha": g["c1"]},
                      {"kind": "pr", "pr": 13, "state": "CLOSED", "role": "superseded", "sha": None}]
    snap = {"site": SITE, "project": PROJECT, "issue_id": "10001", "status": "20002", "status_name": "Waiting",
            "assignee": ME, "account": ME, "to": "31", "to_status": QA, "to_name": "QA (staging)", "summary": "로그인",
            "level": "TO-QA", "S": g["c1"], "run": "9000000001", "run_url": RUN_URL, "items": P.encode_items(items),
            "reqs": P.encode_reqs([{"text": "검증", "target": "pr:12"}]), "close_basis": "-",
            "ledgers": P.encode_ledgers(list(ledgers))}
    text = "변경이 staging에 있습니다.\n" + P.MARKER_FMT % ("QA (staging)", DATE)
    return b"\t".join([b"2", b"jira-transition", P.penc("jira#" + key), UPDATED.encode(), P.encode_snapshot(snap),
                       P.penc(text)])


def closed_line(basis, key="TST-2", items=(), ledgers=(), status=("20002", "Waiting")):
    snap = {"site": SITE, "project": PROJECT, "issue_id": "10002", "status": status[0], "status_name": status[1],
            "assignee": ME, "account": ME, "to": "41", "to_status": CLOSED, "to_name": "Closed", "summary": "x",
            "level": "TO-CLOSED", "S": "-", "run": "-", "run_url": "-", "items": P.encode_items(list(items)),
            "reqs": "-", "close_basis": basis, "ledgers": P.encode_ledgers(list(ledgers))}
    text = "중복입니다.\n" + P.MARKER_FMT % ("Closed", DATE)
    return b"\t".join([b"2", b"jira-transition", P.penc("jira#" + key), UPDATED.encode(), P.encode_snapshot(snap),
                       P.penc(text)])


def recheck_env(name, prs_edit=None, runs=None):
    root = W / name
    g = make_git(root / "git")
    prs = [pr(12, "TST-1 로그인 폼 검증", "MERGED", g["m12"], "feat/login"),
           pr(13, "TST-1 다른 방식 시도", "CLOSED", head="feat/login-alt"),
           pr(7, "관계없는 PR", "OPEN", head_oid=g["c0"])]
    if prs_edit:
        prs = prs_edit(g, prs)
    env = gh_fix(root / "gh", g, prs=prs, runs=runs(g) if runs else None)
    return root, g, env


def recheck(root, g, env, line, md=None, stdin=None):
    md = md or repos_md(root / "repos.md")
    return run_judge("recheck", "--clone", g["clone"], "--remote", "test/repo", "--repos-md", md, "--repo", "repo",
                     stdin=stdin if stdin is not None else HEADER + b"\n" + line + b"\n", env=env)


def want10(res, part):
    rc, so, se = res
    eq((rc, se), (10, ""), "rc/stderr (stdout %r)" % so)
    eq(so.count("\n"), 1, "one stdout line")
    has(so, part, "stdout")


@case("R0 build가 만든 TO-QA 행 그대로 → recheck exit 0, 출력 없음")
def _():
    b = b1()
    line = next(l for l in b["data"].split(b"\n") if l.startswith(b"2\tjira-transition\tjira#TST-1\t"))
    eq(recheck(b["root"], b["g"], b["env"], line), (0, "", ""), "recheck")
    log = (b["root"] / "gh" / "gh.log").read_text()
    run = next((l for l in log.splitlines() if l.startswith("run list")), "")
    for part in ("deploy-staging.yml", "deploy/staging", "push", "success"):
        has(run, part, "gh run list")


@case("R1 승인 뒤 새 커밋이 티켓을 언급 → 10 '승인 뒤 새 관련 변경: c:…'")
def _():
    root, g, env = recheck_env("r1")
    new = seed_commit(g, "TST-1 후속 수정", "more.txt", branches=("develop",))
    want10(recheck(root, g, env, qa_line(g)), "승인 뒤 새 관련 변경: c:" + new[:12])


@case("R2 승인 뒤 새 합쳐진 PR이 티켓을 언급 → 10 '승인 뒤 새 관련 변경: pr:31'")
def _():
    root, g, env = recheck_env("r2", prs_edit=lambda g, p: p + [pr(31, "TST-1 추가 작업", "MERGED", g["c0"])])
    want10(recheck(root, g, env, qa_line(g)), "승인 뒤 새 관련 변경: pr:31")


@case("R3 staging 배포에서 되돌림 → 10 '되돌려짐'")
def _():
    root, g, env = recheck_env("r3")
    sh("git", "-C", g["seed"], "revert", "--no-edit", g["c1"])
    head = sh("git", "-C", g["seed"], "rev-parse", "HEAD")
    sh("git", "-C", g["seed"], "push", "-q", "origin", "HEAD:refs/heads/develop", "HEAD:refs/heads/deploy/staging")
    gh_fix(root / "gh", g, prs=json.loads((root / "gh" / "prs.json").read_text()),
           runs=[{"headSha": head, "databaseId": 9000000002, "url": RUN_URL, "updatedAt": "2026-10-19T01:00:00Z"}])
    want10(recheck(root, g, env, qa_line(g)), "staging 배포에서 되돌려짐: 커밋 " + g["c1"][:12])


@case("R3b 짧은 sha로 적은 되돌림(This reverts commit <12자>) → 10")
def _():
    root, g, env = recheck_env("r3b")
    (g["seed"] / "err.txt").write_text("되돌림\n")
    sh("git", "-C", g["seed"], "commit", "-q", "-am", "오류 문구 되돌림\n\nThis reverts commit %s." % g["m12"][:12])
    head = sh("git", "-C", g["seed"], "rev-parse", "HEAD")
    sh("git", "-C", g["seed"], "push", "-q", "origin", "HEAD:refs/heads/develop", "HEAD:refs/heads/deploy/staging")
    gh_fix(root / "gh", g, prs=json.loads((root / "gh" / "prs.json").read_text()),
           runs=[{"headSha": head, "databaseId": 9000000002, "url": RUN_URL, "updatedAt": "2026-10-19T01:00:00Z"}])
    want10(recheck(root, g, env, qa_line(g)), "staging 배포에서 되돌려짐: PR #12")


@case("R5b 승인 항목의 커밋이 저장소에 아예 없음(얕은 클론 아님) → 10, 배포 기준 커밋이 없음 → 3")
def _():
    root, g, env = recheck_env("r5b")
    items = [{"kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": g["m12"]},
             {"kind": "c", "pr": None, "state": None, "role": "unrelated", "sha": "9" * 40}]
    want10(recheck(root, g, env, qa_line(g, items=items)), "커밋 999999999999 (커밋이 저장소에 없음)")
    gh_fix(root / "gh", g, prs=json.loads((root / "gh" / "prs.json").read_text()),
           runs=[{"headSha": "8" * 40, "databaseId": 1, "url": RUN_URL, "updatedAt": "2026-10-19T01:00:00Z"}])
    rc, so, se = recheck(root, g, env, qa_line(g))
    eq((rc, so), (3, ""), "S' missing")
    has(se, "배포 기준 커밋 888888888888가 클론에 없음", "stderr")


@case("R4 S'가 앞으로 갔지만 승인 항목은 여전히 조상 → 0")
def _():
    root, g, env = recheck_env("r4")
    head = seed_commit(g, "문서 정리", "doc.txt")
    gh_fix(root / "gh", g, prs=json.loads((root / "gh" / "prs.json").read_text()),
           runs=[{"headSha": head, "databaseId": 9000000002, "url": RUN_URL, "updatedAt": "2026-10-19T01:00:00Z"}])
    eq(recheck(root, g, env, qa_line(g)), (0, "", ""), "recheck")


@case("R5 지금 S'에 승인 항목이 없음 → 10 '지금 staging 배포(…)에 없음'")
def _():
    root, g, env = recheck_env("r5", runs=lambda g: [{"headSha": g["c0"], "databaseId": 1, "url": RUN_URL,
                                                       "updatedAt": "2026-10-19T01:00:00Z"}])
    want10(recheck(root, g, env, qa_line(g)), "지금 staging 배포(%s)에 없음: PR #12" % g["c0"][:12])


@case("R6 승인 때 닫힌 PR이 다시 열림 → 10 '열린 PR: PR #13'")
def _():
    def reopen(g, prs):
        return [dict(p, state="OPEN") if p["number"] == 13 else p for p in prs]
    root, g, env = recheck_env("r6", prs_edit=reopen)
    want10(recheck(root, g, env, qa_line(g)), "진행 중인 작업: PR #13")


@case("R7 승인 때 닫힌 PR이 그 뒤 합쳐짐 → 10 '승인 뒤 합쳐진 PR: pr:13'")
def _():
    def merge13(g, prs):
        return [dict(p, state="MERGED", mergeCommit={"oid": g["p1"]}) if p["number"] == 13 else p for p in prs]
    root, g, env = recheck_env("r7", prs_edit=merge13)
    want10(recheck(root, g, env, qa_line(g)), "승인 뒤 합쳐진 PR: pr:13")
    def merge13_stage(g, prs):
        return [dict(p, state="MERGED", mergeCommit={"oid": g["p1"]}, baseRefName="deploy/stage2")
                if p["number"] == 13 else p for p in prs]
    root, g, env = recheck_env("r7b", prs_edit=merge13_stage)
    eq(recheck(root, g, env, qa_line(g)), (0, "", ""), "merged into another branch = outside the deploy check")


@case("R8 합쳐진 PR의 병합 sha가 승인 때와 다름 → 10")
def _():
    def resha(g, prs):
        return [dict(p, mergeCommit={"oid": g["c0"]}) if p["number"] == 12 else p for p in prs]
    root, g, env = recheck_env("r8", prs_edit=resha)
    want10(recheck(root, g, env, qa_line(g)), "병합 기록이 승인 때와 다름: PR #12")


def stage_pr_env(name, base):
    """PR #60 'TST-1 승격'(base 지정)이 staging 역사에 없는 커밋 st로 합쳐짐 + st 자체는 deploy/stage2에만."""
    root = W / name
    g = make_git(root / "git")
    g["st"] = seed_commit(g, "stage 핫픽스", "st.txt", branches=("deploy/stage2", "main"))
    prs = [pr(12, "TST-1 로그인 폼 검증", "MERGED", g["m12"], "feat/login"),
           pr(13, "TST-1 다른 방식 시도", "CLOSED", head="feat/login-alt"),
           pr(60, "TST-1 승격", "MERGED", g["st"], "deploy/develop-to-stage", base=base)]
    env = gh_fix(root / "gh", g, prs=prs)
    items = [{"kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": g["m12"]},
             {"kind": "c", "pr": None, "state": None, "role": "required", "sha": g["c1"]},
             {"kind": "pr", "pr": 13, "state": "CLOSED", "role": "superseded", "sha": None},
             {"kind": "pr", "pr": 60, "state": "MERGED", "role": "unrelated", "sha": g["st"]}]
    return root, g, env, items


@case("R13 다른 브랜치(deploy/stage2)로 합쳐진 PR이 S'에 없음 → 0 (배포 판단에서 제외)")
def _():
    root, g, env, items = stage_pr_env("r13", "deploy/stage2")
    eq(recheck(root, g, env, qa_line(g, items=items)), (0, "", ""), "recheck")


@case("R14 기본 브랜치로 합쳐진 PR(required 아님)이 S'에 없음 → 10")
def _():
    root, g, env, items = stage_pr_env("r14", "develop")
    want10(recheck(root, g, env, qa_line(g, items=items)), "지금 staging 배포(%s)에 없음: PR #60" % g["c1"][:12])


@case("R15 커밋(required 아님): 기본 브랜치에 없으면 제외 → 0, 기본 브랜치에 있는데 S'에 없으면 → 10, required면 → 10")
def _():
    def approved(g):
        return [{"kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": g["m12"]},
                {"kind": "c", "pr": None, "state": None, "role": "required", "sha": g["c1"]},
                {"kind": "pr", "pr": 13, "state": "CLOSED", "role": "superseded", "sha": None}]
    root, g, env = recheck_env("r15")
    st = seed_commit(g, "TST-1 stage 전용 수정", "st.txt", branches=("deploy/stage2",))
    base = approved(g)
    unrel = base + [{"kind": "c", "pr": None, "state": None, "role": "unrelated", "sha": st}]
    eq(recheck(root, g, env, qa_line(g, items=unrel)), (0, "", ""), "stage-only commit ignored")
    req = base + [{"kind": "c", "pr": None, "state": None, "role": "required", "sha": st}]
    want10(recheck(root, g, env, qa_line(g, items=req)), "지금 staging 배포(%s)에 없음: 커밋 %s" % (g["c1"][:12], st[:12]))
    root, g, env = recheck_env("r15b")
    dv = seed_commit(g, "TST-1 develop 후속", "dv.txt", branches=("develop",))
    items = approved(g) + [{"kind": "c", "pr": None, "state": None, "role": "unrelated", "sha": dv}]
    want10(recheck(root, g, env, qa_line(g, items=items)), "지금 staging 배포(%s)에 없음: 커밋 %s" % (g["c1"][:12], dv[:12]))


@case("R9 성공한 staging 배포 없음 → 10")
def _():
    root, g, env = recheck_env("r9", runs=lambda g: [])
    want10(recheck(root, g, env, qa_line(g)), "staging 배포 성공 기록이 없음")


@case("R10 gh 실패 → 3, stderr 한 줄, stdout 없음")
def _():
    root, g, env = recheck_env("r10")
    rc, so, se = recheck(root, g, dict(env, GH_FAIL="run list"), qa_line(g))
    eq((rc, so), (3, ""), "rc/stdout")
    has(se, "chore-judge: recheck:", "stderr")


@case("R11 잘못된 입력(한 줄·깨진 행) · 바인딩 site 불일치 · 바인딩 없음 → 3")
def _():
    root, g, env = recheck_env("r11")
    for stdin in (HEADER + b"\n", HEADER + b"\nnot a row\n", b"garbage\n" + qa_line(g) + b"\n"):
        rc, so, se = recheck(root, g, env, b"", stdin=stdin)
        eq((rc, so, se.startswith("chore-judge: recheck: ")), (3, "", True), "bad input %r" % stdin[-20:])
    rc, so, se = recheck(root, g, env, qa_line(g), md=repos_md(root / "other.md", site="other.atlassian.net"))
    eq((rc, so), (3, ""), "site mismatch")
    md = root / "none.md"
    md.write_text("| repo | local path | remote (owner/repo) | note |\n|---|---|---|---|\n| `repo` | `~/x` | `test/repo` | 메모 |\n")
    rc, so, se = recheck(root, g, env, qa_line(g), md=md)
    eq((rc, so), (3, ""), "no binding")


@case("R12 TO-CLOSED: 근거 티켓 있음 → 0, 없음 → 10, 근거 PR 합쳐짐 → 0, 아님 → 10")
def _():
    root, g, env = recheck_env("r12")
    setup_fake()
    eq(recheck(root, g, env, closed_line("duplicate:TST-20")), (0, "", ""), "exists")
    want10(recheck(root, g, env, closed_line("duplicate:TST-404")), "근거 티켓이 없음: TST-404")
    eq(recheck(root, g, env, closed_line("superseded:pr:12")), (0, "", ""), "pr merged")
    want10(recheck(root, g, env, closed_line("superseded:pr:13")), "근거 PR이 합쳐진 상태가 아님: PR #13")


@case("R16 TO-CLOSED: 이 티켓을 언급하는 열린 PR이 생김 → 10, PR 목록 불완전 → 3")
def _():
    root, g, env = recheck_env("r16", prs_edit=lambda g, p: p + [pr(70, "TST-2 다시 손봄", "OPEN")])
    setup_fake()
    open70 = [{"kind": "pr", "pr": 70, "state": "OPEN", "role": "unrelated", "sha": None}]
    want10(recheck(root, g, env, closed_line("duplicate:TST-20", items=open70)), "진행 중인 작업: PR #70")
    root, g, env = recheck_env("r16b")
    (root / "gh" / "pr-total.json").write_text("99")
    rc, so, se = recheck(root, g, env, closed_line("duplicate:TST-20"))
    eq((rc, so), (3, ""), "incomplete PR list")
    has(se, "PR 목록 불완전", "stderr")


# ───────────────────────── 리뷰 라운드 (2026-10-19): 규칙마다 그 규칙만 실패하는 사례 ─────────────────────────

def with_double():
    """[E] 모양(되돌림을 브랜치 범위로 모으는 방식 등) 자체를 쓰는 사례는 대역으로 고정한다 — 판정 쪽 처리를 보는 것."""
    return {"CHORE_EVIDENCE_PY": str(W / "mods" / "ev.py")}


OM = {"repo": "org/web", "number": 5, "state": "OPEN", "title": "x"}      # 증거가 쓰는 다른 저장소 언급 한 건


@case("G1 증거 형식 오류(on_S·patch_equivalent·reverted_by·folded·open_pr_mentions·excluded·deploy.stale) → exit 1")
def _():
    base = lambda **kw: jira_ev("TST-43", [dict(jc_pr(12, "MERGED", "a" * 40), **kw)])
    variants = [("on_S", base(on_S="true")), ("patch_equivalent_on_S", base(patch_equivalent_on_S=0)),
                ("reverted_by", base(reverted_by=None)), ("folded_commits", base(folded_commits="x")),
                ("open_pr_mentions", dict(jira_ev("TST-43"), open_pr_mentions="30")),
                ("excluded", dict(jira_ev("TST-43"), excluded="hold")),
                ("open_branches", dict(jira_ev("TST-43"), open_branches="feat/TST-43-x")),
                ("other_repo_mentions", dict(jira_ev("TST-43"), other_repo_mentions=None)),
                *[("other_repo_mentions", dict(jira_ev("TST-43"), other_repo_mentions=[dict(OM, **kw) if kw else {}]))
                  for kw in ({}, {"number": "5"}, {"number": 0}, {"number": True}, {"state": "DRAFT"},
                             {"repo": "orgweb"}, {"repo": "org/"}, {"title": None})],
                ("stale", dict(jira_ev("TST-43"), deploy=dict(jira_ev("TST-43")["deploy"], stale="yes")))]
    for i, (what, ev) in enumerate(variants):
        rc, so, se, out = small("g1-%d" % i, [(ev, True, "")], [PASS_ROWS[0]],
                                [("jira#TST-43", dict(VERDICT="KEEP", REASON="x"))])
        eq((rc, out.exists()), (1, False), what)
        has(se, "증거 형식 오류: jira#TST-43", what)
        has(se, what, what)


@case("G2 자체 검사: 머리 줄은 입력에서 따로 다시 만든 것과 같아야 함 (groups= 밖이 바뀌면 · Jira 행 없이 groups=가 바뀌면 실패)")
def _():
    j = judge_mod()
    data = b1()["data"]
    hdr0 = P.parse_header(HEADER_NOJ)
    good = j.header_with_jira(HEADER_NOJ, hdr0) + data[len(HEADER):]
    idx = {"inventory": {"jira": {"total": sum(1 for u in EXPECT if u.startswith("jira#"))}}}
    j.self_check(good, HEADER_NOJ, hdr0, BINDING, idx)
    bad = good.replace(b"no_local=1", b"no_local=0", 1)
    try:
        j.self_check(bad, HEADER_NOJ, hdr0, BINDING, idx)
        raise AssertionError("other header field changed: accepted")
    except j.Fail as e:
        has(str(e), "머리 줄", "message")
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A")]
    plain = HEADER + b"\n" + b"\n".join(rows) + b"\n"
    try:
        j.self_check(plain, HEADER_NOJ, hdr0, None, {})
        raise AssertionError("groups changed without jira rows: accepted")
    except j.Fail as e:
        has(str(e), "머리 줄", "message")


@case("G3 cl_bound: 바인딩에 닫기 상태 없음 → AMBIGUOUS, 그 조건만")
def _():
    rc, so, se, out = small("g3", [(jira_ev("TST-2"), True, "")], [PASS_ROWS[0]],
                            [("jira#TST-2", dict(VERDICT="TO-CLOSED", REASON="중복", CLOSE_BASIS="duplicate:TST-20",
                                                 CITES="jira:TST-20"))], binding=dict(BINDING, closed=None))
    eq((rc, se), (0, ""), "rc")
    ev = rows_by_ref(out.read_bytes())[("report", "jira#TST-2")]["jira"]["evidence"]
    eq((ev["v"], ev["missing"]), ("AMBIGUOUS", "저장소 등록부에 닫기(Closed) 상태가 없음"), "cl_bound")


def hold_build(name, *flags):
    b = b1()
    out = W / ("%s.tsv" % name)
    rc, so, se = run_judge("build", "--plan", b["plan"], "--ev", b["ev"], "--verdicts", b["vd"], "--out", out,
                           "--date", DATE, "--clone", b["g"]["clone"], *flags, env=b["env"])
    return rc, so, se, out


def counts_of(so):
    return dict(kv.split("=") for kv in so.split("\n")[0][len("build: "):].split())


@case("H1 --hold-area close: 닫기 행 → tier-3 KEEP '이번 승인에서 뺌'(verdict=KEEP), 개수에 반영")
def _():
    rc, so, se, out = hold_build("h1", "--hold-area", "close")
    eq((rc, se), (0, ""), "rc")
    rows = rows_by_ref(out.read_bytes())
    for ref in ("pr#7", "issue#9"):
        r = rows[("report", ref)]
        eq((r["tier"], r["snapshot"]["verdict"], r["unit"]["evidence"]["v"], r["unit"]["evidence"]["reason"]),
           (3, "KEEP", "KEEP", "이번 승인에서 뺌"), ref)
        if ("close-pr", ref) in rows or ("close-issue", ref) in rows:
            raise AssertionError("%s still acting" % ref)
    c, base = counts_of(so), counts_of(b1()["so"])
    eq((c["close-pr"], c["close-issue"], c["held"], int(c["keep"]) - int(base["keep"]), c["to-qa"]),
       ("0", "0", "2", 2, base["to-qa"]), "counts")


@case("H2 --hold-area jira: Jira 옮기기 행 → tier-3 jira#KEY KEEP(summary·status_name 유지), 닫기 행은 그대로")
def _():
    rc, so, se, out = hold_build("h2", "--hold-area", "jira")
    eq((rc, se), (0, ""), "rc")
    rows = rows_by_ref(out.read_bytes())
    if any(a == "jira-transition" for a, _ in rows):
        raise AssertionError("jira-transition rows remain")
    r = rows[("report", "jira#TST-1")]["jira"]
    eq((r["summary"], r["status_name"], r["evidence"]["v"], r["evidence"]["reason"]),
       ("로그인 폼 검증, 오류 문구 정리", "Waiting", "KEEP", "이번 승인에서 뺌"), "held jira row")
    has(r["evidence"]["known"], "판정 의견(QA로 옮기기)", "known keeps the verdict")
    eq((("close-pr", "pr#7") in rows, counts_of(so)["to-qa"], counts_of(so)["to-closed"]), (True, "0", "0"), "others")


@case("H3 --hold jira#TST-2 · --hold pr#7: 그 행만 뺌 / 계획에 없는 ref → exit 1")
def _():
    rc, so, se, out = hold_build("h3", "--hold", "jira#TST-2", "--hold", "pr#7")
    eq((rc, se), (0, ""), "rc")
    rows = rows_by_ref(out.read_bytes())
    eq((("jira-transition", "jira#TST-2") in rows, rows[("report", "jira#TST-2")]["jira"]["evidence"]["reason"],
        ("jira-transition", "jira#TST-26") in rows, ("close-pr", "pr#7") in rows, ("close-issue", "issue#9") in rows,
        counts_of(so)["held"]), (False, "이번 승인에서 뺌", True, False, True, "2"), "only the named rows")
    for ref, part in (("pr#999", "--hold 대상이 계획에 없음: pr#999"), ("branch-x", "pr#N, issue#N, jira#KEY 꼴")):
        rc, so, se, out = hold_build("h3-" + ref.replace("#", ""), "--hold", ref)
        eq((rc, so, out.exists()), (1, "", False), ref)
        has(se, part, ref)


@case("H4 --hold-area branches: delete-remote → tier-3 remote:<b> 보존 행(같은 tip, 엔진 kept 모양) + chore.sh check-plan 통과")
def _():
    rc, so, se, out = hold_build("h4", "--hold-area", "branches")
    eq((rc, se), (0, ""), "rc")
    data = out.read_bytes()
    rows = rows_by_ref(data)
    if any(a == "delete-remote" for a, _ in rows):
        raise AssertionError("delete-remote rows remain")
    r = rows[("report", "remote:feat/login-form")]
    src = VALID_ROWS[1].split(b"\t")
    eq((r["tier"], r["expected"], list(r["snapshot"]), r["evidence"]),
       (3, src[3].decode(), ["tip_author", "tip_date", "pr", "pr_state", "pr_author", "pr_base", "pr_merge_commit"],
        "이번 승인에서 뺌"), "kept row")
    s0 = P.parse_snapshot(src[4], "src")
    eq({k: r["snapshot"][k] for k in r["snapshot"]},
       {"tip_author": s0["tip_author"], "tip_date": s0["tip_date"], "pr": s0["pr"], "pr_state": "MERGED",
        "pr_author": s0["pr_author"], "pr_base": s0["pr_base"], "pr_merge_commit": s0["pr_merge_commit"]}, "values")
    eq(counts_of(so)["held"], "1", "held")
    p = subprocess.run(["bash", str(SCRIPTS / "chore.sh"), "check-plan", "--plan", str(out)], capture_output=True,
                       env=ENV, timeout=60)
    eq((p.returncode, p.stderr.decode()[-300:]), (0, ""), "chore.sh check-plan")


@case("R17 다시 뽑은 후보의 reverted_by(리베이스 병합 범위 안 커밋 되돌림) → 10 '되돌려짐: PR #80' [대역]")
def _():
    root, g, env = recheck_env("r17")
    y1 = seed_commit(g, "작업 1단계", "y1.txt")
    y2 = seed_commit(g, "TST-1 작업 마무리", "y2.txt")
    sh("git", "-C", g["seed"], "revert", "--no-edit", y1)
    head = sh("git", "-C", g["seed"], "rev-parse", "HEAD")
    sh("git", "-C", g["seed"], "push", "-q", "origin", "HEAD:refs/heads/develop", "HEAD:refs/heads/deploy/staging")
    prs = json.loads((root / "gh" / "prs.json").read_text())
    prs.append(dict(pr(80, "TST-1 리베이스 병합", "MERGED", y2), commits=[{"oid": y1}, {"oid": y2}]))
    gh_fix(root / "gh", g, prs=prs, runs=[{"headSha": head, "databaseId": 9000000002, "url": RUN_URL,
                                            "updatedAt": "2026-10-19T01:00:00Z"}])
    items = [{"kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": g["m12"]},
             {"kind": "c", "pr": None, "state": None, "role": "required", "sha": g["c1"]},
             {"kind": "pr", "pr": 13, "state": "CLOSED", "role": "superseded", "sha": None},
             {"kind": "pr", "pr": 80, "state": "MERGED", "role": "unrelated", "sha": y2}]
    want10(recheck(root, g, dict(env, **with_double()), qa_line(g, items=items)), "되돌려짐: PR #80")


@case("R18 승인한 두 부모 병합 PR의 브랜치 커밋(merge^1..merge^2)이 S'에서 되돌려짐 → 10")
def _():
    root, g, env = recheck_env("r18")
    sh("git", "-C", g["seed"], "revert", "--no-edit", g["p1"])
    head = sh("git", "-C", g["seed"], "rev-parse", "HEAD")
    sh("git", "-C", g["seed"], "push", "-q", "origin", "HEAD:refs/heads/develop", "HEAD:refs/heads/deploy/staging")
    gh_fix(root / "gh", g, prs=json.loads((root / "gh" / "prs.json").read_text()),
           runs=[{"headSha": head, "databaseId": 9000000002, "url": RUN_URL, "updatedAt": "2026-10-19T01:00:00Z"}])
    want10(recheck(root, g, env, qa_line(g)), "staging 배포에서 되돌려짐: PR #12 (안의 커밋 %s)" % g["p1"][:12])


def closed_env(name, prs_edit=None):
    root, g, env = recheck_env(name, prs_edit=prs_edit)
    setup_fake()
    return root, g, env


@case("R19 TO-CLOSED: 승인 뒤 이 티켓을 언급하는 새 합쳐진 PR → 10 '승인 뒤 새 관련 변경'")
def _():
    root, g, env = closed_env("r19", lambda g, p: p + [pr(71, "TST-2 마무리", "MERGED", g["c0"])])
    want10(recheck(root, g, env, closed_line("duplicate:TST-20")), "승인 뒤 새 관련 변경: pr:71")


@case("R20 TO-CLOSED: 승인한 합쳐진 PR의 병합 커밋이 바뀜 → 10")
def _():
    root, g, env = closed_env("r20", lambda g, p: p + [pr(72, "TST-2 정리", "MERGED", g["c1"])])
    items = [{"kind": "pr", "pr": 72, "state": "MERGED", "role": "unrelated", "sha": g["c0"]}]
    want10(recheck(root, g, env, closed_line("duplicate:TST-20", items=items)), "병합 기록이 승인 때와 다름: PR #72")


@case("R21 TO-CLOSED 근거 술어를 지금 값으로: 다른 프로젝트 · 대체 티켓이 더 오래됐고 안 끝남 · 잇는 것 없음 → 10, 맞으면 0")
def _():
    root, g, env = closed_env("r21")
    want10(recheck(root, g, env, closed_line("duplicate:TST-61")), "중복 근거 티켓이 다른 프로젝트: TST-61")
    want10(recheck(root, g, env, closed_line("superseded:TST-51")), "대체 티켓이 더 먼저 만들어졌고 아직 끝나지 않음: TST-51")
    want10(recheck(root, g, env, closed_line("superseded:TST-52")), "잇는 링크가 없고 같은 작성자의 같은 제목도 아님: TST-52")
    eq(recheck(root, g, env, closed_line("superseded:TST-50")), (0, "", ""), "newer + same creator/summary")


@case("R22 계획 머리 줄 remote ≠ --remote → 3, gh·git 읽기 없음")
def _():
    root, g, env = recheck_env("r22")
    md = repos_md(root / "repos.md", extra="| `o` | `~/o` | `other/repo` | jira=%s/TST jira-qa=%s jira-closed=%s "
                                            "deploy-proof=deploy-staging.yml@deploy/staging |\n" % (SITE, QA, CLOSED))
    rc, so, se = run_judge("recheck", "--clone", g["clone"], "--remote", "other/repo", "--repos-md", md,
                           stdin=HEADER + b"\n" + qa_line(g) + b"\n", env=env)
    eq((rc, so), (3, ""), "rc")
    has(se, "계획의 저장소 test/repo ≠ --remote other/repo", "stderr")
    eq((root / "gh" / "gh.log").read_text(), "", "no gh call")


@case("R23 새 후보의 커밋이 클론에 없어 다시 뽑기가 불완전해도 ⊆ 검사가 먼저 → 10 (이 행만)")
def _():
    root, g, env = recheck_env("r23", prs_edit=lambda g, p: p + [pr(90, "TST-1 새 작업", "MERGED", "5" * 40)])
    want10(recheck(root, g, env, qa_line(g)), "승인 뒤 새 관련 변경: pr:90")


@case("R24 다시 뽑기가 불완전하고 새 후보는 없음 → 3")
def _():
    root, g, env, items = stage_pr_env("r24", "deploy/stage2")
    prs = json.loads((root / "gh" / "prs.json").read_text())
    for x in prs:
        if x["number"] == 60:
            x["mergeCommit"] = {"oid": "6" * 40}
    gh_fix(root / "gh", g, prs=prs)
    items = [dict(it, sha="6" * 40) if it.get("pr") == 60 else it for it in items]
    rc, so, se = recheck(root, g, env, qa_line(g, items=items))
    eq((rc, so), (3, ""), "rc")
    has(se, "관련 변경 목록 불완전", "stderr")


@case("R25 지금 staging 배포 기준이 stale(더 최근 실행이 성공 push가 아님) → 10")
def _():
    root, g, env = recheck_env("r25")
    (root / "gh" / "runs-all.json").write_text(json.dumps(
        [{"headSha": g["c1"], "databaseId": 9000000009, "url": RUN_URL, "updatedAt": "2026-10-19T02:00:00Z",
          "status": "in_progress", "conclusion": ""}]))
    want10(recheck(root, g, env, qa_line(g)), "staging 배포 기준을 확정 못 함")


@case("R26 git fetch 실패 → 3 · R27 TO-QA PR 목록 불완전 → 3 · R28 얕은 클론 → 3")
def _():
    root, g, env = recheck_env("r26")
    sh("git", "-C", g["clone"], "remote", "set-url", "origin", str(root / "no-such-origin.git"))
    rc, so, se = recheck(root, g, env, qa_line(g))
    eq((rc, so), (3, ""), "fetch failure")
    has(se, "git fetch 실패", "stderr")
    root, g, env = recheck_env("r27")
    (root / "gh" / "pr-total.json").write_text("99")
    rc, so, se = recheck(root, g, env, qa_line(g))
    eq((rc, so), (3, ""), "incomplete PR list")
    has(se, "PR 목록 불완전", "stderr")
    root, g, env = recheck_env("r28")
    shallow = root / "shallow"
    sh("git", "clone", "-q", "--depth", "1", "--no-single-branch", "file://" + str(g["bare"]), shallow)
    rc, so, se = run_judge("recheck", "--clone", shallow, "--remote", "test/repo", "--repos-md", repos_md(root / "r.md"),
                           stdin=HEADER + b"\n" + qa_line(g) + b"\n", env=env)
    eq((rc, so), (3, ""), "shallow clone")
    has(se, "얕은", "stderr")


@case("R29 TO-CLOSED Jira 읽기 5xx · 인증 실패 → 3")
def _():
    root, g, env = closed_env("r29")
    for mode in ("500", "401"):
        FAKE.modes = {"view": mode}
        rc, so, se = recheck(root, g, env, closed_line("duplicate:TST-20"))
        eq((rc, so), (3, ""), mode)
        has(se, "chore-judge: recheck:", mode)
    FAKE.modes = {}


# ───────────────────────── 리뷰 3라운드 (2026-10-19) ─────────────────────────

def push_branch(g, branch, msg, fname):
    """seed의 develop 위에 커밋 하나를 origin/<branch>로만 올린다(기본·배포 브랜치는 그대로) → 그 커밋."""
    sh("git", "-C", g["seed"], "checkout", "-q", "-B", "tmp-" + fname, "develop")
    (g["seed"] / fname).write_text(msg + "\n")
    sh("git", "-C", g["seed"], "add", "-A")
    sh("git", "-C", g["seed"], "commit", "-q", "-m", msg)
    head = sh("git", "-C", g["seed"], "rev-parse", "HEAD")
    sh("git", "-C", g["seed"], "push", "-q", "origin", "HEAD:refs/heads/" + branch)
    sh("git", "-C", g["seed"], "checkout", "-q", "develop")
    return head


@case("W1 승인 뒤 키 이름 브랜치가 생김(PR 없음) → 10 '진행 중인 작업: 브랜치 …' (TO-QA · TO-CLOSED)")
def _():
    root, g, env = recheck_env("w1")
    setup_fake()
    push_branch(g, "feat/TST-1-followup", "후속 작업", "f1.txt")
    push_branch(g, "feat/TST-2-followup", "후속 작업", "f2.txt")
    want10(recheck(root, g, env, qa_line(g)), "진행 중인 작업: 브랜치 feat/TST-1-followup")
    want10(recheck(root, g, env, closed_line("duplicate:TST-20")), "진행 중인 작업: 브랜치 feat/TST-2-followup")


@case("W2 제목에 키 없는 열린 PR의 커밋 메시지가 키를 언급 → 10 '진행 중인 작업: PR #96' (TO-QA · TO-CLOSED)")
def _():
    for key, line_of in (("TST-1", lambda g: qa_line(g)), ("TST-2", lambda g: closed_line("duplicate:TST-20"))):
        root, g, env = recheck_env("w2-" + key)
        setup_fake()
        head = push_branch(g, "feat/followup", "%s 후속 수정" % key, "f.txt")
        prs = json.loads((root / "gh" / "prs.json").read_text())
        prs.append(pr(96, "후속 정리", "OPEN", head="feat/followup", head_oid=head))
        gh_fix(root / "gh", g, prs=prs)
        want10(recheck(root, g, env, line_of(g)), "진행 중인 작업: PR #96")


@case("W3 진행 중인 작업 읽기가 불완전(열린 PR의 머리 커밋이 클론에 없음)하고 아무것도 못 찾음 → 3")
def _():
    root, g, env = recheck_env("w3")
    prs = json.loads((root / "gh" / "prs.json").read_text())
    prs.append(pr(97, "관계없는 작업", "OPEN", head="feat/other", head_oid="5" * 40))
    gh_fix(root / "gh", g, prs=prs)
    rc, so, se = recheck(root, g, env, qa_line(g))
    eq((rc, so), (3, ""), "rc")
    has(se, "진행 중인 작업 목록 불완전", "stderr")


@case("W4 PR 브랜치 안에서 되돌리고(X → Revert X) 병합 커밋으로 합친 PR → recheck 0 (되돌림 아님)")
def _():
    root, g, env = recheck_env("w4")
    sd = g["seed"]
    sh("git", "-C", sd, "checkout", "-q", "-b", "feat/xy", "develop")
    (sd / "x.txt").write_text("x\n")
    sh("git", "-C", sd, "add", "-A")
    sh("git", "-C", sd, "commit", "-q", "-m", "기능 X")
    x = sh("git", "-C", sd, "rev-parse", "HEAD")
    sh("git", "-C", sd, "revert", "--no-edit", x)
    y = sh("git", "-C", sd, "rev-parse", "HEAD")
    sh("git", "-C", sd, "checkout", "-q", "develop")
    sh("git", "-C", sd, "merge", "-q", "--no-ff", "feat/xy", "-m", "Merge pull request #95 from test/feat/xy")
    m2 = sh("git", "-C", sd, "rev-parse", "HEAD")
    sh("git", "-C", sd, "push", "-q", "origin", "HEAD:refs/heads/develop", "HEAD:refs/heads/deploy/staging")
    prs = json.loads((root / "gh" / "prs.json").read_text())
    prs.append(pr(95, "TST-1 X 시도와 되돌림", "MERGED", m2, "feat/xy", head_oid=y))
    gh_fix(root / "gh", g, prs=prs, runs=[{"headSha": m2, "databaseId": 9000000002, "url": RUN_URL,
                                            "updatedAt": "2026-10-19T01:00:00Z"}])
    items = [{"kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": g["m12"]},
             {"kind": "c", "pr": None, "state": None, "role": "required", "sha": g["c1"]},
             {"kind": "pr", "pr": 13, "state": "CLOSED", "role": "superseded", "sha": None},
             {"kind": "pr", "pr": 95, "state": "MERGED", "role": "unrelated", "sha": m2}]
    eq(recheck(root, g, env, qa_line(g, items=items)), (0, "", ""), "own-branch revert")


@case("W5 TO-CLOSED recheck: 근거 키가 지금은 이 티켓으로 옮겨짐(별칭) → 10 '근거 티켓이 이 티켓 자신임'")
def _():
    root, g, env = closed_env("w5")
    FAKE.aliases["TST-62"] = "TST-2"
    want10(recheck(root, g, env, closed_line("duplicate:TST-62")), "근거 티켓이 이 티켓 자신임: TST-62")


@case("W6 보류(--hold)한 TO-CLOSED 근거 티켓은 이번 계획에서 닫히지 않으므로 그 중복 티켓은 TO-CLOSED로 남음")
def _():
    rc, so, se, out = hold_build("w6", "--hold", "jira#TST-25")
    eq((rc, se), (0, ""), "rc")
    rows = rows_by_ref(out.read_bytes())
    eq((("jira-transition", "jira#TST-24") in rows, rows[("report", "jira#TST-25")]["jira"]["evidence"]["reason"]),
       (True, "이번 승인에서 뺌"), "held target frees its duplicate")


@case("W7 다른 저장소(jira-repos=)의 PR이 승인 뒤 키를 언급 → 10 (TO-QA · TO-CLOSED · CLOSED PR도 — 증거 제외와 같은 술어), 목록 불완전 → 3")
def _():
    root, g, env = closed_env("w7")
    md = repos_md(root / "repos.md", others="org/web")
    web = root / "gh" / "prs-org-web.json"

    def run(line):
        return recheck(root, g, env, line, md=md)
    web.write_text(json.dumps([pr(5, "TST-1 화면 쪽 수정", "MERGED", "1" * 40), pr(6, "TST-2 정리", "OPEN")]))
    want10(run(qa_line(g)), "다른 저장소의 PR이 이 티켓을 언급: org/web#5")
    want10(run(closed_line("duplicate:TST-20")), "다른 저장소의 PR이 이 티켓을 언급: org/web#6")
    web.write_text(json.dumps([pr(5, "TST-1 버린 시도", "CLOSED")]))
    want10(run(qa_line(g)), "다른 저장소의 PR이 이 티켓을 언급: org/web#5")
    web.write_text(json.dumps([pr(5, "관계없는 일", "CLOSED")]))
    eq(run(qa_line(g)), (0, "", ""), "no mention in the other repo")
    (root / "gh" / "pr-total-org-web.json").write_text("7")
    rc, so, se = run(qa_line(g))
    eq((rc, so), (3, ""), "incomplete other-repo list")
    has(se, "다른 저장소 PR 목록 불완전: org/web", "stderr")


@case("W8 다른 저장소 목록 = 증거 _other_repos: jira-repos=에 이 저장소 자신(대소문자 달라도)이 있으면 무시, 쉼표 문자열 = 목록")
def _():
    import contextlib
    import types
    root, g, env = recheck_env("w8")
    (root / "gh" / "prs-org-web.json").write_text(json.dumps([pr(5, "관계없는 일", "OPEN")]))
    j = judge_mod()
    a = types.SimpleNamespace(remote="test/repo")

    @contextlib.contextmanager
    def gh_env():
        saved = dict(os.environ)
        os.environ.update({k: v for k, v in ENV.items()})
        os.environ.update(env)
        try:
            yield
        finally:
            os.environ.clear()
            os.environ.update(saved)
    with gh_env():
        # 이 저장소의 PR #12·#13(TST-1 언급, MERGED·CLOSED)은 다른 저장소가 아니다
        for others in (["test/repo", "org/web"], ["Test/Repo", "org/web"], "test/repo, Test/Repo,org/web"):
            j.no_other_repo(a, dict(BINDING, other_repos=others), "TST-1")
        (root / "gh" / "prs-org-web.json").write_text(json.dumps([pr(5, "TST-1 화면", "CLOSED")]))
        for others in (["org/web"], "org/web", " org/web , ORG/WEB"):
            try:
                j.no_other_repo(a, dict(BINDING, other_repos=others), "TST-1")
                raise AssertionError("%r: mention not refused" % (others,))
            except j.ProofFail as e:
                eq(str(e), "다른 저장소의 PR이 이 티켓을 언급: org/web#5", repr(others))
        gl = (root / "gh" / "gh.log").read_text()
        if "--repo test/repo" in gl or "--repo Test/Repo" in gl:
            raise AssertionError("this repo was read as another repo: %r" % gl)


@case("W9 찾은 것이 불완전보다 먼저: 진행 중인 작업(열린 PR이 키를 언급) + 다른 열린 PR 머리 커밋 못 읽음 → 10, 다른 저장소 A 언급 + 앞선 저장소 B 목록 불완전 → 10")
def _():
    root, g, env = recheck_env("w9")
    prs = json.loads((root / "gh" / "prs.json").read_text())
    prs += [pr(97, "관계없는 작업", "OPEN", head="feat/other", head_oid="5" * 40),
            pr(98, "TST-1 진행 중", "OPEN", head="feat/doing", head_oid="6" * 40)]
    gh_fix(root / "gh", g, prs=prs)
    items = [{"kind": "pr", "pr": 12, "state": "MERGED", "role": "required", "sha": g["m12"]},
             {"kind": "c", "pr": None, "state": None, "role": "required", "sha": g["c1"]},
             {"kind": "pr", "pr": 13, "state": "CLOSED", "role": "superseded", "sha": None},
             {"kind": "pr", "pr": 98, "state": "OPEN", "role": "unrelated", "sha": None}]
    want10(recheck(root, g, env, qa_line(g, items=items)), "진행 중인 작업: PR #98")
    root, g, env = recheck_env("w9b")
    md = repos_md(root / "repos.md", others="org/broken,org/web")
    (root / "gh" / "prs-org-broken.json").write_text(json.dumps([pr(1, "관계없는 일", "OPEN")]))
    (root / "gh" / "pr-total-org-broken.json").write_text("9")
    (root / "gh" / "prs-org-web.json").write_text(json.dumps([pr(5, "TST-1 화면", "MERGED", "1" * 40)]))
    want10(recheck(root, g, env, qa_line(g), md=md), "다른 저장소의 PR이 이 티켓을 언급: org/web#5")


@case("L1 build: index.json ledgers(제외 원장 절대 경로)를 Jira 옮기기 행마다 snapshot ledgers로 옮김")
def _():
    b = b1()
    want = [str((b["root"] / "ledgers" / "work.jsonl").resolve())]
    _, rows = P.parse_plan(b["data"])
    moves = [r for r in rows if r["action"] == "jira-transition"]
    eq((len(moves) > 0, [r["jira"]["ledgers"] for r in moves]), (True, [want] * len(moves)), "ledgers per row")


@case("L2 build: index.json ledgers 없음 · 상대 경로 · 목록 아님 → exit 1 '증거 형식 오류: index ledgers'")
def _():
    for i, bad in enumerate(({"ledgers": None}, {"ledgers": ["rel/ledger.jsonl"]}, {"ledgers": "/a.jsonl"})):
        rc, so, se, out = small("l2-%d" % i, [(jira_ev("TST-43"), True, "")], [PASS_ROWS[0]],
                                [("jira#TST-43", dict(VERDICT="KEEP", REASON="x"))], index_extra=bad)
        eq((rc, out.exists()), (1, False), repr(bad))
        has(se, "증거 형식 오류: index ledgers", repr(bad))


@case("L3 recheck: 승인 뒤 바인딩 보류(jira-hold)에 snapshot 상태가 들어감 → 10 (TO-QA · TO-CLOSED), git·gh 읽기 없음")
def _():
    root, g, env = closed_env("l3")
    md = repos_md(root / "repos.md", hold=HOLD + ",20002")
    want10(recheck(root, g, env, qa_line(g), md=md), "보류 상태(Waiting) — 손대지 않음")
    want10(recheck(root, g, env, closed_line("duplicate:TST-20"), md=md), "보류 상태(Waiting) — 손대지 않음")
    eq((root / "gh" / "gh.log").read_text(), "", "no gh call before the hold check")


@case("L4 recheck: TO-CLOSED 행의 snapshot 상태 = 바인딩 jira-qa → 10")
def _():
    root, g, env = closed_env("l4")
    want10(recheck(root, g, env, closed_line("duplicate:TST-20", status=(QA, "QA (staging)"))),
           "보류 상태(QA (staging)) — 손대지 않음")


@case("L5 recheck: 승인 뒤 제외 원장에 이 티켓이 들어감 → 10(원장 사유) · 원장에 없음 → 0 · 원장을 못 읽음 → 3")
def _():
    root, g, env = closed_env("l5")
    led = root / "rtw-work" / "ledger.jsonl"
    led.parent.mkdir()
    led.write_text('{"key": "TST-9", "status": "진행 중"}\nTST-77\t다른 일\n')
    paths = [str(led.resolve())]
    eq(recheck(root, g, env, qa_line(g, ledgers=paths)), (0, "", ""), "TO-QA, key not in ledger")
    eq(recheck(root, g, env, closed_line("duplicate:TST-20", ledgers=paths)), (0, "", ""), "TO-CLOSED, key not in ledger")
    led.write_text(led.read_text() + '{"key": "TST-1", "status": "PR 준비 중"}\nTST-2\t같이 진행\n')
    want10(recheck(root, g, env, qa_line(g, ledgers=paths)), "다른 작업(rtw-work)에서 진행 중인 티켓")
    want10(recheck(root, g, env, closed_line("duplicate:TST-20", ledgers=paths)), "다른 작업(rtw-work)에서 진행 중인 티켓")
    led.unlink()
    for line in (qa_line(g, ledgers=paths), closed_line("duplicate:TST-20", ledgers=paths)):
        rc, so, se = recheck(root, g, env, line)
        eq((rc, so), (3, ""), "unreadable ledger")
        has(se, "제외 원장 읽기 실패", "stderr")


# ───────────────────────── 실물 연결 (evidence → build → recheck) ─────────────────────────

@case("E2E 실물 chore-evidence.py evidence → build → recheck (TO-QA 하나, TO-CLOSED 하나)")
def _():
    if not REAL_EV.exists():
        raise AssertionError("scripts/chore-evidence.py 없음 — 이 사례는 실물이 있어야 함")
    root = W / "e2e"
    g = make_git(root / "git")
    env = gh_fix(root / "gh", g, prs=[pr(12, "TST-1 로그인 폼 검증", "MERGED", g["m12"], "feat/login"),
                                      pr(13, "TST-1 다른 방식 시도", "CLOSED", head="feat/login-alt"),
                                      pr(7, "관계없는 PR", "OPEN", head_oid=g["c0"])])
    f = FAKE
    for key in ("TST-1", "TST-2"):
        f.add_issue(key, status={"id": "20002", "name": "Waiting"}, summary="%s 요약" % key)
        f.transitions[key] = [{"id": "31", "to": {"id": QA, "name": "QA (staging)"}},
                              {"id": "41", "to": {"id": CLOSED, "name": "Closed"}}]
    f.search_issues = [{"id": f.issues[k]["id"], "key": k} for k in ("TST-1", "TST-2")]
    hdr = HEADER.replace(b"origin=git@github.com%3Atest/repo.git", b"origin=" + P.penc(str(g["bare"]), sp=True))
    plan = root / "plan.tsv"
    plan.write_bytes(hdr + b"\n" + PASS_ROWS[2] + b"\n")
    md = repos_md(root / "repos.md")
    e = dict(ENV, **env)
    p = subprocess.run([sys.executable, "-I", str(REAL_EV), "evidence", "--plan", str(plan), "--out", str(root / "ev"),
                        "--clone", str(g["clone"]), "--repos-md", str(md), "--now", "2026-10-19T00:00:00Z"],
                       capture_output=True, env=e, timeout=120)
    eq(p.returncode, 0, "evidence rc (%s)" % p.stderr.decode()[:300])
    ev1 = json.loads((root / "ev" / "jira-TST-1.json").read_text())
    eq((ev1["complete"], ev1["incomplete"], sorted(c["id"] for c in ev1["candidates"])[0:0]), (True, [], []),
       "evidence complete")
    eq((ev1["complete"], sorted(c["id"] for c in ev1["candidates"])),
       (True, sorted(["pr:12", "pr:13", "c:" + g["c1"]])), "evidence candidates")
    vd = root / "verdicts"
    verdict(vd, "jira#TST-1", VERDICT="TO-QA", REASON="두 요구사항이 staging에 들어갔습니다",
            ITEMS="pr:12=required, c:%s=required, pr:13=superseded" % g["c1"][:12],
            REQUIREMENTS=['"로그인 폼 검증" => pr:12', '"오류 문구 정리" => c:%s' % g["c1"][:12]],
            CITES="pr:12:merged")
    verdict(vd, "jira#TST-2", VERDICT="TO-CLOSED", REASON="TST-20과 같은 작업입니다", CLOSE_BASIS="duplicate:TST-20",
            CITES="jira:TST-20")
    out = root / "final.tsv"
    rc, so, se = run_judge("build", "--plan", plan, "--ev", root / "ev", "--verdicts", vd, "--out", out, "--date", DATE,
                           "--clone", g["clone"], env=env)
    eq((rc, se), (0, ""), "build")
    has(so, "to-qa=1 to-closed=1 keep=0 ambiguous=0", "counts")
    data = out.read_bytes()
    lines = data.split(b"\n")
    for key in ("TST-1", "TST-2"):
        line = next(l for l in lines if l.startswith(b"2\tjira-transition\tjira#%s\t" % key.encode()))
        eq(run_judge("recheck", "--clone", g["clone"], "--remote", "test/repo", "--repos-md", md,
                     stdin=lines[0] + b"\n" + line + b"\n", env=env), (0, "", ""), "recheck " + key)
    r = rows_by_ref(data)[("jira-transition", "jira#TST-1")]
    eq((r["expected"], r["snapshot"]["S"], r["snapshot"]["issue_id"]),
       (f.issues["TST-1"]["updated"], g["c1"], f.issues["TST-1"]["id"]), "row facts from the live evidence")


# ───────────────────────── v4.3 Jira로 옮기기 (M 사례 — design v9 §5 build) ─────────────────────────

MV_TYPES = [{"id": MV.TYPE, "name": "작업"}, {"id": "10005", "name": "버그"}, {"id": "10007", "name": "개선  요청"}]
MOVE = {"site": SITE, "project": PROJECT, "project_id": MV.PID, "types": MV_TYPES,
        "excluded_types": [{"id": "10001", "name": "에픽", "why": "상위 유형(hierarchyLevel 1, 에픽 등)"}]}
MV_HEADER = HEADER.replace(b"groups=feat/*,issues,jira,pull-requests", b"groups=feat/*,issues,jira,move,pull-requests")


def mv_reason(n):
    return "이슈 %d은 재현 절차가 있고 아직 고친 변경이 없습니다." % n


def mv_keep(n, **kw):
    return dict({"VERDICT": "KEEP", "REASON": mv_reason(n), "JIRA_TYPE": "작업"}, **kw)


def mv_att(i):
    return "20261020T%06dZ-%08x" % (i, i)


def mv_journal(chore, n, att, events, run_id=MV.RUN_B, at=None):
    """이관 일지 줄(chore-jira.py mv_line)을 <run_id>.journal에 덧붙인다. events = [(사건, [(칸, 값)])]; sid·of 값 k →
    <run_id>/<att>/k (read_moves 규칙: seq는 attempt 안에서 1부터). at = 모든 줄의 시각(없으면 2026-10-20의 고정 시각 —
    고정물 머리 줄 created= 2026-10-15 뒤)."""
    chore.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, (ev, fields) in enumerate(events, 1):
        fl = [(k, "%s/%s/%s" % (run_id, att, v) if k in ("sid", "of") else v) for k, v in fields]
        lines.append(MV.CJ.mv_line(at or "2026-10-20T00:%02d:%02d.000Z" % (n % 60, i), att, "issue#%d" % n, ev, fl))
    with open(chore / (run_id + ".journal"), "a", encoding="utf-8") as fh:
        fh.write("".join(lines))


def mv_created(key, seq=1):
    return [("mv-create-sent", [("seq", str(seq)), ("acct", MV.ME)]), ("mv-create-ok", [("sid", str(seq)), ("key", key)])]


def mv_commented(key, body, cid, seq):
    sha = MV.CJ.sha_text(body)
    return [("mv-comment-sent", [("seq", str(seq)), ("key", key), ("tsha", sha)]),
            ("mv-comment-ok", [("sid", str(seq)), ("cid", str(cid)), ("csha", sha)])]


def mv_body(key, reason="다른 계획의 이유", date=MV.PLAN_DATE_B):
    """다른 계획이 이슈에 단 이관 댓글 본문(그 계획의 gh 틀에 KEY)."""
    return P.comment_body(P.move_comment(SITE, reason, date), key)


class MoveScn:
    """M 사례 하나: 가짜 gh(MV.GHS)·가짜 Jira(MV.FJ) 초기화 + 이 사례만의 git 클론(이관 일지 = <clone>/.git/chore)."""

    def __init__(self, name):
        MV.FJ.reset()
        MV.GHS.reset()
        self.root = W / name
        self.root.mkdir(parents=True)
        self.clone = self.root / "clone"
        sh("git", "init", "-q", self.clone)
        self.chore = self.clone / ".git" / "chore"
        self.items, self.k = [], 0

    def issue(self, n, v=None, briefs=(), ev_updated=None, row_updated=None, **gh):
        """가짜 GitHub 이슈 n + 판정 v(기본 KEEP · 작업). briefs = [(KEY, found)] = 증거의 언급 키(jira 목록)."""
        MV.GHS.add_issue(n, **gh)
        it = {"n": n, "v": mv_keep(n) if v is None else v, "briefs": list(briefs), "ev_updated": ev_updated,
              "row_updated": row_updated}
        self.items.append(it)
        return it

    def build(self, *extra, payloads=True, pre_payloads=False, move=MOVE, binding=BINDING, rows=None, gh_issues=(),
              env_extra=None, account=MV.ME, date=DATE, out=None, pdir=None, script=JUDGE, run_id=RUN_ID,
              preexec=None):
        """지금 가짜 GitHub 상태로 report 계획·증거·판정을 쓰고 build를 돌린다(이슈마다 증거 issue.updated = 지금 updatedAt)."""
        self.k += 1
        d = self.root / ("b%d" % self.k)
        vd = d / "verdicts"
        vd.mkdir(parents=True)
        plan_rows, units = [PASS_ROWS[0]], []
        for it in self.items:
            n, g = it["n"], MV.GHS.issue(it["n"])
            plan_rows.append(issue_row(n, it["row_updated"] or g["updated_at"], g["title"]))
            ev = issue_ev(n, g["title"])
            ev["issue"]["updated"] = it["ev_updated"] or g["updated_at"]
            ev["jira"] = [{"key": k, "found": f, "summary": "요약" if f else None, "status_name": "Waiting" if f else None,
                           "status_category": None, "assignee": None, "assignee_name": None, "last_comments": []}
                          for k, f in it["briefs"]]
            units.append((ev, True, ""))
            verdict(vd, "issue#%d" % n, **it["v"])
        plan = d / "plan.tsv"
        hdr = HEADER
        if run_id != RUN_ID:            # 새 report 계획 = 지금 만든 것(머리 줄 created= = 지금 — apply E1이 보고 시각과 비교한다)
            created = (datetime.now(timezone.utc) + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
            hdr = hdr.replace(b"\trun_id=" + RUN_ID.encode() + b"\t", b"\trun_id=" + run_id.encode() + b"\t")
            hdr = hdr.replace(b"\tcreated=" + P.penc(HDR["created"], sp=True) + b"\t",
                              b"\tcreated=" + P.penc(created, sp=True) + b"\t")
            assert b"run_id=" + run_id.encode() in hdr and P.penc(created, sp=True) in hdr
        plan.write_bytes(hdr + b"\n" + b"\n".join(plan_rows if rows is None else rows) + b"\n")
        write_ev(d / "ev", units, binding=binding, extra={"account": account, "move": move, "run_id": run_id})
        out, pdir = out or d / "final.tsv", pdir or d / "payloads"
        if pre_payloads:
            pdir.mkdir()
        args = ["build", "--plan", plan, "--ev", d / "ev", "--verdicts", vd, "--out", out, "--date", date,
                "--clone", self.clone] + (["--payloads", pdir] if payloads else []) + list(extra)
        env = gh_fix(d / "gh", None, prs=[], issues=list(gh_issues), runs=[])
        env.update(MV.gh_env())
        env.update({"CHORE_JIRA_BASE": MV.FJ.base, "JIRA_EMAIL": MV.EMAIL, "JIRA_API_TOKEN": MV.TOKEN})
        env.update(env_extra or {})
        rc, so, se = run_judge(*args, env=env, script=script, preexec=preexec)
        data = out.read_bytes() if out.is_file() else b""
        return {"rc": rc, "so": so, "se": se, "out": out, "pdir": pdir, "plan": plan, "data": data, "dir": d,
                "rows": rows_by_ref(data) if data else {}}


def mv_ok(r):
    eq((r["rc"], r["se"]), (0, ""), "build rc/stderr")


def mv_no_writes():
    """build는 읽기만: 가짜 Jira에 GET 아닌 요청 없음, 가짜 gh에 댓글 게시·닫기 없음."""
    eq(([x[:2] for x in MV.FJ.log if x[0] != "GET"], MV.GHS.calls("post"), MV.GHS.calls("close")), ([], [], []),
       "writes during build")


def mv_amb(r, n):
    row = r["rows"].get(("report", "issue#%d" % n))
    if row is None or row["unit"]["evidence"]["v"] != "AMBIGUOUS":
        raise AssertionError("issue#%d: not a tier-3 AMBIGUOUS row (%r)" % (n, row and row["unit"]["evidence"]))
    return row["unit"]["evidence"]


def mv_expect(scn, n, reason, related=(), type_id=MV.TYPE):
    """판정 build와 같은 함수로 따로 만든 기대값: 지금 가짜 GitHub 이슈(gh_issue) + 이 클론 일지의 R → issue_check."""
    MV.in_proc_env()
    view = MV.CJ.gh_issue(MV.REMOTE, n)
    R = MV.CJ.move_history(str(scn.chore), "issue#%d" % n)["R"]
    return MV.CJ.issue_check(view, {"project_id": MV.PID, "issuetype": type_id, "account": MV.ME},
                             {"reason": reason, "related": list(related)}, R, DATE, MV.REPO_URL)


@case("M1 KEEP + JIRA_TYPE → 그 자리에서 2 move-issue 행(ref·expected 그대로, snapshot MOVE_SNAP_KEYS 순서, 구조형 증거, "
      "related = 언급 키(found) ∪ 이 이슈를 적은 사람 티켓), payload 파일 바이트 = issue_check payload · sha == payload_sha, "
      "groups=에 move, stdout move-issue=1, chore.sh check-plan 통과")
def _():
    s = MoveScn("m1")
    s.issue(51, briefs=[("TST-7", True), ("TST-404", False)], comments=[(MV.HUMAN, "저도 봤습니다")])
    s.issue(52, v=dict(AMB, VERDICT="AMBIGUOUS", REASON="모르겠음"))
    human = MV.FJ.add_ticket(description={"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "참고: %s/issues/51 을 보고 만든 티켓" % MV.REPO_URL}]}]}, reporter=MV.OTHER, summary="사람 티켓")
    r = s.build()
    mv_ok(r)
    mv_no_writes()
    out, src = r["data"].split(b"\n"), r["plan"].read_bytes().split(b"\n")
    eq(out[0], MV_HEADER, "groups= gains move, nothing else in the header changes")
    eq(out[1], src[1], "pass-through row")
    eq((out[2].split(b"\t")[:2], out[2].split(b"\t")[2:4]), ([b"2", b"move-issue"], src[2].split(b"\t")[2:4]),
       "move row in place, ref/expected bytes of the input row")
    eq(out[3].split(b"\t")[:3], [b"3", b"report", b"issue#52"], "AMBIGUOUS issue stays a tier-3 row in place")
    row, g, reason = r["rows"][("move-issue", "issue#51")], MV.GHS.issue(51), mv_reason(51)
    ic = mv_expect(s, 51, reason, ["TST-7", human])
    eq(list(row["snapshot"]), list(P.MOVE_SNAP_KEYS), "snapshot key order")
    eq(row["snapshot"], {"state": "OPEN", "updated": g["updated_at"], "author": "frank", "title": g["title"], "site": SITE,
                         "project": PROJECT, "project_id": MV.PID, "issuetype": MV.TYPE, "issuetype_name": "작업",
                         "account": MV.ME, "gh_login": MV.LOGIN, "source_sha": ic["source_sha"],
                         "payload_sha": ic["payload_sha"], "adopt": "-", "prior": "-"}, "snapshot")
    m = row["move"]
    eq((m["reason"], m["gh"], m["related"], m["plan_date"], m["adopt"], m["prior"]),
       (reason, P.move_comment(SITE, reason, DATE), ["TST-7", human], DATE, None, None), "structured evidence")
    eq(sorted(os.listdir(r["pdir"])), ["issue-51.json"], "one payload file per move row, nothing else")
    data = (r["pdir"] / "issue-51.json").read_bytes()
    eq((data == ic["payload"], hashlib.sha256(data).hexdigest(), P.canon_json(json.loads(data)) == data),
       (True, row["snapshot"]["payload_sha"], True), "payload file")
    blocks = P.parse_blocks(json.loads(data)["fields"]["description"])
    eq((blocks[3], blocks[4], ("codeBlock", "저도 봤습니다") in blocks),
       (("paragraph", "남기는 이유: " + reason), ("paragraph", "관련: TST-7, " + human), True), "description blocks")
    c = counts_of(r["so"])
    eq((r["so"].split("\n")[0].endswith(" held=0 move-issue=1"), c["keep"], c["ambiguous"], c["gate-downgraded"]),
       (True, "0", "1", "0"), "stdout counts")
    has(r["so"], "build: sha256=" + hashlib.sha256(r["data"]).hexdigest(), "sha line")
    j, hdr, idx = judge_mod(), P.parse_header(HEADER), {"inventory": {"jira": {"total": 0}}}
    j.self_check(r["data"], HEADER, hdr, BINDING, idx, {51: data})
    for bad in ({}, {51: data + b" "}, {51: data, 52: data}):
        try:
            j.self_check(r["data"], HEADER, hdr, BINDING, idx, bad)
            raise AssertionError("self_check accepted payloads for %r" % sorted(bad))
        except j.Fail as e:
            has(str(e), "설명 파일", "self_check")
    p = subprocess.run(["bash", str(SCRIPTS / "chore.sh"), "check-plan", "--plan", str(r["out"])], capture_output=True,
                       env=ENV, timeout=60)
    eq((p.returncode, p.stderr.decode()[-300:]), (0, ""), "chore.sh check-plan")


@case("M2 JIRA_TYPE 없음·목록에 없음 → AMBIGUOUS(MISSING '옮길 Jira 유형', OWNER me, KNOWN에 판정 이유) · .md 꼴(공백 접기·백틱까지)로 "
      "적은 유형 → 그 유형의 원문 id·이름")
def _():
    s = MoveScn("m2")
    s.issue(53, v={"VERDICT": "KEEP", "REASON": mv_reason(53)})
    s.issue(54, v=mv_keep(54, JIRA_TYPE="스토리"))
    s.issue(55, v=mv_keep(55, JIRA_TYPE="개선 요청"))
    s.issue(56, v=mv_keep(56, JIRA_TYPE="`버그`"))
    for tid in ("10005", "10007"):
        MV.FJ.createmeta[tid] = MV.FJ.createmeta[MV.TYPE]
    r = s.build()
    mv_ok(r)
    for n, part in ((53, "고르지 않음"), (54, "스토리")):
        ev = mv_amb(r, n)
        eq((ev["missing"], ev["owner"]), ("옮길 Jira 유형", "me"), "issue#%d" % n)
        has(ev["reason"], part, "reason")
        has(ev["known"], mv_reason(n), "known keeps the verdict reason")
    got = {n: tuple(r["rows"][("move-issue", "issue#%d" % n)]["snapshot"][k] for k in ("issuetype", "issuetype_name"))
           for n in (55, 56)}
    eq(got, {55: ("10007", "개선  요청"), 56: ("10005", "버그")}, "type id + raw name")
    c = counts_of(r["so"])
    eq((c["move-issue"], c["ambiguous"], c["keep"], c["gate-downgraded"]), ("2", "2", "0", "2"), "never silently KEEP")


@case("M3 JIRA_TYPE는 이슈 판정에만: PR·Jira 판정 = 형식 오류(build exit 1, 계획 없음), 두 번 = 형식 오류, 이슈 판정은 받음")
def _():
    j = judge_mod()
    eq(bad_verdict("UNIT: pr#7\nVERDICT: KEEP\nREASON: x\nJIRA_TYPE: 작업\n", kind="pr"),
       "JIRA_TYPE는 이슈 판정에만 쓰는 필드", "pr")
    eq(bad_verdict("UNIT: jira#TST-1\nVERDICT: KEEP\nREASON: x\nJIRA_TYPE: 작업\n"), "JIRA_TYPE는 이슈 판정에만 쓰는 필드", "jira")
    eq(j.parse_verdict("UNIT: issue#9\nVERDICT: KEEP\nREASON: x\nJIRA_TYPE:  작업 \n", "issue#9", "issue", [])["jira_type"],
       "작업", "issue")
    eq(j.parse_verdict("UNIT: issue#9\nVERDICT: KEEP\nREASON: x\n", "issue#9", "issue", [])["jira_type"], None, "absent")
    try:
        j.parse_verdict("UNIT: issue#9\nVERDICT: KEEP\nREASON: x\nJIRA_TYPE: 작업\nJIRA_TYPE: 버그\n", "issue#9", "issue", [])
        raise AssertionError("duplicate JIRA_TYPE accepted")
    except j.Malformed as e:
        eq(str(e), "필드 JIRA_TYPE가 두 번", "duplicate")
    rows = [pr_row(7, "2026-09-01T03:04:05Z", "c" * 40, "A")]
    rc, so, se, out = small("m3", [(pr_ev(7, "A"), True, "")], rows,
                            [("pr#7", dict(VERDICT="KEEP", REASON="x", JIRA_TYPE="작업"))], binding=None)
    eq((rc, so, out.exists()), (1, "", False), "build")
    has(se, "pr#7 (JIRA_TYPE는 이슈 판정에만 쓰는 필드)", "stderr")


@case("M4 §5-1 이 이슈의 미결 전송(만들기 · 댓글 — 다른 계획의 일지) → AMBIGUOUS '이전 실행 결과 미확정 — resolve', KNOWN에 sid")
def _():
    s = MoveScn("m4")
    s.issue(61)
    s.issue(62)
    mv_journal(s.chore, 61, mv_att(1), [("mv-create-sent", [("seq", "1"), ("acct", MV.ME)])])
    key = MV.ours_ticket(MV.FJ, 62)
    mv_journal(s.chore, 62, mv_att(2), mv_created(key) + [("mv-comment-sent", [("seq", "2"), ("key", key),
                                                                               ("tsha", "a" * 64)])])
    r = s.build()
    mv_ok(r)
    for n, sid in ((61, "%s/%s/1" % (MV.RUN_B, mv_att(1))), (62, "%s/%s/2" % (MV.RUN_B, mv_att(2)))):
        ev = mv_amb(r, n)
        eq((ev["missing"], ev["owner"]), ("이전 실행 결과 미확정 — resolve", "me"), "issue#%d" % n)
        has(ev["known"], sid, "known names the pending send")
    eq(os.listdir(r["pdir"]), [], "no move rows → empty payload folder")
    mv_no_writes()


@case("M5 §5-2 다른 계정의 chore 티켓이 이 이슈를 가리킴(b) → AMBIGUOUS, KNOWN에 그 키")
def _():
    s = MoveScn("m5")
    s.issue(63)
    key = MV.ours_ticket(MV.FJ, 63, reporter=MV.OTHER)
    r = s.build()
    mv_ok(r)
    ev = mv_amb(r, 63)
    eq(ev["missing"], "다른 계정의 chore 티켓이 이 이슈를 가리킴", "missing")
    has(ev["known"], key, "known")


@case("M6 §5-3 T 1개 · ticket_check(orig) 통과 → adopt=KEY, prior = 그 KEY의 기록된 이관 댓글 0개 '-' · 1개 cid:csha · "
      "2개 → AMBIGUOUS(M8); adopt KEY는 related에서 빠지고 gh 틀은 {KEY} 두 번, payload는 R로 거른 댓글로")
def _():
    s = MoveScn("m6")
    s.issue(64)
    i65 = s.issue(65)
    s.issue(66)
    k64 = MV.ours_ticket(MV.FJ, 64)                       # 출처 B에서만(일지에 없음) — 이 계정·이 이슈 모양
    k65 = MV.ours_ticket(MV.FJ, 65)
    b65 = mv_body(k65)
    c65 = MV.GHS.comment(65, MV.LOGIN, b65)
    mv_journal(s.chore, 65, mv_att(5), mv_created(k65) + mv_commented(k65, b65, c65, 2))
    i65["briefs"].append((k65, True))                     # 이관 댓글이 그 키를 적으므로 증거의 언급 키에도 나온다
    k66 = MV.ours_ticket(MV.FJ, 66)
    b66 = mv_body(k66)
    c66a, c66b = MV.GHS.comment(66, MV.LOGIN, b66), MV.GHS.comment(66, MV.LOGIN, b66)
    mv_journal(s.chore, 66, mv_att(6), mv_created(k66) + mv_commented(k66, b66, c66a, 2) + mv_commented(k66, b66, c66b, 3))
    r = s.build()
    mv_ok(r)
    r64, r65 = (r["rows"][("move-issue", "issue#%d" % n)] for n in (64, 65))
    eq((r64["snapshot"]["adopt"], r64["snapshot"]["prior"]), (k64, "-"), "adopt from source B, no prior")
    sha = MV.CJ.sha_text(b65)
    eq((r65["snapshot"]["adopt"], r65["snapshot"]["prior"]), (k65, "%s:%s" % (c65, sha)), "adopt + prior")
    eq((r65["move"]["adopt"], r65["move"]["prior"], r65["move"]["related"], r65["move"]["gh"].count("{KEY}")),
       (k65, {"cid": str(c65), "csha": sha}, [], 2), "decoded row")
    ic = mv_expect(s, 65, mv_reason(65))
    eq((r65["snapshot"]["payload_sha"], r65["snapshot"]["source_sha"]), (ic["payload_sha"], ic["source_sha"]),
       "payload from the R-filtered comments")
    eq((mv_amb(r, 66)["missing"], sorted(os.listdir(r["pdir"]))), (MV.CJ.M8, ["issue-64.json", "issue-65.json"]),
       "two recorded migration comments → decision; payload files of the move rows")
    mv_no_writes()


@case("M7 §5-3 T 1개인데 승인본과 다름(만든 뒤 이슈에 새 댓글) · T 2개(M4) → AMBIGUOUS")
def _():
    s = MoveScn("m7")
    s.issue(67)
    s.issue(68)
    k67 = MV.ours_ticket(MV.FJ, 67)
    MV.GHS.comment(67, MV.HUMAN, "옮긴 뒤에 단 새 댓글")
    a68, b68 = MV.ours_ticket(MV.FJ, 68), MV.ours_ticket(MV.FJ, 68)
    r = s.build()
    mv_ok(r)
    eq(mv_amb(r, 67)["missing"], "이미 만든 티켓 %s가 승인본과 다름(티켓 수정 또는 이슈 변경)" % k67, "T=1 mismatch")
    ev = mv_amb(r, 68)
    eq(ev["missing"], MV.CJ.M4, "T=2")
    has(ev["known"], "%s, %s" % (a68, b68), "known lists the tickets")


@case("M8 §5-4 기록된 이관 댓글이 지워짐(M6) · 기록 없는 이관 댓글(M10) → AMBIGUOUS; 기존 chore 닫기 댓글(다른 표지)은 보통 댓글")
def _():
    s = MoveScn("m8")
    s.issue(69)
    s.issue(70)
    s.issue(71, comments=[(MV.LOGIN, "예전 정리 댓글입니다.\n" + MV.deleted_comment_marker())])
    k69 = MV.ours_ticket(MV.FJ, 69)
    b69 = mv_body(k69)
    c69 = MV.GHS.comment(69, MV.LOGIN, b69)
    mv_journal(s.chore, 69, mv_att(9), mv_created(k69) + mv_commented(k69, b69, c69, 2))
    MV.GHS.delete_comment(69, c69)
    MV.GHS.comment(70, MV.LOGIN, mv_body("TST-555"))
    r = s.build()
    mv_ok(r)
    eq((mv_amb(r, 69)["missing"], mv_amb(r, 70)["missing"]), (MV.CJ.M6, MV.CJ.M10), "recorded_bad · unrecorded")
    blocks = P.parse_blocks(json.loads((r["pdir"] / "issue-71.json").read_bytes())["fields"]["description"])
    eq(("codeBlock", "예전 정리 댓글입니다.\n" + MV.deleted_comment_marker()) in blocks, True, "old chore comment carried")


@case("M9 판정 뒤 바뀜(증거 updated ≠ 지금) · 계획 뒤 바뀜(expected ≠ 지금) · 이미 닫힘 → 그 이슈만 AMBIGUOUS · GitHub 읽기 실패 → "
      "'확인 못 함'")
def _():
    s = MoveScn("m9")
    s.issue(72, ev_updated="2026-10-01T00:00:00Z")
    s.issue(73, row_updated="2026-10-01T00:00:00Z")
    s.issue(74)
    MV.GHS.set_issue(74, state="closed", closed_at="2026-10-21T00:10:00Z")
    s.issue(75)
    r = s.build()
    mv_ok(r)
    eq([mv_amb(r, n)["missing"] for n in (72, 73, 74)],
       ["판정 뒤 이슈가 바뀜 — 다음 계획에서", "계획 뒤 이슈가 바뀜 — 다음 계획에서", "이슈가 이미 닫혀 있음 — 다음 계획에서"], "missing")
    eq(("move-issue", "issue#75") in r["rows"], True, "the unchanged issue still moves")
    MV.GHS.mode("comments", "fail")
    r = s.build()
    mv_ok(r)
    eq(mv_amb(r, 75)["missing"], "확인 못 함: GitHub 이슈 #75", "read failure = decision, not a crash")


@case("M10 유형의 생성 화면 없음 → AMBIGUOUS '티켓 유형을 만들 수 없음 — …'(다른 유형은 옮김) · 프로젝트 id가 증거 때와 다름 → "
      "모든 KEEP 이슈 AMBIGUOUS(프로젝트 읽기 1번) · Jira 인증 실패 → exit 1, 아무것도 안 씀")
def _():
    s = MoveScn("m10")
    s.issue(76, v=mv_keep(76, JIRA_TYPE="버그"))
    s.issue(77)
    s.issue(78, v=mv_keep(78, JIRA_TYPE="버그"))
    k78 = MV.ours_ticket(MV.FJ, 78)
    r = s.build()
    mv_ok(r)
    ev = mv_amb(r, 76)
    eq((ev["missing"], ev["decider"]), (MV.CJ.MT_TYPE + "유형 10005의 생성 화면을 찾을 수 없음 (HTTP 404)", "Jira 프로젝트 관리자"),
       "createmeta")
    eq(("move-issue", "issue#77") in r["rows"], True, "other type still moves")
    eq(r["rows"][("move-issue", "issue#78")]["snapshot"]["adopt"], k78, "adopt row: no create, no createmeta check (S4)")
    n0 = len(MV.FJ.log)
    r = s.build(move=dict(MOVE, project_id="10099"))
    mv_ok(r)
    eq([mv_amb(r, n)["missing"] for n in (76, 77, 78)], ["Jira 프로젝트가 증거 때와 다름"] * 3, "project mismatch")
    eq((sum(1 for x in MV.FJ.log[n0:] if x[1] == "project"), os.listdir(r["pdir"])), (1, []), "read once")
    MV.FJ.modes["project"] = "401"
    r = s.build()
    eq((r["rc"], r["so"], r["out"].exists(), os.path.exists(r["pdir"])), (1, "", False, False), "auth failure")
    has(r["se"], "Jira 인증 실패", "stderr")


@case("M11 옮기는 저장소에서 근거가 jira:뿐인 이슈 CLOSE(자기 인용은 세지 않음) → AMBIGUOUS 'Jira 티켓만 근거인 닫기 — 사람이 판단' · "
      "다른 근거도 있으면 닫기 · index move가 없으면 그대로 닫기")
def _():
    s = MoveScn("m11")
    close = {"VERDICT": "CLOSE", "REASON": "TST-5에서 같은 일을 하고 있습니다"}
    s.issue(81, v=dict(close, CITES="jira:TST-5, issue:81"))
    s.issue(82, v=dict(close, CITES="jira:TST-5, issue:3"))
    MV.FJ.add_ticket("TST-5", summary="근거 티켓")
    gh = [{"number": 3, "state": "CLOSED", "title": "옛 이슈"}, {"number": 81, "state": "OPEN", "title": "이슈 81"},
          {"number": 82, "state": "OPEN", "title": "이슈 82"}]
    got = {}
    for move in (MOVE, None):
        r = got[move is None] = s.build(move=move, gh_issues=gh)
        mv_ok(r)
    eq([(("close-issue", "issue#81") in got[x]["rows"], ("close-issue", "issue#82") in got[x]["rows"]) for x in (0, 1)],
       [(False, True), (True, True)], "close rows (moving repo · not moving)")
    ev = mv_amb(got[False], 81)
    eq((ev["missing"], ev["owner"], ev["decider"]), ("Jira 티켓만 근거인 닫기 — 사람이 판단", "me", "이 저장소 정리 담당(나)"),
       "jira-only close")
    has(ev["reason"], "판정(닫기)", "reason")


@case("M12 옮기지 않는 저장소(index move null — 바인딩 없음·있음): KEEP + JIRA_TYPE = JIRA_TYPE 없을 때와 같은 바이트, "
      "move 읽기 0번, move-issue=0, --payloads = 빈 폴더")
def _():
    s = MoveScn("m12")
    s.issue(83)
    outs = []
    for binding in (None, BINDING):
        for v in (mv_keep(83), {"VERDICT": "KEEP", "REASON": mv_reason(83)}):
            s.items[0]["v"] = v
            r = s.build(move=None, binding=binding)
            mv_ok(r)
            eq((r["so"].split("\n")[0].endswith(" held=0 move-issue=0"), os.listdir(r["pdir"])), (True, []), "out")
            eq(r["rows"][("report", "issue#83")]["unit"]["evidence"]["v"], "KEEP", "stays KEEP")
            outs.append(r["data"])
    eq((outs[0] == outs[1], outs[2] == outs[3], outs[0].split(b"\n", 1)[0]), (True, True, HEADER), "byte-identical")
    eq((MV.GHS.read()["log"], MV.FJ.log), ([], []), "no gh / Jira reads for moves")


@case("M13 --hold-area move → move 행 전부 tier-3 KEEP '이번 승인에서 뺌'(--payloads 없이) · --hold issue#N → 그 행만, 다른 move "
      "행과 그 payload 파일은 그대로")
def _():
    s = MoveScn("m13")
    s.issue(84)
    s.issue(85)
    r = s.build("--hold-area", "move", payloads=False)
    mv_ok(r)
    for n in (84, 85):
        row = r["rows"][("report", "issue#%d" % n)]
        eq((row["snapshot"]["verdict"], row["unit"]["evidence"]["v"], row["unit"]["evidence"]["reason"]),
           ("KEEP", "KEEP", "이번 승인에서 뺌"), "issue#%d held" % n)
        has(row["unit"]["evidence"]["known"], "판정 의견(Jira로 옮기기): " + mv_reason(n), "known")
    c = counts_of(r["so"])
    eq((c["held"], c["keep"], c["move-issue"], r["data"].split(b"\n", 1)[0]), ("2", "2", "0", HEADER), "counts/header")
    r = s.build("--hold", "issue#84")
    mv_ok(r)
    eq((r["rows"][("report", "issue#84")]["unit"]["evidence"]["reason"], ("move-issue", "issue#85") in r["rows"],
        sorted(os.listdir(r["pdir"])), counts_of(r["so"])["held"]), ("이번 승인에서 뺌", True, ["issue-85.json"], "1"),
       "only the named row")


@case("M14 --payloads: move 행이 있는데 없음 → exit 1 · 이미 있는 폴더 → exit 1(GitHub·Jira 읽기 전) — 둘 다 계획을 쓰지 않음")
def _():
    s = MoveScn("m14")
    s.issue(86)
    r = s.build(payloads=False)
    eq((r["rc"], r["so"], r["out"].exists()), (1, "", False), "missing --payloads")
    has(r["se"], "--payloads DIR", "stderr")
    n0, j0 = len(MV.GHS.read()["log"]), len(MV.FJ.log)
    r = s.build(pre_payloads=True)
    eq((r["rc"], r["so"], r["out"].exists(), os.listdir(r["pdir"])), (1, "", False, []), "existing folder")
    has(r["se"], "이미 있음", "stderr")
    eq((len(MV.GHS.read()["log"]), len(MV.FJ.log)), (n0, j0), "refused before any read")


@case("M15 입력 계획에 이미 move-issue 행 → exit 1 (report 계획만 받는다)")
def _():
    s = MoveScn("m15")
    s.issue(87)
    r = s.build()
    mv_ok(r)
    line = next(x for x in r["data"].split(b"\n") if x.startswith(b"2\tmove-issue\t"))
    r = s.build(rows=[PASS_ROWS[0], line])
    eq((r["rc"], r["out"].exists()), (1, False), "rc")
    has(r["se"], "이미 move-issue 행이 있음", "stderr")


@case("M16 move-issue 행 0개 + --payloads → 빈 폴더(임시 폴더 → rename), 계획 바이트·stdout은 --payloads 없을 때와 같음 "
      "(옮기는 저장소 · 옮기지 않는 저장소)")
def _():
    s = MoveScn("m16")
    s.issue(91, v=dict(AMB, VERDICT="AMBIGUOUS", REASON="모르겠음"))
    for move in (MOVE, None):
        a, b = s.build(move=move), s.build(move=move, payloads=False)
        mv_ok(a)
        mv_ok(b)
        eq((os.path.isdir(a["pdir"]), os.listdir(a["pdir"]), os.path.exists(b["pdir"])), (True, [], False), "folders")
        eq((a["data"], a["so"]), (b["data"], b["so"]), "plan bytes and stdout do not depend on --payloads")
        eq([x for x in os.listdir(a["pdir"].parent) if x.startswith(".payloads.tmp-")], [], "no temp folder left")


CJ_ADOPT_ONE = r"""
# chore-jira.py 감싸개(M17): 실물을 그대로 내보내되 live_candidates는 언제나 T = [TST-900], ticket_check는 언제나 통과 —
# 두 이슈가 한 티켓을 adopt하는 상태(실물 술어로는 블록 1·표지가 이슈마다 달라 만들기 어려움)를 build에 준다.
import importlib.util
_spec = importlib.util.spec_from_file_location("chore_jira_real", %r)
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)
for _k in dir(_m):
    if not _k.startswith("__"):
        globals()[_k] = getattr(_m, _k)


def live_candidates(c, hist, src_b, account, repo_url, n):
    return ["TST-900"], [], [], []


def ticket_check(c, key, mode, expected_payload_bytes, acct, repo_url, n):
    return None
"""


@case("M17 같은 adopt KEY를 move-issue 행 둘이 씀 → 두 행 모두 AMBIGUOUS '이미 만든 티켓 KEY를 여러 이슈가 가리킴 — 사람이 판단'"
      "(OWNER me), build exit 0 · 그 KEY를 한 행만 쓰면 adopt 행")
def _():
    wrap = W / "cj_adopt_one.py"
    wrap.write_text(CJ_ADOPT_ONE % str(REAL_CJ))
    env = {"CHORE_JIRA_PY": str(wrap)}
    s = MoveScn("m17")
    s.issue(92)
    r = s.build(env_extra=env)
    mv_ok(r)
    eq(r["rows"][("move-issue", "issue#92")]["snapshot"]["adopt"], "TST-900", "one issue: adopt row")
    s.issue(93)
    r = s.build(env_extra=env)
    mv_ok(r)
    for n in (92, 93):
        ev = mv_amb(r, n)
        eq((ev["missing"], ev["owner"]), ("이미 만든 티켓 TST-900를 여러 이슈가 가리킴 — 사람이 판단", "me"), "issue#%d" % n)
        has(ev["known"], "issue#92, issue#93", "known names both issues")
    c = counts_of(r["so"])
    eq((c["move-issue"], c["ambiguous"], c["gate-downgraded"], os.listdir(r["pdir"])), ("0", "2", "2", []), "counts")


@case("M18 --out과 --payloads가 겹침(--out이 DIR 안 · DIR 자체 · DIR가 --out 경로 안, 대소문자만 다름 포함) → exit 1, "
      "GitHub·Jira 읽기 전, 아무것도 안 씀")
def _():
    s = MoveScn("m18")
    s.issue(101)
    base = s.root / "w"
    base.mkdir()
    n0, j0 = len(MV.GHS.read()["log"]), len(MV.FJ.log)
    for out, pdir in ((base / "p" / "final.tsv", base / "p"), (base / "same", base / "same"),
                      (base / "o", base / "o" / "p"), (base / "P" / "final.tsv", base / "p")):
        r = s.build(out=out, pdir=pdir)
        eq((r["rc"], r["so"], os.listdir(base)), (1, "", []), "overlap %s · %s" % (out.name, pdir.name))
        has(r["se"], "겹침", "stderr")
    eq((len(MV.GHS.read()["log"]), len(MV.FJ.log)), (n0, j0), "refused before any read")
    r = s.build(out=base / "final.tsv", pdir=base / "payloads")
    mv_ok(r)
    eq(sorted(os.listdir(base)), ["final.tsv", "payloads"], "side by side is fine")


FAULT_POINTS = ("payloads-renamed", "payloads-returned", "plan-mid-write")   # chore-judge.py _fault 지점


def leftovers(d):
    return sorted(x for x in os.listdir(d) if x.startswith("."))


@case("M19 publish는 반쪽을 남기지 않음 — 실물 writer 안의 고장 주입(CHORE_JUDGE_TEST_FAULT): DIR rename 직후 · write_payloads가 "
      "돌아온 직후 · 계획 임시 파일 반쯤에 SIGINT·SIGTERM → 막아 둔 신호가 둘 다 놓인 뒤 전달(exit 1 '다 쓴 뒤', 계획 바이트·설명 "
      "파일 = 정상 build) · 같은 지점의 신호 아닌 예외 → exit 1, 계획·DIR·임시 파일 없음 · --out <없는 폴더> → 같음")
def _():
    s = MoveScn("m19")
    s.issue(102)
    r0 = s.build()
    mv_ok(r0)
    want_sha = r0["rows"][("move-issue", "issue#102")]["snapshot"]["payload_sha"]
    for point in FAULT_POINTS:
        for how in ("int", "term"):
            r = s.build(env_extra={"CHORE_JUDGE_TEST_FAULT": "%s:%s" % (point, how)})
            what = "%s:%s" % (point, how)
            eq((r["rc"], r["so"], r["se"]), (1, "", "chore-judge: build: 중단 신호를 받음 — 계획과 설명 파일 폴더를 다 쓴 뒤"
                                                 "(그대로 둠)\n"), what)
            eq((r["data"], os.listdir(r["pdir"]), leftovers(r["dir"])), (r0["data"], ["issue-102.json"], []), what)
            eq(hashlib.sha256((r["pdir"] / "issue-102.json").read_bytes()).hexdigest(), want_sha, what + " payload")
        r = s.build(env_extra={"CHORE_JUDGE_TEST_FAULT": point + ":raise"})
        eq((r["rc"], r["so"], r["out"].exists(), r["pdir"].exists(), leftovers(r["dir"])), (1, "", False, False, []),
           point + ":raise")
        has(r["se"], "test fault at " + point, point + ":raise stderr")
    r = s.build(out=s.root / "no-such-dir" / "final.tsv")
    eq((r["rc"], r["so"], os.path.exists(r["out"]), os.path.exists(r["pdir"])), (1, "", False, False), "missing out dir")
    has(r["se"], "출력을 쓸 수 없음", "stderr")
    j = judge_mod()
    real, calls = j._fsync_dir, []

    def flaky(path):
        calls.append(str(path))
        if len(calls) == 2:               # 1 = 임시 폴더, 2 = rename 뒤 부모 폴더
            raise OSError(5, "I/O error")
        real(path)
    target = W / "m19-fsync" / "payloads"
    target.parent.mkdir()
    j._fsync_dir = flaky
    try:
        j.write_payloads(target, {"issue-1.json": b"{}"})
        raise AssertionError("parent fsync failure accepted")
    except j.Fail as e:
        has(str(e), "설명 파일 폴더를 쓸 수 없음", "message")
    finally:
        j._fsync_dir = real
    eq((len(calls), os.listdir(target.parent)), (2, []), "DIR removed after a failed parent fsync, no temp folder")


@case("M19b 계획 writer의 임시 파일은 어떤 예외로 끝나도 지움(OSError 밖 — 반쯤 쓴 때 KeyboardInterrupt, 신호를 막지 않은 직접 호출)")
def _():
    j, d = judge_mod(), W / "m19b"
    d.mkdir()
    os.environ["CHORE_JUDGE_TEST_FAULT"] = "plan-mid-write:int"
    try:
        j.write_atomic(d / "final.tsv", b"x" * 1000)
        raise AssertionError("no KeyboardInterrupt")
    except KeyboardInterrupt:
        pass
    finally:
        del os.environ["CHORE_JUDGE_TEST_FAULT"]
    eq(os.listdir(d), [], "no plan, no temp file")


@case("M20 증거의 Jira 계정: 비었음 → AMBIGUOUS '내 Jira 계정을 모름' · 일지에 적을 수 없는 모양(chore-jira ACCT_RE 밖) → "
      "AMBIGUOUS — 둘 다 GitHub·Jira 읽기 없음")
def _():
    s = MoveScn("m20")
    s.issue(103)
    for account, want in (("", "내 Jira 계정을 모름"), ("712020:aaaa bbbb", "내 Jira 계정을 일지에 적을 수 없는 모양")):
        r = s.build(account=account)
        mv_ok(r)
        ev = mv_amb(r, 103)
        eq((ev["missing"], ev["owner"]), (want, "me"), repr(account))
    eq((MV.GHS.read()["log"], MV.FJ.log), ([], []), "no reads")


@case("M21 T 1개가 이 계획(머리 줄 run_id)의 전송으로 만든 티켓 → AMBIGUOUS '이 계획이 이미 만든 티켓 KEY — 승인된 계획으로 다시 실행' "
      "(다른 계획이 만든 티켓은 M6처럼 adopt)")
def _():
    s = MoveScn("m21")
    s.issue(104)
    s.issue(105)
    k104, k105 = MV.ours_ticket(MV.FJ, 104), MV.ours_ticket(MV.FJ, 105)
    mv_journal(s.chore, 104, mv_att(21), mv_created(k104), run_id=RUN_ID)
    mv_journal(s.chore, 105, mv_att(22), mv_created(k105), run_id=MV.RUN_B)
    r = s.build()
    mv_ok(r)
    ev = mv_amb(r, 104)
    eq((ev["missing"], ev["owner"]), ("이 계획이 이미 만든 티켓 %s — 승인된 계획으로 다시 실행" % k104, "me"), "this plan")
    eq(r["rows"][("move-issue", "issue#105")]["snapshot"]["adopt"], k105, "another plan's ticket is adopted")


@case("M22 --date는 달력에 있는 날(chore_plan 계획 날짜 규칙): 2026-02-30 · 2026-13-01 · 2026-1-01 → 사용법 오류 exit 2, 계획 없음 · "
      "2028-02-29 → 받음")
def _():
    s = MoveScn("m22")
    s.issue(106)
    for d in ("2026-02-30", "2026-13-01", "2026-1-01"):
        r = s.build(date=d)
        eq((r["rc"], r["so"], r["out"].exists()), (2, "", False), d)
        has(r["se"], "--date는 달력에 있는 날", d)
    r = s.build(date="2028-02-29")
    mv_ok(r)
    eq(r["rows"][("move-issue", "issue#106")]["move"]["plan_date"], "2028-02-29", "plan date")


@case("M23 지금 있는 이관 기록 댓글(R)의 티켓이 T에도 지워진 티켓에도 없음(다른 계획이 출처 B로 adopt하고 댓글만 기록, 그 뒤 티켓의 표지 "
      "문단을 지움) → AMBIGUOUS '기록된 티켓 KEY를 이 이슈의 티켓으로 확인할 수 없음 — 사람이 판단' (새로 만들지 않음)")
def _():
    s = MoveScn("m23")
    s.issue(107)
    key = MV.ours_ticket(MV.FJ, 107)
    body = mv_body(key)
    cid = MV.GHS.comment(107, MV.LOGIN, body)
    mv_journal(s.chore, 107, mv_att(23), mv_commented(key, body, cid, 1))
    desc = MV.FJ.tickets[key]["description"]
    desc["content"] = desc["content"][:-1]                # 표지 문단 삭제 → chore 모양 아님 → 후보 c(사람 티켓)로 읽힘
    r = s.build()
    mv_ok(r)
    ev = mv_amb(r, 107)
    eq((ev["missing"], ev["owner"]), ("기록된 티켓 %s를 이 이슈의 티켓으로 확인할 수 없음 — 사람이 판단" % key, "me"), "orphan")
    eq((os.listdir(r["pdir"]), MV.FJ.creates()), ([], []), "no move row, no create")


def mv_apply(s, r, run_id=RUN_ID, env_extra=None):
    """build가 쓴 계획(r["out"])을 실물 chore-jira.py apply-rows로(가짜 Jira·가짜 gh, 일지 = 이 클론의 <run_id>.journal).
    → (rc, {ref: (상태, 이유)}, stderr)."""
    md = s.root / "repos.md"
    md.write_text(MV.REPOS_MD, encoding="utf-8")
    s.k += 1
    att = "20261023T%06dZ-%08x" % (s.k, s.k)
    s.chore.mkdir(parents=True, exist_ok=True)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.path.join(MV.root(), "home"),
           "CHORE_JIRA_BASE": MV.FJ.base, "JIRA_EMAIL": MV.EMAIL, "JIRA_API_TOKEN": MV.TOKEN, "CHORE_JIRA_TIMEOUT": "5",
           "CHORE_JIRA_RETRY_SLEEP": "0", "CHORE_JIRA_J2_SLEEP": "0"}
    env.update(MV.gh_env())
    env.update(env_extra or {})
    p = subprocess.run([sys.executable, "-I", MV.SCRIPT, "apply-rows", "--plan", str(r["out"]), "--attempt", att,
                        "--journal", str(s.chore / (run_id + ".journal")), "--lock", str(s.chore / (run_id + ".lock")),
                        "--parent-pid", str(os.getpid()), "--repos-md", str(md), "--remote", MV.REMOTE, "--clone",
                        str(s.clone), "--judge", "/nonexistent-judge"], capture_output=True, env=env, timeout=120)
    got = {c[3]: (c[1], c[4]) for c in (x.split("\t") for x in p.stdout.decode("utf-8").split("\n") if x)
           if c[0] == "RESULT"}
    return p.returncode, got, p.stderr.decode("utf-8")


@case("M24 왕복: build의 final.tsv를 실물 chore-jira.py apply-rows(가짜 Jira·가짜 gh)로 — 새 행 = F1 content_ok 통과, POST 바이트 "
      "= 설명 파일 바이트, 댓글, 닫기 → OK moved · adopt 행 = A2 → C → 닫기, POST /issue 없음")
def _():
    s = MoveScn("m24")
    s.issue(108, comments=[(MV.HUMAN, "재현됩니다")])
    s.issue(109)
    k109 = MV.ours_ticket(MV.FJ, 109)
    r = s.build()
    mv_ok(r)
    rows = r["rows"]
    eq((rows[("move-issue", "issue#108")]["snapshot"]["adopt"], rows[("move-issue", "issue#109")]["snapshot"]["adopt"]),
       ("-", k109), "built rows")
    rc, got, err = mv_apply(s, r)
    eq((rc, err[-300:]), (0, ""), "apply-rows rc/stderr")
    key = next(k for k in MV.FJ.tickets if k != k109)
    eq(got, {"issue#108": ("OK", "moved: %s — %s" % (key, MV.CJ.MT_MOVED_NEW)),
             "issue#109": ("OK", "moved: %s — %s" % (k109, MV.CJ.MT_MOVED_OLD))}, "RESULT lines")
    eq((len(MV.FJ.creates()), MV.FJ.bodies), (1, [(r["pdir"] / "issue-108.json").read_bytes()]),
       "one POST /issue, exactly the payload file bytes")
    for n, k in ((108, key), (109, k109)):
        mig = MV.GHS.migration(n)
        eq((MV.GHS.issue(n)["state"], len(mig), mig[0]["body"]),
           ("closed", 1, P.comment_body(rows[("move-issue", "issue#%d" % n)]["move"]["gh"], k)), "issue#%d" % n)


CJ_PLAN_BAD_ROW = r"""
# chore_plan.py 감싸개(M25): 실물을 그대로 내보내되 check_move_issue만 PlanError — build가 행 검사 실패를 결정 필요로 바꾸는지.
import importlib.util
_spec = importlib.util.spec_from_file_location("chore_plan_real", %r)
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)
for _k in dir(_m):
    if not _k.startswith("__"):
        globals()[_k] = getattr(_m, _k)


def check_move_issue(ref, x, s, ev_raw, where):
    raise PlanError("%%s: synthetic move-issue row check failure" %% where)
"""


@case("M25 그 밖의 막힘: 제목이 제어 문자뿐(issue_check payload 없음) → '새 티켓 내용을 만들 수 없음' · 판정 이유에 {KEY}(gh 틀 검사 "
      "PlanError) · check_move_issue PlanError → '실행 행을 만들 수 없음' · 일지 형식 오류 → '확인 못 함: 이관 일지'")
def _():
    s = MoveScn("m25")
    s.issue(110, title="\t\x01")
    s.issue(111, v=mv_keep(111, REASON="옮길 티켓 {KEY}을 남깁니다."))
    s.issue(112)
    r = s.build()
    mv_ok(r)
    eq((mv_amb(r, 110)["missing"], mv_amb(r, 111)["missing"]), ("새 티켓 내용을 만들 수 없음", "실행 행을 만들 수 없음"),
       "payload None · gh template")
    eq(("move-issue", "issue#112") in r["rows"], True, "the plain issue moves")
    wrap = W / "plan_bad_row.py"
    wrap.write_text(CJ_PLAN_BAD_ROW % str(SCRIPTS / "chore_plan.py"))
    r = s.build(env_extra={"CHORE_PLAN_PY": str(wrap)})
    mv_ok(r)
    ev = mv_amb(r, 112)
    eq(ev["missing"], "실행 행을 만들 수 없음", "check_move_issue")
    has(ev["known"], "synthetic move-issue row check failure", "known carries the plan error")
    s.chore.mkdir(parents=True, exist_ok=True)
    with open(s.chore / (MV.RUN_B + ".journal"), "w", encoding="utf-8") as fh:
        fh.write("이것은 일지 줄이 아님\n")
    r = s.build()
    mv_ok(r)
    eq([mv_amb(r, n)["missing"] for n in (110, 111, 112)], ["확인 못 함: 이관 일지"] * 3, "journal format error")


RUN_C = "20261023T020000Z-0c0c0c0c"
MV_AFTER_REPORT = "Jira에서 그 티켓이 있는지 확인 — 이 계획의 보고 뒤에 만든 티켓이라 다음 정리(새 report)에서 다시 판단"
MV_UNCONFIRMED = "Jira에서 그 티켓이 있는지 확인 — 다음 정리에서 다시 판단"


@case("M26 확인 전(댓글 전송 없음)에 404가 된 chore KEY(apply E1 차단기 뒤): 같은 report 계획 → AMBIGUOUS KNOWN '<KEY> — M20'(이 "
      "계획의 KEY), --confirmed-deleted KEY를 줘도 같고 그 KEY는 '쓰이지 않은 확인 키' · 새 report 계획(보고 전에 "
      "만든 KEY) → 플래그 없으면 AMBIGUOUS, 행 없음 · --confirmed-deleted KEY → 만들기 행, 실물 apply가 한 번 더 만듦, 쓰이지 않은 확인 "
      "키는 stderr 한 줄 · 플래그 키 형식 exit 2 · 다른 프로젝트 exit 1")
def _():
    s = MoveScn("m26")
    s.issue(120)
    r = s.build()
    mv_ok(r)
    rc, got, _ = mv_apply(s, r, env_extra={"CHORE_JIRA_TEST_KILL_AFTER": "mv-create-ok"})
    eq((rc, len(MV.FJ.creates())), (-signal.SIGKILL, 1), "killed right after create-ok")
    key = next(iter(MV.FJ.tickets))
    del MV.FJ.tickets[key]                                # 이제 404 — 지워짐인지 못 읽음인지 Jira로는 모른다
    rc, got, err = mv_apply(s, r)
    eq((rc, got.get("issue#120")), (9, ("SKIP", "manual: %s — %s" % (key, MV.CJ.M20))), "apply E1 breaker (%s)" % err[-200:])
    known = "%s — %s" % (key, MV.CJ.M20)
    for what, extra, run_id, missing, se in (
            ("same report plan", (), RUN_ID, MV_UNCONFIRMED, ""),
            ("same report plan + flag (this plan's key)", ("--confirmed-deleted", key), RUN_ID, MV_UNCONFIRMED,
             "chore-judge: build: 이번 build에서 쓰이지 않은 확인 키: %s\n" % key),
            ("new report plan without the flag", (), RUN_C, MV_UNCONFIRMED, "")):
        r2 = s.build(*extra, run_id=run_id)
        eq((r2["rc"], r2["se"]), (0, se), what + ": rc/stderr")
        ev = mv_amb(r2, 120)
        eq((ev["known"], ev["missing"], ev["owner"]), (known, missing, "me"), what)
        eq((os.listdir(r2["pdir"]), len(MV.FJ.creates())), ([], 1), what + ": no row, nothing created")
    r3 = s.build("--confirmed-deleted", key, "--confirmed-deleted", "TST-999", run_id=RUN_C)
    eq((r3["rc"], r3["se"]), (0, "chore-judge: build: 이번 build에서 쓰이지 않은 확인 키: TST-999\n"), "unused key listed once")
    eq(r3["rows"][("move-issue", "issue#120")]["snapshot"]["adopt"], "-", "confirmed deleted: create row")
    rc, got, err = mv_apply(s, r3, run_id=RUN_C)
    new = next(iter(MV.FJ.tickets))
    eq((rc, got, len(MV.FJ.creates())), (0, {"issue#120": ("OK", "moved: %s — %s" % (new, MV.CJ.MT_MOVED_NEW))}, 2),
       "apply creates once (%s)" % err[-200:])
    for flag, rc_want, part in (("tst-1", 2, "사용법 오류: --confirmed-deleted는 Jira 티켓 키"),
                                ("OTH-5", 1, "--confirmed-deleted는 바인딩 프로젝트 TST의 티켓 키: OTH-5")):
        r4 = s.build("--confirmed-deleted", flag)
        eq((r4["rc"], r4["so"], r4["out"].exists()), (rc_want, "", False), flag)
        has(r4["se"], part, flag)


@case("M27 T 1개가 다른 계획의 chore 전송이 만든 티켓이고 댓글 전송이 없음(만든 뒤 확인 전) → chore-jira post_create_why: 팀이 배정함 → "
      "AMBIGUOUS KNOWN '<KEY> — M19' · 담당자 없음 → adopt 행")
def _():
    s = MoveScn("m27")
    s.issue(121)
    s.issue(122)
    k121, k122 = MV.ours_ticket(MV.FJ, 121), MV.ours_ticket(MV.FJ, 122)
    mv_journal(s.chore, 121, mv_att(27), mv_created(k121))
    mv_journal(s.chore, 122, mv_att(28), mv_created(k122))
    MV.FJ.tickets[k121]["assignee"] = "712020:00000000-0000-0000-0000-00000000cccc"
    r = s.build()
    mv_ok(r)
    ev = mv_amb(r, 121)
    eq((ev["known"], ev["owner"]), ("%s — %s" % (k121, MV.CJ.M19), "me"), "assigned → M19")
    eq(r["rows"][("move-issue", "issue#122")]["snapshot"]["adopt"], k122, "unassigned → adopt")


def sighup_default():
    """자식에서 SIGHUP을 기본 동작으로(nohup·셸이 무시로 넘겨도 M28이 같은 것을 보게)."""
    signal.signal(signal.SIGHUP, signal.SIG_DFL)


@case("M28 publish 마스크에 SIGHUP·SIGQUIT도: DIR rename 직후 SIGHUP → 신호로 끝나도 계획·설명 파일 둘 다 있음, 임시 파일 없음 · "
      "SIGINT와 SIGTERM이 같이 막혀 있다 풀림 → 한 번만(stderr 한 줄, exit 1, traceback 없음), 출력 둘 다 있음")
def _():
    s = MoveScn("m28")
    s.issue(123)
    r0 = s.build()
    mv_ok(r0)
    r = s.build(env_extra={"CHORE_JUDGE_TEST_FAULT": "payloads-renamed:hup"}, preexec=sighup_default)
    eq((r["rc"], r["data"], os.listdir(r["pdir"]), leftovers(r["dir"])),
       (-signal.SIGHUP, r0["data"], ["issue-123.json"], []), "SIGHUP after the rename")
    r = s.build(env_extra={"CHORE_JUDGE_TEST_FAULT": "payloads-renamed:both"})
    eq((r["rc"], r["so"], r["se"]), (1, "", "chore-judge: build: 중단 신호를 받음 — 계획과 설명 파일 폴더를 다 쓴 뒤(그대로 둠)\n"),
       "two pending signals → one")
    eq((r["data"], os.listdir(r["pdir"]), leftovers(r["dir"])), (r0["data"], ["issue-123.json"], []), "outputs")


@case("M29 이 계획이 만들고 댓글 전송이 없는 티켓에 팀이 담당자를 붙임 → 만든 뒤 확인이 같은 계획 검사보다 먼저: AMBIGUOUS KNOWN "
      "'<KEY> — M19' (담당자 없음이면 M21처럼 '승인된 계획으로 다시 실행')")
def _():
    s = MoveScn("m29")
    s.issue(124)
    key = MV.ours_ticket(MV.FJ, 124)
    mv_journal(s.chore, 124, mv_att(29), mv_created(key), run_id=RUN_ID)
    MV.FJ.tickets[key]["assignee"] = "712020:00000000-0000-0000-0000-00000000cccc"
    r = s.build()
    mv_ok(r)
    ev = mv_amb(r, 124)
    eq((ev["known"], ev["owner"]), ("%s — %s" % (key, MV.CJ.M19), "me"), "this plan's assigned ticket → M19")


def sigint_ignored():
    """자식이 SIGINT를 무시한 채 시작(셸의 백그라운드 작업처럼)."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)


@case("M30 부모가 SIGINT를 무시로 넘긴 build: publish 처리기를 달지 않아 무시가 그대로 — DIR rename 직후 SIGINT → exit 0, 정상 build: "
      "두 줄, 계획·설명 파일 둘 다 (마스크에는 그대로 들어 있음)")
def _():
    s = MoveScn("m30")
    s.issue(125)
    r0 = s.build()
    mv_ok(r0)
    r = s.build(env_extra={"CHORE_JUDGE_TEST_FAULT": "payloads-renamed:int"}, preexec=sigint_ignored)
    mv_ok(r)
    eq((r["so"], r["data"], os.listdir(r["pdir"]), leftovers(r["dir"])), (r0["so"], r0["data"], ["issue-125.json"], []),
       "ignored SIGINT stays ignored")


@case("M31 확인 전 404 KEY는 apply E1과 같은 규칙(contract round 4c·4d): 다른 계획이 이 계획의 보고(created=) 뒤에 만든 KEY + "
      "--confirmed-deleted → AMBIGUOUS '…보고 뒤에 만든 티켓…', 행 없음, 그 KEY는 '쓰이지 않은 확인 키' · 보고와 같은 순간 → 같음 · "
      "이 계획의 KEY는 시각이 보고보다 앞서도(시계가 뒤로 감) 플래그와 무관하게 AMBIGUOUS · 다른 계획이 보고 1ms 전에 만든 KEY → "
      "플래그 없으면 AMBIGUOUS, 플래그 있으면 만들기 행")
def _():
    created = MV.CJ.parse_ts(HDR["created"])
    def inst(delta_ms):
        return (created + timedelta(milliseconds=delta_ms)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    s = MoveScn("m31")
    keys = {}
    for n, delta, run_id in ((131, 60000, MV.RUN_B), (132, 0, MV.RUN_B), (133, -1, MV.RUN_B), (134, -60000, RUN_ID)):
        s.issue(n)
        keys[n] = "TST-%d" % (900 + n)                       # 만든 기록만 있고 Jira에는 없음(404)
        mv_journal(s.chore, n, mv_att(n), mv_created(keys[n]), run_id=run_id, at=inst(delta))
    flags = [x for n in (131, 132, 133, 134) for x in ("--confirmed-deleted", keys[n])]
    r = s.build(*flags)
    eq((r["rc"], r["se"]), (0, "chore-judge: build: 이번 build에서 쓰이지 않은 확인 키: %s, %s, %s\n"
                            % (keys[131], keys[132], keys[134])), "flags that released nothing are listed")
    ev = mv_amb(r, 134)
    eq((ev["known"], ev["missing"]), ("%s — %s" % (keys[134], MV.CJ.M20), MV_UNCONFIRMED), "own KEY before created= + flag")
    for n in (131, 132):
        ev = mv_amb(r, n)
        eq((ev["known"], ev["missing"], ev["owner"]), ("%s — %s" % (keys[n], MV.CJ.M20), MV_AFTER_REPORT, "me"),
           "issue#%d (at %s created=)" % (n, "after" if n == 131 else "=="))
    eq((r["rows"][("move-issue", "issue#133")]["snapshot"]["adopt"], os.listdir(r["pdir"])), ("-", ["issue-133.json"]),
       "made before the report + confirmed → create row")
    r = s.build()
    mv_ok(r)
    eq([mv_amb(r, n)["missing"] for n in (131, 132, 133, 134)], [MV_AFTER_REPORT, MV_AFTER_REPORT, MV_UNCONFIRMED,
                                                                 MV_UNCONFIRMED], "no flags")


@case("M32 다른 계획이 옮기고 닫은(mv-comment-ok + mv-closed) 이슈를 사람이 다시 엶 → KEEP이어도 AMBIGUOUS KNOWN '<KEY> — M21', "
      "MISSING '이전 정리가 옮기고 닫은 뒤 사람이 다시 연 이슈 — 다시 닫을지 오너가 정함', owner me — adopt 행·설명 파일 없음 "
      "(contract round 5b)")
def _():
    s = MoveScn("m32")
    s.issue(135)
    key = MV.ours_ticket(MV.FJ, 135)
    body = mv_body(key)
    cid = MV.GHS.comment(135, MV.LOGIN, body)
    mv_journal(s.chore, 135, mv_att(35), mv_commented(key, body, cid, 1) + [("mv-closed", [("key", key)])])
    eq(MV.CJ.move_history(str(s.chore), "issue#135")["closed"], {(MV.RUN_B, key)}, "history sees the close")
    r = s.build()
    mv_ok(r)
    ev = mv_amb(r, 135)
    eq((ev["known"], ev["missing"], ev["recommend"], ev["owner"]),
       ("%s — %s" % (key, MV.CJ.M21), "이전 정리가 옮기고 닫은 뒤 사람이 다시 연 이슈 — 다시 닫을지 오너가 정함",
        "닫을 이유가 있으면 오너가 직접 닫음, 아니면 열린 채로 둠", "me"), "reopened issue")
    eq((("move-issue", "issue#135") in r["rows"], os.listdir(r["pdir"])), (False, []), "no adopt row, no payload file")


@case("M33 다른 계획이 만들고(create-ok) 댓글 달고(comment-ok) 닫은(mv-closed) 이슈를 사람이 다시 엶 + 그 티켓은 지워짐(404, 댓글을 "
      "보냈으니 만든 뒤 확인 KEY 아님) → KEEP = 새 만들기 행(adopt -, T 0개), M21 아님, 설명 파일 있음 — 보고서의 '티켓을 지우면 다음 "
      "정리가 새로 만듦' 출구")
def _():
    s = MoveScn("m33")
    s.issue(136)
    key = "TST-1136"                                      # 일지에만 있고 Jira에는 없음(지워짐)
    body = mv_body(key)
    cid = MV.GHS.comment(136, MV.LOGIN, body)
    mv_journal(s.chore, 136, mv_att(36), mv_created(key) + mv_commented(key, body, cid, 2) + [("mv-closed", [("key", key)])])
    h = MV.CJ.move_history(str(s.chore), "issue#136")
    eq((h["closed"], MV.CJ.needs_post_create_check(h, key)), ({(MV.RUN_B, key)}, False), "history: closed, comment sent")
    r = s.build()
    mv_ok(r)
    row = r["rows"].get(("move-issue", "issue#136"))
    eq((row is not None and row["snapshot"]["adopt"], row is not None and row["snapshot"]["prior"], os.listdir(r["pdir"])),
       ("-", "-", ["issue-136.json"]), "a new create row")
    ic = mv_expect(s, 136, mv_reason(136))
    eq(row["snapshot"]["payload_sha"], ic["payload_sha"], "payload from the R-filtered comments (old migration comment left out)")


@case("M34 다시 연 옮긴 이슈의 M21은 새 티켓 내용을 만들기 전: 제목이 제어 문자뿐으로 바뀜(payload 없음) → M21('새 티켓 내용을 만들 수 "
      "없음' 아님) · 본문이 바뀜(payload는 만들어짐) → M21 · 후보 둘(하나가 닫은 기록) → M4가 먼저")
def _():
    s = MoveScn("m34")
    keys = {}
    for n in (141, 142):
        s.issue(n)
        keys[n] = MV.ours_ticket(MV.FJ, n)
        body = mv_body(keys[n])
        cid = MV.GHS.comment(n, MV.LOGIN, body)
        mv_journal(s.chore, n, mv_att(n), mv_commented(keys[n], body, cid, 1) + [("mv-closed", [("key", keys[n])])])
    MV.GHS.set_issue(141, title="\t\x01")                  # 다시 연 뒤 제목을 바꿈 — move_summary가 비어 payload를 못 만듦
    MV.GHS.set_issue(142, body="다시 연 뒤 고친 본문")
    s.issue(143)
    k143 = MV.ours_ticket(MV.FJ, 143)
    other = MV.ours_ticket(MV.FJ, 143)
    b143 = mv_body(k143)
    c143 = MV.GHS.comment(143, MV.LOGIN, b143)
    mv_journal(s.chore, 143, mv_att(43), mv_commented(k143, b143, c143, 1) + [("mv-closed", [("key", k143)])])
    in_proc = MV.CJ.move_history(str(s.chore), "issue#141")
    MV.in_proc_env()
    ic = MV.CJ.issue_check(MV.CJ.gh_issue(MV.REMOTE, 141), {"project_id": MV.PID, "issuetype": MV.TYPE, "account": MV.ME},
                           {"reason": mv_reason(141), "related": []}, in_proc["R"], DATE, MV.REPO_URL)
    eq(ic["payload"], None, "precondition: issue#141 has no payload")
    r = s.build()
    mv_ok(r)
    for n in (141, 142):
        ev = mv_amb(r, n)
        eq((ev["known"], ev["missing"]), ("%s — %s" % (keys[n], MV.CJ.M21),
                                         "이전 정리가 옮기고 닫은 뒤 사람이 다시 연 이슈 — 다시 닫을지 오너가 정함"), "issue#%d" % n)
    ev = mv_amb(r, 143)
    eq(ev["missing"], MV.CJ.M4, "two candidates → M4")
    has(ev["known"], "%s, %s" % (k143, other), "known lists both")
    eq(os.listdir(r["pdir"]), [], "no rows")


# ───────────────────────── 실행 ─────────────────────────

def main():
    global W, FAKE
    W = Path(tempfile.mkdtemp(prefix="chore-judge-test."))
    FAKE = JT.FakeJira()
    MV.FJ, MV.GHS = MV.FakeJira(), MV.GH()          # move 사례의 가짜 Jira·가짜 gh (MV.gh_env·ours_ticket이 이 둘을 쓴다)
    # 셸의 백그라운드 작업은 SIGINT를 무시한 채 시작하고(POSIX), 무시는 자식에게 그대로 넘어간다 — M19의 SIGINT 주입이
    # 이 실행 방식과 무관하게 같은 것을 보도록 이 프로세스(그리고 exec된 자식)의 SIGINT를 기본 처리로 되돌린다.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    failed = 0
    try:
        (W / "bin").mkdir()
        gh = W / "bin" / "gh"
        gh.write_text("#!%s -I\n%s" % (sys.executable, GH_STUB))
        gh.chmod(0o755)
        mods = W / "mods"
        mods.mkdir()
        (mods / "cj_wrap.py").write_text(CJ_WRAP % str(REAL_CJ))
        ev_path = REAL_EV if REAL_EV.exists() and not os.environ.get("CHORE_JUDGE_TEST_EV_DOUBLE") else mods / "ev.py"
        (mods / "ev.py").write_text(EV_DOUBLE)
        (W / "gitconfig").write_text("[init]\n\tdefaultBranch = develop\n[advice]\n\tdetachedHead = false\n")
        ENV.update({"PATH": "%s:%s" % (W / "bin", os.environ.get("PATH", "/usr/bin:/bin")), "HOME": str(W),
                    "GIT_CONFIG_GLOBAL": str(W / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1", "TZ": "UTC",
                    "GIT_AUTHOR_NAME": "tester", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "tester",
                    "GIT_COMMITTER_EMAIL": "t@example.com", "CHORE_JIRA_BASE": FAKE.base, "JIRA_EMAIL": JT.EMAIL,
                    "JIRA_API_TOKEN": JT.TOKEN, "CHORE_JIRA_TIMEOUT": "5", "CHORE_JIRA_RETRY_SLEEP": "0",
                    "CHORE_EVIDENCE_PY": str(ev_path)})
        wrap = _load("cj_wrap_probe", mods / "cj_wrap.py")
        if wrap.DOUBLE_BINDING:
            ENV["CHORE_JIRA_PY"] = str(mods / "cj_wrap.py")
        print("# chore-evidence: %s · read_binding: %s" % (
            "실물 scripts/chore-evidence.py" if ev_path == REAL_EV else "대역(EV_DOUBLE)",
            "대역(감싸개)" if wrap.DOUBLE_BINDING else "실물 chore-jira.py"))
        setup_fake()
        only = os.environ.get("CHORE_JUDGE_TEST_ONLY")      # 개발용: 이름이 이 접두로 시작하는 사례만 (게이트는 전부)
        CASES[:] = [c for c in CASES if not only or c[0].startswith(only)]
        for name, fn in CASES:
            try:
                setup_fake()
                fn()
                print("ok   %s" % name)
            except Exception as e:
                failed += 1
                print("FAIL %s :: %s" % (name, " ".join(str(e).split())[:1500] or type(e).__name__))
                if os.environ.get("CHORE_JUDGE_TEST_TRACE"):
                    traceback.print_exc()
    finally:
        FAKE.close()
        MV.FJ.close()
        if not os.environ.get("CHORE_JUDGE_TEST_KEEP"):
            shutil.rmtree(W, ignore_errors=True)
            if MV.ROOT:
                shutil.rmtree(MV.ROOT, ignore_errors=True)
        else:
            print("# kept %s %s" % (W, MV.ROOT))
    print("%d/%d passed" % (len(CASES) - failed, len(CASES)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
