/**
 * E4 ③ — the epic tree's execution slot (.prd/19 D9 c·d·e, §2.1), next to
 * A0's one-chain-per-owner slot, which stays as it was:
 *
 *   T1 while the epic root runs, its child may start; another tree is 429;
 *      an ordinary task follows A0 (one at a time, beside the tree).
 *   T2 the root's chain ends while a child runs: the tree keeps the slot.
 *   T3 a 4th child running at once is 429.
 *   T4 a Close that times out releases only that member.
 *   T5 a tree has its own window (30 starts per 10 minutes), apart from A0's;
 *      the launcher's start of a new epic counts against A0's.
 *   T6 over the cost limit a host start (spawn, instruct, wake) is refused;
 *      the owner's own instruction still runs.
 *   T7 shutting down: 503.
 *   T8 canStart takes the tree: a dry run of the same admission, counting nothing.
 *   T9 a tree start answered 500 does not use up the tree's window, and holds no slot.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskTurnController, type TaskTurnControllerDeps } from '../task-turn-controller';
import type { RunTaskTurnInput, RunTaskTurnResult } from '../task-turn-runner';

const OWNER = 'UOWNER';
const EPIC = 'task:e1';
const EPIC2 = 'task:e2';
const PLAIN = 'task:p1';
const PLAIN2 = 'task:p2';
const child = (n: number, parent = 'e1') => `task:${parent}-c${n}`;

const completed = (turnId = 't'): RunTaskTurnResult => ({
  turnId,
  outcome: { turnId, outcome: 'completed', category: 'WorkflowComplete', at: 1 },
});

function harness(over: Partial<TaskTurnControllerDeps> = {}) {
  const base = { slackless: true, ownerId: OWNER, ownerName: 'Owner' };
  const sessions = new Map<string, any>([
    [EPIC, { ...base, taskId: 'e1', kind: 'epic' }],
    [EPIC2, { ...base, taskId: 'e2', kind: 'epic' }],
    [PLAIN, { ...base, taskId: 'p1' }],
    [PLAIN2, { ...base, taskId: 'p2' }],
  ]);
  for (let n = 1; n <= 5; n++) {
    sessions.set(child(n), { ...base, taskId: `e1-c${n}`, parentTaskId: 'e1', planNodeId: `n${n}` });
  }
  sessions.set(child(1, 'e2'), { ...base, taskId: 'e2-c1', parentTaskId: 'e2', planNodeId: 'n1' });

  // Every chain runs until its gate opens (or returns at once when there is none).
  const gates = new Map<string, () => void>();
  const hold = (key: string) => {
    let open!: () => void;
    const p = new Promise<void>((r) => {
      open = r;
    });
    gates.set(key, open);
    return p;
  };
  const held = new Set<string>();
  const runTaskTurn = vi.fn(async (input: RunTaskTurnInput) => {
    input.onStarted?.();
    if (held.has(input.sessionKey)) await hold(input.sessionKey);
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
  const run = async (key: string, extra: Record<string, unknown> = {}) => {
    held.add(key);
    return controller.start({ sessionKey: key, text: 'go', actorUserId: OWNER, ...extra });
  };
  const release = async (key: string, done?: Promise<void>) => {
    held.delete(key);
    gates.get(key)?.();
    await done;
  };
  return { controller, sessions, run, release, deps, runTaskTurn };
}

const status = (r: { status: number }) => r.status;

describe('TaskTurnController — the epic tree slot (E4 ③, .prd/19 §2.1)', () => {
  it('T1 — the root runs: its child starts, another tree is 429, an ordinary task follows A0 beside the tree', async () => {
    const h = harness();
    const root = await h.run(EPIC);
    expect(status(root)).toBe(202);
    const c1 = await h.run(child(1));
    expect(status(c1)).toBe(202);
    // Another epic, or a child of another epic: one tree per owner.
    expect(status(await h.run(EPIC2))).toBe(429);
    expect(status(await h.run(child(1, 'e2')))).toBe(429);
    // An ordinary task runs beside the tree; a second ordinary one is A0's 429.
    const plain = await h.run(PLAIN);
    expect(status(plain)).toBe(202);
    expect(status(await h.run(PLAIN2))).toBe(429);
    // The same tree's root again while it runs: the busy task's 409.
    expect(status(await h.run(EPIC))).toBe(409);
    await h.release(EPIC, root.done);
    await h.release(child(1), c1.done);
    await h.release(PLAIN, plain.done);
    // All free: the other tree may run now.
    const other = await h.run(EPIC2);
    expect(status(other)).toBe(202);
    await h.release(EPIC2, other.done);
  });

  it('T2 — the root’s chain ends while a child runs: the tree keeps the slot until the child ends', async () => {
    const h = harness();
    const root = await h.run(EPIC);
    const c1 = await h.run(child(1));
    await h.release(EPIC, root.done);
    expect(status(await h.run(EPIC2))).toBe(429);
    // The root may start again (a wake) while its child runs.
    const wake = await h.run(EPIC);
    expect(status(wake)).toBe(202);
    await h.release(EPIC, wake.done);
    await h.release(child(1), c1.done);
    const other = await h.run(EPIC2);
    expect(status(other)).toBe(202);
    await h.release(EPIC2, other.done);
  });

  it('T3 — at most 3 children of an epic run at once; the 4th is 429, and starts once one ends', async () => {
    const h = harness();
    const running = [];
    for (let n = 1; n <= 3; n++) {
      const r = await h.run(child(n));
      expect(status(r), `child ${n}`).toBe(202);
      running.push(r);
    }
    const fourth = await h.run(child(4));
    expect(status(fourth)).toBe(429);
    expect((fourth.body as any).error).toMatch(/3 children/);
    // The root is not a child: it still starts.
    const root = await h.run(EPIC);
    expect(status(root)).toBe(202);
    await h.release(child(1), running[0].done);
    const now = await h.run(child(4));
    expect(status(now)).toBe(202);
    for (const [key, r] of [
      [child(2), running[1]],
      [child(3), running[2]],
      [child(4), now],
      [EPIC, root],
    ] as const)
      await h.release(key, r.done);
  });

  it('T4 — a Close that times out releases only that member; the rest of the tree keeps the slot', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ closeWaitMs: 1000 });
      const root = await h.run(EPIC);
      const c1 = await h.run(child(1));
      const c2 = await h.run(child(2));
      const c3 = await h.run(child(3));
      // The chain ignores its abort (hung): Close gives up after closeWaitMs.
      const closing = h.controller.close(child(1));
      await vi.advanceTimersByTimeAsync(1000);
      await closing;
      expect(h.controller.isRunning(child(1))).toBe(false);
      // One child slot is free; the tree still holds the owner's slot.
      const c4 = await h.run(child(4));
      expect(status(c4)).toBe(202);
      expect(status(await h.run(child(5)))).toBe(429);
      expect(status(await h.run(EPIC2))).toBe(429);
      // The hung chain ending late frees nothing that is not its own.
      await h.release(child(1), c1.done);
      expect(status(await h.run(child(5)))).toBe(429);
      for (const [key, r] of [
        [child(2), c2],
        [child(3), c3],
        [child(4), c4],
        [EPIC, root],
      ] as const)
        await h.release(key, r.done);
      const other = await h.run(EPIC2);
      expect(status(other)).toBe(202);
      await h.release(EPIC2, other.done);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T5 — a tree has its own window of 30 starts per 10 minutes, apart from A0’s; a new epic’s first start is A0’s', async () => {
    let t = 0;
    const h = harness({ now: () => t, maxStartsPerWindow: 2 });
    for (let i = 0; i < 30; i++) {
      const r = await h.controller.start({ sessionKey: child(1 + (i % 3)), text: `n${i}`, actorUserId: OWNER });
      expect(status(r), `start ${i}`).toBe(202);
      await r.done;
      t += 1000;
    }
    const over = await h.controller.start({ sessionKey: EPIC, text: 'wake', actorUserId: OWNER });
    expect(status(over)).toBe(429);
    expect((over.body as any).error).toMatch(/this epic/);
    // A0's window is untouched by the tree: ordinary tasks still start (2 per window here).
    for (const key of [PLAIN, PLAIN2]) {
      const r = await h.controller.start({ sessionKey: key, text: 'go', actorUserId: OWNER });
      expect(status(r)).toBe(202);
      await r.done;
    }
    // The launcher's first start of a new epic counts against A0's window, which is now full.
    const fresh = await h.controller.start({ sessionKey: EPIC2, text: 'go', actorUserId: OWNER, newTask: true });
    expect(status(fresh)).toBe(429);
    expect((fresh.body as any).error).toMatch(/dashboard task starts/);
    // Ten minutes later both windows are open again.
    t += 10 * 60_000;
    const later = await h.controller.start({ sessionKey: EPIC, text: 'wake', actorUserId: OWNER });
    expect(status(later)).toBe(202);
    await later.done;
  });

  it('T6 — over the cost limit a host start is refused; the owner’s own instruction runs', async () => {
    let spent = 50;
    const treeCostUsd = vi.fn(() => spent);
    const h = harness({ treeCostUsd, epicCostLimitUsd: () => 50 });
    const host = { initiator: 'host' as const };
    for (const key of [child(1), EPIC]) {
      const r = await h.controller.start({ sessionKey: key, text: 'go', actorUserId: OWNER, ...host });
      expect(status(r), key).toBe(429);
      expect((r.body as any).error).toMatch(/cost limit/);
    }
    expect(treeCostUsd).toHaveBeenCalledWith(EPIC);
    // The owner's instruction (the default initiator) is not capped.
    const owner = await h.controller.start({ sessionKey: child(1), text: 'go', actorUserId: OWNER });
    expect(status(owner)).toBe(202);
    await owner.done;
    // Under the limit, the host starts again.
    spent = 49.99;
    const r = await h.controller.start({ sessionKey: child(1), text: 'go', actorUserId: OWNER, ...host });
    expect(status(r)).toBe(202);
    await r.done;
    // An ordinary task is never priced as a tree.
    treeCostUsd.mockClear();
    spent = 1e9;
    const plain = await h.controller.start({ sessionKey: PLAIN, text: 'go', actorUserId: OWNER, ...host });
    expect(status(plain)).toBe(202);
    await plain.done;
    expect(treeCostUsd).not.toHaveBeenCalled();
  });

  it('T7 — shutting down, every start is 503: root, child, and the dry run', async () => {
    const h = harness();
    h.controller.stopAccepting();
    expect(status(await h.run(EPIC))).toBe(503);
    expect(status(await h.run(child(1)))).toBe(503);
    expect(h.controller.canStart(OWNER, 'go', { role: 'child', root: EPIC })?.status).toBe(503);
  });

  it('T8 — canStart takes the tree: the same admission as a start, counting nothing', async () => {
    const h = harness({ treeCostUsd: () => 100, epicCostLimitUsd: () => 50 });
    expect(h.controller.canStart(OWNER, 'go', { role: 'child', root: EPIC })).toBeNull();
    // A host start over the limit is refused before anything is made.
    expect(h.controller.canStart(OWNER, 'go', { role: 'child', root: EPIC, initiator: 'host' })?.status).toBe(429);
    const root = await h.run(EPIC);
    // A new epic (no root yet) while another tree runs: 429; a child of the running tree: allowed.
    expect(h.controller.canStart(OWNER, 'go', { role: 'root' })?.status).toBe(429);
    expect(h.controller.canStart(OWNER, 'go', { role: 'child', root: EPIC })).toBeNull();
    // An ordinary task's dry run is A0's, and the tree does not hold it.
    expect(h.controller.canStart(OWNER, 'go')).toBeNull();
    // Dry runs used nothing: three children still start.
    const kids = [];
    for (let n = 1; n <= 3; n++) {
      const r = await h.run(child(n));
      expect(status(r)).toBe(202);
      kids.push(r);
    }
    expect(h.controller.canStart(OWNER, 'go', { role: 'child', root: EPIC })?.status).toBe(429);
    for (let n = 1; n <= 3; n++) await h.release(child(n), kids[n - 1].done);
    await h.release(EPIC, root.done);
  });

  it('T9 — a tree start answered 500 does not use up the tree’s window, and holds no slot', async () => {
    const h = harness({ maxTreeStartsPerWindow: 1 });
    for (let i = 0; i < 3; i++) {
      h.runTaskTurn.mockImplementationOnce(async () => {
        throw new Error('ENOSPC');
      });
      const r = await h.controller.start({ sessionKey: child(1), text: 'go', actorUserId: OWNER });
      expect(status(r)).toBe(500);
    }
    // No slot is left behind: another tree may start, and this tree's one window start is unused.
    const other = await h.controller.start({ sessionKey: EPIC2, text: 'go', actorUserId: OWNER });
    expect(status(other)).toBe(202);
    await other.done;
    const ok = await h.controller.start({ sessionKey: child(1), text: 'go', actorUserId: OWNER });
    expect(status(ok)).toBe(202);
    await ok.done;
  });
});
