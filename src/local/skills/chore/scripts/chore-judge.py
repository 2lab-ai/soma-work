#!/usr/bin/env python3
"""chore-judge.py — 판정 결과를 최종 계획으로 묶고(build), Jira를 옮기기 직전에 증거를 다시 확인한다(recheck).
(chore v4 U2b, 2026-10-19 — spec-v4 §B5 §B6 §C §D, ev-schema.md, design-jira.md §4 step 10)

    python3 -I scripts/chore-judge.py build --plan <report plan.tsv> --ev <증거 폴더> --verdicts <판정 폴더>
        --out <최종 plan.tsv> --clone DIR [--allow-missing] [--date YYYY-MM-DD] [--payloads DIR]
        [--confirmed-deleted KEY]...
        [--hold-area close|jira|move|branches]... [--hold pr#N|issue#N|jira#KEY]...
    python3 -I scripts/chore-judge.py recheck --clone C --remote owner/repo --repos-md F [--repo NAME]
        (stdin = 계획 머리 줄 + jira-transition 행 줄, 정확히 2줄)

build — 입력 계획의 머리 줄을 바이트 그대로, 행은 입력 순서 그대로 쓴다. 바뀌는 것은 이것뿐:
  - 판정한 tier-3 pr#N / issue#N 중 CLOSE가 기계 확인을 통과한 행 = 그 자리에서 `2 close-pr` / `2 close-issue`
    (ref·expected 바이트 그대로; snapshot = 엔진이 쓴 쌍을 순서·바이트 그대로 두고 build의 키 verdict·title이 입력에
    있으면 떼어 낸 뒤 맨 끝에 title=<제목> 하나를 붙인 것; 증거 칸 = 게시할 댓글).
  - 나머지 tier-3 pr#N / issue#N = ref·expected 그대로, snapshot = 같은 방식으로 verdict·title을 떼고 맨 끝에
    verdict=<v> 하나를 붙인 것, 증거 칸 = 구조형(t=제목;v=KEEP|AMBIGUOUS|NOT-JUDGED;…).
  - 끝에 Jira 행(바인딩이 있을 때만, 키 순서): tier-2 jira-transition → tier-3 jira#KEY → inventory jira#<PROJECT>.
    Jira 행이 있으면 머리 줄 groups=에 jira를, move-issue 행이 있으면 move를 더한다(그 칸만).
  - Jira로 옮기기(v4.3, design v9 §5): 증거 index.json move가 null이 아닌 저장소(바인딩 jira=)에서 KEEP 이슈 = 그 자리에서
    `2 move-issue issue#N`(ref·expected 바이트 그대로, expected == 지금 GitHub updatedAt; snapshot = MOVE_SNAP_KEYS 순서,
    증거 = encode_move_evidence(reason, gh = move_comment(site, reason, 계획 날짜), related)). 판정 JIRA_TYPE이 없거나
    move.types 중 하나와 맞지 않으면(증거 .md에 보이는 꼴 — chore-evidence _inl — 정확히 하나) AMBIGUOUS(MISSING "옮길
    Jira 유형"). 그다음 처음 맞는 것이 AMBIGUOUS(OWNER me, MISSING = 그 조건의 고정 문구): Jira 계정 모름 · 일지에 적을 수
    없는 모양(chore-jira.py ACCT_RE) → 프로젝트 id ≠ 증거 때(build에 한 번) → GitHub 엄격 읽기(chore-jira.py gh_issue)의
    updatedAt ≠ 증거 → OPEN 아님 → expected ≠ updatedAt → 이 이슈의 일지 미결(move_history; 일지 = <--clone의 git common
    dir>/chore) → 확인 전(mv-comment-sent 없음 — chore-jira needs_post_create_check)인 chore KEY가 404(KNOWN `<KEY> — M20`,
    apply E1과 같은 규칙 — contract round 4c·4d): 그 KEY를 이 계획(머리 줄 run_id)의 전송이 만들었으면 시각과 무관하게
    언제나, 다른 계획의 전송 시각 ≥ 이 계획 머리 줄 created=면 언제나(MISSING "… 이 계획의 보고 뒤에 만든 티켓이라 다음
    정리(새 report)에서 다시 판단"), 그보다 전이면 --confirmed-deleted
    KEY(되풀이; 오너가 Jira에서 지워진 것을 확인함)로 주지 않았을 때 — 주었으면 그 KEY만 예전처럼 지워진 티켓으로 보고 새로
    만듦. 그 플래그의 KEY는 바인딩 프로젝트 키여야 하고(형식 틀림 exit 2, 다른 프로젝트 exit 1), 플래그가 실제로 풀어 준 KEY만
    "쓰임" — 나머지는 성공 뒤 stderr에 한 줄 "이번 build에서 쓰이지 않은 확인 키: …" → live_candidates의 b → T 1개이고 어느
    계획이든 그 KEY로 이 이슈를 닫은 기록(mv-closed, move_history "closed")이 있는데 지금 열림(KNOWN `<KEY> — M21`, 사람이 다시
    엶 — 다시 닫을지 오너가 정함; contract round 5b — 새 티켓 내용을 만들기 전에) → 새 티켓 내용을 만들 수 없음(issue_check
    payload 없음) → T 2개 이상(M4) → 지금 있는 이관 기록 댓글(R)의 티켓이 T에도 지워진 티켓에도 없음
    → T 1개: 만든 뒤 확인 전이면 post_create_why(KNOWN `<KEY> — M19|M20`, apply mv_c 머리와 같음) · 그 티켓을 이
    계획(머리 줄 run_id)의 전송이 만듦("승인된 계획으로 다시 실행") · ticket_check(orig) 불일치 · 그
    KEY의 이관 기록 댓글 2개 이상(M8) | T 0개: createmeta_ok(유형마다 한 번 — 만드는 행만, apply F와 같음) →
    recorded_bad(M6/M7) → 기록 없는 이관 댓글(M10). T 1개 통과 = adopt KEY, prior = 그 KEY의 기록 댓글(0개 -, 1개
    cid:csha). related = 증거의 언급 키(found, 바인딩 프로젝트) ∪ live_candidates c − T, 키 순서. source_sha·payload_sha =
    issue_check(일지의 R로 거른 댓글, 계획 날짜 = --date) — apply가 같은 함수로 다시 만든다. Jira 인증 실패 = exit 1, 그 밖
    읽기 실패 = 그 이슈만 AMBIGUOUS "확인 못 함". 바인딩 저장소에서 근거(CITES, 자기 자신 제외)가 jira:뿐인 이슈 CLOSE =
    AMBIGUOUS "Jira 티켓만 근거인 닫기 — 사람이 판단"(design R4). index.json move가 null이면 이 절 전체가 없다(전과 같은 바이트).
  - 같은 adopt KEY를 move-issue 행 둘 이상이 쓰면(모든 단위를 정한 뒤, --hold 전) 그 행 모두 AMBIGUOUS "이미 만든 티켓
    <KEY>를 여러 이슈가 가리킴 — 사람이 판단"(OWNER me) — 계획 검사(adopt KEY는 한 행에만)로 build 전체가 멈추지 않게.
  - --payloads DIR (contract §3): 체인 전체가 언제나 준다(skill이 갈라지지 않게). move-issue 행이 있는데 없으면 exit 1,
    주었는데 DIR가 이미 있으면 exit 1(읽기 전에 검사). move-issue 행마다 DIR/issue-<N>.json = 그 행 payload 바이트
    그대로(sha256 == payload_sha), 그 밖 파일 없음 — 행이 0개면 빈 폴더. DIR 옆 임시 폴더에 쓰고 fsync한 뒤 DIR로 rename,
    그다음 계획을 쓴다(publish). publish 동안 SIGINT·SIGTERM·SIGHUP·SIGQUIT은 pthread_sigmask로 막혀 둘 다 놓인 뒤에
    전달된다(SIGINT·SIGTERM = exit 1 "중단 신호를 받음 — 계획과 설명 파일 폴더를 다 쓴 뒤", 둘이 같이 와도 한 번; SIGHUP·
    SIGQUIT = 기본 동작); 신호 아닌 실패(쓰기 실패 · rename 뒤 부모 폴더 fsync 실패)로
    계획이 그 바이트로 놓이지 않으면 DIR와 임시 파일을 지우고 exit 1 — 막는 네 신호와 잡는 예외에 대해서는 반쪽(DIR만·계획만)이
    남지 않는다. SIGKILL이나 전원 끊김은 다르다: 계획의 os.replace 뒤에는 부모 폴더 fsync가 없어서, 그때 끊기면 DIR만 있고
    새 계획은 없는 반쪽이 남을 수 있다(DIR의 rename 뒤에는 부모 폴더 fsync가 있다). 계획 바이트는 --payloads와
    무관하다. 테스트 전용 env CHORE_JUDGE_TEST_FAULT=<지점>:<int|term|hup|both|raise>(_fault). --out이 DIR와 같거나 DIR
    안이거나 DIR가 --out 경로 안이면(realpath, 대소문자 무시) 읽기·쓰기 전에 exit 1. --date는 달력에 있는 날(chore_plan
    계획 날짜 규칙), 아니면 사용법 오류 exit 2.
  - --hold-area close|jira|move|branches / --hold <ref>로 승인에서 뺀 실행 행 = 지우지 않고 tier-3로 남긴다(최종 보고에
    남게): 닫기·Jira·Jira로 옮기기 = KEEP "이번 승인에서 뺌", 원격 브랜치 지우기 = 엔진 모양의 remote:<b> 보존 행. 로컬
    지우기 행은 그대로.
  판정 파일 = <판정 폴더>/<pr-N|issue-N|jira-KEY>.txt, 한 줄에 `NAME: 값` (UNIT VERDICT REASON ITEMS REQUIREMENTS
  CLOSE_BASIS CITES KNOWN MISSING OWNER DECIDER RECOMMEND JIRA_TYPE; REQUIREMENTS만 여러 줄, JIRA_TYPE은 이슈 판정에만).
  입력 계획에 이미 Jira 행·move-issue 행이 있으면 exit 1(report 계획만 받는다). 판정 없음 = exit 1(모두 나열),
  --allow-missing이면 AMBIGUOUS "판정 누락". 형식 오류 = exit 1(모두 나열, 조용히 KEEP으로 바꾸지 않음).
  기계 확인(gate)은 조건마다 함수 하나, 실패 문구는 한국어 — 실패하면 AMBIGUOUS(MISSING = 실패한 조건),
  배포만 기다리는 TO-QA는 KEEP "<이름> 배포 대기"(이름 = 바인딩 proof_label). 쓰기 전에 출력 전체를 chore_plan.parse_plan +
  check_jira_binding(move-issue 행 포함) + inventory 수 대조 + payload sha 대조로 검사하고 임시 파일 → rename으로 쓴다.
  성공 stdout 두 줄 (move-issue=는 첫 줄 맨 끝 — 앞 키를 읽는 쪽은 그대로 맞는다):
      build: close-pr=a close-issue=b to-qa=n to-closed=m keep=k ambiguous=x not-judged=y excluded=z gate-downgraded=g held=h move-issue=v
      build: sha256=<출력 파일 sha256>
  실패 = stderr 한 줄 "chore-judge: build: …" + exit 1, 사용법 오류 = exit 2.
  --clone(필수) = 커밋·파일 근거(c:… path:…)와 기본 브랜치 포함 여부를 확인할 로컬 저장소. 읽기는 gh·git -C·Jira
  조회만(쓰기 없음, git fetch도 하지 않음). 증거 모양이 어긋나면(on_S가 참/거짓/없음이 아님 등) exit 1 "증거 형식 오류".
  index.json ledgers(제외 원장 절대 경로, 필수)는 Jira 옮기기 행마다 snapshot ledgers로 옮겨 recheck가 다시 읽는다.

recheck — chore-jira.py apply-rows 10단계가 행마다 부른다. 계획 행·바인딩(read_binding)·지금 사실만 읽는다.
  exit 0 = 증거가 아직 맞음(출력 없음) · exit 10 = 맞지 않음(stdout에 한국어 한 줄) · exit 3 = 읽기 실패나 잘못된
  입력(stderr 한 줄; apply-rows는 단계를 멈춘다). 토큰·URL은 찍지 않는다.
  공통: 머리 줄 remote ≠ --remote면 읽기 전에 exit 3, 다시 뽑은 후보 ⊆ 승인 항목(뽑기가 불완전해도 이 검사가 먼저),
  승인 때 합쳐진 PR의 병합 커밋 그대로, 진행 중인 작업 없음(증거의 open_work: 열린 PR·키 이름 브랜치), 다른 저장소
  (바인딩 jira-repos=, 이 저장소 제외)의 PR이 상태 무관하게 키를 언급하지 않음(증거 제외와 같은 술어).
  git·gh 전에: 승인 snapshot 상태가 지금 바인딩의 보류(jira-hold 또는 jira-qa)면 10, 행의 제외 원장(ledgers)을 지금
  다시 읽어 이 티켓이 있으면 10(원장 사유), 원장을 못 읽으면 3 — 증거의 hold·ledger 제외와 같은 술어.
  TO-QA: 지금 배포 기준(바인딩 deploy-proof, stale이면 10) · 배포 판단 범위 항목은 그 조상이고 되돌리지 않았음(두 부모 병합은 그
  브랜치 커밋까지, 다시 뽑은 후보의 reverted_by까지). TO-CLOSED: 닫는 근거 술어(build와 같은 함수)를 지금 값으로.

표준 라이브러리만. 같은 폴더 모듈은 경로로 읽는다(python3 -I는 같은 폴더 import를 막는다); 테스트용 경로 덮어쓰기
= env CHORE_PLAN_PY / CHORE_JIRA_PY / CHORE_EVIDENCE_PY.
"""
import argparse
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
KST = timezone(timedelta(hours=9))
CMD_TIMEOUT = 120


def _load(name, env, filename):
    path = os.environ.get(env) or str(HERE / filename)
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


P = _load("chore_plan", "CHORE_PLAN_PY", "chore_plan.py")
CJ = _load("chore_jira", "CHORE_JIRA_PY", "chore-jira.py")
_EV = []


def EV():
    """chore-evidence.py(증거 API) — recheck와 build의 JIRA_TYPE 대조(_inl)만 쓰므로 그때 읽는다."""
    if not _EV:
        _EV.append(_load("chore_evidence", "CHORE_EVIDENCE_PY", "chore-evidence.py"))
    return _EV[0]


class Fail(Exception):
    """build exit 1 / recheck exit 3 — 메시지 한 줄."""


class ProofFail(Exception):
    """recheck exit 10 — 증거가 지금은 맞지 않음(한국어 한 줄)."""


class ReadFail(Exception):
    """gh·git 읽기 실패 (build에서는 그 근거가 확인 안 됨, recheck에서는 exit 3)."""


class Malformed(Exception):
    """판정 파일 형식 오류."""


class Interrupted(BaseException):
    """설명 파일·계획을 쓰는 동안 받은 SIGTERM (SIGINT = KeyboardInterrupt) — 쓴 것을 치우고 exit 1."""


MOVE_RECOMMEND = "확인한 뒤 다음 계획에서 다시 판단"


class MoveBlock(Exception):
    """KEEP 이슈를 Jira로 옮기는 행을 만들 수 없음 → 그 이슈만 AMBIGUOUS. why = MISSING(막은 조건의 고정 문구), detail = KNOWN에
    덧붙이는 사실(키·댓글 id·읽기 오류), reason = AMBIGUOUS REASON(없으면 "Jira로 옮기기를 기계 확인이 막음 — <why>")."""

    def __init__(self, why, detail="", recommend=MOVE_RECOMMEND, decider=None, reason=None, known=None):
        super().__init__(why)
        self.why, self.detail, self.recommend, self.decider, self.reason = why, detail, recommend, decider, reason
        self.known = known       # KNOWN 그대로(계약 문구 — contract §6 round 3: `<KEY> — ` + M19/M20); 없으면 판정 의견 + detail


# ───────────────────────── 외부 읽기 (gh · git) ─────────────────────────

def _first_line(raw):
    lines = raw.decode("utf-8", "replace").strip().splitlines()
    return CJ.scrub(lines[0] if lines else "", 160)


def _run(cmd, what):
    try:
        return subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=CMD_TIMEOUT,
                              env=dict(os.environ, GIT_TERMINAL_PROMPT="0"))
    except subprocess.TimeoutExpired:
        raise ReadFail("%s 시간 초과" % what) from None
    except OSError as e:
        raise ReadFail("%s 실행 실패 (%s)" % (what, type(e).__name__)) from None


