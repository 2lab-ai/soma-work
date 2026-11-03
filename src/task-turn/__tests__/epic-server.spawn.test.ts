/**
 * E4 ④b — the epic makes and instructs its children (.prd/19 D4 · D8 · D9 a), on the Slack path
 * since #854: a child is its own Slack thread, an instruction is a message into it.
 *
 *   K1 the same node twice → one child (the second call returns it).
 *   K3 the 8th child is refused; nothing is made.
 *   K4 folder: a sub-path of the epic's folder (made, handed to the child), or none — the child's
 *      thread gets a fresh one; out of it, or shared with a running sibling, refused.
 *   K5 no argument names an owner: the host makes the child from the epic's own record.
 *   K6 the tree's limits come first: a refusal is passed on and nothing is made.
 *   K7 the host's refusal is passed on; a folder this call made is removed again.
 *   K8 an empty, over-long or command-like instruction is refused before anything is made.
 *   K10 the title is the card rule; none falls back to the node's.
 *   K12 a closed child is not live: instruct_child calls it closed.
 *   I1 an idle child: the tree's limits, then the instruction — it runs now.
 *   I2 a working child takes the instruction in its queue: queued, never refused as busy (the
 *      bug #854 removes — the epic's word to a busy child is not lost).
 *   I3 only this epic's live children.
 *   I4 a running sibling in an idle child's folder refuses the restart (D4).
 *   I5 an instruction that went nowhere says so.
 */
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyPlanWrite } from '../epic-plan';
import { EPIC_CHILD_MAX, type EpicExecutionContext, type EpicHost, epicTools, setEpicHost } from '../epic-server';

const OWNER = `UEPICS${process.pid}`;
const EPIC_DIR = `/tmp/${OWNER}/session_epic`;
const EPIC_ID = 'e1';

beforeAll(() => fs.mkdirSync(`${EPIC_DIR}/work`, { recursive: true }));
afterAll(() => fs.rmSync(`/tmp/${OWNER}`, { recursive: true, force: true }));
afterEach(() => setEpicHost(undefined));

// The turn runs as someone in its context: the child is still made from the epic's own record.
const ctx = { origin: 'slack', userId: 'U_CTX', epicTaskId: EPIC_ID } as unknown as EpicExecutionContext;
const parse = (r: any) => JSON.parse(r.content[0].text);

