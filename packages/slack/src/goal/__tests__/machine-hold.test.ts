/**
 * .prd/39 D6 — a goal held in the slot carries one shape: `status: 'paused'` with `holdWhy`. The hold's transitions
 * write it; taking the slot again clears it. The load keeps it only under a matching fingerprint (D17).
 */
import { describe, expect, it } from 'vitest';
import { pauseCurrentGoalHoldingQueue, resumePausedGoal, settleLoadedPhase, storedGoal } from '../machine';
import type { SessionGoal } from '../model';

const goal = (goalId: string, over: Partial<SessionGoal> = {}): SessionGoal => ({
  goalId,
  objective: goalId,
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'U1',
  continuationCount: 2,
  maxContinuations: 10,
  ...over,
});

describe('goal/machine — the slot hold (D6)', () => {
  it('a dashboard stop with a queue holds the goal in place with its why, and a resume clears it', () => {
    const session = { goal: goal('a'), goalQueue: [goal('b', { status: 'queued' })] };
    const { paused, inPlace } = pauseCurrentGoalHoldingQueue(session);
    expect(inPlace).toBe(true);
    expect(paused?.status).toBe('paused');
    expect(paused?.holdWhy).toBe('dashboard-stop');

    resumePausedGoal(session, 'a');
    expect(session.goal?.status).toBe('active');
    expect(session.goal?.holdWhy).toBeUndefined();
  });

  it('the why survives a save and load under the same fingerprint, and lapses when an older version moved it', () => {
    const held = goal('h', { status: 'paused', holdWhy: 'cap-stop', epoch: 3, updatedAt: 30 });
    const stored = storedGoal(held);
    expect(settleLoadedPhase(JSON.parse(JSON.stringify(stored))).holdWhy).toBe('cap-stop');

    const movedByOld = { ...JSON.parse(JSON.stringify(stored)), epoch: 4 };
    expect(settleLoadedPhase(movedByOld).holdWhy).toBeUndefined();
  });
});
