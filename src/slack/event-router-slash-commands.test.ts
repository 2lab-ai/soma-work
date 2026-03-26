import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration Tests for EventRouter.setupSlashCommands()
 * Trace: docs/slash-commands/trace.md — missing contract tests identified in PR review
 *
 * These tests verify the EventRouter-level slash command handling:
 * - ack() called immediately
 * - Error handling paths with double-fault protection
 * - /session with/without active sessions
 * - /new fallback message
 * - Session-dependent command blocking
 */

// Minimal mocks for Bolt's app.command() pattern
function createMockBoltArgs(overrides: Record<string, any> = {}) {
  return {
    command: {
      command: '/soma',
      text: '',
      user_id: 'U_TEST',
      channel_id: 'C_TEST',
      user_name: 'test',
      team_id: 'T1',
      team_domain: 'test',
      channel_name: 'general',
      api_app_id: 'A1',
      trigger_id: 'tr',
      response_url: 'https://hooks.slack.com/commands/xxx',
      token: 'test',
      ...overrides,
    },
    ack: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

// We test the slash command logic by importing EventRouter and capturing
// the handlers registered via app.command()
describe('EventRouter.setupSlashCommands — integration', () => {
  let handlers: Record<string, Function>;
  let mockApp: any;
  let mockDeps: any;
  let eventRouter: any;

  beforeEach(async () => {
    handlers = {};

    mockApp = {
      command: vi.fn((cmd: string, handler: Function) => {
        handlers[cmd] = handler;
      }),
      message: vi.fn(),
      event: vi.fn(),
    };

    mockDeps = {
      slackApi: {
        getBotUserId: vi.fn().mockResolvedValue('B_BOT'),
        getClient: vi.fn(),
        getChannelInfo: vi.fn(),
        getPermalink: vi.fn(),
        addReaction: vi.fn(),
      },
      claudeHandler: {
        getSession: vi.fn(),
        findSessionBySourceThread: vi.fn(),
        setExpiryCallbacks: vi.fn(),
        cleanupInactiveSessions: vi.fn(),
      },
      sessionManager: {
        formatUserSessionsBlocks: vi.fn(),
        handleSessionWarning: vi.fn(),
        handleSessionSleep: vi.fn(),
        handleSessionExpiry: vi.fn(),
        handleIdleCheck: vi.fn(),
      },
      actionHandlers: {
        registerHandlers: vi.fn(),
      },
      commandDeps: {
        workingDirManager: { parseSetCommand: vi.fn().mockReturnValue(null), isGetCommand: vi.fn().mockReturnValue(false) },
        mcpManager: { getPluginManager: vi.fn() },
        claudeHandler: {},
        sessionUiManager: {},
        requestCoordinator: {},
        slackApi: {},
        reactionManager: {},
        contextWindowManager: {},
      },
    };

    const { EventRouter } = await import('./event-router');
    eventRouter = new EventRouter(mockApp, mockDeps, vi.fn());
    eventRouter.setup();
  });

  // ============================================================
  // Trace S1: Registration
  // ============================================================

  it('registers three slash commands: /soma, /session, /new', () => {
    expect(mockApp.command).toHaveBeenCalledWith('/soma', expect.any(Function));
    expect(mockApp.command).toHaveBeenCalledWith('/session', expect.any(Function));
    expect(mockApp.command).toHaveBeenCalledWith('/new', expect.any(Function));
  });

  // ============================================================
  // Trace S2: /soma — ack() called immediately
  // ============================================================

  it('/soma: ack() is called immediately before any async work', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: 'help' });
    await handlers['/soma']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    // ack must be called before respond
    const ackOrder = ack.mock.invocationCallOrder[0];
    const respondOrder = respond.mock.invocationCallOrder[0];
    expect(ackOrder).toBeLessThan(respondOrder);
  });

  // ============================================================
  // Trace S2: /soma — error handling returns ephemeral
  // ============================================================

  it('/soma: handler exception returns generic ephemeral error (no internal details)', async () => {
    // Force CommandRouter.route() to throw
    const { command, ack, respond } = createMockBoltArgs({
      command: '/soma',
      text: 'help',
    });

    // Override the commandRouter to throw
    const origRouter = (eventRouter as any).commandRouter;
    (eventRouter as any).commandRouter = {
      route: vi.fn().mockRejectedValue(new Error('DB connection failed: host=10.0.0.5')),
    };

    await handlers['/soma']({ command, ack, respond });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
      })
    );
    // Must NOT expose internal error details
    const errorText = respond.mock.calls[0][0].text;
    expect(errorText).not.toContain('DB connection');
    expect(errorText).not.toContain('10.0.0.5');
    expect(errorText).toContain('⚠️');

    // Restore
    (eventRouter as any).commandRouter = origRouter;
  });

  it('/soma: double-fault — respond() failure in catch does not throw', async () => {
    const { command, ack, respond } = createMockBoltArgs({
      command: '/soma',
      text: 'help',
    });

    (eventRouter as any).commandRouter = {
      route: vi.fn().mockRejectedValue(new Error('Original error')),
    };
    respond.mockRejectedValueOnce(new Error('respond() also failed'));

    // Should not throw — double fault is caught internally
    await expect(
      handlers['/soma']({ command, ack, respond })
    ).resolves.not.toThrow();
  });

  // ============================================================
  // P1: Session-dependent commands blocked via slash
  // ============================================================

  it('/soma: session-dependent commands (close, renew, new, context, restore, link) are blocked', async () => {
    const sessionCommands = ['close', 'renew', 'new', 'context', 'restore', 'link'];

    for (const cmd of sessionCommands) {
      const { command, ack, respond } = createMockBoltArgs({
        command: '/soma',
        text: cmd,
      });
      await handlers['/soma']({ command, ack, respond });

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          response_type: 'ephemeral',
        })
      );
      const text = respond.mock.calls[0][0].text;
      expect(text).toContain('스레드 컨텍스트가 필요');
      expect(text).toContain(cmd);
    }
  });

  it('/soma: stateless commands (help, model) are NOT blocked', async () => {
    const { command, ack, respond } = createMockBoltArgs({
      command: '/soma',
      text: 'help',
    });
    await handlers['/soma']({ command, ack, respond });

    // help should be routed to CommandRouter, not blocked
    const text = respond.mock.calls[0][0].text;
    expect(text).not.toContain('스레드 컨텍스트가 필요');
  });

  // ============================================================
  // Trace S4: /session — with and without active sessions
  // ============================================================

  it('/session: with active sessions, returns ephemeral list', async () => {
    mockDeps.sessionManager.formatUserSessionsBlocks.mockResolvedValue({
      text: '2 active sessions',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Session 1' } }],
    });

    const { command, ack, respond } = createMockBoltArgs({ command: '/session' });
    await handlers['/session']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(mockDeps.sessionManager.formatUserSessionsBlocks).toHaveBeenCalledWith(
      'U_TEST',
      { showControls: true }
    );
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '2 active sessions',
        response_type: 'ephemeral',
      })
    );
  });

  it('/session: no active sessions, returns empty message', async () => {
    mockDeps.sessionManager.formatUserSessionsBlocks.mockResolvedValue({
      text: '활성 세션이 없습니다.',
      blocks: [],
    });

    const { command, ack, respond } = createMockBoltArgs({ command: '/session' });
    await handlers['/session']({ command, ack, respond });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '활성 세션이 없습니다.',
        response_type: 'ephemeral',
      })
    );
  });

  it('/session: error returns generic ephemeral error', async () => {
    mockDeps.sessionManager.formatUserSessionsBlocks.mockRejectedValue(
      new Error('Redis timeout')
    );

    const { command, ack, respond } = createMockBoltArgs({ command: '/session' });
    await handlers['/session']({ command, ack, respond });

    const errorText = respond.mock.calls[0][0].text;
    expect(errorText).toContain('⚠️');
    expect(errorText).not.toContain('Redis');
  });

  // ============================================================
  // Trace S5: /new — fallback message
  // ============================================================

  it('/new: always returns fallback message', async () => {
    const { command, ack, respond } = createMockBoltArgs({
      command: '/new',
      text: '',
    });
    await handlers['/new']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
      })
    );
    const text = respond.mock.calls[0][0].text;
    expect(text).toContain('스레드 내에서만');
  });

  it('/new: with prompt, includes prompt in fallback message', async () => {
    const { command, ack, respond } = createMockBoltArgs({
      command: '/new',
      text: 'fix the bug',
    });
    await handlers['/new']({ command, ack, respond });

    const text = respond.mock.calls[0][0].text;
    expect(text).toContain('fix the bug');
  });

  it('/new: error in respond() does not throw', async () => {
    const { command, ack, respond } = createMockBoltArgs({
      command: '/new',
      text: '',
    });
    respond.mockRejectedValueOnce(new Error('response_url expired'));

    await expect(
      handlers['/new']({ command, ack, respond })
    ).resolves.not.toThrow();
  });
});
