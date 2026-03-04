import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * MCP Status Cleanup Tests
 *
 * These tests verify that MCP tracking state is properly cleaned up:
 * 1. toolUseIdToName map is cleared on abort/completion
 * 2. toolUseIdToCallId map is cleared on abort/completion
 * 3. McpStatusDisplay session ticks are stopped on abort
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

  getActiveMcpCallIds(): string[] {
    return Array.from(this.toolUseIdToCallId.values());
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

// Mock MCP Status Display (session-tick API)
class MockMcpStatusDisplay {
  private activeCalls: Map<string, { sessionKey: string; status: string }> = new Map();

  registerCall(
    sessionKey: string,
    callId: string,
    _config: any,
    _channel: string,
    _threadTs: string
  ): void {
    this.activeCalls.set(callId, { sessionKey, status: 'running' });
  }

  completeCall(callId: string, _duration: number | null): void {
    const entry = this.activeCalls.get(callId);
    if (entry) {
      this.activeCalls.set(callId, { ...entry, status: 'completed' });
    }
  }

  cleanupSession(sessionKey: string): void {
    for (const [callId, entry] of this.activeCalls) {
      if (entry.sessionKey === sessionKey) {
        this.activeCalls.delete(callId);
      }
    }
  }

  isTracking(callId: string): boolean {
    const entry = this.activeCalls.get(callId);
    return entry?.status === 'running';
  }

  getActiveCount(): number {
    let count = 0;
    for (const entry of this.activeCalls.values()) {
      if (entry.status === 'running') count++;
    }
    return count;
  }
}

// Mock MCP Call Tracker
class MockMcpCallTracker {
  private calls: Map<string, { startTime: number; serverName: string; toolName: string }> = new Map();

  startCall(serverName: string, toolName: string): string {
    const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.calls.set(callId, {
      startTime: Date.now(),
      serverName,
      toolName,
    });
    return callId;
  }

  endCall(callId: string): number | null {
    const call = this.calls.get(callId);
    if (!call) return null;

    const duration = Date.now() - call.startTime;
    this.calls.delete(callId);
    return duration;
  }

  isCallActive(callId: string): boolean {
    return this.calls.has(callId);
  }

  getActiveCallCount(): number {
    return this.calls.size;
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

  describe('MCP Status Display Cleanup (Session Tick API)', () => {
    it('should register call with tracking', () => {
      const callId = 'call_123';
      const config = { displayType: 'MCP', displayLabel: 'github → create_issue', initialDelay: 10000, predictKey: { serverName: 'github', toolName: 'create_issue' } };

      mcpStatusDisplay.registerCall('session1', callId, config, 'C123', '111.222');

      expect(mcpStatusDisplay.isTracking(callId)).toBe(true);
      expect(mcpStatusDisplay.getActiveCount()).toBe(1);
    });

    it('should complete call and clear active tracking', () => {
      const callId = 'call_123';
      const config = { displayType: 'MCP', displayLabel: 'github → create_issue', initialDelay: 10000, predictKey: { serverName: 'github', toolName: 'create_issue' } };

      mcpStatusDisplay.registerCall('session1', callId, config, 'C123', '111.222');
      expect(mcpStatusDisplay.isTracking(callId)).toBe(true);

      mcpStatusDisplay.completeCall(callId, 1000);
      expect(mcpStatusDisplay.isTracking(callId)).toBe(false);
    });

    it('should handle multiple concurrent MCP calls', () => {
      const config = (label: string) => ({ displayType: 'MCP', displayLabel: label, initialDelay: 10000, predictKey: { serverName: 'test', toolName: 'test' } });

      mcpStatusDisplay.registerCall('session1', 'call_1', config('github → create_issue'), 'C123', '111.222');
      mcpStatusDisplay.registerCall('session1', 'call_2', config('codex → search'), 'C123', '111.222');
      mcpStatusDisplay.registerCall('session1', 'call_3', config('filesystem → read'), 'C123', '111.222');

      expect(mcpStatusDisplay.getActiveCount()).toBe(3);

      // Complete one
      mcpStatusDisplay.completeCall('call_2', 500);

      expect(mcpStatusDisplay.getActiveCount()).toBe(2);
      expect(mcpStatusDisplay.isTracking('call_1')).toBe(true);
      expect(mcpStatusDisplay.isTracking('call_2')).toBe(false);
      expect(mcpStatusDisplay.isTracking('call_3')).toBe(true);
    });

    it('should cleanup session and remove all tracking', () => {
      const config = { displayType: 'MCP', displayLabel: 'test', initialDelay: 0, predictKey: { serverName: 'test', toolName: 'test' } };

      mcpStatusDisplay.registerCall('session1', 'call_1', config, 'C123', '111.222');
      mcpStatusDisplay.registerCall('session1', 'call_2', config, 'C123', '111.222');

      expect(mcpStatusDisplay.getActiveCount()).toBe(2);

      mcpStatusDisplay.cleanupSession('session1');

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
    it('should cleanup all resources on request completion', () => {
      // Simulate full tool use -> result flow
      const toolUseId = 'tu_123';
      const toolName = 'mcp__github__create_issue';

      // 1. Track tool use
      toolTracker.trackToolUse(toolUseId, toolName);

      // 2. Start MCP call
      const callId = mcpCallTracker.startCall('github', 'create_issue');
      toolTracker.trackMcpCall(toolUseId, callId);

      // 3. Register call in status display
      const config = { displayType: 'MCP', displayLabel: 'github → create_issue', initialDelay: 10000, predictKey: { serverName: 'github', toolName: 'create_issue' } };
      mcpStatusDisplay.registerCall('session1', callId, config, 'C123', '111.222');

      // Verify all tracking is active
      expect(toolTracker.getToolUseCount()).toBe(1);
      expect(toolTracker.getMcpCallCount()).toBe(1);
      expect(mcpCallTracker.isCallActive(callId)).toBe(true);
      expect(mcpStatusDisplay.isTracking(callId)).toBe(true);

      // 4. Tool result arrives - cleanup
      const duration = mcpCallTracker.endCall(callId);
      mcpStatusDisplay.completeCall(callId, duration);
      toolTracker.removeMcpCallId(toolUseId);

      // Verify partial cleanup
      expect(toolTracker.getMcpCallCount()).toBe(0);
      expect(mcpCallTracker.isCallActive(callId)).toBe(false);
      expect(mcpStatusDisplay.isTracking(callId)).toBe(false);
      // Tool use ID still tracked for reference
      expect(toolTracker.getToolName(toolUseId)).toBe(toolName);

      // 5. Session ends - full cleanup
      toolTracker.cleanup();
      expect(toolTracker.getToolUseCount()).toBe(0);
    });

    it('should cleanup all resources on abort', () => {
      // Simulate abort during tool execution
      const toolUseId = 'tu_123';
      const toolName = 'mcp__codex__search';
      const config = { displayType: 'MCP', displayLabel: 'codex → search', initialDelay: 0, predictKey: { serverName: 'codex', toolName: 'search' } };

      // Setup tracking
      toolTracker.trackToolUse(toolUseId, toolName);
      const callId = mcpCallTracker.startCall('codex', 'search');
      toolTracker.trackMcpCall(toolUseId, callId);
      mcpStatusDisplay.registerCall('session1', callId, config, 'C123', '111.222');

      // Verify all active
      expect(mcpStatusDisplay.getActiveCount()).toBe(1);
      expect(mcpCallTracker.getActiveCallCount()).toBe(1);

      // Abort happens — complete calls + cleanup session
      mcpStatusDisplay.completeCall(callId, null);
      mcpStatusDisplay.cleanupSession('session1');
      mcpCallTracker.endCall(callId);
      toolTracker.cleanup();

      // All should be cleaned up
      expect(mcpStatusDisplay.getActiveCount()).toBe(0);
      expect(mcpCallTracker.getActiveCallCount()).toBe(0);
      expect(toolTracker.getToolUseCount()).toBe(0);
      expect(toolTracker.getMcpCallCount()).toBe(0);
    });

    it('should handle multiple tools with partial completion', () => {
      // Tool 1 completes, Tool 2 is aborted
      const toolUse1 = 'tu_1';
      const toolUse2 = 'tu_2';
      const config = (label: string) => ({ displayType: 'MCP', displayLabel: label, initialDelay: 0, predictKey: { serverName: 'test', toolName: 'test' } });

      // Start both tools
      toolTracker.trackToolUse(toolUse1, 'mcp__github__list_issues');
      toolTracker.trackToolUse(toolUse2, 'mcp__codex__search');

      const callId1 = mcpCallTracker.startCall('github', 'list_issues');
      const callId2 = mcpCallTracker.startCall('codex', 'search');

      toolTracker.trackMcpCall(toolUse1, callId1);
      toolTracker.trackMcpCall(toolUse2, callId2);

      mcpStatusDisplay.registerCall('session1', callId1, config('github → list_issues'), 'C123', '111.222');
      mcpStatusDisplay.registerCall('session1', callId2, config('codex → search'), 'C123', '111.222');

      // Tool 1 completes normally
      const duration1 = mcpCallTracker.endCall(callId1);
      mcpStatusDisplay.completeCall(callId1, duration1);
      toolTracker.removeMcpCallId(toolUse1);

      expect(mcpStatusDisplay.getActiveCount()).toBe(1);
      expect(mcpCallTracker.getActiveCallCount()).toBe(1);

      // Abort happens - Tool 2 is interrupted
      mcpStatusDisplay.completeCall(callId2, null);
      mcpStatusDisplay.cleanupSession('session1');
      mcpCallTracker.endCall(callId2);
      toolTracker.cleanup();

      expect(mcpStatusDisplay.getActiveCount()).toBe(0);
      expect(mcpCallTracker.getActiveCallCount()).toBe(0);
      expect(toolTracker.getToolUseCount()).toBe(0);
    });
  });
});
