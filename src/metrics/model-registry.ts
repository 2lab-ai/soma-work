/**
 * Unified model registry — single source of truth for pricing, context windows, and max output.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 * Last updated: 2026-06-09 (Claude Fable 5 release, 2026-06-09)
 */

import { resolveModelProfile } from './model-profile';

/**
 * Context-window / auto-compact / blocking-limit facts now live in
 * `model-profile.ts` (the single canonical resolver). They are re-exported
 * here so the many existing importers of this module keep working unchanged.
 */
export {
  FALLBACK_CONTEXT_WINDOW,
  GPT_5_5_AUTO_COMPACT_TOKENS,
  GPT_5_5_CONTEXT_WINDOW,
  GPT_5_5_SDK_BLOCKING_LIMIT,
  GPT_5_6_AUTO_COMPACT_TOKENS,
  GPT_5_6_CONTEXT_WINDOW,
  GPT_5_6_SDK_BLOCKING_LIMIT,
  hasOneMSuffix,
  isGpt55Model,
  isGpt56Model,
  isNativeOneMModel,
  isRejectedModelInput,
  type ModelInputAccepted,
  type ModelInputCompatibility,
  type ModelInputRejected,
  type ModelProfile,
  NATIVE_ONE_M_SDK_BLOCKING_LIMIT,
  ONE_M_SUFFIX_RE,
  resolveModelInputCompatibility,
  resolveModelProfile,
  stripOneMSuffix,
} from './model-profile';

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
  /**
   * LEGACY, NOT AUTHORITATIVE. The registry is substring-matched, so one row
   * covers a family including its `[1m]` variant and it cannot express the
   * suffix opt-in at all (the `opus-4-8` row says 1M while bare
   * `claude-opus-4-8` is a 200k profile). The effective window every consumer
   * must use is `resolveModelProfile(id).contextWindow` — this field survives
   * only because `getModelSpec` is a public shape. Nothing in `src/` reads it.
   */
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
  // Claude Opus 5 (2026-08-26) — Opus tier, same rates as the 4.x opus rows
  // ($5 in / $25 out / $0.5 cache-read; 5min write 1.25×input, 1hr 2×input).
  // Cross-checked against llmux, which is the component that actually bills
  // this traffic: `llmux/src/pricing.rs:103-105` maps `claude-opus-5` to
  // `OPUS_TIER` = ModelPrice::new(5.0, 25.0, 0.5, 6.25).
  //
  // MUST stay above the generic `sonnet-4-` / `haiku-4-` fallbacks — and it
  // must exist at all: `claude-opus-5` matches NO other pattern in this table
  // (`opus-4-8`, `opus-4-5`, … all carry a `4-`), so without this row every
  // Opus 5 turn was priced at FALLBACK_SPEC's Sonnet rates. `opus-5` does not
  // collide with `claude-opus-4-5-*` either — that id spells `opus-4-5`.
  [
    'opus-5',
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

/**
 * Fixed token-count auto-compact trigger for models whose compaction point
 * is defined in absolute tokens rather than the per-user percent threshold.
 * Returns `undefined` for every other model — callers fall back to the
 * percent-based check (#617).
 *
 * Thin delegate over the canonical resolver (`model-profile.ts`), which owns
 * both the exact-id policy overlay and the family defaults.
 */
export function resolveAutoCompactTokens(modelName?: string): number | undefined {
  return resolveModelProfile(modelName).autoCompactTokens;
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
 * Thin delegate over the canonical resolver (`model-profile.ts`): exact-id
 * policy overlay → `[1m]` opt-in → native-1M → gpt families → llmux catalog
 * (non-claude groups only) → 200k fallback.
 *
 * Used by stream-executor hot paths and threshold checks that need a non-zero
 * denominator before the SDK reports `contextWindow`.
 */
export function resolveContextWindow(modelName?: string): number {
  return resolveModelProfile(modelName).contextWindow;
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
