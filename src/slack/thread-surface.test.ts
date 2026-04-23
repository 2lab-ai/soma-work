import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import type { Todo } from '../todo-manager';
import type { ConversationSession } from '../types';
import { ThreadSurface } from './thread-surface';

/**
 * ThreadSurface unit tests — narrowly scoped to the P2 B2 migration guard
 * in `buildCombinedBlocks` (Issue #577).
 *
 * Legacy render paths (header, panel, choice slot, close, debounce) have
 * existing coverage in adjacent test files + integration harnesses; this
 * file's job is ONLY to assert that the task-list embed is skipped under
 * PHASE>=2 so that TurnSurface.renderTasks owns the plan message.
 */

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    content: 'Task',
    status: 'pending',
    activeForm: 'Working',
    ...overrides,
  } as Todo;
}

function makeSession(): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: 't1.0',
    threadRootTs: 't1.0',
    ownerId: 'U1',
    isActive: true,
    terminated: false,
    workflow: undefined,
    actionPanel: {},
  } as unknown as ConversationSession;
}

function makeDeps(todos: Todo[]) {
  return {
    slackApi: {
      getClient: vi.fn().mockReturnValue({}),
    } as any,
    claudeHandler: {
      getSessionKey: vi.fn().mockReturnValue('C1:t1.0'),
    } as any,
    requestCoordinator: {
      isRequestActive: vi.fn().mockReturnValue(false),
    } as any,
    todoManager: {
      getTodos: vi.fn().mockReturnValue(todos),
      getEffectiveStatus: vi.fn().mockImplementation((todo: Todo) => todo.status),
    } as any,
  };
}

// ThreadSurface.buildCombinedBlocks is intentionally private — the P2 guard
// sits there, so we cast-escape for this targeted test. Keeping the escape
// local avoids leaking `any` into the rest of the suite.
function buildBlocks(surface: ThreadSurface, session: ConversationSession, sessionKey: string): any[] {
  return (surface as any).buildCombinedBlocks(session, sessionKey);
}

function hasTaskListEmbed(blocks: any[]): boolean {
  // The checklist renderer emits a section with text containing "Task List".
  // The queue/pulse themes also include the phrase somewhere in their text.
  // If any block text mentions "Task List", the embed was produced.
  return blocks.some((block) => {
    if (block.type !== 'section') return false;
    const text = block.text?.text;
    return typeof text === 'string' && text.includes('Task List');
  });
}

