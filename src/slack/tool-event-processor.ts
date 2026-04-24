/**
 * ToolEventProcessor - Handles tool_use and tool_result events
 * Extracted from slack-handler.ts tool processing logic (Phase 4.2)
 */

import { config } from '../config';
import { Logger } from '../logger';
import { type McpCallTracker, mcpCallTracker } from '../mcp-call-tracker';
import type { AssistantStatusManager } from './assistant-status-manager';
import type { McpHealthMonitor } from './mcp-health-monitor';
import type { McpStatusDisplay } from './mcp-status-tracker';
import { getToolResultRenderMode, LOG_DETAIL, OutputFlag, shouldOutput } from './output-flags';
import { shouldRunLegacyB4Path } from './pipeline/effective-phase';
import type { ReactionManager } from './reaction-manager';
import { ToolFormatter, type ToolResult } from './tool-formatter';
import type { ToolTracker } from './tool-tracker';

/**
 * Issue #688 — entry stored in BackgroundBashRegistry per live
 * `Bash({run_in_background:true})` invocation. The registry is keyed by
 * `(sessionKey, toolUseId)` so that:
 *  - `handleToolResult` can remove the exact entry by `toolUseId` on the
 *    stream's own tool_result (normal completion).
 *  - `cleanup()` (turn end) can `drain(sessionKey)` to sweep any bg bash
 *    that never produced a tool_result.
 * Both paths call `unregister()` to decrement the AssistantStatusManager
 * bg-bash counter so the native spinner text resolves correctly.
 */
interface BgBashEntry {
  callId: string;
  toolUseId: string;
  unregister: () => void;
}

class BackgroundBashRegistry {
  private map = new Map<string /*sessionKey*/, Map<string /*toolUseId*/, BgBashEntry>>();

  add(sessionKey: string, toolUseId: string, entry: BgBashEntry): void {
    let bucket = this.map.get(sessionKey);
    if (!bucket) {
      bucket = new Map();
      this.map.set(sessionKey, bucket);
    }
    bucket.set(toolUseId, entry);
  }

  remove(sessionKey: string, toolUseId: string): BgBashEntry | undefined {
    const bucket = this.map.get(sessionKey);
    if (!bucket) return undefined;
    const entry = bucket.get(toolUseId);
    if (!entry) return undefined;
    bucket.delete(toolUseId);
    if (bucket.size === 0) this.map.delete(sessionKey);
    return entry;
  }

  drain(sessionKey: string): BgBashEntry[] {
    const bucket = this.map.get(sessionKey);
    if (!bucket) return [];
    const entries = Array.from(bucket.values());
    this.map.delete(sessionKey);
    return entries;
  }
}

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
  /**
   * Turn id minted by StreamExecutor for this request. Optional for
   * backward compatibility — if absent the PHASE>=2 B1 absorb path
   * falls through to legacy `say`. See stream-executor.ts:355 for the
   * format (`${sessionKey}:${ms}:${uuid}`).
   */
  turnId?: string;
}

/**
 * Slack say function type
 */
export type SayFunction = (message: { text: string; thread_ts: string }) => Promise<{ ts?: string }>;

/**
 * Callback used to absorb a formatted tool result into the B1 stream at
 * PHASE>=2. Installed by `slack-handler.ts` as a closure over
 * `threadPanel.appendText`. Returns `true` when Slack accepted the chunk;
 * any `false` (closing turn, closed stream, Slack error) signals the
 * caller to fall back to legacy `context.say` so tool output is never
 * silently dropped.
 *
 * Caller-side (not TurnSurface) owns the presentation separator
 * (currently `\n\n`), so this sink stays a generic B1 write primitive
 * and keeps TurnSurface unaware of "tool result" semantics.
 */
