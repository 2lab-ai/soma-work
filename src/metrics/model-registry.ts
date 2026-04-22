/**
 * Unified model registry — single source of truth for pricing, context windows, and max output.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 * Last updated: 2026-04-17
 */

export const PRICING_VERSION = '2026-04-17';

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
 * Single source of truth: the `[1m]` suffix is the only signal for a 1M window.
 * Bare model ids (without the suffix) resolve to `FALLBACK_CONTEXT_WINDOW` (200k),
 * even for models whose base spec used to be 1M. This matches the
 * user-facing contract where 1M context is an opt-in via the `[1m]` variant.
 *
 * Used by stream-executor hot paths and threshold checks that need a non-zero
 * denominator before the SDK reports `contextWindow`.
 */
export function resolveContextWindow(modelName?: string): number {
  if (!modelName) return FALLBACK_CONTEXT_WINDOW;
  return hasOneMSuffix(modelName) ? 1_000_000 : FALLBACK_CONTEXT_WINDOW;
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
