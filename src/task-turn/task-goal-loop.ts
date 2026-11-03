/**
 * The goal loop on a Slack-less dashboard task (SSOT 2026-11-03).
 *
 * The loop itself is `GoalLoopController` — one owner for Slack threads and
 * tasks. A task differs in three seams, wired here:
 *
 *   1. Trigger — a Slack turn fires the loop from its turn-settled hook; a
 *      task fires it from its chain's end (`onChainEnd`, after the task is free
 *      again), with the chain's last answer stashed as the eval's evidence.
 *   2. Continuation — a Slack goal turn is a synthetic thread message; a task's
 *      is a host start on the task controller, marked `goalContinuation` (not
 *      user input). It never supersedes: a task already running refuses it
 *      (its own chain end runs the loop again). The owner's other task holding
 *      the one dashboard slot, or a full start window, is waited out (bounded).
 *   3. The user — a person's instruction to the task resets the goal's
 *      continuation count, as a Slack message does.
 */

import type { SyntheticMessageEvent } from '../cron-scheduler';
import { GOAL_SUMMARY_PERSIST_MAX, resetGoalContinuationOnUserMessage } from '../slack/goal-continuation';
import type { ConversationSession } from '../types';
import type { TaskCommandRequest, TaskCommandResponse } from './task-turn-controller';

/** How often a continuation the owner's slot (or window) refused is tried again, and how many times. */
export const TASK_GOAL_START_RETRY_MS = 30_000;
export const TASK_GOAL_START_MAX_RETRIES = 20;

export interface TaskGoalLoopDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  /** The task controller's `start` (host start). */
  start(request: TaskCommandRequest): Promise<TaskCommandResponse>;
  /** The chain's last answer: the final of the task's last turn, from its work log. */
  readLastFinal(session: ConversationSession): Promise<string | undefined>;
  saveSessions(): void;
  /** The task controller's `isRunning`: a newer chain owns the task (and the loop) now. */
  isRunning(sessionKey: string): boolean;
  /** `GoalLoopController.onTurnSettled` — a turn ended: judge the goal. */
  settle(sessionKey: string): void;
  logger: {
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
  };
  retryDelayMs?: number;
  maxRetries?: number;
  /** Injectable for tests (production: unref'd `setTimeout`). */
  schedule?: (fn: () => void, delayMs: number) => void;
}

export interface TaskGoalLoop {
  /**
   * The task controller's chain end: a chain of a task with an active goal that
   * started and ended healthily (`completed`) wakes the loop — as a Slack turn
   * wakes it only from a normal finish. Stop, a failure or an interruption does
   * not: Stop means stop, and the owner's next instruction runs the loop again.
   */
  onChainEnd(sessionKey: string, info: { started: boolean; stopped?: boolean; outcome?: string }): Promise<void>;
  /** `GoalLoopController.injectContinuation` for a task. */
  injectContinuation(event: SyntheticMessageEvent, target: { sessionKey: string }): Promise<void>;
  /** The task controller's `onUserInstruction`. */
  onUserInstruction(sessionKey: string, session: ConversationSession): void;
}

/** The goal a continuation was meant for is still the live one (same goal, same intent epoch). */
function sameGoal(session: ConversationSession | undefined, goalId: string | undefined, epoch: number): boolean {
  const goal = session?.goal;
  return !!goal && goal.status === 'active' && !!goalId && goal.goalId === goalId && (goal.epoch ?? 0) === epoch;
}

/** A refusal that waits for something else to end (the owner's one dashboard slot, the start window). */
function isWaitable(response: TaskCommandResponse): boolean {
  return response.status === 429 && !/cost limit/.test(String(response.body.error ?? ''));
}

