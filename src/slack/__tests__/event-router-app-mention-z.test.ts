import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FIX #1 (PR #509, revised by #530): `app_mention` events that start with
 * `/z` must route through `ZRouter` — the same normalization pipeline as
 * slash and DM. Bare `[cmd] [args]` (restored in #530) falls through to the
 * legacy pipeline instead. This test file exercises that contract.
 *
 * See: docs/current/spec/z-command-master-spec.md §5-1 "3 entry points common normalizeZInvocation".
 */

vi.mock('../../channel-registry', () => ({
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

  const { EventRouter } = await import('../event-router');
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

  it('bare `@bot persona set linus` falls through to legacy pipeline (#530)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true });
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

    // Bare text MUST NOT route through ZRouter after #530 (Gate C' removed).
    expect(dispatch).not.toHaveBeenCalled();
    // Fall-through to legacy pipeline with original bare text.
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler.mock.calls[0][0].text).toBe('persona set linus');
  });

  it('bare `@bot model opus-4.7` (no linked session) falls through — ZRouter not called (#530)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> model opus-4.7',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler.mock.calls[0][0].text).toBe('model opus-4.7');
  });

  it('`@bot /z model opus-4.7` still routes through ZRouter (regression guard)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> /z model opus-4.7',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].source).toBe('channel_mention');
  });

  it('bare `@bot model opus-4.7` in source thread with linked session still shows linked-status card (pre-#509 parity)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true });
    eventRouter.zRouter = { dispatch };

    mockDeps.claudeHandler.getSession.mockReturnValue(null);
    mockDeps.claudeHandler.findSessionBySourceThread.mockReturnValue({
      channelId: 'C_WORK',
      threadTs: 'wt.1',
    });
    const linkedStatusSpy = vi.fn();
    (eventRouter as any).respondWithLinkedSessionStatus = linkedStatusSpy;

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '2.2',
        thread_ts: 'src.1',
        text: '<@B_BOT> model opus-4.7',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    // Bare command in source-thread with linked session: ZRouter NOT called,
    // linked-status card IS rendered (pre-#509 intentional exception).
    expect(dispatch).not.toHaveBeenCalled();
    expect(linkedStatusSpy).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler).not.toHaveBeenCalled();
  });

  it('bare `@bot commands` (retired) falls through to legacy pipeline — no tombstone (#530)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ handled: true });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> commands',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler.mock.calls[0][0].text).toBe('commands');
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

  it('`@bot /z new <prompt>` with continueWithPrompt substitutes text and continues pipeline (codex P1 followup)', async () => {
    // ZRouter captures `/z new foo` and returns a `continueWithPrompt`; the
    // app_mention handler must forward the substituted prompt into the legacy
    // pipeline instead of no-opping.
    const dispatch = vi.fn().mockResolvedValue({
      handled: true,
      continueWithPrompt: 'write a failing test',
    });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '1.1',
        text: '<@B_BOT> /z new write a failing test',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    // Pipeline was entered with the substituted text.
    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler.mock.calls[0][0].text).toBe('write a failing test');
    // `/z new` keeps the re-route (a deferred `$skill` remainder relies on it).
    expect(mockMessageHandler.mock.calls[0][0].routeContext?.verbatimPrompt).toBeUndefined();
  });

  it('`@bot /z goal <objective>` marks the returned objective verbatim (review P1, PR #305)', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      handled: true,
      continueWithPrompt: 'new dashboard',
      verbatimPrompt: true,
    });
    eventRouter.zRouter = { dispatch };

    const handler = eventHandlers['app_mention'];
    await handler({
      event: { user: 'U_X', channel: 'C_X', ts: '1.2', text: '<@B_BOT> /z goal new dashboard', team: 'T_X' },
      say: vi.fn(),
    });

    expect(mockMessageHandler).toHaveBeenCalledTimes(1);
    const forwarded = mockMessageHandler.mock.calls[0][0];
    expect(forwarded.text).toBe('new dashboard');
    expect(forwarded.routeContext?.verbatimPrompt).toBe(true);
  });

  it('`@bot /z persona` in a source thread with a linked session bypasses linked-status guard (codex P1 followup)', async () => {
    // Before the fix, the source-thread re-mention guard intercepted any
    // app_mention inside a thread linked to a work session — including `/z`
    // commands. The guard must run AFTER the `/z` gate.
    const dispatch = vi.fn().mockResolvedValue({ handled: true, consumed: true });
    eventRouter.zRouter = { dispatch };

    // Simulate: source thread has a linked work session.
    mockDeps.claudeHandler.getSession.mockReturnValue(null);
    mockDeps.claudeHandler.findSessionBySourceThread.mockReturnValue({
      channelId: 'C_WORK',
      threadTs: 'wt.1',
    });
    // Spy on the "linked status" responder so we can assert it is NOT called.
    const linkedStatusSpy = vi.fn();
    (eventRouter as any).respondWithLinkedSessionStatus = linkedStatusSpy;

    const handler = eventHandlers['app_mention'];
    await handler({
      event: {
        user: 'U_X',
        channel: 'C_X',
        ts: '2.2',
        thread_ts: 'src.1', // in a source thread
        text: '<@B_BOT> /z persona',
        team: 'T_X',
      },
      say: vi.fn(),
    });

    // /z was routed normally.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].source).toBe('channel_mention');
    // Linked-status card was NOT rendered.
    expect(linkedStatusSpy).not.toHaveBeenCalled();
    // Legacy pipeline was NOT invoked (terminal).
    expect(mockMessageHandler).not.toHaveBeenCalled();
  });
});

