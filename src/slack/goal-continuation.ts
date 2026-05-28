/**
 * Goal ralph-loop driver — schedules synthetic continuation turns
 * after the session goes idle while an active goal is pending.
 *
 * Port of codex `codex-rs/core/src/goals.rs:1270`
 * (`maybe_continue_goal_if_idle_runtime`) +
 * `goal_continuation_candidate_if_active` (six guards) into the
 * soma-work environment, where the continuation surface is a
 * `SyntheticMessageEvent` injected via `MessageInjector` rather than
 * a codex `start_task` call.
 *
 * Pinned references (commit `46946bb9`):
 * - https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L1270
 * - https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L1275
 * - https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L1360
 * - https://github.com/openai/codex/blob/46946bb91c25b45dec125e29a933b019c61856ff/codex-rs/core/src/goals.rs#L901
 *
 * See `docs/goal-command/spec.md` §Auto-Continuation Loop.
 */

import type { SyntheticMessageEvent } from '../cron-scheduler';
import { Logger } from '../logger';
import { buildGoalContinuationPrompt } from '../prompt/session-goal-block';
import type { ConversationSession } from '../types';

const logger = new Logger('GoalContinuation');

/** Prefix carried on every synthetic continuation event so log greps and
 *  workflow classifiers can spot ralph-loop traffic. */
export const GOAL_CONTINUATION_TEXT_PREFIX = '[goal-continuation]';

export type MessageInjector = (event: SyntheticMessageEvent) => Promise<void>;

export interface GoalContinuationDeps {
  /** Resolve the session for a sessionKey. Returns `undefined` when the
   *  session has been removed between idle drain and ralph-loop check. */
  getSession: (sessionKey: string) => ConversationSession | undefined;
  /** Current activity-state lookup. Re-checked inside the lock so a
   *  racing user turn that flipped `working` between drain and inject
   *  is honored. */
  getActivityState: (sessionKey: string) => string | undefined;
  /** Persist session changes (continuationCount bump etc). */
  saveSessions: () => void;
  /** Fire-and-forget synthetic-message injector. */
  messageInjector: MessageInjector;
  /** Optional Slack notifier for cap-reached / blocked exits. */
  postSystemMessage?: (channel: string, threadTs: string | undefined, text: string) => Promise<void>;
  /** Test seam — defaults to Date.now(). */
  now?: () => number;
}

/**
 * Module-level reentrancy guard: a `Set<sessionKey>` mirroring codex's
 * `continuation_lock: Semaphore::new(1)`. If two idle transitions race
 * (e.g. activity-state churn) only one continuation fires per goal
 * turn.
 */
const inFlightContinuations = new Set<string>();

/**
 * Test-only reset for the module-level lock. Production callers
 * should never touch this — it exists so vitest can run sequential
 * scenarios without bleeding lock state.
 */
export function __resetGoalContinuationLockForTests(): void {
  inFlightContinuations.clear();
}

export type GoalContinuationOutcome =
  | { fired: true; reason: 'injected'; continuationCount: number }
  | {
      fired: false;
      reason:
        | 'no-session'
        | 'no-goal'
        | 'goal-not-active'
        | 'pending-eval'
        | 'not-idle'
        | 'lock-held'
        | 'cap-reached'
        | 'blocked';
    };

/**
 * Decide whether to inject the next continuation turn and fire it if
 * so. Mirrors codex `maybe_continue_goal_if_idle_runtime` →
 * `goal_continuation_candidate_if_active` (six guards).
 *
 * Guard order (matches codex L1360 onward):
 *   1. Session exists
 *   2. Goal exists and `status === 'active'`
 *   3. No `pendingEval` (the eval cycle owns transitions until it
 *      resolves — see spec §Completion via Host-Side Eval Model)
 *   4. Activity state is `'idle'` (re-checked here; the caller is
 *      already on the idle hook but state may have flipped racing
 *      a fresh user turn)
 *   5. No other continuation in flight for the same sessionKey
 *   6. `continuationCount < maxContinuations`
 *
 * On firing: increments `continuationCount`, stamps
 * `lastContinuationAt`, persists, releases the lock after the
 * injector promise resolves (or rejects), and returns
 * `{ fired: true }`.
 */
