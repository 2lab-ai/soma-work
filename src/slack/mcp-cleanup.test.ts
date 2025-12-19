import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MCP Status Cleanup Tests
 *
 * These tests verify that MCP tracking state is properly cleaned up:
 * 1. toolUseIdToName map is cleared on abort/completion
 * 2. toolUseIdToCallId map is cleared on abort/completion
 * 3. McpStatusDisplay intervals are stopped on abort
 * 4. Status messages are updated to show cancellation/completion
 */

// Mock the tool tracking behavior from SlackHandler
class MockToolTracker {
  private toolUseIdToName: Map<string, string> = new Map();
  private toolUseIdToCallId: Map<string, string> = new Map();

  trackToolUse(toolUseId: string, toolName: string): void {
    this.toolUseIdToName.set(toolUseId, toolName);
  }

  trackMcpCall(toolUseId: string, callId: string): void {
    this.toolUseIdToCallId.set(toolUseId, callId);
  }

  getToolName(toolUseId: string): string | undefined {
    return this.toolUseIdToName.get(toolUseId);
  }

  getMcpCallId(toolUseId: string): string | undefined {
    return this.toolUseIdToCallId.get(toolUseId);
  }

  removeMcpCallId(toolUseId: string): void {
    this.toolUseIdToCallId.delete(toolUseId);
  }

  cleanup(): void {
    this.toolUseIdToName.clear();
    this.toolUseIdToCallId.clear();
  }

  getToolUseCount(): number {
    return this.toolUseIdToName.size;
  }

  getMcpCallCount(): number {
    return this.toolUseIdToCallId.size;
  }

  // For testing scheduled cleanup
  scheduleCleanup(delayMs: number, callback?: () => void): NodeJS.Timeout {
    return setTimeout(() => {
      this.cleanup();
      callback?.();
    }, delayMs);
  }
}

// Mock MCP Status Display
class MockMcpStatusDisplay {
  private statusIntervals: Map<string, NodeJS.Timeout> = new Map();
  private statusMessages: Map<string, { channel: string; ts: string; serverName: string; toolName: string }> = new Map();
  private updateCount: Map<string, number> = new Map();

  startStatusUpdate(
    callId: string,
    serverName: string,
    toolName: string,
    channel: string,
    threadTs: string
  ): void {
    // Store status message info
    this.statusMessages.set(callId, {
      channel,
      ts: threadTs,
      serverName,
      toolName,
    });

    // Start interval (simulated with 100ms for testing)
    const interval = setInterval(() => {
      const count = this.updateCount.get(callId) || 0;
      this.updateCount.set(callId, count + 1);
    }, 100);

    this.statusIntervals.set(callId, interval);
  }

  async stopStatusUpdate(callId: string, duration?: number | null): Promise<void> {
    // Stop interval
    const timer = this.statusIntervals.get(callId);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.statusIntervals.delete(callId);
    }

    // Remove status message info
    this.statusMessages.delete(callId);
    this.updateCount.delete(callId);
  }

  isTracking(callId: string): boolean {
    return this.statusIntervals.has(callId);
  }

  getActiveCount(): number {
    return this.statusIntervals.size;
  }

  getUpdateCount(callId: string): number {
    return this.updateCount.get(callId) || 0;
  }

  hasStatusMessage(callId: string): boolean {
    return this.statusMessages.has(callId);
  }

  // Stop all tracking (for cleanup)
  stopAll(): void {
    for (const [callId, timer] of this.statusIntervals) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.statusIntervals.clear();
    this.statusMessages.clear();
    this.updateCount.clear();
  }
}

// Mock MCP Call Tracker
class MockMcpCallTracker {
  private activeCalls: Map<string, { startTime: number; serverName: string; toolName: string }> = new Map();

  startCall(serverName: string, toolName: string): string {
    const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.activeCalls.set(callId, {
      startTime: Date.now(),
      serverName,
      toolName,
    });
    return callId;
  }

