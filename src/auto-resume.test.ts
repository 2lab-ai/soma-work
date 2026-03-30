/**
 * Auto-Resume Interrupted Sessions — Contract Tests (RED)
 *
 * Trace: docs/auto-resume/trace.md
 * These tests verify the auto-resume behavior after server restart.
 * All tests should be RED (failing) until implementation is complete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock(import('./env-paths'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: '/tmp/soma-work-auto-resume-test',
  };
});

import { SlackHandler } from './slack-handler';

/**
 * Helper to create a SlackHandler with mocked dependencies
 */
function createTestHandler() {
  const mockPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: '9999.0001' });
  const app = {
    client: {
      chat: { postMessage: mockPostMessage },
    },
  } as any;

  const mockGetCrashRecoveredSessions = vi.fn().mockReturnValue([]);
  const mockClearCrashRecoveredSessions = vi.fn();
  const claudeHandler = {
    getCrashRecoveredSessions: mockGetCrashRecoveredSessions,
    clearCrashRecoveredSessions: mockClearCrashRecoveredSessions,
  } as any;

  const mcpManager = {} as any;

  const handler = new SlackHandler(app, claudeHandler, mcpManager);

  return {
    handler,
    app,
    claudeHandler,
    mockPostMessage,
    mockGetCrashRecoveredSessions,
    mockClearCrashRecoveredSessions,
  };
}

const RESUME_PROMPT =
  '서비스가 재시작되어 이전 작업이 중단되었다. 아래 순서로 작업을 이어가라:\n' +
  '1. mcp__slack-mcp__get_thread_messages (offset: 0, limit: 50)으로 이 스레드의 전체 대화를 먼저 읽어라.\n' +
  '2. 유저가 마지막으로 요청한 작업이 무엇인지 파악하라.\n' +
  '3. 네가 마지막으로 어디까지 진행했는지 확인하라 (git status, 파일 상태 등).\n' +
  '4. 중단된 지점부터 작업을 이어서 완료하라.\n' +
  '5. 만약 작업 상태를 파악할 수 없으면, 유저에게 현재 상황을 설명하고 다음 단계를 물어라.';

describe('Auto-Resume: S1 — Working session auto-resumes after restart', () => {
  // Trace: S1, Section 3b-3c — notifyCrashRecovery calls handleMessage for working sessions
  it('notifyCrashRecovery_calls_handleMessage_for_working_sessions', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    // Mock handleMessage to track calls
    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    handlerAny.handleMessage = handleMessageSpy;

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C123',
        threadTs: '1700000000.000100',
        ownerId: 'U456',
        ownerName: 'Zhuge',
        activityState: 'working',
        sessionKey: 'C123-1700000000.000100',
      },
    ]);

    await handler.notifyCrashRecovery();

    // handleMessage should have been called with a synthetic event
    expect(handleMessageSpy).toHaveBeenCalledTimes(1);
    const syntheticEvent = handleMessageSpy.mock.calls[0][0];
    expect(syntheticEvent.user).toBe('U456');
    expect(syntheticEvent.channel).toBe('C123');
    expect(syntheticEvent.thread_ts).toBe('1700000000.000100');
    expect(syntheticEvent.text).toBe(RESUME_PROMPT);
  });

  // Trace: S1, Section 3c — autoResumeSession creates correct synthetic event
  it('autoResumeSession_creates_correct_synthetic_event', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    handlerAny.handleMessage = handleMessageSpy;

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C999',
        threadTs: '1700000001.000200',
        ownerId: 'U789',
        ownerName: 'TestUser',
        activityState: 'working',
        sessionKey: 'C999-1700000001.000200',
      },
    ]);

    await handler.notifyCrashRecovery();

    const syntheticEvent = handleMessageSpy.mock.calls[0][0];
    // Verify all MessageEvent fields are correctly mapped
    expect(syntheticEvent).toMatchObject({
      user: 'U789',
      channel: 'C999',
      thread_ts: '1700000001.000200',
      text: RESUME_PROMPT,
    });
    // ts should use the notification message's ts (real Slack message)
    expect(syntheticEvent.ts).toBe('9999.0001');
  });

  // Trace: S1, Section 6 — auto-resume notification message differs from manual
  it('auto_resume_notification_message_differs_from_manual', async () => {
    const { handler, mockPostMessage, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;
    handlerAny.handleMessage = vi.fn().mockResolvedValue(undefined);

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C123',
        threadTs: '1700000000.000100',
        ownerId: 'U456',
        ownerName: 'Zhuge',
        activityState: 'working',
        sessionKey: 'C123-1700000000.000100',
      },
    ]);

    await handler.notifyCrashRecovery();

    // Notification for working sessions should indicate auto-resume
    const notificationCall = mockPostMessage.mock.calls[0];
    const messageText = notificationCall[0].text;
    expect(messageText).toContain('자동으로 재개');
    expect(messageText).not.toContain('다시 시도해주세요');
  });
});

