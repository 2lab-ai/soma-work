# Plan v3 · Issue #617 · Context Compaction Tracking + Per-User Threshold

## 1. Overview

3개 공백(①SDK hook 미등록 ②threshold 설정 부재 ③Slack 본문 post 부재)을 채운다. 기존 파이프라인 재사용:
- SDK `compact_boundary` 수신 → `stream-processor.ts:1029`
- SDK `status === 'compacting'` spinner 신호 → `stream-processor.ts:1041`, `stream-executor.ts:777`
- `CommandResult.continueWithPrompt` 루프 재진입 → `event-router.ts:158-160`, `input-processor.ts:52-75`

새 모듈은 3개. idempotency는 **session 내 compaction epoch 토큰**으로 설계 (세션당 N회 compaction 안전).

## 2. Data model changes

### 2.1 `src/user-settings-store.ts`

```ts
export interface UserSettings {
  // existing fields...
  compactThreshold?: number;  // 50~95, default 80 (undefined = use default)
}

export const DEFAULT_COMPACT_THRESHOLD = 80;
export const COMPACT_THRESHOLD_MIN = 50;
export const COMPACT_THRESHOLD_MAX = 95;

export function validateCompactThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("compactThreshold must be an integer");
  }
  if (value < COMPACT_THRESHOLD_MIN || value > COMPACT_THRESHOLD_MAX) {
    throw new Error(`compactThreshold must be in [${COMPACT_THRESHOLD_MIN}, ${COMPACT_THRESHOLD_MAX}]`);
  }
  return value;
}
```

Add **method on existing store** (matching `getUserDefaultModel` pattern at line 488):

```ts
getUserCompactThreshold(userId: string): number {
  return this.getSettings(userId)?.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
}

setUserCompactThreshold(userId: string, value: number): void {
  const validated = validateCompactThreshold(value);
  this.updateSettings(userId, { compactThreshold: validated });
}
```

**Migration**: existing `user-settings.json` records without `compactThreshold` are treated as undefined → `??` returns `DEFAULT_COMPACT_THRESHOLD`. No schema migration needed. Documented in JSDoc above `compactThreshold`.

Covers **AC1, AC2, AC7**.

## 3. Session state additions

Add to `ConversationSession` (or equivalent session struct owned by `SessionRegistry`):

```ts
interface ConversationSession {
  // existing...
  compactEpoch: number;                                          // incremented on each compaction start; default 0
  compactPostedByEpoch: Record<number, { pre: boolean; post: boolean }>;  // dedupe map for slackPost (pre/post)
  compactionRehydratedByEpoch: Record<number, boolean>;          // dedupe for context-builder rehydration
  preCompactUsagePct: number | null;                             // snapshot captured at PreCompact for "was X%"
  lastKnownUsagePct: number | null;                              // updated on every result-message; fallback for X/Y
  autoCompactPending: boolean;                                   // set by threshold-checker, consumed by input-processor
  pendingUserText: string | null;                                // user message text held while auto-compact runs
  pendingEventContext: { channel: string; threadTs: string; user: string; ts: string } | null;  // synthetic-event re-dispatch context
}
```

Initialization in `SessionRegistry` (session creation path). Rollback = remove these **8 fields**.

**Two epoch helpers** — split by signal role so "new cycle" is decided only by START signals, not END signals (prevents over-bump when `compact_boundary` arrives before `PostCompact` hook):

```ts
// START signals (PreCompact hook, `status==='compacting'` fallback).
// Always begins a NEW cycle unless one is already open for the current epoch.
export function beginCompactionCycleIfNeeded(session: ConversationSession): number {
  const marker = session.compactPostedByEpoch[session.compactEpoch];
  if (!marker || marker.post === true) {
    session.compactEpoch++;
    session.compactPostedByEpoch[session.compactEpoch] = { pre: false, post: false };
  }
  return session.compactEpoch;
}

// END signals (PostCompact hook, compact_boundary stream callback).
// Never starts a second cycle — only initializes the epoch counter once
// if we're still at the initial state (no Start signal observed).
// Two END signals for the same cycle rely on the caller's `marker.post===true` skip.
export function getCurrentEpochForEnd(session: ConversationSession): number {
  const marker = session.compactPostedByEpoch[session.compactEpoch];
  if (!marker) {
    // Fallback: no Start signal was observed. Init the first cycle once.
    session.compactEpoch++;
    session.compactPostedByEpoch[session.compactEpoch] = { pre: false, post: false };
  }
  return session.compactEpoch;
}
```

