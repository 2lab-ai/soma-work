/**
 * E4 ⑧ — the board's view of an epic (.prd/19 D11): `epicState`, progress and
 * the plan tree, from the server's records only.
 */
import { describe, expect, it } from 'vitest';
import { epicBoardView } from '../epic-board';

const epic = (extra: Record<string, unknown> = {}) =>
  ({
    taskId: 'e1',
    ownerId: 'U1',
    slackless: true,
    kind: 'epic',
    activityState: 'idle',
    plan: {
      nodes: [
        { id: 'login', title: 'Fix login', kind: 'issue', spawned: ['c1'] },
        { id: 'login-test', title: 'Test it', kind: 'sub', parent: 'login', accepted: { by: 'epic', at: 1 } },
        { id: 'docs', title: 'Docs', kind: 'issue' },
      ],
    },
    ...extra,
  }) as any;
const child = (taskId: string, planNodeId: string, extra: Record<string, unknown> = {}) =>
  ({ taskId, planNodeId, parentTaskId: 'e1', ownerId: 'U1', slackless: true, activityState: 'idle', ...extra }) as any;

describe('epicBoardView (E4 ⑧)', () => {
  it('the plan tree: each node’s status, verdict and live children; progress counts', () => {
    const v = epicBoardView(epic(), [
      child('c1', 'login', { activityState: 'working' }),
      child('c2', 'docs', { lastTurnOutcome: { turnId: 't', outcome: 'failed' } }),
    ]);
    expect(v.nodes).toEqual([
      { id: 'login', title: 'Fix login', kind: 'issue', status: 'running', accepted: false, childTaskIds: ['c1'] },
      {
        id: 'login-test',
        title: 'Test it',
        kind: 'sub',
        parent: 'login',
        status: 'none',
        accepted: true,
        childTaskIds: [],
      },
      { id: 'docs', title: 'Docs', kind: 'issue', status: 'failed', accepted: false, childTaskIds: ['c2'] },
    ]);
    expect(v.progress).toEqual({ accepted: 1, total: 3, byStatus: { running: 1, none: 1, failed: 1 } });
  });

  it('a child of another epic or another owner is not this epic’s', () => {
    const v = epicBoardView(epic(), [
      child('x1', 'docs', { parentTaskId: 'e2', activityState: 'working' }),
      child('x2', 'docs', { ownerId: 'U9', activityState: 'working' }),
    ]);
    expect(v.nodes.find((n) => n.id === 'docs')).toMatchObject({ status: 'none', childTaskIds: [] });
    expect(v.state).toBe('idle');
  });

  it.each([
    ['a child works', [child('c1', 'login', { activityState: 'working' })], {}, 'running'],
    ['the epic works', [], { activityState: 'working' }, 'running'],
    ['a child waits on a question', [child('c1', 'login', { activityState: 'waiting' })], {}, 'needs-input'],
    ['the epic waits on its owner', [], { activityState: 'waiting' }, 'needs-input'],
    [
      'a running child’s approval is open — owner attention wins over running',
      [child('c1', 'login', { activityState: 'working', openChain: 'ch' })],
      {
        epicEvents: [
          {
            id: 'c1:ap',
            childTaskId: 'c1',
            planNodeId: 'login',
            outcome: 'needs-input',
            approvalId: 'ap',
            chainId: 'ch',
            at: 1,
            state: 'pending',
          },
        ],
      },
      'needs-input',
    ],
    [
      'nothing holds, plan done',
      [],
      { plan: { nodes: [{ id: 'a', title: 'A', kind: 'issue' }], done: { by: 'epic', at: 1 } } },
      'done',
    ],
    ['nothing holds, plan not done', [], {}, 'idle'],
    ['no plan yet', [], { plan: undefined }, 'idle'],
  ])('epicState: %s', (_name, children, extra, state) => {
    expect(epicBoardView(epic(extra), children as any).state).toBe(state);
  });

  it('a child’s activity is what the board shows for it: a permission prompt waits, an armed resume works (R1)', () => {
    const working = child('c1', 'login', { activityState: 'working' });
    const idle = child('c2', 'docs');
    expect(epicBoardView(epic(), [working], { activityOf: () => 'waiting' }).state).toBe('needs-input');
    expect(epicBoardView(epic(), [idle]).state).toBe('idle');
    expect(epicBoardView(epic(), [idle], { activityOf: () => 'working' }).state).toBe('running');
    // Absent from the lookup: the record's own.
    expect(epicBoardView(epic(), [working], { activityOf: () => undefined }).state).toBe('running');
  });

  it('a running node whose child the board shows waiting is needs-input, like the epic (fable #704 R2 P3-1)', () => {
    const working = child('c1', 'login', { activityState: 'working' });
    const other = child('c2', 'docs', { activityState: 'working' });
    const shown = (c: any) => (c.taskId === 'c1' ? 'waiting' : undefined);
    const v = epicBoardView(epic(), [working, other], { activityOf: shown });
    expect(v.state).toBe('needs-input');
    expect(v.nodes.map((n) => [n.id, n.status])).toEqual([
      ['login', 'needs-input'],
      ['login-test', 'none'],
      ['docs', 'running'],
    ]);
    expect(v.progress.byStatus).toEqual({ 'needs-input': 1, none: 1, running: 1 });
    // Shown working (an armed resume) does not make an idle node running.
    const idle = child('c3', 'docs');
    expect(epicBoardView(epic(), [idle], { activityOf: () => 'working' }).nodes[2].status).not.toBe('running');
    // Only a running node changes: a finished node keeps its chain's result whatever the board shows.
    const done = child('c4', 'docs', { lastTurnOutcome: { turnId: 't1', outcome: 'completed', at: 1 } });
    expect(epicBoardView(epic(), [done], { activityOf: () => 'waiting' }).nodes[2].status).toBe('finished');
  });

  it('a running child outranks done', () => {
    const done = { plan: { nodes: [{ id: 'login', title: 'L', kind: 'issue' }], done: { by: 'epic', at: 1 } } };
    expect(epicBoardView(epic(done), [child('c1', 'login', { activityState: 'working' })]).state).toBe('running');
  });

  it('no plan: no nodes, zero progress', () => {
    expect(epicBoardView(epic({ plan: undefined }), [])).toEqual({
      state: 'idle',
      progress: { accepted: 0, total: 0, byStatus: {} },
      nodes: [],
    });
  });
});
