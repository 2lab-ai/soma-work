import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration Tests for EventRouter.setupSlashCommands()
 *
 * Phase 1 of #506 — unified `/z` entry point:
 * - `/z` registered as the primary command
 * - `/soma`, `/session`, `/new` are tombstone-redirected to `/z` by default
 * - Set `SOMA_ENABLE_LEGACY_SLASH=true` to restore pre-/z behavior (rollback)
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

function buildMockDeps() {
  return {
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
      workingDirManager: {
        parseSetCommand: vi.fn().mockReturnValue(null),
        isGetCommand: vi.fn().mockReturnValue(false),
      },
      mcpManager: { getPluginManager: vi.fn() },
      claudeHandler: {},
      sessionUiManager: {},
      requestCoordinator: {},
      slackApi: {},
      reactionManager: {},
      contextWindowManager: {},
    },
  };
}

async function setupRouter(opts: { legacyEnabled?: boolean } = {}) {
  if (opts.legacyEnabled) {
    process.env.SOMA_ENABLE_LEGACY_SLASH = 'true';
  } else {
    delete process.env.SOMA_ENABLE_LEGACY_SLASH;
  }

  const handlers: Record<string, Function> = {};
  const mockApp = {
    command: vi.fn((cmd: string, handler: Function) => {
      handlers[cmd] = handler;
    }),
    message: vi.fn(),
    event: vi.fn(),
  };
  const mockDeps = buildMockDeps();

  const { EventRouter } = await import('./event-router');
  const eventRouter = new EventRouter(mockApp as any, mockDeps as any, vi.fn());
  eventRouter.setup();

  return { handlers, mockApp, mockDeps, eventRouter: eventRouter as any };
}

describe('EventRouter.setupSlashCommands — /z unified (default)', () => {
  let handlers: Record<string, Function>;
  let mockApp: any;
  let mockDeps: any;
  let eventRouter: any;

  beforeEach(async () => {
    ({ handlers, mockApp, mockDeps, eventRouter } = await setupRouter());
  });

  afterEach(() => {
    delete process.env.SOMA_ENABLE_LEGACY_SLASH;
  });

  // ============================================================
  // Registration
  // ============================================================

  it('registers /z as the unified entry point', () => {
    expect(mockApp.command).toHaveBeenCalledWith('/z', expect.any(Function));
  });

  it('registers legacy slash commands (/soma, /session, /new) for tombstone-redirect', () => {
    expect(mockApp.command).toHaveBeenCalledWith('/soma', expect.any(Function));
    expect(mockApp.command).toHaveBeenCalledWith('/session', expect.any(Function));
    expect(mockApp.command).toHaveBeenCalledWith('/new', expect.any(Function));
  });

  // ============================================================
  // /z — dispatches to ZRouter
  // ============================================================

  it('/z: ack() is called immediately', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/z', text: 'help' });
    await handlers['/z']({ command, ack, respond });
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('/z: empty text falls back to help', async () => {
    // Force zRouter.dispatch() to return not-handled.
    (eventRouter as any).zRouter = {
      dispatch: vi.fn().mockResolvedValue({ handled: false, consumed: false }),
    };

    const { command, ack, respond } = createMockBoltArgs({ command: '/z', text: '' });
    await handlers['/z']({ command, ack, respond });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
  });

  it('/z: when zRouter is not initialized, responds with init message', async () => {
    (eventRouter as any).zRouter = null;
    const { command, ack, respond } = createMockBoltArgs({ command: '/z', text: 'help' });
    await handlers['/z']({ command, ack, respond });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        text: expect.stringContaining('initializing'),
      }),
    );
  });

  it('/z: handler exception returns generic ephemeral error (no internal details)', async () => {
    (eventRouter as any).zRouter = {
      dispatch: vi.fn().mockRejectedValue(new Error('DB connection failed: host=10.0.0.5')),
    };

    const { command, ack, respond } = createMockBoltArgs({ command: '/z', text: 'help' });
    await handlers['/z']({ command, ack, respond });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    const errorText = respond.mock.calls[0][0].text;
    expect(errorText).not.toContain('DB connection');
    expect(errorText).not.toContain('10.0.0.5');
    expect(errorText).toContain('⚠️');
  });

  it('/z: double-fault — respond() failure in catch does not throw', async () => {
    (eventRouter as any).zRouter = {
      dispatch: vi.fn().mockRejectedValue(new Error('Original error')),
    };

    const { command, ack, respond } = createMockBoltArgs({ command: '/z', text: 'help' });
    respond.mockRejectedValueOnce(new Error('respond() also failed'));

    await expect(handlers['/z']({ command, ack, respond })).resolves.not.toThrow();
  });

  // ============================================================
  // /soma, /session, /new — tombstone redirects
  // ============================================================

  it('/soma: redirects to /z by default', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: 'help' });
    await handlers['/soma']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        text: expect.stringContaining('/z'),
      }),
    );
  });

  it('/soma: respond() failure in redirect does not throw', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: 'help' });
    respond.mockRejectedValueOnce(new Error('response_url expired'));
    await expect(handlers['/soma']({ command, ack, respond })).resolves.not.toThrow();
  });

  it('/session: redirects to /z by default', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/session' });
    await handlers['/session']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        text: expect.stringContaining('/z'),
      }),
    );
    // Legacy sessionManager code path must NOT run.
    expect(mockDeps.sessionManager.formatUserSessionsBlocks).not.toHaveBeenCalled();
  });

  it('/session: respond() failure in redirect does not throw', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/session' });
    respond.mockRejectedValueOnce(new Error('response_url expired'));
    await expect(handlers['/session']({ command, ack, respond })).resolves.not.toThrow();
  });

  it('/new: redirects to /z by default', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/new', text: '' });
    await handlers['/new']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        text: expect.stringContaining('/z'),
      }),
    );
  });

  it('/new: respond() failure in redirect does not throw', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/new', text: '' });
    respond.mockRejectedValueOnce(new Error('response_url expired'));
    await expect(handlers['/new']({ command, ack, respond })).resolves.not.toThrow();
  });
});

