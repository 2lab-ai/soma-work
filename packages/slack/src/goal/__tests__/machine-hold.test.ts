/**
 * .prd/39 D6 — a goal held in the slot carries one shape: `status: 'paused'` with `holdWhy`. The hold's transitions
 * write it; taking the slot again clears it. The load keeps it only under a matching fingerprint (D17).
 */
import { describe, expect, it } from 'vitest';
import { pauseCurrentGoalHoldingQueue, resumePausedGoal, settleLoadedPhase, storedGoal } from '../machine';
import type { SessionGoal } from '../model';
import { phaseOf } from '../read';

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

  // Review #1498 (P1) — a goal loaded stopped, held in the slot and resumed runs: its stored stop is not carried back.
  it('a loaded stopped goal, held and resumed, runs — the stored stop does not come back', () => {
    const loaded = settleLoadedPhase(
      JSON.parse(JSON.stringify(storedGoal(goal('s', { phase: { kind: 'stopped', why: 'judge-failed', at: 5 } })))),
    );
    expect(phaseOf(loaded)).toMatchObject({ kind: 'stopped' });
    const session = { goal: loaded, goalQueue: [goal('q', { status: 'queued' })] };
    pauseCurrentGoalHoldingQueue(session);
    resumePausedGoal(session, 's');
    expect(session.goal?.status).toBe('active');
    expect(session.goal?.phase).toBeUndefined();
    expect(phaseOf(session.goal)).toEqual({ kind: 'running' });
  });

  it('the why survives a save and load under the same fingerprint, and lapses when an older version moved it', () => {
    const held = goal('h', { status: 'paused', holdWhy: 'cap-stop', epoch: 3, updatedAt: 30 });
    const stored = storedGoal(held);
    expect(settleLoadedPhase(JSON.parse(JSON.stringify(stored))).holdWhy).toBe('cap-stop');

    const movedByOld = { ...JSON.parse(JSON.stringify(stored)), epoch: 4 };
    expect(settleLoadedPhase(movedByOld).holdWhy).toBeUndefined();
  });
});
