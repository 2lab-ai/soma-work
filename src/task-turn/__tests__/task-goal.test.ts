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
import {
  createTaskGoalInjector,
  PLAN_GOAL_OBJECTIVE_MAX,
  planGoalObjective,
  resetGoalForUserTurn,
  settleTaskGoal,
} from '../task-goal';
import type { TaskPlanDoc } from '../task-plan';
import type { TaskCommandRequest } from '../task-turn-controller';

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

describe('G6 — the goal continuation for a task (createTaskGoalInjector)', () => {
  const idleTask = (over: Record<string, unknown> = {}) =>
    ({
      slackless: true,
      activityState: 'idle',
      goal: { goalId: 'g1', status: 'active', epoch: 1 },
      lastTurnOutcome: { turnId: 't1', outcome: 'completed' },
      taskPlan: { state: 'approved', revision: 1 },
      ...over,
    }) as unknown as ConversationSession;
  const event = { text: '[goal-continuation] keep going', user: 'U1' };

  it('starts the task’s next turn as the goal’s owner (a host start)', async () => {
    const start = vi.fn(async () => ({ status: 202, body: {} }));
    const inject = createTaskGoalInjector({
      controller: { start },
      getSession: () => idleTask(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await inject(event, 'task:a');
    expect(start).toHaveBeenCalledWith({
      sessionKey: 'task:a',
      text: event.text,
      actorUserId: 'U1',
      initiator: 'host',
    });
  });

  it('the owner’s slot busy (429): it waits and starts once the slot frees — not a stalled loop (grok P2 / fable P1-1)', async () => {
    const replies = [
      { status: 429, body: { error: 'one dashboard task runs at a time' } },
      { status: 202, body: {} },
    ];
    const start = vi.fn(async () => replies.shift()!);
    const scheduled: Array<() => void> = [];
    const inject = createTaskGoalInjector({
      controller: { start },
      getSession: () => idleTask(),
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: (fn) => scheduled.push(fn),
    });
    await expect(inject(event, 'task:a')).resolves.toBeUndefined();
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the owner wrote since (epoch moved)', { goal: { goalId: 'g1', status: 'active', epoch: 2 } }],
    ['another goal', { goal: { goalId: 'g2', status: 'active', epoch: 1 } }],
    ['a turn ran since', { lastTurnOutcome: { turnId: 't2', outcome: 'completed' } }],
    ['not idle', { activityState: 'working' }],
  ])('a waiting retry is dropped when %s', async (_name, later) => {
    let live = idleTask();
    const start = vi.fn(async () => ({ status: 429, body: { error: 'busy' } }));
    const scheduled: Array<() => void> = [];
    const inject = createTaskGoalInjector({
      controller: { start },
      getSession: () => live,
      logger: { info: vi.fn(), warn: vi.fn() },
      schedule: (fn) => scheduled.push(fn),
    });
    await inject(event, 'task:a');
    live = idleTask(later);
    scheduled[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('another refusal is the loop’s injection failure (it throws)', async () => {
    const inject = createTaskGoalInjector({
      controller: { start: vi.fn(async () => ({ status: 409, body: { error: 'the task is being closed' } })) },
      getSession: () => idleTask(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await expect(inject(event, 'task:a')).rejects.toThrow('the task is being closed');
  });

  it('never while the plan waits for its owner, never on an epic', async () => {
    const start = vi.fn(async () => ({ status: 202, body: {} }));
    for (const over of [{ taskPlan: { state: 'awaiting', revision: 2 } }, { kind: 'epic' }]) {
      const inject = createTaskGoalInjector({
        controller: { start },
        getSession: () => idleTask(over),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await expect(inject(event, 'task:a')).rejects.toThrow();
    }
    expect(start).not.toHaveBeenCalled();
  });

  it('the first continuation of a task the restart cut carries the restart guidance, once (D10 — fable P2)', async () => {
    const start = vi.fn(async (_request: TaskCommandRequest) => ({ status: 202, body: {} }));
    const cut = new Set(['task:a']);
    const inject = createTaskGoalInjector({
      controller: { start },
      getSession: () => idleTask(),
      logger: { info: vi.fn(), warn: vi.fn() },
      restartNotice: (k) => (cut.delete(k) ? '<task-restart-resume>…' : undefined),
    });
    await inject(event, 'task:a');
    await inject(event, 'task:a');
    expect(start.mock.calls[0][0]).toMatchObject({ promptNotice: '<task-restart-resume>…' });
    expect(start.mock.calls[1][0]).not.toHaveProperty('promptNotice');
  });
});

describe('G7 — a dashboard word resets the goal; a refused start gives back only that (trinity R2, fable P2)', () => {
  const reset = (s: ConversationSession) => {
    s.goal!.continuationCount = 0;
    s.goal!.epoch = (s.goal!.epoch ?? 0) + 1;
  };
  it('the give-back restores the epoch and the budget, and nothing the loop changed meanwhile', () => {
    const session = taskWithGoal();
    Object.assign(session.goal!, { continuationCount: 4, pendingEval: { startedAt: 1 } });
    const giveBack = resetGoalForUserTurn(session, reset);
    expect(session.goal).toMatchObject({ continuationCount: 0, epoch: 4 });
    // The loop drops the verdict of the eval the epoch bump outdated and clears its lease meanwhile.
    (session.goal as { pendingEval?: unknown }).pendingEval = undefined;
    giveBack();
    expect(session.goal).toMatchObject({ continuationCount: 4, epoch: 3 });
    expect((session.goal as { pendingEval?: unknown }).pendingEval).toBeUndefined();
  });
  it('a goal replaced meanwhile is left alone; no goal is a no-op', () => {
    const session = taskWithGoal();
    const giveBack = resetGoalForUserTurn(session, reset);
    const next = { goalId: 'g2', status: 'active', epoch: 9, continuationCount: 1 };
    (session as { goal?: unknown }).goal = next;
    giveBack();
    expect(session.goal).toBe(next);
    expect(session.goal).toMatchObject({ epoch: 9, continuationCount: 1 });
    expect(() => resetGoalForUserTurn(taskWithGoal({ goal: undefined }), reset)()).not.toThrow();
  });
});
