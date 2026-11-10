/**
 * Locks the grok-4.7 wiring, added 2026-11-10.
 *
 * `grok-4.7` was released by xAI on 2026-09-21 (docs.x.ai model page: 500,000
 * context, $2 in / $6 out / $0.50 cached below 200k) and has been the llmux
 * grok pin — the owner of the `grok` alias — since 2026-09-23. soma-work kept
 * `grok-4.6` as its representative grok, so the dashboard `grok[1m]` nickname
 * and the featured model-card button still selected the older model.
 *
 * Load-bearing contracts:
 *   1. `grok-4.7` is a static, selectable id (cold start without a catalog
 *      snapshot still knows it); `grok-4.6` stays selectable by its literal id.
 *   2. The representative grok is `grok-4.7`: the featured model-card value
 *      and the dashboard `grok[1m]` nickname both select it.
 *   3. It is a DECLARED policy row with the 500k / 477k / 450k numbers.
 *   4. `grok-4.7[1m]` is refused with a visible `use grok-4.7` suggestion,
 *      exactly like `grok-4.6[1m]` (xAI has no 1M window).
 *   5. Pricing has its own row ($2 / $6 / $0.50, no cache-write charge).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_IDS, DEFAULT_COMPACT_HEADROOM, resolveModelProfile } from '../metrics/model-profile';
import { calculateTokenCost, hasModelPricing, resolveModelInputCompatibility } from '../metrics/model-registry';
import { modelCatalog } from '../model-catalog';
import { listRepresentativeModels, REPRESENTATIVE_MODEL_NICKNAMES } from '../session/model-switch';
import { FEATURED_ALIASES } from '../slack/z/topics/model-topic';
import { AVAILABLE_MODELS, coerceToAvailableModel, DEFAULT_MODEL, UserSettingsStore } from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok47-test-'));
  return new UserSettingsStore(dir);
}

afterEach(() => {
  modelCatalog.__testReset();
});

describe('grok-4.7 — release wiring', () => {
  it('is a static selectable id next to grok-4.6', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    expect(models).toContain('grok-4.7');
    expect(models).toContain('grok-4.6');
    expect(models.indexOf('grok-4.7')).toBeLessThan(models.indexOf('grok-4.6'));
  });

  it('is selectable but not the default', () => {
    expect(DEFAULT_MODEL).not.toBe('grok-4.7');
  });

  it('resolves and round-trips as itself without a catalog snapshot; grok-4.6 stays reachable', () => {
    const store = makeStore();
    expect(store.resolveModelInput('grok-4.7')).toBe('grok-4.7');
    expect(store.resolveModelInput('grok-4.6')).toBe('grok-4.6');
    expect(coerceToAvailableModel('grok-4.7')).toBe('grok-4.7');
    expect(coerceToAvailableModel('GROK-4.7')).toBe('grok-4.7');
  });

  it('renders a curated display label', () => {
    expect(makeStore().getModelDisplayName('grok-4.7')).toBe('Grok 4.7 (500k)');
  });
});

describe('grok-4.7 — the representative grok', () => {
  it('the featured model-card value is grok-4.7, not grok-4.6', () => {
    expect([...FEATURED_ALIASES]).toContain('grok-4.7');
    expect([...FEATURED_ALIASES]).not.toContain('grok-4.6');
  });

  it('the dashboard grok[1m] nickname resolves to grok-4.7 with its 500k / 450k profile', () => {
    expect([...REPRESENTATIVE_MODEL_NICKNAMES]).toContain('grok[1m]');
    const store = makeStore();
    const reps = listRepresentativeModels({
      resolveModel: (input) => store.resolveModelInput(input),
      contextWindow: (model) => resolveModelProfile(model).contextWindow,
      autoCompactFor: (model) => resolveModelProfile(model).autoCompactTokens ?? 0,
      displayName: (model) => store.getModelDisplayName(model),
    });
    const grok = reps.find((r) => r.nickname === 'grok[1m]');
    expect(grok?.model).toBe('grok-4.7');
    expect(grok?.contextWindow).toBe(500_000);
    expect(grok?.autoCompactTokens).toBe(450_000);
  });
});

describe('grok-4.7 — canonical profile', () => {
  it('is a DECLARED policy row: 500k / 477k / 450k', () => {
    expect(CANONICAL_MODEL_IDS).toContain('grok-4.7');
    const profile = resolveModelProfile('grok-4.7');
    expect(profile.contextWindow).toBe(500_000);
    expect(profile.sdkBlockingLimit).toBe(477_000);
    expect(profile.autoCompactTokens).toBe(450_000);
    expect(profile.compactHeadroom).toBe(DEFAULT_COMPACT_HEADROOM);
  });

  it('matches grok-4.6 — same 500k xAI window', () => {
    const a = resolveModelProfile('grok-4.7');
    const b = resolveModelProfile('grok-4.6');
    expect([a.contextWindow, a.sdkBlockingLimit, a.autoCompactTokens]).toEqual([
      b.contextWindow,
      b.sdkBlockingLimit,
      b.autoCompactTokens,
    ]);
  });

  it('grok-4.7[1m] is refused with a visible `use grok-4.7` suggestion', () => {
    const result = resolveModelInputCompatibility('grok-4.7[1m]');
    expect(result && 'rejectedReason' in result).toBe(true);
    expect(result && 'suggestedModel' in result ? result.suggestedModel : null).toBe('grok-4.7');
    expect(coerceToAvailableModel('grok-4.7[1m]')).toBe(DEFAULT_MODEL);
  });
});

describe('grok-4.7 — pricing', () => {
  it('$2 in / $6 out / $0.50 cache-read, no cache-write charge', () => {
    expect(hasModelPricing('grok-4.7')).toBe(true);
    expect(calculateTokenCost('grok-4.7', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(8.5, 6);
  });
});
