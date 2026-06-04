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

import type { ConversationSession } from '../types';

/** Prefix carried on every synthetic continuation event so log greps and
 *  workflow classifiers can spot goal-loop traffic. */
export const GOAL_CONTINUATION_TEXT_PREFIX = '[goal-continuation]';

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
 * here — if the work model's turn ended and the user typed before the
 * evaluator returned, the eval result is still informative. The
 * evaluator's resolution clears `pendingEval` on its own.
 *
 * Accepts the structural shape (`{ goal?: SessionGoal }`) instead of the
 * full `ConversationSession` so the somalib-shaped session surfaced by
 * `SessionInitializer.initialize()` is callable without an unsafe cast.
 */
export function resetGoalContinuationOnUserMessage(session: { goal?: ConversationSession['goal'] }): void {
  if (!session.goal) return;
  session.goal.continuationCount = 0;
  session.goal.consecutiveBlockedSignals = 0;
}
