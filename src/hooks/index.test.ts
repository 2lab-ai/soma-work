import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env-paths and logger before importing modules
vi.mock('../env-paths', () => ({
  DATA_DIR: '/tmp/test-hooks-index',
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

describe('Hook routes (integration)', () => {
  let server: FastifyInstance;
  let hookState: typeof import('./hook-state').hookState;

  beforeEach(async () => {
    vi.resetModules();

    server = Fastify({ logger: false });

    const { registerHookRoutes } = await import('./index');
    const stateModule = await import('./hook-state');
    hookState = stateModule.hookState;

    await registerHookRoutes(server);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('POST /api/hooks/v1/pre_tool_use with normal tool returns 200', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/pre_tool_use',
      payload: {
        session_id: 'sess-1',
        tool_name: 'Read',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action).toBe('pass');
  });

  it('POST /api/hooks/v1/pre_tool_use over threshold returns 403 with message', async () => {
    // First, fill up to threshold
    for (let i = 0; i < 5; i++) {
      await server.inject({
        method: 'POST',
        url: '/api/hooks/v1/pre_tool_use',
        payload: {
          session_id: 'sess-block',
          tool_name: 'Bash',
        },
      });
    }

    // This should be blocked (6th call, count is already at 5+)
    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/pre_tool_use',
      payload: {
        session_id: 'sess-block',
        tool_name: 'Bash',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('TodoWrite');
  });

  it('POST /api/hooks/v1/post_tool_use returns 200', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/post_tool_use',
      payload: {
        session_id: 'sess-1',
        tool_name: 'Task',
        tool_response: 'done',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
  });

  it('POST /api/hooks/v1/cleanup returns 200 and cleans session', async () => {
    // Set up some state first
    hookState.incrementTodoGuard('sess-cleanup');
    expect(hookState.getTodoGuardState('sess-cleanup')).toBeDefined();

    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/cleanup',
      payload: {
        session_id: 'sess-cleanup',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');

    // State should be cleaned
    expect(hookState.getTodoGuardState('sess-cleanup')).toBeUndefined();
  });

  it('should fail-open on internal error (returns 200)', async () => {
    // Send request with no body — the handler wraps try/catch
    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/pre_tool_use',
      payload: {},
    });

    // Should still return 200 (fail-open behavior)
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/hooks/v1/pre_tool_use with exempt tool (ToolSearch) returns pass', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/pre_tool_use',
      payload: {
        session_id: 'sess-1',
        tool_name: 'ToolSearch',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action).toBe('pass');
  });

  it('POST /api/hooks/v1/pre_tool_use tracks Task tool pre-call', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/pre_tool_use',
      payload: {
        session_id: 'sess-track',
        tool_name: 'Task',
        tool_input: { description: 'agent subtask' },
      },
    });

    // Complete the call
    await server.inject({
      method: 'POST',
      url: '/api/hooks/v1/post_tool_use',
      payload: {
        session_id: 'sess-track',
        tool_name: 'Task',
        tool_response: 'completed',
      },
    });

    const log = hookState.getCallLog('sess-track');
    expect(log).toHaveLength(1);
    expect(log[0].toolName).toBe('Task');
    expect(log[0].description).toBe('agent subtask');
    expect(log[0].status).toBe('ok');
  });
});
