/**
 * #598 ④b1 — the ordered decision of a task turn's outcome (design 598b v5
 * §7 + §14.2/§14.3). The first matching row wins.
 */
import { describe, expect, it } from 'vitest';
import { deriveTaskTurnOutcome, type TaskTurnTerminalSignals } from '../task-turn-outcome';

const success = (over: Partial<TaskTurnTerminalSignals> = {}): TaskTurnTerminalSignals => ({
  exit: 'success',
  endTurnInfoPresent: true,
  ...over,
});
const error = (over: Partial<TaskTurnTerminalSignals> = {}): TaskTurnTerminalSignals => ({ exit: 'error', ...over });
const open = () => true;

describe('deriveTaskTurnOutcome (§7)', () => {
  it.each([
    ['1 fallbackCompact → no terminal', error({ fallbackCompact: true, thrownError: true }), null],
    ['2 user-stop → cancelled', error({ abortReason: 'user-stop' }), { outcome: 'cancelled', category: 'Exception' }],
    [
      '3 session-close → cancelled',
      error({ abortReason: 'session-close' }),
      { outcome: 'cancelled', category: 'Exception' },
    ],
    ['4 supersede → no terminal', error({ abortReason: 'supersede' }), null],
    ['4 user-interrupted → no terminal', error({ abortReason: 'user-interrupted' }), null],
    ['5 shutdown → no terminal', error({ abortReason: 'shutdown' }), null],
    [
      '6a stall → interrupted / Stalled',
      error({ abortReason: 'stall-timeout' }),
      { outcome: 'interrupted', category: 'Stalled' },
    ],
    [
      '6b ghost → interrupted / Exception',
      error({ abortReason: 'ghost-session' }),
      { outcome: 'interrupted', category: 'Exception' },
    ],
    [
      '6c unknown → interrupted / Exception',
      error({ abortReason: '__unknown' }),
      { outcome: 'interrupted', category: 'Exception' },
    ],
    [
      '7 abort-like without a controller abort',
      error({ abortLike: true }),
      { outcome: 'interrupted', reason: 'transport aborted' },
    ],
    ['8 thrown error', error({ thrownError: true, reasonText: 'boom' }), { outcome: 'failed', reason: 'boom' }],
    [
      '8 thrown error with a retry → retryable',
      error({ thrownError: true, retryAfterMs: 5000 }),
      { outcome: 'failed', retryable: true },
    ],
    [
      '9 SDK result error',
      success({ hasSdkError: true, reasonText: 'max_turns' }),
      { outcome: 'failed', reason: 'max_turns' },
    ],
    ['10 renew failed', success({ renewFailed: true }), { outcome: 'failed', reason: 'renew failed' }],
    [
      '11 normal EOF without a result',
      success({ endTurnInfoPresent: false }),
      { outcome: 'interrupted', reason: 'stream ended without a result' },
    ],
    [
      '12 question open',
      success({ choiceStillOpen: open, questionTitle: 'Pick one' }),
      { outcome: 'waiting', category: 'UIUserAskQuestion', reason: 'Pick one' },
    ],
    ['13 otherwise', success(), { outcome: 'completed', category: 'WorkflowComplete' }],
  ])('%s', (_label, signals, expected) => {
    const got = deriveTaskTurnOutcome(signals);
    if (expected === null) expect(got).toBeNull();
    else expect(got).toMatchObject(expected);
  });

  it('explicit failures rank above an open question (a3 M3)', () => {
    expect(deriveTaskTurnOutcome(success({ hasSdkError: true, choiceStillOpen: open }))?.outcome).toBe('failed');
    expect(deriveTaskTurnOutcome(error({ abortReason: 'user-stop', choiceStillOpen: open }))?.outcome).toBe(
      'cancelled',
    );
  });

  it('the EOF rule does not override an explicit error or abort', () => {
    expect(deriveTaskTurnOutcome(success({ endTurnInfoPresent: false, hasSdkError: true }))?.outcome).toBe('failed');
    expect(deriveTaskTurnOutcome(error({ abortReason: 'user-stop' }))?.outcome).toBe('cancelled');
  });

  it('the question is read through the probe at decision time (an answer during the drain completes the turn)', () => {
    let answered = false;
    const signals = success({ choiceStillOpen: () => !answered });
    answered = true;
    expect(deriveTaskTurnOutcome(signals)?.outcome).toBe('completed');
  });

  describe('a recording failure', () => {
    it('turns completed into failed with a record reason', () => {
      expect(deriveTaskTurnOutcome(success(), 'ENOSPC')).toMatchObject({ outcome: 'failed', reason: 'record: ENOSPC' });
    });
    it('keeps any other outcome and carries the failure beside it', () => {
      expect(deriveTaskTurnOutcome(error({ abortReason: 'user-stop' }), 'ENOSPC')).toMatchObject({
        outcome: 'cancelled',
        recordFailure: 'ENOSPC',
      });
    });
    it('does not create an outcome for a non-terminal return', () => {
      expect(deriveTaskTurnOutcome(error({ abortReason: 'supersede' }), 'ENOSPC')).toBeNull();
    });
  });
});
