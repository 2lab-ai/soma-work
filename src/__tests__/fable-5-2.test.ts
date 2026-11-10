/**
 * Locks the Claude Fable 5.2 wiring, added 2026-11-10.
 *
 * `claude-fable-5-2` (display "Fable 5.2") was released 2026-11-09: 1,000,000
 * context (the default and the maximum — Fable runs 1M natively, there is no
 * 200K mode), 128k max output. The llmux gateway moved its own `fable` alias
 * to `claude-fable-5-2[1m]` the same day, the same roll it made from Fable 5
 * to 5.1 on 2026-09-02.
 *
 * Load-bearing contracts:
 *   1. The `fable` / `fable[1m]` / `fable-5-2` / `fable-5-2[1m]` shorthands
 *      select `claude-fable-5-2[1m]` — a family shorthand always lands on the
 *      newest `[1m]` row (same rule as `opus` → `claude-opus-5-5[1m]`,
 *      `sol` → `gpt-6.1-sol[1m]`).
 *   2. Version-pinned spellings are NOT silently upgraded: `fable-5-1*` stay
 *      on Fable 5.1, `fable-5*` on Fable 5, and both 5.1 ids stay selectable.
 *   3. The `[1m]` id is a DECLARED policy row (1M / 977k / 750k, the Claude 1M
 *      policy), so a session on it gets the 750k auto-compact default. The
 *      bare id takes the native-1M branch (1M, no token default), like 5.1.
 *   4. Pricing has its own row ($8 / $40 / $0.20 / $10 / $16) above the 5.1
 *      and 5 rows — without it `claude-fable-5-2` matched `fable-5` and was
 *      priced at Fable 5's $10 / $50 / $1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_MODEL_IDS, DEFAULT_COMPACT_HEADROOM, resolveModelProfile } from '../metrics/model-profile';
import {
  calculateTokenCost,
  getModelSpec,
  isNativeOneMModel,
  resolveAutoCompactTokens,
  resolveContextWindow,
  resolveModelInputCompatibility,
} from '../metrics/model-registry';
import { safeMaxAutoCompactTokens } from '../session/autocompact-policy';
import { ModelHandler } from '../slack/commands/model-handler';
import type { CommandContext, CommandDependencies } from '../slack/commands/types';
import {
  AVAILABLE_MODELS,
  coerceToAvailableModel,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  UserSettingsStore,
} from '../user-settings-store';

function makeStore(): UserSettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable52-test-'));
  return new UserSettingsStore(dir);
}

describe('fable-5.2 — release wiring', () => {
  it('lists the bare id AND the `[1m]` id as selectable ids, ahead of 5.1', () => {
    const models = AVAILABLE_MODELS as readonly string[];
    expect(models).toContain('claude-fable-5-2');
    expect(models).toContain('claude-fable-5-2[1m]');
    // The newest fable leads its block, as 5.1 did before it.
    expect(models.indexOf('claude-fable-5-2')).toBeLessThan(models.indexOf('claude-fable-5-1'));
    expect(models.indexOf('claude-fable-5-2[1m]')).toBeLessThan(models.indexOf('claude-fable-5-1[1m]'));
    // The previous generations stay selectable by their literal ids.
    for (const id of ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-fable-5', 'claude-fable-5[1m]']) {
      expect(models).toContain(id);
    }
  });

  it('is SELECTABLE but NOT the default', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
  });

  it('fable / fable[1m] / fable-5-2 / fable-5-2[1m] point at the newest [1m] row', () => {
    expect(MODEL_ALIASES.fable).toBe('claude-fable-5-2[1m]');
    expect(MODEL_ALIASES['fable[1m]']).toBe('claude-fable-5-2[1m]');
    expect(MODEL_ALIASES['fable-5-2']).toBe('claude-fable-5-2[1m]');
    expect(MODEL_ALIASES['fable-5-2[1m]']).toBe('claude-fable-5-2[1m]');
  });

  it('version-pinned fable aliases are NOT silently upgraded', () => {
    expect(MODEL_ALIASES['fable-5-1']).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable-5-1[1m]']).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable-5']).toBe('claude-fable-5[1m]');
    expect(MODEL_ALIASES['fable-5[1m]']).toBe('claude-fable-5[1m]');
  });

  it.each([
    'fable',
    ' FABLE ',
    'fable[1m]',
    'FABLE[1M]',
    'fable-5-2',
    'fable-5-2[1m]',
  ])('resolveModelInput resolves %s to claude-fable-5-2[1m]', (input) => {
    expect(makeStore().resolveModelInput(input)).toBe('claude-fable-5-2[1m]');
  });

  it.each(['claude-fable-5-2', 'claude-fable-5-2[1m]'])('round-trips the literal id %s through settings', (model) => {
    const store = makeStore();
    expect(store.resolveModelInput(model)).toBe(model);
    expect(store.resolveModelInput(model.toUpperCase())).toBe(model);
    expect(coerceToAvailableModel(model)).toBe(model);
    expect(coerceToAvailableModel(`  ${model.toUpperCase()}  `)).toBe(model);
    store.setUserDefaultModel('U_FABLE52', model);
    expect(store.getUserDefaultModel('U_FABLE52')).toBe(model);
  });

  it('coerce does NOT consult MODEL_ALIASES — the shorthand falls back to the default', () => {
    expect(coerceToAvailableModel('fable-5-2')).toBe(DEFAULT_MODEL);
  });

  it('renders curated display labels for both spellings', () => {
    const store = makeStore();
    expect(store.getModelDisplayName('claude-fable-5-2')).toBe('Fable 5.2');
    expect(store.getModelDisplayName('claude-fable-5-2[1m]')).toBe('Fable 5.2 (1M)');
    // 5.1 keeps its own labels.
    expect(store.getModelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(store.getModelDisplayName('claude-fable-5-1[1m]')).toBe('Fable 5.1 (1M)');
  });

  it('`model fable` updates both the user default and the current session to 5.2', async () => {
    const { userSettingsStore } = await import('../user-settings-store');
    const store = makeStore();
    const setDefault = vi.spyOn(userSettingsStore, 'setUserDefaultModel').mockImplementation((user, model) => {
      store.setUserDefaultModel(user, model);
    });
    const getDefault = vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockImplementation((user) => {
      return store.getUserDefaultModel(user);
    });
    try {
      const session = { model: 'claude-fable-5-1[1m]' };
      const handler = new ModelHandler({
        claudeHandler: { getSession: () => session },
      } as unknown as CommandDependencies);
      const say = vi.fn().mockResolvedValue(undefined);
      expect(handler.canHandle('model fable')).toBe(true);
      await handler.execute({
        text: 'model fable',
        user: 'U_FABLE52',
        channel: 'C_TEST',
        threadTs: '123.456',
        say,
      } as unknown as CommandContext);
      expect(store.getUserDefaultModel('U_FABLE52')).toBe('claude-fable-5-2[1m]');
      expect(session.model).toBe('claude-fable-5-2[1m]');
      expect(say.mock.calls[0][0].text).toContain('Fable 5.2 (1M)');
    } finally {
      setDefault.mockRestore();
      getDefault.mockRestore();
    }
  });
});

describe('fable-5.2 — canonical profile', () => {
  it('[1m] id is a DECLARED policy row: 1M / 977k / 750k', () => {
    expect(CANONICAL_MODEL_IDS).toContain('claude-fable-5-2[1m]');
    expect(resolveModelProfile('claude-fable-5-2[1m]')).toEqual({
      modelId: 'claude-fable-5-2[1m]',
      contextWindow: 1_000_000,
      sdkBlockingLimit: 977_000,
      autoCompactTokens: 750_000,
      compactHeadroom: DEFAULT_COMPACT_HEADROOM,
    });
  });

  it('[1m] id carries the same numbers as the 5.1 [1m] row it supersedes', () => {
    const p52 = resolveModelProfile('claude-fable-5-2[1m]');
    const p51 = resolveModelProfile('claude-fable-5-1[1m]');
    expect([p52.contextWindow, p52.sdkBlockingLimit, p52.autoCompactTokens]).toEqual([
      p51.contextWindow,
      p51.sdkBlockingLimit,
      p51.autoCompactTokens,
    ]);
  });

  it('bare id takes the native-1M branch: 1M / 977k / no token default (same as bare 5.1)', () => {
    expect(isNativeOneMModel('claude-fable-5-2')).toBe(true);
    expect(CANONICAL_MODEL_IDS).not.toContain('claude-fable-5-2');
    const p = resolveModelProfile('claude-fable-5-2');
    expect(p.contextWindow).toBe(1_000_000);
    expect(p.sdkBlockingLimit).toBe(977_000);
    expect(p.autoCompactTokens).toBeUndefined();
  });

  it('registry delegates resolve the same numbers', () => {
    expect(resolveContextWindow('claude-fable-5-2[1m]')).toBe(1_000_000);
    expect(resolveAutoCompactTokens('claude-fable-5-2[1m]')).toBe(750_000);
    expect(resolveContextWindow('claude-fable-5-2')).toBe(1_000_000);
  });

  it('declared trigger is reachable — not clamped by the session policy', () => {
    expect(safeMaxAutoCompactTokens('claude-fable-5-2[1m]')).toBeGreaterThanOrEqual(750_000);
  });

  it('compatibility tier accepts the [1m] id as itself', () => {
    expect(resolveModelInputCompatibility('claude-fable-5-2[1m]')).toEqual({ modelId: 'claude-fable-5-2[1m]' });
    expect(resolveModelInputCompatibility('CLAUDE-FABLE-5-2[1M]')).toEqual({ modelId: 'claude-fable-5-2[1m]' });
  });
});

describe('fable-5.2 — model-registry pricing', () => {
  it('$8 in / $40 out / $0.20 cache read / $10 5-min write / $16 1-h write, for every spelling', () => {
    for (const id of ['claude-fable-5-2', 'claude-fable-5-2[1m]', 'claude-fable-5-2-20261109']) {
      const spec = getModelSpec(id);
      expect([
        spec.pricing.inputPerMTok,
        spec.pricing.outputPerMTok,
        spec.pricing.cacheReadPerMTok,
        spec.pricing.cache5minWritePerMTok,
        spec.pricing.cache1hrWritePerMTok,
      ]).toEqual([8, 40, 0.2, 10, 16]);
      expect(spec.contextWindow).toBe(1_000_000);
      expect(spec.maxOutput).toBe(128_000);
    }
  });

  it('prices one million of each token class at the 5-min write rate', () => {
    expect(calculateTokenCost('claude-fable-5-2[1m]', 1e6, 1e6, 1e6, 1e6)).toBeCloseTo(8 + 40 + 0.2 + 10, 6);
  });

  it('does not shadow Fable 5.1 or Fable 5', () => {
    expect(getModelSpec('claude-fable-5-1').pricing.inputPerMTok).toBe(10);
    expect(getModelSpec('claude-fable-5-1').pricing.cacheReadPerMTok).toBe(0.25);
    expect(getModelSpec('claude-fable-5').pricing.cacheReadPerMTok).toBe(1);
    expect(getModelSpec('claude-fable-5[1m]').pricing.inputPerMTok).toBe(10);
  });
});
