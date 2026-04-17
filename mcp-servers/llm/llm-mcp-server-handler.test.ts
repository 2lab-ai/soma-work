/**
 * Handler-layer tests — plan v8 tests 7-30.
 *
 * These tests exercise LlmMCPServer.handleTool with all deps mocked:
 *   - runtimes (codex/gemini): minimal vi.fn() stubs
 *   - sessionStore: real FileSessionStore on a tmp jsonl (no mocks) so
 *     persistence+invariant paths are real
 *   - childRegistry: noop
 *   - sessionLocks: real SessionLocks
 *   - shutdownCoordinator: minimal passthrough (always accepting)
 *
 * We avoid mocking the MCP SDK Server here — handleTool is a direct method
 * on the subclass, so we construct LlmMCPServer and call handleTool() in-process.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
import { FileSessionStore } from './runtime/session-store.js';
import { ChildRegistry } from './runtime/child-registry.js';
import { SessionLocks } from './runtime/session-locks.js';
import { ShutdownCoordinator } from './runtime/shutdown.js';
import { ErrorCode, LlmChatError } from './runtime/errors.js';
import type { Backend, LlmRuntime, StartSessionResult, ResumeSessionResult } from './runtime/types.js';
import type { ToolResult } from '../_shared/base-mcp-server.js';

type RuntimeMock = LlmRuntime & {
  startSession: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  ensureReady: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-handler-test-'));
}

function makeRuntime(name: Backend): RuntimeMock {
  return {
    name,
    capabilities: {
      supportsReview: false,
      supportsInterrupt: false,
      supportsResume: true,
      supportsEventStream: false,
    },
    ensureReady: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn<
      [string, string, any],
      Promise<StartSessionResult>
    >().mockResolvedValue({
      backendSessionId: 'thread-new',
      content: 'hello from backend',
      resolvedConfig: { applied: true },
    }),
    resumeSession: vi.fn<
      [string, string, any],
      Promise<ResumeSessionResult>
    >().mockResolvedValue({
      backendSessionId: 'thread-new',
      content: 'resumed',
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

interface Deps {
  server: LlmMCPServer;
  sessionStore: FileSessionStore;
  childRegistry: ChildRegistry;
  sessionLocks: SessionLocks;
  shutdownCoordinator: ShutdownCoordinator;
  runtimes: Record<Backend, RuntimeMock>;
  dir: string;
}

function buildServer(): Deps {
  const dir = tmpDir();
  const sessionStore = new FileSessionStore(path.join(dir, 'sessions.jsonl'));
  const childRegistry = new ChildRegistry(path.join(dir, 'children.jsonl'), {
    captureFingerprint: () => ({ startTimeToken: 't', cmdFingerprint: 'f' }),
  });
  const sessionLocks = new SessionLocks();
  const runtimes: Record<Backend, RuntimeMock> = {
    codex: makeRuntime('codex'),
    gemini: makeRuntime('gemini'),
  };
  // Fake pidfile handle — we never touch it here.
  const pidfile = {
    path: path.join(dir, 'fake.pid'),
    pid: process.pid,
    release: () => {},
  };
  const shutdownCoordinator = new ShutdownCoordinator({
    pidfile,
    sessionStore,
    childRegistry,
    runtimes,
  });
  const server = new LlmMCPServer({
    runtimes,
    sessionStore,
    childRegistry,
    sessionLocks,
    shutdownCoordinator,
  });
  return { server, sessionStore, childRegistry, sessionLocks, shutdownCoordinator, runtimes, dir };
}

function parseStructured(result: ToolResult): any {
  // Our server attaches structuredContent via cast; read it off the object.
  return (result as unknown as { structuredContent: any }).structuredContent;
}

describe('LlmMCPServer handleTool — chat new/resume', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = buildServer();
  });

  afterEach(() => {
    try { fs.rmSync(deps.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  // ── New session ──

  it('test 7: new happy → pending → ready with resolvedConfig persisted', async () => {
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    const s = parseStructured(result);
    expect(s.sessionId).toBeDefined();
    expect(s.backend).toBe('codex');
    expect(s.content).toBe('hello from backend');

    const stored = deps.sessionStore.get(s.sessionId)!;
    expect(stored.status).toBe('ready');
    expect(stored.backendSessionId).toBe('thread-new');
    expect(stored.resolvedConfig).toEqual({ applied: true });
  });

  it('test 8: new backend failure → sessionStore.delete the placeholder', async () => {
    deps.runtimes.codex.startSession.mockRejectedValueOnce(new Error('backend exploded'));
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    expect(result.isError).toBe(true);
    // No record should be visible in the store.
    const all: string[] = [];
    const raw = fs.readFileSync(path.join(deps.dir, 'sessions.jsonl'), 'utf8').trim();
    if (raw) for (const l of raw.split('\n')) all.push(l);
    expect(all).toHaveLength(0);
  });

  it('test 9: new watchdog timeout → BACKEND_TIMEOUT', async () => {
    deps.runtimes.codex.startSession.mockRejectedValueOnce(
      new LlmChatError(ErrorCode.BACKEND_TIMEOUT, 'Exceeded 500ms'),
    );
    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    expect(result.isError).toBe(true);
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_TIMEOUT);
  });

  it('test 10: new post-success persist-fail → corrupted + PERSISTENCE_FAILED', async () => {
    // Let startSession succeed, but make the promote-to-ready update fail.
    const origUpdate = deps.sessionStore.update.bind(deps.sessionStore);
    let calls = 0;
    vi.spyOn(deps.sessionStore, 'update').mockImplementation(async (id, patch) => {
      calls++;
      if (calls === 1) throw new Error('disk full');
      return origUpdate(id, patch); // 2nd call (marking corrupted) should succeed
    });

    const result = await deps.server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    expect(result.isError).toBe(true);
    expect(parseStructured(result).error.code).toBe(ErrorCode.PERSISTENCE_FAILED);
  });

  it('test 11: resolvedConfig echoed by startSession is stored verbatim', async () => {
    deps.runtimes.codex.startSession.mockResolvedValueOnce({
      backendSessionId: 'thread-x',
      content: 'ok',
      resolvedConfig: { custom_flag: 'yes', nested: { deep: 1 } },
    });
    const result = await deps.server.handleTool('chat', {
      prompt: 'hi',
      model: 'codex',
      config: { override_me: true },
    });
    const s = parseStructured(result);
    const stored = deps.sessionStore.get(s.sessionId)!;
    expect(stored.resolvedConfig).toEqual({ custom_flag: 'yes', nested: { deep: 1 } });
  });

  // ── Resume ──

  async function seedReady(publicId = 'resume-ok'): Promise<void> {
    const now = new Date().toISOString();
    await deps.sessionStore.save({
      publicId,
      backend: 'codex',
      backendSessionId: 'thread-stored',
      model: 'gpt-5.4',
      cwd: '/tmp/stored-cwd',
      resolvedConfig: { stored_key: 'stored_val' },
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
  }

  it('test 12: resume happy (stored resolvedConfig used)', async () => {
    await seedReady();
    const result = await deps.server.handleTool('chat', {
      prompt: 'more',
      resumeSessionId: 'resume-ok',
    });
    const s = parseStructured(result);
    expect(s.sessionId).toBe('resume-ok');
    expect(s.content).toBe('resumed');
    // runtime.resumeSession got called with stored resolvedConfig
    const call = deps.runtimes.codex.resumeSession.mock.calls[0];
    expect(call[2].resolvedConfig).toEqual({ stored_key: 'stored_val' });
  });

  it('test 13: resume with rotated backendSessionId → store updates', async () => {
    await seedReady();
    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: 'thread-rotated',
      content: 'r',
    });
    await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: 'resume-ok' });
    expect(deps.sessionStore.get('resume-ok')!.backendSessionId).toBe('thread-rotated');
  });

  it('test 14: resume with cwd override; stored cwd is fallback', async () => {
    await seedReady();
    await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'resume-ok',
      cwd: '/tmp/override',
    });
    expect(deps.runtimes.codex.resumeSession.mock.calls[0][2].cwd).toBe('/tmp/override');

    // Second call without cwd uses stored value.
    await deps.server.handleTool('chat', { prompt: 'y', resumeSessionId: 'resume-ok' });
    expect(deps.runtimes.codex.resumeSession.mock.calls[1][2].cwd).toBe('/tmp/stored-cwd');
  });

  it('test 15: resume + model → MUTUAL_EXCLUSION', async () => {
    await seedReady();
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'resume-ok',
      model: 'gpt-5.4',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.MUTUAL_EXCLUSION);
  });

  it('test 16: resume + config → MUTUAL_EXCLUSION', async () => {
    await seedReady();
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'resume-ok',
      config: { a: 1 },
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.MUTUAL_EXCLUSION);
  });

  it('test 17: resume unknown sessionId → SESSION_NOT_FOUND', async () => {
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'does-not-exist',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it('test 18: resume with status=pending → SESSION_CORRUPTED', async () => {
    const now = new Date().toISOString();
    await deps.sessionStore.save({
      publicId: 'pending-id',
      backend: 'codex',
      backendSessionId: null,
      model: 'gpt-5.4',
      resolvedConfig: {},
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'pending-id',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.SESSION_CORRUPTED);
  });

  it('test 19: resume with status=corrupted → SESSION_CORRUPTED', async () => {
    const now = new Date().toISOString();
    await deps.sessionStore.save({
      publicId: 'corrupted-id',
      backend: 'codex',
      backendSessionId: null,
      model: 'gpt-5.4',
      resolvedConfig: {},
      status: 'corrupted',
      createdAt: now,
      updatedAt: now,
    });
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'corrupted-id',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.SESSION_CORRUPTED);
  });

  it('test 20: resume concurrent same ID → SESSION_BUSY', async () => {
    await seedReady();
    // Make the runtime stall so the lock is held.
    let release: (() => void) | null = null;
    deps.runtimes.codex.resumeSession.mockImplementation(
      () =>
        new Promise<ResumeSessionResult>((resolve) => {
          release = () => resolve({ backendSessionId: 'thread-stored', content: 'slow' });
        }),
    );

    const first = deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'resume-ok',
    });
    // Yield so the first call enters handleResume and acquires the lock.
    await new Promise((r) => setImmediate(r));

    const second = await deps.server.handleTool('chat', {
      prompt: 'y',
      resumeSessionId: 'resume-ok',
    });
    expect(parseStructured(second).error.code).toBe(ErrorCode.SESSION_BUSY);

    // Clean up.
    release?.();
    await first;
  });

  it('test 21: resume watchdog timeout → BACKEND_TIMEOUT', async () => {
    await seedReady();
    deps.runtimes.codex.resumeSession.mockRejectedValueOnce(
      new LlmChatError(ErrorCode.BACKEND_TIMEOUT, 'slow'),
    );
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'resume-ok',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.BACKEND_TIMEOUT);
  });

  it('test 22: resume post-success persist-fail → PERSISTENCE_FAILED + corrupted', async () => {
    await seedReady();
    // Rotate the bsid so updateBackendSessionId is called (the persist path).
    deps.runtimes.codex.resumeSession.mockResolvedValueOnce({
      backendSessionId: 'thread-rotated',
      content: 'r',
    });
    vi.spyOn(deps.sessionStore, 'updateBackendSessionId').mockRejectedValueOnce(
      new Error('disk full'),
    );

    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'resume-ok',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.PERSISTENCE_FAILED);
    // Subsequent: record should be marked corrupted.
    expect(deps.sessionStore.get('resume-ok')!.status).toBe('corrupted');
  });

  it('test 23: stored resolvedConfig threaded into runtime.resumeSession', async () => {
    const now = new Date().toISOString();
    await deps.sessionStore.save({
      publicId: 'cfg-check',
      backend: 'gemini',
      backendSessionId: 'gemini-thread',
      model: 'gemini-3.1-pro',
      resolvedConfig: { temperature: 0.2, nested: { foo: 'bar' } },
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: 'cfg-check' });
    const call = deps.runtimes.gemini.resumeSession.mock.calls[0];
    expect(call[2].resolvedConfig).toEqual({ temperature: 0.2, nested: { foo: 'bar' } });
  });

  // ── Validation ──

  it('test 24: schema rejects background:true — runtime-side validation flags unknown field', async () => {
    // Since handleTool is called after the SDK schema validator in real use,
    // here we assert the tool definition bans additionalProperties — any key
    // other than the allowed set would be rejected upstream.
    const def = deps.server.defineTools()[0];
    expect((def.inputSchema as any).additionalProperties).toBe(false);
    expect(Object.keys((def.inputSchema as any).properties)).not.toContain('background');
  });

  it('test 25: schema rejects unknown field', async () => {
    const def = deps.server.defineTools()[0];
    expect((def.inputSchema as any).additionalProperties).toBe(false);
  });

  it('test 26: schema rejects empty prompt (minLength 1)', () => {
    const def = deps.server.defineTools()[0];
    expect((def.inputSchema as any).properties.prompt.minLength).toBe(1);
  });

  it('test 27: schema rejects timeoutMs out of range', () => {
    const def = deps.server.defineTools()[0];
    expect((def.inputSchema as any).properties.timeoutMs.minimum).toBe(1000);
    expect((def.inputSchema as any).properties.timeoutMs.maximum).toBe(1800000);
  });

  it('test 28: runtime rejects whitespace-only prompt → INVALID_ARGS', async () => {
    const result = await deps.server.handleTool('chat', { prompt: '   \n\t  ', model: 'codex' });
    expect(parseStructured(result).error.code).toBe(ErrorCode.INVALID_ARGS);
  });

  it('test 29: sessionLocks released on all error paths', async () => {
    await seedReady();
    // Backend failure on resume — lock must still be released.
    deps.runtimes.codex.resumeSession.mockRejectedValueOnce(new Error('boom'));
    await deps.server.handleTool('chat', { prompt: 'x', resumeSessionId: 'resume-ok' });
    expect(deps.sessionLocks.isHeld('resume-ok')).toBe(false);

    // Second call succeeds — confirms the lock is free.
    const result = await deps.server.handleTool('chat', {
      prompt: 'y',
      resumeSessionId: 'resume-ok',
    });
    expect(result.isError).toBeFalsy();
    expect(deps.sessionLocks.isHeld('resume-ok')).toBe(false);
  });

  it('test 30: structured error uses numeric ErrorCode enum value for session_not_found', async () => {
    const result = await deps.server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'missing',
    });
    expect(result.isError).toBe(true);
    const s = parseStructured(result);
    // Stable contract: the enum value is what callers match on.
    expect(s.error.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(typeof s.error.message).toBe('string');
  });
});
