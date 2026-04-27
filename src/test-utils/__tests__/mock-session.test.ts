import { describe, expect, it } from 'vitest';
import { createMockSession } from '../mock-session';

describe('createMockSession', () => {
  it('should return a session with sensible defaults', () => {
    const session = createMockSession();

    expect(session.session.ownerId).toBe('U123');
    expect(session.session.channelId).toBe('C123');
    expect(session.sessionKey).toBe('C123:thread123');
    expect(session.isNewSession).toBe(true);
    expect(session.userName).toBe('Test User');
    expect(session.workingDirectory).toBeTruthy();
    expect(session.abortController).toBeInstanceOf(AbortController);
    expect(session.halted).toBe(false);
  });

  it('should allow partial overrides', () => {
    const session = createMockSession({
      session: { ownerId: 'U999', channelId: 'C999' },
      userName: 'Custom User',
      isNewSession: false,
    });

    expect(session.session.ownerId).toBe('U999');
    expect(session.session.channelId).toBe('C999');
    expect(session.userName).toBe('Custom User');
    expect(session.isNewSession).toBe(false);
    // Non-overridden defaults
    expect(session.sessionKey).toBe('C123:thread123');
    expect(session.halted).toBe(false);
  });

  it('should create independent instances', () => {
    const s1 = createMockSession();
    const s2 = createMockSession();

    s1.abortController.abort();
    expect(s2.abortController.signal.aborted).toBe(false);
  });
});
