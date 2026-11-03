/**
 * #853 — 시작 / 취소 on a Slack session's plan (plan mode on every session).
 *
 *   S1 시작: the gate is saved approved, then the plan goes into the thread as the
 *      decider's next instruction (the normal Slack path: queue, steering, goals).
 *   S2 a plan that could not be sent puts the waiting plan back; 시작 can be pressed again.
 *   S3 취소: saved cancelled, nothing is sent.
 *   S4 refusals change nothing: no plan mode, nobody signed in, someone the owner
 *      has not approved, a closed session, a stale revision.
 *   S5 a turn in flight refuses nothing: the plan is handed over and waits in the queue behind
 *      it as its own turn (review #858 — the busy check was the task path's, which had no queue).
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskPlanGate } from '../task-plan';
import { createSlackPlanDecider } from '../task-plan-decision';

const KEY = 'work:C1:1700000000.000100';
const PLAN = { summary: '결론', intent: '의도', phases: [{ title: '단계', steps: [{ title: '작업' }] }] } as any;
const awaiting = (): TaskPlanGate => ({
  state: 'awaiting',
  revision: 2,
  updatedAt: 1,
  plan: { ...PLAN, revision: 2, submittedAt: 1 },
});

function harness(
  over: Record<string, unknown> = {},
  session: any = { ownerId: 'UOWNER', channelId: 'C1', threadTs: '1700000000.000100', taskPlan: awaiting() },
) {
  const setPlanGate = vi.fn((_k: string, gate: TaskPlanGate) => {
    session.taskPlan = gate;
  });
  const sendPlan = vi.fn(async () => true);
  const decide = createSlackPlanDecider({
    getSession: (k: string) => (k === KEY ? session : undefined),
    setPlanGate,
    sendPlan,
    now: () => 50,
    logger: { info: vi.fn(), warn: vi.fn() },
    ...over,
  } as any);
  return { decide, session, setPlanGate, sendPlan };
}

describe('createSlackPlanDecider (#853)', () => {
  it('S1 — 시작 saves the gate approved, then sends the plan into the thread as the decider', async () => {
    const h = harness();
    const r = await h.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' });
    expect(r).toEqual({ status: 200, body: { ok: true, state: 'approved', revision: 2, started: true } });
    expect(h.session.taskPlan).toMatchObject({ state: 'approved', decidedBy: 'UOWNER' });
    expect(h.sendPlan).toHaveBeenCalledWith(KEY, expect.stringContaining('# 작업 계획 v2'), 'UOWNER');
    // Approved before the instruction is sent: its turn is not a planning turn.
    expect(h.setPlanGate.mock.invocationCallOrder[0]).toBeLessThan(h.sendPlan.mock.invocationCallOrder[0]);
  });

  it('S2 — a plan that could not be sent puts the waiting plan back', async () => {
    const h = harness({ sendPlan: vi.fn(async () => false) });
    const before = h.session.taskPlan;
    const r = await h.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' });
    expect(r.status).toBe(502);
    expect(h.session.taskPlan).toEqual(before);
    const thrown = harness({
      sendPlan: vi.fn(async () => {
        throw new Error('slack down');
      }),
    });
    await expect(
      thrown.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' }),
    ).rejects.toThrow('slack down');
    expect(thrown.session.taskPlan.state).toBe('awaiting');
  });

  it('S3 — 취소 saves it cancelled and sends nothing', async () => {
    const h = harness();
    const r = await h.decide({ sessionKey: KEY, decision: 'cancel', revision: 2, actorUserId: 'UOWNER' });
    expect(r).toEqual({ status: 200, body: { ok: true, state: 'cancelled', revision: 2 } });
    expect(h.session.taskPlan.state).toBe('cancelled');
    expect(h.sendPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['no session', { sessionKey: 'work:C9:9.9' }, {}, undefined, 409],
    ['no plan mode', {}, {}, { ownerId: 'UOWNER', channelId: 'C1', threadTs: '1' }, 409],
    ['nobody signed in', { actorUserId: '' }, {}, undefined, 403],
    ['someone the owner has not approved', { actorUserId: 'UOTHER' }, { mayDecide: () => false }, undefined, 403],
    ['a closed session', {}, {}, { ownerId: 'UOWNER', terminated: true, taskPlan: awaiting() }, 409],
    ['a stale revision', { revision: 1 }, {}, undefined, 409],
  ])('S4 — refuses %s and changes nothing', async (_name, req, over, session, status) => {
    const h = session ? harness(over, session) : harness(over);
    const before = h.session.taskPlan;
    const r = await h.decide({
      sessionKey: KEY,
      decision: 'start',
      revision: 2,
      actorUserId: 'UOWNER',
      ...(req as object),
    });
    expect(r.status).toBe(status);
    expect(h.session.taskPlan).toBe(before);
    expect(h.setPlanGate).not.toHaveBeenCalled();
    expect(h.sendPlan).not.toHaveBeenCalled();
  });

  it('S5 — a turn in flight does not refuse 시작: the plan is handed over (it queues behind it)', async () => {
    const h = harness({ isBusy: () => true });
    const r = await h.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' });
    expect(r).toEqual({ status: 200, body: { ok: true, state: 'approved', revision: 2, started: true } });
    expect(h.sendPlan).toHaveBeenCalledTimes(1);
  });
});

/**
 * 2026-11-03 — 시작 on a Slack session's plan opens the plan's goal too (the user's word: "작업 계획으로
 * 진행될 때 자동으로 goal을 설정"), as a task's does: the thread's own goal loop drives it to the plan's end.
 */
