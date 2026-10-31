/**
 * E4 ② — the epic's plan tree and event queue: schema, write rules, node
 * status and done (.prd/19 D2 · D5 · D6 · D10 a). Pure functions; the
 * registry stores what they return.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPlanWrite,
  EPIC_EVENTS_MAX,
  EpicPlanError,
  epicNodeStatus,
  isEpicDone,
  sanitizeEpicEvents,
  sanitizeEpicPlan,
} from '../epic-plan';

const NOW = 1_800_000_000_000;
const issue = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `T ${id}`,
  kind: 'issue' as const,
  ...extra,
});
const sub = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `T ${id}`,
  kind: 'sub' as const,
  parent,
  ...extra,
});
const ctx = (extra: Record<string, unknown> = {}) => ({ now: NOW, by: 'epic' as const, children: [], ...extra });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof EpicPlanError ? e.code : `not EpicPlanError: ${(e as Error).message}`;
  }
  return 'no throw';
};

describe('applyPlanWrite (D2)', () => {
  it('a first write makes the plan; issues have no parent, subs hang under an issue', () => {
    const plan = applyPlanWrite(
      undefined,
      { nodes: [issue('a'), sub('a-1', 'a'), issue('b', { body: 'why' })] },
      ctx(),
    );
    expect(plan.nodes.map((n) => [n.id, n.kind, n.parent])).toEqual([
      ['a', 'issue', undefined],
      ['a-1', 'sub', 'a'],
      ['b', 'issue', undefined],
    ]);
    expect(plan.nodes[2].body).toBe('why');
  });

  it('refuses malformed writes with a code, leaving nothing changed', () => {
    const long = 'x'.repeat(201);
    const cases: Array<[string, unknown]> = [
      ['too-many-nodes', { nodes: Array.from({ length: 51 }, (_, i) => issue(`n${i}`)) }],
      ['bad-id', { nodes: [issue('Bad Id')] }],
      ['duplicate-id', { nodes: [issue('a'), issue('a')] }],
      ['bad-title', { nodes: [{ ...issue('a'), title: long }] }],
      ['bad-title', { nodes: [{ ...issue('a'), title: '' }] }],
      ['bad-title', { nodes: [{ ...issue('a'), title: '   ' }] }],
      ['bad-body', { nodes: [issue('a', { body: 'y'.repeat(2001) })] }],
      ['bad-kind', { nodes: [{ id: 'a', title: 'A', kind: 'epic' }] }],
      ['bad-parent', { nodes: [issue('a', { parent: 'b' }), issue('b')] }],
      ['bad-parent', { nodes: [sub('s', 'nope')] }],
      ['bad-parent', { nodes: [issue('a'), sub('s', 'a'), sub('t', 's')] }],
      ['bad-input', { nodes: 'a' }],
    ];
    for (const [want, input] of cases)
      expect(
        code(() => applyPlanWrite(undefined, input as any, ctx())),
        want,
      ).toBe(want);
  });

  it('a node a child was made for cannot be removed; one without children can', () => {
    const current = applyPlanWrite(undefined, { nodes: [issue('a'), issue('b')] }, ctx());
    current.nodes[0].spawned = ['t1'];
    expect(code(() => applyPlanWrite(current, { nodes: [issue('b')] }, ctx()))).toBe('node-has-children');
    // A live child counts even before `spawned` is written.
    expect(
      code(() =>
        applyPlanWrite(current, { nodes: [issue('a')] }, ctx({ children: [{ planNodeId: 'b', active: false }] })),
      ),
    ).toBe('node-has-children');
    const kept = applyPlanWrite(current, { nodes: [issue('a')] }, ctx());
    expect(kept.nodes.map((n) => n.id)).toEqual(['a']);
    expect(kept.nodes[0].spawned).toEqual(['t1']);
  });

  it('accepted: true sets it (by and when), omitted keeps it, false clears it; spawned is not writable', () => {
    const first = applyPlanWrite(undefined, { nodes: [issue('a', { accepted: true, spawned: ['forged'] })] }, ctx());
    expect(first.nodes[0].accepted).toEqual({ by: 'epic', at: NOW });
    expect(first.nodes[0].spawned).toBeUndefined();
    const kept = applyPlanWrite(first, { nodes: [{ ...issue('a'), title: 'renamed' }] }, ctx({ now: NOW + 5 }));
    expect(kept.nodes[0]).toMatchObject({ title: 'renamed', accepted: { by: 'epic', at: NOW } });
    // Set again (by someone else, later): the first verdict stands.
    const again = applyPlanWrite(kept, { nodes: [issue('a', { accepted: true })] }, ctx({ now: NOW + 9, by: 'owner' }));
    expect(again.nodes[0].accepted).toEqual({ by: 'epic', at: NOW });
    const cleared = applyPlanWrite(kept, { nodes: [issue('a', { accepted: false })] }, ctx());
    expect(cleared.nodes[0].accepted).toBeUndefined();
  });

  it('done: true is refused while a child runs or waits; false clears it', () => {
    const plan = applyPlanWrite(undefined, { nodes: [issue('a')] }, ctx());
    expect(
      code(() =>
        applyPlanWrite(
          plan,
          { nodes: [issue('a')], done: true },
          ctx({ children: [{ planNodeId: 'a', active: true }] }),
        ),
      ),
    ).toBe('children-running');
    const done = applyPlanWrite(plan, { nodes: [issue('a')], done: true }, ctx());
    expect(done.done).toEqual({ by: 'epic', at: NOW });
    expect(applyPlanWrite(done, { nodes: [issue('a')] }, ctx()).done).toEqual({ by: 'epic', at: NOW });
    // Marked done again: the first mark stands.
    expect(applyPlanWrite(done, { nodes: [issue('a')], done: true }, ctx({ now: NOW + 9, by: 'owner' })).done).toEqual({
      by: 'epic',
      at: NOW,
    });
    expect(applyPlanWrite(done, { nodes: [issue('a')], done: false }, ctx()).done).toBeUndefined();
  });
});

describe('isEpicDone (D10 a)', () => {
  it('all of at least one node accepted, or set explicitly; an empty plan is not done', () => {
    expect(isEpicDone(undefined)).toBe(false);
    expect(isEpicDone({ nodes: [] })).toBe(false);
    expect(isEpicDone({ nodes: [], done: { by: 'epic', at: 1 } })).toBe(true);
    const a = { id: 'a', title: 'A', kind: 'issue' as const, accepted: { by: 'epic' as const, at: 1 } };
    const b = { id: 'b', title: 'B', kind: 'issue' as const };
    expect(isEpicDone({ nodes: [a, b] })).toBe(false);
    expect(isEpicDone({ nodes: [a] })).toBe(true);
  });
});

describe('epicNodeStatus (D5)', () => {
  const node = { id: 'a', title: 'A', kind: 'issue' as const };
  const child = (extra: Record<string, unknown> = {}) =>
    ({ taskId: 'c1', planNodeId: 'a', activityState: 'idle', ...extra }) as any;
  const outcome = (o: string) => ({
    lastTurnOutcome: { turnId: 't', outcome: o, category: 'WorkflowComplete', at: 1 },
  });

  it('no child → none; a child made for it and gone → closed', () => {
    expect(epicNodeStatus(node, [], [])).toBe('none');
    expect(epicNodeStatus({ ...node, spawned: ['c0'] }, [], [])).toBe('closed');
  });

  it('a running child: an open approval makes it needs-input, otherwise running', () => {
    expect(epicNodeStatus(node, [child({ activityState: 'working' })], [])).toBe('running');
    const open = {
      id: 'e1',
      childTaskId: 'c1',
      planNodeId: 'a',
      outcome: 'needs-input',
      approvalId: 'p1',
      at: 1,
      state: 'pending',
    };
    expect(epicNodeStatus(node, [child({ activityState: 'working' })], [open as any])).toBe('needs-input');
    expect(epicNodeStatus(node, [child({ activityState: 'working' })], [{ ...open, resolvedAt: 2 } as any])).toBe(
      'running',
    );
  });

  it('a child that is not running: its last chain result decides', () => {
    expect(epicNodeStatus(node, [child(outcome('completed'))], [])).toBe('finished');
    expect(epicNodeStatus(node, [child(outcome('failed'))], [])).toBe('failed');
    expect(epicNodeStatus(node, [child(outcome('cancelled'))], [])).toBe('cancelled');
    expect(epicNodeStatus(node, [child(outcome('waiting'))], [])).toBe('needs-input');
    expect(epicNodeStatus(node, [child(outcome('interrupted'))], [])).toBe('interrupted');
    // Made, not started yet: nothing to report.
    expect(epicNodeStatus(node, [child()], [])).toBe('none');
  });

  it('only the children of this node count', () => {
    expect(epicNodeStatus(node, [child({ planNodeId: 'b', activityState: 'working' })], [])).toBe('none');
  });
});

describe('sanitizeEpicPlan / sanitizeEpicEvents (load)', () => {
  it('keeps well-formed nodes, drops the rest and orphaned subs', () => {
    const plan = sanitizeEpicPlan({
      nodes: [
        issue('a', { accepted: { by: 'epic', at: 1 }, spawned: ['c1', 'c1', 3] }),
        { id: 'Bad' },
        sub('s', 'a'),
        sub('o', 'gone'),
      ],
      done: { by: 'nobody', at: 1 },
    });
    expect(plan?.nodes.map((n) => n.id)).toEqual(['a', 's']);
    expect(plan?.nodes[0].spawned).toEqual(['c1']);
    expect(plan?.done).toBeUndefined();
    expect(sanitizeEpicPlan('x')).toBeUndefined();
  });

  it('events: well-formed only, at most EPIC_EVENTS_MAX — delivered dropped first, then the oldest of a child', () => {
    const ev = (i: number, extra: Record<string, unknown> = {}) => ({
      id: `e${i}`,
      childTaskId: `c${i % 3}`,
      planNodeId: 'a',
      outcome: 'completed',
      at: i,
      state: 'pending',
      ...extra,
    });
    expect(
      sanitizeEpicEvents([ev(1), { id: 'bad' }, ev(2, { outcome: 'weird' }), ev(3, { state: 'odd' })])?.map(
        (e) => e.id,
      ),
    ).toEqual(['e1']);
    // Delivered events go first, even when they are newer than every pending one.
    const many = [
      ...Array.from({ length: EPIC_EVENTS_MAX }, (_, i) => ev(i)),
      ...Array.from({ length: 10 }, (_, i) => ev(1000 + i, { state: 'delivered' })),
    ];
    const kept = sanitizeEpicEvents(many)!;
    expect(kept).toHaveLength(EPIC_EVENTS_MAX);
    expect(kept.every((e) => e.state === 'pending')).toBe(true);
    // Over the cap with no delivered events: the oldest go first, the newest per child stay.
    const pendingOnly = sanitizeEpicEvents(Array.from({ length: EPIC_EVENTS_MAX + 5 }, (_, i) => ev(i)))!;
    expect(pendingOnly).toHaveLength(EPIC_EVENTS_MAX);
    expect(pendingOnly.some((e) => e.id === `e${EPIC_EVENTS_MAX + 4}`)).toBe(true);
    expect(pendingOnly.some((e) => e.id === 'e0')).toBe(false);
    // A child whose only event is the oldest keeps it: the newest event of every child stays.
    const lonely = { ...ev(0), id: 'lonely', childTaskId: 'lonely' };
    const crowd = Array.from({ length: EPIC_EVENTS_MAX + 5 }, (_, i) => ({ ...ev(i + 1), childTaskId: 'busy' }));
    const fair = sanitizeEpicEvents([lonely, ...crowd])!;
    expect(fair).toHaveLength(EPIC_EVENTS_MAX);
    expect(fair.some((e) => e.id === 'lonely')).toBe(true);
  });
});
