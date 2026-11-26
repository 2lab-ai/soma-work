import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../types';
import { ThreadSurface } from '../thread-surface';

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

// ---------------------------------------------------------------------------
// P3 (PHASE>=3) — setChoiceMeta + clearChoice (extended pendingChoice clear)
// ---------------------------------------------------------------------------

describe('ThreadSurface — P3 setChoiceMeta / clearChoice', () => {
  afterEach(() => {
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
    const session = makeSession();
    const deps = makeP3Deps(session);
    const surface = new ThreadSurface(deps);

    await surface.setChoiceMeta('C1:t1.0', 'choice-ts-2');
    expect(session.actionPanel?.choiceBlocks).toBeUndefined();
  });

  it('setChoiceMeta is a no-op when session is missing', async () => {
    const deps = makeP3Deps({} as any);
    (deps.claudeHandler.getSessionByKey as any) = vi.fn().mockReturnValue(undefined);
    const surface = new ThreadSurface(deps);
    await expect(surface.setChoiceMeta('missing', 'ts')).resolves.toBeUndefined();
    expect(deps.slackApi.getPermalink).not.toHaveBeenCalled();
  });

  it('clearChoice also clears pendingChoice (P3)', async () => {
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
