# Trace — Context Window via `[1m]` Suffix

## Vertical Scenarios

### Scenario 1 — User sets `claude-opus-4-7[1m]` via `/model` command
Call stack:
1. `src/slack/commands/model-handler.ts` receives `/model claude-opus-4-7[1m]`
2. `userSettingsStore.resolveModelInput('claude-opus-4-7[1m]')` → `'claude-opus-4-7[1m]'`  ← **suffix must survive normalize**
3. `userSettingsStore.setUserDefaultModel(userId, 'claude-opus-4-7[1m]')`
4. Persisted to `user-settings.json`
5. On next message, `stream-executor.ts:~1098` reads the stored model → session.model
6. `resolveContextWindow(session.model)` → `1_000_000`
7. `claude-handler.ts` calls `query({ prompt, options: { model: 'claude-opus-4-7[1m]' } })` (no `betas` field)
8. Agent SDK strips suffix + sends `anthropic-beta: context-1m-2025-08-07` internally

RED contract tests:
- `user-settings-store.test.ts`: `resolveModelInput('claude-opus-4-7[1m]')` returns the suffixed form.
- `user-settings-store.test.ts`: load → save → reload preserves `defaultModel: 'claude-opus-4-7[1m]'`.
- `model-registry.test.ts`: `getContextWindow('claude-opus-4-7[1m]') === 1_000_000`.
- `claude-handler.test.ts`: SDK receives `options.model === 'claude-opus-4-7[1m]'` and `options.betas === undefined`.

### Scenario 2 — User keeps bare `claude-opus-4-7` (200k)
1. `resolveModelInput('claude-opus-4-7')` → `'claude-opus-4-7'`
2. `resolveContextWindow('claude-opus-4-7')` → `200_000`
3. `compact-threshold-checker.ts` uses 200k as denominator (was 1M before → triggers compaction sooner, as intended)
4. SDK call: `options.model === 'claude-opus-4-7'`, `options.betas === undefined`

RED tests:
- `model-registry.test.ts`: bare 200k case.
- `session-usage.test.ts:29-35`: table row for bare `claude-opus-4-7` → 200k.
- `compact-threshold-checker.test.ts` (if present): bare model compact threshold uses 200k.

### Scenario 3 — Existing user has `claude-sonnet-4-6` stored (silent reset)
1. Bot starts → `UserSettingsStore.loadSettings()`
2. line 217-226 migration: `!validModels.has('claude-sonnet-4-6')` → reset to `DEFAULT_MODEL`
3. Save file → `defaultModel: 'claude-opus-4-7'`
4. Logger info "Updated user settings model defaults"
5. Next `/z` turn uses Opus 4.7 (200k)

RED tests:
- `user-settings-store.test.ts`: seed a settings.json with `claude-sonnet-4-6`, construct the store, expect `getUserDefaultModel()` → `claude-opus-4-7`.

### Scenario 4 — Deploy-time bootstrap normalizer must mirror
1. Bootstrap runs `normalizeMainTargetData(targetDir)`
2. VALID_MODELS check at :111 — must include all 4 new models (or else `claude-opus-4-7[1m]` gets reset at deploy)
3. File written back with user's `[1m]` preserved

RED tests:
- `main-env-bootstrap.test.ts:258`: iterate `AVAILABLE_MODELS`, assert each survives normalization.

### Scenario 5 — `buildBetaHeaders` removal
1. `claude-handler.ts` no longer imports/exports `buildBetaHeaders`.
2. Block at :1065-1072 is deleted.
3. SDK call `query({ prompt, options })` — `options.betas` is never set by us.

RED tests:
- `claude-handler.test.ts:32-67`: delete the `buildBetaHeaders` describe block entirely. Add regression check: inspect `options` passed into a stub `query` function, assert `options.betas === undefined`.

### Scenario 6 — Alias → suffixed form
1. User types `/model opus[1m]`.
2. `resolveModelInput('opus[1m]')` lowercases/trims → alias lookup → `claude-opus-4-7[1m]`.
3. Stored + used identically to Scenario 1.

RED tests:
- `user-settings-store.test.ts`: `resolveModelInput('opus[1m]')` → `'claude-opus-4-7[1m]'`.
- `resolveModelInput('OPUS-4.6[1M]')` → `'claude-opus-4-6[1m]'` (case-insensitive).

