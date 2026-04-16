/**
 * Token pricing — thin wrapper over model-registry for backward compatibility.
 *
 * New consumers should import directly from './model-registry'.
 * This module preserves the legacy `ModelPricing` interface shape
 * (with `cacheCreatePerMTok` as an alias for `cache5minWritePerMTok`).
 */

import {
  calculateTokenCost as _calculateTokenCost,
  getModelPricing as _getModelPricing,
  type ModelPricingSpec,
} from './model-registry';

export { calculateTokenCost } from './model-registry';

/**
 * Legacy ModelPricing interface preserved for backward compatibility.
 * `cacheCreatePerMTok` maps to the 5-minute cache write tier.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheCreatePerMTok: number;
}

/**
 * Get pricing for a model by name pattern matching.
 * Returns legacy ModelPricing shape (cacheCreatePerMTok = cache5minWritePerMTok).
 */
export function getModelPricing(modelName?: string): ModelPricing {
  const spec: ModelPricingSpec = _getModelPricing(modelName);
  return {
    inputPerMTok: spec.inputPerMTok,
    outputPerMTok: spec.outputPerMTok,
    cacheReadPerMTok: spec.cacheReadPerMTok,
    cacheCreatePerMTok: spec.cache5minWritePerMTok,
  };
}