def gh_json(args):
    what = "gh " + " ".join(args[:2])
    p = _run(["gh"] + args, what)
    if p.returncode != 0:
        raise ReadFail("%s 실패: %s" % (what, _first_line(p.stderr)))
    try:
        return json.loads(p.stdout.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ReadFail("%s 응답이 JSON이 아님" % what) from None


def git(clone, *args):
    return _run(["git", "-C", clone] + list(args), "git " + args[0])


def git_out(clone, *args):
    p = git(clone, *args)
    if p.returncode != 0:
        raise ReadFail("git %s 실패: %s" % (args[0], _first_line(p.stderr)))
    return p.stdout.decode("utf-8", "replace")


def is_ancestor(clone, sha, tip):
    """sha가 tip의 조상인가 (merge-base --is-ancestor: 0 = 예, 1 = 아니오, 그 밖 = 읽기 실패)."""
    p = git(clone, "merge-base", "--is-ancestor", sha, tip)
    if p.returncode in (0, 1):
        return p.returncode == 0
    raise ReadFail("git merge-base 실패: %s" % _first_line(p.stderr))


REVERT_RE = re.compile(r"This reverts commit ([0-9a-f]{7,40})")


def revert_targets(clone, tip):
    """tip에서 닿는 커밋 중 메시지에 'This reverts commit <sha 앞 7자 이상>'이 든 것 → [(되돌린 커밋, sha 접두)]
    (증거 모듈의 reverted_by와 같은 규칙)."""
    out = git_out(clone, "log", "--format=%H%x1f%B%x1e", "-E", "--grep=This reverts commit [0-9a-f]{7,40}", tip, "--")
    pairs = []
    for rec in out.split("\x1e"):
        h, _, msg = rec.strip("\n").partition("\x1f")
        pairs += [(h, m) for m in REVERT_RE.findall(msg)]
    return pairs


def is_shallow(clone):
    return git_out(clone, "rev-parse", "--is-shallow-repository").strip() == "true"


def resolve_commit(clone, ref):
    """ref → 커밋 sha40, 없으면 None."""
    p = git(clone, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
    if p.returncode != 0:
        return None
    out = p.stdout.decode("ascii", "replace").strip()
    return out if P.HEX40.fullmatch(out) else None


# ───────────────────────── 시각 · 문장 ─────────────────────────

def kst(ts):
    return CJ.parse_ts(ts).astimezone(KST)


def sentence(s):
    s = s.strip()
    return s if s.endswith((".", "!", "?", "。")) else s + "."


def ro(word):
    """조사 '로/으로' — 마지막 한글 음절의 받침(ㄹ 받침은 '로'), 숫자는 읽는 소리, 그 밖은 '로'."""
    for ch in reversed(word):
        if "가" <= ch <= "힣":
            jong = (ord(ch) - 0xAC00) % 28
            return "로" if jong in (0, 8) else "으로"
        if ch.isdigit():
            return "으로" if ch in "036" else "로"
        if ch.isalpha():
            return "로"
    return "로"


def cand_name(c):
    return "PR #%d" % c["number"] if c["kind"] == "pr" else "커밋 %s" % c["sha"][:12]


def key_order(key):
    proj, _, num = key.rpartition("-")
    return (proj, int(num) if num.isdigit() else 0, key)


# ───────────────────────── 판정 파일 ─────────────────────────

FIELDS = ("UNIT", "VERDICT", "REASON", "ITEMS", "REQUIREMENTS", "CLOSE_BASIS", "CITES", "KNOWN", "MISSING", "OWNER",
          "DECIDER", "RECOMMEND", "JIRA_TYPE")
JIRA_ONLY = ("ITEMS", "REQUIREMENTS", "CLOSE_BASIS")
ISSUE_ONLY = ("JIRA_TYPE",)      # v4.3: KEEP 이슈를 옮길 Jira 유형 이름(바인딩 저장소에서만 쓰임 — 그 밖에서는 무시)
VERDICTS = {"pr": ("CLOSE", "KEEP", "AMBIGUOUS"), "issue": ("CLOSE", "KEEP", "AMBIGUOUS"),
            "jira": ("TO-QA", "TO-CLOSED", "KEEP", "AMBIGUOUS")}
FIELD_LINE = re.compile(r"([A-Z_]+):[ ]*(.*?)[ ]*")
ITEM_EL = re.compile(r"(?:pr:([1-9][0-9]*)|c:([0-9a-f]{12,40}))=(required|superseded|unrelated)")
REQ_EL = re.compile(r'"(.+)"[ ]*=>[ ]*(?:(pr:[1-9][0-9]*)|c:([0-9a-f]{12,40})|(UNMET))')
CITE_PR = re.compile(r"pr:([1-9][0-9]*)(:merged)?")
CITE_ISSUE = re.compile(r"issue:([1-9][0-9]*)")
CITE_JIRA = re.compile(r"jira:([A-Z][A-Z0-9]+-[1-9][0-9]*)")
CITE_C = re.compile(r"c:([0-9a-f]{7,40})")
CITE_PATH = re.compile(r"path:(.+?)(:absent)?")
CTL = re.compile(r"[\x00-\x1f\x7f]")


def parse_cites(text):
    """CITES 값 → [{"t": pr|issue|jira|c|path, …}] (빈 값 = 빈 목록)."""
    out = []
    if text == "":
        return out
    for el in (e.strip() for e in text.split(",")):
        m = CITE_PR.fullmatch(el)
        if m:
            out.append({"t": "pr", "n": int(m.group(1)), "merged": bool(m.group(2)), "raw": el})
            continue
        m = CITE_ISSUE.fullmatch(el)
        if m:
            out.append({"t": "issue", "n": int(m.group(1)), "raw": el})
            continue
        m = CITE_JIRA.fullmatch(el)
        if m:
            out.append({"t": "jira", "key": m.group(1), "raw": el})
            continue
        m = CITE_C.fullmatch(el)
        if m:
            out.append({"t": "c", "sha": m.group(1), "raw": el})
            continue
        m = CITE_PATH.fullmatch(el)
        if m and m.group(1).strip():
            out.append({"t": "path", "p": m.group(1), "absent": bool(m.group(2)), "raw": el})
            continue
        raise Malformed("CITES 요소 %r 형식 오류 (pr:N, pr:N:merged, issue:N, jira:KEY, c:<sha>, path:<경로>[:absent])"
                        % el)
    return out


def _commit_by_prefix(prefix, cands, what):
    hits = [c for c in cands if c["kind"] == "commit" and c["sha"].startswith(prefix)]
    if len(hits) > 1:
        raise Malformed("%s c:%s가 후보 커밋 %d개와 맞음" % (what, prefix, len(hits)))
    return hits[0]["id"] if hits else None


def parse_verdict(text, uid, kind, cands):
    """판정 파일 본문 → dict. 형식 오류 = Malformed(이유)."""
    f, reqs = {}, []
    for no, line in enumerate(text.lstrip("﻿").split("\n"), 1):
        line = line.rstrip("\r")
        if line.strip() == "":
            continue
        m = FIELD_LINE.fullmatch(line)
        if not m:
            raise Malformed("%d번째 줄이 'NAME: 값' 형식이 아님" % no)
        name, val = m.group(1), m.group(2)
        if name not in FIELDS:
            raise Malformed("알 수 없는 필드 %s" % name)
        if CTL.search(val):
            raise Malformed("%s 값에 제어 문자" % name)
        if kind != "jira" and name in JIRA_ONLY:
            raise Malformed("%s는 Jira 판정에만 쓰는 필드" % name)
        if kind != "issue" and name in ISSUE_ONLY:
            raise Malformed("%s는 이슈 판정에만 쓰는 필드" % name)
        if name == "REQUIREMENTS":
            reqs.append(val)
            continue
        if name in f:
            raise Malformed("필드 %s가 두 번" % name)
        f[name] = val
    if f.get("UNIT") != uid:
        raise Malformed("UNIT %r ≠ %s" % (f.get("UNIT"), uid) if "UNIT" in f else "UNIT 없음")
    verdict = f.get("VERDICT")
    if verdict not in VERDICTS[kind]:
        raise Malformed("VERDICT %r는 %s 중 하나여야 함" % (verdict, "|".join(VERDICTS[kind])))
    if f.get("REASON", "") == "":
        raise Malformed("REASON 없음")
    v = {"unit": uid, "verdict": verdict, "reason": f["REASON"], "cites_raw": f.get("CITES", ""),
         "cites": parse_cites(f.get("CITES", "")), "roles": {}, "reqs": [], "basis": None,
         "jira_type": f.get("JIRA_TYPE") or None}
    for k in ("KNOWN", "MISSING", "OWNER", "DECIDER", "RECOMMEND"):
        v[k.lower()] = f.get(k, "")
    if v["owner"] and not P.OWNER.fullmatch(v["owner"]):
        raise Malformed("OWNER %r는 me, author:<login>, creator, qa-team, unknown 중 하나" % v["owner"])
    if verdict == "AMBIGUOUS":
        empty = [k for k in ("KNOWN", "MISSING", "OWNER", "DECIDER", "RECOMMEND") if v[k.lower()] == ""]
        if empty:
            raise Malformed("AMBIGUOUS인데 %s 없음" % ", ".join(empty))
    if kind != "jira":
        return v
    ids = {c["id"] for c in cands}
    for el in (e.strip() for e in f.get("ITEMS", "").split(",")) if f.get("ITEMS", "") != "" else ():
        m = ITEM_EL.fullmatch(el)
        if not m:
            raise Malformed("ITEMS 요소 %r 형식 오류 (pr:N=<역할> | c:<sha12..40>=<역할>)" % el)
        cid = "pr:" + m.group(1) if m.group(1) else _commit_by_prefix(m.group(2), cands, "ITEMS")
        if cid is None or cid not in ids:
            raise Malformed("ITEMS %s는 이 티켓의 후보가 아님" % el.split("=")[0])
        if cid in v["roles"]:
            raise Malformed("ITEMS가 %s를 두 번 적음" % cid)
        v["roles"][cid] = m.group(3)
    missing = [c["id"] for c in cands if c["id"] not in v["roles"]]
    if missing:
        raise Malformed("ITEMS에 후보 %s 빠짐" % ", ".join(i if i.startswith("pr:") else i[:14] for i in missing))
    for line in reqs:
        m = REQ_EL.fullmatch(line)
        if not m:
            raise Malformed("REQUIREMENTS %r 형식 오류 (\"<요구사항>\" => pr:N | c:<sha> | UNMET)" % line)
        if m.group(2):
            target = m.group(2)
        elif m.group(3):
            target = _commit_by_prefix(m.group(3), cands, "REQUIREMENTS") or "c:" + m.group(3)
        else:
            target = "UNMET"
        v["reqs"].append({"text": m.group(1), "target": target})
    if "CLOSE_BASIS" in f:
        if not P.CLOSE_BASIS.fullmatch(f["CLOSE_BASIS"]):
            raise Malformed("CLOSE_BASIS %r 형식 오류 (duplicate:<KEY> | superseded:<KEY> | superseded:pr:N)"
                            % f["CLOSE_BASIS"])
        v["basis"] = P.decode_close_basis(f["CLOSE_BASIS"])
        v["basis_raw"] = f["CLOSE_BASIS"]
    if verdict == "TO-CLOSED" and v["basis"] is None:
        raise Malformed("TO-CLOSED인데 CLOSE_BASIS 없음")
    return v


# ───────────────────────── 근거 확인 (build) ─────────────────────────

def index_ledgers(index):
    """index.json ledgers = 증거가 읽은 제외 원장의 절대 경로 목록(언제나 있음) — 어긋나면 Fail(exit 1)."""
    lg = index.get("ledgers")
    if not (isinstance(lg, list) and all(isinstance(x, str) and x.startswith("/") for x in lg)):
        raise Fail("증거 형식 오류: index ledgers가 절대 경로 목록이 아님 (%r)" % (lg,))
    return lg


def index_move(index):
    """index.json move(chore-evidence v4.3) = null(옮기지 않는 저장소 — 옛 증거에는 키가 없다) 또는 {site, project, project_id,
    types [{id, name}], excluded_types}. site·project가 바인딩과 다르거나 모양이 어긋나면 Fail(exit 1, 증거 결함)."""
    mv = index.get("move")
    if mv is None:
        return None
    b = index.get("binding")

    def bad(what):
        raise Fail("증거 형식 오류: index move %s" % what)
    if not isinstance(mv, dict):
        bad("가 객체가 아님")
    if not isinstance(b, dict) or mv.get("site") != b.get("site") or mv.get("project") != b.get("project"):
        bad("의 site·project가 바인딩과 다름")
    if not (isinstance(mv.get("project_id"), str) and P.PR_NUM.fullmatch(mv["project_id"])):
        bad("project_id가 숫자 id가 아님")
    types = mv.get("types")
    if not (isinstance(types, list) and all(isinstance(t, dict) and isinstance(t.get("id"), str)
                                            and P.PR_NUM.fullmatch(t["id"]) and isinstance(t.get("name"), str)
                                            and t["name"].strip() for t in types)):
        bad("types가 {id, name} 목록이 아님")
    return mv


class Ctx:
    def __init__(self, hdr, index, clone, date):
        self.hdr, self.remote, self.default = hdr, hdr["remote"], hdr["default"]
        self.binding = index.get("binding")
        self.account = index.get("account") or ""
        self.ledgers = index_ledgers(index)
        self.move = index_move(index)
        self.repo_url = "https://github.com/" + self.remote          # chore-jira.py apply·resolve와 같은 꼴
        self.repo_name = self.remote.split("/", 1)[-1]
        self.clone, self.date = clone, date
        self.cache, self._jira, self._once = {}, None, {}
        self.confirmed, self.confirmed_used = set(), set()   # --confirmed-deleted KEY들, 그중 이 build가 실제로 본 것

    def jira(self):
        if self._jira is None:
            try:
                self._jira = CJ.client(self.binding["site"])
            except CJ.JiraError as e:
                raise Fail("Jira 연결 실패: %s" % CJ.scrub(e.message)) from None
        return self._jira

    def once(self, key, fn):
        """build 한 번에 한 번만 읽는 move 사실(프로젝트 id·gh 로그인·일지 폴더·출처 B·유형별 createmeta). MoveBlock도
        기억해 그 뒤 이슈마다 같은 이유로 막는다."""
        if key not in self._once:
            try:
                self._once[key] = (fn(), None)
            except MoveBlock as e:
                self._once[key] = (None, e)
        val, err = self._once[key]
        if err is not None:
            raise err
        return val


def gh_item(ctx, what, n):
    """gh pr|issue view N → dict, 확인 못 하면 None (없음과 읽기 실패를 가르지 않는다 — 어느 쪽이든 근거 안 됨)."""
    key = (what, n)
    if key not in ctx.cache:
        fields = "number,state,mergeCommit" if what == "pr" else "number,state"
        try:
            d = gh_json([what, "view", str(n), "--repo", ctx.remote, "--json", fields])
            ctx.cache[key] = d if isinstance(d, dict) and d.get("number") == n else None
        except ReadFail:
            ctx.cache[key] = None
    return ctx.cache[key]


TICKET_FIELDS = "project,status,created,creator,summary,issuelinks"


def fetch_ticket(client, key):
    """Jira 티켓 하나 → {"id","key","project","created","creator","summary","status_category","links":[KEY]}.
    JiraError는 그대로 올린다(404 = 없음). 판정 build와 recheck가 같은 읽기·같은 술어를 쓴다."""
    d = client.get("/rest/api/3/issue/" + key, {"fields": TICKET_FIELDS})
    fl = d.get("fields") if isinstance(d, dict) else None
    if not isinstance(fl, dict) or not isinstance(d.get("key"), str):
        raise CJ.JiraError(CJ.READ, "응답 형식 오류: 티켓 %s" % key)
    st = fl.get("status") if isinstance(fl.get("status"), dict) else {}
    cat = st.get("statusCategory") if isinstance(st.get("statusCategory"), dict) else {}
    links = []
    for ln in fl.get("issuelinks") or []:
        other = (ln.get("outwardIssue") or ln.get("inwardIssue")) if isinstance(ln, dict) else None
        if isinstance(other, dict) and isinstance(other.get("key"), str):
            links.append(other["key"])
    project = fl.get("project") if isinstance(fl.get("project"), dict) else {}
    creator = fl.get("creator") if isinstance(fl.get("creator"), dict) else {}
    return {"id": str(d.get("id") or ""), "key": d["key"], "project": project.get("key"),
            "created": fl.get("created"), "creator": creator.get("accountId"),
            "summary": fl.get("summary") if isinstance(fl.get("summary"), str) else "",
            "status_category": cat.get("key"), "links": links}


def jira_target(ctx, key):
    """근거 티켓 조회 → ("ok", info) | ("missing", None) | ("error", 이유). 인증 실패 = Fail(exit 1)."""
    ck = ("jira", key)
    if ck not in ctx.cache:
        try:
            ctx.cache[ck] = ("ok", fetch_ticket(ctx.jira(), key))
        except CJ.JiraError as e:
            if e.code == CJ.AUTH:
                raise Fail("Jira 인증 실패 — 자격 증명 확인") from None
            ctx.cache[ck] = ("missing", None) if e.status == 404 else ("error", CJ.scrub(e.message))
    return ctx.cache[ck]


def this_ticket(u):
    """build 쪽 '이 티켓' = 증거의 issue + links (recheck 쪽은 fetch_ticket으로 지금 값을 읽는다)."""
    i = u.issue
    return {"id": str(i.get("id") or ""), "key": u.key, "project": i.get("project"), "created": i.get("created"),
            "creator": i.get("creator"), "summary": i.get("summary") or "",
            "links": [ln.get("key") for ln in u.ev.get("links") or [] if isinstance(ln, dict)]}


def is_self(this, target):
    return target["key"] == this["key"] or bool(target["id"]) and target["id"] == this["id"]


def dup_project_problem(this, target):
    return None if target["project"] == this["project"] else "중복 근거 티켓이 다른 프로젝트: %s" % target["key"]


def sup_newer_problem(this, target):
    if target["status_category"] == "done":
        return None
    try:
        if kst(target["created"]) > kst(this["created"]):
            return None
    except (ValueError, TypeError):
        return "대체 티켓과 이 티켓의 생성 시각을 비교할 수 없음: %s" % target["key"]
    return "대체 티켓이 더 먼저 만들어졌고 아직 끝나지 않음: %s" % target["key"]


DIGIT_RUN = re.compile(r"[0-9]+(?:[-./:][0-9]+)*")


def norm_summary(s):
    return " ".join(DIGIT_RUN.sub(" ", s or "").split())


def sup_joined_problem(this, target):
    if target["key"] in this["links"] or this["key"] in target["links"]:
        return None
    if target["creator"] and target["creator"] == this["creator"] \
            and norm_summary(target["summary"]) == norm_summary(this["summary"]):
        return None
    return "대체 티켓과 잇는 링크가 없고 같은 작성자의 같은 제목도 아님: %s" % target["key"]


def cite_words(c):
    t = c["t"]
    if t == "pr":
        return "PR #%d%s" % (c["n"], "(합쳐짐)" if c["merged"] else "")
    if t == "issue":
        return "이슈 #%d" % c["n"]
    if t == "jira":
        return c["key"]
    if t == "c":
        return "커밋 %s" % c["sha"][:12]
    return "%s 파일이 기본 브랜치에 없음" % c["p"] if c["absent"] else "%s 파일" % c["p"]


def cite_problem(ctx, c):
    """근거 하나를 기계로 확인 → None(맞음) 또는 한국어 실패 문구."""
    t = c["t"]
    if t in ("pr", "issue"):
        d = gh_item(ctx, t, c["n"])
        name = ("PR #%d" if t == "pr" else "이슈 #%d") % c["n"]
        if d is None:
            return "확인 안 됨: %s" % name
        if t == "pr" and c["merged"] and d.get("state") != "MERGED":
            return "합쳐진 PR 아님: %s" % name
        return None
    if t == "jira":
        if not ctx.binding:
            return "확인 안 됨: %s (Jira 연결 없음)" % c["key"]
        st, _ = jira_target(ctx, c["key"])
        return None if st == "ok" else "확인 안 됨: %s" % c["key"]
    base = "refs/remotes/origin/" + ctx.default
    try:
        if resolve_commit(ctx.clone, base) is None:
            return "확인 안 됨: 기본 브랜치 %s를 로컬 저장소에서 못 찾음" % ctx.default
        if t == "c":
            full = resolve_commit(ctx.clone, c["sha"])
            if full is None:
                return "확인 안 됨: 커밋 %s 없음" % c["sha"][:12]
            return None if is_ancestor(ctx.clone, full, base) else "기본 브랜치에 없음: 커밋 %s" % c["sha"][:12]
        present = git_out(ctx.clone, "ls-tree", "-z", "--name-only", base, "--", c["p"]) != ""
    except ReadFail as e:
        return "확인 못 함: %s (%s)" % (cite_words(c), e)
    if c["absent"] and present:
        return "기본 브랜치에 아직 있음: %s" % c["p"]
    if not c["absent"] and not present:
        return "기본 브랜치에 없음: %s" % c["p"]
    return None


# ───────────────────────── 기계 확인 (gate) — 조건마다 함수 하나 ─────────────────────────
# 반환 None = 통과, 문자열 = 실패한 조건(한국어), NA = 이 단위에는 해당 없음(통과도 실패도 아님 — KNOWN의
# "확인된 것"에 적지 않는다). u = Unit.
NA = object()


def g_complete(ctx, u):
    if u.ev.get("complete") is True:
        return None
    inc = [str(x) for x in u.ev.get("incomplete") or []]
    return "증거 수집이 끝나지 않음" + (" (%s)" % ", ".join(inc) if inc else "")


def self_cite(u, c):
    """이 단위 자신을 가리키는 인용(pr#7의 pr:7, issue#9의 issue:9, jira#K의 jira:K) — 근거로 세지 않는다."""
    if u.kind in ("pr", "issue"):
        return c["t"] == u.kind and c["n"] == int(u.id.split("#")[1])
    return c["t"] == "jira" and c["key"] == u.key


def g_cites_present(ctx, u):
    if any(not self_cite(u, c) for c in u.v["cites"]):
        return None
    what = "옮기는 근거 인용 없음" if u.v["verdict"] == "TO-QA" else "닫는 근거 인용 없음"
    return what + (" (자기 자신 인용은 근거가 아님)" if u.v["cites"] else "")


def g_cites_resolve(ctx, u):
    bad = [p for p in (cite_problem(ctx, c) for c in u.v["cites"]) if p]
    return "; ".join(bad) if bad else None


def g_close_jira_only(ctx, u):
    """design v9 R4: Jira로 옮기는 저장소(index move)에서 이슈 CLOSE의 근거(자기 자신 인용 제외)가 jira:뿐이면 사람이 판단 —
    Jira 티켓을 이슈 닫기의 근거로 쓰는 경로는 없다(남길 이슈는 새 티켓으로 옮긴다). 그 밖(PR·옮기지 않는 저장소) = 해당 없음."""
    if u.kind != "issue" or ctx.move is None:
        return NA
    cites = [c for c in u.v["cites"] if not self_cite(u, c)]
    return "Jira 티켓만 근거인 닫기 — 사람이 판단" if cites and all(c["t"] == "jira" for c in cites) else None


def env_label(binding):
    """바인딩의 배포 환경 이름(chore-jira read_binding의 proof_label: deploy-env= 또는 deploy-proof 브랜치의 마지막 조각).
    없거나(deploy-proof 없는 바인딩·proof_label 없는 옛 증거) 문자열이 아니면 None."""
    label = (binding or {}).get("proof_label")
    return label if isinstance(label, str) and label else None


def deploy_word(binding):
    """판정 글의 배포 이름 한 벌: "<이름> 배포", 이름이 없으면 "배포" (조사는 늘 "배포" 뒤에 붙는다 — 가·를·에)."""
    label = env_label(binding)
    return "%s 배포" % label if label else "배포"


def qa_bound(ctx, u):
    b = ctx.binding or {}
    return None if b.get("qa") and b.get("proof_workflow") and b.get("proof_branch") else \
        "저장소 등록부에 QA 상태 또는 배포 기준(deploy-proof)이 없음"


def qa_reqs_present(ctx, u):
    return None if u.v["reqs"] else "요구사항 목록 없음"


def qa_reqs_met(ctx, u):
    unmet = [r["text"] for r in u.v["reqs"] if r["target"] == "UNMET"]
    return "아직 반영 안 된 요구사항: %s" % ", ".join(unmet) if unmet else None


def qa_reqs_linked(ctx, u):
    bad = [r["text"] for r in u.v["reqs"]
           if r["target"] != "UNMET" and u.v["roles"].get(r["target"]) != "required"]
    return "필요한 변경으로 표시된 PR·커밋에 연결 안 된 요구사항: %s" % ", ".join(bad) if bad else None


def g_required_kind(ctx, u):
    bad = [cand_name(c) for c in u.cands if u.v["roles"][c["id"]] == "required"
           and c["kind"] == "pr" and c.get("state") != "MERGED"]
    return "합쳐지지 않은 PR이 필요한 변경으로 표시됨: %s" % ", ".join(bad) if bad else None


def qa_deploy(ctx, u):
    """이 단위 증거의 deploy만 본다(index의 deploy로 바꿔 끼우지 않음). 없음·stale·모양 오류 = 실패."""
    d, dep = u.deploy, deploy_word(ctx.binding)
    if not isinstance(d, dict) or not P.HEX40.fullmatch(str(d.get("S") or "")):
        return "%s 성공 기록 없음" % dep
    if d.get("stale") is True:
        return "%s 기준을 확정 못 함: %s" % (dep, d.get("stale_reason") or "이유 모름")
    if not P.DIGITS.fullmatch(str(d.get("run") or "")) or not P.HTTPS_URL.fullmatch(str(d.get("run_url") or "")):
        return "%s 실행 번호·주소를 읽을 수 없음" % dep
    if str(d["run_url"]).casefold() != run_url(ctx, d).casefold():
        return "%s 주소가 이 저장소의 그 실행이 아님" % dep
    try:
        kst(d.get("completed"))
    except (ValueError, TypeError):
        return "%s 완료 시각을 읽을 수 없음" % dep
    return None


def run_url(ctx, d):
    """계획에 적는 배포 실행 주소 = https://github.com/<계획 머리 줄 remote>/actions/runs/<run> (gh가 준 주소와 대소문자만
    다를 수 있다 — 머리 줄 remote는 소문자, GitHub 주소의 owner/repo는 대소문자를 가리지 않는다)."""
    return "https://github.com/%s/actions/runs/%s" % (ctx.remote, d.get("run"))


def deploy_branches(ctx):
    """배포 판단에 넣는 PR의 base = 기본 브랜치와 배포 증명(deploy-proof) 브랜치."""
    return {ctx.default, (ctx.binding or {}).get("proof_branch")} - {None}


def on_default(ctx, c):
    """커밋 후보가 origin/<기본 브랜치>에서 닿는가: 증거의 on_default(있으면) → 없으면 git → 모르면 None."""
    od = c.get("on_default")
    if isinstance(od, bool):
        return od
    key = ("on_default", c["sha"])
    if key not in ctx.cache:
        base = "refs/remotes/origin/" + ctx.default
        try:
            ctx.cache[key] = None if resolve_commit(ctx.clone, c["sha"]) is None or \
                resolve_commit(ctx.clone, base) is None else is_ancestor(ctx.clone, c["sha"], base)
        except ReadFail:
            ctx.cache[key] = None
    return ctx.cache[key]


def deploy_scope(ctx, u):
    """배포 판단에 넣는 후보와 뺀 후보(KNOWN에 적는 문구). 규칙(2026-10-19 디스패처 결정 — 승격 PR은 배포 브랜치 역사에
    없다): required 항목은 언제나 넣는다. required가 아닌 합쳐진 PR은 base가 기본 브랜치·배포 증명 브랜치일 때만, 커밋은
    기본 브랜치에서 닿을 때만(모르면 넣는다 — 보수적). 열린·닫힌 PR은 role과 상관없이 배포 판단에 없다."""
    if u.scope is None:
        inn, notes = [], []
        for c in u.cands:
            if c["kind"] == "pr" and c.get("state") != "MERGED":
                continue                     # 안 합친 PR은 배포 판단에 없다(required면 g_required_kind가 막는다)
            if u.v["roles"][c["id"]] == "required":
                inn.append(c)
            elif c["kind"] == "pr":
                if c.get("base") in deploy_branches(ctx):
                    inn.append(c)
                else:
                    notes.append("다른 브랜치로 합쳐진 PR #%d(%s) — 배포 판단에서 제외" % (c["number"], c.get("base")))
            elif on_default(ctx, c) is False:
                notes.append("기본 브랜치에 없는 커밋 %s(%s) — 배포 판단에서 제외"
                             % (c["sha"][:12], ", ".join(str(r) for r in c.get("refs") or []) or "다른 브랜치"))
            else:
                inn.append(c)
        u.scope = (inn, notes)
    return u.scope


def _deployable(ctx, u):
    return deploy_scope(ctx, u)[0]


def qa_required_base(ctx, u):
    bad = ["%s(%s)" % (cand_name(c), c.get("base")) for c in u.cands if u.v["roles"][c["id"]] == "required"
           and c["kind"] == "pr" and c.get("state") == "MERGED" and c.get("base") not in deploy_branches(ctx)]
    return "다른 브랜치로 합쳐진 PR이 필요한 변경으로 표시됨: %s" % ", ".join(bad) if bad else None


def qa_reverted(ctx, u):
    bad = [cand_name(c) for c in _deployable(ctx, u) if c.get("reverted_by")]
    return "%s에서 되돌려진 변경: %s" % (deploy_word(ctx.binding), ", ".join(bad)) if bad else None


def qa_cherry_pick(ctx, u):
    bad = [cand_name(c) for c in _deployable(ctx, u)
           if c.get("on_S") is False and c.get("patch_equivalent_on_S") is True]
    return "체리픽으로만 들어감: %s" % ", ".join(bad) if bad else None


def qa_s_unknown(ctx, u):
    bad = [cand_name(c) for c in _deployable(ctx, u) if c.get("on_S") is None]
    return "%s 포함 여부를 모름: %s" % (deploy_word(ctx.binding), ", ".join(bad)) if bad else None


def _not_on_s(ctx, u, required):
    return [cand_name(c) for c in _deployable(ctx, u)
            if c.get("on_S") is False and c.get("patch_equivalent_on_S") is not True
            and not c.get("reverted_by") and (u.v["roles"][c["id"]] == "required") == required]


def qa_other_not_on_s(ctx, u):
    bad = _not_on_s(ctx, u, False)
    return "합쳐졌지만 %s에 없음: %s" % (deploy_word(ctx.binding), ", ".join(bad)) if bad else None


def qa_required_not_on_s(ctx, u):
    bad = _not_on_s(ctx, u, True)
    return "%s 대기: %s" % (deploy_word(ctx.binding), ", ".join(bad)) if bad else None


def g_open_prs(ctx, u):
    """진행 중인 작업(증거 제외 open-pr·other-repo 뒤의 두 번째 확인): 열린 PR, 키 이름 브랜치, 다른 저장소의 언급."""
    ns, brs, other = (u.ev.get(k) or [] for k in ("open_pr_mentions", "open_branches", "other_repo_mentions"))
    parts = []
    if ns:
        parts.append("이 티켓을 언급하는 열린 PR: %s" % ", ".join("PR #%s" % n for n in ns))
    if brs:
        parts.append("이 티켓 이름의 브랜치가 진행 중: %s" % ", ".join(str(b) for b in brs))
    if other:
        parts.append("다른 저장소에도 이 티켓 작업이 있음: %s" % ", ".join("%s#%d" % (o["repo"], o["number"]) for o in other))
    return "; ".join(parts) or None


def g_not_hold(ctx, u):
    hold = [str(h) for h in (ctx.binding or {}).get("hold") or []]
    return "보류 상태: %s" % u.issue.get("status_name") if str(u.issue.get("status_id")) in hold else None


def g_not_at_target(ctx, u):
    if not u.target:
        return NA
    return "이미 목표 상태" if str(u.issue.get("status_id")) == u.target else None


def g_assignee(ctx, u):
    if not ctx.account:
        return "내 Jira 계정을 모름"
    return None if u.issue.get("assignee") == ctx.account else "담당자가 내가 아님"


def g_transition(ctx, u):
    if not u.target:
        return NA
    for t in u.ev.get("transitions") or []:
        if isinstance(t, dict) and str(t.get("to_id")) == u.target and P.DIGITS.fullmatch(str(t.get("id") or "")):
            u.tr = t
            return None
    return "%s 가는 전환이 없음" % ("QA로" if u.level == "TO-QA" else "닫기(Closed)로")


def cl_complete(ctx, u):
    """TO-CLOSED도 증거가 끝까지 모여야 한다 — 불완전한 후보 목록은 이 티켓의 열린 PR을 숨길 수 있다."""
    return None if u.ev.get("complete") is True else "이 티켓에 연결된 변경 목록을 끝까지 읽지 못함"


def cl_bound(ctx, u):
    return None if (ctx.binding or {}).get("closed") else "저장소 등록부에 닫기(Closed) 상태가 없음"


def cl_not_working(ctx, u):
    name = str(u.issue.get("status_name") or "")
    return "진행·리뷰 중인 티켓은 닫지 않음: %s" % name if name.casefold() in ("in progress", "review") else None


def cl_own_work(ctx, u):
    """닫기 판정인데 이 티켓의 작업이 보이면(required 후보, 또는 대체 근거 PR이 이 티켓의 후보) QA 경로로 판단한다."""
    b = u.v["basis"]
    ids = {c["id"] for c in u.cands}
    own = any(u.v["roles"][c["id"]] == "required" for c in u.cands) or \
        (b["pr"] is not None and "pr:%d" % b["pr"] in ids)
    return "이 티켓의 작업으로 보임 — QA 경로로 판단" if own else None


def cl_basis_exists(ctx, u):
    b = u.v["basis"]
    if b["pr"] is not None:
        return NA
    if b["key"] == u.key:
        return "근거 티켓이 이 티켓 자신임"
    st, info = jira_target(ctx, b["key"])
    if st == "missing":
        return "근거 티켓 없음: %s" % b["key"]
    if st != "ok":
        return "근거 티켓 확인 못 함: %s" % b["key"]
    return "근거 티켓이 이 티켓 자신임" if is_self(this_ticket(u), info) else None


def _basis_target(ctx, u, kind):
    """close_basis가 kind(duplicate|superseded)이고 근거 티켓을 읽었으면 그 정보, 아니면 None(해당 없음)."""
    b = u.v["basis"]
    if b["type"] != kind or b["key"] is None:
        return None
    st, info = jira_target(ctx, b["key"])
    return info if st == "ok" else None


def cl_dup_same_project(ctx, u):
    b = u.v["basis"]
    if b["type"] != "duplicate":
        return NA
    if b["key"].rsplit("-", 1)[0] != u.issue.get("project"):
        return "중복 근거 티켓이 다른 프로젝트: %s" % b["key"]
    info = _basis_target(ctx, u, "duplicate")
    return NA if info is None else dup_project_problem(this_ticket(u), info)


def cl_sup_newer_or_done(ctx, u):
    info = _basis_target(ctx, u, "superseded")
    return NA if info is None else sup_newer_problem(this_ticket(u), info)


def cl_sup_joined(ctx, u):
    info = _basis_target(ctx, u, "superseded")
    return NA if info is None else sup_joined_problem(this_ticket(u), info)


def cl_sup_pr_merged(ctx, u):
    b = u.v["basis"]
    if b["pr"] is None:
        return NA
    d = gh_item(ctx, "pr", b["pr"])
    if d is None:
        return "근거 PR 확인 안 됨: PR #%d" % b["pr"]
    return None if d.get("state") == "MERGED" else "근거 PR이 합쳐지지 않음: PR #%d" % b["pr"]


def cl_dup_closing(ctx, u):
    """두 번째 차례에서만 부른다: 중복 근거 티켓이 이번 계획에서 같이 닫히면 실패."""
    b = u.v["basis"]
    return "중복 근거 티켓도 이번 계획에서 닫힘: %s" % b["key"] if b["type"] == "duplicate" and \
        b["key"] in ctx.closing else None


CLOSE_GATES = (g_complete, g_cites_present, g_close_jira_only, g_cites_resolve)
TOQA_GATES = (qa_bound, g_complete, g_cites_present, g_cites_resolve, qa_reqs_present, qa_reqs_met, qa_reqs_linked,
              g_required_kind, qa_required_base, qa_deploy, qa_reverted, qa_cherry_pick, qa_s_unknown,
              qa_other_not_on_s, qa_required_not_on_s, g_open_prs, g_not_hold, g_not_at_target, g_assignee,
              g_transition)
TOCLOSED_GATES = (cl_bound, cl_complete, g_cites_present, g_cites_resolve, cl_own_work, cl_basis_exists,
                  cl_dup_same_project, cl_sup_newer_or_done, cl_sup_joined, cl_sup_pr_merged, g_open_prs,
                  cl_not_working, g_not_hold, g_not_at_target, g_assignee, g_transition)
WAIT_GATES = {"qa_required_not_on_s"}     # 이것만 실패하면 KEEP "<이름> 배포 대기"
ME_DECIDER = "이 저장소 정리 담당(나)"
# 실패 조건 → (통과했을 때 KNOWN에 적는 사실, DECIDER, RECOMMEND). {dep} = deploy_word(바인딩) — gate_text가 채운다
GATE_TEXT = {
    "g_complete": ("증거 수집 완료", ME_DECIDER, "증거를 다시 모은 뒤 다음 계획에서 판단"),
    "g_cites_present": ("근거 인용 있음", ME_DECIDER, "닫는 근거(PR·커밋·파일)를 적어 판정을 다시 돌림"),
    "g_cites_resolve": ("인용한 근거 확인됨", ME_DECIDER, "인용한 근거가 실제로 맞는지 확인하고 다음 계획에서 처리"),
    "g_close_jira_only": (None, ME_DECIDER, "Jira 티켓 말고 닫는 근거(PR·커밋·파일)가 있는지 확인해 직접 닫거나, 남길 이슈면 "
                                            "판정을 남기기로 다시 돌림"),
    "qa_bound": ("QA 이동 기준 등록됨", "저장소 등록부 담당",
                 "저장소 등록부에 QA 상태(jira-qa)와 배포 기준(deploy-proof)을 적고 다시 실행"),
    "qa_reqs_present": ("요구사항 목록 있음", ME_DECIDER, "티켓 요구사항을 줄마다 적어 판정을 다시 돌림"),
    "qa_reqs_met": ("요구사항 모두 반영", "이 티켓 담당(나)", "남은 요구사항을 처리할지, 티켓을 나눌지 정함"),
    "qa_reqs_linked": ("요구사항마다 필요한 변경 연결", ME_DECIDER, "요구사항마다 반영한 PR·커밋을 찾아 판정을 다시 돌림"),
    "qa_required_base": ("필요한 PR이 기본 브랜치·{dep} 브랜치로 합쳐짐", "이 티켓 담당(나)",
                         "기본 브랜치에 합쳐진 PR을 필요한 변경으로 다시 골라 판정을 다시 돌림"),
    "g_required_kind": ("필요한 변경이 모두 합쳐짐", "이 티켓 담당(나)", "필요한 PR이 합쳐진 뒤 다음 계획에서 처리"),
    "qa_deploy": ("{dep} 기록 있음", "{dep} 담당", "{dep}가 성공한 뒤 다음 계획에서 처리"),
    "qa_reverted": ("{dep}에서 되돌린 변경 없음", "이 티켓 담당(나)", "왜 되돌렸는지 확인하고 티켓을 옮길지 정함"),
    "qa_cherry_pick": (None, "{dep} 담당",
                       "체리픽 내용이 원래 변경과 같은지 직접 확인해 옮기거나, 원래 커밋이 배포된 뒤 처리"),
    "qa_s_unknown": (None, ME_DECIDER, "증거를 다시 모은 뒤 다음 계획에서 판단"),
    "qa_other_not_on_s": (None, "이 티켓 담당(나)",
                          "{dep}에 없는 관련 변경이 이 티켓에 필요한지 확인하고 판정을 다시 돌림"),
    "qa_required_not_on_s": (None, "{dep} 담당", "{dep} 뒤 다음 계획에서 처리"),
    "g_open_prs": ("열린 관련 PR 없음", "그 PR 작성자", "열린 PR이 끝난 뒤 다음 계획에서 처리"),
    "g_not_hold": ("보류 상태 아님", "QA 담당", "보류가 풀린 뒤 다음 계획에서 처리"),
    "g_not_at_target": ("목표 상태 아님", ME_DECIDER, "할 일 없음 — 다음 계획에서 다시 확인"),
    "g_assignee": ("담당자가 나", "이 티켓 담당자", "담당자를 확인한 뒤 다음 계획에서 처리"),
    "g_transition": ("옮기는 전환 있음", "Jira 프로젝트 관리자", "그 상태로 가는 전환이 있는지 확인하고 직접 옮김"),
    "cl_complete": ("증거 수집 완료", ME_DECIDER, "증거를 다시 모은 뒤 다음 계획에서 판단"),
    "cl_bound": ("닫기 기준 등록됨", "저장소 등록부 담당", "저장소 등록부에 닫기 상태를 적고 다시 실행"),
    "cl_own_work": ("이 티켓의 작업이 아님", "이 티켓 담당(나)",
                    "{dep}를 확인해 QA로 옮길지 판정을 다시 돌림"),
    "cl_basis_exists": ("근거 티켓 있음", "이 티켓 담당(나)", "근거 티켓을 확인하고 판정을 다시 돌림"),
    "cl_dup_same_project": ("중복 근거가 같은 프로젝트", "이 티켓 담당(나)", "다른 프로젝트의 중복이면 직접 닫음"),
    "cl_sup_newer_or_done": ("대체 티켓이 더 새것이거나 끝남", "이 티켓 담당(나)", "어느 티켓을 남길지 정하고 직접 정리"),
    "cl_sup_joined": ("대체 티켓과 연결됨", "이 티켓 담당(나)", "두 티켓을 링크로 잇거나 직접 닫음"),
    "cl_sup_pr_merged": ("근거 PR이 합쳐짐", "그 PR 작성자", "PR이 합쳐진 뒤 다음 계획에서 처리"),
    "cl_not_working": ("진행·리뷰 상태 아님", "이 티켓 담당(나)", "작업이 끝났으면 QA로 옮기고, 아니면 상태를 정리한 뒤 다시 판단"),
    "cl_dup_closing": ("중복 근거 티켓은 남음", "이 티켓 담당(나)", "둘 중 남길 티켓을 정하고 다음 계획에서 처리"),
    "row_check": ("실행 행 형식 통과", ME_DECIDER, "판정 도구가 실행 행을 만들지 못함 — 이 티켓은 직접 확인"),
}
VERDICT_KO = {"CLOSE": "닫기", "TO-QA": "QA로 옮기기", "TO-CLOSED": "티켓 닫기"}


def gate_text(ctx, name):
    """GATE_TEXT[name]의 세 글에 이 바인딩의 배포 이름({dep})을 채운다."""
    dep = deploy_word(ctx.binding)
    return tuple(t.replace("{dep}", dep) if t else t for t in GATE_TEXT[name])


# ───────────────────────── 단위 ─────────────────────────

class Unit:
    def __init__(self, entry, ev, row, raw):
        self.id, self.kind = entry["unit"], entry["kind"]
        self.file = unit_file(self.id)
        self.judge, self.why_not = entry.get("judge") is True, entry.get("why_not") or ""
        self.ev, self.row, self.raw = ev, row, raw
        self.key = self.id[len("jira#"):] if self.kind == "jira" else None
        self.issue = ev.get("issue") if isinstance(ev.get("issue"), dict) else {}
        self.cands = [c for c in ev.get("candidates") or [] if isinstance(c, dict)] if self.kind == "jira" else []
        self.deploy = ev.get("deploy")
        self.v = None
        self.scope = None        # (배포 판단에 넣는 후보, 뺀 후보 문구) — TO-QA 확인 때 한 번
        self.level = self.target = self.tr = None
        self.result = None       # dict: cls, ev(tier-3 증거 dict) | comment | line
        self.downgraded = False


def other_mention_ok(o):
    """증거가 쓰는 다른 저장소 언급 한 건 = {"repo": "owner/name", "number": 양의 int(bool 아님), "state": OPEN|MERGED|CLOSED,
    "title": str} (chore-evidence.py _jira_unit의 other 목록과 같은 모양)."""
    if not isinstance(o, dict):
        return False
    repo, parts = o.get("repo"), str(o.get("repo")).split("/")
    return (isinstance(repo, str) and len(parts) == 2 and all(parts)
            and type(o.get("number")) is int and o["number"] > 0
            and o.get("state") in P.ITEM_STATES and isinstance(o.get("title"), str))


def _tri(v):
    return v is None or type(v) is bool


def _str_list(v):
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def check_evidence(u):
    """Jira 단위 증거의 모양(ev-schema) — 어긋나면 증거 결함이라 Fail("증거 형식 오류: …"), 그럴듯한 값으로 메우지 않는다.
    후보: id·kind·번호/sha 모양, on_S·patch_equivalent_on_S = bool|None, reverted_by = 목록, folded_commits = 목록(있으면).
    단위: open_pr_mentions = 정수 목록, open_branches = 이름 목록, other_repo_mentions = other_mention_ok 목록,
    excluded = None|dict,
    deploy = None|dict(stale = bool, 있으면)."""
    def bad(what):
        raise Fail("증거 형식 오류: %s %s" % (u.id, what))
    seen = set()
    for c in u.cands:
        if c.get("kind") == "pr":
            ok = type(c.get("number")) is int and c["number"] > 0 and c.get("id") == "pr:%d" % c["number"] \
                and c.get("state") in P.ITEM_STATES
        elif c.get("kind") == "commit":
            ok = P.HEX40.fullmatch(str(c.get("sha") or "")) is not None and c.get("id") == "c:" + c["sha"]
        else:
            ok = False
        if not ok or c["id"] in seen:
            bad("후보 %r" % c.get("id"))
        seen.add(c["id"])
        for k in ("on_S", "patch_equivalent_on_S"):
            if not _tri(c.get(k)):
                bad("후보 %s의 %s가 참/거짓/없음이 아님 (%r)" % (c["id"], k, c.get(k)))
        if not _str_list(c.get("reverted_by")):
            bad("후보 %s의 reverted_by가 목록이 아님" % c["id"])
        if "folded_commits" in c and not _str_list(c["folded_commits"]):
            bad("후보 %s의 folded_commits가 목록이 아님" % c["id"])
    raw = u.ev.get("candidates")
    if raw is not None and (not isinstance(raw, list) or len(raw) != len(u.cands)):
        bad("candidates가 후보 목록이 아님")
    om = u.ev.get("open_pr_mentions")
    if not (isinstance(om, list) and all(type(n) is int for n in om)):
        bad("open_pr_mentions가 PR 번호 목록이 아님")
    if not _str_list(u.ev.get("open_branches")):
        bad("open_branches가 브랜치 이름 목록이 아님")
    orm = u.ev.get("other_repo_mentions")
    if not isinstance(orm, list):
        bad("other_repo_mentions가 목록이 아님")
    for o in orm:
        if not other_mention_ok(o):
            bad("other_repo_mentions 원소 %r가 {repo: owner/name, number: 양의 정수, state: OPEN|MERGED|CLOSED, "
                "title: 글} 꼴이 아님" % (o,))
    if not (u.ev.get("excluded") is None or isinstance(u.ev.get("excluded"), dict)):
        bad("excluded가 없음/객체가 아님")
    d = u.ev.get("deploy")
    if not (d is None or isinstance(d, dict) and type(d.get("stale", False)) is bool):
        bad("deploy가 없음/객체가 아님 (또는 stale이 참/거짓이 아님)")


def unit_file(uid):
    kind, _, rest = uid.partition("#")
    return "%s-%s" % (kind, rest)


def jira_links(u):
    """tier-3 증거 jira= 목록: pr/issue = 언급한 Jira 키와 상태, jira = 이슈 링크 대상과 상태."""
    out, seen = [], set()
    src = u.ev.get("links") if u.kind == "jira" else u.ev.get("jira")
    for j in src or []:
        if not isinstance(j, dict) or not isinstance(j.get("key"), str) or not P.JIRA_KEY.fullmatch(j["key"]):
            continue
        if j["key"] in seen:
            continue
        seen.add(j["key"])
        out.append((j["key"], j.get("status_name") or "상태 모름"))
    return out


def complete_word(u):
    c = u.ev.get("complete")
    return "yes" if c is True else "no" if c is False else ""


def base_ev(u, v, reason, **kw):
    ev = {"v": v, "reason": reason, "cites": ",".join(c["raw"] for c in u.v["cites"]) if u.v else "",
          "complete": complete_word(u), "jira": jira_links(u)}
    ev.update(kw)
    return ev


def from_verdict(u):
    """판정 그대로의 KEEP / AMBIGUOUS."""
    v = u.v
    return {"cls": v["verdict"].lower(), "ev": base_ev(u, v["verdict"], v["reason"], known=v["known"],
                                                         missing=v["missing"], owner=v["owner"], decider=v["decider"],
                                                         recommend=v["recommend"])}


def downgrade(ctx, u, fails, held):
    """기계 확인 실패 → AMBIGUOUS(또는 배포 대기만이면 KEEP "<이름> 배포 대기")."""
    u.downgraded = True
    v = u.v
    names = [n for n, _ in fails]
    missing = "; ".join(m for _, m in fails)
    notes = "".join(" / " + n for n in (u.scope[1] if u.scope else ()))
    if all(n in WAIT_GATES for n in names):
        dep = deploy_word(ctx.binding)
        return {"cls": "keep", "ev": base_ev(u, "KEEP", "%s 대기 — 아직 %s에 없음: " % (dep, dep)
                                             + ", ".join(m.split(": ", 1)[-1] for _, m in fails),
                                             known="판정 의견: " + v["reason"] + notes)}
    known = "판정 의견: " + v["reason"] + (" / 확인된 것: " + ", ".join(held) if held else "") + notes
    _, decider, recommend = gate_text(ctx, names[0])
    reason = "판정(%s)을 기계 확인이 막음 — %s" % (VERDICT_KO.get(v["verdict"], v["verdict"]), fails[0][1])
    return {"cls": "ambiguous", "ev": base_ev(u, "AMBIGUOUS", reason, known=known, missing=missing, owner="me",
                                              decider=decider, recommend=recommend)}


S_FAMILY = ("qa_deploy", "qa_reverted", "qa_cherry_pick", "qa_s_unknown", "qa_other_not_on_s",
            "qa_required_not_on_s")


def run_gates(ctx, u, gates):
    """모든 조건을 돌린다(첫 실패에서 멈추지 않음 — MISSING에 전부). → (실패 [(이름, 문구)], 통과한 사실 [글])."""
    fails, held = [], []
    for g in gates:
        msg = g(ctx, u)
        if msg is NA:
            continue
        if msg:
            fails.append((g.__name__, msg))
        elif GATE_TEXT[g.__name__][0]:
            held.append(gate_text(ctx, g.__name__)[0])
    if gates is TOQA_GATES and not any(n in S_FAMILY for n, _ in fails):
        held.append("관련 변경 모두 %s에 포함" % deploy_word(ctx.binding))
    return fails, held


# ───────────────────────── 댓글 ─────────────────────────

def comment_ok(text, marker_to=None):
    """게시 가능한 댓글인가: check_comment_text 통과 + ADF 왕복 + (Jira면) 마지막 줄 표지가 MARKER에 맞고 to_name과 같음."""
    try:
        CJ.check_comment_text(text)
    except CJ.JiraError:
        return False
    if CJ.flatten(CJ.build_adf(text)) != text:
        return False
    if marker_to is not None:
        m = P.MARKER.fullmatch(text.split("\n")[-1])
        if not m or m.group(1) != marker_to:
            return False
    return True


def last_update(u):
    """댓글에 적는 마지막 갱신 날짜(한국 시각) = 승인 snapshot의 updated."""
    return kst(u.row["snapshot"]["updated"]).strftime("%Y-%m-%d")


def pr_comment(u):
    day = last_update(u)
    links = jira_links(u)
    tickets = " (작업 티켓 %s)" % ", ".join("%s: %s" % kv for kv in links) if links else ""
    return ("저장소 정리 중 열린 PR을 하나씩 확인했습니다. %s 이 PR의 마지막 갱신은 %s입니다%s. "
            "필요하면 다시 열어 주세요. 브랜치는 지우지 않고 그대로 둡니다." % (sentence(u.v["reason"]), day, tickets))


def issue_comment(u):
    day = last_update(u)
    cites = ", ".join(cite_words(c) for c in u.v["cites"])
    return ("저장소 정리 중 열린 이슈를 하나씩 확인했습니다. %s 근거: %s. 마지막 갱신은 %s입니다. 필요하면 다시 열어 주세요."
            % (sentence(u.v["reason"]), cites, day))


def marker(to_name, date):
    return P.MARKER_FMT % (to_name, date)


def qa_comment(u, to_name, date, url, dep):
    parts = []
    for c in u.cands:
        if u.v["roles"][c["id"]] != "required":
            continue
        parts.append("PR #%d(%s에 합쳐짐)" % (c["number"], c.get("base") or "기본 브랜치") if c["kind"] == "pr"
                     else "커밋 %s" % c["sha"][:12])
    when = kst(u.deploy["completed"]).strftime("%Y-%m-%d %H:%M")
    body = ("저장소 정리 중 확인했습니다. 이 작업의 변경(%s)은 %s %s(한국 시각 %s)에 포함되어 있습니다. "
            "그래서 %s%s 옮깁니다. %s" % (", ".join(parts), dep, url, when, to_name, ro(to_name),
                                       sentence(u.v["reason"])))
    return body + "\n" + marker(to_name, date)


def closed_comment(u, to_name, date):
    b = u.v["basis"]
    target = b["key"] if b["pr"] is None else "PR #%d" % b["pr"]
    body = ("저장소 정리 중 확인했습니다. %s 근거: %s. 그래서 닫습니다. 필요하면 다시 열어 주세요."
            % (sentence(u.v["reason"]), target))
    return body + "\n" + marker(to_name, date)


# ───────────────────────── 행 만들기 ─────────────────────────

def plan_items(u):
    out = []
    for c in u.cands:
        role = u.v["roles"][c["id"]]
        if c["kind"] == "pr":
            out.append({"kind": "pr", "pr": c["number"], "state": c.get("state"), "role": role,
                        "sha": c.get("merge_sha") if c.get("state") == "MERGED" else None})
        else:
            out.append({"kind": "c", "pr": None, "state": None, "role": role, "sha": c.get("sha")})
    return out


def jira_tier2(ctx, u):
    """TO-QA / TO-CLOSED → tier-2 jira-transition 행 바이트. 만들 수 없으면 None과 이유."""
    b, iss = ctx.binding, u.issue
    to_name = str(u.tr.get("to_name") or "")
    expected = str(iss.get("updated") or "")
    if P.jira_time(expected) is None:
        return None, "Jira 갱신 시각 형식이 계획과 맞지 않음"
    try:
        items = P.encode_items(plan_items(u))
        if u.level == "TO-QA":
            reqs = P.encode_reqs([{"text": r["text"], "target": r["target"]} for r in u.v["reqs"]])
            s, run, url = u.deploy["S"], str(u.deploy["run"]), run_url(ctx, u.deploy)
            basis = "-"
            text = qa_comment(u, to_name, ctx.date, url, deploy_word(ctx.binding))
        else:
            reqs, s, run, url, basis = "-", "-", "-", "-", u.v["basis_raw"]
            text = closed_comment(u, to_name, ctx.date)
    except P.PlanError as e:
        return None, "실행 행을 만들 수 없음: %s" % e
    if not comment_ok(text, to_name):
        return None, "게시할 댓글이 형식 검사를 통과하지 못함"
    snap = {"site": b["site"], "project": b["project"], "issue_id": str(iss.get("id") or ""),
            "status": str(iss.get("status_id") or ""), "status_name": str(iss.get("status_name") or ""),
            "assignee": str(iss.get("assignee") or ""), "account": ctx.account, "to": str(u.tr["id"]),
            "to_status": u.target, "to_name": to_name, "summary": str(iss.get("summary") or ""), "level": u.level,
            "S": s, "run": run, "run_url": url, "items": items, "reqs": reqs, "close_basis": basis}
    try:
        snap["ledgers"] = P.encode_ledgers(ctx.ledgers)
    except P.PlanError as e:
        return None, "제외 원장 경로를 계획에 적을 수 없음: %s" % e
    snap = {k: snap[k] for k in P.JIRA_SNAP_KEYS}
    ref = P.penc(u.id)
    try:
        snap_raw, ev_raw = P.encode_snapshot(snap), P.penc(text)
        x = expected.encode("utf-8")
        jira = P.check_jira_transition(u.id, expected, P.parse_snapshot(snap_raw, u.id), ev_raw, u.id, ctx.remote)
        P.check_jira_binding([{"line": 0, "ref": u.id, "snapshot": snap, "jira": jira}], b["site"], b["project"],
                             b.get("qa"), b.get("closed"))
    except P.PlanError as e:
        return None, "실행 행 검사 실패: %s" % e
    return b"\t".join([b"2", P.penc(P.JIRA_ACTION), ref, x, snap_raw, ev_raw]), None


# ───────────────────────── Jira로 옮기기 (v4.3 move-issue, design v9 §5 build) ─────────────────────────

MOVE_TYPE_WHY = "옮길 Jira 유형"


def move_type(ctx, name):
    """판정의 JIRA_TYPE → index move.types의 {id, name} 하나, 없으면 None. 증거 .md는 유형 이름을 chore-evidence _inl 꼴
    (공백 접기 · 백틱 → ' · 인라인 코드)로 보여 준다 — 그 꼴(백틱 안쪽 또는 백틱까지)과 정확히 같은 유형이 하나일 때만
    (chore-evidence가 _inl 꼴이 겹치는 유형 목록을 거절하므로 둘 이상은 없다). 행은 그 유형의 id·이름 원문을 쓴다."""
    if not name:
        return None
    inl = EV()._inl
    hits = [t for t in ctx.move["types"] if name in (inl(t["name"]), inl(t["name"])[1:-1])]
    return hits[0] if len(hits) == 1 else None


def mv_jira(what, fn, *a):
    """Jira 읽기(chore-jira.py 함수): 인증 실패 = Fail(exit 1, jira_target과 같음), 그 밖 실패 = 이 이슈만 MoveBlock."""
    try:
        return fn(*a)
    except CJ.JiraError as e:
        if e.code == CJ.AUTH:
            raise Fail("Jira 인증 실패 — 자격 증명 확인") from None
        raise MoveBlock("확인 못 함: " + what, CJ.scrub(e.message)) from None


def mv_gh(what, fn, *a):
    try:
        return fn(*a)
    except CJ.GhError as e:
        raise MoveBlock("확인 못 함: " + what, CJ.scrub(str(e))) from None


def mv_project(ctx):
    """build의 첫 move 행 전에 한 번: 지금 Jira 프로젝트 id == 증거의 move.project_id (확정 404 = None = 다름)."""
    pid = mv_jira("Jira 프로젝트", CJ.project_id, ctx.jira(), ctx.move["project"])
    if pid != ctx.move["project_id"]:
        raise MoveBlock("Jira 프로젝트가 증거 때와 다름", "증거 %s · 지금 %s" % (ctx.move["project_id"], pid or "없음"),
                        "저장소 등록부의 Jira 연결을 확인하고 증거를 다시 모음")
    return pid


def mv_chore_dir(ctx):
    """일지 폴더 = --clone의 <git common dir>/chore (chore-jira.py resolve가 쓰는 _git_common_dir 그대로 — 엔진 chore_paths와 같은 곳)."""
    try:
        return os.path.join(CJ._git_common_dir(ctx.clone), "chore")
    except CJ.Stop as e:
        raise Fail("이관 일지 폴더를 찾을 수 없음: %s" % e.message) from None


def mv_history(ctx, ref):
    try:
        return CJ.move_history(ctx.once("chore_dir", lambda: mv_chore_dir(ctx)), ref)
    except CJ.FormatError as e:
        raise MoveBlock("확인 못 함: 이관 일지", CJ.scrub(str(e)), "일지를 읽지 못하는 까닭을 확인한 뒤 다음 계획에서 처리") from None


def move_line(ctx, u, t):
    """KEEP 이슈 하나 → (move-issue 행 바이트, payload 바이트, adopt KEY | None). 막히면 MoveBlock(design v9 §5, 처음 맞는 것)."""
    mv, ref, n = ctx.move, u.id, int(u.id.split("#")[1])
    if not ctx.account:
        raise MoveBlock("내 Jira 계정을 모름")
    if not CJ.ACCT_RE.fullmatch(ctx.account):          # apply가 계획을 읽을 때 단계 전체를 멈추는 모양(chore-jira.py load)
        raise MoveBlock("내 Jira 계정을 일지에 적을 수 없는 모양", "증거의 계정 %r" % ctx.account[:80],
                        "증거의 Jira 계정을 확인하고 증거를 다시 모음")
    ctx.once("project", lambda: mv_project(ctx))
    login = ctx.once("gh_login", lambda: mv_gh("GitHub 로그인", CJ.gh_login))
    view = mv_gh("GitHub 이슈 #%d" % n, CJ.gh_issue, ctx.remote, n)
    if view["updated"] != u.issue.get("updated"):
        raise MoveBlock("판정 뒤 이슈가 바뀜 — 다음 계획에서", "증거 %s · 지금 %s" % (u.issue.get("updated"), view["updated"]))
    if view["state"] != "OPEN":
        raise MoveBlock("이슈가 이미 닫혀 있음 — 다음 계획에서")
    cols = u.raw.split(b"\t")
    if cols[3] != view["updated"].encode("utf-8"):
        raise MoveBlock("계획 뒤 이슈가 바뀜 — 다음 계획에서", "계획 %s · 지금 %s" % (cols[3].decode("utf-8", "replace"),
                                                                           view["updated"]))
    h = mv_history(ctx, ref)                                                          # 1 미결
    pend = h["pending_creates"] + h["pending_comments"]
    if pend:
        raise MoveBlock("이전 실행 결과 미확정 — resolve", "미결 전송 " + ", ".join(pend),
                        "이전 실행의 결과를 확인해 기록한 뒤 다음 계획에서 처리")
    src = ctx.once("source_b", lambda: mv_jira("출처 B 검색", CJ.source_b, ctx.jira(), mv["project"], ctx.repo_name))
    T, b, c, gone = mv_jira("이 이슈의 티켓", CJ.live_candidates, ctx.jira(), h, src, ctx.account, ctx.repo_url, n)   # 2
    reported = CJ.parse_ts(ctx.hdr["created"])        # 이 계획의 보고 시각 — apply E1이 같은 값과 비교한다
    for key in gone:    # 확인을 마친 적 없는(댓글 전송 없음) chore KEY의 404는 "지워짐"이 아니다 — 못 읽음일 수 있다
        if not CJ.needs_post_create_check(h, key):
            continue                                    # 댓글을 보낸 KEY = 예전 규칙(404 = 지워짐)
        if h["keys"][key]["run_id"] == ctx.hdr["run_id"]:
            raise post_create_block(key, CJ.M20)        # 이 계획의 KEY — 플래그와 무관, 시계와도 무관(contract round 4d)
        if CJ.parse_ts(h["keys"][key]["at"]) >= reported:
            raise post_create_block(key, CJ.M20, after_report=True)   # apply E1과 같음 — 플래그와 무관
        if key not in ctx.confirmed:
            raise post_create_block(key, CJ.M20)        # 보고 전에 만든 KEY: 오너가 지워짐을 확인했을 때만 새로 만듦
        ctx.confirmed_used.add(key)                     # 플래그가 실제로 풀어 준 KEY만 "쓰임"
    if b:
        raise MoveBlock("다른 계정의 chore 티켓이 이 이슈를 가리킴", ", ".join(b),
                        "그 티켓을 만든 사람과 어느 티켓을 남길지 정한 뒤 다음 계획에서 처리")
    if len(T) == 1 and any(k == T[0] for _run, k in h["closed"]):   # 어느 정리가 옮기고 닫았는데 지금 열림 = 사람이 다시 엶
        raise MoveBlock("이전 정리가 옮기고 닫은 뒤 사람이 다시 연 이슈 — 다시 닫을지 오너가 정함",   # (contract round 5b) —
                        recommend="닫을 이유가 있으면 오너가 직접 닫음, 아니면 열린 채로 둠",       # 새 티켓 내용을 만들기 전에
                        known="%s — %s" % (T[0], CJ.M21), reason="Jira로 옮기기를 기계 확인이 막음 — %s — %s" % (T[0], CJ.M21))
    mentioned = [j["key"] for j in u.ev.get("jira") or [] if isinstance(j, dict) and j.get("found") is True
                 and isinstance(j.get("key"), str) and P.JIRA_KEY.fullmatch(j["key"])
                 and j["key"].rsplit("-", 1)[0] == mv["project"]]
    related = sorted((set(mentioned) | set(c)) - set(T) - set(gone), key=key_order)
    snap = {"project_id": mv["project_id"], "issuetype": t["id"], "account": ctx.account}
    ic = CJ.issue_check(view, snap, {"reason": u.v["reason"], "related": related}, h["R"], ctx.date, ctx.repo_url)
    if ic["payload"] is None:
        raise MoveBlock("새 티켓 내용을 만들 수 없음", recommend="이슈 제목·본문을 확인한 뒤 다음 계획에서 처리")
    adopt = prior = None                                                              # 3
    if len(T) >= 2:
        raise MoveBlock(CJ.M4, ", ".join(T), "남길 티켓 하나만 두고 나머지를 지운 뒤 다음 계획에서 처리")
    orphan = sorted({k for k, _cid in ic["valid"]} - set(T) - set(gone), key=key_order)
    if orphan:          # 지금 있는 이관 기록 댓글의 티켓을 후보로 못 알아봄 — 새로 만들면 티켓·댓글이 둘이 된다
        raise MoveBlock("기록된 티켓 %s를 이 이슈의 티켓으로 확인할 수 없음 — 사람이 판단" % ", ".join(orphan),
                        "후보 %s" % (", ".join(T) or "없음"),
                        "그 티켓이 이 이슈의 것인지 확인해 표지를 되살리거나 티켓과 이관 댓글을 정리한 뒤 다음 계획에서 처리")
    if T:
        key = T[0]
        acct = h["keys"][key]["acct"] if key in h["keys"] else ctx.account   # chore-jira.py C1과 같은 계정
        if CJ.needs_post_create_check(h, key):          # apply mv_c 머리와 같음: 만든 뒤 확인을 마친 적 없는 chore 티켓 —
            why = mv_jira(key, CJ.post_create_why, ctx.jira(), key, acct)   # 같은 계획 검사보다 먼저(그 재실행도 이 확인에서 멈춘다)
            if why is not None:
                raise post_create_block(key, why)
        if h["keys"].get(key, {}).get("run_id") == ctx.hdr["run_id"]:
            raise MoveBlock("이 계획이 이미 만든 티켓 %s — 승인된 계획으로 다시 실행" % key, "계획 " + ctx.hdr["run_id"],
                            "이 report 계획으로 다시 판정하지 말고, 그 실행의 멈춘 사유가 허용하면 승인한 계획을 같은 명령으로 다시 실행")
        miss = mv_jira(key, CJ.ticket_check, ctx.jira(), key, "orig", ic["payload"], acct, ctx.repo_url, n)
        if miss is not None:
            raise MoveBlock("이미 만든 티켓 %s가 승인본과 다름(티켓 수정 또는 이슈 변경)" % key, miss,
                            "그 티켓을 지우면 다음 계획이 새로 만듦 (옮긴 뒤 다시 열린 이슈면 GitHub에서 다시 닫아도 끝남)")
        mine = sorted(((cid, csha) for (k, cid), csha in h["R"].items() if k == key), key=lambda x: int(x[0]))
        if len(mine) >= 2:
            raise MoveBlock(CJ.M8, "%s 이관 댓글 %s" % (key, ", ".join(cid for cid, _ in mine)),
                            "하나만 남기고 나머지 이관 댓글을 지운 뒤 다음 계획에서 처리")
        adopt, prior = key, ("%s:%s" % mine[0] if mine else None)
    else:               # T 0개 = 새로 만듦 — 생성 화면 검사는 만드는 행에만(apply F와 같음; adopt 행은 만들지 않는다)
        why = ctx.once(("createmeta", t["id"]), lambda: mv_jira(
            "생성 화면", CJ.createmeta_ok, ctx.jira(), mv["project_id"], t["id"]))
        if why is not None:
            raise MoveBlock(CJ.MT_TYPE + why, "유형 %s" % t["name"], "생성 화면의 필수 칸을 정리하거나 다른 유형을 고른 뒤 다음 "
                            "계획에서 처리", "Jira 프로젝트 관리자")
    if ic["recorded_bad"]:                                                            # 4
        raise MoveBlock(CJ.bad_reason(ic), "댓글 " + ", ".join(cid for _k, cid in ic["recorded_bad"]),
                        "이관 댓글을 확인해 연결을 기록한 뒤 다음 계획에서 처리")
    rcid = {cid for _k, cid in h["R"]}
    loose = [cm["id"] for cm in view["comments"] if cm["id"] not in rcid
             and P.migration_comment(cm["body"], cm["author"], login)]
    if loose:
        raise MoveBlock(CJ.M10, "댓글 " + ", ".join(loose), "그 댓글을 지운 뒤 다음 계획에서 처리")
    snap = {"state": view["state"], "updated": view["updated"], "author": view["author"] or "", "title": view["title"],
            "site": mv["site"], "project": mv["project"], "project_id": mv["project_id"], "issuetype": t["id"],
            "issuetype_name": t["name"], "account": ctx.account, "gh_login": login, "source_sha": ic["source_sha"],
            "payload_sha": ic["payload_sha"], "adopt": adopt or "-", "prior": prior or "-"}
    try:
        gh = P.move_comment(mv["site"], u.v["reason"], ctx.date)
        ev_raw = P.encode_move_evidence({"reason": u.v["reason"], "gh": gh, "related": related})
        snap_raw = P.encode_snapshot({k: snap[k] for k in P.MOVE_SNAP_KEYS})
        P.check_move_issue(ref, P.raw_text(cols[3], ref), P.parse_snapshot(snap_raw, ref), ev_raw, ref)
    except P.PlanError as e:
        raise MoveBlock("실행 행을 만들 수 없음", str(e), "판정 이유·이슈 제목을 확인한 뒤 다음 계획에서 처리") from None
    return b"\t".join([b"2", P.penc(P.MOVE_ACTION), cols[2], cols[3], snap_raw, ev_raw]), ic["payload"], adopt


def post_create_block(key, why, after_report=False):
    """만든 뒤 확인(chore-jira.py post_create_why: M19 담당자·보고자 / M20 다시 읽을 수 없음)이 통과하지 않은 티켓 → MoveBlock,
    KNOWN = `<KEY> — ` + 그 문구(contract §6 round 3). apply는 같은 경우 차단기로 멈춘다 — build는 행을 만들지 않는다.
    after_report = 404인 확인 전 KEY를 이 계획의 보고(머리 줄 created=) 뒤에 만듦(contract round 4c — 플래그도 이 계획에서는
    풀지 못한다; MISSING이 같은 머리로 시작해 skill의 오너 질문은 그대로)."""
    if why == CJ.M20 and after_report:
        missing = "Jira에서 그 티켓이 있는지 확인 — 이 계획의 보고 뒤에 만든 티켓이라 다음 정리(새 report)에서 다시 판단"
        recommend = "Jira에서 %s가 있는지 확인한 뒤 다음 정리에서 처리" % key
    elif why == CJ.M20:
        missing, recommend = "Jira에서 그 티켓이 있는지 확인 — 다음 정리에서 다시 판단", "Jira에서 %s가 있는지 확인" % key
    else:
        missing = "그 티켓의 담당자를 떼고 보고자를 실행 계정으로 고친 뒤 — 다음 정리에서 다시 판단"
        recommend = "%s의 담당자·보고자를 확인해 고친 뒤 다음 계획에서 처리" % key
    return MoveBlock(missing, recommend=recommend, known="%s — %s" % (key, why),
                     reason="Jira로 옮기기를 기계 확인이 막음 — %s — %s" % (key, why))


def move_blocked(u, e):
    """옮기기를 막은 확인 → AMBIGUOUS (OWNER me, MISSING = 막은 조건, KNOWN = 판정 의견 + 그 사실). 기계 확인이 판정을 바꾼 것."""
    u.downgraded = True
    known = e.known or "판정 의견: " + u.v["reason"] + (" / " + e.detail if e.detail else "")
    return {"cls": "ambiguous", "ev": base_ev(u, "AMBIGUOUS", e.reason or "Jira로 옮기기를 기계 확인이 막음 — " + e.why,
                                              known=known, missing=e.why, owner="me", decider=e.decider or ME_DECIDER,
                                              recommend=e.recommend)}


def decide_move(ctx, u):
    """Jira로 옮기는 저장소의 KEEP 이슈 → move-issue 결과(그 자리에서 바뀌는 tier-2 행) 또는 AMBIGUOUS — 조용히 KEEP으로 두지 않는다."""
    t = move_type(ctx, u.v["jira_type"])
    if t is None:
        got = u.v["jira_type"]
        return move_blocked(u, MoveBlock(
            MOVE_TYPE_WHY, "판정의 유형 '%s'는 목록에 없음" % got if got else "",
            "판정을 다시 돌려 증거의 '남길 때 옮길 Jira 유형' 목록에서 하나를 고름",
            reason=("남길 이슈의 옮길 Jira 유형(%s)이 목록에 없음" % got) if got else "남길 이슈인데 옮길 Jira 유형을 고르지 않음"))
    try:
        line, payload, adopt = move_line(ctx, u, t)
    except MoveBlock as e:
        return move_blocked(u, e)
    return {"cls": P.MOVE_ACTION, "line": line, "payload": payload, "adopt": adopt}


BUILD_SNAP_KEYS = (b"verdict", b"title")      # build가 엔진 snapshot 끝에 붙이는 키 (입력에 있으면 떼고 다시 붙인다)


def engine_snapshot(raw):
    """입력 행의 snapshot 칸 바이트에서 build가 붙이는 키를 뗀 나머지(엔진이 쓴 쌍, 순서·바이트 그대로)."""
    if raw == b"-":
        return []
    return [kv for kv in raw.split(b";") if kv.split(b"=", 1)[0] not in BUILD_SNAP_KEYS]


def with_key(raw, key, value):
    """snapshot 바이트 끝에 key=<penc(value)> 하나를 붙인다(엔진 쌍은 그대로)."""
    return b";".join(engine_snapshot(raw) + [P.penc(key) + b"=" + P.penc(value)])


def row_title(u):
    """pr#N / issue#N 행의 제목 = 지금 증거 칸의 날것 제목(구조형이면 t), 비면 증거 json의 title."""
    title = u.row["unit"]["evidence"]["t"] if u.row.get("unit") else u.row["evidence"]
    if not title.strip():
        title = str(u.ev.get("title") or "") or "(제목 없음)"
    return title


def unit_line(u):
    """tier-3 pr#N / issue#N 행: ref·expected 그대로, snapshot = 엔진 쌍 + verdict=<v>(마지막), 증거 = 구조형."""
    cols = u.raw.split(b"\t")
    ev = dict(u.result["ev"], t=row_title(u))
    return b"\t".join(cols[:4] + [with_key(cols[4], "verdict", ev["v"]), P.encode_unit_evidence(ev)])


def jira_unit_line(u):
    s, name = str(u.issue.get("summary") or ""), str(u.issue.get("status_name") or "")
    snap = P.encode_jira_unit_snapshot(s, name) if s and name else b"-"
    return b"\t".join([b"3", b"report", P.penc(u.id), b"-", snap, P.encode_jira_evidence(u.result["ev"])])


# ───────────────────────── build ─────────────────────────

def read_json(path, what):
    try:
        with open(path, "rb") as fh:
            return json.loads(fh.read().decode("utf-8"))
    except FileNotFoundError:
        raise Fail("%s 없음: %s" % (what, path)) from None
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise Fail("%s 읽기 실패: %s (%s)" % (what, path, type(e).__name__)) from None


UNIT_ID = {"pr": P.PR_REF, "issue": P.ISSUE_REF, "jira": P.JIRA_KEY_REF}


def load_units(ev_dir, index, rows, lines):
    """index.json 단위 + 단위 json + (pr/issue는) 계획 행을 묶는다. 계획과 증거가 어긋나면 Fail."""
    by_ref = {}
    for i, r in enumerate(rows):
        if r["tier"] == 3 and r["action"] == "report" and (P.PR_REF.fullmatch(r["ref"]) or P.ISSUE_REF.fullmatch(r["ref"])):
            by_ref[r["ref"]] = (r, lines[i])
    units, seen = [], set()
    entries = index.get("units")
    if not isinstance(entries, list):
        raise Fail("index.json units 목록 없음")
    for e in entries:
        if not isinstance(e, dict) or e.get("kind") not in UNIT_ID or not isinstance(e.get("unit"), str) \
                or not UNIT_ID[e["kind"]].fullmatch(e["unit"]):
            raise Fail("index.json 단위 형식 오류: %r" % (e if not isinstance(e, dict) else e.get("unit")))
        if e["unit"] in seen:
            raise Fail("index.json 단위 중복: %s" % e["unit"])
        seen.add(e["unit"])
        ev = read_json(Path(ev_dir) / (unit_file(e["unit"]) + ".json"), "증거 파일")
        if not isinstance(ev, dict):
            raise Fail("증거 파일 형식 오류: %s.json" % unit_file(e["unit"]))
        row, raw = by_ref.pop(e["unit"], (None, None))
        if e["kind"] != "jira" and row is None:
            raise Fail("계획에 없는 증거 단위: %s" % e["unit"])
        u = Unit(e, ev, row, raw)
        if u.kind == "jira":
            check_evidence(u)
        units.append(u)
    if by_ref:
        raise Fail("증거에 없는 계획 행: %s" % ", ".join(sorted(by_ref)))
    return units


def decide(ctx, u, verdicts_dir, allow_missing, missing, malformed):
    """단위 하나의 결론(u.result). 판정 파일 문제는 missing/malformed 목록에 모은다."""
    if u.kind == "jira":
        ex = u.ev.get("excluded")
        if isinstance(ex, dict):
            if ex.get("code") == "prior-marker":
                n = len(u.ev.get("prior_marker_comments") or [])
                u.result = {"cls": "ambiguous", "ev": base_ev(
                    u, "AMBIGUOUS", "이전 정리 댓글 있음 — 그 결론을 확인하고 다음 계획에서 다시 판단",
                    known="이 계정이 남긴 정리 댓글 %d건" % n, missing="그 댓글의 결론이 지금도 맞는지", owner="me",
                    decider=ME_DECIDER, recommend="이전 정리 댓글의 결론을 확인하고 다음 계획에서 다시 판단")}
            else:
                u.result = {"cls": "excluded", "ev": base_ev(u, "EXCLUDED", str(ex.get("reason") or "")
                                                             or "판정 제외 (%s)" % ex.get("code"))}
            return
        if not u.judge:
            u.result = {"cls": "excluded", "ev": base_ev(u, "EXCLUDED", u.why_not or "판정 제외")}
            return
    elif not u.judge:
        u.result = {"cls": "not-judged", "ev": base_ev(u, "NOT-JUDGED", u.why_not or "판정 대상 아님")}
        return
    path = Path(verdicts_dir) / (u.file + ".txt")
    try:
        text = path.read_bytes().decode("utf-8")
    except FileNotFoundError:
        if not allow_missing:
            missing.append(u.id)
            return
        u.result = {"cls": "ambiguous", "ev": base_ev(
            u, "AMBIGUOUS", "판정 누락", known="판정 파일 없음", missing="판정", owner="me",
            decider="이 저장소 정리 담당", recommend="판정을 다시 돌린 뒤 다음 계획에서 처리")}
        return
    except (OSError, UnicodeDecodeError) as e:
        malformed.append("%s (읽기 실패: %s)" % (u.id, type(e).__name__))
        return
    try:
        u.v = parse_verdict(text, u.id, u.kind, u.cands)
    except Malformed as e:
        malformed.append("%s (%s)" % (u.id, e))
        return
    verdict = u.v["verdict"]
    if verdict == "KEEP" and u.kind == "issue" and ctx.move is not None:
        u.result = decide_move(ctx, u)         # 남길 이슈 = 바인딩 Jira 프로젝트의 새 티켓으로 옮김(또는 결정 필요)
        return
    if verdict in ("KEEP", "AMBIGUOUS"):
        u.result = from_verdict(u)
        return
    if verdict == "CLOSE":
        fails, held = run_gates(ctx, u, CLOSE_GATES)
        if fails:
            u.result = downgrade(ctx, u, fails, held)
            return
        try:
            text = pr_comment(u) if u.kind == "pr" else issue_comment(u)
        except (KeyError, ValueError, TypeError):
            text = None
        if text is None or not comment_ok(text):
            u.result = downgrade(ctx, u, [("row_check", "게시할 댓글이 형식 검사를 통과하지 못함")], held)
            return
        cols = u.raw.split(b"\t")
        action = "close-pr" if u.kind == "pr" else "close-issue"
        snap = with_key(cols[4], "title", row_title(u))
        u.result = {"cls": action, "line": b"\t".join([b"2", action.encode("ascii"), cols[2], cols[3], snap,
                                                       P.penc(text)]), "comment": text}
        return
    u.level = verdict
    u.target = str((ctx.binding or {}).get("qa" if verdict == "TO-QA" else "closed") or "")
    fails, held = run_gates(ctx, u, TOQA_GATES if verdict == "TO-QA" else TOCLOSED_GATES)
    if fails:
        u.result = downgrade(ctx, u, fails, held)
        return
    line, why = jira_tier2(ctx, u)
    if line is None:
        u.result = downgrade(ctx, u, [("row_check", why)], held)
        return
    u.result = {"cls": verdict.lower(), "line": line, "held": held}


def dup_adopt(units):
    """모든 단위를 정한 뒤 한 번: 같은 adopt KEY를 쓰는 move-issue 행이 둘 이상이면 그 행 모두 AMBIGUOUS — 한 티켓은 한 이슈의
    것(chore_plan check_plan_rows)이고, 어느 이슈의 티켓인지는 사람이 정한다. --hold보다 먼저(승인과 무관한 사실)."""
    by_key = {}
    for u in units:
        if u.result["cls"] == P.MOVE_ACTION and u.result["adopt"]:
            by_key.setdefault(u.result["adopt"], []).append(u)
    for key, us in by_key.items():
        if len(us) < 2:
            continue
        for u in us:
            u.result = move_blocked(u, MoveBlock(
                "이미 만든 티켓 %s를 여러 이슈가 가리킴 — 사람이 판단" % key, "그 티켓을 쓰는 이슈 " + ", ".join(x.id for x in us),
                "그 티켓이 어느 이슈의 것인지 정하고 나머지 이슈를 가리키는 티켓 내용을 바로잡은 뒤 다음 계획에서 처리"))


HOLD_REASON = "이번 승인에서 뺌"
HOLD_AREAS = {"close": ("close-pr", "close-issue"), "jira": ("to-qa", "to-closed"), "move": (P.MOVE_ACTION,),
              "branches": ()}
HELD_CLASSES = ("close-pr", "close-issue", "to-qa", "to-closed", P.MOVE_ACTION)


def apply_holds(units, areas, refs):
    """승인 단계에서 뺀 것(--hold-area close|jira|move, --hold <ref>)을 지우지 않고 tier-3 KEEP "이번 승인에서 뺌"으로 남긴다 —
    최종 보고에서 사라지지 않게. 실행 행이 아닌 단위를 가리키는 --hold는 할 일 없음. 계획에 없는 ref = Fail. → 뺀 수."""
    by_id = {u.id: u for u in units}
    for ref in refs:
        if not (P.PR_REF.fullmatch(ref) or P.ISSUE_REF.fullmatch(ref) or P.JIRA_KEY_REF.fullmatch(ref)):
            raise Fail("--hold %r는 pr#N, issue#N, jira#KEY 꼴이어야 함" % ref)
        if ref not in by_id:
            raise Fail("--hold 대상이 계획에 없음: %s" % ref)
    pick = {cls for area in areas for cls in HOLD_AREAS[area]}
    n = 0
    for u in units:
        cls = u.result["cls"]
        if cls not in HELD_CLASSES or (cls not in pick and u.id not in refs):
            continue
        what = "Jira로 옮기기" if cls == P.MOVE_ACTION else VERDICT_KO.get(u.v["verdict"], u.v["verdict"])
        u.result = {"cls": "keep", "ev": base_ev(u, "KEEP", HOLD_REASON, known="판정 의견(%s): %s" % (
            what, u.v["reason"]))}
        n += 1
    return n


def kept_branch_line(raw):
    """승인에서 뺀 delete-remote 행 → 엔진(report)이 남기는 브랜치와 같은 tier-3 모양: remote:<b>, 같은 tip,
    snapshot = tip_author tip_date pr pr_state=MERGED pr_author pr_base pr_merge_commit(값은 지우기 행 그대로 —
    basis·pr_head_repo·pr_head_oid는 보존 행에 없는 키), 증거 = "이번 승인에서 뺌"."""
    cols = raw.split(b"\t")
    s = P.parse_snapshot(cols[4], "delete-remote")
    snap = {"tip_author": s["tip_author"], "tip_date": s["tip_date"], "pr": s["pr"], "pr_state": "MERGED",
            "pr_author": s["pr_author"], "pr_base": s["pr_base"], "pr_merge_commit": s["pr_merge_commit"]}
    return b"\t".join([b"3", b"report", b"remote:" + cols[2], cols[3], P.encode_snapshot(snap), P.penc(HOLD_REASON)])


def header_with_jira(header, hdr):
    """Jira 행이 있는 계획의 머리 줄: groups=에 jira를 더한다(이미 있으면 그대로)."""
    return header_with_groups(header, hdr, ("jira",))


def header_with_groups(header, hdr, add):
    """머리 줄 groups=에 add의 그룹 이름(Jira 행 → jira, move-issue 행 → move = chore.sh grp)을 더한다(모두 이미 있으면
    그대로). 정렬·인코딩 = chore.sh report (`cut -f7 rows | sort -u` LC_ALL=C → hlist = penc(이름, 공백 포함)). groups= 칸
    밖은 바이트 그대로."""
    if set(add) <= set(hdr["groups"]):
        return header
    names = sorted(set(hdr["groups"]) | set(add), key=lambda g: P.penc(g))
    value = b",".join(P.penc(g, sp=True) for g in names)
    fields = header.split(b"\t")
    i = next(n for n, f in enumerate(fields) if f.startswith(b"groups="))
    fields[i] = b"groups=" + value
    return b"\t".join(fields)


def check_out_paths(out, payloads):
    """--out과 --payloads가 서로를 덮지 않는가(읽기·쓰기 전에): 둘의 realpath(없는 부분은 이름 그대로 — 부모 폴더까지 푼다)가
    같거나, 계획이 DIR 안에 있거나(DIR에 계획이 섞임), DIR가 --out 경로 안에 있으면 Fail. 대소문자 무시 파일 시스템도 막도록
    casefold로 비교한다(대소문자만 다른 두 이름을 거절해도 잃는 것은 없다)."""
    if payloads is None:
        return
    o, d = (os.path.realpath(x).casefold() for x in (out, payloads))
    if o == d or o.startswith(d.rstrip(os.sep) + os.sep) or d.startswith(o.rstrip(os.sep) + os.sep):
        raise Fail("--out %s와 --payloads %s가 겹침 — 계획은 설명 파일 폴더 밖에 따로 두세요" % (out, payloads))


def build(a):
    check_out_paths(a.out, a.payloads)
    if a.payloads is not None and os.path.lexists(a.payloads):       # 읽기(네트워크) 전에 — 지난 build의 설명 파일과 섞지 않는다
        raise Fail("--payloads %s가 이미 있음 — 새 폴더 이름을 주세요" % a.payloads)
    try:
        with open(a.plan, "rb") as fh:
            data = fh.read()
    except OSError as e:
        raise Fail("계획을 읽을 수 없음: %s (%s)" % (a.plan, e.strerror or e)) from None
    try:
        hdr, rows = P.parse_plan(data)
    except P.PlanError as e:
        raise Fail("입력 계획 거부: %s" % e) from None
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    body = lines[1:]
    if len(body) != len(rows):
        raise Fail("계획 행 수가 맞지 않음")
    if any(r.get("jira") for r in rows):
        raise Fail("입력 계획에 이미 Jira 행이 있음 — report 계획을 넣으세요")
    if any(r.get("move") for r in rows):
        raise Fail("입력 계획에 이미 move-issue 행이 있음 — report 계획을 넣으세요")
    index = read_json(Path(a.ev) / "index.json", "index.json")
    if not isinstance(index, dict):
        raise Fail("index.json 형식 오류")
    if "remote" in index and str(index["remote"]).lower() != hdr["remote"].lower():
        raise Fail("증거의 저장소 %s ≠ 계획의 저장소 %s" % (index["remote"], hdr["remote"]))
    if "run_id" in index and index["run_id"] != hdr["run_id"]:
        raise Fail("증거가 다른 계획에서 나옴 (run_id %s ≠ %s)" % (index["run_id"], hdr["run_id"]))
    binding = index.get("binding")
    if binding is not None and not (isinstance(binding, dict) and binding.get("site") and binding.get("project")):
        raise Fail("index.json binding 형식 오류")
    p = git(a.clone, "rev-parse", "--git-dir")
    if p.returncode != 0:
        raise Fail("--clone이 git 저장소가 아님: %s" % a.clone)
    ctx = Ctx(hdr, index, a.clone, a.date)
    ctx.confirmed = set(a.confirmed_deleted or ())
    wrong = sorted(k for k in ctx.confirmed if ctx.move is not None and k.rsplit("-", 1)[0] != ctx.move["project"])
    if wrong:
        raise Fail("--confirmed-deleted는 바인딩 프로젝트 %s의 티켓 키: %s" % (ctx.move["project"], ", ".join(wrong)))
    units = load_units(a.ev, index, rows, body)
    jira_units = [u for u in units if u.kind == "jira"]
    if binding is None and jira_units:
        raise Fail("Jira 바인딩이 없는데 Jira 단위가 있음")
    missing, malformed = [], []
    for u in units:
        decide(ctx, u, a.verdicts, a.allow_missing, missing, malformed)
    if missing or malformed:
        parts = []
        if missing:
            parts.append("판정 파일 없음 %d건: %s" % (len(missing), ", ".join(missing)))
        if malformed:
            parts.append("판정 형식 오류 %d건: %s" % (len(malformed), "; ".join(malformed)))
        raise Fail(" / ".join(parts))
    dup_adopt(units)
    held = apply_holds(units, a.hold_area or [], a.hold or [])
    # 두 번째 차례: 중복 근거 티켓이 이번 계획에서 같이 닫히면 둘 다 막는다(한 번만 — 결과가 순서에 기대지 않게)
    ctx.closing = {u.key for u in jira_units if u.result["cls"] == "to-closed"}
    for u in jira_units:
        if u.result["cls"] == "to-closed":
            msg = cl_dup_closing(ctx, u)
            if msg:
                u.result = downgrade(ctx, u, [("cl_dup_closing", msg)], u.result["held"])
    # 출력
    out = [lines[0]]
    raw_unit = {u.row["line"]: u for u in units if u.row is not None}
    hold_branches = "branches" in (a.hold_area or [])
    for i, r in enumerate(rows):
        u = raw_unit.get(r["line"])
        if u is None and hold_branches and r["action"] == "delete-remote":
            out.append(kept_branch_line(body[i]))
            held += 1
        elif u is None:
            out.append(body[i])
        elif u.result["cls"] in ("close-pr", "close-issue", P.MOVE_ACTION):
            out.append(u.result["line"])
        else:
            out.append(unit_line(u))
    if binding is not None:
        inv = index.get("inventory")
        inv = inv.get("jira") if isinstance(inv, dict) else None
        if not isinstance(inv, dict):
            raise Fail("index.json inventory.jira 없음")
        total = inv.get("total")
        if type(total) is not int or total != len(jira_units):
            raise Fail("Jira 검색 총수 %r ≠ 증거의 Jira 단위 %d개" % (total, len(jira_units)))
        if str(inv.get("site") or binding["site"]) != binding["site"]:
            raise Fail("inventory site %s ≠ 바인딩 site %s" % (inv.get("site"), binding["site"]))
        ordered = sorted(jira_units, key=lambda u: key_order(u.key))
        out += [u.result["line"] for u in ordered if u.result["cls"] in ("to-qa", "to-closed")]
        out += [jira_unit_line(u) for u in ordered if u.result["cls"] not in ("to-qa", "to-closed")]
        try:
            out.append(b"\t".join([b"3", b"report", P.penc("jira#" + binding["project"]), b"-", b"-",
                                   P.encode_inventory_evidence(total, str(inv.get("jql") or ""), binding["site"])]))
        except P.PlanError as e:
            raise Fail("inventory 행을 만들 수 없음: %s" % e) from None
    payloads = {int(u.id.split("#")[1]): u.result["payload"] for u in units if u.result["cls"] == P.MOVE_ACTION}
    add = (["jira"] if any(l.split(b"\t", 3)[2].startswith(b"jira#") for l in out[1:]) else []) + \
        (["move"] if payloads else [])
    if add:
        out[0] = header_with_groups(lines[0], hdr, add)
    result = b"\n".join(out) + b"\n"
    self_check(result, lines[0], hdr, binding, index, payloads)
    if payloads and a.payloads is None:
        raise Fail("move-issue 행 %d개 — --payloads DIR(새 티켓 설명 파일 폴더)이 필요함" % len(payloads))
    write_outputs(a.out, result, a.payloads, {"issue-%d.json" % n: data for n, data in payloads.items()})
    unrelated = sorted(ctx.confirmed - ctx.confirmed_used, key=key_order)
    if unrelated:                                       # 해는 없음 — 오타·다른 이슈의 키인지 사람이 보게 한 번만
        _err("build", "이번 build에서 쓰이지 않은 확인 키: " + ", ".join(unrelated))
    counts = {k: 0 for k in ("close-pr", "close-issue", "to-qa", "to-closed", "keep", "ambiguous", "not-judged",
                             "excluded", P.MOVE_ACTION)}
    for u in units:
        counts[u.result["cls"]] += 1
    down = sum(1 for u in units if u.downgraded)
    nmove = counts.pop(P.MOVE_ACTION)
    print("build: " + " ".join("%s=%d" % kv for kv in counts.items())
          + " gate-downgraded=%d held=%d %s=%d" % (down, held, P.MOVE_ACTION, nmove))
    print("build: sha256=" + hashlib.sha256(result).hexdigest())
    return 0


def self_check(result, header, hdr, binding, index, payloads=None):
    """쓰기 전 검사: parse_plan(move-issue 행 검사 포함) + check_jira_binding + 머리 줄 바이트(입력 그대로, Jira 행이 있으면
    groups=에 jira, move-issue 행이 있으면 move만 더함) + move-issue 행마다 payloads(이슈 번호 → 바이트)의 sha256 == payload_sha
    (그 밖 payload 없음) + inventory 총수 = jira#KEY 행 수 = 증거 총수."""
    try:
        _, rows = P.parse_plan(result)
        if binding is not None:
            P.check_jira_binding(rows, binding["site"], binding["project"], binding.get("qa"), binding.get("closed"))
    except P.PlanError as e:
        raise Fail("자체 검사 실패: %s" % e) from None
    keys = [r for r in rows if r.get("jira") and r["jira"]["kind"] in ("transition", "unit")]
    invs = [r for r in rows if r.get("jira") and r["jira"]["kind"] == "inventory"]
    moves = {r["move"]["number"]: r for r in rows if r.get("move")}
    add = (["jira"] if keys or invs else []) + (["move"] if moves else [])
    want_header = header_with_groups(header, hdr, add)                           # 입력 머리 줄에서 따로 다시 만든다
    if result.split(b"\n", 1)[0] != want_header:
        raise Fail("자체 검사 실패: 머리 줄이 입력(+ groups=의 jira·move)과 다름")
    payloads = payloads or {}
    if set(payloads) != set(moves) or any(hashlib.sha256(payloads[n]).hexdigest() != r["snapshot"]["payload_sha"]
                                          for n, r in moves.items()):
        raise Fail("자체 검사 실패: 설명 파일이 move-issue 행의 payload_sha와 맞지 않음")
    if binding is None:
        if keys or invs or moves:
            raise Fail("자체 검사 실패: 바인딩 없이 Jira 행")
        return
    want = (index.get("inventory") or {}).get("jira", {}).get("total")
    if len(invs) != 1 or invs[0]["jira"]["total"] != len(keys) or len(keys) != want:
        raise Fail("자체 검사 실패: inventory 총수 %s, jira#KEY 행 %d개, 증거 총수 %r"
                   % (invs[0]["jira"]["total"] if invs else "없음", len(keys), want))


def _fault(point):
    """테스트 전용 고장 주입(env CHORE_JUDGE_TEST_FAULT=<지점>:<int|term|hup|both|raise>): 그 지점에서 자기에게 SIGINT /
    SIGTERM / SIGHUP / SIGINT와 SIGTERM 둘 다를 보내거나 신호 아닌 예외(Fail)를 던진다. 지점 = payloads-renamed(DIR rename 직후) · payloads-returned(write_payloads가 돌아온 직후) ·
    plan-mid-write(계획 임시 파일을 반쯤 쓴 때). env가 없으면 아무것도 하지 않는다."""
    spec = os.environ.get("CHORE_JUDGE_TEST_FAULT")
    if not spec or spec.partition(":")[0] != point:
        return
    sigs = {"int": (signal.SIGINT,), "term": (signal.SIGTERM,), "hup": (signal.SIGHUP,),
            "both": (signal.SIGINT, signal.SIGTERM)}.get(spec.partition(":")[2])
    if sigs is None:
        raise Fail("test fault at %s" % point)
    for sig in sigs:
        os.kill(os.getpid(), sig)


def write_atomic(path, data):
    """계획 파일: 같은 폴더의 임시 파일에 쓰고 fsync한 뒤 os.replace. 어떤 예외로 끝나도(BaseException) 임시 파일을 지운다."""
    path, tmp = Path(path), None
    try:
        fd, tmp = tempfile.mkstemp(prefix=".chore-judge.", dir=str(path.parent))
        with os.fdopen(fd, "wb") as fh:
            half = len(data) // 2
            fh.write(data[:half])
            _fault("plan-mid-write")
            fh.write(data[half:])
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        tmp = None
    except OSError as e:
        raise Fail("출력을 쓸 수 없음: %s (%s)" % (path, e.strerror or e)) from None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass


PUBLISH = {"done": False, "signalled": False}   # done = write_outputs가 설명 파일 폴더와 계획을 둘 다 놓았나(main이 중단
                                                 # 신호 문구를 고른다), signalled = 중단 신호를 이미 한 번 예외로 바꿈
PUBLISH_CAUGHT = (signal.SIGINT, signal.SIGTERM)                          # publish 동안 예외(Interrupted)로 받는 신호
PUBLISH_BLOCKED = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT}   # publish 동안 막는 신호


def _term(signum, frame):
    """publish의 중단 신호 → Interrupted 한 번만(프로세스당). 같이 막혀 있던 두 번째 신호는 무시한다 — main의 except 안에서
    다시 던지면 traceback이 된다. 출력은 그때 이미 둘 다 놓였거나 둘 다 없다."""
    if not PUBLISH["signalled"]:
        PUBLISH["signalled"] = True
        raise Interrupted()


def write_outputs(out, result, pdir, files):
    """설명 파일 폴더(주었으면 — move-issue 행이 0개면 빈 폴더) → 계획 순서로 쓴다(publish). 이 동안 SIGINT·SIGTERM·SIGHUP·
    SIGQUIT을 pthread_sigmask로 막는다 — 신호는 둘 다 놓인 뒤(또는 아무것도 안 놓인 뒤) 풀 때 전달된다. SIGINT·SIGTERM은
    이 동안 _term(Interrupted 한 번)으로 받아 main이 exit 1로 바꾸고, SIGHUP·SIGQUIT은 기본 동작(프로세스 끝)이 그때
    일어난다 — 출력은 이미 일관된다. 부모가 무시(SIG_IGN)로 넘긴 신호에는 _term을 달지 않는다(무시를 그대로 — 마스크에는
    넣는다). 신호를 받았으면 _term을 그대로 둔다(뒤늦게 처리되는 두 번째 신호도 무시되게). 신호 아닌
    예외로 끝나고 계획이 그 바이트로 놓이지 않았으면 이 build가 rename한 DIR를 지운다 — 막는 신호와 잡는 예외에 대해서만
    반쪽(DIR만·계획만)이 남지 않는다. SIGKILL·전원 끊김은 막지 못한다: write_atomic의 os.replace 뒤에 부모 폴더 fsync가
    없으므로 DIR(rename 뒤 부모 fsync까지 함)만 남고 계획은 옛것이거나 없는 반쪽이 생길 수 있다."""
    old_handlers = {sig: signal.signal(sig, _term) for sig in PUBLISH_CAUGHT if signal.getsignal(sig) is not signal.SIG_IGN}
    try:
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, PUBLISH_BLOCKED)
        state = {}
        try:
            if pdir is not None:
                write_payloads(pdir, files, state)
                _fault("payloads-returned")
            write_atomic(out, result)
            PUBLISH["done"] = True
        except BaseException:
            if state.get("renamed") and not _holds(out, result):
                shutil.rmtree(pdir, ignore_errors=True)
            raise
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)   # 막아 둔 신호가 여기서 전달된다
    finally:
        if not PUBLISH["signalled"]:
            for sig, old in old_handlers.items():
                signal.signal(sig, old)


