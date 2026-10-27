/**
 * Tasks a later list dropped (dashboard task view, T2).
 *
 * TodoWrite replaces the whole list. A task the new list no longer holds left
 * the plan: completed (done), started but never completed (중단), or never
 * started (실행 안 됨). The ledger stamps when it left (`removedAt`) and the
 * view says which way it went (`dropped`), so the dashboard never shows a
 * dropped task as running or as waiting to run.
 */

import { describe, expect, it } from 'vitest';
import { applyTodoList, closeTaskList, ledgerTasks, sanitizeTaskLedger } from '../task-ledger';

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' };
const todo = (content: string, status: Todo['status'] = 'pending'): Todo => ({ content, status });

describe('a later list drops tasks (T2)', () => {
  it('marks a task dropped while running as started, one never run as unstarted, with the time it left', () => {
    let l = applyTodoList(undefined, [todo('A', 'completed'), todo('B', 'in_progress'), todo('C'), todo('D')], 1000);
    l = applyTodoList(l, [todo('X', 'in_progress'), todo('Y')], 5000);
    const view = ledgerTasks(l);
    expect(view.current.map((t) => [t.content, t.dropped])).toEqual([
      ['X', undefined],
      ['Y', undefined],
    ]);
    const byContent = Object.fromEntries(view.earlier.map((t) => [t.content, t]));
    expect(byContent.A.dropped).toBeUndefined();
    expect(byContent.A.removedAt).toBe(5000);
    expect(byContent.B.dropped).toBe('started');
    expect(byContent.B.removedAt).toBe(5000);
    expect(byContent.C.dropped).toBe('unstarted');
    expect(byContent.D.dropped).toBe('unstarted');
  });

  it('keeps the first time a task left — a later list does not move it', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress')], 1000);
    l = applyTodoList(l, [todo('B')], 2000);
    l = applyTodoList(l, [todo('C')], 3000);
    const a = ledgerTasks(l).earlier.find((t) => t.content === 'A');
    expect(a?.removedAt).toBe(2000);
    expect(ledgerTasks(l).earlier.find((t) => t.content === 'B')?.removedAt).toBe(3000);
  });

  it('a task carried over to the next list did not leave', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress'), todo('B')], 1000);
    l = applyTodoList(l, [todo('A', 'completed'), todo('B', 'in_progress')], 2000);
    const view = ledgerTasks(l);
    expect(view.earlier).toEqual([]);
    expect(view.current.every((t) => t.removedAt === undefined && t.dropped === undefined)).toBe(true);
  });

  it('a session that starts over (new / renew) closes its list at that time', () => {
    let l = applyTodoList(undefined, [todo('A', 'completed'), todo('B', 'in_progress'), todo('C')], 1000);
    l = closeTaskList(l, 9000)!;
    const view = ledgerTasks(l);
    expect(view.current).toEqual([]);
    expect(view.earlier.map((t) => [t.content, t.dropped, t.removedAt])).toEqual([
      ['C', 'unstarted', 9000],
      ['B', 'started', 9000],
      ['A', undefined, 9000],
    ]);
  });

  it('survives persistence; a ledger saved before removedAt existed still reads its dropped tasks', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress'), todo('B')], 1000);
    l = applyTodoList(l, [todo('C')], 4000);
    const restored = sanitizeTaskLedger(JSON.parse(JSON.stringify(l)))!;
    expect(ledgerTasks(restored).earlier.map((t) => [t.content, t.dropped, t.removedAt])).toEqual([
      ['B', 'unstarted', 4000],
      ['A', 'started', 4000],
    ]);
    const legacy = sanitizeTaskLedger({
      nextSeq: 4,
      current: ['T3'],
      tasks: [
        { id: 'T1', content: 'old running', status: 'in_progress', startedAt: 1000, toolCalls: 2 },
        { id: 'T2', content: 'old waiting', status: 'pending', toolCalls: 0 },
        { id: 'T3', content: 'now', status: 'in_progress', startedAt: 3000, toolCalls: 0 },
      ],
    })!;
    expect(ledgerTasks(legacy).earlier.map((t) => [t.id, t.dropped, t.removedAt])).toEqual([
      ['T2', 'unstarted', undefined],
      ['T1', 'started', undefined],
    ]);
  });
});

describe('review r1 (astra P2) — a task that ran and went back to pending', () => {
  it('still reads stopped (started) when a later list drops it: its tool calls prove it ran', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress')], 1000);
    l.tasks[0].toolCalls = 1;
    l = applyTodoList(l, [todo('A', 'pending')], 2000);
    l = applyTodoList(l, [todo('B')], 3000);
    const a = ledgerTasks(l).earlier.find((t) => t.content === 'A');
    expect(a?.startedAt).toBeUndefined();
    expect(a?.dropped).toBe('started');
  });
});
