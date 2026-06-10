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
 * the structural types below mirror `SessionGoal` in `src/types.ts`.
 */

export type SessionGoalStatus = 'active' | 'paused' | 'complete';

/**
 * Default cap for `maxContinuations`. Mirrors
 * `DEFAULT_GOAL_MAX_CONTINUATIONS` in `src/types.ts` (the package tree
 * cannot import the composition root). See `docs/goal-command/spec.md`
 * §Auto-Continuation Loop.
 */
export const DEFAULT_GOAL_MAX_CONTINUATIONS = 10;

/**
 * Structural mirror of `SessionGoal` (`src/types.ts`) — only the fields the
 * apply helpers create or clear. The real `SessionGoal` is assignable to
 * this shape and vice versa.
 */
export interface SessionGoalState {
  objective: string;
  status: SessionGoalStatus;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  continuationCount: number;
  maxContinuations: number;
  evalAttemptCount?: number;
  epoch?: number;
  pendingEval?: { requestedAt: number; turnId: string };
  lastEvalReason?: string;
}

/**
 * Build a fresh ACTIVE goal. The epoch is bumped strictly past the prior
 * goal's epoch (when one exists) so an in-flight completion eval for the
 * replaced goal resolves into a discard, never an apply (M1 — see
 * `src/slack/goal-continuation.ts` `bumpGoalEpoch`). Ralph-loop state starts
 * at zero; `pendingEval` / `lastEvalReason` are intentionally absent — a new
 * objective invalidates any eval cycle staged for the old one.
 */
export function createActiveSessionGoal(
  objective: string,
  userId: string,
  existingGoal?: { epoch?: number },
): SessionGoalState {
  const now = Date.now();
  return {
    objective,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    continuationCount: 0,
    maxContinuations: DEFAULT_GOAL_MAX_CONTINUATIONS,
    evalAttemptCount: 0,
    epoch: (existingGoal?.epoch ?? 0) + 1,
  };
}

/**
 * Install `goal` on `session` and invalidate every cached artifact that
 * would otherwise leak pre-goal state into the next turn:
 *
 *   - `systemPrompt` — must be rebuilt so the `<session-goal>` block is
 *     injected (same invalidation `GoalHandler.persistGoalChange` does);
 *   - `goalLastTurnText` — runtime stash of a PRE-goal assistant turn; the
 *     first eval for the new goal must not read it as evidence.
 *
 * Persistence (`claudeHandler.saveSessions()`) is the caller's job.
 */
export function applyGoalToSession(
  session: { goal?: SessionGoalState; systemPrompt?: string; goalLastTurnText?: string },
  goal: SessionGoalState,
): void {
  session.goal = goal;
  session.systemPrompt = undefined;
  session.goalLastTurnText = undefined;
}

/**
 * Render an objective for a Slack notice: whitespace-normalized, clipped to
 * 900 chars, backticks neutralized, wrapped in inline code. Single source for
 * every goal notice (`GoalHandler`, slack-handler 🎯 notice, SET_GOAL
 * host-apply) so the rendering cannot drift between surfaces.
 */
export function formatGoalObjectiveForSlack(objective: string): string {
  const normalized = objective.replace(/\s+/g, ' ').trim();
  const clipped = normalized.length > 900 ? `${normalized.slice(0, 897)}...` : normalized;
  return `\`${clipped.replace(/`/g, "'")}\``;
}
