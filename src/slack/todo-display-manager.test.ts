import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
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

// =============================================================================
// P2 B2 (#577) — dual-call behavior under PHASE>=2
// =============================================================================

describe('TodoDisplayManager — P2 B2 dual-call (PHASE>=2)', () => {
  const originalPhase = config.ui.fiveBlockPhase;

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
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
  });

  const session = { sessionId: 'S1', channelId: 'C1' } as any;
  const todos = [{ id: 't1', content: 'do thing', status: 'in_progress', priority: 'high' } as any];
  const turnCtx = { channelId: 'C1', threadTs: 't1.0', sessionKey: 'C1:t1.0' };
  const say = vi.fn();

  it('PHASE=2 + turnId + turnCtx → calls BOTH onPlanRender AND onRenderRequest', async () => {
    config.ui.fiveBlockPhase = 2;

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

  it('PHASE=2 without turnId → onRenderRequest only, onPlanRender skipped', async () => {
    config.ui.fiveBlockPhase = 2;

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

  it('PHASE=2 without turnCtx → onPlanRender skipped', async () => {
    config.ui.fiveBlockPhase = 2;

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

  it('PHASE=1 (below threshold) → onPlanRender skipped even with full turn context', async () => {
    config.ui.fiveBlockPhase = 1;

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

    expect(onPlanRender).not.toHaveBeenCalled();
    expect(onRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('PHASE=0 (default) → onPlanRender skipped; legacy-only flow', async () => {
    config.ui.fiveBlockPhase = 0;

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

    expect(onPlanRender).not.toHaveBeenCalled();
    expect(onRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('PHASE=2 + onPlanRender throws → does NOT block onRenderRequest', async () => {
    config.ui.fiveBlockPhase = 2;
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

  it('PHASE=2 + empty todos → onPlanRender skipped (nothing to render)', async () => {
    config.ui.fiveBlockPhase = 2;

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
