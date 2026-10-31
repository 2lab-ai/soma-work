import { Logger } from '@soma/common/logger';

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
  /** #598 ④b2 — which session tracked each tool use, and each session's own cleanup timer. */
  private toolUseIdToSession: Map<string, string> = new Map();
  private sessionCleanupTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Track a tool use with its ID and name
   */
  trackToolUse(toolUseId: string, toolName: string, sessionKey?: string): void {
    this.toolUseIdToName.set(toolUseId, toolName);
    if (sessionKey) this.toolUseIdToSession.set(toolUseId, sessionKey);
    this.logger.debug('Tracked tool use', { toolUseId, toolName });
  }

  /**
   * Track an MCP call ID for a tool use
   */
  trackMcpCall(toolUseId: string, callId: string, sessionKey?: string): void {
    this.toolUseIdToCallId.set(toolUseId, callId);
    if (sessionKey) this.toolUseIdToSession.set(toolUseId, sessionKey);
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

  /** The tool uses no session owns (tracked without a session key). */
  private cleanupUnowned(): void {
    for (const toolUseId of [...this.toolUseIdToName.keys()]) {
      if (this.toolUseIdToSession.has(toolUseId)) continue;
      this.toolUseIdToName.delete(toolUseId);
      this.toolUseIdToCallId.delete(toolUseId);
    }
    for (const toolUseId of [...this.toolUseIdToCallId.keys()]) {
      if (!this.toolUseIdToSession.has(toolUseId)) this.toolUseIdToCallId.delete(toolUseId);
    }
  }

  /**
   * Clear all tracking data immediately
   */
  cleanup(): void {
    this.cancelScheduledCleanup();
    for (const timer of this.sessionCleanupTimers.values()) clearTimeout(timer);
    this.sessionCleanupTimers.clear();
    this.toolUseIdToName.clear();
    this.toolUseIdToCallId.clear();
    this.toolUseIdToSession.clear();
    this.logger.debug('Cleaned up all tracking data');
  }

  /**
   * Schedule a delayed cleanup (to keep data visible for a while)
   * @param delayMs Delay in milliseconds before cleanup
   * @param callback Optional callback after cleanup
   */
  scheduleCleanup(delayMs: number, callback?: () => void, sessionKey?: string): void {
    if (sessionKey) {
      this.scheduleSessionCleanup(delayMs, sessionKey, callback);
      return;
    }
    // The keyless (global) schedule replaces only the global timer: sessions'
    // own cleanups keep running (#629 R1).
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);

    this.cleanupTimer = setTimeout(() => {
      // A delayed global sweep removes only tool uses no session owns, and never
      // cancels a session's own timer — that session's cleanup removes its own
      // (#629 R2 astra). `cleanup()` stays the explicit clear-everything.
      this.cleanupUnowned();
      this.cleanupTimer = null;
      callback?.();
    }, delayMs);

    this.logger.debug('Scheduled cleanup', { delayMs });
  }

  /**
   * #598 ④b2 — a session's own delayed cleanup. It replaces only that session's
   * earlier timer (never another session's, whose callback would otherwise be
   * lost) and removes only the tool uses tracked for that session, so a turn
   * still running in another session keeps its mappings.
   */
  private scheduleSessionCleanup(delayMs: number, sessionKey: string, callback?: () => void): void {
    const previous = this.sessionCleanupTimers.get(sessionKey);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.sessionCleanupTimers.delete(sessionKey);
      for (const [toolUseId, owner] of this.toolUseIdToSession) {
        if (owner !== sessionKey) continue;
        this.toolUseIdToName.delete(toolUseId);
        this.toolUseIdToCallId.delete(toolUseId);
        this.toolUseIdToSession.delete(toolUseId);
      }
      callback?.();
    }, delayMs);
    this.sessionCleanupTimers.set(sessionKey, timer);
    this.logger.debug('Scheduled session cleanup', { delayMs, sessionKey });
  }

  /**
   * Cancel any scheduled cleanup
   */
  cancelScheduledCleanup(): void {
    for (const timer of this.sessionCleanupTimers.values()) clearTimeout(timer);
    this.sessionCleanupTimers.clear();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.debug('Cancelled scheduled cleanup');
    }
  }
}
