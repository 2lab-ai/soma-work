import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpStatusDisplay } from './mcp-status-tracker';
import { SlackApiHelper } from './slack-api-helper';
import { McpCallTracker } from '../mcp-call-tracker';

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
      mockMcpCallTracker as unknown as McpCallTracker
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startStatusUpdate', () => {
    describe('for codex server', () => {
      it('should create status message immediately', async () => {
        await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');

        expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
          'C123',
          expect.stringContaining('MCP 실행 중: codex → search'),
          { threadTs: '111.222' }
        );
      });

      it('should update message every 30 seconds', async () => {
        await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');
        mockSlackApi.postMessage.mockClear();

        // Advance 30 seconds
        await vi.advanceTimersByTimeAsync(30000);

        expect(mockSlackApi.updateMessage).toHaveBeenCalled();
      });

      it('should stop updating when elapsed returns null', async () => {
        await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');

        mockMcpCallTracker.getElapsedTime.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(30000);

        expect(display.getActiveCount()).toBe(0);
      });
    });

    describe('for other servers', () => {
      it('should not create status message immediately', async () => {
        await display.startStatusUpdate('call1', 'jira', 'search', 'C123', '111.222');

        expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      });

      it('should create status message after 10 seconds', async () => {
        await display.startStatusUpdate('call1', 'jira', 'search', 'C123', '111.222');

        await vi.advanceTimersByTimeAsync(10000);

        expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
          'C123',
          expect.stringContaining('MCP 실행 중: jira → search'),
          { threadTs: '111.222' }
        );
      });

      it('should not create message if call completes before 10 seconds', async () => {
        await display.startStatusUpdate('call1', 'jira', 'search', 'C123', '111.222');

        mockMcpCallTracker.getElapsedTime.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(10000);

        expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      });
    });

    it('should include progress bar when prediction is available', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(60000);
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30000);

      await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');

      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('진행률: 50%'),
        expect.any(Object)
      );
      expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
        'C123',
        expect.stringContaining('██████████░░░░░░░░░░'),
        expect.any(Object)
      );
    });
  });

  describe('stopStatusUpdate', () => {
    it('should clear interval and update message to completed', async () => {
      await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');
      mockSlackApi.updateMessage.mockClear();

      await display.stopStatusUpdate('call1', 5000);

      expect(mockSlackApi.updateMessage).toHaveBeenCalledWith(
        'C123',
        '123.456',
        expect.stringContaining('MCP 완료: codex → search')
      );
      expect(mockSlackApi.updateMessage).toHaveBeenCalledWith(
        'C123',
        '123.456',
        expect.stringContaining('5.0s')
      );
      expect(display.getActiveCount()).toBe(0);
    });

    it('should not throw if no status message exists', async () => {
      await expect(display.stopStatusUpdate('unknown', 5000)).resolves.not.toThrow();
    });

    it('should handle undefined duration', async () => {
      await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');
      mockSlackApi.updateMessage.mockClear();

      await display.stopStatusUpdate('call1');

      expect(mockSlackApi.updateMessage).toHaveBeenCalledWith(
        'C123',
        '123.456',
        '✅ *MCP 완료: codex → search*'
      );
    });
  });

  describe('getStatusMessageInfo', () => {
    it('should return status message info', async () => {
      await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');

      const info = display.getStatusMessageInfo('call1');
      expect(info).toEqual({
        ts: '123.456',
        channel: 'C123',
        serverName: 'codex',
        toolName: 'search',
      });
    });

    it('should return undefined for unknown call', () => {
      expect(display.getStatusMessageInfo('unknown')).toBeUndefined();
    });
  });

  describe('getActiveCount', () => {
    it('should return number of active status updates', async () => {
      expect(display.getActiveCount()).toBe(0);

      await display.startStatusUpdate('call1', 'codex', 'search', 'C123', '111.222');
      expect(display.getActiveCount()).toBe(1);

      await display.startStatusUpdate('call2', 'codex', 'search', 'C123', '111.222');
      expect(display.getActiveCount()).toBe(2);

      await display.stopStatusUpdate('call1');
      expect(display.getActiveCount()).toBe(1);
    });
  });
});
