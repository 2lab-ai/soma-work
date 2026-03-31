/**
 * ToolEventProcessor tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpCallTracker } from '../mcp-call-tracker';
import { McpStatusDisplay } from './mcp-status-tracker';
import {
  type SayFunction,
  type ToolEventContext,
  ToolEventProcessor,
  type ToolResultEvent,
  type ToolUseEvent,
} from './tool-event-processor';
import { ToolTracker } from './tool-tracker';

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
      registerCall: vi.fn(),
      completeCall: vi.fn(),
      cleanupSession: vi.fn(),
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

    it('should call registerCall for MCP tools', async () => {
      const toolUses: ToolUseEvent[] = [{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { query: 'test' } }];

      await processor.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).toHaveBeenCalledWith('jira', 'search_issues');
      expect(toolTracker.getMcpCallId('tool_1')).toBe('call_123');
      expect(mcpStatusDisplay.registerCall).toHaveBeenCalledWith(
        'C123:thread_ts',
        'call_123',
        {
          displayType: 'MCP',
          displayLabel: 'jira → search_issues',
          initialDelay: 10000,
          predictKey: { serverName: 'jira', toolName: 'search_issues' },
          paramsSummary: '(query: test)',
        },
        'C123',
        'thread_ts',
      );
    });

    it('should not start MCP tracking for non-MCP tools', async () => {
      const toolUses: ToolUseEvent[] = [{ id: 'tool_1', name: 'Read', input: {} }];

      await processor.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).not.toHaveBeenCalled();
      expect(mcpStatusDisplay.registerCall).not.toHaveBeenCalled();
    });

    it('should handle complex MCP tool names', async () => {
      const toolUses: ToolUseEvent[] = [{ id: 'tool_1', name: 'mcp__github__repos__list_branches', input: {} }];

      await processor.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).toHaveBeenCalledWith('github', 'repos__list_branches');
    });

    it('should call registerCall for Task tools (subagent)', async () => {
      const toolUses: ToolUseEvent[] = [
        {
          id: 'tool_1',
          name: 'Task',
          input: { description: 'review', prompt: 'test', subagent_type: 'code-reviewer' },
        },
      ];

      await processor.handleToolUse(toolUses, mockContext);

      expect(mcpStatusDisplay.registerCall).toHaveBeenCalledWith(
        'C123:thread_ts',
        'call_123',
        expect.objectContaining({
          displayType: 'Subagent',
        }),
        'C123',
        'thread_ts',
      );
    });

    it('should use registerCall for multiple trackable tools (no groupId needed)', async () => {
      mcpCallTracker.startCall.mockReturnValueOnce('call_1').mockReturnValueOnce('call_2');
      const toolUses: ToolUseEvent[] = [
        {
          id: 'tool_1',
          name: 'Task',
          input: { description: 'review', prompt: 'test', subagent_type: 'code-reviewer' },
        },
        {
          id: 'tool_2',
          name: 'Task',
          input: { description: 'hunt', prompt: 'test', subagent_type: 'silent-failure-hunter' },
        },
      ];

      await processor.handleToolUse(toolUses, mockContext);

      // Both should use registerCall (session tick handles consolidation)
      expect(mcpStatusDisplay.registerCall).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleToolResult', () => {
    it('should lookup tool name from tracker if not set', async () => {
      // Pre-track a tool
      toolTracker.trackToolUse('tool_1', 'Read');

      const toolResults: ToolResultEvent[] = [{ toolUseId: 'tool_1', result: 'file contents' }];

      await processor.handleToolResult(toolResults, mockContext);

      // Should have sent a formatted message
      expect(mockSay).toHaveBeenCalled();
    });

    it('should end MCP tracking and call completeCall', async () => {
      // Pre-track MCP call
      toolTracker.trackToolUse('tool_1', 'mcp__jira__search_issues');
      toolTracker.trackMcpCall('tool_1', 'call_123');

      const toolResults: ToolResultEvent[] = [
        { toolUseId: 'tool_1', toolName: 'mcp__jira__search_issues', result: '[]' },
      ];

      await processor.handleToolResult(toolResults, mockContext);

      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_123');
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_123', 1000);
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
        }),
      );
    });

    it('should format and send built-in tool results', async () => {
      toolTracker.trackToolUse('tool_1', 'Bash');

      const toolResults: ToolResultEvent[] = [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }];

      await processor.handleToolResult(toolResults, mockContext);

      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Bash'),
        }),
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
          text: expect.stringContaining('🔴'),
        }),
      );
    });

    it('should skip tools that should not display results', async () => {
      toolTracker.trackToolUse('tool_1', 'TodoWrite');

      const toolResults: ToolResultEvent[] = [{ toolUseId: 'tool_1', toolName: 'TodoWrite', result: 'updated' }];

      await processor.handleToolResult(toolResults, mockContext);

      // TodoWrite results are skipped
      expect(mockSay).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should call cleanupSession on mcpStatusDisplay', () => {
      processor.cleanup('C123:thread_ts');

      expect(mcpStatusDisplay.cleanupSession).toHaveBeenCalledWith('C123:thread_ts');
    });

    it('should complete active MCP calls before cleanup', () => {
      // Track active MCP calls
      toolTracker.trackToolUse('tool_1', 'mcp__codex__search');
      toolTracker.trackMcpCall('tool_1', 'call_1');
      toolTracker.trackToolUse('tool_2', 'mcp__jira__search');
      toolTracker.trackMcpCall('tool_2', 'call_2');

      processor.cleanup('C123:thread_ts');

      // Should complete active calls
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_1', null);
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_2', null);
      // Then cleanup session
      expect(mcpStatusDisplay.cleanupSession).toHaveBeenCalledWith('C123:thread_ts');
    });

    it('should not throw without sessionKey', () => {
      expect(() => processor.cleanup()).not.toThrow();
    });
  });
});
