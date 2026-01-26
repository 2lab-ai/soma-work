import { Logger } from '../logger';

/**
 * Tracks tool usage and MCP call mappings for a session.
 *
 * Responsibilities:
 * - Track tool_use_id to tool_name mappings
 * - Track tool_use_id to MCP call_id mappings
 * - Handle cleanup on session end
 */
export class ToolTracker {
  private logger = new Logger('ToolTracker');
  private toolUseIdToName: Map<string, string> = new Map();
  private toolUseIdToCallId: Map<string, string> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  /**
   * Track a tool use with its ID and name
   */
  trackToolUse(toolUseId: string, toolName: string): void {
    this.toolUseIdToName.set(toolUseId, toolName);
    this.logger.debug('Tracked tool use', { toolUseId, toolName });
  }

  /**
   * Track an MCP call ID for a tool use
   */
  trackMcpCall(toolUseId: string, callId: string): void {
    this.toolUseIdToCallId.set(toolUseId, callId);
    this.logger.debug('Tracked MCP call', { toolUseId, callId });
  }

  /**
   * Get the tool name for a tool use ID
   */
  getToolName(toolUseId: string): string | undefined {
    return this.toolUseIdToName.get(toolUseId);
  }

  /**
   * Get the MCP call ID for a tool use ID
   */
  getMcpCallId(toolUseId: string): string | undefined {
    return this.toolUseIdToCallId.get(toolUseId);
  }

  /**
   * Remove the MCP call ID for a tool use (on tool result)
   */
  removeMcpCallId(toolUseId: string): void {
    this.toolUseIdToCallId.delete(toolUseId);
    this.logger.debug('Removed MCP call ID', { toolUseId });
  }

  /**
   * Get count of tracked tool uses
   */
  getToolUseCount(): number {
    return this.toolUseIdToName.size;
  }

  /**
   * Get count of tracked MCP calls
   */
  getMcpCallCount(): number {
    return this.toolUseIdToCallId.size;
  }

  /**
   * Check if there are any active MCP calls
   */
  hasActiveMcpCalls(): boolean {
    return this.toolUseIdToCallId.size > 0;
  }

  /**
   * Get all active MCP call IDs
   */
  getActiveMcpCallIds(): string[] {
    return Array.from(this.toolUseIdToCallId.values());
  }

  /**
   * Clear all tracking data immediately
   */
  cleanup(): void {
    this.cancelScheduledCleanup();
    this.toolUseIdToName.clear();
    this.toolUseIdToCallId.clear();
    this.logger.debug('Cleaned up all tracking data');
  }

  /**
   * Schedule a delayed cleanup (to keep data visible for a while)
   * @param delayMs Delay in milliseconds before cleanup
   * @param callback Optional callback after cleanup
   */
  scheduleCleanup(delayMs: number, callback?: () => void): void {
    this.cancelScheduledCleanup();

    this.cleanupTimer = setTimeout(() => {
      this.cleanup();
      this.cleanupTimer = null;
      callback?.();
    }, delayMs);

    this.logger.debug('Scheduled cleanup', { delayMs });
  }

  /**
   * Cancel any scheduled cleanup
   */
  cancelScheduledCleanup(): void {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.debug('Cancelled scheduled cleanup');
    }
  }
}
