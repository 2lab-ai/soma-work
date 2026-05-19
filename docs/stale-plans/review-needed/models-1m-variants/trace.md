# Trace: Add [1m] variants for opus-4-6 / opus-4-7

Spec: `./spec.md` · Issue: #656 · Base: `main @ ac8b125`

---

## Implementation Status

| # | Scenario | Size | Status | Files | RED test |
|---|----------|------|--------|-------|----------|
| T1 | Shared `[1m]` helpers in model-registry | tiny | Ready | `src/metrics/model-registry.ts` | `model-registry.test.ts` suffix cases |
| T2 | Suffix-based `resolveContextWindow` | tiny | Ready | `src/metrics/model-registry.ts` | `model-registry.test.ts` `[1m] → 1M, bare → 200k` |
| T3 | Expand `AVAILABLE_MODELS` 6→8 + `MODEL_ALIASES` +3 + `getModelDisplayName` 8-case + extract `coerceToAvailableModel` | small | Ready | `src/user-settings-store.ts` | `user-settings-store.test.ts` length + alias + coerce tests |
| T4 | Delete `buildBetaHeaders` + call site + tests | tiny | Ready | `src/claude-handler.ts`, `claude-handler.test.ts` | delete-only |
| T5 | Bootstrap: expand `VALID_MODELS` 8, add case-insensitive `coerceModel`, use shared helper, drop retired-opus-4-5 special case | small | Ready | `src/deploy/main-env-bootstrap.ts` | `main-env-bootstrap.test.ts` drift guard + `[1M]` round-trip |
| T6 | `FEATURED_ALIASES = ['sonnet','opus','opus[1m]','haiku']` | tiny | Ready | `src/slack/z/topics/model-topic.ts` | `model-topic.test.ts` featured list + description |
| T7 | `thread-header-builder.formatModelName` `[1m]` → `" (1M)"` | tiny | Ready | `src/slack/thread-header-builder.ts` | `thread-header-builder.test.ts` `[1m]` case |
| T8 | `stream-executor.ts:2192` precedence flip `session.model ?? usage.modelName` | tiny | Ready | `src/slack/pipeline/stream-executor.ts` | `session-usage.test.ts` — session `[1m]` wins over SDK-stripped |
| T9 | `session-registry.ts` apply `coerceToAvailableModel` at deserialize (`:1585`, `:1655`) | tiny | Ready | `src/session-registry.ts` | `session-registry.test.ts` legacy-session round-trip |
| T10 | Fix test drifts: `session-usage.test.ts` local table + `session-initializer-{midthread,onboarding}.test.ts` mocked AVAILABLE_MODELS | small | Ready | test files | — |

---

## Per-scenario Call Stacks

### T1. Shared `[1m]` helpers
**Trigger**: Any code that needs to detect/strip the 1M-context suffix.
**Added to `src/metrics/model-registry.ts`**:
```ts
export const ONE_M_SUFFIX_RE = /\[1m\]$/i;
export function hasOneMSuffix(model: string): boolean {
  return ONE_M_SUFFIX_RE.test(model);
}
export function stripOneMSuffix(model: string): string {
  return model.replace(ONE_M_SUFFIX_RE, '');
}
```
**Consumers** (call order):
1. `thread-header-builder.ts:formatModelName` (T7) — strips before base format, appends `" (1M)"`
2. `resolveContextWindow` (T2) — suffix-rule context-window selection
3. `model-topic.ts` (T6) — **not** a direct consumer of the helpers themselves; it only consumes the string `'opus[1m]'` as a featured alias key and delegates display to `userSettingsStore.getModelDisplayName` (which internally handles the `[1m]` label)

---

