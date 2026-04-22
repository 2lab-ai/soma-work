# Spec: Add [1m] variants for opus-4-6 / opus-4-7 (keep existing 6 intact)

**Issue**: [#656](https://github.com/2lab-ai/soma-work/issues/656)
**Supersedes**: [#648](https://github.com/2lab-ai/soma-work/issues/648), abandoned PR [#652](https://github.com/2lab-ai/soma-work/pull/652) (closed due to scope error — silently shrank allow-list 6→4)
**Base commit**: `main @ ac8b125`

---

## Why

bypass-mode / power users want 1M-context window on the top two models (`opus-4-7`, `opus-4-6`) without losing access to the existing lineup (Sonnet 4.6/4.5, Haiku 4.5, Opus 4.5). PR #652 correctly moved to suffix-based context-window resolution via a `[1m]` convention, but incorrectly shrank the allow-list from 6 to 4. This spec re-scopes to purely additive (6 → 8) and preserves the 8 orthogonal technical wins from #652.

## Scope — Additive Only

### MUST KEEP (6 existing entries unchanged)
```ts
'claude-opus-4-7',
'claude-opus-4-6',
'claude-sonnet-4-6',
'claude-sonnet-4-5-20250929',
'claude-opus-4-5-20251101',
'claude-haiku-4-5-20251001',
```

### MUST ADD (2 new [1m] variants)
```ts
'claude-opus-4-7[1m]',
'claude-opus-4-6[1m]',
```

→ `AVAILABLE_MODELS.length === 8`

### Non-goals

- Do **not** shrink `AVAILABLE_MODELS`
- Do **not** drop `sonnet-*`, `haiku-*`, `opus-4-5-*` from any allow-list
- Do **not** re-introduce manual `context-1m-2025-08-07` beta-header injection (SDK ≥ 0.2.111 handles natively)

---

## Architecture Decisions

### D1: `[1m]` suffix as the single 1M-context indicator
- Suffix syntax: `{baseModelId}[1m]`
- `resolveContextWindow(modelName)` → `endsWith('[1m]')` ? `1_000_000` : `200_000`
- Claude Agent SDK ≥ 0.2.111 detects `/\[1m\]/i`, strips it before the API call, and injects `context-1m-2025-08-07` beta uniformly across API-key and OAuth.
- **No runtime beta-header injection needed** — `buildBetaHeaders` deleted.

### D2: Shared helpers in `metrics/model-registry.ts`
```ts
export const ONE_M_SUFFIX_RE = /\[1m\]$/i;
export function hasOneMSuffix(model: string): boolean;
export function stripOneMSuffix(model: string): string;
```
Consumers: `thread-header-builder.ts`, `model-topic.ts`, `resolveContextWindow`.

### D3: `coerceToAvailableModel` helper in `user-settings-store.ts`
- **Trim + lowercase** before allow-list lookup (handles hand-edited `user-settings.json` with stray whitespace or uppercase).
- Known entries → passthrough (including `claude-opus-4-5-*`, `claude-sonnet-*`, `claude-haiku-*`).
- Unknown → `DEFAULT_MODEL` fallback.
- Called by:
  - `session-registry.ts` (legacy session restore at `:1585`, `:1655`)
  - `deploy/main-env-bootstrap.ts:normalizeMainTargetData` (persisted `user-settings.json` + `sessions.json`)
  - `user-settings-store.loadSettings` (in-process normalization)

**Deliberate difference from #652**: `claude-opus-4-5-20251101` is a **KEEP**, not a retired special-case. The pre-#652 hard-force-to-DEFAULT is removed; the value is a valid allow-list member.

### D4: Bootstrap case-insensitive coerce
- `main-env-bootstrap.ts:coerceModel` **trims + lowercases** the raw value before allow-list lookup.
- `claude-opus-4-7[1M]` (user typo uppercase M) → round-trips to `claude-opus-4-7[1m]` instead of silently dropping to `DEFAULT_MODEL`.
- Bootstrap keeps its own `VALID_MODELS` Set (import-lean constraint — runs before process init), guarded by an **exact set equality** drift test against `AVAILABLE_MODELS` in `main-env-bootstrap.test.ts`.

### D5: `FEATURED_ALIASES` (model-topic.ts)
- New: `['sonnet', 'opus', 'opus[1m]', 'haiku']`.
- Keeps `sonnet` and `haiku` as primary buttons.
- Adds `opus[1m]` fourth button.

### D6: `MODEL_ALIASES` (user-settings-store.ts)
- Keep **all 9 existing keys**: `sonnet`, `sonnet-4.6`, `sonnet-4.5`, `opus`, `opus-4.7`, `opus-4.6`, `opus-4.5`, `haiku`, `haiku-4.5`.
- Add **3 new keys**: `opus[1m] → claude-opus-4-7[1m]`, `opus-4.7[1m] → claude-opus-4-7[1m]`, `opus-4.6[1m] → claude-opus-4-6[1m]`.

### D7: `stream-executor.ts` model-name precedence flip
- Current (`:2192`): `const modelName = usage.modelName || session.model;`
- New: `const modelName = session.model ?? usage.modelName;`
- Reason: SDK strips `[1m]` before reporting `usage.modelName`; session value (user-selected `[1m]`) must win so context-window resolution sees the suffix.

### D8: `thread-header-builder.formatModelName` `[1m]` awareness
- If `ONE_M_SUFFIX_RE.test(model)` → strip suffix → format base → append `" (1M)"`.
- `claude-opus-4-7[1m]` → `opus-4.7 (1M)`.

### D9: `getModelDisplayName` coverage
- Switch/map covers all **8** entries (not 4 as in #652).
- `[1m]` cases can append `" (1M)"` to the base label either explicitly or via shared helper.

---

## SDK Version Gate

Before deleting `buildBetaHeaders`, verify (one-time precondition):
- `package.json:38` → `@anthropic-ai/claude-agent-sdk ^0.2.111` ✅ (confirmed present on main)
- `package-lock.json` → resolved version ≥ 0.2.111

If the resolved lock version is < 0.2.111, **abort the delete** and bump the SDK in the same PR.

## Files Touched

### Production (8)
| File | Change |
|------|--------|
| `src/metrics/model-registry.ts` | Add `ONE_M_SUFFIX_RE`/`hasOneMSuffix`/`stripOneMSuffix`; rewrite `resolveContextWindow` to suffix-based |
| `src/user-settings-store.ts` | Expand `AVAILABLE_MODELS` 6→8; expand `MODEL_ALIASES` +3 keys; extract + export `coerceToAvailableModel`; expand `getModelDisplayName` switch to 8; remove retired-model hard-force (opus-4-5 is valid) |
| `src/claude-handler.ts` | Delete `buildBetaHeaders` function + call site |
| `src/deploy/main-env-bootstrap.ts` | Expand `VALID_MODELS` 6→8; add **bootstrap-local** `coerceModel` (trim + lowercase — cannot import user-settings-store due to import-lean constraint); drop retired-opus-4-5 special case |
| `src/slack/z/topics/model-topic.ts` | `FEATURED_ALIASES = ['sonnet', 'opus', 'opus[1m]', 'haiku']` |
| `src/slack/thread-header-builder.ts` | `formatModelName`: detect `[1m]` → strip → format → append `" (1M)"` |
| `src/slack/pipeline/stream-executor.ts` | Line ~2192: flip precedence to `session.model ?? usage.modelName` |
| `src/session-registry.ts` | Apply `coerceToAvailableModel` at deserialize paths (`:1585`, `:1655`) |

### Tests (9)
| File | Change |
|------|--------|
| `src/claude-handler.test.ts` | Delete all `buildBetaHeaders` tests (8 assertions) |
| `src/metrics/model-registry.test.ts` | Add tests for `resolveContextWindow` suffix rule, `hasOneMSuffix`, `stripOneMSuffix` |
| `src/user-settings-store.test.ts` | Add `coerceToAvailableModel` tests; update `AVAILABLE_MODELS.length === 8` assertions |
| `src/deploy/main-env-bootstrap.test.ts` | Update drift guard for 8 entries; add `[1M]` uppercase round-trip test |
| `src/slack/z/topics/model-topic.test.ts` | Update for 4 featured aliases including `opus[1m]` |
| `src/slack/thread-header-builder.test.ts` | Add `formatModelName('claude-opus-4-7[1m]') === 'opus-4.7 (1M)'` test |
| `src/slack/pipeline/session-usage.test.ts` | Sync local `MODEL_CONTEXT_WINDOWS` table — adopt suffix rule; add `opus-4-7` entry |
| `src/slack/pipeline/session-initializer-{midthread,onboarding}.test.ts` | Fix drifted mocked `AVAILABLE_MODELS` (missing `sonnet-4-6`) — update to 8 entries |
| `src/session-registry.test.ts` | Add legacy-session coerce round-trip tests |

---

## Acceptance Criteria (from Issue #656)

- [ ] `AVAILABLE_MODELS.length === 8`
- [ ] `MODEL_ALIASES` retains all 9 pre-existing keys + 3 new `[1m]` keys (12 total)
- [ ] `FEATURED_ALIASES = ['sonnet', 'opus', 'opus[1m]', 'haiku']`
- [ ] `VALID_MODELS` has all 8 entries
- [ ] `getModelDisplayName` non-empty for every entry (8/8)
- [ ] `resolveContextWindow('claude-opus-4-7[1m]') === 1_000_000`
- [ ] `resolveContextWindow('claude-opus-4-7') === 200_000`
- [ ] `resolveContextWindow('claude-sonnet-4-6') === 200_000`
- [ ] `buildBetaHeaders` removed from code + tests
- [ ] Slack `/z model` selecting `opus[1m]` persists `claude-opus-4-7[1m]`; thread header shows `opus-4.7 (1M)`
- [ ] Known legacy models (`claude-sonnet-4-6`, etc.) passthrough; only unknown → `DEFAULT_MODEL`
- [ ] `npm run build` clean
- [ ] `npm test` matches pre-existing baseline (36 EPERM sandbox failures are known/unrelated)

---

## Decision Gate — Auto-decided

| Item | Decision | Switching cost | Rationale |
|------|----------|----------------|-----------|
| Featured aliases order | `['sonnet', 'opus', 'opus[1m]', 'haiku']` | tiny | Matches issue proposal verbatim |
| Retired `claude-opus-4-5-20251101` treatment | KEEP as valid allow-list entry (not retired) | tiny | Issue §Scope explicitly lists it under "MUST KEEP" |
| `[1m]` display label format | `" (1M)"` appended | tiny | Matches issue Acceptance §7 |
| Helpers location | `metrics/model-registry.ts` | small | Single module already owns resolveContextWindow |
| `coerceToAvailableModel` export location | `user-settings-store.ts` | small | Store already owns `AVAILABLE_MODELS` + `DEFAULT_MODEL` |

No items require user escalation — all decisions derive directly from issue body.