/**
 * SSOT 2026-10-21 T1, mention variant: `@bot /z goal …` in a thread that
 * already has a session is the same instruction as typing `/z goal …` there.
 * It must reach the host's follow-up fence (which runs a goal command at once
 * and admits the new goal's opening turn with the goal change) instead of
 * running `GoalHandler` inside ZRouter ahead of the fence.
 */
describe('EventRouter.app_mention — `/z goal` in a thread with a session takes the typed path', () => {
  let eventHandlers: Record<string, Function>;
  let mockDeps: ReturnType<typeof buildMockDeps>;
  let eventRouter: any;
  let mockMessageHandler: any;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ eventHandlers, mockDeps, eventRouter, mockMessageHandler } = await setupRouter());
    dispatch = vi.fn().mockResolvedValue({ handled: true, continueWithPrompt: 'x', verbatimPrompt: true });
    eventRouter.zRouter = { dispatch };
  });

  afterEach(() => {
    eventRouter.cleanup?.();
  });

  const mention = (text: string, overrides: Record<string, unknown> = {}) =>
    eventHandlers['app_mention']({
      event: { user: 'U_X', channel: 'C_X', ts: '2.1', thread_ts: '1.0', text, team: 'T_X', ...overrides },
      say: vi.fn(),
    });

  for (const text of ['/z goal 새 목표', '/z goal done', '/z goal 새 목표 $local:z', '/z goal']) {
    it(`hands \`@bot ${text}\` to the host pipeline as typed — never through ZRouter`, async () => {
      mockDeps.claudeHandler.getSession.mockReturnValue({ ownerId: 'U_X' });

      await mention(`<@B_BOT> ${text}`);

      expect(dispatch).not.toHaveBeenCalled();
      expect(mockDeps.claudeHandler.getSession).toHaveBeenCalledWith('C_X', '1.0');
      expect(mockMessageHandler).toHaveBeenCalledTimes(1);
      const forwarded = mockMessageHandler.mock.calls[0][0];
      expect(forwarded.text).toBe(text);
      expect(forwarded.routeContext?.verbatimPrompt, 'still a command, not an objective').toBeUndefined();
    });
  }

  it('keeps ZRouter for `/z goal` when the thread has no session (nothing can be running)', async () => {
    mockDeps.claudeHandler.getSession.mockReturnValue(undefined);

    await mention('<@B_BOT> /z goal 새 목표');

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps ZRouter for `/z goal` at the channel top level', async () => {
    mockDeps.claudeHandler.getSession.mockReturnValue({ ownerId: 'U_X' });

    await mention('<@B_BOT> /z goal 새 목표', { thread_ts: undefined });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps ZRouter for every other `/z` command in a thread with a session', async () => {
    mockDeps.claudeHandler.getSession.mockReturnValue({ ownerId: 'U_X' });
    dispatch.mockResolvedValue({ handled: true, consumed: true });

    await mention('<@B_BOT> /z persona');

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(mockMessageHandler).not.toHaveBeenCalled();
  });

  it('bare `@bot goal …` already reaches the host pipeline with the bot mention stripped', async () => {
    mockDeps.claudeHandler.getSession.mockReturnValue({ ownerId: 'U_X' });

    await mention('<@B_BOT> goal 새 목표');

    expect(dispatch).not.toHaveBeenCalled();
    expect(mockMessageHandler.mock.calls[0][0].text).toBe('goal 새 목표');
  });
});