describe('ThreadSurface.buildCombinedBlocks — P2 B2 guard', () => {
  const originalPhase = config.ui.fiveBlockPhase;

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
  });

  it('PHASE=0 embeds the task list when todos exist (legacy behavior)', () => {
    config.ui.fiveBlockPhase = 0;
    const todos = [makeTodo({ content: 'one' }), makeTodo({ content: 'two' })];
    const deps = makeDeps(todos);
    const surface = new ThreadSurface(deps);

    const blocks = buildBlocks(surface, makeSession(), 'C1:t1.0');

    expect(hasTaskListEmbed(blocks)).toBe(true);
    expect(deps.todoManager.getTodos).toHaveBeenCalledWith('sess-1');
  });

  it('PHASE=1 embeds the task list (guard is >=2, not >=1)', () => {
    config.ui.fiveBlockPhase = 1;
    const todos = [makeTodo({ content: 'only' })];
    const deps = makeDeps(todos);
    const surface = new ThreadSurface(deps);

    const blocks = buildBlocks(surface, makeSession(), 'C1:t1.0');

    expect(hasTaskListEmbed(blocks)).toBe(true);
  });

  it('PHASE=2 does NOT embed the task list even with todos present', () => {
    config.ui.fiveBlockPhase = 2;
    const todos = [makeTodo({ content: 'one' }), makeTodo({ content: 'two' })];
    const deps = makeDeps(todos);
    const surface = new ThreadSurface(deps);

    const blocks = buildBlocks(surface, makeSession(), 'C1:t1.0');

    expect(hasTaskListEmbed(blocks)).toBe(false);
    // And we didn't even bother asking the todoManager for them.
    expect(deps.todoManager.getTodos).not.toHaveBeenCalled();
  });

  it('PHASE=3 also skips (cumulative flag — >=2 suffices)', () => {
    config.ui.fiveBlockPhase = 3;
    const todos = [makeTodo({ content: 'x' })];
    const deps = makeDeps(todos);
    const surface = new ThreadSurface(deps);

    const blocks = buildBlocks(surface, makeSession(), 'C1:t1.0');

    expect(hasTaskListEmbed(blocks)).toBe(false);
    expect(deps.todoManager.getTodos).not.toHaveBeenCalled();
  });

  it('PHASE=2 still emits header + panel blocks (only the task section is gone)', () => {
    config.ui.fiveBlockPhase = 2;
    const todos = [makeTodo({ content: 'x' })];
    const deps = makeDeps(todos);
    const surface = new ThreadSurface(deps);

    const blocks = buildBlocks(surface, makeSession(), 'C1:t1.0');

    // Expect the rest of the surface to be untouched — non-empty block list.
    expect(blocks.length).toBeGreaterThan(0);
    // And nothing mentions "Task List" mrkdwn.
    expect(hasTaskListEmbed(blocks)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P3 (PHASE>=3) — setChoiceMeta + clearChoice (extended pendingChoice clear)
// ---------------------------------------------------------------------------

describe('ThreadSurface — P3 setChoiceMeta / clearChoice', () => {
  const originalPhase = config.ui.fiveBlockPhase;

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
  });

  function makeP3Deps(session: ConversationSession) {
    const slackApi = {
      getClient: vi.fn().mockReturnValue({}),
      getPermalink: vi.fn().mockResolvedValue('https://slack.example/p1'),
      postMessage: vi.fn().mockResolvedValue({ ts: 'panel-ts' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    const claudeHandler = {
      getSessionByKey: vi.fn().mockReturnValue(session),
      getSessionKey: vi.fn().mockReturnValue('C1:t1.0'),
    };
    const requestCoordinator = { isRequestActive: vi.fn().mockReturnValue(false) };
    const todoManager = { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() };
    return {
      slackApi: slackApi as any,
      claudeHandler: claudeHandler as any,
      requestCoordinator: requestCoordinator as any,
      todoManager: todoManager as any,
    };
  }

  it('setChoiceMeta writes choiceMessageTs + waitingForChoice and attempts permalink', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    const deps = makeP3Deps(session);
    const surface = new ThreadSurface(deps);

    await surface.setChoiceMeta('C1:t1.0', 'choice-ts-1');

    expect(session.actionPanel?.choiceMessageTs).toBe('choice-ts-1');
    expect(session.actionPanel?.waitingForChoice).toBe(true);
    // Permalink fetch fires (fire-and-forget) — allow pending microtasks to run
    await new Promise((r) => setImmediate(r));
    expect(deps.slackApi.getPermalink).toHaveBeenCalledWith('C1', 'choice-ts-1');
  });

  it('setChoiceMeta does NOT write choiceBlocks (the B3 message owns its own buttons)', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    const deps = makeP3Deps(session);
    const surface = new ThreadSurface(deps);

    await surface.setChoiceMeta('C1:t1.0', 'choice-ts-2');
    expect(session.actionPanel?.choiceBlocks).toBeUndefined();
  });

  it('setChoiceMeta is a no-op below PHASE=3', async () => {
    config.ui.fiveBlockPhase = 2;
    const session = makeSession();
    const deps = makeP3Deps(session);
    const surface = new ThreadSurface(deps);

    await surface.setChoiceMeta('C1:t1.0', 'never-written');
    expect(session.actionPanel?.choiceMessageTs).toBeUndefined();
    expect(deps.slackApi.getPermalink).not.toHaveBeenCalled();
  });

  it('setChoiceMeta is a no-op when session is missing', async () => {
    config.ui.fiveBlockPhase = 3;
    const deps = makeP3Deps({} as any);
    (deps.claudeHandler.getSessionByKey as any) = vi.fn().mockReturnValue(undefined);
    const surface = new ThreadSurface(deps);
    await expect(surface.setChoiceMeta('missing', 'ts')).resolves.toBeUndefined();
    expect(deps.slackApi.getPermalink).not.toHaveBeenCalled();
  });

  it('clearChoice also clears pendingChoice (P3)', async () => {
    config.ui.fiveBlockPhase = 3;
    const session = makeSession();
    session.actionPanel = {
      choiceMessageTs: 'ts-xyz',
      choiceMessageLink: 'link',
      waitingForChoice: true,
      choiceBlocks: [{ type: 'section' } as any],
      pendingChoice: {
        turnId: 'turn-1',
        kind: 'single',
        choiceTs: 'ts-xyz',
        formIds: [],
        question: {} as any,
        createdAt: 1,
      },
    };
    const deps = makeP3Deps(session);
    const surface = new ThreadSurface(deps);
    await surface.clearChoice('C1:t1.0');
    expect(session.actionPanel?.pendingChoice).toBeUndefined();
    expect(session.actionPanel?.choiceBlocks).toBeUndefined();
    expect(session.actionPanel?.waitingForChoice).toBe(false);
    expect(session.actionPanel?.choiceMessageTs).toBeUndefined();
    expect(session.actionPanel?.choiceMessageLink).toBeUndefined();
  });
});
