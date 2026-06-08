import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BackgroundWaitDecisionInput,
  buildBackgroundWaitPrompt,
  DEFAULT_BACKGROUND_WAIT_MAX_CONTINUATIONS,
  decideBackgroundWaitContinuation,
  getBackgroundWaitCap,
  type LiveBackgroundWork,
} from './background-wait';

const liveWork = (over: Partial<LiveBackgroundWork> = {}): LiveBackgroundWork => ({
  count: 0,
  labels: [],
  signature: '',
  ...over,
});

function input(over: Partial<BackgroundWaitDecisionInput> = {}): BackgroundWaitDecisionInput {
  return {
    live: liveWork(),
    priorWaitCount: 0,
    cap: 6,
    hasPendingChoice: false,
    hasError: false,
    hasOtherContinuation: false,
    ...over,
  };
}

describe('decideBackgroundWaitContinuation', () => {
  it('RESUMES when a background task is live and the turn would otherwise complete', () => {
    const d = decideBackgroundWaitContinuation(input({ live: liveWork({ count: 1, signature: 'b1' }) }));
    expect(d.action).toBe('continue');
    if (d.action !== 'continue') throw new Error('unreachable');
    expect(d.continuation.origin).toBe('host');
    expect(d.continuation.prompt).toMatch(/background/i);
    expect(d.nextWaitCount).toBe(1);
  });

  it('includes subagent labels in the resume prompt', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: liveWork({ count: 1, labels: ['Explore'], signature: 'b1' }) }),
    );
    expect(d.action).toBe('continue');
    if (d.action !== 'continue') throw new Error('unreachable');
    expect(d.continuation.prompt).toContain('Explore');
  });

  it('RESETS (completes normally) when no background work is live', () => {
    const d = decideBackgroundWaitContinuation(input({ priorWaitCount: 3 }));
    expect(d.action).toBe('reset');
  });

  it('stops with cap-exceeded once priorWaitCount reaches the cap, carrying the signature', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: liveWork({ count: 2, signature: 'b1,b2' }), priorWaitCount: 6, cap: 6 }),
    );
    expect(d.action).toBe('cap-exceeded');
    if (d.action !== 'cap-exceeded') throw new Error('unreachable');
    expect(d.suppressSignature).toBe('b1,b2');
  });

  it('SUPPRESSES (none) while the gave-up signature is still live — no re-resume, no re-warn', () => {
    const d = decideBackgroundWaitContinuation(
      input({
        live: liveWork({ count: 2, signature: 'b1,b2' }),
        priorWaitCount: 6,
        cap: 6,
        suppressedSignature: 'b1,b2',
      }),
    );
    expect(d.action).toBe('none');
  });

  it('RE-ARMS when the live signature changes from the suppressed one', () => {
    // one task settled → signature is now 'b2' ≠ suppressed 'b1,b2' → resume again
    const d = decideBackgroundWaitContinuation(
      input({ live: liveWork({ count: 1, signature: 'b2' }), priorWaitCount: 1, cap: 6, suppressedSignature: 'b1,b2' }),
    );
    expect(d.action).toBe('continue');
  });

  it('increments the wait counter across consecutive waits', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: liveWork({ count: 1, signature: 'b1' }), priorWaitCount: 4, cap: 6 }),
    );
    expect(d.action).toBe('continue');
    if (d.action !== 'continue') throw new Error('unreachable');
    expect(d.nextWaitCount).toBe(5);
  });

  it('does NOT resume when a user choice is pending', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: liveWork({ count: 1, signature: 'b1' }), hasPendingChoice: true }),
    );
    expect(d.action).toBe('none');
  });

  it('does NOT resume when the turn ended in an error', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: liveWork({ count: 1, signature: 'b1' }), hasError: true }),
    );
    expect(d.action).toBe('none');
  });

  it('does NOT override an existing model/host continuation', () => {
    const d = decideBackgroundWaitContinuation(
      input({ live: liveWork({ count: 1, signature: 'b1' }), hasOtherContinuation: true }),
    );
    expect(d.action).toBe('none');
  });
});

describe('buildBackgroundWaitPrompt', () => {
  it('mentions the live count, labels, and attempt/cap — and does NOT tell the model to poll TaskOutput/BashOutput', () => {
    const p = buildBackgroundWaitPrompt(liveWork({ count: 2, labels: ['Explore', 'Plan'], signature: 'a,b' }), 3, 6);
    expect(p).toContain('2 background tasks');
    expect(p).toContain('Explore, Plan');
    expect(p).toContain('3/6');
    // The runtime owns the signal now — the prompt must NOT instruct deprecated polling.
    expect(p).not.toMatch(/TaskOutput|BashOutput/);
    expect(p).toMatch(/runtime/i);
  });

  it('uses singular wording for a single live task', () => {
    const p = buildBackgroundWaitPrompt(liveWork({ count: 1, signature: 'a' }), 1, 6);
    expect(p).toContain('1 background task');
    expect(p).not.toContain('1 background tasks');
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
