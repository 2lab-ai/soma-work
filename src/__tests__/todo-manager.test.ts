import { describe, expect, it } from 'vitest';
import { parseTodos, type Todo, TodoManager } from '../todo-manager.js';

// --- parseTodos ---

describe('parseTodos', () => {
  const validTodo: Todo = {
    id: '1',
    content: 'Do stuff',
    status: 'pending',
    priority: 'high',
  };

  it('returns Todo[] for a valid array', () => {
    const result = parseTodos([validTodo]);
    expect(result).toEqual([validTodo]);
  });

  it('returns null for non-array inputs', () => {
    expect(parseTodos(null)).toBeNull();
    expect(parseTodos(undefined)).toBeNull();
    expect(parseTodos('string')).toBeNull();
    expect(parseTodos(42)).toBeNull();
    expect(parseTodos({ todos: [] })).toBeNull();
  });

  it('filters out malformed items from the array', () => {
    const result = parseTodos([
      validTodo,
      null,
      undefined,
      { id: '2', content: 'Missing status', priority: 'low' },
      { id: '3', content: 'Bad status', status: 'unknown', priority: 'high' },
      { id: '4', content: 'Valid too', status: 'completed', priority: 'medium' },
    ]);
    expect(result).toEqual([validTodo, { id: '4', content: 'Valid too', status: 'completed', priority: 'medium' }]);
  });

  it('returns empty array for an empty array input', () => {
    expect(parseTodos([])).toEqual([]);
  });

  it('defaults invalid priority to medium instead of filtering', () => {
    const result = parseTodos([{ id: '1', content: 'Bad priority', status: 'pending', priority: 'critical' }]);
    expect(result).toEqual([{ id: '1', content: 'Bad priority', status: 'pending', priority: 'medium' }]);
  });

  it('preserves optional fields like dependencies and activeForm', () => {
    const todoWithOptionals: Todo = {
      ...validTodo,
      dependencies: ['0'],
      activeForm: 'Doing stuff',
    };
    const result = parseTodos([todoWithOptionals]);
    expect(result).toEqual([todoWithOptionals]);
  });

  it('auto-assigns id and priority when missing (TodoWrite compat)', () => {
    const todoWriteInput = [
      { content: 'Task A', status: 'pending', activeForm: 'Working on A' },
      { content: 'Task B', status: 'in_progress', activeForm: 'Working on B' },
      { content: 'Task C', status: 'completed', activeForm: 'Done with C' },
    ];
    const result = parseTodos(todoWriteInput);
    expect(result).toHaveLength(3);
    // IDs are content-hash based (stable, deterministic)
    expect(result![0].id).toMatch(/^todo-/);
    expect(result![0].content).toBe('Task A');
    expect(result![0].status).toBe('pending');
    expect(result![0].priority).toBe('medium');
    expect(result![1].id).toMatch(/^todo-/);
    expect(result![1].content).toBe('Task B');
    expect(result![1].priority).toBe('medium');
    expect(result![2].id).toMatch(/^todo-/);
    expect(result![2].content).toBe('Task C');
    expect(result![2].priority).toBe('medium');
    // Same content produces same id (stable)
    const result2 = parseTodos(todoWriteInput);
    expect(result2![0].id).toBe(result![0].id);
  });

  it('preserves explicit id and priority when provided', () => {
    const result = parseTodos([{ id: 'custom-id', content: 'Test', status: 'pending', priority: 'high' }]);
    expect(result).toEqual([{ id: 'custom-id', content: 'Test', status: 'pending', priority: 'high' }]);
  });

  it('does not mutate input objects', () => {
    const input = [{ content: 'Task X', status: 'pending', activeForm: 'Working on X' }];
    const originalContent = { ...input[0] };
    parseTodos(input);
    // Input object should remain unchanged (no id/priority stamped onto it)
    expect(input[0]).toEqual(originalContent);
  });
});

// --- TodoManager.updateTodos ---

describe('TodoManager.updateTodos', () => {
  const validTodo: Todo = {
    id: '1',
    content: 'Task 1',
    status: 'pending',
    priority: 'high',
  };

  it('stores valid todos', () => {
    const mgr = new TodoManager();
    mgr.updateTodos('sess-1', [validTodo]);
    expect(mgr.getTodos('sess-1')).toEqual([validTodo]);
  });

  it('rejects non-array input and preserves previous state', () => {
    const mgr = new TodoManager();
    mgr.updateTodos('sess-1', [validTodo]);

    // Pass a non-array — previous state should be preserved
    mgr.updateTodos('sess-1', 'not-an-array' as unknown as Todo[]);
    expect(mgr.getTodos('sess-1')).toEqual([validTodo]);
  });

  it('rejects null input and preserves previous state', () => {
    const mgr = new TodoManager();
    mgr.updateTodos('sess-1', [validTodo]);

    mgr.updateTodos('sess-1', null as unknown as Todo[]);
    expect(mgr.getTodos('sess-1')).toEqual([validTodo]);
  });

  it('rejects object input and preserves previous state', () => {
    const mgr = new TodoManager();
    mgr.updateTodos('sess-1', [validTodo]);

    mgr.updateTodos('sess-1', { content: 'foo' } as unknown as Todo[]);
    expect(mgr.getTodos('sess-1')).toEqual([validTodo]);
  });

  it('filters malformed items from array input', () => {
    const mgr = new TodoManager();
    mgr.updateTodos('sess-1', [validTodo, null as unknown as Todo]);
    expect(mgr.getTodos('sess-1')).toEqual([validTodo]);
  });

  it('fires onUpdate callback with validated todos', () => {
    const mgr = new TodoManager();
    const calls: Todo[][] = [];
    mgr.setOnUpdateCallback((_id, todos) => calls.push(todos));

    mgr.updateTodos('sess-1', [validTodo]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([validTodo]);
  });

  it('does not fire onUpdate callback for rejected input', () => {
    const mgr = new TodoManager();
    mgr.updateTodos('sess-1', [validTodo]);

    const calls: Todo[][] = [];
    mgr.setOnUpdateCallback((_id, todos) => calls.push(todos));

    mgr.updateTodos('sess-1', 42 as unknown as Todo[]);
    expect(calls).toHaveLength(0);
  });

  it('returns empty array for unknown session', () => {
    const mgr = new TodoManager();
    expect(mgr.getTodos('nonexistent')).toEqual([]);
  });

  it('handles TodoWrite input (no id/priority) end-to-end', () => {
    const mgr = new TodoManager();
    const todoWritePayload = [
      { content: 'Investigate bug', status: 'in_progress', activeForm: 'Investigating bug' },
      { content: 'Fix the issue', status: 'pending', activeForm: 'Fixing the issue' },
    ] as unknown as Todo[];

    mgr.updateTodos('sess-1', todoWritePayload);
    const stored = mgr.getTodos('sess-1');
    expect(stored).toHaveLength(2);
    expect(stored[0].id).toMatch(/^todo-/);
    expect(stored[0].priority).toBe('medium');
    expect(stored[0].content).toBe('Investigate bug');
    expect(stored[0].status).toBe('in_progress');
    expect(stored[0].startedAt).toBeDefined(); // auto-stamped
    expect(stored[1].id).toMatch(/^todo-/);
    expect(stored[1].priority).toBe('medium');
  });
});
