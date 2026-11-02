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
| `rollback cancel` (`롤백 취소`) | Drops a rollback that has not run yet. |

The matcher is strict (`rollback`, `rollback <n>`, `rollback cancel`) so an instruction such as "rollback the migration" still reaches the model. `rollback` is not a known command root for the ❓ hint for the same reason.
