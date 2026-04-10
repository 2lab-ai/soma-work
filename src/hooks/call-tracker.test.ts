import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env-paths and logger before importing modules
vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/test-hooks-call-tracker',
  IS_DEV: true,
}));
vi.mock('../logger', () => ({
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

describe('call-tracker', () => {
  let trackPreCall: typeof import('./call-tracker').trackPreCall;
  let trackPostCall: typeof import('./call-tracker').trackPostCall;
  let hookState: typeof import('./hook-state').hookState;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const stateModule = await import('./hook-state');
    hookState = stateModule.hookState;

    const trackerModule = await import('./call-tracker');
    trackPreCall = trackerModule.trackPreCall;
    trackPostCall = trackerModule.trackPostCall;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not create state for non-tracked tool (Read)', () => {
    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'Read',
    });
    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(0);
  });

  it('should not create state for non-tracked tool (Edit)', () => {
    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'Edit',
    });
    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(0);
  });

  it('should create pending call for Task tool', () => {
    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_input: { description: 'run tests' },
    });

    // Pending call should exist — verify by completing it
    trackPostCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_response: 'done',
    });
    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(1);
    expect(log[0].toolName).toBe('Task');
    expect(log[0].description).toBe('run tests');
    expect(log[0].status).toBe('ok');
  });

  it('should create pending call for mcp__ tool', () => {
    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'mcp__slack-mcp__send_thread_message',
    });

    trackPostCall({
      session_id: 'sess-1',
      tool_name: 'mcp__slack-mcp__send_thread_message',
      tool_response: 'sent',
    });

    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(1);
    expect(log[0].toolName).toBe('mcp__slack-mcp__send_thread_message');
  });

  it('should create log entry with duration after post matches pre', () => {
    const startTime = new Date('2026-04-10T10:00:00Z');
    vi.setSystemTime(startTime);

    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_input: { description: 'build project' },
    });

    // Advance time by 2 seconds
    vi.advanceTimersByTime(2000);

    trackPostCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_response: 'build complete',
    });

    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(1);
    expect(log[0].durationMs).toBeGreaterThanOrEqual(2000);
    expect(log[0].status).toBe('ok');
    expect(log[0].description).toBe('build project');
  });

  it('should not create log entry for post without pre (graceful)', () => {
    trackPostCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_response: 'orphaned result',
    });

    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(0);
  });

  it('should detect error in tool_response', () => {
    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_input: { description: 'failing task' },
    });

    trackPostCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_response: 'Error: command failed with exit code 1',
    });

    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('error');
  });

  it('should detect failure in tool_response', () => {
    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'Task',
    });

    trackPostCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_response: 'Task failed to complete',
    });

    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('error');
  });

  it('should detect timeout in tool_response', () => {
    trackPreCall({
      session_id: 'sess-1',
      tool_name: 'Task',
    });

    trackPostCall({
      session_id: 'sess-1',
      tool_name: 'Task',
      tool_response: 'Operation timeout after 30s',
    });

    const log = hookState.getCallLog('sess-1');
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('error');
  });

  it('should not track when session_id is missing', () => {
    trackPreCall({
      tool_name: 'Task',
    });

    const log = hookState.getCallLog();
    expect(log).toHaveLength(0);
  });

  it('should not track when tool_name is missing', () => {
    trackPreCall({
      session_id: 'sess-1',
    });

    const log = hookState.getCallLog();
    expect(log).toHaveLength(0);
  });
});
