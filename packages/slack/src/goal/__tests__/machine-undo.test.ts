/**
 * .prd/39 D10 · A8 (X8) — an undo puts the goals back, but not a question the change already retired. Retiring a
 * question has effects outside the session (its DM is rewritten as resolved, its buttons stop answering), so a goal
 * restored with the question's fields would wait on a question nobody can answer. A question the change did not
 * touch is restored as it was.
 */
import { describe, expect, it } from 'vitest';
import { deleteCurrentGoal, endGoalCapDecision, restoreGoalState, snapshotGoalState } from '../machine';
import type { SessionGoal } from '../model';
import { capAskOf, phaseOf, stallAskOf } from '../read';

const goal = (goalId: string, over: Partial<SessionGoal> = {}): SessionGoal => ({
  goalId,
  objective: goalId,
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'U1',
  continuationCount: 10,
  maxContinuations: 10,
  ...over,
});
const capRound = { capDmPendingAt: 5, capDecisionId: 'round-1', capDmRef: { channel: 'D1', ts: '1.1' } };
const stall = { stallId: 's1', stalledAt: 2, reason: 'same', actions: ['a'], confidence: 0.99 };

describe('restoreGoalState — an undo does not revive a retired question (X8)', () => {
  it('A8: delete the goal asking the cap question, the promotion is refused, the undo restores it without the question', () => {
    const asking = goal('a', capRound);
    const session = { goal: asking, goalQueue: [goal('b', { status: 'queued', continuationCount: 0 })] };
    const before = snapshotGoalState(session);

    // The change: the question ends with the goal (its DM is rewritten), the next goal is promoted.
    endGoalCapDecision(asking);
    deleteCurrentGoal(session);
    expect(session.goal?.goalId).toBe('b');

    // The promoted goal's first turn was refused: put everything back.
    restoreGoalState(session, before);
    expect(session.goal).toBe(asking);
    expect(session.goalQueue?.map((g) => g.goalId)).toEqual(['b']);
    expect(capAskOf(session.goal)).toBeUndefined();
    expect(session.goal?.capDecisionId).toBeUndefined();
    expect(session.goal?.capDmRef).toBeUndefined();
    expect(phaseOf(session.goal)).toEqual({ kind: 'running' });
  });

  it('a stall question the change retired is not restored either', () => {
    const stalled = goal('s', { stall, continuationCount: 1 });
    const session = { goal: stalled };
    const before = snapshotGoalState(session);
    endGoalCapDecision(stalled); // the default retirer ends the stall round too
    restoreGoalState(session, before);
    expect(stallAskOf(session.goal)).toBeUndefined();
  });

  it('a question the change did not touch comes back as it was', () => {
    const asking = goal('a', capRound);
    const session = { goal: asking };
    const before = snapshotGoalState(session);
    asking.objective = 'edited';
    restoreGoalState(session, before);
    expect(session.goal?.objective).toBe('a');
    expect(capAskOf(session.goal)).toMatchObject({ roundId: 'round-1', openedAt: 5 });
    expect(session.goal?.capDmRef).toEqual({ channel: 'D1', ts: '1.1' });
  });
});
