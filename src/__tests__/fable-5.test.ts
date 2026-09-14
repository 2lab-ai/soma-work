/**
 * Locks the Claude Fable 5 (2026-06-09) release wiring.
 *
 * 2026-08-26 correction. Fable 5 does serve 1M upstream on the bare id, and
 * `resolveContextWindow('claude-fable-5')` still says so. The auto-compact
 * trigger itself is a HARNESS number read from the model profile — the client
 * is not the authority for it. What the literal `[1m]` suffix buys is the SDK
 * side of the same session: the live llmux probe showed input accounting and
 * the blocking limit are sized at 1,000,000 only for `claude-fable-5[1m]`,
 * while the bare id is sized at 200,000 and hard-blocks input long before the
 * harness's 750k trigger could ever fire. So the user-facing aliases now point
 * at the literal `[1m]` spelling and the old "there is no fable[1m]" guards
 * are inverted here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getModelSpec, isNativeOneMModel, resolveContextWindow, resolveModelProfile } from '../metrics/model-registry';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable5-test-'));
  return new UserSettingsStore(dir);
}

describe('fable-5 — release wiring', () => {
  it('lists the bare claude-fable-5 in AVAILABLE_MODELS', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5');
  });

  it('ALSO lists the literal claude-fable-5[1m] variant (Claude Code 1M denominator)', () => {
    expect(AVAILABLE_MODELS as readonly string[]).toContain('claude-fable-5[1m]');
  });

  it('advances the unversioned alias to 5.1 while preserving the version-pinned alias', () => {
    expect(MODEL_ALIASES.fable).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable-5']).toBe('claude-fable-5[1m]');
  });

  it('keeps explicit [1m] aliases on their respective generations', () => {
    expect(MODEL_ALIASES['fable[1m]']).toBe('claude-fable-5-1[1m]');
    expect(MODEL_ALIASES['fable-5[1m]']).toBe('claude-fable-5[1m]');
  });

  it('the literal [1m] id round-trips through resolve + coerce (never downgraded)', () => {
    const store = makeStore();
    expect(store.resolveModelInput('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    expect(store.resolveModelInput('fable')).toBe('claude-fable-5-1[1m]');
    expect(coerceToAvailableModel('claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    expect(coerceToAvailableModel('claude-fable-5[1M]')).toBe('claude-fable-5[1m]');
  });

  it('does NOT change DEFAULT_MODEL (Fable is opt-in, not the default)', () => {
    // Fable 5 is double opus pricing and becomes credit-gated post-launch, so
    // it must not silently become everyone's default.
    expect(DEFAULT_MODEL).toBe('gpt-5.6-sol');
  });

  it('coerce passes the bare id through and normalises an uppercase typo path', () => {
    expect(coerceToAvailableModel('claude-fable-5')).toBe('claude-fable-5');
    expect(coerceToAvailableModel('  claude-fable-5  ')).toBe('claude-fable-5');
  });

  it('renders curated display labels that tell the two spellings apart', () => {
    const store = makeStore();
    // "(1M)" now marks the spelling whose CLIENT denominator is 1M. The bare
    // id keeps a plain label: Claude Code sizes it at 200k.
    expect(store.getModelDisplayName('claude-fable-5')).toBe('Fable 5');
    expect(store.getModelDisplayName('claude-fable-5[1m]')).toBe('Fable 5 (1M)');
  });
});

describe('fable-5.1 — selectable and persistence-safe without a catalog', () => {
  it.each(['claude-fable-5-1', 'claude-fable-5-1[1m]'])('round-trips %s through settings', (model) => {
    const store = makeStore();
    expect(AVAILABLE_MODELS as readonly string[]).toContain(model);
    expect(store.resolveModelInput(model)).toBe(model);
    expect(coerceToAvailableModel(model)).toBe(model);
    store.setUserDefaultModel('U_FABLE51', model);
    expect(store.getUserDefaultModel('U_FABLE51')).toBe(model);
    expect(store.getModelDisplayName(model)).toBe(model.endsWith('[1m]') ? 'Fable 5.1 (1M)' : 'Fable 5.1');
  });

  it.each(['fable', ' FABLE ', 'fable[1m]', 'fable-5-1', 'fable-5-1[1m]'])('resolves %s to the 5.1 1M id', (input) => {
    expect(makeStore().resolveModelInput(input)).toBe('claude-fable-5-1[1m]');
  });

  it('model fable updates both the user default and current session', async () => {
    const { userSettingsStore } = await import('../user-settings-store');
    const store = makeStore();
    const setDefault = vi.spyOn(userSettingsStore, 'setUserDefaultModel').mockImplementation((user, model) => {
      store.setUserDefaultModel(user, model);
    });
    const getDefault = vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockImplementation((user) => {
      return store.getUserDefaultModel(user);
    });
    try {
      const session = { model: 'claude-fable-5[1m]' };
      const handler = new ModelHandler({
        claudeHandler: { getSession: () => session },
      } as unknown as CommandDependencies);
      const say = vi.fn().mockResolvedValue(undefined);
      expect(handler.canHandle('model fable')).toBe(true);
      await handler.execute({
        text: 'model fable',
        user: 'U_FABLE51',
        channel: 'C_TEST',
        threadTs: '123.456',
        say,
      } as unknown as CommandContext);
      expect(store.getUserDefaultModel('U_FABLE51')).toBe('claude-fable-5-1[1m]');
      expect(session.model).toBe('claude-fable-5-1[1m]');
      expect(say.mock.calls[0][0].text).toContain('Fable 5.1 (1M)');
    } finally {
      setDefault.mockRestore();
      getDefault.mockRestore();
    }
  });

  it('preserves the 1M window and 750k auto-compact policy on the new alias target', () => {
    expect(resolveModelProfile('claude-fable-5-1[1m]')).toMatchObject({
      modelId: 'claude-fable-5-1[1m]',
      contextWindow: 1_000_000,
      sdkBlockingLimit: 977_000,
      autoCompactTokens: 750_000,
    });
  });
});

describe('fable-5 — native 1M context (the key contract)', () => {
  it('resolveContextWindow returns 1M for the BARE id — no [1m] suffix', () => {
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000);
  });

  it('is recognised as a native-1M model', () => {
    expect(isNativeOneMModel('claude-fable-5')).toBe(true);
  });
});

describe('fable-5 — model-registry pricing + context', () => {
  it('returns double-opus pricing, 1M context, 128k max output', () => {
    const spec = getModelSpec('claude-fable-5');
    expect(spec.pricing.inputPerMTok).toBe(10);
    expect(spec.pricing.outputPerMTok).toBe(50);
    expect(spec.pricing.cacheReadPerMTok).toBe(1);
    expect(spec.pricing.cache5minWritePerMTok).toBe(12.5);
    expect(spec.pricing.cache1hrWritePerMTok).toBe(20);
    expect(spec.maxOutput).toBe(128_000);
    expect(spec.contextWindow).toBe(1_000_000);
  });
});
