/**
 * Goal continuation helpers.
 *
 * The auto-continuation loop is driven from the post-turn completion
 * handler (`index.ts` → `slack-handler.handleAssistantTurnCompleteForGoal`):
 * every turn end while a goal is active forks a clean eval turn, and on a
 * "not yet complete" verdict the handler injects the next continuation
 * turn. See `docs/goal-command/spec.md` §Auto-Continuation Loop.
 *
 * This module no longer schedules continuations itself — it only exposes
 * the shared text prefix and the user-message reset.
 */

import type { ConversationSession, SessionGoal } from '../types';

/** Prefix carried on every synthetic continuation event so log greps and
 *  workflow classifiers can spot goal-loop traffic. */
export const GOAL_CONTINUATION_TEXT_PREFIX = '[goal-continuation]';

/**
 * Bump the goal's intent epoch. Called by every goal mutation (set / pause
 * / resume / done / clear) and by every real user message. The completion
 * eval captures the epoch at dispatch and discards a verdict whose epoch
 * moved while it was in flight (M1) — so a stale eval can never apply
 * against state the user already changed. Idempotent and cheap.
 */
export function bumpGoalEpoch(goal: SessionGoal): void {
  goal.epoch = (goal.epoch ?? 0) + 1;
}

/**
 * Reset loop state when a real user message arrives. Mirrors codex
 * `clear_reserved_goal_continuation_turn`: the appearance of user input
 * zeroes the cap counter — the cap measures "how long has the model been
 * running without the user weighing in," and a user message resets that
 * meter.
 *
 * Caller (slack-handler) is responsible for `saveSessions()` after this
 * returns so the reset is durable across crashes.
 *
 * A pending eval triggered by a previous turn is explicitly NOT cleared
 * here — but the epoch IS bumped, so when that in-flight eval resolves the
 * `GoalLoopController` epoch guard discards its (now stale) verdict instead
 * of applying it against the work the user just steered (M1). The
 * evaluator's resolution clears `pendingEval` on its own.
 *
 * Accepts the structural shape (`{ goal?: SessionGoal }`) instead of the
 * full `ConversationSession` so the somalib-shaped session surfaced by
 * `SessionInitializer.initialize()` is callable without an unsafe cast.
 */
export function resetGoalContinuationOnUserMessage(session: { goal?: ConversationSession['goal'] }): void {
  if (!session.goal) return;
  session.goal.continuationCount = 0;
  // A real user message answers any pending cap-decision DM implicitly — clear
  // the dedup guard so a future cap event can DM again (S3).
  session.goal.capDmPendingAt = undefined;
  // Invalidate any in-flight completion eval — the user just weighed in, so
  // a verdict about the pre-message work must not apply (M1).
  bumpGoalEpoch(session.goal);
}
