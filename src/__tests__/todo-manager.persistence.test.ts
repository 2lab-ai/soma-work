/**
 * TodoManager — persistence + instruction FK contract tests.
 *
 * Issue: #757 (parent epic #727).
 *
 * Sealed scope:
 *   - On-disk path: data/users/{userId}/todos.json
 *   - File schema: { schemaVersion: 1, todos: Array<Todo & { sessionId, userInstructionId }> }
 *   - Atomic write tmp → rename. RAM and disk stay in sync (write-through).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Todo, TodoManager } from '../todo-manager';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-todo-mgr-'));
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const baseTodo = (over: Partial<Todo> = {}): Todo => ({
  id: 't1',
  content: 'Do thing',
  status: 'pending',
  priority: 'medium',
  ...over,
});

describe('TodoManager — disk path layout', () => {
  it('persists to data/users/{userId}/todos.json under the configured baseDir', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1' });

    const expected = path.join(tmpRoot, 'users', 'U1', 'todos.json');
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('writes file atomically (no leftover *.tmp on success)', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1' });

    const userDir = path.join(tmpRoot, 'users', 'U1');
    const files = fs.readdirSync(userDir);
    expect(files).toContain('todos.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('rejects unsafe userId (path traversal / separator)', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    expect(() => mgr.updateTodos('sess-1', [baseTodo()], { userId: '../etc' })).toThrow();
    expect(() => mgr.updateTodos('sess-1', [baseTodo()], { userId: 'a/b' })).toThrow();
  });
});

describe('TodoManager — file schema (sealed shape)', () => {
  it('writes schemaVersion=1 envelope with todos[] each carrying sessionId + userInstructionId', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1', currentInstructionId: null });

    const file = path.join(tmpRoot, 'users', 'U1', 'todos.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.todos)).toBe(true);
    expect(parsed.todos).toHaveLength(1);
    expect(parsed.todos[0].sessionId).toBe('sess-1');
    expect(parsed.todos[0].userInstructionId).toBeNull();
    expect(parsed.todos[0].id).toBe('t1');
    expect(parsed.todos[0].content).toBe('Do thing');
  });

  it('round-trips through loadFromDisk', () => {
    const mgr1 = new TodoManager({ baseDir: tmpRoot });
    mgr1.updateTodos('sess-1', [baseTodo()], { userId: 'U1', currentInstructionId: null });

    // Fresh manager — load from disk.
    const mgr2 = new TodoManager({ baseDir: tmpRoot });
    mgr2.loadFromDisk('U1');
    const round = mgr2.getTodos('sess-1');
    expect(round).toHaveLength(1);
    expect(round[0].id).toBe('t1');
    expect(round[0].userInstructionId).toBeNull();
  });

  it('loadFromDisk with no file is a no-op (RAM stays empty)', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    expect(() => mgr.loadFromDisk('U1')).not.toThrow();
    expect(mgr.getTodos('sess-1')).toEqual([]);
  });

  it('treats malformed JSON as a hard error (NEVER silently overwrites)', () => {
    const userDir = path.join(tmpRoot, 'users', 'U1');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'todos.json'), '{not json', 'utf-8');

    const mgr = new TodoManager({ baseDir: tmpRoot });
    expect(() => mgr.loadFromDisk('U1')).toThrow();
  });
});

describe('TodoManager — auto-link userInstructionId from currentInstructionId', () => {
  it('stamps userInstructionId from opts.currentInstructionId on first creation', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1', currentInstructionId: 'instr_42' });

    const stored = mgr.getTodos('sess-1');
    expect(stored[0].userInstructionId).toBe('instr_42');
  });

  it('stamps userInstructionId=null when currentInstructionId is null', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1', currentInstructionId: null });

    const stored = mgr.getTodos('sess-1');
    expect(stored[0].userInstructionId).toBeNull();
  });

  it('stamps userInstructionId=null when no opts (defensive default)', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()]);

    const stored = mgr.getTodos('sess-1');
    expect(stored[0].userInstructionId).toBeNull();
  });

  it('frozen at creation: subsequent updates do NOT change userInstructionId', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1', currentInstructionId: 'instr_A' });

    // currentInstructionId changes mid-session — the existing Todo's link must stay frozen.
    mgr.updateTodos('sess-1', [baseTodo({ status: 'in_progress' })], {
      userId: 'U1',
      currentInstructionId: 'instr_B',
    });

    const stored = mgr.getTodos('sess-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].userInstructionId).toBe('instr_A');
    expect(stored[0].status).toBe('in_progress');
  });

  it('newly added Todo in a later update gets the THEN-current instructionId', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo({ id: 't1' })], { userId: 'U1', currentInstructionId: 'instr_A' });

    // Now add t2 while currentInstructionId is instr_B
    mgr.updateTodos('sess-1', [baseTodo({ id: 't1' }), baseTodo({ id: 't2', content: 'New thing' })], {
      userId: 'U1',
      currentInstructionId: 'instr_B',
    });

    const stored = mgr.getTodos('sess-1');
    const t1 = stored.find((t) => t.id === 't1');
    const t2 = stored.find((t) => t.id === 't2');
    expect(t1?.userInstructionId).toBe('instr_A');
    expect(t2?.userInstructionId).toBe('instr_B');
  });

  it('persists userInstructionId through write-through on every mutation', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1', currentInstructionId: 'instr_A' });

    // Read the file directly between mutations.
    const file = path.join(tmpRoot, 'users', 'U1', 'todos.json');
    let parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.todos[0].userInstructionId).toBe('instr_A');

    mgr.updateTodos('sess-1', [baseTodo({ status: 'completed' })], {
      userId: 'U1',
      currentInstructionId: 'instr_B', // changed but Todo is frozen
    });
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.todos[0].userInstructionId).toBe('instr_A');
    expect(parsed.todos[0].status).toBe('completed');
  });
});

describe('TodoManager — cancelled/completed instruction guard', () => {
  it('throws when creating a Todo whose currentInstructionId is cancelled', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    expect(() =>
      mgr.updateTodos('sess-1', [baseTodo()], {
        userId: 'U1',
        currentInstructionId: 'instr_dead',
        instructionStatusLookup: (id) => (id === 'instr_dead' ? 'cancelled' : 'unknown'),
      }),
    ).toThrow(/cancelled|completed/i);
  });

  it('throws when creating a Todo whose currentInstructionId is completed', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    expect(() =>
      mgr.updateTodos('sess-1', [baseTodo()], {
        userId: 'U1',
        currentInstructionId: 'instr_done',
        instructionStatusLookup: (id) => (id === 'instr_done' ? 'completed' : 'unknown'),
      }),
    ).toThrow(/cancelled|completed/i);
  });

  it('allows creation when currentInstructionId is active', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    expect(() =>
      mgr.updateTodos('sess-1', [baseTodo()], {
        userId: 'U1',
        currentInstructionId: 'instr_live',
        instructionStatusLookup: (id) => (id === 'instr_live' ? 'active' : 'unknown'),
      }),
    ).not.toThrow();
    expect(mgr.getTodos('sess-1')[0].userInstructionId).toBe('instr_live');
  });

  it('allows updates to existing Todos even after their instruction completes (frozen)', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    // Create Todo while instr_live is active.
    mgr.updateTodos('sess-1', [baseTodo()], {
      userId: 'U1',
      currentInstructionId: 'instr_live',
      instructionStatusLookup: () => 'active',
    });

    // The instruction completes. Now we update Todo status — must NOT throw
    // because we are not creating a new link, just mutating an existing Todo.
    expect(() =>
      mgr.updateTodos('sess-1', [baseTodo({ status: 'completed' })], {
        userId: 'U1',
        currentInstructionId: 'instr_live',
        instructionStatusLookup: () => 'completed',
      }),
    ).not.toThrow();
    expect(mgr.getTodos('sess-1')[0].status).toBe('completed');
  });

  it('does NOT save the file when guard throws (RAM and disk stay clean)', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    expect(() =>
      mgr.updateTodos('sess-1', [baseTodo()], {
        userId: 'U1',
        currentInstructionId: 'instr_dead',
        instructionStatusLookup: () => 'cancelled',
      }),
    ).toThrow();

    expect(mgr.getTodos('sess-1')).toEqual([]);
    const file = path.join(tmpRoot, 'users', 'U1', 'todos.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects when ANY new Todo in a batch links to a dead instruction', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    // First create t1 under an active instruction.
    mgr.updateTodos('sess-1', [baseTodo({ id: 't1' })], {
      userId: 'U1',
      currentInstructionId: 'instr_live',
      instructionStatusLookup: () => 'active',
    });

    // Now an update that adds t2 while instr_dead is the current pointer
    // (but the lookup says cancelled). t1 is existing (frozen, fine), t2 is
    // a new creation under a dead instruction → MUST throw, t1 must NOT be
    // mutated.
    const file = path.join(tmpRoot, 'users', 'U1', 'todos.json');
    const before = fs.readFileSync(file, 'utf-8');
    expect(() =>
      mgr.updateTodos('sess-1', [baseTodo({ id: 't1' }), baseTodo({ id: 't2', content: 'New' })], {
        userId: 'U1',
        currentInstructionId: 'instr_dead',
        instructionStatusLookup: (id) => (id === 'instr_dead' ? 'cancelled' : 'active'),
      }),
    ).toThrow(/cancelled|completed/i);

    // Disk state is unchanged.
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    // RAM: only t1 still present.
    const stored = mgr.getTodos('sess-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('t1');
  });
});

describe('TodoManager — findTodosByInstructionId (cross-session)', () => {
  it('returns Todos linked to the same instruction across multiple sessions', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-A', [baseTodo({ id: 't-a1' })], {
      userId: 'U1',
      currentInstructionId: 'instr_42',
    });
    mgr.updateTodos('sess-B', [baseTodo({ id: 't-b1', content: 'Other session task' })], {
      userId: 'U1',
      currentInstructionId: 'instr_42',
    });
    mgr.updateTodos('sess-C', [baseTodo({ id: 't-c1', content: 'Different instruction' })], {
      userId: 'U1',
      currentInstructionId: 'instr_99',
    });

    const linked = mgr.findTodosByInstructionId('U1', 'instr_42');
    const ids = linked.map((t) => t.id).sort();
    expect(ids).toEqual(['t-a1', 't-b1']);
  });

  it('returns empty array when no Todos are linked to the instruction', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-1', [baseTodo()], { userId: 'U1', currentInstructionId: 'instr_42' });

    expect(mgr.findTodosByInstructionId('U1', 'instr_unknown')).toEqual([]);
  });

  it('does NOT cross user boundaries', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-A', [baseTodo({ id: 't-u1' })], { userId: 'U1', currentInstructionId: 'instr_42' });
    mgr.updateTodos('sess-B', [baseTodo({ id: 't-u2' })], { userId: 'U2', currentInstructionId: 'instr_42' });

    const u1Linked = mgr.findTodosByInstructionId('U1', 'instr_42');
    expect(u1Linked.map((t) => t.id)).toEqual(['t-u1']);

    const u2Linked = mgr.findTodosByInstructionId('U2', 'instr_42');
    expect(u2Linked.map((t) => t.id)).toEqual(['t-u2']);
  });

  it('skips Todos with userInstructionId=null', () => {
    const mgr = new TodoManager({ baseDir: tmpRoot });
    mgr.updateTodos('sess-A', [baseTodo({ id: 't-null' })], { userId: 'U1', currentInstructionId: null });
    mgr.updateTodos('sess-B', [baseTodo({ id: 't-link' })], { userId: 'U1', currentInstructionId: 'instr_42' });

    const linked = mgr.findTodosByInstructionId('U1', 'instr_42');
    expect(linked.map((t) => t.id)).toEqual(['t-link']);
  });

  it('finds Todos that were rehydrated via loadFromDisk', () => {
    const mgr1 = new TodoManager({ baseDir: tmpRoot });
    mgr1.updateTodos('sess-A', [baseTodo({ id: 't-a' })], { userId: 'U1', currentInstructionId: 'instr_42' });
    mgr1.updateTodos('sess-B', [baseTodo({ id: 't-b' })], { userId: 'U1', currentInstructionId: 'instr_42' });

    // New manager — must rehydrate from disk before findTodosByInstructionId
    // can see anything.
    const mgr2 = new TodoManager({ baseDir: tmpRoot });
    mgr2.loadFromDisk('U1');
    const linked = mgr2.findTodosByInstructionId('U1', 'instr_42');
    expect(linked.map((t) => t.id).sort()).toEqual(['t-a', 't-b']);
  });
});
