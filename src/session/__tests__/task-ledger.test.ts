/**
 * SSOT 2026-10-22 T7/T8 — the per-session task ledger behind the dashboard's
 * task list: every task gets an id of its own (T1, T2, …) that never changes
 * and is never reused, completed tasks keep their elapsed time and the number
 * of tool calls made while they ran, and none of it is lost when TodoWrite
 * replaces the list or the in-memory todo list is cleared.
 */

import { describe, expect, it } from 'vitest';
import {
  applyTodoList,
  closeTaskList,
  currentTask,
  ledgerTasks,
  recordToolCall,
  sanitizeTaskLedger,
  stampWorkLogTask,
  TASK_LEDGER_MAX,
  type TaskLedger,
} from '../task-ledger';

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string };
const todo = (content: string, status: Todo['status'] = 'pending', activeForm?: string): Todo => ({
  content,
  status,
  ...(activeForm ? { activeForm } : {}),
});

describe('task ids (T8)', () => {
  it('gives every task its own id in first-seen order', () => {
    const l = applyTodoList(undefined, [todo('A'), todo('B'), todo('C')], 1000);
    expect(ledgerTasks(l).current.map((t) => [t.id, t.content])).toEqual([
      ['T1', 'A'],
      ['T2', 'B'],
      ['T3', 'C'],
    ]);
  });

  it('keeps the id of a task across updates and reorders', () => {
    let l = applyTodoList(undefined, [todo('A'), todo('B')], 1000);
    l = applyTodoList(l, [todo('B', 'in_progress'), todo('A', 'completed')], 2000);
    expect(ledgerTasks(l).current.map((t) => [t.id, t.content, t.status])).toEqual([
      ['T2', 'B', 'in_progress'],
      ['T1', 'A', 'completed'],
    ]);
  });

  it('two tasks with the same text are still two tasks with two ids', () => {
    const l = applyTodoList(undefined, [todo('Run tests'), todo('Run tests')], 1000);
    expect(ledgerTasks(l).current.map((t) => t.id)).toEqual(['T1', 'T2']);
  });

  it('never reuses an id — a task that comes back after it was dropped is a new task', () => {
    let l = applyTodoList(undefined, [todo('A')], 1000);
    l = applyTodoList(l, [todo('B')], 2000);
    l = applyTodoList(l, [todo('A')], 3000);
    expect(ledgerTasks(l).current.map((t) => t.id)).toEqual(['T3']);
  });
});

