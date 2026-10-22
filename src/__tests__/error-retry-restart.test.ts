/**
 * #351 — an error auto-retry must survive a restart.
 *
 * The recoverable-error path schedules the retry with an in-memory
 * `setTimeout`. A restart before it fires used to lose it: the timer died with
 * the process, and crash recovery only resumes sessions that were `working`
 * at shutdown — a session waiting on an error retry is idle.
 *
 * Fix under test:
 *   - `pendingRetryAt` (the due time), `errorRetryCount` and
 *     `lastErrorContext` are persisted; the timer handle stays runtime-only.
 *   - `scheduleErrorRetry` arms the timer, records the due time and saves
 *     immediately; the timer only resumes if the session still owns that
 *     exact due time.
 *   - `resumePendingErrorRetries` re-arms the persisted due times at startup,
 *     except where another resume path already owns the session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/soma-work-error-retry-restart-test';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DATA_DIR: '/tmp/soma-work-error-retry-restart-test' };
});

import { getMetricsEmitter } from '../metrics/event-emitter';
import { SessionRegistry } from '../session-registry';
import { SlackHandler } from '../slack-handler';
import type { ConversationSession } from '../types';
import { userSettingsStore } from '../user-settings-store';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------- persistence ----------

describe('#351 persistence: pending error retry survives save/load', () => {
  it('round-trips pendingRetryAt, errorRetryCount and lastErrorContext', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.001');
    session.sessionId = 'sess-1';
    const dueAt = Date.now() + 60 * 60 * 1000;
    session.pendingRetryAt = dueAt;
    session.errorRetryCount = 1;
    session.lastErrorContext = 'previous attempt failed';
    session.pendingRetryTimer = setTimeout(() => {}, 60_000);
    writer.saveSessions();
    clearTimeout(session.pendingRetryTimer);

    const reader = new SessionRegistry();
    reader.loadSessions();
    const restored = reader.getSession('C1', '171.001');

    expect(restored).toBeDefined();
    expect(restored?.pendingRetryAt).toBe(dueAt);
    expect(restored?.errorRetryCount).toBe(1);
    expect(restored?.lastErrorContext).toBe('previous attempt failed');
    // The handle itself is runtime-only.
    expect(restored?.pendingRetryTimer).toBeUndefined();
  });

  it('drops pendingRetryAt for a session put to sleep on load (sleepers are never auto-resumed)', () => {
    const sessionsData = [
      {
        key: 'C1-171.002',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: '171.002',
        sessionId: 'sess-stale',
        isActive: true,
        lastActivity: new Date(Date.now() - 400 * DAY).toISOString(),
        activityState: 'idle',
        state: 'MAIN',
        pendingRetryAt: Date.now() + 60_000,
        errorRetryCount: 1,
        lastErrorContext: 'previous attempt failed',
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();
    const restored = registry.getSession('C1', '171.002');

    expect(restored).toBeDefined();
    expect(restored?.state).toBe('SLEEPING');
    expect(restored?.pendingRetryAt).toBeUndefined();
  });

  it('drops pendingRetryAt for a session that was already asleep on disk', () => {
    const sessionsData = [
      {
        key: 'C1-171.003',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: '171.003',
        sessionId: 'sess-asleep',
        isActive: true,
        lastActivity: new Date(Date.now() - 60_000).toISOString(),
        activityState: 'idle',
        state: 'SLEEPING',
        sleepStartedAt: new Date(Date.now() - 60_000).toISOString(),
        pendingRetryAt: Date.now() + 60_000,
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();
    const restored = registry.getSession('C1', '171.003');

    expect(restored).toBeDefined();
    expect(restored?.state).toBe('SLEEPING');
    expect(restored?.pendingRetryAt).toBeUndefined();
  });

  it('ignores a malformed persisted pendingRetryAt', () => {
    const sessionsData = [
      {
        key: 'C1-171.004',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: '171.004',
        sessionId: 'sess-bad',
        isActive: true,
        lastActivity: new Date().toISOString(),
        activityState: 'idle',
        state: 'MAIN',
        pendingRetryAt: 'soon',
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();

    expect(registry.getSession('C1', '171.004')?.pendingRetryAt).toBeUndefined();
  });
});

describe('#351 reset paths clear the pending retry due time', () => {
  it('clearSessionId clears pendingRetryAt', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Tester', 'C1', '171.R1');
    session.sessionId = 'sess-r1';
    session.pendingRetryAt = Date.now() + 60_000;

    registry.clearSessionId('C1', '171.R1');

    expect(session.pendingRetryAt).toBeUndefined();
  });

  it('resetSessionContext clears pendingRetryAt', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Tester', 'C1', '171.R2');
    session.sessionId = 'sess-r2';
    session.pendingRetryAt = Date.now() + 60_000;

    registry.resetSessionContext('C1', '171.R2');

    expect(session.pendingRetryAt).toBeUndefined();
  });
});

// ---------- SlackHandler: schedule + restart re-arm ----------

function liveSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    channelId: 'C1',
    threadTs: 'T1',
    ownerId: 'U1',
    sessionId: 'sess-1',
    activityState: 'idle',
    ...overrides,
  } as unknown as ConversationSession;
}

function createHandler(sessions: Map<string, ConversationSession>) {
  const app = {
    client: { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.1' }) } },
    assistant: vi.fn(),
  } as any;
  const claudeHandler = {
    getAllSessions: vi.fn(() => sessions),
    getSessionByKey: vi.fn((k: string) => sessions.get(k)),
    getSession: vi.fn((channelId: string, threadTs?: string) =>
      [...sessions.values()].find((s) => s.channelId === channelId && s.threadTs === threadTs),
    ),
    getCrashRecoveredSessions: vi.fn().mockReturnValue([]),
    clearCrashRecoveredSessions: vi.fn(),
    saveSessions: vi.fn(),
  } as any;
  const handler = new SlackHandler(app, claudeHandler, {} as any);
  const autoResume = vi.spyOn(handler as any, 'autoResumeSession').mockResolvedValue(undefined);
  return { handler, claudeHandler, autoResume };
}

describe('#351 scheduleErrorRetry: arms, persists and guards the fire', () => {
  beforeEach(() => vi.useFakeTimers());

  it('records the due time, keeps the handle and saves immediately', () => {
    const session = liveSession();
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));
    const dueAt = Date.now() + 30_000;

    (handler as any).scheduleErrorRetry({ channelId: 'C1', threadTs: 'T1', ownerId: 'U1' }, dueAt, 30_000, 'ctx');

    expect(session.pendingRetryAt).toBe(dueAt);
    expect(session.pendingRetryTimer).toBeDefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_999);
    expect(autoResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoResume).toHaveBeenCalledTimes(1);
    expect(autoResume).toHaveBeenCalledWith({ channelId: 'C1', threadTs: 'T1', ownerId: 'U1' }, undefined, 'ctx');
    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetryTimer).toBeUndefined();
  });

  it('does not resume when pendingRetryAt was cleared before the timer fired', () => {
    const session = liveSession();
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(
      { channelId: 'C1', threadTs: 'T1', ownerId: 'U1' },
      Date.now() + 30_000,
      30_000,
      undefined,
    );

    session.pendingRetryAt = undefined;
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
  });

  it('does not resume from a timer whose due time was rescheduled', () => {
    const session = liveSession();
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(
      { channelId: 'C1', threadTs: 'T1', ownerId: 'U1' },
      Date.now() + 30_000,
      30_000,
      undefined,
    );

    // A newer schedule owns the session now; the first timer is superseded.
    session.pendingRetryAt = Date.now() + 90_000;
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
  });

  it('does not resume when the sessionId changed before the timer fired', () => {
    const session = liveSession();
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(
      { channelId: 'C1', threadTs: 'T1', ownerId: 'U1' },
      Date.now() + 30_000,
      30_000,
      undefined,
    );

    session.sessionId = 'sess-2';
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
  });

  it('does not resume when the session is gone', () => {
    const sessions = new Map([['k1', liveSession()]]);
    const { handler, autoResume } = createHandler(sessions);
    (handler as any).scheduleErrorRetry(
      { channelId: 'C1', threadTs: 'T1', ownerId: 'U1' },
      Date.now() + 30_000,
      30_000,
      undefined,
    );

    sessions.delete('k1');
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
  });
});

describe('#351 resumePendingErrorRetries: re-arm after restart', () => {
  beforeEach(() => vi.useFakeTimers());

  it('re-arms a future due time for the remaining delay, then resumes once', () => {
    const dueAt = Date.now() + 60_000;
    const session = liveSession({ pendingRetryAt: dueAt, lastErrorContext: 'ctx' });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(1);

    vi.advanceTimersByTime(59_999);
    expect(autoResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoResume).toHaveBeenCalledTimes(1);
    expect(autoResume).toHaveBeenCalledWith({ channelId: 'C1', threadTs: 'T1', ownerId: 'U1' }, undefined, 'ctx');
    expect(session.pendingRetryAt).toBeUndefined();

    vi.advanceTimersByTime(10 * 60_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('fires a past-due retry after the startup floor, not immediately', () => {
    const session = liveSession({ pendingRetryAt: Date.now() - 10 * 60_000 });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(1);

    vi.advanceTimersByTime(4_999);
    expect(autoResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('uses the session owner as the resume actor', () => {
    const session = liveSession({ ownerId: 'U_OWNER', pendingRetryAt: Date.now() + 1_000 });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    handler.resumePendingErrorRetries();
    vi.advanceTimersByTime(5_000);

    expect(autoResume).toHaveBeenCalledWith(
      { channelId: 'C1', threadTs: 'T1', ownerId: 'U_OWNER' },
      undefined,
      undefined,
    );
  });

  it('does not re-arm (and clears) a session whose active goal is resumed by the goal loop', () => {
    const session = liveSession({
      pendingRetryAt: Date.now() + 1_000,
      goal: { goalId: 'g1', objective: 'finish', status: 'active' } as any,
    });
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(0);
    expect(session.pendingRetryAt).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(autoResume).not.toHaveBeenCalled();
  });

  it('does not re-arm a session that crash recovery already auto-resumed', async () => {
    const session = liveSession({ pendingRetryAt: Date.now() + 1_000 });
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));
    claudeHandler.getCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C1',
        threadTs: 'T1',
        ownerId: 'U1',
        activityState: 'idle',
        sessionKey: 'k1',
        shouldAutoResume: true,
      },
    ]);

    await handler.notifyCrashRecovery();
    expect(autoResume).toHaveBeenCalledTimes(1);
    expect(session.pendingRetryAt).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalled();

    expect(handler.resumePendingErrorRetries()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('keeps the due time of a session crash recovery only notified (no auto-resume)', async () => {
    const session = liveSession({ pendingRetryAt: Date.now() + 1_000 });
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));
    claudeHandler.getCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C1',
        threadTs: 'T1',
        ownerId: 'U1',
        activityState: 'idle',
        sessionKey: 'k1',
        shouldAutoResume: false,
      },
    ]);

    await handler.notifyCrashRecovery();
    expect(autoResume).not.toHaveBeenCalled();

    expect(handler.resumePendingErrorRetries()).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('skips a session whose retry timer is already armed in this process', () => {
    const existing = setTimeout(() => {}, 60_000);
    const session = liveSession({ pendingRetryAt: Date.now() + 60_000, pendingRetryTimer: existing });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(0);
    expect(session.pendingRetryTimer).toBe(existing);

    vi.advanceTimersByTime(120_000);
    expect(autoResume).not.toHaveBeenCalled();
  });

  it('ignores sessions with no pending retry', () => {
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', liveSession()]]));

    expect(handler.resumePendingErrorRetries()).toBe(0);
    expect(claudeHandler.saveSessions).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(autoResume).not.toHaveBeenCalled();
  });
});

// ---------- the recoverable-error path itself ----------

describe('#351 recoverable-error path persists the retry it schedules', () => {
  const CHANNEL = 'C1';
  const THREAD_TS = '111.222';

  function buildErrorPathHandler(retryAfterMs: number | undefined) {
    vi.spyOn(getMetricsEmitter(), 'emitFollowupQueue').mockResolvedValue(undefined);
    vi.spyOn(userSettingsStore, 'getUserAutoGoalEnabled').mockReturnValue(false);
    vi.spyOn(userSettingsStore, 'getUserGoalMaxContinuations').mockReturnValue(10);
    vi.spyOn(userSettingsStore, 'isUserAccepted').mockReturnValue(true);

    const session = {
      ownerId: 'U_OWNER',
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      threadRootTs: THREAD_TS,
      sessionId: 'sess-1',
      errorRetryCount: 1,
      lastErrorContext: 'previous attempt failed',
    } as unknown as ConversationSession;
    const claudeHandler = {
      getSessionKey: vi.fn().mockReturnValue(`${CHANNEL}:${THREAD_TS}`),
      getSession: vi.fn().mockReturnValue(session),
      getSessionByKey: vi.fn().mockReturnValue(session),
      saveSessions: vi.fn(),
      canInterrupt: vi.fn().mockReturnValue(true),
      setActivityStateByKey: vi.fn(),
    };
    const store = { load: () => undefined, save: () => {}, recoveryWarning: undefined };
    const handler = new SlackHandler({ client: {}, assistant: vi.fn() } as any, claudeHandler as any, {} as any, {
      followupQueueStore: store,
    });
    const h = handler as any;
    h.slackApi = {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      postSystemMessage: vi.fn().mockResolvedValue({ ts: 'm' }),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postEphemeral: vi.fn().mockResolvedValue({ ts: 'eph' }),
    };
    h.assistantStatusManager = {
      bumpEpoch: vi.fn().mockReturnValue(1),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    };
    h.inputProcessor = {
      processFiles: vi.fn().mockResolvedValue({ files: [], shouldContinue: true }),
      routeCommand: vi.fn().mockResolvedValue({ handled: false }),
    };
    h.messageValidator = {
      validateWorkingDirectory: vi.fn().mockReturnValue({ valid: true, workingDirectory: '/tmp/work' }),
    };
    h.sessionInitializer = {
      validateWorkingDirectory: vi.fn().mockResolvedValue({ valid: true, workingDirectory: '/tmp/work' }),
      initialize: vi.fn().mockResolvedValue({
        session,
        sessionKey: `${CHANNEL}:${THREAD_TS}`,
        isNewSession: false,
        userName: 'Owner',
        workingDirectory: '/tmp/work',
        abortController: new AbortController(),
        halted: false,
      }),
    };
    h.threadPanel = {
      create: vi.fn().mockResolvedValue(undefined),
      updatePanel: vi.fn().mockResolvedValue(undefined),
      clearChoice: vi.fn().mockResolvedValue(undefined),
    };
    h.createAgentSession = vi.fn().mockImplementation(() => ({
      startWithContinuation: vi.fn().mockRejectedValue(new Error('pool rate limited')),
      getLastTurnSucceeded: () => false,
      getRetryAfterMs: () => retryAfterMs,
    }));
    const autoResume = vi.spyOn(h, 'autoResumeSession').mockResolvedValue(undefined);
    return { handler: h, session, claudeHandler, autoResume };
  }

  const event = () => ({
    user: 'U_OWNER',
    channel: CHANNEL,
    team: 'T1',
    ts: '222.333',
    thread_ts: THREAD_TS,
    text: 'do the work',
  });

  afterEach(() => vi.restoreAllMocks());

  it('records and saves the due time without changing the outcome or the retry budget', async () => {
    const { handler, session, claudeHandler, autoResume } = buildErrorPathHandler(30_000);
    const before = Date.now();

    const outcome = await handler.processMessage(event(), vi.fn().mockResolvedValue({ ts: 'msg' }));
    const after = Date.now();

    expect(outcome).toEqual({ result: 'error', reason: 'recoverable error — auto-retry in 30000ms' });
    expect(session.pendingRetryTimer).toBeDefined();
    expect(session.pendingRetryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(session.pendingRetryAt).toBeLessThanOrEqual(after + 30_000);
    expect(claudeHandler.saveSessions).toHaveBeenCalled();
    // The budget is the stream executor's; scheduling must not touch it.
    expect(session.errorRetryCount).toBe(1);
    expect(autoResume).not.toHaveBeenCalled();
    clearTimeout(session.pendingRetryTimer);
  });

  it('schedules nothing when the error carries no retry delay', async () => {
    const { handler, session } = buildErrorPathHandler(undefined);

    await expect(handler.processMessage(event(), vi.fn().mockResolvedValue({ ts: 'msg' }))).rejects.toThrow(
      'pool rate limited',
    );

    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetryTimer).toBeUndefined();
  });
});
