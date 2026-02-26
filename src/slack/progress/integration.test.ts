/**
 * Integration test: EventMapper → MessageRenderer pipeline
 *
 * Verifies that the same tool event sequence produces the same
 * mock call pattern as the pre-refactoring inline code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapToolUses, mapToolResults } from './event-mapper';
import { MessageRenderer, MessageRendererDeps } from './message-renderer';
import { LOG_DETAIL, LOG_COMPACT } from '../output-flags';

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
      createStatusMessage: vi.fn().mockResolvedValue('status-ts'),
      updateStatusDirect: vi.fn().mockResolvedValue(undefined),
      getStatusEmoji: vi.fn().mockImplementation((s: string) => s),
      getStatusMessage: vi.fn(),
      cleanup: vi.fn(),
    } as any,
    reactionManager: {
      updateReaction: vi.fn().mockResolvedValue(undefined),
    } as any,
    assistantStatusManager: {
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      getToolStatusText: vi.fn().mockReturnValue('is working...'),
      isEnabled: vi.fn().mockReturnValue(true),
    } as any,
    say: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
  };
}

describe('Progress pipeline integration', () => {
  let deps: MessageRendererDeps;
  let renderer: MessageRenderer;

  beforeEach(async () => {
    deps = createMockDeps();
    renderer = new MessageRenderer(deps);
    await renderer.start({
      channel: 'C1',
      threadTs: 'ts1',
      sessionKey: 'sk1',
      verbosityMask: LOG_DETAIL,
    });
  });

  it('full tool lifecycle: start → onToolStart → onToolComplete → finish', async () => {
    // 1. Renderer.start was called in beforeEach
    expect(deps.statusReporter.createStatusMessage).toHaveBeenCalledTimes(1);
    expect(deps.reactionManager.updateReaction).toHaveBeenCalledTimes(1);
    expect(deps.assistantStatusManager.setStatus).toHaveBeenCalledTimes(1);

    // 2. Tool use arrives
    const toolUses = [{ id: 'tu1', name: 'Read', input: { file_path: '/foo.ts' } }];
    const startEvents = mapToolUses(toolUses);
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].type).toBe('tool_start');

    for (const event of startEvents) {
      await renderer.onToolStart(event);
    }

    // Status updated to working
    expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
      'C1', 'status-ts', 'working', expect.any(String)
    );
    // ToolEventProcessor.handleToolUse called
    expect(deps.toolEventProcessor.handleToolUse).toHaveBeenCalledTimes(1);

    // 3. Tool result arrives
    const toolResults = [{ toolUseId: 'tu1', toolName: 'Read', result: 'contents' }];
    const completeEvents = mapToolResults(toolResults);
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].type).toBe('tool_complete');

    for (const event of completeEvents) {
      await renderer.onToolComplete(event);
    }

    // ToolEventProcessor.handleToolResult called
    expect(deps.toolEventProcessor.handleToolResult).toHaveBeenCalledTimes(1);

    // 4. Stream finishes
    await renderer.finish({ status: 'completed' });

    // Final status set to completed
    expect(deps.statusReporter.updateStatusDirect).toHaveBeenLastCalledWith(
      'C1', 'status-ts', 'completed', expect.any(String)
    );
    expect(deps.assistantStatusManager.clearStatus).toHaveBeenCalledWith('C1', 'ts1');
  });

  it('MCP tool lifecycle with server name parsing', async () => {
    const toolUses = [
      { id: 'tu2', name: 'mcp__github__search_repos', input: { query: 'test' } },
    ];
    const events = mapToolUses(toolUses);

    expect(events[0].serverName).toBe('github');
    expect(events[0].serverToolName).toBe('search_repos');
    expect(events[0].category).toBe('mcp');

    await renderer.onToolStart(events[0]);

    // handleToolUse was called with the original tool data
    expect(deps.toolEventProcessor.handleToolUse).toHaveBeenCalledWith(
      [{ id: 'tu2', name: 'mcp__github__search_repos', input: { query: 'test' } }],
      expect.any(Object)
    );
  });

  it('parallel MCP + subagent batch gets groupIds', async () => {
    const toolUses = [
      { id: 'tu3', name: 'mcp__jira__get_issue', input: {} },
      { id: 'tu4', name: 'Task', input: { subagent_type: 'general-purpose', prompt: 'search' } },
    ];
    const events = mapToolUses(toolUses);

    expect(events[0].groupId).toBeDefined();
    expect(events[1].groupId).toBe(events[0].groupId);
    expect(events[1].category).toBe('subagent');
    expect(events[1].subagentType).toBe('general-purpose');
  });

  it('abort sets error status', async () => {
    await renderer.abort(new Error('test'));

    expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
      'C1', 'status-ts', 'error', expect.any(String)
    );
    expect(deps.assistantStatusManager.clearStatus).toHaveBeenCalledWith('C1', 'ts1');
  });

  it('compact verbosity still shows status and reactions', async () => {
    const compactDeps = createMockDeps();
    const compactRenderer = new MessageRenderer(compactDeps);
    await compactRenderer.start({
      channel: 'C2',
      threadTs: 'ts2',
      sessionKey: 'sk2',
      verbosityMask: LOG_COMPACT,
    });

    // Status message and reactions should still be created at compact level
    expect(compactDeps.statusReporter.createStatusMessage).toHaveBeenCalled();
    expect(compactDeps.reactionManager.updateReaction).toHaveBeenCalled();
    expect(compactDeps.assistantStatusManager.setStatus).toHaveBeenCalled();
  });
});
