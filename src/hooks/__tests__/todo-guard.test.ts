import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env-paths and logger before importing modules
vi.mock('../../env-paths', () => ({
  DATA_DIR: '/tmp/test-hooks-todo-guard',
  IS_DEV: true,
}));
vi.mock('../../logger', () => ({
  Logger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

// Mock fs to prevent file I/O during tests
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('todo-guard', () => {
  let handlePreToolUse: typeof import('../todo-guard').handlePreToolUse;
  let hookState: typeof import('../hook-state').hookState;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const stateModule = await import('../hook-state');
    hookState = stateModule.hookState;

    const guardModule = await import('../todo-guard');
    handlePreToolUse = guardModule.handlePreToolUse;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not block exempt tool (ToolSearch)', () => {
    const result = handlePreToolUse({
      session_id: 'sess-1',
      tool_name: 'ToolSearch',
    });
    expect(result.blocked).toBe(false);
  });

  it('should not block TodoWrite and set marker via handlePreToolUse', () => {
    // TodoWrite is handled BEFORE exempt check to set the marker.
    // The shell proxy forwards TodoWrite specifically for this purpose.
    const result = handlePreToolUse({
      session_id: 'sess-1',
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'task 1', status: 'pending' }] },
    });
    expect(result.blocked).toBe(false);

    // Marker IS set via handlePreToolUse (TodoWrite handled before exempt check)
    const state = hookState.getTodoGuardState('sess-1');
    expect(state?.todoExists).toBe(true);
  });

  it('should not block TodoWrite with empty todos and not set marker', () => {
    const result = handlePreToolUse({
      session_id: 'sess-1',
      tool_name: 'TodoWrite',
      tool_input: { todos: [] },
    });
    expect(result.blocked).toBe(false);

    // Marker should NOT be set
    const state = hookState.getTodoGuardState('sess-1');
    expect(state).toBeUndefined();
  });

  it('should not block when no session_id (fail-open)', () => {
    const result = handlePreToolUse({
      tool_name: 'Bash',
    });
    expect(result.blocked).toBe(false);
  });

  it('should not block when under threshold and increment count', () => {
    for (let i = 0; i < 4; i++) {
      const result = handlePreToolUse({
        session_id: 'sess-1',
        tool_name: 'Bash',
      });
      expect(result.blocked).toBe(false);
    }

    const state = hookState.getTodoGuardState('sess-1');
    expect(state?.count).toBe(4);
  });

  it('should block at threshold (5 calls)', () => {
    // Make 5 calls to reach threshold
    for (let i = 0; i < 4; i++) {
      handlePreToolUse({
        session_id: 'sess-1',
        tool_name: 'Bash',
      });
    }

    const result = handlePreToolUse({
      session_id: 'sess-1',
      tool_name: 'Bash',
    });
    expect(result.blocked).toBe(true);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('TodoWrite');
  });

  it('should not block after TodoWrite marker is set (via hookState) regardless of count', () => {
    // Make 4 calls first
    for (let i = 0; i < 4; i++) {
      handlePreToolUse({
        session_id: 'sess-1',
        tool_name: 'Bash',
      });
    }

    // Set TodoWrite marker directly (as the shell proxy does)
    hookState.markTodoExists('sess-1');

    // Next calls should not be blocked even though count >= threshold
    const result = handlePreToolUse({
      session_id: 'sess-1',
      tool_name: 'Bash',
    });
    expect(result.blocked).toBe(false);
  });

  it('should track sessions independently', () => {
    // Fill session 1 to threshold
    for (let i = 0; i < 5; i++) {
      handlePreToolUse({
        session_id: 'sess-1',
        tool_name: 'Bash',
      });
    }

    // Session 2 should still be under threshold
    const result = handlePreToolUse({
      session_id: 'sess-2',
      tool_name: 'Bash',
    });
    expect(result.blocked).toBe(false);

    const state1 = hookState.getTodoGuardState('sess-1');
    const state2 = hookState.getTodoGuardState('sess-2');
    expect(state1?.count).toBe(5);
    expect(state2?.count).toBe(1);
  });
});
