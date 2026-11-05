/**
 * The goal completes only when BOTH hold (2026-11-05): the evaluator reports
 * the objective met, AND every task of the work model's latest task list
 * (TodoWrite, the session's task ledger) is completed. A task taken off the
 * list no longer counts — that is how the model drops work that left the goal.
 *
 * Live case: the dashboard read "목표 2/2 · 작업 1/6" — the evaluator closed the
 * goal while five of the model's six tasks were still open.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SyntheticMessageEvent } from '../../cron-scheduler';
import { applyTodoList, type TaskLedger, type TodoInput } from '../../session/task-ledger';
import type { ConversationSession, SessionGoal } from '../../types';
import type { GoalEvalVerdict } from '../goal-completion-evaluator';
import { GoalLoopController, type GoalLoopControllerDeps } from '../goal-loop-controller';
import { gateGoalVerdictOnTasks } from '../goal-task-gate';

const SESSION_KEY = 'C1:T1';

const SIX_TASKS: TodoInput[] = [
  { content: 'v0.29.0 npm 퍼블리시 확인', status: 'completed' },
  { content: 'ui-working 자체 디자인 구현', status: 'in_progress' },
  { content: 'ui-copy-field 자체 디자인 구현', status: 'in_progress' },
  { content: '와이어링 나머지 + 리뷰 + verify', status: 'pending' },
  { content: 'PR → CI → 머지 → 배포 + 실서버 검사', status: 'pending' },
  { content: '최종 보고 + 카드 동기화', status: 'pending' },
];

function ledgerOf(...lists: TodoInput[][]): TaskLedger {
  let ledger: TaskLedger | undefined;
  let now = 1_000;
  for (const list of lists) {
    ledger = applyTodoList(ledger, list, now);
    now += 1_000;
  }
  return ledger as TaskLedger;
}

function makeGoal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    goalId: 'goal-test',
    objective: 'ship the feature',
    status: 'active',
    createdAt: 100,
    updatedAt: 100,
    createdBy: 'U1',
    continuationCount: 0,
    maxContinuations: 10,
    evalAttemptCount: 0,
    epoch: 0,
    ...overrides,
  };
}

function makeHarness(opts: { verdict: GoalEvalVerdict; ledger?: TaskLedger; goal?: Partial<SessionGoal> }) {
  const goal = makeGoal(opts.goal);
  const session = {
    channelId: 'C1',
    threadTs: 'T1',
    model: 'claude-opus-4',
    goal,
    goalLastTurnText: 'did some work',
    taskLedger: opts.ledger,
  } as unknown as ConversationSession;
  const injected: SyntheticMessageEvent[] = [];
  const notices: string[] = [];
  const evalPrompts: string[] = [];
  const dispatcher: GoalLoopControllerDeps['dispatcher'] = async (params) => {
    evalPrompts.push(params.userPrompt);
    return JSON.stringify(opts.verdict);
  };
  const controller = new GoalLoopController({
    registry: {
      getSessionByKey: () => session,
      getActivityStateByKey: () => 'idle',
      saveSessions: () => undefined,
    },
    requestCoordinator: { isRequestActive: () => false },
    dispatcher,
    injectContinuation: async (event) => {
      injected.push(event);
    },
    postNotice: async (_channel, _threadTs, text) => {
      notices.push(text);
      return undefined;
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fallbackModel: 'claude-sonnet-4',
    scheduleEvalRetry: () => undefined,
  });
  return { controller, session, goal, injected, notices, evalPrompts };
}

const DONE: GoalEvalVerdict = { completed: true, reason: 'PR #26 merged and deployed', remaining: [] };

describe('goal completion requires every task of the latest list to be completed', () => {
  it('eval says complete, 1/6 tasks done → the goal stays active and the model is told which tasks are open', async () => {
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(SIX_TASKS) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('active');
    expect(h.goal.completedVia).toBeUndefined();
    expect(h.session.goalHistory ?? []).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('✅ Goal completed'))).toBe(false);

    // The thread hears why: the evaluator said done, but 5 of 6 tasks are open.
    const notice = h.notices.find((n) => n.startsWith('🔄'));
    expect(notice).toBeDefined();
    expect(notice).toContain('5 of 6');
    expect(notice).toContain('ui-working 자체 디자인 구현');

    // The continuation is injected and names the open tasks and both ways out.
    expect(h.goal.continuationCount).toBe(1);
    expect(h.injected).toHaveLength(1);
    const text = h.injected[0].text ?? '';
    expect(text).toContain('[goal-continuation]');
    expect(text).toContain('not complete');
    for (const t of SIX_TASKS.slice(1)) expect(text).toContain(t.content);
    expect(text).not.toContain(SIX_TASKS[0].content);
    expect(text).toContain('TodoWrite');
    expect(text).toMatch(/remove/i);

    // The open tasks are the recorded gap, so a reused verdict still carries them.
    expect(h.goal.lastEvalRemaining).toHaveLength(5);
    expect(h.goal.lastEvalReason).toContain('5 of 6');
  });

  it('eval says complete and every task is completed → the goal completes', async () => {
    const allDone = SIX_TASKS.map((t) => ({ ...t, status: 'completed' as const }));
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(SIX_TASKS, allDone) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('complete');
    expect(h.goal.completedVia).toBe('eval-model');
    expect(h.injected).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('✅ Goal completed'))).toBe(true);
  });

  it('tasks the model removed from the list no longer count → the goal completes', async () => {
    // The model dropped the tasks that left the goal and completed the rest.
    const trimmed: TodoInput[] = [
      { content: SIX_TASKS[0].content, status: 'completed' },
      { content: SIX_TASKS[1].content, status: 'completed' },
    ];
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(SIX_TASKS, trimmed) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('complete');
    expect(h.injected).toHaveLength(0);
  });

  it('no task list at all → the evaluator alone decides, as before', async () => {
    const h = makeHarness({ verdict: DONE });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('complete');
  });

  it('eval says complete with open tasks at the continuation cap → asks to keep going, never completes', async () => {
    const h = makeHarness({
      verdict: DONE,
      ledger: ledgerOf(SIX_TASKS),
      goal: { continuationCount: 10, maxContinuations: 10 },
    });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.goal.status).toBe('active');
    expect(h.injected).toHaveLength(0);
    expect(h.notices.some((n) => n.includes('✅ Goal completed'))).toBe(false);
    expect(h.notices.some((n) => n.includes('⏹️') || n.includes('⏸️'))).toBe(true);
  });

  it('the evaluator sees the task list, captioned as the model’s own claims (not evidence)', async () => {
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(SIX_TASKS) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.evalPrompts).toHaveLength(1);
    expect(h.evalPrompts[0]).toContain('Task list');
    expect(h.evalPrompts[0]).toContain('[in_progress] ui-working 자체 디자인 구현');
    expect(h.evalPrompts[0]).toContain('[completed] v0.29.0 npm 퍼블리시 확인');
    // A [completed] mark is the model's word — it must never read as host evidence (review P1).
    expect(h.evalPrompts[0]).toContain('claims, not evidence');
    expect(h.evalPrompts[0]).not.toContain('host-tracked');
  });

  it('the next evaluation gets the previous acceptance with the task gap (review P2)', async () => {
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(SIX_TASKS) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    // Second turn: the evaluator's <previous-evaluation> is the recorded gap.
    h.session.goalLastTurnText = 'marked the tasks done';
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.evalPrompts).toHaveLength(2);
    expect(h.evalPrompts[1]).toContain('<previous-evaluation>');
    expect(h.evalPrompts[1]).toContain(DONE.reason);
  });
});

describe('a task-gate gap is judged again once its open tasks change (review P2)', () => {
  it('continuation 10/10 completes the last task but leaves no text → re-judged and completed, no cap question', async () => {
    const oneLeft: TodoInput[] = [
      { content: SIX_TASKS[0].content, status: 'completed' },
      { content: SIX_TASKS[1].content, status: 'in_progress' },
    ];
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(oneLeft), goal: { continuationCount: 9 } });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.goal.status).toBe('active');
    expect(h.goal.continuationCount).toBe(10);

    // The continuation turn marks the task done, then is cut short (no text).
    h.session.taskLedger = applyTodoList(
      h.session.taskLedger,
      oneLeft.map((t) => ({ ...t, status: 'completed' as const })),
      9_000,
    );
    h.session.goalLastTurnText = '';
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.evalPrompts).toHaveLength(2);
    expect(h.goal.status).toBe('complete');
    expect(h.goal.capDecisionId).toBeUndefined();
  });

  it('a status flip or one task of several closed keeps the reuse — no evaluation over a silent turn (review r2 P2)', async () => {
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(SIX_TASKS) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    // T4 pending → in_progress, T2 completed; T3..T6 still open. The turn left no text.
    const partial = SIX_TASKS.map((t, i) =>
      i === 1 ? { ...t, status: 'completed' as const } : i === 3 ? { ...t, status: 'in_progress' as const } : t,
    );
    h.session.taskLedger = applyTodoList(h.session.taskLedger, partial, 9_000);
    h.session.goalLastTurnText = '';
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.evalPrompts).toHaveLength(1);
    expect(h.goal.status).toBe('active');
    expect(h.goal.continuationCount).toBe(2);
  });

  it('over 30 open tasks: closing every listed one but not the tail keeps the reuse (review r2 P2)', async () => {
    const many: TodoInput[] = Array.from({ length: 31 }, (_, i) => ({
      content: `step ${i + 1} of the plan`,
      status: 'pending',
    }));
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(many) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    expect(h.goal.lastEvalRemaining).toHaveLength(31); // 30 lines + "… and 1 more"

    const tailOpen = many.map((t, i) => (i < 30 ? { ...t, status: 'completed' as const } : t));
    h.session.taskLedger = applyTodoList(h.session.taskLedger, tailOpen, 9_000);
    h.session.goalLastTurnText = '';
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.evalPrompts).toHaveLength(1);
    expect(h.goal.status).toBe('active');
  });

  it('a turn cut short with the same open tasks still reuses the gap (no extra evaluation)', async () => {
    const h = makeHarness({ verdict: DONE, ledger: ledgerOf(SIX_TASKS) });
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);
    h.session.goalLastTurnText = '';
    h.controller.onTurnSettled(SESSION_KEY);
    await h.controller.settled(SESSION_KEY);

    expect(h.evalPrompts).toHaveLength(1);
    expect(h.goal.continuationCount).toBe(2);
  });
});

describe('gateGoalVerdictOnTasks', () => {
  it('passes a not-complete verdict through untouched', () => {
    const v: GoalEvalVerdict = { completed: false, reason: 'tests missing', remaining: ['add tests'] };
    expect(gateGoalVerdictOnTasks(v, ledgerOf(SIX_TASKS))).toEqual({ verdict: v });
  });

  it('passes a complete verdict when the latest list has no open task', () => {
    const allDone = SIX_TASKS.map((t) => ({ ...t, status: 'completed' as const }));
    expect(gateGoalVerdictOnTasks(DONE, ledgerOf(allDone))).toEqual({ verdict: DONE });
    expect(gateGoalVerdictOnTasks(DONE, undefined)).toEqual({ verdict: DONE });
  });

  it('turns a complete verdict with open tasks into a gap naming them', () => {
    const out = gateGoalVerdictOnTasks(DONE, ledgerOf(SIX_TASKS));
    expect(out.verdict.completed).toBe(false);
    expect(out.verdict.sameAsPrevious).toBeUndefined();
    expect(out.verdict.remaining).toHaveLength(5);
    expect(out.verdict.remaining[0]).toMatch(/^T2 \[in_progress\] ui-working/);
    expect(out.tasks).toEqual({ open: 5, total: 6, evalReason: DONE.reason });
    expect(out.verdict.reason).toContain(`Evaluator's reason for calling the objective met: ${DONE.reason}`);
  });

  it('cuts a long task text by code point, never through an emoji', () => {
    const long = `${'가'.repeat(198)}🚀🚀🚀`;
    const out = gateGoalVerdictOnTasks(DONE, ledgerOf([{ content: long, status: 'pending' }]));
    const line = out.verdict.remaining[0];
    expect(line).toBe(`T1 [pending] ${'가'.repeat(198)}🚀…`);
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
