import { beforeEach, describe, expect, it, vi } from 'vitest';

// No autoskills — keeps the dispatch text free of <invoked_skills> noise.
vi.mock('../slack/autoskill-fire', () => ({
  buildAutoskillFire: vi.fn(() => null),
}));

import type { FollowupQueueSnapshot } from '@soma/slack/followup-queue';
import {
  buildFollowupItemMessage,
  FOLLOWUP_CANCEL_ACTION_ID,
  FOLLOWUP_SEND_NOW_ACTION_ID,
  type FollowupQueueView,
  parseFollowupItemActionValue,
} from '@soma/slack/followup-queue-blocks';
import { parseFollowupQueueSnapshot } from '@soma/slack/followup-queue-store';
import { getMetricsEmitter } from '../metrics/event-emitter';
import { QueueHandler } from '../slack/commands/queue-handler';
import { ThreadSurface } from '../slack/thread-surface';
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

/**
 * ssot-task: T3 — a turn stopped because it crossed the auto-compact threshold
 * (abort reason `auto-compact`) must hand its work on once its dispatch slot is
 * closed: queued work runs first (the armed flag makes that turn `/compact`),
 * otherwise a synthetic host continuation does. Before this, the stop was
 * classified `interrupted` → `canDrain=false`: nothing ran and the work stopped.
 * Drives the REAL SlackHandler + FollowupDispatcher (harness of
 * `slack-handler.followup.test.ts`).
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

/**
 * What a QUEUED message shows since 09: the receipt and both controls, ON the
 * user's own message. There is no bot card and no text receipt any more — the
 * whole surface is the reaction set, so the assertions read it directly.
 */
const QUEUED_REACTIONS = ['inbox_tray', 'ui_send_now', 'ui_cancel'];
/** …and what a message the running turn was given shows instead (§2.1). */
const DELIVERED_REACTIONS = ['white_check_mark'];
/**
 * Only the emoji the QUEUE surface owns. A drained message runs through the
 * ordinary dispatch pipeline too, which paints its own progress reactions
 * (`:brain:` and friends) on the very same message — reading those as queue
 * state would make these assertions about a surface this spec does not own.
 */
const QUEUE_REACTION_NAMES = ['inbox_tray', 'ui_send_now', 'ui_cancel', 'white_check_mark', 'no_entry_sign', 'warning'];

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

describe('SlackHandler — resume after an auto-compact stop (T3)', () => {
  let handler: SlackHandler;
  let handlerAny: any;
  let registrySession: any;
  let claudeHandler: any;
  let saved: FollowupQueueSnapshot[];
  let saveError: Error | undefined;
  let postSystemMessage: ReturnType<typeof vi.fn>;
  let addReaction: ReturnType<typeof vi.fn>;
  let removeReaction: ReturnType<typeof vi.fn>;
  let deleteMessage: ReturnType<typeof vi.fn>;
  let processFiles: ReturnType<typeof vi.fn>;
  let routeCommand: ReturnType<typeof vi.fn>;
  let initialize: ReturnType<typeof vi.fn>;
  let startWithContinuation: ReturnType<typeof vi.fn>;
  let createAgentSession: ReturnType<typeof vi.fn>;
  let abortSession: ReturnType<typeof vi.fn>;
  let lastTurnSucceeded: boolean;
  let emitFollowupQueue: ReturnType<typeof vi.spyOn>;
  /** The ThreadPanel the handler built itself — kept for its production follow-up wiring. */
  let realThreadPanel: any;

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
      broadcastSessionUpdate: vi.fn(),
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
    realThreadPanel = handlerAny.threadPanel;

    addReaction = vi.fn().mockResolvedValue(undefined);
    removeReaction = vi.fn().mockResolvedValue(undefined);
    postSystemMessage = vi.fn().mockResolvedValue({ ts: 'm' });
    deleteMessage = vi.fn().mockResolvedValue(undefined);
    handlerAny.slackApi = {
      // Deliberately the BOOLEAN seam only, with no `addReactionResult`: a host
      // whose client predates the coded variant still has to paint (it just
      // cannot detect `invalid_name`), and that degradation is worth pinning on
      // the real handler rather than only in the surface's own unit test.
      addReaction,
      removeReaction,
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage,
      deleteMessage,
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph' }),
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

  /** Start a turn, stop it with `reason` mid-flight, and let it settle. */
  async function startTurnStoppedWith(reason: string, during?: () => Promise<void>): Promise<void> {
    const controller = new AbortController();
    initialize.mockImplementationOnce(async () => ({
      session: registrySession,
      sessionKey: SESSION_KEY,
      isNewSession: false,
      userName: 'Owner',
      workingDirectory: '/tmp/work',
      abortController: controller,
      halted: false,
    }));
    const gate = deferred<any>();
    startWithContinuation.mockImplementationOnce(() => gate.promise);
    const first = handler.handleMessage(message(), say());
    await tick();
    if (during) await during();
    controller.abort(reason);
    gate.resolve({ hasPendingChoice: false });
    await first;
    await tick();
    await tick();
  }

  const routedTexts = () => routeCommand.mock.calls.map((call: any[]) => String(call[0]?.text ?? ''));

  it('no queued work: resumes with a synthetic host continuation (compacts first via the armed flag)', async () => {
    await startTurnStoppedWith('auto-compact');

    const resumed = routeCommand.mock.calls
      .map((call: any[]) => call[0])
      .find((e: any) => /\[auto-compact\]/.test(String(e?.text)));
    expect(resumed).toBeDefined();
    expect(resumed.synthetic).toBe(true);
    expect(resumed.routeContext).toMatchObject({ hostTurn: true });
    expect(resumed.channel).toBe(CHANNEL);
    expect(resumed.thread_ts).toBe(THREAD_TS);
  });

  it('a message queued during the turn runs next — and no second continuation is added', async () => {
    await startTurnStoppedWith('auto-compact', async () => {
      await handler.handleMessage(message({ ts: '222.444', text: '두번째 지시' }), say());
      await tick();
    });

    expect(routedTexts()).toContain('두번째 지시');
    expect(routedTexts().some((t) => /\[auto-compact\]/.test(t))).toBe(false);
  });

  it('an active goal resumes through its goal loop — no continuation here', async () => {
    registrySession.goal = { goalId: 'g1', objective: '$fix', status: 'active', createdBy: 'U_OWNER' };
    await startTurnStoppedWith('auto-compact');
    expect(routedTexts().some((t) => /\[auto-compact\]/.test(t))).toBe(false);
  });

  it('a user interrupt still parks the queue (unchanged)', async () => {
    await startTurnStoppedWith('user-interrupted', async () => {
      await handler.handleMessage(message({ ts: '222.555', text: '세번째 지시' }), say());
      await tick();
    });
    expect(routedTexts()).not.toContain('세번째 지시');
    expect(routedTexts().some((t) => /\[auto-compact\]/.test(t))).toBe(false);
  });
});
