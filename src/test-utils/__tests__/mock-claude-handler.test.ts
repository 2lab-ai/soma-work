import { describe, expect, it, vi } from 'vitest';
import { createMockClaudeHandler } from '../mock-claude-handler';

describe('createMockClaudeHandler', () => {
  it('should return an object with essential ClaudeHandler methods as mocks', () => {
    const mock = createMockClaudeHandler();

    expect(mock.getSessionByKey).toBeDefined();
    expect(mock.setActivityStateByKey).toBeDefined();
    expect(mock.getAllSessions).toBeDefined();
    expect(mock.getSessionKey).toBeDefined();
  });

  it('should have default return values', () => {
    const mock = createMockClaudeHandler();

    expect(mock.getAllSessions()).toEqual(new Map());
    expect(mock.getSessionByKey('key')).toBeUndefined();
  });

  it('should allow overriding specific methods', () => {
    const customSession = { id: 'custom' };
    const mock = createMockClaudeHandler({
      getSessionByKey: vi.fn().mockReturnValue(customSession),
    });

    expect(mock.getSessionByKey('key')).toEqual(customSession);
    // Non-overridden still present
    expect(mock.getAllSessions()).toEqual(new Map());
  });
});