**Semantic contract** — a session's N-th compaction cycle MUST be announced by at least one START signal (`PreCompact` hook OR SDK `status==='compacting'`). If both END signals fire for the same cycle, the second is idempotent via `marker.post===true`. If the SDK ever emits END without any START for the second+ cycle, that is treated as an SDK malfunction and the second cycle will be silently merged into the first. `getCurrentEpochForEnd` logs a `logger.warn('compact-hooks: END signal dropped (no START for new cycle)')` in that branch via the existing `Logger` used in `stream-executor.ts`. No new session field is added.

## 4. New modules

### 4.1 `src/slack/commands/compact-threshold-handler.ts` (new, ~70 LOC)

Follows `compact-handler.ts` pattern. Handles 3 forms:
- `/compact-threshold` → `Current threshold: <N>%` (via `slackApi.postSystemMessage`)
- `/compact-threshold <int>` → validates 50-95, persists via `userSettingsStore.setUserCompactThreshold`, responds `Updated to <N>%`
- invalid arg (range/type) → `postSystemMessage` with explicit error (includes AC1 verbatim "compactThreshold must be in [50, 95]")

Registered in `src/slack/commands/command-router.ts` (or wherever `CompactHandler` is registered) alongside existing handlers.

### 4.2 `src/slack/hooks/compact-hooks.ts` (new, ~180 LOC)

Exports `buildCompactHooks({ sessionRegistry, slackApi }): SdkHookMap` and a helper that returns an object with 3 callbacks matching Claude Agent SDK's hook signatures per docs (https://code.claude.com/docs/en/hooks):

- **PreCompact(payload)**:
  1. Resolve session by `payload.session_id`.
  2. `const epoch = beginCompactionCycleIfNeeded(session);`
  3. `session.preCompactUsagePct = session.lastKnownUsagePct;`
  4. If `!session.compactPostedByEpoch[epoch].pre`:
     - `slackApi.postSystemMessage(channel, \`🗜️ Compaction starting · trigger=${payload.trigger ?? 'unknown'}\`, { threadTs })`
     - `session.compactPostedByEpoch[epoch].pre = true`

- **PostCompact(payload)**:
  1. Resolve session. `const epoch = getCurrentEpochForEnd(session);` (END signal — never starts a new cycle; only initializes epoch when no Start signal was ever observed).
  2. If `!session.compactPostedByEpoch[epoch].post`:
     - `const x = session.preCompactUsagePct; const y = session.lastKnownUsagePct;`
     - msg = ``✅ Compaction complete · was ~${x ?? '?'}% → now ~${y ?? '?'}% · 중요한 맥락 다시 알려주세요``
     - `slackApi.postSystemMessage(...msg)`, `session.compactPostedByEpoch[epoch].post = true`
  3. `session.autoCompactPending = false` reset.
  4. If `session.pendingUserText` AND `session.pendingEventContext`:
     - `const text = session.pendingUserText; const ctx = session.pendingEventContext;`
     - `session.pendingUserText = null; session.pendingEventContext = null;` (prevents re-entry)
     - `await eventRouter.dispatchPendingUserMessage(ctx, text);` — **concrete new method** added to `event-router.ts` (see §5.8).

- **SessionStart(payload)**:
  1. If `payload.source !== 'compact'`, return (no-op).
  2. Resolve session. `const epoch = getCurrentEpochForEnd(session);` (SessionStart post-compact is an END signal — the cycle was already begun).
  3. If `session.compactionRehydratedByEpoch[epoch]` → skip (already rebuilt via compact_boundary path).
  4. Else: trigger `buildCompactionContext(snapshotFromSession(session))` — **same function imported from `src/session/compaction-context-builder.ts`**, same effect as `stream-executor.ts:399-406`. Set `session.compactionRehydratedByEpoch[epoch] = true`.

### 4.3 `src/session/compact-threshold-checker.ts` (new, ~100 LOC)

```ts
export async function checkAndSchedulePendingCompact(args: {
  session: ConversationSession;
  userId: string;
  channel: string;
  threadTs: string;
  userSettings: UserSettingsStore;
  slackApi: SlackApiHelper;
  modelRegistry: ModelRegistry;
}): Promise<boolean>
```

Logic (called at **exact site** `stream-executor.ts:1098` right after `threadPanel.endTurn(turnId, 'completed')`):
1. `if (session.autoCompactPending) return false;` (already scheduled)
2. `const usagePct = computeUsagePct(session, modelRegistry);` reuse formula from `dashboard.ts:314-319`.
3. `session.lastKnownUsagePct = usagePct;`
4. `const threshold = userSettings.getUserCompactThreshold(userId);`
5. If `usagePct >= threshold`:
   - `session.autoCompactPending = true`
   - `slackApi.postSystemMessage(channel, \`🗜️ Context usage ${usagePct}% ≥ threshold ${threshold}% — next turn will auto /compact\`, { threadTs })`
   - return `true`
