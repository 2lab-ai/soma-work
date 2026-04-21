/**
 * Unified model registry — single source of truth for pricing, context windows, and max output.
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 * Last updated: 2026-04-21
 *
 * Context window rule (#648):
 *   `contextWindow` is derived from the `[1m]` model-name suffix, not from the
 *   registry pricing rows. A bare model (e.g. `claude-opus-4-7`) is 200k; the
 *   `[1m]`-suffixed form (e.g. `claude-opus-4-7[1m]`) is 1M. Claude Agent SDK
 *   strips the suffix and injects the `context-1m-2025-08-07` beta internally.
 *
 *   The `contextWindow` field on each `ModelSpec` below is informational only —
 *   every row is set to 200_000 to avoid the foot-gun of a mismatched registry
 *   value masking the suffix-based rule. Call `getContextWindow` /
 *   `resolveContextWindow` as the single source of truth.
 */

export const PRICING_VERSION = '2026-04-21';

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
   * Informational only. The true context window is derived from the `[1m]`
   * suffix — use `resolveContextWindow` / `getContextWindow`.
   */
  contextWindow: number;
  maxOutput: number;
}

/**
 * Model registry. Key = substring matched against full model name.
 * Order matters — first match wins.
 *
 * Note: substring matching still works with `[1m]`-suffixed names because
 * `'claude-opus-4-7[1m]'.includes('opus-4-7') === true`. Only `contextWindow`
 * is forced to the bare 200k base — the `[1m]` lift is applied by
 * `resolveContextWindow`.
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
      contextWindow: 200_000,
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
      contextWindow: 200_000,
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
      contextWindow: 200_000,
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
      contextWindow: 200_000,
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
      contextWindow: 200_000,
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

/** Fallback context window size when model is undefined. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * Resolve context window for a model by suffix rule.
 *
 * Rule (#648): `[1m]` suffix → 1M. Anything else → 200k.
 * Claude Agent SDK (v0.2.111+) strips the suffix and injects the
 * `context-1m-2025-08-07` beta header internally. We keep the suffix
 * end-to-end so our local math (compact threshold %, usage meter) matches
 * the window the API is actually serving.
 */
export function resolveContextWindow(modelName?: string): number {
  if (!modelName) return FALLBACK_CONTEXT_WINDOW;
  return /\[1m\]$/i.test(modelName) ? 1_000_000 : 200_000;
}

/**
 * Get context window size for a model. Delegates to `resolveContextWindow`.
 * Kept as a named export for backward compatibility with existing call sites.
 */
export function getContextWindow(modelName?: string): number {
  return resolveContextWindow(modelName);
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
