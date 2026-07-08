/**
 * GoalLoopController — the single owner of the goal auto-continuation
 * ("ralph") loop.
 *
 * Before this module the loop lived as a ~170-line closure in `index.ts`
 * bootstrap, with its correctness resting on an implicit temporal ordering
 * between independent lifecycle hooks (the turn-settled trigger firing
 * after `removeController` released the request slot). That ordering was
 * enforced only by comments and was re-broken three times (#1054 spin,
 * #1058 never-checks, #1061 fix). This controller makes the loop an owned,
 * unit-testable state machine — see `docs/goal-command/spec.md`
 * §Auto-Continuation Loop.
 *
 * Guarantees this module provides:
 *
 *   1. **Serialization** — work for a given session is run through a
 *      per-session promise queue, so two evals (or an eval and an
 *      injection) for the same session can never overlap. The trigger is
 *      fire-and-forget from the caller's perspective; ordering is owned
 *      here, not by the caller's call stack.
 *   2. **Epoch guard (M1)** — every eval captures the goal's `epoch` at
 *      dispatch. `epoch` is bumped by every goal mutation (set / pause /
 *      resume / done / clear) AND by every real user message. If the epoch
 *      moved while the eval was in flight, the resolved verdict is
 *      discarded: it does not mutate goal state, persist, post a notice,
 *      increment/cap the counter, complete, or inject. The user's newer
 *      intent always wins.
 *   3. **Bounded eval (M3)** — every eval runs under a timeout +
 *      `AbortController`. A hung dispatch can no longer wedge the loop for
 *      the life of the process; on timeout the lease clears via the
 *      dispatch-failure path and one notice posts.
 *   4. **Never-supersede injection (M2)** — the continuation is injected
 *      only if the session is still idle; the caller threads an atomic
 *      slot reservation so a real user turn that starts during the eval is
 *      never aborted by the injection.
 */

import { createHash } from 'node:crypto';
import { boundRateLimitDelayMs, parseRetryAfterMs, textIndicatesRetryableRateLimit } from '@soma/common/rate-limit';
import type { SyntheticMessageEvent } from '../cron-scheduler';
import { buildGoalContinuationPrompt } from '../prompt/session-goal-block';
import type { ConversationSession, SessionGoal } from '../types';
import type { EffortLevel } from '../user-settings-store';
import { buildCapDecisionDmBlocks } from './goal-blocks';
import {
  applyGoalEvalDispatchFailure,
  decideGoalEvalOutcome,
  evaluateGoalCompletion,
  type GoalEvalDispatcher,
  type GoalEvalVerdict,
  shouldRunGoalIdleDriver,
} from './goal-completion-evaluator';
import { GOAL_CONTINUATION_TEXT_PREFIX } from './goal-continuation';
import { advanceGoalQueue, formatGoalObjectiveForSlack } from './session-goal';

/** Default ceiling for a single completion eval before it is aborted. */
const DEFAULT_GOAL_EVAL_TIMEOUT_MS = 120_000;

/**
 * Consecutive eval-dispatch failures the loop self-heals before falling back
 * to the terminal "run `goal done` / `goal pause`" notice. Counts transient
 * API failures (429 pool rate limit, 529 overloaded, timeouts, flaky JSON),
 * NOT completed eval cycles.
 */
export const GOAL_EVAL_DISPATCH_MAX_RETRIES = 3;

/**
 * Backoff before a scheduled re-eval when the failure carries no explicit
 * "retry in Ns" window (timeouts, parse flakes, unknown API errors).
 */
export const GOAL_EVAL_RETRY_DEFAULT_DELAY_MS = 60_000;

/**
 * After the eval timeout aborts the dispatch, how long we keep listening for
 * the dispatch's OWN (richer, typed) rejection before failing with the
 * generic timeout error. The dispatch seam rejects promptly on abort and its
 * error carries `poolRateLimitRetryMs` when the abort interrupted a
 * rate-limit wait — that window is what lets the loop schedule the retry at
 * the gateway-advertised time instead of a blind 60s backoff.
 */
