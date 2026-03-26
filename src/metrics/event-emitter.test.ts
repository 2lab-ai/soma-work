import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MetricsEventEmitter } from './event-emitter';
import { MetricsEventStore } from './event-store';
import { ConversationSession } from '../types';

// Contract tests — Scenario 2 & 3: MetricsEventEmitter + Hooks
// Trace: docs/daily-weekly-report/trace.md

// Mock EventStore
vi.mock('./event-store', () => ({
  MetricsEventStore: vi.fn().mockImplementation(() => ({
    append: vi.fn().mockResolvedValue(undefined),
  })),
}));

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U123',
    ownerName: 'TestUser',
    userId: 'U123',
    channelId: 'C456',
    threadTs: '123.456',
    isActive: true,
    lastActivity: new Date(),
    state: 'MAIN',
    activityState: 'idle',
    ...overrides,
  } as ConversationSession;
}

describe('MetricsEventEmitter', () => {
  let emitter: MetricsEventEmitter;
  let mockStore: { append: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockStore = { append: vi.fn().mockResolvedValue(undefined) };
    emitter = new MetricsEventEmitter(mockStore as any);
  });

  // === Scenario 2: Session Lifecycle ===

  // Trace: Scenario 2, Section 3a-3c — session_created event
  it('sessionCreated_writesEventToStore', async () => {
    const session = makeSession();
    await emitter.emitSessionCreated(session);

    expect(mockStore.append).toHaveBeenCalledOnce();
    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('session_created');
    expect(event.userId).toBe('U123');
    expect(event.userName).toBe('TestUser');
  });

  // Trace: Scenario 2, Section 3a-3c — session_slept event
  it('sessionSlept_writesEventToStore', async () => {
    const session = makeSession();
    await emitter.emitSessionSlept(session);

    expect(mockStore.append).toHaveBeenCalledOnce();
    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('session_slept');
  });

  // Trace: Scenario 2, Section 3a-3c — session_closed event
  it('sessionClosed_writesEventToStore', async () => {
    const session = makeSession();
    await emitter.emitSessionClosed(session, 'C456-123.456');

    expect(mockStore.append).toHaveBeenCalledOnce();
    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('session_closed');
    expect(event.sessionKey).toBe('C456-123.456');
  });

  // Trace: Scenario 2, Section 3a — correct metadata transformation
  it('sessionCreated_containsCorrectMetadata', async () => {
    const session = makeSession({ channelId: 'C789', threadTs: '999.888' });
    await emitter.emitSessionCreated(session);

    const event = mockStore.append.mock.calls[0][0];
    expect(event.metadata).toEqual(
      expect.objectContaining({ channelId: 'C789', threadTs: '999.888' })
    );
  });

  // Trace: Scenario 2, Section 5 — fire-and-forget resilience
  it('fireAndForget_doesNotBlockOnFailure', async () => {
    mockStore.append.mockRejectedValueOnce(new Error('disk full'));
    // Should not throw
    await expect(emitter.emitSessionCreated(makeSession())).resolves.not.toThrow();
  });

  // === Scenario 3: Turn & GitHub Hooks ===

  // Trace: Scenario 3, Section 3a — user turn event
  it('turnUsed_userTurn_writesEvent', async () => {
    await emitter.emitTurnUsed('conv-1', 'U123', 'TestUser', 'user');

    expect(mockStore.append).toHaveBeenCalledOnce();
    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('turn_used');
    expect(event.userId).toBe('U123');
    expect(event.metadata).toEqual(
      expect.objectContaining({ conversationId: 'conv-1', role: 'user' })
    );
  });

  // Trace: Scenario 3, Section 3a — assistant turn event
  it('turnUsed_assistantTurn_writesEvent', async () => {
    await emitter.emitTurnUsed('conv-1', 'assistant', 'assistant', 'assistant');

    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('turn_used');
    expect(event.metadata?.role).toBe('assistant');
  });

  // Trace: Scenario 3, Section 3b — issue_created on link add
  it('issueCreated_onLinkAdd', async () => {
    await emitter.emitGitHubEvent('issue_created', 'U123', 'TestUser', 'session-key', {
      url: 'https://github.com/org/repo/issues/1',
    });

    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('issue_created');
    expect(event.metadata?.url).toBe('https://github.com/org/repo/issues/1');
  });

  // Trace: Scenario 3, Section 3b — pr_created on link add
  it('prCreated_onLinkAdd', async () => {
    await emitter.emitGitHubEvent('pr_created', 'U123', 'TestUser', 'session-key', {
      url: 'https://github.com/org/repo/pull/2',
    });

    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('pr_created');
  });

  // Trace: Scenario 3, Section 3b — pr_merged on status change
  it('prMerged_onStatusChange', async () => {
    await emitter.emitGitHubEvent('pr_merged', 'U123', 'TestUser', 'session-key', {
      url: 'https://github.com/org/repo/pull/2',
    });

    const event = mockStore.append.mock.calls[0][0];
    expect(event.eventType).toBe('pr_merged');
  });

  // Trace: Scenario 3, Section 5 — missing userId defaults to unknown
  it('turnUsed_missingUserId_defaultsToUnknown', async () => {
    await emitter.emitTurnUsed('conv-1', undefined as any, undefined as any, 'user');

    const event = mockStore.append.mock.calls[0][0];
    expect(event.userId).toBe('unknown');
    expect(event.userName).toBe('unknown');
  });
});
