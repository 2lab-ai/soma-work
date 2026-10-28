---
name: chore
description: "Use when the user wants hygiene on a GitHub repo listed in the caller's registry (env CHORE_REPOS_MD) — stale/merged branch cleanup, a sweep of every open PR and issue, cleanup of the Jira tickets assigned to them that are already handled, moving the issues worth keeping to the repo's bound Jira project, worktree prune. Triggers on '/chore', 'chore 작업', '레포 정리', '레포 청소', '브랜치 정리', 'PR·이슈 정리', '지라 정리', '이슈 Jira로 옮기기'. Args — target repo (required; registry name, `owner/repo`, or a GitHub URL); the registry = the file named by env CHORE_REPOS_MD. NOT for code fixes, issue gating, local disk reclaim, or only listing Jira tickets."
---

# chore — act only on what is provably done, after the user approves the exact plan

Engine = `$ENGINE/chore.sh` (rules in its header): `report` · `apply` (approved plan only, by sha256) · `verify` ·
`check-plan`. Read-only helpers: `$ENGINE/chore-evidence.py` (facts per unit), `$ENGINE/chore-judge.py` build
(verdicts → final plan, machine gates), `$ENGINE/chore-render.py` (approval page), `$ENGINE/chore-report.py` (final
report); `$ENGINE/chore-jira.py` is the only Jira writer (and the only GitHub writer for move rows) and runs inside apply.
Tier 1 = local, 2 = remote delete / close / Jira move / Jira로 옮기기 (남길 이슈 → 새 Jira 티켓 + 이슈 닫기), 3 = held or
listed. Only branch-delete basis: same-repo MERGED PR into an integration ref (I), head oid = tip, merge commit in that
ref's current history. apply never acts on a ref in P (default, protection, rulesets, environments, workflow triggers,
OPEN PR heads/bases, `--protect`) as last checked. The only judgment = one judge agent per unit with the fixed
[judge-prompt.md](judge-prompt.md) (next to this SKILL.md).

Paths: ENGINE = `$CLAUDE_PLUGIN_ROOT/skills/chore/scripts`. `$CLAUDE_PLUGIN_ROOT` is two directories above this skill's
base directory (`…/skills/chore` → `…`); shells usually do not set it, so write the absolute path. Each step is a separate
shell call and shell state does not carry over: start every call with `export ENGINE=<absolute path> CHORE_REPOS_MD=<registry>`.

Names: CLONE = the repo's local path in the registry, column 2; W = a fresh folder in the session scratchpad; L = this
run's ledger folder (below); PL = this round's payloads folder (`W/payloads`, each rebuild `W/payloads-2`, `-3` … — build
refuses one that exists; one ticket body per move row, empty when none). Jira binding = tokens in the repo's note cell
(`jira=<site>/<PROJECT>` `jira-qa=` `jira-closed=` `jira-hold=` `jira-repos=` `deploy-proof=<workflow file>@<branch>`,
optional `deploy-env=<label>` = the name pages and comments give the proof deploy, else the proof branch's last
`/`-segment); no `jira=` ⇒ no Jira phase. Jira credentials = env `JIRA_EMAIL` / `JIRA_API_TOKEN`, else the file named by
`CHORE_ENV_FILE` — never print them.

## 호출자가 정하는 값

| 값 | 무엇 | 기본 |
|---|---|---|
| `CHORE_REPOS_MD` (필수) | the registry: absolute path of a markdown table, one row per repo | none — see below |
| `CHORE_ENV_FILE` (선택) | `KEY=VALUE` file read only for an empty `JIRA_EMAIL` / `JIRA_API_TOKEN` | env only |
| L (원장) | one folder per run; the caller's wrapper may point it into its own repo and commit it | `<scratchpad>/chore-ledger/<repo>-<YYYY-MM-DD>/` |
| 게시 | where the approval page and the final report are shown | a private artifact/page the session can publish; Slack bot session → upload the HTML to the thread |
| 제외 원장 | the caller's in-flight ticket files (any non-comment line naming a KEY: a `.jsonl` ledger, `KEY<TAB>note`) | none |
| 판정 에이전트 | one fresh agent per unit, mid-size model | the caller may name the model |

