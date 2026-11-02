# Context rollback

Roll the model's conversation context back to an earlier point, so the next turn runs as if the later turns never happened. Files the model changed are not restored — only what it remembers.

Requested 2026-11-02: "채팅 내역을 이용하여 원하는 지점으로 문맥 대화 롤백 기능 (대화해서 특정 유저의 입력 시점으로 롤백, 작업 로그에서 특정 시점으로 롤백 2가지 지원". Epic #741: #743 (engine + thread command), #744 (dashboard), #745 (goal stall offers the goal's first failure point).

Revised 2026-11-03 (owner): "되돌리기 버튼 '작업 카드'에서 빼줘 … 되돌리기 모드를 누르면 채팅이랑 작업 로그에 각각 엔트리별로 해당 지점으로 되돌리기 버튼이 '디테일 작업 카드'에 표시되고 거기서 누르면 확인하고 되돌리기를 할수 있어야함 … 되돌리기후 다시 되돌리기한건 redo할 수 있어야함 … 해당 지시를 출력해주고 해당 지시를 보내기 전으로 되돌리는 거야 (Claude Code와 같이)". The point list (picker) is gone: the dashboard has 되돌리기 모드, and a rollback can be taken back (Redo).

## How it works

- **Mechanism.** soma-work runs one Agent SDK `query({ resume: sessionId })` per turn. A rollback sets `resumeSessionAt: <chain uuid>` on the next turn's query: the session id stays, every transcript entry after that uuid leaves the context, and later plain resumes stay on the shortened branch. Verified on SDK 0.3.284 (2 November 2026): a codeword given after the cut point was gone, one before it was kept, and a cut at a `tool_result` entry worked. A uuid the transcript does not have fails the turn with `No message found with message.uuid`, so the host checks the transcript first.
- **Cut points (anchors).** `@soma/slack/context-anchor` tracks the main agent's latest safe chain entry while a turn streams (`trackChainPoint`, called from `ClaudeHandler.streamSdkQuery`): an assistant message with no `tool_use`, or the `tool_result` message that answers the last open call. A cut between a call and its result would leave a dangling `tool_use`, so it is never an anchor. Subagent frames are ignored. The encoded anchor `<sessionId>~<compactionCount>~<uuid>` sits on `session.contextAnchor` (persisted).
- **What carries an anchor.** Every recorded user turn (`ConversationTurn.anchor` — the cut point just before that input) and every work-log entry (`WorkLogEntry.anchor` — the cut point the entry was made at).
- **When an anchor is unusable.** Another SDK session (`new`, renew) or a compaction since it was taken (`compactionCount` moved): `anchorRefusal` says `other-session` / `compacted`. A compaction replaces the context with a summary, and resuming at a pre-compaction uuid would bring the whole old context back.
- **Request.** `requestContextRollback` (`src/session/context-rollback.ts`) is the one gate for every surface: session owner only, never while a turn runs, a usable anchor, the uuid on the transcript's *active branch* (`transcriptOnActiveChain`: the tail and its `parentUuid` ancestors — after a rollback the dropped branch's uuids stay in the file, but the SDK cannot resume there and fails the turn with `No message found with message.uuid`), and not the current tail. The thread list and the dashboard picker offer only active-branch points (`activeChainFilter`). It stores `session.pendingRewind` (persisted).
- **Apply.** `ClaudeHandler.streamSdkQuery` consumes it once (`consumePendingRewind`) when building the next turn's options: `options.resumeSessionAt = uuid`, the request is cleared, and the anchor moves to the target. A refused uuid fails that one turn, never every turn.
- **Redo.** Every accepted request pushes the rollback it replaced (or `null`, none) onto `session.rewindRedo` (persisted, at most 20). `redoContextRollback` — owner only, never while a turn runs — pops it: the previous waiting rollback waits again, or none does. Redo works until the next turn runs: that turn applies the rollback and clears the stack, as a new edit clears an editor's redo. An applied rollback cannot be taken back — the SDK cannot resume on the branch it dropped (`No message found with message.uuid`, measured on dev 2026-11-02). `cancel` drops the waiting rollback and the stack.

## Thread command