describe('elapsed time and tool calls of a task (T7)', () => {
  it('stamps start on in_progress and end on completed, from the ledger clock', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress')], 1000);
    l = applyTodoList(l, [todo('A', 'completed')], 61_000);
    const [a] = ledgerTasks(l).current;
    expect(a).toMatchObject({ id: 'T1', status: 'completed', startedAt: 1000, completedAt: 61_000 });
  });

  it('counts tool calls on the task in progress only', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress'), todo('B')], 1000);
    expect(recordToolCall(l)?.id).toBe('T1');
    recordToolCall(l);
    l = applyTodoList(l, [todo('A', 'completed'), todo('B', 'in_progress')], 2000);
    recordToolCall(l);
    const [a, b] = ledgerTasks(l).current;
    expect([a.toolCalls, b.toolCalls]).toEqual([2, 1]);
  });

  it('with no task in progress a tool call is not counted', () => {
    const l = applyTodoList(undefined, [todo('A')], 1000);
    expect(recordToolCall(l)).toBeUndefined();
    expect(ledgerTasks(l).current[0].toolCalls).toBe(0);
  });

  it('keeps a completed task, its time and tool calls when TodoWrite replaces the list', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress')], 1000);
    recordToolCall(l);
    recordToolCall(l);
    l = applyTodoList(l, [todo('A', 'completed')], 5000);
    l = applyTodoList(l, [todo('X', 'in_progress')], 6000);
    const view = ledgerTasks(l);
    expect(view.current.map((t) => t.id)).toEqual(['T2']);
    expect(view.earlier).toEqual([
      expect.objectContaining({
        id: 'T1',
        content: 'A',
        status: 'completed',
        startedAt: 1000,
        completedAt: 5000,
        toolCalls: 2,
      }),
    ]);
  });

  it('a re-sent list after the todo list was wiped keeps the original times (no reset to now)', () => {
    let l = applyTodoList(undefined, [todo('A', 'in_progress'), todo('B')], 1000);
    l = applyTodoList(l, [todo('A', 'completed'), todo('B', 'in_progress')], 2000);
    // TodoManager forgot the list (5-min cleanup); the next TodoWrite re-sends everything.
    l = applyTodoList(l, [todo('A', 'completed'), todo('B', 'completed')], 9000);
    const [a, b] = ledgerTasks(l).current;
    expect(a).toMatchObject({ startedAt: 1000, completedAt: 2000 });
    expect(b).toMatchObject({ startedAt: 2000, completedAt: 9000 });
  });

  it('times come from the ledger clock only — a todo list’s own stamps are ignored (review P2: equal titles share them)', () => {
    let l = applyTodoList(undefined, [{ content: 'A', status: 'in_progress', startedAt: 100 } as any], 5000);
    expect(ledgerTasks(l).current[0]).toMatchObject({ startedAt: 5000 });
    l = applyTodoList(l, [{ content: 'A', status: 'completed', startedAt: 4000, completedAt: 4500 } as any], 6000);
    expect(ledgerTasks(l).current[0]).toMatchObject({ startedAt: 5000, completedAt: 6000 });
  });

  it('a task that jumps straight to completed starts and ends at the same moment', () => {
    const l = applyTodoList(undefined, [todo('A', 'completed')], 1000);
    expect(ledgerTasks(l).current[0]).toMatchObject({ startedAt: 1000, completedAt: 1000 });
  });

  it('back to pending clears the times; reopening clears the end', () => {
    // Reopening happens within a list still under way (B runs). A list whose
    // every task completed is over: the same text afterwards is a new run
    // (task-usage-reconcile.test.ts, live 2026-10-29).
    let l = applyTodoList(undefined, [todo('A', 'completed'), todo('B', 'in_progress')], 1000);
    l = applyTodoList(l, [todo('A', 'in_progress'), todo('B', 'in_progress')], 2000);
    expect(ledgerTasks(l).current[0]).toMatchObject({ id: 'T1', startedAt: 1000 });
    expect(ledgerTasks(l).current[0].completedAt).toBeUndefined();
    l = applyTodoList(l, [todo('A', 'pending'), todo('B', 'in_progress')], 3000);
    expect(ledgerTasks(l).current[0].startedAt).toBeUndefined();
  });

  it('the current task is the first one in progress in list order, with its activeForm', () => {
    const l = applyTodoList(undefined, [todo('A', 'completed'), todo('B', 'in_progress', 'Doing B'), todo('C')], 1);
    expect(currentTask(l)).toMatchObject({ id: 'T2', content: 'B', activeForm: 'Doing B' });
    expect(currentTask(undefined)).toBeUndefined();
  });
});

