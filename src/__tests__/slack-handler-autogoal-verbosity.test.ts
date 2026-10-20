import { getVerbosityFlags, LOG_MINIMAL } from '@soma/slack/output-flags';
import { setStreamExecutorProviders } from '@soma/slack/pipeline/stream-executor';
import type { WorkLogInput } from '@soma/slack/work-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({ buildAutoskillFire: vi.fn(() => null) }));

import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * Spec 10 §3.2-5 — the `🤖 Autogoal: …` notice is a status message: posted only
 * when the session's mask carries `STATUS_MESSAGE` (compact and above), and
 * recorded in the conversation's work log as a `notice` at every level. The
 * goal is still activated and the turn still dispatches the goal prompt.
 */
describe('SlackHandler — autogoal notice follows the session verbosity', () => {
  const recorded: Array<[string, WorkLogInput]> = [];

  beforeEach(() => {
    recorded.length = 0;
    setStreamExecutorProviders({
      appendWorkLog: (conversationId, entry) => {
        recorded.push([conversationId, entry]);
      },
    });
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(true);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
  });

  afterEach(() => {
    setStreamExecutorProviders({ appendWorkLog: () => {} });
    vi.restoreAllMocks();
  });

  async function run(logVerbosity: number | undefined) {
    const registrySession: any = {
      ownerId: 'U123',
      channelId: 'C123',
      threadTs: '111.222',
      conversationId: 'conv-1',
      logVerbosity,
    };
    const claudeHandler = {
      getSession: vi.fn().mockReturnValue(undefined),
      getSessionByKey: vi.fn().mockReturnValue(registrySession),
      saveSessions: vi.fn(),
    };
    const handler = new SlackHandler({ client: {}, assistant: vi.fn() } as any, claudeHandler as any, {} as any);
    const handlerAny = handler as any;

    const postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage,
    };
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false }),
    };
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' }),
      initialize: vi.fn().mockResolvedValue({
        session: registrySession,
        sessionKey: 'C123:111.222',
        isNewSession: true,
        userName: 'T',
        workingDirectory: '/tmp',
        abortController: new AbortController(),
        halted: false,
      }),
    };
    const execute = vi.fn().mockResolvedValue({ success: true, messageCount: 1 });
    handlerAny.streamExecutor = { execute };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };

    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(
      { user: 'U123', channel: 'C123', ts: '111.222', text: 'ship the dashboard' } as any,
      say,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const autogoalPosts = postSystemMessage.mock.calls.filter((c: any[]) => String(c[1]).includes('Autogoal'));
    return { registrySession, autogoalPosts, dispatched: execute.mock.calls[0][0].text as string };
  }

  it('minimal: not posted, recorded once as a notice, the goal still activated and dispatched', async () => {
    const { registrySession, autogoalPosts, dispatched } = await run(LOG_MINIMAL);

    expect(autogoalPosts).toHaveLength(0);
    expect(recorded).toEqual([
      ['conv-1', { kind: 'notice', text: expect.stringContaining('🤖 Autogoal'), ts: expect.any(Number) }],
    ]);
    expect(recorded[0][1].text).toContain('ship the dashboard');
    expect(registrySession.goal?.status).toBe('active');
    expect(registrySession.goal?.objective).toBe('ship the dashboard');
    // D1: autogoal dispatches the user's instruction verbatim.
    expect(dispatched).toBe('ship the dashboard');
  });

  it.each([
    ['compact', getVerbosityFlags('compact')],
    ['unset (read as detail)', undefined],
  ])('%s: posted as today, and recorded', async (_label, mask) => {
    const { autogoalPosts } = await run(mask);

    expect(autogoalPosts).toHaveLength(1);
    expect(autogoalPosts[0][0]).toBe('C123');
    expect(autogoalPosts[0][2]).toEqual({ threadTs: '111.222' });
    expect(recorded).toEqual([['conv-1', { kind: 'notice', text: autogoalPosts[0][1], ts: expect.any(Number) }]]);
  });
});