export async function maybeScheduleGoalContinuation(
  sessionKey: string,
  deps: GoalContinuationDeps,
): Promise<GoalContinuationOutcome> {
  const session = deps.getSession(sessionKey);
  if (!session) return { fired: false, reason: 'no-session' };

  const goal = session.goal;
  if (!goal) return { fired: false, reason: 'no-goal' };
  if (goal.status === 'blocked') return { fired: false, reason: 'blocked' };
  if (goal.status !== 'active') return { fired: false, reason: 'goal-not-active' };

  // Eval cycle owns transitions until it resolves — otherwise we'd
  // inject a continuation the work model writes against stale
  // evidence and the evaluator races itself.
  if (goal.pendingEval) return { fired: false, reason: 'pending-eval' };

  // Re-check idle: an injector queued before a user typed could
  // otherwise fire after the user's fresh turn started.
  const state = deps.getActivityState(sessionKey);
  if (state !== 'idle') return { fired: false, reason: 'not-idle' };

  // Single-permit lock — codex `continuation_lock: Semaphore::new(1)`.
  // Released in the finally below so an injector failure cannot
  // permanently mask future continuations.
  if (inFlightContinuations.has(sessionKey)) return { fired: false, reason: 'lock-held' };

  if (goal.continuationCount >= goal.maxContinuations) {
    logger.info('Goal continuation cap reached', {
      sessionKey,
      continuationCount: goal.continuationCount,
      maxContinuations: goal.maxContinuations,
    });
    if (deps.postSystemMessage) {
      try {
        await deps.postSystemMessage(
          session.channelId,
          session.threadTs,
          `⏹️ Goal auto-continuation paused after ${goal.maxContinuations} synthetic turns. Send a message in this thread to resume.`,
        );
      } catch (err: unknown) {
        logger.warn('Failed to post cap-reached notice', {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { fired: false, reason: 'cap-reached' };
  }

  inFlightContinuations.add(sessionKey);
  try {
    const now = deps.now ? deps.now() : Date.now();
    goal.continuationCount = goal.continuationCount + 1;
    goal.lastContinuationAt = now;
    deps.saveSessions();

    const promptText = buildGoalContinuationPrompt(goal);
    const syntheticEvent: SyntheticMessageEvent = {
      user: goal.createdBy,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: `${now / 1000}`,
      text: `${GOAL_CONTINUATION_TEXT_PREFIX} ${promptText}`,
      synthetic: true,
      // Bypass workflow classification — this is a goal-driven turn,
      // not a fresh routable request.
      skipDispatch: true,
      routeContext: { skipAutoBotThread: true },
    };

    logger.info('Injecting goal continuation', {
      sessionKey,
      continuationCount: goal.continuationCount,
      maxContinuations: goal.maxContinuations,
      hasEvalReason: Boolean(goal.lastEvalReason),
    });

    await deps.messageInjector(syntheticEvent);

    return { fired: true, reason: 'injected', continuationCount: goal.continuationCount };
  } catch (err: unknown) {
    logger.error('Goal continuation injection failed', {
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    inFlightContinuations.delete(sessionKey);
  }
}

/**
 * Reset ralph-loop state when a real user message arrives. Mirrors
 * codex `clear_reserved_goal_continuation_turn` (L901): the
 * appearance of user input invalidates a pending continuation. We
 * also zero the cap counter — the cap measures "how long has the
 * model been running without the user weighing in," and a user
 * message resets that meter.
 *
 * Caller (slack-handler) is responsible for `saveSessions()` after
 * this returns so the reset is durable across crashes.
 *
 * Accepts the structural shape (`{ goal?: SessionGoal }`) instead of
 * the full `ConversationSession` so the somalib-shaped session
 * surfaced by `SessionInitializer.initialize()` is callable without
 * an unsafe cast.
 */
export function resetGoalContinuationOnUserMessage(session: { goal?: ConversationSession['goal'] }): void {
  if (!session.goal) return;
  session.goal.continuationCount = 0;
  session.goal.consecutiveBlockedSignals = 0;
  // A pending eval triggered by a previous synthetic turn is
  // explicitly NOT cleared here — if the work model said "complete"
  // and the user typed before the evaluator returned, the eval result
  // is still informative. The evaluator's resolution clears
  // pendingEval on its own.
}
