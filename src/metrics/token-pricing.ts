/**
 * Anthropic model pricing table.
 * Prices are per 1M tokens (MTok) in USD.
 *
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 * Last updated: 2025-06-01
 *
 * Cache pricing:
 * - cache_creation: 25% MORE than base input price
 * - cache_read: 90% LESS than base input price (10% of base)
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheCreatePerMTok: number;
}

/**
 * Model family pricing lookup.
 * Key is a substring matched against the full model name.
 * Order matters — first match wins.
 */
const MODEL_PRICING: [pattern: string, pricing: ModelPricing][] = [
  // Claude 4.6
  [
    'opus-4-6',
    {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.5, // 10% of input
      cacheCreatePerMTok: 18.75, // 125% of input
    },
  ],
  [
    'sonnet-4-6',
    {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheCreatePerMTok: 3.75,
    },
  ],
  // Claude 4.5
  [
    'opus-4-5',
    {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.5,
      cacheCreatePerMTok: 18.75,
    },
  ],
  [
    'sonnet-4-5',
    {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheCreatePerMTok: 3.75,
    },
  ],
  [
    'haiku-4-5',
    {
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheReadPerMTok: 0.08,
      cacheCreatePerMTok: 1,
    },
  ],
  // Claude 4.0
  [
    'sonnet-4-',
    {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheCreatePerMTok: 3.75,
    },
  ],
  [
    'haiku-4-',
    {
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheReadPerMTok: 0.08,
      cacheCreatePerMTok: 1,
    },
  ],
];

/** Fallback pricing (Sonnet-tier) when model is unknown */
const FALLBACK_PRICING: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheCreatePerMTok: 3.75,
};

/**
 * Get pricing for a model by name pattern matching.
 */
export function getModelPricing(modelName?: string): ModelPricing {
  if (!modelName) return FALLBACK_PRICING;
  for (const [pattern, pricing] of MODEL_PRICING) {
    if (modelName.includes(pattern)) return pricing;
  }
  return FALLBACK_PRICING;
}

/**
 * Calculate cost from token counts and model name.
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
    (cacheCreateTokens / 1_000_000) * pricing.cacheCreatePerMTok
  );
}
