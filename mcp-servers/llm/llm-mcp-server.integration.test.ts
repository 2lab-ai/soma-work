/**
 * Integration tests — wired LlmMCPServer, in-process, no real CLI spawn.
 *
 * The simplified surface has no filesystem persistence and no shutdown
 * coordinator, so these tests focus on:
 *   - tools/list contract (single "chat" tool, additionalProperties=false)
 *   - new → resume flow round-trip
 *   - watchdog wired through real child process kill signal
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
import { runWithWatchdog } from './runtime/watchdog.js';
import { ErrorCode } from './runtime/errors.js';
import type { Backend, LlmRuntime } from './runtime/types.js';
import type { ToolResult } from '../_shared/base-mcp-server.js';

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
    ensureReady: async () => {},
    startSession: async () => ({
      backendSessionId: 'bsid-integ',
      content: 'first',
    }),
    resumeSession: async () => ({
      backendSessionId: 'bsid-integ',
      content: 'continued',
    }),
    shutdown: async () => {},
  };
}

function buildServer(overrides: Partial<Record<Backend, LlmRuntime>> = {}) {
  const runtimes: Record<Backend, LlmRuntime> = {
    codex: overrides.codex ?? makeRuntime('codex'),
    gemini: overrides.gemini ?? makeRuntime('gemini'),
  };
  const server = new LlmMCPServer({ runtimes });
  return { server };
}

describe('Integration — end-to-end in-process', () => {
  beforeEach(() => { /* no-op */ });
  afterEach(() => { vi.restoreAllMocks(); });

  it('tools/list length=1 named "chat"; new → resume flow', async () => {
    const { server } = buildServer();

    const tools = server.defineTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('chat');
    expect((tools[0].inputSchema as any).additionalProperties).toBe(false);

    const newResult = await server.handleTool('chat', { prompt: 'hi', model: 'codex' });
    const s1 = parseStructured(newResult);
    expect(s1.sessionId).toBeDefined();
    expect(s1.content).toBe('first');

    const resumeResult = await server.handleTool('chat', {
      prompt: 'more',
      resumeSessionId: s1.sessionId,
    });
    const s2 = parseStructured(resumeResult);
    expect(s2.sessionId).toBe(s1.sessionId);
    expect(s2.content).toBe('continued');
  });

  it('real watchdog cancels a live child within 1s of timeoutMs:500', async () => {
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

      await new Promise<void>((r) => {
        const t = setTimeout(r, 300);
        t.unref?.();
      });
      expect(pidAlive(pid)).toBe(false);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 10_000);
});
