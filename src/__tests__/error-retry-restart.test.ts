/**
 * #351 — an error auto-retry must survive a restart.
 *
 * The recoverable-error path schedules the retry with an in-memory
 * `setTimeout`. A restart before it fires used to lose it: the timer died with
 * the process, and crash recovery only resumes sessions that were `working`
 * at shutdown — a session waiting on an error retry is idle.
 *
 * Fix under test:
 *   - `pendingRetryAt` (the due time), `pendingRetrySessionId` (the run it
 *     belongs to), `errorRetryCount` and `lastErrorContext` are persisted; the
 *     timer handle stays runtime-only.
 *   - `scheduleErrorRetry` arms the timer, records the marker and saves
 *     immediately; the timer only resumes if the session is still the same run
 *     and still owns that exact due time.
 *   - `resumePendingErrorRetries` re-arms the persisted markers at startup,
 *     except where another resume path actually claimed the session or the
 *     marker belongs to a previous run.
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
  it('round-trips pendingRetryAt, pendingRetrySessionId, errorRetryCount and lastErrorContext', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.001');
    session.sessionId = 'sess-1';
    const dueAt = Date.now() + 60 * 60 * 1000;
    session.pendingRetryAt = dueAt;
    session.pendingRetrySessionId = 'sess-1';
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
    expect(restored?.pendingRetrySessionId).toBe('sess-1');
    expect(restored?.errorRetryCount).toBe(1);
    expect(restored?.lastErrorContext).toBe('previous attempt failed');
    // The handle itself is runtime-only.
    expect(restored?.pendingRetryTimer).toBeUndefined();
  });

  it('drops the pending retry of a session put to sleep on load (sleepers are never auto-resumed)', () => {
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
        pendingRetrySessionId: 'sess-stale',
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
    expect(restored?.pendingRetrySessionId).toBeUndefined();
  });

  it('drops the pending retry of a session that was already asleep on disk', () => {
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
        pendingRetrySessionId: 'sess-asleep',
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();
    const restored = registry.getSession('C1', '171.003');

    expect(restored).toBeDefined();
    expect(restored?.state).toBe('SLEEPING');
    expect(restored?.pendingRetryAt).toBeUndefined();
    expect(restored?.pendingRetrySessionId).toBeUndefined();
  });

  it('ignores a malformed persisted pendingRetryAt or pendingRetrySessionId', () => {
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
        pendingRetrySessionId: 'sess-bad',
      },
      {
        key: 'C1-171.005',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C1',
        threadTs: '171.005',
        sessionId: 'sess-bad-2',
        isActive: true,
        lastActivity: new Date().toISOString(),
        activityState: 'idle',
        state: 'MAIN',
        pendingRetryAt: Date.now() + 60_000,
        pendingRetrySessionId: 42,
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();

    expect(registry.getSession('C1', '171.004')?.pendingRetryAt).toBeUndefined();
    expect(registry.getSession('C1', '171.004')?.pendingRetrySessionId).toBeUndefined();
    expect(registry.getSession('C1', '171.005')?.pendingRetrySessionId).toBeUndefined();
  });
});

describe('#351 reset paths clear the pending retry marker', () => {
  it('clearSessionId clears pendingRetryAt and pendingRetrySessionId', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Tester', 'C1', '171.R1');
    session.sessionId = 'sess-r1';
    session.pendingRetryAt = Date.now() + 60_000;
    session.pendingRetrySessionId = 'sess-r1';

    registry.clearSessionId('C1', '171.R1');

    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetrySessionId).toBeUndefined();
  });

  it('resetSessionContext clears pendingRetryAt and pendingRetrySessionId', () => {
    const registry = new SessionRegistry();
    const session = registry.createSession('U1', 'Tester', 'C1', '171.R2');
    session.sessionId = 'sess-r2';
    session.pendingRetryAt = Date.now() + 60_000;
    session.pendingRetrySessionId = 'sess-r2';

    registry.resetSessionContext('C1', '171.R2');

    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetrySessionId).toBeUndefined();
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

/** A persisted retry marker owned by the default `liveSession` run (`sess-1`). */
function pendingRetry(dueAt: number): Partial<ConversationSession> {
  return { pendingRetryAt: dueAt, pendingRetrySessionId: 'sess-1' };
}