6. else return `false`.

**Pending consumption in `input-processor.ts:52-75` (AC3 injector call-site, concrete)**:
```ts
async routeCommand(event, say) {
  const session = this.deps.claudeHandler.getSession(event.channel, event.thread_ts ?? event.ts);
  if (session?.autoCompactPending) {
    session.autoCompactPending = false;
    session.pendingUserText = event.text ?? null;
    await this.deps.slackApi.postSystemMessage(event.channel, '🗜️ Auto-compact 실행 — 원 메시지는 compact 완료 후 재처리됩니다', { threadTs: event.thread_ts ?? event.ts });
    return { handled: true, continueWithPrompt: '/compact' };
  }
  // ...existing flow
}
```

`event-router.ts:158-160`의 기존 `continueWithPrompt` 루프가 `/compact`를 Claude SDK로 흘려 보냄 → SDK compact 실행 → `PostCompact` hook에서 `pendingUserText` 재주입.

Covers **AC3**.

## 5. Wiring changes (concrete file:line anchors)

### 5.1 `src/claude-handler.ts:862-866` — register SDK hooks

```ts
const compactHooks = buildCompactHooks({ sessionRegistry: this.sessionRegistry, slackApi: this.slackApi });
options.hooks = {
  ...(existing hooks),
  PreCompact: [compactHooks.PreCompact],
  PostCompact: [compactHooks.PostCompact],
  SessionStart: [compactHooks.SessionStart],
};
```

Covers **AC4, AC5, AC6** primary path.

### 5.2 `src/slack/stream-processor.ts:1041` — AC4 fallback (`status === 'compacting'`)

Augment existing branch: emit `onCompactStarting({ trigger: 'unknown' })` callback if consumer provides one. No direct Slack post here — keeps stream-processor agnostic. `stream-executor.ts:777` consumes the callback.

### 5.3 `src/slack/pipeline/stream-executor.ts:777` — "starting" fallback Slack post

If `status === 'compacting'` received:
- `const epoch = beginCompactionCycleIfNeeded(session);`
- If `!session.compactPostedByEpoch[epoch].pre`:
  - `slackApi.postSystemMessage(..., '🗜️ Compaction starting · trigger=unknown (fallback)', ...)`
  - `session.preCompactUsagePct = session.lastKnownUsagePct;`
  - `session.compactPostedByEpoch[epoch].pre = true`

Guarantees **AC4 even when SDK PreCompact hook not emitted** by current SDK version. Same epoch helper prevents double-bump when both primary hook and fallback fire.

### 5.4 `src/slack/pipeline/stream-executor.ts:761-775` — `onCompactBoundary`

Keep existing counter/flag logic. Add (uses same helper to fix the compact_boundary-before-PreCompact race):
```ts
const epoch = getCurrentEpochForEnd(session);  // END signal; never starts a new cycle
if (!session.compactPostedByEpoch[epoch].post) {
  const x = session.preCompactUsagePct; const y = session.lastKnownUsagePct;
  await slackApi.postSystemMessage(channel, `✅ Compaction complete · was ~${x ?? '?'}% → now ~${y ?? '?'}%`, { threadTs });
  session.compactPostedByEpoch[epoch].post = true;
}
if (!session.compactionRehydratedByEpoch[epoch]) {
  // Existing rebuild at lines 399-406 runs on the next turn; mark here to dedupe against SessionStart hook.
  session.compactionRehydratedByEpoch[epoch] = true;
}
session.autoCompactPending = false;

// pendingUserText re-dispatch (dedupe: only the first of PostCompact-hook / compact_boundary reaches here)
if (session.pendingUserText && session.pendingEventContext) {
  const text = session.pendingUserText;
  const ctx = session.pendingEventContext;
  session.pendingUserText = null;
  session.pendingEventContext = null;
  await this.deps.eventRouter.dispatchPendingUserMessage(ctx, text);
}
```
Idempotent key = `epoch`; whichever of PostCompact hook (§4.2) or `onCompactBoundary` fires first posts and re-dispatches, the other skips.

### 5.5 `src/slack/pipeline/stream-executor.ts:1098` — threshold-checker call

Right after `await this.deps.threadPanel?.endTurn(turnId, 'completed');`:
```ts
await checkAndSchedulePendingCompact({ session, userId, channel, threadTs, userSettings: userSettingsStore, slackApi: this.deps.slackApi, modelRegistry: this.deps.modelRegistry });
```

