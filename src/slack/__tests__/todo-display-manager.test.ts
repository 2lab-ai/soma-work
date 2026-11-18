import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TodoDisplayManager } from '../todo-display-manager';

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

  const update = (status: 'pending' | 'in_progress' | 'completed', say: ReturnType<typeof vi.fn>) =>
    manager.handleTodoUpdate(
      { todos: [{ id: 'todo-1', content: 'Do it', status, priority: 'high' }] },
      'session-1',
      'session-id',
      'C123',
      '999.888',
      say as any,
      0,
    );

  it('the first todo update posts the list; the next edits that message instead of posting again', async () => {
    const say = vi.fn().mockResolvedValue({ ts: '111.222' });

    await update('pending', say);
    expect(say).toHaveBeenCalledWith({ text: 'todo list', thread_ts: '999.888' });

    await update('in_progress', say);
    expect(slackApi.updateMessage).toHaveBeenCalledWith('C123', '111.222', 'todo list');
    expect(say).toHaveBeenCalledTimes(1);
  });

  it('an edit that fails falls back to posting the list again', async () => {
    const say = vi.fn().mockResolvedValueOnce({ ts: '111.222' }).mockResolvedValueOnce({ ts: '222.333' });
    slackApi.updateMessage.mockRejectedValue(new Error('ratelimited'));

    await update('pending', say);
    await update('completed', say);

    expect(slackApi.updateMessage).toHaveBeenCalledWith('C123', '111.222', 'todo list');
    expect(say).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenLastCalledWith({ text: 'todo list', thread_ts: '999.888' });
  });
});

// =============================================================================
// P2 B2 (#577) — dual-call behavior under PHASE>=2
// =============================================================================

describe('TodoDisplayManager — B2 plan render dual-call', () => {
  let slackApi: { updateMessage: ReturnType<typeof vi.fn> };
  let todoManager: {
    getTodos: ReturnType<typeof vi.fn>;
    hasSignificantChange: ReturnType<typeof vi.fn>;
    updateTodos: ReturnType<typeof vi.fn>;
    formatTodoList: ReturnType<typeof vi.fn>;
    getStatusChange: ReturnType<typeof vi.fn>;
    cleanupSession: ReturnType<typeof vi.fn>;
  };
  let reactionManager: { updateTaskProgressReaction: ReturnType<typeof vi.fn> };
  let manager: TodoDisplayManager;
  let onRenderRequest: ReturnType<typeof vi.fn>;
  let onPlanRender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    slackApi = { updateMessage: vi.fn() };
    todoManager = {
      getTodos: vi.fn().mockReturnValue([]),
      hasSignificantChange: vi.fn().mockReturnValue(true),
      updateTodos: vi.fn(),
      formatTodoList: vi.fn().mockReturnValue('todo list'),
      getStatusChange: vi.fn().mockReturnValue(null),
      cleanupSession: vi.fn(),
    };
    reactionManager = { updateTaskProgressReaction: vi.fn().mockResolvedValue(undefined) };
    manager = new TodoDisplayManager(slackApi as any, todoManager as any, reactionManager as any);
    onRenderRequest = vi.fn().mockResolvedValue(undefined);
    onPlanRender = vi.fn().mockResolvedValue(true);
    manager.setRenderRequestCallback(onRenderRequest as any);
    manager.setPlanRenderCallback(onPlanRender as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const session = { sessionId: 'S1', channelId: 'C1' } as any;
  const todos = [{ id: 't1', content: 'do thing', status: 'in_progress', priority: 'high' } as any];
  const turnCtx = { channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0' };
  const say = vi.fn();

  it('turnId + turnCtx → calls BOTH onPlanRender AND onRenderRequest', async () => {
    await manager.handleTodoUpdate(
      { todos },
      'C1:t1.0',
      'S1',
      'C1',
      't1.0',
      say,
      0,
      session,
      'C1:t1.0:turn-1',
      turnCtx,
    );

    expect(onPlanRender).toHaveBeenCalledTimes(1);
    expect(onPlanRender).toHaveBeenCalledWith('C1:t1.0:turn-1', expect.any(Array), turnCtx);
    expect(onRenderRequest).toHaveBeenCalledTimes(1);
    expect(onRenderRequest).toHaveBeenCalledWith(session, 'C1:t1.0');
    // Legacy separate-message path (say / slackApi.updateMessage) must stay quiet
    // when onRenderRequest succeeds.
    expect(slackApi.updateMessage).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('without turnId → onRenderRequest only, onPlanRender skipped', async () => {
    await manager.handleTodoUpdate(
      { todos },
      'C1:t1.0',
      'S1',
      'C1',
      't1.0',
      say,
      0,
      session,
      // turnId / turnCtx absent
    );

    expect(onPlanRender).not.toHaveBeenCalled();
    expect(onRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('without turnCtx → onPlanRender skipped', async () => {
    await manager.handleTodoUpdate(
      { todos },
      'C1:t1.0',
      'S1',
      'C1',
      't1.0',
      say,
      0,
      session,
      'C1:t1.0:turn-1',
      // turnCtx absent
    );

    expect(onPlanRender).not.toHaveBeenCalled();
    expect(onRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('onPlanRender throws → does NOT block onRenderRequest', async () => {
    onPlanRender.mockRejectedValueOnce(new Error('boom'));

    await manager.handleTodoUpdate(
      { todos },
      'C1:t1.0',
      'S1',
      'C1',
      't1.0',
      say,
      0,
      session,
      'C1:t1.0:turn-1',
      turnCtx,
    );

    expect(onPlanRender).toHaveBeenCalledTimes(1);
    // Critical: legacy path still runs after plan render explodes.
    expect(onRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('empty todos → onPlanRender skipped (nothing to render)', async () => {
    await manager.handleTodoUpdate(
      { todos: [] },
      'C1:t1.0',
      'S1',
      'C1',
      't1.0',
      say,
      0,
      session,
      'C1:t1.0:turn-1',
      turnCtx,
    );

    expect(onPlanRender).not.toHaveBeenCalled();
    // onRenderRequest still fires — this handles the "tasks cleared" state
    // on the combined-header surface.
    expect(onRenderRequest).toHaveBeenCalledTimes(1);
  });
});
