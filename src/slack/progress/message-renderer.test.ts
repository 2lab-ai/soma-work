import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRenderer, MessageRendererDeps } from './message-renderer';
import { LOG_DETAIL, LOG_MINIMAL, LOG_COMPACT } from '../output-flags';
import type { ToolStartEvent, ToolCompleteEvent } from './types';

function createMockDeps(): MessageRendererDeps {
  return {
    toolEventProcessor: {
      handleToolUse: vi.fn().mockResolvedValue(undefined),
      handleToolResult: vi.fn().mockResolvedValue(undefined),
      setReactionManager: vi.fn(),
      setCompactDurationCallback: vi.fn(),
      cleanup: vi.fn(),
    } as any,
    statusReporter: {
      createStatusMessage: vi.fn().mockResolvedValue('status-ts-123'),
      updateStatusDirect: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      getStatusEmoji: vi.fn().mockImplementation((status: string) => {
        const map: Record<string, string> = {
          thinking: 'thinking_face',
          working: 'gear',
          completed: 'white_check_mark',
          error: 'x',
          waiting: 'raised_hand',
        };
        return map[status] || status;
      }),
      getStatusMessage: vi.fn(),
      cleanup: vi.fn(),
    } as any,
    reactionManager: {
      updateReaction: vi.fn().mockResolvedValue(undefined),
    } as any,
    assistantStatusManager: {
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      getToolStatusText: vi.fn().mockImplementation((name: string, server?: string) => {
        if (server) return `is calling ${server}...`;
        return 'is working...';
      }),
      isEnabled: vi.fn().mockReturnValue(true),
    } as any,
    say: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
  };
}

