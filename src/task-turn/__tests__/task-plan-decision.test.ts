/**
 * Plan mode (SSOT 2026-11-02) — the decider behind the dashboard's 시작 / 취소.
 * A start that does not happen — refused, or thrown — puts the waiting plan back,
 * so 시작 can be pressed again (review R1, fable P3).
 *
 * ssot-task map: T4 (start / cancel).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../types';
import { applyPlanSubmission, checkPlanSubmission, newPlanGate, type TaskPlanGate } from '../task-plan';
import { createTaskPlanDecider } from '../task-plan-decision';

const NOW = 1_800_000_000_000;
const KEY = 'task:t-1';

function awaitingTask(): ConversationSession {
  const plan = checkPlanSubmission({
    summary: '계획 모드',
    intent: '실행 전 확인',
    ssot: ['plan 토글 on/off'],
    intents: [{ id: 'I1', text: '실행 전 확인', source: 'SSOT_1' }],
    phases: [{ title: '서버', steps: [{ title: '게이트' }] }],
  });
  return {
    slackless: true,
    taskId: 't-1',
    ownerId: 'U1',
    taskPlan: applyPlanSubmission(newPlanGate(NOW), plan, NOW),
  } as unknown as ConversationSession;
}

function harness(start: () => Promise<{ status: number; body: unknown }>) {
  const task = awaitingTask();
  const setTaskPlanGate = vi.fn((_id: string, gate: TaskPlanGate) => {
    task.taskPlan = gate;
  });
  const decide = createTaskPlanDecider({
    getSession: (k) => (k === KEY ? task : undefined),
    setTaskPlanGate,
    controller: { canStart: () => null, isRunning: () => false, start: vi.fn(start) as never },
    now: () => NOW + 1,
    logger: { info: () => {}, warn: () => {} },
  });
  return { task, decide, setTaskPlanGate };
}

describe('createTaskPlanDecider — a start that does not happen puts the plan back', () => {
  it('a refused start (non-202): the plan waits again at the same revision', async () => {
    const { task, decide } = harness(async () => ({ status: 409, body: { error: 'busy' } }));
    const res = await decide({ sessionKey: KEY, decision: 'start', revision: 1, actorUserId: 'U1' });
    expect(res.status).toBe(409);
    expect(task.taskPlan?.state).toBe('awaiting');
    expect(task.taskPlan?.revision).toBe(1);
  });

  it('a start that throws: the plan waits again, and the error still surfaces', async () => {
    const { task, decide, setTaskPlanGate } = harness(async () => {
      throw new Error('boom');
    });
    await expect(decide({ sessionKey: KEY, decision: 'start', revision: 1, actorUserId: 'U1' })).rejects.toThrow(
      'boom',
    );
    expect(task.taskPlan?.state).toBe('awaiting');
    expect(setTaskPlanGate).toHaveBeenCalledTimes(2); // approved, then put back
  });

  it('a start that happens: approved, and the start carried the plan', async () => {
    const { task, decide } = harness(async () => ({ status: 202, body: { ok: true } }));
    const res = await decide({ sessionKey: KEY, decision: 'start', revision: 1, actorUserId: 'U1' });
    expect(res.status).toBe(200);
    expect(task.taskPlan?.state).toBe('approved');
    expect(task.taskPlan?.decidedBy).toBe('U1');
  });
});
