/**
 * A dashboard task's goal (2026-11-03) — 시작 on a plan opens a goal, and the goal loop drives the
 * task until the plan is done.
 *
 *   G1 the objective: the plan's revision, conclusion, intent and phase map, bounded
 *   G2 a chain that ended: its last turn is the goal's evidence, then the loop wakes
 *   G3 evidence from a turn another goal owned is not credited (the loop's epoch guard re-judges)
 *   G4 the host is stopping: evidence kept, the loop not run (the restart resumes the goal)
 *   G5 no active goal: nothing
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../types';
import { PLAN_GOAL_OBJECTIVE_MAX, planGoalObjective, settleTaskGoal } from '../task-goal';
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

function taskWithGoal(over: Record<string, unknown> = {}): ConversationSession {
  return {
    slackless: true,
    goal: { goalId: 'g1', status: 'active', epoch: 3, objective: 'finish the plan' },
    activeLegGoalId: 'g1',
    activeLegGoalEpoch: 3,
    ...over,
  } as unknown as ConversationSession;
}

describe('G2–G5 — a task chain that ended settles its goal', () => {
  it('G2: the last turn is the evidence (runtime and the bounded persisted mirror), then the loop wakes', () => {
    const session = taskWithGoal();
    const settle = vi.fn();
    const save = vi.fn();
    const out = settleTaskGoal({
      session,
      sessionKey: 'task:a',
      turnText: 'phase 1 done: inventory written',
      shuttingDown: false,
      summaryMax: 10,
      settle,
      save,
    });
    expect(out).toBe('settled');
    expect(session.goalLastTurnText).toBe('phase 1 done: inventory written');
    expect(session.goal?.lastAssistantTurnSummary).toBe('phase 1 do');
    expect(save).toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith('task:a');
  });

  it('G3: a turn another goal (or an older epoch) owned is not credited — the loop still wakes', () => {
    const session = taskWithGoal({ activeLegGoalEpoch: 2 });
    const settle = vi.fn();
    settleTaskGoal({
      session,
      sessionKey: 'task:a',
      turnText: 'old work',
      shuttingDown: false,
      summaryMax: 99,
      settle,
      save: vi.fn(),
    });
    expect(session.goalLastTurnText).toBeUndefined();
    expect(settle).toHaveBeenCalledWith('task:a');
  });

  it('G4: while the host stops, the evidence is kept and the loop is not run', () => {
    const session = taskWithGoal();
    const settle = vi.fn();
    const out = settleTaskGoal({
      session,
      sessionKey: 'task:a',
      turnText: 'cut',
      shuttingDown: true,
      summaryMax: 99,
      settle,
      save: vi.fn(),
    });
    expect(out).toBe('held');
    expect(session.goalLastTurnText).toBe('cut');
    expect(settle).not.toHaveBeenCalled();
  });

  it('G5: no active goal (none, paused, complete) — nothing happens', () => {
    for (const goal of [undefined, { goalId: 'g1', status: 'paused' }, { goalId: 'g1', status: 'complete' }]) {
      const session = taskWithGoal({ goal });
      const settle = vi.fn();
      expect(
        settleTaskGoal({
          session,
          sessionKey: 'task:a',
          turnText: 'x',
          shuttingDown: false,
          summaryMax: 9,
          settle,
          save: vi.fn(),
        }),
      ).toBe('no-goal');
      expect(settle).not.toHaveBeenCalled();
    }
  });
});
