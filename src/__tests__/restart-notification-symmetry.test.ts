/**
 * Restart Notification Symmetry — Contract Tests (RED first)
 *
 * Verifies that the set of sessions notified at shutdown equals the set
 * notified at restart (and that auto-resume is decided by the captured
 * `wasWorkingAtShutdown` marker rather than the possibly-stale persisted
 * `activityState`).
 *
 * Root cause of the bug fixed by this change:
 *   `setActivityState('working' | 'waiting')` does NOT save to disk
 *   (only 'idle' transitions persist). So a session that was actively
 *   working when the process died could be loaded back with
 *   `activityState='idle'` — and the previous restart filter
 *   (`activityState !== 'idle'`) silently dropped it from
 *   `_crashRecoveredSessions`, so the user never saw the
 *   "자동으로 재개합니다..." notification.
 *
 * Fix: at graceful shutdown, `notifyShutdown` records on each successfully
 * notified session:
 *   - `shutdownNotificationSent = true`
 *   - `wasWorkingAtShutdown = (activityState === 'working')`
 *   - `shutdownNotifiedAt = Date.now()`
 * These markers are persisted. On reload, any session carrying
 * `shutdownNotificationSent` joins the crash-recovery batch — using
 * `wasWorkingAtShutdown` (NOT the stale persisted `activityState`) to
 * decide whether to auto-resume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/soma-work-restart-symmetry-test';

vi.mock(import('../env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: '/tmp/soma-work-restart-symmetry-test',
  };
});

import type { ClaudeHandler } from '../claude-handler';
import { SessionRegistry } from '../session-registry';
import { SessionUiManager } from '../slack/session-manager';
import type { SlackApiHelper } from '../slack/slack-api-helper';
import { SlackHandler } from '../slack-handler';
import type { ConversationSession } from '../types';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------- notifyShutdown: stamps marker ----------

describe('Restart symmetry: notifyShutdown stamps recovery markers', () => {
  const buildManager = () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: '999.111', channel: 'C1' });
    const slackApi = { postMessage } as unknown as SlackApiHelper;
    const sessions = new Map<string, ConversationSession>();
    const claudeHandler = {
      getAllSessions: vi.fn(() => sessions),
    } as unknown as ClaudeHandler;
    const manager = new SessionUiManager(claudeHandler, slackApi);
    return { manager, sessions, postMessage };
  };

  it('marks every notified session with shutdownNotificationSent=true', async () => {
    const { manager, sessions } = buildManager();
    const s1: ConversationSession = {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      sessionId: 'sid-1',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'working',
    } as ConversationSession;
    sessions.set('k1', s1);

    await manager.notifyShutdown();

    expect(s1.shutdownNotificationSent).toBe(true);
    expect(s1.shutdownNotifiedAt).toBeTypeOf('number');
  });

  it('captures wasWorkingAtShutdown from in-memory activityState (not what gets saved)', async () => {
    const { manager, sessions } = buildManager();
    const working: ConversationSession = {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      sessionId: 'sid-1',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'working',
    } as ConversationSession;
    const idle: ConversationSession = {
      ownerId: 'U2',
      userId: 'U2',
      channelId: 'C2',
      threadTs: 't2',
      sessionId: 'sid-2',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'idle',
    } as ConversationSession;
    sessions.set('k-working', working);
    sessions.set('k-idle', idle);

    await manager.notifyShutdown();

    expect(working.wasWorkingAtShutdown).toBe(true);
    expect(idle.wasWorkingAtShutdown).toBe(false);
  });

  it('does NOT mark a session when postMessage fails (channel inaccessible)', async () => {
    const { manager, sessions, postMessage } = buildManager();
    postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    const s1: ConversationSession = {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      sessionId: 'sid-1',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'working',
    } as ConversationSession;
    sessions.set('k1', s1);

    await manager.notifyShutdown();

    expect(s1.shutdownNotificationSent).toBeFalsy();
    // wasWorkingAtShutdown must also be cleared so the disk record doesn't
    // later trick loadSessions into a spurious recovery.
    expect(s1.wasWorkingAtShutdown).toBeFalsy();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Race-1: activityState flips to 'idle' DURING the awaited postMessage
  //
  // Observed at iq-64 2026-05-15T07:31:14Z. Every "Sent shutdown
  // notification" log line printed `wasWorking:false`, including for the
  // session that was actively running tools (creating PR #2590). Cause:
  // notifyShutdown read `session.activityState === 'working'` AFTER
  // awaiting postMessage. During that await, the Node event loop drained
  // pending Claude SDK stream-completion callbacks for in-flight turns,
  // which call setActivityState('idle'). By the time the marker capture
  // ran, the state had already flipped.
  //
  // The fix snapshots wasWorking BEFORE the await.
  // ─────────────────────────────────────────────────────────────────────
  it('captures wasWorking from a pre-await snapshot when activityState flips during postMessage', async () => {
    const { manager, sessions, postMessage } = buildManager();
    const working: ConversationSession = {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      sessionId: 'sid-1',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'working',
    } as ConversationSession;
    sessions.set('k1', working);

    // Simulate the prod race: during the awaited postMessage, an
    // unrelated event-loop turn flips activityState to 'idle' (the
    // in-flight Claude SDK turn happens to complete). The fix must
    // capture wasWorking BEFORE this flip.
    postMessage.mockImplementationOnce(async () => {
      working.activityState = 'idle';
      return { ts: '1.1', channel: 'C1' };
    });

    await manager.notifyShutdown();

    expect(working.shutdownNotificationSent).toBe(true);
    expect(working.wasWorkingAtShutdown).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Race-2: process.exit beats slow postMessage
  //
  // Same iq-64 incident: notifyShutdown is bounded by a 5s
  // `Promise.race` and the parent cleanup runs `saveSessions()` +
  // `process.exit(0)` immediately after. With 60 sessions at ~300ms
  // Slack roundtrip each, ~49 sessions' postMessage never returns
  // before exit. Those sessions never had `shutdownNotificationSent`
  // stamped under the old "stamp after await" ordering, so on the
  // next start `loadSessions` saw a stale `activityState: 'idle'` and
  // dropped them from `_crashRecoveredSessions`. The user's session
  // (creating PR #2590) was one of these — it stayed frozen with no
  // recovery message and no auto-resume.
  //
  // Fix: stamp the marker BEFORE awaiting postMessage. The
  // optimistic stamp is cleared in the catch branch on hard failures
  // (channel deleted etc.) so the prior "do not mark on failure"
  // invariant still holds, but a still-pending postMessage at
  // process.exit time leaves the marker persisted, which is correct
  // — the session WAS active when shutdown began.
  // ─────────────────────────────────────────────────────────────────────
  it('stamps the recovery marker before awaiting postMessage so a hung post does not erase the recovery record', async () => {
    const { manager, sessions, postMessage } = buildManager();
    const working: ConversationSession = {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: 't1',
      sessionId: 'sid-1',
      isActive: true,
      lastActivity: new Date(),
      activityState: 'working',
    } as ConversationSession;
    sessions.set('k1', working);

    // postMessage never resolves — simulates a hung Slack call that
    // the cleanup-level Promise.race timeout will abandon before exit.
    let resolveHung: (v: { ts: string; channel: string }) => void = () => {};
    postMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHung = resolve;
        }),
    );

    // Kick off but do NOT await — mirror cleanup() which races against
    // a 5s deadline and then proceeds to saveSessions/process.exit.
    const shutdownPromise = manager.notifyShutdown();

    // Yield once so the loop has a chance to push the per-session
    // promise and synchronously stamp the marker before awaiting.
    await new Promise<void>((r) => setImmediate(r));

    // The marker must already be on disk-shape (in-memory ready for
    // saveSessions) even though postMessage is still pending.
    expect(working.shutdownNotificationSent).toBe(true);
    expect(working.wasWorkingAtShutdown).toBe(true);
    expect(working.shutdownNotifiedAt).toBeTypeOf('number');

    // Drain so the test doesn't leak the pending promise.
    resolveHung({ ts: '1.1', channel: 'C1' });
    await shutdownPromise;
  });
});

// ---------- loadSessions: marker drives recovery batch ----------

describe('Restart symmetry: loadSessions honors shutdownNotificationSent marker', () => {
  it('recovers a session whose persisted activityState is idle but marker says working', async () => {
    // This is the headline bug case.
    // Setup: session was actively working when service was shut down.
    // setActivityState('working') did NOT save → on-disk activityState='idle'.
    // notifyShutdown set the marker: shutdownNotificationSent=true,
    // wasWorkingAtShutdown=true. saveSessions persisted both.
    const sessionsData = [
      {
        key: 'C123-1700000000.000100',
        ownerId: 'U456',
        userId: 'U456',
        channelId: 'C123',
        threadTs: '1700000000.000100',
        sessionId: 'sess-abc-123',
        isActive: true,
        lastActivity: new Date().toISOString(),
        activityState: 'idle', // <- STALE
        shutdownNotificationSent: true,
        wasWorkingAtShutdown: true, // <- AUTHORITATIVE
        shutdownNotifiedAt: Date.now(),
        state: 'MAIN',
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();

    const recovered = registry.getCrashRecoveredSessions();
    expect(recovered.length).toBe(1);
    expect(recovered[0].sessionKey).toBe('C123-1700000000.000100');
    expect(recovered[0].shouldAutoResume).toBe(true);
  });

  it('recovers an idle session that received a shutdown notification (no auto-resume)', async () => {
    // Symmetry: every session that got a shutdown notification should get a
    // restart notification, even if it was idle. Auto-resume stays off for
    // non-working sessions.
    const sessionsData = [
      {
        key: 'C-idle-1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C-idle',
        threadTs: 'ts-idle',
        sessionId: 'sess-idle',
        isActive: true,
        lastActivity: new Date().toISOString(),
        activityState: 'idle',
        shutdownNotificationSent: true,
        wasWorkingAtShutdown: false,
        state: 'MAIN',
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();

    const recovered = registry.getCrashRecoveredSessions();
    expect(recovered.length).toBe(1);
    expect(recovered[0].shouldAutoResume).toBe(false);
  });

  it('falls back to activityState-based detection when marker is absent (crash without graceful shutdown)', async () => {
    // uncaughtException path: saveSessions() runs but notifyShutdown() did not.
    // The marker is not present. We still want the existing crash-recovery
    // behavior to kick in for sessions whose persisted activityState shows
    // they were actively working / waiting.
    const sessionsData = [
      {
        key: 'C-crash-1',
        ownerId: 'U1',
        userId: 'U1',
        channelId: 'C-crash',
        threadTs: 'ts-crash',
        sessionId: 'sess-crash',
        isActive: true,
        lastActivity: new Date().toISOString(),
        activityState: 'working', // persisted because the working transition
        // happened to coincide with an unrelated saveSessions call before the crash
        state: 'MAIN',
      },
    ];
    fs.writeFileSync(path.join(TEST_DIR, 'sessions.json'), JSON.stringify(sessionsData));

    const registry = new SessionRegistry();
    registry.loadSessions();

    const recovered = registry.getCrashRecoveredSessions();
    expect(recovered.length).toBe(1);
    expect(recovered[0].shouldAutoResume).toBe(true);
  });
});

// ---------- notifyCrashRecovery: shouldAutoResume drives auto-resume ----------

describe('Restart symmetry: notifyCrashRecovery routes auto-resume via shouldAutoResume', () => {
  function buildHandler() {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '9999.0001' });
    const app = {
      client: { chat: { postMessage } },
      assistant: vi.fn(),
    } as any;
    const getCrashRecoveredSessions = vi.fn().mockReturnValue([]);
    const clearCrashRecoveredSessions = vi.fn();
    const getSessionByKey = vi.fn().mockReturnValue(undefined);
    const saveSessions = vi.fn();
    const claudeHandler = {
      getCrashRecoveredSessions,
      clearCrashRecoveredSessions,
      getSessionByKey,
      saveSessions,
    } as any;
    const handler = new SlackHandler(app, claudeHandler, {} as any);
    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    (handler as any).handleMessage = handleMessageSpy;
    return { handler, postMessage, getCrashRecoveredSessions, handleMessageSpy };
  }

  it('auto-resumes when shouldAutoResume=true even if activityState=idle', async () => {
    const { handler, postMessage, getCrashRecoveredSessions, handleMessageSpy } = buildHandler();
    getCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C1',
        threadTs: 't1',
        ownerId: 'U1',
        activityState: 'idle', // stale
        sessionKey: 'C1-t1',
        shouldAutoResume: true, // authoritative
      },
    ]);

    await handler.notifyCrashRecovery();

    expect(postMessage).toHaveBeenCalledTimes(1);
    const text = postMessage.mock.calls[0][0].text as string;
    expect(text).toContain('자동으로 재개');
    expect(handleMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-resume when shouldAutoResume=false even if activityState=working', async () => {
    // Defense in depth: trust the explicit decision flag over the raw state string.
    const { handler, postMessage, getCrashRecoveredSessions, handleMessageSpy } = buildHandler();
    getCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C1',
        threadTs: 't1',
        ownerId: 'U1',
        activityState: 'working',
        sessionKey: 'C1-t1',
        shouldAutoResume: false,
      },
    ]);

    await handler.notifyCrashRecovery();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(handleMessageSpy).not.toHaveBeenCalled();
  });
});
