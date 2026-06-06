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

import type { SyntheticMessageEvent } from '../cron-scheduler';
import { buildGoalContinuationPrompt } from '../prompt/session-goal-block';
import type { ConversationSession, SessionGoal } from '../types';
import type { EffortLevel } from '../user-settings-store';
import {
  applyGoalEvalDispatchFailure,
  decideGoalEvalOutcome,
  evaluateGoalCompletion,
  type GoalEvalDispatcher,
  shouldRunGoalIdleDriver,
} from './goal-completion-evaluator';
import { GOAL_CONTINUATION_TEXT_PREFIX } from './goal-continuation';

/** Default ceiling for a single completion eval before it is aborted. */
export const DEFAULT_GOAL_EVAL_TIMEOUT_MS = 120_000;

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
  logger: GoalLoopLogger;
  /** Default work model when the session has none. */
  fallbackModel: string;
  /** Eval timeout; defaults to {@link DEFAULT_GOAL_EVAL_TIMEOUT_MS}. */
  evalTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Snapshot of the goal's identity at eval-dispatch time. A resolved eval
 * is applied only if the live goal still matches this snapshot.
 */
interface GoalEpochSnapshot {
  /** Monotonic counter bumped by every goal mutation + real user message. */
  epoch: number;
  /** Guards against the goal being replaced by a brand-new objective. */
  createdAt: number;
}

export class GoalLoopController {
  private readonly deps: GoalLoopControllerDeps;
  private readonly now: () => number;
  private readonly evalTimeoutMs: number;
  /** Per-session serialization queue — see guarantee (1). */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(deps: GoalLoopControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.evalTimeoutMs = deps.evalTimeoutMs ?? DEFAULT_GOAL_EVAL_TIMEOUT_MS;
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

    // Stamp the lease (pendingEval) so a racing settle can't start a second
    // eval, and snapshot the epoch so we can detect user intent landing
    // during the eval. Every goal-state change drops the cached prompt.
    const startedAt = this.now();
    const snapshot: GoalEpochSnapshot = { epoch: activeGoal.epoch ?? 0, createdAt: activeGoal.createdAt };
    activeGoal.pendingEval = { requestedAt: startedAt, turnId: `${startedAt}` };
    activeGoal.updatedAt = startedAt;
    session.systemPrompt = undefined;
    registry.saveSessions();

    const objective = activeGoal.objective;
    const workSummaryRaw = (session.goalLastTurnText ?? activeGoal.lastAssistantTurnSummary ?? '').trim();
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
      this.handleEvalDispatchFailure(sessionKey, session, snapshot, err);
      return;
    }

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
      if (live && live.createdAt === snapshot.createdAt && live.pendingEval?.requestedAt === startedAt) {
        live.pendingEval = undefined;
        registry.saveSessions();
      }
      return;
    }

    const outcome = decideGoalEvalOutcome(activeGoal, verdict, this.now());
    session.systemPrompt = undefined;
    registry.saveSessions();

    if (outcome.action === 'complete') {
      await this.deps.postNotice(
        session.channelId,
        session.threadTs,
        `✅ Goal completed (eval-model verdict).\n*Objective:* ${objective}\n*Eval reason:* ${verdict.reason}`,
      );
      return;
    }

    const remaining = verdict.remaining.length
      ? verdict.remaining.map((r) => `• ${r}`).join('\n')
      : '_(no remaining items reported)_';

    if (outcome.action === 'cap-paused') {
      logger.info('Goal continuation cap reached', {
        sessionKey,
        continuationCount: activeGoal.continuationCount,
        maxContinuations: activeGoal.maxContinuations,
      });
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

  /** Run the eval bounded by a timeout that aborts the dispatch. */
  private async runEvalWithTimeout(
    session: ConversationSession,
    objective: string,
    workSummary: string,
  ): ReturnType<typeof evaluateGoalCompletion> {
    const abortController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort('goal-eval-timeout');
        reject(new Error(`goal completion eval timed out after ${this.evalTimeoutMs}ms`));
      }, this.evalTimeoutMs);
    });
    try {
      return await Promise.race([
        evaluateGoalCompletion(
          {
            objective,
            workSummary,
            model: session.model || this.deps.fallbackModel,
            effort: session.effort as EffortLevel | undefined,
            abortController,
            cwd: session.workingDirectory,
          },
          this.deps.dispatcher,
        ),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handleEvalDispatchFailure(
    sessionKey: string,
    session: ConversationSession,
    snapshot: GoalEpochSnapshot,
    err: unknown,
  ): void {
    const { registry, logger } = this.deps;
    const live = registry.getSessionByKey(sessionKey)?.goal;
    // Only clear OUR lease, and only if the goal we evaluated is still the
    // live one — otherwise a newer goal owns its own lease.
    if (live && this.epochStillValid(live, snapshot)) {
      applyGoalEvalDispatchFailure(live, this.now());
      session.systemPrompt = undefined;
      registry.saveSessions();
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Goal eval dispatch failed', { sessionKey, error: message });
    void this.deps
      .postNotice(
        session.channelId,
        session.threadTs,
        `⚠️ Goal completion evaluation failed: ${message}. Run \`goal done\` to force completion or \`goal pause\` / \`goal clear\` to stop the loop.`,
      )
      .catch(() => undefined);
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
      routeContext: { skipAutoBotThread: true },
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
   * `createdAt`) and its epoch has not advanced. Any goal mutation or real
   * user message bumps the epoch; a `goal clear`/replace changes
   * `createdAt`. Either invalidates the in-flight eval.
   */
  private epochStillValid(live: SessionGoal | undefined, snapshot: GoalEpochSnapshot): boolean {
    if (!live) return false;
    if (live.createdAt !== snapshot.createdAt) return false;
    return (live.epoch ?? 0) === snapshot.epoch;
  }
}
