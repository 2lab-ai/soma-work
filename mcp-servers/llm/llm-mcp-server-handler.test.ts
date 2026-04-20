/**
 * Handler-layer tests for the simplified llm-mcp-server.
 *
 * Surface under test:
 *   chat({ prompt, model?, resumeSessionId?, cwd?, timeoutMs? })
 *     → { sessionId, backend, model, content }
 *     | { error: { code, message } }
 *
 * Sessions are in-memory; runtimes are mocked.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    constructor() {}
    setRequestHandler() {}
    connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

import { LlmMCPServer } from './llm-mcp-server.js';
import { ErrorCode, LlmChatError } from './runtime/errors.js';
import type { Backend, LlmRuntime, ResumeSessionResult, StartSessionResult } from './runtime/types.js';
import type { ToolResult } from '../_shared/base-mcp-server.js';

type RuntimeMock = LlmRuntime & {
  startSession: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  ensureReady: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
};

function makeRuntime(name: Backend): RuntimeMock {
  return {
    name,
    ensureReady: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn<[string, string, any], Promise<StartSessionResult>>().mockResolvedValue({
      backendSessionId: 'thread-new',
      content: 'hello from backend',
    }),
    resumeSession: vi.fn<[string, string, any], Promise<ResumeSessionResult>>().mockResolvedValue({
      backendSessionId: 'thread-new',
      content: 'resumed',
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as RuntimeMock;
}

interface Deps {
  server: LlmMCPServer;
  runtimes: Record<Backend, RuntimeMock>;
}

function buildServer(): Deps {
  const runtimes: Record<Backend, RuntimeMock> = {
    codex: makeRuntime('codex'),
    gemini: makeRuntime('gemini'),
  };
  const server = new LlmMCPServer({ runtimes });
  return { server, runtimes };
}

function parseStructured(result: ToolResult): any {
  return (result as unknown as { structuredContent: any }).structuredContent;
}

describe('LlmMCPServer.handleTool — chat new/resume', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = buildServer();
  });

  // ── New session ──

  it('new happy: routes codex, returns sessionId + content', async () => {
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    const s = parseStructured(result);
    expect(s.sessionId).toBeTypeOf('string');
    expect(s.backend).toBe('codex');
    expect(s.model).toBe('gpt-5.4');
    expect(s.content).toBe('hello from backend');
  });

  it('new happy: default model (omitted) → codex', async () => {
    const result = await deps.server.handleTool('chat', { prompt: 'hi' });
    const s = parseStructured(result);
    expect(s.backend).toBe('codex');
  });

  it('new: backend failure → BACKEND_FAILED', async () => {
    deps.runtimes.codex.startSession.mockRejectedValueOnce(new Error('backend exploded'));
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    expect(result.isError).toBe(true);
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_FAILED);
  });

  it('new: watchdog timeout propagated → BACKEND_TIMEOUT', async () => {
    deps.runtimes.codex.startSession.mockRejectedValueOnce(
      new LlmChatError(ErrorCode.BACKEND_TIMEOUT, 'Exceeded 500ms'),
    );
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    expect(result.isError).toBe(true);
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_TIMEOUT);
  });

  it('new: runtime returns empty backendSessionId → BACKEND_FAILED', async () => {
    deps.runtimes.codex.startSession.mockResolvedValueOnce({
      backendSessionId: '',
      content: 'ok',
    });
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    expect(result.isError).toBe(true);
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_FAILED);
  });

  // ── Resume ──

  async function seedSession(): Promise<string> {
    deps.runtimes.codex.startSession.mockResolvedValueOnce({
      backendSessionId: 'thread-stored',
      content: 'start',
    });
    const res = await deps.server.handleTool('chat', {
      prompt: 'hi',
      model: 'codex',
      cwd: '/tmp/stored-cwd',
    });
    return parseStructured(res).sessionId as string;
  }

  it('resume happy: uses stored backendSessionId', async () => {
    const id = await seedSession();
    const result = await deps.server.handleTool('chat', {
      prompt: 'more',
      resumeSessionId: id,
    });
    const s = parseStructured(result);
    expect(s.sessionId).toBe(id);
    expect(s.content).toBe('resumed');
    const call = deps.runtimes.codex.resumeSession.mock.calls[0];
    expect(call[0]).toBe('thread-stored');
  });

  it('resume: rotated backendSessionId → stored in-memory', async () => {
    const id = await seedSession();
    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: 'thread-rotated',
      content: 'r',
    });
    await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: id });

    // Next resume call must reuse the rotated id.
    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: 'thread-rotated',
      content: 'r2',
    });
    await deps.server.handleTool('chat', { prompt: 'y', resumeSessionId: id });
    expect(deps.runtimes.codex.resumeSession.mock.calls[1][0]).toBe('thread-rotated');
  });

  it('resume: whitespace-only rotated id is ignored (keeps old id)', async () => {
    const id = await seedSession();
    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: '   ',
      content: 'r',
    });
    await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: id });

    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: 'thread-stored',
      content: 'r2',
    });
    await deps.server.handleTool('chat', { prompt: 'y', resumeSessionId: id });
    expect(deps.runtimes.codex.resumeSession.mock.calls[1][0]).toBe('thread-stored');
  });

  it('resume: cwd override wins; falls back to stored cwd when omitted', async () => {
    const id = await seedSession();
    await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: id,
      cwd: '/tmp/override',
    });
    expect(deps.runtimes.codex.resumeSession.mock.calls[0][2].cwd).toBe('/tmp/override');

    await deps.server.handleTool('chat', { prompt: 'y', resumeSessionId: id });
    expect(deps.runtimes.codex.resumeSession.mock.calls[1][2].cwd).toBe('/tmp/stored-cwd');
  });

  it('resume + model → MUTUAL_EXCLUSION', async () => {
    const id = await seedSession();
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: id,
      model: 'gpt-5.4',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.MUTUAL_EXCLUSION);
  });

  it('resume unknown sessionId → SESSION_NOT_FOUND', async () => {
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'does-not-exist',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it('resume concurrent same id → SESSION_BUSY', async () => {
    const id = await seedSession();
    let release: (() => void) | null = null;
    deps.runtimes.codex.resumeSession.mockImplementationOnce(
      () =>
        new Promise<ResumeSessionResult>((resolve) => {
          release = () => resolve({ backendSessionId: 'thread-stored', content: 'slow' });
        }),
    );

    const first = deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: id });
    await new Promise((r) => setImmediate(r)); // let first enter handleResume

    const second = await deps.server.handleTool('chat', { prompt: 'y', resumeSessionId: id });
    expect(parseStructured(second).error.code).toBe(ErrorCode.SESSION_BUSY);

    release?.();
    await first;
  });

  it('resume watchdog timeout → BACKEND_TIMEOUT', async () => {
    const id = await seedSession();
    deps.runtimes.codex.resumeSession.mockRejectedValueOnce(
      new LlmChatError(ErrorCode.BACKEND_TIMEOUT, 'slow'),
    );
    const result = await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: id });
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_TIMEOUT);
  });

  // ── Validation ──

  it('schema: additionalProperties=false and prompt minLength=1', () => {
    const def = deps.server.defineTools()[0];
    expect((def.inputSchema as any).additionalProperties).toBe(false);
    expect((def.inputSchema as any).properties.prompt.minLength).toBe(1);
  });

  it('schema: timeoutMs bounded 1000..1800000', () => {
    const def = deps.server.defineTools()[0];
    expect((def.inputSchema as any).properties.timeoutMs.minimum).toBe(1000);
    expect((def.inputSchema as any).properties.timeoutMs.maximum).toBe(1800000);
  });

  it('schema: no config field', () => {
    const def = deps.server.defineTools()[0];
    expect(Object.keys((def.inputSchema as any).properties)).not.toContain('config');
  });

  it('runtime rejects whitespace-only prompt → INVALID_ARGS', async () => {
    const result = await deps.server.handleTool('chat', { prompt: '   \n\t  ', model: 'codex' });
    expect(parseStructured(result).error.code).toBe(ErrorCode.INVALID_ARGS);
  });

  it('unknown tool → INVALID_ARGS', async () => {
    const result = await deps.server.handleTool('not-a-tool', {});
    expect(parseStructured(result).error.code).toBe(ErrorCode.INVALID_ARGS);
  });

  it('structured error uses stable enum string for session_not_found', async () => {
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'missing',
    });
    const s = parseStructured(result);
    expect(s.error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(typeof s.error.message).toBe('string');
  });
});
