import { describe, expect, it } from 'vitest';
import { DEFAULT_GOAL_MAX_CONTINUATIONS, type SessionGoal } from '../../types';
import {
  creditActiveGoalMs,
  type GoalLifecycleSession,
  migrateLegacyGoal,
  migrateLegacyGoalArray,
  stampActiveLegGoalOwner,
} from '../session-goal-lifecycle';

// RED tests for the phase-1 extraction (docs/current/plans/refactoring-hotspots).
// SSOT mapping: T2 ("리팩토링 진행해줘") — pins the behavior of the goal-lifecycle
// helpers currently embedded in src/session-registry.ts before they move.

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-1',
    objective: 'test objective',
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: DEFAULT_GOAL_MAX_CONTINUATIONS,
    evalAttemptCount: 0,
    ...overrides,
  };
}

describe('migrateLegacyGoal', () => {
  it('returns undefined for undefined input', () => {
    expect(migrateLegacyGoal(undefined)).toBeUndefined();
  });

  it('clears a persisted pendingEval lease (process-local, cannot survive restart)', () => {
    const goal = makeGoal({ pendingEval: { requestedAt: 123, turnId: 't-1' } });
    const migrated = migrateLegacyGoal(goal);
    expect(migrated?.pendingEval).toBeUndefined();
    // Returns a copy — the input object is not mutated.
    expect(goal.pendingEval).toEqual({ requestedAt: 123, turnId: 't-1' });
  });

  it("coerces the retired 'blocked' status to 'paused'", () => {
    const goal = makeGoal({ status: 'blocked' as SessionGoal['status'] });
    expect(migrateLegacyGoal(goal)?.status).toBe('paused');
  });

  it('backfills a stable goalId when missing', () => {
    const goal = { ...makeGoal({ createdAt: 42 }), goalId: undefined } as unknown as SessionGoal;
    const migrated = migrateLegacyGoal(goal);
    expect(typeof migrated?.goalId).toBe('string');
    expect(migrated?.goalId).toMatch(/^goal-legacy-42-/);
  });

  it('backfills ralph-loop fields on pre-followup goals', () => {
    const goal = {
      ...makeGoal(),
      continuationCount: undefined,
      maxContinuations: undefined,
      evalAttemptCount: undefined,
    } as unknown as SessionGoal;
    const migrated = migrateLegacyGoal(goal);
    expect(migrated?.continuationCount).toBe(0);
    expect(migrated?.maxContinuations).toBe(DEFAULT_GOAL_MAX_CONTINUATIONS);
    expect(migrated?.evalAttemptCount).toBe(0);
  });

  it('fast path: returns a fully-populated goal unchanged', () => {
    const goal = makeGoal({ continuationCount: 3, maxContinuations: 5, evalAttemptCount: 2 });
    const migrated = migrateLegacyGoal(goal);
    expect(migrated).toBe(goal);
  });
});

describe('migrateLegacyGoalArray', () => {
  it('returns undefined for undefined input', () => {
    expect(migrateLegacyGoalArray(undefined)).toBeUndefined();
  });

  it('returns [] for an empty array', () => {
    expect(migrateLegacyGoalArray([])).toEqual([]);
  });

  it('migrates each entry and drops nullish entries', () => {
    const legacy = makeGoal({ status: 'blocked' as SessionGoal['status'] });
    const arr = [legacy, undefined as unknown as SessionGoal];
    const migrated = migrateLegacyGoalArray(arr);
    expect(migrated).toHaveLength(1);
    expect(migrated?.[0].status).toBe('paused');
  });
});

describe('creditActiveGoalMs', () => {
  it('credits the leg-owner goal resolved by activeLegGoalId across the queue', () => {
    const owner = makeGoal({ goalId: 'owner', status: 'complete', activeMsUsed: 10 });
    const promoted = makeGoal({ goalId: 'promoted', status: 'active' });
    const session: GoalLifecycleSession = {
      goal: promoted,
      goalHistory: [owner],
      activeLegGoalId: 'owner',
    };
    creditActiveGoalMs(session, 500);
    expect(owner.activeMsUsed).toBe(510);
    expect(promoted.activeMsUsed).toBeUndefined();
  });

  it('falls back to the live active goal when no leg owner is recorded', () => {
    const active = makeGoal({ status: 'active' });
    const session: GoalLifecycleSession = { goal: active };
    creditActiveGoalMs(session, 250);
    expect(active.activeMsUsed).toBe(250);
  });

  it('does not credit a non-active fallback goal', () => {
    const paused = makeGoal({ status: 'paused' });
    const session: GoalLifecycleSession = { goal: paused };
    creditActiveGoalMs(session, 250);
    expect(paused.activeMsUsed).toBeUndefined();
  });

  it('no-ops on elapsedMs <= 0', () => {
    const active = makeGoal({ status: 'active', activeMsUsed: 7 });
    creditActiveGoalMs({ goal: active }, 0);
    creditActiveGoalMs({ goal: active }, -5);
    expect(active.activeMsUsed).toBe(7);
  });
});

describe('stampActiveLegGoalOwner', () => {
  it('stamps goalId and epoch (defaulting epoch to 0) for an active goal', () => {
    const active = makeGoal({ goalId: 'g-active', status: 'active' });
    const session: GoalLifecycleSession = { goal: active };
    stampActiveLegGoalOwner(session);
    expect(session.activeLegGoalId).toBe('g-active');
    expect(session.activeLegGoalEpoch).toBe(0);
  });

  it('stamps the explicit epoch when present', () => {
    const active = makeGoal({ goalId: 'g-active', status: 'active', epoch: 4 });
    const session: GoalLifecycleSession = { goal: active };
    stampActiveLegGoalOwner(session);
    expect(session.activeLegGoalEpoch).toBe(4);
  });

  it('clears the stamp when there is no active goal', () => {
    const paused = makeGoal({ status: 'paused' });
    const session: GoalLifecycleSession = {
      goal: paused,
      activeLegGoalId: 'stale',
      activeLegGoalEpoch: 9,
    };
    stampActiveLegGoalOwner(session);
    expect(session.activeLegGoalId).toBeUndefined();
    expect(session.activeLegGoalEpoch).toBeUndefined();
  });
});
