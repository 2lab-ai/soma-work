/**
 * Session-goal lifecycle helpers — load-time migration, per-goal
 * active-time attribution, and leg-owner stamping.
 *
 * Extracted from `src/session-registry.ts` (phase 1 of
 * `docs/current/plans/refactoring-hotspots/spec.md`) so the registry
 * consumes the goal domain instead of owning parts of it. The queue /
 * lookup half of the domain lives in `@soma/slack/session-goal`
 * (re-exported by `./session-goal`).
 *
 * Mutation contract (do not mix the styles):
 * - `migrateLegacyGoal` / `migrateLegacyGoalArray` return copies and never
 *   mutate their input — deserialize paths rely on rebinding.
 * - `creditActiveGoalMs` / `stampActiveLegGoalOwner` mutate the live
 *   session/goal in place — the turn timer relies on identity.
 */
import { DEFAULT_GOAL_MAX_CONTINUATIONS, type SessionGoal } from '../types';
import { findGoalById } from './session-goal';

/**
 * Narrow structural view of the session fields the goal lifecycle touches.
 * `ConversationSession` satisfies this; tests can pass a bare object.
 */
export interface GoalLifecycleSession {
  goal?: SessionGoal;
  goalQueue?: SessionGoal[];
  goalHistory?: SessionGoal[];
  /** Owner (goalId) of the in-flight turn leg, captured at beginTurn. */
  activeLegGoalId?: string;
  /** Intent epoch of the leg owner, captured at beginTurn. */
  activeLegGoalEpoch?: number;
}

/**
 * Credit `elapsedMs` of active turn time to the session's active goal (T3).
 * Mirrors how `activeAccumulatedMs` is folded by the turn timer, so a goal's
 * `activeMsUsed` tracks the same wall-clock legs (begin-fold, end, and the
 * load-time orphan sweep) — only while THIS goal is `active`.
 */
export function creditActiveGoalMs(session: GoalLifecycleSession, elapsedMs: number): void {
  if (elapsedMs <= 0) return;
  // Credit the goal that OWNED the leg (captured at beginTurn), resolved across
  // active/queue/history so a `goal done`/advance mid-leg still credits the
  // right goal. Fall back to the live active goal when no owner was recorded
  // (e.g. the load-time orphan sweep before any beginTurn ran this process).
  const goal =
    findGoalById(session, session.activeLegGoalId) ?? (session.goal?.status === 'active' ? session.goal : undefined);
  if (!goal) return;
  goal.activeMsUsed = (goal.activeMsUsed ?? 0) + elapsedMs;
}

/**
 * Stamp the goal (id + intent epoch) that owns the turn leg being started,
 * so a `goal done`/advance mid-turn doesn't misattribute the leg's spend to
 * the promoted goal, AND so the turn-end evidence stash can detect an
 * in-turn objective change (Update bumps the epoch on the same goalId).
 * Clears both fields when no goal is active.
 */
export function stampActiveLegGoalOwner(session: GoalLifecycleSession): void {
  const legGoal = session.goal?.status === 'active' ? session.goal : undefined;
  session.activeLegGoalId = legGoal?.goalId;
  session.activeLegGoalEpoch = legGoal ? (legGoal.epoch ?? 0) : undefined;
}

/**
 * Backfill ralph-loop fields onto a legacy `SessionGoal` loaded from
 * disk. Pre-#959-followup goals lack `continuationCount` /
 * `maxContinuations`, and the loop guards would treat `undefined < N`
 * as `false`, silently disabling continuation. We default to a
 * not-yet-fired loop with the standard cap.
 *
 * The dead `'blocked'` status arm was removed (N11) — it was never
 * assigned in production, but a defensively-persisted `'blocked'` is
 * coerced to `'paused'` on load so a legacy record can't carry an
 * out-of-union status.
 *
 * Also clears `pendingEval` unconditionally on load: it is a
 * process-local lease on an in-flight completion eval (fire-and-forget,
 * in-memory only). No eval can survive a process restart, so a
 * persisted `pendingEval` would permanently suppress the turn-end loop
 * (every turn end short-circuits on `if (goal.pendingEval) return`).
 * Dropping it on load lets the loop resume on the next turn.
 */
export function migrateLegacyGoal(goal: SessionGoal | undefined): SessionGoal | undefined {
  if (!goal) return goal;
  // Stale lease cleanup — see doc comment. Rebind so both the fast path
  // and the backfill path below return a goal without `pendingEval`.
  if (goal.pendingEval !== undefined) {
    goal = { ...goal, pendingEval: undefined };
  }
  // Coerce the retired `'blocked'` status arm (N11) to `'paused'`.
  if ((goal.status as string) === 'blocked') {
    goal = { ...goal, status: 'paused' };
  }
  // Backfill the stable `goalId` (added with the multi-goal queue) for goals
  // persisted before the field existed — the eval snapshot guard keys on it.
  if (typeof goal.goalId !== 'string' || goal.goalId.length === 0) {
    goal = { ...goal, goalId: `goal-legacy-${goal.createdAt}-${Math.random().toString(36).slice(2, 8)}` };
  }
  // Fast path — goal already has all post-followup fields.
  if (
    typeof goal.continuationCount === 'number' &&
    typeof goal.maxContinuations === 'number' &&
    goal.maxContinuations > 0 &&
    typeof goal.evalAttemptCount === 'number'
  ) {
    return goal;
  }
  return {
    ...goal,
    continuationCount: typeof goal.continuationCount === 'number' ? goal.continuationCount : 0,
    maxContinuations:
      typeof goal.maxContinuations === 'number' && goal.maxContinuations > 0
        ? goal.maxContinuations
        : DEFAULT_GOAL_MAX_CONTINUATIONS,
    evalAttemptCount: typeof goal.evalAttemptCount === 'number' ? goal.evalAttemptCount : 0,
  };
}

/** Migrate a persisted goal array (queue / history), dropping nullish entries. */
export function migrateLegacyGoalArray(arr: SessionGoal[] | undefined): SessionGoal[] | undefined {
  if (!Array.isArray(arr) || arr.length === 0) return arr === undefined ? undefined : [];
  return arr.map((g) => migrateLegacyGoal(g)).filter((g): g is SessionGoal => !!g);
}
