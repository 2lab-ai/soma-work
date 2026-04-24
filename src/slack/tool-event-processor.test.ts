/**
 * ToolEventProcessor tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { McpCallTracker } from '../mcp-call-tracker';
import { McpStatusDisplay } from './mcp-status-tracker';
import {
  type SayFunction,
  type ToolEventContext,
  ToolEventProcessor,
  type ToolResultEvent,
  type ToolResultSink,
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

  /**
   * Tool verbose absorb (Issue #664, PHASE>=2 sink path).
   *
   * Verifies the ToolResultSink contract: at PHASE>=2 with a sink installed
   * and a `turnId` in context, `sendToolResult` routes the formatted result
   * through the sink instead of posting a separate legacy bubble via `say`.
   * Any missing precondition (PHASE<2, no sink, no turnId) OR a sink that
   * returns `false` (closing turn, Slack error) falls through to legacy
   * `say` — tool output is never silently dropped.
   */
  describe('Tool verbose absorb (PHASE>=2 sink)', () => {
    const originalPhase = config.ui.fiveBlockPhase;
    afterEach(() => {
      // Restore between cases so a test-only flip can't leak across the
      // vitest run (matches TurnSurface.phase()'s per-call read model).
      config.ui.fiveBlockPhase = originalPhase;
    });

    function makeContextWithTurn(turnId?: string): ToolEventContext {
      return { ...mockContext, turnId };
    }

    it('PHASE=0 + sink installed: legacy say fires, sink NOT called (regression)', async () => {
      config.ui.fiveBlockPhase = 0;
      const sink = vi.fn().mockResolvedValue(true) as unknown as ToolResultSink;
      processor.setToolResultSink(sink);
      toolTracker.trackToolUse('tool_1', 'Bash');

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        makeContextWithTurn('session:42:abc'),
      );

      expect(sink).not.toHaveBeenCalled();
      expect(mockSay).toHaveBeenCalledTimes(1);
    });

    it('PHASE=1 + sink installed: legacy say fires, sink NOT called (regression)', async () => {
      // P1 boundary — B1 stream is live but tool results still own their own
      // bubble. This test enforces the rollout gate so a future phase-gate
      // mistake can't silently promote tool absorb to PHASE=1.
      config.ui.fiveBlockPhase = 1;
      const sink = vi.fn().mockResolvedValue(true) as unknown as ToolResultSink;
      processor.setToolResultSink(sink);
      toolTracker.trackToolUse('tool_1', 'Bash');

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        makeContextWithTurn('session:42:abc'),
      );

      expect(sink).not.toHaveBeenCalled();
      expect(mockSay).toHaveBeenCalledTimes(1);
    });

    it('PHASE=2 + sink + turnId + sink returns true: say is NOT called (absorbed)', async () => {
      config.ui.fiveBlockPhase = 2;
      const sink = vi.fn().mockResolvedValue(true);
      processor.setToolResultSink(sink as unknown as ToolResultSink);
      toolTracker.trackToolUse('tool_1', 'Bash');

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        makeContextWithTurn('session:42:abc'),
      );

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith('session:42:abc', expect.stringContaining('Bash'));
      expect(mockSay).not.toHaveBeenCalled();
    });

    it('PHASE=2 + sink returns false (closing/stream-closed): falls back to legacy say', async () => {
      // This is the closing-race fallback: during `end()` the underlying
      // TurnSurface.appendText returns false, the sink propagates that
      // false, and we must still emit the tool bubble rather than drop it.
      config.ui.fiveBlockPhase = 2;
      const sink = vi.fn().mockResolvedValue(false);
      processor.setToolResultSink(sink as unknown as ToolResultSink);
      toolTracker.trackToolUse('tool_1', 'Bash');

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        makeContextWithTurn('session:42:abc'),
      );

      expect(sink).toHaveBeenCalledTimes(1);
      expect(mockSay).toHaveBeenCalledTimes(1);
    });

    it('PHASE=2 + NO sink installed: legacy say still fires (never silent-drop)', async () => {
      config.ui.fiveBlockPhase = 2;
      // No setToolResultSink call.
      toolTracker.trackToolUse('tool_1', 'Bash');

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        makeContextWithTurn('session:42:abc'),
      );

      expect(mockSay).toHaveBeenCalledTimes(1);
    });

    it('PHASE=2 + sink installed but NO turnId in context: falls back to legacy say', async () => {
      config.ui.fiveBlockPhase = 2;
      const sink = vi.fn().mockResolvedValue(true);
      processor.setToolResultSink(sink as unknown as ToolResultSink);
      toolTracker.trackToolUse('tool_1', 'Bash');

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        makeContextWithTurn(undefined),
      );

      expect(sink).not.toHaveBeenCalled();
      expect(mockSay).toHaveBeenCalledTimes(1);
    });

    it('setToolResultSink(null) clears the sink so legacy path resumes', async () => {
      config.ui.fiveBlockPhase = 2;
      const sink = vi.fn().mockResolvedValue(true);
      processor.setToolResultSink(sink as unknown as ToolResultSink);
      processor.setToolResultSink(null);
      toolTracker.trackToolUse('tool_1', 'Bash');

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        makeContextWithTurn('session:42:abc'),
      );

      expect(sink).not.toHaveBeenCalled();
      expect(mockSay).toHaveBeenCalledTimes(1);
    });

    it('hidden/compact render mode + PHASE=2: no sink call, no say (mode short-circuit preserved)', async () => {
      // Short-circuit invariant: `getToolResultRenderMode` returns
      // 'hidden' for mask 0 and 'compact' for LOG_COMPACT (TOOL_CALL on,
      // TOOL_RESULT off). Both bypass the bubble entirely, and the sink
      // path must inherit that invariant — absorbing tool output when
      // the user asked to hide it would be a privacy regression.
      config.ui.fiveBlockPhase = 2;
      const sink = vi.fn().mockResolvedValue(true);
      processor.setToolResultSink(sink as unknown as ToolResultSink);
      toolTracker.trackToolUse('tool_1', 'Bash');
      const hiddenCtx: ToolEventContext = { ...makeContextWithTurn('session:42:abc'), logVerbosity: 0 };

      await processor.handleToolResult(
        [{ toolUseId: 'tool_1', toolName: 'Bash', result: 'command output' }],
        hiddenCtx,
      );

      expect(sink).not.toHaveBeenCalled();
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

  /**
   * Issue #688 — Background Bash progress tracking.
   *
   * Bash({run_in_background:true}) rides the shared MCP progress
   * pipeline via the `_bash_bg` virtual server, plus an
   * AssistantStatusManager bg-counter increment so the native spinner
   * can flip to "waiting on background shell". These tests cover the
   * S7/S8/S10 acceptance rows from docs/agent-status-visibility/plan.md.
   */
  describe('Background Bash tracking (issue #688)', () => {
    function makeStatusManager() {
      const unregister = vi.fn();
      const register = vi.fn(() => unregister);
      return {
        register,
        unregister,
        manager: {
          registerBackgroundBashActive: register,
          getToolStatusText: vi.fn().mockReturnValue('is running commands...'),
          buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
          setStatus: vi.fn().mockResolvedValue(undefined),
          clearStatus: vi.fn().mockResolvedValue(undefined),
          bumpEpoch: vi.fn().mockReturnValue(1),
          isEnabled: vi.fn().mockReturnValue(true),
          setTitle: vi.fn(),
        },
      };
    }

    it('S7: Bash run_in_background=true triggers startCall + trackMcpCall + registerCall + registerBackgroundBashActive', async () => {
      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_1');
      const status = makeStatusManager();
      const p = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, status.manager as any);

      const toolUses: ToolUseEvent[] = [
        { id: 'tu_bg_1', name: 'Bash', input: { command: 'sleep 10', run_in_background: true } },
      ];

      await p.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).toHaveBeenCalledWith('_bash_bg', 'bash');
      expect(toolTracker.getMcpCallId('tu_bg_1')).toBe('call_bg_1');
      expect(status.register).toHaveBeenCalledWith('C123', 'thread_ts');
      expect(mcpStatusDisplay.registerCall).toHaveBeenCalledWith(
        'C123:thread_ts',
        'call_bg_1',
        expect.objectContaining({
          displayType: 'BashBG',
          displayLabel: '`sleep 10`',
          predictKey: { serverName: '_bash_bg', toolName: 'bash' },
        }),
        'C123',
        'thread_ts',
      );
    });

    it('foreground Bash (no run_in_background) does NOT start bg tracking (regression)', async () => {
      const status = makeStatusManager();
      const p = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, status.manager as any);

      const toolUses: ToolUseEvent[] = [{ id: 'tu_fg_1', name: 'Bash', input: { command: 'ls' } }];

      await p.handleToolUse(toolUses, mockContext);

      expect(mcpCallTracker.startCall).not.toHaveBeenCalled();
      expect(status.register).not.toHaveBeenCalled();
      expect(mcpStatusDisplay.registerCall).not.toHaveBeenCalled();
    });

    it('S8: same tool_use_id tool_result triggers registry remove + unregister + endMcpTracking', async () => {
      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_2');
      const status = makeStatusManager();
      const p = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, status.manager as any);

      await p.handleToolUse(
        [{ id: 'tu_bg_2', name: 'Bash', input: { command: 'sleep 5', run_in_background: true } }],
        mockContext,
      );

      await p.handleToolResult([{ toolUseId: 'tu_bg_2', toolName: 'Bash', result: 'started' }], mockContext);

      expect(status.unregister).toHaveBeenCalledTimes(1);
      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_bg_2');
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_bg_2', 1000);
    });

    it('S10: turn-end sweep via cleanup() drains live bg entries and unregisters each', async () => {
      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_a').mockReturnValueOnce('call_bg_b');
      const status = makeStatusManager();
      const p = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, status.manager as any);

      await p.handleToolUse(
        [
          { id: 'tu_bg_a', name: 'Bash', input: { command: 'sleep 20', run_in_background: true } },
          { id: 'tu_bg_b', name: 'Bash', input: { command: 'sleep 30', run_in_background: true } },
        ],
        mockContext,
      );

      // Simulate turn end without any tool_result arriving.
      p.cleanup('C123:thread_ts');

      expect(status.unregister).toHaveBeenCalledTimes(2);
      // completeCall for both active calls arrives from the activeMcpCallIds
      // sweep in cleanup(), not from a direct completeCall in sweep.
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_bg_a', null);
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_bg_b', null);
      expect(mcpStatusDisplay.cleanupSession).toHaveBeenCalledWith('C123:thread_ts');
    });

    it('tool_result after cleanup (already-swept) does not unregister again (idempotent)', async () => {
      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_c');
      const status = makeStatusManager();
      const p = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, status.manager as any);

      await p.handleToolUse(
        [{ id: 'tu_bg_c', name: 'Bash', input: { command: 'echo hi', run_in_background: true } }],
        mockContext,
      );

      p.cleanup('C123:thread_ts');
      expect(status.unregister).toHaveBeenCalledTimes(1);

      // late tool_result — entry is already gone from the registry, so no
      // extra unregister/counter decrement
      status.unregister.mockClear();
      await p.handleToolResult([{ toolUseId: 'tu_bg_c', toolName: 'Bash', result: 'ok' }], mockContext);
      expect(status.unregister).not.toHaveBeenCalled();
    });
  });

  // #689 P4 Part 2/2 — PHASE>=4 suppresses the MCP-specific legacy setStatus
  // call. TurnSurface takes over as the single B4 writer. At PHASE<4 the
  // legacy path must still fire (regression guard).
  describe('#689 B4 legacy suppression', () => {
    const originalPhase = config.ui.fiveBlockPhase;
    afterEach(async () => {
      config.ui.fiveBlockPhase = originalPhase;
      // Reset the module-level clamp-once flag so the disabled-mgr clamp
      // test doesn't leak state into subsequent tests. Mirrors the pattern
      // in turn-surface.test.ts (commit 1c83d5e).
      const { __resetClampEmitted } = await import('./pipeline/effective-phase');
      __resetClampEmitted();
    });

    const makeMgr = (enabled: boolean) => ({
      isEnabled: vi.fn().mockReturnValue(enabled),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      getToolStatusText: vi.fn().mockReturnValue('is calling jira...'),
    });

    it('PHASE<4: handleToolUse calls setStatus on MCP tool (legacy behaviour)', async () => {
      config.ui.fiveBlockPhase = 3;
      const mgr = makeMgr(true);
      const proc = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, mgr as any);
      await proc.handleToolUse(
        [{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { q: 't' } }],
        mockContext,
      );
      expect(mgr.setStatus).toHaveBeenCalledTimes(1);
      expect(mgr.setStatus).toHaveBeenCalledWith('C123', 'thread_ts', 'is calling jira...');
    });

    it('PHASE>=4 + enabled: handleToolUse does NOT call setStatus (TurnSurface owns)', async () => {
      config.ui.fiveBlockPhase = 4;
      const mgr = makeMgr(true);
      const proc = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, mgr as any);
      await proc.handleToolUse(
        [{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { q: 't' } }],
        mockContext,
      );
      expect(mgr.setStatus).not.toHaveBeenCalled();
    });

    it('PHASE>=4 + disabled (clamped): handleToolUse re-fires legacy setStatus (graceful fallback)', async () => {
      config.ui.fiveBlockPhase = 4;
      const mgr = makeMgr(false);
      const proc = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, mgr as any);
      await proc.handleToolUse(
        [{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { q: 't' } }],
        mockContext,
      );
      expect(mgr.setStatus).toHaveBeenCalledTimes(1);
    });
  });
});