describe('MessageRenderer', () => {
  let deps: MessageRendererDeps;
  let renderer: MessageRenderer;

  beforeEach(() => {
    deps = createMockDeps();
    renderer = new MessageRenderer(deps);
  });

  describe('start()', () => {
    it('creates status message, sets reaction, and starts spinner at detail level', async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_DETAIL,
      });

      expect(deps.statusReporter.createStatusMessage).toHaveBeenCalledWith(
        'C123', 'ts123', 'sk', 'thinking', expect.any(String)
      );
      expect(deps.reactionManager.updateReaction).toHaveBeenCalledWith('sk', 'thinking_face');
      expect(deps.assistantStatusManager.setStatus).toHaveBeenCalledWith('C123', 'ts123', 'is thinking...');
    });

    it('skips status message and reaction at minimal level', async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_MINIMAL,
      });

      expect(deps.statusReporter.createStatusMessage).not.toHaveBeenCalled();
      expect(deps.reactionManager.updateReaction).not.toHaveBeenCalled();
      expect(deps.assistantStatusManager.setStatus).not.toHaveBeenCalled();
    });

    it('creates status message and reaction at compact level', async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_COMPACT,
      });

      expect(deps.statusReporter.createStatusMessage).toHaveBeenCalled();
      expect(deps.reactionManager.updateReaction).toHaveBeenCalled();
      expect(deps.assistantStatusManager.setStatus).toHaveBeenCalled();
    });
  });

  describe('onToolStart()', () => {
    const readEvent: ToolStartEvent = {
      type: 'tool_start',
      toolUseId: 'tu1',
      toolName: 'Read',
      category: 'read',
      displayLabel: 'Read',
      input: { file_path: '/foo.ts' },
    };

    const mcpEvent: ToolStartEvent = {
      type: 'tool_start',
      toolUseId: 'tu2',
      toolName: 'mcp__github__search',
      category: 'mcp',
      displayLabel: 'github → search',
      serverName: 'github',
      serverToolName: 'search',
      input: { query: 'test' },
    };

    beforeEach(async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_DETAIL,
      });
    });

    it('updates status message to working and delegates to ToolEventProcessor', async () => {
      await renderer.onToolStart(readEvent);

      expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
        'C123', 'status-ts-123', 'working', expect.any(String)
      );
      expect(deps.reactionManager.updateReaction).toHaveBeenCalledWith('sk', 'gear');
      expect(deps.toolEventProcessor.handleToolUse).toHaveBeenCalledWith(
        [{ id: 'tu1', name: 'Read', input: { file_path: '/foo.ts' } }],
        expect.objectContaining({ channel: 'C123', threadTs: 'ts123' })
      );
    });

    it('sets MCP-specific spinner text for MCP tools', async () => {
      await renderer.onToolStart(mcpEvent);

      expect(deps.assistantStatusManager.getToolStatusText).toHaveBeenCalledWith(
        'mcp__github__search', 'github'
      );
      expect(deps.assistantStatusManager.setStatus).toHaveBeenCalledWith(
        'C123', 'ts123', 'is calling github...'
      );
    });
  });

  describe('onToolComplete()', () => {
    beforeEach(async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_DETAIL,
      });
    });

    it('delegates to ToolEventProcessor with correct result event', async () => {
      const event: ToolCompleteEvent = {
        type: 'tool_complete',
        toolUseId: 'tu1',
        toolName: 'Read',
        category: 'read',
        displayLabel: 'Read',
        isError: false,
        resultPreview: 'contents',
      };

      await renderer.onToolComplete(event);

      expect(deps.toolEventProcessor.handleToolResult).toHaveBeenCalledWith(
        [{ toolUseId: 'tu1', toolName: 'Read', result: 'contents', isError: false }],
        expect.objectContaining({ channel: 'C123', threadTs: 'ts123' })
      );
    });

    it('passes isError flag for error results', async () => {
      const event: ToolCompleteEvent = {
        type: 'tool_complete',
        toolUseId: 'tu2',
        toolName: 'Bash',
        category: 'execute',
        displayLabel: 'Bash',
        isError: true,
        resultPreview: 'command failed',
      };

      await renderer.onToolComplete(event);

      expect(deps.toolEventProcessor.handleToolResult).toHaveBeenCalledWith(
        [expect.objectContaining({ isError: true })],
        expect.any(Object)
      );
    });
  });

  describe('finish()', () => {
    beforeEach(async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_DETAIL,
      });
    });

    it('updates status message, reaction, and clears spinner for completed', async () => {
      await renderer.finish({ status: 'completed' });

      expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
        'C123', 'status-ts-123', 'completed', expect.any(String)
      );
      expect(deps.reactionManager.updateReaction).toHaveBeenCalledWith('sk', 'white_check_mark');
      expect(deps.assistantStatusManager.clearStatus).toHaveBeenCalledWith('C123', 'ts123');
    });

    it('sets waiting status when choice is pending', async () => {
      await renderer.finish({ status: 'waiting' });

      expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
        'C123', 'status-ts-123', 'waiting', expect.any(String)
      );
      expect(deps.reactionManager.updateReaction).toHaveBeenCalledWith('sk', 'raised_hand');
    });
  });

  describe('abort()', () => {
    beforeEach(async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_DETAIL,
      });
    });

    it('sets error status and clears spinner', async () => {
      await renderer.abort(new Error('test error'));

      expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
        'C123', 'status-ts-123', 'error', expect.any(String)
      );
      expect(deps.reactionManager.updateReaction).toHaveBeenCalledWith('sk', 'x');
      expect(deps.assistantStatusManager.clearStatus).toHaveBeenCalledWith('C123', 'ts123');
    });
  });

  describe('onText() / onThinking()', () => {
    it('are pass-through (no errors)', async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_DETAIL,
      });

      // Should not throw
      await renderer.onText('hello');
      await renderer.onThinking('reasoning...');
    });
  });

  describe('onStatusChange()', () => {
    beforeEach(async () => {
      await renderer.start({
        channel: 'C123',
        threadTs: 'ts123',
        sessionKey: 'sk',
        verbosityMask: LOG_DETAIL,
      });
    });

    it('updates both status message and reaction', async () => {
      await renderer.onStatusChange('working');

      expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
        'C123', 'status-ts-123', 'working', expect.any(String)
      );
      expect(deps.reactionManager.updateReaction).toHaveBeenCalledWith('sk', 'gear');
    });
  });
});
