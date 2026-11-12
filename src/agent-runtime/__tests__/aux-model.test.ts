/**
 * Auxiliary (side-call) model choice — titles, summaries, dreaming, dispatch,
 * cron `fast`, … An aux call names a TIER (`haiku` = cheap/fast, `sonnet` =
 * mid); the model comes from the MAIN model's provider:
 *
 *   tier   | Claude (or unknown) | Codex / GPT        | Grok
 *   haiku  | alias `haiku`       | alias `luna`       | alias `grok`, effort low
 *   sonnet | alias `sonnet`      | alias `terra`      | alias `grok`, effort medium
 *
 * Aliases resolve at CALL time through the soma-work alias table, so a model
 * update (an edit of that table) moves every aux call with no code change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVAILABLE_MODELS, DEFAULT_MODEL, MODEL_ALIASES, userSettingsStore } from '../../user-settings-store';
import { auxModelFor, auxProviderOf } from '../aux-model';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The newest grok the allow-list carries (the `grok` tier target when no `grok` alias resolves). */
function newestGrokInAllowList(): string {
  const groks = AVAILABLE_MODELS.filter((m) => /^grok-\d/.test(m));
  return [...groks].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

describe('auxProviderOf', () => {
  it.each([
    ['claude-opus-5-5[1m]', 'claude'],
    ['claude-fable-5-2[1m]', 'claude'],
    ['opus', 'claude'],
    ['gpt-6.1-sol[1m]', 'codex'],
    ['gpt-5.5', 'codex'],
    ['sol', 'codex'],
    ['terra', 'codex'],
    ['luna', 'codex'],
    ['astra', 'codex'],
    ['grok-4.7', 'grok'],
    ['grok', 'grok'],
    ['some-unknown-model', 'claude'],
  ])('%s → %s', (model, provider) => {
    expect(auxProviderOf(model)).toBe(provider);
  });
});

describe('auxModelFor — tier × main provider', () => {
  it('Claude main: haiku → the `haiku` alias, sonnet → the `sonnet` alias, no effort', () => {
    expect(auxModelFor('haiku', { mainModel: 'claude-opus-5-5[1m]' })).toEqual({ model: MODEL_ALIASES.haiku });
    expect(auxModelFor('sonnet', { mainModel: 'claude-opus-5-5[1m]' })).toEqual({ model: MODEL_ALIASES.sonnet });
    // Today's table: the newest haiku / sonnet on their [1m] rows.
    expect(auxModelFor('haiku', { mainModel: 'claude-fable-5-2[1m]' }).model).toBe('claude-haiku-5-5[1m]');
    expect(auxModelFor('sonnet', { mainModel: 'claude-fable-5-2[1m]' }).model).toBe('claude-sonnet-5-5[1m]');
  });

  it('Codex/GPT main: haiku → `luna`, sonnet → `terra`, no effort', () => {
    for (const main of ['gpt-6.1-sol[1m]', 'gpt-6-astra', 'gpt-5.5', 'sol', 'astra']) {
      expect(auxModelFor('haiku', { mainModel: main })).toEqual({ model: MODEL_ALIASES.luna });
      expect(auxModelFor('sonnet', { mainModel: main })).toEqual({ model: MODEL_ALIASES.terra });
    }
    expect(auxModelFor('haiku', { mainModel: 'gpt-6.1-sol[1m]' }).model).toBe('gpt-6-luna[1m]');
    expect(auxModelFor('sonnet', { mainModel: 'gpt-6.1-sol[1m]' }).model).toBe('gpt-6.1-terra[1m]');
  });

  it('Grok main: both tiers run grok, with effort low (haiku) / medium (sonnet)', () => {
    const grok = newestGrokInAllowList();
    expect(auxModelFor('haiku', { mainModel: 'grok-4.7' })).toEqual({ model: grok, effort: 'low' });
    expect(auxModelFor('sonnet', { mainModel: 'grok-4.6' })).toEqual({ model: grok, effort: 'medium' });
  });

  it('unknown main model → the Claude row', () => {
    expect(auxModelFor('haiku', { mainModel: 'mystery-model' })).toEqual({ model: MODEL_ALIASES.haiku });
    expect(auxModelFor('sonnet', { mainModel: 'mystery-model' })).toEqual({ model: MODEL_ALIASES.sonnet });
  });
});

describe('auxModelFor — which model is the MAIN model', () => {
  it("the session's model wins over the user's default", () => {
    const spy = vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('grok-4.7');
    expect(auxModelFor('sonnet', { mainModel: 'claude-opus-5-5[1m]', userId: 'U1' })).toEqual({
      model: MODEL_ALIASES.sonnet,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("no session model → the user's default model", () => {
    const spy = vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('claude-opus-5-5[1m]');
    expect(auxModelFor('sonnet', { userId: 'U1' })).toEqual({ model: MODEL_ALIASES.sonnet });
    expect(spy).toHaveBeenCalledWith('U1');

    spy.mockReturnValue('grok-4.7');
    expect(auxModelFor('haiku', { userId: 'U1' })).toEqual({ model: newestGrokInAllowList(), effort: 'low' });
  });

  it('no session and no user → DEFAULT_MODEL decides the provider', () => {
    const expected = auxProviderOf(DEFAULT_MODEL) === 'codex' ? MODEL_ALIASES.terra : MODEL_ALIASES.sonnet;
    expect(auxModelFor('sonnet').model).toBe(expected);
    expect(auxModelFor('sonnet', {}).model).toBe(expected);
  });

  it('a blank session model counts as no session model', () => {
    vi.spyOn(userSettingsStore, 'getUserDefaultModel').mockReturnValue('gpt-6.1-sol[1m]');
    expect(auxModelFor('haiku', { mainModel: '', userId: 'U1' })).toEqual({ model: MODEL_ALIASES.luna });
  });
});

describe('auxModelFor — operator override', () => {
  it('a set override wins as-is (no alias resolution, no effort), whatever the main model', () => {
    expect(auxModelFor('sonnet', { override: 'claude-sonnet-4-6', mainModel: 'grok-4.7' })).toEqual({
      model: 'claude-sonnet-4-6',
    });
    expect(auxModelFor('haiku', { override: 'my-model', mainModel: 'gpt-6.1-sol[1m]' })).toEqual({
      model: 'my-model',
    });
  });

  it('an unset / empty override falls through to the tier', () => {
    expect(auxModelFor('sonnet', { override: undefined, mainModel: 'gpt-5.5' })).toEqual({
      model: MODEL_ALIASES.terra,
    });
    expect(auxModelFor('sonnet', { override: '', mainModel: 'gpt-5.5' })).toEqual({ model: MODEL_ALIASES.terra });
  });
});

describe('auxModelFor — aliases resolve at call time', () => {
  it('editing the alias table moves the aux model with no code change', () => {
    const before = MODEL_ALIASES.sonnet;
    try {
      MODEL_ALIASES.sonnet = 'claude-sonnet-4-6';
      expect(auxModelFor('sonnet', { mainModel: 'claude-opus-5-5[1m]' }).model).toBe('claude-sonnet-4-6');
      MODEL_ALIASES.sonnet = 'claude-sonnet-4-6[1m]';
      expect(auxModelFor('sonnet', { mainModel: 'claude-opus-5-5[1m]' }).model).toBe('claude-sonnet-4-6[1m]');
    } finally {
      MODEL_ALIASES.sonnet = before;
    }
    expect(auxModelFor('sonnet', { mainModel: 'claude-opus-5-5[1m]' }).model).toBe(before);
  });

  it('every tier alias goes through resolveModelInput on each call', () => {
    const spy = vi.spyOn(userSettingsStore, 'resolveModelInput');
    auxModelFor('haiku', { mainModel: 'gpt-6.1-sol[1m]' });
    auxModelFor('haiku', { mainModel: 'gpt-6.1-sol[1m]' });
    expect(spy.mock.calls.filter(([input]) => input === 'luna')).toHaveLength(2);
  });

  it('a `grok` alias that resolves (e.g. the llmux catalog overlay) is used', () => {
    const real = userSettingsStore.resolveModelInput.bind(userSettingsStore);
    vi.spyOn(userSettingsStore, 'resolveModelInput').mockImplementation((input: string) =>
      input === 'grok' ? 'grok-9.9' : real(input),
    );
    expect(auxModelFor('sonnet', { mainModel: 'grok-4.7' })).toEqual({ model: 'grok-9.9', effort: 'medium' });
  });

  it('an unresolvable alias is passed bare (llmux resolves it)', () => {
    vi.spyOn(userSettingsStore, 'resolveModelInput').mockImplementation((input: string) =>
      input === 'terra' ? null : input.startsWith('gpt-') ? input : null,
    );
    expect(auxModelFor('sonnet', { mainModel: 'gpt-6.1-sol[1m]' })).toEqual({ model: 'terra' });
  });
});
