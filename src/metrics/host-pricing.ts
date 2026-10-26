/**
 * One price table for the task total and the subagent rows (SSOT 2026-10-26
 * T2/T3).
 *
 * The SDK reports llmux models under their aliases (`astra`, `grok`) and, not
 * knowing them, prices them at its own default rate — astra came out at about
 * a third of its price (dev 2026-10-27: $4.11 for a turn the gpt-6-astra row
 * prices at $12.54), and at other rates than the same calls on a subagent row
 * (`agent-spend.ts` prices a transcript with the host table). So every model
 * the model catalog places outside the `claude` group is priced with the host
 * table, its alias resolved to the canonical id first. Claude models keep the
 * SDK's cost (the SDK knows their prices, cache-write tiers included). With
 * no catalog entry for a model nothing changes.
 */

import { calculateTokenCost } from './model-registry';

/** The part of the model catalog pricing needs (`src/model-catalog.ts`). */
export interface PricingCatalog {
  /** Id or alias → canonical id, or null. */
  resolveInput(input: string): string | null;
  getGroupFor(id: string): string | null;
}

export interface HostPricing {
  /** The host prices `model` itself (the SDK does not know it). */
  hostPriced(model: string): boolean;
  /** `calculateTokenCost` with the catalog alias resolved (`astra` → `gpt-6-astra[1m]`). */
  calculateTokenCost(
    model: string | undefined,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreateTokens: number,
  ): number;
}

/** The catalog group the SDK prices itself. */
const SDK_PRICED_GROUP = 'claude';

export function createHostPricing(catalog: PricingCatalog): HostPricing {
  const canonical = (model: string): string | null => {
    try {
      return catalog.resolveInput(model);
    } catch {
      return null;
    }
  };
  return {
    hostPriced(model) {
      if (!model) return false;
      const id = canonical(model);
      if (!id) return false;
      let group: string | null = null;
      try {
        group = catalog.getGroupFor(id);
      } catch {
        group = null;
      }
      return !!group && group !== SDK_PRICED_GROUP;
    },
    calculateTokenCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens) {
      const id = model ? (canonical(model) ?? model) : model;
      return calculateTokenCost(id, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
    },
  };
}
