/**
 * #854 — an epic tree's limits on the Slack path (.prd/19 D9 c–e, kept when epics moved to
 * Slack sessions): at most 3 children running at once, at most 30 host starts per 10 minutes
 * in one tree, and no host start once the tree's spend reached its owner's limit.
 *
 *   G1 a child start is refused while 3 other children run; the child itself does not count.
 *   G2 the tree's window: the 31st start in 10 minutes is refused; it frees as the window moves.
 *   G3 the cost cap refuses every host start, a wake included; under it, nothing is refused.
 */
import { describe, expect, it } from 'vitest';
import { createEpicTreeGate } from '../epic-tree-gate';

const epic: any = { taskId: 'e1', ownerId: 'U1', kind: 'epic' };
const kid = (id: string, running: boolean) => ({ taskId: id, parentTaskId: 'e1', ownerId: 'U1', running });

function gate(over: Record<string, unknown> = {}, kids = [kid('c1', true), kid('c2', true), kid('c3', true)]) {
  let t = 1_000_000;
  const g = createEpicTreeGate({
    getChildTasks: () => kids as any,
    isRunning: (s: any) => s.running === true,
    treeCostUsd: () => 10,
    costLimitUsd: () => 50,
    now: () => t,
    ...over,
  });
  return { g, advance: (ms: number) => (t += ms), kids };
}

describe('epic tree gate (#854)', () => {
  it('G5 — starts still being handed over count in the tree’s window too (review #872 R2 astra)', () => {
    const { g } = gate({}, []);
    for (let i = 0; i < 29; i++) g.record(epic);
    expect(g.refusal(epic, { newChild: true })).toBeUndefined();
    expect(g.refusal(epic, { newChild: true, making: 1 })).toMatch(/too many starts/);
    // Starts in flight that take no running place (a working child's queued word) count in the window only.
    const running = kid('c1', true);
    expect(g.refusal(epic, { child: running as any, pending: 1 })).toMatch(/too many starts/);
  });

  it('G4 — children still being made take their places too (review #872: parallel spawn_child)', () => {
    const { g } = gate({}, [kid('c1', true), kid('c2', true)]);
    expect(g.refusal(epic, { newChild: true })).toBeUndefined();
    expect(g.refusal(epic, { newChild: true, making: 1 })).toMatch(/at most 3 children/);
  });

  it('G1 — at most 3 children running at once; the child being instructed does not count against itself', () => {
    const { g, kids } = gate();
    expect(g.refusal(epic, { child: kid('c4', false) as any })).toMatch(/at most 3 children/);
    expect(g.refusal(epic, { newChild: true })).toMatch(/at most 3 children/);
    // The 3rd running child, instructed again: it is already in its place.
    expect(g.refusal(epic, { child: kids[2] as any })).toBeUndefined();
    // A wake is the epic's own turn, not a child's place.
    expect(g.refusal(epic, {})).toBeUndefined();
    const two = gate({}, [kid('c1', true), kid('c2', false)]);
    expect(two.g.refusal(epic, { child: kid('c3', false) as any })).toBeUndefined();
  });

  it('G2 — at most 30 starts per tree in 10 minutes; the window moves on', () => {
    const { g, advance } = gate({}, []);
    for (let i = 0; i < 30; i++) {
      expect(g.refusal(epic, {})).toBeUndefined();
      g.record(epic);
    }
    expect(g.refusal(epic, {})).toMatch(/too many starts in this epic/);
    advance(10 * 60_000 + 1);
    expect(g.refusal(epic, {})).toBeUndefined();
  });

  it('G3 — the cost cap refuses every host start, a wake included', () => {
    const { g } = gate({ treeCostUsd: () => 50 }, []);
    expect(g.refusal(epic, {})).toMatch(/cost limit \(\$50\)/);
    expect(g.refusal(epic, { child: kid('c1', false) as any })).toMatch(/cost limit/);
  });
});
