# Context rollback

Roll the model's conversation context back to an earlier point, so the next turn runs as if the later turns never happened. Files the model changed are not restored — only what it remembers.

Requested 2026-11-02: "채팅 내역을 이용하여 원하는 지점으로 문맥 대화 롤백 기능 (대화해서 특정 유저의 입력 시점으로 롤백, 작업 로그에서 특정 시점으로 롤백 2가지 지원". Epic #741: #743 (engine + thread command), #744 (dashboard), #745 (goal stall offers the goal's first failure point).

## How it works

- **Mechanism.** soma-work runs one Agent SDK `query({ resume: sessionId })` per turn. A rollback sets `resumeSessionAt: <chain uuid>` on the next turn's query: the session id stays, every transcript entry after that uuid leaves the context, and later plain resumes stay on the shortened branch. Verified on SDK 0.3.284 (2 November 2026): a codeword given after the cut point was gone, one before it was kept, and a cut at a `tool_result` entry worked. A uuid the transcript does not have fails the turn with `No message found with message.uuid`, so the host checks the transcript first.
- **Cut points (anchors).** `@soma/slack/context-anchor` tracks the main agent's latest safe chain entry while a turn streams (`trackChainPoint`, called from `ClaudeHandler.streamSdkQuery`): an assistant message with no `tool_use`, or the `tool_result` message that answers the last open call. A cut between a call and its result would leave a dangling `tool_use`, so it is never an anchor. Subagent frames are ignored. The encoded anchor `<sessionId>~<compactionCount>~<uuid>` sits on `session.contextAnchor` (persisted).
- **What carries an anchor.** Every recorded user turn (`ConversationTurn.anchor` — the cut point just before that input) and every work-log entry (`WorkLogEntry.anchor` — the cut point the entry was made at).
- **When an anchor is unusable.** Another SDK session (`new`, renew) or a compaction since it was taken (`compactionCount` moved): `anchorRefusal` says `other-session` / `compacted`. A compaction replaces the context with a summary, and resuming at a pre-compaction uuid would bring the whole old context back.
- **Request.** `requestContextRollback` (`src/session/context-rollback.ts`) is the one gate for every surface: session owner only, never while a turn runs, a usable anchor, the uuid present in the transcript (`findTranscriptPath`), and not the current tail. It stores `session.pendingRewind` (persisted).
- **Apply.** `ClaudeHandler.streamSdkQuery` consumes it once (`consumePendingRewind`) when building the next turn's options: `options.resumeSessionAt = uuid`, the request is cleared, and the anchor moves to the target. A refused uuid fails that one turn, never every turn.

## Thread command

| Command | What it does |
|---|---|
| `rollback` (`롤백`) | Lists your inputs in this context that can be rolled back before (the latest 10, numbered). Goal continuations and other system turns are left out. |
| `rollback <n>` | Rolls the context back to just before input n. The thread is told what leaves the context; the next message runs from there. |
| `rollback goal` | Rolls the context back to where a stalled goal first failed for its reason (#745) — only when the stall offers it (the repeated turns did nothing). Same gate. |
| `rollback cancel` (`롤백 취소`) | Drops a rollback that has not run yet. |

The matcher is strict (`rollback`, `rollback <n>`, `rollback goal`, `rollback cancel`) so an instruction such as "rollback the migration" still reaches the model. `rollback` is not a known command root for the ❓ hint for the same reason.

## Dashboard

The opened card and the panel head have **⏪ 되돌리기** on a live session that has an SDK conversation (`KanbanSession.rollbackAvailable`). It opens a picker (`<ui-dialog id="rollback-dialog">`) with two lists, newest first:

- **내 입력 — 그 입력 직전으로**: the owner's inputs of this context (`rollbackInputPoints`).
- **작업 로그 — 그 지점까지 유지**: the work log's cut points (`rollbackWorkLogPoints`): each is the first reply, final answer or tool result entry made after the model reached a new safe cut point, so everything up to and including that entry stays.

**What a rollback dropped is marked.** A request records the time of the last entry it keeps (`PendingRewind.keptUntil` — an input point keeps up to just before the input, a work-log point keeps its own entry, the goal's first failure keeps its turn). When the next turn applies it, the session keeps the dropped span (`contextRewinds: { from: keptUntil, to: requestedAt, label, at }`, the latest 10, persisted, cleared by `new`/renew) and the card carries it. Work-log entries and conversation turns made inside a span read **↩︎ 문맥에서 빠짐** (a tool's summary, an entry's text, a turn's name). The dashboard POST takes the point's time as `at`.

A row's **되돌리기** takes two presses: the first arms it (the button reads `한 번 더 눌러 확인` and the status line says what will happen), the second sends. The dashboard uses no `confirm()` prompts.

`GET /api/dashboard/session/:key/rollback-points` answers both lists, a waiting rollback, and why a rollback cannot be asked now (`refusal`, `refusalText` — not the owner, a turn is running). `POST /api/dashboard/session/:key/rollback` takes `{ anchor, label, source: 'input' | 'worklog' }` or `{ cancel: true }`. Both routes sit behind the owner gate (`resolveSelfActionKeyAndOwner`) and call `SlackHandler.getContextRollbackPoints` / `handleContextRollback`, which use the same `requestContextRollback` gate as the thread command and tell the thread. A refusal answers 403 (not the owner), 409 (a turn is running, nothing to drop) or 422 (the point is from another conversation, before a compaction, or missing from the transcript) with the thread command's words. A waiting rollback shows on the card's action (`⏪ 되돌리기 예약됨`) and in the panel head (`⏪ 다음 턴부터 되돌림`), and can be cancelled from the picker.