### 5.6 `src/slack/pipeline/input-processor.ts:52-75`

Insert pending-compact pre-check at method start (see §4.3 code block). Additionally on match, save `session.pendingEventContext = { channel: event.channel, threadTs: event.thread_ts ?? event.ts, user: event.user, ts: event.ts }`.

### 5.7 Command handler registration (two files, concrete anchors)

- `src/slack/commands/command-router.ts:85` — insert `new CompactThresholdHandler(deps),` adjacent to the existing `new CompactHandler(deps),` entry so precedence matches the other `/compact*` variants.
- `src/slack/commands/index.ts:8` — add `export { CompactThresholdHandler } from './compact-threshold-handler';` next to the existing `CompactHandler` re-export.

### 5.8 `src/slack/event-router.ts` — new `dispatchPendingUserMessage` method

New public method on `EventRouter`:
```ts
public async dispatchPendingUserMessage(
  ctx: { channel: string; threadTs: string; user: string; ts: string },
  text: string,
): Promise<void> {
  // Build synthetic MessageEvent matching the shape expected by this.messageHandler (event-router.ts:177).
  const syntheticEvent = {
    type: 'message',
    channel: ctx.channel,
    thread_ts: ctx.threadTs,
    user: ctx.user,
    ts: ctx.ts,
    text,
  } as MessageEvent;
  // Inline say function → delegate to slackApi so Bolt's say dependency is unnecessary.
  const say: SayFn = async (arg) => {
    const payload = typeof arg === 'string' ? { text: arg } : arg;
    await this.deps.slackApi.postMessage(ctx.channel, payload.text ?? '', {
      threadTs: ctx.threadTs,
      blocks: payload.blocks,
    });
  };
  await this.messageHandler(syntheticEvent, say);
}
```

Wire `compact-hooks.ts` and `stream-executor.ts:761-775` via DI: pass the `EventRouter` instance through the existing deps chain (`stream-executor` already owns `deps.claudeHandler`; add `deps.eventRouter` alongside). Injected at bootstrap in `src/slack/index.ts` (or wherever `EventRouter` and `StreamExecutor` are constructed).

## 6. Tests — 1:1 AC mapping

| File | Tests | AC |
|---|---|---|
| `tests/user-settings-store.test.ts` (extend) | `validateCompactThreshold` range 49/50/80/95/96, type guard (abc/3.5), round-trip persist, default=80 | **AC1, AC2** |
| `tests/slack/commands/compact-threshold-handler.test.ts` (new) | `/compact-threshold` current-value response, `/compact-threshold 75` update+response, range error 30, type error abc | **AC1, AC7** |
| `tests/session/compact-threshold-checker.test.ts` (new) | usage=79/threshold=80 → false, no post; usage=80/threshold=80 → true + slackPost + `autoCompactPending=true`; re-call with `autoCompactPending=true` → no-op; post-PostCompact reset → can fire again | **AC3** |
| `tests/slack/hooks/compact-hooks.test.ts` (new) | PreCompact payload (trigger=auto/manual) → slackPost "starting · trigger=X", epoch++, `preCompactUsagePct` snapshot; PostCompact payload → slackPost "complete · was ~X% → now ~Y%" (explicit test for `preCompactUsagePct=null` fallback to `'?'`); SessionStart source=compact → rehydrate triggered; source=startup → skip; idempotent: calling PostCompact twice in same epoch → 1 slackPost | **AC4, AC5, AC6** |
| `tests/slack/hooks/compact-fallback.test.ts` (new) | PreCompact hook never fires; `status === 'compacting'` signal → slackPost "starting · trigger=unknown (fallback)", epoch bumped. SDK PreCompact fires first → compacting-status signal skips (idempotent by epoch pre flag). | **AC4 fallback** |
| `tests/slack/pipeline/stream-executor-compact.test.ts` (new) | Dual-path dedupe: compact_boundary + PostCompact hook both fire in 1 epoch → slackPost count=1. 2 compactions in 1 session (epoch 1, 2) → slackPost count=2. | **AC6 dedupe + N-compaction safety** |
| `tests/slack/pipeline/input-processor-compact.test.ts` (new) | `session.autoCompactPending=true` → returns `{handled: true, continueWithPrompt: '/compact'}`, `pendingUserText=<original>`; PostCompact hook re-dispatches saved text once. | **AC3 end-to-end** |

Covers **AC8** (test coverage AC).

## 7. Verification sequence