describe('Auto-Resume: S2 — Waiting session gets notification only', () => {
  // Trace: S2, Section 3a — does not auto-resume waiting sessions
  it('notifyCrashRecovery_does_not_auto_resume_waiting_sessions', async () => {
    const { handler, mockPostMessage, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    handlerAny.handleMessage = handleMessageSpy;

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C123',
        threadTs: '1700000000.000100',
        ownerId: 'U456',
        ownerName: 'Zhuge',
        activityState: 'waiting',
        sessionKey: 'C123-1700000000.000100',
      },
    ]);

    await handler.notifyCrashRecovery();

    // handleMessage should NOT be called for waiting sessions
    expect(handleMessageSpy).not.toHaveBeenCalled();

    // But notification should still be sent
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const messageText = mockPostMessage.mock.calls[0][0].text;
    expect(messageText).toContain('다시 시도해주세요');
  });
});

describe('Auto-Resume: S3 — Auto-resume failure is isolated', () => {
  // Trace: S3, Section 3a — catches handleMessage errors
  it('autoResumeSession_catches_handleMessage_errors', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    handlerAny.handleMessage = vi.fn().mockRejectedValue(new Error('SDK connection failed'));

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C123',
        threadTs: '1700000000.000100',
        ownerId: 'U456',
        ownerName: 'Zhuge',
        activityState: 'working',
        sessionKey: 'C123-1700000000.000100',
      },
    ]);

    // Should NOT throw even when handleMessage fails
    await expect(handler.notifyCrashRecovery()).resolves.not.toThrow();
  });

  // Trace: S3, Section 3b — continues processing after resume failure
  it('notifyCrashRecovery_continues_after_resume_failure', async () => {
    const { handler, mockPostMessage, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    // First call fails, second succeeds
    handlerAny.handleMessage = vi.fn()
      .mockRejectedValueOnce(new Error('SDK connection failed'))
      .mockResolvedValueOnce(undefined);

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C1',
        threadTs: 't1',
        ownerId: 'U1',
        activityState: 'working',
        sessionKey: 'C1-t1',
      },
      {
        channelId: 'C2',
        threadTs: 't2',
        ownerId: 'U2',
        activityState: 'working',
        sessionKey: 'C2-t2',
      },
    ]);

    const result = await handler.notifyCrashRecovery();

    // Both notifications should be sent despite first resume failure
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    // handleMessage called for both working sessions
    expect(handlerAny.handleMessage).toHaveBeenCalledTimes(2);
  });

  // Trace: S3 — skips auto-resume when notification fails (channel inaccessible)
  it('notifyCrashRecovery_skips_resume_when_notification_fails', async () => {
    const { handler, mockPostMessage, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    handlerAny.handleMessage = handleMessageSpy;

    // Notification fails for first session
    mockPostMessage
      .mockRejectedValueOnce(new Error('channel_not_found'))
      .mockResolvedValueOnce({ ok: true, ts: '9999.0002' });

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C1',
        threadTs: 't1',
        ownerId: 'U1',
        activityState: 'working',
        sessionKey: 'C1-t1',
      },
      {
        channelId: 'C2',
        threadTs: 't2',
        ownerId: 'U2',
        activityState: 'working',
        sessionKey: 'C2-t2',
      },
    ]);

    await handler.notifyCrashRecovery();

    // Only second session should have auto-resume called (first notification failed → skip)
    expect(handleMessageSpy).toHaveBeenCalledTimes(1);
    expect(handleMessageSpy.mock.calls[0][0].channel).toBe('C2');
  });
});

