/**
 * ToolEventProcessor tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolEventProcessor, ToolUseEvent, ToolResultEvent, ToolEventContext, SayFunction } from './tool-event-processor';
import { ToolTracker } from './tool-tracker';
import { McpStatusDisplay } from './mcp-status-tracker';
import { McpCallTracker } from '../mcp-call-tracker';

// Mock dependencies
vi.mock('./mcp-status-tracker', () => ({
  McpStatusDisplay: vi.fn().mockImplementation(() => ({
    startStatusUpdate: vi.fn(),
    stopStatusUpdate: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('ToolEventProcessor', () => {
  let toolTracker: ToolTracker;
  let mcpStatusDisplay: any;
  let mcpCallTracker: any;
  let processor: ToolEventProcessor;
  let mockSay: SayFunction;
  let mockContext: ToolEventContext;

  beforeEach(() => {
    toolTracker = new ToolTracker();
    mcpStatusDisplay = {
      startStatusUpdate: vi.fn(),
      stopStatusUpdate: vi.fn().mockResolvedValue(undefined),
    };
    mcpCallTracker = {
      startCall: vi.fn().mockReturnValue('call_123'),
      endCall: vi.fn().mockReturnValue(1000),
      getToolStats: vi.fn().mockReturnValue(null),
    };
    processor = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker);

    mockSay = vi.fn().mockResolvedValue({ ts: 'msg_ts' }) as unknown as SayFunction;
    mockContext = {
      channel: 'C123',
      threadTs: 'thread_ts',
      sessionKey: 'C123:thread_ts',
      say: mockSay,
    };
  });

  describe('handleToolUse', () => {
    it('should track tool use IDs', async () => {
      const toolUses: ToolUseEvent[] = [
        { id: 'tool_1', name: 'Read', input: { file_path: '/test.txt' } },
        { id: 'tool_2', name: 'Bash', input: { command: 'ls' } },
      ];

      await processor.handleToolUse(toolUses, mockContext);

      expect(toolTracker.getToolName('tool_1')).toBe('Read');
      expect(toolTracker.getToolName('tool_2')).toBe('Bash');
    });

    it('should start MCP tracking for MCP tools', async () => {
      const toolUses: ToolUseEvent[] = [
        { id: 'tool_1', name: 'mcp__jira__search_issues', input: { query: 'test' } },
      ];

      await processor.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).toHaveBeenCalledWith('jira', 'search_issues');
      expect(toolTracker.getMcpCallId('tool_1')).toBe('call_123');
      expect(mcpStatusDisplay.startStatusUpdate).toHaveBeenCalledWith(
        'call_123',
        'jira',
        'search_issues',
        'C123',
        'thread_ts'
      );
    });

    it('should not start MCP tracking for non-MCP tools', async () => {
      const toolUses: ToolUseEvent[] = [
        { id: 'tool_1', name: 'Read', input: {} },
      ];

      await processor.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).not.toHaveBeenCalled();
      expect(mcpStatusDisplay.startStatusUpdate).not.toHaveBeenCalled();
    });

    it('should handle complex MCP tool names', async () => {
      const toolUses: ToolUseEvent[] = [
        { id: 'tool_1', name: 'mcp__github__repos__list_branches', input: {} },
      ];

      await processor.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).toHaveBeenCalledWith('github', 'repos__list_branches');
    });
  });

  describe('handleToolResult', () => {
    it('should lookup tool name from tracker if not set', async () => {
      // Pre-track a tool
      toolTracker.trackToolUse('tool_1', 'Read');

      const toolResults: ToolResultEvent[] = [
        { toolUseId: 'tool_1', result: 'file contents' },
      ];

      await processor.handleToolResult(toolResults, mockContext);

      // Should have sent a formatted message
      expect(mockSay).toHaveBeenCalled();
    });

    it('should end MCP tracking and show duration', async () => {
      // Pre-track MCP call
      toolTracker.trackToolUse('tool_1', 'mcp__jira__search_issues');
      toolTracker.trackMcpCall('tool_1', 'call_123');

      const toolResults: ToolResultEvent[] = [
        { toolUseId: 'tool_1', toolName: 'mcp__jira__search_issues', result: '[]' },
      ];

      await processor.handleToolResult(toolResults, mockContext);

      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_123');
      expect(mcpStatusDisplay.stopStatusUpdate).toHaveBeenCalledWith('call_123', 1000);
      expect(toolTracker.getMcpCallId('tool_1')).toBeUndefined();
    });

    it('should format and send MCP tool results', async () => {
      toolTracker.trackToolUse('tool_1', 'mcp__jira__search_issues');
      toolTracker.trackMcpCall('tool_1', 'call_123');

      const toolResults: ToolResultEvent[] = [
        { toolUseId: 'tool_1', toolName: 'mcp__jira__search_issues', result: '[{"key":"TEST-1"}]' },
      ];

      await processor.handleToolResult(toolResults, mockContext);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('MCP Result: jira → search_issues'),
        })
      );
    });

    it('should format and send built-in tool results', async () => {
      toolTracker.trackToolUse('tool_1', 'Bash');

      const toolResults: ToolResultEvent[] = [
        { toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' },
      ];

      await processor.handleToolResult(toolResults, mockContext);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Bash'),
        })
      );
    });

    it('should handle error results', async () => {
      toolTracker.trackToolUse('tool_1', 'Bash');

      const toolResults: ToolResultEvent[] = [
        { toolUseId: 'tool_1', toolName: 'Bash', result: 'command failed', isError: true },
      ];

      await processor.handleToolResult(toolResults, mockContext);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('❌'),
        })
      );
    });

    it('should skip tools that should not display results', async () => {
      toolTracker.trackToolUse('tool_1', 'TodoWrite');

      const toolResults: ToolResultEvent[] = [
        { toolUseId: 'tool_1', toolName: 'TodoWrite', result: 'updated' },
      ];

      await processor.handleToolResult(toolResults, mockContext);

      // TodoWrite results are skipped
      expect(mockSay).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should call cleanup without error', () => {
      expect(() => processor.cleanup()).not.toThrow();
    });
  });
});
