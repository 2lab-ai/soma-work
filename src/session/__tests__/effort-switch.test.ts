import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../types';
import { EffortSwitchError, type EffortSwitchDeps, switchSessionEffort } from '../effort-switch';

// SSOT T1 — the dashboard changes a session's reasoning effort (one click on the
// card or at the top of the session panel). The switch only touches the session
// (the `%effort` scope); the next turn's SDK call reads `session.effort`.

function session(over: Partial<ConversationSession> = {}): ConversationSession {
  return { ownerId: 'U1', model: 'claude-opus-4-7', effort: 'xhigh', ...over } as unknown as ConversationSession;
}

function deps(s: ConversationSession | undefined, over: Partial<EffortSwitchDeps> = {}): EffortSwitchDeps {
  return {
    getSession: () => s,
    clamp: (_model, effort) => effort,
    save: vi.fn(),
    broadcast: vi.fn(),
    ...over,
  };
}

describe('switchSessionEffort', () => {
  it('sets session.effort, saves and broadcasts', () => {
    const s = session();
    const d = deps(s);
    const r = switchSessionEffort('C1:t1', 'high', d);
    expect(s.effort).toBe('high');
    expect(r).toEqual({ status: 'switched', effort: 'high', previous: 'xhigh', effective: 'high' });
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
  });

  it('accepts any case and surrounding spaces, like the Slack resolver', () => {
    const s = session();
    switchSessionEffort('C1:t1', '  MAX ', deps(s));
    expect(s.effort).toBe('max');
  });

  it('reports unchanged without writing when the level is already set', () => {
    const s = session({ effort: 'high' } as Partial<ConversationSession>);
    const d = deps(s);
    expect(switchSessionEffort('C1:t1', 'high', d).status).toBe('unchanged');
    expect(d.save).not.toHaveBeenCalled();
  });

  it('reports the effective level when the model clamps the request', () => {
    const s = session({ model: 'grok-4.6' } as Partial<ConversationSession>);
    const r = switchSessionEffort('C1:t1', 'max', deps(s, { clamp: () => 'high' }));
    expect(s.effort).toBe('max');
    expect(r.effective).toBe('high');
  });

  it('rejects an unknown level with 400', () => {
    expect(() => switchSessionEffort('C1:t1', 'ultra', deps(session()))).toThrow(EffortSwitchError);
    try {
      switchSessionEffort('C1:t1', 'turbo', deps(session()));
    } catch (e) {
      expect((e as EffortSwitchError).statusCode).toBe(400);
    }
  });

  it('rejects a missing session with 404 and a terminated one with 409', () => {
    const missing = () => switchSessionEffort('C1:t1', 'low', deps(undefined));
    expect(missing).toThrow(EffortSwitchError);
    try {
      missing();
    } catch (e) {
      expect((e as EffortSwitchError).statusCode).toBe(404);
    }
    try {
      switchSessionEffort('C1:t1', 'low', deps(session({ terminated: true } as Partial<ConversationSession>)));
    } catch (e) {
      expect((e as EffortSwitchError).statusCode).toBe(409);
    }
  });
});
