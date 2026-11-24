import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

const hostWait = vi.hoisted(() => ({ fn: vi.fn((_c?: string, _t?: string): any => undefined) }));
vi.mock('../work-queue/host-wait', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../work-queue/host-wait')>()),
  hostWaitFor: (channel?: string, threadTs?: string) => hostWait.fn(channel, threadTs),
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
  let beforeDelete: ((key: string, session: any, reason: 'terminated' | 'sleep-expired') => void) | undefined;

  beforeEach(() => {
    hostWait.fn.mockReset();
    hostWait.fn.mockReturnValue(undefined);
    beforeDelete = undefined;
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
      getSessionRegistry: () => ({
        setBeforeSessionDelete: (cb: typeof beforeDelete) => {
          beforeDelete = cb;
        },
      }),
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
      interrupt: () => 'stopped' as const,
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
  it('an admitted replay is no Slack redelivery: the goal-command dedupe does not drop it', async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(message('200.0', { ts: '200.01', text: 'goal 두 번째' }), vi.fn());
    expect(ledger.entries).toHaveLength(1);
    await a.settle();
    // The first arrival recorded this ts as a goal intake: a redelivery of it is dropped …
    handlerAny.isRedeliveredGoalCommand = vi.fn().mockReturnValue(true);
    await handler.handleMessage(message('300.0', { ts: '300.01' }), vi.fn());
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    // … but the queue's replay of it carries its admission and runs.
    queue.release(OWNER);
    await tick();
    await tick();
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    expect(ledger.entries).toEqual([]);
  });

  it('a replay parked for a shutdown has used its entry: it is never replayed a second time', async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(message('200.0', { ts: '200.01' }), vi.fn());
    await a.settle();
    handlerAny.followupShutdownPreparing = true;
    handlerAny.parkDuringShutdownPreparation = vi.fn().mockResolvedValue(undefined);
    queue.release(OWNER);
    await tick();
    expect(handlerAny.parkDuringShutdownPreparation).toHaveBeenCalledTimes(1);
    expect(ledger.entries).toEqual([]);
    handlerAny.followupShutdownPreparing = false;
  });

  it('after a bot-thread migration the running task is the work thread: its key, channel and thread', async () => {
    const a = await startBusy('100.0');
    sessions.set('C123:900.0', { ownerId: OWNER, channelId: 'C9', threadTs: '900.0', title: 'work thread' });
    handlerAny.followupMigration = {
      bySlot: new Map([['C123:100.0', 'C123:900.0']]),
      byCanonical: new Map([['C123:900.0', 'C123:100.0']]),
    };
    const running = handler.runningTasksOf(OWNER);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ sessionKey: 'C123:900.0', channel: 'C9', threadTs: '900.0' });
    handlerAny.followupMigration = undefined;
    await a.settle();
  });
  it('when the running task ends, the chain-settled hook starts the waiting one — no manual release', async () => {
    handler.setUserTaskQueue(queue, () => queue.release(OWNER));
    const a = await startBusy('100.0');
    await handler.handleMessage(message('200.0', { ts: '200.01', text: '두 번째 일' }), vi.fn());
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    await a.settle();
    await tick();
    await tick();
    expect(started.map((e) => e.sessionKey)).toEqual(['C123:200.0']);
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    expect(ledger.entries).toEqual([]);
  });
  it('two first messages in two new threads in the same tick: the second waits (no session exists yet)', async () => {
    sessions.clear();
    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);
    const first = handler.handleMessage(message('500.0', { ts: '500.01' }), vi.fn().mockResolvedValue({ ts: 'x' }));
    const second = handler.handleMessage(message('600.0', { ts: '600.01' }), vi.fn());
    await second;
    expect(ledger.entries.map((e) => e.sessionKey)).toEqual(['C123:600.0']);
    gate.resolve({ hasPendingChoice: false });
    await first;
  });

  // a shared dev host (2026-11-24) — the three gaps a live board showed.
  it('a pr-watch event runs on the slot it reserved; a request sent before it arrives waits', async () => {
    expect(queue.reserveHostTurn(OWNER, 'C123:300.0')).toBe(true);
    await handler.handleMessage(message('200.0', { ts: '200.01' }), vi.fn());
    expect(ledger.entries.map((e) => e.sessionKey)).toEqual(['C123:200.0']);
    await handler.handleMessage(
      message('300.0', { ts: '', synthetic: true, routeContext: { skipAutoBotThread: true, userTaskReady: true } }),
      vi.fn(),
    );
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(ledger.entries.map((e) => e.sessionKey)).toEqual(['C123:200.0']);
  });

  it('a pr-watch event whose reservation is gone runs only into a free slot; at the limit it is dropped, not queued', async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(
      message('300.0', { ts: '', synthetic: true, routeContext: { skipAutoBotThread: true, userTaskReady: true } }),
      vi.fn(),
    );
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(ledger.entries).toEqual([]);
    await a.settle();
  });

  it("closing a thread's session takes its waiting entry out of line; a sleep expiry does not", async () => {
    const a = await startBusy('100.0');
    await handler.handleMessage(message('200.0', { ts: '200.01' }), vi.fn());
    await handler.handleMessage(message('300.0', { ts: '300.01' }), vi.fn());
    expect(ledger.entries.map((e) => e.sessionKey)).toEqual(['C123:200.0', 'C123:300.0']);
    expect(beforeDelete).toBeTypeOf('function');
    beforeDelete?.('C123:300.0', { ownerId: OWNER }, 'sleep-expired');
    expect(ledger.entries).toHaveLength(2);
    beforeDelete?.('C123:200.0', { ownerId: OWNER }, 'terminated');
    expect(ledger.entries.map((e) => e.sessionKey)).toEqual(['C123:300.0']);
    await a.settle();
  });

  it('a running task that holds a deploy/QA lane or waits on an environment hand-off is guarded', async () => {
    const a = await startBusy('100.0');
    hostWait.fn.mockImplementation((_c?: string, t?: string) =>
      t === '100.0' ? { kind: 'running', queue: 'deploy:dev2', since: 1 } : undefined,
    );
    expect(handler.runningTasksOf(OWNER)).toEqual([
      expect.objectContaining({ sessionKey: 'C123:100.0', guard: 'deploy:dev2' }),
    ]);
    hostWait.fn.mockImplementation(() => ({ kind: 'env', owner: 'env:qa', since: 1 }));
    expect(handler.runningTasksOf(OWNER)[0].guard).toBe('env:qa');
    // Waiting in a lane's line is not holding it: that task may be stopped.
    hostWait.fn.mockImplementation(() => ({ kind: 'queued', queue: 'deploy:dev2', position: 2, since: 1 }));
    expect(handler.runningTasksOf(OWNER)[0].guard).toBeUndefined();
    await a.settle();
  });

  // A shared dev host (2026-11-24): Slack resent one app_mention four times (retry_attempt 1..3, reason timeout) and
  // each copy lined up — the same request five times in line, five notices.
  it('a Slack redelivery of a message that waits in line is one entry; each copy still gets its receipt', async () => {
    const a = await startBusy('100.0');
    const accepted = vi.fn();
    handler.onTurnAccepted(CHANNEL, '200.01', accepted);
    for (let i = 0; i < 4; i++) {
      await handler.handleMessage(message('200.0', { ts: '200.01', text: 'review PR #816' }), vi.fn());
    }
    expect(ledger.entries).toHaveLength(1);
    expect(accepted).toHaveBeenCalled();
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    await a.settle();
  });
});
