/**
 * Plan mode and the owner's one-task slot (D9, .prd/17) — 2026-11-03 incident:
 * the owner's task "de-aislop" was drafting its plan; direct input on another
 * task's waiting plan (riftbound, v1) was refused 429 "one dashboard task runs
 * at a time". A plan turn only researches (step 6c, `plan-pending-guard.ts`), so
 * it neither waits for the owner's slot nor holds it. The work still does.
 *
 *   S1 direct input on a waiting plan starts while another task drafts its plan (the incident).
 *   S2 direct input on a waiting plan starts while another task works.
 *   S3 a running plan turn holds no slot: a task's work starts beside it.
 *   S4 the work slot is unchanged: work beside work is 429; 시작 (an approved plan) is work;
 *      a plan turn ending does not free the slot a working task holds.
 *   S5 the epic tree slot likewise: a plan turn of an epic runs beside another tree, and holds none.
 *   S6 a plan turn still meets the per-task 409 and the start window.
 *   S7 canStart takes `planning`: the dry run of a plan-mode start skips the slot, not the window.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyPlanSubmission, checkPlanSubmission, newPlanGate } from '../task-plan';
import { createTaskTurnController, type TaskTurnControllerDeps } from '../task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn-runner';

const OWNER = 'UOWNER';
const DRAFTING = 'task:de-aislop';
const WAITING = 'task:riftbound';
const WORK = 'task:work';
const WORK2 = 'task:work2';
const EPIC = 'task:e1';
const EPIC_PLAN = 'task:e2';

const PLAN = checkPlanSubmission({ summary: 's', intent: 'i', phases: [{ title: 'p', steps: [{ title: 'x' }] }] });
const awaiting = () => applyPlanSubmission(newPlanGate(1), PLAN, 2);

const completed = (turnId = 't'): RunTaskTurnResult => ({
  turnId,
  outcome: { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 1 },
});

function harness(over: Partial<TaskTurnControllerDeps> = {}) {
  const base = { slackless: true, ownerId: OWNER, ownerName: 'Owner' };
  const sessions = new Map<string, any>([
    [DRAFTING, { ...base, taskId: 'de-aislop', taskPlan: newPlanGate(1) }],
    [WAITING, { ...base, taskId: 'riftbound', taskPlan: awaiting() }],
    [WORK, { ...base, taskId: 'work' }],
    [WORK2, { ...base, taskId: 'work2' }],
    [EPIC, { ...base, taskId: 'e1', kind: 'epic' }],
    [EPIC_PLAN, { ...base, taskId: 'e2', kind: 'epic', taskPlan: awaiting() }],
  ]);
  const gates = new Map<string, () => void>();
  const held = new Set<string>();
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput) => {
    input.onStarted?.();
    if (held.has(input.sessionKey)) {
      await new Promise<void>((r) => gates.set(input.sessionKey, r));
    }
    return completed();
  });
  const controllers = new Map<string, AbortController>();
  const deps: TaskTurnControllerDeps = {
    runner: {
      runTaskTurn,
      abandonTurn: vi.fn(async (_k: string, turnId: string, decided: any) => ({
        turnId,
        outcome: { ...decided, turnId, at: 1 },
      })),
    },
    getSession: (k) => sessions.get(k),
    coordinator: {
      setController: (k, ac) => controllers.set(k, ac),
      removeController: (k, expected) => {
        if (!expected || controllers.get(k) === expected) controllers.delete(k);
      },
    },
    buildExecutionContext: vi.fn((s: any) => ({ origin: 'task', userId: s.ownerId, workingDirectory: '/w' }) as any),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  const controller = createTaskTurnController(deps);
  /** Start a chain that keeps running until `release(key)`. */
  const run = (key: string, text = 'go') => {
    held.add(key);
    return controller.start({ sessionKey: key, text, actorUserId: OWNER });
  };
  const release = async (key: string, done?: Promise<void>) => {
    held.delete(key);
    gates.get(key)?.();
    await done;
  };
  return { controller, sessions, run, release };
}

