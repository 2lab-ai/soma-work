# Phase 6 — `Stalled` category split + T4 backlog (timeout-fire elimination)

> Created: 2026-05-28, after user reframed the turn-end-surface-guarantee invariant.

## What this PR does (this ships)

1. **TurnCategory enum gains `'Stalled'`.** `packages/slack/src/turn-notifier.ts` adds the fourth category alongside `WorkflowComplete` / `UIUserAskQuestion` / `Exception`. New `(⚫, #1F1F1F, '응답 없음 — 코드 버그 의심')` triple. `determineTurnCategory` accepts optional `isStalled` signal, with precedence over `isError`.
2. **`stream-executor.ts` `handleError` recategorizes stall-timeout** from `Exception` → `Stalled`. Message text changes from `"이전 턴이 일정 시간 응답이 없어 중단되었습니다."` to `"응답 없음 — 모델이 end_turn / ASK 신호를 보내지 않은 채 시간이 초과되었습니다. 코드 경로에 누락된 종료 신호가 있을 가능성이 큽니다."` — the new text frames the event as an investigation prompt, not a model/SDK error.
3. **B-4 say() fallback emoji** flips to ⚫ when notifier missing and abort is stall-timeout.
4. **CompletionMessageTracker** persists Stalled cards (was: persists only Exception). Stalled cards are investigation queue entries; deleting them on next turn would hide the buggy code path.
5. **Slack block-kit channel** renders the diagnostic body block for Stalled (same code-fence treatment as Exception).
6. **Docs** — `trace.md` invariant section rewritten with the 4-category table + user's binding quote.
7. **Tests** — `turn-notifier.test.ts` covers Stalled determination + color/emoji/label entries; `stream-executor.test.ts` updates the two assertions that previously locked the Exception+Korean text in for stall-timeout.

## What this PR does NOT do (T4 — separate work)

The user's binding direction: `"이렇게 타임아웃나는 경우를 모두 제거하라"` — every code path that produces a `Stalled` card is a bug to remove. This PR ships the visible recategorization; the actual elimination is a backlog audit.

### T4 backlog seed — one observed case

**Case `C0AKY7W2UGZ-1779941197.183069` (2026-05-28 04:06→05:16Z, prod dev box)**

Symptom: assistant rendered text `"백그라운드 검색이 이제 완료됐다. 유저 응답 대기 중. 응답이 오면 선택된 그룹별로 코드 수정 → 커밋 → PR 푸시."` and then the SDK iterator went idle for 30 min with no further SDK message (no `ResultMessage`, no `tool_use`, no `assistant` delta).

Possible root causes to investigate:

- **(a) Model never emitted `end_turn`.** The prompt / system message may not require the model to emit a terminal token after announcing a wait-for-user. If true: prompt-design fix (instruct the model to ALWAYS emit `end_turn` when handing back to user, even mid-conversation).
- **(b) Model emitted `end_turn` but the SDK / our `StreamProcessor` failed to surface a `ResultMessage`.** If true: SDK pipeline bug — investigate `StreamProcessor.handleResultMessage` instrumentation, add a log line on every `ResultMessage` arrival with the stop_reason.
- **(c) Network drop / Claude API silent close between assistant message and ResultMessage.** If true: SDK transport hardening or explicit close detection.

Each requires its own investigation + targeted PR. **Do not fold into this PR.**

### T4 audit procedure (to apply per observed Stalled card)

1. From the Stalled card timestamp, pull the session's full log (`grep <sessionKey>`).
2. Identify the last SDK message type emitted (text / tool_use / system) and check for matching `ResultMessage`.
3. Classify into (a) / (b) / (c) above (or a new category).
4. File a follow-up issue / PR per code path. The Stalled card itself stays in the thread as evidence.

### Why the timer stays armed

We do NOT disable the idle timer in this PR — disabling would hide the signal. Instead:

- The timer is now an **observability tool** (per user's reframing).
- Default remains 2h (PR #978's value); operators can `SOMA_STREAM_STALL_TIMEOUT_MS=0` to disable per environment.
- Every ⚫ card surfaced in production = T4 audit entry.

## Out of scope

- `B-2` / `B-4` / `B-5` / `B-6` / `C-3` / `C-4` / `C-6` — all previously shipped, no regression here.
- Color theme variants (dark mode etc.) — `#1F1F1F` is the universal pick for now.
- Stalled card auto-routing to a triage channel / incident bot — future work.

## Codex consult

Skipped for this PR — user's instruction is binding and concrete enough that codex consultation would only add latency. The single design decision (`'Stalled'` as new category vs reusing `'Exception'` with a sub-state) is already settled by the user's `"검은색으로 고치고"` directive + the 3-color definition they listed.

## Migration

- Existing `Exception` consumers that switched on `category === 'Exception'` continue to work unchanged for genuine errors. Stalled is a SIBLING category, not a sub-state.
- Existing tests that assert `category === 'Exception'` for stall-timeout updated in this PR (2 assertions in `stream-executor.test.ts`).
- Dashboards / external consumers that color cards by `TurnCategory` will render Stalled as `#1F1F1F` (black) via `getCategoryColor`. If a consumer hard-codes only the original 3 categories, it would receive a string it doesn't recognize — review external consumers (this codebase has only `slack-block-kit-channel` + `telegram-channel`, both of which call the shared helpers).

## Verification

- 191 stream-executor tests + 11 idle-timeout tests + 27 turn-notifier tests = **218/218 GREEN** on impacted files.
- Full suite, tsc, biome to be confirmed pre-merge.

## ID

Phase 6 (this PR), following Phase 1 (PR #969), Phase 2 (PR #970), Phase 3a (PR #971), Phase 3b (PR #972), Phase 4 (PR #973), Phase 5 (PR #978 — 2h default tune).