export type ToolResultSink = (turnId: string, markdown: string) => Promise<boolean>;

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
  /**
   * Issue #688 — registry of live `Bash({run_in_background:true})` calls.
   * Populated by `startBackgroundBashTracking`, drained by
   * `handleToolResult` (normal completion) or `cleanup()` (turn end).
   */
  private backgroundBashRegistry = new BackgroundBashRegistry();
  /** Callback for updating compact tool call messages with duration */
  private onCompactDurationUpdate?: (toolUseId: string, duration: number | null, channel: string) => Promise<void>;
  /**
   * PHASE>=2 sink — absorbs formatted tool results into the B1 stream.
   * Null by default; installed by slack-handler after construction. See
   * `ToolResultSink` for the fallback contract.
   */
  private toolResultSink: ToolResultSink | null = null;

  constructor(
    toolTracker: ToolTracker,
    mcpStatusDisplay: McpStatusDisplay,
    mcpCallTrackerInstance: McpCallTracker = mcpCallTracker,
    assistantStatusManager?: AssistantStatusManager,
    mcpHealthMonitor?: McpHealthMonitor,
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
  setCompactDurationCallback(cb: (toolUseId: string, duration: number | null, channel: string) => Promise<void>): void {
    this.onCompactDurationUpdate = cb;
  }

  /**
   * Install the PHASE>=2 tool-result sink. See `ToolResultSink` for the
   * contract. Passing no callback (or `null`) clears the sink — the
   * processor will then always use the legacy `context.say` path.
   */
  setToolResultSink(sink: ToolResultSink | null): void {
    this.toolResultSink = sink;
  }

  /**
   * Handle tool use events from assistant message
   * - Track tool use IDs
   * - Start MCP call tracking for MCP tools
   * - Session tick handles consolidation automatically
   */
  async handleToolUse(toolUses: ToolUseEvent[], context: ToolEventContext): Promise<void> {
    for (const toolUse of toolUses) {
      this.logger.debug(
        'Handling tool_use',
        ToolFormatter.buildToolUseLogSummary(toolUse.id, toolUse.name, toolUse.input),
      );

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

      // Issue #688 — Bash with run_in_background=true gets its own
      // progress track via the shared MCP pipeline (virtual `_bash_bg`
      // server), plus a bg-counter increment on AssistantStatusManager so
      // the native spinner flips to "waiting on background shell…".
      if (toolUse.name === 'Bash' && ToolFormatter.isBackgroundBash(toolUse.input)) {
        await this.startBackgroundBashTracking(toolUse, context);
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

    // Native spinner with MCP server name — legacy-only; TurnSurface owns
    // the single B4 writer at PHASE>=4. Lifting getToolStatusText into
    // TurnSurface is a follow-up — see docs/slack-ui-phase4.md.
    // Skip when the descriptor is undefined/empty — `setStatus('')` reroutes
    // to `clearStatus` internally, which would silently wipe the spinner
    // mid-tool instead of leaving the previous status visible.
    if (shouldRunLegacyB4Path(this.assistantStatusManager)) {
      const statusText = this.assistantStatusManager?.getToolStatusText(toolUse.name, serverName);
      if (statusText) {
        await this.assistantStatusManager?.setStatus(context.channel, context.threadTs, statusText);
      }
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
      paramsSummary: summary.promptPreview ? `(${ToolFormatter.truncateString(summary.promptPreview, 50)})` : '',
    };

    if (shouldOutput(OutputFlag.MCP_PROGRESS, context.logVerbosity ?? LOG_DETAIL)) {
      this.mcpStatusDisplay.registerCall(context.sessionKey, callId, config, context.channel, context.threadTs);
    }
  }

  /**
   * Issue #688 — start progress tracking for a background Bash. Mirrors
   * `startSubagentTracking` so the `_bash_bg` virtual server rides the
   * same McpStatusDisplay / McpCallTracker pipeline. The
   * AssistantStatusManager bg-counter increment returns an idempotent
   * unregister function, which is stored on the registry entry and
   * invoked either by `handleToolResult` (normal close) or by
   * `cleanup()` (turn-end sweep for calls that never produced a result).
   */
  private async startBackgroundBashTracking(toolUse: ToolUseEvent, context: ToolEventContext): Promise<void> {
    const rawCommand = String((toolUse.input as { command?: unknown } | null | undefined)?.command ?? '');
    const cmdPrefix = ToolFormatter.truncateString(rawCommand, 80);

    const callId = this.mcpCallTracker.startCall('_bash_bg', 'bash');
    this.toolTracker.trackMcpCall(toolUse.id, callId);

    const unregister =
      this.assistantStatusManager?.registerBackgroundBashActive(context.channel, context.threadTs) ?? (() => {});

    this.backgroundBashRegistry.add(context.sessionKey, toolUse.id, {
      callId,
      toolUseId: toolUse.id,
      unregister,
    });

    const config = {
      displayType: 'BashBG',
      displayLabel: `\`${cmdPrefix}\``,
      initialDelay: 0,
      predictKey: { serverName: '_bash_bg', toolName: 'bash' },
      paramsSummary: '',
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

      // Issue #688 — background Bash registry: drop the entry and
      // decrement the bg-bash counter. endMcpTracking still owns the
      // McpCallTracker/McpStatusDisplay closure (callId-based), so we
      // must NOT call completeCall from here to avoid double-closing.
      const bgEntry = this.backgroundBashRegistry.remove(context.sessionKey, toolResult.toolUseId);
      if (bgEntry) {
        try {
          bgEntry.unregister();
        } catch (err) {
          // unregister is idempotent (released flag). A throw here means
          // two code paths are fighting over the same entry — surface as
          // warn so a real concurrency bug doesn't hide at debug level.
          this.logger.warn('bg bash unregister threw', {
            toolUseId: toolResult.toolUseId,
            error: (err as Error)?.message ?? String(err),
          });
        }
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
   * Format and send tool result message (skipped in compact mode).
   *
   * PHASE>=2 contract (Issue #664): when a `toolResultSink` is installed
   * and the context carries a `turnId`, the formatted result is absorbed
   * into the B1 stream instead of posted as a separate message. If the
   * sink returns `false` (turn closing, stream closed, Slack error, etc.)
   * we fall through to the legacy `context.say` path — tool output is
   * never silently dropped. PHASE<2 always uses the legacy path, so
   * pre-rollout behavior is unchanged.
   */
  private async sendToolResult(
    toolResult: ToolResultEvent,
    duration: number | null,
    context: ToolEventContext,
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
    if (!formatted) return;

    // PHASE>=2: try to absorb verbose output into the B1 stream so the
    // turn shows a single consolidated body instead of separate tool
    // bubbles. Read the phase per-call so a mid-test env flip takes
    // effect on the next event, matching TurnSurface.phase()'s behavior.
    if (config.ui.fiveBlockPhase >= 2 && this.toolResultSink && context.turnId) {
      const absorbed = await this.toolResultSink(context.turnId, formatted);
      if (absorbed) return;
      // Fallthrough: sink refused (no open stream, closing, Slack error).
      // Prefer a legacy bubble over a silent drop.
      this.logger.debug('tool-result sink returned false — falling back to legacy say', {
        turnId: context.turnId,
        toolUseId: toolResult.toolUseId,
      });
    }

    await context.say({
      text: formatted,
      thread_ts: context.threadTs,
    });
  }

  /**
   * Cleanup resources on abort or completion.
   * Completes any active MCP calls and cleans up the session tick.
   */
  cleanup(sessionKey?: string): void {
    // Issue #688 — sweep any background bashes that never produced a
    // tool_result. Decrement their bg-bash counters BEFORE the general
    // activeMcpCallIds sweep below — otherwise the native spinner text
    // could continue to resolve to "waiting on background shell" after
    // the turn is gone. `endMcpTracking` also runs below for the same
    // callId via activeMcpCallIds, so we only touch the counter here and
    // let the existing `completeCall(callId, null)` close the display.
    if (sessionKey) {
      const bgEntries = this.backgroundBashRegistry.drain(sessionKey);
      for (const entry of bgEntries) {
        try {
          entry.unregister();
        } catch (err) {
          // Same warn-level rationale as handleToolResult's unregister catch.
          this.logger.warn('bg bash unregister threw during sweep', {
            sessionKey,
            toolUseId: entry.toolUseId,
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

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
