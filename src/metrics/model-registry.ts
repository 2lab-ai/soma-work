/**
 * Unified model registry — single source of truth for pricing, context windows, and max output.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 * Last updated: 2026-06-09 (Claude Fable 5 release, 2026-06-09)
 */

export const PRICING_VERSION = '2026-06-09';

export interface ModelPricingSpec {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** Cache write with 5-minute TTL (default) — 1.25× base input */
  cache5minWritePerMTok: number;
  /** Cache write with 1-hour TTL — 2× base input */
  cache1hrWritePerMTok: number;
}

export interface ModelSpec {
  pricing: ModelPricingSpec;
  contextWindow: number;
  maxOutput: number;
}

/**
 * Model registry. Key = substring matched against full model name.
 * Order matters — first match wins.
 */
const MODEL_REGISTRY: [pattern: string, spec: ModelSpec][] = [
  // Claude Fable 5 (2026-06-09). Anthropic's most capable generally-available
  // model: 1M context, 128k max output. Pricing is double Opus-tier
  // ($10 in / $50 out per MTok). cacheRead = 0.1×input, 5min write = 1.25×input,
  // 1hr write = 2×input — same multipliers as every other tier. Listed first so
  // the `includes('fable-5')` matcher resolves before any opus/sonnet pattern.
  [
    'fable-5',
    {
      pricing: {
        inputPerMTok: 10,
        outputPerMTok: 50,
        cacheReadPerMTok: 1,
        cache5minWritePerMTok: 12.5,
        cache1hrWritePerMTok: 20,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.6-terra — mid tier of the gpt-5.6 family ($2.50 in / $15
  // out / $0.25 cache-read per MTok, 2026-07-09 launch rates; no
  // cache-creation charge on codex). Same 372k window as sol — official
  // value from the openai/codex model catalog (models-manager/models.json),
  // probe-consistent (369,755-token input accepted, ~380k rejected).
  // MUST stay ABOVE the 'gpt-5.6' entry — patterns are substring-matched
  // first-wins, and 'gpt-5.6' would swallow 'gpt-5.6-terra'.
  [
    'gpt-5.6-terra',
    {
      pricing: {
        inputPerMTok: 2.5,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.25,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 372_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.6-luna — budget tier ($1 in / $6 out / $0.1 cache-read per
  // MTok, 2026-07-09 launch rates; no cache-creation charge on codex). Same
  // 372k catalog window. MUST stay above the generic 'gpt-5.6' pattern.
  [
    'gpt-5.6-luna',
    {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 6,
        cacheReadPerMTok: 0.1,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 372_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.6 family fallback (sol rates) — served via llmux's codex
  // backend group. There is no bare `gpt-5.6` model; this pattern catches
  // `gpt-5.6-sol` plus the legacy bare-id spelling in old transcripts and
  // future dated sol snapshots. Rates match OpenAI's 2026-07-09 launch
  // pricing for the sol flagship: $5 in / $30 out / $0.5 cache-read per
  // MTok, no cache-creation charge on codex. Context window is 372k — the
  // official openai/codex catalog value (models-manager/models.json:
  // context_window 372000 for sol/terra/luna alike), probe-consistent
  // (369,755-token input accepted, ~380k rejected) — with harness-side
  // auto-compact at 340k (see GPT_5_6_* constants below). Terra/luna have
  // their own entries ABOVE this one (substring matching is first-wins).
  [
    'gpt-5.6',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 30,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 372_000,
      maxOutput: 128_000,
    },
  ],
  // OpenAI gpt-5.5 — served via llmux's codex backend group (llmux routes
  // `gpt-` prefixed ids to codex; see llmux src/routing.rs). Rates mirror
  // llmux's built-in gpt-5.5 pricing (2026-04-23): $5 in / $30 out /
  // $0.5 cache-read per MTok, and NO cache-creation charge (codex has no
  // cache-write billing — both write rates are 0). Context window is 275k
  // with harness-side auto-compact at 250k (see GPT_5_5_* constants below).
  [
    'gpt-5.5',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 30,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 0,
        cache1hrWritePerMTok: 0,
      },
      contextWindow: 275_000,
      maxOutput: 128_000,
    },
  ],
  // Claude 4.8 (2026-05-28). Same $/MTok as 4.7; 1M context (default per
  // Anthropic spec, but per soma-work convention only `[1m]`-suffixed ids
  // actually opt into 1M at resolveContextWindow — see hasOneMSuffix).
  [
    'opus-4-8',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude 4.7
  [
    'opus-4-7',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  // Claude 4.6
  [
    'opus-4-6',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  [
    'sonnet-4-6',
    {
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cache5minWritePerMTok: 3.75,
        cache1hrWritePerMTok: 6,
      },
      contextWindow: 1_000_000,
      maxOutput: 64_000,
    },
  ],
  // Claude 4.5
  [
    'opus-4-5',
    {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cache5minWritePerMTok: 6.25,
        cache1hrWritePerMTok: 10,
      },
      contextWindow: 1_000_000,
      maxOutput: 128_000,
    },
  ],
  [
    'sonnet-4-5',
    {
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cache5minWritePerMTok: 3.75,
        cache1hrWritePerMTok: 6,
      },
      contextWindow: 1_000_000,
      maxOutput: 64_000,
    },
  ],
  [
    'haiku-4-5',
    {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cache5minWritePerMTok: 1.25,
        cache1hrWritePerMTok: 2,
      },
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
  ],
  // Claude 4.0 (generic fallbacks)
  [
    'sonnet-4-',
    {
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cache5minWritePerMTok: 3.75,
        cache1hrWritePerMTok: 6,
      },
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
  ],
  [
    'haiku-4-',
    {
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 5,
        cacheReadPerMTok: 0.1,
        cache5minWritePerMTok: 1.25,
        cache1hrWritePerMTok: 2,
      },
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
  ],
];

/** Fallback spec (Sonnet-tier) when model is unknown */
const FALLBACK_SPEC: ModelSpec = {
  pricing: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cache5minWritePerMTok: 3.75,
    cache1hrWritePerMTok: 6,
  },
  contextWindow: 200_000,
  maxOutput: 64_000,
};

/**
 * Get full model spec by name pattern matching.
 */
export function getModelSpec(modelName?: string): ModelSpec {
  if (!modelName) return FALLBACK_SPEC;
  for (const [pattern, spec] of MODEL_REGISTRY) {
    if (modelName.includes(pattern)) return spec;
  }
  return FALLBACK_SPEC;
}

/**
 * Get pricing for a model. Backward-compatible wrapper.
 */
export function getModelPricing(modelName?: string): ModelPricingSpec {
  return getModelSpec(modelName).pricing;
}

/** Fallback context window size when SDK/registry haven't reported one yet. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * Suffix marker for the 1M-context variant of a model id.
 * Convention: `{baseModelId}[1m]` enables the 1M beta context window.
 * The Claude Agent SDK (≥ 0.2.111) detects this suffix, strips it before the
 * API call, and injects the `context-1m-2025-08-07` beta header uniformly
 * across API-key and OAuth auth — so no runtime beta-header injection is needed.
 */
export const ONE_M_SUFFIX_RE = /\[1m\]$/i;

/** Returns true when `model` ends with the 1M suffix (case-insensitive). */
export function hasOneMSuffix(model: string): boolean {
  return ONE_M_SUFFIX_RE.test(model);
}

/**
 * Models that serve a 1M context window on the BARE id — no `[1m]` suffix and
 * no `context-1m-2025-08-07` beta header.
 *
 * Fable 5 ships 1M as its native, generally-available context (Anthropic docs,
 * 2026-06-09), unlike opus where 1M is a beta opt-in gated behind the `[1m]`
 * suffix + beta header. So `claude-fable-5` must resolve to 1M directly; it has
 * no `[1m]` variant and must NOT go through the suffix/beta-header path.
 */
const NATIVE_ONE_M_RE = /fable-5/i;

/** Returns true when `model` serves 1M context on its bare id (no suffix). */
export function isNativeOneMModel(model: string): boolean {
  return NATIVE_ONE_M_RE.test(model);
}

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value injected for native-1M models:
 * the SDK's own input hard-block formula (`window − 20k output reserve − 3k
 * safety`) evaluated on the true 1M window.
 *
 * See the native-1M workaround block in `build-stream-options.ts` for the
 * full story (the pinned SDK resolves native-1M ids to 200k); remove this
 * constant together with that injection.
 */
export const NATIVE_ONE_M_SDK_BLOCKING_LIMIT = 977_000;

/** Strips the `[1m]` suffix from `model` if present. Case-insensitive. */
export function stripOneMSuffix(model: string): string {
  return model.replace(ONE_M_SUFFIX_RE, '');
}

/* ------------------------------------------------------------------ *
 * gpt-5.5 (llmux codex backend)
 * ------------------------------------------------------------------ */

/**
 * gpt-5.5 — an OpenAI model served through llmux's codex backend group
 * (llmux routes `gpt-` prefixed ids to codex accounts; the SDK subprocess
 * talks to llmux exactly as it does for claude ids). The pinned Agent SDK
 * does not know this id, so — like native-1M models — the harness owns the
 * context-window math (see `resolveContextWindow`, the SDK workaround block
 * in `build-stream-options.ts`, and the token-based auto-compact trigger in
 * `compact-threshold-checker.ts`).
 */
const GPT_5_5_RE = /gpt-5\.5/i;

/** Returns true when `model` is a gpt-5.5 id (case-insensitive). */
export function isGpt55Model(model: string): boolean {
  return GPT_5_5_RE.test(model);
}

/** gpt-5.5 true context window: 275k. */
export const GPT_5_5_CONTEXT_WINDOW = 275_000;

/**
 * Harness-side auto-compact trigger for gpt-5.5: when a session's used
 * context tokens reach 250k, the turn-end checker schedules `/compact` for
 * the next turn — a fixed token count (not the per-user percent threshold),
 * per the model's spec.
 */
export const GPT_5_5_AUTO_COMPACT_TOKENS = 250_000;

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value injected for gpt-5.5: the
 * SDK's own input hard-block formula (`window − 20k output reserve − 3k
 * safety`) evaluated on the true 275k window. Without it the pinned SDK
 * resolves the unknown id to 200k and refuses input at ~177k.
 */
export const GPT_5_5_SDK_BLOCKING_LIMIT = GPT_5_5_CONTEXT_WINDOW - 20_000 - 3_000;

/* ------------------------------------------------------------------ *
 * gpt-5.6 (llmux codex backend, default model since 2026-07-10)
 * ------------------------------------------------------------------ */

/**
 * gpt-5.6 — OpenAI's 2026-07-09 release, served through llmux's codex
 * backend group like gpt-5.5. llmux ≥ 0.2.16 pins the upstream slug to
 * `gpt-5.6-sol` (the bare `gpt-5.6` id is rejected by the ChatGPT-account
 * codex backend). The pinned Agent SDK does not know this id either, so the
 * harness owns the context-window math — same workaround set as gpt-5.5,
 * evaluated on the 372k catalog window.
 *
 * The regex matches the soma-work id (`gpt-5.6`) AND the upstream-reported
 * slugs (`gpt-5.6-sol`, `gpt-5.6-terra`) so usage events that carry the
 * upstream name resolve to the same window.
 */
const GPT_5_6_RE = /gpt-5\.6/i;

/** Returns true when `model` is a gpt-5.6 family id (case-insensitive). */
export function isGpt56Model(model: string): boolean {
  return GPT_5_6_RE.test(model);
}

/**
 * gpt-5.6 context window: 372k — the official value from the openai/codex
 * model catalog (models-manager/models.json: context_window 372000 for
 * sol/terra/luna alike), cross-checked by probing the ChatGPT-account codex
 * backend on 2026-07-10 (369,755-token input accepted, ~380k rejected;
 * gpt-5.5's 272k input split is gone). The official API window is 1.05M,
 * but the codex backend clamps to the catalog value — do NOT raise this
 * without re-checking the catalog.
 */
export const GPT_5_6_CONTEXT_WINDOW = 372_000;

/**
 * Harness-side auto-compact trigger for gpt-5.6: fixed 340k tokens (~91% of
 * the 372k window, mirroring gpt-5.5's 250k/275k ratio). The 32k headroom
 * matters: the compact turn itself resends the full history plus the summary
 * prompt, so the trigger must sit safely below the hard window.
 */
export const GPT_5_6_AUTO_COMPACT_TOKENS = 340_000;

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value injected for gpt-5.6: the
 * SDK's own input hard-block formula (`window − 20k output reserve − 3k
 * safety`) evaluated on the true 372k window. Without it the pinned SDK
 * resolves the unknown id to 200k and refuses input at ~177k.
 */
export const GPT_5_6_SDK_BLOCKING_LIMIT = GPT_5_6_CONTEXT_WINDOW - 20_000 - 3_000;

/**
 * Fixed token-count auto-compact trigger for models whose compaction point
 * is defined in absolute tokens rather than the per-user percent threshold.
 * Returns `undefined` for every other model — callers fall back to the
 * percent-based check (#617).
 *
 * Order matters: gpt-5.6 first — the regexes are disjoint today, but keep
 * the newest generation first so a future overlapping pattern resolves to
 * the newer trigger.
 */
export function resolveAutoCompactTokens(modelName?: string): number | undefined {
  if (modelName && isGpt56Model(modelName)) return GPT_5_6_AUTO_COMPACT_TOKENS;
  if (modelName && isGpt55Model(modelName)) return GPT_5_5_AUTO_COMPACT_TOKENS;
  return undefined;
}

/**
 * Error code surfaced on thrown errors when the account lacks 1M-context
 * entitlement. Set by `claude-handler.maybeThrowOneMUnavailable` and checked
 * by `stream-executor.isOneMContextUnavailableError` — keeping the literal in
 * one place prevents drift between producer and matcher.
 */
export const ONE_M_CONTEXT_UNAVAILABLE_CODE = 'ONE_M_CONTEXT_UNAVAILABLE';

/**
 * Detect whether `text` matches any of the three stable SDK signals that
 * indicate the account cannot use the 1M-context beta for the attempted model.
 *
 * Issue #661 — Claude Agent SDK ≥ 0.2.111 surfaces these via
 * `isApiErrorMessage: true` assistant messages (not via throw). stream-executor
 * uses this matcher downstream to decide whether to strip `[1m]` and retry.
 *
 * Signal sources (observed in `@anthropic-ai/claude-agent-sdk@0.2.111`
 * `cli.js` bundle):
 *   1. "Extra usage is required for 1M context" (HTTP 429 rewrite)
 *   2. "long context beta" — covers both the 400 "not yet available for this
 *      subscription" and the 400 "incompatible with the long context beta
 *      header" variants.
 *   3. "not yet available for this subscription" — defensive redundancy for
 *      the 400 subscription variant in case the "long context beta" phrasing
 *      changes.
 *
 * Keeping the matcher narrow is the whole point: a broad substring like
 * "context" would misfire on `prompt is too long` errors (Issue #661 spec
 * test case 4) and downgrade the user's model without their consent.
 */
export function isOneMContextUnavailableSignal(text: string): boolean {
  return classifyOneMUnavailable(text) !== 'none';
}

/**
 * Classify the root cause of a 1M-context unavailability signal. The fallback
 * (strip `[1m]`, retry bare) is the same for all kinds, but the USER-facing
 * remediation is not: entitlement errors point to Claude Extra Usage /
 * subscription upgrade, while auth errors need the operator to reconfigure
 * the authentication mode.
 *
 * - `entitlement`: account-level 1M usage not enabled. 429 "Extra usage is
 *   required for 1M context" or 400 "not yet available for this subscription".
 * - `auth`: the current auth style cannot carry the long-context beta header.
 *   400 "This authentication style is incompatible with the long context
 *   beta header." No amount of Extra Usage will help — the fix is to change
 *   how the bot authenticates (CCT slot / token type).
 * - `none`: text does not match any known 1M-unavailable signal.
 *
 * Narrowing note: the "long context beta" substring is intentionally scoped
 * to the auth variant and no longer overlaps with the subscription variant —
 * keep `not yet available for this subscription` as the dedicated gate for
 * the entitlement case.
 */
export type OneMUnavailableKind = 'entitlement' | 'auth' | 'none';

export function classifyOneMUnavailable(text: string): OneMUnavailableKind {
  const s = text.toLowerCase();
  if (s.includes('incompatible with the long context beta header')) return 'auth';
  if (s.includes('extra usage is required for 1m context')) return 'entitlement';
  if (s.includes('not yet available for this subscription')) return 'entitlement';
  // Residual "long context beta" mentions (without the specific auth phrase)
  // are still treated as auth-ish: the Anthropic SDK uses this phrasing in
  // several 400-class auth/header rejections. Safer to steer the user to
  // an operator than to bill.
  if (s.includes('long context beta')) return 'auth';
  return 'none';
}

/**
 * Resolve context window for a model by name.
 *
 * Two signals resolve to a 1M window:
 *   1. The `[1m]` suffix (opus beta opt-in) — strips + injects the beta header.
 *   2. A native-1M model id (e.g. `claude-fable-5`) — 1M on the bare id, no
 *      suffix and no beta header. See `isNativeOneMModel`.
 * gpt-5.6 (llmux codex backend) resolves to its true 372k window;
 * gpt-5.5 (same backend) resolves to its true 275k window.
 * Every other bare model id resolves to `FALLBACK_CONTEXT_WINDOW` (200k), even
 * for specs that used to be 1M — matching the user-facing contract where 1M is
 * otherwise an opt-in via the `[1m]` variant.
 *
 * Used by stream-executor hot paths and threshold checks that need a non-zero
 * denominator before the SDK reports `contextWindow`.
 */
export function resolveContextWindow(modelName?: string): number {
  if (!modelName) return FALLBACK_CONTEXT_WINDOW;
  if (hasOneMSuffix(modelName)) return 1_000_000;
  if (isNativeOneMModel(modelName)) return 1_000_000;
  if (isGpt56Model(modelName)) return GPT_5_6_CONTEXT_WINDOW;
  if (isGpt55Model(modelName)) return GPT_5_5_CONTEXT_WINDOW;
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * Get max output token count for a model.
 */
export function getMaxOutput(modelName?: string): number {
  return getModelSpec(modelName).maxOutput;
}

/**
 * Calculate cost from token counts and model name.
 * Uses cache5minWritePerMTok for cacheCreateTokens (default behavior).
 * Returns cost in USD.
 */
export function calculateTokenCost(
  modelName: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): number {
  const pricing = getModelPricing(modelName);
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok +
    (cacheCreateTokens / 1_000_000) * pricing.cache5minWritePerMTok
  );
}