describe('EventRouter.setupSlashCommands — legacy rollback (SOMA_ENABLE_LEGACY_SLASH=true)', () => {
  let handlers: Record<string, Function>;
  let mockDeps: any;
  let eventRouter: any;

  beforeEach(async () => {
    ({ handlers, mockDeps, eventRouter } = await setupRouter({ legacyEnabled: true }));
  });

  afterEach(() => {
    delete process.env.SOMA_ENABLE_LEGACY_SLASH;
  });

  // ============================================================
  // /soma — ack() called immediately + CommandRouter path
  // ============================================================

  it('/soma: ack() is called immediately before any async work', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: 'help' });
    await handlers['/soma']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    const ackOrder = ack.mock.invocationCallOrder[0];
    const respondOrder = respond.mock.invocationCallOrder[0];
    expect(ackOrder).toBeLessThan(respondOrder);
  });

  it('/soma: handler exception returns generic ephemeral error (no internal details)', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: 'help' });

    (eventRouter as any).commandRouter = {
      route: vi.fn().mockRejectedValue(new Error('DB connection failed: host=10.0.0.5')),
    };

    await handlers['/soma']({ command, ack, respond });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    const errorText = respond.mock.calls[0][0].text;
    expect(errorText).not.toContain('DB connection');
    expect(errorText).not.toContain('10.0.0.5');
    expect(errorText).toContain('⚠️');
  });

  it('/soma: double-fault — respond() failure in catch does not throw', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: 'help' });

    (eventRouter as any).commandRouter = {
      route: vi.fn().mockRejectedValue(new Error('Original error')),
    };
    respond.mockRejectedValueOnce(new Error('respond() also failed'));

    await expect(handlers['/soma']({ command, ack, respond })).resolves.not.toThrow();
  });

  it('/soma: session-dependent commands (close, renew, new, context, restore, link) are blocked', async () => {
    const sessionCommands = ['close', 'renew', 'new', 'context', 'restore', 'link'];

    for (const cmd of sessionCommands) {
      const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: cmd });
      await handlers['/soma']({ command, ack, respond });

      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
      const text = respond.mock.calls[0][0].text;
      expect(text).toContain('스레드 컨텍스트가 필요');
      expect(text).toContain(cmd);
    }
  });

  it('/soma: all SLASH_FORBIDDEN entries are blocked on legacy rollback (FIX #2)', async () => {
    // Covers all 12 entries in SLASH_FORBIDDEN — previously only the first 6
    // (SESSION_DEPENDENT_COMMANDS) were blocked, leaving `compact` and
    // `session set *` unblocked under rollback. See capability.ts.
    const cases: { text: string; contains: string }[] = [
      { text: 'new', contains: 'new' },
      { text: 'close', contains: 'close' },
      { text: 'renew', contains: 'renew' },
      { text: 'context', contains: 'context' },
      { text: 'restore', contains: 'restore' },
      { text: 'link https://x', contains: 'link' },
      { text: 'compact', contains: 'compact' },
      { text: 'session set model opus', contains: 'session set model' },
      { text: 'session set verbosity 2', contains: 'session set verbosity' },
      { text: 'session set effort high', contains: 'session set effort' },
      { text: 'session set thinking on', contains: 'session set thinking' },
      { text: 'session set thinking_summary on', contains: 'session set thinking_summary' },
    ];

    for (const { text, contains } of cases) {
      const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text });
      await handlers['/soma']({ command, ack, respond });
      const responseText = respond.mock.calls[0][0].text;
      expect(responseText).toContain('스레드 컨텍스트가 필요');
      expect(responseText).toContain(contains);
    }
  });

  it('/soma: stateless commands (help) are NOT blocked', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/soma', text: 'help' });
    await handlers['/soma']({ command, ack, respond });

    const text = respond.mock.calls[0][0].text;
    expect(text).not.toContain('스레드 컨텍스트가 필요');
  });

  // ============================================================
  // /session — legacy path calls sessionManager
  // ============================================================

  it('/session: with active sessions, returns ephemeral list', async () => {
    mockDeps.sessionManager.formatUserSessionsBlocks.mockResolvedValue({
      text: '2 active sessions',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Session 1' } }],
    });

    const { command, ack, respond } = createMockBoltArgs({ command: '/session' });
    await handlers['/session']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(mockDeps.sessionManager.formatUserSessionsBlocks).toHaveBeenCalledWith('U_TEST', {
      showControls: true,
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '2 active sessions',
        response_type: 'ephemeral',
      }),
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
      }),
    );
  });

  it('/session: error returns generic ephemeral error', async () => {
    mockDeps.sessionManager.formatUserSessionsBlocks.mockRejectedValue(new Error('Redis timeout'));

    const { command, ack, respond } = createMockBoltArgs({ command: '/session' });
    await handlers['/session']({ command, ack, respond });

    const errorText = respond.mock.calls[0][0].text;
    expect(errorText).toContain('⚠️');
    expect(errorText).not.toContain('Redis');
  });

  // ============================================================
  // /new — legacy fallback message
  // ============================================================

  it('/new: always returns fallback message', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/new', text: '' });
    await handlers['/new']({ command, ack, respond });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ response_type: 'ephemeral' }));
    const text = respond.mock.calls[0][0].text;
    expect(text).toContain('스레드 내에서만');
  });

  it('/new: with prompt, includes prompt in fallback message', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/new', text: 'fix the bug' });
    await handlers['/new']({ command, ack, respond });

    const text = respond.mock.calls[0][0].text;
    expect(text).toContain('fix the bug');
  });

  it('/new: error in respond() does not throw', async () => {
    const { command, ack, respond } = createMockBoltArgs({ command: '/new', text: '' });
    respond.mockRejectedValueOnce(new Error('response_url expired'));

    await expect(handlers['/new']({ command, ack, respond })).resolves.not.toThrow();
  });
});