| Command | What it does |
|---|---|
| `rollback` (`롤백`) | Lists your inputs in this context that can be rolled back before (the latest 10, numbered). Goal continuations and other system turns are left out. |
| `rollback <n>` | Rolls the context back to just before input n. The thread is told what leaves the context; the next message runs from there. |
| `rollback goal` | Rolls the context back to where a stalled goal first failed for its reason (#745) — only when the stall offers it (the repeated turns did nothing). Same gate. |
| `rollback cancel` (`롤백 취소`) | Drops a rollback that has not run yet. |
| `rollback redo` (`롤백 다시`) | Takes the last rollback back, one step at a time, until the next message runs. |

`rollback <n>` and the dashboard quote the instruction an input rollback goes back before (`contextRollbackNotice`). The matcher is strict (`rollback`, `rollback <n>`, `rollback goal`, `rollback cancel`, `rollback redo`) so an instruction such as "rollback the migration" still reaches the model. `rollback` is not a known command root for the ❓ hint for the same reason.

## Dashboard — 되돌리기 모드

The board's card has no rollback button. The detail card's head (the panel) has **되돌리기 모드** (the `undo` glyph of @2lab.ai/ui's icon set) on a live session that has an SDK conversation (`KanbanSession.rollbackAvailable`), and **↪︎ Redo** while there is a rollback to take back (`KanbanSession.rewindRedo`, the depth).

Turning the mode on loads the points (`GET …/rollback-points`) and puts a button on each entry it can roll back to:

- **지시와 답변** — each of the owner's instructions: **⏪ 이 지시 전으로 되돌리기**, above its words (the turn's `media-<id>` slot of `<ui-conversation>`). The points are `rollbackInputPoints`; an input recorded without an anchor (before anchors were kept) gets one from the SDK transcript (`inputAnchorsFromTranscript`).
- **작업 로그** — each of the owner's instructions (`rollbackWorkLogInstructionPoints`: **⏪ 이 지시 전으로 되돌리기**), and each reply, final answer or tool result after which the model reached a new safe cut point (`rollbackWorkLogPoints`: **⏪ 여기까지 유지하고 되돌리기** — that entry and everything before it stay). A tool result's button sits on its call's card. The buttons are put into `<ui-work-log>`'s rows (its open shadow root, `.wl-entry[data-entry]`) and kept there across the element's repaints by a `MutationObserver`.

Only points on the active branch are offered (`activeChainFilter`); points from before a compaction or another conversation get no button. Not the owner, or a turn running: the buttons are disabled with the reason.

A button opens the confirmation (`<ui-dialog id="rollback-dialog">`):

- an instruction: "이 지시를 보내기 **전**으로 되돌립니다", the whole instruction quoted, how many turns leave, and that the instruction comes back into the composer;
- a work-log point: "이 지점까지 유지", the point's label, and the instruction it belongs to.

**되돌리기** asks the one gate (`POST …/rollback`). On success an instruction goes back into the panel composer (`#pc-composer`) to be edited and sent — Claude Code's rewind — and the thread is told, quoting it. **↪︎ Redo** (`POST …/rollback { redo: true }`) takes the last rollback back; the instruction it put into the composer leaves with it unless it was edited.

**What a rollback drops is marked — at once.** A request records the time of the last entry it keeps (`PendingRewind.keptUntil` — an input point keeps up to just before the input, a work-log point keeps its own entry, the goal's first failure keeps its turn). The card carries the waiting rollback's `keptUntil`, so work-log entries and conversation turns after it read **↩︎ 문맥에서 빠짐** as soon as it is asked for (`rewindSpansOf`); Redo takes the marks away. When the next turn applies it, the session keeps the dropped span (`contextRewinds: { from: keptUntil, to: requestedAt, label, at }`, the latest 10, persisted, cleared by `new`/renew) and the marks stay.

`GET /api/dashboard/session/:key/rollback-points` answers every point keyed to its entry (`inputs[].turnId`, `instructions[].seq`, `worklog[].seq`), an input's full text (up to 4,000 characters), the waiting rollback (`pending`, with `keptUntil`), the Redo depth (`redo`), and why a rollback cannot be asked now (`refusal`, `refusalText`). `POST /api/dashboard/session/:key/rollback` takes `{ anchor, label, source: 'input' | 'worklog', at?, text? }`, `{ redo: true }` or `{ cancel: true }`. Both routes sit behind the owner gate (`resolveSelfActionKeyAndOwner`) and call `SlackHandler.getContextRollbackPoints` / `handleContextRollback`, which use the same gates as the thread command and tell the thread. A refusal answers 403 (not the owner), 409 (a turn is running, nothing to drop, nothing to redo) or 422 (the point is from another conversation, before a compaction, or missing from the transcript) with the thread command's words. A waiting rollback shows in the panel head (`되돌림 — 다음 지시부터 적용`, after the same glyph). The dashboard uses no `confirm()` prompts.
