/**
 * A dashboard task's goal (2026-11-03): plan mode drives its work to the end.
 *
 * A plan-mode task runs one turn on 시작 and stops when that turn ends — a long
 * plan (an epic's worth of work) needed someone to say "continue" each time, and
 * a restart left it stopped. Now 시작 opens a goal for the plan, and the goal loop
 * (`GoalLoopController`, the Slack sessions' "ralph" loop) judges each ended turn
 * against it and continues the task until the plan is done.
 *
 * What a task needs beside a Slack session's goal (the loop itself is shared):
 *   - the objective, from the approved plan (`planGoalObjective`);
 *   - the trigger: a task's chain ending is its turn settling (`settleTaskGoal`,
 *     the task twin of `SlackHandler.handleAssistantTurnCompleteForGoal`);
 *   - the continuation as the task's next turn (the host's task injector, `index.ts`).
 */
import type { ConversationSession } from '../types';
import { isPlanPending, type TaskPlanDoc } from './task-plan';
import type { TaskCommandResponse, TaskTurnController } from './task-turn-controller';

/** The goal objective's bound — the plan's conclusion and its phase map, not its details. */
export const PLAN_GOAL_OBJECTIVE_MAX = 2400;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The goal a started plan opens: finish the plan — its conclusion, the completion rule, the
 * phase count and each phase's title, then the intent. The rule and the count come first, so
 * a bound that cuts a long plan cuts the intent's tail, never "every phase" (trinity R1, grok P3).
 */
export function planGoalObjective(plan: TaskPlanDoc): string {
  const n = plan.phases.length;
  const head = [
    `작업 계획 v${plan.revision}을 끝까지 완료한다: ${clip(plan.summary, 600)}`,
    `완료 조건: 아래 ${n}개 단계 전부의 산출물이 나오고 검증까지 끝나야 한다. 한 단계라도 남으면 완료가 아니다. 계획 밖의 일은 하지 않는다.`,
  ].join('\n');
  const titleBudget = Math.max(40, Math.floor((PLAN_GOAL_OBJECTIVE_MAX - head.length - 200) / Math.max(n, 1)) - 6);
  const phases = plan.phases.map((p, i) => `${i + 1}. ${clip(p.title, titleBudget)}`).join('\n');
  const body = `${head}\n단계(${n}):\n${phases}`;
  return clip(`${body}\n의도: ${plan.intent}`, PLAN_GOAL_OBJECTIVE_MAX);
}

export interface SettleTaskGoalInput {
  session: ConversationSession;
  sessionKey: string;
  /** The chain's last turn's final text ('' when none). */
  turnText: string;
  /** The host is stopping: evidence is kept, the loop is not run (the restart resumes the goal, #788). */
  shuttingDown: boolean;
  /** Bounded mirror length for the persisted summary (`GOAL_SUMMARY_PERSIST_MAX`). */
  summaryMax: number;
  /** Wake the goal loop (`GoalLoopController.onTurnSettled(key, { cause: 'turn' })`). */
  settle: (sessionKey: string) => void;
  save: () => void;
}

export type SettleTaskGoalResult = 'no-goal' | 'held' | 'settled';

/**
 * A task chain ended: stash its last turn's text as the goal's evidence and wake the
 * loop. The evidence is credited only when the live goal is the one that owned the
 * turn (`activeLegGoalId` / `activeLegGoalEpoch`, captured by `beginTurn` on task
 * turns too) — a goal changed mid-turn gets a fresh judgement from the loop's own
 * epoch guard instead. Slack's follow-up-queue deferral has no task counterpart.
 */
export function settleTaskGoal(input: SettleTaskGoalInput): SettleTaskGoalResult {
  const { session, sessionKey } = input;
  const goal = session.goal;
  if (!goal || goal.status !== 'active') return 'no-goal';
  const legGoalId = session.activeLegGoalId;
  const goalChanged =
    legGoalId !== undefined && (legGoalId !== goal.goalId || (session.activeLegGoalEpoch ?? 0) !== (goal.epoch ?? 0));
  if (!goalChanged && input.turnText.trim()) {
    session.goalLastTurnText = input.turnText;
    goal.lastAssistantTurnSummary = input.turnText.slice(0, input.summaryMax);
    input.save();
  }
  if (input.shuttingDown) return 'held';
  input.settle(sessionKey);
  return 'settled';
}

