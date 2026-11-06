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
  });

  it('uses singular wording for a single live task', () => {
    const p = buildBackgroundWaitPrompt(liveWork({ count: 1, signature: 'a' }), 1, 6);
    expect(p).toContain('1 background task');
    expect(p).not.toContain('1 background tasks');
  });

  // #997: this prompt resumed a turn whose `gh pr merge` the host had cut. The
  // SDK filled the call with its fixed cancel text and the model told the user
  // they had stopped the merge. The prompt says who cut it.
  it('says the SDK cancel text on a call before it came from the host, not the user (#997)', () => {
    const p = buildBackgroundWaitPrompt(liveWork({ count: 1, signature: 'a' }), 2, 6);
    expect(p).toContain("The user doesn't want to take this action right now");
    // Scoped: a genuine user stop leaves the same text on an earlier call.
    expect(p).toMatch(/If the last tool call of your previous turn reads/);
    expect(p).toMatch(/no message of the user's says they stopped it/);
    expect(p).toMatch(/the host closed that call when the turn ended, not the user/);
    expect(p).toMatch(/Check whether it took effect, then continue/);
  });
});

// #966 — a turn's CLI process ends with the turn, and its background tasks die with it (dev 2026-11-05:
// `bkzs8pdz1 killed` 06:42:17Z, `baxddqx0i stopped` 08:50Z). The resume used to say the runtime keeps them
// alive "until it settles", so the model ended its turn again waiting for a report that never came.
describe('buildBackgroundWaitPrompt — the tasks stopped with the turn (#966)', () => {
  const stopped = liveWork({
    count: 2,
    labels: ['local_agent'],
    signature: 'a1,b1',
    tasks: [
      { taskId: 'b1', taskType: 'local_bash', outputFile: '/tmp/b1.output' },
      { taskId: 'a1', taskType: 'local_agent' },
    ],
  });

  it('says they stopped with the turn and will not report back — never that they still run', () => {
    const p = buildBackgroundWaitPrompt(stopped, 1, 6);
    expect(p).toContain('stopped with it');
    expect(p).toContain('will not report back');
    expect(p).not.toMatch(/still running|keeps this session alive|still reports/i);
  });

  it('names a task by its description too, on one line', () => {
    const p = buildBackgroundWaitPrompt(
      liveWork({
        count: 1,
        signature: 'b2',
        tasks: [{ taskId: 'b2', taskType: 'local_bash', description: 'Wait for\nCI "checks"' }],
      }),
      1,
      6,
    );
    expect(p).toContain('- b2 (local_bash) Wait for CI checks');
  });

  it('names each stopped task with its type and output file', () => {
    const p = buildBackgroundWaitPrompt(stopped, 1, 6);
    expect(p).toContain('- b1 (local_bash) — output file: /tmp/b1.output');
    expect(p).toContain('- a1 (local_agent)');
  });

  it('says how to pick them up in this turn: rerun or wait before ending; SendMessage resumes a subagent', () => {
    const p = buildBackgroundWaitPrompt(stopped, 1, 6);
    expect(p).toContain('rerun a stopped command in the foreground');
    expect(p).toContain('wait for it before you end the turn');
    expect(p).toContain("SendMessage to a stopped subagent's agent ID");
  });

  it('keeps the header the dashboard reads', () => {
    expect(buildBackgroundWaitPrompt(stopped, 2, 6)).toMatch(/^\[background-work-resume 2\/6\]/);
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
