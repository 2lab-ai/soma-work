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
  // `exitOnShutdown: false` so shutdown-related tests can await the hook
  // without the test runner being killed by `process.exit(0)`.
  const server = new LlmMCPServer({ runtimes, exitOnShutdown: false });
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
    expect(s.model).toBe('gpt-5.5');
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

  it('new: runtime returns empty backendSessionId → BACKEND_FAILED + error log', async () => {
    // The only way ops can distinguish a backend regression from a caller bug
    // is the `llm.chat.empty-session-id` log line. Assert it is emitted with
    // enough routing context (backend, model) to act on.
    const logger = (deps.server as unknown as { logger: { error: (...a: any[]) => void } }).logger;
    const errSpy = vi.spyOn(logger, 'error');

    deps.runtimes.codex.startSession.mockResolvedValueOnce({
      backendSessionId: '',
      content: 'ok',
    });
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    expect(result.isError).toBe(true);
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_FAILED);
    expect(errSpy).toHaveBeenCalledWith(
      'llm.chat.empty-session-id',
      // Pin both fields: a routing regression that drops `model` would go
      // unnoticed if we only asserted `backend`.
      expect.objectContaining({ backend: 'codex', model: 'gpt-5.5' }),
    );
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

  it('resume: whitespace-only rotated id is ignored and warns', async () => {
    const id = await seedSession();
    // The warn on blank rotation is the only ops signal that a specific backend
    // regressed — without this assertion the warn could silently disappear.
    const logger = (deps.server as unknown as { logger: { warn: (...a: any[]) => void } }).logger;
    const warnSpy = vi.spyOn(logger, 'warn');

    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: '   ',
      content: 'r',
    });
    await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: id });

    expect(warnSpy).toHaveBeenCalledWith(
      'llm.chat.resume.blank-rotated-id',
      expect.objectContaining({ backend: 'codex', rawType: 'string' }),
    );

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

  it('resume watchdog timeout → BACKEND_TIMEOUT; inflight released for retry', async () => {
    const id = await seedSession();
    deps.runtimes.codex.resumeSession.mockRejectedValueOnce(
      new LlmChatError(ErrorCode.BACKEND_TIMEOUT, 'slow'),
    );
    const result = await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: id });
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_TIMEOUT);

    // The inflight Set must release on the error path — otherwise a single
    // transient timeout would permanently lock the session to SESSION_BUSY.
    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: 'thread-stored',
      content: 'ok',
    });
    const retry = await deps.server.handleTool('chat', {
      prompt: 'again',
      resumeSessionId: id,
    });
    expect(parseStructured(retry).error).toBeUndefined();
    expect(parseStructured(retry).content).toBe('ok');
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

  it('structured error uses stable enum string for session_not_found and logs typed-error', async () => {
    // `llm.chat.typed-error` must fire on every `LlmChatError` branch
    // (SESSION_NOT_FOUND here as representative). Without this assertion
    // the ops-facing log added for BACKEND_TIMEOUT / SESSION_BUSY / etc.
    // could regress back to silence.
    const logger = (deps.server as unknown as { logger: { error: (...a: any[]) => void } }).logger;
    const errSpy = vi.spyOn(logger, 'error');

    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'missing',
    });
    const s = parseStructured(result);
    expect(s.error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(typeof s.error.message).toBe('string');
    expect(errSpy).toHaveBeenCalledWith(
      'llm.chat.typed-error',
      expect.objectContaining({ code: ErrorCode.SESSION_NOT_FOUND }),
    );
  });

  // ── In-memory session map ──
  // The deleted FileSessionStore enforced `publicId` uniqueness via an
  // `assertInvariant`. The new `Map<string, Session>` leans on `randomUUID()`;
  // these tests are the guardrail against a future bug where `handleNew`
  // clobbers the map or `handleResume` resolves the wrong key.

  it('sessionId uniqueness: two new calls yield distinct sessionIds', async () => {
    deps.runtimes.codex.startSession
      .mockResolvedValueOnce({ backendSessionId: 'thread-a', content: 'a' })
      .mockResolvedValueOnce({ backendSessionId: 'thread-b', content: 'b' });
    const r1 = await deps.server.handleTool('chat', { prompt: 'a', model: 'codex' });
    const r2 = await deps.server.handleTool('chat', { prompt: 'b', model: 'codex' });
    const id1 = parseStructured(r1).sessionId as string;
    const id2 = parseStructured(r2).sessionId as string;
    expect(id1).toBeTypeOf('string');
    expect(id2).toBeTypeOf('string');
    expect(id1).not.toBe(id2);
  });

  it('multi-session accumulation: 3 distinct sessions resumable independently', async () => {
    deps.runtimes.codex.startSession
      .mockResolvedValueOnce({ backendSessionId: 'thread-1', content: 'c1' })
      .mockResolvedValueOnce({ backendSessionId: 'thread-2', content: 'c2' })
      .mockResolvedValueOnce({ backendSessionId: 'thread-3', content: 'c3' });

    const ids = [] as string[];
    for (const p of ['one', 'two', 'three']) {
      const r = await deps.server.handleTool('chat', { prompt: p, model: 'codex' });
      ids.push(parseStructured(r).sessionId as string);
    }
    expect(new Set(ids).size).toBe(3);

    // Each resume must hit its own stored backendSessionId.
    for (let i = 0; i < ids.length; i++) {
      deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
        backendSessionId: `thread-${i + 1}`,
        content: `r${i + 1}`,
      });
      await deps.server.handleTool('chat', { prompt: 'cont', resumeSessionId: ids[i] });
      expect(deps.runtimes.codex.resumeSession.mock.calls[i][0]).toBe(`thread-${i + 1}`);
    }
  });

  // ── Unknown model alias ──

  it('unknown model alias: falls back to codex + logs warn without INVALID_ARGS', async () => {
    // Spy on logger before issuing the call. `warn` is the access point in
    // base-mcp-server's StderrLogger; we confirm the alias is surfaced.
    const logger = (deps.server as unknown as { logger: { warn: (...a: any[]) => void } }).logger;
    const warnSpy = vi.spyOn(logger, 'warn');

    const result = await deps.server.handleTool('chat', { prompt: 'x', model: 'frobnicate' });
    // No error; request routed to codex with the alias as the `model`.
    expect(parseStructured(result).error).toBeUndefined();
    expect(deps.runtimes.codex.startSession).toHaveBeenCalledWith(
      'frobnicate',
      'x',
      expect.any(Object),
    );
    // Pin the payload — a regression that emits the event with an empty
    // alias or the wrong fallback backend still passes a name-only check.
    expect(warnSpy).toHaveBeenCalledWith(
      'llm.route.unknown-alias',
      expect.objectContaining({ alias: 'frobnicate', fallbackBackend: 'codex' }),
    );
  });

  // ── Shutdown ──

  it('shutdown drains every runtime and swallows-with-log per-runtime errors', async () => {
    // Capture the warn log before triggering shutdown — the swallow-with-log
    // contract is the only signal that a runtime hung during teardown.
    const logger = (deps.server as unknown as { logger: { warn: (...a: any[]) => void } }).logger;
    const warnSpy = vi.spyOn(logger, 'warn');

    deps.runtimes.gemini.shutdown.mockRejectedValueOnce(new Error('gemini stuck'));
    // Accessing the protected hook is intentional — the change under review
    // exposed this seam specifically so tests can assert teardown without
    // `process.exit` terminating the runner.
    await (deps.server as unknown as { shutdown: () => Promise<void> }).shutdown();
    expect(deps.runtimes.codex.shutdown).toHaveBeenCalled();
    expect(deps.runtimes.gemini.shutdown).toHaveBeenCalled();
    // Pin the runtime identity in the payload — a closure bug that logs the
    // wrong runtime's name (or drops it entirely) still passes a name-only
    // `toContain` check and ops would lose the ability to identify which
    // runtime hung during teardown.
    expect(warnSpy).toHaveBeenCalledWith(
      'llm.runtime.shutdown-failed',
      expect.objectContaining({ runtime: 'gemini' }),
    );
  });
});