const activeGoal = () => ({ goalId: 'g1', objective: 'finish the migration', status: 'active' }) as any;

function createHandler(sessions: Map<string, ConversationSession>) {
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.1' });
  const app = {
    client: { chat: { postMessage } },
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
  return { handler, claudeHandler, autoResume, postMessage };
}

const TARGET = { channelId: 'C1', threadTs: 'T1', ownerId: 'U1' };

describe('#351 scheduleErrorRetry: arms, persists and guards the fire', () => {
  beforeEach(() => vi.useFakeTimers());

  it('records the due time and owning sessionId, keeps the handle and saves immediately', () => {
    const session = liveSession();
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));
    const dueAt = Date.now() + 30_000;

    (handler as any).scheduleErrorRetry(TARGET, dueAt, 30_000, 'ctx');

    expect(session.pendingRetryAt).toBe(dueAt);
    expect(session.pendingRetrySessionId).toBe('sess-1');
    expect(session.pendingRetryTimer).toBeDefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_999);
    expect(autoResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoResume).toHaveBeenCalledTimes(1);
    expect(autoResume).toHaveBeenCalledWith(TARGET, undefined, 'ctx');
    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetrySessionId).toBeUndefined();
    expect(session.pendingRetryTimer).toBeUndefined();
  });

  it('saves the cleared marker when the timer fires', () => {
    const session = liveSession();
    const { handler, claudeHandler } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 30_000, 30_000, undefined);
    claudeHandler.saveSessions.mockClear();
    claudeHandler.saveSessions.mockImplementation(() => {
      // What reaches disk must already be the cleared state.
      expect(session.pendingRetryAt).toBeUndefined();
      expect(session.pendingRetrySessionId).toBeUndefined();
    });

    vi.advanceTimersByTime(30_000);

    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);
  });

  it('does not resume when pendingRetryAt was cleared before the timer fired', () => {
    const session = liveSession();
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 30_000, 30_000, undefined);

    session.pendingRetryAt = undefined;
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
  });

  it('does not resume from a timer whose due time was rescheduled', () => {
    const session = liveSession();
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 30_000, 30_000, undefined);

    // A newer schedule owns the session now; the first timer is superseded.
    session.pendingRetryAt = Date.now() + 90_000;
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
  });

  it('a reschedule cancels the superseded timer: one live timer, one resume', () => {
    const session = liveSession();
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 30_000, 30_000, 'first');
    const first = session.pendingRetryTimer;

    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 90_000, 90_000, 'second');

    expect(session.pendingRetryTimer).not.toBe(first);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(90_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
    expect(autoResume).toHaveBeenCalledWith(TARGET, undefined, 'second');
  });

  it('clears and saves the persisted marker when the sessionId changed before the timer fired', () => {
    const session = liveSession();
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 30_000, 30_000, undefined);
    claudeHandler.saveSessions.mockClear();

    // e.g. an ingress hand-over that starts a fresh run without a registry reset
    session.sessionId = undefined;
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetrySessionId).toBeUndefined();
    expect(session.pendingRetryTimer).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);
  });

  it('leaves a newer schedule alone when the sessionId changed under a stale timer', () => {
    const session = liveSession();
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 30_000, 30_000, undefined);
    const staleTimer = session.pendingRetryTimer;

    // The new run scheduled its own retry; the old handle is simulated as
    // still live (the reschedule normally cancels it).
    session.sessionId = 'sess-2';
    const newerDueAt = Date.now() + 90_000;
    session.pendingRetryAt = newerDueAt;
    session.pendingRetrySessionId = 'sess-2';
    const newerTimer = setTimeout(() => {}, 90_000);
    session.pendingRetryTimer = newerTimer;
    vi.advanceTimersByTime(30_000);

    expect(staleTimer).not.toBe(newerTimer);
    expect(autoResume).not.toHaveBeenCalled();
    expect(session.pendingRetryAt).toBe(newerDueAt);
    expect(session.pendingRetrySessionId).toBe('sess-2');
    expect(session.pendingRetryTimer).toBe(newerTimer);
  });

  it('does not resume when the session is gone', () => {
    const sessions = new Map([['k1', liveSession()]]);
    const { handler, autoResume } = createHandler(sessions);
    (handler as any).scheduleErrorRetry(TARGET, Date.now() + 30_000, 30_000, undefined);

    sessions.delete('k1');
    vi.advanceTimersByTime(30_000);

    expect(autoResume).not.toHaveBeenCalled();
  });
});

