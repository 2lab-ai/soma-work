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
import type { TaskPlanDoc } from './task-plan';

/** The goal objective's bound — the plan's conclusion and its phase map, not its details. */
export const PLAN_GOAL_OBJECTIVE_MAX = 2400;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The goal a started plan opens: finish the plan — its conclusion, intent and phases, in its own words. */
export function planGoalObjective(plan: TaskPlanDoc): string {
  const phases = plan.phases.map((p, i) => `${i + 1}. ${p.title}`).join('\n');
  return clip(
    [
      `작업 계획 v${plan.revision}을 끝까지 완료한다: ${plan.summary}`,
      `의도: ${clip(plan.intent, 900)}`,
      `단계:\n${phases}`,
      '모든 단계의 산출물이 나오고 검증까지 끝나야 완료다. 계획 밖의 일은 하지 않는다.',
    ].join('\n'),
    PLAN_GOAL_OBJECTIVE_MAX,
  );
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