Registry row = `| name | local path | owner/repo | note |` (binding tokens in the note cell). No `CHORE_REPOS_MD` or no row
for the target → stop before any command and say what to provide (that path, that row); never guess a path.

## Procedure

**P1 — inventory (read-only)**
1. Parallel sessions → `--no-local`; families still in use → `--protect`; each `--integrate` with a stated reason:
   `CHORE_REPOS_MD=<registry> "$ENGINE/chore.sh" report <repo> --plan W/plan.tsv --json W/plan.json [--protect GLOB]… [--integrate REF]… [--no-local]`
2. Exclusion ledgers = tickets other sessions are working on (제외 원장 above); list the ones used in L/README.md:
   `python3 -I "$ENGINE/chore-evidence.py" evidence --plan W/plan.tsv --out W/ev --clone CLONE --repos-md "$CHORE_REPOS_MD" [--stale-days 30] [--exclude-ledger F]…`
   → `W/ev/index.json` (units `judge:true|false`).

**P2 — judge (content, never age)**
3. One judge agent (판정 에이전트 above) per `judge:true` unit, waves of 10 in parallel — never two units in one agent.
   Each gets judge-prompt.md + `W/ev/<unit-file>.md` + CLONE + OUT = `W/verdicts/<unit-file>.txt` and writes only OUT.
   Recent (<30 days) PRs/issues and excluded tickets are `judge:false`: listed, not judged. In a repo with `jira=` a KEEP
   issue verdict carries `JIRA_TYPE` (judge-prompt.md); none from the evidence's list → that issue is 결정 필요.
4. `python3 -I "$ENGINE/chore-judge.py" build --plan W/plan.tsv --ev W/ev --verdicts W/verdicts --out W/final.tsv --clone CLONE --payloads PL [--confirmed-deleted KEY]…`
   → `build: close-pr=… to-qa=… … move-issue=n` + `build: sha256=…`. Exit 1 names missing / malformed verdicts → rerun
   only those judges (a fresh agent each), build again. `--allow-missing` only when a judge cannot finish (→ 결정 필요).
   Exit 1 "중단 신호를 받음 — 계획과 설명 파일 폴더를 다 쓴 뒤(그대로 둠)" (no `build:` lines) → use those outputs (digest =
   `shasum -a 256 W/final.tsv`; move count = the page's "Jira로 옮기기 n건") or build again with a new `--out` and the next
   PL; "…쓰지 않음" → build again as is. Owner question (a 결정 필요 row whose "확인 안 된 것" says "Jira에서 그 티켓이 있는지
   확인…", or the breaker below): ask (AskUserQuestion — Slack bot session: `local:UIAskUserQuestion`;
   `https://<site>/browse/<KEY>`) whether KEY exists in Jira, answer → L. Gone → the next chore's build (new report) gets `--confirmed-deleted KEY`; before approval, build again now with it
   (next PL) — except for "Jira에서 그 티켓이 있는지 확인 — 이 계획의 보고 뒤에 만든 티켓이라 다음 정리(새 report)에서 다시 판단" and
   for a KEY this plan's own run made (its send is in this plan's `<run_id>.journal`): the flag releases neither, so those
   go to the next chore. Exists → fix the run account's read access; the next chore adopts KEY. No answer → it stays 결정 필요.

**P3 — approval (nothing runs before it)**
5. `python3 -I "$ENGINE/chore-render.py" --plan W/final.tsv --json W/plan.json --out W/plan.html --repo-url https://github.com/<owner>/<repo> --payloads PL`
   — its 지문 == `shasum -a 256 W/final.tsv`. Publish it (게시 above). Read the rendered frame before asking, every
   "Jira로 옮기기" card too: its GitHub comment ("이슈에 이미 있는 이관 댓글을 그대로 둠" = none), "Jira 티켓 설명 미리보기", "잘림".
