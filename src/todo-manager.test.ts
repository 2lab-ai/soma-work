import { describe, expect, it } from 'vitest';
import { parseTodos, type Todo, TodoManager } from './todo-manager.js';

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

  it('filters items with invalid priority', () => {
    const result = parseTodos([{ id: '1', content: 'Bad priority', status: 'pending', priority: 'critical' }]);
    expect(result).toEqual([]);
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
});
