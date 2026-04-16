import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FIX #1 (PR #509): `app_mention` events that start with `/z` or match a
 * legacy naked command must route through `ZRouter` — the same normalization
 * pipeline as slash and DM. This test file exercises that contract.
 *
 * See: plan/MASTER-SPEC.md §5-1 "3 entry points common normalizeZInvocation".
 */

vi.mock('../channel-registry', () => ({
  registerChannel: vi.fn().mockResolvedValue(null),
  unregisterChannel: vi.fn(),
}));

function buildMockDeps() {
  return {
    slackApi: {
      getBotUserId: vi.fn().mockResolvedValue('B_BOT'),
      getClient: vi.fn().mockReturnValue({
        chat: {
          postEphemeral: vi.fn().mockResolvedValue({ message_ts: 'ep.1' }),
          postMessage: vi.fn().mockResolvedValue({ ts: 'pm.1' }),
          update: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      }),
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

async function setupRouter() {
  const handlers: Record<string, Function> = {};
  const eventHandlers: Record<string, Function> = {};
  const mockApp = {
    command: vi.fn((cmd: string, handler: Function) => {
      handlers[cmd] = handler;
    }),
    message: vi.fn(),
    event: vi.fn((type: string, handler: Function) => {
      eventHandlers[type] = handler;
    }),
  };
  const mockDeps = buildMockDeps();
  const mockMessageHandler = vi.fn().mockResolvedValue(undefined);

  const { EventRouter } = await import('./event-router');
  const eventRouter = new EventRouter(mockApp as any, mockDeps as any, mockMessageHandler as any);
  eventRouter.setup();

  return { handlers, eventHandlers, mockApp, mockDeps, eventRouter: eventRouter as any, mockMessageHandler };
}

describe('EventRouter.app_mention — /z routing (FIX #1)', () => {
  let eventHandlers: Record<string, Function>;
  let mockDeps: ReturnType<typeof buildMockDeps>;
  let eventRouter: any;
  let mockMessageHandler: any;

  beforeEach(async () => {
    ({ eventHandlers, mockDeps, eventRouter, mockMessageHandler } = await setupRouter());
  });

  afterEach(() => {
    eventRouter.cleanup?.();
  });

  it('routes `@bot /z persona` through ZRouter with source=channel_mention', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> /z persona',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const inv = dispatch.mock.calls[0][0];
    expect(inv.source).toBe('channel_mention');
    expect(inv.remainder).toBe('persona');
    // Channel mention must NOT flow through the legacy messageHandler when /z
    // has been routed.
    expect(mockMessageHandler).not.toHaveBeenCalled();
  });

  it('routes legacy naked `@bot persona set linus` through ZRouter (tombstone path)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> persona set linus',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const inv = dispatch.mock.calls[0][0];
    expect(inv.source).toBe('channel_mention');
    expect(inv.isLegacyNaked).toBe(true);
    // Tombstone handled by ZRouter; no pipeline continuation.
    expect(mockMessageHandler).not.toHaveBeenCalled();
  });

  it('forbidden `@bot /z new` (slash-only) IS allowed via channel_mention (not slash)', async () => {
    // Per SLASH_FORBIDDEN semantics, channel_mention is NOT blocked — only
    // slash is. Verify dispatch still happens.
    const dispatch = vi.fn().mockResolvedValue({ handled: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> /z new',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].source).toBe('channel_mention');
  });

  it('whitelisted naked `@bot new` falls through to legacy pipeline', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> new',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    // Whitelisted naked is NOT legacy-naked and does not start with `/z`, so
    // it falls through to the legacy pipeline (session handler takes over).
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler.mock.calls[0][0].text).toBe('new');
  });

  it('unrecognized prose `@bot hello claude` falls through to legacy pipeline', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> hello claude how are you',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler.mock.calls[0][0].text).toBe('hello claude how are you');
  });

  it('ZRouter error (handled=false, error set) surfaces visible notice', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: false, error: 'persona handler boom' });
    eventRouter.zRouter = { dispatch };

    const client = mockDeps.slackApi.getClient() as any;

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> /z persona',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    // ChannelEphemeralZRespond.send() is used for error fallback.
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('명령 실행 실패') }),
    );
  });
});
