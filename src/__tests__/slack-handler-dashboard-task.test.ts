import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import { __resetLastCommandChannelStoreForTests, getLastCommandChannelStore } from '../last-command-channel-store';
import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * Dashboard "New task" (SSOT 2026-10-23 T5/T6) on the message path.
 *
 *   T6 — the composer's autogoal toggle is per task: `autoGoalOverride` on the
 *        event wins over the user's autogoal setting, in both directions.
 *   T5 — "the channel the user last gave a command in" is recorded on every
 *        real (non-synthetic) message in a channel, so the composer can
 *        default to it. DMs and system-generated turns do not count.
 */
describe('SlackHandler — dashboard task overrides + last command channel', () => {
  let claudeHandler: any;
  let registrySession: any;
  let handler: SlackHandler;
  let handlerAny: any;
  let postMessage: ReturnType<typeof vi.fn>;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let routeCommand: ReturnType<typeof vi.fn>;
  let initialize: ReturnType<typeof vi.fn>;
  let autoGoalSpy: any;

  beforeEach(() => {
    vi.restoreAllMocks();

    autoGoalSpy = vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(true);
    __resetLastCommandChannelStoreForTests(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'last-cmd-')), 'last-command-channels.json'),
    );
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'resolveModelInput').mockImplementation((input: string) =>
      input === 'fable' ? ('claude-fable-5' as any) : undefined,
    );
    // The inline `%model` path resolves through the DETAILED resolver, so the
    // stub has to live there too — otherwise the real alias table leaks in and
    // this test starts asserting alias values instead of directive ordering
    // (which is what it is actually for).
    vi.spyOn(userSettingsStore, 'resolveModelInputDetailedWithRefresh').mockImplementation(async (input: string) =>
      input === 'fable' ? { status: 'accepted', modelId: 'claude-fable-5' } : { status: 'unknown' },
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

  it('autoGoalOverride=true starts a goal even when the user setting is off', async () => {
    autoGoalSpy.mockReturnValue(false);
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: 'do the thing', autoGoalOverride: true } as any,
      say,
    );
    expect(registrySession.goal?.objective).toBe('do the thing');
  });

  it('autoGoalOverride=false keeps autogoal off even when the user setting is on', async () => {
    autoGoalSpy.mockReturnValue(true);
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: 'do the thing', autoGoalOverride: false } as any,
      say,
    );
    expect(registrySession.goal).toBeUndefined();
    expect(startWithContinuation).toHaveBeenCalledWith('do the thing', expect.anything(), expect.anything());
  });

  it('no override → the user setting decides (unchanged behaviour)', async () => {
    autoGoalSpy.mockReturnValue(true);
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: 'do the thing' } as any, say);
    expect(registrySession.goal?.objective).toBe('do the thing');
  });

  it('records the channel of a real user message as their last command channel', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: 'do the thing' } as any, say);
    expect(getLastCommandChannelStore().get('U123')).toBe('C123');
  });

  it('a DM or a synthetic turn does not move the last command channel', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage({ user: 'U123', channel: 'C123', ts: '111.222', text: 'first' } as any, say);
    await handler.handleMessage({ user: 'U123', channel: 'D999', ts: '111.333', text: 'dm' } as any, say);
    await handler.handleMessage(
      { user: 'U123', channel: 'C777', ts: '111.444', text: 'auto', synthetic: true } as any,
      say,
    );
    expect(getLastCommandChannelStore().get('U123')).toBe('C123');
  });
});
