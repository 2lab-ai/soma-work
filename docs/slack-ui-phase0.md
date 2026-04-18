# Slack UI Phase 0 — SDK 4.7.0 upgrade + `ui-test` harness

Scope: issue [#525](https://github.com/2lab-ai/soma-work/issues/525) Phase 0.
This is a **self-proof** harness — the bot calls the same runtime paths
(bolt 4.7.0 + `@slack/web-api` 7.15.1) that Phase 1~4 will migrate to, so
any SDK/API regression surfaces here before real feature migration.

## Commands

Both commands are **DM-only** and **admin-only** and require an env flag.
They are invoked as **naked** text (no `/z` prefix).

| Command | Effect |
|---|---|
| `ui-test` | Prints usage help |
| `ui-test stream` | Runs `chat.startStream` → 5× `chat.appendStream` → `chat.stopStream`. Each chunk is ≥260 chars (forces buffer overflow). 800ms between chunks. |
| `ui-test plan` | Posts a `plan` block with 4 `task_card`s, then transitions through 5 states via `chat.update` (3s intervals). Status values: `pending` → `in_progress` → `complete` → `error`. Each update carries a classic `section` fallback block + top-level `text` for legacy clients. |
| `ui-test task_card` | Posts a single **standalone** `task_card` block (outside any `plan` wrapper) and transitions it `pending` → `in_progress` → `complete` via `chat.update` (3s intervals). Confirms whether Slack accepts `task_card` as a top-level block. |
| `ui-test work` | Combined simulation: starts a stream at the top, posts a live `plan` below, then runs 4 real shell commands (`pwd`, `date -u`, `uptime`, `ls /tmp \| wc -l`) via `node:child_process.exec`. Each step flips the corresponding `task_card` `pending` → `in_progress` → `complete`/`error` while streaming the command output into the top message. 5s timeout, 4KB buffer per step. Commands are compile-time constants — no user input touches the shell. |

## Gating (triple)

Gate order (execute):

1. **Env**: `SLACK_UI_TEST_ENABLED !== 'true'` → disabled notice + `handled: true`. `canHandle()` intentionally matches regardless of env so the naked `ui-test` text never falls through to the session initialization pipeline.
2. **Admin**: `!isAdminUser(ctx.user)` → permission denied. Reuses `ADMIN_USERS` comma-separated env list (`src/admin-utils.ts`).
3. **DM-only**: `!ctx.channel.startsWith('D')` → DM-only notice. Channel streaming requires `recipient_user_id`/`recipient_team_id`, which we intentionally avoid by DM-scoping.

## Env setup

```bash
SLACK_UI_TEST_ENABLED=true
ADMIN_USERS=U0123ABC,U0456DEF
```

## Trigger surface

- ✅ **Naked DM**: send `ui-test stream` or `ui-test plan` as a direct message to the bot.
- ✅ **Naked thread in DM**: also works — handler preserves thread context.
- ❌ **Slash `/z ui-test`**: intentionally blocked via `SLASH_FORBIDDEN` in `src/slack/z/capability.ts`. The slash adapter fills `threadTs = channel_id` as a placeholder which breaks `chat.startStream({ thread_ts })`. Users are shown `SLASH_FORBIDDEN_MESSAGE`.
- ❌ **Public/private channel**: `channel.startsWith('D')` gate rejects with DM-only notice.

## Expected behavior

### `ui-test stream`
- New DM message begins streaming ~immediately after trigger.
- Over ~4 seconds, the message grows by 5 visible chunks (≥260 chars each).
- Final state: `✅ Stream demo complete (5 chunks).`

### `ui-test plan`
- New DM message renders a `plan` block titled *Phase 0 UI test plan* with 4 `task_card`s (all `pending`).
- Every 3 seconds, the same message transitions:
  - state 1: t0=in_progress, others pending
  - state 2: t0=complete, t1=in_progress, others pending
  - state 3: t0=complete, t1=complete, t2=**error**, t3=pending
  - state 4: t0=complete, t1=complete, t2=error, t3=complete
- Each state also includes a classic `section` fallback block with `mrkdwn`: `*Fallback* — state N: t0=... · t1=... · t2=... · t3=...`.
- `text` field mirrors the fallback for legacy clients that can't render `plan`/`task_card`.

### `ui-test task_card`
- One DM message with a standalone `task_card` block.
- 3-second intervals: `pending` → `in_progress` → `complete`.
- `text` fallback: `task_card demo — <status>`.

### `ui-test work`
- Two DM messages anchor the run: a **stream** (top) and a **plan** (bottom).
- 4 tasks execute in order. For each task:
  - Plan `task_card` flips to `in_progress`.
  - Stream appends `### <title>\n$ <cmd>`.
  - `child_process.exec` runs the command (5s timeout, 4KB buffer, `bash` shell).
  - Stream appends the command output in a fenced block.
  - Plan `task_card` flips to `complete` (or `error` if the command failed).
- Stream closes with `✅ All tasks complete.` or `⚠️ N complete, M error.` summary.
- Plan remains visible after completion so the user can inspect final task states.

### Streaming mode invariant

`chat.appendStream({ chunks: [...] })` locks the stream into **chunks** mode. `chat.stopStream` must close in the same mode — passing top-level `markdown_text` after chunked appends raises `streaming_mode_mismatch` on the server. The harness uses `chunks` mode end-to-end for every stream and this is verified by `ui-test stream` in DM.

## Go / No-Go checklist

Run all four commands and observe on **three Slack clients simultaneously**:

- [ ] **iOS** — stream chunks visible and incremental; plan block renders OR falls back to section; task_card status transitions visible; `work` runs shell commands and updates both blocks in lockstep
- [ ] **Android** — same
- [ ] **desktop web** — same

| Result | Verdict | Next step |
|---|---|---|
| All 3 clients render both commands correctly | **Go** | Proceed to Phase 1 (actual migration PR) |
| `plan` block panics or goes invisible on any client | **No-Go (Opt B-minus)** | Drop `plan`/`task_card`, keep classic `section` only |
| `stream` stalls, errors, or skips chunks on any client | **No-Go** | Investigate before migrating `stream-processor.ts` in Phase 2 |

## Out-of-scope (Phase 0)

- `src/slack/stream-processor.ts` — Phase 2
- `src/slack/tool-event-processor.ts` — Phase 2
- `src/slack/pipeline/session-initializer.ts` — Phase 4
- `src/slack/assistant-status-manager.ts` — Phase 3
- `SlackStream` wrapper — Phase 2
- `app.assistant(new Assistant(...))` container — Phase 3
- `DispatchService` `plan` block integration — Phase 4
- `CommandContext` extension (teamId/channelType) — permanently out-of-scope; use `deps.slackApi.getChannelInfo()` if needed
- `task_update` streaming chunks — future phase (this harness uses `chat.update` for state transitions instead)

## Regression smoke (post-SDK-bump)

These existing code paths were not touched by Phase 0 and must still work:

- [ ] Socket Mode boot (`src/index.ts`)
- [ ] DM `/z help` response
- [ ] `app_mention` thread response
- [ ] cron / ReportScheduler / dashboard / MCP existing UX unchanged
- [ ] Flag-off + non-admin + channel + DM: `ui-test` correctly rejected at each gate

## File map

| File | Change |
|---|---|
| `package.json` | `@slack/bolt` =4.4.0 → =4.7.0; add `@slack/web-api` ^7.15.1 |
| `package-lock.json` | Regenerated |
| `src/slack/commands/ui-test-handler.ts` | **New** — Phase 0 harness |
| `src/slack/commands/command-router.ts` | Register `UITestHandler` (near `SandboxHandler`) |
| `src/slack/commands/index.ts` | Re-export `UITestHandler` |
| `src/slack/z/whitelist.ts` | Add `^ui-test(\s+(stream\|plan\|task_card\|work))?$` to naked whitelist |
| `src/slack/z/capability.ts` | Add `'ui-test'` to `SLASH_FORBIDDEN` |
| `docs/slack-ui-phase0.md` | This document |
