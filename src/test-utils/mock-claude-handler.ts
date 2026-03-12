import { vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

export interface MockClaudeHandler {
  getSessionByKey: MockFn;
  setActivityStateByKey: MockFn;
  getAllSessions: MockFn;
  getSessionKey: MockFn;
}

/**
 * ClaudeHandler mock factory.
 * 필수 메서드의 기본 mock을 제공하며, overrides로 개별 메서드 교체 가능.
 */
export function createMockClaudeHandler(overrides: Partial<MockClaudeHandler> = {}): MockClaudeHandler {
  return {
    getSessionByKey: vi.fn().mockReturnValue(undefined),
    setActivityStateByKey: vi.fn(),
    getAllSessions: vi.fn().mockReturnValue(new Map()),
    getSessionKey: vi.fn().mockReturnValue('C123:thread123'),
    ...overrides,
  };
}
