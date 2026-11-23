import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import { getMetricsEmitter } from '../metrics/event-emitter';
import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';
import { emptyLedger, type UserTaskEntry, type UserTaskLedger } from '../user-task-queue/ledger';
import { UNLIMITED, UserTaskQueue } from '../user-task-queue/user-task-queue';

/**
 * The per-user task queue at the ingress (`SlackHandler.handleMessage`): a person who already runs a task in one
 * thread does not start a second thread's turn — it waits in their queue, durably, and starts when the first ends.
 * Only the leaves are faked (Slack API, pipeline, session initializer, agent session); the follow-up dispatcher, the
 * ingress fence and the queue are real.
 */

const CHANNEL = 'C123';
const OWNER = 'U_OWNER';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function message(threadTs: string, overrides: Record<string, any> = {}): any {
  return {
    user: OWNER,
    channel: CHANNEL,
    team: 'T1',
    ts: `${threadTs}1`,
    thread_ts: threadTs,
    text: '할 일',
    ...overrides,
  };
}

describe('SlackHandler — per-user task queue gate', () => {
  let handler: SlackHandler;
  let handlerAny: any;
  let sessions: Map<string, any>;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let queue: UserTaskQueue;
  let limits: Map<string, number>;
  let started: UserTaskEntry[];
  let ledger: UserTaskLedger;

  const keyOf = (channel: string, threadTs?: string) => `${channel}:${threadTs}`;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(getMetricsEmitter(), 'emitFollowupQueue').mockResolvedValue(undefined);
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'isUserAccepted').mockReturnValue(true);

    sessions = new Map();
    const sessionFor = (threadTs: string) => {
      const key = keyOf(CHANNEL, threadTs);
      let s = sessions.get(key);
      if (!s) {
        s = {
          ownerId: OWNER,
          channelId: CHANNEL,
          threadTs,
          threadRootTs: threadTs,
          sessionId: `s-${threadTs}`,
          title: `task ${threadTs}`,
        };
        sessions.set(key, s);
      }
      return s;
    };
    const claudeHandler = {
      getSessionKey: vi.fn((channel: string, threadTs?: string) => keyOf(channel, threadTs)),
      getSession: vi.fn((_c: string, threadTs: string) => sessions.get(keyOf(CHANNEL, threadTs))),
      getSessionByKey: vi.fn((key: string) => sessions.get(key)),
      getAllSessions: vi.fn(() => sessions),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(true),
      setActivityStateByKey: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
      setSteerSignals: vi.fn(),
    };
    const store = { load: () => undefined, save: () => undefined, recoveryWarning: undefined };
    const app = { client: {}, assistant: vi.fn() } as any;
    handler = new SlackHandler(app, claudeHandler as any, {} as any, { followupQueueStore: store });
    handlerAny = handler as any;
    handlerAny.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph' }),
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
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp/work' }),
      initialize: vi.fn().mockImplementation(async (event: any) => ({
        session: sessionFor(event.thread_ts || event.ts),
        sessionKey: keyOf(CHANNEL, event.thread_ts || event.ts),
        isNewSession: false,
        userName: 'Owner',
        workingDirectory: '/tmp/work',
        abortController: new AbortController(),
        halted: false,
      })),
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

    limits = new Map();
    started = [];
    ledger = emptyLedger();
    queue = new UserTaskQueue({
      store: { load: () => undefined, save: (l) => (ledger = l) },
      limitFor: (u) => limits.get(u) ?? 1,
      runningTasks: (u) => handler.runningTasksOf(u),
      start: (entry) => {
        started.push(entry);
        const event =
          entry.kind === 'request'
            ? {
                ...(entry.message as any),
                routeContext: { ...(entry.message as any)?.routeContext, userTaskEntryId: entry.id },
              }
            : {
                user: entry.userId,
                channel: entry.channel,
                thread_ts: entry.threadTs,
                ts: '',
                text: 'resume',
                synthetic: true,
                routeContext: { hostTurn: true, verbatimPrompt: true, userTaskEntryId: entry.id },
              };
        void handler.handleMessage(event, vi.fn().mockResolvedValue({ ts: 'x' }));
      },
      interrupt: () => true,
    });
    handler.setUserTaskQueue(queue);
  });

  afterEach(() => {
    handler.setUserTaskQueue(undefined);
  });

  async function startBusy(threadTs: string): Promise<{ settle: () => Promise<void> }> {
    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);
    const first = handler.handleMessage(message(threadTs), vi.fn().mockResolvedValue({ ts: 'x' }));
    await tick();
    return {
      settle: async () => {
        gate.resolve({ hasPendingChoice: false });
        await first;
      },
    };
  }

  it('a second thread waits while the first runs, durably, and its receipt fires', async () => {
    const a = await startBusy('100.0');
    expect(handler.runningTasksOf(OWNER).map((t) => t.sessionKey)).toEqual(['C123:100.0']);

    const accepted = vi.fn();
    handler.onTurnAccepted(CHANNEL, '200.01', accepted);
    await handler.handleMessage(message('200.0', { ts: '200.01', text: '두 번째 일' }), vi.fn());

    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ sessionKey: 'C123:200.0', state: 'waiting', preview: '두 번째 일' });
    expect(accepted).toHaveBeenCalledTimes(1);

    await a.settle();
    expect(handler.runningTasksOf(OWNER)).toEqual([]);
  });

  it('when the first ends, the waiting one is replayed as it arrived and runs', async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(message('200.0', { ts: '200.01', text: '두 번째 일' }), vi.fn());
    await a.settle();

    queue.release(OWNER);
    await tick();
    await tick();
    expect(started).toHaveLength(1);
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    // The admission was taken by the replay: nothing is left in line.
    expect(ledger.entries).toEqual([]);
  });

  it('an admin is never held', async () => {
    limits.set(OWNER, UNLIMITED);
    const a = await startBusy('100.0');
    await handler.handleMessage(message('200.0', { ts: '200.01' }), vi.fn());
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    expect(ledger.entries).toEqual([]);
    await a.settle();
  });

  it('a host continuation (hostTurn) of another thread passes; a goal continuation of a waiting thread is dropped', async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(
      message('300.0', { ts: '', synthetic: true, routeContext: { hostTurn: true, verbatimPrompt: true } }),
      vi.fn(),
    );
    expect(startWithContinuation).toHaveBeenCalledTimes(2);

    await handler.handleMessage(message('200.0', { ts: '200.01' }), vi.fn());
    expect(ledger.entries).toHaveLength(1);
    await handler.handleMessage(
      message('200.0', { ts: '', synthetic: true, routeContext: { goalContinuation: true } }),
      vi.fn(),
    );
    expect(ledger.entries).toHaveLength(1);
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    await a.settle();
  });

  it('a made-up admission id admits nothing', async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(
      message('200.0', { ts: '200.01', routeContext: { userTaskEntryId: 'forged' } }),
      vi.fn(),
    );
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(ledger.entries).toHaveLength(1);
    await a.settle();
  });

  it('a follow-up in the running thread itself is not a new task (the follow-up queue takes it)', async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(message('100.0', { ts: '100.02', text: '이것도' }), vi.fn());
    expect(ledger.entries).toEqual([]);
    expect(handlerAny.getFollowupQueue().list('C123:100.0')).toHaveLength(1);
    await a.settle();
  });
});