describe('TaskTurnController — a plan turn and the owner’s slot (2026-11-03)', () => {
  it('S1 — direct input on a waiting plan starts while another task drafts its plan (the incident)', async () => {
    const h = harness();
    const drafting = await h.run(DRAFTING);
    expect(drafting.status).toBe(202);
    const revise = await h.run(WAITING, '먼저 권한 확인해줘 — 계획 다시 짜줘');
    expect(revise.body).toEqual({ ok: true });
    expect(revise.status).toBe(202);
    await h.release(DRAFTING, drafting.done);
    await h.release(WAITING, revise.done);
  });

  it('S2 — direct input on a waiting plan starts while another task works', async () => {
    const h = harness();
    const work = await h.run(WORK);
    expect(work.status).toBe(202);
    const revise = await h.run(WAITING, '2단계는 빼줘');
    expect(revise.status).toBe(202);
    await h.release(WAITING, revise.done);
    await h.release(WORK, work.done);
  });

  it('S3 — a running plan turn holds no slot: a task’s work starts beside it', async () => {
    const h = harness();
    const drafting = await h.run(DRAFTING);
    expect(drafting.status).toBe(202);
    const work = await h.run(WORK);
    expect(work.status).toBe(202);
    await h.release(WORK, work.done);
    await h.release(DRAFTING, drafting.done);
  });

  it('S4 — the work slot is unchanged: work beside work is 429, 시작 is work, a plan turn’s end frees nothing', async () => {
    const h = harness();
    const work = await h.run(WORK);
    expect(work.status).toBe(202);
    const other = await h.run(WORK2);
    expect(other.status).toBe(429);
    expect(other.body.error).toMatch(/one dashboard task runs at a time/);
    // 시작: the decider saves the gate approved, then starts — that turn is the work.
    h.sessions.get(WAITING).taskPlan = { ...awaiting(), state: 'approved', decidedAt: 3, decidedBy: OWNER };
    expect((await h.run(WAITING)).status).toBe(429);
    // A plan turn that starts and ends beside the work does not free the work's slot.
    const drafting = await h.run(DRAFTING);
    expect(drafting.status).toBe(202);
    await h.release(DRAFTING, drafting.done);
    expect((await h.run(WORK2)).status).toBe(429);
    await h.release(WORK, work.done);
    const after = await h.run(WORK2);
    expect(after.status).toBe(202);
    await h.release(WORK2, after.done);
  });

  it('S5 — the epic tree slot likewise: an epic’s plan turn runs beside another tree, and holds none', async () => {
    const h = harness();
    const tree = await h.run(EPIC);
    expect(tree.status).toBe(202);
    const planning = await h.run(EPIC_PLAN, '자식 노드를 셋으로 줄여줘');
    expect(planning.status).toBe(202);
    await h.release(EPIC, tree.done);
    // The other epic's work starts while the planning epic still runs: the plan turn holds no tree slot.
    const again = await h.run(EPIC);
    expect(again.status).toBe(202);
    await h.release(EPIC, again.done);
    await h.release(EPIC_PLAN, planning.done);
  });

  it('S6 — a plan turn still meets the per-task 409 and the start window', async () => {
    let t = 0;
    const h = harness({ now: () => t, maxStartsPerWindow: 2, windowMs: 1000 });
    const first = await h.run(WAITING);
    expect(first.status).toBe(202);
    expect((await h.run(WAITING)).status).toBe(409);
    const second = await h.run(DRAFTING);
    expect(second.status).toBe(202);
    await h.release(WAITING, first.done);
    await h.release(DRAFTING, second.done);
    const third = await h.run(WAITING);
    expect(third.status).toBe(429);
    expect(third.body.error).toMatch(/too many dashboard task starts/);
    t = 2000;
    const later = await h.run(WAITING);
    expect(later.status).toBe(202);
    await h.release(WAITING, later.done);
  });

  it('S7 — canStart takes planning: the dry run of a plan-mode start skips the slot, not the window', async () => {
    const h = harness({ maxStartsPerWindow: 1 });
    const work = await h.run(WORK);
    expect(work.status).toBe(202);
    expect(h.controller.canStart(OWNER, 'x')?.status).toBe(429);
    expect(h.controller.canStart(OWNER, 'x', undefined, { planning: true })?.body.error).toMatch(
      /too many dashboard task starts/,
    );
    await h.release(WORK, work.done);
    const wide = harness();
    const busy = await wide.run(WORK);
    const tree = await wide.run(EPIC);
    expect(wide.controller.canStart(OWNER, 'x', undefined, { planning: true })).toBeNull();
    // A new epic made in plan mode: its plan turn needs no tree slot while another tree runs.
    expect(wide.controller.canStart(OWNER, 'x', { role: 'root' })?.body.error).toMatch(/one epic runs at a time/);
    expect(wide.controller.canStart(OWNER, 'x', { role: 'root' }, { planning: true })).toBeNull();
    // A command is still refused for what it is.
    expect(wide.controller.canStart(OWNER, '/model x', undefined, { planning: true })?.status).toBe(400);
    await wide.release(EPIC, tree.done);
    await wide.release(WORK, busy.done);
  });
});
