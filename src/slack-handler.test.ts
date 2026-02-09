import { describe, it, expect, vi } from 'vitest';
import { SlackHandler } from './slack-handler';

describe('SlackHandler', () => {
  it('ensures action panel after session initialization', async () => {
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
    const ensurePanel = vi.fn().mockResolvedValue(undefined);
    handlerAny.actionPanelManager = { ensurePanel };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'hello',
    };

    await handler.handleMessage(event as any, say);

    expect(ensurePanel).toHaveBeenCalledTimes(1);
    expect(ensurePanel).toHaveBeenCalledWith(sessionResult.session, sessionResult.sessionKey);
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
    handlerAny.actionPanelManager = { ensurePanel: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg123' });
    const event = {
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: 'hello',
    };

    await handler.handleMessage(event as any, say);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      threadTs: '222.333',
    }));
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
    handlerAny.actionPanelManager = {
      ensurePanel: vi.fn().mockResolvedValue(undefined),
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
      expect.arrayContaining(['managed_message_delete_cancel', 'managed_message_delete_confirm'])
    );
    expect(mockSlackApi.deleteMessage).not.toHaveBeenCalled();
    expect(handlerAny.inputProcessor.processFiles).not.toHaveBeenCalled();
  });
});
