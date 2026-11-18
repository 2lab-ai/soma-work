/**
 * Locks the gpt-6.2-sol / gpt-6.2-astra wiring, added 2026-11-18.
 *
 * OpenAI released generation 6.2 on 2026-11-17 with two tiers, `gpt-6.2-sol`
 * (display "GPT-6.2 Sol") and `gpt-6.2-astra` ("GPT-6.2 Astra"). Per the
 * openai/codex model catalog (models.json @ 6c0cee5) their context_windows are
 * 500000 (sol) and 272000 (astra); the published 1,050,000 maximum is reached
 * through the `[1m]` opt-in. Both are served through llmux's codex backend
 * group: llmux forwards the slug verbatim and strips one trailing `[1m]`
 * before forwarding. llmux moved its own `sol` alias to gpt-6.2-sol and its
 * `astra` alias to gpt-6.2-astra[1m] on 2026-11-18.
 *
 * Load-bearing contracts:
 *   1. `sol` / `sol[1m]` / `gpt-6.2` select `gpt-6.2-sol[1m]`, and `astra` /
 *      `astra[1m]` select `gpt-6.2-astra[1m]` — a family shorthand lands on
 *      the newest `[1m]` row. The version-pinned `gpt-6.1` (→ gpt-6.1-sol[1m])
 *      and `gpt-6` / `gpt6` (→ gpt-6-astra[1m]) do not move; neither do
 *      `terra`, `luna` (6.2 has no such tiers) or `gpt` (the default,
 *      gpt-5.6-sol).
 *   2. Every older id stays selectable by its literal spelling (#656).
 *   3. Bare `gpt-6.2-sol` is a DECLARED policy row with the gpt-6.1-terra
 *      numbers (500k / 477k / 450k); bare `gpt-6.2-astra` one with the
 *      gpt-6-astra numbers (272k / 249k / 240k). The `[1m]` ids take the shared
 *      GPT 1M suffix rule (1M / 977k / 600k).
 *   4. Each has its own price row (sol $2 / $10 / $0.10, astra $8 / $40 /
 *      $0.40; no cache-write charge on the codex wire), so neither falls
 *      through to the Sonnet-rate fallback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_IDS, DEFAULT_COMPACT_HEADROOM, resolveModelProfile } from '../metrics/model-profile';
import {
  calculateTokenCost,
  findModelPricing,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt62-test-'));
  return new UserSettingsStore(dir);
}

// The llmux catalog rows as llmux advertises them from 2026-11-18: `sol` on
// the bare sol id, `astra` on the astra `[1m]` id.
const SOL_CATALOG_ROW = {
  id: 'gpt-6.2-sol',
  aliases: ['sol'],
  name: 'GPT-6.2 Sol',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  max_context: 872_000,
  group: 'codex',
};
const ASTRA_CATALOG_ROW = {
  id: 'gpt-6.2-astra[1m]',
  aliases: ['astra'],
  name: 'GPT-6.2 Astra',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  max_context: 872_000,
  group: 'codex',
};

afterEach(() => {
  modelCatalog.__testReset();
});

describe('gpt-6.2 — release wiring', () => {
  it('lists both bare ids AND both `[1m]` opt-ins as selectable ids', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-sol[1m]', 'gpt-6.2-astra', 'gpt-6.2-astra[1m]']) {
      expect(models).toContain(id);
    }
  });

  it('keeps every older sol / astra id selectable (#656)', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    for (const id of [
      'gpt-6.1-sol',
      'gpt-6.1-sol[1m]',
      'gpt-6-astra',
      'gpt-6-astra[1m]',
      'gpt-5.6-sol',
      'gpt-5.6-sol[1m]',
      'gpt-6.1-terra',
      'gpt-6.1-terra[1m]',
    ]) {
      expect(models).toContain(id);
    }
  });

  it('is SELECTABLE but NOT the default — gpt-5.6-sol stays DEFAULT_MODEL', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6-sol');
  });

  it('sol / sol[1m] / gpt-6.2 point at gpt-6.2-sol[1m]; astra / astra[1m] at gpt-6.2-astra[1m]', () => {
    expect(MODEL_ALIASES.sol).toBe('gpt-6.2-sol[1m]');
    expect(MODEL_ALIASES['sol[1m]']).toBe('gpt-6.2-sol[1m]');
    expect(MODEL_ALIASES['gpt-6.2']).toBe('gpt-6.2-sol[1m]');
    expect(MODEL_ALIASES.astra).toBe('gpt-6.2-astra[1m]');
    expect(MODEL_ALIASES['astra[1m]']).toBe('gpt-6.2-astra[1m]');
  });

  it('version-pinned and sibling aliases do not move', () => {
    expect(MODEL_ALIASES['gpt-6.1']).toBe('gpt-6.1-sol[1m]');
    expect(MODEL_ALIASES['gpt-6']).toBe('gpt-6-astra[1m]');
    expect(MODEL_ALIASES.gpt6).toBe('gpt-6-astra[1m]');
    expect(MODEL_ALIASES.terra).toBe('gpt-6.1-terra[1m]');
    expect(MODEL_ALIASES['terra[1m]']).toBe('gpt-6.1-terra[1m]');
    expect(MODEL_ALIASES.luna).toBe('gpt-6-luna[1m]');
    expect(MODEL_ALIASES['gpt-5.6']).toBe('gpt-5.6-sol');
  });

  it('resolveModelInput resolves the shorthands, case- and whitespace-insensitively', () => {
    const store = makeStore();
    expect(store.resolveModelInput('sol')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput('sol[1m]')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput('gpt-6.2')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput('  SOL[1M] ')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput(' GPT-6.2 ')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput('astra')).toBe('gpt-6.2-astra[1m]');
    expect(store.resolveModelInput('astra[1m]')).toBe('gpt-6.2-astra[1m]');
    expect(store.resolveModelInput('  ASTRA ')).toBe('gpt-6.2-astra[1m]');
    expect(store.resolveModelInput('gpt-6.1')).toBe('gpt-6.1-sol[1m]');
    expect(store.resolveModelInput('gpt-6')).toBe('gpt-6-astra[1m]');
  });

  it('accepts all four literal ids as themselves; older literals stay reachable', () => {
    const store = makeStore();
    expect(store.resolveModelInput('gpt-6.2-sol')).toBe('gpt-6.2-sol');
    expect(store.resolveModelInput('gpt-6.2-sol[1m]')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput('GPT-6.2-SOL[1M]')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput('gpt-6.2-astra')).toBe('gpt-6.2-astra');
    expect(store.resolveModelInput('gpt-6.2-astra[1m]')).toBe('gpt-6.2-astra[1m]');
    expect(store.resolveModelInput('GPT-6.2-ASTRA[1M]')).toBe('gpt-6.2-astra[1m]');
    expect(store.resolveModelInput('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(store.resolveModelInput('gpt-6-astra')).toBe('gpt-6-astra');
  });

  it('static aliases win over the llmux catalog rows that advertise `sol` / `astra`', () => {
    // Live scenario: llmux advertises `sol` on the bare 500k sol id. The
    // shorthand must still land on the `[1m]` row.
    modelCatalog.__testSeed([SOL_CATALOG_ROW, ASTRA_CATALOG_ROW]);
    const store = makeStore();
    expect(store.resolveModelInput('sol')).toBe('gpt-6.2-sol[1m]');
    expect(store.resolveModelInput('astra')).toBe('gpt-6.2-astra[1m]');
    expect(store.resolveModelInput('gpt-6.2-sol')).toBe('gpt-6.2-sol');
  });

  it('coerce round-trips all four literal ids; shorthands fall back to the default', () => {
    expect(coerceToAvailableModel('gpt-6.2-sol')).toBe('gpt-6.2-sol');
    expect(coerceToAvailableModel('GPT-6.2-SOL')).toBe('gpt-6.2-sol');
    expect(coerceToAvailableModel('gpt-6.2-sol[1m]')).toBe('gpt-6.2-sol[1m]');
    expect(coerceToAvailableModel('gpt-6.2-astra')).toBe('gpt-6.2-astra');
    expect(coerceToAvailableModel('GPT-6.2-ASTRA[1M]')).toBe('gpt-6.2-astra[1m]');
    // coerce does NOT consult MODEL_ALIASES.
    expect(coerceToAvailableModel('gpt-6.2')).toBe('gpt-5.6-sol');
    expect(coerceToAvailableModel('astra')).toBe('gpt-5.6-sol');
  });

  it('renders the curated display labels for all four ids', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('gpt-6.2-sol')).toBe('GPT-6.2 Sol (500k)');
    expect(store.getModelDisplayName('gpt-6.2-sol[1m]')).toBe('GPT-6.2 Sol (1M)');
    expect(store.getModelDisplayName('gpt-6.2-astra')).toBe('GPT-6.2 Astra (272k)');
    expect(store.getModelDisplayName('gpt-6.2-astra[1m]')).toBe('GPT-6.2 Astra (1M)');
  });
});

describe('gpt-6.2 — canonical profile', () => {
  it('bare gpt-6.2-sol is a DECLARED policy row: 500k / 477k / 450k', () => {
    expect(CANONICAL_MODEL_IDS).toContain('gpt-6.2-sol');
    expect(resolveModelProfile('gpt-6.2-sol')).toEqual({
      modelId: 'gpt-6.2-sol',
      contextWindow: 500_000,
      sdkBlockingLimit: 477_000,
      autoCompactTokens: 450_000,
      compactHeadroom: DEFAULT_COMPACT_HEADROOM,
    });
  });

  it('bare gpt-6.2-astra is a DECLARED policy row: 272k / 249k / 240k', () => {
    expect(CANONICAL_MODEL_IDS).toContain('gpt-6.2-astra');
    expect(resolveModelProfile('gpt-6.2-astra')).toEqual({
      modelId: 'gpt-6.2-astra',
      contextWindow: 272_000,
      sdkBlockingLimit: 249_000,
      autoCompactTokens: 240_000,
      compactHeadroom: DEFAULT_COMPACT_HEADROOM,
    });
  });

  it('bare ids match the rows of the same catalog window (6.1-terra, 6-astra)', () => {
    const pairs: Array<[string, string]> = [
      ['gpt-6.2-sol', 'gpt-6.1-terra'],
      ['gpt-6.2-astra', 'gpt-6-astra'],
    ];
    for (const [id, twin] of pairs) {
      const p = resolveModelProfile(id);
      const t = resolveModelProfile(twin);
      expect(p.contextWindow).toBe(t.contextWindow);
      expect(p.sdkBlockingLimit).toBe(t.sdkBlockingLimit);
      expect(p.autoCompactTokens).toBe(t.autoCompactTokens);
    }
  });

  it('[1m] ids derive the shared GPT 1M profile (no canonical row), like 6.1', () => {
    for (const id of ['gpt-6.2-sol[1m]', 'gpt-6.2-astra[1m]']) {
      expect(CANONICAL_MODEL_IDS).not.toContain(id);
      const p = resolveModelProfile(id);
      expect(p.contextWindow).toBe(1_000_000);
      expect(p.sdkBlockingLimit).toBe(977_000);
      expect(p.autoCompactTokens).toBe(600_000);
      const ref = resolveModelProfile('gpt-6.1-sol[1m]');
      expect([p.contextWindow, p.sdkBlockingLimit, p.autoCompactTokens]).toEqual([
        ref.contextWindow,
        ref.sdkBlockingLimit,
        ref.autoCompactTokens,
      ]);
    }
  });

  it('registry delegates resolve the same numbers', () => {
    expect(resolveContextWindow('gpt-6.2-sol')).toBe(500_000);
    expect(resolveAutoCompactTokens('gpt-6.2-sol')).toBe(450_000);
    expect(resolveContextWindow('gpt-6.2-astra')).toBe(272_000);
    expect(resolveAutoCompactTokens('gpt-6.2-astra')).toBe(240_000);
    expect(resolveContextWindow('gpt-6.2-sol[1m]')).toBe(1_000_000);
    expect(resolveAutoCompactTokens('gpt-6.2-astra[1m]')).toBe(600_000);
  });

  it('declared triggers are reachable — not clamped by the session policy', () => {
    // 477,000 − 9,000 headroom = 468,000 ≥ 450,000; 249,000 − 9,000 = 240,000.
    expect(safeMaxAutoCompactTokens('gpt-6.2-sol')).toBe(468_000);
    expect(safeMaxAutoCompactTokens('gpt-6.2-astra')).toBe(240_000);
  });

  it('a catalog window does not override the declared rows', () => {
    modelCatalog.__testSeed([
      { ...SOL_CATALOG_ROW, aliases: [] },
      { ...ASTRA_CATALOG_ROW, id: 'gpt-6.2-astra', aliases: [] },
    ]);
    expect(resolveContextWindow('gpt-6.2-sol')).toBe(500_000);
    expect(resolveContextWindow('gpt-6.2-astra')).toBe(272_000);
  });

  it('no family rule matches gpt-6.2 — the declared rows are what size it', () => {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      expect(isGpt6Model(id)).toBe(false);
      expect(isGpt56Model(id)).toBe(false);
      expect(isGpt55Model(id)).toBe(false);
      expect(isNativeOneMModel(id)).toBe(false);
    }
  });

  it('compatibility tier accepts the bare ids and has no opinion on the [1m] ids', () => {
    expect(resolveModelInputCompatibility('gpt-6.2-sol')).toEqual({ modelId: 'gpt-6.2-sol' });
    expect(resolveModelInputCompatibility('gpt-6.2-astra')).toEqual({ modelId: 'gpt-6.2-astra' });
    expect(resolveModelInputCompatibility('gpt-6.2-sol[1m]')).toBeNull();
    expect(resolveModelInputCompatibility('gpt-6.2-astra[1m]')).toBeNull();
  });
});

describe('gpt-6.2 — model-registry pricing', () => {
  it('gpt-6.2-sol: $2 in / $10 out / $0.10 cache-read, no cache-write charge, for both ids', () => {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-sol[1m]']) {
      expect(hasModelPricing(id)).toBe(true);
      const spec = getModelSpec(id);
      expect([
        spec.pricing.inputPerMTok,
        spec.pricing.outputPerMTok,
        spec.pricing.cacheReadPerMTok,
        spec.pricing.cache5minWritePerMTok,
        spec.pricing.cache1hrWritePerMTok,
      ]).toEqual([2, 10, 0.1, 0, 0]);
      expect(spec.contextWindow).toBe(500_000);
      expect(spec.maxOutput).toBe(128_000);
    }
  });

  it('gpt-6.2-astra: $8 in / $40 out / $0.40 cache-read, no cache-write charge, for both ids', () => {
    for (const id of ['gpt-6.2-astra', 'gpt-6.2-astra[1m]']) {
      expect(hasModelPricing(id)).toBe(true);
      const spec = getModelSpec(id);
      expect([
        spec.pricing.inputPerMTok,
        spec.pricing.outputPerMTok,
        spec.pricing.cacheReadPerMTok,
        spec.pricing.cache5minWritePerMTok,
        spec.pricing.cache1hrWritePerMTok,
      ]).toEqual([8, 40, 0.4, 0, 0]);
      expect(spec.contextWindow).toBe(272_000);
      expect(spec.maxOutput).toBe(128_000);
    }
  });

  it('prices one million of each token class; cache creation costs nothing', () => {
    expect(calculateTokenCost('gpt-6.2-sol', 1e6, 1e6, 1e6, 1e6)).toBeCloseTo(2 + 10 + 0.1, 6);
    expect(calculateTokenCost('gpt-6.2-astra[1m]', 1e6, 1e6, 1e6, 1e6)).toBeCloseTo(8 + 40 + 0.4, 6);
  });

  it('the price picker sees a registry row, not the Sonnet fallback', () => {
    expect(findModelPricing('gpt-6.2-sol')?.inputPerMTok).toBe(2);
    expect(findModelPricing('gpt-6.2-astra')?.inputPerMTok).toBe(8);
  });

  it('does not shadow the older sol / astra / terra rows', () => {
    expect(getModelSpec('gpt-6-astra').pricing.inputPerMTok).toBe(10);
    expect(getModelSpec('gpt-6-astra[1m]').pricing.inputPerMTok).toBe(10);
    expect(getModelSpec('gpt-6-sol').pricing.cacheReadPerMTok).toBe(0.2);
    expect(getModelSpec('gpt-6.1-sol').pricing.cacheReadPerMTok).toBe(0.1);
    expect(getModelSpec('gpt-6.1-terra').pricing.inputPerMTok).toBe(1);
    expect(getModelSpec('gpt-5.6-sol').pricing.inputPerMTok).toBe(5);
  });
});