6. AskUserQuestion (Slack bot session: `local:UIAskUserQuestion`) on that digest — options (description): 전부 실행(추천)
   ("계획의 모든 실행 행") / 이슈 옮기기 빼고 실행 ("Jira로 옮기기만 빼고 실행" — only when build `move-issue=` > 0) / 저장소만
   ("PR·이슈 닫기·브랜치 삭제만 — Jira 쓰기·이슈 옮기기 없음") / 중단 ("아무것도 실행하지 않음"). Body = the page's `#confirm` line
   (PR 닫기 · 이슈 닫기 · 브랜치 삭제 · Jira → QA · Jira 닫기 · Jira로 옮기기 n건 · 결정 필요 · 로컬 정리 — the move and local parts
   only when present) + the judge agent count + the URL, and the question names each irreversible effect with its own
   count, e.g. "Jira 티켓 A개 생성 + GitHub 이슈 B개에 이관 댓글 + 이슈 C개 닫기(not planned) — 되돌릴 수 없음" — from the move
   cards: A = cards without "이미 만든 티켓 …로 닫기만 (새 티켓 없음)", B = cards without "이슈에 이미 있는 이관 댓글을 그대로 둠 — 새
   댓글 없음", C = all move rows. Never delete rows: a rejection rebuilds the plan into a new PL (held rows become tier-3
   KEEP "이번 승인에서 뺌", listed in the final report) — 이슈 옮기기 빼고 → `--hold-area move`; 저장소만 → `--hold-area jira
   --hold-area move`; a typed "Jira만" → `--hold-area close --hold-area branches --hold-area move`; rejected rows → `--hold
   <ref>` each (`pr#N` · `issue#N` · `jira#KEY`; a rejected branch group → `--hold-area branches`; repeatable) — rebuild
   like this, then step 5 again with that PL and confirm the new digest:
   `python3 -I "$ENGINE/chore-judge.py" build --plan W/plan.tsv --ev W/ev --verdicts W/verdicts --out W/final.tsv --clone CLONE --payloads W/payloads-2 --hold-area move`
