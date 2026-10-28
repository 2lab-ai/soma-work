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
      // The SDK may report an id without the `[1m]` suffix the catalog lists it under.
      return catalog.resolveInput(model) ?? (/\[1m\]$/i.test(model) ? null : catalog.resolveInput(`${model}[1m]`));
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

/** One model's saved SDK running total (`@soma/slack/session-usage-math` `ModelUsageCounters`). */
interface RunningTotal {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/**
 * A saved SDK running total (`sdkUsageBaseline`) with every host-priced
 * model's cost recomputed from its saved tokens. Run on load: a total saved
 * while the SDK still priced an llmux model would make the next result's delta
 * carry the repricing of the whole history — up into one turn (astra), or a
 * turn read as 0 and the old price kept for good (grok). Host pricing is
 * linear in tokens, so after this the delta is the new price of the new tokens
 * only. A copy; the input is not changed.
 */
export function repriceBaseline<B extends { models: Record<string, RunningTotal> }>(
  baseline: B | undefined,
  pricing: HostPricing,
): B | undefined {
  if (!baseline) return baseline;
  const models: Record<string, RunningTotal> = {};
  for (const [model, c] of Object.entries(baseline.models)) {
    let cost = c.costUsd;
    try {
      if (pricing.hostPriced(model)) {
        const p = pricing.calculateTokenCost(
          model,
          c.inputTokens,
          c.outputTokens,
          c.cacheReadInputTokens,
          c.cacheCreationInputTokens,
        );
        if (Number.isFinite(p) && p >= 0) cost = p;
      }
    } catch {
      // Pricing is a display number: a failure keeps the saved cost.
    }
    models[model] = { ...c, costUsd: cost };
  }
  return { ...baseline, models };
}
