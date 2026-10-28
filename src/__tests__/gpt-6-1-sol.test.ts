/**
 * Locks the gpt-6.1-sol wiring, added 2026-10-14.
 *
 * `gpt-6.1-sol` (display "GPT-6.1 Sol") is the newest gpt sol generation. Per
 * the openai/codex model catalog its context_window is 272000 — the same class
 * as gpt-6-astra — and the published 1,050,000 maximum is reached through the
 * `[1m]` opt-in. It is served through llmux's codex backend group: llmux
 * forwards the slug verbatim and strips one trailing `[1m]` before forwarding.
 *
 * Load-bearing contracts:
 *   1. The `sol` / `sol[1m]` / `gpt-6.1` shorthands select `gpt-6.1-sol[1m]` —
 *      a family shorthand always lands on the newest `[1m]` row (same rule as
 *      `astra` → `gpt-6-astra[1m]`, `fable` → `claude-fable-5-1[1m]`). The
 *      upstream gateway moved its own `sol` alias to gpt-6.1-sol on 2026-10-06.
 *   2. The DEFAULT stays gpt-5.6-sol — the `gpt` alias is intentionally NOT
 *      bumped, and the literal gpt-5.6-sol ids stay selectable.
 *   3. Bare `gpt-6.1-sol` is a DECLARED policy row (the `[1m]` id takes the
 *      shared GPT 1M suffix rule), so it never drops to the 200k fallback or
 *      to a catalog window, and pricing never falls through to the
 *      Sonnet-rate fallback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CANONICAL_MODEL_IDS, DEFAULT_COMPACT_HEADROOM, resolveModelProfile } from '../metrics/model-profile';
import {
  getModelSpec,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt61-test-'));
  return new UserSettingsStore(dir);
}

afterEach(() => {
  modelCatalog.__testReset();
});

describe('gpt-6.1-sol — release wiring', () => {
  it('lists the bare id AND the `[1m]` opt-in as selectable ids', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    expect(models).toContain('gpt-6.1-sol');
    expect(models).toContain('gpt-6.1-sol[1m]');
    // The previous sol generation stays selectable by its literal ids.
    expect(models).toContain('gpt-5.6-sol');
    expect(models).toContain('gpt-5.6-sol[1m]');
  });

  it('is SELECTABLE but NOT the default — gpt-5.6-sol stays DEFAULT_MODEL', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.gpt).toBe('gpt-5.6-sol');
  });

  it('sol / sol[1m] / gpt-6.1 aliases point at the newest [1m] row', () => {
    expect(MODEL_ALIASES.sol).toBe('gpt-6.1-sol[1m]');
    expect(MODEL_ALIASES['sol[1m]']).toBe('gpt-6.1-sol[1m]');
    expect(MODEL_ALIASES['gpt-6.1']).toBe('gpt-6.1-sol[1m]');
    // Version-pinned gpt-5.6 spellings must NOT be silently upgraded.
    expect(MODEL_ALIASES['gpt-5.6']).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES['gpt5.6']).toBe('gpt-5.6-sol');
    expect(MODEL_ALIASES.terra).toBe('gpt-5.6-terra');
    expect(MODEL_ALIASES.luna).toBe('gpt-5.6-luna');
  });

  it('resolveModelInput resolves the shorthands to gpt-6.1-sol[1m]', () => {
    const store = makeStore();
    expect(store.resolveModelInput('sol')).toBe('gpt-6.1-sol[1m]');
    expect(store.resolveModelInput('sol[1m]')).toBe('gpt-6.1-sol[1m]');
    expect(store.resolveModelInput('gpt-6.1')).toBe('gpt-6.1-sol[1m]');
    // Case/whitespace symmetry.
    expect(store.resolveModelInput('  SOL ')).toBe('gpt-6.1-sol[1m]');
    expect(store.resolveModelInput('  SOL[1M] ')).toBe('gpt-6.1-sol[1m]');
    expect(store.resolveModelInput(' GPT-6.1 ')).toBe('gpt-6.1-sol[1m]');
  });

  it('accepts both literal ids as themselves', () => {
    const store = makeStore();
    // Literal bare id — the caller explicitly asked for the 272k profile.
    expect(store.resolveModelInput('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(store.resolveModelInput('gpt-6.1-sol[1m]')).toBe('gpt-6.1-sol[1m]');
    expect(store.resolveModelInput('GPT-6.1-SOL[1M]')).toBe('gpt-6.1-sol[1m]');
  });

  it('static aliases win over an llmux catalog that advertises `sol` on the bare id', () => {
    // Live scenario: llmux advertises `gpt-6.1-sol` with alias `sol`. The
    // shorthand must still land on the `[1m]` row, not the 272k bare id.
    modelCatalog.__testSeed([
      { id: 'gpt-6.1-sol', aliases: ['sol'], name: 'GPT-6.1 Sol', efforts: [], max_context: 400_000, group: 'codex' },
    ]);
    const store = makeStore();
    expect(store.resolveModelInput('sol')).toBe('gpt-6.1-sol[1m]');
    expect(store.resolveModelInput('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });

  it('the gpt-5.6-sol literals still resolve to themselves', () => {
    const store = makeStore();
    expect(store.resolveModelInput('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(store.resolveModelInput('gpt-5.6-sol[1m]')).toBe('gpt-5.6-sol[1m]');
    expect(store.resolveModelInput('gpt')).toBe('gpt-5.6-sol');
  });

  it('coerce round-trips both literal ids; the bare generation spelling falls back to the default', () => {
    expect(coerceToAvailableModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(coerceToAvailableModel('GPT-6.1-SOL')).toBe('gpt-6.1-sol');
    expect(coerceToAvailableModel('gpt-6.1-sol[1m]')).toBe('gpt-6.1-sol[1m]');
    expect(coerceToAvailableModel('GPT-6.1-SOL[1M]')).toBe('gpt-6.1-sol[1m]');
    // coerce does NOT consult MODEL_ALIASES.
    expect(coerceToAvailableModel('gpt-6.1')).toBe('gpt-5.6-sol');
  });

  it('renders the curated display labels for both variants', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('gpt-6.1-sol')).toBe('GPT-6.1 Sol (272k)');
    expect(store.getModelDisplayName('gpt-6.1-sol[1m]')).toBe('GPT-6.1 Sol (1M)');
  });
});

describe('gpt-6.1-sol — canonical profile', () => {
  it('bare id is a DECLARED policy row: 272k / 249k / 240k', () => {
    expect(CANONICAL_MODEL_IDS).toContain('gpt-6.1-sol');
    const p = resolveModelProfile('gpt-6.1-sol');
    expect(p.modelId).toBe('gpt-6.1-sol');
    expect(p.contextWindow).toBe(272_000);
    expect(p.sdkBlockingLimit).toBe(249_000);
    expect(p.autoCompactTokens).toBe(240_000);
    expect(p.compactHeadroom).toBe(DEFAULT_COMPACT_HEADROOM);
  });

  it('bare id matches gpt-6-astra numbers', () => {
    const sol = resolveModelProfile('gpt-6.1-sol');
    const astra = resolveModelProfile('gpt-6-astra');
    expect(sol.contextWindow).toBe(astra.contextWindow);
    expect(sol.sdkBlockingLimit).toBe(astra.sdkBlockingLimit);
    expect(sol.autoCompactTokens).toBe(astra.autoCompactTokens);
  });

  it('[1m] id derives the shared GPT 1M profile (no canonical row)', () => {
    expect(CANONICAL_MODEL_IDS).not.toContain('gpt-6.1-sol[1m]');
    const p = resolveModelProfile('gpt-6.1-sol[1m]');
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.sdkBlockingLimit).toBe(977_000);
    expect(p.autoCompactTokens).toBe(600_000);
  });

  it('registry delegates resolve the same numbers', () => {
    expect(resolveContextWindow('gpt-6.1-sol')).toBe(272_000);
    expect(resolveAutoCompactTokens('gpt-6.1-sol')).toBe(240_000);
    expect(resolveContextWindow('gpt-6.1-sol[1m]')).toBe(1_000_000);
    expect(resolveAutoCompactTokens('gpt-6.1-sol[1m]')).toBe(600_000);
  });

  it('declared trigger is reachable — not clamped by the session policy', () => {
    expect(safeMaxAutoCompactTokens('gpt-6.1-sol')).toBe(240_000);
  });

  it('a bigger catalog window does not override the declared 272k', () => {
    modelCatalog.__testSeed([
      { id: 'gpt-6.1-sol', aliases: ['sol'], name: 'GPT-6.1 Sol', efforts: [], max_context: 400_000, group: 'codex' },
    ]);
    expect(resolveContextWindow('gpt-6.1-sol')).toBe(272_000);
  });

  it('compatibility tier accepts the bare id and does not reject the [1m] id', () => {
    expect(resolveModelInputCompatibility('gpt-6.1-sol')).toEqual({ modelId: 'gpt-6.1-sol' });
    // The [1m] spelling has no canonical row and is not a grok id — the
    // compatibility tier has no opinion (null, never a rejection) and the
    // store falls through to the static allow-list.
    expect(resolveModelInputCompatibility('gpt-6.1-sol[1m]')).toBeNull();
  });

  it('gpt-6.1-sol is not mistaken for gpt-5.6 / gpt-5.5 / native-1M', () => {
    expect(isGpt56Model('gpt-6.1-sol')).toBe(false);
    expect(isGpt55Model('gpt-6.1-sol')).toBe(false);
    expect(isNativeOneMModel('gpt-6.1-sol')).toBe(false);
  });
});

describe('gpt-6.1-sol — model-registry pricing', () => {
  it('$2 in / $10 out / $0.10 cache-read, no cache-write charge, for both ids', () => {
    for (const id of ['gpt-6.1-sol', 'gpt-6.1-sol[1m]']) {
      const spec = getModelSpec(id);
      expect(spec.pricing.inputPerMTok).toBe(2);
      expect(spec.pricing.outputPerMTok).toBe(10);
      expect(spec.pricing.cacheReadPerMTok).toBe(0.1);
      expect(spec.pricing.cache5minWritePerMTok).toBe(0);
      expect(spec.pricing.cache1hrWritePerMTok).toBe(0);
      expect(spec.maxOutput).toBe(128_000);
    }
  });

  it('does not shadow gpt-6-astra or the gpt-5.6 tiers', () => {
    expect(getModelSpec('gpt-6-astra').pricing.inputPerMTok).toBe(10);
    expect(getModelSpec('gpt-5.6-sol').pricing.inputPerMTok).toBe(5);
    expect(getModelSpec('gpt-5.6-sol[1m]').pricing.inputPerMTok).toBe(5);
    expect(getModelSpec('gpt-5.6-terra').pricing.inputPerMTok).toBe(2.5);
  });
});