describe('Auto-Resume: S4 — Multiple sessions with delay', () => {
  // Trace: S4, Section 3a — processes sessions with delay
  it('notifyCrashRecovery_processes_sessions_with_delay', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;
    handlerAny.handleMessage = vi.fn().mockResolvedValue(undefined);

    mockGetCrashRecoveredSessions.mockReturnValue([
      { channelId: 'C1', threadTs: 't1', ownerId: 'U1', activityState: 'working', sessionKey: 'C1-t1' },
      { channelId: 'C2', threadTs: 't2', ownerId: 'U2', activityState: 'working', sessionKey: 'C2-t2' },
    ]);

    const start = Date.now();
    await handler.notifyCrashRecovery();
    const elapsed = Date.now() - start;

    // With 2 sessions and 2s delay between each, should take at least 2s
    // (delay is between sessions, so 1 delay for 2 sessions)
    expect(elapsed).toBeGreaterThanOrEqual(1500); // Allow some tolerance
  });

  // Regression: notifyCrashRecovery should NOT block on slow handleMessage (fire-and-forget)
  it('notifyCrashRecovery_does_not_block_on_slow_handleMessage', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    // Simulate a handleMessage that takes 30 seconds (like real Claude streaming)
    handlerAny.handleMessage = vi.fn().mockImplementation(
      () => new Promise(resolve => setTimeout(resolve, 30_000)),
    );

    mockGetCrashRecoveredSessions.mockReturnValue([
      { channelId: 'C1', threadTs: 't1', ownerId: 'U1', activityState: 'working', sessionKey: 'C1-t1' },
      { channelId: 'C2', threadTs: 't2', ownerId: 'U2', activityState: 'working', sessionKey: 'C2-t2' },
    ]);

    const start = Date.now();
    await handler.notifyCrashRecovery();
    const elapsed = Date.now() - start;

    // notifyCrashRecovery should complete in ~2s (delay between sessions)
    // NOT 60s+ (waiting for handleMessage to finish)
    expect(elapsed).toBeLessThan(5000);

    // Both sessions should have been fired (even though still running)
    expect(handlerAny.handleMessage).toHaveBeenCalledTimes(2);
  });

  // Trace: S4, Section 3a — resumes only working sessions in batch
  it('notifyCrashRecovery_resumes_only_working_sessions_in_batch', async () => {
    const { handler, mockPostMessage, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;
    handlerAny.handleMessage = vi.fn().mockResolvedValue(undefined);

    mockGetCrashRecoveredSessions.mockReturnValue([
      { channelId: 'C1', threadTs: 't1', ownerId: 'U1', activityState: 'working', sessionKey: 'C1-t1' },
      { channelId: 'C2', threadTs: 't2', ownerId: 'U2', activityState: 'waiting', sessionKey: 'C2-t2' },
      { channelId: 'C3', threadTs: 't3', ownerId: 'U3', activityState: 'working', sessionKey: 'C3-t3' },
    ]);

    await handler.notifyCrashRecovery();

    // All 3 get notifications
    expect(mockPostMessage).toHaveBeenCalledTimes(3);

    // Only 2 working sessions get auto-resumed
    expect(handlerAny.handleMessage).toHaveBeenCalledTimes(2);

    // Verify correct sessions were resumed
    const resumedChannels = handlerAny.handleMessage.mock.calls.map(
      (call: any[]) => call[0].channel,
    );
    expect(resumedChannels).toContain('C1');
    expect(resumedChannels).toContain('C3');
    expect(resumedChannels).not.toContain('C2');
  });
});