describe('#351 resumePendingErrorRetries: re-arm after restart', () => {
  beforeEach(() => vi.useFakeTimers());

  it('re-arms a future due time for the remaining delay, then resumes once', () => {
    const dueAt = Date.now() + 60_000;
    const session = liveSession({ ...pendingRetry(dueAt), lastErrorContext: 'ctx' });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(1);

    vi.advanceTimersByTime(59_999);
    expect(autoResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoResume).toHaveBeenCalledTimes(1);
    expect(autoResume).toHaveBeenCalledWith(TARGET, undefined, 'ctx');
    expect(session.pendingRetryAt).toBeUndefined();

    vi.advanceTimersByTime(10 * 60_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('fires a past-due retry after the startup floor, not immediately', () => {
    const session = liveSession(pendingRetry(Date.now() - 10 * 60_000));
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(1);

    vi.advanceTimersByTime(4_999);
    expect(autoResume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('uses the session owner as the resume actor', () => {
    const session = liveSession({ ownerId: 'U_OWNER', ...pendingRetry(Date.now() + 1_000) });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    handler.resumePendingErrorRetries();
    vi.advanceTimersByTime(5_000);

    expect(autoResume).toHaveBeenCalledWith(
      { channelId: 'C1', threadTs: 'T1', ownerId: 'U_OWNER' },
      undefined,
      undefined,
    );
  });

  it('drops (and saves) instead of re-arming a retry that belongs to a previous run', () => {
    // The hand-over cleared sessionId (or a new run replaced it) before the
    // restart; the persisted retry would resume into the wrong run.
    const session = liveSession({ ...pendingRetry(Date.now() + 1_000), sessionId: undefined });
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(0);
    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetrySessionId).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(autoResume).not.toHaveBeenCalled();
  });

  it('drops instead of re-arming a session that went to sleep before the re-arm ran', () => {
    const session = liveSession({ ...pendingRetry(Date.now() + 1_000), state: 'SLEEPING' as any });
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(0);
    expect(session.pendingRetryAt).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(autoResume).not.toHaveBeenCalled();
  });

  it('does not re-arm a session that crash recovery already auto-resumed', async () => {
    const session = liveSession(pendingRetry(Date.now() + 1_000));
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
    expect(session.pendingRetrySessionId).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalled();

    expect(handler.resumePendingErrorRetries()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('keeps the due time of a session crash recovery only notified (no auto-resume)', async () => {
    const session = liveSession(pendingRetry(Date.now() + 1_000));
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
    const session = liveSession({ ...pendingRetry(Date.now() + 60_000), pendingRetryTimer: existing });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(0);
    expect(session.pendingRetryTimer).toBe(existing);

    vi.advanceTimersByTime(120_000);
    expect(autoResume).not.toHaveBeenCalled();
  });

  it('skips a Slack-less task (#612 R2): it is not runnable before the execution context exists', () => {
    const session = liveSession({
      ...pendingRetry(Date.now() + 60_000),
      channelId: '',
      threadTs: undefined,
      slackless: true,
    } as Partial<ConversationSession>);
    const { handler, autoResume } = createHandler(new Map([['task:t1', session]]));

    expect(handler.resumePendingErrorRetries()).toBe(0);
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

describe('#351 goal sessions: the retry belongs to whoever actually claims the session', () => {
  beforeEach(() => vi.useFakeTimers());

  it('goal loop not wired → the goal session keeps its retry and it is re-armed', () => {
    const session = liveSession({ ...pendingRetry(Date.now() + 1_000), goal: activeGoal() });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    // no setGoalTurnSettledHandler

    expect(handler.resumeActiveGoals()).toBe(0);
    expect(session.pendingRetryAt).toBeDefined();

    expect(handler.resumePendingErrorRetries()).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('goal loop throws for that session → the retry is kept and re-armed', () => {
    const session = liveSession({ ...pendingRetry(Date.now() + 1_000), goal: activeGoal() });
    const { handler, autoResume } = createHandler(new Map([['k1', session]]));
    handler.setGoalTurnSettledHandler(() => {
      throw new Error('controller not ready');
    });

    expect(handler.resumeActiveGoals()).toBe(0);
    expect(session.pendingRetryAt).toBeDefined();
    expect(session.pendingRetrySessionId).toBe('sess-1');

    expect(handler.resumePendingErrorRetries()).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(autoResume).toHaveBeenCalledTimes(1);
  });

  it('goal loop claims the session → the retry is cleared, saved and not re-armed', () => {
    const session = liveSession({ ...pendingRetry(Date.now() + 1_000), goal: activeGoal() });
    const { handler, claudeHandler, autoResume } = createHandler(new Map([['k1', session]]));
    const settled = vi.fn();
    handler.setGoalTurnSettledHandler(settled);

    expect(handler.resumeActiveGoals()).toBe(1);
    expect(settled).toHaveBeenCalledWith('k1');
    expect(session.pendingRetryAt).toBeUndefined();
    expect(session.pendingRetrySessionId).toBeUndefined();
    expect(claudeHandler.saveSessions).toHaveBeenCalledTimes(1);

    expect(handler.resumePendingErrorRetries()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(autoResume).not.toHaveBeenCalled();
  });
});

describe('#351 restart notice for a session whose error retry is still pending', () => {
  beforeEach(() => vi.useFakeTimers());

  const recovered = (shouldAutoResume: boolean) => [
    {
      channelId: 'C1',
      threadTs: 'T1',
      ownerId: 'U1',
      activityState: 'idle',
      sessionKey: 'k1',
      shouldAutoResume,
    },
  ];

  async function noticeFor(session: ConversationSession, shouldAutoResume = false): Promise<string> {
    const { handler, claudeHandler, postMessage } = createHandler(new Map([['k1', session]]));
    claudeHandler.getCrashRecoveredSessions.mockReturnValue(recovered(shouldAutoResume));
    await handler.notifyCrashRecovery();
    expect(postMessage).toHaveBeenCalledTimes(1);
    return postMessage.mock.calls[0][0].text as string;
  }

  it('says when the scheduled retry continues instead of asking the user to retry', async () => {
    const text = await noticeFor(liveSession(pendingRetry(Date.now() + 10 * 60_000)));

    expect(text).toBe('⚠️ 서비스가 재시작되었습니다. 예약된 자동 재시도는 약 10분 후 이어서 진행합니다.');
  });

  it('rounds a partial minute up and floors a past-due retry at the startup delay', async () => {
    expect(await noticeFor(liveSession(pendingRetry(Date.now() + 61_000)))).toContain('약 2분 후');
    expect(await noticeFor(liveSession(pendingRetry(Date.now() - 10 * 60_000)))).toContain('약 1분 후');
  });

  it('keeps the retry-by-hand text when the retry belongs to a previous run', async () => {
    const text = await noticeFor(liveSession({ ...pendingRetry(Date.now() + 60_000), sessionId: 'sess-2' }));

    expect(text).toContain('다시 시도해주세요.');
  });

  it('keeps the retry-by-hand text when no retry is pending', async () => {
    expect(await noticeFor(liveSession())).toContain('다시 시도해주세요.');
  });

  it('keeps the auto-resume text for a session that was working', async () => {
    const text = await noticeFor(liveSession(pendingRetry(Date.now() + 60_000)), true);

    expect(text).toContain('자동으로 재개합니다...');
  });

  it('keeps the retry-by-hand text for an active-goal session (the goal loop owns it)', async () => {
    const text = await noticeFor(liveSession({ ...pendingRetry(Date.now() + 60_000), goal: activeGoal() }));

    expect(text).toContain('다시 시도해주세요.');
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
    expect(session.pendingRetrySessionId).toBe('sess-1');
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