const GOAL_EVAL_ABORT_GRACE_MS = 5_000;

/**
 * Extract the delay before a scheduled eval retry from a dispatch failure.
 * Prefers the gateway-advertised rate-limit window (stashed
 * `poolRateLimitRetryMs`, else parsed from the message), bounded to the
 * shared [1s, 1h] band; anything else gets the fixed default backoff.
 * Pure — exported for tests.
 */
export function extractEvalRetryDelayMs(err: unknown): number {
  const stashed = (err as { poolRateLimitRetryMs?: unknown })?.poolRateLimitRetryMs;
  if (typeof stashed === 'number' && Number.isFinite(stashed) && stashed >= 0) {
    return boundRateLimitDelayMs(stashed);
  }
  const message = String((err as { message?: unknown })?.message ?? '');
  if (textIndicatesRetryableRateLimit(message)) {
    return boundRateLimitDelayMs(parseRetryAfterMs(message));
  }
  return GOAL_EVAL_RETRY_DEFAULT_DELAY_MS;
}

/** Minimal logger surface (matches the project `Logger`). */
export interface GoalLoopLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Session-registry surface the controller needs. */
export interface GoalLoopRegistry {
  getSessionByKey(sessionKey: string): ConversationSession | undefined;
  getActivityStateByKey(sessionKey: string): string | undefined;
  saveSessions(): void;
}

/** Request-coordinator surface the controller needs. */
export interface GoalLoopRequestCoordinator {
  isRequestActive(sessionKey: string): boolean;
}

export interface GoalLoopControllerDeps {
  registry: GoalLoopRegistry;
  requestCoordinator: GoalLoopRequestCoordinator;
  /** Runs the eval dispatch (production: `ClaudeHandler.dispatchOneShot`). */
  dispatcher: GoalEvalDispatcher;
  /** Injects a synthetic continuation turn (production: handleMessage path). */
  injectContinuation: (event: SyntheticMessageEvent) => Promise<void>;
  /** Posts an in-thread system notice. */
  postNotice: (channel: string, threadTs: string | undefined, text: string) => Promise<unknown>;
  /**
   * DMs the goal owner a Block Kit message (S3). Used when the
   * auto-continuation budget is exhausted to ask "keep going?" with
   * Continue/Cancel buttons. Optional — when unset the loop falls back to the
   * in-thread pause notice only.
   */
  postOwnerDm?: (userId: string, text: string, blocks: unknown[]) => Promise<unknown>;
  logger: GoalLoopLogger;
  /** Default work model when the session has none. */
  fallbackModel: string;
  /**
   * Optional cheaper eval tier (S9). When set, the completion eval runs on
   * this model instead of the session's work model — the eval only emits a
   * small strict-JSON verdict, so a lighter model is usually sufficient and
   * far cheaper at fleet scale. When unset, the eval matches the work model.
   */
  evalModelOverride?: string;
  /** Eval timeout; defaults to {@link DEFAULT_GOAL_EVAL_TIMEOUT_MS}. */
  evalTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Schedules a deferred eval-retry callback (production: unref'd
   * `setTimeout`). Injectable so tests can capture and fire retries
   * synchronously instead of faking timers.
   */
  scheduleEvalRetry?: (fn: () => void, delayMs: number) => void;
}

/**
 * Snapshot of the goal's identity at eval-dispatch time. A resolved eval
 * is applied only if the live goal still matches this snapshot.
 */
interface GoalEpochSnapshot {
  /** Monotonic counter bumped by every goal mutation + real user message. */
  epoch: number;
  /**
   * Stable goal identity. Keying the guard on `goalId` (not `createdAt`)
   * means a verdict can never apply against a different goal that happens to
   * share a `createdAt` — including a queue-promoted goal created in the same
   * millisecond as the one that just completed.
   */
  goalId: string;
}

