/**
 * A plan-mode task's goal (2026-11-03) — 시작 on a plan opens a goal whose objective is the plan.
 *
 *   G1 the objective: the plan's revision, conclusion, intent and phase map, bounded
 *   G1b the completion rule and the phase count survive the bound (trinity R1, grok P3)
 *
 * The loop that drives a task's goal is `task-goal-loop.ts` (#861), tested there.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_GOAL_OBJECTIVE_MAX, planGoalObjective } from '../task-goal';
import type { TaskPlanDoc } from '../task-plan';

const plan = (over: Partial<TaskPlanDoc> = {}): TaskPlanDoc =>
  ({
    revision: 2,
    summary: '대시보드에 모노 테마 두 개를 더한다',
    intent: '색은 상태만 말한다',
    phases: [
      { title: '색 목록', steps: [{ title: 'grep' }] },
      { title: '라이브러리 팔레트', steps: [{ title: 'tokens' }] },
    ],
    submittedAt: 1,
    ...over,
  }) as TaskPlanDoc;

describe('G1 — the goal a started plan opens', () => {
  it('names the revision, the conclusion, the intent and every phase in order', () => {
    const objective = planGoalObjective(plan());
    expect(objective).toContain('작업 계획 v2');
    expect(objective).toContain('대시보드에 모노 테마 두 개를 더한다');
    expect(objective).toContain('색은 상태만 말한다');
    expect(objective.indexOf('1. 색 목록')).toBeLessThan(objective.indexOf('2. 라이브러리 팔레트'));
  });

  it('stays within its bound however long the plan is', () => {
    const long = plan({
      intent: '의'.repeat(5000),
      phases: Array.from({ length: 10 }, (_, i) => ({ title: `단계 ${i} ${'x'.repeat(400)}`, steps: [] })),
    } as Partial<TaskPlanDoc>);
    expect(planGoalObjective(long).length).toBeLessThanOrEqual(PLAN_GOAL_OBJECTIVE_MAX);
  });
});

describe('G1b — the completion rule survives the bound (trinity R1, grok P3)', () => {
  it('a plan far over the bound still says how many phases and that every one must be done', () => {
    const huge = plan({
      summary: '요'.repeat(3000),
      intent: '의'.repeat(5000),
      phases: Array.from({ length: 10 }, (_, i) => ({ title: `단계 ${i} ${'x'.repeat(900)}`, steps: [] })),
    } as Partial<TaskPlanDoc>);
    const objective = planGoalObjective(huge);
    expect(objective.length).toBeLessThanOrEqual(PLAN_GOAL_OBJECTIVE_MAX);
    expect(objective).toContain('완료 조건: 아래 10개 단계 전부');
    expect(objective).toContain('10. 단계 9');
  });
});
