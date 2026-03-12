/**
 * Session result mock factory.
 * 기본 세션 데이터를 제공하며, 부분 오버라이드 가능.
 */
export interface MockSessionResult {
  session: { ownerId: string; channelId: string };
  sessionKey: string;
  isNewSession: boolean;
  userName: string;
  workingDirectory: string;
  abortController: AbortController;
  halted: boolean;
}

export function createMockSession(overrides: Partial<MockSessionResult> = {}): MockSessionResult {
  const defaults: MockSessionResult = {
    session: { ownerId: 'U123', channelId: 'C123' },
    sessionKey: 'C123:thread123',
    isNewSession: true,
    userName: 'Test User',
    workingDirectory: '/tmp/test-user',
    abortController: new AbortController(),
    halted: false,
  };

  return {
    ...defaults,
    ...overrides,
    session: { ...defaults.session, ...(overrides.session ?? {}) },
  };
}
