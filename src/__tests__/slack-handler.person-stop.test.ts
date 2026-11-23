import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import type { FollowupQueueSnapshot } from '@soma/slack/followup-queue';
import { getMetricsEmitter } from '../metrics/event-emitter';
import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * Z 2026-11-23 (the customer dev host): "내가 어드민인데 … 내가 왜 중지 못함?" — the dashboard stops at 10:50–10:52 reached three
 * of another user's tasks while their turns were still being prepared (the restart had resumed them, no abort controller yet):
 * the stop found nothing to abort, and minutes later the turns ran anyway.
 *
 *   P1  the host records a person's stop (`user-stop`: dashboard 중지, `!`) apart from a shutdown or a close
 *   P2  a person's stop that lands while a turn is being prepared cancels it before the model sees the prompt —
 *       the turn reports `interrupted` / `user-stop`, and a stale `working` goes back to idle
 *   P3  a stop from BEFORE the turn's message came in does not cancel it (the person wrote again after stopping)
 *   P4  `!{prompt}` stops the old turn and runs its own — its own stop does not cancel it
 *
 * The real SlackHandler with its leaves faked, as in slack-handler.instruction-approval.test.ts.
 */

const SESSION_KEY = 'C123:111.222';
const CHANNEL = 'C123';
const THREAD_TS = '111.222';

function message(overrides: Record<string, any> = {}): any {
  return {
    user: 'U_OWNER',
    channel: CHANNEL,
    team: 'T1',
    ts: '222.333',
    thread_ts: THREAD_TS,
    text: '지시',
    ...overrides,
  };
}

describe('SlackHandler — a person’s stop holds (Z 2026-11-23)', () => {
  let handler: SlackHandler;
  let handlerAny: any;
  let registrySession: any;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let claudeHandler: any;
  let duringPreparation: () => void;
  const say = vi.fn().mockResolvedValue({ ts: 'say' });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getMetricsEmitter(), 'emitFollowupQueue').mockResolvedValue(undefined);
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'isUserAccepted').mockReturnValue(true);

    registrySession = {
      ownerId: 'U_OWNER',
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      threadRootTs: THREAD_TS,
      sessionId: 'sess-1',
      activityState: 'working',
    };
    claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
      getSession: vi.fn().mockReturnValue(registrySession),
      getSessionByKey: vi.fn((key: string) => (key === SESSION_KEY ? registrySession : undefined)),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(true),
      setActivityStateByKey: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
    };
    const store = {
      load: () => undefined,
      save: (_snapshot: FollowupQueueSnapshot) => {},
      recoveryWarning: undefined,
    };
    const app = { client: {}, assistant: vi.fn() } as any;
    handler = new SlackHandler(app, claudeHandler, {} as any, { followupQueueStore: store });
    handlerAny = handler as any;
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph' }),
      getUserName: vi.fn().mockResolvedValue('Owner'),
    };
    handlerAny.assistantStatusManager = {
      bumpEpoch: vi.fn().mockReturnValue(1),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    };
    handlerAny.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false }),
    };
    handlerAny.messageValidator = {
      validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/tmp/work' }),
    };
    duringPreparation = () => {};
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp/work' }),
      initialize: vi.fn().mockImplementation(async () => {
        // The window the incident fell into: the turn is being prepared, its controller not registered yet.
        duringPreparation();
        const abortController = new AbortController();
        handlerAny.requestCoordinator.setController(SESSION_KEY, abortController);
        return {
          session: registrySession,
          sessionKey: SESSION_KEY,
          isNewSession: false,
          userName: 'Owner',
          workingDirectory: '/tmp/work',
          abortController,
          halted: false,
        };
      }),
    };
    handlerAny.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
    };
    startWithContinuation = vi.fn().mockResolvedValue({ hasPendingChoice: false });
    handlerAny.createAgentSession = vi.fn().mockImplementation(() => ({
      startWithContinuation,
      getLastTurnSucceeded: () => true,
      getRetryAfterMs: () => undefined,
    }));
  });

  it('P1 the host records a person’s stop apart from a shutdown or a close', () => {
    const coordinator = handler.getRequestCoordinator();
    coordinator.abortSession(SESSION_KEY, 'shutdown');
    expect(registrySession.lastStopAtMs).toBeTypeOf('number');
    expect(registrySession.lastPersonStopAtMs).toBeUndefined();
    coordinator.abortSession(SESSION_KEY, 'session-close');
    expect(registrySession.lastPersonStopAtMs).toBeUndefined();
    coordinator.abortSession(SESSION_KEY, 'user-stop');
    expect(registrySession.lastPersonStopAtMs).toBeTypeOf('number');
  });

  it('P2 a stop that lands while the turn is being prepared cancels it before the model sees the prompt', async () => {
    duringPreparation = () => {
      // No controller yet: the abort finds nothing — what the dashboard did at 10:50:41.
      expect(handler.getRequestCoordinator().abortSession(SESSION_KEY, 'user-stop')).toBe(false);
    };
    const outcome = await handlerAny.processMessage(message({ ts: '400.1' }), say);
    expect(outcome).toEqual({ result: 'interrupted', reason: 'user-stop' });
    expect(startWithContinuation).not.toHaveBeenCalled();
    expect(handler.getRequestCoordinator().isRequestActive(SESSION_KEY)).toBe(false);
    // Nothing runs any more: the card does not keep saying working.
    expect(registrySession.activityState).toBe('idle');
    expect(claudeHandler.broadcastSessionUpdate).toHaveBeenCalled();
  });

  it('P2b a session waiting on its owner’s answer keeps waiting — only a stale `working` goes back to idle', async () => {
    registrySession.activityState = 'waiting';
    duringPreparation = () => {
      handler.getRequestCoordinator().abortSession(SESSION_KEY, 'user-stop');
    };
    const outcome = await handlerAny.processMessage(message({ ts: '400.4' }), say);
    expect(outcome).toEqual({ result: 'interrupted', reason: 'user-stop' });
    expect(registrySession.activityState).toBe('waiting');
  });

  it('P3 a stop from before the message came in does not cancel it — the person wrote again after stopping', async () => {
    handler.getRequestCoordinator().abortSession(SESSION_KEY, 'user-stop');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const outcome = await handlerAny.processMessage(message({ ts: '400.2' }), say);
    expect(outcome.result).not.toBe('interrupted');
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
  });

  it('P4 `!{prompt}` stops the old turn and runs its own — its own stop does not cancel it', async () => {
    await handlerAny.processMessage(message({ ts: '400.3', text: '!이거 대신 해' }), say);
    expect(registrySession.lastPersonStopAtMs).toBeTypeOf('number');
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
  });
});
