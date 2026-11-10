/**
 * Locks the gpt-6.1-terra wiring, added 2026-11-10.
 *
 * `gpt-6.1-terra` (display "GPT-6.1 Terra") is generation 6.1's mid tier,
 * released 2026-10-26. Per the openai/codex model catalog (models.json @
 * caae161d) its context_window is 500000 — NOT the 272k of gpt-6.1-sol /
 * gpt-6-astra — and the published 1,050,000 maximum is reached through the
 * `[1m]` opt-in. It is served through llmux's codex backend group: llmux
 * forwards the slug verbatim and strips one trailing `[1m]` before forwarding.
 * llmux moved its own `terra` alias to it on 2026-11-10.
 *
 * Load-bearing contracts:
 *   1. The `terra` / `terra[1m]` shorthands select `gpt-6.1-terra[1m]` — a
 *      family shorthand lands on the newest `[1m]` row (same rule as `sol` →
 *      `gpt-6.1-sol[1m]`, `astra` → `gpt-6-astra[1m]`).
 *   2. gpt-5.6-terra stays selectable by its literal id; the DEFAULT stays
 *      gpt-5.6-sol and the `gpt` alias do not move (`luna` follows gpt-6-luna).
 *   3. Bare `gpt-6.1-terra` is a DECLARED policy row (500k / 477k / 450k — the
 *      grok-4.6 numbers for the same window), so it never drops to the 200k
 *      fallback or to a catalog window. The `[1m]` id takes the shared GPT 1M
 *      suffix rule.
 *   4. Pricing has its own row ($1 / $5 / $0.05, no cache-write charge on the
 *      codex wire), so it never falls through to the Sonnet-rate fallback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_IDS, DEFAULT_COMPACT_HEADROOM, resolveModelProfile } from '../metrics/model-profile';
import {
  calculateTokenCost,
  getModelSpec,
  hasModelPricing,
  isGpt6Model,
  isGpt55Model,
  isGpt56Model,
  isNativeOneMModel,
  resolveAutoCompactTokens,
  resolveContextWindow,
  resolveModelInputCompatibility,
} from '../metrics/model-registry';
import { modelCatalog } from '../model-catalog';
import { safeMaxAutoCompactTokens } from '../session/autocompact-policy';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  UserSettingsStore,
} from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt61terra-test-'));
  return new UserSettingsStore(dir);
}

const TERRA_CATALOG_ROW = {
  id: 'gpt-6.1-terra',
  aliases: ['terra'],
  name: 'GPT-6.1 Terra',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  max_context: 872_000,
  group: 'codex',
};

afterEach(() => {
  modelCatalog.__testReset();
});

describe('gpt-6.1-terra — release wiring', () => {
  it('lists the bare id AND the `[1m]` opt-in as selectable ids', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    expect(models).toContain('gpt-6.1-terra');
    expect(models).toContain('gpt-6.1-terra[1m]');
    // The previous terra generation stays selectable by its literal id.
    expect(models).toContain('gpt-5.6-terra');
  });

  it('is SELECTABLE but NOT the default — gpt-5.6-sol stays DEFAULT_MODEL', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6-sol');
  });

  it('terra / terra[1m] point at the newest [1m] row; sibling aliases do not move', () => {
    expect(MODEL_ALIASES.terra).toBe('gpt-6.1-terra[1m]');
    expect(MODEL_ALIASES['terra[1m]']).toBe('gpt-6.1-terra[1m]');
    // `gpt-6.1` stays on sol — sol is generation 6.1's flagship.
    expect(MODEL_ALIASES['gpt-6.1']).toBe('gpt-6.1-sol[1m]');
    expect(MODEL_ALIASES.sol).toBe('gpt-6.1-sol[1m]');
    expect(MODEL_ALIASES.luna).toBe('gpt-6-luna[1m]');
    expect(MODEL_ALIASES.astra).toBe('gpt-6-astra[1m]');
  });

  it('resolveModelInput resolves the shorthands to gpt-6.1-terra[1m]', () => {
    const store = makeStore();
    expect(store.resolveModelInput('terra')).toBe('gpt-6.1-terra[1m]');
    expect(store.resolveModelInput('terra[1m]')).toBe('gpt-6.1-terra[1m]');
    expect(store.resolveModelInput('  TERRA ')).toBe('gpt-6.1-terra[1m]');
    expect(store.resolveModelInput('  TERRA[1M] ')).toBe('gpt-6.1-terra[1m]');
  });

  it('accepts both literal ids as themselves; gpt-5.6-terra stays reachable', () => {
    const store = makeStore();
    expect(store.resolveModelInput('gpt-6.1-terra')).toBe('gpt-6.1-terra');
    expect(store.resolveModelInput('gpt-6.1-terra[1m]')).toBe('gpt-6.1-terra[1m]');
    expect(store.resolveModelInput('GPT-6.1-TERRA[1M]')).toBe('gpt-6.1-terra[1m]');
    expect(store.resolveModelInput('gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });

  it('static aliases win over an llmux catalog that advertises `terra` on the bare id', () => {
    // Live scenario: llmux advertises `gpt-6.1-terra` with alias `terra`. The
    // shorthand must still land on the `[1m]` row, not the 500k bare id.
    modelCatalog.__testSeed([TERRA_CATALOG_ROW]);
    const store = makeStore();
    expect(store.resolveModelInput('terra')).toBe('gpt-6.1-terra[1m]');
    expect(store.resolveModelInput('gpt-6.1-terra')).toBe('gpt-6.1-terra');
  });

  it('coerce round-trips both literal ids; the shorthand falls back to the default', () => {
    expect(coerceToAvailableModel('gpt-6.1-terra')).toBe('gpt-6.1-terra');
    expect(coerceToAvailableModel('GPT-6.1-TERRA')).toBe('gpt-6.1-terra');
    expect(coerceToAvailableModel('gpt-6.1-terra[1m]')).toBe('gpt-6.1-terra[1m]');
    expect(coerceToAvailableModel('GPT-6.1-TERRA[1M]')).toBe('gpt-6.1-terra[1m]');
    // coerce does NOT consult MODEL_ALIASES.
    expect(coerceToAvailableModel('terra')).toBe('gpt-5.6-sol');
    expect(coerceToAvailableModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });

  it('renders the curated display labels for both variants', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('gpt-6.1-terra')).toBe('GPT-6.1 Terra (500k)');
    expect(store.getModelDisplayName('gpt-6.1-terra[1m]')).toBe('GPT-6.1 Terra (1M)');
    expect(store.getModelDisplayName('gpt-5.6-terra')).toBe('GPT-5.6 Terra (372k)');
  });
});

describe('gpt-6.1-terra — canonical profile', () => {
  it('bare id is a DECLARED policy row: 500k / 477k / 450k', () => {
    expect(CANONICAL_MODEL_IDS).toContain('gpt-6.1-terra');
    expect(resolveModelProfile('gpt-6.1-terra')).toEqual({
      modelId: 'gpt-6.1-terra',
      contextWindow: 500_000,
      sdkBlockingLimit: 477_000,
      autoCompactTokens: 450_000,
      compactHeadroom: DEFAULT_COMPACT_HEADROOM,
    });
  });

  it('bare id matches the grok-4.6 numbers — the other declared 500k row', () => {
    const terra = resolveModelProfile('gpt-6.1-terra');
    const grok = resolveModelProfile('grok-4.6');
    expect(terra.contextWindow).toBe(grok.contextWindow);
    expect(terra.sdkBlockingLimit).toBe(grok.sdkBlockingLimit);
    expect(terra.autoCompactTokens).toBe(grok.autoCompactTokens);
  });

  it('[1m] id derives the shared GPT 1M profile (no canonical row)', () => {
    expect(CANONICAL_MODEL_IDS).not.toContain('gpt-6.1-terra[1m]');
    const p = resolveModelProfile('gpt-6.1-terra[1m]');
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.sdkBlockingLimit).toBe(977_000);
    expect(p.autoCompactTokens).toBe(600_000);
  });

  it('registry delegates resolve the same numbers', () => {
    expect(resolveContextWindow('gpt-6.1-terra')).toBe(500_000);
    expect(resolveAutoCompactTokens('gpt-6.1-terra')).toBe(450_000);
    expect(resolveContextWindow('gpt-6.1-terra[1m]')).toBe(1_000_000);
    expect(resolveAutoCompactTokens('gpt-6.1-terra[1m]')).toBe(600_000);
  });

  it('declared trigger is reachable — not clamped by the session policy', () => {
    // 477,000 − 9,000 headroom = 468,000 ≥ 450,000.
    expect(safeMaxAutoCompactTokens('gpt-6.1-terra')).toBe(468_000);
    expect(safeMaxAutoCompactTokens('gpt-6.1-terra')).toBeGreaterThanOrEqual(450_000);
  });

  it('a different catalog window does not override the declared 500k', () => {
    modelCatalog.__testSeed([TERRA_CATALOG_ROW]);
    expect(resolveContextWindow('gpt-6.1-terra')).toBe(500_000);
  });

  it('without the declared row the bare id would have no family rule (gpt-6.1 is not gpt-6)', () => {
    // GPT_6_RE pins the generation boundary — `gpt-6.1-*` is not matched, so
    // the declared row above is what sizes the bare id.
    expect(isGpt6Model('gpt-6.1-terra')).toBe(false);
    expect(isGpt56Model('gpt-6.1-terra')).toBe(false);
    expect(isGpt55Model('gpt-6.1-terra')).toBe(false);
    expect(isNativeOneMModel('gpt-6.1-terra')).toBe(false);
  });

  it('compatibility tier accepts the bare id and has no opinion on the [1m] id', () => {
    expect(resolveModelInputCompatibility('gpt-6.1-terra')).toEqual({ modelId: 'gpt-6.1-terra' });
    expect(resolveModelInputCompatibility('gpt-6.1-terra[1m]')).toBeNull();
  });
});

describe('gpt-6.1-terra — model-registry pricing', () => {
  it('$1 in / $5 out / $0.05 cache-read, no cache-write charge, for both ids', () => {
    for (const id of ['gpt-6.1-terra', 'gpt-6.1-terra[1m]']) {
      expect(hasModelPricing(id)).toBe(true);
      const spec = getModelSpec(id);
      expect([
        spec.pricing.inputPerMTok,
        spec.pricing.outputPerMTok,
        spec.pricing.cacheReadPerMTok,
        spec.pricing.cache5minWritePerMTok,
        spec.pricing.cache1hrWritePerMTok,
      ]).toEqual([1, 5, 0.05, 0, 0]);
      expect(spec.contextWindow).toBe(500_000);
      expect(spec.maxOutput).toBe(128_000);
    }
  });

  it('prices one million of each token class; cache creation costs nothing', () => {
    expect(calculateTokenCost('gpt-6.1-terra', 1e6, 1e6, 1e6, 1e6)).toBeCloseTo(1 + 5 + 0.05, 6);
  });

  it('does not shadow gpt-6.1-sol or gpt-5.6-terra', () => {
    expect(getModelSpec('gpt-6.1-sol').pricing.inputPerMTok).toBe(2);
    expect(getModelSpec('gpt-6.1-sol[1m]').pricing.inputPerMTok).toBe(2);
    expect(getModelSpec('gpt-5.6-terra').pricing.inputPerMTok).toBe(2.5);
  });
});
