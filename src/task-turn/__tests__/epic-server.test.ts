/**
 * E4 ④a — the epic's host tools (.prd/19 D3 · D8).
 *
 *   S1 the server rides an epic's own task turn only: not a child's, an
 *      ordinary task's, or a Slack turn.
 *   S2 the tools carry no identity: no owner, task id or mode argument; the
 *      epic is the turn's own.
 *   S3 plan_write saves through the host's plan writer as the epic; a refusal
 *      comes back with its code and nothing changed; a save failure says so.
 *   S4 child_status() is the tree: each node's status and verdict, every child
 *      made (a closed one as closed); child_status(id) adds that child's last
 *      final, for a child of this epic only.
 *   S5 every call re-reads the epic: one closed meanwhile, or no host yet, is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real server, but its config is kept so the tools it carries can be read.
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const actual: any = await original();
  return { ...actual, createSdkMcpServer: vi.fn((config: any) => ({ type: 'sdk', name: config.name, config })) };
});
import type { TaskExecutionContext } from '../../agent-runtime/execution-context';
import { applyPlanWrite, EpicPlanError } from '../epic-plan';
import { attachesEpicServer, buildEpicServer, type EpicHost, epicTools, setEpicHost } from '../epic-server';

const EPIC_ID = 'e1';
const ctx = (extra: Record<string, unknown> = {}) =>
  ({
    origin: 'task',
    userId: 'U1',
    isAdmin: false,
    permissionMode: 'legacy',
    sessionKey: `task:${EPIC_ID}`,
    taskId: EPIC_ID,
    workingDirectory: '/tmp/U1/e',
    kind: 'epic',
    ...extra,
  }) as unknown as TaskExecutionContext;

function fakeHost(over: Partial<EpicHost> = {}) {
  const epic: any = { taskId: EPIC_ID, ownerId: 'U1', slackless: true, kind: 'epic', childTaskIds: [] };
  const children: any[] = [];
  const host: EpicHost = {
    getTask: vi.fn((id: string) => (id === EPIC_ID ? epic : children.find((c) => c.taskId === id))),
    getChildTasks: vi.fn((id: string) => (id === EPIC_ID ? children : [])),
    setEpicPlan: vi.fn((_id, input, by) => {
      epic.plan = applyPlanWrite(epic.plan, input, { now: 1, by, children: [] });
      return epic.plan;
    }),
    readChildFinal: vi.fn(async () => ({ text: 'the end of its answer', clipped: true })),
    ...over,
  };
  return { host, epic, children };
}

const tools = () => {
  const [planWrite, childStatus] = epicTools(ctx());
  return { planWrite, childStatus };
};
const parse = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => setEpicHost(undefined));

describe('the epic server (E4 ④a, D3 · D8)', () => {
  it('S1 — rides an epic’s own task turn only', () => {
    expect(attachesEpicServer(ctx())).toBe(true);
    // A child (even one claiming to be an epic), an ordinary task, a Slack turn, no context.
    expect(attachesEpicServer(ctx({ kind: undefined, parentTaskId: EPIC_ID }))).toBe(false);
    expect(attachesEpicServer(ctx({ parentTaskId: EPIC_ID }))).toBe(false);
    expect(attachesEpicServer(ctx({ kind: undefined }))).toBe(false);
    expect(attachesEpicServer(ctx({ origin: 'slack' }))).toBe(false);
    expect(attachesEpicServer(undefined)).toBe(false);
  });

  it('S2 — the tools take no identity: the epic is the turn’s own', async () => {
    const { planWrite, childStatus } = tools();
    expect(planWrite.name).toBe('plan_write');
    expect(childStatus.name).toBe('child_status');
    expect(Object.keys(planWrite.inputSchema).sort()).toEqual(['done', 'nodes']);
    expect(Object.keys(childStatus.inputSchema)).toEqual(['childId']);
    const { host } = fakeHost();
    setEpicHost(host);
    await planWrite.handler({ nodes: [{ id: 'a', title: 'A', kind: 'issue' }] } as any, {});
    expect(host.setEpicPlan).toHaveBeenCalledWith(EPIC_ID, expect.anything(), 'epic');
  });

  it('S3 — plan_write saves as the epic; a refusal comes back with its code; a failed save says so', async () => {
    const { planWrite } = tools();
    const { host, epic } = fakeHost();
    setEpicHost(host);
    const ok = await planWrite.handler(
      { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue', accepted: true }] } as any,
      {},
    );
    expect(ok.isError).toBeUndefined();
    expect(parse(ok)).toMatchObject({
      ok: true,
      done: true,
      plan: { nodes: [{ id: 'login', accepted: { by: 'epic' } }] },
    });
    expect(epic.plan.nodes).toHaveLength(1);

    const bad = await planWrite.handler({ nodes: [{ id: 'Bad Id', title: 'x', kind: 'issue' }] } as any, {});
    expect(bad.isError).toBe(true);
    expect(parse(bad)).toMatchObject({ ok: false, code: 'bad-id' });
    expect(epic.plan.nodes.map((n: any) => n.id)).toEqual(['login']);

    (host.setEpicPlan as any).mockImplementationOnce(() => {
      throw new Error('ENOSPC /secret/path');
    });
    const failed = await planWrite.handler({ nodes: [] } as any, {});
    expect(failed.isError).toBe(true);
    expect(parse(failed)).toMatchObject({ ok: false, code: 'not-saved' });
    // The error text of a failed save does not reach the model.
    expect(JSON.stringify(failed.content)).not.toMatch(/ENOSPC|secret/);
    // An EpicPlanError keeps its own message.
    (host.setEpicPlan as any).mockImplementationOnce(() => {
      throw new EpicPlanError('children-running', 'a child is still running or waiting — done refused');
    });
    expect(parse(await planWrite.handler({ nodes: [], done: true } as any, {}))).toMatchObject({
      code: 'children-running',
    });
  });

  it('S4 — child_status() is the tree; child_status(id) adds that child’s last final, for this epic’s children only', async () => {
    const { childStatus } = tools();
    const { host, epic, children } = fakeHost();
    setEpicHost(host);
    epic.plan = applyPlanWrite(
      undefined,
      {
        nodes: [
          { id: 'login', title: 'Fix login', kind: 'issue', accepted: true },
          { id: 'docs', title: 'Docs', kind: 'issue' },
        ],
      },
      { now: 1, by: 'epic', children: [] },
    );
    epic.plan.nodes[1].spawned = ['c-gone'];
    epic.childTaskIds = ['c1', 'c-gone'];
    children.push({
      taskId: 'c1',
      ownerId: 'U1',
      planNodeId: 'login',
      activityState: 'idle',
      lastTurnOutcome: { turnId: 't', outcome: 'completed', category: 'WorkflowComplete', at: 1, reason: 'secret' },
    });
    const tree = parse(await childStatus.handler({} as any, {}));
    expect(tree).toEqual({
      ok: true,
      done: false,
      nodes: [
        { id: 'login', title: 'Fix login', kind: 'issue', status: 'finished', accepted: { by: 'epic', at: 1 } },
        { id: 'docs', title: 'Docs', kind: 'issue', status: 'closed' },
      ],
      children: [
        { taskId: 'c1', planNodeId: 'login', state: 'idle', outcome: 'completed' },
        { taskId: 'c-gone', closed: true },
      ],
    });
    // The child's own words (its outcome reason) are not passed up in the tree.
    expect(JSON.stringify(tree)).not.toMatch(/secret/);
    // Every node accepted: the tree reads done.
    epic.plan.nodes[1].accepted = { by: 'epic', at: 2 };
    expect(parse(await childStatus.handler({} as any, {})).done).toBe(true);
    epic.plan.nodes[1].accepted = undefined;

    const one = parse(await childStatus.handler({ childId: 'c1' } as any, {}));
    // The final read is the child's own record.
    expect(host.readChildFinal).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'c1' }));
    expect(one).toEqual({
      ok: true,
      child: {
        taskId: 'c1',
        planNodeId: 'login',
        state: 'idle',
        outcome: 'completed',
        final: 'the end of its answer',
        clipped: true,
      },
    });
    expect(parse(await childStatus.handler({ childId: 'c-gone' } as any, {}))).toEqual({
      ok: true,
      child: { taskId: 'c-gone', closed: true },
    });
    const stranger = await childStatus.handler({ childId: 'someone-else' } as any, {});
    expect(stranger.isError).toBe(true);
    expect(parse(stranger)).toMatchObject({ code: 'not-a-child' });
    // A final that cannot be read leaves it out, not the status.
    (host.readChildFinal as any).mockRejectedValueOnce(new Error('disk'));
    expect(parse(await childStatus.handler({ childId: 'c1' } as any, {})).child.final).toBeUndefined();
  });

  it('S4b — a running child with an open approval of its chain reads needs-input; another owner’s “child” does not count', async () => {
    const { childStatus } = tools();
    const { host, epic, children } = fakeHost();
    setEpicHost(host);
    epic.plan = applyPlanWrite(
      undefined,
      { nodes: [{ id: 'login', title: 'Fix login', kind: 'issue' }] },
      {
        now: 1,
        by: 'epic',
        children: [],
      },
    );
    epic.childTaskIds = ['c1', 'cx'];
    children.push({ taskId: 'c1', ownerId: 'U1', planNodeId: 'login', activityState: 'working', openChain: 'ch1' });
    epic.epicEvents = [
      {
        id: 'e1',
        childTaskId: 'c1',
        planNodeId: 'login',
        outcome: 'needs-input',
        approvalId: 'p',
        chainId: 'ch1',
        at: 1,
        state: 'pending',
      },
    ];
    expect(parse(await childStatus.handler({} as any, {})).nodes[0].status).toBe('needs-input');
    // A record under this epic that belongs to someone else is not its live child.
    children.push({ taskId: 'cx', ownerId: 'U2', planNodeId: 'login', activityState: 'working' });
    const tree = parse(await childStatus.handler({} as any, {}));
    expect(tree.children).toContainEqual({ taskId: 'cx', closed: true });
    expect(parse(await childStatus.handler({ childId: 'cx' } as any, {})).child).toEqual({
      taskId: 'cx',
      closed: true,
    });
  });

  it('S6 — the server is `epic` and carries both tools', () => {
    const server: any = buildEpicServer(ctx());
    expect(server.name).toBe('epic');
    expect(server.config.tools.map((t: any) => t.name)).toEqual(['plan_write', 'child_status']);
  });

  it('S5 — every call re-reads the epic: no host yet, or an epic closed meanwhile, is refused', async () => {
    const { planWrite, childStatus } = tools();
    const notReady = await childStatus.handler({} as any, {});
    expect(parse(notReady)).toMatchObject({ code: 'not-ready' });
    const { host, epic } = fakeHost();
    setEpicHost(host);
    epic.terminated = true;
    expect(parse(await planWrite.handler({ nodes: [] } as any, {}))).toMatchObject({ code: 'not-an-epic' });
    expect(host.setEpicPlan).not.toHaveBeenCalled();
    epic.terminated = undefined;
    epic.kind = undefined;
    expect(parse(await childStatus.handler({} as any, {}))).toMatchObject({ code: 'not-an-epic' });
  });
});
