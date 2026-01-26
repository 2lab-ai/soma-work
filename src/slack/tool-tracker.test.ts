import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTracker } from './tool-tracker';

describe('ToolTracker', () => {
  let tracker: ToolTracker;

  beforeEach(() => {
    tracker = new ToolTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    tracker.cancelScheduledCleanup();
    vi.useRealTimers();
  });

  describe('tool use tracking', () => {
    it('should track tool use with ID and name', () => {
      const toolUseId = 'tu_123';
      const toolName = 'mcp__github__create_issue';

      tracker.trackToolUse(toolUseId, toolName);

      expect(tracker.getToolName(toolUseId)).toBe(toolName);
    });

    it('should return undefined for non-tracked tool', () => {
      expect(tracker.getToolName('nonexistent')).toBeUndefined();
    });

    it('should track multiple tools', () => {
      tracker.trackToolUse('tu_1', 'tool_1');
      tracker.trackToolUse('tu_2', 'tool_2');

      expect(tracker.getToolName('tu_1')).toBe('tool_1');
      expect(tracker.getToolName('tu_2')).toBe('tool_2');
      expect(tracker.getToolUseCount()).toBe(2);
    });
  });

  describe('MCP call tracking', () => {
    it('should track MCP call ID', () => {
      const toolUseId = 'tu_123';
      const callId = 'call_456';

      tracker.trackMcpCall(toolUseId, callId);

      expect(tracker.getMcpCallId(toolUseId)).toBe(callId);
    });

    it('should return undefined for non-tracked call', () => {
      expect(tracker.getMcpCallId('nonexistent')).toBeUndefined();
    });

    it('should remove MCP call ID', () => {
      const toolUseId = 'tu_123';
      const callId = 'call_456';

      tracker.trackMcpCall(toolUseId, callId);
      tracker.removeMcpCallId(toolUseId);

      expect(tracker.getMcpCallId(toolUseId)).toBeUndefined();
    });

    it('should track multiple MCP calls', () => {
      tracker.trackMcpCall('tu_1', 'call_1');
      tracker.trackMcpCall('tu_2', 'call_2');

      expect(tracker.getMcpCallId('tu_1')).toBe('call_1');
      expect(tracker.getMcpCallId('tu_2')).toBe('call_2');
      expect(tracker.getMcpCallCount()).toBe(2);
    });
  });

  describe('active MCP calls', () => {
    it('should report if there are active MCP calls', () => {
      expect(tracker.hasActiveMcpCalls()).toBe(false);

      tracker.trackMcpCall('tu_1', 'call_1');

      expect(tracker.hasActiveMcpCalls()).toBe(true);
    });

    it('should get all active MCP call IDs', () => {
      tracker.trackMcpCall('tu_1', 'call_1');
      tracker.trackMcpCall('tu_2', 'call_2');

      const callIds = tracker.getActiveMcpCallIds();

      expect(callIds).toContain('call_1');
      expect(callIds).toContain('call_2');
      expect(callIds.length).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('should clear all tracking data', () => {
      tracker.trackToolUse('tu_1', 'tool_1');
      tracker.trackToolUse('tu_2', 'tool_2');
      tracker.trackMcpCall('tu_1', 'call_1');

      tracker.cleanup();

      expect(tracker.getToolUseCount()).toBe(0);
      expect(tracker.getMcpCallCount()).toBe(0);
    });
  });

  describe('scheduled cleanup', () => {
    it('should schedule cleanup after delay', () => {
      tracker.trackToolUse('tu_1', 'tool_1');
      tracker.trackMcpCall('tu_1', 'call_1');

      let callbackCalled = false;
      tracker.scheduleCleanup(1000, () => {
        callbackCalled = true;
      });

      // Before delay
      expect(tracker.getToolUseCount()).toBe(1);
      expect(callbackCalled).toBe(false);

      // After delay
      vi.advanceTimersByTime(1000);

      expect(tracker.getToolUseCount()).toBe(0);
      expect(callbackCalled).toBe(true);
    });

    it('should cancel scheduled cleanup', () => {
      tracker.trackToolUse('tu_1', 'tool_1');

      tracker.scheduleCleanup(1000);
      tracker.cancelScheduledCleanup();

      vi.advanceTimersByTime(1000);

      // Data should still be there
      expect(tracker.getToolUseCount()).toBe(1);
    });

    it('should replace previous scheduled cleanup', () => {
      tracker.trackToolUse('tu_1', 'tool_1');

      let firstCallback = false;
      let secondCallback = false;

      tracker.scheduleCleanup(1000, () => {
        firstCallback = true;
      });

      tracker.scheduleCleanup(2000, () => {
        secondCallback = true;
      });

      vi.advanceTimersByTime(1000);
      expect(firstCallback).toBe(false);
      expect(tracker.getToolUseCount()).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(secondCallback).toBe(true);
      expect(tracker.getToolUseCount()).toBe(0);
    });

    it('should cancel scheduled cleanup on immediate cleanup', () => {
      tracker.trackToolUse('tu_1', 'tool_1');

      let callbackCalled = false;
      tracker.scheduleCleanup(1000, () => {
        callbackCalled = true;
      });

      // Immediate cleanup should cancel scheduled
      tracker.cleanup();

      vi.advanceTimersByTime(1000);

      expect(callbackCalled).toBe(false);
    });
  });
});
