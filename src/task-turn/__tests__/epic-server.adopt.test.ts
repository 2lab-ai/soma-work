/**
 * #1020 — the epic finds its owner's tasks and adopts one as a child (`find_tasks`, `adopt_child`).
 *
 *   T1 the tools carry no identity (no owner, no epic id); their descriptions tell the flow: a node
 *      per task first (plan_write, the task's title), then adopt_child; the task keeps running and
 *      is not instructed — instruct_child gives it work.
 *   T2 find_tasks asks the host for the turn's own epic, passes query / day / limit, and answers
 *      the tasks with the room left for children.
 *   T3 a day that is neither 'today' nor a real YYYY-MM-DD is refused before the host is asked.
 *   T4 adopt_child: the node must be in the plan; the host adopts for the turn's own epic; the
 *      answer names the child, its node and its state.
 *   T5 a re-call for a task already this epic's child on that node returns it (adopted: false).
 *   T6 the host's refusal is passed on with its code, as spawn_child's.
 *   T7 every call re-reads the epic: no host yet, or an epic closed meanwhile, is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPlanWrite } from '../epic-plan';
import { EPIC_CHILD_MAX, type EpicExecutionContext, type EpicHost, epicTools, setEpicHost } from '../epic-server';

const EPIC_ID = 'e1';
const ctx = { origin: 'slack', userId: 'U_CTX', epicTaskId: EPIC_ID } as unknown as EpicExecutionContext;
const parse = (r: any) => JSON.parse(r.content[0].text);
afterEach(() => setEpicHost(undefined));

function world() {
  const epic: any = {
    taskId: EPIC_ID,
    ownerId: 'U1',
    channelId: 'C1',
    kind: 'epic',
    childTaskIds: ['c-old'],
    plan: applyPlanWrite(
      undefined,
      {
        nodes: [
          { id: 'login', title: 'Fix login', kind: 'issue' },
          { id: 'docs', title: 'Docs', kind: 'issue' },
        ],
      },
      { now: 1, by: 'epic', children: [] },
    ),
  };
  const children: any[] = [];
  const tasks: any[] = [{ taskId: 't1', ownerId: 'U1', activityState: 'working' }];
  const items = [
    {
      taskId: 't1',
      title: '결제 버그',
      state: 'working',
      channel: 'C2',
      lastActivity: '2026-11-06T01:00:00.000Z',
      adoptable: true,
    },
  ];
  const host: EpicHost = {
    getTask: vi.fn((id: string) => (id === EPIC_ID ? epic : [...children, ...tasks].find((c) => c.taskId === id))),
    getChildTasks: vi.fn((id: string) => (id === EPIC_ID ? children : [])),
    setEpicPlan: vi.fn() as any,
    readChildFinal: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    admit: vi.fn(() => undefined),
    spawnChild: vi.fn(async () => ({ ok: false, code: 'x', error: 'not in this test' })) as any,
    instructChild: vi.fn(async () => ({ taken: false, queued: false })),
    ensureDirectory: vi.fn(),
    findTasks: vi.fn(() => items) as any,
    adoptChild: vi.fn((_epic: any, taskId: string, planNodeId: string) => {
      const task = tasks.find((t) => t.taskId === taskId);
      Object.assign(task, { parentTaskId: EPIC_ID, planNodeId });
      children.push(task);
      epic.childTaskIds = [...epic.childTaskIds, taskId];
      return { ok: true as const };
    }),
  };
  setEpicHost(host);
  return { epic, children, tasks, items, host };
}

const tools = () => {
  const all = epicTools(ctx);
  const byName = new Map(all.map((t) => [t.name, t]));
  return { findTasks: byName.get('find_tasks') as any, adoptChild: byName.get('adopt_child') as any };
};

describe('find_tasks and adopt_child (#1020)', () => {
  it('T1 — no identity in the arguments; the descriptions tell the flow', () => {
    const { findTasks, adoptChild } = tools();
    expect(findTasks?.name).toBe('find_tasks');
    expect(adoptChild?.name).toBe('adopt_child');
    expect(Object.keys(findTasks.inputSchema).sort()).toEqual(['day', 'limit', 'query']);
    expect(Object.keys(adoptChild.inputSchema).sort()).toEqual(['planNodeId', 'taskId']);
    for (const t of [findTasks, adoptChild]) {
      expect(t.description).toContain('plan_write');
      expect(t.description).toContain('adopt_child');
    }
    expect(adoptChild.description).toContain('instruct_child');
    expect(adoptChild.description).toMatch(/not instructed/);
    expect(adoptChild.description).toMatch(/keeps running/);
    expect(adoptChild.description).toContain(`${EPIC_CHILD_MAX}`);
    expect(findTasks.description).toMatch(/today/);
  });

  it('T2 — find_tasks: the host’s tasks for the turn’s own epic, with the room left', async () => {
    const w = world();
    const { findTasks } = tools();
    const r = await findTasks.handler({ query: '결제', day: 'today', limit: 5 }, {});
    expect(r.isError).toBeUndefined();
    expect(w.host.findTasks).toHaveBeenCalledWith(w.epic, { query: '결제', day: 'today', limit: 5 });
    expect(parse(r)).toEqual({ ok: true, room: EPIC_CHILD_MAX - 1, tasks: w.items });
    await findTasks.handler({}, {});
    expect(w.host.findTasks).toHaveBeenLastCalledWith(w.epic, {});
    // Closed children count: no room is never negative.
    w.epic.childTaskIds = Array.from({ length: EPIC_CHILD_MAX + 2 }, (_, i) => `gone${i}`);
    expect(parse(await findTasks.handler({}, {})).room).toBe(0);
  });

  it('T3 — a day that is not today or a real YYYY-MM-DD is refused before the host is asked', async () => {
    const w = world();
    const { findTasks } = tools();
    for (const day of ['yesterday', '2026-13-01', '2026-02-30', '26-11-06', '2026/11/06']) {
      const r = await findTasks.handler({ day }, {});
      expect(r.isError, day).toBe(true);
      expect(parse(r)).toMatchObject({ ok: false, code: 'bad-day' });
    }
    expect(w.host.findTasks).not.toHaveBeenCalled();
    expect(parse(await findTasks.handler({ day: '2026-11-06' }, {})).ok).toBe(true);
    expect(parse(await findTasks.handler({ day: 'today' }, {})).ok).toBe(true);
    // A blank day is no day.
    await findTasks.handler({ day: '  ', query: '결제' }, {});
    expect(w.host.findTasks).toHaveBeenLastCalledWith(w.epic, { query: '결제' });
  });

  it('T4 — adopt_child: a node of the plan, adopted for the turn’s own epic; the child, its node, its state', async () => {
    const w = world();
    const { adoptChild } = tools();
    const missing = await adoptChild.handler({ taskId: 't1', planNodeId: 'nope' }, {});
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({ ok: false, code: 'no-such-node' });
    expect(parse(missing).error).toContain('plan_write');
    expect(w.host.adoptChild).not.toHaveBeenCalled();

    const r = await adoptChild.handler({ taskId: 't1', planNodeId: 'login' }, {});
    expect(r.isError).toBeUndefined();
    expect(w.host.adoptChild).toHaveBeenCalledWith(w.epic, 't1', 'login');
    expect(parse(r)).toEqual({ ok: true, adopted: true, childId: 't1', planNodeId: 'login', state: 'working' });
    // Adopting starts nothing: no instruction, no start in the tree's window.
    expect(w.host.instructChild).not.toHaveBeenCalled();
    expect(w.host.spawnChild).not.toHaveBeenCalled();
  });

  it('T5 — a re-call for this epic’s child on that node returns it (adopted: false)', async () => {
    const w = world();
    const { adoptChild } = tools();
    await adoptChild.handler({ taskId: 't1', planNodeId: 'login' }, {});
    const again = await adoptChild.handler({ taskId: 't1', planNodeId: 'login' }, {});
    expect(parse(again)).toEqual({ ok: true, adopted: false, childId: 't1', planNodeId: 'login', state: 'working' });
    expect(w.host.adoptChild).toHaveBeenCalledTimes(1);
  });

  it('T6 — the host’s refusal is passed on with its code', async () => {
    const w = world();
    const { adoptChild } = tools();
    (w.host.adoptChild as any).mockReturnValueOnce({
      ok: false,
      code: 'other-owner',
      error: 'that task is not this epic owner’s',
    });
    const r = await adoptChild.handler({ taskId: 't1', planNodeId: 'login' }, {});
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual({ ok: false, code: 'other-owner', error: 'that task is not this epic owner’s' });
  });

  it('T7 — every call re-reads the epic: no host yet, or an epic closed meanwhile, is refused', async () => {
    const { findTasks, adoptChild } = tools();
    expect(parse(await findTasks.handler({}, {}))).toMatchObject({ code: 'not-ready' });
    expect(parse(await adoptChild.handler({ taskId: 't1', planNodeId: 'login' }, {}))).toMatchObject({
      code: 'not-ready',
    });
    const w = world();
    w.epic.closing = true;
    expect(parse(await findTasks.handler({}, {}))).toMatchObject({ code: 'not-an-epic' });
    expect(parse(await adoptChild.handler({ taskId: 't1', planNodeId: 'login' }, {}))).toMatchObject({
      code: 'not-an-epic',
    });
    expect(w.host.findTasks).not.toHaveBeenCalled();
    expect(w.host.adoptChild).not.toHaveBeenCalled();
  });
});
