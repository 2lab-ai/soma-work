/**
 * Unit Tests — CodexRuntime
 * Issue #332: Backend Runtime Adapter Layer
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CodexRuntime } from './codex-runtime.js';

// ── Mock McpClient ────────────────────────────────────────

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    isReady: vi.fn().mockReturnValue(true),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ content: 'mock response' }) }],
      structuredContent: { threadId: 'thread-abc-123' },
    }),
    ...overrides,
  };
}

// Mock child_process for CLI existence check
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => '/usr/local/bin/codex'),
}));

// Mock McpClient constructor
vi.mock('../../_shared/mcp-client.js', () => {
  let mockInstance: any = null;
  return {
    McpClient: class MockMcpClient {
      static __setMockInstance(inst: any) { mockInstance = inst; }
      isReady() { return mockInstance?.isReady() ?? false; }
      start() { return mockInstance?.start() ?? Promise.resolve(); }
      stop() { return mockInstance?.stop() ?? Promise.resolve(); }
      callTool(...args: any[]) { return mockInstance?.callTool(...args) ?? Promise.resolve({}); }
    },
  };
});

// ── Tests ─────────────────────────────────────────────────

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
      // First call initializes (this.client is null, so isReady is not called)
      await runtime.ensureReady();

      // Second call — client is now set, isReady returns true → skip init
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
        await new Promise(r => setTimeout(r, 10));
      });

      await Promise.all([runtime.ensureReady(), runtime.ensureReady(), runtime.ensureReady()]);
      expect(startCount).toBe(1);
    });
  });

  describe('startSession()', () => {
    it('calls codex tool with correct args', async () => {
      const result = await runtime.startSession('hello', {
        model: 'gpt-5.4',
        cwd: '/tmp/test',
        configOverride: { model_reasoning_effort: 'xhigh', 'features.fast_mode': 'true' },
      });

      expect(mockClient.callTool).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({
          prompt: 'hello',
          model: 'gpt-5.4',
          cwd: '/tmp/test',
          config: expect.objectContaining({
            model_reasoning_effort: 'xhigh',
            features: { fast_mode: true },
          }),
        }),
        600_000,
      );
      expect(result.backendSessionId).toBe('thread-abc-123');
      expect(result.backend).toBe('codex');
    });

    it('merges user config over defaults', async () => {
      await runtime.startSession('hello', {
        model: 'gpt-5.4',
        configOverride: { model_reasoning_effort: 'xhigh' },
        config: { model_reasoning_effort: 'low' },
      });

      const callArgs = mockClient.callTool.mock.calls[0][1];
      expect(callArgs.config.model_reasoning_effort).toBe('low');
    });

    it('extracts threadId from response', async () => {
      const result = await runtime.startSession('hello', { model: 'gpt-5.4' });
      expect(result.backendSessionId).toBe('thread-abc-123');
    });
  });

  describe('resumeSession()', () => {
    it('calls codex-reply with threadId', async () => {
      const result = await runtime.resumeSession('thread-abc-123', 'continue');

      expect(mockClient.callTool).toHaveBeenCalledWith(
        'codex-reply',
        { prompt: 'continue', threadId: 'thread-abc-123' },
        600_000,
      );
      expect(result.backend).toBe('codex');
    });
  });

  describe('shutdown()', () => {
    it('stops the client', async () => {
      await runtime.ensureReady();
      await runtime.shutdown();
      // shutdown should not throw
    });
  });

  describe('capabilities', () => {
    it('has correct flags', () => {
      expect(runtime.capabilities).toEqual({
        supportsReview: false,
        supportsInterrupt: false,
        supportsResume: true,
        supportsEventStream: false,
      });
    });
  });
});
