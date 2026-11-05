/**
 * Every valid TodoWrite snapshot reaches the TodoManager's update listener —
 * the session's persisted task ledger — even when the display has nothing to
 * redraw (2026-11-05, goal task gate, review P1).
 *
 * After a restart (or the TodoManager's idle cleanup) the in-memory list is
 * empty while the ledger still holds the old tasks. An empty TodoWrite — the
 * model taking tasks that left the goal off its list — compares `[]` with `[]`,
 * so the display skipped it and the ledger kept the stale tasks, holding the
 * goal open for good.
 */

import { describe, expect, it, vi } from 'vitest';
import { TodoManager } from '../../todo-manager';
import { TodoDisplayManager } from '../todo-display-manager';

function makeManager() {
  const todoManager = new TodoManager();
  const synced: unknown[][] = [];
  todoManager.setOnUpdateCallback((_sessionId, todos) => synced.push(todos));
  const slackApi = { updateMessage: vi.fn() };
  const reactions = { updateTaskProgressReaction: vi.fn().mockResolvedValue(undefined) };
  const display = new TodoDisplayManager(slackApi as never, todoManager, reactions);
  return { display, synced, say: vi.fn().mockResolvedValue({ ts: '1.1' }) };
}

describe('TodoDisplayManager — the ledger hears every TodoWrite', () => {
  it('an empty list over an empty memory still reaches the ledger (restart / cleanup)', async () => {
    const { display, synced, say } = makeManager();
    await display.handleTodoUpdate({ todos: [] }, 'C1:T1', 'sid-1', 'C1', 'T1', say, 0);
    expect(synced).toEqual([[]]);
  });

  it('a list whose items all fail to parse is no clear — the ledger keeps its tasks (review r2 P2)', async () => {
    const { display, synced, say } = makeManager();
    await display.handleTodoUpdate(
      { todos: [{ content: 'Unfinished task', status: 'invalid' }] as never },
      'C1:T1',
      'sid-1',
      'C1',
      'T1',
      say,
      0,
    );
    expect(synced).toEqual([]);
  });

  it('a changed list reaches the ledger once, as before', async () => {
    const { display, synced, say } = makeManager();
    await display.handleTodoUpdate(
      { todos: [{ id: 'a', content: 'do it', status: 'pending', priority: 'high' }] },
      'C1:T1',
      'sid-1',
      'C1',
      'T1',
      say,
      0,
    );
    expect(synced).toHaveLength(1);
  });
});
