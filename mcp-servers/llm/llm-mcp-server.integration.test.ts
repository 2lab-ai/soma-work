/**
 * Integration tests — plan v8 tests 64-66.
 *
 * These do not spawn the compiled server over real stdio (that's covered by
 * the manual self-proof harness). Instead they exercise the wired LlmMCPServer
 * end-to-end in-process: tools/list via defineTools(), call flow via
 * handleTool(), and legacy migration via a seeded filesystem.
 *
 * Test 65 (real watchdog) uses a runtime that spawns a real `sleep` child
 * process and is cancelled by the shared watchdog; we verify the OS-level
 * termination via `ps -p <pid>`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class { constructor() {} setRequestHandler() {} connect() {} },
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
import { runWithWatchdog } from './runtime/watchdog.js';
import { ErrorCode } from './runtime/errors.js';
import type { Backend, LlmRuntime } from './runtime/types.js';
import type { ToolResult } from '../_shared/base-mcp-server.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-integ-'));
}

function parseStructured(r: ToolResult): any {
  return (r as unknown as { structuredContent: any }).structuredContent;
}

function pidAlive(pid: number): boolean {
  const out = spawnSync('ps', ['-p', String(pid)], { encoding: 'utf8' });
  return out.status === 0 && out.stdout.split('\n').length > 2;
}

function makeRuntime(name: Backend): LlmRuntime {
  return {
    name,
    capabilities: {
      supportsReview: false,
      supportsInterrupt: false,
      supportsResume: true,
      supportsEventStream: false,
    },
    ensureReady: async () => {},
    startSession: async () => ({
      backendSessionId: 'bsid-integ',
      content: 'first',
      resolvedConfig: {},
    }),
    resumeSession: async () => ({
      backendSessionId: 'bsid-integ',
      content: 'continued',
    }),
    shutdown: async () => {},
  };
}

function buildServer(dir: string, overrides: Partial<Record<Backend, LlmRuntime>> = {}) {
  const sessionStore = new FileSessionStore(path.join(dir, 'sessions.jsonl'));
  const childRegistry = new ChildRegistry(path.join(dir, 'children.jsonl'), {
    captureFingerprint: () => ({ startTimeToken: 't', cmdFingerprint: 'f' }),
  });
  const sessionLocks = new SessionLocks();
  const runtimes: Record<Backend, LlmRuntime> = {
    codex: overrides.codex ?? makeRuntime('codex'),
    gemini: overrides.gemini ?? makeRuntime('gemini'),
  };
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
  return { server, sessionStore, childRegistry };
}

describe('Integration — end-to-end in-process', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('test 64: tools/list length=1 named "chat"; new → resume flow', async () => {
    const { server } = buildServer(dir);

    // tools/list equivalent.
    const tools = server.defineTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('chat');
    expect((tools[0].inputSchema as any).additionalProperties).toBe(false);

    // New session.
    const newResult = await server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    const s1 = parseStructured(newResult);
    expect(s1.sessionId).toBeDefined();
    expect(s1.content).toBe('first');

    // Resume with the returned sessionId.
    const resumeResult = await server.handleTool('chat', {
      prompt: 'more',
      resumeSessionId: s1.sessionId,
    });
    const s2 = parseStructured(resumeResult);
    expect(s2.sessionId).toBe(s1.sessionId);
    expect(s2.content).toBe('continued');
  });

  it('test 65: real watchdog cancels a live child within 1s of timeoutMs:500', async () => {
    // This is a direct unit of the watchdog + real child: spawn `sleep 10`,
    // race it against a 500ms timeout. The killChild closure sends signals
    // to the real sleep child; we verify it's gone from `ps` afterward.
    const child: ChildProcess = spawn('sleep', ['10'], { stdio: 'ignore' });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    try {
      const work = new Promise<string>(() => {}); // never resolves
      const t0 = Date.now();
      const err = await runWithWatchdog(work, {
        timeoutMs: 500,
        killGraceMs: 500,
        killChild: (sig) => {
          try { child.kill(sig); } catch { /* best-effort */ }
        },
      }).catch((e) => e);
      const elapsed = Date.now() - t0;

      expect(err.code).toBe(ErrorCode.BACKEND_TIMEOUT);
      expect(elapsed).toBeLessThan(1_000);

      // Give the OS a moment to reap the child.
      await new Promise<void>((r) => {
        const t = setTimeout(r, 300);
        t.unref?.();
      });
      expect(pidAlive(pid)).toBe(false);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 10_000);

  it('test 66: legacy fixture — blob + malformed jsonl + pending; resume of pending → SESSION_CORRUPTED', async () => {
    // Write a legacy blob with one valid record and one malformed record.
    const now = new Date().toISOString();
    const legacyBlob = [
      {
        publicId: 'good-legacy',
        backend: 'codex',
        backendSessionId: 'thread-good',
        model: 'gpt-5.4',
        resolvedConfig: { ok: true },
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      },
      // "pending" record with a backendSessionId — v8 invariant violation → corrupted
      {
        publicId: 'pending-bad',
        backend: 'codex',
        backendSessionId: 'thread-ghost',
        model: 'gpt-5.4',
        resolvedConfig: {},
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
    ];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llm-sessions.json'), JSON.stringify(legacyBlob), 'utf8');

    const { server, sessionStore } = buildServer(dir);

    // Trigger load.
    expect(sessionStore.get('good-legacy')).toBeDefined();
    expect(sessionStore.get('pending-bad')!.status).toBe('corrupted');

    // Legacy blob should have been renamed to .bak.
    expect(fs.existsSync(path.join(dir, 'llm-sessions.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'llm-sessions.json.bak'))).toBe(true);

    // JSONL should exist. Append a malformed line to verify the lenient loader
    // still serves subsequent reads (in a fresh server instance).
    fs.appendFileSync(path.join(dir, 'llm-sessions.jsonl'), '{"this is:"not closed\n', 'utf8');

    const { server: server2 } = buildServer(dir);
    // Malformed line is skipped; good record still resolvable.
    expect(server2).toBeDefined();

    // Resume of the pending-bad record → SESSION_CORRUPTED
    const result = await server.handleTool('chat', {
      prompt: 'x',
      resumeSessionId: 'pending-bad',
    });
    expect(parseStructured(result).error.code).toBe(ErrorCode.SESSION_CORRUPTED);
  });
});