7. Before any apply: final.tsv + its sha256 + plan.html + PL + `W/verdicts/` + the build stdout → L (`git commit` when L
   is in the caller's repo). Approve and apply in the same sitting (apply re-checks every row live; a long gap only adds SKIPs).

**P4 — apply → verify → report**
8. Step 1, when the page names its group (its remote deletes only; this verify reads Jira / move rows NOT-SCHEDULED, a move
   row with an earlier-made ticket UNRESOLVED "티켓 만듦, 이슈 닫지 않음" — expected) — "1단계 생략, 한 번에 실행" → go to 9:
   `CHORE_REPOS_MD=<registry> "$ENGINE/chore.sh" apply <repo> --plan W/final.tsv --digest <sha> --tiers 2 --yes --only-group '<group>' > W/run1.out 2> W/run1.err`
   `CHORE_REPOS_MD=<registry> "$ENGINE/chore.sh" verify <repo> --plan W/final.tsv --results W/run1.out --digest <sha> > W/verify1.out`
9. Full run, same plan and digest, no `--only-group`: closes → Jira moves (transitions, then issue moves) → remaining
   remote deletes (already gone → SKIP) → local → prune. `--tiers 2` (`1,2` if tier-1 rows were approved; a plan with
   Jira rows always needs 2); no run1.out when step 1 was skipped; keep stderr (the only record of which check stopped it):
   `CHORE_REPOS_MD=<registry> "$ENGINE/chore.sh" apply <repo> --plan W/final.tsv --digest <sha> --tiers 2 --yes > W/run2.out 2> W/run2.err`
   `cat W/run1.out W/run2.out > W/all.out; CHORE_REPOS_MD=<registry> "$ENGINE/chore.sh" verify <repo> --plan W/final.tsv --results W/all.out --digest <sha> > W/verify.out`
10. Rerun = the same apply (`> W/run3.out 2> W/run3.err` …), appended to all.out in run order, then verify again. `ABORTED`
    → rerun, except the breaker (below) or the same reason twice in a row (e.g. Jira auth, journal format) → report.
    `unresolved>0` or `fail>0` → render the report (12) now. A move row goes by its 다음 할 일 (before its RESULT), first match:
    (1) contains "다음 정리" (e.g. "다음 정리에서 다시 판단", "이슈가 열려 있으면 그 티켓을 지울 때 다음 정리가 새로 만듦") → not a reason to rerun; report; the
    next chore takes what is still open ("Jira에서 그 티켓이 있는지 확인…" → step 4's owner question). A rerun for other rows re-runs
    these too with every engine check — it may finish one inside its approval or stop on a breaker (expected). A recorded
    close is never redone on a reopened issue while its ticket stays (rerun: "옮긴 뒤 다시 열린 이슈 — 다시 닫지 않음" before any comment;
    later build: 결정 필요 "이전 정리가 옮기고 닫은 뒤 사람이 다시 연 이슈 — 다시 닫을지 오너가 정함"); a deleted ticket → a later chore moves and closes it
    again; (2) starts with "같은 계획으로 다시 실행" → rerun; (3) ends with "같은 계획으로 다시 실행" → do that step (resolve below, the owner's
    act), then rerun; (4) anything else ("확인 결과를 보고 사람이 정함", "일지를 읽을 수 없음 — 사람이 확인") → show the report to the owner; no
    rerun until they decide. A ticket FAIL on a row whose issue has its migration comment and is closed (ticket edited or
    deleted after that) gets the owner exit "이관 댓글이 달리고 닫힌 이슈 — 그 뒤 티켓이 바뀌었거나 없어짐. …" (rule 4): not rerun; not re-created
    while the issue stays closed (if a person reopens it and the ticket is gone, a later chore moves it again, as above).
    Other rows: last RESULT UNKNOWN / NOT-ATTEMPTED → rerun, else → the owner. Done = `success=yes` or the owner accepting
    the rest as reported. No SUMMARY/ABORTED line: killed → rerun; refused before acting (stderr `chore: …`) → report. Only
    complete runs go to verify or the report; a killed run's acts still count (verify reads Jira moves from the journal; a
    close seen as "changed since approval" counts if CLOSED with the approved comment).
    Breaker = `reason=Jira 단계가 차단기로 멈춤` (chore-jira exit 9): no row of this plan is rerun — NOT-ATTEMPTED ones
    included — until its cause is fixed; the report then shows no rerun command (it names the rows and says to fix the
    cause first). The cause = the runN.err line `chore: jira: chore-jira: apply-rows: …`:
    - `게시한 댓글이 승인본 조건과 맞지 않음` (a Jira → QA / 닫기 row): never touch that ticket, report it; the next plan takes
      the rest after the cause is fixed — until then build with `--hold-area jira`.
    - `방금 만든 티켓 <KEY>: 담당자가 붙음(승인본은 담당자 없음)` / `…: 보고자가 실행 계정이 아님` (or head `만든 뒤 확인하지 못한 티켓`): give the owner the
      KEY link + cause; rerun only after the owner removed the assignee / set reporter = the sent line's `acct=`.
    - `…: 만든 티켓을 다시 읽지 못함(없음)` (either head): no rerun; step 4's owner question (gone → the next chore's build).
    - `이 계획이 만든 티켓 <KEY>가 승인본과 다름(…)`: no rerun; report KEY + the why to the owner (its fate is theirs); the next plan takes the issue.
    - The same KEY or cause again, or any other cause → stop and report.
11. Every runN.out, runN.err, verify.out and the Jira journal (the SUMMARY/ABORTED `journal=` path) → L.
12. Final report (results in the run order verify read) → publish as in 5 → read the frame → hand the URL; report → L (as in 7):
    `python3 -I "$ENGINE/chore-report.py" --plan W/final.tsv --digest <sha> --results W/run1.out [--results W/run2.out]… --verify W/verify.out --out W/report.html --repo-url https://github.com/<owner>/<repo> --payloads PL`