### T2. `resolveContextWindow` suffix rule
**Trigger**: `stream-executor.updateSessionUsage` (`:2193`) on every usage update; `session-registry` context-bar math.
**Rewrite**:
```ts
export function resolveContextWindow(modelName?: string): number {
  if (!modelName) return FALLBACK_CONTEXT_WINDOW;
  return hasOneMSuffix(modelName) ? 1_000_000 : FALLBACK_CONTEXT_WINDOW;
}
```
- `FALLBACK_CONTEXT_WINDOW = 200_000` (unchanged)
- `MODEL_REGISTRY.contextWindow` fields become informational (spec notes they drop to 200k per #652 T2). Leave as-is for data-sheet purposes; runtime no longer reads them.

**Call sites that already consume it** (unchanged):
- `src/slack/pipeline/stream-executor.ts:2193` (T8 flips the model-name source)
- No other production call sites in main.

---

### T3. Allow-list + aliases + display + coerce
**Changes in `src/user-settings-store.ts`**:
1. `AVAILABLE_MODELS` (:11–18) expand to 8 entries.
2. `MODEL_ALIASES` (:23–33) add 3 keys.
3. `getModelDisplayName` (:713–730) expand switch to 8 cases; `[1m]` cases append `" (1M)"` (via `stripOneMSuffix` + base lookup, or explicit).
4. Extract `coerceToAvailableModel(raw: string | null | undefined): ModelId`:
   ```ts
   export function coerceToAvailableModel(raw: string | null | undefined): ModelId {
     if (typeof raw !== 'string') return DEFAULT_MODEL;
     const normalized = raw.trim().toLowerCase();
     if (normalized.length === 0) return DEFAULT_MODEL;
     if ((AVAILABLE_MODELS as readonly string[]).includes(normalized)) return normalized as ModelId;
     return DEFAULT_MODEL;
   }
   ```
   **Trim + lowercase** — handles hand-edited JSON with stray whitespace or uppercase `[1M]`.
5. `loadSettings` (:217–226) replace inline normalization with `coerceToAvailableModel`. **Remove** the `=== 'claude-opus-4-5-20251101'` hard-force (opus-4-5 is now valid).

**Call stack (user-settings load)**:
```
UserSettingsStore.loadSettings()
  └─ for each userSettings
      └─ userSettings.defaultModel = coerceToAvailableModel(userSettings.defaultModel)
```

---

### T4. Delete `buildBetaHeaders`
**Changes**:
1. `src/claude-handler.ts:94–111` — delete function.
2. `src/claude-handler.ts:1087–1094` — delete call block.
3. `src/claude-handler.test.ts:2, 32–67` — delete import + all 8 assertions.

**Justification**: SDK ≥ 0.2.111 handles `[1m]` stripping + beta injection natively.

**Call stack (before)**:
```
ClaudeHandler.query(options)
  └─ buildBetaHeaders(options.model, hasApiKey)
      └─ returns ['context-1m-2025-08-07'] or undefined
  └─ options.betas = betas (if any)
```
**After**: model string passes through to SDK `query()` unchanged; SDK detects `[1m]` and injects beta itself.

---

### T5. Bootstrap
**Changes in `src/deploy/main-env-bootstrap.ts`**:
1. `VALID_MODELS` (:8–15) → 8 entries (same as `AVAILABLE_MODELS`).
2. Add `coerceModel`:
   ```ts
   function coerceModel(raw: unknown): string {
     if (typeof raw !== 'string') return DEFAULT_MODEL;
     const normalized = raw.trim().toLowerCase();
     if (normalized.length === 0) return DEFAULT_MODEL;
     return VALID_MODELS.has(normalized) ? normalized : DEFAULT_MODEL;
   }
   ```
   **Trim + lowercase**. Local to bootstrap (cannot import from user-settings-store — import-lean constraint).
3. `normalizeMainTargetData` (:109–117) — replace inline check with `coerceModel`. Drop the `=== 'claude-opus-4-5-20251101'` force-reset.
4. Apply `coerceModel` to `sessions.json` entries too:
   ```ts
   for (const session of sessions) {
     if (typeof session.model === 'string') {
       session.model = coerceModel(session.model);
     }
     // existing ownerId/state/workflow logic...
   }
   ```

**Why bootstrap has its own copy of the list**: bootstrap is import-lean (runs before the main process). Drift is guarded by `main-env-bootstrap.test.ts` with an **exact-set equality** assertion:
```ts
import { AVAILABLE_MODELS } from '../user-settings-store';
it('VALID_MODELS equals AVAILABLE_MODELS exactly', () => {
  expect(Array.from(VALID_MODELS_FOR_TEST).sort()).toEqual([...AVAILABLE_MODELS].sort());
});
```
Where `VALID_MODELS_FOR_TEST` is exposed via a `__TEST_ONLY` export from bootstrap, OR we re-export `VALID_MODELS` and rely on this test living in the same test file that already imports from user-settings-store.

---

### T6. Featured aliases
**Change in `src/slack/z/topics/model-topic.ts:10`**:
```ts
const FEATURED_ALIASES = ['sonnet', 'opus', 'opus[1m]', 'haiku'] as const;
```
`renderModelCard` iterates this for the top row of buttons. `MODEL_ALIASES['opus[1m]']` must resolve to `claude-opus-4-7[1m]` (set in T3).

---

### T7. Thread header
**Change in `src/slack/thread-header-builder.ts:310–320`**:
```ts
static formatModelName(model: string): string {
  const has1m = hasOneMSuffix(model);
  const base = has1m ? stripOneMSuffix(model) : model;
  const m = base.match(/claude-(\w+)-(\d+)-(\d+)/);
  const formatted = m ? `${m[1]}-${m[2]}.${m[3]}` : base.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return has1m ? `${formatted} (1M)` : formatted;
}
```
**Trigger**: `buildHeader` (:131, :201) — whenever a thread header is rendered for a session.

---

### T8. Stream-executor precedence flip
**Change in `src/slack/pipeline/stream-executor.ts:2192`**:
```ts
// Was: const modelName = usage.modelName || session.model;
const modelName = session.model ?? usage.modelName;
```
**Call stack**:
```
ClaudeHandler streaming callback
  └─ stream-executor.updateSessionUsage(session, usage)
      └─ const modelName = session.model ?? usage.modelName
      └─ resolveContextWindow(modelName)
      └─ session.usage.contextWindow = Math.max(sdk, lookup)
```
**Why**: SDK strips `[1m]` before reporting `usage.modelName`. Session value carries user intent (with suffix).

---

### T9. Session-registry coerce on deserialize
**Change in `src/session-registry.ts`** at:
- `:1585` (archive restore) → `model: coerceToAvailableModel(serialized.model)`
- `:1655` (active session restore) → `model: coerceToAvailableModel(serialized.model)`

**Call stack**:
```
SessionRegistry.load()
  └─ parses sessions.json
  └─ for each serialized
      └─ ConversationSession.fromSerialized({..., model: coerceToAvailableModel(serialized.model), ...})
```
**Behavior**: Known entries (including legacy but-still-valid `claude-sonnet-4-6`) passthrough. Unknown → `DEFAULT_MODEL`.

---

### T10. Test drift fixes
1. `src/slack/pipeline/session-usage.test.ts:30–38` local `MODEL_CONTEXT_WINDOWS`:
   - Replace with suffix-rule implementation: `model.endsWith('[1m]') ? 1_000_000 : 200_000`.
   - OR add `opus-4-7` entry and align with new bare=200k default.
   - Decision: **adopt suffix rule** (matches production).

2. `src/slack/pipeline/session-initializer-midthread.test.ts:35–41` and `session-initializer-onboarding.test.ts:35–41`:
   - Current mocked `AVAILABLE_MODELS` omits `claude-sonnet-4-6`.
   - Update to full 8-entry list to match production.

---

## RED Tests (to write first)

**Regression-first philosophy**: every test that PR #652 would have failed is explicit here, using **exact-set** assertions — not length-only — so silent removals cannot slip through again.

### Exact-set regression guards (the #652 killshot)

| RED test | Assertion | Purpose |
|----------|-----------|---------|
| `user-settings-store.test.ts: AVAILABLE_MODELS is exactly 8 entries in order` | Deep equals against hardcoded expected array `['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-opus-4-7[1m]', 'claude-opus-4-6[1m]']` | Catches any silent removal or reordering (the #652 failure mode) |
| `user-settings-store.test.ts: MODEL_ALIASES has exactly 12 keys with exact mapping` | Deep equals against full expected `Record<string, ModelId>` with all 9 pre-existing + 3 new `[1m]` keys | Prevents dropped aliases like sonnet/haiku |
| `main-env-bootstrap.test.ts: VALID_MODELS === new Set(AVAILABLE_MODELS)` | Exact set equality via `Array.from(VALID_MODELS).sort()` vs sorted `AVAILABLE_MODELS` | Hard-enforces drift between duplicate allow-lists |
| `user-settings-store.test.ts: getModelDisplayName returns non-empty for every AVAILABLE_MODELS entry` | Parameterized `it.each(AVAILABLE_MODELS)` — asserts result is non-empty string ≠ the raw modelId | Catches switch statement shrinkage |

### New-feature tests

| RED test | Assertion | Will fail on main |
|----------|-----------|-------------------|
| `model-registry.test.ts: hasOneMSuffix('claude-opus-4-7[1m]') === true` | suffix detection | Y (helpers don't exist) |
| `model-registry.test.ts: hasOneMSuffix('claude-opus-4-7') === false` | negative case | Y |
| `model-registry.test.ts: hasOneMSuffix('claude-opus-4-7[1M]') === true` | case-insensitive | Y |
| `model-registry.test.ts: stripOneMSuffix('claude-opus-4-7[1m]') === 'claude-opus-4-7'` | strip correctness | Y |
| `model-registry.test.ts: resolveContextWindow('claude-opus-4-7[1m]') === 1_000_000` | 1M path | Y (currently registry returns 1M for bare too — wrong) |
| `model-registry.test.ts: resolveContextWindow('claude-opus-4-6[1m]') === 1_000_000` | 1M path #2 | Y |
| `model-registry.test.ts: resolveContextWindow('claude-opus-4-7') === 200_000` | bare → 200k | Y (currently 1M) |
| `model-registry.test.ts: resolveContextWindow('claude-sonnet-4-6') === 200_000` | **explicit sonnet-4-6 SSOT check** | Y (currently 1M) |
| `model-registry.test.ts: resolveContextWindow('claude-haiku-4-5-20251001') === 200_000` | haiku | N (already 200k) — sanity lock |
| `model-registry.test.ts: resolveContextWindow(undefined) === FALLBACK_CONTEXT_WINDOW` | fallback | N — sanity lock |
| `user-settings-store.test.ts: MODEL_ALIASES['opus[1m]'] === 'claude-opus-4-7[1m]'` | alias | Y |
| `user-settings-store.test.ts: MODEL_ALIASES['opus-4.7[1m]'] === 'claude-opus-4-7[1m]'` | alias | Y |
| `user-settings-store.test.ts: MODEL_ALIASES['opus-4.6[1m]'] === 'claude-opus-4-6[1m]'` | alias | Y |
| `user-settings-store.test.ts: MODEL_ALIASES['sonnet'] === 'claude-sonnet-4-6'` | **existing sonnet alias preserved** | N — regression lock |
| `user-settings-store.test.ts: MODEL_ALIASES['haiku'] === 'claude-haiku-4-5-20251001'` | **existing haiku alias preserved** | N — regression lock |
| `user-settings-store.test.ts: coerceToAvailableModel('claude-opus-4-7[1M]') === 'claude-opus-4-7[1m]'` | case-insensitive | Y |
| `user-settings-store.test.ts: coerceToAvailableModel('  claude-sonnet-4-6  ') === 'claude-sonnet-4-6'` | **trim + passthrough** | Y |
| `user-settings-store.test.ts: coerceToAvailableModel('bogus-model') === DEFAULT_MODEL` | unknown→fallback | Y |
| `user-settings-store.test.ts: coerceToAvailableModel('claude-opus-4-5-20251101') === 'claude-opus-4-5-20251101'` | **opus-4-5 passthrough (NOT retired)** | Y (currently forced to DEFAULT in loadSettings) |
| `user-settings-store.test.ts: coerceToAvailableModel(null) === DEFAULT_MODEL` | null safety | Y |
| `user-settings-store.test.ts: coerceToAvailableModel('') === DEFAULT_MODEL` | empty safety | Y |
| `main-env-bootstrap.test.ts: normalizeMainTargetData round-trips 'claude-opus-4-7[1M]' → 'claude-opus-4-7[1m]'` | case-insensitive round-trip | Y |
| `main-env-bootstrap.test.ts: normalizeMainTargetData preserves all 8 entries in user-settings.json` | parameterized over `AVAILABLE_MODELS` | Y |
| `main-env-bootstrap.test.ts: normalizeMainTargetData normalizes sessions.json session.model too` | coerce on sessions | Y |
| `main-env-bootstrap.test.ts: coerceModel('  claude-sonnet-4-6  ') === 'claude-sonnet-4-6'` | **bootstrap trim round-trip** (mirrors user-settings trim test) | Y |
| `main-env-bootstrap.test.ts: coerceModel('  claude-opus-4-7[1M]  ') === 'claude-opus-4-7[1m]'` | trim + case round-trip | Y |
| `main-env-bootstrap.test.ts: package-lock.json resolves '@anthropic-ai/claude-agent-sdk' >= 0.2.111` | **lockfile SDK gate** (not just package.json declaration) | N — lock (read `package-lock.json`, assert resolved `version` satisfies semver ≥ 0.2.111) |
| `thread-header-builder.test.ts: formatModelName('claude-opus-4-7[1m]') === 'opus-4.7 (1M)'` | (1M) marker | Y |
| `thread-header-builder.test.ts: formatModelName('claude-opus-4-6[1m]') === 'opus-4.6 (1M)'` | (1M) marker #2 | Y |
| `thread-header-builder.test.ts: formatModelName('claude-sonnet-4-6') === 'sonnet-4.6'` | bare passthrough | N — lock |
| `thread-header-builder.test.ts: formatModelName('claude-haiku-4-5-20251001') === 'haiku-4.5'` | bare passthrough | N — lock |
| `model-topic.test.ts: FEATURED_ALIASES === ['sonnet','opus','opus[1m]','haiku']` | **exact array check** | Y |
| `model-topic.test.ts: renderModelCard() options include a button labeled 'opus[1m]' with description 'Opus 4.7 (1M)'` | UI wiring | Y |
| `model-topic.test.ts: applyModel('opus[1m]') persists 'claude-opus-4-7[1m]'` | **alias → persistence integration** | Y |
| `session-usage.test.ts: given session.model='claude-opus-4-7[1m]' and usage.modelName='claude-opus-4-7', resulting contextWindow === 1_000_000` | precedence flip + suffix rule (**end-to-end session-level**) | Y |
| `session-registry.test.ts: deserialized unknown model → DEFAULT_MODEL` | coerce | Y |
| `session-registry.test.ts: deserialized 'claude-sonnet-4-6' → 'claude-sonnet-4-6' passthrough` | known-legacy passthrough via coerce helper | verifies coerce path lands (currently passthrough is verbatim) |
| `session-registry.test.ts: deserialized 'claude-opus-4-7[1M]' → 'claude-opus-4-7[1m]' (case round-trip)` | case-insensitive session restore | Y |
| `claude-handler.test.ts` | **buildBetaHeaders import + all 8 tests DELETED** (not moved) | Y — verifies removal |
| `package.json: '@anthropic-ai/claude-agent-sdk' satisfies ^0.2.111` | **SDK precondition guard** (static check OR test file reads package.json) | N — locks the delete-safety assumption |

### Integration / end-to-end Slack flow

**Decision: extend existing `src/slack/z/topics/model-topic.test.ts`** (no new file) — keeps the touched-test count exact at 9. The 6-step flow lands as a single `describe('opus[1m] end-to-end', ...)` block in that file and simulates:

1. User clicks `opus[1m]` featured button.
2. `applyModel('opus[1m]')` resolves via `MODEL_ALIASES['opus[1m]']` → `'claude-opus-4-7[1m]'`.
3. `UserSettingsStore.setUserDefaultModel(userId, 'claude-opus-4-7[1m]')` persists the suffix-bearing id (not stripped).
4. A fresh `ConversationSession` reads `userSettings.defaultModel` as `session.model`.
5. `ThreadHeaderBuilder.buildHeader(session)` produces a header string containing `` `opus-4.7 (1M)` ``.
6. `stream-executor.updateSessionUsage` with a stripped `usage.modelName = 'claude-opus-4-7'` still resolves `contextWindow === 1_000_000` because `session.model` wins.

This single test exercises the exact chain named in the issue Acceptance §7.

---

## Execution Plan

Since this is a coordinated cross-file change, **single PR** (not incremental).

Execution order (stv:work loop):
1. T1+T2 together (registry helpers + resolveContextWindow rewrite)
2. T3 (user-settings-store: allow-list + aliases + display + coerce helper)
3. T4 (delete buildBetaHeaders + tests)
4. T5 (bootstrap)
5. T6 (model-topic featured)
6. T7 (thread-header formatModelName)
7. T8 (stream-executor precedence flip)
8. T9 (session-registry coerce)
9. T10 (test drift fixes)
10. Build + test verification
11. Commit + push + PR

Each scenario has its RED test landed first where applicable; the implementation flips them to GREEN.

---

## What to carry forward from #652 (confirmed preserved)

1. ✅ T2 — suffix-based `resolveContextWindow`
2. ✅ T4 — delete `buildBetaHeaders`
3. ✅ T3 — `coerceToAvailableModel` helper (but: opus-4-5 is KEEP, not retired)
4. ✅ T5 — bootstrap case-insensitive `coerceModel`
5. ✅ T8 — stream-executor precedence flip
6. ✅ T7 — thread-header `(1M)` marker
7. ✅ T1 — shared helpers in model-registry
8. ✅ T3 — `getModelDisplayName` 8 entries (vs 4 in #652)

---

## What #652 got wrong (explicitly reverted here)

| #652 error | Our correction |
|-----------|----------------|
| Shrank `AVAILABLE_MODELS` 6→4 (dropped sonnet-4-6, sonnet-4-5, opus-4-5, haiku-4-5) | KEEP all 6, add 2 → 8 |
| Dropped `MODEL_ALIASES` entries `sonnet`, `sonnet-4.6`, `sonnet-4.5`, `haiku`, `haiku-4.5`, `opus-4.5` | KEEP all 9 existing, add 3 `[1m]` |
| `FEATURED_ALIASES = ['opus', 'opus[1m]', 'opus-4.6[1m]']` (no sonnet/haiku) | `['sonnet', 'opus', 'opus[1m]', 'haiku']` |
| Treated `claude-opus-4-5-20251101` as retired → forced to DEFAULT | Treated as valid allow-list entry → passthrough |
| `getModelDisplayName` switch shrunk to 4 cases | Expanded to all 8 cases |