export interface TaskGoalInjectorDeps {
  controller: Pick<TaskTurnController, 'start'>;
  getSession(sessionKey: string): ConversationSession | undefined;
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
  /** Schedules a retry (production: an unref'd setTimeout). */
  schedule?: (fn: () => void, delayMs: number) => void;
  /** Between tries while the owner's slot is busy. Default 30 s. */
  retryMs?: number;
  /** Tries before giving up. Default 240 (two hours at the default pace). */
  maxAttempts?: number;
  /**
   * The restart guidance for the first continuation of a task the restart cut (D10 on the goal
   * path — trinity R1, fable P2): the host hands it out once per cut task. Unset: none.
   */
  restartNotice?: (sessionKey: string) => string | undefined;
}

/**
 * The goal loop's continuation for a dashboard task: the task's next turn, through the task
 * controller (a host start as the goal's owner). A Slack thread's continuation always finds the
 * thread; a task's start can find the owner's one dashboard task (or the start window) taken —
 * 429 — and a refused injection ends the loop with no turn to settle it again (trinity R1, grok
 * P2). So a 429 waits and tries again while the same goal still wants it: the goal and its epoch
 * unchanged (no owner word since), no turn ran since, the task idle. Anything else is refused.
 */
export function createTaskGoalInjector(
  deps: TaskGoalInjectorDeps,
): (event: { text?: string; user: string }, sessionKey: string) => Promise<void> {
  const retryMs = deps.retryMs ?? 30_000;
  const maxAttempts = deps.maxAttempts ?? 240;
  const schedule =
    deps.schedule ??
    ((fn: () => void, delayMs: number) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
    });

  const refusal = (res: TaskCommandResponse) =>
    String((res.body as { error?: unknown } | undefined)?.error ?? `HTTP ${res.status}`);

  return async (event, sessionKey) => {
    const at = deps.getSession(sessionKey);
    const want = {
      goalId: at?.goal?.goalId,
      epoch: at?.goal?.epoch ?? 0,
      turnId: at?.lastTurnOutcome?.turnId,
    };
    const stillWanted = (): string | null => {
      const s = deps.getSession(sessionKey);
      if (!s || s.terminated || s.closing) return 'closed';
      if (s.goal?.status !== 'active' || s.goal.goalId !== want.goalId || (s.goal.epoch ?? 0) !== want.epoch) {
        return 'the goal changed';
      }
      if (s.lastTurnOutcome?.turnId !== want.turnId) return 'a turn ran since';
      if (s.activityState && s.activityState !== 'idle') return `not idle (${s.activityState})`;
      return null;
    };
    // Not while the plan waits for its owner (a continuation there would be direct input), not an epic.
    if (at?.kind === 'epic') throw new Error('an epic is driven by its children’s events, not a goal');
    if (isPlanPending(at?.taskPlan)) throw new Error('the plan waits for its owner');
    const promptNotice = deps.restartNotice?.(sessionKey);
    const start = () =>
      deps.controller.start({
        sessionKey,
        text: event.text ?? '',
        actorUserId: event.user,
        initiator: 'host',
        ...(promptNotice ? { promptNotice } : {}),
      });

    const first = await start();
    if (first.status === 202) return;
    if (first.status !== 429) throw new Error(refusal(first));
    deps.logger.info('Goal continuation waits for the owner’s dashboard slot', { sessionKey, error: refusal(first) });
    const retry = (tries: number) => {
      schedule(() => {
        const gone = stillWanted();
        if (gone) {
          deps.logger.info('Goal continuation retry dropped', { sessionKey, reason: gone });
          return;
        }
        void start()
          .then((res) => {
            if (res.status === 202) {
              deps.logger.info('Goal continuation started after waiting', { sessionKey, tries });
            } else if (res.status === 429 && tries < maxAttempts) {
              retry(tries + 1);
            } else {
              deps.logger.warn('Goal continuation gave up', { sessionKey, status: res.status, error: refusal(res) });
            }
          })
          .catch((error) =>
            deps.logger.warn('Goal continuation retry failed', { sessionKey, error: (error as Error)?.message }),
          );
      }, retryMs);
    };
    retry(2);
  };
}