describe('ledger bounds and persistence', () => {
  it('keeps at most TASK_LEDGER_MAX tasks, dropping the oldest that are not in the list', () => {
    let l: TaskLedger | undefined;
    for (let i = 0; i < TASK_LEDGER_MAX + 30; i++) l = applyTodoList(l, [todo(`t${i}`, 'completed')], i + 1);
    const view = ledgerTasks(l!);
    expect(view.current.length + view.earlier.length).toBe(TASK_LEDGER_MAX);
    expect(view.current[0].content).toBe(`t${TASK_LEDGER_MAX + 29}`);
    // Ids keep counting up — nothing is renumbered.
    expect(view.current[0].id).toBe(`T${TASK_LEDGER_MAX + 30}`);
  });

  it('a persisted next number below an existing id is raised, so no id is ever minted twice (review P3)', () => {
    const l = sanitizeTaskLedger({
      nextSeq: 2,
      current: ['T7'],
      tasks: [{ id: 'T7', content: 'old', status: 'completed', toolCalls: 5 }],
    });
    expect(l?.nextSeq).toBe(8);
    const next = applyTodoList(l, [todo('old', 'completed'), todo('new')], 1);
    expect(ledgerTasks(next).current.map((t) => t.id)).toEqual(['T7', 'T8']);
  });

  it('a restored ledger over the bound keeps the tasks of the current list (review P2)', () => {
    const tasks = Array.from({ length: TASK_LEDGER_MAX + 1 }, (_, i) => ({
      id: `T${i + 1}`,
      content: `t${i + 1}`,
      status: i === 0 ? 'in_progress' : 'completed',
      toolCalls: 0,
    }));
    const l = sanitizeTaskLedger({ nextSeq: TASK_LEDGER_MAX + 2, current: ['T1'], tasks });
    expect(l?.tasks).toHaveLength(TASK_LEDGER_MAX);
    expect(currentTask(l)?.id).toBe('T1');
  });

  it('closing the list (new / renew) keeps the history but no task is in progress any more (review P2)', () => {
    const l = applyTodoList(undefined, [todo('A', 'in_progress')], 1);
    const closed = closeTaskList(l, 2);
    expect(currentTask(closed)).toBeUndefined();
    expect(ledgerTasks(closed!).earlier.map((t) => t.id)).toEqual(['T1']);
    expect(closeTaskList(undefined, 2)).toBeUndefined();
  });

  it('sanitizes a persisted ledger: unknown shapes are dropped, numbers stay numbers', () => {
    expect(sanitizeTaskLedger(null)).toBeUndefined();
    expect(sanitizeTaskLedger({ nextSeq: 'x' })).toBeUndefined();
    const l = sanitizeTaskLedger({
      nextSeq: 4,
      current: ['T3', 'T9'],
      tasks: [
        { id: 'T1', content: 'A', status: 'completed', startedAt: 1, completedAt: 2, toolCalls: 3 },
        { id: 'T2', content: 5, status: 'completed' },
        { id: 'T3', content: '<b>C</b>', status: 'bogus', toolCalls: 'many' },
      ],
    });
    expect(l).toEqual({
      nextSeq: 4,
      current: ['T3'],
      tasks: [
        // #488: a ledger saved before firstStartedAt existed reads its first start from startedAt.
        { id: 'T1', content: 'A', status: 'completed', startedAt: 1, firstStartedAt: 1, completedAt: 2, toolCalls: 3 },
        { id: 'T3', content: '<b>C</b>', status: 'pending', toolCalls: 0 },
      ],
    });
  });
});

describe('work-log entries carry the task they were made in (T10) and count its tool calls (T7)', () => {
  it('stamps work entries with the task in progress; a tool entry also counts as a tool call', () => {
    const l = applyTodoList(undefined, [todo('Write the parser', 'in_progress')], 1);
    expect(stampWorkLogTask(l, { kind: 'narration', text: 'thinking' })).toEqual({
      kind: 'narration',
      text: 'thinking',
      taskId: 'T1',
      taskTitle: 'Write the parser',
    });
    expect(stampWorkLogTask(l, { kind: 'tool', text: 'Read x' })).toMatchObject({ taskId: 'T1' });
    expect(stampWorkLogTask(l, { kind: 'tool_result', text: 'Read ok' })).toMatchObject({ taskId: 'T1' });
    expect(ledgerTasks(l).current[0].toolCalls).toBe(1);
  });

  it('instructions and final answers frame the turn — they stay outside any task', () => {
    const l = applyTodoList(undefined, [todo('A', 'in_progress')], 1);
    expect(stampWorkLogTask(l, { kind: 'instruction', text: 'do it' })).toEqual({ kind: 'instruction', text: 'do it' });
    expect(stampWorkLogTask(l, { kind: 'final', text: 'done' })).toEqual({ kind: 'final', text: 'done' });
  });

  it('without a task in progress (or a ledger) the entry is left as it is', () => {
    expect(stampWorkLogTask(undefined, { kind: 'tool', text: 'x' })).toEqual({ kind: 'tool', text: 'x' });
    const l = applyTodoList(undefined, [todo('A')], 1);
    expect(stampWorkLogTask(l, { kind: 'tool', text: 'x' })).toEqual({ kind: 'tool', text: 'x' });
  });

  it('caps the stamped title at 200 characters', () => {
    const l = applyTodoList(undefined, [todo('x'.repeat(500), 'in_progress')], 1);
    expect(stampWorkLogTask(l, { kind: 'tool', text: 't' }).taskTitle).toHaveLength(200);
  });
});
