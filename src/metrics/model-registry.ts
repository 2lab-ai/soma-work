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
export const NATIVE_ONE_M_RE = /fable-5/i;

/** Returns true when `model` serves 1M context on its bare id (no suffix). */
export function isNativeOneMModel(model: string): boolean {
  return NATIVE_ONE_M_RE.test(model);
}

/**
 * `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` value injected for native-1M models.
 *
 * The pinned Agent SDK (0.2.111) does not know native-1M model ids — its
 * internal window resolver only honors the `[1m]` suffix, the 1M beta header
 * (sonnet-4 / opus-4-6 / opus-4-7 only), or a sonnet-4-6 experiment, and
 * falls back to 200k for everything else, including `claude-fable-5`. On that
 * bogus 200k base the SDK hard-blocks new input at `window − 20k (output
 * reserve) − 3k (safety) ≈ 177k`. This constant is the same SDK formula
 * evaluated on the true 1M window: 1_000_000 − 20_000 − 3_000.
 *
 * Consumed by `build-stream-options.ts` (native-1M env workaround). Remove
 * together with that injection once the pinned SDK CLI resolves fable-5 to
 * 1M natively.
 */
export const NATIVE_ONE_M_SDK_BLOCKING_LIMIT = 977_000;

/** Strips the `[1m]` suffix from `model` if present. Case-insensitive. */
export function stripOneMSuffix(model: string): string {
  return model.replace(ONE_M_SUFFIX_RE, '');
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
