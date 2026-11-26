/**
 * Issue #1082 T1: shared session-goal apply helpers.
 *
 * Two host-side paths create an ACTIVE goal on a session outside of
 * `GoalHandler.setGoal` (which requires an existing session):
 *
 *   - `src/slack-handler.ts` — goal-prefixed FIRST message: the objective is
 *     parsed before any session exists, carried out-of-band as
 *     `CommandResult.setGoalObjective`, and applied to the freshly created
 *     session BEFORE the first dispatch so turn 1 already runs with the goal
 *     block.
 *   - `packages/slack/src/pipeline/stream-executor.ts` — the SET_GOAL
 *     model-command host-apply branch (#1082 T2).
 *
 * Lives in `@soma/slack` (not the `src/` composition root) because the
 * package tree must be importable from `stream-executor` without a cycle;
 * The goal types are the one model in `./goal/model` (re-exported below).
 */

export type {
  GoalCompletedVia,
  GoalQueueSession,
  SessionGoal,
  SessionGoalFile,
  SessionGoalFirstFailure,
  SessionGoalPendingEval,
  SessionGoalStall,
  SessionGoalStatus,
} from './goal/model';
export { DEFAULT_GOAL_MAX_CONTINUATIONS, MAX_GOAL_HISTORY } from './goal/model';

/** The queue helpers' goal: the one model (`./goal/model`). The name stays for its callers. */
export type SessionGoalState = import('./goal/model').SessionGoal;

// .prd/40 §2 — transitions live in `./goal/machine`, lookups in `./goal/read`, Slack text in `./goal/format`.
export { formatGoalObjectiveForSlack } from './goal/format';
export * from './goal/machine';
export { findGoalById, findPausedGoal, findPendingGoalPosition } from './goal/read';