export class GoalLoopController {
  private readonly deps: GoalLoopControllerDeps;
  private readonly now: () => number;
  private readonly evalTimeoutMs: number;
  private readonly scheduleEvalRetry: (fn: () => void, delayMs: number) => void;
  /** Per-session serialization queue — see guarantee (1). */
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Sessions with a scheduled eval retry currently armed, keyed by the
   * goal-intent snapshot the retry was armed for. Dedups re-arming for the
   * SAME intent (multiple gated settles during one backoff window must not
   * stack timers) while letting a NEWER intent (epoch/goal moved, then a
   * fresh failure) supersede a stale armed timer — the stale timer's
   * `token` no longer matches, so it no-ops instead of deleting the fresh
   * arm's bookkeeping. In-memory on purpose: a restart loses the timers AND
   * this map together, so the first post-restart settle re-arms exactly one
   * retry for the remaining `evalBackoffUntil` window.
   */
  private readonly armedEvalRetries = new Map<string, { token: object; goalId: string; epoch: number }>();

  constructor(deps: GoalLoopControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.evalTimeoutMs = deps.evalTimeoutMs ?? DEFAULT_GOAL_EVAL_TIMEOUT_MS;
    this.scheduleEvalRetry =
      deps.scheduleEvalRetry ??
      ((fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        // Never keep the process alive just for a retry.
        if (typeof timer.unref === 'function') timer.unref();
      });
  }

  /**
   * Trigger entry — called once per assistant turn end while a goal is
   * active, AFTER the turn released its request slot. Enqueues a single
   * driver run on the session's serial queue and returns immediately.
   * This is the ONLY public way to advance the loop; the caller never
   * touches loop state directly (M4 — ordering is owned here).
   */
  onTurnSettled(sessionKey: string): void {
    this.enqueue(sessionKey, () => this.runOnce(sessionKey));
  }

  /**
   * Resolve once the session's queued work has drained. Used by tests and
   * by a graceful shutdown that wants to let an in-flight eval settle.
   */
  async settled(sessionKey: string): Promise<void> {
    await (this.queues.get(sessionKey) ?? Promise.resolve());
  }

