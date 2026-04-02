import { describe, expect, it, vi } from 'vitest';
import { SlackHandler } from './slack-handler';

describe('SlackHandler', () => {
  it('creates thread panel after session initialization', async () => {
    const app = { client: {} } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: { ownerId: 'U123' },
      sessionKey: 'C123:thread123',
      isNewSession: true,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    handlerAny.streamExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, messageCount: 1 }),
    };
    const create = vi.fn().mockResolvedValue(undefined);
    handlerAny.threadPanel = { create };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'hello',
    };

    await handler.handleMessage(event as any, say);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(sessionResult.session, sessionResult.sessionKey);
  });

  it('streams into bot-initiated thread when initializer returns migrated session', async () => {
    const app = { client: {} } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '222.333',
        threadModel: 'bot-initiated',
        threadRootTs: '222.333',
      },
      sessionKey: 'C123:222.333',
      isNewSession: true,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1 });
    handlerAny.streamExecutor = { execute };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'hello',
    };

    await handler.handleMessage(event as any, say);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        threadTs: '222.333',
      }),
    );
  });

  it('clears waiting choice panel when user sends direct text input', async () => {
    const app = { client: {} } as any;
    const claudeHandler = {
      setActivityStateByKey: vi.fn(),
    };
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        actionPanel: {
          waitingForChoice: true,
          choiceBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'choice' } }],
        },
      },
      sessionKey: 'C123:thread123',
      isNewSession: false,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    handlerAny.streamExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, messageCount: 1 }),
    };

    const clearChoice = vi.fn().mockResolvedValue(undefined);
    handlerAny.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      clearChoice,
    };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: '직접 입력으로 답변할게요',
    };

    await handler.handleMessage(event as any, say);

    expect(clearChoice).toHaveBeenCalledTimes(1);
    expect(clearChoice).toHaveBeenCalledWith('C123:thread123');
  });

  it('passes forceWorkflow from continuation into runDispatch', async () => {
    const app = { client: {} } as any;
    const claudeHandler = {
      resetSessionContext: vi.fn(),
      getSession: vi.fn().mockReturnValue({
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '111.222',
      }),
    };
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '111.222',
      },
      sessionKey: 'C123:111.222',
      isNewSession: true,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
      runDispatch: vi.fn().mockResolvedValue(undefined),
    };
    handlerAny.streamExecutor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          messageCount: 1,
          continuation: {
            prompt: 'new https://github.com/acme/repo/pull/1',
            resetSession: true,
            dispatchText: 'https://github.com/acme/repo/pull/1',
            forceWorkflow: 'pr-review',
          },
        })
        .mockResolvedValueOnce({ success: true, messageCount: 1 }),
    };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'review this pr',
    };

    await handler.handleMessage(event as any, say);

    expect(claudeHandler.resetSessionContext).toHaveBeenCalledWith('C123', '111.222');
    expect(handlerAny.sessionInitializer.runDispatch).toHaveBeenCalledWith(
      'C123',
      '111.222',
      'https://github.com/acme/repo/pull/1',
      'pr-review',
    );
  });

  it('uses persisted sourceThread for continuation messages in work thread', async () => {
    // Bug: When user sends a follow-up message in the work thread,
    // activeThreadTs === originalThreadTs, so sourceThreadTs was set to undefined.
    // Fix: Fall back to session.sourceThread from the persisted session.
    const app = { client: {} } as any;
    const claudeHandler = {};
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate a continuation message: user posts directly in the work thread.
    // The session already has sourceThread from the initial thread migration.
    const sessionResult = {
      session: {
        ownerId: 'U123',
        channelId: 'C123',
        threadTs: '222.333',
        threadRootTs: '222.333',
        sourceThread: { channel: 'C123', threadTs: '111.000' }, // original source thread
      },
      sessionKey: 'C123:222.333',
      isNewSession: false,
      userName: 'Test User',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false, continueWithPrompt: undefined }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue(sessionResult),
    };
    const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1 });
    handlerAny.streamExecutor = { execute };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    // User posts in the work thread (thread_ts === work thread's ts)
    const event = {
      user: 'U123',
      channel: 'C123',
      thread_ts: '222.333',
      ts: '333.444',
      text: 'continue working',
    };

    await handler.handleMessage(event as any, say);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadTs: '111.000', // should fall back to session.sourceThread
        sourceChannel: 'C123',
      }),
    );
  });

  it('silently deletes unmanaged bot-authored message permalink sent in DM', async () => {
    const app = { client: {} } as any;
    const claudeHandler = {
      getAllSessions: vi.fn().mockReturnValue(new Map()),
      getSessionKey: vi.fn().mockReturnValue('C999:111.222'),
      getSessionByKey: vi.fn().mockReturnValue(undefined),
    };
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      getMessage: vi.fn().mockResolvedValue({
        ts: '111.222',
        user: 'B999',
      }),
      getBotUserId: vi.fn().mockResolvedValue('B999'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn(),
      routeCommand: vi.fn(),
    };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'D123',
      ts: '555.666',
      text: 'https://workspace.slack.com/archives/C999/p111222000000',
    };

    await handler.handleMessage(event as any, say);

    expect(mockSlackApi.deleteMessage).toHaveBeenCalledWith('C999', '111222.000000');
    expect(say).not.toHaveBeenCalled();
    expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
  });

  it('asks confirmation before deleting managed bot-authored message permalink sent in DM', async () => {
    const app = { client: {} } as any;
    const managedSession = {
      channelId: 'C999',
      threadTs: '222333.000000',
      threadRootTs: '222333.000000',
      actionPanel: {
        messageTs: '999.111',
      },
    };
    const claudeHandler = {
      getAllSessions: vi.fn().mockReturnValue(new Map([['s1', managedSession]])),
      getSessionKey: vi.fn().mockReturnValue('C999:222333.000000'),
      getSessionByKey: vi.fn().mockReturnValue(managedSession),
    };
    const mcpManager = {};

    const handler = new SlackHandler(app as any, claudeHandler as any, mcpManager as any);
    const handlerAny = handler as any;

    const mockSlackApi = {
      getMessage: vi.fn().mockResolvedValue({
        ts: '222333.000000',
        thread_ts: '222333.000000',
        user: 'B999',
      }),
      getBotUserId: vi.fn().mockResolvedValue('B999'),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    };

    handlerAny.slackApi = mockSlackApi;
    handlerAny.inputProcessor = {
      processFiles: vi.fn(),
      routeCommand: vi.fn(),
    };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'D123',
      ts: '555.666',
      text: 'https://workspace.slack.com/archives/C999/p222333000000',
    };

    await handler.handleMessage(event as any, say);

    expect(say).toHaveBeenCalledTimes(1);
    const posted = say.mock.calls[0][0];
    expect(posted.blocks).toBeDefined();
    const actions = posted.blocks.find((b: any) => b.type === 'actions');
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(
      expect.arrayContaining(['managed_message_delete_cancel', 'managed_message_delete_confirm']),
    );
    expect(mockSlackApi.deleteMessage).not.toHaveBeenCalled();
    expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
  });
});
