# Context Window Trace: context-window-analysis

## AS-IS
- Slack bot tracks session context usage from Claude SDK stream events.
- Current context occupancy is intended to reflect the latest assistant turn, not billing totals.
- Max context window is intended to be dynamic per model, not a fixed 200k.

## TO-BE
- Produce an implementation-level spec for how context window size and occupancy are derived.
- Identify every branch that participates in the calculation.
- Identify any branches that drift from the intended single source of truth.

## Phase 1: Heuristic Top-3

### Hypothesis 1: Current context is derived from cumulative billing totals
- `src/slack/stream-processor.ts:889` extracts aggregate `modelUsage` from result message.
- `src/slack/stream-processor.ts:312` separately captures per-turn assistant usage.
- `src/slack/pipeline/stream-executor.ts:1122` prefers `lastTurn*` over aggregate for `current*`.
- Result: hypothesis ruled out for the main session state path. Main path uses per-turn values when available.

### Hypothesis 2: Cache tokens are excluded from context occupancy
- `src/slack/context-window-manager.ts:106` adds `currentCacheReadTokens` and `currentCacheCreateTokens`.
- `src/slack/thread-header-builder.ts:126` uses `computeUsedTokens()`.
- `src/slack/commands/context-handler.ts:40` uses `computeUsedTokens()`.
- Result: hypothesis ruled out for the main display path. Main path includes cache tokens.

### Hypothesis 3: Max context window is hardcoded to 200k
- `src/slack/pipeline/stream-executor.ts:49` defines fallback `200_000`.
- `src/slack/pipeline/stream-executor.ts:60` defines model-family lookup table.
- `src/slack/pipeline/stream-executor.ts:1107` resolves `max(sdkWindow, lookupWindow)`.
- Result: hypothesis ruled out for the main update path. Main path is dynamic, with fallback.

## Trace: Entry to Display

### 1. Entry point for user-visible context output
- `/context` command enters at `src/slack/commands/context-handler.ts:16`.
- It loads the session via `this.deps.claudeHandler.getSession(channel, threadTs)` at `src/slack/commands/context-handler.ts:19`.
- If `session.usage` is missing, it returns an informational message at `src/slack/commands/context-handler.ts:29`.
- If usage exists, it computes:
  - current used tokens via `ContextWindowManager.computeUsedTokens(usage)` at `src/slack/commands/context-handler.ts:40`
  - max window via `usage.contextWindow` at `src/slack/commands/context-handler.ts:41`
  - remaining percent via `ContextWindowManager.computeRemainingPercent(usage)` at `src/slack/commands/context-handler.ts:42`

### 2. Single source of truth for occupancy and remaining percent
- `src/slack/context-window-manager.ts:87` computes remaining percent as:
  - `((contextWindow - usedTokens) / contextWindow) * 100`
- `src/slack/context-window-manager.ts:106` computes used tokens as:
  - `currentInputTokens + currentCacheReadTokens + currentCacheCreateTokens + currentOutputTokens`
- This is the authoritative implementation for the main context UI path.

### 3. Where `session.usage` gets updated
- `StreamExecutor` wires the usage callback at `src/slack/pipeline/stream-executor.ts:391`.
- When `StreamProcessor` emits usage, `this.updateSessionUsage(session, usage)` runs at `src/slack/pipeline/stream-executor.ts:392`.
- After update, remaining percent is recalculated and used to update the thread emoji at `src/slack/pipeline/stream-executor.ts:395`.

### 4. How usage is extracted from the SDK stream
- `StreamProcessor.process()` iterates SDK messages at `src/slack/stream-processor.ts:242`.
- Assistant messages go through `handleAssistantMessage()` at `src/slack/stream-processor.ts:305`.
- Result messages go through `handleResultMessage()` at `src/slack/stream-processor.ts:860`.

### 5. Per-turn usage capture from assistant messages
- In `handleAssistantMessage()`, the code reads `message.message.usage` at `src/slack/stream-processor.ts:314`.
- It stores per-turn values into `_lastAssistantTurnUsage` at `src/slack/stream-processor.ts:316`.
- Captured fields:
  - `input_tokens`
  - `output_tokens`
  - `cache_read_input_tokens`
  - `cache_creation_input_tokens`

### 6. Aggregate usage capture from result messages
- In `handleResultMessage()`, result usage is extracted at `src/slack/stream-processor.ts:872`.
- `extractUsageData()` first checks `message.modelUsage` at `src/slack/stream-processor.ts:891`.
- If present, `aggregateModelUsage()` sums billing totals across models at `src/slack/stream-processor.ts:939`.
- If not present, it falls back to `message.usage` at `src/slack/stream-processor.ts:901`.
- Aggregate usage contains:
  - `inputTokens`
  - `outputTokens`
  - `cacheReadInputTokens`
  - `cacheCreationInputTokens`
  - `totalCostUsd`
  - optional `contextWindow`
  - optional `modelName`

### 7. Merge step: per-turn usage is attached back onto aggregate usage
- After stream iteration completes, `process()` merges `_lastAssistantTurnUsage` into the final `UsageData` at `src/slack/stream-processor.ts:271`.
- This produces a combined payload:
  - aggregate totals for billing
  - per-turn `lastTurn*` fields for context occupancy