  /** Chain `fn` onto the session's serial queue; failures never break it. */
  private enqueue(sessionKey: string, fn: () => Promise<void>): void {
    const prev = this.queues.get(sessionKey) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(fn)
      .catch((err: unknown) => {
        this.deps.logger.warn('Goal loop run failed', {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        // Drop the queue entry once drained so the map doesn't grow without
        // bound. A new trigger re-seeds it.
        if (this.queues.get(sessionKey) === next) this.queues.delete(sessionKey);
      });
    this.queues.set(sessionKey, next);
  }

  /** One eval (+ maybe one continuation) for a settled session. */
  private async runOnce(sessionKey: string): Promise<void> {
    const { registry, requestCoordinator, logger } = this.deps;
    const session = registry.getSessionByKey(sessionKey);
    const goal = session?.goal;
    if (
      !session ||
      !shouldRunGoalIdleDriver({
        goal,
        requestActive: requestCoordinator.isRequestActive(sessionKey),
        activityState: registry.getActivityStateByKey(sessionKey),
      })
    ) {
      return;
    }
    const activeGoal = session.goal!;

    // Transient-failure backoff gate: while a scheduled eval retry is waiting
    // out a rate-limit window, ordinary settles (e.g. a duplicate trigger that
    // was already queued behind the failing run) must NOT re-dispatch — they
    // would hammer the same 429 and burn the retry budget instantly. The
    // scheduled retry clears the stamp when it fires; the timestamp
    // self-expires so a lost timer (process restart) can never wedge the loop.
    if (activeGoal.evalBackoffUntil !== undefined && this.now() < activeGoal.evalBackoffUntil) {
      const backoffMsRemaining = activeGoal.evalBackoffUntil - this.now();
      logger.info('Goal eval skipped — transient-failure backoff in effect', { sessionKey, backoffMsRemaining });
      // Re-arm (deduped) a retry for the REMAINING window. Normally the
      // failure path already armed one and this is a no-op; after a restart
      // the timer was lost while `evalBackoffUntil` persisted, so without
      // this the loop would stall until unrelated user activity.
      this.armEvalRetry(sessionKey, { epoch: activeGoal.epoch ?? 0, goalId: activeGoal.goalId }, backoffMsRemaining);
      return;
    }

    const objective = activeGoal.objective;
    const workSummaryRaw = (session.goalLastTurnText ?? activeGoal.lastAssistantTurnSummary ?? '').trim();
    const summaryHash = this.hashSummary(workSummaryRaw);

    // S9 cost short-circuit: if the work summary is byte-identical to what we
    // last evaluated and we already hold that verdict's gap reason, a fresh
    // eval would return the same "not complete" — skip the (expensive)
    // dispatch and reuse it. Empty summaries never short-circuit (no evidence
    // to reuse), and a `complete` verdict clears the hash so it never sticks.
    if (workSummaryRaw !== '' && activeGoal.lastEvalSummaryHash === summaryHash && activeGoal.lastEvalReason) {
      logger.info('Goal eval short-circuited — work summary unchanged since last eval', { sessionKey });
      await this.handleVerdict(
        sessionKey,
        session,
        activeGoal,
        { completed: false, reason: activeGoal.lastEvalReason, remaining: [] },
        summaryHash,
      );
      return;
    }

    // Stamp the lease (pendingEval) so a racing settle can't start a second
    // eval, and snapshot the epoch so we can detect user intent landing
    // during the eval. Every goal-state change drops the cached prompt.
    const startedAt = this.now();
    const snapshot: GoalEpochSnapshot = { epoch: activeGoal.epoch ?? 0, goalId: activeGoal.goalId };
    activeGoal.pendingEval = { requestedAt: startedAt, turnId: `${startedAt}` };
    activeGoal.updatedAt = startedAt;
    session.systemPrompt = undefined;
    registry.saveSessions();

    const evalUserSummary = [
      'Eval trigger: idle-settle (work turn ended)',
      '',
      '## Assistant turn output (latest work turn)',
      workSummaryRaw ? workSummaryRaw.slice(0, 16_000) : '(no assistant text was produced this turn)',
    ].join('\n');

    logger.info('Goal session settled idle — dispatching completion eval', { sessionKey });

    let verdict;
    try {
      verdict = await this.runEvalWithTimeout(session, objective, evalUserSummary);
    } catch (err: unknown) {
      this.handleEvalDispatchFailure(sessionKey, session, snapshot, startedAt, err);
      return;
    }

    // A successful dispatch (verdict obtained) closes the transient-failure
    // streak — the retry budget only measures CONSECUTIVE dispatch failures.
    activeGoal.evalDispatchRetryCount = undefined;
    activeGoal.evalBackoffUntil = undefined;

    // M1 epoch guard — if the user changed the goal or sent a message while
    // the eval ran, the live goal no longer matches what we evaluated.
    // Discard the verdict entirely: no mutate / persist / notice / inject.
    const live = registry.getSessionByKey(sessionKey)?.goal;
    if (!this.epochStillValid(live, snapshot)) {
      logger.info('Goal eval verdict discarded — goal epoch moved during eval', { sessionKey });
      // Clear OUR stale lease so the loop isn't wedged: same goal object
      // (createdAt unchanged) and the lease is the one WE stamped
      // (requestedAt === startedAt). Epoch may have advanced — that is
      // exactly the discard case — but the lease is still ours to release.
      // A replaced/cleared goal (createdAt changed) owns its own lease; we
      // never touch it.
      if (live && live.goalId === snapshot.goalId && live.pendingEval?.requestedAt === startedAt) {
        live.pendingEval = undefined;
        registry.saveSessions();
      }
      return;
    }

    await this.handleVerdict(sessionKey, session, activeGoal, verdict, summaryHash);
  }

  /**
   * Apply a verdict: mutate goal state, post the Slack notice, and on a
   * `continue` outcome inject the next continuation (never superseding a live
   * turn). Shared by the real-eval path and the S9 short-circuit path.
   */
  private async handleVerdict(
    sessionKey: string,
    session: ConversationSession,
    activeGoal: SessionGoal,
    verdict: GoalEvalVerdict,
    summaryHash: string,
  ): Promise<void> {
    const { registry, requestCoordinator, logger } = this.deps;
    const outcome = decideGoalEvalOutcome(activeGoal, verdict, this.now());
    // Remember which summary produced this verdict so an identical next turn
    // can short-circuit (S9). A `complete` verdict stops the loop, so clear it.
    activeGoal.lastEvalSummaryHash = outcome.action === 'complete' ? undefined : summaryHash;
    session.systemPrompt = undefined;

    if (outcome.action === 'complete') {
      // Pin the eval reason on the goal so `goal` status history can show why
      // it closed. `applyGoalEvalSuccess` already set status/audit fields.
      activeGoal.completionReason = verdict.reason;
      // Multi-goal (T2): archive the finished goal and promote the next queued
      // goal. Shared `advanceGoalQueue` keeps this identical to user `goal done`.
      //
      // CRITICAL (codex blocking #1): persist ONLY after the advance, never
      // between the status flip and the advance. Otherwise a crash there would
      // leave disk in an inconsistent `status=complete` + non-empty `goalQueue`
      // state and the queued goal would be stranded on restart (resumeActiveGoals
      // only scans active goals). One durable write = a consistent state:
      // either the next goal is active, or the goal is closed with an empty queue.
      const next = advanceGoalQueue(session);
      registry.saveSessions();

      await this.deps.postNotice(
        session.channelId,
        session.threadTs,
        `✅ Goal completed (eval-model verdict).\n*Objective:* ${activeGoal.objective}\n*Eval reason:* ${verdict.reason}`,
      );

      if (next) {
        await this.deps.postNotice(
          session.channelId,
          session.threadTs,
          `▶️ Starting next queued goal:\n*Objective:* ${next.objective}`,
        );
        // Re-enter the ralph loop for the promoted goal — unless a real user
        // turn started during the eval, in which case defer (never supersede).
        if (requestCoordinator.isRequestActive(sessionKey)) {
          logger.info('Queued-goal continuation deferred — session became busy during eval', { sessionKey });
          return;
        }
        this.injectContinuationTurn(sessionKey, session, next as SessionGoal);
      }
      return;
    }

    // Non-complete (continue / cap): persist the loop-state mutations
    // (`continuationCount`, `lastEvalReason`, `lastContinuationAt`) that
    // `decideGoalEvalOutcome` applied. The complete branch above owns its own
    // single post-advance save and returns before reaching here.
    registry.saveSessions();

    const remaining = verdict.remaining.length
      ? verdict.remaining.map((r) => `• ${r}`).join('\n')
      : '_(no remaining items reported)_';

    if (outcome.action === 'cap-paused') {
      logger.info('Goal continuation cap reached', {
        sessionKey,
        continuationCount: activeGoal.continuationCount,
        maxContinuations: activeGoal.maxContinuations,
      });
      // S3: instead of silently pausing, DM the owner a "keep going?" decision
      // with Continue/Cancel buttons. `capDmPendingAt` dedups so exactly one DM
      // is sent per cap event (it's cleared on a Continue/Cancel answer or any
      // real user message via resetGoalContinuationOnUserMessage).
      const alreadyAsked = activeGoal.capDmPendingAt !== undefined;
      if (this.deps.postOwnerDm && !alreadyAsked) {
        const blocks = buildCapDecisionDmBlocks({
          value: {
            sessionKey,
            goalId: activeGoal.goalId,
            channel: session.channelId,
            threadTs: session.threadTs,
          },
          objective: activeGoal.objective,
          maxContinuations: activeGoal.maxContinuations,
          reason: verdict.reason,
          formatObjective: formatGoalObjectiveForSlack,
        });
        // Send the DM FIRST; only stamp the dedup guard on success so a failed
        // send never leaves the goal flagged-but-undecided with no retry path
        // (codex review #1). On failure, fall through to the in-thread notice;
        // a later cap trigger can retry the DM since the flag was never set.
        let dmSent = false;
        try {
          await this.deps.postOwnerDm(activeGoal.createdBy, '⏳ Goal 계속 진행할까요?', blocks);
          dmSent = true;
        } catch (err: unknown) {
          logger.warn('Failed to DM goal owner the cap decision — falling back to thread notice', {
            sessionKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (dmSent) {
          activeGoal.capDmPendingAt = this.now();
          registry.saveSessions();
          await this.deps.postNotice(
            session.channelId,
            session.threadTs,
            `⏸️ Goal auto-continuation reached its ${activeGoal.maxContinuations}-turn budget. Asked the owner via DM whether to keep going.`,
          );
          return;
        }
      }
      // Fallback (no DM transport, already asked, or DM send failed): keep the
      // original in-thread pause notice.
      await this.deps.postNotice(
        session.channelId,
        session.threadTs,
        `⏹️ Goal auto-continuation paused after ${activeGoal.maxContinuations} turns.\n*Latest reason:* ${verdict.reason}\nSend a message in this thread to resume.`,
      );
      return;
    }

    await this.deps.postNotice(
      session.channelId,
      session.threadTs,
      `🔄 Goal not yet complete (eval-model verdict).\n*Reason:* ${verdict.reason}\n*Remaining:*\n${remaining}`,
    );

    // Never supersede a turn that started during the eval. A live request
    // means a user (or already-running) turn owns the slot — defer; the
    // next turn-settled trigger re-runs the loop.
    if (requestCoordinator.isRequestActive(sessionKey)) {
      logger.info('Goal continuation deferred — session became busy during eval', { sessionKey });
      return;
    }

    this.injectContinuationTurn(sessionKey, session, activeGoal);
  }

  /** Stable hash of the work summary for the S9 unchanged-summary check. */
  private hashSummary(summary: string): string {
    return createHash('sha1').update(summary).digest('hex');
  }

  /**
   * Run the eval bounded by a timeout that aborts the dispatch.
   *
   * The abort and the failure are deliberately SPLIT: at `evalTimeoutMs` the
   * dispatch is aborted, but we keep listening for its own rejection for a
   * short grace window before failing with the generic timeout error. The
   * dispatch seam rejects promptly on abort with a typed error that carries
   * `poolRateLimitRetryMs` when the abort interrupted a rate-limit wait —
   * racing a bare rejection at `evalTimeoutMs` (the old shape) swallowed that
   * window, so the retry scheduler could never honor the gateway's
   * "retry in Ns" hint. A dispatch that ignores the abort entirely still
   * fails at `evalTimeoutMs + grace` (M3 boundedness holds).
   */
  private async runEvalWithTimeout(
    session: ConversationSession,
    objective: string,
    workSummary: string,
  ): ReturnType<typeof evaluateGoalCompletion> {
    const abortController = new AbortController();
    const graceMs = Math.min(GOAL_EVAL_ABORT_GRACE_MS, this.evalTimeoutMs);
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let failTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      abortTimer = setTimeout(() => {
        abortController.abort('goal-eval-timeout');
        failTimer = setTimeout(
          () => reject(new Error(`goal completion eval timed out after ${this.evalTimeoutMs}ms`)),
          graceMs,
        );
      }, this.evalTimeoutMs);
    });
    try {
      return await Promise.race([
        evaluateGoalCompletion(
          {
            objective,
            workSummary,
            // S9: prefer the configured cheaper eval tier; otherwise match the
            // work model so the eval is never weaker than the worker.
            model: this.deps.evalModelOverride || session.model || this.deps.fallbackModel,
            effort: session.effort as EffortLevel | undefined,
            abortController,
            cwd: session.workingDirectory,
          },
          this.deps.dispatcher,
        ),
        timeout,
      ]);
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (failTimer) clearTimeout(failTimer);
    }
  }

  private handleEvalDispatchFailure(
    sessionKey: string,
    session: ConversationSession,
    snapshot: GoalEpochSnapshot,
    startedAt: number,
    err: unknown,
  ): void {
    const { registry, logger } = this.deps;
    const live = registry.getSessionByKey(sessionKey)?.goal;
    const epochValid = live !== undefined && this.epochStillValid(live, snapshot);
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Goal eval dispatch failed', { sessionKey, error: message });

    // Epoch moved during the failed eval (user message / goal mutation): the
    // user's newer intent supersedes this eval entirely — no retry, no notice.
    // But the lease is still OURS to release (same goal object, same
    // `requestedAt` we stamped) — mirroring the success-path discard cleanup;
    // leaving it set would wedge every future driver run behind `pendingEval`.
    if (!epochValid) {
      if (live && live.goalId === snapshot.goalId && live.pendingEval?.requestedAt === startedAt) {
        live.pendingEval = undefined;
        registry.saveSessions();
      }
      logger.info('Goal eval dispatch failure discarded — goal epoch moved during eval', { sessionKey });
      return;
    }

    // Only clear OUR lease, and only if the goal we evaluated is still the
    // live one — otherwise a newer goal owns its own lease.
    if (live) {
      applyGoalEvalDispatchFailure(live, this.now());
      session.systemPrompt = undefined;
      registry.saveSessions();
    }

    // Self-heal transient API failures (429 pool rate limit, 529, timeouts,
    // flaky output): schedule a re-eval after the failure's advertised window
    // (or a fixed backoff) instead of stopping the loop on a manual notice.
    if (live) {
      const retriesUsed = live.evalDispatchRetryCount ?? 0;
      if (retriesUsed < GOAL_EVAL_DISPATCH_MAX_RETRIES) {
        const delayMs = extractEvalRetryDelayMs(err);
        live.evalDispatchRetryCount = retriesUsed + 1;
        // Backoff stamp: any settle that lands before the scheduled retry
        // fires is skipped by the runOnce gate, so queued duplicate triggers
        // can never hammer the same 429 window and burn the budget instantly.
        live.evalBackoffUntil = this.now() + delayMs;
        registry.saveSessions();
        logger.warn('Scheduling goal eval retry after transient dispatch failure', {
          sessionKey,
          attempt: live.evalDispatchRetryCount,
          maxRetries: GOAL_EVAL_DISPATCH_MAX_RETRIES,
          delayMs,
        });
        void this.deps
          .postNotice(
            session.channelId,
            session.threadTs,
            `⏳ Goal completion evaluation hit a transient API error — retrying in ${Math.round(delayMs / 1000)}s ` +
              `(attempt ${live.evalDispatchRetryCount}/${GOAL_EVAL_DISPATCH_MAX_RETRIES}).\n*Error:* ${message}`,
          )
          .catch(() => undefined);
        this.armEvalRetry(sessionKey, snapshot, delayMs);
        return;
      }
      // Budget exhausted — reset the streak so a user nudge starts a fresh
      // budget instead of landing straight back on the terminal notice.
      live.evalDispatchRetryCount = undefined;
      registry.saveSessions();
    }

    void this.deps
      .postNotice(
        session.channelId,
        session.threadTs,
        `⚠️ Goal completion evaluation failed: ${message}. Run \`goal done\` to force completion or \`goal pause\` / \`goal clear\` to stop the loop.`,
      )
      .catch(() => undefined);
  }

  /**
   * Arm (at most one per session) a scheduled eval retry that re-enters
   * through the ONE public entry, `onTurnSettled`, so the retry rides the
   * same serial queue and re-checks every gate (idle / requestActive /
   * pendingEval) at fire time. The fire-time snapshot check makes the retry
   * a no-op when the user weighed in (or the goal was replaced) during the
   * wait — their own turn-settled trigger drives the loop then, so the
   * retry never produces a stale extra eval. On a valid fire it lifts the
   * `evalBackoffUntil` gate so the re-entered run can actually dispatch.
   */
  private armEvalRetry(sessionKey: string, snapshot: GoalEpochSnapshot, delayMs: number): void {
    const existing = this.armedEvalRetries.get(sessionKey);
    // Same intent already armed → dedupe. A DIFFERENT intent (goal replaced
    // or epoch moved since the stale arm) must NOT be suppressed — the stale
    // timer will fail its own snapshot check, so without replacement the new
    // backoff window would be left with no timer at all (stall).
    if (existing && existing.goalId === snapshot.goalId && existing.epoch === snapshot.epoch) return;
    const token = {};
    this.armedEvalRetries.set(sessionKey, { token, goalId: snapshot.goalId, epoch: snapshot.epoch });
    this.scheduleEvalRetry(() => {
      // Superseded by a newer arm → this timer no longer owns the session's
      // retry; never delete the newer arm's bookkeeping.
      if (this.armedEvalRetries.get(sessionKey)?.token !== token) return;
      this.armedEvalRetries.delete(sessionKey);
      const liveAtFire = this.deps.registry.getSessionByKey(sessionKey)?.goal;
      if (!liveAtFire || !this.epochStillValid(liveAtFire, snapshot)) return;
      // OUR window elapsed — lift the backoff gate so the retry (and any
      // later natural settle) can dispatch again.
      liveAtFire.evalBackoffUntil = undefined;
      this.deps.registry.saveSessions();
      this.onTurnSettled(sessionKey);
    }, delayMs);
  }

  private injectContinuationTurn(sessionKey: string, session: ConversationSession, activeGoal: SessionGoal): void {
    const now = this.now();
    const syntheticEvent: SyntheticMessageEvent = {
      user: activeGoal.createdBy,
      channel: session.channelId,
      thread_ts: session.threadTs,
      ts: `${now / 1000}`,
      text: `${GOAL_CONTINUATION_TEXT_PREFIX} ${buildGoalContinuationPrompt(activeGoal)}`,
      synthetic: true,
      skipDispatch: true,
      // `goalContinuation` makes session-initializer DROP this turn (never
      // supersede) if a live request is found at concurrency-control time —
      // closing the residual async-gap window where a user turn started
      // after our pre-injection idle recheck (M2).
      routeContext: { skipAutoBotThread: true, goalContinuation: true },
    };
    this.deps.logger.info('Injecting goal continuation', {
      sessionKey,
      continuationCount: activeGoal.continuationCount,
      maxContinuations: activeGoal.maxContinuations,
    });
    // Fire-and-forget. Injection is the only thing that drives the loop
    // forward on 'continue'; if it throws the loop silently stalls, so
    // escalate to error + an actionable notice.
    this.deps.injectContinuation(syntheticEvent).catch(async (err: unknown) => {
      const injectErr = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('Goal continuation injection failed — loop stalled', { sessionKey, error: injectErr });
      try {
        await this.deps.postNotice(
          session.channelId,
          session.threadTs,
          `⚠️ Goal continuation failed to start: ${injectErr}. The loop is paused — send a message in this thread to resume, or use \`goal pause\` / \`goal clear\`.`,
        );
      } catch (noticeErr: unknown) {
        this.deps.logger.error('Failed to post goal continuation-failure notice', {
          sessionKey,
          error: noticeErr instanceof Error ? noticeErr.message : String(noticeErr),
        });
      }
    });
  }

  /**
   * A snapshot is still valid iff the live goal is the SAME goal (same
   * `goalId`) and its epoch has not advanced. Any goal mutation or real
   * user message bumps the epoch; a `goal clear`/replace/queue-advance swaps
   * in a goal with a different `goalId`. Either invalidates the in-flight eval.
   */
  private epochStillValid(live: SessionGoal | undefined, snapshot: GoalEpochSnapshot): boolean {
    if (!live) return false;
    // Fail closed on a missing/empty goalId on either side — never let
    // `undefined === undefined` pass the identity check (would defeat M1 for
    // hand-built/legacy state). Production goals always carry a goalId
    // (creation + migration backfill).
    if (!live.goalId || !snapshot.goalId) return false;
    if (live.goalId !== snapshot.goalId) return false;
    return (live.epoch ?? 0) === snapshot.epoch;
  }
}