**결정 필요 · 미결 (move rows)** — the report gives each row a fixed next step. Recording what a person checked =
`python3 -I "$ENGINE/chore-jira.py" resolve --repos-md "$CHORE_REPOS_MD" --remote <owner>/<repo> --clone CLONE` + one form
(project lock — refused while an apply runs; never edit a journal by hand; copy the `.journal` it names to that plan's L):
- "그 결과를 기록" — a create: `--sid S --found KEY` (that send made KEY) | `--sid S --not-created` (a few minutes after the
  sent time at the earliest, search again first; resolve also searches by the sent line's `acct=` + created time, no text
  index, and refuses while a ticket points at the issue); a comment: `--sid S --comment-found --cid C` | `--sid S --comment-not-posted`.
- "지워진 티켓의 댓글 결과 미확정": first ask the owner (AskUserQuestion, issue link) about the migration comment on the
  GitHub issue that points at the deleted ticket — owner deletes it → then `--comment-not-posted`; owner keeps it →
  `--comment-found --cid C`. When the RESULT / 결과 column says this, it wins over the plain "댓글 결과 미확정" step.
- "연결을 기록" / "지운 것으로 기록": `--ref issue#N --key KEY --plan <run_id> --link` (gone comments → retired, one post
  allowed); KEY = the report row's — for a gone comment of a deleted ticket, that deleted KEY; run_id = the approved
  plan header's (= `journal=` file name; a wrong one = a stray journal). The rerun after `--link` re-posts a migration
  comment a person may have deleted on purpose — first ask the owner (AskUserQuestion with the issue link; a new public
  GitHub comment cannot be taken back), then run it.
- S = `<run_id>/<attempt>/<seq>` of a `mv-create-sent` / `mv-comment-sent` line that no later line names as `sid=S` or
  `of=S`; read only: `grep -H ' issue#N mv-' <common>/chore/*.journal` (`<common>` = `git -C CLONE rev-parse
  --path-format=absolute --git-common-dir`; file `<run_id>.journal`, column 2 = attempt, `seq=` on the line).
- Did the create land — read-only, the writer's own search (`<repo>` = the name after `owner/`):
  `python3 -I "$ENGINE/chore-jira.py" --site <site> search --jql 'project = <PROJECT> AND text ~ "\"<repo>/issues\""' --fields summary,description,reporter,created`
  → that send's ticket: description line 1 `GitHub 이슈에서 옮김: <repo URL>/issues/N`, reporter = the sent line's `acct=`, created ≥ its instant − 5 min (UTC).

## Principles

- Nothing runs before the confirm, tier 1 included. A re-report is a receipt only — its new candidates are not approved.
- Every PR, issue and Jira unit is judged on its content, one agent per unit; age, inactivity or status alone is never
  a verdict. CLOSE / TO-QA / TO-CLOSED stand only if every cite resolves by machine — else 결정 필요.
- Jira actions are only TO-QA — to the bound QA status (`jira-qa=`), only when every required merged change is in the
  latest successful proof deploy (`deploy-proof=`, label `deploy-env=`); never Done/Closed for finished work — and
  TO-CLOSED (duplicate or superseded, basis cited). No "rotten" closes of tickets assigned to me.
- Jira로 옮기기 = KEEP issues only (AMBIGUOUS and <30-day ones stay on GitHub, listed), `jira=` repos only, always a new
  ticket (an earlier run's own is reused; mentioned keys → "관련:" / 합칠 후보, never merged): no assignee, reporter =
  run account, first status, the verdict's JIRA_TYPE; key + link comment, close not planned. A CLOSE citing only `jira:` → 결정 필요.
- Excluded and marked, never touched: tickets in another session's ledger, `jira-hold` statuses, tickets an OPEN PR
  mentions, tickets with work in a `jira-repos` repo. A ticket already carrying a chore comment → 결정 필요.
- apply acts on a private copy of the approved bytes, re-checking each row right before acting. Changed metadata (P, PR basis,
  merge commit, integration ref not forward or now at the row's tip, OPEN PR, branch gone) → SKIP; a tip moved since the
  report → lease rejects → FAIL, review it. A close needs `updatedAt` unchanged — a comment or label after approval → SKIP.
  A Jira row re-reads the ticket and re-checks its evidence (exclusion ledgers, hold list, deploy proof) once, right before
  its first write; it comments first, re-reads the ticket, then moves, journaling every write; a rerun resumes from the
  journal and never posts a second comment.
- A move row re-checks before each write: issue unchanged since approval (all original content), no other ticket
  pointing at it, ticket content = the approved payload, migration comment exactly once; a new (or never-checked) ticket
  must be readable, unassigned, reporter = the sent line's `acct=`. An unread create or comment is never re-sent (→ resolve).
  Scope = this machine, this clone, this Jira account; another operator's chore ticket on the issue → 결정 필요.
- Deleting / editing a Jira ticket or GitHub comment, or re-closing a reopened issue (breaker, 다음 할 일 saying 지우·지운
  뒤·다시 닫, "지워진 티켓의 댓글 결과 미확정") = the owner's act, asked with the link (AskUserQuestion); the operator resolves, reruns.
- Not seen: a PR opened or an integration ref rewound after the last check; P's protection / ruleset / environment / workflow
  sources, read at apply start and again after the Jira stage, before any delete (a rule added in between); another worktree
  checking out a branch or starting a rebase/bisect on it after the check (a local branch is deleted only at the approved
  oid). Jira residual race: an edit after the last re-read and before a write — before the comment, the re-read after
  posting stops the move (verify: UNRESOLVED "댓글만 남음"); just before the move, neither apply nor verify sees it. A
  ledger, hold-list or deploy change after that row's evidence check. The reopen guard knows only chore closes recorded
  (`mv-closed`) in this clone's `<git common dir>/chore/` journals, so these still get closed again: a person's
  close-and-reopen between approval and apply on a row with no recorded close (e.g. adopt after a plan that only
  commented); a close made by a run from another clone or machine; a close that went through but whose re-read right
  after failed or no longer saw CLOSED (FAIL "이슈를 닫지 못함", no `mv-closed` — like the kill between close and its
  journal line). Deleted comments are invisible for Jira rows; a move row reports its migration comment gone or changed
  ("이관 댓글이 지워짐", "이관 댓글 없음", "이관 댓글이 보낸 본문과 다름").
- Recovery = `git push origin <oid>:refs/heads/<b>`; backups only in the local clone as `refs/chore-backup/<run_id>/<branch
  name as is>`. No automatic restore (recreating may trigger a deploy). Jira: nothing automatic — move the ticket back
  through a transition Jira offers and edit or delete the posted comment — by hand, the owner's act.
- verify `p-invariant`: FAIL = a still-protected or integration ref vanished — find who deleted it; WARN = it vanished
  after its protection went away (e.g. its OPEN PR merged and the head was auto-deleted).

## Red flags — STOP

- Touching anything in P, a target outside the registry, or the registry's own repository (the engine refuses it), apply
  without the confirm and a recorded digest, approving a page whose digest is not the final TSV's, editing the plan or deleting / closing / moving by hand.
- Judging by age (commit, PR, issue or ticket); several units in one judge agent; a close without a cite.
- Moving a finished ticket past the bound QA status (`jira-qa=`); any Jira write outside apply, except the owner's own
  delete / edit asked with the link; touching a ticket in another session's ledger; a close or move whose exact comment
  is not on the approval page; touching a dirty or checked-out worktree; a tier-3 row that "looks obviously deletable".
- Creating a ticket, closing an issue, or deleting a ticket or comment for a move yourself; rerunning a plan after a
  breaker before its cause is fixed; editing a chore journal; approving a move whose description preview is not on the page.
