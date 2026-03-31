import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TodoDisplayManager } from './todo-display-manager';

describe('TodoDisplayManager', () => {
  let slackApi: {
    updateMessage: ReturnType<typeof vi.fn>;
  };
  let todoManager: {
    getTodos: ReturnType<typeof vi.fn>;
    hasSignificantChange: ReturnType<typeof vi.fn>;
    updateTodos: ReturnType<typeof vi.fn>;
    formatTodoList: ReturnType<typeof vi.fn>;
    getStatusChange: ReturnType<typeof vi.fn>;
    cleanupSession: ReturnType<typeof vi.fn>;
  };
  let reactionManager: {
    updateTaskProgressReaction: ReturnType<typeof vi.fn>;
  };
  let manager: TodoDisplayManager;

  beforeEach(() => {
    slackApi = {
      updateMessage: vi.fn(),
    };
    todoManager = {
      getTodos: vi.fn().mockReturnValue([]),
      hasSignificantChange: vi.fn().mockReturnValue(true),
      updateTodos: vi.fn(),
      formatTodoList: vi.fn().mockReturnValue('todo list'),
      getStatusChange: vi.fn().mockReturnValue(null),
      cleanupSession: vi.fn(),
    };
    reactionManager = {
      updateTaskProgressReaction: vi.fn().mockResolvedValue(undefined),
    };
    manager = new TodoDisplayManager(slackApi as any, todoManager as any, reactionManager as any);
  });

  it('handleTodoUpdate uses slackApi.updateMessage for existing todo message', async () => {
    const say = vi.fn().mockResolvedValue({ ts: '999.888' });
    (manager as any).todoMessages.set('session-1', '111.222');

    await manager.handleTodoUpdate(
      {
        todos: [{ id: 'todo-1', content: 'Do it', status: 'in_progress', priority: 'high' }],
      },
      'session-1',
      'session-id',
      'C123',
      '999.888',
      say,
      0,
    );

    expect(slackApi.updateMessage).toHaveBeenCalledWith('C123', '111.222', 'todo list');
    expect(say).not.toHaveBeenCalled();
  });

  it('handleTodoUpdate falls back to say when slackApi.updateMessage fails', async () => {
    const say = vi.fn().mockResolvedValue({ ts: '222.333' });
    slackApi.updateMessage.mockRejectedValue(new Error('ratelimited'));
    (manager as any).todoMessages.set('session-1', '111.222');

    await manager.handleTodoUpdate(
      {
        todos: [{ id: 'todo-1', content: 'Do it', status: 'completed', priority: 'high' }],
      },
      'session-1',
      'session-id',
      'C123',
      '999.888',
      say,
      0,
    );

    expect(slackApi.updateMessage).toHaveBeenCalledWith('C123', '111.222', 'todo list');
    expect(say).toHaveBeenCalledWith({
      text: 'todo list',
      thread_ts: '999.888',
    });
  });
});