### 8. Session state normalization in `updateSessionUsage()`
- Initialization happens at `src/slack/pipeline/stream-executor.ts:1082`.
- Max context window resolution happens at `src/slack/pipeline/stream-executor.ts:1104`:
  - `sdkWindow = usage.contextWindow || 0`
  - `lookupWindow = resolveContextWindow(modelName)`
  - `resolved = Math.max(sdkWindow, lookupWindow)`
- Current occupancy fields are selected at `src/slack/pipeline/stream-executor.ts:1122`:
  - if `lastTurnInputTokens !== undefined`, use `lastTurn*`
  - else fall back to aggregate fields
- Billing totals are accumulated separately at `src/slack/pipeline/stream-executor.ts:1128`.

## Derived Algorithm Spec

### A. Max context window
1. Start with `FALLBACK_CONTEXT_WINDOW = 200_000` from `src/slack/pipeline/stream-executor.ts:49`.
2. Resolve model lookup using `MODEL_CONTEXT_WINDOWS` in `src/slack/pipeline/stream-executor.ts:60`.
3. Compute:
   - `sdkWindow = usage.contextWindow > 0 ? usage.contextWindow : 0`
   - `lookupWindow = resolveContextWindow(usage.modelName || session.model)`
   - `contextWindow = max(sdkWindow, lookupWindow)`
4. Persist to `session.usage.contextWindow`.

### B. Current context occupancy
1. Prefer the latest assistant turn's usage:
   - `lastTurnInputTokens`
   - `lastTurnOutputTokens`
   - `lastTurnCacheReadTokens`
   - `lastTurnCacheCreateTokens`
2. If those do not exist, fall back to aggregate result usage.
3. Compute:
   - `usedTokens = currentInputTokens + currentCacheReadTokens + currentCacheCreateTokens + currentOutputTokens`

### C. Remaining percent
1. Compute `usedTokens` from section B.
2. Compute:
   - `remainingPercent = ((contextWindow - usedTokens) / contextWindow) * 100`
3. Clamp to `[0, 100]`.

### D. Billing totals
- `totalInputTokens += usage.inputTokens`
- `totalOutputTokens += usage.outputTokens`
- `totalCostUsd += usage.totalCostUsd`
- These totals are not used for current context occupancy.

## Verified Invariants from Tests

### Current context overwrites, does not accumulate
- `src/slack/pipeline/session-usage.test.ts:114` verifies current usage is overwritten per turn.
- `src/slack/commands/context-handler.test.ts:54` verifies `/context` shows `2800`, not cumulative `4300`.

### Cache tokens must be included
- `src/slack/pipeline/session-usage.test.ts:353` verifies `3 + 117500 + 5800 + 626 = 123929`.
- Old `input + output` only calculation is explicitly marked wrong at `src/slack/pipeline/session-usage.test.ts:379`.

### Per-turn beats aggregate for actual occupancy
- `src/slack/pipeline/session-usage.test.ts:384` verifies agent-loop aggregate overcount is avoided by using `lastTurn*`.

### Dynamic max window is preserved
- `src/slack/pipeline/session-usage.test.ts:232` verifies SDK-reported `1_000_000`.
- `src/slack/pipeline/session-usage.test.ts:271` verifies model lookup preserves `1M` across later turns.
- `src/slack/pipeline/session-usage.test.ts:316` verifies `max(200k SDK, 1M lookup) = 1M`.
- `src/slack/pipeline/session-usage.test.ts:334` verifies future larger SDK values win over lookup.

## Branch Audit: Main Path vs Drift

### Main path aligned with source of truth
- `src/slack/commands/context-handler.ts:40`
- `src/slack/thread-header-builder.ts:126`
- `src/slack/thread-surface.ts:595`
- `src/slack/actions/action-panel-action-handler.ts:380`
- `src/slack/actions/session-action-handler.ts:366`

### Drifted branches still doing inline math
- `src/slack/commands/session-command-handler.ts:101`
  - Uses `currentInputTokens + currentOutputTokens`
  - Excludes cache tokens
  - Does not use `ContextWindowManager.computeUsedTokens()`
- `src/slack/pipeline/stream-executor.ts:931`
  - `getCurrentContextUsagePercent()` uses `currentInputTokens + currentOutputTokens`
  - Excludes cache tokens
- `src/slack/pipeline/stream-executor.ts:941`
  - `getContextUsagePercentFromResult()` uses `usage.inputTokens + usage.outputTokens`
  - Excludes cache tokens and uses aggregate result usage

## Notes
- `src/slack/stream-processor.ts:924` contains an outdated comment saying per-turn interception would be a future improvement.
- Actual per-turn interception is already implemented at:
  - `src/slack/stream-processor.ts:312`
  - `src/slack/stream-processor.ts:271`

## Conclusion
- The intended implementation is correct on the main path:
  - dynamic max window
  - per-turn current occupancy
  - cache-inclusive used token calculation
  - aggregate totals separated for billing
- The main implementation spec should treat `ContextWindowManager.computeUsedTokens()` and `computeRemainingPercent()` as the source of truth.
- Any other surface that reimplements `input + output` inline is a drift from the intended spec.
