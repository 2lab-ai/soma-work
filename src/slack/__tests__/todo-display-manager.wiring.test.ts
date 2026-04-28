/**
 * TodoDisplayManager — production wiring (#757 / PR3b).
 *
 * Linus round-1 P1: the production call site previously invoked
 * `TodoManager.updateTodos(sessionId, newTodos)` WITHOUT `opts`, so the disk
 * write + FK guard + cross-session lookup added in PR3b were dead code in
 * production. This suite drives the real TodoDisplayManager seam (real
 * TodoManager, tmpdir DATA_DIR) and asserts that:
 *
 *   1. handleTodoUpdate persists to data/users/{userId}/todos.json
 *   2. New Todos auto-link userInstructionId from session.currentInstructionId
 *   3. The cancelled/completed instruction guard fires through the seam
 *      (NOT only when invoking TodoManager directly).
 *
 * Keeping this in a sibling `__tests__/` per pattern.test rule, with the
 * `.wiring` aspect suffix to disambiguate from `todo-display-manager.test.ts`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type InstructionStatus, type Todo, TodoManager } from '../../todo-manager';
import type { ConversationSession } from '../../types';
import { TodoDisplayManager } from '../todo-display-manager';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-todo-display-wiring-'));
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const fakeReactionManager = () => ({
  updateTaskProgressReaction: vi.fn().mockResolvedValue(undefined),
});

const fakeSlackApi = () => ({
  updateMessage: vi.fn().mockResolvedValue(undefined),
});

const baseSession = (over: Partial<ConversationSession> = {}): ConversationSession =>
  ({
    ownerId: 'U_WIRE',
    ownerName: 'wire-user',
    channelId: 'C1',
    threadTs: 't1.0',
    sessionId: 'sess-wire',
    isActive: true,
    lastActivity: new Date(),
    userId: 'U_WIRE',
    currentInstructionId: 'instr_live',
    ...over,
  }) as ConversationSession;

const todoPayload = (over: Partial<Todo> = {}): Todo => ({
  id: 't-wire-1',
  content: 'Wire the opts',
  status: 'pending',
  priority: 'medium',
  ...over,
});

describe('TodoDisplayManager — production wiring (PR3b)', () => {
  it('persists TodoWrite to data/users/{userId}/todos.json via opts.userId', async () => {
    const todoManager = new TodoManager({ baseDir: tmpRoot });
    const display = new TodoDisplayManager(
      fakeSlackApi() as any,
      todoManager,
      fakeReactionManager() as any,
    );
    const session = baseSession({ currentInstructionId: null });
    const say = vi.fn().mockResolvedValue({ ts: '111.222' });

    await display.handleTodoUpdate(
      { todos: [todoPayload()] },
      'sess-wire',
      'sess-wire',
      'C1',
      't1.0',
      say,
      0,
      session,
      undefined,
      undefined,
      {
        userId: session.ownerId,
        currentInstructionId: session.currentInstructionId ?? null,
      },
    );

    const file = path.join(tmpRoot, 'users', 'U_WIRE', 'todos.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.todos).toHaveLength(1);
    expect(parsed.todos[0].sessionId).toBe('sess-wire');
    expect(parsed.todos[0].userInstructionId).toBeNull();
  });

  it('auto-links userInstructionId from session.currentInstructionId', async () => {
    const todoManager = new TodoManager({ baseDir: tmpRoot });
    const display = new TodoDisplayManager(
      fakeSlackApi() as any,
      todoManager,
      fakeReactionManager() as any,
    );
    const session = baseSession({ currentInstructionId: 'instr_live' });
    const say = vi.fn().mockResolvedValue({ ts: '111.222' });

    const lookup = vi.fn((id: string): InstructionStatus => (id === 'instr_live' ? 'active' : 'unknown'));

    await display.handleTodoUpdate(
      { todos: [todoPayload({ id: 't-link', content: 'Link me' })] },
      'sess-wire',
      'sess-wire',
      'C1',
      't1.0',
      say,
      0,
      session,
      undefined,
      undefined,
      {
        userId: session.ownerId,
        currentInstructionId: session.currentInstructionId ?? null,
        instructionStatusLookup: lookup,
      },
    );

    const stored = todoManager.getTodos('sess-wire');
    expect(stored).toHaveLength(1);
    expect(stored[0].userInstructionId).toBe('instr_live');

    const file = path.join(tmpRoot, 'users', 'U_WIRE', 'todos.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.todos[0].userInstructionId).toBe('instr_live');
  });

  it('fires cancelled-instruction guard through the seam (rejects new Todo)', async () => {
    const todoManager = new TodoManager({ baseDir: tmpRoot });
    const display = new TodoDisplayManager(
      fakeSlackApi() as any,
      todoManager,
      fakeReactionManager() as any,
    );
    const session = baseSession({ currentInstructionId: 'instr_dead' });
    const say = vi.fn().mockResolvedValue({ ts: '111.222' });

    const lookup = vi.fn(
      (id: string): InstructionStatus => (id === 'instr_dead' ? 'cancelled' : 'unknown'),
    );

    await expect(
      display.handleTodoUpdate(
        { todos: [todoPayload({ id: 't-dead', content: 'Should reject' })] },
        'sess-wire',
        'sess-wire',
        'C1',
        't1.0',
        say,
        0,
        session,
        undefined,
        undefined,
        {
          userId: session.ownerId,
          currentInstructionId: session.currentInstructionId ?? null,
          instructionStatusLookup: lookup,
        },
      ),
    ).rejects.toThrow(/cancelled/);

    expect(lookup).toHaveBeenCalledWith('instr_dead');
    // Guard fires BEFORE any RAM mutation or disk write.
    expect(todoManager.getTodos('sess-wire')).toEqual([]);
    const file = path.join(tmpRoot, 'users', 'U_WIRE', 'todos.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('fires completed-instruction guard through the seam (rejects new Todo)', async () => {
    const todoManager = new TodoManager({ baseDir: tmpRoot });
    const display = new TodoDisplayManager(
      fakeSlackApi() as any,
      todoManager,
      fakeReactionManager() as any,
    );
    const session = baseSession({ currentInstructionId: 'instr_done' });
    const say = vi.fn().mockResolvedValue({ ts: '111.222' });

    const lookup = vi.fn(
      (id: string): InstructionStatus => (id === 'instr_done' ? 'completed' : 'unknown'),
    );

    await expect(
      display.handleTodoUpdate(
        { todos: [todoPayload({ id: 't-done', content: 'Should reject' })] },
        'sess-wire',
        'sess-wire',
        'C1',
        't1.0',
        say,
        0,
        session,
        undefined,
        undefined,
        {
          userId: session.ownerId,
          currentInstructionId: session.currentInstructionId ?? null,
          instructionStatusLookup: lookup,
        },
      ),
    ).rejects.toThrow(/completed/);

    expect(todoManager.getTodos('sess-wire')).toEqual([]);
  });
});
