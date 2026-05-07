/**
 * ToolEventProcessor tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { McpCallTracker } from '../../mcp-call-tracker';
import { McpStatusDisplay } from '../mcp-status-tracker';
import {
  type SayFunction,
  type ToolEventContext,
  ToolEventProcessor,
  type ToolResultEvent,
  type ToolResultSink,
  type ToolUseEvent,
} from '../tool-event-processor';
import { ToolTracker } from '../tool-tracker';

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
      // Issue #794 — async final-render fence. Mock returns immediately
      // so cleanup tests don't hang on a real Promise.
      flushSession: vi.fn().mockResolvedValue(undefined),
    };
    mcpCallTracker = {
      startCall: vi.fn().mockReturnValue('call_123'),
      endCall: vi.fn().mockReturnValue(1000),
      getElapsedTime: vi.fn().mockReturnValue(750),
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
    it('should call flushSession on mcpStatusDisplay (issue #794)', async () => {
      await processor.cleanup('C123:thread_ts');

      // Issue #794 — `flushSession` is the awaitable final-render fence.
      expect(mcpStatusDisplay.flushSession).toHaveBeenCalledWith('C123:thread_ts');
      expect(mcpStatusDisplay.cleanupSession).not.toHaveBeenCalled();
    });

    it('should fall back to cleanupSession when flushSession throws', async () => {
      // flushSession does Slack I/O; on failure cleanup must still tear
      // down the session tick synchronously so timers don't leak.
      mcpStatusDisplay.flushSession.mockRejectedValueOnce(new Error('slack down'));

      await processor.cleanup('C123:thread_ts');

      expect(mcpStatusDisplay.flushSession).toHaveBeenCalledWith('C123:thread_ts');
      expect(mcpStatusDisplay.cleanupSession).toHaveBeenCalledWith('C123:thread_ts');
    });

    it('should complete active MCP calls before cleanup (legacy global sweep, no turnId)', async () => {
      // Track active MCP calls
      toolTracker.trackToolUse('tool_1', 'mcp__codex__search');
      toolTracker.trackMcpCall('tool_1', 'call_1');
      toolTracker.trackToolUse('tool_2', 'mcp__jira__search');
      toolTracker.trackMcpCall('tool_2', 'call_2');

      // No turnId provided → legacy `getActiveMcpCallIds` sweep path.
      await processor.cleanup('C123:thread_ts');

      // Should complete active calls
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_1', null);
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_2', null);
      // Then flush session (issue #794 await fence)
      expect(mcpStatusDisplay.flushSession).toHaveBeenCalledWith('C123:thread_ts');
    });

    it('should not throw without sessionKey', async () => {
      await expect(processor.cleanup()).resolves.not.toThrow();
    });
  });

  /**
   * Issue #794 — Subagent (Task) progress visibility in minimal mode.
   *
   * Three independent surfaces drive these tests:
   *   1. `BackgroundTaskRegistry` — turn-scoped registry of live
   *      `Task({run_in_background:true})` calls. Defends against
   *      same-session turn replacement (cf. session-initializer:1138).
   *   2. `isBackgroundTaskSpawnAck` — the bg Task tool_result that
   *      arrives within ~1s with `task_id: …` is a spawn-ack, NOT a
   *      completion. Suppress `endMcpTracking` so the progress UI
   *      survives until turn end.
   *   3. `cleanup(sessionKey, turnId)` — async, turn-scoped:
   *      drains bg Task entries, sweeps callIds for THIS turn only,
   *      then awaits `flushSession` for the final consolidated render.
   */
  describe('Subagent progress in minimal mode (issue #794)', () => {
    function makeBgTaskInput(prompt = 'do something long') {
      return {
        subagent_type: 'general-purpose',
        prompt,
        run_in_background: true,
      };
    }
    function makeFgTaskInput(prompt = 'do something fast') {
      return {
        subagent_type: 'general-purpose',
        prompt,
      };
    }

    // S15b — bg Task: `Subagent (bg)` displayType + registry add.
    it('S15b: startSubagentTracking({run_in_background:true}) → displayType "Subagent (bg)"', async () => {
      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      await processor.handleToolUse([{ id: 'tu_bg_subagent', name: 'Task', input: makeBgTaskInput() }], ctx);

      expect(mcpStatusDisplay.registerCall).toHaveBeenCalledWith(
        'C123:thread_ts',
        'call_123',
        expect.objectContaining({ displayType: 'Subagent (bg)' }),
        'C123',
        'thread_ts',
      );
    });

    // S15c — fg Task: legacy `Subagent` displayType.
    it('S15c: startSubagentTracking({run_in_background:false}) → displayType "Subagent"', async () => {
      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      await processor.handleToolUse([{ id: 'tu_fg_subagent', name: 'Task', input: makeFgTaskInput() }], ctx);

      expect(mcpStatusDisplay.registerCall).toHaveBeenCalledWith(
        'C123:thread_ts',
        'call_123',
        expect.objectContaining({ displayType: 'Subagent' }),
        'C123',
        'thread_ts',
      );
    });

    // S13 — bg Task spawn-ack: keeps progress UI alive.
    it('S13: bg Task spawn-ack tool_result → endMcpTracking SKIPPED + onCompactDurationUpdate fired', async () => {
      const compactCb = vi.fn().mockResolvedValue(undefined);
      processor.setCompactDurationCallback(compactCb);

      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      await processor.handleToolUse([{ id: 'tu_bg_ack', name: 'Task', input: makeBgTaskInput() }], ctx);

      // Reset the call mock so we can isolate the result-handling effect.
      mcpCallTracker.endCall.mockClear();
      mcpStatusDisplay.completeCall.mockClear();

      const spawnAckText = 'Task started in background. output_file: /tmp/x.json task_id: abc-123-def';
      await processor.handleToolResult(
        [{ toolUseId: 'tu_bg_ack', toolName: 'Task', result: spawnAckText, isError: false }],
        ctx,
      );

      // Progress UI must survive — no endMcpTracking.
      expect(mcpCallTracker.endCall).not.toHaveBeenCalled();
      expect(mcpStatusDisplay.completeCall).not.toHaveBeenCalled();
      // Compact one-line still closes via onCompactDurationUpdate.
      // Pin the elapsed value (mock returns 750) so a future drift of
      // `getElapsedTime` plumbing can't silently zero/null this field.
      expect(mcpCallTracker.getElapsedTime).toHaveBeenCalledWith('call_123');
      expect(compactCb).toHaveBeenCalledWith('tu_bg_ack', 750, 'C123');
    });

    // S13b — same spawn-ack semantics, but with the SDK's array
    // tool_result shape ([{type:'text', text:'…task_id: …'}]). The
    // Anthropic SDK returns this shape from real Task calls; a string-
    // only test would let an extractTaskIdFromResult regression on the
    // array branch slip past. (Issue #794.)
    it('S13b: bg Task spawn-ack tool_result (array shape) → endMcpTracking SKIPPED + compactCb fired', async () => {
      const compactCb = vi.fn().mockResolvedValue(undefined);
      processor.setCompactDurationCallback(compactCb);

      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      await processor.handleToolUse([{ id: 'tu_bg_ack_arr', name: 'Task', input: makeBgTaskInput() }], ctx);

      mcpCallTracker.endCall.mockClear();
      mcpStatusDisplay.completeCall.mockClear();

      await processor.handleToolResult(
        [
          {
            toolUseId: 'tu_bg_ack_arr',
            toolName: 'Task',
            result: [{ type: 'text', text: 'Task started in background. task_id: abc-123' }],
            isError: false,
          },
        ],
        ctx,
      );

      expect(mcpCallTracker.endCall).not.toHaveBeenCalled();
      expect(mcpStatusDisplay.completeCall).not.toHaveBeenCalled();
      expect(compactCb).toHaveBeenCalledWith('tu_bg_ack_arr', 750, 'C123');
    });

    // S14 — bg Task error result: normal close (no special-case).
    it('S14: bg Task error tool_result → falls through to endMcpTracking + sendToolResult', async () => {
      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      await processor.handleToolUse([{ id: 'tu_bg_err', name: 'Task', input: makeBgTaskInput() }], ctx);

      mcpCallTracker.endCall.mockClear();
      mcpStatusDisplay.completeCall.mockClear();

      // Even with `task_id` text, isError=true is a real failure: close normally.
      await processor.handleToolResult(
        [
          {
            toolUseId: 'tu_bg_err',
            toolName: 'Task',
            result: 'Failed to spawn: subagent panic. task_id: nope',
            isError: true,
          },
        ],
        ctx,
      );

      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_123');
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_123', 1000);
    });

    // S14b — bg Task non-ack result without `task_id`: normal close too.
    it('S14b: bg Task result without task_id marker → endMcpTracking fires', async () => {
      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      await processor.handleToolUse([{ id: 'tu_bg_no_id', name: 'Task', input: makeBgTaskInput() }], ctx);

      mcpCallTracker.endCall.mockClear();

      await processor.handleToolResult(
        [{ toolUseId: 'tu_bg_no_id', toolName: 'Task', result: 'no marker here', isError: false }],
        ctx,
      );

      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_123');
    });

    // S15 — async cleanup with bg Task: drain registry + flushSession.
    it('S15: cleanup(sessionKey, turnId) drains bg Task → endMcpTracking + flushSession awaited', async () => {
      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_task');
      await processor.handleToolUse([{ id: 'tu_bg_drain', name: 'Task', input: makeBgTaskInput() }], ctx);

      mcpCallTracker.endCall.mockClear();
      mcpStatusDisplay.flushSession.mockClear();

      // Turn ends with the bg Task still alive — cleanup must drain it.
      await processor.cleanup('C123:thread_ts', 'C123:1:turn-A');

      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_bg_task');
      expect(mcpStatusDisplay.flushSession).toHaveBeenCalledWith('C123:thread_ts');
      // Ordering pin (issue #794) — flushSession MUST run AFTER endCall so
      // the final render reflects the bg Task's `completed` flip. A drift
      // here would re-introduce the "stuck running" symptom.
      expect(mcpStatusDisplay.flushSession.mock.invocationCallOrder[0]).toBeGreaterThan(
        mcpCallTracker.endCall.mock.invocationCallOrder[0],
      );
    });

    // S15-bis — same-session, two turns: cleanup(turn1) leaves turn2 callIds alone.
    it('S15-bis: cleanup(turn1) does NOT complete callIds registered under turn2 (callIdsByTurn)', async () => {
      // turn1 — register one MCP call.
      mcpCallTracker.startCall.mockReturnValueOnce('call_turn1');
      const ctxTurn1: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-1' };
      await processor.handleToolUse([{ id: 'tu_turn1', name: 'mcp__codex__search', input: { q: 't' } }], ctxTurn1);

      // turn2 — same session, register another MCP call BEFORE turn1 cleans up.
      mcpCallTracker.startCall.mockReturnValueOnce('call_turn2');
      const ctxTurn2: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-2' };
      await processor.handleToolUse([{ id: 'tu_turn2', name: 'mcp__codex__search', input: { q: 't' } }], ctxTurn2);

      mcpStatusDisplay.completeCall.mockClear();

      // turn1's cleanup arrives — must touch only turn1's callId.
      await processor.cleanup('C123:thread_ts', 'C123:1:turn-1');

      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_turn1', null);
      expect(mcpStatusDisplay.completeCall).not.toHaveBeenCalledWith('call_turn2', null);
    });

    // S15-tri — same-session, two turns: cleanup(turn1) leaves turn2 bg Task alone.
    it('S15-tri: cleanup(turn1) does NOT drain turn2 background Task entries', async () => {
      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_t1');
      const ctxTurn1: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-1' };
      await processor.handleToolUse(
        [{ id: 'tu_bg_t1', name: 'Task', input: makeBgTaskInput('turn-1 task') }],
        ctxTurn1,
      );

      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_t2');
      const ctxTurn2: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-2' };
      await processor.handleToolUse(
        [{ id: 'tu_bg_t2', name: 'Task', input: makeBgTaskInput('turn-2 task') }],
        ctxTurn2,
      );

      mcpCallTracker.endCall.mockClear();

      // turn1 cleanup — drain turn1 entry only.
      await processor.cleanup('C123:thread_ts', 'C123:1:turn-1');

      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_bg_t1');
      expect(mcpCallTracker.endCall).not.toHaveBeenCalledWith('call_bg_t2');
    });

    // Foreground Task spawn-ack-shaped result still closes normally.
    it('foreground Task with task_id-shaped result still ends tracking (NOT a spawn-ack)', async () => {
      const ctx: ToolEventContext = { ...mockContext, turnId: 'C123:1:turn-A' };
      await processor.handleToolUse([{ id: 'tu_fg_task', name: 'Task', input: makeFgTaskInput() }], ctx);

      mcpCallTracker.endCall.mockClear();

      await processor.handleToolResult(
        [
          {
            toolUseId: 'tu_fg_task',
            toolName: 'Task',
            result: 'something with task_id: abc',
            isError: false,
          },
        ],
        ctx,
      );

      // No registry entry → not a spawn-ack → normal close.
      expect(mcpCallTracker.endCall).toHaveBeenCalledWith('call_123');
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

      // Simulate turn end without any tool_result arriving. Issue #794
      // — `cleanup` is async; await it so the awaitable bg drain and
      // flushSession both finish before assertions run.
      await p.cleanup('C123:thread_ts');

      expect(status.unregister).toHaveBeenCalledTimes(2);
      // completeCall for both active calls arrives from the activeMcpCallIds
      // sweep in cleanup() (legacy fallback when no turnId is provided).
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_bg_a', null);
      expect(mcpStatusDisplay.completeCall).toHaveBeenCalledWith('call_bg_b', null);
      // Issue #794 — final-render fence is `flushSession`, not the legacy
      // `cleanupSession`. The mock provides `flushSession` so the
      // feature-detect branch picks it.
      expect(mcpStatusDisplay.flushSession).toHaveBeenCalledWith('C123:thread_ts');
    });

    it('tool_result after cleanup (already-swept) does not unregister again (idempotent)', async () => {
      mcpCallTracker.startCall.mockReturnValueOnce('call_bg_c');
      const status = makeStatusManager();
      const p = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, status.manager as any);

      await p.handleToolUse(
        [{ id: 'tu_bg_c', name: 'Bash', input: { command: 'echo hi', run_in_background: true } }],
        mockContext,
      );

      await p.cleanup('C123:thread_ts');
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
      const { __resetClampEmitted } = await import('../pipeline/effective-phase');
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
      await proc.handleToolUse([{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { q: 't' } }], mockContext);
      expect(mgr.setStatus).toHaveBeenCalledTimes(1);
      expect(mgr.setStatus).toHaveBeenCalledWith('C123', 'thread_ts', 'is calling jira...');
    });

    it('PHASE>=4 + enabled: handleToolUse does NOT call setStatus (TurnSurface owns)', async () => {
      config.ui.fiveBlockPhase = 4;
      const mgr = makeMgr(true);
      const proc = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, mgr as any);
      await proc.handleToolUse([{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { q: 't' } }], mockContext);
      expect(mgr.setStatus).not.toHaveBeenCalled();
    });

    it('PHASE>=4 + disabled (clamped): handleToolUse re-fires legacy setStatus (graceful fallback)', async () => {
      config.ui.fiveBlockPhase = 4;
      const mgr = makeMgr(false);
      const proc = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, mgr as any);
      await proc.handleToolUse([{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { q: 't' } }], mockContext);
      expect(mgr.setStatus).toHaveBeenCalledTimes(1);
    });

    // #700 round-3 review finding #8 — getToolStatusText returning undefined
    // must NEVER surface as setStatus('') — which reroutes to clearStatus
    // internally and would wipe the spinner mid-tool. Lock the defensive
    // skip so a future bug (TOOL_STATUS_MAP becoming Partial, serverName
    // resolution change) cannot silently regress into a clear.
    it('getToolStatusText returns undefined: setStatus is NOT called with empty string', async () => {
      config.ui.fiveBlockPhase = 3;
      const mgr = {
        isEnabled: vi.fn().mockReturnValue(true),
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        getToolStatusText: vi.fn().mockReturnValue(undefined),
      };
      const proc = new ToolEventProcessor(toolTracker, mcpStatusDisplay, mcpCallTracker, mgr as any);

      await proc.handleToolUse([{ id: 'tool_1', name: 'mcp__jira__search_issues', input: { q: 't' } }], mockContext);

      // Either setStatus was not called, or it was called with a defined
      // non-empty string. NEVER with '' — that reroutes to clearStatus.
      const emptyCalls = mgr.setStatus.mock.calls.filter(([, , text]) => text === '' || text == null);
      expect(emptyCalls.length).toBe(0);
    });
  });
});