| Step | Command | Verifies |
|---|---|---|
| S1 | `bun test tests/user-settings-store.test.ts` | AC1, AC2 |
| S2 | `bun test tests/slack/commands/compact-threshold-handler.test.ts` | AC1, AC7 |
| S3 | `bun test tests/session/compact-threshold-checker.test.ts` | AC3 |
| S4 | `bun test tests/slack/hooks/compact-hooks.test.ts` | AC4/5/6 primary |
| S5 | `bun test tests/slack/hooks/compact-fallback.test.ts` | AC4 fallback |
| S6 | `bun test tests/slack/pipeline/stream-executor-compact.test.ts` | AC6 dedupe + N-compact |
| S7 | `bun test tests/slack/pipeline/input-processor-compact.test.ts` | AC3 end-to-end |
| S8 | `bun run build && bun run typecheck` | wiring compile |
| S9 | Slack QA: 긴 대화 → 80% 도달 | AC3 end-to-end observation |
| S10 | Slack QA: `/compact-threshold 60` → 60% 도달 | AC1 + AC3 |

## 8. Risk & rollback

### 8.1 Risks

- **R1 (P0-6 addressed)**: SDK `PreCompact` hook may not exist in current SDK version or payload `trigger` field absent. **Mitigation**: §5.2/§5.3 provides `status === 'compacting'` fallback; PostCompact failure falls back to `compact_boundary` path at §5.4. Either primary OR fallback guarantees AC4/AC5.
- **R2**: context-usage % math — reuse proven `dashboard.ts:314-319` formula with `modelRegistry.getContextWindow(model)`. Unit tested.
- **R3**: `pendingUserText` re-dispatch — concretely implemented as `EventRouter.dispatchPendingUserMessage` in §5.8 using a synthetic `MessageEvent` + inline `SayFn` wrapping `slackApi.postMessage`. Both types are already imported in `event-router.ts`. No outstanding gap.
- **R4**: SessionStart+compact_boundary duplicate rehydration. **Mitigation**: shared idempotent flag `compactPostedByEpoch` + `compactionRehydratedByEpoch`.

### 8.2 Rollback (restores exact prior behavior)

1. Revert `claude-handler.ts:862-866` hook registration block.
2. Revert `stream-executor.ts:777` fallback slackPost addition (keep only the original spinner text mutation).
3. Revert `stream-executor.ts:761-775` slackPost + rehydration flag + pending re-dispatch additions (keep only counter/flag mutation and the original rebuild logic).
4. Revert `stream-executor.ts:1098` `checkAndSchedulePendingCompact` call.
5. Revert `input-processor.ts:52-75` pending-compact pre-check.
6. Revert `command-router.ts:85` `CompactThresholdHandler` registration + `index.ts:8` re-export.
7. Revert `event-router.ts` `dispatchPendingUserMessage` method + DI wire-up in `src/slack/index.ts`.
8. Remove 8 session fields (§3): `compactEpoch`, `compactPostedByEpoch`, `compactionRehydratedByEpoch`, `preCompactUsagePct`, `lastKnownUsagePct`, `autoCompactPending`, `pendingUserText`, `pendingEventContext`.
9. Leave new files (`compact-hooks.ts`, `compact-threshold-checker.ts`, `compact-threshold-handler.ts`) as dead code or delete.

Result: `onCompactBoundary` pre-existing behavior (counter bump + spinner text + compaction-context rebuild) fully restored.

## 9. LOC estimate (revised)

| Component | LOC |
|---|---|
| compact-threshold-handler.ts | ~70 |
| compact-hooks.ts (incl. `beginCompactionCycleIfNeeded` + `getCurrentEpochForEnd` helpers) | ~210 |
| compact-threshold-checker.ts | ~100 |
| user-settings-store edits | ~25 |
| session-type edits (8 fields) | ~20 |
| stream-executor edits (§5.3/5.4/5.5 incl. pending re-dispatch) | ~60 |
| input-processor edits (§5.6) | ~20 |
| stream-processor edits (§5.2) | ~10 |
| claude-handler edits (§5.1) | ~15 |
| event-router edits (§5.8 `dispatchPendingUserMessage`) | ~30 |
| command-router.ts:85 + index.ts:8 registration | ~8 |
| bootstrap DI wiring (`src/slack/index.ts`) | ~10 |
| **Production subtotal** | **~578** |
| Tests (7 files) | ~350 |
| **Total** | **~928** |

11 production files edited + 5 new + 7 test files.

## 10. Out of scope (unchanged)

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env injection
- Pre-compact summary diff visualization
- Team-level threshold
