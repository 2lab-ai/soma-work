/**
 * A plan-mode task's goal (2026-11-03): 시작 on a plan opens a goal for it.
 *
 * A plan-mode task ran one turn on 시작 and stopped when that turn ended — a long
 * plan needed someone to say "continue" each time, and a restart left it stopped.
 * Now 시작 opens a goal whose objective is the approved plan (`planGoalObjective`,
 * opened by `task-plan-decision.ts`), and the dashboard task's goal loop
 * (`task-goal-loop.ts`, #861) drives the task until the plan is done.
 */
import type { TaskPlanDoc } from './task-plan';

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
