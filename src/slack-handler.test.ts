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
});