def _holds(path, data):
    """path에 지금 정확히 data가 있나 (os.replace 뒤에 난 예외 — 계획은 이미 놓였으니 DIR도 남긴다)."""
    try:
        with open(path, "rb") as fh:
            return fh.read() == data
    except OSError:
        return False


def _fsync_dir(path):
    fd = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_payloads(path, files, state=None):
    """--payloads DIR (contract §3): files = {issue-<N>.json: payload 바이트}(비면 빈 폴더)를 DIR 옆 임시 폴더에 쓰고(파일마다
    fsync, 폴더 fsync) DIR로 rename한 뒤 부모 폴더를 fsync — 계획보다 먼저. DIR가 생겨 있으면 Fail(POSIX rename은 빈 폴더를
    덮어쓴다). state["renamed"] = rename을 했음(호출자가 계획을 못 쓰면 DIR를 지우는 근거 — 미리 있던 DIR는 건드리지 않는다).
    rename 뒤 부모 fsync가 실패하면 DIR를 지운다(끝까지 간 것만 남긴다)."""
    state = {} if state is None else state
    path, tmp, done = Path(path), None, False
    try:
        tmp = tempfile.mkdtemp(prefix="." + path.name + ".tmp-", dir=str(path.parent))
        for name, data in sorted(files.items()):
            fd = os.open(os.path.join(tmp, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
        _fsync_dir(tmp)
        if os.path.lexists(path):
            raise Fail("--payloads %s가 이미 있음 — 새 폴더 이름을 주세요" % path)
        os.rename(tmp, path)
        tmp, state["renamed"] = None, True
        _fault("payloads-renamed")
        _fsync_dir(path.parent)
        done = True
    except OSError as e:
        raise Fail("설명 파일 폴더를 쓸 수 없음: %s (%s)" % (path, e.strerror or e)) from None
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
        elif state.get("renamed") and not done:
            shutil.rmtree(path, ignore_errors=True)


# ───────────────────────── recheck ─────────────────────────

def parse_row_line(line, remote):
    """jira-transition 행 한 줄 → (ref, snapshot, row["jira"]). parse_plan(계획 전체 검사)은 쓰지 않는다."""
    where = "row"
    cols = line.split(b"\t")
    if len(cols) != 6:
        raise P.PlanError("row: expected 6 tab-separated columns, got %d" % len(cols))
    if P.pdec(cols[0], where) != "2" or P.pdec(cols[1], where) != P.JIRA_ACTION:
        raise P.PlanError("row: not a tier-2 jira-transition row")
    ref = P.pdec(cols[2], where)
    P.check_ref(P.JIRA_ACTION, ref, where, False)
    snap = P.parse_snapshot(cols[4], where)
    if set(snap) != P.SNAP_EXACT[P.JIRA_ACTION]:
        raise P.PlanError("row: snapshot keys for jira-transition differ")
    x = P.raw_text(cols[3], where)
    return ref, snap, P.check_jira_transition(ref, x, snap, cols[5], where, remote)


def item_name(it):
    return "PR #%d" % it["pr"] if it["kind"] == "pr" else "커밋 %s" % it["sha"][:12]


def short_id(cid):
    return cid if cid.startswith("pr:") else cid[:14]


def live_deploy_branches(hdr, binding):
    return {hdr["default"], binding.get("proof_branch")} - {None}


def recheck_in_scope(a, hdr, binding, it, base_of):
    """build와 같은 배포 판단 범위(deploy_scope): required = 언제나, required가 아닌 합쳐진 PR = 지금 base가 기본
    브랜치·배포 증명 브랜치일 때, 커밋 = origin/<기본 브랜치>에서 닿을 때(클론에 없으면 넣는다 — 보수적)."""
    if it["role"] == "required":
        return True
    if it["kind"] == "pr":
        if it["state"] != "MERGED":
            return False
        if it["pr"] not in base_of:
            raise ReadFail("PR 목록에 PR #%d이 없음" % it["pr"])
        return base_of[it["pr"]] in live_deploy_branches(hdr, binding)
    base = "refs/remotes/origin/" + hdr["default"]
    if resolve_commit(a.clone, base) is None:
        raise ReadFail("기본 브랜치 origin/%s가 클론에 없음" % hdr["default"])
    if resolve_commit(a.clone, it["sha"]) is None:
        return True
    return is_ancestor(a.clone, it["sha"], base)


def fetch_origin(a):
    p = git(a.clone, "fetch", "--quiet", "origin")
    if p.returncode != 0:
        raise ReadFail("git fetch 실패: %s" % _first_line(p.stderr))


def all_prs_live(a):
    all_prs, ok = EV().load_all_prs(a.remote)
    if not ok:
        raise ReadFail("PR 목록 불완전")
    return all_prs


def merge_branch(clone, sha):
    """두 부모 병합 커밋이면 그 병합이 들여온 커밋(sha^1..sha^2), 아니면 빈 목록."""
    if resolve_commit(clone, sha + "^2") is None:
        return []
    return git_out(clone, "rev-list", sha + "^1.." + sha + "^2", "--").split()


def live_set(a, hdr, binding, key, items, S, all_prs):
    """다시 뽑은 후보 ⊆ 승인 항목(정체성), 승인 때 안 합쳐졌던 PR이 배포 판단 범위로 합쳐졌으면 실패. 다시 뽑기가
    불완전(ok=False)해도 ⊆ 검사를 먼저 한다 — 새 후보면 이 행만 exit 10, 아니면 읽기 실패 exit 3. → 다시 뽑은 후보 목록."""
    cands, ok = EV().jira_candidates(key, a.remote, a.clone, list(hdr["I"]), S, all_prs,
                                     fold_bases=live_deploy_branches(hdr, binding))
    approved = {it["id"]: it for it in items}
    for c in cands:
        it = approved.get(c.get("id"))
        if it is None:
            raise ProofFail("승인 뒤 새 관련 변경: %s" % short_id(str(c.get("id"))))
    if not ok:
        raise ReadFail("관련 변경 목록 불완전")
    for c in cands:
        it = approved[c["id"]]
        if it["kind"] == "pr" and c.get("state") == "MERGED" and it["state"] != "MERGED" \
                and c.get("base") in live_deploy_branches(hdr, binding):
            raise ProofFail("승인 뒤 합쳐진 PR: %s" % it["id"])
    return cands


def merged_unchanged(a, items):
    """승인 때 합쳐진 PR은 지금도 같은 병합 커밋으로 합쳐져 있어야 한다."""
    for it in items:
        if it["kind"] == "pr" and it["state"] == "MERGED":
            d = gh_json(["pr", "view", str(it["pr"]), "--repo", a.remote, "--json", "number,state,mergeCommit"])
            oid = (d.get("mergeCommit") or {}).get("oid") if isinstance(d, dict) else None
            if not isinstance(d, dict) or d.get("state") != "MERGED" or oid != it["sha"]:
                raise ProofFail("병합 기록이 승인 때와 다름: PR #%d" % it["pr"])


def no_open_work(a, hdr, key, all_prs):
    """증거의 제외와 같은 '진행 중인 작업'(open_work): 열린 PR(제목·브랜치·본문 또는 커밋 메시지가 키를 언급)과
    합쳐지지 않은 키 이름 브랜치. 무언가 있으면 exit 10 — 읽기가 불완전해도 이 검사가 먼저(live_set과 같은 순서),
    아무것도 못 찾았는데 불완전하면 exit 3."""
    prs, branches, ok = EV().open_work(key, a.clone, hdr["default"], list(hdr["I"]), all_prs)
    if prs or branches:
        raise ProofFail("진행 중인 작업: %s" % ", ".join(["PR #%s" % n for n in prs] + ["브랜치 %s" % b for b in branches]))
    if not ok:
        raise ReadFail("진행 중인 작업 목록 불완전")


def no_other_repo(a, binding, key):
    """증거의 other-repo 제외를 다시(같은 함수·같은 술어): 다른 저장소 목록 = 증거 모듈 _other_repos(바인딩 jira-repos=,
    이 저장소 제외, 대소문자 무시 중복 제거, 쉼표 문자열도 목록과 같게), 그 저장소마다 PR 전체(상태 무관)를 읽어
    _pr_mentions가 참인 PR이 있으면 exit 10. 목록이 불완전하면 언급 검사 뒤 exit 3."""
    ev, incomplete = EV(), []
    rx = ev.key_pattern(key)
    for remote in ev._other_repos(binding, a.remote):
        prs, ok = ev.load_all_prs(remote)
        hit = sorted(p["number"] for p in prs if ev._pr_mentions(rx, p))
        if hit:
            raise ProofFail("다른 저장소의 PR이 이 티켓을 언급: %s" % ", ".join("%s#%s" % (remote, n) for n in hit))
        if not ok:
            incomplete.append(remote)
    if incomplete:
        raise ReadFail("다른 저장소 PR 목록 불완전: %s" % ", ".join(incomplete))


def recheck_qa(a, hdr, binding, key, jira):
    fetch_origin(a)
    dep = deploy_word(binding)
    dh = EV().deploy_head(a.remote, binding)
    if not dh or not P.HEX40.fullmatch(str(dh.get("S") or "")):
        raise ProofFail("%s 성공 기록이 없음" % dep)
    if dh.get("stale") is True:
        raise ProofFail("%s 기준을 확정 못 함: %s" % (dep, dh.get("stale_reason") or "이유 모름"))
    s2 = dh["S"]
    if resolve_commit(a.clone, s2) is None:
        raise ReadFail("배포 기준 커밋 %s가 클론에 없음 (fetch 뒤에도)" % s2[:12])
    all_prs = all_prs_live(a)
    base_of = {p["number"]: p.get("base") for p in all_prs if isinstance(p, dict) and "number" in p}
    items = jira["items"]
    reverts = revert_targets(a.clone, s2)

    def reverted(sha):
        return any(sha.startswith(pre) for _, pre in reverts)
    scoped = []
    for it in items:
        if not recheck_in_scope(a, hdr, binding, it, base_of):
            continue
        scoped.append(it["id"])
        if resolve_commit(a.clone, it["sha"]) is None:
            if is_shallow(a.clone):
                raise ReadFail("얕은 클론이라 %s의 커밋을 확인할 수 없음" % item_name(it))
            raise ProofFail("지금 %s(%s)에 없음: %s (커밋이 저장소에 없음)" % (dep, s2[:12], item_name(it)))
        if not is_ancestor(a.clone, it["sha"], s2):
            raise ProofFail("지금 %s(%s)에 없음: %s" % (dep, s2[:12], item_name(it)))
        if reverted(it["sha"]):
            raise ProofFail("%s에서 되돌려짐: %s" % (dep, item_name(it)))
        own = merge_branch(a.clone, it["sha"])
        inside = set(own)      # 그 브랜치 안에서 되돌리고 다시 합친 것(X 뒤 "This reverts commit X")은 되돌림이 아니다
        inner = [c for c in own if any(c.startswith(pre) for h, pre in reverts if h not in inside)]
        if inner:
            raise ProofFail("%s에서 되돌려짐: %s (안의 커밋 %s)" % (dep, item_name(it), inner[0][:12]))
    cands = live_set(a, hdr, binding, key, items, s2, all_prs)
    for c in cands:
        if c["id"] in scoped and c.get("reverted_by"):
            raise ProofFail("%s에서 되돌려짐: %s" % (dep,
                "PR #%d" % c["number"] if c.get("kind") == "pr" else "커밋 %s" % str(c.get("sha"))[:12]))
    merged_unchanged(a, items)
    no_open_work(a, hdr, key, all_prs)
    no_other_repo(a, binding, key)


def live_ticket(client, key, what):
    """recheck의 Jira 읽기: 없음(404) = 증거 깨짐(exit 10), 그 밖의 실패(5xx·인증·형식) = 읽기 실패(exit 3)."""
    try:
        return fetch_ticket(client, key)
    except CJ.JiraError as e:
        if e.status == 404:
            raise ProofFail("%s이 없음: %s" % (what, key)) from None
        raise ReadFail("Jira 읽기 실패: %s" % CJ.scrub(e.message)) from None


def recheck_closed(a, hdr, binding, jira):
    """닫기: 다시 뽑은 후보 ⊆ 승인 항목 + 합친 커밋 그대로 + 열린 PR 없음(배포 포함 여부는 보지 않는다 — 후보의 배포
    사실은 기본 브랜치 끝을 기준으로 뽑는다) + 닫는 근거 술어를 지금 값으로 다시."""
    fetch_origin(a)
    tip = resolve_commit(a.clone, "refs/remotes/origin/" + hdr["default"])
    if tip is None:
        raise ReadFail("기본 브랜치 origin/%s가 클론에 없음" % hdr["default"])
    all_prs = all_prs_live(a)
    live_set(a, hdr, binding, jira["key"], jira["items"], tip, all_prs)
    merged_unchanged(a, jira["items"])
    no_open_work(a, hdr, jira["key"], all_prs)
    no_other_repo(a, binding, jira["key"])
    b = jira["close_basis"]
    if b["pr"] is not None:
        d = gh_json(["pr", "view", str(b["pr"]), "--repo", a.remote, "--json", "number,state"])
        if not isinstance(d, dict) or d.get("state") != "MERGED":
            raise ProofFail("근거 PR이 합쳐진 상태가 아님: PR #%d" % b["pr"])
        return
    try:
        client = CJ.client(binding["site"])
    except CJ.JiraError as e:
        raise ReadFail("Jira 연결 실패: %s" % CJ.scrub(e.message)) from None
    target = live_ticket(client, b["key"], "근거 티켓")
    this = live_ticket(client, jira["key"], "이 티켓")
    if is_self(this, target):
        raise ProofFail("근거 티켓이 이 티켓 자신임: %s" % b["key"])
    checks = (dup_project_problem,) if b["type"] == "duplicate" else (sup_newer_problem, sup_joined_problem)
    for fn in checks:
        msg = fn(this, target)
        if msg:
            raise ProofFail(msg)


def is_hold_status(binding, status_id):
    """증거의 hold 제외와 같은 술어(chore-evidence.py _jira_unit): 상태 ∈ jira-hold 또는 상태 = jira-qa."""
    hold = [str(h) for h in binding.get("hold") or []]
    return str(status_id) in hold or bool(binding.get("qa")) and str(status_id) == str(binding["qa"])


def not_held(binding, snap):
    """승인 snapshot의 상태를 지금 바인딩으로 다시 — 그 사이 보류 목록에 들어갔으면 exit 10. 지금 Jira 상태가 snapshot과
    다르면 apply-rows 8단계가 이미 SKIP하므로 Jira를 읽지 않는다."""
    if is_hold_status(binding, snap["status"]):
        raise ProofFail("보류 상태(%s) — 손대지 않음" % (snap["status_name"] or snap["status"]))


def not_in_ledger(binding, jira):
    """승인 때 읽은 제외 원장(row의 ledgers 경로)을 지금 다시 읽어(증거 모듈 read_ledgers 그대로) 이 티켓이 있으면
    exit 10(원장의 사유 그대로), 원장을 못 읽으면 exit 3."""
    ev = EV()
    try:
        ledger = ev.read_ledgers(jira["ledgers"], binding["project"])
    except ev.EvidenceError as e:
        raise ReadFail("제외 원장 읽기 실패: %s" % e) from None
    if jira["key"] in ledger:
        raise ProofFail(ledger[jira["key"]][0])


def recheck(a):
    data = sys.stdin.buffer.read()
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()
    if len(lines) != 2:
        raise Fail("stdin은 계획 머리 줄과 행 줄 정확히 2줄 (받은 줄 %d)" % len(lines))
    try:
        hdr = P.parse_header(lines[0])
        ref, snap, jira = parse_row_line(lines[1], hdr["remote"])
    except P.PlanError as e:
        raise Fail("입력 거부: %s" % e) from None
    if hdr["remote"].casefold() != a.remote.casefold():
        raise Fail("계획의 저장소 %s ≠ --remote %s" % (hdr["remote"], a.remote))
    try:
        binding = CJ.read_binding(a.repos_md, a.remote)
    except Exception as e:       # BindingError(등록부 형식) · 읽기 실패 — 어느 쪽이든 이 행은 확인할 수 없다
        raise Fail("바인딩 읽기 실패: %s" % CJ.scrub(getattr(e, "message", None) or e)) from None
    if not binding:
        raise Fail("저장소 등록부에 이 저장소의 Jira 바인딩이 없음")
    if snap["site"] != binding.get("site") or snap["project"] != binding.get("project"):
        raise Fail("행의 Jira %s/%s ≠ 바인딩 %s/%s" % (snap["site"], snap["project"], binding.get("site"),
                                                    binding.get("project")))
    try:
        P.check_jira_binding([{"line": 2, "ref": ref, "snapshot": snap, "jira": jira}], binding["site"],
                             binding["project"], binding.get("qa"), binding.get("closed"))
    except P.PlanError as e:
        raise Fail("바인딩과 맞지 않는 행: %s" % e) from None
    if jira["level"] == "TO-QA" and (not binding.get("proof_workflow") or not binding.get("proof_branch")):
        raise Fail("바인딩에 배포 기준(deploy-proof)이 없음")
    not_held(binding, snap)
    not_in_ledger(binding, jira)
    if jira["level"] == "TO-QA":
        recheck_qa(a, hdr, binding, jira["key"], jira)
    else:
        recheck_closed(a, hdr, binding, jira)
    return 0


# ───────────────────────── CLI ─────────────────────────

class _Parser(argparse.ArgumentParser):
    usage_code = 2

    def error(self, message):
        raise SystemExit(("usage", message))


def build_parser():
    p = _Parser(prog="chore-judge.py", allow_abbrev=False, description="chore 판정 묶기(build)·증거 재확인(recheck)")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=_Parser)
    b = sub.add_parser("build", allow_abbrev=False, help="판정 → 최종 계획")
    b.add_argument("--plan", required=True)
    b.add_argument("--ev", required=True)
    b.add_argument("--verdicts", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--allow-missing", action="store_true")
    b.add_argument("--date")
    b.add_argument("--clone", required=True)
    b.add_argument("--hold-area", action="append", choices=sorted(HOLD_AREAS))
    b.add_argument("--hold", action="append")
    b.add_argument("--payloads")
    b.add_argument("--confirmed-deleted", action="append")
    r = sub.add_parser("recheck", allow_abbrev=False, help="jira-transition 행의 증거를 지금 사실로 다시 확인")
    r.add_argument("--clone", required=True)
    r.add_argument("--remote", required=True)
    r.add_argument("--repos-md", required=True)
    r.add_argument("--repo")
    return p


def _err(cmd, msg):
    line = "chore-judge: %s: %s" % (cmd, " ".join(str(msg).split()))
    sys.stderr.buffer.write(CJ.scrub(line, 2000).encode("utf-8", "backslashreplace") + b"\n")
    sys.stderr.flush()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    cmd = argv[0] if argv and argv[0] in ("build", "recheck") else "usage"
    try:
        a = build_parser().parse_args(argv)
    except SystemExit as e:
        if isinstance(e.code, tuple):
            _err(cmd, "사용법 오류: " + e.code[1])
            return 3 if cmd == "recheck" else 2
        return e.code if isinstance(e.code, int) else 2
    if a.cmd == "build":
        if a.date is None:
            a.date = datetime.now().strftime("%Y-%m-%d")
        else:
            try:
                P._plan_date(a.date, "--date")             # chore_plan의 계획 날짜 규칙 그대로(달력에 있는 날)
            except P.PlanError:
                _err("build", "사용법 오류: --date는 달력에 있는 날 YYYY-MM-DD")
                return 2
        bad = [k for k in a.confirmed_deleted or () if not P.JIRA_KEY.fullmatch(k)]
        if bad:
            _err("build", "사용법 오류: --confirmed-deleted는 Jira 티켓 키(PROJ-N): " + ", ".join(bad))
            return 2
        try:
            return build(a)
        except Fail as e:
            _err("build", e)
            return 1
        except (KeyboardInterrupt, Interrupted):
            _err("build", "중단 신호를 받음 — " + ("계획과 설명 파일 폴더를 다 쓴 뒤(그대로 둠)" if PUBLISH["done"]
                                                  else "계획·설명 파일 폴더를 쓰지 않음"))
            return 1
    try:
        recheck(a)
    except ProofFail as e:
        sys.stdout.buffer.write((" ".join(str(e).split())).encode("utf-8") + b"\n")
        sys.stdout.flush()
        return 10
    except (Fail, ReadFail) as e:
        _err("recheck", e)
        return 3
    except CJ.JiraError as e:
        _err("recheck", "Jira 읽기 실패: %s" % e.message)
        return 3
    except Exception as e:  # EvidenceError 등 — 증거 모듈의 읽기 실패는 모두 exit 3
        _err("recheck", "읽기 실패 (%s): %s" % (type(e).__name__, e))
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
