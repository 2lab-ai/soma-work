# Spec — Context Window via `[1m]` Model Suffix

## Proposal / WHY

Current context window calculation uses substring matching on model name (`'opus-4-7'`, `'sonnet-4-6'`, etc.) in `MODEL_REGISTRY` and silently assigns **1M context window** to any model matching those substrings. Reality: bare `claude-opus-4-7` is 200k; only the `[1m]`-suffixed variant requests the 1M context beta. Our local math (compact threshold percent, usage meter, etc.) therefore under-triggers compaction and mis-renders "remaining context".

Claude Agent SDK supports a `[1m]` suffix convention natively: passing `model: 'claude-opus-4-7[1m]'` makes the SDK strip the suffix and add the `context-1m-2025-08-07` beta header on our behalf (confirmed via `code.claude.com/docs/en/model-config` + `anthropics/claude-code#36670`). We keep the suffix end-to-end so the SDK handles the beta switch, and compute our own context-window math from the suffix.

## Scope

### In
- Replace substring-based `contextWindow` in `src/metrics/model-registry.ts` with suffix-based rule.
- Shrink user-facing `AVAILABLE_MODELS` in `src/user-settings-store.ts` to exactly four:
  `claude-opus-4-6`, `claude-opus-4-6[1m]`, `claude-opus-4-7`, `claude-opus-4-7[1m]`.
- Extend `MODEL_ALIASES`, `resolveModelInput`, `getModelDisplayName` to handle `[1m]` variants.
- Keep `DEFAULT_MODEL = 'claude-opus-4-7'` (200k, user-confirmed Q1=A).
- Rely on existing legacy-migration at `loadSettings` (~line 217-226) to silently reset non-allowed `defaultModel` to `DEFAULT_MODEL` (user-confirmed Q2=A).
- Mirror `VALID_MODELS` update in `src/deploy/main-env-bootstrap.ts` so deploy-time migration does not undo the user's `[1m]` choice.
- Delete `buildBetaHeaders` + call site in `src/claude-handler.ts`. Pass `options.model` to SDK with `[1m]` intact (user-confirmed Q3: drop beta headers entirely, let SDK handle it). Verified via `@anthropic-ai/claude-agent-sdk@^0.2.111` bundle: SDK detects `/\[1m\]/i`, strips suffix, handles uniformly across API-key and OAuth auth. `CLAUDE_CODE_DISABLE_1M_CONTEXT` env var exists as kill switch.
- **Preserve `[1m]` in session.model across the executor hot path.** `src/slack/pipeline/stream-executor.ts:2192` currently does `const modelName = usage.modelName || session.model;` — after the plan, `usage.modelName` is the SDK-stripped bare name, so this would force the suffix-aware lookup to 200k even when the user selected `[1m]`. Fix: flip precedence to `session.model ?? usage.modelName`.
- **Mirror `FEATURED_ALIASES` in `src/slack/z/topics/model-topic.ts:10`.** Currently `['sonnet', 'opus', 'haiku']`; after alias-table rewrite only `opus` survives. Update to `['opus', 'opus[1m]', 'opus-4.6[1m]']` (3 featured buttons spanning both models and 1M variant).
- **Coerce stale `session.model` on session restore / deploy normalize.** Extend `normalizeMainTargetData` in `src/deploy/main-env-bootstrap.ts` to normalize `session.model` in `sessions.json` against new allow-list. Extend `session-registry.ts` load path (or `loadSessions()`) to coerce unknown models to `DEFAULT_MODEL`. Prevents ~24h silent wrong-context-window on crash-recovered sessions post-deploy.
- Update affected tests: `model-registry.test.ts`, `claude-handler.test.ts`, `session-usage.test.ts`, `main-env-bootstrap.test.ts`, `user-settings-store.test.ts`, `model-topic.test.ts`, `stream-executor*.test.ts` (new regression test for suffix preservation), and any `session-registry` test touching load path (add stale-model coerce case).
- **Rewrite `session-usage.test.ts` in-file execution shadow.** The file contains local copies of `resolveContextWindow`, `MODEL_CONTEXT_WINDOWS` (:30-38), and `updateSessionUsage` (:52-91). These simulate production logic but currently use substring matching and the old precedence `usageData.modelName || session.model`. Must be rewritten to mirror production: suffix-based `resolveContextWindow`, and flipped precedence `session.model ?? usageData.modelName`. Otherwise the test file passes green while diverging from `stream-executor.ts`. This is execution-shadow rewrite, not just assertion update.
- **Prune legacy `MODEL_ALIASES` keys that point outside new `AVAILABLE_MODELS`.** Current alias table includes `sonnet`, `sonnet-4.6`, `sonnet-4.5`, `opus-4.5`, `haiku`, `haiku-4.5` — all now point to unreachable model IDs. Remove them; keep only the opus 4.6/4.7 × {bare,[1m]} aliases.
- **`getModelDisplayName` fallback spec.** For unknown `model: ModelId` (transient state between pre-deploy persistence and post-deploy coerce), `default` branch returns the raw string. Add a belt-and-suspenders branch: if `typeof model === 'string' && model.endsWith('[1m]')`, strip + recurse + append `" (1M)"`.
- **`src/slack/thread-header-builder.ts:315` formatter.** Regex `/claude-(\w+)-(\d+)-(\d+)/` does not match `claude-opus-4-7[1m]` (`\w` excludes `[`). Add branch: strip `[1m]` before regex, append `" (1M)"` to output.

