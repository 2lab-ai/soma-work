import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * E2 ⑧ — where the Slack entry sits in `processMessage` (.prd/18 D2 (3)):
 * after command routing and Gate B, before the working folder, the session
 * and the thinking status. The host hands the entry its own allow-list (built
 * from what routing found) next to the router's hint; an answered entry ends
 * the Slack path, an unanswered one leaves it untouched.
 */
describe('SlackHandler — the Slack task entry', () => {
  let claudeHandler: any;
  let handler: SlackHandler;
  let handlerAny: any;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let routeCommand: ReturnType<typeof vi.fn>;
  let initialize: ReturnType<typeof vi.fn>;
  let validateWorkingDirectory: ReturnType<typeof vi.fn>;
  let entry: { run: ReturnType<typeof vi.fn>; guard: ReturnType<typeof vi.fn> };

  const plain = (over: Record<string, unknown> = {}) =>
    ({
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      text: '로그인 버그 고쳐줘',
      routeContext: { taskEntryCandidate: true },
      ...over,
    }) as any;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);

    const registrySession: any = { ownerId: 'U123', channelId: 'C123', threadTs: '111.222', sessionId: undefined };
    claudeHandler = {
      getSession: vi.fn().mockReturnValue(undefined),
      getSessionByKey: vi.fn().mockReturnValue(registrySession),
      saveSessions: vi.fn(),
    };
    handler = new SlackHandler({ client: {}, assistant: vi.fn() } as any, claudeHandler as any, {} as any);
    handlerAny = handler as any;
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
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
    validateWorkingDirectory = vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp' });
    handlerAny.sessionInitializer = { validateWorkingDirectory, initialize };
    handlerAny.threadPanel = { create: vi.fn().mockResolvedValue(undefined) };
    startWithContinuation = vi.fn().mockResolvedValue(undefined);
    handlerAny.createAgentSession = vi.fn().mockReturnValue({ startWithContinuation });

    entry = { run: vi.fn().mockResolvedValue({ result: 'safe' }), guard: vi.fn().mockResolvedValue(false) };
    handler.setTaskEntry(entry as any);
  });

  it('a plain instruction: the entry gets the message, the held say and an all-clear allow-list; answered → no Slack session', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });
    await handler.handleMessage(plain(), say);
    expect(entry.run).toHaveBeenCalledTimes(1);
    const input = entry.run.mock.calls[0][0];
    expect(input.event).toEqual({
      user: 'U123',
      channel: 'C123',
      ts: '111.222',
      thread_ts: undefined,
      text: '로그인 버그 고쳐줘',
    });
    expect(input.allow).toEqual({
      candidate: true,
      dm: false,
      hasSession: false,
      verbatim: false,
      goalOpening: false,
      steer: false,
      inlineDirective: false,
      handled: false,
      continueWithPrompt: false,
      deferredSkillFire: false,
      forceWorkflow: false,
      setGoalObjective: false,
      inlineModel: false,
      inlineNoGoal: false,
      fileCount: 0,
    });
    // Before the working folder and the session: nothing of the Slack path ran.
    expect(validateWorkingDirectory).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(startWithContinuation).not.toHaveBeenCalled();
  });

  it('the entry declines (undefined): the Slack path runs as before', async () => {
    entry.run.mockResolvedValue(undefined);
    await handler.handleMessage(plain(), vi.fn().mockResolvedValue({ ts: 'msg' }));
    expect(entry.run).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
  });

  it('no router hint → candidate false; a thread with a Slack session → hasSession', async () => {
    entry.run.mockResolvedValue(undefined);
    await handler.handleMessage(plain({ routeContext: undefined }), vi.fn().mockResolvedValue({ ts: 'msg' }));
    expect(entry.run.mock.calls[0][0].allow.candidate).toBe(false);

    claudeHandler.getSession.mockReturnValue({ ownerId: 'U123', channelId: 'C123', threadTs: '111.000' });
    await handler.handleMessage(plain({ ts: '111.333', thread_ts: '111.000' }), vi.fn().mockResolvedValue({ ts: 'm' }));
    const second = entry.run.mock.calls[1][0];
    expect(second.allow.hasSession).toBe(true);
    expect(second.event.thread_ts).toBe('111.000');
  });

  it('a command continuation (`/new <prompt>`) is not a task', async () => {
    entry.run.mockResolvedValue(undefined);
    routeCommand.mockResolvedValue({ handled: true, continueWithPrompt: 'do it' });
    await handler.handleMessage(plain({ text: 'new do it' }), vi.fn().mockResolvedValue({ ts: 'm' }));
    expect(entry.run.mock.calls[0][0].allow).toMatchObject({ handled: true, continueWithPrompt: true });
  });

  it('`%nogoal` / `%model` on the message are passed as inline directives', async () => {
    entry.run.mockResolvedValue(undefined);
    vi.spyOn(userSettingsStore, 'resolveModelInputDetailedWithRefresh').mockResolvedValue({
      status: 'accepted',
      modelId: 'claude-fable-5',
    } as any);
    vi.spyOn(userSettingsStore, 'getModelDisplayName').mockReturnValue('Fable' as any);
    await handler.handleMessage(plain({ text: '%nogoal do the thing' }), vi.fn().mockResolvedValue({ ts: 'm' }));
    expect(entry.run.mock.calls[0][0].allow).toMatchObject({ inlineNoGoal: true, inlineDirective: true });
  });

  it('a fully handled command never reaches the entry', async () => {
    routeCommand.mockResolvedValue({ handled: true });
    await handler.handleMessage(plain({ text: 'taskentry on' }), vi.fn().mockResolvedValue({ ts: 'm' }));
    expect(entry.run).not.toHaveBeenCalled();
  });

  it('without an entry (no deliverer at boot) the Slack path is unchanged', async () => {
    handler.setTaskEntry(undefined);
    await handler.handleMessage(plain(), vi.fn().mockResolvedValue({ ts: 'msg' }));
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('the router asks the entry to guard an instruction thread; without an entry nothing is claimed', async () => {
    const guard = handlerAny.eventRouter.deps.guardInstructionThread;
    entry.guard.mockResolvedValue(true);
    const say = vi.fn();
    expect(await guard({ channel: 'C1', ts: '1', thread_ts: '0' }, say)).toBe(true);
    expect(entry.guard).toHaveBeenCalledWith({ channel: 'C1', ts: '1', thread_ts: '0' }, say);
    handler.setTaskEntry(undefined);
    expect(await guard({ channel: 'C1', ts: '2', thread_ts: '0' }, say)).toBe(false);
  });
});
