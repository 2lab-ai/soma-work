import { beforeEach, describe, expect, it, vi } from 'vitest';

// No autoskills — keeps the dispatch text free of <invoked_skills> noise.
vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import type { FollowupQueueSnapshot } from '@soma/slack/followup-queue';
import { getMetricsEmitter } from '../metrics/event-emitter';
import { SlackHandler } from '../slack-handler';
import { userSettingsStore } from '../user-settings-store';

/**
 * Follow-up queue — host integration (`.prd/slack-agent-ui` U3/U4/U5).
 *
 * These tests drive the REAL `FollowupQueue` + `FollowupDispatcher` through the
 * real `SlackHandler` ingress. Only the leaves are faked: the Slack API, the
 * file/command pipeline, the session initializer and the agent session. What is
 * under test is the wiring the SSOT is about — when a message is parked, what is
 * parked, when it runs, and what must NOT happen in between.
 */

const SESSION_KEY = 'C123:111.222';
const CHANNEL = 'C123';
const THREAD_TS = '111.222';

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

function message(overrides: Record<string, any> = {}): any {
  return {
    user: 'U_OWNER',
    channel: CHANNEL,
    team: 'T1',
    ts: '222.333',
    thread_ts: THREAD_TS,
    text: '첫 지시',
    ...overrides,
  };
}

