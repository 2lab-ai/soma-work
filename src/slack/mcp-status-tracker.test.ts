import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpStatusDisplay, StatusUpdateConfig } from './mcp-status-tracker';
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

// Helper to create MCP config
function mcpConfig(serverName: string, toolName: string): StatusUpdateConfig {
  return {
    displayType: 'MCP',
    displayLabel: `${serverName} → ${toolName}`,
    initialDelay: serverName === 'codex' ? 0 : 10000,
    predictKey: { serverName, toolName },
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
      mockMcpCallTracker as unknown as McpCallTracker
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startStatusUpdate', () => {
    describe('for codex server (immediate)', () => {
      it('should create status message immediately', async () => {
        await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');

        expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
          'C123',
          expect.stringContaining('MCP 실행 중: codex → search'),
          { threadTs: '111.222' }
        );
      });

      it('should update message every 30 seconds', async () => {
        await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');
        mockSlackApi.postMessage.mockClear();

        // Advance 30 seconds
        await vi.advanceTimersByTimeAsync(30000);

        expect(mockSlackApi.updateMessage).toHaveBeenCalled();
      });

      it('should stop updating when elapsed returns null', async () => {
        await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');

        mockMcpCallTracker.getElapsedTime.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(30000);

        expect(display.getActiveCount()).toBe(0);
      });
    });

    describe('for other servers (delayed)', () => {
      it('should not create status message immediately', async () => {
        await display.startStatusUpdate('call1', mcpConfig('jira', 'search'), 'C123', '111.222');

        expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      });

      it('should create status message after 10 seconds', async () => {
        await display.startStatusUpdate('call1', mcpConfig('jira', 'search'), 'C123', '111.222');

        await vi.advanceTimersByTimeAsync(10000);

        expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
          'C123',
          expect.stringContaining('MCP 실행 중: jira → search'),
          { threadTs: '111.222' }
        );
      });

      it('should not create message if call completes before 10 seconds', async () => {
        await display.startStatusUpdate('call1', mcpConfig('jira', 'search'), 'C123', '111.222');

        mockMcpCallTracker.getElapsedTime.mockReturnValue(null);
        await vi.advanceTimersByTimeAsync(10000);

        expect(mockSlackApi.postMessage).not.toHaveBeenCalled();
      });
    });

    describe('for subagent (immediate)', () => {
      it('should create status message immediately for subagent', async () => {
        await display.startStatusUpdate('call1', {
          displayType: 'Subagent',
          displayLabel: 'General Purpose',
          initialDelay: 0,
          predictKey: { serverName: '_subagent', toolName: 'General Purpose' },
        }, 'C123', '111.222');

        expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
          'C123',
          expect.stringContaining('Subagent 실행 중: General Purpose'),
          { threadTs: '111.222' }
        );
      });
    });

    it('should include progress bar when prediction is available', async () => {
      mockMcpCallTracker.getPredictedDuration.mockReturnValue(60000);
      mockMcpCallTracker.getElapsedTime.mockReturnValue(30000);

      await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');

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
      await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');
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

    it('should show subagent completion text', async () => {
      await display.startStatusUpdate('call1', {
        displayType: 'Subagent',
        displayLabel: 'Explorer',
        initialDelay: 0,
        predictKey: { serverName: '_subagent', toolName: 'Explorer' },
      }, 'C123', '111.222');
      mockSlackApi.updateMessage.mockClear();

      await display.stopStatusUpdate('call1', 3000);

      expect(mockSlackApi.updateMessage).toHaveBeenCalledWith(
        'C123',
        '123.456',
        expect.stringContaining('Subagent 완료: Explorer')
      );
    });

    it('should not throw if no status message exists', async () => {
      await expect(display.stopStatusUpdate('unknown', 5000)).resolves.not.toThrow();
    });

    it('should handle undefined duration', async () => {
      await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');
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
      await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');

      const info = display.getStatusMessageInfo('call1');
      expect(info).toEqual({
        ts: '123.456',
        channel: 'C123',
        displayType: 'MCP',
        displayLabel: 'codex → search',
      });
    });

    it('should return undefined for unknown call', () => {
      expect(display.getStatusMessageInfo('unknown')).toBeUndefined();
    });
  });

  describe('getActiveCount', () => {
    it('should return number of active status updates', async () => {
      expect(display.getActiveCount()).toBe(0);

      await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');
      expect(display.getActiveCount()).toBe(1);

      await display.startStatusUpdate('call2', mcpConfig('codex', 'search'), 'C123', '111.222');
      expect(display.getActiveCount()).toBe(2);

      await display.stopStatusUpdate('call1');
      expect(display.getActiveCount()).toBe(1);
    });
  });

  describe('Consolidated Group', () => {
    const subagentConfig = (label: string): StatusUpdateConfig => ({
      displayType: 'Subagent',
      displayLabel: label,
      initialDelay: 0,
      predictKey: { serverName: '_subagent', toolName: label },
    });

    describe('startGroupStatusUpdate', () => {
      it('should create group and track callId', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('Code Reviewer'), 'C123', '111.222');

        expect(display.isInGroup('call1')).toBe(true);
        expect(display.isInGroup('unknown')).toBe(false);
      });

      it('should post consolidated message after debounce', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('Code Reviewer'), 'C123', '111.222');
        await display.startGroupStatusUpdate('g1', 'call2', subagentConfig('Silent Failure Hunter'), 'C123', '111.222');

        // Before debounce fires
        expect(mockSlackApi.postMessage).not.toHaveBeenCalled();

        // After debounce (300ms)
        await vi.advanceTimersByTimeAsync(300);

        expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
        expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
          'C123',
          expect.stringContaining('2개 작업 실행 중'),
          { threadTs: '111.222' }
        );
      });

      it('should include all entries in consolidated message', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('Code Reviewer'), 'C123', '111.222');
        await display.startGroupStatusUpdate('g1', 'call2', subagentConfig('Oracle Reviewer'), 'C123', '111.222');

        await vi.advanceTimersByTimeAsync(300);

        const messageText = mockSlackApi.postMessage.mock.calls[0][1];
        expect(messageText).toContain('Code Reviewer');
        expect(messageText).toContain('Oracle Reviewer');
        expect(messageText).toContain('⏳');
      });

      it('should debounce multiple renders into one', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('A'), 'C123', '111.222');
        // Second entry added within debounce window
        await display.startGroupStatusUpdate('g1', 'call2', subagentConfig('B'), 'C123', '111.222');
        // Third entry added within debounce window
        await display.startGroupStatusUpdate('g1', 'call3', subagentConfig('C'), 'C123', '111.222');

        await vi.advanceTimersByTimeAsync(300);

        // Only one postMessage despite 3 entries added
        expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);
        expect(mockSlackApi.postMessage).toHaveBeenCalledWith(
          'C123',
          expect.stringContaining('3개 작업 실행 중'),
          { threadTs: '111.222' }
        );
      });
    });

    describe('stopGroupStatusUpdate', () => {
      it('should mark entry as completed and update message', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('Code Reviewer'), 'C123', '111.222');
        await display.startGroupStatusUpdate('g1', 'call2', subagentConfig('Oracle Reviewer'), 'C123', '111.222');

        // Let initial render happen
        await vi.advanceTimersByTimeAsync(300);
        mockSlackApi.postMessage.mockClear();

        // Complete first entry
        await display.stopGroupStatusUpdate('call1', 3700);

        // Debounce
        await vi.advanceTimersByTimeAsync(300);

        expect(mockSlackApi.updateMessage).toHaveBeenCalled();
        const updateText = mockSlackApi.updateMessage.mock.calls[0][2];
        expect(updateText).toContain('1/2 완료');
        expect(updateText).toContain('✅ Code Reviewer');
        expect(updateText).toContain('⏳ Oracle Reviewer');
      });

      it('should show all-completed state when all entries done', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('Code Reviewer'), 'C123', '111.222');
        await display.startGroupStatusUpdate('g1', 'call2', subagentConfig('Oracle Reviewer'), 'C123', '111.222');

        await vi.advanceTimersByTimeAsync(300);
        mockSlackApi.updateMessage.mockClear();

        await display.stopGroupStatusUpdate('call1', 3700);
        await display.stopGroupStatusUpdate('call2', 11600);

        // Final render is synchronous (no debounce), all entries completed
        const updateText = mockSlackApi.updateMessage.mock.calls[0][2];
        expect(updateText).toContain('2개 작업 완료');
        expect(updateText).toContain('✅ Code Reviewer');
        expect(updateText).toContain('✅ Oracle Reviewer');
      });

      it('should clean up group after all entries complete', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('A'), 'C123', '111.222');

        await vi.advanceTimersByTimeAsync(300);

        await display.stopGroupStatusUpdate('call1', 1000);

        expect(display.isInGroup('call1')).toBe(false);
      });

      it('should not throw for unknown callId', async () => {
        await expect(display.stopGroupStatusUpdate('unknown')).resolves.not.toThrow();
      });
    });

    describe('isInGroup', () => {
      it('should return false for individual (non-group) calls', async () => {
        await display.startStatusUpdate('call1', mcpConfig('codex', 'search'), 'C123', '111.222');
        expect(display.isInGroup('call1')).toBe(false);
      });

      it('should return true for group calls', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('A'), 'C123', '111.222');
        expect(display.isInGroup('call1')).toBe(true);
      });
    });

    describe('periodic group update', () => {
      it('should update group message every 10 seconds', async () => {
        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('A'), 'C123', '111.222');
        await display.startGroupStatusUpdate('g1', 'call2', subagentConfig('B'), 'C123', '111.222');

        // Initial render
        await vi.advanceTimersByTimeAsync(300);
        expect(mockSlackApi.postMessage).toHaveBeenCalledTimes(1);

        // After 10 seconds — periodic update
        await vi.advanceTimersByTimeAsync(10000);

        expect(mockSlackApi.updateMessage).toHaveBeenCalled();
      });
    });

    describe('progress bar in group entries', () => {
      it('should show progress bar for entries with predictions', async () => {
        mockMcpCallTracker.getPredictedDuration.mockReturnValue(60000);
        mockMcpCallTracker.getElapsedTime.mockReturnValue(30000);

        await display.startGroupStatusUpdate('g1', 'call1', subagentConfig('Code Reviewer'), 'C123', '111.222');
        await vi.advanceTimersByTimeAsync(300);

        const messageText = mockSlackApi.postMessage.mock.calls[0][1];
        expect(messageText).toContain('█');
        expect(messageText).toContain('░');
      });
    });
  });
});
