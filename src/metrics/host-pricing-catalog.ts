/**
 * The process's host pricing, backed by the model catalog (`metrics/host-pricing.ts`):
 * the stream mapper prices llmux models with it, and a loaded session's saved
 * SDK running total is repriced with it (`session-registry.ts`).
 */

import { modelCatalog } from '../model-catalog';
import { createHostPricing } from './host-pricing';

export const hostPricing = createHostPricing(modelCatalog);