describe('SlackHandler — follow-up queue host', () => {
  let handler: SlackHandler;
  let handlerAny: any;
  let registrySession: any;
  let claudeHandler: any;
  let saved: FollowupQueueSnapshot[];
  let saveError: Error | undefined;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let addReaction: ReturnType<typeof vi.fn>;
  let processFiles: ReturnType<typeof vi.fn>;
  let routeCommand: ReturnType<typeof vi.fn>;
  let initialize: ReturnType<typeof vi.fn>;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let createAgentSession: ReturnType<typeof vi.fn>;
  let abortSession: ReturnType<typeof vi.fn>;
  let lastTurnSucceeded: boolean;
  let emitFollowupQueue: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    saved = [];
    saveError = undefined;
    lastTurnSucceeded = true;

    emitFollowupQueue = vi.spyOn(getMetricsEmitter(), 'emitFollowupQueue').mockResolvedValue(undefined);

    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'isUserAccepted').mockReturnValue(true);

    registrySession = {
      ownerId: 'U_OWNER',
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      threadRootTs: THREAD_TS,
      sessionId: 'sess-1',
    };
    claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue(SESSION_KEY),
      getSession: vi.fn().mockReturnValue(registrySession),
      getSessionByKey: vi.fn().mockReturnValue(registrySession),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(true),
      setActivityStateByKey: vi.fn(),
    };

    const store = {
      load: () => undefined,
      save: (snapshot: FollowupQueueSnapshot) => {
        if (saveError) throw saveError;
        saved.push(JSON.parse(JSON.stringify(snapshot)));
      },
      recoveryWarning: undefined,
    };

    const app = { client: {}, assistant: vi.fn() } as any;
    handler = new SlackHandler(app, claudeHandler as any, {} as any, { followupQueueStore: store });
    handlerAny = handler as any;

    addReaction = vi.fn().mockResolvedValue(undefined);
    postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    handlerAny.slackApi = {
      addReaction,
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage,
    };

    // Setup assistant status (main `0987345`) fires on every non-synthetic
    // message and is awaited once the session migrates threads. Stubbed here
    // exactly as `slack-handler.test.ts` does: the real manager drives the
    // rate-limited Slack queue against a bare `{ client: {} }` app, adding
    // second-scale waits to queue tests that say nothing about status.
    handlerAny.assistantStatusManager = {
      bumpEpoch: vi.fn().mockReturnValue(1),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    };

    // The REAL coordinator, only observed. Replacing it would hide the seam
    // under test: the queue freeze is wired through its `beforeAbort` dep, so a
    // fake would prove nothing about what a real stop does.
    abortSession = vi.spyOn(handlerAny.requestCoordinator, 'abortSession') as any;

    processFiles = vi.fn().mockResolvedValue({ files: [], shouldContinue: true });
    routeCommand = vi.fn().mockResolvedValue({ handled: false });
    handlerAny.inputProcessor = { processFiles, routeCommand };

    handlerAny.messageValidator = {
      validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/tmp/work' }),
    };

    initialize = vi.fn().mockImplementation(async () => ({
      session: registrySession,
      sessionKey: SESSION_KEY,
      isNewSession: false,
      userName: 'Owner',
      workingDirectory: '/tmp/work',
      abortController: new AbortController(),
      halted: false,
    }));
    handlerAny.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp/work' }),
      initialize,
    };

    handlerAny.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
    };

    startWithContinuation = vi.fn().mockResolvedValue({ hasPendingChoice: false });
    createAgentSession = vi.fn().mockImplementation(() => ({
      startWithContinuation,
      getLastTurnSucceeded: () => lastTurnSucceeded,
      getRetryAfterMs: () => undefined,
    }));
    handlerAny.createAgentSession = createAgentSession;
  });

  const say = () => vi.fn().mockResolvedValue({ ts: 'msg' });

  /** Start a turn and leave it running. Resolve the returned gate to settle it. */
  async function startBusyTurn(): Promise<{ settle: () => Promise<void>; first: Promise<void> }> {
    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);
    const first = handler.handleMessage(message(), say());
    await tick();
    return {
      first,
      settle: async () => {
        gate.resolve({ hasPendingChoice: false });
        await first;
      },
    };
  }

  const items = () => handlerAny.getFollowupQueue().list(SESSION_KEY);

  it('parks an active-session follow-up BEFORE any transform, download or abort', async () => {
    const { settle } = await startBusyTurn();

    await handler.handleMessage(
      message({
        user: 'U_OTHER',
        ts: '333.444',
        text: '%model fable 이것도 봐줘',
        files: [
          {
            id: 'F1',
            name: 'log.txt',
            mimetype: 'text/plain',
            filetype: 'text',
            url_private: 'https://x/1',
            url_private_download: 'https://x/1d',
            size: 12,
          },
        ],
      }),
      say(),
    );

    const queued = items();
    expect(queued).toHaveLength(1);
    // RAW text: the `%model` directive is NOT stripped at enqueue (ssot §3.1).
    expect(queued[0].message.text).toBe('%model fable 이것도 봐줘');
    expect(queued[0].message.user).toBe('U_OTHER');
    expect(queued[0].message.files).toHaveLength(1);
    expect(queued[0].state).toBe('queued');

    // The running turn was neither aborted nor superseded, and the follow-up
    // never touched the file/command pipeline.
    expect(abortSession).not.toHaveBeenCalled();
    expect(processFiles).toHaveBeenCalledTimes(1); // the first message only
    expect(routeCommand).toHaveBeenCalledTimes(1);
    expect(startWithContinuation).toHaveBeenCalledTimes(1);

    // Durable first, receipt second — the snapshot exists before the UI claim.
    expect(saved[saved.length - 1].sessions[0].items).toHaveLength(1);
    const receipt = postSystemMessage.mock.calls.find((call: any[]) => String(call[1]).includes('Queue'));
    expect(receipt, 'a visible receipt is posted after the durable write').toBeDefined();

    await settle();
  });

  it('dispatches an idle message immediately and queues nothing', async () => {
    await handler.handleMessage(message(), say());

    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(items()).toHaveLength(0);
  });

  /**
   * Tail anchoring (A36) — the panel can only stay at the bottom of its thread
   * if it hears about EVERY message that lands below it. Bot writes report
   * themselves through the api helper; an inbound human reply never touches it,
   * so the panel sat above the user's own messages until the ingress reported
   * them too. `kind: 'user'` keeps the source of the event honest.
   */
  it('reports an inbound thread reply to the panel so it can re-anchor', async () => {
    const notifyThreadPost = vi.fn();
    handlerAny.slackApi.notifyThreadPost = notifyThreadPost;

    await handler.handleMessage(message({ ts: '333.444' }), say());

    expect(notifyThreadPost).toHaveBeenCalledWith({
      channel: CHANNEL,
      threadTs: THREAD_TS,
      ts: '333.444',
      kind: 'user',
    });
  });

  it('reports nothing for a synthetic turn — no message landed in the thread', async () => {
    const notifyThreadPost = vi.fn();
    handlerAny.slackApi.notifyThreadPost = notifyThreadPost;

    await handler.handleMessage(message({ ts: '333.445', synthetic: true }), say());

    expect(notifyThreadPost).not.toHaveBeenCalled();
  });

  it('claims the next user message at the safe boundary, preserving author and files', async () => {
    const { settle } = await startBusyTurn();

    await handler.handleMessage(
      message({
        user: 'U_OTHER',
        ts: '333.444',
        text: '이것도 봐줘',
        files: [
          {
            id: 'F1',
            name: 'log.txt',
            mimetype: 'text/plain',
            filetype: 'text',
            url_private: 'https://x/1',
            url_private_download: 'https://x/1d',
            size: 12,
          },
        ],
      }),
      say(),
    );
    expect(items()).toHaveLength(1);

    await settle();

    // The drained item ran as a fresh USER dispatch by its ORIGINAL author.
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    const drainedContext = createAgentSession.mock.calls[1][2];
    expect(drainedContext.user).toBe('U_OTHER');
    expect(drainedContext.synthetic).toBeFalsy();
    expect(processFiles.mock.calls[1][0].files).toHaveLength(1);
    expect(items()[0].state).toBe('resolved');
  });

  it('fences two near-simultaneous messages — one dispatches, the other queues', async () => {
    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);

    const first = handler.handleMessage(message({ ts: '222.333', text: '하나' }), say());
    const second = handler.handleMessage(message({ ts: '222.444', text: '둘' }), say());
    await tick();

    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    await second;
    expect(items()).toHaveLength(1);
    expect(items()[0].message.text).toBe('둘');

    gate.resolve({ hasPendingChoice: false });
    await first;
  });

  it('reports a durable failure and posts NO receipt', async () => {
    const { settle } = await startBusyTurn();
    saveError = new Error('disk full');

    await handler.handleMessage(message({ ts: '333.444', text: '저장 못 하는 지시' }), say());

    expect(items()).toHaveLength(0);
    const failure = postSystemMessage.mock.calls.find((call: any[]) => String(call[1]).includes('disk full'));
    expect(failure, 'the failure is explicit').toBeDefined();
    const receipt = postSystemMessage.mock.calls.find((call: any[]) => String(call[1]).includes('Queue에 넣었습니다'));
    expect(receipt, 'no receipt for a message that was not stored').toBeUndefined();

    saveError = undefined;
    await settle();
  });

  it('does not drain while the turn ended waiting for a user choice', async () => {
    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);
    const first = handler.handleMessage(message(), say());
    await tick();

    await handler.handleMessage(message({ ts: '333.444', text: '다음 지시' }), say());
    gate.resolve({ hasPendingChoice: true });
    await first;

    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    expect(items()[0].state).toBe('queued');
  });

  it('keeps paused items paused when a fresh idle message arrives', async () => {
    const { settle } = await startBusyTurn();
    await handler.handleMessage(message({ ts: '333.444', text: '나중 지시' }), say());
    await settle();
    // The drain already ran it; park a second one and freeze via explicit stop.
    const { settle: settle2 } = await startBusyTurn();
    await handler.handleMessage(message({ ts: '444.555', text: '또 다른 지시' }), say());
    await handler.handleMessage(message({ ts: '444.666', text: '!' }), say());
    await settle2();

    const paused = items().find((item: any) => item.message.text === '또 다른 지시');
    expect(paused.state).toBe('paused');

    const dispatchCount = startWithContinuation.mock.calls.length;
    await handler.handleMessage(message({ ts: '555.666', text: '새 지시' }), say());

    // The new message runs; the paused one stays paused (no auto-resume, A27).
    expect(startWithContinuation.mock.calls.length).toBe(dispatchCount + 1);
    expect(items().find((item: any) => item.message.text === '또 다른 지시').state).toBe('paused');
  });

  it('holds the autogoal driver while follow-up work is pending, then releases it once', async () => {
    const goalDriver = vi.fn();
    handler.setGoalTurnSettledHandler(goalDriver);
    registrySession.goal = { goalId: 'g1', status: 'active', objective: '릴리즈', epoch: 0 };

    const { settle } = await startBusyTurn();
    await handler.handleMessage(message({ ts: '333.444', text: '사람 후속 지시' }), say());

    // The turn ends: the goal hook fires while an item is queued.
    handlerAny.handleAssistantTurnCompleteForGoal(registrySession, SESSION_KEY, ['turn text']);
    expect(goalDriver).not.toHaveBeenCalled();
    // The evidence is still stashed — only the driver is held back.
    expect(registrySession.goalLastTurnText).toBe('turn text');

    await settle();

    expect(goalDriver).toHaveBeenCalledTimes(1);
    expect(goalDriver).toHaveBeenCalledWith(SESSION_KEY);
  });

  it('runs an immediate control live while busy, but queues a command that would dispatch', async () => {
    const { settle } = await startBusyTurn();

    await handler.handleMessage(message({ ts: '333.444', text: 'help' }), say());
    expect(items()).toHaveLength(0);
    expect(routeCommand).toHaveBeenCalledTimes(2); // the control was routed live

    await handler.handleMessage(message({ ts: '333.555', text: 'new 테스트 하나 써줘' }), say());
    expect(items()).toHaveLength(1);
    expect(items()[0].message.text).toBe('new 테스트 하나 써줘');
    // A command carrying a prompt must NOT supersede the running turn.
    expect(abortSession).not.toHaveBeenCalled();

    await settle();
  });

  it('never queues a synthetic turn that arrives while a dispatch is live', async () => {
    const { settle } = await startBusyTurn();

    await handler.handleMessage(message({ ts: '333.444', text: 'goal 계속', synthetic: true }), say());

    expect(items()).toHaveLength(0);
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    await settle();
  });

  it('fences a reply in the migrated work thread against the turn that created it', async () => {
    // A first mention migrates into a bot work thread: the dispatch slot was
    // opened under the SOURCE key, but the session now lives under the work
    // thread key (`session-initializer.ts:1238-1239` terminates the source).
    const WORK_KEY = 'C123:999.000';
    claudeHandler.getSessionKey.mockImplementation(
      (channel: string, threadTs?: string) => `${channel}:${threadTs ?? ''}`,
    );
    const workSession = { ...registrySession, threadTs: '999.000', threadRootTs: '999.000' };
    claudeHandler.getSessionByKey.mockImplementation((key: string) =>
      key === WORK_KEY ? workSession : registrySession,
    );
    initialize.mockImplementation(async () => ({
      session: workSession,
      sessionKey: WORK_KEY,
      isNewSession: true,
      userName: 'Owner',
      workingDirectory: '/tmp/work',
      abortController: new AbortController(),
      halted: false,
    }));

    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);
    // Ingress key = source thread `C123:111.222`.
    const first = handler.handleMessage(message({ ts: '222.333', text: '첫 지시' }), say());
    await tick();

    // The reply arrives in the WORK thread — a different session key.
    await handler.handleMessage(message({ ts: '333.444', thread_ts: '999.000', text: '작업 스레드 후속' }), say());

    // It must be parked on the live turn, not dispatched on top of it.
    expect(startWithContinuation).toHaveBeenCalledTimes(1);
    const workItems = handlerAny.getFollowupQueue().list(WORK_KEY);
    expect(workItems).toHaveLength(1);
    expect(workItems[0].message.text).toBe('작업 스레드 후속');

    gate.resolve({ hasPendingChoice: false });
    await first;

    // Drained on the canonical (work-thread) session, which is the one that
    // still exists after the migration.
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    expect(handlerAny.getFollowupQueue().list(WORK_KEY)[0].state).toBe('resolved');
  });

  describe('explicit steer `!{prompt}` (U6)', () => {
    it('never overlaps the running turn: the new dispatch waits for the teardown', async () => {
      const { settle } = await startBusyTurn();

      const steering = handler.handleMessage(message({ ts: '333.444', text: '!대신 이걸 해줘' }), say());
      await tick();

      // The interrupt was SIGNALLED, but the replacement turn must not start
      // until the interrupted run's own teardown has settled
      // (`followup-dispatcher.ts:474` awaits `victim.settled`).
      expect(abortSession).toHaveBeenCalledWith(SESSION_KEY, 'user-interrupted');
      expect(startWithContinuation).toHaveBeenCalledTimes(1);

      await settle();
      await steering;

      expect(startWithContinuation).toHaveBeenCalledTimes(2);
      // The stored item carries the PARSED prompt, so the replacement turn
      // cannot re-enter the abort branch and steer itself recursively.
      const steered = items().find((item: any) => item.message.text === '대신 이걸 해줘');
      expect(steered, 'the steer prompt is stored without its `!`').toBeDefined();
      expect(steered.state).toBe('resolved');
      expect(abortSession).toHaveBeenCalledTimes(1);
      expect(processFiles.mock.calls[1][0].text).toBe('대신 이걸 해줘');
    });

    it('keeps an already-queued peer in FIFO and runs it after the steer', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.111', text: '먼저 들어온 지시' }), say());

      const steering = handler.handleMessage(message({ ts: '333.444', text: '!급한 거 먼저' }), say());
      await tick();
      // The peer is untouched by the steer — not cancelled, not reordered away.
      expect(items().find((item: any) => item.message.text === '먼저 들어온 지시').state).toBe('queued');

      await settle();
      await steering;

      const order = startWithContinuation.mock.calls.length;
      expect(order).toBe(3); // first turn → steer → peer
      expect(items().find((item: any) => item.message.text === '먼저 들어온 지시').state).toBe('resolved');
    });

    it('refuses an unauthorized steer WITHOUT aborting, and keeps the item', async () => {
      claudeHandler.canInterrupt.mockReturnValue(false);
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ user: 'U_STRANGER', ts: '333.444', text: '!내가 가로챌래' }), say());

      // The live turn is untouched — a denial is not an abort.
      expect(abortSession).not.toHaveBeenCalled();
      expect(startWithContinuation).toHaveBeenCalledTimes(1);
      // The instruction is retained, visibly rejected, and still drainable.
      const retained = items().find((item: any) => item.message.text === '내가 가로챌래');
      expect(retained.state).toBe('queued');
      expect(
        postSystemMessage.mock.calls.some((call: any[]) => String(call[1]).includes('큐에 그대로')),
        'the rejection says the item was kept',
      ).toBe(true);

      await settle();
    });

    it('lets only ONE of two simultaneous steers win, keeping the loser queued', async () => {
      const { settle } = await startBusyTurn();

      const a = handler.handleMessage(message({ ts: '333.444', text: '!첫 번째 조종' }), say());
      const b = handler.handleMessage(message({ ts: '333.555', text: '!두 번째 조종' }), say());
      await tick();

      // Single winner: one reservation, one interrupt.
      expect(abortSession).toHaveBeenCalledTimes(1);

      await settle();
      await Promise.all([a, b]);

      // The loser was never consumed — it drained afterwards instead.
      const second = items().find((item: any) => item.message.text === '두 번째 조종');
      expect(second).toBeDefined();
      expect(['resolved', 'queued']).toContain(second.state);
      expect(items().find((item: any) => item.message.text === '첫 번째 조종').state).toBe('resolved');
    });

    it('refreshes the surface only AFTER `sendNow`, never between enqueue and the cut', async () => {
      const { settle } = await startBusyTurn();

      // Order is the contract. A refresh between the enqueue and `sendNow` is an
      // await the settling turn's drain can claim the fresh item in; `sendNow`
      // then returns a stale rejection and the user is told "중단 못했다, 큐에
      // 남아있다" about an item that is already running.
      const order: string[] = [];
      const dispatcher = handlerAny.followupDispatcher;
      const realSendNow = dispatcher.sendNow.bind(dispatcher);
      vi.spyOn(dispatcher, 'sendNow').mockImplementation((...args: any[]) => {
        order.push('sendNow');
        return realSendNow(...args);
      });
      const realRefresh = handlerAny.refreshFollowupSurface.bind(handler);
      vi.spyOn(handlerAny, 'refreshFollowupSurface').mockImplementation((...args: any[]) => {
        order.push('refresh');
        return realRefresh(...args);
      });

      const steering = handler.handleMessage(message({ ts: '333.444', text: '!지금 이걸' }), say());
      await tick();
      await settle();
      await steering;

      expect(order[0], 'the cut is transacted before any surface write').toBe('sendNow');
    });

    it('still treats a bare `!` as an immediate stop', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.111', text: '남겨둘 지시' }), say());

      await handler.handleMessage(message({ ts: '333.444', text: '!' }), say());

      // Bare `!` runs live, aborts with the existing reason, and freezes the
      // queue — it never becomes a queued item.
      expect(abortSession).toHaveBeenCalledWith(SESSION_KEY);
      expect(items()).toHaveLength(1);
      expect(items()[0].state).toBe('paused');
      await settle();
    });
  });

  describe('central stop wiring (U8)', () => {
    const coordinator = () => handlerAny.requestCoordinator;

    it('freezes queued items into `paused` on a stop of an IDLE session', async () => {
      // The turn ends waiting for a user choice, so the drain stays shut and the
      // item is still queued while the session sits idle — exactly the state a
      // "stop" button press finds, with no controller to abort.
      const gate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => gate.promise);
      const first = handler.handleMessage(message(), say());
      await tick();
      await handler.handleMessage(message({ ts: '444.555', text: '대기 중인 지시' }), say());
      gate.resolve({ hasPendingChoice: true });
      await first;
      expect(items()[0].state).toBe('queued');

      const aborted = coordinator().abortSession(SESSION_KEY, 'user-stop');
      expect(aborted, 'no controller: the abort itself is a no-op').toBe(false);

      // …but the stop was still observed.
      expect(items()[0].state).toBe('paused');
      expect(handlerAny.getFollowupQueue().freezeReason(SESSION_KEY)).toBeTruthy();
    });

    it('marks a dispatched item `uncertain`, not paused, when the stop lands mid-run', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '실행될 지시' }), say());

      // Let the drain start the queued item, then stop while it runs.
      const drainGate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => drainGate.promise);
      const finished = settle();
      await tick();
      expect(items()[0].state).toBe('dispatched');

      coordinator().abortSession(SESSION_KEY, 'session-close');
      // A running item's outcome is unknown — calling it `paused` would be a lie.
      expect(items()[0].state).toBe('uncertain');

      drainGate.resolve({ hasPendingChoice: false });
      await finished;
    });

    it('does NOT freeze on a `Send now` interrupt', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.111', text: '뒤에 기다리는 지시' }), say());

      const steering = handler.handleMessage(message({ ts: '333.444', text: '!지금 이걸' }), say());
      await tick();
      // `user-interrupted` is not a stop: the queue must stay live or the very
      // items the user is advancing would be stranded.
      expect(handlerAny.getFollowupQueue().freezeReason(SESSION_KEY)).toBeUndefined();

      await settle();
      await steering;
      expect(items().every((item: any) => item.state !== 'paused')).toBe(true);
    });

    it('refuses the abort when the freeze cannot be persisted', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '저장 실패 시 지시' }), say());

      const controller = new AbortController();
      coordinator().setController(SESSION_KEY, controller);
      saveError = new Error('disk full');

      expect(() => coordinator().abortSession(SESSION_KEY, 'user-stop')).toThrow(/disk full/);
      // A stop that could not be recorded is a stop that did not happen.
      expect(controller.signal.aborted).toBe(false);
      expect(items()[0].state).toBe('queued');

      saveError = undefined;
      coordinator().removeController(SESSION_KEY, controller);
      await settle();
    });

    it('tells the user when a bare `!` stop was refused, and does not claim it stopped', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '남는 지시' }), say());
      saveError = new Error('disk full');

      await handler.handleMessage(message({ ts: '333.555', text: '!' }), say());

      expect(
        postSystemMessage.mock.calls.some((call: any[]) => String(call[1]).includes('중단하지 못했습니다')),
        'the refused stop is explicit',
      ).toBe(true);
      expect(addReaction.mock.calls.some((call: any[]) => call[2] === 'octagonal_sign')).toBe(false);
      expect(items()[0].state).toBe('queued');

      saveError = undefined;
      await settle();
    });
  });

  describe('queue observability (U13b)', () => {
    /** All emitted metrics, flattened to `[sessionKey, userId, userName, metric]`. */
    const emitted = () => emitFollowupQueue.mock.calls.map((call: any[]) => call[3]);
    const opsFor = (operation: string) => emitted().filter((metric: any) => metric.operation === operation);

    it('emits `enqueue` with the ORIGINAL author and no user content', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(
        message({ user: 'U_OTHER', ts: '333.444', text: '비밀 프로젝트 문서를 고쳐줘' }),
        say(),
      );

      const enqueues = opsFor('enqueue');
      expect(enqueues).toHaveLength(1);
      expect(enqueues[0].depth).toBe(1);
      expect(enqueues[0].uncertainCount).toBe(0);
      expect(enqueues[0].itemId).toBe(items()[0].id);

      // Identity travels as the event's author, not inside the metadata.
      const call = emitFollowupQueue.mock.calls.find((c: any[]) => c[3].operation === 'enqueue') as any[];
      expect(call[0]).toBe(SESSION_KEY);
      expect(call[1]).toBe('U_OTHER');

      // No message text / cwd anywhere in what we hand the emitter.
      const serialized = JSON.stringify(emitFollowupQueue.mock.calls);
      expect(serialized).not.toContain('비밀 프로젝트');
      expect(serialized).not.toContain('/tmp/work');

      await settle();
    });

    it('emits nothing for an enqueue whose durable write failed — only a coded reject', async () => {
      const { settle } = await startBusyTurn();
      saveError = new Error('disk full');

      await handler.handleMessage(message({ ts: '333.444', text: '저장 실패' }), say());

      expect(opsFor('enqueue')).toHaveLength(0);
      const rejects = opsFor('reject');
      expect(rejects).toHaveLength(1);
      expect(rejects[0].reason).toBe('persist_failed');
      // Stable code only — never the raw error text.
      expect(JSON.stringify(emitFollowupQueue.mock.calls)).not.toContain('disk full');

      saveError = undefined;
      await settle();
    });

    it('emits a coded reject when the queue is over capacity', async () => {
      process.env.SOMA_FOLLOWUP_QUEUE_CAPACITY = '1';
      const scoped = new SlackHandler({ client: {}, assistant: vi.fn() } as any, claudeHandler as any, {} as any, {
        followupQueueStore: { load: () => undefined, save: () => undefined, recoveryWarning: undefined },
      });
      process.env.SOMA_FOLLOWUP_QUEUE_CAPACITY = undefined as any;
      delete process.env.SOMA_FOLLOWUP_QUEUE_CAPACITY;
      const scopedAny = scoped as any;
      scopedAny.slackApi = handlerAny.slackApi;
      scopedAny.inputProcessor = handlerAny.inputProcessor;
      scopedAny.messageValidator = handlerAny.messageValidator;
      scopedAny.sessionInitializer = handlerAny.sessionInitializer;
      scopedAny.threadPanel = handlerAny.threadPanel;
      scopedAny.createAgentSession = createAgentSession;

      const gate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => gate.promise);
      const first = scoped.handleMessage(message(), say());
      await tick();
      await scoped.handleMessage(message({ ts: '333.111', text: '첫 대기' }), say());
      await scoped.handleMessage(message({ ts: '333.222', text: '넘치는 대기' }), say());

      const rejects = opsFor('reject');
      expect(rejects.some((metric: any) => metric.reason === 'capacity')).toBe(true);

      gate.resolve({ hasPendingChoice: false });
      await first;
    });

    it('reports claim, dispatch and resolve as distinct committed transitions', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '드레인될 지시' }), say());
      await settle();

      const sequence = emitted()
        .map((metric: any) => metric.operation)
        .filter((op: string) => ['enqueue', 'claim', 'dispatch', 'resolve'].includes(op));
      expect(sequence).toEqual(['enqueue', 'claim', 'dispatch', 'resolve']);

      // A drain latency is measured from the previous turn settling to the
      // item actually being dispatched — never inferred from `enqueuedAt`.
      const dispatched = opsFor('dispatch')[0];
      expect(typeof dispatched.drainLatencyMs).toBe('number');
      expect(dispatched.drainLatencyMs).toBeGreaterThanOrEqual(0);
      expect(dispatched.interruptLatencyMs).toBeUndefined();
    });

    it('does not count a `Send now` reservation as a dispatch, and times the interrupt', async () => {
      const { settle } = await startBusyTurn();
      const steering = handler.handleMessage(message({ ts: '333.444', text: '!즉시 이걸' }), say());
      await tick();

      // Reserved, not dispatched: the replacement turn has not started yet.
      expect(opsFor('dispatch')).toHaveLength(0);

      await settle();
      await steering;

      const dispatches = opsFor('dispatch');
      expect(dispatches).toHaveLength(1);
      expect(typeof dispatches[0].interruptLatencyMs).toBe('number');
      expect(dispatches[0].interruptLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('emits a coded reject when a steer is not authorized', async () => {
      claudeHandler.canInterrupt.mockReturnValue(false);
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ user: 'U_STRANGER', ts: '333.444', text: '!가로채기' }), say());

      const rejects = opsFor('reject');
      expect(rejects.some((metric: any) => metric.reason === 'interrupt_denied')).toBe(true);
      expect(JSON.stringify(emitFollowupQueue.mock.calls)).not.toContain('가로채기');
      await settle();
    });
  });

  describe('shutdown preparation (U8 idle gap)', () => {
    /** Leaves one item queued with the session idle (turn ended on a pending choice). */
    async function parkOneAndGoIdle(text = '남겨진 지시'): Promise<void> {
      const gate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => gate.promise);
      const first = handler.handleMessage(message(), say());
      await tick();
      await handler.handleMessage(message({ ts: '444.555', text }), say());
      gate.resolve({ hasPendingChoice: true });
      await first;
    }

    it('freezes an IDLE session that `clearAll` would never visit', async () => {
      await parkOneAndGoIdle();
      expect(items()[0].state).toBe('queued');

      handler.prepareFollowupShutdown();

      // Routed through the coordinator, so the single freeze owner does the work.
      expect(abortSession).toHaveBeenCalledWith(SESSION_KEY, 'shutdown');
      expect(items()[0].state).toBe('paused');
      expect(handlerAny.getFollowupQueue().freezeReason(SESSION_KEY)).toBeTruthy();
    });

    it('preserves uncertainty for an item that was actually running', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '실행 중 지시' }), say());
      const drainGate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => drainGate.promise);
      const finished = settle();
      await tick();
      expect(items()[0].state).toBe('dispatched');

      handler.prepareFollowupShutdown();

      // A running item's side effects are unknown — `paused` would be a lie.
      expect(items()[0].state).toBe('uncertain');

      drainGate.resolve({ hasPendingChoice: false });
      await finished;
    });

    it('stops DISPATCHING new work once preparation succeeded, but still parks it', async () => {
      await parkOneAndGoIdle();
      handler.prepareFollowupShutdown();
      const before = startWithContinuation.mock.calls.length;
      const queuedBefore = items().length;

      await handler.handleMessage(message({ ts: '555.666', text: '셧다운 중 도착' }), say());

      // No turn starts — but the instruction is kept, not dropped.
      expect(startWithContinuation.mock.calls.length).toBe(before);
      expect(items()).toHaveLength(queuedBefore + 1);
      expect(items().at(-1).message.ts).toBe('555.666');
    });

    it('fails loud and keeps accepting work when the freeze cannot be persisted', async () => {
      await parkOneAndGoIdle();
      saveError = new Error('disk full');

      expect(() => handler.prepareFollowupShutdown()).toThrow(/disk full/);
      // Nothing was recorded, so nothing may be reported as stopped.
      expect(items()[0].state).toBe('queued');

      // …and the bot is not stranded: admission is restored.
      saveError = undefined;
      const before = startWithContinuation.mock.calls.length;
      await handler.handleMessage(message({ ts: '555.777', text: '준비 실패 후 도착' }), say());
      expect(startWithContinuation.mock.calls.length).toBe(before + 1);
    });

    it('restores admission when the shutdown is cancelled after a successful prepare', async () => {
      await parkOneAndGoIdle();
      handler.prepareFollowupShutdown();
      const before = startWithContinuation.mock.calls.length;

      // `clearAll` (or anything else in the shutdown chain) refused, so the
      // process stays up — the host must accept work again.
      handler.cancelFollowupShutdownPreparation();

      await handler.handleMessage(message({ ts: '666.777', text: '셧다운 취소 후 도착' }), say());
      expect(startWithContinuation.mock.calls.length).toBe(before + 1);
      // The recorded freeze is NOT undone: cancelling a shutdown does not
      // resume a queue the user never resumed (A27).
      expect(handlerAny.getFollowupQueue().freezeReason(SESSION_KEY)).toBeTruthy();
      expect(items().some((item: any) => item.state === 'paused')).toBe(true);
    });

    it('denies button-driven work during preparation without touching the frozen queue', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '버튼으로 올릴 지시' }), say());
      const item = items()[0];
      handler.prepareFollowupShutdown();
      const frozenReason = handlerAny.getFollowupQueue().freezeReason(SESSION_KEY);
      const statesBefore = items().map((entry: any) => `${entry.id}:${entry.state}`);

      // `Send now` is refused BEFORE it can reserve or abort anything.
      const sendNow = await handlerAny
        .getFollowupDispatcher()
        .sendNow(SESSION_KEY, item.id, item.epoch, 'U_OWNER', handlerAny.getFollowupQueue().getTurnEpoch(SESSION_KEY));
      expect(sendNow.status).toBe('rejected');
      expect(sendNow.reason).toBe('interrupt-denied');
      expect(String(sendNow.detail)).toMatch(/shutdown/i);

      // Resume / Retry share the host's interrupt policy — also denied.
      expect(handlerAny.authorizeFollowupInterrupt(SESSION_KEY, 'U_OWNER').allowed).toBe(false);

      // No auto-drain either.
      await handlerAny.runFollowupDrainLoop(SESSION_KEY);

      expect(abortSession.mock.calls.filter((call: any[]) => call[1] === 'user-interrupted')).toHaveLength(0);
      expect(items().map((entry: any) => `${entry.id}:${entry.state}`)).toEqual(statesBefore);
      expect(handlerAny.getFollowupQueue().freezeReason(SESSION_KEY)).toBe(frozenReason);

      // Cancelling restores admission; queue state is untouched by the restore.
      handler.cancelFollowupShutdownPreparation();
      expect(handlerAny.authorizeFollowupInterrupt(SESSION_KEY, 'U_OWNER').allowed).toBe(true);
      expect(items().map((entry: any) => `${entry.id}:${entry.state}`)).toEqual(statesBefore);

      await settle();
    });

    it('never reuses the `Send now` reason for shutdown', async () => {
      await parkOneAndGoIdle();
      handler.prepareFollowupShutdown();
      expect(abortSession.mock.calls.every((call: any[]) => call[1] !== 'user-interrupted')).toBe(true);
    });
  });

  describe('startup reconcile ordering (A16)', () => {
    /** One `queued` item for `SESSION_KEY`, exactly as U2 would have written it. */
    function snapshotWithQueuedItem(): FollowupQueueSnapshot {
      return {
        version: 1,
        sessions: [
          {
            sessionKey: SESSION_KEY,
            nextSeq: 2,
            turnEpoch: 3,
            items: [
              {
                id: `${SESSION_KEY}#1`,
                sessionKey: SESSION_KEY,
                seq: 1,
                epoch: 1,
                state: 'queued',
                eventKey: `${CHANNEL}:333.444`,
                message: message({ ts: '333.444', text: '재시작 전에 남은 지시' }),
                context: { workingDirectory: '/tmp/work' },
                enqueuedAt: 1,
                updatedAt: 1,
              },
            ],
          },
        ],
      };
    }

    /**
     * Boot a handler over a restored snapshot with an EMPTY registry, the way
     * `index.ts` really does it (`index.ts:487` constructs, `:510` loads).
     * `live` is the registry view; `loadSessions` fills it, or does not.
     */
    function boot(fill: boolean): { handler: SlackHandler; live: Map<string, any> } {
      const live = new Map<string, any>();
      const registryHandler = {
        ...claudeHandler,
        getAllSessions: vi.fn(() => live),
        loadSessions: vi.fn(() => {
          if (fill) live.set(SESSION_KEY, registrySession);
          return live.size;
        }),
      };
      const booted = new SlackHandler({ client: {}, assistant: vi.fn() } as any, registryHandler as any, {} as any, {
        followupQueueStore: {
          load: () => snapshotWithQueuedItem(),
          save: () => undefined,
          recoveryWarning: undefined,
        },
      });
      return { handler: booted, live };
    }

    const stateOf = (h: SlackHandler) => (h as any).getFollowupQueue().list(SESSION_KEY)[0].state;

    it('does not cancel restored items at construction time, when the registry is still empty', () => {
      const { handler: booted } = boot(false);

      // `recover()` turned the queued item into `paused`; the registry Map is
      // empty because `loadSavedSessions()` has not run yet. Treating that as
      // "the session is gone" would cancel the whole queue on every restart.
      expect(stateOf(booted)).toBe('paused');
    });

    it('cancels an orphan only after the registry has actually loaded', () => {
      const { handler: booted } = boot(false);
      booted.loadSavedSessions();

      expect(stateOf(booted)).toBe('cancelled');
    });

    it('leaves items untouched when the session came back with the registry, and is idempotent', () => {
      const { handler: booted } = boot(true);
      booted.loadSavedSessions();
      booted.loadSavedSessions();

      expect(stateOf(booted)).toBe('paused');
    });

    /** The fakes `beforeEach` wires onto the shared handler, onto a booted one. */
    function wire(booted: SlackHandler): void {
      const bootedAny = booted as any;
      bootedAny.slackApi = handlerAny.slackApi;
      bootedAny.inputProcessor = handlerAny.inputProcessor;
      bootedAny.messageValidator = handlerAny.messageValidator;
      bootedAny.sessionInitializer = handlerAny.sessionInitializer;
      bootedAny.threadPanel = handlerAny.threadPanel;
      bootedAny.createAgentSession = createAgentSession;
    }

    const reconcileWarns = (warn: ReturnType<typeof vi.spyOn>) =>
      warn.mock.calls.filter((call: any[]) => /reconcile/i.test(String(call[0])));

    it('stays silent on the real boot order — construct, await, then loadSavedSessions', async () => {
      const { handler: booted } = boot(true);
      const warn = vi.spyOn((booted as any).logger, 'warn');

      // `index.ts:487` constructs, then AWAITS `getAuthContext()` (network)
      // before `:510` loads. Any timer-based watchdog fires inside that gap, so
      // every real restart with pending items would warn falsely.
      await tick();
      booted.loadSavedSessions();
      await tick();

      expect(reconcileWarns(warn)).toHaveLength(0);
    });

    it('warns exactly once when work is admitted before the registry loaded', async () => {
      const { handler: booted } = boot(false);
      wire(booted);
      const warn = vi.spyOn((booted as any).logger, 'warn');

      // Admission, not the clock, is what makes an un-reconciled queue harmful:
      // restored orphans look drainable to the first message that arrives.
      await booted.handleMessage(message({ ts: '333.444', text: '재시작 직후 도착' }), say());
      await booted.handleMessage(message({ ts: '333.555', text: '그 다음 도착' }), say());
      await tick();

      expect(reconcileWarns(warn)).toHaveLength(1);
    });
  });

  /**
   * The restart freeze exists to stop RESTORED items from being replayed blind
   * (A16/A21). It is not a lock on the thread: a message the user sends after
   * the process came back has not run at all, so it steers into the live turn or
   * starts its own, and the panel is the only place the freeze is visible.
   *
   * Live report (2026-09-17, right after the v0.2.1135 restart): a thread whose
   * queue held nothing but resolved history answered every new message with
   * `⏸️ 큐가 멈춰 있어 자동으로 실행되지 않습니다 — process restart`, and nothing
   * ran until a Resume.
   */
  describe('restart freeze scope (live message vs restored items)', () => {
    const RESTORED_TS = '222.100';

    /** One restored row, exactly as U2 would have written it before the restart. */
    function restored(over: Record<string, any> = {}): any {
      return {
        id: `${SESSION_KEY}#1`,
        sessionKey: SESSION_KEY,
        seq: 1,
        epoch: 1,
        state: 'queued',
        eventKey: `${CHANNEL}:${RESTORED_TS}`,
        message: message({ ts: RESTORED_TS, text: '재시작 전에 남은 지시' }),
        context: { workingDirectory: '/tmp/work' },
        enqueuedAt: 1,
        updatedAt: 1,
        ...over,
      };
    }

    /** Boot a handler over a restored snapshot, with the session back in the registry. */
    function bootWith(restoredItems: any[]): SlackHandler {
      const snapshot: FollowupQueueSnapshot = {
        version: 1,
        sessions: [{ sessionKey: SESSION_KEY, nextSeq: restoredItems.length + 1, turnEpoch: 3, items: restoredItems }],
      };
      const registryHandler = {
        ...claudeHandler,
        getAllSessions: vi.fn(() => new Map([[SESSION_KEY, registrySession]])),
        loadSessions: vi.fn(() => 1),
      };
      const booted = new SlackHandler({ client: {}, assistant: vi.fn() } as any, registryHandler as any, {} as any, {
        followupQueueStore: { load: () => snapshot, save: () => undefined, recoveryWarning: undefined },
      });
      const bootedAny = booted as any;
      bootedAny.slackApi = handlerAny.slackApi;
      bootedAny.assistantStatusManager = handlerAny.assistantStatusManager;
      bootedAny.inputProcessor = handlerAny.inputProcessor;
      bootedAny.messageValidator = handlerAny.messageValidator;
      bootedAny.sessionInitializer = handlerAny.sessionInitializer;
      bootedAny.threadPanel = handlerAny.threadPanel;
      bootedAny.createAgentSession = createAgentSession;
      booted.loadSavedSessions();
      return booted;
    }

    /** Start a turn on `booted` and leave it running. */
    async function startBusyTurnOn(booted: SlackHandler): Promise<() => Promise<void>> {
      const gate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => gate.promise);
      const first = booted.handleMessage(message({ ts: '111.900', text: '재시작 후 첫 지시' }), say());
      await tick();
      return async () => {
        gate.resolve({ hasPendingChoice: false });
        await first;
      };
    }

    const queueOf = (booted: SlackHandler) => (booted as any).getFollowupQueue();
    const receipts = () => postSystemMessage.mock.calls.map((call: any[]) => String(call[1]));

    it('does not freeze a session whose restored queue is only history', async () => {
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const booted = bootWith([restored({ state: 'resolved', stateReason: 'consumed' })]);
      const settle = await startBusyTurnOn(booted);

      await booted.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      // Nothing was at risk of a blind replay, so nothing was frozen — and the
      // live message went into the running turn like any other follow-up.
      expect(queueOf(booted).freezeReason(SESSION_KEY)).toBeUndefined();
      expect(steerTurn).toHaveBeenCalledTimes(1);
      const text = receipts().join('\n');
      expect(text).toContain('전달했습니다');
      expect(text).not.toContain('큐가 멈춰');
      await settle();
    });

    it('steers a live message even while restored items keep the session frozen', async () => {
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const booted = bootWith([restored()]);
      expect(queueOf(booted).freezeReason(SESSION_KEY)).toBe('process restart');
      const settle = await startBusyTurnOn(booted);

      await booted.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      expect(steerTurn).toHaveBeenCalledTimes(1);
      const stored = queueOf(booted).list(SESSION_KEY);
      expect(stored.find((item: any) => item.message.ts === '333.444').state).toBe('steered');
      // The restored row is the one the freeze is for: still parked, still
      // waiting for the user's Resume.
      expect(stored.find((item: any) => item.message.ts === RESTORED_TS).state).toBe('paused');
      expect(receipts().join('\n')).toContain('전달했습니다');
      await settle();
    });

    it('runs a live message immediately when the frozen session has no live turn', async () => {
      const booted = bootWith([restored()]);
      expect(queueOf(booted).freezeReason(SESSION_KEY)).toBe('process restart');
      const before = startWithContinuation.mock.calls.length;

      await booted.handleMessage(message({ ts: '333.444', text: '재시작 후 새 지시' }), say());

      // It dispatched as an ordinary new turn — no queue row, no receipt, no
      // Resume in the way.
      expect(startWithContinuation.mock.calls.length).toBe(before + 1);
      expect(receipts().join('\n')).not.toContain('📥');
      expect(
        queueOf(booted)
          .list(SESSION_KEY)
          .map((item: any) => item.message.ts),
      ).toEqual([RESTORED_TS]);
      expect(queueOf(booted).list(SESSION_KEY)[0].state).toBe('paused');
    });

    it('never tells a live message that the queue is stopped, even when it could not be steered', async () => {
      claudeHandler.steerTurn = vi.fn().mockReturnValue(false); // the channel refused the push
      const booted = bootWith([restored()]);
      const settle = await startBusyTurnOn(booted);

      await booted.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      const text = receipts().join('\n');
      expect(text).toContain('📥 Queue에 넣었습니다');
      expect(text).not.toContain('큐가 멈춰');
      // And it is drainable: the freeze holds the restored row, not this one.
      await settle();
      expect(
        queueOf(booted)
          .list(SESSION_KEY)
          .find((item: any) => item.message.ts === '333.444').state,
      ).toBe('resolved');
    });
  });

  describe('messages arriving during shutdown preparation', () => {
    /** Items as the STORE saw them — memory is not evidence of a durable park. */
    const persisted = () =>
      saved[saved.length - 1]?.sessions.find((session: any) => session.sessionKey === SESSION_KEY)?.items ?? [];

    it('parks the instruction DURABLY first, then tells the user how to get it back', async () => {
      handler.prepareFollowupShutdown();
      const before = startWithContinuation.mock.calls.length;

      await handler.handleMessage(message({ ts: '555.888', text: '셧다운 중 도착' }), say());

      // Both Slack writes are best-effort and can vanish with the process; the
      // durable record is the only thing that survives the restart.
      expect(persisted().map((item: any) => [item.message.ts, item.state])).toContainEqual(['555.888', 'queued']);
      expect(
        postSystemMessage.mock.calls.some((call: any[]) => String(call[1]).includes('재시작 준비 중')),
        'the notice says why it did not run and how to resume it',
      ).toBe(true);
      expect(
        postSystemMessage.mock.calls.some((call: any[]) => String(call[1]).includes('Resume')),
        'a restart maps queued → paused, so only an explicit Resume releases it',
      ).toBe(true);
      // Parked, never run: no turn starts while the process is stopping.
      expect(startWithContinuation.mock.calls.length).toBe(before);
    });

    it('names the store failure AND both Slack outcomes when nothing could be parked', async () => {
      handler.prepareFollowupShutdown();
      const logError = vi.spyOn(handlerAny.logger, 'error');
      saveError = new Error('disk full');
      addReaction.mockRejectedValueOnce(new Error('reaction refused'));
      postSystemMessage.mockRejectedValueOnce(new Error('post refused'));

      await handler.handleMessage(message({ ts: '555.999', text: '저장도 안 되는 지시' }), say());

      // Nothing durable, and both best-effort writes failed too — the only
      // trace left is the log, so it has to carry all three facts.
      expect(items()).toHaveLength(0);
      const logged = JSON.stringify(logError.mock.calls);
      expect(logged).toContain('disk full');
      expect(logged).toContain('reaction refused');
      expect(logged).toContain('post refused');
      // …and the writes were attempted even though the park failed.
      expect(addReaction).toHaveBeenCalledWith(CHANNEL, '555.999', expect.any(String));
      expect(postSystemMessage).toHaveBeenCalled();
    });
  });

  describe('dispatch-time working-directory re-authorization (A30/A13)', () => {
    it('dispatches a queued item in the directory it was captured with', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '같은 디렉토리 지시' }), say());
      expect(items()[0].context.workingDirectory).toBe('/tmp/work');

      await settle();

      expect(startWithContinuation).toHaveBeenCalledTimes(2);
      expect(initialize.mock.calls[1][1]).toBe('/tmp/work');
      expect(items()[0].state).toBe('resolved');
    });

    it('refuses the dispatch when the author moved since enqueue, keeping the item queued', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '다른 디렉토리 지시' }), say());
      expect(items()[0].context.workingDirectory).toBe('/tmp/work');

      // The author changed their working directory while the turn was running.
      handlerAny.messageValidator.validateWorkingDirectory.mockReturnValue({
        valid: true,
        workingDirectory: '/tmp/elsewhere',
      });
      handlerAny.sessionInitializer.validateWorkingDirectory.mockResolvedValue({
        valid: true,
        workingDirectory: '/tmp/elsewhere',
      });

      await settle();

      // The stored item must not silently run in a directory nobody authorized.
      expect(startWithContinuation).toHaveBeenCalledTimes(1);
      expect(items()[0].state).toBe('queued');
      expect(String(items()[0].stateReason)).toContain('작업 디렉토리가 변경');
    });

    it('refuses to run when the directory changes BETWEEN authorization and dispatch', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: 'TOCTOU 지시' }), say());

      // The gate (`authorizeFollowupDispatch`, sync) still sees the captured
      // directory; the pipeline's own async re-validation, one await later,
      // sees a different one. Running the newest answer would execute a
      // directory nobody authorized.
      handlerAny.sessionInitializer.validateWorkingDirectory.mockResolvedValue({
        valid: true,
        workingDirectory: '/tmp/elsewhere',
      });

      await settle();

      expect(startWithContinuation).toHaveBeenCalledTimes(1);
      // Already `dispatched` when the mismatch is found, so the honest landing
      // is `failed` + Retry — not a rollback to `queued` from inside the run.
      expect(items()[0].state).toBe('failed');
      expect(String(items()[0].stateReason)).toBe(
        '작업 디렉토리가 변경되어 실행하지 않았습니다 (다시 시도하려면 Retry)',
      );
    });
  });

  it('steers through the slot key when the running turn migrated to a bot work thread', async () => {
    const WORK_KEY = 'C123:999.000';
    claudeHandler.getSessionKey.mockImplementation(
      (channel: string, threadTs?: string) => `${channel}:${threadTs ?? ''}`,
    );
    const workSession = { ...registrySession, threadTs: '999.000', threadRootTs: '999.000' };
    claudeHandler.getSessionByKey.mockImplementation((key: string) =>
      key === WORK_KEY ? workSession : registrySession,
    );
    initialize.mockImplementation(async () => ({
      session: workSession,
      sessionKey: WORK_KEY,
      isNewSession: true,
      userName: 'Owner',
      workingDirectory: '/tmp/work',
      abortController: new AbortController(),
      halted: false,
    }));

    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);
    // The slot was opened under the SOURCE key; the session lives under the work key.
    const first = handler.handleMessage(message({ ts: '222.333', text: '첫 지시' }), say());
    await tick();

    // `!{prompt}` arrives in the WORK thread — busy only via the slot key.
    const steering = handler.handleMessage(
      message({ ts: '333.444', thread_ts: '999.000', text: '!대신 이걸 해줘' }),
      say(),
    );
    await tick();

    // It must cut the running turn instead of falling through to a plain enqueue.
    expect(abortSession).toHaveBeenCalledWith(WORK_KEY, 'user-interrupted');
    expect(startWithContinuation).toHaveBeenCalledTimes(1);

    gate.resolve({ hasPendingChoice: false });
    await first;
    await steering;

    // Exactly one replacement dispatch, run through the slot-owning key.
    expect(startWithContinuation).toHaveBeenCalledTimes(2);
    expect(abortSession.mock.calls.filter((call: any[]) => call[1] === 'user-interrupted')).toHaveLength(1);
    const steered = handlerAny.getFollowupQueue().list(SESSION_KEY);
    expect(steered).toHaveLength(1);
    expect(steered[0].message.text).toBe('대신 이걸 해줘');
    expect(steered[0].state).toBe('resolved');
  });

  it('rejects a non-admin DM before anything is accepted into the queue', async () => {
    claudeHandler.getSessionKey.mockReturnValue('D999:111.222');
    const { settle } = await startBusyTurn();
    handlerAny.sendDmNonAdminRejection = vi.fn().mockResolvedValue(undefined);

    await handler.handleMessage(
      message({ channel: 'D999', user: 'U_STRANGER', ts: '333.444', text: '뭐 좀 해줘' }),
      say(),
    );

    expect(handlerAny.getFollowupQueue().list('D999:111.222')).toHaveLength(0);
    expect(handlerAny.sendDmNonAdminRejection).toHaveBeenCalled();
    await settle();
  });
  /* ---------------------------------------------------------------- *
   * Auto-steering (06 §3.2, D1/D2) — the queued message joins the turn
   * that is ALREADY running instead of waiting for it to end.
   * ---------------------------------------------------------------- */

  describe('auto-steering', () => {
    /** The steering seam a real ClaudeHandler always has; `true` = a live turn took it. */
    function withLiveTurn(pushed = true) {
      const steerTurn = vi.fn().mockReturnValue(pushed);
      claudeHandler.steerTurn = steerTurn;
      return steerTurn;
    }

    /** The uuid the host minted for the one steer it attempted. */
    const steeredUuid = (steerTurn: ReturnType<typeof vi.fn>): string => steerTurn.mock.calls[0][1].uuid;

    const receipts = () => postSystemMessage.mock.calls.map((call: any[]) => String(call[1]));

    it('pushes a queued follow-up into the live turn under the session key', async () => {
      const steerTurn = withLiveTurn();
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      expect(steerTurn).toHaveBeenCalledTimes(1);
      // The steering registry is keyed by the executor's own session key —
      // a `channel:ts` guess would find no live turn.
      expect(steerTurn.mock.calls[0][0]).toBe(SESSION_KEY);
      expect(steerTurn.mock.calls[0][1]).toMatchObject({ text: '이것도 같이 봐줘' });
      expect(typeof steeredUuid(steerTurn)).toBe('string');
      await settle();
    });

    it('marks the item steered and says the running turn got it', async () => {
      withLiveTurn();
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      const queued = items();
      expect(queued).toHaveLength(1);
      expect(queued[0].state).toBe('steered');
      expect(queued[0].steerUuid).toBeTruthy();
      expect(receipts().join('\n')).toContain('전달했습니다');
      await settle();
    });

    it('steers the FORMATTED prompt when the message carries files (D2)', async () => {
      const steerTurn = withLiveTurn();
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockResolvedValue({ files: processed, shouldContinue: true });
      const formatFilePrompt = vi.fn().mockResolvedValue('이 로그 봐줘\n\nUploaded files:\n/tmp/log.txt');
      const cleanupTempFiles = vi.fn().mockResolvedValue(undefined);
      handlerAny.fileHandler = { formatFilePrompt, cleanupTempFiles };
      const { settle } = await startBusyTurn();

      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '이 로그 봐줘',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        say(),
      );

      expect(formatFilePrompt).toHaveBeenCalledWith(processed, '이 로그 봐줘');
      expect(steerTurn.mock.calls[0][1].text).toBe('이 로그 봐줘\n\nUploaded files:\n/tmp/log.txt');
      // Still on disk: the model reads the paths at the next tool boundary.
      expect(cleanupTempFiles).not.toHaveBeenCalled();
      await settle();
    });

    it('keeps the plain receipt and the queued item when no live turn takes the push', async () => {
      withLiveTurn(false);
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      const queued = items();
      expect(queued).toHaveLength(1);
      expect(queued[0].state).toBe('queued');
      const text = receipts().join('\n');
      expect(text).toContain('📥 Queue에 넣었습니다');
      expect(text).not.toContain('전달했습니다');
      await settle();
    });

    it('cleans up downloaded files when the push is refused', async () => {
      withLiveTurn(false);
      const cleanupTempFiles = vi.fn().mockResolvedValue(undefined);
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockResolvedValue({ files: processed, shouldContinue: true });
      handlerAny.fileHandler = { formatFilePrompt: vi.fn().mockResolvedValue('t'), cleanupTempFiles };
      const { settle } = await startBusyTurn();

      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '이 로그 봐줘',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        say(),
      );

      expect(cleanupTempFiles).toHaveBeenCalledWith(processed);
      await settle();
    });

    it('never loses the stored item when the steer path throws', async () => {
      claudeHandler.steerTurn = vi.fn(() => {
        throw new Error('registry exploded');
      });
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      const queued = items();
      expect(queued).toHaveLength(1);
      expect(queued[0].state).toBe('queued');
      expect(receipts().join('\n')).toContain('📥 Queue에 넣었습니다');
      await settle();
    });

    /**
     * A freeze parks the items that were already in the queue when it happened.
     * The message the user sends AFTER it is not one of them — it has not run,
     * it is going into a turn that is still alive, and telling the user it is
     * held until a Resume is a false receipt (2026-09-17 live report).
     */
    it('steers a message that arrived AFTER the freeze into the live turn', async () => {
      const steerTurn = withLiveTurn();
      const { settle } = await startBusyTurn();
      handlerAny.getFollowupQueue().freeze(SESSION_KEY, '사용자가 중지했습니다');

      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());

      expect(steerTurn).toHaveBeenCalledTimes(1);
      expect(items()[0].state).toBe('steered');
      const text = receipts().join('\n');
      expect(text).toContain('전달했습니다');
      expect(text).not.toContain('큐가 멈춰');
      await settle();
    });

    /**
     * Steering hands the RAW text to the model, so anything the dispatch path
     * would have to interpret first must not be steered. A `control-with-dispatch`
     * command (`new`/`goal`/`$skill`/`compact`) only means what it says after
     * `processMessage` re-routes it (`command-router.ts:380-414`); steered, the
     * model would read the literal string as an instruction and the command
     * would never run.
     */
    for (const text of ['goal 릴리즈까지 끌고 가줘', 'new 테스트 하나 써줘', '$autoz 이거 해줘', 'compact']) {
      it(`queues \`${text}\` instead of steering it — it has to re-route through dispatch`, async () => {
        const steerTurn = withLiveTurn();
        const { settle } = await startBusyTurn();

        await handler.handleMessage(message({ ts: '333.444', text }), say());

        expect(steerTurn).not.toHaveBeenCalled();
        expect(items()).toHaveLength(1);
        expect(items()[0].state).toBe('queued');
        expect(receipts().join('\n')).toContain('📥 Queue에 넣었습니다');
        await settle();
      });
    }

    /**
     * `/z <instruction>` is the SAME turn with a routing prefix the dispatch
     * path strips (`command-router.ts:396-399` / `z/strip-z-prefix.ts:24`).
     * Steering pushes the text UNSTRIPPED, so the model would read the literal
     * `/z` as part of the instruction.
     */
    it('queues a `/z` prefixed message instead of steering the unstripped text', async () => {
      const steerTurn = withLiveTurn();
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ ts: '333.444', text: '/z 이것도 같이 봐줘' }), say());

      expect(steerTurn).not.toHaveBeenCalled();
      expect(items()).toHaveLength(1);
      expect(items()[0].state).toBe('queued');
      expect(items()[0].message.text).toBe('/z 이것도 같이 봐줘');
      await settle();
    });

    /**
     * `!{prompt}` is the explicit steer form, and the `!` is stripped by
     * `parseSteerPrompt` (`slack-handler.ts:2161`) before the dispatcher sees
     * it. It reaches the AUTO-steer path only through the slot race
     * (`slack-handler.ts:939`): `handleMessage` saw an idle slot, so the
     * explicit-steer branch was skipped, and `runInitial` then lost the slot
     * inside the same tick. Pushed from here the text is unstripped, so the
     * model would read the leading `!` as prose.
     */
    it('queues `!{prompt}` instead of steering it when the slot is lost in the same tick', async () => {
      const steerTurn = withLiveTurn();
      const { settle } = await startBusyTurn();
      const dispatcher = handlerAny.followupDispatcher;
      const realIsBusy = dispatcher.isBusy.bind(dispatcher);
      // Exactly the race: the ingress check says idle, the dispatch says busy.
      vi.spyOn(dispatcher, 'isBusy')
        .mockImplementationOnce(() => false)
        .mockImplementation(realIsBusy);

      await handler.handleMessage(message({ ts: '333.444', text: '!이것도 같이 봐줘' }), say());

      expect(steerTurn).not.toHaveBeenCalled();
      expect(items()).toHaveLength(1);
      expect(items()[0].state).toBe('queued');
      expect(items()[0].message.text).toBe('!이것도 같이 봐줘');
      await settle();
    });

    /**
     * The classifier runs AFTER the durable enqueue, so a throw from it used to
     * escape `trySteerFollowup` entirely — past the receipt, out of
     * `handleMessage`. The item was stored and the user was told nothing.
     * Everything after the enqueue is best effort: a throwing classifier is the
     * plain queue path plus a warning.
     */
    it('falls back to the plain queue path when the classifier throws', async () => {
      const steerTurn = withLiveTurn();
      const { settle } = await startBusyTurn();
      // Installed only for the FOLLOW-UP: its call 1 is `isQueueableFollowup`
      // (before the enqueue, where a throw is still safe), call 2 is
      // `isSteerableText` — the one that runs after the item is durable.
      handlerAny.commandRouter.classifyText = vi
        .fn()
        .mockReturnValueOnce('instruction')
        .mockImplementation(() => {
          throw new Error('classifier exploded');
        });

      await expect(
        handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say()),
      ).resolves.toBeUndefined();

      expect(steerTurn).not.toHaveBeenCalled();
      expect(items()).toHaveLength(1);
      expect(items()[0].state).toBe('queued');
      expect(receipts().join('\n')).toContain('📥 Queue에 넣었습니다');
      await settle();
    });

    /**
     * `%model opus 해줘` is a TURN carrying a session directive: the directive is
     * stripped and applied by the dispatch path (`slack-handler.ts:1085`).
     * Steered, the `%model opus` prefix would reach the model as prose and the
     * model swap would silently not happen.
     */
    it('queues a message carrying an inline `%` directive instead of steering it', async () => {
      const steerTurn = withLiveTurn();
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ ts: '333.444', text: '%model opus 이것도 같이 봐줘' }), say());

      expect(steerTurn).not.toHaveBeenCalled();
      expect(items()[0].state).toBe('queued');
      expect(items()[0].message.text).toBe('%model opus 이것도 같이 봐줘');
      await settle();
    });

    /**
     * Steering is an interrupt of someone else's running turn, so it takes the
     * SAME authorization `Send now` takes (`slack-handler.ts:3082`). Without it
     * any thread member could inject text into the owner's live turn — a right
     * no button in this UI grants them.
     */
    it('does not steer a reply from someone who may not interrupt the session', async () => {
      const steerTurn = withLiveTurn();
      claudeHandler.canInterrupt.mockImplementation(
        (_channel: string, _threadTs: string, user: string) => user === 'U_OWNER',
      );
      const { settle } = await startBusyTurn();

      await handler.handleMessage(message({ user: 'U_STRANGER', ts: '333.444', text: '이것도 같이 봐줘' }), say());

      expect(steerTurn).not.toHaveBeenCalled();
      expect(items()).toHaveLength(1);
      expect(items()[0].state).toBe('queued');
      expect(receipts().join('\n')).toContain('📥 Queue에 넣었습니다');
      await settle();
    });

    /**
     * The push was refused AND the rollback could not be persisted, so the row
     * is stuck `steered` — the one case where "큐에 넣었습니다" would be a lie
     * about a state the panel is about to show differently.
     */
    it('says the state is undetermined when the rollback of a refused push failed', async () => {
      withLiveTurn(false);
      const { settle } = await startBusyTurn();
      // enqueue commits, steer commits, the rollback's commit is the one that dies.
      let writes = 0;
      const store = handlerAny.followupStore;
      const realSave = store.save;
      store.save = (snapshot: FollowupQueueSnapshot) => {
        writes += 1;
        if (writes === 3) throw new Error('disk full');
        realSave(snapshot);
      };

      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());
      store.save = realSave;

      expect(items()[0].state).toBe('steered');
      const text = receipts().join('\n');
      expect(text).toContain('⚠️ 전달 중 오류로 항목 상태를 확정하지 못했습니다');
      expect(text).not.toContain('📥 Queue에 넣었습니다');
      await settle();
    });

    it('cleans up downloaded files when the formatted prompt turns out to be empty', async () => {
      withLiveTurn();
      const cleanupTempFiles = vi.fn().mockResolvedValue(undefined);
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockResolvedValue({ files: processed, shouldContinue: true });
      handlerAny.fileHandler = { formatFilePrompt: vi.fn().mockResolvedValue('   '), cleanupTempFiles };
      const { settle } = await startBusyTurn();

      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        say(),
      );

      expect(cleanupTempFiles).toHaveBeenCalledWith(processed);
      expect(items()[0].state).toBe('queued');
      await settle();
    });

    /**
     * `processFiles` announces "📎 Processing N file(s)" through the raw Bolt
     * `say` (`input-processor.ts:106-110`). On the steer path that post is an
     * untracked bot message landing UNDER the queue panel, which the panel then
     * has to chase. The download still happens; only the announcement is
     * silenced — the receipt below it already says the message was delivered.
     */
    it('downloads the files without posting the untracked "Processing files" notice', async () => {
      withLiveTurn();
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockImplementation(async (_event: any, sayFn: any) => {
        await sayFn({ text: '📎 Processing 1 file(s): log.txt' });
        return { files: processed, shouldContinue: true };
      });
      handlerAny.fileHandler = {
        formatFilePrompt: vi.fn().mockResolvedValue('이 로그 봐줘\n\n/tmp/log.txt'),
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      };
      const { settle } = await startBusyTurn();
      const bolt = say();

      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '이 로그 봐줘',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        bolt,
      );

      expect(processFiles).toHaveBeenCalled();
      expect(bolt).not.toHaveBeenCalled();
      expect(items()[0].state).toBe('steered');
      await settle();
    });
  });

  /* ---------------------------------------------------------------- *
   * Settlement — the SDK's lifecycle frames decide what a steered item became.
   * ---------------------------------------------------------------- */

  describe('steer settlement', () => {
    /** Steer one message into the running turn and hand back its uuid. */
    async function steerOne(): Promise<{ uuid: string; itemId: string; settle: () => Promise<void> }> {
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());
      expect(items()[0].state).toBe('steered');
      return { uuid: steerTurn.mock.calls[0][1].uuid, itemId: items()[0].id, settle };
    }

    /** The hook the host handed to the executor — the only path the SDK's answer arrives on. */
    const lifecycle = () => handlerAny.streamExecutor.deps.onSteerLifecycle;

    it('wires onSteerLifecycle into the StreamExecutor', () => {
      expect(typeof lifecycle()).toBe('function');
    });

    it('resolves the item as consumed when the model read it', async () => {
      const { uuid, settle } = await steerOne();

      await lifecycle()({ sessionKey: SESSION_KEY, uuid, phase: 'completed' });

      const [item] = items();
      expect(item.state).toBe('resolved');
      expect(item.stateReason).toBe('consumed');
      await settle();
    });

    it('returns a discarded message to the queue so the drain still runs it', async () => {
      const { uuid, settle } = await steerOne();

      await lifecycle()({ sessionKey: SESSION_KEY, uuid, phase: 'discarded' });

      const [item] = items();
      expect(item.state).toBe('queued');
      expect(item.steerUuid).toBeUndefined();
      await settle();
    });

    it('returns a cancelled message to the queue with its own reason', async () => {
      const { uuid, settle } = await steerOne();

      await lifecycle()({ sessionKey: SESSION_KEY, uuid, phase: 'cancelled' });

      const [item] = items();
      expect(item.state).toBe('queued');
      expect(item.stateReason).toBe('취소됨');
      await settle();
    });

    it('leaves the item alone for started/observed — neither is a settlement', async () => {
      const { uuid, settle } = await steerOne();

      await lifecycle()({ sessionKey: SESSION_KEY, uuid, phase: 'started' });
      await lifecycle()({ sessionKey: SESSION_KEY, uuid, phase: 'observed' });

      expect(items()[0].state).toBe('steered');
      await settle();
    });

    it('cleans up the steered files once the turn settled the message', async () => {
      const cleanupTempFiles = vi.fn().mockResolvedValue(undefined);
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockResolvedValue({ files: processed, shouldContinue: true });
      handlerAny.fileHandler = { formatFilePrompt: vi.fn().mockResolvedValue('t'), cleanupTempFiles };
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const { settle } = await startBusyTurn();
      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '이 로그 봐줘',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        say(),
      );

      await lifecycle()({ sessionKey: SESSION_KEY, uuid: steerTurn.mock.calls[0][1].uuid, phase: 'completed' });

      expect(cleanupTempFiles).toHaveBeenCalledWith(processed);
      await settle();
    });

    it('never fails the turn when the settlement itself cannot be recorded', async () => {
      const { settle } = await steerOne();

      await expect(lifecycle()({ sessionKey: SESSION_KEY, uuid: 'unknown-uuid', phase: 'completed' })).resolves.toBe(
        undefined,
      );
      expect(items()[0].state).toBe('steered');
      await settle();
    });

    /**
     * The frame carries the SESSION key the executor ran under; after a
     * bot-thread migration the ROW lives under the slot key the push was made
     * on (`dispatcher.steer` only accepts the key that owns the live slot,
     * `followup-dispatcher.ts:497-500`). Settling the wrong bucket would leave
     * the item `steered` forever and record nothing.
     */
    it('settles the bucket the item was enqueued in when the turn migrated to a work thread', async () => {
      const WORK_KEY = 'C123:999.000';
      claudeHandler.getSessionKey.mockImplementation(
        (channel: string, threadTs?: string) => `${channel}:${threadTs ?? ''}`,
      );
      const workSession = { ...registrySession, threadTs: '999.000', threadRootTs: '999.000' };
      claudeHandler.getSessionByKey.mockImplementation((key: string) =>
        key === WORK_KEY ? workSession : registrySession,
      );
      initialize.mockImplementation(async () => ({
        session: workSession,
        sessionKey: WORK_KEY,
        isNewSession: true,
        userName: 'Owner',
        workingDirectory: '/tmp/work',
        abortController: new AbortController(),
        halted: false,
      }));
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;

      const gate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => gate.promise);
      // The slot was opened under the SOURCE key; the session runs under the work key.
      const first = handler.handleMessage(message({ ts: '222.333', text: '첫 지시' }), say());
      await tick();

      // The reply arrives in the SOURCE thread — the key that owns the slot.
      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());
      expect(items()[0].state).toBe('steered');
      // The push was addressed to the session that is really running.
      expect(steerTurn.mock.calls[0][0]).toBe(WORK_KEY);

      // …so the receipt comes back stamped with THAT key.
      await lifecycle()({ sessionKey: WORK_KEY, uuid: steerTurn.mock.calls[0][1].uuid, phase: 'completed' });

      expect(items()[0].state).toBe('resolved');
      expect(items()[0].stateReason).toBe('consumed');

      gate.resolve({ hasPendingChoice: false });
      await first;
    });
  });

  /* ---------------------------------------------------------------- *
   * Orphaned `steered` rows — a turn can end without ever naming the
   * message it was given (killed CLI, dropped frame). No drain can take a
   * `steered` row, so the sweep is what keeps it from sitting forever.
   * ---------------------------------------------------------------- */

  describe('end-of-turn sweep', () => {
    it('returns a never-settled message to the queue and drains it', async () => {
      claudeHandler.steerTurn = vi.fn().mockReturnValue(true);
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());
      expect(items()[0].state).toBe('steered');

      // The turn ends and no `steer_lifecycle` frame ever names the message.
      await settle();

      // It ran as an ordinary drained item instead of being stranded.
      expect(startWithContinuation).toHaveBeenCalledTimes(2);
      expect(items()[0].state).toBe('resolved');
    });

    it('cleans up the steered temp files it swept back into the queue', async () => {
      const cleanupTempFiles = vi.fn().mockResolvedValue(undefined);
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockResolvedValue({ files: processed, shouldContinue: true });
      handlerAny.fileHandler = { formatFilePrompt: vi.fn().mockResolvedValue('t'), cleanupTempFiles };
      claudeHandler.steerTurn = vi.fn().mockReturnValue(true);
      const { settle } = await startBusyTurn();
      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '이 로그 봐줘',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        say(),
      );

      await settle();

      expect(cleanupTempFiles).toHaveBeenCalledWith(processed);
    });

    /**
     * Under a bot-thread migration the steered ROW lives under the SLOT key
     * (the bucket the push was made in, `steer settlement` above), while the
     * drain — and the sweep inside it — runs under the CANONICAL key. A turn
     * that ends with no settlement frame therefore left that row `steered`
     * forever: no drain can claim it (`claimNext` takes `queued` only) and no
     * receipt can still arrive.
     */
    it('sweeps the slot-key bucket too when the turn migrated to a work thread', async () => {
      const WORK_KEY = 'C123:999.000';
      claudeHandler.getSessionKey.mockImplementation(
        (channel: string, threadTs?: string) => `${channel}:${threadTs ?? ''}`,
      );
      const workSession = { ...registrySession, threadTs: '999.000', threadRootTs: '999.000' };
      claudeHandler.getSessionByKey.mockImplementation((key: string) =>
        key === WORK_KEY ? workSession : registrySession,
      );
      initialize.mockImplementation(async () => ({
        session: workSession,
        sessionKey: WORK_KEY,
        isNewSession: true,
        userName: 'Owner',
        workingDirectory: '/tmp/work',
        abortController: new AbortController(),
        halted: false,
      }));
      claudeHandler.steerTurn = vi.fn().mockReturnValue(true);

      const gate = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => gate.promise);
      // The slot was opened under the SOURCE key; the session runs under the work key.
      const first = handler.handleMessage(message({ ts: '222.333', text: '첫 지시' }), say());
      await tick();

      // The reply arrives in the SOURCE thread — the key that owns the slot.
      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());
      expect(items()[0].state).toBe('steered');

      // The turn ends and no `steer_lifecycle` frame ever names the message.
      gate.resolve({ hasPendingChoice: false });
      await first;

      expect(items()[0].state).toBe('queued');
    });

    /**
     * The sweep used to hang off `drainFollowups` alone, which runs BEFORE the
     * drain loop. A turn the loop itself dispatched was therefore never swept:
     * a message steered into it and never settled stayed `steered`, with no
     * turn left that could ever settle it.
     */
    it('sweeps the turn the drain loop itself dispatched', async () => {
      // The first follow-up is refused by the live turn (so the drain runs it
      // later); the second one is taken by the turn the DRAIN dispatched.
      claudeHandler.steerTurn = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
      const live = deferred<any>();
      const drainRun = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => live.promise).mockImplementationOnce(() => drainRun.promise);

      const first = handler.handleMessage(message({ ts: '222.333', text: '첫 지시' }), say());
      await tick();
      await handler.handleMessage(message({ ts: '333.444', text: '이건 큐로' }), say());
      expect(items()[0].state).toBe('queued');

      // The first turn ends: the drain claims that item, and its run is held open.
      live.resolve({ hasPendingChoice: false });
      await tick();
      expect(items()[0].state).toBe('dispatched');

      // A reply steered into the DRAIN-dispatched turn.
      await handler.handleMessage(message({ ts: '555.666', text: '이것도 같이 봐줘' }), say());
      const steeredId = items()[1].id;
      expect(items()[1].state).toBe('steered');

      // That turn ends parked on a question: no settlement frame, and no
      // further drain is allowed to follow it.
      drainRun.resolve({ hasPendingChoice: true });
      await first;

      expect(items().find((item: any) => item.id === steeredId).state).toBe('queued');
    });

    /**
     * The `Send now` button's follow-through enters this loop directly
     * (`deps.runDrain`) with no `drainFollowups` boundary in front of it, so the
     * loop itself has to clear a row the superseded turn stranded — otherwise
     * nothing does until some later message happens to start a turn.
     */
    it('sweeps a stranded steered row when the drain loop is entered directly', async () => {
      const queue = handlerAny.getFollowupQueue();
      expect(queue.enqueue(SESSION_KEY, message({ ts: '333.444', text: '이것도 같이 봐줘' }), {}).status).toBe(
        'queued',
      );
      const parked = queue.list(SESSION_KEY)[0];
      // The shape a turn that died holding the pushed copy leaves behind.
      expect(queue.steer(SESSION_KEY, parked.id, parked.epoch, 'uuid-stranded').ok).toBe(true);
      expect(items()[0].state).toBe('steered');

      await handlerAny.runFollowupDrainLoop(SESSION_KEY);

      expect(items()[0].state).toBe('queued');
    });

    /**
     * The protective half of the same guard. The sweep DECLARES that no receipt
     * can still arrive, which is only true once nothing is in flight: a live
     * turn may be holding the pushed copy right now, and returning that row to
     * `queued` would have the drain deliver the same message a second time
     * (§3.2's double delivery). Every unguarded sweep on a non-boundary path is
     * routed through this variant for exactly that reason.
     */
    it('does not sweep a steered row while a dispatch is still in flight', async () => {
      const { settle } = await startBusyTurn();
      const queue = handlerAny.getFollowupQueue();
      expect(queue.enqueue(SESSION_KEY, message({ ts: '333.444', text: '이것도 같이 봐줘' }), {}).status).toBe(
        'queued',
      );
      const parked = queue.list(SESSION_KEY)[0];
      expect(queue.steer(SESSION_KEY, parked.id, parked.epoch, 'uuid-live').ok).toBe(true);
      expect(handlerAny.followupDispatcher.isBusy(SESSION_KEY)).toBe(true);

      await handlerAny.sweepSteerBucketsIfIdle(SESSION_KEY);

      // Still the live turn's: only the turn boundary may declare it stranded.
      expect(items()[0].state).toBe('steered');
      await settle();
    });

    /**
     * A steered item is outstanding follow-up work exactly like a queued one —
     * the autogoal driver must not start a turn on top of it (§3.6).
     */
    it('holds the autogoal driver while a message is still steered', async () => {
      claudeHandler.steerTurn = vi.fn().mockReturnValue(true);
      const goalDriver = vi.fn();
      handler.setGoalTurnSettledHandler(goalDriver);
      registrySession.goal = { goalId: 'g1', status: 'active', objective: '릴리즈', epoch: 0 };

      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '사람 후속 지시' }), say());
      expect(items()[0].state).toBe('steered');

      handlerAny.handleAssistantTurnCompleteForGoal(registrySession, SESSION_KEY, ['turn text']);
      expect(goalDriver).not.toHaveBeenCalled();

      await settle();
      expect(goalDriver).toHaveBeenCalledTimes(1);
    });
  });

  /* ---------------------------------------------------------------- *
   * `Send now` steer release — the host hook the action module calls once
   * the dispatcher's transaction is over.
   * ---------------------------------------------------------------- */

  describe('Send now steer release', () => {
    /** Steer one message carrying a file, so the temp-file release is observable. */
    async function steerWithFile(): Promise<{
      uuid: string;
      itemId: string;
      epoch: number;
      processed: unknown[];
      cleanupTempFiles: ReturnType<typeof vi.fn>;
      settle: () => Promise<void>;
    }> {
      const cleanupTempFiles = vi.fn().mockResolvedValue(undefined);
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockResolvedValue({ files: processed, shouldContinue: true });
      handlerAny.fileHandler = { formatFilePrompt: vi.fn().mockResolvedValue('이 로그 봐줘'), cleanupTempFiles };
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const { settle } = await startBusyTurn();
      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '이 로그 봐줘',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        say(),
      );
      const [item] = items();
      expect(item.state).toBe('steered');
      return {
        uuid: steerTurn.mock.calls[0][1].uuid,
        itemId: item.id,
        epoch: item.epoch,
        processed,
        cleanupTempFiles,
        settle,
      };
    }

    /**
     * The dispatcher's unsteer is SPECULATIVE: when the reserve is refused or
     * the interrupt fails it puts the row back under the SAME uuid
     * (`followup-dispatcher.ts:896 restoreSteer`), because the SDK is still
     * holding the copy it was pushed. Releasing the files there would delete
     * attachments the live turn is about to read.
     */
    it('keeps the steer artifacts when the dispatcher put the item back under the same uuid', async () => {
      const { uuid, itemId, epoch, processed, cleanupTempFiles, settle } = await steerWithFile();
      // The real `Send now` transaction, failing on the interrupt hop.
      abortSession.mockImplementation(() => {
        throw new Error('abort seam gone');
      });

      const result = await handlerAny.followupDispatcher.sendNow(
        SESSION_KEY,
        itemId,
        epoch,
        'U_OWNER',
        handlerAny.getFollowupQueue().getTurnEpoch(SESSION_KEY),
      );

      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('interrupt-failed');
      expect(items()[0].state).toBe('steered');
      expect(items()[0].steerUuid).toBe(uuid);

      // The action module announces the hook in a `finally`, whatever happened.
      handlerAny.releaseSteerAfterSendNow(SESSION_KEY, itemId);

      expect(cleanupTempFiles).not.toHaveBeenCalled();
      // The uuid bookkeeping is kept too: the settlement that eventually names
      // this uuid still finds the files and the item.
      await handlerAny.streamExecutor.deps.onSteerLifecycle({ sessionKey: SESSION_KEY, uuid, phase: 'completed' });
      expect(cleanupTempFiles).toHaveBeenCalledWith(processed);
      expect(items()[0].state).toBe('resolved');

      await settle();
    });

    it('releases the steer artifacts once the item really left `steered`', async () => {
      const { itemId, processed, cleanupTempFiles, settle } = await steerWithFile();
      // What a successful `Send now` leaves behind: the row is out of `steered`
      // and the SDK copy died with the interrupted turn.
      const queue = handlerAny.getFollowupQueue();
      expect(queue.unsteerAll(SESSION_KEY, 'send-now')).toHaveLength(1);

      handlerAny.releaseSteerAfterSendNow(SESSION_KEY, itemId);
      await tick();

      expect(cleanupTempFiles).toHaveBeenCalledWith(processed);
      await settle();
    });
  });

  /* ---------------------------------------------------------------- *
   * Cancel of a steered item — the SDK decides, the queue records.
   * ---------------------------------------------------------------- */

  describe('cancel of a steered item', () => {
    async function steerOne(): Promise<{ uuid: string; itemId: string; epoch: number; settle: () => Promise<void> }> {
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '이것도 같이 봐줘' }), say());
      const [item] = items();
      return { uuid: steerTurn.mock.calls[0][1].uuid, itemId: item.id, epoch: item.epoch, settle };
    }

    it('cancels the item once the SDK confirmed the withdrawal', async () => {
      const { uuid, itemId, epoch, settle } = await steerOne();
      claudeHandler.cancelSteeredMessage = vi.fn().mockResolvedValue('withdrawn');

      const outcome = await handlerAny.cancelSteeredFollowup(SESSION_KEY, itemId, epoch, uuid);

      expect(claudeHandler.cancelSteeredMessage).toHaveBeenCalledWith(SESSION_KEY, uuid);
      expect(outcome).toBe('cancelled');
      expect(items()[0].state).toBe('cancelled');
      await settle();
    });

    it('reports an already-delivered message and records it as consumed', async () => {
      const { uuid, itemId, epoch, settle } = await steerOne();
      claudeHandler.cancelSteeredMessage = vi.fn().mockResolvedValue('already-dequeued');

      const outcome = await handlerAny.cancelSteeredFollowup(SESSION_KEY, itemId, epoch, uuid);

      expect(outcome).toBe('already-delivered');
      // The model has it: the honest row is consumed history, not `cancelled`.
      expect(items()[0].state).toBe('resolved');
      await settle();
    });

    /**
     * The SDK was never asked (no live query for the key, or a runtime without
     * `cancelAsyncMessage`), so delivery is UNKNOWN. Recording consumption would
     * resolve a message nobody delivered; leaving it `steered` would leave a row
     * no drain can take. It goes back to `queued`, where the control works again.
     */
    it('returns the item to the queue when the SDK could not be asked', async () => {
      const { uuid, itemId, epoch, settle } = await steerOne();
      claudeHandler.cancelSteeredMessage = vi.fn().mockResolvedValue('unreachable');

      const outcome = await handlerAny.cancelSteeredFollowup(SESSION_KEY, itemId, epoch, uuid);

      expect(outcome).toBe('returned-to-queue');
      expect(items()[0].state).toBe('queued');
      expect(items()[0].stateReason).toBe('전달 여부를 확인할 수 없어 큐로 되돌림');
      await settle();
    });

    /**
     * Under a bot-thread migration the steered ROW lives under the SLOT key
     * (the bucket the push was accepted in, `steer settlement` above) while the
     * click arrives stamped with the CANONICAL session key. `unreachable`
     * unsteered the canonical bucket only, so the click read "failed" and the
     * row stayed `steered` under the slot key — a row no drain can take
     * (`followup-queue.ts:651-666`) and no receipt can still reach.
     */
    it('returns the slot-key row to the queue when the turn migrated to a work thread', async () => {
      const WORK_KEY = 'C123:999.000';
      const queue = handlerAny.getFollowupQueue();
      expect(queue.enqueue(SESSION_KEY, message({ ts: '333.444', text: '이것도 같이 봐줘' }), {}).status).toBe(
        'queued',
      );
      const [parked] = items();
      // The shape a migrated turn leaves behind: the push was accepted in the
      // SLOT bucket, while the session runs under the work key.
      expect(queue.steer(SESSION_KEY, parked.id, parked.epoch, 'uuid-migrated').ok).toBe(true);
      handlerAny.bindFollowupMigration(SESSION_KEY, WORK_KEY);
      claudeHandler.cancelSteeredMessage = vi.fn().mockResolvedValue('unreachable');

      const outcome = await handlerAny.cancelSteeredFollowup(WORK_KEY, parked.id, parked.epoch, 'uuid-migrated');

      expect(outcome).toBe('returned-to-queue');
      expect(items()[0].state).toBe('queued');
      expect(items()[0].stateReason).toBe('전달 여부를 확인할 수 없어 큐로 되돌림');
    });

    it('reports failure without touching the item when the queue write loses the CAS', async () => {
      const { uuid, itemId, settle } = await steerOne();
      claudeHandler.cancelSteeredMessage = vi.fn().mockResolvedValue('withdrawn');

      const outcome = await handlerAny.cancelSteeredFollowup(SESSION_KEY, itemId, 99, uuid);

      expect(outcome).toBe('failed');
      expect(items()[0].state).toBe('steered');
      await settle();
    });

    /**
     * `already-dequeued` is the branch that RECORDS a delivery, and the record
     * can fail exactly like the `withdrawn` one does (a settlement raced the
     * click, a restarted queue). Cleaning up the temp files on a write that did
     * not land would delete attachments of a row still sitting `steered` under
     * a uuid whose settlement frame has not arrived yet — and the click would
     * read "already delivered" for a delivery nothing recorded.
     */
    it('reports failure and keeps the steer artifacts when the consumption cannot be recorded', async () => {
      const cleanupTempFiles = vi.fn().mockResolvedValue(undefined);
      const processed = [{ name: 'log.txt', path: '/tmp/log.txt', isImage: false }];
      processFiles.mockResolvedValue({ files: processed, shouldContinue: true });
      handlerAny.fileHandler = { formatFilePrompt: vi.fn().mockResolvedValue('이 로그 봐줘'), cleanupTempFiles };
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const { settle } = await startBusyTurn();
      await handler.handleMessage(
        message({
          ts: '333.444',
          text: '이 로그 봐줘',
          files: [
            {
              id: 'F1',
              name: 'log.txt',
              mimetype: 'text/plain',
              filetype: 'text',
              url_private: 'https://x/1',
              url_private_download: 'https://x/1d',
              size: 12,
            },
          ],
        }),
        say(),
      );
      const [item] = items();
      expect(item.state).toBe('steered');
      const uuid = steerTurn.mock.calls[0][1].uuid;

      claudeHandler.cancelSteeredMessage = vi.fn().mockResolvedValue('already-dequeued');
      // Not under this key and not under a slot-key counterpart either.
      const markConsumed = vi
        .spyOn(handlerAny.followupDispatcher, 'markConsumed')
        .mockReturnValue({ ok: false, reason: 'not-found' } as any);

      const outcome = await handlerAny.cancelSteeredFollowup(SESSION_KEY, item.id, item.epoch, uuid);

      expect(outcome).toBe('failed');
      expect(markConsumed).toHaveBeenCalled();
      expect(cleanupTempFiles).not.toHaveBeenCalled();
      // The bookkeeping that finds those files is still there.
      expect(handlerAny.followupSteerUuids.get(item.id)).toBe(uuid);
      expect(items()[0].state).toBe('steered');

      markConsumed.mockRestore();
      await settle();
    });
  });

  /* ---------------------------------------------------------------- *
   * Edit = the user edited their own Slack message (D3).
   * ---------------------------------------------------------------- */

  describe('queued message edit', () => {
    const edit = (over: Record<string, unknown> = {}) => ({
      channel: CHANNEL,
      ts: '333.444',
      threadTs: THREAD_TS,
      user: 'U_OWNER',
      text: '역시 로그만 보여줘',
      ...over,
    });

    it('rewrites the stored text of the queued item', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '배포 상태 알려줘' }), say());

      await handlerAny.handleQueuedMessageEdit(edit());

      expect(items()[0].message.text).toBe('역시 로그만 보여줘');
      expect(items()[0].state).toBe('queued');
      await settle();
    });

    it('says nothing about an edit that matches no queued item', async () => {
      const { settle } = await startBusyTurn();
      const before = postSystemMessage.mock.calls.length;

      await handlerAny.handleQueuedMessageEdit(edit({ ts: '999.999' }));

      expect(postSystemMessage.mock.calls.length).toBe(before);
      await settle();
    });

    it('answers ONE notice when the message was already handed to the model', async () => {
      claudeHandler.steerTurn = vi.fn().mockReturnValue(true);
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '배포 상태 알려줘' }), say());
      expect(items()[0].state).toBe('steered');

      await handlerAny.handleQueuedMessageEdit(edit());
      await handlerAny.handleQueuedMessageEdit(edit({ text: '또 고침' }));

      const notices = postSystemMessage.mock.calls.filter((call: any[]) => String(call[1]).includes('편집이 큐에'));
      expect(notices).toHaveLength(1);
      // The stored text is the one the model was given, not the edit.
      expect(items()[0].message.text).toBe('배포 상태 알려줘');
      await settle();
    });

    /**
     * A `paused`/`uncertain` item was never handed to anyone — "이미 전달·실행된"
     * would be a lie about a message that is sitting still, and it hides the one
     * action that actually helps (Resume).
     */
    it('tells a paused item the queue is stopped, not that the message was delivered', async () => {
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '배포 상태 알려줘' }), say());
      await handler.handleMessage(message({ ts: '333.555', text: '!' }), say());
      await settle();
      expect(items()[0].state).toBe('paused');

      await handlerAny.handleQueuedMessageEdit(edit());

      const notice = postSystemMessage.mock.calls.map((call: any[]) => String(call[1])).filter((t) => t.includes('✏️'));
      expect(notice).toHaveLength(1);
      expect(notice[0]).toBe(
        '✏️ 재시작 전 항목이라 편집이 반영되지 않습니다 — 새 메시지로 다시 보내거나 ⋯ 메뉴의 Retry로 실행하세요.',
      );
    });

    /**
     * The "one notice per item" memory is not a leak: once the item is settled
     * it can never take an edit again, so the entry is dropped with it.
     */
    it('forgets the edit notice once the item is settled', async () => {
      const steerTurn = vi.fn().mockReturnValue(true);
      claudeHandler.steerTurn = steerTurn;
      const { settle } = await startBusyTurn();
      await handler.handleMessage(message({ ts: '333.444', text: '배포 상태 알려줘' }), say());
      await handlerAny.handleQueuedMessageEdit(edit());
      const itemId = items()[0].id;
      expect(handlerAny.followupEditNoticed.has(itemId)).toBe(true);

      await handlerAny.streamExecutor.deps.onSteerLifecycle({
        sessionKey: SESSION_KEY,
        uuid: steerTurn.mock.calls[0][1].uuid,
        phase: 'completed',
      });

      expect(handlerAny.followupEditNoticed.has(itemId)).toBe(false);
      await settle();
    });

    /**
     * Same rule on the path most items actually take: the ordinary drain. The
     * one-shot describes ONE delivery, so it dies with that delivery — kept, it
     * leaks for every item that ever took a notice, and the next state of the
     * same message would be announced with a memory of the previous one.
     */
    it('forgets the edit notice once the item settles through the ordinary drain', async () => {
      const live = deferred<any>();
      const drainRun = deferred<any>();
      startWithContinuation.mockImplementationOnce(() => live.promise).mockImplementationOnce(() => drainRun.promise);

      const first = handler.handleMessage(message({ ts: '222.333', text: '첫 지시' }), say());
      await tick();
      await handler.handleMessage(message({ ts: '333.444', text: '배포 상태 알려줘' }), say());
      expect(items()[0].state).toBe('queued');

      // The turn ends: the drain claims and dispatches the item, and that run
      // is held open — the item is handed over, so an edit gets the notice.
      live.resolve({ hasPendingChoice: false });
      await tick();
      const itemId = items()[0].id;
      expect(items()[0].state).toBe('dispatched');

      await handlerAny.handleQueuedMessageEdit(edit());
      expect(handlerAny.followupEditNoticed.has(itemId)).toBe(true);

      drainRun.resolve({ hasPendingChoice: false });
      await first;
      expect(items()[0].state).toBe('resolved');
      expect(handlerAny.followupEditNoticed.has(itemId)).toBe(false);

      // And the terminal item stays silent about later edits.
      const before = postSystemMessage.mock.calls.length;
      await handlerAny.handleQueuedMessageEdit(edit({ text: '또 고침' }));
      expect(postSystemMessage.mock.calls.length).toBe(before);
    });
  });
});
