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
import { AssistantStatusManager } from './assistant-status-manager';
import { McpHealthMonitor } from './mcp-health-monitor';
import { getToolResultRenderMode, shouldOutput, OutputFlag, LOG_DETAIL } from './output-flags';

/**
 * Context for tool event processing
 */
export interface ToolEventContext {
  channel: string;
  threadTs: string;
  sessionKey: string;
  say: SayFunction;
  /** Verbosity bitmask — controls result display behavior */
  logVerbosity?: number;
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
  private assistantStatusManager: AssistantStatusManager | null;
  private mcpHealthMonitor: McpHealthMonitor | null = null;
  private subagentCallIds: Set<string> = new Set();
  /** Callback for updating compact tool call messages with duration */
  private onCompactDurationUpdate?: (toolUseId: string, duration: number | null, channel: string) => Promise<void>;

  constructor(
    toolTracker: ToolTracker,
    mcpStatusDisplay: McpStatusDisplay,
    mcpCallTrackerInstance: McpCallTracker = mcpCallTracker,
    assistantStatusManager?: AssistantStatusManager,
    mcpHealthMonitor?: McpHealthMonitor
  ) {
    this.toolTracker = toolTracker;
    this.mcpStatusDisplay = mcpStatusDisplay;
    this.mcpCallTracker = mcpCallTrackerInstance;
    this.assistantStatusManager = assistantStatusManager || null;
    this.mcpHealthMonitor = mcpHealthMonitor || null;
  }

  /**
   * Set reaction manager for MCP pending tracking
   */
  setReactionManager(reactionManager: ReactionManager): void {
    this.reactionManager = reactionManager;
  }

  /**
   * Set callback for compact mode duration updates (in-place tool call message update)
   */
  setCompactDurationCallback(
    cb: (toolUseId: string, duration: number | null, channel: string) => Promise<void>
  ): void {
    this.onCompactDurationUpdate = cb;
  }

  /**
   * Handle tool use events from assistant message
   * - Track tool use IDs
   * - Start MCP call tracking for MCP tools
   * - Session tick handles consolidation automatically
   */
  async handleToolUse(toolUses: ToolUseEvent[], context: ToolEventContext): Promise<void> {
    for (const toolUse of toolUses) {
      this.logger.debug('Handling tool_use', ToolFormatter.buildToolUseLogSummary(
        toolUse.id,
        toolUse.name,
        toolUse.input
      ));

      // Track tool use ID to name mapping
      this.toolTracker.trackToolUse(toolUse.id, toolUse.name);

      // Start MCP call tracking for MCP tools
      if (toolUse.name.startsWith('mcp__')) {
        await this.startMcpTracking(toolUse, context);
      }

      // Start subagent tracking for Task tools
      if (toolUse.name === 'Task') {
        await this.startSubagentTracking(toolUse, context);
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

    // Native spinner with MCP server name
    if (this.assistantStatusManager) {
      const statusText = this.assistantStatusManager.getToolStatusText(toolUse.name, serverName);
      await this.assistantStatusManager.setStatus(context.channel, context.threadTs, statusText);
    }

    const config = {
      displayType: 'MCP',
      displayLabel: `${serverName} → ${actualToolName}`,
      initialDelay: serverName === 'codex' ? 0 : 10000,
      predictKey: { serverName, toolName: actualToolName },
      paramsSummary: ToolFormatter.formatCompactParams(toolUse.input),
    };

    if (shouldOutput(OutputFlag.MCP_PROGRESS, context.logVerbosity ?? LOG_DETAIL)) {
      this.mcpStatusDisplay.registerCall(context.sessionKey, callId, config, context.channel, context.threadTs);
    }
  }

  /**
   * Start subagent tracking and status display for Task tools
   */
  private async startSubagentTracking(toolUse: ToolUseEvent, context: ToolEventContext): Promise<void> {
    const summary = ToolFormatter.getTaskToolSummary(toolUse.input);
    const subagentName = summary.subagentLabel || 'Task';

    // Start call tracking with virtual server name
    const callId = this.mcpCallTracker.startCall('_subagent', subagentName);
    this.toolTracker.trackMcpCall(toolUse.id, callId);
    this.subagentCallIds.add(callId);

    const config = {
      displayType: 'Subagent',
      displayLabel: subagentName,
      initialDelay: 0,
      predictKey: { serverName: '_subagent', toolName: subagentName },
      paramsSummary: summary.promptPreview
        ? `(${ToolFormatter.truncateString(summary.promptPreview, 50)})`
        : '',
    };

    if (shouldOutput(OutputFlag.MCP_PROGRESS, context.logVerbosity ?? LOG_DETAIL)) {
      this.mcpStatusDisplay.registerCall(context.sessionKey, callId, config, context.channel, context.threadTs);
    }
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

      // Update compact tool call message with duration (in-place)
      if (duration !== null && this.onCompactDurationUpdate) {
        await this.onCompactDurationUpdate(toolResult.toolUseId, duration, context.channel);
      }

      if (this.mcpHealthMonitor && toolResult.toolName?.startsWith('mcp__')) {
        await this.mcpHealthMonitor.recordResult({
          toolName: toolResult.toolName,
          isError: toolResult.isError,
          channel: context.channel,
          threadTs: context.threadTs,
        });
      }

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
   * End MCP or subagent tracking for a tool and return duration
   */
  private async endMcpTracking(toolUseId: string, sessionKey?: string): Promise<number | null> {
    const callId = this.toolTracker.getMcpCallId(toolUseId);
    if (!callId) return null;

    const duration = this.mcpCallTracker.endCall(callId);
    this.toolTracker.removeMcpCallId(toolUseId);

    // MCP-specific cleanup (reactions)
    if (!this.subagentCallIds.has(callId)) {
      if (this.reactionManager && sessionKey) {
        await this.reactionManager.clearMcpPending(sessionKey, callId);
      }
    } else {
      this.subagentCallIds.delete(callId);
    }

    // Mark call as completed in session tick
    this.mcpStatusDisplay.completeCall(callId, duration);

    return duration;
  }

  /**
   * Format and send tool result message (skipped in compact mode)
   */
  private async sendToolResult(
    toolResult: ToolResultEvent,
    duration: number | null,
    context: ToolEventContext
  ): Promise<void> {
    // In compact mode, results are handled via in-place updates — skip separate messages
    const resultMode = getToolResultRenderMode(context.logVerbosity ?? LOG_DETAIL);
    if (resultMode === 'compact' || resultMode === 'hidden') return;

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
   * Cleanup resources on abort or completion.
   * Completes any active MCP calls and cleans up the session tick.
   */
  cleanup(sessionKey?: string): void {
    // Complete any outstanding MCP calls
    const activeMcpCallIds = this.toolTracker.getActiveMcpCallIds();
    for (const callId of activeMcpCallIds) {
      this.mcpStatusDisplay.completeCall(callId, null);
    }

    // Cleanup session tick
    if (sessionKey) {
      this.mcpStatusDisplay.cleanupSession(sessionKey);
    }
  }
}