export function createTaskGoalLoop(deps: TaskGoalLoopDeps): TaskGoalLoop {
  const retryDelayMs = deps.retryDelayMs ?? TASK_GOAL_START_RETRY_MS;
  const maxRetries = deps.maxRetries ?? TASK_GOAL_START_MAX_RETRIES;
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number) => {
      const timer = setTimeout(fn, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

  async function onChainEnd(
    sessionKey: string,
    info: { started: boolean; stopped?: boolean; outcome?: string },
  ): Promise<void> {
    if (!info.started || info.stopped || info.outcome !== 'completed') return;
    const session = deps.getSession(sessionKey);
    const goal = session?.goal;
    if (!session || session.slackless !== true || !goal || goal.status !== 'active') return;
    // #876 R2 (grok P1) — a goal whose first turn has not started (its opening waits in the queue):
    // the turn that just ended was not its work, and its opening's own end runs the loop.
    if (goal.openingPending === true) return;
    // The fence (#861 R1, astra-zhuge P1): this end speaks for its own turn only. Pinned before the
    // read and checked after it — a newer instruction (epoch), a newer turn, a running chain or a
    // Stop own the loop then, and this late end neither writes evidence nor wakes the loop.
    const goalId = goal.goalId;
    const epoch = goal.epoch ?? 0;
    const turnId = session.lastTurnOutcome?.turnId;
    const fresh = (): boolean => {
      const live = deps.getSession(sessionKey);
      return (
        live === session &&
        sameGoal(live, goalId, epoch) &&
        live.lastTurnOutcome?.turnId === turnId &&
        !deps.isRunning(sessionKey)
      );
    };
    // The turn credits the goal only if the goal did not change under it (Slack's rule:
    // an update or a delete mid-turn invalidates the evidence). The loop still runs.
    const legGoalId = session.activeLegGoalId;
    const changed =
      legGoalId !== undefined && (legGoalId !== goal.goalId || (session.activeLegGoalEpoch ?? 0) !== (goal.epoch ?? 0));
    let text: string | undefined;
    if (!changed) {
      try {
        text = await deps.readLastFinal(session);
      } catch (error) {
        deps.logger.warn('Task goal evidence could not be read', { sessionKey, error: (error as Error)?.message });
      }
    }
    if (!fresh()) {
      deps.logger.info('Task goal chain end superseded — a newer turn or instruction owns the loop', { sessionKey });
      return;
    }
    if (!changed) {
      const turnText = text ?? '';
      session.goalLastTurnText = turnText;
      goal.lastAssistantTurnSummary = turnText.slice(0, GOAL_SUMMARY_PERSIST_MAX);
      deps.saveSessions();
    }
    deps.settle(sessionKey);
  }

  async function injectContinuation(event: SyntheticMessageEvent, target: { sessionKey: string }): Promise<void> {
    const { sessionKey } = target;
    const first = deps.getSession(sessionKey);
    const goalId = first?.goal?.goalId;
    const epoch = first?.goal?.epoch ?? 0;
    for (let attempt = 0; ; attempt++) {
      const session = deps.getSession(sessionKey);
      // The goal moved (paused, cleared, replaced, the owner wrote): this continuation is stale.
      if (!sameGoal(session, goalId, epoch)) {
        deps.logger.info('Task goal continuation dropped — the goal changed', { sessionKey });
        return;
      }
      const response = await deps.start({
        sessionKey,
        text: event.text,
        // The goal's owner, as a Slack goal turn runs as the user who set it.
        actorUserId: event.user,
        initiator: 'host',
        goalContinuation: true,
      });
      if (response.status >= 200 && response.status < 300) return;
      // The task runs a turn (the owner wrote meanwhile): never supersede — that turn's end runs the loop.
      if (response.status === 409 && /already running/.test(String(response.body.error ?? ''))) {
        deps.logger.info('Task goal continuation dropped — a turn is running on the task', { sessionKey });
        return;
      }
      if (!isWaitable(response) || attempt >= maxRetries) {
        throw new Error(String(response.body.error ?? `the task could not start (${response.status})`));
      }
      deps.logger.info('Task goal continuation waits — the task cannot start yet', {
        sessionKey,
        attempt: attempt + 1,
        reason: response.body.error,
      });
      await new Promise<void>((resolve) => schedule(resolve, retryDelayMs));
    }
  }

  function onUserInstruction(_sessionKey: string, session: ConversationSession): void {
    if (!session.goal) return;
    resetGoalContinuationOnUserMessage(session);
    deps.saveSessions();
  }

  return { onChainEnd, injectContinuation, onUserInstruction };
}
