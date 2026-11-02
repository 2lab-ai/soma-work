/**
 * SSOT 2026-10-22 T4/T5 — the dashboard's model switch, host side: only the
 * representative models; the auto-compact threshold follows the model; a
 * context already above the target's threshold compacts on the current model
 * first and switches at that compact's boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listRepresentativeModels,
  type ModelSwitchDeps,
  ModelSwitchError,
  QUEUED_COMPACT_WATCH_MS,
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

  it('context size unknown (no usage — e.g. restored from a sessions.json saved without it) and a smaller target threshold: compact first (review P1)', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', sessionId: 's' };
    const { d, calls } = deps(session);
    expect((await switchSessionModel('k', 'grok[1m]', d)).status).toBe('compacting');
    expect(calls.compact).toEqual(['k']);
  });

  it('context size unknown but the target allows at least as much: switch at once', async () => {
    const session: Record<string, any> = { model: 'grok-4.6', sessionId: 's' };
    const { d, calls } = deps(session);
    expect((await switchSessionModel('k', 'opus[1m]', d)).status).toBe('switched');
    expect(calls.compact).toEqual([]);
  });

  it('mid-turn, a smaller target threshold is refused even if the committed usage looks small (review P1)', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(300_000), sessionId: 's' };
    const { d, calls } = deps(session, { isRequestActive: () => true });
    await expect(switchSessionModel('k', 'grok[1m]', d)).rejects.toMatchObject({ statusCode: 409 });
    expect(session.model).toBe('claude-opus-5-5[1m]');
    expect(calls.compact).toEqual([]);
  });

  it('mid-turn, a target with at least the same threshold switches (next turn uses it)', async () => {
    const session: Record<string, any> = { model: 'grok-4.6', usage: usage(300_000), sessionId: 's' };
    const { d } = deps(session, { isRequestActive: () => true });
    expect((await switchSessionModel('k', 'opus[1m]', d)).status).toBe('switched');
  });

  it('the running turn’s latest call counts toward the context it holds', async () => {
    const session: Record<string, any> = {
      model: 'claude-opus-5-5[1m]',
      usage: usage(300_000),
      sessionId: 's',
      liveUsage: {
        'm:a': { inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 590_000, cacheCreateTokens: 7_000 },
      },
    };
    const { d } = deps(session);
    const r = await switchSessionModel('k', 'grok[1m]', d);
    expect(r).toMatchObject({ status: 'compacting', usedTokens: 600_000 });
  });

  it('a compact that was dropped (slot taken) un-parks the switch once the dispatch returns (review R2 F1)', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d, calls } = deps(session, { dispatchCompact: async () => {} }); // resolved, but no compact ran
    expect((await switchSessionModel('k', 'grok[1m]', d)).status).toBe('compacting');
    await new Promise((r) => setTimeout(r, 0));
    expect(session.pendingModelSwitch).toBeUndefined();
    expect(session.model).toBe('claude-opus-5-5[1m]');
    expect(calls.broadcasts).toBe(2);
  });

  it('a compact queued behind a running turn keeps the switch parked until that compact runs (review R3-2)', async () => {
    // `handleMessage` returns as soon as the follow-up queue has the command:
    // the compact has not run yet, so the switch must still be waiting for it.
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d, calls } = deps(session, { dispatchCompact: async () => 'queued' as const });
    expect((await switchSessionModel('k', 'grok[1m]', d)).status).toBe('compacting');
    await new Promise((r) => setTimeout(r, 0));
    expect(session.pendingModelSwitch).toMatchObject({ model: 'grok-4.6', nickname: 'grok[1m]' });
    expect(session.model).toBe('claude-opus-5-5[1m]');
    expect(calls.broadcasts).toBe(1);
  });

  it('the parked switch records which message carries its compact, so only that compact applies it (review R4)', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d } = deps(session, {
      dispatchCompact: async (_key, onSent) => {
        onSent?.({ channel: 'C1', ts: '100.1' });
        return 'queued' as const;
      },
    });
    expect((await switchSessionModel('k', 'grok[1m]', d)).status).toBe('compacting');
    await new Promise((r) => setTimeout(r, 0));
    expect(session.pendingModelSwitch).toMatchObject({ nickname: 'grok[1m]', compactTs: '100.1' });
    expect(session.pendingModelSwitch.armed).toBeUndefined();
  });

  it('a dispatch that reports it settled without taking the compact un-parks the switch (review R3-2)', async () => {
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' };
    const { d } = deps(session, { dispatchCompact: async () => 'settled' as const });
    expect((await switchSessionModel('k', 'grok[1m]', d)).status).toBe('compacting');
    await new Promise((r) => setTimeout(r, 0));
    expect(session.pendingModelSwitch).toBeUndefined();
  });

  it('shrinking is judged against the session’s effective threshold, override included (review R2-3)', async () => {
    // Opus 1M at a 900k override, size unknown (no usage); sonnet[1m] compacts at 750k.
    const session: Record<string, any> = { model: 'claude-opus-5-5[1m]', autoCompactTokens: 900_000, sessionId: 's' };
    const { d, calls } = deps(session);
    expect((await switchSessionModel('k', 'sonnet[1m]', d)).status).toBe('compacting');
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

describe('a switch whose compact is queued behind another turn (review R4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const big = () => ({ model: 'claude-opus-5-5[1m]', usage: usage(600_000), sessionId: 's' }) as Record<string, any>;
  function queuedDeps(session: Record<string, any>, stillQueued: () => boolean, now: () => number = () => 42) {
    return deps(session, {
      dispatchCompact: async (_key, onSent) => {
        onSent?.({ channel: 'C1', ts: '100.1' });
        return 'queued' as const;
      },
      isCompactQueued: vi.fn(() => stillQueued()),
      now,
    });
  }

  it('is un-parked as soon as its queued compact will no longer run (cancelled, stopped, failed)', async () => {
    vi.useFakeTimers();
    let queued = true;
    const session = big();
    const { d, calls } = queuedDeps(session, () => queued);
    expect((await switchSessionModel('k', 'grok[1m]', d)).status).toBe('compacting');
    await vi.advanceTimersByTimeAsync(QUEUED_COMPACT_WATCH_MS);
    expect(session.pendingModelSwitch).toMatchObject({ nickname: 'grok[1m]', compactTs: '100.1' });
    expect(d.isCompactQueued).toHaveBeenCalledWith({ channel: 'C1', ts: '100.1' });
    queued = false; // the user cancelled it from the queue panel
    await vi.advanceTimersByTimeAsync(QUEUED_COMPACT_WATCH_MS);
    expect(session.pendingModelSwitch).toBeUndefined();
    expect(session.model).toBe('claude-opus-5-5[1m]');
    expect(calls.broadcasts).toBe(2);
  });

  it('once its own compact turn armed it, the watch leaves it to that turn', async () => {
    vi.useFakeTimers();
    let queued = true;
    const session = big();
    const { d } = queuedDeps(session, () => queued);
    await switchSessionModel('k', 'grok[1m]', d);
    await vi.advanceTimersByTimeAsync(QUEUED_COMPACT_WATCH_MS);
    session.pendingModelSwitch.armed = true; // the drain ran it: the /compact turn is on
    queued = false;
    await vi.advanceTimersByTimeAsync(QUEUED_COMPACT_WATCH_MS * 3);
    expect(session.pendingModelSwitch).toMatchObject({ armed: true });
  });

  it('a queued switch still waiting when its TTL runs out is un-parked', async () => {
    vi.useFakeTimers();
    let t = 1_000;
    const session = big();
    const { d } = queuedDeps(
      session,
      () => true,
      () => t,
    );
    await switchSessionModel('k', 'grok[1m]', d);
    await vi.advanceTimersByTimeAsync(QUEUED_COMPACT_WATCH_MS);
    expect(session.pendingModelSwitch).toBeDefined();
    t += 30 * 60 * 1000 + 1;
    await vi.advanceTimersByTimeAsync(QUEUED_COMPACT_WATCH_MS);
    expect(session.pendingModelSwitch).toBeUndefined();
  });
});

describe('the effort follows the model (a switch never keeps a level the target cannot run)', () => {
  const SOL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const GROK = ['low', 'medium', 'high', 'xhigh'];
  const levels = (m: string) =>
    m === 'grok-4.6' ? GROK : m.startsWith('gpt-') ? SOL : ['low', 'medium', 'high', 'xhigh', 'max'];

  it('representative models carry the levels each runs', () => {
    const { d } = deps(undefined, { effortLevels: levels });
    const reps = listRepresentativeModels(d);
    expect(reps.find((m) => m.nickname === 'sol[1m]')?.effortLevels).toEqual(SOL);
    expect(reps.find((m) => m.nickname === 'grok[1m]')?.effortLevels).toEqual(GROK);
    // Without the dep nothing is claimed.
    expect(listRepresentativeModels(deps(undefined).d)[0]).not.toHaveProperty('effortLevels');
  });

  it('switching now: ultra on sol becomes xhigh on grok, and the result says so', async () => {
    const session: Record<string, any> = {
      model: 'gpt-5.6-sol[1m]',
      effort: 'ultra',
      usage: usage(100_000),
      sessionId: 's',
    };
    const { d } = deps(session, { effortLevels: levels });
    const r = await switchSessionModel('k', 'grok[1m]', d);
    expect(r).toMatchObject({ status: 'switched', model: 'grok-4.6', effort: 'xhigh' });
    expect(session).toMatchObject({ model: 'grok-4.6', effort: 'xhigh' });
  });

  it('a level the target runs is kept (no effort in the result)', async () => {
    const session: Record<string, any> = {
      model: 'claude-opus-5-5[1m]',
      effort: 'high',
      usage: usage(100_000),
      sessionId: 's',
    };
    const { d } = deps(session, { effortLevels: levels });
    const r = await switchSessionModel('k', 'sol[1m]', d);
    expect(r).not.toHaveProperty('effort');
    expect(session.effort).toBe('high');
  });

  it('a switch that waits for its compact parks the effort it lands with; the session keeps its level until then', async () => {
    const session: Record<string, any> = {
      model: 'gpt-5.6-sol[1m]',
      effort: 'max',
      usage: usage(600_000),
      sessionId: 's',
    };
    const { d } = deps(session, { effortLevels: levels });
    const r = await switchSessionModel('k', 'grok[1m]', d);
    expect(r).toMatchObject({ status: 'compacting', effort: 'xhigh' });
    expect(session.pendingModelSwitch).toMatchObject({ model: 'grok-4.6', effort: 'xhigh' });
    expect(session.effort).toBe('max');
  });
});
