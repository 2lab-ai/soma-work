/**
 * .prd/39 S2 · S3 — phaseOf and placeOf, read off today's fields (A20, the read half). Each row is one legacy
 * field shape and the phase or place it means.
 */
import { describe, expect, it } from 'vitest';
import type { SessionGoal } from '../model';
import { capAskOf, loopDrives, phaseOf, placeOf, slotGoalInFlight, slotHoldOf, stallAskOf } from '../read';

const goal = (over: Partial<SessionGoal> = {}): SessionGoal => ({
  goalId: 'g1',
  objective: 'ship',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'U1',
  continuationCount: 0,
  maxContinuations: 10,
  ...over,
});
const stall = { stallId: 's1', stalledAt: 2, reason: 'same', actions: ['a', 'b', 'c'], confidence: 0.99 };

describe('phaseOf (S3)', () => {
  it.each([
    ['no goal', undefined, undefined],
    ['a queued goal has no phase', goal({ status: 'queued' }), undefined],
    ['a paused goal has no phase', goal({ status: 'paused' }), undefined],
    ['a complete goal has no phase', goal({ status: 'complete' }), undefined],
    ['active with nothing pending', goal(), { kind: 'running' }],
    ['the opening not yet at the model', goal({ openingPending: true }), { kind: 'opening' }],
    [
      'a cap round, its DM landed',
      goal({ capDmPendingAt: 5, capDecisionId: 'r1', capDmRef: { channel: 'D', ts: '1' } }),
      { kind: 'asking', ask: { kind: 'cap', roundId: 'r1', openedAt: 5, dmRef: { channel: 'D', ts: '1' } } },
    ],
    [
      'a legacy cap round without an id stays id-less',
      goal({ capDmPendingAt: 5 }),
      { kind: 'asking', ask: { kind: 'cap', roundId: undefined, openedAt: 5, dmRef: undefined } },
    ],
    ['a stall question', goal({ stall }), { kind: 'asking', ask: { kind: 'stall', stall } }],
    [
      'a judge retry waiting out its window',
      goal({ evalBackoffUntil: 9, evalDispatchRetryCount: 2, evalRetryReason: '429' }),
      { kind: 'retrying', until: 9, attempt: 2, reason: '429' },
    ],
    ['the opening comes before a question', goal({ openingPending: true, capDmPendingAt: 5 }), { kind: 'opening' }],
    [
      'a question comes before a retry',
      goal({ stall, evalBackoffUntil: 9 }),
      { kind: 'asking', ask: { kind: 'stall', stall } },
    ],
  ])('%s', (_name, g, phase) => {
    expect(phaseOf(g)).toEqual(phase);
  });

  it('the loop drives running and retrying only (D2)', () => {
    expect(loopDrives(phaseOf(goal()))).toBe(true);
    expect(loopDrives(phaseOf(goal({ evalBackoffUntil: 9 })))).toBe(true);
    expect(loopDrives(phaseOf(goal({ openingPending: true })))).toBe(false);
    expect(loopDrives(phaseOf(goal({ capDmPendingAt: 5 })))).toBe(false);
    expect(loopDrives(phaseOf(goal({ stall })))).toBe(false);
    expect(loopDrives(phaseOf(goal({ status: 'paused' })))).toBe(false);
  });

  it('capAskOf and stallAskOf name the open question', () => {
    expect(capAskOf(goal({ capDmPendingAt: 5, capDecisionId: 'r1' }))?.roundId).toBe('r1');
    expect(capAskOf(goal({ capDmPendingAt: 5, status: 'paused' }))).toBeUndefined();
    expect(stallAskOf(goal({ stall }))?.stall.stallId).toBe('s1');
    expect(stallAskOf(goal())).toBeUndefined();
  });
});

describe('placeOf (S2)', () => {
  it('finds the goal in the slot, the queue, the shelf or the history', () => {
    const active = goal({ goalId: 'a' });
    const queued = goal({ goalId: 'q', status: 'queued' });
    const shelved = goal({ goalId: 's', status: 'paused' });
    const done = goal({ goalId: 'h', status: 'complete' });
    const session = { goal: active, goalQueue: [queued], goalPaused: [shelved], goalHistory: [done] };
    expect(placeOf(session, active)).toBe('slot-active');
    expect(placeOf(session, queued)).toBe('queue');
    expect(placeOf(session, shelved)).toBe('shelf');
    expect(placeOf(session, done)).toBe('history');
    expect(placeOf(session, goal({ goalId: 'gone' }))).toBeUndefined();
    expect(slotGoalInFlight(session)).toBe(active);
    expect(slotHoldOf(session)).toBeUndefined();
  });

  it('a paused goal in the slot is a hold; a complete one is not in flight', () => {
    const hold = goal({ status: 'paused' });
    expect(placeOf({ goal: hold }, hold)).toBe('slot-hold');
    expect(slotHoldOf({ goal: hold })).toBe(hold);
    expect(slotGoalInFlight({ goal: hold })).toBe(hold);
    const done = goal({ status: 'complete' });
    expect(placeOf({ goal: done }, done)).toBe('slot-complete');
    expect(slotGoalInFlight({ goal: done })).toBeUndefined();
  });
});
