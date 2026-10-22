/**
 * SSOT 2026-10-22 T4/T5 — the dashboard's model switch, host side: only the
 * representative models; the auto-compact threshold follows the model; a
 * context already above the target's threshold compacts on the current model
 * first and switches at that compact's boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  listRepresentativeModels,
  type ModelSwitchDeps,
  ModelSwitchError,
  REPRESENTATIVE_MODEL_NICKNAMES,
  switchSessionModel,
} from '../model-switch';

const MODELS: Record<string, string> = {
  'opus[1m]': 'claude-opus-5-5[1m]',
  'fable[1m]': 'claude-fable-5-1[1m]',
  'sonnet[1m]': 'claude-sonnet-4-6[1m]',
  'sol[1m]': 'gpt-5.6-sol[1m]',
  'astra[1m]': 'gpt-6-astra[1m]',
  'grok-4.6': 'grok-4.6',
};
const AUTO: Record<string, number> = { 'grok-4.6': 450_000 };

function deps(session: Record<string, any> | undefined, over: Partial<ModelSwitchDeps> = {}) {
  const calls = { compact: [] as string[], saves: 0, broadcasts: 0 };
  const d: ModelSwitchDeps = {
    resolveModel: (input) => MODELS[input] ?? null,
    contextWindow: (m) => (m === 'grok-4.6' ? 500_000 : 1_000_000),
    autoCompactFor: (m) => AUTO[m] ?? 750_000,
    displayName: (m) => `name:${m}`,
    getSession: () => session as any,
    isRequestActive: () => false,
    dispatchCompact: async (key) => {
      calls.compact.push(key);
    },
    save: () => {
      calls.saves++;
    },
    broadcast: () => {
      calls.broadcasts++;
    },
    now: () => 42,
    ...over,
  };
  return { d, calls };
}
const usage = (used: number) => ({
  currentInputTokens: used,
  currentOutputTokens: 0,
  currentCacheReadTokens: 0,
  currentCacheCreateTokens: 0,
  contextWindow: 1_000_000,
});

describe('representative models (T4)', () => {
  it('are exactly opus / fable / sonnet / sol / astra [1m] and grok, in that order', () => {
    expect([...REPRESENTATIVE_MODEL_NICKNAMES]).toEqual([
      'opus[1m]',
      'fable[1m]',
      'sonnet[1m]',
      'sol[1m]',
      'astra[1m]',
      'grok[1m]',
    ]);
  });

  it('resolve to their models with window and auto-compact threshold; grok is grok-4.6 (no 1M variant)', () => {
    const list = listRepresentativeModels(deps(undefined).d);
    expect(list.map((m) => [m.nickname, m.model, m.autoCompactTokens])).toEqual([
      ['opus[1m]', 'claude-opus-5-5[1m]', 750_000],
      ['fable[1m]', 'claude-fable-5-1[1m]', 750_000],
      ['sonnet[1m]', 'claude-sonnet-4-6[1m]', 750_000],
      ['sol[1m]', 'gpt-5.6-sol[1m]', 750_000],
      ['astra[1m]', 'gpt-6-astra[1m]', 750_000],
      ['grok[1m]', 'grok-4.6', 450_000],
    ]);
    expect(list[5]).toMatchObject({ contextWindow: 500_000, label: 'name:grok-4.6' });
  });

  it('a model that does not resolve right now is left out', () => {
    const list = listRepresentativeModels({
      ...deps(undefined).d,
      resolveModel: (i) => (i === 'opus[1m]' ? null : (MODELS[i] ?? null)),
    });
    expect(list.map((m) => m.nickname)).not.toContain('opus[1m]');
  });
});

describe('switchSessionModel (T4/T5)', () => {
  it('refuses anything but a representative model', async () => {
    const { d } = deps({ model: 'x' });
    await expect(switchSessionModel('k', 'claude-haiku-4-5-20251001', d)).rejects.toMatchObject({ statusCode: 400 });
    await expect(switchSessionModel('k', 'grok-4.6', d)).rejects.toBeInstanceOf(ModelSwitchError);
  });

  it('404 for an unknown session, 409 for an ended one', async () => {
    await expect(switchSessionModel('k', 'opus[1m]', deps(undefined).d)).rejects.toMatchObject({ statusCode: 404 });
    await expect(switchSessionModel('k', 'opus[1m]', deps({ terminated: true }).d)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('switches at once when the context fits the target’s threshold; auto-compact follows the model', async () => {
    const session: Record<string, any> = {
      model: 'claude-opus-5-5[1m]',
      autoCompactTokens: 900_000,
      usage: usage(300_000),
      sessionId: 's',
    };
    const { d, calls } = deps(session);
    const r = await switchSessionModel('k', 'grok[1m]', d);
    expect(r).toEqual({
      status: 'switched',
      nickname: 'grok[1m]',
      model: 'grok-4.6',
      autoCompactTokens: 450_000,
      usedTokens: 300_000,
    });
    expect(session.model).toBe('grok-4.6');
    expect(session.autoCompactTokens).toBeUndefined();
    expect(session.usage.contextWindow).toBe(500_000);
    expect(calls).toMatchObject({ compact: [], saves: 1, broadcasts: 1 });
  });

  it('above the target’s threshold: compacts on the current model first, the switch waits for it', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d, calls } = deps(session);
    const r = await switchSessionModel('k', 'grok[1m]', d);
    expect(r).toMatchObject({
      status: 'compacting',
      model: 'grok-4.6',
      autoCompactTokens: 450_000,
      usedTokens: 600_000,
    });
    expect(session.model).toBe('claude-opus-5-5[1m]');
    expect(session.pendingModelSwitch).toEqual({ model: 'grok-4.6', nickname: 'grok[1m]', requestedAt: 42 });
    expect(calls.compact).toEqual(['k']);
  });

  it('its own compact replaces a pending auto-compact, so the context is compacted once (review P1)', async () => {
    const session: Record<string, any> = {
      model: 'claude-opus-5-5[1m]',
      usage: usage(600_000),
      sessionId: 's',
      autoCompactPending: true,
    };
    const { d, calls } = deps(session);
    await switchSessionModel('k', 'grok[1m]', d);
    expect(session.autoCompactPending).toBe(false);
    expect(calls.compact).toEqual(['k']);
  });

  it('a compact cannot start mid-turn: 409, nothing parked', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d, calls } = deps(session, { isRequestActive: () => true });
    await expect(switchSessionModel('k', 'grok[1m]', d)).rejects.toMatchObject({ statusCode: 409 });
    expect(session.pendingModelSwitch).toBeUndefined();
    expect(calls.compact).toEqual([]);
  });

  it('answers at once — it does not hold the request open for the whole compact turn (review P2)', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d } = deps(session, { dispatchCompact: () => new Promise<void>(() => {}) }); // never settles
    await expect(switchSessionModel('k', 'grok[1m]', d)).resolves.toMatchObject({ status: 'compacting' });
  });

  it('a compact that fails to start un-parks the switch and says so to the dashboard', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d, calls } = deps(session, {
      dispatchCompact: vi.fn().mockRejectedValue(new Error('slack down')),
    });
    expect((await switchSessionModel('k', 'grok[1m]', d)).status).toBe('compacting');
    await new Promise((r) => setTimeout(r, 0));
    expect(session.pendingModelSwitch).toBeUndefined();
    expect(session.model).toBe('claude-opus-5-5[1m]');
    expect(calls.broadcasts).toBe(2);
  });

  it('the same model and no override: unchanged, nothing written', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(1), sessionId: 's' };
    const { d, calls } = deps(session);
    expect((await switchSessionModel('k', 'opus[1m]', d)).status).toBe('unchanged');
    expect(calls.saves).toBe(0);
  });
});