describe('createSlackPlanDecider — 시작 opens the plan’s goal', () => {
  it('S6 — opened before the plan is sent (its turn is the goal’s opening turn), as the user who pressed 시작', async () => {
    const undo = vi.fn();
    const openGoal = vi.fn(() => undo);
    const h = harness({ openGoal });
    const r = await h.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' });
    expect(r.status).toBe(200);
    expect(openGoal).toHaveBeenCalledWith(h.session, expect.objectContaining({ revision: 2 }), 'UOWNER');
    expect(openGoal.mock.invocationCallOrder[0]).toBeLessThan(h.sendPlan.mock.invocationCallOrder[0]);
    expect(undo).not.toHaveBeenCalled();
  });

  it('S7 — a plan that was not taken takes its goal back with it', async () => {
    const undo = vi.fn();
    const h = harness({ openGoal: vi.fn(() => undo), sendPlan: vi.fn(async () => false) });
    expect((await h.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' })).status).toBe(
      502,
    );
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('S8 — 취소 opens none; a goal that cannot open is logged and the plan still starts', async () => {
    const openGoal = vi.fn(() => () => {});
    const h = harness({ openGoal });
    await h.decide({ sessionKey: KEY, decision: 'cancel', revision: 2, actorUserId: 'UOWNER' });
    expect(openGoal).not.toHaveBeenCalled();

    const broken = harness({
      openGoal: vi.fn(() => {
        throw new Error('goal store down');
      }),
    });
    const r = await broken.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' });
    expect(r.status).toBe(200);
    expect(broken.sendPlan).toHaveBeenCalled();
  });
});

describe('createSlackPlanDecider — no goal on a Slack epic (#854 × #840)', () => {
  it('S9 — an epic session’s 시작 starts its plan without a goal: its children’s ends wake it, not the goal loop', async () => {
    const openGoal = vi.fn(() => () => {});
    const h = harness(
      { openGoal },
      {
        ownerId: 'UOWNER',
        channelId: 'C1',
        threadTs: '1700000000.000100',
        kind: 'epic',
        taskId: 'e1',
        taskPlan: awaiting(),
      },
    );
    const r = await h.decide({ sessionKey: KEY, decision: 'start', revision: 2, actorUserId: 'UOWNER' });
    expect(r.status).toBe(200);
    expect(h.sendPlan).toHaveBeenCalled();
    expect(openGoal).not.toHaveBeenCalled();
  });
});
