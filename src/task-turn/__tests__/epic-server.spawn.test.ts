/**
 * E4 ④b — the epic makes and instructs its children (.prd/19 D4 · D8 · D9 a, §5 ④b).
 *
 *   K1 the same node twice → one child (the second call returns it).
 *   K2 a child made but not started (the turn ended) → a re-call returns the same child.
 *   K3 the 8th child is refused; nothing is made.
 *   K4 folder: a sub-path of the epic's folder, or a fresh one; out of it, or
 *      shared with a running sibling (same, or one holding the other), refused.
 *   K5 arguments cannot change the owner: the child is the epic owner's, under the epic.
 *   K6 the start is a host start of the tree (E4 ③): its dry run first, refusals passed on.
 *   K7 a failed create: nothing started, the refusal says so.
 *   I1 instruct_child: plain text only; a running child is busy (409 passed on);
 *      only this epic's live children; a running sibling in its folder refuses.
 */
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskExecutionContext } from '../../agent-runtime/execution-context';
import { applyPlanWrite } from '../epic-plan';
import { EPIC_CHILD_MAX, type EpicHost, epicTools, setEpicHost } from '../epic-server';

const OWNER = `UEPICS${process.pid}`;
const EPIC_DIR = `/tmp/${OWNER}/epic_1`;
const EPIC_ID = 'e1';

beforeAll(() => fs.mkdirSync(`${EPIC_DIR}/work`, { recursive: true }));
afterAll(() => fs.rmSync(`/tmp/${OWNER}`, { recursive: true, force: true }));
afterEach(() => setEpicHost(undefined));

// The turn runs as someone else in its context: the child must still be the epic owner's.
const ctx = { origin: 'task', userId: 'U_CTX', taskId: EPIC_ID, kind: 'epic' } as unknown as TaskExecutionContext;
const parse = (r: any) => JSON.parse(r.content[0].text);