### Out
- No changes to `libsoma` or `soma` (telegram) repos.
- No changes to internal dispatch/summary models (haiku/sonnet used by `dispatch-service.ts`, `summarizer.ts`, `config.ts`). These are infrastructure-internal and pass directly to SDK.
- `MODEL_REGISTRY` pricing entries for older models stay (still referenced by token-cost math via internal flows).
- No UI notification when a user's model is reset during migration (Q2=A silent reset).

## Architecture Decisions

### D1. contextWindow derivation = pure suffix check
```ts
export function resolveContextWindow(modelName?: string): number {
  return modelName?.endsWith('[1m]') ? 1_000_000 : 200_000;
}
export function getContextWindow(modelName?: string): number {
  return resolveContextWindow(modelName);
}
```
`MODEL_REGISTRY[i].contextWindow` becomes informational only; set all entries to `200_000` to remove the foot-gun of mismatched values. `getModelSpec` retains substring matching for `pricing` and `maxOutput`.

### D2. SDK receives model name with `[1m]` intact
SDK strips the suffix and injects the beta header. Our code no longer maintains `buildBetaHeaders`. `options.betas` is never set by our handler.

### D3. AVAILABLE_MODELS pivots to user-facing list only
The 6 → 4 shrink is scoped to **user-facing model selection** (`AVAILABLE_MODELS`, `MODEL_ALIASES`, `getModelDisplayName` switch, `resolveModelInput`). Internal infra constants (`FALLBACK_DISPATCH_MODEL`, `HAIKU_MODEL`, `SONNET_MODEL`, `config.summaryModel`) are untouched because they are not exposed via `/model` commands.

### D4. Deploy-time VALID_MODELS must mirror AVAILABLE_MODELS + normalize sessions.json
Otherwise `normalizeMainTargetData` at deploy time would undo a user's `[1m]` selection. Derive or duplicate the 4-entry list. Additionally, `normalizeMainTargetData` currently ignores `session.model` in `sessions.json` — extend it to reset stale models to `DEFAULT_MODEL`.

### D7. Executor uses `session.model` (suffix-bearing) for contextWindow lookup
`stream-executor.ts:2192` must prefer `session.model` (locally stored, suffix intact) over `usage.modelName` (SDK-stripped) when resolving contextWindow. The `Math.max(sdkWindow, lookupWindow)` pattern stays — it still protects against the SDK reporting the base window when 1M is active.

### D8. Session restore coerces unknown model to DEFAULT_MODEL
`SessionRegistry.loadSessions()` (and equivalent deserialize path) validates `serialized.model` against `AVAILABLE_MODELS`; falls back to `DEFAULT_MODEL` on miss. Logs the coercion. Covers sessions persisted before the allow-list shrank.

