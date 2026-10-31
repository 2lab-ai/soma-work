/**
 * E4 ② — the epic's plan tree and event queue: schema, write rules, node
 * status and done (.prd/19 D2 · D5 · D6 · D10 a). Pure functions; the
 * registry stores what they return.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPlanWrite,
  EPIC_EVENTS_MAX,
  EPIC_RETIRED_MAX,
  EpicPlanError,
  epicNodeStatus,
  isEpicDone,
  resolveEpicApprovals,
  sanitizeEpicEvents,
  sanitizeEpicPlan,
  withEpicEvent,
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
    // The removed id is retired: it never names another node, in this write or any later one.
    expect(kept.retired).toEqual(['b']);
    expect(code(() => applyPlanWrite(kept, { nodes: [issue('a'), issue('b')] }, ctx()))).toBe('id-reused');
    const later = applyPlanWrite(kept, { nodes: [issue('a'), issue('c')] }, ctx());
    expect(later.retired).toEqual(['b']);
    expect(code(() => applyPlanWrite(later, { nodes: [issue('a'), sub('b', 'a')] }, ctx()))).toBe('id-reused');
    // `retired` is the host's: a writer cannot clear it.
    expect(applyPlanWrite(later, { nodes: [issue('a'), issue('c')], retired: [] } as any, ctx()).retired).toEqual([
      'b',
    ]);
    // At most EPIC_RETIRED_MAX ids are remembered: past that, removing a node is refused.
    const full = {
      nodes: [issue('a'), issue('z')],
      retired: Array.from({ length: EPIC_RETIRED_MAX }, (_, i) => `r${i}`),
    };
    expect(code(() => applyPlanWrite(full, { nodes: [issue('a')] }, ctx()))).toBe('too-many-retired');
    expect(applyPlanWrite(full, { nodes: [issue('a'), issue('z')] }, ctx()).retired).toHaveLength(EPIC_RETIRED_MAX);
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

  it('a running child: an open approval of its current chain makes it needs-input, otherwise running', () => {
    const running = child({ activityState: 'working', openChain: 'ch1' });
    expect(epicNodeStatus(node, [running], [])).toBe('running');
    const open = {
      id: 'e1',
      childTaskId: 'c1',
      planNodeId: 'a',
      outcome: 'needs-input',
      approvalId: 'p1',
      chainId: 'ch1',
      at: 1,
      state: 'pending',
    };
    expect(epicNodeStatus(node, [running], [open as any])).toBe('needs-input');
    expect(epicNodeStatus(node, [running], [{ ...open, resolvedAt: 2 } as any])).toBe('running');
    // An approval an earlier chain left open (a crash) is not this run's; nor one with no chain.
    expect(epicNodeStatus(node, [running], [{ ...open, chainId: 'ch0' } as any])).toBe('running');
    expect(epicNodeStatus(node, [running], [{ ...open, chainId: undefined } as any])).toBe('running');
    // Another child's approval does not count.
    expect(epicNodeStatus(node, [running], [{ ...open, childTaskId: 'c9' } as any])).toBe('running');
  });

  it('a child that is not running: its last chain result decides', () => {
    expect(epicNodeStatus(node, [child(outcome('completed'))], [])).toBe('finished');
    expect(epicNodeStatus(node, [child(outcome('failed'))], [])).toBe('failed');
    expect(epicNodeStatus(node, [child(outcome('cancelled'))], [])).toBe('cancelled');
    expect(epicNodeStatus(node, [child(outcome('waiting'))], [])).toBe('needs-input');
    expect(epicNodeStatus(node, [child(outcome('interrupted'))], [])).toBe('interrupted');
    // Made, not started yet: nothing to report.
    expect(epicNodeStatus(node, [child()], [])).toBe('none');
    // D6: when the child is not running, its chain result decides (its chain's end closed any approval).
    const stale = {
      id: 'e9',
      childTaskId: 'c1',
      planNodeId: 'a',
      outcome: 'needs-input',
      approvalId: 'p',
      at: 1,
      state: 'pending',
    };
    expect(epicNodeStatus(node, [child(outcome('completed'))], [stale as any])).toBe('finished');
  });

  it('several live children for one node: the running one speaks, then a waiting one, then the newest', () => {
    const idle = child({ taskId: 'c2' });
    expect(epicNodeStatus(node, [child({ activityState: 'working' }), idle], [])).toBe('running');
    expect(epicNodeStatus(node, [child({ activityState: 'waiting', ...outcome('waiting') }), idle], [])).toBe(
      'needs-input',
    );
    expect(epicNodeStatus(node, [child(outcome('failed')), child({ taskId: 'c2', ...outcome('completed') })], [])).toBe(
      'finished',
    );
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
    // Load keeps what a write would accept (one node check): over 50 nodes, an over-long title or
    // body, an issue with a parent are dropped — and a dropped node's id is retired, never reused.
    const loaded = sanitizeEpicPlan({
      nodes: [
        { ...issue('long-title'), title: 'x'.repeat(201) },
        issue('long-body', { body: 'y'.repeat(2001) }),
        issue('has-parent', { parent: 'x' }),
        ...Array.from({ length: 50 }, (_, i) => issue(`n${i}`)),
      ],
    })!;
    expect(loaded.nodes.map((n) => n.id)).toEqual(Array.from({ length: 47 }, (_, i) => `n${i}`));
    expect(loaded.retired).toEqual(['long-title', 'long-body', 'has-parent']);
    expect(code(() => applyPlanWrite(loaded, { nodes: [...loaded.nodes, issue('long-body')] as any }, ctx()))).toBe(
      'id-reused',
    );
    // A blank title is no title, on load as on write.
    expect(sanitizeEpicPlan({ nodes: [{ ...issue('a'), title: '   ' }, issue('b')] })?.nodes.map((n) => n.id)).toEqual([
      'b',
    ]);
    // Retired ids: slugs only, de-duplicated, never one a node still uses.
    expect(sanitizeEpicPlan({ nodes: [issue('a')], retired: ['b', 'b', 'Bad Id', 7, 'a'] })?.retired).toEqual(['b']);
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
    // Every field a later step relies on survives a reload (⑥ reverts `consumedBy`, ⑤ closes by `approvalId`).
    const full = ev(7, {
      chainId: 'ch',
      turnId: 'tu',
      approvalId: 'ap',
      consumedBy: 'pc',
      resolvedAt: 9,
      outcome: 'needs-input',
      state: 'delivered',
    });
    expect(sanitizeEpicEvents([full])).toEqual([full]);
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
    // More children than the cap, one pending event each: still at most EPIC_EVENTS_MAX, the oldest gone.
    const crowded = sanitizeEpicEvents(
      Array.from({ length: EPIC_EVENTS_MAX + 1 }, (_, i) => ({ ...ev(i), childTaskId: `kid${i}` })),
    )!;
    expect(crowded).toHaveLength(EPIC_EVENTS_MAX);
    expect(crowded.some((e) => e.id === 'e0')).toBe(false);
  });
});

describe('withEpicEvent / resolveEpicApprovals (E4 ⑤, D6)', () => {
  const ev = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, childTaskId: 'c1', planNodeId: 'n', outcome: 'completed', at: 1, state: 'pending', ...extra }) as any;

  it('adds an event once (same id is the same event) and holds the cap', () => {
    const one = withEpicEvent(undefined, ev('a'));
    expect(one.map((e) => e.id)).toEqual(['a']);
    expect(withEpicEvent(one, ev('a', { at: 9 }))).toBe(one);
    const full = Array.from({ length: EPIC_EVENTS_MAX }, (_, i) => ev(`d${i}`, { state: 'delivered', at: i }));
    const next = withEpicEvent(full, ev('new', { at: 1_000 }));
    expect(next).toHaveLength(EPIC_EVENTS_MAX);
    expect(next.some((e) => e.id === 'new')).toBe(true);
    expect(next.some((e) => e.id === 'd0')).toBe(false);
  });

  it('closes only the open approvals it matches; unchanged events are the same array', () => {
    const events = [
      ev('ap1', { outcome: 'needs-input', approvalId: 'ap1', chainId: 'x' }),
      ev('ap2', { outcome: 'needs-input', approvalId: 'ap2', chainId: 'y' }),
      ev('ap3', { outcome: 'needs-input', approvalId: 'ap3', chainId: 'x', resolvedAt: 5 }),
      ev('end', { chainId: 'x' }),
    ];
    const closed = resolveEpicApprovals(events, (e) => e.chainId === 'x', 7)!;
    expect(closed.map((e) => e.resolvedAt)).toEqual([7, undefined, 5, undefined]);
    expect(resolveEpicApprovals(events, (e) => e.chainId === 'z', 7)).toBe(events);
    expect(resolveEpicApprovals(undefined, () => true, 7)).toBeUndefined();
  });
});
