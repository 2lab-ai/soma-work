import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpCallTracker } from '../mcp-call-tracker';
import { McpStatusDisplay, type StatusUpdateConfig } from './mcp-status-tracker';
import type { SlackApiHelper } from './slack-api-helper';

// Mock SlackApiHelper
const createMockSlackApi = () => ({
  postMessage: vi.fn().mockResolvedValue({ ts: '123.456', channel: 'C123' }),
  updateMessage: vi.fn().mockResolvedValue(undefined),
});

// Mock McpCallTracker
const createMockMcpCallTracker = () => ({
  getElapsedTime: vi.fn().mockReturnValue(5000),
  getPredictedDuration: vi.fn().mockReturnValue(null),
});

// Helper to create config
function mcpConfig(serverName: string, toolName: string, paramsSummary?: string): StatusUpdateConfig {
  return {
    displayType: 'MCP',
    displayLabel: `${serverName} → ${toolName}`,
    initialDelay: 0,
    predictKey: { serverName, toolName },
    paramsSummary,
  };
}

function subagentConfig(label: string): StatusUpdateConfig {
  return {
    displayType: 'Subagent',
    displayLabel: label,
    initialDelay: 0,
    predictKey: { serverName: '_subagent', toolName: label },
  };
}

describe('McpStatusDisplay', () => {
  let mockSlackApi: ReturnType<typeof createMockSlackApi>;
  let mockMcpCallTracker: ReturnType<typeof createMockMcpCallTracker>;
  let display: McpStatusDisplay;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSlackApi = createMockSlackApi();
    mockMcpCallTracker = createMockMcpCallTracker();
    display = new McpStatusDisplay(
      mockSlackApi as unknown as SlackApiHelper,
      mockMcpCallTracker as unknown as McpCallTracker,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerCall', () => {
    it('should register a call and start a session tick', () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      expect(display.getActiveCount()).toBe(1);
    });

    it('should register multiple calls in the same session', () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      expect(display.getActiveCount()).toBe(2);
    });

    it('should reuse session tick for same session', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      // First tick should post a single consolidated message
      await vi.advanceTimersByTimeAsync(10_000);

      // Only 1 postMessage (consolidated), not 2 separate ones
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
    });

    it('should create separate ticks for different sessions', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session2', 'call2', mcpConfig('jira', 'search'), 'C456', '222.333');

      await vi.advanceTimersByTimeAsync(10_000);

      // Each session gets its own message
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(2);
    });

    it('should post initial message on first tick', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith('C123', expect.stringContaining('codex → search'), {
        threadTs: '111.222',
      });
    });

    it('should update message on subsequent ticks', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // First tick: post
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);

      // Second tick: update
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.updateMessage).toHaveBeenCalled();
    });
  });

  describe('completeCall', () => {
    it('should mark a call as completed', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.completeCall('call1', 5000);

      // Should still be in active count until tick renders and cleans up
      // After tick, all completed → tick stops
      await vi.advanceTimersByTimeAsync(10_000);

      // Completion text should include green indicator
      const postText = mockSlackApi.postMessage.mock.calls[0]?.[1] ?? '';
      expect(postText).toContain('🟢');
    });

    it('should be no-op for unknown callId', () => {
      // Should not throw
      expect(() => display.completeCall('unknown', 5000)).not.toThrow();
    });

    it('should stop tick when all calls complete', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      display.completeCall('call1', 3000);
      display.completeCall('call2', 5000);

      // First tick renders final state
      await vi.advanceTimersByTimeAsync(10_000);

      // Reset mocks to check no more ticks
      mockSlackApi.postMessage.mockClear();
      mockSlackApi.updateMessage.mockClear();

      // Advance more time — should have no more API calls
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();
    });

    it('should fall back to startTime-based elapsed when duration is null', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // 5s pass before completion (first tick is at 10s, so no tick fires yet)
      await vi.advanceTimersByTimeAsync(5000);

      // Abort / untracked path: duration comes through as null
      display.completeCall('call1', null);

      // Next tick renders the completed state
      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('🟢');
      expect(postText).toContain('5.0s');
    });

    it('should preserve explicit duration=0 (do not fall back on 0)', async () => {
      // Regression guard: `duration ?? fallback` must treat 0 as a real value,
      // unlike `duration || fallback` which would clobber 0.
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // Advance 4s, then report a 0ms duration (e.g. cached response).
      await vi.advanceTimersByTimeAsync(4000);
      display.completeCall('call1', 0);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      // Expect 0ms-style formatting, not the 4s fallback.
      expect(postText).toContain('0ms');
      expect(postText).not.toContain('4.0s');
    });

    it('should show elapsed for every call in multi-call session even when one is null', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(3000);

      display.completeCall('call1', null); // fallback to 3s
      display.completeCall('call2', 7000); // explicit

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('3.0s'); // from startTime fallback
      expect(postText).toContain('7.0s'); // from explicit duration
    });

    it('should render mixed state (some complete, some running)', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      display.completeCall('call1', 3000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('🟢'); // completed call
      expect(postText).toContain('⏳'); // running call
      expect(postText).toContain('1/2 완료');
    });
  });

  describe('cleanupSession', () => {
    it('should remove all calls and stop tick for a session', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');

      display.cleanupSession('session1');

      expect(display.getActiveCount()).toBe(0);

      // No ticks should fire
      mockSlackApi.postMessage.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
    });

    it('should not affect other sessions', () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session2', 'call2', mcpConfig('jira', 'search'), 'C456', '222.333');

      display.cleanupSession('session1');

      expect(display.getActiveCount()).toBe(1);
    });

    it('should be no-op for unknown session', () => {
      expect(() => display.cleanupSession('unknown')).not.toThrow();
    });
  });

  describe('adaptive interval', () => {
    it('should use 10s interval for calls < 1 minute old', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30_000); // 30s
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // First tick at 10s
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);

      // Second tick at 20s
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.updateMessage).toHaveBeenCalledTimes(1);
    });

    it('should use 30s interval for calls 1-10 minutes old', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(120_000); // 2 min
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      // First tick at 10s (initial interval)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);

      // After interval adjustment to 30s, no update at 20s
      mockSlackApi.updateMessage.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();

      // Update at 30s from adjustment
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockSlackApi.updateMessage).toHaveBeenCalled();
    });
  });

  describe('2-hour hard timeout', () => {
    it('should mark calls as timed_out after 2 hours', async () => {
      // Set elapsed to just over 2 hours
      mockMcpCallTracker.getElapsedTime.mockReturnValue(7_200_001);
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0]?.[1] ?? '';
      expect(postText).toContain('타임아웃');
    });

    it('should stop tick after all calls timeout', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(7_200_001);
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      mockSlackApi.postMessage.mockClear();
      mockSlackApi.updateMessage.mockClear();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      expect(mockSlackApi.updateMessage).not.toHaveBeenCalled();
    });
  });

  describe('consolidated rendering', () => {
    it('should render all-completed state', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', subagentConfig('Explorer'), 'C123', '111.222');

      display.completeCall('call1', 3000);
      display.completeCall('call2', 5000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('2개 작업 완료');
      expect(postText).toContain('🟢');
    });

    it('should render mixed running/completed state', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', subagentConfig('Explorer'), 'C123', '111.222');

      display.completeCall('call1', 3000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('2개 작업 실행 중');
      expect(postText).toContain('1/2 완료');
      expect(postText).toContain('⏳ Explorer');
      expect(postText).toContain('🟢 codex → search');
    });

    it('should show timed_out entries', async () => {
      mockMcpCallTracker.getElapsedTime.mockReturnValue(7_200_001);
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('⏱️');
      expect(postText).toContain('타임아웃');
    });

    it('should include paramsSummary in rendered text', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search', '(query: hello)'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('(query: hello)');
    });

    it('should include progress bar when prediction is available', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(60000);
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30000);

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('█');
      expect(postText).toContain('░');
    });

    it('should show duration for completed calls', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.completeCall('call1', 5000);

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('5.0s');
    });

    it('should only make 1 API call per tick', async () => {
      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');
      display.registerCall('session1', 'call3', subagentConfig('Explorer'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      // Only 1 postMessage for all 3 calls
      expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('getActiveCount', () => {
    it('should return number of running calls', () => {
      expect(display.getActiveCount()).toBe(0);

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      expect(display.getActiveCount()).toBe(1);

      display.registerCall('session1', 'call2', mcpConfig('jira', 'search'), 'C123', '111.222');
      expect(display.getActiveCount()).toBe(2);

      display.completeCall('call1', 1000);
      // Completed calls are still counted until tick cleanup
      // They should not be counted in active
      expect(display.getActiveCount()).toBe(1);
    });
  });

  describe('adaptive prediction rendering', () => {
    it('should show adaptive indicator when elapsed exceeds predicted', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(34800); // 34.8s
      mockMcpCallTracker.getElapsedTime.mockReturnValue(40000); // 40s elapsed

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).toContain('🐢');
      expect(postText).toContain('→');
    });

    it('should not adapt when elapsed is within predicted time', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(60000); // 60s
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30000); // 30s

      display.registerCall('session1', 'call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      await vi.advanceTimersByTimeAsync(10_000);

      const postText = mockSlackApi.postMessage.mock.calls[0][1];
      expect(postText).not.toContain('🐢');
    });
  });
});