function world() {
  const epic: any = {
    taskId: EPIC_ID,
    ownerId: OWNER,
    ownerName: 'Owner',
    slackless: true,
    kind: 'epic',
    workingDirectory: EPIC_DIR,
    childTaskIds: [],
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
  const running = new Set<string>();
  let n = 0;
  const controller = {
    canStart: vi.fn((): any => null),
    start: vi.fn(async (_req: any): Promise<any> => ({ status: 202, body: { ok: true } })),
    isRunning: vi.fn((key: string) => running.has(key)),
  };
  const host: EpicHost = {
    getTask: (id) => (id === EPIC_ID ? epic : children.find((c) => c.taskId === id)),
    getChildTasks: (id) => (id === EPIC_ID ? children : []),
    setEpicPlan: vi.fn() as any,
    readChildFinal: vi.fn(async () => undefined),
    createTask: vi.fn((input: any) => {
      const child = { ...input, taskId: `c${++n}`, slackless: true, activityState: 'idle' };
      children.push(child);
      epic.childTaskIds = [...epic.childTaskIds, child.taskId];
      return child;
    }),
    createFreshDirectory: vi.fn((ownerId: string) => `/tmp/${ownerId}/session_fresh${n + 1}`),
    ensureDirectory: vi.fn(),
    controller,
  };
  setEpicHost(host);
  const [, , spawn, instruct] = epicTools(ctx);
  return { epic, children, running, controller, host, spawn, instruct };
}

describe('spawn_child (E4 ④b)', () => {
  it('K1 — the same node twice is one child: the second call returns it', async () => {
    const w = world();
    const first = parse(await w.spawn.handler({ planNodeId: 'login', instruction: 'fix it' } as any, {}));
    expect(first).toMatchObject({ ok: true, made: true, childId: 'c1', started: true });
    const again = parse(await w.spawn.handler({ planNodeId: 'login', instruction: 'fix it' } as any, {}));
    expect(again).toMatchObject({ ok: true, made: false, childId: 'c1' });
    expect(w.host.createTask).toHaveBeenCalledTimes(1);
    expect(w.controller.start).toHaveBeenCalledTimes(1);
  });

  it('K2 — made but not started (the turn ended before): a re-call returns the same child', async () => {
    const w = world();
    w.controller.start.mockResolvedValueOnce({ status: 500, body: { error: 'the task turn could not start' } });
    const first = parse(await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {}));
    expect(first).toMatchObject({ made: true, childId: 'c1', started: false, reason: 'the task turn could not start' });
    const again = parse(await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {}));
    expect(again).toMatchObject({ made: false, childId: 'c1', state: 'idle' });
  });

  it(`K3 — the ${EPIC_CHILD_MAX + 1}th child is refused, closed children counted; nothing is made`, async () => {
    const w = world();
    w.epic.childTaskIds = Array.from({ length: EPIC_CHILD_MAX }, (_, i) => `old${i}`);
    const r = await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatchObject({ code: 'too-many-children' });
    expect(w.host.createTask).not.toHaveBeenCalled();
  });

  it('K4 — folder: a sub-path of the epic’s folder or a fresh one; out of it or shared with a running sibling refused', async () => {
    const w = world();
    const named = parse(
      await w.spawn.handler({ planNodeId: 'login', instruction: 'go', folder: 'work/login' } as any, {}),
    );
    expect(named).toMatchObject({ made: true, childId: 'c1' });
    expect(w.children[0].workingDirectory).toBe(`${EPIC_DIR}/work/login`);
    expect(w.host.ensureDirectory).toHaveBeenCalledWith(`${EPIC_DIR}/work/login`);
    // Out of the epic's folder: refused, nothing made.
    for (const folder of ['../elsewhere', '/tmp/x', 'a/../../b']) {
      const r = parse(await w.spawn.handler({ planNodeId: 'docs', instruction: 'go', folder } as any, {}));
      expect(r.code, folder).toBe('bad-folder');
    }
    // A running sibling in the same folder, or one holding it: refused.
    w.running.add('task:c1');
    for (const folder of ['work/login', 'work/login/sub', 'work']) {
      const r = parse(await w.spawn.handler({ planNodeId: 'docs', instruction: 'go', folder } as any, {}));
      expect(r.code, folder).toBe('folder-overlap');
    }
    // A folder that only shares a prefix is not the same folder.
    const apart = parse(
      await w.spawn.handler({ planNodeId: 'docs', instruction: 'go', folder: 'work/login2' } as any, {}),
    );
    expect(apart).toMatchObject({ made: true });
    expect(w.host.createTask).toHaveBeenCalledTimes(2);
    // No folder: a fresh one.
    const w2 = world();
    await w2.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    expect(w2.host.createFreshDirectory).toHaveBeenCalledWith(OWNER);
    expect(w2.children[0].workingDirectory).toMatch(new RegExp(`^/tmp/${OWNER}/session_fresh`));
  });

  it('K5 — the child is the epic owner’s, under the epic, for that node; no argument names an owner or mode', async () => {
    const w = world();
    const [, , spawn] = epicTools(ctx);
    expect(Object.keys(spawn.inputSchema).sort()).toEqual(['folder', 'instruction', 'planNodeId', 'title']);
    await w.spawn.handler({ planNodeId: 'login', instruction: 'go', ownerId: 'U_EVIL', isAdmin: true } as any, {});
    expect(w.host.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, parentTaskId: EPIC_ID, planNodeId: 'login', title: 'Fix login' }),
    );
    expect(w.controller.start).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: OWNER, initiator: 'host', sessionKey: 'task:c1', text: 'go' }),
    );
  });

  it('K6 — the tree’s dry run comes first; its refusal is passed on and nothing is made; an unknown node is refused', async () => {
    const w = world();
    w.controller.canStart.mockReturnValueOnce({
      status: 429,
      body: { error: 'at most 3 children of an epic run at once' },
    });
    const r = parse(await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {}));
    expect(r).toMatchObject({ ok: false, code: 'start-429', error: 'at most 3 children of an epic run at once' });
    expect(w.controller.canStart).toHaveBeenCalledWith(OWNER, 'go', {
      root: 'task:e1',
      role: 'child',
      initiator: 'host',
    });
    expect(w.host.createTask).not.toHaveBeenCalled();
    expect(w.host.createFreshDirectory).not.toHaveBeenCalled();
    expect(parse(await w.spawn.handler({ planNodeId: 'nope', instruction: 'go' } as any, {}))).toMatchObject({
      code: 'no-such-node',
    });
  });

  it('K7 — a failed create starts nothing and says so (no internal message)', async () => {
    const w = world();
    (w.host.createTask as any).mockImplementationOnce(() => {
      throw new Error('ENOSPC /secret');
    });
    const r = await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    expect(parse(r)).toMatchObject({ code: 'not-saved' });
    expect(JSON.stringify(r.content)).not.toMatch(/ENOSPC|secret/);
    expect(w.controller.start).not.toHaveBeenCalled();
  });
});