  endCall(callId: string): number | null {
    const call = this.activeCalls.get(callId);
    if (!call) return null;

    const duration = Date.now() - call.startTime;
    this.activeCalls.delete(callId);
    return duration;
  }

  isCallActive(callId: string): boolean {
    return this.activeCalls.has(callId);
  }

  getActiveCallCount(): number {
    return this.activeCalls.size;
  }
}

describe('MCP Status Cleanup', () => {
  let toolTracker: MockToolTracker;
  let mcpStatusDisplay: MockMcpStatusDisplay;
  let mcpCallTracker: MockMcpCallTracker;

  beforeEach(() => {
    toolTracker = new MockToolTracker();
    mcpStatusDisplay = new MockMcpStatusDisplay();
    mcpCallTracker = new MockMcpCallTracker();
  });

  afterEach(() => {
    mcpStatusDisplay.stopAll();
  });

  describe('Tool Tracking Cleanup', () => {
    it('should track tool use with ID and name', () => {
      const toolUseId = 'tu_123';
      const toolName = 'mcp__github__create_issue';

      toolTracker.trackToolUse(toolUseId, toolName);

      expect(toolTracker.getToolName(toolUseId)).toBe(toolName);
      expect(toolTracker.getToolUseCount()).toBe(1);
    });

    it('should track MCP call ID for tool use', () => {
      const toolUseId = 'tu_123';
      const callId = 'call_456';

      toolTracker.trackMcpCall(toolUseId, callId);

      expect(toolTracker.getMcpCallId(toolUseId)).toBe(callId);
      expect(toolTracker.getMcpCallCount()).toBe(1);
    });

    it('should clear all tracking on cleanup', () => {
      // Track multiple tools
      toolTracker.trackToolUse('tu_1', 'tool_1');
      toolTracker.trackToolUse('tu_2', 'tool_2');
      toolTracker.trackMcpCall('tu_1', 'call_1');
      toolTracker.trackMcpCall('tu_2', 'call_2');

      expect(toolTracker.getToolUseCount()).toBe(2);
      expect(toolTracker.getMcpCallCount()).toBe(2);

      toolTracker.cleanup();

      expect(toolTracker.getToolUseCount()).toBe(0);
      expect(toolTracker.getMcpCallCount()).toBe(0);
    });

    it('should remove individual MCP call ID on tool result', () => {
      const toolUseId = 'tu_123';
      const callId = 'call_456';

      toolTracker.trackToolUse(toolUseId, 'mcp__github__create_issue');
      toolTracker.trackMcpCall(toolUseId, callId);

      expect(toolTracker.getMcpCallId(toolUseId)).toBe(callId);

      // On tool result, remove the call ID
      toolTracker.removeMcpCallId(toolUseId);

      expect(toolTracker.getMcpCallId(toolUseId)).toBeUndefined();
      // Tool name should still be tracked (for reference)
      expect(toolTracker.getToolName(toolUseId)).toBe('mcp__github__create_issue');
    });

    it('should schedule delayed cleanup', async () => {
      toolTracker.trackToolUse('tu_1', 'tool_1');
      toolTracker.trackMcpCall('tu_1', 'call_1');

      let cleanupCalled = false;
      const timer = toolTracker.scheduleCleanup(50, () => {
        cleanupCalled = true;
      });

      expect(toolTracker.getToolUseCount()).toBe(1);

      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(cleanupCalled).toBe(true);
      expect(toolTracker.getToolUseCount()).toBe(0);

      clearTimeout(timer);
    });
  });

  describe('MCP Status Display Cleanup', () => {
    it('should start status update with tracking', () => {
      const callId = 'call_123';

      mcpStatusDisplay.startStatusUpdate(callId, 'github', 'create_issue', 'C123', '111.222');

      expect(mcpStatusDisplay.isTracking(callId)).toBe(true);
      expect(mcpStatusDisplay.hasStatusMessage(callId)).toBe(true);
      expect(mcpStatusDisplay.getActiveCount()).toBe(1);
    });

    it('should stop status update and clear tracking', async () => {
      const callId = 'call_123';

      mcpStatusDisplay.startStatusUpdate(callId, 'github', 'create_issue', 'C123', '111.222');

      expect(mcpStatusDisplay.isTracking(callId)).toBe(true);

      await mcpStatusDisplay.stopStatusUpdate(callId, 1000);

      expect(mcpStatusDisplay.isTracking(callId)).toBe(false);
      expect(mcpStatusDisplay.hasStatusMessage(callId)).toBe(false);
    });

    it('should handle multiple concurrent MCP calls', async () => {
      const callId1 = 'call_1';
      const callId2 = 'call_2';
      const callId3 = 'call_3';

      mcpStatusDisplay.startStatusUpdate(callId1, 'github', 'create_issue', 'C123', '111.222');
      mcpStatusDisplay.startStatusUpdate(callId2, 'codex', 'search', 'C123', '111.222');
      mcpStatusDisplay.startStatusUpdate(callId3, 'filesystem', 'read', 'C123', '111.222');

      expect(mcpStatusDisplay.getActiveCount()).toBe(3);

      // Stop one
      await mcpStatusDisplay.stopStatusUpdate(callId2, 500);

      expect(mcpStatusDisplay.getActiveCount()).toBe(2);
      expect(mcpStatusDisplay.isTracking(callId1)).toBe(true);
      expect(mcpStatusDisplay.isTracking(callId2)).toBe(false);
      expect(mcpStatusDisplay.isTracking(callId3)).toBe(true);
    });

    it('should stop all tracking on abort', async () => {
      mcpStatusDisplay.startStatusUpdate('call_1', 'github', 'create_issue', 'C123', '111.222');
      mcpStatusDisplay.startStatusUpdate('call_2', 'codex', 'search', 'C123', '111.222');

      expect(mcpStatusDisplay.getActiveCount()).toBe(2);

      // Abort - stop all
      mcpStatusDisplay.stopAll();

      expect(mcpStatusDisplay.getActiveCount()).toBe(0);
    });

    it('should handle stop for non-existent call gracefully', async () => {
      // Should not throw
      await mcpStatusDisplay.stopStatusUpdate('nonexistent', 0);

      expect(mcpStatusDisplay.getActiveCount()).toBe(0);
    });
  });

  describe('MCP Call Tracker Integration', () => {
    it('should track call start and end', () => {
      const callId = mcpCallTracker.startCall('github', 'create_issue');

      expect(mcpCallTracker.isCallActive(callId)).toBe(true);
      expect(mcpCallTracker.getActiveCallCount()).toBe(1);

      const duration = mcpCallTracker.endCall(callId);

      expect(duration).toBeGreaterThanOrEqual(0);
      expect(mcpCallTracker.isCallActive(callId)).toBe(false);
      expect(mcpCallTracker.getActiveCallCount()).toBe(0);
    });

    it('should return null for unknown call end', () => {
      const duration = mcpCallTracker.endCall('unknown');
      expect(duration).toBeNull();
    });
  });

  describe('Full Cleanup Flow', () => {
    it('should cleanup all resources on request completion', async () => {
      // Simulate full tool use -> result flow
      const toolUseId = 'tu_123';
      const toolName = 'mcp__github__create_issue';

      // 1. Track tool use
      toolTracker.trackToolUse(toolUseId, toolName);

      // 2. Start MCP call
      const callId = mcpCallTracker.startCall('github', 'create_issue');
      toolTracker.trackMcpCall(toolUseId, callId);

      // 3. Start status display
      mcpStatusDisplay.startStatusUpdate(callId, 'github', 'create_issue', 'C123', '111.222');

      // Verify all tracking is active
      expect(toolTracker.getToolUseCount()).toBe(1);
      expect(toolTracker.getMcpCallCount()).toBe(1);
      expect(mcpCallTracker.isCallActive(callId)).toBe(true);
      expect(mcpStatusDisplay.isTracking(callId)).toBe(true);

      // 4. Tool result arrives - cleanup
      const duration = mcpCallTracker.endCall(callId);
      await mcpStatusDisplay.stopStatusUpdate(callId, duration);
      toolTracker.removeMcpCallId(toolUseId);

      // Verify partial cleanup
      expect(toolTracker.getMcpCallCount()).toBe(0);
      expect(mcpCallTracker.isCallActive(callId)).toBe(false);
      expect(mcpStatusDisplay.isTracking(callId)).toBe(false);
      // Tool use ID still tracked for reference
      expect(toolTracker.getToolName(toolUseId)).toBe(toolName);

      // 5. Session ends - full cleanup (after delay in real impl)
      toolTracker.cleanup();
      expect(toolTracker.getToolUseCount()).toBe(0);
    });

    it('should cleanup all resources on abort', async () => {
      // Simulate abort during tool execution
      const toolUseId = 'tu_123';
      const toolName = 'mcp__codex__search';

      // Setup tracking
      toolTracker.trackToolUse(toolUseId, toolName);
      const callId = mcpCallTracker.startCall('codex', 'search');
      toolTracker.trackMcpCall(toolUseId, callId);
      mcpStatusDisplay.startStatusUpdate(callId, 'codex', 'search', 'C123', '111.222');

      // Verify all active
      expect(mcpStatusDisplay.getActiveCount()).toBe(1);
      expect(mcpCallTracker.getActiveCallCount()).toBe(1);

      // Abort happens
      mcpStatusDisplay.stopAll();
      // In real impl, active calls would also be ended
      mcpCallTracker.endCall(callId);
      toolTracker.cleanup();

      // All should be cleaned up
      expect(mcpStatusDisplay.getActiveCount()).toBe(0);
      expect(mcpCallTracker.getActiveCallCount()).toBe(0);
      expect(toolTracker.getToolUseCount()).toBe(0);
      expect(toolTracker.getMcpCallCount()).toBe(0);
    });

    it('should handle multiple tools with partial completion', async () => {
      // Tool 1 completes, Tool 2 is aborted
      const toolUse1 = 'tu_1';
      const toolUse2 = 'tu_2';

      // Start both tools
      toolTracker.trackToolUse(toolUse1, 'mcp__github__list_issues');
      toolTracker.trackToolUse(toolUse2, 'mcp__codex__search');

      const callId1 = mcpCallTracker.startCall('github', 'list_issues');
      const callId2 = mcpCallTracker.startCall('codex', 'search');

      toolTracker.trackMcpCall(toolUse1, callId1);
      toolTracker.trackMcpCall(toolUse2, callId2);

      mcpStatusDisplay.startStatusUpdate(callId1, 'github', 'list_issues', 'C123', '111.222');
      mcpStatusDisplay.startStatusUpdate(callId2, 'codex', 'search', 'C123', '111.222');

      // Tool 1 completes normally
      const duration1 = mcpCallTracker.endCall(callId1);
      await mcpStatusDisplay.stopStatusUpdate(callId1, duration1);
      toolTracker.removeMcpCallId(toolUse1);

      expect(mcpStatusDisplay.getActiveCount()).toBe(1);
      expect(mcpCallTracker.getActiveCallCount()).toBe(1);

      // Abort happens - Tool 2 is interrupted
      mcpStatusDisplay.stopAll();
      mcpCallTracker.endCall(callId2);
      toolTracker.cleanup();

      expect(mcpStatusDisplay.getActiveCount()).toBe(0);
      expect(mcpCallTracker.getActiveCallCount()).toBe(0);
      expect(toolTracker.getToolUseCount()).toBe(0);
    });
  });
});
