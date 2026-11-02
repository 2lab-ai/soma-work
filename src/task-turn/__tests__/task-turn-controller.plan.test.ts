/**
 * Plan mode (SSOT 2026-11-02) — the controller and a task whose plan is not started (T2 · T4).
 *
 *   C1 every hop of such a task carries the plan-mode notice (`promptNotice`); the
 *      instruction itself stays the user's words. A started plan, or no plan mode: none.
 *   C2 direct input on a waiting plan (any instruction) takes it back to drafting, in
 *      the turn's saved start; a start that does not happen puts the waiting plan back.
 *   C3 an answer to a question asked while planning rides the same notice.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyPlanSubmission, checkPlanSubmission, newPlanGate } from '../task-plan';
import { createTaskTurnController, type TaskTurnControllerDeps } from '../task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn-runner';

const KEY = 'task:11111111-2222-4333-8444-555555555555';
const CTX = { origin: 'task', userId: 'UOWNER', workingDirectory: '/work/UOWNER/t' } as any;
const completed = (turnId = 't'): RunTaskTurnResult => ({
  turnId,
  outcome: { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 1 },
});

function harness(session: Record<string, unknown>, over: Partial<TaskTurnControllerDeps> = {}) {
  const live: any = { slackless: true, ownerId: 'UOWNER', ownerName: 'Owner', taskId: 'a', ...session };
  const inputs: RunTaskTurnInput[] = [];
  const seenAtStart: unknown[] = [];
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput) => {
    inputs.push(input);
    seenAtStart.push(live.taskPlan ? { ...live.taskPlan } : undefined);
    input.onStarted?.();
    return completed();
  });
  const deps: TaskTurnControllerDeps = {
    runner: { runTaskTurn, abandonTurn: vi.fn() as any },
    getSession: (k) => (k === KEY ? live : undefined),
    coordinator: { setController: vi.fn(), removeController: vi.fn() },
    buildExecutionContext: vi.fn(() => CTX),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => 5_000,
    ...over,
  };
  return { controller: createTaskTurnController(deps), live, inputs, seenAtStart, runTaskTurn };
}

const PLAN = checkPlanSubmission({ summary: 's', intent: 'i', phases: [{ title: 'p', steps: [{ title: 'x' }] }] });

describe('TaskTurnController — plan mode', () => {
  it('C1 — a pending plan’s turn carries the notice; the instruction is the user’s own words', async () => {
    const h = harness({ taskPlan: newPlanGate(1) });
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: '  대시보드 개선해줘  ' });
    expect(r.status).toBe(202);
    await r.done;
    expect(h.inputs[0].text).toBe('대시보드 개선해줘');
    const notice = String((h.inputs[0].params as any).promptNotice);
    expect(notice).toContain('<task-plan-mode state="drafting" revision="0">');
    expect(notice).toContain('mcp__plan__plan_submit');
  });

  it('C1 — a started plan, or a task without plan mode, carries no notice', async () => {
    const started = harness({ taskPlan: { ...newPlanGate(1), state: 'approved', revision: 1 } });
    await (await started.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' })).done;
    expect((started.inputs[0].params as any).promptNotice).toBeUndefined();
    const plain = harness({});
    await (await plain.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: 'go' })).done;
    expect((plain.inputs[0].params as any).promptNotice).toBeUndefined();
  });

  it('C2 — direct input on a waiting plan: drafting again from the turn’s start, the notice names the revision', async () => {
    const awaiting = applyPlanSubmission(newPlanGate(1), PLAN, 2);
    const h = harness({ taskPlan: awaiting });
    await (await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: '2단계는 빼줘' })).done;
    expect(h.seenAtStart[0]).toMatchObject({ state: 'drafting', revision: 1, updatedAt: 5_000 });
    expect(h.live.taskPlan.plan).toEqual(awaiting.plan);
    expect(String((h.inputs[0].params as any).promptNotice)).toMatch(/v1에 대해 직접 입력/);
  });

  it('C2 — a start that does not happen puts the waiting plan back', async () => {
    const awaiting = applyPlanSubmission(newPlanGate(1), PLAN, 2);
    const h = harness(
      { taskPlan: awaiting },
      {
        runner: {
          // The turn's start is never saved: the chain ends before it starts.
          runTaskTurn: vi.fn(async () => {
            throw new Error('start not saved');
          }),
          abandonTurn: vi.fn() as any,
        },
      },
    );
    const r = await h.controller.start({ actorUserId: 'UOWNER', sessionKey: KEY, text: '2단계는 빼줘' });
    expect(r.status).toBe(500);
    expect(h.live.taskPlan).toBe(awaiting);
  });

  it('C3 — an answer to a question asked while planning carries the notice', async () => {
    const h = harness({
      taskPlan: newPlanGate(1),
      activityState: 'waiting',
      actionPanel: {
        pendingQuestion: { type: 'user_choice', question: '범위?', askId: 'ask-1', choices: [{ id: '1', label: 'A' }] },
      },
    });
    const r = await h.controller.answer({
      sessionKey: KEY,
      askId: 'ask-1',
      answer: { kind: 'single', choiceId: '1' },
      actorUserId: 'UOWNER',
    });
    expect(r.status).toBe(202);
    await r.done;
    expect(String((h.inputs[0].params as any).promptNotice)).toContain('<task-plan-mode');
  });
});