### D9. No auth-method gate; trust SDK
`buildBetaHeaders` gated on `!!process.env.ANTHROPIC_API_KEY`. That gate reflected our belief that OAuth SDK clients didn't support the beta header — but `@anthropic-ai/claude-agent-sdk@^0.2.111` handles `[1m]` uniformly (`DP`/`/\[1m\]/i` detection + `replace(/\[1m\]$/i,"")` before API, both paths). Kill-switch `CLAUDE_CODE_DISABLE_1M_CONTEXT` is already respected by SDK internals. Deleting our helper is safe.

### D5. Alias table — keep short `opus` aliases
- `opus` → `claude-opus-4-7`
- `opus[1m]` → `claude-opus-4-7[1m]`
- `opus-4.7` → `claude-opus-4-7`
- `opus-4.7[1m]` → `claude-opus-4-7[1m]`
- `opus-4.6` → `claude-opus-4-6`
- `opus-4.6[1m]` → `claude-opus-4-6[1m]`

Remove sonnet/haiku aliases (not user-facing anymore per D3).

### D6. resolveModelInput normalization
Lowercase + trim. Accept both `claude-opus-4-7[1m]` and alias forms. Reject everything else (returns `null`). Display names:
- `claude-opus-4-7` → `"Opus 4.7"`
- `claude-opus-4-7[1m]` → `"Opus 4.7 (1M)"`
- `claude-opus-4-6` → `"Opus 4.6"`
- `claude-opus-4-6[1m]` → `"Opus 4.6 (1M)"`

## Success Criteria

| # | Invariant |
|---|-----------|
| S1 | `getContextWindow('claude-opus-4-7') === 200_000` |
| S2 | `getContextWindow('claude-opus-4-7[1m]') === 1_000_000` |
| S3 | `getContextWindow('claude-opus-4-6') === 200_000` |
| S4 | `getContextWindow('claude-opus-4-6[1m]') === 1_000_000` |
| S5 | `resolveModelInput('claude-opus-4-7[1m]') === 'claude-opus-4-7[1m]'` |
| S6 | `resolveModelInput('opus[1m]') === 'claude-opus-4-7[1m]'` |
| S7 | Loading `user-settings.json` with `defaultModel: 'claude-sonnet-4-6'` silently resets to `'claude-opus-4-7'` |
| S8 | Loading with `defaultModel: 'claude-opus-4-7[1m]'` preserves `[1m]` across load → save cycle |
| S9 | `claude-handler.ts` no longer exports `buildBetaHeaders`; SDK call omits `options.betas` |
| S10 | SDK `query()` receives the exact `options.model` string the user selected, including `[1m]` |
| S11 | `npm run build && npm test` pass |
| S12 | `npm run typecheck` has zero errors |
| S13 | `stream-executor` regression test: `session.model='claude-opus-4-7[1m]'`, `usage.modelName='claude-opus-4-7'`, `usage.contextWindow=200_000` → `session.usage.contextWindow === 1_000_000` |
| S14 | `/z` featured-model buttons render 3 valid buttons using new aliases (no silent disappearance) |
| S15 | `sessions.json` with legacy `session.model` (e.g. `claude-sonnet-4-6`) restores as `claude-opus-4-7` post-deploy |
| S16 | Loading sessions via `SessionRegistry.loadSessions()` coerces stale models to `DEFAULT_MODEL` and emits an info log |
| S17 | `formatModelName('claude-opus-4-7[1m]') === 'opus-4.7 (1M)'` (and `claude-opus-4-6[1m]` → `'opus-4.6 (1M)'`); bare variants retain current output |
| S18 | `model-registry.test.ts` existing assertions at :70, :74 rewritten: bare `opus-4-6`/`opus-4-7` return 200k; `[1m]` variants return 1M |
| S19 | In-file shadow at `session-usage.test.ts:30-91` mirrors production: `resolveContextWindow` uses suffix, `updateSessionUsage` uses `session.model ?? usageData.modelName` precedence |
| S20 | `MODEL_ALIASES` has exactly the keys: `opus`, `opus[1m]`, `opus-4.7`, `opus-4.7[1m]`, `opus-4.6`, `opus-4.6[1m]` — no legacy sonnet/haiku/4.5 aliases |
