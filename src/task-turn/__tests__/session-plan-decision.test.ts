/**
 * #853 — 시작 / 취소 on a Slack session's plan (plan mode on every session).
 *
 *   S1 시작: the gate is saved approved, then the plan goes into the thread as the
 *      decider's next instruction (the normal Slack path: queue, steering, goals).
 *   S2 a plan that could not be sent puts the waiting plan back; 시작 can be pressed again.
 *   S3 취소: saved cancelled, nothing is sent.
 *   S4 refusals change nothing: no plan mode, nobody signed in, someone the owner
 *      has not approved, a closed session, a turn still writing the plan, a stale revision.
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
    isBusy: () => false,
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
    ['a turn still writing the plan', {}, { isBusy: () => true }, undefined, 409],
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
});