describe('Auto-Resume: CrashRecoveredSession sessionKey field', () => {
  // Trace: S1, Section 3a — sessionKey is populated during loadSessions
  it('loadSessions_populates_sessionKey_in_crash_recovered_sessions', async () => {
    // This test verifies the session-registry change
    // Import directly to test the type extension
    const fs = await import('fs');
    const path = await import('path');

    const TEST_DIR = '/tmp/soma-work-auto-resume-test';
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }

    // Write a test sessions.json with a working session
    const sessionsData = [
      {
        key: 'C123-1700000000.000100',
        ownerId: 'U456',
        ownerName: 'Zhuge',
        userId: 'U456',
        channelId: 'C123',
        threadTs: '1700000000.000100',
        sessionId: 'sess-abc-123',
        isActive: true,
        lastActivity: new Date().toISOString(),
        activityState: 'working',
        state: 'MAIN',
      },
    ];
    fs.writeFileSync(
      path.join(TEST_DIR, 'sessions.json'),
      JSON.stringify(sessionsData),
    );

    const { SessionRegistry } = await import('./session-registry');
    const registry = new SessionRegistry();
    registry.loadSessions();

    const recovered = registry.getCrashRecoveredSessions();
    expect(recovered.length).toBe(1);
    expect(recovered[0].sessionKey).toBe('C123-1700000000.000100');

    // Cleanup
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });
});

describe('Auto-Resume: Context enrichment with title/workflow', () => {
  it('autoResumeSession_includes_title_and_workflow_in_prompt', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    handlerAny.handleMessage = handleMessageSpy;

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C123',
        threadTs: '1700000000.000100',
        ownerId: 'U456',
        ownerName: 'Zhuge',
        activityState: 'working',
        sessionKey: 'C123-1700000000.000100',
        title: 'Fix login authentication bug',
        workflow: 'jira-create-pr',
      },
    ]);

    await handler.notifyCrashRecovery();

    expect(handleMessageSpy).toHaveBeenCalledTimes(1);
    const syntheticEvent = handleMessageSpy.mock.calls[0][0];
    expect(syntheticEvent.text).toContain('--- 중단 시점 컨텍스트 ---');
    expect(syntheticEvent.text).toContain('세션 제목: Fix login authentication bug');
    expect(syntheticEvent.text).toContain('워크플로우: jira-create-pr');
  });

  it('autoResumeSession_omits_context_section_when_no_title_or_workflow', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    handlerAny.handleMessage = handleMessageSpy;

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C123',
        threadTs: '1700000000.000100',
        ownerId: 'U456',
        activityState: 'working',
        sessionKey: 'C123-1700000000.000100',
      },
    ]);

    await handler.notifyCrashRecovery();

    const syntheticEvent = handleMessageSpy.mock.calls[0][0];
    expect(syntheticEvent.text).toBe(RESUME_PROMPT);
    expect(syntheticEvent.text).not.toContain('--- 중단 시점 컨텍스트 ---');
  });

  it('autoResumeSession_skips_default_workflow_in_context', async () => {
    const { handler, mockGetCrashRecoveredSessions } = createTestHandler();
    const handlerAny = handler as any;

    const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
    handlerAny.handleMessage = handleMessageSpy;

    mockGetCrashRecoveredSessions.mockReturnValue([
      {
        channelId: 'C123',
        threadTs: '1700000000.000100',
        ownerId: 'U456',
        activityState: 'working',
        sessionKey: 'C123-1700000000.000100',
        title: 'Some task',
        workflow: 'default',
      },
    ]);

    await handler.notifyCrashRecovery();

    const syntheticEvent = handleMessageSpy.mock.calls[0][0];
    expect(syntheticEvent.text).toContain('세션 제목: Some task');
    expect(syntheticEvent.text).not.toContain('워크플로우');
  });
});