describe('instruct_child (E4 ④b, D8)', () => {
  async function withChild() {
    const w = world();
    await w.spawn.handler({ planNodeId: 'login', instruction: 'first', folder: 'work/login' } as any, {});
    w.controller.start.mockClear();
    return w;
  }

  it('I1 — a plain instruction starts the child as a host start; / or % is refused with its reason', async () => {
    const w = await withChild();
    expect(parse(await w.instruct.handler({ childId: 'c1', instruction: 'next step' } as any, {}))).toEqual({
      ok: true,
      childId: 'c1',
      started: true,
    });
    expect(w.controller.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'task:c1', text: 'next step', actorUserId: OWNER, initiator: 'host' }),
    );
    for (const instruction of ['/compact', '  %model x']) {
      const r = parse(await w.instruct.handler({ childId: 'c1', instruction } as any, {}));
      expect(r.code, instruction).toBe('command');
    }
    expect(w.controller.start).toHaveBeenCalledTimes(1);
  });

  it('I2 — a running child is busy (the controller’s 409 passed on); other refusals keep their status', async () => {
    const w = await withChild();
    w.controller.start.mockResolvedValueOnce({
      status: 409,
      body: { error: 'a turn is already running on this task' },
    });
    expect(parse(await w.instruct.handler({ childId: 'c1', instruction: 'x' } as any, {}))).toMatchObject({
      code: 'busy',
      error: 'a turn is already running on this task',
    });
    w.controller.start.mockResolvedValueOnce({
      status: 429,
      body: { error: 'this epic reached its cost limit ($50)' },
    });
    expect(parse(await w.instruct.handler({ childId: 'c1', instruction: 'x' } as any, {}))).toMatchObject({
      code: 'start-429',
    });
  });

  it('I2b — a running child is busy, not in its own way: its own folder is not a sibling’s', async () => {
    const w = await withChild();
    w.running.add('task:c1');
    w.controller.start.mockResolvedValueOnce({
      status: 409,
      body: { error: 'a turn is already running on this task' },
    });
    expect(parse(await w.instruct.handler({ childId: 'c1', instruction: 'x' } as any, {}))).toMatchObject({
      code: 'busy',
    });
  });

  it('I3 — only this epic’s live children: a stranger, or a closed child, is refused', async () => {
    const w = await withChild();
    expect(parse(await w.instruct.handler({ childId: 'zz', instruction: 'x' } as any, {}))).toMatchObject({
      code: 'not-a-child',
    });
    w.children.splice(0, 1); // c1 closed (still counted in childTaskIds)
    expect(parse(await w.instruct.handler({ childId: 'c1', instruction: 'x' } as any, {}))).toMatchObject({
      code: 'closed',
    });
    expect(w.controller.start).not.toHaveBeenCalled();
  });

  it('I4 — a running sibling in its folder refuses the restart (D4)', async () => {
    const w = await withChild();
    // A second child made in a folder that holds c1's, while c1 was idle.
    await w.spawn.handler({ planNodeId: 'docs', instruction: 'go', folder: 'work' } as any, {});
    w.running.add('task:c2');
    w.controller.start.mockClear();
    expect(parse(await w.instruct.handler({ childId: 'c1', instruction: 'x' } as any, {}))).toMatchObject({
      code: 'folder-overlap',
    });
    expect(w.controller.start).not.toHaveBeenCalled();
  });
});
