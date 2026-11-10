/**
 * Locks the sonnet / haiku / luna shorthands to the llmux alias owners
 * (2026-11-10, issue #1120).
 *
 * The llmux gateway moved `sonnet` to Sonnet 5.5 (2026-09-23), `haiku` to
 * Haiku 5.5 (2026-10-08) and `luna` to gpt-6-luna (2026-10-06); soma-work kept
 * Sonnet 4.6, Haiku 4.5 and gpt-5.6-luna, so the same word picked an older
 * model here than llmux serves under it.
 *
 * Load-bearing contracts:
 *   1. Each shorthand (and its `[1m]` spelling) lands on the newest `[1m]` row
 *      — the same rule as opus / fable / sol / terra / astra.
 *   2. The older generations stay selectable: `sonnet-4.6*`, `sonnet-4.5`,
 *      `haiku-4.5` stay pinned; the literal ids stay in AVAILABLE_MODELS.
 *   3. Declared Claude 1M policy for the two claude `[1m]` targets (1M /
 *      977k / 750k); gpt-6-luna takes the generation-6 rule (272k / 240k bare,
 *      shared GPT 1M for `[1m]`).
 *   4. Own price rows for Sonnet 5.5 and Haiku 5.5 (they fell to the Sonnet
 *      fallback before); gpt-6-luna already had one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_IDS, resolveModelProfile } from '../metrics/model-profile';
import { calculateTokenCost, findModelPricing } from '../metrics/model-registry';
import { modelCatalog } from '../model-catalog';
import { AVAILABLE_MODELS, coerceToAvailableModel, MODEL_ALIASES, UserSettingsStore } from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-llmux-test-'));
  return new UserSettingsStore(dir);
}

afterEach(() => {
  modelCatalog.__testReset();
});

/** llmux `GET /llmux/models` alias owners, 2026-11-10. */
const LLMUX_OWNERS: Record<string, string> = {
  sonnet: 'claude-sonnet-5-5[1m]',
  haiku: 'claude-haiku-5-5[1m]',
  luna: 'gpt-6-luna[1m]',
};

describe('shorthands follow the llmux alias owners', () => {
  for (const [alias, owner] of Object.entries(LLMUX_OWNERS)) {
    it(`${alias} and ${alias}[1m] select ${owner}`, () => {
      expect(MODEL_ALIASES[alias]).toBe(owner);
      expect(MODEL_ALIASES[`${alias}[1m]`]).toBe(owner);
      const store = makeStore();
      expect(store.resolveModelInput(alias)).toBe(owner);
      expect(store.resolveModelInput(`${alias}[1m]`)).toBe(owner);
    });
  }

  it('version-pinned spellings select their own generation', () => {
    expect(MODEL_ALIASES['sonnet-5-5']).toBe('claude-sonnet-5-5[1m]');
    expect(MODEL_ALIASES['haiku-5-5']).toBe('claude-haiku-5-5[1m]');
    expect(MODEL_ALIASES['sonnet-4.6']).toBe('claude-sonnet-4-6');
    expect(MODEL_ALIASES['sonnet-4.6[1m]']).toBe('claude-sonnet-4-6[1m]');
    expect(MODEL_ALIASES['sonnet-4.5']).toBe('claude-sonnet-4-5-20250929');
    expect(MODEL_ALIASES['haiku-4.5']).toBe('claude-haiku-4-5-20251001');
  });

  it('new and old literal ids are all selectable and round-trip', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    for (const id of [
      'claude-sonnet-5-5',
      'claude-sonnet-5-5[1m]',
      'claude-haiku-5-5',
      'claude-haiku-5-5[1m]',
      'gpt-6-luna',
      'gpt-6-luna[1m]',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6[1m]',
      'claude-haiku-4-5-20251001',
      'gpt-5.6-luna',
    ]) {
      expect(models).toContain(id);
      expect(coerceToAvailableModel(id)).toBe(id);
    }
  });

  it('renders curated display labels', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)');
    expect(store.getModelDisplayName('claude-haiku-5-5[1m]')).toBe('Haiku 5.5 (1M)');
    expect(store.getModelDisplayName('gpt-6-luna[1m]')).toBe('GPT-6 Luna (1M)');
    expect(store.getModelDisplayName('gpt-6-luna')).toBe('GPT-6 Luna (272k)');
  });
});

describe('profiles of the new targets', () => {
  it('claude [1m] targets are declared 1M / 977k / 750k rows', () => {
    for (const id of ['claude-sonnet-5-5[1m]', 'claude-haiku-5-5[1m]']) {
      expect(CANONICAL_MODEL_IDS).toContain(id);
      const p = resolveModelProfile(id);
      expect([p.contextWindow, p.sdkBlockingLimit, p.autoCompactTokens]).toEqual([1_000_000, 977_000, 750_000]);
    }
  });

  it('bare claude-sonnet-5-5 keeps the 200k contract of bare sonnet', () => {
    expect(resolveModelProfile('claude-sonnet-5-5').contextWindow).toBe(200_000);
    expect(resolveModelProfile('claude-sonnet-5-5').autoCompactTokens).toBeUndefined();
  });

  it('gpt-6-luna takes the generation-6 rule; its [1m] row the shared GPT 1M policy', () => {
    const bare = resolveModelProfile('gpt-6-luna');
    expect([bare.contextWindow, bare.autoCompactTokens]).toEqual([272_000, 240_000]);
    const oneM = resolveModelProfile('gpt-6-luna[1m]');
    expect([oneM.contextWindow, oneM.sdkBlockingLimit, oneM.autoCompactTokens]).toEqual([1_000_000, 977_000, 600_000]);
  });
});

describe('pricing of the new targets', () => {
  it('Sonnet 5.5: $2 / $10 / $0.10 / $2.50 / $4', () => {
    expect(findModelPricing('claude-sonnet-5-5[1m]')).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.1,
      cache5minWritePerMTok: 2.5,
      cache1hrWritePerMTok: 4,
    });
  });

  it('Haiku 5.5: $0.10 / $0.50 / $0.01 / $0.125 / $0.20', () => {
    expect(findModelPricing('claude-haiku-5-5')).toMatchObject({
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      cacheReadPerMTok: 0.01,
      cache5minWritePerMTok: 0.125,
      cache1hrWritePerMTok: 0.2,
    });
    // 1M of each class: 0.10 + 0.50 + 0.01 + 0.125
    expect(calculateTokenCost('claude-haiku-5-5[1m]', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(
      0.735,
      6,
    );
  });

  it('does not change Sonnet 4.6 pricing', () => {
    expect(findModelPricing('claude-sonnet-4-6')).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
  });
});