function world() {
  const epic: any = {
    taskId: EPIC_ID,
    ownerId: OWNER,
    channelId: 'C1',
    kind: 'epic',
    sessionWorkingDir: EPIC_DIR,
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
  const host: EpicHost = {
    getTask: (id) => (id === EPIC_ID ? epic : children.find((c) => c.taskId === id)),
    getChildTasks: (id) => (id === EPIC_ID ? children : []),
    setEpicPlan: vi.fn() as any,
    readChildFinal: vi.fn(async () => undefined),
    isRunning: vi.fn((s: any) => running.has(s.taskId)),
    admit: vi.fn((): string | undefined => undefined),
    spawnChild: vi.fn(async (_epic: any, spec: any): Promise<any> => {
      const child = {
        taskId: `c${++n}`,
        ownerId: OWNER,
        parentTaskId: EPIC_ID,
        planNodeId: spec.planNodeId,
        title: spec.title,
        sessionWorkingDir: spec.workingDirectory ?? `/tmp/${OWNER}/session_fresh${n}`,
        activityState: 'working',
      };
      children.push(child);
      epic.childTaskIds = [...epic.childTaskIds, child.taskId];
      return { ok: true, childId: child.taskId, started: true };
    }),
    instructChild: vi.fn(
      async (_epic: any, child: any): Promise<any> => ({
        taken: true,
        queued: running.has(child.taskId),
      }),
    ),
    ensureDirectory: vi.fn((dir: string) => {
      if (fs.existsSync(dir)) return undefined;
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }),
  };
  setEpicHost(host);
  const [, , spawn, instruct] = epicTools(ctx);
  return { epic, children, running, host, spawn, instruct };
}

describe('epic children on the Slack path (E4 ④b, #854)', () => {
  it('K1 — the same node twice is one child: the second call returns it', async () => {
    const w = world();
    const first = parse(await w.spawn.handler({ planNodeId: 'login', instruction: '로그인 고쳐' } as any, {}));
    expect(first).toEqual({ ok: true, made: true, childId: 'c1', started: true });
    const again = parse(await w.spawn.handler({ planNodeId: 'login', instruction: '또' } as any, {}));
    expect(again).toEqual({ ok: true, made: false, childId: 'c1', state: 'working' });
    expect(w.host.spawnChild).toHaveBeenCalledTimes(1);
  });

  it(`K3 — the ${EPIC_CHILD_MAX + 1}th child is refused, closed children counted; nothing is made`, async () => {
    const w = world();
    w.epic.childTaskIds = Array.from({ length: EPIC_CHILD_MAX }, (_, i) => `gone${i}`);
    const r = await w.spawn.handler({ planNodeId: 'docs', instruction: 'go' } as any, {});
    expect(parse(r)).toMatchObject({ ok: false, code: 'too-many-children' });
    expect(w.host.spawnChild).not.toHaveBeenCalled();
  });

  it('K4 — folder: a sub-path of the epic’s folder is made and handed over; none → a fresh one; out of it, or a running sibling’s, refused', async () => {
    const w = world();
    parse(await w.spawn.handler({ planNodeId: 'login', instruction: 'a', folder: 'work/login' } as any, {}));
    expect((w.host.spawnChild as any).mock.calls[0][1]).toMatchObject({ workingDirectory: `${EPIC_DIR}/work/login` });
    expect(fs.existsSync(`${EPIC_DIR}/work/login`)).toBe(true);
    // No folder: the child's own thread gets a fresh session folder.
    parse(await w.spawn.handler({ planNodeId: 'docs', instruction: 'b' } as any, {}));
    expect((w.host.spawnChild as any).mock.calls[1][1].workingDirectory).toBeUndefined();

    const out = world();
    const escape = await out.spawn.handler({ planNodeId: 'login', instruction: 'a', folder: '../../etc' } as any, {});
    expect(parse(escape).ok).toBe(false);
    expect(out.host.spawnChild).not.toHaveBeenCalled();

    const shared = world();
    shared.children.push({
      taskId: 'busy',
      ownerId: OWNER,
      parentTaskId: EPIC_ID,
      planNodeId: 'docs',
      sessionWorkingDir: `${EPIC_DIR}/work`,
    });
    shared.running.add('busy');
    const overlap = await shared.spawn.handler(
      { planNodeId: 'login', instruction: 'a', folder: 'work/login' } as any,
      {},
    );
    expect(parse(overlap)).toMatchObject({ ok: false, code: 'folder-overlap' });
    expect(shared.host.spawnChild).not.toHaveBeenCalled();
  });

  it('K5 — the host makes the child from the epic’s own record; no argument names an owner', async () => {
    const w = world();
    expect(Object.keys((w.spawn as any).inputSchema).sort()).toEqual(['folder', 'instruction', 'planNodeId', 'title']);
    await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    expect((w.host.spawnChild as any).mock.calls[0][0]).toBe(w.epic);
  });

  it('K6 — the tree’s limits come first: their refusal is passed on and nothing is made; an unknown node is refused', async () => {
    const w = world();
    (w.host.admit as any).mockReturnValue('at most 3 children of an epic run at once — wait for one to finish');
    const r = await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    expect(parse(r)).toMatchObject({ ok: false, code: 'start-429', error: expect.stringMatching(/at most 3/) });
    expect(w.host.spawnChild).not.toHaveBeenCalled();
    const unknown = await w.spawn.handler({ planNodeId: 'nope', instruction: 'go' } as any, {});
    expect(parse(unknown)).toMatchObject({ code: 'no-such-node' });
  });

  it('K7 — the host’s refusal is passed on; a folder this call made is removed again', async () => {
    const w = world();
    (w.host.spawnChild as any).mockResolvedValueOnce({
      ok: false,
      code: 'no-thread',
      error: 'the child’s thread could not be made — nothing changed; try again',
    });
    const r = await w.spawn.handler({ planNodeId: 'login', instruction: 'go', folder: 'work/k7' } as any, {});
    expect(parse(r)).toMatchObject({ ok: false, code: 'no-thread' });
    expect(fs.existsSync(`${EPIC_DIR}/work/k7`)).toBe(false);
    expect(fs.existsSync(`${EPIC_DIR}/work`)).toBe(true);
  });

  it('K8 — an empty, blank, over-long or command instruction is refused before anything is made', async () => {
    const w = world();
    for (const instruction of ['', '   ', '/compact', '%model x', '!stop', '$autoz go', 'x'.repeat(40_001)]) {
      const r = await w.spawn.handler({ planNodeId: 'login', instruction } as any, {});
      expect(r.isError, instruction.slice(0, 10)).toBe(true);
    }
    expect(w.host.spawnChild).not.toHaveBeenCalled();
  });

  it('K10 — the title is the card rule (first non-empty line, 80 chars); none falls back to the node', async () => {
    const w = world();
    await w.spawn.handler(
      { planNodeId: 'login', instruction: 'go', title: `\n  첫 줄 ${'가'.repeat(90)}\n둘째` } as any,
      {},
    );
    await w.spawn.handler({ planNodeId: 'docs', instruction: 'go' } as any, {});
    const titles = (w.host.spawnChild as any).mock.calls.map((c: any[]) => c[1].title);
    expect(titles[0]).toHaveLength(80);
    expect(titles[0].startsWith('첫 줄')).toBe(true);
    expect(titles[1]).toBe('Docs');
  });

  it('K12 — a closed child is not live: its node may get a new one, instruct_child calls it closed', async () => {
    const w = world();
    w.epic.childTaskIds = ['c-old'];
    w.children.push({ taskId: 'c-old', ownerId: OWNER, parentTaskId: EPIC_ID, planNodeId: 'login', terminated: true });
    const r = parse(await w.instruct.handler({ childId: 'c-old', instruction: 'go' } as any, {}));
    expect(r).toMatchObject({ ok: false, code: 'closed' });
    const made = parse(await w.spawn.handler({ planNodeId: 'login', instruction: 'again' } as any, {}));
    expect(made).toMatchObject({ ok: true, made: true });
  });

  it('I1 — an idle child: the tree’s limits, then the instruction into its thread — it runs now', async () => {
    const w = world();
    await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    w.children[0].activityState = 'idle';
    (w.host.admit as any).mockClear();
    const r = parse(await w.instruct.handler({ childId: 'c1', instruction: '테스트도 추가해' } as any, {}));
    expect(r).toEqual({ ok: true, childId: 'c1', started: true, queued: false });
    expect(w.host.admit).toHaveBeenCalledWith(w.epic, { child: w.children[0] });
    expect(w.host.instructChild).toHaveBeenCalledWith(w.epic, w.children[0], '테스트도 추가해');
  });

  it('I2 — a working child takes the instruction in its queue: queued, never refused as busy', async () => {
    const w = world();
    await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    w.running.add('c1');
    (w.host.admit as any).mockClear();
    // Queueing takes no new place (the gate does not count the running child against itself, G1) —
    // but it is a start of the tree's work, so the tree's spend and window still answer (review #872 astra R6).
    const r = parse(await w.instruct.handler({ childId: 'c1', instruction: '이것도' } as any, {}));
    expect(r).toEqual({ ok: true, childId: 'c1', started: false, queued: true });
    expect(w.host.admit).toHaveBeenCalledWith(w.epic, { child: w.children[0] });
  });

  it('I6 — a tree past its cost cap queues nothing either: the working child’s instruction is refused, nothing sent', async () => {
    const w = world();
    await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    w.running.add('c1');
    (w.host.instructChild as any).mockClear();
    (w.host.admit as any).mockReturnValue(
      'this epic reached its cost limit ($50) — an instruction from its owner still runs',
    );
    const r = parse(await w.instruct.handler({ childId: 'c1', instruction: '이것도' } as any, {}));
    expect(r).toMatchObject({ ok: false, code: 'start-429' });
    expect(w.host.instructChild).not.toHaveBeenCalled();
  });

  it('I3 — only this epic’s live children: a stranger is refused, nothing is sent', async () => {
    const w = world();
    const r = parse(await w.instruct.handler({ childId: 'someone', instruction: 'go' } as any, {}));
    expect(r).toMatchObject({ ok: false, code: 'not-a-child' });
    expect(w.host.instructChild).not.toHaveBeenCalled();
  });

  it('I4 — a running sibling in an idle child’s folder refuses its restart (D4)', async () => {
    const w = world();
    w.epic.childTaskIds = ['idle', 'busy'];
    w.children.push(
      {
        taskId: 'idle',
        ownerId: OWNER,
        parentTaskId: EPIC_ID,
        planNodeId: 'login',
        sessionWorkingDir: `${EPIC_DIR}/work`,
      },
      {
        taskId: 'busy',
        ownerId: OWNER,
        parentTaskId: EPIC_ID,
        planNodeId: 'docs',
        sessionWorkingDir: `${EPIC_DIR}/work`,
      },
    );
    w.running.add('busy');
    const r = parse(await w.instruct.handler({ childId: 'idle', instruction: 'go' } as any, {}));
    expect(r).toMatchObject({ ok: false, code: 'folder-overlap' });
    expect(w.host.instructChild).not.toHaveBeenCalled();
  });

  it('I5 — an instruction that went nowhere says so', async () => {
    const w = world();
    await w.spawn.handler({ planNodeId: 'login', instruction: 'go' } as any, {});
    (w.host.instructChild as any).mockResolvedValueOnce({ taken: false, queued: false, reason: 'the thread is gone' });
    const r = parse(await w.instruct.handler({ childId: 'c1', instruction: 'go' } as any, {}));
    expect(r).toMatchObject({ ok: false, code: 'not-sent', error: 'the thread is gone' });
  });
});
