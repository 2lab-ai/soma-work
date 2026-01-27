/**
 * ToolEventProcessor - Handles tool_use and tool_result events
 * Extracted from slack-handler.ts tool processing logic (Phase 4.2)
 */

import { Logger } from '../logger';
import { mcpCallTracker, McpCallTracker } from '../mcp-call-tracker';
import { ToolTracker } from './tool-tracker';
import { McpStatusDisplay } from './mcp-status-tracker';
import { ToolFormatter, ToolResult } from './tool-formatter';
import { ReactionManager } from './reaction-manager';

/**
 * Context for tool event processing
 */
export interface ToolEventContext {
  channel: string;
  threadTs: string;
  sessionKey: string;
  say: SayFunction;
}

/**
 * Slack say function type
 */
export type SayFunction = (message: { text: string; thread_ts: string }) => Promise<{ ts?: string }>;

/**
 * Tool use event from stream
 */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: any;
}

/**
 * Tool result event from stream
 */
export interface ToolResultEvent {
  toolUseId: string;
  toolName?: string;
  result: any;
  isError?: boolean;
}

/**
 * ToolEventProcessor handles tool_use and tool_result event processing
 * - Tracks tool use ID to name mappings
 * - Manages MCP call tracking and status display
 * - Formats and sends tool results
 */
export class ToolEventProcessor {
  private logger = new Logger('ToolEventProcessor');
  private toolTracker: ToolTracker;
  private mcpStatusDisplay: McpStatusDisplay;
  private mcpCallTracker: McpCallTracker;
  private reactionManager: ReactionManager | null = null;

  constructor(
    toolTracker: ToolTracker,
    mcpStatusDisplay: McpStatusDisplay,
    mcpCallTrackerInstance: McpCallTracker = mcpCallTracker
  ) {
    this.toolTracker = toolTracker;
    this.mcpStatusDisplay = mcpStatusDisplay;
    this.mcpCallTracker = mcpCallTrackerInstance;
  }

  /**
   * Set reaction manager for MCP pending tracking
   */
  setReactionManager(reactionManager: ReactionManager): void {
    this.reactionManager = reactionManager;
  }

  /**
   * Handle tool use events from assistant message
   * - Track tool use IDs
   * - Start MCP call tracking for MCP tools
   */
  async handleToolUse(toolUses: ToolUseEvent[], context: ToolEventContext): Promise<void> {
    for (const toolUse of toolUses) {
      // Track tool use ID to name mapping
      this.toolTracker.trackToolUse(toolUse.id, toolUse.name);

      // Start MCP call tracking for MCP tools
      if (toolUse.name.startsWith('mcp__')) {
        await this.startMcpTracking(toolUse, context);
      }
    }
  }

  /**
   * Start MCP call tracking and status display
   */
  private async startMcpTracking(toolUse: ToolUseEvent, context: ToolEventContext): Promise<void> {
    const nameParts = toolUse.name.split('__');
    const serverName = nameParts[1] || 'unknown';
    const actualToolName = nameParts.slice(2).join('__') || toolUse.name;

    // Start call tracking
    const callId = this.mcpCallTracker.startCall(serverName, actualToolName);
    this.toolTracker.trackMcpCall(toolUse.id, callId);

    // Set hourglass reaction for MCP pending
    if (this.reactionManager && context.sessionKey) {
      await this.reactionManager.setMcpPending(context.sessionKey, callId);
    }

    // Start periodic status update display
    this.mcpStatusDisplay.startStatusUpdate(
      callId,
      serverName,
      actualToolName,
      context.channel,
      context.threadTs
    );
  }

  /**
   * Handle tool result events from user message
   * - End MCP call tracking
   * - Format and send results
   */
  async handleToolResult(toolResults: ToolResultEvent[], context: ToolEventContext): Promise<void> {
    for (const toolResult of toolResults) {
      // Lookup tool name from tracking if not set
      if (!toolResult.toolName && toolResult.toolUseId) {
        toolResult.toolName = this.toolTracker.getToolName(toolResult.toolUseId);
      }

      // End MCP call tracking and get duration
      const duration = await this.endMcpTracking(toolResult.toolUseId, context.sessionKey);

      this.logger.debug('Processing tool result', {
        toolName: toolResult.toolName,
        toolUseId: toolResult.toolUseId,
        hasResult: !!toolResult.result,
        isError: toolResult.isError,
        duration,
      });

      // Format and send result
      await this.sendToolResult(toolResult, duration, context);
    }
  }

  /**
   * End MCP tracking for a tool and return duration
   */
  private async endMcpTracking(toolUseId: string, sessionKey?: string): Promise<number | null> {
    const callId = this.toolTracker.getMcpCallId(toolUseId);
    if (!callId) return null;

    const duration = this.mcpCallTracker.endCall(callId);
    this.toolTracker.removeMcpCallId(toolUseId);

    // Clear hourglass reaction for MCP pending
    if (this.reactionManager && sessionKey) {
      await this.reactionManager.clearMcpPending(sessionKey, callId);
    }

    // Stop status update display
    await this.mcpStatusDisplay.stopStatusUpdate(callId, duration);

    return duration;
  }

  /**
   * Format and send tool result message
   */
  private async sendToolResult(
    toolResult: ToolResultEvent,
    duration: number | null,
    context: ToolEventContext
  ): Promise<void> {
    const result: ToolResult = {
      toolName: toolResult.toolName,
      toolUseId: toolResult.toolUseId,
      result: toolResult.result,
      isError: toolResult.isError,
    };

    const formatted = ToolFormatter.formatToolResult(result, duration, this.mcpCallTracker);

    if (formatted) {
      await context.say({
        text: formatted,
        thread_ts: context.threadTs,
      });
    }
  }

  /**
   * Cleanup resources on abort or completion
   */
  cleanup(): void {
    // Tool tracker handles its own cleanup via scheduleCleanup
    // MCP status display handles its own cleanup when calls end
  }
}
