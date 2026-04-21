/**
 * Unit Tests — CodexRuntime (slim surface; no resolvedConfig, no child-registry).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CodexRuntime } from './codex-runtime.js';
import { ErrorCode, LlmChatError } from './errors.js';

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    isReady: vi.fn().mockReturnValue(true),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getPid: vi.fn().mockReturnValue(12345),
    killProcess: vi.fn().mockReturnValue(true),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ content: 'mock response' }) }],
      structuredContent: { threadId: 'thread-abc-123' },
    }),
    ...overrides,
  };
}

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => '/usr/local/bin/codex'),
}));

vi.mock('../../_shared/mcp-client.js', () => {
  let mockInstance: any = null;
  return {
    McpClient: class MockMcpClient {
      static __setMockInstance(inst: any) { mockInstance = inst; }
      isReady() { return mockInstance?.isReady() ?? false; }
      start() { return mockInstance?.start() ?? Promise.resolve(); }
      stop() { return mockInstance?.stop() ?? Promise.resolve(); }
      getPid() { return mockInstance?.getPid?.(); }
      killProcess(sig?: any) { return mockInstance?.killProcess?.(sig) ?? true; }
      callTool(...args: any[]) { return mockInstance?.callTool(...args) ?? Promise.resolve({}); }
    },
  };
});

describe('CodexRuntime', () => {
  let runtime: CodexRuntime;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(async () => {
    mockClient = createMockClient();
    const { McpClient } = await import('../../_shared/mcp-client.js');
    (McpClient as any).__setMockInstance(mockClient);
    runtime = new CodexRuntime();
  });

  describe('ensureReady()', () => {
    it('spawns client on first call', async () => {
      mockClient.isReady.mockReturnValue(false);
      await runtime.ensureReady();
      expect(mockClient.start).toHaveBeenCalled();
    });

    it('reuses live client', async () => {
      await runtime.ensureReady();
      mockClient.isReady.mockReturnValue(true);
      mockClient.start.mockClear();
      await runtime.ensureReady();
      expect(mockClient.start).not.toHaveBeenCalled();
    });

    it('single-flights concurrent calls', async () => {
      mockClient.isReady.mockReturnValue(false);
      let startCount = 0;
      mockClient.start.mockImplementation(async () => {
        startCount++;
        await new Promise((r) => setTimeout(r, 10));
      });
      await Promise.all([runtime.ensureReady(), runtime.ensureReady(), runtime.ensureReady()]);
      expect(startCount).toBe(1);
    });
  });

  describe('startSession()', () => {
    it('calls codex tool with hardcoded default config', async () => {
      const result = await runtime.startSession('gpt-5.4', 'hello', { cwd: '/tmp/test' });

      expect(mockClient.callTool).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({
          prompt: 'hello',
          model: 'gpt-5.4',
          cwd: '/tmp/test',
          config: expect.objectContaining({
            model_reasoning_effort: 'xhigh',
            features: { fast_mode: true },
            service_tier: 'fast',
          }),
        }),
        600_000,
      );
      expect(result.backendSessionId).toBe('thread-abc-123');
    });

    it('omits cwd when not supplied', async () => {
      await runtime.startSession('gpt-5.4', 'hi', {});
      const args = mockClient.callTool.mock.calls[0][1];
      expect(args).not.toHaveProperty('cwd');
    });

    it('extracts threadId from structuredContent', async () => {
      const result = await runtime.startSession('gpt-5.4', 'hi', {});
      expect(result.backendSessionId).toBe('thread-abc-123');
    });

    it('passes timeoutMs to McpClient.callTool', async () => {
      await runtime.startSession('gpt-5.4', 'hi', { timeoutMs: 12345 });
      const [, , timeout] = mockClient.callTool.mock.calls[0];
      expect(timeout).toBe(12345);
    });
  });

  describe('resumeSession()', () => {
    it('calls codex-reply with threadId only', async () => {
      const result = await runtime.resumeSession('thread-abc-123', 'continue', {});
      expect(mockClient.callTool).toHaveBeenCalledWith(
        'codex-reply',
        { prompt: 'continue', threadId: 'thread-abc-123' },
        600_000,
      );
      expect(result.backendSessionId).toBe('thread-abc-123');
    });
  });

  describe('watchdog integration', () => {
    it('kills child on backend timeout', async () => {
      mockClient.callTool.mockImplementation(() => new Promise(() => {})); // never resolves
      await expect(
        runtime.startSession('gpt-5.4', 'x', { timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(LlmChatError);
      expect(mockClient.killProcess).toHaveBeenCalledWith('SIGTERM');
    }, 10_000);

    it('wraps non-LlmChatError from callTool as BACKEND_FAILED', async () => {
      mockClient.callTool.mockRejectedValue(new Error('boom'));
      const err = await runtime.startSession('gpt-5.4', 'x', {}).catch((e) => e);
      expect(err).toBeInstanceOf(LlmChatError);
      expect((err as LlmChatError).code).toBe(ErrorCode.BACKEND_FAILED);
    });
  });

  describe('shutdown()', () => {
    it('stops the client', async () => {
      await runtime.ensureReady();
      await runtime.shutdown();
      expect(mockClient.stop).toHaveBeenCalled();
    });
  });
});