### Scenario 7 — Executor preserves `[1m]` for contextWindow lookup
1. Session starts with `session.model = 'claude-opus-4-7[1m]'`.
2. SDK query runs. Response carries `usage.modelName = 'claude-opus-4-7'` (SDK strips before API) and `usage.contextWindow = 200_000` (SDK reports base window per comment at :2189).
3. `updateSessionUsage` at :2192 computes `modelName = session.model ?? usage.modelName` → `'claude-opus-4-7[1m]'`.
4. `resolveContextWindow('claude-opus-4-7[1m]')` → `1_000_000`.
5. `Math.max(200_000, 1_000_000)` → `1_000_000`.
6. `session.usage.contextWindow = 1_000_000`. Display/compact math correct.

RED tests (in `session-usage.test.ts` or new `stream-executor-context-window.test.ts`):
- Session has `[1m]` model, SDK reports stripped+base → session.usage.contextWindow = 1M.
- Session has bare model, SDK reports matching bare → session.usage.contextWindow = 200k.
- Session.model empty, SDK reports bare → suffix-aware lookup uses SDK name; returns 200k.

### Scenario 8 — `/z` featured-model buttons survive alias shrink
1. `model-topic.renderModelCard` iterates `FEATURED_ALIASES`.
2. Old set `['sonnet','opus','haiku']` — after alias table shrink, only `opus` resolves; buttons collapse to 1.
3. New set `['opus', 'opus[1m]', 'opus-4.6[1m]']` — all 3 resolve; 3 buttons rendered.

RED tests:
- `model-topic.test.ts:31-33` assertions updated to new 3-tuple.
- Snapshot/structure test that `FEATURED_ALIASES` length matches rendered-button count.

### Scenario 9 — Crash-recovered session with stale model
1. Pre-deploy: session saved with `session.model = 'claude-sonnet-4-6'`.
2. Post-deploy: `SessionRegistry.loadSessions()` deserializes and finds model not in `AVAILABLE_MODELS`.
3. Coerces to `DEFAULT_MODEL = 'claude-opus-4-7'`. Logs info.
4. Subsequent turn uses Opus 4.7 (200k) with correct context window math.

RED tests:
- `session-registry.test.ts` (or equivalent): seed serialized session with `model: 'claude-sonnet-4-6'`, load, expect restored `session.model === 'claude-opus-4-7'`.

### Scenario 10 — Deploy bootstrap normalizes sessions.json
1. `normalizeMainTargetData` reads `sessions.json`.
2. For each session, if `session.model` is not in VALID_MODELS, reset to DEFAULT_MODEL.
3. File written back with coerced values.

RED tests:
- `main-env-bootstrap.test.ts`: seed sessions.json with `model: 'claude-sonnet-4-6'`, call normalizer, assert restored model.

## Implementation Status (task list)

| # | Scenario | Files | Size | Status |
|---|----------|-------|------|--------|
| T2 | contextWindow suffix logic | `src/metrics/model-registry.ts` | small | Ready |
| T3 | user-settings-store shrink + aliases + display names | `src/user-settings-store.ts` + test | medium | Ready |
| T4 | claude-handler buildBetaHeaders removal | `src/claude-handler.ts` + test | small | Ready |
| T5 | deploy bootstrap VALID_MODELS mirror + sessions.json normalize | `src/deploy/main-env-bootstrap.ts` + test | small | Ready |
| T6 | executor suffix preservation (Scenario 7) | `src/slack/pipeline/stream-executor.ts` + new test | small | Ready |
| T7 | model-topic FEATURED_ALIASES + display card | `src/slack/z/topics/model-topic.ts` + test | small | Ready |
| T8 | session-registry stale-model coerce (Scenario 9) | `src/session-registry.ts` + test | small | Ready |
| T9 | thread-header-builder `[1m]` formatter branch | `src/slack/thread-header-builder.ts` + test | small | Ready |
| T10 | `session-usage.test.ts` execution-shadow rewrite (resolveContextWindow + updateSessionUsage precedence flip) | `src/slack/pipeline/session-usage.test.ts` :30-91 | small | Ready |
| T10.5 | remaining test fixture alignment | `session-initializer-*.test.ts`, `model-registry.test.ts` assertions | small | Ready |
| T11 | typecheck + unit tests + build green | — | small | Ready |
| T12 | commit + PR + reviewer pass ≥ 95 | — | small | Ready |
