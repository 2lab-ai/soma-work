---
name: auto-es
description: "soma-work only. The Executive Summary inside soma-work — run it instead of es (z phase5, autoz terminal report, a final report, $es). Runs zworkflow:es for the document, then adds the harness rules: own issues/PRs/documents with their state, a bold ⚠️ TL;DR line when one of them is unfinished, a final user follow-up section, and the session task card sync + card check through the model-command MCP, so the card waits in NEEDS YOU while work is unfinished. The host's turn-end summary runs its turn-end contract (reference/turn-end.md)."
---

# auto-es — es + the soma-work harness

`zworkflow:es` writes a portable Executive Summary; it knows nothing about soma-work. This skill is what soma-work
runs instead: the same document, plus the rules that need the harness — the session's task card (dashboard) and its
NEEDS YOU column. The harness prompt routes every es request here (`src/prompt/common.prompt`).

## Procedure

1. Run `zworkflow:es` — its mode resolution (Path A discovery, or the host's mode header) and its mode template give
   the document. This is the one place es runs directly: the harness rule "run `local:auto-es` instead of es" does
   not send this step back here.
2. Apply §Harness additions to that document while you write it.
3. §Card sync — put the links, their state, the title and the TL;DR on this session's task card.
4. §Card check — close the report with its one line.

## Harness additions

On top of the es mode template, in every mode (`brief` / `issue` / `epic`):

- **TL;DR first.** Before the SSOT section: exactly 3 lines, one plain sentence each (≤ 100 characters) —
  outcome · the most important fact · the next step. Path B wraps them in the host's `<tldr>` envelope; Path A
  renders them as a `TL;DR` block and sends the same lines in §Card sync. When an own artifact is unfinished,
  line 2 is the ⚠️ line of §Unfinished own artifacts.
- **Status marks own artifacts.** Every issue, PR and document **created this session** carries
  `🆕 created this session` and its current state (Open / Draft / Merged / Closed / QA / Published …). Documents
  count: HTML artifacts, uploaded reports, spec pages. At `brief` a created document is a link, so Status renders.
- **`⚠️ User follow-up required` — the very last section** (after the mode's own sections), only when an own
  artifact is unfinished. One block per unfinished artifact, in this order:
  - **Artifact** — `{label}: {url} — {state}` (the state you read this session).
  - **Why the agent could not complete it** — bold: the concrete blocker and its evidence (the error, the missing
    permission, the failing check, the pending decision). Never just "pending".
  - **Who must act** — the user, a reviewer, an admin (name the role or person when known).
  - **Steps** — numbered and runnable: a fenced command (`gh pr merge 830 --squash`) or the exact click path.
  - **Verify** — how to confirm it is done (`gh pr view 830 --json state` → `MERGED`).
  - **Then tell the agent** — what to reply in this thread so it continues (`"merged"` → it runs the dev deploy).

## Unfinished own artifacts

An **own artifact** is an issue, PR or document this session created (not one it only read or commented on). It is
**complete** only in a terminal state:

| Kind | Complete | Unfinished (examples) |
|---|---|---|
| PR | **Merged**, or **Closed** on purpose with the reason stated (superseded by #N, dropped by decision) | Open, Draft, review requested, changes requested, approved-but-unmerged, CI failing/pending, merge conflict, blocked by branch protection |
| Issue | **Closed** (completed, or not planned with the reason stated) — or a **hand-off issue** (below) once filed and linked | Open, waiting on QA / deploy / another PR / a decision the request needs |
| Document | Published where the user reads it (uploaded, linked, merged) | Draft only on local disk, upload failed, link dead |

Two things are never unfinished, so they never get a ⚠️ line or a follow-up block:

- **A hand-off issue.** This is an issue the session filed to carry work outside the request it was asked to do, and the report names it as such ("follow-up", "후속"). For this session it is complete once it is filed and linked: its job here was to be recorded. List it in Status with the state you last saw (Open while it waits). There is no ⚠️ line and no follow-up block. If the user wants it done, they say so ("873 진행"), and that is a new request.
- **What the user ended or declined.** The user may say "여기까지해", "stop here", "skip that" or "그건 생략". The step they declined, and anything that waits only on it, is not a blocker. Say it was skipped by the user's decision, on a plain line that quotes their words (skipped — user: "여기까지해"), so a reader can tell a real stop from a misread reply. Without this rule a finished session stays waiting (NEEDS YOU, 입력 대기) for work the user already let go.

A hand-off issue is not a way out. The request's own deliverable stays unfinished until it is done, unless the user ended that very work: the PR that fixes what was asked, the issue it closes, the deploy it needs. An issue filed for the request's own remaining work is not a hand-off issue. It stays Open, it is unfinished, and it gets the ⚠️ line. Calling that work a follow-up does not complete it.

When **any** own artifact is unfinished, three things are mandatory — in Path A and Path B alike:

1. **TL;DR ⚠️ line.** One TL;DR line starts with `⚠️` and states, in bold, which artifact is not complete and why it
   cannot be completed by the agent — the concrete blocker, never "pending":
   `⚠️ **PR #830 not merged — merging needs a maintainer approval the bot does not have.**` Several unfinished
   artifacts share one ⚠️ line (`⚠️ **PR #830 unmerged (approval) · issue #829 open (needs prod deploy)**`). The
   TL;DR stays 3 lines: outcome · ⚠️ blocker · next step. A line that starts with `⚠️` is reserved for this signal
   only — never use it for a risk, a flaky test or a note.
2. **`⚠️ User follow-up required` as the very last section** — §Harness additions.
3. **The card waits for the user.** The ⚠️ TL;DR line is what moves the session's task card to **NEEDS YOU**
   (waiting for the user's follow-up input) instead of DONE, with the blocker as the card's summary line. Path A
   writes the TL;DR to the card (§Card sync); Path B's TL;DR is parsed by the host. The card leaves NEEDS YOU when
   the next Executive Summary's TL;DR has no ⚠️ line (the work got finished), or on `/new`.

No unfinished own artifact → no ⚠️ line, no follow-up section. Never invent a blocker to look diligent, and never
hide one to look done.

## Card sync

The session's task card (dashboard) shows the session title, the issue/PR/document links with their state, and the
TL;DR. Running auto-es keeps it true.

**Path A (model-run — z phase5, autoz terminal report, a final report, `$es`)**. After writing the document, in the
same turn:

1. `GET_SESSION` — read what the card already lists (`issues`, `prs`, `docs`, `active`, `sequence`).
2. `UPDATE_SESSION` once, with:
   - `operations` — for every issue/PR/document this session created or changed state of:
     `{ action: "add", resourceType: "issue" | "pr" | "doc", link: { url, type, provider, label: "#830", title, status } }`.
     `status` is the state you just read (`open`, `draft`, `merged`, `closed`, …). Re-adding a known URL updates it in
     place. Then `{ action: "set_active", resourceType, url }` for the artifact the session is about now.
   - `title` — when the session still has a stand-in title or the work's subject changed (≤ 100 chars).
   - `executiveSummary: { tldr: [line1, line2, line3] }` — the same TL;DR lines the document opens with, ⚠️ line
     included. This is what puts the TL;DR on the card and what keeps the card in NEEDS YOU.
3. `GET_SESSION` again with `{ waitForAckMs: 30000 }` — the server waits (up to 30 s) for the host to handle your
   write; the host can apply it ~20 s late (#881). Verify against `payload.host`, the host's receipt (#846): every own artifact is in
   `host.session` with the state you wrote, `host.tldr` is your TL;DR, and `host.followUp` is your ⚠️ reason when
   you wrote one. `prs: []` after you created a PR is an alarm: fix the write before you finish. Write full URLs in
   the document too (short refs like `#830` are not captured).
   - `host` is the host's state: written at the turn start, after each of your writes, when the host notes a link
     itself (a PR it saw you open) and on `/new` (#881).
   - `hostPending: true` after the wait (`hostWaitedMs` says how long) — the host has not handled your last write:
     say in the document that the card is unconfirmed; do not loop.
   - `host.lastWrite` is your own last write as the host handled it (looked up by its `receiptId`).
     `host.lastWrite.ok === false` — the host could not apply it (`reason`, e.g. `SEQUENCE_MISMATCH`), so the card
     did not change: retry once without `expectedSequence`, then say in the document that the card is stale.
     `host.lastWrite.instructions` tells instruction writes apart: they wait for the user's y/n, or were refused.
   - A user message that reaches you after this write (sent while you were writing it) is not in the card: answer
     it, then write the card again so the TL;DR covers it (#881).
   - No `host` in the answer (an older host, or the host could not write its receipt): `payload.session` is the
     model-command server's own copy, not the host's; the thread's `⚠️ Session update could not be applied on host
     (<reason>)` is then the only sign of a failed write.

A Slack-less dashboard task makes the same calls: the host writes them by the task's session key.

**Path B (host-run, no tools)** — §Turn end.

## Card check

필수(required) — 보고를 닫기 전에 이 세션의 작업 카드가 보고와 같은지 확인한다 (#836). 호스트가 일부를 스스로 기록하더라도 마지막 확인은 모델의 몫이다. 이 턴에 §Card sync를 이미 했다면 그것이 이 확인을 겸한다 — 두 번 하지 않는다. 호출 모양은 §Card sync와 같다.

- `GET_SESSION` — 카드가 기록한 링크를 읽는다 (`payload.session`의 `issues` · `prs` · `docs`, 그리고 `active`). 이때의 `active`를 기억해 둔다.
- 보고가 이름 붙인 모든 PR · 이슈 · 문서를 URL로 대조한다(정규형 URL, 같은 링크는 한 번만 센다). 카드가 바뀌었는지가 아니라, 보고의 산출물이 카드에 있는지를 본다.
- 빠진 것이 있으면 `UPDATE_SESSION` 한 번: 빠진 것마다 `{ action: "add", resourceType: "issue" | "pr" | "doc", link: { url, type, provider, label, title, status } }` (url은 정규형). `add`는 그 종류의 지금 링크도 옮기므로, 끝에 추가한 종류마다 처음 읽은 `active`로 되돌린다: `{ action: "set_active", resourceType, url }` — url은 `GET_SESSION`이 돌려준 문자열 그대로. 처음에 비어 있던 종류는 url 없이 `{ action: "set_active", resourceType }`로 비운다. 지금 다루는 산출물로 바꾸는 것이 의도일 때만 그 url을 쓴다.
- `GET_SESSION`을 `{ waitForAckMs: 30000 }`으로 다시 읽어 확인한다 — 서버가 호스트의 처리를 최대 30초 기다린다(호스트는 쓰기를 ~20초 늦게 적용할 수 있다, #881). 호스트의 영수증 `payload.host`로 본다(#846). 기다린 뒤에도 `hostPending: true`면(`hostWaitedMs`) 보고에 카드 미확인이라 적고 반복하지 않는다. `host.lastWrite.ok`가 false면 카드는 바뀌지 않은 것이다(`reason`) — `expectedSequence` 없이 한 번 다시 시도하고, 그래도 실패하면 그 링크를 빠진 것으로 센다. `host`가 없는 답(이전 호스트)의 `payload.session`은 model-command 서버의 사본(쓰기를 바로 반영한 미리보기)이라 호스트의 수락 증거가 아니다 — 그때는 스레드의 `⚠️ Session update could not be applied on host (<reason>)`가 유일한 실패 신호다.
- 보고에 한 줄로 쓴다: `Card check: <카드에 있는 수>/<보고의 산출물 수> on the card`. 다시 시도해도 빠진 것이 있으면 그 URL을 적고, 보고를 완료로 닫지 않는다.

## Turn end

The host's turn-end Executive Summary (Path B, `packages/slack/src/summary-service.ts`) is this skill run without tools: soma-work reads `reference/turn-end.md` at startup (`src/plugin/harness-skills.ts`) and appends it to the
summary fork's prompt after the es mode template. The fork writes the document with the TL;DR envelope; the host does
the card side itself — it puts the TL;DR on the card and derives the NEEDS YOU follow-up from the ⚠️ line. Links reach
the card from the session's own capture, so the document must still carry full URLs.

In a turn where Path A already wrote the card (§Card sync), the host does not run its summary for that turn (#846):
the card and the thread head keep the TL;DR this skill wrote. When the turn took in a message the user sent while it
ran, the host summary runs after all and judges the whole turn. The next input clears the mark, so the next turn is
summarized again.
