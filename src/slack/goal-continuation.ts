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
import { retireGoalCapDecision } from './goal-cap-decision';
import { retireGoalStall } from './goal-stall';

/** Prefix carried on every synthetic continuation event so log greps and
 *  workflow classifiers can spot goal-loop traffic. */
export const GOAL_CONTINUATION_TEXT_PREFIX = '[goal-continuation]';

/** The work-summary evidence a goal persists (`lastAssistantTurnSummary`), and what the eval's S9 hash covers. */
export const GOAL_SUMMARY_PERSIST_MAX = 16_000;

/**
 * Bump the goal's intent epoch — `bumpEpoch` of `@soma/slack/goal/machine`, the one way the epoch moves (.prd/39 I4).
 * Called by every goal mutation and by every real user message; it also ends a judge retry window armed for the old
 * epoch. The name stays for its callers.
 */
export { bumpEpoch as bumpGoalEpoch } from '@soma/slack/goal/machine';

import { bumpEpoch as bumpGoalEpoch, reopenStoppedGoal } from '@soma/slack/goal/machine';

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
  // The owner wrote: an open stall round ends (this turn clears its question).
  retireGoalStall(session.goal, 'user-message');
  // A real user message answers any pending cap decision implicitly: it ends,
  // its DM stops offering buttons, and a future cap event asks again (S3).
  retireGoalCapDecision(session.goal);
  // A user nudge also resets the transient eval-dispatch failure streak and
  // lifts any pending backoff window — user intent always outranks the
  // self-healing retry machinery.
  session.goal.evalDispatchRetryCount = undefined;
  session.goal.evalBackoffUntil = undefined;
  session.goal.evalRetryReason = undefined;
  // .prd/39 S3 · D8 — the person's word opens a stopped goal again (judge-failed, start-failed, resume-failed,
  // person-stopped): their turn runs and its end drives the loop.
  reopenStoppedGoal(session.goal);
  // Invalidate any in-flight completion eval — the user just weighed in, so
  // a verdict about the pre-message work must not apply (M1).
  bumpGoalEpoch(session.goal);
}
