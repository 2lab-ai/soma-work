/**
 * Unit Tests — GeminiRuntime
 * Issue #332: Backend Runtime Adapter Layer
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GeminiRuntime } from './gemini-runtime.js';

// ── Mock McpClient ────────────────────────────────────────

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    isReady: vi.fn().mockReturnValue(true),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ content: 'gemini response' }) }],
      structuredContent: { sessionId: 'gemini-session-xyz' },
    }),
    ...overrides,
  };
}

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => '/usr/local/bin/gemini'),
}));

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

describe('GeminiRuntime', () => {
  let runtime: GeminiRuntime;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(async () => {
    mockClient = createMockClient();
    const { McpClient } = await import('../../_shared/mcp-client.js');
    (McpClient as any).__setMockInstance(mockClient);
    runtime = new GeminiRuntime();
  });

  describe('ensureReady()', () => {
    it('spawns client on first call', async () => {
      mockClient.isReady.mockReturnValue(false);
      await runtime.ensureReady();
      expect(mockClient.start).toHaveBeenCalled();
    });

    it('single-flights concurrent calls', async () => {
      mockClient.isReady.mockReturnValue(false);
      let startCount = 0;
      mockClient.start.mockImplementation(async () => {
        startCount++;
        await new Promise(r => setTimeout(r, 10));
      });

      await Promise.all([runtime.ensureReady(), runtime.ensureReady()]);
      expect(startCount).toBe(1);
    });
  });

  describe('startSession()', () => {
    it('calls chat tool with correct args (no config expansion)', async () => {
      const result = await runtime.startSession('hello', {
        model: 'gemini-3.1-pro-preview',
      });

      expect(mockClient.callTool).toHaveBeenCalledWith(
        'chat',
        { prompt: 'hello', model: 'gemini-3.1-pro-preview' },
        600_000,
      );
      expect(result.backendSessionId).toBe('gemini-session-xyz');
      expect(result.backend).toBe('gemini');
    });

    it('extracts sessionId from response', async () => {
      const result = await runtime.startSession('hello', { model: 'gemini-3.1-pro' });
      expect(result.backendSessionId).toBe('gemini-session-xyz');
    });
  });

  describe('resumeSession()', () => {
    it('calls chat-reply with sessionId', async () => {
      const result = await runtime.resumeSession('gemini-session-xyz', 'continue');

      expect(mockClient.callTool).toHaveBeenCalledWith(
        'chat-reply',
        { prompt: 'continue', sessionId: 'gemini-session-xyz' },
        600_000,
      );
      expect(result.backend).toBe('gemini');
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
