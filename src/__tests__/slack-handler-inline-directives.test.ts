import { beforeEach, describe, expect, it, vi } from 'vitest';

// No autoskills — keeps dispatchText free of <invoked_skills> noise so the
// autogoal/nogoal assertions stay exact.
vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * Inline session directives in an instruction message:
 *
 *   1. `%model fable {instruction}` — session model change applied FIRST (before
 *      autogoal promotion / dispatch), then the remainder is processed as the
 *      user's instruction ("2건으로 별도 처리").
 *   2. `%nogoal {instruction}` — autogoal is NOT triggered for this message;
 *      the instruction is dispatched as-is.
 */
describe('SlackHandler — inline %model / %nogoal directives', () => {
  let claudeHandler: any;
  let registrySession: any;
  let handler: SlackHandler;
  let handlerAny: any;
  let postMessage: ReturnType<typeof vi.fn>;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let routeCommand: ReturnType<typeof vi.fn>;
  let initialize: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(true);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'resolveModelInput').mockImplementation((input: string) =>
      input === 'fable' ? ('claude-fable-5' as any) : undefined,
    );
    vi.spyOn(userSettingsStore, 'getModelDisplayName').mockReturnValue('Fable' as any);

    const app = { client: {}, assistant: vi.fn() } as any;

    // Fresh-context start: no pre-route session; initialize creates the session.
    registrySession = { ownerId: 'U123', channelId: 'C123', threadTs: '111.222', sessionId: undefined };
    claudeHandler = {
      getSession: vi.fn().mockReturnValue(undefined),
      getSessionByKey: vi.fn().mockReturnValue(registrySession),
      saveSessions: vi.fn(),
    };
    handler = new SlackHandler(app as any, claudeHandler as any, {} as any);
    handlerAny = handler as any;

    postMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage,
      postSystemMessage,
    };

    routeCommand = vi.fn().mockResolvedValue({ handled: false });
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand,
    };

    initialize = vi.fn().mockResolvedValue({
      session: registrySession,
      sessionKey: 'C123:111.222',
      isNewSession: true,
      userName: 'T',
      workingDirectory: '/tmp',
      abortController: new AbortController(),
      halted: false,
    });
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize,
    };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    startWithContinuation = vi.fn().mockResolvedValue(undefined);
    handlerAny.createAgentSession = vi.fn().mockReturnValue({ startWithContinuation });
  });

  it('`%model fable {instruction}`: applies session model BEFORE autogoal, then autogoal fires on the remainder', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: '%model fable do the thing' } as any,
      say,
    );

    // Session model changed (session-scoped, this very turn).
    expect(registrySession.model).toBe('claude-fable-5');

    // Routing and downstream processing saw ONLY the remainder.
    expect(routeCommand.mock.calls[0][0].text).toBe('do the thing');

    // Autogoal promoted the REMAINDER (not the %model prefix) to the goal.
    expect(registrySession.goal?.objective).toBe('do the thing');
    const autogoalCall = postSystemMessage.mock.calls.find((c: any[]) => String(c[1]).includes('Autogoal'));
    expect(autogoalCall, 'autogoal banner should be posted for the remainder').toBeDefined();
    expect(String(autogoalCall?.[1])).toContain('do the thing');
    expect(String(autogoalCall?.[1])).not.toContain('%model');

    // Ordering: model-change ack posted BEFORE the autogoal banner.
    const orderOf = (pred: (c: any[]) => boolean): number => {
      const idx = postSystemMessage.mock.calls.findIndex(pred);
      return idx >= 0 ? (postSystemMessage.mock.invocationCallOrder[idx] as number) : Number.POSITIVE_INFINITY;
    };
    const modelAt = orderOf((c) => String(c[1]).includes('claude-fable-5'));
    const autogoalAt = orderOf((c) => String(c[1]).includes('Autogoal'));
    expect(modelAt).toBeLessThan(autogoalAt);

    // The turn still dispatched.
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
  });

  it('`%nogoal {instruction}`: autogoal is skipped, instruction dispatches as-is', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: '%nogoal do the thing' } as any,
      say,
    );

    // No goal was set, no autogoal banner.
    expect(registrySession.goal).toBeUndefined();
    const autogoalCall = postSystemMessage.mock.calls.find((c: any[]) => String(c[1]).includes('Autogoal'));
    expect(autogoalCall).toBeUndefined();

    // The instruction itself (without the prefix) was dispatched.
    expect(startWithContinuation).toHaveBeenCalledWith('do the thing', expect.anything(), expect.anything());
  });

  it('`%model fable %nogoal {instruction}`: model applies AND autogoal is skipped', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: '%model fable %nogoal do the thing' } as any,
      say,
    );

    expect(registrySession.model).toBe('claude-fable-5');
    expect(registrySession.goal).toBeUndefined();
    expect(startWithContinuation).toHaveBeenCalledWith('do the thing', expect.anything(), expect.anything());
  });

  it('`%model bogus {instruction}`: unknown model → error posted, nothing dispatched', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: '%model bogus do the thing' } as any,
      say,
    );

    const errCall = postSystemMessage.mock.calls.find((c: any[]) => String(c[1]).includes('bogus'));
    expect(errCall, 'unknown-model error should be posted').toBeDefined();
    expect(initialize).not.toHaveBeenCalled();
    expect(startWithContinuation).not.toHaveBeenCalled();
    expect(registrySession.model).toBeUndefined();
  });

  it('bare `%nogoal` (no instruction): usage hint, nothing dispatched', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: '%nogoal' } as any, say);

    expect(initialize).not.toHaveBeenCalled();
    expect(startWithContinuation).not.toHaveBeenCalled();
    expect(postSystemMessage).toHaveBeenCalled();
  });

  it('synthetic events bypass inline directive parsing', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: '%model fable do the thing', synthetic: true } as any,
      say,
    );

    // Text reaches routing untouched; no model change applied.
    expect(routeCommand.mock.calls[0][0].text).toBe('%model fable do the thing');
    expect(registrySession.model).toBeUndefined();
  });
});
