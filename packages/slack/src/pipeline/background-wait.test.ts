import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BackgroundWaitDecisionInput,
  buildBackgroundWaitPrompt,
  DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS,
  decideBackgroundWaitContinuation,
  getBackgroundWaitCap,
} from './background-wait';

function input(over: Partial<BackgroundWaitDecisionInput> = {}): BackgroundWaitDecisionInput {
  return {
    live: { bashCount: 0, taskLabels: [] },
    priorWaitCount: 0,
    cap: 6,
    hasPendingChoice: false,
    hasError: false,
    hasOtherContinuation: false,
    ...over,
  };
}

describe('decideBackgroundWaitContinuation', () => {
  it('RESUMES when a background bash is live and the turn would otherwise complete', () => {
    const d = decideBackgroundWaitContinuation(input({ live: { bashCount: 1, taskLabels: [] } }));
    expect(d.action).toBe('continue');
    if (d.action !== 'continue') throw new Error('unreachable');
    expect(d.continuation.origin).toBe('host');
    expect(d.continuation.prompt).toMatch(/background/i);
    expect(d.nextWaitCount).toBe(1);
  });

  it('RESUMES when a background subagent task is live', () => {
    const d = decideBackgroundWaitContinuation(input({ live: { bashCount: 0, taskLabels: ['Explore'] } }));
    expect(d.action).toBe('continue');
    if (d.action !== 'continue') throw new Error('unreachable');
    expect(d.continuation.prompt).toContain('Explore');
  });

  it('RESETS (completes normally) when no background work is live', () => {
    const d = decideBackgroundWaitContinuation(input({ priorWaitCount: 3 }));
    expect(d.action).toBe('reset');
  });

  it('stops with cap-exceeded once priorWaitCount reaches the cap', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: { bashCount: 2, taskLabels: [] }, priorWaitCount: 6, cap: 6 }),
    );
    expect(d.action).toBe('cap-exceeded');
  });

  it('increments the wait counter across consecutive waits', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: { bashCount: 1, taskLabels: [] }, priorWaitCount: 4, cap: 6 }),
    );
    expect(d.action).toBe('continue');
    if (d.action !== 'continue') throw new Error('unreachable');
    expect(d.nextWaitCount).toBe(5);
  });

  it('does NOT resume when a user choice is pending', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: { bashCount: 1, taskLabels: [] }, hasPendingChoice: true }),
    );
    expect(d.action).toBe('none');
  });

  it('does NOT resume when the turn ended in an error', () => {
    const d = decideBackgroundWaitContinuation(input({ live: { bashCount: 1, taskLabels: [] }, hasError: true }));
    expect(d.action).toBe('none');
  });

  it('does NOT override an existing model/host continuation', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: { bashCount: 1, taskLabels: [] }, hasOtherContinuation: true }),
    );
    expect(d.action).toBe('none');
  });
});

describe('buildBackgroundWaitPrompt', () => {
  it('mentions shell-command and subagent counts plus the attempt/cap', () => {
    const p = buildBackgroundWaitPrompt({ bashCount: 2, taskLabels: ['Explore', 'Plan'] }, 3, 6);
    expect(p).toContain('2 background shell commands');
    expect(p).toContain('2 background subagent tasks');
    expect(p).toContain('Explore, Plan');
    expect(p).toContain('3/6');
    expect(p).toMatch(/Monitor|BashOutput/);
  });
});

describe('getBackgroundWaitCap', () => {
  const KEY = 'BACKGROUND_WAIT_MAX_CONTINUATIONS';
  const saved = process.env[KEY];
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('defaults when unset', () => {
    expect(getBackgroundWaitCap()).toBe(DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS);
  });
  it('honors a positive override', () => {
    process.env[KEY] = '3';
    expect(getBackgroundWaitCap()).toBe(3);
  });
  it('falls back for non-numeric or non-positive values', () => {
    process.env[KEY] = 'nope';
    expect(getBackgroundWaitCap()).toBe(DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS);
    process.env[KEY] = '0';
    expect(getBackgroundWaitCap()).toBe(DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS);
  });
});
